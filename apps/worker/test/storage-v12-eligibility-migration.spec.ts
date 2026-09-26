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
import { advanceStorageCommunityDaily, readPublishedStorageCommunityDaily } from "../src/storage-community-daily";
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
const BRIDGE = "0011_v12_public_eligibility.sql";
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
  // The deployed predecessor: every isolation migration before the bridge.
  await applyD1Migrations(source(), b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter((migration) => migration.name < BRIDGE));
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

/** Upload one complete v1.2 day and activate a domain that carries it. */
async function uploadV12Day(principal: Principal, eventNumbers: readonly number[], revision = 1): Promise<void> {
  const day = today(), consent = telemetryV12RequiredConsent(), parserVersion = `synthetic-v12-daily-${revision}`;
  const records = eventNumbers.map(usageRecord);
  const chunk: TelemetryV12Chunk = { schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
    chunkId: `usage:${day}:0`, chunkRevision: 1, parserVersion, consent, records: [...records],
    chunkDigest: await sha256Hex(canonicalTelemetryV12Json(records)) };
  const manifest: TelemetryV12DayManifest = { schemaVersion: "telemetry-day-manifest-v1.2", day, parserVersion, consent,
    chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: records.length }],
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  const registered = await registerTelemetryV12DayManifest(source(), principal, manifest);
  chunk.manifestDigest = manifest.manifestDigest;
  const device = await authenticateDevice(source(), principal.authorization);
  const envelopeDigest = await sha256Hex(`synthetic-v12-daily-${crypto.randomUUID()}`);
  const upload = await createDeviceUploadAuthorization(source(), device, envelopeDigest, 4096);
  const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${upload.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 4096, contentType: "application/json" });
  await persistTelemetryV12StagedChunk(source(), principal, chunk, { chunkRowId: `chunk:${crypto.randomUUID()}`,
    r2Key: `synthetic/v12-daily/${crypto.randomUUID()}`, envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId });
  const predecessor = await createTelemetryV12DomainPredecessor(source(), principal);
  const domain = { schemaVersion: "telemetry-domain-manifest-v1.2" as const, fromDay: day, throughDay: day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: [{ day, manifestId: registered.manifestId, manifestDigest: manifest.manifestDigest }], manifestDigest: "0".repeat(64) };
  domain.manifestDigest = await sha256Hex(telemetryV12DomainManifestDigestInput(domain));
  await activateTelemetryV12Domain(source(), principal, domain);
}

async function deliverAndPublish(): Promise<void> {
  for (let n = 0; n < 64; n++) if ((await drainCommunityPublicSourceBootstrap(source())).completed) break;
  for (let n = 0; n < 256; n++) {
    if ((await advanceStorageAnalytics(options())).state === "idle") break;
  }
  for (let n = 0; n < 16; n++) {
    const result = await advanceStorageCommunityDaily(options());
    if (result.state === "published" || result.state === "unchanged") return;
  }
}

async function publishedTotals(): Promise<{ contributingParticipants: number; usageEvents: number } | null> {
  const rows = (await readPublishedStorageCommunityDaily({ ...options(), fromDay: today(), throughDay: today() })).rows;
  return rows.length === 0 ? null : JSON.parse(rows.at(-1)!.payload_json).totals;
}

describe("isolation 0011 v1.2 public eligibility bridge", () => {
  it("bridges v1.2 heads accepted before the migration exactly once", async () => {
    const accountless = await accountlessV12Device();
    await uploadV12Day(accountless, [1, 2]);
    const social = await createV11DeviceFixture(source());
    await grantTelemetryV12Consent(source(), social, telemetryV12RequiredConsent());
    await uploadV12Day(social, [3]);
    // Before the bridge the accountless device is not public, and the social
    // owner has no analytics identity at all.
    expect(await source().prepare(`SELECT count(*) AS n FROM community_public_source_owners
      WHERE participant_id=?`).bind(accountless.participantId).first("n")).toBe(0);
    expect(await source().prepare("SELECT count(*) AS n FROM storage_v11_owner_links WHERE participant_id IN (?,?)")
      .bind(accountless.participantId, social.participantId).first("n")).toBe(0);

    await applyD1Migrations(source(), b.TEST_INGESTION_ISOLATION_MIGRATIONS);
    expect(await source().prepare("SELECT count(*) AS n FROM storage_v12_event_sources").first("n")).toBe(2);
    await deliverAndPublish();
    expect(await publishedTotals()).toMatchObject({ contributingParticipants: 2, usageEvents: 3 });

    // Re-requesting an already bridged head journals nothing new.
    const journal = async () => await source().prepare("SELECT count(*) AS n FROM storage_ingestion_changes").first<number>("n");
    const before = await journal();
    await source().prepare(`INSERT INTO storage_v12_head_requests(participant_id,generation_id,head_revision)
      SELECT participant_id,generation_id,revision FROM telemetry_v12_domain_heads WHERE participant_id=?`)
      .bind(accountless.participantId).run();
    expect(await journal()).toBe(before);
    expect(await source().prepare("SELECT count(*) AS n FROM storage_v12_event_sources").first("n")).toBe(2);
  });

  it("keeps the pre-bridge analytics journal on its existing formats", async () => {
    const social = await createV11DeviceFixture(source());
    await grantTelemetryV12Consent(source(), social, telemetryV12RequiredConsent());
    await uploadV12Day(social, [1]);
    // No v1.2 bridge exists yet: delivery stays idle and nothing is published.
    for (let n = 0; n < 8; n++) if ((await advanceStorageAnalytics(options())).state === "idle") break;
    expect(await source().prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='storage_v12_event_sources'").first("n")).toBe(0);
  });
});
