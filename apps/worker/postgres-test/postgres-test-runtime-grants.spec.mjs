// PostgreSQL 17: the test runtime role's function grants
// (cloud-run/test-migrations.mjs grantAndVerifyTestRuntimePrivileges, which
// the A2, benchmark and fast-path migrate Jobs and the fast-path seed run).
//
// Primary 0046 revokes storage_journal_append and storage_owner_link_ensure
// from PUBLIC. Both are SECURITY INVOKER and run as the request's role inside
// the v1.2 owner bridge (0055), v1.1 live admission (0060) and legacy
// contribution admission (0061). The live edge write tier (2026-10-01) found
// that the routine granted the runtime role only
// insert_telemetry_v1_contribution, so POST
// /api/v1/me/telemetry-v12/domain-activate answered 503.
//
// As on Cloud SQL, a migrator that is not a superuser (a LOGIN member of a
// NOLOGIN cloudsqlsuperuser stand-in with CREATEDB and CREATEROLE) owns a
// fresh database, migrates a primary and a ledger schema there with the
// production runner and runs the routine. The spec shows the runtime role
// refused (42501) under the pre-fix grant, then executes both functions as
// the runtime role after the routine; it fails without the fix. The
// operator-only entrypoints stay refused, a stray direct grant on one is
// reset, and a privilege the reset cannot remove fails the read-back closed.
//
// The routine pins the runtime role's exact name, so the spec creates
// "tibotattle-test-runtime@tibotattle.iam" (NOLOGIN) when the local cluster
// lacks it and drops it afterwards; only superuser sessions SET ROLE to it.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { applyPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import {
  grantAndVerifyTestRuntimePrivileges,
  TEST_MIGRATIONS_RUNTIME_IAM_USER,
  TEST_OPERATOR_ONLY_PRIMARY_FUNCTIONS,
  TEST_RUNTIME_PRIMARY_FUNCTIONS,
} from "../cloud-run/test-migrations.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";

const endpoint = await postgresTestEndpoint();
const RUNTIME = `"${TEST_MIGRATIONS_RUNTIME_IAM_USER}"`;
const PARTICIPANT_CONSENT = "privacy-safe-telemetry-v0.1";

const digest = (label) => createHash("sha256").update(label).digest("hex");
const isCode = (code) => (error) => error?.code === code;
const insufficientPrivilege = isCode("42501");

