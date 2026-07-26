import {
  TELEMETRY_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_ENVELOPE_SCHEMA_VERSION,
} from "./constants";
import { ApiError } from "./errors";

type JsonRecord = Record<string, unknown>;

export interface TelemetryEnvelope {
  schemaVersion: typeof TELEMETRY_ENVELOPE_SCHEMA_VERSION;
  synthetic: false;
  keyId: string;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
}

export interface UsageAccounting {
  estimatedApiCostUsd: string | null;
  pricingCoveragePercent: number;
  unknownBillableUnits: number;
  priceBasis: "current_api_prices" | "historical_api_prices" | "unpriced";
}

export interface TelemetryUsageEvent {
  schemaVersion: "usage-event-v0.1";
  eventTime: string;
  provider: "openai_codex" | "anthropic_claude_code";
  modelId: string;
  modelRecognition: "recognized" | "unrecognized" | "missing";
  modelFingerprint: string | null;
  billingSurface: "chatgpt_subscription" | "openai_api" | "claude_subscription" | "unknown";
  speedMode: "standard" | "fast" | "unknown" | "other";
  apiServiceTier: "standard" | "priority" | "flex" | "batch" | "unknown" | "other";
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "unknown";
  components: {
    inputUncachedTokens: number | null;
    inputCacheReadTokens: number | null;
    inputCacheWriteTokens: number | null;
    inputCacheWrite5mTokens: number | null;
    inputCacheWrite1hTokens: number | null;
    outputTextTokens: number | null;
    outputReasoningTokens: number | null;
    outputCombinedTokens: number | null;
  };
  totalInputContextTokens: number | null;
  surface: "scheduled_task" | "subagent" | "extension_or_ide" | "cli_exec"
    | "local_interactive_unclassified" | "local_rollout_unclassified";
  agentScope: "root" | "subagent" | "automation" | "unknown";
  lineageDisposition: "standalone" | "forked" | "parent_linked";
  toolClassCounts: Record<ToolClass, number>;
  outcome: "completed" | "failed" | "cancelled" | "interrupted" | "retry" | "unknown";
  eventId: string;
  accounting: UsageAccounting;
}

export interface TelemetryQuotaSnapshot {
  schemaVersion: "quota-snapshot-v0.1";
  observedTime: string;
  receivedTime: string;
  provider: "openai_codex" | "anthropic_claude_code";
  planType: "free" | "go" | "plus" | "pro" | "business" | "enterprise" | "edu" | "team" | "unknown";
  planVariant: "pro-20x" | "pro-10x-promo" | "pro-5x" | "plus" | "unknown";
  limitId: "unknown" | "codex" | "codex-spark";
  slot: "primary" | "secondary" | "five_hour" | "seven_day" | "other" | "unknown";
  usedPercent: number;
  displayPrecision: number;
  windowDurationMinutes: number;
  resetsAt: string;
  snapshotSource: "rollout" | "app_server_read" | "status_line" | "ui_declaration" | "notification";
  providerSurface: "account_shared_unallocated" | "general_usage" | "model_specific" | "separate_limit" | "unknown";
  snapshotId: string;
}

export interface TelemetryActivityMarker {
  schemaVersion: "export-activity-marker-v0.1";
  observedTime: string;
  surface: string;
  state: "start" | "end" | "pulse";
  agenticPoolCoupling: string;
  planType: TelemetryQuotaSnapshot["planType"];
  planVariant: TelemetryQuotaSnapshot["planVariant"];
  markerId: string;
}

export interface TelemetryContribution {
  schemaVersion: typeof TELEMETRY_CONTRIBUTION_SCHEMA_VERSION;
  synthetic: false;
  createdAt: string;
  coveredAt: { startAt: string; endAt: string };
  clientPlatform: "macos" | "linux" | "windows" | "other" | "unknown";
  providerPolicyEpoch: "unknown" | "openai_pre_agentic_pool_2026_07_09"
    | "openai_agentic_pool_2026_07_09" | "anthropic_unknown";
  usageEvents: TelemetryUsageEvent[];
  quotaSnapshots: TelemetryQuotaSnapshot[];
  activityMarkers: TelemetryActivityMarker[];
  accounting: {
    estimatedApiCostUsd: string | null;
    pricedEventCoveragePercent: number;
    unknownModelEventCount: number;
    unknownBillableUnits: number;
    priceBasis: UsageAccounting["priceBasis"];
  };
}

