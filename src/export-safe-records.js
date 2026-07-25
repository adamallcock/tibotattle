import { createHash } from "node:crypto";
import { CODEX_COLLECTOR_CANDIDATE_VERSION } from "./codex-collector-export-source.js";
import { validateClaudeStatusSnapshot } from "./claude-statusline.js";
import { scanCodexLogEvents } from "./codex-log-scan.js";
import {
  deriveAccountScopeId,
  deriveEventOccurrenceId,
  deriveMarkerOccurrenceId,
  deriveModelFingerprint,
  deriveQuotaStateId,
  deriveSessionScopeId,
  deriveSnapshotObservationId,
} from "./export-identity.js";
import { exportCompatibilityTuple } from "./export-contract.js";
import { recognizedExportLimitId, recognizedExportModelId } from "./export-registries.js";
import { createExportResourceGuard, ExportResourceLimitError } from "./export-resource-policy.js";
import { assertValidExportRecord } from "./export-schema.js";
import {
  createEmptyCodexCheckpointState,
  normalizeCodexCheckpointState,
} from "./export-checkpoint-state.js";
import { stableJson } from "./storage.js";

const PLAN_TYPES = new Set(["free", "go", "plus", "pro", "business", "enterprise", "edu", "team", "unknown"]);
const PLAN_VARIANTS = new Set(["pro-20x", "pro-10x-promo", "pro-5x", "plus", "unknown"]);
const SESSION_SCOPE_PATTERN = /^session:v1:[A-Za-z0-9_-]{43}$/u;
const ACCOUNT_SCOPE_SUBJECT_PATTERN = /^openai-account:v1:[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MODEL_FINGERPRINT_PATTERN = /^model:v1:[A-Za-z0-9_-]{43}$/u;
const CLAUDE_PHYSICAL_OCCURRENCE_PATTERN = /^claude-ledger-occurrence:v1:[A-Za-z0-9_-]{43}$/u;
const MARKER_SURFACES = new Set([
  "chatgpt_chat", "chatgpt_web", "chatgpt_work", "workspace_agent", "chatgpt_excel",
  "codex_cloud", "codex_other_machine", "chatgpt_work_voice", "ordinary_chat_voice",
  "image_generation", "codex_spark", "other_machine", "voice_mode", "voice_dictation",
  "third_party_client", "quiet_period", "controlled_experiment",
]);
const MARKER_STATES = new Set(["start", "end", "pulse"]);
const POOL_COUPLINGS = new Set([
  "excluded_ordinary_chat", "shared_agentic_pool", "mixed_task_shared_voice_time_separate",
  "shared_agentic_pool_feature_multiplier", "separate_demand_adjusted_model_limit",
  "unknown_client_surface", "unknown_legacy_voice_marker", "depends_on_destination_surface",
  "not_applicable", "depends_on_experiment_surface", "unknown",
]);
const DIAGNOSTIC_CODES = Object.freeze({
  malformedLines: "malformed_lines",
  malformedTimestamps: "malformed_timestamps",
  malformedUsageRecords: "malformed_usage_records",
  missingRateLimitRecords: "missing_rate_limit_records",
  malformedRateLimitRecords: "malformed_rate_limit_records",
  replayedEventsSkipped: "replayed_events_skipped",
  forkReplayEventsSkipped: "fork_replay_events_skipped",
  unattributedForkReplayEventsSkipped: "unattributed_fork_replay_events_skipped",
  replayedToolCallsSkipped: "replayed_tool_calls_skipped",
  lastOnlyEvents: "last_only_events",
  lineageParentsMissing: "lineage_parents_missing",
  malformedTaskEvents: "malformed_task_events",
});

const TOOL_FIELD = Object.freeze({
  web_search: "webSearch",
  file_search: "fileSearch",
  code_interpreter: "codeInterpreter",
  hosted_shell: "hostedShell",
  computer_use: "computerUse",
  mcp: "mcp",
  apply_patch: "applyPatch",
  local_shell: "localShell",
  subagent: "subagent",
  tool_gateway: "toolGateway",
  other: "other",
  unknown: "unknown",
});

export function normalizeExportBounds(startAt, endAt) {
  const start = boundedIso(startAt, "startAt");
  const end = boundedIso(endAt, "endAt");
  if (Date.parse(end) < Date.parse(start)) throw new Error("endAt must not precede startAt");
  return { startAt: start, endAt: end, startMs: Date.parse(start), endMs: Date.parse(end) };
}

function boundedIso(value, field) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function enumOrUnknown(value, allowed) {
  return typeof value === "string" && allowed.has(value.toLowerCase()) ? value.toLowerCase() : "unknown";
}

/**
 * Reduce a raw provider model label to the sole representation allowed in an
 * export or durable parser checkpoint.  Never return the input label.
 */
export function safeExportModelDeclaration(secret, value) {
  const recognized = recognizedExportModelId(value);
  if (recognized) return { modelId: recognized, modelRecognition: "recognized", modelFingerprint: null };
  if (typeof value !== "string" || value.length === 0 || value.toLowerCase() === "unknown") {
    return { modelId: "unknown", modelRecognition: "missing", modelFingerprint: null };
  }
  return {
    modelId: "unknown",
    modelRecognition: "unrecognized",
    modelFingerprint: deriveModelFingerprint(secret, value),
  };
}

/** Return a fresh, closed-shape coarse tool-count accumulator. */
export function createEmptySafeToolClassCounts() {
  return Object.fromEntries(Object.values(TOOL_FIELD).map((field) => [field, 0]));
}

/**
 * Map the scanner's already-classified tool category to a reviewed telemetry
 * field. Unknown and future scanner categories deliberately collapse to the
 * coarse `unknown` bucket, so raw tool names cannot cross this boundary.
 */
export function safeToolCountFieldForScannerToolClass(toolClass) {
  return typeof toolClass === "string" ? (TOOL_FIELD[toolClass] ?? "unknown") : "unknown";
}

function normalizeCheckpointModelDeclaration(value) {
  try {
    const checkpoint = createEmptyCodexCheckpointState();
    checkpoint.currentModel = value;
    return normalizeCodexCheckpointState(checkpoint).currentModel;
  } catch {
    // Do not interpolate a rejected value: it may contain raw log content.
    throw new TypeError("Invalid privacy-safe model declaration");
  }
}

function normalizeProviderModelDeclaration(value) {
  const declaration = assertExactDataKeys(value, ["modelId", "modelRecognition", "modelFingerprint"],
    "Invalid privacy-safe model declaration");
  const recognized = recognizedExportModelId(declaration.modelId);
  const valid = (declaration.modelRecognition === "recognized"
      && recognized === declaration.modelId && declaration.modelFingerprint === null)
    || (declaration.modelRecognition === "missing"
      && declaration.modelId === "unknown" && declaration.modelFingerprint === null)
    || (declaration.modelRecognition === "unrecognized"
      && declaration.modelId === "unknown" && MODEL_FINGERPRINT_PATTERN.test(declaration.modelFingerprint ?? ""));
  if (!valid) throw new TypeError("Invalid privacy-safe model declaration");
  return { ...declaration };
}

function usageModelDeclaration(secret, event) {
  if (Object.hasOwn(event, "modelDeclaration")) {
    // Checkpoint-driven callers must not also pass a raw label.  That keeps
    // the resume boundary unambiguous and avoids retaining a raw canary in an
    // otherwise safe parser event object.
    if (Object.hasOwn(event, "model")) throw new TypeError("Invalid privacy-safe model declaration");
    return normalizeCheckpointModelDeclaration(event.modelDeclaration);
  }
  return safeExportModelDeclaration(secret, event.model);
}

function displayPrecision(value) {
  if (!Number.isFinite(value)) return 0;
  const text = String(value);
  return text.includes(".") ? Math.min(6, text.split(".")[1].length) : 0;
}

function canonicalSubject(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function usageEventIdentitySubject(event) {
  return {
    identityVersion: "codex-source-occurrence-v1",
    provider: "openai_codex",
    sourceFormat: "codex-rollout-jsonl",
    sourceScopeId: event.sourceScopeId,
    sourceRecordOrdinal: event.sourceRecordOrdinal,
    recordKind: "token_count",
  };
}

export function quotaObservationIdentitySubject(event, slot) {
  return {
    identityVersion: "codex-source-occurrence-v1",
    provider: "openai_codex",
    sourceFormat: "codex-rollout-jsonl",
    sourceScopeId: event.sourceScopeId,
    sourceRecordOrdinal: event.sourceRecordOrdinal,
    recordKind: "rate_limit_snapshot",
    slot,
  };
}

export function quotaStateIdentitySubject(snapshot) {
  const subject = {
    provider: snapshot.provider,
    accountScopeId: snapshot.accountScopeId,
    planType: snapshot.planType,
    planVariant: snapshot.planVariant,
    limitId: snapshot.limitId,
    slot: snapshot.slot,
    usedPercent: snapshot.usedPercent,
    displayPrecision: snapshot.displayPrecision,
    windowDurationMinutes: snapshot.windowDurationMinutes,
    resetsAt: snapshot.resetsAt,
    providerSurface: snapshot.providerSurface,
  };
  if (snapshot.accountScopeId === "unattributed") subject.sessionScopeId = snapshot.sessionScopeId;
  return subject;
}

export function normalizeCodexUsageEvent(secret, event, toolClassCounts = createEmptySafeToolClassCounts()) {
  if (!event.sourceScopeId) throw new Error("Missing privacy-safe session scope for usage event");
  const usage = {
    schemaVersion: "usage-event-v0.1",
    eventTime: boundedIso(event.timestamp, "usage event timestamp"),
    provider: "openai_codex",
    ...usageModelDeclaration(secret, event),
    billingSurface: event.tierSemantics?.billingSurface ?? "unknown",
    speedMode: event.tierSemantics?.codexSpeedMode ?? "unknown",
    apiServiceTier: event.tierSemantics?.apiServiceTier ?? "unknown",
    reasoningEffort: "unknown",
    components: {
      inputUncachedTokens: event.componentAvailability.input_uncached_tokens ? event.components.input_uncached_tokens : null,
      inputCacheReadTokens: event.componentAvailability.input_cache_read_tokens ? event.components.input_cache_read_tokens : null,
      inputCacheWriteTokens: event.componentAvailability.input_cache_write_tokens ? event.components.input_cache_write_tokens : null,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
      outputTextTokens: event.componentAvailability.output_text_tokens ? event.components.output_text_tokens : null,
      outputReasoningTokens: event.componentAvailability.output_reasoning_tokens ? event.components.output_reasoning_tokens : null,
      outputCombinedTokens: null,
    },
    totalInputContextTokens: event.rawAvailability.input_tokens ? event.raw.input_tokens : null,
    surface: event.surfaceClassification.surface,
    agentScope: event.surfaceClassification.agentScope,
    lineageDisposition: event.surfaceClassification.lineageDisposition,
    toolClassCounts,
    outcome: "unknown",
    sessionScopeId: event.sourceScopeId,
    accountScopeId: "unattributed",
  };
  usage.eventId = deriveEventOccurrenceId(secret, canonicalSubject(usageEventIdentitySubject(event)));
  assertValidExportRecord("usageEvent", usage);
  return usage;
}

export function normalizeCodexQuotaSnapshot(secret, event) {
  if (!event.sourceScopeId) throw new Error("Missing privacy-safe session scope for quota snapshot");
  const observedTime = boundedIso(event.timestamp, "quota snapshot timestamp");
  const limitId = recognizedExportLimitId(event.window.limitId);
  const snapshot = {
    schemaVersion: "quota-snapshot-v0.1",
    observedTime,
    receivedTime: observedTime,
    provider: "openai_codex",
    planType: enumOrUnknown(event.window.planType, PLAN_TYPES),
    planVariant: "unknown",
    limitId,
    slot: event.window.slot === "primary" || event.window.slot === "secondary" ? event.window.slot : "unknown",
    usedPercent: event.window.usedPercent,
    displayPrecision: displayPrecision(event.window.usedPercent),
    windowDurationMinutes: event.window.windowDurationMins,
    resetsAt: new Date(event.window.resetsAt * 1000).toISOString(),
    snapshotSource: "rollout",
    providerSurface: limitId.includes("spark") ? "separate_limit" : "account_shared_unallocated",
    sessionScopeId: event.sourceScopeId,
    accountScopeId: "unattributed",
  };
  snapshot.snapshotId = deriveSnapshotObservationId(secret, canonicalSubject(quotaObservationIdentitySubject(event, snapshot.slot)));
  snapshot.providerStateId = deriveQuotaStateId(secret, canonicalSubject(quotaStateIdentitySubject(snapshot)));
  assertValidExportRecord("quotaSnapshot", snapshot);
  return snapshot;
}

function assertExactDataKeys(value, keys, code) {
  let ownKeys;
  let prototype;
  try {
    ownKeys = Reflect.ownKeys(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new TypeError(code);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || prototype !== Object.prototype
      || ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== "string")
      || keys.some((key) => !ownKeys.includes(key))) throw new TypeError(code);
  const copy = {};
  for (const key of keys) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new TypeError(code);
    }
    if (!descriptor || !("value" in descriptor)) throw new TypeError(code);
    copy[key] = descriptor.value;
  }
  return copy;
}

