import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createClaudeTranscriptExportCursor,
  createClaudeTranscriptExportPlanCheckpoint,
  createClaudeTranscriptExportSourcePlan,
  restoreClaudeTranscriptExportSourcePlan,
  scanClaudeTranscriptExportSource,
  sliceClaudeTranscriptExportSourcePlans,
} from "./claude-transcript-export-source.js";
import { inventoryClaudeDesktopSources } from "./claude-desktop-source-inventory.js";
import { readClaudeDesktopPlanHistory } from "./claude-desktop-plan-history.js";
import { openClaudeDesktopLedgerPrototype } from "./claude-desktop-ledger-prototype.js";
import { createExportResourceGuard } from "./export-resource-policy.js";

export const CLAUDE_DESKTOP_PHASE0_BENCHMARK_VERSION =
  "claude-desktop-phase0-benchmark-v0.2";

function elapsed(startedAt) {
  return Number((performance.now() - startedAt).toFixed(3));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function privateSourceKey(secret, path) {
  return createHmac("sha256", secret)
    .update("app-usagemonitor/claude-desktop-benchmark-quota-source/v1\0", "utf8")
    .update(path, "utf8")
    .digest("hex");
}

function normalizeSecret(secret) {
  if (secret === undefined) return randomBytes(32);
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) {
    throw new TypeError("Claude Desktop Phase 0 benchmark secret is invalid");
  }
  return Buffer.from(secret);
}

function candidateForLedger(candidate, sourceKey) {
  const candidateKey = sha256(stableJson(candidate));
  return {
    provider: "anthropic_claude_code",
    logicalKey: candidate.occurrenceMaterial,
    candidateKey,
    sourceKey,
    sourceGeneration: 1,
    observedAtMs: Date.parse(candidate.eventTime),
    modelKey: sha256(stableJson(candidate.modelDeclaration)),
    inputUncachedTokens: candidate.components.inputUncachedTokens,
    inputCacheReadTokens: candidate.components.inputCacheReadTokens,
    inputCacheWriteTokens: candidate.components.inputCacheWriteTokens,
    outputTextTokens: null,
    outputReasoningTokens: null,
    outputCombinedTokens: candidate.components.outputCombinedTokens,
    outputKind: "provider_reported_combined",
    parserVersion: candidate.candidateVersion,
  };
}

function emptyUsageMerge() {
  return { inserted: 0, superseded: 0, tombstoned: 0, elapsedMs: 0 };
}

