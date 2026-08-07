import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createUnifiedIndexWriter,
  openLocalUnifiedIndex,
  outcomeOrdinal,
  reasoningEffortOrdinal,
} from "../src/local-unified-index.js";
import {
  telemetryV1DayDigest,
  telemetryV1HistoryDigest,
} from "../src/contribution/telemetry-v1-chunks.js";
import {
  ContributionIncrementalSyncError,
  runIncrementalContributionSyncOnce,
} from "../src/contribution-incremental-sync.js";

const ORIGIN = "https://usage.example";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const AUTH_ID = "22222222-2222-4222-8222-222222222222";
const CHUNK_ROW_ID = "chunk:33333333-3333-4333-8333-333333333333";
const DAY_ONE = "2026-08-01";
const DAY_TWO = "2026-08-02";
const SESSION_LOCAL = Buffer.alloc(32, 0x0c);

function dayMs(day, offsetMs = 0) {
  return Date.parse(`${day}T00:00:00.000Z`) + offsetMs;
}

function eventKey(index) {
  const key = Buffer.alloc(32, 0);
  key.writeUInt32BE(index, 28);
  return key;
}

async function writeEvents(file, events, { create }) {
  const database = openLocalUnifiedIndex(file, { readOnly: false, create });
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: "telemetry-contribution-v0.1",
  });
  const accountScopeId = writer.internAccountScope({
    status: "unavailable",
    reason: "missing_account",
    planType: null,
    scopeLocal: null,
  });
  for (const event of events) {
    writer.writeUsageEvent({
      eventKey: event.eventKey,
      observedAtMs: event.observedAtMs,
      sessionLocal: SESSION_LOCAL,
      accountScopeId,
      modelId: writer.internModel("gpt-5.6-sol", "recognized"),
      tierId: writer.internTier({
        apiServiceTier: "unknown",
        billingSurface: "chatgpt_subscription",
        codexSpeedMode: "standard",
        tierSource: "rollout_thread_settings",
        providerTierRaw: "default",
      }),
      surfaceId: writer.internSurface({
        agentScope: "root",
        surface: "extension_or_ide",
        threadSource: "rollout",
        lineageDisposition: "standalone",
      }),
      quotaObservationId: null,
      reasoningEffort: reasoningEffortOrdinal("medium"),
      outcome: outcomeOrdinal("unknown"),
      tokensInUncached: event.tokens ?? 100,
      tokensInCacheRead: null,
      tokensInCacheWrite: null,
      tokensInCacheWrite5m: null,
      tokensInCacheWrite1h: null,
      tokensOutText: 1,
      tokensOutReasoning: null,
      tokensOutCombined: null,
      totalInputContext: null,
    });
  }
  await writer.close({ integrityCheck: true, fsyncPath: null });
}