function finalizeQuotaSnapshot(secret, snapshot, observationSubject, unattributedOccurrenceMaterial = null) {
  snapshot.snapshotId = deriveSnapshotObservationId(secret, canonicalSubject(observationSubject));
  const stateSubject = quotaStateIdentitySubject(snapshot);
  if (snapshot.accountScopeId === "unattributed" && snapshot.sessionScopeId === null) {
    if (!SHA256_PATTERN.test(unattributedOccurrenceMaterial ?? "")) {
      throw new TypeError("Sessionless unattributed quota normalization requires occurrence material");
    }
    stateSubject.unattributedOccurrenceMaterial = unattributedOccurrenceMaterial;
  }
  snapshot.providerStateId = deriveQuotaStateId(secret, canonicalSubject(stateSubject));
  assertValidExportRecord("quotaSnapshot", snapshot);
  return snapshot;
}

/**
 * Convert one already privacy-reduced collector candidate into the canonical
 * quota contract. Sessionless unattributed observations are retained, but
 * their provider-state identity includes occurrence material so observations
 * from unknown accounts cannot collapse into one apparent shared state.
 */
export function normalizeCodexCollectorQuotaCandidate(secret, candidate) {
  const keys = [
    "candidateVersion", "kind", "provider", "observedTime", "receivedTime", "source",
    "planType", "limitId", "slot", "usedPercent", "displayPrecision",
    "windowDurationMinutes", "resetsAt", "sharedPoolSurface", "accountScopeSubject",
    "sessionScopeId", "observationIdentityMaterial",
  ];
  candidate = assertExactDataKeys(candidate, keys, "Invalid privacy-safe collector quota candidate");
  if (candidate.candidateVersion !== CODEX_COLLECTOR_CANDIDATE_VERSION
      || candidate.kind !== "quota_snapshot_candidate"
      || candidate.provider !== "openai_codex"
      || !["app_server_read", "app_server_notification"].includes(candidate.source)
      || candidate.sharedPoolSurface !== "account_shared_unallocated"
      || candidate.sessionScopeId !== null
      || (candidate.accountScopeSubject !== "unattributed"
        && !ACCOUNT_SCOPE_SUBJECT_PATTERN.test(candidate.accountScopeSubject ?? ""))
      || !SHA256_PATTERN.test(candidate.observationIdentityMaterial ?? "")
      || !PLAN_TYPES.has(candidate.planType)
      || !["codex", "codex-spark"].includes(candidate.limitId)
      || !["primary", "secondary"].includes(candidate.slot)
      || !Number.isFinite(candidate.usedPercent) || candidate.usedPercent < 0 || candidate.usedPercent > 100
      || !Number.isSafeInteger(candidate.displayPrecision) || candidate.displayPrecision < 0 || candidate.displayPrecision > 6
      || candidate.displayPrecision !== displayPrecision(candidate.usedPercent)
      || !Number.isSafeInteger(candidate.windowDurationMinutes) || candidate.windowDurationMinutes < 1
      || candidate.windowDurationMinutes > 525_600
      || boundedIso(candidate.observedTime, "collector quota observedTime") !== candidate.observedTime
      || boundedIso(candidate.receivedTime, "collector quota receivedTime") !== candidate.receivedTime
      || Date.parse(candidate.receivedTime) < Date.parse(candidate.observedTime)
      || boundedIso(candidate.resetsAt, "collector quota resetsAt") !== candidate.resetsAt) {
    throw new TypeError("Invalid privacy-safe collector quota candidate");
  }
  const accountScopeId = deriveAccountScopeId(secret, candidate.accountScopeSubject);
  const snapshot = {
    schemaVersion: "quota-snapshot-v0.1",
    observedTime: candidate.observedTime,
    receivedTime: candidate.receivedTime,
    provider: "openai_codex",
    planType: candidate.planType,
    planVariant: "unknown",
    limitId: candidate.limitId,
    slot: candidate.slot,
    usedPercent: candidate.usedPercent,
    displayPrecision: candidate.displayPrecision,
    windowDurationMinutes: candidate.windowDurationMinutes,
    resetsAt: candidate.resetsAt,
    snapshotSource: candidate.source === "app_server_notification" ? "notification" : "app_server_read",
    providerSurface: "account_shared_unallocated",
    sessionScopeId: null,
    accountScopeId,
  };
  return finalizeQuotaSnapshot(secret, snapshot, {
    identityVersion: "codex-collector-safe-occurrence-v0.1",
    provider: "openai_codex",
    observationIdentityMaterial: candidate.observationIdentityMaterial,
  }, candidate.observationIdentityMaterial);
}

