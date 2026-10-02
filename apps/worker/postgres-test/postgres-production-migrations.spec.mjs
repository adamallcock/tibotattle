// PostgreSQL 17: the OPS-10 production migration job
// (cloud-run/postgres-production-migrations.mjs), primary role only.
//
// As on Cloud SQL, a migrator that is not a superuser (a LOGIN member of a
// NOLOGIN cloudsqlsuperuser stand-in with CREATEDB and CREATEROLE) owns a
// fresh database. The job runs with its real manifest reader, canonical
// runner and shared runtime-grant policy; only the Cloud SQL connector and
// the attached identity are replaced by local stand-ins. The spec shows:
//
//   - on a fresh schema of a '-rehearsal-xxxxxxxx' scratch target the job
//     applies primary 0001-0065 forward, and the distinct runtime role ends
//     with exactly table DML plus EXECUTE on the three runtime functions: it
//     cannot CREATE in the schema, cannot write the migration history, and
//     every operator-only entrypoint is present and closed to it;
//   - a rerun is a no-op with an identical receipt;
//   - a history ahead of the image, and one that is not a prefix of it, are
//     each refused with no write (a perturbed grant stays perturbed);
//   - a non-scratch target is refused PRODUCTION_SIMP_RESIDUE_MISSING before
//     any connection when the image's manifest lacks the residue (the real
//     '_append_only_residue.sql' migration and the migrations after it
//     removed), and is accepted with the real manifest, which carries
//     LEAD-SIMP's 0064 residue;
//   - no ledger schema is created, read or configured.
//
// Every database, schema and role is created with the w2_opsdb_ prefix and a
// random tag, and dropped afterwards. All values are synthetic.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import { POSTGRES_MIGRATION_ROOT, readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import {
  CONTRACT_MIGRATIONS,
  PRODUCTION_MIGRATION_RECEIPT_SCHEMA,
  runProductionMigrations,
  SIMP_RESIDUE_MIGRATION_SUFFIX,
  verifyProductionMigrationReceipt,
} from "../cloud-run/postgres-production-migrations.mjs";
import {
  functionSignature,
  OPERATOR_ONLY_PRIMARY_FUNCTIONS,
  RUNTIME_PRIMARY_FUNCTIONS,
} from "../cloud-run/postgres-runtime-grants.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const endpoint = PG_TEST_SOCKET ? await postgresTestEndpoint() : null;

const TAG = randomBytes(5).toString("hex");
const PROJECT = "w2-opsdb-synthetic";
const REGION = "us-east1";
const IAM_DOMAIN = `${PROJECT}.iam`;
const ROLES = Object.freeze({
  group: `w2_opsdb_cloudsqlsuperuser_${TAG}`,
  migrator: `w2_opsdb_migrator_${TAG}@${IAM_DOMAIN}`,
  runtime: `w2_opsdb_runtime_${TAG}@${IAM_DOMAIN}`,
});
const DATABASE = `w2_opsdb_${TAG}`;
const SCRATCH_SCHEMA = `w2_opsdb_primary_${TAG}`;
const ENVIRONMENT_SCHEMA = `w2_opsdb_primary_env_${TAG}`;
const REFUSED_SCHEMA = `w2_opsdb_primary_refused_${TAG}`;
const ENVIRONMENT_INSTANCE = `${PROJECT}:${REGION}:w2-opsdb-primary`;
const SCRATCH_INSTANCE = `${PROJECT}:${REGION}:w2-opsdb-primary-rehearsal-${randomBytes(4).toString("hex")}`;
const SOURCE_COMMIT = "a".repeat(40);
const HISTORY = "_tibotattle_migration_history";
const PARTICIPANT_CONSENT = "privacy-safe-telemetry-v0.1";

const q = (name) => `"${name.replaceAll('"', '""')}"`;
const isCode = (code) => (error) => error?.code === code;
const insufficientPrivilege = isCode("42501");
const digest = (label) => createHash("sha256").update(label).digest("hex");

