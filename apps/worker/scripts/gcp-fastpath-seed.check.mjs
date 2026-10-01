#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { GCP_FASTPATH_CONNECTION, validateTarget } from "./gcp-fastpath-connection.mjs";
import { fastpathRehearsalSchemas } from "./gcp-fastpath-rehearsal.mjs";
import {
  defaultSuffix,
  GCP_FASTPATH_SEED,
  goldenPath,
  loadSeedStages,
  planSeed,
  runGcpFastpathSeed,
  SEED_STAGES,
  seededSchemas,
  seedMarker,
} from "./gcp-fastpath-seed.mjs";
import { POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX,
  POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX,
  POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX } from "./postgres-typed-legacy-transfer.mjs";

const COMMIT = "4".repeat(40);
const GOLDEN = GCP_FASTPATH_SEED.defaultGolden;

/** Fake git: `present` paths exist at the commit, `dirty` paths differ in the checkout. */
function fakeGit({ present = [], dirty = [] } = {}) {
  return (command, args) => {
    assert.equal(command, "git");
    const [, , verb, ...rest] = args;
    if (verb === "cat-file") {
      const path = rest[1].slice(COMMIT.length + 1);
      return { status: present.includes(path) ? 0 : 1, stdout: "" };
    }
    if (verb === "diff") {
      const paths = rest.slice(rest.indexOf("--") + 1);
      return { status: paths.some((path) => dirty.includes(path)) ? 1 : 0, stdout: "" };
    }
    if (verb === "ls-files") return { status: 0, stdout: "" };
    throw new Error(`unexpected git ${verb}`);
  };
}

const stagePath = (name) => SEED_STAGES.find((stage) => stage.name === name).path;
const ALL_STAGES = SEED_STAGES.map(({ path }) => path);
const GOLDEN_MANIFEST = `${GOLDEN}/manifest.json`;

test("the seed's stages are the local rehearsal's whole importer chain, in its order", () => {
  assert.deepEqual(SEED_STAGES.map(({ name }) => name), ["rehearsal-loader", "oracle-sqlite", "identity",
    "typed-legacy", "v12", "usage-correction", "ingestion-journal"]);
  assert.equal(stagePath("rehearsal-loader"), "apps/worker/scripts/gcp-fastpath-rehearsal.mjs");
});

test("every stage contract matches the real module exports", async () => {
  const loader = await loadSeedStages();
  for (const name of ["fastpathRehearsalSchemas", "sealFastpathRehearsalSource", "loadFastpathRehearsalImporters"]) {
    assert.equal(typeof loader[name], "function", name);
  }
});

test("seed skips with its reason when any chain stage or the golden is absent at the commit", () => {
  const withoutT1 = planSeed(COMMIT, { spawn: fakeGit({
    present: [...ALL_STAGES.filter((path) => path !== stagePath("identity")), GOLDEN_MANIFEST] }) });
  assert.equal(withoutT1.decision, "skip");
  assert.match(withoutT1.reason, /T-1 identity\/authority copy/u);
  assert.match(withoutT1.reason, /postgres-fastpath-identity-copy\.mjs/u);
  assert.equal(withoutT1.stages.find(({ name }) => name === "identity").status, "absent");
  for (const stage of ["v12", "usage-correction", "ingestion-journal"]) {
    const plan = planSeed(COMMIT, { spawn: fakeGit({
      present: [...ALL_STAGES.filter((path) => path !== stagePath(stage)), GOLDEN_MANIFEST] }) });
    assert.equal(plan.decision, "skip", `${stage} is not optional: the chain is all or nothing`);
  }
  const withoutGolden = planSeed(COMMIT, { spawn: fakeGit({ present: ALL_STAGES }) });
  assert.equal(withoutGolden.decision, "skip");
  assert.match(withoutGolden.reason, /golden/u);
});

