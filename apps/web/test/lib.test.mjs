import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  SEMANTIC_OPEN_TARGET_PLACEHOLDER,
} from "../../../config/product-brand.js";

import {
  buildSyntheticFixture,
  bytesToBase64Url,
  contributionBatchAdmission,
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
  PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION,
  PARTICIPANT_PROFILE_SCHEMA_VERSION,
  PARTICIPANT_STATS_SCHEMA_VERSION
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

test("same-duration provider tracks stay distinguishable without inventing account labels", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    quotaWindows: [
      { limitId: "codex", durationMinutes: 10080, usedPercent: 39 },
      { limitId: "codex_bengalfox", durationMinutes: 10080, usedPercent: 0 }
    ]
  });
  assert.equal(result.quotaWindows[0].label, "Seven-day allowance");
  assert.equal(result.quotaWindows[1].label, "Secondary observed allowance");
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

test("local pairing preserves only the fixed recovery-required error code", async () => {
  const pairingCode =
    "um_pair_00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const client = new LocalCompanionClient({
    fetchImpl: async () => new Response(JSON.stringify({
      schemaVersion: "local-companion-v0.1",
      error: {
        code: "contribution_device_recovery_required",
      },
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await assert.rejects(
    client.pairContributionDevice(pairingCode),
    (error) => error?.status === 409
      && error?.code === "contribution_device_recovery_required",
  );

  const unrelated = new LocalCompanionClient({
    fetchImpl: async () => new Response(JSON.stringify({
      schemaVersion: "local-companion-v0.1",
      error: {
        code: "contribution_device_pairing_not_configured",
      },
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await assert.rejects(
    unrelated.pairContributionDevice(pairingCode),
    (error) => error?.status === 409 && error?.code === undefined,
  );
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
    "Monitoring gaps",
    "Your contribution receipt",
    "Community backend readiness"
  ]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /id="usage-timeline-chart"/);
  assert.match(html, /id="timeline-chart"/);
  assert.match(html, /id="weekly-chart"/);
  assert.match(html, /id="accounting"/);
  assert.match(html, /id="accounting-models"/);
  assert.match(html, /Usage increments/);
  assert.match(html, /Percentages are API-price-equivalent cost shares/);
  assert.match(html, /id="community"/);
  assert.match(html, /id="history"/);
  assert.match(html, /Your contribution receipt/);
  assert.match(html, /Exact metadata categories a contribution may contain/);
  assert.match(html, /id="contribution-file"/);
  assert.match(html, /id="contribution-invite"/);
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
  assert.match(html, /privacy-safe Usage Monitor export/);
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
    /Open Usage Monitor from Applications and use the separate local dashboard tab/,
  );
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

  assert.match(appSource, /function configuredInstallerUrl\(\)/u);
  assert.match(appSource, /function configuredInstallerMetadata\(/u);
  assert.match(appSource, /function configuredInstallerRelease\(\)/u);
  assert.match(appSource, /function configuredSemanticOpenTarget\(\)/u);
  assert.match(appSource, /const SEMANTIC_OPEN_TARGET = configuredSemanticOpenTarget\(\);/u);
  assert.match(appSource, /installedAppLink\.href = SEMANTIC_OPEN_TARGET/u);
  assert.doesNotMatch(appSource, /usagemonitor:\/\/open/u);
  assert.match(appSource, /SHA-256 \$\{release\.sha256\}/u);
  assert.match(appSource, /Requires macOS \$\{release\.minimumMacos\} or later/u);
  assert.match(appSource, /selected\.protocol === "https:"/u);
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
  assert.match(appSource, /setup: "Local setup needed"/u);
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
  assert.match(appSource, /Deep analysis stopped at a safety limit/u);
  assert.match(appSource, /previously verified results remain usable/u);
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
  assert.match(html, /id="weekly-evidence-controls"/);
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
  assert.match(appSource, /row\.last_observed_at \?\? row\.first_observed_at/);
  assert.match(appSource, /Partial diagnostic extrapolated to 100 percentage points/);
  assert.match(appSource, /lookbackHours: activeContributionLookbackHours/);
  assert.match(styles, /interactive-chart/);
  assert.match(styles, /chart-status-missing/);
  assert.match(styles, /touch-action: pan-y/);
  assert.match(styles, /\.chart-navigation \.button\.compact \{ display: inline-flex; \}/);
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

test("weekly view gives a plain-language change conclusion", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /id="weekly-trend"/);
  assert.match(html, /Has the inferred limit changed/);
  assert.match(appSource, /function renderWeeklyTrend/);
  assert.match(appSource, /no convincing change detected/);
  assert.match(appSource, /possible accounting or allowance shift/);
});

test("weekly defaults to high-confidence evidence and partial diagnostics are opt-in", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const allFitsControl =
    html.match(/<button[^>]*data-evidence="all"[^>]*>/u)?.[0] ?? "";
  const matureControl =
    html.match(/<button[^>]*data-evidence="mature"[^>]*>/u)?.[0] ?? "";

  assert.doesNotMatch(allFitsControl, /\bactive\b|aria-pressed="true"/u);
  assert.match(matureControl, /\bactive\b/u);
  assert.match(matureControl, /aria-pressed="true"/u);
  assert.match(appSource, /let showWeeklyPartialDiagnostics = false;/u);
  assert.match(
    appSource,
    /const chartValues = showWeeklyPartialDiagnostics[\s\S]*?\? rangedValues[\s\S]*?: rangedValues\.filter\(\(row\) => row\.matureValue !== null\);/u,
  );
  assert.match(
    appSource,
    /matureValue: observedSpanPp !== null && observedSpanPp >= 80 \? value : null/u,
  );
  assert.match(
    appSource,
    /showWeeklyPartialDiagnostics = button\.dataset\.evidence === "all"/u,
  );
});

test("weekly trend is derived from the selected displayed evidence only", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /renderWeeklyTrend\(chartValues\);/u);

  const trendMatch = appSource.match(
    /function renderWeeklyTrend\(([^)]*)\) \{([\s\S]*?)\n\}\n\nfunction renderWeeklyStats/u,
  );
  assert.ok(trendMatch, "renderWeeklyTrend source is available for contract review");
  const [, parameters, trendSource] = trendMatch;
  assert.equal(parameters.trim(), "values");
  assert.match(trendSource, /values\.slice\(0, 3\)/u);
  assert.match(trendSource, /values\.slice\(-3\)/u);
  assert.doesNotMatch(
    trendSource,
    /gradient|early_three_median_usd|recent_three_median_usd|early_to_recent_change/u,
  );
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
    /row\.limitId === "codex" && row\.durationMinutes === 10_080/u,
  );
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
  assert.match(
    liveSource,
    /const weeklyQuota = mainWeeklyQuotaTrack\(data\.timeline\.quota\);/u,
  );
  assert.match(
    liveSource,
    /const quota = \(weeklyQuota\.length \? weeklyQuota : data\.timeline\.quota\)/u,
  );
});

test("local-only UI says the optional community service is not connected", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(
    appSource,
    /Local preparation available; community service not connected/u,
  );
  assert.match(
    appSource,
    /The optional community service is not connected in this local-only build\./u,
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

test("primary contribution journey connects the Mac without exposing a pairing code", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const id of [
    "contribution-invite",
    "community-connect-consent",
    "connect-community",
    "community-connect-status",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /Help map Codex limits/u);
  assert.match(html, /content-free pseudonymous metadata/u);
  assert.match(html, /I consent to contribute this metadata and keep it current/u);
  assert.match(html, /Contribute and keep it current/u);
  const consentTag =
    html.match(/<input id="community-connect-consent"[^>]*>/u)?.[0] ?? "";
  assert.doesNotMatch(consentTag, /\bchecked\b/u);
  assert.match(html, /every 6 hours while the app is open/u);
  assert.match(html, /This is off until I choose it/u);
  assert.match(appSource, /async function connectCommunityContribution\(\)/u);
  assert.match(appSource, /\{ deviceBootstrap: true \}/u);
  assert.match(appSource, /localClient\.pairContributionDevice\(pairing\.pairingCode\)/u);
  assert.match(appSource, /void enrollment\.recoveryCode;/u);
  assert.match(appSource, /armAutomaticContributionAfterReviewedSend/u);
  assert.match(appSource, /pendingAutomaticContributionConsent = binding/u);
  assert.match(appSource, /inspectNextContribution/u);
  assert.match(appSource, /pairing = null;/u);
  assert.match(
    appSource,
    /Automatic contribution remains off until that exact reviewed send is accepted/u,
  );
});

test("post-results contribution CTA is explicit while technical and deletion controls stay quiet", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const coveragePosition = html.indexOf('id="coverage"');
  const ctaPosition = html.indexOf('id="contribution-cta"');
  const dataPosition = html.indexOf('id="data"');
  assert.ok(coveragePosition >= 0 && coveragePosition < ctaPosition);
  assert.ok(ctaPosition < dataPosition);
  assert.match(html, /What would be contributed\?/u);
  assert.match(html, /No message content, reasoning text, filenames, URLs, commands/u);
  assert.match(html, /id="contribution-not-now"/u);
  assert.match(html, /id="automatic-contribution-status"/u);
  assert.match(html, /id="automatic-contribution-toggle"[\s\S]*hidden/u);
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

test("automatic contribution is enabled only after the exact reviewed first send is accepted", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const connectBody = appSource.match(
    /async function connectCommunityContribution\(\) \{([\s\S]*?)\n\}/u,
  )?.[1] ?? "";
  const runBody = appSource.match(
    /async function runContributionSyncAction\(action\) \{([\s\S]*?)\n\}/u,
  )?.[1] ?? "";
  assert.match(connectBody, /armAutomaticContributionAfterReviewedSend\(\)/u);
  assert.doesNotMatch(connectBody, /enableAutomaticContributionAfterReviewedSend\(\)/u);
  assert.match(runBody, /runReviewedContributionGate\(\{/u);
  assert.match(runBody, /acceptedContribution = gate\.accepted/u);
  assert.match(
    runBody,
    /hasPendingAutomaticConsent:[\s\S]*Boolean\(pendingAutomaticContributionConsent\)[\s\S]*enableAutomaticContribution:[\s\S]*enableAutomaticContributionAfterReviewedSend/u,
  );
  assert.match(
    appSource,
    /Consent is held only in this open tab\. Automatic contribution remains off until your exact reviewed first send is accepted/u,
  );
  assert.match(
    appSource,
    /gate\.automaticError\?\.code[\s\S]*=== "automatic_contribution_first_review_required"/u,
  );
  assert.doesNotMatch(appSource, /sessionStorage|localStorage/u);
  for (const explanation of [
    "five-minute abort deadline",
    "local pseudonymous identity is unavailable",
    "privacy verification failed",
    "service rejected part of the exact prepared set",
    "local preparation or maintenance failed",
    "delivery failed without a safe retry signal",
  ]) {
    assert.match(appSource, new RegExp(explanation, "u"));
  }
  assert.match(
    appSource,
    /value\.lastOutcome\?\.code[\s\S]*replaceAll\("_", " "\)/u,
  );
  assert.match(appSource, /No retry is scheduled/u);
});

test("stale local device conflicts route users to the confirmed native reset", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const recoveryMatch = appSource.match(
    /function renderContributionDeviceRecovery\(status\) \{([\s\S]*?)\n\}\n\nasync function finishCommunityDevicePairing/u,
  );
  assert.ok(recoveryMatch, "stale-device recovery renderer is available");
  const recoverySource = recoveryMatch[1];
  assert.match(recoverySource, /No evidence was uploaded/u);
  assert.match(recoverySource, /did not delete or rotate anything/u);
  assert.match(
    recoverySource,
    /Data & Diagnostics…[\s\S]*Identity & Device Reset…[\s\S]*both native confirmations/u,
  );
  assert.match(recoverySource, /does not revoke hosted devices or delete hosted data/u);
  assert.match(recoverySource, /action\.href = SEMANTIC_OPEN_TARGET/u);
  assert.match(
    appSource,
    /error\?\.code === "contribution_device_recovery_required"/u,
  );
  assert.equal(
    (appSource.match(/renderContributionDeviceRecovery\(status\)/gu) ?? [])
      .length,
    2,
    "one declaration and the primary pairing path use the recovery renderer",
  );
  assert.doesNotMatch(
    recoverySource,
    /deleteExact|removeContributionDevice|rotateContribution|fetch\(/u,
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
  assert.match(appSource, /localClient\.enableAutomaticContribution\(/);
  assert.match(appSource, /localClient\.disableAutomaticContribution\(\)/);
  assert.match(appSource, /inviteInput\.value = ""/);
  assert.doesNotMatch(appSource, /sessionStorage|localStorage|accessToken|Bearer/);
  assert.match(appSource, /void enrollment\.recoveryCode;/);
  assert.doesNotMatch(appSource, /showRecoveryCodeOnce/);
  assert.match(appSource, /normalizeCommunitySnapshot\(payload\)/);
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
  assert.match(appSource, /A replacement revision may be pending/);
  assert.match(appSource, /Not testable/);
  assert.match(appSource, /for \(const smoothingHours of \[1, 2, 3\]\)/);
  assert.match(appSource, /published_partial/);
  assert.match(appSource, /We do not disclose why or how close the cohort was/);
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
    /acceptedContribution = gate\.accepted[\s\S]*if \(acceptedContribution && pendingAutomaticContributionConsent\)[\s\S]*if \(acceptedContribution\) await loadCommunityResults\(\)/u,
  );
});

test("export filenames and reflected API errors remain bounded", () => {
  assert.equal(safeFilename("../../private id"), "usage-monitor-privateid-export.json");
  assert.equal(safeApiError({ error: { code: "INVALID_ENVELOPE" } }, "failed"), "INVALID ENVELOPE");
  assert.equal(safeApiError({ message: "private server detail" }, "failed"), "failed");
});
