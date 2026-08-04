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
const WINDOW_EXPORTS = Object.freeze([
  "FIVE_HOUR_WINDOW_MINUTES",
  "SEVEN_DAY_WINDOW_MINUTES",
  "SUPPORTED_QUOTA_WINDOW_DURATIONS",
  "isSupportedQuotaWindowDuration",
]);
const SOURCE_HASHES = Object.freeze({
  "quota-calibration.js":
    "d8246bd3a290084315b90f2b8b1c0910ccde861ca0e30292512ed5594426461b",
  "quota-rolling.js":
    "d86cbeaefc8c1a6d5836296f83d10af87dbb7ca8171dc5cc7522a21cfb005b1c",
  "quota-tracks.js":
    "7f1790e98ffcad931bf85d4d390741d5eb38b2df2bf2748fe5b2abfc98820708",
  "quota-windows.js":
    "01b099579d811a30fd2e0543f89286fc9946e821a4db0dd3b07dd453f9c0381b",
  "quota-pace-forecast.js":
    "dcc2c7317ef96433f02eb300ef0d33d6f5985e0c51923dfa5bc09f9ec92ae648",
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
