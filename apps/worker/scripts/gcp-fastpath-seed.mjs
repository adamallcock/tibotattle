#!/usr/bin/env node

/**
 * Seed the disposable fast-path test database (`tibotattle_fastpath`) with
 * exactly the data the local rehearsal imports, then give the runtime IAM
 * user exactly the reviewed runtime grants and read back as it.
 *
 * The seed does not have its own importer logic. It calls the local
 * rehearsal's own loader (scripts/gcp-fastpath-rehearsal.mjs):
 * sealFastpathRehearsalSource rebuilds the golden's USAGE_MONITOR_DB dump
 * into a sealed SQLite, and loadFastpathRehearsalImporters runs the same
 * importer chain, in the same order, into ONE
 * typed_legacy_transfer_rehearsal_target_fastpath_<8 hex> schema:
 * T-1 identity/authority copy, typed-legacy transfer, T-1 legacy-transport
 * copy, T-2 v1.2 transfer, T-1 v1.2 event-source copy, usage-correction
 * transfer and the ingestion journal (prefix-guarded fast-path target), then
 * T-1's roster, public-owner and owner-revision verifications. So
 * analytics-refresh and the origin read on GCP what they read locally.
 * The whole chain runs as the migrator IAM user, which owns what it seeds
 * but is not a superuser (a cloudsqlsuperuser member with CREATEDB and
 * CREATEROLE): no stage needs superuser privileges, and, like the local
 * superuser rehearsal, it is never an ingestion-journal transfer session.
 * Its connector session is TCP, not the local Unix socket the
 * ingestion-journal importer otherwise requires, so the seed alone passes
 * `cloudFastpathTarget: true`, accepted only in tibotattle_fastpath, for a
 * fast-path target schema, on PostgreSQL 17 and without a superuser
 * (scripts/gcp-fastpath-cloud-target.mjs).
 *
 *   node scripts/gcp-fastpath-seed.mjs seed --target=gcp-fastpath --commit=<ref>
 *        [--golden=<dir>] [--schema-suffix=<8 hex>] [--replace]
 *   node scripts/gcp-fastpath-seed.mjs plan [--commit=<ref>] [--golden=<dir>]
 *   node scripts/gcp-fastpath-seed.mjs readback --target=gcp-fastpath --schema=<seeded schema>
 *
 * The importers run from this checkout under Node 26 (node:sqlite), so every
 * stage file, the migrations and the golden must equal the deployed commit's;
 * the plan refuses a differing checkout and skips, with its reason, when a
 * stage is absent at that commit. A schema holding a partial seed is refused
 * unless --replace drops exactly that target and its control schema. No
 * credential is read, printed or stored.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGcpFastpathPool, GCP_FASTPATH_CONNECTION, validateTarget } from "./gcp-fastpath-connection.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SUFFIX = /^[0-9a-f]{8}$/u;
const SEED_MARKER_VERSION = "gcp-fastpath-seed-v1";

export const GCP_FASTPATH_SEED = Object.freeze({
  targetPrefix: "typed_legacy_transfer_rehearsal_target_fastpath_",
  controlPrefix: "typed_legacy_transfer_rehearsal_ctl_",
  defaultGolden: "apps/worker/analytics-v2-test/golden",
  migrationPaths: Object.freeze([
    "apps/worker/postgres/migrations",
    "apps/worker/cloud-run/postgres-migrations.mjs",
    "apps/worker/scripts/postgres-migrations.mjs",
  ]),
  // Not a stage, but it decides whether the ingestion-journal stage accepts
  // the cloud target, so it too must equal the deployed commit's.
  supportPaths: Object.freeze([
    "apps/worker/scripts/gcp-fastpath-cloud-target.mjs",
  ]),
});

/**
 * The modules the seed's chain runs, with the exports it relies on. The
 * first stage is the rehearsal loader the seed calls; the rest are the
 * importers that loader calls, in its order. Every stage is required: the
 * GCP seed must be the local rehearsal's chain, not a subset of it.
 */
