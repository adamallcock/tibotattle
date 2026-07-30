import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  loadVerifiedLocalMetadataBundleFiles,
} from "./bundle-verifier.js";
import {
  priceClaudeUsageRecord,
  priceCodexUsageEvent,
} from "./local-api-pricing.js";
import { addUsdStrings } from "./cost-ledger.js";
import { stableJson } from "./storage.js";
import {
  MAX_PREPARED_CONTRIBUTION_BATCHES,
  PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA,
  PREPARED_CONTRIBUTION_SET_MANIFEST,
  PREPARED_CONTRIBUTION_SET_VERSION,
  publishPreparedContributionFile,
  publishPreparedContributionManifest,
  verifyPreparedContributionFiles,
  verifyPreparedContributionSet,
} from "./telemetry-prepared-set.js";

export const TELEMETRY_CONTRIBUTION_VERSION = "telemetry-contribution-v0.1";
export const TELEMETRY_CONTRIBUTION_BUILDER_VERSION =
  "verified-bundle-to-telemetry-contribution-v0.1";

const MAX_TOTAL_RECORDS = 200;
const MAX_ACTIVITY_MARKERS = 100;
const POLICY_BOUNDARY = Date.parse("2026-07-09T00:00:00.000Z");

function fixedError(code) {
  const error = new Error(`Telemetry contribution build failed (${code})`);
  error.code = code;
  return error;
}

function nullableComponent(components, key) {
  const value = components?.[key];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizedComponents(record) {
  return {
    inputUncachedTokens: nullableComponent(record.components, "inputUncachedTokens"),
    inputCacheReadTokens: nullableComponent(record.components, "inputCacheReadTokens"),
    inputCacheWriteTokens: nullableComponent(record.components, "inputCacheWriteTokens"),
    inputCacheWrite5mTokens: nullableComponent(record.components, "inputCacheWrite5mTokens"),
    inputCacheWrite1hTokens: nullableComponent(record.components, "inputCacheWrite1hTokens"),
    outputTextTokens: nullableComponent(record.components, "outputTextTokens"),
    outputReasoningTokens: nullableComponent(record.components, "outputReasoningTokens"),
    outputCombinedTokens: nullableComponent(record.components, "outputCombinedTokens"),
  };
}

function coveragePercent(result) {
  const counts = result?.coverageCounts ?? {};
  const priced = Number(counts.pricedComponents ?? 0);
  const unpriced = Number(counts.unpricedComponents ?? 0);
  const unavailable = Number(counts.unavailableComponents ?? 0);
  const total = priced + unpriced + unavailable;
  return total === 0 ? 0 : Number(((100 * priced) / total).toFixed(6));
}

function unknownBillableUnits(result) {
  return Array.isArray(result?.components)
    ? result.components.filter((component) => component?.pricingStatus === "unpriced").length
    : 0;
}

function priceUsage(record, components) {
  try {
    if (record.provider === "openai_codex") {
      const sourceComponents = {
        input_uncached_tokens: components.inputUncachedTokens,
        input_cache_read_tokens: components.inputCacheReadTokens,
        input_cache_write_tokens: components.inputCacheWriteTokens,
        output_text_tokens: components.outputTextTokens,
        output_reasoning_tokens: components.outputReasoningTokens,
      };
      return priceCodexUsageEvent({
        timestamp: record.eventTime,
        model: record.modelRecognition === "recognized" ? record.modelId : "unknown",
        components: sourceComponents,
        componentAvailability: Object.fromEntries(
          Object.entries(sourceComponents).map(([key, value]) => [key, value !== null]),
        ),
      }, {
        apiServiceTier: record.apiServiceTier === "priority"
          || record.apiServiceTier === "flex"
          || record.apiServiceTier === "batch"
          ? record.apiServiceTier
          : "standard",
        priceEpochBasis: "current_price_sensitivity",
      });
    }
    if (record.provider === "anthropic_claude_code") {
      return priceClaudeUsageRecord({
        ...record,
        components,
      }, {
        apiServiceTier: "standard",
        priceEpochBasis: "current_price_sensitivity",
      });
    }
  } catch {
    // Pricing failure is represented explicitly below; it does not suppress
    // the otherwise valid privacy-safe usage observation.
  }
  return {
    totalUsd: "0",
    coverageStatus: "unpriced",
    coverageCounts: {
      pricedComponents: 0,
      unpricedComponents: 1,
      unavailableComponents: 0,
    },
    components: [{ pricingStatus: "unpriced" }],
  };
}

function transportUsage(record) {
  const components = normalizedComponents(record);
  const priced = priceUsage(record, components);
  const fullyUnpriced = priced.coverageStatus === "unpriced";
  return {
    schemaVersion: "usage-event-v0.1",
    eventTime: record.eventTime,
    provider: record.provider,
    modelId: record.modelId,
    modelRecognition: record.modelRecognition,
    modelFingerprint: record.modelFingerprint ?? null,
    billingSurface: record.billingSurface,
    speedMode: record.speedMode,
    apiServiceTier: record.apiServiceTier,
    reasoningEffort: record.reasoningEffort,
    components,
    totalInputContextTokens: Number.isSafeInteger(record.totalInputContextTokens)
      ? record.totalInputContextTokens
      : null,
    surface: record.surface,
    agentScope: record.agentScope,
    lineageDisposition: record.lineageDisposition,
    toolClassCounts: structuredClone(record.toolClassCounts),
    outcome: record.outcome,
    eventId: record.eventId,
    accounting: {
      estimatedApiCostUsd: fullyUnpriced ? null : sixDecimalUsd(priced.totalUsd),
      pricingCoveragePercent: coveragePercent(priced),
      unknownBillableUnits: unknownBillableUnits(priced),
      priceBasis: "current_api_prices",
    },
  };
}

function transportQuota(record) {
  return {
    schemaVersion: "quota-snapshot-v0.1",
    observedTime: record.observedTime,
    receivedTime: record.receivedTime,
    provider: record.provider,
    planType: record.planType,
    planVariant: record.planVariant,
    limitId: record.limitId,
    slot: record.slot,
    usedPercent: record.usedPercent,
    displayPrecision: record.displayPrecision,
    windowDurationMinutes: record.windowDurationMinutes,
    resetsAt: record.resetsAt,
    snapshotSource: record.snapshotSource,
    providerSurface: record.providerSurface,
    snapshotId: record.snapshotId,
  };
}

function transportMarker(record) {
  return {
    schemaVersion: "export-activity-marker-v0.1",
    observedTime: record.observedTime,
    surface: record.surface,
    state: record.state,
    agenticPoolCoupling: record.agenticPoolCoupling,
    planType: record.planType,
    planVariant: record.planVariant,
    markerId: record.markerId,
  };
}

function sixDecimalUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "0.000000";
  return number.toFixed(6);
}