function response(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

/**
 * A fake contribution service holding the same journal shape the worker
 * holds: current chunk revisions keyed by chunk id, day and history digests
 * computed by the identical rules, revision + admission checks on ingest.
 * The fake envelope embeds the plaintext, so no cryptography runs here.
 */
function createFakeService({
  admissionLimit = Number.POSITIVE_INFINITY,
  conflictOnce = false,
  stateStatus = null,
} = {}) {
  const journal = new Map();
  const calls = [];
  let acceptedInWindow = 0;
  let pendingConflict = conflictOnce;

  function currentDays() {
    const byDay = new Map();
    for (const chunk of journal.values()) {
      const list = byDay.get(chunk.day) ?? [];
      list.push(chunk);
      byDay.set(chunk.day, list);
    }
    return [...byDay.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, chunks]) => ({
        day,
        dayDigest: telemetryV1DayDigest(chunks),
        chunks: chunks
          .sort((left, right) => (
            left.stream === right.stream
              ? left.chunkSeq - right.chunkSeq
              : left.stream < right.stream ? -1 : 1
          ))
          .map((chunk) => ({
            chunkId: chunk.chunkId,
            revision: chunk.revision,
            chunkDigest: chunk.chunkDigest,
            recordCount: chunk.recordCount,
          })),
      }));
  }

  function acknowledgedThroughDay() {
    const days = currentDays();
    return days.at(-1)?.day ?? null;
  }

  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({ path: parsed.pathname, options });
    if (parsed.pathname === "/api/v1/device/sync/state") {
      assert.match(options.headers.Authorization, /^Device um_device_/u);
      if (stateStatus !== null) return stateStatus();
      const days = currentDays();
      return response({
        schemaVersion: "device-sync-state-v1.0",
        contractVersion: "telemetry-contribution-v1.0",
        acknowledgedThroughDay: acknowledgedThroughDay(),
        historyDigest: telemetryV1HistoryDigest(days),
        dayCount: days.length,
        chunkCount: journal.size,
        admission: {
          schemaVersion: "telemetry-chunk-admission-v1.0",
          state: acceptedInWindow >= admissionLimit ? "exhausted" : "available",
          windowDay: DAY_ONE,
          budget: "launch_week",
          acceptedChunks: acceptedInWindow,
          remainingChunks: Math.max(0, admissionLimit - acceptedInWindow),
          maximumChunks: admissionLimit,
          retryAt: "2026-08-02T00:00:00.000Z",
        },
      });
    }
    if (parsed.pathname === "/api/v1/device/sync/manifest") {
      assert.match(options.headers.Authorization, /^Device um_device_/u);
      const fromDay = parsed.searchParams.get("fromDay");
      const toDay = parsed.searchParams.get("toDay");
      return response({
        schemaVersion: "device-sync-manifest-v1.0",
        contractVersion: "telemetry-contribution-v1.0",
        fromDay,
        toDay,
        days: currentDays().filter(
          (day) => day.day >= fromDay && day.day <= toDay,
        ),
      });
    }
    if (parsed.pathname === "/api/v1/envelope-key") {
      return response({
        algorithm: "RSA-OAEP-256",
        keyId: "key:test",
        publicJwk: { kty: "RSA" },
      });
    }
    if (parsed.pathname === "/api/v1/device/upload-authorizations") {
      assert.match(options.headers.Authorization, /^Device um_device_/u);
      return response({
        uploadAuthorization: `um_device_upload_${AUTH_ID}.${"B".repeat(43)}`,
        expiresAt: "2026-08-02T00:00:00.000Z",
      }, 201);
    }
    if (parsed.pathname === "/api/v1/contributions") {
      assert.match(options.headers.Authorization, /^Upload um_device_upload_/u);
      const envelope = JSON.parse(options.body);
      assert.equal(envelope.schemaVersion, "telemetry-envelope-v1.0");
      const chunk = envelope.plaintext;
      const current = journal.get(chunk.chunkId);
      if (current !== undefined
          && current.chunkDigest === chunk.chunkDigest) {
        return response({
          schemaVersion: "telemetry-chunk-receipt-v1.0",
          contributionId: CHUNK_ROW_ID,
          chunkId: chunk.chunkId,
          chunkRevision: current.revision,
          status: "accepted",
          replayed: true,
          recordCounts: {
            declared: chunk.records.length,
            accepted: 0,
          },
          acknowledgedThroughDay: acknowledgedThroughDay(),
        }, 202, { "idempotency-replayed": "true" });
      }
      if (pendingConflict) {
        pendingConflict = false;
        return response({
          error: { code: "CHUNK_REVISION_CONFLICT" },
        }, 409);
      }
      const expectedRevision = current === undefined
        ? 1
        : current.revision + 1;
      if (chunk.chunkRevision !== expectedRevision) {
        return response({
          error: { code: "CHUNK_REVISION_CONFLICT" },
        }, 409);
      }
      if (acceptedInWindow >= admissionLimit) {
        return response({
          error: { code: "CHUNK_ADMISSION_LIMIT_REACHED" },
        }, 429, { "Retry-After": "3600" });
      }
      acceptedInWindow += 1;
      const [stream, day, seq] = chunk.chunkId.split(":");
      journal.set(chunk.chunkId, {
        chunkId: chunk.chunkId,
        stream,
        day,
        chunkSeq: Number(seq),
        revision: chunk.chunkRevision,
        chunkDigest: chunk.chunkDigest,
        recordCount: chunk.records.length,
        consent: chunk.consent,
      });
      return response({
        schemaVersion: "telemetry-chunk-receipt-v1.0",
        contributionId: CHUNK_ROW_ID,
        chunkId: chunk.chunkId,
        chunkRevision: chunk.chunkRevision,
        status: "accepted",
        supersededRevision: current?.revision ?? null,
        recordCounts: {
          declared: chunk.records.length,
          accepted: chunk.records.length,
        },
        acknowledgedThroughDay: acknowledgedThroughDay(),
        admission: {
          state: acceptedInWindow >= admissionLimit
            ? "exhausted"
            : "available",
          retryAt: "2026-08-02T00:00:00.000Z",
        },
      }, 202);
    }
    throw new Error("unexpected request");
  };

  return { fetchImpl, calls, journal };
}

