/**
 * Shared, offline-safe primitives for the release-evidence contract.
 *
 * This module deliberately knows nothing about artifact policy.  It owns the
 * boring but security-sensitive mechanics: bounded reads, regular-file and
 * real-path checks, deterministic JSON, and digesting one open file handle.
 */

import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { realpath, lstat, mkdir, rmdir, unlink, link } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  RELEASE_EVIDENCE_MAX_METADATA_BYTES,
  RELEASE_EVIDENCE_MAX_PATH_BYTES,
} from "../config/release-evidence.js";

export class ReleaseEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseEvidenceError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new ReleaseEvidenceError(code, message);
}

export function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

export function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function assertPlainObject(value, code, label) {
  assert(isPlainObject(value), code, `${label} must be an object`);
  return value;
}

export function assertBoolean(value, code, label) {
  assert(typeof value === "boolean", code, `${label} must be boolean`);
  return value;
}

export function assertSafeText(value, code, label, {
  pattern = null,
  maximumBytes = 1024,
} = {}) {
  assert(typeof value === "string" && value.length > 0,
    code, `${label} must be a non-empty string`);
  assert(!value.includes("\0") && Buffer.byteLength(value, "utf8") <= maximumBytes,
    code, `${label} contains an invalid string`);
  if (pattern !== null) {
    assert(pattern.test(value), code, `${label} has an invalid value`);
  }
  return value;
}

