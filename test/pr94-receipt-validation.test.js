import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createPr94LedgerEvidence } from "../scripts/lib/pr94-ledger-evidence.mjs";
import { buildPr94CalibrationEvidence, comparePr94CalibrationEvidence } from "../scripts/lib/pr94-calibration-evidence.mjs";
import { validatePr94AnalysisResult, validatePr94ComparisonReceipt } from "../scripts/lib/pr94-receipt-validation.mjs";

const HASH = (character) => character.repeat(64);
const REVISION = (character) => character.repeat(40);
const INSTANT_START = "2025-09-01T00:00:00.000Z";
const INSTANT_END = "2026-09-01T00:00:00.000Z";
const BEFORE_REVISION = "a3c850360bc83c0e27bef2171aeb4a302b72f472";
const AFTER_REVISION = "20f449ff5c222989029fe343f219f02b497ae1d4";
const clone = (value) => structuredClone(value);

function emptyLedger() {
  return createPr94LedgerEvidence({ hmacKey: Buffer.alloc(32, 19) }).finish();
}

const OUTCOMES = [
  "selected_plan_primary", "alternate_plan_primary", "unselected_plan_primary", "losing_qualifying_fragment",
  "simultaneous_slot_conflict", "near_duplicate_reset_identity_with_less_evidence", "overlapping_observation_window",
  "aggregation_diagnostic_only", "insufficient_unique_boundaries", "insufficient_percent_span",
  "training_capacity_unavailable", "insufficient_training_pairs", "full_capacity_unavailable",
  "relative_width_unavailable", "relative_width_exceeded", "insufficient_snapshots", "no_percent_change",
  "no_within_era_percent_change",
  "all_snapshot_attribution_withheld", "unexplained_no_transition",
];
const CANDIDATES = ["standard_api", "speed_lower", "speed_midpoint", "speed_upper"];
const ROW_REASONS = ["eligible", "aggregation_diagnostic_only", "non_increasing_percent", "no_usage",
  "partial_elapsed_coverage", "pricing_warning", "attribution_warning"];

const calibrationSourceUrl = new URL("../src/reporting/weekly-calibration.js?pr94-receipt-validation", import.meta.url).href;
const calibrationHook = registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (url !== calibrationSourceUrl) return loaded;
  return { ...loaded, source: `${loaded.source}\nexport { selectResetGroups, fitReset, uniquePoints, capacityFit, fitRelativeCentral80Width, isEligible, partitionKey, resetParentKey };\n` };
} });
let calibrationOriginal;
try { calibrationOriginal = await import(calibrationSourceUrl); } finally { calibrationHook.deregister(); }

const CALIBRATION_HMAC_KEY = new Uint8Array(32).fill(13);
const CALIBRATION_RESET = Date.parse("2026-08-31T00:00:00.000Z") / 1_000;
const CALIBRATION_SCOPE = { startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z" };

function calibrationRows({ planType = "pro", count = 12, offset = 0, costStep = 10 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const time = Date.parse("2026-08-25T00:00:00.000Z") + (index + offset) * 3_600_000;
    return {
      accountScopeId: "unattributed", provider: "openai_codex", planType, planVariant: "unknown", planEraKey: "era-one",
      aggregationEligibility: "primary_conditional", limitId: "codex", slot: "primary", windowDurationMins: 10_080,
      resetsAt: CALIBRATION_RESET, eventTime: new Date(time + 3_600_000).toISOString(),
      lastPriorObservedAt: new Date(time).toISOString(), firstNextObservedAt: new Date(time + 3_600_000).toISOString(),
      priorUsedPercent: index, nextUsedPercent: index + 1,
      lastPriorCumulativeApiPricedUsd: index * costStep, firstNextCumulativeApiPricedUsd: (index + 1) * costStep,
      lastPriorCumulativeQuotaWeightedLowerUsd: index * costStep,
      firstNextCumulativeQuotaWeightedLowerUsd: (index + 1) * costStep,
      lastPriorCumulativeQuotaWeightedUpperUsd: index * costStep * 2,
      firstNextCumulativeQuotaWeightedUpperUsd: (index + 1) * costStep * 2,
      marginalUsageEventCount: 1,
      quality: { localCoverage: { elapsedTimeCoverageFraction: 1 }, pricingWarnings: [], attributionWarnings: [] },
    };
  });
}

