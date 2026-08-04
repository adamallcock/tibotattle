import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";

export const RELEASE_PREFLIGHT_SCHEMA_VERSION =
  "usage-monitor-worker-release-preflight-v0.1";
export const REQUIRED_PRIMARY_MIGRATIONS = Object.freeze([
  "0023_community_aggregate_safety.sql",
  "0024_apple_signin_nonce_binding.sql",
  "0025_device_lifecycle.sql",
  "0026_signin_start_admission.sql",
  "0027_identity_reenrollment_cooldown_guard.sql",
  "0028_identity_link_secret_configuration.sql",
  "0029_sparkle_appcast_guard_nonces.sql",
]);

const DATABASES = Object.freeze([
  Object.freeze({ binding: "USAGE_MONITOR_DB", migrationsDir: "migrations" }),
  Object.freeze({
    binding: "DELETION_LEDGER",
    migrationsDir: "deletion-ledger-migrations",
  }),
]);

const IDENTITY_LINK_SECRET_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const COLLECTION_CONTROLS_SCHEMA_VERSION = "collection-controls-v0.1";
const COLLECTION_CONTROL_FLAGS = Object.freeze([
  "enrollment_enabled",
  "upload_registration_enabled",
  "processing_enabled",
  "publication_enabled",
]);

export const REQUIRED_SCHEMA_OBJECTS = Object.freeze([
  ["table", "collection_controls"],
  ["table", "apple_signin_handoffs"],
  ["table", "device_credentials"],
  ["table", "community_snapshot_policy"],
  ["table", "community_aggregate_exclusions"],
  ["table", "device_credential_rotations"],
  ["table", "device_pairing_events"],
  ["table", "sign_in_start_admission_windows"],
  ["table", "identity_reenrollment_cooldowns"],
  ["table", "identity_link_secret_configuration"],
  ["table", "sparkle_appcast_guard_nonces"],
  ["index", "community_aggregate_exclusions_participant"],
  ["index", "apple_signin_handoffs_expires_at"],
  ["index", "device_credentials_social_recheck"],
  ["index", "device_credential_rotations_retire"],
  ["index", "device_pairing_events_velocity"],
  ["index", "sign_in_start_admission_windows_retention"],
  ["index", "identity_reenrollment_cooldowns_retention"],
  ["index", "idx_sparkle_appcast_guard_nonces_expires_at"],
  ["trigger", "community_snapshot_policy_changed"],
  ["trigger", "community_snapshot_policy_no_delete"],
  ["trigger", "community_aggregate_exclusion_inserted"],
  ["trigger", "community_aggregate_exclusion_changed"],
  ["trigger", "community_aggregate_exclusion_no_delete"],
  ["trigger", "participants_identity_reenrollment_cooldown_guard"],
]);

export const REQUIRED_DELETION_LEDGER_SCHEMA_OBJECTS = Object.freeze([
  ["table", "deletion_tombstones"],
  ["table", "identity_reenrollment_cooldowns"],
  ["index", "deletion_tombstones_retention"],
  ["index", "identity_reenrollment_cooldowns_retention"],
]);

export const REQUIRED_COLUMNS = Object.freeze({
  participants: Object.freeze([
    "identity_cooldown_digest",
  ]),
  apple_signin_handoffs: Object.freeze([
    "state",
    "nonce_hash",
    "identity_link_key",
    "proof",
    "created_at",
    "expires_at",
    "delivered_at",
  ]),
  community_snapshot_policy: Object.freeze([
    "singleton_id",
    "maturity_days",
    "minimum_accepted_collection_days",
    "account_usage_events_cap",
    "account_token_components_cap",
    "account_tool_units_cap",
    "policy_revision",
    "updated_at",
    "updated_by_digest",
  ]),
  community_aggregate_exclusions: Object.freeze([
    "exclusion_id",
    "participant_id",
    "scope",
    "reason_code",
    "state",
    "effective_at",
    "expires_at",
    "created_at",
    "created_by_digest",
    "revoked_at",
    "revoked_by_digest",
  ]),
  device_credentials: Object.freeze([
    "social_verified_at",
    "credential_generation",
  ]),
  device_credential_rotations: Object.freeze([
    "id",
    "device_id",
    "participant_id",
    "prior_secret_hash",
    "replacement_secret_hash",
    "attempt_id",
    "generation",
    "rotated_at",
    "retire_at",
  ]),
  device_pairing_events: Object.freeze([
    "id",
    "pairing_id",
    "participant_id",
    "kind",
    "occurred_at",
  ]),
  sign_in_start_admission_windows: Object.freeze([
    "window_started_at",
    "accepted_count",
    "last_accepted_at",
  ]),
  identity_reenrollment_cooldowns: Object.freeze([
    "identity_cooldown_digest",
    "schema_version",
    "deleted_at",
    "retain_until",
  ]),
  identity_link_secret_configuration: Object.freeze([
    "singleton",
    "key_version",
    "secret_fingerprint",
    "recorded_at",
  ]),
});

