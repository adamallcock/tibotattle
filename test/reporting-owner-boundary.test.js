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
// Every reporting implementation module, pinned to the exact import
// specifiers it is reviewed to carry. An empty list means the module is a
// pure leaf. A non-empty list may only name a workspace package the
// architecture checker already grants the reporting owner
// (OWNER_ALLOWED_PACKAGES in scripts/check-architecture-boundaries.mjs);
// runtime builtins and relative reaches into another owner stay forbidden.
const REPORTING_IMPLEMENTATIONS = Object.freeze({
  "src/reporting/monitoring-quality.js": Object.freeze([]),
  // The seven-day window length is the quota owner's constant. Reporting
  // reads it from that package's public entrypoint instead of restating
  // 10_080 and letting the two definitions drift apart.
  "src/reporting/weekly-calibration.js": Object.freeze([
    "@app-usagemonitor/quota-analysis",
  ]),
});
const REPORTING_ALLOWED_PACKAGES = Object.freeze([
  "@app-usagemonitor/accounting",
  "@app-usagemonitor/quota-analysis",
]);
const REPORTING_PUBLIC_EXPORTS = Object.freeze([
  "BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT",
  "CANDIDATES",
  "analyzeMonitoringQuality",
  "analyzeWeeklyCalibration",
  "classifyMonitoringInterval",
  "createCollectorQualityAccumulator",
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
  for (
    const [implementation, reviewed] of Object.entries(REPORTING_IMPLEMENTATIONS)
  ) {
    const imports = await extractEsmImports(await source(implementation), {
      sourceName: implementation,
    });
    assert.deepEqual(
      imports.map(({ specifier }) => specifier).sort(),
      [...reviewed].sort(),
      `${implementation} must not import a runtime or another owner`,
    );
    for (const specifier of reviewed) {
      assert.equal(
        REPORTING_ALLOWED_PACKAGES.includes(specifier),
        true,
        `${implementation} may only reach a package the reporting owner is granted: ${specifier}`,
      );
    }
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
