import { env, applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { Buffer } from "node:buffer";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json, telemetryV11RequiredConsent, type TelemetryV11Envelope, type TelemetryV11QuotaObservation } from "@app-usagemonitor/telemetry-contract";
import { runTelemetryV11Sync } from "./helpers/contribution-v11-runner.js";
import { claimContributionDevicePairing } from "./helpers/contribution-device-client.js";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { authenticateDevice, createDeviceUploadAuthorization } from "../src/device-auth";
import { handleRequest } from "../src/index";
import { deleteDueQuarantineObjects, recordDeletionTombstone, replayDeletionTombstones } from "../src/retention";
import { reconcilePendingQuarantineObjects } from "../src/quarantine-reconciliation";
import { personalStats } from "../src/telemetry-repository";
import { createUploadAuthorizationMaterial, storeUploadAuthorization, claimUploadAuthorization } from "../src/session";
import { assertTelemetryTransportWriteAllowed, grantTelemetryV11Consent, telemetryTransportCapabilities } from "../src/telemetry-transport-policy";
import { registerTelemetryV11DayManifest, telemetryV11LegacyProjection, loadTelemetryV11ReadyDayVector,
  telemetryV11ChunkR2KeyPage, telemetryV11ExportEntries } from "../src/telemetry-v11-repository";
import { ownerErase, ownerErasureRequest } from "./helpers/owner-erasure";
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";

interface TestBindings extends Env { TEST_MIGRATIONS: D1Migration[]; TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[] }
const bindings = () => env as TestBindings;
const db = () => bindings().USAGE_MONITOR_DB;
let publicJwk: JsonWebKey;
let publicJwkJson = "";
let privateJwkJson = "";
const keyId = "key:synthetic-v11";
const day = "2026-08-28";

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  if (!("publicKey" in pair)) throw new Error("Expected an RSA test key pair");
  const exportedPublic = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (exportedPublic instanceof ArrayBuffer) throw new Error("Expected a JWK test key");
  publicJwk = exportedPublic;
  publicJwkJson = JSON.stringify({ ...publicJwk, kid: keyId });
  privateJwkJson = JSON.stringify({ ...await crypto.subtle.exportKey("jwk", pair.privateKey), kid: keyId });
});
beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings().TEST_MIGRATIONS);
  await applyD1Migrations(bindings().DELETION_LEDGER, bindings().TEST_DELETION_LEDGER_MIGRATIONS);
});
function runtime(): Env {
  return { ...bindings(), ENVIRONMENT: "synthetic-development", ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    ENVELOPE_PUBLIC_JWK: publicJwkJson, ENVELOPE_PRIVATE_JWK: privateJwkJson };
}
function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.method === "POST") headers.set("origin", "https://example.test");
  return handleRequest(new Request(`https://example.test${path}`, { ...init, headers }), runtime());
}
async function encrypted(value: unknown): Promise<TelemetryV11Envelope> {
  const rsa = await crypto.subtle.importKey("jwk", publicJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  if ("privateKey" in key) throw new Error("Expected a symmetric test key");
  const raw = await crypto.subtle.exportKey("raw", key);
  if (!(raw instanceof ArrayBuffer)) throw new Error("Expected raw key bytes");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, raw);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key,
    new TextEncoder().encode(canonicalTelemetryV11Json(value)));
  new Uint8Array(raw).fill(0);
  return { schemaVersion: "telemetry-envelope-v1.1", synthetic: false, keyId,
    wrappedKey: encodeBase64Url(new Uint8Array(wrapped)), iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)) };
}
async function upload(fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>, envelope: object) {
  const raw = JSON.stringify(envelope);
  const register = await api("/api/v1/device/upload-authorizations", { method: "POST",
    headers: { authorization: fixture.authorization, "content-type": "application/json" },
    body: JSON.stringify({ envelopeDigest: await sha256Hex(raw), contentLengthBytes: new TextEncoder().encode(raw).length,
      contentType: "application/json", telemetrySchemaVersion: "telemetry-contribution-v1.1" }) });
  expect(register.status).toBe(201);
  const authorization = await register.json<{ uploadAuthorization: string }>();
  return api("/api/v1/contributions", { method: "POST", headers: {
    authorization: `Upload ${authorization.uploadAuthorization}`, "content-type": "application/json" }, body: raw });
}
function runnerOptions(
  fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>,
  count = 1,
  syncDay = day,
) {
  return {
    serverBaseUrl: "https://example.test", deviceAuthorization: fixture.authorization,
    consent: telemetryV11RequiredConsent(), days: [syncDay],
    readDay: async (selectedDay: string) => makeV11Day(selectedDay, { usage: selectedDay === syncDay
      ? Array.from({ length: count }, (_, index) => v11UsageRecord(syncDay, "a", { eventId: "event:v2:" + index.toString(16).padStart(64, "0") }))
      : [] }),
    createEnvelope: encrypted,
    fetchImpl: async (url: URL, options: RequestInit) => {
      // The Node client refuses redirects. Workerd's Request constructor only
      // implements manual/follow, so the in-process bridge uses manual and
      // never follows a response. All bytes, auth and handlers stay real.
      expect(options.redirect).toBe("error");
      return handleRequest(new Request(url, { ...options, redirect: "manual" }), runtime());
    },
  };
}