export const REQUIRED_DELETION_LEDGER_COLUMNS = Object.freeze({
  deletion_tombstones: Object.freeze([
    "participant_digest",
    "schema_version",
    "deleted_at",
    "retain_until",
  ]),
  identity_reenrollment_cooldowns: Object.freeze([
    "identity_cooldown_digest",
    "schema_version",
    "deleted_at",
    "retain_until",
  ]),
});

function objectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function disabledEnvironment(environment, expectedName) {
  const vars = objectRecord(environment?.vars);
  return Boolean(objectRecord(environment)
    && vars?.ENVIRONMENT === expectedName
    && vars.ENROLLMENT_MODE === "disabled"
    && vars.ACCOUNT_SCOPED_INGEST_MODE === "disabled"
    && vars.UPLOAD_INGRESS_QUEUE_MODE === "disabled");
}

function configuredIdentityLinkSecretVersion(environment) {
  const value = objectRecord(environment?.vars)?.IDENTITY_LINK_SECRET_VERSION;
  return typeof value === "string" && IDENTITY_LINK_SECRET_VERSION_PATTERN.test(value);
}

export function assessDisabledEnrollmentConfiguration(config) {
  const checks = {
    stagingEnrollmentDisabled: disabledEnvironment(
      config?.env?.staging,
      "staging",
    ),
    productionEnrollmentDisabled: disabledEnvironment(
      config?.env?.production,
      "production",
    ),
    stagingIdentityLinkSecretVersionConfigured:
      configuredIdentityLinkSecretVersion(config?.env?.staging),
    productionIdentityLinkSecretVersionConfigured:
      configuredIdentityLinkSecretVersion(config?.env?.production),
  };
  const blockers = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => `CONFIG_${name.replaceAll(/([A-Z])/gu, "_$1").toUpperCase()}`);
  return {
    ok: blockers.length === 0,
    checks,
    blockers,
  };
}

function runWrangler({ wrangler, workerDirectory, configPath, args, spawn }) {
  const command = configPath === null
    ? args
    : ["--config", configPath, ...args];
  let result;
  try {
    result = spawn(wrangler, command, {
      cwd: workerDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
  return {
    ok: !result?.error && result?.status === 0,
    // Wrangler output is intentionally retained only for machine parsing and
    // is never included in the bounded receipt. This prevents a secret or a
    // provider error from crossing the release-gate output boundary.
    stdout: typeof result?.stdout === "string" ? result.stdout : "",
    stderr: typeof result?.stderr === "string" ? result.stderr : "",
  };
}

function parseRows(stdout) {
  try {
    const value = JSON.parse(stdout);
    const entries = Array.isArray(value) ? value : [];
    const result = entries.findLast((entry) => Array.isArray(entry?.results));
    return result?.results ?? null;
  } catch {
    return null;
  }
}

function migrationFiles(files) {
  return files
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right, "en"));
}

async function readMigrationNames(workerDirectory, migrationsDir) {
  const directory = join(workerDirectory, migrationsDir);
  const files = await readdir(directory, { withFileTypes: true });
  return migrationFiles(
    files.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
}

function migrationRowsMatch(rows, expected) {
  if (!Array.isArray(rows) || rows.length !== expected.length) return false;
  return rows.every((row, index) => (
    Number(row?.id) === index + 1
    && row?.name === expected[index]
  ));
}

function runQuery({
  wrangler,
  workerDirectory,
  configPath,
  stateDirectory,
  binding,
  sql,
  spawn,
}) {
  const result = runWrangler({
    wrangler,
    workerDirectory,
    configPath,
    spawn,
    args: [
      "d1",
      "execute",
      binding,
      "--local",
      "--env",
      "staging",
      "--persist-to",
      stateDirectory,
      "--command",
      sql,
      "--json",
    ],
  });
  if (!result.ok) return null;
  return parseRows(result.stdout);
}

function schemaObjectNames(rows) {
  return new Set(
    (Array.isArray(rows) ? rows : [])
      .filter((row) => typeof row?.type === "string" && typeof row?.name === "string")
      .map((row) => `${row.type}:${row.name}`),
  );
}

function hasColumns(rows, expected) {
  const actual = new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => row?.name)
      .filter((name) => typeof name === "string"),
  );
  return expected.every((name) => actual.has(name));
}

