// Synthetic, content-free fixtures for the interim frozen public read (C-IPR).
//
// The base is the Q-1 oracle golden: the response d43c8f92's own production
// code produced over a synthetic corpus (community-daily-response.json), made
// into a full 366-day export by widening `from` to a year before `to`. Every
// value in it is a synthetic count, a closed token or a synthetic digest.
// Variants (the release-era v1.2 breakdowns, other spend shapes) are derived
// from it so the tests exercise real production shapes, not invented ones.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const GOLDEN_URL = new URL("../golden/community-daily-response.json", import.meta.url);
const DENSE_GOLDEN_URL = new URL("../golden-dense/community-daily-response-settled.json", import.meta.url);

/** The golden's window ends on this day, which is therefore the evidence date. */
export const FIXTURE_EVIDENCE_DATE = "2026-10-01";
/** After every releasedAt in the golden, on the evidence date. */
export const FIXTURE_CAPTURED_AT = "2026-10-01T23:30:00.000Z";
/** A synthetic 40-hex commit. */
export const FIXTURE_SOURCE_COMMIT = "5e1f0c4a9b7d3a6e2c8f1b0d4a7e9c3b5d2f6a81";

const MILLISECONDS_PER_DAY = 86_400_000;

export function daysBefore(day, count) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - count * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

function fullYearFrom(body) {
  return { ...body, from: daysBefore(body.to, 365) };
}

/** Every oracle golden response, as paths under analytics-v2-test/. */
export const ORACLE_GOLDEN_RESPONSES = Object.freeze([
  "golden/community-daily-response.json",
  "golden-dense/community-daily-response.json",
  "golden-dense/community-daily-response-settled.json",
  "golden-q1-node/community-daily-response-settled.json",
]);

/** One oracle golden as a full-window export body. */
export function oracleGoldenExportBody(path) {
  return fullYearFrom(JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")));
}

/** The golden as a full-window export body: allowance ready, confirmed, v1.1 breakdowns. */
export function goldenExportBody() {
  return fullYearFrom(JSON.parse(readFileSync(GOLDEN_URL, "utf8")));
}

/** The dense golden: the allowance updating and unavailable, no breakdowns, still a cache series. */
export function denseGoldenExportBody() {
  return fullYearFrom(JSON.parse(readFileSync(DENSE_GOLDEN_URL, "utf8")));
}

/**
 * The release-era breakdowns (community-allowance-breakdowns-v1.2): the
 * pro10x basis, the promax plan and its normalization. Synthetic: promax has
 * no fit on any day.
 */
export function withV12Breakdowns(body) {
  const clone = structuredClone(body);
  const breakdowns = clone.allowanceBreakdowns;
  breakdowns.schemaVersion = "community-allowance-breakdowns-v1.2";
  breakdowns.basis = "seven_day_codex_pro10x_equivalent_personal_plans_trailing_30d_promax25";
  breakdowns.normalization = "pro_x1_prolite_x2_promax_x0_4_plus_x10";
  breakdowns.modelBasis = "seven_day_codex_pro10x_equivalent_per_model_composition";
  breakdowns.days = breakdowns.days.map((row) => {
    const byPlanType = {};
    for (const plan of ["pro", "prolite"]) byPlanType[plan] = row.byPlanType[plan];
    byPlanType.promax = { centralUsd: null, participantCount: 0, fitCount: 0, band80Usd: null };
    byPlanType.plus = row.byPlanType.plus;
    return { ...row, byPlanType };
  });
  return clone;
}

/** The v1.0 breakdowns: no combined summary per day. */
export function withV10Breakdowns(body) {
  const clone = structuredClone(body);
  clone.allowanceBreakdowns.schemaVersion = "community-allowance-breakdowns-v1.0";
  clone.allowanceBreakdowns.days = clone.allowanceBreakdowns.days.map(({ combined: _combined, ...row }) => row);
  return clone;
}

/** UTF-8 bytes of the compact JSON text, as `curl` would save the response body. */
export function exportBytes(body) {
  return new TextEncoder().encode(JSON.stringify(body));
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The loader's whole input for one export body, with the capture facts overridable. */
export function exportInput(body, facts = {}) {
  const bytes = exportBytes(body);
  return {
    exportBytes: bytes,
    expectedSha256: sha256Hex(bytes),
    capturedAt: FIXTURE_CAPTURED_AT,
    sourceCommit: FIXTURE_SOURCE_COMMIT,
    evidenceDate: body.to,
    ...facts,
  };
}
