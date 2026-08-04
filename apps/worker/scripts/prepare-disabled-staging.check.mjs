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

test("preparation requires exact confirmation before inspection or mutation", () => {
  const calls = [];
  const result = prepareDisabledStaging({
    config: provisionedConfig(),
    confirmation: "yes",
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
    if (joined.startsWith("d1 migrations list ")) {
      return {
        status: 0,
        stdout: migrationsApplied
          ? "No migrations to apply!"
          : "Migrations to be applied",
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
  assert.equal(result.receipt.operation, "disabled_staging_prepared");
  assert.equal(result.receipt.activationState, "not_authorized");
  assert.equal(result.receipt.collectionAuthorized, false);
  assert.deepEqual(result.receipt.evidence, {
    resourcesVerified: true,
    migrationsCurrent: true,
    pilotSchemaCurrent: true,
    identityProtectionSchemaCurrent: true,
    identityProtectionSchema: {
      status: "verified",
      verified: true,
      primary: {
        status: "verified",
        verified: true,
        tables: { identityReenrollmentCooldowns: true },
        columns: {
          participantCooldownDigest: true,
          cooldownDigest: true,
          schemaVersion: true,
          deletedAt: true,
          retainUntil: true,
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