/** One statement as the runtime role, in its own transaction; the session stays superuser. */
async function asRuntime(pool, sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${RUNTIME}`);
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runtimeCanExecute(pool, schema, { name, args }) {
  const result = await pool.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
    [TEST_MIGRATIONS_RUNTIME_IAM_USER, `"${schema}"."${name}"(${args})`]);
  return result.rows[0].allowed;
}

/** The grant the routine made before the fix: table DML and v1 admission only. */
async function preFixGrant(pool, schema) {
  await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${RUNTIME}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${RUNTIME}`);
  await pool.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "${schema}" TO ${RUNTIME}`);
  await pool.query(`GRANT EXECUTE ON FUNCTION "${schema}"."insert_telemetry_v1_contribution"(jsonb) TO ${RUNTIME}`);
}

const ownerLinkEnsure = (pool, schema, participantId) =>
  asRuntime(pool, `SELECT "${schema}".storage_owner_link_ensure($1, 'active') AS digest`, [participantId]);
const journalAppend = (pool, schema, ownerDigest, label) =>
  asRuntime(pool, `SELECT "${schema}".storage_journal_append('owner-active', $1, $2, $3, $4)::int AS sequence`,
    [ownerDigest, digest(`event-${label}`), digest(`object-${label}`), digest(`content-${label}`)]);

test("PG17 the runtime role executes the owner-journal functions only through the grant routine; operator entrypoints stay closed", {
  skip: endpoint === null,
  timeout: 300_000,
}, async () => {
  const pools = [];
  const connect = (user, database, applicationName) => {
    const pool = new pg.Pool({
      host: endpoint.host, port: endpoint.port, user, database,
      password: endpoint.password ?? "synthetic-local-only", ssl: false, max: 3,
      connectionTimeoutMillis: 5_000, application_name: applicationName,
    });
    pool.on("error", () => {});
    pools.push(pool);
    return pool;
  };
  const tag = randomBytes(5).toString("hex");
  const roles = { group: `runtime_grants_cloudsqlsuperuser_${tag}`, migrator: `runtime_grants_migrator_${tag}` };
  const database = `runtime_grants_${tag}`;
  const primary = `runtime_grants_primary_${tag}`;
  const ledger = `runtime_grants_ledger_${tag}`;
  const admin = connect(endpoint.user, endpoint.database, "pg-test-runtime-grants-admin");
  const created = { roles: [], database: false, runtime: false };
  const lock = await admin.connect();
  let locked = false;
  try {
    // The runtime role is cluster-wide; one run of this spec owns it at a time.
    await lock.query("SELECT pg_advisory_lock(hashtextextended('tibotattle-test-runtime-grants', 0))");
    locked = true;
    const facts = await admin.query("SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user");
    assert.equal(facts.rows[0]?.rolsuper, true, "the spec creates roles and a database; PG_TEST_USER must be superuser");
    created.runtime = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1",
      [TEST_MIGRATIONS_RUNTIME_IAM_USER])).rowCount === 0;
    if (created.runtime) await admin.query(`CREATE ROLE ${RUNTIME} NOLOGIN NOSUPERUSER NOCREATEROLE`);
    const runtimeRole = (await admin.query("SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = $1",
      [TEST_MIGRATIONS_RUNTIME_IAM_USER])).rows[0];
    assert.deepEqual(runtimeRole, { rolsuper: false, rolcreaterole: false }, "the runtime role is unprivileged");
    await admin.query(`CREATE ROLE "${roles.group}" NOLOGIN NOSUPERUSER CREATEDB CREATEROLE`);
    created.roles.push(roles.group);
    await admin.query(`CREATE ROLE "${roles.migrator}" LOGIN NOSUPERUSER CREATEDB CREATEROLE INHERIT
      IN ROLE "${roles.group}"`);
    created.roles.push(roles.migrator);
    await admin.query(`CREATE DATABASE "${database}" OWNER "${roles.group}"`);
    created.database = true;

    const migrator = connect(roles.migrator, database, "pg-test-runtime-grants-migrator");
    // Only a superuser session can SET ROLE to the runtime role.
    const superuser = connect(endpoint.user, database, "pg-test-runtime-grants-superuser");
    const session = await migrator.query(`SELECT session_user::text AS login, rolsuper FROM pg_catalog.pg_roles
      WHERE rolname = session_user`);
    assert.deepEqual(session.rows[0], { login: roles.migrator, rolsuper: false });
    for (const [migrationRole, schema] of [["primary", primary], ["ledger", ledger]]) {
      await migrator.query(`CREATE SCHEMA "${schema}"`);
      await applyPostgresMigrations({ role: migrationRole, schema, pool: migrator });
    }
    await migrator.query(`INSERT INTO "${primary}".participants (id, owner_kind, access_token_id, access_token_hash,
        recovery_token_id, recovery_token_hash, state, consent_version, consented_at, created_at)
      VALUES ('participant-runtime-grants', 'social', 'access-runtime-grants', $1, 'recovery-runtime-grants', $2,
        'active', $3, now(), now())`, [randomBytes(32), randomBytes(32), PARTICIPANT_CONSENT]);
    await migrator.query(`INSERT INTO "${primary}".storage_source_state (singleton, source_id, authority_epoch)
      VALUES (1, 'synthetic-runtime-grants-source', 0)`);

    // Before: the migrations revoke every runtime and operator function from
    // PUBLIC, and the pre-fix grant opened only v1 admission.
    await preFixGrant(migrator, primary);
    for (const fn of [...TEST_RUNTIME_PRIMARY_FUNCTIONS, ...TEST_OPERATOR_ONLY_PRIMARY_FUNCTIONS]) {
      assert.equal(await runtimeCanExecute(migrator, primary, fn), fn.name === "insert_telemetry_v1_contribution",
        `pre-fix ${fn.name}`);
    }
    await assert.rejects(ownerLinkEnsure(superuser, primary, "participant-runtime-grants"), insufficientPrivilege,
      "pre-fix: the runtime cannot mint an owner link");
    await assert.rejects(journalAppend(superuser, primary, digest("owner-pre-fix"), "pre-fix"), insufficientPrivilege,
      "pre-fix: the runtime cannot append to the owner journal");

    // After: the routine, run by the migrator, grants exactly the runtime
    // functions and reads them back.
    await grantAndVerifyTestRuntimePrivileges(migrator, "primary", primary);
    await grantAndVerifyTestRuntimePrivileges(migrator, "ledger", ledger);
    for (const fn of TEST_RUNTIME_PRIMARY_FUNCTIONS) {
      assert.equal(await runtimeCanExecute(migrator, primary, fn), true, fn.name);
    }
    const ownerDigest = (await ownerLinkEnsure(superuser, primary, "participant-runtime-grants")).rows[0].digest;
    assert.match(ownerDigest, /^[0-9a-f]{64}$/u, "the runtime mints the owner link");
    assert.equal((await ownerLinkEnsure(superuser, primary, "participant-runtime-grants")).rows[0].digest, ownerDigest,
      "and the mint is idempotent");
    assert.deepEqual((await journalAppend(superuser, primary, ownerDigest, "after")).rows, [{ sequence: 1 }],
      "the runtime appends one exact journal row");

    // The operator-only entrypoints stay closed to the runtime role.
    const operatorCalls = {
      storage_v11_bridge_backfill: `SELECT "${primary}".storage_v11_bridge_backfill(1)`,
      storage_v12_bridge_backfill: `SELECT "${primary}".storage_v12_bridge_backfill(1)`,
      typed_telemetry_restart_identities: `SELECT "${primary}".typed_telemetry_restart_identities()`,
    };
    assert.deepEqual(Object.keys(operatorCalls), TEST_OPERATOR_ONLY_PRIMARY_FUNCTIONS.map(({ name }) => name));
    for (const fn of TEST_OPERATOR_ONLY_PRIMARY_FUNCTIONS) {
      assert.equal(await runtimeCanExecute(migrator, primary, fn), false, fn.name);
      await assert.rejects(asRuntime(superuser, operatorCalls[fn.name]), insufficientPrivilege, fn.name);
    }

    // A stray direct grant on an operator entrypoint is reset by a re-run,
    // which is otherwise idempotent.
    const v12Backfill = TEST_OPERATOR_ONLY_PRIMARY_FUNCTIONS.find(({ name }) => name === "storage_v12_bridge_backfill");
    await migrator.query(`GRANT EXECUTE ON FUNCTION "${primary}".storage_v12_bridge_backfill(integer) TO ${RUNTIME}`);
    assert.equal(await runtimeCanExecute(migrator, primary, v12Backfill), true);
    await grantAndVerifyTestRuntimePrivileges(migrator, "primary", primary);
    assert.equal(await runtimeCanExecute(migrator, primary, v12Backfill), false, "the re-run removed the stray grant");
    for (const fn of TEST_RUNTIME_PRIMARY_FUNCTIONS) {
      assert.equal(await runtimeCanExecute(migrator, primary, fn), true, `re-run ${fn.name}`);
    }

    // A privilege the reset cannot remove fails the read-back closed: an
    // operator entrypoint reopened to PUBLIC, or a runtime function that is.
    for (const [statement, restore] of [
      [`GRANT EXECUTE ON FUNCTION "${primary}".typed_telemetry_restart_identities() TO PUBLIC`,
        `REVOKE ALL ON FUNCTION "${primary}".typed_telemetry_restart_identities() FROM PUBLIC`],
      [`GRANT EXECUTE ON FUNCTION "${primary}".storage_owner_link_ensure(text, text) TO PUBLIC`,
        `REVOKE ALL ON FUNCTION "${primary}".storage_owner_link_ensure(text, text) FROM PUBLIC`],
    ]) {
      await migrator.query(statement);
      await assert.rejects(grantAndVerifyTestRuntimePrivileges(migrator, "primary", primary),
        isCode("POSTGRES_TEST_MIGRATIONS_PRIMARY_RUNTIME_PRIVILEGES_INVALID"), statement);
      await migrator.query(restore);
    }
    await grantAndVerifyTestRuntimePrivileges(migrator, "primary", primary);
  } finally {
    for (const pool of pools.filter((pool) => pool !== admin)) await pool.end().catch(() => {});
    if (created.database) await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    for (const role of created.roles.reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
    if (created.runtime) await admin.query(`DROP ROLE IF EXISTS ${RUNTIME}`).catch(() => {});
    if (locked) {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended('tibotattle-test-runtime-grants', 0))")
        .catch(() => {});
    }
    lock.release();
    await admin.end().catch(() => {});
  }
});
