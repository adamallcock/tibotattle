#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { captureCodexObservation } from "./capture.js";
import {
  readCodexAccountSnapshot,
  sanitizeCodexAccountSnapshotWithSecretLoader,
} from "./codex-app-server.js";
import { selectProductionAccountObservationSecret } from "./account-observation-production.js";
import { analyzeObservations } from "./analyze.js";
import { mineCodexTransitions, renderTransitionAudit } from "./codex-transition-miner.js";
import { inferCapacityFromTransitions, renderInferenceReport } from "./interval-inference.js";
import { runExperiment } from "./experiment-harness.js";
import { analyzeContamination, renderContaminationReport } from "./contamination-analysis.js";
import { appendedRolloutSourcesAreAfterEnd, codexLogSourceFingerprint, scanAndPriceCodexLogs, scanCodexLogEvents } from "./codex-log-scan.js";
import { analyzeToolMechanisms, renderToolMechanismReport, REQUIRED_TOOL_CLASSES } from "./tool-mechanism-analysis.js";
import { planBaselineCorrectionMigration } from "./correction-migration.js";
import { analyzeWeeklyLimitHistory, renderWeeklyLimitHistoryReport } from "./weekly-limit-history.js";
import { renderCorrectionReport, resolveCorrections } from "./corrections.js";
import { analyzeProviderCrosscheck, renderProviderCrosscheckReport } from "./provider-crosscheck.js";
import { analyzeMonitoringQuality, renderMonitoringQualityReport } from "./monitoring-quality.js";
import { analyzeWeeklyCalibration, renderWeeklyCalibrationReport } from "./weekly-calibration.js";
import { upsertPlanProfile, validatePlanTimeline } from "./plan-timeline.js";
import { createActivityMarker } from "./activity-markers.js";
import {
  inspectParticipantSecret,
  rotateParticipantSecret,
  withParticipantSecretLease,
} from "./export-identity.js";
import {
  renderParticipantIdentityBackendMode,
  renderParticipantIdentityFileResidueState,
  renderParticipantIdentitySourceState,
  selectProductionParticipantIdentity,
} from "./export-identity-production.js";
import { buildLocalMetadataBundle, renderMetadataExportPreview, writeLocalMetadataBundle } from "./metadata-exporter.js";
import { verifyLocalMetadataBundleFiles } from "./bundle-verifier.js";
import {
  createLocalExportWorkspace,
  inspectLocalExportWorkspace,
  resumeLocalExportWorkspace,
} from "./export-set-controller.js";
import { materializeLocalExportSet } from "./export-set-materializer.js";
import { verifyLocalExportSet } from "./export-set-verifier.js";
import { planLocalExportDeletion } from "./export-deletion.js";
import { deleteLocalExport, recoverLocalExportDeletion } from "./export-deletion-executor.js";
import { planLocalExportWorkspaceDiscard } from "./export-workspace-discard.js";
import {
  discardLocalExportWorkspace,
  recoverLocalExportWorkspaceDiscard,
} from "./export-workspace-discard-executor.js";
import { readBoundedJsonLines } from "./bounded-jsonl.js";
import { createExportResourceGuard, DEFAULT_EXPORT_RESOURCE_LIMITS } from "./export-resource-policy.js";
import {
  createProductionClaudeCallbackBackend,
  readClaudeCallbackCapability,
} from "./claude-callback-capability.js";
import {
  inspectClaudeCallbackLifecycle,
  installClaudeCallback,
  planManagedClaudeCallbackCapabilityRemoval,
  recoverClaudeCallbackLifecycle,
  removeManagedClaudeCallbackCapability,
  rotateManagedClaudeCallbackCapability,
  uninstallClaudeCallback,
} from "./claude-callback-lifecycle.js";
import { runR7SmokeBenchmark } from "./r7-resource-benchmark.js";
import {
  defaultCollectorCheckpointFile,
  defaultCollectorDataFile,
  defaultCollectorLockFile,
  runCollectorForeground,
  runCollectorOnce,
} from "./passive-collector.js";
import {
  appendObservation,
  appendJsonLinesOwnerOnly,
  defaultContaminationFile,
  defaultContaminationReportFile,
  defaultCorrectionReportFile,
  defaultCorrectionsFile,
  defaultDataFile,
  defaultExperimentResultsFile,
  defaultEffectiveObservationsFile,
  defaultInferenceFile,
  defaultInferenceReportFile,
  defaultTransitionAuditFile,
  defaultTransitionFile,
  frozenTransitionFile,
  defaultToolMechanismFile,
  defaultToolMechanismReportFile,
  defaultWeeklyHistoryFile,
  defaultWeeklyHistoryReportFile,
  defaultPlanTimelineFile,
  defaultProviderUiObservationFile,
  defaultProviderCrosscheckFile,
  defaultProviderCrosscheckReportFile,
  defaultLocalHistoryFile,
  defaultLocalHistoryCacheValidationFile,
  defaultMonitoringQualityFile,
  defaultMonitoringQualityReportFile,
  defaultWeeklyCalibrationFile,
  defaultWeeklyCalibrationReportFile,
  defaultActivityMarkerFile,
  readObservations,
  readJsonIfExists,
  writeJsonOwnerOnlyAtomic,
  writeOwnerOnlyAtomic,
  recoverOwnerOnlyPairTransactions,
  withOwnerOnlyFileLock,
} from "./storage.js";

