#!/usr/bin/env node

// scripts/gcp-test-database.mjs applies the shared runtime-grant policy
// (cloud-run/postgres-runtime-grants.mjs) with its read-back. Before this
// change it granted only insert_telemetry_v1_contribution, the gap the
// 2026-10-01 live edge write tier found in the fast-path routine. An injected
// client records every statement; no database, connector or credential is used.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  functionSignature,
  OPERATOR_ONLY_PRIMARY_FUNCTIONS,
  RUNTIME_PRIMARY_FUNCTIONS,
} from "../cloud-run/postgres-runtime-grants.mjs";
import {
  ensureSchema,
  GCP_TEST_DATABASE_GRANT_CODE_PREFIX,
  grantRuntimePrivileges,
  JobError,
} from "./gcp-test-database.mjs";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const RUNTIME = "w2-opsdb-runtime@w2-opsdb-synthetic.iam";
const PRIMARY = Object.freeze({ role: "primary", schema: "w2_opsdb_qualification_primary" });
const LEDGER = Object.freeze({ role: "ledger", schema: "w2_opsdb_qualification_ledger" });
const EMPTY = Object.freeze({ rows: [], rowCount: 0 });
const RUNTIME_SIGNATURES = RUNTIME_PRIMARY_FUNCTIONS.map(functionSignature);
const OPERATOR_SIGNATURES = OPERATOR_ONLY_PRIMARY_FUNCTIONS.map(functionSignature);
const POSTURE = Object.freeze({
  schema_usage: true, schema_create: false, application_tables_dml: true, sequences_access: true,
  history_select: true, history_insert: false, history_update: false, history_delete: false,
  default_tables_dml: true, default_sequences_access: true,
  no_global_table_defaults: true, no_global_sequence_defaults: true,
});

/** A client whose function grants follow its statements; the read-back reports them. */
function injectedClient({ role = "primary", posture = {}, extra = [], failOn = () => false } = {}) {
  const statements = [];
  const releases = [];
  const granted = new Set();
  const client = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (failOn(sql)) throw Object.assign(new Error("synthetic driver failure"), { code: "XX000" });
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
        return { rows: [{ ...POSTURE, ...posture, restricted_functions: [...restricted, ...extra] }], rowCount: 1 };
      }
      throw new Error("unexpected statement");
    },
    async release(discard = false) {
      releases.push(discard);
    },
  };
  return { pool: { async connect() { return client; } }, statements, releases, granted };
}

const refusedWith = (code) => (error) => error instanceof JobError && error.code === code;

test("importing the job runs nothing; it applies the shared policy under its own code family", () => {
  assert.equal(GCP_TEST_DATABASE_GRANT_CODE_PREFIX, "");
  assert.equal(process.exitCode, undefined, "no job ran on import");
});

test("the primary grant set equals the shared three-function policy, with its read-back, for the configured role and schema", async () => {
  const { pool, statements, releases, granted } = injectedClient();
  await grantRuntimePrivileges(pool, PRIMARY, RUNTIME);
  const executeGrants = statements.map(({ sql }) => sql).filter((sql) => sql.startsWith("GRANT EXECUTE ON FUNCTION "));
  assert.deepEqual(executeGrants, RUNTIME_PRIMARY_FUNCTIONS.map(({ name, args }) =>
    `GRANT EXECUTE ON FUNCTION "${PRIMARY.schema}"."${name}"(${args}) TO "${RUNTIME}"`));
  assert.deepEqual([...granted].sort(), [...RUNTIME_SIGNATURES].sort(),
    "insert_telemetry_v1_contribution, storage_journal_append and storage_owner_link_ensure");
  for (const signature of OPERATOR_SIGNATURES) {
    assert.equal(statements.some(({ sql }) => sql.includes(signature.split("(")[0])), false, `${signature} is never granted`);
  }
  const resetIndex = statements.findIndex(({ sql }) => sql.startsWith("REVOKE ALL ON ALL ROUTINES IN SCHEMA "));
  const firstGrant = statements.findIndex(({ sql }) => sql.startsWith("GRANT EXECUTE"));
  assert.ok(resetIndex >= 0 && resetIndex < firstGrant, "direct routine grants are reset before granting");
  assert.equal(statements.some(({ sql }) => sql === `REVOKE ALL ON SCHEMA "${PRIMARY.schema}" FROM "${RUNTIME}"`), true);
  const readBack = statements.find(({ sql }) => sql.includes("has_schema_privilege($1, $2, 'USAGE')"));
  assert.deepEqual(readBack.params.slice(0, 2), [RUNTIME, PRIMARY.schema], "the read-back names the configured role and schema");
  assert.equal(statements.at(-1).sql, "COMMIT");
  assert.deepEqual(releases, [false]);
  for (const { sql } of statements.filter(({ sql: text }) => /^(?:GRANT|REVOKE|ALTER DEFAULT)/u.test(text))) {
    assert.ok(sql.includes(`"${PRIMARY.schema}"`) && sql.includes(`"${RUNTIME}"`), sql);
  }

  const ledger = injectedClient({ role: "ledger" });
  await grantRuntimePrivileges(ledger.pool, LEDGER, RUNTIME);
  assert.equal(ledger.statements.some(({ sql }) => sql.startsWith("GRANT EXECUTE")), false, "the ledger grants no function");
});

