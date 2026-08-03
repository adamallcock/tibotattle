import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  SEMANTIC_OPEN_TARGET_PLACEHOLDER,
} from "../../../config/product-brand.js";

import {
  DIAGNOSTIC_REFERENCE_PATTERN,
  DIAGNOSTIC_SURFACES,
  buildSyntheticFixture,
  bytesToBase64Url,
  contributionBatchAdmission,
  createDiagnosticReference,
  diagnosticErrorCode,
  diagnosticReferenceSentence,
  diagnosticSurface,
  serviceRequestId,
  createQuotaTimelineLookup,
  createRefreshPollingBudget,
  createSyntheticEnvelope,
  createTelemetryEnvelope,
  parseJsonWithUniqueObjectKeys,
  refreshNeedsContinuation,
  runReviewedContributionGate,
  ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION,
  ENVELOPE_SCHEMA_VERSION,
  safeApiError,
  safeFilename,
  TELEMETRY_ENVELOPE_SCHEMA_VERSION,
  validateAccountScopedTelemetryContribution,
  validateSyntheticFixture,
  validateTelemetryContribution
} from "../public/lib.js";
import {
  AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION,
  CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  CODEX_PRIMARY_LIMIT_ID,
  CODEX_SPARK_LIMIT_ID,
  CODEX_WEEKLY_ALLOWANCE_MINUTES,
  COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
  CONTRIBUTION_SYNC_PREVIEW_SCHEMA_VERSION,
  CONTRIBUTION_SYNC_RUN_SCHEMA_VERSION,
  CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION,
  LOCAL_ONBOARDING_SCHEMA_VERSION,
  CommunityClient,
  demoDashboard,
  LocalCompanionClient,
  normalizeCommunitySnapshot,
  normalizeContributionSyncStatus,
  normalizeContributionSyncPreview,
  normalizeContributionSyncRun,
  normalizeContributionDeletionReceipt,
  normalizeBackendReadiness,
  normalizeAutomaticContributionStatus,
  normalizeLocalContributionDevicePairing,
  normalizeLocalContributionPreparation,
  normalizeLocalOnboarding,
  normalizeDashboardPayload,
  normalizeParticipantCommunityComparison,
  normalizeParticipantDeletionReceipt,
  normalizeParticipantHistory,
  normalizeParticipantStats,
  normalizeLocalContributionDeviceReset,
  normalizeLocalDiagnosticNote,
  PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION,
  PARTICIPANT_PROFILE_SCHEMA_VERSION,
  PARTICIPANT_STATS_SCHEMA_VERSION,
  isPrimaryCodexQuotaWindow,
  isPrimaryCodexWeeklyQuotaWindow,
  SUPPORTED_COMMUNITY_SNAPSHOT_SCHEMA_VERSIONS,
  SUPPORTED_PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSIONS
} from "../public/data-client.js";

test("browser JSON preflight rejects duplicate object keys before parsing", () => {
  for (const serialized of [
    '{"prompt":"first","prompt":"second"}',
    '{"row":{"accountScopeId":"first","accountScopeId":"second"}}',
    '{"content":"first","\\u0063ontent":"second"}',
    '{"safeCount":1,"safeCount":1}',
  ]) {
    assert.throws(
      () => parseJsonWithUniqueObjectKeys(serialized),
      (error) => (
        error instanceof SyntaxError
        && error.code === "duplicate_json_object_key"
        && error.message === "Duplicate JSON object keys are not accepted."
        && !error.message.includes("prompt")
        && !error.message.includes("accountScopeId")
        && !error.message.includes("content")
        && !error.message.includes("safeCount")
      ),
    );
  }
});

test("browser JSON preflight preserves canonical JSON object behavior", () => {
  const serialized = JSON.stringify({
    schemaVersion: "telemetry-contribution-v0.2",
    nested: {
      accountScopeId: "acct_opaque",
      values: [null, true, false, -12.5e3, "escaped\nvalue"],
    },
    siblings: [
      { repeatedAcrossObjects: 1 },
      { repeatedAcrossObjects: 2 },
    ],
  });
  assert.deepEqual(
    parseJsonWithUniqueObjectKeys(serialized),
    JSON.parse(serialized),
  );
  assert.deepEqual(
    parseJsonWithUniqueObjectKeys(
      '{"left":{"same":"allowed"},"right":{"same":"allowed"}}',
    ),
    {
      left: { same: "allowed" },
      right: { same: "allowed" },
    },
  );
  assert.throws(
    () => parseJsonWithUniqueObjectKeys('{"truncated":'),
    (error) => (
      error instanceof SyntaxError
      && error.code !== "duplicate_json_object_key"
      && !error.message.includes("truncated")
    ),
  );
});

test("quota timeline lookup preserves latest-at-or-before boundary semantics", () => {
  const rows = [
    { id: "late", observedAt: "2026-07-29T03:00:00.000Z" },
    { id: "first-at-duplicate", observedAt: "2026-07-29T02:00:00.000Z" },
    { id: "early", observedAt: "2026-07-29T01:00:00.000Z" },
    { id: "last-at-duplicate", observedAt: "2026-07-29T02:00:00.000Z" },
  ];
  const sorted = [...rows].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  );
  const reference = (timestampMs) => {
    let selected = null;
    for (const row of sorted) {
      if (Date.parse(row.observedAt) > timestampMs) break;
      selected = row;
    }
    return selected;
  };
  const lookup = createQuotaTimelineLookup(rows);

  for (const timestampMs of [
    Number.NEGATIVE_INFINITY,
    Date.parse("2026-07-29T00:59:59.999Z"),
    Date.parse("2026-07-29T01:00:00.000Z"),
    Date.parse("2026-07-29T01:59:59.999Z"),
    Date.parse("2026-07-29T02:00:00.000Z"),
    Date.parse("2026-07-29T02:59:59.999Z"),
    Date.parse("2026-07-29T03:00:00.000Z"),
    Number.POSITIVE_INFINITY,
  ]) {
    assert.strictEqual(
      lookup.atOrBefore(timestampMs)?.row ?? null,
      reference(timestampMs),
    );
  }
  assert.strictEqual(
    lookup.atOrBefore(Date.parse("2026-07-29T02:00:00.000Z"))?.row,
    rows[3],
    "the latest source row wins when observations share a timestamp",
  );
  assert.equal(lookup.atOrBefore(Number.NaN), null);
  assert.equal(createQuotaTimelineLookup([]).atOrBefore(Date.now()), null);
  assert.equal(
    createQuotaTimelineLookup([{ observedAt: "not-a-timestamp" }]).size,
    0,
  );
  assert.throws(
    () => createQuotaTimelineLookup(null),
    /Quota timeline rows must be an array/,
  );
});

test("quota timeline lookup parses supported dashboard bounds only once", () => {
  const quotaRowCount = 10_000;
  const usagePointCount = 3_000;
  const startMs = Date.parse("2026-01-01T00:00:00.000Z");
  let observedAtReads = 0;
  const rows = Array.from({ length: quotaRowCount }, (_, id) => {
    const observedAt = new Date(startMs + id * 60_000).toISOString();
    return Object.defineProperty({ id }, "observedAt", {
      enumerable: true,
      get() {
        observedAtReads += 1;
        return observedAt;
      },
    });
  });

  const lookup = createQuotaTimelineLookup(rows);
  assert.equal(lookup.size, quotaRowCount);
  assert.equal(observedAtReads, quotaRowCount);
  for (let query = 0; query < usagePointCount; query += 1) {
    const expectedId = Math.floor(
      query * (quotaRowCount - 1) / (usagePointCount - 1),
    );
    assert.equal(
      lookup.atOrBefore(startMs + expectedId * 60_000)?.row.id,
      expectedId,
    );
  }
  assert.equal(observedAtReads, quotaRowCount);
  assert.equal(lookup.atOrBefore(startMs - 1), null);
  const last = lookup.atOrBefore(Number.POSITIVE_INFINITY);
  assert.equal(last?.row.id, quotaRowCount - 1);
  assert.equal(last?.timestampMs, startMs + (quotaRowCount - 1) * 60_000);
  assert.equal(observedAtReads, quotaRowCount);
});

test("reviewed contribution must be accepted before recurring contribution can be enabled", async () => {
  const calls = [];
  let resolveSend;
  const acceptedSend = new Promise((resolve) => {
    resolveSend = resolve;
  });
  const running = runReviewedContributionGate({
    reviewToken: "review-token",
    hasPendingAutomaticConsent: true,
    runReviewedSend: async (token) => {
      calls.push(["send", token]);
      return acceptedSend;
    },
    enableAutomaticContribution: async () => {
      calls.push(["enable"]);
      return { status: "scheduled" };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [["send", "review-token"]]);
  resolveSend({ status: "completed", accepted: 1 });
  const accepted = await running;
  assert.equal(accepted.accepted, true);
  assert.deepEqual(calls, [["send", "review-token"], ["enable"]]);
  assert.deepEqual(accepted.automatic, { status: "scheduled" });

  for (const result of [
    { status: "completed", accepted: 0 },
    { status: "interrupted", accepted: 1 },
    { status: "completed", accepted: -1 },
  ]) {
    let enabled = false;
    const rejected = await runReviewedContributionGate({
      reviewToken: "review-token",
      hasPendingAutomaticConsent: true,
      runReviewedSend: async () => result,
      enableAutomaticContribution: async () => {
        enabled = true;
      },
    });
    assert.equal(rejected.accepted, false);
    assert.equal(enabled, false);
  }

  let enabledWithoutConsent = false;
  const noConsent = await runReviewedContributionGate({
    reviewToken: "review-token",
    hasPendingAutomaticConsent: false,
    runReviewedSend: async () => ({ status: "completed", accepted: 1 }),
    enableAutomaticContribution: async () => {
      enabledWithoutConsent = true;
    },
  });
  assert.equal(noConsent.accepted, true);
  assert.equal(enabledWithoutConsent, false);
});

test("refresh polling budget gives each accepted continuation a fresh window", () => {
  let nowMs = 1_000;
  const budget = createRefreshPollingBudget({
    now: () => nowMs,
    windowMs: 2_000,
    settlementGraceMs: 1_000,
    maximumContinuations: 2
  });

  assert.equal(budget.hasTime(), true);
  assert.equal(budget.canContinue(), true);
  nowMs = 3_000;
  assert.equal(budget.hasTime(), false);
  assert.equal(budget.noteContinuation(), true);
  assert.equal(budget.continuations, 1);
  nowMs = 4_999;
  assert.equal(budget.hasTime(), true);
  nowMs = 5_000;
  assert.equal(budget.hasTime(), false);
  budget.noteSettling();
  nowMs = 5_999;
  assert.equal(budget.hasTime(), true);
  assert.equal(budget.noteContinuation(), true);
  nowMs = 7_998;
  assert.equal(budget.hasTime(), true);
  assert.equal(budget.noteContinuation(), false);
});

test("default local analysis permits only two bounded continuations", () => {
  const budget = createRefreshPollingBudget();
  assert.equal(budget.canContinue(), true);
  assert.equal(budget.noteContinuation(), true);
  assert.equal(budget.noteContinuation(), true);
  assert.equal(budget.canContinue(), false);
  assert.equal(budget.noteContinuation(), false);
});

test("contribution admission uses participant allowance without inventing an unknown limit", () => {
  const known = contributionBatchAdmission({
    estimatedBatches: 8,
    participantAdmission: {
      state: "available",
      remainingBatches: 7,
      maximumBatches: 100,
      renewsAt: "2026-08-03T00:00:00.000Z",
    },
  });
  assert.equal(known.admissionKnown, true);
  assert.equal(known.exceedsParticipantAdmission, true);
  assert.equal(known.blocked, true);
  assert.equal(known.effectiveBatchLimit, 7);
  assert.equal(known.renewsAt, "2026-08-03T00:00:00.000Z");

  const exhausted = contributionBatchAdmission({
    estimatedBatches: 1,
    participantAdmission: {
      state: "exhausted",
      remainingBatches: 0,
      maximumBatches: 100,
      renewsAt: "2026-08-03T00:00:00.000Z",
    },
  });
  assert.equal(exhausted.blocked, true);
  assert.equal(exhausted.effectiveBatchLimit, 0);

  const unknown = contributionBatchAdmission({
    estimatedBatches: 8,
    participantAdmission: null,
  });
  assert.equal(unknown.admissionKnown, false);
  assert.equal(unknown.remainingBatches, null);
  assert.equal(unknown.blocked, false);
  assert.equal(unknown.effectiveBatchLimit, 100);

  assert.equal(
    contributionBatchAdmission({
      estimatedBatches: 101,
      participantAdmission: null,
    }).blocked,
    true,
  );
});

test("completed bounded passes continue under the original user action", () => {
  assert.equal(refreshNeedsContinuation({
    outcome: "succeeded",
    progress: { status: "bounded_pause" },
  }), true);
  assert.equal(refreshNeedsContinuation({
    outcome: "failed",
    errorCode: "refresh_timed_out",
    progress: { status: "bounded_pause" },
  }), true);
  assert.equal(refreshNeedsContinuation({
    outcome: "succeeded",
    progress: { status: "recent_7d_complete" },
  }), false);
  assert.equal(refreshNeedsContinuation({
    outcome: "failed",
    errorCode: "collector_failed",
    progress: { status: "bounded_pause" },
  }), false);
});

function communitySnapshot() {
  const releasedTokens = { status: "released", value: 100_000, unit: "tokens_rounded_down" };
  return {
    schemaVersion: COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
    releaseStatus: "published",
    snapshotId: "community-week:2026-07-13",
    period: {
      startAt: "2026-07-13T00:00:00.000Z",
      endAt: "2026-07-20T00:00:00.000Z"
    },
    ingestionCutoffAt: "2026-07-22T00:00:00.000Z",
    releasedAt: "2026-07-22T00:00:00.000Z",
    immutable: true,
    nonOverlapping: true,
    privacyPolicy: {
      version: "community-weekly-v0.1",
      minimumIndependentParticipants: 20
    },
    cells: [{
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      metrics: {
        usageEvents: { status: "released", value: 30, unit: "events_rounded_down" },
        inputUncachedTokens: releasedTokens,
        inputCacheReadTokens: releasedTokens,
        inputCacheWriteTokens: releasedTokens,
        outputTextTokens: releasedTokens,
        outputReasoningTokens: releasedTokens,
        outputCombinedTokens: releasedTokens,
        toolUnits: { status: "released", value: 10, unit: "tool_units_rounded_down" }
      }
    }]
  };
}

function safeTelemetry() {
  const toolClassCounts = {
    webSearch: 0,
    fileSearch: 0,
    codeInterpreter: 0,
    hostedShell: 0,
    computerUse: 0,
    mcp: 0,
    applyPatch: 0,
    localShell: 1,
    subagent: 0,
    toolGateway: 0,
    other: 0,
    unknown: 0
  };
  return {
    schemaVersion: "telemetry-contribution-v0.1",
    synthetic: false,
    createdAt: "2026-07-25T14:00:00.000Z",
    coveredAt: {
      startAt: "2026-07-25T13:00:00.000Z",
      endAt: "2026-07-25T13:30:00.000Z"
    },
    clientPlatform: "macos",
    providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
    usageEvents: [{
      schemaVersion: "usage-event-v0.1",
      eventTime: "2026-07-25T13:10:00.000Z",
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      modelRecognition: "recognized",
      modelFingerprint: null,
      billingSurface: "chatgpt_subscription",
      speedMode: "standard",
      apiServiceTier: "standard",
      reasoningEffort: "high",
      components: {
        inputUncachedTokens: 1200,
        inputCacheReadTokens: 9000,
        inputCacheWriteTokens: 0,
        inputCacheWrite5mTokens: null,
        inputCacheWrite1hTokens: null,
        outputTextTokens: 800,
        outputReasoningTokens: 300,
        outputCombinedTokens: null
      },
      totalInputContextTokens: 10200,
      surface: "local_interactive_unclassified",
      agentScope: "root",
      lineageDisposition: "standalone",
      toolClassCounts,
      outcome: "completed",
      eventId: `event:v2:${"a".repeat(64)}`,
      accounting: {
        estimatedApiCostUsd: "0.420000",
        pricingCoveragePercent: 100,
        unknownBillableUnits: 0,
        priceBasis: "current_api_prices"
      }
    }],
    quotaSnapshots: [],
    activityMarkers: [],
    accounting: {
      estimatedApiCostUsd: "0.420000",
      pricedEventCoveragePercent: 100,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices"
    }
  };
}

function safeAccountScopedTelemetry() {
  const source = safeTelemetry();
  return {
    schemaVersion: ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION,
    consentVersion: "privacy-safe-telemetry-v0.2",
    status: "implementation_disabled",
    synthetic: false,
    datasetId: `dataset:v1:${"d".repeat(64)}`,
    partIndex: 1,
    partCount: 1,
    completeness: "complete",
    createdAt: source.createdAt,
    coveredAt: source.coveredAt,
    clientPlatform: source.clientPlatform,
    providerPolicyEpoch: source.providerPolicyEpoch,
    usageEvents: source.usageEvents.map(({ accounting, ...row }) => ({
      ...row,
      schemaVersion: "usage-event-v0.2",
      accountTrackId: `account-track:v1:${"a".repeat(64)}`,
      accountingDiagnostic: {
        ...accounting,
        status: "untrusted_diagnostic",
        sourceSchemaVersion: "telemetry-contribution-v0.1"
      }
    })),
    quotaSnapshots: [],
    activityMarkers: [],
    accountingDiagnostic: {
      ...source.accounting,
      status: "untrusted_diagnostic",
      sourceSchemaVersion: "telemetry-contribution-v0.1"
    }
  };
}

async function rsaPair() {
  return webcrypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["encrypt", "decrypt"]
  );
}

async function decryptEnvelope(envelope, privateKey) {
  const decode = (value) => new Uint8Array(Buffer.from(value, "base64url"));
  const rawPayloadKey = await webcrypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    decode(envelope.wrappedKey)
  );
  const payloadKey = await webcrypto.subtle.importKey(
    "raw",
    rawPayloadKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plaintext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(envelope.iv) },
    payloadKey,
    decode(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

test("the legacy demo fixture remains fixed, synthetic, and content-free", () => {
  const fixture = buildSyntheticFixture();
  assert.equal(validateSyntheticFixture(fixture), true);
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.fixtureId, "codex-weekly-demo-v0.1");
});

test("base64url encoding is unpadded and URL safe", () => {
  assert.equal(bytesToBase64Url(new Uint8Array([])), "");
  assert.equal(bytesToBase64Url(new TextEncoder().encode("foo")), "Zm9v");
  assert.equal(bytesToBase64Url(new Uint8Array([251, 255])), "-_8");
});

test("synthetic hybrid envelope retains the existing contract", async () => {
  const pair = await rsaPair();
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const envelope = await createSyntheticEnvelope({
    publicJwk,
    keyId: "key:test",
    cryptoImpl: webcrypto
  });
  assert.equal(envelope.schemaVersion, ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.synthetic, true);
  assert.deepEqual(await decryptEnvelope(envelope, pair.privateKey), buildSyntheticFixture());
});

test("real privacy-safe telemetry is validated and encrypted without changing its payload", async () => {
  const payload = safeTelemetry();
  assert.equal(validateTelemetryContribution(payload), true);
  const pair = await rsaPair();
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const envelope = await createTelemetryEnvelope({
    payload,
    publicJwk,
    keyId: "key:real-test",
    cryptoImpl: webcrypto
  });
  assert.equal(envelope.schemaVersion, TELEMETRY_ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.synthetic, false);
  assert.equal("payload" in envelope, false);
  assert.deepEqual(await decryptEnvelope(envelope, pair.privateKey), payload);
});

test("account-scoped local-preview telemetry is preflighted and encrypted unchanged", async () => {
  const payload = safeAccountScopedTelemetry();
  assert.equal(validateAccountScopedTelemetryContribution(payload), true);
  const pair = await rsaPair();
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const envelope = await createTelemetryEnvelope({
    payload,
    publicJwk,
    keyId: "key:account-scoped-test",
    cryptoImpl: webcrypto
  });
  assert.equal(envelope.schemaVersion, TELEMETRY_ENVELOPE_SCHEMA_VERSION);
  assert.deepEqual(await decryptEnvelope(envelope, pair.privateKey), payload);
});

function telemetryContractFailure(code, detailCode) {
  return (error) => {
    assert.equal(error?.code, code);
    assert.equal(error?.detailCode, detailCode);
    return true;
  };
}

test("account-scoped browser preflight rejects direct account scopes and content fields", () => {
  const directScope = safeAccountScopedTelemetry();
  directScope.usageEvents[0].accountTrackId = `account:v1:${"a".repeat(64)}`;
  assert.throws(
    () => validateAccountScopedTelemetryContribution(directScope),
    telemetryContractFailure(
      "PRIVACY_CANARY_DETECTED",
      "private_projection_invalid",
    ),
  );
  const content = safeAccountScopedTelemetry();
  content.usageEvents[0].prompt = "private";
  assert.throws(
    () => validateAccountScopedTelemetryContribution(content),
    telemetryContractFailure(
      "PRIVACY_CANARY_DETECTED",
      "private_projection_invalid",
    ),
  );
});

test("browser telemetry validation rejects raw-content-shaped and identity fields", () => {
  for (const [key, value] of [
    ["prompt", "private"],
    ["response", "private"],
    ["filePath", "/private/project"],
    ["commandArguments", ["--secret"]],
    ["email", "person@example.test"],
    ["participantId", "person_123"]
  ]) {
    const payload = safeTelemetry();
    payload.usageEvents[0][key] = value;
    assert.throws(
      () => validateTelemetryContribution(payload),
      telemetryContractFailure(
        "PRIVACY_CANARY_DETECTED",
        "privacy_canary_detected",
      ),
    );
  }
});

test("browser telemetry validation rejects synthetic, wrong-schema, oversized, and deeply nested inputs", () => {
  assert.throws(
    () => validateTelemetryContribution({ synthetic: false }),
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "schema_version_invalid",
    ),
  );
  const synthetic = safeTelemetry();
  synthetic.synthetic = true;
  assert.throws(
    () => validateTelemetryContribution(synthetic),
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "schema_version_invalid",
    ),
  );
  assert.throws(
    () => validateTelemetryContribution(safeTelemetry(), { maxSerializedBytes: 10 }),
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "maximum_bytes_exceeded",
    ),
  );
  const nested = safeTelemetry();
  nested.extra = { a: { b: { c: 1 } } };
  assert.throws(
    () => validateTelemetryContribution(nested, { maxDepth: 1 }),
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "maximum_depth_exceeded",
    ),
  );
  const tooMany = safeTelemetry();
  tooMany.usageEvents = Array.from(
    { length: 201 },
    () => structuredClone(tooMany.usageEvents[0]),
  );
  assert.throws(
    () => validateTelemetryContribution(tooMany),
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "maximum_array_items_exceeded",
    ),
  );
});

test("local dashboard normalizer accepts artifact rows and keeps stale state explicit", () => {
  const result = normalizeDashboardPayload({
    schemaVersion: "local-dashboard-v0.1",
    mode: "real_local_evidence",
    status: "stale",
    freshness: { latestObservedAt: "2026-07-25T12:00:00Z", ageSeconds: 7200 },
    quotaWindows: [{
      id: "weekly",
      durationMinutes: 10080,
      usedPercent: 39,
      resetAt: "2026-07-28T17:00:00Z"
    }],
    pricing: {
      estimatedApiCostUsd: 12.34,
      pricedEventCoveragePercent: 91,
      components: { input_uncached: { tokens: 1000, costUsd: 1.25 } }
    },
    gradient: {
      snapshot: {
        datasets: {
          summary: [{ mean_absolute_error_pp: 2.7 }],
          rolling_history: [{ timestamp: "2026-07-25T12:00:00Z", series: "Observed quota change", quota_change_pp: 4 }]
        }
      }
    }
  });
  assert.equal(result.state, "stale");
  assert.equal(result.mode, "real_local_evidence");
  assert.equal(result.quotaWindows[0].remainingPercent, 61);
  assert.equal(result.pricing.totalCostUsd, 12.34);
  assert.equal(result.pricing.basis, "api_price_equivalent");
  assert.equal(result.pricing.apiServiceTier, "unknown");
  assert.equal(result.gradient.summary.mean_absolute_error_pp, 2.7);
  assert.equal(result.gradient.rollingHistory.length, 1);
});

