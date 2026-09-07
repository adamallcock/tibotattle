import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalTelemetryV11Json, parseTelemetryV11DayManifest, parseTelemetryV11DomainManifest,
  telemetryV11RequiredConsent, telemetryV11DomainManifestDigestInput,
} from "@app-usagemonitor/telemetry-contract";
import {
  createTelemetryV11Day, readTelemetryV11Capabilities, runTelemetryV11Sync, telemetryV11FieldInventory,
} from "../src/contribution/index.js";

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
function preparedDay(selectedDay = day, count = 1, parserVersion = "synthetic-v11-sync") {
  return createTelemetryV11Day({ day: selectedDay, parserVersion,
    recordsByStream: { usage: Array.from({ length: count }, (_, index) => usage(index, selectedDay)) } });
}

function server({ count = 1, capabilitiesChange = {}, predecessorChange = {} } = {}) {
  let sequence = 10;
  const manifests = new Map();
  const envelopes = new Map();
  const authorizations = new Map();
  const calls = [];
  let active = null;
  const capability = {
    schemaVersion: "device-sync-capabilities-v1.1", destinationOrigin: origin,
    enrollmentNamespace: "synthetic_enrollment_namespace", identityVersion: "account-track-v2",
    minimumWriteRank: 11, policyRevision: 1, requiredConsent: telemetryV11RequiredConsent(), consentCurrent: true,
    formats: [
      { schemaVersion: "telemetry-contribution-v0.1", rank: 1, lifecycle: "accepted" },
      { schemaVersion: "telemetry-contribution-v0.2", rank: 2, lifecycle: "blocked" },
      { schemaVersion: "telemetry-contribution-v1.0", rank: 10, lifecycle: "accepted" },
      { schemaVersion: "telemetry-contribution-v1.1", rank: 11, lifecycle: "accepted" },
    ],
    ...capabilitiesChange,
  };
  const fetchImpl = async (url, options) => {
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(new URL(url).origin, origin);
    const path = new URL(url).pathname;
    const body = options.body === undefined ? null : JSON.parse(options.body);
    calls.push({ path, body });
    if (path === "/api/v1/device/sync-capabilities") return json(capability);
    if (path === "/api/v1/me/telemetry-v11/domain-predecessor") {
      assert.deepEqual(body, {});
      return json({
        schemaVersion: "telemetry-domain-predecessor-v1.1", token: uuid(sequence++),
        previousGenerationId: active?.generationId ?? null, legacyFingerprint: "e".repeat(64),
        fromDay: day, throughDay: day, expiresAt: "2026-08-29T13:00:00.000Z", ...predecessorChange,
      }, 201);
    }
    if (path === "/api/v1/device/telemetry/v1.1/day-manifests") {
      parseTelemetryV11DayManifest(body);
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
      assert.equal(body.telemetrySchemaVersion, "telemetry-contribution-v1.1");
      const uploadAuthorization = "um_device_upload_" + uuid(sequence++) + "." + "b".repeat(43);
      authorizations.set("Upload " + uploadAuthorization, body);
      return json({ uploadAuthorization, expiresAt: "2026-08-28T14:00:00.000Z" }, 201);
    }
    if (path === "/api/v1/contributions") {
      const bound = authorizations.get(options.headers.authorization);
      assert.equal(bound.envelopeDigest, hash(options.body));
      assert.equal(bound.contentLengthBytes, Buffer.byteLength(options.body, "utf8"));
      assert.equal(body.schemaVersion, "telemetry-envelope-v1.1");
      const chunk = envelopes.get(body.ciphertext);
      const candidate = manifests.get(chunk.chunkId.split(":")[1] + ":" + chunk.manifestDigest);
      const replayed = candidate.chunks.has(chunk.chunkId);
      candidate.chunks.set(chunk.chunkId, chunk);
      return json({ schemaVersion: "telemetry-chunk-receipt-v1.1", contributionId: "chunk:" + uuid(sequence++),
        manifestId: candidate.id, chunkId: chunk.chunkId, chunkRevision: 1, status: "staged", replayed,
        recordCounts: { declared: chunk.records.length, accepted: chunk.records.length },
      }, 202);
    }
    if (path === "/api/v1/me/telemetry-v11/domain-activate") {
      parseTelemetryV11DomainManifest(body);
      assert.equal(body.manifestDigest, hash(telemetryV11DomainManifestDigestInput(body)));
      for (const entry of body.days) {
        const candidate = manifests.get(entry.day + ":" + entry.manifestDigest);
        assert.equal(candidate.id, entry.manifestId);
        assert.equal(candidate.chunks.size, candidate.manifest.chunks.length);
      }
      active = { schemaVersion: "telemetry-domain-activation-v1.1", generationId: uuid(sequence++),
        manifestDigest: body.manifestDigest, fromDay: body.fromDay, throughDay: body.throughDay, replay: false };
      return json(active, 201);
    }
    throw new Error("Unexpected synthetic route");
  };
  return {
    calls, manifests, envelopes, capability, active: () => active,
    options: {
      serverBaseUrl: origin, deviceAuthorization: authorization, consent: telemetryV11RequiredConsent(),
      days: [day], clock: () => now, readDay: (selectedDay) => preparedDay(selectedDay, selectedDay === day ? count : 0),
      createEnvelope: async (chunk) => {
        assert.ok(Object.isFrozen(chunk.records[0].components));
        const ciphertext = (sequence++).toString(16).padStart(64, "0");
        envelopes.set(ciphertext, chunk);
        return { schemaVersion: "telemetry-envelope-v1.1", synthetic: false, keyId: "key:synthetic-v11",
          wrappedKey: "a".repeat(342), iv: "a".repeat(16), ciphertext };
      },
      fetchImpl,
    },
  };
}

