import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import config from "../vitest.analytics-v2.config.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { loadExpansionReaders, compareExpansionRead } from "../scripts/gcp-read-expansion-ab.mjs";
import { seedAnalyticsV2Fixture, D1, NOW_MS } from "./fixtures/analytics-v2/direct-seed.mjs";

const socket = process.env.PG_TEST_SOCKET;
const host = process.env.PG_TEST_HOST;
const skip = !socket && !host;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Fixed labels and aggregate timing only: never emit SQL, binds, rows or identities.
function boundaryDiagnostics(family) {
  const started = performance.now();
  const milliseconds = (value) => Math.round(value * 1000) / 1000;
  let activeStage;
  const emit = (details) => console.log(JSON.stringify({
    event: "read_expansion_boundary_timing", family,
    elapsedMs: milliseconds(performance.now() - started), ...details,
  }));
  const queryKind = (args) => {
    const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
    if (sql.includes("occurrences.legacy_sources")) return "legacy_expansion";
    if (sql.includes("occurrences.v12_sources")) return "v12_expansion";
    if (sql.includes("snapshot.plan_cache")) return "plan_cache";
    if (sql.startsWith("INSERT INTO ") && sql.includes('."telemetry_v12_typed_records"')) return "v12_parent_insert";
    if (sql.startsWith("INSERT INTO ") && sql.includes('."telemetry_v12_typed_usage"')) return "v12_usage_insert";
    if (sql.startsWith("UPDATE ") && sql.includes('."telemetry_v12_day_manifests"')) return "v12_manifest_ready";
    return "other";
  };
  return {
    reader(reader, method) {
      activeStage.reader = reader;
      activeStage.method = method;
      emit({ stage: activeStage.stage, reader, method, state: "reader_started" });
    },
    async stage(stage, operation) {
      const current = { stage, started: performance.now(), queries: new Map() };
      activeStage = current;
      let completed = false;
      emit({ stage, state: "started" });
      try {
        const result = await operation();
        completed = true;
        return result;
      } finally {
        emit({ stage, state: "finished", completed,
          durationMs: milliseconds(performance.now() - current.started),
          queries: [...current.queries.values()].map((entry) => ({ ...entry,
            totalMs: milliseconds(entry.totalMs), maxMs: milliseconds(entry.maxMs) })),
        });
        activeStage = undefined;
      }
    },
    async query(receiver, query, args) {
      const current = activeStage;
      if (!current) return Reflect.apply(query, receiver, args);
      const kind = queryKind(args);
      const metric = current.queries.get(kind) ?? { kind, count: 0, failed: 0, totalMs: 0, maxMs: 0 };
      current.queries.set(kind, metric);
      const expansion = kind === "legacy_expansion" || kind === "v12_expansion";
      const queryNumber = metric.count + 1;
      const reader = { reader: current.reader, method: current.method };
      const before = performance.now();
      let result;
      let completed = false;
      if (expansion) emit({ stage: current.stage, ...reader, kind, queryNumber, state: "query_started" });
      try {
        result = await Reflect.apply(query, receiver, args);
        completed = true;
        return result;
      } finally {
        const elapsed = performance.now() - before;
        metric.count += 1;
        metric.failed += Number(!completed);
        metric.totalMs += elapsed;
        metric.maxMs = Math.max(metric.maxMs, elapsed);
        if (expansion) emit({ stage: current.stage, ...reader, kind, queryNumber, state: "query_finished",
          completed, durationMs: milliseconds(elapsed), rows: result?.rows?.length ?? null });
        const settings = result?.rows?.[0];
        if (kind === "plan_cache" && ["auto", "force_generic_plan", "force_custom_plan"].includes(settings?.previous)) {
          emit({ stage: current.stage, ...reader, state: "reader_previous_settings", planCache: settings.previous,
            jit: ["on", "off"].includes(settings.previous_jit) ? settings.previous_jit : null,
            workMem: typeof settings.previous_work_mem === "string" && /^[0-9]{1,8}(?:kB|MB|GB)$/u.test(settings.previous_work_mem)
              ? settings.previous_work_mem : null });
        }
        if (completed && kind === "v12_manifest_ready" && metric.count % 25 === 0) {
          emit({ stage: current.stage, state: "seed_progress", readyManifests: metric.count });
        }
      }
    },
  };
}

function observeOccurrenceReads(readers, occurrenceReads, diagnostics) {
  return Object.fromEntries(["base", "candidate"].map((readerName) => {
    const reader = readers[readerName];
    const occurrences = reader.occurrences;
    return [readerName, { ...reader, occurrences: { ...occurrences,
      readOwnerOccurrences(...args) {
        diagnostics.reader(readerName, "occurrences");
        const promise = Reflect.apply(occurrences.readOwnerOccurrences, occurrences, args);
        occurrenceReads.push({ readerName, promise });
        return promise;
      },
      readOwnerDayFingerprints(...args) {
        diagnostics.reader(readerName, "fingerprints");
        return Reflect.apply(occurrences.readOwnerDayFingerprints, occurrences, args);
      },
    } }];
  }));
}