test("local dashboard retains the pricing epoch required to explain allowance fits", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    pricing: {
      priceEpochBasis: "event_time_when_registry_has_effective_evidence",
      eventTimeHistoricalTotalUsdExact: "12.345678",
      currentPriceSensitivityTotalUsdExact: null,
      registryVersion: "app-official-api-prices-v0.2",
      registryObservedAt: "2026-08-01T13:47:00Z",
      priceCardIds: ["pre-change", "post-change"],
      priceCardBreakdown: [{ priceCardId: "pre-change", events: 1, costUsd: "2.5" }],
      mixedPriceCardWindows: true,
    },
  });
  assert.equal(
    result.pricing.priceEpochBasis,
    "event_time_when_registry_has_effective_evidence",
  );
  assert.equal(result.pricing.eventTimeHistoricalTotalUsdExact, "12.345678");
  assert.equal(result.pricing.currentPriceSensitivityTotalUsdExact, null);
  assert.equal(result.pricing.registryVersion, "app-official-api-prices-v0.2");
  assert.deepEqual(result.pricing.priceCardIds, ["pre-change", "post-change"]);
  assert.deepEqual(result.pricing.priceCardBreakdown, [
    { priceCardId: "pre-change", events: 1, costUsd: "2.5" },
  ]);
  assert.equal(result.pricing.mixedPriceCardWindows, true);

  const forgedCurrentTotal = normalizeDashboardPayload({
    mode: "real_local_evidence",
    pricing: {
      priceEpochBasis: "event_time_when_registry_has_effective_evidence",
      eventTimeHistoricalTotalUsdExact: "12.345678",
      currentPriceSensitivityTotalUsdExact: "12.345678",
    },
  });
  assert.equal(forgedCurrentTotal.pricing.currentPriceSensitivityTotalUsdExact, null);
});

test("missing numeric evidence stays missing instead of becoming zero", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "insufficient",
    quotaWindows: [{ id: "weekly", usedPercent: null, remainingPercent: null }],
    pricing: { totalCostUsd: null, coveragePercent: null }
  });
  assert.equal(result.quotaWindows[0].usedPercent, null);
  assert.equal(result.quotaWindows[0].remainingPercent, null);
  assert.equal(result.pricing.totalCostUsd, null);
  assert.equal(result.pricing.coveragePercent, null);
});

test("new accounting caveats survive the closed dashboard normalizer", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "stale",
    monitoringGaps: [
      { id: "provider_accounting_changes", status: "uncertain" },
      { id: "unknown_token_components", status: "observed_combined" },
      { id: "calculation_disagreement", status: "review_available" }
    ]
  });
  assert.deepEqual(
    result.monitoringGaps.map((row) => [row.id, row.status]),
    [
      ["provider_accounting_changes", "uncertain"],
      ["unknown_token_components", "observed_combined"],
      ["calculation_disagreement", "review_available"]
    ]
  );
});

test("the Fast-mode blind spot reports a share instead of a bare not-observed", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    monitoringGaps: [{ id: "fast_mode", status: "mostly_unknown" }]
  });
  assert.deepEqual(
    result.monitoringGaps.map((row) => [row.id, row.status]),
    [["fast_mode", "mostly_unknown"]]
  );
  // The copy must state the cause, not assert an unqualified absence.
  assert.match(
    result.monitoringGaps[0].explanation,
    /only when it is applied or changed, never at session start/u
  );
  assert.doesNotMatch(result.monitoringGaps[0].explanation, /NOT OBSERVED/iu);
});

test("the closed accounting normalizer keeps the quota-weighted metric and its coverage split", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    accounting: {
      periodId: "7d",
      events: 10,
      apiPriceEquivalentUsd: 20,
      quotaWeightedApiPriceEquivalentUsd: 34,
      speedWeighting: {
        fast: { "gpt-5.6": { events: 4, apiPriceEquivalentUsd: 8 } },
        standard: { "gpt-5.4": { events: 2, apiPriceEquivalentUsd: 4 } },
        unknown: { unsupported: { events: 4, apiPriceEquivalentUsd: 8 } }
      },
      fastMode: {
        preference: "mixed_unknown",
        quotaWeightedApiPriceEquivalentUsd: 34,
        standardApiPriceEquivalentUsd: 20,
        unweightedUnknownApiPriceEquivalentUsd: 8,
        weightingStatus: "partial",
        appliedMultipliers: { "gpt-5.6": 2.5 },
        coverage: {
          totalEvents: 10,
          observedEvents: 6,
          assumedFromPreferenceEvents: 0,
          inferredEvents: 3,
          unknownEvents: 1,
          observedSharePercent: 60,
          unknownSharePercent: 10
        },
        inference: {
          status: "inferred",
          inferredFastWindows: 2,
          referenceWindowCount: 4,
          scoredWindowCount: 9,
          relativeTolerance: 0.1,
          // A server claiming inference changed the total must not be believed.
          appliedToWeighting: true
        }
      }
    }
  });
  const accounting = result.accounting;
  assert.equal(accounting.quotaWeightedApiPriceEquivalentUsd, 34);
  assert.equal(accounting.apiPriceEquivalentUsd, 20);
  assert.equal(accounting.fastMode.preference, "mixed_unknown");
  assert.equal(accounting.fastMode.weightingStatus, "partial");
  assert.equal(accounting.fastMode.unweightedUnknownApiPriceEquivalentUsd, 8);
  assert.deepEqual(accounting.fastMode.coverage, {
    totalEvents: 10,
    observedEvents: 6,
    assumedFromPreferenceEvents: 0,
    inferredEvents: 3,
    unknownEvents: 1,
    observedSharePercent: 60,
    unknownSharePercent: 10
  });
  // The multipliers and the metric name are stated by this page, never taken
  // from the server, and inference can never be reported as weighted.
  assert.deepEqual(accounting.fastMode.multipliers, {
    "gpt-5.6": 2.5,
    "gpt-5.5": 2.5,
    "gpt-5.4": 2
  });
  assert.equal(accounting.fastMode.metricLabel, "Quota-weighted API-price equivalent");
  assert.equal(accounting.fastMode.inference.appliedToWeighting, false);
  assert.equal(accounting.fastMode.inference.inferredFastWindows, 2);
  assert.equal(accounting.fastMode.logRecordsTierChangesOnly, true);
  assert.equal(
    accounting.fastMode.preferenceAppliesTo,
    "turns_with_no_observed_tier_only"
  );
  assert.equal(accounting.speedWeighting.fast["gpt-5.6"].events, 4);
  assert.equal(accounting.speedWeighting.unknown.unsupported.apiPriceEquivalentUsd, 8);
  assert.equal(accounting.speedWeighting.fast["gpt-5.5"].events, 0);
});

test("an absent or hostile Fast-mode projection degrades to an explicit unknown", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    accounting: {
      events: 3,
      apiPriceEquivalentUsd: 5,
      quotaWeightedApiPriceEquivalentUsd: -12,
      fastMode: { preference: "turbo", weightingStatus: "definitely" }
    }
  });
  assert.equal(result.accounting.quotaWeightedApiPriceEquivalentUsd, null);
  assert.equal(result.accounting.fastMode.preference, "standard");
  assert.equal(result.accounting.fastMode.weightingStatus, "unknown");
  assert.equal(result.accounting.fastMode.coverage.totalEvents, 0);
  assert.equal(result.accounting.fastMode.inference.status, "not_run");
});

test("live weekly calibration keeps its explicit multi-account ambiguity label", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    weekly: {
      dataClass: "live_replay_safe_cache",
      accountAttribution: {
        status: "historical_unattributed",
        maySpanMultipleAccounts: true,
        label:
          "Historical estimate; account-unattributed and may combine multiple accounts"
      },
      datasets: {
        summary: [{
          median_weekly_value_usd: 1800,
          qualifying_resets: 3
        }]
      }
    }
  });
  assert.equal(result.weekly.dataClass, "live_replay_safe_cache");
  assert.equal(result.weekly.accountAttribution.maySpanMultipleAccounts, true);
  assert.match(result.weekly.accountAttribution.label, /may combine multiple accounts/);
});

test("normal Codex allowance selection uses stable identifiers, not labels", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    quotaWindows: [
      {
        limitId: CODEX_PRIMARY_LIMIT_ID,
        durationMinutes: CODEX_WEEKLY_ALLOWANCE_MINUTES,
        label: "Límite semanal",
        usedPercent: 39
      },
      {
        limitId: CODEX_SPARK_LIMIT_ID,
        durationMinutes: CODEX_WEEKLY_ALLOWANCE_MINUTES,
        label: "GPT-5.3-Codex-Spark limit",
        usedPercent: 0
      },
      {
        limitId: "Seven-day allowance",
        durationMinutes: CODEX_WEEKLY_ALLOWANCE_MINUTES,
        label: "Seven-day allowance",
        usedPercent: 0
      }
    ]
  });
  assert.equal(CODEX_PRIMARY_LIMIT_ID, "codex");
  assert.equal(result.quotaWindows[0].label, "Seven-day allowance");
  assert.equal(result.quotaWindows[1].label, "Other observed allowance");
  assert.equal(result.quotaWindows[2].label, "Other observed allowance");
  assert.equal(result.quotaWindows[0].limitId, CODEX_PRIMARY_LIMIT_ID);
  assert.equal(result.quotaWindows[1].limitId, CODEX_SPARK_LIMIT_ID);
  assert.equal(result.quotaWindows[2].limitId, "unknown");
  assert.equal(isPrimaryCodexQuotaWindow(result.quotaWindows[0]), true);
  assert.equal(isPrimaryCodexQuotaWindow(result.quotaWindows[1]), false);
  assert.equal(isPrimaryCodexQuotaWindow(result.quotaWindows[2]), false);
  assert.equal(
    isPrimaryCodexQuotaWindow({
      limitId: CODEX_PRIMARY_LIMIT_ID,
      durationMinutes: CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
      label: "Límite de cinco horas"
    }),
    true
  );
  assert.equal(
    isPrimaryCodexWeeklyQuotaWindow({
      limitId: CODEX_PRIMARY_LIMIT_ID,
      durationMinutes: CODEX_WEEKLY_ALLOWANCE_MINUTES,
      label: "Weekly allowance"
    }),
    true
  );
  assert.doesNotMatch(result.quotaWindows.map((row) => row.label).join(" "), /bengalfox/);
  assert.doesNotMatch(result.quotaWindows.map((row) => row.label).join(" "), /Account/);
});

test("local split overview contract derives quota and seven-day pricing without exposing identities", () => {
  const result = normalizeDashboardPayload({}, {
    overview: {
      schemaVersion: "local-companion-v0.1",
      mode: "real_local_evidence",
      evidenceStatus: "available",
      latestEvidenceAt: "2026-07-25T12:00:00.000Z",
      freshness: { status: "live", ageSeconds: 30 },
      quota: {
        observedAt: "2026-07-25T12:00:00.000Z",
        windows: [{
          limitId: "codex",
          slot: "secondary",
          planType: "pro",
          usedPercent: 39,
          durationMinutes: 10080,
          resetAt: "2026-07-28T17:00:00.000Z"
        }]
      },
      usage: [
        { id: "24h", label: "Last 24 hours", events: 1, apiPriceEquivalentUsd: 1, pricedEventFraction: 1 },
        {
          id: "7d",
          label: "Last 7 days",
          events: 50,
          apiPriceEquivalentUsd: 511.64,
          pricedEventFraction: .55014,
          components: { input_uncached_tokens: 1000, output_text_tokens: 200 }
        }
      ],
      pricing: { apiServiceTier: "standard" }
    },
    reports: { reports: [{ id: "weekly", title: "Weekly", href: "/reports/weekly", modifiedAt: "2026-07-25T12:00:00Z" }] }
  });
  assert.equal(result.state, "live");
  assert.equal(result.quotaWindows[0].remainingPercent, 61);
  assert.equal(result.quotaWindows[0].observedAt, "2026-07-25T12:00:00.000Z");
  assert.equal(result.pricing.totalCostUsd, 511.64);
  assert.equal(result.pricing.coveragePercent, 55.014);
  assert.equal(result.pricing.components.length, 2);
  assert.equal(result.reports[0].updatedAt, "2026-07-25T12:00:00Z");
});

test("demo data is labeled demo at the contract root and has multiple useful sections", () => {
  const result = demoDashboard();
  assert.equal(result.mode, "demo");
  assert.equal(result.state, "demo");
  assert.ok(result.quotaWindows.length >= 2);
  assert.ok(result.quotaWindows.every(isPrimaryCodexQuotaWindow));
  assert.ok(result.gradient.rolling.length > 20);
  assert.deepEqual(
    [...new Set(result.gradient.rolling.map((row) => row.smoothing_hours))].sort(),
    [1, 2, 3]
  );
  assert.ok(result.weekly.weeklyValues.length > 5);
  assert.ok(result.quality.opportunities.length > 2);
});

