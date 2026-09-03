import { PR94_LEDGER_COMPONENTS, validatePr94LedgerEvidenceAggregate } from "./pr94-ledger-evidence.mjs";
import { validatePr94ProductionResourceEvidence, validatePr94ProductionResourceOutcome } from "./pr94-production-resource-worker.mjs";
import { validatePr94PopulationEvidence } from "./pr94-population-evidence.mjs";

// This module validates only the content-free public projections. Private
// frame files remain the authority for row-level comparison and are never
// accepted by these functions.
const ANALYSIS_SCHEMA = "pr94-analysis-worker-v1";
const RECEIPT_SCHEMA = "pr94-admitted-index-comparison-v2";
const CALIBRATION_SCHEMA = "pr94-calibration-evidence-v2";
const CALIBRATION_COMPARISON_SCHEMA = "pr94-calibration-comparison-v2";
const LEDGER_COMPARISON_SCHEMA = "pr94-ledger-comparison-v1";
const HASH = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const INSTANT_LENGTH = 24;
const MAX_RSS = 6_442_450_944;
const MAX_PHASE_MS = 3_600_000;
const MAX_USAGE = 1_000_000;
const MAX_QUOTA = 1_000_000;
const MAX_TRANSITIONS = 200_000;
const MAX_LEDGER_ROWS = 2_000_000;
const MAX_CALIBRATION_PARENTS = 10_000;
const MAX_CALIBRATION_FRAGMENTS = 40_000;
const MAX_CALIBRATION_ITEMS = MAX_CALIBRATION_FRAGMENTS * 4;
const MAX_INDEX_BYTES = 32 * 1024 * 1024 * 1024;
const PR94_COMPARISON_REVISIONS = Object.freeze({
  before: "a3c850360bc83c0e27bef2171aeb4a302b72f472",
  after: "20f449ff5c222989029fe343f219f02b497ae1d4",
});

const CANDIDATES = Object.freeze([
  "standard_api", "speed_lower", "speed_midpoint", "speed_upper",
]);
const PRIMARY_TRANSITIONS = Object.freeze([
  "retained_primary", "lost_primary", "new_primary", "no_primary", "missing_parent",
]);
const PLANS = new Set([
  "free", "plus", "pro", "pro_lite", "team", "business", "enterprise", "edu", "unknown", "other",
]);
const OUTCOMES = Object.freeze([
  "selected_plan_primary", "alternate_plan_primary", "unselected_plan_primary",
  "losing_qualifying_fragment", "simultaneous_slot_conflict",
  "near_duplicate_reset_identity_with_less_evidence", "overlapping_observation_window",
  "aggregation_diagnostic_only", "insufficient_unique_boundaries", "insufficient_percent_span",
  "training_capacity_unavailable", "insufficient_training_pairs", "full_capacity_unavailable",
  "relative_width_unavailable", "relative_width_exceeded", "insufficient_snapshots",
  "no_percent_change", "no_within_era_percent_change", "all_snapshot_attribution_withheld", "unexplained_no_transition",
]);
const ROW_REASONS = Object.freeze([
  "eligible", "aggregation_diagnostic_only", "non_increasing_percent", "no_usage",
  "partial_elapsed_coverage", "pricing_warning", "attribution_warning",
]);
const GENERATION_COUNTS = Object.freeze([
  "indexedSourceCount", "indexedSourceBytes", "skippedSourceCount", "skippedSourceBytes",
  "skippedThreadCount", "usageEvents", "quotaOccurrences", "toolFacts",
]);
const ACCOUNT_CHECK_COUNTS = Object.freeze([
  "fragmentCandidatesChecked", "rowsChecked", "changedEligibilityRows", "changedPointSets",
  "changedFits", "unknownOnlyFitExclusions",
]);
const CALIBRATION_COMPARISON_COUNTS = Object.freeze([
  "beforeParentCandidates", "afterParentCandidates", "missingParentCandidates", "addedParentCandidates",
  "reconciledParentCandidates", "identicalFitInputsCompared", "changedIdenticalInputFits", "unexplainedParents",
  "changedRawParentInventory", "baselinePrimaryFits", "retainedPrimaryFits", "lostPrimaryFits", "newPrimaryFits",
  "changedInputPrimaryLosses", "rejectedIdenticalInputFits", "unexplainedPrimaryLosses",
  "retainedPrimaryInputChanges", "changedOutcomeParentCandidates",
]);
const ANALYSIS_KEYS = Object.freeze([
  "schema", "revisionKind", "contextBehavior", "generation", "attributionIndex",
  "instrumentation", "inventory", "coverage", "ledger", "calibration", "populationEvidence", "batchMetrics",
  "deduplicatedWeeklySnapshots", "phaseMs", "privateArtifactBytes",
]);
const RECEIPT_KEYS = Object.freeze([
  "schema", "status", "scope", "sources", "index", "window", "comparison",
  "measurements", "productionResources", "evidence",
]);

