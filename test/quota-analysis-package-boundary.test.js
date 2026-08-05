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
  "MAX_QUOTA_WINDOW_DURATION_MINUTES",
  "SEVEN_DAY_WINDOW_MINUTES",
  "SUPPORTED_QUOTA_WINDOW_DURATIONS",
  "isValidQuotaWindowDuration",
  "isSupportedQuotaWindowDuration",
]);
const SOURCE_HASHES = Object.freeze({
  "quota-calibration.js":
    "7d19a7a0184c65378c3214b439c2cac647747457823d91d2999991847a552bbc",
  "quota-rolling.js":
    "2afca11d40c61c463524cc8f4d267c128dbe427c72fb6c2e3ed68b056ca70977",
  "quota-tracks.js":
    "85118466c257497a72c07c05cda6224c8d0a7e6a7b85aa69b4d950bf823d2170",
  "quota-windows.js":
    "bb6ac48094e6bc7cd7dc44f587107b40b4a19799461814184e2b5f0cb6a08414",
  "quota-pace-forecast.js":
    "89bff15bf12f4b94c578c04a6c7b05f3c7656eda3ae9b935a0ed9683ef08e8b6",
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