/**
 * Convert an already privacy-reduced Claude transcript candidate into the
 * canonical usage contract. Claude reports one combined output-token total;
 * this adapter preserves it without inventing visible-text or reasoning
 * components.
 */
export function normalizeClaudeTranscriptUsageCandidate(secret, candidate) {
  const keys = [
    "candidateVersion", "provider", "eventTime", "modelDeclaration", "billingSurface",
    "speedMode", "components", "totalInputContextTokens", "surface", "agentScope",
    "lineageDisposition", "toolClassCounts", "sessionScopeId", "occurrenceMaterial",
  ];
  candidate = assertExactDataKeys(candidate, keys, "Invalid privacy-safe Claude transcript usage candidate");
  const components = assertExactDataKeys(candidate.components, [
    "inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens", "inputCacheWrite5mTokens",
    "inputCacheWrite1hTokens", "outputCombinedTokens",
  ], "Invalid privacy-safe Claude transcript usage candidate");
  const scannerCounts = assertExactDataKeys(candidate.toolClassCounts, Object.keys(TOOL_FIELD),
    "Invalid privacy-safe Claude transcript usage candidate");
  const modelDeclaration = normalizeProviderModelDeclaration(candidate.modelDeclaration);
  const tokenValues = [
    components.inputUncachedTokens, components.inputCacheReadTokens,
    components.inputCacheWriteTokens, components.outputCombinedTokens,
    candidate.totalInputContextTokens,
  ];
  if (candidate.candidateVersion !== "claude-transcript-usage-candidate-v0.2"
      || candidate.provider !== "anthropic_claude_code"
      || candidate.billingSurface !== "claude_subscription"
      || !["standard", "fast", "unknown", "other"].includes(candidate.speedMode)
      || !["subagent", "local_interactive_unclassified"].includes(candidate.surface)
      || !["root", "subagent"].includes(candidate.agentScope)
      || !["standalone", "parent_linked"].includes(candidate.lineageDisposition)
      || !SESSION_SCOPE_PATTERN.test(candidate.sessionScopeId ?? "")
      || !SHA256_PATTERN.test(candidate.occurrenceMaterial ?? "")
      || boundedIso(candidate.eventTime, "Claude transcript usage event time") !== candidate.eventTime
      || tokenValues.some((value) => !Number.isSafeInteger(value) || value < 0)
      || (components.inputCacheWrite5mTokens !== null
        && (!Number.isSafeInteger(components.inputCacheWrite5mTokens)
          || components.inputCacheWrite5mTokens < 0))
      || (components.inputCacheWrite1hTokens !== null
        && (!Number.isSafeInteger(components.inputCacheWrite1hTokens)
          || components.inputCacheWrite1hTokens < 0))
      || ((components.inputCacheWrite5mTokens === null) !== (components.inputCacheWrite1hTokens === null))
      || (components.inputCacheWrite5mTokens !== null
        && components.inputCacheWrite5mTokens + components.inputCacheWrite1hTokens
          !== components.inputCacheWriteTokens)
      || candidate.totalInputContextTokens !== components.inputUncachedTokens
        + components.inputCacheReadTokens + components.inputCacheWriteTokens
      || Object.values(scannerCounts).some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000)) {
    throw new TypeError("Invalid privacy-safe Claude transcript usage candidate");
  }
  const toolClassCounts = createEmptySafeToolClassCounts();
  for (const [scannerClass, count] of Object.entries(scannerCounts)) {
    toolClassCounts[safeToolCountFieldForScannerToolClass(scannerClass)] += count;
  }
  const usage = {
    schemaVersion: "usage-event-v0.1",
    eventTime: candidate.eventTime,
    provider: "anthropic_claude_code",
    ...modelDeclaration,
    billingSurface: "claude_subscription",
    speedMode: candidate.speedMode,
    apiServiceTier: "unknown",
    reasoningEffort: "unknown",
    components: {
      inputUncachedTokens: components.inputUncachedTokens,
      inputCacheReadTokens: components.inputCacheReadTokens,
      inputCacheWriteTokens: components.inputCacheWriteTokens,
      inputCacheWrite5mTokens: components.inputCacheWrite5mTokens,
      inputCacheWrite1hTokens: components.inputCacheWrite1hTokens,
      outputTextTokens: null,
      outputReasoningTokens: null,
      outputCombinedTokens: components.outputCombinedTokens,
    },
    totalInputContextTokens: candidate.totalInputContextTokens,
    surface: candidate.surface,
    agentScope: candidate.agentScope,
    lineageDisposition: candidate.lineageDisposition,
    toolClassCounts,
    outcome: "unknown",
    sessionScopeId: candidate.sessionScopeId,
    accountScopeId: "unattributed",
  };
  usage.eventId = deriveEventOccurrenceId(secret, candidate.occurrenceMaterial);
  assertValidExportRecord("usageEvent", usage);
  return usage;
}

