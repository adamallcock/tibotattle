#!/usr/bin/env node

/**
 * Seed the disposable fast-path test database (`tibotattle_fastpath`) from a
 * hash-sealed SQLite dump through the rehearsal importers, then give the
 * runtime IAM user exactly the reviewed runtime grants and read back as it.
 *
 * The importers keep their prefix guards: the seeded schema is a
 * `typed_legacy_transfer_rehearsal_target_<suffix>` schema inside the
 * fast-path database, and refresh/origin are pointed at it explicitly.
 *
 *   node scripts/gcp-fastpath-seed.mjs seed --target=gcp-fastpath --commit=<ref>
 *        --sqlite=<path> --sqlite-sha256=<hex> [--schema-suffix=<suffix>]
 *   node scripts/gcp-fastpath-seed.mjs prove --target=gcp-fastpath
 *   node scripts/gcp-fastpath-seed.mjs plan --commit=<ref>
 *
 * Importers run from this checkout, so the stage files and migrations must
 * equal the deployed commit's; a stage absent from that commit is skipped
 * with its reason. No credential is read, printed or stored.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGcpFastpathPool, GCP_FASTPATH_CONNECTION, validateTarget } from "./gcp-fastpath-connection.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SUFFIX = /^[a-z][a-z0-9_]{7,23}$/u;

export const GCP_FASTPATH_SEED = Object.freeze({
  targetPrefix: "typed_legacy_transfer_rehearsal_target_",
  controlPrefix: "typed_legacy_transfer_rehearsal_",
  migrationPaths: Object.freeze([
    "apps/worker/postgres/migrations",
    "apps/worker/cloud-run/postgres-migrations.mjs",
  ]),
});

/**
 * Ordered importer stages. Call contracts for the stages that do not exist
 * yet (T-1, T-2) are the ones this wrapper will invoke; their owners align
 * the export names or the integration lead adjusts this table.
 */
export const SEED_STAGES = Object.freeze([
  Object.freeze({
    name: "identity", label: "T-1 identity/authority copy", required: true,
    path: "apps/worker/scripts/postgres-fastpath-identity-copy.mjs",
    exports: Object.freeze(["runPostgresFastpathIdentityCopy"]),
  }),
  Object.freeze({
    name: "typed-legacy", label: "typed-legacy v1/v1.1 transfer", required: true,
    path: "apps/worker/scripts/postgres-typed-legacy-transfer.mjs",
    exports: Object.freeze(["createSealedSqliteTypedLegacyRehearsalSource", "runPostgresTypedLegacyTransfer"]),
  }),
  Object.freeze({
    name: "v12", label: "T-2 v1.2 transfer", required: false,
    path: "apps/worker/scripts/postgres-v12-transfer.mjs",
    exports: Object.freeze(["createSealedSqliteV12RehearsalSource", "runPostgresV12Transfer"]),
  }),
]);

/** Importers whose own prefix guard cannot target the shared seeded schema. */
export const UNSEEDED_IMPORTERS = Object.freeze([
  Object.freeze({ label: "usage-correction transfer", path: "apps/worker/scripts/postgres-usage-correction-transfer.mjs",
    reason: "its target guard requires usage_correction_transfer_target_*" }),
  Object.freeze({ label: "ingestion-journal transfer", path: "apps/worker/scripts/postgres-ingestion-journal-transfer.mjs",
    reason: "its target guard requires storage_journal_transfer_target_*" }),
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

/** True when this checkout's files at `paths` equal the commit (no diff, no untracked extras). */
function checkoutMatches(commit, paths, spawn) {
  const diff = git(["diff", "--quiet", commit, "--", ...paths], spawn);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...paths], spawn);
  return diff.status === 0 && untracked.status === 0 && String(untracked.stdout).trim() === "";
}

