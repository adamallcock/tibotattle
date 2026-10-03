#!/usr/bin/env node

// OPS-10 production migration job (postgres-production-migrations.mjs) with
// fake identity, pools and runner: its closed environment, target and
// identity contract, the expand-compatibility review, the SIMP residue
// ordering guard, the read-only history comparison, the order of its writes,
// and its content-free receipt. The PostgreSQL 17 proof is
// postgres-test/postgres-production-migrations.spec.mjs.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { readPostgresMigrations } from "./postgres-migrations.mjs";
import {
  assertExpandCompatible,
  classifyContractOperations,
  compareHistoryToManifest,
  CONTRACT_MIGRATIONS,
  isTestTargetValue,
  parseProductionMigrationConfig,
  primaryManifestSha256,
  PRODUCTION_MIGRATION_JOB,
  PRODUCTION_MIGRATION_RECEIPT_SCHEMA,
  productionMigrationReceiptDigest,
  readAttachedServiceAccountEmail,
  runProductionMigrations,
  safeProductionMigrationErrorCode,
  SCRATCH_INSTANCE_PATTERN,
  SIMP_RESIDUE_MIGRATION_SUFFIX,
  SIMP_RESIDUE_PREDECESSOR,
  simpResidueMigration,
  validateProductionMigrationEnvironment,
  verifyProductionMigrationReceipt,
} from "./postgres-production-migrations.mjs";
import {
  functionSignature,
  OPERATOR_ONLY_PRIMARY_FUNCTIONS,
  RUNTIME_PRIMARY_FUNCTIONS,
} from "./postgres-runtime-grants.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./cloud-run-iam-test-target.mjs";
import {
  FASTPATH_MIGRATION_TARGETS,
  GRAPH_BENCHMARK_MIGRATION_TARGETS,
  TEST_MIGRATIONS_IAM_USER,
  TEST_MIGRATIONS_RUNTIME_IAM_USER,
  TEST_MIGRATIONS_SERVICE_ACCOUNT,
} from "./test-migrations.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROJECT = "w2-opsdb-synthetic";
const MIGRATOR_SA = `w2-opsdb-migrator@${PROJECT}.iam.gserviceaccount.com`;
const MIGRATOR = `w2-opsdb-migrator@${PROJECT}.iam`;
const RUNTIME = `w2-opsdb-runtime@${PROJECT}.iam`;
const ENVIRONMENT_INSTANCE = `${PROJECT}:us-east1:w2-opsdb-primary`;
const SCRATCH_INSTANCE = `${PROJECT}:us-east1:w2-opsdb-primary-rehearsal-0a1b2c3d`;
const SCHEMA = "w2_opsdb_primary";
const EMPTY = Object.freeze({ rows: [], rowCount: 0 });
const primary = await readPostgresMigrations({ role: "primary" });
// The real manifest carries LEAD-SIMP's residue (its final name, OD-1),
// followed by additive migrations and K-CORE-A's reviewed run stamps (0069).
// The "missing residue" cases slice it off, with the contract entries of
// everything sliced, instead of naming a synthetic file at a hard-coded
// number.
const REAL_RESIDUE = "0064_append_only_residue.sql";
// The manifest before the residue (0001-0063): the residue and everything
// promoted after it (0065 the interim public read, 0066 and 0067 from
// D-PT4X, 0068 from D-OPS4, 0069 from K-CORE-A) sliced off.
const residueFree = Object.freeze(primary.slice(0, primary.findIndex(({ name }) => name === REAL_RESIDUE)));
const residueFreeContracts = Object.freeze(Object.fromEntries(Object.entries(CONTRACT_MIGRATIONS)
  .filter(([name]) => residueFree.some((migration) => migration.name === name))));

