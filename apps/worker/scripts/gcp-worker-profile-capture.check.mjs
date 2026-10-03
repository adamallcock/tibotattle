/** Synthetic real-isolate MODEL-BLOCKS proof. No database, private evidence or stamped build. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { Worker } from "node:worker_threads";
import { createWorkerProfileCoordinator } from "../cloud-run/analytics-refresh-worker-profile.mjs";
import { createAnalyticsRefreshOwnerPool } from "../cloud-run/analytics-refresh-pool.mjs";
import { cloudRunBuildPlugins } from "../cloud-run/node-host-build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMP = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-worker-profile-proof-")));
after(() => rm(TEMP, { recursive: true, force: true }));
const entry = join(TEMP, "proof-entry.ts");
await writeFile(entry, `
export { computeAnalyticsV2 } from ${JSON.stringify(join(ROOT, "src/analytics-v2/compute.ts"))};
export { ANALYTICS_V2_DEFAULT_RESOURCES } from ${JSON.stringify(join(ROOT, "src/analytics-v2/resources.ts"))};
import { analyticsV2RequiredOccurrenceRange } from ${JSON.stringify(join(ROOT, "src/analytics-v2/compute.ts"))};
import { composeProofCorpus, oneDevicePerOwner, NOW_MS, TODAY } from ${JSON.stringify(join(ROOT, "analytics-v2-test/fixtures/synthetic-occurrences.mjs"))};
export function proofInput() {
  const corpus = composeProofCorpus(), queuedDays = { days: [TODAY], lastSequence: 42 };
  return { ...corpus, occurrenceRange: analyticsV2RequiredOccurrenceRange({ nowMs: NOW_MS, queuedDays }),
    devicesByDay: oneDevicePerOwner(corpus.occurrencesByOwner, queuedDays.days), queuedDays, nowMs: NOW_MS, revisionSeed: 0 };
}
`);
await build({ entryPoints: { proof: entry, "analytics-refresh-worker": join(ROOT, "cloud-run/analytics-refresh-worker.mjs") },
  bundle: true, platform: "node", format: "esm", target: "node22", outdir: TEMP, outExtension: { ".js": ".mjs" },
  plugins: cloudRunBuildPlugins(ROOT), external: ["pg"], mainFields: ["module", "main"], logLevel: "silent" });
const { computeAnalyticsV2, proofInput, ANALYTICS_V2_DEFAULT_RESOURCES } = await import(pathToFileURL(join(TEMP, "proof.mjs")));
const MIB = 1048576;
const input = proofInput();
const clean = (output) => ({ ...output, timings: null,
  resources: { ...output.resources, owners: output.resources.owners.map((owner) => ({ ...owner, heapPeakBytes: null })) } });
let inlineDigest;
const inline = clean(await computeAnalyticsV2({ ...input, emissionSequenceDigest: (value) => { inlineDigest = value; } }));
async function run(workers, size, extra = {}) {
  const pool = createAnalyticsRefreshOwnerPool({ workers, memoryBudgetBytes: ANALYTICS_V2_DEFAULT_RESOURCES.memoryBudgetBytes,
    poolBytes: 8192 * MIB, modelBlockSize: size, modelFanOut: "all",
    workerUrl: pathToFileURL(join(TEMP, "analytics-refresh-worker.mjs")), ...extra });
  let sequence;
  try {
    const occurrences = input.occurrencesByOwner;
    const evidence = new Map([...occurrences].map(([owner, days]) => [owner, new Map([...days].map(([day, rows]) => [day, { usage: rows.usage.length, quota: rows.quota.length, session: rows.session.length }]))]));
    const outputs = await computeAnalyticsV2({ ...input, occurrencesByOwner: new Map(), ownerEvidence: evidence,
      loadOwnerOccurrences: async (owner, range, onPart) => {
        const days = new Map([...occurrences.get(owner)].filter(([day]) => day >= range.fromDay && day <= range.throughDay));
        if (onPart !== undefined) {
          let ordinal = 0;
          for (const stream of ["usage", "quota", "session"]) {
            await onPart(stream, new Map([...days].map(([day, rows]) => [day, rows[stream]])), ordinal++);
          }
          return null;
        }
        return days;
      }, ownerPool: pool, emissionSequenceDigest: (value) => { sequence = value; } });
    assert.deepEqual(clean(outputs), inline);
    assert.equal(sequence, inlineDigest, "exact production merge sequence digest");
    return pool.stats();
  } finally { await pool.abort(); assert.equal(pool.running, 0); }
}

for (const extension of [false, true]) test(`real bundled owner and model-block capture preserves exact inline outputs (extension=${extension})`, { timeout: 60000 }, async () => {
  const directory = join(TEMP, extension ? "extended-captures" : "captures");
  const captures = createWorkerProfileCoordinator({ directory, source: "a".repeat(40), ...(extension ? { allocation: true, memory: true } : {}) },
    { workerUrl: pathToFileURL(join(TEMP, "analytics-refresh-worker.mjs")), runId: "synthetic-fixture" });
  const stats = await run(8, 14, { profileCapture: captures });
  captures.finish();
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.ok(stats.blockGrantsGranted > 0);
  assert.ok(manifest.captures.some((capture) => capture.role === "owner"));
  assert.ok(manifest.captures.some((capture) => capture.role === "model-block"));
  assert.equal(manifest.skipped, 0);
  if (extension) {
    assert.equal(manifest.completeCoverage, false, "bounded phase history overflow is explicitly incomplete");
    assert.ok(manifest.captures.some((capture) => capture.extension?.phases.error === "PHASE_PROFILE_TRUNCATED"));
  } else assert.equal(manifest.completeCoverage, true);
  for (const capture of manifest.captures) {
    if (extension && capture.extension.phases.error !== null) assert.equal(capture.error, "WORKER_PROFILE_EXTENSION_FAILED");
    else assert.equal(capture.error, null);
    assert.ok(Number.isInteger(capture.termination.exitCode));
    assert.ok(capture.profileSha256);
    if (extension) {
      assert.ok(capture.extension.allocation.sha256);
      assert.ok(capture.extension.memory.sha256);
      assert.ok(capture.extension.phases.sha256);
    }
    assert.ok(capture.startInspectorMs >= 0);
    assert.ok(capture.stopAndPersistMs >= 0);
  }
  console.log(JSON.stringify({ captures: manifest.captures.length, roles: [...new Set(manifest.captures.map((capture) => capture.role))], completeCoverage: manifest.completeCoverage, exactInlineParity: true }));
});
