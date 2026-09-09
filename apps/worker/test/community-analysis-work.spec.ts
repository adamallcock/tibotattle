import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json";
import { sha256Hex } from "../src/crypto";
import { createV11DeviceFixture, makeV11Day, stageV11Day } from "./helpers/telemetry-v11";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from "@app-usagemonitor/telemetry-contract";
import { V1_QUOTA_ACQUISITION_VERSION, createV1QuotaAcquisitionCheckpoint, createV1QuotaWorkInterner,
  encodeV1QuotaWorkCheckpoint, decodeV1QuotaWorkCheckpoint, type V1QuotaWorkControl, type V1QuotaWorkComponent,
  advanceV1QuotaAcquisitionPage, type V1QuotaPageReplay, type V1PlanSourceRow,
  type V1QuotaAcquisitionIdentity } from "../src/quota-analysis-v1-reader";
import {
  beginCommunityAnalysisWork, commitCommunityAnalysisWorkPage, readCommunityAnalysisWork,
  readCommunityAnalysisWorkParts, prepareCommunityAnalysisWorkDelta, COMMUNITY_ANALYSIS_PART_BYTES,
  type CommunityAnalysisWorkIdentity, type CommunityAnalysisWorkHead,
  beginCommunityAnalysisStage, readCommunityAnalysisStage, writeCommunityAnalysisStagePage,
  verifyCommunityAnalysisStagePage, promoteCommunityAnalysisStage, collectCommunityAnalysisWorkGarbage,
  beginCommunityAnalysisDiscard, type CommunityAnalysisWorkStage, type CommunityAnalysisStageTarget,
  readCommunityAnalysisWorkForDiscard,
  beginCommunityAnalysisSupersession, readCommunityAnalysisWorkForSupersession,
} from "../src/community-analysis-work";

interface TestBindings extends Env { TEST_MIGRATIONS: D1Migration[] }
const db = () => (env as TestBindings).USAGE_MONITOR_DB;
const NOW = "2026-09-01T00:00:00.000Z";
const IDENTITY: CommunityAnalysisWorkIdentity = {
  participantId: "synthetic-work-participant", inputRevision: 0, inputFingerprint: "a".repeat(64),
  sourceKind: "v1", sourceMethodVersion: "synthetic-work-1", fixedNow: NOW,
  observedAtCutoff: "2026-08-01T00:00:00.000Z", resetsAtCutoff: "2026-08-08T00:00:00.000Z",
  windowMinutes: 10080, maxQuotaRows: 60000,
};
const control = (): V1QuotaWorkControl => ({ version: V1_QUOTA_ACQUISITION_VERSION, phase: "plan",
  cursor: { observedAt: IDENTITY.observedAtCutoff, resetsAt: IDENTITY.resetsAtCutoff, id: 0 }, planTime: null, reset: null });
const budget = (remainingQueries = 1000, reserveQueries = 0) => ({ remainingQueries, reserveQueries, deadlineMs: 1, now: () => 0 });
const anchor = (day = "2026-08-01") => ({ sourceContext: JSON.stringify(["openai_codex", "codex"]),
  contextKey: "openai_codex|codex", observedAtMs: Date.parse(`${day}T00:00:00.000Z`),
  planType: "pro", planVariant: "unknown", accountScopeId: null });
const part = (partKey = 0) => ({ component: "plan-anchors" as const, partKey,
  value: [{ ...anchor(), observedAtMs: anchor().observedAtMs + partKey }] });
async function participant(id = IDENTITY.participantId): Promise<void> {
  await db().prepare(`INSERT INTO participants (id,access_token_id,access_token_hash,recovery_token_id,
    recovery_token_hash,state,consent_version,consented_at,created_at)
    VALUES (?,?,?,?,?,'active','privacy-safe-telemetry-v0.1',?,?)`)
    .bind(id, `access:${id}`, new Uint8Array(32), `recovery:${id}`, new Uint8Array(32), NOW, NOW).run();
}
async function begin(identity = IDENTITY): Promise<CommunityAnalysisWorkHead> {
  const value = await beginCommunityAnalysisWork(db(), identity, control(), budget());
  if (value.status !== "ready") throw new Error("synthetic work did not begin");
  return value.head;
}
async function saved(head: CommunityAnalysisWorkHead, parts = [part()]): Promise<CommunityAnalysisWorkHead> {
  const result = await commitCommunityAnalysisWorkPage(db(), head, { control: control(), phase: "plan", parts }, budget());
  if (result.status !== "ready") throw new Error("synthetic work did not save");
  return result.head;
}
async function payloads() {
  return (await db().prepare(`SELECT component,payload_sha256 FROM community_analysis_work_parts
    ORDER BY participant_id,component,payload_sha256`).all()).results;
}
async function currentIdentity(): Promise<CommunityAnalysisWorkIdentity> {
  const row = await db().prepare("SELECT revision FROM community_analytical_input_versions WHERE participant_id=?")
    .bind(IDENTITY.participantId).first<{ revision: number }>();
  if (!row) throw new Error("synthetic revision missing");
  return { ...IDENTITY, inputRevision: row.revision };
}
async function collectAll(head: CommunityAnalysisWorkHead, initial: CommunityAnalysisWorkStage) {
  let stage = initial;
  const allocation = budget();
  for (let page = 0; page < 100; page++) {
    const result = await collectCommunityAnalysisWorkGarbage(db(), head, stage, allocation);
    if (result.status !== "ready") throw new Error("synthetic garbage collection refused");
    if (result.done) return result;
    stage = result.stage;
  }
  throw new Error("synthetic garbage collection did not complete");
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), (env as TestBindings).TEST_MIGRATIONS);
  await participant();
});

