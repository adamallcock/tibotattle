import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from "@app-usagemonitor/telemetry-contract";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import { initializeStorageSource, readIngestionChanges } from "../src/analytics-delivery";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { advanceAdmittedV11DailyProjection, advanceV11DailyProjection, readV11ProjectedOwnerDays, retireV11DailyProjectionPage } from "../src/v11-daily-projection";
import { revokeAccountlessEnrollment } from "../src/accountless-enrollment";
import { eraseParticipantAsOwner } from "../src/participant-erasure";
import { readTypedV11ManifestPage, TYPED_V11_MANIFEST_PAGE_SQL } from "../src/typed-v11-record-reader";
import { makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { advanceStorageAnalytics, initializeStorageAnalyticsRuntime, runStorageAnalyticsPass } from "../src/storage-analytics-runtime";
import { runStorageAnalyticsSchedule } from "../src/storage-analytics-worker";
import { readAdminOverview } from "../src/admin-operations";
import { lookupV11StorageSource } from "../src/v11-storage-journal";

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
  ACCOUNTLESS_ENROLLMENT_MODE: "enabled", ACCOUNTLESS_OWNERSHIP_MODE: "enabled", PUBLIC_ANALYTICS_MODE:"enabled" } as Env);
const step = (db = target()) => advanceV11DailyProjection({ source: source(), target: db, sourceId, sourceLayout });
const read = (ownerDigest: string) => readV11ProjectedOwnerDays({ source: source(), target: target(), sourceId,
  ownerDigest, fromDay: today(), throughDay: today() });
function withObservedBatches(database: D1Database, sizes: number[], truncateFirst = false): D1Database {
  let calls = 0;
  return new Proxy(database, { get(value, property) {
    if (property === "batch") return (async (statements: D1PreparedStatement[]) => {
      calls += 1; sizes.push(statements.length);
      const results = await database.batch(statements);
      return truncateFirst && calls === 1 ? results.slice(0, 1) : results;
    }) as D1Database["batch"];
    const member: unknown = Reflect.get(value, property);
    return typeof member === "function" ? member.bind(value) : member;
  } });
}
function observedDatabase(database: D1Database, stats: { prepared: number; roundTrips: number }): D1Database {
  const raw = Symbol("raw-statement");
  const statement = (value: D1PreparedStatement): D1PreparedStatement => new Proxy(value, { get(inner, property) {
    if (property === raw) return inner;
    if (property === "bind") return (...values: unknown[]) => statement(inner.bind(...values));
    if (["all", "first", "raw", "run"].includes(String(property))) return (...values: unknown[]) => {
      stats.roundTrips += 1;
      return (inner[property as keyof D1PreparedStatement] as (...args: unknown[]) => unknown).apply(inner, values);
    };
    const candidate: unknown = Reflect.get(inner, property);
    return typeof candidate === "function" ? candidate.bind(inner) : candidate;
  } });
  return new Proxy(database, { get(value, property) {
    if (property === "prepare") return (sql: string) => { stats.prepared += 1; return statement(value.prepare(sql)); };
    if (property === "batch") return (statements: D1PreparedStatement[]) => {
      stats.roundTrips += 1;
      return value.batch(statements.map(candidate => Reflect.get(candidate, raw)));
    };
    const candidate: unknown = Reflect.get(value, property);
    return typeof candidate === "function" ? candidate.bind(value) : candidate;
  } });
}
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
  return { participantId, deviceId, authorization, event, manifest };
}

