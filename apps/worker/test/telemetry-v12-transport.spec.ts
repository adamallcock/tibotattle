import { env, applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalTelemetryV11Json,
  canonicalTelemetryV12Json,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV11DomainManifestDigestInput,
  telemetryV12RequiredConsent,
  telemetryV11RequiredConsent,
  type TelemetryV12Chunk,
  type TelemetryV12DayManifest,
  type TelemetryV12UsageEvent,
  type TelemetryV11DomainManifest,
} from "@app-usagemonitor/telemetry-contract";
import {
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
  enrollAccountlessDevice,
  parseAccountlessEnrollmentRequest,
} from "../src/accountless-enrollment";
import {
  ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  createAccountlessUploadOwner,
  parseAccountlessOwnershipRequest,
} from "../src/accountless-ownership";
import { handleRequest } from "../src/index";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import {
  assertTelemetryTransportWriteAllowed,
  ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
  ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
  ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
  grantTelemetryV12AccountlessAuthorization,
  parseTelemetryV12AccountlessAuthorizationRequest,
  grantTelemetryV11Consent,
  grantTelemetryV12Consent,
  telemetryTransportCapabilities,
  telemetryTransportV12Capabilities,
} from "../src/telemetry-transport-policy";
import {
  readTelemetryV12DayCandidates,
  persistTelemetryV12StagedChunk,
  registerTelemetryV12DayManifest,
  telemetryV12ChunkCount,
  telemetryV12ChunkR2KeyPage,
} from "../src/telemetry-v12-repository";
import { registerTelemetryV11DayManifest, telemetryV11LegacyProjection } from "../src/telemetry-v11-repository";
import { decodeTelemetryV12Record, type TelemetryV12TypedRecordRow } from "../src/telemetry-v12-typed-codec";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { activateTelemetryV12Domain, createTelemetryV12DomainPredecessor } from "../src/telemetry-v12-domain";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { initializeTypedV1Admission, insertTypedTelemetryV1Chunk } from "../src/typed-v1-admission";
import { parseTelemetryV1Chunk } from "../src/telemetry-v1";
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
}
const bindings = () => env as TestBindings;
const db = () => bindings().USAGE_MONITOR_DB;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings().TEST_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_INGESTION_ISOLATION_MIGRATIONS);
});

