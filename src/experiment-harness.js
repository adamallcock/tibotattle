import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findCodexBinary,
  readCodexAccountSnapshot,
  sanitizeCodexAccountSnapshot,
} from "./providers/codex/account.js";
import { scanAndPriceCodexLogs } from "./codex-local-usage-analysis.js";
import { scanCodexLogEvents } from "./codex-log-scan.js";
import { stableJson } from "./export/index.js";
import { subscriptionSpeedSensitivity } from "./application/index.js";
import { validateTierDeclaration } from "./providers/codex/logs.js";
import {
  apiPriceResolutionSummary,
  costWarningCodes,
  priceCodexUsageEvent,
} from "@app-usagemonitor/accounting";

const MANIFEST_SCHEMA_VERSION = "0.3";
const RESULT_SCHEMA_VERSION = "0.3";
const ALLOWED_MODES = new Set(["dry", "sample", "live"]);
const ALLOWED_CACHE_STATES = new Set(["uncached", "repeat_expected", "unspecified"]);
const ALLOWED_TOOL_CLASSES = new Set(["none", "web_search", "file_search", "code_interpreter", "computer_use", "mcp", "local_shell", "subagent"]);

const WORKLOADS = {
  "no-tool-arithmetic-v1": {
    buildPrompt: () => "Do not use any tools. Compute 271828 + 314159 and reply with only the integer result.",
    expectedToolClass: "none",
  },
  "no-tool-arithmetic-repeat-v1": {
    buildPrompt: () => "Do not use any tools. Compute 271828 + 314159 and reply with only the integer result.",
    expectedToolClass: "none",
  },
  "no-tool-context-below-band-v1": {
    buildPrompt: () => `Do not use tools. Read the deterministic context and reply only with the number of times the word alpha appears.\n${"alpha beta gamma delta ".repeat(65_000)}`,
    expectedToolClass: "none",
  },
  "no-tool-context-above-band-v1": {
    buildPrompt: () => `Do not use tools. Read the deterministic context and reply only with the number of times the word alpha appears.\n${"alpha beta gamma delta ".repeat(80_000)}`,
    expectedToolClass: "none",
  },
};

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) throw new Error(`${field} must be a non-empty string of at most 200 characters`);
}

