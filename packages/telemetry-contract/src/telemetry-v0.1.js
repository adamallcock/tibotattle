import {
  MAX_TELEMETRY_BROWSER_BYTES,
  TELEMETRY_MODEL_IDS,
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_TOOL_CLASSES,
} from "./constants.js";
import {
  telemetryContractFailure,
} from "./errors.js";
import {
  assertTelemetryClientBounds,
  hasTelemetryExactKeys,
  isTelemetryBounded,
  isTelemetryHashId,
  isTelemetryInstant,
  isTelemetryInteger,
  isTelemetryMember,
  isTelemetryMoney,
  isTelemetryNullableInteger,
  telemetryPrivacyCanary,
  telemetryUsdToMicros,
} from "./primitives.js";

const MODEL_IDS = new Set(TELEMETRY_MODEL_IDS);
const OPENAI_MODELS = new Set(
  TELEMETRY_MODEL_IDS.filter((value) => (
    value === "unknown" || value.startsWith("gpt-")
  )),
);
const CLAUDE_MODELS = new Set(
  TELEMETRY_MODEL_IDS.filter((value) => (
    value === "unknown" || value.startsWith("claude-")
  )),
);
const ACTIVITY_SURFACES = new Set([
  "chatgpt_chat",
  "chatgpt_web",
  "chatgpt_work",
  "workspace_agent",
  "chatgpt_excel",
  "codex_cloud",
  "codex_other_machine",
  "chatgpt_work_voice",
  "ordinary_chat_voice",
  "image_generation",
  "codex_spark",
  "other_machine",
  "voice_mode",
  "voice_dictation",
  "third_party_client",
  "quiet_period",
  "controlled_experiment",
]);
const POOL_COUPLINGS = new Set([
  "excluded_ordinary_chat",
  "shared_agentic_pool",
  "mixed_task_shared_voice_time_separate",
  "shared_agentic_pool_feature_multiplier",
  "separate_demand_adjusted_model_limit",
  "unknown_client_surface",
  "unknown_legacy_voice_marker",
  "depends_on_destination_surface",
  "not_applicable",
  "depends_on_experiment_surface",
  "unknown",
]);

const CONTRIBUTION_KEYS = Object.freeze([
  "schemaVersion",
  "synthetic",
  "createdAt",
  "coveredAt",
  "clientPlatform",
  "providerPolicyEpoch",
  "usageEvents",
  "quotaSnapshots",
  "activityMarkers",
  "accounting",
]);
const USAGE_KEYS = Object.freeze([
  "schemaVersion",
  "eventTime",
  "provider",
  "modelId",
  "modelRecognition",
  "modelFingerprint",
  "billingSurface",
  "speedMode",
  "apiServiceTier",
  "reasoningEffort",
  "components",
  "totalInputContextTokens",
  "surface",
  "agentScope",
  "lineageDisposition",
  "toolClassCounts",
  "outcome",
  "eventId",
  "accounting",
]);
const COMPONENT_KEYS = Object.freeze([
  "inputUncachedTokens",
  "inputCacheReadTokens",
  "inputCacheWriteTokens",
  "inputCacheWrite5mTokens",
  "inputCacheWrite1hTokens",
  "outputTextTokens",
  "outputReasoningTokens",
  "outputCombinedTokens",
]);
const QUOTA_KEYS = Object.freeze([
  "schemaVersion",
  "observedTime",
  "receivedTime",
  "provider",
  "planType",
  "planVariant",
  "limitId",
  "slot",
  "usedPercent",
  "displayPrecision",
  "windowDurationMinutes",
  "resetsAt",
  "snapshotSource",
  "providerSurface",
  "snapshotId",
]);
const ACTIVITY_KEYS = Object.freeze([
  "schemaVersion",
  "observedTime",
  "surface",
  "state",
  "agenticPoolCoupling",
  "planType",
  "planVariant",
  "markerId",
]);
const USAGE_ACCOUNTING_KEYS = Object.freeze([
  "estimatedApiCostUsd",
  "pricingCoveragePercent",
  "unknownBillableUnits",
  "priceBasis",
]);
const CONTRIBUTION_ACCOUNTING_KEYS = Object.freeze([
  "estimatedApiCostUsd",
  "pricedEventCoveragePercent",
  "unknownModelEventCount",
  "unknownBillableUnits",
  "priceBasis",
]);

