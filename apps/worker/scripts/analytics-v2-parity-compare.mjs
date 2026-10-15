#!/usr/bin/env node
// GCP fast-path parity compare (Q-2): the analytics_v2 GET
// /api/v1/community/daily response and stored admin preview against the Q-1
// production-code oracle golden (d43c8f92).
//
// Normalization is deliberately minimal. Only the publication-schedule
// fields differ by construction between the oracle and a fresh rehearsal
// schema: days[].revision, days[].releasedAt, payload.revision,
// payload.releasedAt and the `:r<revision>` suffix of payload.aggregateId.
// Everything else is compared exactly and every difference is reported per
// family:
//
//   envelope              schemaVersion, from, to, allowanceState, allowanceReadState
//   daily-days            which community days are published
//   daily-totals          payload.totals per day
//   daily-cells           payload.cells and cellsTruncated per day
//   spend                 payload.apiEquivalentSpend per day
//   daily-other           every other payload field per day
//   allowance-breakdowns  allowanceBreakdowns header and per-day combined/byPlanType
//   breakdowns-v13-metadata  the declared v1.3 relabel and model-metadata block
//                         (accepted: owner decision round 7, below)
//   model-days            allowanceBreakdowns days[].models and preview.models, on
//                         every date the oracle published
//   model-days-per-date   the fast path publishing a model date the oracle
//                         withheld (accepted: owner decision OD-12, below)
//   preview               the stored admin preview except preview.models
//   cache-structure       cacheRetention schema, method, measures, gap basis, window and band ids
//   cache-counts          cacheRetention counts (informational: the Q-1 manifest's
//                         parityBasis says counts are not a parity basis)
//
// A difference is "expected" only in three families:
// - cache-counts, by the oracle's own parityBasis;
// - breakdowns-v13-metadata, by the owner's decision of 2026-10-02 (round 7,
//   contract names round 9): GCP serves community-allowance-breakdowns-v1.3 at
//   cutover, which is d43c8f92's v1.1 plus a closed model-metadata block. A
//   served v1.3 block is accepted only when it is exactly the v1.1 envelope
//   relabelled with a trailing `modelConfig`, and that block equals the
//   declared catalog-baseline block (manifest_version 1): the committed
//   analytics-v2-test/fixtures/breakdowns-v13-declared-model-metadata.json,
//   which the analytics-v2 and PostgreSQL specs hold equal to
//   src/analytics-v2/public-allowance-breakdowns-v13.ts over
//   catalog/manifest-0001.json. It is then compared as the v1.1 block it
//   reduces to, so every other byte is still held to the oracle. A malformed
//   v1.3 block, or any other block, is unexpected. (Plain JavaScript and JSON
//   here: the rehearsal's origin child and the edge end-to-end suite run this
//   module under Node 22.16, which does not strip TypeScript.)
// - model-days-per-date, by the owner's decision of 2026-10-01 (fast-path plan
//   OD-12): the fast path publishes each model date on its own, with refused
//   owners excluded and counted, where d43c8f92 withholds a 14-date block until
//   every member has a result. Only the dates the golden manifest lists as
//   withheld (modelPublications.missing) qualify, and only as publication:
//   the oracle side must be unpublished (allowanceBreakdowns days[].models
//   empty, the date absent from preview.models.days) and the fast path may
//   fill exactly those two places. Every other model date stays in model-days
//   and must be byte-equal; a published date outside the withheld set, a
//   missing published date, or any other field difference is unexpected.
//   The VALUE published on an accepted date must equal the oracle's per-date
//   expectation (per-date-expected.json: d43c8f92's own publishers over its
//   per-owner references) exactly. Without that expectation, or where it
//   differs, the publication is an unexpected model-days difference: an
//   accepted date is never taken on its presence alone.
// Every other difference is reported as unexpected; the caller decides how to
// label it and must say so in its receipt.
//
// Two further declared differences are conditional on production state that
// no golden corpus holds, so they have no family here and a rehearsal over
// the Q-1 or dense corpus stays byte-equal (src/analytics-v2/exclusions.ts
// has the contract):
// - N-EXCL (round 5): an owner with an active community_weekly exclusion
//   covering day D is left out of D's public daily and allowance preview,
//   where d43c8f92 applies the exclusions to its weekly snapshot only.
//   It arises only while production holds an active exclusion row.
// - EXCL-UNLINKED (round 19, "the exclusion lifts it"): an eligible
//   participant with typed evidence and no active owner link blocks only the
//   days its active exclusions do not cover, where d43c8f92's daily cohort
//   refusal blocks every day. It arises only while such a participant exists
//   and an active row covers one of the compared days.
// A corpus that holds either condition must label the resulting differences
// in its receipt; this compare does not accept them.
//
// CLI: node scripts/analytics-v2-parity-compare.mjs --golden <dir> --actual <response.json>
//        [--actual-preview <preview.json>] [--per-date-expected <per-date-expected.json>]
// The withheld dates are read from <dir>/manifest.json when it exists. The
// per-date expectation must be for the golden's clock (nowMs). Prints one JSON
// report; exits 0 when there is no unexpected difference, 1 otherwise, 2 on a
// usage error. Inputs are synthetic and content-free.
//
// Current qualification is a separate mode, with no historical waivers:
//   --comparison-mode current-worker-d1 --current-reference <reference.json>
//   --current-reference-binding <binding.json> --actual <response.json>
//   --current-reference-sha256 <accepted-json-stringify-sha256> --actual-preview <preview.json>
// Its binding is captured independently from the candidate source/runtime and
// immutable corpus before the reference runs. The reference digest comes from
// the accepted D1 producer receipt, before any PG read; it is never inferred
// from the supplied file by this comparator. It hashes UTF-8 JSON.stringify
// bytes in producer key order, not a key-sorted encoding. A partial reference
// cannot pass. Its v2 evidence describes corpus-specific convergence, actual
// strict export refusal, and actual current recomputation separately. Expected
// conflict queues never become a quiescent whole-export claim.
// This saved-file CLI checks preservation and equality against caller-supplied
// accepted evidence; it cannot establish that a native D1 execution occurred.
// The qualification controller separately enforces its preserved producer receipt.

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  assessCurrentQ1ReferenceCompleteness,
  validateCurrentQ1ReferenceBinding,
} from "../postgres-test/fixtures/current-q1-d1-reference.mjs";

