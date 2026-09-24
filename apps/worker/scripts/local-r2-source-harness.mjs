import { randomBytes, createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, link, lstat, mkdir, mkdtemp, open, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  ObjectTransferRehearsalError,
  ObjectTransferRetryableError,
  runPostgresObjectTransferRehearsal,
} from "./postgres-object-transfer-rehearsal.mjs";
import {
  LOCAL_R2_SOURCE_MAX_OBJECT_BYTES,
  LOCAL_R2_SOURCE_MAX_PAGE_BYTES,
  LOCAL_R2_SOURCE_MAX_STREAM_CHUNK_BYTES,
  LOCAL_R2_SOURCE_PREFIX,
  LocalR2SourceProtocolError,
  isPlainRecord,
  parseVersionToken,
  safeText,
  validateBucketName,
  validateKey,
  validateListPage,
  validateListRequest,
  validateReadRequest,
} from "./local-r2-source-protocol.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const WORKER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKER_ENTRYPOINT = fileURLToPath(new URL("./local-r2-source-worker.mjs", import.meta.url));
const DEFAULT_COMPATIBILITY_DATE = "2026-07-26";
const MAX_CHECKPOINT_BYTES = 8 * 1_024;
const REQUEST_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 60_000;
const STREAM_TOTAL_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const STARTUP_TIMEOUT_MS = 30_000;

export class LocalR2SourceHarnessError extends Error {
  constructor(code) {
    super(code);
    this.name = "LocalR2SourceHarnessError";
    this.code = code;
  }
}

export class LocalObjectTransferCheckpointError extends Error {
  constructor(code) {
    super(code);
    this.name = "LocalObjectTransferCheckpointError";
    this.code = code;
  }
}

function fail(code) {
  throw new LocalR2SourceHarnessError(code);
}

function checkpointFail(code) {
  throw new LocalObjectTransferCheckpointError(code);
}

function fixedSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function copyProtocolError(error, fallback) {
  if (error instanceof LocalR2SourceProtocolError) {
    return new ObjectTransferRehearsalError(error.code);
  }
  return new ObjectTransferRehearsalError(fallback);
}

function assertLocalUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail("LOCAL_R2_ENDPOINT_INVALID"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1"
      || !/^[0-9]+$/u.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535
      || url.username !== "" || url.password !== "" || url.pathname !== "/"
      || url.search !== "" || url.hash !== "") {
    fail("LOCAL_R2_ENDPOINT_INVALID");
  }
  return url.origin;
}

function assertLocalToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    fail("LOCAL_R2_ACCESS_TOKEN_INVALID");
  }
  return value;
}

async function readBoundedJson(response, maxBytes) {
  if (!response.body) fail("LOCAL_R2_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        break;
      }
      if (!(result.value instanceof Uint8Array)) fail("LOCAL_R2_RESPONSE_INVALID");
      total += result.value.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        fail("LOCAL_R2_RESPONSE_LIMIT");
      }
      chunks.push(result.value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* The stream already released its lock. */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(decoder.decode(bytes)); } catch {
    fail("LOCAL_R2_RESPONSE_INVALID");
  }
}

function responseFailure(response, fallback) {
  if (response.status === 409) return new ObjectTransferRehearsalError("OBJECT_TRANSFER_SOURCE_CHANGED");
  if (response.status === 503 || response.status === 429 || response.status >= 500) {
    return new ObjectTransferRetryableError();
  }
  if (response.status === 413) return new ObjectTransferRehearsalError("OBJECT_TRANSFER_STREAM_LIMIT");
  return new ObjectTransferRehearsalError(fallback);
}

function createRequestController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return { controller, clear: () => clearTimeout(timer) };
}

