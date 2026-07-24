import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SECRET_BYTES = 32;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PSEUDONYM_PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const LEGACY_RETIREMENT_CONTENT = "app-usagemonitor legacy secret retired v1\n";
const ROTATION_CONFIRMATION_ERROR = "Participant secret rotation requires confirmRotation: true";

export function defaultExportStateDirectory({
  platform = process.platform,
  homeDirectory = homedir(),
  environment = process.env,
} = {}) {
  if (platform === "darwin") return join(homeDirectory, "Library", "Application Support", "app-usagemonitor");
  if (platform === "win32") {
    return join(environment.LOCALAPPDATA || join(homeDirectory, "AppData", "Local"), "app-usagemonitor");
  }
  return join(environment.XDG_STATE_HOME || join(homeDirectory, ".local", "state"), "app-usagemonitor");
}

export function defaultExportSecretFile(options) {
  return join(defaultExportStateDirectory(options), "export-participant-secret");
}

export function legacyWorkingDirectorySecretFile({ workingDirectory = process.cwd() } = {}) {
  return resolve(workingDirectory, ".usage-monitor", "export-participant-secret");
}

function decodeSecret(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const result = Buffer.from(value);
    if (result.byteLength !== SECRET_BYTES) throw new Error("Participant secret must contain exactly 32 bytes");
    return result;
  }
  if (typeof value !== "string") throw new Error("Participant secret must be a 32-byte base64url value");
  const normalized = value.trim();
  if (!BASE64URL_256_PATTERN.test(normalized)) throw new Error("Participant secret must be a 32-byte base64url value");
  const result = Buffer.from(normalized, "base64url");
  if (result.byteLength !== SECRET_BYTES) throw new Error("Participant secret must contain exactly 32 bytes");
  return result;
}

export function encodeParticipantSecret(secret) {
  return decodeSecret(secret).toString("base64url");
}

function assertOwnedRegularSecret(stats) {
  if (!stats.isFile()) throw new Error("Participant secret must be a regular file");
  if (stats.nlink !== 1) throw new Error("Participant secret must not be hard-linked");
  if (stats.size !== 44) throw new Error("Participant secret file must contain exactly 44 bytes");
  if (typeof process.getuid === "function" && typeof stats.uid === "number" && stats.uid !== process.getuid()) {
    throw new Error("Participant secret must be owned by the current user");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("Participant secret permissions must be owner-only");
  }
}

async function readSecretFileWithIdentity(path) {
  const pathStats = await lstat(path);
  assertOwnedRegularSecret(pathStats);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    assertOwnedRegularSecret(stats);
    if (typeof stats.dev === "number" && typeof stats.ino === "number"
        && (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino)) {
      throw new Error("Participant secret changed while it was being opened");
    }
    return {
      secret: decodeSecret((await handle.readFile("utf8")).trim()),
      identity: { dev: stats.dev, ino: stats.ino },
    };
  } finally {
    await handle.close();
  }
}

async function readSecretFile(path) {
  return (await readSecretFileWithIdentity(path)).secret;
}

function isIncompleteConcurrentCreate(error) {
  return error instanceof Error && error.message === "Participant secret file must contain exactly 44 bytes";
}

async function readSecretFileEventually(path) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readSecretFileWithIdentity(path);
    } catch (error) {
      if (!isIncompleteConcurrentCreate(error)) throw error;
      lastError = error;
      await new Promise((resolveRetry) => setTimeout(resolveRetry, Math.min(attempt, 5)));
    }
  }
  throw lastError;
}

function sameFileIdentity(left, right) {
  return typeof left?.dev === "number" && typeof left?.ino === "number"
    && typeof right?.dev === "number" && typeof right?.ino === "number"
    && left.dev === right.dev && left.ino === right.ino;
}

function secretsEqual(left, right) {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function prepareSecretDirectory(path) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Participant secret directory must be a real directory");
  if (typeof process.getuid === "function" && typeof stats.uid === "number" && stats.uid !== process.getuid()) {
    throw new Error("Participant secret directory must be owned by the current user");
  }
  if ((stats.mode & 0o022) !== 0) throw new Error("Participant secret directory must not be group- or world-writable");
}

async function writeNewSecret(path, encoded) {
  await prepareSecretDirectory(path);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    await handle.writeFile(`${encoded}\n`, "utf8");
    await handle.sync();
    const stats = await handle.stat();
    assertOwnedRegularSecret(stats);
  } finally {
    await handle.close();
  }
}

function retirementFileFor(path) {
  return `${path}.legacy-retired`;
}