function fakeDeviceSecret() {
  return async ({ expectedOrigin, operation }) => operation(
    Buffer.alloc(32, 7),
    { origin: expectedOrigin, deviceId: DEVICE_ID },
  );
}

function fakeCreateEnvelope() {
  return async ({ chunk }) => ({
    schemaVersion: "telemetry-envelope-v1.0",
    synthetic: false,
    keyId: "key:test",
    plaintext: chunk,
  });
}

async function withIndex(run) {
  const root = await mkdtemp(join(tmpdir(), "telemetry-v1-engine-"));
  const file = join(root, "index.sqlite");
  try {
    await writeEvents(file, [
      { eventKey: eventKey(1), observedAtMs: dayMs(DAY_ONE, 1_000) },
      { eventKey: eventKey(2), observedAtMs: dayMs(DAY_ONE, 2_000) },
      { eventKey: eventKey(3), observedAtMs: dayMs(DAY_TWO, 1_000) },
    ], { create: true });
    return await run(file);
  } finally {
    await rm(root, { recursive: true });
  }
}

function engineOptions(file, service, overrides = {}) {
  return {
    indexFile: file,
    origin: ORIGIN,
    backend: {},
    fetchImpl: service.fetchImpl,
    withDeviceSecret: fakeDeviceSecret(),
    createEnvelope: fakeCreateEnvelope(),
    ...overrides,
  };
}

test("a first full sync uploads every chunk oldest day first and lands complete", async () => {
  await withIndex(async (file) => {
    const service = createFakeService();
    const outcome = await runIncrementalContributionSyncOnce(
      engineOptions(file, service),
    );
    assert.equal(outcome.status, "complete");
    assert.equal(outcome.failure, null);
    assert.equal(outcome.daysTotal, 2);
    assert.equal(outcome.daysSynced, 2);
    assert.equal(outcome.daysPending, 0);
    assert.equal(outcome.chunksUploaded, 2);
    assert.equal(outcome.recordsUploaded, 3);
    assert.equal(outcome.acknowledgedThroughDay, DAY_TWO);
    const uploaded = service.calls
      .filter((call) => call.path === "/api/v1/contributions")
      .map((call) => JSON.parse(call.options.body).plaintext.chunkId);
    assert.deepEqual(uploaded, [
      `usage:${DAY_ONE}:0`,
      `usage:${DAY_TWO}:0`,
    ]);
    // Consent identifiers ride in every chunk.
    assert.equal(
      service.journal.get(`usage:${DAY_ONE}:0`).consent.telemetrySchemaVersion,
      "telemetry-contribution-v1.0",
    );
    // No manifest was needed: an empty service is the trivial digest match.
    assert.equal(
      service.calls.some(
        (call) => call.path === "/api/v1/device/sync/manifest",
      ),
      false,
    );
  });
});

test("an unchanged history is one state read and zero uploads", async () => {
  await withIndex(async (file) => {
    const service = createFakeService();
    await runIncrementalContributionSyncOnce(engineOptions(file, service));
    service.calls.length = 0;
    const outcome = await runIncrementalContributionSyncOnce(
      engineOptions(file, service),
    );
    assert.equal(outcome.status, "complete");
    assert.equal(outcome.chunksUploaded, 0);
    assert.equal(outcome.chunksSkipped, 2);
    assert.deepEqual(
      service.calls.map((call) => call.path),
      ["/api/v1/device/sync/state"],
    );
  });
});