function progressJournal() {
  let serialized = null;
  const writes = [];
  // A new port on every pass models a restart: the runner cannot rely on a
  // retained mutable array or other process memory to find the next day.
  return {
    writes,
    read: () => serialized === null ? null : JSON.parse(serialized),
    replace: (value) => { serialized = value === null ? null : JSON.stringify(value); },
    port: () => ({
      read: async () => serialized === null ? null : JSON.parse(serialized),
      write: async (value) => {
        if (value !== null) assert.ok(Object.isFrozen(value.days));
        serialized = value === null ? null : JSON.stringify(value);
        writes.push(serialized);
      },
    }),
  };
}

function longHistoryFixture() {
  const before = { fromDay: "2026-06-28", throughDay: day };
  const fixture = server({ count: 0, predecessorChange: before });
  let time = now;
  const reads = [];
  const sourcePublication = { fingerprint: "synthetic-source-one", parserVersion: "synthetic-v11-sync" };
  return { ...fixture, before, reads, sourcePublication,
    advance: (milliseconds) => { time += milliseconds; },
    options: { ...fixture.options, sourcePublication, days: [before.fromDay, day],
      clock: () => time,
      readDay: (selectedDay) => { reads.push(selectedDay); return preparedDay(selectedDay, 0); },
      fetchImpl: async (url, options) => {
        // Logical latency, not a slow test. Even the empty, already-ready
        // manifests used to consume every future pass's entire time budget.
        time += 1_000;
        return fixture.options.fetchImpl(url, options);
      },
    },
  };
}

test("successor field inventory is immutable, content-free and digest-bound", () => {
  const inventory = telemetryV11FieldInventory();
  const { inventoryDigest, ...base } = inventory;
  assert.equal(inventoryDigest, hash(canonicalTelemetryV11Json(base)));
  assert.deepEqual(inventory.consent, telemetryV11RequiredConsent());
  assert.deepEqual(inventory.fields.accountPlanAttribution, ["accountBasis", "accountTrackId", "planBasis", "planType", "planEraId"]);
  assert.ok(Object.isFrozen(inventory.fields.usage));
  assert.equal(JSON.stringify(inventory).includes("rawAccount"), false);
});

test("read-only capability preflight does not require consent or call a write route", async () => {
  const fixture = server({ capabilitiesChange: { consentCurrent: false } });
  const capability = await readTelemetryV11Capabilities(fixture.options);
  assert.equal(capability.consentCurrent, false);
  assert.ok(Object.isFrozen(capability.formats[0]));
  assert.deepEqual(fixture.calls.map((call) => call.path), ["/api/v1/device/sync-capabilities"]);
});

