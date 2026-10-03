/**
 * Content-free READ-PLAN A/B over one already-imported synthetic schema and
 * one exported snapshot. Never imports data. Both roots load their public
 * readers with their own Vite configuration. Output is counts/timings/digests;
 * neither ids, values, SQL nor driver errors are emitted.
 *
 * --base-root <checkout> --schema <synthetic schema> --from YYYY-MM-DD
 * --through YYYY-MM-DD [--first-through YYYY-MM-DD] [--bench]
 * PG_TEST_SOCKET/PG_TEST_PORT select a private local cluster. Large corpus
 * runs and --bench require the coordinator's resource reservation first.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lstat, realpath, stat } from "node:fs/promises";
import { createServer } from "vite";
import pg from "pg";
import { analyticsRefreshRangeChunks, createSnapshotReadPool } from "../cloud-run/analytics-refresh-read.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STREAMS = ["usage", "quota", "session"];
const FLOOR = new Date(-100_000 * 86_400_000).toISOString().slice(0, 10);
const canonical = (value) => value instanceof Map ? [...value].map(([key, item]) => [key, canonical(item)])
  : value instanceof Uint8Array ? Buffer.from(value).toString("hex")
  : Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  : value;
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const outcome = async (operation) => {
  try { return { value: await operation() }; }
  catch (error) {
    assert.match(error.code ?? "", /^(?:ANALYTICS_V2_[A-Z0-9_]+|unavailable|timeout|conflict|invalid)$/u);
    return { refusal: error.code };
  }
};
function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--bench") { result.bench = true; continue; }
    assert.ok(["--base-root", "--schema", "--from", "--through", "--first-through"].includes(key), "invalid_argument");
    assert.ok(argv[index + 1] && !argv[index + 1].startsWith("--"), "missing_argument");
    result[key.slice(2)] = argv[++index];
  }
  assert.match(result.schema ?? "", /^[a-z_][a-z0-9_]{0,62}$/u);
  for (const name of ["from", "through"]) assert.match(result[name] ?? "", /^\d{4}-\d{2}-\d{2}$/u);
  assert.ok(result.from <= result.through && result["base-root"]);
  result.firstThrough = result["first-through"] ?? result.through;
  assert.ok(result.firstThrough <= result.through);
  return result;
}
async function load(root) {
  const config = (await import(pathToFileURL(resolve(root, "vitest.analytics-v2.config.mjs")))).default;
  const vite = await createServer({ root, configFile: false, logLevel: "error", plugins: config.plugins, resolve: config.resolve,
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  return { vite, owners: await vite.ssrLoadModule("/src/analytics-v2/owners.ts"),
    occurrences: await vite.ssrLoadModule("/src/analytics-v2/occurrence-source.ts") };
}
export async function readPlanAB(argv = process.argv.slice(2)) {
  const opts = options(argv);
  const socket = process.env.PG_TEST_SOCKET;
  assert.match(socket ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.equal((await lstat(socket)).isSymbolicLink(), false);
  assert.equal(await realpath(socket), socket);
  assert.equal((await stat(socket)).mode & 0o077, 0);
  const port = Number(process.env.PG_TEST_PORT);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535 && ![55432, 55433].includes(port));
  const pool = new pg.Pool({ host: socket, port, user: process.env.PG_TEST_USER ?? "postgres",
    database: process.env.PG_TEST_DATABASE ?? "postgres", ssl: false, max: 5, connectionTimeoutMillis: 5_000 });
  let base, head, exporter, reads;
  try {
    base = await load(resolve(opts["base-root"], "apps/worker"));
    head = await load(ROOT);
    exporter = await pool.connect();
    await exporter.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = (await exporter.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
    reads = createSnapshotReadPool(pool, snapshot);
    const statements = [];
    const explainQueue = [];
    let phase = "setup";
    const monitoredPool = { connect: async () => {
      const client = await reads.connect();
      return { release: (...args) => client.release(...args), query: async (...args) => {
        const sql = typeof args[0] === "string" ? args[0] : args[0].text;
        const values = typeof args[0] === "string" ? args[1] : args[0].values;
        const family = /^\/\* analytics_v2:(occurrences\.(?:counts|first_evidence|legacy_candidates)) \*\//u.exec(sql)?.[1];
        const start = performance.now();
        const result = await client.query(...args);
        if (family) {
          const entry = { phase, family, wallMs: performance.now() - start, aggregateRows: result.rows.length };
          if (opts.bench) {
            assert.ok(explainQueue.length < 25_000, "explain_capacity");
            explainQueue.push({ entry, sql, values });
          }
          statements.push(entry);
        }
        return result;
      } };
    } };
    const context = { pool: monitoredPool, schema: opts.schema, nowMs: Date.parse(`${opts.firstThrough}T12:00:00Z`) };
    const listing = await head.owners.listAnalyticsV2Owners(context);
    const owners = listing.owners;
    const effectiveOwners = owners.filter((owner) => owner.source === "effective");
    const spans = analyticsRefreshRangeChunks({ fromDay: opts.from, throughDay: opts.through }, 400);
    const report = { method: "analytics-v2-read-plan-ab-v1", owners: owners.length, spans: spans.length,
      comparisons: [], planTimings: [], concurrencyTimings: [], statements };
    for (const [ownerIndex, owner] of owners.entries()) {
      const ownerDigest = owner.ownerDigest;
      const planOptions = { ownerDigest, streams: STREAMS, fromDay: FLOOR, throughDay: opts.through,
        firstEvidenceThroughDay: opts.firstThrough };
      phase = `head-plan-${ownerIndex}`;
      const start = performance.now();
      const planned = await outcome(() => head.occurrences.readOwnerEvidencePlan(context, planOptions));
      const planMs = performance.now() - start;
      phase = `base-first-${ownerIndex}`;
      const oldStart = performance.now();
      const oldFirst = await outcome(() => base.occurrences.readOwnerFirstEvidenceDay(context,
        { ownerDigest, throughDay: opts.firstThrough }));
      let baseEvidenceMs = performance.now() - oldStart;
      const firstDays = planned.value ? [...planned.value.values()].map((part) => part.firstEvidenceDay).filter((day) => day !== null).sort() : [];
      assert.deepEqual(planned.refusal ? { refusal: planned.refusal } : { value: firstDays[0] ?? null }, oldFirst);
      for (const stream of STREAMS) for (const [spanIndex, span] of spans.entries()) {
        const request = { ownerDigest, stream, ...span };
        for (const method of ["countOwnerOccurrences", "readOwnerOccurrences"]) {
          phase = `base-${ownerIndex}-${stream}-${spanIndex}-${method}`;
          const beforeStart = performance.now();
          const before = await outcome(() => base.occurrences[method](context, request));
          if (method === "countOwnerOccurrences") baseEvidenceMs += performance.now() - beforeStart;
          phase = `head-${ownerIndex}-${stream}-${spanIndex}-${method}`;
          const after = await outcome(() => head.occurrences[method](context, request));
          assert.deepEqual(after, before);
          report.comparisons.push({ ownerIndex, stream, spanIndex, method, sha256: digest(after),
            days: after.value instanceof Map ? after.value.size : null, refusal: after.refusal ?? null });
          if (method === "countOwnerOccurrences" && planned.value) {
            assert.deepEqual(await outcome(() => head.occurrences.countOwnerEvidencePlanRange(context, planned.value, request)), before);
          }
        }
      }
      report.planTimings.push({ ownerIndex, planMs, baseFirstAndCountsMs: baseEvidenceMs,
        firstSha256: digest(oldFirst) });
    }
    if (opts.bench) {
      // Explain sequentially after timing/parity. No EXPLAIN execution time
      // contaminates the reader client-wall measurements above.
      const client = await reads.connect();
      try {
        for (const { entry, sql, values } of explainQueue) {
          const explain = await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values);
          const root = explain.rows[0]["QUERY PLAN"][0];
          Object.assign(entry, { serverMs: root["Execution Time"], planCost: root.Plan["Total Cost"],
            sharedHits: root.Plan["Shared Hit Blocks"] ?? 0, sharedReads: root.Plan["Shared Read Blocks"] ?? 0,
            tempReads: root.Plan["Temp Read Blocks"] ?? 0, tempWrites: root.Plan["Temp Written Blocks"] ?? 0 });
        }
      } finally { await client.release(); }
    }
    if (opts.bench) {
      // Concurrency wall excludes the separate EXPLAIN runs above: reuse the
      // actual Job snapshot pool directly for this pass.
      const concurrentContext = { ...context, pool: reads };
      for (const concurrency of [1, 2, 3, 4]) {
        let cursor = 0;
        const start = performance.now();
        await Promise.all(Array.from({ length: concurrency }, async () => {
          while (cursor < effectiveOwners.length) {
            const owner = effectiveOwners[cursor++];
            await head.occurrences.readOwnerEvidencePlan(concurrentContext, { ownerDigest: owner.ownerDigest,
              streams: STREAMS, fromDay: FLOOR, throughDay: opts.through, firstEvidenceThroughDay: opts.firstThrough });
          }
        }));
        report.concurrencyTimings.push({ concurrency, wallMs: performance.now() - start });
      }
    }
    return report;
  } finally {
    if (reads) await reads.close();
    if (exporter) { await exporter.query("ROLLBACK"); exporter.release(); }
    await pool.end();
    await base?.vite.close();
    await head?.vite.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await readPlanAB())}\n`); }
  catch { process.stderr.write("READ_PLAN_AB_FAILED\n"); process.exitCode = 1; }
}
