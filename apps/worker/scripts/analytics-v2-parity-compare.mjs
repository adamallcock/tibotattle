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
//   model-days            allowanceBreakdowns days[].models and preview.models, on
//                         every date the oracle published
//   model-days-per-date   the fast path publishing a model date the oracle
//                         withheld (accepted: owner decision OD-12, below)
//   preview               the stored admin preview except preview.models
//   cache-structure       cacheRetention schema, method, measures, gap basis, window and band ids
//   cache-counts          cacheRetention counts (informational: the Q-1 manifest's
//                         parityBasis says counts are not a parity basis)
//
// A difference is "expected" only in two families:
// - cache-counts, by the oracle's own parityBasis;
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
// CLI: node scripts/analytics-v2-parity-compare.mjs --golden <dir> --actual <response.json>
//        [--actual-preview <preview.json>] [--per-date-expected <per-date-expected.json>]
// The withheld dates are read from <dir>/manifest.json when it exists. The
// per-date expectation must be for the golden's clock (nowMs). Prints one JSON
// report; exits 0 when there is no unexpected difference, 1 otherwise, 2 on a
// usage error. Inputs are synthetic and content-free.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ANALYTICS_V2_PARITY_REPORT_VERSION = "analytics-v2-parity-report-v3";
export const ANALYTICS_V2_PARITY_FAMILIES = Object.freeze([
  "envelope", "daily-days", "daily-totals", "daily-cells", "spend", "daily-other",
  "allowance-breakdowns", "model-days", "model-days-per-date", "preview", "cache-structure", "cache-counts",
]);
const EXPECTED_FAMILIES = new Set(["cache-counts", "model-days-per-date"]);
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
  const aAllowance = actual?.allowanceBreakdowns;
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
    unexpectedFamilies: unexpected.map((entry) => entry.family),
    unexpectedDiffs: unexpected.reduce((sum, entry) => sum + entry.diffCount, 0),
    families: list,
  });
}

function usageFail(message) {
  process.stderr.write(`${JSON.stringify({ status: "error", code: "PARITY_COMPARE_USAGE", message })}\n`);
  process.exit(2);
}

async function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const goldenDirectory = value("--golden");
  const actualPath = value("--actual");
  if (!goldenDirectory || !actualPath) usageFail("--golden <dir> and --actual <response.json> are required");
  const read = async (path) => JSON.parse(await readFile(resolve(path), "utf8"));
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