function batchAccounting(usageEvents) {
  if (usageEvents.length === 0) {
    return {
      estimatedApiCostUsd: null,
      pricedEventCoveragePercent: 0,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "unpriced",
    };
  }
  const cost = usageEvents.reduce(
    (sum, row) => row.accounting.estimatedApiCostUsd === null
      ? sum
      : addUsdStrings(sum, row.accounting.estimatedApiCostUsd),
    "0",
  );
  const coverage = usageEvents.reduce(
    (sum, row) => sum + row.accounting.pricingCoveragePercent,
    0,
  ) / usageEvents.length;
  return {
    estimatedApiCostUsd: sixDecimalUsd(cost),
    pricedEventCoveragePercent: Number(coverage.toFixed(6)),
    unknownModelEventCount: usageEvents.filter((row) => row.modelId === "unknown").length,
    unknownBillableUnits: usageEvents.reduce(
      (sum, row) => sum + row.accounting.unknownBillableUnits,
      0,
    ),
    priceBasis: "current_api_prices",
  };
}

function providerPolicyEpoch(bundle) {
  const providers = new Set([
    ...bundle.records.usageEvents.map((record) => record.provider),
    ...bundle.records.quotaSnapshots.map((record) => record.provider),
  ]);
  if (providers.size !== 1) return "unknown";
  if (providers.has("anthropic_claude_code")) return "anthropic_unknown";
  if (!providers.has("openai_codex")) return "unknown";
  const start = Date.parse(bundle.coveredAt.startAt);
  const end = Date.parse(bundle.coveredAt.endAt);
  if (end <= POLICY_BOUNDARY) return "openai_pre_agentic_pool_2026_07_09";
  if (start >= POLICY_BOUNDARY) return "openai_agentic_pool_2026_07_09";
  return "unknown";
}

