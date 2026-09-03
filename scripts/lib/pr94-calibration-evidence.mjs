import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// The runner authenticates the revision and its export-only loader. Pin the
// unchanged fit body as well: the explanatory branches below must never become
// a second, silently drifting calibration policy. All numerical fits are still
// evaluated by the original revision's helpers and public reporter.
const FIT_RESET_SHA256 = "c35467f3159d5c1d4188a8534b9dd8e4e93a2ca7316c7e1a81d9004dbf71c8b3";
const SCHEMA = "pr94-calibration-evidence-v2";
const LIMITS = Object.freeze({ parents: 10_000, transitions: 200_000, fragments: 40_000 });
const CANDIDATES = Object.freeze([
  ["standard_api", "standard"], ["speed_lower", "lower"],
  ["speed_midpoint", "midpoint"], ["speed_upper", "upper"],
]);
const PLANS = new Set(["free", "plus", "pro", "pro_lite", "team", "business", "enterprise", "edu", "unknown"]);
const SUPPRESSIONS = Object.freeze([
  "simultaneous_slot_conflict", "near_duplicate_reset_identity_with_less_evidence",
  "overlapping_observation_window",
]);
const OUTCOMES = Object.freeze([
  "selected_plan_primary", "alternate_plan_primary", "unselected_plan_primary",
  "losing_qualifying_fragment", ...SUPPRESSIONS,
  "aggregation_diagnostic_only", "insufficient_unique_boundaries", "insufficient_percent_span",
  "training_capacity_unavailable", "insufficient_training_pairs", "full_capacity_unavailable",
  "relative_width_unavailable", "relative_width_exceeded", "insufficient_snapshots",
  "no_percent_change", "all_snapshot_attribution_withheld", "unexplained_no_transition",
]);
const ROW_REASONS = Object.freeze([
  "eligible", "aggregation_diagnostic_only", "non_increasing_percent", "no_usage",
  "partial_elapsed_coverage", "pricing_warning", "attribution_warning",
]);
const ACCOUNT_CHECK_COUNTS = Object.freeze([
  "fragmentCandidatesChecked", "rowsChecked", "changedEligibilityRows", "changedPointSets",
  "changedFits", "unknownOnlyFitExclusions",
]);
const PRIVATE = new WeakMap();
const HEX = /^[a-f0-9]{64}$/u;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail("pr94_calibration_count_invalid");
  return value;
}

function text(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.length > 512) fail("pr94_calibration_identity_invalid");
  return value;
}

function keyBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 64) {
    fail("pr94_calibration_hmac_key_invalid");
  }
  return value;
}

function digest(key, domain, value) {
  return createHmac("sha256", key).update(domain).update("\0").update(JSON.stringify(value)).digest("hex");
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function recordKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("pr94_calibration_private_frames_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string"
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value"))) {
    fail("pr94_calibration_private_frames_invalid");
  }
  return Object.keys(value);
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Public receipt ordering is code-unit lexical, independent of host locale.
// JSON punctuation and prefix plans (pro/pro_lite) collate differently in ICU.
function compareReceiptKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function plan(value) {
  return PLANS.has(value) ? value : value === null || value === undefined ? "unknown" : "other";
}

function accountKnown(value) {
  return ![null, undefined, "unknown", "unattributed", "unavailable", ""].includes(value);
}

function parentIdentity(row) {
  if (!row || typeof row !== "object") fail("pr94_calibration_parent_invalid");
  return [text(row.accountScopeId, "unattributed"), text(row.provider), text(row.planType, "unknown"),
    text(row.limitId), count(row.windowDurationMins), count(row.resetsAt)];
}

function parentKey(row, key) { return digest(key, "parent", parentIdentity(row)); }
function groupKey(row, internals) {
  return `${internals.partitionKey(row, { includeSlot: false })}|${row.resetsAt}`;
}
function actualParentKey(row, internals, key) {
  return digest(key, "actual-parent", internals.resetParentKey
    ? internals.resetParentKey(row) : groupKey(row, internals));
}

function round(value) {
  return Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 1e6) / 1e6 : null;
}

// Receipt statistics only, not a replacement for any calibration calculation.
function distribution(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  const quantile = (p) => {
    if (ordered.length === 0) return null;
    const at = (ordered.length - 1) * p;
    const low = Math.floor(at);
    return round(low === Math.ceil(at) ? ordered[low]
      : ordered[low] * (1 - (at - low)) + ordered[Math.ceil(at)] * (at - low));
  };
  return { count: ordered.length, median: quantile(0.5), central80: { lower: quantile(0.1), upper: quantile(0.9) } };
}

function emptyCounts(names) { return Object.fromEntries(names.map((name) => [name, 0])); }