/** HTTP client exposing only the rehearsal's R2 source operations. */
export function createLocalR2TransferSource({ url, token, fetchImpl = globalThis.fetch }) {
  const baseUrl = assertLocalUrl(url);
  const accessToken = assertLocalToken(token);
  if (typeof fetchImpl !== "function") fail("LOCAL_R2_FETCH_UNAVAILABLE");

  async function sendJson(path, value, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const deadline = createRequestController(timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${LOCAL_R2_SOURCE_PREFIX}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify(value),
        cache: "no-store",
        redirect: "error",
        signal: deadline.controller.signal,
      });
      return { response, clear: deadline.clear };
    } catch {
      deadline.clear();
      throw new ObjectTransferRetryableError();
    }
  }

  return Object.freeze({
    async health() {
      const deadline = createRequestController(REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(`${baseUrl}${LOCAL_R2_SOURCE_PREFIX}/health`, {
          method: "GET",
          headers: { authorization: `Bearer ${accessToken}` },
          cache: "no-store",
          redirect: "error",
          signal: deadline.controller.signal,
        });
        return response.status === 204;
      } catch {
        return false;
      } finally {
        deadline.clear();
      }
    },

    async listPage(input) {
      let request;
      try { request = validateListRequest(input); } catch (error) {
        throw copyProtocolError(error, "OBJECT_TRANSFER_INVENTORY_INVALID");
      }
      let sent;
      try { sent = await sendJson("/list", request); } catch (error) {
        if (error instanceof ObjectTransferRetryableError) throw error;
        throw new ObjectTransferRetryableError();
      }
      try {
        if (!sent.response.ok) {
          await sent.response.body?.cancel().catch(() => undefined);
          throw responseFailure(sent.response, "OBJECT_TRANSFER_INVENTORY_INVALID");
        }
        let page;
        try { page = await readBoundedJson(sent.response, LOCAL_R2_SOURCE_MAX_PAGE_BYTES); } catch {
          throw new ObjectTransferRehearsalError("OBJECT_TRANSFER_INVENTORY_INVALID");
        }
        try {
          return validateListPage(page, request);
        } catch (error) {
          throw copyProtocolError(error, "OBJECT_TRANSFER_INVENTORY_INVALID");
        }
      } finally {
        sent.clear();
      }
    },

    async openRead(input) {
      let request;
      try {
        request = validateReadRequest(input);
        parseVersionToken(request.ifVersion);
      } catch (error) {
        throw copyProtocolError(error, "OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
      }
      const controller = new AbortController();
      let idleTimer;
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
        idleTimer.unref?.();
      };
      resetIdleTimer();
      const totalTimer = setTimeout(() => controller.abort(), STREAM_TOTAL_TIMEOUT_MS);
      totalTimer.unref?.();
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${LOCAL_R2_SOURCE_PREFIX}/read`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            "cache-control": "no-store",
          },
          body: JSON.stringify(request),
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        throw new ObjectTransferRetryableError();
      }
      resetIdleTimer();
      if (!response.ok) {
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        await response.body?.cancel().catch(() => undefined);
        throw responseFailure(response, "OBJECT_TRANSFER_SOURCE_READ_FAILED");
      }
      const returnedVersion = response.headers.get("x-local-r2-source-version");
      const contentLength = response.headers.get("content-length");
      if (!response.body || returnedVersion !== request.ifVersion
          || contentLength === null || !/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        await response.body?.cancel().catch(() => undefined);
        throw new ObjectTransferRehearsalError("OBJECT_TRANSFER_SOURCE_CHANGED");
      }
      const expectedBytes = Number(contentLength);
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes > LOCAL_R2_SOURCE_MAX_OBJECT_BYTES) {
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        await response.body.cancel().catch(() => undefined);
        throw new ObjectTransferRehearsalError("OBJECT_TRANSFER_STREAM_LIMIT");
      }

      const sourceBody = (async function* () {
        const reader = response.body.getReader();
        let completed = false;
        let total = 0;
        try {
          for (;;) {
            let result;
            try { result = await reader.read(); } catch {
              throw new ObjectTransferRetryableError();
            }
            if (controller.signal.aborted) throw new ObjectTransferRetryableError();
            if (result.done) {
              completed = true;
              if (total !== expectedBytes) {
                throw new ObjectTransferRehearsalError("OBJECT_TRANSFER_SOURCE_SIZE_MISMATCH");
              }
              return;
            }
            if (!(result.value instanceof Uint8Array) || result.value.byteLength === 0) {
              throw new ObjectTransferRehearsalError("OBJECT_TRANSFER_STREAM_CHUNK_INVALID");
            }
            total += result.value.byteLength;
            if (!Number.isSafeInteger(total) || total > expectedBytes
                || total > LOCAL_R2_SOURCE_MAX_OBJECT_BYTES) {
              throw new ObjectTransferRehearsalError("OBJECT_TRANSFER_STREAM_LIMIT");
            }
            resetIdleTimer();
            for (let offset = 0; offset < result.value.byteLength; offset += LOCAL_R2_SOURCE_MAX_STREAM_CHUNK_BYTES) {
              yield result.value.subarray(offset, Math.min(
                result.value.byteLength, offset + LOCAL_R2_SOURCE_MAX_STREAM_CHUNK_BYTES,
              ));
            }
          }
        } finally {
          clearTimeout(idleTimer);
          clearTimeout(totalTimer);
          if (!completed) await reader.cancel().catch(() => undefined);
          try { reader.releaseLock(); } catch { /* Ignore a released stream. */ }
        }
      }());
      return { version: returnedVersion, body: sourceBody };
    },
  });
}

function checkpointName(sourceManifestSha256, key) {
  return createHash("sha256").update(sourceManifestSha256).update("\n").update(key).digest("hex");
}

function normalizeCheckpoint(value) {
  const fields = ["schemaVersion", "sourceManifestSha256", "key", "sourceVersion", "size",
    "contentSha256", "metadataSha256", "targetGeneration"];
  if (!isPlainRecord(value) || Object.keys(value).length !== fields.length
      || Object.keys(value).some(key => !fields.includes(key))) {
    checkpointFail("OBJECT_TRANSFER_CHECKPOINT_INVALID");
  }
  if (value.schemaVersion !== "object-transfer-rehearsal-v1"
      || !fixedSha256(value.sourceManifestSha256)
      || !fixedSha256(value.contentSha256) || !fixedSha256(value.metadataSha256)
      || !Number.isSafeInteger(value.size) || value.size < 0
      || value.size > LOCAL_R2_SOURCE_MAX_OBJECT_BYTES) {
    checkpointFail("OBJECT_TRANSFER_CHECKPOINT_INVALID");
  }
  try {
    validateKey(value.key);
    safeText(value.sourceVersion, 1_024, "OBJECT_TRANSFER_CHECKPOINT_INVALID");
    parseVersionToken(value.sourceVersion);
    safeText(value.targetGeneration, 1_024, "OBJECT_TRANSFER_CHECKPOINT_INVALID");
  } catch {
    checkpointFail("OBJECT_TRANSFER_CHECKPOINT_INVALID");
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    sourceManifestSha256: value.sourceManifestSha256,
    key: value.key,
    sourceVersion: value.sourceVersion,
    size: value.size,
    contentSha256: value.contentSha256,
    metadataSha256: value.metadataSha256,
    targetGeneration: value.targetGeneration,
  });
}

function serializeCheckpoint(value) {
  const checkpoint = normalizeCheckpoint(value);
  const bytes = encoder.encode(JSON.stringify(checkpoint));
  if (bytes.byteLength > MAX_CHECKPOINT_BYTES) checkpointFail("OBJECT_TRANSFER_CHECKPOINT_LIMIT");
  return { checkpoint, bytes };
}

export function defaultObjectTransferCheckpointDirectory({ platform = process.platform, env = process.env } = {}) {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (typeof localAppData !== "string" || !isAbsolute(localAppData)) {
      fail("OBJECT_TRANSFER_CHECKPOINT_DIRECTORY_UNAVAILABLE");
    }
    return join(localAppData, "TiboTattle", "object-transfer-checkpoints");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "TiboTattle", "object-transfer-checkpoints");
  }
  const stateHome = env.XDG_STATE_HOME;
  const base = typeof stateHome === "string" && isAbsolute(stateHome)
    ? stateHome
    : join(homedir(), ".local", "state");
  return join(base, "tibotattle", "object-transfer-checkpoints");
}

async function ensurePrivateDirectory(path) {
  const directory = resolve(path);
  try { await mkdir(directory, { recursive: true, mode: 0o700 }); } catch {
    checkpointFail("OBJECT_TRANSFER_CHECKPOINT_UNAVAILABLE");
  }
  let metadata;
  try { metadata = await lstat(directory); } catch {
    checkpointFail("OBJECT_TRANSFER_CHECKPOINT_UNAVAILABLE");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    checkpointFail("OBJECT_TRANSFER_CHECKPOINT_DIRECTORY_INVALID");
  }
  let canonicalParent;
  let canonical;
  try {
    canonicalParent = await realpath(dirname(directory));
    canonical = await realpath(directory);
  } catch {
    checkpointFail("OBJECT_TRANSFER_CHECKPOINT_UNAVAILABLE");
  }
  if (canonical !== join(canonicalParent, directory.slice(dirname(directory).length + 1))) {
    checkpointFail("OBJECT_TRANSFER_CHECKPOINT_DIRECTORY_INVALID");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    checkpointFail("OBJECT_TRANSFER_CHECKPOINT_PERMISSIONS");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    checkpointFail("OBJECT_TRANSFER_CHECKPOINT_OWNER_INVALID");
  }
  return directory;
}

async function readCheckpointFile(directory, name, identity) {
  const path = join(directory, `${name}.json`);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    checkpointFail("OBJECT_TRANSFER_CHECKPOINT_UNAVAILABLE");
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_CHECKPOINT_BYTES
        || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
        || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
      checkpointFail("OBJECT_TRANSFER_CHECKPOINT_INVALID");
    }
    const bytes = await handle.readFile();
    let value;
    try { value = JSON.parse(decoder.decode(bytes)); } catch {
      checkpointFail("OBJECT_TRANSFER_CHECKPOINT_INVALID");
    }
    const checkpoint = normalizeCheckpoint(value);
    if (checkpoint.sourceManifestSha256 !== identity.sourceManifestSha256 || checkpoint.key !== identity.key) {
      checkpointFail("OBJECT_TRANSFER_CHECKPOINT_MISMATCH");
    }
    return checkpoint;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    checkpointFail("OBJECT_TRANSFER_CHECKPOINT_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function normalizeRehearsalReceipt(value) {
  const fields = ["schemaVersion", "status", "sourceObjects", "sourceBytes", "sourceManifestSha256",
    "sourceInventorySha256", "targetInventorySha256", "metrics"];
  if (!isPlainRecord(value) || Object.keys(value).length !== fields.length
      || Object.keys(value).some(key => !fields.includes(key))) {
    fail("OBJECT_TRANSFER_RECEIPT_INVALID");
  }
  const metricFields = ["copied", "adopted", "resumed", "retries", "transferredBytes",
    "maxStreamChunkBytes", "maxConcurrentObjectStreams"];
  if (value.schemaVersion !== "object-transfer-rehearsal-v1"
      || !["complete", "checkpointed"].includes(value.status)
      || !Number.isSafeInteger(value.sourceObjects) || value.sourceObjects < 0
      || !Number.isSafeInteger(value.sourceBytes) || value.sourceBytes < 0
      || !fixedSha256(value.sourceManifestSha256) || !fixedSha256(value.sourceInventorySha256)
      || (value.targetInventorySha256 !== null && !fixedSha256(value.targetInventorySha256))
      || !isPlainRecord(value.metrics) || Object.keys(value.metrics).length !== metricFields.length
      || Object.keys(value.metrics).some(key => !metricFields.includes(key))
      || metricFields.some(key => !Number.isSafeInteger(value.metrics[key]) || value.metrics[key] < 0)) {
    fail("OBJECT_TRANSFER_RECEIPT_INVALID");
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    status: value.status,
    sourceObjects: value.sourceObjects,
    sourceBytes: value.sourceBytes,
    sourceManifestSha256: value.sourceManifestSha256,
    sourceInventorySha256: value.sourceInventorySha256,
    targetInventorySha256: value.targetInventorySha256,
    metrics: Object.freeze(Object.fromEntries(metricFields.map(key => [key, value.metrics[key]]))),
  });
}

async function writePrivateRehearsalReceipt(path, input) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("OBJECT_TRANSFER_RECEIPT_PATH_INVALID");
  const receipt = normalizeRehearsalReceipt(input);
  const resolvedPath = resolve(path);
  const fileName = basename(resolvedPath);
  if (fileName.length === 0 || fileName === "." || fileName === "..") fail("OBJECT_TRANSFER_RECEIPT_PATH_INVALID");
  const parent = await ensurePrivateDirectory(dirname(resolvedPath));
  const output = join(parent, fileName);
  const bytes = encoder.encode(`${JSON.stringify(receipt)}\n`);
  if (bytes.byteLength > MAX_CHECKPOINT_BYTES) fail("OBJECT_TRANSFER_RECEIPT_LIMIT");
  let handle;
  let created = false;
  try {
    handle = await open(output, "wx", 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(output).catch(() => undefined);
    if (error?.code === "EEXIST") fail("OBJECT_TRANSFER_RECEIPT_EXISTS");
    if (error instanceof LocalR2SourceHarnessError) throw error;
    checkpointFail("OBJECT_TRANSFER_RECEIPT_UNAVAILABLE");
  }
}

async function preflightPrivateReceiptPath(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("OBJECT_TRANSFER_RECEIPT_PATH_INVALID");
  const resolvedPath = resolve(path);
  const fileName = basename(resolvedPath);
  if (fileName.length === 0 || fileName === "." || fileName === "..") fail("OBJECT_TRANSFER_RECEIPT_PATH_INVALID");
  const parent = await ensurePrivateDirectory(dirname(resolvedPath));
  try {
    await lstat(join(parent, fileName));
    fail("OBJECT_TRANSFER_RECEIPT_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** Private, immutable and crash-durable filesystem implementation of get/put. */
export function createLocalObjectTransferCheckpointStore({
  directory = defaultObjectTransferCheckpointDirectory(),
} = {}) {
  if (process.platform === "win32") checkpointFail("OBJECT_TRANSFER_CHECKPOINT_PRIVATE_STORAGE_UNAVAILABLE");
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    fail("OBJECT_TRANSFER_CHECKPOINT_DIRECTORY_INVALID");
  }
  let directoryPromise;
  const getDirectory = () => {
    directoryPromise ??= ensurePrivateDirectory(directory);
    return directoryPromise;
  };
  return Object.freeze({
    async get({ sourceManifestSha256, key }) {
      if (!fixedSha256(sourceManifestSha256)) checkpointFail("OBJECT_TRANSFER_CHECKPOINT_INVALID");
      try { validateKey(key); } catch { checkpointFail("OBJECT_TRANSFER_CHECKPOINT_INVALID"); }
      const root = await getDirectory();
      return readCheckpointFile(root, checkpointName(sourceManifestSha256, key), { sourceManifestSha256, key });
    },

    async put(input) {
      const { checkpoint, bytes } = serializeCheckpoint(input);
      const root = await getDirectory();
      const name = checkpointName(checkpoint.sourceManifestSha256, checkpoint.key);
      const finalPath = join(root, `${name}.json`);
      const tempPath = join(root, `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
      let handle;
      try {
        handle = await open(tempPath, "wx", 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = null;
        try {
          await link(tempPath, finalPath);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          const existing = await readCheckpointFile(root, name, {
            sourceManifestSha256: checkpoint.sourceManifestSha256,
            key: checkpoint.key,
          });
          if (!existing || !Buffer.from(encoder.encode(JSON.stringify(existing))).equals(Buffer.from(bytes))) {
            checkpointFail("OBJECT_TRANSFER_CHECKPOINT_CONFLICT");
          }
          return;
        }
        await syncDirectory(root);
      } catch (error) {
        if (error instanceof LocalObjectTransferCheckpointError) throw error;
        checkpointFail("OBJECT_TRANSFER_CHECKPOINT_UNAVAILABLE");
      } finally {
        await handle?.close().catch(() => undefined);
        await unlink(tempPath).catch(() => undefined);
      }
    },
  });
}

