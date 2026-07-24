import { createHash } from "node:crypto";
import { platform } from "node:os";
import { resolve } from "node:path";
import { scanCodexLogEvents } from "./codex-log-scan.js";
import {
  deriveAccountScopeId,
  deriveEventId,
  deriveMarkerId,
  deriveModelFingerprint,
  deriveParticipantId,
  deriveSessionScopeId,
  deriveSnapshotId,
  randomBundleId,
} from "./export-identity.js";
import { verifyPrivacySafeBundle } from "./export-privacy.js";
import { assertValidExportRecord } from "./export-schema.js";
import { stableJson, writeJsonOwnerOnlyAtomic } from "./storage.js";

const KNOWN_MODEL_PATTERN = /^(?:gpt-[a-z0-9][a-z0-9._-]{0,62}|o[0-9][a-z0-9._-]{0,62}|codex-[a-z0-9][a-z0-9._-]{0,62}|claude-[a-z0-9][a-z0-9._-]{0,62})$/;
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

function boundedIso(value, field) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function validateBounds(startAt, endAt) {
  const start = boundedIso(startAt, "startAt");
  const end = boundedIso(endAt, "endAt");
  if (Date.parse(end) < Date.parse(start)) throw new Error("endAt must not precede startAt");
  return { startAt: start, endAt: end, startMs: Date.parse(start), endMs: Date.parse(end) };
}

function enumOrUnknown(value, allowed) {
  return typeof value === "string" && allowed.has(value.toLowerCase()) ? value.toLowerCase() : "unknown";
}

function safeLimitId(value) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "unknown";
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : "unknown";
}

function modelDeclaration(secret, value) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "unknown";
  if (KNOWN_MODEL_PATTERN.test(normalized)) return { modelId: normalized, modelFingerprint: null };
  return {
    modelId: "unknown",
    modelFingerprint: deriveModelFingerprint(secret, typeof value === "string" && value.length ? value : "unknown"),
  };
}

function emptyToolCounts() {
  return Object.fromEntries(Object.values(TOOL_FIELD).map((field) => [field, 0]));
}

function displayPrecision(value) {
  if (!Number.isFinite(value)) return 0;
  const text = String(value);
  return text.includes(".") ? Math.min(6, text.split(".")[1].length) : 0;
}

function platformName() {
  if (platform() === "darwin") return "macos";
  if (platform() === "linux") return "linux";
  if (platform() === "win32") return "windows";
  return "other";
}