function eligibleReason(row, internals) {
  let reason = "eligible";
  if (row.aggregationEligibility === "diagnostic_only" && !internals.isEligible(row)) reason = "aggregation_diagnostic_only";
  else if (!(row.nextUsedPercent > row.priorUsedPercent)) reason = "non_increasing_percent";
  else if (!(row.marginalUsageEventCount > 0)) reason = "no_usage";
  else if (row.quality?.localCoverage?.elapsedTimeCoverageFraction !== 1) reason = "partial_elapsed_coverage";
  else if ((row.quality?.pricingWarnings?.length ?? 0) !== 0) reason = "pricing_warning";
  else if ((row.quality?.attributionWarnings?.length ?? 0) !== 0) reason = "attribution_warning";
  if ((reason === "eligible") !== internals.isEligible(row)) fail("pr94_calibration_eligibility_drift");
  return reason;
}

function fitDecision(rows, candidate, internals) {
  const fit = internals.fitReset(rows, candidate);
  const points = internals.uniquePoints(rows, candidate);
  let reason = null;
  if (points.length < 8) reason = rows.length > 0
      && rows.every((row) => row.aggregationEligibility === "diagnostic_only" && !internals.isEligible(row))
    ? "aggregation_diagnostic_only" : "insufficient_unique_boundaries";
  else if (points.at(-1).percent - points[0].percent < 5) reason = "insufficient_percent_span";
  else {
    const cutoff = points[0].percent + (points.at(-1).percent - points[0].percent) * 0.7;
    let train = points.filter((point) => point.percent <= cutoff);
    const holdout = points.filter((point) => point.percent > cutoff);
    if (train.length < 5 || holdout.length < 2) {
      const split = Math.max(5, Math.min(points.length - 2, Math.floor(points.length * 0.7)));
      train = points.slice(0, split);
    }
    const training = internals.capacityFit(train);
    if (!Number.isFinite(training.capacityUsd)) reason = "training_capacity_unavailable";
    else if (training.pairCount < 6) reason = "insufficient_training_pairs";
    else {
      const full = internals.capacityFit(points);
      if (!Number.isFinite(full.capacityUsd)) reason = "full_capacity_unavailable";
      else {
        const width = internals.fitRelativeCentral80Width(full);
        if (!Number.isFinite(width)) reason = "relative_width_unavailable";
        else if (width > 1) reason = "relative_width_exceeded";
      }
    }
  }
  if ((fit === null) !== (reason !== null)) fail("pr94_calibration_fit_gate_drift");
  return { fit, points, reason };
}

function checkUnknownAccountFit(rows, candidate, internals, actualFit, actualPoints) {
  const result = emptyCounts(ACCOUNT_CHECK_COUNTS);
  result.rowsChecked = rows.filter((row) => !accountKnown(row.accountScopeId)).length;
  if (result.rowsChecked === 0) return result;
  result.fragmentCandidatesChecked = 1;
  // A diagnostic counterfactual only: preserve every numeric/plan/eligibility
  // field, changing only unknown account identity within the existing group.
  // It proves direct fit-gate independence, NOT upstream quantity attribution
  // or that this synthetic scope is an observed real billing identity.
  const known = rows.map((row) => accountKnown(row.accountScopeId) ? row
    : { ...row, accountScopeId: "pr94-counterfactual-known-account" });
  result.changedEligibilityRows = rows.filter((row, index) => internals.isEligible(row)
    !== internals.isEligible(known[index])).length;
  const points = internals.uniquePoints(known, candidate);
  const fit = internals.fitReset(known, candidate);
  result.changedPointSets = Number(!equal(actualPoints, points));
  result.changedFits = Number(!equal(actualFit, fit));
  result.unknownOnlyFitExclusions = Number(actualFit === null && fit !== null);
  return result;
}

function noTransitionReason(raw) {
  const total = count(raw.snapshotCount);
  const unique = count(raw.uniqueSnapshotCount);
  const distinct = count(raw.distinctPercentCount);
  const matched = count(raw.matchedSnapshotCount);
  const conflicted = count(raw.conflictedSnapshotCount);
  const unavailable = count(raw.unavailableSnapshotCount);
  if (total === 0 || unique === 0 || unique > total || distinct === 0 || distinct > unique
      || matched + conflicted + unavailable !== total) {
    fail("pr94_calibration_snapshot_partition_invalid");
  }
  if (matched === 0 && total > 0) return "all_snapshot_attribution_withheld";
  const matchedUnique = raw.matchedUniqueSnapshotCount ?? (matched === total ? unique : null);
  const matchedDistinct = raw.matchedDistinctPercentCount ?? (matched === total ? distinct : null);
  if (matchedUnique !== null && (count(matchedUnique) > matched
      || (matchedDistinct !== null && count(matchedDistinct) > matchedUnique))) {
    fail("pr94_calibration_snapshot_partition_invalid");
  }
  if (matchedUnique !== null && matchedUnique < 2) return "insufficient_snapshots";
  if (matchedDistinct !== null && matchedDistinct < 2) return "no_percent_change";
  return "unexplained_no_transition";
}