export function buildLocalR2WranglerConfig({ bucketName, workerEntrypoint = WORKER_ENTRYPOINT } = {}) {
  const bucket = validateBucketName(bucketName);
  if (typeof workerEntrypoint !== "string" || !isAbsolute(workerEntrypoint)) {
    fail("LOCAL_R2_WORKER_ENTRYPOINT_INVALID");
  }
  return Object.freeze({
    name: "tibotattle-local-r2-source-bridge",
    main: workerEntrypoint,
    compatibility_date: DEFAULT_COMPATIBILITY_DATE,
    r2_buckets: Object.freeze([Object.freeze({
      binding: "TRANSFER_SOURCE_BUCKET",
      bucket_name: bucket,
      remote: true,
    })]),
  });
}

async function availableLoopbackPort() {
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once("error", () => reject(new LocalR2SourceHarnessError("LOCAL_R2_PORT_UNAVAILABLE")));
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close((error) => {
        if (error || !Number.isSafeInteger(port)) reject(new LocalR2SourceHarnessError("LOCAL_R2_PORT_UNAVAILABLE"));
        else resolvePort(port);
      });
    });
  });
}

function processExit(child) {
  return new Promise(resolveExit => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
    child.once("error", () => resolveExit({ code: null, signal: null }));
  });
}

