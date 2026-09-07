import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPr94Revision } from "./pr94-revision-loader.mjs";
import { buildPr94PopulationEvidence } from "./pr94-population-evidence.mjs";
import { inspectDetailedAccountingBenchmarkIndex,
  projectDetailedAccountingBenchmarkGeneration } from "../benchmark-detailed-accounting.mjs";
import {
  createPr94LedgerEvidence,
  iteratePr94LedgerEvidencePrivate,
  disposePr94LedgerEvidencePrivate,
} from "./pr94-ledger-evidence.mjs";
import {
  buildPr94CalibrationEvidence,
  iteratePr94CalibrationPrivateFrames,
  disposePr94CalibrationEvidencePrivate,
} from "./pr94-calibration-evidence.mjs";

const MAX_RSS = 6_442_450_944;
const MAX_USAGE = 1_000_000;
const MAX_QUOTA = 1_000_000;
const MAX_TRANSITIONS = 200_000;
const WEEKLY = 10_080;
export const PR94_ANALYSIS_ERROR_CODES = Object.freeze([
  "pr94_resource_limit", "pr94_inputs_invalid", "pr94_attribution_index_incomplete", "pr94_derivation_invalid",
  "pr94_private_artifact_limit", "pr94_private_artifact_write_failed", "pr94_inventory_invalid", "pr94_path_invalid",
  "pr94_generation_incomplete", "pr94_inventory_mismatch", "pr94_reader_incomplete", "pr94_result_limit",
  "pr94_runtime_invalid", "pr94_request_invalid", "pr94_population_invalid", "pr94_instrumentation_invalid",
  "transition_derivation_input_limit_exceeded", "transition_derivation_row_limit_exceeded", "transition_derivation_work_limit_exceeded",
  "pr94_ledger_row_rejected", "pr94_ledger_invalid", "pr94_ledger_state", "pr94_ledger_private_evidence_required",
  "pr94_analysis_failed",
  ...["aggregate_invalid", "baseline_population_mismatch", "candidates_invalid", "count_invalid", "diagnostic_multiplied",
    "duplicate_parent", "eligibility_drift", "evidence_untrusted", "fit_gate_drift", "fit_source_unrecognized",
    "fragment_limit", "fragment_multiplied", "fragment_reason_unknown", "group_multiplied", "group_unreconciled",
    "hmac_key_invalid", "identity_invalid", "input_invalid", "internal_missing", "parent_candidate_missing",
    "parent_invalid", "parent_multiplied", "parent_out_of_scope", "primary_multiplied", "private_frames_invalid",
    "report_count_mismatch", "report_distribution_mismatch", "report_fit_mismatch", "report_fragment_mismatch",
    "report_group_mismatch", "report_rejected_fit", "report_suppressed_fit", "scope_invalid", "seal_invalid",
    "snapshot_partition_invalid", "suppression_unknown", "transition_parent_missing"].map((name) => `pr94_calibration_${name}`),
]);
const TOKEN_COLUMNS = Object.freeze([
  "tokens_in_uncached", "tokens_in_cache_read", "tokens_in_cache_write",
  "tokens_out_text", "tokens_out_reasoning", "tokens_out_combined",
]);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function checkResource() {
  if (process.memoryUsage.rss() > MAX_RSS) fail("pr94_resource_limit");
}
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function parentKey(row) {
  return JSON.stringify([row.accountScopeId ?? "unattributed", row.provider,
    row.planType ?? "unknown", row.limitId, row.windowDurationMins, row.resetsAt]);
}
function quotaIdentity(snapshot) {
  return { accountScopeId: snapshot.accountScopeId ?? null,
    provider: snapshot.window.provider, planType: snapshot.window.planType ?? "unknown",
    planVariant: snapshot.window.planVariant ?? "unknown", limitId: snapshot.window.limitId,
    windowDurationMins: snapshot.window.windowDurationMins, resetsAt: snapshot.window.resetsAt };
}

