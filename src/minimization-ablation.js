import { createHash } from "node:crypto";
import { analyzeWeeklyCalibration } from "./reporting/index.js";
import { stableJson } from "./export/index.js";

export const MINIMIZATION_ABLATION_SCHEMA_VERSION = "g1-data-minimization-ablation-v0.1";

const PRIMARY_ABSOLUTE_TOLERANCE_PP = 0.25;
const PRIMARY_RELATIVE_TOLERANCE = 0.05;
const MINIMUM_PROSPECTIVE_RESETS = 3;

const SAFE_TRANSITION_KEYS = new Set([
  "accountScopeId", "aggregateToolClassMix", "controlledState", "displayLagEnvelopes", "eventTime",
  "firstNextCumulativeApiPricedUsd", "firstNextCumulativeQuotaWeightedLowerUsd",
  "firstNextCumulativeQuotaWeightedUpperUsd", "firstNextObservedAt",
  "lastPriorCumulativeApiPricedUsd", "lastPriorCumulativeQuotaWeightedLowerUsd",
  "lastPriorCumulativeQuotaWeightedUpperUsd", "lastPriorObservedAt", "limitId",
  "marginalApiPricedUsd", "marginalComponents", "marginalUsageEventCount", "modelMix",
  "modelFingerprint", "nextUsedPercent", "parserVersion", "planType", "priceCardIds",
  "priorUsedPercent", "provider", "providerSummary", "quality", "resetIdentity", "resetsAt", "sessionPseudonym",
  "slot", "snapshot", "tierUsageEventCounts", "windowDurationMins",
]);

const FIELD_FAMILIES = [
  {
    id: "A1", label: "event timestamp", sourceFields: ["eventTime", "firstNextObservedAt", "lastPriorObservedAt"],
    variants: [
      { id: "exact_timestamp", detailRank: 2, temporalResolution: "exact", linkability: "high", transform: (row) => row },
      { id: "minute_timestamp", detailRank: 1, temporalResolution: "minute", linkability: "medium", transform: (row) => roundRowTimes(row, 60) },
      { id: "five_minute_timestamp", detailRank: 0, temporalResolution: "five_minutes", linkability: "low", transform: (row) => roundRowTimes(row, 300) },
    ],
    fallback: "temporary_restricted_exact_time_only_until_prospective_receipt",
  },
  {
    id: "A2", label: "session pseudonym", sourceFields: ["sessionPseudonym"],
    variants: [
      { id: "session_retained", detailRank: 2, temporalResolution: "not_applicable", linkability: "high", transform: (row) => row },
      { id: "session_constant", detailRank: 1, temporalResolution: "not_applicable", linkability: "none", transform: (row) => ({ ...row, sessionPseudonym: "constant" }) },
      { id: "session_omitted", detailRank: 0, temporalResolution: "not_applicable", linkability: "none", transform: (row) => omitFields(row, ["sessionPseudonym"]) },
    ],
    fallback: "omit",
  },
  {
    id: "A3", label: "unknown-model fingerprint", sourceFields: ["modelFingerprint"],
    variants: [
      { id: "fingerprint_retained", detailRank: 1, temporalResolution: "not_applicable", linkability: "high", transform: (row) => row },
      { id: "fingerprint_plain_unknown", detailRank: 0, temporalResolution: "not_applicable", linkability: "none", transform: (row) => ({ ...row, modelFingerprint: "unknown" }) },
    ],
    fallback: "omit",
  },
  {
    id: "A4", label: "tool diagnostics", sourceFields: ["aggregateToolClassMix"],
    variants: [
      { id: "coarse_tool_groups", detailRank: 2, temporalResolution: "not_applicable", linkability: "low", transform: (row) => row },
      { id: "total_tool_count", detailRank: 1, temporalResolution: "not_applicable", linkability: "low", transform: (row) => ({ ...row, aggregateToolClassMix: { total: sumNumbers(row.aggregateToolClassMix) } }) },
      { id: "binary_tool_used", detailRank: 0, temporalResolution: "not_applicable", linkability: "none", transform: (row) => ({ ...row, aggregateToolClassMix: { used: sumNumbers(row.aggregateToolClassMix) > 0 ? 1 : 0 } }) },
    ],
    fallback: "omit_or_binary_only_after_synthetic_gate",
  },
  {
    id: "A5", label: "receipt and reset time", sourceFields: ["resetsAt", "firstNextObservedAt", "lastPriorObservedAt"],
    variants: [
      { id: "minute_receipt_reset_time", detailRank: 1, temporalResolution: "minute", linkability: "medium", transform: (row) => roundReceiptAndReset(row, 60) },
      { id: "five_minute_receipt_reset_time", detailRank: 0, temporalResolution: "five_minutes", linkability: "low", transform: (row) => roundReceiptAndReset(row, 300) },
    ],
    fallback: "no_schema_retention_until_reset_assignment_gate_passes",
  },
  {
    id: "A6", label: "parser and source diagnostics", sourceFields: ["quality"],
    variants: [
      { id: "broad_diagnostic_categories", detailRank: 2, temporalResolution: "not_applicable", linkability: "low", transform: (row) => row },
      { id: "aggregate_diagnostic_counts", detailRank: 1, temporalResolution: "not_applicable", linkability: "none", transform: (row) => ({ ...row, quality: aggregateQuality(row.quality) }) },
      { id: "diagnostics_omitted", detailRank: 0, temporalResolution: "not_applicable", linkability: "none", transform: (row) => omitFields(row, ["quality"]) },
    ],
    fallback: "omit_or_aggregate_only_after_synthetic_gate",
  },
  {
    id: "A7", label: "provider-level summaries", sourceFields: ["providerSummary"],
    variants: [
      { id: "provider_summary_omitted", detailRank: 0, temporalResolution: "not_applicable", linkability: "none", transform: (row) => omitFields(row, ["providerSummary"]) },
    ],
    fallback: "omit",
  },
];