function reject() {
  throw new Error("invalid_pr94_receipt_value");
}

function publicError(kind) {
  const code = `pr94_receipt_${kind}_invalid`;
  return Object.assign(new Error(code), { code });
}

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject();
  const expected = new Set(keys);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expected.size) reject();
  for (const key of ownKeys) {
    if (typeof key !== "string" || !expected.has(key)) reject();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) reject();
  }
  return value;
}

function list(value, maximum) {
  if (!Array.isArray(value) || !Number.isSafeInteger(value.length) || value.length > maximum) reject();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) reject();
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) reject();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) reject();
  }
  return value;
}

function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum || Object.is(value, -0)) reject();
  return value;
}

function finite(value, minimum = -Infinity, maximum = Infinity) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum
      || Object.is(value, -0)) reject();
  return value;
}

function boolean(value) {
  if (typeof value !== "boolean") reject();
  return value;
}

function member(value, values) {
  if (!values.includes(value)) reject();
  return value;
}

function hash(value) {
  if (typeof value !== "string" || !HASH.test(value)) reject();
  return value;
}

function revision(value) {
  if (typeof value !== "string" || !REVISION.test(value)) reject();
  return value;
}

function instant(value) {
  if (typeof value !== "string" || value.length !== INSTANT_LENGTH
      || !Number.isSafeInteger(Date.parse(value)) || new Date(value).toISOString() !== value) reject();
  return value;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateGeneration(value) {
  exact(value, ["id", "fingerprintSha256", "publicationStatus", "publicationBlockReason",
    "toolProvenanceComplete", ...GENERATION_COUNTS]);
  integer(value.id, 1);
  hash(value.fingerprintSha256);
  member(value.publicationStatus, ["complete", "partial"]);
  member(value.publicationBlockReason, [null, "tool_provenance_incomplete", "codex_rollout_sources_quarantined"]);
  boolean(value.toolProvenanceComplete);
  for (const key of GENERATION_COUNTS) integer(value[key]);
  return value;
}

function validateAttributionIndex(value, revisionKind) {
  if (revisionKind === "before") {
    if (value !== null) reject();
    return value;
  }
  exact(value, ["observationCount", "ignoredObservationCount", "eras", "conflicts", "contexts"]);
  for (const key of ["observationCount", "ignoredObservationCount", "eras", "conflicts", "contexts"]) {
    integer(value[key], 0, MAX_QUOTA);
  }
  if (value.ignoredObservationCount > value.observationCount
      || value.eras > value.observationCount || value.conflicts > value.observationCount
      || value.contexts > value.observationCount) reject();
  return value;
}

function validateInstrumentation(value) {
  exact(value, ["sourceSha256", "instrumentationSha256", "transformation"]);
  hash(value.sourceSha256); hash(value.instrumentationSha256);
  if (value.transformation !== "append_exports_only") reject();
  return value;
}

function validateInventory(value, generation) {
  exact(value, ["indexedUsageRows", "zeroComponentUsageRows", "quota",
    "generationUsageRows", "generationQuotaRows"]);
  integer(value.indexedUsageRows, 0, MAX_USAGE);
  integer(value.zeroComponentUsageRows, 0, MAX_USAGE);
  if (value.zeroComponentUsageRows > value.indexedUsageRows) reject();
  exact(value.quota, ["admitted", "held", "suppressed"]);
  for (const key of ["admitted", "held", "suppressed"]) integer(value.quota[key], 0, MAX_QUOTA);
  if (value.quota.admitted + value.quota.held + value.quota.suppressed > generation.quotaOccurrences) reject();
  integer(value.generationUsageRows);
  integer(value.generationQuotaRows);
  if (value.generationUsageRows !== generation.usageEvents
      || value.generationQuotaRows !== generation.quotaOccurrences) reject();
  return value;
}

function validateCoverage(value) {
  exact(value, ["accountingStatus", "diagnosticsSha256", "compatibilitySha256"]);
  if (value.accountingStatus !== "complete") reject();
  hash(value.diagnosticsSha256); hash(value.compatibilitySha256);
  return value;
}

function validatePopulation(value, ledger, revisionKind) {
  try { validatePr94PopulationEvidence(value); } catch { reject(); }
  if (value.revisionKind !== revisionKind || value.totals.events !== ledger.usage.events
      || value.totals.totalUsd !== ledger.usage.totalUsd) reject();
  for (const name of PR94_LEDGER_COMPONENTS) {
    const population = value.totals.components[name];
    const ledgerComponent = ledger.usage.components[name];
    for (const key of ["quantity", "observedEvents", "missingEvents", "unavailableEvents"]) {
      if (population[key] !== ledgerComponent[key]) reject();
    }
  }
  return value;
}

function validateCalibrationDistribution(value, kind) {
  exact(value, ["count", "median", "central80"]);
  integer(value.count, 0, MAX_CALIBRATION_ITEMS);
  exact(value.central80, ["lower", "upper"]);
  if (value.count === 0) {
    if (value.median !== null || value.central80.lower !== null || value.central80.upper !== null) reject();
    return value;
  }
  const minimum = kind === "capacity" ? Number.MIN_VALUE : 0;
  finite(value.median, minimum);
  finite(value.central80.lower, minimum);
  finite(value.central80.upper, minimum);
  if (value.central80.lower > value.central80.upper) reject();
  return value;
}

function validateCalibrationCandidate(value, parentMaximum) {
  exact(value, ["candidateId", "parentCandidates", "outcomes", "primary", "diagnostic", "spans", "boundaries"]);
  member(value.candidateId, CANDIDATES);
  integer(value.parentCandidates, 0, parentMaximum);
  exact(value.outcomes, OUTCOMES);
  for (const outcome of OUTCOMES) integer(value.outcomes[outcome], 0, MAX_CALIBRATION_ITEMS);
  validateCalibrationDistribution(value.primary, "capacity");
  validateCalibrationDistribution(value.diagnostic, "capacity");
  validateCalibrationDistribution(value.spans, "span");
  validateCalibrationDistribution(value.boundaries, "boundaries");
  return value;
}

function validateCalibrationCandidateList(value, parentMaximum) {
  list(value, 4);
  if (value.length !== CANDIDATES.length) reject();
  const seen = new Set();
  value.forEach((candidate, index) => {
    validateCalibrationCandidate(candidate, parentMaximum);
    if (candidate.candidateId !== CANDIDATES[index] || seen.has(candidate.candidateId)) reject();
    seen.add(candidate.candidateId);
  });
  return value;
}

function validateCalibrationAggregateLocal(value) {
  exact(value, ["schemaVersion", "revisionKind", "selectedPlanType", "status", "counts",
    "rowReasons", "unknownAccountCheck", "candidates", "plans"]);
  if (value.schemaVersion !== CALIBRATION_SCHEMA) reject();
  member(value.revisionKind, ["before", "after", "final"]);
  member(value.selectedPlanType, [...PLANS]);
  member(value.status, ["pass", "fail"]);
  exact(value.counts, ["rawParents", "parentCandidates", "transitionRows", "parentsWithTransitions",
    "knownAccountParents", "unknownAccountParents", "unexplainedParents"]);
  integer(value.counts.rawParents, 0, MAX_CALIBRATION_PARENTS);
  integer(value.counts.parentCandidates, 0, MAX_CALIBRATION_PARENTS * 4);
  integer(value.counts.transitionRows, 0, MAX_TRANSITIONS);
  for (const key of ["parentsWithTransitions", "knownAccountParents", "unknownAccountParents", "unexplainedParents"]) {
    integer(value.counts[key], 0, MAX_CALIBRATION_PARENTS);
  }
  if (value.counts.parentCandidates !== value.counts.rawParents * 4
      || value.counts.parentsWithTransitions > value.counts.rawParents
      || value.counts.knownAccountParents + value.counts.unknownAccountParents !== value.counts.rawParents
      || value.counts.unexplainedParents > value.counts.rawParents) reject();

  exact(value.rowReasons, ROW_REASONS);
  let reasonTotal = 0;
  for (const reason of ROW_REASONS) {
    integer(value.rowReasons[reason], 0, MAX_TRANSITIONS);
    reasonTotal += value.rowReasons[reason];
  }
  if (reasonTotal !== value.counts.transitionRows) reject();

  exact(value.unknownAccountCheck, ["scope", ...ACCOUNT_CHECK_COUNTS]);
  if (value.unknownAccountCheck.scope !== "original_fit_gate_only") reject();
  for (const key of ACCOUNT_CHECK_COUNTS) {
    integer(value.unknownAccountCheck[key], 0,
      key === "rowsChecked" ? MAX_TRANSITIONS * 4 : MAX_CALIBRATION_ITEMS);
  }
  if (value.unknownAccountCheck.changedEligibilityRows > value.unknownAccountCheck.rowsChecked
      || value.unknownAccountCheck.changedPointSets > value.unknownAccountCheck.fragmentCandidatesChecked
      || value.unknownAccountCheck.changedFits > value.unknownAccountCheck.fragmentCandidatesChecked
      || value.unknownAccountCheck.unknownOnlyFitExclusions > value.unknownAccountCheck.changedFits
      || (value.unknownAccountCheck.fragmentCandidatesChecked === 0)
        !== (value.unknownAccountCheck.rowsChecked === 0)) reject();
  if (value.status !== (value.counts.unexplainedParents === 0
      && ACCOUNT_CHECK_COUNTS.slice(2).every((key) => value.unknownAccountCheck[key] === 0) ? "pass" : "fail")) reject();

  validateCalibrationCandidateList(value.candidates, value.counts.rawParents);
  list(value.plans, PLANS.size);
  const planCounts = Object.fromEntries(CANDIDATES.map((candidate) => [candidate, 0]));
  const seenPlans = new Set();
  let previousPlan = null;
  for (const plan of value.plans) {
    exact(plan, ["planType", "candidates"]);
    member(plan.planType, [...PLANS]);
    if (seenPlans.has(plan.planType) || (previousPlan !== null && plan.planType <= previousPlan)) reject();
    previousPlan = plan.planType;
    seenPlans.add(plan.planType);
    validateCalibrationCandidateList(plan.candidates, value.counts.rawParents);
    for (const candidate of plan.candidates) planCounts[candidate.candidateId] += candidate.parentCandidates;
  }
  for (const candidate of value.candidates) {
    if (planCounts[candidate.candidateId] !== candidate.parentCandidates) reject();
  }
  if ((value.counts.rawParents === 0) !== (value.plans.length === 0)) reject();
  return value;
}

/** Validate the public calibration projection owned by this receipt schema. */
export function validatePr94CalibrationAggregate(value) {
  return validateCalibrationAggregateLocal(value);
}

function validateBatchMetrics(value) {
  exact(value, ["batches", "maximumUsageSlice", "maximumQuotaSlice"]);
  integer(value.batches, 0, MAX_QUOTA);
  integer(value.maximumUsageSlice, 0, MAX_USAGE);
  integer(value.maximumQuotaSlice, 0, MAX_QUOTA);
  return value;
}

function validatePhaseMs(value) {
  exact(value, ["readAndLedger", "attributionAndDerivation", "calibrationAndReconciliation"]);
  for (const key of ["readAndLedger", "attributionAndDerivation", "calibrationAndReconciliation"]) {
    integer(value[key], 0, MAX_PHASE_MS);
  }
  return value;
}

function validatePrivateArtifactBytes(value) {
  exact(value, ["ledger", "calibration"]);
  integer(value.ledger, 1, 512 * 1024 * 1024);
  integer(value.calibration, 1, 512 * 1024 * 1024);
  return value;
}

function validateAnalysisLocal(value) {
  exact(value, ANALYSIS_KEYS);
  if (value.schema !== ANALYSIS_SCHEMA) reject();
  member(value.revisionKind, ["before", "after", "final"]);
  if (value.contextBehavior !== "legacy_zero") reject();
  const generation = validateGeneration(value.generation);
  validateAttributionIndex(value.attributionIndex, value.revisionKind);
  validateInstrumentation(value.instrumentation);
  const inventory = validateInventory(value.inventory, generation);
  validateCoverage(value.coverage);
  try { validatePr94LedgerEvidenceAggregate(value.ledger); } catch { reject(); }
  try { validatePr94CalibrationAggregate(value.calibration); } catch { reject(); }
  if (value.calibration.revisionKind !== value.revisionKind) reject();
  validatePopulation(value.populationEvidence, value.ledger, value.revisionKind);
  validateBatchMetrics(value.batchMetrics);
  integer(value.deduplicatedWeeklySnapshots, 0, MAX_USAGE);
  validatePhaseMs(value.phaseMs);
  validatePrivateArtifactBytes(value.privateArtifactBytes);
  if (value.ledger.usage.events !== inventory.indexedUsageRows - inventory.zeroComponentUsageRows
      || value.ledger.quota.events !== inventory.quota.admitted) reject();
  return value;
}

export function validatePr94AnalysisResult(value) {
  try { return validateAnalysisLocal(value); }
  catch { throw publicError("analysis"); }
}

function validateSource(value) {
  exact(value, ["revision", "dependencies"]);
  revision(value.revision);
  exact(value.dependencies, ["sourceSha256", "runtimeSha256", "lockSha256", "identitySha256"]);
  for (const digest of Object.values(value.dependencies)) hash(digest);
  return value;
}

function validateSources(value) {
  exact(value, ["before", "after", "final"]);
  for (const side of ["before", "after", "final"]) validateSource(value[side]);
  if (value.before.revision !== PR94_COMPARISON_REVISIONS.before
      || value.after.revision !== PR94_COMPARISON_REVISIONS.after) reject();
  if (value.before.dependencies.runtimeSha256 !== value.after.dependencies.runtimeSha256
      || value.before.dependencies.runtimeSha256 !== value.final.dependencies.runtimeSha256
      || value.before.dependencies.lockSha256 !== value.after.dependencies.lockSha256) reject();
  // Only before/after isolate PR94. The separately identified final lane also
  // includes subsequent reviewed dependency updates; bind those to its own
  // production probes instead of pretending it is the historical PR94 tree.
  return value;
}

function validateIndex(value) {
  exact(value, ["sha256", "bytes"]);
  hash(value.sha256);
  integer(value.bytes, 1, MAX_INDEX_BYTES);
  return value;
}

function validateWindow(value) {
  exact(value, ["startAt", "endAt"]);
  instant(value.startAt); instant(value.endAt);
  if (value.startAt >= value.endAt) reject();
  return value;
}

function validateLedgerComparisonShape(value) {
  exact(value, ["schemaVersion", "status", "aggregateEqual", "rows"]);
  if (value.schemaVersion !== LEDGER_COMPARISON_SCHEMA) reject();
  member(value.status, ["equal", "different"]);
  boolean(value.aggregateEqual);
  exact(value.rows, ["usage", "quota"]);
  for (const kind of ["usage", "quota"]) {
    const row = value.rows[kind];
    exact(row, ["before", "after", "unchanged", "changed", "missing", "added"]);
    for (const key of ["before", "after", "unchanged", "changed", "missing", "added"]) {
      integer(row[key], 0, MAX_LEDGER_ROWS);
    }
    if (row.unchanged + row.changed + row.missing !== row.before
        || row.unchanged + row.changed + row.added !== row.after) reject();
  }
  const unchanged = ["usage", "quota"].every((kind) => {
    const row = value.rows[kind];
    return row.changed === 0 && row.missing === 0 && row.added === 0;
  });
  if (value.status === "equal" && (!value.aggregateEqual || !unchanged)) reject();
  return value;
}

function primaryFitCount(calibration) {
  return calibration.candidates.reduce((total, candidate) => total + candidate.primary.count, 0);
}

function validateCalibrationComparison(value, before = null, after = null) {
  exact(value, ["schemaVersion", "status", ...CALIBRATION_COMPARISON_COUNTS,
    "selectedPopulationMatches", "duplicatePrimaryVotes", "requiresCoverageReview", "primaryOutcomeMatrix"]);
  if (value.schemaVersion !== CALIBRATION_COMPARISON_SCHEMA) reject();
  member(value.status, ["pass", "fail"]);
  for (const key of CALIBRATION_COMPARISON_COUNTS) integer(value[key], 0, MAX_CALIBRATION_ITEMS);
  if (value.beforeParentCandidates % 4 !== 0 || value.afterParentCandidates % 4 !== 0
      || value.missingParentCandidates % 4 !== 0 || value.addedParentCandidates % 4 !== 0
      || value.reconciledParentCandidates % 4 !== 0) reject();
  boolean(value.selectedPopulationMatches);
  boolean(value.requiresCoverageReview);
  if (value.missingParentCandidates + value.reconciledParentCandidates !== value.beforeParentCandidates
      || value.addedParentCandidates + value.reconciledParentCandidates !== value.afterParentCandidates
      || value.changedIdenticalInputFits + value.rejectedIdenticalInputFits > value.identicalFitInputsCompared
      || value.changedIdenticalInputFits > value.identicalFitInputsCompared
      || value.changedInputPrimaryLosses > value.lostPrimaryFits
      || value.unexplainedPrimaryLosses > value.lostPrimaryFits
      || value.lostPrimaryFits + value.retainedPrimaryFits !== value.baselinePrimaryFits
      || value.changedRawParentInventory > value.reconciledParentCandidates
      || value.changedOutcomeParentCandidates > value.reconciledParentCandidates
      || value.retainedPrimaryInputChanges > value.reconciledParentCandidates) reject();

  list(value.primaryOutcomeMatrix, MAX_CALIBRATION_ITEMS);
  const matrixTotals = { parentCandidates: 0, baselinePrimaryFits: 0, afterPrimaryFits: 0,
    retainedPrimaryFits: 0, lostPrimaryFits: 0, newPrimaryFits: 0, changedInputPrimaryLosses: 0 };
  const seen = new Set();
  let previousKey = null;
  for (const cell of value.primaryOutcomeMatrix) {
    exact(cell, ["candidateId", "planType", "accountKnown", "transition", "afterOutcomes",
      "parentCandidates", "baselinePrimaryFits", "afterPrimaryFits", "retainedPrimaryFits",
      "lostPrimaryFits", "newPrimaryFits", "changedInputPrimaryLosses"]);
    member(cell.candidateId, CANDIDATES);
    member(cell.planType, [...PLANS]);
    boolean(cell.accountKnown);
    member(cell.transition, PRIMARY_TRANSITIONS);
    for (const key of ["parentCandidates", "baselinePrimaryFits", "afterPrimaryFits", "retainedPrimaryFits",
      "lostPrimaryFits", "newPrimaryFits", "changedInputPrimaryLosses"]) {
      integer(cell[key], 0, MAX_CALIBRATION_ITEMS);
      matrixTotals[key] += cell[key];
    }
    if (cell.parentCandidates < 1 || cell.lostPrimaryFits + cell.retainedPrimaryFits !== cell.baselinePrimaryFits
        || cell.retainedPrimaryFits + cell.newPrimaryFits !== cell.afterPrimaryFits
        || cell.changedInputPrimaryLosses > cell.lostPrimaryFits) reject();
    list(cell.afterOutcomes, OUTCOMES.length + 1);
    let outcomeTotal = 0;
    let previousOutcome = null;
    for (const outcome of cell.afterOutcomes) {
      exact(outcome, ["outcome", "count"]);
      member(outcome.outcome, [...OUTCOMES, "missing_parent"]);
      integer(outcome.count, 1, MAX_CALIBRATION_ITEMS);
      if (previousOutcome !== null && outcome.outcome <= previousOutcome) reject();
      previousOutcome = outcome.outcome;
      outcomeTotal += outcome.count;
    }
    if (cell.afterOutcomes.length === 0
        || (cell.transition === "missing_parent"
          ? !(cell.afterOutcomes.length === 1 && cell.afterOutcomes[0].outcome === "missing_parent"
            && cell.afterOutcomes[0].count === 1)
          : cell.afterOutcomes.some((outcome) => outcome.outcome === "missing_parent"))) reject();
    if (cell.transition === "retained_primary" && (cell.baselinePrimaryFits === 0 || cell.afterPrimaryFits === 0)) reject();
    if (cell.transition === "lost_primary" && (cell.baselinePrimaryFits === 0 || cell.afterPrimaryFits !== 0)) reject();
    if (cell.transition === "new_primary" && (cell.baselinePrimaryFits !== 0 || cell.afterPrimaryFits === 0)) reject();
    if (cell.transition === "no_primary" && (cell.baselinePrimaryFits !== 0 || cell.afterPrimaryFits !== 0)) reject();
    if (cell.transition === "missing_parent" && cell.afterPrimaryFits !== 0) reject();
    if (cell.transition !== "missing_parent" && outcomeTotal < cell.afterPrimaryFits) reject();
    const key = JSON.stringify([cell.candidateId, cell.planType, cell.accountKnown, cell.transition, cell.afterOutcomes]);
    if (seen.has(key) || (previousKey !== null && key <= previousKey)) reject();
    seen.add(key); previousKey = key;
  }
  if (matrixTotals.parentCandidates !== value.beforeParentCandidates + value.addedParentCandidates
      || matrixTotals.baselinePrimaryFits !== value.baselinePrimaryFits
      || matrixTotals.afterPrimaryFits !== value.retainedPrimaryFits + value.newPrimaryFits
      || matrixTotals.retainedPrimaryFits !== value.retainedPrimaryFits
      || matrixTotals.lostPrimaryFits !== value.lostPrimaryFits
      || matrixTotals.newPrimaryFits !== value.newPrimaryFits
      || matrixTotals.changedInputPrimaryLosses !== value.changedInputPrimaryLosses) reject();
  const expectedReview = value.lostPrimaryFits > 0 || value.newPrimaryFits > 0
    || value.retainedPrimaryInputChanges > 0 || value.changedOutcomeParentCandidates > 0;
  if (value.requiresCoverageReview !== expectedReview) reject();
  if (value.status === "pass"
      && (value.missingParentCandidates !== 0 || value.addedParentCandidates !== 0
        || value.changedIdenticalInputFits !== 0 || value.rejectedIdenticalInputFits !== 0
        || value.unexplainedPrimaryLosses !== 0 || value.changedRawParentInventory !== 0
        || value.unexplainedParents !== 0 || value.duplicatePrimaryVotes !== 0
        || !value.selectedPopulationMatches)) reject();
  if (before !== null && after !== null) {
    if (value.beforeParentCandidates !== before.calibration.counts.parentCandidates
        || value.afterParentCandidates !== after.calibration.counts.parentCandidates
        || value.unexplainedParents !== before.calibration.counts.unexplainedParents
          + after.calibration.counts.unexplainedParents
        || value.baselinePrimaryFits !== primaryFitCount(before.calibration)
        || value.retainedPrimaryFits + value.newPrimaryFits !== primaryFitCount(after.calibration)
        || value.selectedPopulationMatches !== (before.calibration.selectedPlanType === after.calibration.selectedPlanType)) reject();
  }
  return value;
}

function validateLedgerComparison(value, before = null, after = null) {
  validateLedgerComparisonShape(value);
  if (before !== null && after !== null) {
    for (const kind of ["usage", "quota"]) {
      if (value.rows[kind].before !== before.ledger[kind].events
          || value.rows[kind].after !== after.ledger[kind].events) reject();
    }
  }
  return value;
}

function validateComparison(value, evidence) {
  exact(value, ["attributionLedger", "finalLedger", "attributionCalibration", "finalCalibration",
    "readerEvidenceUnchanged"]);
  boolean(value.readerEvidenceUnchanged);
  if (!value.readerEvidenceUnchanged) reject();
  const ledgerComparisons = [
    [value.attributionLedger, evidence.before, evidence.after],
    [value.finalLedger, evidence.after, evidence.final],
  ];
  const calibrationComparisons = [
    [value.attributionCalibration, evidence.before, evidence.after],
    [value.finalCalibration, evidence.after, evidence.final],
  ];
  ledgerComparisons.forEach(([comparison, before, after]) => validateLedgerComparison(comparison, before, after));
  calibrationComparisons.forEach(([comparison, before, after]) => validateCalibrationComparison(comparison, before, after));
  if (ledgerComparisons.some(([comparison]) => comparison.status !== "equal" || !comparison.aggregateEqual)
      || calibrationComparisons.some(([comparison]) => comparison.status !== "pass")) reject();
  return value;
}

function validateMetrics(value) {
  exact(value, ["wallMs", "userCpuMs", "systemCpuMs", "peakRssBytes"]);
  integer(value.wallMs, 0, MAX_PHASE_MS);
  integer(value.userCpuMs, 0);
  integer(value.systemCpuMs, 0);
  integer(value.peakRssBytes, 1, MAX_RSS);
  return value;
}

function validateMeasurements(value) {
  exact(value, ["before", "after", "final"]);
  for (const side of ["before", "after", "final"]) validateMetrics(value[side]);
  return value;
}

function validateEvidence(value) {
  exact(value, ["before", "after", "final"]);
  for (const side of ["before", "after", "final"]) {
    validateAnalysisLocal(value[side]);
    if (value[side].revisionKind !== side || value[side].calibration.status !== "pass"
        || value[side].populationEvidence.unknownAccountOnlyWithheldEvents !== 0) reject();
  }
  for (const key of ["inventory", "coverage", "generation"]) {
    if (!same(value.before[key], value.after[key]) || !same(value.before[key], value.final[key])) reject();
  }
  if (!same(value.before.ledger, value.after.ledger) || !same(value.after.ledger, value.final.ledger)) reject();
  return value;
}

function validateProductionResources(value, receipt, evidence) {
  exact(value, ["before", "after", "final"]);
  for (const side of ["before", "after", "final"]) {
    const resource = value[side];
    try {
      // Only the original merge may record its known unshippable artifact.
      // Baseline and final candidate still require the strict success shape.
      if (side === "after") validatePr94ProductionResourceOutcome(resource);
      else validatePr94ProductionResourceEvidence(resource);
    } catch { reject(); }
    if (resource.revision !== receipt.sources[side].revision
        || !same(resource.dependencies, receipt.sources[side].dependencies)
        || !same(resource.index, receipt.index)
        || resource.clock.startAt !== receipt.window.startAt
        || resource.clock.endAt !== receipt.window.endAt) reject();
    const generation = evidence[side].generation;
    if (resource.generation.id !== generation.id
        || resource.generation.publicationStatus !== generation.publicationStatus
        || resource.generation.toolProvenanceComplete !== generation.toolProvenanceComplete
        || resource.generation.usageEvents !== generation.usageEvents
        || resource.generation.quotaOccurrences !== generation.quotaOccurrences) reject();
  }
  const historicalRefusal = value.after.status === "historical_artifact_refused";
  if (receipt.status !== (historicalRefusal
    ? "passed_with_historical_artifact_refusal" : "passed")) reject();
  return value;
}

function validateReceiptLocal(value) {
  exact(value, RECEIPT_KEYS);
  if (value.schema !== RECEIPT_SCHEMA
      || !["passed", "passed_with_historical_artifact_refusal"].includes(value.status)
      || value.scope !== "fixed_admitted_index_analysis_not_raw_ingestion_or_hosted_activation") reject();
  validateSources(value.sources);
  validateIndex(value.index);
  validateWindow(value.window);
  validateMeasurements(value.measurements);
  validateEvidence(value.evidence);
  validateComparison(value.comparison, value.evidence);
  validateProductionResources(value.productionResources, value, value.evidence);
  return value;
}

export function validatePr94ComparisonReceipt(value) {
  try { return validateReceiptLocal(value); }
  catch { throw publicError("comparison"); }
}
