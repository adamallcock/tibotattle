import { createHash, createPublicKey, verify } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import distribution from "../../config/electron-production-distribution.cjs";
import { createPosixDesktopSettingsBackend } from "./desktop-settings-backends.js";

export const LINUX_UPDATE_MANIFEST_SCHEMA = "tibotattle-linux-update-v1";
const STATE_SCHEMA = "tibotattle-linux-update-high-water-v1";
const MANIFEST_KEYS = ["schemaVersion", "appId", "channel", "target", "version",
  "sequence", "size", "sha256", "keyId", "expiresAt"];
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAXIMUM_ARTIFACT_BYTES = 2 * 1024 ** 3;
const MAXIMUM_VALIDITY_MS = 31 * 24 * 60 * 60_000;
const VERIFIERS = new WeakSet();

export class LinuxUpdateAuthenticityError extends Error {
  constructor() {
    super("Linux update publisher verification failed");
    this.code = "linux_update_authenticity_failed";
  }
}
function fail() { throw new LinuxUpdateAuthenticityError(); }
function exact(value, keys) {
  return value !== null && typeof value === "object"
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) fail();
  const left = a.split(".").map(BigInt), right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}
function canonicalBytes(manifest) {
  return Buffer.from(`${JSON.stringify(Object.fromEntries(MANIFEST_KEYS.map(key => [key, manifest[key]])))}\n`);
}
function state(value) {
  if (!exact(value, ["schemaVersion", "sequence", "version", "manifestSha256", "artifactSha256"])
      || value.schemaVersion !== STATE_SCHEMA || !Number.isSafeInteger(value.sequence)
      || value.sequence < 1 || typeof value.version !== "string" || !VERSION.test(value.version)
      || typeof value.manifestSha256 !== "string" || !DIGEST.test(value.manifestSha256)
      || typeof value.artifactSha256 !== "string" || !DIGEST.test(value.artifactSha256)) fail();
  return Object.freeze({ ...value });
}
const STATE_CODEC = Object.freeze({
  decodeValue: state,
  decodeBytes(bytes) { return state(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); },
  encode(value, maximumBytes) {
    const validated = state(value), bytes = Buffer.from(`${JSON.stringify(validated)}\n`);
    if (bytes.length > maximumBytes) fail();
    return { value: validated, bytes };
  },
});

// Trust entries are shipped inside the application, not learned from update
// metadata. Rotation overlaps keys in an authenticated app release; bounded
// sequences let the following release retire the earlier key's authority.
function trustedKeys(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 8) fail();
  const keys = new Map();
  for (const entry of entries) {
    if (!exact(entry, ["id", "publicKey", "minimumSequence", "maximumSequence"])
        || typeof entry.id !== "string" || !/^[a-z0-9-]{1,48}$/u.test(entry.id)
        || keys.has(entry.id) || typeof entry.publicKey !== "string"
        || !/^[A-Za-z0-9+/]{43}=$/u.test(entry.publicKey)
        || !Number.isSafeInteger(entry.minimumSequence) || entry.minimumSequence < 1
        || !Number.isSafeInteger(entry.maximumSequence)
        || entry.maximumSequence < entry.minimumSequence) fail();
    const raw = Buffer.from(entry.publicKey, "base64");
    if (raw.length !== 32 || raw.toString("base64") !== entry.publicKey) fail();
    const key = createPublicKey({ format: "der", type: "spki",
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]) });
    keys.set(entry.id, Object.freeze({ ...entry, key }));
  }
  return keys;
}

function inspectArtifact(path, manifest) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")
      || basename(path) !== `TiboTattle-${manifest.version}-linux-x86_64.AppImage`) fail();
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size !== manifest.size
        || (before.mode & 0o022) !== 0 || before.uid !== process.getuid()) fail();
    const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (count === 0) fail();
      hash.update(chunk.subarray(0, count)); offset += count;
    }
    const after = fstatSync(fd), linked = lstatSync(path);
    if (!linked.isFile() || linked.dev !== before.dev || linked.ino !== before.ino
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || hash.digest("hex") !== manifest.sha256) fail();
  } catch { fail(); } finally { if (fd !== undefined) closeSync(fd); }
}

/** Main-process-only composition seam. The wrapper accepts only this branded
 * verifier. Production construction below supplies source-embedded keys and
 * owner-only durable state; renderers/feed metadata cannot supply either. */