export function buildPr94QuotaGroups(snapshots, { quota, revisionKind }) {
  if (!Array.isArray(snapshots) || snapshots.length > MAX_QUOTA
      || !["before", "after", "final"].includes(revisionKind)) fail("pr94_inputs_invalid");
  let attribution = null;
  if (revisionKind !== "before") {
    attribution = quota.buildPlanAttributionIndex(snapshots.map((snapshot) => ({
      contextKey: quota.planAttributionContextKey(snapshot.window.provider, snapshot.window.limitId),
      observedAtMs: snapshot.timestampMs,
      planType: snapshot.window.planType,
      planVariant: snapshot.window.planVariant ?? "unknown",
      accountScopeId: snapshot.accountScopeId ?? null,
    })));
    // Unknown-plan anchors intentionally contribute to ignoredObservationCount;
    // the original owner retains their conditional era. They are not malformed
    // input and must not be relabelled as a failed/incomplete discovery.
    if (attribution.status !== "ready") {
      fail("pr94_attribution_index_incomplete");
    }
  }
  const groups = new Map();
  let latestMs = -Infinity;
  let latestPlans = new Set();
  for (const snapshot of snapshots) {
    if (snapshot.window.provider !== "openai_codex" || snapshot.window.limitId !== "codex") continue;
    const plan = snapshot.window.planType;
    if (typeof plan === "string" && plan !== "unknown") {
      if (snapshot.timestampMs > latestMs) { latestMs = snapshot.timestampMs; latestPlans = new Set(); }
      if (snapshot.timestampMs === latestMs) latestPlans.add(plan);
    }
    if (snapshot.window.windowDurationMins !== WEEKLY) continue;
    const identity = quotaIdentity(snapshot);
    const key = parentKey(identity);
    let group = groups.get(key);
    if (!group) {
      group = { identity, snapshots: [], unique: new Set(), percents: new Set(),
        matchedUnique: new Set(), matchedPercents: new Set(), matched: 0,
        conflicted: 0, unavailable: 0 };
      groups.set(key, group);
    }
    group.snapshots.push(snapshot);
    const observationKey = `${snapshot.timestampMs}|${snapshot.window.usedPercent}`;
    group.unique.add(observationKey);
    group.percents.add(snapshot.window.usedPercent);
    const lookup = attribution === null ? null : quota.planEraForInterval(attribution, {
      contextKey: quota.planAttributionContextKey(snapshot.window.provider, snapshot.window.limitId),
      observedAtMs: snapshot.timestampMs, accountScopeId: snapshot.accountScopeId ?? null,
    });
    const matched = attribution === null
      || (lookup.status === "matched" && lookup.era.planType === snapshot.window.planType);
    if (matched) {
      group.matched += 1;
      group.matchedUnique.add(observationKey);
      group.matchedPercents.add(snapshot.window.usedPercent);
    } else if (lookup.status === "conflicted") group.conflicted += 1;
    else group.unavailable += 1;
  }
  const rawParents = [...groups.values()].map((group) => ({
    ...group.identity, snapshotCount: group.snapshots.length,
    uniqueSnapshotCount: group.unique.size, distinctPercentCount: group.percents.size,
    matchedSnapshotCount: group.matched,
    matchedUniqueSnapshotCount: group.matchedUnique.size,
    matchedDistinctPercentCount: group.matchedPercents.size,
    conflictedSnapshotCount: group.conflicted, unavailableSnapshotCount: group.unavailable,
  }));
  for (const group of groups.values()) {
    delete group.unique; delete group.percents;
    delete group.matchedUnique; delete group.matchedPercents;
  }
  return { attribution, rawParents, groups: [...groups.values()],
    selectedPlanType: latestPlans.size === 1 ? [...latestPlans][0] : "unknown" };
}

function bound(values, target, inclusive) {
  let low = 0; let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle].timestampMs < target
        || (inclusive && values[middle].timestampMs === target)) low = middle + 1;
    else high = middle;
  }
  return low;
}