function validEnv(overrides = {}) {
  const env = {
    CLOUD_RUN_JOB: "tibotattle-production-migrate",
    CLOUD_RUN_EXECUTION: "tibotattle-production-migrate-x7k2p",
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: PROJECT,
    MIGRATION_ENVIRONMENT: "production",
    PRODUCTION_MIGRATOR_SERVICE_ACCOUNT: MIGRATOR_SA,
    POSTGRES_MIGRATOR_IAM_USER: MIGRATOR,
    POSTGRES_RUNTIME_IAM_USER: RUNTIME,
    ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME: ENVIRONMENT_INSTANCE,
    PRIMARY_INSTANCE_CONNECTION_NAME: SCRATCH_INSTANCE,
    PRIMARY_DATABASE: "tibotattle",
    PRIMARY_SCHEMA: SCHEMA,
    DEPLOYMENT_SOURCE_COMMIT: "c".repeat(40),
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

const isCode = (code) => (error) => error?.code === code;

/** A migration list with one synthetic migration appended, as readPostgresMigrations returns it. */
function withExtraMigration(base, name, sql) {
  const version = base.length + 1;
  return Object.freeze([...base, Object.freeze({
    role: "primary",
    version,
    name: `${String(version).padStart(4, "0")}_${name}`,
    bytes: Buffer.byteLength(sql),
    sha256: createHash("sha256").update(sql).digest("hex"),
    sql,
  })]);
}

/**
 * Fake job seams over one in-memory schema. Statements are recorded in order;
 * the runner fake writes the full history. The read-back reports function
 * grants as they were issued.
 */
function harness({
  migrations = primary, history = null, owner = null, posture = {}, attached = MIGRATOR_SA, contractMigrations,
} = {}) {
  const events = [];
  const granted = new Set();
  const state = {
    schemaExists: history !== null || owner !== null,
    owner,
    history: (history ?? []).map(({ version, name, sha256 }) => ({ version, name, checksum_sha256: sha256 })),
  };
  const counts = { identity: 0, manifest: 0, pools: 0, apply: 0, closes: 0 };
  const client = {
    async query(sql, params) {
      events.push(sql);
      if (/^(?:BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(sql)) return EMPTY;
      if (sql.includes("AS schema_present")) {
        return { rows: [{ schema_present: state.schemaExists, history_present: state.history.length > 0 }], rowCount: 1 };
      }
      if (sql.includes(`"_tibotattle_migration_history"`)) return { rows: state.history, rowCount: state.history.length };
      if (sql.includes("FROM pg_namespace WHERE nspname=$1")) {
        return state.owner === null ? EMPTY : { rows: [{ owner: state.owner }], rowCount: 1 };
      }
      if (sql.startsWith("CREATE SCHEMA ")) {
        state.schemaExists = true;
        state.owner = MIGRATOR;
        return EMPTY;
      }
      if (sql.startsWith("REVOKE ALL ON ALL ROUTINES")) {
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
        assert.deepEqual(params.slice(0, 2), [RUNTIME, SCHEMA]);
        return { rows: [{
          schema_usage: true, schema_create: false, application_tables_dml: true, sequences_access: true,
          history_select: true, history_insert: false, history_update: false, history_delete: false,
          default_tables_dml: true, default_sequences_access: true,
          no_global_table_defaults: true, no_global_sequence_defaults: true,
          restricted_functions: [...RUNTIME_PRIMARY_FUNCTIONS, ...OPERATOR_ONLY_PRIMARY_FUNCTIONS].map(functionSignature)
            .map((signature) => ({ signature, runtime_execute: granted.has(signature) })),
        }], rowCount: 1 };
      }
      if (sql.includes("FROM pg_roles r")) {
        assert.deepEqual(params, [RUNTIME, MIGRATOR, SCHEMA]);
        return { rows: [{
          rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false,
          member_of_migrator: false, database_create: false, owns_schema: false, extra_table_privileges: 0,
          ...posture,
        }], rowCount: 1 };
      }
      throw new Error("unexpected fake SQL");
    },
    async release() {},
  };
  const pool = { async connect() { return client; } };
  const dependencies = {
    async readServiceAccountEmail() {
      counts.identity += 1;
      return attached;
    },
    async readMigrations({ role }) {
      counts.manifest += 1;
      assert.equal(role, "primary", "the ledger directory is never read");
      return migrations;
    },
    createConnector: () => ({ fake: true }),
    async createPool(options) {
      counts.pools += 1;
      assert.equal(options.user, MIGRATOR);
      assert.equal(options.max, PRODUCTION_MIGRATION_JOB.pools.primary);
      assert.equal(options.applicationName, "tibotattle-production-migrator");
      return pool;
    },
    async applyMigrations({ role, schema }) {
      counts.apply += 1;
      assert.equal(role, "primary");
      events.push(`APPLY ${schema}`);
      state.history = migrations.map(({ version, name, sha256 }) => ({ version, name, checksum_sha256: sha256 }));
      return { role, schema, applied: migrations.length, migrations };
    },
    async closeResources({ pools, connector }) {
      counts.closes += 1;
      assert.deepEqual(pools, counts.pools > 0 ? [pool] : []);
      assert.equal(connector?.fake, true);
    },
    ...(contractMigrations === undefined ? {} : { contractMigrations }),
  };
  return { dependencies, events, counts, state };
}

const WRITE = /^(?:CREATE|GRANT|REVOKE|ALTER|INSERT|UPDATE|DELETE|APPLY)\b/u;

test("the job definition is single-sourced: manual, migrator identity, one task, no retries, one primary connection", () => {
  assert.deepEqual(PRODUCTION_MIGRATION_JOB, {
    name: "production-migrate", entry: "dist/production-migrations.mjs", schedule: "manual",
    serviceAccount: "migrator", tasks: 1, parallelism: 1, maxRetries: 0, taskTimeoutSeconds: 1800,
    pools: { primary: 1 },
    env: [
      "MIGRATION_ENVIRONMENT", "GOOGLE_CLOUD_PROJECT", "PRODUCTION_MIGRATOR_SERVICE_ACCOUNT",
      "POSTGRES_MIGRATOR_IAM_USER", "POSTGRES_RUNTIME_IAM_USER", "ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME",
      "PRIMARY_INSTANCE_CONNECTION_NAME", "PRIMARY_DATABASE", "PRIMARY_SCHEMA", "DEPLOYMENT_SOURCE_COMMIT",
    ],
  });
  assert.equal(Object.isFrozen(PRODUCTION_MIGRATION_JOB.pools), true);
  assert.equal(Object.isFrozen(PRODUCTION_MIGRATION_JOB.env), true);
});

test("the job's env list is exactly the operator-set env the validator reads (OPS-2 renders it)", () => {
  // Every name the validator reads, apart from what Cloud Run supplies.
  const read = new Set();
  const env = new Proxy(validEnv(), { get(target, name) { read.add(name); return target[name]; } });
  validateProductionMigrationEnvironment(env);
  const operatorSet = [...read].filter((name) => typeof name === "string"
    && !name.startsWith("CLOUD_RUN_") && name !== "K_SERVICE");
  assert.deepEqual(operatorSet.sort(), [...PRODUCTION_MIGRATION_JOB.env].sort());
  // Each one is required: dropping any refuses.
  for (const name of PRODUCTION_MIGRATION_JOB.env) {
    assert.throws(() => validateProductionMigrationEnvironment(validEnv({ [name]: undefined })),
      (error) => typeof error?.code === "string", name);
  }
});

test("the environment contract is closed: job context, identities, target, ledger and key credentials", () => {
  const config = validateProductionMigrationEnvironment(validEnv());
  assert.deepEqual(config.target, {
    kind: "scratch", instanceConnectionName: SCRATCH_INSTANCE, region: "us-east1", database: "tibotattle", schema: SCHEMA,
  });
  assert.equal(validateProductionMigrationEnvironment(validEnv({ PRIMARY_INSTANCE_CONNECTION_NAME: ENVIRONMENT_INSTANCE }))
    .target.kind, "environment");
  const cases = [
    [{ CLOUD_RUN_JOB: "tibotattle-production-refresh" }, "CLOUD_RUN_PRODUCTION_MIGRATIONS_JOB_CONTEXT_INVALID"],
    [{ CLOUD_RUN_JOB: "tibotattle-test-migrate" }, "CLOUD_RUN_PRODUCTION_MIGRATIONS_JOB_CONTEXT_INVALID"],
    [{ CLOUD_RUN_EXECUTION: "" }, "CLOUD_RUN_PRODUCTION_MIGRATIONS_JOB_CONTEXT_INVALID"],
    [{ CLOUD_RUN_TASK_COUNT: "2" }, "CLOUD_RUN_PRODUCTION_MIGRATIONS_JOB_CONTEXT_INVALID"],
    [{ CLOUD_RUN_TASK_ATTEMPT: "1" }, "CLOUD_RUN_PRODUCTION_MIGRATIONS_JOB_CONTEXT_INVALID"],
    [{ K_SERVICE: "tibotattle-production" }, "CLOUD_RUN_PRODUCTION_MIGRATIONS_JOB_CONTEXT_INVALID"],
    [{ LEDGER_SCHEMA: "tibotattle_ledger" }, "POSTGRES_PRODUCTION_MIGRATIONS_LEDGER_FORBIDDEN"],
    [{ LEDGER_DATABASE: "" }, "POSTGRES_PRODUCTION_MIGRATIONS_LEDGER_FORBIDDEN"],
    [{ LEDGER_INSTANCE_CONNECTION_NAME: ENVIRONMENT_INSTANCE }, "POSTGRES_PRODUCTION_MIGRATIONS_LEDGER_FORBIDDEN"],
    [{ GOOGLE_APPLICATION_CREDENTIALS: "/synthetic/key.json" }, "CLOUD_RUN_PRODUCTION_MIGRATIONS_KEY_CREDENTIALS_FORBIDDEN"],
    [{ MIGRATION_ENVIRONMENT: "test" }, "POSTGRES_PRODUCTION_MIGRATIONS_ENVIRONMENT_INVALID"],
    [{ GOOGLE_CLOUD_PROJECT: "Bad_Project" }, "POSTGRES_PRODUCTION_MIGRATIONS_GOOGLE_CLOUD_PROJECT_INVALID"],
    [{ PRODUCTION_MIGRATOR_SERVICE_ACCOUNT: `w2-opsdb-migrator@other-project.iam.gserviceaccount.com` },
      "POSTGRES_PRODUCTION_MIGRATIONS_MIGRATOR_SERVICE_ACCOUNT_INVALID"],
    [{ POSTGRES_MIGRATOR_IAM_USER: RUNTIME }, "POSTGRES_PRODUCTION_MIGRATIONS_MIGRATOR_IAM_USER_INVALID"],
    [{ POSTGRES_RUNTIME_IAM_USER: MIGRATOR }, "POSTGRES_PRODUCTION_MIGRATIONS_RUNTIME_IAM_USER_INVALID"],
    [{ POSTGRES_RUNTIME_IAM_USER: undefined }, "POSTGRES_PRODUCTION_MIGRATIONS_POSTGRES_RUNTIME_IAM_USER_INVALID"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: `${PROJECT}:us-east1:w2-opsdb-other` }, "POSTGRES_PRODUCTION_MIGRATIONS_TARGET_NOT_CONFIGURED"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: `${PROJECT}:us-west1:w2-opsdb-primary-rehearsal-0a1b2c3d` },
      "POSTGRES_PRODUCTION_MIGRATIONS_TARGET_NOT_CONFIGURED"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: `other-project-x:us-east1:w2-opsdb-primary-rehearsal-0a1b2c3d` },
      "POSTGRES_PRODUCTION_MIGRATIONS_TARGET_NOT_CONFIGURED"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: `${PROJECT}:us-east1:w2-opsdb-primary-rehearsal-0a1b2c3` },
      "POSTGRES_PRODUCTION_MIGRATIONS_TARGET_NOT_CONFIGURED"],
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: "not-a-connection-name" },
      "POSTGRES_PRODUCTION_MIGRATIONS_PRIMARY_INSTANCE_CONNECTION_NAME_INVALID"],
    [{ ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME: `${PROJECT}:us-east1:w2-opsdb-staging-primary` },
      "POSTGRES_PRODUCTION_MIGRATIONS_ENVIRONMENT_INSTANCE_INVALID"],
    [{ ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME: `${PROJECT}:us-east1:w2-opsdb-primary-rehearsal-0a1b2c3d` },
      "POSTGRES_PRODUCTION_MIGRATIONS_ENVIRONMENT_INSTANCE_INVALID"],
    [{ ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME: `other-project-x:us-east1:w2-opsdb-primary` },
      "POSTGRES_PRODUCTION_MIGRATIONS_ENVIRONMENT_INSTANCE_INVALID"],
    [{ MIGRATION_ENVIRONMENT: "staging" }, "POSTGRES_PRODUCTION_MIGRATIONS_ENVIRONMENT_INSTANCE_INVALID"],
    [{ PRIMARY_SCHEMA: "public" }, "POSTGRES_PRODUCTION_MIGRATIONS_PRIMARY_SCHEMA_INVALID"],
    [{ PRIMARY_SCHEMA: "pg_temp_1" }, "POSTGRES_PRODUCTION_MIGRATIONS_PRIMARY_SCHEMA_INVALID"],
    [{ PRIMARY_DATABASE: "bad-database" }, "POSTGRES_PRODUCTION_MIGRATIONS_PRIMARY_DATABASE_INVALID"],
    [{ DEPLOYMENT_SOURCE_COMMIT: "c".repeat(39) }, "POSTGRES_PRODUCTION_MIGRATIONS_DEPLOYMENT_SOURCE_COMMIT_INVALID"],
  ];
  for (const [overrides, code] of cases) {
    assert.throws(() => validateProductionMigrationEnvironment(validEnv(overrides)), isCode(code), JSON.stringify(overrides));
  }
  const staging = validateProductionMigrationEnvironment(validEnv({
    MIGRATION_ENVIRONMENT: "staging",
    ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME: `${PROJECT}:us-east1:w2-opsdb-staging-primary`,
    PRIMARY_INSTANCE_CONNECTION_NAME: `${PROJECT}:us-east1:w2-opsdb-staging-primary`,
  }));
  assert.equal(staging.target.kind, "environment");
  assert.throws(() => validateProductionMigrationEnvironment(validEnv({
    MIGRATION_ENVIRONMENT: "staging",
    ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME: `${PROJECT}:us-east1:w2-opsdb-staging-production`,
  })), isCode("POSTGRES_PRODUCTION_MIGRATIONS_ENVIRONMENT_INSTANCE_INVALID"));
});