test("missing, old, broadened and malformed local consent fail before any network or reader", async () => {
  for (const consent of [undefined, null, {}, { ...telemetryV11RequiredConsent(), extra: true },
    { ...telemetryV11RequiredConsent(), telemetrySchemaVersion: "telemetry-contribution-v1.0" }]) {
    const fixture = server();
    await assert.rejects(runTelemetryV11Sync({ ...fixture.options, consent }), { code: "contribution_incremental_sync_consent_invalid" });
    assert.equal(fixture.calls.length, 0);
  }
});

test("staged lifecycle and ungranted devices stop before projection or staging", async () => {
  for (const grant of [false, true]) {
    const fixture = server({ capabilitiesChange: { consentCurrent: grant } });
    if (grant) fixture.capability.formats.at(-1).lifecycle = "staged";
    const result = await runTelemetryV11Sync({ ...fixture.options, readDay: () => assert.fail("must not read") });
    assert.equal(result.status, "failed");
    assert.equal(result.failure.code, "consent_rejected");
    assert.equal(result.networkActivity, true);
    assert.equal(result.acknowledgedThroughDay, null);
    assert.equal(fixture.calls.length, 1);
  }
});

test("one pass stages exact chunks then acknowledges only the atomic domain receipt", async () => {
  const fixture = server({ count: 201 });
  const result = await runTelemetryV11Sync(fixture.options);
  assert.deepEqual(result, {
    schemaVersion: "incremental-contribution-sync-run-v1.0", status: "complete", daysTotal: 1, daysSynced: 1, daysPending: 0,
    chunksUploaded: 2, chunksSkipped: 0, recordsUploaded: 201, stagedDays: 1,
    acknowledgedThroughDay: day, domainGenerationId: fixture.active().generationId, orphanChunkIds: [],
    failure: null, networkActivity: true,
  });
  assert.equal(fixture.calls.at(-1).path, "/api/v1/me/telemetry-v11/domain-activate");
});

test("partial chunk budgets retain no watermark, and a retry skips the exact staged prefix", async () => {
  const fixture = server({ count: 201 });
  const first = await runTelemetryV11Sync({ ...fixture.options, maxChunks: 1 });
  assert.equal(first.status, "partial");
  assert.equal(first.chunksUploaded, 1);
  assert.equal(first.daysSynced, 0);
  assert.equal(first.acknowledgedThroughDay, null);
  assert.equal(fixture.active(), null);
  const second = await runTelemetryV11Sync({ ...fixture.options, maxChunks: 1 });
  assert.equal(second.status, "complete");
  assert.equal(second.chunksUploaded, 1);
  assert.equal(second.chunksSkipped, 1);
  assert.equal(second.recordsUploaded, 1);
  assert.equal(fixture.manifests.size, 1);
});

test("a durable day cursor lets 62 days finish across bounded passes and process restarts", async () => {
  const fixture = longHistoryFixture();
  const journal = progressJournal();
  const first = await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port() });
  assert.equal(first.status, "partial");
  assert.equal(first.daysTotal, 62);
  assert.equal(first.daysSynced, 0);
  assert.equal(first.acknowledgedThroughDay, null);
  assert.equal(fixture.active(), null);
  const saved = journal.read();
  assert.equal(saved.schemaVersion, "telemetry-v11-sync-progress-v1");
  assert.equal(saved.days.length, 57);
  assert.deepEqual(saved.days.map((entry) => entry.day), fixture.reads.slice(0, 57));
  assert.match(saved.contextDigest, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(saved), /authorization|um_device_|enrollmentNamespace|token|expiresAt|\/Users\//iu);
  const readCount = fixture.reads.length;
  const second = await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port() });
  assert.equal(second.status, "complete");
  assert.equal(second.daysSynced, 62);
  assert.equal(second.daysPending, 0);
  assert.equal(second.stagedDays, 62);
  assert.equal(second.acknowledgedThroughDay, day);
  assert.equal(fixture.reads[readCount], "2026-08-24");
  assert.equal(fixture.reads.length - readCount, 5);
  assert.equal(fixture.manifests.size, 62);
  assert.equal(journal.read(), null);
  assert.deepEqual(fixture.calls.at(-1).body.days.map((entry) => entry.day),
    Array.from({ length: 62 }, (_, index) => new Date(Date.parse("2026-06-28") + index * 86_400_000).toISOString().slice(0, 10)));
});