function canonicalSubject(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizeActivityMarker(secret, marker, bounds) {
  const observedTime = boundedIso(marker?.observedAt, "activity marker observedAt");
  const observedMs = Date.parse(observedTime);
  if (observedMs < bounds.startMs || observedMs > bounds.endMs) return null;
  if (!MARKER_SURFACES.has(marker?.surface) || !MARKER_STATES.has(marker?.state)) return null;
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
  safe.markerId = deriveMarkerId(secret, canonicalSubject({
    ...safe,
    sourceMarkerOrdinal: typeof marker?.markerId === "string" ? marker.markerId : "missing",
  }));
  assertValidExportRecord("activityMarker", safe);
  return safe;
}

function diagnosticsFromScan(scan, leftoverToolCalls) {
  const codes = Object.entries(DIAGNOSTIC_CODES)
    .map(([source, code]) => ({ code, count: Number(scan?.diagnostics?.[source] ?? 0) }))
    .filter((entry) => Number.isSafeInteger(entry.count) && entry.count > 0);
  if (leftoverToolCalls > 0) codes.push({ code: "unattached_tool_calls", count: leftoverToolCalls });
  return {
    sourceFilesScanned: Number(scan?.diagnostics?.filesScanned ?? 0),
    codes: codes.sort((left, right) => left.code.localeCompare(right.code)),
  };
}

export async function buildLocalMetadataBundle({
  startAt,
  endAt,
  codexHome,
  secret,
  activityMarkers = [],
  createdAt = new Date().toISOString(),
  bundleId = randomBundleId(),
  forbiddenSourceValues = [],
} = {}) {
  if (!secret) throw new Error("A participant export secret is required");
  const bounds = validateBounds(startAt, endAt);
  const usageEvents = [];
  const quotaSnapshotsById = new Map();
  const toolCountsBySession = new Map();

  const scan = await scanCodexLogEvents({
    startAt: bounds.startAt,
    endAt: bounds.endAt,
    codexHome,
    sourceScopeForRollout: (rawScope) => deriveSessionScopeId(secret, rawScope),
    onToolCall(event) {
      if (!event.sourceScopeId) throw new Error("Missing privacy-safe session scope for tool event");
      const counts = toolCountsBySession.get(event.sourceScopeId) ?? emptyToolCounts();
      counts[TOOL_FIELD[event.toolClass] ?? "unknown"] += 1;
      toolCountsBySession.set(event.sourceScopeId, counts);
    },
    onUsage(event) {
      if (!event.sourceScopeId) throw new Error("Missing privacy-safe session scope for usage event");
      const model = modelDeclaration(secret, event.model);
      const toolClassCounts = toolCountsBySession.get(event.sourceScopeId) ?? emptyToolCounts();
      toolCountsBySession.delete(event.sourceScopeId);
      const usage = {
        schemaVersion: "usage-event-v0.1",
        eventTime: boundedIso(event.timestamp, "usage event timestamp"),
        provider: "openai_codex",
        ...model,
        billingSurface: event.tierSemantics?.billingSurface ?? "unknown",
        speedMode: event.tierSemantics?.codexSpeedMode ?? "unknown",
        apiServiceTier: event.tierSemantics?.apiServiceTier ?? "unknown",
        reasoningEffort: "unknown",
        components: {
          inputUncachedTokens: event.components.input_uncached_tokens,
          inputCacheReadTokens: event.components.input_cache_read_tokens,
          inputCacheWriteTokens: event.components.input_cache_write_tokens,
          outputTextTokens: event.components.output_text_tokens,
          outputReasoningTokens: event.components.output_reasoning_tokens,
        },
        totalInputContextTokens: event.raw.input_tokens,
        surface: event.surfaceClassification.surface,
        agentScope: event.surfaceClassification.agentScope,
        lineageDisposition: event.surfaceClassification.lineageDisposition,
        toolClassCounts,
        outcome: "unknown",
        sessionScopeId: event.sourceScopeId,
        accountScopeId: "unattributed",
      };
      usage.eventId = deriveEventId(secret, canonicalSubject(usage));
      assertValidExportRecord("usageEvent", usage);
      usageEvents.push(usage);
    },
    onRateLimitSnapshot(event) {
      if (!event.sourceScopeId) throw new Error("Missing privacy-safe session scope for quota snapshot");
      const observedTime = boundedIso(event.timestamp, "quota snapshot timestamp");
      const limitId = safeLimitId(event.window.limitId);
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
      snapshot.snapshotId = deriveSnapshotId(secret, canonicalSubject(snapshot));
      assertValidExportRecord("quotaSnapshot", snapshot);
      quotaSnapshotsById.set(snapshot.snapshotId, snapshot);
    },
  });

  const safeMarkers = activityMarkers
    .map((marker) => normalizeActivityMarker(secret, marker, bounds))
    .filter(Boolean)
    .sort((left, right) => left.observedTime.localeCompare(right.observedTime) || left.markerId.localeCompare(right.markerId));
  usageEvents.sort((left, right) => left.eventTime.localeCompare(right.eventTime) || left.eventId.localeCompare(right.eventId));
  const quotaSnapshots = [...quotaSnapshotsById.values()]
    .sort((left, right) => left.observedTime.localeCompare(right.observedTime) || left.snapshotId.localeCompare(right.snapshotId));
  const leftoverToolCalls = [...toolCountsBySession.values()]
    .reduce((total, counts) => total + Object.values(counts).reduce((sum, count) => sum + count, 0), 0);
  const recordCounts = {
    usageEvents: usageEvents.length,
    quotaSnapshots: quotaSnapshots.length,
    activityMarkers: safeMarkers.length,
  };
  const bundle = {
    schemaVersion: "usage-metadata-bundle-v0.1",
    exporterVersion: "0.1.0",
    bundleId,
    participantId: deriveParticipantId(secret),
    createdAt: boundedIso(createdAt, "createdAt"),
    coveredAt: { startAt: bounds.startAt, endAt: bounds.endAt },
    consentVersion: "local-dry-run-v0.1",
    sourceProviders: ["openai_codex"],
    clientPlatform: platformName(),
    transportReady: false,
    recordCounts,
    records: { usageEvents, quotaSnapshots, activityMarkers: safeMarkers },
    diagnostics: diagnosticsFromScan(scan, leftoverToolCalls),
  };
  assertValidExportRecord("bundle", bundle);
  const receipt = verifyPrivacySafeBundle(bundle, { createdAt: bundle.createdAt, forbiddenSourceValues });
  return { bundle, receipt };
}

export function renderMetadataExportPreview({ bundle, receipt }) {
  const checks = receipt.checks.map((check) => `  ${check.code}: ${check.status} (${check.violations})`).join("\n");
  return [
    "Local metadata export preview",
    `Coverage: ${bundle.coveredAt.startAt} to ${bundle.coveredAt.endAt}`,
    `Usage events: ${bundle.recordCounts.usageEvents}`,
    `Quota snapshots: ${bundle.recordCounts.quotaSnapshots}`,
    `Activity markers: ${bundle.recordCounts.activityMarkers}`,
    `Source files scanned: ${bundle.diagnostics.sourceFilesScanned}`,
    `Privacy verdict: ${receipt.verdict}`,
    checks,
    `Bundle bytes: ${receipt.bundleBytes}`,
    "Upload: disabled (transportReady=false)",
  ].join("\n");
}

export async function writeLocalMetadataBundle({ bundle, receipt, outputFile, receiptFile } = {}) {
  if (!outputFile || !receiptFile) throw new Error("outputFile and receiptFile are required");
  const output = resolve(outputFile);
  const receiptOutput = resolve(receiptFile);
  await writeJsonOwnerOnlyAtomic(output, bundle);
  await writeJsonOwnerOnlyAtomic(receiptOutput, receipt);
  return { outputFile: output, receiptFile: receiptOutput };
}