function validateInputs(options) {
  const { internals, candidates, transitions, rawParents, revisionKind, analyzeWeeklyCalibration } = options;
  if (!["before", "after", "final"].includes(revisionKind)
      || typeof analyzeWeeklyCalibration !== "function"
      || !Array.isArray(transitions) || transitions.length > LIMITS.transitions
      || !Array.isArray(rawParents) || rawParents.length > LIMITS.parents
      || !Array.isArray(candidates) || candidates.length !== 4) fail("pr94_calibration_input_invalid");
  for (const name of ["selectResetGroups", "fitReset", "uniquePoints", "capacityFit", "fitRelativeCentral80Width", "isEligible", "partitionKey"]) {
    if (typeof internals?.[name] !== "function") fail("pr94_calibration_internal_missing");
  }
  if (createHash("sha256").update(Function.prototype.toString.call(internals.fitReset)).digest("hex") !== FIT_RESET_SHA256) {
    fail("pr94_calibration_fit_source_unrecognized");
  }
  for (const [at, [id, kind]] of CANDIDATES.entries()) {
    if (candidates[at]?.id !== id || candidates[at]?.kind !== kind) fail("pr94_calibration_candidates_invalid");
  }
  if (revisionKind !== "before" && typeof internals.resetParentKey !== "function") fail("pr94_calibration_internal_missing");
  for (const field of ["startAt", "endAt"]) {
    const value = options.scope?.[field];
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) fail("pr94_calibration_scope_invalid");
  }
  if (options.scope.startAt > options.scope.endAt) fail("pr94_calibration_scope_invalid");
  keyBytes(options.hmacKey);
}

