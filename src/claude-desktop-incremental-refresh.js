import { createHash, createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import { openClaudeDesktopIncrementalCanonicalizer } from "./claude-desktop-incremental-canonicalizer.js";
import { openClaudeDesktopLedgerPrototype } from "./claude-desktop-ledger-prototype.js";
import { readClaudeDesktopPlanHistory } from "./claude-desktop-plan-history.js";
import { inventoryClaudeDesktopSources } from "./claude-desktop-source-inventory.js";
import { claudeDesktopWinnerToPricingRecord } from "./claude-desktop-pricing.js";
import { openClaudeDesktopPricingCache } from "./claude-desktop-pricing-cache.js";

// The row-rich pricing object is a local readability/debug surface. It is
// intentionally bounded because each row carries the full pricing detail and
// can otherwise turn a normal history refresh into an unbounded allocation.
// Five thousand winners is above the small-fixture/debug use case while still
// keeping an explicit developer opt-in within a predictable memory envelope.
export const CLAUDE_DESKTOP_DEBUG_PRICING_ROW_LIMIT = 5_000;

function debugPricingRowLimitError(winnerCount) {
  const error = new RangeError(
    `Claude Desktop debug pricing rows exceed the ${CLAUDE_DESKTOP_DEBUG_PRICING_ROW_LIMIT} winner limit`,
  );
  error.code = "claude_desktop_incremental_refresh_debug_pricing_row_limit";
  error.winnerCount = winnerCount;
  error.maximumWinnerCount = CLAUDE_DESKTOP_DEBUG_PRICING_ROW_LIMIT;
  return error;
}

function assertDebugPricingRowCount(winnerCount) {
  if (!Number.isSafeInteger(winnerCount) || winnerCount < 0) {
    throw new TypeError("Claude Desktop debug pricing winner count is invalid");
  }
  if (winnerCount > CLAUDE_DESKTOP_DEBUG_PRICING_ROW_LIMIT) {
    throw debugPricingRowLimitError(winnerCount);
  }
}

function elapsed(startedAt) {
  return Number((performance.now() - startedAt).toFixed(3));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function quotaSourceKey(secret, path) {
  return createHmac("sha256", secret)
    .update("app-usagemonitor/claude-desktop-incremental-quota-source/v1\0", "utf8")
    .update(path, "utf8")
    .digest("hex");
}

export function createClaudeDesktopLedgerCandidate({ candidate, sourceKey, sourceGeneration }) {
  const outputKind = Object.hasOwn(candidate, "outputKind")
    ? candidate.outputKind : "provider_reported_combined";
  const winner = { ...candidate, outputKind };
  const record = claudeDesktopWinnerToPricingRecord(winner);
  const modelDeclaration = {
    modelId: candidate.modelDeclaration.modelId,
    modelRecognition: candidate.modelDeclaration.modelRecognition,
    modelFingerprint: candidate.modelDeclaration.modelFingerprint,
  };
  return {
    provider: "anthropic_claude_code",
    logicalKey: candidate.occurrenceMaterial,
    candidateKey: sha256(stableJson({ sourceKey, sourceGeneration, candidate })),
    sourceKey,
    sourceGeneration,
    observedAtMs: Date.parse(record.eventTime),
    eventTime: record.eventTime,
    modelDeclaration,
    billingSurface: candidate.billingSurface,
    totalInputContextTokens: record.totalInputContextTokens,
    modelKey: sha256(stableJson(modelDeclaration)),
    inputUncachedTokens: record.components.inputUncachedTokens,
    inputCacheReadTokens: record.components.inputCacheReadTokens,
    inputCacheWriteTokens: record.components.inputCacheWriteTokens,
    inputCacheWrite5mTokens: record.components.inputCacheWrite5mTokens,
    inputCacheWrite1hTokens: record.components.inputCacheWrite1hTokens,
    outputTextTokens: null,
    outputReasoningTokens: null,
    outputCombinedTokens: record.components.outputCombinedTokens,
    outputKind,
    parserVersion: candidate.candidateVersion,
  };
}

function memoryReading() {
  const value = process.memoryUsage();
  return {
    rssBytes: value.rss,
    heapUsedBytes: value.heapUsed,
    externalBytes: value.external,
    arrayBuffersBytes: value.arrayBuffers,
  };
}

function updatePeak(target, value) {
  for (const key of Object.keys(value)) target[key] = Math.max(target[key] ?? 0, value[key]);
}

export async function runClaudeDesktopIncrementalRefresh({
  metadataDirectory,
  projectsDirectory,
  cleanupMarkerPath = null,
  quotaHistoryPath,
  canonicalPath,
  ledgerPath,
  pricingCachePath = null,
  includeDebugPricingRows = false,
  includeQuota = true,
  startAt,
  endAt,
  secret,
  shadowSink = null,
  signal = null,
} = {}) {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32
      || typeof canonicalPath !== "string" || typeof ledgerPath !== "string"
      || (pricingCachePath !== null
        && (typeof pricingCachePath !== "string" || pricingCachePath.length === 0))
      || typeof includeDebugPricingRows !== "boolean"
      || typeof includeQuota !== "boolean"
      || (includeQuota && (typeof quotaHistoryPath !== "string"
        || quotaHistoryPath.length === 0))
      || (signal !== null && (typeof signal !== "object"
        || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function"))
      || (shadowSink !== null && shadowSink !== undefined && typeof shadowSink !== "function")) {
    throw new TypeError("Claude Desktop incremental refresh configuration is invalid");
  }
  const key = Buffer.from(secret);
  const peakMemory = {};
  const sample = () => updatePeak(peakMemory, memoryReading());
  sample();
  const sampler = setInterval(sample, 5);
  sampler.unref?.();
  let canonicalizer;
  let ledger;
  let pricingCache;
  try {
    signal?.throwIfAborted?.();
    canonicalizer = openClaudeDesktopIncrementalCanonicalizer(canonicalPath, { secret: key });
    ledger = openClaudeDesktopLedgerPrototype(ledgerPath);
    const totalStartedAt = performance.now();
    let startedAt = performance.now();
    const inventory = await inventoryClaudeDesktopSources({
      metadataDirectory,
      projectsDirectory,
      cleanupMarkerPath,
      secret: key,
      includePrivatePlan: true,
      signal,
    });
    const inventoryMs = elapsed(startedAt);
    startedAt = performance.now();
    const canonical = await canonicalizer.refresh({
      sourcePaths: inventory.privatePlan.sourcePaths,
      startAt,
      endAt,
      observedAtMs: Date.parse(endAt),
      signal,
    });
    const canonicalizationMs = elapsed(startedAt);
    const {
      presentSources,
      missingSourceKeys,
      ...canonicalForProjection
    } = canonical;
    const sourceLifecycle = {
      ...ledger.markSourcesObserved("anthropic_claude_code", presentSources, {
        observedAtMs: Date.parse(endAt),
      }),
      missing: missingSourceKeys.length,
    };
    ledger.markSourcesMissing("anthropic_claude_code", missingSourceKeys, {
      observedAtMs: Date.parse(endAt),
    });
    const canonicalSummary = {
      sourceCount: canonical.sourceCount,
      unchangedSources: canonical.unchangedSources,
      appendedSources: canonical.appendedSources,
      rebuiltSources: canonical.rebuiltSources,
      missingSources: canonical.missingSources,
      parsedBytes: canonical.parsedBytes,
      observedSourceBytes: canonical.observedSourceBytes,
      parsedLines: canonical.parsedLines,
      assistantOccurrences: canonical.assistantOccurrences,
      dirtyGroupCount: canonical.dirtyGroupCount,
      candidateCount: canonical.candidates.length,
    };
    startedAt = performance.now();
    let inserted = 0;
    let superseded = 0;
    let tombstoned = 0;
    for (let offset = 0; offset < canonical.candidates.length; offset += 1_000) {
      signal?.throwIfAborted?.();
      const merged = ledger.mergeUsageCandidates(
        canonical.candidates.slice(offset, offset + 1_000).map(createClaudeDesktopLedgerCandidate),
        { acceptedAtMs: Date.parse(endAt) },
      );
      inserted += merged.inserted;
      superseded += merged.superseded;
      tombstoned += merged.tombstoned;
    }
    const merge = { inserted, superseded, tombstoned, elapsedMs: elapsed(startedAt) };

    let quotaParseMs = 0;
    let quotaMerge = null;
    if (includeQuota) {
      signal?.throwIfAborted?.();
      startedAt = performance.now();
      const quota = await readClaudeDesktopPlanHistory(quotaHistoryPath, { secret: key });
      quotaParseMs = elapsed(startedAt);
      signal?.throwIfAborted?.();
      startedAt = performance.now();
      quotaMerge = ledger.mergeQuotaObservations(quota.observations, {
        sourceKey: quotaSourceKey(key, quotaHistoryPath),
        acceptedAtMs: Date.parse(endAt),
      });
      quotaMerge.elapsedMs = elapsed(startedAt);
    }

    signal?.throwIfAborted?.();
    const beforeProjection = ledger.providerSummary("anthropic_claude_code");
    // Check the winner cardinality before opening a pricing cache or calling
    // the row-rich reader. This preserves the durable usage/quota work while
    // ensuring an oversized explicit debug request cannot materialize rows or
    // create a pricing-cache file as a side effect.
    if (includeDebugPricingRows) assertDebugPricingRowCount(beforeProjection.winnerCount);
    let projection = null;
    if (canonical.candidates.length > 0 || beforeProjection.generation === null) {
      startedAt = performance.now();
      projection = ledger.publishProjection("anthropic_claude_code", {
        publishedAtMs: Date.parse(endAt),
        signal,
      });
      projection.elapsedMs = elapsed(startedAt);
    }
    if (pricingCachePath !== null) pricingCache = openClaudeDesktopPricingCache(pricingCachePath);
    const pricingProjection = includeDebugPricingRows
      ? ledger.readPricingProjection("anthropic_claude_code")
      : null;
    // The bounded summary is always available. An explicitly requested cache
    // uses this same summary, and the debug flag may additionally request the
    // bounded row-rich view above.
    const pricingSummary = ledger.readPricingSummary(
      "anthropic_claude_code",
      {},
      { signal },
    );
    const pricingCachePublication = pricingCache
      ? pricingCache.publishProjection(pricingSummary, { publishedAtMs: Date.parse(endAt) })
      : null;
    const shadow = typeof shadowSink === "function"
      ? await shadowSink({
        canonical: {
          ...canonicalForProjection,
          snapshot: canonicalizer.snapshot(),
        },
        projection,
        pricingProjection,
        pricingSummary,
        acceptedAtMs: Date.parse(endAt),
      })
      : null;
    signal?.throwIfAborted?.();
    // Dirty canonical groups are acknowledged only after every durable
    // downstream publication succeeds. A failed pricing-cache or shadow
    // write therefore replays as harmless ledger/store duplicates instead of
    // stranding a newly merged winner without a current projection.
    canonicalizer.acknowledgeDirty(canonical.dirtyKeys);
    sample();
    return {
      status: inventory.status === "complete" ? "completed" : "partial_inventory",
      elapsedMs: elapsed(totalStartedAt),
      inventoryMs,
      canonicalizationMs,
      canonical: canonicalSummary,
      sourceLifecycle,
      merge,
      quotaParseMs,
      quotaMerge,
      projection,
      pricingProjection,
      pricingSummary,
      pricingCachePublication,
      shadow,
      canonicalSnapshot: canonicalizer.snapshot(),
      ledgerSnapshot: ledger.providerSummary("anthropic_claude_code"),
      peakMemory,
    };
  } finally {
    clearInterval(sampler);
    canonicalizer?.close();
    ledger?.close();
    pricingCache?.close();
    key.fill(0);
  }
}
