import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import {
  identityProtectionSchemaVerified,
  probeStagingLive,
  REQUIRED_D1_BINDINGS,
  stagingOperationReceipt,
} from "./staging-readiness-lib.mjs";

export const PREPARE_CONFIRMATION = "PREPARE_DISABLED_STAGING";

function run(spawn, wrangler, workerDirectory, args) {
  const result = spawn(wrangler, args, {
    cwd: workerDirectory,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return !result.error && result.status === 0;
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
  const before = probeStagingLive({
    config,
    wrangler,
    workerDirectory,
    spawn,
  });
  const infrastructureReady = before.checks.authenticated
    && before.checks.resourceIdentifiersConfigured
    && before.checks.d1ServiceReachable
    && before.checks.r2ServiceReachable
    && before.checks.d1ResourcesExist
    && before.checks.r2ResourceExists;
  if (before.state === "unsafe_configuration" || !infrastructureReady) {
    return {
      ok: false,
      code: "STAGING_INFRASTRUCTURE_BLOCKED",
      blockers: before.blockers.filter((code) =>
        !["REMOTE_MIGRATIONS_PENDING", "REMOTE_COLLECTION_NOT_CONTAINED"]
          .includes(code)),
    };
  }
  if (before.checks.migrationsCurrent
      && !identityProtectionSchemaVerified(before)) {
    const schemaBlockers = before.blockers.filter((code) =>
      code.startsWith("REMOTE_IDENTITY_REENROLLMENT_SCHEMA_")
      || code.startsWith("REMOTE_DELETION_LEDGER_SCHEMA_"));
    return {
      ok: false,
      code: "STAGING_SCHEMA_PROTECTION_BLOCKED",
      blockers: schemaBlockers.length > 0
        ? schemaBlockers
        : ["REMOTE_IDENTITY_PROTECTION_SCHEMA_UNVERIFIED"],
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

  const after = probeStagingLive({
    config,
    wrangler,
    workerDirectory,
    spawn,
  });
  const remainingBlockers = after.blockers.filter(
    (code) => code !== "REQUIRED_STAGING_SECRETS_MISSING",
  );
  if (remainingBlockers.length > 0
      || !after.checks.migrationsCurrent
      || !after.checks.collectionContained
      || !identityProtectionSchemaVerified(after)) {
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
      migrationsCurrent: after.checks.migrationsCurrent,
      pilotSchemaCurrent: after.checks.pilotSchemaCurrent,
      identityProtectionSchemaCurrent:
        after.checks.identityProtectionSchemaCurrent,
      identityProtectionSchema: after.evidence.identityProtectionSchema,
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
  const config = parse(
    await readFile(join(workerDirectory, "wrangler.jsonc"), "utf8"),
  );
  const wrangler = join(
    workerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const result = prepareDisabledStaging({
    config,
    confirmation: process.argv[3],
    wrangler,
    workerDirectory,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
