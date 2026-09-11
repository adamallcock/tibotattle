import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createCommunityAnalysisWorkStore } from "../src/community-analysis-work";
import { communityAnalysisAcquisitionIdentity } from "../src/community-analysis-runner";
import { createV1QuotaAcquisitionCheckpoint, encodeV1QuotaWorkCheckpoint,
  advanceV1QuotaAcquisitionPage } from "../src/quota-analysis-v1-reader";
import { createV1QuotaPageReader } from "../src/quota-fit-projection";
import { ensurePreparedV1Window, createPreparedV1EvidenceReader } from "../src/prepared-v1-evidence";
import { loadV1SourcePin } from "../src/telemetry-v1-source-selection";
import { ensureCommunityHistoryDependency, loadCommunityHistorySource,
  rebindCommunityHistoryWork } from "../src/community-model-history-dependencies";
import { warmCommunityModelHistory, readCommunityModelHistoryProgress } from "../src/community-model-history";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";
import { MODEL_HISTORY_TEST_DAY, seedModelHistoryFixture, insertModelHistoryRecords,
  modelHistorySourceInput } from "./helpers/model-history";
import { createUploadAuthorizationMaterial, storeUploadAuthorization, claimUploadAuthorization } from "../src/session";
import { createV11DeviceFixture, makeV11Day, stageV11Day } from "./helpers/telemetry-v11";
import { createTelemetryV11DomainPredecessor, activateTelemetryV11Domain } from "../src/telemetry-v11-domain";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "../src/crypto";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";

const db = () => env.USAGE_MONITOR_DB;
const DAY = MODEL_HISTORY_TEST_DAY, NOW = Date.parse("2026-09-06T12:00:00.000Z");
const LEASE = "synthetic-history-dependency-lease";
const store = createCommunityAnalysisWorkStore("model-history");
const budget = (remainingQueries = 1000) => ({ remainingQueries, deadlineMs: Date.now() + 30_000 });
type Fixture = Awaited<ReturnType<typeof seedModelHistoryFixture>>;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await db().prepare(`UPDATE retention_state SET maintenance_lease_token=?,
    maintenance_lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') WHERE singleton=1`).bind(LEASE).run();
});