function calibrationRawParent(first) {
  return { accountScopeId: first.accountScopeId, provider: first.provider, planType: first.planType,
    limitId: first.limitId, windowDurationMins: first.windowDurationMins, resetsAt: first.resetsAt,
    snapshotCount: 13, uniqueSnapshotCount: 13, distinctPercentCount: 13, matchedSnapshotCount: 13,
    conflictedSnapshotCount: 0, unavailableSnapshotCount: 0, matchedUniqueSnapshotCount: 13,
    matchedDistinctPercentCount: 13 };
}

function populatedCalibration(revisionKind, options = {}) {
  const transitions = calibrationRows(options);
  return buildPr94CalibrationEvidence({ internals: calibrationOriginal,
    analyzeWeeklyCalibration: calibrationOriginal.analyzeWeeklyCalibration,
    candidates: calibrationOriginal.CANDIDATES, transitions,
    rawParents: [calibrationRawParent(transitions[0])], revisionKind,
    hmacKey: CALIBRATION_HMAC_KEY, scope: CALIBRATION_SCOPE, selectedPlanType: options.planType ?? "pro" });
}

function noWithinEraCalibration(revisionKind) {
  const first = calibrationRows()[0];
  return buildPr94CalibrationEvidence({ internals: calibrationOriginal,
    analyzeWeeklyCalibration: calibrationOriginal.analyzeWeeklyCalibration,
    candidates: calibrationOriginal.CANDIDATES, transitions: [], rawParents: [{ ...calibrationRawParent(first),
      matchedDistinctPercentCount: 2,
      derivationEvidence: { groupCount: 2, snapshotCount: 13, transitionCount: 0, zeroTransitionGroupCount: 2 } }],
    revisionKind, hmacKey: CALIBRATION_HMAC_KEY, scope: CALIBRATION_SCOPE, selectedPlanType: "pro" });
}

