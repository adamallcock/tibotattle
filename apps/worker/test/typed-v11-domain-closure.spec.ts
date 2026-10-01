import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json, telemetryV11DomainManifestDigestInput, telemetryV11RequiredConsent,
  type TelemetryV11DomainManifest, type TelemetryV11QuotaObservation, type TelemetryV11SessionDimension,
  type TelemetryV11Record, type TelemetryV11Stream } from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest, telemetryV11LegacyProjection } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { grantTelemetryV11Consent } from "../src/telemetry-transport-policy";
import { insertTelemetryV1Chunk } from "../src/telemetry-v1-repository";
import { parseTelemetryV1Chunk } from "../src/telemetry-v1";
import { readLegacyTelemetryCopyPage } from "../src/typed-telemetry-copy";
import { prepareTypedV1PreservationProofs } from "../src/typed-v1-preservation-proof";
import { sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";

const b = env as Env & { TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[] };
const db = () => b.USAGE_MONITOR_DB;
const namespace = "synthetic-original-ingestion";
const today = () => new Date().toISOString().slice(0, 10);
type Fixture = Awaited<ReturnType<typeof createV11DeviceFixture>>;
type PreparedDay = Awaited<ReturnType<typeof makeV11Day>>;
type StagedDay = Awaited<ReturnType<typeof registerTelemetryV11DayManifest>>;
const compatibility = { code: "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE" };

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), b.TEST_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await initializeStorageSource(db(), namespace);
  await applyD1Migrations(db(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await initializeTypedV11Admission(db(), namespace);
});

async function stage(fixture: Fixture, prepared: PreparedDay): Promise<StagedDay> {
  await registerTelemetryV11DayManifest(db(), fixture, prepared.manifest);
  for (const chunk of prepared.chunks) {
    const envelopeDigest = await sha256Hex(`synthetic-envelope:${crypto.randomUUID()}`);
    const principal = await authenticateDevice(db(), fixture.authorization);
    const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
    const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
    await persistTypedV11StagedChunk(db(), fixture, chunk, { sourceNamespace: namespace,
      chunkRowId: `chunk:${crypto.randomUUID()}`, r2Key: `synthetic/${crypto.randomUUID()}`,
      envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId });
  }
  return registerTelemetryV11DayManifest(db(), fixture, prepared.manifest);
}
async function domain(fixture: Fixture, days: StagedDay[]): Promise<TelemetryV11DomainManifest> {
  const prior = await createTelemetryV11DomainPredecessor(db(), fixture);
  const ordered = [...days].sort((a, c) => a.day.localeCompare(c.day));
  const value: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1",
    fromDay: ordered[0]!.day, throughDay: ordered.at(-1)!.day,
    predecessor: { token: prior.token, previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint },
    days: ordered.map(day => ({ day: day.day, manifestId: day.manifestId, manifestDigest: day.manifestDigest })),
    manifestDigest: "0".repeat(64) };
  value.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(value));
  return value;
}
async function activate(fixture: Fixture, prepared: PreparedDay) {
  const day = await stage(fixture, prepared);
  return activateTelemetryV11Domain(db(), fixture, await domain(fixture, [day]));
}
function quota(usedPercent: number | null = 12.345678901234567): TelemetryV11QuotaObservation {
  return { schemaVersion: "quota-observation-v1.1", observationId: `quota-occurrence:v1:${"b".repeat(64)}`,
    observedTime: `${today()}T12:05:00.000Z`, provider: "openai_codex", planType: "pro", planVariant: "unknown",
    limitId: "codex", slot: "seven_day", usedPercent, windowDurationMinutes: 10080,
    resetsAt: `${today()}T23:00:00.000Z`, accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null } };
}
function session(tools: Record<string, number> = { shell: 2, browser: 1 }): TelemetryV11SessionDimension {
  return { schemaVersion: "session-dimension-v1.1", sessionUuid: "session:synthetic-closure",
    firstEventTime: `${today()}T12:05:00.000Z`, provider: "openai_codex", toolClassCounts: tools };
}
async function legacy(fixture: Fixture, stream: TelemetryV11Stream, record: TelemetryV11Record) {
  const projected = telemetryV11LegacyProjection(stream, record);
  if (!projected) throw new Error("synthetic legacy counterpart required");
  const records = [JSON.parse(projected.canonicalRecord)];
  const envelopeDigest = await sha256Hex(`synthetic-legacy:${crypto.randomUUID()}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
  const chunk = parseTelemetryV1Chunk({ schemaVersion: "telemetry-contribution-v1.0", chunkId: `${stream}:${today()}:0`,
    chunkRevision: 1, chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)), parserVersion: "synthetic-v1",
    consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0", fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" }, records });
  await insertTelemetryV1Chunk(db(), { chunkRowId: `chunk:${crypto.randomUUID()}`, participantId: fixture.participantId,
    deviceId: fixture.deviceId, chunk, envelopeDigest, r2Key: `synthetic/legacy-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes: null });
}
async function enable(fixture: Fixture) {
  await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  await grantTelemetryV11Consent(db(), fixture, telemetryV11RequiredConsent());
}