test("cancellation retains only completed day manifests and the next pass resumes that prefix", async () => {
  const fixture = server({ count: 0, predecessorChange: { fromDay: "2026-08-26" } });
  const journal = progressJournal();
  const controller = new AbortController();
  const sourcePublication = { fingerprint: "synthetic-source-one", parserVersion: "synthetic-v11-sync" };
  const first = await runTelemetryV11Sync({ ...fixture.options, sourcePublication,
    progressStore: journal.port(), signal: controller.signal,
    readDay: (selectedDay) => {
      if (selectedDay === "2026-08-27") controller.abort();
      return preparedDay(selectedDay, 0);
    },
  });
  assert.equal(first.status, "partial");
  assert.equal(first.failure.code, "interrupted");
  assert.equal(first.daysSynced, 0);
  assert.equal(journal.read().days.length, 1);
  assert.equal(fixture.active(), null);
  const reads = [];
  const second = await runTelemetryV11Sync({ ...fixture.options, sourcePublication,
    progressStore: journal.port(), readDay: (selectedDay) => { reads.push(selectedDay); return preparedDay(selectedDay, 0); },
  });
  assert.equal(second.status, "complete");
  assert.deepEqual(reads, ["2026-08-27", day]);
  assert.equal(journal.read(), null);
});

test("parser, binding, device, policy and predecessor changes cannot reuse a saved prefix", async () => {
  for (const change of ["parser", "binding", "device", "policy", "predecessor", "legacy", "bounds"]) {
    const fixture = longHistoryFixture();
    const journal = progressJournal();
    await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port() });
    const saved = journal.read();
    const next = { ...fixture.options, progressStore: journal.port(), maxDurationMs: 300_000 };
    if (change === "parser") {
      next.sourcePublication = { ...fixture.sourcePublication, parserVersion: "synthetic-new-parser" };
      next.readDay = (selectedDay) => { fixture.reads.push(selectedDay); return preparedDay(selectedDay, 0, "synthetic-new-parser"); };
    }
    if (change === "binding") fixture.capability.enrollmentNamespace = "synthetic_other_enrollment";
    if (change === "device") next.deviceAuthorization = "Device um_device_" + uuid(2) + "." + "a".repeat(43);
    if (change === "policy") fixture.capability.policyRevision += 1;
    if (change === "predecessor") fixture.before.previousGenerationId = uuid(900);
    if (change === "legacy") fixture.before.legacyFingerprint = "f".repeat(64);
    if (change === "bounds") fixture.before.fromDay = "2026-06-27";
    const readCount = fixture.reads.length;
    const writes = journal.writes.length;
    const result = await runTelemetryV11Sync(next);
    assert.equal(result.status, "complete", change);
    assert.equal(fixture.reads[readCount], fixture.before.fromDay, change);
    assert.equal(journal.writes[writes], null, change);
    assert.ok(saved.days.length > 0);
    assert.equal(journal.read(), null, change);
  }
});

test("a new generation with an appended final day revalidates the prefix locally without restaging it", async () => {
  const fixture = longHistoryFixture();
  const journal = progressJournal();
  await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port() });
  const saved = journal.read();
  const start = fixture.calls.length;
  const reads = [];
  const result = await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port(),
    sourcePublication: { ...fixture.sourcePublication, fingerprint: "synthetic-source-appended" },
    readDay: (selectedDay) => { reads.push(selectedDay); return preparedDay(selectedDay, selectedDay === day ? 1 : 0); },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.daysSynced, 62);
  assert.equal(result.recordsUploaded, 1);
  assert.deepEqual(reads.slice(0, saved.days.length), saved.days.map((entry) => entry.day));
  assert.deepEqual(fixture.calls.slice(start).filter((call) => call.path.endsWith("/day-manifests"))
    .map((call) => call.body.day), ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", day]);
  assert.deepEqual(fixture.calls.at(-1).body.days.slice(0, saved.days.length), saved.days);
  assert.equal(journal.read(), null);
});

