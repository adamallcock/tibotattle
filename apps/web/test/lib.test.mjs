import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  buildSyntheticFixture,
  bytesToBase64Url,
  createSyntheticEnvelope,
  createTelemetryEnvelope,
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
  COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
  CONTRIBUTION_SYNC_PREVIEW_SCHEMA_VERSION,
  CONTRIBUTION_SYNC_RUN_SCHEMA_VERSION,
  CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION,
  CommunityClient,
  demoDashboard,
  LocalCompanionClient,
  normalizeCommunitySnapshot,
  normalizeContributionSyncStatus,
  normalizeContributionSyncPreview,
  normalizeContributionSyncRun,
  normalizeLocalContributionPreparation,
  normalizeDashboardPayload,
  normalizeParticipantCommunityComparison,
  normalizeParticipantHistory,
  normalizeParticipantStats,
  PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION,
  PARTICIPANT_PROFILE_SCHEMA_VERSION,
  PARTICIPANT_STATS_SCHEMA_VERSION
} from "../public/data-client.js";

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

test("account-scoped browser preflight rejects direct account scopes and content fields", () => {
  const directScope = safeAccountScopedTelemetry();
  directScope.usageEvents[0].accountTrackId = `account:v1:${"a".repeat(64)}`;
  assert.throws(
    () => validateAccountScopedTelemetryContribution(directScope),
    /invalid usageEvents record/
  );
  const content = safeAccountScopedTelemetry();
  content.usageEvents[0].prompt = "private";
  assert.throws(
    () => validateAccountScopedTelemetryContribution(content),
    /forbidden content field/
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
    assert.throws(() => validateTelemetryContribution(payload), /forbidden content field/);
  }
});

