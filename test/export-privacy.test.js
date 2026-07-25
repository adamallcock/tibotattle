import test from "node:test";
import assert from "node:assert/strict";
import { inspectSensitiveExportStrings, verifyPrivacySafeBundle } from "../src/export-privacy.js";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import {
  normalizeClaudeStatusQuotaSnapshots,
  normalizeCodexCollectorQuotaCandidate,
} from "../src/export-safe-records.js";
import { deriveEventOccurrenceId, deriveSessionScopeId } from "../src/export-identity.js";

const SECRET = Buffer.alloc(32, 51);

function bundleWithQuota(snapshot) {
  return {
    schemaVersion: "usage-metadata-bundle-v0.1",
    compatibility: exportCompatibilityTuple(),
    bundleId: `bundle:v1:${"a".repeat(64)}`,
    participantId: `participant:v1:${"b".repeat(64)}`,
    createdAt: "2026-07-24T13:00:00.000Z",
    coveredAt: { startAt: "2026-07-24T12:00:00.000Z", endAt: "2026-07-24T13:00:00.000Z" },
    sourceProviders: [snapshot.provider],
    clientPlatform: "macos",
    transportReady: false,
    recordCounts: { usageEvents: 0, quotaSnapshots: 1, activityMarkers: 0 },
    records: { usageEvents: [], quotaSnapshots: [snapshot], activityMarkers: [] },
    diagnostics: { sourceFilesScanned: 1, codes: [] },
  };
}

function bundleWithUsage(usage) {
  const bundle = bundleWithQuota(usage);
  bundle.recordCounts = { usageEvents: 1, quotaSnapshots: 0, activityMarkers: 0 };
  bundle.records = { usageEvents: [usage], quotaSnapshots: [], activityMarkers: [] };
  return bundle;
}

test("sensitive string scanner recognizes common content and credential shapes", () => {
  const findings = inspectSensitiveExportStrings({
    a: "adam@example.com",
    b: "https://private.example/thread",
    c: "/Users/adam/private-repo",
    d: "Bearer abcdefghijklmnopqrstuvwxyz",
  });
  assert.deepEqual(new Set(findings.map((finding) => finding.code)), new Set([
    "email_address", "web_url", "absolute_user_path", "bearer_token",
  ]));
});

test("privacy gate fails closed without echoing the sensitive value", () => {
  const sensitive = "canary-private-value";
  const invalidBundle = {
    bundleId: `bundle:v1:${"a".repeat(64)}`,
    participantId: `participant:v1:${"b".repeat(64)}`,
    coveredAt: {},
    recordCounts: { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 },
    records: { usageEvents: [], quotaSnapshots: [], activityMarkers: [] },
    leaked: sensitive,
  };
  assert.throws(
    () => verifyPrivacySafeBundle(invalidBundle, { forbiddenSourceValues: [sensitive] }),
    (error) => error.message.includes("failed closed") && !error.message.includes(sensitive),
  );
});

test("privacy failures expose only fixed sensitive-pattern codes", () => {
  const invalidBundle = {
    bundleId: `bundle:v1:${"a".repeat(64)}`,
    participantId: `participant:v1:${"b".repeat(64)}`,
    coveredAt: {},
    recordCounts: { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 },
    records: { usageEvents: [], quotaSnapshots: [], activityMarkers: [] },
    leaked: "https://private.example/path",
  };
  assert.throws(
    () => verifyPrivacySafeBundle(invalidBundle),
    (error) => error.message.includes("sensitive=web_url")
      && error.message.includes("private.example") === false
      && error.message.includes("/records/") === false,
  );
});

test("privacy gate accepts the implemented OpenAI collector quota family", () => {
  const snapshot = normalizeCodexCollectorQuotaCandidate(SECRET, {
    candidateVersion: "codex-collector-quota-candidate-v0.1",
    kind: "quota_snapshot_candidate",
    provider: "openai_codex",
    observedTime: "2026-07-24T12:02:00.000Z",
    receivedTime: "2026-07-24T12:02:01.000Z",
    source: "app_server_read",
    planType: "pro",
    limitId: "codex",
    slot: "secondary",
    usedPercent: 12,
    displayPrecision: 0,
    windowDurationMinutes: 10_080,
    resetsAt: "2026-07-31T12:00:00.000Z",
    sharedPoolSurface: "account_shared_unallocated",
    accountScopeSubject: "unattributed",
    sessionScopeId: null,
    observationIdentityMaterial: "c".repeat(64),
  });
  assert.equal(verifyPrivacySafeBundle(bundleWithQuota(snapshot)).verdict, "passed");
});