export function buildPr94CalibrationEvidence(options) {
  validateInputs(options);
  const { internals, candidates, transitions, rawParents, revisionKind, hmacKey, scope } = options;
  const selectedPlanType = options.selectedPlanType ?? null;
  const parents = new Map();
  for (const raw of rawParents) {
    if (raw.windowDurationMins !== 10_080 || raw.limitId !== "codex") fail("pr94_calibration_parent_out_of_scope");
    const id = parentKey(raw, hmacKey);
    if (parents.has(id)) fail("pr94_calibration_duplicate_parent");
    const reason = noTransitionReason(raw); // Validate every raw partition, not only empty parents.
    parents.set(id, { raw, reason, frames: candidates.map((candidate) => ({
      kind: "parent", parentKey: id, candidateId: candidate.id, planType: plan(raw.planType),
      accountKnown: accountKnown(raw.accountScopeId),
      snapshotCount: raw.snapshotCount, fragments: [], noTransitionReason: null,
    })) });
  }
  const weekly = transitions.filter((row) => row.windowDurationMins === 10_080 && row.limitId === "codex");
  const groupedRows = new Map();
  const rowReasons = emptyCounts(ROW_REASONS);
  for (const row of weekly) {
    if (!parents.has(parentKey(row, hmacKey))) fail("pr94_calibration_transition_parent_missing");
    const group = groupKey(row, internals);
    const rows = groupedRows.get(group) ?? [];
    rows.push(row);
    groupedRows.set(group, rows);
    rowReasons[eligibleReason(row, internals)] += 1;
  }
  if (groupedRows.size > LIMITS.fragments) fail("pr94_calibration_fragment_limit");
  const actualPlans = [...new Set(rawParents.map((row) => row.planType ?? "unknown"))].sort();
  const reports = [];
  const observedGroups = new Set();
  for (const population of actualPlans) {
    const input = weekly.filter((row) => (row.planType ?? "unknown") === population);
    const grouped = internals.selectResetGroups(input);
    const selected = new Set(grouped.selected.map((group) => groupKey(group.first, internals)));
    const suppressed = new Map();
    for (const item of grouped.suppressed) {
      if (!SUPPRESSIONS.includes(item.reason)) fail("pr94_calibration_suppression_unknown");
      const id = `${item.partition}|${item.resetsAt}`;
      if (suppressed.has(id) || selected.has(id)) fail("pr94_calibration_group_multiplied");
      suppressed.set(id, item.reason);
    }
    for (const candidate of candidates) {
      const report = options.analyzeWeeklyCalibration({ transitions: input, scope }, {
        planType: population, forcedCandidateId: candidate.id,
      });
      const populationParents = new Set(rawParents.filter((row) => (row.planType ?? "unknown") === population)
        .map((row) => parentKey(row, hmacKey)));
      reports.push({ populationParents, candidateId: candidate.id, report });
      if (!equal(report.duplicateResetGroupsSuppressed, grouped.suppressed)
          || report.quality?.exactResetGroups !== grouped.exactGroupCount
          || report.quality?.selectedResetGroups !== grouped.selected.length) fail("pr94_calibration_report_group_mismatch");
      const primary = new Map();
      for (const reset of report.resetValues) {
        const id = `${reset.continuityTrack}|${reset.resetsAt}`;
        if (primary.has(id)) fail("pr94_calibration_primary_multiplied");
        primary.set(id, reset);
      }
      const diagnostics = new Map();
      for (const item of report.fragmentDiagnostics ?? []) {
        if (item.candidateId !== candidate.id) continue;
        if (item.reason !== "another_qualifying_fragment_represents_reset") fail("pr94_calibration_fragment_reason_unknown");
        const id = JSON.stringify([item.resetParentKey, item.planEraKey]);
        if (diagnostics.has(id)) fail("pr94_calibration_diagnostic_multiplied");
        diagnostics.set(id, item);
      }
      let primaryCount = 0;
      let diagnosticCount = 0;
      for (const [id, rows] of groupedRows) {
        const first = rows[0];
        if ((first.planType ?? "unknown") !== population) continue;
        observedGroups.add(id);
        if (selected.has(id) === suppressed.has(id)) fail("pr94_calibration_group_unreconciled");
        const frame = parents.get(parentKey(first, hmacKey)).frames.find((item) => item.candidateId === candidate.id);
        const fragment = {
          fragmentKey: digest(hmacKey, "fragment", id),
          actualParentKey: actualParentKey(first, internals, hmacKey),
          outcome: suppressed.get(id) ?? null, inputDigest: null,
          capacity: null, span: null, boundaries: null,
          accountCheck: emptyCounts(ACCOUNT_CHECK_COUNTS),
        };
        if (selected.has(id)) {
          const decision = fitDecision(rows, candidate, internals);
          fragment.accountCheck = checkUnknownAccountFit(rows, candidate, internals, decision.fit, decision.points);
          fragment.inputDigest = digest(hmacKey, "fit-input", decision.points);
          fragment.boundaries = decision.points.length;
          fragment.span = decision.points.length ? decision.points.at(-1).percent - decision.points[0].percent : null;
          fragment.outcome = decision.reason;
          if (decision.fit !== null) {
            fragment.capacity = decision.fit.fullCapacityUsd;
            const actual = primary.get(id);
            if (actual) {
              if (actual.apiPriceEquivalentUsd !== round(fragment.capacity)
                  || actual.pointCount !== decision.fit.pointCount
                  || actual.percentSpan !== round(decision.fit.percentSpan)) fail("pr94_calibration_report_fit_mismatch");
              fragment.outcome = selectedPlanType === null ? "unselected_plan_primary"
                : population === selectedPlanType ? "selected_plan_primary" : "alternate_plan_primary";
              primaryCount += 1;
            } else {
              const item = diagnostics.get(JSON.stringify([internals.resetParentKey?.(first), first.planEraKey ?? "legacy"]));
              if (!item || item.apiPriceEquivalentUsd !== round(fragment.capacity)
                  || item.uniqueBoundaries !== fragment.boundaries
                  || item.observedSpanPercentagePoints !== round(fragment.span)) fail("pr94_calibration_report_fragment_mismatch");
              fragment.outcome = "losing_qualifying_fragment";
              diagnosticCount += 1;
            }
          } else if (primary.has(id)) fail("pr94_calibration_report_rejected_fit");
        } else if (primary.has(id)) fail("pr94_calibration_report_suppressed_fit");
        frame.fragments.push(fragment);
      }
      const score = report.selection?.candidateScores?.find((item) => item.id === candidate.id);
      if (primaryCount !== primary.size || primaryCount !== score?.qualifyingResets
          || diagnosticCount !== diagnostics.size) fail("pr94_calibration_report_count_mismatch");
    }
  }
  if (observedGroups.size !== groupedRows.size) fail("pr94_calibration_group_unreconciled");
  const frames = [...parents.values()].flatMap(({ frames: items, reason }) => items.map((frame) => {
    if (frame.fragments.length === 0) frame.noTransitionReason = reason;
    frame.fragments.sort((a, b) => a.fragmentKey.localeCompare(b.fragmentKey));
    return frame;
  })).sort((a, b) => a.parentKey.localeCompare(b.parentKey) || a.candidateId.localeCompare(b.candidateId));
  assertFrames(frames);
  // Independently reconcile the original reporter's distribution, not only its counts.
  for (const { populationParents, candidateId, report } of reports) {
    const relevant = frames.filter((frame) => populationParents.has(frame.parentKey) && frame.candidateId === candidateId);
    const primary = relevant.flatMap((frame) => frame.fragments.filter(isPrimary).map((item) => item.capacity));
    const calculated = distribution(primary);
    const summary = report.weeklyValueSummary;
    if (summary === null ? calculated.count !== 0
      : summary.resetCount !== calculated.count || summary.medianApiPriceEquivalentUsd !== calculated.median
        || summary.central80AcrossResetsUsd.lower !== calculated.central80.lower
        || summary.central80AcrossResetsUsd.upper !== calculated.central80.upper) fail("pr94_calibration_report_distribution_mismatch");
    const fragmentSummary = report.quality?.fragmentSelection?.find((item) => item.candidateId === candidateId);
    if (revisionKind !== "before") {
      const diagnostic = distribution(relevant.flatMap((frame) => frame.fragments
        .filter((item) => item.outcome === "losing_qualifying_fragment").map((item) => round(item.capacity))));
      const projected = (value) => ({ count: value.count, medianApiPriceEquivalentUsd: value.median,
        central80ApiPriceEquivalentUsd: value.central80 });
      if (!equal(fragmentSummary?.primary, projected(calculated))
          || !equal(fragmentSummary?.diagnosticOnly, projected(diagnostic))) fail("pr94_calibration_report_distribution_mismatch");
    }
  }
  if (revisionKind === "before") {
    // The old public reporter has no plan selector. Per-plan diagnostic reads
    // must add back to its native all-plan result, not silently replace it.
    for (const candidate of candidates) {
      const report = options.analyzeWeeklyCalibration({ transitions: weekly, scope }, { forcedCandidateId: candidate.id });
      const expected = new Set(frames.filter((frame) => frame.candidateId === candidate.id)
        .flatMap((frame) => frame.fragments.filter(isPrimary).map((item) => item.fragmentKey)));
      const observed = new Set(report.resetValues.map((row) => digest(hmacKey, "fragment", `${row.continuityTrack}|${row.resetsAt}`)));
      if (observed.size !== report.resetValues.length || observed.size !== expected.size
          || [...observed].some((id) => !expected.has(id))) fail("pr94_calibration_baseline_population_mismatch");
      const score = report.selection?.candidateScores?.find((item) => item.id === candidate.id);
      if (score?.qualifyingResets !== expected.size) fail("pr94_calibration_baseline_population_mismatch");
    }
  }
  const aggregate = aggregateFrames(frames, { revisionKind, selectedPlanType: plan(selectedPlanType), transitionRows: weekly.length, rowReasons });
  PRIVATE.set(aggregate, { frames: freeze(frames), key: Buffer.from(hmacKey) });
  return aggregate;
}