export function compareCodeUnits(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function stableStringify(value) {
  function normalize(current) {
    if (Array.isArray(current)) return current.map(normalize);
    if (isPlainObject(current)) {
      return Object.fromEntries(
        Object.keys(current)
          .sort(compareCodeUnits)
          .map((key) => [key, normalize(current[key])]),
      );
    }
    return current;
  }
  return JSON.stringify(normalize(value));
}

export function sha256Bytes(bytes) {
  assert(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array,
    "RELEASE_EVIDENCE_BYTES_INVALID", "Digest input must be byte data");
  return createHash("sha256").update(bytes).digest("hex");
}

export function pathWithin(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value === ""
    || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

export function assertSafeFileName(value, label) {
  assertSafeText(value, "RELEASE_EVIDENCE_UNSAFE_FILE_NAME", label, {
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u,
    maximumBytes: 256,
  });
  assert(value !== "." && value !== ".."
      && !value.includes("/")
      && !value.includes("\\")
      && basename(value) === value,
  "RELEASE_EVIDENCE_UNSAFE_FILE_NAME",
  `${label} must be a simple release file name`);
  return value;
}

export function assertByteCount(value, label) {
  assert(Number.isSafeInteger(value) && value > 0,
    "RELEASE_EVIDENCE_BYTES_INVALID",
    `${label} must be a positive safe integer`);
  return value;
}

export function assertSha256(value, label) {
  return assertSafeText(value, "RELEASE_EVIDENCE_SHA256_INVALID", label, {
    pattern: /^[a-f0-9]{64}$/u,
    maximumBytes: 64,
  });
}

export function assertCanonicalSubjectDigest(value, expected, label) {
  assertSha256(value, label);
  assert(value === expected, "RELEASE_EVIDENCE_SUBJECT_MISMATCH",
    `${label} must match the final artifact SHA-256`);
}

export function assertHttpsUrl(value, code, label, { maximumBytes = 2048 } = {}) {
  assertSafeText(value, code, label, { maximumBytes });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(code, `${label} must be a canonical HTTPS URL`);
  }
  assert(parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.hostname.length > 0
      && parsed.href === value,
  code, `${label} must be a canonical HTTPS URL`);
  return value;
}

/**
 * Descriptor paths are intentionally relative.  A native finalizer can set
 * --base-dir to its staging root; accepting arbitrary absolute paths makes a
 * compromised descriptor a local file reader.
 */
export function resolveDescriptorPath(value, baseDir, label) {
  assertSafeText(value, "RELEASE_EVIDENCE_PATH_INVALID", label, {
    maximumBytes: RELEASE_EVIDENCE_MAX_PATH_BYTES,
  });
  assert(!isAbsolute(value), "RELEASE_EVIDENCE_UNSAFE_PATH",
    `${label} must be relative to the descriptor base directory`);
  const selected = resolve(baseDir, value);
  assert(pathWithin(baseDir, selected), "RELEASE_EVIDENCE_UNSAFE_PATH",
    `${label} escapes the descriptor base directory`);
  return selected;
}

function statValue(value, key) {
  return value?.[key] === undefined ? null : String(value[key]);
}

function statFingerprint(value) {
  return Object.freeze({
    dev: statValue(value, "dev"),
    ino: statValue(value, "ino"),
    size: statValue(value, "size"),
    mtimeNs: statValue(value, "mtimeNs"),
    ctimeNs: statValue(value, "ctimeNs"),
  });
}

function sameStat(left, right) {
  const identityAvailable = left.dev !== null && left.ino !== null
    && right.dev !== null && right.ino !== null
    && (left.dev !== "0" || left.ino !== "0")
    && (right.dev !== "0" || right.ino !== "0");
  if (identityAvailable && (left.dev !== right.dev || left.ino !== right.ino)) {
    return false;
  }
  return left.size === right.size
    && (left.mtimeNs === null || right.mtimeNs === null || left.mtimeNs === right.mtimeNs)
    && (left.ctimeNs === null || right.ctimeNs === null || left.ctimeNs === right.ctimeNs);
}

async function realPathWithin(root, selected, label) {
  let rootReal;
  let selectedReal;
  try {
    rootReal = await realpath(resolve(root));
    selectedReal = await realpath(resolve(selected));
  } catch (error) {
    fail("RELEASE_EVIDENCE_FILE_UNAVAILABLE",
      `${label} cannot resolve its real path: ${error.message}`);
  }
  assert(pathWithin(rootReal, selectedReal), "RELEASE_EVIDENCE_UNSAFE_PATH",
    `${label} escapes the real descriptor root`);
  return selectedReal;
}

async function inspectRegularFile(path, label, maximumBytes = null, root = null) {
  const selected = resolve(path);
  let metadata;
  try {
    metadata = await lstat(selected, { bigint: true });
  } catch (error) {
    fail("RELEASE_EVIDENCE_FILE_UNAVAILABLE",
      `${label} is missing or cannot be inspected: ${error.message}`);
  }
  assert(metadata.isFile() && !metadata.isSymbolicLink(),
    "RELEASE_EVIDENCE_SYMLINK_OR_NONFILE",
    `${label} must be a regular, non-symlink file`);
  if (root !== null) await realPathWithin(root, selected, label);
  const snapshot = statFingerprint(metadata);
  const size = Number(metadata.size);
  assertByteCount(size, label);
  if (maximumBytes !== null) {
    assert(size <= maximumBytes, "RELEASE_EVIDENCE_FILE_TOO_LARGE",
      `${label} exceeds the metadata size limit`);
  }
  return Object.freeze({ path: selected, size, snapshot });
}

export async function regularFileInfo(path, label, maximumBytes = null, root = null) {
  return inspectRegularFile(path, label, maximumBytes, root);
}

async function openCheckedFile(path, label, maximumBytes = null, root = null) {
  const initial = await inspectRegularFile(path, label, maximumBytes, root);
  let handle;
  try {
    handle = await open(initial.path, "r");
  } catch (error) {
    fail("RELEASE_EVIDENCE_FILE_UNAVAILABLE",
      `${label} could not be opened: ${error.message}`);
  }
  let opened;
  try {
    opened = await handle.stat({ bigint: true });
  } catch (error) {
    await handle.close().catch(() => {});
    fail("RELEASE_EVIDENCE_FILE_UNAVAILABLE",
      `${label} could not be inspected after opening: ${error.message}`);
  }
  if (!opened.isFile() || !sameStat(initial.snapshot, statFingerprint(opened))) {
    await handle.close().catch(() => {});
    fail("RELEASE_EVIDENCE_FILE_CHANGED",
      `${label} changed before it was opened`);
  }
  return { handle, initial, opened: statFingerprint(opened) };
}

async function readHandleBytes(handle, label, maximumBytes) {
  const chunks = [];
  let bytes = 0;
  const stream = handle.createReadStream({ autoClose: false });
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (maximumBytes !== null && bytes > maximumBytes) {
          stream.destroy(new ReleaseEvidenceError(
            "RELEASE_EVIDENCE_FILE_TOO_LARGE",
            `${label} exceeds the metadata size limit`,
          ));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", rejectPromise);
      stream.on("end", resolvePromise);
    });
  } catch (error) {
    if (error instanceof ReleaseEvidenceError) throw error;
    fail("RELEASE_EVIDENCE_FILE_UNAVAILABLE",
      `${label} could not be read: ${error.message}`);
  }
  return Buffer.concat(chunks, bytes);
}

export async function digestRegularFile(path, label, maximumBytes = null, root = null) {
  const { handle, initial, opened } = await openCheckedFile(path, label, maximumBytes, root);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const stream = handle.createReadStream({ autoClose: false });
    await new Promise((resolvePromise, rejectPromise) => {
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (maximumBytes !== null && bytes > maximumBytes) {
          stream.destroy(new ReleaseEvidenceError(
            "RELEASE_EVIDENCE_FILE_TOO_LARGE",
            `${label} exceeds the metadata size limit`,
          ));
          return;
        }
        hash.update(chunk);
      });
      stream.on("error", rejectPromise);
      stream.on("end", resolvePromise);
    });
    const final = statFingerprint(await handle.stat({ bigint: true }));
    assert(sameStat(opened, final) && bytes === Number(final.size),
      "RELEASE_EVIDENCE_FILE_CHANGED",
      `${label} changed while it was being hashed`);
  } catch (error) {
    if (error instanceof ReleaseEvidenceError) throw error;
    fail("RELEASE_EVIDENCE_FILE_UNAVAILABLE",
      `${label} could not be read: ${error.message}`);
  } finally {
    await handle.close().catch(() => {});
  }
  return Object.freeze({ path: initial.path, bytes, sha256: hash.digest("hex") });
}

