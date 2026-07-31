/**
 * Runtime-neutral contract for the durable local export workspace.  The
 * composition root supplies serialization, hashing, platform naming, and the
 * adjacent export-owner bindings; this owner never imports Node or a platform.
 */
function configurationFailure() {
  throw new TypeError("Export workspace contract configuration is invalid");
}

function ownValue(configuration, key) {
  try {
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)
        || !Object.hasOwn(configuration, key)) configurationFailure();
    const descriptor = Object.getOwnPropertyDescriptor(configuration, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) configurationFailure();
    return descriptor.value;
  } catch {
    configurationFailure();
  }
}

function ownCallable(configuration, key, isProxy = null) {
  const value = ownValue(configuration, key);
  if (typeof value !== "function" || (isProxy && isProxy(value))) configurationFailure();
  return value;
}

function ownData(value, isProxy) {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) configurationFailure();
  const result = {};
  try {
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || isProxy(descriptor.value)) configurationFailure();
      result[key] = descriptor.value;
    }
  } catch { configurationFailure(); }
  return Object.freeze(result);
}

function ownString(value, isProxy) {
  if (typeof value !== "string" || isProxy(value)) configurationFailure();
  return value;
}

function ownStringArray(value, isProxy) {
  if (!Array.isArray(value) || isProxy(value)) configurationFailure();
  const values = [];
  try {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")
          || typeof descriptor.value !== "string" || isProxy(descriptor.value)) configurationFailure();
      values.push(descriptor.value);
    }
  } catch { configurationFailure(); }
  return Object.freeze(values);
}

