import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { resolve } from "node:path";
import {
  assertModernAttribution,
  assertSevenDayResetFit,
  encryptEnvelopeForSync,
  journeyTargetDay,
  journeyTrailingCurrentDays,
  seedFixtureFromNow,
  targetBaseSlot,
  emptyV11Day,
  emptyV12Day,
  richV11Day,
  richV12Day,
  assertAdditiveSuccessorPreserves,
  assertResumeSeedJournal,
  journeyStateSnapshot,
  runSyncWithBoundedRetry,
  syncOutcomeDiagnostics,
} from "../scripts/gcp-cloud-run-journey.mjs";

const run = promisify(execFile);

test("GCP journey local refusal and maintenance checks stay executable", async () => {
  const { stdout, stderr } = await run(process.execPath, [
    resolve("scripts/gcp-cloud-run-journey.check.mjs"),
  ], {
    cwd: resolve("."),
    timeout: 30_000,
    maxBuffer: 512 * 1024,
  });
  assert.equal(stderr, "", stderr);
  assert.match(stdout, /gcp-cloud-run-journey focused refusal\/restore\/control checks passed/u);
});

test("GCP journey rich successor fixtures pass the real v1.1/v1.2 projections", () => {
  const day = "2026-09-20";
  const resetDay = "2026-09-27";
  const v11 = richV11Day(day, { resetDay });
  const v12 = richV12Day(day, { resetDay });

  assert.doesNotThrow(() => {
    assertModernAttribution(v11, "v1.1");
    assertSevenDayResetFit(v11, resetDay, "v1.1");
    assertModernAttribution(v12, "v1.2");
    assertSevenDayResetFit(v12, resetDay, "v1.2");
  });

  const modernRecords = [...v11.chunks, ...v12.chunks]
    .flatMap((chunk) => chunk.records)
    .filter((record) => record.schemaVersion.startsWith("usage-event-")
      || record.schemaVersion.startsWith("quota-observation-"));
  assert.ok(modernRecords.length > 0);
  const usageRecords = modernRecords
    .filter((record) => record.schemaVersion.startsWith("usage-event-"))
    .sort((left, right) => left.eventTime.localeCompare(right.eventTime));
  assert.equal(usageRecords.length, 40);
  assert.equal(usageRecords[0].eventTime, `${day}T00:15:00.000Z`);
  assert.equal(usageRecords.at(-1).eventTime, `${day}T19:45:00.000Z`);
  for (let index = 1; index < usageRecords.length; index += 1) {
    assert.equal(
      Date.parse(usageRecords[index].eventTime) - Date.parse(usageRecords[index - 1].eventTime),
      30 * 60 * 1_000,
    );
  }
  const quotaRecords = modernRecords
    .filter((record) => record.schemaVersion.startsWith("quota-observation-"))
    .sort((left, right) => left.observedTime.localeCompare(right.observedTime));
  assert.equal(quotaRecords.length, 40);
  assert.ok(quotaRecords.every((record, index) => (
    Number.isFinite(record.usedPercent)
      && record.usedPercent > (index === 0 ? 0 : quotaRecords[index - 1].usedPercent)
  )));
  assert.ok(Math.abs(quotaRecords.at(-1).usedPercent - 60) < 1e-9);
  assert.ok(modernRecords.every((record) => /^account-track:v2:[0-9a-f]{64}$/u.test(
    record.accountPlanAttribution.accountTrackId,
  )));
  const serialized = JSON.stringify({ v11, v12 });
  assert.equal(serialized.includes("synthetic_enrollment_0001"), false);
  assert.equal(serialized.includes("openai-account:v1:"), false);
});

test("GCP journey provides explicit empty current-day coverage without future data", () => {
  const targetDay = "2026-09-22";
  const currentNoon = Date.parse("2026-09-23T12:00:00.000Z");
  const trailingDays = journeyTrailingCurrentDays(targetDay, currentNoon);
  assert.deepEqual(trailingDays, ["2026-09-23"]);

  const v11 = emptyV11Day(trailingDays[0]);
  const v12 = emptyV12Day(trailingDays[0]);
  for (const day of [v11, v12]) {
    assert.equal(day.manifest.day, trailingDays[0]);
    assert.deepEqual(day.manifest.chunks, []);
    assert.deepEqual(day.chunks, []);
  }

  assert.deepEqual(
    journeyTrailingCurrentDays(targetDay, Date.parse("2026-09-22T23:59:59.999Z")),
    [],
  );
  assert.deepEqual(
    journeyTrailingCurrentDays(targetDay, Date.parse("2026-09-24T12:00:00.000Z")),
    ["2026-09-23", "2026-09-24"],
  );
  assert.throws(
    () => journeyTrailingCurrentDays("2025-01-01", currentNoon),
    (error) => error?.code === "JOURNEY_TRAILING_DAY_WINDOW_INVALID",
  );
});