async function context(fixture: Fixture, database = db()) {
  const source = await loadCommunityHistorySource(database, fixture.participantId, DAY, budget());
  if (!source) throw new Error("synthetic source missing");
  const dependency = await ensureCommunityHistoryDependency(database, source.pin, LEASE, budget());
  if (!dependency) throw new Error("synthetic dependency missing");
  const { identity } = await modelHistorySourceInput(fixture.participantId);
  return { ...source, dependency, identity };
}
async function append(fixture: Fixture, day = "2026-09-07", label = "outside") {
  await insertModelHistoryRecords(fixture, label, [{ stream: "quota", observedAt: `${day}T00:00:00.000Z`,
    usedPercent: 1, resetsAt: `${day}T23:59:59.999Z` }]);
}
async function sessionChunk(fixture: Fixture, day: string, label: string, createdAt: string) {
  const id = `history-session-${label}`, digest = await sha256Hex(id);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const grant = await createDeviceUploadAuthorization(db(), principal, digest, 200);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${grant.uploadAuthorization}`,
    { envelopeDigest: digest, bodyBytes: 200, contentType: "application/json" });
  const previous = await db().prepare(`SELECT COALESCE(MAX(chunk_seq),-1) AS sequence FROM telemetry_v1_chunks
    WHERE participant_id=? AND device_id=? AND stream='session' AND chunk_day=?`)
    .bind(fixture.participantId, fixture.deviceId, day).first<{ sequence: number }>();
  await db().prepare(`INSERT INTO telemetry_v1_chunks(id,participant_id,device_id,stream,chunk_day,chunk_seq,
    revision,chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at)
    VALUES(?,?,?,'session',?,?,1,?,?,'synthetic-history-session',1,1,?,?,?)`)
    .bind(id, fixture.participantId, fixture.deviceId, day, previous!.sequence + 1, digest, digest,
      `synthetic/history/session/${id}`, claimed.authorizationId, createdAt).run();
  await db().prepare(`INSERT INTO telemetry_v1_records(chunk_row_id,participant_id,device_id,stream,occurrence_id,
    observed_at,observed_day,provider,record_json) VALUES(?,?,?,'session',?,?,?,'openai_codex','{}')`)
    .bind(id, fixture.participantId, fixture.deviceId, id, `${day}T12:00:00.000Z`, day).run();
}
async function parts() {
  return (await db().prepare("SELECT * FROM community_model_history_work_parts ORDER BY participant_id,component,payload_sha256").all()).results;
}
async function rawWork() {
  return Promise.all(["community_model_history_work", "community_model_history_work_stage"].map(async table =>
    (await db().prepare(`SELECT * FROM ${table}`).all()).results));
}
async function staged(mode: "writing" | "verifying" | "garbage_collecting", legacy = true, prepared = false) {
  const fixture = await seedModelHistoryFixture({ binCount: 10 });
  const initial = await context(fixture);
  const legacyPin = await loadV1SourcePin(db(), initial.pin.scope, { legacyInputRevisions: [initial.identity.inputRevision] });
  const identity = { ...initial.identity, inputFingerprint: legacy
    ? legacyPin.legacyFingerprints![String(initial.identity.inputRevision)]! : initial.identity.inputFingerprint };
  const acquisition = communityAnalysisAcquisitionIdentity(identity);
  const checkpoint = createV1QuotaAcquisitionCheckpoint(acquisition);
  const encoded = encodeV1QuotaWorkCheckpoint(checkpoint);
  const begun = await store.beginCommunityAnalysisWork(db(), identity, encoded.control, budget(), undefined,
    prepared ? "prepared-source-days-1" : undefined);
  if (begun.status !== "ready") throw new Error("synthetic work missing");
  let head = begun.head;
  if (prepared) expect((await ensurePreparedV1Window(db(), initial.pin,
    { maxPages: 64, deadlineMs: Date.now() + 30_000, budget: budget() })).status).toBe("complete");
  const reader = prepared ? (await createPreparedV1EvidenceReader(db(), initial.pin)).quotaReader
    : await createV1QuotaPageReader(db(), fixture.participantId, "2026-09-06T00:00:00.000Z");
  const step = await advanceV1QuotaAcquisitionPage(reader, acquisition,
    new Map(initial.pin.winners.map(winner => [winner.observed_day, winner.device_id])), budget(1), checkpoint);
  if (!step.replay || !step.checkpoint) throw new Error("synthetic replay missing");
  const targetEncoded = encodeV1QuotaWorkCheckpoint(step.checkpoint);
  const target = { phase: step.replay.through.phase, control: targetEncoded.control, components: targetEncoded.components };
  const beganStage = await store.beginCommunityAnalysisStage(db(), head, target, step.replay, budget());
  if (beganStage.status !== "ready") throw new Error("synthetic stage missing");
  let stage = beganStage.stage;
  expect(stage.mode).toBe("writing");
  if (mode !== "writing") {
    const written = await store.writeCommunityAnalysisStagePage(db(), head, stage, target, step.replay, budget());
    if (written.status !== "ready") throw new Error("synthetic stage write missing");
    stage = written.stage;
    expect(stage.mode).toBe("verifying");
  }
  if (mode === "garbage_collecting") {
    const verified = await store.verifyCommunityAnalysisStagePage(db(), head, stage, budget());
    if (verified.status !== "ready") throw new Error("synthetic stage verification missing");
    const promoted = await store.promoteCommunityAnalysisStage(db(), head, verified.stage, budget());
    if (promoted.status !== "ready") throw new Error("synthetic stage promotion missing");
    head = promoted.head; stage = promoted.stage;
  }
  return { fixture, initial, head, stage, target, replay: step.replay };
}
async function rebind(fixture: Fixture, database = db()) {
  const current = await context(fixture);
  const status = await rebindCommunityHistoryWork(database, current.identity, current.pin, current.previousWorkFingerprint,
    current.dependency, LEASE, budget());
  return { ...current, status };
}
function beforeBatch(action: () => Promise<void>) {
  let done = false;
  return new Proxy(db(), { get(target, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      if (!done) { done = true; await action(); }
      return target.batch(statements);
    };
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
function forbidAcquisition() {
  return new Proxy(db(), { get(target, property) {
    if (property === "prepare") return (sql: string) => {
      if (/telemetry_v1_records|telemetry_v1_quota_fit_rows|community_prepared_/u.test(sql)) {
        throw new Error("terminal reuse unexpectedly acquired analytical evidence");
      }
      return target.prepare(sql);
    };
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
async function warm(maxQueries = 900, database = db()) {
  const meter = createD1InvocationBudget(maxQueries);
  return warmCommunityModelHistory(meter.wrap(database), NOW, { meter, deadlineMs: Date.now() + 30_000, maintenanceLease: LEASE });
}
async function resultRow(participantId: string) {
  return db().prepare("SELECT * FROM community_model_history_results WHERE participant_id=? AND day=?").bind(participantId, DAY)
    .first<{ input_revision: number; input_fingerprint: string; dependency_revision: number; result_json: string; computed_at: string }>();
}
async function legacy(fixture: Fixture) {
  await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE format_rank=2").run();
  const material = await createUploadAuthorizationMaterial(fixture.participantId, fixture.sessionId, "b".repeat(64), 1);
  await storeUploadAuthorization(db(), material);
  const claimed = await claimUploadAuthorization(db(), `Upload ${material.encoded}`,
    { envelopeDigest: "b".repeat(64), bodyBytes: 1, contentType: "application/json" });
  const id = `legacy:${fixture.participantId}`, time = `${DAY}T12:00:00.000Z`;
  await db().prepare(`INSERT INTO telemetry_contributions(id,participant_id,plaintext_digest,envelope_digest,r2_key,status,
    schema_version,transport_schema_version,range_start,range_end,client_platform,provider_policy_epoch,
    estimated_api_cost_usd,priced_event_coverage_percent,unknown_model_event_count,unknown_billable_units,
    price_basis,declared_record_count,created_at,upload_authorization_id)
    VALUES(?,?,?,?,?,'accepted','telemetry-contribution-v0.1','telemetry-contribution-v0.2',?,?,'macos','unknown',
      NULL,0,0,0,'unavailable',0,?,?)`)
    .bind(id, fixture.participantId, "a".repeat(64), "b".repeat(64), `synthetic/history/legacy/${id}`,
      time, `${DAY}T23:59:59.999Z`, time, claimed.authorizationId).run();
  return id;
}
async function successor(fixture: Fixture) {
  fixture = await createV11DeviceFixture(db(), { participantId: fixture.participantId, grant: true });
  const day = new Date().toISOString().slice(0, 10);
  const staged = await stageV11Day(db(), fixture, await makeV11Day(day, {}));
  const predecessor = await createTelemetryV11DomainPredecessor(db(), fixture);
  const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: day, throughDay: day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: [{ day, manifestId: staged.manifestId, manifestDigest: staged.manifestDigest }], manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(db(), fixture, manifest);
}

describe("date-scoped historical dependencies", () => {
  it.each(["writing", "verifying", "garbage_collecting"] as const)("preserves a pre-upgrade %s stage after an unrelated upload", async mode => {
    const value = await staged(mode);
    const beforeParts = await parts();
    await append(value.fixture);
    const current = await rebind(value.fixture);
    expect(current.identity.inputRevision).toBeGreaterThan(value.head.identity.inputRevision);
    expect(current.pin.fingerprint).toBe(value.initial.pin.fingerprint);
    expect(current.status).toBe("ready");
    const head = await store.readCommunityAnalysisWork(db(), current.identity, budget());
    if (head.status !== "ready") throw new Error("rebound head unreadable");
    expect(head.head).toEqual({ ...value.head, identity: current.identity });
    const stage = await store.readCommunityAnalysisStage(db(), head.head, budget());
    if (stage.status !== "ready") throw new Error("rebound stage unreadable");
    expect(stage.stage).toEqual({ ...value.stage, revision: value.stage.revision + 1,
      target: { ...value.stage.target, stateSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
    expect(stage.stage.target.stateSha256).not.toBe(value.stage.target.stateSha256);
    expect(await parts()).toEqual(beforeParts);
    expect((await store.readCommunityAnalysisWork(db(), value.head.identity, budget())).status).toBe("stale");
    if (mode === "writing") {
      expect((await store.writeCommunityAnalysisStagePage(db(), value.head, value.stage, value.target, value.replay, budget())).status).toBe("stale");
      expect((await store.writeCommunityAnalysisStagePage(db(), head.head, stage.stage, value.target, value.replay, budget())).status).toBe("ready");
    } else if (mode === "verifying") {
      expect((await store.verifyCommunityAnalysisStagePage(db(), head.head, stage.stage, budget())).status).toBe("ready");
    }
  });

  it("preserves the prepared-reader policy and makes repeated rebinding a no-op", async () => {
    const value = await staged("verifying", false, true);
    await append(value.fixture);
    expect((await rebind(value.fixture)).status).toBe("ready");
    const before = await rawWork();
    expect((await rebind(value.fixture)).status).toBe("ready");
    expect(await rawWork()).toEqual(before);
    expect(before[0]![0]).toMatchObject({ reader_policy: "prepared-source-days-1", run_id: value.head.runId });
  });

  it("does not touch a closed window for uploads before or after it, but invalidates either inclusive boundary", async () => {
    const fixture = await seedModelHistoryFixture({ binCount: 10 });
    const initial = await context(fixture);
    const beforeDay = new Date(Date.parse(`${initial.dependency.fromDay}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
    await append(fixture, beforeDay, "before-window"); await append(fixture);
    const outside = await context(fixture);
    expect(outside.dependency).toEqual(initial.dependency);
    for (const [index, day] of [initial.dependency.fromDay, DAY].entries()) {
      await append(fixture, day, `boundary-${index}`);
      const next = await context(fixture);
      expect(next.dependency.revision).toBe(initial.dependency.revision + index + 1);
      expect(next.pin.fingerprint).not.toBe(initial.pin.fingerprint);
    }
  });

  it("reuses a terminal result after losing-device or irrelevant session changes but rejects a new analytical winner", async () => {
    const fixture = await seedModelHistoryFixture();
    for (let pass = 0; pass < 5 && !(await resultRow(fixture.participantId)); pass++) await warm();
    const before = await resultRow(fixture.participantId), initial = await context(fixture);
    if (!before) throw new Error("synthetic terminal result missing");
    const second = await createV11DeviceFixture(db(), { participantId: fixture.participantId });
    await append(second, "2026-09-01", "losing-device");
    await db().prepare("UPDATE telemetry_v1_chunks SET created_at='2026-09-01T00:00:00.000Z' WHERE device_id=?")
      .bind(second.deviceId).run();
    await sessionChunk(second, "2026-09-01", "losing-new-session", "2026-09-09T00:00:00.000Z");
    await sessionChunk(fixture, "2026-09-01", "winning-new-session", "2026-09-10T00:00:00.000Z");
    const dirty = await context(fixture);
    expect(dirty.dependency.revision).toBeGreaterThan(initial.dependency.revision);
    expect(dirty.pin.fingerprint).toBe(initial.pin.fingerprint);
    expect(await warm(40)).toMatchObject({ resolvedAccounts: 0, publishedDays: 0 }); // dirty until exact proof is adopted
    expect(await warm(900, forbidAcquisition())).toMatchObject({ resolvedAccounts: 1, publishedDays: 1 });
    const adopted = await resultRow(fixture.participantId);
    expect(JSON.parse(adopted!.result_json)).toEqual(JSON.parse(before.result_json));
    expect(adopted!.dependency_revision).toBe(dirty.dependency.revision);
    // A newer analytical chunk elects the second device; the old values cannot
    // be relabelled with that genuinely different evidence identity.
    await db().prepare("UPDATE telemetry_v1_chunks SET created_at='2026-09-11T00:00:00.000Z' WHERE device_id=? AND stream='quota'")
      .bind(second.deviceId).run();
    expect((await context(fixture)).pin.fingerprint).not.toBe(initial.pin.fingerprint);
    expect(await warm(40)).toMatchObject({ resolvedAccounts: 0, publishedDays: 0 });
  });

  it("includes a session-only fallback's device identity but not its unchanged transport vector", async () => {
    const fixture = await seedModelHistoryFixture({ binCount: 10 });
    await sessionChunk(fixture, "2026-08-31", "fallback-original", "2026-08-31T12:00:00.000Z");
    const initial = await context(fixture);
    await sessionChunk(fixture, "2026-08-31", "fallback-same-device", "2026-08-31T13:00:00.000Z");
    expect((await context(fixture)).pin.fingerprint).toBe(initial.pin.fingerprint);
    const second = await createV11DeviceFixture(db(), { participantId: fixture.participantId });
    await sessionChunk(second, "2026-08-31", "fallback-new-device", "2026-08-31T14:00:00.000Z");
    expect((await context(fixture)).pin.fingerprint).not.toBe(initial.pin.fingerprint);
  });

  it("ignores identical/storage-only writes but rejects selected analytical corrections", async () => {
    const value = await staged("verifying");
    const initial = await context(value.fixture);
    const chunk = await db().prepare("SELECT id FROM telemetry_v1_chunks WHERE participant_id=? ORDER BY id LIMIT 1")
      .bind(value.fixture.participantId).first<{ id: string }>();
    await db().prepare(`UPDATE telemetry_v1_chunks SET chunk_digest=chunk_digest,
      r2_key=r2_key||'-rotated',envelope_digest=?,quarantine_deleted_at='2026-09-07T00:00:00.000Z' WHERE id=?`)
      .bind("b".repeat(64), chunk!.id).run();
    expect((await context(value.fixture)).dependency).toEqual(initial.dependency);
    expect((await context(value.fixture)).pin.inputRevision).toBe(initial.pin.inputRevision);
    await db().prepare("UPDATE telemetry_v1_chunks SET chunk_digest=? WHERE id=?").bind("c".repeat(64), chunk!.id).run();
    const corrected = await rebind(value.fixture);
    expect(corrected.dependency.revision).toBe(initial.dependency.revision + 1);
    expect(corrected.status).toBe("stale");
    expect((await rawWork())[0]![0]).toMatchObject({ run_id: value.head.runId, input_fingerprint: value.head.identity.inputFingerprint });
  });

  it.each(["revision", "dependency", "lease"] as const)("refuses a %s race without changing saved head, stage or evidence", async kind => {
    const value = await staged("verifying");
    await append(value.fixture);
    const before = await rawWork(), beforeParts = await parts();
    const racing = beforeBatch(async () => {
      if (kind === "revision") await append(value.fixture, "2026-09-08", "racing-outside");
      else if (kind === "dependency") await db().prepare("UPDATE community_model_history_dependencies SET dependency_revision=dependency_revision+1").run();
      else await db().prepare("UPDATE retention_state SET maintenance_lease_expires_at='2000-01-01T00:00:00.000Z' WHERE singleton=1").run();
    });
    expect((await rebind(value.fixture, racing)).status).toBe("stale");
    expect(await rawWork()).toEqual(before);
    expect(await parts()).toEqual(beforeParts);
  });

  it("rolls back the whole rebind if an exact dependency fence changes inside its transaction", async () => {
    const value = await staged("verifying"); await append(value.fixture);
    const before = await rawWork();
    const current = await context(value.fixture);
    await db().prepare(`CREATE TRIGGER synthetic_rebase_dependency_race AFTER UPDATE OF input_revision ON community_model_history_work
      BEGIN UPDATE community_model_history_dependencies SET dependency_revision=dependency_revision+1
        WHERE participant_id=NEW.participant_id; END`).run();
    expect(await rebindCommunityHistoryWork(db(), current.identity, current.pin, current.previousWorkFingerprint,
      current.dependency, LEASE, budget())).toBe("stale");
    expect(await rawWork()).toEqual(before);
    expect((await context(value.fixture)).dependency).toEqual(current.dependency);
  });

  it("refuses successor activation between pinning and atomic rebind", async () => {
    // Empty source permits a real successor closure without manufacturing a
    // fake compatibility proof for this suite's intentionally minimal rows.
    const fixture = await createV11DeviceFixture(db(), { participantId: "history-cutover" });
    const initial = await context(fixture);
    const encoded = encodeV1QuotaWorkCheckpoint(createV1QuotaAcquisitionCheckpoint(communityAnalysisAcquisitionIdentity(initial.identity)));
    expect((await store.beginCommunityAnalysisWork(db(), initial.identity, encoded.control, budget())).status).toBe("ready");
    await db().prepare("UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=?")
      .bind(fixture.participantId).run();
    const before = await rawWork(), beforeParts = await parts();
    expect((await rebind(fixture, beforeBatch(() => successor(fixture)))).status).toBe("stale");
    expect(await rawWork()).toEqual(before);
    expect(await parts()).toEqual(beforeParts);
    expect((await db().prepare("SELECT * FROM community_model_history_dependencies").all()).results).toEqual([]);
  });

  it("preserves legacy cache dependencies for no-op/storage metadata but fences genuine pricing/status changes", async () => {
    const fixture = await seedModelHistoryFixture({ binCount: 10 });
    const id = await legacy(fixture);
    const initial = await context(fixture);
    await db().prepare(`UPDATE telemetry_contributions SET plaintext_digest=plaintext_digest,
      r2_key=r2_key||'-rotated',envelope_digest=?,quarantine_deleted_at='2026-09-07T00:00:00.000Z' WHERE id=?`)
      .bind("c".repeat(64), id).run();
    const unchanged = await context(fixture);
    expect(unchanged.dependency).toEqual(initial.dependency);
    expect(unchanged.pin.inputRevision).toBe(initial.pin.inputRevision);
    expect(await readCommunityModelHistoryProgress(db(), NOW)).toMatchObject({ activeDay: DAY,
      completeAccounts: null, requiredAccounts: null });
    await db().prepare("UPDATE telemetry_contributions SET server_cost_nanousd=server_cost_nanousd+1 WHERE id=?").bind(id).run();
    const priced = await context(fixture);
    expect(priced.dependency.revision).toBe(initial.dependency.revision + 1);
    expect(priced.pin.inputRevision).toBe(initial.pin.inputRevision! + 1);
    await db().prepare("UPDATE telemetry_contributions SET status='deleting' WHERE id=?").bind(id).run();
    expect((await context(fixture)).dependency.revision).toBe(initial.dependency.revision + 2);
  });

  it("keeps the legacy no-op allowlist closed across every persisted contribution column", async () => {
    const columns = (await db().prepare("PRAGMA table_info(telemetry_contributions)").all<{ name: string }>()).results;
    const excluded = new Set(["r2_key", "envelope_digest", "quarantine_deleted_at"]);
    for (const name of ["community_analytical_input_legacy_update", "community_model_history_legacy_update",
      "community_model_history_dependency_legacy_update"]) {
      const trigger = await db().prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
        .bind(name).first<{ sql: string }>();
      expect(trigger).not.toBeNull();
      for (const column of columns) {
        const predicate = `OLD.${column.name} IS NOT NEW.${column.name}`;
        if (excluded.has(column.name)) expect(trigger!.sql).not.toContain(predicate);
        else expect(trigger!.sql).toContain(predicate);
      }
    }
  });

  it("preserves a completed result across later uploads without quota acquisition or result rewrites", async () => {
    const fixture = await seedModelHistoryFixture();
    for (let pass = 0; pass < 5 && !(await resultRow(fixture.participantId)); pass++) await warm();
    const before = await resultRow(fixture.participantId);
    expect(before).not.toBeNull();
    const json = JSON.parse(before!.result_json);
    expect(json.status).toBe("ready");
    await append(fixture);
    await db().prepare("DELETE FROM community_model_composition_days WHERE day=?").bind(DAY).run();
    const result = await warm(40); // too small to enter any acquisition attempt
    expect(result).toMatchObject({ day: DAY, requiredAccounts: 1, resolvedAccounts: 1, publishedDays: 1 });
    expect(await resultRow(fixture.participantId)).toEqual(before);
    expect((await readCommunityModelHistoryProgress(db(), NOW))?.resolvedDays).toBe(1);
  });

  it("bridges a pre-upgrade terminal result only with an exact recomputed legacy digest", async () => {
    const fixture = await seedModelHistoryFixture();
    for (let pass = 0; pass < 5 && !(await resultRow(fixture.participantId)); pass++) await warm();
    const before = await resultRow(fixture.participantId);
    if (!before) throw new Error("synthetic result missing");
    const { sourcePin } = await modelHistorySourceInput(fixture.participantId);
    const old = await loadV1SourcePin(db(), sourcePin.scope, { legacyInputRevisions: [before.input_revision] });
    const fingerprint = old.legacyFingerprints![String(before.input_revision)]!;
    const result = { ...JSON.parse(before.result_json), inputFingerprint: fingerprint };
    await db().prepare("UPDATE community_model_history_results SET input_fingerprint=?,dependency_revision=NULL,result_json=?")
      .bind(fingerprint, JSON.stringify(result)).run();
    await append(fixture);
    await db().prepare("DELETE FROM community_model_composition_days WHERE day=?").bind(DAY).run();
    const progress = await warm(900, forbidAcquisition());
    expect(progress).toMatchObject({ day: DAY, resolvedAccounts: 1, publishedDays: 1 });
    const after = await resultRow(fixture.participantId);
    expect(after!.input_fingerprint).toBe(sourcePin.fingerprint);
    expect(JSON.parse(after!.result_json)).toEqual(JSON.parse(before.result_json));
    expect(after!.dependency_revision).not.toBeNull();
  });

  it("rebinds a completed checkpoint without reacquisition and rejects its result after an in-window correction", async () => {
    const fixture = await seedModelHistoryFixture();
    for (let pass = 0; pass < 5 && !(await resultRow(fixture.participantId)); pass++) await warm();
    const before = await resultRow(fixture.participantId), beforeHead = (await rawWork())[0]![0];
    expect(before).not.toBeNull();
    await append(fixture);
    await db().prepare("DELETE FROM community_model_history_results WHERE participant_id=?").bind(fixture.participantId).run();
    await db().prepare("DELETE FROM community_model_composition_days WHERE day=?").bind(DAY).run();
    const rebound = await warm();
    expect(rebound).toMatchObject({ day: DAY, resolvedAccounts: 1, publishedDays: 1 });
    const afterHead = (await rawWork())[0]![0];
    expect(afterHead).toMatchObject({ run_id: beforeHead!.run_id, progress_revision: beforeHead!.progress_revision, phase: "complete" });
    expect(JSON.parse((await resultRow(fixture.participantId))!.result_json)).toEqual(JSON.parse(before!.result_json));
    await db().prepare("UPDATE telemetry_v1_chunks SET chunk_digest=? WHERE participant_id=? AND chunk_day=?")
      .bind("f".repeat(64), fixture.participantId, "2026-09-01").run();
    expect(await warm(40)).toMatchObject({ day: DAY, requiredAccounts: 1, resolvedAccounts: 0, publishedDays: 0 });
    expect(await readCommunityModelHistoryProgress(db(), NOW)).toMatchObject({ completeAccounts: 0, requiredAccounts: 1 });
  });

  it("exposes only dependency-current compact progress and clears retained work on withdrawal/erasure", async () => {
    const value = await staged("verifying");
    expect(await readCommunityModelHistoryProgress(db(), NOW)).toMatchObject({ resolvedDays: 0, activeDay: DAY,
      completeAccounts: 0, requiredAccounts: 1 });
    await db().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(value.fixture.participantId).run();
    expect(await rawWork()).toEqual([[], []]);
    expect((await db().prepare("SELECT * FROM community_model_history_dependencies").all()).results).toEqual([]);
    expect(await rebindCommunityHistoryWork(db(), value.initial.identity, value.initial.pin, value.head.identity.inputFingerprint,
      value.initial.dependency, LEASE, budget())).toBe("absent");
    await db().prepare("DELETE FROM participants WHERE id=?").bind(value.fixture.participantId).run();
    expect(await parts()).toEqual([]);
  });
});
