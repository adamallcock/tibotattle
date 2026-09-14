import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { telemetryV11DomainManifestDigestInput,
  type TelemetryV11DomainManifest } from "@app-usagemonitor/telemetry-contract";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { initializeStorageAnalyticsRuntime } from "../src/storage-analytics-runtime";
import { drainCommunityPublicSourceBootstrap } from "../src/community-daily-aggregates";
import { ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION, ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
  enrollAccountlessDevice } from "../src/accountless-enrollment";
import { ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION, ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  createAccountlessUploadOwner } from "../src/accountless-ownership";
import { authenticateDevice, claimDeviceUploadAuthorization,
  createDeviceUploadAuthorization } from "../src/device-auth";
import { encodeBase64Url, sha256, sha256Hex } from "../src/crypto";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain,
  createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { createCatalogStorageRouter, initializeAccountlessIssuanceBaseline,
  type AccountlessIssuanceReservation, type OwnerStorageRoute } from "../src/storage-routing";
import { configureStorageShardAllocation,
  recordStorageCapacityObservation } from "../src/storage-capacity";
import { qualifyStorageShardForTest } from './helpers/storage-shard-readiness';
import { captureStorageMultiSourceCohort,
  storageMultiSourceCohortPublicationQueryCeiling } from "../src/storage-multi-source-cohort";
import { runStorageAnalyticsSchedule,
  storageMultiSourceScheduleQueryCeiling } from "../src/storage-analytics-worker";
import { makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";

interface Bindings extends Env {
  STORAGE_ROUTING_DB: D1Database;
  STORAGE_INGESTION_A: D1Database; STORAGE_INGESTION_B: D1Database; STORAGE_INGESTION_C: D1Database;
  STORAGE_ANALYTICS_A: D1Database; STORAGE_ANALYTICS_B: D1Database; STORAGE_ANALYTICS_C: D1Database;
  STORAGE_PUBLICATION_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ROUTING_MIGRATIONS: D1Migration[]; TEST_ANALYTICS_MIGRATIONS: D1Migration[];
  TEST_ROUTING_MIGRATIONS: D1Migration[]; TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}
const b = env as Bindings;
const namespaces = { a: "synthetic-a", b: "synthetic-b", c: "synthetic-c" } as const;
const sourceIds = { a: "source-a", b: "source-b", c: "source-c" } as const;
const sources = () => ({ a: b.STORAGE_INGESTION_A, b: b.STORAGE_INGESTION_B,
  c: b.STORAGE_INGESTION_C });
const targets = () => ({ a: b.STORAGE_ANALYTICS_A, b: b.STORAGE_ANALYTICS_B,
  c: b.STORAGE_ANALYTICS_C });
const routeBindings = () => ({ STORAGE_INGESTION_A: b.STORAGE_INGESTION_A,
  STORAGE_INGESTION_B: b.STORAGE_INGESTION_B, STORAGE_INGESTION_C: b.STORAGE_INGESTION_C });
const router = () => createCatalogStorageRouter({ catalog: b.STORAGE_ROUTING_DB,
  bindings: routeBindings(), clock: () => Date.now() });
const cohortEnv = () => ({ STORAGE_ROUTING_DB: b.STORAGE_ROUTING_DB, ...routeBindings(),
  STORAGE_ANALYTICS_A: b.STORAGE_ANALYTICS_A, STORAGE_ANALYTICS_B: b.STORAGE_ANALYTICS_B,
  STORAGE_ANALYTICS_C: b.STORAGE_ANALYTICS_C, STORAGE_PUBLICATION_DB: b.STORAGE_PUBLICATION_DB,
  STORAGE_SOURCE_NAMESPACE_A: namespaces.a, STORAGE_SOURCE_NAMESPACE_B: namespaces.b,
  STORAGE_SOURCE_NAMESPACE_C: namespaces.c });

beforeEach(async () => {
  await reset();
  await applyD1Migrations(b.STORAGE_ROUTING_DB, b.TEST_ROUTING_MIGRATIONS);
  await initializeAccountlessIssuanceBaseline(b.STORAGE_ROUTING_DB, {
    budgetDay: new Date().toISOString().slice(0, 10), dailyReserved: 0,
    lifetimeReserved: 0, baselineDigest: "f".repeat(64),
    initializedAt: Date.now(),
  });
  await applyD1Migrations(b.DELETION_LEDGER, b.TEST_DELETION_LEDGER_MIGRATIONS);
  await applyD1Migrations(b.STORAGE_PUBLICATION_DB, b.TEST_ANALYTICS_MIGRATIONS);
  for (const shard of ["a", "b", "c"] as const) {
    const source = sources()[shard], target = targets()[shard];
    for (const migrations of [b.TEST_MIGRATIONS, b.TEST_TYPED_INGESTION_MIGRATIONS,
      b.TEST_INGESTION_BRIDGE_MIGRATIONS, b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,
      b.TEST_TYPED_V1_ADMISSION_MIGRATIONS]) await applyD1Migrations(source, migrations);
    await initializeStorageSource(source, sourceIds[shard]);
    await initializeTypedV11Admission(source, namespaces[shard]);
    await initializeTypedV1Admission(source, namespaces[shard]);
    await source.prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
    await applyD1Migrations(source, b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    await applyD1Migrations(source, b.TEST_INGESTION_ROUTING_MIGRATIONS);
    await drainCommunityPublicSourceBootstrap(source);
    await applyD1Migrations(target, b.TEST_ANALYTICS_MIGRATIONS);
    await initializeStorageAnalyticsRuntime({ source, target, sourceId: sourceIds[shard],
      sourceNamespace: namespaces[shard] });
  }
  await b.STORAGE_ROUTING_DB.batch((["a", "b", "c"] as const).map(shard =>
    b.STORAGE_ROUTING_DB.prepare("INSERT INTO storage_shards(shard_id,binding_name,state) VALUES(?,?,'active')")
      .bind(shard, `STORAGE_INGESTION_${shard.toUpperCase()}`)));
  const now = Date.now();
  for (const shardId of ["a", "b", "c"] as const) {
    await recordStorageCapacityObservation(b.STORAGE_ROUTING_DB, { shardId,
      observedBytes: 0, observedAt: now, validUntil: now + 60_000, pressureState: "normal" });
    const readiness=await qualifyStorageShardForTest(b.STORAGE_ROUTING_DB,{shardId,
      bindingName:`STORAGE_INGESTION_${shardId.toUpperCase()}`,
      qualifiedAt:now});
    await configureStorageShardAllocation(b.STORAGE_ROUTING_DB, { shardId,
      allocationTier: "active", allocationEnabled: true,
      qualificationDigest:readiness.readinessDigest, updatedAt: now });
  }
});

async function seedOwner(shard: "a" | "b" | "c", ownerId: string,
  options: { catalog?: boolean; fill?: string } = {}) {
  const db = sources()[shard], now = Date.now();
  const deviceId = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const input = new Uint8Array(prefix.length + secret.length); input.set(prefix); input.set(secret, prefix.length);
  const request = { schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION, deviceId,
    deviceSecretHash: await sha256(input), policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS } as const;
  input.fill(0);
  const authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`; secret.fill(0);
  let route: OwnerStorageRoute;
  let issuanceReservation: AccountlessIssuanceReservation | undefined;
  if (options.catalog !== false) {
    route = await router().ensureOwner(ownerId, shard, 1);
    const capabilityHash = [...request.deviceSecretHash]
      .map(value => value.toString(16).padStart(2, "0")).join("");
    await b.STORAGE_ROUTING_DB.prepare(`INSERT INTO storage_capability_locators
      (capability_hash,owner_id,state) VALUES (?,?,'active')`)
      .bind(capabilityHash, ownerId).run();
    const allocation = await router().ensureCapabilityOwner(
      capabilityHash,
      await sha256Hex(`app-usagemonitor/storage-accountless-device/v1\0${deviceId}`),
      ownerId,
      1,
    );
    route = allocation.route;
    issuanceReservation = allocation.issuanceReservation;
  } else {
    route = { mode: "single", ownerId, shardId: "primary",
      bindingName: "USAGE_MONITOR_DB", generation: 0 };
  }
  await enrollAccountlessDevice(db, request, now, route, issuanceReservation);
  const owner = await createAccountlessUploadOwner(db, authorization, {
    schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
    policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
    telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  }, now, route);
  const principal = await authenticateDevice(db, authorization);
  const day = new Date(now).toISOString().slice(0, 10);
  const prepared = await makeV11Day(day, { usage: [v11UsageRecord(day, options.fill ?? shard)] });
  const staged = await registerTelemetryV11DayManifest(db, principal, prepared.manifest, now, route);
  for (const chunk of prepared.chunks) {
    const envelopeDigest = await sha256Hex(`synthetic:${crypto.randomUUID()}`);
    const upload = await createDeviceUploadAuthorization(db, principal, envelopeDigest, 200, now, route);
    const claim = await claimDeviceUploadAuthorization(db, `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest, bodyBytes: 200, contentType: "application/json" }, route);
    await persistTypedV11StagedChunk(db, principal, chunk, { sourceNamespace: namespaces[shard],
      chunkRowId: `chunk:${crypto.randomUUID()}`, r2Key: `synthetic/${crypto.randomUUID()}`,
      envelopeDigest, deviceUploadAuthorizationId: claim.authorizationId }, now, route);
  }
  const predecessor = await createTelemetryV11DomainPredecessor(db, principal, now, route);
  const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1",
    fromDay: day, throughDay: day, predecessor: { token: predecessor.token,
      previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: [{ day, manifestId: staged.manifestId, manifestDigest: staged.manifestDigest }],
    manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(db, principal, manifest, now, route);
  const ownerDigest = await db.prepare("SELECT owner_digest FROM storage_v11_owner_links WHERE participant_id=?")
    .bind(owner.participantId).first<string>("owner_digest");
  if (!ownerDigest) throw new Error("synthetic owner missing");
  return { route, ownerId, ownerDigest, participantId: owner.participantId };
}