function collectionControlProbeState(rows) {
  if (!Array.isArray(rows)) return "unavailable";
  if (rows.length === 0) return "missing";
  if (rows.length !== 1) return "invalid";
  const row = rows[0];
  if (row?.singleton !== 1
      || row.schema_version !== COLLECTION_CONTROLS_SCHEMA_VERSION
      || !COLLECTION_CONTROL_FLAGS.every((field) => row[field] === 0 || row[field] === 1)
      || !["operational", "degraded", "contained"].includes(row.control_state)
      || !Number.isSafeInteger(row.revision)
      || row.revision < 1) {
    return "invalid";
  }
  const enabledCount = COLLECTION_CONTROL_FLAGS
    .filter((field) => row[field] === 1)
    .length;
  if ((row.control_state === "operational" && enabledCount !== 4)
      || (row.control_state === "contained" && enabledCount !== 0)
      || (row.control_state === "degraded"
        && (enabledCount === 0 || enabledCount === 4))) {
    return "invalid";
  }
  return row.control_state === "contained" ? "contained" : "uncontained";
}

function collectionControlBlocker(state) {
  switch (state) {
    case "missing":
      return "LOCAL_COLLECTION_CONTROLS_MISSING";
    case "uncontained":
      return "LOCAL_COLLECTION_CONTROLS_NOT_CONTAINED";
    case "unavailable":
      return "LOCAL_COLLECTION_CONTROLS_UNAVAILABLE";
    default:
      return "LOCAL_COLLECTION_CONTROLS_INVALID";
  }
}

function validOwnerOnlyDirectory(metadata) {
  return metadata.isDirectory()
    && !metadata.isSymbolicLink()
    && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
}

async function createOwnerOnlyState() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "usage-monitor-release-preflight-"));
  await chmod(stateDirectory, 0o700);
  const metadata = await lstat(stateDirectory);
  if (!validOwnerOnlyDirectory(metadata)) {
    throw new Error("unsafe release preflight state directory");
  }
  return stateDirectory;
}