function round(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sumNumbers(value) {
  return Object.values(value ?? {}).reduce((sum, item) => sum + (Number.isFinite(item) ? item : 0), 0);
}

function omitFields(row, fields) {
  const next = { ...row };
  for (const field of fields) delete next[field];
  return next;
}

function roundEpochSeconds(value, resolutionSeconds) {
  return Number.isFinite(value) ? Math.floor(value / resolutionSeconds) * resolutionSeconds : value;
}

function roundIso(value, resolutionSeconds) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return value;
  return new Date(Math.floor(milliseconds / (resolutionSeconds * 1_000)) * resolutionSeconds * 1_000).toISOString();
}

function roundRowTimes(row, resolutionSeconds) {
  return {
    ...row,
    eventTime: roundIso(row.eventTime, resolutionSeconds),
    firstNextObservedAt: roundIso(row.firstNextObservedAt, resolutionSeconds),
    lastPriorObservedAt: roundIso(row.lastPriorObservedAt, resolutionSeconds),
  };
}

function roundReceiptAndReset(row, resolutionSeconds) {
  return {
    ...row,
    resetsAt: roundEpochSeconds(row.resetsAt, resolutionSeconds),
    firstNextObservedAt: roundIso(row.firstNextObservedAt, resolutionSeconds),
    lastPriorObservedAt: roundIso(row.lastPriorObservedAt, resolutionSeconds),
  };
}

function aggregateQuality(quality) {
  if (!quality || typeof quality !== "object") return quality;
  const warningCount = (field) => Array.isArray(quality[field]) ? quality[field].length : 0;
  return {
    localCoverage: quality.localCoverage,
    pricingWarnings: Array.from({ length: warningCount("pricingWarnings") }, () => "aggregate"),
    attributionWarnings: Array.from({ length: warningCount("attributionWarnings") }, () => "aggregate"),
  };
}

function valueKey(value) {
  return stableJson(value);
}

function knownScope(row) {
  return Boolean(row.accountScopeId && row.accountScopeId !== "unattributed")
    && Boolean(row.planType && row.planType !== "unknown");
}