function isPrimary(fragment) { return fragment.outcome.endsWith("_plan_primary"); }

function assertFrames(frames) {
  if (!Array.isArray(frames) || frames.length > LIMITS.parents * 4) fail("pr94_calibration_private_frames_invalid");
  const identities = new Set();
  const fragments = new Set();
  const votes = new Set();
  let fragmentCount = 0;
  for (const frame of frames) {
    if (!equal(recordKeys(frame).sort(), ["kind", "parentKey", "candidateId", "planType", "accountKnown", "snapshotCount", "fragments", "noTransitionReason"].sort())
        || frame.kind !== "parent" || !HEX.test(frame.parentKey)
        || !CANDIDATES.some(([id]) => id === frame.candidateId)
        || ![...PLANS, "other"].includes(frame.planType) || typeof frame.accountKnown !== "boolean"
        || !Array.isArray(frame.fragments) || frame.fragments.length > LIMITS.fragments
        || (frame.noTransitionReason !== null && !OUTCOMES.includes(frame.noTransitionReason))) fail("pr94_calibration_private_frames_invalid");
    count(frame.snapshotCount);
    const identity = `${frame.parentKey}|${frame.candidateId}`;
    if (identities.has(identity) || (frame.fragments.length === 0) !== (frame.noTransitionReason !== null)) fail("pr94_calibration_parent_multiplied");
    identities.add(identity);
    for (const item of frame.fragments) {
      fragmentCount += 1;
      if (fragmentCount > LIMITS.fragments * 4) fail("pr94_calibration_fragment_limit");
      if (!equal(recordKeys(item).sort(), ["fragmentKey", "actualParentKey", "outcome", "inputDigest", "capacity", "span", "boundaries", "accountCheck"].sort())
          || !HEX.test(item.fragmentKey) || !HEX.test(item.actualParentKey)
          || !OUTCOMES.includes(item.outcome) || (item.inputDigest !== null && !HEX.test(item.inputDigest))
          || (item.capacity !== null && (!Number.isFinite(item.capacity) || item.capacity <= 0))
          || (item.span !== null && !Number.isFinite(item.span))
          || (item.boundaries !== null && (!Number.isSafeInteger(item.boundaries) || item.boundaries < 0))) fail("pr94_calibration_private_frames_invalid");
      if (!equal(recordKeys(item.accountCheck).sort(), [...ACCOUNT_CHECK_COUNTS].sort())) fail("pr94_calibration_private_frames_invalid");
      for (const field of ACCOUNT_CHECK_COUNTS) count(item.accountCheck[field]);
      if (item.accountCheck.fragmentCandidatesChecked > 1
          || item.accountCheck.rowsChecked > LIMITS.transitions
          || (item.accountCheck.fragmentCandidatesChecked === 0) !== (item.accountCheck.rowsChecked === 0)
          || item.accountCheck.changedEligibilityRows > item.accountCheck.rowsChecked
          || ["changedPointSets", "changedFits", "unknownOnlyFitExclusions"].some((field) => item.accountCheck[field] > item.accountCheck.fragmentCandidatesChecked)
          || item.accountCheck.unknownOnlyFitExclusions > item.accountCheck.changedFits) fail("pr94_calibration_private_frames_invalid");
      const fragment = `${frame.candidateId}|${item.fragmentKey}`;
      if (fragments.has(fragment)) fail("pr94_calibration_fragment_multiplied");
      fragments.add(fragment);
      if (isPrimary(item)) {
        const vote = `${frame.candidateId}|${item.actualParentKey}`;
        if (votes.has(vote) || item.capacity === null) fail("pr94_calibration_primary_multiplied");
        votes.add(vote);
      }
    }
  }
  const parentCounts = new Map();
  for (const frame of frames) parentCounts.set(frame.parentKey, (parentCounts.get(frame.parentKey) ?? 0) + 1);
  if ([...parentCounts.values()].some((value) => value !== 4)) fail("pr94_calibration_parent_candidate_missing");
}