describe("staged v1.2 successor transport", () => {
  it("advertises a separate staged capability without changing the frozen legacy dictionary", async () => {
    const fixture = await createV11DeviceFixture(db());
    const capabilities = await telemetryTransportV12Capabilities(db(), fixture, "https://example.test");
    expect(capabilities).toMatchObject({
      schemaVersion: "device-sync-capabilities-v1.2",
      identityVersion: "account-track-v2",
      successor: {
        schemaVersion: "telemetry-contribution-v1.2",
        envelopeSchemaVersion: "telemetry-envelope-v1.2",
        lifecycle: "staged",
        consentCurrent: false,
        authorizationCurrent: false,
        activationTime: null,
      },
    });
    const legacy = await db().prepare(
      "SELECT count(*) AS total FROM telemetry_transport_formats",
    ).first<{ total: number }>();
    expect(legacy?.total).toBe(4);
  });

  it("requires exact successor activation and records the device consent instant", async () => {
    const fixture = await createV11DeviceFixture(db());
    await db().prepare(
      "UPDATE telemetry_v12_runtime SET state = 'active', changed_at = ? WHERE id = 1",
    ).bind("2026-09-21T12:00:00.000Z").run();
    await expect(grantTelemetryV12Consent(db(), fixture, telemetryV12RequiredConsent(), Date.parse("2026-09-21T12:00:01.000Z")))
      .resolves.toMatchObject({ schemaVersion: "telemetry-contribution-v1.2" });
    const capabilities = await telemetryTransportV12Capabilities(db(), fixture, "https://example.test");
    expect(capabilities.successor).toMatchObject({
      lifecycle: "accepted",
      consentCurrent: true,
      authorizationCurrent: true,
      activationTime: "2026-09-21T12:00:01.000Z",
    });
  });

  it("keeps a valid v1 device admitted when v1.1 consent is granted on another device", async () => {
    const first = await createV11DeviceFixture(db());
    const second = await createV11DeviceFixture(db(), { participantId: first.participantId });
    await db().prepare(
      "UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = 'telemetry-contribution-v1.1'",
    ).run();
    await grantTelemetryV11Consent(db(), first, telemetryV11RequiredConsent());
    const firstCapabilities = await telemetryTransportCapabilities(db(), first, "https://example.test");
    const secondCapabilities = await telemetryTransportCapabilities(db(), second, "https://example.test");
    expect(firstCapabilities.minimumWriteRank).toBe(11);
    expect(secondCapabilities.minimumWriteRank).toBeLessThan(11);
    await expect(assertTelemetryTransportWriteAllowed(
      db(), second, "telemetry-contribution-v1.0",
    )).resolves.toBeUndefined();
    await expect(assertTelemetryTransportWriteAllowed(
      db(), second, "telemetry-contribution-v1.1",
    )).rejects.toMatchObject({ code: "TELEMETRY_CONSENT_INVALID" });
  });

  it("enforces the per-device floor in the real typed v1 insert path", async () => {
    const first = await createV11DeviceFixture(db());
    const second = await createV11DeviceFixture(db(), { participantId: first.participantId });
    await db().prepare(
      "UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = 'telemetry-contribution-v1.1'",
    ).run();
    const sourceNamespace = "synthetic-v12-device-floor-v1";
    await initializeStorageSource(db(), sourceNamespace);
    await initializeTypedV1Admission(db(), sourceNamespace);

    const makeInsert = async (
      fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>,
      fill: string,
    ) => {
      const projected = telemetryV11LegacyProjection("usage", v11UsageRecord(
        "2026-09-20", fill,
      ));
      if (!projected) throw new Error("synthetic v1 projection missing");
      const record = JSON.parse(projected.canonicalRecord) as Record<string, unknown>;
      const envelopeDigest = await sha256Hex(`synthetic-v12-floor-v1:${fill}`);
      const principal = await authenticateDevice(db(), fixture.authorization);
      const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
      const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
        envelopeDigest, bodyBytes: 200, contentType: "application/json",
      });
      const chunk = parseTelemetryV1Chunk({
        schemaVersion: "telemetry-contribution-v1.0",
        chunkId: "usage:2026-09-20:0",
        chunkRevision: 1,
        chunkDigest: await sha256Hex(canonicalTelemetryV11Json([record])),
        parserVersion: "synthetic-v12-floor-v1",
        consent: {
          telemetrySchemaVersion: "telemetry-contribution-v1.0",
          fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
          privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
        },
        records: [record],
      });
      return {
        chunkRowId: `chunk:${crypto.randomUUID()}`,
        participantId: fixture.participantId,
        deviceId: fixture.deviceId,
        chunk,
        envelopeDigest,
        r2Key: `synthetic/v12-floor-v1-${crypto.randomUUID()}`,
        deviceUploadAuthorizationId: claimed.authorizationId,
        createdAt: new Date().toISOString(),
        supersedes: null,
      };
    };

    // Mint both upload authorizations before the first device opts into v1.1.
    // The legacy v1 path therefore has to enforce the final device floor at
    // its storage boundary, rather than trusting an earlier route decision.
    const firstInsert = await makeInsert(first, "b");
    const secondInsert = await makeInsert(second, "c");
    await grantTelemetryV11Consent(db(), first, telemetryV11RequiredConsent());
    expect(await db().prepare(
      "SELECT minimum_rank FROM telemetry_transport_device_floors WHERE participant_id = ? AND device_id = ?",
    ).bind(first.participantId, first.deviceId).first<number>("minimum_rank")).toBe(11);
    expect(await db().prepare(
      "SELECT minimum_rank FROM telemetry_transport_device_floors WHERE participant_id = ? AND device_id = ?",
    ).bind(second.participantId, second.deviceId).first<number>("minimum_rank")).toBeLessThan(11);

    await expect(insertTypedTelemetryV1Chunk(db(), firstInsert, sourceNamespace))
      .rejects.toThrow("telemetry_transport_blocked");
    await expect(insertTypedTelemetryV1Chunk(db(), secondInsert, sourceNamespace))
      .resolves.toMatchObject({ acceptedRecords: 1, replay: false });
    expect(await db().prepare(
      "SELECT count(*) AS total FROM telemetry_v1_chunks WHERE participant_id = ?",
    ).bind(first.participantId).first<number>("total")).toBe(1);
  });

  it("requires a separate accountless v1.2 grant and admits that device only", async () => {
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
    const input = new Uint8Array(prefix.length + secret.length);
    input.set(prefix);
    input.set(secret, prefix.length);
    const secretHash = await sha256Hex(input);
    input.fill(0);
    const authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
    const nowEpoch = Date.now();
    await enrollAccountlessDevice(db(), parseAccountlessEnrollmentRequest({
      schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
      deviceId,
      deviceSecretHash: secretHash,
      policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
      authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    }), nowEpoch);
    await createAccountlessUploadOwner(db(), authorization, parseAccountlessOwnershipRequest({
      schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
      policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
      authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
      telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
    }), nowEpoch);
    const owner = await db().prepare(
      "SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id = ?",
    ).bind(deviceId).first<{ participant_id: string }>();
    expect(owner?.participant_id).toMatch(/^participant:/u);
    await db().prepare("UPDATE telemetry_v12_runtime SET state = 'active' WHERE id = 1").run();
    const request = parseTelemetryV12AccountlessAuthorizationRequest({
      schemaVersion: ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
      policyVersion: ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
      authorizationBasis: ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
      telemetrySchemaVersion: "telemetry-contribution-v1.2",
    });
    await grantTelemetryV12AccountlessAuthorization(db(), {
      participantId: owner!.participant_id,
      deviceId,
    }, request, nowEpoch);
    const capabilities = await telemetryTransportV12Capabilities(
      db(), { participantId: owner!.participant_id, deviceId }, "https://example.test",
    );
    expect(capabilities).toMatchObject({
      authorityKind: "accountless",
      successor: { lifecycle: "accepted", consentCurrent: false, authorizationCurrent: true },
    });
    await expect(assertTelemetryTransportWriteAllowed(
      db(), { participantId: owner!.participant_id, deviceId }, "telemetry-contribution-v1.2",
    )).resolves.toBeUndefined();
    await expect(db().prepare(
      "SELECT count(*) AS total FROM telemetry_v12_device_capabilities WHERE participant_id = ?",
    ).bind(owner!.participant_id).first<{ total: number }>("total")).resolves.toBe(0);
    secret.fill(0);
  });

  it("stages a v1.2 day manifest only after the independent device grant", async () => {
    const fixture = await createV11DeviceFixture(db());
    await db().prepare("UPDATE telemetry_v12_runtime SET state = 'active' WHERE id = 1").run();
    await grantTelemetryV12Consent(db(), fixture, telemetryV12RequiredConsent(), Date.parse("2026-09-21T12:00:01.000Z"));
    const manifest: TelemetryV12DayManifest = {
      schemaVersion: "telemetry-day-manifest-v1.2",
      day: "2026-09-20",
      parserVersion: "test-v12",
      consent: telemetryV12RequiredConsent(),
      chunks: [{ chunkId: "usage:2026-09-20:0", chunkDigest: "a".repeat(64), recordCount: 1 }],
      excluded: { quota: 0, session: 0, usage: 0 },
      manifestDigest: "0".repeat(64),
    };
    manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
    const candidate = await registerTelemetryV12DayManifest(db(), fixture, manifest);
    expect(candidate).toMatchObject({ day: "2026-09-20", state: "staged", expectedChunks: 1 });
    expect((await readTelemetryV12DayCandidates(db(), fixture, {
      fromDay: "2026-09-20", toDay: "2026-09-20",
    })).candidates).toHaveLength(1);
    expect(canonicalTelemetryV12Json(manifest)).toContain("telemetry-day-manifest-v1.2");
  });

  it("stores admitted records as typed rows without a per-event JSON copy", async () => {
    const fixture = await createV11DeviceFixture(db());
    await db().prepare("UPDATE telemetry_v12_runtime SET state = 'active' WHERE id = 1").run();
    await grantTelemetryV12Consent(db(), fixture, telemetryV12RequiredConsent());
    const record: TelemetryV12UsageEvent = {
      schemaVersion: "usage-event-v1.2", eventId: `event:v2:${"1".repeat(64)}`,
      eventTime: "2026-09-20T12:05:00.000Z", sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
      provider: "openai_codex", modelId: "gpt-5.6-sol", speedMode: "standard", apiServiceTier: "default",
      surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription",
      reasoningEffort: "high", agentScope: "root", outcome: "completed", totalInputContextTokens: 1000,
      components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
        outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null },
      accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
        planBasis: "same_source_occurrence", planType: "pro", planEraId: null },
      boundaryFlags: null, tieOrder: null, cacheWriteTtl: null,
    };
    const chunk: TelemetryV12Chunk = {
      schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
      chunkId: "usage:2026-09-20:0", chunkRevision: 1, parserVersion: "test-v12",
      consent: telemetryV12RequiredConsent(), records: [record],
      chunkDigest: await sha256Hex(canonicalTelemetryV12Json([record])),
    };
    const manifest: TelemetryV12DayManifest = {
      schemaVersion: "telemetry-day-manifest-v1.2", day: "2026-09-20", parserVersion: "test-v12",
      consent: telemetryV12RequiredConsent(), chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: 1 }],
      excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64),
    };
    manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
    chunk.manifestDigest = manifest.manifestDigest;
    await registerTelemetryV12DayManifest(db(), fixture, manifest);
    const principal = await authenticateDevice(db(), fixture.authorization);
    const envelopeDigest = await sha256Hex("synthetic-v12-envelope");
    const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 22);
    const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest, bodyBytes: 22, contentType: "application/json" });
    await expect(persistTelemetryV12StagedChunk(db(), fixture, chunk, {
      chunkRowId: `chunk:${crypto.randomUUID()}`, r2Key: `synthetic/${crypto.randomUUID()}`,
      envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId,
    })).resolves.toMatchObject({ replay: false, chunkId: chunk.chunkId });
    const columns = await db().prepare("PRAGMA table_info(telemetry_v12_records)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).not.toContain("record_json");
    expect(await db().prepare("SELECT count(*) AS total FROM telemetry_v12_usage").first<{ total: number }>("total")).toBe(1);
    const typedChunk = await db().prepare("SELECT id FROM telemetry_v12_chunks WHERE chunk_id = ?")
      .bind(chunk.chunkId).first<string>("id");
    const typedRow = await db().prepare(
      `SELECT r.stream, r.occurrence_id, r.observed_at_ms, r.observed_day,
              provider.value AS provider, r.canonical_digest,
              u.session_id, model.value AS model, speed.value AS speed_mode,
              tier.value AS api_service_tier, surface.value AS surface,
              billing.value AS billing_surface, effort.value AS reasoning_effort,
              scope.value AS agent_scope, outcome.value AS outcome,
              u.total_input_context_tokens, u.input_uncached_tokens,
              u.input_cache_read_tokens, u.input_cache_write_tokens,
              u.output_text_tokens, u.output_reasoning_tokens, u.output_combined_tokens,
              u.boundary_flags, u.tie_order,
              u.cache_write_ttl_five_minute_tokens, u.cache_write_ttl_one_hour_tokens,
              a.account_basis, a.account_track, a.plan_basis,
              plan.value AS attribution_plan_type, a.plan_era
         FROM telemetry_v12_records r
         JOIN typed_telemetry_dictionary provider ON provider.id = r.provider_id
         JOIN telemetry_v12_usage u ON u.record_id = r.id
         JOIN typed_telemetry_dictionary model ON model.id = u.model_id
         JOIN typed_telemetry_dictionary speed ON speed.id = u.speed_mode_id
         JOIN typed_telemetry_dictionary tier ON tier.id = u.api_service_tier_id
         JOIN typed_telemetry_dictionary surface ON surface.id = u.surface_id
         JOIN typed_telemetry_dictionary billing ON billing.id = u.billing_surface_id
         JOIN typed_telemetry_dictionary effort ON effort.id = u.reasoning_effort_id
         JOIN typed_telemetry_dictionary scope ON scope.id = u.agent_scope_id
         JOIN typed_telemetry_dictionary outcome ON outcome.id = u.outcome_id
         JOIN telemetry_v12_attributions a ON a.id = u.attribution_id
         JOIN typed_telemetry_dictionary plan ON plan.id = a.plan_type_id
        WHERE r.chunk_id = ? AND r.record_index = 0`,
    ).bind(typedChunk ?? "").first<TelemetryV12TypedRecordRow>();
    expect(typedRow).toBeTruthy();
    const decoded = decodeTelemetryV12Record(typedRow!);
    expect(decoded.usage?.model).toBe(record.modelId);
    expect(decoded.canonicalRecord).toBe(canonicalTelemetryV12Json(record));
    expect(await db().prepare("SELECT state FROM telemetry_v12_day_manifests WHERE manifest_digest = ?")
      .bind(manifest.manifestDigest).first<string>("state")).toBe("ready");
    expect(await telemetryV12ChunkCount(db(), fixture.participantId)).toBe(1);
    const r2Page = await telemetryV12ChunkR2KeyPage(db(), fixture.participantId, null, 1);
    expect(r2Page.rows).toHaveLength(1);
    expect(r2Page.rows[0]?.r2Key).toMatch(/^synthetic\//u);

    // The successor closes beside an existing typed v1.1 head. Initialize
    // both typed legacy allocators through the normal source gate; this is
    // deliberately a typed fixture, never a raw JSON compatibility bypass.
    const sourceNamespace = "synthetic-v12-mixed-source";
    await initializeStorageSource(db(), "synthetic-v12-mixed-source-id");
    await initializeTypedV1Admission(db(), sourceNamespace);
    await initializeTypedV11Admission(db(), sourceNamespace);
    await db().prepare(
      "UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = 'telemetry-contribution-v1.1'",
    ).run();
    await grantTelemetryV11Consent(db(), fixture, telemetryV11RequiredConsent());
    const v11Prepared = await makeV11Day(manifest.day, { usage: [v11UsageRecord(manifest.day)] });
    await registerTelemetryV11DayManifest(db(), fixture, v11Prepared.manifest);
    const v11Chunk = v11Prepared.chunks[0]!;
    const v11EnvelopeDigest = await sha256Hex(`synthetic-v11-envelope:${crypto.randomUUID()}`);
    const v11Principal = await authenticateDevice(db(), fixture.authorization);
    const v11Upload = await createDeviceUploadAuthorization(db(), v11Principal, v11EnvelopeDigest, 200);
    const v11Claimed = await claimDeviceUploadAuthorization(db(), `Upload ${v11Upload.uploadAuthorization}`,
      { envelopeDigest: v11EnvelopeDigest, bodyBytes: 200, contentType: "application/json" });
    const v11Day = await persistTypedV11StagedChunk(db(), fixture, v11Chunk, {
      sourceNamespace,
      chunkRowId: `chunk:${crypto.randomUUID()}`,
      r2Key: `synthetic/v11-${crypto.randomUUID()}`,
      envelopeDigest: v11EnvelopeDigest,
      deviceUploadAuthorizationId: v11Claimed.authorizationId,
    });
    await registerTelemetryV11DayManifest(db(), fixture, v11Prepared.manifest);
    const v11Days = [{
      day: v11Prepared.manifest.day,
      manifestId: v11Day.manifestId,
      manifestDigest: v11Prepared.manifest.manifestDigest,
    }];
    // Capture one synthetic clock instant for the whole closure. A long full
    // Worker suite can cross UTC midnight between these calls; using separate
    // wall-clock reads would then create a manifest whose range is older than
    // the predecessor snapshot and produce a false conflict.
    const domainNowEpoch = Date.now();
    const v11Today = new Date(domainNowEpoch).toISOString().slice(0, 10);
    for (let cursor = Date.parse(`${manifest.day}T00:00:00.000Z`) + 86_400_000;
      cursor <= Date.parse(`${v11Today}T00:00:00.000Z`); cursor += 86_400_000) {
      const empty = await makeV11Day(new Date(cursor).toISOString().slice(0, 10), {});
      const emptyDay = await registerTelemetryV11DayManifest(db(), fixture, empty.manifest);
      v11Days.push({ day: empty.manifest.day, manifestId: emptyDay.manifestId,
        manifestDigest: empty.manifest.manifestDigest });
    }
    const v11Prior = await createTelemetryV11DomainPredecessor(db(), fixture, domainNowEpoch);
    const v11Domain: TelemetryV11DomainManifest = {
      schemaVersion: "telemetry-domain-manifest-v1.1",
      fromDay: v11Prepared.manifest.day,
      throughDay: v11Today,
      predecessor: {
        token: v11Prior.token,
        previousGenerationId: v11Prior.previousGenerationId,
        legacyFingerprint: v11Prior.legacyFingerprint,
      },
      days: v11Days,
      manifestDigest: "0".repeat(64),
    };
    v11Domain.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(v11Domain));
    const v11Activation = await activateTelemetryV11Domain(db(), fixture, v11Domain, domainNowEpoch);
    expect(v11Activation.replay).toBe(false);

    const v12Prior = await createTelemetryV12DomainPredecessor(db(), fixture, domainNowEpoch);
    const v12ManifestId = await db().prepare(
      "SELECT id FROM telemetry_v12_day_manifests WHERE manifest_digest = ?",
    ).bind(manifest.manifestDigest).first<string>("id");
    const v12Domain = {
      schemaVersion: "telemetry-domain-manifest-v1.2" as const,
      fromDay: manifest.day,
      throughDay: manifest.day,
      predecessor: {
        token: v12Prior.token,
        previousGenerationId: v12Prior.previousGenerationId,
        legacyFingerprint: v12Prior.legacyFingerprint,
      },
      days: [{ day: manifest.day, manifestId: v12ManifestId!, manifestDigest: manifest.manifestDigest }],
      manifestDigest: "0".repeat(64),
    };
    v12Domain.manifestDigest = await sha256Hex(telemetryV12DomainManifestDigestInput(v12Domain));
    const v12Activation = await activateTelemetryV12Domain(db(), fixture, v12Domain, domainNowEpoch);
    expect(v12Activation.replay).toBe(false);
    expect(await db().prepare("SELECT generation_id FROM telemetry_v11_domain_heads WHERE participant_id = ?")
      .bind(fixture.participantId).first<string>("generation_id")).toBe(v11Activation.generationId);
    expect(await db().prepare("SELECT generation_id FROM telemetry_v12_domain_heads WHERE participant_id = ?")
      .bind(fixture.participantId).first<string>("generation_id")).toBe(v12Activation.generationId);

  });
});