// Slot is retained as a row field but excluded from partitions: it is a
// server-assigned UI role (the weekly window flipped secondary -> primary
// around 2026-07-06), so partition identity is (limit, duration) with
// resetsAt as the instance facet.
function resetPartition(row) {
  return [
    row.accountScopeId ?? "unattributed", row.provider ?? "unknown",
    row.planType ?? "unknown", row.limitId ?? "unknown",
    row.windowDurationMins ?? "unknown", row.resetsAt ?? "unknown",
  ].join("\u001f");
}

function basePartition(row) {
  return [
    row.accountScopeId ?? "unattributed", row.provider ?? "unknown",
    row.planType ?? "unknown", row.limitId ?? "unknown",
    row.windowDurationMins ?? "unknown",
  ].join("\u001f");
}

function transitionComponentTotals(rows) {
  const totals = { apiPriceEquivalentUsd: 0, tokenComponents: 0 };
  for (const row of rows) {
    if (Number.isFinite(row.marginalApiPricedUsd)) totals.apiPriceEquivalentUsd += row.marginalApiPricedUsd;
    totals.tokenComponents += sumNumbers(row.marginalComponents);
  }
  return {
    apiPriceEquivalentUsd: round(totals.apiPriceEquivalentUsd),
    tokenComponents: round(totals.tokenComponents),
  };
}

function sourceAvailability(rows, family) {
  return rows.length > 0 && family.sourceFields.every((field) => rows.every((row) => Object.hasOwn(row, field)));
}

function summarizeCardinality(rows, family, variant) {
  const fields = family.id === "A1" ? ["eventTime", "firstNextObservedAt", "lastPriorObservedAt"]
    : family.id === "A2" ? ["sessionPseudonym"]
      : family.id === "A3" ? ["modelFingerprint"]
        : family.id === "A4" ? ["aggregateToolClassMix"]
          : family.id === "A5" ? ["resetsAt", "firstNextObservedAt", "lastPriorObservedAt"]
            : family.id === "A6" ? ["quality"]
              : ["providerSummary"];
  const values = rows.filter((row) => fields.every((field) => Object.hasOwn(row, field)))
    .map((row) => valueKey(fields.map((field) => row[field])));
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const tupleCounts = new Map();
  for (const row of rows) {
    const tuple = valueKey([row.provider, row.planType, row.windowDurationMins, fields.map((field) => row[field] ?? null)]);
    tupleCounts.set(tuple, (tupleCounts.get(tuple) ?? 0) + 1);
  }
  return {
    fieldFamily: family.id,
    retainedRestrictedFields: fields,
    retained: values.length > 0,
    distinctValueCount: counts.size,
    singletonValueFraction: values.length === 0 ? null : round([...counts.values()].filter((count) => count === 1).length / values.length),
    quasiIdentifierDistinctTupleCount: tupleCounts.size,
    quasiIdentifierSingletonTupleFraction: rows.length === 0 ? null : round([...tupleCounts.values()].filter((count) => count === 1).length / rows.length),
    temporalResolution: variant.temporalResolution,
    linkability: variant.linkability,
    retentionEligibility: "pending_prospective_receipt",
    rowValuesEmitted: false,
  };
}

function resetAssignmentSummary(referenceRows, variantRows) {
  const byOriginal = new Map();
  const byVariant = new Map();
  for (let index = 0; index < referenceRows.length; index += 1) {
    const original = resetPartition(referenceRows[index]);
    const variant = resetPartition(variantRows[index]);
    const originalTargets = byOriginal.get(original) ?? new Set();
    originalTargets.add(variant);
    byOriginal.set(original, originalTargets);
    const variantSources = byVariant.get(variant) ?? new Set();
    variantSources.add(original);
    byVariant.set(variant, variantSources);
  }
  const split = new Set([...byOriginal].filter(([, targets]) => targets.size > 1).map(([key]) => key));
  const merged = new Set([...byVariant].filter(([, sources]) => sources.size > 1).map(([key]) => key));
  const mismatchedRows = referenceRows.reduce((count, row, index) => count
    + (split.has(resetPartition(row)) || merged.has(resetPartition(variantRows[index])) ? 1 : 0), 0);
  return {
    mismatchFraction: referenceRows.length === 0 ? null : round(mismatchedRows / referenceRows.length),
    wholeResetReassignment: split.size > 0 || merged.size > 0,
  };
}