test("privacy gate accepts Claude quota records under the partial provider adapter", () => {
  const [snapshot] = normalizeClaudeStatusQuotaSnapshots(SECRET, {
    schemaVersion: "0.2",
    kind: "claude_rate_limit_snapshot",
    provider: "anthropic_claude_code",
    capturedAt: "2026-07-24T12:02:00.000Z",
    clientVersion: "2.1.0",
    modelId: "claude_sonnet",
    fastMode: false,
    sessionPseudonym: `claude-session:v1:${"D".repeat(43)}`,
    limits: {
      fiveHour: { windowMinutes: 300, usedPercent: 8, resetsAt: 1_785_000_000 },
      sevenDay: null,
    },
    privacy: {
      rawSessionIdentifierStored: false,
      transcriptPathStored: false,
      workspaceStored: false,
      conversationContentStored: false,
      accountIdentifierStored: false,
      repositoryMetadataStored: false,
    },
  }, { physicalOccurrenceMaterial: `claude-ledger-occurrence:v1:${"E".repeat(43)}` });
  assert.equal(verifyPrivacySafeBundle(bundleWithQuota(snapshot)).verdict, "passed");
});

test("privacy gate accepts Claude usage events under the implemented transcript adapter", () => {
  const usage = {
    schemaVersion: "usage-event-v0.1",
    eventTime: "2026-07-24T12:02:00.000Z",
    provider: "anthropic_claude_code",
    modelId: "unknown",
    modelRecognition: "missing",
    modelFingerprint: null,
    billingSurface: "claude_subscription",
    speedMode: "unknown",
    apiServiceTier: "unknown",
    reasoningEffort: "unknown",
    components: {
      inputUncachedTokens: 10,
      inputCacheReadTokens: 20,
      inputCacheWriteTokens: 30,
      inputCacheWrite5mTokens: 30,
      inputCacheWrite1hTokens: 0,
      outputTextTokens: null,
      outputReasoningTokens: null,
      outputCombinedTokens: 40,
    },
    totalInputContextTokens: 60,
    surface: "local_rollout_unclassified",
    agentScope: "unknown",
    lineageDisposition: "standalone",
    toolClassCounts: {
      webSearch: 0,
      fileSearch: 0,
      codeInterpreter: 0,
      hostedShell: 0,
      computerUse: 0,
      mcp: 0,
      applyPatch: 0,
      localShell: 0,
      subagent: 0,
      toolGateway: 0,
      other: 0,
      unknown: 0,
    },
    outcome: "unknown",
    eventId: `event:v2:${"f".repeat(64)}`,
    sessionScopeId: `session:v1:${"0".repeat(64)}`,
    accountScopeId: "unattributed",
  };
  assert.equal(verifyPrivacySafeBundle(bundleWithUsage(usage)).verdict, "passed");
});

test("hex-derived identifiers pass the scanner and credential-shaped ID values fail closed", () => {
  const usage = {
    schemaVersion: "usage-event-v0.1",
    eventTime: "2026-07-24T12:02:00.000Z",
    provider: "anthropic_claude_code",
    modelId: "unknown",
    modelRecognition: "missing",
    modelFingerprint: null,
    billingSurface: "claude_subscription",
    speedMode: "unknown",
    apiServiceTier: "unknown",
    reasoningEffort: "unknown",
    components: {
      inputUncachedTokens: 1,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      inputCacheWrite5mTokens: 0,
      inputCacheWrite1hTokens: 0,
      outputTextTokens: null,
      outputReasoningTokens: null,
      outputCombinedTokens: 1,
    },
    totalInputContextTokens: 1,
    surface: "local_rollout_unclassified",
    agentScope: "unknown",
    lineageDisposition: "standalone",
    toolClassCounts: {
      webSearch: 0, fileSearch: 0, codeInterpreter: 0, hostedShell: 0,
      computerUse: 0, mcp: 0, applyPatch: 0, localShell: 0,
      subagent: 0, toolGateway: 0, other: 0, unknown: 0,
    },
    outcome: "unknown",
    eventId: deriveEventOccurrenceId(SECRET, "privacy-regression-event"),
    sessionScopeId: deriveSessionScopeId(SECRET, "privacy-regression-session"),
    accountScopeId: "unattributed",
  };
  assert.match(usage.eventId, /^event:v2:[a-f0-9]{64}$/u);
  assert.equal(inspectSensitiveExportStrings(usage).some(({ code }) => code === "common_api_key"), false);
  assert.equal(verifyPrivacySafeBundle(bundleWithUsage(usage)).verdict, "passed");

  const credentialShaped = structuredClone(usage);
  credentialShaped.eventId = `event:v2:sk-${"A".repeat(40)}`;
  assert.equal(
    inspectSensitiveExportStrings(credentialShaped).some(({ code, path }) =>
      code === "common_api_key" && path === "/eventId"),
    true,
  );
  assert.throws(
    () => verifyPrivacySafeBundle(bundleWithUsage(credentialShaped)),
    (error) => error.message.includes("schema_allowlist")
      && error.message.includes("sensitive_string_scan")
      && error.message.includes("common_api_key")
      && error.message.includes("sk-") === false,
  );
});
