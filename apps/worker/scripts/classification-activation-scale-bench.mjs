// Local-only activation cost bench on a disposable schema. Output is
// aggregate (statement family, call count, milliseconds); no SQL values,
// identifiers or record content are printed. Not part of any gate.
//
//   PG_TEST_SOCKET=/private/tmp/tibotattle-pg-<name>/socket PG_TEST_PORT=55567 \
//     node scripts/classification-activation-scale-bench.mjs --format 11 --days 8 --per-day 1000
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "./postgres-migrations.mjs";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";
import {
  enableScaleV12, grantScaleV11, initializeScaleV11, prepareScaleSchema, scaleDays, scaleSession, scaleUsage,
  scaleV11DomainManifest, scaleV12DomainManifest, seedScaleDevice, seedScaleParticipant, stageScaleV11Day,
  stageScaleV12Day, statementTimer, summarize, SCALE_NAMESPACE,
} from "../postgres-test/fixtures/classification-scale.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  format: { type: "string", default: "11" }, days: { type: "string", default: "4" },
  "per-day": { type: "string", default: "400" }, keep: { type: "boolean", default: false },
  explain: { type: "string", default: "" }, "explain-step": { type: "string", default: "" }, "no-analyze": { type: "boolean", default: false }, "link-index": { type: "boolean", default: false }, steps: { type: "string", default: "baseline,append,correct" },
} });
const format = Number(values.format); const dayCount = Number(values.days); const perDay = Number(values["per-day"]);
assert.ok([11, 12].includes(format) && dayCount > 0 && perDay > 0);

