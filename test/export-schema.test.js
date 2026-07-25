import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { exportRegistrySnapshot } from "../src/export-registries.js";
import { exportSchemas, validateExportRecord } from "../src/export-schema.js";
import { exportCompatibilityTuple } from "../src/export-contract.js";

function usageEvent() {
  return {
    schemaVersion: "usage-event-v0.1",
    eventTime: "2026-07-24T12:00:00.000Z",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    modelRecognition: "recognized",
    modelFingerprint: null,
    billingSurface: "chatgpt_subscription",
    speedMode: "fast",
    apiServiceTier: "unknown",
    reasoningEffort: "unknown",
    components: {
      inputUncachedTokens: 10,
      inputCacheReadTokens: 20,
      inputCacheWriteTokens: 0,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
      outputTextTokens: 5,
      outputReasoningTokens: 3,
      outputCombinedTokens: null,
    },
    totalInputContextTokens: 30,
    surface: "local_interactive_unclassified",
    agentScope: "root",
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
    eventId: `event:v2:${"a".repeat(64)}`,
    sessionScopeId: `session:v1:${"b".repeat(64)}`,
    accountScopeId: "unattributed",
  };
}

function quotaSnapshot() {
  return {
    schemaVersion: "quota-snapshot-v0.1",
    observedTime: "2026-07-24T12:00:00.000Z",
    receivedTime: "2026-07-24T12:00:00.000Z",
    provider: "openai_codex",
    planType: "pro",
    planVariant: "unknown",
    limitId: "codex",
    slot: "secondary",
    usedPercent: 12,
    displayPrecision: 0,
    windowDurationMinutes: 10080,
    resetsAt: "2026-07-31T12:00:00.000Z",
    snapshotSource: "rollout",
    providerSurface: "account_shared_unallocated",
    snapshotId: `snapshot:v2:${"c".repeat(64)}`,
    providerStateId: `quota-state:v1:${"d".repeat(64)}`,
    sessionScopeId: `session:v1:${"e".repeat(64)}`,
    accountScopeId: "unattributed",
  };
}

function activityMarker() {
  return {
    schemaVersion: "export-activity-marker-v0.1",
    observedTime: "2026-07-24T12:00:00.000Z",
    surface: "controlled_experiment",
    state: "pulse",
    agenticPoolCoupling: "depends_on_experiment_surface",
    planType: "pro",
    planVariant: "unknown",
    markerId: `marker:v2:${"4".repeat(64)}`,
    accountScopeId: "unattributed",
  };
}

function bundleWithDiagnostic(code) {
  return {
    schemaVersion: "usage-metadata-bundle-v0.1",
    compatibility: exportCompatibilityTuple(),
    bundleId: `bundle:v1:${"f".repeat(64)}`,
    participantId: `participant:v1:${"0".repeat(64)}`,
    createdAt: "2026-07-24T12:00:00.000Z",
    coveredAt: { startAt: "2026-07-24T11:00:00.000Z", endAt: "2026-07-24T12:00:00.000Z" },
    sourceProviders: ["openai_codex"],
    clientPlatform: "macos",
    transportReady: false,
    recordCounts: { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 },
    records: { usageEvents: [], quotaSnapshots: [], activityMarkers: [] },
    diagnostics: { sourceFilesScanned: 1, codes: [{ code, count: 1 }] },
  };
}

function privacyReceipt() {
  return {
    schemaVersion: "privacy-receipt-v0.1",
    compatibility: exportCompatibilityTuple(),
    createdAt: "2026-07-24T12:00:00.000Z",
    bundleId: `bundle:v1:${"f".repeat(64)}`,
    participantId: `participant:v1:${"0".repeat(64)}`,
    bundleSha256: "1".repeat(64),
    bundleBytes: 1,
    verdict: "passed",
    transportReady: false,
    coveredAt: { startAt: "2026-07-24T11:00:00.000Z", endAt: "2026-07-24T12:00:00.000Z" },
    recordCounts: { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 },
    checks: ["schema_allowlist", "sensitive_string_scan", "source_value_canary_scan", "provider_adapter_compatibility"]
      .map((code) => ({ code, status: "passed", violations: 0 })),
    excludedCategories: ["prompt_and_response_content"],
  };
}

test("allowlist schema accepts a valid usage event and rejects unknown nested fields", () => {
  assert.equal(validateExportRecord("usageEvent", usageEvent()).valid, true);
  const contaminated = usageEvent();
  contaminated.components.prompt = "private";
  const result = validateExportRecord("usageEvent", contaminated);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.keyword === "additionalProperties"));
  assert.equal(JSON.stringify(result.errors).includes("private"), false);
});