function distribution() { return { count: 0, median: null, central80: { lower: null, upper: null } }; }
function calibrationCandidate(candidateId, parentCandidates = 0) {
  return { candidateId, parentCandidates,
    outcomes: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])),
    primary: distribution(), diagnostic: distribution(), spans: distribution(), boundaries: distribution() };
}
function calibration(revisionKind) {
  return { schemaVersion: "pr94-calibration-evidence-v2", revisionKind, selectedPlanType: "unknown", status: "pass",
    counts: { rawParents: 0, parentCandidates: 0, transitionRows: 0, parentsWithTransitions: 0,
      knownAccountParents: 0, unknownAccountParents: 0, unexplainedParents: 0 },
    rowReasons: Object.fromEntries(ROW_REASONS.map((reason) => [reason, 0])),
    unknownAccountCheck: { scope: "original_fit_gate_only", fragmentCandidatesChecked: 0, rowsChecked: 0,
      changedEligibilityRows: 0, changedPointSets: 0, changedFits: 0, unknownOnlyFitExclusions: 0 },
    candidates: CANDIDATES.map((candidateId) => calibrationCandidate(candidateId)), plans: [] };
}
function generation() {
  return { id: 1, fingerprintSha256: HASH("a"), publicationStatus: "complete", publicationBlockReason: null,
    toolProvenanceComplete: true, indexedSourceCount: 0, indexedSourceBytes: 0, skippedSourceCount: 0,
    skippedSourceBytes: 0, skippedThreadCount: 0, usageEvents: 0, quotaOccurrences: 0, toolFacts: 0 };
}
function population(revisionKind) {
  return { schema: "pr94-population-evidence-v1", context: "openai_codex|codex", revisionKind,
    totals: { events: 0, totalUsd: "0", components: Object.fromEntries([
      "input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens",
      "output_text_tokens", "output_reasoning_tokens", "output_combined_tokens",
    ].map((name) => [name, { quantity: "0", observedEvents: 0, missingEvents: 0, unavailableEvents: 0 }])) },
    populations: [], unknownAccountOnlyWithheldEvents: 0 };
}
function analysis(revisionKind) {
  return { schema: "pr94-analysis-worker-v1", revisionKind, contextBehavior: "legacy_zero", generation: generation(),
    attributionIndex: revisionKind === "before" ? null : { observationCount: 0, ignoredObservationCount: 0, eras: 0, conflicts: 0, contexts: 0 },
    instrumentation: { sourceSha256: HASH("b"), instrumentationSha256: HASH("c"), transformation: "append_exports_only" },
    inventory: { indexedUsageRows: 0, zeroComponentUsageRows: 0,
      quota: { admitted: 0, held: 0, suppressed: 0 }, generationUsageRows: 0, generationQuotaRows: 0 },
    coverage: { accountingStatus: "complete", diagnosticsSha256: HASH("d"), compatibilitySha256: HASH("e") },
    ledger: emptyLedger(), calibration: calibration(revisionKind), populationEvidence: population(revisionKind),
    batchMetrics: { batches: 0, maximumUsageSlice: 0, maximumQuotaSlice: 0 }, deduplicatedWeeklySnapshots: 0,
    phaseMs: { readAndLedger: 0, attributionAndDerivation: 0, calibrationAndReconciliation: 0 },
    privateArtifactBytes: { ledger: 1, calibration: 1 } };
}
function source(revisionCharacter) {
  const revisionValue = revisionCharacter.length === 1 ? REVISION(revisionCharacter) : revisionCharacter;
  return { revision: revisionValue, dependencies: { sourceSha256: HASH("f"), runtimeSha256: HASH("0"),
    lockSha256: HASH("1"), identitySha256: HASH("2") } };
}
function queryPlans(revision) {
  if (revision === BEFORE_REVISION) {
    return { schema: "pr94-attribution-query-plans-v1", scope: "attribution_point_queries_explain_only",
      binding: "synthetic", status: "feature_absent", statements: null };
  }
  const statements = Object.fromEntries(["membership", "same_record_plans", "source_predecessor", "session_predecessor"]
    .map((role) => [role, { steps: 1, search: 1, scan: 0, tempSort: 0, other: 0 }]));
  return { schema: "pr94-attribution-query-plans-v1", scope: "attribution_point_queries_explain_only",
    binding: "synthetic", status: "observed", statements };
}
function resource(side, receipt, evidence) {
  const generationEvidence = evidence[side].generation;
  return { schema: "pr94-production-resource-v2", scope: "isolated_child_repeatability", revision: receipt.sources[side].revision,
    dependencies: receipt.sources[side].dependencies,
    clock: { startAt: INSTANT_START, endAt: INSTANT_END, nowMs: Date.parse(INSTANT_END), windowDays: 365 },
    index: receipt.index, generation: { id: generationEvidence.id, publicationStatus: generationEvidence.publicationStatus,
      toolProvenanceComplete: generationEvidence.toolProvenanceComplete, usageEvents: generationEvidence.usageEvents,
      quotaOccurrences: generationEvidence.quotaOccurrences },
    policy: { maximumRssBytes: 6_442_450_944, rssDeltaBudgetBytes: 1, rebuildChildOldSpaceMib: 6144,
      archiveMaximumRssBytes: 1, archiveRssDeltaBudgetBytes: 1 },
    limits: { envelopeBytes: 64 * 1024, transportBytes: 64 * 1024 * 1024, durableCacheBytes: 16 * 1024 * 1024 },
    runs: ["primary", "fresh_process_repeat"].map((kind) => ({ kind,
      metrics: { wallMs: 0, userCpuMs: 0, systemCpuMs: 0, peakRssBytes: 1 },
      envelope: { status: "ok", resultBytes: 2, resultSha256: HASH("4") }, artifact: { sha256: HASH("4"), bytes: 2 },
      cache: { schemaVersion: "local-replay-safe-accounting-v0.15",
        source: { mode: "unified", contextBehavior: "legacy_zero", accountingCoverage: "complete", generationMatched: true, readsRawSources: false },
        weeklyInput: { status: "complete", encoding: "accounting_compact_v3", source: "unified_index",
          retainedUsageEvents: 0, retainedWeeklySnapshots: 0, estimatedRetainedBytes: 0,
          limits: { usageEvents: 1, weeklySnapshots: 1, combinedInputs: 1, retainedBytes: 1 } },
        rows: { periods: 0, timeline: 0, sparkUsageTimeline: 0, quotaTimeline: 0, sparkQuotaTimeline: 0 } } })),
    queryPlans: queryPlans(receipt.sources[side].revision),
    exactRepeatOutput: true, indexUnchanged: true, sourceUnchanged: true, dependenciesUnchanged: true,
    notMeasured: ["app_no_change_cache_hit", "app_relaunch", "end_to_end_refresh", "cancellation", "evidence_observer_overhead"] };
}
function receipt() {
  const evidence = { before: analysis("before"), after: analysis("after"), final: analysis("final") };
  const value = { schema: "pr94-admitted-index-comparison-v2", status: "passed",
    scope: "fixed_admitted_index_analysis_not_raw_ingestion_or_hosted_activation",
    sources: { before: source(BEFORE_REVISION), after: source(AFTER_REVISION), final: source("c") }, index: { sha256: HASH("6"), bytes: 1 },
    window: { startAt: INSTANT_START, endAt: INSTANT_END },
    comparison: { attributionLedger: ledgerComparison(), finalLedger: ledgerComparison(),
      attributionCalibration: calibrationComparison(), finalCalibration: calibrationComparison(), readerEvidenceUnchanged: true },
    measurements: Object.fromEntries(["before", "after", "final"].map((side) => [side,
      { wallMs: 0, userCpuMs: 0, systemCpuMs: 0, peakRssBytes: 1 }])), productionResources: {}, evidence };
  for (const side of ["before", "after", "final"]) value.productionResources[side] = resource(side, value, evidence);
  return value;
}
function ledgerComparison() {
  const row = { before: 0, after: 0, unchanged: 0, changed: 0, missing: 0, added: 0 };
  return { schemaVersion: "pr94-ledger-comparison-v1", status: "equal", aggregateEqual: true,
    rows: { usage: { ...row }, quota: { ...row } } };
}
function calibrationComparison() {
  return { schemaVersion: "pr94-calibration-comparison-v2", status: "pass", beforeParentCandidates: 0,
    afterParentCandidates: 0, missingParentCandidates: 0, addedParentCandidates: 0, reconciledParentCandidates: 0,
    identicalFitInputsCompared: 0, changedIdenticalInputFits: 0, unexplainedParents: 0, changedRawParentInventory: 0,
    selectedPopulationMatches: true, duplicatePrimaryVotes: 0, baselinePrimaryFits: 0, retainedPrimaryFits: 0,
    lostPrimaryFits: 0, newPrimaryFits: 0, changedInputPrimaryLosses: 0, rejectedIdenticalInputFits: 0,
    unexplainedPrimaryLosses: 0, retainedPrimaryInputChanges: 0, changedOutcomeParentCandidates: 0,
    requiresCoverageReview: false, primaryOutcomeMatrix: [] };
}
function rejects(value, expectedCode = "pr94_receipt_analysis_invalid") {
  assert.throws(() => validatePr94AnalysisResult(value), { code: expectedCode });
}

