import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { initializeStorageAnalyticsRuntime, advanceStorageAnalytics } from "../src/storage-analytics-runtime";
import { advanceNextStorageCommunityDaily } from "../src/storage-community-daily";
import { drainCommunityPublicSourceBootstrap } from "../src/community-daily-aggregates";
import { readStorageCommunityProgress, readStoragePipelineProgress } from "../src/storage-community-progress";
import { adoptV11UploadedEvidence } from "../src/v11-evidence-adoption";
import { makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";

interface Bindings extends Env { STORAGE_ANALYTICS_DB: D1Database; TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[] }
const b = env as Bindings, source = () => b.USAGE_MONITOR_DB, target = () => b.STORAGE_ANALYTICS_DB;
const sourceId = "synthetic-pipeline-source", namespace = "synthetic-pipeline-namespace";
const bindings = () => ({ source: source(), target: target(), sourceId, sourceNamespace: namespace });
const runtime = () => ({ ...b, ENVIRONMENT: "synthetic-development", ACCOUNT_SCOPED_INGEST_MODE: "disabled",
  ACCOUNTLESS_ENROLLMENT_MODE: "enabled", ACCOUNTLESS_OWNERSHIP_MODE: "enabled" } as Env);
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

beforeEach(async () => {
  await reset();
  await applyD1Migrations(source(), b.TEST_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS);
  await applyD1Migrations(b.DELETION_LEDGER, b.TEST_DELETION_LEDGER_MIGRATIONS);
  await initializeStorageSource(source(), sourceId);
  await applyD1Migrations(source(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await initializeTypedV11Admission(source(), namespace);
  await initializeTypedV1Admission(source(), namespace);
  await applyD1Migrations(source(), b.TEST_INGESTION_ISOLATION_MIGRATIONS);
  await initializeStorageAnalyticsRuntime(bindings());
  await source().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  for (let n = 0; n < 64; n++) if ((await drainCommunityPublicSourceBootstrap(source())).completed) break;
  for (let n = 0; n < 64; n++) if ((await advanceStorageAnalytics(bindings())).state === "idle") break;
});

type Device = { participantId: string; deviceId: string; authorization: string };

async function accountlessDevice(): Promise<Device> {
  const deviceId = crypto.randomUUID(), secret = crypto.getRandomValues(new Uint8Array(32));
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const bytes = new Uint8Array(prefix.length + secret.length); bytes.set(prefix); bytes.set(secret, prefix.length);
  const deviceSecretHash = await sha256Hex(bytes), authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  bytes.fill(0); secret.fill(0);
  const request = (path: string, body: object, auth = "") => handleRequest(new Request(`https://pipeline.example.test${path}`, {
    method: "POST", headers: { origin: "https://pipeline.example.test", "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  }), runtime());
  expect((await request("/api/v1/accountless/enrollment", { schemaVersion: "accountless-enrollment-v0.1", deviceId, deviceSecretHash,
    policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1" })).status).toBe(201);
  expect((await request("/api/v1/accountless/ownership", { schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
    authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1" }, authorization)).status).toBe(201);
  const participantId = (await source().prepare("SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?")
    .bind(deviceId).first<string>("participant_id"))!;
  return { participantId, deviceId, authorization };
}

async function uploadDay(device: Device, observedDay: string, events: number[]) {
  const prepared = await makeV11Day(observedDay, { usage: events.map((n) =>
    v11UsageRecord(observedDay, "a", { eventId: `event:v2:${observedDay.replaceAll("-", "")}${n.toString(16).padStart(56, "0")}`,
      eventTime: `${observedDay}T12:${String(n % 60).padStart(2, "0")}:00.000Z` })) });
  await registerTelemetryV11DayManifest(source(), device, prepared.manifest);
  for (const chunk of prepared.chunks) {
    const envelopeDigest = await sha256Hex(`synthetic-pipeline:${crypto.randomUUID()}`);
    const auth = await authenticateDevice(source(), device.authorization);
    const upload = await createDeviceUploadAuthorization(source(), auth, envelopeDigest, 200);
    const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
    await persistTypedV11StagedChunk(source(), device, chunk, { sourceNamespace: namespace, chunkRowId: `chunk:${crypto.randomUUID()}`,
      r2Key: `synthetic/${crypto.randomUUID()}`, envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId });
  }
}

describe("analytics processing pipeline progress", () => {
  it("follows one activation from the journal through delivery to daily publication", async () => {
    const before = (await readStoragePipelineProgress(bindings(), Date.now()))!;
    expect(before.delivery).toMatchObject({ pendingChanges: 0, pendingActivations: 0, current: null });
    expect(before.delivery.appliedSequence).toBe(before.ingestion.journalHead);

    const device = await accountlessDevice();
    for (const offset of [5, 4, 3]) await uploadDay(device, day(offset), [1, 2]);
    expect(await adoptV11UploadedEvidence(source(), { dryRun: false, maxDevices: 10, afterParticipantId: null }))
      .toMatchObject({ outcomes: { adopted: 1 } });

    const recorded = (await readStoragePipelineProgress(bindings(), Date.now()))!;
    expect(recorded.ingestion.journalHead).toBeGreaterThan(before.ingestion.journalHead);
    expect(recorded.ingestion.latestRecordedAt).not.toBeNull();
    expect(recorded.delivery).toMatchObject({ appliedSequence: before.delivery.appliedSequence, current: null });
    expect(recorded.delivery.pendingActivations).toBe(1);
    expect(recorded.delivery.pendingChanges).toBe(recorded.ingestion.journalHead - recorded.delivery.appliedSequence);

    // Fold the activation one day at a time and watch the current position move.
    const positions: Array<{ daysDone: number; daysTotal: number } | null> = [];
    for (let n = 0; n < 64; n++) {
      const step = await advanceStorageAnalytics({ ...bindings(), maxV11PhysicalPages: 1 });
      const pipeline = (await readStoragePipelineProgress(bindings(), Date.now()))!;
      positions.push(pipeline.delivery.current && { daysDone: pipeline.delivery.current.daysDone,
        daysTotal: pipeline.delivery.current.daysTotal });
      if (pipeline.delivery.current) {
        expect(pipeline.delivery.current).toMatchObject({ fromDay: day(5), throughDay: day(3) });
      }
      if (step.state === "idle") break;
    }
    const seen = positions.filter((value): value is { daysDone: number; daysTotal: number } => value !== null);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value.daysTotal === 3 && value.daysDone <= 3)).toBe(true);
    expect(seen.map((value) => value.daysDone)).toEqual([...seen.map((value) => value.daysDone)].sort((a, c) => a - c));

    const delivered = (await readStoragePipelineProgress(bindings(), Date.now()))!;
    expect(delivered.delivery).toMatchObject({ pendingChanges: 0, pendingActivations: 0, current: null,
      appliedSequence: delivered.ingestion.journalHead });
    expect(delivered.daily.queuedDays).toBeGreaterThan(0);
    expect(delivered.daily.oldestQueuedDay! <= delivered.daily.newestQueuedDay!).toBe(true);
    expect(delivered.daily).toMatchObject({ lastReleasedAt: null, releasedLastHour: 0 });

    for (let n = 0; n < 64; n++) {
      if ((await advanceNextStorageCommunityDaily({ ...bindings() })).state === "idle") break;
    }
    const published = (await readStoragePipelineProgress(bindings(), Date.now()))!;
    expect(published.daily).toMatchObject({ queuedDays: 0, oldestQueuedDay: null, newestQueuedDay: null });
    expect(published.daily.releasedLastHour).toBeGreaterThan(0);
    expect(published.daily.lastReleasedAt).not.toBeNull();
    // Publication an hour ago is no longer "in the last hour".
    expect((await readStoragePipelineProgress(bindings(), Date.now() + 2 * 3_600_000))!.daily.releasedLastHour).toBe(0);
  });

  it("reports the pipeline as unavailable without taking the progress panel down", async () => {
    const failing = new Proxy(source(), {
      get(target, property) {
        if (property === "batch") return async () => { throw new Error("synthetic source failure"); };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await readStoragePipelineProgress({ ...bindings(), source: failing }, Date.now())).toBeNull();
    const progress = await readStorageCommunityProgress(bindings(), Date.now());
    expect(progress.pipeline).not.toBeNull();
    expect(progress.graph.owners.active).toBeGreaterThanOrEqual(0);
  });
});