// These are the original miner's groups, not a second implementation of its
// era or transition policy. Bind every summary to its input parent and emitted
// rows before retaining only bounded, content-free counts for reconciliation.
function originalDerivationEvidence(result, identity, attributed) {
  if (!Array.isArray(result.groupSummaries) || result.groupSummaries.length > MAX_QUOTA
      || result.windowGroupCount !== result.groupSummaries.length) fail("pr94_derivation_invalid");
  const expectedParent = parentKey(identity);
  const rowCounts = new Map();
  for (const row of result.transitions) {
    if (parentKey(row) !== expectedParent) fail("pr94_derivation_invalid");
    const era = attributed ? row.planEraKey : "legacy";
    if (typeof era !== "string" || era.length === 0 || era.length > 4096) fail("pr94_derivation_invalid");
    rowCounts.set(era, (rowCounts.get(era) ?? 0) + 1);
  }
  const seen = new Set();
  const evidence = { groupCount: result.groupSummaries.length, snapshotCount: 0,
    transitionCount: 0, zeroTransitionGroupCount: 0 };
  for (const summary of result.groupSummaries) {
    if (!summary || parentKey(summary) !== expectedParent
        || !["primary", "secondary"].includes(summary.slot)
        || !integer(summary.snapshotCount) || summary.snapshotCount < 1 || summary.snapshotCount > MAX_QUOTA
        || !integer(summary.transitionCount) || summary.transitionCount >= summary.snapshotCount
        || !integer(summary.monotonicTransitionCount) || !integer(summary.regressionTransitionCount)
        || summary.monotonicTransitionCount + summary.regressionTransitionCount !== summary.transitionCount) {
      fail("pr94_derivation_invalid");
    }
    const era = attributed ? summary.planEraKey : "legacy";
    if (typeof era !== "string" || era.length === 0 || era.length > 4096 || seen.has(era)
        || (rowCounts.get(era) ?? 0) !== summary.transitionCount) fail("pr94_derivation_invalid");
    seen.add(era);
    rowCounts.delete(era);
    evidence.snapshotCount += summary.snapshotCount;
    evidence.transitionCount += summary.transitionCount;
    evidence.zeroTransitionGroupCount += Number(summary.transitionCount === 0);
    if (evidence.snapshotCount > MAX_QUOTA || evidence.transitionCount > MAX_TRANSITIONS) fail("pr94_derivation_invalid");
  }
  if (rowCounts.size !== 0 || evidence.snapshotCount !== result.deduplicatedSnapshotCount
      || evidence.transitionCount !== result.transitions.length) fail("pr94_derivation_invalid");
  return Object.freeze(evidence);
}

export async function derivePr94BatchedTransitions({ modules, usage, grouped, startAt, endAt,
  resourceCheck = checkResource }) {
  const transitions = [];
  let deduplicatedSnapshotCount = 0;
  let maximumUsageSlice = 0;
  let maximumQuotaSlice = 0;
  const rawParents = new Map(grouped.rawParents.map((parent) => [parentKey(parent), parent]));
  if (rawParents.size !== grouped.rawParents.length || rawParents.size !== grouped.groups.length) fail("pr94_derivation_invalid");
  for (const group of grouped.groups) {
    resourceCheck();
    const windowStart = (group.identity.resetsAt - WEEKLY * 60) * 1000;
    const lastObserved = group.snapshots.at(-1).timestampMs;
    const low = bound(usage, Math.max(Date.parse(startAt), windowStart), false);
    const high = bound(usage, lastObserved, true);
    const slice = usage.slice(low, high);
    maximumUsageSlice = Math.max(maximumUsageSlice, slice.length);
    maximumQuotaSlice = Math.max(maximumQuotaSlice, group.snapshots.length);
    const result = await modules.miner.deriveCodexTransitionSeriesCooperatively({
      startAt, endAt, rawUsageEvents: slice, rateLimitSnapshots: group.snapshots.slice(),
      diagnostics: {}, includeSnapshotIntervals: false, windowDurationMins: WEEKLY,
      includeNormalizedInputs: false, consumeInputs: true,
      resourceCheck, ...(grouped.attribution ? { planAttributionIndex: grouped.attribution } : {}),
    });
    if (!integer(result.deduplicatedSnapshotCount) || result.deduplicatedSnapshotCount > group.snapshots.length
        || !Array.isArray(result.transitions) || result.transitions.length > MAX_TRANSITIONS) {
      fail("pr94_derivation_invalid");
    }
    const parent = rawParents.get(parentKey(group.identity));
    const derivationEvidence = originalDerivationEvidence(result, group.identity, grouped.attribution !== null);
    if (!parent || derivationEvidence.snapshotCount !== parent.matchedUniqueSnapshotCount) fail("pr94_derivation_invalid");
    parent.derivationEvidence = derivationEvidence;
    rawParents.delete(parentKey(group.identity));
    deduplicatedSnapshotCount += result.deduplicatedSnapshotCount;
    if (transitions.length + result.transitions.length > MAX_TRANSITIONS) fail("pr94_resource_limit");
    for (const row of result.transitions) transitions.push(row);
  }
  if (rawParents.size !== 0) fail("pr94_derivation_invalid");
  transitions.sort((a, b) => a.eventTime.localeCompare(b.eventTime)
    || a.resetIdentity.localeCompare(b.resetIdentity)
    || a.windowDurationMins - b.windowDurationMins || a.slot.localeCompare(b.slot));
  return { transitions, deduplicatedSnapshotCount,
    batchMetrics: { batches: grouped.groups.length, maximumUsageSlice, maximumQuotaSlice } };
}