test("seed runs only from a checkout equal to the commit in stages, migrations and golden", () => {
  const present = [...ALL_STAGES, GOLDEN_MANIFEST];
  assert.equal(planSeed(COMMIT, { spawn: fakeGit({ present }) }).decision, "run");
  for (const dirty of [stagePath("v12"), stagePath("rehearsal-loader"), "apps/worker/postgres/migrations", GOLDEN]) {
    const plan = planSeed(COMMIT, { spawn: fakeGit({ present, dirty: [dirty] }) });
    assert.equal(plan.decision, "refuse", dirty);
    assert.match(plan.reason, /run the seed from a checkout of the deployed commit/u);
  }
  assert.throws(() => goldenPath("/tmp/elsewhere"), (error) => error?.code === "GCP_FASTPATH_SEED_GOLDEN_INVALID");
  assert.equal(goldenPath(), GOLDEN);
});

test("seeded schemas are the rehearsal's names and pass every importer's prefix guard", () => {
  const suffix = defaultSuffix("483245adcb02202539b5b3abb2d479e07f722e48", "98936d54208d964f".padEnd(64, "0"));
  assert.match(suffix, /^[0-9a-f]{8}$/u);
  assert.equal(defaultSuffix("483245adcb02202539b5b3abb2d479e07f722e48", "98936d54208d964f".padEnd(64, "0")), suffix);
  assert.notEqual(defaultSuffix(COMMIT, "98936d54208d964f".padEnd(64, "0")), suffix);
  const schemas = seededSchemas(suffix);
  const rehearsal = fastpathRehearsalSchemas(suffix);
  assert.equal(schemas.target, rehearsal.schema);
  assert.equal(schemas.control, rehearsal.controlSchema);
  assert.equal(schemas.target.startsWith(POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX), true,
    "usage-correction and ingestion-journal accept the fast-path target prefix");
  assert.equal(schemas.target.startsWith(POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX), true);
  assert.equal(schemas.control.startsWith(POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX), true);
  assert.equal(schemas.control.startsWith(POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX), false);
  assert.equal(`${schemas.target}_ledger`.length <= 63, true, "the origin's <schema>_ledger fits an identifier");
  for (const bad of ["short", "ABCDEF12", "fp_483245ad", "0123456789", "../../x", undefined]) {
    assert.throws(() => seededSchemas(bad), (error) => error?.code === "GCP_FASTPATH_SEED_SUFFIX_INVALID");
  }
  assert.match(seedMarker(COMMIT, "a".repeat(64)), /^gcp-fastpath-seed-v1 complete commit=4{40} dump=a{64}$/u);
});

test("the connection targets only the disposable fast-path database", () => {
  assert.equal(GCP_FASTPATH_CONNECTION.database, "tibotattle_fastpath");
  assert.notEqual(GCP_FASTPATH_CONNECTION.database, "tibotattle");
  assert.equal(validateTarget("gcp-fastpath"), "gcp-fastpath");
  for (const bad of ["local", "tibotattle", "gcp-test-app", undefined]) {
    assert.throws(() => validateTarget(bad), (error) => error?.code === "GCP_FASTPATH_CONNECTION_TARGET_INVALID");
  }
  assert.deepEqual(Object.keys(GCP_FASTPATH_CONNECTION.identities).sort(), ["migrator", "runtime"]);
});

// ---------------------------------------------------------------------------
// The seed against a local PostgreSQL 17 (the GCP pool swapped for a local one)
// ---------------------------------------------------------------------------

const PRIVATE_SOCKET = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
const LOCAL_SKIP = !process.env.PG_TEST_SOCKET && !process.env.PG_TEST_HOST
  ? "needs PG_TEST_SOCKET or PG_TEST_HOST (local PostgreSQL 17)"
  : NODE_MAJOR < 26 ? "the sealed-SQLite importers are qualified on Node 26" : false;