function equivalentPartitions(referenceRows, variantRows, key) {
  if (referenceRows.length !== variantRows.length) return false;
  const reference = referenceRows.map(key);
  const variant = variantRows.map(key);
  const relation = new Map();
  for (let index = 0; index < reference.length; index += 1) {
    const seen = relation.get(reference[index]);
    if (seen && seen !== variant[index]) return false;
    relation.set(reference[index], variant[index]);
  }
  return true;
}

function pearson(xs, ys) {
  if (xs.length < 2 || xs.length !== ys.length) return null;
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const xMean = mean(xs);
  const yMean = mean(ys);
  let numerator = 0;
  let xSquares = 0;
  let ySquares = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const x = xs[index] - xMean;
    const y = ys[index] - yMean;
    numerator += x * y;
    xSquares += x * x;
    ySquares += y * y;
  }
  return xSquares > 0 && ySquares > 0 ? numerator / Math.sqrt(xSquares * ySquares) : null;
}

function slope(xs, ys) {
  if (xs.length < 2 || xs.length !== ys.length) return null;
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index] - xMean) * (ys[index] - yMean);
    denominator += (xs[index] - xMean) ** 2;
  }
  return denominator > 0 ? numerator / denominator : null;
}

function gradientDiagnostics(rows) {
  const byReset = new Map();
  for (const row of rows) {
    const key = resetPartition(row);
    const entries = byReset.get(key) ?? [];
    entries.push(row);
    byReset.set(key, entries);
  }
  const result = {};
  for (const horizonHours of [1, 2, 3]) {
    const costs = [];
    const movements = [];
    const maximumMs = horizonHours * 60 * 60 * 1_000;
    for (const entries of byReset.values()) {
      entries.sort((left, right) => left.eventTime.localeCompare(right.eventTime));
      for (let right = 0; right < entries.length; right += 1) {
        for (let left = right - 1; left >= 0; left -= 1) {
          const elapsedMs = Date.parse(entries[right].firstNextObservedAt) - Date.parse(entries[left].lastPriorObservedAt);
          if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) continue;
          if (elapsedMs > maximumMs) break;
          const cost = entries[right].firstNextCumulativeApiPricedUsd - entries[left].lastPriorCumulativeApiPricedUsd;
          const movement = entries[right].nextUsedPercent - entries[left].priorUsedPercent;
          if (Number.isFinite(cost) && Number.isFinite(movement) && cost > 0 && movement > 0) {
            costs.push(cost);
            movements.push(movement);
          }
        }
      }
    }
    result[`${horizonHours}h`] = costs.length >= 3 ? {
      status: "available",
      comparisonCount: costs.length,
      correlation: round(pearson(costs, movements)),
      slopePpPerUsd: round(slope(costs, movements)),
    } : { status: "unavailable", comparisonCount: costs.length, correlation: null, slopePpPerUsd: null };
  }
  return result;
}

function primaryMetrics(rows, scope) {
  const report = analyzeWeeklyCalibration({
    parserVersion: "g1-minimization-input",
    scope,
    pricing: { basis: "standard_openai_api_prices_not_codex_subscription_credits" },
    transitions: rows,
  });
  const standard = report.selection.candidateScores.find((candidate) => candidate.id === "standard_api");
  if (!standard || standard.qualifyingResets < MINIMUM_PROSPECTIVE_RESETS || !Number.isFinite(standard.pooledHoldoutMaePp)) {
    return {
      status: "insufficient_qualifying_resets",
      qualifyingResetCount: standard?.qualifyingResets ?? 0,
      holdoutPointCount: standard?.holdoutPoints ?? 0,
      maePp: null,
      signedBiasPp: null,
      report,
    };
  }
  return {
    status: "available",
    qualifyingResetCount: standard.qualifyingResets,
    holdoutPointCount: standard.holdoutPoints,
    maePp: standard.pooledHoldoutMaePp,
    signedBiasPp: standard.pooledHoldoutBiasPp,
    report,
  };
}