test("an altered completed-day digest drops its staged suffix before the new generation activates", async () => {
  const fixture = longHistoryFixture();
  const journal = progressJournal();
  await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port() });
  const saved = journal.read();
  const changed = saved.days.at(-2).day;
  const firstChanged = saved.days.length - 2;
  const start = fixture.calls.length;
  const result = await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port(),
    sourcePublication: { ...fixture.sourcePublication, fingerprint: "synthetic-source-corrected" },
    readDay: (selectedDay) => preparedDay(selectedDay, selectedDay === changed ? 1 : 0),
  });
  assert.equal(result.status, "complete");
  assert.equal(result.recordsUploaded, 1);
  const restaged = fixture.calls.slice(start).filter((call) => call.path.endsWith("/day-manifests"));
  assert.equal(restaged[0].body.day, changed);
  assert.equal(restaged.length, 62 - firstChanged);
  const activated = fixture.calls.at(-1).body.days;
  assert.deepEqual(activated.slice(0, firstChanged), saved.days.slice(0, firstChanged));
  assert.notEqual(activated[firstChanged].manifestDigest, saved.days[firstChanged].manifestDigest);
  assert.notEqual(activated[firstChanged].manifestId, saved.days[firstChanged].manifestId);
  assert.equal(journal.read(), null);
});

test("a newly appended calendar day extends the candidate after revalidating its old prefix", async () => {
  const fixture = longHistoryFixture();
  const journal = progressJournal();
  await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port() });
  const saved = journal.read();
  fixture.before.throughDay = "2026-08-29";
  const start = fixture.calls.length;
  const result = await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port(),
    days: [fixture.before.fromDay, fixture.before.throughDay],
    sourcePublication: { ...fixture.sourcePublication, fingerprint: "synthetic-source-next-day" },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.daysSynced, 63);
  assert.equal(result.acknowledgedThroughDay, "2026-08-29");
  const requests = fixture.calls.slice(start).filter((call) => call.path.endsWith("/day-manifests"));
  assert.equal(requests.length, 6);
  assert.equal(requests[0].body.day, "2026-08-24");
  assert.equal(requests.at(-1).body.day, "2026-08-29");
  assert.deepEqual(fixture.calls.at(-1).body.days.slice(0, saved.days.length), saved.days);
});

test("budgeted prefix validation checkpoints separately and resumes under the same new publication", async () => {
  const fixture = longHistoryFixture();
  const journal = progressJournal();
  await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port() });
  const before = journal.read();
  const sourcePublication = { ...fixture.sourcePublication, fingerprint: "synthetic-source-revalidation" };
  const reads = [];
  const readDay = (selectedDay) => {
    reads.push(selectedDay);
    fixture.advance(1_000);
    return preparedDay(selectedDay, 0);
  };
  const start = fixture.calls.length;
  const partial = await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port(),
    sourcePublication, readDay, maxDurationMs: 20_000,
  });
  assert.equal(partial.status, "partial");
  assert.equal(partial.daysSynced, 0);
  assert.equal(fixture.active(), null);
  const validating = journal.read();
  assert.deepEqual(validating.days, before.days);
  assert.equal(validating.validatedDays, 17);
  assert.equal(validating.sourceFingerprint, hash(sourcePublication.fingerprint));
  assert.equal(fixture.calls.slice(start).some((call) => call.path.endsWith("/day-manifests")), false);
  const nextRead = reads.length;
  const complete = await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port(), sourcePublication, readDay });
  assert.equal(complete.status, "complete");
  assert.equal(complete.daysSynced, 62);
  assert.equal(reads[nextRead], before.days[17].day);
  assert.equal(journal.read(), null);
});

test("marker/root uncertainty forces digest revalidation even when the index publication is unchanged", async () => {
  const fixture = longHistoryFixture();
  const journal = progressJournal();
  await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port() });
  const saved = journal.read();
  const changed = saved.days.at(-1).day;
  const reads = [];
  const start = fixture.calls.length;
  const result = await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port(), revalidateProgress: true,
    readDay: (selectedDay) => { reads.push(selectedDay); return preparedDay(selectedDay, selectedDay === changed ? 1 : 0); },
  });
  assert.equal(result.status, "complete");
  assert.equal(reads[0], fixture.before.fromDay);
  assert.equal(fixture.calls.slice(start).filter((call) => call.path.endsWith("/day-manifests"))[0].body.day, changed);
  assert.notEqual(fixture.calls.at(-1).body.days[saved.days.length - 1].manifestDigest, saved.days.at(-1).manifestDigest);
});