export const SEED_STAGES = Object.freeze([
  Object.freeze({
    name: "rehearsal-loader", label: "rehearsal loader (seal + importer chain)",
    path: "apps/worker/scripts/gcp-fastpath-rehearsal.mjs",
    exports: Object.freeze(["fastpathRehearsalSchemas", "sealFastpathRehearsalSource",
      "loadFastpathRehearsalImporters", "buildJournalSqlite"]),
  }),
  Object.freeze({
    name: "oracle-sqlite", label: "golden dump to sealed SQLite",
    path: "apps/worker/scripts/gcp-fastpath-oracle-sqlite.mjs",
    exports: Object.freeze(["rebuildOracleSqlite"]),
  }),
  Object.freeze({
    name: "identity", label: "T-1 identity/authority copy (with legacy-transport and v12-event-sources copies)",
    path: "apps/worker/scripts/postgres-fastpath-identity-copy.mjs",
    exports: Object.freeze(["openSealedFastpathIdentitySource", "runPostgresFastpathIdentityCopy",
      "runPostgresFastpathTransportCopy", "compareFastpathOwnerRoster", "compareFastpathPublicSourceOwners",
      "compareFastpathOwnerRevisions"]),
  }),
  Object.freeze({
    name: "typed-legacy", label: "typed-legacy v1/v1.1 transfer",
    path: "apps/worker/scripts/postgres-typed-legacy-transfer.mjs",
    exports: Object.freeze(["createSealedSqliteTypedLegacyRehearsalSource", "runPostgresTypedLegacyTransfer"]),
  }),
  Object.freeze({
    name: "v12", label: "T-2 v1.2 transfer",
    path: "apps/worker/scripts/postgres-v12-transfer.mjs",
    exports: Object.freeze(["createSealedSqliteV12RehearsalSource", "loadPostgresV12EffectiveReader",
      "runPostgresV12Transfer"]),
  }),
  Object.freeze({
    name: "usage-correction", label: "usage-correction transfer",
    path: "apps/worker/scripts/postgres-usage-correction-transfer.mjs",
    exports: Object.freeze(["createSealedSqliteUsageCorrectionSource", "runPostgresUsageCorrectionTransfer"]),
  }),
  Object.freeze({
    name: "ingestion-journal", label: "ingestion-journal transfer (fast-path prefix)",
    path: "apps/worker/scripts/postgres-ingestion-journal-transfer.mjs",
    exports: Object.freeze(["createSealedSqliteIngestionJournalSource", "transferPostgresIngestionJournal"]),
  }),
]);

function fail(code, detail) {
  throw Object.assign(new Error(detail === undefined ? code : `${code}: ${detail}`), { code });
}