const socket = process.env.PG_TEST_SOCKET;
assert.match(socket ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
assert.equal((await lstat(socket)).isSymbolicLink(), false);
assert.equal((await stat(await realpath(socket))).mode & 0o077, 0);
const pool = new pg.Pool({ host: socket, port: Number(process.env.PG_TEST_PORT ?? "55567"), user: "postgres",
  password: "synthetic-local-only", database: "postgres", ssl: false, max: 2, application_name: "classification-scale-bench" });
const timer = statementTimer(pool);
assert.equal((await pool.query("SELECT inet_server_addr() AS a")).rows[0].a, null, "socket-only local server");
const vite = await createServer({ root: WORKER_ROOT, configFile: false, logLevel: "silent",
  plugins: analyticsV2Config.plugins, resolve: analyticsV2Config.resolve,
  server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom" });
const modules = {
  ...await vite.ssrLoadModule("/src/postgres-typed-v12-domain.ts"),
  ...await vite.ssrLoadModule("/src/postgres-typed-v12-admission.ts"),
  live: await vite.ssrLoadModule("/src/postgres-telemetry-v11-live-admission.ts"),
  transport: await vite.ssrLoadModule("/src/postgres-typed-v12-transport.ts"),
};
const schema = `classification_scale_${randomBytes(5).toString("hex")}`;
const report = { format, days: dayCount, perDay, steps: [] };
try {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await applyPostgresMigrations({ role: "primary", schema, pool });
  await prepareScaleSchema(pool, schema);
  const options = { schema: { primarySchema: schema }, sourceNamespace: SCALE_NAMESPACE };
  if (values["link-index"]) {
    // Candidate follow-up index, created only in this disposable schema: the
    // link predicate and readLinks never bind participant_id, the leading
    // column of the only covering index, so each probe scans every link.
    await pool.query(`CREATE INDEX ON "${schema}".telemetry_classification_correction_links (device_id,occurrence_id)`);
    await pool.query(`CREATE INDEX ON "${schema}".telemetry_classification_correction_links (participant_id,stream,occurrence_id)`);
  }
  const participant = await seedScaleParticipant(pool, schema, "bench");
  const principal = await seedScaleDevice(pool, schema, participant, "bench", { v12: false });
  if (format === 11) {
    await initializeScaleV11(modules, pool, schema, options);
    await grantScaleV11(modules, pool, participant, principal, options);
  } else await enableScaleV12(pool, schema, principal);
  const domain = format === 11 ? modules.live.createPostgresTelemetryV11Domain(pool, options)
    : modules.createPostgresTypedV12Domain(pool, options);
  const stageDay = format === 11 ? stageScaleV11Day : stageScaleV12Day;
  const domainManifest = format === 11 ? scaleV11DomainManifest : scaleV12DomainManifest;
  // A v1.1 predecessor always covers today, so every synthetic domain ends today.
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const days = scaleDays(dayCount, new Date(today - (dayCount - 1) * 86_400_000).toISOString().slice(0, 10));
  // One session per day (a session occurrence is unique across the domain).
  const records = (day, labels, extra = 0) => [scaleSession(format, day, days.indexOf(day), labels.provider),
    ...Array.from({ length: perDay + extra }, (_, index) => scaleUsage(format, day, index,
      { ...labels, session: days.indexOf(day) }))];
  const unknown = { provider: "unknown", modelId: "unknown" };
  const known = { provider: "openai_codex", modelId: "gpt-6.1-sol" };
  // Production tables carry autovacuum statistics; a fresh schema has none.
  const analyze = async () => {
    const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname=$1`, [schema])).rows;
    for (const { tablename } of tables) await pool.query(`ANALYZE "${schema}"."${tablename}"`);
  };
  const run = async (name, staged) => {
    if (!values["no-analyze"]) await analyze();
    const manifest = domainManifest(await domain.createPredecessor(principal), staged);
    timer.start();
    const started = process.hrtime.bigint();
    let outcome = "activated";
    try { await domain.activate(principal, manifest); }
    catch (error) { outcome = error.code ?? error.status ?? "error"; }
    const wallMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    const entries = timer.stop();
    const links = (await pool.query(`SELECT count(*)::integer AS n FROM "${schema}".telemetry_classification_correction_links`)).rows[0].n;
    report.steps.push({ name, outcome, wallMs, statements: entries.length, links, families: summarize(entries) });
    if (values.explain && name === (values["explain-step"] || name)) {
      // Re-plan the slowest statement of a family on the committed state.
      // Plans name only synthetic relations; they are printed to stderr.
      for (const family of values.explain.split(",")) {
        const entry = entries.filter((item) => item.family === family).sort((a, b) => b.ms - a.ms)[0];
        if (!entry) continue;
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS, TIMING OFF) ${entry.text}`, entry.values)).rows
            .map((row) => row["QUERY PLAN"]).join("\n");
          console.error(`---- ${name} ${family} (${Math.round(entry.ms)} ms) ----\n${plan}`);
        } finally { await client.query("ROLLBACK"); client.release(); }
      }
    }
    return outcome;
  };
  const steps = new Set(values.steps.split(","));
  const stagedStart = process.hrtime.bigint();
  let current = [];
  for (const day of days) current.push(await stageDay(modules, pool, schema, options, principal, day, records(day, unknown)));
  report.stageMs = Math.round(Number(process.hrtime.bigint() - stagedStart) / 1e6);
  await run("baseline", current);
  if (steps.has("append")) {
    const last = await stageDay(modules, pool, schema, options, principal, days.at(-1), records(days.at(-1), unknown, 1));
    current = [...current.slice(0, -1), last];
    await run("append", current);
  }
  if (steps.has("correct")) {
    const corrected = [];
    for (const day of days) corrected.push(await stageDay(modules, pool, schema, options, principal, day,
      records(day, known, day === days.at(-1) && steps.has("append") ? 1 : 0)));
    await run("correct", corrected);
    if (steps.has("after")) {
      const again = await stageDay(modules, pool, schema, options, principal, days.at(-1),
        records(days.at(-1), known, 2));
      await run("after-correct-append", [...corrected.slice(0, -1), again]);
    }
  }
  console.log(JSON.stringify(report, null, 1));
} finally {
  if (!values.keep) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  else console.error(`kept schema ${schema}`);
  await pool.end(); await vite.close();
}