test("arbitrary source-like fields cannot pass the strict usage schema", () => {
  fc.assert(fc.property(
    fc.stringMatching(/^[a-z][a-zA-Z0-9]{2,24}$/).filter((key) => !Object.hasOwn(usageEvent(), key)),
    fc.oneof(fc.string(), fc.integer(), fc.boolean()),
    (key, value) => {
      const candidate = { ...usageEvent(), [key]: value };
      return validateExportRecord("usageEvent", candidate).valid === false;
    },
  ), { numRuns: 100 });
});

test("reviewed registries and schemas expose the same closed model, limit, and diagnostic vocabularies", () => {
  const registry = exportRegistrySnapshot();
  assert.deepEqual(
    exportSchemas.usageEvent.properties.modelId.enum,
    ["unknown", ...registry.providers.openai_codex.modelIds, ...registry.providers.anthropic_claude_code.modelIds],
  );
  assert.deepEqual(
    exportSchemas.quotaSnapshot.properties.limitId.enum,
    ["unknown", ...registry.providers.openai_codex.limitIds],
  );
  assert.deepEqual(
    exportSchemas.bundle.properties.diagnostics.properties.codes.items.properties.code.enum,
    registry.diagnosticCodes,
  );
});

test("unreviewed models, provider-incompatible models, limits, and diagnostics fail closed", () => {
  const arbitraryModel = usageEvent();
  arbitraryModel.modelId = "gpt-private-safe";
  assert.equal(validateExportRecord("usageEvent", arbitraryModel).valid, false);

  const recognizedWithFingerprint = usageEvent();
  recognizedWithFingerprint.modelFingerprint = `model:v1:${"1".repeat(64)}`;
  assert.equal(validateExportRecord("usageEvent", recognizedWithFingerprint).valid, false);

  const missingModel = usageEvent();
  missingModel.modelId = "unknown";
  missingModel.modelRecognition = "missing";
  missingModel.modelFingerprint = null;
  assert.equal(validateExportRecord("usageEvent", missingModel).valid, true);

  const unrecognizedWithoutFingerprint = usageEvent();
  unrecognizedWithoutFingerprint.modelId = "unknown";
  unrecognizedWithoutFingerprint.modelRecognition = "unrecognized";
  unrecognizedWithoutFingerprint.modelFingerprint = null;
  assert.equal(validateExportRecord("usageEvent", unrecognizedWithoutFingerprint).valid, false);

  const claudeWithGpt = usageEvent();
  claudeWithGpt.provider = "anthropic_claude_code";
  assert.equal(validateExportRecord("usageEvent", claudeWithGpt).valid, false);

  const codexWithClaude = usageEvent();
  codexWithClaude.modelId = "claude-sonnet-5";
  assert.equal(validateExportRecord("usageEvent", codexWithClaude).valid, false);

  const arbitraryLimit = quotaSnapshot();
  arbitraryLimit.limitId = "private.safe";
  assert.equal(validateExportRecord("quotaSnapshot", arbitraryLimit).valid, false);

  const claudeWithCodexLimit = quotaSnapshot();
  claudeWithCodexLimit.provider = "anthropic_claude_code";
  assert.equal(validateExportRecord("quotaSnapshot", claudeWithCodexLimit).valid, false);

  assert.equal(validateExportRecord("bundle", bundleWithDiagnostic("new_unreviewed_code")).valid, false);
  assert.equal(validateExportRecord("bundle", bundleWithDiagnostic("malformed_lines")).valid, true);
  for (const code of [
    "collector_empty_lines",
    "collector_irrelevant_records",
    "collector_out_of_bounds_records",
    "collector_oversized_irrelevant_lines",
    "collector_unsupported_schema_records",
    "collector_unsupported_source_records",
  ]) {
    assert.equal(validateExportRecord("bundle", bundleWithDiagnostic(code)).valid, true, code);
  }
});