export const ANALYTICS_V2_PARITY_REPORT_VERSION = "analytics-v2-parity-report-v4";
export const ANALYTICS_V2_CURRENT_CONTRACT_REPORT_VERSION = "analytics-v2-current-contract-report-v2";
export const ANALYTICS_V2_PARITY_FAMILIES = Object.freeze([
  "envelope", "daily-days", "daily-totals", "daily-cells", "spend", "daily-other",
  "allowance-breakdowns", "breakdowns-v13-metadata", "model-days", "model-days-per-date", "preview",
  "cache-structure", "cache-counts",
]);
const EXPECTED_FAMILIES = new Set(["cache-counts", "model-days-per-date", "breakdowns-v13-metadata"]);
/** The owner decision that makes breakdowns-v13-metadata expected. */
export const ANALYTICS_V2_BREAKDOWNS_V13_DECISION =
  "Round 7 and round 9, 2026-10-02: breakdowns v1.3 (d43c8f92 v1.1 plus model metadata) at cutover, a declared difference";
const WORKER_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const V13_SCHEMA_VERSION = "community-allowance-breakdowns-v1.3";
const V11_SCHEMA_VERSION = "community-allowance-breakdowns-v1.1";
/** The v1.1 envelope in the vendored projection's key order; v1.3 appends modelConfig. */
const V11_KEYS = Object.freeze(["schemaVersion", "basis", "referencePlanType", "normalization", "modelBasis",
  "modelGate", "generatedAt", "days"]);
/**
 * The declared block: the catalog baseline's (manifest_version 1) public
 * roster as committed, never re-derived from the code under test.
 */
export const ANALYTICS_V2_DECLARED_MODEL_METADATA = Object.freeze(JSON.parse(readFileSync(
  join(WORKER_ROOT, "analytics-v2-test/fixtures/breakdowns-v13-declared-model-metadata.json"), "utf8")));
/** The owner decision that makes model-days-per-date expected (fast-path plan OD-12). */
export const ANALYTICS_V2_PER_DATE_MODEL_DECISION =
  "OD-12, 2026-10-01: per-date model publication with refused owners excluded and counted";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