function addUsageMerge(total, value, elapsedMs) {
  total.inserted += value.inserted;
  total.superseded += value.superseded;
  total.tombstoned += value.tombstoned;
  total.elapsedMs = Number((total.elapsedMs + elapsedMs).toFixed(3));
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

export async function benchmarkClaudeDesktopPhase0({
  metadataDirectory,
  projectsDirectory,
  cleanupMarkerPath = null,
  quotaHistoryPath,
  startAt,
  endAt,
  secret,
  temporaryRoot = tmpdir(),
  simulateRestartAfterCandidates = 10_000,
} = {}) {
  if (typeof quotaHistoryPath !== "string" || quotaHistoryPath.length === 0
      || typeof startAt !== "string" || typeof endAt !== "string"
      || !Number.isSafeInteger(simulateRestartAfterCandidates)
      || simulateRestartAfterCandidates < 1) {
    throw new TypeError("Claude Desktop Phase 0 benchmark configuration is invalid");
  }
  const key = normalizeSecret(secret);
  let stage = "setup";
  const peakMemoryByStage = {};
  const peakMemory = {};
  const sampleMemory = () => {
    const reading = memoryReading();
    updatePeak(peakMemory, reading);
    peakMemoryByStage[stage] ??= {};
    updatePeak(peakMemoryByStage[stage], reading);
  };
  sampleMemory();
  const sampler = setInterval(() => {
    sampleMemory();
  }, 5);
  sampler.unref?.();
  let root;
  try {
    root = await mkdtemp(join(temporaryRoot, "tibotattle-claude-phase0-"));
    await chmod(root, 0o700);

    stage = "inventory";
    let startedAt = performance.now();
    const inventory = await inventoryClaudeDesktopSources({
      metadataDirectory,
      projectsDirectory,
      cleanupMarkerPath,
      secret: key,
      includePrivatePlan: true,
    });
    const inventoryMs = elapsed(startedAt);

    stage = "canonicalization";
    startedAt = performance.now();
    let createdPlan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory,
      selectedSourcePaths: inventory.privatePlan.sourcePaths,
      startAt,
      endAt,
      secret: key,
      resourceGuard: createExportResourceGuard({ scope: "export_set" }),
    });
    const canonicalizationMs = elapsed(startedAt);
    let planCheckpoint = createClaudeTranscriptExportPlanCheckpoint(createdPlan, { secret: key });
    let checkpointText = JSON.stringify(planCheckpoint);
    const checkpointBytes = Buffer.byteLength(checkpointText);
    const plan = await restoreClaudeTranscriptExportSourcePlan(planCheckpoint, {
      projectsDirectory,
      selectedSourcePaths: inventory.privatePlan.sourcePaths,
      secret: key,
    });
    createdPlan = null;
    planCheckpoint = null;
    checkpointText = null;

    const ledgerPath = join(root, "phase0-ledger.sqlite");
    let ledger = openClaudeDesktopLedgerPrototype(ledgerPath);
    stage = "scan_merge";
    startedAt = performance.now();
    let candidateCount = 0;
    const merge = emptyUsageMerge();
    const sourcePlans = sliceClaudeTranscriptExportSourcePlans(plan, { secret: key });
    async function scanAndMerge({ repeated = false } = {}) {
      const totals = emptyUsageMerge();
      let scannedCandidates = 0;
      let restartCount = 0;
      const scanStartedAt = performance.now();
      for (const sourcePlan of sourcePlans) {
        const source = sourcePlan.sources[0];
        const persisted = ledger.readIngestCheckpoint(
          "anthropic_claude_code", plan.planSha256, source.sourceKey,
        );
        if (persisted?.complete) continue;
        let cursor = persisted?.cursor
          ?? createClaudeTranscriptExportCursor(sourcePlan, source.sourceKey, { secret: key });
        for (;;) {
          const scanned = await scanClaudeTranscriptExportSource(sourcePlan, source.sourceKey, {
            secret: key,
            cursor,
            maximumCandidateRecords: 1_000,
            resourceGuard: createExportResourceGuard({ scope: "export_set" }),
          });
          const batch = scanned.candidates.map((candidate) => candidateForLedger(candidate, source.sourceKey));
          const mergeStartedAt = performance.now();
          const merged = ledger.mergeUsageCandidates(batch, {
            acceptedAtMs: Date.parse(endAt),
            checkpoint: {
              provider: "anthropic_claude_code",
              planSha256: plan.planSha256,
              sourceKey: source.sourceKey,
              cursor: scanned.cursor,
              complete: scanned.complete,
            },
          });
          addUsageMerge(totals, merged, elapsed(mergeStartedAt));
          scannedCandidates += batch.length;
          cursor = scanned.cursor;
          if (!repeated && restartCount === 0
              && scannedCandidates >= simulateRestartAfterCandidates) {
            ledger.close();
            ledger = openClaudeDesktopLedgerPrototype(ledgerPath);
            if (!scanned.complete) {
              const resumed = ledger.readIngestCheckpoint(
                "anthropic_claude_code", plan.planSha256, source.sourceKey,
              );
              if (!resumed || resumed.complete) {
                throw new Error("Claude Desktop Phase 0 restart checkpoint is unavailable");
              }
              cursor = resumed.cursor;
            }
            restartCount += 1;
          }
          if (scanned.complete) break;
        }
      }
      return {
        candidateCount: scannedCandidates,
        elapsedMs: elapsed(scanStartedAt),
        merge: totals,
        repeated,
        restartCount,
      };
    }

    let quotaMerge;
    let projection;
    let unchangedRefresh;
    let quota;
    let quotaParseMs;
    try {
      const firstPass = await scanAndMerge();
      candidateCount = firstPass.candidateCount;
      Object.assign(merge, firstPass.merge);
      const scanMs = firstPass.elapsedMs;

      stage = "quota";
      startedAt = performance.now();
      quota = await readClaudeDesktopPlanHistory(quotaHistoryPath, { secret: key });
      quotaParseMs = elapsed(startedAt);
      const quotaMergeStartedAt = performance.now();
      quotaMerge = ledger.mergeQuotaObservations(quota.observations, {
        sourceKey: privateSourceKey(key, quotaHistoryPath),
        acceptedAtMs: Date.parse(endAt),
      });
      quotaMerge.elapsedMs = elapsed(quotaMergeStartedAt);

      stage = "projection";
      startedAt = performance.now();
      projection = ledger.publishProjection("anthropic_claude_code", {
        publishedAtMs: Date.parse(endAt),
      });
      const projectionMs = elapsed(startedAt);

      stage = "unchanged_refresh";
      const repeatedUsage = await scanAndMerge({ repeated: true });
      startedAt = performance.now();
      const repeatedQuota = ledger.mergeQuotaObservations(quota.observations, {
        sourceKey: privateSourceKey(key, quotaHistoryPath),
        acceptedAtMs: Date.parse(endAt),
      });
      unchangedRefresh = {
        scope: "checkpoint_and_preparsed_quota_merge_only",
        elapsedMs: Number((repeatedUsage.elapsedMs + elapsed(startedAt)).toFixed(3)),
        candidateCount: repeatedUsage.candidateCount,
        insertedUsageCandidates: repeatedUsage.merge.inserted,
        insertedQuotaRevisions: repeatedQuota.inserted,
      };
      projection.elapsedMs = projectionMs;

      stage = "finalize";
      sampleMemory();
      const databaseBytes = (await lstat(ledgerPath)).size;
      return {
        schemaVersion: CLAUDE_DESKTOP_PHASE0_BENCHMARK_VERSION,
        status: inventory.status === "complete" ? "completed" : "partial_inventory",
        interval: { startAt, endAt },
        inventory: {
          elapsedMs: inventoryMs,
          metadataFiles: inventory.metadataFileCount,
          selectedParents: inventory.statusCounts.selected ?? 0,
          selectedChildren: inventory.selectedChildTranscriptCount,
          missingParents: inventory.statusCounts.parent_missing ?? 0,
          orphanTranscripts: inventory.orphanTranscriptCount,
        },
        canonicalization: {
          elapsedMs: canonicalizationMs,
          sourceFiles: plan.sourceCount,
          sourceBytes: plan.totalBytes,
          selectedLogicalMessages: plan.sources.reduce(
            (sum, source) => sum + source.selectedMessages,
            0,
          ),
        },
        scan: { elapsedMs: scanMs, candidateCount, restartCount: firstPass.restartCount },
        quota: {
          elapsedMs: quotaParseMs,
          samples: quota.sampleCount,
          observations: quota.observationCount,
          accounts: quota.accountCount,
        },
        merge,
        quotaMerge,
        projection,
        unchangedRefresh,
        databaseBytes,
        checkpointBytes,
        peakRssBytes: peakMemory.rssBytes,
        peakMemory,
        peakMemoryByStage,
      };
    } finally {
      ledger.close();
    }
  } finally {
    clearInterval(sampler);
    key.fill(0);
    if (root) await rm(root, { recursive: true, force: true });
  }
}
