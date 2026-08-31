import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parseTelemetryV11DayManifest, parseTelemetryV11DomainManifest, telemetryV11RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { ensureContributionDeviceCapability } from "../../src/contribution-device-capability.js";
import {
  ATTRIBUTION_FIXTURE_BINDING, ATTRIBUTION_FIXTURE_DAY, ATTRIBUTION_FIXTURE_DEVICE_ID, ATTRIBUTION_FIXTURE_START,
} from "./local-attribution-fixture.js";

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const digest = (text) => createHash("sha256").update(text).digest("hex");
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

export async function createAttributionFixtureDevice(stateFile, origin = ATTRIBUTION_FIXTURE_BINDING.destinationOrigin) {
  let value = null;
  const backend = {
    async read() { return value === null ? null : Buffer.from(value); },
    async createIfMissing(_capability, secret) { if (value !== null) return "existing"; value = Buffer.from(secret); return "created"; },
    async deleteExact() { value?.fill(0); value = null; return "deleted"; },
  };
  await ensureContributionDeviceCapability({ backend, stateFile, origin,
    generateDeviceId: () => ATTRIBUTION_FIXTURE_DEVICE_ID, generateSecret: () => Buffer.alloc(32, 31),
    clock: () => ATTRIBUTION_FIXTURE_START });
  return backend;
}

/** In-memory protocol fixture. Crypto and hosted-route suites test their own
 * implementations; this fixture asserts exact local integration requests. */