test("rotating a credential on the same device does not invalidate a secret-free progress context", async () => {
  const fixture = longHistoryFixture();
  const journal = progressJournal();
  await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port() });
  const start = fixture.reads.length;
  const result = await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port(),
    deviceAuthorization: "Device um_device_" + uuid(1) + "." + "c".repeat(43),
  });
  assert.equal(result.status, "complete");
  assert.equal(fixture.reads[start], "2026-08-24");
  assert.equal(fixture.reads.length - start, 5);
});

test("malformed or discontinuous cursor data is discarded and never replaces source projection", async () => {
  for (const mutate of [
    (value) => { value.extra = "synthetic-private-canary"; },
    (value) => { value.days[0].extra = "synthetic-private-canary"; },
    (value) => { value.days[0].day = day; },
    (value) => { value.days[0].manifestId = "invalid"; },
    (value) => { value.days[0].manifestDigest = "invalid"; },
    (value) => { value.sourceFingerprint = "invalid"; },
    (value) => { value.validatedDays = value.days.length + 1; },
    (value) => { value.days.push(...Array.from({ length: 4096 }, () => value.days[0])); },
  ]) {
    const fixture = longHistoryFixture();
    const journal = progressJournal();
    await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port() });
    const corrupt = journal.read();
    mutate(corrupt);
    journal.replace(corrupt);
    const readCount = fixture.reads.length;
    const result = await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port(), maxDurationMs: 300_000 });
    assert.equal(result.status, "complete");
    assert.equal(fixture.reads[readCount], fixture.before.fromDay);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-canary/u);
    assert.equal(journal.read(), null);
  }
});

test("durable progress failure cannot acknowledge partial history or bypass exact source/parser binding", async () => {
  for (const failing of ["read", "write"]) {
    const fixture = longHistoryFixture();
    const journal = progressJournal();
    const progressStore = journal.port();
    progressStore[failing] = async () => { throw new Error("private-synthetic-store-failure"); };
    const result = await runTelemetryV11Sync({ ...fixture.options, progressStore });
    assert.equal(result.status, "failed");
    assert.equal(result.failure.code, "index_unavailable");
    assert.equal(result.failure.retryable, true);
    assert.equal(result.daysSynced, 0);
    assert.equal(fixture.active(), null);
    assert.doesNotMatch(JSON.stringify(result), /private-synthetic-store-failure/u);
  }
  const fixture = longHistoryFixture();
  const journal = progressJournal();
  await assert.rejects(runTelemetryV11Sync({ ...fixture.options, sourcePublication: null, progressStore: journal.port() }), {
    code: "contribution_incremental_sync_invalid_configuration",
  });
  assert.equal(fixture.calls.length, 0);
  const mismatched = await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port(),
    sourcePublication: { ...fixture.sourcePublication, parserVersion: "not-the-published-parser" },
  });
  assert.equal(mismatched.status, "failed");
  assert.equal(mismatched.failure.code, "local_index_changed");
  assert.equal(journal.read(), null);
  assert.equal(fixture.manifests.size, 0);
});

test("a resumed vector rechecks the hosted predecessor and clears rejected stale manifests", async () => {
  for (const rejection of ["predecessor", "activation"]) {
    const fixture = longHistoryFixture();
    const journal = progressJournal();
    await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port() });
    let predecessors = 0;
    const result = await runTelemetryV11Sync({ ...fixture.options, progressStore: journal.port(),
      fetchImpl: async (url, options) => {
        const path = new URL(url).pathname;
        if (rejection === "predecessor" && path.endsWith("/domain-predecessor") && ++predecessors === 2) {
          fixture.before.legacyFingerprint = "f".repeat(64);
        }
        if (rejection === "activation" && path.endsWith("/domain-activate")) return json({
          error: { code: "TELEMETRY_MANIFEST_INCOMPLETE" },
        }, 409);
        return fixture.options.fetchImpl(url, options);
      },
    });
    assert.equal(result.status, "failed", rejection);
    assert.equal(result.failure.code, "revision_conflict", rejection);
    assert.equal(result.failure.retryable, true);
    assert.equal(result.daysSynced, 0);
    assert.equal(fixture.active(), null);
    assert.equal(journal.read(), null);
    if (rejection === "predecessor") assert.equal(fixture.calls.some((call) => call.path.endsWith("/domain-activate")), false);
  }
});