const TOOL_CLASSES = [
  "webSearch", "fileSearch", "codeInterpreter", "hostedShell", "computerUse", "mcp",
  "applyPatch", "localShell", "subagent", "toolGateway", "other", "unknown",
] as const;
type ToolClass = typeof TOOL_CLASSES[number];

const MODEL_IDS = new Set([
  "unknown", "gpt-4.1", "gpt-5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5",
  "gpt-5.5-codex", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
  "claude-fable-5", "claude-haiku-4-5-20251001", "claude-opus-4-8",
  "claude-sonnet-4-6", "claude-sonnet-5",
]);
const OPENAI_MODELS = new Set([...MODEL_IDS].filter((value) => value === "unknown" || value.startsWith("gpt-")));
const CLAUDE_MODELS = new Set([...MODEL_IDS].filter((value) => value === "unknown" || value.startsWith("claude-")));
const ACTIVITY_SURFACES = new Set([
  "chatgpt_chat", "chatgpt_web", "chatgpt_work", "workspace_agent", "chatgpt_excel",
  "codex_cloud", "codex_other_machine", "chatgpt_work_voice", "ordinary_chat_voice",
  "image_generation", "codex_spark", "other_machine", "voice_mode", "voice_dictation",
  "third_party_client", "quiet_period", "controlled_experiment",
]);
const POOL_COUPLINGS = new Set([
  "excluded_ordinary_chat", "shared_agentic_pool", "mixed_task_shared_voice_time_separate",
  "shared_agentic_pool_feature_multiplier", "separate_demand_adjusted_model_limit",
  "unknown_client_surface", "unknown_legacy_voice_marker", "depends_on_destination_surface",
  "not_applicable", "depends_on_experiment_surface", "unknown",
]);

