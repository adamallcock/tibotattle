#!/usr/bin/env node

// The one runtime-grant policy (postgres-runtime-grants.mjs): its exact SQL,
// its read-back refusals, its parameterisation by runtime role and schema,
// and the ratchet that keeps it the only grant policy in Worker tooling.
// Fake clients only; the PostgreSQL 17 proofs are
// postgres-test/postgres-test-runtime-grants.spec.mjs and
// postgres-test/postgres-production-migrations.spec.mjs.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ensureSchema,
  functionSignature,
  grantAndVerifyRuntimePrivileges,
  isRuntimeGrantError,
  MIGRATION_HISTORY_TABLE,
  OPERATOR_ONLY_PRIMARY_FUNCTIONS,
  readBackReceipts,
  restrictedFunctionsMatchPolicy,
  RUNTIME_GRANT_ROLES,
  RUNTIME_PRIMARY_FUNCTIONS,
  runtimeGrantPolicyDigest,
} from "./postgres-runtime-grants.mjs";
import * as testMigrations from "./test-migrations.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(ROOT, "..");
const SCHEMA = "w2_opsdb_synthetic_primary";
const RUNTIME = "w2-opsdb-runtime@w2-opsdb-synthetic.iam";
const PREFIX = "POSTGRES_SYNTHETIC_";
const EMPTY = Object.freeze({ rows: [], rowCount: 0 });
const POLICY_DIGEST = "327c3bdd0c2ab66b91c4323d44af0746149f0c3cf680c1ec21a953a7f6b084e5";
const RUNTIME_SIGNATURES = RUNTIME_PRIMARY_FUNCTIONS.map(functionSignature);
const OPERATOR_SIGNATURES = OPERATOR_ONLY_PRIMARY_FUNCTIONS.map(functionSignature);

const OK_READ_BACK = Object.freeze({
  schema_usage: true,
  schema_create: false,
  application_tables_dml: true,
  sequences_access: true,
  history_select: true,
  history_insert: false,
  history_update: false,
  history_delete: false,
  default_tables_dml: true,
  default_sequences_access: true,
  no_global_table_defaults: true,
  no_global_sequence_defaults: true,
});

/**
 * A client whose function grants follow the statements it receives: the
 * read-back reports the restricted routines of a migrated primary schema
 * (runtime and operator-only), executable only when granted, plus `extra`.
 */
function fakePool({
  role = "primary",
  readBack = {},
  extra = [],
  failOn = () => false,
  rollbackFails = false,
  releaseFails = false,
  owner = null,
  history = [],
} = {}) {
  const statements = [];
  const releases = [];
  const granted = new Set();
  let schemaOwner = owner;
  const client = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (failOn(sql)) throw Object.assign(new Error("synthetic driver failure"), { code: "XX000" });
      if (sql === "ROLLBACK" && rollbackFails) throw new Error("synthetic rollback failure");
      if (/^(?:BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(sql)) return EMPTY;
      if (sql.startsWith("REVOKE ALL ON ALL ROUTINES IN SCHEMA ")) {
        granted.clear();
        return EMPTY;
      }
      const grant = /^GRANT EXECUTE ON FUNCTION "[a-z0-9_]+"\."([a-z0-9_]+)"\(([a-z, ]*)\) TO "/u.exec(sql);
      if (grant !== null) {
        granted.add(`${grant[1]}(${grant[2]})`);
        return EMPTY;
      }
      if (/^(?:GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)/u.test(sql)) return EMPTY;
      if (sql.includes("has_schema_privilege($1, $2, 'USAGE')")) {
        const restricted = role === "primary"
          ? [...RUNTIME_SIGNATURES, ...OPERATOR_SIGNATURES]
            .map((signature) => ({ signature, runtime_execute: granted.has(signature) }))
          : [];
        return { rows: [{ ...OK_READ_BACK, ...readBack, restricted_functions: [...restricted, ...extra] }], rowCount: 1 };
      }
      if (sql.includes("FROM pg_namespace WHERE nspname=$1")) {
        return schemaOwner === null ? EMPTY : { rows: [{ owner: schemaOwner }], rowCount: 1 };
      }
      if (sql.startsWith("CREATE SCHEMA ")) {
        schemaOwner = "w2-opsdb-migrator@w2-opsdb-synthetic.iam";
        return EMPTY;
      }
      if (sql.includes(`"${MIGRATION_HISTORY_TABLE}"`)) return { rows: history, rowCount: history.length };
      throw new Error(`unexpected fake SQL ${sql.slice(0, 40)}`);
    },
    async release(discard = false) {
      releases.push(discard);
      if (releaseFails) throw new Error("synthetic release failure");
    },
  };
  return { pool: { async connect() { return client; } }, statements, releases, granted };
}