function invalid(detailCode, message) {
  telemetryContractFailure(
    "TELEMETRY_RECORD_INVALID",
    detailCode,
    message,
  );
}

function validateUsageAccounting(value) {
  return hasTelemetryExactKeys(value, USAGE_ACCOUNTING_KEYS)
    && isTelemetryMoney(value.estimatedApiCostUsd)
    && isTelemetryBounded(value.pricingCoveragePercent, 0, 100)
    && isTelemetryInteger(value.unknownBillableUnits, 1_000_000_000)
    && isTelemetryMember(value.priceBasis, [
      "current_api_prices",
      "historical_api_prices",
      "unpriced",
    ]);
}

function validateUsage(value) {
  if (
    !hasTelemetryExactKeys(value, USAGE_KEYS)
    || value.schemaVersion !== "usage-event-v0.1"
    || !isTelemetryInstant(value.eventTime)
    || !isTelemetryMember(value.provider, [
      "openai_codex",
      "anthropic_claude_code",
    ])
    || typeof value.modelId !== "string"
    || !MODEL_IDS.has(value.modelId)
    || !isTelemetryMember(value.modelRecognition, [
      "recognized",
      "unrecognized",
      "missing",
    ])
    || !(
      value.modelFingerprint === null
      || isTelemetryHashId(value.modelFingerprint, "model:v1")
    )
    || !isTelemetryMember(value.billingSurface, [
      "chatgpt_subscription",
      "openai_api",
      "claude_subscription",
      "unknown",
    ])
    || !isTelemetryMember(value.speedMode, [
      "standard",
      "fast",
      "unknown",
      "other",
    ])
    || !isTelemetryMember(value.apiServiceTier, [
      "standard",
      "priority",
      "flex",
      "batch",
      "unknown",
      "other",
    ])
    || !isTelemetryMember(value.reasoningEffort, [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
      "unknown",
    ])
    || !hasTelemetryExactKeys(value.components, COMPONENT_KEYS)
    || !Object.values(value.components).every((component) => (
      isTelemetryNullableInteger(component, 1_000_000_000)
    ))
    || !isTelemetryNullableInteger(
      value.totalInputContextTokens,
      1_000_000_000,
    )
    || !isTelemetryMember(value.surface, [
      "scheduled_task",
      "subagent",
      "extension_or_ide",
      "cli_exec",
      "local_interactive_unclassified",
      "local_rollout_unclassified",
    ])
    || !isTelemetryMember(value.agentScope, [
      "root",
      "subagent",
      "automation",
      "unknown",
    ])
    || !isTelemetryMember(value.lineageDisposition, [
      "standalone",
      "forked",
      "parent_linked",
    ])
    || !hasTelemetryExactKeys(
      value.toolClassCounts,
      TELEMETRY_TOOL_CLASSES,
    )
    || !Object.values(value.toolClassCounts).every((count) => (
      isTelemetryInteger(count, 1_000_000)
    ))
    || !isTelemetryMember(value.outcome, [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "retry",
      "unknown",
    ])
    || !isTelemetryHashId(value.eventId, "event:v2")
    || !validateUsageAccounting(value.accounting)
  ) return false;

  const declarationValid = (
    value.modelRecognition === "recognized"
    && value.modelId !== "unknown"
    && value.modelFingerprint === null
  ) || (
    value.modelRecognition === "unrecognized"
    && value.modelId === "unknown"
    && value.modelFingerprint !== null
  ) || (
    value.modelRecognition === "missing"
    && value.modelId === "unknown"
    && value.modelFingerprint === null
  );
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

function validateQuota(value) {
  if (
    !hasTelemetryExactKeys(value, QUOTA_KEYS)
    || value.schemaVersion !== "quota-snapshot-v0.1"
    || !isTelemetryInstant(value.observedTime)
    || !isTelemetryInstant(value.receivedTime)
    || !isTelemetryInstant(value.resetsAt)
    || !isTelemetryMember(value.provider, [
      "openai_codex",
      "anthropic_claude_code",
    ])
    || !isTelemetryMember(value.planType, [
      "free",
      "go",
      "plus",
      "pro",
      "business",
      "enterprise",
      "edu",
      "team",
      "unknown",
    ])
    || !isTelemetryMember(value.planVariant, [
      "pro-20x",
      "pro-10x-promo",
      "pro-5x",
      "plus",
      "unknown",
    ])
    || !isTelemetryMember(value.limitId, [
      "unknown",
      "codex",
      "codex-spark",
    ])
    || !isTelemetryMember(value.slot, [
      "primary",
      "secondary",
      "five_hour",
      "seven_day",
      "other",
      "unknown",
    ])
    || !isTelemetryBounded(value.usedPercent, 0, 100)
    || !isTelemetryInteger(value.displayPrecision, 6)
    || !isTelemetryInteger(value.windowDurationMinutes, 525_600)
    || value.windowDurationMinutes < 1
    || !isTelemetryMember(value.snapshotSource, [
      "rollout",
      "app_server_read",
      "status_line",
      "ui_declaration",
      "notification",
    ])
    || !isTelemetryMember(value.providerSurface, [
      "account_shared_unallocated",
      "general_usage",
      "model_specific",
      "separate_limit",
      "unknown",
    ])
    || !isTelemetryHashId(value.snapshotId, "snapshot:v2")
  ) return false;
  if (
    Date.parse(value.receivedTime) < Date.parse(value.observedTime)
    || Date.parse(value.resetsAt) <= Date.parse(value.observedTime)
  ) return false;
  if (value.provider === "anthropic_claude_code") {
    return value.limitId === "unknown"
      && value.snapshotSource === "status_line"
      && value.providerSurface === "general_usage";
  }
  return value.snapshotSource !== "status_line";
}

function validateActivity(value) {
  return hasTelemetryExactKeys(value, ACTIVITY_KEYS)
    && value.schemaVersion === "export-activity-marker-v0.1"
    && isTelemetryInstant(value.observedTime)
    && typeof value.surface === "string"
    && ACTIVITY_SURFACES.has(value.surface)
    && isTelemetryMember(value.state, ["start", "end", "pulse"])
    && typeof value.agenticPoolCoupling === "string"
    && POOL_COUPLINGS.has(value.agenticPoolCoupling)
    && isTelemetryMember(value.planType, [
      "free",
      "go",
      "plus",
      "pro",
      "business",
      "enterprise",
      "edu",
      "team",
      "unknown",
    ])
    && isTelemetryMember(value.planVariant, [
      "pro-20x",
      "pro-10x-promo",
      "pro-5x",
      "plus",
      "unknown",
    ])
    && isTelemetryHashId(value.markerId, "marker:v2");
}

export function parseTelemetryContribution(value, {
  maxSerializedBytes = MAX_TELEMETRY_BROWSER_BYTES,
  maxDepth = 12,
  maxArrayItems = 200,
  nowEpoch = Date.now(),
} = {}) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    invalid(
      "object_required",
      "The export must be one JSON object.",
    );
  }
  if (
    value.schemaVersion !== TELEMETRY_SCHEMA_VERSION
    || value.synthetic !== false
  ) {
    invalid(
      "schema_version_invalid",
      "Choose a real privacy-safe telemetry export from this app.",
    );
  }
  if (telemetryPrivacyCanary(value)) {
    telemetryContractFailure(
      "PRIVACY_CANARY_DETECTED",
      "privacy_canary_detected",
      "The export contains a forbidden content or identity field.",
    );
  }
  assertTelemetryClientBounds(value, {
    maxSerializedBytes,
    maxDepth,
    maxArrayItems,
  });
  if (!hasTelemetryExactKeys(value, CONTRIBUTION_KEYS)) {
    invalid(
      "closed_shape_invalid",
      "The export does not match the closed telemetry contribution schema.",
    );
  }
  if (
    !isTelemetryInstant(value.createdAt)
    || !hasTelemetryExactKeys(value.coveredAt, ["startAt", "endAt"])
    || !isTelemetryInstant(value.coveredAt.startAt)
    || !isTelemetryInstant(value.coveredAt.endAt)
    || Date.parse(value.coveredAt.endAt)
      < Date.parse(value.coveredAt.startAt)
    || Date.parse(value.coveredAt.endAt)
      - Date.parse(value.coveredAt.startAt) > 366 * 86_400_000
  ) {
    invalid(
      "covered_at_invalid",
      "The export has an invalid coveredAt interval.",
    );
  }
  if (!isTelemetryMember(value.clientPlatform, [
    "macos",
    "linux",
    "windows",
    "other",
    "unknown",
  ])) {
    invalid("client_platform_invalid", "The export client platform is invalid.");
  }
  if (!isTelemetryMember(value.providerPolicyEpoch, [
    "unknown",
    "openai_pre_agentic_pool_2026_07_09",
    "openai_agentic_pool_2026_07_09",
    "anthropic_unknown",
  ])) {
    invalid(
      "provider_policy_epoch_invalid",
      "The export provider policy epoch is invalid.",
    );
  }
  if (!Array.isArray(value.usageEvents)
      || value.usageEvents.length > 200
      || !value.usageEvents.every(validateUsage)) {
    invalid(
      "usage_events_invalid",
      "The export contains invalid usageEvents records.",
    );
  }
  if (!Array.isArray(value.quotaSnapshots)
      || value.quotaSnapshots.length > 200
      || !value.quotaSnapshots.every(validateQuota)) {
    invalid(
      "quota_snapshots_invalid",
      "The export contains invalid quotaSnapshots records.",
    );
  }
  if (!Array.isArray(value.activityMarkers)
      || value.activityMarkers.length > 100
      || !value.activityMarkers.every(validateActivity)) {
    invalid(
      "activity_markers_invalid",
      "The export contains invalid activityMarkers records.",
    );
  }
  const totalRecords = value.usageEvents.length
    + value.quotaSnapshots.length
    + value.activityMarkers.length;
  if (totalRecords < 1 || totalRecords > 200) {
    invalid(
      "record_count_invalid",
      "The export must contain between 1 and 200 telemetry records.",
    );
  }
  if (
    !hasTelemetryExactKeys(
      value.accounting,
      CONTRIBUTION_ACCOUNTING_KEYS,
    )
    || !isTelemetryMoney(value.accounting.estimatedApiCostUsd)
    || !isTelemetryBounded(
      value.accounting.pricedEventCoveragePercent,
      0,
      100,
    )
    || !isTelemetryInteger(
      value.accounting.unknownModelEventCount,
      200,
    )
    || !isTelemetryInteger(
      value.accounting.unknownBillableUnits,
      1_000_000_000,
    )
    || !isTelemetryMember(value.accounting.priceBasis, [
      "current_api_prices",
      "historical_api_prices",
      "unpriced",
    ])
  ) {
    invalid(
      "accounting_invalid",
      "The export accounting summary is invalid.",
    );
  }

  const eventIds = new Set(
    value.usageEvents.map((row) => row.eventId),
  );
  const snapshotIds = new Set(
    value.quotaSnapshots.map((row) => row.snapshotId),
  );
  const markerIds = new Set(
    value.activityMarkers.map((row) => row.markerId),
  );
  if (
    eventIds.size !== value.usageEvents.length
    || snapshotIds.size !== value.quotaSnapshots.length
    || markerIds.size !== value.activityMarkers.length
  ) {
    invalid(
      "duplicate_record_id",
      "The export contains duplicate telemetry record identifiers.",
    );
  }

  const start = Date.parse(value.coveredAt.startAt);
  const end = Date.parse(value.coveredAt.endAt);
  const created = Date.parse(value.createdAt);
  const observedTimes = [
    ...value.usageEvents.map((row) => Date.parse(row.eventTime)),
    ...value.quotaSnapshots.map((row) => Date.parse(row.observedTime)),
    ...value.activityMarkers.map((row) => Date.parse(row.observedTime)),
  ];
  if (
    observedTimes.some((timestamp) => timestamp < start || timestamp > end)
    || created < end - 5 * 60_000
    || !Number.isFinite(nowEpoch)
    || created > nowEpoch + 24 * 60 * 60_000
  ) {
    invalid(
      "record_time_invalid",
      "The export contains telemetry outside its declared time range.",
    );
  }

  const unknownModelEventCount = value.usageEvents
    .filter((row) => row.modelId === "unknown").length;
  const unknownBillableUnits = value.usageEvents.reduce(
    (sum, row) => sum + row.accounting.unknownBillableUnits,
    0,
  );
  const coverage = value.usageEvents.length === 0
    ? 0
    : value.usageEvents.reduce(
      (sum, row) => sum + row.accounting.pricingCoveragePercent,
      0,
    ) / value.usageEvents.length;
  const eventPriceBases = new Set(
    value.usageEvents.map((row) => row.accounting.priceBasis),
  );
  const costMicros = value.usageEvents.reduce(
    (sum, row) => sum + (
      row.accounting.estimatedApiCostUsd === null
        ? 0n
        : telemetryUsdToMicros(row.accounting.estimatedApiCostUsd)
    ),
    0n,
  );
  const batchCostMicros =
    value.accounting.estimatedApiCostUsd === null
      ? null
      : telemetryUsdToMicros(value.accounting.estimatedApiCostUsd);
  if (
    value.accounting.unknownModelEventCount !== unknownModelEventCount
    || value.accounting.unknownBillableUnits !== unknownBillableUnits
    || Math.abs(
      value.accounting.pricedEventCoveragePercent - coverage,
    ) > 0.001
    || eventPriceBases.size > 1
    || (
      eventPriceBases.size === 1
      && !eventPriceBases.has(value.accounting.priceBasis)
    )
    || (
      batchCostMicros === null
        ? costMicros !== 0n
        : batchCostMicros !== costMicros
    )
    || (
      value.usageEvents.length === 0
      && (
        value.accounting.priceBasis !== "unpriced"
        || value.accounting.estimatedApiCostUsd !== null
      )
    )
    || value.usageEvents.some((row) => (
      row.accounting.priceBasis === "unpriced"
      && (
        row.accounting.estimatedApiCostUsd !== null
        || row.accounting.pricingCoveragePercent !== 0
      )
    ))
  ) {
    invalid(
      "accounting_reconciliation_invalid",
      "The export accounting summary does not reconcile.",
    );
  }

  const providers = new Set([
    ...value.usageEvents.map((row) => row.provider),
    ...value.quotaSnapshots.map((row) => row.provider),
  ]);
  const epochBoundary = Date.parse("2026-07-09T00:00:00.000Z");
  if (
    (
      value.providerPolicyEpoch
        === "openai_pre_agentic_pool_2026_07_09"
      && (
        providers.size !== 1
        || !providers.has("openai_codex")
        || end > epochBoundary
      )
    )
    || (
      value.providerPolicyEpoch
        === "openai_agentic_pool_2026_07_09"
      && (
        providers.size !== 1
        || !providers.has("openai_codex")
        || start < epochBoundary
      )
    )
    || (
      value.providerPolicyEpoch === "anthropic_unknown"
      && (
        providers.size !== 1
        || !providers.has("anthropic_claude_code")
      )
    )
  ) {
    invalid(
      "provider_policy_epoch_mismatch",
      "The export provider policy epoch does not match its records.",
    );
  }
  return value;
}

export function validateTelemetryContribution(value, options = {}) {
  parseTelemetryContribution(value, options);
  return true;
}