test("scratch names: '-rehearsal-' plus eight lowercase characters and an optional b, never anything else", () => {
  for (const id of ["p-rehearsal-0a1b2c3d", "p-rehearsal-0a1b2c3db", "primary-rehearsal-abcdefgh"]) {
    assert.equal(SCRATCH_INSTANCE_PATTERN.test(id), true, id);
  }
  for (const id of ["p-rehearsal-0a1b2c3", "p-rehearsal-0A1B2C3D", "p-rehearsal-0a1b2c3dc", "p-rehearsal-0a1b2c3d-x",
    "p-rehearsal0a1b2c3d", "p-rehearsal-0a1b_2c3"]) {
    assert.equal(SCRATCH_INSTANCE_PATTERN.test(id), false, id);
  }
});

test("every test deployment identity is refused, whichever setting carries it", () => {
  const instances = [
    CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.instanceConnectionName,
    CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.instanceConnectionName,
    // The retired A2 target (OD-6) is the IAM test target's primary.
    ...Object.values(FASTPATH_MIGRATION_TARGETS).map(({ instanceConnectionName }) => instanceConnectionName),
  ];
  for (const instance of instances) assert.equal(isTestTargetValue("instance", instance), true, instance);
  const schemas = [
    CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.schema,
    ...Object.values(FASTPATH_MIGRATION_TARGETS).map(({ schema }) => schema),
    ...GRAPH_BENCHMARK_MIGRATION_TARGETS.map(({ schema }) => schema),
    "typed_legacy_transfer_rehearsal_target_fastpath_7ea408a7",
  ];
  for (const schema of schemas) assert.equal(isTestTargetValue("schema", schema), true, schema);
  assert.equal(isTestTargetValue("database", FASTPATH_MIGRATION_TARGETS.primary.database), true);
  for (const identity of [TEST_MIGRATIONS_SERVICE_ACCOUNT, TEST_MIGRATIONS_IAM_USER, TEST_MIGRATIONS_RUNTIME_IAM_USER,
    CLOUD_RUN_IAM_TEST_TARGET.postgres.iamUser]) {
    assert.equal(isTestTargetValue("iam", identity), true, identity);
  }
  for (const [overrides, label] of [
    [{ PRIMARY_INSTANCE_CONNECTION_NAME: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.instanceConnectionName,
      ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.instanceConnectionName },
    "test instance"],
    [{ ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME: `${PROJECT}:us-east1:tibotattle-test-primary-20261002` }, "test-token instance"],
    [{ PRIMARY_SCHEMA: FASTPATH_MIGRATION_TARGETS.primary.schema }, "fast-path schema"],
    [{ PRIMARY_SCHEMA: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.schema }, "A2 schema"],
    [{ PRIMARY_DATABASE: FASTPATH_MIGRATION_TARGETS.primary.database }, "fast-path database"],
    [{ POSTGRES_RUNTIME_IAM_USER: TEST_MIGRATIONS_RUNTIME_IAM_USER }, "test runtime identity"],
    [{ PRODUCTION_MIGRATOR_SERVICE_ACCOUNT: `tibotattle-test-migrator@${PROJECT}.iam.gserviceaccount.com`,
      POSTGRES_MIGRATOR_IAM_USER: `tibotattle-test-migrator@${PROJECT}.iam` }, "test migrator identity"],
  ]) {
    assert.throws(() => validateProductionMigrationEnvironment(validEnv(overrides)),
      isCode("POSTGRES_PRODUCTION_MIGRATIONS_TEST_TARGET_FORBIDDEN"), label);
  }
  assert.equal(isTestTargetValue("instance", ENVIRONMENT_INSTANCE), false);
  assert.equal(isTestTargetValue("schema", "tibotattle"), false);
});

