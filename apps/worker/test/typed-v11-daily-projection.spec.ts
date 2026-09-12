import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from "@app-usagemonitor/telemetry-contract";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import { initializeStorageSource, readIngestionChanges } from "../src/analytics-delivery";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { advanceV11DailyProjection, readV11ProjectedOwnerDays, retireV11DailyProjectionPage } from "../src/v11-daily-projection";
import { revokeAccountlessEnrollment } from "../src/accountless-enrollment";
import { eraseParticipantAsOwner } from "../src/participant-erasure";
import { readTypedV11ManifestPage, TYPED_V11_MANIFEST_PAGE_SQL } from "../src/typed-v11-record-reader";
import { makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeStorageAnalyticsRuntime, runStorageAnalyticsPass } from "../src/storage-analytics-runtime";
import { runStorageAnalyticsSchedule } from "../src/storage-analytics-worker";

interface Bindings extends Env { STORAGE_ANALYTICS_DB: D1Database; TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[] }
const b = env as Bindings, source = () => b.USAGE_MONITOR_DB, target = () => b.STORAGE_ANALYTICS_DB;
const sourceId = "synthetic-typed-source", namespace = "synthetic-original-typed-source";
const sourceLayout = { kind: "typed-v11" as const, sourceNamespace: namespace };
const today = () => new Date().toISOString().slice(0, 10);
const runtime = () => ({ ...b, ENVIRONMENT: "synthetic-development", ACCOUNT_SCOPED_INGEST_MODE: "disabled",
  ACCOUNTLESS_ENROLLMENT_MODE: "enabled", ACCOUNTLESS_OWNERSHIP_MODE: "enabled" } as Env);
const step = (db = target()) => advanceV11DailyProjection({ source: source(), target: db, sourceId, sourceLayout });
const read = (ownerDigest: string) => readV11ProjectedOwnerDays({ source: source(), target: target(), sourceId,
  ownerDigest, fromDay: today(), throughDay: today() });
async function drain() {
  for (let n = 0; n < 20; n++) {
    const result = await step(), retired = await retireV11DailyProjectionPage(target(), sourceId);
    if (result.state === "idle" && retired.state === "idle") return;
  }
  throw new Error("synthetic drain limit");
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(source(), b.TEST_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS);
  await applyD1Migrations(b.DELETION_LEDGER, b.TEST_DELETION_LEDGER_MIGRATIONS);
  await initializeStorageSource(source(), sourceId);
  await initializeTypedV11Admission(source(), namespace);
  await source().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
});

