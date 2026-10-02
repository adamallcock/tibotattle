#!/usr/bin/env node
// GCP fast-path owner-level parity compare: analytics_v2's stored per-owner
// outputs against a d43c8f92 production-code oracle's direct references
// (apps/worker/analytics-v2-test/golden-dense or golden-q1-node:
// owner-results.json and cache-reference.json, produced by
// scripts/gcp-fastpath-dense-oracle).
//
// Families, every comparison exact (objects compared with their keys sorted,
// arrays in order, numbers by value, no tolerance):
//
//   owner-fits         analytics_v2_owner_fits.fits against the reference fits
//                      for the oracle's today (production's
//                      selectCommunityAllowanceAnalysisFits of its native
//                      analysis)
//   owner-model-dates  analytics_v2_owner_model_dates.result against the
//                      reference composition for each of the 70 model dates.
//                      Only inputFingerprint is dropped from the reference: it
//                      is run-specific (it carries the source's global mutation
//                      epoch) and analytics_v2 never stores it
//   owner-days         analytics_v2_owner_day.daily against production's daily
//                      owner values (complete) for every owner-day the
//                      reference holds. An owner-day the reference lacks must
//                      be a day of the golden's crossed-day conflict, which
//                      production's daily lane never completes for any owner.
//                      There, the conflict owner's row must be its refusal;
//                      every other owner's stored value has no production
//                      reference and is NOT compared: the report lists those
//                      owner-days as uncomparedOwnerDays
//   owner-cache-days   analytics_v2_cache_bands against production's effective
//                      cache day build for every owner-day with usage: a built
//                      day's (model, effort, band) rows and their seven
//                      counters; a refused day has no bands
//   refusals           the run's refusal set. Every reference failure maps to
//                      a refusal of the same owner, day and family, and no
//                      other refusal exists: a failed model date -> family
//                      model; failed fits -> scalar; a refused cache day ->
//                      cache; the conflict owner's conflict days -> daily.
//                      Reasons are closed per family (REFUSAL_REASONS). Only
//                      a reference recorded as `failed` stands for a
//                      production failure: an absent, stalled or
//                      result_size_limit reference is no reference, and the
//                      input is refused as invalid
//
// Nothing is normalized beyond inputFingerprint. A difference in any family is
// unexpected. Inputs are synthetic and content-free; the report carries owner
// keys (a, b, ...), days, field paths and synthetic aggregate values only.
//
// CLI: node scripts/analytics-v2-owner-parity-compare.mjs --reference <golden dir>
//        --rows <owner-rows.json written by gcp-fastpath-rehearsal.mjs --out>
// Prints one JSON report; exits 0 when there is no unexpected difference, 1
// otherwise, 2 on a usage error.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ANALYTICS_V2_OWNER_PARITY_REPORT_VERSION = "analytics-v2-owner-parity-report-v2";
export const ANALYTICS_V2_OWNER_PARITY_FAMILIES = Object.freeze([
  "owner-fits", "owner-model-dates", "owner-days", "owner-cache-days", "refusals",
]);
const OWNER_RESULTS_VERSION = "gcp-fastpath-dense-owner-results-v1";
const CACHE_REFERENCE_VERSION = "gcp-fastpath-dense-cache-reference-v1";
const CACHE_METHOD = "cache-retention-v2";
const CACHE_LAYOUT = "effective";
export const ANALYTICS_V2_CACHE_COUNTERS = Object.freeze([
  "adjacencies", "reusedMoreThanHalf", "matchedOrExceeded", "unorderedTies", "excludedInsufficientEvidence",
  "excludedContextContracted", "sessions",
]);
/**
 * The analytics_v2 reasons a reference failure may map to, per family. The
 * production side states its own reason (STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE,
 * usage_row_refused, a conflict-blocked day); analytics_v2 names the kernel
 * refusal that stands in for it.
 */
export const REFUSAL_REASONS = Object.freeze({
  daily: Object.freeze(["source_conflict_or_order"]),
  scalar: Object.freeze(["incomplete_window", "source_conflict_or_order"]),
  model: Object.freeze(["incomplete_window", "source_conflict_or_order"]),
  cache: Object.freeze(["incomplete_cache_day", "incomplete_cache_lookback", "source_conflict_or_order"]),
});
const MAX_LISTED_DIFFS = 40;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