describe("trusted storage multi-source cohort", () => {
  it("captures the current routed copy and excludes a retained copy only with exact catalog proof", async () => {
    const current = await seedOwner("a", "accountless:cohort-owner", { fill: "a" });
    const retained = await seedOwner("b", current.ownerId, { catalog: false, fill: "b" });
    await b.STORAGE_ROUTING_DB.prepare(`INSERT INTO storage_owner_routes
      (owner_id,shard_id,route_generation,state,reservation_bytes,updated_at)
      VALUES('accountless:orphan-preparing','c',1,'preparing',1,?)`).bind(Date.now()).run();
    const captured = await captureStorageMultiSourceCohort(cohortEnv());
    expect(captured).toMatchObject({ activeRouteCount: 1, memberCount: 1 });
    expect(captured.set.members).toEqual([{ sourceId: "source-a", ownerDigest: current.ownerDigest,
      inputRevision: 1, ownerRevision: 1, routeGeneration: 1 }]);
    expect(captured.set.members[0]!.ownerDigest).not.toBe(retained.ownerDigest);
  });

  it("defers the whole cohort for an eligible owner without a catalog route", async () => {
    await seedOwner("b", "accountless:unmapped-owner", { catalog: false });
    await expect(captureStorageMultiSourceCohort(cohortEnv()))
      .rejects.toThrow("STORAGE_MULTI_SOURCE_COHORT_UNAVAILABLE");
  });

  it("refuses aliased resources, partial C configuration, and a current C owner without analytics C", async () => {
    await expect(captureStorageMultiSourceCohort({ ...cohortEnv(),
      STORAGE_ANALYTICS_A: b.STORAGE_INGESTION_A }))
      .rejects.toThrow("STORAGE_MULTI_SOURCE_COHORT_UNAVAILABLE");
    await expect(captureStorageMultiSourceCohort({ ...cohortEnv(), STORAGE_ANALYTICS_C: undefined }))
      .rejects.toThrow("STORAGE_MULTI_SOURCE_COHORT_UNAVAILABLE");
    await seedOwner("c", "accountless:c-owner");
    const withoutC = { ...cohortEnv(), STORAGE_ANALYTICS_C: undefined,
      STORAGE_SOURCE_NAMESPACE_C: undefined };
    await expect(captureStorageMultiSourceCohort(withoutC))
      .rejects.toThrow("STORAGE_MULTI_SOURCE_COHORT_UNAVAILABLE");
  });

  it("shares one 900-query scheduler meter and retains source progress when publication fails", async () => {
    expect(storageMultiSourceCohortPublicationQueryCeiling(5_000, 3)).toBe(518);
    expect(storageMultiSourceScheduleQueryCeiling()).toBe(887);
    await seedOwner("a", "accountless:progress-owner");
    await b.STORAGE_INGESTION_A.prepare("DELETE FROM storage_owner_fences WHERE owner_id=?")
      .bind("accountless:progress-owner").run();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(runStorageAnalyticsSchedule({ ...cohortEnv(), DELETION_LEDGER: b.DELETION_LEDGER,
      STORAGE_ANALYTICS_MODE: "multi-source" })).resolves.toBeUndefined();
    const applied = await b.STORAGE_ANALYTICS_A.prepare(
      "SELECT count(*) AS total FROM analytics_v11_projection_work WHERE source_id='source-a'",
    ).first<{total: number}>();
    expect(applied).toEqual({ total: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"publication":"unavailable"'));
    log.mockRestore();
  });
});