async function fixture(count = 1) {
  const deviceId = crypto.randomUUID(), secret = crypto.getRandomValues(new Uint8Array(32));
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const bytes = new Uint8Array(prefix.length + secret.length); bytes.set(prefix); bytes.set(secret, prefix.length);
  const deviceSecretHash = await sha256Hex(bytes), authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  bytes.fill(0); secret.fill(0);
  const request = (path: string, body: object, auth = "") => handleRequest(new Request(`https://typed.example.test${path}`, {
    method: "POST", headers: { origin: "https://typed.example.test", "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  }), runtime());
  expect((await request("/api/v1/accountless/enrollment", { schemaVersion: "accountless-enrollment-v0.1", deviceId, deviceSecretHash,
    policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1" })).status).toBe(201);
  expect((await request("/api/v1/accountless/ownership", { schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
    authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1" }, authorization)).status).toBe(201);
  const participantId = (await source().prepare("SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?")
    .bind(deviceId).first<string>("participant_id"))!;
  const principal = { participantId, deviceId };
  const prepared = await makeV11Day(today(), { usage: Array.from({ length: count }, (_, n) =>
    v11UsageRecord(today(), "a", { eventId: `event:v2:${n.toString(16).padStart(64, "0")}` })) });
  const day = await registerTelemetryV11DayManifest(source(), principal, prepared.manifest);
  for (const chunk of prepared.chunks) {
    const envelopeDigest = await sha256Hex(`synthetic:${crypto.randomUUID()}`);
    const device = await authenticateDevice(source(), authorization);
    const upload = await createDeviceUploadAuthorization(source(), device, envelopeDigest, 200);
    const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
    await persistTypedV11StagedChunk(source(), principal, chunk, { sourceNamespace: namespace,
      chunkRowId: `chunk:${crypto.randomUUID()}`, r2Key: `synthetic/${crypto.randomUUID()}`, envelopeDigest,
      deviceUploadAuthorizationId: claimed.authorizationId });
  }
  const prior = await createTelemetryV11DomainPredecessor(source(), principal);
  const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: day.day, throughDay: day.day,
    predecessor: { token: prior.token, previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint },
    days: [{ day: day.day, manifestId: day.manifestId, manifestDigest: day.manifestDigest }], manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(source(), principal, manifest);
  const event = (await readIngestionChanges(source(), sourceId, 0)).at(-1)!;
  return { participantId, deviceId, event, manifest };
}

describe("typed accountless upload to isolated projection", () => {
  it("refuses trigger separation on a target containing old analytical payloads",async()=>{
    await source().prepare("INSERT INTO community_model_composition_days(day,payload_json,computed_at) VALUES('2026-09-01','{}','2026-09-01T00:00:00.000Z')").run();
    await expect(applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(m=>/^(0001|0002)_/.test(m.name)))).rejects.toThrow();
    expect(await source().prepare("SELECT count(*) n FROM community_model_composition_days").first("n")).toBe(1);
    const trigger=await source().prepare("SELECT sql FROM sqlite_schema WHERE name='telemetry_v11_head_insert_publish'").first<string>("sql");
    expect(trigger).toContain("INSERT INTO community_daily_aggregate_rebuilds");
  });
  it("removes synchronous analytical work while retaining admission, head CAS and opt-out",async()=>{
    await applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(m=>/^(0001|0002)_/.test(m.name)));
    const value=await fixture(203);
    expect(await source().prepare("SELECT revision FROM community_analytical_input_versions WHERE participant_id=?")
      .bind(value.participantId).first<number>("revision")).toBeGreaterThan(0);
    expect(await source().prepare("SELECT COUNT(*) n FROM community_current_analysis_queue").first("n")).toBe(0);
    expect(await source().prepare("SELECT COUNT(*) n FROM community_daily_aggregate_rebuilds").first("n")).toBe(0);
    expect(await source().prepare("SELECT COUNT(*) n FROM storage_ingestion_changes").first("n")).toBe(1);
    await source().prepare("UPDATE community_snapshot_policy SET maturity_days=maturity_days+1 WHERE singleton_id=1").run();
    expect(await source().prepare("SELECT policy_revision FROM ingestion_analytics_separation").first("policy_revision")).toBe(2);
    expect(await source().prepare("SELECT COUNT(*) n FROM storage_ingestion_changes").first("n")).toBe(1);
    await expect(source().prepare("INSERT INTO community_model_composition_days(day,payload_json,computed_at) VALUES('2026-09-01','{}','2026-09-01T00:00:00.000Z')")
      .run()).rejects.toThrow("analytics_write_requires_separate_database");
    await drain();expect((await read(value.event.ownerDigest)).values[0]!.counts.usage).toBe(203);
    await revokeAccountlessEnrollment(source(),value.deviceId,"user_opt_out",Date.now());
    expect((await read(value.event.ownerDigest)).state).toBe("authority-unavailable");
    await drain();expect((await read(value.event.ownerDigest)).values).toEqual([]);
    expect(await source().prepare("SELECT COUNT(*) n FROM community_daily_aggregate_rebuilds").first("n")).toBe(0);
  });
  it("runs the independently metered scheduler and preserves a committed cursor across failure",async()=>{
    await applyD1Migrations(source(),b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(source(),namespace);
    const value=await fixture(203);
    const options={source:source(),target:target(),sourceId,sourceNamespace:namespace};
    await initializeStorageAnalyticsRuntime(options);
    await expect(initializeStorageAnalyticsRuntime({...options,sourceNamespace:"wrong-original"})).rejects.toThrow();
    expect(await runStorageAnalyticsPass({...options,maxQueries:20})).toMatchObject({state:"deferred",reason:"query_budget",steps:0,recordsRead:0});
    expect(await runStorageAnalyticsPass({...options,deadlineMs:0})).toMatchObject({state:"deferred",reason:"deadline",queriesUsed:0});
    const first=await runStorageAnalyticsPass({...options,maxSteps:1});
    expect(first).toMatchObject({state:"progress",recordsRead:200,steps:1});expect(first.queriesUsed).toBeLessThan(100);
    const unavailable={prepare(){throw new Error("synthetic analytics offline");}} as unknown as D1Database;
    await expect(runStorageAnalyticsSchedule({STORAGE_ANALYTICS_MODE:"enabled",STORAGE_SOURCE_ID:sourceId,
      TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:unavailable,DELETION_LEDGER:b.DELETION_LEDGER}))
      .rejects.toThrow("STORAGE_ANALYTICS_UNAVAILABLE");
    expect(await source().prepare("SELECT COUNT(*) n FROM typed_v11_record_admissions").first("n")).toBe(203);
    expect(await runStorageAnalyticsPass(options)).toMatchObject({state:"idle",recordsRead:3});
    expect((await read(value.event.ownerDigest)).values[0]!.counts.usage).toBe(203);
    await revokeAccountlessEnrollment(source(),value.deviceId,"user_opt_out",Date.now());
    expect((await read(value.event.ownerDigest)).state).toBe("authority-unavailable");
    expect(await runStorageAnalyticsPass(options)).toMatchObject({state:"idle"});
    expect((await read(value.event.ownerDigest)).values).toEqual([]);
    await expect(runStorageAnalyticsSchedule({STORAGE_ANALYTICS_MODE:"disabled"})).resolves.toBeUndefined();
  });
  it("accepts typed-only records without analytics, resumes bounded pages, and withdraws before the consumer catches up", async () => {
    const value = await fixture(203);
    expect(await source().prepare("SELECT COUNT(*) n FROM telemetry_v11_records").first("n")).toBe(0);
    expect(await source().prepare("SELECT COUNT(*) n FROM typed_v11_record_admissions").first("n")).toBe(203);
    const unavailable = { prepare() { throw new Error("synthetic analytics offline"); } } as unknown as D1Database;
    await expect(step(unavailable)).rejects.toThrow("synthetic analytics offline");
    expect(await step()).toMatchObject({ state: "building", sequence: 0, recordsRead: 200 });
    expect((await read(value.event.ownerDigest)).values).toEqual([]);
    expect(await step()).toMatchObject({ state: "building", recordsRead: 3 });
    await drain();
    expect((await read(value.event.ownerDigest)).values[0]!.counts.usage).toBe(203);
    expect(await revokeAccountlessEnrollment(source(), value.deviceId, "user_opt_out", Date.now())).toBe(true);
    expect(await read(value.event.ownerDigest)).toEqual({ state: "authority-unavailable", values: [] });
    await drain();
    expect(await read(value.event.ownerDigest)).toEqual({ state: "available", values: [] });
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_day_values").first("n")).toBe(0);
  });

  it("refuses to switch a partly processed generation to JSON or a different original namespace", async () => {
    await fixture(203); await step();
    await expect(advanceV11DailyProjection({ source: source(), target: target(), sourceId })).rejects.toThrow("V11_PROJECTION_SOURCE_LAYOUT_CONFLICT");
    await expect(advanceV11DailyProjection({ source: source(), target: target(), sourceId,
      sourceLayout: { kind: "typed-v11", sourceNamespace: "other:synthetic" } })).rejects.toThrow("V11_PROJECTION_SOURCE_LAYOUT_CONFLICT");
    expect(await target().prepare("SELECT sequence FROM analytics_source_cursors").first()).toBeNull();
    await drain();
  });

  it("checks the original owner, device and namespace of authority-selected typed records", async () => {
    const value = await fixture();
    const options = { sourceNamespace: namespace, participantId: value.participantId, deviceId: value.deviceId,
      manifestId: value.manifest.days[0]!.manifestId, afterStream: "", afterOccurrence: "", limit: 200 };
    expect(await readTypedV11ManifestPage(source(), options)).toHaveLength(1);
    for (const override of [{ participantId: "other:synthetic" }, { deviceId: "other:device" }, { sourceNamespace: "other:namespace" }]) {
      await expect(readTypedV11ManifestPage(source(), { ...options, ...override })).rejects.toThrow();
    }
    const plan = (await source().prepare(`EXPLAIN QUERY PLAN ${TYPED_V11_MANIFEST_PAGE_SQL}`)
      .bind(options.manifestId, "", "", 200).all<{ detail: string }>()).results.map(row => row.detail).join("\n");
    expect(plan).toMatch(/SEARCH p USING INDEX typed_v11_proof_manifest \(manifest_key=\? AND \(stream,occurrence_id\)>/);
    expect(plan).not.toMatch(/SCAN p\b|SCAN m\b|TEMP B-TREE/);
  });

  it("validates empty-day identity and rejects a bad initial namespace without pinning unusable work", async () => {
    const value = await fixture(0);
    await expect(advanceV11DailyProjection({ source: source(), target: target(), sourceId })).rejects.toThrow("V11_PROJECTION_SOURCE_LAYOUT_CONFLICT");
    await expect(advanceV11DailyProjection({ source: source(), target: target(), sourceId,
      sourceLayout: { kind: "typed-v11", sourceNamespace: "other:synthetic" } })).rejects.toThrow("V11_PROJECTION_SOURCE_LAYOUT_CONFLICT");
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_projection_work").first("n")).toBe(0);
    const options = { sourceNamespace: namespace, participantId: value.participantId, deviceId: value.deviceId,
      manifestId: value.manifest.days[0]!.manifestId, afterStream: "", afterOccurrence: "", limit: 200 };
    expect(await readTypedV11ManifestPage(source(), options)).toEqual([]);
    await expect(readTypedV11ManifestPage(source(), { ...options, participantId: "other:synthetic" })).rejects.toThrow();
    await drain();
    expect((await read(value.event.ownerDigest)).values[0]!.counts).toEqual({ usage: 0, quota: 0, session: 0 });
  });

  it("removes typed evidence through real owner erasure and drains terminal proof without resurrecting it", async () => {
    const value = await fixture(); await step();
    await expect(eraseParticipantAsOwner(runtime(), "e".repeat(64), value.participantId)).resolves.toMatchObject({ deleted: true });
    await drain();
    expect((await read(value.event.ownerDigest)).values).toEqual([]);
    for (const table of ["typed_v11_record_admissions", "typed_telemetry_records", "typed_telemetry_owners", "typed_telemetry_devices"]) {
      expect(await source().prepare(`SELECT COUNT(*) n FROM ${table}`).first("n")).toBe(0);
    }
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_day_values").first("n")).toBe(0);
  });
});