async function waitForWorker(source, child, exitPromise, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) fail("LOCAL_R2_WRANGLER_EXITED");
    const exited = await Promise.race([exitPromise.then(() => true), delay(100).then(() => false)]);
    if (exited) fail("LOCAL_R2_WRANGLER_EXITED");
    if (await source.health()) return;
  }
  fail("LOCAL_R2_WRANGLER_STARTUP_TIMEOUT");
}

async function stopChild(child, exitPromise) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch { return; }
  const terminated = await Promise.race([exitPromise.then(() => true), delay(5_000).then(() => false)]);
  if (!terminated) {
    try { child.kill("SIGKILL"); } catch { /* The process may have exited. */ }
    await Promise.race([exitPromise, delay(5_000)]);
  }
}

/**
 * Start a local Wrangler dev Worker with only a remote R2 read binding. This
 * does not deploy Worker code: `wrangler dev` runs on loopback; only the R2
 * binding is remote. The returned source and checkpoint store plug directly
 * into runPostgresObjectTransferRehearsal. Wrangler's non-interactive remote
 * binding needs CLOUDFLARE_API_TOKEN in its inherited environment; absence
 * fails with LOCAL_R2_CLOUDFLARE_API_TOKEN_REQUIRED, and the value is never
 * written to the harness config, dev vars, or logs.
 */