function invalid(code: "ENVELOPE_INVALID" | "TELEMETRY_RECORD_INVALID" | "PRIVACY_CANARY_DETECTED"): never {
  throw new ApiError(400, code);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is JsonRecord {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function instant(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function bounded(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function nullableInteger(value: unknown): value is number | null {
  return value === null || integer(value);
}

function money(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^(?:0|[1-9]\d{0,8})\.\d{6}$/u.test(value));
}

function hashId(value: unknown, prefix: string): value is string {
  return typeof value === "string"
    && new RegExp(`^${prefix}:(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$`, "u").test(value);
}

function base64Url(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max
    && /^[A-Za-z0-9_-]+$/u.test(value);
}

export function validateTelemetryEnvelope(value: unknown): TelemetryEnvelope {
  if (!exact(value, ["schemaVersion", "synthetic", "keyId", "wrappedKey", "iv", "ciphertext"])
      || value.schemaVersion !== TELEMETRY_ENVELOPE_SCHEMA_VERSION
      || value.synthetic !== false
      || typeof value.keyId !== "string"
      || !/^key:[A-Za-z0-9._-]{1,64}$/u.test(value.keyId)
      || !base64Url(value.wrappedKey, 342, 342)
      || !base64Url(value.iv, 16, 16)
      || !base64Url(value.ciphertext, 16, 2_000_000)) {
    invalid("ENVELOPE_INVALID");
  }
  return value as unknown as TelemetryEnvelope;
}

function validateAccounting(value: unknown): value is UsageAccounting {
  return exact(value, [
    "estimatedApiCostUsd", "pricingCoveragePercent", "unknownBillableUnits", "priceBasis",
  ])
    && money(value.estimatedApiCostUsd)
    && bounded(value.pricingCoveragePercent, 0, 100)
    && integer(value.unknownBillableUnits, 1_000_000_000)
    && member(value.priceBasis, ["current_api_prices", "historical_api_prices", "unpriced"]);
}

function validateUsage(value: unknown): value is TelemetryUsageEvent {
  if (!exact(value, [
    "schemaVersion", "eventTime", "provider", "modelId", "modelRecognition",
    "modelFingerprint", "billingSurface", "speedMode", "apiServiceTier", "reasoningEffort",
    "components", "totalInputContextTokens", "surface", "agentScope", "lineageDisposition",
    "toolClassCounts", "outcome", "eventId", "accounting",
  ])
      || value.schemaVersion !== "usage-event-v0.1"
      || !instant(value.eventTime)
      || !member(value.provider, ["openai_codex", "anthropic_claude_code"])
      || typeof value.modelId !== "string" || !MODEL_IDS.has(value.modelId)
      || !member(value.modelRecognition, ["recognized", "unrecognized", "missing"])
      || !(value.modelFingerprint === null
        || hashId(value.modelFingerprint, "model:v1"))
      || !member(value.billingSurface, ["chatgpt_subscription", "openai_api", "claude_subscription", "unknown"])
      || !member(value.speedMode, ["standard", "fast", "unknown", "other"])
      || !member(value.apiServiceTier, ["standard", "priority", "flex", "batch", "unknown", "other"])
      || !member(value.reasoningEffort, ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown"])
      || !exact(value.components, [
        "inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens",
        "inputCacheWrite5mTokens", "inputCacheWrite1hTokens", "outputTextTokens",
        "outputReasoningTokens", "outputCombinedTokens",
      ])
      || !Object.values(value.components).every(nullableInteger)
      || !nullableInteger(value.totalInputContextTokens)
      || !member(value.surface, [
        "scheduled_task", "subagent", "extension_or_ide", "cli_exec",
        "local_interactive_unclassified", "local_rollout_unclassified",
      ])
      || !member(value.agentScope, ["root", "subagent", "automation", "unknown"])
      || !member(value.lineageDisposition, ["standalone", "forked", "parent_linked"])
      || !exact(value.toolClassCounts, TOOL_CLASSES)
      || !Object.values(value.toolClassCounts).every((count) => integer(count, 1_000_000))
      || !member(value.outcome, ["completed", "failed", "cancelled", "interrupted", "retry", "unknown"])
      || !hashId(value.eventId, "event:v2")
      || !validateAccounting(value.accounting)) return false;

  const declarationValid = (value.modelRecognition === "recognized"
      && value.modelId !== "unknown" && value.modelFingerprint === null)
    || (value.modelRecognition === "unrecognized"
      && value.modelId === "unknown" && value.modelFingerprint !== null)
    || (value.modelRecognition === "missing"
      && value.modelId === "unknown" && value.modelFingerprint === null);
  if (!declarationValid) return false;
  if (value.provider === "openai_codex") {
    return OPENAI_MODELS.has(value.modelId)
      && value.components.outputCombinedTokens === null
      && value.components.inputCacheWrite5mTokens === null
      && value.components.inputCacheWrite1hTokens === null;
  }
  return CLAUDE_MODELS.has(value.modelId)
    && value.billingSurface === "claude_subscription"
    && value.apiServiceTier === "unknown"
    && value.reasoningEffort === "unknown"
    && value.components.outputTextTokens === null
    && value.components.outputReasoningTokens === null
    && value.components.outputCombinedTokens !== null;
}

function validateQuota(value: unknown): value is TelemetryQuotaSnapshot {
  if (!exact(value, [
    "schemaVersion", "observedTime", "receivedTime", "provider", "planType", "planVariant",
    "limitId", "slot", "usedPercent", "displayPrecision", "windowDurationMinutes",
    "resetsAt", "snapshotSource", "providerSurface", "snapshotId",
  ])
      || value.schemaVersion !== "quota-snapshot-v0.1"
      || !instant(value.observedTime) || !instant(value.receivedTime) || !instant(value.resetsAt)
      || !member(value.provider, ["openai_codex", "anthropic_claude_code"])
      || !member(value.planType, ["free", "go", "plus", "pro", "business", "enterprise", "edu", "team", "unknown"])
      || !member(value.planVariant, ["pro-20x", "pro-10x-promo", "pro-5x", "plus", "unknown"])
      || !member(value.limitId, ["unknown", "codex", "codex-spark"])
      || !member(value.slot, ["primary", "secondary", "five_hour", "seven_day", "other", "unknown"])
      || !bounded(value.usedPercent, 0, 100) || !integer(value.displayPrecision, 6)
      || !integer(value.windowDurationMinutes, 525_600) || value.windowDurationMinutes < 1
      || !member(value.snapshotSource, ["rollout", "app_server_read", "status_line", "ui_declaration", "notification"])
      || !member(value.providerSurface, ["account_shared_unallocated", "general_usage", "model_specific", "separate_limit", "unknown"])
      || !hashId(value.snapshotId, "snapshot:v2")) return false;
  if (Date.parse(value.receivedTime) < Date.parse(value.observedTime)
      || Date.parse(value.resetsAt) <= Date.parse(value.observedTime)) return false;
  if (value.provider === "anthropic_claude_code") {
    return value.limitId === "unknown"
      && value.snapshotSource === "status_line"
      && value.providerSurface === "general_usage";
  }
  return value.snapshotSource !== "status_line";
}

function validateMarker(value: unknown): value is TelemetryActivityMarker {
  return exact(value, [
    "schemaVersion", "observedTime", "surface", "state", "agenticPoolCoupling",
    "planType", "planVariant", "markerId",
  ])
    && value.schemaVersion === "export-activity-marker-v0.1"
    && instant(value.observedTime)
    && typeof value.surface === "string" && ACTIVITY_SURFACES.has(value.surface)
    && member(value.state, ["start", "end", "pulse"])
    && typeof value.agenticPoolCoupling === "string" && POOL_COUPLINGS.has(value.agenticPoolCoupling)
    && member(value.planType, ["free", "go", "plus", "pro", "business", "enterprise", "edu", "team", "unknown"])
    && member(value.planVariant, ["pro-20x", "pro-10x-promo", "pro-5x", "plus", "unknown"])
    && hashId(value.markerId, "marker:v2");
}

function privacyCanary(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return /(?:^|["\s])(?:prompt|response|message|command|arguments|cwd|path|url|email|username|hostname)["\s:]/iu.test(serialized)
    || /(?:\/Users\/|\/home\/|[A-Z]:\\|@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/u.test(serialized);
}

export function validateTelemetryContribution(value: unknown): TelemetryContribution {
  if (privacyCanary(value)) invalid("PRIVACY_CANARY_DETECTED");
  if (!exact(value, [
    "schemaVersion", "synthetic", "createdAt", "coveredAt", "clientPlatform",
    "providerPolicyEpoch", "usageEvents", "quotaSnapshots", "activityMarkers", "accounting",
  ])
      || value.schemaVersion !== TELEMETRY_CONTRIBUTION_SCHEMA_VERSION
      || value.synthetic !== false || !instant(value.createdAt)
      || !exact(value.coveredAt, ["startAt", "endAt"])
      || !instant(value.coveredAt.startAt) || !instant(value.coveredAt.endAt)
      || Date.parse(value.coveredAt.endAt) < Date.parse(value.coveredAt.startAt)
      || Date.parse(value.coveredAt.endAt) - Date.parse(value.coveredAt.startAt) > 366 * 86_400_000
      || !member(value.clientPlatform, ["macos", "linux", "windows", "other", "unknown"])
      || !member(value.providerPolicyEpoch, [
        "unknown", "openai_pre_agentic_pool_2026_07_09",
        "openai_agentic_pool_2026_07_09", "anthropic_unknown",
      ])
      || !Array.isArray(value.usageEvents) || value.usageEvents.length > 200
      || !Array.isArray(value.quotaSnapshots) || value.quotaSnapshots.length > 200
      || !Array.isArray(value.activityMarkers) || value.activityMarkers.length > 100
      || value.usageEvents.length + value.quotaSnapshots.length + value.activityMarkers.length < 1
      || value.usageEvents.length + value.quotaSnapshots.length + value.activityMarkers.length > 200
      || !value.usageEvents.every(validateUsage)
      || !value.quotaSnapshots.every(validateQuota)
      || !value.activityMarkers.every(validateMarker)
      || !exact(value.accounting, [
        "estimatedApiCostUsd", "pricedEventCoveragePercent", "unknownModelEventCount",
        "unknownBillableUnits", "priceBasis",
      ])
      || !money(value.accounting.estimatedApiCostUsd)
      || !bounded(value.accounting.pricedEventCoveragePercent, 0, 100)
      || !integer(value.accounting.unknownModelEventCount, 200)
      || !integer(value.accounting.unknownBillableUnits, 1_000_000_000)
      || !member(value.accounting.priceBasis, ["current_api_prices", "historical_api_prices", "unpriced"])) {
    invalid("TELEMETRY_RECORD_INVALID");
  }
  const eventIds = new Set(value.usageEvents.map((row) => row.eventId));
  const snapshotIds = new Set(value.quotaSnapshots.map((row) => row.snapshotId));
  const markerIds = new Set(value.activityMarkers.map((row) => row.markerId));
  if (eventIds.size !== value.usageEvents.length
      || snapshotIds.size !== value.quotaSnapshots.length
      || markerIds.size !== value.activityMarkers.length) {
    invalid("TELEMETRY_RECORD_INVALID");
  }
  const start = Date.parse(value.coveredAt.startAt);
  const end = Date.parse(value.coveredAt.endAt);
  const created = Date.parse(value.createdAt);
  const observedTimes = [
    ...value.usageEvents.map((row) => Date.parse(row.eventTime)),
    ...value.quotaSnapshots.map((row) => Date.parse(row.observedTime)),
    ...value.activityMarkers.map((row) => Date.parse(row.observedTime)),
  ];
  if (observedTimes.some((timestamp) => timestamp < start || timestamp > end)
      || created < end - 5 * 60_000
      || created > Date.now() + 24 * 60 * 60_000) {
    invalid("TELEMETRY_RECORD_INVALID");
  }

  const unknownModelEventCount = value.usageEvents
    .filter((row) => row.modelId === "unknown").length;
  const unknownBillableUnits = value.usageEvents
    .reduce((sum, row) => sum + row.accounting.unknownBillableUnits, 0);
  const coverage = value.usageEvents.length === 0 ? 0 : value.usageEvents
    .reduce((sum, row) => sum + row.accounting.pricingCoveragePercent, 0)
      / value.usageEvents.length;
  const eventPriceBases = new Set(value.usageEvents.map((row) => row.accounting.priceBasis));
  const eventCosts = value.usageEvents.map((row) => row.accounting.estimatedApiCostUsd);
  const toMicros = (amount: string): bigint => {
    const [whole = "0", fraction = "000000"] = amount.split(".");
    return (BigInt(whole) * 1_000_000n) + BigInt(fraction);
  };
  const costMicros = eventCosts.reduce(
    (sum: bigint, amount) => sum + (amount === null ? 0n : toMicros(amount)),
    0n,
  );
  const batchCostMicros = value.accounting.estimatedApiCostUsd === null
    ? null : toMicros(value.accounting.estimatedApiCostUsd);
  if (value.accounting.unknownModelEventCount !== unknownModelEventCount
      || value.accounting.unknownBillableUnits !== unknownBillableUnits
      || Math.abs(value.accounting.pricedEventCoveragePercent - coverage) > 0.001
      || eventPriceBases.size > 1
      || (eventPriceBases.size === 1 && !eventPriceBases.has(value.accounting.priceBasis))
      || (batchCostMicros === null ? costMicros !== 0n : batchCostMicros !== costMicros)
      || (value.usageEvents.length === 0
        && (value.accounting.priceBasis !== "unpriced"
          || value.accounting.estimatedApiCostUsd !== null))
      || value.usageEvents.some((row) => row.accounting.priceBasis === "unpriced"
        && (row.accounting.estimatedApiCostUsd !== null
          || row.accounting.pricingCoveragePercent !== 0))) {
    invalid("TELEMETRY_RECORD_INVALID");
  }

  const providers = new Set([
    ...value.usageEvents.map((row) => row.provider),
    ...value.quotaSnapshots.map((row) => row.provider),
  ]);
  const epochBoundary = Date.parse("2026-07-09T00:00:00.000Z");
  if ((value.providerPolicyEpoch === "openai_pre_agentic_pool_2026_07_09"
      && (providers.size !== 1 || !providers.has("openai_codex") || end > epochBoundary))
    || (value.providerPolicyEpoch === "openai_agentic_pool_2026_07_09"
      && (providers.size !== 1 || !providers.has("openai_codex") || start < epochBoundary))
    || (value.providerPolicyEpoch === "anthropic_unknown"
      && (providers.size !== 1 || !providers.has("anthropic_claude_code")))) {
    invalid("TELEMETRY_RECORD_INVALID");
  }
  return value as unknown as TelemetryContribution;
}
