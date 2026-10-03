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
      const schema = `readexp_boundary_${randomBytes(6).toString("hex")}`;
      let vite;
      let readers;
      let created = false;
      try {
        const version = (await pool.query("SELECT current_setting('server_version_num')::integer AS version")).rows[0].version;
        assert.equal(Math.floor(version / 10_000), 17);
        await pool.query(`CREATE SCHEMA "${schema}"`);
        created = true;
        await applyPostgresMigrations({ role: "primary", schema, pool });
        vite = await createServer({ root, configFile: false, plugins: config.plugins, resolve: config.resolve,
          logLevel: "error", server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
        const modules = {
          codec: await vite.ssrLoadModule("/src/typed-telemetry-codec.ts"),
          v12codec: await vite.ssrLoadModule("/src/telemetry-v12-typed-codec.ts"),
          reconciliation: await vite.ssrLoadModule("/src/telemetry-usage-reconciliation.ts"),
          sha256Hex: (await vite.ssrLoadModule("/src/crypto.ts")).sha256Hex,
        };
        const { boundary } = await seedAnalyticsV2Fixture({ pool, schema, modules,
          correctionRuntime: "staged", expansionBoundary: family });
        assert.equal(boundary.occurrenceIds.length, 200);
        const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema]);
        for (const { tablename } of tables.rows) {
          assert.match(tablename, /^[a-z_][a-z0-9_]*$/u);
          await pool.query(`ANALYZE "${schema}"."${tablename}"`);
        }
        readers = await loadExpansionReaders();
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
              if (count === 40001) await boundary.enableExtraSource();
              await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
              const returnedCounts = [];
              const observed = { query: async (...args) => {
                const result = await client.query(...args);
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
              if (count === 40000) {
                await compareExpansionRead(readers, context, input);
                for (const reader of [readers.base, readers.candidate]) {
                  const output = await reader.occurrences.readOwnerOccurrences(context, input);
                  assert.equal(output.get(D1).length, 200);
                  assert.ok(output.get(D1).every((row) => row.status === "compatible" && row.sourceCount === 200));
                }
              } else {
                for (const reader of [readers.base, readers.candidate]) {
                  await assert.rejects(reader.occurrences.readOwnerOccurrences(context, input),
                    (error) => error?.code === "ANALYTICS_V2_SOURCE_LIMIT");
                }
                await compareExpansionRead(readers, context, input);
              }
              assert.ok(returnedCounts.length >= 2, "both independent bundled readers executed real expansion SQL");
            } finally {
              await client.query("ROLLBACK");
            }
          }
        } finally {
          client.release();
        }
      } finally {
        if (readers) await readers.close();
        if (vite) await vite.close();
        if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await pool.end();
      }
    });
}