test("GCP journey successor fixtures retain the admitted v1 occurrence", () => {
  const day = "2026-09-22";
  const legacy = {
    schemaVersion: "usage-event-v1.0",
    eventId: "event:gcp-journey-legacy-source-0001",
    eventTime: `${day}T12:00:00.000Z`,
    sessionUuid: "session:gcp-journey-legacy-source-0001",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "standard",
    surface: "api",
    billingSurface: "api",
    reasoningEffort: "none",
    agentScope: "local",
    outcome: "success",
    totalInputContextTokens: 1,
    components: {
      inputUncachedTokens: 1,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTextTokens: 1,
      outputReasoningTokens: 0,
      outputCombinedTokens: 1,
    },
  };
  const v11 = richV11Day(day, { legacyUsageRecord: legacy });
  const v11UsageChunk = v11.chunks.find((chunk) => chunk.chunkId.startsWith("usage:"));
  assert.equal(v11UsageChunk?.records.length, 21);
  const v11Record = v11UsageChunk
    ?.records.find((record) => record.eventId === legacy.eventId);
  assert.ok(v11Record);
  const { accountPlanAttribution: _v11Attribution, ...v11Base } = v11Record;
  assert.deepEqual({ ...v11Base, schemaVersion: "usage-event-v1.0" }, legacy);

  const v12 = richV12Day(day, { legacyUsageRecord: legacy });
  const v12UsageChunk = v12.chunks.find((chunk) => chunk.chunkId.startsWith("usage:"));
  assert.equal(v12UsageChunk?.records.length, 21);
  const v12Record = v12UsageChunk
    ?.records.find((record) => record.eventId === legacy.eventId);
  assert.ok(v12Record);
  const {
    accountPlanAttribution: _v12Attribution,
    boundaryFlags: _boundaryFlags,
    tieOrder: _tieOrder,
    cacheWriteTtl: _cacheWriteTtl,
    ...v12Base
  } = v12Record;
  assert.deepEqual({ ...v12Base, schemaVersion: "usage-event-v1.0" }, legacy);
});

test("GCP journey captures a non-future mixed fixture window", () => {
  const beforeWindow = Date.parse("2026-09-22T19:59:59.999Z");
  const before = seedFixtureFromNow(beforeWindow);
  assert.equal(journeyTargetDay(beforeWindow), "2026-09-21");
  assert.equal(before.day, "2026-09-21");
  assert.equal(before.baseSlot, 1);
  assert.equal(targetBaseSlot(before.day, beforeWindow), 1);
  const beforeV11 = richV11Day(before.day, { baseSlot: before.baseSlot });
  const beforeV12 = richV12Day(before.day, { baseSlot: before.baseSlot });
  const beforeEvents = [...beforeV11.chunks, ...beforeV12.chunks]
    .flatMap((chunk) => chunk.records)
    .filter((record) => record.schemaVersion.startsWith("usage-event-"));
  assert.ok(beforeEvents.every((record) => Date.parse(record.eventTime) <= beforeWindow));

  const atWindow = Date.parse("2026-09-22T20:00:00.000Z");
  const current = seedFixtureFromNow(atWindow);
  assert.equal(current.day, "2026-09-22");
  assert.equal(current.baseSlot, 0);
  const currentV11 = richV11Day(current.day, { baseSlot: current.baseSlot });
  const currentV12 = richV12Day(current.day, { baseSlot: current.baseSlot });
  const currentEvents = [...currentV11.chunks, ...currentV12.chunks]
    .flatMap((chunk) => chunk.records)
    .filter((record) => record.schemaVersion.startsWith("usage-event-"));
  assert.ok(currentEvents.every((record) => Date.parse(record.eventTime) <= atWindow));
});