test("pre-hardening draft v0.1 records fail closed and must be regenerated", () => {
  const legacyUsage = usageEvent();
  delete legacyUsage.modelRecognition;
  legacyUsage.eventId = `event:v1:${"a".repeat(64)}`;
  assert.equal(validateExportRecord("usageEvent", legacyUsage).valid, false);

  const legacyQuota = quotaSnapshot();
  delete legacyQuota.providerStateId;
  legacyQuota.snapshotId = `snapshot:v1:${"c".repeat(64)}`;
  assert.equal(validateExportRecord("quotaSnapshot", legacyQuota).valid, false);

  const oldBase64urlEncoding = usageEvent();
  oldBase64urlEncoding.eventId = `event:v2:${"A".repeat(43)}`;
  assert.equal(validateExportRecord("usageEvent", oldBase64urlEncoding).valid, false);

  const oldBundleEncoding = bundleWithDiagnostic("malformed_lines");
  oldBundleEncoding.participantId = `participant:v1:${"B".repeat(43)}`;
  assert.equal(validateExportRecord("bundle", oldBundleEncoding).valid, false);
});

test("every export-facing telemetry identifier rejects the old base64url body shape", () => {
  const oldBody = "A".repeat(43);
  const cases = [
    ["usageEvent", () => usageEvent(), "eventId", `event:v2:${oldBody}`],
    ["usageEvent", () => usageEvent(), "sessionScopeId", `session:v1:${oldBody}`],
    ["usageEvent", () => usageEvent(), "accountScopeId", `account:v1:${oldBody}`],
    ["quotaSnapshot", () => quotaSnapshot(), "snapshotId", `snapshot:v2:${oldBody}`],
    ["quotaSnapshot", () => quotaSnapshot(), "providerStateId", `quota-state:v1:${oldBody}`],
    ["quotaSnapshot", () => quotaSnapshot(), "sessionScopeId", `session:v1:${oldBody}`],
    ["quotaSnapshot", () => quotaSnapshot(), "accountScopeId", `account:v1:${oldBody}`],
    ["activityMarker", () => activityMarker(), "markerId", `marker:v2:${oldBody}`],
    ["activityMarker", () => activityMarker(), "accountScopeId", `account:v1:${oldBody}`],
    ["bundle", () => bundleWithDiagnostic("malformed_lines"), "bundleId", `bundle:v1:${oldBody}`],
    ["bundle", () => bundleWithDiagnostic("malformed_lines"), "participantId", `participant:v1:${oldBody}`],
    ["privacyReceipt", () => privacyReceipt(), "bundleId", `bundle:v1:${oldBody}`],
    ["privacyReceipt", () => privacyReceipt(), "participantId", `participant:v1:${oldBody}`],
  ];

  for (const [kind, makeRecord, field, value] of cases) {
    const record = makeRecord();
    record[field] = value;
    assert.equal(validateExportRecord(kind, record).valid, false, `${kind}.${field}`);
  }

  const unrecognizedModel = usageEvent();
  unrecognizedModel.modelId = "unknown";
  unrecognizedModel.modelRecognition = "unrecognized";
  unrecognizedModel.modelFingerprint = `model:v1:${oldBody}`;
  assert.equal(validateExportRecord("usageEvent", unrecognizedModel).valid, false, "usageEvent.modelFingerprint");
});

test("sessionless quota snapshots are limited to account-level OpenAI collector observations", () => {
  const rollout = quotaSnapshot();
  rollout.sessionScopeId = null;
  assert.equal(validateExportRecord("quotaSnapshot", rollout).valid, false);

  const declaration = quotaSnapshot();
  declaration.snapshotSource = "ui_declaration";
  declaration.sessionScopeId = null;
  assert.equal(validateExportRecord("quotaSnapshot", declaration).valid, false);

  for (const snapshotSource of ["app_server_read", "notification"]) {
    const attributed = quotaSnapshot();
    attributed.snapshotSource = snapshotSource;
    attributed.sessionScopeId = null;
    attributed.accountScopeId = `account:v1:${"1".repeat(64)}`;
    assert.equal(validateExportRecord("quotaSnapshot", attributed).valid, true);

    const unattributed = structuredClone(attributed);
    unattributed.accountScopeId = "unattributed";
    assert.equal(validateExportRecord("quotaSnapshot", unattributed).valid, true);

    const sessionScopedCollector = structuredClone(attributed);
    sessionScopedCollector.sessionScopeId = `session:v1:${"2".repeat(64)}`;
    assert.equal(validateExportRecord("quotaSnapshot", sessionScopedCollector).valid, false);
  }

  const claude = quotaSnapshot();
  claude.provider = "anthropic_claude_code";
  claude.planType = "unknown";
  claude.limitId = "unknown";
  claude.slot = "seven_day";
  claude.snapshotSource = "status_line";
  claude.providerSurface = "general_usage";
  assert.equal(validateExportRecord("quotaSnapshot", claude).valid, true);
  claude.sessionScopeId = null;
  assert.equal(validateExportRecord("quotaSnapshot", claude).valid, false);
});