function comparablePrimary(reference, candidate) {
  if (reference.status !== "available" || candidate.status !== "available") {
    return { status: "unavailable", pass: false, absoluteLossPp: null, relativeLossFraction: null };
  }
  const absoluteLossPp = round(candidate.maePp - reference.maePp);
  const relativeLossFraction = reference.maePp >= PRIMARY_ABSOLUTE_TOLERANCE_PP
    ? round(absoluteLossPp / reference.maePp)
    : null;
  const pass = absoluteLossPp <= PRIMARY_ABSOLUTE_TOLERANCE_PP
    && (relativeLossFraction === null || relativeLossFraction <= PRIMARY_RELATIVE_TOLERANCE);
  return { status: pass ? "pass" : "fail", pass, absoluteLossPp, relativeLossFraction };
}

function scopeSummary(rows) {
  const scoped = rows.filter(knownScope).length;
  return {
    eligibleRecordCount: rows.length,
    knownScopeFraction: rows.length === 0 ? null : round(scoped / rows.length),
    usable: rows.length > 0 && scoped === rows.length,
  };
}

function hardGates(referenceRows, variantRows, referenceCardinality, variantCardinality, prospectiveRows, variantProspectiveRows) {
  const referenceTotals = transitionComponentTotals(referenceRows);
  const variantTotals = transitionComponentTotals(variantRows);
  const resetAssignment = resetAssignmentSummary(referenceRows, variantRows);
  const referenceScope = scopeSummary(prospectiveRows);
  const variantScope = scopeSummary(variantProspectiveRows);
  const contaminationEqual = referenceRows.every((row, index) => row.controlledState === variantRows[index].controlledState);
  const deterministicFirst = sha256(stableJson({
    totals: variantTotals, cardinality: variantCardinality, resetAssignment,
    gradient: gradientDiagnostics(variantProspectiveRows),
  }));
  const deterministicSecond = sha256(stableJson({
    totals: transitionComponentTotals(variantRows), cardinality: variantCardinality,
    resetAssignment: resetAssignmentSummary(referenceRows, variantRows), gradient: gradientDiagnostics(variantProspectiveRows),
  }));
  const componentMatch = Object.keys(referenceTotals).every((key) => Math.abs(referenceTotals[key] - variantTotals[key]) <= 1e-6);
  const collisionPass = variantCardinality.distinctValueCount <= referenceCardinality.distinctValueCount || !variantCardinality.retained;
  const identityPass = referenceRows.length === variantRows.length
    && new Set(referenceRows.map((row) => row.__minimizationIndex)).size === referenceRows.length
    && new Set(variantRows.map((row) => row.__minimizationIndex)).size === variantRows.length;
  return [
    { id: "identity_parity", status: identityPass ? "pass" : "fail", recordCount: variantRows.length },
    { id: "duplicate_collision", status: collisionPass ? "pass" : "fail", variantDistinctValueCount: variantCardinality.distinctValueCount },
    { id: "partition_isolation", status: equivalentPartitions(referenceRows, variantRows, basePartition) ? "pass" : "fail" },
    { id: "reset_assignment", status: resetAssignment.mismatchFraction !== null && resetAssignment.mismatchFraction <= 0.005 && !resetAssignment.wholeResetReassignment ? "pass" : "fail", ...resetAssignment },
    { id: "component_totals", status: componentMatch ? "pass" : "fail", totalsMatch: componentMatch },
    { id: "identifiability", status: collisionPass ? "pass" : "fail", linkability: variantCardinality.linkability },
    { id: "contamination", status: contaminationEqual ? "pass" : "fail" },
    { id: "scope_alert", status: referenceScope.usable && variantScope.usable ? "pass" : "fail", referenceScope, variantScope },
    { id: "determinism", status: deterministicFirst === deterministicSecond ? "pass" : "fail" },
    { id: "privacy", status: variantCardinality.rowValuesEmitted === false ? "pass" : "fail" },
  ];
}

function publicPrimary(primary) {
  return {
    status: primary.status,
    qualifyingResetCount: primary.qualifyingResetCount,
    holdoutPointCount: primary.holdoutPointCount,
    maePp: primary.maePp,
    signedBiasPp: primary.signedBiasPp,
  };
}

