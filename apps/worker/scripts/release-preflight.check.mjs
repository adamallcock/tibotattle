import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assessDisabledEnrollmentConfiguration,
  REQUIRED_COLUMNS,
  REQUIRED_DELETION_LEDGER_COLUMNS,
  REQUIRED_DELETION_LEDGER_SCHEMA_OBJECTS,
  REQUIRED_PRIMARY_MIGRATIONS,
  REQUIRED_SCHEMA_OBJECTS,
  validateMigrationInventory,
  validateMigrationSource,
  runReleasePreflight,
} from "./release-preflight.mjs";
import { EXPECTED_STAGING_MIGRATIONS } from "./staging-readiness-lib.mjs";

const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const localWrangler = join(
  workerDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

function safeConfig() {
  return {
    env: {
      staging: {
        vars: {
          ENVIRONMENT: "staging",
          ENROLLMENT_MODE: "disabled",
          ACCOUNT_SCOPED_INGEST_MODE: "disabled",
          UPLOAD_INGRESS_QUEUE_MODE: "disabled",
          IDENTITY_LINK_SECRET_VERSION: "staging-v1",
        },
      },
      production: {
        vars: {
          ENVIRONMENT: "production",
          ENROLLMENT_MODE: "disabled",
          ACCOUNT_SCOPED_INGEST_MODE: "disabled",
          UPLOAD_INGRESS_QUEUE_MODE: "disabled",
          IDENTITY_LINK_SECRET_VERSION: "production-v1",
        },
      },
    },
  };
}

function jsonRows(rows) {
  return JSON.stringify([{ results: rows, success: true }]);
}

async function migrationNames(directory) {
  const entries = await readdir(join(workerDirectory, directory), {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && /^\d+_.+\.sql$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
}

async function disposableState() {
  const state = await mkdtemp(join(tmpdir(), "usage-monitor-release-preflight-check-"));
  await chmod(state, 0o700);
  return state;
}

async function removeState(state) {
  await rm(state, { recursive: true, force: true });
  try {
    await access(state);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function writeHermeticWranglerConfig(root) {
  const config = {
    $schema: join(workerDirectory, "node_modules/wrangler/config-schema.json"),
    name: "app-usagemonitor-release-preflight-check",
    main: join(workerDirectory, "src/index.ts"),
    compatibility_date: "2026-07-26",
    compatibility_flags: ["nodejs_compat"],
    env: {
      staging: {
        name: "app-usagemonitor-release-preflight-check-staging",
        workers_dev: true,
        vars: {
          ENVIRONMENT: "staging",
          ENROLLMENT_MODE: "disabled",
          ACCOUNT_SCOPED_INGEST_MODE: "disabled",
          UPLOAD_INGRESS_QUEUE_MODE: "disabled",
          IDENTITY_LINK_SECRET_VERSION: "staging-v1",
        },
        d1_databases: [
          {
            binding: "USAGE_MONITOR_DB",
            database_name: "release-preflight-check-primary",
            database_id: "00000000-0000-4000-8000-000000000010",
            migrations_dir: join(workerDirectory, "migrations"),
          },
          {
            binding: "DELETION_LEDGER",
            database_name: "release-preflight-check-deletion-ledger",
            database_id: "00000000-0000-4000-8000-000000000011",
            migrations_dir: join(workerDirectory, "deletion-ledger-migrations"),
          },
        ],
      },
      production: {
        vars: {
          ENVIRONMENT: "production",
          ENROLLMENT_MODE: "disabled",
          ACCOUNT_SCOPED_INGEST_MODE: "disabled",
          UPLOAD_INGRESS_QUEUE_MODE: "disabled",
          IDENTITY_LINK_SECRET_VERSION: "production-v1",
        },
      },
    },
  };
  const configPath = join(root, "wrangler.jsonc");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { config, configPath };
}

function rowsFromWrangler(stdout) {
  try {
    const value = JSON.parse(stdout);
    const entries = Array.isArray(value) ? value : [];
    return entries.findLast((entry) => Array.isArray(entry?.results))?.results ?? null;
  } catch {
    return null;
  }
}

function schemaObjectSet(rows) {
  return new Set(
    (Array.isArray(rows) ? rows : [])
      .filter((row) => typeof row?.type === "string" && typeof row?.name === "string")
      .map((row) => `${row.type}:${row.name}`),
  );
}

function containedCollectionControlRow() {
  return {
    singleton: 1,
    schema_version: "collection-controls-v0.1",
    enrollment_enabled: 0,
    upload_registration_enabled: 0,
    processing_enabled: 0,
    publication_enabled: 0,
    control_state: "contained",
    revision: 1,
  };
}

async function standardFixture({
  collectionControlRows = [containedCollectionControlRow()],
  schemaMismatch = null,
} = {}) {
  const calls = [];
  const primaryMigrations = await migrationNames("migrations");
  const deletionLedgerMigrations = await migrationNames("deletion-ledger-migrations");
  const schemaRows = REQUIRED_SCHEMA_OBJECTS.map(([type, name]) => ({ type, name }));
  const deletionLedgerSchemaRows = REQUIRED_DELETION_LEDGER_SCHEMA_OBJECTS.map(
    ([type, name]) => ({ type, name }),
  );
  const columnRows = Object.fromEntries(
    Object.entries(REQUIRED_COLUMNS).map(([table, columns]) => [
      table,
      columns.map((name) => ({ name })),
    ]),
  );
  if (schemaMismatch !== null) {
    const [table, column] = schemaMismatch;
    columnRows[table] = columnRows[table].filter((row) => row.name !== column);
  }
  const deletionLedgerColumnRows = Object.fromEntries(
    Object.entries(REQUIRED_DELETION_LEDGER_COLUMNS).map(([table, columns]) => [
      table,
      columns.map((name) => ({ name })),
    ]),
  );
  const spawn = (_wrangler, args) => {
    calls.push(args);
    assert.equal(args.includes("--remote"), false);
    assert.equal(args.includes("deploy"), false);
    assert.equal(args.includes("--local"), true);
    if (args.includes("migrations")) {
      return {
        status: 0,
        stdout: "provider-secret=must-not-escape",
        stderr: "provider-secret=must-not-escape",
      };
    }
    const sql = args[args.indexOf("--command") + 1];
    if (sql.includes("d1_migrations")) {
      const binding = args[2];
      const names = binding === "USAGE_MONITOR_DB"
        ? primaryMigrations
        : deletionLedgerMigrations;
      return {
        status: 0,
        stdout: jsonRows(names.map((name, index) => ({ id: index + 1, name }))),
      };
    }
    if (sql.includes("FROM collection_controls")) {
      assert.equal(/\b(?:INSERT|UPDATE|DELETE)\b/iu.test(sql), false);
      return { status: 0, stdout: jsonRows(collectionControlRows) };
    }
    if (sql.includes("sqlite_master")) {
      return {
        status: 0,
        stdout: jsonRows(args[2] === "DELETION_LEDGER"
          ? deletionLedgerSchemaRows
          : schemaRows),
      };
    }
    const table = /PRAGMA table_info\('([^']+)'\)/u.exec(sql)?.[1];
    const columns = args[2] === "DELETION_LEDGER"
      ? deletionLedgerColumnRows
      : columnRows;
    return { status: 0, stdout: jsonRows(columns[table] ?? []) };
  };
  return { calls, primaryMigrations, spawn };
}

test("disabled enrollment config is required and reports booleans only", () => {
  const config = safeConfig();
  assert.deepEqual(assessDisabledEnrollmentConfiguration(config), {
    ok: true,
    checks: {
      stagingEnrollmentDisabled: true,
      productionEnrollmentDisabled: true,
      stagingIdentityLinkSecretVersionConfigured: true,
      productionIdentityLinkSecretVersionConfigured: true,
    },
    blockers: [],
  });
  config.env.staging.vars.ENROLLMENT_MODE = "local_open";
  const blocked = assessDisabledEnrollmentConfiguration(config);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blockers, ["CONFIG_STAGING_ENROLLMENT_DISABLED"]);
  assert.equal(typeof blocked.checks.stagingEnrollmentDisabled, "boolean");
  delete config.env.production.vars.IDENTITY_LINK_SECRET_VERSION;
  const missingVersion = assessDisabledEnrollmentConfiguration(config);
  assert.equal(missingVersion.ok, false);
  assert.deepEqual(missingVersion.blockers, [
    "CONFIG_STAGING_ENROLLMENT_DISABLED",
    "CONFIG_PRODUCTION_IDENTITY_LINK_SECRET_VERSION_CONFIGURED",
  ]);
});

test("release preflight applies both local migration streams, checks schema, and cleans state", async () => {
  const { calls, primaryMigrations, spawn } = await standardFixture();
  let statePath = null;
  const result = await runReleasePreflight({
    config: safeConfig(),
    workerDirectory,
    wrangler: "fake-wrangler",
    spawn,
    createState: async () => {
      statePath = await disposableState();
      return statePath;
    },
    cleanupState: removeState,
  });
  assert.equal(result.state, "ready");
  assert.equal(result.collectionAuthorized, false);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.checks.primaryMigrationsAppliedInOrder, true);
  assert.equal(result.checks.deletionLedgerMigrationsAppliedInOrder, true);
  assert.equal(result.checks.localMigrationInventorySafe, true);
  assert.equal(result.checks.localMigrationSourcesSafe, true);
  assert.equal(result.checks.primaryMigrationRerunStable, true);
  assert.equal(result.checks.deletionLedgerMigrationRerunStable, true);
  assert.equal(result.checks.requiredSchemaPresent, true);
  assert.equal(result.checks.deletionLedgerSchemaPresent, true);
  assert.equal(result.checks.collectionControlsCoherent, true);
  assert.equal(result.checks.isolatedStateCleaned, true);
  assert.equal(result.evidence.migrationWindow, "0023-0029");
  assert.ok(statePath);
  await assert.rejects(access(statePath));
  assert.equal(calls.filter((args) => args.includes("migrations")).length, 4);
  assert.equal(
    REQUIRED_PRIMARY_MIGRATIONS.every((name) => primaryMigrations.includes(name)),
    true,
  );
});

test("migration source preflight rejects missing, malformed, and transaction-owning inputs", () => {
  const inventory = {
    USAGE_MONITOR_DB: [...EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB],
    DELETION_LEDGER: [...EXPECTED_STAGING_MIGRATIONS.DELETION_LEDGER],
  };
  assert.deepEqual(validateMigrationInventory(inventory), { ok: true, code: null });

  const missing = structuredClone(inventory);
  missing.USAGE_MONITOR_DB.splice(1, 1);
  assert.deepEqual(validateMigrationInventory(missing), {
    ok: false,
    code: "LOCAL_MIGRATION_INVENTORY_DRIFT",
  });

  const malformedName = structuredClone(inventory);
  const nonceIndex = malformedName.USAGE_MONITOR_DB.findIndex((name) =>
    name.startsWith("0024_"));
  malformedName.USAGE_MONITOR_DB[nonceIndex] = "0024-apple-signin.sql";
  assert.deepEqual(validateMigrationInventory(malformedName), {
    ok: false,
    code: "LOCAL_MIGRATION_INVENTORY_DRIFT",
  });

  assert.deepEqual(validateMigrationSource(
    "0024_apple_signin_nonce_binding.sql",
    "CREATE TABLE example (id INTEGER);\n",
  ), { ok: true, code: null });
  assert.deepEqual(validateMigrationSource(
    "0024_apple_signin_nonce_binding.sql",
    "CREATE TABLE example (id INTEGER);",
  ), { ok: false, code: "LOCAL_MIGRATION_SOURCE_FORMAT_INVALID" });
  assert.deepEqual(validateMigrationSource(
    "0024_apple_signin_nonce_binding.sql",
    "BEGIN;\nCREATE TABLE example (id INTEGER);\nCOMMIT;\n",
  ), {
    ok: false,
    code: "LOCAL_MIGRATION_TRANSACTION_CONTROL_UNSUPPORTED",
  });
});

for (const [label, bundle] of [
  ["missing migration", {
    ok: false,
    code: "LOCAL_MIGRATION_INVENTORY_DRIFT",
    names: [],
  }],
  ["malformed migration source", {
    ok: false,
    code: "LOCAL_MIGRATION_SOURCE_FORMAT_INVALID",
    names: [...EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB],
  }],
]) {
  test(`invalid ${label} stops before any local migration command`, async () => {
    let called = false;
    const result = await runReleasePreflight({
      config: safeConfig(),
      workerDirectory,
      wrangler: "fake-wrangler",
      spawn: () => {
        called = true;
        return { status: 0, stdout: "must-not-run", stderr: "" };
      },
      readMigrations: async () => ({
        USAGE_MONITOR_DB: bundle,
        DELETION_LEDGER: {
          ok: true,
          code: null,
          names: [...EXPECTED_STAGING_MIGRATIONS.DELETION_LEDGER],
        },
      }),
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.blockers.includes(bundle.code), true);
    assert.equal(called, false);
  });
}

// An operational controls row passes: under the migration-gate governance
// (docs/governance/2026-08-07-production-deploy-migration-gate.md) the
// rehearsal proves the migrated row is COHERENT, not that intake is closed.
test("release preflight accepts operational collection controls as coherent", async () => {
  const { spawn } = await standardFixture({
    collectionControlRows: [{
      ...containedCollectionControlRow(),
      enrollment_enabled: 1,
      upload_registration_enabled: 1,
      processing_enabled: 1,
      publication_enabled: 1,
      control_state: "operational",
    }],
  });
  const result = await runReleasePreflight({
    config: safeConfig(),
    workerDirectory,
    wrangler: "fake-wrangler",
    spawn,
    createState: disposableState,
    cleanupState: removeState,
  });
  assert.equal(result.state, "ready");
  assert.equal(result.checks.collectionControlsCoherent, true);
  assert.deepEqual(result.blockers, []);
});

for (const [label, collectionControlRows, blocker] of [
  ["missing", [], "LOCAL_COLLECTION_CONTROLS_MISSING"],
  ["malformed", [{
    ...containedCollectionControlRow(),
    schema_version: "wrong-schema",
  }], "LOCAL_COLLECTION_CONTROLS_INVALID"],
]) {
  test(`release preflight blocks ${label} collection controls without release-ready evidence`, async () => {
    const { spawn } = await standardFixture({ collectionControlRows });
    const result = await runReleasePreflight({
      config: safeConfig(),
      workerDirectory,
      wrangler: "fake-wrangler",
      spawn,
      createState: disposableState,
      cleanupState: removeState,
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.collectionAuthorized, false);
    assert.equal(result.checks.collectionControlsCoherent, false);
    assert.deepEqual(result.blockers, [blocker]);
    assert.equal(JSON.stringify(result).includes('"state":"ready"'), false);
    assert.equal(JSON.stringify(result).includes("release-ready"), false);
  });
}

test("release preflight blocks a missing community schema invariant", async () => {
  const { spawn } = await standardFixture({
    schemaMismatch: ["community_snapshot_policy", "account_tool_units_cap"],
  });
  const result = await runReleasePreflight({
    config: safeConfig(),
    workerDirectory,
    wrangler: "fake-wrangler",
    spawn,
    createState: disposableState,
    cleanupState: removeState,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.checks.requiredSchemaPresent, false);
  assert.deepEqual(result.blockers, ["LOCAL_SCHEMA_INCOMPLETE"]);
  assert.equal(result.collectionAuthorized, false);
});

test("migration failure is content-free, local-only, and still cleans isolated state", async () => {
  let cleanupCalled = false;
  const result = await runReleasePreflight({
    config: safeConfig(),
    workerDirectory,
    wrangler: "fake-wrangler",
    spawn: () => ({
      status: 1,
      stdout: "secret-value",
      stderr: "secret-value",
    }),
    createState: disposableState,
    cleanupState: async (state) => {
      cleanupCalled = true;
      return removeState(state);
    },
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.collectionAuthorized, false);
  assert.deepEqual(result.blockers, ["LOCAL_PRIMARY_MIGRATION_FAILED"]);
  assert.equal(result.checks.isolatedStateCleaned, true);
  assert.equal(cleanupCalled, true);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});

test("missing deletion-ledger schema blocks the gate with a separate blocker", async () => {
  const primaryMigrations = await migrationNames("migrations");
  const deletionLedgerMigrations = await migrationNames("deletion-ledger-migrations");
  const spawn = (_wrangler, args) => {
    if (args.includes("migrations")) return { status: 0, stdout: "" };
    const sql = args[args.indexOf("--command") + 1];
    if (sql.includes("d1_migrations")) {
      const names = args[2] === "USAGE_MONITOR_DB"
        ? primaryMigrations
        : deletionLedgerMigrations;
      return {
        status: 0,
        stdout: jsonRows(names.map((name, index) => ({ id: index + 1, name }))),
      };
    }
    if (sql.includes("FROM collection_controls")) {
      return { status: 0, stdout: jsonRows([containedCollectionControlRow()]) };
    }
    if (sql.includes("sqlite_master")) {
      return {
        status: 0,
        stdout: jsonRows(args[2] === "DELETION_LEDGER"
          ? []
          : REQUIRED_SCHEMA_OBJECTS.map(([type, name]) => ({ type, name }))),
      };
    }
    const table = /PRAGMA table_info\('([^']+)'\)/u.exec(sql)?.[1];
    const columns = args[2] === "DELETION_LEDGER"
      ? REQUIRED_DELETION_LEDGER_COLUMNS
      : REQUIRED_COLUMNS;
    return {
      status: 0,
      stdout: jsonRows((columns[table] ?? []).map((name) => ({ name }))),
    };
  };
  const result = await runReleasePreflight({
    config: safeConfig(),
    workerDirectory,
    wrangler: "fake-wrangler",
    spawn,
    createState: disposableState,
    cleanupState: removeState,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.checks.primaryMigrationsAppliedInOrder, true);
  assert.equal(result.checks.deletionLedgerMigrationsAppliedInOrder, true);
  assert.equal(result.checks.requiredSchemaPresent, true);
  assert.equal(result.checks.deletionLedgerSchemaPresent, false);
  assert.deepEqual(result.blockers, ["LOCAL_DELETION_LEDGER_SCHEMA_INCOMPLETE"]);
  assert.equal(result.collectionAuthorized, false);
  assert.equal(result.checks.isolatedStateCleaned, true);
});

test("real Wrangler proves both local D1 streams, schema, and controls coherence query", async () => {
  const root = await mkdtemp(join(
    tmpdir(),
    "usage-monitor-release-preflight-real-wrangler-",
  ));
  let statePath = null;
  const commands = [];
  const migrationRows = new Map();
  const schemaRows = new Map();
  let collectionRows = null;
  try {
    const { config, configPath } = await writeHermeticWranglerConfig(root);
    const hermeticEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        !/^(?:CLOUDFLARE_|CF_|WRANGLER_(?!SEND_METRICS$))/u.test(name)),
    );
    hermeticEnv.CI = "1";
    hermeticEnv.WRANGLER_SEND_METRICS = "false";
    const spawn = (command, args, options) => {
      assert.equal(command, localWrangler);
      assert.equal(args.includes("--local"), true);
      assert.equal(args.includes("--remote"), false);
      assert.equal(args.includes("deploy"), false);
      assert.equal(args[args.indexOf("--config") + 1], configPath);
      assert.equal(args[args.indexOf("--env") + 1], "staging");
      const persistIndex = args.indexOf("--persist-to");
      assert.notEqual(persistIndex, -1);
      assert.equal(args[persistIndex + 1], statePath);
      const result = spawnSync(command, args, {
        ...options,
        env: hermeticEnv,
      });
      const commandIndex = args.indexOf("--command");
      const sql = commandIndex < 0 ? null : args[commandIndex + 1] ?? null;
      const rows = sql === null ? null : rowsFromWrangler(result.stdout);
      const binding = args[args.indexOf("execute") + 1] ?? null;
      if (sql?.includes("d1_migrations") && binding !== null) {
        const rowsForBinding = migrationRows.get(binding) ?? [];
        rowsForBinding.push(rows);
        migrationRows.set(binding, rowsForBinding);
      }
      if (sql?.includes("sqlite_master") && binding !== null) {
        schemaRows.set(binding, rows);
      }
      if (sql?.includes("FROM collection_controls")) {
        collectionRows = rows;
      }
      commands.push({ args, binding, result, sql });
      return result;
    };
    const createState = async () => {
      statePath = join(root, "persist");
      await mkdir(statePath, { recursive: true });
      await chmod(statePath, 0o700);
      return statePath;
    };
    const result = await runReleasePreflight({
      config,
      configPath,
      workerDirectory,
      wrangler: localWrangler,
      spawn,
      createState,
      cleanupState: removeState,
    });

    // Freshly migrated databases seed an operational controls row; that is a
    // coherent, passing outcome under the migration-gate governance
    // (docs/governance/2026-08-07-production-deploy-migration-gate.md).
    assert.equal(result.state, "ready");
    assert.equal(result.collectionAuthorized, false);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.checks.localOnly, true);
    assert.equal(result.checks.localMigrationInventorySafe, true);
    assert.equal(result.checks.localMigrationSourcesSafe, true);
    assert.equal(result.checks.primaryMigrationsAppliedInOrder, true);
    assert.equal(result.checks.deletionLedgerMigrationsAppliedInOrder, true);
    assert.equal(result.checks.primaryMigrationRerunStable, true);
    assert.equal(result.checks.deletionLedgerMigrationRerunStable, true);
    assert.equal(result.checks.requiredSchemaPresent, true);
    assert.equal(result.checks.deletionLedgerSchemaPresent, true);
    assert.equal(result.checks.collectionControlsCoherent, true);
    assert.equal(result.checks.isolatedStateCleaned, true);
    assert.ok(statePath);
    await assert.rejects(access(statePath), (error) => error?.code === "ENOENT");

    const primaryMigrations = await migrationNames("migrations");
    const deletionLedgerMigrations = await migrationNames("deletion-ledger-migrations");
    assert.deepEqual(
      migrationRows.get("USAGE_MONITOR_DB")?.map((rows) =>
        rows?.map((row) => `${row?.id}:${row?.name}`)),
      [primaryMigrations, primaryMigrations].map((names) =>
        names.map((name, index) => `${index + 1}:${name}`)),
    );
    assert.deepEqual(
      migrationRows.get("DELETION_LEDGER")?.map((rows) =>
        rows?.map((row) => `${row?.id}:${row?.name}`)),
      [deletionLedgerMigrations, deletionLedgerMigrations].map((names) =>
        names.map((name, index) => `${index + 1}:${name}`)),
    );

    const primarySchema = schemaObjectSet(schemaRows.get("USAGE_MONITOR_DB"));
    for (const [type, name] of REQUIRED_SCHEMA_OBJECTS) {
      assert.equal(primarySchema.has(`${type}:${name}`), true, `${type}:${name}`);
    }
    const deletionLedgerSchema = schemaObjectSet(
      schemaRows.get("DELETION_LEDGER"),
    );
    for (const [type, name] of REQUIRED_DELETION_LEDGER_SCHEMA_OBJECTS) {
      assert.equal(
        deletionLedgerSchema.has(`${type}:${name}`),
        true,
        `DELETION_LEDGER ${type}:${name}`,
      );
    }

    assert.equal(collectionRows?.length, 1);
    assert.equal(collectionRows?.[0]?.control_state, "operational");
    assert.deepEqual([
      collectionRows?.[0]?.enrollment_enabled,
      collectionRows?.[0]?.upload_registration_enabled,
      collectionRows?.[0]?.processing_enabled,
      collectionRows?.[0]?.publication_enabled,
    ], [1, 1, 1, 1]);
    const collectionQueries = commands.filter(({ sql }) =>
      sql?.includes("FROM collection_controls"));
    assert.equal(collectionQueries.length, 1);
    assert.doesNotMatch(collectionQueries[0].sql, /\b(?:INSERT|UPDATE|DELETE)\b/iu);

    const migrationCommands = commands.filter(({ args }) => args.includes("migrations"));
    assert.deepEqual(
      migrationCommands.map(({ args }) => args[args.indexOf("apply") + 1]),
      [
        "USAGE_MONITOR_DB",
        "USAGE_MONITOR_DB",
        "DELETION_LEDGER",
        "DELETION_LEDGER",
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