function aggregateFrames(frames, metadata) {
  const parents = frames.filter((frame) => frame.candidateId === "standard_api");
  const summarize = (items) => {
    const outcomes = emptyCounts(OUTCOMES);
    const primary = [];
    const diagnostic = [];
    const spans = [];
    const boundaries = [];
    for (const frame of items) {
      if (frame.noTransitionReason !== null) outcomes[frame.noTransitionReason] += 1;
      for (const item of frame.fragments) {
        outcomes[item.outcome] += 1;
        if (isPrimary(item)) primary.push(item.capacity);
        if (item.outcome === "losing_qualifying_fragment") diagnostic.push(item.capacity);
        if (item.span !== null) spans.push(item.span);
        if (item.boundaries !== null) boundaries.push(item.boundaries);
      }
    }
    return { parentCandidates: items.length, outcomes, primary: distribution(primary), diagnostic: distribution(diagnostic), spans: distribution(spans), boundaries: distribution(boundaries) };
  };
  const unexplained = parents.filter((frame) => frame.noTransitionReason === "unexplained_no_transition").length;
  const unknownAccountCheck = { scope: "original_fit_gate_only", ...emptyCounts(ACCOUNT_CHECK_COUNTS) };
  for (const frame of frames) for (const fragment of frame.fragments) {
    for (const field of ACCOUNT_CHECK_COUNTS) unknownAccountCheck[field] += fragment.accountCheck[field];
  }
  const accountViolation = ACCOUNT_CHECK_COUNTS.slice(2).some((field) => unknownAccountCheck[field] !== 0);
  return freeze({
    schemaVersion: SCHEMA, revisionKind: metadata.revisionKind, selectedPlanType: metadata.selectedPlanType,
    status: unexplained === 0 && !accountViolation ? "pass" : "fail",
    counts: { rawParents: parents.length, parentCandidates: frames.length, transitionRows: metadata.transitionRows,
      parentsWithTransitions: parents.filter((frame) => frame.fragments.length > 0).length,
      knownAccountParents: parents.filter((frame) => frame.accountKnown).length,
      unknownAccountParents: parents.filter((frame) => !frame.accountKnown).length, unexplainedParents: unexplained },
    rowReasons: metadata.rowReasons, unknownAccountCheck,
    candidates: CANDIDATES.map(([candidateId]) => ({ candidateId, ...summarize(frames.filter((frame) => frame.candidateId === candidateId)) })),
    plans: [...new Set(frames.map((frame) => frame.planType))].sort().map((planType) => ({
      planType, candidates: CANDIDATES.map(([candidateId]) => ({ candidateId, ...summarize(frames.filter((frame) => frame.planType === planType && frame.candidateId === candidateId)) })),
    })),
  });
}

/** Owner-only transport. These HMAC frames are NEVER a public receipt. */
export function* iteratePr94CalibrationPrivateFrames(evidence) {
  const state = PRIVATE.get(evidence);
  if (!state) fail("pr94_calibration_evidence_untrusted");
  for (const frame of state.frames) {
    if (PRIVATE.get(evidence) !== state) fail("pr94_calibration_evidence_untrusted");
    yield clone(frame);
  }
  if (PRIVATE.get(evidence) !== state) fail("pr94_calibration_evidence_untrusted");
  yield { kind: "seal", digest: digest(state.key, "sealed-calibration", [evidence, state.frames]) };
}