async function cleanupOwnerOnlyState(stateDirectory) {
  try {
    const metadata = await lstat(stateDirectory);
    if (!validOwnerOnlyDirectory(metadata)) return false;
    await rm(stateDirectory, { recursive: true, force: true });
    await access(stateDirectory);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function baseReceipt(configChecks) {
  return {
    schemaVersion: RELEASE_PREFLIGHT_SCHEMA_VERSION,
    state: "blocked",
    environment: "staging",
    collectionAuthorized: false,
    checks: {
      disabledEnrollmentConfiguration: configChecks.ok,
      primaryMigrationsAppliedInOrder: false,
      deletionLedgerMigrationsAppliedInOrder: false,
      requiredSchemaPresent: false,
      deletionLedgerSchemaPresent: false,
      collectionControlsContained: false,
      localOnly: true,
      isolatedStateCleaned: false,
    },
    blockers: [...configChecks.blockers],
    evidence: {
      migrationWindow: "0023-0029",
      database: "USAGE_MONITOR_DB",
      rollbackRestoreEquivalent: "isolated_cleanup",
    },
  };
}

/**
 * Run the release gate against disposable local D1 state. The only Wrangler
 * operations used here carry --local and a generated --persist-to directory;
 * no caller-controlled command or remote/deploy flag is accepted.
 */
export async function runReleasePreflight({
  config,
  configPath = null,
  workerDirectory,
  wrangler,
  spawn = spawnSync,
  createState = createOwnerOnlyState,
  cleanupState = cleanupOwnerOnlyState,
} = {}) {
  const configuration = assessDisabledEnrollmentConfiguration(config);
  const receipt = baseReceipt(configuration);
  if (!configuration.ok) return receipt;

  let stateDirectory = null;
  let cleanupOk = false;
  try {
    const migrationNames = await Promise.all(
      DATABASES.map(({ migrationsDir }) =>
        readMigrationNames(workerDirectory, migrationsDir)),
    );
    stateDirectory = await createState();
    const metadata = await lstat(stateDirectory);
    if (!validOwnerOnlyDirectory(metadata)) {
      receipt.blockers.push("LOCAL_STATE_DIRECTORY_UNSAFE");
    } else {
      const applied = [];
      let migrationFailed = false;
      for (const [index, database] of DATABASES.entries()) {
        const migration = runWrangler({
          wrangler,
          workerDirectory,
          configPath,
          spawn,
          args: [
            "d1",
            "migrations",
            "apply",
            database.binding,
            "--local",
            "--env",
            "staging",
            "--persist-to",
            stateDirectory,
          ],
        });
        if (!migration.ok) {
          receipt.blockers.push(
            index === 0
              ? "LOCAL_PRIMARY_MIGRATION_FAILED"
              : "LOCAL_DELETION_LEDGER_MIGRATION_FAILED",
          );
          migrationFailed = true;
          break;
        }
        const rows = runQuery({
          wrangler,
          workerDirectory,
          configPath,
          stateDirectory,
          binding: database.binding,
          spawn,
          sql: "SELECT id, name FROM d1_migrations ORDER BY id",
        });
        applied.push(migrationRowsMatch(rows, migrationNames[index]));
      }
      if (!migrationFailed) {
        receipt.checks.primaryMigrationsAppliedInOrder = applied[0] === true
          && migrationNames[0].some((name) =>
            REQUIRED_PRIMARY_MIGRATIONS.includes(name))
          && REQUIRED_PRIMARY_MIGRATIONS.every((name) =>
            migrationNames[0].includes(name));
        receipt.checks.deletionLedgerMigrationsAppliedInOrder = applied[1] === true
          && migrationNames[1].length > 0;
        if (!receipt.checks.primaryMigrationsAppliedInOrder) {
          receipt.blockers.push("LOCAL_PRIMARY_MIGRATION_ORDER_INVALID");
        }
        if (!receipt.checks.deletionLedgerMigrationsAppliedInOrder) {
          receipt.blockers.push("LOCAL_DELETION_LEDGER_MIGRATION_ORDER_INVALID");
        }
      }
    }
    if (receipt.blockers.length === 0) {
      const objects = runQuery({
        wrangler,
        workerDirectory,
        configPath,
        stateDirectory,
        binding: "USAGE_MONITOR_DB",
        spawn,
        sql: "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY type, name",
      });
      const objectNames = schemaObjectNames(objects);
      const objectsPresent = REQUIRED_SCHEMA_OBJECTS.every(([type, name]) =>
        objectNames.has(`${type}:${name}`));
      const columnsPresent = await Promise.all(
        Object.entries(REQUIRED_COLUMNS).map(async ([table, columns]) => {
          const rows = runQuery({
            wrangler,
            workerDirectory,
            configPath,
            stateDirectory,
            binding: "USAGE_MONITOR_DB",
            spawn,
            sql: `PRAGMA table_info('${table}')`,
          });
          return hasColumns(rows, columns);
        }),
      );
      receipt.checks.requiredSchemaPresent = objectsPresent
        && columnsPresent.every(Boolean);
      if (!receipt.checks.requiredSchemaPresent) {
        receipt.blockers.push("LOCAL_SCHEMA_INCOMPLETE");
      }

      // This probe is intentionally read-only. Preflight never repairs or
      // contains the singleton to make the local gate pass.
      const collectionControls = runQuery({
        wrangler,
        workerDirectory,
        configPath,
        stateDirectory,
        binding: "USAGE_MONITOR_DB",
        spawn,
        sql: `
SELECT singleton,
       schema_version,
       enrollment_enabled,
       upload_registration_enabled,
       processing_enabled,
       publication_enabled,
       control_state,
       revision
  FROM collection_controls
 WHERE singleton = 1
`,
      });
      const collectionControlState = collectionControlProbeState(collectionControls);
      receipt.checks.collectionControlsContained = collectionControlState === "contained";
      if (!receipt.checks.collectionControlsContained) {
        receipt.blockers.push(collectionControlBlocker(collectionControlState));
      }

      const deletionLedgerObjects = runQuery({
        wrangler,
        workerDirectory,
        configPath,
        stateDirectory,
        binding: "DELETION_LEDGER",
        spawn,
        sql: "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY type, name",
      });
      const deletionLedgerObjectNames = schemaObjectNames(deletionLedgerObjects);
      const deletionLedgerObjectsPresent =
        REQUIRED_DELETION_LEDGER_SCHEMA_OBJECTS.every(([type, name]) =>
          deletionLedgerObjectNames.has(`${type}:${name}`));
      const deletionLedgerColumnsPresent = await Promise.all(
        Object.entries(REQUIRED_DELETION_LEDGER_COLUMNS).map(async ([table, columns]) => {
          const rows = runQuery({
            wrangler,
            workerDirectory,
            configPath,
            stateDirectory,
            binding: "DELETION_LEDGER",
            spawn,
            sql: `PRAGMA table_info('${table}')`,
          });
          return hasColumns(rows, columns);
        }),
      );
      receipt.checks.deletionLedgerSchemaPresent = deletionLedgerObjectsPresent
        && deletionLedgerColumnsPresent.every(Boolean);
      if (!receipt.checks.deletionLedgerSchemaPresent) {
        receipt.blockers.push("LOCAL_DELETION_LEDGER_SCHEMA_INCOMPLETE");
      }
    }
  } catch {
    receipt.blockers.push("LOCAL_RELEASE_PREFLIGHT_FAILED");
  } finally {
    if (stateDirectory !== null) {
      try {
        cleanupOk = await cleanupState(stateDirectory);
      } catch {
        cleanupOk = false;
      }
    }
  }
  receipt.checks.isolatedStateCleaned = cleanupOk;
  if (!cleanupOk) receipt.blockers.push("LOCAL_STATE_CLEANUP_FAILED");
  receipt.blockers = [...new Set(receipt.blockers)];
  receipt.state = receipt.blockers.length === 0 ? "ready" : "blocked";
  return receipt;
}

function usageError(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: release-preflight.mjs [--config /path/to/wrangler.jsonc]\n",
  );
  process.exit(2);
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usageError(`${name} requires a value`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const known = new Set(["--config"]);
  for (let index = 0; index < args.length; index += 1) {
    if (!known.has(args[index])) usageError("An unsupported option was supplied");
    index += 1;
  }
  const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  const configPath = resolve(optionValue(args, "--config")
    ?? join(workerDirectory, "wrangler.jsonc"));
  const parseErrors = [];
  let config;
  try {
    config = parse(
      await readFile(configPath, "utf8"),
      parseErrors,
      { allowTrailingComma: true, disallowComments: false },
    );
  } catch {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: RELEASE_PREFLIGHT_SCHEMA_VERSION,
      state: "blocked",
      environment: "staging",
      collectionAuthorized: false,
      checks: { localOnly: true, isolatedStateCleaned: false },
      blockers: ["WRANGLER_CONFIGURATION_UNREADABLE"],
    })}\n`);
    process.exit(1);
  }
  if (parseErrors.length > 0 || objectRecord(config) === null) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: RELEASE_PREFLIGHT_SCHEMA_VERSION,
      state: "blocked",
      environment: "staging",
      collectionAuthorized: false,
      checks: { localOnly: true, isolatedStateCleaned: false },
      blockers: ["WRANGLER_CONFIGURATION_INVALID"],
      parseError: printParseErrorCode(parseErrors[0]?.error ?? 0),
    })}\n`);
    process.exit(1);
  }
  const wrangler = join(
    workerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const result = await runReleasePreflight({
    config,
    configPath,
    workerDirectory,
    wrangler,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.state === "ready" ? 0 : 1);
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