test("the attached identity must be the configured migrator, before any manifest or SQL", async () => {
  assert.throws(() => parseProductionMigrationConfig(validEnv(), `other@${PROJECT}.iam.gserviceaccount.com`),
    isCode("CLOUD_RUN_PRODUCTION_MIGRATIONS_SERVICE_ACCOUNT_INVALID"));
  const wrong = harness({ attached: `w2-opsdb-runtime@${PROJECT}.iam.gserviceaccount.com` });
  await assert.rejects(runProductionMigrations({ env: validEnv(), dependencies: wrong.dependencies }),
    isCode("CLOUD_RUN_PRODUCTION_MIGRATIONS_SERVICE_ACCOUNT_INVALID"));
  assert.deepEqual(wrong.counts, { identity: 1, manifest: 0, pools: 0, apply: 0, closes: 0 });
  const invalid = harness();
  await assert.rejects(runProductionMigrations({ env: validEnv({ LEDGER_SCHEMA: "x" }), dependencies: invalid.dependencies }),
    isCode("POSTGRES_PRODUCTION_MIGRATIONS_LEDGER_FORBIDDEN"));
  assert.deepEqual(invalid.counts, { identity: 0, manifest: 0, pools: 0, apply: 0, closes: 0 },
    "an invalid environment is refused before the identity is even read");
  assert.equal(await readAttachedServiceAccountEmail({ createAuth: () => ({ getCredentials: async () => ({ client_email: MIGRATOR_SA }) }) }),
    MIGRATOR_SA);
  for (const auth of [
    () => ({ getCredentials: async () => ({}) }),
    () => ({ getCredentials: async () => ({ client_email: "user@example.com" }) }),
    () => ({ getCredentials: async () => { throw new Error("no credentials"); } }),
    () => { throw new Error("no client"); },
  ]) {
    await assert.rejects(readAttachedServiceAccountEmail({ createAuth: auth }),
      isCode("CLOUD_RUN_PRODUCTION_MIGRATIONS_IDENTITY_UNAVAILABLE"));
  }
});