async function localPoolOptions() {
  const socket = process.env.PG_TEST_SOCKET;
  let host = process.env.PG_TEST_HOST;
  if (socket) {
    assert.match(socket, PRIVATE_SOCKET);
    const real = await realpath(socket);
    assert.equal((await lstat(socket)).isSymbolicLink(), false);
    assert.equal((await stat(real)).mode & 0o077, 0);
    host = real;
  } else {
    assert.ok(["127.0.0.1", "localhost", "::1"].includes(host));
  }
  return { host, port: Number(process.env.PG_TEST_PORT ?? "55432"), user: process.env.PG_TEST_USER || "postgres",
    database: process.env.PG_TEST_DATABASE || "postgres", ssl: false };
}

/** Real git for rev-parse and cat-file; a clean checkout for diff and ls-files. */
function cleanCheckoutGit(command, args, options) {
  const verb = args[2];
  if (verb === "diff" || verb === "ls-files") return { status: 0, stdout: "" };
  return spawnSync(command, args, options);
}

test("PG17: the seed runs the rehearsal's chain into one schema, is idempotent and refuses a partial seed",
  { skip: LOCAL_SKIP, timeout: 600_000 }, async () => {
    const options = await localPoolOptions();
    const pools = [];
    const createPool = async ({ max }) => {
      const pool = new pg.Pool({ ...options, max });
      pool.on("error", () => {});
      pools.push(pool);
      return { pool, identity: options.user, close: async () => {} };
    };
    const granted = [];
    const dependencies = {
      spawn: cleanCheckoutGit,
      createPool,
      expectedOwner: null,
      grantRuntime: async (pool, schema) => { granted.push(schema); },
      readBack: async (schema) => {
        const counted = await pools[0].query(`SELECT count(*)::int AS n FROM "${schema}".storage_ingestion_changes`);
        return { schema, storageIngestionChanges: counted.rows[0].n };
      },
    };
    const suffix = (Date.now() % 0x1_0000_0000).toString(16).padStart(8, "0");
    const schemas = seededSchemas(suffix);
    const lines = [];
    try {
      const first = await runGcpFastpathSeed({ commit: "HEAD", schemaSuffix: suffix, dependencies,
        log: (line) => lines.push(line) });
      assert.equal(first.status, "seeded");
      assert.equal(first.schema, schemas.target);
      assert.equal(first.nowIso, "2026-10-01T12:00:00.000Z");
      for (const [name, entry] of Object.entries(first.steps.importVerification)) {
        assert.equal(entry.equal, true, name);
      }
      assert.equal(first.steps.typedLegacy.status, "staged_rehearsal_complete");
      assert.equal(first.steps.v12.status, "staged_rehearsal_complete");
      assert.equal(first.steps.ingestionJournal.status, "synthetic_storage_ingestion_journal_transfer_complete");
      // The receipt's legacy-transport, v1.2 event-source and journal counts.
      for (const [table, rows] of Object.entries({ telemetry_v11_chunks: 1530, telemetry_v11_day_manifests: 510,
        telemetry_v11_domain_days: 510, typed_v11_record_proofs: 11181, telemetry_v1_chunks: 2,
        storage_v12_event_sources: 1, storage_ingestion_changes: 6 })) {
        assert.equal(first.steps.importedRows[table], rows, table);
      }
      assert.deepEqual(granted, [schemas.target]);
      assert.equal(first.readback.storageIngestionChanges, 6);

      const again = await runGcpFastpathSeed({ commit: "HEAD", schemaSuffix: suffix, dependencies,
        log: (line) => lines.push(line) });
      assert.equal(again.status, "already-seeded");
      assert.equal(again.steps, null, "the importers are not re-run");

      await pools[0].query(`COMMENT ON SCHEMA "${schemas.target}" IS NULL`);
      await assert.rejects(runGcpFastpathSeed({ commit: "HEAD", schemaSuffix: suffix, dependencies,
        log: (line) => lines.push(line) }), (error) => error?.code === "GCP_FASTPATH_SEED_PARTIAL_SCHEMA");
    } finally {
      for (const schema of [schemas.target, schemas.control]) {
        await pools[0]?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      }
      for (const pool of pools) await pool.end().catch(() => {});
    }
  });
