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

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("synthetic-request-aborted")); return; }
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("synthetic-request-aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

// The synthetic predecessor follows the Worker contract: its range is the
// device's ready days, seeded with the current day while none is ready, and its
// fingerprint pins only the active generation. The two legacy switches restore
// the earlier server contract (refuse a device without a ready day; fingerprint
// its ready days) so the client-visible consequence of each stays tested.
function server({ count = 1, capabilitiesChange = {}, predecessorChange = {}, destinationOrigin = origin,
  refuseWithoutReadyDay = false, fingerprintReadyDays = false, idempotentActivationReplay = false } = {}) {
  let sequence = 10;
  const manifests = new Map();
  const envelopes = new Map();
  const authorizations = new Map();
  const calls = [];
  let active = null;
  let activeDays = null;
  let activationCommits = 0;
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
      const readyDays = [...manifests.values()]
        .filter((candidate) => candidate.chunks.size === candidate.manifest.chunks.length)
        .map((candidate) => candidate.manifest.day).sort();
      if (refuseWithoutReadyDay && readyDays.length === 0) {
        return json({ error: { code: "TELEMETRY_MANIFEST_INCOMPLETE" } }, 409);
      }
      const known = readyDays.length ? readyDays : [new Date(now).toISOString().slice(0, 10)];
      return json({
        schemaVersion: "telemetry-domain-predecessor-v1.2", token: uuid(sequence++),
        previousGenerationId: active?.generationId ?? null,
        legacyFingerprint: hash(JSON.stringify([active?.generationId ?? null,
          ...(fingerprintReadyDays ? readyDays : [])])),
        fromDay: known[0], throughDay: known.at(-1), expiresAt: "2026-08-29T13:00:00.000Z", ...predecessorChange,
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
      const requestedDays = body.days.map(({ day: selectedDay, manifestDigest }) => ({ day: selectedDay, manifestDigest }));
      if (idempotentActivationReplay && active !== null
          && active.fromDay === body.fromDay && active.throughDay === body.throughDay
          && JSON.stringify(activeDays) === JSON.stringify(requestedDays)) {
        return json({ ...active, replay: true, unchanged: true, requestedManifestDigest: body.manifestDigest }, 200);
      }
      active = { schemaVersion: "telemetry-domain-activation-v1.2", generationId: uuid(sequence++),
        manifestDigest: body.manifestDigest, fromDay: body.fromDay, throughDay: body.throughDay, replay: false };
      activeDays = requestedDays;
      activationCommits += 1;
      return json(active, 201);
    }
    throw new Error("Unexpected synthetic route");
  };
  return {
    calls, manifests, envelopes, capability, active: () => active,
    activationCommits: () => activationCommits,
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

test("v1.2 activation uses its longer request bound without extending ordinary requests", async () => {
  const fixture = server();
  let activationDuration = 0;
  const result = await runTelemetryV12Sync({ ...fixture.options,
    requestTimeoutMs: 100, activationRequestTimeoutMs: 1_000, maxDurationMs: 1_500,
    fetchImpl: async (url, request) => {
      if (new URL(url).pathname === "/api/v1/me/telemetry-v12/domain-activate") {
        const activationStart = Date.now();
        await abortableDelay(150, request.signal);
        activationDuration = Date.now() - activationStart;
      }
      return fixture.options.fetchImpl(url, request);
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.failure, null);
  assert.ok(activationDuration >= 130);

  const ordinary = server();
  let ordinaryAborted = false;
  let prepared = false;
  const bounded = await runTelemetryV12Sync({ ...ordinary.options,
    requestTimeoutMs: 100, activationRequestTimeoutMs: 1_000, maxDurationMs: 1_500,
    readDay: () => { prepared = true; return ordinary.options.readDay(day); },
    fetchImpl: async (url, request) => {
      if (new URL(url).pathname === "/api/v1/device/sync-capabilities-v1.2") {
        try { await abortableDelay(300, request.signal); }
        catch { ordinaryAborted = request.signal.aborted; throw new Error("synthetic-request-aborted"); }
      }
      return ordinary.options.fetchImpl(url, request);
    },
  });
  assert.equal(bounded.failure.code, "service_unavailable");
  assert.equal(bounded.failure.retryable, true);
  assert.equal(ordinaryAborted, true);
  assert.equal(prepared, false);
});

test("predecessor renewal covers the activation horizon but never exceeds remaining pass time", async () => {
  for (const { maxDurationMs, expectedPredecessorReads } of [
    { maxDurationMs: 60_000, expectedPredecessorReads: 2 },
    { maxDurationMs: 20_000, expectedPredecessorReads: 1 },
  ]) {
    const fixture = server({ predecessorChange: {
      expiresAt: new Date(now + 30_000).toISOString(),
    } });
    const result = await runTelemetryV12Sync({ ...fixture.options,
      requestTimeoutMs: 15_000, activationRequestTimeoutMs: 60_000, maxDurationMs,
    });
    assert.equal(result.status, "complete");
    const predecessorIndexes = fixture.calls.flatMap(({ path }, index) =>
      path.endsWith("/domain-predecessor") ? [index] : []);
    const activationIndex = fixture.calls.findIndex(({ path }) => path.endsWith("/domain-activate"));
    assert.equal(predecessorIndexes.length, expectedPredecessorReads);
    assert.ok(predecessorIndexes.at(-1) < activationIndex);
  }
});

test("v1.2 activation still obeys the whole-pass deadline and caller cancellation", async () => {
  const passFixture = server();
  let passActivationStarted = false;
  let passActivationAborted = false;
  const passBounded = await runTelemetryV12Sync({ ...passFixture.options,
    requestTimeoutMs: 100, activationRequestTimeoutMs: 60_000, maxDurationMs: 1_500,
    fetchImpl: async (url, request) => {
      if (new URL(url).pathname === "/api/v1/me/telemetry-v12/domain-activate") {
        passActivationStarted = true;
        try { await abortableDelay(5_000, request.signal); }
        catch { passActivationAborted = request.signal.aborted; throw new Error("synthetic-request-aborted"); }
      }
      return passFixture.options.fetchImpl(url, request);
    },
  });
  assert.equal(passBounded.status, "partial");
  assert.equal(passBounded.failure, null);
  assert.equal(passBounded.acknowledgedThroughDay, null);
  assert.equal(passActivationStarted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passActivationAborted, true);

  const abortFixture = server();
  const controller = new AbortController();
  let notifyActivation;
  const activationStarted = new Promise((resolve) => { notifyActivation = resolve; });
  let callerAbortReachedRequest = false;
  const pending = runTelemetryV12Sync({ ...abortFixture.options,
    signal: controller.signal, requestTimeoutMs: 100, activationRequestTimeoutMs: 60_000, maxDurationMs: 5_000,
    fetchImpl: async (url, request) => {
      if (new URL(url).pathname === "/api/v1/me/telemetry-v12/domain-activate") {
        notifyActivation();
        try { await abortableDelay(5_000, request.signal); }
        catch { callerAbortReachedRequest = request.signal.aborted; throw new Error("synthetic-request-aborted"); }
      }
      return abortFixture.options.fetchImpl(url, request);
    },
  });
  await activationStarted;
  controller.abort();
  const interrupted = await pending;
  assert.equal(interrupted.status, "partial");
  assert.equal(interrupted.failure.code, "interrupted");
  assert.equal(interrupted.failure.retryable, true);
  assert.equal(interrupted.acknowledgedThroughDay, null);
  assert.equal(callerAbortReachedRequest, true);
});

test("activation timeout overrides are bounded to v1.2 accountless request limits", async () => {
  const fixture = server();
  await assert.rejects(runTelemetryV12Sync({ ...fixture.options, activationRequestTimeoutMs: 60_001 }),
    { code: "contribution_incremental_sync_invalid_configuration" });
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

function recordedPredecessors(fixture) {
  const responses = [];
  return {
    responses,
    fetchImpl: async (url, request) => {
      const response = await fixture.options.fetchImpl(url, request);
      if (new URL(url).pathname === "/api/v1/me/telemetry-v12/domain-predecessor") {
        responses.push({ status: response.status, body: await response.clone().json() });
      }
      return response;
    },
  };
}

function journalOptions() {
  let saved = null;
  return {
    current: () => saved,
    options: {
      progressStore: { read: async () => saved, write: async (value) => { saved = value; } },
      sourcePublication: { fingerprint: "synthetic-v12-publication", parserVersion: "synthetic-v12-sync" },
    },
  };
}

test("a never-uploaded install bootstraps its first domain and keeps the journal's pin", async () => {
  const fixture = server();
  const recorded = recordedPredecessors(fixture);
  const journal = journalOptions();
  const result = await runTelemetryV12Sync({ ...fixture.options, ...journal.options,
    days: ["2026-08-27", day], readDay: (selectedDay) => preparedDay(selectedDay, 1),
    fetchImpl: recorded.fetchImpl });
  assert.equal(result.status, "complete");
  assert.equal(result.failure, null);
  assert.equal(result.chunksUploaded, 2);
  assert.equal(result.acknowledgedThroughDay, day);
  assert.equal(journal.current(), null);
  // Before staging: nothing is ready, so the range is the current day. After
  // staging: the range is the run's own ready days, under the same pin.
  assert.deepEqual(recorded.responses.map(({ status, body }) => [status, body.fromDay, body.throughDay]),
    [[201, day, day], [201, "2026-08-27", day]]);
  assert.equal(recorded.responses[1].body.legacyFingerprint, recorded.responses[0].body.legacyFingerprint);
});

test("a predecessor refused until a day is ready strands a never-uploaded install", async () => {
  const fixture = server({ refuseWithoutReadyDay: true });
  for (let pass = 0; pass < 2; pass += 1) {
    const result = await runTelemetryV12Sync(fixture.options);
    assert.equal(result.status, "failed");
    assert.equal(result.failure.code, "revision_conflict");
    assert.equal(result.failure.retryable, true);
    assert.equal(result.chunksUploaded, 0);
  }
  assert.equal(fixture.manifests.size, 0);
  assert.ok(fixture.calls.every(({ path }) => path !== "/api/v1/contributions"));
});

test("a fingerprint that moves when the run's own days become ready fails the journal's final check", async () => {
  const fixture = server({ fingerprintReadyDays: true });
  const journal = journalOptions();
  const result = await runTelemetryV12Sync({ ...fixture.options, ...journal.options });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "revision_conflict");
  assert.equal(result.chunksUploaded, 1);
  assert.equal(fixture.active(), null);
  assert.ok(fixture.calls.every(({ path }) => !path.endsWith("/domain-activate")));
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

test("a committed activation with a dropped receipt replays without creating another head", async () => {
  const fixture = server({ idempotentActivationReplay: true });
  let lostReceipt = false;
  const fetchImpl = async (url, request) => {
    const response = await fixture.options.fetchImpl(url, request);
    if (new URL(url).pathname === "/api/v1/me/telemetry-v12/domain-activate" && !lostReceipt) {
      lostReceipt = true;
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error("synthetic-activation-connection-reset")); },
      }), { status: response.status, headers: response.headers });
    }
    return response;
  };
  const first = await runTelemetryV12Sync({ ...fixture.options, fetchImpl });
  assert.equal(first.failure.code, "service_unavailable");
  assert.equal(first.failure.retryable, true);
  assert.equal(first.acknowledgedThroughDay, null);
  const committedGeneration = fixture.active().generationId;
  assert.equal(fixture.activationCommits(), 1);

  const second = await runTelemetryV12Sync({ ...fixture.options, fetchImpl });
  assert.equal(second.status, "complete");
  assert.equal(second.domainGenerationId, committedGeneration);
  assert.equal(second.acknowledgedThroughDay, day);
  assert.ok(second.chunksSkipped >= 1);
  assert.equal(fixture.activationCommits(), 1);
  assert.equal(fixture.calls.filter(({ path }) => path === "/api/v1/contributions").length, 1);
  assert.equal(fixture.calls.filter(({ path }) => path.endsWith("/domain-activate")).length, 2);
});

test("a noncommitted activation retry preserves staged chunks and commits once", async () => {
  const fixture = server();
  let refusedBeforeCommit = true;
  const first = await runTelemetryV12Sync({ ...fixture.options,
    fetchImpl: async (url, request) => {
      if (new URL(url).pathname === "/api/v1/me/telemetry-v12/domain-activate" && refusedBeforeCommit) {
        refusedBeforeCommit = false;
        return json({ error: { code: "SERVICE_UNAVAILABLE" } }, 503);
      }
      return fixture.options.fetchImpl(url, request);
    },
  });
  assert.equal(first.failure.code, "service_unavailable");
  assert.equal(first.failure.retryable, true);
  assert.equal(first.chunksUploaded, 1);
  assert.equal(fixture.active(), null);
  assert.equal(fixture.activationCommits(), 0);

  const second = await runTelemetryV12Sync(fixture.options);
  assert.equal(second.status, "complete");
  assert.ok(second.chunksSkipped >= 1);
  assert.equal(fixture.activationCommits(), 1);
  assert.equal(fixture.calls.filter(({ path }) => path === "/api/v1/contributions").length, 1);
});