/** The oracle's per-date expectation (scripts/gcp-fastpath-dense-oracle/oracle.mjs). */
const PER_DATE_SCHEMA_VERSION = "gcp-fastpath-dense-per-date-v1";
const MAX_LISTED_DIFFS = 40;
const AGGREGATE_REVISION_SUFFIX = /:r[1-9][0-9]*$/u;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A served allowanceBreakdowns block with the declared v1.3 difference undone.
 * `served` says whether the block claims v1.3; `valid` whether it is exactly
 * the declared shape; `metadataEqual` whether its block is the declared one
 * (null when it is not v1.3). `base` is what the oracle is compared with: the
 * reduced v1.1 block when valid, else the block unchanged.
 */
export function declaredBreakdownsV13(value, declaredModelMetadata = ANALYTICS_V2_DECLARED_MODEL_METADATA) {
  if (!isObject(value) || value.schemaVersion !== V13_SCHEMA_VERSION) {
    return { base: value, served: false, valid: true, metadataEqual: null, metadata: null };
  }
  const keys = Object.keys(value);
  const expectedKeys = [...V11_KEYS, "modelConfig"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
      || !Array.isArray(value.modelConfig)) {
    return { base: value, served: true, valid: false, metadataEqual: false, metadata: null };
  }
  const { modelConfig, ...rest } = value;
  // Entry key order is part of the declared bytes, so it is compared too.
  const entryKeys = (block) => (Array.isArray(block) ? block : []).map((entry) => (isObject(entry) ? Object.keys(entry) : null));
  const metadataEqual = Array.isArray(declaredModelMetadata)
    && diffValues(declaredModelMetadata, modelConfig).length === 0
    && JSON.stringify(entryKeys(declaredModelMetadata)) === JSON.stringify(entryKeys(modelConfig));
  return {
    base: { ...rest, schemaVersion: V11_SCHEMA_VERSION }, served: true, valid: true,
    metadata: modelConfig, metadataEqual,
  };
}

/** Drop only the publication-schedule fields from one served day. */
export function normalizeServedDay(entry) {
  if (!isObject(entry)) return entry;
  const { revision: _revision, releasedAt: _releasedAt, payload, ...rest } = entry;
  if (!isObject(payload)) return { ...rest, payload };
  const { revision: _payloadRevision, releasedAt: _payloadReleasedAt, aggregateId, ...payloadRest } = payload;
  return {
    ...rest,
    payload: {
      ...payloadRest,
      ...(typeof aggregateId === "string" ? { aggregateId: aggregateId.replace(AGGREGATE_REVISION_SUFFIX, "") } : {}),
    },
  };
}

/** Structural diff: a list of {path, golden, actual} leaves. */
export function diffValues(golden, actual, path = "$", out = []) {
  if (Object.is(golden, actual)) return out;
  if (Array.isArray(golden) && Array.isArray(actual)) {
    const length = Math.max(golden.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= golden.length) out.push({ path: `${path}[${index}]`, golden: undefined, actual: actual[index] });
      else if (index >= actual.length) out.push({ path: `${path}[${index}]`, golden: golden[index], actual: undefined });
      else diffValues(golden[index], actual[index], `${path}[${index}]`, out);
    }
    return out;
  }
  if (isObject(golden) && isObject(actual)) {
    const keys = [...new Set([...Object.keys(golden), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      if (!Object.hasOwn(actual, key)) out.push({ path: `${path}.${key}`, golden: golden[key], actual: undefined });
      else if (!Object.hasOwn(golden, key)) out.push({ path: `${path}.${key}`, golden: undefined, actual: actual[key] });
      else diffValues(golden[key], actual[key], `${path}.${key}`, out);
    }
    return out;
  }
  out.push({ path, golden, actual });
  return out;
}

function brief(value) {
  if (value === undefined) return "<absent>";
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function family(name) {
  return { family: name, expected: EXPECTED_FAMILIES.has(name), compared: 0, equal: 0, diffCount: 0, diffs: [] };
}

function record(target, key, golden, actual) {
  target.compared += 1;
  const diffs = diffValues(golden, actual, key);
  if (diffs.length === 0) {
    target.equal += 1;
    return;
  }
  target.diffCount += diffs.length;
  for (const diff of diffs) {
    if (target.diffs.length >= MAX_LISTED_DIFFS) break;
    target.diffs.push({ path: diff.path, golden: brief(diff.golden), actual: brief(diff.actual) });
  }
}

function byDay(entries) {
  const map = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (isObject(entry) && typeof entry.day === "string") map.set(entry.day, entry);
  }
  return map;
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => isObject(object) && Object.hasOwn(object, key))
    .map((key) => [key, object[key]]));
}

