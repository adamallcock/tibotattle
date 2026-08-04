import assert from "node:assert/strict";
import test from "node:test";
import {
  PREPARE_CONFIRMATION,
  prepareDisabledStaging,
} from "./prepare-disabled-staging.mjs";
import {
  checkedInConfig,
  provisionedConfig,
  successSpawn,
  workerDirectory,
} from "./staging-test-fixtures.mjs";
import {
  EXPECTED_STAGING_MIGRATIONS,
  STAGING_PROOF_TYPES,
} from "./staging-readiness-lib.mjs";

const VALID_DEPLOYMENT_PROOF_CHECK = Object.freeze({
  ok: true,
  code: null,
});

test("preparation requires exact confirmation before inspection or mutation", () => {
  const calls = [];
  const result = prepareDisabledStaging({
    config: provisionedConfig(),
    confirmation: "yes",
    deploymentProofCheck: VALID_DEPLOYMENT_PROOF_CHECK,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: (_command, args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(result, { ok: false, code: "CONFIRMATION_REQUIRED" });
  assert.deepEqual(calls, []);
});

test("preparation will not mutate unprovisioned infrastructure", () => {
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined === "whoami") return { status: 0, stdout: "", stderr: "" };
    if (joined === "d1 list --json") {
      return { status: 0, stdout: "[]", stderr: "" };
    }
    if (joined === "r2 bucket list") {
      return { status: 1, stdout: "", stderr: "code: 10042" };
    }
    throw new Error(`Unexpected command: ${joined}`);
  };
  const result = prepareDisabledStaging({
    config: checkedInConfig,
    confirmation: PREPARE_CONFIRMATION,
    deploymentProofCheck: VALID_DEPLOYMENT_PROOF_CHECK,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STAGING_INFRASTRUCTURE_BLOCKED");
  assert.equal(result.blockers.includes("R2_NOT_ENABLED"), true);
  assert.equal(calls.some((args) => args.includes("apply")), false);
  assert.equal(calls.some((args) => args.includes("execute")), false);
});

test("preparation applies both migrations, contains collection, and rechecks", () => {
  const config = provisionedConfig();
  const calls = [];
  let migrationsApplied = false;
  let containmentApplied = false;
  let applyCount = 0;
  const spawn = (_command, args) => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined === "whoami") return { status: 0, stdout: "", stderr: "" };
    if (joined === "d1 list --json") {
      return {
        status: 0,
        stdout: JSON.stringify(config.env.staging.d1_databases.map((entry) => ({
          uuid: entry.database_id,
          name: entry.database_name,
        }))),
        stderr: "",
      };
    }
    if (joined === "r2 bucket list") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("r2 bucket info ")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          name: config.env.staging.r2_buckets[0].bucket_name,
        }),
        stderr: "",
      };
    }
    if (joined === "secret list --env staging --format json") {
      return {
        status: 0,
        stdout: JSON.stringify([
          { name: "ENVELOPE_PRIVATE_JWK" },
          { name: "ENVELOPE_PUBLIC_JWK" },
        ]),
        stderr: "",
      };
    }
    if (joined.includes("FROM d1_migrations")) {
      if (!migrationsApplied) {
        return {
          status: 1,
          stdout: "",
          stderr: "Error: no such table: d1_migrations",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify([{
          results: EXPECTED_STAGING_MIGRATIONS[args[2]]
            .map((name) => ({ name })),
        }]),
        stderr: "",
      };
    }
    if (joined.startsWith("d1 migrations apply ")) {
      applyCount += 1;
      if (applyCount === 2) migrationsApplied = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("d1 execute USAGE_MONITOR_DB ")
        && joined.includes("sqlite_master")) {
      return {
        status: 0,
        stdout: JSON.stringify([{
          results: [{
            admission_table: 1,
            admission_guard: 1,
            admission_counter: 1,
            quarantine_reconciliation: 1,
            lifecycle_status: 1,
            primary_cooldown_table: 1,
            primary_participant_cooldown_digest: 1,
            primary_cooldown_digest: 1,
            primary_cooldown_schema_version: 1,
            primary_cooldown_deleted_at: 1,
            primary_cooldown_retain_until: 1,
            primary_cooldown_retention_index: 1,
            primary_cooldown_retention_index_shape: 1,
            primary_cooldown_guard_trigger: 1,
            primary_identity_link_secret_configuration_table: 1,
            primary_identity_link_secret_configuration_singleton: 1,
            primary_identity_link_secret_configuration_key_version: 1,
            primary_identity_link_secret_configuration_secret_fingerprint: 1,
            primary_identity_link_secret_configuration_recorded_at: 1,
            primary_identity_link_secret_configuration_columns_exact: 1,
            primary_identity_link_secret_configuration_singleton_check: 1,
            primary_identity_link_secret_configuration_key_version_check: 1,
            primary_identity_link_secret_configuration_fingerprint_check: 1,
            primary_identity_link_secret_configuration_check_count: 1,
            primary_identity_link_secret_configuration_strict: 1,
            primary_identity_link_secret_configuration_no_extra_objects: 1,
          }],
        }]),
        stderr: "",
      };
    }
    if (joined.startsWith("d1 execute DELETION_LEDGER ")
        && joined.includes("sqlite_master")) {
      return {
        status: 0,
        stdout: JSON.stringify([{
          results: [{
            deletion_tombstone_table: 1,
            deletion_tombstone_participant_digest: 1,
            deletion_tombstone_schema_version: 1,
            deletion_tombstone_deleted_at: 1,
            deletion_tombstone_retain_until: 1,
            deletion_tombstone_retention_index: 1,
            deletion_tombstone_retention_index_shape: 1,
            deletion_cooldown_table: 1,
            deletion_cooldown_digest: 1,
            deletion_cooldown_schema_version: 1,
            deletion_cooldown_deleted_at: 1,
            deletion_cooldown_retain_until: 1,
            deletion_cooldown_retention_index: 1,
            deletion_cooldown_retention_index_shape: 1,
          }],
        }]),
        stderr: "",
      };
    }
    if (joined.startsWith("d1 execute USAGE_MONITOR_DB ")
        && args.includes("--json")) {
      return {
        status: 0,
        stdout: JSON.stringify([{
          results: [{
            schema_version: "collection-controls-v0.1",
            control_state: containmentApplied ? "contained" : "operational",
            enrollment_enabled: containmentApplied ? 0 : 1,
            upload_registration_enabled: containmentApplied ? 0 : 1,
            processing_enabled: containmentApplied ? 0 : 1,
            publication_enabled: containmentApplied ? 0 : 1,
          }],
        }]),
        stderr: "",
      };
    }
    if (joined.startsWith("d1 execute USAGE_MONITOR_DB ")) {
      containmentApplied = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected command: ${joined}`);
  };
  const result = prepareDisabledStaging({
    config,
    confirmation: PREPARE_CONFIRMATION,
    deploymentProofCheck: VALID_DEPLOYMENT_PROOF_CHECK,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn,
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "DISABLED_STAGING_PREPARED");
  assert.equal(result.collectionAuthorized, false);
  assert.equal(result.secretsInstalled, true);
  assert.equal(
    result.receipt.schemaVersion,
    "usage-monitor-staging-operation-receipt-v0.1",
  );
  assert.equal(
    result.receipt.evidenceType,
    STAGING_PROOF_TYPES.OPERATION_RECEIPT,
  );
  assert.equal(result.receipt.operation, "disabled_staging_prepared");
  assert.equal(result.receipt.activationState, "not_authorized");
  assert.equal(result.receipt.collectionAuthorized, false);
  assert.deepEqual(result.receipt.evidence, {
    resourcesVerified: true,
    staticConfigurationChecked: true,
    remoteReadOnlyProof: true,
    migrationInventoryCurrent: true,
    migrationsCurrent: true,
    pilotSchemaCurrent: true,
    primaryReenrollmentSchemaCurrent: true,
    deletionLedgerSchemaCurrent: true,
    identityProtectionSchemaCurrent: true,
    identityProtectionSchema: {
      status: "verified",
      verified: true,
      primary: {
        status: "verified",
        verified: true,
        tables: {
          identityReenrollmentCooldowns: true,
          identityLinkSecretConfiguration: true,
        },
        columns: {
          participantCooldownDigest: true,
          cooldownDigest: true,
          schemaVersion: true,
          deletedAt: true,
          retainUntil: true,
          identityLinkSecretConfigurationSingleton: true,
          identityLinkSecretConfigurationKeyVersion: true,
          identityLinkSecretConfigurationSecretFingerprint: true,
          identityLinkSecretConfigurationRecordedAt: true,
        },
        constraints: {
          identityLinkSecretConfigurationColumnsExact: true,
          identityLinkSecretConfigurationSingletonCheck: true,
          identityLinkSecretConfigurationKeyVersionCheck: true,
          identityLinkSecretConfigurationFingerprintCheck: true,
          identityLinkSecretConfigurationCheckCount: true,
          identityLinkSecretConfigurationStrict: true,
          identityLinkSecretConfigurationNoExtraObjects: true,
        },
        indexes: { retention: true, retentionShape: true },
        triggers: { reenrollmentCooldownGuard: true },
      },
      deletionLedger: {
        status: "verified",
        verified: true,
        tables: {
          deletionTombstones: true,
          identityReenrollmentCooldowns: true,
        },
        columns: {
          participantDigest: true,
          tombstoneSchemaVersion: true,
          tombstoneDeletedAt: true,
          tombstoneRetainUntil: true,
          cooldownDigest: true,
          cooldownSchemaVersion: true,
          cooldownDeletedAt: true,
          cooldownRetainUntil: true,
        },
        indexes: {
          tombstoneRetention: true,
          tombstoneRetentionShape: true,
          cooldownRetention: true,
          cooldownRetentionShape: true,
        },
      },
    },
    collectionContained: true,
    secretsInstalled: true,
  });
  assert.equal(Number.isFinite(Date.parse(result.receipt.generatedAt)), true);
  assert.equal(applyCount, 2);
  assert.equal(containmentApplied, true);
  const containmentIndex = calls.findIndex((args) =>
    args[0] === "d1"
    && args[1] === "execute"
    && args.some((value) =>
      typeof value === "string" && value.includes("UPDATE collection_controls")));
  const firstMigrationIndex = calls.findIndex((args) =>
    args[0] === "d1" && args[1] === "migrations" && args[2] === "apply");
  assert.equal(containmentIndex >= 0, true);
  assert.equal(firstMigrationIndex >= 0, true);
  assert.equal(containmentIndex < firstMigrationIndex, true);
});

test("preparation contains an existing active target before any migration", () => {
  const config = provisionedConfig();
  const calls = [];
  const result = prepareDisabledStaging({
    config,
    confirmation: PREPARE_CONFIRMATION,
    deploymentProofCheck: VALID_DEPLOYMENT_PROOF_CHECK,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: successSpawn(config, calls, {
      initialCollectionState: "operational",
    }),
  });
  assert.equal(result.ok, true);
  const containmentIndices = calls.flatMap((args, index) =>
    args.some((value) =>
      typeof value === "string" && value.includes("UPDATE collection_controls"))
      ? [index]
      : []);
  const migrationIndices = calls.flatMap((args, index) =>
    args[0] === "d1" && args[1] === "migrations" && args[2] === "apply"
      ? [index]
      : []);
  assert.deepEqual(containmentIndices.length, 1);
  assert.equal(containmentIndices[0] < migrationIndices[0], true);
});

test("preparation stops at containment failure or crash before migration", () => {
  for (const scenario of [
    { name: "failed containment", options: { containmentFailure: true } },
    { name: "crashed containment", options: { containmentCrash: true } },
    {
      name: "unverified containment",
      options: { containmentProofFailure: true },
    },
  ]) {
    const config = provisionedConfig();
    const calls = [];
    const result = prepareDisabledStaging({
      config,
      confirmation: PREPARE_CONFIRMATION,
      deploymentProofCheck: VALID_DEPLOYMENT_PROOF_CHECK,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: successSpawn(config, calls, {
        ...scenario.options,
        initialCollectionState: "operational",
      }),
    });
    assert.equal(result.ok, false, scenario.name);
    assert.equal(
      result.code,
      scenario.name === "unverified containment"
        ? "STAGING_CONTAINMENT_UNVERIFIED"
        : "STAGING_CONTAINMENT_FAILED",
      scenario.name,
    );
    assert.equal(
      calls.some((args) => args[0] === "d1" && args[1] === "migrations"),
      false,
      scenario.name,
    );
  }
});

test("fresh bootstrap stops before any migration without an operational claim", () => {
  const config = provisionedConfig();
  const calls = [];
  const result = prepareDisabledStaging({
    config,
    confirmation: PREPARE_CONFIRMATION,
    deploymentProofCheck: VALID_DEPLOYMENT_PROOF_CHECK,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: successSpawn(config, calls, { freshTarget: true }),
  });
  assert.deepEqual(result, {
    ok: false,
    code: "STAGING_FRESH_BOOTSTRAP_REQUIRES_OWNER_CONTAINMENT",
    blockers: ["OWNER_CONTAINMENT_REQUIRED_BEFORE_MIGRATIONS"],
  });
  assert.deepEqual(
    calls.filter((args) => args[0] === "d1" && args[1] === "migrations")
      .map((args) => args[3]),
    [],
  );
  assert.equal(result.receipt, undefined);
  assert.equal(result.collectionAuthorized, undefined);
});

test("preparation does not contain until applied migrations are proven exact", () => {
  const config = provisionedConfig();
  const calls = [];
  let applyCount = 0;
  const baseSpawn = successSpawn(config, calls);
  const spawn = (command, args, options) => {
    const joined = args.join(" ");
    if (joined.includes("FROM d1_migrations")) {
      calls.push(args);
      return {
        status: 0,
        stdout: JSON.stringify([{ results: [] }]),
        stderr: "",
      };
    }
    if (joined.startsWith("d1 migrations apply ")) {
      calls.push(args);
      applyCount += 1;
      return { status: 0, stdout: "", stderr: "" };
    }
    return baseSpawn(command, args, options);
  };
  const result = prepareDisabledStaging({
    config,
    confirmation: PREPARE_CONFIRMATION,
    deploymentProofCheck: VALID_DEPLOYMENT_PROOF_CHECK,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn,
  });
  assert.deepEqual(result, {
    ok: false,
    code: "STAGING_MIGRATIONS_UNVERIFIED",
    blockers: ["REMOTE_MIGRATIONS_PENDING"],
  });
  assert.equal(applyCount, 2);
  assert.equal(calls.some((args) => args.some((value) =>
    typeof value === "string" && value.includes("UPDATE collection_controls"))), false);
});

test("preparation refuses absent or invalid compatible-worker proof before migration", () => {
  for (const deploymentProofCheck of [
    { ok: false, code: "DEPLOYMENT_PROOF_REQUIRED" },
    { ok: false, code: "STAGING_DISABLED_WORKER_PROOF_MISMATCH" },
    { ok: false, code: "DEPLOYMENT_PROOF_MALFORMED" },
  ]) {
    const calls = [];
    const result = prepareDisabledStaging({
      config: provisionedConfig(),
      confirmation: PREPARE_CONFIRMATION,
      deploymentProofCheck,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: (_command, args) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(result, deploymentProofCheck);
    assert.equal(calls.some((args) => args.includes("apply")), false);
    assert.equal(calls.some((args) => args.includes("execute")), false);
  }
});

test("preparation refuses missing identity protection before any mutation", () => {
  for (const scenario of [
    {
      name: "primary re-enrollment protection",
      options: { missingPrimarySchema: true },
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
    },
    {
      name: "deletion-ledger cooldown protection",
      options: { missingDeletionLedgerSchema: true },
      blocker: "REMOTE_DELETION_LEDGER_SCHEMA_INCOMPLETE",
    },
  ]) {
    const config = provisionedConfig();
    const calls = [];
    const result = prepareDisabledStaging({
      config,
      confirmation: PREPARE_CONFIRMATION,
      deploymentProofCheck: VALID_DEPLOYMENT_PROOF_CHECK,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: successSpawn(config, calls, scenario.options),
    });
    assert.equal(result.ok, false, scenario.name);
    assert.equal(result.code, "STAGING_SCHEMA_PROTECTION_BLOCKED", scenario.name);
    assert.equal(result.blockers.includes(scenario.blocker), true, scenario.name);
    assert.equal(calls.some((args) => args.includes("apply")), false, scenario.name);
    assert.equal(
      calls.some((args) =>
        args[0] === "d1"
        && args[1] === "execute"
        && args.includes("--command")
        && !args.includes("--json")),
      false,
      scenario.name,
    );
  }
});
