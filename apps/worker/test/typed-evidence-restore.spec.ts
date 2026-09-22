import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { buildPerformanceHistogram, canonicalTelemetryV12Json, telemetryV12RequiredConsent, telemetryV12DayManifestDigestInput, type TelemetryV12UsageEvent, type TelemetryV12Chunk, type TelemetryV12DayManifest, canonicalTelemetryV11Json } from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture, v11UsageRecord } from "./helpers/telemetry-v11";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";
import { insertTypedTelemetryV1Chunk, initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { parseTelemetryV1Chunk, type TelemetryV1UsageEvent } from "../src/telemetry-v1";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-compatibility";
import { captureTelemetryUsageCorrectionBeforeDelete, readTelemetryUsageCorrectionEffectiveFacts,
  type TelemetryUsageCorrectionSource } from "../src/telemetry-usage-correction-repository";
import { authoritySchemaInventory, authoritySchemaDigest, authorityRestoreContractDigest,
  typedEvidenceRestoreFinalSchema, freezeAuthorityRestoreSource, beginAuthorityRestore, copyAuthorityPage,
  sealAuthorityRestore, completeAuthorityVerification, promoteAuthorityRestore, finalizeAuthorityRestore,
  type AuthorityRestoreContract } from "../src/authority-restore";
import { grantTelemetryV12Consent } from "../src/telemetry-transport-policy";
import { registerTelemetryV12DayManifest, persistTelemetryV12StagedChunk } from "../src/telemetry-v12-repository";
import { admitTelemetryPerformanceReport, readTelemetryPerformanceReports } from "../src/telemetry-performance-repository";
import { initializeStorageAnalyticsRuntime } from "../src/storage-analytics-runtime";
import { eraseParticipantAsOwner } from "../src/participant-erasure";
interface Bindings extends Env {
  STORAGE_ANALYTICS_DB: D1Database;
  TEST_ANALYTICS_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
  STORAGE_INGESTION_A: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
}
const bindings = env as Bindings;
const source = () => bindings.USAGE_MONITOR_DB;
const target = () => bindings.STORAGE_INGESTION_A;
const sourceId = "synthetic-typed-evidence";
const sourceNamespace = "synthetic-typed-evidence-original";
const day = "2026-09-20";
beforeEach(async () => { await reset(); });
async function prepare() {
  for (const migrations of [bindings.TEST_MIGRATIONS, bindings.TEST_TYPED_INGESTION_MIGRATIONS,
    bindings.TEST_INGESTION_BRIDGE_MIGRATIONS, bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS,
    bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS]) await applyD1Migrations(source(), migrations);
  await initializeStorageSource(source(), sourceId);
  await initializeTypedV11Admission(source(), sourceNamespace);
  await initializeTypedV1Admission(source(), sourceNamespace);
  await applyD1Migrations(source(), bindings.TEST_INGESTION_ISOLATION_MIGRATIONS);
  const fact = await seedV1Source();
  await source().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
  await captureTelemetryUsageCorrectionBeforeDelete(source(), fact);
  const successor = await seedSuccessorStreams();
  const sourceSchema = await authoritySchemaInventory(source());
  const finalSchema = typedEvidenceRestoreFinalSchema(sourceSchema);
  const authoritySequences = [];
  for (const object of sourceSchema.filter(object => object.type === "table" && /\bAUTOINCREMENT\b/i.test(object.sql))) {
    authoritySequences.push({ name: object.name,
      sequence: await source().prepare("SELECT seq FROM sqlite_sequence WHERE name=?").bind(object.name).first<number>("seq") ?? 0 });
  }
  const contract: AuthorityRestoreContract = { version: "typed-evidence-restore-v1", runId: "synthetic-typed-restore",
    sourceId, sourceNamespace, sourceSnapshotDigest: "a".repeat(64), sourceSchema,
    sourceSchemaDigest: await authoritySchemaDigest(sourceSchema), targetBaseSchema: [],
    targetBaseSchemaDigest: await authoritySchemaDigest([]), finalSchema,
    finalSchemaDigest: await authoritySchemaDigest(finalSchema),
    tables: sourceSchema.filter(object => object.type === "table").map(object => ({ name: object.name, disposition: "authority" })),
    typedCopies: [], authoritySequences, operatingLimitBytes: 64 * 1024 * 1024 };
  return { fact, successor, contract, pin: await authorityRestoreContractDigest(contract) };
}
async function seedV1Source(): Promise<TelemetryUsageCorrectionSource> {
  const fixture = await createV11DeviceFixture(source());
  const projected = telemetryV11LegacyProjection("usage", v11UsageRecord(day, "a", {
    eventId: `event:v2:${"e".repeat(64)}`,
    totalInputContextTokens: null,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: null,
      inputCacheWriteTokens: null,
      outputTextTokens: 50,
      outputReasoningTokens: null,
      outputCombinedTokens: null,
    },
  }));
  if (!projected) throw new Error("synthetic correction projection missing");
  const record = JSON.parse(projected.canonicalRecord) as TelemetryV1UsageEvent;
  const envelopeDigest = await sha256Hex("synthetic-correction-erasure-envelope");
  const principal = await authenticateDevice(source(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(source(), principal, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${upload.uploadAuthorization}`, {
    envelopeDigest, bodyBytes: 200, contentType: "application/json",
  });
  const chunkRowId = `chunk:${crypto.randomUUID()}`;
  const chunk = parseTelemetryV1Chunk({
    schemaVersion: "telemetry-contribution-v1.0",
    chunkId: `usage:${day}:0`,
    chunkRevision: 1,
    chunkDigest: await sha256Hex(canonicalTelemetryV11Json([record])),
    parserVersion: "synthetic-correction-erasure-v1",
    consent: {
      telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
    },
    records: [record],
  });
  await insertTypedTelemetryV1Chunk(source(), {
    chunkRowId,
    participantId: fixture.participantId,
    deviceId: fixture.deviceId,
    chunk,
    envelopeDigest,
    r2Key: `synthetic/correction-erasure/${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId,
    createdAt: new Date().toISOString(),
    supersedes: null,
  }, sourceNamespace);
  const row = await source().prepare(`
    SELECT storage_row_id,source_row_id,source_namespace,format,participant_id,device_id,
      chunk_row_id,manifest_id,occurrence_id
      FROM typed_telemetry_compatibility_records
     WHERE participant_id=? AND chunk_row_id=? LIMIT 2
  `).bind(fixture.participantId, chunkRowId).first<{
    storage_row_id: number;
    source_row_id: number;
    source_namespace: string;
    format: "v1" | "v11";
    participant_id: string;
    device_id: string;
    chunk_row_id: string;
    manifest_id: string | null;
    occurrence_id: string;
  }>();
  const owner = await source().prepare(`
    SELECT link.owner_digest,revision,authority_epoch
      FROM storage_v11_owner_links link
      JOIN storage_owner_revisions revision_row ON revision_row.owner_digest=link.owner_digest
     WHERE link.participant_id=? LIMIT 2
  `).bind(fixture.participantId).first<{
    owner_digest: string;
    revision: number;
    authority_epoch: number;
  }>();
  if (!row || !owner) throw new Error("synthetic correction source missing");
  return {
    participantId: fixture.participantId,
    ownerDigest: owner.owner_digest,
    ownerRevision: owner.revision,
    authorityEpoch: owner.authority_epoch,
    sourceNamespace: row.source_namespace,
    sourceStorageRowId: row.storage_row_id,
    sourceRowId: row.source_row_id,
    sourceFormat: row.format,
    sourceDeviceId: row.device_id,
    sourceChunkId: row.chunk_row_id,
    sourceManifestId: row.manifest_id,
    recordJson: projected.canonicalRecord,
  };
}

async function seedSuccessorStreams() {
  const fixture = await createV11DeviceFixture(source());
  await source().prepare("UPDATE telemetry_v12_runtime SET state='active' WHERE id=1").run();
  await grantTelemetryV12Consent(source(), fixture, telemetryV12RequiredConsent());
  const record = { ...v11UsageRecord(day, "b"), schemaVersion: "usage-event-v1.2",
    boundaryFlags: 1, tieOrder: 0, cacheWriteTtl: null } as TelemetryV12UsageEvent;
  const chunk: TelemetryV12Chunk = { schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
    chunkId: `usage:${day}:0`, chunkRevision: 1, parserVersion: "synthetic-restore-v17",
    consent: telemetryV12RequiredConsent(), records: [record], chunkDigest: await sha256Hex(canonicalTelemetryV12Json([record])) };
  const manifest: TelemetryV12DayManifest = { schemaVersion: "telemetry-day-manifest-v1.2", day,
    parserVersion: chunk.parserVersion, consent: chunk.consent, chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: 1 }],
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  chunk.manifestDigest = manifest.manifestDigest;
  await registerTelemetryV12DayManifest(source(), fixture, manifest);
  const principal = await authenticateDevice(source(), fixture.authorization);
  const envelopeDigest = await sha256Hex("synthetic-typed-restore-v12");
  const upload = await createDeviceUploadAuthorization(source(), principal, envelopeDigest, 22);
  const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${upload.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 22, contentType: "application/json" });
  await persistTelemetryV12StagedChunk(source(), fixture, chunk, { chunkRowId: `chunk:${crypto.randomUUID()}`,
    r2Key: "synthetic/typed-restore-v12", envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId });
  await source().prepare("UPDATE telemetry_performance_runtime SET state='active' WHERE id=1").run();
  await source().prepare(`INSERT INTO telemetry_performance_device_capabilities (
    participant_id, device_id, schema_version, field_dictionary_version, privacy_contract_version,
    scope, capability_revision, authority_epoch, issued_at, expires_at, state, consented_at
  ) VALUES (?, ?, 'model-performance-daily-v1', 'telemetry-performance-registry-2026-09-21.1',
    'privacy-safe-model-performance-v1', 'model-performance-daily', 1, 1,
    '2026-09-20T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'accepted', '2026-09-20T00:00:00.000Z')`)
    .bind(fixture.participantId, fixture.deviceId).run();
  const authorization = { schemaVersion: "telemetry-performance-authorization-v1" as const,
    capabilityRevision: 1, authorityEpoch: 1, issuedAt: "2026-09-20T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z", scope: "model-performance-daily" as const };
  const body = { schemaVersion: "telemetry-performance-report-v1", day, sourceGeneration: "source:v1:restore",
    sourceDigest: "c".repeat(64), sourceRevision: 1, methodVersion: "performance-daily-histogram-v1",
    parserVersion: "synthetic-restore-v17", fieldDictionaryVersion: "telemetry-performance-registry-2026-09-21.1",
    privacyContractVersion: "privacy-safe-model-performance-v1", bucketSchemeVersion: "performance-histogram-v1",
    measurementVersion: "model-performance-samples-v1", records: [{ schemaVersion: "model-performance-daily-v1",
      day, provider: "openai_codex", modelId: "gpt-5.6-luna", reasoningEffort: "high", speedMethod: "receipt",
      speedMode: "standard", speedModeSource: "rollout_thread_settings", apiServiceTier: "unknown",
      measurementVersion: "model-performance-samples-v1", bucketSchemeVersion: "performance-histogram-v1",
      turns: 1, speedTurns: 1, ttftTurns: 1, completionTurns: 1, timedResponses: 1,
      speedTokens: 100, speedDurationMs: 1000, speedHistogram: buildPerformanceHistogram("speed", [100]),
      ttftHistogram: buildPerformanceHistogram("ttft", [100]), completionHistogram: buildPerformanceHistogram("turnDuration", [1000]) }] };
  const report = { ...body, reportRevision: await sha256Hex(canonicalTelemetryV12Json(body)) };
  await admitTelemetryPerformanceReport(source(), fixture, report, authorization, "d".repeat(64));
  return { fixture, manifest, report, authorization };
}