function omit(object, keys) {
  if (!isObject(object)) return object;
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

function cacheStructure(cache) {
  if (!isObject(cache)) return cache ?? null;
  return {
    ...pick(cache, ["schemaVersion", "metric", "methodVersion", "measures", "gapBasis"]),
    windows: (Array.isArray(cache.windows) ? cache.windows : []).map((window) => ({
      window: window?.window,
      days: window?.days,
      bands: (Array.isArray(window?.bands) ? window.bands : []).map((band) => ({
        band: band?.band, startMs: band?.startMs, endMs: band?.endMs,
      })),
    })),
  };
}

/** The golden manifest's withheld model dates, validated: sorted, unique YYYY-MM-DD strings. */
export function withheldModelDatesOf(manifest) {
  const missing = manifest?.modelPublications?.missing;
  if (missing === undefined) return [];
  if (!Array.isArray(missing) || missing.some((day) => typeof day !== "string" || !DAY_PATTERN.test(day))
      || new Set(missing).size !== missing.length) {
    throw new TypeError("ANALYTICS_V2_PARITY_WITHHELD_DATES_INVALID");
  }
  return [...missing].sort();
}

/**
 * A per-date expectation checked against the golden it stands beside: the
 * oracle's per-date schema, the golden's clock, and no unresolved date.
 * Throws ANALYTICS_V2_PARITY_PER_DATE_INVALID otherwise.
 */
export function perDateExpectationFor(expectation, manifest) {
  if (!isObject(expectation) || expectation.schemaVersion !== PER_DATE_SCHEMA_VERSION
      || !Number.isSafeInteger(expectation.nowMs) || expectation.nowMs !== manifest?.nowMs
      || !Array.isArray(expectation.unresolved) || expectation.unresolved.length !== 0) {
    throw new TypeError("ANALYTICS_V2_PARITY_PER_DATE_INVALID");
  }
  return expectation;
}

const UNVERIFIED = "<withheld; no per-date expectation>";

/**
 * The per-date expectation's value at one place, or undefined when the
 * expectation does not hold that date (absent, or no expectation at all).
 */
function expectedOn(entries, day, field) {
  if (!Array.isArray(entries)) return undefined;
  const entry = entries.find((value) => isObject(value) && value.day === day);
  if (entry === undefined) return undefined;
  return field === null ? entry : entry[field];
}

/**
 * One fast-path publication of a withheld model date. It is the accepted
 * per-date difference (model-days-per-date) only when its value equals the
 * per-date expectation exactly; otherwise it is an unexpected model-days
 * difference.
 */
function acceptPerDate(families, published, unverified, key, day, actual, expected) {
  if (expected === undefined) {
    const target = families["model-days"];
    target.compared += 1;
    target.diffCount += 1;
    unverified.add(day);
    if (target.diffs.length < MAX_LISTED_DIFFS) target.diffs.push({ path: key, golden: UNVERIFIED, actual: brief(actual) });
    return;
  }
  if (diffValues(expected, actual, key).length > 0) {
    record(families["model-days"], key, expected, actual);
    return;
  }
  const target = families["model-days-per-date"];
  target.compared += 1;
  target.diffCount += 1;
  published.add(day);
  if (target.diffs.length < MAX_LISTED_DIFFS) target.diffs.push({ path: key, golden: "<withheld>", actual: brief(actual) });
}

/**
 * Compare one served response (and optionally the stored preview) with the
 * golden. Returns a content-free report: counts, field paths and the leaf
 * values of synthetic aggregates only. `withheldModelDates` are the model
 * dates the golden withheld (manifest modelPublications.missing); only those
 * may be published by the fast path, and only with the value
 * `perDateExpected` (the oracle's per-date-expected.json) holds for them (see
 * the header).
 */
export function compareAnalyticsV2Parity({
  golden, actual, goldenPreview = null, actualPreview = null, withheldModelDates = [], perDateExpected = null,
  declaredModelMetadata = ANALYTICS_V2_DECLARED_MODEL_METADATA,
}) {
  const withheld = new Set(withheldModelDatesOf({ modelPublications: { missing: withheldModelDates } }));
  if (perDateExpected !== null && !isObject(perDateExpected)) throw new TypeError("ANALYTICS_V2_PARITY_PER_DATE_INVALID");
  const publishedWithheld = new Set();
  const unverifiedWithheld = new Set();
  const families = Object.fromEntries(ANALYTICS_V2_PARITY_FAMILIES.map((name) => [name, family(name)]));
  const envelopeKeys = ["schemaVersion", "from", "to", "allowanceState", "allowanceReadState"];
  record(families.envelope, "$", pick(golden, envelopeKeys), pick(actual, envelopeKeys));

  const goldenDays = byDay(golden?.days);
  const actualDays = byDay(actual?.days);
  const allDays = [...new Set([...goldenDays.keys(), ...actualDays.keys()])].sort();
  const missing = allDays.filter((day) => goldenDays.has(day) && !actualDays.has(day));
  const extra = allDays.filter((day) => !goldenDays.has(day) && actualDays.has(day));
  record(families["daily-days"], "$.days[*].day", [...goldenDays.keys()].sort(), [...actualDays.keys()].sort());
  for (const day of allDays.filter((value) => goldenDays.has(value) && actualDays.has(value))) {
    const g = normalizeServedDay(goldenDays.get(day));
    const a = normalizeServedDay(actualDays.get(day));
    record(families["daily-totals"], `$.days[${day}].payload.totals`, g.payload?.totals, a.payload?.totals);
    record(families["daily-cells"], `$.days[${day}].payload.cells`,
      pick(g.payload, ["cells", "cellsTruncated"]), pick(a.payload, ["cells", "cellsTruncated"]));
    record(families.spend, `$.days[${day}].payload.apiEquivalentSpend`,
      g.payload?.apiEquivalentSpend, a.payload?.apiEquivalentSpend);
    const otherKeys = ["totals", "cells", "cellsTruncated", "apiEquivalentSpend"];
    record(families["daily-other"], `$.days[${day}]`,
      { ...omit(g, ["payload"]), payload: omit(g.payload, otherKeys) },
      { ...omit(a, ["payload"]), payload: omit(a.payload, otherKeys) });
  }

  const gAllowance = golden?.allowanceBreakdowns;
  // The declared v1.3 difference is accepted only in its exact shape and with
  // the declared block; the reduced v1.1 block is then held to the oracle.
  const declared = declaredBreakdownsV13(actual?.allowanceBreakdowns, declaredModelMetadata);
  const aAllowance = declared.base;
  if (declared.served) {
    const target = families["breakdowns-v13-metadata"];
    if (!declared.valid) {
      record(families["allowance-breakdowns"], "$.allowanceBreakdowns", "<declared v1.3 shape>",
        "<not the v1.1 envelope plus a trailing valid modelConfig>");
    } else if (!declared.metadataEqual) {
      record(families["allowance-breakdowns"], "$.allowanceBreakdowns.modelConfig", declaredModelMetadata,
        declared.metadata);
    } else {
      target.compared += 1;
      target.diffCount += 2;
      target.diffs.push(
        { path: "$.allowanceBreakdowns.schemaVersion", golden: brief(gAllowance?.schemaVersion),
          actual: brief(V13_SCHEMA_VERSION) },
        { path: "$.allowanceBreakdowns.modelConfig", golden: brief(undefined),
          actual: `<declared manifest_version 1 block: ${declaredModelMetadata.length} entries>` },
      );
    }
  }
  record(families["allowance-breakdowns"], "$.allowanceBreakdowns", omit(gAllowance, ["days"]),
    omit(aAllowance, ["days"]));
  const gAllowanceDays = byDay(gAllowance?.days);
  const aAllowanceDays = byDay(aAllowance?.days);
  record(families["allowance-breakdowns"], "$.allowanceBreakdowns.days[*].day",
    [...gAllowanceDays.keys()].sort(), [...aAllowanceDays.keys()].sort());
  for (const day of [...gAllowanceDays.keys()].filter((value) => aAllowanceDays.has(value)).sort()) {
    record(families["allowance-breakdowns"], `$.allowanceBreakdowns.days[${day}]`,
      omit(gAllowanceDays.get(day), ["models"]), omit(aAllowanceDays.get(day), ["models"]));
    const key = `$.allowanceBreakdowns.days[${day}].models`;
    const gModels = gAllowanceDays.get(day)?.models;
    const aModels = aAllowanceDays.get(day)?.models;
    // A withheld date: the oracle serves no model values; the fast path may.
    if (withheld.has(day) && Array.isArray(gModels) && gModels.length === 0
        && Array.isArray(aModels) && aModels.length > 0) {
      acceptPerDate(families, publishedWithheld, unverifiedWithheld, key, day, aModels,
        expectedOn(perDateExpected?.allowanceBreakdowns?.days, day, "models"));
    } else {
      record(families["model-days"], key, gModels, aModels);
    }
  }

  if (goldenPreview !== null || actualPreview !== null) {
    record(families.preview, "preview", omit(goldenPreview, ["models"]), omit(actualPreview, ["models"]));
    const gModels = goldenPreview?.models;
    const aModels = actualPreview?.models;
    record(families["model-days"], "preview.models", omit(gModels, ["days"]), omit(aModels, ["days"]));
    const gModelDays = byDay(gModels?.days);
    const aModelDays = byDay(aModels?.days);
    // A withheld date the oracle's preview omits may be present in the fast
    // path's; every other date must appear in both or neither.
    const accepted = [...aModelDays.keys()].filter((day) => withheld.has(day) && !gModelDays.has(day)).sort();
    record(families["model-days"], "preview.models.days[*].day",
      [...gModelDays.keys()].sort(), [...aModelDays.keys()].filter((day) => !accepted.includes(day)).sort());
    for (const day of [...gModelDays.keys()].filter((value) => aModelDays.has(value)).sort()) {
      record(families["model-days"], `preview.models.days[${day}]`, gModelDays.get(day), aModelDays.get(day));
    }
    for (const day of accepted) {
      acceptPerDate(families, publishedWithheld, unverifiedWithheld, `preview.models.days[${day}]`, day,
        aModelDays.get(day), expectedOn(perDateExpected?.preview?.models?.days, day, null));
    }
  }

  record(families["cache-structure"], "$.cacheRetention",
    cacheStructure(golden?.cacheRetention), cacheStructure(actual?.cacheRetention));
  record(families["cache-counts"], "$.cacheRetention", golden?.cacheRetention ?? null,
    actual?.cacheRetention ?? null);

  const list = ANALYTICS_V2_PARITY_FAMILIES.map((name) => families[name]);
  const unexpected = list.filter((entry) => !entry.expected && entry.diffCount > 0);
  return Object.freeze({
    schemaVersion: ANALYTICS_V2_PARITY_REPORT_VERSION,
    normalized: ["days[].revision", "days[].releasedAt", "payload.revision", "payload.releasedAt",
      "payload.aggregateId :r<revision> suffix"],
    days: { golden: goldenDays.size, actual: actualDays.size, missingInActual: missing, extraInActual: extra },
    perDateModelPublication: {
      decision: ANALYTICS_V2_PER_DATE_MODEL_DECISION,
      withheldDates: withheld.size,
      valuesHeldTo: perDateExpected === null ? null : (perDateExpected.schemaVersion ?? "per-date expectation"),
      publishedWithheldDates: [...publishedWithheld].sort(),
      unverifiedWithheldDates: [...unverifiedWithheld].sort(),
    },
    breakdownsV13: {
      decision: ANALYTICS_V2_BREAKDOWNS_V13_DECISION,
      served: declared.served,
      accepted: declared.served && declared.valid && declared.metadataEqual === true,
      declaredEntries: declaredModelMetadata.length,
    },
    unexpectedFamilies: unexpected.map((entry) => entry.family),
    unexpectedDiffs: unexpected.reduce((sum, entry) => sum + entry.diffCount, 0),
    families: list,
  });
}

function usageFail(message) {
  process.stderr.write(`${JSON.stringify({ status: "error", code: "PARITY_COMPARE_USAGE", message })}\n`);
  process.exit(2);
}

/** Scheduling may vary only when it is an internally consistent publication.
 * Missing or malformed scheduling evidence is not removed before comparison. */
function normalizeCurrentResponse(value) {
  if (!isObject(value) || !Array.isArray(value.days)) {
    throw new TypeError("ANALYTICS_V2_CURRENT_SCHEDULE_INVALID");
  }
  const days = value.days.map((entry) => {
    const payload = entry?.payload;
    const releasedAt = entry?.releasedAt;
    const epoch = typeof releasedAt === "string" ? Date.parse(releasedAt) : NaN;
    if (!isObject(entry) || !DAY_PATTERN.test(entry.day) || !isObject(payload)
        || !Number.isSafeInteger(entry.revision) || entry.revision < 1
        || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== releasedAt
        || payload.day !== entry.day || payload.revision !== entry.revision
        || payload.releasedAt !== releasedAt
        || payload.aggregateId !== `community-daily:${entry.day}:r${entry.revision}`) {
      throw new TypeError("ANALYTICS_V2_CURRENT_SCHEDULE_INVALID");
    }
    return normalizeServedDay(entry);
  });
  return { ...value, days };
}

/** Current Worker/D1 qualification has no historical difference waivers.
 * Its independently captured binding and complete reference are mandatory;
 * expected values are never reconstructed from the actual PG output. The
 * producer controller owns native execution and accepted-receipt enforcement;
 * this pure function checks the supplied accepted evidence and DTO equality. */
export function compareAnalyticsV2CurrentContract({ reference, referenceBinding, referenceSha256, actual, actualPreview }) {
  let measured;
  try { measured = createHash("sha256").update(JSON.stringify(reference) ?? "").digest("hex"); } catch {
    throw new TypeError("ANALYTICS_V2_CURRENT_REFERENCE_DIGEST_MISMATCH");
  }
  if (typeof referenceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(referenceSha256) || measured !== referenceSha256) {
    throw new TypeError("ANALYTICS_V2_CURRENT_REFERENCE_DIGEST_MISMATCH");
  }
  validateCurrentQ1ReferenceBinding({ reference, expected: referenceBinding });
  const completeness = assessCurrentQ1ReferenceCompleteness({
    reference, corpus: referenceBinding.corpusStructure,
    snapshotReadiness: {
      afterForcedRecompute: reference?.afterForcedRecompute?.readiness,
      afterNativeProbes: reference?.afterNativeProbes?.readiness,
    },
  });
  if (reference?.qualification !== "complete" || completeness.state !== "complete") {
    throw new TypeError("ANALYTICS_V2_CURRENT_REFERENCE_INCOMPLETE");
  }
  const expected = reference.afterNativeProbes;
  const publicResponse = family("public-response");
  const adminPreview = family("admin-preview");
  record(publicResponse, "$", normalizeCurrentResponse(expected.publicResponse.body), normalizeCurrentResponse(actual));
  record(adminPreview, "preview", expected.adminPreview, actualPreview);
  const families = [publicResponse, adminPreview];
  const unexpectedDiffs = families.reduce((sum, entry) => sum + entry.diffCount, 0);
  return Object.freeze({
    schemaVersion: ANALYTICS_V2_CURRENT_CONTRACT_REPORT_VERSION,
    comparisonMode: "current-worker-d1",
    evidenceScope: "reference-comparison-only",
    establishesNativeExecution: false,
    referenceQualification: "complete",
    referenceBound: true,
    referenceComplete: true,
    recomputationComplete: true,
    corpusConvergenceComplete: true,
    strictExportRefusalVerified: true,
    recomputationSha256: createHash("sha256").update(JSON.stringify(reference.recomputation)).digest("hex"),
    corpusConvergenceSha256: createHash("sha256").update(JSON.stringify(reference.corpusConvergence)).digest("hex"),
    strictExportRefusalSha256: createHash("sha256").update(JSON.stringify(reference.strictExportRefusal)).digest("hex"),
    referenceSha256,
    reference: {
      schemaVersion: reference.schemaVersion,
      sourceHead: referenceBinding.source.head,
      sourceSha256: referenceBinding.source.sha256,
      migrationSha256: referenceBinding.migrationSha256,
      corpusSha256: referenceBinding.corpus.canonicalSha256,
      runtime: referenceBinding.runtime,
    },
    normalized: ["days[].revision", "days[].releasedAt", "payload.revision", "payload.releasedAt",
      "payload.aggregateId :r<revision> suffix"],
    equal: unexpectedDiffs === 0,
    unexpectedDiffs,
    unexpectedFamilies: families.filter((entry) => entry.diffCount > 0).map((entry) => entry.family),
    families,
  });
}

/** Closed CLI grammar. An omitted mode retains the historical comparison. */
export function parseAnalyticsV2ParityCompareArgs(argv) {
  const flags = new Set(["--comparison-mode", "--golden", "--actual", "--actual-preview", "--per-date-expected",
    "--current-reference", "--current-reference-binding", "--current-reference-sha256"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!flags.has(flag) || Object.hasOwn(values, flag) || typeof value !== "string" || value.length === 0
        || value.startsWith("--")) throw new TypeError("ANALYTICS_V2_PARITY_ARGUMENTS_INVALID");
    values[flag] = value;
  }
  const mode = values["--comparison-mode"] ?? "historical";
  if (!["historical", "current-worker-d1"].includes(mode)) {
    throw new TypeError("ANALYTICS_V2_PARITY_ARGUMENTS_INVALID");
  }
  const current = mode === "current-worker-d1";
  const required = current ? ["--current-reference", "--current-reference-binding", "--current-reference-sha256",
    "--actual", "--actual-preview"]
    : ["--golden", "--actual"];
  const incompatible = current ? ["--golden", "--per-date-expected"]
    : ["--current-reference", "--current-reference-binding", "--current-reference-sha256"];
  if (required.some((flag) => !Object.hasOwn(values, flag))
      || incompatible.some((flag) => Object.hasOwn(values, flag))) {
    throw new TypeError("ANALYTICS_V2_PARITY_ARGUMENTS_INVALID");
  }
  return { mode, values };
}

async function main(argv) {
  let parsed;
  try { parsed = parseAnalyticsV2ParityCompareArgs(argv); } catch { usageFail("ANALYTICS_V2_PARITY_ARGUMENTS_INVALID"); }
  const value = (flag) => parsed.values[flag];
  const read = async (path) => JSON.parse(await readFile(resolve(path), "utf8"));
  if (parsed.mode === "current-worker-d1") {
    let report;
    try {
      report = compareAnalyticsV2CurrentContract({
        reference: await read(value("--current-reference")),
        referenceBinding: await read(value("--current-reference-binding")),
        referenceSha256: value("--current-reference-sha256"),
        actual: await read(value("--actual")), actualPreview: await read(value("--actual-preview")),
      });
    } catch (error) {
      const closed = new Set(["CURRENT_Q1_REFERENCE_BINDING_INVALID", "ANALYTICS_V2_CURRENT_REFERENCE_INCOMPLETE",
        "ANALYTICS_V2_CURRENT_SCHEDULE_INVALID", "ANALYTICS_V2_CURRENT_REFERENCE_DIGEST_MISMATCH"]);
      usageFail(closed.has(error?.message) ? error.message : "ANALYTICS_V2_CURRENT_INPUT_INVALID");
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.equal ? 0 : 1;
    return;
  }
  const goldenDirectory = value("--golden");
  const actualPath = value("--actual");
  const actualPreviewPath = value("--actual-preview");
  const perDatePath = value("--per-date-expected");
  const manifestPath = join(goldenDirectory, "manifest.json");
  const manifest = existsSync(resolve(manifestPath)) ? await read(manifestPath) : null;
  let perDateExpected = null;
  if (perDatePath) {
    try { perDateExpected = perDateExpectationFor(await read(perDatePath), manifest); } catch (error) {
      usageFail(String(error?.message ?? error));
    }
  }
  const report = compareAnalyticsV2Parity({
    golden: await read(join(goldenDirectory, "community-daily-response.json")),
    actual: await read(actualPath),
    goldenPreview: await read(join(goldenDirectory, "preview.json")),
    actualPreview: actualPreviewPath ? await read(actualPreviewPath) : null,
    withheldModelDates: manifest === null ? [] : withheldModelDatesOf(manifest),
    perDateExpected,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.unexpectedDiffs === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