function usage() {
  console.log(`Usage:
  usage-monitor doctor
  usage-monitor register-account --alias LOCAL_ALIAS --default-plan PLAN_VARIANT [--plan-timeline PATH]
  usage-monitor capture [--label TEXT] [--controlled] [--offline] [--plan-timeline PATH] [--data-file PATH]
  usage-monitor report [--json] [--data-file PATH] [--corrections PATH]
  usage-monitor transitions --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--offline] [--compact] [--window-minutes N] [--output PATH] [--audit-file PATH]
  usage-monitor infer [--input PATH] [--output PATH] [--report-file PATH]
  usage-monitor history [--input PATH] [--output PATH] [--report-file PATH]
  usage-monitor crosscheck --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--input LOCAL_HISTORY_PATH] [--allow-stale-cache] [--offline] [--plan-timeline PATH] [--provider-ui PATH] [--output PATH] [--report-file PATH]
  usage-monitor quality [--input TRANSITIONS_PATH] [--collector-file PATH] [--output PATH] [--report-file PATH]
  usage-monitor calibrate-weekly [--input TRANSITIONS_PATH] [--output PATH] [--report-file PATH]
  usage-monitor mark-activity --surface SURFACE --state start|end|pulse [--experiment-id ID] [--activity-file PATH]
  usage-monitor inspect-export --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--codex-home PATH] [--activity-file PATH] [--secret-file PATH]
  usage-monitor export-local --since ISO_TIMESTAMP --until ISO_TIMESTAMP --output PATH [--receipt PATH] [--codex-home PATH] [--activity-file PATH] [--secret-file PATH]
  usage-monitor verify-bundle --input PATH [--receipt PATH]
  usage-monitor export-set --workspace PATH --directory PATH [--resume] [--since ISO_TIMESTAMP --until ISO_TIMESTAMP] [--codex-home PATH] [--collector-file PATH] [--claude-status | --claude-state-dir PATH] [--claude-usage] [--claude-projects-dir PATH] [--activity-file PATH] [--secret-file PATH] [--max-records-per-chunk N] [--max-bundle-bytes N] [--max-artifact-bytes N]
  usage-monitor inspect-export-workspace --workspace PATH
  usage-monitor verify-export-set --directory PATH
  usage-monitor delete-local-export --workspace PATH --directory PATH [--confirm-deletion TOKEN]
  usage-monitor recover-local-export-deletion --workspace PATH --directory PATH
  usage-monitor discard-export-workspace --workspace PATH [--confirm-discard TOKEN]
  usage-monitor recover-export-workspace-discard --workspace PATH
  usage-monitor recover-exports --directory PATH
  usage-monitor rotate-local-identity [--secret-file PATH] [--confirm]
  usage-monitor inspect-claude-callback
  usage-monitor install-claude-callback
  usage-monitor uninstall-claude-callback
  usage-monitor recover-claude-callback
  usage-monitor rotate-claude-callback-identity [--confirm]
  usage-monitor remove-claude-callback-identity [--confirm-removal TOKEN]
  usage-monitor benchmark-r7 --profile smoke --output PATH
  usage-monitor collect-once [--stale-after-ms N] [--no-refresh] [--backfill] [--data-file PATH] [--checkpoint-file PATH]
  usage-monitor collect-foreground [--stale-after-ms N] [--reconciliation-ms N] [--duration-ms N] [--data-file PATH] [--checkpoint-file PATH]
  usage-monitor experiment --manifest PATH [--execute-live] [--offline] [--result-file PATH]
  usage-monitor contamination [--transitions PATH] [--inference PATH] [--experiments PATH] [--observations PATH] [--output PATH] [--report-file PATH]
  usage-monitor tools --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--output PATH] [--report-file PATH]
  usage-monitor migrate-corrections [--observations PATH] [--transitions PATH] [--corrections PATH] [--output PATH] [--report-file PATH]
`);
}

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function readNonNegativeNumber(argv, index, option) {
  const value = Number(readOptionValue(argv, index, option));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${option} requires a non-negative number`);
  return value;
}

export function parseArgs(argv) {
  const result = {
    command: argv[0] ?? "help",
    label: null,
    controlled: false,
    offline: false,
    json: false,
    dataFile: null,
    startAt: null,
    endAt: null,
    outputFile: null,
    auditFile: null,
    inputFile: null,
    reportFile: null,
    checkpointFile: null,
    lockFile: null,
    staleAfterMs: 60_000,
    reconciliationMs: 60_000,
    durationMs: null,
    refreshStale: true,
    backfill: false,
    manifestFile: null,
    resultFile: null,
    transitionsFile: null,
    inferenceFile: null,
    experimentsFile: null,
    observationsFile: null,
    correctionsFile: null,
    executeLive: false,
    compact: false,
    windowDurationMins: null,
    planTimelineFile: null,
    providerUiFile: null,
    accountAlias: null,
    defaultPlanVariant: null,
    allowStaleCache: false,
    collectorFile: null,
    claudeStatus: false,
    claudeStateDirectory: null,
    claudeUsage: false,
    claudeProjectsDirectory: null,
    activitySurface: null,
    activityState: null,
    activityFile: null,
    experimentId: null,
    codexHome: null,
    exportSecretFile: null,
    receiptFile: null,
    directory: null,
    confirm: false,
    confirmDeletionToken: null,
    confirmDiscardToken: null,
    confirmRemovalToken: null,
    resume: false,
    workspaceDirectory: null,
    maximumRecordsPerChunk: null,
    maximumCanonicalBundleBytes: null,
    maximumEncodedArtifactBytes: null,
    benchmarkProfile: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--controlled") result.controlled = true;
    else if (arg === "--no-refresh") result.refreshStale = false;
    else if (arg === "--backfill") result.backfill = true;
    else if (arg === "--execute-live") result.executeLive = true;
    else if (arg === "--offline") result.offline = true;
    else if (arg === "--compact") result.compact = true;
    else if (arg === "--allow-stale-cache") result.allowStaleCache = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--confirm") result.confirm = true;
    else if (arg === "--confirm-deletion") result.confirmDeletionToken = readOptionValue(argv, index++, arg);
    else if (arg === "--confirm-discard") result.confirmDiscardToken = readOptionValue(argv, index++, arg);
    else if (arg === "--confirm-removal") result.confirmRemovalToken = readOptionValue(argv, index++, arg);
    else if (arg === "--resume") result.resume = true;
    else if (arg === "--claude-status") result.claudeStatus = true;
    else if (arg === "--claude-usage") result.claudeUsage = true;
    else if (arg === "--label") result.label = readOptionValue(argv, index++, arg);
    else if (arg === "--data-file") result.dataFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--since") result.startAt = readOptionValue(argv, index++, arg);
    else if (arg === "--until") result.endAt = readOptionValue(argv, index++, arg);
    else if (arg === "--output") result.outputFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--audit-file") result.auditFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--input") result.inputFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--report-file") result.reportFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--checkpoint-file") result.checkpointFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--lock-file") result.lockFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--stale-after-ms") result.staleAfterMs = readNonNegativeNumber(argv, index++, arg);
    else if (arg === "--reconciliation-ms") result.reconciliationMs = readNonNegativeNumber(argv, index++, arg);
    else if (arg === "--duration-ms") result.durationMs = readNonNegativeNumber(argv, index++, arg);
    else if (arg === "--window-minutes") result.windowDurationMins = readNonNegativeNumber(argv, index++, arg);
    else if (arg === "--manifest") result.manifestFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--result-file") result.resultFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--transitions") result.transitionsFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--inference") result.inferenceFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--experiments") result.experimentsFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--observations") result.observationsFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--corrections") result.correctionsFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--plan-timeline") result.planTimelineFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--provider-ui") result.providerUiFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--collector-file") result.collectorFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--claude-state-dir") result.claudeStateDirectory = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--claude-projects-dir") result.claudeProjectsDirectory = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--surface") result.activitySurface = readOptionValue(argv, index++, arg);
    else if (arg === "--state") result.activityState = readOptionValue(argv, index++, arg);
    else if (arg === "--activity-file") result.activityFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--experiment-id") result.experimentId = readOptionValue(argv, index++, arg);
    else if (arg === "--codex-home") result.codexHome = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--secret-file") result.exportSecretFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--receipt") result.receiptFile = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--directory") result.directory = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--workspace") result.workspaceDirectory = resolve(readOptionValue(argv, index++, arg));
    else if (arg === "--max-records-per-chunk") result.maximumRecordsPerChunk = readNonNegativeNumber(argv, index++, arg);
    else if (arg === "--max-bundle-bytes") result.maximumCanonicalBundleBytes = readNonNegativeNumber(argv, index++, arg);
    else if (arg === "--max-artifact-bytes") result.maximumEncodedArtifactBytes = readNonNegativeNumber(argv, index++, arg);
    else if (arg === "--profile") result.benchmarkProfile = readOptionValue(argv, index++, arg);
    else if (arg === "--alias") result.accountAlias = readOptionValue(argv, index++, arg);
    else if (arg === "--default-plan") result.defaultPlanVariant = readOptionValue(argv, index++, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (result.claudeStatus && result.claudeStateDirectory !== null) {
    throw new Error("export-set accepts either --claude-status or --claude-state-dir, not both");
  }
  if ((result.claudeStatus || result.claudeStateDirectory !== null) && result.command !== "export-set") {
    throw new Error("--claude-status and --claude-state-dir are available only for export-set");
  }
  if ((result.claudeUsage || result.claudeProjectsDirectory !== null) && result.command !== "export-set") {
    throw new Error("--claude-usage and --claude-projects-dir are available only for export-set");
  }
  if (result.confirmRemovalToken !== null && result.command !== "remove-claude-callback-identity") {
    throw new Error("--confirm-removal is available only for remove-claude-callback-identity");
  }
  if (result.benchmarkProfile !== null && result.command !== "benchmark-r7") {
    throw new Error("--profile is available only for benchmark-r7");
  }
  result.dataFile ??= defaultDataFile();
  return result;
}

function formatMoney(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : "not identified";
}

function printMethod(name, result) {
  console.log(`  ${name}:`);
  console.log(`    observations: ${result.observations}; used span: ${result.usedPercentSpan.toFixed(1)}%; cost span: ${formatMoney(result.costUsdSpan)}`);
  console.log(`    capacity verdict: ${result.identifiability?.verdict ?? "non_identifiable"}; reported capacity: ${formatMoney(result.identifiability?.reportedCapacityUsd)}`);
  if (result.identifiability?.verdict === "range_identified" && result.fit) {
    console.log(`    R²: ${result.fit.rSquared?.toFixed(4) ?? "n/a"}; RMSE: ${result.fit.rmsePercent.toFixed(3)} percentage points`);
    if (result.holdout) console.log(`    holdout MAE: ${result.holdout.meanAbsoluteErrorPercent.toFixed(3)} percentage points`);
  } else if (result.diagnosticsSuppressed) {
    console.log("    fit diagnostics: suppressed because the series is non-identifiable");
  }
  if (result.warnings.length) console.log(`    warnings: ${result.warnings.join(", ")}`);
}

export function observationsWithEffectiveDerived(observations, resolution) {
  return observations.map((observation) => {
    const effective = resolution.effectiveByOriginalId?.[observation.observationId];
    if (!effective || effective.effectiveRecordId === observation.observationId || !Array.isArray(observation.windows) || observation.windows.length !== 1) {
      return observation;
    }
    const copy = structuredClone(observation);
    const derived = effective.derived;
    copy.windows[0].local.apiPricing = {
      totalUsd: derived.apiPricedCostUsd,
      totalTokens: derived.aggregateTokenTotal,
      components: structuredClone(derived.tokenComponents ?? {}),
      byModel: structuredClone(derived.byModel ?? {}),
      warningCounts: Object.fromEntries((derived.warnings ?? []).map((warning) => [warning, 1])),
      pricingBasis: derived.pricingBasis,
      correctionRecordId: effective.effectiveRecordId,
    };
    copy.windows[0].local.diagnostics = structuredClone(derived.diagnostics ?? copy.windows[0].local.diagnostics);
    return copy;
  });
}

export function validateLocalHistoryCacheProvenance(cached, current, { allowStale = false, appendedAfterEndOnly = false } = {}) {
  const cachedProvenance = cached?.sourceProvenance;
  const cachedFiles = new Map((cachedProvenance?.files ?? []).map((file) => [file.keyHash, file]));
  const currentFiles = new Map((current?.files ?? []).map((file) => [file.keyHash, file]));
  const exactSourceMatch = cachedFiles.size === currentFiles.size
    && [...cachedFiles].every(([key, prior]) => {
      const next = currentFiles.get(key);
      return next
        && next.ino === prior.ino
        && Math.trunc(next.birthtimeMs) === Math.trunc(prior.birthtimeMs)
        && next.size === prior.size
        && Math.trunc(next.mtimeMs) === Math.trunc(prior.mtimeMs);
    });
  const schemaMatches = cachedProvenance?.schemaVersion === current?.schemaVersion;
  const matches = schemaMatches && (exactSourceMatch || appendedAfterEndOnly);
  if (!matches && !allowStale) {
    throw new Error("Local-history cache does not match current rollout sources; rebuild without --input or pass --allow-stale-cache explicitly");
  }
  return {
    status: matches ? (exactSourceMatch ? "current" : "current_after_end_growth") : "stale_override",
    cached: cachedProvenance ?? null,
    current,
  };
}

export function selectCacheValidationBaseline(cached, sidecar, { startAt, endAt }) {
  const original = cached?.sourceProvenance ?? null;
  const validSidecar = sidecar?.schemaVersion === "local-history-cache-validation-v1"
    && sidecar.cacheFingerprint === original?.fingerprint
    && sidecar.startAt === startAt
    && sidecar.endAt === endAt
    && sidecar.verifiedProvenance?.schemaVersion === original?.schemaVersion;
  return validSidecar ? sidecar.verifiedProvenance : original;
}

export function buildCacheValidationSidecar(cached, current, { startAt, endAt, verifiedAt }) {
  const verifiedProvenance = structuredClone(current);
  delete verifiedProvenance.sourcePathByKeyHash;
  return {
    schemaVersion: "local-history-cache-validation-v1",
    cacheFingerprint: cached?.sourceProvenance?.fingerprint ?? null,
    startAt,
    endAt,
    verifiedAt,
    verifiedProvenance,
  };
}

export async function run(
  argv = process.argv.slice(2),
  {
    selectParticipantIdentity = selectProductionParticipantIdentity,
    inspectIdentity = inspectParticipantSecret,
    rotateIdentity = rotateParticipantSecret,
    withIdentityLease = withParticipantSecretLease,
    selectAccountObservationSecret = selectProductionAccountObservationSecret,
    readAccountSnapshot = readCodexAccountSnapshot,
    sanitizeAccountSnapshot = sanitizeCodexAccountSnapshotWithSecretLoader,
    captureObservation = captureCodexObservation,
    runCollectorOnceCommand = runCollectorOnce,
    runCollectorForegroundCommand = runCollectorForeground,
    createClaudeCallbackBackend = createProductionClaudeCallbackBackend,
    readClaudeCallbackCredential = readClaudeCallbackCapability,
    inspectClaudeCallback = inspectClaudeCallbackLifecycle,
    installClaudeCallbackCommand = installClaudeCallback,
    uninstallClaudeCallbackCommand = uninstallClaudeCallback,
    recoverClaudeCallbackCommand = recoverClaudeCallbackLifecycle,
    rotateClaudeCallbackCommand = rotateManagedClaudeCallbackCapability,
    planClaudeCallbackRemoval = planManagedClaudeCallbackCapabilityRemoval,
    removeClaudeCallbackCredential = removeManagedClaudeCallbackCapability,
    runR7BenchmarkCommand = runR7SmokeBenchmark,
  } = {},
) {
  const args = parseArgs(argv);
  let accountObservationSelection = null;
  function selectedAccountObservation() {
    accountObservationSelection ??= selectAccountObservationSecret();
    return accountObservationSelection;
  }
  async function readSanitizedAccountSnapshot(capturedAt) {
    const selection = selectedAccountObservation();
    return sanitizeAccountSnapshot(await readAccountSnapshot(), capturedAt, {
      loadAccountObservationSecret: selection.loadAccountObservationSecret,
    });
  }
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    usage();
    return;
  }
  if (args.command === "benchmark-r7") {
    if (!args.outputFile) throw new Error("benchmark-r7 requires --output");
    if ((args.benchmarkProfile ?? "smoke") !== "smoke") {
      throw new Error("benchmark-r7 supports only the smoke profile until the release workload is implemented");
    }
    const receipt = await runR7BenchmarkCommand();
    await writeJsonOwnerOnlyAtomic(args.outputFile, receipt);
    console.log("R7 benchmark receipt: written");
    console.log(`Profile: ${receipt.profile}; classification: ${receipt.classification}`);
    console.log(`Operations exercised: ${receipt.operations.filter((row) => row.status !== "not_run").length}; recovered after interruption: ${receipt.operations.filter((row) => row.status === "interrupted_recovered").length}; not run: ${receipt.operations.filter((row) => row.status === "not_run").length}`);
    console.log(`Determinism: ${receipt.determinismEvidence.status}; receipt SHA-256: ${receipt.receiptSha256}`);
    console.log(`Network activity: ${receipt.networkActivity}; upload disabled: ${receipt.transportReady === false}`);
    return;
  }
  if (args.command === "inspect-claude-callback") {
    const inspected = await inspectClaudeCallback();
    const backend = createClaudeCallbackBackend();
    let secret = null;
    try {
      secret = await readClaudeCallbackCredential({ backend });
      console.log("Claude callback inspection");
      console.log(`Lifecycle: ${inspected.status}`);
      console.log(`Session-pseudonym capability: ${secret === null ? "missing" : "available"}`);
      console.log("Existing status-line command: private (never displayed)");
      console.log("Network activity: none");
    } finally {
      secret?.fill(0);
    }
    return;
  }
  if (args.command === "install-claude-callback") {
    const result = await installClaudeCallbackCommand({ backend: createClaudeCallbackBackend() });
    console.log(`Claude callback installation: ${result.status}`);
    console.log(`Session-pseudonym capability: ${result.capability}`);
    console.log("Existing supported status line: composed and retained privately for exact restoration");
    console.log("Network activity: none");
    return;
  }
  if (args.command === "uninstall-claude-callback") {
    const result = await uninstallClaudeCallbackCommand();
    console.log(`Claude callback uninstallation: ${result.status}`);
    console.log(`Session-pseudonym capability preserved: ${result.capabilityPreserved}`);
    console.log("Network activity: none");
    return;
  }
  if (args.command === "recover-claude-callback") {
    const result = await recoverClaudeCallbackCommand();
    console.log(`Claude callback recovery: ${result.status}`);
    console.log(`Lifecycle phase: ${result.recovered}`);
    console.log("Network activity: none");
    return;
  }
  if (args.command === "rotate-claude-callback-identity") {
    const backend = createClaudeCallbackBackend();
    if (!args.confirm) {
      let secret = null;
      try {
        secret = await readClaudeCallbackCredential({ backend });
        console.log(`Claude callback identity rotation preflight: ${secret === null ? "missing" : "ready"}`);
        console.log("No state changed; rerun with --confirm to break future Claude-session linkability");
        console.log("Existing snapshots changed: false; network activity: none");
      } finally {
        secret?.fill(0);
      }
      return;
    }
    const result = await rotateClaudeCallbackCommand({ backend, confirm: true });
    console.log(`Claude callback identity rotation: ${result.status}`);
    console.log("Future session pseudonyms changed: true; existing snapshots changed: false");
    console.log("Network activity: none");
    return;
  }
  if (args.command === "remove-claude-callback-identity") {
    const backend = createClaudeCallbackBackend();
    if (args.confirmRemovalToken === null) {
      const planned = await planClaudeCallbackRemoval({ backend });
      console.log(`Claude callback identity removal preflight: ${planned.status}`);
      if (planned.confirmationToken !== null) {
        console.log(`Confirmation token: ${planned.confirmationToken}`);
        console.log("No state changed; rerun with --confirm-removal TOKEN for this exact uninstalled target");
      }
      console.log("Callback must be uninstalled first; network activity: none");
      return;
    }
    const result = await removeClaudeCallbackCredential({
      backend,
      providedToken: args.confirmRemovalToken,
    });
    console.log(`Claude callback identity removal: ${result.status}`);
    console.log(`Secure erasure guaranteed: ${result.secureErasure}`);
    console.log("Network activity: none");
    return;
  }
  if (args.command === "mark-activity") {
    const observedAt = new Date().toISOString();
    const snapshot = await readSanitizedAccountSnapshot(observedAt);
    const marker = createActivityMarker({
      surface: args.activitySurface,
      state: args.activityState,
      observedAt,
      accountScope: snapshot.accountScope,
      planType: snapshot.canonical.planType,
      experimentId: args.experimentId,
    });
    const activityFile = args.activityFile ?? defaultActivityMarkerFile();
    await appendJsonLinesOwnerOnly(activityFile, [marker]);
    console.log(`Activity marker: ${marker.surface} ${marker.state}; account ${marker.accountScope.status}.`);
    console.log(`Data: ${activityFile}`);
    return;
  }
  if (args.command === "verify-bundle") {
    if (!args.inputFile) throw new Error("verify-bundle requires --input");
    const verified = await verifyLocalMetadataBundleFiles({
      bundleFile: args.inputFile,
      receiptFile: args.receiptFile ?? `${args.inputFile}.privacy-receipt.json`,
    });
    console.log("Local metadata bundle verification: passed");
    console.log(`Contract: ${verified.contractFamily} (${verified.contractStatus}); exporter ${verified.exporterVersion}`);
    console.log(`Records: ${verified.recordCounts.usageEvents} usage, ${verified.recordCounts.quotaSnapshots} quota, ${verified.recordCounts.activityMarkers} markers`);
    console.log(`Bundle bytes: ${verified.bundleBytes}; upload disabled: ${verified.transportReady === false}`);
    return;
  }
  if (args.command === "verify-export-set") {
    if (!args.directory) throw new Error("verify-export-set requires --directory");
    const verified = await verifyLocalExportSet({ directory: args.directory });
    console.log("Local metadata export-set verification: passed");
    console.log(`Contract: ${verified.schemaVersion} (${verified.contractStatus})`);
    console.log(`Chunks: ${verified.chunkCount}`);
    console.log(`Records: ${verified.recordCounts.usageEvents} usage, ${verified.recordCounts.quotaSnapshots} quota, ${verified.recordCounts.activityMarkers} markers`);
    console.log(`Bundle bytes: ${verified.bundleBytes}; upload disabled: ${verified.transportReady === false}`);
    return;
  }
  if (args.command === "inspect-export-workspace") {
    if (!args.workspaceDirectory) throw new Error("inspect-export-workspace requires --workspace");
    const inspected = await inspectLocalExportWorkspace({ directory: args.workspaceDirectory });
    console.log("Local metadata export workspace");
    console.log(`Status: ${inspected.poisoned
      ? "poisoned_source_integrity"
      : inspected.scanComplete ? "scan_complete" : "incomplete"}`);
    console.log(`Coverage: ${inspected.coveredAt.startAt} to ${inspected.coveredAt.endAt}`);
    const totalSourceFiles = inspected.sourcePlan.sourceFiles + inspected.supplementalSourcePlan.sourceFiles;
    const totalSourceBytes = inspected.sourcePlan.sourceBytes + inspected.supplementalSourcePlan.sourceBytes;
    console.log(`Sources: ${totalSourceFiles}; bytes: ${totalSourceBytes}`);
    console.log(`Providers: ${inspected.sourceProviders.join(", ")}`);
    console.log(`Records: ${inspected.recordCounts.usageEvents} usage, ${inspected.recordCounts.quotaSnapshots} quota, ${inspected.recordCounts.activityMarkers} markers`);
    console.log(`Workspace bytes: ${inspected.workspaceBytes}; upload disabled: true`);
    return;
  }
  if (args.command === "export-set") {
    if (!args.workspaceDirectory || !args.directory) {
      throw new Error("export-set requires --workspace and --directory");
    }
    if (!args.resume && (!args.startAt || !args.endAt)) {
      throw new Error("export-set creation requires --since and --until");
    }
    if (args.resume && (args.startAt || args.endAt)) {
      throw new Error("export-set --resume uses the workspace interval; omit --since and --until");
    }
    if (args.maximumRecordsPerChunk !== null
        && (!Number.isSafeInteger(args.maximumRecordsPerChunk) || args.maximumRecordsPerChunk < 1)) {
      throw new Error("--max-records-per-chunk requires a positive integer");
    }
    if (args.maximumCanonicalBundleBytes !== null
        && (!Number.isSafeInteger(args.maximumCanonicalBundleBytes) || args.maximumCanonicalBundleBytes < 1)) {
      throw new Error("--max-bundle-bytes requires a positive integer");
    }
    if (args.maximumEncodedArtifactBytes !== null
        && (!Number.isSafeInteger(args.maximumEncodedArtifactBytes) || args.maximumEncodedArtifactBytes < 1)) {
      throw new Error("--max-artifact-bytes requires a positive integer");
    }
    const activityMarkers = await readBoundedJsonLines(args.activityFile ?? defaultActivityMarkerFile(), {
      maximumFileBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumExpandedRecordBytes,
      maximumLineBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumLineBytes,
      maximumRecords: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumOutputRecords,
    });
    const identitySelection = selectParticipantIdentity({ explicitSecretFile: args.exportSecretFile });
    await withIdentityLease(identitySelection.identityOptions, async (identity) => {
      const workspaceResult = args.resume
        ? await resumeLocalExportWorkspace({
            directory: args.workspaceDirectory,
            codexHome: args.codexHome ?? undefined,
            secret: identity.secret,
            activityMarkers,
            collectorPath: args.collectorFile,
            claudeStateDirectory: args.claudeStateDirectory,
            enableClaudeStatus: args.claudeStatus,
            claudeProjectsDirectory: args.claudeProjectsDirectory,
            enableClaudeUsage: args.claudeUsage,
          })
        : await createLocalExportWorkspace({
            directory: args.workspaceDirectory,
            startAt: args.startAt,
            endAt: args.endAt,
            codexHome: args.codexHome ?? undefined,
            secret: identity.secret,
            activityMarkers,
            collectorPath: args.collectorFile,
            claudeStateDirectory: args.claudeStateDirectory,
            enableClaudeStatus: args.claudeStatus,
            claudeProjectsDirectory: args.claudeProjectsDirectory,
            enableClaudeUsage: args.claudeUsage,
          });
      const materialized = await materializeLocalExportSet({
        workspaceDirectory: args.workspaceDirectory,
        outputDirectory: args.directory,
        secret: identity.secret,
        ...(args.maximumRecordsPerChunk === null ? {} : { maximumRecordsPerChunk: args.maximumRecordsPerChunk }),
        ...(args.maximumCanonicalBundleBytes === null ? {} : { maximumCanonicalBundleBytes: args.maximumCanonicalBundleBytes }),
        ...(args.maximumEncodedArtifactBytes === null ? {} : { maximumEncodedArtifactBytes: args.maximumEncodedArtifactBytes }),
      });
      console.log("Local metadata export set: complete");
      console.log(`Workspace status: ${workspaceResult.status.scanComplete ? "scan_complete" : "incomplete"}`);
      console.log(`Chunks: ${materialized.manifest.chunks.length}`);
      console.log(`Records: ${materialized.manifest.totals.recordCounts.usageEvents} usage, ${materialized.manifest.totals.recordCounts.quotaSnapshots} quota, ${materialized.manifest.totals.recordCounts.activityMarkers} markers`);
      console.log(`Manifest bytes: ${materialized.manifestReceipt.manifestBytes}`);
      console.log(`Artifact bytes: ${materialized.manifest.totals.encodedArtifactBytes}; decoded bundle bytes: ${materialized.manifest.totals.decodedBundleBytes}`);
      console.log("Upload: disabled (transportReady=false)");
    });
    return;
  }
  if (args.command === "recover-exports") {
    if (!args.directory) throw new Error("recover-exports requires --directory");
    const recovery = await recoverOwnerOnlyPairTransactions({ directory: args.directory });
    console.log(`Local export recovery: ${recovery.recovered} recovered of ${recovery.transactionsFound} transaction(s)`);
    console.log("Upload remains disabled");
    return;
  }
  if (args.command === "delete-local-export") {
    if (!args.workspaceDirectory || !args.directory) {
      throw new Error("delete-local-export requires --workspace and --directory");
    }
    if (!args.confirmDeletionToken) {
      const planned = await planLocalExportDeletion({
        workspaceDirectory: args.workspaceDirectory,
        outputDirectory: args.directory,
      });
      console.log(`Local export deletion preflight: ${planned.readiness}`);
      console.log(`Artifact class: ${planned.artifactClass}`);
      console.log(`Files: ${planned.fileCounts.totalFiles}; bytes: ${planned.byteCounts.totalBytes}`);
      console.log(`Export-set files: ${planned.fileCounts.chunkArtifacts + planned.fileCounts.chunkReceipts + planned.fileCounts.controlFiles}; workspace files: ${planned.fileCounts.workspaceFiles}`);
      console.log(`Confirmation token: ${planned.confirmationToken}`);
      console.log("No files changed; rerun with --confirm-deletion TOKEN to delete this exact inventory");
      console.log("Source logs and local identity state will be preserved");
      console.log("Network activity: none; secure erasure: not claimed");
      return;
    }
    const receipt = await deleteLocalExport({
      workspaceDirectory: args.workspaceDirectory,
      outputDirectory: args.directory,
      confirmationToken: args.confirmDeletionToken,
    });
    console.log("Local export deletion: complete");
    console.log(`Files deleted: ${receipt.deletedFileCount}; bytes: ${receipt.deletedBytes}`);
    console.log(`Source logs preserved: ${receipt.sourceLogsPreserved}; local identity state preserved: ${receipt.identityStatePreserved}`);
    console.log(`Directories retained: ${receipt.directoriesRetained}`);
    console.log("Network activity: none; secure erasure: not claimed");
    return;
  }
  if (args.command === "recover-local-export-deletion") {
    if (!args.workspaceDirectory || !args.directory) {
      throw new Error("recover-local-export-deletion requires --workspace and --directory");
    }
    const receipt = await recoverLocalExportDeletion({
      workspaceDirectory: args.workspaceDirectory,
      outputDirectory: args.directory,
    });
    console.log("Local export deletion recovery: complete");
    console.log(`Files in committed inventory: ${receipt.deletedFileCount}; bytes: ${receipt.deletedBytes}`);
    console.log(`Source logs preserved: ${receipt.sourceLogsPreserved}; local identity state preserved: ${receipt.identityStatePreserved}`);
    console.log(`Directories retained: ${receipt.directoriesRetained}`);
    console.log("Network activity: none; secure erasure: not claimed");
    return;
  }
  if (args.command === "discard-export-workspace") {
    if (!args.workspaceDirectory) throw new Error("discard-export-workspace requires --workspace");
    if (args.directory) throw new Error("discard-export-workspace accepts --workspace only");
    if (args.confirmDeletionToken) throw new Error("discard-export-workspace uses --confirm-discard, not --confirm-deletion");
    if (!args.confirmDiscardToken) {
      const planned = await planLocalExportWorkspaceDiscard({ workspaceDirectory: args.workspaceDirectory });
      console.log(`Local export workspace discard preflight: ${planned.readiness}`);
      console.log(`Eligibility: ${planned.eligibility}`);
      console.log(`Files: ${planned.fileCounts.totalFiles}; bytes: ${planned.byteCounts.totalBytes}`);
      console.log(`Confirmation token: ${planned.confirmationToken}`);
      console.log("No files changed; rerun with --confirm-discard TOKEN to discard this exact workspace inventory");
      console.log("Source logs, local identity state, and independent output directories will be preserved");
      console.log("Network activity: none; secure erasure: not claimed");
      return;
    }
    const receipt = await discardLocalExportWorkspace({
      workspaceDirectory: args.workspaceDirectory,
      confirmationToken: args.confirmDiscardToken,
    });
    console.log("Local export workspace discard: complete");
    console.log(`Files deleted: ${receipt.deletedFileCount}; bytes: ${receipt.deletedBytes}`);
    console.log(`Source logs preserved: ${receipt.sourceLogsPreserved}; local identity state preserved: ${receipt.identityStatePreserved}`);
    console.log(`Independent output preserved: ${receipt.independentOutputPreserved}; workspace directory retained: ${receipt.workspaceDirectoryRetained}`);
    console.log("Network activity: none; secure erasure: not claimed");
    return;
  }
  if (args.command === "recover-export-workspace-discard") {
    if (!args.workspaceDirectory) throw new Error("recover-export-workspace-discard requires --workspace");
    if (args.directory) throw new Error("recover-export-workspace-discard accepts --workspace only");
    const receipt = await recoverLocalExportWorkspaceDiscard({ workspaceDirectory: args.workspaceDirectory });
    console.log("Local export workspace discard recovery: complete");
    console.log(`Files in committed inventory: ${receipt.deletedFileCount}; bytes: ${receipt.deletedBytes}`);
    console.log(`Source logs preserved: ${receipt.sourceLogsPreserved}; local identity state preserved: ${receipt.identityStatePreserved}`);
    console.log(`Independent output preserved: ${receipt.independentOutputPreserved}; workspace directory retained: ${receipt.workspaceDirectoryRetained}`);
    console.log("Network activity: none; secure erasure: not claimed");
    return;
  }
  if (args.command === "rotate-local-identity") {
    const identitySelection = selectParticipantIdentity({ explicitSecretFile: args.exportSecretFile });
    if (!args.confirm) {
      const inspection = await inspectIdentity(identitySelection.identityOptions);
      const state = inspection.conflict === true
        ? "conflict"
        : ["ready", "missing"].includes(inspection.status)
          ? inspection.status
          : "invalid";
      console.log(`Local export identity rotation preflight: ${state}`);
      console.log(`Storage backend: ${renderParticipantIdentityBackendMode(identitySelection.mode)}`);
      console.log(`Identity source: ${renderParticipantIdentitySourceState(inspection)}`);
      console.log(`Rotatable: ${inspection.rotatable === true}`);
      if (identitySelection.mode === "macos_keychain") {
        console.log(`Owner-file secret residue: ${renderParticipantIdentityFileResidueState(inspection.ownerFileState)}`);
        console.log(`Legacy-file secret residue: ${renderParticipantIdentityFileResidueState(inspection.legacyState)}`);
      }
      console.log("No files changed; rerun with --confirm to break future export linkability");
      console.log("Network activity: none");
      return;
    }
    const rotated = await rotateIdentity({ ...identitySelection.identityOptions, confirmRotation: true });
    console.log("Local export identity rotation: completed");
    console.log(`Storage backend: ${renderParticipantIdentityBackendMode(identitySelection.mode)}`);
    console.log(`Fallback retirement markers committed: ${rotated.ownerFileRetired === true || rotated.legacyRetired === true}`);
    if (identitySelection.mode === "macos_keychain") {
      console.log(`Retired secret files removed this operation: ${Number.isSafeInteger(rotated.secretFilesRemoved) ? rotated.secretFilesRemoved : 0}`);
      console.log(`Retired secret files retained after operation: ${Number.isSafeInteger(rotated.secretFilesRetained) ? rotated.secretFilesRetained : 0}`);
    }
    console.log("Future export pseudonyms changed: true");
    console.log("Existing bundles changed: false");
    console.log(`Secure storage erasure guaranteed: ${rotated.secureErasure}`);
    console.log("Network activity: none");
    return;
  }
  if (args.command === "inspect-export" || args.command === "export-local") {
    if (!args.startAt || !args.endAt) throw new Error(`${args.command} requires --since and --until`);
    if (args.command === "export-local" && !args.outputFile) throw new Error("export-local requires --output");
    const exportResourceGuard = createExportResourceGuard();
    exportResourceGuard.assertCoveredInterval(Date.parse(args.startAt), Date.parse(args.endAt));
    const activityMarkers = await readBoundedJsonLines(args.activityFile ?? defaultActivityMarkerFile(), {
      maximumFileBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumExpandedRecordBytes,
      maximumLineBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumLineBytes,
      maximumRecords: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumOutputRecords,
      resourceGuard: exportResourceGuard,
    });
    const identitySelection = selectParticipantIdentity({ explicitSecretFile: args.exportSecretFile });
    await withIdentityLease(identitySelection.identityOptions, async (identity) => {
      const result = await buildLocalMetadataBundle({
        startAt: args.startAt,
        endAt: args.endAt,
        codexHome: args.codexHome ?? undefined,
        secret: identity.secret,
        activityMarkers,
        resourceGuard: exportResourceGuard,
      });
      console.log(renderMetadataExportPreview(result));
      if (args.command === "inspect-export") return;
      args.receiptFile ??= `${args.outputFile}.privacy-receipt.json`;
      const written = await writeLocalMetadataBundle({
        ...result,
        outputFile: args.outputFile,
        receiptFile: args.receiptFile,
      });
      console.log(`Bundle: ${written.outputFile}`);
      console.log(`Privacy receipt: ${written.receiptFile}`);
    });
    return;
  }
  if (args.command === "doctor") {
    const capturedAt = new Date().toISOString();
    const snapshot = await readSanitizedAccountSnapshot(capturedAt);
    console.log("Codex app-server: available");
    console.log(`Plan: ${snapshot.canonical.planType ?? "unknown"}`);
    console.log(`Account scope: ${snapshot.accountScope.status}${snapshot.accountScope.scopeId ? ` (${snapshot.accountScope.scopeId})` : ` (${snapshot.accountScope.reason})`}`);
    for (const [id, limit] of Object.entries(snapshot.byLimitId)) {
      const windows = [limit.primary, limit.secondary].filter(Boolean);
      console.log(`${id}: ${windows.map((window) => `${window.usedPercent}% / ${window.windowDurationMins}m`).join(", ") || "no active windows"}`);
    }
    console.log("ccusage: installed");
    console.log("RunCost: installed");
    return;
  }
  if (args.command === "register-account") {
    if (!args.accountAlias || !args.defaultPlanVariant) {
      throw new Error("register-account requires --alias and --default-plan");
    }
    const capturedAt = new Date().toISOString();
    const snapshot = await readSanitizedAccountSnapshot(capturedAt);
    if (snapshot.accountScope.status !== "available") {
      throw new Error(`Cannot register account scope: ${snapshot.accountScope.reason}`);
    }
    const timelineFile = args.planTimelineFile ?? defaultPlanTimelineFile();
    const existingTimeline = await readJsonIfExists(timelineFile, {
      schemaVersion: "0.1",
      profiles: [],
      unresolvedEpisodes: [],
    });
    validatePlanTimeline(existingTimeline);
    const updatedTimeline = upsertPlanProfile({
      timeline: existingTimeline,
      scopeId: snapshot.accountScope.scopeId,
      alias: args.accountAlias,
      defaultPlanVariant: args.defaultPlanVariant,
      effectiveAt: capturedAt,
    });
    await writeJsonOwnerOnlyAtomic(timelineFile, updatedTimeline);
    console.log(`Registered current pseudonymous account as ${args.accountAlias} from ${capturedAt}.`);
    console.log(`Plan timeline: ${timelineFile}`);
    return;
  }
  if (args.command === "capture") {
    const planTimeline = await readJsonIfExists(args.planTimelineFile ?? defaultPlanTimelineFile(), null);
    const selection = selectedAccountObservation();
    const observation = await captureObservation({
      ...args,
      planTimeline,
      sanitizeSnapshot: (snapshot, capturedAt) => sanitizeAccountSnapshot(snapshot, capturedAt, {
        loadAccountObservationSecret: selection.loadAccountObservationSecret,
      }),
    });
    await appendObservation(args.dataFile, observation);
    console.log(`Captured ${observation.windows.length} quota window(s) to ${args.dataFile}`);
    for (const window of observation.windows) {
      const coverage = window.officialTokenActivity.localToOfficialCurrentDayRatio;
      console.log(`${window.limitId}/${window.slot}: ${window.usedPercent}% used; API-priced ${formatMoney(window.local.apiPricing.totalUsd)}; ccusage ${formatMoney(window.local.ccusage.totals.costUsd)}; local/official today ${coverage === null ? "n/a" : `${(coverage * 100).toFixed(1)}%`}`);
      const warnings = Object.keys(window.local.apiPricing.warningCounts);
      if (warnings.length) console.log(`  pricing warnings: ${warnings.join(", ")}`);
    }
    return;
  }
  if (args.command === "report") {
    const rawObservations = await readObservations(args.dataFile);
    const correctionFile = args.correctionsFile
      ?? (args.dataFile === defaultDataFile() ? defaultCorrectionsFile() : null);
    const corrections = correctionFile ? await readObservations(correctionFile) : [];
    const correctionResolution = resolveCorrections({ originals: rawObservations, corrections });
    if (correctionResolution.errors.length > 0) {
      throw new Error(`Correction resolution failed: ${correctionResolution.errors.map((error) => error.code).join(", ")}`);
    }
    const observations = observationsWithEffectiveDerived(rawObservations, correctionResolution);
    const report = analyzeObservations(observations);
    if (args.json) {
      console.log(JSON.stringify({
        dataFile: args.dataFile,
        correctionsApplied: Object.values(correctionResolution.effectiveByOriginalId)
          .filter((record) => record.effectiveRecordId !== record.originalObservationId).length,
        windows: report,
      }, null, 2));
      return;
    }
    if (report.length === 0) {
      console.log(`No quota observations found in ${args.dataFile}`);
      return;
    }
    for (const window of report) {
      console.log(`${window.limitId}/${window.slot} (${window.windowDurationMins} minutes, reset ${new Date(window.resetsAt * 1000).toISOString()})`);
      printMethod("OpenAI API pricing via RunCost", window.apiPricing);
      printMethod("ccusage linked-method baseline", window.ccusage);
    }
    const applied = Object.values(correctionResolution.effectiveByOriginalId)
      .filter((record) => record.effectiveRecordId !== record.originalObservationId).length;
    if (applied > 0) console.log(`Applied ${applied} append-only derived correction(s); raw observations were not rewritten.`);
    return;
  }
  if (args.command === "transitions") {
    if (!args.startAt || !args.endAt) throw new Error("transitions requires --since and --until for a deterministic scan interval");
    if (!Number.isFinite(Date.parse(args.startAt)) || !Number.isFinite(Date.parse(args.endAt))) {
      throw new Error("--since and --until must be valid ISO timestamps");
    }
    args.outputFile ??= defaultTransitionFile();
    args.auditFile ??= defaultTransitionAuditFile(args.endAt);
    const dataset = await mineCodexTransitions({
      startAt: args.startAt,
      endAt: args.endAt,
      offline: args.offline,
      includeSnapshotIntervals: !args.compact,
      windowDurationMins: args.windowDurationMins,
    });
    await writeJsonOwnerOnlyAtomic(args.outputFile, dataset);
    await writeOwnerOnlyAtomic(args.auditFile, renderTransitionAudit(dataset));
    console.log(`Recovered ${dataset.summary.transitions} transition(s) across ${dataset.summary.transitionResetGroups} reset group(s) with transitions (${dataset.summary.resetGroups} reset groups observed).`);
    console.log(`Dataset: ${args.outputFile}`);
    console.log(`Audit: ${args.auditFile}`);
    console.log(`Priced events: ${dataset.summary.pricedEvents}/${dataset.summary.usageEvents}; fork replay events excluded: ${dataset.diagnostics.forkReplayEventsSkipped}; malformed lines: ${dataset.diagnostics.malformedLines}.`);
    return;
  }
  if (args.command === "infer") {
    args.inputFile ??= defaultTransitionFile();
    args.outputFile ??= defaultInferenceFile();
    const dataset = JSON.parse(await readFile(args.inputFile, "utf8"));
    args.reportFile ??= defaultInferenceReportFile(dataset.scope?.endAt ?? dataset.materializedAt);
    const report = inferCapacityFromTransitions(dataset);
    await writeJsonOwnerOnlyAtomic(args.outputFile, report);
    await writeOwnerOnlyAtomic(args.reportFile, renderInferenceReport(report));
    console.log(`Inference verdict: ${report.overallVerdict}.`);
    console.log(`Report data: ${args.outputFile}`);
    console.log(`Human report: ${args.reportFile}`);
    for (const series of report.series) {
      const classification = series.classification;
      console.log(`${classification.limitId}/${classification.slot}/${classification.windowDurationMins}m: ${series.identifiability.verdict}; eligible ${series.selection.eligibleTransitions}/${series.selection.totalTransitions}; failures ${series.identifiability.failures.join(", ") || "none"}.`);
    }
    return;
  }
  if (args.command === "history") {
    args.inputFile ??= defaultTransitionFile();
    args.outputFile ??= defaultWeeklyHistoryFile();
    const dataset = JSON.parse(await readFile(args.inputFile, "utf8"));
    const report = analyzeWeeklyLimitHistory(dataset);
    args.reportFile ??= defaultWeeklyHistoryReportFile(dataset.scope?.endAt ?? dataset.materializedAt);
    await writeJsonOwnerOnlyAtomic(args.outputFile, report);
    await writeOwnerOnlyAtomic(args.reportFile, renderWeeklyLimitHistoryReport(report));
    console.log(`History verdict: ${report.verdict}; usable reset groups: ${report.quality.usableDiagnosticResetGroups}.`);
    console.log(`Report data: ${args.outputFile}`);
    console.log(`Human report: ${args.reportFile}`);
    return;
  }
  if (args.command === "crosscheck") {
    if (!args.startAt || !args.endAt) throw new Error("crosscheck requires --since and --until for a deterministic scan interval");
    if (!Number.isFinite(Date.parse(args.startAt)) || !Number.isFinite(Date.parse(args.endAt))) {
      throw new Error("--since and --until must be valid ISO timestamps");
    }
    const capturedAt = new Date().toISOString();
    const cacheSidecarFile = defaultLocalHistoryCacheValidationFile();
    const usesDefaultHistoryCache = args.inputFile === defaultLocalHistoryFile();
    const localScanPromise = args.inputFile
      ? Promise.all([
          readFile(args.inputFile, "utf8").then(JSON.parse),
          codexLogSourceFingerprint({ startAt: args.startAt, endAt: args.endAt, includeSourcePaths: true }),
          usesDefaultHistoryCache ? readJsonIfExists(cacheSidecarFile, null) : null,
        ]).then(async ([cached, current, sidecar]) => {
          const baseline = selectCacheValidationBaseline(cached, sidecar, { startAt: args.startAt, endAt: args.endAt });
          const appendedAfterEndOnly = await appendedRolloutSourcesAreAfterEnd({
            cachedProvenance: baseline,
            currentProvenance: current,
            endAt: args.endAt,
          });
          const cacheValidation = validateLocalHistoryCacheProvenance({ sourceProvenance: baseline }, current, {
            allowStale: args.allowStaleCache,
            appendedAfterEndOnly,
          });
          if (usesDefaultHistoryCache && cacheValidation.status !== "stale_override") {
            await writeJsonOwnerOnlyAtomic(cacheSidecarFile, buildCacheValidationSidecar(cached, current, {
              startAt: args.startAt,
              endAt: args.endAt,
              verifiedAt: capturedAt,
            }));
          }
          return { localScan: cached, cacheValidation: { status: cacheValidation.status } };
        })
      : scanAndPriceCodexLogs({ startAt: args.startAt, endAt: args.endAt, offline: args.offline })
          .then((localScan) => ({ localScan, cacheValidation: { status: "fresh_scan" } }));
    const [localScanResult, accountSnapshot, planTimeline, providerUiObservations, prospectiveCollectorRecords] = await Promise.all([
      localScanPromise,
      readSanitizedAccountSnapshot(capturedAt),
      readJsonIfExists(args.planTimelineFile ?? defaultPlanTimelineFile(), null),
      readObservations(args.providerUiFile ?? defaultProviderUiObservationFile()),
      readObservations(defaultCollectorDataFile()),
    ]);
    const { localScan, cacheValidation } = localScanResult;
    if (localScan.startAt !== args.startAt || localScan.endAt !== args.endAt) {
      throw new Error("Crosscheck local-history bounds do not match --since/--until");
    }
    if (!args.inputFile) await writeJsonOwnerOnlyAtomic(defaultLocalHistoryFile(), localScan);
    const report = analyzeProviderCrosscheck({
      localScan,
      accountSnapshot,
      planTimeline,
      providerUiObservations,
      prospectiveCollectorRecords,
      cacheValidation,
    });
    args.outputFile ??= defaultProviderCrosscheckFile();
    args.reportFile ??= defaultProviderCrosscheckReportFile(args.endAt);
    await writeJsonOwnerOnlyAtomic(args.outputFile, report);
    await writeOwnerOnlyAtomic(args.reportFile, renderProviderCrosscheckReport(report));
    console.log(`Provider crosscheck: ${report.comparisons.comparableDayCount} comparable day(s); local/provider token ratio ${report.comparisons.aggregateLocalToOfficialTokenRatio ?? "unavailable"}.`);
    console.log(`Account scope: ${report.scope.accountScope.status}; historical rollout attribution: unavailable.`);
    console.log(`Report data: ${args.outputFile}`);
    console.log(`Human report: ${args.reportFile}`);
    return;
  }
  if (args.command === "quality") {
    args.inputFile ??= defaultTransitionFile();
    args.collectorFile ??= defaultCollectorDataFile();
    args.outputFile ??= defaultMonitoringQualityFile();
    const transitionDataset = JSON.parse(await readFile(args.inputFile, "utf8"));
    const collectorRecords = await readObservations(args.collectorFile);
    const report = analyzeMonitoringQuality({
      transitions: transitionDataset,
      collectorRecords,
      now: new Date().toISOString(),
    });
    args.reportFile ??= defaultMonitoringQualityReportFile(report.analyzedAt);
    await writeJsonOwnerOnlyAtomic(args.outputFile, report);
    await writeOwnerOnlyAtomic(args.reportFile, renderMonitoringQualityReport(report));
    console.log(`Monitoring quality: collector ${report.collector.status}; app-server ${report.collector.appServerStatus}; ${report.opportunities.filter((row) => row.priority === "P0").length} P0 improvement(s).`);
    console.log(`Dominant series: ${report.dominantSeries.snapshotIntervals} interval(s); flat quota displays ${(100 * (report.quantization.flatIntervalFraction ?? 0)).toFixed(1)}%; account-known ${(100 * (report.metadata.accountKnownIntervalFraction ?? 0)).toFixed(1)}%.`);
    console.log(`Report data: ${args.outputFile}`);
    console.log(`Human report: ${args.reportFile}`);
    return;
  }
  if (args.command === "calibrate-weekly") {
    args.inputFile ??= defaultTransitionFile();
    args.outputFile ??= defaultWeeklyCalibrationFile();
    const transitionDataset = JSON.parse(await readFile(args.inputFile, "utf8"));
    const report = analyzeWeeklyCalibration(transitionDataset);
    args.reportFile ??= defaultWeeklyCalibrationReportFile(report.materializedAt);
    await writeJsonOwnerOnlyAtomic(args.outputFile, report);
    await writeOwnerOnlyAtomic(args.reportFile, renderWeeklyCalibrationReport(report));
    console.log(`Weekly calibration: ${report.selection.selectedCandidateLabel}; ${report.quality.qualifyingResetValues} qualifying reset value(s); ${report.prospectiveStyleValidation.scoredResets} prior-reset validation(s).`);
    console.log(`Report data: ${args.outputFile}`);
    console.log(`Human report: ${args.reportFile}`);
    return;
  }
  if (args.command === "collect-once") {
    const selection = selectedAccountObservation();
    const result = await runCollectorOnceCommand({
      dataFile: args.dataFile === defaultDataFile() ? defaultCollectorDataFile() : args.dataFile,
      checkpointFile: args.checkpointFile ?? defaultCollectorCheckpointFile(),
      lockFile: args.lockFile ?? defaultCollectorLockFile(),
      staleAfterMs: args.staleAfterMs,
      refreshStale: args.refreshStale,
      backfill: args.backfill,
      loadAccountObservationSecret: selection.loadAccountObservationSecret,
    });
    console.log(`Collector run-once: ${result.rolloutRecordsWritten} rollout record(s); refresh ${result.refresh.attempted ? (result.refresh.errorCode ?? (result.refresh.recordWritten ? "recorded" : "deduplicated")) : "not needed"}.`);
    console.log(`Data: ${result.dataFile}`);
    console.log(`Checkpoint: ${result.checkpointFile}`);
    return;
  }
  if (args.command === "collect-foreground") {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    const timer = args.durationMs === null ? null : setTimeout(abort, args.durationMs);
    try {
      const selection = selectedAccountObservation();
      const result = await runCollectorForegroundCommand({
        dataFile: args.dataFile === defaultDataFile() ? defaultCollectorDataFile() : args.dataFile,
        checkpointFile: args.checkpointFile ?? defaultCollectorCheckpointFile(),
        lockFile: args.lockFile ?? defaultCollectorLockFile(),
        staleAfterMs: args.staleAfterMs,
        reconciliationMs: args.reconciliationMs,
        signal: controller.signal,
        loadAccountObservationSecret: selection.loadAccountObservationSecret,
      });
      console.log(`Collector foreground exited cleanly: ${result.rolloutRecordsWritten} rollout record(s), ${result.appServerRecordsWritten} app-server record(s), ${result.reconnectAttempts} reconnect attempt(s).`);
    } finally {
      if (timer) clearTimeout(timer);
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
    return;
  }
  if (args.command === "experiment") {
    if (!args.manifestFile) throw new Error("experiment requires --manifest");
    const manifest = JSON.parse(await readFile(args.manifestFile, "utf8"));
    const result = await runExperiment({
      manifest,
      executeLive: args.executeLive,
      offline: args.offline,
    });
    args.resultFile ??= defaultExperimentResultsFile();
    await appendJsonLinesOwnerOnly(args.resultFile, [result]);
    console.log(`Experiment ${result.experimentId}: ${result.status}.`);
    console.log(`Projected API price: ${formatMoney(result.projection.totalUsd)}; stop reasons: ${result.stopReasons.join(", ") || "none"}.`);
    if (result.measuredLocal) console.log(`Measured local API price: ${formatMoney(result.measuredLocal.apiPricedUsd)}.`);
    console.log(`Result: ${args.resultFile}`);
    return;
  }
  if (args.command === "contamination") {
    args.transitionsFile ??= defaultTransitionFile();
    args.inferenceFile ??= defaultInferenceFile();
    args.experimentsFile ??= defaultExperimentResultsFile();
    args.observationsFile ??= defaultDataFile();
    args.outputFile ??= defaultContaminationFile();
    const transitionDataset = JSON.parse(await readFile(args.transitionsFile, "utf8"));
    const inferenceReport = JSON.parse(await readFile(args.inferenceFile, "utf8"));
    const experimentResults = await readObservations(args.experimentsFile);
    const captureObservations = await readObservations(args.observationsFile);
    const report = analyzeContamination({ transitionDataset, inferenceReport, experimentResults, captureObservations });
    args.reportFile ??= defaultContaminationReportFile(transitionDataset.scope?.endAt ?? transitionDataset.materializedAt);
    await writeJsonOwnerOnlyAtomic(args.outputFile, report);
    await writeOwnerOnlyAtomic(args.reportFile, renderContaminationReport(report));
    console.log(`Contamination intervals: ${report.summary.intervals}; unexplained: ${report.views.unexplainedMovement.count}; negative deltas: ${report.views.negativeDeltas.count}.`);
    console.log(`Control states: ${report.views.byControlState.controlled.intervals} controlled, ${report.views.byControlState.uncontrolled.intervals} uncontrolled, ${report.views.byControlState.unknown.intervals} unknown.`);
    console.log(`Report data: ${args.outputFile}`);
    console.log(`Human report: ${args.reportFile}`);
    return;
  }
  if (args.command === "tools") {
    if (!args.startAt || !args.endAt) throw new Error("tools requires --since and --until for a deterministic scan interval");
    if (!Number.isFinite(Date.parse(args.startAt)) || !Number.isFinite(Date.parse(args.endAt))) {
      throw new Error("--since and --until must be valid ISO timestamps");
    }
    const scan = await scanCodexLogEvents({ startAt: args.startAt, endAt: args.endAt });
    const clientSources = Object.entries(scan.toolObservationsBySource)
      .filter(([sourceKind]) => sourceKind.startsWith("client_"));
    const clientToolEvents = REQUIRED_TOOL_CLASSES.map((toolClass) => ({
      toolClass,
      sourceKind: "client_aggregate",
      count: clientSources.reduce((total, [, counts]) => total + (counts[toolClass] ?? 0), 0),
    })).filter((event) => event.count > 0);
    const officialBillingEvidence = Object.entries(scan.serverBillableUnits).map(([serverBillableUnit, serverUnitCount]) => ({
      toolClass: serverBillableUnit === "responses_web_search_call" ? "web_search" : "file_search",
      sourceKind: "responses_typed_output_item",
      serverBillableUnit,
      serverUnitCount,
    }));
    const analysis = analyzeToolMechanisms({
      clientToolEvents,
      officialBillingEvidence,
      assessedToolClasses: REQUIRED_TOOL_CLASSES,
      scope: { startAt: args.startAt, endAt: args.endAt, provider: "openai_codex", localOnly: true },
    });
    analysis.localObservationDiagnostics = {
      toolCallsByClass: scan.toolCallsByClass,
      toolObservationsBySource: scan.toolObservationsBySource,
      serverBillableUnits: scan.serverBillableUnits,
      replayedToolCallsSkipped: scan.diagnostics.replayedToolCallsSkipped,
      sourceLayoutBoundary: "rollout_file_count_excluded_because_later_forks_can_add_lineage_files_without_changing_fixed_interval_aggregates",
    };
    args.outputFile ??= defaultToolMechanismFile();
    args.reportFile ??= defaultToolMechanismReportFile(args.endAt);
    await writeJsonOwnerOnlyAtomic(args.outputFile, analysis);
    await writeOwnerOnlyAtomic(args.reportFile, renderToolMechanismReport(analysis));
    console.log(`Tool mechanism gate: ${analysis.acceptanceGate.passed ? "pass" : "fail"} (${analysis.acceptanceGate.basis}).`);
    console.log(`Client events assessed: ${analysis.summary.totalClientEventCount}; matched provider units: ${analysis.summary.totalMatchedServerUnitCount}.`);
    console.log(`Report data: ${args.outputFile}`);
    console.log(`Human report: ${args.reportFile}`);
    return;
  }
  if (args.command === "migrate-corrections") {
    args.observationsFile ??= defaultDataFile();
    args.transitionsFile ??= frozenTransitionFile();
    args.correctionsFile ??= defaultCorrectionsFile();
    args.outputFile ??= defaultEffectiveObservationsFile();
    const observations = await readObservations(args.observationsFile);
    const transitionDataset = JSON.parse(await readFile(args.transitionsFile, "utf8"));
    const migration = await withOwnerOnlyFileLock(`${args.correctionsFile}.lock`, async () => {
      const existingCorrections = await readObservations(args.correctionsFile);
      const planned = planBaselineCorrectionMigration({ observations, transitionDataset, existingCorrections });
      await appendJsonLinesOwnerOnly(args.correctionsFile, planned.recordsToAppend);
      return planned;
    });
    args.reportFile ??= defaultCorrectionReportFile(transitionDataset.scope.endAt);
    await writeJsonOwnerOnlyAtomic(args.outputFile, migration.resolution);
    await writeOwnerOnlyAtomic(args.reportFile, renderCorrectionReport(migration.resolution));
    const effective = migration.resolution.effectiveByOriginalId[migration.baselineObservationId];
    console.log(`Correction migration: ${migration.recordsToAppend.length === 0 ? "already applied" : "appended 1 record"}.`);
    console.log(`Effective aggregate tokens: ${effective.derived.aggregateTokenTotal}; warnings: ${effective.derived.warnings.join(", ") || "none"}.`);
    console.log(`Corrections: ${args.correctionsFile}`);
    console.log(`Effective data: ${args.outputFile}`);
    console.log(`Human report: ${args.reportFile}`);
    return;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(`usage-monitor: ${error.message}`);
    process.exitCode = 1;
  });
}