function jobEnv(overrides = {}) {
  return {
    CLOUD_RUN_JOB: "w2-opsdb-production-migrate",
    CLOUD_RUN_EXECUTION: "w2-opsdb-production-migrate-x7k2p",
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: PROJECT,
    MIGRATION_ENVIRONMENT: "production",
    PRODUCTION_MIGRATOR_SERVICE_ACCOUNT: `${ROLES.migrator}.gserviceaccount.com`,
    POSTGRES_MIGRATOR_IAM_USER: ROLES.migrator,
    POSTGRES_RUNTIME_IAM_USER: ROLES.runtime,
    ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME: ENVIRONMENT_INSTANCE,
    PRIMARY_INSTANCE_CONNECTION_NAME: SCRATCH_INSTANCE,
    PRIMARY_DATABASE: DATABASE,
    PRIMARY_SCHEMA: SCRATCH_SCHEMA,
    DEPLOYMENT_SOURCE_COMMIT: SOURCE_COMMIT,
    ...overrides,
  };
}

const state = { pools: [], admin: null, superuser: null, migrator: null, created: { roles: [], database: false } };

function connect(user, database, applicationName, max = 2) {
  const pool = new pg.Pool({
    host: endpoint.host, port: endpoint.port, user, database,
    password: endpoint.password ?? "synthetic-local-only", ssl: false, max,
    connectionTimeoutMillis: 5_000, application_name: applicationName,
  });
  pool.on("error", () => {});
  state.pools.push(pool);
  return pool;
}

/** The job's seams: the local migrator pool and identity, the real manifest and runner. */
function jobDependencies({ rootDirectory = POSTGRES_MIGRATION_ROOT } = {}) {
  const calls = { pools: 0, closes: 0, roles: [] };
  return {
    calls,
    dependencies: {
      rootDirectory,
      async readServiceAccountEmail() {
        return `${ROLES.migrator}.gserviceaccount.com`;
      },
      async readMigrations(options) {
        calls.roles.push(options.role);
        return readPostgresMigrations(options);
      },
      createConnector: () => ({ local: true }),
      async createPool(options) {
        calls.pools += 1;
        assert.equal(options.user, ROLES.migrator);
        assert.equal(options.database, DATABASE);
        assert.equal(options.max, 1);
        assert.equal(options.connector.local, true);
        const pool = new pg.Pool({
          host: endpoint.host, port: endpoint.port, user: ROLES.migrator, database: DATABASE,
          password: endpoint.password ?? "synthetic-local-only", ssl: false, max: options.max,
          connectionTimeoutMillis: 5_000, application_name: options.applicationName,
        });
        pool.on("error", () => {});
        return pool;
      },
      async closeResources({ pools }) {
        calls.closes += 1;
        for (const pool of pools) await pool.end();
      },
    },
  };
}

/** One statement as the runtime role in its own transaction; the session stays superuser. */
async function asRuntime(sql, params = []) {
  const client = await state.superuser.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${q(ROLES.runtime)}`);
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

/**
 * A content-free fingerprint of everything the job could write: the history
 * rows (with applied_at), every ACL in the schema, its default ACLs, and the
 * set of schemas in the database.
 */
async function fingerprint(schema) {
  const result = await state.superuser.query(`SELECT json_build_object(
      'schemas', (SELECT json_agg(nspname ORDER BY nspname) FROM pg_namespace WHERE nspname LIKE 'w2_opsdb_%'),
      'schemaAcl', (SELECT nspacl::text FROM pg_namespace WHERE nspname = $1),
      'relationAcls', (SELECT json_agg(json_build_array(c.relname, c.relacl::text) ORDER BY c.relname)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1),
      'routineAcls', (SELECT json_agg(json_build_array(p.oid::regprocedure::text, p.proacl::text) ORDER BY p.oid)
        FROM pg_proc p WHERE p.pronamespace = to_regnamespace($1)),
      'defaultAcls', (SELECT json_agg(json_build_array(d.defaclobjtype, d.defaclacl::text) ORDER BY d.defaclobjtype)
        FROM pg_default_acl d WHERE d.defaclnamespace = to_regnamespace($1))
    ) AS value`, [schema]);
  const history = await state.superuser.query(
    `SELECT version, name, checksum_sha256, applied_at FROM ${q(schema)}.${q(HISTORY)} ORDER BY version`,
  ).catch(() => ({ rows: null }));
  return JSON.stringify({ catalog: result.rows[0].value, history: history.rows });
}

before(async () => {
  if (endpoint === null) return;
  state.admin = connect(endpoint.user, endpoint.database, "w2-opsdb-admin");
  const facts = await state.admin.query("SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user");
  assert.equal(facts.rows[0]?.rolsuper, true, "the spec creates roles and a database; PG_TEST_USER must be superuser");
  await state.admin.query(`CREATE ROLE ${q(ROLES.group)} NOLOGIN NOSUPERUSER CREATEDB CREATEROLE`);
  state.created.roles.push(ROLES.group);
  await state.admin.query(`CREATE ROLE ${q(ROLES.migrator)} LOGIN NOSUPERUSER CREATEDB CREATEROLE INHERIT
    IN ROLE ${q(ROLES.group)}`);
  state.created.roles.push(ROLES.migrator);
  await state.admin.query(`CREATE ROLE ${q(ROLES.runtime)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  state.created.roles.push(ROLES.runtime);
  await state.admin.query(`CREATE DATABASE ${q(DATABASE)} OWNER ${q(ROLES.group)}`);
  state.created.database = true;
  state.superuser = connect(endpoint.user, DATABASE, "w2-opsdb-superuser");
  state.migrator = connect(ROLES.migrator, DATABASE, "w2-opsdb-migrator");
  const session = await state.migrator.query(`SELECT session_user::text AS login, rolsuper
    FROM pg_catalog.pg_roles WHERE rolname = session_user`);
  assert.deepEqual(session.rows[0], { login: ROLES.migrator, rolsuper: false });
});