export function createExportWorkspaceContract(configuration = {}) {
  const isProxy = ownCallable(configuration, "isProxy");
  if (isProxy(configuration)) configurationFailure();
  const stableJson = ownCallable(configuration, "stableJson", isProxy);
  const sha256Hex = ownCallable(configuration, "sha256Hex", isProxy);
  const platformName = ownCallable(configuration, "platformName", isProxy);
  const assertValidExportRecord = ownCallable(configuration, "assertValidExportRecord", isProxy);
  const normalizeExportResourceLimits = ownCallable(configuration, "normalizeExportResourceLimits", isProxy);
  const summarizeExportSourcePlan = ownCallable(configuration, "summarizeExportSourcePlan", isProxy);
  const assertCanonicalSupplementalCursorJson = ownCallable(configuration, "assertCanonicalSupplementalCursorJson", isProxy);
  const createEmptySupplementalSourcePlan = ownCallable(configuration, "createEmptySupplementalSourcePlan", isProxy);
  const normalizeSupplementalSourcePlan = ownCallable(configuration, "normalizeSupplementalSourcePlan", isProxy);
  const summarizeSupplementalSourcePlan = ownCallable(configuration, "summarizeSupplementalSourcePlan", isProxy);
  const createEmptyCodexCheckpointState = ownCallable(configuration, "createEmptyCodexCheckpointState", isProxy);
  const normalizeCodexCheckpointState = ownCallable(configuration, "normalizeCodexCheckpointState", isProxy);
  const serializeCodexCheckpointState = ownCallable(configuration, "serializeCodexCheckpointState", isProxy);
  const EXPORT_DIAGNOSTIC_CODES = ownStringArray(ownValue(configuration, "EXPORT_DIAGNOSTIC_CODES"), isProxy);
  const EXPORT_CHECKPOINT_PARSER_VERSION = ownString(ownValue(configuration, "EXPORT_CHECKPOINT_PARSER_VERSION"), isProxy);
  const resourceLimits = ownData(ownValue(configuration, "DEFAULT_EXPORT_RESOURCE_LIMITS"), isProxy);
  const DEFAULT_EXPORT_RESOURCE_LIMITS = ownData(
    normalizeExportResourceLimits(resourceLimits),
    isProxy,
  );
  const EXPORT_RESOURCE_POLICY_VERSION = ownString(ownValue(configuration, "EXPORT_RESOURCE_POLICY_VERSION"), isProxy);
  const EXPORT_SOURCE_PLAN_VERSION = ownString(ownValue(configuration, "EXPORT_SOURCE_PLAN_VERSION"), isProxy);
  const EXPORT_SUPPLEMENTAL_SOURCE_PLAN_VERSION = ownString(ownValue(configuration, "EXPORT_SUPPLEMENTAL_SOURCE_PLAN_VERSION"), isProxy);

  const EXPORT_WORKSPACE_VERSION = "usage-export-workspace-v0.4";
  const DEFAULT_EXPORT_WORKSPACE_MAXIMUM_BYTES = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumWorkspaceBytes;
  const DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumSqliteBatchRecords;
  const EXPORT_WORKSPACE_DATABASE_BASENAME = "workspace.sqlite3";
  const CHECKPOINT_PHASES = new Set(["tier_scan", "record_scan", "complete"]);
  const SUPPLEMENTAL_CHECKPOINT_STATUSES = new Set(["pending", "complete"]);
  const REVIEWED_DIAGNOSTIC_CODES = new Set(EXPORT_DIAGNOSTIC_CODES);
  const SAFE_WORKSPACE_CODES = new Set([
    "exists", "missing", "directory", "database_type", "database_owner", "database_permissions",
    "database_links", "database_changed", "sqlite_unavailable", "schema", "checkpoint_mismatch",
    "record_conflict", "transaction", "disk",
  ]);

  class ExportWorkspaceError extends Error {
    constructor(code) {
      if (!SAFE_WORKSPACE_CODES.has(code)) throw new TypeError("Unknown export-workspace failure code");
      super(`Local export workspace failed (${code})`);
      this.name = "ExportWorkspaceError";
      this.code = `export_workspace_${code}`;
    }
  }

  function fail(code) { throw new ExportWorkspaceError(code); }
  function validSha256(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
  function exactKeys(value, keys) {
    return value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  }
  function safeCount(value) { return Number.isSafeInteger(value) && value >= 0; }
  function isCheckpointPhase(value) { return CHECKPOINT_PHASES.has(value); }
  function isSupplementalCheckpointStatus(value) { return SUPPLEMENTAL_CHECKPOINT_STATUSES.has(value); }
  function isReviewedDiagnosticCode(value) { return REVIEWED_DIAGNOSTIC_CODES.has(value); }
  function parseCanonical(value) {
    try {
      const parsed = JSON.parse(value);
      if (stableJson(parsed) !== value) fail("schema");
      return parsed;
    } catch (error) {
      if (error instanceof ExportWorkspaceError) throw error;
      fail("schema");
    }
  }
  function validDescriptorResourceLimits(value) {
    try { return stableJson(value) === stableJson(normalizeExportResourceLimits(value)); } catch { return false; }
  }
  function validSupplementalSourcePlanSummary(value) {
    return exactKeys(value, ["schemaVersion", "supplementalSourcePlanSha256", "sourceCount", "sourceFiles", "sourceBytes"])
      && value.schemaVersion === EXPORT_SUPPLEMENTAL_SOURCE_PLAN_VERSION
      && validSha256(value.supplementalSourcePlanSha256)
      && safeCount(value.sourceCount) && safeCount(value.sourceFiles) && safeCount(value.sourceBytes);
  }
  function assertDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)
        || descriptor.workspaceVersion !== EXPORT_WORKSPACE_VERSION
        || descriptor.resourcePolicyVersion !== EXPORT_RESOURCE_POLICY_VERSION
        || !validDescriptorResourceLimits(descriptor.resourceLimits)
        || typeof descriptor.participantId !== "string" || !/^participant:v1:[a-f0-9]{64}$/.test(descriptor.participantId)
        || typeof descriptor.createdAt !== "string" || !Number.isFinite(Date.parse(descriptor.createdAt))
        || !descriptor.coveredAt || !Number.isFinite(Date.parse(descriptor.coveredAt.startAt))
        || !Number.isFinite(Date.parse(descriptor.coveredAt.endAt))
        || Date.parse(descriptor.coveredAt.endAt) < Date.parse(descriptor.coveredAt.startAt)
        || descriptor.sourcePlan?.schemaVersion !== EXPORT_SOURCE_PLAN_VERSION
        || !validSha256(descriptor.sourcePlan?.sourcePlanSha256)
        || !safeCount(descriptor.sourcePlan?.sourceFiles) || !safeCount(descriptor.sourcePlan?.sourceBytes)
        || !validSupplementalSourcePlanSummary(descriptor.supplementalSourcePlan)
        || !safeCount(descriptor.activityPlan?.recordCount) || !validSha256(descriptor.activityPlan?.recordsSha256)
        || !descriptor.compatibility || typeof descriptor.compatibility !== "object"
        || !Array.isArray(descriptor.sourceProviders) || descriptor.sourceProviders.length < 1
        || descriptor.sourceProviders.some((provider) => provider !== "openai_codex" && provider !== "anthropic_claude_code")
        || !["macos", "linux", "windows", "other", "unknown"].includes(descriptor.clientPlatform)) fail("schema");
  }
  function assertSourcePlanMatchesDescriptor(sourcePlan, descriptor) {
    if (stableJson(summarizeExportSourcePlan(sourcePlan)) !== stableJson(descriptor.sourcePlan)) fail("checkpoint_mismatch");
  }
  function assertSupplementalSourcePlanMatchesDescriptor(supplementalSourcePlan, descriptor) {
    let summary;
    try { summary = summarizeSupplementalSourcePlan(supplementalSourcePlan); } catch { fail("schema"); }
    if (stableJson(summary) !== stableJson(descriptor.supplementalSourcePlan)) fail("checkpoint_mismatch");
  }
  function assertCheckpointExpected(value) {
    if (!exactKeys(value, ["checkpointSeq", "phase", "byteOffset", "lineOrdinal"])
        || !safeCount(value.checkpointSeq) || !CHECKPOINT_PHASES.has(value.phase)
        || !safeCount(value.byteOffset) || !safeCount(value.lineOrdinal)) fail("schema");
    return value;
  }
  function normalizeSupplementalCursorJson(value) {
    try { return assertCanonicalSupplementalCursorJson(value); } catch { fail("schema"); }
  }
  function assertSupplementalCheckpointExpected(value) {
    if (!exactKeys(value, ["checkpointSeq", "status", "cursorJson"])
        || !safeCount(value.checkpointSeq) || !SUPPLEMENTAL_CHECKPOINT_STATUSES.has(value.status)) fail("schema");
    return { checkpointSeq: value.checkpointSeq, status: value.status, cursorJson: normalizeSupplementalCursorJson(value.cursorJson) };
  }
  function normalizeDiagnosticDeltas(value = []) {
    if (!Array.isArray(value) || value.length > 128) fail("schema");
    return value.map((item) => {
      if (!exactKeys(item, ["code", "count"]) || typeof item.code !== "string"
          || !/^[a-z][a-z0-9_]{0,63}$/.test(item.code) || !REVIEWED_DIAGNOSTIC_CODES.has(item.code)
          || !safeCount(item.count)) fail("schema");
      return { code: item.code, count: item.count };
    });
  }
  function sourceCheckpointBatchSha256(batch) {
    if (!batch || typeof batch !== "object" || Array.isArray(batch)) fail("schema");
    const subject = structuredClone(batch); delete subject.batchSha256;
    return sha256Hex(`app-usagemonitor/source-checkpoint-batch/v1\0${stableJson(subject)}`);
  }
  function supplementalSourceCheckpointBatchSha256(batch) {
    if (!batch || typeof batch !== "object" || Array.isArray(batch)) fail("schema");
    const subject = structuredClone(batch); delete subject.batchSha256;
    return sha256Hex(`app-usagemonitor/supplemental-source-checkpoint-batch/v1\0${stableJson(subject)}`);
  }
  function buildExportWorkspaceDescriptor({
    participantId, createdAt, coveredAt, compatibility, sourcePlan,
    supplementalSourcePlan = createEmptySupplementalSourcePlan(), activityPlan,
    sourceProviders = ["openai_codex"], clientPlatform = platformName(),
    resourceLimits = DEFAULT_EXPORT_RESOURCE_LIMITS,
  } = {}) {
    const descriptor = {
      workspaceVersion: EXPORT_WORKSPACE_VERSION,
      resourcePolicyVersion: EXPORT_RESOURCE_POLICY_VERSION,
      resourceLimits: { ...normalizeExportResourceLimits(resourceLimits) },
      participantId,
      createdAt: new Date(createdAt).toISOString(),
      coveredAt: { startAt: new Date(coveredAt.startAt).toISOString(), endAt: new Date(coveredAt.endAt).toISOString() },
      compatibility: structuredClone(compatibility), sourceProviders: [...sourceProviders], clientPlatform,
      sourcePlan: summarizeExportSourcePlan(sourcePlan),
      supplementalSourcePlan: summarizeSupplementalSourcePlan(supplementalSourcePlan),
      activityPlan: structuredClone(activityPlan),
    };
    assertDescriptor(descriptor);
    return descriptor;
  }

  return Object.freeze({
    EXPORT_WORKSPACE_VERSION, DEFAULT_EXPORT_WORKSPACE_MAXIMUM_BYTES, DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS,
    EXPORT_WORKSPACE_DATABASE_BASENAME, ExportWorkspaceError, sourceCheckpointBatchSha256,
    supplementalSourceCheckpointBatchSha256, buildExportWorkspaceDescriptor,
    assertDescriptor, assertSourcePlanMatchesDescriptor, assertSupplementalSourcePlanMatchesDescriptor,
    assertCheckpointExpected, assertSupplementalCheckpointExpected, normalizeDiagnosticDeltas, parseCanonical,
    normalizeSupplementalCursorJson, exactKeys, safeCount, validSha256, isCheckpointPhase,
    isSupplementalCheckpointStatus, isReviewedDiagnosticCode,
    stableJson, sha256Hex, platformName, assertValidExportRecord, EXPORT_DIAGNOSTIC_CODES,
    EXPORT_CHECKPOINT_PARSER_VERSION, createEmptyCodexCheckpointState, normalizeCodexCheckpointState,
    serializeCodexCheckpointState, DEFAULT_EXPORT_RESOURCE_LIMITS, EXPORT_RESOURCE_POLICY_VERSION,
    normalizeExportResourceLimits, EXPORT_SOURCE_PLAN_VERSION, summarizeExportSourcePlan,
    assertCanonicalSupplementalCursorJson, createEmptySupplementalSourcePlan,
    EXPORT_SUPPLEMENTAL_SOURCE_PLAN_VERSION, normalizeSupplementalSourcePlan, summarizeSupplementalSourcePlan,
  });
}