function invalid(what) {
  throw new TypeError(`ANALYTICS_V2_OWNER_PARITY_INPUT_INVALID:${what}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Canonical form for exact comparison: keys sorted, arrays in order. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function leafDiffs(expected, actual, path, out) {
  if (out.length >= MAX_LISTED_DIFFS) return out;
  if (Object.is(expected, actual)) return out;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
      leafDiffs(expected[index], actual[index], `${path}[${index}]`, out);
    }
    return out;
  }
  if (isObject(expected) && isObject(actual)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      leafDiffs(expected[key], actual[key], `${path}.${key}`, out);
    }
    return out;
  }
  const brief = (value) => (value === undefined ? "<absent>" : JSON.stringify(value).slice(0, 160));
  out.push({ path, expected: brief(expected), actual: brief(actual) });
  return out;
}

function family(name) {
  return { family: name, compared: 0, equal: 0, diffCount: 0, diffs: [] };
}

function record(target, key, expected, actual) {
  target.compared += 1;
  const left = JSON.stringify(canonical(expected));
  const right = JSON.stringify(canonical(actual));
  if (left === right) {
    target.equal += 1;
    return;
  }
  target.diffCount += 1;
  for (const diff of leafDiffs(canonical(expected), canonical(actual), key, [])) {
    if (target.diffs.length >= MAX_LISTED_DIFFS) break;
    target.diffs.push(diff);
  }
}

function note(target, key, message) {
  target.compared += 1;
  target.diffCount += 1;
  if (target.diffs.length < MAX_LISTED_DIFFS) target.diffs.push({ path: key, message });
}

function withoutFingerprint(result) {
  if (!isObject(result)) return result;
  const { inputFingerprint: _fingerprint, ...rest } = result;
  return rest;
}

function validRows(rows) {
  if (!isObject(rows)) invalid("rows");
  for (const key of ["fits", "modelDates", "ownerDays", "cacheBands", "refusals"]) {
    if (!Array.isArray(rows[key])) invalid(`rows.${key}`);
  }
  for (const row of [...rows.fits, ...rows.modelDates, ...rows.ownerDays, ...rows.cacheBands, ...rows.refusals]) {
    if (!isObject(row) || !DIGEST_PATTERN.test(row.ownerDigest ?? "")) invalid("rows.ownerDigest");
  }
  return rows;
}

/**
 * Read one rehearsal target's stored owner-level outputs: the latest complete
 * run's refusals and every owner row. Read-only; bigint counters become
 * numbers (they are far below 2^53 here, and a larger one fails closed).
 */
export async function readAnalyticsV2OwnerRows(pool, schema) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) invalid("schema");
  const table = (name) => `"${schema}"."${name}"`;
  const integer = (value) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) invalid("counter");
    return number;
  };
  const run = await pool.query(`SELECT run_id::text AS run_id, refusals FROM ${table("analytics_v2_runs")}
    WHERE state = 'complete' ORDER BY finished_at DESC, started_at DESC LIMIT 1`);
  if (run.rows.length !== 1) invalid("run");
  const fits = await pool.query(`SELECT owner_digest, to_char(as_of_day, 'YYYY-MM-DD') AS as_of_day, fits,
      run_id::text AS run_id FROM ${table("analytics_v2_owner_fits")} ORDER BY owner_digest`);
  const modelDates = await pool.query(`SELECT owner_digest, to_char(day, 'YYYY-MM-DD') AS day, result,
      run_id::text AS run_id FROM ${table("analytics_v2_owner_model_dates")} ORDER BY owner_digest, day`);
  const ownerDays = await pool.query(`SELECT owner_digest, to_char(day, 'YYYY-MM-DD') AS day, daily, refusal,
      run_id::text AS run_id FROM ${table("analytics_v2_owner_day")} ORDER BY owner_digest, day`);
  const cacheBands = await pool.query(`SELECT owner_digest, to_char(day, 'YYYY-MM-DD') AS day, model, effort, band,
      adjacencies, reused_more_than_half, matched_or_exceeded, unordered_ties, excluded_insufficient_evidence,
      excluded_context_contracted, sessions, run_id::text AS run_id
      FROM ${table("analytics_v2_cache_bands")} ORDER BY owner_digest, day, model, effort, band`);
  return {
    runId: run.rows[0].run_id,
    fits: fits.rows.map((row) => ({ ownerDigest: row.owner_digest, asOfDay: row.as_of_day, fits: row.fits,
      runId: row.run_id })),
    modelDates: modelDates.rows.map((row) => ({ ownerDigest: row.owner_digest, day: row.day, result: row.result,
      runId: row.run_id })),
    ownerDays: ownerDays.rows.map((row) => ({ ownerDigest: row.owner_digest, day: row.day, daily: row.daily,
      refusal: row.refusal, runId: row.run_id })),
    cacheBands: cacheBands.rows.map((row) => ({ ownerDigest: row.owner_digest, day: row.day, model: row.model,
      effort: row.effort, band: row.band, adjacencies: integer(row.adjacencies),
      reusedMoreThanHalf: integer(row.reused_more_than_half), matchedOrExceeded: integer(row.matched_or_exceeded),
      unorderedTies: integer(row.unordered_ties), excludedInsufficientEvidence: integer(row.excluded_insufficient_evidence),
      excludedContextContracted: integer(row.excluded_context_contracted), sessions: integer(row.sessions),
      runId: row.run_id })),
    refusals: (Array.isArray(run.rows[0].refusals) ? run.rows[0].refusals : []).map((refusal) => ({
      ownerDigest: refusal.ownerDigest, day: refusal.day ?? null, family: refusal.family, reason: refusal.reason })),
  };
}

function bandKey(row) {
  return `${row.model}\u0000${row.effort}\u0000${row.band}`;
}

function cacheRow(row) {
  return { model: row.model, effort: row.effort, band: row.band,
    ...Object.fromEntries(ANALYTICS_V2_CACHE_COUNTERS.map((counter) => [counter, row[counter]])) };
}

/**
 * Compare stored analytics_v2 owner rows with an oracle's owner references.
 * `conflict` is the golden manifest's crossed-day conflict ({owner, days}) or
 * null.
 */
export function compareAnalyticsV2OwnerParity({ ownerResults, cacheReference, conflict = null, rows }) {
  if (ownerResults?.schemaVersion !== OWNER_RESULTS_VERSION || !isObject(ownerResults.owners)
      || !DAY_PATTERN.test(ownerResults.today ?? "") || !Array.isArray(ownerResults.modelDates)) {
    invalid("ownerResults");
  }
  if (cacheReference?.schemaVersion !== CACHE_REFERENCE_VERSION || !isObject(cacheReference.days)
      || !isObject(cacheReference.ownerDays)) invalid("cacheReference");
  validRows(rows);
  const families = Object.fromEntries(ANALYTICS_V2_OWNER_PARITY_FAMILIES.map((name) => [name, family(name)]));
  const keyOf = new Map();
  for (const [key, owner] of Object.entries(ownerResults.owners)) {
    if (!DIGEST_PATTERN.test(owner?.ownerDigest ?? "")) invalid("ownerResults.ownerDigest");
    keyOf.set(owner.ownerDigest, key);
  }
  const conflictDays = new Set(conflict === null ? [] : conflict.days);
  const conflictOwner = conflict === null ? null : conflict.owner;
  const expectedRefusals = new Map();
  const expectRefusal = (key, day, familyName, basis) => expectedRefusals.set(`${key}|${day}|${familyName}`, basis);
  const byOwner = (list) => Map.groupBy(list, (row) => row.ownerDigest);
  const fitsByOwner = byOwner(rows.fits);
  const modelByOwner = byOwner(rows.modelDates);
  const daysByOwner = byOwner(rows.ownerDays);
  const bandsByOwner = byOwner(rows.cacheBands);
  const strangers = [...new Set([...rows.fits, ...rows.modelDates, ...rows.ownerDays, ...rows.cacheBands]
    .map((row) => row.ownerDigest))].filter((digest) => !keyOf.has(digest));
  for (const digest of strangers) note(families["owner-fits"], `owner ${digest.slice(0, 8)}`, "stored rows for an owner the reference does not hold");
  const unreferencedOwnerDays = [];
  const uncomparedOwnerDays = [];

  for (const [key, owner] of Object.entries(ownerResults.owners)) {
    const digest = owner.ownerDigest;
    // ---- Fits for today.
    const storedFits = fitsByOwner.get(digest) ?? [];
    const reference = owner.fits?.direct;
    if (isObject(reference) && Array.isArray(reference.fits)) {
      if (storedFits.length !== 1) note(families["owner-fits"], `${key}.fits`, `stored ${storedFits.length} fits rows`);
      else {
        record(families["owner-fits"], `${key}.fits`, { asOfDay: ownerResults.today, fits: reference.fits },
          { asOfDay: storedFits[0].asOfDay, fits: storedFits[0].fits });
      }
    } else if (isObject(reference) && reference.state === "failed") {
      // Production's native computation failed: the fast path must refuse too.
      expectRefusal(key, ownerResults.today, "scalar", reference.reason ?? "failed");
      if (storedFits.length !== 0) note(families["owner-fits"], `${key}.fits`, "fits stored where production failed");
      else { families["owner-fits"].compared += 1; families["owner-fits"].equal += 1; }
    } else invalid(`ownerResults.fits.${key}`);

    // ---- Model dates.
    const storedModel = new Map((modelByOwner.get(digest) ?? []).map((row) => [row.day, row.result]));
    for (const day of ownerResults.modelDates) {
      const direct = owner.model?.[day]?.direct;
      const path = `${key}.model[${day}]`;
      if (isObject(direct) && direct.state === "failed") {
        expectRefusal(key, day, "model", direct.reason);
        if (storedModel.has(day)) note(families["owner-model-dates"], path, "result stored where production failed");
        else { families["owner-model-dates"].compared += 1; families["owner-model-dates"].equal += 1; }
      } else if (isObject(direct?.result)) {
        if (!storedModel.has(day)) note(families["owner-model-dates"], path, "no stored result");
        else record(families["owner-model-dates"], path, withoutFingerprint(direct.result), storedModel.get(day));
      } else invalid(`ownerResults.model.${key}.${day}`);
    }
    for (const day of storedModel.keys()) {
      if (!ownerResults.modelDates.includes(day)) note(families["owner-model-dates"], `${key}.model[${day}]`, "stored date outside the reference's 70");
    }

    // ---- Owner-day daily values.
    const storedDays = new Map((daysByOwner.get(digest) ?? []).map((row) => [row.day, row]));
    const referenceDays = owner.daily ?? {};
    for (const [day, value] of Object.entries(referenceDays)) {
      const path = `${key}.daily[${day}]`;
      if (value?.complete !== 1 || value?.sourceFormat !== "effective") invalid(`ownerResults.daily.${key}.${day}`);
      const stored = storedDays.get(day);
      if (stored === undefined) note(families["owner-days"], path, "no stored owner-day");
      else if (stored.daily === null) note(families["owner-days"], path, `stored refusal ${stored.refusal}`);
      else record(families["owner-days"], path, value.values, stored.daily);
    }
    for (const [day, stored] of storedDays) {
      if (Object.hasOwn(referenceDays, day)) continue;
      unreferencedOwnerDays.push(`${key}:${day}`);
      // Production completes no owner value on a conflict-blocked day; any
      // other unreferenced owner-day is a difference.
      if (!conflictDays.has(day)) note(families["owner-days"], `${key}.daily[${day}]`, "stored owner-day the reference lacks");
      else if (key === conflictOwner) {
        expectRefusal(key, day, "daily", "conflict");
        if (stored.daily !== null) note(families["owner-days"], `${key}.daily[${day}]`, "conflict day computed");
      } else {
        // No production value exists for this owner-day: listed, not compared.
        // An unexpected refusal here still fails the refusals family.
        uncomparedOwnerDays.push(`${key}:${day}`);
      }
    }

    // ---- Cache owner-days.
    const storedBands = Map.groupBy(bandsByOwner.get(digest) ?? [], (row) => row.day);
    const referencedCacheDays = new Set();
    for (const [ownerDay, state] of Object.entries(cacheReference.days)) {
      const [ownerKey, day] = ownerDay.split(":");
      if (ownerKey !== key) continue;
      referencedCacheDays.add(day);
      const path = `${key}.cache[${day}]`;
      const stored = (storedBands.get(day) ?? []).map(cacheRow).sort((left, right) =>
        (bandKey(left) < bandKey(right) ? -1 : 1));
      if (state?.state === "refused") {
        expectRefusal(key, day, "cache", state.reason);
        if (stored.length > 0) note(families["owner-cache-days"], path, "bands stored where production refused");
        else { families["owner-cache-days"].compared += 1; families["owner-cache-days"].equal += 1; }
      } else if (state?.state === "built") {
        const expected = (cacheReference.ownerDays[ownerDay] ?? []).map((row) => {
          if (row.layout !== CACHE_LAYOUT || row.method !== CACHE_METHOD) invalid(`cacheReference.${ownerDay}`);
          return cacheRow(row);
        }).sort((left, right) => (bandKey(left) < bandKey(right) ? -1 : 1));
        record(families["owner-cache-days"], path, expected, stored);
      } else invalid(`cacheReference.days.${ownerDay}`);
    }
    for (const day of storedBands.keys()) {
      if (!referencedCacheDays.has(day)) note(families["owner-cache-days"], `${key}.cache[${day}]`, "bands stored for an owner-day without reference usage");
    }
  }

  // ---- Refusals: exactly the reference failures, with closed reasons.
  const actualRefusals = new Map();
  const reasons = {};
  for (const refusal of rows.refusals) {
    const key = keyOf.get(refusal.ownerDigest) ?? `?${refusal.ownerDigest.slice(0, 8)}`;
    const id = `${key}|${refusal.day ?? "owner"}|${refusal.family}`;
    actualRefusals.set(id, refusal.reason);
    reasons[`${refusal.family}:${refusal.reason}`] = (reasons[`${refusal.family}:${refusal.reason}`] ?? 0) + 1;
  }
  for (const [id, basis] of expectedRefusals) {
    const actual = actualRefusals.get(id);
    const familyName = id.split("|")[2];
    if (actual === undefined) note(families.refusals, id, `production ${basis}; no analytics_v2 refusal`);
    else if (!(REFUSAL_REASONS[familyName] ?? []).includes(actual)) note(families.refusals, id, `reason ${actual} is not a closed ${familyName} reason`);
    else { families.refusals.compared += 1; families.refusals.equal += 1; }
  }
  for (const [id, reason] of actualRefusals) {
    if (!expectedRefusals.has(id)) note(families.refusals, id, `analytics_v2 refused (${reason}) where production computed`);
  }

  const list = ANALYTICS_V2_OWNER_PARITY_FAMILIES.map((name) => families[name]);
  const unexpected = list.filter((entry) => entry.diffCount > 0);
  return Object.freeze({
    schemaVersion: ANALYTICS_V2_OWNER_PARITY_REPORT_VERSION,
    normalized: ["owner-model-dates: reference inputFingerprint"],
    owners: [...keyOf.values()],
    today: ownerResults.today,
    runIds: [...new Set([...rows.fits, ...rows.modelDates, ...rows.ownerDays, ...rows.cacheBands]
      .map((row) => row.runId).filter((value) => typeof value === "string"))].length,
    unreferencedOwnerDays: unreferencedOwnerDays.sort(),
    uncomparedOwnerDays: uncomparedOwnerDays.sort(),
    refusalsByFamilyReason: Object.fromEntries(Object.entries(reasons).sort()),
    unexpectedFamilies: unexpected.map((entry) => entry.family),
    unexpectedDiffs: unexpected.reduce((sum, entry) => sum + entry.diffCount, 0),
    families: list,
  });
}

function usageFail(message) {
  process.stderr.write(`${JSON.stringify({ status: "error", code: "OWNER_PARITY_COMPARE_USAGE", message })}\n`);
  process.exit(2);
}

async function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const reference = value("--reference");
  const rowsPath = value("--rows");
  if (!reference || !rowsPath) usageFail("--reference <golden dir> and --rows <owner-rows.json> are required");
  const read = async (path) => JSON.parse(await readFile(resolve(path), "utf8"));
  const report = compareAnalyticsV2OwnerParity({
    ownerResults: await read(join(reference, "owner-results.json")),
    cacheReference: await read(join(reference, "cache-reference.json")),
    conflict: (await read(join(reference, "manifest.json"))).conflict ?? null,
    rows: await read(rowsPath),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.unexpectedDiffs === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