function independentSecondaryUtility(reference, candidate, fixtureHashes) {
  const available = Object.values(candidate).filter((entry) => entry.status === "available");
  const referenceAvailable = Object.values(reference).filter((entry) => entry.status === "available");
  const improvements = available.flatMap((entry, index) => {
    const baseline = referenceAvailable[index];
    if (!baseline || !Number.isFinite(entry.correlation) || !Number.isFinite(baseline.correlation) || baseline.correlation === 0) return [];
    return [(entry.correlation - baseline.correlation) / Math.abs(baseline.correlation)];
  });
  const fixtureCount = Object.keys(fixtureHashes ?? {}).length;
  const supported = improvements.some((improvement) => improvement >= 0.1) && fixtureCount >= 2;
  return {
    status: supported ? "supported" : "not_supported",
    requiredRelativeImprovement: 0.1,
    independentEvidenceCount: fixtureCount,
    maximumObservedRelativeCorrelationImprovement: improvements.length ? round(Math.max(...improvements)) : null,
  };
}

function defaultDecision(family) {
  return {
    status: "insufficient_evidence_default",
    disposition: family.fallback,
    publicAggregatePermitted: false,
  };
}

function selectFamily(family, variants, evidenceReady) {
  if (!evidenceReady) return defaultDecision(family);
  const eligible = variants.filter((variant) => variant.status === "eligible");
  if (eligible.length === 0) return {
    status: "no_variant_met_gates",
    disposition: family.fallback,
    publicAggregatePermitted: false,
  };
  eligible.sort((left, right) => left.detailRank - right.detailRank || left.id.localeCompare(right.id));
  return {
    status: "selected",
    selectedVariantId: eligible[0].id,
    disposition: "retain_only_selected_minimum_detail",
    publicAggregatePermitted: false,
  };
}

function prospectiveRows(rows, cutoffMs, asOfMs) {
  return rows.filter((row) => {
    const resetEndMs = Number(row.resetsAt) * 1_000;
    const durationMs = Number(row.windowDurationMins) * 60_000;
    return Number.isFinite(resetEndMs) && Number.isFinite(durationMs)
      && resetEndMs - durationMs >= cutoffMs && resetEndMs <= asOfMs;
  });
}

function assertSafeTransitionDataset(dataset) {
  if (!dataset || typeof dataset !== "object" || !Array.isArray(dataset.transitions)) {
    throw new TypeError("Data-minimization input must be a sanitized transition dataset");
  }
  for (const row of dataset.transitions) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new TypeError("Invalid sanitized transition record");
    for (const key of Object.keys(row)) {
      if (!SAFE_TRANSITION_KEYS.has(key)) throw new TypeError("Data-minimization input contains an unsupported record field");
    }
  }
}

function materializeRows(rows, transform) {
  return rows.map((row, index) => ({ ...transform({ ...row }), __minimizationIndex: index }));
}

function stripInternal(rows) {
  return rows.map(({ __minimizationIndex, ...row }) => row);
}