function requirePositive(value, field) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be a positive number`);
}

export function validateExperimentManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) throw new Error(`manifest schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  requireString(manifest.experimentId, "experimentId");
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(manifest.experimentId)) throw new Error("experimentId must be a safe lowercase identifier");
  requireString(manifest.hypothesis, "hypothesis");
  if (!ALLOWED_MODES.has(manifest.mode)) throw new Error("mode must be dry, sample, or live");
  requireString(manifest.model, "model");
  requireString(manifest.reasoningEffort, "reasoningEffort");
  validateTierDeclaration(manifest.tierDeclaration);
  if (!WORKLOADS[manifest.workloadId]) throw new Error(`unknown workloadId: ${manifest.workloadId}`);
  if (!ALLOWED_CACHE_STATES.has(manifest.cacheState)) throw new Error("cacheState is invalid");
  if (!ALLOWED_TOOL_CLASSES.has(manifest.permittedToolClass)) throw new Error("permittedToolClass is invalid");
  if (WORKLOADS[manifest.workloadId].expectedToolClass !== manifest.permittedToolClass) {
    throw new Error("workload tool class does not match permittedToolClass");
  }
  requirePositive(manifest.contextBand?.targetInputTokens, "contextBand.targetInputTokens");
  requirePositive(manifest.contextBand?.maximumInputTokens, "contextBand.maximumInputTokens");
  if (manifest.contextBand.targetInputTokens > manifest.contextBand.maximumInputTokens) throw new Error("targetInputTokens exceeds maximumInputTokens");
  requirePositive(manifest.projectedUsage?.outputTextTokens, "projectedUsage.outputTextTokens");
  for (const key of ["inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens", "outputReasoningTokens"]) {
    if (!Number.isFinite(manifest.projectedUsage?.[key]) || manifest.projectedUsage[key] < 0) throw new Error(`projectedUsage.${key} must be non-negative`);
  }
  requirePositive(manifest.budgets?.maximumTurns, "budgets.maximumTurns");
  requirePositive(manifest.budgets?.maximumElapsedMs, "budgets.maximumElapsedMs");
  requirePositive(manifest.budgets?.maximumApiPricedUsd, "budgets.maximumApiPricedUsd");
  requirePositive(manifest.budgets?.maximumDisplayedQuotaMovement, "budgets.maximumDisplayedQuotaMovement");
  requirePositive(manifest.budgets?.minimumQuotaHeadroomPercent, "budgets.minimumQuotaHeadroomPercent");
  requirePositive(manifest.budgets?.minimumQuietPeriodMs, "budgets.minimumQuietPeriodMs");
  if (manifest.budgets.maximumTurns !== 1) throw new Error("v0.3 pilots are restricted to exactly one turn");
  if (manifest.budgets.maximumDisplayedQuotaMovement > 1) throw new Error("maximumDisplayedQuotaMovement may not exceed one percentage point");
  if (manifest.budgets.minimumQuotaHeadroomPercent < 5) throw new Error("minimumQuotaHeadroomPercent must be at least five points");
  if (manifest.concurrency !== "none") throw new Error("v0.3 requires concurrency: none");
  if (manifest.requiredCaptures?.before !== true || manifest.requiredCaptures?.after !== true) throw new Error("before and after captures are required");
  return manifest;
}

function projectedComponents(manifest) {
  return {
    input_uncached_tokens: manifest.projectedUsage.inputUncachedTokens,
    input_cache_read_tokens: manifest.projectedUsage.inputCacheReadTokens,
    input_cache_write_tokens: manifest.projectedUsage.inputCacheWriteTokens,
    output_text_tokens: manifest.projectedUsage.outputTextTokens,
    output_reasoning_tokens: manifest.projectedUsage.outputReasoningTokens,
  };
}

async function priceProjection(manifest, { offline, priceCards }) {
  const components = projectedComponents(manifest);
  const inputTotal = components.input_uncached_tokens + components.input_cache_read_tokens + components.input_cache_write_tokens;
  const priced = priceCodexUsageEvent({
    timestamp: new Date().toISOString(),
    model: manifest.model,
    raw: { input_tokens: inputTotal },
    components,
    componentAvailability: Object.fromEntries(Object.keys(components).map((name) => [name, true])),
  }, {
    priceCards,
  });
  const warningCodes = costWarningCodes(priced);
  const coverageWarningCodes = priced.warnings.coverage.map((warning) => warning.code).sort();
  return {
    totalUsd: Number(priced.totalUsd),
    totalUsdExact: priced.totalUsd,
    components,
    coverageStatus: priced.coverageStatus,
    warningCodes,
    coverageWarningCodes,
    priceCardIds: priced.selectedPriceCardIds,
    priceResolution: apiPriceResolutionSummary({ priceCards }),
    tierSemantics: manifest.tierDeclaration,
    subscriptionSpeedSensitivity: subscriptionSpeedSensitivity({
      [manifest.model]: { costUsd: Number(priced.totalUsd) },
    }, manifest.tierDeclaration.codexSpeedMode),
  };
}

function canonicalWindows(snapshot, capturedAt) {
  const account = sanitizeCodexAccountSnapshot(snapshot, capturedAt);
  return ["primary", "secondary"].flatMap((slot) => {
    const window = account.canonical?.[slot];
    if (!window) return [];
    return [{
      provider: "openai_codex",
      planType: account.canonical.planType ?? "unknown",
      limitId: account.canonical.limitId ?? "unknown",
      slot,
      usedPercent: window.usedPercent,
      windowDurationMins: window.windowDurationMins,
      resetsAt: window.resetsAt,
    }];
  });
}

