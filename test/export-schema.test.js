import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { exportRegistrySnapshot } from "../src/export-registries.js";
import { exportSchemas, validateExportRecord } from "../src/export-schema.js";

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
      outputTextTokens: 5,
      outputReasoningTokens: 3,
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
    eventId: `event:v2:${"A".repeat(43)}`,
    sessionScopeId: `session:v1:${"B".repeat(43)}`,
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
    snapshotId: `snapshot:v2:${"C".repeat(43)}`,
    providerStateId: `quota-state:v1:${"D".repeat(43)}`,
    sessionScopeId: `session:v1:${"E".repeat(43)}`,
    accountScopeId: "unattributed",
  };
}

function bundleWithDiagnostic(code) {
  return {
    schemaVersion: "usage-metadata-bundle-v0.1",
    exporterVersion: "0.1.0",
    bundleId: `bundle:v1:${"F".repeat(43)}`,
    participantId: `participant:v1:${"G".repeat(43)}`,
    createdAt: "2026-07-24T12:00:00.000Z",
    coveredAt: { startAt: "2026-07-24T11:00:00.000Z", endAt: "2026-07-24T12:00:00.000Z" },
    consentVersion: "local-dry-run-v0.1",
    sourceProviders: ["openai_codex"],
    clientPlatform: "macos",
    transportReady: false,
    recordCounts: { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 },
    records: { usageEvents: [], quotaSnapshots: [], activityMarkers: [] },
    diagnostics: { sourceFilesScanned: 1, codes: [{ code, count: 1 }] },
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
    ["unknown", ...registry.providers.openai_codex.modelIds],
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
  recognizedWithFingerprint.modelFingerprint = `model:v1:${"H".repeat(43)}`;
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

  const arbitraryLimit = quotaSnapshot();
  arbitraryLimit.limitId = "private.safe";
  assert.equal(validateExportRecord("quotaSnapshot", arbitraryLimit).valid, false);

  const claudeWithCodexLimit = quotaSnapshot();
  claudeWithCodexLimit.provider = "anthropic_claude_code";
  assert.equal(validateExportRecord("quotaSnapshot", claudeWithCodexLimit).valid, false);

  assert.equal(validateExportRecord("bundle", bundleWithDiagnostic("new_unreviewed_code")).valid, false);
  assert.equal(validateExportRecord("bundle", bundleWithDiagnostic("malformed_lines")).valid, true);
});

test("pre-hardening draft v0.1 records fail closed and must be regenerated", () => {
  const legacyUsage = usageEvent();
  delete legacyUsage.modelRecognition;
  legacyUsage.eventId = `event:v1:${"A".repeat(43)}`;
  assert.equal(validateExportRecord("usageEvent", legacyUsage).valid, false);

  const legacyQuota = quotaSnapshot();
  delete legacyQuota.providerStateId;
  legacyQuota.snapshotId = `snapshot:v1:${"C".repeat(43)}`;
  assert.equal(validateExportRecord("quotaSnapshot", legacyQuota).valid, false);
});