test("contract classification finds drops, renames, tightenings and dynamic SQL, and nothing in comments, strings, relaxations or new tables", () => {
  const kinds = (sql) => [...classifyContractOperations(sql)];
  assert.deepEqual(kinds("ALTER TABLE t DROP COLUMN c;"), ["drop"]);
  assert.deepEqual(kinds("DROP INDEX IF EXISTS i;"), ["drop"]);
  assert.deepEqual(kinds("ALTER TABLE t RENAME COLUMN a TO b;"), ["rename"]);
  assert.deepEqual(kinds("ALTER TABLE t ALTER COLUMN c SET NOT NULL;"), ["set-not-null"]);
  assert.deepEqual(kinds("ALTER TABLE t ADD COLUMN c text NOT NULL;"), ["add-not-null-without-default"]);
  assert.deepEqual(kinds("ALTER TABLE t ADD c integer NOT NULL, ADD COLUMN d text;"), ["add-not-null-without-default"]);
  assert.deepEqual(kinds("CREATE FUNCTION f() RETURNS void AS $body$ BEGIN DROP TABLE x; END $body$ LANGUAGE plpgsql;"),
    ["drop"], "function bodies are code and are scanned");
  // Tightenings the previous revision can fail on.
  assert.deepEqual(kinds("ALTER TABLE t ALTER COLUMN c TYPE integer USING c::integer;"), ["alter-type"]);
  assert.deepEqual(kinds("ALTER TABLE t ALTER c SET DATA TYPE bigint;"), ["alter-type"]);
  for (const sql of [
    "ALTER TABLE t ADD CONSTRAINT k CHECK (c IS NOT NULL);",
    "ALTER TABLE t ADD CONSTRAINT k CHECK (c > 0);",
    "ALTER TABLE t ADD CONSTRAINT u UNIQUE (c);",
    "ALTER TABLE ONLY t ADD PRIMARY KEY (id);",
    "ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (c) REFERENCES u(id);",
    "ALTER TABLE t ADD EXCLUDE USING gist (c WITH &&);",
    "ALTER TABLE t ADD COLUMN d text, ADD CHECK (c > 0);",
    "ALTER DOMAIN d ADD CONSTRAINT k CHECK (VALUE > 0);",
  ]) assert.deepEqual(kinds(sql), ["add-constraint"], sql);
  for (const sql of [
    "CREATE UNIQUE INDEX i ON t (c);",
    "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS i ON ONLY s.t (c);",
    "CREATE UNIQUE INDEX ON t (c);",
    "CREATE TABLE IF NOT EXISTS t (c integer); CREATE UNIQUE INDEX i ON t (c);",
    "CREATE TABLE \"t\" (c integer); CREATE UNIQUE INDEX i ON \"t\" (c);",
    // An index whose table cannot be read fails closed, even beside a new table's index.
    "CREATE TABLE t (c integer); CREATE UNIQUE INDEX i ON t (c); CREATE UNIQUE INDEX j ON (c);",
  ]) assert.deepEqual(kinds(sql), ["unique-index"], sql);
  assert.deepEqual(kinds("DO $$ BEGIN EXECUTE 'DROP TABLE t'; END $$;"), ["dynamic-sql"],
    "a string literal is blanked, so dynamic SQL is flagged for review rather than read");
  assert.deepEqual(kinds("CREATE FUNCTION f() RETURNS void AS $$ BEGIN EXECUTE format('SELECT %I', x); END $$ LANGUAGE plpgsql;"),
    ["dynamic-sql"]);
  for (const sql of [
    "ALTER TABLE t ADD COLUMN c text NOT NULL DEFAULT 'x';",
    "ALTER TABLE t ADD COLUMN c bigint NOT NULL GENERATED ALWAYS AS IDENTITY;",
    "ALTER TABLE t ALTER COLUMN c DROP NOT NULL;",
    "ALTER TABLE t ADD CONSTRAINT k CHECK (c > 0) NOT VALID;",
    "ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (c) REFERENCES u(id) NOT VALID;",
    "CREATE TABLE t (c integer); CREATE UNIQUE INDEX i ON t (c); ALTER TABLE t ADD CONSTRAINT k CHECK (c > 0);",
    "CREATE INDEX i ON t (c);",
    "ALTER TYPE e ADD VALUE 'x';",
    "GRANT EXECUTE ON FUNCTION f() TO r; REVOKE EXECUTE ON FUNCTION g() FROM PUBLIC;",
    "CREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();",
    "CREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW EXECUTE PROCEDURE f();",
    "CREATE TEMP TABLE x (id integer) ON COMMIT DROP;",
    "-- DROP TABLE t; RENAME; SET NOT NULL\nSELECT 1;",
    "/* DROP TABLE t; /* nested */ RENAME */ SELECT 1;",
    "SELECT 'DROP TABLE t; RENAME', E'it\\'s SET NOT NULL';",
    "SELECT \"DROP TABLE\" FROM t;",
    "COMMENT ON TABLE t IS 'never DROP or RENAME';",
  ]) assert.deepEqual(kinds(sql), [], sql);
});