/** Which stages exist at the commit, and whether this checkout can run them. */
export function planSeed(commit, spawn = spawnSync) {
  const stages = SEED_STAGES.map((stage) => {
    const inCommit = git(["cat-file", "-e", `${commit}:${stage.path}`], spawn).status === 0;
    if (!inCommit) return { ...stage, status: "absent" };
    return { ...stage, status: checkoutMatches(commit, [stage.path], spawn) ? "present" : "checkout-mismatch" };
  });
  const migrationsMatch = checkoutMatches(commit, GCP_FASTPATH_SEED.migrationPaths, spawn);
  const missingRequired = stages.filter((stage) => stage.required && stage.status === "absent");
  const mismatched = stages.filter((stage) => stage.status === "checkout-mismatch");
  let decision = "run";
  let reason = null;
  if (missingRequired.length > 0) {
    decision = "skip";
    reason = `${missingRequired.map((stage) => `${stage.label} (${stage.path})`).join(", ")} absent at `
      + `${commit.slice(0, 12)}; without destination identity the typed-legacy importer refuses every owner`;
  } else if (mismatched.length > 0 || !migrationsMatch) {
    decision = "refuse";
    reason = `this checkout differs from ${commit.slice(0, 12)} in `
      + `${[...mismatched.map((stage) => stage.path), ...(migrationsMatch ? [] : GCP_FASTPATH_SEED.migrationPaths)].join(", ")}`
      + "; run the seed from a checkout of the deployed commit";
  }
  return Object.freeze({
    commit, decision, reason,
    stages: stages.map(({ name, label, path, status, required }) => ({ name, label, path, status, required })),
    unseeded: UNSEEDED_IMPORTERS.map(({ label, reason: why }) => ({ label, reason: why })),
  });
}

export function seededSchemas(suffix) {
  if (!SUFFIX.test(suffix ?? "")) fail("GCP_FASTPATH_SEED_SUFFIX_INVALID", String(suffix));
  return Object.freeze({
    target: GCP_FASTPATH_SEED.targetPrefix + suffix,
    control: GCP_FASTPATH_SEED.controlPrefix + suffix,
  });
}

/** Deterministic per (commit, dump): a re-run finds the same schema. */
export function defaultSuffix(commit, sqliteSha256) {
  return `fp_${commit.slice(0, 8)}_${sqliteSha256.slice(0, 8)}`;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function ensureSchemas(pool, schemas) {
  for (const schema of [schemas.target, schemas.control]) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    const owner = await pool.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1",
      [schema]);
    if (owner.rows[0]?.owner !== GCP_FASTPATH_CONNECTION.identities.migrator.iamUser) {
      fail("GCP_FASTPATH_SEED_SCHEMA_OWNER_UNEXPECTED", schema);
    }
  }
}