async function writePrivateFrames(path, frames) {
  const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
  // Observe asynchronous errors even before the next drain/end wait.
  let streamError = null;
  output.on("error", (error) => { streamError = error; });
  let bytes = 0;
  try {
    for (const frame of frames) {
      if (streamError) throw streamError;
      const line = `${JSON.stringify(frame)}\n`;
      bytes += Buffer.byteLength(line);
      if (bytes > 512 * 1024 * 1024) fail("pr94_private_artifact_limit");
      if (!output.write(line)) await once(output, "drain");
    }
    output.end();
    await once(output, "close");
    if (streamError) throw streamError;
    return bytes;
  } catch {
    output.destroy();
    fail("pr94_private_artifact_write_failed");
  }
}

function indexInventory(database, generation, startMs, endMs) {
  const totals = database.prepare(`SELECT COUNT(*) AS count,
    SUM(CASE WHEN ${TOKEN_COLUMNS.map((column) => `COALESCE(${column},0)`).join("+")}=0
      THEN 1 ELSE 0 END) AS zeroCount FROM usage_event
    WHERE observed_at_ms >= ? AND observed_at_ms <= ?`).get(startMs, endMs);
  const quota = { admitted: 0, held: 0, suppressed: 0 };
  for (const row of database.prepare(`SELECT admission,COUNT(*) AS count FROM quota_occurrence
    WHERE observed_at_ms >= ? AND observed_at_ms <= ? GROUP BY admission`).all(startMs, endMs)) {
    if (!Object.hasOwn(quota, row.admission) || !integer(row.count)) fail("pr94_inventory_invalid");
    quota[row.admission] = row.count;
  }
  if (!integer(totals.count) || !integer(totals.zeroCount)
      || totals.zeroCount > totals.count) fail("pr94_inventory_invalid");
  return { indexedUsageRows: totals.count, zeroComponentUsageRows: totals.zeroCount, quota,
    generationUsageRows: generation.usageEvents, generationQuotaRows: generation.quotaOccurrences };
}

function safeCoverage(result) {
  if (result?.coverage?.status !== "complete") fail("pr94_reader_incomplete");
  // Complete accounting coverage is not complete tool provenance. The exact
  // generation descriptor is independently projected by the coordinator.
  return { accountingStatus: "complete",
    diagnosticsSha256: createHash("sha256").update(JSON.stringify(result.diagnostics)).digest("hex"),
    compatibilitySha256: createHash("sha256").update(JSON.stringify(result.compatibility)).digest("hex") };
}