test("the promoted primary tail 0001-0069 is classified once and pinned in CONTRACT_MIGRATIONS", () => {
  const classified = Object.fromEntries(primary.map((migration) => [migration.name, classifyContractOperations(migration.sql)])
    .filter(([, operations]) => operations.length > 0));
  assert.deepEqual(Object.keys(CONTRACT_MIGRATIONS).sort(), Object.keys(classified).sort());
  for (const [name, entry] of Object.entries(CONTRACT_MIGRATIONS)) {
    const migration = primary.find((candidate) => candidate.name === name);
    assert.equal(entry.sha256, migration.sha256, name);
    assert.deepEqual([...entry.operations], [...classified[name]], name);
    assert.ok(entry.reason.length > 20, name);
  }
  assert.equal(Object.keys(CONTRACT_MIGRATIONS).length, 26);
  assert.equal(assertExpandCompatible(primary), 26);
  // LEAD-SIMP's residue: reviewed with exactly the operations it performs.
  const residue = primary.find(({ name }) => name === REAL_RESIDUE);
  assert.equal(residue.version, 64);
  // The interim public read (0065), D-PT4X's community_aggregate_exclusions
  // (0066) and pending_object_transfer_holds (0067), and D-OPS4's ready_at
  // index (0068) follow it and are additive: no entry. K-CORE-A's run stamps
  // (0069) drop the manifest_version defaults they add: reviewed, one entry.
  const RUN_STAMPS = "0069_analytics_v2_run_stamps.sql";
  assert.deepEqual(primary.filter(({ version }) => version > residue.version).map(({ name }) => name), [
    "0065_interim_public_read.sql",
    "0066_community_aggregate_exclusions.sql",
    "0067_pending_object_transfer_holds.sql",
    "0068_v12_ready_manifest_ready_at_index.sql",
    RUN_STAMPS,
  ]);
  for (const migration of primary.filter(({ version, name }) => version > residue.version && name !== RUN_STAMPS)) {
    assert.deepEqual([...classifyContractOperations(migration.sql)], [], migration.name);
  }
  const runStamps = primary.find(({ name }) => name === RUN_STAMPS);
  assert.deepEqual([...CONTRACT_MIGRATIONS[RUN_STAMPS].operations], ["drop"]);
  assert.deepEqual([...classifyContractOperations(runStamps.sql)], ["drop"]);
  // Its only DROP is the transitional default, and its constraints on existing
  // tables are NOT VALID (earlier rows stay unattributed).
  assert.deepEqual([...runStamps.sql.matchAll(/\bDROP\s+(?!NOT\s+NULL\b)\w+/gu)].map((match) => match[0]),
    Array(7).fill("DROP DEFAULT"));
  assert.doesNotMatch(runStamps.sql, /\bEXECUTE\b(?!\s+FUNCTION\b)/u, "the run stamps carry no dynamic SQL");
  assert.deepEqual([...CONTRACT_MIGRATIONS[REAL_RESIDUE].operations], ["drop", "add-constraint"]);
  assert.deepEqual([...classifyContractOperations(residue.sql)], ["drop", "add-constraint"]);
  assert.doesNotMatch(residue.sql, /EXECUTE/iu, "the residue carries no dynamic SQL, comments included");
  // Without its entry the residue is an unreviewed contract migration; the
  // entry without the residue is stale.
  assert.throws(() => assertExpandCompatible(primary, residueFreeContracts),
    isCode("PRODUCTION_MIGRATION_CONTRACT_UNREVIEWED"));
  assert.throws(() => assertExpandCompatible(residueFree), isCode("PRODUCTION_MIGRATION_CONTRACT_MAP_STALE"));
  assert.equal(assertExpandCompatible(residueFree, residueFreeContracts), 24);
});

test("an unreviewed, changed or stale contract migration refuses the image", () => {
  const dropping = withExtraMigration(primary, "w2_opsdb_drop_column.sql", "ALTER TABLE participants DROP COLUMN created_at;");
  assert.throws(() => assertExpandCompatible(dropping), isCode("PRODUCTION_MIGRATION_CONTRACT_UNREVIEWED"));
  const renaming = withExtraMigration(primary, "w2_opsdb_rename.sql", "ALTER TABLE participants RENAME TO people;");
  assert.throws(() => assertExpandCompatible(renaming), isCode("PRODUCTION_MIGRATION_CONTRACT_UNREVIEWED"));
  const reviewed = { ...CONTRACT_MIGRATIONS, [dropping.at(-1).name]: { sha256: dropping.at(-1).sha256, operations: ["drop"],
    reason: "synthetic reviewed contract migration" } };
  assert.equal(assertExpandCompatible(dropping, reviewed), 27);
  for (const [name, sql] of [
    ["w2_opsdb_retype.sql", "ALTER TABLE participants ALTER COLUMN created_at TYPE text;"],
    ["w2_opsdb_check.sql", "ALTER TABLE participants ADD CONSTRAINT w2_opsdb_check CHECK (id <> '');"],
    ["w2_opsdb_unique.sql", "CREATE UNIQUE INDEX w2_opsdb_unique ON participants (created_at);"],
    ["w2_opsdb_dynamic.sql", "DO $$ BEGIN EXECUTE 'DROP TABLE participants'; END $$;"],
  ]) {
    assert.throws(() => assertExpandCompatible(withExtraMigration(primary, name, sql)),
      isCode("PRODUCTION_MIGRATION_CONTRACT_UNREVIEWED"), name);
  }
  const changed = primary.map((migration) => migration.name === "0050_admin_audit_and_collection_controls.sql"
    ? { ...migration, sha256: "f".repeat(64) } : migration);
  assert.throws(() => assertExpandCompatible(changed), isCode("PRODUCTION_MIGRATION_CONTRACT_UNREVIEWED"));
  assert.throws(() => assertExpandCompatible(primary, { ...CONTRACT_MIGRATIONS, "0099_absent.sql": CONTRACT_MIGRATIONS["0014_effective_source_revision.sql"] }),
    isCode("PRODUCTION_MIGRATION_CONTRACT_MAP_STALE"));
  assert.throws(() => assertExpandCompatible(primary, { ...CONTRACT_MIGRATIONS, "0001_schema_metadata.sql": {
    sha256: primary[0].sha256, operations: ["drop"], reason: "not a contract migration" } }),
  isCode("PRODUCTION_MIGRATION_CONTRACT_MAP_STALE"));
});

