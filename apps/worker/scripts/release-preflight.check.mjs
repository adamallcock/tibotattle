import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  readdir,
  rm,
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
  runReleasePreflight,
} from "./release-preflight.mjs";

const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

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

async function standardFixture({ collectionControlRows = [containedCollectionControlRow()] } = {}) {
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
  assert.equal(result.checks.requiredSchemaPresent, true);
  assert.equal(result.checks.deletionLedgerSchemaPresent, true);
  assert.equal(result.checks.collectionControlsContained, true);
  assert.equal(result.checks.isolatedStateCleaned, true);
  assert.equal(result.evidence.migrationWindow, "0023-0029");
  assert.ok(statePath);
  await assert.rejects(access(statePath));
  assert.equal(calls.filter((args) => args.includes("migrations")).length, 2);
  assert.equal(
    REQUIRED_PRIMARY_MIGRATIONS.every((name) => primaryMigrations.includes(name)),
    true,
  );
});

for (const [label, collectionControlRows, blocker] of [
  ["operational", [{
    ...containedCollectionControlRow(),
    enrollment_enabled: 1,
    upload_registration_enabled: 1,
    processing_enabled: 1,
    publication_enabled: 1,
    control_state: "operational",
  }], "LOCAL_COLLECTION_CONTROLS_NOT_CONTAINED"],
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
    assert.equal(result.checks.collectionControlsContained, false);
    assert.deepEqual(result.blockers, [blocker]);
    assert.equal(JSON.stringify(result).includes('"state":"ready"'), false);
    assert.equal(JSON.stringify(result).includes("release-ready"), false);
  });
}

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