after(async () => {
  if (endpoint === null) return;
  for (const pool of state.pools.filter((pool) => pool !== state.admin)) await pool.end().catch(() => {});
  if (state.created.database) {
    await state.admin.query(`DROP DATABASE IF EXISTS ${q(DATABASE)} WITH (FORCE)`).catch(() => {});
  }
  for (const role of [...state.created.roles].reverse()) {
    await state.admin.query(`DROP ROLE IF EXISTS ${q(role)}`).catch(() => {});
  }
  await state.admin.end().catch(() => {});
});

const primary = await readPostgresMigrations({ role: "primary" });
const REAL_RESIDUE = "0064_append_only_residue.sql";
/** The next free primary number after the promoted tail, as a 4-digit prefix. */
const nextNumber = () => String(primary.length + 1).padStart(4, "0");
let firstReceipt;

test("PG17 a fresh scratch schema is migrated 0001-0065 forward and the runtime role ends with exactly DML plus the three runtime functions", {
  skip: !PG_TEST_SOCKET,
  timeout: 300_000,
}, async () => {
  assert.equal(primary.length, 65, "the promoted primary tail");
  assert.equal(primary.at(-1).name, "0065_interim_public_read.sql");
  assert.equal(primary.find(({ name }) => name === REAL_RESIDUE)?.version, 64);
  const { calls, dependencies } = jobDependencies();
  const receipt = await runProductionMigrations({ env: jobEnv(), dependencies });
  firstReceipt = receipt;
  assert.deepEqual(calls.roles, ["primary"], "only the primary manifest is read; the ledger directory is ignored");
  assert.equal(calls.pools, 1);
  assert.equal(calls.closes, 1);
  assert.equal(verifyProductionMigrationReceipt(receipt).digest, receipt.digest);
  assert.equal(receipt.schema, PRODUCTION_MIGRATION_RECEIPT_SCHEMA);
  assert.deepEqual(receipt.target, {
    kind: "scratch", instanceConnectionName: SCRATCH_INSTANCE, database: DATABASE, schema: SCRATCH_SCHEMA,
  });
  assert.equal(receipt.migrations.count, 65);
  assert.equal(receipt.migrations.latest.name, primary.at(-1).name);
  assert.equal(receipt.migrations.simpResidue, REAL_RESIDUE, "the real manifest carries the SIMP residue");
  assert.equal(receipt.migrations.contractReviewed, Object.keys(CONTRACT_MIGRATIONS).length);
  assert.deepEqual(receipt.roles, { migrator: ROLES.migrator, runtime: ROLES.runtime });
  assert.equal(receipt.ledger, "not-migrated");
  assert.doesNotMatch(JSON.stringify(receipt), /applied_at|password|token|participant-/u, "content-free");

  const history = await state.superuser.query(
    `SELECT version, name, checksum_sha256 FROM ${q(SCRATCH_SCHEMA)}.${q(HISTORY)} ORDER BY version`,
  );
  assert.deepEqual(history.rows, primary.map(({ version, name, sha256 }) => ({ version, name, checksum_sha256: sha256 })));
  const owner = await state.superuser.query(
    "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1", [SCRATCH_SCHEMA],
  );
  assert.equal(owner.rows[0].owner, ROLES.migrator, "the migrator owns the schema");

  // Catalog: every relation grants the runtime DML and nothing more; the
  // history grants it SELECT only; it cannot create in the schema.
  const relations = await state.superuser.query(`SELECT c.relname,
        has_table_privilege($1, c.oid, 'SELECT') AS s, has_table_privilege($1, c.oid, 'INSERT') AS i,
        has_table_privilege($1, c.oid, 'UPDATE') AS u, has_table_privilege($1, c.oid, 'DELETE') AS d,
        has_table_privilege($1, c.oid, 'TRUNCATE') OR has_table_privilege($1, c.oid, 'REFERENCES')
          OR has_table_privilege($1, c.oid, 'TRIGGER') OR has_table_privilege($1, c.oid, 'MAINTAIN') AS extra
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`, [ROLES.runtime, SCRATCH_SCHEMA]);
  assert.ok(relations.rows.length > 50, "the migrated schema has its relations");
  for (const row of relations.rows) {
    const expected = row.relname === HISTORY
      ? { s: true, i: false, u: false, d: false, extra: false }
      : { s: true, i: true, u: true, d: true, extra: false };
    assert.deepEqual({ s: row.s, i: row.i, u: row.u, d: row.d, extra: row.extra }, expected, row.relname);
  }
  const schemaPrivileges = await state.superuser.query(`SELECT has_schema_privilege($1, $2, 'USAGE') AS usage,
      has_schema_privilege($1, $2, 'CREATE') AS create,
      has_database_privilege($1, current_database(), 'CREATE') AS database_create`, [ROLES.runtime, SCRATCH_SCHEMA]);
  assert.deepEqual(schemaPrivileges.rows[0], { usage: true, create: false, database_create: false });

  // Functions: among the non-PUBLIC routines the runtime executes exactly the
  // three runtime functions; every operator-only entrypoint exists and is closed.
  const restricted = await state.superuser.query(`SELECT fn.proname || '(' || oidvectortypes(fn.proargtypes) || ')' AS signature,
        has_function_privilege($1, fn.oid, 'EXECUTE') AS runtime_execute
      FROM pg_proc fn WHERE fn.pronamespace = to_regnamespace($2)
       AND NOT has_function_privilege('public', fn.oid, 'EXECUTE')`, [ROLES.runtime, SCRATCH_SCHEMA]);
  assert.deepEqual(restricted.rows.filter((row) => row.runtime_execute).map((row) => row.signature).sort(),
    RUNTIME_PRIMARY_FUNCTIONS.map(functionSignature).sort());
  for (const fn of OPERATOR_ONLY_PRIMARY_FUNCTIONS) {
    assert.deepEqual(restricted.rows.find((row) => row.signature === functionSignature(fn)),
      { signature: functionSignature(fn), runtime_execute: false }, fn.name);
  }

  // Empirically, as the runtime role.
  await assert.rejects(asRuntime(`CREATE TABLE ${q(SCRATCH_SCHEMA)}.w2_opsdb_probe (id integer)`),
    insufficientPrivilege, "the runtime cannot CREATE in the schema");
  await assert.rejects(asRuntime(`INSERT INTO ${q(SCRATCH_SCHEMA)}.${q(HISTORY)} (version, name, checksum_sha256)
      VALUES (999, '0999_w2_opsdb_probe.sql', $1)`, [digest("probe")]), insufficientPrivilege,
  "the runtime cannot insert migration history");
  await assert.rejects(asRuntime(`UPDATE ${q(SCRATCH_SCHEMA)}.${q(HISTORY)} SET name = name`), insufficientPrivilege);
  await assert.rejects(asRuntime(`DELETE FROM ${q(SCRATCH_SCHEMA)}.${q(HISTORY)}`), insufficientPrivilege);
  await assert.rejects(asRuntime(`TRUNCATE ${q(SCRATCH_SCHEMA)}.participants`), insufficientPrivilege);
  assert.equal((await asRuntime(`SELECT count(*)::integer AS n FROM ${q(SCRATCH_SCHEMA)}.${q(HISTORY)}`)).rows[0].n,
    primary.length);
  await asRuntime(`UPDATE ${q(SCRATCH_SCHEMA)}.participants SET id = id WHERE false`);
  await asRuntime(`DELETE FROM ${q(SCRATCH_SCHEMA)}.participants WHERE false`);
  for (const sql of [
    `SELECT ${q(SCRATCH_SCHEMA)}.storage_v11_bridge_backfill(1)`,
    `SELECT ${q(SCRATCH_SCHEMA)}.storage_v12_bridge_backfill(1)`,
    `SELECT ${q(SCRATCH_SCHEMA)}.typed_telemetry_restart_identities()`,
  ]) await assert.rejects(asRuntime(sql), insufficientPrivilege, sql);
  // The owner-journal functions run as the runtime on a synthetic participant.
  await state.migrator.query(`INSERT INTO ${q(SCRATCH_SCHEMA)}.participants (id, owner_kind, access_token_id,
      access_token_hash, recovery_token_id, recovery_token_hash, state, consent_version, consented_at, created_at)
    VALUES ('w2-opsdb-participant', 'social', 'w2-opsdb-access', $1, 'w2-opsdb-recovery', $2, 'active', $3, now(), now())`,
  [randomBytes(32), randomBytes(32), PARTICIPANT_CONSENT]);
  await state.migrator.query(`INSERT INTO ${q(SCRATCH_SCHEMA)}.storage_source_state (singleton, source_id, authority_epoch)
    VALUES (1, 'w2-opsdb-synthetic-source', 0)`);
  const ownerDigest = (await asRuntime(`SELECT ${q(SCRATCH_SCHEMA)}.storage_owner_link_ensure($1, 'active') AS digest`,
    ["w2-opsdb-participant"])).rows[0].digest;
  assert.match(ownerDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual((await asRuntime(`SELECT ${q(SCRATCH_SCHEMA)}.storage_journal_append('owner-active', $1, $2, $3, $4)::int AS sequence`,
    [ownerDigest, digest("event"), digest("object"), digest("content")])).rows, [{ sequence: 1 }]);

  const schemas = await state.superuser.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE '%ledger%'");
  assert.deepEqual(schemas.rows, [], "no ledger schema exists in the database");
});

test("PG17 a rerun is a no-op with an identical receipt", { skip: !PG_TEST_SOCKET, timeout: 300_000 }, async () => {
  assert.ok(firstReceipt, "the first run completed");
  const before = await fingerprint(SCRATCH_SCHEMA);
  const { dependencies } = jobDependencies();
  const receipt = await runProductionMigrations({ env: jobEnv(), dependencies });
  assert.deepEqual(receipt, firstReceipt);
  assert.equal(await fingerprint(SCRATCH_SCHEMA), before, "history (with applied_at) and every grant are unchanged");
});

test("PG17 an ahead history and a diverged history are each refused with no write", {
  skip: !PG_TEST_SOCKET,
  timeout: 300_000,
}, async () => {
  // Perturb a grant the job would restore, so any write would show.
  await state.migrator.query(`REVOKE EXECUTE ON FUNCTION ${q(SCRATCH_SCHEMA)}.storage_journal_append(text, text, text, text, text)
    FROM ${q(ROLES.runtime)}`);
  const cases = [
    ["MIGRATION_STATE_NEWER_THAN_IMAGE",
      `INSERT INTO ${q(SCRATCH_SCHEMA)}.${q(HISTORY)} (version, name, checksum_sha256)
         VALUES (${primary.length + 1}, '${nextNumber()}_w2_opsdb_newer.sql', '${digest("newer")}')`,
      `DELETE FROM ${q(SCRATCH_SCHEMA)}.${q(HISTORY)} WHERE version = ${primary.length + 1}`],
    ["MIGRATION_HISTORY_DIVERGED",
      `UPDATE ${q(SCRATCH_SCHEMA)}.${q(HISTORY)} SET checksum_sha256 = '${"f".repeat(64)}' WHERE version = ${primary.length}`,
      `UPDATE ${q(SCRATCH_SCHEMA)}.${q(HISTORY)} SET checksum_sha256 = '${primary.at(-1).sha256}' WHERE version = ${primary.length}`],
    ["MIGRATION_HISTORY_DIVERGED",
      `UPDATE ${q(SCRATCH_SCHEMA)}.${q(HISTORY)} SET name = '0010_w2_opsdb_other.sql' WHERE version = 10`,
      `UPDATE ${q(SCRATCH_SCHEMA)}.${q(HISTORY)} SET name = '${primary[9].name}' WHERE version = 10`],
  ];
  for (const [code, perturb, restore] of cases) {
    await state.migrator.query(perturb);
    const before = await fingerprint(SCRATCH_SCHEMA);
    const { calls, dependencies } = jobDependencies();
    await assert.rejects(runProductionMigrations({ env: jobEnv(), dependencies }), isCode(code), perturb);
    assert.equal(calls.closes, 1, "resources are closed after a refusal");
    assert.equal(await fingerprint(SCRATCH_SCHEMA), before, `${code}: nothing was written`);
    await state.migrator.query(restore);
  }
  const closed = await state.superuser.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
    [ROLES.runtime, `${q(SCRATCH_SCHEMA)}.storage_journal_append(text, text, text, text, text)`]);
  assert.equal(closed.rows[0].allowed, false, "the perturbed grant was not restored by a refused run");
  // A converged run restores the policy.
  const { dependencies } = jobDependencies();
  assert.deepEqual(await runProductionMigrations({ env: jobEnv(), dependencies }), firstReceipt);
});

