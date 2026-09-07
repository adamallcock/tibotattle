import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { instrumentPr94CalibrationSource } from "../scripts/lib/pr94-revision-loader.mjs";

const reportUrl = new URL("../src/reporting/weekly-calibration.js", import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const source = await readFile(reportUrl, "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");

function syntheticRows() {
  const reset = Date.parse("2026-08-15T00:00:00.000Z") / 1_000;
  return Array.from({ length: 12 }, (_, index) => {
    const at = Date.parse("2026-08-10T00:00:00.000Z") + index * 3_600_000;
    return { provider: "openai_codex", planType: "pro", limitId: "codex", slot: "primary",
      accountScopeId: "unattributed", planEraKey: "synthetic-era", planVariant: "unknown",
      windowDurationMins: 10_080, resetsAt: reset, aggregationEligibility: "primary_conditional",
      eventTime: new Date(at + 3_600_000).toISOString(), lastPriorObservedAt: new Date(at).toISOString(),
      firstNextObservedAt: new Date(at + 3_600_000).toISOString(), priorUsedPercent: index, nextUsedPercent: index + 1,
      lastPriorCumulativeApiPricedUsd: index * 10, firstNextCumulativeApiPricedUsd: (index + 1) * 10,
      lastPriorCumulativeQuotaWeightedLowerUsd: index * 10, firstNextCumulativeQuotaWeightedLowerUsd: (index + 1) * 10,
      lastPriorCumulativeQuotaWeightedUpperUsd: index * 20, firstNextCumulativeQuotaWeightedUpperUsd: (index + 1) * 20,
      marginalUsageEventCount: 1, quality: { localCoverage: { elapsedTimeCoverageFraction: 1 }, pricingWarnings: [], attributionWarnings: [] } };
  });
}

test("PR94 export instrumentation preserves every original source byte and binds only its suffix separately", () => {
  const result = instrumentPr94CalibrationSource(source);
  assert.equal(result.source.slice(0, source.length), source);
  assert.equal(result.sourceSha256, hash(source));
  const suffix = result.source.slice(source.length);
  assert.equal(result.instrumentationSha256, hash(suffix));
  assert.match(suffix, /^\nexport const __pr94CalibrationInternals = Object\.freeze\(\{/u);
  assert.match(suffix, /export \{ CANDIDATES as WEEKLY_CALIBRATION_CANDIDATES \};\n$/u);
  assert.doesNotMatch(suffix, /function\s|import\s|globalThis|process|eval\(/u);
  assert.ok(Object.isFrozen(result));
});

test("PR94 authenticated extra exports do not change actual public reports for any main candidate", async () => {
  const plainUrl = new URL(reportUrl);
  plainUrl.search = "pr94-loader-plain";
  const instrumentedUrl = new URL(reportUrl);
  instrumentedUrl.search = "pr94-loader-instrumented";
  const plain = await import(plainUrl.href);
  const transformed = instrumentPr94CalibrationSource(source);
  let loadCount = 0;
  const hook = registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== instrumentedUrl.href) return loaded;
    loadCount += 1;
    assert.equal(typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8"), source);
    return { ...loaded, source: transformed.source };
  } });
  let instrumented;
  try { instrumented = await import(instrumentedUrl.href); } finally { hook.deregister(); }
  assert.equal(loadCount, 1);
  assert.equal(instrumented.CANDIDATES, instrumented.WEEKLY_CALIBRATION_CANDIDATES);
  assert.ok(Object.isFrozen(instrumented.__pr94CalibrationInternals));
  const dataset = { transitions: syntheticRows(), scope: { startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z" } };
  const before = structuredClone(dataset);
  for (const candidate of plain.CANDIDATES) {
    const options = { planType: "pro", forcedCandidateId: candidate.id };
    assert.deepEqual(instrumented.analyzeWeeklyCalibration(dataset, options), plain.analyzeWeeklyCalibration(dataset, options));
  }
  assert.deepEqual(dataset, before);
  const body = source.slice(source.indexOf("function fitReset("), source.indexOf("\nfunction observedTimestamp")).trimEnd();
  assert.equal(Function.prototype.toString.call(instrumented.__pr94CalibrationInternals.fitReset), body);
});

test("PR94 instrumentation refuses missing, duplicate, oversized or already instrumented declarations", () => {
  for (const invalid of [
    null,
    "x".repeat(512 * 1024 + 1),
    source.replace("function fitReset(", "function renamedFit("),
    `${source}\nfunction fitReset() {}\n`,
    `${source}\nconst CANDIDATES = [];\n`,
    `${source}\nconst __pr94CalibrationInternals = {};\n`,
  ]) assert.throws(() => instrumentPr94CalibrationSource(invalid), /^Error: pr94_instrumentation_invalid$/u);
});

test("PR94 actual revision loader exposes original modules in a fresh process and rejects cached reuse", async () => {
  const loaderUrl = new URL("../scripts/lib/pr94-revision-loader.mjs", import.meta.url).href;
  const code = `import { loadPr94Revision } from ${JSON.stringify(loaderUrl)};
    const root = ${JSON.stringify(root)};
    const loaded = await loadPr94Revision(root);
    let rejectedReuse = false;
    try { await loadPr94Revision(root); } catch(error) { rejectedReuse = error.message === 'pr94_instrumentation_invalid'; }
    process.stdout.write(JSON.stringify({ transformation: loaded.instrumentation.transformation,
      sourceSha256: loaded.instrumentation.sourceSha256,
      helper: typeof loaded.reporting.__pr94CalibrationInternals.fitReset,
      miner: typeof loaded.miner.deriveCodexTransitionSeriesCooperatively,
      reader: typeof loaded.reader.createLocalUnifiedAccountingSource,
      rejectedReuse }));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timeout);
  assert.equal(exit, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { transformation: "append_exports_only", sourceSha256: hash(source),
    helper: "function", miner: "function", reader: "function", rejectedReuse: true });
});