describe("participant-scoped resumable analysis work", () => {
  it("preserves old raw head hashes and fences a prepared reader policy throughout replay", async () => {
    const raw = await begin();
    expect(Object.hasOwn(raw, "readerPolicy")).toBe(false);
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "ready", head: raw });
    await db().prepare("DELETE FROM community_analysis_work WHERE participant_id=?").bind(IDENTITY.participantId).run();
    const prepared = await beginCommunityAnalysisWork(db(), IDENTITY, control(), budget(), undefined, "prepared-source-days-1");
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected prepared run");
    const next = await saved(prepared.head);
    expect(next.readerPolicy).toBe("prepared-source-days-1");
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "ready", head: next });
    await db().prepare("UPDATE community_analysis_work SET reader_policy='raw-source-pages-1'").run();
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "corrupt" });
    expect(await commitCommunityAnalysisWorkPage(db(), next, { phase: "plan", control: control(), parts: [] }, budget()))
      .toEqual({ status: "stale" });
  });

  it("refuses an unmigrated store, then starts only for an active exact source revision", async () => {
    await db().prepare("DROP TABLE community_analysis_work_parts").run();
    await db().prepare("DROP TABLE community_analysis_work").run();
    await expect(begin()).rejects.toThrow();
  });

  it("saves changed chunks atomically, reads bounded pages, and charges each query including reserves", async () => {
    const b = budget(100, 7);
    const first = await beginCommunityAnalysisWork(db(), IDENTITY, control(), b);
    expect(first.status).toBe("ready"); expect(b.remainingQueries).toBe(99);
    if (first.status !== "ready") throw new Error("expected ready");
    const head = await saved(first.head, Array.from({ length: 10 }, (_, key) => part(key)));
    const one = await readCommunityAnalysisWorkParts(db(), head, 0, b);
    expect(one).toMatchObject({ status: "ready", nextOffset: 8, done: false });
    expect(b.remainingQueries).toBe(96);
    const two = await readCommunityAnalysisWorkParts(db(), head, 8, b);
    expect(two).toMatchObject({ status: "ready", nextOffset: 10, done: true });
    expect(b.remainingQueries).toBe(93);
    const old = await payloads();
    const changed = await commitCommunityAnalysisWorkPage(db(), head, { control: control(), phase: "plan",
      parts: [{ component: "plan-anchors", partKey: 9, value: [anchor("2026-08-02")] }] }, b);
    expect(changed.status).toBe("ready"); expect(b.remainingQueries).toBe(90);
    expect((await payloads()).filter(value => old.some(prior => canonicalJson(prior) === canonicalJson(value)))).toHaveLength(9);
    const reserved = budget(8, 7);
    expect(await readCommunityAnalysisWorkParts(db(), head, 0, reserved)).toEqual({ status: "deferred" });
    expect(reserved.remainingQueries).toBe(8);
    expect(await commitCommunityAnalysisWorkPage(db(), head, { control: control(), phase: "plan", parts: [part()] }, reserved))
      .toEqual({ status: "deferred" });
  });

  it("does not equate a missing or unfinished checkpoint with completed zero evidence", async () => {
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "absent" });
    const head = await begin();
    expect(head.phase).toBe("plan");
    expect(await readCommunityAnalysisWorkParts(db(), head, 0, budget())).toMatchObject({ status: "ready", parts: [], done: true });
    expect((await readCommunityAnalysisWork(db(), IDENTITY, budget()))).toMatchObject({ status: "ready", head: { phase: "plan" } });
  });

  it("makes every stale writer mutation a no-op, including deletes and the cursor advance", async () => {
    const original = await begin(), current = await saved(original);
    const before = await payloads();
    const stale = await commitCommunityAnalysisWorkPage(db(), original, { control: control(), phase: "plan",
      parts: [{ component: "plan-anchors", partKey: 0, remove: true }, part(1)] }, budget());
    expect(stale).toEqual({ status: "stale" });
    expect(await payloads()).toEqual(before);
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "ready", head: current });
  });

  it("invalidates corrections, state withdrawal, reactivation and same-revision fingerprint mismatches", async () => {
    let head = await saved(await begin());
    const before = await payloads();
    await db().prepare("UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=?")
      .bind(IDENTITY.participantId).run();
    expect(await commitCommunityAnalysisWorkPage(db(), head, { control: control(), phase: "plan", parts: [part(1)] }, budget()))
      .toEqual({ status: "stale" });
    expect(await payloads()).toEqual(before);
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "stale" });
    const nextIdentity = { ...IDENTITY, inputRevision: 1, inputFingerprint: "b".repeat(64) };
    expect(await beginCommunityAnalysisWork(db(), nextIdentity, control(), budget(), head)).toEqual({ status: "stale" });
    const discard = await beginCommunityAnalysisDiscard(db(), head, 1, budget());
    if (discard.status !== "ready") throw new Error("expected discard");
    await collectAll(head, discard.stage);
    const replacement = await beginCommunityAnalysisWork(db(), nextIdentity, control(), budget());
    expect(replacement.status).toBe("ready");
    if (replacement.status !== "ready") throw new Error("expected replacement");
    head = replacement.head;
    expect(await payloads()).toEqual([]);
    expect(await readCommunityAnalysisWork(db(), { ...nextIdentity, inputFingerprint: "c".repeat(64) }, budget())).toEqual({ status: "stale" });
    await db().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(IDENTITY.participantId).run();
    expect(await commitCommunityAnalysisWorkPage(db(), head, { control: control(), phase: "plan", parts: [part()] }, budget())).toEqual({ status: "stale" });
    await db().prepare("UPDATE participants SET state='active' WHERE id=?").bind(IDENTITY.participantId).run();
    expect(await commitCommunityAnalysisWorkPage(db(), head, { control: control(), phase: "plan", parts: [part()] }, budget())).toEqual({ status: "stale" });
  });

  it("does not invalidate another participant when the global publication epoch changes", async () => {
    const head = await begin();
    await participant("synthetic-other");
    await db().prepare("UPDATE participants SET state='deleting' WHERE id='synthetic-other'").run();
    await db().prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
    expect((await saved(head)).progressRevision).toBe(1);
  });

  it("fences real chunk digest corrections and deletion through the analytical revision triggers", async () => {
    const fixture = await createV11DeviceFixture(db(), { participantId: IDENTITY.participantId });
    const principal = await authenticateDevice(db(), fixture.authorization);
    const digest = "f".repeat(64);
    const upload = await createDeviceUploadAuthorization(db(), principal, digest, 200);
    const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest: digest, bodyBytes: 200, contentType: "application/json" });
    const now = new Date().toISOString(), day = now.slice(0, 10);
    await db().prepare(`INSERT INTO telemetry_v1_chunks (id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
      chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at)
      VALUES ('synthetic-work-chunk',?,?,'quota',?,0,1,?,?,'synthetic-work',1,1,'synthetic/work',?,?)`)
      .bind(IDENTITY.participantId, fixture.deviceId, day, "a".repeat(64), digest, claimed.authorizationId, now).run();
    const head = await saved(await begin(await currentIdentity()));
    await db().prepare("UPDATE telemetry_v1_chunks SET chunk_digest=? WHERE id='synthetic-work-chunk'").bind("b".repeat(64)).run();
    expect(await commitCommunityAnalysisWorkPage(db(), head, { control: control(), phase: "plan", parts: [part(1)] }, budget()))
      .toEqual({ status: "stale" });
    const discard = await beginCommunityAnalysisDiscard(db(), head, (await currentIdentity()).inputRevision, budget());
    if (discard.status !== "ready") throw new Error("expected discard");
    await collectAll(head, discard.stage);
    const replacement = await beginCommunityAnalysisWork(db(), await currentIdentity(), control(), budget());
    if (replacement.status !== "ready") throw new Error("expected replacement");
    await db().prepare("DELETE FROM telemetry_v1_chunks WHERE id='synthetic-work-chunk'").run();
    expect(await commitCommunityAnalysisWorkPage(db(), replacement.head, { control: control(), phase: "plan", parts: [part()] }, budget()))
      .toEqual({ status: "stale" });
  });

  it("rejects old v1 work after a real successor activation and cannot restart it under the new revision", async () => {
    const fixture = await createV11DeviceFixture(db(), { participantId: IDENTITY.participantId, grant: true });
    const day = new Date().toISOString().slice(0, 10);
    const staged = await stageV11Day(db(), fixture, await makeV11Day(day, {}));
    const prior = await createTelemetryV11DomainPredecessor(db(), fixture);
    const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: day, throughDay: day,
      predecessor: { token: prior.token, previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint },
      days: [{ day, manifestId: staged.manifestId, manifestDigest: staged.manifestDigest }], manifestDigest: "0".repeat(64) };
    manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
    const head = await saved(await begin(await currentIdentity()));
    const components = emptyComponents(); components["plan-anchors"] = part().value;
    const replayed = await onePageTarget(head, components, []);
    const stagedWork = await beginCommunityAnalysisStage(db(), head, replayed.target, replayed.replay, budget());
    if (stagedWork.status !== "ready") throw new Error("expected checkpoint stage");
    await activateTelemetryV11Domain(db(), fixture, manifest);
    expect(await readCommunityAnalysisWork(db(), head.identity, budget())).toEqual({ status: "stale" });
    expect(await commitCommunityAnalysisWorkPage(db(), head, { control: control(), phase: "plan", parts: [part(1)] }, budget()))
      .toEqual({ status: "stale" });
    expect(await beginCommunityAnalysisWork(db(), await currentIdentity(), control(), budget(), head)).toEqual({ status: "stale" });
    expect(await verifyCommunityAnalysisStagePage(db(), head, stagedWork.stage, budget())).toEqual({ status: "stale" });
  });

  it("serializes competing page writers and old-run restart attempts", async () => {
    const head = await begin();
    const results = await Promise.all([commitCommunityAnalysisWorkPage(db(), head,
      { control: control(), phase: "plan", parts: [part(0)] }, budget()), commitCommunityAnalysisWorkPage(db(), head,
      { control: control(), phase: "plan", parts: [part(1)] }, budget())]);
    expect(results.map(value => value.status).sort()).toEqual(["ready", "stale"]);
    expect(await beginCommunityAnalysisWork(db(), IDENTITY, control(), budget(), head)).toEqual({ status: "stale" });
    expect(await payloads()).toHaveLength(1);
  });

  it("rolls back earlier changed chunks if a later statement fails", async () => {
    const head = await begin();
    await db().prepare(`CREATE TRIGGER synthetic_work_crash BEFORE INSERT ON community_analysis_work_parts
      WHEN (SELECT COUNT(*) FROM community_analysis_work_parts)=1
      BEGIN SELECT RAISE(ABORT,'synthetic checkpoint interruption'); END`).run();
    await expect(saved(head, [part(0), part(1)])).rejects.toThrow();
    expect(await payloads()).toEqual([]);
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "ready", head });
  });

  it("checks the head after the parts query and rejects a concurrent correction", async () => {
    const head = await saved(await begin());
    const base = db();
    let interleaved = false;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (property === "all" && sql.includes("community_analysis_work_parts")) return async () => {
          const result = await target.all();
          await base.prepare("UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=?")
            .bind(IDENTITY.participantId).run();
          interleaved = true;
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const raced = new Proxy(base, { get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(await readCommunityAnalysisWorkParts(raced, head, 0, budget())).toEqual({ status: "stale" });
    expect(interleaved).toBe(true);
  });

  it("rejects missing and hash-mismatched active parts while ignoring unreferenced staged chunks", async () => {
    let head = await saved(await begin(), [part(0), part(1)]);
    await db().prepare("DELETE FROM community_analysis_work_parts WHERE payload_sha256=?").bind(head.manifest[0]!.sha256).run();
    expect(await readCommunityAnalysisWorkParts(db(), head, 0, budget())).toEqual({ status: "corrupt" });
    head = await saved(head, [part(0)]);
    await db().prepare("DELETE FROM community_analysis_work_parts WHERE payload_sha256=?").bind(head.manifest[0]!.sha256).run();
    await db().prepare(`INSERT INTO community_analysis_work_parts VALUES (?,?,'plan-anchors','[]',?,2)`)
      .bind(IDENTITY.participantId, head.runId, head.manifest[0]!.sha256).run();
    expect(await readCommunityAnalysisWorkParts(db(), head, 0, budget())).toEqual({ status: "corrupt" });
    await db().prepare("DELETE FROM community_analysis_work_parts WHERE payload_sha256=?").bind(head.manifest[0]!.sha256).run();
    head = await saved(head, [part(0)]);
    const raw = canonicalJson([anchor()]);
    await db().prepare(`INSERT INTO community_analysis_work_parts VALUES (?,?, 'eligible',?,?,?)`)
      .bind(IDENTITY.participantId, head.runId, raw, await sha256Hex(raw), new TextEncoder().encode(raw).byteLength).run();
    expect(await readCommunityAnalysisWorkParts(db(), head, 0, budget())).toMatchObject({ status: "ready" });
    await db().prepare("UPDATE community_analysis_work SET control_json='{}' WHERE participant_id=?").bind(IDENTITY.participantId).run();
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "corrupt" });
  });

  it("enforces closed payloads, UTF-8 byte bounds and whole-page atomic budget admission", async () => {
    const head = await begin();
    const denied = [
      [{ ...part(), value: [{ ...anchor(), record_json: "forbidden synthetic payload" }] }],
      [{ ...part(), value: [{ ...anchor(), device_id: "forbidden-device" }] }],
      [{ ...part(), value: [{ ...anchor(), planType: "é".repeat(COMMUNITY_ANALYSIS_PART_BYTES / 2) }] }],
      [part(0), part(0)],
    ];
    for (const parts of denied) await expect(commitCommunityAnalysisWorkPage(db(), head,
      { control: control(), phase: "plan", parts }, budget())).rejects.toThrow("work invalid");
    expect(await commitCommunityAnalysisWorkPage(db(), head, { control: control(), phase: "plan",
      parts: Array.from({ length: 33 }, (_, key) => part(key)) }, budget())).toEqual({ status: "deferred" });
    const text = JSON.stringify("é".repeat(65536));
    expect(text.length).toBeLessThan(COMMUNITY_ANALYSIS_PART_BYTES);
    await expect(db().prepare(`INSERT INTO community_analysis_work_parts VALUES (?,?, 'eligible',?,?,?)`)
      .bind(IDENTITY.participantId, head.runId, text, "a".repeat(64), new TextEncoder().encode(text).byteLength).run()).rejects.toThrow();
    expect(await payloads()).toEqual([]);
    const exhausted = budget(2, 1);
    expect(await commitCommunityAnalysisWorkPage(db(), head, { control: control(), phase: "plan", parts: [part()] }, exhausted))
      .toEqual({ status: "deferred" });
    expect(exhausted.remainingQueries).toBe(2);
    await expect(beginCommunityAnalysisWork(db(), IDENTITY, { ...control(), cursor: { ...control().cursor, id: 1 } }, budget()))
      .rejects.toThrow("work invalid");
  });

  it("rejects a schema-invalid part even when its bytes, manifest and hash agree", async () => {
    const head = await saved(await begin());
    const raw = canonicalJson([{ ...anchor(), raw_payload: "forbidden synthetic field" }]);
    const sha256 = await sha256Hex(raw), bytes = new TextEncoder().encode(raw).byteLength;
    const manifest = [{ component: "plan-anchors", partKey: 0, sha256, bytes }];
    await db().batch([
      db().prepare("DELETE FROM community_analysis_work_parts WHERE participant_id=?").bind(IDENTITY.participantId),
      db().prepare("INSERT INTO community_analysis_work_parts VALUES (?,?,'plan-anchors',?,?,?)")
        .bind(IDENTITY.participantId, head.runId, raw, sha256, bytes),
      db().prepare("UPDATE community_analysis_work SET manifest_json=?,state_sha256=?")
        .bind(canonicalJson(manifest), await sha256Hex(canonicalJson({ ...head, manifest }))),
    ]);
    const current = await readCommunityAnalysisWork(db(), IDENTITY, budget());
    if (current.status !== "ready") throw new Error("expected metadata");
    expect(await readCommunityAnalysisWorkParts(db(), current.head, 0, budget())).toEqual({ status: "corrupt" });
    expect(await readCommunityAnalysisWorkParts(db(), head, 0, budget())).toEqual({ status: "stale" });
  });

  it("detects a valid-JSON cursor or manifest change through the head integrity digest", async () => {
    const head = await saved(await begin());
    await db().prepare("UPDATE community_analysis_work SET manifest_json='[]'").run();
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "corrupt" });
    await db().prepare("UPDATE community_analysis_work SET manifest_json=?,control_json=?")
      .bind(canonicalJson(head.manifest), canonicalJson({ ...control(), cursor: { ...control().cursor, id: 42 } })).run();
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "corrupt" });
  });

  it("cascades all private checkpoint state on participant erasure and prevents resurrection", async () => {
    const head = await saved(await begin());
    await db().prepare("DELETE FROM participants WHERE id=?").bind(IDENTITY.participantId).run();
    expect(await payloads()).toEqual([]);
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "absent" });
    expect(await commitCommunityAnalysisWorkPage(db(), head, { control: control(), phase: "plan", parts: [part()] }, budget())).toEqual({ status: "stale" });
    expect(await beginCommunityAnalysisWork(db(), IDENTITY, control(), budget(), head)).toEqual({ status: "stale" });
  });

  it("frames components by bytes and emits only changed chunks or explicit staging deferral", async () => {
    let head = await begin();
    const components = { "plan-anchors": Array.from({ length: 1800 }, () => anchor()),
      "plan-runs": [], "plan-equal-time": [], "fit-stats": [], eligible: [], "endpoint-runs": [], endpoints: [] };
    const delta = await prepareCommunityAnalysisWorkDelta(head, components);
    expect(delta.status).toBe("ready");
    if (delta.status !== "ready") throw new Error("expected delta");
    expect(delta.parts.length).toBeGreaterThan(1);
    expect(delta.parts.every(value => "value" in value && new TextEncoder().encode(canonicalJson(value.value)).byteLength <= COMMUNITY_ANALYSIS_PART_BYTES)).toBe(true);
    const result = await commitCommunityAnalysisWorkPage(db(), head, { control: control(), phase: "plan", parts: delta.parts }, budget());
    if (result.status !== "ready") throw new Error("expected save");
    head = result.head;
    expect(await prepareCommunityAnalysisWorkDelta(head, components)).toEqual({ status: "ready", parts: [] });
    components["plan-anchors"].push(anchor("2026-08-02"));
    expect(await prepareCommunityAnalysisWorkDelta(head, components)).toMatchObject({ status: "ready", parts: [expect.objectContaining({ component: "plan-anchors" })] });
    components["plan-anchors"] = [];
    expect(await prepareCommunityAnalysisWorkDelta(head, components)).toEqual({ status: "ready",
      parts: head.manifest.map(reference => ({ component: reference.component, partKey: reference.partKey, remove: true })) });
    components["plan-anchors"] = Array.from({ length: 120000 }, () => anchor());
    expect(await prepareCommunityAnalysisWorkDelta(head, components)).toEqual({ status: "deferred", reason: "checkpoint_staging_required" });
  });

  it("round-trips compact endpoint/run parts with one shared interner before accumulation", async () => {
    const identity: V1QuotaAcquisitionIdentity = { participantId: IDENTITY.participantId,
      inputFingerprint: IDENTITY.inputFingerprint, sourceMethodVersion: IDENTITY.sourceMethodVersion,
      observedAtCutoff: IDENTITY.observedAtCutoff, resetsAtCutoff: IDENTITY.resetsAtCutoff,
      windowMinutes: IDENTITY.windowMinutes, maxQuotaRows: IDENTITY.maxQuotaRows };
    const state = createV1QuotaAcquisitionCheckpoint(identity);
    const era = JSON.stringify(["openai_codex|codex", null, "pro", "unknown", anchor().observedAtMs]);
    const endpoint = { id: 1, row: { occurrence_id: "synthetic-endpoint-1", observed_at: NOW,
      provider: "openai_codex", plan_type: "pro", plan_variant: "unknown", limit_id: "codex", slot: "seven_day",
      used_percent: 10, window_duration_minutes: 10080, resets_at: "2026-09-08T00:00:00.000Z", plan_era_key: era } };
    state.phase = "endpoints"; state.plan.anchors = [anchor()]; state.reset = endpoint.row.resets_at;
    state.cursor = { id: 1, observedAt: NOW, resetsAt: endpoint.row.resets_at };
    state.eligible = [JSON.stringify([state.reset, era])]; state.endpoints = [endpoint];
    state.runs = [[era, "seven_day", { firstId: 1, last: endpoint }]];
    const encoded = encodeV1QuotaWorkCheckpoint(state), head = await begin();
    const delta = await prepareCommunityAnalysisWorkDelta(head, encoded.components);
    if (delta.status !== "ready") throw new Error("expected delta");
    const save = await commitCommunityAnalysisWorkPage(db(), head,
      { control: encoded.control, phase: "endpoints", parts: delta.parts }, budget());
    if (save.status !== "ready") throw new Error("expected save");
    const components: Record<V1QuotaWorkComponent, unknown[]> = { "plan-anchors": [], "plan-runs": [],
      "plan-equal-time": [], "fit-stats": [], eligible: [], "endpoint-runs": [], endpoints: [] };
    const interner = createV1QuotaWorkInterner();
    try {
      let offset = 0;
      for (;;) {
        const page = await readCommunityAnalysisWorkParts(db(), save.head, offset, budget());
        if (page.status !== "ready") throw new Error("expected part page");
        for (const part of page.parts) {
          interner.internPart(part.component, part.value);
          if (!Array.isArray(part.value)) throw new Error("expected component array");
          for (const entry of part.value) components[part.component].push(entry);
        }
        if (page.done) break;
        offset = page.nextOffset;
      }
    } finally { interner.release(); }
    const restored = decodeV1QuotaWorkCheckpoint(identity, save.head.control, components);
    expect(restored).toEqual(state);
    expect(restored.runs[0]![2].last).toBe(restored.endpoints[0]);
    expect(Object.keys(restored.endpoints[0]!)).toEqual(["id", "row"]);
  });
});