export async function readJsonFile(path, label, maximumBytes = RELEASE_EVIDENCE_MAX_METADATA_BYTES, root = null) {
  const text = await readTextFile(path, label, maximumBytes, root);
  let value;
  try {
    value = JSON.parse(text.text);
  } catch {
    fail("RELEASE_EVIDENCE_JSON_INVALID", `${label} is not valid JSON`);
  }
  return Object.freeze({ bytes: text.bytes, sha256: text.sha256, value });
}

export async function readTextFile(path, label,
  maximumBytes = RELEASE_EVIDENCE_MAX_METADATA_BYTES, root = null) {
  const { handle, initial, opened } = await openCheckedFile(path, label, maximumBytes, root);
  let bytes;
  try {
    bytes = await readHandleBytes(handle, label, maximumBytes);
    const final = statFingerprint(await handle.stat({ bigint: true }));
    assert(sameStat(opened, final) && bytes.length === Number(final.size),
      "RELEASE_EVIDENCE_FILE_CHANGED",
      `${label} changed while it was being read`);
  } catch (error) {
    if (error instanceof ReleaseEvidenceError) throw error;
    fail("RELEASE_EVIDENCE_FILE_UNAVAILABLE",
      `${label} could not be read: ${error.message}`);
  } finally {
    await handle.close().catch(() => {});
  }
  return Object.freeze({
    bytes: bytes.length,
    sha256: sha256Bytes(bytes),
    text: bytes.toString("utf8"),
  });
}

export async function digestDescriptorFile(value, baseDir, label, maximumBytes) {
  const pathValue = value?.path === undefined ? value?.file : value?.path;
  const path = resolveDescriptorPath(pathValue, baseDir, `${label}.path`);
  const digest = await digestRegularFile(path, label, maximumBytes, baseDir);
  if (value.bytes !== undefined) {
    assert(value.bytes === digest.bytes, "RELEASE_EVIDENCE_BYTES_MISMATCH",
      `${label}.bytes does not match the supplied file`);
  }
  if (value.sha256 !== undefined) {
    assert(value.sha256 === digest.sha256, "RELEASE_EVIDENCE_HASH_MISMATCH",
      `${label}.sha256 does not match the supplied file`);
  }
  return digest;
}

export async function withOutputLock(directory, callback) {
  const lockPath = join(resolve(directory), ".release-evidence-output.lock");
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("RELEASE_EVIDENCE_OUTPUT_BUSY",
        `${directory} is already being written by another release-evidence process`);
    }
    throw error;
  }
  try {
    return await callback();
  } finally {
    await rmdir(lockPath).catch(() => {});
  }
}

export async function writeExclusiveFile(path, text) {
  const selected = resolve(path);
  const temporary = `${selected}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o644);
  let linked = false;
  let failure = null;
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await link(temporary, selected);
    linked = true;
  } catch (error) {
    failure = error;
  } finally {
    await handle.close().catch(() => {});
  }
  if (failure !== null) {
    await unlink(temporary).catch(() => {});
    if (failure?.code === "EEXIST") {
      fail("RELEASE_EVIDENCE_OUTPUT_EXISTS", `${selected} was created concurrently`);
    }
    throw failure;
  }
  assert(linked, "RELEASE_EVIDENCE_OUTPUT_WRITE_FAILED", "output was not installed");
  // The link is the durable installation point.  A failed cleanup of the
  // private staging name must not turn a successfully installed file into a
  // reported write failure after the caller has already observed the link.
  await unlink(temporary).catch(() => {});
}

export async function ensureOutputDirectory(path, root = null) {
  const requestedParent = dirname(resolve(path));
  try {
    await mkdir(requestedParent, { recursive: true });
    const canonicalParent = await realpath(requestedParent);
    const parentMetadata = await lstat(canonicalParent);
    assert(parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink(),
      "RELEASE_EVIDENCE_OUTPUT_DIR_INVALID",
      "release evidence output parent must resolve to a regular directory");
    if (root !== null) {
      const canonicalRoot = await realpath(resolve(root));
      assert(pathWithin(canonicalRoot, canonicalParent),
        "RELEASE_EVIDENCE_UNSAFE_PATH",
        "release evidence output directory escapes the trusted artifact root");
    }
    return canonicalParent;
  } catch (error) {
    if (error instanceof ReleaseEvidenceError) throw error;
    fail("RELEASE_EVIDENCE_OUTPUT_DIR_INVALID",
      `release evidence output directory is unavailable: ${error.message}`);
  }
}