test("local client prefers consolidated dashboard and falls back to split endpoints", async () => {
  const calls = [];
  const consolidated = new LocalCompanionClient({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({
        schemaVersion: "local-dashboard-v0.1",
        status: "ready",
        quotaWindows: []
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  assert.equal((await consolidated.load()).state, "live");
  assert.ok(calls.includes("/api/local/v1/dashboard"));

  const split = new LocalCompanionClient({
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/dashboard") || url.endsWith("/v1/status")) {
        return new Response("", { status: 404 });
      }
      if (url.endsWith("/overview")) {
        return new Response(JSON.stringify({ schemaVersion: "split", status: "insufficient" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  assert.equal((await split.load()).schemaVersion, "split");
});

test("local refresh uses the closed same-origin contract and exposes polling", async () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ refresh: { status: "succeeded" } }), {
        status: options.method === "POST" ? 202 : 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await client.refresh();
  await client.refreshStatus();
  assert.equal(calls[0].url, "/api/local/refresh");
  assert.equal(calls[0].options.body, "{}");
  assert.equal(calls[0].options.headers["X-Usage-Monitor-Local"], "1");
  assert.equal(calls[1].options.method, undefined);
});

test("local health exposes the content-free preparation mode", async () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({
        capabilities: {
          contributionPreparationIdentityMode: "production_keychain"
        }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  assert.equal(
    (await client.health()).capabilities.contributionPreparationIdentityMode,
    "production_keychain"
  );
  assert.deepEqual(calls, ["/api/local/health"]);
});

test("local onboarding is path-free, bounded, and fails closed", async () => {
  const payload = {
    schemaVersion: LOCAL_ONBOARDING_SCHEMA_VERSION,
    status: "ready",
    source: {
      status: "ready",
      sessionsReadable: true,
      archivedSessionsReadable: false,
      rolloutFilesPresent: true,
      rolloutFilesObserved: 42,
      rolloutFilesObservedCapped: false
    },
    state: { status: "ready", writable: true },
    capabilities: {
      explicitRefresh: true,
      customCodexHomeConfigured: false,
      rawContentExposed: false,
      arbitraryPathAccess: false
    }
  };
  assert.deepEqual(normalizeLocalOnboarding(payload), {
    state: "ready",
    sourceStatus: "ready",
    sessionsReadable: true,
    archivedSessionsReadable: false,
    rolloutFilesPresent: true,
    rolloutFilesObserved: 42,
    rolloutFilesObservedCapped: false,
    stateStatus: "ready",
    stateWritable: true,
    explicitRefresh: true,
    customCodexHomeConfigured: false
  });
  assert.equal(
    normalizeLocalOnboarding({
      ...payload,
      privatePath: "/Users/private/.codex"
    }).state,
    "unavailable"
  );
  assert.equal(
    normalizeLocalOnboarding({
      ...payload,
      capabilities: {
        ...payload.capabilities,
        rawContentExposed: true
      }
    }).state,
    "unavailable"
  );

  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.equal((await client.onboarding()).state, "ready");
  assert.deepEqual(calls, ["/api/local/onboarding"]);
});

test("local contribution queue status remains bounded and fails closed", async () => {
  const normalized = normalizeContributionSyncStatus({
    schemaVersion: CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION,
    status: "available",
    paused: false,
    counts: {
      pending: 2,
      inFlight: 1,
      accepted: 8,
      retryable: 3,
      rejected: 1
    },
    dueNow: 2,
    nextAttemptAt: "2026-07-26T13:00:00.000Z",
    lastAcceptedAt: "2026-07-26T12:00:00.000Z",
    includesContent: false,
    includesPaths: false,
    includesCredentials: false,
    privatePath: "/Users/private",
    deviceSecret: "must-not-survive"
  });
  assert.equal(normalized.state, "attention");
  assert.equal(normalized.counts.accepted, 8);
  assert.equal(Object.hasOwn(normalized, "privatePath"), false);
  assert.equal(Object.hasOwn(normalized, "deviceSecret"), false);

  assert.deepEqual(
    normalizeContributionSyncStatus({
      schemaVersion: CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION,
      status: "available",
      paused: false,
      counts: {
        pending: 0,
        inFlight: 0,
        accepted: 1,
        retryable: 0,
        rejected: 0
      },
      dueNow: 0,
      includesContent: true,
      includesPaths: false,
      includesCredentials: false
    }).state,
    "unavailable"
  );

  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({
        schemaVersion: CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION,
        status: "available",
        paused: true,
        counts: {
          pending: 1,
          inFlight: 0,
          accepted: 0,
          retryable: 0,
          rejected: 0
        },
        dueNow: 1,
        nextAttemptAt: null,
        lastAcceptedAt: null,
        includesContent: false,
        includesPaths: false,
        includesCredentials: false
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.equal((await client.contributionSyncStatus()).state, "paused");
  assert.deepEqual(calls, ["/api/local/contribution/sync-status"]);
});

function automaticContributionStatusFixture(overrides = {}) {
  return {
    schemaVersion: AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION,
    status: "disabled",
    enabled: false,
    intervalHours: 6,
    consentCurrent: false,
    firstReviewComplete: true,
    firstReviewedAcceptedAt: "2026-07-29T11:59:00.000Z",
    requiredConsent: {
      telemetrySchemaVersion: "telemetry-contribution-v0.1",
      fieldDictionaryVersion: "telemetry-v0.1-registry-2026-07-25.3",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v0.1",
      destinationOrigin: "https://contribute.example.test"
    },
    consentedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextAttemptAt: null,
    lastOutcome: null,
    foregroundOnly: true,
    daemonInstalled: false,
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
    ...overrides
  };
}

test("automatic contribution settings are fixed, foreground-only, and fail closed", () => {
  const scheduled = normalizeAutomaticContributionStatus(
    automaticContributionStatusFixture({
      status: "scheduled",
      enabled: true,
      consentCurrent: true,
      consentedAt: "2026-07-29T12:00:00.000Z",
      lastAttemptAt: "2026-07-29T12:01:00.000Z",
      lastSuccessAt: "2026-07-29T12:01:00.000Z",
      nextAttemptAt: "2026-07-29T18:01:00.000Z",
      lastOutcome: {
        status: "succeeded",
        code: "accepted",
        at: "2026-07-29T12:01:00.000Z"
      }
    })
  );
  assert.equal(scheduled.state, "scheduled");
  assert.equal(scheduled.enabled, true);
  assert.equal(scheduled.intervalHours, 6);
  assert.equal(scheduled.foregroundOnly, true);
  assert.equal(scheduled.daemonInstalled, false);
  assert.equal(
    scheduled.requiredConsent.destinationOrigin,
    "https://contribute.example.test"
  );
  assert.deepEqual(scheduled.lastOutcome, {
    status: "succeeded",
    code: "accepted",
    at: "2026-07-29T12:01:00.000Z"
  });

  const publicationRecovery = normalizeAutomaticContributionStatus(
    automaticContributionStatusFixture({
      status: "scheduled",
      enabled: true,
      consentCurrent: true,
      consentedAt: "2026-07-29T12:00:00.000Z",
      lastAttemptAt: "2026-07-29T12:01:00.000Z",
      nextAttemptAt: "2026-07-29T18:01:00.000Z",
      lastOutcome: {
        status: "failed",
        code: "publication_incomplete",
        at: "2026-07-29T12:01:00.000Z"
      }
    })
  );
  assert.equal(publicationRecovery.state, "scheduled");
  assert.equal(
    publicationRecovery.lastOutcome.code,
    "publication_incomplete"
  );

  const localDevelopment = normalizeAutomaticContributionStatus(
    automaticContributionStatusFixture({
      status: "consent_required",
      requiredConsent: {
        telemetrySchemaVersion: "telemetry-contribution-v0.1",
        fieldDictionaryVersion: "telemetry-v0.1-registry-2026-07-25.3",
        privacyContractVersion: "ongoing-privacy-safe-telemetry-v0.1",
        destinationOrigin: "http://127.0.0.1:8791"
      }
    })
  );
  assert.equal(localDevelopment.state, "consent_required");

  const firstReviewRequired = normalizeAutomaticContributionStatus(
    automaticContributionStatusFixture({
      status: "first_review_required",
      firstReviewComplete: false,
      firstReviewedAcceptedAt: null
    })
  );
  assert.equal(firstReviewRequired.state, "first_review_required");
  assert.equal(firstReviewRequired.firstReviewComplete, false);
  assert.equal(firstReviewRequired.firstReviewedAcceptedAt, "");
  assert.equal(
    normalizeAutomaticContributionStatus(
      automaticContributionStatusFixture({
        status: "failed",
        firstReviewComplete: false,
        firstReviewedAcceptedAt: null
      })
    ).state,
    "failed"
  );
  assert.equal(
    normalizeAutomaticContributionStatus(
      automaticContributionStatusFixture({
        status: "not_configured",
        firstReviewComplete: false,
        firstReviewedAcceptedAt: null,
        requiredConsent: {
          telemetrySchemaVersion: "telemetry-contribution-v0.1",
          fieldDictionaryVersion: "telemetry-v0.1-registry-2026-07-25.3",
          privacyContractVersion: "ongoing-privacy-safe-telemetry-v0.1",
          destinationOrigin: null
        }
      })
    ).state,
    "not_configured"
  );

  for (const invalid of [
    automaticContributionStatusFixture({ extra: true }),
    automaticContributionStatusFixture({ intervalHours: 4 }),
    automaticContributionStatusFixture({ includesIdentifiers: true }),
    automaticContributionStatusFixture({
      status: "scheduled",
      enabled: false,
      consentCurrent: true
    }),
    automaticContributionStatusFixture({
      lastOutcome: {
        status: "succeeded",
        code: "retry_scheduled",
        at: "2026-07-29T12:01:00.000Z"
      }
    }),
    automaticContributionStatusFixture({
      firstReviewComplete: false
    }),
    automaticContributionStatusFixture({
      status: "first_review_required"
    }),
    automaticContributionStatusFixture({
      requiredConsent: {
        telemetrySchemaVersion: "telemetry-contribution-v0.1",
        fieldDictionaryVersion: "telemetry-v0.1-registry-2026-07-25.3",
        privacyContractVersion: "ongoing-privacy-safe-telemetry-v0.1",
        destinationOrigin: "https://contribute.example.test/collect"
      }
    })
  ]) {
    assert.equal(normalizeAutomaticContributionStatus(invalid).state, "unavailable");
  }
});

test("automatic contribution client uses only fixed local status, enable, and disable routes", async () => {
  const requiredConsent = automaticContributionStatusFixture().requiredConsent;
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      const payload = url.endsWith("/automatic-enable")
        ? automaticContributionStatusFixture({
            status: "scheduled",
            enabled: true,
            consentCurrent: true,
            consentedAt: "2026-07-29T12:00:00.000Z",
            nextAttemptAt: "2026-07-29T18:00:00.000Z"
          })
        : automaticContributionStatusFixture();
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  assert.equal((await client.automaticContributionStatus()).state, "disabled");
  assert.equal(
    (await client.enableAutomaticContribution(requiredConsent)).state,
    "scheduled"
  );
  assert.equal((await client.disableAutomaticContribution()).state, "disabled");
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "/api/local/contribution/automatic-settings",
      "/api/local/contribution/automatic-enable",
      "/api/local/contribution/automatic-disable"
    ]
  );
  assert.deepEqual(
    JSON.parse(calls[1].options.body),
    { intervalHours: 6, consent: requiredConsent }
  );
  assert.deepEqual(
    JSON.parse(calls[2].options.body),
    { reason: "user_request" }
  );
  assert.equal(calls[1].options.headers["X-Usage-Monitor-Local"], "1");
  assert.equal(calls[2].options.headers["X-Usage-Monitor-Local"], "1");
  await assert.rejects(
    client.enableAutomaticContribution({
      ...requiredConsent,
      destinationOrigin: "https://contribute.example.test/collect"
    }),
    /consent is invalid/u
  );

  const reviewLockedClient = new LocalCompanionClient({
    fetchImpl: async () => new Response(JSON.stringify({
      schemaVersion: "local-companion-v0.1",
      error: { code: "automatic_contribution_first_review_required" }
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" }
    })
  });
  await assert.rejects(
    reviewLockedClient.enableAutomaticContribution(requiredConsent),
    (error) => (
      error.status === 409
      && error.code === "automatic_contribution_first_review_required"
    )
  );
  const malformedReviewLockedClient = new LocalCompanionClient({
    fetchImpl: async () => new Response(JSON.stringify({
      schemaVersion: "local-companion-v0.1",
      error: {
        code: "automatic_contribution_first_review_required",
        privateDetail: "must not be trusted"
      }
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" }
    })
  });
  await assert.rejects(
    malformedReviewLockedClient.enableAutomaticContribution(requiredConsent),
    (error) => error.status === 409 && error.code === undefined
  );
});

test("local sync preview and actions keep privileged values behind loopback", async () => {
  const privateCanary = "/Users/private/telemetry-secret.json";
  const reviewToken = "r".repeat(43);
  const previewPayload = {
    schemaVersion: CONTRIBUTION_SYNC_PREVIEW_SCHEMA_VERSION,
    status: "available",
    state: "ready",
    discoveredSets: 1,
    newlyQueued: 1,
    deliveryConfigured: true,
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
    item: {
      schemaVersion: "telemetry-contribution-v0.1",
      clientPlatform: "macos",
      providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
      coveredAt: {
        startAt: "2026-07-26T12:00:00.000Z",
        endAt: "2026-07-26T12:30:00.000Z"
      },
      recordCounts: {
        usageEvents: 2,
        quotaSnapshots: 1,
        activityMarkers: 0,
        total: 3
      },
      accounting: {
        estimatedApiCostUsd: "1.250000",
        pricedEventCoveragePercent: 100,
        unknownModelEventCount: 0,
        unknownBillableUnits: 0,
        priceBasis: "current_api_prices",
        verification: "client_declared_unverified"
      },
      preparedBytes: 4096,
      reservedUploadBytes: 16384,
      attemptCount: 0,
      nextAttemptAt: "2026-07-26T13:00:00.000Z",
      privatePath: privateCanary,
      contributionId: "contribution:private"
    }
  };
  const normalizedPreview = normalizeContributionSyncPreview(previewPayload);
  assert.equal(normalizedPreview.state, "ready");
  assert.equal(normalizedPreview.item.recordCounts.total, 3);
  assert.equal(JSON.stringify(normalizedPreview).includes(privateCanary), false);
  assert.equal(JSON.stringify(normalizedPreview).includes("contribution:"), false);
  assert.equal(
    normalizeContributionSyncPreview({
      ...previewPayload,
      includesIdentifiers: true
    }).status,
    "unavailable"
  );

  const runPayload = {
    schemaVersion: CONTRIBUTION_SYNC_RUN_SCHEMA_VERSION,
    status: "completed",
    discoveredSets: 1,
    newlyQueued: 0,
    processed: 1,
    accepted: 1,
    retryable: 0,
    rejected: 0,
    reservedUploadBytes: 16384,
    bandwidthLimited: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
    privatePath: privateCanary
  };
  assert.deepEqual(normalizeContributionSyncRun(runPayload), {
    status: "completed",
    discoveredSets: 1,
    newlyQueued: 0,
    processed: 1,
    accepted: 1,
    retryable: 0,
    rejected: 0,
    reservedUploadBytes: 16384,
    bandwidthLimited: false
  });

  const calls = [];
  const statusPayload = {
    schemaVersion: CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION,
    status: "available",
    paused: true,
    counts: {
      pending: 1,
      inFlight: 0,
      accepted: 0,
      retryable: 0,
      rejected: 0
    },
    dueNow: 1,
    nextAttemptAt: "2026-07-26T13:00:00.000Z",
    lastAcceptedAt: null,
    includesContent: false,
    includesPaths: false,
    includesCredentials: false
  };
  const pairedPayload = {
    schemaVersion: "local-contribution-device-pairing-v0.1",
    status: "paired",
    scope: "upload_registration",
    expiresAt: "2026-07-26T14:00:00.000Z",
    includesCredentials: false,
    includesIdentifiers: false
  };
  assert.equal(
    normalizeLocalContributionDevicePairing(pairedPayload).status,
    "paired"
  );
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      const body = url.endsWith("device-pair")
        ? pairedPayload
        : url.endsWith("sync-next")
        ? previewPayload
        : url.endsWith("sync-once") ? runPayload : statusPayload;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.equal((await client.contributionSyncPreview()).state, "ready");
  const pairingCode =
    "um_pair_00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(
    (await client.pairContributionDevice(pairingCode)).status,
    "paired"
  );
  assert.equal((await client.runContributionSyncOnce(reviewToken)).accepted, 1);
  assert.equal((await client.setContributionSyncPaused(true)).state, "paused");
  assert.deepEqual(calls.map((call) => call.url), [
    "/api/local/contribution/sync-next",
    "/api/local/contribution/device-pair",
    "/api/local/contribution/sync-once",
    "/api/local/contribution/sync-pause"
  ]);
  for (const call of calls) {
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.headers["X-Usage-Monitor-Local"], "1");
  }
  assert.equal(calls[0].options.body, "{}");
  assert.equal(calls[1].options.body, JSON.stringify({ pairingCode }));
  assert.equal(calls[2].options.body, JSON.stringify({ reviewToken }));
  assert.equal(calls[3].options.body, "{}");
});

test("the Fast-mode preference travels on a fixed same-origin local route", async () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        schemaVersion: "fast-mode-preference-v0.1",
        mode: "mixed_unknown",
        source: "stated",
        recordedAt: "2026-08-01T12:00:00.000Z"
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  const read = await client.fastModePreference();
  assert.equal(read.mode, "mixed_unknown");
  assert.equal(read.source, "stated");
  const written = await client.selectFastModePreference("fast");
  assert.equal(written.mode, "mixed_unknown");
  assert.deepEqual(calls.map((call) => call.url), [
    "/api/local/accounting/fast-mode-preference",
    "/api/local/accounting/fast-mode-preference"
  ]);
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers["X-Usage-Monitor-Local"], "1");
  assert.equal(calls[1].options.body, JSON.stringify({ mode: "fast" }));
  // A value outside the fixed set never reaches the network.
  await assert.rejects(
    () => client.selectFastModePreference("turbo"),
    TypeError
  );
  assert.equal(calls.length, 2);

  // An unreadable preference reads back as the untouched Standard default
  // rather than an invented Fast attribution.
  const offline = new LocalCompanionClient({
    fetchImpl: async () => {
      throw new Error("companion unreachable");
    }
  });
  const fallback = await offline.fastModePreference();
  assert.equal(fallback.mode, "standard");
  assert.equal(fallback.source, "default");
});

test("local pairing preserves fixed identifier-shaped codes and drops anything else", async () => {
  const pairingCode =
    "um_pair_00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const rejectingClient = (error, status = 409) => new LocalCompanionClient({
    fetchImpl: async () => new Response(JSON.stringify({
      schemaVersion: "local-companion-v0.1",
      error,
    }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  });
  // Every fixed companion code survives, so the page can explain the actual
  // cause instead of collapsing all of them into one vague sentence.
  for (const [code, status] of [
    ["contribution_device_recovery_required", 409],
    ["contribution_device_pairing_not_configured", 409],
    ["contribution_device_pairing_failed", 502],
  ]) {
    await assert.rejects(
      rejectingClient({ code }, status).pairContributionDevice(pairingCode),
      (error) => error?.status === status && error?.code === code,
    );
  }

  // Anything that is not an identifier-shaped code cannot reach the page: a
  // sentence, a path, a non-string, or an extra member all drop back to a
  // codeless rejection carrying only the page's own fallback copy.
  for (const error of [
    { code: "Pairing failed at /Users/private/state.json" },
    { code: "MixedCase_Code" },
    { code: 42 },
    { code: "contribution_device_recovery_required", detail: "untrusted" },
  ]) {
    await assert.rejects(
      rejectingClient(error).pairContributionDevice(pairingCode),
      (rejected) => rejected?.status === 409 && rejected?.code === undefined,
    );
  }
});

test("exact prepared review uses a fixed local mutation route", async () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        schemaVersion: "contribution-sync-exact-review-v0.1",
        status: "available",
        state: "ready",
        networkActivity: false,
        payloadBytes: 100,
        reviewToken: "r".repeat(43),
        payload: { schemaVersion: "telemetry-contribution-v0.1" }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  await client.contributionSyncExactReview();
  assert.equal(calls[0].url, "/api/local/contribution/sync-inspect-exact");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Usage-Monitor-Local"], "1");
});

test("local contribution preparation exposes only verified bounded results", async () => {
  const privateCanary = "/Users/private/raw-rollout.jsonl";
  const payload = {
    schemaVersion: "local-contribution-preparation-result-v0.1",
    status: "prepared",
    coveredAt: {
      startAt: "2026-07-26T12:00:00.000Z",
      endAt: "2026-07-26T13:00:00.000Z"
    },
    recordCounts: {
      usageEvents: 10,
      quotaSnapshots: 2,
      activityMarkers: 1
    },
    privacy: {
      verdict: "passed",
      checksPassed: 8,
      checksFailed: 0,
      sourceTransportReady: false,
      provenanceRetained: true
    },
    prepared: {
      schemaVersion: "prepared-contribution-set-v0.1",
      eligibleSchemaVersion: "telemetry-contribution-v0.1",
      batchCount: 1,
      bytes: 4_096
    },
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
    privatePath: privateCanary
  };
  const result = normalizeLocalContributionPreparation(payload);
  assert.equal(result.status, "prepared");
  assert.equal(result.recordCounts.usageEvents, 10);
  assert.equal(result.prepared.bytes, 4_096);
  assert.equal(JSON.stringify(result).includes(privateCanary), false);
  assert.equal(
    normalizeLocalContributionPreparation({
      ...payload,
      includesPaths: true
    }).status,
    "unavailable"
  );

  const requestedLookbacks = [];
  const successClient = new LocalCompanionClient({
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/local/contribution/prepare");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["X-Usage-Monitor-Local"], "1");
      const request = JSON.parse(options.body);
      assert.deepEqual(Object.keys(request), ["lookbackHours"]);
      assert.ok([1, 24, 7 * 24].includes(request.lookbackHours));
      requestedLookbacks.push(request.lookbackHours);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.equal((await successClient.prepareContribution()).status, "prepared");
  assert.equal(
    (await successClient.prepareContribution({ lookbackHours: 1 })).status,
    "prepared",
  );
  assert.equal(
    (await successClient.prepareContribution({
      lookbackHours: 7 * 24,
    })).status,
    "prepared",
  );
  assert.deepEqual(requestedLookbacks, [24, 1, 7 * 24]);
  await assert.rejects(
    successClient.prepareContribution({ lookbackHours: 2 }),
    /lookback is invalid/u,
  );
  await assert.rejects(
    successClient.prepareContribution({
      lookbackHours: 24,
      privatePath: "/Users/private",
    }),
    /options are invalid/u,
  );

  const failureClient = new LocalCompanionClient({
    fetchImpl: async () => new Response(JSON.stringify({
      schemaVersion: "local-contribution-preparation-error-v0.1",
      status: "failed",
      errorCode: "identity_unavailable",
      privatePath: privateCanary
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    })
  });
  await assert.rejects(
    failureClient.prepareContribution(),
    (error) => error.code === "identity_unavailable"
      && error.message === "Request failed (503)."
      && !JSON.stringify(error).includes(privateCanary)
  );
});

test("community adapter separates cookie sessions from one-use upload authority", async () => {
  const calls = [];
  const participantId = "participant:00000000-0000-4000-8000-000000000001";
  const client = new CommunityClient({
    getCsrfToken: () => "csrf-confirmation",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      const payload = url === "/api/v1/me" && options.method === "DELETE"
        ? { deleted: true, participantId, contributionsDeleted: 0 }
        : { ok: true };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await client.session();
  await client.registerUpload({
    envelopeDigest: "a".repeat(64),
    contentLengthBytes: 123,
    contentType: "application/json"
  });
  await client.contributeSerialized(
    JSON.stringify({ schemaVersion: TELEMETRY_ENVELOPE_SCHEMA_VERSION }),
    "one-use-upload"
  );
  await client.personalStats();
  await client.communityStats();
  await client.participantExport();
  await client.deleteParticipant();
  await client.createDevicePairing();
  await client.devices();
  await client.revokeDevice("00000000-0000-4000-8000-000000000001");
  await client.logout();
  await client.securityReset();
  assert.equal(calls[0].url, "/api/v1/session");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[1].url, "/api/v1/me/upload-authorizations");
  assert.equal(calls[1].options.headers["X-Usage-Monitor-CSRF"], "csrf-confirmation");
  assert.equal(calls[1].options.credentials, "same-origin");
  assert.equal(calls[2].url, "/api/v1/contributions");
  assert.equal(calls[2].options.headers.Authorization, "Upload one-use-upload");
  assert.equal(calls[2].options.credentials, "omit");
  assert.equal(calls[3].url, "/api/v1/me/stats");
  assert.equal(calls[3].options.credentials, "same-origin");
  assert.equal(calls[4].url, "/api/v1/stats/aggregate");
  assert.equal(calls[5].url, "/api/v1/me/export");
  assert.equal(calls[6].url, "/api/v1/me");
  assert.equal(calls[6].options.method, "DELETE");
  assert.equal(calls[6].options.headers["X-Usage-Monitor-CSRF"], "csrf-confirmation");
  assert.equal(calls[7].url, "/api/v1/me/device-pairings");
  assert.equal(calls[7].options.headers["X-Usage-Monitor-CSRF"], "csrf-confirmation");
  assert.match(calls[7].options.body, /ongoing-privacy-safe-telemetry-v0\.1/);
  assert.equal(calls[8].url, "/api/v1/me/devices");
  assert.equal(calls[9].url, "/api/v1/me/devices/revoke");
  assert.equal(calls[9].options.method, "POST");
  assert.equal(calls[9].options.headers["X-Usage-Monitor-CSRF"], "csrf-confirmation");
  assert.match(calls[9].options.body, /00000000-0000-4000-8000-000000000001/);
  assert.equal(calls[10].url, "/api/v1/logout");
  assert.equal(calls[11].url, "/api/v1/me/security-reset");
  await client.health();
  await client.readiness();
  await client.enroll("um_invite_test");
  await client.recover("um_recovery_test");
  assert.equal(calls[12].url, "/api/health");
  assert.equal(calls[13].url, "/api/ready");
  assert.match(calls[14].options.body, /privacy-safe-telemetry-v0\.1/);
  assert.match(calls[14].options.body, /um_invite_test/);
  assert.match(calls[15].options.body, /um_recovery_test/);
});

test("community enrollment can atomically request one upload-only device pairing", async () => {
  const calls = [];
  const client = new CommunityClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        schemaVersion: "participant-bootstrap-v0.1",
        state: "pairing_ready"
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  await client.enroll(
    "invite-code",
    "telemetry-contribution-v0.1",
    { deviceBootstrap: true }
  );
  assert.equal(calls[0].url, "/api/v1/enroll");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    consentVersion: "privacy-safe-telemetry-v0.1",
    syntheticOnly: false,
    deviceBootstrap: {
      ongoingUpload: true,
      consentVersion: "ongoing-privacy-safe-telemetry-v0.1"
    },
    inviteCode: "invite-code"
  });
});

test("hosted Google sign-in starts, polls, and refuses anything but Google's authorize URL", async () => {
  const calls = [];
  const state = "G".repeat(64);
  let responseStatus = 200;
  let responsePayload = () => ({
    schemaVersion: "identity-google-start-v0.1",
    state,
    authorizeUrl:
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=test.apps.googleusercontent.com&state=${state}`
  });
  const client = new CommunityClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(responsePayload()), {
        status: responseStatus,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  const started = await client.identityGoogleStart();
  assert.equal(started.state, state);
  assert.equal(
    started.authorizeUrl.startsWith(
      "https://accounts.google.com/o/oauth2/v2/auth?"
    ),
    true
  );
  assert.equal(calls[0].url, "/api/v1/identity/google/start");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "same-origin");
  // The start request carries nothing at all: no client id, no redirect, no
  // PKCE verifier. The service owns every one of them.
  assert.deepEqual(JSON.parse(calls[0].options.body), {});

  // A tampered authorize URL is never handed to window.open.
  for (const authorizeUrl of [
    "https://attacker.example/o/oauth2/v2/auth?client_id=x",
    "https://accounts.google.com.attacker.example/o/oauth2/v2/auth?a=b",
    "https://accounts.google.com/o/oauth2/v2/authorize?a=b",
    "javascript:alert(1)",
    "https://accounts.google.com/o/oauth2/v2/auth"
  ]) {
    responsePayload = () => ({
      schemaVersion: "identity-google-start-v0.1",
      state,
      authorizeUrl
    });
    await assert.rejects(
      client.identityGoogleStart(),
      /usable Google sign-in request/u
    );
  }
  responsePayload = () => ({
    schemaVersion: "identity-google-start-v0.1",
    state: "too-short",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?a=b"
  });
  await assert.rejects(
    client.identityGoogleStart(),
    /usable Google sign-in request/u
  );
  // An Apple start payload can never satisfy a Google start.
  responsePayload = () => ({
    schemaVersion: "identity-apple-start-v0.1",
    state,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?a=b"
  });
  await assert.rejects(
    client.identityGoogleStart(),
    /usable Google sign-in request/u
  );

  responsePayload = () => ({
    schemaVersion: "identity-google-result-v0.1",
    proof: "P".repeat(64)
  });
  const identity = await client.identityGoogleResult(state);
  assert.deepEqual(identity, {
    provider: "google",
    proof: "P".repeat(64)
  });
  const resultCall = calls.at(-1);
  assert.equal(resultCall.url, "/api/v1/identity/google/result");
  assert.equal(resultCall.options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(resultCall.options.body), { state });

  await assert.rejects(client.identityGoogleResult("short"), TypeError);
  await assert.rejects(client.identityGoogleResult(null), TypeError);

  // A pending sign-in is a signal to keep polling, not a failure.
  responseStatus = 404;
  responsePayload = () => ({ error: { code: "IDENTITY_RESULT_PENDING" } });
  await assert.rejects(
    client.identityGoogleResult(state),
    (error) => error.status === 404
      && error.code === "IDENTITY_RESULT_PENDING"
  );
  // A consumed, replayed, or expired state is refused outright.
  responseStatus = 401;
  responsePayload = () => ({ error: { code: "IDENTITY_TOKEN_INVALID" } });
  await assert.rejects(
    client.identityGoogleResult(state),
    (error) => error.status === 401 && error.code === "IDENTITY_TOKEN_INVALID"
  );
  responseStatus = 503;
  responsePayload = () => ({ error: { code: "IDENTITY_CONFIGURATION_INVALID" } });
  await assert.rejects(
    client.identityGoogleStart(),
    (error) => error.status === 503
      && error.code === "IDENTITY_CONFIGURATION_INVALID"
  );
  responseStatus = 401;
  responsePayload = () => ({ error: { code: "PRIVATE_DETAIL_MUST_NOT_PASS" } });
  await assert.rejects(
    client.identityGoogleResult(state),
    (error) => error.status === 401 && error.code === undefined
  );
  responseStatus = 200;
  responsePayload = () => ({
    schemaVersion: "identity-google-result-v0.1",
    proof: ""
  });
  await assert.rejects(
    client.identityGoogleResult(state),
    /usable Google sign-in proof/u
  );
});

// The client-side authorization request is gone, not merely unused. It built a
// provider URL in the page, kept a PKCE verifier there, and read the result out
// of a loopback callback's localStorage write — a completion signal the
// dashboard cannot receive when it runs inside the macOS app, whose web view
// refuses every remote origin and shares no storage with the browser that
// finishes the sign-in. Leaving any of it reachable would leave two ways to
// turn a code into an identity, one of them client-controlled.
test("no client-side Google authorization path survives in the shipped modules", async () => {
  const [libSource, appSource, clientSource] = await Promise.all([
    readFile(new URL("../public/lib.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/data-client.js", import.meta.url), "utf8"),
  ]);
  for (const [name, source] of [
    ["lib.js", libSource],
    ["app.js", appSource],
    ["data-client.js", clientSource],
  ]) {
    for (const retired of [
      "createGoogleSignInRequest",
      "parseGoogleSignInResult",
      "GOOGLE_OAUTH_RESULT_STORAGE_KEY",
      "tibotattle-google-oauth-result",
      "identityGoogleExchange",
      "identity/google/exchange",
      "oauth/google/callback",
      "code_challenge",
      "codeVerifier",
      "localStorage",
    ]) {
      assert.equal(source.includes(retired), false, `${name}: ${retired}`);
    }
  }
  // The only provider URL any of these modules names is the one the service is
  // required to have built, checked before it is opened.
  assert.equal(
    (clientSource.match(/https:\/\/accounts\.google\.com/gu) ?? []).length,
    1
  );
  assert.equal(libSource.includes("accounts.google.com"), false);
  assert.equal(appSource.includes("accounts.google.com"), false);
});

test("a hosted identity enrolls same-origin with fixed error codes", async () => {
  const calls = [];
  const state = "G".repeat(64);
  let responseStatus = 200;
  let responsePayload = () => ({
    schemaVersion: "identity-google-result-v0.1",
    proof: "P".repeat(64)
  });
  const client = new CommunityClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(responsePayload()), {
        status: responseStatus,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  const identity = await client.identityGoogleResult(state);
  assert.deepEqual(identity, {
    provider: "google",
    proof: "P".repeat(64)
  });
  assert.equal(calls[0].url, "/api/v1/identity/google/result");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0].options.body), { state });

  await client.enroll(null, "telemetry-contribution-v0.1", {
    deviceBootstrap: true,
    identity
  });
  assert.equal(calls[1].url, "/api/v1/enroll");
  assert.deepEqual(JSON.parse(calls[1].options.body).identity, {
    provider: "google",
    proof: "P".repeat(64)
  });
  await client.enroll(null, "telemetry-contribution-v0.1", {
    identity: { provider: "apple", proof: "A".repeat(64) }
  });
  assert.deepEqual(JSON.parse(calls[2].options.body).identity, {
    provider: "apple",
    proof: "A".repeat(64)
  });
  assert.equal(
    Object.hasOwn(JSON.parse(calls[2].options.body), "deviceBootstrap"),
    false
  );
  await assert.rejects(
    client.enroll(null, "telemetry-contribution-v0.1", {
      identity: { provider: "github", proof: "A".repeat(64) }
    }),
    TypeError
  );
  await assert.rejects(
    client.enroll(null, "telemetry-contribution-v0.1", {
      identity: { provider: "google", proof: "A".repeat(64), extra: true }
    }),
    TypeError
  );
  assert.equal(calls.length, 3);

  responseStatus = 401;
  responsePayload = () => ({ error: { code: "IDENTITY_REQUIRED" } });
  await assert.rejects(
    client.enroll(null, "telemetry-contribution-v0.1", { identity: null }),
    (error) => error.status === 401 && error.code === "IDENTITY_REQUIRED"
  );

  // Enrollment errors are not hosted-identity endpoint errors. Preserve the
  // service's fixed code and request id so the connection view can tell the
  // user whether storage, enrollment policy, or another specific boundary
  // failed rather than showing a generic retry sentence.
  const requestId = "00000000-0000-4000-8000-000000000007";
  responseStatus = 503;
  responsePayload = () => ({
    error: { code: "BACKEND_STORAGE_UNAVAILABLE", requestId }
  });
  await assert.rejects(
    client.enroll(null, "telemetry-contribution-v0.1", {
      identity: { provider: "google", proof: "P".repeat(64) }
    }),
    (error) => error.status === 503
      && error.code === "BACKEND_STORAGE_UNAVAILABLE"
      && error.requestId === requestId
  );
});

test("hosted Apple sign-in starts, polls, and refuses anything but Apple's authorize URL", async () => {
  const calls = [];
  const state = "S".repeat(64);
  let responseStatus = 200;
  let responsePayload = () => ({
    schemaVersion: "identity-apple-start-v0.1",
    state,
    authorizeUrl:
      `https://appleid.apple.com/auth/authorize?client_id=com.tibotattle.web&state=${state}`
  });
  const client = new CommunityClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(responsePayload()), {
        status: responseStatus,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  const started = await client.identityAppleStart();
  assert.equal(started.state, state);
  assert.equal(
    started.authorizeUrl.startsWith("https://appleid.apple.com/auth/authorize?"),
    true
  );
  assert.equal(calls[0].url, "/api/v1/identity/apple/start");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0].options.body), {});

  // A tampered authorize URL is never handed to window.open.
  for (const authorizeUrl of [
    "https://attacker.example/auth/authorize?client_id=x",
    "https://appleid.apple.com.attacker.example/auth/authorize?a=b",
    "javascript:alert(1)",
    "https://appleid.apple.com/auth/authorize"
  ]) {
    responsePayload = () => ({
      schemaVersion: "identity-apple-start-v0.1",
      state,
      authorizeUrl
    });
    await assert.rejects(
      client.identityAppleStart(),
      /usable Apple sign-in request/u
    );
  }
  responsePayload = () => ({
    schemaVersion: "identity-apple-start-v0.1",
    state: "too-short",
    authorizeUrl: "https://appleid.apple.com/auth/authorize?a=b"
  });
  await assert.rejects(
    client.identityAppleStart(),
    /usable Apple sign-in request/u
  );

  responsePayload = () => ({
    schemaVersion: "identity-apple-result-v0.1",
    proof: "A".repeat(64)
  });
  const identity = await client.identityAppleResult(state);
  assert.deepEqual(identity, {
    provider: "apple",
    proof: "A".repeat(64)
  });
  const resultCall = calls.at(-1);
  assert.equal(resultCall.url, "/api/v1/identity/apple/result");
  assert.equal(resultCall.options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(resultCall.options.body), { state });

  await assert.rejects(client.identityAppleResult("short"), TypeError);
  await assert.rejects(client.identityAppleResult(null), TypeError);

  responseStatus = 404;
  responsePayload = () => ({ error: { code: "IDENTITY_RESULT_PENDING" } });
  await assert.rejects(
    client.identityAppleResult(state),
    (error) => error.status === 404
      && error.code === "IDENTITY_RESULT_PENDING"
  );
  responseStatus = 401;
  responsePayload = () => ({ error: { code: "IDENTITY_TOKEN_INVALID" } });
  await assert.rejects(
    client.identityAppleResult(state),
    (error) => error.status === 401 && error.code === "IDENTITY_TOKEN_INVALID"
  );
  responseStatus = 503;
  responsePayload = () => ({ error: { code: "IDENTITY_CONFIGURATION_INVALID" } });
  await assert.rejects(
    client.identityAppleStart(),
    (error) => error.status === 503
      && error.code === "IDENTITY_CONFIGURATION_INVALID"
  );
  responseStatus = 200;
  responsePayload = () => ({
    schemaVersion: "identity-apple-result-v0.1",
    proof: ""
  });
  await assert.rejects(
    client.identityAppleResult(state),
    /usable Apple sign-in proof/u
  );
});

// Every point where the companion health response is stored, paired with the
// statements that follow it, so a test can require what must happen there.
function assignsCompanionHealth(source) {
  const branches = [];
  const assignment = /localCompanionHealth = localHealth;/gu;
  for (let match = assignment.exec(source); match !== null; match = assignment.exec(source)) {
    branches.push(source.slice(match.index, match.index + 600));
  }
  assert.ok(branches.length >= 2, "expected both the loaded and fallback health paths");
  return branches;
}

test("hosted sign-in step gates contribution and keeps identity copy truthful", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  // The Google client identifier is public — it appears in every
  // authorization URL — so it ships in source rather than being injected at
  // packaging time. Only its paired secret is confidential, and that lives
  // solely in the contribution service.
  assert.match(
    html,
    /<meta name="usage-monitor-google-client-id" content="[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com">/u
  );
  assert.match(html, /id="identity-google-signin"/u);
  assert.match(html, /id="identity-apple-signin"/u);
  assert.match(html, /id="identity-apple-unavailable"/u);
  // Each vendor's exact required label, on a button carrying that vendor's
  // mark. The marks are inline SVG: the release build hashes every shipped
  // file and the local dashboard forbids off-origin subresources, so a hosted
  // or CDN-served brand asset is not an option.
  assert.match(
    html,
    /id="identity-google-signin"[\s\S]{0,400}#provider-mark-google[\s\S]{0,200}>Sign in with Google</u,
  );
  assert.match(
    html,
    /id="identity-apple-signin"[\s\S]{0,400}#provider-mark-apple[\s\S]{0,200}>Sign in with Apple</u,
  );
  // Google's four-colour "G" and Apple's solid monochrome logo, drawn here.
  for (const brandColor of ["#ea4335", "#4285f4", "#fbbc05", "#34a853"]) {
    assert.match(html, new RegExp(`<symbol id="provider-mark-google"[\\s\\S]*?fill="${brandColor}"`, "u"));
  }
  assert.match(
    html,
    /<symbol id="provider-mark-apple"[\s\S]*?fill="currentColor"/u,
  );
  assert.doesNotMatch(html, /<symbol id="provider-mark-apple"[\s\S]*?fill="#/u);
  // Google requires at least a 40px button; Apple's pill and Google's white
  // face with its published rule and label colour are reproduced exactly.
  assert.match(styles, /\.provider-button \{[\s\S]*?min-height: 44px;/u);
  assert.match(
    styles,
    /\.provider-button-google \{ color: #1f1f1f; background: #fff; border-color: #747775; \}/u,
  );
  assert.match(
    styles,
    /\.provider-button-apple \{ color: #fff; background: #000; border-color: #000; \}/u,
  );
  assert.match(styles, /\.provider-button \{[\s\S]*?border-radius: 99px;/u);
  // Keyboard reachable with a focus ring that is visible against both faces.
  assert.doesNotMatch(html, /id="identity-(?:google|apple)-signin"[^>]*tabindex/u);
  assert.match(
    styles,
    /\.provider-button:focus-visible \{ outline: 3px solid var\(--blue\); outline-offset: 3px; \}/u,
  );
  assert.match(html, /Hosted sign-in is not configured for this build\./u);
  assert.match(
    html,
    /Hosted Apple sign-in is not configured for this build\./u
  );
  // Both providers finish through the contribution service, so a build without
  // one must disable them rather than fail after the click.
  assert.match(
    appSource,
    /const serviceConfigured\s*=\s*\n?\s*localCompanionHealth\?\.capabilities\?\.contributionDevicePairing === true;/u,
  );
  assert.match(
    appSource,
    /This build has no contribution service, so hosted sign-in is unavailable\./u,
  );
  // That gate reads a capability the companion reports asynchronously, so both
  // load paths must re-render the controls once it lands. Bootstrap renders
  // them before the first health response, and without these calls the buttons
  // keep the disabled state they were given when the capability was unknown --
  // leaving a click that silently does nothing in every build.
  for (const branch of assignsCompanionHealth(appSource)) {
    assert.match(
      branch,
      /renderHostedIdentity\(\);/u,
      "each localCompanionHealth assignment must re-render the sign-in controls",
    );
  }
  // The dead native handoff copy is gone: Apple provisions Sign in with Apple
  // only for Ad hoc, App Store Connect, and Development distribution, so a
  // Developer ID build can never carry the entitlement.
  assert.equal(/Use Apple sign-in from the app/u.test(html), false);
  assert.match(html, /irreversible hash of that sign-in/u);
  assert.match(html, /never your email or name/u);
  assert.match(html, /Local-only use needs no account\./u);

  // A real signed-in state: a provider badge, which provider it is, and a way
  // out. The copy must not imply that leaving deletes anything hosted.
  for (const id of [
    "identity-signin-choices",
    "identity-account",
    "identity-account-badge",
    "identity-account-mark",
    "identity-account-provider",
    "identity-signout",
    "identity-signin-pending-actions",
    "identity-signin-check",
    "identity-signin-cancel",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  // Sign out keeps the full 44px target and stays outside the only rule that
  // hides compact buttons. Matching the scoped selector matters: the unscoped
  // ".button.compact { display: none; }" regression is a substring of the
  // scoped rule, so an unanchored pattern would pass either way.
  const signOutTag =
    html.match(/<button[^>]*id="identity-signout"[^>]*>/u)?.[0] ?? "";
  assert.match(signOutTag, /class="button button-quiet"/u);
  assert.doesNotMatch(signOutTag, /\bcompact\b/u);
  assert.match(
    styles,
    /@media \(max-width: 760px\)[\s\S]*?\.topbar \.button\.compact \{ display: none; \}/u,
  );
  assert.match(html, />\s*Sign out\s*</u);
  assert.match(html, /Signing out only forgets this sign-in on this page\./u);
  assert.match(html, /metadata already contributed stays until you delete it/u);
  assert.match(html, /<div class="identity-account" id="identity-account" hidden>/u);

  assert.match(appSource, /function configuredGoogleClientId\(\)/u);
  assert.match(appSource, /function hostedSignInRequired\(\)/u);
  assert.match(appSource, /hostedSignInRequired\(\)\s*\|\|/u);
  assert.match(appSource, /identity: hostedIdentity/u);
  // Both providers run the same server-owned handoff: a start that returns an
  // unguessable state, and a bounded poll for the one-time result. Neither
  // completes through a client-side redirect, so neither depends on the page
  // that started it still being the page that receives anything.
  assert.match(appSource, /communityClient\.identityGoogleStart\(\)/u);
  assert.match(appSource, /communityClient\.identityGoogleResult\(/u);
  assert.match(appSource, /communityClient\.identityAppleStart\(\)/u);
  assert.match(appSource, /communityClient\.identityAppleResult\(/u);
  assert.match(appSource, /IDENTITY_RESULT_PENDING/u);
  assert.match(
    appSource,
    /Hosted Apple sign-in is not configured for this build\./u
  );
  assert.match(
    appSource,
    /Hosted Google sign-in is not configured for this build\./u
  );
  assert.equal(/takeAppleIdentityToken/u.test(appSource), false);
  assert.equal(/api\/local\/identity\/apple/u.test(appSource), false);
  assert.match(appSource, /IDENTITY_REQUIRED/u);
  assert.match(appSource, /IDENTITY_TOKEN_INVALID/u);
  assert.match(appSource, /IDENTITY_CONFIGURATION_INVALID/u);
  assert.match(appSource, /let hostedIdentity = null;/u);

  // One poll loop serves both providers, and it stops exactly when the
  // service's five-minute handoff expires rather than earlier: the user is
  // authenticating in a separate browser window, which inside the macOS app is
  // the only place a provider host can be loaded at all.
  const pollBody =
    appSource.match(/async function beginHostedSignIn\([\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(pollBody, /HOSTED_SIGNIN_POLL_ATTEMPTS/u);
  assert.match(pollBody, /error\?\.code !== "IDENTITY_RESULT_PENDING"/u);
  assert.match(pollBody, /if \(attempt\.returnedToApp\)/u);
  assert.match(
    pollBody,
    /sign-in did not complete\. Nothing was uploaded\. You can try again\./u,
  );
  assert.match(pollBody, /openHostedSignInInBrowser\(request\.authorizeUrl\)/u);
  assert.match(pollBody, /waitForHostedSignInPoll\(attempt\)/u);
  assert.match(pollBody, /foregroundNativeDashboardAfterSignIn\(\)/u);
  const handoffBody =
    appSource.match(/function openHostedSignInInBrowser\([\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(handoffBody, /runsInsideNativeDashboard\(\)/u);
  assert.match(handoffBody, /window\.location\.assign\(authorizeUrl\)/u);
  assert.match(
    handoffBody,
    /window\.open\(authorizeUrl, "_blank", "noopener,noreferrer"\)/u,
  );
  const foregroundBody =
    appSource.match(/function foregroundNativeDashboardAfterSignIn\([\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(foregroundBody, /SEMANTIC_OPEN_TARGET/u);
  assert.match(foregroundBody, /window\.location\.assign\(SEMANTIC_OPEN_TARGET\)/u);
  const attempts = Number(
    appSource.match(/const HOSTED_SIGNIN_POLL_ATTEMPTS = (\d+);/u)?.[1]
  );
  const interval = Number(
    appSource.match(/const HOSTED_SIGNIN_POLL_INTERVAL_MS = ([\d_]+);/u)?.[1]
      ?.replace(/_/gu, "")
  );
  assert.equal(attempts * interval, 5 * 60 * 1_000);

  // A browser handoff remains recoverable: the callback can wake the bounded
  // poll immediately, and the person can check or cancel without waiting for
  // the server-side expiry.
  assert.match(appSource, /function checkHostedSignInNow\(\)/u);
  assert.match(appSource, /function cancelHostedSignIn\(\)/u);
  assert.match(html, />\s*Cancel sign-in\s*</u);
  assert.match(appSource, /Nothing was uploaded\./u);
  assert.match(
    appSource,
    /window\.addEventListener\("tibotattle:hosted-sign-in-return", checkHostedSignInNow\);/u,
  );
  assert.match(
    appSource,
    /\$\("#identity-signin-check"\)\.addEventListener\("click", checkHostedSignInNow\);/u,
  );
  assert.match(
    appSource,
    /\$\("#identity-signin-cancel"\)\.addEventListener\("click", cancelHostedSignIn\);/u,
  );
  const cancelBody =
    appSource.match(/function cancelHostedSignIn\(\)\s*\{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.match(cancelBody, /attempt\.cancelled = true;/u);
  assert.match(cancelBody, /activeHostedSignIn = null;/u);
  assert.match(cancelBody, /hostedIdentityBusy = false;/u);
  assert.match(cancelBody, /renderHostedIdentity\(\);/u);
  assert.match(
    pollBody,
    /IDENTITY_TOKEN_INVALID:\s*`\$\{flow\.label\} sign-in was cancelled or did not complete/u,
  );

  // Signing out is page-local: it forgets the memory-only identity and the
  // pseudonymous session it enrolled, so the next sign-in can be a different
  // account, and it calls nothing that could delete hosted data.
  const signOutBody =
    appSource.match(/function signOutHostedIdentity\(\)\s*\{[\s\S]*?\n\}/u)?.[0]
      ?? "";
  assert.match(signOutBody, /hostedIdentity = null;/u);
  assert.match(signOutBody, /setCommunitySession\(null\);/u);
  assert.match(signOutBody, /renderHostedIdentity\(\);/u);
  assert.match(signOutBody, /nothing was deleted/u);
  assert.doesNotMatch(
    signOutBody,
    /communityClient\.|localClient\.|deleteParticipant|deleteContribution/u,
  );
  assert.match(
    appSource,
    /\$\("#identity-signout"\)\.addEventListener\("click", signOutHostedIdentity\);/u,
  );
  // Both states are driven from one render pass, so the buttons always return
  // to their signed-out form when the identity is dropped.
  const renderBody =
    appSource.match(/function renderHostedIdentity\(\)\s*\{[\s\S]*?\n\}/u)?.[0]
      ?? "";
  assert.match(renderBody, /\$\("#identity-signin-choices"\)\.hidden = signedIn;/u);
  assert.match(renderBody, /\$\("#identity-account"\)\.hidden = !signedIn;/u);
  assert.match(renderBody, /\$\("#identity-account-mark"\)\.setAttribute\("href", provider\.mark\);/u);

  // The invitation field is gone from the dashboard: production enrollment is
  // open, so nothing here collects, echoes, or clears an invitation code.
  assert.doesNotMatch(html, /contribution-invite|invite-help|Invitation code/u);
  assert.doesNotMatch(appSource, /inviteInput|inviteCode|invite-help/u);
  assert.doesNotMatch(styles, /invite-row|contribution-invite/u);
});

test("backend readiness accepts fail-closed 503 state without calling it ready", async () => {
  const payload = {
    status: "not_ready",
    checks: {
      lifecycle: "stale",
      lifecycleFresh: false,
      quarantineRetentionComplete: true,
      restoreReplayComplete: true,
      aggregateRebuildComplete: false,
      maintenanceCycleMatched: false,
      quarantineReconciliation: "running",
      quarantineReconciliationComplete: false
    },
    policy: {
      lifecycleStaleAfterMilliseconds: 3_600_000
    }
  };
  let fetchReceiver = "not-called";
  const client = new CommunityClient({
    fetchImpl: async function fetchReadiness() {
      fetchReceiver = this;
      return new Response(JSON.stringify(payload), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.deepEqual(await client.readiness(), {
    state: "not_ready",
    lifecycle: "stale",
    lifecycleFresh: false,
    quarantineRetentionComplete: true,
    restoreReplayComplete: true,
    aggregateRebuildComplete: false,
    maintenanceCycleMatched: false,
    quarantineReconciliation: "running",
    quarantineReconciliationComplete: false
  });
  assert.equal(fetchReceiver, undefined);
  const ready = {
    ...payload,
    status: "ready",
    checks: {
      lifecycle: "ready",
      lifecycleFresh: true,
      quarantineRetentionComplete: true,
      restoreReplayComplete: true,
      aggregateRebuildComplete: true,
      maintenanceCycleMatched: true,
      quarantineReconciliation: "completed",
      quarantineReconciliationComplete: true
    }
  };
  assert.deepEqual(normalizeBackendReadiness(ready), {
    state: "ready",
    lifecycle: "ready",
    lifecycleFresh: true,
    quarantineRetentionComplete: true,
    restoreReplayComplete: true,
    aggregateRebuildComplete: true,
    maintenanceCycleMatched: true,
    quarantineReconciliation: "completed",
    quarantineReconciliationComplete: true
  });
  assert.equal(
    normalizeBackendReadiness({
      ...ready,
      checks: { ...ready.checks, maintenanceCycleMatched: false }
    }).state,
    "unavailable"
  );
  assert.equal(
    normalizeBackendReadiness({ ...payload, leakedPath: "/private/log" }).state,
    "unavailable"
  );
});

test("contribution read and deletion keep identifiers out of request URLs", async () => {
  const calls = [];
  const contributionId = "contribution:00000000-0000-4000-8000-000000000001";
  const client = new CommunityClient({
    getCsrfToken: () => "csrf-confirmation",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const payload = url.endsWith("/delete")
        ? { deleted: true, contributionId }
        : { ok: true };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  await client.contribution(contributionId);
  await client.deleteContribution(contributionId);

  assert.deepEqual(calls.map((call) => call.url), [
    "/api/v1/me/contributions/read",
    "/api/v1/me/contributions/delete"
  ]);
  for (const call of calls) {
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.headers["X-Usage-Monitor-CSRF"], "csrf-confirmation");
    assert.equal(JSON.parse(call.options.body).contributionId, contributionId);
    assert.equal(call.url.includes(contributionId), false);
  }
});

test("deletion receipts fail closed before the UI can claim success", async () => {
  const contributionId = "contribution:00000000-0000-4000-8000-000000000001";
  const participantId = "participant:00000000-0000-4000-8000-000000000001";

  assert.deepEqual(
    normalizeContributionDeletionReceipt(
      { deleted: true, contributionId },
      contributionId
    ),
    { deleted: true, contributionId }
  );
  assert.deepEqual(
    normalizeParticipantDeletionReceipt({
      deleted: true,
      participantId,
      contributionsDeleted: 2
    }),
    { deleted: true, participantId, contributionsDeleted: 2 }
  );

  assert.throws(
    () => normalizeContributionDeletionReceipt({ deleted: true }, contributionId),
    /invalid contribution deletion receipt/
  );
  assert.throws(
    () => normalizeContributionDeletionReceipt(
      {
        deleted: true,
        contributionId: "contribution:00000000-0000-4000-8000-000000000002"
      },
      contributionId
    ),
    /invalid contribution deletion receipt/
  );
  assert.throws(
    () => normalizeParticipantDeletionReceipt({
      deleted: true,
      participantId,
      contributionsDeleted: -1
    }),
    /invalid participant deletion receipt/
  );
  assert.throws(
    () => normalizeParticipantDeletionReceipt({
      deleted: true,
      participantId,
      contributionsDeleted: "1"
    }),
    /invalid participant deletion receipt/
  );
  assert.throws(
    () => normalizeParticipantDeletionReceipt(
      { deleted: true, participantId, contributionsDeleted: 1 },
      "participant:00000000-0000-4000-8000-000000000002"
    ),
    /invalid participant deletion receipt/
  );
  assert.throws(
    () => normalizeParticipantDeletionReceipt({
      deleted: true,
      participantId,
      contributionsDeleted: 1,
      ignored: true
    }),
    /invalid participant deletion receipt/
  );

  const malformedClient = new CommunityClient({
    getCsrfToken: () => "csrf-confirmation",
    fetchImpl: async () => new Response(JSON.stringify({ deleted: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  });
  await assert.rejects(
    malformedClient.deleteContribution(contributionId),
    /invalid contribution deletion receipt/
  );
  await assert.rejects(
    malformedClient.deleteParticipant(),
    /invalid participant deletion receipt/
  );
});

test("community snapshots fail closed and never disclose threshold distance", () => {
  const published = normalizeCommunitySnapshot(communitySnapshot());
  assert.equal(published.state, "published");
  assert.equal(published.minimumIndependentParticipants, 20);
  assert.equal(published.cells[0].metrics.usageEvents.value, 30);

  const partialPayload = structuredClone(communitySnapshot());
  partialPayload.cells[0].metrics.outputReasoningTokens = { status: "suppressed" };
  assert.equal(normalizeCommunitySnapshot(partialPayload).state, "published_partial");
  delete partialPayload.cells[0].metrics.outputReasoningTokens;
  assert.equal(normalizeCommunitySnapshot(partialPayload).state, "unsupported_schema");

  const suppressedPayload = {
    ...communitySnapshot(),
    releaseStatus: "suppressed",
    reason: "minimum_cell_support_not_met",
    participantCount: 19,
    cells: []
  };
  const suppressed = normalizeCommunitySnapshot(suppressedPayload);
  assert.equal(suppressed.state, "suppressed");
  assert.equal(Object.hasOwn(suppressed, "participantCount"), false);

  assert.equal(normalizeCommunitySnapshot({
    publicationStatus: "development_diagnostic_not_publication_safe"
  }).state, "development_unsafe");
  assert.equal(normalizeCommunitySnapshot({
    ...communitySnapshot(),
    immutable: false
  }).state, "unsupported_schema");
  assert.equal(normalizeCommunitySnapshot({
    ...communitySnapshot(),
    releaseStatus: "withdrawn",
    cells: []
  }).state, "withdrawn");
  assert.equal(normalizeCommunitySnapshot({
    ...communitySnapshot(),
    releaseStatus: "not_yet_published",
    cells: []
  }).state, "not_yet_published");
});

test("participant v0.2 stats preserve server repricing, coverage states, and speed separation", () => {
  const result = normalizeParticipantStats({
    schemaVersion: PARTICIPANT_STATS_SCHEMA_VERSION,
    totals: {
      contributions: 2,
      usageEvents: 10,
      quotaSnapshots: 4,
      activityMarkers: 1,
      apiPriceEquivalentUsd: "12.345678",
      serverUnknownBillableUnits: 90,
      fullyPricedEvents: 7,
      partiallyPricedEvents: 2,
      unpricedEvents: 1,
      priceVerification: "server_repriced",
      standardApiCounterfactualUsd: "11.100000",
      standardApiCounterfactualEvents: 8
    },
    insights: [{ code: "fast_event_share", value: 0.3 }],
    rollingQuotaMovement: {
      schemaVersion: "participant-quota-movement-v0.1",
      status: "conditional_estimate",
      accountContinuity: "not_transmitted",
      apiPriceEquivalentCapacityUsd: 617.2839,
      rows: [{
        timestamp: "2026-07-25T14:00:00.000Z",
        windowStartUtc: "2026-07-25T13:00:00.000Z",
        windowEndUtc: "2026-07-25T14:00:00.000Z",
        smoothingHours: 1,
        observedQuotaChangePp: 2,
        expectedQuotaChangePp: 1.8,
        apiPriceEquivalentUsd: "11.100000",
        usageEvents: 8
      }]
    }
  });
  assert.equal(result.state, "ready");
  assert.equal(result.totals.apiPriceEquivalentUsd, 12.345678);
  assert.deepEqual(result.pricingCoverage, {
    state: "partially_priced",
    percent: 90,
    fullyPricedEvents: 7,
    partiallyPricedEvents: 2,
    unpricedEvents: 1,
    unclassifiedEvents: 0
  });
  assert.equal(result.standardApiCounterfactual.apiPriceEquivalentUsd, 11.1);
  assert.equal(result.codexFastObservations.eventShare, 0.3);
  assert.equal(result.rollingQuotaMovement.rows[0].smoothingHours, 1);
  assert.equal(result.rollingQuotaMovement.accountContinuity, "not_transmitted");
});

test("participant stats normalize private account-scoped capacity and sensitivity", () => {
  const result = normalizeParticipantStats({
    schemaVersion: PARTICIPANT_STATS_SCHEMA_VERSION,
    totals: {
      usageEvents: 20,
      quotaSnapshots: 24,
      apiPriceEquivalentUsd: "45.000000",
      priceVerification: "server_repriced",
      fullyPricedEvents: 20,
      partiallyPricedEvents: 0,
      unpricedEvents: 0
    },
    accountScopedQuotaAnalysis: {
      schemaVersion: "account-scoped-quota-analysis-v0.1",
      status: "ready",
      tracks: [{
        continuity: {
          provider: "openai_codex",
          planType: "pro",
          planVariant: "pro-20x",
          limitId: "codex",
          windowDurationMinutes: 10_080,
          policyEpoch: "openai_agentic_pool_2026_07_09"
        },
        calibration: {
          tracks: [{
            totalResetCount: 3,
            estimatedResetCount: 1,
            resets: [{
              status: "conditional_estimate",
              refusalCodes: [],
              capacityNanousd: 600_000_000_000,
              sensitivityRangeNanousd: {
                lower: 500_000_000_000,
                upper: 700_000_000_000
              },
              boundaryCount: 10,
              displayedSpanPp: 12
            }]
          }]
        },
        rolling: {
          status: "conditional_comparison",
          refusalCodes: [],
          comparisons: [{ smoothingHours: 1 }, { smoothingHours: 2 }]
        }
      }]
    }
  });
  const track = result.accountScopedQuotaAnalysis.tracks[0];
  assert.equal(result.accountScopedQuotaAnalysis.status, "ready");
  assert.equal(track.latestCapacityUsd, 600);
  assert.equal(track.sensitivityLowerUsd, 500);
  assert.equal(track.sensitivityUpperUsd, 700);
  assert.equal(track.rollingComparisonCount, 2);
});

test("private community comparison preserves own clipped versus public rounded semantics", () => {
  const metrics = Object.fromEntries([
    ["usageEvents", "events"],
    ["inputUncachedTokens", "tokens"],
    ["inputCacheReadTokens", "tokens"],
    ["inputCacheWriteTokens", "tokens"],
    ["outputTextTokens", "tokens"],
    ["outputReasoningTokens", "tokens"],
    ["outputCombinedTokens", "tokens"],
    ["toolUnits", "units"]
  ].map(([name, unit]) => [
    name,
    name === "outputReasoningTokens"
      ? { status: "community_not_released" }
      : {
          status: "comparable",
          participantClippedValue: name === "usageEvents" ? 1 : 900,
          communityRoundedValue: name === "usageEvents" ? 20 : 0,
          unit
        }
  ]));
  const normalized = normalizeParticipantCommunityComparison({
    schemaVersion: PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION,
    status: "ready",
    snapshotId: "community-weekly:2026-07-20",
    snapshotRevision: 2,
    period: {
      startAt: "2026-07-20T00:00:00.000Z",
      endAt: "2026-07-27T00:00:00.000Z"
    },
    interpretation: "own_clipped_contribution_vs_public_rounded_total",
    cells: [{
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      participantHasActivity: true,
      metrics,
      participantCount: 20,
      accountTrackId: "must-not-survive"
    }]
  });
  assert.equal(normalized.status, "ready");
  assert.equal(normalized.snapshotRevision, 2);
  assert.equal(normalized.cells[0].metrics.inputCacheReadTokens.participantClippedValue, 900);
  assert.equal(normalized.cells[0].metrics.inputCacheReadTokens.communityRoundedValue, 0);
  assert.equal(normalized.cells[0].metrics.outputReasoningTokens.status, "community_not_released");
  assert.equal(Object.hasOwn(normalized.cells[0], "participantCount"), false);
  assert.equal(Object.hasOwn(normalized.cells[0], "accountTrackId"), false);

  const malformed = structuredClone({
    schemaVersion: PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION,
    status: "ready",
    snapshotId: "community-weekly:2026-07-20",
    snapshotRevision: 2,
    period: {
      startAt: "2026-07-20T00:00:00.000Z",
      endAt: "2026-07-27T00:00:00.000Z"
    },
    interpretation: "own_clipped_contribution_vs_public_rounded_total",
    cells: [{
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      participantHasActivity: true,
      metrics
    }]
  });
  malformed.cells[0].metrics.inputCacheReadTokens.status = "comparable";
  malformed.cells[0].metrics.inputCacheReadTokens.participantClippedValue = -1;
  assert.equal(
    normalizeParticipantCommunityComparison(malformed).reason,
    "comparison_contract_invalid"
  );
  assert.equal(normalizeParticipantCommunityComparison({
    schemaVersion: PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION,
    status: "not_testable",
    reason: "community_snapshot_not_released",
    cells: []
  }).reason, "community_snapshot_not_released");
});

test("participant history keeps lifecycle and provenance bounded and private", async () => {
  const contributionId = "contribution:00000000-0000-4000-8000-000000000001";
  const profile = {
    schemaVersion: PARTICIPANT_PROFILE_SCHEMA_VERSION,
    participantId: "private-server-participant-id",
    createdAt: "2026-07-25T12:00:00.000Z",
    consentVersion: "privacy-safe-telemetry-v0.1",
    contributionCount: 1,
    contributionAdmission: {
      schemaVersion: "telemetry-contribution-admission-v0.1",
      state: "available",
      window: {
        kind: "fixed_utc",
        anchor: "monday_00_00_utc",
        startsAt: "2026-07-27T00:00:00.000Z",
        endsAt: "2026-08-03T00:00:00.000Z",
        durationMilliseconds: 604_800_000,
      },
      acceptedBatches: 37,
      remainingBatches: 63,
      maximumBatches: 100,
      slotRefundPolicy: "not_refunded_by_contribution_deletion",
    },
    historyPolicy: {
      maximumItems: 101,
      quarantineRetentionMilliseconds: 604_800_000,
      canonicalMetadataRetainedAfterQuarantine: true,
      clientSoftwareVersion: "unavailable_in_transport"
    },
    contributions: [{
      contributionId,
      status: "accepted",
      synthetic: false,
      schemaVersion: "telemetry-contribution-v0.1",
      transportSchemaVersion: "telemetry-contribution-v0.1",
      coveredAt: {
        startAt: "2026-07-25T12:00:00.000Z",
        endAt: "2026-07-25T12:30:00.000Z"
      },
      clientPlatform: "macos",
      providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
      recordCounts: { declared: 3, accepted: 2, deduplicated: 1 },
      serverAccounting: {
        apiPriceEquivalentUsd: "0.0032",
        priceBasis: "historical_api_prices",
        priceEpochBasis: "event_time_when_registry_has_effective_evidence",
        eventTimeRange: {
          startAt: "2026-07-25T12:05:00.000Z",
          endAt: "2026-07-25T12:05:00.000Z"
        },
        verification: "server_repriced",
        registrySha256: "private-projected-away"
      },
      quarantine: {
        state: "retained",
        scheduledDeletionAt: "2026-08-01T12:00:00.000Z",
        deletedAt: null,
        canonicalMetadataRetained: true
      },
      createdAt: "2026-07-25T12:00:00.000Z",
      datasetId: "private-projected-away",
      accountTrackId: "private-projected-away"
    }]
  };
  const normalized = normalizeParticipantHistory(profile);
  assert.equal(normalized.state, "ready");
  assert.equal(normalized.items[0].contributionId, contributionId);
  assert.equal(normalized.items[0].recordCounts.deduplicated, 1);
  assert.equal(normalized.items[0].serverAccounting.apiPriceEquivalentUsd, 0.0032);
  assert.equal(normalized.items[0].serverAccounting.priceBasis, "historical_api_prices");
  assert.equal(
    normalized.items[0].serverAccounting.priceEpochBasis,
    "event_time_when_registry_has_effective_evidence",
  );
  assert.deepEqual(normalized.items[0].serverAccounting.eventTimeRange, {
    startAt: "2026-07-25T12:05:00.000Z",
    endAt: "2026-07-25T12:05:00.000Z",
  });
  assert.equal(normalized.items[0].quarantine.state, "retained");
  assert.deepEqual(normalized.contributionAdmission, {
    state: "available",
    acceptedBatches: 37,
    remainingBatches: 63,
    maximumBatches: 100,
    renewsAt: "2026-08-03T00:00:00.000Z",
    slotRefundPolicy: "not_refunded_by_contribution_deletion",
  });
  assert.equal(Object.hasOwn(normalized, "participantId"), false);
  assert.equal(Object.hasOwn(normalized.items[0], "datasetId"), false);
  assert.equal(Object.hasOwn(normalized.items[0], "accountTrackId"), false);
  assert.equal(Object.hasOwn(normalized.items[0].serverAccounting, "registrySha256"), false);

  const badRetention = structuredClone(profile);
  badRetention.contributions[0].quarantine.scheduledDeletionAt =
    "2026-08-02T12:00:00.000Z";
  assert.equal(normalizeParticipantHistory(badRetention).reason, "invalid_contract");

  const badCounts = structuredClone(profile);
  badCounts.contributions[0].recordCounts.accepted = 3;
  assert.equal(normalizeParticipantHistory(badCounts).reason, "invalid_contract");

  const duplicateIds = structuredClone(profile);
  duplicateIds.contributions.push(structuredClone(profile.contributions[0]));
  duplicateIds.contributionCount = 2;
  assert.equal(normalizeParticipantHistory(duplicateIds).reason, "invalid_contract");

  const wrongStatus = structuredClone(profile);
  wrongStatus.contributions[0].status = "accepted_synthetic";
  assert.equal(normalizeParticipantHistory(wrongStatus).reason, "invalid_contract");

  const impossibleDeletion = structuredClone(profile);
  impossibleDeletion.contributions[0].quarantine = {
    state: "deleted",
    scheduledDeletionAt: "2026-08-01T12:00:00.000Z",
    deletedAt: "2026-07-25T11:59:59.000Z",
    canonicalMetadataRetained: true
  };
  assert.equal(normalizeParticipantHistory(impossibleDeletion).reason, "invalid_contract");

  const oversized = structuredClone(profile);
  oversized.contributions = Array.from({ length: 102 }, () => profile.contributions[0]);
  oversized.contributionCount = 102;
  assert.equal(normalizeParticipantHistory(oversized).reason, "invalid_contract");

  const invalidAdmission = structuredClone(profile);
  invalidAdmission.contributionAdmission.remainingBatches = 64;
  assert.equal(
    normalizeParticipantHistory(invalidAdmission).reason,
    "invalid_contract",
  );

  const legacyWithoutAdmission = structuredClone(profile);
  delete legacyWithoutAdmission.contributionAdmission;
  assert.equal(
    normalizeParticipantHistory(legacyWithoutAdmission)
      .contributionAdmission.state,
    "unknown",
  );

  const calls = [];
  const client = new CommunityClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(profile), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await client.participantProfile();
  assert.deepEqual(calls, [{
    url: "/api/v1/me",
    options: {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    }
  }]);
  assert.throws(
    () => client.deleteContribution("not-a-contribution"),
    /valid contribution/
  );
});

test("participant results fail closed for unverifiable prices and honest not-testable movement", () => {
  const result = normalizeParticipantStats({
    schemaVersion: PARTICIPANT_STATS_SCHEMA_VERSION,
    totals: {
      usageEvents: 0,
      apiPriceEquivalentUsd: "999.000000",
      priceVerification: "client_declared_unverified",
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0
    },
    rollingQuotaMovement: {
      status: "not_testable",
      reason: "no_observed_quota_movement",
      rows: [],
      accountContinuity: "not_transmitted"
    }
  });
  assert.equal(result.totals.apiPriceEquivalentUsd, null);
  assert.equal(result.pricingCoverage.state, "not_testable");
  assert.equal(result.standardApiCounterfactual.state, "not_separately_returned");
  assert.equal(result.codexFastObservations.state, "not_testable");
  assert.equal(result.rollingQuotaMovement.status, "not_testable");
  assert.equal(result.rollingQuotaMovement.reason, "no_observed_quota_movement");
  assert.equal(normalizeParticipantStats({ schemaVersion: "participant-stats-v0.1" }).state, "unsupported_schema");
});

test("public interface is dashboard-first and never substitutes demo data automatically", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const label of [
    "Overview",
    "Trends",
    "Weekly",
    "Community",
    "Data &amp; privacy",
    "How the estimate was calculated",
    "When to treat this as an estimate",
    "Your contribution receipt",
    "Community backend readiness"
  ]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /id="usage-timeline-chart"/);
  assert.match(html, /id="timeline-chart"/);
  assert.match(html, /id="weekly-chart"/);
  assert.match(html, /id="accounting"/);
  assert.match(html, /id="accounting-component-counts"/);
  assert.match(html, /id="accounting-component-costs"/);
  assert.match(html, /Cost contribution/);
  assert.match(html, /id="accounting-models"/);
  assert.match(html, /class="panel accounting-models-panel"/);
  assert.match(appSource, /function renderAccountingComponentBars/);
  assert.match(html, /Usage increments/);
  assert.match(html, /API pricing is a measuring stick, not your bill/);
  // The dashboard does not ask the user to supply a speed assumption; only
  // recorded log evidence is shown in the primary experience.
  assert.doesNotMatch(html, /id="fast-mode-preference-controls"/);
  assert.doesNotMatch(html, /data-fast-mode="mixed_unknown"/);
  assert.match(html, /Quota-weighted API-price equivalent/);
  assert.match(html, /id="community"/);
  assert.match(html, /id="history"/);
  assert.match(html, /Your contribution receipt/);
  assert.match(html, /Exact metadata categories a contribution may contain/);
  assert.match(html, /id="contribution-file"/);
  assert.match(html, /id="selected-contribution-inspection"/);
  assert.match(html, /Exact retained fields and values/);
  assert.match(html, /Review every validated field and value/);
  assert.match(html, /id="index-progress"/);
  assert.match(html, /id="setup-card"/);
  assert.match(html, /Check this Mac before analyzing/);
  assert.match(html, /A useful headline often appears in seconds/);
  assert.match(html, /The first deep pass can\s+take a few minutes/);
  assert.match(html, /id="setup-refresh"/);
  assert.match(html, /id="prepare-contribution"/);
  assert.match(html, /id="preparation-identity"/);
  assert.match(html, /id="sync-exact-review"/);
  assert.match(html, /Review exact content-free metadata JSON/);
  assert.match(html, /Send reviewed upload/);
  assert.match(html, /can claim only the\s+exact reviewed queue job/);
  assert.match(html, /Raw log contents and source paths never enter this page/);
  assert.match(html, /id="central-state"/);
  assert.match(html, /id="backend"/);
  assert.match(html, /id="backend-state"/);
  assert.match(html, /id="backend-deletion-ledger"/);
  assert.match(html, /id="backend-lifecycle"/);
  assert.match(html, /id="backend-reconciliation"/);
  assert.match(html, /id="backend-aggregate-rebuild"/);
  assert.match(html, /id="backend-collection-state"/);
  assert.match(html, /id="backend-upload-registration"/);
  assert.match(html, /id="backend-processing"/);
  assert.match(html, /id="backend-publication"/);
  assert.match(html, /id="backend-participant-rights"/);
  assert.match(html, /Community backend readiness and data lifecycle/);
  assert.match(html, /fresh retention and restore replay/);
  assert.match(html, /Transactional ingest/);
  assert.doesNotMatch(html, /id="download-participant"/);
  assert.doesNotMatch(html, /id="recover-form"/);
  assert.doesNotMatch(html, /id="security-reset"/);
  assert.doesNotMatch(html, /id="create-device-pairing"/);
  assert.doesNotMatch(html, /id="device-list"/);
  assert.doesNotMatch(html, /id="logout-participant"/);
  assert.match(html, /id="delete-participant"/);
  assert.match(html, /id="contribution-history"/);
  assert.match(html, /privacy-safe TiboTattle export/);
  assert.match(appSource, /demo-button.*addEventListener/s);
  assert.match(appSource, /companionReachable \? "Ready to analyze"/);
  assert.match(appSource, /Continue your local analysis/);
  assert.match(appSource, /ready: "Retention and restore replay current"/);
  assert.match(appSource, /contributionSyncExactReview/);
  assert.match(appSource, /Open Keychain Access, select the login Keychain, unlock it/);
  assert.match(
    appSource,
    /Review the concise coverage and record totals above\. Expand the exact JSON if wanted/,
  );
  assert.match(
    appSource,
    /Your hosted content-free pseudonymous metadata was deleted/,
  );
  assert.match(appSource, /This address is the backend-only service/);
  assert.match(
    appSource,
    /Open TiboTattle from Applications and use its in-app window/,
  );
  assert.match(html, /your dashboard in its own TiboTattle in-app window/u);
  assert.match(html, /Use the TiboTattle in-app window/u);
  assert.doesNotMatch(appSource, /dashboard tab|local tab|separate local dashboard/u);
  assert.doesNotMatch(html, /dashboard tab|local tab|separate local dashboard/u);
  const loadBody = appSource.match(/async function loadLocalDashboard\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.doesNotMatch(loadBody, /demoDashboard/);
});

test("first run is a truthful install and local preflight journey", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(html, /<body class="first-run">/u);
  assert.match(
    html,
    /<meta name="usage-monitor-installer-url" content="">/u,
  );
  assert.match(
    html,
    /<meta name="usage-monitor-installer-version" content="">/u,
  );
  assert.match(
    html,
    /<meta name="usage-monitor-installer-sha256" content="">/u,
  );
  assert.match(
    html,
    new RegExp(
      `<meta name="usage-monitor-semantic-open-target" content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}">`,
      "u",
    ),
  );
  for (const name of [
    "usage-monitor-installer-bytes",
    "usage-monitor-minimum-macos",
    "usage-monitor-architectures",
    "usage-monitor-release-notes-url",
    "usage-monitor-privacy-url",
    "usage-monitor-security-url",
    "usage-monitor-support-url",
  ]) {
    assert.match(
      html,
      new RegExp(`<meta name="${name}" content="">`, "u"),
    );
  }
  assert.match(html, /<link rel="canonical" href="">/u);
  assert.match(html, /property="og:image" content=""/u);
  assert.match(html, /property="og:image:width" content="1200"/u);
  assert.match(html, /property="og:image:height" content="630"/u);
  assert.match(html, /name="twitter:card" content="summary_large_image"/u);
  assert.match(html, /name="twitter:image" content=""/u);
  assert.match(html, /id="installer-link"[^>]*hidden/u);
  assert.match(html, /id="open-installed-app" href=""/u);
  assert.match(html, /id="installer-details"[^>]*hidden/u);
  assert.match(html, /A public installer is not configured for this build/u);
  assert.match(html, /A normal website cannot read Codex files/u);
  assert.match(html, /Your real usage appears only on that loopback page/u);
  assert.match(html, /You may close this hosted browser tab at any time/u);
  assert.match(html, /A useful headline often appears in seconds/u);
  assert.match(html, /first deep pass can\s+take a few minutes/u);
  assert.match(html, /later updates are normally faster/u);
  assert.match(html, /id="release-notes-link"/u);
  assert.match(html, /id="privacy-link"/u);
  assert.match(html, /id="security-link"/u);
  assert.match(html, /id="support-link"/u);
  assert.match(html, /id="companion-check"/u);
  assert.match(html, /id="setup-check-again"/u);
  assert.match(html, /id="refresh-button"[^>]*disabled/u);
  assert.match(html, /data-requires-evidence/u);
  assert.match(html, /id="community-contribution-disclosure"/u);
  assert.match(html, /Closed until you choose it/u);

  // The install call to action is one shared module used by both browser
  // entry points, so these guarantees are asserted where they now live.
  const installSource = await readFile(
    new URL("../public/install-cta.js", import.meta.url),
    "utf8",
  );
  assert.match(installSource, /function configuredInstallerUrl\(documentRef\)/u);
  assert.match(installSource, /function configuredInstallerMetadata\(/u);
  assert.match(
    installSource,
    /export function configuredInstallerRelease\(documentRef\)/u,
  );
  assert.match(
    installSource,
    /export function configuredSemanticOpenTarget\(documentRef\)/u,
  );
  assert.match(appSource, /from "\.\/install-cta\.js"/u);
  assert.match(appSource, /const SEMANTIC_OPEN_TARGET = configuredSemanticOpenTarget\(document\);/u);
  assert.match(appSource, /installedAppLink\.href = SEMANTIC_OPEN_TARGET/u);
  assert.doesNotMatch(appSource, /usagemonitor:\/\/open/u);
  assert.match(installSource, /SHA-256 \$\{release\.sha256\}/u);
  assert.match(installSource, /Requires macOS \$\{release\.minimumMacos\} or later/u);
  assert.match(installSource, /selected\.protocol === "https:"/u);
  assert.doesNotMatch(appSource, /loopbackHttp/u);
  assert.match(appSource, /function openInstalledApp\(\)/u);
  assert.match(appSource, /function localAnalysisAllowed\(/u);
  assert.match(appSource, /if \(!localAnalysisAllowed\(\)\) \{/u);
  for (const status of [
    "codex_home_missing",
    "codex_home_unreadable",
    "session_directories_missing",
    "session_directories_unreadable",
    "no_rollout_files",
  ]) {
    assert.match(appSource, new RegExp(`${status}:`));
  }
  assert.match(appSource, /System Settings → Privacy & Security → Files and Folders/u);
  assert.match(appSource, /customCodexHomeConfigured/u);
  assert.match(appSource, /rolloutFilesObservedCapped/u);
  assert.match(appSource, /setup-check-again.*checkLocalSetup/su);
  assert.match(appSource, /setJourneyState\(ready \? "local-ready" : "needs-local-setup"\)/u);
  assert.match(appSource, /setup: "Set up this Mac"/u);
  assert.match(appSource, /if \(!ready\) setGlobalState\("setup"/u);
  assert.doesNotMatch(appSource, /product laboratory/u);
  assert.match(styles, /body\.first-run \[data-requires-evidence\]/u);
  assert.match(styles, /body\.needs-local-setup \.journey-progressive/u);
  assert.match(styles, /\.state-setup/u);
});

test("local analysis exposes quick results and cancel-safe progress", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(html, /id="cancel-refresh"[^>]*hidden/u);
  assert.match(appSource, /localClient\.cancelRefresh\(\)/u);
  assert.match(appSource, /\["running", "cancelling"\]\.includes\(outcome\)/u);
  assert.match(appSource, /phase === "quick_result"/u);
  assert.match(appSource, /await loadQuickResultDashboard\(\)/u);
  assert.match(appSource, /renderDashboard\(data\)/u);
  assert.match(appSource, /Headline results are ready/u);
  assert.match(appSource, /finishing deeper accounting/u);
  assert.match(appSource, /Local analysis cancelled/u);
  assert.match(appSource, /Verified existing results were kept/u);
  assert.match(appSource, /preserving a resumable local checkpoint/u);
  assert.match(appSource, /refresh_resource_limited/u);
  assert.match(appSource, /This scan paused to protect your Mac/u);
  assert.match(appSource, /No partial result replaced your existing results/u);
  assert.match(appSource, /Deep analysis paused after two bounded continuations/u);
});

test("timeline keeps time, uncertainty, and primary navigation explicit", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  for (const id of [
    "timeline-zoom-in",
    "timeline-zoom-out",
    "timeline-pan-back",
    "timeline-pan-forward",
    "timeline-reset-zoom",
    "timeline-confidence",
    "timeline-zoom-status",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data-nav="community"/);
  assert.match(html, /data-nav="data"/);
  assert.match(html, /Exact local \/ UTC time/);
  assert.match(html, /Missing quota bracket/);
  assert.match(appSource, /function selectedTimelinePoints/);
  assert.match(appSource, /function timelineStatusIntervals/);
  assert.match(appSource, /function bindTimelineInteractions/);
  assert.match(appSource, /event\.key === "ArrowLeft"/);
  assert.match(appSource, /event\.key === "Home"/);
  assert.match(appSource, /statusIntervals/);
  assert.match(appSource, /visibleBounds = timelineBounds\(points\)/);
  assert.match(appSource, /visibleArtifactResiduals\.length[\s\S]*pointResiduals/);
  assert.match(appSource, /renderResiduals\(data, visiblePoints, viewport\)/);
  assert.match(appSource, /safeDomainEndMs - domainStartMs/);
  assert.match(appSource, /USER_TIME_ZONE/);
  assert.match(appSource, /LOCAL_CALENDAR_PARTS/);
  assert.match(appSource, /periodEndAt/);
  assert.match(appSource, /point\.periodEndAt \?\? point\.timestamp/);
  assert.match(appSource, /Unrecognized \/ unpriced overflow/);
  assert.match(appSource, /component\.unpricedTokens/);
  assert.match(appSource, /timelineStatusLabel/);
  assert.match(appSource, /recent_7d_partial/);
  assert.match(appSource, /cannot prove it reached the entire requested seven-day window/);
  assert.match(appSource, /Local-only mode/);
  assert.match(appSource, /centralServiceProxy/);
  assert.match(appSource, /Calculating usage and allowance/);
  assert.match(html, /id="calibration-range-controls"/);
  assert.match(html, /id="weekly-range-controls"/);
  assert.match(html, /id="weekly-partial-legend"/);
  assert.match(html, /id="contribution-lookback-controls"/);
  assert.match(html, /Prepare and review last 24 hours/);
  assert.ok(
    html.indexOf('id="range-controls"') < html.indexOf("advanced-calibration"),
    "usage range controls stay with the headline usage chart",
  );
  assert.ok(
    html.indexOf('id="window-controls"') > html.indexOf("advanced-calibration"),
    "rolling window controls stay inside advanced calibration",
  );
  assert.match(appSource, /row\?\.last_observed_at \?\? row\?\.first_observed_at/);
  assert.match(appSource, /label: "Short observation"/);
  assert.match(appSource, /lookbackHours: activeContributionLookbackHours/);
  assert.match(styles, /interactive-chart/);
  assert.match(styles, /chart-status-missing/);
  assert.match(styles, /touch-action: pan-y/);
  // Narrow screens shed compact buttons only from the crowded top toolbar, so
  // chart navigation — and every other compact control, including the one that
  // turns automatic contribution off — stays reachable without needing its own
  // exception rule.
  assert.match(styles, /\.topbar \.button\.compact \{ display: none; \}/);
  assert.doesNotMatch(styles, /^\s*\.button\.compact \{ display: none; \}/mu);
  assert.match(styles, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(styles, /min-height: 48px/);
  assert.match(styles, /\.primary-nav \{[\s\S]*overflow-x: auto;/);
});

test("default calibration view explains the fitted rate and uncertainty plainly", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const id of [
    "calibration-rate",
    "calibration-range",
    "calibration-example",
    "calibration-explanation",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(appSource, /function renderCalibrationRate/);
  assert.match(appSource, /API equivalent per 1 percentage point/);
  assert.match(appSource, /not an 80% probability/);
  assert.match(appSource, /not a provider-published dollar cap/);
});

test("weekly view keeps the default surface to the estimate and its reset history", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="weekly-trend"/);
  assert.doesNotMatch(html, /id="weekly-stats"/);
  assert.match(html, /<summary>See individual measurements<\/summary>/);
  assert.doesNotMatch(appSource, /function renderWeeklyTrend/);
  assert.doesNotMatch(appSource, /function renderWeeklyStats/);
});

test("weekly view states the exact price epoch and whether the July repricing is included", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(html, /id="weekly-pricing-receipt"/u);
  assert.match(html, /Price basis for the visible fits/u);
  assert.match(appSource, /function renderWeeklyPricingReceipt/u);
  assert.match(appSource, /event_time_when_registry_has_effective_evidence/u);
  assert.match(appSource, /Historical event-time prices used for each fit/u);
  assert.match(appSource, /mixed official card windows/u);
  assert.match(appSource, /lower official GPT-5\.6 Terra\/Luna cards effective July 30 are being used/u);
  assert.match(appSource, /earlier events keep their earlier cards/u);
  assert.doesNotMatch(appSource, /Current official prices are applied to every fit/u);
  assert.match(appSource, /renderWeeklyPricingReceipt\(data\);/u);
  assert.match(styles, /\.weekly-pricing-receipt/u);
});

test("weekly keeps every fit visible and marks short observations separately", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="weekly-evidence-controls"/u);
  assert.match(appSource, /const history = allowanceHistoryChartModel\(data\);/u);
  assert.match(appSource, /const chartValues = history\.points;/u);
  assert.match(
    appSource,
    /wellObserved: isWellObservedWeeklyFit\(observedSpanPp\),/u,
  );
  assert.match(
    appSource,
    /markerRadius: \(point\) => point\.wellObserved \? 4 : 0,/u,
  );
  assert.match(
    appSource,
    /markerRadius: \(point\) => point\.wellObserved \? 0 : 4,/u,
  );
  assert.match(appSource, /weekly-partial-legend"\)\.hidden = !chartValues\.some/u);
  assert.doesNotMatch(appSource, /showWeeklyPartialDiagnostics/u);
});

test("the weekly evidence boundary is fixed and cannot create an empty slider state", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /const WEEKLY_WELL_OBSERVED_SPAN_PP = 50;/u);
  const thresholdMatch = appSource.match(
    /function isWellObservedWeeklyFit\(observedSpanPp\) \{([\s\S]*?)\n\}/u,
  );
  assert.ok(thresholdMatch, "isWellObservedWeeklyFit is available for contract review");
  assert.match(
    thresholdMatch[1],
    /return observedSpanPp !== null && observedSpanPp >= WEEKLY_WELL_OBSERVED_SPAN_PP;/u,
  );
  assert.doesNotMatch(html, /weekly-span-threshold|weekly-evidence-controls/u);
  assert.doesNotMatch(appSource, /weeklySpanThresholdPp|Math\.min\(99, threshold\)/u);
});

test("weekly points carry measured ranges without mouse-only detail popovers", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(
    appSource,
    /errorBars: \{\s*low: "low",\s*high: "high",\s*className: "chart-error-bar-weekly",\s*label: "Measured range",\s*tooltip: false,/u,
  );
  assert.match(
    appSource,
    /confidence: \{ low: "acrossResetLow", high: "acrossResetHigh" \}/u,
  );
  assert.match(
    appSource,
    /if \(errorBars\) values\.push\([\s\S]*?errorBars\.low[\s\S]*?errorBars\.high/u,
  );
  const weeklyChart = appSource.match(
    /function renderAllowanceHistoryChart\(history\) \{([\s\S]*?)\n\}/u,
  )?.[1] ?? "";
  assert.match(weeklyChart, /tooltip: false,/u);
  assert.doesNotMatch(weeklyChart, /focusable: true|weeklyPointDetail|markerOpacity/u);
  assert.match(appSource, /if \(item\.tooltip !== false \|\| item\.focusable === true\)/u);
  assert.match(appSource, /if \(errorBars\.tooltip !== false\)/u);
  assert.match(styles, /\.chart-error-bar-weekly \.chart-error-bar-line/u);
  assert.match(html, /vertical bar shows the range supported/u);
  assert.doesNotMatch(html, /Per-week within-reset sensitivity|Scroll horizontally on a narrow screen/u);
});

test("metric information controls open an accessible popover instead of relying on title hover", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(appSource, /function openInformationPopover\(button\)/u);
  assert.match(appSource, /popover\.setAttribute\("role", "tooltip"\)/u);
  assert.match(appSource, /button\.setAttribute\("aria-expanded", "true"\)/u);
  assert.match(appSource, /button\.setAttribute\("aria-describedby", id\)/u);
  assert.match(appSource, /button\.addEventListener\("click", \(event\) => \{/u);
  assert.match(appSource, /document\.addEventListener\("keydown", \(event\) => \{/u);
  assert.match(appSource, /event\.key !== "Escape"/u);
  assert.match(appSource, /document\.addEventListener\("click", \(event\) => \{/u);
  assert.doesNotMatch(appSource, /button\.title = explanation/u);
  assert.match(styles, /\.info-popover \{/u);
  assert.match(styles, /\.info-button\[aria-expanded="true"\]/u);
});

test("calibration zoom moves in bounded granular steps on every input device", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(appSource, /const TIMELINE_WHEEL_ZOOM_STEP = 1\.12;/u);
  assert.match(appSource, /const TIMELINE_BUTTON_ZOOM_STEP = 1\.25;/u);
  assert.match(appSource, /const TIMELINE_MAXIMUM_ZOOM_STEP = 1\.25;/u);
  assert.match(appSource, /const TIMELINE_MINIMUM_SPAN_MS = 15 \* 60_000;/u);
  // A trackpad emits many small deltas per gesture, so the step is scaled by
  // the fraction of a mouse notch each event actually reports.
  const wheelMatch = appSource.match(
    /function wheelZoomFactor\(event\) \{([\s\S]*?)\n\}/u,
  );
  assert.ok(wheelMatch, "wheelZoomFactor is available for contract review");
  assert.match(
    wheelMatch[1],
    /TIMELINE_WHEEL_ZOOM_STEP \*\* \(pixels \/ TIMELINE_WHEEL_NOTCH_PIXELS\)/u,
  );
  assert.match(wheelMatch[1], /event\.deltaMode === 1/u);
  assert.match(wheelMatch[1], /event\.deltaMode === 2/u);
  // No single event may outrun one button press, and no zoom may pass the
  // minimum useful span or the full extent of the loaded evidence.
  const zoomMatch = appSource.match(
    /function zoomTimeline\(points, factor, anchorRatio = \.5\) \{([\s\S]*?)\n\}/u,
  );
  assert.ok(zoomMatch, "zoomTimeline is available for contract review");
  assert.match(
    zoomMatch[1],
    /Math\.max\(\s*1 \/ TIMELINE_MAXIMUM_ZOOM_STEP,\s*Math\.min\(TIMELINE_MAXIMUM_ZOOM_STEP, factor\),\s*\)/u,
  );
  assert.match(
    zoomMatch[1],
    /Math\.min\(\s*bounds\.endMs - bounds\.startMs,\s*Math\.max\(minimumTimelineSpanMs\(bounds\), span \* step\),\s*\)/u,
  );
  assert.match(appSource, /zoomTimeline\(points, wheelZoomFactor\(event\), ratio\);/u);
  assert.match(appSource, /zoomTimeline\(points, 1 \/ TIMELINE_BUTTON_ZOOM_STEP\)/u);
  assert.match(appSource, /zoomTimeline\(points, TIMELINE_BUTTON_ZOOM_STEP\)/u);
  assert.doesNotMatch(appSource, /zoomTimeline\([^)]*1\.35|zoomTimeline\([^)]*\.74/u);
  // The zoom level itself has to be readable without seeing the chart.
  assert.match(
    appSource,
    /a span of \$\{formatSpanLength\(viewport\.endMs - viewport\.startMs\)\}/u,
  );
});

test("residuals span the calibration range and show uncomputable windows as gaps", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  // Rows with no computable residual are kept, so a shorter run of computable
  // residuals can never silently shorten the axis.
  const rowsMatch = appSource.match(
    /function residualRows\(data, points\) \{([\s\S]*?)\n\}/u,
  );
  assert.ok(rowsMatch, "residualRows is available for contract review");
  assert.doesNotMatch(rowsMatch[1], /return row\.residual !== null/u);
  assert.match(appSource, /const domain = viewport \?\? timelineBounds\(points\);/u);
  assert.match(appSource, /xDomain: domain,/u);
  assert.match(
    appSource,
    /statusIntervals: domain === null\s*\?\s*\[\]\s*: timelineStatusIntervals\(residuals, domain\),/u,
  );
  assert.match(
    appSource,
    /const computed = residuals\.filter\(\(row\) => row\.residual !== null\);/u,
  );
  assert.match(appSource, /function residualGapReasons/u);
  assert.match(appSource, /never as zero/u);
  assert.match(html, /id="residual-coverage"/u);
  assert.match(html, /windows that cannot be differenced are shaded gaps, never zeros/u);
});

test("the weekly allowance chart leads the dashboard", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.ok(
    html.indexOf('id="weekly"') < html.indexOf('id="timeline"'),
    "the weekly allowance section precedes the timeline section",
  );
  assert.ok(
    html.indexOf('data-nav="weekly"') < html.indexOf('data-nav="trends"'),
    "primary navigation follows the same order as the sections",
  );
  assert.match(html, /<p class="eyebrow">02 · Weekly allowance<\/p>/u);
  assert.match(html, /<p class="eyebrow">03 · Timeline<\/p>/u);
  assert.match(html, /class="dashboard-section lead-section" id="weekly"/u);
  assert.match(html, /class="panel weekly-history-panel lead-chart-panel"/u);
  // The lead chart must use the available page width instead of introducing a
  // second horizontal scrollbar for a handful of reset estimates.
  assert.match(styles, /\.weekly-history-chart \{ overflow: visible; \}/u);
  assert.match(styles, /\.weekly-history-chart svg \{ min-width: 0; height: clamp\(300px, 34vw, 420px\); \}/u);
  assert.match(styles, /\.lead-chart-panel \.weekly-history-chart svg \{ height: clamp\(320px, 38vw, 460px\); \}/u);
});

test("estimate caveats show only the few gaps that materially change the result", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  // The default view is a short list of gaps that change how the number reads.
  assert.match(appSource, /const MATERIAL_GAP_LIMIT = 2;/u);
  assert.match(appSource, /const MATERIAL_GAP_STATUSES = Object\.freeze\(\[/u);
  assert.match(appSource, /\.slice\(MATERIAL_GAP_LIMIT\)|\.slice\(0, MATERIAL_GAP_LIMIT\)/u);
  assert.match(appSource, /function briefGapExplanation/u);
  assert.doesNotMatch(appSource, /\.slice\(0, 18\)/u);
  // Technical inventories no longer crowd the reader's main journey.
  assert.doesNotMatch(html, /id="blind-spot-inventory"/u);
  assert.doesNotMatch(html, /Full inventory and per-signal coverage/u);
  assert.doesNotMatch(html, /id="blind-spot-count"/u);
  assert.doesNotMatch(html, /Archived technical reports/u);
  assert.doesNotMatch(html, /id="fast-mode-preference-controls"/u);
});

test("weekly details keep reset evidence concise and do not present speed coverage as known", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const tableMatch = appSource.match(
    /function renderWeeklyTable\(values\) \{([\s\S]*?)\n\}/u,
  );
  assert.ok(tableMatch, "renderWeeklyTable source is available for contract review");
  const tableSource = tableMatch[1];

  assert.match(html, /<summary>See individual measurements<\/summary>/u);
  assert.match(html, /<th scope="col">Observed<\/th>[\s\S]*?<th scope="col">Observed span<\/th>[\s\S]*?<th scope="col">Estimate<\/th>[\s\S]*?<th scope="col">Measured range<\/th>[\s\S]*?<th scope="col">Status<\/th>/u);
  assert.doesNotMatch(html, /Evidence available \/ reset due|Speed known|Known speed coverage/u);
  assert.doesNotMatch(tableSource, /resetDueAt|speedCoverage|known_speed_fraction/u);
  assert.match(tableSource, /Well observed/u);
  assert.match(tableSource, /Short observation/u);
  assert.match(appSource, /function isWellObservedWeeklyFit\(observedSpanPp\)/u);
  assert.doesNotMatch(appSource, /function renderWeeklyTrend|function renderWeeklyStats/u);
});

test("live timeline uses the primary Codex weekly track and live weekly median first", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const trackMatch = appSource.match(
    /function mainWeeklyQuotaTrack\(rows\) \{([\s\S]*?)\n\}\n\nfunction liveTimelinePoints/u,
  );
  assert.ok(trackMatch, "mainWeeklyQuotaTrack source is available for contract review");
  const trackSource = trackMatch[1];
  assert.match(
    trackSource,
    /rows\.filter\(isPrimaryCodexWeeklyQuotaWindow\)/u,
  );
  assert.doesNotMatch(trackSource, /row\.limitId|row\.durationMinutes/u);
  assert.match(trackSource, /row\.slot === "primary"/u);
  assert.match(trackSource, /if \(primary\.length\) return primary;/u);

  const liveMatch = appSource.match(
    /function liveTimelinePoints\([\s\S]*?\) \{([\s\S]*?)\n\}\n\nfunction groupedUsageTimeline/u,
  );
  assert.ok(liveMatch, "liveTimelinePoints source is available for contract review");
  const liveSource = liveMatch[1];
  assert.match(
    liveSource,
    /data\.weekly\.summary\?\.median_weekly_value_usd[\s\S]*?\?\? data\.gradient\.summary\?\.capacity_usd/u,
  );
  assert.match(liveSource, /const quota = mainWeeklyQuotaTrack\(data\.timeline\.quota\);/u);
  assert.doesNotMatch(liveSource, /weeklyQuota|: data\.timeline\.quota/u);

  const usageMatch = appSource.match(
    /function usagePointsWithAllowance\(data, points\) \{([\s\S]*?)\n\}\n\nfunction renderUsageTimeline/u,
  );
  assert.ok(usageMatch, "usage allowance source is available for contract review");
  const usageSource = usageMatch[1];
  assert.match(usageSource, /const quota = mainWeeklyQuotaTrack\(data\.timeline\.quota\);/u);
  assert.doesNotMatch(usageSource, /fallback|data\.timeline\.quota\.filter/u);

  const quotaCardsMatch = appSource.match(
    /function renderQuotaCards\(data\) \{([\s\S]*?)\n\}\n\nfunction renderPricing/u,
  );
  assert.ok(quotaCardsMatch, "quota-card source is available for contract review");
  assert.match(
    quotaCardsMatch[1],
    /data\.quotaWindows\.filter\(isPrimaryCodexQuotaWindow\)/u,
  );
});

test("local-only UI says the optional community service is not connected", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(
    appSource,
    /Local preparation available; community service not connected/u,
  );
  // The invitation field carried a fourth local-only sentence. That field is
  // gone with open enrollment, and the three statements below still say the
  // same thing in the places a reader actually looks.
  assert.match(
    appSource,
    /Community upload and aggregate comparisons appear only in a build with an explicit community-service origin\./u,
  );
  // Readiness mechanics belong in the collapsed service-detail disclosure, so
  // the default panel copy stays about what this means for the reader.
  assert.match(
    appSource,
    /\$\("#backend-readiness-note"\)\.textContent =\s*\n\s*"This build has no community-service origin sealed into it/u,
  );
  assert.match(
    appSource,
    /Your local reporting works whether or not it is reachable, and nothing leaves this Mac unless you choose to contribute\./u,
  );
  assert.match(appSource, /document\.createTextNode\("Local-only mode"\)/u);
  assert.match(
    appSource,
    /No community origin is sealed into this app\. Nothing is failing and no upload is attempted\./u,
  );
});

test("local contribution preparation exposes fixed lookbacks and fails dense weeks closed", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const hours of [1, 24, 168]) {
    assert.match(html, new RegExp(`data-lookback-hours="${hours}"`));
  }
  const defaultControl =
    html.match(/<button[^>]*data-lookback-hours="24"[^>]*>/u)?.[0] ?? "";
  assert.match(defaultControl, /\bactive\b/u);
  assert.match(defaultControl, /aria-pressed="true"/u);
  assert.match(appSource, /let activeContributionLookbackHours = 24;/u);
  assert.match(
    appSource,
    /No network upload is performed\./u,
  );
  assert.match(
    appSource,
    /Seven days exceeded the current single reviewed-set safety cap\. Try 24 hours; on a very active history, use 1 hour\. Nothing was truncated or uploaded\./u,
  );
});

test("return visits schedule one bounded checkpoint refresh after cached results render", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /function scheduleReturningUserRefresh\(\)/u);
  assert.match(appSource, /if \(runsInsideNativeDashboard\(\)\) return;/u);
  assert.match(appSource, /document\.documentElement\.classList\.contains\("native-dashboard"\)/u);
  assert.match(appSource, /returnRefreshDeferrals < 20/u);
  assert.match(appSource, /Cached results are ready/u);
  assert.match(appSource, /checking for new local evidence from the last verified checkpoint/u);
  assert.match(appSource, /await loadCommunityResults\(\);\s*scheduleReturningUserRefresh\(\);/su);
});

test("new enrollment pairs immediately and intentionally discards recovery capability", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="copy-recovery"/u);
  assert.doesNotMatch(html, /id="acknowledge-recovery"/u);
  assert.doesNotMatch(html, /id="recover-form"/u);
  const enrollmentBody = appSource.match(
    /async function connectCommunityContribution\(\) \{([\s\S]*?)\n\}/u,
  )?.[1] ?? "";
  assert.match(enrollmentBody, /void enrollment\.recoveryCode;/u);
  assert.match(enrollmentBody, /pairing = enrollment\.pairing;/u);
  assert.match(enrollmentBody, /await finishCommunityDevicePairing\(pairing, status\);/u);
  assert.doesNotMatch(appSource, /pendingCommunityPairing/u);
  assert.doesNotMatch(appSource, /acknowledgeRecoveryAndConnect/u);
  assert.doesNotMatch(appSource, /showRecoveryCodeOnce/u);
});

test("contribution preflight explains estimated work and blocks over 100 batches", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /id="preparation-estimate"/u);
  assert.match(appSource, /function contributionPreparationEstimate\(/u);
  assert.match(appSource, /maximumSerializedBytes: batches \* 1_310_720/u);
  assert.match(appSource, /participantContributionAdmission/u);
  assert.match(appSource, /remainingBatches/u);
  assert.match(appSource, /renewsAt/u);
  assert.match(appSource, /contributionBatchAdmission\(/u);
  assert.match(appSource, /tooLarge: batchAdmission\.blocked/u);
  assert.match(appSource, /above this participant’s/u);
  assert.match(appSource, /Community batch allowance is unknown/u);
  assert.match(appSource, /no wall-clock ETA is inferred/u);
  assert.match(appSource, /No preparation or upload started/u);
});

test("primary contribution journey connects the Mac for one reviewed send without exposing a pairing code", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const id of [
    "community-connect-consent",
    "connect-community",
    "community-connect-status",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /Share one anonymous summary/u);
  assert.match(html, /reviewed, content-free result/u);
  assert.match(html, /I consent to review and submit this metadata/u);
  assert.match(html, /Review contribution/u);
  const consentTag =
    html.match(/<input id="community-connect-consent"[^>]*>/u)?.[0] ?? "";
  assert.doesNotMatch(consentTag, /\bchecked\b/u);
  assert.doesNotMatch(html, /every 6 hours while the app is open/u);
  assert.match(appSource, /async function connectCommunityContribution\(\)/u);
  assert.match(
    appSource,
    /let enrollmentAttemptedWithHostedIdentity = false;\s*\n\s*let enrollmentEstablished = false;/u,
  );
  assert.match(
    appSource,
    /\{ deviceBootstrap: true, identity: hostedIdentity \}/u,
  );
  assert.match(
    appSource,
    /enrollmentAttemptedWithHostedIdentity = hostedIdentity !== null;\s*\n\s*const enrollment = await communityClient\.enroll/u,
  );
  assert.match(
    appSource,
    /setCommunitySession\(\{[\s\S]*?\}\);\s*\n\s*enrollmentEstablished = true;/u,
  );
  assert.match(appSource, /localClient\.pairContributionDevice\(pairing\.pairingCode\)/u);
  assert.match(appSource, /void enrollment\.recoveryCode;/u);
  assert.doesNotMatch(appSource, /armAutomaticContributionAfterReviewedSend/u);
  assert.match(appSource, /inspectNextContribution/u);
  assert.match(appSource, /pairing = null;/u);
  assert.match(
    appSource,
    /Nothing will repeat automatically/u,
  );
});

test("post-results contribution CTA is explicit while technical and deletion controls stay quiet", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const coveragePosition = html.indexOf('id="coverage"');
  const ctaPosition = html.indexOf('id="contribution-cta"');
  const dataPosition = html.indexOf('id="data"');
  assert.ok(coveragePosition >= 0 && coveragePosition < ctaPosition);
  assert.ok(ctaPosition < dataPosition);
  assert.match(html, /What leaves this Mac — and what never does/u);
  assert.match(html, /Never shared: prompts, responses, reasoning, files, paths/u);
  assert.match(html, /id="contribution-not-now"/u);
  assert.match(html, /id="automatic-contribution-status"/u);
  assert.match(html, /id="automatic-contribution-toggle"[\s\S]*hidden/u);
  // Stopping recurring contribution is a consent control and the only in-page
  // way to do it, so it must never be "compact": that would drop it to a 37px
  // target and put it back in reach of the narrow-width rule that hides
  // compact buttons. [^<] anchors the match to this button's own attributes.
  const automaticToggleTag =
    html.match(/<button[^<]*id="automatic-contribution-toggle"[^<]*>/u)?.[0] ?? "";
  assert.match(automaticToggleTag, /class="button button-quiet"/u);
  assert.doesNotMatch(automaticToggleTag, /\bcompact\b/u);
  assert.match(html, /No daemon or login item is installed/u);
  assert.match(
    html,
    /<details class="panel sync-status-panel"[\s\S]*Advanced queue and exact review/u,
  );
  assert.match(
    html,
    /<details class="sync-exact-review" id="sync-exact-review" hidden>/u,
  );
  assert.match(
    html,
    /<details class="privacy-controls">[\s\S]*Delete all contributed metadata/u,
  );
  assert.doesNotMatch(
    html,
    /Download my data|Recover access|Reset access|Manage devices/u,
  );
});

test("the primary contribution journey never enables a recurring schedule", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const connectBody = appSource.match(
    /async function connectCommunityContribution\(\) \{([\s\S]*?)\n\}/u,
  )?.[1] ?? "";
  const runBody = appSource.match(
    /async function runContributionSyncAction\(action\) \{([\s\S]*?)\n\}/u,
  )?.[1] ?? "";
  assert.doesNotMatch(connectBody, /armAutomaticContributionAfterReviewedSend\(\)/u);
  assert.doesNotMatch(connectBody, /enableAutomaticContributionAfterReviewedSend\(\)/u);
  assert.match(runBody, /localClient\.runContributionSyncOnce\(/u);
  assert.doesNotMatch(runBody, /enableAutomaticContributionAfterReviewedSend/u);
  assert.doesNotMatch(appSource, /Automatic contribution is now on every 6 hours/u);
  assert.doesNotMatch(appSource, /sessionStorage|localStorage/u);
  assert.match(appSource, /Turn off automatic contribution/u);
});

test("stale local device conflicts name the leftover credential and offer the repair", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const recoveryMatch = appSource.match(
    /function renderContributionDeviceRecovery\(status, \{ error \} = \{\}\) \{([\s\S]*?)\n\}\n\nconst DEVICE_CREDENTIAL_RESET_CONFIRMATION/u,
  );
  assert.ok(recoveryMatch, "stale-device recovery renderer is available");
  const recoverySource = recoveryMatch[1];
  // The specific cause is named, and no unrelated thing is blamed.
  assert.match(recoverySource, /leftover contribution-device credential/u);
  assert.match(
    appSource,
    /CONTRIBUTION_DEVICE_CONFLICT_COPY =\n\s*"This Mac still holds a contribution-device credential from an earlier install/u,
  );
  assert.doesNotMatch(
    appSource.match(
      /const CONTRIBUTION_DEVICE_CONFLICT_COPY =\n[^\n]*\n/u,
    )[0],
    /invitation|invite/iu,
  );
  assert.match(recoverySource, /Metadata you already contributed is untouched/u);
  assert.match(recoverySource, /no hosted device is revoked/u);
  assert.match(recoverySource, /Data & Diagnostics… menu offers the same repair natively/u);
  assert.match(recoverySource, /Reset this Mac's device credential/u);
  assert.match(recoverySource, /action\.href = SEMANTIC_OPEN_TARGET/u);
  // Both names for the same fault reach the same explanation and repair.
  assert.match(
    appSource,
    /error\?\.code === "contribution_device_recovery_required"\s*\n\s*\|\| error\?\.code === "contribution_device_credential_conflict"/u,
  );
  // The reset control exists only inside the conflict renderer, so it can
  // never appear unless a credential conflict was actually detected.
  assert.equal(
    (appSource.match(/id = "reset-device-credential"/gu) ?? []).length,
    1,
  );
  // The renderer itself performs no deletion: it only offers the action.
  assert.doesNotMatch(
    recoverySource,
    /deleteExact|removeContributionDevice|rotateContribution|fetch\(/u,
  );
  // The repair requires an explicit confirmation and states its exact scope.
  const resetMatch = appSource.match(
    /async function resetContributionDeviceCredential\(\) \{([\s\S]*?)\n\}\n/u,
  );
  assert.ok(resetMatch, "the bounded device-credential repair is available");
  assert.match(
    resetMatch[1],
    /if \(!window\.confirm\(DEVICE_CREDENTIAL_RESET_CONFIRMATION\)\) return;/u,
  );
  assert.match(
    appSource,
    /DEVICE_CREDENTIAL_RESET_CONFIRMATION =[\s\S]*?Metadata you already contributed is not deleted, no hosted device is revoked/u,
  );
  assert.match(
    resetMatch[1],
    /localClient\.resetContributionDeviceCredential\(\)/u,
  );
});

test("real contribution UI encrypts before sending and renders delayed snapshots", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /createTelemetryEnvelope/);
  assert.match(appSource, /communityClient\.registerUpload\(/);
  assert.match(appSource, /communityClient\.contributeSerialized\(/);
  const submitBody = appSource.match(
    /async function submitContribution\(event\) \{([\s\S]*?)\n\}\n\nfunction renderPersonalStats/u,
  )?.[1];
  assert.ok(submitBody, "the browser upload boundary is available");
  assert.ok(
    submitBody.indexOf("await parseSafeExport(file)")
      < submitBody.indexOf("await ensureCommunitySession(payload.schemaVersion)"),
    "strict file parsing happens before session enrollment",
  );
  assert.ok(
    submitBody.indexOf("await parseSafeExport(file)")
      < submitBody.indexOf("communityClient.registerUpload"),
    "strict file parsing happens before upload registration",
  );
  assert.ok(
    submitBody.indexOf("await parseSafeExport(file)")
      < submitBody.indexOf("communityClient.contributeSerialized"),
    "strict file parsing happens before upload transport",
  );
  assert.match(
    appSource,
    /function parseSafeExport\(file\)[\s\S]*parseJsonWithUniqueObjectKeys\(content\)[\s\S]*duplicate JSON object keys/u,
  );
  assert.match(appSource, /communityClient\.participantProfile\(\)/);
  assert.match(appSource, /communityClient\.deleteContribution\(contributionId\)/);
  assert.match(appSource, /communityClient\.deleteParticipant\(\)/);
  assert.match(appSource, /renderSelectedContributionInspection\(file, payload\)/);
  assert.match(appSource, /selectedContributionValidated/);
  assert.match(appSource, /selectionRevision !== contributionSelectionRevision/);
  assert.match(appSource, /files\[0\] !== file/);
  assert.match(appSource, /JSON\.stringify\(payload, null, 2\)/);
  assert.match(appSource, /renderIndexProgress\(progress/);
  assert.match(appSource, /progress\.filesProcessed/);
  assert.match(appSource, /Continuing local analysis/);
  assert.match(appSource, /prepareLocalContribution/);
  assert.match(appSource, /localClient\.prepareContribution\(\{\s*lookbackHours: activeContributionLookbackHours/s);
  assert.doesNotMatch(appSource, /\brenderStats\(/);
  assert.match(appSource, /communityClient\.createDevicePairing\(/);
  assert.match(appSource, /localClient\.automaticContributionStatus\(\)/);
  // New contributions are explicit reviewed sends. A legacy schedule can
  // still be turned off, but this client no longer creates one.
  assert.doesNotMatch(appSource, /localClient\.enableAutomaticContribution\(/);
  assert.match(appSource, /localClient\.disableAutomaticContribution\(\)/);
  // Enrollment is open, so the dashboard always passes a null invitation code;
  // the client keeps the parameter for the service's invite-only mode.
  assert.match(
    appSource,
    /communityClient\.enroll\(\s*null,\s*contributionSchemaVersion,/u,
  );
  assert.doesNotMatch(appSource, /sessionStorage|localStorage|accessToken|Bearer/);
  assert.match(appSource, /void enrollment\.recoveryCode;/);
  assert.doesNotMatch(appSource, /showRecoveryCodeOnce/);
  // The community snapshot renderer is shared with the public site entry, so
  // its normalization boundary is asserted in the module that owns it.
  assert.match(
    await readFile(new URL("../public/community-view.js", import.meta.url), "utf8"),
    /normalizeCommunitySnapshot\(payload\)/,
  );
  assert.match(appSource, /renderSharedCommunitySnapshot\(\{/u);
  assert.match(appSource, /normalizeParticipantStats\(payload\)/);
  assert.match(appSource, /function renderBackendHealth\(health, readiness, \{ configured = true \} = \{\}\)/);
  assert.match(appSource, /Collection contained/);
  assert.match(appSource, /View, export, and delete remain available/);
  assert.match(appSource, /implementation_disabled/);
  assert.match(appSource, /Server-repriced API equivalent/);
  assert.match(appSource, /Standard API counterfactual/);
  assert.match(appSource, /Codex Fast observations/);
  assert.match(appSource, /Account continuity was not transmitted/);
  assert.match(appSource, /Account-scoped quota calibration/);
  assert.match(appSource, /Your contribution in the released week/);
  assert.match(appSource, /Accepted contribution history/);
  assert.match(appSource, /Encrypted object scheduled for deletion after/);
  assert.match(appSource, /does not delete the canonical metadata/);
  assert.match(appSource, /This is not an average, percentile, bill, or provider allowance/);
  // Fixed, non-speculative copy for every community-snapshot state now lives
  // in the shared renderer both surfaces use.
  const communityViewSource = await readFile(
    new URL("../public/community-view.js", import.meta.url),
    "utf8",
  );
  assert.match(communityViewSource, /A replacement revision may be pending/);
  assert.match(communityViewSource, /published_partial/);
  assert.match(
    communityViewSource,
    /We do not disclose why or how close the cohort was/,
  );
  assert.match(appSource, /Not testable/);
  assert.match(appSource, /for \(const smoothingHours of \[1, 2, 3\]\)/);
  assert.doesNotMatch(appSource, /Current eligible count|payload\.participantCount/);
});

test("foreground sync results expose all bounded outcomes and flag zero-accept passes", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const formatterMatch = appSource.match(
    /function contributionSyncPassResult\(result\) \{([\s\S]*?)\n\}\n\nfunction clearContributionSyncExactReview/u,
  );
  assert.ok(formatterMatch, "foreground sync result formatter is available for contract review");
  const formatterSource = formatterMatch[1];
  assert.match(
    formatterSource,
    /result\.status === "completed"[\s\S]*result\.accepted === 0[\s\S]*result\.retryable \+ result\.rejected > 0/u,
  );
  assert.match(formatterSource, /accepted,[\s\S]*waiting to retry,[\s\S]*rejected/u);
  assert.match(formatterSource, /may need to be paired as an upload-only device/u);
  assert.match(formatterSource, /do not identify the exact server-side reason/u);
  assert.match(
    appSource,
    /showContributionSyncAction\(outcome\.message, outcome\.needsAttention\)/u,
  );
  assert.match(
    appSource,
    /acceptedContribution = result\.status === "completed"[\s\S]*if \(acceptedContribution\) await loadCommunityResults\(\)/u,
  );
});

test("export filenames and reflected API errors remain bounded", () => {
  assert.equal(safeFilename("../../private id"), "usage-monitor-privateid-export.json");
  assert.equal(safeApiError({ error: { code: "INVALID_ENVELOPE" } }, "failed"), "INVALID ENVELOPE");
  assert.equal(safeApiError({ message: "private server detail" }, "failed"), "failed");
});

test("every user-visible failure carries a quotable, content-free reference", () => {
  const references = new Set();
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const reference = createDiagnosticReference(webcrypto);
    assert.match(reference, DIAGNOSTIC_REFERENCE_PATTERN);
    assert.equal(reference.length, 9);
    // Crockford base32: no I, L, O or U, so a reference read aloud or retyped
    // into a support conversation cannot collide with 1 or 0.
    assert.doesNotMatch(reference.slice(3), /[ILOU]/u);
    references.add(reference);
  }
  assert.ok(references.size > 480, "references are fresh randomness, not a counter");

  // The reference is minted from WebCrypto alone. Nothing the user typed and
  // nothing the service returned can influence it.
  const bytes = [];
  const recording = {
    getRandomValues(target) {
      bytes.push(target.length);
      target.fill(0);
      return target;
    },
  };
  assert.equal(createDiagnosticReference(recording), "TT-000000");
  assert.deepEqual(bytes, [6]);

  assert.equal(
    diagnosticReferenceSentence({ reference: "TT-7QF3K2" }),
    "Reference TT-7QF3K2, also written to the local diagnostics log.",
  );
  assert.equal(
    diagnosticReferenceSentence({
      reference: "TT-7QF3K2",
      requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
    }),
    "Reference TT-7QF3K2 · service request 0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b. Both are written to the local diagnostics log.",
  );
  // A malformed request id is dropped rather than shown, and a malformed
  // reference yields no sentence at all instead of a misleading one.
  assert.equal(
    diagnosticReferenceSentence({
      reference: "TT-7QF3K2",
      requestId: "participant:private",
    }),
    "Reference TT-7QF3K2, also written to the local diagnostics log.",
  );
  assert.equal(diagnosticReferenceSentence({ reference: "nope" }), "");
  assert.equal(diagnosticReferenceSentence(), "");

  assert.equal(
    serviceRequestId("0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b"),
    "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
  );
  for (const invalid of ["", "not-a-uuid", null, 7, "0F2C7A11-4B93-4BB2-9A7C-1C0D2E3F4A5B"]) {
    assert.equal(serviceRequestId(invalid), "");
  }
  assert.equal(diagnosticErrorCode("INTERNAL_ERROR"), "INTERNAL_ERROR");
  assert.equal(
    diagnosticErrorCode("contribution_device_credential_conflict"),
    "contribution_device_credential_conflict",
  );
  for (const invalid of ["failed at /Users/private", "a".repeat(81), null, {}]) {
    assert.equal(diagnosticErrorCode(invalid), "");
  }
  assert.equal(diagnosticSurface("contribution_connect"), "contribution_connect");
  assert.equal(diagnosticSurface("anything_else"), "");
  assert.ok(DIAGNOSTIC_SURFACES.includes("device_credential_reset"));
});

test("service request ids survive rejection so both sides of a failure can be joined", async () => {
  const requestId = "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b";
  const failing = (payload, status = 500) => new CommunityClient({
    getCsrfToken: () => "csrf-confirmation",
    fetchImpl: async () => new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await assert.rejects(
    failing({ error: { code: "INTERNAL_ERROR", requestId } }).personalStats(),
    (error) => error.status === 500
      && error.code === "INTERNAL_ERROR"
      && error.requestId === requestId,
  );
  // A body that is not the service's fixed error shape contributes nothing:
  // no code to branch on and no request id to show.
  await assert.rejects(
    failing({ error: { code: "sorry, it broke", requestId: "private-value" } })
      .personalStats(),
    (error) => error.code === undefined && error.requestId === undefined,
  );
  await assert.rejects(
    failing("not json at all").personalStats(),
    (error) => error.status === 500
      && error.code === undefined
      && error.requestId === undefined,
  );
});

test("diagnostic notes are recorded through a fixed, bounded local route", async () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        schemaVersion: "local-diagnostic-note-v0.1",
        status: "recorded",
        reference: "TT-7QF3K2",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const recorded = await client.recordDiagnosticNote({
    reference: "TT-7QF3K2",
    surface: "contribution_connect",
    code: "contribution_device_recovery_required",
    requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
  });
  assert.deepEqual(recorded, { status: "recorded", reference: "TT-7QF3K2" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/local/diagnostics/note");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Usage-Monitor-Local"], "1");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    reference: "TT-7QF3K2",
    surface: "contribution_connect",
    code: "contribution_device_recovery_required",
    requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
  });

  // A code or request id the boundary cannot vouch for is replaced, never
  // forwarded, so nothing free-form can reach the local log.
  await client.recordDiagnosticNote({
    reference: "TT-ZZ0011",
    surface: "contribution_send",
    code: "failed reading /Users/private/state.json",
    requestId: "private-value",
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    reference: "TT-ZZ0011",
    surface: "contribution_send",
    code: "unknown",
    requestId: "",
  });

  for (const invalid of [
    { reference: "nope", surface: "contribution_send" },
    { reference: "TT-7QF3K2", surface: "Not A Surface" },
    { reference: "TT-7QF3K2" },
  ]) {
    await assert.rejects(
      client.recordDiagnosticNote(invalid),
      /Diagnostic note inputs are invalid/u,
    );
  }
  assert.equal(calls.length, 2);

  assert.deepEqual(
    normalizeLocalDiagnosticNote({
      schemaVersion: "local-diagnostic-note-v0.1",
      status: "recorded",
      reference: "TT-IL0OU1",
    }),
    { status: "unavailable", reference: "" },
  );
  assert.deepEqual(
    normalizeLocalDiagnosticNote(null),
    { status: "unavailable", reference: "" },
  );
});

test("the device credential repair is explicit, local-only, and fails closed", async () => {
  const calls = [];
  const client = (payload, status = 200) => new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const reset = await client({
    schemaVersion: "local-contribution-device-reset-v0.1",
    status: "reset",
    credential: "deleted",
    binding: "removed",
    hostedDataDeleted: false,
    includesIdentifiers: false,
  }).resetContributionDeviceCredential();
  assert.deepEqual(reset, {
    status: "reset",
    credential: "deleted",
    binding: "removed",
  });
  assert.equal(
    calls[0].url,
    "/api/local/contribution/device-credential-reset",
  );
  assert.equal(calls[0].options.headers["X-Usage-Monitor-Local"], "1");
  assert.deepEqual(
    JSON.parse(calls[0].options.body),
    { confirm: "reset_device_credential" },
  );

  // A response that claims hosted data was deleted, or that carries an
  // identifier, is not the contract this page asked for and is refused.
  for (const payload of [
    {
      schemaVersion: "local-contribution-device-reset-v0.1",
      status: "reset",
      credential: "deleted",
      binding: "removed",
      hostedDataDeleted: true,
      includesIdentifiers: false,
    },
    {
      schemaVersion: "local-contribution-device-reset-v0.1",
      status: "reset",
      credential: "deleted",
      binding: "removed",
      hostedDataDeleted: false,
      includesIdentifiers: true,
    },
    {
      schemaVersion: "local-contribution-device-reset-v0.2",
      status: "reset",
      credential: "deleted",
      binding: "removed",
      hostedDataDeleted: false,
      includesIdentifiers: false,
    },
  ]) {
    assert.equal(
      normalizeLocalContributionDeviceReset(payload).status,
      "unavailable",
    );
  }
  assert.equal(
    normalizeLocalContributionDeviceReset(null).status,
    "unavailable",
  );

  await assert.rejects(
    client({
      schemaVersion: "local-companion-v0.1",
      error: { code: "device_credential_reset_failed" },
    }, 500).resetContributionDeviceCredential(),
    (error) => error.status === 500
      && error.code === "device_credential_reset_failed",
  );
});

test("sealed snapshots stay readable across both released contracts", () => {
  assert.deepEqual(SUPPORTED_COMMUNITY_SNAPSHOT_SCHEMA_VERSIONS, [
    "community-weekly-snapshot-v0.1",
    "community-weekly-snapshot-v0.2",
  ]);

  // A sealed revision is immutable by design, so a week published under the
  // earlier contract keeps being served and must keep rendering.
  const v01 = structuredClone(communitySnapshot());
  v01.schemaVersion = "community-weekly-snapshot-v0.1";
  delete v01.cells[0].planType;
  delete v01.cells[0].planVariant;
  const earlier = normalizeCommunitySnapshot(v01);
  assert.equal(earlier.state, "published");
  assert.equal(earlier.schemaVersion, "community-weekly-snapshot-v0.1");
  assert.equal(earlier.cells[0].metrics.usageEvents.value, 30);
  // Plan cohorts arrived with v0.2, so a v0.1 cell says unknown rather than
  // inventing a cohort or refusing the whole snapshot.
  assert.equal(earlier.cells[0].planType, "unknown");
  assert.equal(earlier.cells[0].planVariant, "unknown");

  const v02 = structuredClone(communitySnapshot());
  v02.cells[0].planType = "chatgpt_plus";
  v02.cells[0].planVariant = "standard";
  const current = normalizeCommunitySnapshot(v02);
  assert.equal(current.state, "published");
  assert.equal(current.schemaVersion, "community-weekly-snapshot-v0.2");
  assert.equal(current.cells[0].planType, "chatgpt_plus");
  assert.equal(current.cells[0].planVariant, "standard");

  // A cell that claims a cohort under the earlier contract does not get one:
  // the contract, not the payload, decides whether the field means anything.
  const spoofed = structuredClone(v01);
  spoofed.cells[0].planType = "chatgpt_pro";
  spoofed.cells[0].planVariant = "priority";
  const ignored = normalizeCommunitySnapshot(spoofed);
  assert.equal(ignored.cells[0].planType, "unknown");
  assert.equal(ignored.cells[0].planVariant, "unknown");

  // Every other check stays exactly as strict on the older contract.
  for (const mutate of [
    (payload) => { payload.immutable = false; },
    (payload) => { payload.nonOverlapping = false; },
    (payload) => { payload.privacyPolicy.minimumIndependentParticipants = 2; },
    (payload) => { delete payload.cells[0].metrics.toolUnits; },
    (payload) => { payload.cells[0].metrics.usageEvents.unit = "tokens_rounded_down"; },
    (payload) => { payload.cells[0].modelId = ""; },
    (payload) => { payload.ingestionCutoffAt = ""; },
  ]) {
    const broken = structuredClone(v01);
    mutate(broken);
    assert.equal(normalizeCommunitySnapshot(broken).state, "unsupported_schema");
  }

  // A contract nobody has released is still refused rather than guessed at.
  for (const version of [
    "community-weekly-snapshot-v0.3",
    "community-weekly-snapshot",
    "participant-community-comparison-v0.2",
    "",
  ]) {
    const unsupported = structuredClone(communitySnapshot());
    unsupported.schemaVersion = version;
    assert.equal(
      normalizeCommunitySnapshot(unsupported).state,
      "unsupported_schema",
    );
  }
});

test("participant community comparison reads both released contracts", () => {
  assert.deepEqual(SUPPORTED_PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSIONS, [
    "participant-community-comparison-v0.1",
    "participant-community-comparison-v0.2",
  ]);
  const comparison = (schemaVersion, cell = {}) => ({
    schemaVersion,
    status: "ready",
    snapshotId: "community-weekly:2026-07-20",
    snapshotRevision: 2,
    period: {
      startAt: "2026-07-20T00:00:00.000Z",
      endAt: "2026-07-27T00:00:00.000Z",
    },
    interpretation: "own_clipped_contribution_vs_public_rounded_total",
    cells: [{
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      participantHasActivity: true,
      metrics: Object.fromEntries([
        ["usageEvents", "events"],
        ["inputUncachedTokens", "tokens"],
        ["inputCacheReadTokens", "tokens"],
        ["inputCacheWriteTokens", "tokens"],
        ["outputTextTokens", "tokens"],
        ["outputReasoningTokens", "tokens"],
        ["outputCombinedTokens", "tokens"],
        ["toolUnits", "units"],
      ].map(([name, unit]) => [name, {
        status: "comparable",
        participantClippedValue: 3,
        communityRoundedValue: 20,
        unit,
      }])),
      ...cell,
    }],
  });

  const earlier = normalizeParticipantCommunityComparison(
    comparison("participant-community-comparison-v0.1"),
  );
  assert.equal(earlier.status, "ready");
  assert.equal(earlier.cells[0].metrics.usageEvents.participantClippedValue, 3);
  assert.equal(earlier.cells[0].planType, "unknown");
  assert.equal(earlier.cells[0].planVariant, "unknown");
  // v0.1 never checked a cohort, so false would be a claim it did not make.
  assert.equal(earlier.cells[0].cohortMatchesParticipant, "unknown");
  assert.deepEqual(earlier.participantPlanCohort, {
    planType: "unknown",
    planVariant: "unknown",
  });

  const current = normalizeParticipantCommunityComparison({
    ...comparison("participant-community-comparison-v0.2", {
      planType: "chatgpt_plus",
      planVariant: "standard",
      cohortMatchesParticipant: true,
    }),
    participantPlanCohort: {
      planType: "chatgpt_plus",
      planVariant: "standard",
    },
  });
  assert.equal(current.status, "ready");
  assert.equal(current.cells[0].planType, "chatgpt_plus");
  assert.equal(current.cells[0].cohortMatchesParticipant, true);
  assert.deepEqual(current.participantPlanCohort, {
    planType: "chatgpt_plus",
    planVariant: "standard",
  });

  // Cohort claims on a v0.1 payload are ignored, not adopted.
  const spoofed = normalizeParticipantCommunityComparison(
    comparison("participant-community-comparison-v0.1", {
      planType: "chatgpt_pro",
      cohortMatchesParticipant: true,
    }),
  );
  assert.equal(spoofed.cells[0].planType, "unknown");
  assert.equal(spoofed.cells[0].cohortMatchesParticipant, "unknown");

  // Everything else remains strict on the older contract.
  const invalidUnit = comparison("participant-community-comparison-v0.1");
  invalidUnit.cells[0].metrics.toolUnits.unit = "tokens";
  assert.equal(
    normalizeParticipantCommunityComparison(invalidUnit).reason,
    "comparison_contract_invalid",
  );
  const invalidProvider = comparison("participant-community-comparison-v0.1");
  invalidProvider.cells[0].provider = "unknown_provider";
  assert.equal(
    normalizeParticipantCommunityComparison(invalidProvider).reason,
    "comparison_contract_invalid",
  );

  // An unreleased contract is still refused.
  assert.equal(
    normalizeParticipantCommunityComparison(
      comparison("participant-community-comparison-v0.3"),
    ).status,
    "not_testable",
  );
});

test("result panels show the number and its caveat, not the service plumbing", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  // The publication-policy prose was relocated, not deleted, and now sits in a
  // collapsed disclosure beside the result.
  assert.match(html, /id="community-snapshot-provenance"/u);
  const provenance = html.match(
    /<details class="journey-disclosure service-detail-disclosure" id="community-snapshot-provenance">([\s\S]*?)<\/details>/u,
  )?.[1];
  assert.ok(provenance, "the snapshot provenance disclosure is available");
  assert.doesNotMatch(provenance, /\bopen\b/u);
  assert.match(provenance, /How this snapshot is produced/u);
  assert.match(
    provenance,
    /Community values use a fixed delay, independent per-cell support/u,
  );
  assert.match(provenance, /A sealed\s+revision is never rewritten/u);
  assert.match(provenance, /id="community-snapshot-service-detail"/u);

  // The default view keeps only what a reader needs to interpret the number.
  // Both entry points render this from one shared module.
  const detailBody = await readFile(
    new URL("../public/community-view.js", import.meta.url),
    "utf8",
  );
  assert.match(appSource, /from "\.\/community-view\.js"/u);
  assert.match(
    detailBody,
    /container\.append\(node\(\s*"p",\s*"snapshot-disclosure",\s*`Activity totals for the week above/u,
  );
  assert.match(
    detailBody,
    /container\.append\(node\(\s*"p",\s*"snapshot-partial",\s*"Some metrics were not released/u,
  );
  // Contract version, ingestion cutoff, release timing, clipping mechanics and
  // the next-contract statement all moved into the disclosure.
  for (const relocated of [
    /detail\.append\(quality\);/u,
    /\["Contract", snapshot\.schemaVersion\]/u,
    /\["Ingestion cutoff", formatLocal\(snapshot\.ingestionCutoffAt\)\]/u,
    /detail\.append\(node\(\s*"p",\s*"snapshot-disclosure",\s*`Each value is clipped per participant/u,
    /detail\.append\(node\(\s*"p",\s*"snapshot-disclosure",\s*"This release currently reports privacy-safe activity totals/u,
  ]) {
    assert.match(detailBody, relocated);
  }

  // The backend lifecycle plumbing is behind the same kind of disclosure, and
  // the panel's default copy answers what it means for the reader instead.
  const backendDetail = html.match(
    /<details class="journey-disclosure service-detail-disclosure" id="backend-service-detail">([\s\S]*?)<\/details>/u,
  )?.[1];
  assert.ok(backendDetail, "the backend service-detail disclosure is available");
  assert.match(backendDetail, /Service readiness and lifecycle detail/u);
  assert.match(backendDetail, /id="backend-facts"/u);
  assert.match(backendDetail, /class="backend-flow"/u);
  assert.match(backendDetail, /Account-scoped v0\.2 ingest is disabled by default/u);
  assert.match(backendDetail, /id="backend-readiness-note"/u);
  const description = html.match(
    /<p class="annotation" id="backend-description">([\s\S]*?)<\/p>/u,
  )?.[1];
  assert.ok(description, "the backend panel description is available");
  assert.match(description, /Your local reporting works whether or not it is reachable/u);
  assert.doesNotMatch(description, /reconciliation|restore replay|aggregate rebuild/u);
});

test("failure copy is chosen from fixed maps and never echoes a server string", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  // A code is an untrusted string, so every copy lookup goes through the
  // own-property helper. Plain member access would resolve "constructor" or
  // "toString" to an inherited value and render it as a sentence.
  assert.match(
    appSource,
    /function fixedCopy\(map, code\) \{\s*\n\s*return typeof code === "string" && Object\.hasOwn\(map, code\)/u,
  );
  for (const map of [
    "HOSTED_IDENTITY_ERROR_COPY",
    "SERVICE_ERROR_COPY",
    "LOCAL_COMPANION_ERROR_COPY",
    "COMMUNITY_COMPARISON_REASONS",
    "QUOTA_MOVEMENT_REASONS",
    "ACCOUNT_CALIBRATION_REASONS",
    "CONTRIBUTION_STATUS_LABELS",
  ]) {
    assert.doesNotMatch(appSource, new RegExp(`${map}\\[`, "u"));
    assert.match(appSource, new RegExp(`fixedCopy\\(\\s*${map},`, "u"));
  }

  // The explanation always comes from a fixed map or the caller's fallback.
  const describe = appSource.match(
    /function describeFailure\(\{ surface, error, messages = \{\}, fallback \}\) \{([\s\S]*?)\n\}\n/u,
  )?.[1];
  assert.ok(describe, "the failure describer is available");
  assert.match(
    describe,
    /const explanation = fixedCopy\(messages, code\)\s*\n\s*\?\? fixedCopy\(SERVICE_ERROR_COPY, code\)\s*\n\s*\?\? fixedCopy\(LOCAL_COMPANION_ERROR_COPY, code\)\s*\n\s*\?\? fallback;/u,
  );
  // The reference is minted per failure and filed against a fixed surface.
  assert.match(describe, /const reference = createDiagnosticReference\(\);/u);
  assert.match(describe, /const code = diagnosticErrorCode\(error\?\.code\);/u);
  assert.match(describe, /const requestId = serviceRequestId\(error\?\.requestId\);/u);
  assert.match(
    describe,
    /localClient\.recordDiagnosticNote\(\{\s*\n\s*reference,\s*\n\s*surface: diagnosticSurface\(surface\),/u,
  );
  // Filing the note must never replace telling the user what happened.
  assert.match(describe, /\}\)\.catch\(\(\) => \{\}\);/u);

  // The connect fallback no longer names three unrelated things to check.
  const connect = appSource.match(
    /async function connectCommunityContribution\(\) \{([\s\S]*?)\n\}\n/u,
  )?.[1];
  assert.ok(connect, "the connect journey is available");
  assert.doesNotMatch(connect, /Check the invitation/u);
  assert.doesNotMatch(
    connect,
    /Check service availability and Keychain access/u,
  );
  assert.match(
    connect,
    /The cause was not reported in a form this page can explain/u,
  );
  for (const code of [
    "BODY_INVALID",
    "CONTENT_TYPE_INVALID",
    "NOT_FOUND",
    "central_participant_request_not_authorized",
    "central_participant_response_too_large",
  ]) {
    assert.match(appSource, new RegExp(`${code}:`, "u"));
  }
  assert.match(
    connect,
    /const retryNeedsFreshSignIn = enrollmentAttemptedWithHostedIdentity\s*\n\s*&& !enrollmentEstablished\s*\n\s*&& hostedIdentity !== null;/u,
  );
  assert.match(
    connect,
    /hostedIdentity = null;\s*\n\s*renderHostedIdentity\(\);/u,
  );
  assert.match(
    connect,
    /For safety, this page discarded the one-time sign-in; sign in again before retrying\./u,
  );
  assert.match(
    connect,
    /if \(contributionDeviceRecoveryIsRequired\(error\)\) \{\s*\n\s*renderContributionDeviceRecovery\(status, \{ error \}\);/u,
  );

  // Every journey that can fail files its note against a fixed surface.
  const surfaces = [...appSource.matchAll(/surface: "([a-z_]+)"/gu)]
    .map((match) => match[1]);
  assert.ok(surfaces.length >= 7);
  for (const surface of surfaces) {
    assert.ok(
      DIAGNOSTIC_SURFACES.includes(surface),
      `${surface} is a fixed diagnostic surface`,
    );
  }
  for (const journey of [
    "contribution_connect",
    "contribution_prepare",
    "contribution_send",
    "device_credential_reset",
    "hosted_identity",
    "hosted_privacy",
    "automatic_contribution",
  ]) {
    assert.ok(surfaces.includes(journey), `${journey} reports failures`);
  }

  // The noisy implementation-path note stays out of the primary contribution
  // panel while the bounded diagnostic recorder remains available to support.
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="diagnostics-log-location"/u);
  assert.match(appSource, /localClient\.recordDiagnosticNote\(/u);
});

// The shareable card is the one surface whose output is meant to leave the
// machine as a picture, where nothing can be unshared and no reader can audit
// what produced it. These two tests hold the properties that make posting it
// safe: it can only paint fixed copy and formatted figures, and it always
// carries a reference in the format the diagnostic log records.
function shareCardSource(appSource) {
  const start = appSource.indexOf("// Shareable results card");
  const end = appSource.indexOf("function groupRolling(");
  assert.ok(start !== -1 && end > start, "the results-card section is available");
  return appSource.slice(start, end);
}

/**
 * The first argument of every `call` in `source`, whitespace-normalized.
 *
 * Scanning for the argument rather than matching a line catches a painted
 * value however it is formatted, including one wrapped across lines.
 */
function firstArguments(source, call) {
  const found = [];
  for (
    let index = source.indexOf(call);
    index !== -1;
    index = source.indexOf(call, index + call.length)
  ) {
    const start = index + call.length;
    let depth = 0;
    let cursor = start;
    for (; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (character === "(" || character === "[") depth += 1;
      else if (character === ")" || character === "]") {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === "," && depth === 0) break;
    }
    found.push(source.slice(start, cursor).trim().replace(/\s+/gu, " "));
  }
  return found;
}

test("a posted results card can carry only fixed copy and formatted figures", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const section = shareCardSource(appSource);

  // Everything painted onto the image. Each entry is either a literal written
  // here, a formatted number, or a field of the frozen card model, so a
  // payload string cannot reach the canvas without failing this list. A
  // prompt, a response, a file path, a folder name, a URL, an account
  // identifier or an email would all have to arrive as one of these.
  assert.deepEqual(
    [...new Set(firstArguments(section, "context.fillText("))].sort(),
    [
      "\"TiboTattle\"",
      "`${card.trend.count} reset fits`",
      "badge",
      "card.home",
      "card.trendEmpty",
      "card.trendEmptyDetail",
      "card.trendLabel.toUpperCase()",
      "formatMoney(value, axisDigits)",
      "line",
      "shareCardFit( context, \"Local measurement · API equivalent, not a bill.\", inner, )",
      "shareCardFit(context, card.identifierLine, inner)",
      "shareCardFit(context, card.relationshipNote, inner - 20)",
      "shareCardFit(context, card.subtitle, inner)",
      "shareCardFit(context, card.title, inner)",
      "shareCardFit(context, stat.value, textWidth)",
      "tick.label",
      "xAxisLabel",
      "yAxisLabel",
    ],
  );

  // The whole of the dashboard the card is allowed to see. Everything here is
  // a number, a fixed enumeration, or a version identifier; no field carries
  // user text, and a card that started reading one would fail this list.
  assert.deepEqual(
    [...new Set(
      [...section.matchAll(/data\??\.[A-Za-z]+(?:\?\.[A-Za-z]+)*/gu)].map((match) => match[0]),
    )].sort(),
    [
      "data?.mode",
      "data?.pricing",
      "data?.pricing?.coveragePercent",
      "data?.pricing?.fastMode?.unweightedUnknownApiPriceEquivalentUsd",
      "data?.pricing?.fastMode?.weightingStatus",
      "data?.pricing?.quotaWeightedTotalCostUsd",
      "data?.pricing?.registryVersion",
      "data?.pricing?.totalCostUsd",
      "data?.quotaWindows",
      "data?.schemaVersion",
      "data?.weekly?.summary",
      "data?.weekly?.summary?.median",
      "data?.weekly?.summary?.medianWeeklyValueUsd",
    ],
  );

  // The card receives the same derived history model as the Allowance page.
  // It cannot independently read raw local records, change the active range,
  // hide shorter fits, or select a different vertical scale.
  const trend = section.match(
    /function shareCardTrend\(history\) \{[\s\S]*?\n\}/u,
  )?.[0];
  assert.ok(trend, "the plotted history builder is available");
  assert.deepEqual(
    [...new Set([...trend.matchAll(/point\?\.[A-Za-z0-9_]+/gu)].map((match) => match[0]))].sort(),
    [
      "point?.acrossResetHigh",
      "point?.acrossResetLow",
      "point?.at",
      "point?.high",
      "point?.historicalMedian",
      "point?.low",
      "point?.value",
    ],
  );
  assert.match(trend, /Array\.isArray\(history\?\.points\)/u);
  assert.match(trend, /dateLabel: point\.dateLabel,/u);
  assert.match(trend, /wellObserved: point\.wellObserved === true,/u);
  assert.match(trend, /const axisLow = finite\(history\?\.axis\?\.low\);/u);
  assert.match(trend, /axis: Object\.freeze\(\{[\s\S]*?low: axisLow,/u);
  assert.match(trend, /xTicks: Object\.freeze\(\[\.\.\.\(history\?\.xTicks \?\? \[\]\)\]\),/u);
  assert.match(trend, /firstDateLabel: points\[0\]\.dateLabel,/u);
  assert.match(trend, /lastDateLabel: points\[points\.length - 1\]\.dateLabel,/u);
  assert.doesNotMatch(
    section,
    /toLocaleString|toLocaleDateString|toLocaleTimeString|toISOString|formatLocal/u,
  );
  // The only date formatter is a fixed month/day/year representation in the
  // viewer's time zone. It accepts the parsed number, not a source string.
  assert.match(
    section,
    /const SHARE_CARD_DATE_FORMAT = new Intl\.DateTimeFormat\("en-US", \{[\s\S]*?month: "short",[\s\S]*?day: "numeric",[\s\S]*?year: "numeric",/u,
  );
  assert.match(
    section,
    /function shareCardDateLabel\(timestamp\) \{\s*\n\s*return Number\.isFinite\(timestamp\) \? SHARE_CARD_DATE_FORMAT\.format\(timestamp\) : "";/u,
  );
  assert.match(section, /const yAxisLabel = "7-day allowance \(\$\)";/u);
  assert.match(section, /const xAxisLabel = "Reset estimate date";/u);
  assert.match(section, /for \(const value of axis\.ticks\) \{[\s\S]*?formatMoney\(value, axisDigits\)/u);
  assert.match(section, /for \(const tick of xTicks\) \{[\s\S]*?context\.fillText\(tick\.label, tickX, plotBottom \+ 21\);/u);
  assert.match(section, /const bandLow = finite\(points\[0\]\?\.acrossResetLow\);/u);
  assert.match(section, /const median = finite\(points\[0\]\?\.historicalMedian\);/u);
  assert.doesNotMatch(
    section,
    /SHARE_CARD_TREND_MAX_POINTS|function shareCardTrendAxis|function shareCardTrendDateTicks/u,
  );
  // The classification is fixed in the shared model, not read from the
  // on-screen control, so two readers of the same evidence post the same
  // picture.
  assert.doesNotMatch(section, /weeklySpanThresholdPp|showWeeklyPartialDiagnostics/u);

  // The three free-form strings that do arrive are each replaced before use.
  // A window's own label is never printed and an allowance is selected only
  // through the stable normal-Codex quota predicate, not its translated label.
  assert.match(
    section,
    /function shareCardWindowKind\(window\) \{\s*\n\s*if \(!isPrimaryCodexQuotaWindow\(window\)\) return "other";\s*\n\s*const minutes = finite\(window\?\.durationMinutes\);/u,
  );
  assert.match(
    section,
    /isPrimaryCodexQuotaWindow\(window\)[\s\S]*?shareCardWindowKind\(window\) === "seven_day"/u,
  );
  assert.deepEqual(
    [...new Set(
      [...section.matchAll(/\b(?:window|allowanceWindow)\??\.[A-Za-z]+/gu)].map((match) => match[0]),
    )].sort(),
    [
      "allowanceWindow?.remainingPercent",
      "window?.durationMinutes",
      "window?.remainingPercent",
    ],
  );
  // A period name is looked up in the product's own vocabulary and the phrase
  // written here is printed. The arriving string is matched, never rendered,
  // so even a recognized label reaches the image only as fixed copy.
  assert.match(
    section,
    /function shareCardPeriodLabel\(candidate\) \{\s*\n\s*return SHARE_CARD_PERIOD_PHRASES\.get\(candidate\) \?\? SHARE_CARD_UNKNOWN_PERIOD;/u,
  );
  const phrases = section.match(
    /const SHARE_CARD_PERIOD_PHRASES = new Map\(\[([\s\S]*?)\]\);/u,
  )?.[1];
  assert.ok(phrases, "the period vocabulary is available");
  assert.deepEqual(
    [...phrases.matchAll(/\["([^"]+)", "([^"]+)"\]/gu)].map((match) => match[1]),
    [
      "All retained evidence",
      "Last 24 hours",
      "Last 30 days",
      "Last 7 days",
      "Recorded period",
    ],
  );
  assert.match(section, /const period = shareCardPeriodLabel\(pricing\.periodLabel\);/u);
  assert.equal(
    section.match(/pricing\.periodLabel/gu).length,
    1,
    "the period label is read only through the fixed vocabulary",
  );
  // Both version identifiers are accepted only in a shape that cannot hold a
  // path, a sentence, or a quoted value.
  assert.match(
    section,
    /const SHARE_CARD_REGISTRY_VERSION_PATTERN = \/\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,47\}\$\/u;/u,
  );
  assert.match(
    section,
    /const SHARE_CARD_APP_VERSION_PATTERN = \/\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$\/u;/u,
  );
  assert.match(
    section,
    /return typeof candidate === "string"\s*\n\s*&& SHARE_CARD_REGISTRY_VERSION_PATTERN\.test\(candidate\)/u,
  );
  assert.match(
    section,
    /return SHARE_CARD_APP_VERSION_PATTERN\.test\(value \?\? ""\) \? value : "";/u,
  );

  // The link prints a host and nothing else, so no path, query or fragment
  // from the page's own canonical URL can be carried into a post.
  assert.match(
    section,
    /const host = new URL\(canonical\)\.hostname\.replace\(\/\^www\\\.\/u, ""\);\s*\n\s*return SHARE_CARD_HOME_PATTERN\.test\(host\) \? host : fallback;/u,
  );
  assert.doesNotMatch(section, /\.pathname|\.search|\.hash|location\.href/u);

  // Composed once and frozen, so nothing can be appended to a card between
  // composition and painting.
  assert.match(section, /return Object\.freeze\(\{\s*\n\s*reference,/u);
  assert.match(section, /stats: Object\.freeze\(stats\.map\(\(stat\) => Object\.freeze\(\{ \.\.\.stat \}\)\)\)/u);

  // The image and its accessible label are rendered from that one frozen card.
  // The redundant text transcript is intentionally absent from the primary UI.
  assert.match(section, /canvas\.setAttribute\("aria-label", shareCardText\(shareCard\)\);/u);
  assert.doesNotMatch(section, /renderShareCardReadout\(shareCard\);/u);
  assert.match(section, /if \(!drawShareCard\(canvas, shareCard\)\)/u);

  // The page makes the same promise beside the card.
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="share-panel"/u);
  assert.match(
    html,
    /It contains no\s*\n?\s*prompts, responses, paths, account details, or raw activity/u,
  );
});

test("the posted allowance graph uses the exact history model from the dashboard", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const section = shareCardSource(appSource);

  // A single presentation model owns range selection, point inclusion,
  // classification, vertical bounds, and date landmarks. Both surfaces take
  // their chart state from that model, so a post cannot tell a different story
  // from the Allowance estimate history beside it.
  assert.match(appSource, /function allowanceHistoryChartModel\(data,/u);
  assert.match(appSource, /function allowanceHistoryAxis\(points\)/u);
  assert.match(appSource, /function allowanceHistoryDateTicks\(points, maximum = 4\)/u);
  assert.match(
    appSource,
    /function renderWeekly\(data\) \{[\s\S]*?const history = allowanceHistoryChartModel\(data\);/u,
  );
  assert.match(appSource, /shell\.replaceChildren\(renderAllowanceHistoryChart\(history\)\);/u);
  assert.match(
    section,
    /const history = allowanceHistoryChartModel\(data\);\s*\n\s*const trend = shareCardTrend\(history\);/u,
  );
  assert.match(
    section,
    /history = allowanceHistoryChartModel\(data\),/u,
  );
  assert.doesNotMatch(
    section,
    /SHARE_CARD_TREND_MAX_POINTS|shareCardTrendAxis|shareCardTrendDateTicks/u,
  );
});

test("a posted results card always carries a diagnostic-format reference", async () => {
  // The reference is minted by the same helper the diagnostic surfaces use, so
  // a card someone posts can be matched against the local log.
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const reference = createDiagnosticReference(webcrypto);
    assert.match(reference, DIAGNOSTIC_REFERENCE_PATTERN);
    assert.match(reference, /^TT-[0-9A-Z]{6}$/u);
    assert.doesNotMatch(reference, /[ILOU]/u);
  }

  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const section = shareCardSource(appSource);

  // No card is composed at all without a reference in that format, so an image
  // can never be saved or copied untraceable.
  assert.match(
    section,
    /if \(!DIAGNOSTIC_REFERENCE_PATTERN\.test\(reference \?\? ""\)\) \{\s*\n\s*throw new TypeError\("A results card requires a minted reference\."\);/u,
  );
  assert.match(section, /shareCardReference = createDiagnosticReference\(\);/u);
  assert.doesNotMatch(section, /Math\.random|Date\.now|new Date\(/u);

  // One image and one reference always describe the same figures: the
  // reference is re-minted whenever any printed figure changes.
  const signature = section.match(
    /const signature = JSON\.stringify\(\[([\s\S]*?)\]\);/u,
  )?.[1];
  assert.ok(signature, "the figure signature is available");
  for (const figure of [
    "data?.mode",
    "shareCardWindowKind(allowanceWindow)",
    "finite(allowanceWindow?.remainingPercent)",
    "finite(data?.pricing?.quotaWeightedTotalCostUsd)",
    "finite(data?.pricing?.totalCostUsd)",
    "finite(data?.pricing?.coveragePercent)",
    "finite(data?.weekly?.summary?.median_weekly_value_usd",
    "trend,",
  ]) {
    assert.ok(signature.includes(figure), `${figure} re-mints the reference`);
  }
  assert.match(
    section,
    /const history = allowanceHistoryChartModel\(data\);\s*\n\s*const trend = shareCardTrend\(history\);/u,
  );
  assert.match(
    section,
    /if \(signature !== shareCardSignature \|\| shareCardReference === ""\) \{/u,
  );

  // It is printed on the image itself, first in the identifier line, and it
  // names the saved file so a downloaded card stays matched to it.
  assert.match(section, /const identifiers = \[\s*\n\s*`Debug: \$\{reference\}`,/u);
  assert.match(section, /`v\$\{appVersion\}`/u);
  assert.doesNotMatch(section, /price table \$\{registryVersion\}/u);
  assert.match(
    section,
    /return `tibotattle-results-\$\{card\.reference\}\.png`;/u,
  );
  assert.match(
    section,
    /Reference \$\{card\.reference\} is printed on the image/u,
  );

  // The same reference remains visible beside the card without duplicating a
  // full transcript of an image that is already the share surface.
  assert.match(section, /\$\("#share-card-reference"\)\.textContent = shareCard\.reference;/u);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="share-card-reference"/u);
  assert.doesNotMatch(html, /id="share-card-readout"/u);
});

test("a posted results card states a figure in full and marks a fixture as one", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const section = shareCardSource(appSource);

  // One type size for the whole row, chosen so the longest figure fits its
  // column whole. "Not estimable" and a seven-figure total both overrun the
  // column at the full size, and a figure cut off mid-word in the largest type
  // on the card is unreadable at a glance and easy to misread as a smaller
  // number.
  assert.match(
    section,
    /function shareCardValueSize\(context, values, maxWidth\) \{[\s\S]*?if \(values\.every\(\(value\) => context\.measureText\(value\)\.width <= maxWidth\)\) \{/u,
  );
  assert.match(
    section,
    /const valueSize = shareCardValueSize\(\s*\n\s*context,\s*\n\s*card\.stats\.map\(\(stat\) => stat\.value\),\s*\n\s*textWidth,\s*\n\s*\);/u,
  );
  assert.match(section, /context\.font = shareCardFont\(500, valueSize, "serif"\);/u);
  assert.doesNotMatch(section, /shareCardFont\(500, 54, "serif"\)/u);
  // Every value the card can print for missing evidence is spelled out, so the
  // size that fits them is the size the row is drawn at.
  for (const empty of ["Not observed", "Not available", "Not estimable"]) {
    assert.ok(section.includes(`"${empty}"`), `${empty} is one of the fixed figures`);
  }

  // A fixture is marked where a reader scrolling a timeline will see it: in
  // the line under the title and on a mark beside the wordmark, not only in
  // the smallest copy on the image.
  assert.match(
    section,
    /subtitle: isDemo\s*\n\s*\? "Illustrative demo data\. Not a measurement\."\s*\n\s*: "Measured on my own Mac\. Nothing left it\.",/u,
  );
  assert.match(section, /badge: isDemo \? "DEMO DATA" : "",/u);
  assert.match(section, /if \(card\.badge !== ""\) \{\s*\n\s*drawShareCardBadge\(/u);
  // The mark is drawn in the header, above the figures it qualifies.
  assert.ok(
    section.indexOf("drawShareCardBadge(\n      context,")
      < section.indexOf("card.stats.forEach"),
    "the demo mark is drawn before the figures",
  );
  // And the caveat that says the same thing stays, first in the list.
  assert.match(
    section,
    /if \(isDemo\) \{\s*\n\s*caveats\.push\(\s*\n\s*"Labeled demo data: an illustrative fixture, not measured usage\.",/u,
  );

  // The history takes exactly the room the qualifications leave, but a card
  // without material qualifications is allowed to use that visual height.
  assert.match(
    section,
    /const caveatTop = caveatLines\.length === 0\s*\n\s*\? ruleY - 8\s*\n\s*: ruleY - 22 - \(caveatLines\.length - 1\) \* caveatStep;/u,
  );
  assert.match(
    section,
    /const trendHeight = Math\.min\(\s*\n\s*SHARE_CARD_TREND_MAX_HEIGHT,\s*\n\s*Math\.max\(SHARE_CARD_TREND_MIN_HEIGHT, caveatTop - 30 - trendTop\),\s*\n\s*\);/u,
  );
  assert.match(
    section,
    /const trendTop = card\.relationshipNote === ""\s*\n\s*\? statTop \+ statHeight \+ 36\s*\n\s*: statTop \+ statHeight \+ 48;/u,
  );
  assert.match(section, /relationshipNote,/u);
  // The image makes the incomparable denominators explicit rather than
  // suggesting that seven days of recorded events is a single allowance.
  assert.match(section, /label: "Recorded activity"/u);
  assert.match(section, /label: "Estimated 7-day allowance"/u);
  assert.match(
    section,
    /Activity sums all events in \$\{period\}; the estimate is one seven-day allowance\./u,
  );
  // The social image reuses the date landmarks and vertical domain from the
  // Allowance estimate history, instead of inventing a compact-card axis.
  assert.match(appSource, /function allowanceHistoryDateTicks\(points, maximum = 4\)/u);
  assert.match(appSource, /xTicks: history\.xTicks,/u);
  assert.match(appSource, /yDomain: history\.axis,/u);
  assert.match(section, /for \(const tick of xTicks\)/u);
  assert.doesNotMatch(section, /shareCardTrendDateTicks|shareCardTrendAxis/u);
  assert.match(section, /const SHARE_CARD_TREND_MAX_HEIGHT = 290;/u);
  assert.match(section, /const SHARE_CARD_TREND_MIN_HEIGHT = 142;/u);
  // Only the qualifications that can change interpretation survive on a
  // social image; the full evidence remains in the local app.
  assert.match(appSource, /const SHARE_CARD_MAX_CAVEATS = 2;/u);
  assert.match(appSource, /const SHARE_CARD_MAX_CAVEAT_LINES = 2;/u);

  // The posted image and the preview element describe the same picture.
  assert.match(appSource, /const SHARE_CARD_WIDTH = 1200;/u);
  assert.match(appSource, /const SHARE_CARD_HEIGHT = 800;/u);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(
    html,
    /<canvas\s+id="share-card-canvas"[\s\S]*?width="1200"\s*\n\s*height="800"/u,
  );
});
