import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import {
  assessStagingConfiguration,
  probeStagingLive,
} from "./staging-readiness-lib.mjs";

export const PILOT_OPERATION_RECEIPT_SCHEMA_VERSION =
  "usage-monitor-pilot-operation-receipt-v0.1";
export const PILOT_SQL_TEMP_CLEANUP_WARNING =
  "PILOT_SQL_TEMP_CLEANUP_REQUIRED";

const MAX_RECEIPT_BYTES = 8 * 1024;
const MAX_INVITATION_FILE_BYTES = 512;
const DEFAULT_PILOT_FILE_SYSTEM = Object.freeze({
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
});
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INVITATION_PATTERN =
  /^um_invite_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})\n?$/u;

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function ownerOnlyDirectory(directory) {
  try {
    const metadata = lstatSync(directory);
    return metadata.isDirectory()
      && !metadata.isSymbolicLink()
      && (metadata.mode & 0o077) === 0
      && (currentUid() === null || metadata.uid === currentUid());
  } catch {
    return false;
  }
}

export function validateNewOwnerOnlyFile(filename) {
  if (typeof filename !== "string" || !isAbsolute(filename)) return false;
  const normalized = resolve(filename);
  if (normalized !== filename || !ownerOnlyDirectory(dirname(filename))) {
    return false;
  }
  try {
    lstatSync(filename);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

export function writeNewOwnerOnlyFile(filename, value) {
  if (!validateNewOwnerOnlyFile(filename)) return false;
  let descriptor;
  let identity;
  try {
    descriptor = openSync(filename, "wx", 0o600);
    const metadata = fstatSync(descriptor);
    identity = {
      dev: metadata.dev,
      ino: metadata.ino,
    };
    if (!metadata.isFile()
        || (metadata.mode & 0o777) !== 0o600
        || (currentUid() !== null && metadata.uid !== currentUid())) {
      throw new Error("unsafe owner-only file");
    }
    writeFileSync(descriptor, value, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    return true;
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The fixed failure result below is sufficient.
      }
    }
    if (identity) unlinkExactOwnerOnlyFile(filename, identity);
    return false;
  }
}

export function readOwnerOnlyInvitation(filename) {
  if (typeof filename !== "string" || !isAbsolute(filename)
      || resolve(filename) !== filename
      || !ownerOnlyDirectory(dirname(filename))) {
    return null;
  }
  try {
    const metadata = lstatSync(filename);
    if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.size < 1
        || metadata.size > MAX_INVITATION_FILE_BYTES
        || (metadata.mode & 0o777) !== 0o600
        || (currentUid() !== null && metadata.uid !== currentUid())) {
      return null;
    }
    const match = INVITATION_PATTERN.exec(readFileSync(filename, "utf8"));
    if (!match?.[1] || !match[2]) return null;
    return {
      id: match[1],
      secret: match[2],
      encoded: `um_invite_${match[1]}.${match[2]}`,
      identity: {
        dev: metadata.dev,
        ino: metadata.ino,
      },
    };
  } catch {
    return null;
  }
}

export function unlinkExactOwnerOnlyFile(filename, identity) {
  try {
    if (!ownerOnlyDirectory(dirname(filename))) return false;
    const metadata = lstatSync(filename);
    if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.dev !== identity.dev
        || metadata.ino !== identity.ino
        || (currentUid() !== null && metadata.uid !== currentUid())) {
      return false;
    }
    unlinkSync(filename);
    return true;
  } catch {
    return false;
  }
}