test("the read-back refuses a schema where the runtime role holds any extra non-PUBLIC function, with this job's codes", async () => {
  const cases = [
    ["an extra non-PUBLIC function", { extra: [{ signature: "w2_opsdb_extra_backfill(integer)", runtime_execute: true }] }],
    ["an operator-only entrypoint", { extra: [{ signature: OPERATOR_SIGNATURES[0], runtime_execute: true }] }],
    ["CREATE on the schema", { posture: { schema_create: true } }],
    ["write access to migration history", { posture: { history_insert: true } }],
    ["missing table DML", { posture: { application_tables_dml: false } }],
  ];
  for (const [label, setup] of cases) {
    const { pool, statements, releases } = injectedClient(setup);
    await assert.rejects(grantRuntimePrivileges(pool, PRIMARY, RUNTIME), refusedWith("PRIMARY_RUNTIME_PRIVILEGES_INVALID"), label);
    assert.equal(statements.at(-1).sql, "ROLLBACK", label);
    assert.deepEqual(releases, [true], label);
  }
  const missingRuntimeFunction = injectedClient({ failOn: () => false });
  const client = await missingRuntimeFunction.pool.connect();
  const original = client.query.bind(client);
  client.query = async (sql, params) => {
    const result = await original(sql, params);
    if (sql.includes("has_schema_privilege($1, $2, 'USAGE')")) {
      result.rows[0].restricted_functions = result.rows[0].restricted_functions
        .filter(({ signature }) => signature !== RUNTIME_SIGNATURES[2]);
    }
    return result;
  };
  await assert.rejects(grantRuntimePrivileges({ async connect() { return client; } }, PRIMARY, RUNTIME),
    refusedWith("PRIMARY_RUNTIME_PRIVILEGES_INVALID"), "a runtime function missing or reopened to PUBLIC");
  const ledger = injectedClient({ role: "ledger", extra: [{ signature: RUNTIME_SIGNATURES[0], runtime_execute: true }] });
  await assert.rejects(grantRuntimePrivileges(ledger.pool, LEDGER, RUNTIME), refusedWith("LEDGER_RUNTIME_PRIVILEGES_INVALID"));
});

test("driver failures and invalid identifiers refuse with closed job codes", async () => {
  const driver = injectedClient({ failOn: (sql) => sql.startsWith("GRANT EXECUTE") });
  await assert.rejects(grantRuntimePrivileges(driver.pool, PRIMARY, RUNTIME), (error) =>
    refusedWith("PRIMARY_RUNTIME_GRANT_FAILED")(error) && !error.message.includes("synthetic"));
  assert.deepEqual(driver.releases, [true]);
  const { pool, statements } = injectedClient();
  await assert.rejects(grantRuntimePrivileges(pool, { role: "primary", schema: "Bad-Schema" }, RUNTIME),
    refusedWith("SCHEMA_INVALID"));
  await assert.rejects(grantRuntimePrivileges(pool, PRIMARY, 'bad"role'), refusedWith("RUNTIME_ROLE_INVALID"));
  await assert.rejects(grantRuntimePrivileges(pool, { role: "admin", schema: PRIMARY.schema }, RUNTIME),
    refusedWith("ROLE_INVALID"));
  assert.deepEqual(statements, [], "argument refusals precede any connection");
});

test("ensureSchema still refuses a schema another role owns", async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes("FROM pg_namespace")) return { rows: [{ owner: "someone-else" }], rowCount: 1 };
      return EMPTY;
    },
    release() {},
  };
  await assert.rejects(ensureSchema({ async connect() { return client; } }, PRIMARY, "w2-opsdb-migrator@w2-opsdb-synthetic.iam"),
    refusedWith("PRIMARY_SCHEMA_OWNER_UNEXPECTED"));
  assert.equal(statements.some((sql) => sql.startsWith("CREATE SCHEMA")), false);
});

test("the job source carries no grant SQL of its own and keeps the reviewed INSTANCE_PATTERN literal", async () => {
  const source = await readFile(join(SCRIPTS_ROOT, "gcp-test-database.mjs"), "utf8");
  assert.doesNotMatch(source, /GRANT\s+EXECUTE|ON\s+ALL\s+TABLES\s+IN\s+SCHEMA/u);
  assert.equal([...source.matchAll(/^const INSTANCE_PATTERN = \/(.+)\/([a-z]*);$/gmu)].length, 1,
    "scripts/gcp-backup-horizon.check.mjs pins this literal");
  assert.match(source, /if \(invokedDirectly\(\)\) \{/u, "the job runs only as the entry point");
});
