import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalTelemetryV12Json, parseTelemetryV12DayManifest, parseTelemetryV12DomainManifest,
  telemetryV12RequiredConsent, telemetryV12DomainManifestDigestInput,
} from "@app-usagemonitor/telemetry-contract";
import {
  ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
  ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
  ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
  createTelemetryV12Day, readTelemetryV12Capabilities, runTelemetryV12Sync, telemetryV12FieldInventory,
} from "../src/contribution/index.js";
import { DEPLOYMENT_ENDPOINTS } from "../config/deployment-endpoints.js";

const day = "2026-08-28";
const now = Date.parse(day + "T13:00:00.000Z");
const origin = "https://community.example.test";
const uuid = (number) => "00000000-0000-4000-8000-" + number.toString(16).padStart(12, "0");
const authorization = "Device um_device_" + uuid(1) + "." + "a".repeat(43);
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
});
function usage(index, selectedDay = day) {
  return {
    schemaVersion: "usage-event-v1.0", eventId: "event:v2:" + index.toString(16).padStart(64, "0"),
    eventTime: selectedDay + "T12:05:00.000Z", sessionUuid: "synthetic-session",
    provider: "openai_codex", modelId: "gpt-5.6-sol", speedMode: "standard", apiServiceTier: "default",
    surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription",
    reasoningEffort: "high", agentScope: "root", outcome: "completed", totalInputContextTokens: 100,
    components: { inputUncachedTokens: 10, inputCacheReadTokens: 90, inputCacheWriteTokens: 0,
      outputTextTokens: 20, outputReasoningTokens: 1, outputCombinedTokens: null },
  };
}
function quota(index = 0, selectedDay = day) {
  return {
    observationId: `quota-occurrence:v1:${index.toString(16).padStart(64, "0")}`,
    observedTime: selectedDay + "T12:05:00.000Z", provider: "openai_codex",
    planType: "plus", planVariant: "unknown", limitId: "codex", slot: "secondary",
    usedPercent: 12, windowDurationMinutes: 10_080, resetsAt: "2026-08-31T12:00:00.000Z",
  };
}
function preparedDay(selectedDay = day, count = 1, parserVersion = "synthetic-v12-sync") {
  return createTelemetryV12Day({ day: selectedDay, parserVersion,
    recordsByStream: { usage: Array.from({ length: count }, (_, index) => usage(index, selectedDay)) } });
}