export function createLinuxUpdateVerifier({ keys, currentVersion, backend, now = Date.now } = {}) {
  const trusted = trustedKeys(keys);
  if (typeof currentVersion !== "string" || !VERSION.test(currentVersion)
      || typeof backend?.load !== "function" || typeof backend?.save !== "function"
      || typeof now !== "function") fail();
  let accepted = null, acceptedPath = null, highWater;
  let operation = Promise.resolve();
  function validate(info) {
    if (!exact(info, ["version", "files", "path", "sha512", "tibotattleLinuxUpdate"])) fail();
    const envelope = info?.tibotattleLinuxUpdate;
    if (!exact(envelope, ["manifest", "signature"])) fail();
    const manifest = envelope.manifest;
    if (!exact(manifest, MANIFEST_KEYS)
        || manifest.schemaVersion !== LINUX_UPDATE_MANIFEST_SCHEMA
        || manifest.appId !== distribution.PRODUCTION_ELECTRON_APP_ID
        || manifest.channel !== "stable" || manifest.target !== "linux-x64"
        || typeof manifest.version !== "string" || !VERSION.test(manifest.version)
        || manifest.version !== info.version || compareVersions(manifest.version, currentVersion) < 0
        || !Number.isSafeInteger(manifest.sequence) || manifest.sequence < 1
        || !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAXIMUM_ARTIFACT_BYTES
        || typeof manifest.sha256 !== "string" || !DIGEST.test(manifest.sha256)
        || !Number.isSafeInteger(manifest.expiresAt) || manifest.expiresAt <= now()
        || manifest.expiresAt > now() + MAXIMUM_VALIDITY_MS
        || typeof envelope.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/u.test(envelope.signature)) fail();
    const authority = trusted.get(manifest.keyId);
    if (!authority || manifest.sequence < authority.minimumSequence
        || manifest.sequence > authority.maximumSequence) fail();
    const bytes = canonicalBytes(manifest), signature = Buffer.from(envelope.signature, "base64");
    if (signature.toString("base64") !== envelope.signature
        || !verify(null, bytes, authority.key, signature)) fail();
    const file = info.files?.[0];
    if (!Array.isArray(info.files) || info.files.length !== 1
        || !file || typeof file !== "object" || typeof file.url !== "string"
        || file.url !== `TiboTattle-${manifest.version}-linux-x86_64.AppImage`
        || info.path !== file.url || info.sha512 !== file.sha512
        || file.size !== manifest.size || typeof file.sha512 !== "string"
        || !/^[A-Za-z0-9+/]{86}==$/u.test(file.sha512)
        || Object.keys(file).some(key => !["url", "size", "sha512", "blockMapSize"].includes(key))
        || Object.hasOwn(info, "packages")
        || (Object.hasOwn(file, "blockMapSize") && (!Number.isSafeInteger(file.blockMapSize)
          || file.blockMapSize < 1 || file.blockMapSize > manifest.size - 4))) fail();
    return { manifest: Object.freeze({ ...manifest }), manifestSha256: createHash("sha256").update(bytes).digest("hex") };
  }
  async function authorize(info) {
    accepted = null; acceptedPath = null;
    const candidate = validate(info);
    if (highWater === undefined) {
      const stored = await backend.load();
      highWater = stored === null || stored === undefined ? null : state(stored);
    }
    if (highWater !== null && (candidate.manifest.sequence < highWater.sequence
        || compareVersions(candidate.manifest.version, highWater.version) < 0
        || (candidate.manifest.sequence === highWater.sequence
          && candidate.manifestSha256 !== highWater.manifestSha256)
        || (candidate.manifest.version === highWater.version
          && candidate.manifest.sha256 !== highWater.artifactSha256))) fail();
    const next = state({ schemaVersion: STATE_SCHEMA, sequence: candidate.manifest.sequence,
      version: candidate.manifest.version, manifestSha256: candidate.manifestSha256,
      artifactSha256: candidate.manifest.sha256 });
    await backend.save(next); // No availability/download claim before durable replay protection.
    highWater = next; accepted = candidate;
    return Object.freeze({ updateAvailable: compareVersions(candidate.manifest.version, currentVersion) > 0 });
  }
  const verifier = Object.freeze({
    authorize(info) {
      const current = operation.catch(() => {}).then(() => authorize(info)).catch(() => { fail(); });
      operation = current; return current;
    },
    verifyDownloaded(paths, installerPath) {
      if (!accepted || !Array.isArray(paths) || paths.length !== 1
          || paths[0] !== installerPath || accepted.manifest.expiresAt <= now()) fail();
      inspectArtifact(installerPath, accepted.manifest); acceptedPath = installerPath;
    },
    verifyBeforeInstall(installerPath) {
      if (!accepted || acceptedPath === null || acceptedPath !== installerPath
          || accepted.manifest.expiresAt <= now()) fail();
      // Synchronous revalidation immediately before the library's synchronous
      // install entrypoint prevents intervening event-loop work changing bytes.
      inspectArtifact(installerPath, accepted.manifest);
    },
  });
  VERIFIERS.add(verifier);
  return verifier;
}

export function isLinuxUpdateVerifier(value) { return VERIFIERS.has(value); }

export function createProductionLinuxUpdateVerifier(app) {
  if (distribution.PRODUCTION_ELECTRON_LINUX_UPDATE_KEYS.length === 0) return null;
  return createLinuxUpdateVerifier({
    keys: distribution.PRODUCTION_ELECTRON_LINUX_UPDATE_KEYS,
    currentVersion: app.getVersion(),
    backend: createPosixDesktopSettingsBackend({ platform: "linux",
      rootPath: join(app.getPath("userData"), "desktop-settings"),
      filename: "linux-update-high-water-v1.json", maximumBytes: 4096, codec: STATE_CODEC }),
  });
}