function evaluateVariant({ family, variant, referenceRows, prospectiveReferenceRows, scope, fixtureHashes }) {
  const available = sourceAvailability(referenceRows, family);
  if (!available) {
    return {
      id: variant.id,
      detailRank: variant.detailRank,
      status: "source_field_unavailable",
      primary: { status: "not_evaluated", qualifyingResetCount: 0, holdoutPointCount: 0, maePp: null, signedBiasPp: null },
      primaryComparison: { status: "unavailable", pass: false, absoluteLossPp: null, relativeLossFraction: null },
      secondary: { status: "not_evaluated" },
      hardGates: [],
      privacyCardinality: { fieldFamily: family.id, retained: false, temporalResolution: variant.temporalResolution, linkability: variant.linkability, rowValuesEmitted: false },
    };
  }
  const variantRows = materializeRows(referenceRows, variant.transform);
  const variantProspectiveRows = prospectiveRows(variantRows, scope.cutoffMs, scope.asOfMs);
  const referencePrimary = primaryMetrics(stripInternal(prospectiveReferenceRows), scope.datasetScope);
  const candidatePrimary = primaryMetrics(stripInternal(variantProspectiveRows), scope.datasetScope);
  const referenceCardinality = summarizeCardinality(referenceRows, family, family.variants[0]);
  const privacyCardinality = summarizeCardinality(variantRows, family, variant);
  const gates = hardGates(referenceRows, variantRows, referenceCardinality, privacyCardinality, prospectiveReferenceRows, variantProspectiveRows);
  const primaryComparison = comparablePrimary(referencePrimary, candidatePrimary);
  const referenceSecondary = gradientDiagnostics(prospectiveReferenceRows);
  const secondary = {
    status: "available",
    gradients: gradientDiagnostics(variantProspectiveRows),
    scopeUsable: scopeSummary(variantProspectiveRows),
    staleResiduals: { status: "unavailable_under_transition_grain" },
    forkReplay: { status: "unavailable_under_transition_grain" },
    modelRegimeAndFastSensitivity: { status: "unavailable_under_transition_grain" },
    providerCrosscheck: { status: "unavailable_under_transition_grain" },
    independentUtility: independentSecondaryUtility(referenceSecondary, gradientDiagnostics(variantProspectiveRows), fixtureHashes),
  };
  const gatesPass = gates.every((gate) => gate.status === "pass");
  return {
    id: variant.id,
    detailRank: variant.detailRank,
    status: gatesPass && primaryComparison.pass ? "eligible" : "not_eligible",
    primary: publicPrimary(candidatePrimary),
    primaryComparison,
    secondary,
    hardGates: gates,
    privacyCardinality,
  };
}

function evaluateJointSelection(familyResults, referenceRows, prospectiveReferenceRows, scope, fixtureHashes, evidenceReady) {
  if (!evidenceReady) return {
    status: "not_evaluated_insufficient_evidence",
    selectedVariantIds: [],
    smallestAdditionalFieldSet: [],
  };
  const selected = familyResults.map((family) => family.decision.selectedVariantId).filter(Boolean);
  if (selected.length !== familyResults.length) return {
    status: "not_evaluated_missing_family_selection",
    selectedVariantIds: selected,
    smallestAdditionalFieldSet: [],
  };
  const variants = FIELD_FAMILIES.map((family) => family.variants.find((variant) => selected.includes(variant.id))).filter(Boolean);
  const combined = materializeRows(referenceRows, (row) => variants.reduce((current, variant) => variant.transform(current), row));
  const combinedProspective = prospectiveRows(combined, scope.cutoffMs, scope.asOfMs);
  const referencePrimary = primaryMetrics(stripInternal(prospectiveReferenceRows), scope.datasetScope);
  const candidatePrimary = primaryMetrics(stripInternal(combinedProspective), scope.datasetScope);
  const comparison = comparablePrimary(referencePrimary, candidatePrimary);
  const referenceCardinality = { distinctValueCount: referenceRows.length, fieldFamily: "joint", retained: true };
  const combinedCardinality = { distinctValueCount: combined.length, fieldFamily: "joint", retained: true, rowValuesEmitted: false, temporalResolution: "mixed", linkability: "mixed" };
  const gates = hardGates(referenceRows, combined, referenceCardinality, combinedCardinality, prospectiveReferenceRows, combinedProspective);
  const pass = comparison.pass && gates.every((gate) => gate.status === "pass");
  return {
    status: pass ? "selected_joint_set_passes" : "joint_set_failed",
    selectedVariantIds: selected,
    primary: publicPrimary(candidatePrimary),
    primaryComparison: comparison,
    hardGates: gates,
    smallestAdditionalFieldSet: pass ? [] : ["unresolved; do not retain additional fields without a new preregistered test"],
    fixtureCount: Object.keys(fixtureHashes ?? {}).length,
  };
}

/**
 * Evaluate the preregistered G1 minimization variants. The result deliberately
 * excludes event rows, exact times, reset keys, and pseudonyms; it is safe to
 * retain as a local receipt but not evidence of an identified provider limit.
 */
export function evaluateMinimizationAblation(dataset, {
  prospectiveAfter = "2026-07-24T00:00:00.000Z",
  asOf = dataset?.scope?.endAt ?? dataset?.materializedAt,
  fixtureHashes = {},
  inputSha256 = null,
} = {}) {
  assertSafeTransitionDataset(dataset);
  const cutoffMs = Date.parse(prospectiveAfter);
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(asOfMs)) throw new TypeError("Prospective cutoff and as-of time must be ISO timestamps");
  const referenceRows = materializeRows(dataset.transitions, (row) => row);
  const prospectiveReferenceRows = prospectiveRows(referenceRows, cutoffMs, asOfMs);
  const sourceScope = scopeSummary(prospectiveReferenceRows);
  const referencePrimary = primaryMetrics(stripInternal(prospectiveReferenceRows), dataset.scope ?? {});
  const prospectiveResetCount = referencePrimary.qualifyingResetCount;
  const evidenceReady = prospectiveResetCount >= MINIMUM_PROSPECTIVE_RESETS && sourceScope.usable && referencePrimary.status === "available";
  const scope = { cutoffMs, asOfMs, datasetScope: dataset.scope ?? {} };
  const families = FIELD_FAMILIES.map((family) => {
    const variants = family.variants.map((variant) => evaluateVariant({
      family, variant, referenceRows, prospectiveReferenceRows, scope, fixtureHashes,
    }));
    return {
      id: family.id,
      label: family.label,
      sourceAvailability: sourceAvailability(referenceRows, family) ? "available" : "unavailable",
      variants,
      decision: selectFamily(family, variants, evidenceReady),
    };
  });
  const jointSelection = evaluateJointSelection(families, referenceRows, prospectiveReferenceRows, scope, fixtureHashes, evidenceReady);
  const blockers = [];
  if (prospectiveResetCount < MINIMUM_PROSPECTIVE_RESETS) blockers.push("fewer_than_three_completed_prospective_reset_windows");
  if (!sourceScope.usable) blockers.push("participant_account_plan_scope_unavailable");
  if (referencePrimary.status !== "available") blockers.push("reference_primary_metric_unavailable");
  const receipt = {
    schemaVersion: MINIMIZATION_ABLATION_SCHEMA_VERSION,
    kind: "g1_data_minimization_ablation_receipt",
    input: {
      inputSha256: inputSha256 ?? sha256(stableJson(dataset)),
      sourceRecordCount: dataset.transitions.length,
      fixtureHashes: { ...fixtureHashes },
      recordsEmitted: false,
    },
    preregistration: {
      primaryMetric: "chronological later-displayed-quota-movement MAE from Standard API-price-equivalent usage",
      absoluteTolerancePp: PRIMARY_ABSOLUTE_TOLERANCE_PP,
      relativeToleranceFraction: PRIMARY_RELATIVE_TOLERANCE,
      relativeToleranceAppliesWhenReferenceMaeAtLeastPp: PRIMARY_ABSOLUTE_TOLERANCE_PP,
      minimumProspectiveResetWindows: MINIMUM_PROSPECTIVE_RESETS,
      prospectiveCutoffApplied: "configured_without_emitting_exact_source_times",
    },
    evidence: {
      prospectiveQualifyingResetCount: prospectiveResetCount,
      prospectiveScope: sourceScope,
      referencePrimary: publicPrimary(referencePrimary),
      status: evidenceReady ? "eligible_for_preregistered_selection" : "insufficient_evidence",
      blockers,
    },
    ablations: families,
    jointSelection,
    decision: {
      status: evidenceReady && jointSelection.status === "selected_joint_set_passes" ? "selection_complete" : "inconclusive",
      noPublicAggregate: !evidenceReady,
      fieldDecisions: families.map((family) => ({
        id: family.id,
        status: family.decision.status,
        disposition: family.decision.disposition,
        publicAggregatePermitted: family.decision.publicAggregatePermitted,
      })),
    },
    privacy: {
      exactSourceTimesEmitted: false,
      pseudonymsEmitted: false,
      rowDataEmitted: false,
      rawProviderIdentifiersEmitted: false,
    },
  };
  return { ...receipt, receiptSha256: sha256(stableJson(receipt)) };
}
