#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DIGEST_ONLY_GOLDEN_NOW, DIGEST_ONLY_GOLDEN_SOURCE,
  withDigestOnlyGolden } from "../analytics-v2-test/fixtures/digest-only-golden.mjs";
import { localFastpathTcpHost, withLocalFastpathCloudDatabase } from "../postgres-test/fixtures/fastpath-cloud-database.mjs";
import { GCP_FASTPATH_CLOUD_TARGET, GCP_FASTPATH_CLOUD_TARGET_REFUSALS,
  gcpFastpathCloudTargetRefusal } from "./gcp-fastpath-cloud-target.mjs";
import { createGcpFastpathPool, fastpathInstanceConnectionName, GCP_FASTPATH_CONNECTION,
  validateTarget } from "./gcp-fastpath-connection.mjs";
import { fastpathRehearsalSchemas } from "./gcp-fastpath-rehearsal.mjs";
import {
  corpusGolden,
  defaultSuffix,
  GCP_FASTPATH_SEED,
  goldenPath,
  goldenSourceIdentity,
  loadSeedStages,
  loadStage,
  planSeed,
  readSeedGolden,
  runGcpFastpathSeed,
  SEALED_CORPUS_STAGE,
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

// MEAS-SYNTH review (2026-10-03): a static import of the sealed-corpus
// importer loaded the rehearsal loader's whole chain (node:sqlite, pg, every
// importer) before any plan, for every command.
test("the seed loads its stages, the sealed-corpus importer included, only after the plan and contract-checked", async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "gcp-fastpath-seed.mjs"), "utf8");
  const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gmsu)].map(([, specifier]) => specifier);
  assert.deepEqual(specifiers.filter((specifier) => !specifier.startsWith("node:")), ["./gcp-fastpath-connection.mjs"]);
  assert.equal(GCP_FASTPATH_SEED.sealedCorpusPaths.includes(SEALED_CORPUS_STAGE.path), true,
    "the plan holds the importer to the commit");
  const module = await loadStage(SEALED_CORPUS_STAGE);
  for (const name of SEALED_CORPUS_STAGE.exports) assert.equal(typeof module[name], "function", name);
  await assert.rejects(loadStage({ ...SEALED_CORPUS_STAGE, exports: [...SEALED_CORPUS_STAGE.exports, "absentExport"] }),
    (error) => error?.code === "GCP_FASTPATH_SEED_STAGE_CONTRACT_MISMATCH");
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
  for (const dirty of [stagePath("v12"), stagePath("rehearsal-loader"), "apps/worker/postgres/migrations", GOLDEN,
    "apps/worker/scripts/gcp-fastpath-cloud-target.mjs"]) {
    const plan = planSeed(COMMIT, { spawn: fakeGit({ present, dirty: [dirty] }) });
    assert.equal(plan.decision, "refuse", dirty);
    assert.match(plan.reason, /run the seed from a checkout of the deployed commit/u);
  }
  assert.throws(() => goldenPath("/tmp/elsewhere"), (error) => error?.code === "GCP_FASTPATH_SEED_GOLDEN_INVALID");
  assert.equal(goldenPath(), GOLDEN);
});

test("a --sealed-corpus seed has no golden: its importer files must exist at the commit and equal the checkout", () => {
  const corpusPaths = [...GCP_FASTPATH_SEED.sealedCorpusPaths];
  assert.deepEqual(corpusPaths, ["apps/worker/scripts/gcp-fastpath-prod-shape/import-corpus.mjs",
    "apps/worker/scripts/gcp-fastpath-prod-shape/prod-shape-corpus.mjs",
    "apps/worker/scripts/postgres-fastpath-identity-copy.mjs"]);
  const present = [...ALL_STAGES, ...corpusPaths];
  const plan = planSeed(COMMIT, { spawn: fakeGit({ present }), sealedCorpus: true });
  assert.equal(plan.decision, "run");
  assert.equal(plan.golden, null);
  // A golden-mode plan of the same commit still needs its golden.
  assert.equal(planSeed(COMMIT, { spawn: fakeGit({ present }) }).decision, "skip");
  const missing = planSeed(COMMIT, { spawn: fakeGit({ present: present.filter((path) => path !== corpusPaths[0]) }),
    sealedCorpus: true });
  assert.equal(missing.decision, "skip");
  assert.match(missing.reason, /sealed-corpus importer \(apps\/worker\/scripts\/gcp-fastpath-prod-shape\/import-corpus\.mjs\)/u);
  for (const dirty of [...corpusPaths, stagePath("v12"), "apps/worker/postgres/migrations"]) {
    const refused = planSeed(COMMIT, { spawn: fakeGit({ present, dirty: [dirty] }), sealedCorpus: true });
    assert.equal(refused.decision, "refuse", dirty);
  }
});