function emptyComponents() {
  return { "plan-anchors": [] as ReturnType<typeof anchor>[], "plan-runs": [], "plan-equal-time": [],
    "fit-stats": [], eligible: [], "endpoint-runs": [], endpoints: [] };
}
async function onePageTarget(head: CommunityAnalysisWorkHead, components: unknown = emptyComponents(),
  sourceRows: V1PlanSourceRow[] = [{ id: 1, observed_at: "2026-08-01T00:00:00.000Z", observed_day: "2026-08-01",
    device_id: "synthetic-winner", provider: "openai_codex", limit_id: "codex", plan_type: "pro", plan_variant: "unknown" }]) {
  const i = head.identity;
  const identity: V1QuotaAcquisitionIdentity = { participantId: i.participantId, inputFingerprint: i.inputFingerprint,
    sourceMethodVersion: i.sourceMethodVersion, observedAtCutoff: i.observedAtCutoff, resetsAtCutoff: i.resetsAtCutoff,
    windowMinutes: i.windowMinutes, maxQuotaRows: i.maxQuotaRows };
  const state = decodeV1QuotaWorkCheckpoint(identity, head.control, components);
  let queries = 0;
  const step = await advanceV1QuotaAcquisitionPage({
    async readPlanPage() { queries++; return sourceRows; }, async readFitPage() { queries++; return []; },
  }, identity, new Map([["2026-08-01", "synthetic-winner"]]), budget(1), state);
  expect(queries).toBe(1);
  if (step.replay === null || step.checkpoint === null) throw new Error("synthetic page not stageable");
  const encoded = encodeV1QuotaWorkCheckpoint(step.checkpoint);
  return { target: { phase: step.replay.through.phase, control: encoded.control, components: encoded.components } satisfies CommunityAnalysisStageTarget,
    replay: step.replay, result: step.result, checkpoint: step.checkpoint };
}
async function stageSmall() {
  const head = await begin(), replayed = await onePageTarget(head);
  const beginStage = await beginCommunityAnalysisStage(db(), head, replayed.target, replayed.replay, budget());
  if (beginStage.status !== "ready") throw new Error("synthetic stage missing");
  return { head, stage: beginStage.stage, ...replayed };
}
async function finishWrites(head: CommunityAnalysisWorkHead, initial: CommunityAnalysisWorkStage,
  target: CommunityAnalysisStageTarget, replay: V1QuotaPageReplay) {
  let stage = initial;
  while (stage.mode === "writing") {
    const result = await writeCommunityAnalysisStagePage(db(), head, stage, target, replay, budget());
    if (result.status !== "ready") throw new Error("synthetic stage write refused");
    stage = result.stage;
  }
  return stage;
}
async function finishVerification(head: CommunityAnalysisWorkHead, initial: CommunityAnalysisWorkStage) {
  let stage = initial;
  do {
    const result = await verifyCommunityAnalysisStagePage(db(), head, stage, budget());
    if (result.status !== "ready") throw new Error("synthetic verification refused");
    stage = result.stage;
  } while (stage.verifiedOffset < stage.target.manifest.length);
  return stage;
}
async function seedLarge(count: number) {
  const components = emptyComponents();
  components["plan-anchors"] = Array.from({ length: count }, (_, index) => ({ ...anchor(),
    observedAtMs: anchor().observedAtMs + count - index, planVariant: `variant-${"x".repeat(56)}` }));
  let head = await begin();
  for (let start = 0; start < count; start += 384 * 32) {
    const parts = [];
    for (let offset = start; offset < Math.min(start + 384 * 32, count); offset += 384) {
      parts.push({ component: "plan-anchors" as const, partKey: offset / 384,
        value: components["plan-anchors"].slice(offset, offset + 384) });
    }
    const next = await commitCommunityAnalysisWorkPage(db(), head, { control: control(), phase: "plan", parts }, budget());
    if (next.status !== "ready") throw new Error("synthetic large checkpoint refused");
    head = next.head;
  }
  return { head, components };
}