async function freshPairing(fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>) {
  const result = await api("/api/v1/me/device-pairings", { method: "POST",
    headers: { cookie: fixture.cookie, "x-usage-monitor-csrf": fixture.csrfToken, "content-type": "application/json" },
    body: JSON.stringify({ consentVersion: "ongoing-privacy-safe-telemetry-v1.0", ongoingUpload: true }) });
  expect(result.status).toBe(201);
  return (await result.json<{ pairingCode: string }>()).pairingCode;
}

function localRepairPorts(deviceId: string, initialSecret: Buffer) {
  let installed = Buffer.from(initialSecret);
  let rotations = 0;
  const hash = async (secret: Buffer) => {
    const prefix = Buffer.from("app-usagemonitor/device/v1\0" + deviceId + "\0");
    const input = Buffer.concat([prefix, secret]);
    try { return await sha256Hex(input); } finally { input.fill(0); }
  };
  // Only the platform lease/CAS boundary is synthetic. The production client's
  // negotiation, derivation, headers, body and response parser run unchanged.
  const ports: Pick<Parameters<typeof claimContributionDevicePairing>[0], "ensureCapability" | "rotate"> = {
    ensureCapability: async ({ origin }) => ({ origin, deviceId, status: "existing",
      deviceSecretHash: await hash(installed) }),
    rotate: async ({ expectedOrigin, deriveSecret, performRemoteRotation }) => {
      const currentSecret = Buffer.from(installed);
      const replacement = deriveSecret({ origin: expectedOrigin, deviceId, currentSecret });
      try {
        const receipt = await performRemoteRotation({ origin: expectedOrigin, deviceId, currentSecret,
          nextDeviceSecretHash: await hash(replacement) });
        expect(receipt.committed).toBe(true);
        expect(installed.equals(currentSecret)).toBe(true);
        installed.fill(0); installed = Buffer.from(replacement); rotations += 1;
        return { status: "renewed", origin: expectedOrigin, deviceId, expiresAt: receipt.expiresAt };
      } finally { currentSecret.fill(0); replacement.fill(0); }
    },
  };
  return { ports, authorization: () => "Device um_device_" + deviceId + "." + installed.toString("base64url"),
    rotations: () => rotations, close: () => installed.fill(0) };
}

async function seedLegacyV02Contribution(fixture: { participantId: string; sessionId: string }) {
  const id = "contribution:" + crypto.randomUUID();
  const authorization = await createUploadAuthorizationMaterial(fixture.participantId, fixture.sessionId, "b".repeat(64), 1);
  await storeUploadAuthorization(db(), authorization);
  const claimed = await claimUploadAuthorization(db(), "Upload " + authorization.encoded,
    { envelopeDigest: "b".repeat(64), bodyBytes: 1, contentType: "application/json" });
  await db().prepare(
    `INSERT INTO telemetry_contributions (
       id, participant_id, plaintext_digest, envelope_digest, r2_key, status, schema_version,
       transport_schema_version, range_start, range_end, client_platform, provider_policy_epoch,
       estimated_api_cost_usd, priced_event_coverage_percent, unknown_model_event_count,
       unknown_billable_units, price_basis, declared_record_count, created_at, upload_authorization_id
     ) VALUES (?, ?, ?, ?, ?, 'accepted', 'telemetry-contribution-v0.1',
       'telemetry-contribution-v0.2', ?, ?, 'macos', 'unknown', NULL, 0, 0, 0, 'unavailable', 0, ?, ?)`,
  ).bind(id, fixture.participantId, "a".repeat(64), "b".repeat(64), "telemetry/" + id,
    "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z", claimed.authorizationId).run();
}

