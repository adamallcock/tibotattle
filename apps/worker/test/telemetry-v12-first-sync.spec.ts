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
  await initializeStorageAnalyticsRuntime({ source: source(), target: target(), sourceId, sourceNamespace: namespace });
  await source().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  await source().prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1")
    .bind(new Date().toISOString()).run();
});

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


const dayOffset = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

function usageOn(day: string, n: number): TelemetryV12UsageEvent {
  return { ...usageRecord(n), eventId: `event:v2:${day.replaceAll("-", "")}${n.toString(16).padStart(56, "0")}`,
    eventTime: `${day}T00:05:${String(n % 60).padStart(2, "0")}.000Z` };
}

/** The desktop client's day preparation: one manifest per day, empty days included. */
async function prepareDay(day: string, records: readonly TelemetryV12UsageEvent[], revision = 1) {
  const consent = telemetryV12RequiredConsent(), parserVersion = `synthetic-v12-first-sync-${revision}`;
  const chunks: TelemetryV12Chunk[] = records.length ? [{ schemaVersion: "telemetry-contribution-v1.2",
    manifestDigest: "0".repeat(64), chunkId: `usage:${day}:0`, chunkRevision: 1, parserVersion, consent,
    records: [...records], chunkDigest: await sha256Hex(canonicalTelemetryV12Json(records)) }] : [];
  const manifest: TelemetryV12DayManifest = { schemaVersion: "telemetry-day-manifest-v1.2", day, parserVersion, consent,
    chunks: chunks.map(chunk => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length })),
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  for (const chunk of chunks) chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunks };
}

/** Exactly the order runSync uses: predecessor, every day in the planned range
 * (register, then upload each chunk), a renewed predecessor checked against the
 * plan, then activation. Throws with the server code on the first refusal. */
async function clientPass(principal: Principal, localDays: Map<string, TelemetryV12UsageEvent[]>, revision = 1) {
  const before = await createTelemetryV12DomainPredecessor(source(), principal);
  const local = [...localDays.keys()].sort();
  const fromDay = [before.fromDay, local[0]!].sort()[0]!;
  const throughDay = [before.throughDay, local.at(-1)!].sort().at(-1)!;
  const vector: Array<{ day: string; manifestId: string; manifestDigest: string }> = [];
  for (let time = Date.parse(`${fromDay}T00:00:00.000Z`); time <= Date.parse(`${throughDay}T00:00:00.000Z`); time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    const prepared = await prepareDay(day, localDays.get(day) ?? [], revision);
    const candidate = await registerTelemetryV12DayManifest(source(), principal, prepared.manifest);
    for (const chunk of prepared.chunks) {
      const device = await authenticateDevice(source(), principal.authorization);
      const envelopeDigest = await sha256Hex(`synthetic-v12-first-sync-${crypto.randomUUID()}`);
      const upload = await createDeviceUploadAuthorization(source(), device, envelopeDigest, 4096);
      const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${upload.uploadAuthorization}`,
        { envelopeDigest, bodyBytes: 4096, contentType: "application/json" });
      await persistTelemetryV12StagedChunk(source(), principal, chunk, { chunkRowId: `chunk:${crypto.randomUUID()}`,
        r2Key: `synthetic/v12-first-sync/${crypto.randomUUID()}`, envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId });
    }
    vector.push({ day, manifestId: candidate.manifestId, manifestDigest: prepared.manifest.manifestDigest });
  }
  const renewed = await createTelemetryV12DomainPredecessor(source(), principal);
  // The client's own revision_conflict guard.
  expect(renewed.previousGenerationId).toBe(before.previousGenerationId);
  expect(renewed.legacyFingerprint).toBe(before.legacyFingerprint);
  expect(renewed.fromDay >= fromDay && renewed.throughDay <= throughDay).toBe(true);
  const domain = { schemaVersion: "telemetry-domain-manifest-v1.2" as const, fromDay, throughDay,
    predecessor: { token: renewed.token, previousGenerationId: renewed.previousGenerationId,
      legacyFingerprint: renewed.legacyFingerprint }, days: vector, manifestDigest: "0".repeat(64) };
  domain.manifestDigest = await sha256Hex(telemetryV12DomainManifestDigestInput(domain));
  return activateTelemetryV12Domain(source(), principal, domain);
}

describe("first and later v1.2 syncs from the shipped client sequence", () => {
  it("starts a device with no v1.2 history, crosses an idle day and appends later", async () => {
    const device = await accountlessV12Device();
    const local = new Map([[dayOffset(2), [usageOn(dayOffset(2), 1), usageOn(dayOffset(2), 2)]],
      [dayOffset(0), [usageOn(dayOffset(0), 3)]]]);
    const first = await clientPass(device, local);
    expect(first).toMatchObject({ fromDay: dayOffset(2), throughDay: dayOffset(0), replay: false });
    local.set(dayOffset(0), [usageOn(dayOffset(0), 3), usageOn(dayOffset(0), 4)]);
    const second = await clientPass(device, local, 2);
    expect(second).toMatchObject({ fromDay: dayOffset(2), throughDay: dayOffset(0), replay: false });
    expect(await source().prepare("SELECT revision FROM telemetry_v12_domain_heads WHERE participant_id=?")
      .bind(device.participantId).first("revision")).toBe(2);
  });
});