async function activateSuccessor(value: Awaited<ReturnType<typeof fixture>>) {
  const principal = { participantId: value.participantId, deviceId: value.deviceId };
  const prepared = await makeV11Day(today(), { usage: Array.from({ length: 1_201 }, (_, n) =>
    v11UsageRecord(today(), "a", { eventId: `event:v2:${n.toString(16).padStart(64, "0")}` })) });
  const day = await registerTelemetryV11DayManifest(source(), principal, prepared.manifest);
  for (const chunk of prepared.chunks) {
    const envelopeDigest = await sha256Hex(`synthetic-successor:${crypto.randomUUID()}`);
    const device = await authenticateDevice(source(), value.authorization);
    const upload = await createDeviceUploadAuthorization(source(), device, envelopeDigest, 200);
    const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
    await persistTypedV11StagedChunk(source(), principal, chunk, { sourceNamespace: namespace,
      chunkRowId: `chunk:${crypto.randomUUID()}`, r2Key: `synthetic/${crypto.randomUUID()}`, envelopeDigest,
      deviceUploadAuthorizationId: claimed.authorizationId });
  }
  const prior = await createTelemetryV11DomainPredecessor(source(), principal);
  const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1",
    fromDay: day.day, throughDay: day.day,
    predecessor: { token: prior.token, previousGenerationId: prior.previousGenerationId,
      legacyFingerprint: prior.legacyFingerprint },
    days: [{ day: day.day, manifestId: day.manifestId, manifestDigest: day.manifestDigest }],
    manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(source(), principal, manifest);
  const event = (await readIngestionChanges(source(), sourceId, value.event.sequence)).at(-1);
  if (!event) throw new Error("synthetic successor event missing");
  return event;
}