// No altered driver rows, lowered bounds, trigger bypasses or dropped constraints:
// these tests count the rows actually returned by each production SQL statement.
for (const family of ["legacy", "v12"]) {
  test(`real ${family} SQL accepts 40000 variants and refuses 40001 in one 200-id batch`,
    { skip, timeout: 600_000 }, async () => {
      assert.ok(!host || ["127.0.0.1", "localhost", "::1"].includes(host));
      if (socket) {
        assert.match(socket, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
        assert.equal((await lstat(socket)).isSymbolicLink(), false);
        assert.equal(await realpath(socket), socket);
        const metadata = await stat(socket);
        assert.equal(metadata.mode & 0o077, 0);
        assert.equal(metadata.uid, process.getuid());
      }
      const port = Number(process.env.PG_TEST_PORT ?? "55433");
      assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
      const pool = new pg.Pool({ host: socket || host, port,
        user: process.env.PG_TEST_USER ?? "postgres", database: process.env.PG_TEST_DATABASE ?? "postgres",
        password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only", ssl: false, max: 2,
        application_name: "read-expansion-real-boundaries" });
      const diagnostics = boundaryDiagnostics(family);
      const poolQuery = pool.query;
      pool.query = (...args) => diagnostics.query(pool, poolQuery, args);
      const schema = `readexp_boundary_${randomBytes(6).toString("hex")}`;
      let vite;
      let readers;
      let created = false;
      try {
        await diagnostics.stage("database_setup", async () => {
          const version = (await pool.query("SELECT current_setting('server_version_num')::integer AS version")).rows[0].version;
          assert.equal(Math.floor(version / 10_000), 17);
          await pool.query(`CREATE SCHEMA "${schema}"`);
          created = true;
        });
        await diagnostics.stage("migrations", () => applyPostgresMigrations({ role: "primary", schema, pool }));
        const modules = await diagnostics.stage("fixture_modules", async () => {
          vite = await createServer({ root, configFile: false, plugins: config.plugins, resolve: config.resolve,
            logLevel: "error", server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
          return {
            codec: await vite.ssrLoadModule("/src/typed-telemetry-codec.ts"),
            v12codec: await vite.ssrLoadModule("/src/telemetry-v12-typed-codec.ts"),
            reconciliation: await vite.ssrLoadModule("/src/telemetry-usage-reconciliation.ts"),
            sha256Hex: (await vite.ssrLoadModule("/src/crypto.ts")).sha256Hex,
          };
        });
        const { boundary } = await diagnostics.stage("seed", () => seedAnalyticsV2Fixture({ pool, schema, modules,
          correctionRuntime: "staged", expansionBoundary: family }));
        assert.equal(boundary.occurrenceIds.length, 200);
        await diagnostics.stage("analyze", async () => {
          const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema]);
          for (const { tablename } of tables.rows) {
            assert.match(tablename, /^[a-z_][a-z0-9_]*$/u);
            await pool.query(`ANALYZE "${schema}"."${tablename}"`);
          }
        });
        readers = await diagnostics.stage("bundle_readers", () => loadExpansionReaders());
        for (const reader of [readers.base, readers.candidate]) {
          assert.equal(reader.occurrences.MAX_ANALYTICS_V2_BATCH_SOURCE_ROWS, 40000);
          assert.equal(reader.occurrences.MAX_ANALYTICS_V2_BATCH_V12_ROWS, 40000);
        }
        const input = { ownerDigest: boundary.ownerDigest, stream: "usage", fromDay: D1, throughDay: D1 };
        const client = await pool.connect();
        try {
          for (const count of [40000, 40001]) {
            try {
              // Add the final valid transport source before opening the
              // immutable snapshot; published source graphs stay immutable.
              if (count === 40001) await diagnostics.stage("admit_extra", () => boundary.enableExtraSource());
              await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
              const returnedCounts = [];
              const observed = { query: async (...args) => {
                const result = await diagnostics.query(client, client.query, args);
                const sql = typeof args[0] === "string" ? args[0] : args[0].text;
                if (sql.includes(`occurrences.${family === "legacy" ? "legacy" : "v12"}_sources`)) {
                  returnedCounts.push(result.rows.length);
                  const binds = typeof args[0] === "string" ? args[1] : args[0].values;
                  assert.equal(binds[family === "legacy" ? 4 : 3].length, 200,
                    "one complete logical expansion batch reaches PostgreSQL");
                  assert.equal(result.rows.length, count, "real SQL returns the exact boundary cardinality");
                }
                return result;
              } };
              const context = { pool, client: observed, schema, nowMs: NOW_MS };
              // Compare and assert the same real reads; do not execute the
              // expensive expansion again solely to inspect its result.
              const occurrenceReads = [];
              await diagnostics.stage(count === 40000 ? "accepted_compare" : "overflow_compare",
                () => compareExpansionRead(observeOccurrenceReads(readers, occurrenceReads, diagnostics), context, input));
              await diagnostics.stage(count === 40000 ? "accepted_assertions" : "overflow_assertions", async () => {
                assert.deepEqual(occurrenceReads.map(({ readerName }) => readerName), ["base", "candidate"]);
                for (const { promise } of occurrenceReads) {
                  if (count === 40000) {
                    const output = await promise;
                    assert.equal(output.get(D1).length, 200);
                    assert.ok(output.get(D1).every((row) => row.status === "compatible" && row.sourceCount === 200));
                  } else {
                    await assert.rejects(promise,
                      (error) => error?.code === "ANALYTICS_V2_SOURCE_LIMIT");
                  }
                }
                assert.ok(returnedCounts.length >= 2, "both independent bundled readers executed real expansion SQL");
              });
            } finally {
              await client.query("ROLLBACK");
            }
          }
        } finally {
          client.release();
        }
      } finally {
        await diagnostics.stage("cleanup", async () => {
          if (readers) await readers.close();
          if (vite) await vite.close();
          if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
          await pool.end();
        });
      }
    });
}