export function disposePr94CalibrationEvidencePrivate(evidence) {
  const state = PRIVATE.get(evidence);
  if (!state) fail("pr94_calibration_evidence_untrusted");
  state.key.fill(0);
  state.frames = null;
  PRIVATE.delete(evidence);
}

export async function importPr94CalibrationEvidence({ aggregate, frames, hmacKey }) {
  keyBytes(hmacKey);
  if (!frames || (typeof frames[Symbol.iterator] !== "function" && typeof frames[Symbol.asyncIterator] !== "function")) {
    fail("pr94_calibration_private_frames_invalid");
  }
  const received = [];
  for await (const frame of frames) {
    if (received.length >= LIMITS.parents * 4 + 1) fail("pr94_calibration_private_frames_invalid");
    recordKeys(frame);
    if (Array.isArray(frame.fragments)) for (const item of frame.fragments) {
      recordKeys(item);
      recordKeys(item.accountCheck);
    }
    received.push(clone(frame));
  }
  if (received.length === 0) fail("pr94_calibration_private_frames_invalid");
  const items = received.slice(0, -1);
  assertFrames(items);
  const seal = received.at(-1);
  if (!equal(recordKeys(seal).sort(), ["digest", "kind"]) || seal.kind !== "seal" || !HEX.test(seal.digest)) fail("pr94_calibration_seal_invalid");
  const expected = digest(hmacKey, "sealed-calibration", [aggregate, items]);
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(seal.digest, "hex"))) fail("pr94_calibration_seal_invalid");
  if (!["before", "after", "final"].includes(aggregate?.revisionKind)
      || ![...PLANS, "other"].includes(aggregate.selectedPlanType)
      || !equal(Object.keys(aggregate.rowReasons ?? {}).sort(), [...ROW_REASONS].sort())) fail("pr94_calibration_aggregate_invalid");
  for (const value of Object.values(aggregate.rowReasons)) count(value);
  const rebuilt = aggregateFrames(items, { revisionKind: aggregate.revisionKind, selectedPlanType: aggregate.selectedPlanType,
    transitionRows: count(aggregate.counts?.transitionRows), rowReasons: clone(aggregate.rowReasons) });
  if (!equal(aggregate, rebuilt)) fail("pr94_calibration_aggregate_invalid");
  PRIVATE.set(rebuilt, { frames: freeze(items), key: Buffer.from(hmacKey) });
  return rebuilt;
}

