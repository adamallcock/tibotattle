import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import {
  probeStagingLive,
  REQUIRED_D1_BINDINGS,
  STAGING_PROOF_TYPES,
  stagingOperationReceipt,
} from "./staging-readiness-lib.mjs";

export const PREPARE_CONFIRMATION = "PREPARE_DISABLED_STAGING";

function run(spawn, wrangler, workerDirectory, args) {
  try {
    const result = spawn(wrangler, args, {
      cwd: workerDirectory,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

export function prepareDisabledStaging({
  config,
  confirmation,
  wrangler,
  workerDirectory,
  spawn = spawnSync,
}) {
  if (confirmation !== PREPARE_CONFIRMATION) {
    return { ok: false, code: "CONFIRMATION_REQUIRED" };
  }
  let before;
  try {
    before = probeStagingLive({
      config,
      wrangler,
      workerDirectory,
      spawn,
    });
  } catch {
    return { ok: false, code: "STAGING_READINESS_FAILED" };
  }
  const infrastructureReady = before.checks.authenticated
    && before.checks.resourceIdentifiersConfigured
    && before.checks.d1ServiceReachable
    && before.checks.r2ServiceReachable
    && before.checks.d1ResourcesExist
    && before.checks.r2ResourceExists;
  const migrationPreflightBlockers = before.blockers.filter((code) =>
    ![
      "REMOTE_MIGRATIONS_PENDING",
      "REMOTE_MIGRATION_STATE_UNINITIALIZED",
      "REMOTE_COLLECTION_NOT_CONTAINED",
      "REQUIRED_STAGING_SECRETS_MISSING",
    ].includes(code));
  if (before.state === "unsafe_configuration"
      || !infrastructureReady
      || migrationPreflightBlockers.length > 0) {
    return {
      ok: false,
      code: "STAGING_INFRASTRUCTURE_BLOCKED",
      blockers: migrationPreflightBlockers,
    };
  }

  for (const { binding } of REQUIRED_D1_BINDINGS) {
    if (!run(
      spawn,
      wrangler,
      workerDirectory,
      [
        "d1", "migrations", "apply", binding,
        "--remote", "--env", "staging",
      ],
    )) {
      return { ok: false, code: "STAGING_MIGRATION_FAILED" };
    }
  }

  let afterMigrations;
  try {
    afterMigrations = probeStagingLive({
      config,
      wrangler,
      workerDirectory,
      spawn,
    });
  } catch {
    return { ok: false, code: "STAGING_MIGRATIONS_UNVERIFIED" };
  }
  const migrationVerificationBlockers = afterMigrations.blockers.filter(
    (code) => ![
      "REMOTE_COLLECTION_NOT_CONTAINED",
      "REQUIRED_STAGING_SECRETS_MISSING",
    ].includes(code),
  );
  if (!afterMigrations.checks.migrationsCurrent
      || !afterMigrations.checks.pilotSchemaCurrent
      || migrationVerificationBlockers.length > 0) {
    return {
      ok: false,
      code: "STAGING_MIGRATIONS_UNVERIFIED",
      blockers: migrationVerificationBlockers.length > 0
        ? migrationVerificationBlockers
        : ["REMOTE_MIGRATIONS_PENDING"],
    };
  }

  const containmentSql = `
UPDATE collection_controls
   SET enrollment_enabled = 0,
       upload_registration_enabled = 0,
       processing_enabled = 0,
       publication_enabled = 0,
       control_state = 'contained',
       revision = revision + 1,
       reason_code = 'maintenance',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE singleton = 1;
`;
  if (!run(
    spawn,
    wrangler,
    workerDirectory,
    [
      "d1", "execute", "USAGE_MONITOR_DB",
      "--remote", "--env", "staging",
      "--command", containmentSql,
    ],
  )) {
    return { ok: false, code: "STAGING_CONTAINMENT_FAILED" };
  }

  let after;
  try {
    after = probeStagingLive({
      config,
      wrangler,
      workerDirectory,
      spawn,
    });
  } catch {
    return { ok: false, code: "STAGING_PREPARATION_UNVERIFIED" };
  }
  const remainingBlockers = after.blockers.filter(
    (code) => code !== "REQUIRED_STAGING_SECRETS_MISSING",
  );
  if (remainingBlockers.length > 0
      || !after.checks.migrationsCurrent
      || !after.checks.collectionContained) {
    return {
      ok: false,
      code: "STAGING_PREPARATION_UNVERIFIED",
      blockers: remainingBlockers,
    };
  }
  return {
    ok: true,
    code: "DISABLED_STAGING_PREPARED",
    collectionAuthorized: false,
    secretsInstalled: after.checks.requiredSecretsInstalled,
    receipt: stagingOperationReceipt("disabled_staging_prepared", {
      resourcesVerified: after.checks.d1ResourcesExist
        && after.checks.r2ResourceExists,
      staticConfigurationChecked: after.evidenceType
        === STAGING_PROOF_TYPES.LIVE_REMOTE,
      remoteReadOnlyProof: true,
      migrationInventoryCurrent: after.checks.remoteMigrationInventoryCurrent,
      migrationsCurrent: after.checks.migrationsCurrent,
      pilotSchemaCurrent: after.checks.pilotSchemaCurrent,
      collectionContained: after.checks.collectionContained,
      secretsInstalled: after.checks.requiredSecretsInstalled,
    }),
  };
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--confirm") {
    process.stderr.write(
      `Usage: prepare-disabled-staging.mjs --confirm ${PREPARE_CONFIRMATION}\n`,
    );
    process.exit(2);
  }
  const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  let result;
  try {
    const config = parse(
      await readFile(join(workerDirectory, "wrangler.jsonc"), "utf8"),
    );
    const wrangler = join(
      workerDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "wrangler.cmd" : "wrangler",
    );
    result = prepareDisabledStaging({
      config,
      confirmation: process.argv[3],
      wrangler,
      workerDirectory,
    });
  } catch {
    result = { ok: false, code: "STAGING_PREPARATION_FAILED" };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