function assertTransportProjection(value) {
  const serialized = stableJson(value);
  if (/(?:accountScopeId|sessionScopeId|participantId|providerStateId)/u.test(serialized)) {
    throw fixedError("private_scope_leaked");
  }
  if (/(?:\/Users\/|\/home\/|file:\/\/|https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/iu.test(serialized)) {
    throw fixedError("content_canary_detected");
  }
  if (Buffer.byteLength(serialized, "utf8") > 1_250_000) {
    throw fixedError("batch_too_large");
  }
  return value;
}

export function buildTelemetryContributionsFromBundle(bundle) {
  if (!bundle || bundle.schemaVersion !== "usage-metadata-bundle-v0.1") {
    throw fixedError("bundle_invalid");
  }
  const entries = [
    ...bundle.records.usageEvents.map((record) => ({
      family: "usageEvents",
      observedAt: record.eventTime,
      id: record.eventId,
      value: transportUsage(record),
    })),
    ...bundle.records.quotaSnapshots.map((record) => ({
      family: "quotaSnapshots",
      observedAt: record.observedTime,
      id: record.snapshotId,
      value: transportQuota(record),
    })),
    ...bundle.records.activityMarkers.map((record) => ({
      family: "activityMarkers",
      observedAt: record.observedTime,
      id: record.markerId,
      value: transportMarker(record),
    })),
  ].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.family.localeCompare(right.family)
    || left.id.localeCompare(right.id)
  ));
  if (entries.length === 0) throw fixedError("bundle_empty");
  const batches = [];
  let batch = { usageEvents: [], quotaSnapshots: [], activityMarkers: [] };
  for (const entry of entries) {
    const total = batch.usageEvents.length
      + batch.quotaSnapshots.length
      + batch.activityMarkers.length;
    if (total >= MAX_TOTAL_RECORDS
        || (entry.family === "activityMarkers"
          && batch.activityMarkers.length >= MAX_ACTIVITY_MARKERS)) {
      batches.push(batch);
      batch = { usageEvents: [], quotaSnapshots: [], activityMarkers: [] };
    }
    batch[entry.family].push(entry.value);
  }
  if (batch.usageEvents.length + batch.quotaSnapshots.length + batch.activityMarkers.length > 0) {
    batches.push(batch);
  }
  const epoch = providerPolicyEpoch(bundle);
  if (batches.length > MAX_PREPARED_CONTRIBUTION_BATCHES) {
    throw fixedError("batch_count_invalid");
  }
  return batches.map(({ usageEvents, quotaSnapshots, activityMarkers }) => {
    return assertTransportProjection({
      schemaVersion: TELEMETRY_CONTRIBUTION_VERSION,
      synthetic: false,
      createdAt: bundle.createdAt,
      coveredAt: structuredClone(bundle.coveredAt),
      clientPlatform: bundle.clientPlatform,
      providerPolicyEpoch: epoch,
      usageEvents,
      quotaSnapshots,
      activityMarkers,
      accounting: batchAccounting(usageEvents),
    });
  });
}

export async function materializeTelemetryContributions({
  bundleFile,
  receiptFile,
  outputDirectory,
  failpoint = async () => {},
  signal = null,
} = {}) {
  if (!outputDirectory) throw fixedError("output_required");
  if (typeof failpoint !== "function") throw fixedError("failpoint_invalid");
  if (signal !== null
      && (typeof signal !== "object"
        || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function")) {
    throw fixedError("signal_invalid");
  }
  signal?.throwIfAborted?.();
  const verified = await loadVerifiedLocalMetadataBundleFiles({
    bundleFile,
    receiptFile,
  });
  signal?.throwIfAborted?.();
  const contributions = buildTelemetryContributionsFromBundle(verified.bundle);
  if (contributions.length > MAX_PREPARED_CONTRIBUTION_BATCHES) {
    throw fixedError("batch_count_invalid");
  }
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  signal?.throwIfAborted?.();
  const files = [];
  for (const [index, contribution] of contributions.entries()) {
    signal?.throwIfAborted?.();
    const content = stableJson(contribution);
    const file = join(
      directory,
      `telemetry-contribution-${String(index + 1).padStart(6, "0")}.json`,
    );
    const published = await publishPreparedContributionFile({
      directory,
      name: basename(file),
      content,
    });
    signal?.throwIfAborted?.();
    const counts = {
      usageEvents: contribution.usageEvents.length,
      quotaSnapshots: contribution.quotaSnapshots.length,
      activityMarkers: contribution.activityMarkers.length,
    };
    files.push({
      file,
      basename: published.basename,
      sha256: published.sha256,
      bytes: published.bytes,
      counts,
    });
    await failpoint("after_contribution_file", {
      index: index + 1,
      batchCount: contributions.length,
    });
    signal?.throwIfAborted?.();
  }
  const manifestFiles = await verifyPreparedContributionFiles({
    directory,
    files: files.map((file) => ({
      basename: file.basename,
      sha256: file.sha256,
      bytes: file.bytes,
      recordCounts: file.counts,
    })),
  });
  signal?.throwIfAborted?.();
  const manifest = {
    schemaVersion: PREPARED_CONTRIBUTION_SET_VERSION,
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    eligibleSchemaVersion: PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA,
    batchCount: manifestFiles.length,
    files: manifestFiles,
  };
  await failpoint("before_manifest", { batchCount: contributions.length });
  signal?.throwIfAborted?.();
  const publishedManifest = await publishPreparedContributionManifest({
    directory,
    manifest,
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    failpoint: (name) => failpoint(name, {
      batchCount: contributions.length,
    }),
  });
  signal?.throwIfAborted?.();
  await failpoint("after_manifest", { batchCount: contributions.length });
  signal?.throwIfAborted?.();
  await verifyPreparedContributionSet({
    directory,
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
  });
  signal?.throwIfAborted?.();
  return {
    schemaVersion: "telemetry-contribution-build-receipt-v0.1",
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    sourcePrivacyVerdict: verified.summary.verdict,
    sourceTransportReady: verified.summary.transportReady,
    outputDirectory: directory,
    batchCount: contributions.length,
    files,
    preparedSet: {
      schemaVersion: PREPARED_CONTRIBUTION_SET_VERSION,
      eligibleSchemaVersion: PREPARED_CONTRIBUTION_ELIGIBLE_SCHEMA,
      manifestBasename: PREPARED_CONTRIBUTION_SET_MANIFEST,
      manifestSha256: publishedManifest.sha256,
      manifestBytes: publishedManifest.bytes,
    },
  };
}