test("PR94 receipt validators accept content-free synthetic analysis and comparison projections", () => {
  const result = receipt();
  assert.equal(validatePr94AnalysisResult(result.evidence.before), result.evidence.before);
  assert.equal(validatePr94ComparisonReceipt(result), result);
});

test("comparison validator accepts actual populated calibration v2 matrices in canonical order", () => {
  const beforeCalibration = populatedCalibration("before");
  const afterCalibration = populatedCalibration("after");
  const finalCalibration = populatedCalibration("final");
  const result = receipt();
  result.evidence.before.calibration = beforeCalibration;
  result.evidence.after.calibration = afterCalibration;
  result.evidence.final.calibration = finalCalibration;
  result.comparison.attributionCalibration = comparePr94CalibrationEvidence(beforeCalibration, afterCalibration);
  result.comparison.finalCalibration = comparePr94CalibrationEvidence(afterCalibration, finalCalibration);
  assert.equal(validatePr94ComparisonReceipt(result), result);
  for (const comparison of [result.comparison.attributionCalibration, result.comparison.finalCalibration]) {
    const keys = comparison.primaryOutcomeMatrix.map((cell) => JSON.stringify([
      cell.candidateId, cell.planType, cell.accountKnown, cell.transition, cell.afterOutcomes]));
    assert.deepEqual(keys, [...keys].sort());
  }
  const wrongParentCounts = clone(result);
  wrongParentCounts.comparison.attributionCalibration.beforeParentCandidates = 8;
  wrongParentCounts.comparison.attributionCalibration.afterParentCandidates = 8;
  wrongParentCounts.comparison.attributionCalibration.reconciledParentCandidates = 8;
  wrongParentCounts.comparison.attributionCalibration.primaryOutcomeMatrix.forEach((cell) => { cell.parentCandidates = 2; });
  assert.throws(() => validatePr94ComparisonReceipt(wrongParentCounts), { code: "pr94_receipt_comparison_invalid" });
  const wrongPrimaryCounts = clone(result);
  wrongPrimaryCounts.comparison.attributionCalibration.baselinePrimaryFits = 8;
  wrongPrimaryCounts.comparison.attributionCalibration.retainedPrimaryFits = 8;
  wrongPrimaryCounts.comparison.attributionCalibration.primaryOutcomeMatrix.forEach((cell) => {
    cell.baselinePrimaryFits = 2; cell.afterPrimaryFits = 2; cell.retainedPrimaryFits = 2;
    cell.afterOutcomes[0].count = 2;
  });
  assert.throws(() => validatePr94ComparisonReceipt(wrongPrimaryCounts), { code: "pr94_receipt_comparison_invalid" });
  const reversed = clone(result);
  reversed.comparison.attributionCalibration.primaryOutcomeMatrix.reverse();
  assert.throws(() => validatePr94ComparisonReceipt(reversed), { code: "pr94_receipt_comparison_invalid" });
});