test("GCP journey sync diagnostics stay bounded and content-free", () => {
  const diagnostic = syncOutcomeDiagnostics({
    status: "failed",
    chunksUploaded: 1,
    chunksSkipped: 2,
    stagedDays: 3,
    failure: {
      code: "revision_conflict",
      retryAfterMilliseconds: 2_000,
      privatePayload: "must-not-escape",
    },
    networkActivity: true,
    responseBody: "must-not-escape",
  }, "v1.1");
  assert.deepEqual(diagnostic, {
    stream: "v1.1",
    status: "failed",
    chunksUploaded: 1,
    chunksSkipped: 2,
    stagedDays: 3,
    failureCode: "revision_conflict",
    retryAfterMilliseconds: 2_000,
    networkActivity: true,
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /privatePayload|must-not-escape/u);

  assert.deepEqual(syncOutcomeDiagnostics({
    status: "unexpected",
    chunksUploaded: 2_001,
    chunksSkipped: -1,
    stagedDays: "3",
    failure: { code: "raw_provider_error" },
    networkActivity: "yes",
  }, "unexpected"), {
    stream: "v1.1",
    status: "invalid",
    chunksUploaded: null,
    chunksSkipped: null,
    stagedDays: null,
    failureCode: null,
    retryAfterMilliseconds: null,
    networkActivity: false,
  });
});

test("GCP journey additive successor keeps old rows exact and adds one unique point", () => {
  const day = "2026-09-22";
  const legacy = {
    schemaVersion: "usage-event-v1.0",
    eventId: "event:gcp-journey-successor-legacy-0001",
    eventTime: `${day}T12:00:00.000Z`,
    sessionUuid: "session:gcp-journey-successor-legacy-0001",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "standard",
    surface: "api",
    billingSurface: "api",
    reasoningEffort: "none",
    agentScope: "local",
    outcome: "success",
    totalInputContextTokens: 1,
    components: {
      inputUncachedTokens: 1,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTextTokens: 1,
      outputReasoningTokens: 0,
      outputCombinedTokens: 1,
    },
  };
  const predecessor = richV12Day(day, { resetDay: "2026-09-29", legacyUsageRecord: legacy });
  const successor = richV12Day(day, {
    additional: true,
    resetDay: "2026-09-29",
    legacyUsageRecord: legacy,
  });
  const predecessorUsage = predecessor.chunks.find((chunk) => chunk.chunkId.startsWith("usage:"));
  const successorUsage = successor.chunks.find((chunk) => chunk.chunkId.startsWith("usage:"));
  const successorQuota = successor.chunks.find((chunk) => chunk.chunkId.startsWith("quota:"));
  const predecessorSession = predecessor.chunks.find((chunk) => chunk.chunkId.startsWith("session:"));
  const successorSession = successor.chunks.find((chunk) => chunk.chunkId.startsWith("session:"));
  assert.equal(predecessorUsage?.records.length, 21);
  assert.equal(successorUsage?.records.length, 22);
  assert.equal(successorQuota?.records.length, 21);
  assert.deepEqual(successorSession?.records, predecessorSession?.records);
  assert.equal(successorUsage?.records.some((record) => record.eventId.endsWith(":40")), true);
  assert.equal(assertAdditiveSuccessorPreserves(predecessor, successor).predecessorRecords, 42);
});

test("GCP journey bounded sync retry makes one permitted retry only", async () => {
  let calls = 0;
  const result = await runSyncWithBoundedRetry(async () => {
    calls += 1;
    return {
      status: "failed",
      failure: {
        code: "service_unavailable",
        retryable: true,
        retryAfterMilliseconds: 0,
      },
    };
  }, {});
  assert.equal(calls, 2);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "service_unavailable");
});