function preflightStops(manifest, projection, windows) {
  const stops = [];
  if (projection.coverageWarningCodes.length > 0) stops.push("pricing_warning");
  if (projection.totalUsd > manifest.budgets.maximumApiPricedUsd) stops.push("projected_api_price_budget_exceeded");
  if (windows.length === 0) stops.push("quota_window_unavailable");
  for (const window of windows) {
    if (100 - window.usedPercent < manifest.budgets.minimumQuotaHeadroomPercent) stops.push("insufficient_quota_headroom");
  }
  return [...new Set(stops)].sort();
}

async function probeRecentCodexActivity({ endAtMs, lookbackMs, controllerSessionId = null }) {
  const startAt = new Date(endAtMs - lookbackMs).toISOString();
  const endAt = new Date(endAtMs).toISOString();
  const excludeController = typeof controllerSessionId === "string" && controllerSessionId.length > 0;
  const rollouts = new Set();
  let usageEvents = 0;
  let lastUsageAt = null;
  const scanned = await scanCodexLogEvents({
    startAt,
    endAt,
    excludeSessionIds: excludeController ? [controllerSessionId] : [],
    activeTaskRecencyMs: Math.max(300_000, lookbackMs),
    onUsage(event) {
      usageEvents += 1;
      rollouts.add(event.sourceRolloutOrdinal);
      if (lastUsageAt === null || event.timestamp > lastUsageAt) lastUsageAt = event.timestamp;
    },
  });
  return {
    lookbackMs,
    usageEvents,
    usageBearingRollouts: rollouts.size,
    lastUsageAt,
    controllerExclusionApplied: excludeController,
    excludedControllerRollouts: scanned.diagnostics.excludedRollouts,
    activeTaskRolloutsAtEnd: scanned.diagnostics.activeTaskRolloutsAtEnd,
    activeTaskRecencyMs: Math.max(300_000, lookbackMs),
  };
}

function quotaChanges(before, after) {
  // Identity is (limit, duration, resetsAt); slot is a server-assigned UI
  // role that can flip between captures without the window itself changing.
  const byIdentity = new Map(before.map((window) => [[window.limitId, window.windowDurationMins, window.resetsAt].join("|"), window]));
  return after.map((window) => {
    const key = [window.limitId, window.windowDurationMins, window.resetsAt].join("|");
    const prior = byIdentity.get(key);
    return {
      limitId: window.limitId,
      slot: window.slot,
      windowDurationMins: window.windowDurationMins,
      resetsAt: window.resetsAt,
      beforeUsedPercent: prior?.usedPercent ?? null,
      afterUsedPercent: window.usedPercent,
      displayedMovement: prior ? window.usedPercent - prior.usedPercent : null,
      resetChangedOrMissingBefore: !prior,
    };
  });
}

export function environmentForWorkload(environment = process.env) {
  const workloadEnvironment = { ...environment };
  delete workloadEnvironment.CODEX_THREAD_ID;
  return workloadEnvironment;
}

async function spawnWorkload(manifest, { timeoutMs, spawnProcess = spawn }) {
  const binary = await findCodexBinary();
  const workingDirectory = await mkdtemp(join(tmpdir(), "app-usagemonitor-pilot-"));
  const workload = WORKLOADS[manifest.workloadId];
  try {
    const args = [
      "exec",
      "--model", manifest.model,
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--color", "never",
      "-c", `model_reasoning_effort=\"${manifest.reasoningEffort}\"`,
      "-C", workingDirectory,
      "-",
    ];
    if (manifest.tierDeclaration.billingSurface !== "openai_api" && manifest.tierDeclaration.codexSpeedMode !== "unknown") {
      const providerTier = manifest.tierDeclaration.codexSpeedMode === "standard" ? "default" : "priority";
      args.splice(args.length - 2, 0, "-c", `service_tier=\"${providerTier}\"`);
    }
    const workloadEnvironment = environmentForWorkload();
    const child = spawnProcess(binary, args, { stdio: ["pipe", "ignore", "ignore"], env: workloadEnvironment });
    child.stdin.end(`${workload.buildPrompt()}\n`);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`workload_timeout:${timeoutMs}`));
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve({ exitCode: 0 });
        else reject(new Error(`workload_failed:${code ?? signal}`));
      });
    });
  } finally {
    await rm(workingDirectory, { recursive: true });
  }
}