function server({ count = 1, capabilitiesChange = {}, predecessorChange = {}, destinationOrigin = origin } = {}) {
  let sequence = 10;
  const manifests = new Map();
  const envelopes = new Map();
  const authorizations = new Map();
  const calls = [];
  let active = null;
  const capability = {
    schemaVersion: "device-sync-capabilities-v1.2", destinationOrigin,
    enrollmentNamespace: "synthetic_enrollment_namespace", identityVersion: "account-track-v2",
    authorityKind: "social", successor: {
      schemaVersion: "telemetry-contribution-v1.2", envelopeSchemaVersion: "telemetry-envelope-v1.2",
      lifecycle: "accepted", requiredConsent: telemetryV12RequiredConsent(),
      consentCurrent: true, authorizationCurrent: true, activationTime: "2026-08-28T00:00:00.000Z",
    }, ...capabilitiesChange,
  };
  const fetchImpl = async (url, options) => {
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(new URL(url).origin, destinationOrigin);
    const path = new URL(url).pathname;
    const body = options.body === undefined ? null : JSON.parse(options.body);
    calls.push({ path, body });
    if (path === "/api/v1/device/sync-capabilities-v1.2") return json(capability);
    if (path === "/api/v1/me/telemetry-v12/domain-predecessor") {
      assert.deepEqual(body, {});
      return json({
        schemaVersion: "telemetry-domain-predecessor-v1.2", token: uuid(sequence++),
        previousGenerationId: active?.generationId ?? null, legacyFingerprint: "e".repeat(64),
        fromDay: day, throughDay: day, expiresAt: "2026-08-29T13:00:00.000Z", ...predecessorChange,
      }, 201);
    }
    if (path === "/api/v1/device/telemetry/v1.2/day-manifests") {
      parseTelemetryV12DayManifest(body);
      const key = body.day + ":" + body.manifestDigest;
      if (!manifests.has(key)) manifests.set(key, { manifest: body, id: uuid(sequence++), chunks: new Map() });
      const candidate = manifests.get(key);
      return json({ manifestId: candidate.id, day: body.day, manifestDigest: body.manifestDigest,
        state: candidate.chunks.size === body.chunks.length ? "ready" : "staged",
        expectedChunks: body.chunks.length,
        stagedChunks: [...candidate.chunks.values()].map((chunk) => ({
          chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length,
        })),
      }, 201);
    }
    if (path === "/api/v1/device/upload-authorizations") {
      assert.equal(body.telemetrySchemaVersion, "telemetry-contribution-v1.2");
      const uploadAuthorization = "um_device_upload_" + uuid(sequence++) + "." + "b".repeat(43);
      authorizations.set("Upload " + uploadAuthorization, body);
      return json({ uploadAuthorization, expiresAt: "2026-08-28T14:00:00.000Z" }, 201);
    }
    if (path === "/api/v1/contributions") {
      const bound = authorizations.get(options.headers.authorization);
      assert.equal(bound.envelopeDigest, hash(options.body));
      assert.equal(bound.contentLengthBytes, Buffer.byteLength(options.body, "utf8"));
      assert.equal(body.schemaVersion, "telemetry-envelope-v1.2");
      const chunk = envelopes.get(body.ciphertext);
      const candidate = manifests.get(chunk.chunkId.split(":")[1] + ":" + chunk.manifestDigest);
      const replayed = candidate.chunks.has(chunk.chunkId);
      candidate.chunks.set(chunk.chunkId, chunk);
      return json({ schemaVersion: "telemetry-chunk-receipt-v1.2", contributionId: "chunk:" + uuid(sequence++),
        manifestId: candidate.id, chunkId: chunk.chunkId, chunkRevision: 1, status: "staged", replayed,
        recordCounts: { declared: chunk.records.length, accepted: chunk.records.length },
      }, 202);
    }
    if (path === "/api/v1/me/telemetry-v12/domain-activate") {
      parseTelemetryV12DomainManifest(body);
      assert.equal(body.manifestDigest, hash(telemetryV12DomainManifestDigestInput(body)));
      for (const entry of body.days) {
        const candidate = manifests.get(entry.day + ":" + entry.manifestDigest);
        assert.equal(candidate.id, entry.manifestId);
        assert.equal(candidate.chunks.size, candidate.manifest.chunks.length);
      }
      active = { schemaVersion: "telemetry-domain-activation-v1.2", generationId: uuid(sequence++),
        manifestDigest: body.manifestDigest, fromDay: body.fromDay, throughDay: body.throughDay, replay: false };
      return json(active, 201);
    }
    throw new Error("Unexpected synthetic route");
  };
  return {
    calls, manifests, envelopes, capability, active: () => active,
    options: {
      serverBaseUrl: destinationOrigin, deviceAuthorization: authorization, consent: telemetryV12RequiredConsent(),
      days: [day], clock: () => now, readDay: (selectedDay) => preparedDay(selectedDay, selectedDay === day ? count : 0),
      createEnvelope: async (chunk) => {
        assert.ok(Object.isFrozen(chunk.records[0].components));
        const ciphertext = (sequence++).toString(16).padStart(64, "0");
        envelopes.set(ciphertext, chunk);
        return { schemaVersion: "telemetry-envelope-v1.2", synthetic: false, keyId: "key:synthetic-v12",
          wrappedKey: "a".repeat(342), iv: "a".repeat(16), ciphertext };
      },
      fetchImpl,
    },
  };
}

test("v1.2 capabilities are separate, read-only and cannot authorize themselves", async () => {
  const fixture = server();
  assert.deepEqual(await readTelemetryV12Capabilities(fixture.options), fixture.capability);
  assert.deepEqual(fixture.calls.map(({ path }) => path), ["/api/v1/device/sync-capabilities-v1.2"]);
  assert.equal(fixture.manifests.size, 0);
});