describe("typed accountless upload to isolated projection", () => {
  it("reports the typed current corpus from headers and publication state from analytics", async () => {
    await applyD1Migrations(source(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(source(), namespace);
    await initializeStorageAnalyticsRuntime({ source: source(), target: target(), sourceId,
      sourceNamespace: namespace });
    const value = await fixture(203);
    const releasedAt = new Date().toISOString();
    const authority = JSON.stringify({ sourceId, publicAuthorityEpoch: 0 });
    await target().batch([
      target().prepare(`INSERT INTO analytics_community_daily_publications(
        source_id,day,revision,cohort_digest,authority_json,payload_json,payload_sha256,released_at)
        VALUES(?,?,1,?,?,'{}',?,?)`).bind(sourceId, today(), "a".repeat(64), authority, "b".repeat(64), releasedAt),
      target().prepare("INSERT INTO analytics_community_daily_queue VALUES(?,?,1)")
        .bind(sourceId, "2026-09-12"),
      target().prepare(`INSERT INTO analytics_community_model_publications(
        source_id,day,revision,method,cohort_digest,authority_json,payload_json,payload_sha256,computed_ms)
        VALUES(?,?,1,'synthetic',?,?,'{}',?,?)`)
        .bind(sourceId, today(), "c".repeat(64), authority, "d".repeat(64), Date.now()),
    ]);
    const adminSourceQueries: string[] = [];
    const adminSource = new Proxy(source(), {
      get(base, property) {
        if (property === "prepare") return (sql: string) => {
          adminSourceQueries.push(sql);
          return base.prepare(sql);
        };
        const candidate: unknown = Reflect.get(base, property);
        return typeof candidate === "function" ? candidate.bind(base) : candidate;
      },
    });
    const overview = await readAdminOverview(adminSource, b.DELETION_LEDGER, {
      environment: "synthetic-development", enrollmentMode: "local_open",
      accountScopedIngestMode: "disabled", storage: { source: adminSource, target: target(),
        sourceId, sourceNamespace: namespace },
    }) as Record<string, any>;
    expect(overview).toMatchObject({
      schemaVersion: "admin-overview-v0.5",
      service: { telemetryStorageMode: "typed" },
      counts: { contributions: {
        contributingAccounts: { total: 1, bounded: false },
        incrementalChunks: { total: 2, current: 2, bounded: false },
        storedTelemetryRecords: 203,
        storedTelemetryRecordsBounded: false,
      } },
      dailyPublication: { latestEvidenceDay: today(), latestReleasedAt: releasedAt,
        pendingRebuilds: 1, pendingRebuildsBounded: false },
      historicalPublication: { publishedDays: 1, publishedDaysBounded: false,
        latestEvidenceDay: today(), previewState: "not_published" },
      pendingHistoricalRebuilds: null,
      snapshots: [],
    });
    expect(overview.counts.contributions.latestAcceptedAt).not.toBeNull();
    expect(JSON.stringify(overview)).not.toContain(value.participantId);
    expect(adminSourceQueries.some(sql => (
      sql.includes("FROM telemetry_analytical_chunks")
    ))).toBe(true);
    const retiredOverviewSource = /\bFROM\s+(?:typed_telemetry_records|telemetry_records|community_daily_aggregates|community_weekly_snapshots|community_weekly_snapshot_rebuilds)\b/u;
    expect(adminSourceQueries.every(sql => (
      !retiredOverviewSource.test(sql)
    ))).toBe(true);
  });

  it("refuses trigger separation on a target containing old analytical payloads",async()=>{
    await source().prepare("INSERT INTO community_model_composition_days(day,payload_json,computed_at) VALUES('2026-09-01','{}','2026-09-01T00:00:00.000Z')").run();
    await expect(applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(m=>/^(0001|0002)_/.test(m.name)))).rejects.toThrow();
    expect(await source().prepare("SELECT count(*) n FROM community_model_composition_days").first("n")).toBe(1);
    const trigger=await source().prepare("SELECT sql FROM sqlite_schema WHERE name='telemetry_v11_head_insert_publish'").first<string>("sql");
    expect(trigger).toContain("INSERT INTO community_daily_aggregate_rebuilds");
  });
  it("removes synchronous analytical work and retains accepted history after opt-out",async()=>{
    await applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(m=>/^(0001|0002)_/.test(m.name)));
    await applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter(m=>/^0005_/.test(m.name)));
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
    const retained = await read(value.event.ownerDigest);
    await revokeAccountlessEnrollment(source(),value.deviceId,"user_opt_out",Date.now());
    await expect(authenticateDevice(source(),value.authorization)).rejects.toThrow();
    expect(await read(value.event.ownerDigest)).toEqual(retained);
    await drain();expect(await read(value.event.ownerDigest)).toEqual(retained);
    expect(await source().prepare("SELECT COUNT(*) n FROM typed_v11_record_admissions").first("n")).toBe(203);
    expect(await source().prepare("SELECT COUNT(*) n FROM storage_ingestion_changes").first("n")).toBe(1);
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
    // Owner summaries have their own bounded phase, so journal catch-up does
    // not leave the authenticated Admin history blank for days.
    expect(await target().prepare(`SELECT COUNT(*) AS n
      FROM analytics_admin_metric_snapshots WHERE source_id=?`).bind(sourceId).first<number>("n")).toBe(1);
    expect(await target().prepare(`SELECT COUNT(*) AS n
      FROM analytics_admin_metrics_history_cache WHERE source_id=?`).bind(sourceId).first<number>("n")).toBe(1);
    const snapshotJson = await target().prepare(`SELECT metrics_json
      FROM analytics_admin_metric_snapshots WHERE source_id=?`).bind(sourceId)
      .first<string>("metrics_json");
    expect(JSON.parse(snapshotJson!)).toMatchObject({
      corpusChunks: 2,
      corpusCurrentChunks: 2,
      corpusCurrentRecords: 203,
      contributingAccountsTotal: 1,
    });
    const historyJson = await target().prepare(`SELECT payload_json
      FROM analytics_admin_metrics_history_cache WHERE source_id=?`).bind(sourceId)
      .first<string>("payload_json");
    expect(JSON.parse(historyJson!).events).toMatchObject({
      uploadedChunks: { total: 2 },
      acceptedUploads: { total: 2 },
      uploadedRecords: { total: 203 },
      uploadingParticipants: { total: 1 },
    });
    await runStorageAnalyticsSchedule({STORAGE_ANALYTICS_MODE:"enabled",PUBLIC_ANALYTICS_MODE:"disabled",
      STORAGE_SOURCE_ID:sourceId,TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),
      STORAGE_ANALYTICS_DB:target(),DELETION_LEDGER:b.DELETION_LEDGER});
    expect(await target().prepare("SELECT sequence FROM analytics_source_cursors WHERE source_id=?")
      .bind(sourceId).first<number>("sequence")).toBe(1);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_community_daily_publications")
      .first<number>("n")).toBe(0);
    const unavailable={prepare(){throw new Error("synthetic analytics offline");}} as unknown as D1Database;
    await expect(runStorageAnalyticsSchedule({STORAGE_ANALYTICS_MODE:"enabled",STORAGE_SOURCE_ID:sourceId,
      TELEMETRY_STORAGE_NAMESPACE:namespace,STORAGE_INGESTION_DB:source(),STORAGE_ANALYTICS_DB:unavailable,DELETION_LEDGER:b.DELETION_LEDGER}))
      .rejects.toThrow("STORAGE_ANALYTICS_UNAVAILABLE");
    expect(await source().prepare("SELECT COUNT(*) n FROM typed_v11_record_admissions").first("n")).toBe(203);
    expect(await runStorageAnalyticsPass(options)).toMatchObject({state:"idle",recordsRead:0});
    expect((await read(value.event.ownerDigest)).values[0]!.counts.usage).toBe(203);
    await revokeAccountlessEnrollment(source(),value.deviceId,"security_reset",Date.now());
    expect((await read(value.event.ownerDigest)).state).toBe("authority-unavailable");
    expect(await runStorageAnalyticsPass(options)).toMatchObject({state:"idle"});
    expect((await read(value.event.ownerDigest)).values).toEqual([]);
    await expect(runStorageAnalyticsSchedule({STORAGE_ANALYTICS_MODE:"disabled"})).resolves.toBeUndefined();
  });
  it("accepts typed-only records without analytics and honors a security withdrawal before the consumer catches up", async () => {
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
    expect(await revokeAccountlessEnrollment(source(), value.deviceId, "security_reset", Date.now())).toBe(true);
    expect(await read(value.event.ownerDigest)).toEqual({ state: "authority-unavailable", values: [] });
    await drain();
    expect(await read(value.event.ownerDigest)).toEqual({ state: "available", values: [] });
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_day_values").first("n")).toBe(0);
  });

  it("groups five admitted physical pages and measures the exact bounded work", async () => {
    await applyD1Migrations(source(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(source(), namespace);
    await fixture(2_200);
    const options = { source: source(), target: target(), ledger: b.DELETION_LEDGER, sourceId, sourceNamespace: namespace,
      maxSteps: 1, publishCommunity: false, skipV1PrefixProbe: true };
    await initializeStorageAnalyticsRuntime(options);
    expect(await runStorageAnalyticsPass(options)).toMatchObject({ state: "progress", recordsRead: 1_000 });
    const stats = { prepared: 0, roundTrips: 0 };
    const measured = await runStorageAnalyticsPass({ ...options, source: observedDatabase(source(), stats),
      target: observedDatabase(target(), stats), ledger: observedDatabase(b.DELETION_LEDGER, stats) });
    expect(measured).toMatchObject({ state: "progress", reason: "step_limit", steps: 1, recordsRead: 1_000 });
    expect(await target().prepare(`SELECT revision,day_records FROM analytics_v11_projection_work
      WHERE source_id=?`).bind(sourceId).first()).toEqual({ revision: 10, day_records: 2_000 });
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_projection_steps").first<number>("n")).toBe(10);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_value_pages").first<number>("n")).toBe(10);
    expect(await target().prepare("SELECT MAX(length(values_json)) n FROM analytics_v11_value_pages").first<number>("n"))
      .toBeLessThanOrEqual(262_144);
    expect({ queries: measured.queriesUsed, prepared: stats.prepared, roundTrips: stats.roundTrips })
      .toEqual({ queries: 77, prepared: 77, roundTrips: 40 });
    expect(measured.queriesUsed).toBeLessThan(840);
  });

  it("keeps the reserved query headroom ahead of any grouped target write", async () => {
    await applyD1Migrations(source(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(source(), namespace);
    await fixture(1_200);
    const options = { source: source(), target: target(), ledger: b.DELETION_LEDGER, sourceId,
      sourceNamespace: namespace, maxSteps: 1, publishCommunity: false, skipV1PrefixProbe: true };
    await initializeStorageAnalyticsRuntime(options);
    expect(await runStorageAnalyticsPass({ ...options, maxQueries: 99 }))
      .toMatchObject({ state: "deferred", reason: "query_budget", steps: 0, recordsRead: 0 });
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_projection_steps").first<number>("n")).toBe(0);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_value_pages").first<number>("n")).toBe(0);
    const resumed = await runStorageAnalyticsPass({ ...options, maxQueries: 840 });
    expect(resumed).toMatchObject({ state: "progress", recordsRead: 1_000 });
    expect(resumed.queriesUsed).toBeLessThan(840);
  });

  it("keeps the final partial page and ready transition outside a physical-page group", async () => {
    await applyD1Migrations(source(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(source(), namespace);
    await fixture(1_050);
    const options = { source: source(), target: target(), sourceId, sourceNamespace: namespace,
      maxSteps: 1, publishCommunity: false, skipV1PrefixProbe: true };
    await initializeStorageAnalyticsRuntime(options);
    expect(await runStorageAnalyticsPass(options)).toMatchObject({ recordsRead: 1_000, steps: 1 });
    expect(await target().prepare("SELECT revision,day_records,phase FROM analytics_v11_projection_work")
      .first()).toEqual({ revision: 5, day_records: 1_000, phase: "building" });
    expect(await runStorageAnalyticsPass(options)).toMatchObject({ recordsRead: 50, steps: 1 });
    expect(await target().prepare("SELECT revision,day_records,phase FROM analytics_v11_projection_work")
      .first()).toEqual({ revision: 6, day_records: 0, phase: "ready" });
    expect(await runStorageAnalyticsPass(options)).toMatchObject({ recordsRead: 0, steps: 1 });
    expect(await target().prepare("SELECT sequence FROM analytics_source_cursors WHERE source_id=?")
      .bind(sourceId).first<number>("sequence")).toBe(1);
  });

  it("accepts a lost grouped response only when all five exact step receipts exist", async () => {
    const value = await fixture(1_200);
    const input = await lookupV11StorageSource(source(), value.event);
    if (input.disposition !== "generation") throw new Error("synthetic generation missing");
    let lost = false;
    const flaky = new Proxy(target(), { get(database, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await database.batch(statements);
        if (!lost && statements.length === 15) { lost = true; throw new Error("synthetic grouped ACK loss"); }
        return result;
      };
      const member: unknown = Reflect.get(database, property);
      return typeof member === "function" ? member.bind(database) : member;
    } });
    expect(await advanceAdmittedV11DailyProjection({ source: source(), target: flaky, sourceId,
      change: value.event, input, sourceLayout, maxPhysicalPages: 5 }))
      .toMatchObject({ state: "building", recordsRead: 1_000 });
    expect(lost).toBe(true);
    expect((await target().prepare(`SELECT revision,step_digest FROM analytics_v11_projection_steps
      ORDER BY revision`).all()).results).toHaveLength(5);
    expect(await target().prepare("SELECT revision,day_records FROM analytics_v11_projection_work")
      .first()).toEqual({ revision: 5, day_records: 1_000 });

    await reset();
    await applyD1Migrations(source(), b.TEST_MIGRATIONS);
    await applyD1Migrations(source(), b.TEST_TYPED_INGESTION_MIGRATIONS);
    await applyD1Migrations(source(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
    await applyD1Migrations(source(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
    await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS);
    await initializeStorageSource(source(), sourceId);
    await initializeTypedV11Admission(source(), namespace);
    await source().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
    const other = await fixture(1_200);
    const otherInput = await lookupV11StorageSource(source(), other.event);
    if (otherInput.disposition !== "generation") throw new Error("synthetic generation missing");
    let partial = false;
    const impossiblePartial = new Proxy(target(), { get(database, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!partial && statements.length === 15) {
          partial = true;
          await database.batch(statements.slice(0, 3));
          throw new Error("synthetic non-atomic partial group");
        }
        return database.batch(statements);
      };
      const member: unknown = Reflect.get(database, property);
      return typeof member === "function" ? member.bind(database) : member;
    } });
    await expect(advanceAdmittedV11DailyProjection({ source: source(), target: impossiblePartial, sourceId,
      change: other.event, input: otherInput, sourceLayout, maxPhysicalPages: 5 }))
      .rejects.toThrow("V11_PROJECTION_STEP_UNACKNOWLEDGED");
    expect(partial).toBe(true);
    expect(await target().prepare(`SELECT COUNT(*) n FROM analytics_v11_projection_steps
      WHERE event_digest=?`).bind(other.event.eventDigest).first<number>("n")).toBe(1);
  });

  it("rolls back every grouped page when one statement fails", async () => {
    const value = await fixture(1_200);
    const input = await lookupV11StorageSource(source(), value.event);
    if (input.disposition !== "generation") throw new Error("synthetic generation missing");
    const broken = new Proxy(target(), { get(database, property) {
      if (property === "batch") return (statements: D1PreparedStatement[]) => database.batch(statements.length === 15
        ? [...statements, database.prepare("INSERT INTO synthetic_missing_table VALUES(1)")] : statements);
      const member: unknown = Reflect.get(database, property);
      return typeof member === "function" ? member.bind(database) : member;
    } });
    await expect(advanceAdmittedV11DailyProjection({ source: source(), target: broken, sourceId,
      change: value.event, input, sourceLayout, maxPhysicalPages: 5 }))
      .rejects.toThrow("V11_PROJECTION_STEP_UNACKNOWLEDGED");
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_projection_steps").first<number>("n")).toBe(0);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_value_pages").first<number>("n")).toBe(0);
    expect(await target().prepare("SELECT revision,day_records FROM analytics_v11_projection_work")
      .first()).toEqual({ revision: 0, day_records: 0 });
  });

  it("rechecks owner authority after all grouped reads and isolates a successor generation", async () => {
    const withdrawn = await fixture(1_200);
    const withdrawnInput = await lookupV11StorageSource(source(), withdrawn.event);
    if (withdrawnInput.disposition !== "generation") throw new Error("synthetic generation missing");
    let sourceBatches = 0, withdrew = false;
    const withdrawingSource = new Proxy(source(), { get(database, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await database.batch(statements); sourceBatches += 1;
        if (sourceBatches === 10) {
          withdrew = true;
          await source().prepare("UPDATE participants SET state='deleting' WHERE id=?")
            .bind(withdrawn.participantId).run();
        }
        return result;
      };
      const member: unknown = Reflect.get(database, property);
      return typeof member === "function" ? member.bind(database) : member;
    } });
    expect(await advanceAdmittedV11DailyProjection({ source: withdrawingSource, target: target(), sourceId,
      change: withdrawn.event, input: withdrawnInput, sourceLayout, maxPhysicalPages: 5 }))
      .toMatchObject({ state: "discarded", sequence: withdrawn.event.sequence, recordsRead: 1_000 });
    expect(withdrew).toBe(true);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_value_pages").first<number>("n")).toBe(0);

    await reset();
    await applyD1Migrations(source(), b.TEST_MIGRATIONS);
    await applyD1Migrations(source(), b.TEST_TYPED_INGESTION_MIGRATIONS);
    await applyD1Migrations(source(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
    await applyD1Migrations(source(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
    await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS);
    await initializeStorageSource(source(), sourceId);
    await initializeTypedV11Admission(source(), namespace);
    await source().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
    const original = await fixture(1_200);
    const originalInput = await lookupV11StorageSource(source(), original.event);
    if (originalInput.disposition !== "generation") throw new Error("synthetic generation missing");
    let batches = 0;
    const activation: { sequence?: number } = {};
    const racingSource = new Proxy(source(), { get(database, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await database.batch(statements); batches += 1;
        if (batches === 1) activation.sequence = (await activateSuccessor(original)).sequence;
        return result;
      };
      const member: unknown = Reflect.get(database, property);
      return typeof member === "function" ? member.bind(database) : member;
    } });
    expect(await advanceAdmittedV11DailyProjection({ source: racingSource, target: target(), sourceId,
      change: original.event, input: originalInput, sourceLayout, maxPhysicalPages: 5 }))
      .toMatchObject({ state: "building", sequence: 0, recordsRead: 1_000 });
    expect(activation.sequence).toBe(2);
    expect(await target().prepare("SELECT generation_id,day_records FROM analytics_v11_projection_work")
      .first()).toEqual({ generation_id: originalInput.generationId, day_records: 1_000 });
    expect((await target().prepare("SELECT DISTINCT producer_event FROM analytics_v11_value_pages").all()).results)
      .toEqual([{ producer_event: original.event.eventDigest }]);
  });

  it("refuses a grouped target write after an erasure fence or elapsed deadline", async () => {
    const value = await fixture(1_200);
    const input = await lookupV11StorageSource(source(), value.event);
    if (input.disposition !== "generation") throw new Error("synthetic generation missing");
    let fenced = false;
    const fencingTarget = new Proxy(target(), { get(database, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!fenced && statements.length === 15) {
          fenced = true;
          await target().prepare(`INSERT INTO analytics_storage_erasure_fences
            (source_id,owner_digest,terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch)
            VALUES(?,?,?,?,?,?,?)`).bind(sourceId, value.event.ownerDigest, "f".repeat(64), value.event.sequence + 1,
            value.event.revision + 1, value.event.authorityEpoch + 1, value.event.publicAuthorityEpoch + 1).run();
        }
        return database.batch(statements);
      };
      const member: unknown = Reflect.get(database, property);
      return typeof member === "function" ? member.bind(database) : member;
    } });
    await expect(advanceAdmittedV11DailyProjection({ source: source(), target: fencingTarget, sourceId,
      change: value.event, input, sourceLayout, maxPhysicalPages: 5 }))
      .rejects.toThrow("V11_PROJECTION_STEP_UNACKNOWLEDGED");
    expect(fenced).toBe(true);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_value_pages").first<number>("n")).toBe(0);

    await reset();
    await applyD1Migrations(source(), b.TEST_MIGRATIONS);
    await applyD1Migrations(source(), b.TEST_TYPED_INGESTION_MIGRATIONS);
    await applyD1Migrations(source(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
    await applyD1Migrations(source(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
    await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS);
    await initializeStorageSource(source(), sourceId);
    await initializeTypedV11Admission(source(), namespace);
    await source().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
    const late = await fixture(1_200);
    const lateInput = await lookupV11StorageSource(source(), late.event);
    if (lateInput.disposition !== "generation") throw new Error("synthetic generation missing");
    let now = 1_000, batches = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const lateSource = new Proxy(source(), { get(database, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await database.batch(statements); batches += 1;
        if (batches === 10) now = 20_000;
        return result;
      };
      const member: unknown = Reflect.get(database, property);
      return typeof member === "function" ? member.bind(database) : member;
    } });
    try {
      await expect(advanceAdmittedV11DailyProjection({ source: lateSource, target: target(), sourceId,
        change: late.event, input: lateInput, sourceLayout, maxPhysicalPages: 5, deadlineMs: 20_000 }))
        .rejects.toThrow("V11_PROJECTION_DEADLINE_EXCEEDED");
    } finally { clock.mockRestore(); }
    expect(batches).toBeGreaterThanOrEqual(10);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_projection_steps").first<number>("n")).toBe(0);
  });

  it("does not let a later terminal proof skip its journal row when the prefix hint is stale", async () => {
    await applyD1Migrations(source(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(source(), namespace);
    const value = await fixture();
    await initializeStorageAnalyticsRuntime({ source: source(), target: target(), sourceId, sourceNamespace: namespace });
    await source().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(value.participantId).run();
    const options = { source: source(), target: target(), sourceId, sourceNamespace: namespace,
      maxSteps: 1, publishCommunity: false, skipV1PrefixProbe: true };
    expect(await runStorageAnalyticsPass(options)).toMatchObject({ state: "progress", steps: 1, recordsRead: 0 });
    expect(await target().prepare("SELECT sequence FROM analytics_source_cursors WHERE source_id=?")
      .bind(sourceId).first<number>("sequence")).toBe(1);
    expect(await runStorageAnalyticsPass(options)).toMatchObject({ state: "progress", steps: 1, recordsRead: 0 });
    expect(await target().prepare("SELECT sequence FROM analytics_source_cursors WHERE source_id=?")
      .bind(sourceId).first<number>("sequence")).toBe(2);
  });

  it("rejects forged admitted objects and rechecks owner authority after reading a page", async () => {
    const value = await fixture(203), input = await lookupV11StorageSource(source(), value.event);
    if (input.disposition !== "generation") throw new Error("synthetic generation missing");
    const admitted = { source: source(), target: target(), sourceId, change: value.event, input,
      sourceLayout } as const;
    await expect(advanceAdmittedV11DailyProjection({ ...admitted,
      input: { ...input, manifestDigest: "f".repeat(64) } })).rejects.toThrow("V11_PROJECTION_SOURCE_CONFLICT");
    await expect(advanceAdmittedV11DailyProjection({ ...admitted,
      input: { disposition: "discard", reason: "owner-erased", sourceId, ownerDigest: value.event.ownerDigest,
        terminalRevision: value.event.revision, terminalSequence: value.event.sequence,
        authorityEpoch: value.event.authorityEpoch, publicAuthorityEpoch: value.event.publicAuthorityEpoch } }))
      .rejects.toThrow("V11_PROJECTION_SOURCE_CONFLICT");
    let batches = 0, erased = false;
    const observed = new Proxy(source(), { get(database, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        batches += 1;
        if (batches === 3 && !erased) {
          erased = true;
          await source().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(value.participantId).run();
        }
        return database.batch(statements);
      };
      const member: unknown = Reflect.get(database, property);
      return typeof member === "function" ? member.bind(database) : member;
    } });
    const fresh = await lookupV11StorageSource(source(), value.event);
    expect(await advanceAdmittedV11DailyProjection({ ...admitted, source: observed, input: fresh }))
      .toMatchObject({ state: "discarded", sequence: 1, recordsRead: 200 });
    expect(erased).toBe(true);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_value_pages").first<number>("n")).toBe(0);
  });

  it("reconciles a lost admitted-page response without applying the page twice", async () => {
    await applyD1Migrations(source(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
    await initializeTypedV1Admission(source(), namespace);
    await fixture(203);
    await initializeStorageAnalyticsRuntime({ source: source(), target: target(), sourceId, sourceNamespace: namespace });
    let lost = false;
    const flaky = new Proxy(target(), { get(database, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await database.batch(statements);
        if (!lost) { lost = true; throw new Error("synthetic lost admitted page response"); }
        return result;
      };
      const member: unknown = Reflect.get(database, property);
      return typeof member === "function" ? member.bind(database) : member;
    } });
    expect(await advanceStorageAnalytics({ source: source(), target: flaky, sourceId, sourceNamespace: namespace }))
      .toMatchObject({ recordsRead: 200 });
    expect(await advanceStorageAnalytics({ source: source(), target: target(), sourceId, sourceNamespace: namespace }))
      .toMatchObject({ recordsRead: 3 });
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_projection_steps").first<number>("n")).toBe(2);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_value_pages").first<number>("n")).toBe(2);
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

  it("batches a 200-record manifest page and refuses a truncated membership snapshot", async () => {
    const value = await fixture(203);
    const options = { sourceNamespace: namespace, participantId: value.participantId, deviceId: value.deviceId,
      manifestId: value.manifest.days[0]!.manifestId, afterStream: "", afterOccurrence: "", limit: 200 };
    const sizes: number[] = [];
    expect(await readTypedV11ManifestPage(withObservedBatches(source(), sizes), options)).toHaveLength(200);
    expect(sizes).toEqual([2, 3]);
    await expect(readTypedV11ManifestPage(withObservedBatches(source(), [], true), options))
      .rejects.toThrow("TYPED_V11_READER_MEMBERSHIP_CONFLICT");
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