export function comparePr94CalibrationEvidence(before, after) {
  const left = PRIVATE.get(before);
  const right = PRIVATE.get(after);
  if (!left || !right || left.key.length !== right.key.length
      || !timingSafeEqual(left.key, right.key)) fail("pr94_calibration_evidence_untrusted");
  const prior = new Map(left.frames.map((frame) => [`${frame.parentKey}|${frame.candidateId}`, frame]));
  const next = new Map(right.frames.map((frame) => [`${frame.parentKey}|${frame.candidateId}`, frame]));
  let missing = 0;
  let added = 0;
  let unchangedFitInputs = 0;
  let changedIdenticalInputFits = 0;
  let rejectedIdenticalInputFits = 0;
  let changedRawParentInventory = 0;
  let baselinePrimaryFits = 0;
  let retainedPrimaryFits = 0;
  let lostPrimaryFits = 0;
  let newPrimaryFits = 0;
  let changedInputPrimaryLosses = 0;
  let unexplainedPrimaryLosses = 0;
  let retainedPrimaryInputChanges = 0;
  let changedOutcomeParentCandidates = 0;
  const matrix = new Map();
  const outcomes = (frame) => {
    const counts = new Map();
    if (!frame) counts.set("missing_parent", 1);
    else if (frame.noTransitionReason !== null) counts.set(frame.noTransitionReason, 1);
    else for (const fragment of frame.fragments) counts.set(fragment.outcome, (counts.get(fragment.outcome) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => compareReceiptKeys(a, b)).map(([outcome, count]) => ({ outcome, count }));
  };
  const addMatrix = (frame, following) => {
    const baseline = frame?.fragments.filter(isPrimary) ?? [];
    const current = following?.fragments.filter(isPrimary) ?? [];
    const retained = Math.min(baseline.length, current.length);
    const lost = baseline.length - retained;
    const gained = current.length - retained;
    const afterOutcomes = outcomes(following);
    const transition = !following ? "missing_parent" : baseline.length > 0
      ? current.length > 0 ? "retained_primary" : "lost_primary"
      : current.length > 0 ? "new_primary" : "no_primary";
    // A changed-input rejection is evidence of changed fit inputs, not proof
    // that the change is acceptable. Preserve every exact downstream reason
    // and make every coverage change require review; no loss tolerance exists.
    const selectedAfter = following?.fragments.filter((item) => item.inputDigest !== null) ?? [];
    const inputsChanged = lost > 0 && selectedAfter.length > 0
      && baseline.every((previous) => selectedAfter.every((item) => item.inputDigest !== previous.inputDigest));
    const namedOtherDisposition = following && (following.noTransitionReason !== null
      && following.noTransitionReason !== "unexplained_no_transition"
      || following.fragments.some((item) => SUPPRESSIONS.includes(item.outcome)
        || item.outcome === "losing_qualifying_fragment"));
    const unexplained = lost > 0 && (!following || (!inputsChanged && !namedOtherDisposition));
    const primaryInputsChanged = retained > 0 && !equal(baseline.map((item) => item.inputDigest).sort(),
      current.map((item) => item.inputDigest).sort());
    if (primaryInputsChanged) retainedPrimaryInputChanges += 1;
    if (frame && following && !equal(outcomes(frame), afterOutcomes)) changedOutcomeParentCandidates += 1;
    baselinePrimaryFits += baseline.length;
    retainedPrimaryFits += retained;
    lostPrimaryFits += lost;
    newPrimaryFits += gained;
    if (inputsChanged) changedInputPrimaryLosses += lost;
    if (unexplained) unexplainedPrimaryLosses += lost;
    const identity = frame ?? following;
    const key = JSON.stringify([identity.candidateId, identity.planType, identity.accountKnown, transition, afterOutcomes]);
    let cell = matrix.get(key);
    if (!cell) {
      cell = { candidateId: identity.candidateId, planType: identity.planType, accountKnown: identity.accountKnown,
        transition, afterOutcomes, parentCandidates: 0, baselinePrimaryFits: 0, afterPrimaryFits: 0,
        retainedPrimaryFits: 0, lostPrimaryFits: 0, newPrimaryFits: 0, changedInputPrimaryLosses: 0 };
      matrix.set(key, cell);
    }
    cell.parentCandidates += 1;
    cell.baselinePrimaryFits += baseline.length;
    cell.afterPrimaryFits += current.length;
    cell.retainedPrimaryFits += retained;
    cell.lostPrimaryFits += lost;
    cell.newPrimaryFits += gained;
    if (inputsChanged) cell.changedInputPrimaryLosses += lost;
  };
  for (const [id, frame] of prior) {
    const following = next.get(id);
    addMatrix(frame, following);
    if (!following) { missing += 1; continue; }
    if (frame.snapshotCount !== following.snapshotCount || frame.accountKnown !== following.accountKnown
        || frame.planType !== following.planType) changedRawParentInventory += 1;
    const priorFits = new Map(frame.fragments.filter((item) => item.capacity !== null).map((item) => [item.inputDigest, item.capacity]));
    for (const item of following.fragments.filter((fragment) => fragment.inputDigest !== null)) {
      if (!priorFits.has(item.inputDigest)) continue;
      unchangedFitInputs += 1;
      if (item.capacity === null) rejectedIdenticalInputFits += 1;
      else if (priorFits.get(item.inputDigest) !== item.capacity) changedIdenticalInputFits += 1;
    }
  }
  for (const [id, frame] of next) if (!prior.has(id)) { added += 1; addMatrix(null, frame); }
  return freeze({ schemaVersion: "pr94-calibration-comparison-v2",
    status: before.status === "pass" && after.status === "pass" && missing === 0 && added === 0
      && changedIdenticalInputFits === 0 && rejectedIdenticalInputFits === 0
      && unexplainedPrimaryLosses === 0 && changedRawParentInventory === 0
      && before.selectedPlanType === after.selectedPlanType ? "pass" : "fail",
    beforeParentCandidates: prior.size, afterParentCandidates: next.size,
    missingParentCandidates: missing, addedParentCandidates: added,
    reconciledParentCandidates: prior.size - missing, identicalFitInputsCompared: unchangedFitInputs,
    changedIdenticalInputFits, unexplainedParents: before.counts.unexplainedParents + after.counts.unexplainedParents,
    changedRawParentInventory, selectedPopulationMatches: before.selectedPlanType === after.selectedPlanType,
    duplicatePrimaryVotes: 0,
    baselinePrimaryFits, retainedPrimaryFits, lostPrimaryFits, newPrimaryFits,
    changedInputPrimaryLosses, rejectedIdenticalInputFits, unexplainedPrimaryLosses,
    retainedPrimaryInputChanges, changedOutcomeParentCandidates,
    requiresCoverageReview: lostPrimaryFits > 0 || newPrimaryFits > 0
      || retainedPrimaryInputChanges > 0 || changedOutcomeParentCandidates > 0,
    primaryOutcomeMatrix: [...matrix.entries()].sort(([a], [b]) => compareReceiptKeys(a, b)).map(([, value]) => value),
  });
}