function git(args, spawn = spawnSync) {
  return spawn("git", ["-C", REPOSITORY_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function resolveCommit(ref, spawn = spawnSync) {
  const resolved = git(["rev-parse", "--verify", `${ref}^{commit}`], spawn);
  const commit = String(resolved.stdout ?? "").trim();
  if (resolved.status !== 0 || !COMMIT.test(commit)) fail("GCP_FASTPATH_SEED_COMMIT_UNRESOLVED", String(ref));
  return commit;
}

/** Repository-relative path of a golden directory inside this checkout. */
export function goldenPath(golden = GCP_FASTPATH_SEED.defaultGolden) {
  const absolute = isAbsolute(golden) ? golden : resolve(REPOSITORY_ROOT, golden);
  const path = relative(REPOSITORY_ROOT, absolute);
  if (path === "" || path.startsWith("..") || isAbsolute(path)) fail("GCP_FASTPATH_SEED_GOLDEN_INVALID", String(golden));
  return path;
}

/** True when this checkout's files at `paths` equal the commit (no diff, no untracked extras). */
function checkoutMatches(commit, paths, spawn) {
  const diff = git(["diff", "--quiet", commit, "--", ...paths], spawn);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...paths], spawn);
  return diff.status === 0 && untracked.status === 0 && String(untracked.stdout).trim() === "";
}

/** Which stages exist at the commit, and whether this checkout can run them. */
export function planSeed(commit, { spawn = spawnSync, golden = GCP_FASTPATH_SEED.defaultGolden } = {}) {
  const goldenDirectory = goldenPath(golden);
  const stages = SEED_STAGES.map((stage) => {
    const inCommit = git(["cat-file", "-e", `${commit}:${stage.path}`], spawn).status === 0;
    if (!inCommit) return { ...stage, status: "absent" };
    return { ...stage, status: checkoutMatches(commit, [stage.path], spawn) ? "present" : "checkout-mismatch" };
  });
  const goldenInCommit = git(["cat-file", "-e", `${commit}:${goldenDirectory}/manifest.json`], spawn).status === 0;
  const dataPaths = [...GCP_FASTPATH_SEED.migrationPaths, ...GCP_FASTPATH_SEED.supportPaths, goldenDirectory];
  const dataMatch = checkoutMatches(commit, dataPaths, spawn);
  const missing = stages.filter((stage) => stage.status === "absent");
  const mismatched = stages.filter((stage) => stage.status === "checkout-mismatch");
  let decision = "run";
  let reason = null;
  if (missing.length > 0 || !goldenInCommit) {
    decision = "skip";
    reason = `${[...missing.map((stage) => `${stage.label} (${stage.path})`),
      ...(goldenInCommit ? [] : [`golden (${goldenDirectory})`])].join(", ")} absent at `
      + `${commit.slice(0, 12)}; the seed runs the local rehearsal's whole chain or nothing`;
  } else if (mismatched.length > 0 || !dataMatch) {
    decision = "refuse";
    reason = `this checkout differs from ${commit.slice(0, 12)} in `
      + `${[...mismatched.map((stage) => stage.path), ...(dataMatch ? [] : dataPaths)].join(", ")}`
      + "; run the seed from a checkout of the deployed commit";
  }
  return Object.freeze({
    commit, decision, reason, golden: goldenDirectory,
    stages: stages.map(({ name, label, path, status }) => ({ name, label, path, status })),
  });
}

export function seededSchemas(suffix) {
  if (!SUFFIX.test(suffix ?? "")) fail("GCP_FASTPATH_SEED_SUFFIX_INVALID", String(suffix));
  const target = GCP_FASTPATH_SEED.targetPrefix + suffix;
  return Object.freeze({ suffix, target, control: GCP_FASTPATH_SEED.controlPrefix + suffix });
}

/** Deterministic per (commit, golden dump): a re-run finds the same schema. */
export function defaultSuffix(commit, dumpSha256) {
  if (!COMMIT.test(commit ?? "") || !SHA256.test(dumpSha256 ?? "")) fail("GCP_FASTPATH_SEED_SUFFIX_INPUT_INVALID");
  return createHash("sha256").update(`${commit}\n${dumpSha256}`).digest("hex").slice(0, 8);
}

export function seedMarker(commit, dumpSha256) {
  return `${SEED_MARKER_VERSION} complete commit=${commit} dump=${dumpSha256}`;
}

/** A source id or typed-storage namespace the origin and its env flag both accept. */
const SOURCE_IDENTITY = /^[A-Za-z0-9._:-]{1,200}$/u;

function dumpCell(dump, tableName, column) {
  const table = Array.isArray(dump?.tables) ? dump.tables.find((entry) => entry?.name === tableName) : undefined;
  const index = Array.isArray(table?.columns) ? table.columns.indexOf(column) : -1;
  if (index < 0 || !Array.isArray(table.rows) || table.rows.length !== 1) return undefined;
  return table.rows[0][index];
}

/**
 * The typed-storage source the golden's USAGE_MONITOR_DB dump pins, which the
 * T-1 copy carries into the seeded schema unchanged: storage_source_state's
 * source id and the namespace both typed admission states name. An origin
 * serving that schema must be configured with exactly these
 * (POSTGRES_SOURCE_ID, POSTGRES_SOURCE_NAMESPACE): its typed routes refuse
 * any other source with 503 BACKEND_STORAGE_UNAVAILABLE.
 */
export function goldenSourceIdentity(dump) {
  const sourceId = dumpCell(dump, "storage_source_state", "source_id");
  const v1 = dumpCell(dump, "typed_v1_admission_state", "source_namespace");
  const v11 = dumpCell(dump, "typed_v11_admission_state", "source_namespace");
  if (!SOURCE_IDENTITY.test(sourceId ?? "") || !SOURCE_IDENTITY.test(v1 ?? "") || v1 !== v11) {
    fail("GCP_FASTPATH_SEED_GOLDEN_SOURCE_INVALID");
  }
  return Object.freeze({ sourceId, sourceNamespace: v1 });
}

/** The golden's manifest, dump path, dump digest, pinned clock and source identity (read-only). */
export async function readSeedGolden(golden = GCP_FASTPATH_SEED.defaultGolden) {
  const directory = join(REPOSITORY_ROOT, goldenPath(golden));
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const dumpPath = join(directory, "dump", "usage-monitor-db.json");
  if (typeof manifest?.now !== "string" || !Array.isArray(manifest?.owners)) fail("GCP_FASTPATH_SEED_GOLDEN_INVALID");
  const dump = await readFile(dumpPath);
  return Object.freeze({ manifest, dumpPath, dumpSha256: createHash("sha256").update(dump).digest("hex"),
    nowIso: manifest.now, sourceIdentity: goldenSourceIdentity(JSON.parse(dump.toString("utf8"))) });
}

/** The source the seeded schema pins, read back as the typed routes read it. */
async function seededSourceIdentity(pool, schema) {
  const result = await pool.query(`SELECT source.source_id, v1.source_namespace AS v1_namespace,
      v11.source_namespace AS v11_namespace,
      (v1.runtime_contract_version = 1 AND v11.runtime_contract_version = 1) AS runtime_current
    FROM "${schema}".storage_source_state source
    JOIN "${schema}".typed_v1_admission_state v1 ON v1.id = 1
    JOIN "${schema}".typed_v11_admission_state v11 ON v11.id = 1
    WHERE source.singleton = 1`);
  const row = result.rows.length === 1 ? result.rows[0] : null;
  if (row === null || row.v1_namespace !== row.v11_namespace || row.runtime_current !== true) return null;
  return Object.freeze({ sourceId: row.source_id, sourceNamespace: row.v1_namespace });
}

async function loadStage(stage) {
  const module = await import(pathToFileURL(join(REPOSITORY_ROOT, stage.path)).href);
  const missing = stage.exports.filter((name) => typeof module[name] !== "function");
  if (missing.length > 0) {
    fail("GCP_FASTPATH_SEED_STAGE_CONTRACT_MISMATCH",
      `${stage.path} lacks ${missing.join(", ")}; exports: ${Object.keys(module).join(", ")}`);
  }
  return module;
}

/** Load every stage and check its contract; returns the rehearsal loader module. */
export async function loadSeedStages() {
  const modules = new Map();
  for (const stage of SEED_STAGES) modules.set(stage.name, await loadStage(stage));
  return modules.get("rehearsal-loader");
}

async function schemaState(pool, schema) {
  const result = await pool.query(`SELECT pg_get_userbyid(nspowner) AS owner,
      obj_description(oid, 'pg_namespace') AS marker FROM pg_namespace WHERE nspname = $1`, [schema]);
  return result.rows[0] ?? null;
}

async function ensureOwnedSchema(pool, schema, owner) {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  const state = await schemaState(pool, schema);
  if (owner !== null && state?.owner !== owner) fail("GCP_FASTPATH_SEED_SCHEMA_OWNER_UNEXPECTED", schema);
}

const READBACK_TABLES = Object.freeze([
  "participants", "storage_v11_owner_links", "typed_telemetry_owners", "typed_telemetry_records",
  "telemetry_v12_records", "telemetry_v12_day_manifests", "telemetry_v11_day_manifests", "telemetry_v1_chunks",
  "storage_v12_event_sources", "storage_ingestion_changes", "community_public_source_owners",
  "analytics_v2_published_daily",
]);

/** Read-only counts as the runtime IAM user: proves its grants, not the migrator's. */
export async function readBackAsRuntime(schema, { createPool = createGcpFastpathPool } = {}) {
  const runtime = await createPool({ as: "runtime", max: 1, applicationName: "tibotattle-fastpath-readback" });
  const client = await runtime.pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const counts = {};
    for (const table of READBACK_TABLES) {
      const exists = await client.query("SELECT to_regclass($1) AS relation", [`"${schema}"."${table}"`]);
      if (exists.rows[0]?.relation === null) continue;
      const counted = await client.query(`SELECT count(*)::int AS rows FROM "${schema}"."${table}"`);
      counts[table] = counted.rows[0].rows;
    }
    const history = await client.query(
      `SELECT count(*)::int AS applied, max(version)::int AS latest FROM "${schema}"."_tibotattle_migration_history"`);
    const privileges = await client.query(`SELECT has_schema_privilege(current_user, $1, 'CREATE') AS schema_create,
      has_table_privilege(current_user, $2, 'INSERT') AS history_insert`,
    [schema, `"${schema}"."_tibotattle_migration_history"`]);
    await client.query("ROLLBACK");
    return Object.freeze({ user: runtime.identity, schema, migrations: history.rows[0], counts,
      runtimeCanCreateInSchema: privileges.rows[0].schema_create,
      runtimeCanWriteMigrationHistory: privileges.rows[0].history_insert });
  } finally {
    client.release();
    await runtime.close();
  }
}

