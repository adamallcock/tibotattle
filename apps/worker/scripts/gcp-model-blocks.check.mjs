/** Synthetic real-isolate MODEL-BLOCKS proof. No database, private evidence or stamped build. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { Worker } from "node:worker_threads";
import { serialize } from "node:v8";
import { createAnalyticsRefreshOwnerPool } from "../cloud-run/analytics-refresh-pool.mjs";
import { analyticsRefreshSerializationBound } from "../cloud-run/analytics-refresh-worker.mjs";
import { cloudRunBuildPlugins } from "../cloud-run/node-host-build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMP = await mkdtemp(join(tmpdir(), "tibotattle-model-blocks-proof-"));
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

test("pre-serialization bound dominates actual V8 buffers on closed plain graphs", () => {
  const shared = { strings: ["a".repeat(30000), "🦉".repeat(30000), "\ud800".repeat(30000)], rows: [1, null, true, undefined] };
  const value = { owner: shared, map: new Map([["one", shared], ["two", shared]]), rows: Array.from({ length: 100 }, () => shared) };
  assert.ok(analyticsRefreshSerializationBound(value) >= serialize(value).byteLength);
});
for (const workers of [2, 4, 8]) for (const size of [1, 5, 14, 70]) {
  test(`real Workers W=${workers} b=${size}: ordered rows/refusals/budget and merge sequence`, { timeout: 60000 }, async () => {
    const stats = await run(workers, size);
    assert.ok(stats.modelBlockedOwners > 0);
    assert.ok(stats.modelBlocksPerOwner.every((owner) => owner.blocks === Math.ceil(70 / size)));
    assert.equal(stats.blockGrantsRequested, stats.blockGrantsGranted + stats.blockGrantsRefused);
    if (workers === 8 && size < 70) assert.ok(stats.blockGrantsGranted > 0, "real block path exercised");
    if (size === 70) assert.equal(stats.blockGrantsGranted, 0, "one last block is evaluated by its owner");
    console.log(JSON.stringify({ workers, size, sequenceDigest: inlineDigest, blockedOwners: stats.modelBlockedOwners,
      granted: stats.blockGrantsGranted, refused: stats.blockGrantsRefused }));
  });
}
test("real child failure discards first owner attempt and recomputes once alone without fan-out", { timeout: 60000 }, async () => {
  let injected = false;
  const stats = await run(8, 5, { createWorker: (url, options) => {
    const worker = new Worker(url, options);
    if (options.workerData.block && !injected) {
      injected = true;
      worker.once("message", () => worker.emit("error", Object.assign(new Error("synthetic OOM"), { code: "ERR_WORKER_OUT_OF_MEMORY" })));
    }
    return worker;
  } });
  assert.ok(injected);
  assert.equal(stats.retriedAlone, 1);
});