export function participantSecretLegacyRetirementFile(secretFile = defaultExportSecretFile()) {
  return retirementFileFor(resolve(secretFile));
}

function assertOwnedRegularControlFile(stats, expectedSize) {
  if (!stats.isFile()) throw new Error("Participant secret control file must be a regular file");
  if (stats.nlink !== 1) throw new Error("Participant secret control file must not be hard-linked");
  if (stats.size !== expectedSize) throw new Error("Participant secret control file has invalid content");
  if (typeof process.getuid === "function" && typeof stats.uid === "number" && stats.uid !== process.getuid()) {
    throw new Error("Participant secret control file must be owned by the current user");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("Participant secret control file permissions must be owner-only");
  }
}

async function readLegacyRetirementFile(path) {
  const pathStats = await lstat(path);
  assertOwnedRegularControlFile(pathStats, Buffer.byteLength(LEGACY_RETIREMENT_CONTENT));
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    assertOwnedRegularControlFile(stats, Buffer.byteLength(LEGACY_RETIREMENT_CONTENT));
    if (typeof stats.dev === "number" && typeof stats.ino === "number"
        && (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino)) {
      throw new Error("Participant secret control file changed while it was being opened");
    }
    if ((await handle.readFile("utf8")) !== LEGACY_RETIREMENT_CONTENT) {
      throw new Error("Participant secret control file has invalid content");
    }
  } finally {
    await handle.close();
  }
}

function isIncompleteConcurrentControlCreate(error) {
  return error instanceof Error && error.message === "Participant secret control file has invalid content";
}

async function readLegacyRetirementFileEventually(path) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readLegacyRetirementFile(path);
    } catch (error) {
      if (!isIncompleteConcurrentControlCreate(error)) throw error;
      lastError = error;
      await new Promise((resolveRetry) => setTimeout(resolveRetry, Math.min(attempt, 5)));
    }
  }
  throw lastError;
}

async function syncDirectory(directory) {
  const directoryOnly = constants.O_DIRECTORY ?? 0;
  const handle = await open(directory, constants.O_RDONLY | directoryOnly);
  try {
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code)) throw error;
  } finally {
    await handle.close();
  }
}