it('offers the successor only on the typed deployment whose independent analytics can read it',async()=>{
 await applyD1Migrations(bindings().DELETION_LEDGER,bindings().TEST_DELETION_LEDGER_MIGRATIONS);
 const fixture=await createV11DeviceFixture(db());
 const settings:Env={...bindings(),ENVIRONMENT:'synthetic-development',ACCOUNT_SCOPED_INGEST_MODE:'disabled'};
 const request=()=>new Request('https://example.test/api/v1/device/sync-capabilities-v1.2',{
   headers:{authorization:fixture.authorization},
 });
 expect((await handleRequest(request(),settings)).status).toBe(503);
 const namespace='synthetic-v12-route-storage';
 Reflect.set(settings,'TELEMETRY_STORAGE_MODE','typed');
 Reflect.set(settings,'TELEMETRY_STORAGE_NAMESPACE',namespace);
 expect((await handleRequest(request(),settings)).status).toBe(503);
 await initializeStorageSource(db(),'synthetic-v12-route-source');
 await initializeTypedV1Admission(db(),namespace);
 await initializeTypedV11Admission(db(),namespace);
 const ready=await handleRequest(request(),settings);
 expect(ready.status).toBe(200);
 expect(await ready.json()).toMatchObject({schemaVersion:'device-sync-capabilities-v1.2',successor:{lifecycle:'staged'}});
 Reflect.set(settings,'TELEMETRY_STORAGE_NAMESPACE','synthetic-wrong-namespace');
 expect((await handleRequest(request(),settings)).status).toBe(503);
});