describe("staged immutable checkpoint promotion", () => {
  it("resumes a prepared 128-row staged page without interchanging raw physical replay", async () => {
    const raw = await begin();
    const identity: V1QuotaAcquisitionIdentity = { participantId: IDENTITY.participantId,
      inputFingerprint: IDENTITY.inputFingerprint, sourceMethodVersion: IDENTITY.sourceMethodVersion,
      observedAtCutoff: IDENTITY.observedAtCutoff, resetsAtCutoff: IDENTITY.resetsAtCutoff,
      windowMinutes: IDENTITY.windowMinutes, maxQuotaRows: IDENTITY.maxQuotaRows };
    const rows: V1PlanSourceRow[] = Array.from({ length: 128 }, (_, offset) => ({ id: offset + 1,
      observed_at: new Date(Date.parse(IDENTITY.observedAtCutoff) + offset * 1000).toISOString(),
      observed_day: "2026-08-01", device_id: "synthetic-winner", provider: "openai_codex", limit_id: "codex",
      plan_type: "pro", plan_variant: "unknown" }));
    const replayPage = async () => advanceV1QuotaAcquisitionPage({ pageSize: 128,
      async readPlanPage(_cursor, limit) { expect(limit).toBe(128); return rows; },
      async readFitPage() { throw new Error("plan replay must read exactly one physical page"); },
    }, identity, new Map([["2026-08-01", "synthetic-winner"]]), budget(1), createV1QuotaAcquisitionCheckpoint(identity));
    const first = await replayPage();
    if (!first.checkpoint || !first.replay || first.replay.version !== "v1-quota-page-replay-2") throw new Error("expected prepared replay");
    expect(first.replay).toMatchObject({ version: "v1-quota-page-replay-2", readerPolicy: "prepared-source-days-1", pageSize: 128,
      from: { phase: "plan", cursor: { id: 0 } }, through: { phase: "plan", cursor: { id: 128 } } });
    const encoded = encodeV1QuotaWorkCheckpoint(first.checkpoint);
    const target: CommunityAnalysisStageTarget = { phase: first.replay.through.phase, control: encoded.control, components: encoded.components };
    expect(await beginCommunityAnalysisStage(db(), raw, target, first.replay, budget())).toEqual({ status: "replay_unresolved" });
    await db().prepare("DELETE FROM community_analysis_work WHERE participant_id=?").bind(IDENTITY.participantId).run();
    const prepared = await beginCommunityAnalysisWork(db(), IDENTITY, control(), budget(), undefined, "prepared-source-days-1");
    if (prepared.status !== "ready") throw new Error("expected prepared head");
    const rawReplay: V1QuotaPageReplay = { version: "v1-quota-page-replay-1", from: first.replay.from, through: first.replay.through,
      sourceQueryCount: 1, resolution: "resolved" };
    expect(await beginCommunityAnalysisStage(db(), prepared.head, target, rawReplay, budget())).toEqual({ status: "replay_unresolved" });
    const begun = await beginCommunityAnalysisStage(db(), prepared.head, target, first.replay, budget());
    if (begun.status !== "ready") throw new Error("expected prepared stage");
    expect(begun.stage.mode).toBe("writing");
    const restored = await readCommunityAnalysisStage(db(), prepared.head, budget());
    expect(restored).toEqual(begun);
    if (restored.status !== "ready") throw new Error("expected durable prepared stage");
    expect(await writeCommunityAnalysisStagePage(db(), prepared.head, restored.stage, target, rawReplay, budget()))
      .toEqual({ status: "replay_unresolved" });
    const replayed = await replayPage();
    expect(replayed).toEqual(first);
    const written = await finishWrites(prepared.head, restored.stage, target, first.replay);
    const verified = await finishVerification(prepared.head, written);
    const promoted = await promoteCommunityAnalysisStage(db(), prepared.head, verified, budget());
    if (promoted.status !== "ready") throw new Error("expected prepared promotion");
    expect(promoted.head.readerPolicy).toBe("prepared-source-days-1");
    await collectAll(promoted.head, promoted.stage);
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "ready", head: promoted.head });
    const parts = await readCommunityAnalysisWorkParts(db(), promoted.head, 0, budget());
    if (parts.status !== "ready") throw new Error("expected promoted prepared parts");
    expect(parts.done).toBe(true);
    const components: Record<V1QuotaWorkComponent, unknown[]> = emptyComponents();
    for (const part of parts.parts) {
      if (!Array.isArray(part.value)) throw new Error("expected component array");
      components[part.component].push(...part.value);
    }
    expect(decodeV1QuotaWorkCheckpoint(identity, promoted.head.control, components)).toEqual(first.checkpoint);
  });

  it.each([
    { sourceMethodVersion: "legacy-day-or-complete-domain-3:policy-2" },
    { observedAtCutoff: "2026-08-02T00:00:00.000Z", resetsAtCutoff: "2026-08-09T00:00:00.000Z" },
    { windowMinutes: 300 },
    { maxQuotaRows: 50000 },
  ])("disposes same-revision work only for an explicit changed policy/window: %j", async patch => {
    const fixture = await stageSmall();
    await finishWrites(fixture.head, fixture.stage, fixture.target, fixture.replay);
    const currentStage = await readCommunityAnalysisStage(db(), fixture.head, budget());
    if (currentStage.status !== "ready") throw new Error("expected stage");
    const replacement = { ...IDENTITY, ...patch };
    const inspected = await readCommunityAnalysisWorkForSupersession(db(), replacement, budget());
    expect(inspected).toEqual({ status: "ready", head: fixture.head, stage: currentStage.stage });
    const begun = await beginCommunityAnalysisSupersession(db(), fixture.head, replacement, budget(), currentStage.stage);
    if (begun.status !== "ready") throw new Error("expected supersession");
    expect(begun.stage.replay).toEqual({ version: "community-analysis-supersession-1", replacementIdentity: replacement });
    const restored = await readCommunityAnalysisWorkForSupersession(db(), replacement, budget());
    expect(restored).toEqual({ status: "ready", head: fixture.head, stage: begun.stage });
    await collectAll(fixture.head, begun.stage);
    const start = createV1QuotaAcquisitionCheckpoint({ participantId: replacement.participantId,
      inputFingerprint: replacement.inputFingerprint, sourceMethodVersion: replacement.sourceMethodVersion,
      observedAtCutoff: replacement.observedAtCutoff, resetsAtCutoff: replacement.resetsAtCutoff,
      windowMinutes: replacement.windowMinutes, maxQuotaRows: replacement.maxQuotaRows });
    const newHead = await beginCommunityAnalysisWork(db(), replacement, encodeV1QuotaWorkCheckpoint(start).control, budget());
    expect(newHead.status).toBe("ready");
    expect(await beginCommunityAnalysisSupersession(db(), fixture.head, replacement, budget(), currentStage.stage)).toEqual({ status: "stale" });
    expect(await collectCommunityAnalysisWorkGarbage(db(), fixture.head, begun.stage, budget())).toEqual({ status: "stale" });
    expect(await readCommunityAnalysisWork(db(), replacement, budget())).toEqual(newHead);
  });

  it("refuses fixed-time/fingerprint-only supersession and fences correction or competing policy disposal", async () => {
    const head = await saved(await begin());
    for (const replacement of [IDENTITY, { ...IDENTITY, fixedNow: "2026-09-02T00:00:00.000Z" },
      { ...IDENTITY, inputFingerprint: "b".repeat(64) }, { ...IDENTITY, inputRevision: 1, sourceMethodVersion: "changed" }]) {
      expect(await beginCommunityAnalysisSupersession(db(), head, replacement, budget())).toEqual({ status: "stale" });
      expect(await readCommunityAnalysisWorkForSupersession(db(), replacement, budget())).toEqual({ status: "stale" });
    }
    const replacement = { ...IDENTITY, sourceMethodVersion: "policy:changed" };
    const results = await Promise.all([0, 1].map(() => beginCommunityAnalysisSupersession(db(), head, replacement, budget())));
    expect(results.map(value => value.status).sort()).toEqual(["ready", "stale"]);
    const begun = results.find(value => value.status === "ready");
    if (!begun || begun.status !== "ready") throw new Error("expected winner");
    await db().prepare("UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=?")
      .bind(IDENTITY.participantId).run();
    expect(await collectCommunityAnalysisWorkGarbage(db(), head, begun.stage, budget())).toEqual({ status: "stale" });
    const newRevision = await beginCommunityAnalysisDiscard(db(), head, 1, budget(), begun.stage);
    if (newRevision.status !== "ready") throw new Error("expected corrected discard");
    expect(newRevision.stage.replay).toBeNull();
    await collectAll(head, newRevision.stage);
    expect(await payloads()).toEqual([]);
  });

  it("preserves same-source supersession tokens across bounded cleanup and owner erasure", async () => {
    const seeded = await seedLarge(14000), replacement = { ...IDENTITY, sourceMethodVersion: "policy:new" };
    const begun = await beginCommunityAnalysisSupersession(db(), seeded.head, replacement, budget());
    if (begun.status !== "ready") throw new Error("expected supersession");
    const before = (await payloads()).length;
    const page = await collectCommunityAnalysisWorkGarbage(db(), seeded.head, begun.stage, budget());
    expect(before - (await payloads()).length).toBe(32);
    if (page.status !== "ready" || page.done) throw new Error("expected bounded cleanup");
    expect(await readCommunityAnalysisWorkForSupersession(db(), replacement, budget()))
      .toEqual({ status: "ready", head: seeded.head, stage: page.stage });
    await db().prepare("DELETE FROM participants WHERE id=?").bind(IDENTITY.participantId).run();
    expect(await payloads()).toEqual([]);
    expect(await collectCommunityAnalysisWorkGarbage(db(), seeded.head, page.stage, budget())).toEqual({ status: "stale" });
    expect(await beginCommunityAnalysisSupersession(db(), seeded.head, replacement, budget(), page.stage)).toEqual({ status: "stale" });
  });

  it("promotes and restores a completed real reader page with its original numeric endpoint IDs", async () => {
    const identity: V1QuotaAcquisitionIdentity = { participantId: IDENTITY.participantId,
      inputFingerprint: IDENTITY.inputFingerprint, sourceMethodVersion: IDENTITY.sourceMethodVersion,
      observedAtCutoff: IDENTITY.observedAtCutoff, resetsAtCutoff: IDENTITY.resetsAtCutoff,
      windowMinutes: IDENTITY.windowMinutes, maxQuotaRows: IDENTITY.maxQuotaRows };
    const state = createV1QuotaAcquisitionCheckpoint(identity);
    const era = JSON.stringify(["openai_codex|codex", null, "pro", "unknown", anchor().observedAtMs]);
    const first = { id: 42, row: { occurrence_id: "synthetic-endpoint-42", observed_at: "2026-08-01T00:00:10.000Z",
      provider: "openai_codex", plan_type: "pro", plan_variant: "unknown", limit_id: "codex", slot: "seven_day",
      used_percent: 10, window_duration_minutes: 10080, resets_at: "2026-08-08T00:00:00.000Z", plan_era_key: era } };
    const last = { id: 77, row: { ...first.row, occurrence_id: "synthetic-endpoint-77", observed_at: "2026-08-01T00:00:20.000Z" } };
    state.phase = "endpoints"; state.plan.anchors = [anchor()]; state.reset = first.row.resets_at;
    state.cursor = { id: last.id, observedAt: last.row.observed_at, resetsAt: last.row.resets_at };
    state.eligible = [JSON.stringify([state.reset, era])]; state.endpoints = [first];
    state.runs = [[era, "seven_day", { firstId: first.id, last }]];
    const encoded = encodeV1QuotaWorkCheckpoint(state), initial = await begin();
    const delta = await prepareCommunityAnalysisWorkDelta(initial, encoded.components);
    if (delta.status !== "ready") throw new Error("expected initial delta");
    const saved = await commitCommunityAnalysisWorkPage(db(), initial,
      { control: encoded.control, phase: "endpoints", parts: delta.parts }, budget());
    if (saved.status !== "ready") throw new Error("expected initial endpoint checkpoint");
    const page = await onePageTarget(saved.head, structuredClone(encoded.components), []);
    expect(page.result.status).toBe("complete");
    expect(page.target.phase).toBe("complete"); expect(page.target.control.phase).toBe("endpoints");
    expect(page.checkpoint.endpoints.map(value => value.id)).toEqual([42, 77]);
    const begun = await beginCommunityAnalysisStage(db(), saved.head, page.target, page.replay, budget());
    if (begun.status !== "ready") throw new Error("expected completed stage");
    const regenerated = await onePageTarget(saved.head, structuredClone(encoded.components), []);
    expect(regenerated.replay).toEqual(page.replay); expect(regenerated.target).toEqual(page.target);
    const written = await finishWrites(saved.head, begun.stage, regenerated.target, regenerated.replay);
    const verified = await finishVerification(saved.head, written);
    const promoted = await promoteCommunityAnalysisStage(db(), saved.head, verified, budget());
    if (promoted.status !== "ready") throw new Error("expected completed promotion");
    await collectAll(promoted.head, promoted.stage);
    const reloaded = await readCommunityAnalysisWork(db(), IDENTITY, budget());
    if (reloaded.status !== "ready") throw new Error("expected durable completed head");
    expect(reloaded.head.phase).toBe("complete");
    const components: Record<V1QuotaWorkComponent, unknown[]> = emptyComponents(), interner = createV1QuotaWorkInterner();
    try {
      for (let offset = 0;;) {
        const read = await readCommunityAnalysisWorkParts(db(), reloaded.head, offset, budget());
        if (read.status !== "ready") throw new Error("expected completed part page");
        for (const part of read.parts) {
          interner.internPart(part.component, part.value);
          if (!Array.isArray(part.value)) throw new Error("expected completed part array");
          for (const entry of part.value) components[part.component].push(entry);
        }
        if (read.done) break;
        offset = read.nextOffset;
      }
    } finally { interner.release(); }
    const restored = decodeV1QuotaWorkCheckpoint(identity, reloaded.head.control, components);
    expect(restored).toEqual(page.checkpoint);
    expect(restored.endpoints.map(value => value.id)).toEqual([42, 77]);
    if (page.result.status !== "complete") throw new Error("expected completed analytical input");
    expect(restored.endpoints.map(value => value.row)).toEqual(page.result.quotaRows);
    expect(restored.plan.anchors).toEqual(page.result.planAnchors);
    const persisted = canonicalJson({ control: reloaded.head.control, components });
    expect(persisted).not.toContain("attributionIndex"); expect(persisted).not.toContain("device_id");
    expect(await beginCommunityAnalysisStage(db(), reloaded.head, page.target, page.replay, budget())).toEqual({ status: "replay_unresolved" });
  });

  it("persists more than32 changed chunks across restarts, preserving the old checkpoint until verified promotion", async () => {
    const seeded = await seedLarge(24000), oldHead = JSON.parse(JSON.stringify(seeded.head));
    const replayed = await onePageTarget(seeded.head, structuredClone(seeded.components), []);
    const begun = await beginCommunityAnalysisStage(db(), seeded.head, replayed.target, replayed.replay, budget());
    if (begun.status !== "ready") throw new Error("expected large stage");
    expect(begun.stage.writeManifest.length).toBeGreaterThan(32);
    let stage = begun.stage;
    while (stage.mode === "writing") {
      const regenerated = await onePageTarget(seeded.head, structuredClone(seeded.components), []);
      expect(regenerated.replay).toEqual(replayed.replay);
      const b = budget(100, 20), expected = Math.min(32, stage.writeManifest.length - stage.writeOffset) + 1;
      const next = await writeCommunityAnalysisStagePage(db(), seeded.head, stage, regenerated.target, regenerated.replay, b);
      expect(b.remainingQueries).toBe(100 - expected);
      if (next.status !== "ready") throw new Error("expected resumed write");
      const reloaded = await readCommunityAnalysisStage(db(), seeded.head, budget());
      expect(reloaded).toEqual(next);
      stage = next.stage;
      expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "ready", head: oldHead });
    }
    expect(await promoteCommunityAnalysisStage(db(), seeded.head, stage, budget())).toEqual({ status: "deferred" });
    while (stage.verifiedOffset < stage.target.manifest.length) {
      const b = budget(20, 4), next = await verifyCommunityAnalysisStagePage(db(), seeded.head, stage, b);
      expect(b.remainingQueries).toBe(17);
      if (next.status !== "ready") throw new Error("expected verification page");
      stage = next.stage;
      expect(await readCommunityAnalysisStage(db(), seeded.head, budget())).toEqual(next);
    }
    const promoted = await promoteCommunityAnalysisStage(db(), seeded.head, stage, budget());
    if (promoted.status !== "ready") throw new Error("expected promotion");
    expect(promoted.head.phase).toBe("fitability");
    expect(await readCommunityAnalysisWorkParts(db(), seeded.head, 0, budget())).toEqual({ status: "stale" });
    const followup = await onePageTarget(promoted.head, replayed.target.components, []);
    expect(await beginCommunityAnalysisStage(db(), promoted.head, followup.target, followup.replay, budget())).toEqual({ status: "stale" });
    let garbage = promoted.stage;
    for (;;) {
      const before = (await payloads()).length;
      const result = await collectCommunityAnalysisWorkGarbage(db(), promoted.head, garbage, budget());
      expect(before - (await payloads()).length).toBeLessThanOrEqual(32);
      if (result.status !== "ready") throw new Error("expected collection page");
      if (result.done) break;
      garbage = result.stage;
      expect(await readCommunityAnalysisStage(db(), promoted.head, budget())).toEqual({ status: "ready", stage: garbage });
    }
    expect(await payloads()).toHaveLength(new Set(promoted.head.manifest.map(value => `${value.component}:${value.sha256}`)).size);
    expect(await beginCommunityAnalysisStage(db(), promoted.head, followup.target, followup.replay, budget())).toMatchObject({ status: "ready" });
  });

  it("requires a resolved exact one-page replay and refuses changed regeneration without writing", async () => {
    const fixture = await stageSmall(), before = await payloads();
    expect(await beginCommunityAnalysisStage(db(), fixture.head, fixture.target, null, budget())).toEqual({ status: "replay_unresolved" });
    const wrongMarker = { ...fixture.replay, sourceQueryCount: 2 };
    expect(await writeCommunityAnalysisStagePage(db(), fixture.head, fixture.stage, fixture.target, wrongMarker, budget()))
      .toEqual({ status: "replay_unresolved" });
    const changed = structuredClone(fixture.target);
    const decoded = changed.components as ReturnType<typeof emptyComponents>;
    decoded["plan-anchors"][0]!.observedAtMs += 1;
    expect(await writeCommunityAnalysisStagePage(db(), fixture.head, fixture.stage, changed, fixture.replay, budget()))
      .toEqual({ status: "replay_unresolved" });
    expect(await payloads()).toEqual(before);
    expect(await readCommunityAnalysisStage(db(), fixture.head, budget())).toEqual({ status: "ready", stage: fixture.stage });
  });

  it("reuses unchanged immutable chunks and cannot update them in place", async () => {
    const head = await saved(await begin()), components = emptyComponents();
    components["plan-anchors"] = part().value;
    const replayed = await onePageTarget(head, components, []);
    const begun = await beginCommunityAnalysisStage(db(), head, replayed.target, replayed.replay, budget());
    if (begun.status !== "ready") throw new Error("expected reused stage");
    expect(begun.stage.writeManifest).toEqual([]);
    expect(begun.stage.mode).toBe("verifying");
    await expect(db().prepare("UPDATE community_analysis_work_parts SET payload_json=payload_json").run()).rejects.toThrow("immutable");
    const verified = await finishVerification(head, begun.stage);
    const promoted = await promoteCommunityAnalysisStage(db(), head, verified, budget());
    if (promoted.status !== "ready") throw new Error("expected promotion");
    await collectAll(promoted.head, promoted.stage);
    expect(await payloads()).toHaveLength(1);
  });

  it("rolls back an interrupted stage page and rejects duplicate competing writers", async () => {
    const seeded = await seedLarge(2000), replayed = await onePageTarget(seeded.head, structuredClone(seeded.components), []);
    const begun = await beginCommunityAnalysisStage(db(), seeded.head, replayed.target, replayed.replay, budget());
    if (begun.status !== "ready") throw new Error("expected stage");
    const before = await payloads();
    await db().prepare(`CREATE TRIGGER synthetic_staging_crash BEFORE INSERT ON community_analysis_work_parts
      WHEN (SELECT COUNT(*) FROM community_analysis_work_parts)=${before.length + 1}
      BEGIN SELECT RAISE(ABORT,'synthetic staged interruption'); END`).run();
    await expect(writeCommunityAnalysisStagePage(db(), seeded.head, begun.stage, replayed.target, replayed.replay, budget())).rejects.toThrow();
    expect(await payloads()).toEqual(before);
    expect(await readCommunityAnalysisStage(db(), seeded.head, budget())).toEqual(begun);
    await db().prepare("DROP TRIGGER synthetic_staging_crash").run();
    const results = await Promise.all([0, 1].map(() => writeCommunityAnalysisStagePage(db(), seeded.head, begun.stage, replayed.target, replayed.replay, budget())));
    expect(results.map(value => value.status).sort()).toEqual(["ready", "stale"]);
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "ready", head: seeded.head });
  });

  it("refuses missing chunks before verification and rechecks existence at promotion", async () => {
    const fixture = await stageSmall();
    const written = await finishWrites(fixture.head, fixture.stage, fixture.target, fixture.replay);
    const verified = await finishVerification(fixture.head, written);
    await db().prepare("DELETE FROM community_analysis_work_parts").run();
    expect(await verifyCommunityAnalysisStagePage(db(), fixture.head, written, budget())).toEqual({ status: "stale" });
    expect(await promoteCommunityAnalysisStage(db(), fixture.head, verified, budget())).toEqual({ status: "stale" });
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "ready", head: fixture.head });
    expect(await readCommunityAnalysisStage(db(), fixture.head, budget())).toEqual({ status: "ready", stage: verified });
    const replayRead = { ...verified, verifiedOffset: 0 };
    // A fabricated cursor cannot bypass the stored stage digest/CAS token.
    expect(await verifyCommunityAnalysisStagePage(db(), fixture.head, replayRead, budget())).toEqual({ status: "stale" });
  });

  it("detects missing and corrupt unverified payloads and corrupted staged metadata", async () => {
    const fixture = await stageSmall();
    const written = await finishWrites(fixture.head, fixture.stage, fixture.target, fixture.replay);
    const expected = written.target.manifest[0]!;
    await db().prepare("DELETE FROM community_analysis_work_parts").run();
    expect(await verifyCommunityAnalysisStagePage(db(), fixture.head, written, budget())).toEqual({ status: "corrupt" });
    await db().prepare("INSERT INTO community_analysis_work_parts VALUES (?,?,'plan-anchors','[]',?,2)")
      .bind(IDENTITY.participantId, fixture.head.runId, expected.sha256).run();
    expect(await verifyCommunityAnalysisStagePage(db(), fixture.head, written, budget())).toEqual({ status: "corrupt" });
    await db().prepare("UPDATE community_analysis_work_stage SET target_manifest_json='[]'").run();
    expect(await readCommunityAnalysisStage(db(), fixture.head, budget())).toEqual({ status: "corrupt" });
    expect(await readCommunityAnalysisWork(db(), IDENTITY, budget())).toEqual({ status: "ready", head: fixture.head });
  });

  it.each(["write", "verify", "promote"] as const)("fences a correction interleaved immediately before staged %s mutation", async operation => {
    const fixture = await stageSmall(); let stage = fixture.stage;
    if (operation !== "write") stage = await finishWrites(fixture.head, stage, fixture.target, fixture.replay);
    if (operation === "promote") stage = await finishVerification(fixture.head, stage);
    const base = db(); let interleaved = false;
    const correction = async () => {
      if (interleaved) return;
      interleaved = true;
      await base.prepare("UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=?")
        .bind(IDENTITY.participantId).run();
    };
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (operation === "verify" && property === "all" && sql.includes("community_analysis_work_parts")) return async () => {
          const result = await target.all(); await correction(); return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const raced = new Proxy(base, { get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch" && operation !== "verify") return async (statements: D1PreparedStatement[]) => {
        await correction(); return target.batch(statements);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const before = await payloads();
    const result = operation === "write"
      ? await writeCommunityAnalysisStagePage(raced, fixture.head, stage, fixture.target, fixture.replay, budget())
      : operation === "verify" ? await verifyCommunityAnalysisStagePage(raced, fixture.head, stage, budget())
        : await promoteCommunityAnalysisStage(raced, fixture.head, stage, budget());
    expect(result).toEqual({ status: "stale" }); expect(interleaved).toBe(true);
    expect(await payloads()).toEqual(before);
    const inspection = await readCommunityAnalysisWorkForDiscard(db(), IDENTITY.participantId, 1, budget());
    expect(inspection).toEqual({ status: "ready", head: fixture.head, stage });
  });

  it("preserves shared query reserves and deadlines for every staged operation", async () => {
    const fixture = await stageSmall();
    const b = budget(4, 3);
    expect(await writeCommunityAnalysisStagePage(db(), fixture.head, fixture.stage, fixture.target, fixture.replay, b))
      .toEqual({ status: "deferred" }); expect(b.remainingQueries).toBe(4);
    expect(await readCommunityAnalysisStage(db(), fixture.head, b)).toMatchObject({ status: "ready" });
    expect(b.remainingQueries).toBe(3);
    const written = await finishWrites(fixture.head, fixture.stage, fixture.target, fixture.replay);
    expect(await verifyCommunityAnalysisStagePage(db(), fixture.head, written, budget(4, 2))).toEqual({ status: "deferred" });
    const verified = await finishVerification(fixture.head, written);
    expect(await promoteCommunityAnalysisStage(db(), fixture.head, verified, budget(3, 2))).toEqual({ status: "deferred" });
    expect(await promoteCommunityAnalysisStage(db(), fixture.head, verified, { ...budget(), now: () => 1 }))
      .toEqual({ status: "deferred" });
    const promoted = await promoteCommunityAnalysisStage(db(), fixture.head, verified, budget());
    if (promoted.status !== "ready") throw new Error("expected promotion");
    expect(await collectCommunityAnalysisWorkGarbage(db(), promoted.head, promoted.stage, budget(34, 1))).toEqual({ status: "deferred" });
    const gcBudget = budget(100, 10);
    expect(await collectCommunityAnalysisWorkGarbage(db(), promoted.head, promoted.stage, gcBudget)).toMatchObject({ status: "ready", done: false });
    expect(gcBudget.remainingQueries).toBe(98); // one indexed key read + one cursor CAS, no referenced deletion
  });

  it("discards stale-source work in bounded pages across restarts without a normal restart cascade", async () => {
    const seeded = await seedLarge(14000), replayed = await onePageTarget(seeded.head, structuredClone(seeded.components), []);
    const begun = await beginCommunityAnalysisStage(db(), seeded.head, replayed.target, replayed.replay, budget());
    if (begun.status !== "ready") throw new Error("expected stage");
    const partial = await writeCommunityAnalysisStagePage(db(), seeded.head, begun.stage, replayed.target, replayed.replay, budget());
    if (partial.status !== "ready") throw new Error("expected partial write");
    await db().prepare("UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=?").bind(IDENTITY.participantId).run();
    expect(await beginCommunityAnalysisWork(db(), { ...IDENTITY, inputRevision: 1 }, control(), budget(), seeded.head)).toEqual({ status: "stale" });
    const inspection = await readCommunityAnalysisWorkForDiscard(db(), IDENTITY.participantId, 1, budget());
    if (inspection.status !== "ready" || !inspection.stage) throw new Error("expected discard inspection");
    const discard = await beginCommunityAnalysisDiscard(db(), inspection.head, 1, budget(), inspection.stage);
    if (discard.status !== "ready") throw new Error("expected discard");
    let stage = discard.stage;
    let pages = 0;
    for (;;) {
      const prior = (await payloads()).length;
      const result = await collectCommunityAnalysisWorkGarbage(db(), seeded.head, stage, budget());
      expect(prior - (await payloads()).length).toBeLessThanOrEqual(32);
      if (result.status !== "ready") throw new Error("expected discard page");
      pages++;
      if (result.done) { expect(result.discarded).toBe(true); break; }
      const restarted = await readCommunityAnalysisWorkForDiscard(db(), IDENTITY.participantId, 1, budget());
      if (restarted.status !== "ready" || !restarted.stage) throw new Error("expected resumed discard");
      stage = restarted.stage;
    }
    expect(pages).toBeGreaterThan(2);
    expect(await payloads()).toEqual([]);
    expect(await readCommunityAnalysisWork(db(), { ...IDENTITY, inputRevision: 1 }, budget())).toEqual({ status: "absent" });
    expect(await beginCommunityAnalysisWork(db(), { ...IDENTITY, inputRevision: 1 }, control(), budget())).toMatchObject({ status: "ready" });
    expect(await writeCommunityAnalysisStagePage(db(), seeded.head, partial.stage, replayed.target, replayed.replay, budget())).toEqual({ status: "stale" });
  });

  it.each(["writing", "verifying", "garbage_collecting", "discarding"] as const)("erases head, stage and chunks during %s", async mode => {
    const fixture = await stageSmall(); let head = fixture.head, stage = fixture.stage;
    if (mode === "verifying" || mode === "garbage_collecting") stage = await finishWrites(head, stage, fixture.target, fixture.replay);
    if (mode === "garbage_collecting") {
      stage = await finishVerification(head, stage);
      const promoted = await promoteCommunityAnalysisStage(db(), head, stage, budget());
      if (promoted.status !== "ready") throw new Error("expected promotion");
      head = promoted.head; stage = promoted.stage;
    }
    if (mode === "discarding") {
      await db().prepare("UPDATE community_analytical_input_versions SET revision=1 WHERE participant_id=?").bind(IDENTITY.participantId).run();
      const result = await beginCommunityAnalysisDiscard(db(), head, 1, budget(), stage);
      if (result.status !== "ready") throw new Error("expected discard");
      stage = result.stage;
    }
    await db().prepare("DELETE FROM participants WHERE id=?").bind(IDENTITY.participantId).run();
    expect(await payloads()).toEqual([]);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM community_analysis_work_stage").first()).toEqual({ n: 0 });
    expect(await db().prepare("SELECT COUNT(*) AS n FROM community_analysis_work").first()).toEqual({ n: 0 });
    expect(await readCommunityAnalysisStage(db(), head, budget())).toEqual({ status: "absent" });
    if (mode === "writing") expect(await writeCommunityAnalysisStagePage(db(), head, stage, fixture.target, fixture.replay, budget())).toEqual({ status: "stale" });
  });
});