describe("typed v1.1 exact domain closure", () => {
  it("uses typed-only records through the real multi-stream domain activation and preserves active deletion fences", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const result = await activate(fixture, await makeV11Day(today(), { usage: [v11UsageRecord(today())], quota: [quota()], session: [session()] }));
    expect(result.replay).toBe(false);
    expect(await db().prepare("SELECT COUNT(*) FROM telemetry_v11_records").first("COUNT(*)")).toBe(0);
    expect(await db().prepare("SELECT COUNT(*) FROM typed_v11_record_admissions").first("COUNT(*)")).toBe(3);
    await expect(db().prepare("DELETE FROM typed_v11_record_admissions").run()).rejects.toThrow();
    expect(await db().prepare("SELECT generation_id FROM telemetry_v11_domain_heads").first("generation_id")).toBe(result.generationId);
  });

  it("permits attribution-only refinement while preserving exact float, NULL and session maps", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const usage = v11UsageRecord(today()); const q = quota();
    const unknown = { ...quota(null), observationId: "quota:unknown-components", windowDurationMinutes: null, resetsAt: null };
    const initial = await activate(fixture, await makeV11Day(today(), { usage: [usage], quota: [q, unknown], session: [session()] }));
    const attribution = { accountBasis: "same_source" as const, accountTrackId: `account-track:v2:${"c".repeat(64)}`,
      planBasis: "same_source_occurrence" as const, planType: "pro" as const, planEraId: null };
    const successor = await activate(fixture, await makeV11Day(today(), {
      usage: [{ ...usage, accountPlanAttribution: { ...attribution } }], quota: [{ ...q, accountPlanAttribution: { ...attribution } }, { ...unknown, accountPlanAttribution: { ...attribution } }],
      session: [session({ browser: 1, shell: 2 })],
    }));
    expect(successor.generationId).not.toBe(initial.generationId);
    expect(await db().prepare("SELECT COUNT(*) FROM typed_v11_record_admissions").first("COUNT(*)")).toBe(8);
  });

  it.each(["float", "null", "tools", "removed-tool", "added-tool", "missing"])("rejects changed %s base evidence and retains the prior head", async kind => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const q = quota(kind === "null" ? null : undefined);
    const original = await activate(fixture, await makeV11Day(today(), { usage: [v11UsageRecord(today())], quota: [q], session: [session()] }));
    const candidate = await stage(fixture, await makeV11Day(today(), {
      usage: kind === "missing" ? [] : [v11UsageRecord(today())],
      quota: [{ ...q, usedPercent: kind === "float" ? 12.34567890123457 : kind === "null" ? 0 : q.usedPercent }],
      session: [session(kind === "tools" ? { shell: 3, browser: 1 } : kind === "removed-tool" ? { shell: 2 } : kind === "added-tool" ? { shell: 2, browser: 1, other: 0 } : undefined)],
    }));
    await expect(activateTelemetryV11Domain(db(), fixture, await domain(fixture, [candidate]))).rejects.toMatchObject(compatibility);
    expect(await db().prepare("SELECT generation_id FROM telemetry_v11_domain_heads").first("generation_id")).toBe(original.generationId);
    expect(await db().prepare("SELECT state FROM telemetry_v11_day_manifests WHERE id=?").bind(candidate.manifestId).first("state")).toBe("ready");
  });

  it("refuses incomplete manifests, foreign authority and a stale predecessor without losing staged data", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const prepared = await makeV11Day(today(), { usage: [v11UsageRecord(today())], quota: [quota()] });
    const partial = await stage(fixture, { ...prepared, chunks: prepared.chunks.slice(0, 1) });
    await expect(activateTelemetryV11Domain(db(), fixture, await domain(fixture, [partial])))
      .rejects.toMatchObject({ code: "TELEMETRY_MANIFEST_INCOMPLETE" });
    const ready = await stage(fixture, { ...prepared, chunks: prepared.chunks.slice(1) });
    const manifest = await domain(fixture, [ready]);
    const other = await createV11DeviceFixture(db(), { grant: true });
    await expect(activateTelemetryV11Domain(db(), other, manifest)).rejects.toMatchObject({ code: "TELEMETRY_MANIFEST_CONFLICT" });
    await db().prepare("UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=?").bind(fixture.participantId).run();
    await expect(activateTelemetryV11Domain(db(), fixture, manifest)).rejects.toMatchObject({ code: "TELEMETRY_MANIFEST_CONFLICT" });
    expect(await db().prepare("SELECT COUNT(*) FROM typed_v11_record_admissions").first("COUNT(*)")).toBe(2);
  });

  it("rejects an occurrence duplicated across candidate days", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const earlier = new Date(Date.parse(today()) - 86_400_000).toISOString().slice(0, 10);
    const first = await stage(fixture, await makeV11Day(earlier, { usage: [v11UsageRecord(earlier)] }));
    const second = await stage(fixture, await makeV11Day(today(), { usage: [v11UsageRecord(today())] }));
    await expect(activateTelemetryV11Domain(db(), fixture, await domain(fixture, [first, second])))
      .rejects.toMatchObject({ code: "TELEMETRY_OCCURRENCE_CONFLICT" });
    expect(await db().prepare("SELECT COUNT(*) FROM telemetry_v11_domain_heads").first("COUNT(*)")).toBe(0);
  });

  it("requires exact transaction-bound legacy proofs for every winning stream", async () => {
    const fixture = await createV11DeviceFixture(db());
    const usage = v11UsageRecord(today()), q = quota(), s = session();
    await legacy(fixture, "usage", usage); await legacy(fixture, "quota", q); await legacy(fixture, "session", s);
    await enable(fixture);
    const candidate = await stage(fixture, await makeV11Day(today(), { usage: [usage], quota: [q], session: [s] }));
    await expect(activateTelemetryV11Domain(db(), fixture, await domain(fixture, [candidate]))).rejects.toMatchObject(compatibility);
    const rows = await readLegacyTelemetryCopyPage(db(), { sourceNamespace: namespace, format: "v1", afterSourceRowId: 0, limit: 32 });
    expect(rows).toHaveLength(3);
    const proof = await prepareTypedV1PreservationProofs(db(), rows);
    const proved = await db().batch(proof.statements);
    expect(proved.every(row => row.results.length === 1)).toBe(true);
    const changed = await stage(fixture, await makeV11Day(today(), { usage: [usage],
      quota: [{ ...q, usedPercent: 12.34567890123457 }], session: [s] }));
    await expect(activateTelemetryV11Domain(db(), fixture, await domain(fixture, [changed]))).rejects.toMatchObject(compatibility);
    const result = await activateTelemetryV11Domain(db(), fixture, await domain(fixture, [candidate]));
    expect(result.replay).toBe(false);
    expect(await db().prepare("SELECT COUNT(*) FROM telemetry_v1_records").first("COUNT(*)")).toBe(3);
  });
  it("refuses retained raw v1.1 history without deleting it or claiming an import", async () => {
    await reset();
    await applyD1Migrations(db(), b.TEST_MIGRATIONS);
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const staged = await stageV11Day(db(), fixture, await makeV11Day(today(), { usage: [v11UsageRecord(today())] }));
    await applyD1Migrations(db(), b.TEST_TYPED_INGESTION_MIGRATIONS);
    await initializeStorageSource(db(), namespace);
    await applyD1Migrations(db(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
    await applyD1Migrations(db(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
    await expect(initializeTypedV11Admission(db(), namespace)).rejects.toThrow();
    await expect(activateTelemetryV11Domain(db(), fixture, await domain(fixture, [staged]))).rejects.toMatchObject(compatibility);
    expect(await db().prepare("SELECT COUNT(*) FROM telemetry_v11_records").first("COUNT(*)")).toBe(1);
    expect(await db().prepare("SELECT state FROM telemetry_v11_day_manifests WHERE id=?").bind(staged.manifestId).first("state")).toBe("ready");
  });

  it("keeps preservation and chunk completeness probes indexed", async () => {
    for (const [sql, proofIndex] of [
      ["SELECT base_digest FROM typed_v11_record_admissions WHERE manifest_id=? AND stream=? AND occurrence_id=?", "typed_v11_proof_manifest"],
      ["SELECT legacy_digest FROM typed_v11_record_admissions WHERE manifest_id=? AND stream=? AND legacy_occurrence_id=?", "typed_v11_admissions_legacy"],
      ["SELECT count(*) FROM typed_v11_record_admissions WHERE chunk_id=?", "typed_v11_proof_chunk"],
    ] as const) {
      const rows = (await db().prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...Array(sql.split("?").length - 1).fill("synthetic"))
        .all<{ detail: string }>()).results;
      const plan = rows.map(row => row.detail).join("\n");
      // The compatibility view must push predicates into integer-key proof
      // indexes; decoding identifiers must never require scanning retained rows.
      expect(plan).toMatch(new RegExp(`SEARCH p USING (?:COVERING )?INDEX ${proofIndex}\\b`));
      expect(plan).not.toMatch(/\bSCAN (?:p|m|c|a|typed_v11_record_proofs|typed_v11_record_admissions)\b|TEMP B-TREE/);
    }
  });

});