test("receipt validator accepts the original miner's within-era no-change outcome", () => {
  const beforeCalibration = noWithinEraCalibration("before");
  const afterCalibration = noWithinEraCalibration("after");
  const finalCalibration = noWithinEraCalibration("final");
  for (const value of [beforeCalibration, afterCalibration, finalCalibration]) {
    assert.equal(value.candidates[0].outcomes.no_within_era_percent_change, 1);
  }
  const result = receipt();
  result.evidence.before.calibration = beforeCalibration;
  result.evidence.after.calibration = afterCalibration;
  result.evidence.final.calibration = finalCalibration;
  result.comparison.attributionCalibration = comparePr94CalibrationEvidence(beforeCalibration, afterCalibration);
  result.comparison.finalCalibration = comparePr94CalibrationEvidence(afterCalibration, finalCalibration);
  assert.equal(validatePr94ComparisonReceipt(result), result);
  assert.ok(result.comparison.attributionCalibration.primaryOutcomeMatrix.every((cell) =>
    cell.afterOutcomes.length === 1
      && cell.afterOutcomes[0].outcome === "no_within_era_percent_change"));

  const unknownOutcome = clone(result);
  unknownOutcome.evidence.after.calibration.candidates[0].outcomes.no_within_era_percent_change_extra = 1;
  assert.throws(() => validatePr94ComparisonReceipt(unknownOutcome), { code: "pr94_receipt_comparison_invalid" });
  const misplacedOutcome = clone(result);
  misplacedOutcome.evidence.after.calibration.rowReasons.no_within_era_percent_change = 1;
  assert.throws(() => validatePr94ComparisonReceipt(misplacedOutcome), { code: "pr94_receipt_comparison_invalid" });
});