const options = (overrides = {}) => ({ role: "primary", schema: SCHEMA, runtimeRole: RUNTIME, codePrefix: PREFIX, ...overrides });
const rejectsCode = (promise, code, message) => assert.rejects(promise, (error) => error?.code === code, message ?? code);

test("the policy is exactly three runtime functions and three closed operator entrypoints, pinned by digest", () => {
  assert.deepEqual(RUNTIME_SIGNATURES, ["insert_telemetry_v1_contribution(jsonb)",
    "storage_journal_append(text, text, text, text, text)", "storage_owner_link_ensure(text, text)"]);
  assert.deepEqual(OPERATOR_SIGNATURES, ["storage_v11_bridge_backfill(integer)",
    "storage_v12_bridge_backfill(integer)", "typed_telemetry_restart_identities()"]);
  for (const list of [RUNTIME_PRIMARY_FUNCTIONS, OPERATOR_ONLY_PRIMARY_FUNCTIONS, RUNTIME_GRANT_ROLES]) {
    assert.equal(Object.isFrozen(list), true);
  }
  assert.equal(runtimeGrantPolicyDigest(), POLICY_DIGEST,
    "a policy change is deliberate: update this pin and every receipt that names the digest");
});

test("test-migrations.mjs re-exports the same policy objects under its test-era names", () => {
  assert.equal(testMigrations.TEST_RUNTIME_PRIMARY_FUNCTIONS, RUNTIME_PRIMARY_FUNCTIONS);
  assert.equal(testMigrations.TEST_OPERATOR_ONLY_PRIMARY_FUNCTIONS, OPERATOR_ONLY_PRIMARY_FUNCTIONS);
  assert.equal(testMigrations.functionSignature, functionSignature);
  assert.equal(testMigrations.restrictedFunctionsMatchPolicy, restrictedFunctionsMatchPolicy);
  for (const name of ["ensureSchema", "grantAndVerifyRuntimePrivileges", "readBackReceipts",
    "grantAndVerifyTestRuntimePrivileges"]) {
    assert.equal(typeof testMigrations[name], "function", name);
  }
});