async function completedTypedLegacyRun(pool, schemas, transferId) {
  const table = await pool.query("SELECT to_regclass($1) AS relation",
    [`"${schemas.control}"."_typed_legacy_transfer_rehearsal_runs_v1"`]);
  if (table.rows[0]?.relation === null) return false;
  const run = await pool.query(`SELECT status FROM "${schemas.control}"."_typed_legacy_transfer_rehearsal_runs_v1"
    WHERE transfer_id=$1`, [transferId]);
  return run.rows[0]?.status === "complete";
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

const READBACK_TABLES = Object.freeze([
  "participants", "storage_v11_owner_links", "typed_telemetry_dictionary", "typed_telemetry_namespaces",
  "typed_telemetry_owners", "typed_telemetry_owner_memberships", "typed_telemetry_devices",
  "typed_telemetry_manifests", "typed_telemetry_chunks", "typed_telemetry_records", "typed_telemetry_usage",
  "typed_telemetry_quota", "typed_telemetry_session_tools", "telemetry_v12_domains", "telemetry_v12_day_manifests",
  "telemetry_v12_chunks",
]);

/** Read-only counts as the runtime IAM user: proves its grants, not the migrator's. */
export async function readBackAsRuntime(schema) {
  const runtime = await createGcpFastpathPool({ as: "runtime", max: 1, applicationName: "tibotattle-fastpath-readback" });
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

/**
 * Seed one rehearsal-target schema from a sealed SQLite dump. Returns a
 * receipt; `status` is "seeded", "already-seeded" or "skipped".
 */
export async function runGcpFastpathSeed({
  commit: ref,
  sqlitePath,
  sqliteSha256,
  schemaSuffix,
  log = (line) => console.error(line),
} = {}) {
  const commit = resolveCommit(ref);
  const plan = planSeed(commit);
  if (plan.decision === "skip") {
    log(`# seed skipped: ${plan.reason}`);
    return Object.freeze({ step: "seed", status: "skipped", reason: plan.reason, plan });
  }
  if (plan.decision === "refuse") fail("GCP_FASTPATH_SEED_CHECKOUT_MISMATCH", plan.reason);
  if (!SHA256.test(sqliteSha256 ?? "")) fail("GCP_FASTPATH_SEED_SQLITE_SHA256_REQUIRED");
  const sqlite = await realpath(resolve(sqlitePath ?? ""));
  if (await sha256File(sqlite) !== sqliteSha256) fail("GCP_FASTPATH_SEED_SQLITE_SHA256_MISMATCH");
  const schemas = seededSchemas(schemaSuffix ?? defaultSuffix(commit, sqliteSha256));
  const transferId = `gcp-fastpath-${schemas.target.slice(GCP_FASTPATH_SEED.targetPrefix.length)}`;
  const modules = new Map();
  for (const stage of SEED_STAGES) {
    const planned = plan.stages.find(({ name }) => name === stage.name);
    if (planned.status === "present") modules.set(stage.name, await loadStage(stage));
    else log(`# seed stage skipped: ${stage.label} (${stage.path}) is absent at ${commit.slice(0, 12)}`);
  }
  for (const unseeded of plan.unseeded) log(`# seed stage not run: ${unseeded.label}: ${unseeded.reason}`);
  const migrator = await createGcpFastpathPool({ as: "migrator", max: 4 });
  const started = Date.now();
  const stages = [];
  let status = "seeded";
  try {
    await ensureSchemas(migrator.pool, schemas);
    const migrations = await applyPrimaryMigrations(migrator.pool, schemas.target);
    if (await completedTypedLegacyRun(migrator.pool, schemas, transferId)) {
      status = "already-seeded";
      log(`# seed: ${schemas.target} already holds a complete transfer ${transferId}; importers not re-run`);
    } else {
      const identity = modules.get("identity");
      const identityReceipt = await identity.runPostgresFastpathIdentityCopy({
        sqlitePath: sqlite, expectedSha256: sqliteSha256, destinationPool: migrator.pool, targetSchema: schemas.target,
      });
      stages.push({ name: "identity", receipt: identityReceipt });
      const typed = modules.get("typed-legacy");
      const typedSource = await typed.createSealedSqliteTypedLegacyRehearsalSource({ path: sqlite, expectedSha256: sqliteSha256 });
      try {
        const receipt = await typed.runPostgresTypedLegacyTransfer({ source: typedSource, destinationPool: migrator.pool,
          targetSchema: schemas.target, controlSchema: schemas.control, transferId });
        stages.push({ name: "typed-legacy", status: receipt.status, destinationManifestSha256: receipt.destination?.manifestSha256 });
      } finally {
        typedSource.close?.();
      }
      const v12 = modules.get("v12");
      if (v12 !== undefined) {
        const v12Source = await v12.createSealedSqliteV12RehearsalSource({ path: sqlite, expectedSha256: sqliteSha256 });
        try {
          const receipt = await v12.runPostgresV12Transfer({ source: v12Source, destinationPool: migrator.pool,
            targetSchema: schemas.target, controlSchema: schemas.control, transferId: `${transferId}-v12` });
          stages.push({ name: "v12", status: receipt?.status ?? null });
        } finally {
          v12Source.close?.();
        }
      }
    }
    await grantRuntime(migrator.pool, schemas.target);
    const readback = await readBackAsRuntime(schemas.target);
    return Object.freeze({ step: "seed", status, commit, schema: schemas.target, controlSchema: schemas.control,
      transferId, sqliteSha256, migrations, stages, readback, plan, durationSeconds: (Date.now() - started) / 1000 });
  } finally {
    await migrator.close();
  }
}

/** Synthetic, content-free sealed SQLite in the D1 source layout the typed-legacy importer reads. */
async function syntheticSealedSqlite() {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-fastpath-proof-")));
  const path = join(directory, "source.sqlite");
  const linked = "synthetic-fastpath-linked-owner";
  const linkless = "synthetic-fastpath-linkless-owner";
  const ownerDigest = "c".repeat(64);
  const day = 20_725;
  const at = Date.UTC(2026, 8, 29, 12);
  const byte = (value, size = 24) => Buffer.alloc(size, value);
  const tables = {
    typed_telemetry_dictionary: ["openai_codex", "model-x", "standard", "default-tier", "cli", "codex-billing",
      "medium", "core", "success", "plus", "standard-variant", "five-hour", "primary", "shell"]
      .map((value, index) => ({ id: index + 1, value })),
    typed_telemetry_namespaces: [{ id: 100, original_id: byte(1) }],
    typed_telemetry_owners: [{ id: 200, namespace_id: 100, original_id: byte(2) },
      { id: 201, namespace_id: 100, original_id: byte(8) }],
    typed_telemetry_devices: [{ id: 300, namespace_id: 100, owner_id: 200, original_id: byte(3) },
      { id: 301, namespace_id: 100, owner_id: 200, original_id: byte(4) }],
    typed_telemetry_manifests: [{ id: 401, namespace_id: 100, owner_id: 200, device_id: 301, original_id: byte(5), chunk_day: day }],
    typed_telemetry_identifiers: [{ id: 600, namespace_id: 100, owner_id: 200, value: byte(6) },
      { id: 601, namespace_id: 100, owner_id: 200, value: byte(7) }],
    typed_telemetry_attributions: [{ id: 611, namespace_id: 100, owner_id: 200, account_basis: 0,
      account_track: Buffer.alloc(0), plan_basis: 0, plan_type_id: 10, plan_era: Buffer.alloc(0) }],
    typed_telemetry_quota_dimensions: [
      { id: 602, namespace_id: 100, owner_id: 200, plan_type_id: 10, plan_variant_id: 11, attribution_id: null },
      { id: 603, namespace_id: 100, owner_id: 200, plan_type_id: 10, plan_variant_id: 11, attribution_id: 611 }],
    typed_telemetry_chunks: [
      ...[101, 102, 103].map((id) => ({ id, namespace_id: 100, format: 10, owner_id: 200, device_id: 300,
        manifest_id: null, original_id: byte(id), stream: id - 100, chunk_day: day })),
      ...[[111, 2], [112, 3]].map(([id, stream]) => ({ id, namespace_id: 100, format: 11, owner_id: 200,
        device_id: 301, manifest_id: 401, original_id: byte(id), stream, chunk_day: day }))],
    typed_telemetry_records: [],
    typed_telemetry_usage: [],
    typed_telemetry_quota: [],
    typed_telemetry_session_tools: [],
  };
  const record = (id, format, stream, chunkId, manifestId = null) => tables.typed_telemetry_records.push({
    id, namespace_id: 100, format, source_row_id: id, owner_id: 200, device_id: format === 10 ? 300 : 301,
    chunk_id: chunkId, manifest_id: manifestId, stream, occurrence_id: Buffer.from(`synthetic-occurrence-${id}`),
    observed_at_ms: at, observed_day: day, provider_id: 1, canonical_digest: byte(id % 255, 32) });
  for (let id = 1001; id <= 1004; id += 1) record(id, 10, 1, 101);
  record(1101, 10, 2, 102);
  record(1201, 10, 3, 103);
  record(2001, 11, 2, 111, 401);
  record(2002, 11, 3, 112, 401);
  for (let id = 1001; id <= 1004; id += 1) {
    tables.typed_telemetry_usage.push({ record_id: id, stream: 1, session_id: 600, model_id: 2, speed_mode_id: 3,
      api_service_tier_id: 4, surface_id: 5, billing_surface_id: 6, reasoning_effort_id: 7, agent_scope_id: 8,
      outcome_id: 9, attribution_id: null, total_input_context_tokens: 1000, input_uncached_tokens: 100,
      input_cache_read_tokens: 900, input_cache_write_tokens: 0, output_text_tokens: 50,
      output_reasoning_tokens: 25, output_combined_tokens: 75 });
  }
  for (const recordId of [1101, 2001]) {
    tables.typed_telemetry_quota.push({ record_id: recordId, stream: 2, dimensions_id: recordId === 1101 ? 602 : 603,
      limit_id: 12, slot_id: 13, used_percent: 75, window_duration_minutes: 300, resets_at_ms: at + 86_400_000 });
  }
  for (const recordId of [1201, 2002]) {
    tables.typed_telemetry_session_tools.push({ record_id: recordId, stream: 3, tool_class_id: 14, count: 2 });
  }
  const db = new DatabaseSync(path);
  const quoted = (name) => `"${name}"`;
  try {
    for (const [table, rows] of Object.entries(tables)) {
      const columns = Object.keys(rows[0]);
      db.exec(`CREATE TABLE ${quoted(table)} (${columns.map((name) => {
        const sample = rows.find((row) => row[name] !== null)?.[name];
        return `${quoted(name)} ${Buffer.isBuffer(sample) ? "BLOB" : typeof sample === "number" ? "INTEGER" : "TEXT"}`;
      }).join(",")})`);
      const insert = db.prepare(`INSERT INTO ${quoted(table)} (${columns.map(quoted).join(",")})
        VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of rows) insert.run(...columns.map((column) => row[column]));
    }
    db.exec(`CREATE TABLE typed_v1_owner_memberships(typed_owner_id INTEGER, participant_id TEXT);
      CREATE TABLE typed_v11_owner_memberships(typed_owner_id INTEGER, participant_id TEXT);
      CREATE TABLE typed_v1_admission_state(id INTEGER, namespace_id INTEGER, source_namespace TEXT);
      CREATE TABLE typed_v11_admission_state(id INTEGER, namespace_id INTEGER, source_namespace TEXT);
      CREATE TABLE participants(id TEXT, state TEXT);
      CREATE TABLE storage_v11_owner_links(participant_id TEXT, owner_digest TEXT, state TEXT);`);
    db.prepare("INSERT INTO typed_v1_admission_state VALUES (1,100,?)").run("synthetic-fastpath-v1-source");
    db.prepare("INSERT INTO typed_v11_admission_state VALUES (1,100,?)").run("synthetic-fastpath-v11-source");
    db.prepare("INSERT INTO participants VALUES (?,'active')").run(linked);
    db.prepare("INSERT INTO participants VALUES (?,'active')").run(linkless);
    db.prepare("INSERT INTO storage_v11_owner_links VALUES (?,?,'active')").run(linked, ownerDigest);
    db.prepare("INSERT INTO typed_v1_owner_memberships VALUES (200,?)").run(linked);
    db.prepare("INSERT INTO typed_v11_owner_memberships VALUES (200,?)").run(linked);
    db.prepare("INSERT INTO typed_v11_owner_memberships VALUES (201,?)").run(linkless);
  } finally {
    db.close();
  }
  await chmod(path, 0o400);
  return { directory, path, sha256: await sha256File(path) };
}

/**
 * Prove the path end to end with today's code: migrate a rehearsal target in
 * the fast-path database, stand in for T-1 with the fixture's two synthetic
 * participants and one owner link (direct SQL, as the importer's PG spec
 * does), run the existing typed-legacy importer from a sealed SQLite, apply
 * runtime grants and read back as the runtime IAM user.
 */
export async function proveGcpFastpathSeed({ log = (line) => console.error(line) } = {}) {
  const fixture = await syntheticSealedSqlite();
  // Deterministic per fixture: a re-run reuses the schema and skips a completed import.
  const suffix = `fp_proof_${fixture.sha256.slice(0, 8)}`;
  const schemas = seededSchemas(suffix);
  const transferId = `gcp-fastpath-proof-${suffix}`;
  const typed = await import("./postgres-typed-legacy-transfer.mjs");
  const migrator = await createGcpFastpathPool({ as: "migrator", max: 4 });
  const started = Date.now();
  try {
    await ensureSchemas(migrator.pool, schemas);
    const migrationsStarted = Date.now();
    const migrations = await applyPrimaryMigrations(migrator.pool, schemas.target);
    const migrationSeconds = (Date.now() - migrationsStarted) / 1000;
    log(`# proof: ${schemas.target} migrated (${migrations.applied}, ${migrations.latest}) in ${migrationSeconds}s`);
    const alreadyComplete = await completedTypedLegacyRun(migrator.pool, schemas, transferId);
    if (!alreadyComplete) {
      const now = new Date().toISOString();
      await migrator.pool.query(`INSERT INTO "${schemas.target}".participants(id, created_at) VALUES ($1,$3),($2,$3)
        ON CONFLICT (id) DO NOTHING`, ["synthetic-fastpath-linked-owner", "synthetic-fastpath-linkless-owner", now]);
      await migrator.pool.query(`INSERT INTO "${schemas.target}".storage_v11_owner_links(participant_id, owner_digest, state)
        VALUES ($1,$2,'active') ON CONFLICT (participant_id) DO NOTHING`, ["synthetic-fastpath-linked-owner", "c".repeat(64)]);
    }
    // The importer is idempotent per transfer id: a completed run re-verifies parity without rewriting.
    const source = await typed.createSealedSqliteTypedLegacyRehearsalSource({
      path: fixture.path, expectedSha256: fixture.sha256 });
    let receipt;
    const importStarted = Date.now();
    try {
      receipt = await typed.runPostgresTypedLegacyTransfer({ source, destinationPool: migrator.pool,
        targetSchema: schemas.target, controlSchema: schemas.control, transferId, pageSize: 200 });
    } finally {
      source.close?.();
    }
    const importSeconds = (Date.now() - importStarted) / 1000;
    log(`# proof: typed-legacy import ${receipt.status} in ${importSeconds}s (re-run: ${alreadyComplete})`);
    await grantRuntime(migrator.pool, schemas.target);
    const readback = await readBackAsRuntime(schemas.target);
    return Object.freeze({
      step: "prove", status: receipt.status, reRun: alreadyComplete, schema: schemas.target, controlSchema: schemas.control, transferId,
      sqliteSha256: fixture.sha256, identity: "proof stand-in: 2 synthetic participants + 1 owner link by direct SQL",
      migrations, migrationSeconds, importSeconds,
      sourceRows: Object.fromEntries(Object.entries(receipt.source?.tables ?? {}).map(([name, table]) => [name, table.rows])),
      sourceManifestSha256: receipt.source?.manifestSha256, destinationManifestSha256: receipt.destination?.manifestSha256,
      stagingFamilyEvidence: receipt.stagingFamilyEvidence?.rowCount ?? null,
      readback, durationSeconds: (Date.now() - started) / 1000,
    });
  } finally {
    await migrator.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["seed", "prove", "plan", "readback"].includes(command)) fail("GCP_FASTPATH_SEED_COMMAND_INVALID", String(command));
  const options = { command, target: undefined };
  for (const argument of rest) {
    const separator = argument.indexOf("=");
    const key = separator > 2 ? argument.slice(2, separator) : "";
    const value = separator > 2 ? argument.slice(separator + 1) : "";
    if (!argument.startsWith("--") || value.length === 0) fail("GCP_FASTPATH_SEED_ARGUMENT_INVALID", argument);
    if (key === "target") options.target = validateTarget(value);
    else if (key === "commit") options.commit = value;
    else if (key === "sqlite") options.sqlitePath = value;
    else if (key === "sqlite-sha256") options.sqliteSha256 = value;
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
    if (options.command === "plan") result = planSeed(resolveCommit(options.commit ?? "HEAD"));
    else if (options.command === "prove") result = await proveGcpFastpathSeed();
    else if (options.command === "readback") {
      if (!options.schema?.startsWith(GCP_FASTPATH_SEED.targetPrefix)) fail("GCP_FASTPATH_SEED_SCHEMA_INVALID");
      result = await readBackAsRuntime(seededSchemas(options.schema.slice(GCP_FASTPATH_SEED.targetPrefix.length)).target);
    } else result = await runGcpFastpathSeed(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: "error", code: error?.code ?? "GCP_FASTPATH_SEED_FAILED",
      message: String(error?.message ?? "") }));
    process.exitCode = 1;
  }
}