test("the SIMP residue guard: only an '_append_only_residue.sql' migration after 0053 and 0063 counts", () => {
  assert.equal(SIMP_RESIDUE_PREDECESSOR, "0063_enrollment_grants_erased_redeemer.sql");
  assert.equal(SIMP_RESIDUE_MIGRATION_SUFFIX, "_append_only_residue.sql");
  // The real manifest carries LEAD-SIMP's residue right after the predecessor.
  assert.equal(simpResidueMigration(primary).name, REAL_RESIDUE);
  assert.equal(residueFree.at(-1).name, SIMP_RESIDUE_PREDECESSOR, "the predecessor precedes the residue");
  assert.equal(simpResidueMigration(residueFree), null, "the real residue sliced off is a missing residue");
  const synthetic = withExtraMigration(residueFree, "simp_append_only_residue.sql", "SELECT 1;\n");
  assert.equal(simpResidueMigration(synthetic).name, `${String(residueFree.length + 1).padStart(4, "0")}_simp_append_only_residue.sql`);
  const renamed = (index, name) => residueFree.map((migration, at) => at === index ? { ...migration, name } : migration);
  assert.equal(simpResidueMigration(renamed(10, "0011_early_append_only_residue.sql")), null,
    "a residue before 0053 does not follow the fences");
  assert.equal(simpResidueMigration(renamed(59, "0060_early_append_only_residue.sql")), null,
    "a residue numbered before 0063 does not follow the numbering");
  assert.equal(simpResidueMigration(withExtraMigration(residueFree.slice(0, -1), "simp_append_only_residue.sql", "SELECT 1;\n")),
    null, "a manifest without the predecessor has no residue");
  assert.equal(simpResidueMigration(withExtraMigration(residueFree, "append_only_residue_notes.sql", "SELECT 1;")), null);
});

test("history versus manifest: behind and current proceed; ahead and non-prefix histories refuse", () => {
  const rows = (list) => list.map(({ version, name, sha256 }) => ({ version, name, checksum_sha256: sha256 }));
  assert.deepEqual({ ...compareHistoryToManifest([], primary) }, { applied: 0, pending: primary.length });
  assert.deepEqual({ ...compareHistoryToManifest(rows(primary.slice(0, 40)), primary) },
    { applied: 40, pending: primary.length - 40 });
  assert.deepEqual({ ...compareHistoryToManifest(rows(primary), primary) }, { applied: primary.length, pending: 0 });
  assert.equal(primary.length, 69);
  const newer = rows(withExtraMigration(primary, "w2_opsdb_newer.sql", "SELECT 1;"));
  assert.throws(() => compareHistoryToManifest(newer, primary), isCode("MIGRATION_STATE_NEWER_THAN_IMAGE"));
  const diverged = [
    rows(primary).map((row) => row.version === 30 ? { ...row, checksum_sha256: "0".repeat(64) } : row),
    rows(primary).map((row) => row.version === 2 ? { ...row, name: "0002_w2_opsdb_other.sql" } : row),
    rows(primary).filter((row) => row.version !== 5),
    [...rows(primary).slice(0, -1), { ...rows(primary).at(-1), version: primary.length + 1 }],
    [{ version: "1", name: primary[0].name, checksum_sha256: primary[0].sha256 }],
    // Ahead and diverged: divergence wins, so a newer image never hides a fork.
    newer.map((row) => row.version === 1 ? { ...row, checksum_sha256: "1".repeat(64) } : row),
  ];
  for (const history of diverged) {
    assert.throws(() => compareHistoryToManifest(history, primary), isCode("MIGRATION_HISTORY_DIVERGED"));
  }
});

test("a fresh scratch target: read-only history first, then schema, forward runner, grants, read-back, posture", async () => {
  const run = harness();
  const receipt = await runProductionMigrations({ env: validEnv(), dependencies: run.dependencies });
  assert.deepEqual(run.counts, { identity: 1, manifest: 1, pools: 1, apply: 1, closes: 1 });
  const firstWrite = run.events.findIndex((sql) => WRITE.test(sql));
  assert.equal(run.events[0], "BEGIN READ ONLY", "the history comparison opens read-only");
  assert.ok(run.events.findIndex((sql) => sql.includes("AS schema_present")) < firstWrite);
  assert.equal(run.events[firstWrite], `CREATE SCHEMA "${SCHEMA}"`);
  const order = ["CREATE SCHEMA", "APPLY", "GRANT EXECUTE", "_tibotattle_migration_history\"\n        ORDER BY", "FROM pg_roles r"]
    .map((marker) => run.events.findIndex((sql, index) => index >= firstWrite && sql.includes(marker)));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "schema, runner, grants, read-back, posture, in that order");
  assert.ok(order.every((index) => index >= 0));
  assert.equal(verifyProductionMigrationReceipt(receipt).digest, receipt.digest);
  assert.equal(receipt.schema, PRODUCTION_MIGRATION_RECEIPT_SCHEMA);
  assert.equal(receipt.target.kind, "scratch");
  assert.equal(receipt.migrations.count, 69);
  assert.equal(receipt.migrations.manifestSha256, primaryManifestSha256(primary));
  assert.equal(receipt.migrations.contractReviewed, 26);
  assert.equal(receipt.migrations.simpResidue, REAL_RESIDUE);
  assert.equal(receipt.ledger, "not-migrated");
  assert.equal(receipt.sourceCommit, "c".repeat(40));
  const rerun = await runProductionMigrations({ env: validEnv(), dependencies: run.dependencies });
  assert.deepEqual(rerun, receipt, "a rerun returns the identical receipt");
  assert.equal(run.events.filter((sql) => sql.startsWith("CREATE SCHEMA")).length, 1);
});

test("ahead and diverged histories refuse with no write, and the pool is still closed", async () => {
  const newer = withExtraMigration(primary, "w2_opsdb_newer.sql", "SELECT 1;");
  for (const [history, code] of [
    [newer, "MIGRATION_STATE_NEWER_THAN_IMAGE"],
    [primary.map((migration) => migration.version === 7 ? { ...migration, sha256: "e".repeat(64) } : migration),
      "MIGRATION_HISTORY_DIVERGED"],
  ]) {
    const run = harness({ history, owner: MIGRATOR });
    await assert.rejects(runProductionMigrations({ env: validEnv(), dependencies: run.dependencies }), isCode(code));
    assert.deepEqual(run.events.filter((sql) => WRITE.test(sql)), [], `${code}: no write`);
    assert.equal(run.counts.apply, 0);
    assert.equal(run.counts.closes, 1);
  }
});

