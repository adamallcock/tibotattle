import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalTelemetryV12Json,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RequiredConsent,
  type TelemetryV12Chunk,
  type TelemetryV12DayManifest,
  type TelemetryV12UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture } from "./helpers/telemetry-v11";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { grantTelemetryV12AccountlessAuthorization, grantTelemetryV12Consent } from "../src/telemetry-transport-policy";
import { persistTelemetryV12StagedChunk, registerTelemetryV12DayManifest } from "../src/telemetry-v12-repository";
import { activateTelemetryV12Domain, createTelemetryV12DomainPredecessor } from "../src/telemetry-v12-domain";
import { advanceNextStorageCommunityDaily, advanceStorageCommunityDaily, readPublishedStorageCommunityDaily } from "../src/storage-community-daily";
import { drainCommunityPublicSourceBootstrap } from "../src/community-daily-aggregates";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeStorageAnalyticsRuntime, advanceStorageAnalytics } from "../src/storage-analytics-runtime";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import { revokeAccountlessEnrollment } from "../src/accountless-enrollment";
import { eraseParticipantAsOwner } from "../src/participant-erasure";
import { assertTelemetryV12WriteAllowed } from "../src/telemetry-transport-policy";

interface Bindings extends Env { STORAGE_ANALYTICS_DB: D1Database; TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[] }
const b = env as Bindings, source = () => b.USAGE_MONITOR_DB, target = () => b.STORAGE_ANALYTICS_DB;
const sourceId = "synthetic-typed-source", namespace = "synthetic-original-typed-source";
const today = () => new Date().toISOString().slice(0, 10);
const runtime = () => ({ ...b, ENVIRONMENT: "synthetic-development", ACCOUNT_SCOPED_INGEST_MODE: "disabled",
  ACCOUNTLESS_ENROLLMENT_MODE: "enabled", ACCOUNTLESS_OWNERSHIP_MODE: "enabled" } as Env);
const options = () => ({ source: source(), target: target(), sourceId, sourceNamespace: namespace, day: today() });

type Principal = { participantId: string; deviceId: string; authorization: string };

/** The shipped Electron route: enroll, claim ownership, then take the separate
 * v1.2 successor authorization. No v1.1 day is ever uploaded. */
async function accountlessV12Device(): Promise<Principal> {
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
  // The route's storage-mode and rate-limit gates are covered elsewhere; this
  // is the exact grant it commits.
  await grantTelemetryV12AccountlessAuthorization(source(), { participantId, deviceId }, {
    schemaVersion: "accountless-upload-owner-v1.2", policyVersion: "accountless-telemetry-v1.2-policy-v1",
    authorizationBasis: "accountless-policy-v1.2", telemetrySchemaVersion: "telemetry-contribution-v1.2" });
  return { participantId, deviceId, authorization };
}

function usageRecord(n: number): TelemetryV12UsageEvent {
  return {
    schemaVersion: "usage-event-v1.2", eventId: `event:v2:${n.toString(16).padStart(64, "0")}`,
    eventTime: `${today()}T00:05:00.000Z`, sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex", modelId: "gpt-5.6-sol", speedMode: "standard", apiServiceTier: "default",
    surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription", reasoningEffort: "high",
    agentScope: "root", outcome: "completed", totalInputContextTokens: 1000,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null },
    accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null, planBasis: "same_source_occurrence",
      planType: "pro", planEraId: null },
    boundaryFlags: null, tieOrder: null, cacheWriteTtl: null,
  };
}

const REBUILD = "0012_v12_empty_day_manifests.sql";
const isolation = () => b.TEST_INGESTION_ISOLATION_MIGRATIONS;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(source(), b.TEST_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await initializeStorageSource(source(), sourceId);
  await applyD1Migrations(source(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await initializeTypedV11Admission(source(), namespace);
  await initializeTypedV1Admission(source(), namespace);
  // The deployed predecessor: every isolation migration before the rebuild.
  await applyD1Migrations(source(), isolation().filter((migration) => migration.name < REBUILD));
  await source().prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1")
    .bind(new Date().toISOString()).run();
});

const manifestTable = () => source().prepare(
  "SELECT sql FROM sqlite_schema WHERE type='table' AND name='telemetry_v12_day_manifests'").first<string>("sql");
const namedObjects = async () => (await source().prepare(`SELECT type,name FROM sqlite_schema
  WHERE name IN ('telemetry_v12_manifests_device_day','telemetry_v12_manifest_admission','telemetry_v12_manifest_immutable',
    'telemetry_v12_manifest_ready','telemetry_v12_chunk_admission','telemetry_v12_record_admission',
    'telemetry_v12_domain_day_admission') ORDER BY name`).all<{ type: string; name: string }>()).results;

describe("isolation 0012 v1.2 empty day manifests", () => {
  it("rebuilds an empty role with the v1.1 bound and every dependent trigger", async () => {
    expect(await manifestTable()).toContain("BETWEEN 1 AND 4096");
    const before = await namedObjects();
    expect(before).toHaveLength(7);
    await applyD1Migrations(source(), isolation());
    expect(await manifestTable()).toContain("BETWEEN 0 AND 4096");
    expect(await namedObjects()).toEqual(before);
    expect(await source().prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'telemetry_v12_%rebuild%'").first("n")).toBe(0);
    const fkProblems = (await source().prepare("PRAGMA foreign_key_check").all()).results;
    expect(fkProblems).toEqual([]);
  });

  it("refuses to rebuild a role that already holds a v1.2 manifest and leaves it unchanged", async () => {
    const device = await createV11DeviceFixture(source());
    await grantTelemetryV12Consent(source(), device, telemetryV12RequiredConsent());
    const day = new Date().toISOString().slice(0, 10), consent = telemetryV12RequiredConsent();
    const records = [usageRecord(1)];
    const chunkDigest = await sha256Hex(canonicalTelemetryV12Json(records));
    const manifest: TelemetryV12DayManifest = { schemaVersion: "telemetry-day-manifest-v1.2", day, parserVersion: "synthetic-guard",
      consent, chunks: [{ chunkId: `usage:${day}:0`, chunkDigest, recordCount: 1 }],
      excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64) };
    manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
    await registerTelemetryV12DayManifest(source(), device, manifest);
    await expect(applyD1Migrations(source(), isolation())).rejects.toThrow();
    expect(await manifestTable()).toContain("BETWEEN 1 AND 4096");
    expect(await source().prepare("SELECT count(*) AS n FROM telemetry_v12_day_manifests").first("n")).toBe(1);
    expect(await source().prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'telemetry_v12_%rebuild%'").first("n")).toBe(0);
  });
});
