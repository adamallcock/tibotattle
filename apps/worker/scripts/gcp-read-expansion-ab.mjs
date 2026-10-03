/** Local, read-only differential reader check; aggregate receipts only. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { build } from "esbuild";
import { analyticsRefreshRangeChunks, analyticsRefreshReadSpans,
  ANALYTICS_REFRESH_DEFAULT_READ_CHUNK_OCCURRENCES, ANALYTICS_REFRESH_MAX_READ_CANDIDATES } from "../cloud-run/analytics-refresh-read.mjs";

const exec = promisify(execFile);
const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(WORKER, "../..");
export const DEFAULT_BASE = "48c26716a478bf92a830c27ea9c8ab7a90a0d929";
const sha = (value) => createHash("sha256").update(value).digest("hex");

/** Two independent module graphs in one process, with a retained committed base. */
export async function loadExpansionReaders({ base = DEFAULT_BASE, candidateSourceTransform } = {}) {
  assert.match(base, /^[0-9a-f]{40}$/u);
  const scratch = await mkdtemp("/private/tmp/tibotattle-readexp-ab-");

  try {
    await symlink(join(WORKER, "node_modules"), join(scratch, "node_modules"));
    const archive = join(scratch, "base.tar");
    await exec("git", ["archive", "--format=tar", "--output", archive, base], { cwd: ROOT });
    const tree = join(scratch, "base");
    await mkdir(tree);
    await exec("tar", ["-xf", archive, "-C", tree]);
    for (const area of ["", "apps/worker", "apps/worker/cloud-run"]) {
      await symlink(join(ROOT, area, "node_modules"), join(tree, area, "node_modules"));
    }
    const readers = [];
    for (const [index, worker] of [join(tree, "apps/worker"), WORKER].entries()) {
      const entry = join(scratch, `reader-${index}-entry.mjs`);
      const outfile = join(scratch, `reader-${index}.mjs`);
      await writeFile(entry, `export * as occurrences from ${JSON.stringify(join(worker, "src/analytics-v2/occurrence-source.ts"))};\n`
        + `export * as owners from ${JSON.stringify(join(worker, "src/analytics-v2/owners.ts"))};\n`);
      const { cloudRunBuildPlugins } = await import(pathToFileURL(join(worker, "cloud-run/node-host-build.mjs")));
      const mutation = index === 1 && candidateSourceTransform ? [{ name: "read-expansion-negative-control",
        setup(plugin) { plugin.onLoad({ filter: /occurrence-source\.ts$/ }, async (args) => ({
          contents: candidateSourceTransform(await readFile(args.path, "utf8")), loader: "ts", resolveDir: dirname(args.path),
        })); },
      }] : [];
      await build({ entryPoints: [entry], outfile, absWorkingDir: join(worker, "cloud-run"),
        plugins: [...mutation, ...cloudRunBuildPlugins(worker)], bundle: true, platform: "node", format: "esm", target: "node22",
        external: ["jsonc-parser", "pg", "@google-cloud/cloud-sql-connector", "google-auth-library"],
        logLevel: "silent" });
      readers.push(await import(pathToFileURL(outfile)));
    }
    return { base: readers[0], candidate: readers[1], close: () => rm(scratch, { recursive: true }) };
  } catch (error) {
    await rm(scratch, { recursive: true });
    throw error;
  }
}

export async function compareExpansionRead(readers, context, options) {
  const outcome = async (reader, method, input) => {
    try { return { value: JSON.stringify([...await reader.occurrences[method](context, input)]) }; }
    catch (error) { return { error: { name: error?.constructor?.name, code: error?.code ?? error?.reason ?? null } }; }
  };
  const old = await outcome(readers.base, "readOwnerOccurrences", options);
  const next = await outcome(readers.candidate, "readOwnerOccurrences", options);
  assert.equal(sha(JSON.stringify(next)), sha(JSON.stringify(old)), "reader output/refusal bytes differ");
  const { stream: _stream, ...range } = options;
  const oldFingerprints = await outcome(readers.base, "readOwnerDayFingerprints", range);
  const nextFingerprints = await outcome(readers.candidate, "readOwnerDayFingerprints", range);
  assert.equal(sha(JSON.stringify(nextFingerprints)), sha(JSON.stringify(oldFingerprints)), "fingerprint output/refusal bytes differ");
  return { occurrenceSha256: sha(JSON.stringify(next)), fingerprintSha256: sha(JSON.stringify(nextFingerprints)) };
}