test("browser telemetry validation rejects synthetic, wrong-schema, oversized, and deeply nested inputs", () => {
  assert.throws(() => validateTelemetryContribution({ synthetic: false }), /privacy-safe/);
  const synthetic = safeTelemetry();
  synthetic.synthetic = true;
  assert.throws(() => validateTelemetryContribution(synthetic), /privacy-safe/);
  assert.throws(
    () => validateTelemetryContribution(safeTelemetry(), { maxSerializedBytes: 10 }),
    /larger/
  );
  const nested = safeTelemetry();
  nested.extra = { a: { b: { c: 1 } } };
  assert.throws(() => validateTelemetryContribution(nested, { maxDepth: 1 }), /closed telemetry/);
  const tooMany = safeTelemetry();
  tooMany.usageEvents = Array.from({ length: 101 }, () => structuredClone(tooMany.usageEvents[0]));
  tooMany.quotaSnapshots = Array.from({ length: 100 }, () => ({}));
  assert.throws(() => validateTelemetryContribution(tooMany), /smaller batches/);
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
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      const body = url.endsWith("sync-next")
        ? previewPayload
        : url.endsWith("sync-once") ? runPayload : statusPayload;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.equal((await client.contributionSyncPreview()).state, "ready");
  assert.equal((await client.runContributionSyncOnce(reviewToken)).accepted, 1);
  assert.equal((await client.setContributionSyncPaused(true)).state, "paused");
  assert.deepEqual(calls.map((call) => call.url), [
    "/api/local/contribution/sync-next",
    "/api/local/contribution/sync-once",
    "/api/local/contribution/sync-pause"
  ]);
  for (const call of calls.slice(1)) {
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.headers["X-Usage-Monitor-Local"], "1");
  }
  assert.equal(calls[1].options.body, JSON.stringify({ reviewToken }));
  assert.equal(calls[2].options.body, "{}");
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

  const successClient = new LocalCompanionClient({
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/local/contribution/prepare");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["X-Usage-Monitor-Local"], "1");
      assert.equal(options.body, "{}");
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.equal((await successClient.prepareContribution()).status, "prepared");

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
  const client = new CommunityClient({
    getCsrfToken: () => "csrf-confirmation",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), {
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
  await client.enroll("um_invite_test");
  await client.recover("um_recovery_test");
  assert.equal(calls[12].url, "/api/health");
  assert.match(calls[13].options.body, /privacy-safe-telemetry-v0\.1/);
  assert.match(calls[13].options.body, /um_invite_test/);
  assert.match(calls[14].options.body, /um_recovery_test/);
});

test("contribution read and deletion keep identifiers out of request URLs", async () => {
  const calls = [];
  const contributionId = "contribution:00000000-0000-4000-8000-000000000001";
  const client = new CommunityClient({
    getCsrfToken: () => "csrf-confirmation",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), {
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
  for (const label of ["Overview", "Timeline", "Weekly", "Accounting", "Community", "Your data", "Gaps", "Privacy", "Backend"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /id="usage-timeline-chart"/);
  assert.match(html, /id="timeline-chart"/);
  assert.match(html, /id="weekly-chart"/);
  assert.match(html, /id="accounting"/);
  assert.match(html, /id="accounting-models"/);
  assert.match(html, /id="community"/);
  assert.match(html, /id="history"/);
  assert.match(html, /Your private results, export and deletion/);
  assert.match(html, /Exact metadata categories a contribution may contain/);
  assert.match(html, /id="contribution-file"/);
  assert.match(html, /id="contribution-invite"/);
  assert.match(html, /id="selected-contribution-inspection"/);
  assert.match(html, /Exact retained fields and values/);
  assert.match(html, /Review every validated field and value/);
  assert.match(html, /id="index-progress"/);
  assert.match(html, /id="prepare-contribution"/);
  assert.match(html, /id="preparation-identity"/);
  assert.match(html, /id="sync-exact-review"/);
  assert.match(html, /Every retained field and value in the next upload/);
  assert.match(html, /Raw log contents and source paths never enter this page/);
  assert.match(html, /id="central-state"/);
  assert.match(html, /id="backend"/);
  assert.match(html, /id="backend-state"/);
  assert.match(html, /id="backend-deletion-ledger"/);
  assert.match(html, /id="backend-lifecycle"/);
  assert.match(html, /id="backend-collection-state"/);
  assert.match(html, /id="backend-upload-registration"/);
  assert.match(html, /id="backend-processing"/);
  assert.match(html, /id="backend-publication"/);
  assert.match(html, /id="backend-participant-rights"/);
  assert.match(html, /Backend readiness and data lifecycle/);
  assert.match(html, /Transactional ingest/);
  assert.match(html, /id="download-participant"/);
  assert.match(html, /id="recover-form"/);
  assert.match(html, /id="security-reset"/);
  assert.match(html, /id="create-device-pairing"/);
  assert.match(html, /id="device-list"/);
  assert.match(html, /id="logout-participant"/);
  assert.match(html, /id="delete-participant"/);
  assert.match(html, /id="contribution-history"/);
  assert.match(html, /privacy-safe Usage Monitor export/);
  assert.match(appSource, /demo-button.*addEventListener/s);
  assert.match(appSource, /contributionSyncExactReview/);
  assert.match(appSource, /Open Keychain Access, select the login Keychain, unlock it/);
  assert.match(appSource, /Review every retained field and value below/);
  const loadBody = appSource.match(/async function loadLocalDashboard\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.doesNotMatch(loadBody, /demoDashboard/);
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
  assert.match(html, /data-nav="history"/);
  assert.match(html, /data-nav="backend"/);
  assert.match(html, /Exact UTC \/ local time/);
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
  assert.match(appSource, /"UTC"/);
  assert.match(appSource, /timelineStatusLabel/);
  assert.match(appSource, /recent_7d_partial/);
  assert.match(appSource, /cannot prove it reached the entire requested seven-day window/);
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

test("real contribution UI encrypts before sending and renders delayed snapshots", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /createTelemetryEnvelope/);
  assert.match(appSource, /communityClient\.registerUpload\(/);
  assert.match(appSource, /communityClient\.contributeSerialized\(/);
  assert.match(appSource, /communityClient\.participantExport\(\)/);
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
  assert.match(appSource, /Continuing bounded index/);
  assert.match(appSource, /prepareLocalContribution/);
  assert.match(appSource, /localClient\.prepareContribution\(\)/);
  assert.doesNotMatch(appSource, /\brenderStats\(/);
  assert.match(appSource, /communityClient\.createDevicePairing\(/);
  assert.match(appSource, /communityClient\.devices\(\)/);
  assert.match(appSource, /inviteInput\.value = ""/);
  assert.doesNotMatch(appSource, /sessionStorage|localStorage|accessToken|Bearer/);
  assert.match(appSource, /showRecoveryCodeOnce\(enrollment\.recoveryCode\)/);
  assert.match(appSource, /showRecoveryCodeOnce\(null\)/);
  assert.match(appSource, /normalizeCommunitySnapshot\(payload\)/);
  assert.match(appSource, /normalizeParticipantStats\(payload\)/);
  assert.match(appSource, /function renderBackendHealth\(health\)/);
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

test("export filenames and reflected API errors remain bounded", () => {
  assert.equal(safeFilename("../../private id"), "usage-monitor-privateid-export.json");
  assert.equal(safeApiError({ error: { code: "INVALID_ENVELOPE" } }, "failed"), "INVALID ENVELOPE");
  assert.equal(safeApiError({ message: "private server detail" }, "failed"), "failed");
});