test("v1.2 stages, encrypts and acknowledges only a complete successor domain", async () => {
  const fixture = server();
  const result = await runTelemetryV12Sync(fixture.options);
  assert.equal(result.status, "complete");
  assert.equal(result.failure, null);
  assert.equal(result.recordsUploaded, 1);
  assert.equal(result.acknowledgedThroughDay, day);
  assert.ok(fixture.calls.some(({ path }) => path === "/api/v1/me/telemetry-v12/domain-activate"));
  assert.ok(fixture.calls.every(({ path }) => !path.includes("v1.1") && !path.includes("telemetry-v11")));
});

test("v1.2 resumes a partial day without reposting an accepted chunk", async () => {
  const fixture = server({ count: 201 });
  const first = await runTelemetryV12Sync({ ...fixture.options, maxChunks: 1 });
  assert.equal(first.status, "partial");
  assert.equal(first.acknowledgedThroughDay, null);
  const second = await runTelemetryV12Sync(fixture.options);
  assert.equal(second.status, "complete");
  assert.equal(second.chunksUploaded, 1);
  assert.equal(second.chunksSkipped, 1);
  assert.equal(fixture.calls.filter(({ path }) => path === "/api/v1/contributions").length, 2);
});

test("v1.2 rejects legacy consent and legacy capability shapes before preparing data", async () => {
  const fixture = server();
  await assert.rejects(runTelemetryV12Sync({ ...fixture.options,
    consent: { ...telemetryV12RequiredConsent(), telemetrySchemaVersion: "telemetry-contribution-v1.1" } }),
  { code: "contribution_incremental_sync_consent_invalid" });
  assert.equal(fixture.calls.length, 0);
  for (const change of [{ schemaVersion: "device-sync-capabilities-v1.1" }, { extra: true }]) {
    const incompatible = server({ capabilitiesChange: change });
    const result = await runTelemetryV12Sync({ ...incompatible.options, readDay: () => assert.fail("must not prepare") });
    assert.equal(result.failure.code, "response_invalid");
    assert.equal(incompatible.manifests.size, 0);
  }
});

test("staged or ungranted successors cannot use an otherwise valid legacy device", async () => {
  for (const change of [{ lifecycle: "staged", authorizationCurrent: false },
    { consentCurrent: false, authorizationCurrent: false }]) {
    const fixture = server();
    Object.assign(fixture.capability.successor, change);
    const result = await runTelemetryV12Sync({ ...fixture.options, readDay: () => assert.fail("must not prepare") });
    assert.equal(result.failure.code, "consent_rejected");
    assert.equal(fixture.manifests.size, 0);
  }
});

test("accountless v1.2 requires its separate exact policy tuple", async () => {
  const localOrigin = "http://127.0.0.1:9876";
  const fixture = server({ destinationOrigin: localOrigin, capabilitiesChange: { authorityKind: "accountless" } });
  fixture.capability.successor.consentCurrent = false;
  const { consent: unused, ...options } = fixture.options;
  void unused;
  const authority = { schemaVersion: ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
    policyVersion: ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
    telemetrySchemaVersion: "telemetry-contribution-v1.2" };
  await assert.rejects(runTelemetryV12Sync({ ...options, laboratory: true,
    authorization: { ...authority, telemetrySchemaVersion: "telemetry-contribution-v1.1" } }),
  { code: "contribution_incremental_sync_authorization_invalid" });
  assert.equal(fixture.calls.length, 0);
  const result = await runTelemetryV12Sync({ ...options, laboratory: true, authorization: authority });
  assert.equal(result.status, "complete");
});


