import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as reporting from "../src/reporting/index.js";
import { extractEsmImports } from "../scripts/lib/esm-imports.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPORTING_IMPLEMENTATIONS = Object.freeze([
  "src/reporting/monitoring-quality.js",
  "src/reporting/weekly-calibration.js",
]);
const REPORTING_PUBLIC_EXPORTS = Object.freeze([
  "BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT",
  "CANDIDATES",
  "analyzeMonitoringQuality",
  "analyzeWeeklyCalibration",
  "classifyMonitoringInterval",
  "projectBoundedWeeklyCalibrationSummary",
  "renderMonitoringQualityReport",
  "renderWeeklyCalibrationReport",
]);
const REPORTING_CALLERS = Object.freeze([
  "src/cli.js",
  "src/local-companion-data.js",
  "src/minimization-ablation.js",
  "src/replay-safe-accounting-cache.js",
  "test/monitoring-quality.test.js",
  "test/weekly-calibration.test.js",
]);

async function source(relativePath) {
  return readFile(join(REPOSITORY_ROOT, relativePath), "utf8");
}

test("reporting publishes only the reviewed monitoring and weekly calibration API", () => {
  assert.deepEqual(Object.keys(reporting).sort(), REPORTING_PUBLIC_EXPORTS);
});

test("reporting implementations are runtime-neutral and index-only outside the owner", async () => {
  for (const implementation of REPORTING_IMPLEMENTATIONS) {
    const imports = await extractEsmImports(await source(implementation), {
      sourceName: implementation,
    });
    assert.deepEqual(imports, [], `${implementation} must not import a runtime or another owner`);
  }

  const indexImports = await extractEsmImports(
    await source("src/reporting/index.js"),
    { sourceName: "src/reporting/index.js" },
  );
  assert.ok(indexImports.length > 0);
  assert.ok(indexImports.every(({ specifier }) => (
    typeof specifier === "string" && specifier.startsWith("./")
  )));
});

test("all reporting callers enter through the public index", async () => {
  for (const caller of REPORTING_CALLERS) {
    const callerSource = await source(caller);
    assert.match(callerSource, /reporting\/index\.js/u, caller);
    assert.doesNotMatch(
      callerSource,
      /(?:\.\/|\.\.\/src\/)(?:monitoring-quality|weekly-calibration)\.js/u,
      caller,
    );
  }
});

test("retired flat reporting paths cannot reappear", async () => {
  await assert.rejects(
    access(join(REPOSITORY_ROOT, "src/monitoring-quality.js")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    access(join(REPOSITORY_ROOT, "src/weekly-calibration.js")),
    { code: "ENOENT" },
  );
});