describe("staged attribution transport and enrollment floor", () => {
  it.each(["same pairing", "new pairing after lost code"] as const)(
    "production client repairs 180-day expiry and a lost commit response with %s", async (retry) => {
      const fixture = await createV11DeviceFixture(db(), { grant: true });
      const runner = runnerOptions(fixture, 201);
      expect((await runTelemetryV11Sync({ ...runner, maxChunks: 1 })).status).toBe("partial");
      const before = await telemetryTransportCapabilities(db(), fixture, "https://example.test");
      const old = Buffer.from(fixture.authorization.split(".")[1]!, "base64url");
      const local = localRepairPorts(fixture.deviceId, old); old.fill(0);
      try {
        const expired = new Date(Date.now() - 181 * 86_400_000).toISOString();
        await db().prepare("UPDATE device_credentials SET issued_at = ?, social_verified_at = ?, last_used_at = ?, expires_at = ? WHERE id = ?")
          .bind(expired, expired, expired, new Date(Date.now() - 86_400_000).toISOString(), fixture.deviceId).run();
        let pairingCode = await freshPairing(fixture);
        let loseResponse = true;
        const request = () => claimContributionDevicePairing({
          origin: "https://example.test", pairingCode, ...local.ports,
          fetchImpl: async (url, options) => {
            expect(options.redirect).toBe("error");
            const reply = await handleRequest(new Request(url, { ...options, redirect: "manual" }), runtime());
            if (loseResponse && new Headers(options.headers).has("x-previous-device-authorization") && reply.status === 201) {
              loseResponse = false; await reply.body?.cancel(); throw new Error("synthetic lost committed receipt");
            }
            return reply;
          },
        });
        await expect(request()).rejects.toMatchObject({ code: "contribution_device_client_service_unavailable" });
        expect(loseResponse).toBe(false);
        expect(local.authorization()).toBe(fixture.authorization);
        expect(local.rotations()).toBe(0);
        if (retry === "new pairing after lost code") pairingCode = await freshPairing(fixture);
        expect(await request()).toMatchObject({ status: "paired", deviceId: fixture.deviceId, scope: "upload_registration" });
        expect(local.rotations()).toBe(1);
        const currentAuthorization = local.authorization();
        expect(currentAuthorization).not.toBe(fixture.authorization);
        expect(await telemetryTransportCapabilities(db(), fixture, "https://example.test")).toEqual(before);
        expect((await db().prepare("SELECT count(*) AS n FROM device_credentials WHERE participant_id = ?")
          .bind(fixture.participantId).first<{ n: number }>())?.n).toBe(1);
        expect((await db().prepare("SELECT count(*) AS n FROM telemetry_v11_chunks WHERE participant_id = ?")
          .bind(fixture.participantId).first<{ n: number }>())?.n).toBe(1);
        expect((await runTelemetryV11Sync({ ...runner, deviceAuthorization: currentAuthorization })))
          .toMatchObject({ status: "complete", chunksUploaded: 1, chunksSkipped: 1, recordsUploaded: 1 });
        const installed = await authenticateDevice(db(), currentAuthorization);
        expect(installed).toMatchObject({ participantId: fixture.participantId, deviceId: fixture.deviceId,
          credentialGeneration: retry === "same pairing" ? 2 : 3 });
        const receiptCount = await db().prepare("SELECT count(*) AS n FROM device_credential_rotations WHERE device_id = ?")
          .bind(fixture.deviceId).first<{ n: number }>();
        expect(receiptCount?.n).toBe(retry === "same pairing" ? 1 : 2);
      } finally { local.close(); }
    },
  );

  it("production client's initial lost acknowledgement retries creation without inventing a rotation", async () => {
    const fixture = await createV11DeviceFixture(db());
    const deviceId = crypto.randomUUID();
    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    const local = localRepairPorts(deviceId, secret); secret.fill(0);
    try {
      const pairingCode = await freshPairing(fixture);
      let loseResponse = true;
      const request = () => claimContributionDevicePairing({ origin: "https://example.test", pairingCode, ...local.ports,
        fetchImpl: async (url, options) => {
          expect(new Headers(options.headers).has("x-previous-device-authorization")).toBe(false);
          const reply = await handleRequest(new Request(url, { ...options, redirect: "manual" }), runtime());
          if (loseResponse && reply.status === 201) {
            loseResponse = false; await reply.body?.cancel(); throw new Error("synthetic lost initial receipt");
          }
          return reply;
        },
      });
      await expect(request()).rejects.toMatchObject({ code: "contribution_device_client_service_unavailable" });
      expect((await request()).deviceId).toBe(deviceId);
      expect(local.rotations()).toBe(0);
      expect((await authenticateDevice(db(), local.authorization())).credentialGeneration).toBe(1);
    } finally { local.close(); }
  });

  it("the real HTTP runner resumes a bounded partial day and activates only its complete comparison domain", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const syncDay = new Date(fixture.nowEpoch).toISOString().slice(0, 10);
    const options = runnerOptions(fixture, 201, syncDay);
    const partial = await runTelemetryV11Sync({ ...options, maxChunks: 1 });
    expect(partial.failure).toBeNull();
    expect(partial).toMatchObject({ status: "partial", chunksUploaded: 1, daysSynced: 0, acknowledgedThroughDay: null });
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_v11_domain_heads").first<{ n: number }>())?.n).toBe(0);
    const complete = await runTelemetryV11Sync({ ...options, maxChunks: 1 });
    expect(complete).toMatchObject({ status: "complete", chunksUploaded: 1, chunksSkipped: 1, recordsUploaded: 1, daysPending: 0 });
    expect(complete.acknowledgedThroughDay).not.toBeNull();
    expect((await db().prepare("SELECT generation_id FROM telemetry_v11_domain_heads WHERE participant_id = ?")
      .bind(fixture.participantId).first<{ generation_id: string }>())?.generation_id).toBe(complete.domainGenerationId);
    const again = await runTelemetryV11Sync(options);
    expect(again).toMatchObject({ status: "complete", chunksUploaded: 0, chunksSkipped: 2,
      domainGenerationId: complete.domainGenerationId });
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_v11_active_records").first<{ n: number }>())?.n).toBe(201);
  });

  it("fresh HTTP re-pair renews an expired active device without changing attribution enrollment, floor or staged history", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const options = runnerOptions(fixture, 201);
    const partial = await runTelemetryV11Sync({ ...options, maxChunks: 1 });
    expect(partial.failure).toBeNull();
    expect(partial.status).toBe("partial");
    const before = await telemetryTransportCapabilities(db(), fixture, "https://example.test");
    await db().prepare("UPDATE device_credentials SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1_000).toISOString(), fixture.deviceId).run();
    expect(await runTelemetryV11Sync(options)).toMatchObject({ status: "failed", failure: { code: "device_unavailable" }, acknowledgedThroughDay: null });
    const pairing = await api("/api/v1/me/device-pairings", { method: "POST",
      headers: { cookie: fixture.cookie, "x-usage-monitor-csrf": fixture.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ consentVersion: "ongoing-privacy-safe-telemetry-v1.0", ongoingUpload: true }) });
    expect(pairing.status).toBe(201);
    const material = await pairing.json<{ pairingCode: string }>();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const prefix = new TextEncoder().encode("app-usagemonitor/device/v1\0" + fixture.deviceId + "\0");
    const input = new Uint8Array(prefix.length + secret.length); input.set(prefix); input.set(secret, prefix.length);
    const claimBody = JSON.stringify({ deviceId: fixture.deviceId, deviceSecretHash: await sha256Hex(input) });
    input.fill(0);
    const claimHeaders = { authorization: "Pairing " + material.pairingCode, "content-type": "application/json",
      "x-previous-device-authorization": fixture.authorization };
    expect((await api("/api/v1/device-pairings/claim", { method: "POST", headers: claimHeaders, body: claimBody })).status).toBe(201);
    expect((await api("/api/v1/device-pairings/claim", { method: "POST", headers: claimHeaders, body: claimBody })).status).toBe(201);
    const renewed = "Device um_device_" + fixture.deviceId + "." + encodeBase64Url(secret); secret.fill(0);
    const after = await telemetryTransportCapabilities(db(), fixture, "https://example.test");
    expect(after).toEqual(before);
    const complete = await runTelemetryV11Sync({ ...options, deviceAuthorization: renewed });
    expect(complete).toMatchObject({ status: "complete", chunksUploaded: 1, chunksSkipped: 1 });
    expect((await db().prepare("SELECT count(*) AS n FROM device_credentials WHERE participant_id = ?")
      .bind(fixture.participantId).first<{ n: number }>())?.n).toBe(1);
  });

  it("keeps migration inactive, legacy clients allowed, dormant v0.2 blocked, and capabilities private", async () => {
    const first = await createV11DeviceFixture(db());
    const second = await createV11DeviceFixture(db(), { participantId: first.participantId });
    const capabilities = await telemetryTransportCapabilities(db(), first, "https://example.test");
    expect(capabilities).toMatchObject({ minimumWriteRank: 1, consentCurrent: false,
      formats: expect.arrayContaining([{ schemaVersion: "telemetry-contribution-v1.1", rank: 11, lifecycle: "staged" }]) });
    expect(capabilities.enrollmentNamespace).toMatch(/^[0-9a-f]{64}$/u);
    expect((await telemetryTransportCapabilities(db(), second, "https://example.test")).enrollmentNamespace).toBe(capabilities.enrollmentNamespace);
    await expect(assertTelemetryTransportWriteAllowed(db(), first, "telemetry-contribution-v1.0")).resolves.toBeUndefined();
    await expect(assertTelemetryTransportWriteAllowed(db(), first, "telemetry-contribution-v0.2")).rejects.toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });
    await expect(grantTelemetryV11Consent(db(), first, telemetryV11RequiredConsent())).rejects.toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });
    expect((await api("/api/v1/device/sync-capabilities")).status).toBe(401);
    const response = await api("/api/v1/device/sync-capabilities", { headers: { authorization: first.authorization } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(db().prepare("UPDATE attribution_enrollments SET namespace = ? WHERE participant_id = ?")
      .bind("d".repeat(64), first.participantId).run()).rejects.toThrow("attribution_enrollment_immutable");
  });

  it("requires fresh explicit session+CSRF consent and persists the participant floor across devices", async () => {
    const first = await createV11DeviceFixture(db());
    const second = await createV11DeviceFixture(db(), { participantId: first.participantId });
    await db().prepare("UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = 'telemetry-contribution-v1.1'").run();
    const body = JSON.stringify({ deviceId: first.deviceId, consent: telemetryV11RequiredConsent(), ongoingUpload: true });
    expect((await api("/api/v1/me/device-telemetry-consents", { method: "POST", headers: {
      cookie: first.cookie, "content-type": "application/json" }, body })).status).toBe(403);
    const headers = { cookie: first.cookie, "x-usage-monitor-csrf": first.csrfToken, "content-type": "application/json" };
    expect((await api("/api/v1/me/device-telemetry-consents", { method: "POST", headers, body })).status).toBe(201);
    expect((await api("/api/v1/me/device-telemetry-consents", { method: "POST", headers, body })).status).toBe(201);
    expect((await telemetryTransportCapabilities(db(), second, "https://example.test"))).toMatchObject({ minimumWriteRank: 11, policyRevision: 1, consentCurrent: false });
    await expect(assertTelemetryTransportWriteAllowed(db(), second, "telemetry-contribution-v1.0")).rejects.toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });
    await expect(assertTelemetryTransportWriteAllowed(db(), second, "telemetry-contribution-v1.1")).rejects.toMatchObject({ code: "TELEMETRY_CONSENT_INVALID" });
    await expect(db().prepare("UPDATE telemetry_transport_participant_floors SET minimum_rank = 1, revision = revision + 1 WHERE participant_id = ?")
      .bind(first.participantId).run()).rejects.toThrow("telemetry_transport_rollback_required");
  });

  it.each(["preflight", "before transaction"] as const)(
    "incompatible accepted v0.2 history at %s blocks successor consent without raising the legacy floor", async (when) => {
      const fixture = await createV11DeviceFixture(db());
      await db().prepare("UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE format_rank IN (2, 11)").run();
      if (when === "preflight") await seedLegacyV02Contribution(fixture);
      const base = db();
      const guarded = when === "preflight" ? base : new Proxy(base, {
        get(target, property) {
          if (property === "batch") return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
            await seedLegacyV02Contribution(fixture);
            return target.batch<T>(statements);
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await expect(grantTelemetryV11Consent(guarded, fixture, telemetryV11RequiredConsent()))
        .rejects.toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });
      const capabilities = await telemetryTransportCapabilities(base, fixture, "https://example.test");
      expect(capabilities).toMatchObject({ minimumWriteRank: 1, policyRevision: 0, consentCurrent: false });
      expect(capabilities.formats.find((format) => format.rank === 11)?.lifecycle).toBe("blocked");
      expect((await base.prepare("SELECT count(*) AS n FROM telemetry_v11_device_consents WHERE participant_id = ?")
        .bind(fixture.participantId).first<{ n: number }>())?.n).toBe(0);
      await expect(assertTelemetryTransportWriteAllowed(base, fixture, "telemetry-contribution-v0.2")).resolves.toBeUndefined();
      const unaffected = await createV11DeviceFixture(base);
      expect((await telemetryTransportCapabilities(base, unaffected, "https://example.test")).formats
        .find((format) => format.rank === 11)?.lifecycle).toBe("accepted");
    },
  );

  it("rejects legacy registration and ingest replay even when an authorization was minted before upgrade", async () => {
    const fixture = await createV11DeviceFixture(db());
    const envelope = { schemaVersion: "telemetry-envelope-v1.0", synthetic: false, keyId,
      wrappedKey: "a".repeat(342), iv: "a".repeat(16), ciphertext: "a".repeat(20) };
    const raw = JSON.stringify(envelope);
    const digest = await sha256Hex(raw);
    const length = new TextEncoder().encode(raw).length;
    const principal = await authenticateDevice(db(), fixture.authorization);
    const before = await createDeviceUploadAuthorization(db(), principal, digest, length);
    await db().prepare("UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = 'telemetry-contribution-v1.1'").run();
    await grantTelemetryV11Consent(db(), fixture, telemetryV11RequiredConsent());
    expect((await api("/api/v1/device/upload-authorizations", { method: "POST", headers: {
      authorization: fixture.authorization, "content-type": "application/json" }, body: JSON.stringify({
      envelopeDigest: digest, contentLengthBytes: length, contentType: "application/json" }) })).status).toBe(403);
    const ingest = await api("/api/v1/contributions", { method: "POST", headers: {
      authorization: `Upload ${before.uploadAuthorization}`, "content-type": "application/json" }, body: raw });
    expect(ingest.status).toBe(403);
    expect(await ingest.json()).toMatchObject({ error: { code: "TELEMETRY_TRANSPORT_BLOCKED" } });
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_v1_chunks").first<{ n: number }>())?.n).toBe(0);
    expect((await bindings().QUARANTINE.list()).objects).toHaveLength(0);
  });

  it("stages authenticated encrypted chunks idempotently without publishing or advancing legacy ack", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const prepared = await makeV11Day(day, { usage: [v11UsageRecord(day)] });
    const staged = await api("/api/v1/device/telemetry/v1.1/day-manifests", { method: "POST", headers: {
      authorization: fixture.authorization, "content-type": "application/json" }, body: JSON.stringify(prepared.manifest) });
    expect(staged.status).toBe(201);
    const candidate = await staged.json<{ manifestId: string }>();
    const one = await upload(fixture, await encrypted(prepared.chunks[0]));
    expect(one.status).toBe(202);
    const receipt = await one.json<Record<string, unknown>>();
    expect(receipt).toMatchObject({ schemaVersion: "telemetry-chunk-receipt-v1.1", status: "staged", manifestId: candidate.manifestId,
      recordCounts: { declared: 1, accepted: 1 }, replayed: false });
    expect(receipt).not.toHaveProperty("acknowledgedThroughDay");
    const again = await upload(fixture, await encrypted(prepared.chunks[0]));
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ contributionId: receipt.contributionId, replayed: true });
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_v11_chunks").first<{ n: number }>())?.n).toBe(1);
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_v1_records").first<{ n: number }>())?.n).toBe(0);
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_v11_domains").first<{ n: number }>())?.n).toBe(0);
    expect(await loadTelemetryV11ReadyDayVector(db(), fixture, [{ day, manifestId: candidate.manifestId,
      manifestDigest: prepared.manifest.manifestDigest }])).toMatchObject([{ state: "ready" }]);
  });

  it("retains a canonical server-derived v1 counterpart without exporting a second identity", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const quota: TelemetryV11QuotaObservation = { schemaVersion: "quota-observation-v1.1", observationId: `quota-occurrence:v1:${"b".repeat(64)}`,
      observedTime: `${day}T12:05:00.000Z`, provider: "openai_codex", planType: "plus", planVariant: "unknown",
      limitId: "codex", slot: "secondary", usedPercent: 12, windowDurationMinutes: 10080, resetsAt: "2026-08-31T12:00:00.000Z",
      accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
        planBasis: "same_source_occurrence", planType: "plus", planEraId: null } };
    const candidate = await stageV11Day(db(), fixture, await makeV11Day(day, { quota: [quota] }));
    const stored = await db().prepare("SELECT legacy_occurrence_id, legacy_record_json FROM telemetry_v11_records WHERE manifest_id = ?")
      .bind(candidate.manifestId).first<{ legacy_occurrence_id: string; legacy_record_json: string }>();
    expect(stored?.legacy_occurrence_id).toBe(`q:${Date.parse(quota.observedTime)}:codex:secondary`);
    expect(stored?.legacy_record_json).toBe(telemetryV11LegacyProjection("quota", quota)?.canonicalRecord);
    const base = JSON.parse(stored!.legacy_record_json) as Record<string, unknown>;
    expect(base.schemaVersion).toBe("quota-observation-v1.0");
    expect(base).not.toHaveProperty("accountPlanAttribution");
  });

  it("retains quota-only plan evidence with unknown measurements, without inventing a legacy counterpart", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const quota: TelemetryV11QuotaObservation = { schemaVersion: "quota-observation-v1.1", observationId: "quota-occurrence:v1:" + "c".repeat(64),
      observedTime: day + "T12:05:00.000Z", provider: "openai_codex", planType: "plus", planVariant: "unknown",
      limitId: "codex", slot: "unknown", usedPercent: null, windowDurationMinutes: null, resetsAt: null,
      accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
        planBasis: "same_source_occurrence", planType: "plus", planEraId: null } };
    const candidate = await stageV11Day(db(), fixture, await makeV11Day(day, { quota: [quota] }));
    const stored = await db().prepare("SELECT record_json, legacy_occurrence_id, legacy_record_json FROM telemetry_v11_records WHERE manifest_id = ?")
      .bind(candidate.manifestId).first<{ record_json: string; legacy_occurrence_id: string | null; legacy_record_json: string | null }>();
    expect(stored).toMatchObject({ legacy_occurrence_id: null, legacy_record_json: null });
    expect(JSON.parse(stored!.record_json)).toEqual(quota);
  });

  it("private export includes staged/active attribution evidence and excludes capabilities and other participants", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const stranger = await createV11DeviceFixture(db(), { grant: true });
    const isolated = await stageV11Day(db(), stranger, await makeV11Day(day, { usage: [v11UsageRecord(day, "f")] }));
    const options = runnerOptions(fixture, 201);
    expect((await runTelemetryV11Sync({ ...options, maxChunks: 1 })).status).toBe("partial");
    type Inventory = { attributionTransport: Array<{ kind: string; recordCount?: number; records?: unknown[]; activeWhenRead: boolean }> };
    const staged = await api("/api/v1/me/export", { headers: { cookie: fixture.cookie } });
    expect(staged.status).toBe(200);
    const first = await staged.json<Inventory>();
    expect(first.attributionTransport.filter((entry) => entry.kind === "chunk")).toMatchObject([{ recordCount: 200, activeWhenRead: false }]);
    expect(first.attributionTransport.filter((entry) => entry.kind === "domain")).toHaveLength(0);
    expect((await runTelemetryV11Sync(options)).status).toBe("complete");
    const exported = await (await api("/api/v1/me/export", { headers: { cookie: fixture.cookie } })).json<Inventory>();
    const chunks = exported.attributionTransport.filter((entry) => entry.kind === "chunk");
    expect(chunks).toHaveLength(2);
    expect(chunks.reduce((total, entry) => total + (entry.records?.length ?? 0), 0)).toBe(201);
    expect(chunks.every((entry) => entry.activeWhenRead)).toBe(true);
    expect(exported.attributionTransport.filter((entry) => entry.kind === "domain")).toHaveLength(1);
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain(isolated.manifestId);
    expect(serialized).not.toContain(stranger.participantId);
    for (const forbidden of ["predecessor_token_hash", "token_hash", "legacy_record_json",
      "r2_key", "uploadAuthorization", "enrollmentNamespace", "secret_hash"]) expect(serialized).not.toContain(forbidden);
  });

  it("private stats use only the active domain while an incomplete newer candidate stays an inventory", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const complete = await runTelemetryV11Sync(runnerOptions(fixture, 2));
    expect(complete.status).toBe("complete");
    await stageV11Day(db(), fixture, await makeV11Day(day, { usage: [v11UsageRecord(day, "f", {
      components: { inputUncachedTokens: 999, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
        outputTextTokens: 0, outputReasoningTokens: 0, outputCombinedTokens: null },
    })] }, "synthetic-unactivated-candidate"));
    const stats = await personalStats(db(), fixture.participantId);
    expect(stats).toMatchObject({ analyticalSource: { transportSchemaVersion: "telemetry-contribution-v1.1",
      generationId: complete.domainGenerationId }, totals: {
        usageEvents: 2, inputUncachedTokens: 200, apiPriceEquivalentUsd: null,
        priceVerification: "not_repriced_in_incremental_stats",
      } });
    expect(Reflect.get(stats, "accountScopedQuotaAnalysis")).toMatchObject({ status: "not_testable" });
  });

  it("private export and R2 cleanup seek their tuple cursors without prefix scans or missing rows", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    expect((await runTelemetryV11Sync(runnerOptions(fixture, 401))).status).toBe("complete");
    const observedQueries: Array<{ sql: string; values: unknown[] }> = [];
    const base = db();
    const observed = new Proxy(base, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          const query = { sql, values: [] as unknown[] };
          observedQueries.push(query);
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(prepared, method) {
              if (method === "bind") return (...values: unknown[]) => {
                query.values = values; return prepared.bind(...values);
              };
              const value = Reflect.get(prepared, method);
              return typeof value === "function" ? value.bind(prepared) : value;
            },
          });
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const entries: object[] = [];
    for await (const entry of telemetryV11ExportEntries(observed, fixture.participantId, new Date().toISOString())) entries.push(entry);
    expect(entries.filter((entry) => Reflect.get(entry, "kind") === "chunk")).toHaveLength(3);
    const ids: string[] = [];
    let cursor: { createdAt: string; chunkRowId: string } | null = null;
    do {
      const page = await telemetryV11ChunkR2KeyPage(observed, fixture.participantId, cursor, 1);
      ids.push(...page.rows.map((row) => row.id)); cursor = page.nextCursor;
    } while (cursor !== null);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    const cursorQueries = observedQueries.filter((query) => query.sql.includes("> (?, ?)"));
    expect(cursorQueries.length).toBeGreaterThanOrEqual(7);
    for (const query of cursorQueries) {
      expect(query.sql).not.toContain("IS NULL OR");
      const plan = await base.prepare("EXPLAIN QUERY PLAN " + query.sql).bind(...query.values).all<{ detail: string }>();
      const steps = plan.results.map((row) => row.detail);
      expect(steps.some((step) => step.includes("(created_at,id)>(?,?)")), steps.join("\n")).toBe(true);
      expect(steps.some((step) => step.includes("TEMP B-TREE FOR ORDER BY")), steps.join("\n")).toBe(false);
    }
  });

  it("rolls back a duplicate occurrence chunk and never marks its partial manifest ready", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const records = Array.from({ length: 200 }, (_, n) => v11UsageRecord(day, n.toString(16).padStart(2, "0").repeat(32).slice(0, 1), {
      eventId: `event:v2:${n.toString(16).padStart(64, "0")}` }));
    records.push(records[0]!);
    const prepared = await makeV11Day(day, { usage: records });
    await expect(stageV11Day(db(), fixture, prepared)).rejects.toMatchObject({ code: "TELEMETRY_OCCURRENCE_CONFLICT" });
    const candidate = await registerTelemetryV11DayManifest(db(), fixture, prepared.manifest);
    expect(candidate.state).toBe("staged");
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_v11_chunks").first<{ n: number }>())?.n).toBe(1);
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_v11_records").first<{ n: number }>())?.n).toBe(200);
    await expect(loadTelemetryV11ReadyDayVector(db(), fixture, [candidate])).rejects.toMatchObject({ code: "TELEMETRY_MANIFEST_INCOMPLETE" });
  });

  it("owner rollback is CSRF/auth gated, audit scoped and cannot silently change analytical authority", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const body = { action: "run_maintenance", transportRollback: { participantId: fixture.participantId,
      expectedRevision: 1, fromRank: 11, toRank: 10, confirmation: "lower_transport_admission_preserving_analytical_source" } };
    const owner = await ownerErasureRequest(runtime(), fixture.participantId);
    const request = () => new Request(owner.request.url, { method: "POST", headers: owner.request.headers, body: JSON.stringify(body) });
    const denied = request(); denied.headers.delete("cf-access-jwt-assertion");
    expect((await handleRequest(denied, owner.runtimeEnv)).status).not.toBe(200);
    const csrf = request(); csrf.headers.delete("x-usage-monitor-admin");
    expect((await handleRequest(csrf, owner.runtimeEnv)).status).toBe(403);
    const response = await handleRequest(request(), owner.runtimeEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { minimumWriteRank: 10, policyRevision: 2, activeAnalyticalSourcePreserved: true } });
    expect((await handleRequest(request(), owner.runtimeEnv)).status).toBe(409);
    const audit = await db().prepare("SELECT details_json FROM admin_action_audit WHERE outcome = 'success'").first<{ details_json: string }>();
    expect(audit?.details_json).not.toContain(fixture.participantId);
    expect(audit?.details_json).toContain("participantDigest");
    await expect(assertTelemetryTransportWriteAllowed(db(), fixture, "telemetry-contribution-v1.0")).resolves.toBeUndefined();
    const base = db();
    const revokedBeforeCommit = new Proxy(base, {
      get(target, property) {
        if (property === "batch") return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
          await target.prepare("UPDATE web_sessions SET state = 'revoked' WHERE id = ?").bind(fixture.sessionId).run();
          return target.batch<T>(statements);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(grantTelemetryV11Consent(revokedBeforeCommit, fixture, telemetryV11RequiredConsent()))
      .rejects.toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });
    expect(await base.prepare("SELECT minimum_rank, revision FROM telemetry_transport_participant_floors WHERE participant_id = ?")
      .bind(fixture.participantId).first()).toEqual({ minimum_rank: 10, revision: 2 });
  });

  it("owner erasure removes staged objects, identities, grants and journals through the existing pipeline", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    await stageV11Day(db(), fixture, await makeV11Day(day, { usage: [v11UsageRecord(day)] }), { quarantine: bindings().QUARANTINE });
    expect((await bindings().QUARANTINE.list()).objects).toHaveLength(1);
    const result = await ownerErase(runtime(), fixture.participantId);
    expect(result.status).toBe(200);
    expect((await bindings().QUARANTINE.list()).objects).toHaveLength(0);
    for (const table of ["participants", "attribution_enrollments", "telemetry_transport_participant_floors",
      "telemetry_v11_device_consents", "telemetry_v11_day_manifests", "telemetry_v11_chunks", "telemetry_v11_records"]) {
      expect((await db().prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n, table).toBe(0);
    }
    expect((await api("/api/v1/device/sync-capabilities", { headers: { authorization: fixture.authorization } })).status).toBe(401);
  });

  it("owner erasure closes active domains and prevents the old enrollment or credential from returning", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    expect((await runTelemetryV11Sync(runnerOptions(fixture))).status).toBe("complete");
    const result = await ownerErase(runtime(), fixture.participantId);
    expect(result.status).toBe(200);
    for (const table of ["telemetry_v11_domain_heads", "telemetry_v11_domains", "telemetry_v11_domain_days",
      "telemetry_v11_domain_predecessors", "telemetry_v11_records", "telemetry_v11_chunks", "telemetry_v11_day_manifests",
      "telemetry_v11_device_consents", "telemetry_transport_participant_floors", "attribution_enrollments"]) {
      expect((await db().prepare("SELECT count(*) AS n FROM " + table).first<{ n: number }>())?.n, table).toBe(0);
    }
    expect((await bindings().QUARANTINE.list()).objects).toHaveLength(0);
    expect((await api("/api/v1/device/sync-capabilities", { headers: { authorization: fixture.authorization } })).status).toBe(401);
  });

  it("orphan reconciliation preserves v11 references and restore replay erases both bytes and derived state", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    await stageV11Day(db(), fixture, await makeV11Day(day, { usage: [v11UsageRecord(day)] }), { quarantine: bindings().QUARANTINE });
    const reconciliation = await reconcilePendingQuarantineObjects(db(), bindings().QUARANTINE, Date.now() + 2 * 3_600_000);
    expect(reconciliation).toMatchObject({ orphanObjectsDeleted: 0, referencedObjectsPreserved: 1, reconciliationComplete: true });
    expect((await bindings().QUARANTINE.list()).objects).toHaveLength(1);
    await recordDeletionTombstone(bindings().DELETION_LEDGER, fixture.participantId);
    expect(await replayDeletionTombstones(db(), bindings().DELETION_LEDGER, bindings().QUARANTINE))
      .toEqual({ suppressed: 1, complete: true });
    expect((await bindings().QUARANTINE.list()).objects).toHaveLength(0);
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_v11_records").first<{ n: number }>())?.n).toBe(0);
    expect((await db().prepare("SELECT count(*) AS n FROM attribution_enrollments").first<{ n: number }>())?.n).toBe(0);
  });

  it("age retention can delete staged quarantine bytes while retaining the analytical records", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    await stageV11Day(db(), fixture, await makeV11Day(day, { usage: [v11UsageRecord(day)] }), { quarantine: bindings().QUARANTINE });
    const result = await deleteDueQuarantineObjects(db(), bindings().QUARANTINE, new Date(Date.now() + 1000).toISOString());
    expect(result).toEqual({ deleted: 1, complete: true });
    expect((await bindings().QUARANTINE.list()).objects).toHaveLength(0);
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_v11_records").first<{ n: number }>())?.n).toBe(1);
  });

  it("deletion-safe restore replay removes an activated domain and withdraws its selected analytical records", async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const completed = await runTelemetryV11Sync(runnerOptions(fixture, 2));
    expect(completed.status).toBe("complete");
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_analytical_records WHERE participant_id = ?")
      .bind(fixture.participantId).first<{ n: number }>())?.n).toBe(2);
    expect((await bindings().QUARANTINE.list()).objects).toHaveLength(1);
    await recordDeletionTombstone(bindings().DELETION_LEDGER, fixture.participantId);
    expect(await replayDeletionTombstones(db(), bindings().DELETION_LEDGER, bindings().QUARANTINE))
      .toEqual({ suppressed: 1, complete: true });
    for (const table of ["telemetry_v11_domain_heads", "telemetry_v11_domains", "telemetry_v11_domain_days",
      "telemetry_v11_domain_predecessors", "telemetry_v11_records", "telemetry_v11_chunks", "telemetry_v11_day_manifests",
      "telemetry_v11_device_consents", "attribution_enrollments"]) {
      expect((await db().prepare("SELECT count(*) AS n FROM " + table).first<{ n: number }>())?.n, table).toBe(0);
    }
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_analytical_records WHERE participant_id = ?")
      .bind(fixture.participantId).first<{ n: number }>())?.n).toBe(0);
    expect((await bindings().QUARANTINE.list()).objects).toHaveLength(0);
    expect((await api("/api/v1/device/sync-capabilities", { headers: { authorization: fixture.authorization } })).status).toBe(401);
  });
});