test("--sealed-corpus excludes --corpus, --golden and --dump", async () => {
  await assert.rejects(runGcpFastpathSeed({ commit: "HEAD", sealedCorpus: "/nonexistent", dump: "/nonexistent.json",
    log: () => {} }), (error) => error?.code === "GCP_FASTPATH_SEED_ARGUMENT_INVALID");
  const script = fileURLToPath(new URL("./gcp-fastpath-seed.mjs", import.meta.url));
  for (const other of ["--corpus=dense", "--golden=apps/worker/analytics-v2-test/golden", "--dump=/nonexistent.json"]) {
    const run = spawnSync(process.execPath, [script, "seed", "--target=gcp-fastpath", "--commit=HEAD",
      "--sealed-corpus=/nonexistent", other], { encoding: "utf8" });
    assert.equal(run.status, 1, other);
    assert.match(run.stderr, /GCP_FASTPATH_SEED_ARGUMENT_INVALID/u, other);
  }
});

test("--corpus selects a committed golden; the dense golden's dump must match its pinned digest", async () => {
  assert.equal(corpusGolden("q1"), GCP_FASTPATH_SEED.defaultGolden);
  assert.equal(corpusGolden("dense"), "apps/worker/analytics-v2-test/golden-dense");
  for (const bad of ["Q1", "golden", "", undefined, "__proto__"]) {
    assert.throws(() => corpusGolden(bad), (error) => error?.code === "GCP_FASTPATH_SEED_CORPUS_INVALID");
  }
  const q1 = await readSeedGolden(corpusGolden("q1"));
  assert.match(q1.dumpSha256, /^[0-9a-f]{64}$/u);
  assert.equal(q1.nowIso, "2026-10-01T12:00:00.000Z");
  // golden-dense commits only its dump's digest.
  await assert.rejects(readSeedGolden(corpusGolden("dense")),
    (error) => error?.code === "GCP_FASTPATH_SEED_DUMP_REQUIRED");
  const directory = await mkdtemp(join(tmpdir(), "gcp-fastpath-seed-check-"));
  try {
    const dump = join(directory, "usage-monitor-db.json");
    await writeFile(dump, '{"schema":[],"tables":[]}\n');
    await assert.rejects(readSeedGolden(corpusGolden("dense"), { dump }),
      (error) => error?.code === "GCP_FASTPATH_SEED_DUMP_DIGEST_MISMATCH");
    await assert.rejects(readSeedGolden(corpusGolden("q1"), { dump }),
      (error) => error?.code === "GCP_FASTPATH_SEED_DUMP_AMBIGUOUS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// The dense corpus's path, with a synthetic dump: the golden commits only the
// digest, and the source the origin is told comes from the external dump's bytes.
test("a digest-only golden reads its digest, clock and source from the --dump its manifest pins", async () => {
  await withDigestOnlyGolden(async ({ golden, dump, dumpSha256 }) => {
    const read = await readSeedGolden(golden, { dump });
    assert.equal(read.dumpPath, dump);
    assert.equal(read.dumpSha256, dumpSha256);
    assert.equal(read.nowIso, DIGEST_ONLY_GOLDEN_NOW);
    assert.deepEqual({ ...read.sourceIdentity }, { ...DIGEST_ONLY_GOLDEN_SOURCE });
    await assert.rejects(readSeedGolden(golden), (error) => error?.code === "GCP_FASTPATH_SEED_DUMP_REQUIRED");
    const altered = join(dirname(dump), "altered.json");
    await writeFile(altered, `${await readFile(dump, "utf8")} `);
    await assert.rejects(readSeedGolden(golden, { dump: altered }),
      (error) => error?.code === "GCP_FASTPATH_SEED_DUMP_DIGEST_MISMATCH");
  });
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
  // The origin serves one schema (no ledger pair): the target itself must be
  // a PostgreSQL identifier.
  assert.equal(schemas.target.length <= 63, true, "the seeded schema fits an identifier");
  assert.deepEqual(Object.keys(rehearsal).sort(), ["controlSchema", "schema", "suffix"], "no ledger schema");
  for (const bad of ["short", "ABCDEF12", "fp_483245ad", "0123456789", "../../x", undefined]) {
    assert.throws(() => seededSchemas(bad), (error) => error?.code === "GCP_FASTPATH_SEED_SUFFIX_INVALID");
  }
  assert.match(seedMarker(COMMIT, "a".repeat(64)), /^gcp-fastpath-seed-v1 complete commit=4{40} dump=a{64}$/u);
});

test("the cloud-target exception names the seed's database, prefix and PostgreSQL major, and refuses by reason", async () => {
  assert.deepEqual(GCP_FASTPATH_CLOUD_TARGET, { database: "tibotattle_fastpath",
    schemaPrefix: "typed_legacy_transfer_rehearsal_target_fastpath_", postgresMajor: 17 });
  assert.equal(GCP_FASTPATH_CLOUD_TARGET.database, GCP_FASTPATH_CONNECTION.database);
  assert.equal(GCP_FASTPATH_CLOUD_TARGET.schemaPrefix, GCP_FASTPATH_SEED.targetPrefix);
  const cloud = { database: "tibotattle_fastpath", version: 170006, session_superuser: false, current_superuser: "off" };
  const client = (facts) => ({ query: async () => (facts instanceof Error ? Promise.reject(facts) : { rows: [facts] }) });
  const schema = seededSchemas("0a1b2c3d").target;
  assert.equal(await gcpFastpathCloudTargetRefusal(client(cloud), schema), null);
  const cases = [
    [client(cloud), seededSchemas("0a1b2c3d").control, "schema"],
    [client(cloud), "storage_journal_transfer_target_0a1b2c3d", "schema"],
    [client(cloud), `${schema}0`, "schema"],
    [client(cloud), "typed_legacy_transfer_rehearsal_target_fastpath_ABCDEF12", "schema"],
    [client(cloud), undefined, "schema"],
    [client(new Error("synthetic")), schema, "unavailable"],
    [{ query: async () => ({ rows: [] }) }, schema, "unavailable"],
    [client({ ...cloud, database: "tibotattle" }), schema, "database"],
    [client({ ...cloud, database: "postgres" }), schema, "database"],
    [client({ ...cloud, version: 160004 }), schema, "postgres-major"],
    [client({ ...cloud, version: "not-a-number" }), schema, "postgres-major"],
    [client({ ...cloud, session_superuser: true }), schema, "superuser"],
    [client({ ...cloud, session_superuser: null }), schema, "superuser"],
    [client({ ...cloud, current_superuser: "on" }), schema, "superuser"],
  ];
  for (const [fake, target, reason] of cases) {
    assert.equal(await gcpFastpathCloudTargetRefusal(fake, target), reason, `${target} ${reason}`);
    assert.ok(GCP_FASTPATH_CLOUD_TARGET_REFUSALS.includes(reason));
  }
});

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_SCAN_ROOTS = ["scripts", "cloud-run", "src", "gcp-test"];
const PRODUCTION_SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".wrangler", "fixtures"]);
const TEST_FILE = /\.(?:check|test|spec|bench)\.[cm]?[jt]s$|\.d\.ts$/u;

async function productionSources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!PRODUCTION_SKIPPED_DIRECTORIES.has(entry.name)) files.push(...await productionSources(path));
    } else if (entry.isFile() && /\.(?:[cm]?[jt]s)$/u.test(entry.name) && !TEST_FILE.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

test("only the seed passes cloudFastpathTarget: the rehearsal loader forwards it, the journal importer reads it", async () => {
  const mentions = {};
  for (const root of PRODUCTION_SCAN_ROOTS) {
    for (const path of await productionSources(join(WORKER_ROOT, root))) {
      // Code lines only: doc comments may describe the option.
      const code = (await readFile(path, "utf8")).split("\n")
        .filter((line) => !/^\s*(?:\*|\/\*|\/\/)/u.test(line)).join("\n");
      if (!code.includes("cloudFastpathTarget")) continue;
      mentions[relative(WORKER_ROOT, path)] = (code.match(/cloudFastpathTarget\s*:\s*true\b/gu) ?? []).length;
    }
  }
  assert.deepEqual(mentions, {
    "scripts/gcp-fastpath-rehearsal.mjs": 0,
    "scripts/gcp-fastpath-seed.mjs": 1,
    "scripts/postgres-ingestion-journal-transfer.mjs": 0,
  });
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

test("--meas-instance dials the same database on a measurement instance and names no other instance", async () => {
  assert.equal(fastpathInstanceConnectionName(undefined), GCP_FASTPATH_CONNECTION.instanceConnectionName);
  assert.equal(fastpathInstanceConnectionName("tibotattle-meas-prodtier-20261003"),
    "tibotattle:us-east1:tibotattle-meas-prodtier-20261003");
  for (const bad of ["tibotattle-primary", "tibotattle-test-primary-20260922", "tibotattle-meas-prodtier-20261399", ""]) {
    assert.throws(() => fastpathInstanceConnectionName(bad),
      (error) => error?.code === "GCP_FASTPATH_CONNECTION_INSTANCE_INVALID", bad);
    // Refused before any gcloud call (no impersonation is attempted).
    await assert.rejects(createGcpFastpathPool({ measInstance: bad, spawn: () => assert.fail("no gcloud") }),
      (error) => error?.code === "GCP_FASTPATH_CONNECTION_INSTANCE_INVALID", bad);
  }
  const script = fileURLToPath(new URL("./gcp-fastpath-seed.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script, "seed", "--target=gcp-fastpath", "--commit=HEAD",
    "--meas-instance=tibotattle-primary"], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /GCP_FASTPATH_CONNECTION_INSTANCE_INVALID/u);
});

// ---------------------------------------------------------------------------
test("the golden pins one typed-storage source, which the origin over a seeded schema must be told", async () => {
  const table = (name, columns, rows) => ({ name, columns, rows });
  const dump = (sourceId, v1, v11) => ({ tables: [
    table("storage_source_state", ["singleton", "source_id", "authority_epoch"], [[1, sourceId, 0]]),
    table("typed_v1_admission_state", ["id", "source_namespace"], [[1, v1]]),
    table("typed_v11_admission_state", ["id", "source_namespace"], [[1, v11]]),
  ] });
  assert.deepEqual({ ...goldenSourceIdentity(dump("synthetic-source", "synthetic-ns", "synthetic-ns")) },
    { sourceId: "synthetic-source", sourceNamespace: "synthetic-ns" });
  for (const [label, bad] of [
    ["formats disagree", dump("s", "ns-a", "ns-b")],
    ["no source", dump(undefined, "ns", "ns")],
    ["comma", dump("s,t", "ns", "ns")],
    ["no tables", {}],
    ["two source rows", { tables: [table("storage_source_state", ["source_id"], [["a"], ["b"]])] }],
  ]) {
    assert.throws(() => goldenSourceIdentity(bad), (error) => error?.code === "GCP_FASTPATH_SEED_GOLDEN_SOURCE_INVALID", label);
  }
  assert.deepEqual({ ...(await readSeedGolden()).sourceIdentity },
    { sourceId: "gcp-fastpath-oracle", sourceNamespace: "gcp-fastpath-oracle" });
});

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
      // Read back from the schema: the source the deployed origin is configured with.
      assert.deepEqual({ ...first.sourceIdentity },
        { sourceId: "gcp-fastpath-oracle", sourceNamespace: "gcp-fastpath-oracle" });
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
      assert.deepEqual({ ...again.sourceIdentity }, { ...first.sourceIdentity });

      // A seeded schema that no longer pins the golden's source is refused, never handed to the origin.
      const t = (name) => `"${schemas.target}"."${name}"`;
      await pools[0].query(`UPDATE ${t("storage_source_state")} SET source_id = 'synthetic-other' WHERE singleton = 1`);
      await assert.rejects(runGcpFastpathSeed({ commit: "HEAD", schemaSuffix: suffix, dependencies,
        log: (line) => lines.push(line) }), (error) => error?.code === "GCP_FASTPATH_SEED_SOURCE_IDENTITY_MISMATCH");
      await pools[0].query(`UPDATE ${t("storage_source_state")} SET source_id = 'gcp-fastpath-oracle' WHERE singleton = 1`);

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

// Importer run-control rows name the run (transfer ids carry the schema
// suffix) or the clock (migration history; publication_state's migration
// seed), so two seeds can only agree on their counts.
const RUN_STAMPED_TABLES = new Set(["_tibotattle_migration_history", "_storage_ingestion_journal_transfer_runs_v1",
  "_storage_ingestion_journal_transfer_checkpoints_v1", "postgres_usage_correction_transfer_runs",
  "postgres_usage_correction_transfer_checkpoints", "postgres_usage_correction_transfer_table_receipts",
  "publication_state"]);

/** Per-table row counts and content digests of every table in a seeded schema. */
async function seededFingerprint(pool, schema) {
  const tables = await pool.query(`SELECT relname::text AS name FROM pg_catalog.pg_class
    WHERE relnamespace = $1::regnamespace AND relkind IN ('r', 'p') ORDER BY 1`, [schema]);
  const fingerprint = {};
  for (const { name } of tables.rows) {
    const { rows: [row] } = await pool.query(`SELECT count(*)::int AS n,
        md5(COALESCE(string_agg(t::text, E'\\n' ORDER BY t::text COLLATE "C"), '')) AS digest
      FROM "${schema}"."${name}" t`);
    fingerprint[name] = RUN_STAMPED_TABLES.has(name) ? { rows: row.n } : { rows: row.n, md5: row.digest };
  }
  return fingerprint;
}

async function userTriggerStates(pool, schema) {
  const result = await pool.query(`SELECT rel.relname::text || '.' || trigger.tgname::text AS name,
      trigger.tgenabled::text AS enabled
    FROM pg_catalog.pg_trigger trigger JOIN pg_catalog.pg_class rel ON rel.oid = trigger.tgrelid
    WHERE rel.relnamespace = $1::regnamespace AND NOT trigger.tgisinternal ORDER BY 1`, [schema]);
  return result.rows;
}

test("PG17: as a Cloud SQL-like migrator (not a superuser) the seed equals the superuser seed",
  { skip: LOCAL_SKIP, timeout: 900_000 }, async () => {
    // Cloud SQL's migrator IAM user is a cloudsqlsuperuser member with
    // CREATEDB and CREATEROLE, never a superuser, and owns what its
    // migrations create. The stand-in: a NOLOGIN cloudsqlsuperuser role that
    // owns a fresh database, and a LOGIN migrator in it. The superuser seed
    // runs in PG_TEST_DATABASE, as above (primary 0056 binds each database's
    // transfer control schema to the role that installs it first).
    const options = await localPoolOptions();
    const admin = new pg.Pool({ ...options, max: 1 });
    admin.on("error", () => {});
    const tag = randomBytes(5).toString("hex");
    const roles = { group: `fp_seed_cloudsqlsuperuser_${tag}`, migrator: `fp_seed_migrator_${tag}` };
    const database = `fp_seed_cloudsql_${tag}`;
    const pools = [];
    const poolFor = ({ user, database: name, max }) => {
      const pool = new pg.Pool({ ...options, user, database: name, max });
      pool.on("error", () => {});
      pools.push(pool);
      return pool;
    };
    const created = { roles: [], database: false };
    const seeds = {};
    try {
      const facts = await admin.query("SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user");
      assert.equal(facts.rows[0]?.rolsuper, true, "the check creates roles and a database; PG_TEST_USER must be superuser");
      await admin.query(`CREATE ROLE "${roles.group}" NOLOGIN NOSUPERUSER CREATEDB CREATEROLE`);
      created.roles.push(roles.group);
      await admin.query(`CREATE ROLE "${roles.migrator}" LOGIN NOSUPERUSER CREATEDB CREATEROLE INHERIT
        IN ROLE "${roles.group}"`);
      created.roles.push(roles.migrator);
      await admin.query(`CREATE DATABASE "${database}" OWNER "${roles.group}"`);
      created.database = true;

      const runs = {
        superuser: { user: options.user, database: options.database, expectedOwner: null },
        migrator: { user: roles.migrator, database, expectedOwner: roles.migrator },
      };
      for (const [name, run] of Object.entries(runs)) {
        const pool = poolFor({ user: run.user, database: run.database, max: 4 });
        const session = await pool.query(`SELECT session_user::text AS login, rolsuper, rolcreaterole
          FROM pg_catalog.pg_roles WHERE rolname = session_user`);
        assert.deepEqual(session.rows[0], { login: run.user, rolsuper: name === "superuser", rolcreaterole: true });
        const schemas = seededSchemas(randomBytes(4).toString("hex"));
        seeds[name] = { pool, schemas };
        const receipt = await runGcpFastpathSeed({ commit: "HEAD", schemaSuffix: schemas.suffix, log: () => {},
          dependencies: {
            spawn: cleanCheckoutGit,
            createPool: async () => ({ pool, identity: run.user, close: async () => {} }),
            expectedOwner: run.expectedOwner,
            grantRuntime: async () => {},
            readBack: async (schema) => ({ schema }),
          } });
        assert.equal(receipt.status, "seeded", name);
        for (const [verification, entry] of Object.entries(receipt.steps.importVerification)) {
          assert.equal(entry.equal, true, `${name} ${verification}`);
        }
        seeds[name].receipt = receipt;
      }

      const { superuser, migrator } = seeds;
      // Same importer receipts, row counts and verifications.
      assert.deepEqual(migrator.receipt.steps, superuser.receipt.steps);
      // Same rows in every table, and nothing a suppressed trigger would mint.
      assert.deepEqual(await seededFingerprint(migrator.pool, migrator.schemas.target),
        await seededFingerprint(superuser.pool, superuser.schemas.target));
      // Every user trigger is enabled again, exactly as in the superuser seed.
      const triggers = await userTriggerStates(migrator.pool, migrator.schemas.target);
      assert.ok(triggers.length > 0);
      assert.deepEqual(triggers.filter((trigger) => trigger.enabled !== "O"), []);
      assert.deepEqual(triggers, await userTriggerStates(superuser.pool, superuser.schemas.target));
      // The migrator owns everything it seeded, and neither seed is an
      // ingestion-journal transfer session (CREATEROLE, like superuser, is
      // never one), so both take the same importer paths.
      const foreign = await migrator.pool.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_class
        WHERE relnamespace = $1::regnamespace AND relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $2)`,
      [migrator.schemas.target, roles.migrator]);
      assert.equal(foreign.rows[0].n, 0);
      for (const { pool, schemas } of [superuser, migrator]) {
        const transfer = await pool.query(`SELECT "${schemas.target}".storage_journal_transfer_session() AS session`);
        assert.equal(transfer.rows[0].session, false);
      }
    } finally {
      const superuserSeed = seeds.superuser?.schemas;
      for (const schema of superuserSeed ? [superuserSeed.target, superuserSeed.control] : []) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      }
      for (const pool of pools) await pool.end().catch(() => {});
      if (created.database) await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
      for (const role of created.roles.reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });

const TCP_HOST = LOCAL_SKIP ? null : localFastpathTcpHost();

test("PG17 over TCP: the seed's chain passes the cloud-target exception as a non-superuser in tibotattle_fastpath "
  + "and equals the local rehearsal's chain", {
  skip: LOCAL_SKIP || (TCP_HOST === null && "needs PG_TEST_TCP_HOST (loopback TCP to the same PostgreSQL 17)"),
  timeout: 900_000,
}, async () => {
  // Cloud SQL through the connector: a TCP session (inet_server_addr() is not
  // NULL) as a non-superuser migrator into tibotattle_fastpath. The seed runs
  // through runGcpFastpathSeed, the deploy's entrypoint, with only the pool
  // swapped; the baseline is the superuser over the local Unix socket, the
  // rehearsal's own session.
  const options = await localPoolOptions();
  assert.ok(options.host.startsWith("/"), "the baseline runs over the local Unix socket (PG_TEST_SOCKET)");
  await withLocalFastpathCloudDatabase({ admin: { ...options }, tcpHost: TCP_HOST, port: options.port },
    async ({ database, roles, tcpPool }) => {
      const runs = {
        socketSuperuser: { pool: new pg.Pool({ ...options, max: 4 }), user: options.user, expectedOwner: null },
        cloudMigrator: { pool: tcpPool({ user: roles.migrator, max: 4 }), user: roles.migrator,
          expectedOwner: roles.migrator },
      };
      runs.socketSuperuser.pool.on("error", () => {});
      const seeds = {};
      try {
        const facts = await runs.cloudMigrator.pool.query(`SELECT inet_server_addr() IS NOT NULL AS tcp,
            current_database()::text AS db, rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user`);
        assert.deepEqual(facts.rows[0], { tcp: true, db: database, rolsuper: false });
        for (const [name, run] of Object.entries(runs)) {
          const schemas = seededSchemas(randomBytes(4).toString("hex"));
          seeds[name] = { pool: run.pool, schemas };
          const receipt = await runGcpFastpathSeed({ commit: "HEAD", schemaSuffix: schemas.suffix, log: () => {},
            dependencies: {
              spawn: cleanCheckoutGit,
              createPool: async () => ({ pool: run.pool, identity: run.user, close: async () => {} }),
              expectedOwner: run.expectedOwner,
              grantRuntime: async () => {},
              readBack: async (schema) => ({ schema }),
            } });
          assert.equal(receipt.status, "seeded", name);
          assert.equal(receipt.steps.ingestionJournal.status, "synthetic_storage_ingestion_journal_transfer_complete");
          seeds[name].receipt = receipt;
        }
        const { socketSuperuser, cloudMigrator } = seeds;
        assert.deepEqual(cloudMigrator.receipt.steps, socketSuperuser.receipt.steps);
        // Every table the rehearsal counts, at the local rehearsal's counts.
        assert.deepEqual(cloudMigrator.receipt.steps.importedRows, { participants: 4, storage_v11_owner_links: 4,
          typed_telemetry_records: 11183, telemetry_v12_records: 0, telemetry_v12_day_manifests: 170,
          telemetry_v1_chunks: 2, telemetry_v11_chunks: 1530, telemetry_v11_day_manifests: 510,
          telemetry_v11_domain_days: 510, typed_v11_record_proofs: 11181, typed_v1_record_admissions: 2,
          storage_v11_event_sources: 3, typed_v1_event_sources: 2, storage_v12_event_sources: 1,
          storage_ingestion_changes: 6, telemetry_usage_correction_facts: 0 });
        assert.deepEqual(await seededFingerprint(cloudMigrator.pool, cloudMigrator.schemas.target),
          await seededFingerprint(socketSuperuser.pool, socketSuperuser.schemas.target));
        const triggers = await userTriggerStates(cloudMigrator.pool, cloudMigrator.schemas.target);
        assert.deepEqual(triggers.filter((trigger) => trigger.enabled !== "O"), []);
        assert.deepEqual(triggers, await userTriggerStates(socketSuperuser.pool, socketSuperuser.schemas.target));
      } finally {
        const baseline = seeds.socketSuperuser?.schemas;
        for (const schema of baseline ? [baseline.target, baseline.control] : []) {
          await runs.socketSuperuser.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
        }
        await runs.socketSuperuser.pool.end().catch(() => {});
      }
    });
});

test("PG17: a --sealed-corpus seed imports a production-shaped corpus through the same chain, idempotently",
  { skip: LOCAL_SKIP || (!process.env.MEAS_SYNTH_CORPUS
    && "needs MEAS_SYNTH_CORPUS (a scripts/gcp-fastpath-prod-shape/seed-source.mjs work directory)"),
  timeout: 3_600_000 }, async () => {
    const options = await localPoolOptions();
    const admin = new pg.Pool({ ...options, max: 1 });
    admin.on("error", () => {});
    const database = `meas_synth_seedcheck_${randomBytes(4).toString("hex")}`;
    let pool = null;
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      pool = new pg.Pool({ ...options, database, max: 4 });
      pool.on("error", () => {});
      const dependencies = { spawn: cleanCheckoutGit, createPool: async () => ({ pool, identity: options.user,
        close: async () => {} }), expectedOwner: null, grantRuntime: async () => {}, readBack: async (schema) => ({ schema }) };
      const first = await runGcpFastpathSeed({ commit: "HEAD", sealedCorpus: process.env.MEAS_SYNTH_CORPUS,
        dependencies, log: () => {} });
      assert.equal(first.status, "seeded");
      assert.equal(first.nowIso, "2026-10-01T12:46:00.000Z");
      assert.equal(first.sealedCorpus.sealedSha256, first.dumpSha256);
      assert.deepEqual({ ...first.sourceIdentity }, { sourceId: "gcp-fastpath-oracle", sourceNamespace: "gcp-fastpath-oracle" });
      for (const [name, entry] of Object.entries(first.steps.importVerification)) assert.equal(entry.equal, true, name);
      assert.ok(first.steps.analyze.tables > 0);
      assert.equal(first.steps.maxSourceTableRows, 20_000_000);
      const again = await runGcpFastpathSeed({ commit: "HEAD", sealedCorpus: process.env.MEAS_SYNTH_CORPUS,
        dependencies, log: () => {} });
      assert.equal(again.status, "already-seeded");
      assert.equal(again.schema, first.schema);
    } finally {
      await pool?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });
