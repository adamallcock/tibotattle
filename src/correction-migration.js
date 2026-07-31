import { createHash } from "node:crypto";
import {
  createCorrection,
  digestDerivedValue,
  extractObservationDerived,
  resolveCorrections,
} from "./corrections.js";
import { stableJson } from "./export/index.js";

const BASELINE_MIGRATION_CREATED_AT = "2026-07-23T21:07:40.000Z";
const EXPECTED_REPLAYED_UNKNOWN_TOKENS = 71_060_499;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sumComponents(components) {
  return Object.values(components ?? {}).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function aggregateModelComponents(byModel) {
  const result = {};
  for (const model of Object.values(byModel ?? {})) {
    for (const [name, value] of Object.entries(model.components ?? {})) {
      result[name] = (result[name] ?? 0) + value;
    }
  }
  return result;
}

function sameComponents(left, right) {
  const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
  return [...keys].every((key) => (left?.[key] ?? 0) === (right?.[key] ?? 0));
}

function correctionIdFor(observationId, originalDigest, replacementDigest) {
  return `correction_${sha256(stableJson({
    migration: "schema-0.1-fork-replay-dedup-v1",
    observationId,
    originalDigest,
    replacementDigest,
  })).slice(0, 24)}`;
}

function findBaseline(observations) {
  const candidates = observations.filter((observation) => {
    if (observation?.schemaVersion !== "0.1") return false;
    const derived = extractObservationDerived(observation);
    return sumComponents(derived.byModel?.unknown?.components) === EXPECTED_REPLAYED_UNKNOWN_TOKENS
      && derived.warnings.includes("unknown_model");
  });
  if (candidates.length !== 1) throw new Error(`Expected exactly one schema-0.1 replay baseline; found ${candidates.length}`);
  return candidates[0];
}

export function buildBaselineReplayCorrection({ observation, transitionDataset }) {
  const originalDerived = extractObservationDerived(observation);
  const unknown = originalDerived.byModel?.unknown;
  const replayedTokens = sumComponents(unknown?.components);
  if (replayedTokens !== EXPECTED_REPLAYED_UNKNOWN_TOKENS) {
    throw new Error(`Baseline replay bucket must contain ${EXPECTED_REPLAYED_UNKNOWN_TOKENS} tokens`);
  }
  if (!originalDerived.warnings.includes("unknown_model")) throw new Error("Baseline must carry the obsolete unknown_model warning");
  if (transitionDataset?.scope?.endAt !== observation.capturedAt) throw new Error("Transition scope must end at the baseline capture time");
  if (transitionDataset?.summary?.partiallyPricedEvents !== 0 || transitionDataset?.summary?.unpricedModels?.length !== 0) {
    throw new Error("Replay-safe transition source must be fully priced with no unknown models");
  }

  const correctedByModel = Object.fromEntries(Object.entries(originalDerived.byModel).filter(([model]) => model !== "unknown"));
  const correctedComponents = transitionDataset.summary.tokenComponentsByModel
    ? aggregateModelComponents(Object.fromEntries(Object.entries(transitionDataset.summary.tokenComponentsByModel).map(([model, components]) => [model, { components }])))
    : aggregateModelComponents(correctedByModel);
  const correctedTotal = sumComponents(correctedComponents);
  if (correctedTotal !== originalDerived.aggregateTokenTotal - replayedTokens) {
    throw new Error("Replay-safe component total does not reconcile to the legacy aggregate minus replayed tokens");
  }
  if (!sameComponents(correctedComponents, aggregateModelComponents(correctedByModel))) {
    throw new Error("Replay-safe transition components do not match the retained known-model aggregates");
  }

  const replacementDerived = {
    aggregateTokenTotal: correctedTotal,
    apiPricedCostUsd: originalDerived.apiPricedCostUsd,
    tokenComponents: correctedComponents,
    byModel: correctedByModel,
    warnings: [],
    diagnostics: {
      filesScanned: transitionDataset.summary.filesScanned,
      usageEvents: transitionDataset.summary.usageEvents,
      pricedEvents: transitionDataset.summary.pricedEvents,
      partiallyPricedEvents: transitionDataset.summary.partiallyPricedEvents,
      forkReplayEventsSkipped: transitionDataset.diagnostics.forkReplayEventsSkipped,
      malformedLines: transitionDataset.diagnostics.malformedLines,
      lineageParentsMissing: transitionDataset.diagnostics.lineageParentsMissing,
    },
    pricingBasis: "standard_openai_api_prices_not_codex_subscription_credits",
  };
  const originalValueDigest = digestDerivedValue(originalDerived);
  const replacementDigest = digestDerivedValue(replacementDerived);
  const correctionId = correctionIdFor(observation.observationId, originalValueDigest, replacementDigest);

  return createCorrection({
    correctionId,
    supersedesId: observation.observationId,
    reason: "Remove replayed fork-history usage that was previously attributed to an unknown model.",
    category: "lineage_replay_deduplication",
    createdAt: BASELINE_MIGRATION_CREATED_AT,
    methodVersions: {
      parser: "codex-transition-miner@0.3.0",
      estimator: transitionDataset.pricing.estimatorVersion,
      pricing: `standard-openai-api:${transitionDataset.pricing.selectedSource}`,
      lineage: "cumulative-snapshot-fork-replay-dedup@0.3.0",
    },
    originalValueDigest,
    replacementDerived,
    diagnostics: {
      targetRecordDigest: digestDerivedValue(observation),
      replacementDerivedDigest: replacementDigest,
      replayedForkHistoryTokensRemoved: replayedTokens,
      obsoleteUnknownModelEventsRemoved: unknown.events ?? null,
      obsoleteWarningsRemoved: ["unknown_model"],
      apiPricedCostChangeUsd: 0,
      providerQuotaFieldsChanged: false,
      officialDailyBucketsChanged: false,
      ccusageChanged: false,
      originalObservationRewritten: false,
    },
    sourceInputCoverage: {
      startAt: transitionDataset.scope.startAt,
      endAt: transitionDataset.scope.endAt,
      filesScanned: transitionDataset.summary.filesScanned,
      usageEvents: transitionDataset.summary.usageEvents,
      pricedEvents: transitionDataset.summary.pricedEvents,
      partiallyPricedEvents: transitionDataset.summary.partiallyPricedEvents,
      forkReplayEventsSkipped: transitionDataset.diagnostics.forkReplayEventsSkipped,
      lineageParentsMissing: transitionDataset.diagnostics.lineageParentsMissing,
      malformedLines: transitionDataset.diagnostics.malformedLines,
      transitionArtifactDigest: digestDerivedValue(transitionDataset),
      completeForFixedInterval: true,
    },
    operatorNote: "Aggregate-only replay correction; provider quota values, daily buckets, and linked ccusage evidence remain unchanged.",
  });
}

export function planBaselineCorrectionMigration({ observations, transitionDataset, existingCorrections = [] }) {
  const baseline = findBaseline(observations);
  const correction = buildBaselineReplayCorrection({ observation: baseline, transitionDataset });
  const matching = existingCorrections.filter((record) => record.correctionId === correction.correctionId);
  if (matching.some((record) => stableJson(record) !== stableJson(correction))) {
    throw new Error(`Existing correction ${correction.correctionId} differs from the deterministic migration record`);
  }
  const competing = existingCorrections.filter((record) => record.supersedesId === baseline.observationId
    && record.correctionId !== correction.correctionId);
  if (competing.length > 0) throw new Error("Existing correction branch conflicts with baseline migration");
  const recordsToAppend = matching.length === 0 ? [correction] : [];
  const allCorrections = matching.length === 0 ? [...existingCorrections, correction] : existingCorrections;
  const resolution = resolveCorrections({ originals: observations, corrections: allCorrections });
  if (resolution.errors.length > 0) throw new Error(`Correction resolution failed: ${resolution.errors.map((error) => error.code).join(", ")}`);
  return {
    baselineObservationId: baseline.observationId,
    correction,
    recordsToAppend,
    resolution,
  };
}

export {
  BASELINE_MIGRATION_CREATED_AT,
  EXPECTED_REPLAYED_UNKNOWN_TOKENS,
};