test("PG17 a non-scratch target is refused PRODUCTION_SIMP_RESIDUE_MISSING before any connection; no ledger is ever configured", {
  skip: !PG_TEST_SOCKET,
  timeout: 300_000,
}, async () => {
  const environmentTarget = jobEnv({
    PRIMARY_INSTANCE_CONNECTION_NAME: ENVIRONMENT_INSTANCE,
    PRIMARY_SCHEMA: REFUSED_SCHEMA,
  });
  // The image's manifest as it was before the real residue: the residue and
  // every later migration (0065) removed, so the copy has no numbering gap.
  const root = await mkdtemp(join(tmpdir(), "w2-opsdb-migrations-"));
  try {
    await cp(join(POSTGRES_MIGRATION_ROOT, "primary"), join(root, "primary"), { recursive: true });
    for (const { name, version } of primary) {
      if (version >= primary.find((migration) => migration.name === REAL_RESIDUE).version) {
        await rm(join(root, "primary", name));
      }
    }
    const refused = jobDependencies({ rootDirectory: root });
    await assert.rejects(runProductionMigrations({ env: environmentTarget, dependencies: refused.dependencies }),
      isCode("PRODUCTION_SIMP_RESIDUE_MISSING"));
    assert.equal(refused.calls.pools, 0, "refused before any connection");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  for (const [name, value] of [["LEDGER_SCHEMA", "w2_opsdb_ledger"], ["LEDGER_INSTANCE_CONNECTION_NAME", ENVIRONMENT_INSTANCE]]) {
    const ledger = jobDependencies();
    await assert.rejects(runProductionMigrations({ env: jobEnv({ [name]: value }), dependencies: ledger.dependencies }),
      isCode("POSTGRES_PRODUCTION_MIGRATIONS_LEDGER_FORBIDDEN"), name);
    assert.deepEqual(ledger.calls, { pools: 0, closes: 0, roles: [] });
  }
  const present = await state.superuser.query("SELECT nspname FROM pg_namespace WHERE nspname = $1", [REFUSED_SCHEMA]);
  assert.deepEqual(present.rows, [], "the refused target's schema was never created");
});

test("PG17 with the SIMP residue in the image manifest the environment target is accepted", {
  skip: !PG_TEST_SOCKET,
  timeout: 300_000,
}, async () => {
  // The real manifest: LEAD-SIMP's residue, followed by the additive 0065.
  assert.ok(REAL_RESIDUE.endsWith(SIMP_RESIDUE_MIGRATION_SUFFIX));
  const { calls, dependencies } = jobDependencies();
  const receipt = await runProductionMigrations({
    env: jobEnv({ PRIMARY_INSTANCE_CONNECTION_NAME: ENVIRONMENT_INSTANCE, PRIMARY_SCHEMA: ENVIRONMENT_SCHEMA }),
    dependencies,
  });
  assert.deepEqual(calls.roles, ["primary"]);
  assert.equal(verifyProductionMigrationReceipt(receipt).target.kind, "environment");
  assert.equal(receipt.migrations.count, 65);
  assert.equal(receipt.migrations.simpResidue, REAL_RESIDUE);
  const history = await state.superuser.query(
    `SELECT count(*)::integer AS n FROM ${q(ENVIRONMENT_SCHEMA)}.${q(HISTORY)}`,
  );
  assert.equal(history.rows[0].n, 65);
  const schemas = await state.superuser.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'w2_opsdb_%' ORDER BY nspname");
  assert.deepEqual(schemas.rows.map(({ nspname }) => nspname), [SCRATCH_SCHEMA, ENVIRONMENT_SCHEMA].sort(),
    "only the two migrated primary schemas exist: no ledger schema was created");
});