async function ensureLegacyRetired(path) {
  try {
    await readLegacyRetirementFileEventually(path);
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    .catch(async (error) => {
      if (error.code !== "EEXIST") throw error;
      // Another creator exposes the O_EXCL inode before its write/sync has
      // completed. Wait for that bounded critical section, then validate it.
      await readLegacyRetirementFileEventually(path);
      return null;
    });
  if (!handle) return false;
  try {
    await handle.writeFile(LEGACY_RETIREMENT_CONTENT, "utf8");
    await handle.sync();
    assertOwnedRegularControlFile(await handle.stat(), Buffer.byteLength(LEGACY_RETIREMENT_CONTENT));
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
  return true;
}

async function readOptionalSecret(path) {
  try {
    return { state: "present", ...(await readSecretFileEventually(path)) };
  } catch (error) {
    if (error.code === "ENOENT") return { state: "missing", secret: null, identity: null };
    throw error;
  }
}

async function retirementState(path) {
  try {
    await readLegacyRetirementFileEventually(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function inspectParticipantSecretInternal({
  environmentSecret = process.env.APP_USAGEMONITOR_EXPORT_SECRET,
  secretFile = defaultExportSecretFile(),
  legacySecretFile = secretFile === defaultExportSecretFile() ? legacyWorkingDirectorySecretFile() : null,
} = {}) {
  const path = resolve(secretFile);
  const legacyPath = legacySecretFile && resolve(legacySecretFile) !== path ? resolve(legacySecretFile) : null;

  if (environmentSecret) {
    return {
      status: "ready",
      secret: decodeSecret(environmentSecret),
      source: "environment",
      canonicalState: "not_checked",
      legacyState: "not_checked",
      legacyRetired: false,
      conflict: false,
      wouldCreate: false,
      wouldMigrate: false,
      rotatable: false,
      path,
      legacyPath,
      canonicalIdentity: null,
    };
  }

  const canonical = await readOptionalSecret(path);
  const retired = legacyPath ? await retirementState(retirementFileFor(path)) : false;
  const legacy = legacyPath && !retired
    ? await readOptionalSecret(legacyPath)
    : { state: legacyPath && retired ? "retired" : "disabled", secret: null, identity: null };
  const conflict = canonical.state === "present" && legacy.state === "present"
    && !secretsEqual(canonical.secret, legacy.secret);

  if (conflict) {
    return {
      status: "conflict",
      secret: null,
      source: null,
      canonicalState: canonical.state,
      legacyState: legacy.state,
      legacyRetired: false,
      conflict: true,
      wouldCreate: false,
      wouldMigrate: false,
      rotatable: false,
      path,
      legacyPath,
      canonicalIdentity: canonical.identity,
    };
  }

  const selected = canonical.state === "present" ? canonical : legacy.state === "present" ? legacy : null;
  return {
    status: selected ? "ready" : "missing",
    secret: selected?.secret ?? null,
    source: canonical.state === "present" ? "owner_only_file" : legacy.state === "present" ? "legacy_owner_only_file" : null,
    canonicalState: canonical.state,
    legacyState: legacy.state,
    legacyRetired: retired,
    conflict: false,
    wouldCreate: !selected,
    wouldMigrate: canonical.state === "missing" && legacy.state === "present",
    rotatable: canonical.state === "present",
    path,
    legacyPath,
    canonicalIdentity: canonical.identity,
  };
}

/** Inspect identity state without creating, migrating, retiring, or rotating any file. */
export async function inspectParticipantSecret(options = {}) {
  const result = await inspectParticipantSecretInternal(options);
  const {
    canonicalIdentity: _canonicalIdentity,
    secret: _secret,
    path: _path,
    legacyPath: _legacyPath,
    ...inspection
  } = result;
  return inspection;
}

function identityConflictError() {
  const error = new Error("Canonical and legacy participant secret files contain different secrets");
  error.code = "EXPORT_IDENTITY_CONFLICT";
  return error;
}

export async function loadOrCreateParticipantSecret({
  environmentSecret = process.env.APP_USAGEMONITOR_EXPORT_SECRET,
  secretFile = defaultExportSecretFile(),
  legacySecretFile = secretFile === defaultExportSecretFile() ? legacyWorkingDirectorySecretFile() : null,
} = {}) {
  const inspection = await inspectParticipantSecretInternal({ environmentSecret, secretFile, legacySecretFile });
  if (inspection.source === "environment") return { secret: inspection.secret, source: "environment", created: false, migrated: false };
  if (inspection.conflict) throw identityConflictError();

  const path = resolve(secretFile);
  const legacyPath = legacySecretFile && resolve(legacySecretFile) !== path ? resolve(legacySecretFile) : null;
  const retirementPath = legacyPath ? retirementFileFor(path) : null;
  if (inspection.source === "owner_only_file") {
    if (retirementPath && !inspection.legacyRetired) await ensureLegacyRetired(retirementPath);
    return { secret: inspection.secret, source: "owner_only_file", created: false, migrated: false };
  }

  if (inspection.source === "legacy_owner_only_file") {
    try {
      await writeNewSecret(path, encodeParticipantSecret(inspection.secret));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const canonicalSecret = (await readSecretFileEventually(path)).secret;
    if (!secretsEqual(canonicalSecret, inspection.secret)) throw identityConflictError();
    await ensureLegacyRetired(retirementPath);
    return { secret: canonicalSecret, source: "owner_only_file", created: false, migrated: true };
  }

  const secret = randomBytes(SECRET_BYTES);
  const encoded = encodeParticipantSecret(secret);
  try {
    await writeNewSecret(path, encoded);
    if (retirementPath) await ensureLegacyRetired(retirementPath);
    return { secret, source: "owner_only_file", created: true, migrated: false };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const concurrent = await inspectParticipantSecretInternal({ environmentSecret: null, secretFile: path, legacySecretFile: legacyPath });
    if (concurrent.conflict) throw identityConflictError();
    if (concurrent.source !== "owner_only_file") throw new Error("Participant secret was not available after concurrent creation");
    if (retirementPath && !concurrent.legacyRetired) await ensureLegacyRetired(retirementPath);
    return { secret: concurrent.secret, source: "owner_only_file", created: false, migrated: false };
  }
}

async function acquireRotationLock(path) {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      const locked = new Error("A participant identity operation is already in progress");
      locked.code = "EXPORT_IDENTITY_ROTATION_LOCKED";
      throw locked;
    }
    throw error;
  }
  try {
    await handle.writeFile("app-usagemonitor identity operation lock v1\n", "utf8");
    await handle.sync();
    const identity = await handle.stat();
    await syncDirectory(dirname(path));
    return { handle, identity: { dev: identity.dev, ino: identity.ino } };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(path).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

/**
 * Hold the same exclusive lease used by rotation for the complete export
 * callback, preventing an export that starts before rotation from publishing
 * after rotation completes under the retired identity.
 */
export async function withParticipantSecretLease({
  environmentSecret = process.env.APP_USAGEMONITOR_EXPORT_SECRET,
  secretFile = defaultExportSecretFile(),
  legacySecretFile = secretFile === defaultExportSecretFile() ? legacyWorkingDirectorySecretFile() : null,
} = {}, callback) {
  if (typeof callback !== "function") throw new TypeError("Participant identity lease requires a callback");
  if (environmentSecret) {
    const identity = await loadOrCreateParticipantSecret({ environmentSecret, secretFile, legacySecretFile });
    return callback(identity);
  }
  const path = resolve(secretFile);
  await prepareSecretDirectory(path);
  const lockPath = `${path}.rotation-lock`;
  const lock = await acquireRotationLock(lockPath);
  try {
    const identity = await loadOrCreateParticipantSecret({
      environmentSecret: null,
      secretFile: path,
      legacySecretFile,
    });
    return await callback(identity);
  } finally {
    await releaseRotationLock(lockPath, lock);
  }
}

async function releaseRotationLock(path, lock) {
  await lock.handle.close();
  try {
    const current = await lstat(path);
    if (sameFileIdentity(lock.identity, current)) {
      await unlink(path);
      await syncDirectory(dirname(path));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function rotationCheckpoint(rotationHook, failpoint, point) {
  if (rotationHook) await rotationHook(point);
  if (failpoint === point) {
    const error = new Error(`Participant secret rotation failpoint: ${point}`);
    error.code = "EXPORT_IDENTITY_ROTATION_FAILPOINT";
    throw error;
  }
}

/**
 * Replace a canonical file-backed identity. The atomic replacement does not and
 * cannot promise secure erasure of old bytes from storage or existing handles.
 */
export async function rotateParticipantSecret({
  confirmRotation = false,
  environmentSecret = process.env.APP_USAGEMONITOR_EXPORT_SECRET,
  secretFile = defaultExportSecretFile(),
  legacySecretFile = secretFile === defaultExportSecretFile() ? legacyWorkingDirectorySecretFile() : null,
  rotationHook = null,
  failpoint = null,
} = {}) {
  if (confirmRotation !== true) throw new Error(ROTATION_CONFIRMATION_ERROR);
  if (environmentSecret) {
    const error = new Error("Environment-provided participant secrets cannot be rotated by this function");
    error.code = "EXPORT_IDENTITY_ENVIRONMENT_ROTATION_REFUSED";
    throw error;
  }

  const path = resolve(secretFile);
  const legacyPath = legacySecretFile && resolve(legacySecretFile) !== path ? resolve(legacySecretFile) : null;
  const lockPath = `${path}.rotation-lock`;
  const initial = await inspectParticipantSecretInternal({ environmentSecret: null, secretFile: path, legacySecretFile: legacyPath });
  if (initial.conflict) throw identityConflictError();
  if (initial.source !== "owner_only_file") {
    const error = new Error("A canonical file-backed participant secret must exist before rotation");
    error.code = "EXPORT_IDENTITY_ROTATION_NOT_READY";
    throw error;
  }

  const lock = await acquireRotationLock(lockPath);
  let stagedPath = null;
  const oldSecret = initial.secret;
  let lockedOldSecret = null;
  let verifiedOldSecret = null;
  let generatedSecret = null;
  try {
    const current = await inspectParticipantSecretInternal({ environmentSecret: null, secretFile: path, legacySecretFile: legacyPath });
    lockedOldSecret = current.secret;
    if (current.conflict) throw identityConflictError();
    if (current.source !== "owner_only_file" || !sameFileIdentity(initial.canonicalIdentity, current.canonicalIdentity)
        || !secretsEqual(initial.secret, current.secret)) {
      const error = new Error("Participant secret changed before rotation acquired its lock");
      error.code = "EXPORT_IDENTITY_ROTATION_RACE";
      throw error;
    }

    if (legacyPath && !current.legacyRetired) await ensureLegacyRetired(retirementFileFor(path));
    generatedSecret = randomBytes(SECRET_BYTES);
    stagedPath = `${path}.rotation-${process.pid}-${randomBytes(12).toString("hex")}.tmp`;
    await writeNewSecret(stagedPath, encodeParticipantSecret(generatedSecret));
    await rotationCheckpoint(rotationHook, failpoint, "after-stage-sync");

    const beforeRename = await readSecretFileWithIdentity(path);
    verifiedOldSecret = beforeRename.secret;
    if (!sameFileIdentity(current.canonicalIdentity, beforeRename.identity)
        || !secretsEqual(current.secret, beforeRename.secret)) {
      const error = new Error("Participant secret changed during rotation");
      error.code = "EXPORT_IDENTITY_ROTATION_RACE";
      throw error;
    }

    await rename(stagedPath, path);
    stagedPath = null;
    await rotationCheckpoint(rotationHook, failpoint, "after-rename");
    await syncDirectory(dirname(path));
    await rotationCheckpoint(rotationHook, failpoint, "after-directory-sync");

    const persisted = await readSecretFile(path);
    if (!secretsEqual(generatedSecret, persisted)) throw new Error("Rotated participant secret did not persist correctly");
    return {
      secret: persisted,
      source: "owner_only_file",
      rotated: true,
      legacyRetired: Boolean(legacyPath),
      secureErasure: false,
    };
  } finally {
    oldSecret.fill(0);
    lockedOldSecret?.fill(0);
    verifiedOldSecret?.fill(0);
    generatedSecret?.fill(0);
    try {
      if (stagedPath) {
        try {
          await unlink(stagedPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    } finally {
      await releaseRotationLock(lockPath, lock);
    }
  }
}

function domainKey(secret, domain) {
  return Buffer.from(hkdfSync(
    "sha256",
    decodeSecret(secret),
    Buffer.from("app-usagemonitor/export-identity/v1", "utf8"),
    Buffer.from(domain, "utf8"),
    SECRET_BYTES,
  ));
}

export function deriveExportPseudonym(secret, prefix, subject) {
  if (!PSEUDONYM_PREFIX_PATTERN.test(prefix)) throw new Error("Pseudonym prefix is invalid");
  if (typeof subject !== "string" || subject.length === 0 || subject.length > 4096) {
    throw new Error("Pseudonym subject must be a bounded non-empty string");
  }
  const digest = createHmac("sha256", domainKey(secret, prefix))
    .update(`app-usagemonitor/${prefix}/v1\0`, "utf8")
    .update(subject, "utf8")
    .digest("base64url");
  return `${prefix}:v1:${digest}`;
}

export function deriveExportPseudonymV2(secret, prefix, subject) {
  if (!PSEUDONYM_PREFIX_PATTERN.test(prefix)) throw new Error("Pseudonym prefix is invalid");
  if (typeof subject !== "string" || subject.length === 0 || subject.length > 4096) {
    throw new Error("Pseudonym subject must be a bounded non-empty string");
  }
  const digest = createHmac("sha256", domainKey(secret, `${prefix}-v2`))
    .update(`app-usagemonitor/${prefix}/v2\0`, "utf8")
    .update(subject, "utf8")
    .digest("base64url");
  return `${prefix}:v2:${digest}`;
}

export function deriveParticipantId(secret) {
  return deriveExportPseudonym(secret, "participant", "self");
}

export function deriveSessionScopeId(secret, rawSessionSubject) {
  return deriveExportPseudonym(secret, "session", rawSessionSubject);
}

export function deriveEventId(secret, canonicalSubject) {
  return deriveExportPseudonym(secret, "event", canonicalSubject);
}

export function deriveEventOccurrenceId(secret, canonicalSourceLocator) {
  return deriveExportPseudonymV2(secret, "event", canonicalSourceLocator);
}

export function deriveSnapshotId(secret, canonicalSubject) {
  return deriveExportPseudonym(secret, "snapshot", canonicalSubject);
}

export function deriveSnapshotObservationId(secret, canonicalSourceLocator) {
  return deriveExportPseudonymV2(secret, "snapshot", canonicalSourceLocator);
}

export function deriveQuotaStateId(secret, canonicalProviderState) {
  return deriveExportPseudonym(secret, "quota-state", canonicalProviderState);
}

export function deriveMarkerId(secret, canonicalSubject) {
  return deriveExportPseudonym(secret, "marker", canonicalSubject);
}

export function deriveMarkerOccurrenceId(secret, rawMarkerId) {
  return deriveExportPseudonymV2(secret, "marker", rawMarkerId);
}

export function deriveAccountScopeId(secret, rawAccountScope) {
  if (rawAccountScope === null || rawAccountScope === undefined || rawAccountScope === "unattributed") return "unattributed";
  return deriveExportPseudonym(secret, "account", String(rawAccountScope));
}

export function deriveModelFingerprint(secret, rawModelId) {
  return deriveExportPseudonym(secret, "model", rawModelId);
}

export function randomBundleId() {
  return `bundle:v1:${randomBytes(SECRET_BYTES).toString("base64url")}`;
}