/**
 * Convert a validated Claude status-line record into zero, one, or two quota
 * snapshots. A captured session pseudonym is mandatory because Claude status
 * records currently contain no account identifier that could safely scope an
 * unattributed provider-state identity.
 */
export function normalizeClaudeStatusQuotaSnapshots(secret, value, { physicalOccurrenceMaterial } = {}) {
  const status = validateClaudeStatusSnapshot(value);
  const windows = [
    ["fiveHour", "five_hour"],
    ["sevenDay", "seven_day"],
  ];
  // A valid pre-response status-line record may contain no quota windows. It
  // contributes no export records and therefore needs neither session scope
  // nor physical-occurrence identity. Window-bearing records remain
  // fail-closed when they cannot be scoped safely.
  if (windows.every(([sourceKey]) => status.limits[sourceKey] === null)) return [];
  if (status.sessionPseudonym === null) {
    throw new TypeError("Claude quota normalization requires a privacy-safe session pseudonym");
  }
  if (typeof physicalOccurrenceMaterial !== "string"
      || !CLAUDE_PHYSICAL_OCCURRENCE_PATTERN.test(physicalOccurrenceMaterial)) {
    throw new TypeError("Claude quota normalization requires privacy-safe physical occurrence material");
  }
  const sessionScopeId = deriveSessionScopeId(secret, status.sessionPseudonym);
  if (!SESSION_SCOPE_PATTERN.test(sessionScopeId)) {
    throw new TypeError("Claude quota normalization requires a privacy-safe session pseudonym");
  }
  return windows.flatMap(([sourceKey, slot]) => {
    const window = status.limits[sourceKey];
    if (window === null) return [];
    const snapshot = {
      schemaVersion: "quota-snapshot-v0.1",
      observedTime: status.capturedAt,
      receivedTime: status.capturedAt,
      provider: "anthropic_claude_code",
      planType: "unknown",
      planVariant: "unknown",
      limitId: "unknown",
      slot,
      usedPercent: window.usedPercent,
      displayPrecision: displayPrecision(window.usedPercent),
      windowDurationMinutes: window.windowMinutes,
      resetsAt: new Date(window.resetsAt * 1000).toISOString(),
      snapshotSource: "status_line",
      providerSurface: "general_usage",
      sessionScopeId,
      accountScopeId: "unattributed",
    };
    return [finalizeQuotaSnapshot(secret, snapshot, {
      identityVersion: "claude-statusline-safe-occurrence-v0.1",
      provider: "anthropic_claude_code",
      capturedAt: status.capturedAt,
      sessionScopeId,
      slot,
      physicalOccurrenceMaterial,
    })];
  });
}