export async function runExperiment({
  manifest,
  executeLive = false,
  offline = false,
  priceCards = null,
  clock = () => Date.now(),
  readSnapshot = () => readCodexAccountSnapshot(),
  executeWorkload = spawnWorkload,
  scanUsage = (options) => scanAndPriceCodexLogs(options),
  controllerSessionId = process.env.CODEX_THREAD_ID ?? null,
  readConcurrency = ({ endAtMs, lookbackMs }) => probeRecentCodexActivity({
    endAtMs,
    lookbackMs,
    controllerSessionId,
  }),
} = {}) {
  validateExperimentManifest(manifest);
  const projection = await priceProjection(manifest, { offline, priceCards });
  const manifestHash = createHash("sha256").update(stableJson(manifest)).digest("hex");
  const base = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    kind: "controlled_micro_workload_result",
    experimentId: manifest.experimentId,
    manifestHash,
    declaredMode: manifest.mode,
    workloadId: manifest.workloadId,
    model: manifest.model,
    reasoningEffort: manifest.reasoningEffort,
    tierSemantics: manifest.tierDeclaration,
    cacheState: manifest.cacheState,
    permittedToolClass: manifest.permittedToolClass,
    concurrency: manifest.concurrency,
    budgets: manifest.budgets,
    projection,
    privacy: {
      promptStored: false,
      responseStored: false,
      sessionIdentifierStored: false,
      repositoryPathStored: false,
      toolArgumentsStored: false,
    },
  };
  if (manifest.mode !== "live" || !executeLive) {
    return {
      ...base,
      status: "dry_run_only",
      controlledState: "not_executed",
      stopReasons: manifest.mode === "live" && !executeLive ? ["live_execution_flag_required"] : [],
    };
  }

  const beforeSnapshot = await readSnapshot();
  const beforeCapturedAt = new Date(clock()).toISOString();
  const beforeWindows = canonicalWindows(beforeSnapshot, beforeCapturedAt);
  const stopReasons = preflightStops(manifest, projection, beforeWindows);
  const concurrencyPreflight = await readConcurrency({
    endAtMs: Date.parse(beforeCapturedAt),
    lookbackMs: manifest.budgets.minimumQuietPeriodMs,
  });
  if (concurrencyPreflight.usageEvents > 0) stopReasons.push("recent_local_activity_detected");
  if ((concurrencyPreflight.activeTaskRolloutsAtEnd ?? 0) > 0) stopReasons.push("active_local_task_detected");
  stopReasons.sort();
  if (stopReasons.length > 0) {
    return {
      ...base,
      status: "preflight_refused",
      controlledState: "not_executed",
      before: { capturedAt: beforeCapturedAt, windows: beforeWindows },
      concurrencyPreflight,
      stopReasons,
    };
  }

  const startedAtMs = clock();
  const startedAt = new Date(startedAtMs).toISOString();
  let workloadOutcome;
  try {
    workloadOutcome = await executeWorkload(manifest, { timeoutMs: manifest.budgets.maximumElapsedMs });
  } catch (error) {
    return {
      ...base,
      status: "workload_failed",
      controlledState: "unknown",
      before: { capturedAt: beforeCapturedAt, windows: beforeWindows },
      concurrencyPreflight,
      startedAt,
      endedAt: new Date(clock()).toISOString(),
      stopReasons: [String(error.message).split(":")[0]],
    };
  }
  const endedAtMs = clock();
  const endedAt = new Date(endedAtMs).toISOString();
  const afterCapturedAt = new Date(clock()).toISOString();
  const afterWindows = canonicalWindows(await readSnapshot(), afterCapturedAt);
  const changes = quotaChanges(beforeWindows, afterWindows);
  const excludeController = typeof controllerSessionId === "string" && controllerSessionId.length > 0;
  const local = await scanUsage({
    startAt: startedAt,
    endAt: endedAt,
    offline,
    excludeSessionIds: excludeController ? [controllerSessionId] : [],
  });
  const postStops = [];
  const usageBearingRollouts = local.diagnostics?.usageBearingRollouts ?? null;
  const concurrentLocalUsageDetected = usageBearingRollouts === null ? null : usageBearingRollouts > 1;
  const observedToolClasses = local.toolCallsByClass ?? local.toolCalls ?? {};
  const observedToolCount = Object.values(observedToolClasses).reduce((sum, count) => sum + count, 0);
  if (endedAtMs - startedAtMs > manifest.budgets.maximumElapsedMs) postStops.push("elapsed_budget_exceeded");
  if (local.runcost.totalUsd > manifest.budgets.maximumApiPricedUsd) postStops.push("measured_api_price_budget_exceeded");
  if (Object.keys(local.runcost.warningCounts).length > 0) postStops.push("pricing_warning");
  if (usageBearingRollouts === null) postStops.push("concurrency_evidence_unavailable");
  else if (usageBearingRollouts === 0) postStops.push("workload_usage_not_observed");
  else if (concurrentLocalUsageDetected) postStops.push("concurrent_local_usage_detected");
  if (manifest.permittedToolClass === "none" && observedToolCount > 0) postStops.push("unexpected_tool_activity");
  if (manifest.permittedToolClass !== "none"
      && Object.keys(observedToolClasses).some((toolClass) => toolClass !== manifest.permittedToolClass)) {
    postStops.push("unexpected_tool_activity");
  }
  if (changes.some((change) => change.resetChangedOrMissingBefore)) postStops.push("reset_changed");
  if (changes.some((change) => change.displayedMovement !== null && Math.abs(change.displayedMovement) > manifest.budgets.maximumDisplayedQuotaMovement)) {
    postStops.push("displayed_quota_movement_budget_exceeded");
  }
  return {
    ...base,
    status: postStops.length === 0 ? "completed" : "completed_with_stop",
    controlledState: postStops.length === 0 ? "controlled" : "unknown",
    startedAt,
    endedAt,
    elapsedMs: endedAtMs - startedAtMs,
    workloadOutcome,
    before: { capturedAt: beforeCapturedAt, windows: beforeWindows },
    concurrencyPreflight,
    after: { capturedAt: afterCapturedAt, windows: afterWindows },
    quotaChanges: changes,
    measuredLocal: {
      apiPricedUsd: local.runcost.totalUsd,
      components: local.components,
      models: local.runcost.byModel,
      warningCounts: local.runcost.warningCounts,
      diagnostics: local.diagnostics,
      observedToolClasses,
      tierSemantics: manifest.tierDeclaration,
      subscriptionSpeedSensitivity: subscriptionSpeedSensitivity(local.runcost.byModel, manifest.tierDeclaration.codexSpeedMode),
    },
    concurrencyEvidence: {
      declared: manifest.concurrency,
      usageBearingRollouts,
      concurrentLocalUsageDetected,
      controllerExclusionApplied: excludeController,
      excludedControllerRollouts: local.diagnostics?.excludedRollouts ?? 0,
      basis: "distinct_non_controller_rollout_files_with_retained_usage_during_the_measured_interval",
    },
    stopReasons: postStops.sort(),
  };
}
