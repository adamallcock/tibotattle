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
const SOURCE_HASHES = Object.freeze({
  "quota-calibration.js":
    "3cfea0c59b3d381e696e471b25c44000abcc5e47eeaccf95ed9e54880c142c74",
  "quota-rolling.js":
    "a1559a990b7d90ddc44b0362cca44206f84f103dd4528dbdcd3e476d94a32179",
  "quota-tracks.js":
    "c6b9fce426d2665f002c9b62cfc48bb2c0e1a171a9bf3d50170d419528c08124",
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
    [...TRACK_EXPORTS, ...CALIBRATION_EXPORTS, ...ROLLING_EXPORTS].sort(),
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
