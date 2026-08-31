import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { EXPECTED_STAGING_MIGRATIONS } from "./staging-readiness-lib.mjs";

export const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
export const checkedInConfig = parse(
  await readFile(join(workerDirectory, "wrangler.jsonc"), "utf8"),
);

export function provisionedConfig() {
  const config = structuredClone(checkedInConfig);
  config.env.staging.d1_databases[0].database_id =
    "12345678-1234-4234-8234-1234567890ab";
  config.env.staging.d1_databases[1].database_id =
    "abcdefab-cdef-4def-8def-abcdefabcdef";
  return config;
}

export function successSpawn(
  config,
  calls,
  {
    missingPrimarySchema = false,
    missingAttributionSchema = false,
    missingDeletionLedgerSchema = false,
    primarySchemaError = false,
    deletionLedgerSchemaError = false,
    missingIdentityLinkSecretConfiguration = false,
    malformedIdentityLinkSecretConfigurationField = null,
    initialCollectionState = "contained",
    containmentFailure = false,
    containmentCrash = false,
    containmentProofFailure = false,
    migrationFailureAt = null,
    freshTarget = false,
  } = {},
) {
  let applyCount = 0;
  const appliedBindings = new Set();
  let collectionState = freshTarget ? "missing" : initialCollectionState;
  return (_command, args) => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined === "whoami") return { status: 0, stdout: "authenticated", stderr: "" };
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
      return { status: 0, stdout: "bucket list", stderr: "" };
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
          { name: "ENVELOPE_PRIVATE_JWK", type: "secret_text" },
          { name: "ENVELOPE_PUBLIC_JWK", type: "secret_text" },
        ]),
        stderr: "",
      };
    }
    if (joined.includes("FROM d1_migrations")) {
      if (freshTarget && !appliedBindings.has(args[2])) {
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
    if (joined.startsWith("d1 execute USAGE_MONITOR_DB ")
        && joined.includes("sqlite_master")) {
      if (primarySchemaError) {
        return {
          status: 1,
          stdout: "",
          stderr: "provider-secret=must-not-escape",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify([{
          results: [{
            admission_table: 1,
            admission_guard: 1,
            admission_counter: 1,
            quarantine_reconciliation: 1,
            lifecycle_status: 1,
            attribution_objects: missingAttributionSchema ? 0 : 1,
            attribution_columns: missingAttributionSchema ? 0 : 1,
            primary_cooldown_table: missingPrimarySchema ? 0 : 1,
            primary_participant_cooldown_digest: missingPrimarySchema ? 0 : 1,
            primary_cooldown_digest: missingPrimarySchema ? 0 : 1,
            primary_cooldown_schema_version: missingPrimarySchema ? 0 : 1,
            primary_cooldown_deleted_at: missingPrimarySchema ? 0 : 1,
            primary_cooldown_retain_until: missingPrimarySchema ? 0 : 1,
            primary_cooldown_retention_index: missingPrimarySchema ? 0 : 1,
            primary_cooldown_retention_index_shape: missingPrimarySchema ? 0 : 1,
            primary_cooldown_guard_trigger: missingPrimarySchema ? 0 : 1,
            primary_identity_link_secret_configuration_table:
              missingIdentityLinkSecretConfiguration ? 0 : 1,
            primary_identity_link_secret_configuration_singleton:
              missingIdentityLinkSecretConfiguration
              || malformedIdentityLinkSecretConfigurationField
                === "primary_identity_link_secret_configuration_singleton"
                ? 0 : 1,
            primary_identity_link_secret_configuration_key_version:
              missingIdentityLinkSecretConfiguration
              || malformedIdentityLinkSecretConfigurationField
                === "primary_identity_link_secret_configuration_key_version"
                ? 0 : 1,
            primary_identity_link_secret_configuration_secret_fingerprint:
              missingIdentityLinkSecretConfiguration
              || malformedIdentityLinkSecretConfigurationField
                === "primary_identity_link_secret_configuration_secret_fingerprint"
                ? 0 : 1,
            primary_identity_link_secret_configuration_recorded_at:
              missingIdentityLinkSecretConfiguration
              || malformedIdentityLinkSecretConfigurationField
                === "primary_identity_link_secret_configuration_recorded_at"
                ? 0 : 1,
            primary_identity_link_secret_configuration_columns_exact:
              missingIdentityLinkSecretConfiguration
              || malformedIdentityLinkSecretConfigurationField
                === "primary_identity_link_secret_configuration_columns_exact"
                ? 0 : 1,
            primary_identity_link_secret_configuration_singleton_check:
              missingIdentityLinkSecretConfiguration
              || malformedIdentityLinkSecretConfigurationField
                === "primary_identity_link_secret_configuration_singleton_check"
                ? 0 : 1,
            primary_identity_link_secret_configuration_key_version_check:
              missingIdentityLinkSecretConfiguration
              || malformedIdentityLinkSecretConfigurationField
                === "primary_identity_link_secret_configuration_key_version_check"
                ? 0 : 1,
            primary_identity_link_secret_configuration_fingerprint_check:
              missingIdentityLinkSecretConfiguration
              || malformedIdentityLinkSecretConfigurationField
                === "primary_identity_link_secret_configuration_fingerprint_check"
                ? 0 : 1,
            primary_identity_link_secret_configuration_check_count:
              missingIdentityLinkSecretConfiguration
              || malformedIdentityLinkSecretConfigurationField
                === "primary_identity_link_secret_configuration_check_count"
                ? 0 : 1,
            primary_identity_link_secret_configuration_strict:
              missingIdentityLinkSecretConfiguration
              || malformedIdentityLinkSecretConfigurationField
                === "primary_identity_link_secret_configuration_strict"
                ? 0 : 1,
            primary_identity_link_secret_configuration_no_extra_objects:
              missingIdentityLinkSecretConfiguration
              || malformedIdentityLinkSecretConfigurationField
                === "primary_identity_link_secret_configuration_no_extra_objects"
                ? 0 : 1,
          }],
        }]),
        stderr: "",
      };
    }
    if (joined.startsWith("d1 execute DELETION_LEDGER ")
        && joined.includes("sqlite_master")) {
      if (deletionLedgerSchemaError) {
        return {
          status: 1,
          stdout: "",
          stderr: "provider-secret=must-not-escape",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify([{
          results: [{
            deletion_tombstone_table: missingDeletionLedgerSchema ? 0 : 1,
            deletion_tombstone_participant_digest:
              missingDeletionLedgerSchema ? 0 : 1,
            deletion_tombstone_schema_version:
              missingDeletionLedgerSchema ? 0 : 1,
            deletion_tombstone_deleted_at: missingDeletionLedgerSchema ? 0 : 1,
            deletion_tombstone_retain_until:
              missingDeletionLedgerSchema ? 0 : 1,
            deletion_tombstone_retention_index:
              missingDeletionLedgerSchema ? 0 : 1,
            deletion_tombstone_retention_index_shape:
              missingDeletionLedgerSchema ? 0 : 1,
            deletion_cooldown_table: missingDeletionLedgerSchema ? 0 : 1,
            deletion_cooldown_digest: missingDeletionLedgerSchema ? 0 : 1,
            deletion_cooldown_schema_version:
              missingDeletionLedgerSchema ? 0 : 1,
            deletion_cooldown_deleted_at:
              missingDeletionLedgerSchema ? 0 : 1,
            deletion_cooldown_retain_until:
              missingDeletionLedgerSchema ? 0 : 1,
            deletion_cooldown_retention_index:
              missingDeletionLedgerSchema ? 0 : 1,
            deletion_cooldown_retention_index_shape:
              missingDeletionLedgerSchema ? 0 : 1,
          }],
        }]),
        stderr: "",
      };
    }
    if (joined.startsWith("d1 migrations apply ")) {
      applyCount += 1;
      if (migrationFailureAt === applyCount) {
        return { status: 1, stdout: "", stderr: "migration failed" };
      }
      appliedBindings.add(args[3]);
      if (freshTarget && args[3] === "USAGE_MONITOR_DB") {
        collectionState = "operational";
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("d1 execute USAGE_MONITOR_DB ")
        && args.includes("--json")) {
      if (collectionState === "missing") {
        return {
          status: 1,
          stdout: "",
          stderr: "Error: no such table: collection_controls",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify([{
          results: [{
            schema_version: "collection-controls-v0.1",
            control_state: collectionState,
            enrollment_enabled: collectionState === "contained" ? 0 : 1,
            upload_registration_enabled: collectionState === "contained" ? 0 : 1,
            processing_enabled: collectionState === "contained" ? 0 : 1,
            publication_enabled: collectionState === "contained" ? 0 : 1,
          }],
        }]),
        stderr: "",
      };
    }
    if (joined.startsWith("d1 execute USAGE_MONITOR_DB ")) {
      if (containmentCrash) throw new Error("containment crashed");
      if (containmentFailure) {
        return { status: 1, stdout: "", stderr: "containment failed" };
      }
      if (!containmentProofFailure) collectionState = "contained";
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected fake Wrangler call: ${joined}`);
  };
}
