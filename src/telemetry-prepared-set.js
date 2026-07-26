import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { validateTelemetryContribution } from "../apps/web/public/lib.js";
import { readBoundedDirectoryEntries } from "./export-resource-policy.js";
import { stableJson, syncDirectory } from "./storage.js";

export const PREPARED_CONTRIBUTION_SET_VERSION =
  "prepared-contribution-set-v0.1";
export const PREPARED_CONTRIBUTION_SET_MANIFEST =
  "prepared-contribution-set-v0.1.json";
export const PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA =
  "telemetry-contribution-v0.1";
export const MAX_PREPARED_CONTRIBUTION_BATCHES = 100;

const MAX_CONTRIBUTION_BYTES = 1_310_720;
const MAX_MANIFEST_BYTES = 256 * 1024;
const CONTRIBUTION_BASENAME =
  /^telemetry-contribution-([0-9]{6})\.json$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MODEL_IDS = new Set([
  "unknown",
  "gpt-4.1",
  "gpt-5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.5-codex",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
]);
const OPENAI_MODELS = new Set(
  [...MODEL_IDS].filter((value) => (
    value === "unknown" || value.startsWith("gpt-")
  )),
);
const CLAUDE_MODELS = new Set(
  [...MODEL_IDS].filter((value) => (
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

const TOP_LEVEL_KEYS = [
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
];
const USAGE_KEYS = [
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
];
const QUOTA_KEYS = [
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
];
const ACTIVITY_KEYS = [
  "schemaVersion",
  "observedTime",
  "surface",
  "state",
  "agenticPoolCoupling",
  "planType",
  "planVariant",
  "markerId",
];
const COMPONENT_KEYS = [
  "inputUncachedTokens",
  "inputCacheReadTokens",
  "inputCacheWriteTokens",
  "inputCacheWrite5mTokens",
  "inputCacheWrite1hTokens",
  "outputTextTokens",
  "outputReasoningTokens",
  "outputCombinedTokens",
];
const TOOL_KEYS = [
  "webSearch",
  "fileSearch",
  "codeInterpreter",
  "hostedShell",
  "computerUse",
  "mcp",
  "applyPatch",
  "localShell",
  "subagent",
  "toolGateway",
  "other",
  "unknown",
];
const USAGE_ACCOUNTING_KEYS = [
  "estimatedApiCostUsd",
  "pricingCoveragePercent",
  "unknownBillableUnits",
  "priceBasis",
];
const BATCH_ACCOUNTING_KEYS = [
  "estimatedApiCostUsd",
  "pricedEventCoveragePercent",
  "unknownModelEventCount",
  "unknownBillableUnits",
  "priceBasis",
];
const RECORD_COUNT_KEYS = [
  "usageEvents",
  "quotaSnapshots",
  "activityMarkers",
];
const MANIFEST_KEYS = [
  "schemaVersion",
  "builderVersion",
  "eligibleSchemaVersion",
  "batchCount",
  "files",
];
const MANIFEST_FILE_KEYS = [
  "basename",
  "sha256",
  "bytes",
  "recordCounts",
];

const ERROR_CODES = new Set([
  "directory_invalid",
  "manifest_missing",
  "manifest_invalid",
  "manifest_changed",
  "manifest_unexpected_entry",
  "file_missing",
  "file_invalid",
  "file_changed",
  "file_digest",
  "file_metadata",
  "file_schema",
  "publication_invalid",
]);

export class PreparedContributionSetError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown prepared contribution set error");
    }
    super(`Prepared contribution set failed (${code})`);
    this.name = "PreparedContributionSetError";
    this.code = `prepared_contribution_set_${code}`;
  }
}