test("analysis validator is closed and rejects raw/private channels, hashes, counts and timings", () => {
  for (const mutate of [
    (value) => { value.privatePath = "/private/synthetic"; },
    (value) => { value.generation.extra = "synthetic-private"; },
    (value) => { value.instrumentation.sourceSha256 = "not-a-hash"; },
    (value) => { value.inventory.indexedUsageRows = -1; },
    (value) => { value.phaseMs.readAndLedger = Infinity; },
    (value) => { value.privateArtifactBytes.calibration = 0; },
    (value) => { value.attributionIndex = { observationCount: 0, ignoredObservationCount: 1, eras: 0, conflicts: 0, contexts: 0 }; },
    (value) => { value.calibration.rowReasons.extra = 0; },
    (value) => { value.calibration.unknownAccountCheck.changedFits = 1; },
    (value) => { value.calibration.unknownAccountCheck.extra = 0; },
  ]) {
    const value = clone(analysis("before")); mutate(value); rejects(value);
  }
  const unknownPlan = analysis("after");
  unknownPlan.attributionIndex.ignoredObservationCount = 2;
  unknownPlan.attributionIndex.observationCount = 2;
  assert.equal(validatePr94AnalysisResult(unknownPlan), unknownPlan);
});

test("analysis validator delegates closed ledger and calibration aggregate validation", () => {
  const ledger = clone(analysis("before"));
  ledger.ledger.usage.events = 1;
  rejects(ledger);
  const calibrationValue = analysis("before");
  calibrationValue.calibration.candidates[0].outcomes.private_outcome = 1;
  rejects(calibrationValue);
  const statusMismatch = analysis("before");
  statusMismatch.calibration.counts.unexplainedParents = 1;
  statusMismatch.calibration.status = "fail";
  rejects(statusMismatch);
});

test("comparison validator binds evidence revisions, unchanged reader evidence and production resources", () => {
  const good = receipt();
  assert.equal(validatePr94ComparisonReceipt(good), good);
  assert.equal(good.productionResources.before.queryPlans.status, "feature_absent");
  assert.equal(good.productionResources.before.queryPlans.statements, null);
  for (const side of ["after", "final"]) {
    assert.equal(good.productionResources[side].queryPlans.status, "observed");
    assert.deepEqual(Object.keys(good.productionResources[side].queryPlans.statements), [
      "membership", "same_record_plans", "source_predecessor", "session_predecessor"]);
  }
  for (const mutate of [
    (value) => { value.harness = { revision: REVISION("d") }; },
    (value) => { value.sources.before.revision = "short"; },
    (value) => { value.index.bytes = 0; },
    (value) => { value.window.endAt = "2026-09-01T00:00:00.001Z"; },
    (value) => { value.comparison.readerEvidenceUnchanged = false; },
    (value) => { value.comparison.attributionLedger.rows.usage.before = 1;
      value.comparison.attributionLedger.rows.usage.after = 1;
      value.comparison.attributionLedger.rows.usage.unchanged = 1; },
    (value) => { value.evidence.after.generation.usageEvents = 1; },
    (value) => { value.sources.final.dependencies = {
      ...value.sources.final.dependencies, runtimeSha256: HASH("3"),
    }; },
    (value) => { value.evidence.final.populationEvidence.unknownAccountOnlyWithheldEvents = 1; },
    (value) => { value.productionResources.final.runs[0].metrics.peakRssBytes = 6_442_450_945; },
    (value) => { value.productionResources.before.queryPlans.status = "observed";
      value.productionResources.before.queryPlans.statements = queryPlans(AFTER_REVISION).statements; },
    (value) => { value.productionResources.after.queryPlans.status = "feature_absent";
      value.productionResources.after.queryPlans.statements = null; },
    (value) => { value.productionResources.after.queryPlans.statements.membership.steps = 2; },
    (value) => { value.productionResources.after.queryPlans.statements.membership.rawSql = "SELECT synthetic"; },
    (value) => { value.productionResources.final.queryPlans.statements.session_predecessor.search = -1; },
    (value) => { value.measurements.before.wallMs = -1; },
  ]) {
    const value = clone(good); mutate(value);
    assert.throws(() => validatePr94ComparisonReceipt(value), { code: "pr94_receipt_comparison_invalid" });
  }
});

