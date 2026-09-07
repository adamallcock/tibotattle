import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Qualification-only, export-only instrumentation. Original function bodies,
// branches and returned production objects are not changed. The coordinator
// authenticates the clean revision and dependencies before invoking this seam.
// The exact original bytes and appended instrumentation are bound separately.
const REPORT_PATH = "src/reporting/weekly-calibration.js";
const REQUIRED_FUNCTIONS = Object.freeze([
  "selectResetGroups", "fitReset", "uniquePoints", "capacityFit",
  "fitRelativeCentral80Width", "isEligible", "partitionKey",
]);

function fail() { throw new Error("pr94_instrumentation_invalid"); }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export function instrumentPr94CalibrationSource(source) {
  if (typeof source !== "string" || source.length > 512 * 1024
      || source.includes("__pr94CalibrationInternals")) fail();
  for (const name of REQUIRED_FUNCTIONS) {
    if ([...source.matchAll(new RegExp(`^function ${name}\\(`, "gm"))].length !== 1) fail();
  }
  if ([...source.matchAll(/^const CANDIDATES = \[/gmu)].length !== 1) fail();
  const names = [...REQUIRED_FUNCTIONS];
  if (/^function resetParentKey\(/mu.test(source)) names.push("resetParentKey");
  const suffix = `\nexport const __pr94CalibrationInternals = Object.freeze({ ${names.join(", ")} });\n`
    + "export { CANDIDATES as WEEKLY_CALIBRATION_CANDIDATES };\n";
  return Object.freeze({
    source: source + suffix,
    sourceSha256: hash(source),
    instrumentationSha256: hash(suffix),
  });
}

export async function loadPr94Revision(root) {
  if (typeof root !== "string" || resolve(root) !== root) fail();
  const reportUrl = pathToFileURL(join(root, REPORT_PATH)).href;
  const source = await readFile(join(root, REPORT_PATH), "utf8");
  const instrumented = instrumentPr94CalibrationSource(source);
  let calls = 0;
  const hook = registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== reportUrl) return loaded;
      const original = typeof loaded.source === "string"
        ? loaded.source : Buffer.from(loaded.source).toString("utf8");
      if (hash(original) !== instrumented.sourceSha256 || ++calls !== 1) fail();
      return { ...loaded, source: instrumented.source };
    },
  });
  try {
    const reporting = await import(reportUrl);
    if (calls !== 1) fail();
    const [reader, index, miner, accounting, quota, cache] = await Promise.all([
      import(pathToFileURL(join(root, "src/local-unified-accounting-source.js")).href),
      import(pathToFileURL(join(root, "src/local-unified-index.js")).href),
      import(pathToFileURL(join(root, "src/codex-transition-miner.js")).href),
      import(pathToFileURL(join(root, "packages/accounting/index.js")).href),
      import(pathToFileURL(join(root, "packages/quota-analysis/index.js")).href),
      import(pathToFileURL(join(root, "src/replay-safe-accounting-cache.js")).href),
    ]);
    return { reader, index, miner, accounting, quota, cache, reporting,
      instrumentation: {
        sourceSha256: instrumented.sourceSha256,
        instrumentationSha256: instrumented.instrumentationSha256,
        transformation: "append_exports_only",
      } };
  } finally { hook.deregister(); }
}