test("a non-scratch target needs the SIMP residue in the image manifest; refused before any connection otherwise", async () => {
  const env = validEnv({ PRIMARY_INSTANCE_CONNECTION_NAME: ENVIRONMENT_INSTANCE });
  // The real manifest with its residue sliced off (and its contract entry).
  const refused = harness({ migrations: residueFree, contractMigrations: residueFreeContracts });
  await assert.rejects(runProductionMigrations({ env, dependencies: refused.dependencies }),
    isCode("PRODUCTION_SIMP_RESIDUE_MISSING"));
  assert.deepEqual(refused.counts, { identity: 1, manifest: 1, pools: 0, apply: 0, closes: 0 });
  assert.deepEqual(refused.events, []);
  // The real 69-migration manifest is accepted for a non-scratch target.
  const accepted = harness();
  const receipt = await runProductionMigrations({ env, dependencies: accepted.dependencies });
  assert.equal(receipt.target.kind, "environment");
  assert.equal(receipt.migrations.simpResidue, REAL_RESIDUE);
  assert.equal(verifyProductionMigrationReceipt(receipt).migrations.count, 69);
  // A synthetic residue named from the manifest length also satisfies the guard.
  const synthetic = withExtraMigration(residueFree, "simp_append_only_residue.sql", "SELECT 1;\n");
  const syntheticRun = harness({ migrations: synthetic, contractMigrations: residueFreeContracts });
  const syntheticReceipt = await runProductionMigrations({ env, dependencies: syntheticRun.dependencies });
  assert.equal(syntheticReceipt.migrations.simpResidue,
    `${String(synthetic.length).padStart(4, "0")}_simp_append_only_residue.sql`);
  const unreviewed = harness({ migrations: withExtraMigration(primary, "w2_opsdb_drop.sql", "DROP TABLE participants;") });
  await assert.rejects(runProductionMigrations({ env: validEnv(), dependencies: unreviewed.dependencies }),
    isCode("PRODUCTION_MIGRATION_CONTRACT_UNREVIEWED"));
  assert.equal(unreviewed.counts.pools, 0, "an unreviewed contract migration is refused before any connection");
});

test("a runtime role with any extra posture fails closed after the grant read-back", async () => {
  for (const posture of [{ rolsuper: true }, { rolcreatedb: true }, { rolcreaterole: true }, { rolbypassrls: true },
    { rolreplication: true }, { member_of_migrator: true }, { database_create: true }, { owns_schema: true },
    { extra_table_privileges: 1 }]) {
    const run = harness({ posture });
    await assert.rejects(runProductionMigrations({ env: validEnv(), dependencies: run.dependencies }),
      isCode("POSTGRES_PRODUCTION_MIGRATIONS_RUNTIME_POSTURE_INVALID"), JSON.stringify(posture));
    assert.equal(run.counts.closes, 1);
  }
});

test("the receipt is closed, content-free and digest-bound", async () => {
  const run = harness();
  const receipt = await runProductionMigrations({ env: validEnv(), dependencies: run.dependencies });
  assert.equal(receipt.digest, productionMigrationReceiptDigest(receipt));
  const text = JSON.stringify(receipt);
  assert.doesNotMatch(text, /x7k2p|applied_at|password|token/u, "no execution, timestamp or credential");
  const tampered = [
    { ...receipt, environment: "test" },
    { ...receipt, ledger: "migrated" },
    { ...receipt, extra: true },
    { ...receipt, target: { ...receipt.target, kind: "environment" } },
    { ...receipt, target: { ...receipt.target, instanceConnectionName: ENVIRONMENT_INSTANCE } },
    { ...receipt, migrations: { ...receipt.migrations, simpResidue: "0064_other.sql" } },
    { ...receipt, migrations: { ...receipt.migrations, count: 61 } },
    { ...receipt, roles: { migrator: RUNTIME, runtime: RUNTIME } },
    { ...receipt, runtimeGrants: { ...receipt.runtimeGrants, executableFunctions: ["insert_telemetry_v1_contribution(jsonb)"] } },
  ];
  for (const candidate of tampered) {
    const redigested = { ...candidate, digest: productionMigrationReceiptDigest(candidate) };
    assert.throws(() => verifyProductionMigrationReceipt(redigested), isCode("POSTGRES_PRODUCTION_MIGRATIONS_RECEIPT_INVALID"));
  }
  assert.throws(() => verifyProductionMigrationReceipt({ ...receipt, digest: "0".repeat(64) }),
    isCode("POSTGRES_PRODUCTION_MIGRATIONS_RECEIPT_INVALID"));
  assert.equal(safeProductionMigrationErrorCode({ code: "MIGRATION_HISTORY_DIVERGED" }), "MIGRATION_HISTORY_DIVERGED");
  assert.equal(safeProductionMigrationErrorCode({ code: "POSTGRES_MIGRATION_CHECKSUM_DRIFT" }), "POSTGRES_MIGRATION_CHECKSUM_DRIFT");
  assert.equal(safeProductionMigrationErrorCode({ code: "42501" }), "POSTGRES_PRODUCTION_MIGRATIONS_FAILED");
  assert.equal(safeProductionMigrationErrorCode(new Error("relation secret_table does not exist")),
    "POSTGRES_PRODUCTION_MIGRATIONS_FAILED");
});

test("the image builds dist/production-migrations.mjs without the test migrator's entry point", async () => {
  const buildSource = await readFile(join(ROOT, "build.mjs"), "utf8");
  assert.match(buildSource, /"production-migrations": PRODUCTION_MIGRATIONS_ENTRY,/u);
  assert.match(buildSource, /const PRODUCTION_MIGRATIONS_ENTRY = resolve\(ROOT, "postgres-production-migrations\.mjs"\);/u);
  const dockerfile = await readFile(join(ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /&& test -s dist\/production-migrations\.mjs &&/u);
  const result = await build({
    entryPoints: [join(ROOT, "postgres-production-migrations.mjs")],
    bundle: true, platform: "node", format: "esm", target: "node22", write: false, logLevel: "silent",
    external: ["@google-cloud/cloud-sql-connector", "google-auth-library", "jsonc-parser", "pg"],
  });
  const bundle = result.outputFiles[0].text;
  assert.match(bundle, /tibotattle-gcp-migration-v1/u);
  assert.doesNotMatch(bundle, /CLOUD_RUN_TEST_MIGRATIONS_ARGUMENTS_INVALID|tibotattle-test-migrator@/u,
    "the test migrator (and its entry-point main) never enters the production job bundle");
});