test("a lost activation response is not acknowledged; retry reuses staged chunks", async () => {
  const fixture = server();
  const first = await runTelemetryV11Sync({ ...fixture.options, fetchImpl: async (url, options) => {
    const response = await fixture.options.fetchImpl(url, options);
    if (new URL(url).pathname.endsWith("/domain-activate")) throw new Error("synthetic lost response");
    return response;
  } });
  assert.equal(first.failure.code, "service_unavailable");
  assert.equal(first.acknowledgedThroughDay, null);
  assert.equal(first.daysSynced, 0);
  assert.notEqual(fixture.active(), null);
  const second = await runTelemetryV11Sync(fixture.options);
  assert.equal(second.status, "complete");
  assert.equal(second.chunksUploaded, 0);
  assert.equal(second.chunksSkipped, 1);
});

test("unchanged-domain receipts link the submitted digest while retaining the real generation", async () => {
  const fixture = server();
  const first = await runTelemetryV11Sync(fixture.options);
  const active = fixture.active();
  const second = await runTelemetryV11Sync({ ...fixture.options, fetchImpl: async (url, options) => {
    if (new URL(url).pathname.endsWith("/domain-activate")) return json({
      ...active, replay: true, unchanged: true, requestedManifestDigest: JSON.parse(options.body).manifestDigest,
    }, 201);
    return fixture.options.fetchImpl(url, options);
  } });
  assert.equal(second.status, "complete");
  assert.equal(second.domainGenerationId, first.domainGenerationId);
});

test("empty local gaps are explicit staged days, never a bypass of required server coverage", async () => {
  const fixture = server({ predecessorChange: { fromDay: "2026-08-26" } });
  const seen = [];
  const result = await runTelemetryV11Sync({ ...fixture.options, readDay: (selectedDay, { binding }) => {
    seen.push(selectedDay);
    assert.deepEqual(binding, { destinationOrigin: origin, enrollmentNamespace: "synthetic_enrollment_namespace" });
    return fixture.options.readDay(selectedDay);
  } });
  assert.equal(result.status, "complete");
  assert.equal(result.daysTotal, 3);
  assert.deepEqual(seen, ["2026-08-26", "2026-08-27", day]);
  assert.equal(fixture.manifests.size, 3);
});

test("new parser manifests cannot reuse a prior partial day's staged chunks", async () => {
  const fixture = server({ count: 201 });
  await runTelemetryV11Sync({ ...fixture.options, maxChunks: 1 });
  const result = await runTelemetryV11Sync({ ...fixture.options, readDay: () => preparedDay(day, 201, "synthetic-new-parser") });
  assert.equal(result.status, "complete");
  assert.equal(result.chunksSkipped, 0);
  assert.equal(result.chunksUploaded, 2);
  assert.equal(fixture.manifests.size, 2);
});

test("mutable reader output is snapshotted before registration and encryption awaits", async () => {
  const fixture = server();
  const source = structuredClone(preparedDay());
  const result = await runTelemetryV11Sync({ ...fixture.options, readDay: () => source,
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname.endsWith("/day-manifests")) source.chunks[0].records[0].components.inputUncachedTokens = 999;
      return fixture.options.fetchImpl(url, options);
    } });
  assert.equal(result.status, "complete");
  assert.equal([...fixture.envelopes.values()][0].records[0].components.inputUncachedTokens, 10);
});

