// PostgreSQL 17: runtime functions resolve their tables without the caller's
// search_path (primary 0062).
//
// Primary 0011 created telemetry_contributions_require_active_participant()
// without SET search_path, and its body reads `participants` unqualified.
// The migration runner pins the runtime schema for each migration, but the
// origin's Cloud SQL pools set no search_path, so the BEFORE INSERT trigger
// resolved `participants` through the server default ("$user", public) and an
// insert from such a session failed 42P01. Primary 0062 pins the function's
// path to its own schema and pg_catalog.
//
// Every pool here sets no search_path, as the origin's do. The first case
// stops the chain before 0062 and shows the failure, then lets the production
// runner apply 0062 on top and writes through the same trigger: it passes only
// with 0062. The second asserts the catalog invariant 0062 completes: every
// function in a migrated primary schema pins its search_path, including the
// two authority fences the append-only residue migration replaces. There is
// no deletion-ledger role to migrate (D4, SIMP-4).

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { applyPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIMARY_DIRECTORY = join(WORKER_ROOT, "postgres", "migrations", "primary");
const PIN_MIGRATION = "0062_telemetry_contribution_trigger_search_path.sql";
const GUARD_FUNCTION = "telemetry_contributions_require_active_participant";
const GUARD_TRIGGER = "telemetry_contributions_active_participant";
const PARTICIPANT_CONSENT = "privacy-safe-telemetry-v0.1";

const endpoint = await postgresTestEndpoint();

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
const quoted = (schema, name) => `"${schema}"."${name}"`;

function poolFor(local, applicationName) {
  // No `options`: the session keeps the server default search_path.
  return new pg.Pool({
    host: local.host, port: local.port, user: local.user, database: local.database,
    password: local.password ?? "synthetic-local-only", ssl: false, max: 2,
    connectionTimeoutMillis: 5_000, application_name: applicationName,
  });
}

/** The pool's sessions are on PostgreSQL 17 and cannot resolve the runtime tables unqualified. */
async function assertNoRuntimeSearchPath(pool, schema) {
  const session = await pool.query(`SELECT current_setting('server_version_num')::integer AS version,
      current_setting('search_path') AS search_path, pg_catalog.to_regclass('participants') AS participants`);
  const row = session.rows[0];
  assert.equal(Math.floor(row.version / 10_000), 17, "qualified on PostgreSQL 17");
  assert.equal(row.search_path.includes(schema), false, "the pool sets no runtime search_path");
  assert.equal(row.participants, null,
    "no `participants` table is visible on the default search_path; the guard could not fail as the origin's did");
}

async function insertParticipant(pool, schema, id, state) {
  await pool.query(`INSERT INTO ${quoted(schema, "participants")} (id, owner_kind, access_token_id,
      access_token_hash, recovery_token_id, recovery_token_hash, state, consent_version, consented_at, created_at)
    VALUES ($1, 'social', $2, $3, $4, $5, $6, $7, now(), now())`,
  [id, `access-${id}`, randomBytes(32), `recovery-${id}`, randomBytes(32), state, PARTICIPANT_CONSENT]);
}

/** One schema-qualified telemetry_contributions row; only the triggers resolve names themselves. */
function insertContribution(pool, schema, participantId, label) {
  const at = "2026-10-01T00:00:00.000Z";
  return pool.query(`INSERT INTO ${quoted(schema, "telemetry_contributions")} (id, participant_id,
      plaintext_digest, envelope_digest, r2_key, status, schema_version, range_start, range_end, client_platform,
      provider_policy_epoch, priced_event_coverage_percent, unknown_model_event_count, unknown_billable_units,
      price_basis, declared_record_count, created_at)
    VALUES ($1, $2, $3, $4, $5, 'accepted', 'telemetry-contribution-v0.1', $6, $6, 'synthetic', 'synthetic',
      0, 0, 0, 'synthetic', 0, $6)`,
  [`contribution:${label}`, participantId, sha256Hex(`plaintext-${label}`), sha256Hex(`envelope-${label}`),
    `synthetic/${label}`, at]);
}

async function contributionCount(pool, schema) {
  const result = await pool.query(`SELECT count(*)::integer AS n FROM ${quoted(schema, "telemetry_contributions")}`);
  return result.rows[0].n;
}

/** Functions in one schema without a search_path setting, by name. */
async function unpinnedFunctions(pool, schema) {
  const result = await pool.query(`SELECT p.proname
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(COALESCE(p.proconfig, '{}'::text[])) setting
                        WHERE setting LIKE 'search_path=%')
     ORDER BY p.proname`, [schema]);
  return result.rows.map((row) => row.proname);
}

test("PG17 0011's active-participant trigger resolves its table without a session search_path only after 0062", {
  skip: endpoint === null,
  timeout: 180_000,
}, async () => {
  const pool = poolFor(endpoint, "pg-function-search-path-trigger-test");
  const schema = `fn_search_path_${randomBytes(6).toString("hex")}`;
  let created = false;
  let prefixRoot = null;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await assertNoRuntimeSearchPath(pool, schema);

    // The promoted chain below 0062, applied by the production runner.
    const names = (await readdir(PRIMARY_DIRECTORY)).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
    assert.equal(names.includes(PIN_MIGRATION), true, `${PIN_MIGRATION} is promoted`);
    const pinVersion = Number(PIN_MIGRATION.slice(0, 4));
    prefixRoot = await mkdtemp(join(tmpdir(), "fn-search-path-"));
    await mkdir(join(prefixRoot, "primary"));
    for (const name of names.filter((entry) => Number(entry.slice(0, 4)) < pinVersion)) {
      await copyFile(join(PRIMARY_DIRECTORY, name), join(prefixRoot, "primary", name));
    }
    const before = await applyPostgresMigrations({ role: "primary", schema, pool, rootDirectory: prefixRoot });
    assert.equal(before.migrations.at(-1)?.name.startsWith(String(pinVersion - 1).padStart(4, "0")), true);
    assert.deepEqual(await unpinnedFunctions(pool, schema), [GUARD_FUNCTION],
      "before 0062 the active-participant guard is the one function without a pinned search_path");

    await insertParticipant(pool, schema, "participant-active", "active");
    await assert.rejects(insertContribution(pool, schema, "participant-active", "before-pin"), (error) => {
      assert.equal(error?.code, "42P01", "the guard cannot resolve `participants` through the default path");
      assert.equal(String(error?.where ?? "").includes(`function ${schema}.${GUARD_FUNCTION}()`), true,
        "the failure is inside the active-participant guard");
      return true;
    });
    assert.equal(await contributionCount(pool, schema), 0);

    // The production runner applies 0062, and the promoted tail after it, on
    // top of the recorded prefix.
    const after = await applyPostgresMigrations({ role: "primary", schema, pool });
    assert.equal(after.migrations.some((migration) => migration.name === PIN_MIGRATION), true);
    assert.equal(after.migrations.at(-1)?.name, names.at(-1));
    assert.equal(after.applied, names.length);
    await assertNoRuntimeSearchPath(pool, schema);

    await insertContribution(pool, schema, "participant-active", "after-pin");
    assert.equal(await contributionCount(pool, schema), 1, "an active participant's contribution is admitted");

    // The same trigger still refuses: a deleting participant is P1001, not 42P01.
    await insertParticipant(pool, schema, "participant-deleting", "deleting");
    await assert.rejects(insertContribution(pool, schema, "participant-deleting", "deleting"), (error) => {
      assert.equal(error?.code, "P1001");
      assert.equal(error?.message, "participant unavailable");
      return true;
    });
    assert.equal(await contributionCount(pool, schema), 1);

    // The pin is the chain's own: the runner's path captured FROM CURRENT,
    // exactly what 0061's admission-window guard on the same table carries.
    const pins = await pool.query(`SELECT t.tgname, p.proname, p.proconfig
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = $1::regclass AND t.tgname IN ($2, 'telemetry_contributions_enforce_admission_window')
       ORDER BY t.tgname`, [quoted(schema, "telemetry_contributions"), GUARD_TRIGGER]);
    const runnerPath = [`search_path=${schema}, pg_catalog`];
    assert.deepEqual(pins.rows, [
      { tgname: GUARD_TRIGGER, proname: GUARD_FUNCTION, proconfig: runnerPath },
      { tgname: "telemetry_contributions_enforce_admission_window",
        proname: "telemetry_contributions_enforce_admission_window", proconfig: runnerPath },
    ], "0062 pins the guard to its own schema, then pg_catalog, as 0061 pins its sibling");
  } finally {
    if (prefixRoot !== null) await rm(prefixRoot, { recursive: true, force: true });
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
});

test("PG17 every function in the migrated primary schema pins its search_path", {
  skip: endpoint === null,
  timeout: 180_000,
}, async () => {
  const pool = poolFor(endpoint, "pg-function-search-path-catalog-test");
  const suffix = randomBytes(6).toString("hex");
  const schemas = { primary: `fn_search_path_p_${suffix}` };
  const created = [];
  try {
    for (const [role, schema] of Object.entries(schemas)) {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      created.push(schema);
      await assertNoRuntimeSearchPath(pool, schema);
      await applyPostgresMigrations({ role, schema, pool });
      const functions = await pool.query(`SELECT count(*)::integer AS n
          FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1`, [schema]);
      assert.ok(functions.rows[0].n > 0, `${role} creates functions`);
      assert.deepEqual(await unpinnedFunctions(pool, schema), [], `every ${role} function pins its search_path`);
      const fences = await pool.query(`SELECT p.proname, p.proconfig
          FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname IN ('community_daily_authority_fence', 'community_graph_preview_authority_fence')
         ORDER BY p.proname`, [schema]);
      assert.deepEqual(fences.rows.map((row) => row.proname),
        ["community_daily_authority_fence", "community_graph_preview_authority_fence"]);
      for (const row of fences.rows) {
        assert.equal(row.proconfig?.length, 1, row.proname);
        assert.match(row.proconfig[0], new RegExp(`^search_path="?${schema}"?, pg_catalog$`, "u"), row.proname);
      }
    }
    await assert.rejects(applyPostgresMigrations({ role: "ledger", schema: schemas.primary, pool }),
      { code: "POSTGRES_MIGRATION_ROLE_INVALID" });
  } finally {
    for (const schema of created.reverse()) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    }
    await pool.end();
  }
});