test("a changed collection cutoff fences final activation and invalidates the resumed context", async () => {
  const fixture = server();
  const result = await runTelemetryV12Sync({ ...fixture.options,
    readDay: async (selectedDay, context) => {
      assert.equal(context.activationTime, "2026-08-28T00:00:00.000Z");
      return fixture.options.readDay(selectedDay, context);
    },
    createEnvelope: async (chunk) => {
      const envelope = await fixture.options.createEnvelope(chunk);
      fixture.capability.successor.activationTime = "2026-08-28T01:00:00.000Z";
      return envelope;
    } });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "revision_conflict");
  assert.ok(fixture.calls.every(({ path }) => !path.endsWith("/domain-activate")));
});


test("transient gateway responses retry with bounded delays and discard rejected bodies", async () => {
  for (const status of [408, 429, 502, 503]) {
    for (const headers of [{ "content-type": "text/html" }, { "content-type": "application/json", "cache-control": "no-store" }]) {
      let cancelled = false;
      const fixture = server();
      const result = await runTelemetryV12Sync({ ...fixture.options, fetchImpl: async () => new Response(
        new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode("<html>synthetic gateway error</html>")); },
          pull(controller) { controller.close(); },
          cancel() { cancelled = true; },
        }), { status, headers: { ...headers, "retry-after": "60" } },
      ) });
      assert.equal(result.failure.code, "service_unavailable");
      assert.equal(result.failure.retryable, true);
      assert.equal(result.failure.retryAfterMilliseconds, 60_000);
      assert.equal(result.acknowledgedThroughDay, null);
      assert.equal(result.chunksUploaded, 0);
      if (status !== 429 || headers["content-type"] === "text/html") assert.equal(cancelled, true);
    }
  }
  for (const [header, delay] of [["999999999", 604_800_000], ["invalid", null],
    ["Fri, 28 Aug 2026 13:01:00 GMT", 60_000]]) {
    const result = await runTelemetryV12Sync({ ...server().options,
      fetchImpl: async () => new Response(null, { status: 503, headers: { "retry-after": header } }) });
    assert.equal(result.failure.retryAfterMilliseconds, delay);
  }
});

test("body IO interruptions retry while malformed successful receipts and redirects stay terminal", async () => {
  for (const kind of ["io", "json", "utf8", "redirect", "redirect503", "401", "403"]) {
    const response = new Response(new ReadableStream({
      start(controller) {
        if (kind === "io") controller.error(new Error("private-synthetic-body-error"));
        else {
          controller.enqueue(kind === "utf8" ? Uint8Array.of(0xff) : new TextEncoder().encode('{"incomplete":'));
          controller.close();
        }
      },
    }), { status: kind === "redirect503" ? 503 : ["401", "403"].includes(kind) ? Number(kind) : 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (kind.startsWith("redirect")) Object.defineProperty(response, "redirected", { value: true });
    const result = await runTelemetryV12Sync({ ...server().options, fetchImpl: async () => response });
    assert.equal(result.failure.code, kind === "io" ? "service_unavailable" : "response_invalid", kind);
    assert.equal(result.failure.retryable, kind === "io", kind);
    assert.equal(result.acknowledgedThroughDay, null);
    assert.equal(JSON.stringify(result).includes("private-synthetic"), false);
  }
});


test("an interrupted upload acknowledgement retries through server replay without double contribution", async () => {
  const fixture = server();
  let lostReceipt = false;
  const first = await runTelemetryV12Sync({ ...fixture.options, fetchImpl: async (url, request) => {
    const receipt = await fixture.options.fetchImpl(url, request);
    if (new URL(url).pathname === "/api/v1/contributions" && !lostReceipt) {
      lostReceipt = true;
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error("synthetic-connection-reset")); },
      }), { status: receipt.status, headers: receipt.headers });
    }
    return receipt;
  } });
  assert.equal(first.failure.code, "service_unavailable");
  assert.equal(first.failure.retryable, true);
  assert.equal(first.acknowledgedThroughDay, null);
  assert.equal(first.chunksUploaded, 0);
  const second = await runTelemetryV12Sync(fixture.options);
  assert.equal(second.status, "complete");
  assert.equal(second.acknowledgedThroughDay, day);
  assert.ok(second.chunksSkipped >= 1);
  assert.equal(fixture.calls.filter((call) => call.path === "/api/v1/contributions").length, 1);
});
