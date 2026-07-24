import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SECRET_BYTES = 32;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PSEUDONYM_PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

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

async function readSecretFile(path) {
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
    return decodeSecret((await handle.readFile("utf8")).trim());
  } finally {
    await handle.close();
  }
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

export async function loadOrCreateParticipantSecret({
  environmentSecret = process.env.APP_USAGEMONITOR_EXPORT_SECRET,
  secretFile = defaultExportSecretFile(),
  legacySecretFile = secretFile === defaultExportSecretFile() ? legacyWorkingDirectorySecretFile() : null,
} = {}) {
  if (environmentSecret) {
    return {
      secret: decodeSecret(environmentSecret),
      source: "environment",
      created: false,
      migrated: false,
    };
  }
  const path = resolve(secretFile);
  try {
    return { secret: await readSecretFile(path), source: "owner_only_file", created: false, migrated: false };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (legacySecretFile && resolve(legacySecretFile) !== path) {
    try {
      const legacySecret = await readSecretFile(resolve(legacySecretFile));
      try {
        await writeNewSecret(path, encodeParticipantSecret(legacySecret));
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      return { secret: await readSecretFile(path), source: "owner_only_file", created: false, migrated: true };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const secret = randomBytes(SECRET_BYTES);
  const encoded = encodeParticipantSecret(secret);
  try {
    await writeNewSecret(path, encoded);
    return { secret, source: "owner_only_file", created: true, migrated: false };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return { secret: await readSecretFile(path), source: "owner_only_file", created: false, migrated: false };
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
