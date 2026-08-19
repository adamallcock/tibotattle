import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as quotaAnalysis from "@app-usagemonitor/quota-analysis";

const TRACK_EXPORTS = Object.freeze([
  "QUOTA_TRACK_POLICY",
  "buildResetEvidence",
  "continuityKey",
  "resetKey",
]);
const CALIBRATION_EXPORTS = Object.freeze([
  "QUOTA_CALIBRATION_POLICY",
  "analyzeQuotaCalibration",
  "fitResetCapacity",
  "forecastCapacityFromPriorResets",
]);
const ROLLING_EXPORTS = Object.freeze([
  "QUOTA_ROLLING_POLICY",
  "buildRollingQuotaComparisons",
]);
const PACE_EXPORTS = Object.freeze([
  "QUOTA_PACE_POLICY",
  "analyzeQuotaPace",
]);
const COMPOSITION_EXPORTS = Object.freeze([
  "MODEL_COMPOSITION_POLICY",
  "blendedCompositionCapacityUsd",
  "buildCompositionObservations",
  "calibrateCompositionCapacities",
  "compositionExpectedPp",
  "solveNonNegativeLeastSquares",
]);
const WINDOW_EXPORTS = Object.freeze([
  "FIVE_HOUR_WINDOW_MINUTES",
  "formatQuotaWindowDuration",
  "MAX_QUOTA_WINDOW_DURATION_MINUTES",
  "quotaWindowLabel",
  "SEVEN_DAY_WINDOW_MINUTES",
  "SUPPORTED_QUOTA_WINDOW_DURATIONS",
  "isValidQuotaWindowDuration",
  "isSupportedQuotaWindowDuration",
  "selectPrimaryQuotaWindow",
]);
const SOURCE_HASHES = Object.freeze({
  "quota-calibration.js":
    "7d19a7a0184c65378c3214b439c2cac647747457823d91d2999991847a552bbc",
  "quota-rolling.js":
    "2afca11d40c61c463524cc8f4d267c128dbe427c72fb6c2e3ed68b056ca70977",
  "quota-tracks.js":
    // Re-pinned for the reviewed 5pp noise tolerance and running-maximum
    // boundary correction. The executable kernel changed in ea84c35 while
    // this byte-identity receipt remained on the pre-correction digest.
    "d15a78931e10c8bccf82ea262f722ea84b5fd02d0cb3c9fd37b18dbd169fa3f0",
  "quota-windows.js":
    "fbf4bdcfb8417efcc2cdf3d7e3e92f1302048e523d6722b06eb9c47b44861366",
  // Re-pinned with the slot-identity change: `slot` left TRACK_KEYS because
  // track compatibility is judged by (limit, duration) — the provider's
  // primary/secondary slots are UI roles that flipped for the weekly window
  // around 2026-07-06 without the window itself changing.
  // Re-pinned 2026-08-19 for quota-pace-forecast-v0.2. The kernel now reports
  // a named working-time rate and a named wall-clock rate instead of one
  // ambiguous `percentagePointsPerHour`, and `etaAt`/`status` are derived
  // from the wall-clock one. The old ETA divided a remaining allowance by a
  // per-working-hour rate and reported the quotient as wall-clock hours, which
  // made every published forecast arrive early. The plausibility cap moved to
  // the wall-clock rate with it, since that is the only rate the ETA depends
  // on; an over-cap working rate is now reported as null rather than refusing
  // an otherwise sound forecast.
  "quota-pace-forecast.js":
    "793ee450768a193609e1659ce62c33f11af897e5e562b8a7393f4644d0a24891",
  // Not a pre-extraction kernel: authored 2026-08-11 for the
  // composition-aware expected line (per-model NNLS calibration, design:
  // docs/design/composition-aware-expected-line.md). Pinned the same way so
  // an unreviewed edit to the fit is as loud as one to the older kernels.
  // Re-pinned 2026-08-11 for the reviewed corrections: mid-bin-reset bins
  // are voided (one bin's cost was attributed to every same-pool segment
  // moving in it) and the fallback gate became df-adjusted plus split-half
  // stability (raw nested R² could never reject a near-collinear fit).
  "model-composition.js":
    "e7a56f8d66e60227cc509fa3d8166b94c7544af867f081e6a6953e5e984abbd5",
});

test("quota analysis exposes one exact runtime-neutral package root", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../packages/quota-analysis/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.name, "@app-usagemonitor/quota-analysis");
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert.deepEqual(manifest.exports["."], {
    types: "./index.d.ts",
    import: "./index.js",
    default: "./index.js",
  });
  assert.deepEqual(manifest.files, ["index.d.ts", "index.js", "src"]);
  assert.equal(Object.hasOwn(manifest, "dependencies"), false);
  assert.equal(Object.hasOwn(manifest, "devDependencies"), false);
  assert.deepEqual(
    Object.keys(quotaAnalysis).sort(),
    [
      ...TRACK_EXPORTS,
      ...CALIBRATION_EXPORTS,
      ...ROLLING_EXPORTS,
      ...PACE_EXPORTS,
      ...COMPOSITION_EXPORTS,
      ...WINDOW_EXPORTS,
    ].sort(),
  );
});

test("package implementation bytes equal the pre-extraction quota kernels", async () => {
  for (const [name, expected] of Object.entries(SOURCE_HASHES)) {
    const bytes = await readFile(
      new URL(`../packages/quota-analysis/src/${name}`, import.meta.url),
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected,
      name,
    );
  }
});

test("root and Worker resolve only the reviewed package root", async () => {
  const [
    rootManifest,
    workerManifest,
    workerSource,
    declarationSource,
  ] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../apps/worker/package.json", import.meta.url), "utf8"),
    readFile(
      new URL("../apps/worker/src/quota-analysis.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../packages/quota-analysis/index.d.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.equal(
    JSON.parse(rootManifest).dependencies[
      "@app-usagemonitor/quota-analysis"
    ],
    "workspace:*",
  );
  assert.equal(
    JSON.parse(workerManifest).dependencies[
      "@app-usagemonitor/quota-analysis"
    ],
    "file:../../packages/quota-analysis",
  );
  assert.match(
    workerSource,
    /from "@app-usagemonitor\/quota-analysis"/u,
  );
  assert.doesNotMatch(workerSource, /shared\/quota-/u);
  assert.doesNotMatch(
    workerSource,
    /@app-usagemonitor\/quota-analysis\//u,
  );
  assert.doesNotMatch(workerSource, /@ts-(?:expect-error|ignore)/u);
  for (const name of [
    "buildResetEvidence",
    "analyzeQuotaCalibration",
    "buildRollingQuotaComparisons",
  ]) {
    assert.match(
      declarationSource,
      new RegExp(`export function ${name}\\(`, "u"),
      `${name} must have a concrete declaration`,
    );
  }
  assert.doesNotMatch(declarationSource, /declare module/u);
});