export function normalizeActivityMarker(secret, marker, bounds) {
  const observedTime = boundedIso(marker?.observedAt, "activity marker observedAt");
  const observedMs = Date.parse(observedTime);
  if (observedMs < bounds.startMs || observedMs > bounds.endMs) return null;
  if (!MARKER_SURFACES.has(marker?.surface) || !MARKER_STATES.has(marker?.state)) return null;
  if (typeof marker?.markerId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker.markerId)) {
    throw new Error("Activity marker requires a persisted UUID source identifier");
  }
  const agenticPoolCoupling = POOL_COUPLINGS.has(marker?.agenticPoolCoupling)
    ? marker.agenticPoolCoupling
    : "unknown";
  const accountSubject = marker?.accountScope?.status === "available" && typeof marker.accountScope.scopeId === "string"
    ? marker.accountScope.scopeId
    : "unattributed";
  const safe = {
    schemaVersion: "export-activity-marker-v0.1",
    observedTime,
    surface: marker.surface,
    state: marker.state,
    agenticPoolCoupling,
    planType: enumOrUnknown(marker?.planType, PLAN_TYPES),
    planVariant: enumOrUnknown(marker?.planVariant, PLAN_VARIANTS),
    accountScopeId: deriveAccountScopeId(secret, accountSubject),
  };
  safe.markerId = deriveMarkerOccurrenceId(secret, marker.markerId);
  assertValidExportRecord("activityMarker", safe);
  return safe;
}