export function validatePr94WorkerOptions(options) {
  const keys = ["root", "indexFile", "outputDirectory", "startAt", "endAt", "revisionKind"];
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).sort().join("|") !== keys.sort().join("|")) fail("pr94_request_invalid");
  for (const name of ["root", "indexFile", "outputDirectory"]) {
    if (typeof options[name] !== "string" || options[name].includes("\0")
        || resolve(options[name]) !== options[name]) fail("pr94_request_invalid");
  }
  for (const name of ["startAt", "endAt"]) {
    if (typeof options[name] !== "string" || !Number.isSafeInteger(Date.parse(options[name]))
        || new Date(options[name]).toISOString() !== options[name]) fail("pr94_request_invalid");
  }
  if (options.startAt >= options.endAt || !["before", "after", "final"].includes(options.revisionKind)) {
    fail("pr94_request_invalid");
  }
  return options;
}

export async function runPr94AnalysisWorker(options, hmacKey) {
  validatePr94WorkerOptions(options);
  const { root, indexFile, outputDirectory, startAt, endAt, revisionKind } = options;
  const directory = await lstat(outputDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()
      || directory.uid !== process.getuid() || (directory.mode & 0o077)
      || await realpath(outputDirectory) !== outputDirectory) fail("pr94_path_invalid");
  await inspectDetailedAccountingBenchmarkIndex(indexFile);
  const modules = await loadPr94Revision(root);
  const database = modules.index.openLocalUnifiedIndex(indexFile, { readOnly: true });
  let generation; let inventory;
  try {
    generation = modules.index.readUnifiedIndexGenerationDescriptor(database);
    inventory = indexInventory(database, generation, Date.parse(startAt), Date.parse(endAt));
  } finally { database.close(); }
  if (generation.skippedSourceCount !== 0 || generation.skippedThreadCount !== 0
      || !generation.discoveryComplete || !generation.usageProvenanceComplete
      || !generation.quotaProvenanceComplete) fail("pr94_generation_incomplete");
  const generationEvidence = projectDetailedAccountingBenchmarkGeneration(generation);
  const ledger = createPr94LedgerEvidence({ hmacKey, maxRows: 2_000_000 });
  const usage = []; const snapshots = []; const costs = [];
  let lastUsage = -Infinity; let lastQuota = -Infinity;
  const phaseMs = {};
  let started = performance.now();
  const scanResult = await modules.reader.createLocalUnifiedAccountingSource({
    indexFile, requireComplete: true, expectedGeneration: generation,
    verifyPublishedGeneration: true, contextBehavior: "legacy_zero",
  })({ startAt, endAt,
    onUsage(event) {
      if (usage.length >= MAX_USAGE || event.timestampMs < lastUsage) fail("pr94_inputs_invalid");
      lastUsage = event.timestampMs;
      const price = modules.accounting.priceCodexUsageEvent(event);
      ledger.consumeUsage(event, price);
      usage.push(event);
      costs.push(price.totalUsd);
      if (usage.length % 2048 === 0) checkResource();
    },
    onRateLimitSnapshot(snapshot) {
      if (snapshots.length >= MAX_QUOTA || snapshot.timestampMs < lastQuota) fail("pr94_inputs_invalid");
      lastQuota = snapshot.timestampMs;
      ledger.consumeQuota(snapshot);
      snapshots.push({ timestamp: snapshot.timestamp, timestampMs: snapshot.timestampMs,
        window: snapshot.window, ...(snapshot.accountScopeId ? { accountScopeId: snapshot.accountScopeId } : {}) });
      if (snapshots.length % 2048 === 0) checkResource();
    },
  });
  phaseMs.readAndLedger = Math.round(performance.now() - started);
  if (usage.length + inventory.zeroComponentUsageRows !== inventory.indexedUsageRows
      || snapshots.length !== inventory.quota.admitted) fail("pr94_inventory_mismatch");
  const coverage = safeCoverage(scanResult);
  const ledgerEvidence = ledger.finish();
  const privateLedgerBytes = await writePrivateFrames(join(outputDirectory, "ledger.ndjson"),
    iteratePr94LedgerEvidencePrivate(ledgerEvidence));
  disposePr94LedgerEvidencePrivate(ledgerEvidence);
  started = performance.now();
  const grouped = buildPr94QuotaGroups(snapshots, { quota: modules.quota, revisionKind });
  snapshots.length = 0;
  checkResource();
  const populationEvidence = buildPr94PopulationEvidence({ usage, costs, ledger: ledgerEvidence,
    quota: modules.quota, attribution: grouped.attribution, revisionKind, resourceCheck: checkResource });
  costs.length = 0;
  const derived = await derivePr94BatchedTransitions({ modules, usage, grouped, startAt, endAt });
  phaseMs.attributionAndDerivation = Math.round(performance.now() - started);
  usage.length = 0;
  started = performance.now();
  const calibration = buildPr94CalibrationEvidence({
    internals: modules.reporting.__pr94CalibrationInternals,
    analyzeWeeklyCalibration: modules.reporting.analyzeWeeklyCalibration,
    candidates: modules.reporting.WEEKLY_CALIBRATION_CANDIDATES,
    transitions: derived.transitions, rawParents: grouped.rawParents,
    revisionKind, hmacKey, scope: { startAt, endAt }, selectedPlanType: grouped.selectedPlanType,
  });
  phaseMs.calibrationAndReconciliation = Math.round(performance.now() - started);
  const privateCalibrationBytes = await writePrivateFrames(join(outputDirectory, "calibration.ndjson"),
    iteratePr94CalibrationPrivateFrames(calibration));
  disposePr94CalibrationEvidencePrivate(calibration);
  checkResource();
  const result = { schema: "pr94-analysis-worker-v1", revisionKind,
    // This is the shipped detailed-accounting policy, not a claim that unknown
    // source-native context was actually observed as zero.
    contextBehavior: "legacy_zero", generation: generationEvidence,
    attributionIndex: grouped.attribution === null ? null : {
      observationCount: grouped.attribution.observationCount,
      ignoredObservationCount: grouped.attribution.ignoredObservationCount,
      eras: grouped.attribution.eras.length, conflicts: grouped.attribution.conflicts.length,
      contexts: grouped.attribution.contexts.size,
    },
    instrumentation: modules.instrumentation, inventory, coverage,
    ledger: ledgerEvidence, calibration, populationEvidence, batchMetrics: derived.batchMetrics,
    deduplicatedWeeklySnapshots: derived.deduplicatedSnapshotCount, phaseMs,
    privateArtifactBytes: { ledger: privateLedgerBytes, calibration: privateCalibrationBytes } };
  const body = JSON.stringify(result);
  if (Buffer.byteLength(body) > 4 * 1024 * 1024) fail("pr94_result_limit");
  await writeFile(join(outputDirectory, "analysis.json"), body, { flag: "wx", mode: 0o600 });
  return { status: "ok", resultBytes: Buffer.byteLength(body),
    resultSha256: createHash("sha256").update(body).digest("hex") };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.version !== "v26.2.0" || process.platform !== "darwin" || process.arch !== "arm64") {
      fail("pr94_runtime_invalid");
    }
    const chunks = []; let requestBytes = 0;
    for await (const chunk of process.stdin) {
      requestBytes += chunk.length;
      if (requestBytes > 32 * 1024) fail("pr94_request_invalid");
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks).toString("utf8");
    const { hmacKey: key, ...options } = JSON.parse(input);
    if (typeof key !== "string" || !/^[0-9a-f]{64}$/u.test(key)) fail("pr94_request_invalid");
    const envelope = await runPr94AnalysisWorker(options, Buffer.from(key, "hex"));
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } catch (error) {
    // A lower-level Error may contain private paths or input. Do not print it.
    const codes = new Set(PR94_ANALYSIS_ERROR_CODES);
    process.stdout.write(`${JSON.stringify({ status: "error",
      code: codes.has(error?.code ?? error?.message) ? error.code ?? error.message : "pr94_analysis_failed" })}\n`);
  }
}