export async function startLocalR2TransferSession({
  bucketName,
  checkpointDirectory = defaultObjectTransferCheckpointDirectory(),
  port,
  wranglerPath = join(WORKER_ROOT, "node_modules", ".bin", "wrangler"),
  workerEntrypoint = WORKER_ENTRYPOINT,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  spawnImpl = spawn,
  temporaryRoot = tmpdir(),
  wranglerEnvironment = process.env,
} = {}) {
  const bucket = validateBucketName(bucketName);
  const checkpoints = createLocalObjectTransferCheckpointStore({ directory: checkpointDirectory });
  if (typeof wranglerEnvironment !== "object" || wranglerEnvironment === null
      || typeof wranglerEnvironment.CLOUDFLARE_API_TOKEN !== "string"
      || wranglerEnvironment.CLOUDFLARE_API_TOKEN.trim().length === 0) {
    fail("LOCAL_R2_CLOUDFLARE_API_TOKEN_REQUIRED");
  }
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1_000 || startupTimeoutMs > 120_000) {
    fail("LOCAL_R2_STARTUP_TIMEOUT_INVALID");
  }
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) {
    fail("LOCAL_R2_PORT_INVALID");
  }
  if (typeof spawnImpl !== "function" || typeof temporaryRoot !== "string" || !isAbsolute(temporaryRoot)) {
    fail("LOCAL_R2_LAUNCHER_INVALID");
  }
  const chosenPort = port ?? await availableLoopbackPort();
  let runtimeDirectory;
  let child;
  let exitPromise;
  try {
    await access(wranglerPath);
    runtimeDirectory = await mkdtemp(join(temporaryRoot, "tibotattle-r2-source-"));
    await chmod(runtimeDirectory, 0o700);
    const token = randomBytes(32).toString("base64url");
    const config = buildLocalR2WranglerConfig({ bucketName: bucket, workerEntrypoint });
    const configPath = join(runtimeDirectory, "wrangler.jsonc");
    const variablesPath = join(runtimeDirectory, ".dev.vars");
    const wranglerLogPath = join(runtimeDirectory, "wrangler.log");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(variablesPath, `LOCAL_R2_SOURCE_TOKEN=${token}\n`, { mode: 0o600, flag: "wx" });
    const source = createLocalR2TransferSource({ url: `http://127.0.0.1:${chosenPort}`, token });
    child = spawnImpl(wranglerPath, [
      "dev", "--config", configPath, "--ip", "127.0.0.1", "--port", String(chosenPort),
      "--log-level", "error", "--show-interactive-dev-session=false",
    ], {
      cwd: runtimeDirectory,
      env: {
        ...wranglerEnvironment,
        WRANGLER_LOG_PATH: wranglerLogPath,
        WRANGLER_LOG_SANITIZE: "true",
        WRANGLER_LOG: "error",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_SEND_ERROR_REPORTS: "false",
      },
      stdio: "ignore",
      windowsHide: true,
    });
    exitPromise = processExit(child);
    await waitForWorker(source, child, exitPromise, startupTimeoutMs);
    return Object.freeze({
      source,
      checkpoints,
      url: `http://127.0.0.1:${chosenPort}`,
      async close() {
        await stopChild(child, exitPromise);
        await rm(runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
      },
    });
  } catch (error) {
    if (child && exitPromise) await stopChild(child, exitPromise);
    if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof LocalR2SourceHarnessError || error instanceof LocalObjectTransferCheckpointError) throw error;
    fail("LOCAL_R2_WRANGLER_UNAVAILABLE");
  }
}

/** Compose the loopback R2 source, durable checkpoint journal, rehearsal, and optional private receipt file. */
export async function runLocalR2TransferRehearsal({
  bucketName,
  target,
  options,
  checkpointDirectory = defaultObjectTransferCheckpointDirectory(),
  receiptFile,
  ...sessionOptions
} = {}) {
  if (!target || typeof target.listPage !== "function" || typeof target.head !== "function"
      || typeof target.openRead !== "function" || typeof target.putIfAbsent !== "function") {
    fail("OBJECT_TRANSFER_TARGET_ADAPTER_INVALID");
  }
  if (receiptFile !== undefined) await preflightPrivateReceiptPath(receiptFile);
  const session = await startLocalR2TransferSession({
    ...sessionOptions,
    bucketName,
    checkpointDirectory,
  });
  try {
    const receipt = normalizeRehearsalReceipt(await runPostgresObjectTransferRehearsal({
      source: session.source,
      target,
      checkpoints: session.checkpoints,
      options,
    }));
    if (receiptFile !== undefined) await writePrivateRehearsalReceipt(receiptFile, receipt);
    return receipt;
  } finally {
    await session.close();
  }
}