export function summarizeActivityMarkerPlan(secret, activityMarkers, bounds) {
  if (!Array.isArray(activityMarkers)) throw new TypeError("Activity markers must be an array");
  const recordsById = new Map();
  for (const marker of activityMarkers) {
    const record = normalizeActivityMarker(secret, marker, bounds);
    if (!record) continue;
    const canonical = stableJson(record);
    const existing = recordsById.get(record.markerId);
    if (existing !== undefined && existing !== canonical) {
      throw new Error("Activity marker occurrence conflicts with an existing marker");
    }
    recordsById.set(record.markerId, canonical);
  }
  const records = [...recordsById.values()]
    .map((value) => JSON.parse(value))
    .sort((left, right) => left.observedTime.localeCompare(right.observedTime)
      || left.markerId.localeCompare(right.markerId));
  const digest = createHash("sha256")
    .update("app-usagemonitor/export-activity-plan/v1\0")
    .update(stableJson(records))
    .digest("hex");
  return { recordCount: records.length, recordsSha256: digest };
}

export function diagnosticsFromCodexScan(scan, leftoverToolCalls = 0) {
  const codes = Object.entries(DIAGNOSTIC_CODES)
    .map(([source, code]) => ({ code, count: Number(scan?.diagnostics?.[source] ?? 0) }))
    .filter((entry) => Number.isSafeInteger(entry.count) && entry.count > 0);
  if (leftoverToolCalls > 0) codes.push({ code: "unattached_tool_calls", count: leftoverToolCalls });
  return {
    sourceFilesScanned: Number(scan?.diagnostics?.filesScanned ?? 0),
    codes: codes.sort((left, right) => left.code.localeCompare(right.code)),
  };
}