async function grantRuntime(pool, schema) {
  const { grantAndVerifyTestRuntimePrivileges } = await import("../cloud-run/test-migrations.mjs");
  await grantAndVerifyTestRuntimePrivileges(pool, "primary", schema);
}

async function applyPrimaryMigrations(pool, schema) {
  const { applyPostgresMigrations } = await import("../cloud-run/postgres-migrations.mjs");
  const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
  return { applied: applied.applied, latest: applied.migrations.at(-1)?.name ?? null };
}

function verificationsEqual(verification) {
  return verification !== null && typeof verification === "object"
    && Object.values(verification).every((entry) => entry?.equal === true);
}

/**
 * Seed one fast-path rehearsal target from the golden through the local
 * rehearsal's loader. Returns a receipt whose `status` is "seeded",
 * "already-seeded" or "skipped"; a seeded receipt's `sourceIdentity` is the
 * source the schema pins (read back), which the origin serving it must be
 * configured with. `dependencies` exists for the local PG17
 * check: spawn (git), createPool for the migrator, expectedOwner (null skips
 * the owner check), grantRuntime and readBack.
 */
export async function runGcpFastpathSeed({
  commit: ref,
  golden = GCP_FASTPATH_SEED.defaultGolden,
  schemaSuffix,
  replace = false,
  log = (line) => console.error(line),
  dependencies = {},
} = {}) {
  const spawn = dependencies.spawn ?? spawnSync;
  const commit = resolveCommit(ref, spawn);
  const plan = planSeed(commit, { spawn, golden });
  if (plan.decision === "skip") {
    log(`# seed skipped: ${plan.reason}`);
    return Object.freeze({ step: "seed", status: "skipped", reason: plan.reason, plan });
  }
  if (plan.decision === "refuse") fail("GCP_FASTPATH_SEED_CHECKOUT_MISMATCH", plan.reason);
  const { manifest, dumpPath, dumpSha256, sourceIdentity } = await readSeedGolden(plan.golden);
  const loader = await loadSeedStages();
  const suffix = schemaSuffix ?? defaultSuffix(commit, dumpSha256);
  const schemas = seededSchemas(suffix);
  const named = loader.fastpathRehearsalSchemas(suffix);
  if (named.schema !== schemas.target || named.controlSchema !== schemas.control) {
    fail("GCP_FASTPATH_SEED_STAGE_CONTRACT_MISMATCH", "schema naming differs from the rehearsal's");
  }
  const marker = seedMarker(commit, dumpSha256);
  const createPool = dependencies.createPool ?? createGcpFastpathPool;
  const migrator = await createPool({ as: "migrator", max: 4 });
  const owner = dependencies.expectedOwner === undefined
    ? GCP_FASTPATH_CONNECTION.identities.migrator.iamUser : dependencies.expectedOwner;
  const started = Date.now();
  const timings = {};
  let workDirectory = null;
  let status = "seeded";
  let steps = null;
  try {
    const existing = await schemaState(migrator.pool, schemas.target);
    if (existing !== null && existing.marker !== marker) {
      if (!replace) {
        fail("GCP_FASTPATH_SEED_PARTIAL_SCHEMA",
          `${schemas.target} exists without this seed's completion marker; pass --replace or another --schema-suffix`);
      }
      // Exactly the two prefix-validated schemas this seed names, nothing else.
      for (const schema of [schemas.target, schemas.control]) {
        await migrator.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      log(`# seed: dropped the partial ${schemas.target} and ${schemas.control} (--replace)`);
    }
    await ensureOwnedSchema(migrator.pool, schemas.target, owner);
    await ensureOwnedSchema(migrator.pool, schemas.control, owner);
    const migrations = await applyPrimaryMigrations(migrator.pool, schemas.target);
    // The origin is configured with the golden's source; the schema must pin it.
    const assertSourceIdentity = async () => {
      const seeded = await seededSourceIdentity(migrator.pool, schemas.target);
      if (seeded?.sourceId !== sourceIdentity.sourceId || seeded?.sourceNamespace !== sourceIdentity.sourceNamespace) {
        fail("GCP_FASTPATH_SEED_SOURCE_IDENTITY_MISMATCH", schemas.target);
      }
    };
    if (existing !== null && existing.marker === marker) {
      status = "already-seeded";
      log(`# seed: ${schemas.target} already holds this commit's seed of this golden; importers not re-run`);
      await assertSourceIdentity();
    } else {
      workDirectory = await realpath(await mkdtemp(join(tmpdir(), "gcp-fastpath-seed-")));
      const sealed = await loader.sealFastpathRehearsalSource({ dumpPath, workDirectory });
      // The Cloud SQL connector session is not a local Unix socket: the seed,
      // and only the seed, names its fast-path cloud target to the importers
      // (scripts/gcp-fastpath-cloud-target.mjs holds the exact conditions).
      steps = { sqlite: sealed.report, ...await loader.loadFastpathRehearsalImporters({
        pool: migrator.pool, schema: schemas.target, controlSchema: schemas.control, suffix,
        sealedSource: sealed.sealedSource, dumpPath, workDirectory, roster: manifest.owners, timings,
        cloudFastpathTarget: true,
      }) };
      if (!verificationsEqual(steps.importVerification)) {
        fail("GCP_FASTPATH_SEED_VERIFICATION_FAILED", JSON.stringify(steps.importVerification));
      }
      await assertSourceIdentity();
      // The marker is written last: a schema without it is a partial seed.
      await migrator.pool.query(`COMMENT ON SCHEMA "${schemas.target}" IS '${marker}'`);
    }
    await (dependencies.grantRuntime ?? grantRuntime)(migrator.pool, schemas.target);
    const readback = await (dependencies.readBack ?? readBackAsRuntime)(schemas.target);
    return Object.freeze({ step: "seed", status, commit, golden: plan.golden, dumpSha256,
      schema: schemas.target, controlSchema: schemas.control, nowIso: manifest.now, sourceIdentity, migrations, steps,
      timingsMs: timings, readback, plan, durationSeconds: (Date.now() - started) / 1000 });
  } finally {
    if (workDirectory !== null) await rm(workDirectory, { recursive: true, force: true });
    await migrator.close();
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["seed", "plan", "readback"].includes(command)) fail("GCP_FASTPATH_SEED_COMMAND_INVALID", String(command));
  const options = { command, target: undefined, replace: false };
  for (const argument of rest) {
    if (argument === "--replace") { options.replace = true; continue; }
    const separator = argument.indexOf("=");
    const key = separator > 2 ? argument.slice(2, separator) : "";
    const value = separator > 2 ? argument.slice(separator + 1) : "";
    if (!argument.startsWith("--") || value.length === 0) fail("GCP_FASTPATH_SEED_ARGUMENT_INVALID", argument);
    if (key === "target") options.target = validateTarget(value);
    else if (key === "commit") options.commit = value;
    else if (key === "golden") options.golden = value;
    else if (key === "schema-suffix") options.schemaSuffix = value;
    else if (key === "schema") options.schema = value;
    else fail("GCP_FASTPATH_SEED_ARGUMENT_INVALID", argument);
  }
  if (command !== "plan" && options.target === undefined) fail("GCP_FASTPATH_SEED_TARGET_REQUIRED", "--target=gcp-fastpath");
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    let result;
    if (options.command === "plan") {
      result = planSeed(resolveCommit(options.commit ?? "HEAD"), { golden: options.golden });
    } else if (options.command === "readback") {
      if (!options.schema?.startsWith(GCP_FASTPATH_SEED.targetPrefix)) fail("GCP_FASTPATH_SEED_SCHEMA_INVALID");
      result = await readBackAsRuntime(seededSchemas(options.schema.slice(GCP_FASTPATH_SEED.targetPrefix.length)).target);
    } else {
      result = await runGcpFastpathSeed(options);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: "error", code: error?.code ?? "GCP_FASTPATH_SEED_FAILED",
      message: String(error?.message ?? "") }));
    process.exitCode = 1;
  }
}