test("GCP journey resume journal refuses missing receipts and accepts a complete checkpoint", () => {
  const day = "2026-09-22";
  const future = "2099-09-22T00:00:00.000Z";
  const participantId = "participant:synthetic-workload-0001";
  const deviceId = "123e4567-e89b-42d3-a456-426614174000";
  const deviceSecret = "A".repeat(43);
  const makeArchive = (format, manifestId) => {
    const chunkId = `usage:${day}:0`;
    return {
      chunks: [{
        schemaVersion: `telemetry-contribution-${format}`,
        chunkId,
        chunkDigest: "a".repeat(64),
        recordCount: 1,
        manifestDigest: "b".repeat(64),
      }],
      receipts: [{
        contributionId: `contribution-${format}`,
        manifestId,
        chunkId,
        recordCount: 1,
      }],
    };
  };
  const v11ManifestId = "123e4567-e89b-42d3-a456-426614174001";
  const v12ManifestId = "123e4567-e89b-42d3-a456-426614174002";
  const v11 = makeArchive("v1.1", v11ManifestId);
  const v12 = makeArchive("v1.2", v12ManifestId);
  const state = {
    phase: "seed-progress",
    progress: "owner-allowance-preview",
    seedFixture: { day, baseSlot: 0 },
    ownerCreatedAt: future,
    erasureAt: null,
    workload: {
      participantId,
      cookie: "__Host-usage_monitor_session=um_session_synthetic",
      csrfToken: "um_csrf_synthetic",
      expiresAt: future,
    },
    device: {
      id: deviceId,
      secret: deviceSecret,
      authorization: `Device um_device_${deviceId}.${deviceSecret}`,
      expiresAt: future,
    },
    deviceV12: {
      id: "123e4567-e89b-42d3-a456-426614174003",
      secret: deviceSecret,
      authorization: "Device um_device_123e4567-e89b-42d3-a456-426614174003.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      expiresAt: future,
    },
    v1: {
      day,
      raw: "{}",
      chunk: { chunkDigest: "c".repeat(64), records: [{}] },
      first: { contributionId: "contribution-v1" },
    },
    v11: { ...v11, sync: { resumedStatus: "complete", daysSynced: 1 } },
    v12: {
      ...v12,
      fixture: { day, chunk: { records: [{}] }, manifest: { day } },
      first: {},
      replay: {},
      sync: {
        resumedStatus: "complete",
        sameDayStatus: "complete",
        additiveStatus: "complete",
        additiveDaysSynced: 1,
      },
    },
  };
  const fixture = { participantId: "participant:synthetic-admin-0001" };
  assert.equal(assertResumeSeedJournal(state, fixture, Date.parse("2026-09-22T00:00:00.000Z")), true);
  const missingReceipt = structuredClone(state);
  missingReceipt.v12.receipts = [];
  assert.throws(
    () => assertResumeSeedJournal(missingReceipt, fixture, Date.parse("2026-09-22T00:00:00.000Z")),
    (error) => error?.code === "JOURNEY_RESUME_RECEIPTS_INCOMPLETE",
  );
  const wrongCheckpoint = structuredClone(state);
  wrongCheckpoint.progress = "v1-upload";
  assert.throws(
    () => assertResumeSeedJournal(wrongCheckpoint, fixture, Date.parse("2026-09-22T00:00:00.000Z")),
    (error) => error?.code === "JOURNEY_RESUME_CHECKPOINT_INVALID",
  );
});

test("GCP journey snapshots retain the v1.2 sync completion proof", () => {
  const sync = {
    freshStatus: "partial",
    resumedStatus: "complete",
    sameDayStatus: "complete",
    additiveStatus: "complete",
    additiveDaysSynced: 5,
  };
  const snapshot = journeyStateSnapshot({
    phase: "seed-progress",
    progress: "owner-allowance-preview",
    baseOrigin: "https://journey.example",
    seedFixture: { capturedAt: "2026-09-22T00:00:00.000Z", day: "2026-09-22", baseSlot: 0 },
    ownerCreatedAt: "2026-09-22T00:00:00.000Z",
    workload: null,
    device: null,
    deviceV12: null,
    v1: null,
    v11: null,
    v12: { fixture: {}, chunks: [], receipts: [], raw: {}, first: {}, replay: {}, sync },
  });
  assert.deepEqual(snapshot.v12?.sync, sync);
});

test("GCP journey sync envelope boundary returns an object", async () => {
  const keys = await webcrypto.subtle.generateKey({
    name: "RSA-OAEP",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["encrypt", "decrypt"]);
  const publicJwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
  const day = richV11Day("2026-09-22", { resetDay: "2026-09-29" });
  const envelope = await encryptEnvelopeForSync({ publicJwk, keyId: "key:journey-test" }, day.chunks[0],
    "telemetry-envelope-v1.1");
  assert.equal(typeof envelope, "object");
  assert.equal(Array.isArray(envelope), false);
  assert.equal(envelope.schemaVersion, "telemetry-envelope-v1.1");
  assert.equal(typeof envelope.ciphertext, "string");
  assert.equal(typeof envelope.wrappedKey, "string");
});