async function emitSafeRecord(onRecord, resourceGuard, recordType, record) {
  resourceGuard.observeOutputRecord(Buffer.byteLength(stableJson(record), "utf8"));
  await onRecord({ recordType, record });
}

/**
 * Convert Codex rollout records and optional local activity markers into the
 * provider-neutral, validated safe-record contract. The sink is awaited so a
 * durable caller can commit a bounded batch before scanning continues; source
 * content is never exposed through this interface.
 */
export async function scanCodexSafeRecords({
  startAt,
  endAt,
  codexHome,
  secret,
  activityMarkers = [],
  onRecord,
  resourceGuard = createExportResourceGuard(),
  rolloutInfos = null,
  openRolloutSource = null,
  verifyRolloutSource = null,
} = {}) {
  if (!secret) throw new Error("A participant export secret is required");
  if (typeof onRecord !== "function") throw new TypeError("A safe-record sink is required");
  if (!Array.isArray(activityMarkers)) throw new TypeError("Activity markers must be an array");
  const bounds = normalizeExportBounds(startAt, endAt);
  resourceGuard.assertCoveredInterval(bounds.startMs, bounds.endMs);
  if (activityMarkers.length > resourceGuard.limits.maximumOutputRecords) {
    throw new ExportResourceLimitError("output_records");
  }

  const toolCountsBySession = new Map();
  const scan = await scanCodexLogEvents({
    startAt: bounds.startAt,
    endAt: bounds.endAt,
    codexHome,
    sourceScopeForRollout: (rawScope) => deriveSessionScopeId(secret, rawScope),
    onToolCall(event) {
      if (!event.sourceScopeId) throw new Error("Missing privacy-safe session scope for tool event");
      const counts = toolCountsBySession.get(event.sourceScopeId) ?? createEmptySafeToolClassCounts();
      counts[safeToolCountFieldForScannerToolClass(event.toolClass)] += 1;
      toolCountsBySession.set(event.sourceScopeId, counts);
    },
    async onUsage(event) {
      const toolClassCounts = toolCountsBySession.get(event.sourceScopeId) ?? createEmptySafeToolClassCounts();
      toolCountsBySession.delete(event.sourceScopeId);
      await emitSafeRecord(onRecord, resourceGuard, "usageEvent", normalizeCodexUsageEvent(secret, event, toolClassCounts));
    },
    async onRateLimitSnapshot(event) {
      await emitSafeRecord(onRecord, resourceGuard, "quotaSnapshot", normalizeCodexQuotaSnapshot(secret, event));
    },
    resourceGuard,
    rolloutInfos,
    openRolloutSource,
    verifyRolloutSource,
  });

  const compatibility = exportCompatibilityTuple();
  if (scan.parserVersion !== compatibility.providerAdapters.openaiCodex.sourceFormats.rollout.parserVersion) {
    throw new Error("Codex scanner version does not match the export compatibility contract");
  }
  for (const marker of activityMarkers) {
    const normalized = normalizeActivityMarker(secret, marker, bounds);
    if (normalized) await emitSafeRecord(onRecord, resourceGuard, "activityMarker", normalized);
  }

  const leftoverToolCalls = [...toolCountsBySession.values()]
    .reduce((total, counts) => total + Object.values(counts).reduce((sum, count) => sum + count, 0), 0);
  return {
    parserVersion: scan.parserVersion,
    bounds,
    diagnostics: diagnosticsFromCodexScan(scan, leftoverToolCalls),
  };
}