function fail(code) {
  throw new PreparedContributionSetError(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, keys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function instant(value) {
  if (typeof value !== "string" || value.length > 32) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function nullableInteger(value, maximum = 1_000_000_000) {
  return value === null || integer(value, maximum);
}

function bounded(value, minimum, maximum) {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

function member(value, values) {
  return typeof value === "string" && values.includes(value);
}

function money(value) {
  return value === null
    || (typeof value === "string"
      && /^(?:0|[1-9]\d{0,8})\.\d{6}$/u.test(value));
}

function hashId(value, prefix) {
  return typeof value === "string"
    && new RegExp(`^${prefix}:(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$`, "u")
      .test(value);
}

function validUsageAccounting(value) {
  return exact(value, USAGE_ACCOUNTING_KEYS)
    && money(value.estimatedApiCostUsd)
    && bounded(value.pricingCoveragePercent, 0, 100)
    && integer(value.unknownBillableUnits, 1_000_000_000)
    && member(value.priceBasis, [
      "current_api_prices",
      "historical_api_prices",
      "unpriced",
    ]);
}

function validUsage(value) {
  const baseValid = exact(value, USAGE_KEYS)
    && value.schemaVersion === "usage-event-v0.1"
    && instant(value.eventTime)
    && member(value.provider, [
      "openai_codex",
      "anthropic_claude_code",
    ])
    && typeof value.modelId === "string"
    && MODEL_IDS.has(value.modelId)
    && member(value.modelRecognition, [
      "recognized",
      "unrecognized",
      "missing",
    ])
    && (value.modelFingerprint === null
      || hashId(value.modelFingerprint, "model:v1"))
    && member(value.billingSurface, [
      "chatgpt_subscription",
      "openai_api",
      "claude_subscription",
      "unknown",
    ])
    && member(value.speedMode, ["standard", "fast", "unknown", "other"])
    && member(value.apiServiceTier, [
      "standard",
      "priority",
      "flex",
      "batch",
      "unknown",
      "other",
    ])
    && member(value.reasoningEffort, [
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
    && exact(value.components, COMPONENT_KEYS)
    && Object.values(value.components).every((component) => (
      nullableInteger(component)
    ))
    && nullableInteger(value.totalInputContextTokens)
    && member(value.surface, [
      "scheduled_task",
      "subagent",
      "extension_or_ide",
      "cli_exec",
      "local_interactive_unclassified",
      "local_rollout_unclassified",
    ])
    && member(value.agentScope, [
      "root",
      "subagent",
      "automation",
      "unknown",
    ])
    && member(value.lineageDisposition, [
      "standalone",
      "forked",
      "parent_linked",
    ])
    && exact(value.toolClassCounts, TOOL_KEYS)
    && Object.values(value.toolClassCounts).every((count) => (
      integer(count, 1_000_000)
    ))
    && member(value.outcome, [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "retry",
      "unknown",
    ])
    && hashId(value.eventId, "event:v2")
    && validUsageAccounting(value.accounting);
  if (!baseValid) return false;
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

function validQuota(value) {
  const baseValid = exact(value, QUOTA_KEYS)
    && value.schemaVersion === "quota-snapshot-v0.1"
    && instant(value.observedTime)
    && instant(value.receivedTime)
    && instant(value.resetsAt)
    && Date.parse(value.receivedTime) >= Date.parse(value.observedTime)
    && Date.parse(value.resetsAt) > Date.parse(value.observedTime)
    && member(value.provider, [
      "openai_codex",
      "anthropic_claude_code",
    ])
    && member(value.planType, [
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
    && member(value.planVariant, [
      "pro-20x",
      "pro-10x-promo",
      "pro-5x",
      "plus",
      "unknown",
    ])
    && member(value.limitId, ["unknown", "codex", "codex-spark"])
    && member(value.slot, [
      "primary",
      "secondary",
      "five_hour",
      "seven_day",
      "other",
      "unknown",
    ])
    && bounded(value.usedPercent, 0, 100)
    && integer(value.displayPrecision, 6)
    && integer(value.windowDurationMinutes, 525_600)
    && value.windowDurationMinutes >= 1
    && member(value.snapshotSource, [
      "rollout",
      "app_server_read",
      "status_line",
      "ui_declaration",
      "notification",
    ])
    && member(value.providerSurface, [
      "account_shared_unallocated",
      "general_usage",
      "model_specific",
      "separate_limit",
      "unknown",
    ])
    && hashId(value.snapshotId, "snapshot:v2");
  if (!baseValid) return false;
  if (value.provider === "anthropic_claude_code") {
    return value.limitId === "unknown"
      && value.snapshotSource === "status_line"
      && value.providerSurface === "general_usage";
  }
  return value.snapshotSource !== "status_line";
}

function validActivity(value) {
  return exact(value, ACTIVITY_KEYS)
    && value.schemaVersion === "export-activity-marker-v0.1"
    && instant(value.observedTime)
    && typeof value.surface === "string"
    && ACTIVITY_SURFACES.has(value.surface)
    && typeof value.agenticPoolCoupling === "string"
    && POOL_COUPLINGS.has(value.agenticPoolCoupling)
    && member(value.state, ["start", "end", "pulse"])
    && member(value.planType, [
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
    && member(value.planVariant, [
      "pro-20x",
      "pro-10x-promo",
      "pro-5x",
      "plus",
      "unknown",
    ])
    && hashId(value.markerId, "marker:v2");
}

export function validatePreparedTelemetryContributionV01(value) {
  try {
    validateTelemetryContribution(value);
  } catch {
    fail("file_schema");
  }
  if (!exact(value, TOP_LEVEL_KEYS)
      || value.schemaVersion !== PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA
      || value.synthetic !== false
      || !instant(value.createdAt)
      || !exact(value.coveredAt, ["startAt", "endAt"])
      || !instant(value.coveredAt.startAt)
      || !instant(value.coveredAt.endAt)
      || Date.parse(value.coveredAt.endAt) < Date.parse(value.coveredAt.startAt)
      || !member(value.clientPlatform, [
        "macos",
        "linux",
        "windows",
        "other",
        "unknown",
      ])
      || !member(value.providerPolicyEpoch, [
        "unknown",
        "openai_pre_agentic_pool_2026_07_09",
        "openai_agentic_pool_2026_07_09",
        "anthropic_unknown",
      ])
      || !value.usageEvents.every(validUsage)
      || !value.quotaSnapshots.every(validQuota)
      || !value.activityMarkers.every(validActivity)
      || !exact(value.accounting, BATCH_ACCOUNTING_KEYS)
      || !money(value.accounting.estimatedApiCostUsd)
      || !bounded(value.accounting.pricedEventCoveragePercent, 0, 100)
      || !integer(value.accounting.unknownModelEventCount, 200)
      || !integer(value.accounting.unknownBillableUnits, 1_000_000_000)
      || !member(value.accounting.priceBasis, [
        "current_api_prices",
        "historical_api_prices",
        "unpriced",
      ])) {
    fail("file_schema");
  }
  const start = Date.parse(value.coveredAt.startAt);
  const end = Date.parse(value.coveredAt.endAt);
  const observed = [
    ...value.usageEvents.map((row) => Date.parse(row.eventTime)),
    ...value.quotaSnapshots.map((row) => Date.parse(row.observedTime)),
    ...value.activityMarkers.map((row) => Date.parse(row.observedTime)),
  ];
  if (observed.some((timestamp) => timestamp < start || timestamp > end)) {
    fail("file_schema");
  }
  const eventIds = new Set(value.usageEvents.map((row) => row.eventId));
  const snapshotIds = new Set(
    value.quotaSnapshots.map((row) => row.snapshotId),
  );
  const markerIds = new Set(
    value.activityMarkers.map((row) => row.markerId),
  );
  if (eventIds.size !== value.usageEvents.length
      || snapshotIds.size !== value.quotaSnapshots.length
      || markerIds.size !== value.activityMarkers.length) {
    fail("file_schema");
  }
  const unknownModelEventCount = value.usageEvents
    .filter((row) => row.modelId === "unknown").length;
  const unknownBillableUnits = value.usageEvents
    .reduce((sum, row) => sum + row.accounting.unknownBillableUnits, 0);
  const coverage = value.usageEvents.length === 0
    ? 0
    : value.usageEvents.reduce(
      (sum, row) => sum + row.accounting.pricingCoveragePercent,
      0,
    ) / value.usageEvents.length;
  const priceBases = new Set(
    value.usageEvents.map((row) => row.accounting.priceBasis),
  );
  const toMicros = (amount) => {
    const [whole = "0", fraction = "000000"] = amount.split(".");
    return (BigInt(whole) * 1_000_000n) + BigInt(fraction);
  };
  const costMicros = value.usageEvents.reduce(
    (sum, row) => sum + (
      row.accounting.estimatedApiCostUsd === null
        ? 0n
        : toMicros(row.accounting.estimatedApiCostUsd)
    ),
    0n,
  );
  const declaredCost = value.accounting.estimatedApiCostUsd === null
    ? null
    : toMicros(value.accounting.estimatedApiCostUsd);
  if (value.accounting.unknownModelEventCount !== unknownModelEventCount
      || value.accounting.unknownBillableUnits !== unknownBillableUnits
      || Math.abs(value.accounting.pricedEventCoveragePercent - coverage)
        > 0.001
      || priceBases.size > 1
      || (priceBases.size === 1
        && !priceBases.has(value.accounting.priceBasis))
      || (declaredCost === null
        ? costMicros !== 0n
        : declaredCost !== costMicros)
      || (value.usageEvents.length === 0
        && (value.accounting.priceBasis !== "unpriced"
          || value.accounting.estimatedApiCostUsd !== null))) {
    fail("file_schema");
  }
  const providers = new Set([
    ...value.usageEvents.map((row) => row.provider),
    ...value.quotaSnapshots.map((row) => row.provider),
  ]);
  const epochBoundary = Date.parse("2026-07-09T00:00:00.000Z");
  if ((value.providerPolicyEpoch ===
        "openai_pre_agentic_pool_2026_07_09"
      && (providers.size !== 1
        || !providers.has("openai_codex")
        || end > epochBoundary))
    || (value.providerPolicyEpoch ===
        "openai_agentic_pool_2026_07_09"
      && (providers.size !== 1
        || !providers.has("openai_codex")
        || start < epochBoundary))
    || (value.providerPolicyEpoch === "anthropic_unknown"
      && (providers.size !== 1
        || !providers.has("anthropic_claude_code")))) {
    fail("file_schema");
  }
  return value;
}

function recordCounts(value) {
  return {
    usageEvents: value.usageEvents.length,
    quotaSnapshots: value.quotaSnapshots.length,
    activityMarkers: value.activityMarkers.length,
  };
}

function assertDirectory(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("directory_invalid");
  }
}

function assertFile(stats, maximumBytes) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || !Number.isSafeInteger(stats.size) || stats.size < 1
      || stats.size > maximumBytes
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("file_invalid");
  }
}

async function canonicalDirectory(directory) {
  const requested = resolve(directory);
  let requestedStats;
  let canonical;
  try {
    requestedStats = await lstat(requested);
    assertDirectory(requestedStats);
    canonical = await realpath(requested);
    const canonicalStats = await lstat(canonical);
    assertDirectory(canonicalStats);
    if (canonicalStats.dev !== requestedStats.dev
        || canonicalStats.ino !== requestedStats.ino) {
      fail("directory_invalid");
    }
  } catch (error) {
    if (error instanceof PreparedContributionSetError) throw error;
    fail("directory_invalid");
  }
  return canonical;
}

async function readOwnerOnlyFile(
  directory,
  name,
  maximumBytes,
  { missingCode = "file_missing", changedCode = "file_changed" } = {},
) {
  const path = join(directory, name);
  let pathStats;
  let handle;
  try {
    pathStats = await lstat(path);
    assertFile(pathStats, maximumBytes);
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    assertFile(opened, maximumBytes);
    if (opened.dev !== pathStats.dev || opened.ino !== pathStats.ino
        || opened.size !== pathStats.size) {
      fail(changedCode);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== opened.size || after.dev !== opened.dev
        || after.ino !== opened.ino || after.size !== opened.size) {
      fail(changedCode);
    }
    return bytes;
  } catch (error) {
    if (error instanceof PreparedContributionSetError) throw error;
    if (error?.code === "ENOENT") fail(missingCode);
    fail(changedCode);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseCanonical(bytes, code) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code);
  }
  if (stableJson(value) !== bytes.toString("utf8")) fail(code);
  return value;
}

function validCounts(value) {
  return exact(value, RECORD_COUNT_KEYS)
    && integer(value.usageEvents, 200)
    && integer(value.quotaSnapshots, 200)
    && integer(value.activityMarkers, 100)
    && value.usageEvents + value.quotaSnapshots + value.activityMarkers >= 1
    && value.usageEvents + value.quotaSnapshots + value.activityMarkers <= 200;
}

function validateManifest(value, builderVersion) {
  if (!exact(value, MANIFEST_KEYS)
      || value.schemaVersion !== PREPARED_CONTRIBUTION_SET_VERSION
      || value.builderVersion !== builderVersion
      || value.eligibleSchemaVersion
        !== PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA
      || !integer(value.batchCount, MAX_PREPARED_CONTRIBUTION_BATCHES)
      || value.batchCount < 1
      || !Array.isArray(value.files)
      || value.files.length !== value.batchCount) {
    fail("manifest_invalid");
  }
  const names = new Set();
  for (const [index, entry] of value.files.entries()) {
    const expectedName =
      `telemetry-contribution-${String(index + 1).padStart(6, "0")}.json`;
    if (!exact(entry, MANIFEST_FILE_KEYS)
        || entry.basename !== expectedName
        || !CONTRIBUTION_BASENAME.test(entry.basename)
        || names.has(entry.basename)
        || !SHA256_PATTERN.test(entry.sha256)
        || !integer(entry.bytes, MAX_CONTRIBUTION_BYTES)
        || entry.bytes < 1
        || !validCounts(entry.recordCounts)) {
      fail("manifest_invalid");
    }
    names.add(entry.basename);
  }
  return value;
}

async function inspectContribution(directory, entry) {
  const bytes = await readOwnerOnlyFile(
    directory,
    entry.basename,
    MAX_CONTRIBUTION_BYTES,
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (entry.bytes !== bytes.length || entry.sha256 !== digest) {
    fail("file_digest");
  }
  const value = parseCanonical(bytes, "file_schema");
  validatePreparedTelemetryContributionV01(value);
  const counts = recordCounts(value);
  if (stableJson(counts) !== stableJson(entry.recordCounts)) {
    fail("file_metadata");
  }
  return {
    basename: entry.basename,
    sha256: digest,
    bytes: bytes.length,
    recordCounts: counts,
  };
}

export async function loadVerifiedPreparedContribution({
  directory,
  entry,
} = {}) {
  const root = await canonicalDirectory(directory);
  if (!exact(entry, MANIFEST_FILE_KEYS)
      || !CONTRIBUTION_BASENAME.test(entry.basename)
      || !SHA256_PATTERN.test(entry.sha256)
      || !integer(entry.bytes, MAX_CONTRIBUTION_BYTES)
      || !validCounts(entry.recordCounts)) {
    fail("manifest_invalid");
  }
  const bytes = await readOwnerOnlyFile(
    root,
    entry.basename,
    MAX_CONTRIBUTION_BYTES,
  );
  try {
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (entry.bytes !== bytes.length || entry.sha256 !== digest) {
      fail("file_digest");
    }
    const payload = parseCanonical(bytes, "file_schema");
    validatePreparedTelemetryContributionV01(payload);
    if (stableJson(recordCounts(payload)) !== stableJson(entry.recordCounts)) {
      fail("file_metadata");
    }
    return structuredClone(payload);
  } finally {
    bytes.fill(0);
  }
}

export async function verifyPreparedContributionFiles({
  directory,
  files,
} = {}) {
  const root = await canonicalDirectory(directory);
  if (!Array.isArray(files) || files.length < 1
      || files.length > MAX_PREPARED_CONTRIBUTION_BATCHES) {
    fail("manifest_invalid");
  }
  const inspected = [];
  for (const [index, file] of files.entries()) {
    const expectedName =
      `telemetry-contribution-${String(index + 1).padStart(6, "0")}.json`;
    const entry = {
      basename: file?.basename,
      sha256: file?.sha256,
      bytes: file?.bytes,
      recordCounts: file?.recordCounts,
    };
    if (entry.basename !== expectedName) fail("manifest_invalid");
    inspected.push(await inspectContribution(root, entry));
  }
  return inspected;
}

export async function verifyPreparedContributionSet({
  directory,
  builderVersion,
} = {}) {
  if (typeof builderVersion !== "string" || builderVersion.length < 1) {
    fail("manifest_invalid");
  }
  const root = await canonicalDirectory(directory);
  const manifestBytes = await readOwnerOnlyFile(
    root,
    PREPARED_CONTRIBUTION_SET_MANIFEST,
    MAX_MANIFEST_BYTES,
    {
      missingCode: "manifest_missing",
      changedCode: "manifest_changed",
    },
  );
  const manifest = validateManifest(
    parseCanonical(manifestBytes, "manifest_invalid"),
    builderVersion,
  );
  const allowed = new Set([
    PREPARED_CONTRIBUTION_SET_MANIFEST,
    ...manifest.files.map((entry) => entry.basename),
  ]);
  let entries;
  try {
    entries = await readBoundedDirectoryEntries(root, {
      maximumEntries: MAX_PREPARED_CONTRIBUTION_BATCHES + 1,
    });
  } catch {
    fail("directory_invalid");
  }
  if (entries.length !== allowed.size
      || entries.some((entry) => !allowed.has(entry))) {
    fail("manifest_unexpected_entry");
  }
  const inspected = await verifyPreparedContributionFiles({
    directory: root,
    files: manifest.files,
  });
  if (stableJson(inspected) !== stableJson(manifest.files)) {
    fail("file_metadata");
  }
  return structuredClone(manifest);
}

export async function publishPreparedContributionFile({
  directory,
  name,
  content,
  failpoint = async () => {},
} = {}) {
  if (!CONTRIBUTION_BASENAME.test(name)
      || typeof failpoint !== "function") {
    fail("publication_invalid");
  }
  return publishOwnerOnlyFile({
    directory,
    name,
    content,
    maximumBytes: MAX_CONTRIBUTION_BYTES,
    failpoint,
  });
}

export async function publishPreparedContributionManifest({
  directory,
  manifest,
  builderVersion,
  failpoint = async () => {},
} = {}) {
  validateManifest(manifest, builderVersion);
  if (typeof failpoint !== "function") fail("publication_invalid");
  const root = await canonicalDirectory(directory);
  const content = stableJson(manifest);
  const stageName =
    `.prepared-contribution-set.${process.pid}.${randomUUID()}.stage`;
  const stage = await publishOwnerOnlyFile({
    directory: root,
    name: stageName,
    content,
    maximumBytes: MAX_MANIFEST_BYTES,
    failpoint: async () => {},
  });
  const stagePath = join(root, stageName);
  const manifestPath = join(root, PREPARED_CONTRIBUTION_SET_MANIFEST);
  let committed = false;
  try {
    await failpoint("after_manifest_stage");
    await link(stagePath, manifestPath);
    committed = true;
    await syncDirectory(root);
    await failpoint("after_manifest_commit");
    await unlink(stagePath);
    await syncDirectory(root);
  } catch (error) {
    try {
      await unlink(stagePath);
      await syncDirectory(root);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
  if (!committed) fail("publication_invalid");
  return {
    basename: PREPARED_CONTRIBUTION_SET_MANIFEST,
    sha256: stage.sha256,
    bytes: stage.bytes,
  };
}

async function publishOwnerOnlyFile({
  directory,
  name,
  content,
  maximumBytes,
  failpoint,
}) {
  const root = await canonicalDirectory(directory);
  if (basename(name) !== name
      || (!Buffer.isBuffer(content)
        && !(content instanceof Uint8Array)
        && typeof content !== "string")) {
    fail("publication_invalid");
  }
  const bytes = typeof content === "string"
    ? Buffer.from(content, "utf8")
    : Buffer.from(content);
  if (bytes.length < 1 || bytes.length > maximumBytes) {
    fail("publication_invalid");
  }
  const path = join(root, name);
  let handle;
  let identity = null;
  let durable = false;
  try {
    handle = await open(
      path,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat();
    assertFile(written, maximumBytes);
    if (written.size !== bytes.length) fail("publication_invalid");
    identity = { dev: written.dev, ino: written.ino };
    await failpoint("after_file_sync");
    await handle.close();
    handle = null;
    const pathStats = await lstat(path);
    assertFile(pathStats, maximumBytes);
    if (pathStats.dev !== identity.dev || pathStats.ino !== identity.ino
        || pathStats.size !== bytes.length) {
      fail("publication_invalid");
    }
    await syncDirectory(root);
    durable = true;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (!durable && identity) {
      try {
        const current = await lstat(path);
        if (current.isFile() && !current.isSymbolicLink()
            && current.dev === identity.dev && current.ino === identity.ino) {
          await unlink(path);
          await syncDirectory(root);
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw cleanupError;
      }
    }
    throw error;
  }
  return {
    basename: name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}