export function createAttributionFixtureService({ accepted = true, granted = true,
  fromDay = ATTRIBUTION_FIXTURE_DAY, throughDay = ATTRIBUTION_FIXTURE_DAY } = {}) {
  const manifests = new Map();
  const envelopes = new Map();
  const authorizations = new Map();
  const calls = [];
  let sequence = 10;
  let active = null;
  const capability = {
    schemaVersion: "device-sync-capabilities-v1.1", ...ATTRIBUTION_FIXTURE_BINDING,
    identityVersion: "account-track-v2", minimumWriteRank: granted ? 11 : 10, policyRevision: 1,
    requiredConsent: telemetryV11RequiredConsent(), consentCurrent: granted,
    formats: [
      { schemaVersion: "telemetry-contribution-v0.1", rank: 1, lifecycle: "accepted" },
      { schemaVersion: "telemetry-contribution-v0.2", rank: 2, lifecycle: "blocked" },
      { schemaVersion: "telemetry-contribution-v1.0", rank: 10, lifecycle: "accepted" },
      { schemaVersion: "telemetry-contribution-v1.1", rank: 11, lifecycle: accepted ? "accepted" : "staged" },
    ],
  };
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body === undefined || options.body === null ? null : JSON.parse(options.body);
    const headers = new Headers(options.headers);
    calls.push({ path, body });
    if (path === "/api/v1/me/device-telemetry-consents") {
      assert.equal(headers.get("authorization"), null);
      assert.equal(headers.get("cookie"), "__Host-usage_monitor_session=synthetic_session");
      assert.equal(headers.get("x-usage-monitor-csrf"), "synthetic_csrf_0001");
      assert.deepEqual(body, { deviceId: ATTRIBUTION_FIXTURE_DEVICE_ID, consent: telemetryV11RequiredConsent(), ongoingUpload: true });
      if (!accepted) return json({ error: { code: "TELEMETRY_TRANSPORT_BLOCKED" } }, 403);
      capability.consentCurrent = true;
      capability.minimumWriteRank = 11;
      capability.policyRevision += 1;
      return json({ consent: telemetryV11RequiredConsent(), minimumWriteRank: 11 }, 201);
    }
    if (path === "/api/v1/envelope-key") return json({ algorithm: "RSA-OAEP-256", keyId: "key:synthetic", publicJwk: { kty: "RSA" } });
    if (path !== "/api/v1/contributions") assert.match(headers.get("authorization") ?? "", /^Device um_device_[0-9a-f-]+\.[A-Za-z0-9_-]{43}$/u);
    if (path === "/api/v1/device/sync-capabilities") return json(capability);
    if (path === "/api/v1/me/telemetry-v11/domain-predecessor") return json({
      schemaVersion: "telemetry-domain-predecessor-v1.1", token: uuid(sequence++),
      previousGenerationId: active?.generationId ?? null, legacyFingerprint: "e".repeat(64),
      fromDay, throughDay,
      expiresAt: new Date(ATTRIBUTION_FIXTURE_START + 86_400_000).toISOString(),
    }, 201);
    if (path === "/api/v1/device/telemetry/v1.1/day-manifests") {
      parseTelemetryV11DayManifest(body);
      const key = `${body.day}:${body.manifestDigest}`;
      if (!manifests.has(key)) manifests.set(key, { manifest: body, id: uuid(sequence++), chunks: new Map() });
      const candidate = manifests.get(key);
      return json({ manifestId: candidate.id, day: body.day, manifestDigest: body.manifestDigest,
        state: candidate.chunks.size === body.chunks.length ? "ready" : "staged", expectedChunks: body.chunks.length,
        stagedChunks: [...candidate.chunks.values()].map((chunk) => ({ chunkId: chunk.chunkId,
          chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length })) }, 201);
    }
    if (path === "/api/v1/device/upload-authorizations") {
      assert.equal(body.telemetrySchemaVersion, "telemetry-contribution-v1.1");
      const uploadAuthorization = `um_device_upload_${uuid(sequence++)}.${"b".repeat(43)}`;
      authorizations.set(`Upload ${uploadAuthorization}`, body);
      return json({ uploadAuthorization, expiresAt: new Date(ATTRIBUTION_FIXTURE_START + 3_600_000).toISOString() }, 201);
    }
    if (path === "/api/v1/contributions") {
      const authorization = authorizations.get(headers.get("authorization"));
      assert.equal(authorization.envelopeDigest, digest(options.body));
      assert.equal(authorization.contentLengthBytes, Buffer.byteLength(options.body));
      const chunk = envelopes.get(body.ciphertext);
      const candidate = manifests.get(`${chunk.chunkId.split(":")[1]}:${chunk.manifestDigest}`);
      candidate.chunks.set(chunk.chunkId, chunk);
      return json({ schemaVersion: "telemetry-chunk-receipt-v1.1", contributionId: `chunk:${uuid(sequence++)}`,
        manifestId: candidate.id, chunkId: chunk.chunkId, chunkRevision: 1, status: "staged", replayed: false,
        recordCounts: { declared: chunk.records.length, accepted: chunk.records.length } }, 202);
    }
    if (path === "/api/v1/me/telemetry-v11/domain-activate") {
      parseTelemetryV11DomainManifest(body);
      for (const entry of body.days) {
        const candidate = manifests.get(`${entry.day}:${entry.manifestDigest}`);
        assert.equal(candidate?.id, entry.manifestId);
        assert.equal(candidate.chunks.size, candidate.manifest.chunks.length);
      }
      active = { schemaVersion: "telemetry-domain-activation-v1.1", generationId: uuid(sequence++),
        manifestDigest: body.manifestDigest, fromDay: body.fromDay, throughDay: body.throughDay, replay: false };
      return json(active, 201);
    }
    throw new Error("Unexpected synthetic integration route");
  };
  return {
    capability, calls, envelopes, active: () => active, fetchImpl,
    async createEnvelope({ chunk }) {
      const ciphertext = Buffer.from(String(sequence++).padStart(32, "0")).toString("base64url");
      envelopes.set(ciphertext, chunk);
      return { schemaVersion: "telemetry-envelope-v1.1", synthetic: false, keyId: "key:synthetic",
        wrappedKey: "a".repeat(342), iv: "a".repeat(16), ciphertext };
    },
  };
}