export function writePilotReceipt(filename, receipt) {
  let serialized;
  try {
    serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  } catch {
    return false;
  }
  if (Buffer.byteLength(serialized) > MAX_RECEIPT_BYTES) return false;
  return writeNewOwnerOnlyFile(filename, serialized);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function lastD1Row(value) {
  const statements = Array.isArray(value) ? value : [];
  return statements.findLast(
    (entry) => Array.isArray(entry?.results) && entry.results.length === 1,
  )?.results?.[0] ?? null;
}

function secureWranglerOptions(options = {}) {
  const childEnvironment = {
    ...process.env,
    WRANGLER_LOG: "log",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_WRITE_LOGS: "false",
  };
  delete childEnvironment.WRANGLER_LOG_PATH;
  delete childEnvironment.WRANGLER_OUTPUT_FILE_DIRECTORY;
  delete childEnvironment.WRANGLER_OUTPUT_FILE_PATH;
  return {
    ...options,
    env: childEnvironment,
  };
}

function secureWranglerSpawn(spawn) {
  return (command, args, options) =>
    spawn(command, args, secureWranglerOptions(options));
}

function runWrangler(
  wrangler,
  workerDirectory,
  args,
  spawn = spawnSync,
) {
  const result = spawn(wrangler, args, secureWranglerOptions({
    cwd: workerDirectory,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  }));
  return {
    ok: !result.error && result.status === 0,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function remoteDatabaseConfigured(config) {
  const configuration = assessStagingConfiguration(config);
  return configuration.state !== "unsafe_configuration"
    && configuration.checks.resourceIdentifiersConfigured;
}

export function probeRemotePilotReadiness({
  config,
  wrangler,
  workerDirectory,
  spawn = spawnSync,
  allowActiveControls = false,
}) {
  const readiness = probeStagingLive({
    config,
    wrangler,
    workerDirectory,
    spawn: secureWranglerSpawn(spawn),
  });
  const blockers = readiness.blockers.filter(
    (blocker) => !(allowActiveControls
      && blocker === "REMOTE_COLLECTION_NOT_CONTAINED"),
  );
  const requiredChecksPass = Object.entries(readiness.checks).every(
    ([name, passed]) => passed === true
      || (allowActiveControls
        && name === "collectionContained"
        && passed === false),
  );
  return {
    ok: blockers.length === 0 && requiredChecksPass,
    checks: readiness.checks,
    blockers,
  };
}

export function probeRemotePilotDatabase({
  config,
  wrangler,
  workerDirectory,
  spawn = spawnSync,
}) {
  const checks = {
    configurationSafe: remoteDatabaseConfigured(config),
    authenticated: false,
    primaryDatabaseMatched: false,
    migrationsCurrent: false,
  };
  const blockers = [];
  if (!checks.configurationSafe) {
    return {
      ok: false,
      checks,
      blockers: ["STAGING_CONFIGURATION_BLOCKED"],
    };
  }

  const authenticated = runWrangler(
    wrangler,
    workerDirectory,
    ["whoami"],
    spawn,
  );
  checks.authenticated = authenticated.ok;
  if (!checks.authenticated) blockers.push("CLOUDFLARE_AUTHENTICATION_UNAVAILABLE");

  const listed = runWrangler(
    wrangler,
    workerDirectory,
    ["d1", "list", "--json"],
    spawn,
  );
  const databases = parseJson(listed.stdout);
  const primary = config.env.staging.d1_databases.find(
    (entry) => entry.binding === "USAGE_MONITOR_DB",
  );
  checks.primaryDatabaseMatched = listed.ok
    && Array.isArray(databases)
    && databases.some((database) =>
      database?.uuid === primary?.database_id
      && database?.name === primary?.database_name);
  if (!checks.primaryDatabaseMatched) {
    blockers.push("STAGING_PRIMARY_DATABASE_MISMATCH");
  }

  const migrations = runWrangler(
    wrangler,
    workerDirectory,
    [
      "d1", "migrations", "list", "USAGE_MONITOR_DB",
      "--remote", "--env", "staging",
    ],
    spawn,
  );
  checks.migrationsCurrent = migrations.ok
    && /No migrations to apply[.!]?/iu.test(
      `${migrations.stdout}${migrations.stderr}`,
    );
  if (!checks.migrationsCurrent) blockers.push("REMOTE_MIGRATIONS_PENDING");

  return {
    ok: blockers.length === 0,
    checks,
    blockers,
  };
}

export function runRemotePilotSql({
  sql,
  wrangler,
  workerDirectory,
  spawn = spawnSync,
  fileSystem = {},
}) {
  const pilotFileSystem = {
    ...DEFAULT_PILOT_FILE_SYSTEM,
    ...fileSystem,
  };
  let temporaryDirectory;
  let sqlFile;
  let outcome = {
    ok: false,
    row: null,
    warnings: [],
  };
  let cleanupRequired = false;
  try {
    temporaryDirectory = pilotFileSystem.mkdtempSync(
      join(tmpdir(), "usage-monitor-pilot-sql-"),
    );
    const directoryMetadata = pilotFileSystem.lstatSync(temporaryDirectory);
    if (!directoryMetadata.isDirectory()
        || directoryMetadata.isSymbolicLink()
        || (directoryMetadata.mode & 0o777) !== 0o700
        || (currentUid() !== null
          && directoryMetadata.uid !== currentUid())) {
      throw new Error("unsafe pilot SQL temporary directory");
    }
    sqlFile = join(temporaryDirectory, "operation.sql");
    const descriptor = pilotFileSystem.openSync(sqlFile, "wx", 0o600);
    try {
      const fileMetadata = pilotFileSystem.fstatSync(descriptor);
      if (!fileMetadata.isFile()
          || (fileMetadata.mode & 0o777) !== 0o600
          || (currentUid() !== null && fileMetadata.uid !== currentUid())) {
        throw new Error("unsafe pilot SQL temporary file");
      }
      pilotFileSystem.writeFileSync(
        descriptor,
        sql,
        { encoding: "utf8" },
      );
      pilotFileSystem.fsyncSync(descriptor);
    } finally {
      pilotFileSystem.closeSync(descriptor);
    }
    const result = runWrangler(
      wrangler,
      workerDirectory,
      [
        "d1", "execute", "USAGE_MONITOR_DB",
        "--remote", "--env", "staging",
        "--file", sqlFile,
        "--json", "--yes",
      ],
      spawn,
    );
    outcome = {
      ok: result.ok,
      row: result.ok ? lastD1Row(parseJson(result.stdout)) : null,
      warnings: [],
    };
  } catch {
    outcome = { ok: false, row: null, warnings: [] };
  } finally {
    if (sqlFile) {
      try {
        pilotFileSystem.unlinkSync(sqlFile);
      } catch (error) {
        if (error?.code !== "ENOENT") cleanupRequired = true;
      }
    }
    if (temporaryDirectory) {
      try {
        pilotFileSystem.rmdirSync(temporaryDirectory);
      } catch (error) {
        if (error?.code !== "ENOENT") cleanupRequired = true;
      }
    }
    if (cleanupRequired) {
      outcome.warnings = [PILOT_SQL_TEMP_CLEANUP_WARNING];
    }
  }
  return outcome;
}

export function bareHttpsOrigin(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function safeJsonHeaders(response) {
  return response.headers.get("content-type")?.split(";", 1)[0]
      === "application/json"
    && response.headers.get("cache-control") === "no-store"
    && response.headers.get("referrer-policy") === "no-referrer"
    && response.headers.get("x-content-type-options") === "nosniff";
}

export async function fetchPilotJson(
  origin,
  pathname,
  fetchImpl = fetch,
) {
  let response;
  try {
    response = await fetchImpl(new URL(pathname, origin), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: null, value: null };
  }
  if (!safeJsonHeaders(response)) {
    return { ok: false, status: response.status, value: null };
  }
  try {
    return {
      ok: true,
      status: response.status,
      value: await response.json(),
    };
  } catch {
    return { ok: false, status: response.status, value: null };
  }
}

export function containedPilotHealth(value, enrollmentMode = "invite_only") {
  return value?.status === "ok"
    && value?.enrollmentMode === enrollmentMode
    && value?.collectionControls?.state === "contained"
    && value?.collectionControls?.enrollment === false
    && value?.collectionControls?.uploadRegistration === false
    && value?.collectionControls?.processing === false
    && value?.collectionControls?.publication === false
    && value?.capabilities?.encryptedUpload === false
    && value?.capabilities?.delayedAggregateStats === false
    && value?.capabilities?.ongoingDeviceUploadRegistration === false
    && value?.contracts?.accountScopedContribution
      ?.externalParticipantsAuthorized === false;
}

export function activePilotHealth(value) {
  return value?.status === "ok"
    && value?.enrollmentMode === "invite_only"
    && value?.collectionControls?.state === "degraded"
    && value?.collectionControls?.enrollment === true
    && value?.collectionControls?.uploadRegistration === true
    && value?.collectionControls?.processing === true
    && value?.collectionControls?.publication === false
    && value?.capabilities?.encryptedUpload === true
    && value?.capabilities?.delayedAggregateStats === false
    && value?.capabilities?.ongoingDeviceUploadRegistration === true
    && value?.contracts?.accountScopedContribution
      ?.externalParticipantsAuthorized === false;
}

export function lifecycleReady(response) {
  return response.ok
    && response.status === 200
    && response.value?.status === "ready"
    && response.value?.checks?.lifecycle === "ready"
    && response.value?.checks?.lifecycleFresh === true
    && response.value?.checks?.quarantineRetentionComplete === true
    && response.value?.checks?.restoreReplayComplete === true
    && response.value?.checks?.aggregateRebuildComplete === true
    && response.value?.checks?.maintenanceCycleMatched === true
    && response.value?.checks?.quarantineReconciliationComplete === true;
}

export function deployedOrigins(output) {
  return [...String(output).matchAll(
    /https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.workers\.dev/giu,
  )].flatMap((match) => {
    try {
      return [new URL(match[0]).origin];
    } catch {
      return [];
    }
  });
}

export function runPilotDeployment({
  inviteOnly,
  origin,
  wrangler,
  workerDirectory,
  spawn = spawnSync,
}) {
  const args = [
    "deploy", "--env", "staging", "--strict",
    "--var", "ENVIRONMENT:staging",
    "--var", `ENROLLMENT_MODE:${inviteOnly ? "invite_only" : "disabled"}`,
    "--var", "ACCOUNT_SCOPED_INGEST_MODE:disabled",
  ];
  const result = runWrangler(wrangler, workerDirectory, args, spawn);
  return result.ok
    && deployedOrigins(`${result.stdout}\n${result.stderr}`)
      .includes(origin.origin);
}

export function pilotReceipt({
  operation,
  outcome,
  activationState,
  collectionAuthorized,
  evidence,
  generatedAt = new Date().toISOString(),
  operationId = randomUUID(),
}) {
  if (!UUID_PATTERN.test(operationId)
      || !Number.isFinite(Date.parse(generatedAt))
      || typeof operation !== "string"
      || typeof outcome !== "string"
      || typeof activationState !== "string"
      || typeof collectionAuthorized !== "boolean"
      || typeof evidence !== "object"
      || evidence === null
      || Array.isArray(evidence)) {
    throw new TypeError("invalid pilot receipt");
  }
  return {
    schemaVersion: PILOT_OPERATION_RECEIPT_SCHEMA_VERSION,
    operationId,
    operation,
    outcome,
    environment: "staging",
    generatedAt,
    collectionAuthorized,
    activationState,
    evidence,
  };
}
