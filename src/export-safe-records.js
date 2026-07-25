import { createHash } from "node:crypto";
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
      outputTextTokens: event.componentAvailability.output_text_tokens ? event.components.output_text_tokens : null,
      outputReasoningTokens: event.componentAvailability.output_reasoning_tokens ? event.components.output_reasoning_tokens : null,
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
  if (scan.parserVersion !== compatibility.providerAdapters.openaiCodex.parserVersion) {
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