async function drain(operation: () => Promise<{ state: string }>) {
  for (let step = 0; step < 1024; step += 1) if ((await operation()).state === "complete") return;
  throw new Error("Synthetic restore exceeded bounded pages");
}
it("typed snapshot preserves dictionary ids, active correction facts and source authority across restart", async () => {
  const { fact, successor, contract, pin } = await prepare();
  const options = { ownerDigest: fact.ownerDigest, ownerRevision: fact.ownerRevision,
    authorityEpoch: fact.authorityEpoch, day, limit: 200 };
  const before = await readTelemetryUsageCorrectionEffectiveFacts(source(), options);
  const performanceBefore = await readTelemetryPerformanceReports(source(), successor.fixture.participantId);
  expect(before.rows.length).toBe(1);
  await freezeAuthorityRestoreSource(source(), contract, pin);
  await beginAuthorityRestore(source(), target(), contract, pin);
  await copyAuthorityPage(source(), target(), contract, pin);
  await beginAuthorityRestore(source(), target(), contract, pin);
  await drain(() => copyAuthorityPage(source(), target(), contract, pin));
  await sealAuthorityRestore(source(), target(), contract, pin);
  await drain(() => copyAuthorityPage(source(), target(), contract, pin, "verify"));
  await completeAuthorityVerification(source(), target(), contract, pin);
  await promoteAuthorityRestore(source(), target(), contract, pin);
  await finalizeAuthorityRestore(source(), target(), contract, pin);
  await finalizeAuthorityRestore(source(), target(), contract, pin);
  expect(await readTelemetryUsageCorrectionEffectiveFacts(target(), options)).toEqual(before);
  expect(await readTelemetryPerformanceReports(target(), successor.fixture.participantId)).toEqual(performanceBefore);
  expect(await target().prepare("SELECT boundary_flags,tie_order FROM telemetry_v12_usage").first()).toEqual({ boundary_flags: 1, tie_order: 0 });
  expect(await registerTelemetryV12DayManifest(target(), successor.fixture, successor.manifest)).toMatchObject({ state: "ready" });
  expect(await admitTelemetryPerformanceReport(target(), successor.fixture, successor.report, successor.authorization, "d".repeat(64)))
    .toMatchObject({ status: "idempotent" });
  expect(await target().prepare("SELECT state FROM telemetry_usage_correction_runtime WHERE id=1").first("state")).toBe("active");
  expect(await target().prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });
  expect(await target().prepare("SELECT phase FROM _authority_restore_run WHERE id=1").first("phase")).toBe("ready");
  await applyD1Migrations(bindings.STORAGE_ANALYTICS_DB, bindings.TEST_ANALYTICS_MIGRATIONS);
  await applyD1Migrations(bindings.DELETION_LEDGER, bindings.TEST_DELETION_LEDGER_MIGRATIONS);
  await initializeStorageAnalyticsRuntime({ source: target(), target: bindings.STORAGE_ANALYTICS_DB, sourceId, sourceNamespace });
  const runtime = { ...bindings, USAGE_MONITOR_DB: target(), ENVIRONMENT: "synthetic-development" } as Env;
  Reflect.set(runtime, "TELEMETRY_STORAGE_MODE", "typed");
  Reflect.set(runtime, "TELEMETRY_STORAGE_NAMESPACE", sourceNamespace);
  Reflect.set(runtime, "ANALYTICS_DB", bindings.STORAGE_ANALYTICS_DB);
  await bindings.QUARANTINE.put("synthetic/typed-restore-v12", "synthetic ciphertext");
  for (const participantId of [fact.participantId, successor.fixture.participantId]) {
    expect(await eraseParticipantAsOwner(runtime, "synthetic-admin", participantId)).toMatchObject({ deleted: true });
  }
  expect(await target().prepare("SELECT count(*) n FROM telemetry_usage_correction_history").first("n")).toBe(0);
  expect(await target().prepare("SELECT count(*) n FROM telemetry_v12_records").first("n")).toBe(0);
  expect(await target().prepare("SELECT count(*) n FROM telemetry_performance_reports").first("n")).toBe(0);
  expect(await bindings.QUARANTINE.head("synthetic/typed-restore-v12")).toBeNull();
  await expect(registerTelemetryV12DayManifest(target(), successor.fixture, successor.manifest)).rejects.toThrow();
  await expect(admitTelemetryPerformanceReport(target(), successor.fixture, successor.report, successor.authorization, "d".repeat(64))).rejects.toThrow();
}, 120_000);

it("typed snapshot cannot omit a stream table, change namespace layout or use legacy conversion", async () => {
  const { contract } = await prepare();
  for (const invalid of [
    { ...contract, tables: contract.tables.filter(table => table.name !== "telemetry_usage_correction_history") },
    { ...contract, finalSchema: contract.finalSchema.filter(object => object.name !== "telemetry_usage_correction_history") },
    { ...contract, admissionContract: "typed-v1-v11-restore-v1" as const },
    { ...contract, version: "authority-restore-v1" as const },
  ]) {
    invalid.finalSchemaDigest = await authoritySchemaDigest(invalid.finalSchema);
    await expect(freezeAuthorityRestoreSource(source(), invalid, await authorityRestoreContractDigest(invalid))).rejects.toThrow();
  }
  expect(await source().prepare("SELECT 1 FROM sqlite_master WHERE name='_authority_snapshot'").first()).toBeNull();
});
