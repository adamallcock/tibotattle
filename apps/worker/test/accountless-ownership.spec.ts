import { env, applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalTelemetryV11Json,
  telemetryV11DomainManifestDigestInput,
  type TelemetryV11Envelope,
  type TelemetryV11QuotaObservation,
} from "@app-usagemonitor/telemetry-contract";

import {
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
} from "../src/accountless-enrollment";
import {
  ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
} from "../src/accountless-ownership";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import { eraseParticipantAsOwner } from "../src/participant-erasure";
import { accountScopedModelCompositionV11, accountScopedQuotaAnalysisV11 } from "../src/quota-analysis-v11";
import { collectCommunityAllowanceFits, publishCommunityAnalysisCaches } from "../src/community-allowance";
import { advanceCommunityPublication } from "../src/community-publication";
import { loadV11SourcePin } from "../src/telemetry-v11-domain";
import { makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

const ORIGIN = "https://example.test";
const DAY_MILLISECONDS = 86_400_000;
const PUBLIC_FIXTURE_AT = "2026-09-01T12:00:00.000Z";
let publicJwk: JsonWebKey;
let publicJwkJson = "";
let privateJwkJson = "";
const keyId = "key:accountless-e2e";

function bindings(): TestBindings {
  return env as TestBindings;
}

function db(): D1Database {
  return bindings().USAGE_MONITOR_DB;
}

function runtime(overrides: Record<string, unknown> = {}): Env {
  return {
    ...bindings(),
    ENVIRONMENT: "synthetic-development",
    ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    ENVELOPE_PUBLIC_JWK: publicJwkJson,
    ENVELOPE_PRIVATE_JWK: privateJwkJson,
    ...overrides,
  } as unknown as Env;
}

async function api(
  path: string,
  init: RequestInit = {},
  runtimeEnv = runtime(),
): Promise<Response> {
  const headers = new Headers(init.headers);
  if ((init.method ?? "GET").toUpperCase() !== "GET" && !headers.has("origin")) {
    headers.set("origin", ORIGIN);
  }
  return handleRequest(new Request(`${ORIGIN}${path}`, { ...init, headers }), runtimeEnv);
}

async function errorCode(response: Response): Promise<string> {
  const body = await response.json() as { error?: { code?: string } };
  return body.error?.code ?? "";
}

async function deviceSecretHash(
  deviceId: string,
  secret: Uint8Array,
): Promise<string> {
  const prefix = new TextEncoder().encode(
    `app-usagemonitor/device/v1\0${deviceId}\0`,
  );
  const input = new Uint8Array(prefix.byteLength + secret.byteLength);
  input.set(prefix);
  input.set(secret, prefix.byteLength);
  try {
    return await sha256Hex(input);
  } finally {
    input.fill(0);
  }
}

async function encrypted(value: unknown): Promise<TelemetryV11Envelope> {
  const rsa = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  if ("privateKey" in key) throw new Error("expected symmetric key");
  const raw = await crypto.subtle.exportKey("raw", key);
  if (!(raw instanceof ArrayBuffer)) throw new Error("expected raw key");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, raw);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(canonicalTelemetryV11Json(value)),
  );
  new Uint8Array(raw).fill(0);
  return {
    schemaVersion: "telemetry-envelope-v1.1",
    synthetic: false,
    keyId,
    wrappedKey: encodeBase64Url(new Uint8Array(wrapped)),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

async function registerDeviceUpload(
  authorization: string,
  rawEnvelope: string,
  schemaVersion = "telemetry-contribution-v1.1",
): Promise<Response> {
  return api("/api/v1/device/upload-authorizations", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      envelopeDigest: await sha256Hex(rawEnvelope),
      contentLengthBytes: new TextEncoder().encode(rawEnvelope).byteLength,
      contentType: "application/json",
      telemetrySchemaVersion: schemaVersion,
    }),
  });
}