test("only the PR94 isolation pair requires identical locks; final dependencies remain independently bound", () => {
  const value = receipt();
  value.sources.final.dependencies.lockSha256 = HASH("7");
  value.sources.final.dependencies.runtimeSha256 = HASH("8");
  // The fixture intentionally shares the source/probe dependency object.
  assert.equal(validatePr94ComparisonReceipt(value), value);
  const drift = clone(value);
  drift.productionResources.final.dependencies = {
    ...drift.productionResources.final.dependencies, runtimeSha256: HASH("9"),
  };
  assert.throws(() => validatePr94ComparisonReceipt(drift), { code: "pr94_receipt_comparison_invalid" });
  const mixedPair = clone(value);
  mixedPair.sources.after.dependencies.lockSha256 = HASH("7");
  mixedPair.productionResources.after.dependencies.lockSha256 = HASH("7");
  assert.throws(() => validatePr94ComparisonReceipt(mixedPair), { code: "pr94_receipt_comparison_invalid" });
});

test("historical artifact refusal requires an explicit v2 result and never substitutes for final validation", () => {
  const value = receipt();
  value.status = "passed_with_historical_artifact_refusal";
  const historical = value.productionResources.after;
  historical.status = "historical_artifact_refused";
  historical.runs = historical.runs.map(({ cache, ...run }) => ({
    ...run, cacheAssertion: { status: "refused", code: "cache_invalid" },
  }));
  assert.equal(validatePr94ComparisonReceipt(value), value);

  for (const mutate of [
    (changed) => { changed.status = "passed"; },
    (changed) => { changed.schema = "pr94-admitted-index-comparison-v1"; },
    (changed) => { changed.productionResources.after.schema = "pr94-production-resource-v1"; },
    (changed) => { changed.productionResources.after.runs[1].cacheAssertion.code = "other_failure"; },
    (changed) => { changed.productionResources.after.runs[1].artifact.sha256 = HASH("7"); },
    (changed) => { changed.productionResources.after.index = { ...changed.productionResources.after.index, sha256: HASH("7") }; },
    (changed) => { changed.productionResources.after.dependencies = {
      ...changed.productionResources.after.dependencies, identitySha256: HASH("7"),
    }; },
    (changed) => { changed.productionResources.final = clone(changed.productionResources.after); },
    (changed) => { changed.productionResources.before = clone(changed.productionResources.after); },
    (changed) => { changed.comparison.attributionLedger.status = "different"; },
    (changed) => { changed.comparison.attributionCalibration.status = "fail"; },
    (changed) => { changed.productionResources.final.runs[0].cache.source.accountingCoverage = "partial"; },
  ]) {
    const changed = clone(value); mutate(changed);
    assert.throws(() => validatePr94ComparisonReceipt(changed), { code: "pr94_receipt_comparison_invalid" });
  }
  const falseRefusal = receipt();
  falseRefusal.status = "passed_with_historical_artifact_refusal";
  assert.throws(() => validatePr94ComparisonReceipt(falseRefusal), { code: "pr94_receipt_comparison_invalid" });
});

test("closed validators reject accessor, symbol, prototype and raw content channels", () => {
  const value = analysis("before");
  Object.defineProperty(value, "private", { enumerable: true, get() { throw new Error("synthetic"); } });
  rejects(value);
  const symbol = analysis("before"); symbol[Symbol("private")] = "synthetic"; rejects(symbol);
  const prototype = Object.assign(Object.create({ private: "synthetic" }), analysis("before")); rejects(prototype);
  const receiptValue = receipt(); receiptValue.evidence.before.calibration.selectedPlanType = "private-plan";
  assert.throws(() => validatePr94ComparisonReceipt(receiptValue), { code: "pr94_receipt_comparison_invalid" });
});