test("digest mismatch or non-allowlisted content fails before staging a day", async () => {
  for (const change of [
    (source) => { source.chunks[0].chunkDigest = "f".repeat(64); },
    (source) => { source.chunks[0].records[0].rawAccount = "synthetic-private-canary"; },
  ]) {
    const fixture = server();
    const source = structuredClone(preparedDay());
    change(source);
    const result = await runTelemetryV11Sync({ ...fixture.options, readDay: () => source });
    assert.equal(result.status, "failed");
    assert.equal(result.acknowledgedThroughDay, null);
    assert.equal(fixture.manifests.size, 0);
    assert.equal(JSON.stringify(result).includes("synthetic-private-canary"), false);
  }
});

test("no response means no network progress, and oversized streamed responses are cancelled", async () => {
  const fixture = server();
  const offline = await runTelemetryV11Sync({ ...fixture.options, fetchImpl: async () => { throw new Error("synthetic offline"); } });
  assert.equal(offline.networkActivity, false);
  assert.equal(offline.daysSynced, 0);
  assert.equal(offline.failure.code, "service_unavailable");
  let cancelled = false;
  const oversized = await runTelemetryV11Sync({ ...fixture.options, fetchImpl: async () => new Response(
    new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(32_769))); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json", "cache-control": "no-store" } },
  ) });
  assert.equal(oversized.failure.code, "response_invalid");
  assert.equal(oversized.networkActivity, true);
  assert.equal(cancelled, true);
});

test("request timeout, pass deadline and cancellation are bounded even if a port ignores abort", async () => {
  const fixture = server();
  const stalled = () => new Promise(() => {});
  const timeout = await runTelemetryV11Sync({ ...fixture.options, fetchImpl: stalled, requestTimeoutMs: 10 });
  assert.equal(timeout.failure.code, "service_unavailable");
  const budget = await runTelemetryV11Sync({ ...fixture.options, readDay: stalled, maxDurationMs: 10 });
  assert.equal(budget.status, "partial");
  assert.equal(budget.failure, null);
  assert.equal(budget.acknowledgedThroughDay, null);
  const controller = new AbortController();
  controller.abort();
  const interrupted = await runTelemetryV11Sync({ ...fixture.options, signal: controller.signal });
  assert.equal(interrupted.status, "partial");
  assert.equal(interrupted.failure.code, "interrupted");
  assert.equal(interrupted.networkActivity, false);
});

test("HTTP admission, consent, device loss and compatibility rejection retain typed safe failures", async () => {
  const errors = [
    [429, "CHUNK_ADMISSION_LIMIT_REACHED", "admission_exhausted", "partial"],
    [403, "TELEMETRY_TRANSPORT_BLOCKED", "consent_rejected", "failed"],
    [401, "DEVICE_AUTH_INVALID", "device_unavailable", "failed"],
    [409, "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE", "revision_conflict", "failed"],
  ];
  for (const [status, code, failure, expectedStatus] of errors) {
    const fixture = server();
    const result = await runTelemetryV11Sync({ ...fixture.options,
      fetchImpl: async () => json({ error: { code, detail: "private-synthetic-error-not-returned" } }, status, { "retry-after": "60" }) });
    assert.equal(result.failure.code, failure);
    assert.equal(result.status, expectedStatus);
    assert.equal(result.acknowledgedThroughDay, null);
    assert.equal(JSON.stringify(result).includes("private-synthetic-error"), false);
    if (status === 429) assert.equal(result.failure.retryAfterMilliseconds, 60_000);
  }
});

test("changed authenticated enrollment/policy and mismatched activation receipt never acknowledge", async () => {
  for (const kind of ["binding", "policy", "digest"]) {
    const fixture = server();
    let reads = 0;
    const result = await runTelemetryV11Sync({ ...fixture.options, fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/sync-capabilities") && ++reads === 2) {
        if (kind === "binding") fixture.capability.enrollmentNamespace = "synthetic_different_enrollment";
        if (kind === "policy") fixture.capability.policyRevision += 1;
      }
      const response = await fixture.options.fetchImpl(url, options);
      if (path.endsWith("/domain-activate") && kind === "digest") return json({
        ...fixture.active(), manifestDigest: "f".repeat(64),
      }, 201);
      return response;
    } });
    assert.equal(result.status, "failed");
    assert.equal(result.acknowledgedThroughDay, null);
    assert.equal(result.daysSynced, 0);
    assert.equal(result.failure.code, kind === "digest" ? "response_invalid" : "revision_conflict");
  }
});