async function uploadEncryptedChunk(
  authorization: string,
  chunk: unknown,
): Promise<{ response: Response; rawEnvelope: string; uploadAuthorization: string }> {
  const rawEnvelope = JSON.stringify(await encrypted(chunk));
  const registered = await registerDeviceUpload(authorization, rawEnvelope);
  expect(registered.status, await registered.clone().text()).toBe(201);
  const upload = await registered.json<{ uploadAuthorization: string }>();
  return {
    rawEnvelope,
    uploadAuthorization: upload.uploadAuthorization,
    response: await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${upload.uploadAuthorization}`,
        "content-type": "application/json",
      },
      body: rawEnvelope,
    }),
  };
}

function fullV11Day(day: string): {
  quota: TelemetryV11QuotaObservation[];
  usage: ReturnType<typeof v11UsageRecord>[];
} {
  const start = Date.parse(`${day}T01:00:00.000Z`);
  const resetsAt = new Date(start + 7 * DAY_MILLISECONDS).toISOString();
  const quota: TelemetryV11QuotaObservation[] = [];
  const usage: ReturnType<typeof v11UsageRecord>[] = [];
  for (let point = 0; point < 9; point += 1) {
    const observedAt = new Date(start + point * 5 * 60_000).toISOString();
    quota.push({
      schemaVersion: "quota-observation-v1.1",
      observationId: `quota:accountless:${point}`,
      observedTime: observedAt,
      provider: "openai_codex",
      planType: "pro",
      planVariant: "unknown",
      limitId: "codex",
      slot: "seven_day",
      usedPercent: 10 + point * 5,
      windowDurationMinutes: 10_080,
      resetsAt,
      accountPlanAttribution: {
        accountBasis: "unavailable",
        accountTrackId: null,
        planBasis: "same_source_occurrence",
        planType: "pro",
        planEraId: null,
      },
    });
    if (point < 8) {
      const fill = point.toString(16);
      usage.push(v11UsageRecord(day, fill, {
        eventId: `event:v2:${fill.repeat(64)}`,
        eventTime: new Date(start + point * 5 * 60_000 + 150_000).toISOString(),
        sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
        accountPlanAttribution: {
          accountBasis: "unavailable",
          accountTrackId: null,
          planBasis: "same_source_occurrence",
          planType: "pro",
          planEraId: null,
        },
      }));
    }
  }
  return { quota, usage };
}

interface PublicPublicationSnapshot {
  readonly mutationEpoch: unknown;
  readonly allowanceState: unknown;
  readonly daily: readonly unknown[];
  readonly weekly: readonly unknown[];
  readonly modelDays: readonly unknown[];
  readonly dailyRebuilds: readonly unknown[];
  readonly weeklyRebuilds: readonly unknown[];
  readonly builders: readonly unknown[];
  readonly previewCache: unknown;
  readonly publicationChanges: unknown;
  readonly refreshLanes: readonly unknown[];
  readonly preparationProgress: unknown;
}

async function publicPublicationSnapshot(): Promise<PublicPublicationSnapshot> {
  const [
    mutationEpoch,
    allowanceState,
    daily,
    weekly,
    modelDays,
    dailyRebuilds,
    weeklyRebuilds,
    builders,
    previewCache,
    publicationChanges,
    refreshLanes,
    preparationProgress,
  ] = await Promise.all([
    db().prepare("SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1").first(),
    db().prepare(`SELECT publication_state, expected_basis, safe_from_day, safe_to_day,
      changed_at, attribution_method_version
      FROM community_allowance_publication_state WHERE singleton = 1`).first(),
    db().prepare(`SELECT aggregate_id, day, revision, source_mutation_epoch, release_state,
      payload_json, released_at, withdrawn_at
      FROM community_daily_aggregates ORDER BY day, revision`).all(),
    db().prepare(`SELECT snapshot_id, week_start, revision, source_mutation_epoch,
      release_state, payload_json, sealed_at, withdrawn_at, withdrawal_epoch
      FROM community_weekly_snapshots ORDER BY week_start, revision`).all(),
    db().prepare(`SELECT day, payload_json, computed_at, attribution_method_version,
      source_mutation_epoch FROM community_model_composition_days ORDER BY day`).all(),
    db().prepare("SELECT day, requested_epoch, requested_at FROM community_daily_aggregate_rebuilds ORDER BY day").all(),
    db().prepare(`SELECT week_start, week_end, ingestion_cutoff_at, requested_epoch,
      requested_at FROM community_weekly_snapshot_rebuilds ORDER BY week_start`).all(),
    db().prepare(`SELECT week_start, owner_nonce, mutation_epoch, lease_expires_at,
      created_at FROM community_snapshot_builders ORDER BY week_start`).all(),
    db().prepare(`SELECT singleton, generated_at, payload_json, attribution_method_version,
      source_mutation_epoch FROM admin_community_allowance_preview_cache WHERE singleton = 1`).first(),
    db().prepare("SELECT revision FROM community_publication_changes WHERE singleton = 1").first(),
    db().prepare(`SELECT lane, state, completed_at, restart_reason
      FROM community_refresh_lanes ORDER BY lane`).all(),
    db().prepare(`SELECT tracked_days, complete_days, building_days, retiring_days,
      checkpoint_steps, quota_observations, usage_events, is_exact
      FROM community_preparation_progress_counters WHERE singleton_id = 1`).first(),
  ]);
  return {
    mutationEpoch,
    allowanceState,
    daily: daily.results,
    weekly: weekly.results,
    modelDays: modelDays.results,
    dailyRebuilds: dailyRebuilds.results,
    weeklyRebuilds: weeklyRebuilds.results,
    builders: builders.results,
    previewCache,
    publicationChanges,
    refreshLanes: refreshLanes.results,
    preparationProgress,
  };
}

async function seedPublicPublicationFixture(): Promise<PublicPublicationSnapshot> {
  await db().batch([
    db().prepare(`UPDATE community_snapshot_mutation_control
      SET mutation_epoch = 7 WHERE singleton_id = 1`),
    db().prepare(`UPDATE community_allowance_publication_state
      SET publication_state = 'ready', expected_basis = 'public-fixture',
          safe_from_day = '2026-08-01', safe_to_day = '2026-09-01',
          changed_at = ?, attribution_method_version = 'public-fixture-v1'
      WHERE singleton = 1`).bind(PUBLIC_FIXTURE_AT),
    db().prepare(`INSERT INTO admin_community_allowance_preview_cache (
      singleton, generated_at, payload_json, attribution_method_version,
      source_mutation_epoch
    ) VALUES (1, ?, '{"fixture":true}', 'public-fixture-v1', 7)`).bind(PUBLIC_FIXTURE_AT),
    db().prepare(`INSERT INTO community_daily_aggregates (
      aggregate_id, day, revision, source_mutation_epoch, policy_version,
      payload_json, payload_sha256, release_state, released_at
    ) VALUES ('public-daily-fixture', '2026-09-01', 1, 7,
      'community-daily-v1.0', '{"fixture":true}', ?, 'published', ?)`)
      .bind("0".repeat(64), PUBLIC_FIXTURE_AT),
    db().prepare(`INSERT INTO community_weekly_snapshots (
      snapshot_id, week_start, week_end, revision, source_mutation_epoch,
      ingestion_cutoff_at, released_at, policy_version, payload_json,
      payload_sha256, release_state, sealed_at
    ) VALUES ('public-weekly-fixture', '2026-08-31T00:00:00.000Z',
      '2026-09-07T00:00:00.000Z', 1, 7, ?, ?, 'community-weekly-v0.1',
      '{"fixture":true}', ?, 'published', ?)`)
      .bind(PUBLIC_FIXTURE_AT, PUBLIC_FIXTURE_AT, "1".repeat(64), PUBLIC_FIXTURE_AT),
    db().prepare(`INSERT INTO community_model_composition_days (
      day, payload_json, computed_at, attribution_method_version,
      source_mutation_epoch
    ) VALUES ('2026-09-01', '{"fixture":true}', ?, 'public-fixture-v1', 7)`)
      .bind(PUBLIC_FIXTURE_AT),
    db().prepare(`INSERT INTO community_snapshot_builders (
      week_start, owner_nonce, mutation_epoch, lease_expires_at, created_at
    ) VALUES ('2026-08-31T00:00:00.000Z', 'public-fixture-owner', 7, ?, ?)`)
      .bind("2026-09-01T13:00:00.000Z", PUBLIC_FIXTURE_AT),
  ]);
  return publicPublicationSnapshot();
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  if (!("publicKey" in pair)) throw new Error("expected RSA key pair");
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (exported instanceof ArrayBuffer) throw new Error("expected public JWK");
  publicJwk = exported;
  publicJwkJson = JSON.stringify({ ...publicJwk, kid: keyId });
  privateJwkJson = JSON.stringify({
    ...await crypto.subtle.exportKey("jwk", pair.privateKey),
    kid: keyId,
  });
});

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings().TEST_MIGRATIONS);
  await applyD1Migrations(
    bindings().DELETION_LEDGER,
    bindings().TEST_DELETION_LEDGER_MIGRATIONS,
  );
  await db().prepare(
    `UPDATE telemetry_transport_formats SET lifecycle = 'accepted'
      WHERE schema_version = 'telemetry-contribution-v1.1'`,
  ).run();
});

describe("accountless owner-to-v1.1 transport", () => {
  it("rejects a credential whose identity differs from its enrollment ledger", async () => {
    const enrollmentDeviceId = crypto.randomUUID();
    const forgedDeviceId = crypto.randomUUID();
    const participantId = `participant:${crypto.randomUUID()}`;
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const now = new Date().toISOString();
    try {
      const enrollment = await api("/api/v1/accountless/enrollment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
          deviceId: enrollmentDeviceId,
          deviceSecretHash: await deviceSecretHash(enrollmentDeviceId, secret),
          policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
          authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
        }),
      });
      expect(enrollment.status, await enrollment.clone().text()).toBe(201);

      await db().prepare(`INSERT INTO participants (
        id, owner_kind, access_token_id, access_token_hash,
        recovery_token_id, recovery_token_hash, state, consent_version,
        consented_at, created_at, deletion_session_id, identity_link_key,
        identity_cooldown_digest
      ) VALUES (?, 'accountless', NULL, NULL, NULL, NULL, 'active', NULL,
        NULL, ?, NULL, NULL, NULL)`).bind(participantId, now).run();

      // The enrollment device ID is the credential ID. Accepting a second ID
      // here would leave an unauthenticatable accountless participant/owner
      // graph and could detach upload acknowledgements from the installation.
      await expect(db().prepare(`INSERT INTO device_credentials (
        id, participant_id, authority_kind, paired_via_pairing_id,
        accountless_enrollment_device_id, secret_hash, state, issued_at,
        expires_at, last_used_at, revoked_at, social_verified_at,
        credential_generation
      ) SELECT ?, ?, 'accountless', NULL, ledger.device_id,
               ledger.device_secret_hash, 'active', ?, ledger.expires_at, ?,
               NULL, NULL, 1
          FROM accountless_enrollment_ledger ledger
         WHERE ledger.device_id = ?`).bind(
        forgedDeviceId,
        participantId,
        now,
        now,
        enrollmentDeviceId,
      ).run()).rejects.toThrow("device authority unavailable");

      expect(await db().prepare("SELECT id FROM device_credentials WHERE id = ?")
        .bind(forgedDeviceId).first()).toBeNull();
      expect(await db().prepare(
        "SELECT enrollment_device_id FROM accountless_upload_owners WHERE participant_id = ?",
      ).bind(participantId).first()).toBeNull();
    } finally {
      await db().prepare("DELETE FROM participants WHERE id = ?")
        .bind(participantId).run();
      secret.fill(0);
    }
  });

  it("creates a direct owner, accepts encrypted usage and quota exactly once, then revokes every active authority", async () => {
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
    const enrollment = {
      schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
      deviceId,
      deviceSecretHash: await deviceSecretHash(deviceId, secret),
      policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
      authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    };
    try {
      const issued = await api("/api/v1/accountless/enrollment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(enrollment),
      });
      expect(issued.status, await issued.clone().text()).toBe(201);
      const ownershipBody = {
        schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
        policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
        authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
        telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
      };
      const owner = await api("/api/v1/accountless/ownership", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(ownershipBody),
      });
      expect(owner.status, await owner.clone().text()).toBe(201);
      expect(await owner.json()).toMatchObject({
        schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
        state: "created",
        deviceId,
        authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
        telemetrySchemaVersion: "telemetry-contribution-v1.1",
      });
      const retryOwner = await api("/api/v1/accountless/ownership", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(ownershipBody),
      });
      expect(retryOwner.status).toBe(200);
      expect(await retryOwner.json()).toMatchObject({ state: "existing", deviceId });

      const ownerGraph = await db().prepare(`
        SELECT p.id, p.owner_kind, p.access_token_id, p.recovery_token_id,
               p.consent_version, p.consented_at, d.authority_kind,
               d.paired_via_pairing_id, d.accountless_enrollment_device_id,
               d.social_verified_at, floors.minimum_rank,
               (SELECT COUNT(*) FROM web_sessions s WHERE s.participant_id = p.id)
                 AS sessions,
               (SELECT COUNT(*) FROM device_pairings pair WHERE pair.participant_id = p.id)
                 AS pairings,
               (SELECT COUNT(*) FROM telemetry_v11_device_consents consent
                 WHERE consent.participant_id = p.id) AS social_v11_consents,
               (SELECT COUNT(*) FROM accountless_v11_device_authorizations grant_row
                 WHERE grant_row.participant_id = p.id AND grant_row.state = 'active')
                 AS accountless_v11_authorizations
          FROM participants p
          JOIN device_credentials d ON d.participant_id = p.id
          JOIN telemetry_transport_participant_floors floors ON floors.participant_id = p.id
         WHERE d.id = ?
      `).bind(deviceId).first<{
        id: string;
        owner_kind: string;
        access_token_id: string | null;
        recovery_token_id: string | null;
        consent_version: string | null;
        consented_at: string | null;
        authority_kind: string;
        paired_via_pairing_id: string | null;
        accountless_enrollment_device_id: string | null;
        social_verified_at: string | null;
        minimum_rank: number;
        sessions: number;
        pairings: number;
        social_v11_consents: number;
        accountless_v11_authorizations: number;
      }>();
      expect(ownerGraph).toMatchObject({
        owner_kind: "accountless",
        access_token_id: null,
        recovery_token_id: null,
        consent_version: null,
        consented_at: null,
        authority_kind: "accountless",
        paired_via_pairing_id: null,
        accountless_enrollment_device_id: deviceId,
        social_verified_at: null,
        minimum_rank: 11,
        sessions: 0,
        pairings: 0,
        social_v11_consents: 0,
        accountless_v11_authorizations: 1,
      });
      const participantId = ownerGraph?.id;
      expect(participantId).toMatch(/^participant:/u);
      const publicBeforeActivation = await seedPublicPublicationFixture();

      const capabilities = await api("/api/v1/device/sync-capabilities", {
        headers: { authorization },
      });
      expect(capabilities.status, await capabilities.clone().text()).toBe(200);
      expect(await capabilities.json()).toMatchObject({
        schemaVersion: "device-sync-capabilities-v1.1",
        consentCurrent: false,
        authorityKind: "accountless",
        authorizationCurrent: true,
        minimumWriteRank: 11,
        requiredConsent: {
          telemetrySchemaVersion: "telemetry-contribution-v1.1",
        },
      });

      const legacyRegistration = await registerDeviceUpload(
        authorization,
        "{}",
        "telemetry-contribution-v1.0",
      );
      expect(legacyRegistration.status).toBe(403);
      expect(await errorCode(legacyRegistration)).toBe("TELEMETRY_TRANSPORT_BLOCKED");
      expect((await api("/api/v1/device/sync/state", {
        headers: { authorization },
      })).status).toBe(403);

      const day = new Date().toISOString().slice(0, 10);
      const prepared = await makeV11Day(day, fullV11Day(day));
      const manifest = await api("/api/v1/device/telemetry/v1.1/day-manifests", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(prepared.manifest),
      });
      expect(manifest.status, await manifest.clone().text()).toBe(201);
      const candidate = await manifest.json<{
        manifestId: string;
        manifestDigest: string;
        state: string;
      }>();
      expect(candidate).toMatchObject({
        manifestDigest: prepared.manifest.manifestDigest,
        state: "staged",
      });

      const uploads = [] as Array<{
        response: Response;
        rawEnvelope: string;
        uploadAuthorization: string;
      }>;
      for (const chunk of prepared.chunks) {
        const uploaded = await uploadEncryptedChunk(authorization, chunk);
        expect(uploaded.response.status, await uploaded.response.clone().text()).toBe(202);
        expect(await uploaded.response.json()).toMatchObject({
          schemaVersion: "telemetry-chunk-receipt-v1.1",
          manifestId: candidate.manifestId,
          replayed: false,
          status: "staged",
        });
        uploads.push(uploaded);
      }
      const duplicateRegistration = await registerDeviceUpload(
        authorization,
        uploads[0]!.rawEnvelope,
      );
      expect(duplicateRegistration.status).toBe(201);
      const duplicateUpload = await duplicateRegistration.json<{ uploadAuthorization: string }>();
      const duplicate = await api("/api/v1/contributions", {
        method: "POST",
        headers: {
          authorization: `Upload ${duplicateUpload.uploadAuthorization}`,
          "content-type": "application/json",
        },
        body: uploads[0]!.rawEnvelope,
      });
      expect(duplicate.status, await duplicate.clone().text()).toBe(202);
      expect(await duplicate.json()).toMatchObject({ replayed: true });

      const predecessor = await api("/api/v1/me/telemetry-v11/domain-predecessor", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: "{}",
      });
      expect(predecessor.status, await predecessor.clone().text()).toBe(201);
      const predecessorBody = await predecessor.json<{
        token: string;
        previousGenerationId: string | null;
        legacyFingerprint: string;
        fromDay: string;
        throughDay: string;
      }>();
      expect(predecessorBody.fromDay).toBe(day);
      expect(predecessorBody.throughDay).toBe(day);
      const domain = {
        schemaVersion: "telemetry-domain-manifest-v1.1" as const,
        fromDay: day,
        throughDay: day,
        predecessor: {
          token: predecessorBody.token,
          previousGenerationId: predecessorBody.previousGenerationId,
          legacyFingerprint: predecessorBody.legacyFingerprint,
        },
        days: [{
          day,
          manifestId: candidate.manifestId,
          manifestDigest: candidate.manifestDigest,
        }],
        manifestDigest: "0".repeat(64),
      };
      domain.manifestDigest = await sha256Hex(
        telemetryV11DomainManifestDigestInput(domain),
      );
      const activation = await api("/api/v1/me/telemetry-v11/domain-activate", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(domain),
      });
      expect(activation.status, await activation.clone().text()).toBe(201);
      expect(await activation.json()).toMatchObject({
        schemaVersion: "telemetry-domain-activation-v1.1",
        fromDay: day,
        throughDay: day,
        replay: false,
      });

      expect(await loadV11SourcePin(db(), participantId!)).toMatchObject({
        participantId,
        fromDay: day,
        throughDay: day,
      });
      const activeRows = await db().prepare(`
        SELECT stream, COUNT(*) AS count
          FROM telemetry_v11_active_records
         WHERE participant_id = ?
         GROUP BY stream
         ORDER BY stream
      `).bind(participantId).all<{ stream: string; count: number }>();
      expect(activeRows.results).toEqual([
        { stream: "quota", count: 9 },
        { stream: "usage", count: 8 },
      ]);
      expect(await accountScopedQuotaAnalysisV11(db(), participantId!))
        .toMatchObject({ status: "ready" });
      expect(await publicPublicationSnapshot()).toEqual(publicBeforeActivation);

      // A populated accountless v1.1 source remains private even if an old
      // scheduler invocation reaches the cache/publication helpers directly.
      // The source gates must repeat the owner boundary rather than relying on
      // enrollment's ordinary absence of a queue row.
      const accountlessSourcePin = await loadV11SourcePin(db(), participantId!);
      if (accountlessSourcePin === null) throw new Error("synthetic accountless source missing");
      const accountlessAnalysis = await accountScopedQuotaAnalysisV11(db(), participantId!, {
        sourcePin: accountlessSourcePin,
      });
      const accountlessComposition = await accountScopedModelCompositionV11(db(), participantId!, {
        sourcePin: accountlessSourcePin,
      });
      const accountlessLease = "synthetic-accountless-publication-lease";
      await db().prepare(`UPDATE retention_state
        SET maintenance_lease_token = ?, maintenance_lease_expires_at = '2030-01-01T00:00:00.000Z'
        WHERE singleton = 1`).bind(accountlessLease).run();
      expect(await publishCommunityAnalysisCaches(db(), {
        participantId: participantId!,
        source: "v1.1",
        sourcePin: accountlessSourcePin,
        fitFingerprint: accountlessSourcePin.fingerprint,
        fromDay: accountlessSourcePin.fromDay,
        compositionSupported: true,
      }, [{ source: "v1.1", analysis: accountlessAnalysis }], accountlessComposition, accountlessLease)).toBe(false);
      await db().prepare(`INSERT INTO community_current_analysis_queue
        (participant_id, dirty_generation, window_generation, pending, last_served_sequence)
        VALUES (?, 1, 0, 1, 0)`).bind(participantId).run();
      await advanceCommunityPublication(db(), Date.now(), {
        budget: { remainingQueries: 64, deadlineMs: Date.now() + 30_000 },
        maxPages: 4,
      });

      // The populated private v1.1 domain creates no queue work itself. The
      // one row below is an intentionally injected stale scheduler record; it
      // remains pending and cannot enter the captured public cohort.
      expect(await db().prepare(`SELECT COUNT(*) AS count
        FROM community_current_analysis_queue WHERE participant_id = ?`)
        .bind(participantId).first()).toEqual({ count: 1 });
      expect(await db().prepare(`SELECT COUNT(*) AS count
        FROM community_publication_members WHERE participant_id = ?`)
        .bind(participantId).first()).toEqual({ count: 0 });
      expect(await db().prepare(`SELECT COUNT(*) AS count
        FROM community_allowance_fit_cache WHERE participant_id = ?`)
        .bind(participantId).first()).toEqual({ count: 0 });
      expect(await db().prepare(`SELECT COUNT(*) AS count
        FROM community_model_composition_cache WHERE participant_id = ?`)
        .bind(participantId).first()).toEqual({ count: 0 });

      // Accountless evidence remains eligible for its private, internal
      // v1.1 analytical domain, but its owner kind is deliberately excluded
      // from the public allowance cohort until an independent eligibility
      // decision exists.
      expect(await collectCommunityAllowanceFits(db())).toEqual([]);

      const pendingEnvelope = JSON.stringify(await encrypted(prepared.chunks[0]));
      const pendingRegistration = await registerDeviceUpload(authorization, pendingEnvelope);
      expect(pendingRegistration.status).toBe(201);
      const pending = await pendingRegistration.json<{ uploadAuthorization: string }>();
      const disconnected = await api("/api/v1/device/disconnect", {
        method: "POST",
        headers: { authorization },
      });
      expect(disconnected.status, await disconnected.clone().text()).toBe(200);
      expect(await disconnected.json()).toMatchObject({ disconnected: true, deviceId });

      const revocation = await db().prepare(`
        SELECT ledger.state AS ledger_state, owner.state AS owner_state,
               grant_row.state AS authorization_state, device.state AS device_state,
               (SELECT state FROM device_upload_authorizations
                 WHERE id = substr(?, length('um_device_upload_') + 1, 36))
                 AS pending_upload_state,
               (SELECT COUNT(*) FROM device_upload_authorizations
                 WHERE issued_by_device_id = ? AND state = 'consumed') AS consumed_uploads
          FROM accountless_enrollment_ledger ledger
          JOIN accountless_upload_owners owner ON owner.enrollment_device_id = ledger.device_id
          JOIN accountless_v11_device_authorizations grant_row
            ON grant_row.enrollment_device_id = ledger.device_id
          JOIN device_credentials device ON device.id = ledger.device_id
         WHERE ledger.device_id = ?
      `).bind(pending.uploadAuthorization, deviceId, deviceId).first<{
        ledger_state: string;
        owner_state: string;
        authorization_state: string;
        device_state: string;
        pending_upload_state: string;
        consumed_uploads: number;
      }>();
      expect(revocation).toEqual({
        ledger_state: "revoked",
        owner_state: "revoked",
        authorization_state: "revoked",
        device_state: "revoked",
        pending_upload_state: "revoked",
        consumed_uploads: prepared.chunks.length + 1,
      });

      const blockedOwnership = await api("/api/v1/accountless/ownership", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(ownershipBody),
      });
      expect(blockedOwnership.status).toBe(401);
      expect(await errorCode(blockedOwnership)).toBe("ACCOUNTLESS_OWNERSHIP_REVOKED");
      const blockedCapability = await api("/api/v1/device/sync-capabilities", {
        headers: { authorization },
      });
      expect(blockedCapability.status).toBe(401);
      expect(await errorCode(blockedCapability)).toBe("DEVICE_AUTH_INVALID");
      const blockedPending = await api("/api/v1/contributions", {
        method: "POST",
        headers: {
          authorization: `Upload ${pending.uploadAuthorization}`,
          "content-type": "application/json",
        },
        body: pendingEnvelope,
      });
      expect(blockedPending.status).toBe(401);
      expect(await errorCode(blockedPending)).toBe("UPLOAD_AUTH_INVALID");

      // The direct authority root was already revoked by the device opt-out.
      // Operator erasure removes its private participant subtree without
      // withdrawing or invalidating any social public publication surface.
      const erased = await eraseParticipantAsOwner(
        runtime(),
        "e".repeat(64),
        participantId!,
      );
      expect(erased).toMatchObject({ deleted: true, alreadyDeleted: false });
      expect(await publicPublicationSnapshot()).toEqual(publicBeforeActivation);
      expect(await db().prepare("SELECT id FROM participants WHERE id = ?")
        .bind(participantId).first()).toBeNull();
    } finally {
      secret.fill(0);
    }
  });

  it("revokes the accountless authority root before an operator erases its participant", async () => {
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
    try {
      const enrollment = await api("/api/v1/accountless/enrollment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
          deviceId,
          deviceSecretHash: await deviceSecretHash(deviceId, secret),
          policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
          authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
        }),
      });
      expect(enrollment.status, await enrollment.clone().text()).toBe(201);
      const ownership = await api("/api/v1/accountless/ownership", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
          policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
          authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
          telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
        }),
      });
      expect(ownership.status, await ownership.clone().text()).toBe(201);
      const owner = await db().prepare(
        "SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id = ?",
      ).bind(deviceId).first<{ participant_id: string }>();
      expect(owner?.participant_id).toMatch(/^participant:/u);

      // The participant deletion trigger refuses an active accountless owner.
      // Successful erasure therefore proves the ledger cascade happened before
      // the participant row was removed.
      const erased = await eraseParticipantAsOwner(
        runtime(),
        "e".repeat(64),
        owner!.participant_id,
      );
      expect(erased).toMatchObject({
        task: "participant_erasure",
        deleted: true,
        alreadyDeleted: false,
        contributionsDeleted: 0,
      });
      expect(await db().prepare("SELECT id FROM participants WHERE id = ?")
        .bind(owner!.participant_id).first()).toBeNull();
      expect(await db().prepare(`
        SELECT state, revocation_reason
          FROM accountless_enrollment_ledger
         WHERE device_id = ?
      `).bind(deviceId).first()).toEqual({
        state: "revoked",
        revocation_reason: "security_reset",
      });
      expect(await db().prepare(`
        SELECT COUNT(*) AS count
          FROM accountless_upload_owners
         WHERE enrollment_device_id = ?
      `).bind(deviceId).first<{ count: number }>()).toEqual({ count: 0 });
    } finally {
      secret.fill(0);
    }
  });
});