async function main() {
  const schema = process.env.READ_EXPANSION_SCHEMA;
  assert.match(schema ?? "", /^[a-z][a-z0-9_]{0,62}$/u);
  assert.equal(process.env.PG_TEST_HOST, "127.0.0.1", "CLI permits loopback only");
  const port = Number(process.env.PG_TEST_PORT);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
  const nowMs = Number(process.env.READ_EXPANSION_NOW_MS);
  assert.ok(Number.isSafeInteger(nowMs) && nowMs >= 0);
  const pool = new pg.Pool({ host: "127.0.0.1", port, database: process.env.PG_TEST_DATABASE ?? "postgres",
    user: process.env.PG_TEST_USER ?? "postgres", max: 3 });
  let readers;
  let exporter;
  let calls = 0;
  const receipts = [];
  try {
    readers = await loadExpansionReaders({ base: process.env.READ_EXPANSION_BASE ?? DEFAULT_BASE });
    exporter = await pool.connect();
    await exporter.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshotId = (await exporter.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
    assert.match(snapshotId, /^[0-9A-F]+-[0-9A-F]+-[0-9]+$/u);
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(`SET TRANSACTION SNAPSHOT '${snapshotId}'`);
      const context = { pool, client, schema, nowMs };
      const roster = await readers.base.owners.listAnalyticsV2Owners(context);
      const throughDay = process.env.READ_EXPANSION_THROUGH_DAY ?? new Date(nowMs).toISOString().slice(0, 10);
      assert.match(throughDay, /^\d{4}-\d{2}-\d{2}$/u);
      const readChunk = Number(process.env.READ_EXPANSION_READ_CHUNK ?? ANALYTICS_REFRESH_DEFAULT_READ_CHUNK_OCCURRENCES);
      assert.ok(Number.isSafeInteger(readChunk) && readChunk >= 1 && readChunk <= ANALYTICS_REFRESH_MAX_READ_CANDIDATES);
      for (const owner of roster.owners.filter((entry) => entry.source === "effective")) {
        const firstDay = await readers.base.occurrences.readOwnerFirstEvidenceDay(context, { ownerDigest: owner.ownerDigest });
        if (firstDay === null) continue;
        const range = { fromDay: firstDay, throughDay };
        for (const stream of ["usage", "quota", "session"]) {
          const counts = new Map();
          for (const span of analyticsRefreshRangeChunks(range, 400)) {
            for (const [day, count] of await readers.base.occurrences.countOwnerOccurrences(context,
              { ownerDigest: owner.ownerDigest, stream, ...span })) counts.set(day, count);
          }
          for (const span of analyticsRefreshReadSpans(range, 400, counts, readChunk)) {
            const options = { ownerDigest: owner.ownerDigest, stream, fromDay: span.fromDay, throughDay: span.throughDay,
              maxCandidates: Math.min(ANALYTICS_REFRESH_MAX_READ_CANDIDATES, Math.max(readChunk, span.occurrences)) };
            receipts.push(await compareExpansionRead(readers, context, options));
            calls += 1;
          }
        }
      }
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    await exporter.query("ROLLBACK");
    console.log(JSON.stringify({ status: "ok", base: process.env.READ_EXPANSION_BASE ?? DEFAULT_BASE,
      comparisons: calls, aggregateSha256: sha(JSON.stringify(receipts)) }));
  } finally {
    if (exporter) {
      await exporter.query("ROLLBACK").catch(() => {});
      exporter.release();
    }
    if (readers) await readers.close();
    await pool.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(JSON.stringify({ status: "error", code: "READ_EXPANSION_AB_FAILED" })); process.exitCode = 1; });
}
