import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json, telemetryV11DomainManifestDigestInput, telemetryV11RequiredConsent,
  type TelemetryV11DomainManifest,
  type TelemetryV11Record, type TelemetryV11Stream } from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest, telemetryV11LegacyProjection } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { grantTelemetryV11Consent } from "../src/telemetry-transport-policy";
import { insertTypedTelemetryV1Chunk, initializeTypedV1Admission } from "../src/typed-v1-admission";
import { parseTelemetryV1Chunk } from "../src/telemetry-v1";
import { sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";

const b = env as Env & { TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
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
  await applyD1Migrations(b.USAGE_MONITOR_DB, b.TEST_MIGRATIONS);
  await applyD1Migrations(b.USAGE_MONITOR_DB, b.TEST_TYPED_INGESTION_MIGRATIONS);
  await initializeStorageSource(db(), namespace);
  await applyD1Migrations(b.USAGE_MONITOR_DB, b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(b.USAGE_MONITOR_DB, b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(b.USAGE_MONITOR_DB, b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await initializeTypedV11Admission(db(), namespace);
  await initializeTypedV1Admission(db(), namespace);
  await applyD1Migrations(b.USAGE_MONITOR_DB, b.TEST_INGESTION_ISOLATION_MIGRATIONS);
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
  await insertTypedTelemetryV1Chunk(db(), { chunkRowId: `chunk:${crypto.randomUUID()}`, participantId: fixture.participantId,
    deviceId: fixture.deviceId, chunk, envelopeDigest, r2Key: `synthetic/legacy-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes: null }, namespace);
}
async function enable(fixture: Fixture) {
  await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  await grantTelemetryV11Consent(db(), fixture, telemetryV11RequiredConsent());
}


function usage(known: boolean) {
  const row = v11UsageRecord(today());
  return { ...row, totalInputContextTokens: known ? 1000 : null,
    components: { ...row.components, outputCombinedTokens: known ? 75 : null } };
}
describe("typed v1/v1.1 exact-total repair admission", () => {
  it("activates a null-to-known repair and retains known sources through a late-null client with new usage", async () => {
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const first = await activate(fixture, await makeV11Day(today(), { usage: [usage(false)] }));
    const repaired = await activate(fixture, await makeV11Day(today(), { usage: [usage(true)] }));
    expect(repaired.generationId).not.toBe(first.generationId);
    const late = await activate(fixture, await makeV11Day(today(), { usage: [usage(false), v11UsageRecord(today(), "b")] }));
    expect(late.generationId).not.toBe(repaired.generationId);
    expect(await db().prepare("SELECT count(*) n FROM typed_telemetry_usage WHERE total_input_context_tokens=1000 AND output_combined_tokens=75").first("n")).toBe(1);
    expect(await db().prepare("SELECT count(*) n FROM typed_telemetry_records WHERE stream=1").first("n")).toBe(4);
  });
  it("accepts a typed-v1 null-total predecessor without deleting its original typed occurrence", async () => {
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const fixture = await createV11DeviceFixture(db());
    await legacy(fixture, "usage", usage(false));
    await enable(fixture);
    const result = await activate(fixture, await makeV11Day(today(), { usage: [usage(true)] }));
    expect(result.replay).toBe(false);
    expect(await db().prepare("SELECT count(*) n FROM typed_v1_current_records").first("n")).toBe(1);
  });
  it("keeps the exact predecessor contract while the correction runtime is staged", async () => {

    const fixture = await createV11DeviceFixture(db(), { grant: true });
    await activate(fixture, await makeV11Day(today(), { usage: [usage(false)] }));
    await expect(activate(fixture, await makeV11Day(today(), { usage: [usage(true)] }))).rejects.toMatchObject(compatibility);
  });
  it.each(["context", "combined", "input", "output", "model", "outcome", "clock", "session"])("rejects an unrelated or contradictory %s change atomically", async kind => {
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const old = usage(true);
    const first = await activate(fixture, await makeV11Day(today(), { usage: [old] }));
    const changed = structuredClone(old);
    if (kind === "context") changed.totalInputContextTokens = 1001;
    if (kind === "combined") changed.components.outputCombinedTokens = 76;
    if (kind === "input") changed.components.inputUncachedTokens = old.components.inputUncachedTokens! + 1;
    if (kind === "output") changed.components.outputTextTokens = old.components.outputTextTokens! + 1;
    if (kind === "model") changed.modelId = "gpt-5.6-luna";
    if (kind === "outcome") changed.outcome = "failed";
    if (kind === "clock") changed.eventTime = `${today()}T12:06:00.000Z`;
    if (kind === "session") changed.sessionUuid = "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0c";
    await expect(activate(fixture, await makeV11Day(today(), { usage: [changed] }))).rejects.toMatchObject(compatibility);
    expect(await db().prepare("SELECT generation_id FROM telemetry_v11_domain_heads").first("generation_id")).toBe(first.generationId);
  });
});