test("a changed day re-uploads only that day, superseding at revision two", async () => {
  await withIndex(async (file) => {
    const service = createFakeService();
    await runIncrementalContributionSyncOnce(engineOptions(file, service));
    await writeEvents(file, [
      { eventKey: eventKey(9), observedAtMs: dayMs(DAY_TWO, 9_000), tokens: 7 },
    ], { create: false });
    service.calls.length = 0;
    const outcome = await runIncrementalContributionSyncOnce(
      engineOptions(file, service),
    );
    assert.equal(outcome.status, "complete");
    assert.equal(outcome.chunksUploaded, 1);
    const uploads = service.calls
      .filter((call) => call.path === "/api/v1/contributions")
      .map((call) => JSON.parse(call.options.body).plaintext);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].chunkId, `usage:${DAY_TWO}:0`);
    assert.equal(uploads[0].chunkRevision, 2);
    assert.equal(uploads[0].records.length, 2);
    // The digest mismatch forced exactly one manifest diff.
    assert.equal(
      service.calls.filter(
        (call) => call.path === "/api/v1/device/sync/manifest",
      ).length,
      1,
    );
    assert.equal(service.journal.get(`usage:${DAY_TWO}:0`).revision, 2);
  });
});

test("an exhausted admission budget stops the pass with the service's retry floor", async () => {
  await withIndex(async (file) => {
    const service = createFakeService({ admissionLimit: 1 });
    const outcome = await runIncrementalContributionSyncOnce(
      engineOptions(file, service, {
        now: () => Date.parse("2026-08-01T12:00:00.000Z"),
      }),
    );
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.chunksUploaded, 1);
    assert.equal(outcome.daysPending, 1);
    assert.equal(outcome.failure.code, "admission_exhausted");
    assert.equal(outcome.failure.retryable, true);
    assert.equal(outcome.failure.deviceUnavailable, false);
    // The service's next admission window (its retryAt) is the floor.
    assert.equal(outcome.failure.retryAfterMilliseconds, 12 * 60 * 60 * 1_000);
  });
});

test("a revision conflict re-reads the cursor once and then succeeds", async () => {
  await withIndex(async (file) => {
    const service = createFakeService({ conflictOnce: true });
    const outcome = await runIncrementalContributionSyncOnce(
      engineOptions(file, service),
    );
    assert.equal(outcome.status, "complete");
    assert.equal(outcome.chunksUploaded, 2);
    assert.equal(
      service.calls.filter(
        (call) => call.path === "/api/v1/device/sync/state",
      ).length,
      2,
    );
  });
});

test("a device the service no longer recognises surfaces as device_unavailable", async () => {
  await withIndex(async (file) => {
    const service = createFakeService({
      stateStatus: () => response({
        error: { code: "DEVICE_AUTH_INVALID" },
      }, 401),
    });
    const outcome = await runIncrementalContributionSyncOnce(
      engineOptions(file, service),
    );
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failure.code, "device_unavailable");
    assert.equal(outcome.failure.deviceUnavailable, true);
    assert.equal(outcome.chunksUploaded, 0);
  });
});

test("a missing index is a retryable typed outcome, never a crash", async () => {
  const service = createFakeService();
  const outcome = await runIncrementalContributionSyncOnce(engineOptions(
    "/nonexistent/index.sqlite",
    service,
  ));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failure.code, "index_unavailable");
  assert.equal(outcome.failure.retryable, true);
  assert.equal(service.calls.length, 0);
});

test("the engine refuses drifted consent identifiers before any network activity", async () => {
  await withIndex(async (file) => {
    const service = createFakeService();
    await assert.rejects(
      runIncrementalContributionSyncOnce(engineOptions(file, service, {
        consent: {
          telemetrySchemaVersion: "telemetry-contribution-v0.9",
          fieldDictionaryVersion: "stale",
          privacyContractVersion: "stale",
        },
      })),
      (error) => error instanceof ContributionIncrementalSyncError
        && error.code === "contribution_incremental_sync_consent_invalid",
    );
    assert.equal(service.calls.length, 0);
  });
});