test("grant-and-verify resets, then grants exactly the policy to the given runtime role on the given schema", async () => {
  const { pool, statements, releases } = fakePool();
  await grantAndVerifyRuntimePrivileges(pool, options());
  const sql = statements.map(({ sql: text }) => text);
  const quoted = `"${SCHEMA}"`;
  const role = `"${RUNTIME}"`;
  assert.deepEqual(sql.slice(0, 3), ["BEGIN", "SET LOCAL statement_timeout='30000ms'", "SET LOCAL lock_timeout='5000ms'"]);
  assert.deepEqual(sql.filter((text) => /^(?:GRANT|REVOKE|ALTER DEFAULT)/u.test(text)), [
    `REVOKE ALL ON SCHEMA ${quoted} FROM ${role}`,
    `GRANT USAGE ON SCHEMA ${quoted} TO ${role}`,
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${quoted} FROM ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoted} TO ${role}`,
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${quoted} FROM ${role}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${quoted} TO ${role}`,
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\n         ON ${quoted}."${MIGRATION_HISTORY_TABLE}" FROM ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoted}\n         REVOKE ALL ON TABLES FROM ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoted}\n         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoted}\n         REVOKE ALL ON SEQUENCES FROM ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoted}\n         GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`,
    `REVOKE ALL ON ALL ROUTINES IN SCHEMA ${quoted} FROM ${role}`,
    ...RUNTIME_PRIMARY_FUNCTIONS.map(({ name, args }) => `GRANT EXECUTE ON FUNCTION ${quoted}."${name}"(${args}) TO ${role}`),
  ]);
  const readBack = statements.find(({ sql: text }) => text.includes("has_schema_privilege($1, $2, 'USAGE')"));
  assert.deepEqual(readBack.params, [RUNTIME, SCHEMA, `${SCHEMA}.${MIGRATION_HISTORY_TABLE}`, MIGRATION_HISTORY_TABLE],
    "the read-back is scoped to the exact runtime role and schema");
  assert.equal(sql.at(-1), "COMMIT");
  assert.deepEqual(releases, [false]);

  const ledger = fakePool({ role: "ledger" });
  await grantAndVerifyRuntimePrivileges(ledger.pool, options({ role: "ledger" }));
  assert.equal(ledger.statements.some(({ sql: text }) => text.startsWith("GRANT EXECUTE")), false,
    "a ledger schema grants no function");
});

test("the read-back refuses every posture the policy does not allow, and rolls back", async () => {
  const flips = Object.entries(OK_READ_BACK).map(([key, value]) => ({ [key]: !value }));
  for (const readBack of [...flips, { schema_usage: null }]) {
    const { pool, statements, releases } = fakePool({ readBack });
    await rejectsCode(grantAndVerifyRuntimePrivileges(pool, options()), `${PREFIX}PRIMARY_RUNTIME_PRIVILEGES_INVALID`,
      JSON.stringify(readBack));
    assert.equal(statements.at(-1).sql, "ROLLBACK");
    assert.deepEqual(releases, [true]);
  }
  for (const [label, extra] of [
    ["any other non-PUBLIC function executable", [{ signature: "w2_opsdb_extra_backfill(integer)", runtime_execute: true }]],
    ["an operator entrypoint executable through membership", [{ signature: OPERATOR_SIGNATURES[1], runtime_execute: true }]],
    ["a duplicate row", [{ signature: RUNTIME_SIGNATURES[0], runtime_execute: true }]],
    ["a malformed row", [{ signature: "x()", runtime_execute: "true" }]],
  ]) {
    const { pool } = fakePool({ extra });
    await rejectsCode(grantAndVerifyRuntimePrivileges(pool, options()), `${PREFIX}PRIMARY_RUNTIME_PRIVILEGES_INVALID`, label);
  }
  const ledger = fakePool({ role: "ledger", extra: [{ signature: RUNTIME_SIGNATURES[0], runtime_execute: true }] });
  await rejectsCode(grantAndVerifyRuntimePrivileges(ledger.pool, options({ role: "ledger" })),
    `${PREFIX}LEDGER_RUNTIME_PRIVILEGES_INVALID`);
});

test("restrictedFunctionsMatchPolicy accepts exactly the policy and refuses every deviation", () => {
  const row = (signature, runtimeExecute) => ({ signature, runtime_execute: runtimeExecute });
  const exact = [...RUNTIME_SIGNATURES.map((signature) => row(signature, true)),
    ...OPERATOR_SIGNATURES.map((signature) => row(signature, false))];
  assert.equal(restrictedFunctionsMatchPolicy("primary", exact), true);
  assert.equal(restrictedFunctionsMatchPolicy("primary", [...exact].reverse()), true);
  assert.equal(restrictedFunctionsMatchPolicy("ledger", []), true);
  for (const rows of [
    exact.filter(({ signature }) => signature !== RUNTIME_SIGNATURES[1]),
    exact.filter(({ signature }) => signature !== OPERATOR_SIGNATURES[2]),
    exact.map((entry) => entry.signature === RUNTIME_SIGNATURES[2] ? row(entry.signature, false) : entry),
    exact.map((entry) => entry.signature === OPERATOR_SIGNATURES[0] ? row(entry.signature, true) : entry),
    [...exact, row("w2_opsdb_extra()", true)],
    null,
  ]) assert.equal(restrictedFunctionsMatchPolicy("primary", rows), false);
  assert.equal(restrictedFunctionsMatchPolicy("ledger", [row(RUNTIME_SIGNATURES[0], true)]), false);
});

test("arguments are closed: role, schema, runtime role and code prefix", async () => {
  const { pool, statements } = fakePool();
  await rejectsCode(grantAndVerifyRuntimePrivileges(pool, options({ role: "admin" })), `${PREFIX}ROLE_INVALID`);
  await rejectsCode(grantAndVerifyRuntimePrivileges(pool, options({ schema: "Bad-Schema" })), `${PREFIX}SCHEMA_INVALID`);
  await rejectsCode(grantAndVerifyRuntimePrivileges(pool, options({ schema: "pg_catalog" })), `${PREFIX}SCHEMA_INVALID`);
  await rejectsCode(grantAndVerifyRuntimePrivileges(pool, options({ runtimeRole: "" })), `${PREFIX}RUNTIME_ROLE_INVALID`);
  await rejectsCode(grantAndVerifyRuntimePrivileges(pool, options({ runtimeRole: `x${"y".repeat(63)}` })),
    `${PREFIX}RUNTIME_ROLE_INVALID`);
  await rejectsCode(grantAndVerifyRuntimePrivileges(pool, options({ runtimeRole: 'bad"role' })), `${PREFIX}RUNTIME_ROLE_INVALID`);
  await rejectsCode(grantAndVerifyRuntimePrivileges(pool, options({ codePrefix: "lower_" })),
    "POSTGRES_RUNTIME_GRANTS_CODE_PREFIX_INVALID");
  await rejectsCode(grantAndVerifyRuntimePrivileges(pool, options({ codePrefix: undefined })),
    "POSTGRES_RUNTIME_GRANTS_CODE_PREFIX_INVALID");
  assert.deepEqual(statements, [], "argument refusals precede any connection");
  const unprefixed = fakePool({ readBack: { schema_create: true } });
  await rejectsCode(grantAndVerifyRuntimePrivileges(unprefixed.pool, options({ codePrefix: "" })),
    "PRIMARY_RUNTIME_PRIVILEGES_INVALID", "an empty prefix keeps the caller's bare code family");
});

test("driver, rollback and release failures map to closed codes and never leak driver text", async () => {
  const grantFailure = fakePool({ failOn: (sql) => sql.startsWith("GRANT EXECUTE") });
  await assert.rejects(grantAndVerifyRuntimePrivileges(grantFailure.pool, options()), (error) =>
    error.code === `${PREFIX}PRIMARY_RUNTIME_GRANT_FAILED` && !error.message.includes("synthetic driver")
      && isRuntimeGrantError(error));
  assert.equal(grantFailure.statements.at(-1).sql, "ROLLBACK");
  assert.deepEqual(grantFailure.releases, [true], "a failed transaction's connection is discarded");
  const rollback = fakePool({ failOn: (sql) => sql.startsWith("GRANT EXECUTE"), rollbackFails: true });
  await rejectsCode(grantAndVerifyRuntimePrivileges(rollback.pool, options()), `${PREFIX}PRIMARY_RUNTIME_PRIVILEGES_ROLLBACK_FAILED`);
  const release = fakePool({ releaseFails: true });
  await rejectsCode(grantAndVerifyRuntimePrivileges(release.pool, options()), `${PREFIX}PRIMARY_RUNTIME_PRIVILEGES_RELEASE_FAILED`);
  const malformed = fakePool();
  const client = await malformed.pool.connect();
  const query = client.query.bind(client);
  client.query = async (sql, params) => (sql.includes("has_schema_privilege") ? { rows: {}, rowCount: 0 } : query(sql, params));
  await rejectsCode(grantAndVerifyRuntimePrivileges({ async connect() { return client; } }, options()),
    `${PREFIX}PRIMARY_RUNTIME_PRIVILEGES_READ_FAILED`);
});

test("ensureSchema creates an absent schema, accepts its own, and refuses another owner's", async () => {
  const owner = "w2-opsdb-migrator@w2-opsdb-synthetic.iam";
  const fresh = fakePool();
  await ensureSchema(fresh.pool, { role: "primary", schema: SCHEMA, ownerRole: owner, codePrefix: PREFIX });
  assert.equal(fresh.statements.some(({ sql }) => sql === `CREATE SCHEMA "${SCHEMA}"`), true);
  const existing = fakePool({ owner });
  await ensureSchema(existing.pool, { role: "primary", schema: SCHEMA, ownerRole: owner, codePrefix: PREFIX });
  assert.equal(existing.statements.some(({ sql }) => sql.startsWith("CREATE SCHEMA")), false);
  const foreign = fakePool({ owner: "someone-else" });
  await rejectsCode(ensureSchema(foreign.pool, { role: "primary", schema: SCHEMA, ownerRole: owner, codePrefix: PREFIX }),
    `${PREFIX}PRIMARY_SCHEMA_OWNER_UNEXPECTED`);
  assert.equal(foreign.statements.at(-1).sql, "ROLLBACK");
  await rejectsCode(ensureSchema(fresh.pool, { role: "primary", schema: SCHEMA, ownerRole: "", codePrefix: PREFIX }),
    `${PREFIX}SCHEMA_OWNER_INVALID`);
});

test("readBackReceipts requires the exact history in a read-only transaction", async () => {
  const expected = [{ version: 1, name: "0001_a.sql", sha256: "a".repeat(64) }, { version: 2, name: "0002_b.sql", sha256: "b".repeat(64) }];
  const rows = expected.map(({ version, name, sha256 }) => ({ version, name, checksum_sha256: sha256 }));
  const exact = fakePool({ history: rows });
  await readBackReceipts(exact.pool, { role: "primary", schema: SCHEMA, expected, codePrefix: PREFIX });
  assert.equal(exact.statements[0].sql, "BEGIN READ ONLY");
  for (const history of [rows.slice(0, 1), [rows[0], { ...rows[1], checksum_sha256: "c".repeat(64) }], [...rows, rows[1]]]) {
    const { pool } = fakePool({ history });
    await rejectsCode(readBackReceipts(pool, { role: "primary", schema: SCHEMA, expected, codePrefix: PREFIX }),
      `${PREFIX}PRIMARY_RECEIPT_MISMATCH`);
  }
});

/** Every non-test JavaScript or TypeScript module under the given Worker directories. */
async function productModules(directories) {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:mjs|js|ts)$/u.test(entry.name) && !/\.(?:check|spec|test)\.[a-z]+$/u.test(entry.name)) files.push(path);
    }
  };
  for (const directory of directories) await walk(join(WORKER_ROOT, directory));
  return files;
}

test("ratchet: no other Worker module grants routines or table privileges, so there is one runtime-grant policy", async () => {
  const offenders = [];
  for (const file of await productModules(["cloud-run", "scripts", "src"])) {
    const text = await readFile(file, "utf8");
    if (/GRANT\s+EXECUTE\s+ON\s+FUNCTION|ON\s+ALL\s+TABLES\s+IN\s+SCHEMA|ON\s+ALL\s+ROUTINES\s+IN\s+SCHEMA/u.test(text)) {
      offenders.push(relative(WORKER_ROOT, file));
    }
  }
  assert.deepEqual(offenders, ["cloud-run/postgres-runtime-grants.mjs"]);
});
