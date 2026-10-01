import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import {
  durablePrivateJson,
  identityDigest,
  openOperation,
  operationError,
} from "../../../scripts/lib/release-operation.mjs";
import { createProductionDeploymentLock } from "./production-deployment-lock.mjs";
import {
  createProductionLiveConfigSnapshot,
  PRODUCTION_LIVE_CONFIG_SCHEMA,
} from "./production-live-config.mjs";
import { createProductionLiveProvider } from "./production-live-provider.mjs";

export const PRODUCTION_COLLECTION_CONTROL_SCHEMA =
  "production-collection-control-v1";
export const PRODUCTION_COLLECTION_OPERATION_SCHEMA =
  "production-collection-control-operation-v1";
export const PRODUCTION_COLLECTION_CONFIRMATION =
  "CONTAIN_PRODUCTION_COLLECTION";
export const PRODUCTION_RESTORE_CONFIRMATION =
  "RESTORE_PRODUCTION_COLLECTION";
export const PRODUCTION_COLLECTION_ADMIN_ORIGIN =
  DEPLOYMENT_ENDPOINTS.admin.origin;
export const COLLECTION_CONTROL_QUERY = `SELECT schema_version,
       control_state,
       revision,
       enrollment_enabled,
       upload_registration_enabled,
       processing_enabled,
       publication_enabled
  FROM collection_controls
 WHERE singleton = 1`;
export const TELEMETRY_V12_RUNTIME_QUERY =
  "SELECT state FROM telemetry_v12_runtime WHERE id = 1";
export const PRODUCTION_COLLECTION_SUCCESSOR_SCHEMA =
  "production-collection-control-successor-v1";
export const PRODUCTION_COLLECTION_PUBLICATION_SCHEMA =
  "production-collection-control-publication-v1";

const MAX_JSON_BYTES = 1_024 * 1_024;
const ACCOUNT = /^[a-f0-9]{32}$/u;
const WORKER = /^[A-Za-z0-9_-]{1,63}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const PUBLICATION_TEMP = /^\.collection-control-[a-f0-9-]{36}\.json$/u;
const ISO = value => typeof value === "string"
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const FLAGS = [
  "enrollment",
  "uploadRegistration",
  "processing",
  "publication",
];
const CONTROL_KEYS = [
  "schemaVersion",
  "state",
  "revision",
  ...FLAGS,
];
const ADMIN_SESSION_SCHEMA = "production-collection-control-admin-session-v1";

function fail(code) {
  throw operationError(`PRODUCTION_COLLECTION_CONTROL_${code}`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return object(value)
    && Object.keys(value).sort().join("\0")
      === [...expected].sort().join("\0");
}

function clone(value, code = "VALUE_INVALID") {
  try {
    const copy = structuredClone(value);
    const encoded = JSON.stringify(copy);
    if (typeof encoded !== "string"
        || Buffer.byteLength(encoded) > MAX_JSON_BYTES) fail(code);
    return copy;
  } catch (error) {
    if (error?.code?.startsWith("PRODUCTION_COLLECTION_CONTROL_")) throw error;
    fail(code);
  }
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bytesHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeAbsolutePath(value) {
  return typeof value === "string"
    && value.length <= 4096
    && !/[\0\r\n]/u.test(value)
    && isAbsolute(value);
}

function validateControls(value, code = "CONTROL_READ_INVALID") {
  if (!exactKeys(value, CONTROL_KEYS)
      || value.schemaVersion !== "collection-controls-v0.1"
      || !["operational", "degraded", "contained"].includes(value.state)
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || FLAGS.some(name => typeof value[name] !== "boolean")) {
    fail(code);
  }
  const enabled = FLAGS.filter(name => value[name]).length;
  if ((value.state === "operational" && enabled !== 4)
      || (value.state === "contained" && enabled !== 0)
      || (value.state === "degraded" && (enabled === 0 || enabled === 4))) {
    fail(code);
  }
  return Object.freeze(clone(value, code));
}

function controlsFromD1(row) {
  if (!exactKeys(row, [
    "control_state",
    "enrollment_enabled",
    "processing_enabled",
    "publication_enabled",
    "revision",
    "schema_version",
    "upload_registration_enabled",
  ])
      || !["operational", "degraded", "contained"].includes(row.control_state)
      || row.schema_version !== "collection-controls-v0.1"
      || !Number.isSafeInteger(row.revision) || row.revision < 1
      || FLAGS.map(name => ({
        enrollment: row.enrollment_enabled,
        uploadRegistration: row.upload_registration_enabled,
        processing: row.processing_enabled,
        publication: row.publication_enabled,
      }[name])).some(value => value !== 0 && value !== 1)) {
    fail("CONTROL_READ_INVALID");
  }
  return validateControls({
    schemaVersion: row.schema_version,
    state: row.control_state,
    revision: row.revision,
    enrollment: row.enrollment_enabled === 1,
    uploadRegistration: row.upload_registration_enabled === 1,
    processing: row.processing_enabled === 1,
    publication: row.publication_enabled === 1,
  });
}

function targetFor(action, controls) {
  if (action === "contain") {
    return Object.freeze({
      enrollment: false,
      uploadRegistration: false,
      processing: false,
      publication: false,
    });
  }
  if (action === "restore") {
    return Object.freeze(Object.fromEntries(
      FLAGS.map(name => [name, controls[name]]),
    ));
  }
  fail("ACTION_INVALID");
}

function sameFlags(left, right) {
  return FLAGS.every(name => left?.[name] === right?.[name]);
}

function sameControls(left, right) {
  return left?.schemaVersion === right?.schemaVersion
    && left?.state === right?.state
    && left?.revision === right?.revision
    && sameFlags(left, right);
}

function validateDeployment(inventory) {
  if (!object(inventory) || !ISO(inventory.capturedAt)) fail("LIVE_CONFIG_INVALID");
  let snapshot;
  try {
    snapshot = createProductionLiveConfigSnapshot(inventory);
  } catch {
    fail("LIVE_CONFIG_INVALID");
  }
  if (snapshot.schema !== PRODUCTION_LIVE_CONFIG_SCHEMA
      || !COMMIT.test(snapshot.sourceCommit ?? "")
      || !UUID.test(snapshot.versionId ?? "")
      || !SHA256.test(snapshot.fingerprint ?? "")) {
    fail("LIVE_CONFIG_INVALID");
  }
  return Object.freeze({
    sourceCommit: snapshot.sourceCommit,
    versionId: snapshot.versionId,
    configSha256: snapshot.fingerprint,
  });
}

function sameDeployment(left, right) {
  return left?.sourceCommit === right?.sourceCommit
    && left?.versionId === right?.versionId
    && left?.configSha256 === right?.configSha256;
}

function artifactIdentity(value) {
  return {
    sourceCommit: value.sourceCommit,
    versionId: value.versionId,
    configSha256: value.configSha256,
  };
}

function validateOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail("ADMIN_SESSION_INVALID"); }
  if (parsed.protocol !== "https:"
      || parsed.origin !== value
      || parsed.pathname !== "/"
      || parsed.search || parsed.hash
      || value !== PRODUCTION_COLLECTION_ADMIN_ORIGIN) {
    fail("ADMIN_SESSION_INVALID");
  }
  return value;
}

export function validateProductionCollectionAdminSession(value) {
  if (!exactKeys(value, ["accessJwt", "cookie", "csrfToken", "origin", "schema"])
      || value.schema !== ADMIN_SESSION_SCHEMA
      || typeof value.cookie !== "string"
      || value.cookie.length < 1 || value.cookie.length > 16_384
      || /[\0\r\n]/u.test(value.cookie)
      || !/(?:^|;\s*)CF_Authorization=[^;]+/u.test(value.cookie)
      || (value.csrfToken !== null
        && (typeof value.csrfToken !== "string"
          || value.csrfToken.length < 1 || value.csrfToken.length > 96
          || /[\0\r\n]/u.test(value.csrfToken)))
      || (value.accessJwt !== null
        && (typeof value.accessJwt !== "string"
          || value.accessJwt.length < 1 || value.accessJwt.length > 16_384
          || /[\0\r\n]/u.test(value.accessJwt)))) {
    fail("ADMIN_SESSION_INVALID");
  }
  validateOrigin(value.origin);
  return value;
}

async function readOwnerPrivateJson(path, { mode = 0o600 } = {}) {
  if (!safeAbsolutePath(path)) fail("PRIVATE_FILE_INVALID");
  let info;
  try { info = await lstat(path); } catch { fail("PRIVATE_FILE_INVALID"); }
  try {
    if (await realpath(path) !== resolve(path)) fail("PRIVATE_FILE_INVALID");
  } catch { fail("PRIVATE_FILE_INVALID"); }
  if (!info.isFile() || info.nlink !== 1
      || (process.getuid && info.uid !== process.getuid())
      || (info.mode & 0o777) !== mode
      || info.size < 1 || info.size > MAX_JSON_BYTES) {
    fail("PRIVATE_FILE_INVALID");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("PRIVATE_FILE_INVALID");
  }
  let bytes;
  try {
    const current = await handle.stat();
    if (current.ino !== info.ino || current.dev !== info.dev
        || current.nlink !== 1 || current.size !== info.size) {
      fail("PRIVATE_FILE_INVALID");
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.length !== info.size) fail("PRIVATE_FILE_INVALID");
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail("PRIVATE_FILE_INVALID"); }
}

export async function readProductionCollectionAdminSession(path) {
  const session = await readOwnerPrivateJson(path, { mode: 0o600 });
  return validateProductionCollectionAdminSession(session);
}

export async function readProductionCollectionSuccessorArtifact(path) {
  const artifact = await readOwnerPrivateJson(path, { mode: 0o600 });
  return validateProductionCollectionSuccessorArtifact(artifact);
}

async function assertPrivateDirectory(directory) {
  if (!safeAbsolutePath(directory)) fail("PATH_INVALID");
  let info;
  try { info = await lstat(directory); } catch { fail("PATH_INVALID"); }
  let canonical;
  try { canonical = await realpath(directory); } catch { fail("PATH_INVALID"); }
  if (canonical !== resolve(directory)
      || !info.isDirectory() || (info.mode & 0o777) !== 0o700
      || (process.getuid && info.uid !== process.getuid())) {
    fail("PATH_INVALID");
  }
}

async function privateBytes(path, { mode = 0o600, nlink = 1 } = {}) {
  if (!safeAbsolutePath(path)) fail("RECEIPT_INVALID");
  let info;
  try { info = await lstat(path); } catch { fail("RECEIPT_INVALID"); }
  let canonical;
  try { canonical = await realpath(path); } catch { fail("RECEIPT_INVALID"); }
  if (canonical !== resolve(path)
      || !info.isFile() || info.nlink !== nlink
      || (process.getuid && info.uid !== process.getuid())
      || (info.mode & 0o777) !== mode
      || info.size < 1 || info.size > MAX_JSON_BYTES) {
    fail("RECEIPT_INVALID");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("RECEIPT_INVALID");
  }
  let bytes;
  try {
    const current = await handle.stat();
    if (current.ino !== info.ino || current.dev !== info.dev
        || current.nlink !== nlink || current.size !== info.size) {
      fail("RECEIPT_INVALID");
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.length !== info.size) fail("RECEIPT_INVALID");
  return bytes;
}

const PUBLICATION_NAMES = new Set([
  "contain-intent.json",
  "restore-intent.json",
  "contained-result.json",
  "restored-result.json",
]);

function validatePublicationDescriptor(
  value,
  { operationDirectory = null, name = null, sha256 = null, bytesLength = null } = {},
) {
  if (!exactKeys(value, [
    "bytesLength", "bytesSha256", "destination", "name", "schema", "tempPath",
  ])
      || value.schema !== PRODUCTION_COLLECTION_PUBLICATION_SCHEMA
      || !PUBLICATION_NAMES.has(value.name)
      || !safeAbsolutePath(value.destination)
      || basename(value.destination) !== value.name
      || !safeAbsolutePath(value.tempPath)
      || !PUBLICATION_TEMP.test(basename(value.tempPath))
      || dirname(value.tempPath) !== dirname(value.destination)
      || !Number.isSafeInteger(value.bytesLength)
      || value.bytesLength < 1 || value.bytesLength > MAX_JSON_BYTES
      || !SHA256.test(value.bytesSha256 ?? "")) {
    fail("JOURNAL_INVALID");
  }
  if (operationDirectory !== null
      && value.destination !== join(resolve(operationDirectory), value.name)) {
    fail("JOURNAL_INVALID");
  }
  if (name !== null && value.name !== name) fail("RECEIPT_INVALID");
  if (sha256 !== null && value.bytesSha256 !== sha256) fail("RECEIPT_INVALID");
  if (bytesLength !== null && value.bytesLength !== bytesLength) fail("RECEIPT_INVALID");
  return value;
}

function newPublicationDescriptor(operationDirectory, name, bytes) {
  const destination = join(resolve(operationDirectory), name);
  return {
    schema: PRODUCTION_COLLECTION_PUBLICATION_SCHEMA,
    name,
    destination,
    tempPath: join(dirname(destination), `.collection-control-${randomUUID()}.json`),
    bytesLength: bytes.length,
    bytesSha256: bytesHash(bytes),
  };
}

async function readExisting(path) {
  try { return await lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("RECEIPT_INVALID");
  }
}

async function syncPrivateDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function createPublicationTemp(path, bytes) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncPrivateDirectory(dirname(path));
  return true;
}

async function reconcilePublication(
  publication,
  value,
  bytes,
  attempt = 0,
  onPublicationLinked = null,
) {
  validatePublicationDescriptor(publication, {
    name: publication.name,
    sha256: bytesHash(bytes),
    bytesLength: bytes.length,
  });
  const destination = publication.destination;
  const temporary = publication.tempPath;
  const destinationInfo = await readExisting(destination);
  const temporaryInfo = await readExisting(temporary);
  if (destinationInfo) {
    let destinationBytes;
    if (destinationInfo.nlink === 1) {
      destinationBytes = await privateBytes(destination);
    } else if (destinationInfo.nlink === 2 && temporaryInfo
        && temporaryInfo.nlink === 2
        && destinationInfo.ino === temporaryInfo.ino
        && destinationInfo.dev === temporaryInfo.dev) {
      destinationBytes = await privateBytes(destination, { nlink: 2 });
      const temporaryBytes = await privateBytes(temporary, { nlink: 2 });
      if (Buffer.compare(temporaryBytes, bytes) !== 0) fail("RECEIPT_EXISTS");
    } else {
      // A destination with an unexpected link count is never adopted. The
      // journal-bound temporary path must be the exact linked inode.
      fail("RECEIPT_INVALID");
    }
    if (Buffer.compare(destinationBytes, bytes) !== 0) fail("RECEIPT_EXISTS");
    if (temporaryInfo) {
      if (temporaryInfo.nlink !== 1 && !(destinationInfo.nlink === 2
          && temporaryInfo.nlink === 2
          && destinationInfo.ino === temporaryInfo.ino
          && destinationInfo.dev === temporaryInfo.dev)) {
        fail("RECEIPT_INVALID");
      }
      if (temporaryInfo.nlink === 1) {
        const temporaryBytes = await privateBytes(temporary);
        if (Buffer.compare(temporaryBytes, bytes) !== 0) fail("RECEIPT_EXISTS");
      }
      await unlink(temporary);
      await syncPrivateDirectory(dirname(destination));
    }
    await privateBytes(destination);
    return bytesHash(bytes);
  }
  if (temporaryInfo) {
    if (temporaryInfo.nlink !== 1) fail("RECEIPT_INVALID");
    const temporaryBytes = await privateBytes(temporary);
    if (Buffer.compare(temporaryBytes, bytes) !== 0) fail("RECEIPT_EXISTS");
    try {
      await link(temporary, destination);
      await syncPrivateDirectory(dirname(destination));
      await chmod(destination, 0o600);
      if (onPublicationLinked !== null) {
        await onPublicationLinked({
          destination,
          temporary,
          bytesSha256: bytesHash(bytes),
        });
      }
    } catch (error) {
      if (error?.code === "EEXIST" && attempt === 0) {
        return reconcilePublication(
          publication,
          value,
          bytes,
          attempt + 1,
          onPublicationLinked,
        );
      }
      if (error?.code === "EEXIST") fail("RECEIPT_EXISTS");
      throw error;
    }
    await unlink(temporary);
    await syncPrivateDirectory(dirname(destination));
    await privateBytes(destination);
    return bytesHash(bytes);
  }
  const created = await createPublicationTemp(temporary, bytes);
  if (!created && attempt === 0) {
    return reconcilePublication(publication, value, bytes, attempt + 1, onPublicationLinked);
  }
  if (!created) fail("RECEIPT_EXISTS");
  return reconcilePublication(publication, value, bytes, attempt, onPublicationLinked);
}

async function writePrivateNoClobber(
  path,
  value,
  { expectedSha256 = null, publication = null, onPublicationLinked = null } = {},
) {
  await assertPrivateDirectory(dirname(path));
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.length > MAX_JSON_BYTES) fail("RECEIPT_INVALID");
  const actualSha256 = bytesHash(bytes);
  if (expectedSha256 !== null && expectedSha256 !== actualSha256) {
    fail("RECEIPT_INVALID");
  }
  if (publication !== null) {
    validatePublicationDescriptor(publication, {
      operationDirectory: dirname(path),
      name: basename(path),
      sha256: actualSha256,
      bytesLength: bytes.length,
    });
    if (onPublicationLinked !== null && typeof onPublicationLinked !== "function") {
      fail("RECEIPT_INVALID");
    }
    // The journal has already persisted publication before entering this
    // path. A retry can therefore identify and repair a linked temp inode.
    const result = await reconcilePublication(
      publication,
      value,
      bytes,
      0,
      onPublicationLinked,
    );
    return result;
  }
  let existing;
  try { existing = await lstat(path); } catch (error) {
    if (error?.code !== "ENOENT") fail("RECEIPT_INVALID");
  }
  if (existing) {
    const existingBytes = await privateBytes(path);
    if (Buffer.compare(existingBytes, bytes) !== 0) fail("RECEIPT_EXISTS");
    return actualSha256;
  }
  const temporary = join(dirname(path), `.collection-control-${randomUUID()}.json`);
  await durablePrivateJson(temporary, clone(value, "RECEIPT_INVALID"));
  try {
    await link(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    await chmod(path, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") fail("RECEIPT_EXISTS");
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return actualSha256;
}

function sessionHeaders(session, method = "GET") {
  return {
    accept: "application/json",
    "cache-control": "no-store",
    cookie: session.cookie,
    ...(method === "POST" ? {
      "content-type": "application/json",
      origin: session.origin,
      "sec-fetch-site": "same-origin",
      "x-usage-monitor-admin": "1",
      ...(session.csrfToken === null
        ? {}
        : { "x-usage-monitor-csrf": session.csrfToken }),
    } : {}),
    ...(session.accessJwt === null
      ? {}
      : { "cf-access-jwt-assertion": session.accessJwt }),
  };
}

async function responseJson(response, code) {
  let bytes;
  try { bytes = new Uint8Array(await response.arrayBuffer()); }
  catch { fail(code); }
  if (bytes.length > MAX_JSON_BYTES) fail(code);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { fail(code); }
}

async function readAdminOverview({ session, fetchImpl = globalThis.fetch }) {
  validateProductionCollectionAdminSession(session);
  let response;
  try {
    response = await fetchImpl(
      `${session.origin}/api/v1/admin/overview`,
      {
        method: "GET",
        headers: sessionHeaders(session),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch { fail("ADMIN_RESPONSE_UNCERTAIN"); }
  const body = await responseJson(response, "ADMIN_RESPONSE_UNCERTAIN");
  if (!response.ok || !object(body)
      || body.schemaVersion !== "admin-overview-v0.5"
      || !Object.hasOwn(body, "collection")) {
    fail("ADMIN_OVERVIEW_REFUSED");
  }
  return validateControls(body.collection);
}

async function postAdmin({ session, request, fetchImpl = globalThis.fetch }) {
  validateProductionCollectionAdminSession(session);
  let response;
  try {
    response = await fetchImpl(
      `${session.origin}/api/v1/admin/action`,
      {
        method: "POST",
        headers: sessionHeaders(session, "POST"),
        body: JSON.stringify(request),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch { fail("ADMIN_RESPONSE_UNCERTAIN"); }
  const body = await responseJson(response, "ADMIN_RESPONSE_UNCERTAIN");
  if (response.status === 409) fail("ADMIN_ACTION_CONFLICT");
  if (!response.ok || !exactKeys(body, ["action", "collection", "schemaVersion"])
      || body.schemaVersion !== "admin-action-v0.1"
      || body.action !== "set_collection_controls") {
    fail("ADMIN_RESPONSE_REFUSED");
  }
  return validateControls(body.collection);
}

function databaseId(inventory) {
  const bindings = inventory?.version?.resources?.bindings;
  if (!Array.isArray(bindings)) fail("D1_BINDING_INVALID");
  const matches = bindings.filter(binding => binding?.name === "USAGE_MONITOR_DB");
  const binding = matches[0];
  const ids = [binding?.id, binding?.database_id].filter(value => value !== undefined);
  if (matches.length !== 1 || binding?.type !== "d1"
      || ids.length === 0 || ids.some(value => !UUID.test(value))
      || new Set(ids).size !== 1) {
    fail("D1_BINDING_INVALID");
  }
  return ids[0];
}

function queryRows(body) {
  if (!object(body) || body.success !== true) fail("D1_READ_REFUSED");
  const result = Array.isArray(body.result) && body.result.length === 1
    ? body.result[0]
    : null;
  if (!object(result) || result.success !== true
      || !Array.isArray(result.results) || result.results.length !== 1) {
    fail("D1_READ_INVALID");
  }
  return result.results[0];
}

async function readD1({ accountId, inventory, query, environment, fetchImpl }) {
  const token = environment?.CLOUDFLARE_API_TOKEN;
  if (typeof token !== "string" || token.length < 16) fail("CREDENTIAL_REQUIRED");
  if (inventory?.accountId !== accountId) fail("D1_BINDING_INVALID");
  const id = databaseId(inventory);
  let response;
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${id}/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql: query, params: [] }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch { fail("D1_READ_UNCERTAIN"); }
  return queryRows(await responseJson(response, "D1_READ_UNCERTAIN"));
}

async function readControlD1({ accountId, inventory, environment, fetchImpl, d1Read }) {
  const row = d1Read
    ? await d1Read({ accountId, inventory, query: COLLECTION_CONTROL_QUERY })
    : await readD1({ accountId, inventory, query: COLLECTION_CONTROL_QUERY, environment, fetchImpl });
  return validateControls(row?.schemaVersion ? row : controlsFromD1(row));
}

async function readRuntimeD1({ accountId, inventory, environment, fetchImpl, d1Read }) {
  const row = d1Read
    ? await d1Read({ accountId, inventory, query: TELEMETRY_V12_RUNTIME_QUERY })
    : await readD1({ accountId, inventory, query: TELEMETRY_V12_RUNTIME_QUERY, environment, fetchImpl });
  if (!exactKeys(row, ["state"]) || row.state !== "staged") {
    fail("RUNTIME_NOT_STAGED");
  }
  return row.state;
}

async function observe({
  accountId,
  inventory,
  environment,
  fetchImpl,
  session,
  d1Read,
  adminRead,
}) {
  const controls = await readControlD1({
    accountId, inventory, environment, fetchImpl, d1Read,
  });
  const overview = session !== null
    ? await readAdminOverview({ session, fetchImpl })
    : typeof adminRead === "function" ? validateControls(await adminRead()) : null;
  if (overview !== null && !sameControls(controls, overview)) {
    fail("OVERVIEW_D1_MISMATCH");
  }
  return controls;
}

function requestFor(action, expectedRevision, flags) {
  return {
    action: "set_collection_controls",
    expectedRevision,
    enrollment: flags.enrollment,
    uploadRegistration: flags.uploadRegistration,
    processing: flags.processing,
    publication: flags.publication,
    reasonCode: "maintenance",
  };
}

function deploymentIdentityShape(value, code = "JOURNAL_INVALID") {
  if (!exactKeys(value, ["configSha256", "sourceCommit", "versionId"])
      || !COMMIT.test(value.sourceCommit ?? "")
      || !UUID.test(value.versionId ?? "")
      || !SHA256.test(value.configSha256 ?? "")) {
    fail(code);
  }
  return value;
}

function successorUnsigned(value) {
  const { proofSha256: _proofSha256, ...unsigned } = value;
  return unsigned;
}

export function validateProductionCollectionSuccessorArtifact(value) {
  if (!exactKeys(value, [
    "capturedAt", "configSha256", "controls", "proofSha256", "runtimeState",
    "schema", "sourceCommit", "versionId",
  ])
      || value.schema !== PRODUCTION_COLLECTION_SUCCESSOR_SCHEMA
      || !ISO(value.capturedAt)
      || !COMMIT.test(value.sourceCommit ?? "")
      || !UUID.test(value.versionId ?? "")
      || !SHA256.test(value.configSha256 ?? "")
      || value.runtimeState !== "staged"
      || !SHA256.test(value.proofSha256 ?? "")) {
    fail("SUCCESSOR_ARTIFACT_INVALID");
  }
  validateControls(value.controls);
  if (value.controls.state !== "contained" || !FLAGS.every(name => !value.controls[name])) {
    fail("SUCCESSOR_ARTIFACT_INVALID");
  }
  if (identityDigest(successorUnsigned(value)) !== value.proofSha256) {
    fail("SUCCESSOR_ARTIFACT_INVALID");
  }
  return value;
}

function validateApprovedSuccessor(artifact, approvedSha256) {
  validateProductionCollectionSuccessorArtifact(artifact);
  if (typeof approvedSha256 !== "string"
      || !SHA256.test(approvedSha256)
      || artifact.proofSha256 !== approvedSha256) {
    fail("SUCCESSOR_APPROVAL_INVALID");
  }
  return artifact;
}

function receiptValue(result) {
  return {
    schema: PRODUCTION_COLLECTION_CONTROL_SCHEMA,
    ...clone(result, "RECEIPT_INVALID"),
  };
}

function receiptDescriptor(name, value) {
  if (!new Set(["contained-result.json", "restored-result.json"]).has(name)) {
    fail("RECEIPT_INVALID");
  }
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.length > MAX_JSON_BYTES) fail("RECEIPT_INVALID");
  return Object.freeze({ name, sha256: bytesHash(bytes) });
}

function validateReceiptDescriptor(value) {
  if (!exactKeys(value, ["name", "sha256"])
      || !new Set(["contained-result.json", "restored-result.json"]).has(value.name)
      || !SHA256.test(value.sha256 ?? "")) {
    fail("JOURNAL_INVALID");
  }
  return value;
}

function validateCompletedResult(value) {
  if (!exactKeys(value, [
    "action", "coordination", "revision", "schema", "state", "status", "target",
  ])
      || value.schema !== PRODUCTION_COLLECTION_CONTROL_SCHEMA
      || value.status !== "completed"
      || !["contain", "restore"].includes(value.action)
      || value.coordination !== "released"
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !["operational", "degraded", "contained"].includes(value.state)
      || !exactKeys(value.target, FLAGS)
      || FLAGS.some(name => typeof value.target[name] !== "boolean")) {
    fail("JOURNAL_INVALID");
  }
  return value;
}

function validateIntent(intent) {
  if (!exactKeys(intent, [
    "action", "expectedRevision", "identity", "request", "requestSha256", "targetRevision",
  ]) || !["contain", "restore"].includes(intent.action)
      || !Number.isSafeInteger(intent.expectedRevision)
      || !Number.isSafeInteger(intent.targetRevision)
      || intent.targetRevision !== intent.expectedRevision + 1
      || !exactKeys(intent.request, [
        "action", "enrollment", "expectedRevision", "processing", "publication",
        "reasonCode", "uploadRegistration",
      ])
      || intent.request.action !== "set_collection_controls"
      || intent.request.expectedRevision !== intent.expectedRevision
      || intent.request.reasonCode !== "maintenance"
      || !FLAGS.every(name => typeof intent.request[name] === "boolean")
      || !SHA256.test(intent.requestSha256)
      || hash(intent.request) !== intent.requestSha256) {
    fail("JOURNAL_INVALID");
  }
  deploymentIdentityShape(intent.identity);
  return intent;
}

function validateState(state, { operationDirectory = null } = {}) {
  if (!exactKeys(state, [
    "before", "contained", "coordination", "initialIdentity", "intent", "owner",
    "phase", "publication", "receipt", "restore", "result", "schema", "successor",
    "transport",
  ])
      || state.schema !== PRODUCTION_COLLECTION_OPERATION_SCHEMA
      || !/^[a-f0-9]{40}$/u.test(state.owner)
      || !["browser", "session"].includes(state.transport)
      || !["containing", "contained", "restoring", "restored"].includes(state.phase)
      || !["acquire_intent", "held", "release_intent", "released"].includes(state.coordination)
      || !deploymentIdentityShape(state.initialIdentity)
      || (state.intent !== null && validateIntent(state.intent) === null)
      || (state.result !== null && validateCompletedResult(state.result) === null)
      || (state.receipt !== null && validateReceiptDescriptor(state.receipt) === null)
      || (state.publication !== null
        && validatePublicationDescriptor(state.publication, { operationDirectory }) === null)
      || (state.successor !== null && validateProductionCollectionSuccessorArtifact(state.successor) === null)) {
    fail("JOURNAL_INVALID");
  }
  for (const entry of [state.before, state.contained, state.restore]) {
    if (entry === null) continue;
    if (!exactKeys(entry, ["controls", "identity"])
        || !validateControls(entry.controls)
        || !deploymentIdentityShape(entry.identity)) {
      fail("JOURNAL_INVALID");
    }
  }
  if (state.before !== null && !sameDeployment(state.before.identity, state.initialIdentity)) {
    fail("JOURNAL_INVALID");
  }
  if (state.successor !== null
      && (state.contained === null
        || !sameControls(state.successor.controls, state.contained.controls))) {
    fail("JOURNAL_INVALID");
  }
  if (state.intent !== null) {
    if (state.intent.action === "contain"
        && (state.before === null
          || !sameDeployment(state.intent.identity, state.before.identity))) {
      fail("JOURNAL_INVALID");
    }
    if (state.intent.action === "restore"
        && (state.successor === null
          || !sameDeployment(state.intent.identity, artifactIdentity(state.successor)))) {
      fail("JOURNAL_INVALID");
    }
  }
  if (state.result !== null) {
    const expectedReceiptName = state.result.action === "contain"
      ? "contained-result.json" : "restored-result.json";
    if (state.receipt === null
        || state.receipt.name !== expectedReceiptName
        || receiptDescriptor(expectedReceiptName, receiptValue(state.result)).sha256
          !== state.receipt.sha256) {
      fail("JOURNAL_INVALID");
    }
    if (state.result.action === "contain"
        && (state.contained === null
          || !sameDeployment(state.contained.identity, state.before?.identity))) {
      fail("JOURNAL_INVALID");
    }
    if (state.result.action === "restore"
        && (state.restore === null || state.successor === null
          || !sameDeployment(state.restore.identity, artifactIdentity(state.successor)))) {
      fail("JOURNAL_INVALID");
    }
  }
  if (state.coordination === "release_intent") {
    if (state.result === null || state.receipt === null || state.intent !== null) {
      fail("JOURNAL_INVALID");
    }
  }
  if (state.coordination === "released"
      && (state.result === null || state.receipt === null || state.intent !== null)) {
    fail("JOURNAL_INVALID");
  }
  return state;
}

function lockOwnerInput(operationId, identity) {
  return {
    id: operationId,
    sourceCommit: identity.sourceCommit,
    previousSourceCommit: identity.sourceCommit,
  };
}

function operationBinding({ accountId, workerName }) {
  return {
    schema: PRODUCTION_COLLECTION_OPERATION_SCHEMA,
    accountId,
    workerName,
    adminOrigin: PRODUCTION_COLLECTION_ADMIN_ORIGIN,
  };
}

function actionRequiredResult(action, expectedRevision, target) {
  return {
    schema: PRODUCTION_COLLECTION_CONTROL_SCHEMA,
    status: "action_required",
    action,
    origin: PRODUCTION_COLLECTION_ADMIN_ORIGIN,
    path: "/api/v1/admin/action",
    expectedRevision,
    target: Object.freeze({ ...target }),
    reasonCode: "maintenance",
    note: "Apply this exact revision-checked action in the owner-only admin UI, then run read-only reconcile.",
  };
}

function completedResult(action, controls, coordination = "released") {
  return {
    schema: PRODUCTION_COLLECTION_CONTROL_SCHEMA,
    status: "completed",
    action,
    coordination,
    revision: controls.revision,
    state: controls.state,
    target: Object.freeze(Object.fromEntries(FLAGS.map(name => [name, controls[name]]))),
  };
}

async function capture(provider) {
  let inventory;
  try { inventory = await provider.capture(); }
  catch { fail("LIVE_READ_FAILED"); }
  return { inventory, identity: validateDeployment(inventory) };
}

async function writeJournalFile({
  operationDirectory,
  name,
  value,
  expectedSha256,
  state,
  operation,
  onPublicationLinked = null,
}) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.length > MAX_JSON_BYTES || bytesHash(bytes) !== expectedSha256) {
    fail("RECEIPT_INVALID");
  }
  let publication = state.publication;
  if (publication === null) {
    publication = newPublicationDescriptor(operationDirectory, name, bytes);
    state.publication = publication;
    await operation.save(state);
  } else {
    validatePublicationDescriptor(publication, {
      operationDirectory,
      name,
      sha256: expectedSha256,
      bytesLength: bytes.length,
    });
  }
  const actualSha256 = await writePrivateNoClobber(
    join(operationDirectory, name),
    value,
    {
      expectedSha256,
      publication,
      onPublicationLinked,
    },
  );
  if (actualSha256 !== expectedSha256) fail("RECEIPT_INVALID");
  state.publication = null;
  await operation.save(state);
  return value;
}

async function writeReceipt(
  operationDirectory,
  descriptor,
  result,
  state,
  operation,
  onPublicationLinked = null,
) {
  const value = receiptValue(result);
  const expected = receiptDescriptor(descriptor.name, value);
  if (expected.sha256 !== descriptor.sha256) fail("RECEIPT_INVALID");
  return writeJournalFile({
    operationDirectory,
    name: descriptor.name,
    value,
    expectedSha256: descriptor.sha256,
    state,
    operation,
    onPublicationLinked,
  });
}

async function writeIntentReceipt(
  operationDirectory,
  action,
  intent,
  state,
  operation,
  onPublicationLinked = null,
) {
  const name = action === "contain" ? "contain-intent.json" : "restore-intent.json";
  const value = {
    schema: PRODUCTION_COLLECTION_CONTROL_SCHEMA,
    action,
    expectedRevision: intent.expectedRevision,
    target: Object.fromEntries(FLAGS.map(name => [name, intent.request[name]])),
    reasonCode: "maintenance",
  };
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  await writeJournalFile({
    operationDirectory,
    name,
    value,
    expectedSha256: bytesHash(bytes),
    state,
    operation,
    onPublicationLinked,
  });
}

function terminalTransition(state, action, controls, identity) {
  const result = completedResult(action, controls);
  const phase = action === "contain" ? "contained" : "restored";
  const descriptor = receiptDescriptor(
    phase === "contained" ? "contained-result.json" : "restored-result.json",
    receiptValue(result),
  );
  state.phase = phase;
  if (action === "contain") {
    state.contained = { controls, identity };
  } else {
    state.restore = { controls, identity };
  }
  state.intent = null;
  state.result = result;
  state.receipt = descriptor;
  state.coordination = "release_intent";
  return { result, descriptor };
}

async function classifyAfterRead({
  beforeControls,
  targetControls,
  observed,
  expectedRevision,
}) {
  if (observed.revision === expectedRevision
      && sameControls(observed, beforeControls)) return "before";
  if (observed.revision === expectedRevision + 1
      && sameFlags(observed, targetControls)) return "target";
  return "ambiguous";
}

async function observeBracket({
  live,
  firstDeployment = null,
  expectedIdentity = null,
  readRuntime = false,
  accountId,
  environment,
  fetchImpl,
  session,
  d1Read,
  adminRead,
}) {
  const before = firstDeployment ?? await capture(live);
  if (expectedIdentity !== null && !sameDeployment(before.identity, expectedIdentity)) {
    fail("LIVE_DEPLOYMENT_DRIFT");
  }
  const controls = await observe({
    accountId,
    inventory: before.inventory,
    environment,
    fetchImpl,
    session,
    d1Read,
    adminRead,
  });
  if (readRuntime) {
    await readRuntimeD1({
      accountId,
      inventory: before.inventory,
      environment,
      fetchImpl,
      d1Read,
    });
  }
  const after = await capture(live);
  if (!sameDeployment(before.identity, after.identity)
      || (expectedIdentity !== null && !sameDeployment(after.identity, expectedIdentity))) {
    fail("LIVE_DEPLOYMENT_DRIFT");
  }
  return { controls, deployment: after };
}

function terminalObservationMatches(state, observed) {
  return state.result !== null
    && observed.revision === state.result.revision
    && observed.state === state.result.state
    && sameFlags(observed, state.result.target);
}

async function reconcileTerminal({
  state,
  operation,
  operationDirectory,
  lock,
  live,
  accountId,
  environment,
  fetchImpl,
  session,
  d1Read,
  adminRead,
  onPublicationLinked = null,
}) {
  validateState(state, { operationDirectory });
  if (state.coordination !== "release_intent"
      || state.result === null || state.receipt === null) {
    fail("OPERATION_STATE_INVALID");
  }
  const anchor = state.result.action === "contain"
    ? state.before?.identity
    : state.successor === null ? undefined : artifactIdentity(state.successor);
  if (anchor === undefined) fail("JOURNAL_INVALID");
  const deployment = await capture(live);
  const observation = await observeBracket({
    live,
    firstDeployment: deployment,
    expectedIdentity: anchor,
    readRuntime: state.result.action === "restore",
    accountId,
    environment,
    fetchImpl,
    session,
    d1Read,
    adminRead,
  });
  if (!terminalObservationMatches(state, observation.controls)) {
    fail("ACTION_AMBIGUOUS");
  }
  await writeReceipt(
    operationDirectory,
    state.receipt,
    state.result,
    state,
    operation,
    onPublicationLinked,
  );

  const ownerState = lock.status();
  if (ownerState !== null && ownerState !== state.owner) {
    // A different owner is never adopted and is never overwritten. The
    // operation remains release_intent until the owner is reviewed.
    fail("LOCK_NOT_OWNED");
  }
  if (ownerState === state.owner) {
    try {
      await lock.release(state.owner);
    } catch {
      if (lock.status() !== null) fail("RELEASE_UNCERTAIN");
    }
    if (lock.status() !== null) fail("RELEASE_UNCERTAIN");
  }
  state.coordination = "released";
  await operation.save(state);
  return state.result;
}

/**
 * Run the owner-only collection-control operation. Browser transport stops
 * before POST and emits only action metadata; the owner applies the action in
 * the authenticated admin UI and the same operation is then reconciled.
 */
export async function runProductionCollectionControl({
  accountId,
  workerName,
  repositoryRoot,
  operationDirectory,
  successorOutput = null,
  successorArtifact = null,
  approvedSuccessorSha256 = null,
  action = "inspect",
  transport = "browser",
  confirmation = null,
  session = null,
  resume = false,
  reconcileOnly = false,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  provider = null,
  liveProviderFactory = createProductionLiveProvider,
  lockFactory = ({ repositoryRoot: root }) => createProductionDeploymentLock({ repositoryRoot: root }),
  operationFactory = openOperation,
  d1Read = null,
  adminRead = null,
  post = postAdmin,
  onPublicationLinked = null,
} = {}) {
  if (!ACCOUNT.test(accountId ?? "") || !WORKER.test(workerName ?? "")
      || !safeAbsolutePath(repositoryRoot)) fail("ARGUMENTS_INVALID");
  if (!["inspect", "prepare-successor", "contain", "restore", "reconcile"].includes(action)) {
    fail("ACTION_INVALID");
  }
  const needsOperationDirectory = ["contain", "restore", "reconcile"].includes(action);
  if (needsOperationDirectory && !safeAbsolutePath(operationDirectory)) {
    fail("ARGUMENTS_INVALID");
  }
  if (action === "prepare-successor" && !safeAbsolutePath(successorOutput)) {
    fail("ARGUMENTS_INVALID");
  }
  if (action === "restore" && approvedSuccessorSha256 !== null
      && !SHA256.test(approvedSuccessorSha256)) {
    fail("SUCCESSOR_ARTIFACT_INVALID");
  }
  if (!["browser", "session"].includes(transport)) fail("TRANSPORT_INVALID");
  if (action === "inspect"
      && (confirmation !== null || resume || reconcileOnly
        || successorOutput !== null || successorArtifact !== null
        || approvedSuccessorSha256 !== null)) {
    fail("ARGUMENTS_INVALID");
  }
  if (action === "prepare-successor"
      && (confirmation !== null || resume || reconcileOnly
        || successorArtifact !== null || approvedSuccessorSha256 !== null)) {
    fail("ARGUMENTS_INVALID");
  }
  if (action === "contain"
      && (reconcileOnly || successorOutput !== null
        || successorArtifact !== null || approvedSuccessorSha256 !== null)) {
    fail("ARGUMENTS_INVALID");
  }
  if (action === "restore"
      && (reconcileOnly || successorOutput !== null)) {
    fail("ARGUMENTS_INVALID");
  }
  if (action === "contain" && confirmation !== PRODUCTION_COLLECTION_CONFIRMATION) {
    fail("CONFIRMATION_REQUIRED");
  }
  if (action === "restore" && confirmation !== PRODUCTION_RESTORE_CONFIRMATION) {
    fail("CONFIRMATION_REQUIRED");
  }
  if (action === "reconcile" && !reconcileOnly) fail("RECONCILE_MODE_REQUIRED");
  if (action === "reconcile"
      && (confirmation !== null || session !== null
        || successorOutput !== null || successorArtifact !== null
        || approvedSuccessorSha256 !== null)) {
    fail("ARGUMENTS_INVALID");
  }
  if (transport === "browser" && session !== null) {
    fail("ADMIN_SESSION_UNEXPECTED");
  }
  if (transport === "session" && action !== "reconcile") {
    if (!session) fail("ADMIN_SESSION_REQUIRED");
    validateProductionCollectionAdminSession(session);
  } else if (session !== null) {
    validateProductionCollectionAdminSession(session);
  }

  const live = provider ?? liveProviderFactory({
    accountId,
    workerName,
    environment,
    fetchImpl,
  });

  if (action === "prepare-successor") {
    const deployment = await capture(live);
    const observation = await observeBracket({
      live,
      firstDeployment: deployment,
      readRuntime: true,
      accountId,
      environment,
      fetchImpl,
      session,
      d1Read,
      adminRead,
    });
    if (observation.controls.state !== "contained"
        || !FLAGS.every(name => !observation.controls[name])) {
      fail("CONTAINED_STATE_DRIFT");
    }
    const unsigned = {
      schema: PRODUCTION_COLLECTION_SUCCESSOR_SCHEMA,
      capturedAt: observation.deployment.inventory.capturedAt,
      sourceCommit: observation.deployment.identity.sourceCommit,
      versionId: observation.deployment.identity.versionId,
      configSha256: observation.deployment.identity.configSha256,
      controls: observation.controls,
      runtimeState: "staged",
    };
    const artifact = { ...unsigned, proofSha256: identityDigest(unsigned) };
    validateProductionCollectionSuccessorArtifact(artifact);
    await writePrivateNoClobber(successorOutput, artifact);
    return {
      schema: PRODUCTION_COLLECTION_CONTROL_SCHEMA,
      status: "successor_prepared",
      sourceCommit: artifact.sourceCommit,
      versionId: artifact.versionId,
      configSha256: artifact.configSha256,
      containedRevision: artifact.controls.revision,
      approvedSuccessorSha256: artifact.proofSha256,
      productionWritesPerformed: false,
    };
  }

  // Read-only inspection never opens the shared production lock or creates a
  // durable operation. It still performs the exact overview read when a
  // private session is supplied, and always performs the fixed D1 read.
  if (action === "inspect") {
    const deployment = await capture(live);
    const observation = await observeBracket({
      live,
      firstDeployment: deployment,
      accountId,
      environment,
      fetchImpl,
      session,
      d1Read,
      adminRead,
    });
    return {
      schema: PRODUCTION_COLLECTION_CONTROL_SCHEMA,
      status: "inspected",
      sourceCommit: observation.deployment.identity.sourceCommit,
      versionId: observation.deployment.identity.versionId,
      configSha256: observation.deployment.identity.configSha256,
      controls: observation.controls,
      productionWritesPerformed: false,
    };
  }

  if (action === "reconcile") resume = true;
  let operation;
  let lock;
  let state;
  let lockHeld = false;
  let intentCreatedThisRun = false;
  try {
    operation = await operationFactory({
      directory: operationDirectory,
      kind: "production",
      binding: operationBinding({ accountId, workerName }),
      // Restore and read-only reconciliation always continue the existing
      // containment journal. A fresh directory is refused by openOperation.
      resume: resume || action === "restore" || action === "reconcile",
    });
    state = operation.record.state;
    const fresh = Object.keys(state).length === 0;
    lock = lockFactory({ repositoryRoot });

    if (fresh) {
      if (action !== "contain") fail("OPERATION_REQUIRED");
      const initial = await capture(live);
      const owner = lock.createOwner(lockOwnerInput(operation.record.id, initial.identity));
      state = {
        schema: PRODUCTION_COLLECTION_OPERATION_SCHEMA,
        owner,
        phase: "containing",
        coordination: "acquire_intent",
        initialIdentity: initial.identity,
        transport,
        before: null,
        contained: null,
        successor: null,
        restore: null,
        intent: null,
        publication: null,
        receipt: null,
        result: null,
      };
      await operation.save(state);
      lock.acquire(owner);
      lockHeld = true;
      state.coordination = "held";
      await operation.save(state);
      const locked = await capture(live);
      if (!sameDeployment(initial.identity, locked.identity)) {
        fail("LIVE_DEPLOYMENT_DRIFT");
      }
      const observation = await observeBracket({
        live,
        firstDeployment: locked,
        expectedIdentity: locked.identity,
        accountId,
        environment,
        fetchImpl,
        session,
        d1Read,
        adminRead,
      });
      state.before = {
        controls: observation.controls,
        identity: observation.deployment.identity,
      };
      await operation.save(state);
    } else {
      validateState(state, { operationDirectory });
      if (!["contain", "restore", "reconcile"].includes(action)) {
        fail("ACTION_INVALID");
      }
      const persistedAction = state.intent?.action ?? state.result?.action ?? null;
      const pendingAction = state.intent?.action
        ?? (state.coordination === "release_intent" ? persistedAction : null);
      if (action !== "reconcile" && pendingAction !== null
          && action !== pendingAction) {
        fail("ACTION_MISMATCH");
      }
      if (action !== "reconcile" && transport !== state.transport) {
        fail("TRANSPORT_MISMATCH");
      }
      if (action === "restore" && state.intent === null
          && !["contained"].includes(state.phase)) {
        fail("RESTORE_STATE_INVALID");
      }
      if (action === "contain" && state.intent === null
          && !["containing", "contained"].includes(state.phase)) {
        fail("CONTAIN_STATE_INVALID");
      }
      // A release_intent is reconciled against exact terminal state below.
      // It never reacquires or releases a different owner while pending.
      const ownerState = state.coordination === "release_intent"
        || state.coordination === "released"
        ? null : lock.status();
      if (state.coordination === "acquire_intent") {
        if (ownerState !== null && ownerState !== state.owner) fail("LOCK_BUSY");
        if (ownerState === null) {
          lock.acquire(state.owner);
        } else {
          lock.assertOwned(state.owner);
        }
        lockHeld = true;
        state.coordination = "held";
        await operation.save(state);
      } else if (state.coordination === "held") {
        if (ownerState !== state.owner) fail("LOCK_NOT_OWNED");
        lock.assertOwned(state.owner);
        lockHeld = true;
      } else if (action === "restore" && state.phase === "contained") {
        if (ownerState !== null) fail("LOCK_BUSY");
        state.coordination = "acquire_intent";
        await operation.save(state);
        lock.acquire(state.owner);
        lockHeld = true;
        state.coordination = "held";
        await operation.save(state);
      } else if (!["release_intent", "released"].includes(state.coordination)) {
        fail("OPERATION_STATE_INVALID");
      }
    }

    if (state.before === null) {
      // The acquire intent and owner marker are durable before this initial
      // live/D1 bracket. A same-action resume may finish that read under the
      // persisted owner; no other action may turn an incomplete operation
      // into a reconciliation or restore.
      if (action !== "contain" || state.phase !== "containing" || state.intent !== null
          || !lockHeld) {
        fail("CONTAIN_RESUME_REQUIRED");
      }
      const deployment = await capture(live);
      if (!sameDeployment(deployment.identity, state.initialIdentity)) {
        fail("LIVE_DEPLOYMENT_DRIFT");
      }
      const observation = await observeBracket({
        live,
        firstDeployment: deployment,
        expectedIdentity: state.initialIdentity,
        accountId,
        environment,
        fetchImpl,
        session,
        d1Read,
        adminRead,
      });
      state.before = {
        controls: observation.controls,
        identity: observation.deployment.identity,
      };
      await operation.save(state);
    }

    if (["release_intent", "released"].includes(state.coordination)) {
      if (state.result === null) fail("OPERATION_STATE_INVALID");
      if (state.coordination === "released") return state.result;
      return await reconcileTerminal({
        state,
        operation,
        operationDirectory,
        lock,
        live,
        accountId,
        environment,
        fetchImpl,
        session,
        d1Read,
        adminRead,
        onPublicationLinked,
      });
    }

    if (action === "reconcile") {
      if (!lockHeld) {
        if (state.coordination !== "held") fail("RECONCILE_LOCK_REQUIRED");
        lock.assertOwned(state.owner);
        lockHeld = true;
      }
      if (state.intent === null) fail("RECONCILE_REQUIRED");
      const anchor = state.intent.identity;
      const deployment = await capture(live);
      const observation = await observeBracket({
        live,
        firstDeployment: deployment,
        expectedIdentity: anchor,
        readRuntime: state.intent.action === "restore",
        accountId,
        environment,
        fetchImpl,
        session,
        d1Read,
        adminRead,
      });
      const observed = observation.controls;
      const beforeControls = state.intent.action === "contain"
        ? state.before.controls
        : state.contained.controls;
      const targetFlags = Object.fromEntries(FLAGS.map(name => [
        name,
        state.intent.request[name],
      ]));
      const classification = await classifyAfterRead({
        beforeControls,
        targetControls: targetFlags,
        observed,
        expectedRevision: state.intent.expectedRevision,
      });
      if (classification === "before") {
        return {
          schema: PRODUCTION_COLLECTION_CONTROL_SCHEMA,
          status: "pending",
          action: state.intent.action,
          coordination: "held",
          expectedRevision: state.intent.expectedRevision,
          target: targetFlags,
          productionWritesPerformed: false,
        };
      }
      if (classification === "ambiguous") fail("ACTION_AMBIGUOUS");
      terminalTransition(state, state.intent.action, observed, observation.deployment.identity);
      await operation.save(state);
      await writeReceipt(
        operationDirectory,
        state.receipt,
        state.result,
        state,
        operation,
        onPublicationLinked,
      );
      await reconcileTerminal({
        state,
        operation,
        operationDirectory,
        lock,
        live,
        accountId,
        environment,
        fetchImpl,
        session,
        d1Read,
        adminRead,
        onPublicationLinked,
      });
      lockHeld = false;
      return state.result;
    }

    if (action === "restore") {
      const restoringIntent = state.phase === "restoring"
        && state.intent?.action === "restore";
      if ((!restoringIntent && state.phase !== "contained")
          || state.before === null
          || state.contained === null
          || (!restoringIntent && state.intent !== null)) {
        fail("RESTORE_STATE_INVALID");
      }
      if (restoringIntent) {
        if (state.successor === null) fail("SUCCESSOR_ARTIFACT_INVALID");
        if (successorArtifact !== null) {
          validateApprovedSuccessor(successorArtifact, approvedSuccessorSha256);
          if (successorArtifact.proofSha256 !== state.successor.proofSha256) {
            fail("SUCCESSOR_APPROVAL_INVALID");
          }
        }
      } else {
        if (successorArtifact === null) fail("SUCCESSOR_ARTIFACT_REQUIRED");
        const approved = validateApprovedSuccessor(
          successorArtifact,
          approvedSuccessorSha256,
        );
        if (!sameControls(approved.controls, state.contained.controls)
            || approved.controls.state !== "contained") {
          fail("SUCCESSOR_ARTIFACT_INVALID");
        }
        state.successor = structuredClone(approved);
      }
      if (!restoringIntent) {
        const deployment = await capture(live);
        const successorIdentity = artifactIdentity(state.successor);
        if (!sameDeployment(successorIdentity, deployment.identity)) {
          fail("LIVE_DEPLOYMENT_DRIFT");
        }
        const observation = await observeBracket({
          live,
          firstDeployment: deployment,
          expectedIdentity: successorIdentity,
          readRuntime: true,
          accountId,
          environment,
          fetchImpl,
          session,
          d1Read,
          adminRead,
        });
        const contained = observation.controls;
        if (!sameControls(contained, state.contained.controls)
            || contained.state !== "contained") {
          fail("CONTAINED_STATE_DRIFT");
        }
        const flags = targetFor("restore", state.before.controls);
        const request = requestFor("restore", contained.revision, flags);
        state.phase = "restoring";
        state.intent = {
          action: "restore",
          expectedRevision: contained.revision,
          targetRevision: contained.revision + 1,
          identity: successorIdentity,
          request,
          requestSha256: hash(request),
        };
        intentCreatedThisRun = true;
        await operation.save(state);
        await writeIntentReceipt(
          operationDirectory,
          "restore",
          state.intent,
          state,
          operation,
          onPublicationLinked,
        );
        if (transport === "browser") {
          return actionRequiredResult("restore", contained.revision, flags);
        }
      }
    }

    if (action === "contain" && state.intent === null) {
      if (state.before === null) fail("JOURNAL_INVALID");
      const deployment = await capture(live);
      const observation = await observeBracket({
        live,
        firstDeployment: deployment,
        expectedIdentity: state.before.identity,
        accountId,
        environment,
        fetchImpl,
        session,
        d1Read,
        adminRead,
      });
      const current = observation.controls;
      if (!sameControls(current, state.before.controls)) fail("CONTROL_DRIFT");
      const flags = targetFor("contain", current);
      if (current.state === "contained" && sameFlags(current, flags)) {
        terminalTransition(state, "contain", current, observation.deployment.identity);
        await operation.save(state);
        await writeReceipt(
          operationDirectory,
          state.receipt,
          state.result,
          state,
          operation,
          onPublicationLinked,
        );
        await reconcileTerminal({
          state,
          operation,
          operationDirectory,
          lock,
          live,
          accountId,
          environment,
          fetchImpl,
          session,
          d1Read,
          adminRead,
          onPublicationLinked,
        });
        lockHeld = false;
        return state.result;
      }
      const request = requestFor("contain", current.revision, flags);
      state.intent = {
        action: "contain",
        expectedRevision: current.revision,
        targetRevision: current.revision + 1,
        identity: observation.deployment.identity,
        request,
        requestSha256: hash(request),
      };
      intentCreatedThisRun = true;
      await operation.save(state);
      await writeIntentReceipt(
        operationDirectory,
        "contain",
        state.intent,
        state,
        operation,
        onPublicationLinked,
      );
      if (transport === "browser") {
        return actionRequiredResult("contain", current.revision, flags);
      }
    }

    validateIntent(state.intent);
    const deployment = await capture(live);
    const anchor = state.intent.identity;
    const observation = await observeBracket({
      live,
      firstDeployment: deployment,
      expectedIdentity: anchor,
      readRuntime: state.intent.action === "restore",
      accountId,
      environment,
      fetchImpl,
      session,
      d1Read,
      adminRead,
    });
    const current = observation.controls;
    const beforeControls = state.intent.action === "contain"
      ? state.before.controls
      : state.contained.controls;
    const targetFlags = Object.fromEntries(FLAGS.map(name => [
      name,
      state.intent.request[name],
    ]));
    const classification = await classifyAfterRead({
      beforeControls,
      targetControls: targetFlags,
      observed: current,
      expectedRevision: state.intent.expectedRevision,
    });
    if (classification === "target") {
      terminalTransition(state, state.intent.action, current, observation.deployment.identity);
      await operation.save(state);
      await writeReceipt(
        operationDirectory,
        state.receipt,
        state.result,
        state,
        operation,
        onPublicationLinked,
      );
      await reconcileTerminal({
        state,
        operation,
        operationDirectory,
        lock,
        live,
        accountId,
        environment,
        fetchImpl,
        session,
        d1Read,
        adminRead,
        onPublicationLinked,
      });
      lockHeld = false;
      return state.result;
    }
    if (classification === "ambiguous") fail("ACTION_AMBIGUOUS");
    if (transport === "browser") {
      await writeIntentReceipt(
        operationDirectory,
        state.intent.action,
        state.intent,
        state,
        operation,
        onPublicationLinked,
      );
      return actionRequiredResult(
        state.intent.action,
        state.intent.expectedRevision,
        targetFlags,
      );
    }
    if (reconcileOnly) fail("RECONCILE_REQUIRED");
    // An explicit --resume is the only path that may retry the exact CAS body
    // after a read proved the preimage still exists under the same shared lock.
    if (!resume && !intentCreatedThisRun) fail("ACTION_PENDING");
    let returned;
    try {
      returned = await post({
        session,
        request: state.intent.request,
        fetchImpl,
      });
      if (!sameFlags(returned, targetFlags)
          || returned.revision !== state.intent.targetRevision) {
        fail("ADMIN_RESPONSE_INVALID");
      }
    } catch (error) {
      if (error?.code === "PRODUCTION_COLLECTION_CONTROL_ADMIN_ACTION_CONFLICT") {
        throw error;
      }
      // The exact read below distinguishes a committed request from an
      // uncommitted response. It never posts a second time in this invocation.
      const afterDeployment = await capture(live);
      const afterObservation = await observeBracket({
        live,
        firstDeployment: afterDeployment,
        expectedIdentity: anchor,
        readRuntime: state.intent.action === "restore",
        accountId,
        environment,
        fetchImpl,
        session,
        d1Read,
        adminRead,
      });
      const after = afterObservation.controls;
      const afterClass = await classifyAfterRead({
        beforeControls,
        targetControls: targetFlags,
        observed: after,
        expectedRevision: state.intent.expectedRevision,
      });
      if (afterClass === "target") {
        terminalTransition(
          state,
          state.intent.action,
          after,
          afterObservation.deployment.identity,
        );
        await operation.save(state);
        await writeReceipt(
          operationDirectory,
          state.receipt,
          state.result,
          state,
          operation,
          onPublicationLinked,
        );
        await reconcileTerminal({
          state,
          operation,
          operationDirectory,
          lock,
          live,
          accountId,
          environment,
          fetchImpl,
          session,
          d1Read,
          adminRead,
          onPublicationLinked,
        });
        lockHeld = false;
        return state.result;
      }
      if (afterClass === "before") return {
        schema: PRODUCTION_COLLECTION_CONTROL_SCHEMA,
        status: "pending",
        action: state.intent.action,
        coordination: "held",
        expectedRevision: state.intent.expectedRevision,
        target: targetFlags,
        productionWritesPerformed: false,
      };
      fail("ACTION_AMBIGUOUS");
    }
    const afterDeployment = await capture(live);
    const afterObservation = await observeBracket({
      live,
      firstDeployment: afterDeployment,
      expectedIdentity: anchor,
      readRuntime: state.intent.action === "restore",
      accountId,
      environment,
      fetchImpl,
      session,
      d1Read,
      adminRead,
    });
    const after = afterObservation.controls;
    if (after.revision !== state.intent.targetRevision
        || !sameFlags(after, targetFlags)) fail("ACTION_RESULT_UNCERTAIN");
    terminalTransition(
      state,
      state.intent.action,
      after,
      afterObservation.deployment.identity,
    );
    await operation.save(state);
    await writeReceipt(
      operationDirectory,
      state.receipt,
      state.result,
      state,
      operation,
      onPublicationLinked,
    );
    await reconcileTerminal({
      state,
      operation,
      operationDirectory,
      lock,
      live,
      accountId,
      environment,
      fetchImpl,
      session,
      d1Read,
      adminRead,
      onPublicationLinked,
    });
    lockHeld = false;
    return state.result;
  } finally {
    if (operation) operation.close();
    // A held shared lock is intentionally not released on uncertainty, drift,
    // stale revision, or malformed readback. A later reconcile owns release.
    void lockHeld;
  }
}

export function parseProductionCollectionControlArguments(argv) {
  const result = {
    action: "inspect",
    transport: "browser",
    resume: false,
  };
  const values = new Map([
    ["--mode", "action"],
    ["--transport", "transport"],
    ["--account-id", "accountId"],
    ["--worker-name", "workerName"],
    ["--repository-root", "repositoryRoot"],
    ["--operation-directory", "operationDirectory"],
    ["--admin-session-file", "adminSessionFile"],
    ["--successor-output", "successorOutput"],
    ["--successor-artifact", "successorArtifact"],
    ["--approved-successor-sha256", "approvedSuccessorSha256"],
    ["--confirm", "confirmation"],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--resume") {
      if (result.resume) fail("ARGUMENTS_INVALID");
      result.resume = true;
      continue;
    }
    const name = values.get(key);
    const value = argv[index + 1];
    if (!name || value === undefined || value.startsWith("--")
        || seen.has(name)) {
      fail("ARGUMENTS_INVALID");
    }
    seen.add(name);
    result[name] = value;
    index += 1;
  }
  if (!ACCOUNT.test(result.accountId ?? "")
      || !WORKER.test(result.workerName ?? "")
      || !safeAbsolutePath(result.repositoryRoot)
      || (["contain", "restore", "reconcile"].includes(result.action)
        && !safeAbsolutePath(result.operationDirectory))
      || (result.adminSessionFile !== undefined
        && !safeAbsolutePath(result.adminSessionFile))
      || (result.successorOutput !== undefined
        && !safeAbsolutePath(result.successorOutput))
      || (result.successorArtifact !== undefined
        && !safeAbsolutePath(result.successorArtifact))
      || (result.approvedSuccessorSha256 !== undefined
        && !SHA256.test(result.approvedSuccessorSha256))) {
    fail("ARGUMENTS_INVALID");
  }
  if (result.action === "inspect") {
    if (result.confirmation !== undefined || result.resume
        || result.successorOutput !== undefined
        || result.successorArtifact !== undefined
        || result.approvedSuccessorSha256 !== undefined) {
      fail("ARGUMENTS_INVALID");
    }
  } else if (result.action === "contain") {
    if (result.confirmation !== PRODUCTION_COLLECTION_CONFIRMATION) {
      fail("CONFIRMATION_REQUIRED");
    }
    if (result.successorOutput !== undefined
        || result.successorArtifact !== undefined
        || result.approvedSuccessorSha256 !== undefined) {
      fail("ARGUMENTS_INVALID");
    }
  } else if (result.action === "restore") {
    if (result.confirmation !== PRODUCTION_RESTORE_CONFIRMATION) {
      fail("CONFIRMATION_REQUIRED");
    }
    const hasArtifact = result.successorArtifact !== undefined;
    const hasApproval = result.approvedSuccessorSha256 !== undefined;
    if (hasArtifact !== hasApproval || (!result.resume && !hasArtifact)) {
      fail("SUCCESSOR_ARTIFACT_REQUIRED");
    }
    if (result.successorOutput !== undefined) fail("ARGUMENTS_INVALID");
  } else if (result.action === "reconcile") {
    if (result.confirmation !== undefined && result.confirmation !== null
        || result.adminSessionFile !== undefined
        || result.successorArtifact !== undefined
        || result.approvedSuccessorSha256 !== undefined
        || result.successorOutput !== undefined) {
      fail("ARGUMENTS_INVALID");
    }
  } else if (result.action === "prepare-successor") {
    if (result.confirmation !== undefined || result.resume
        || result.successorOutput === undefined
        || result.successorArtifact !== undefined
        || result.approvedSuccessorSha256 !== undefined) {
      fail("ARGUMENTS_INVALID");
    }
  } else {
    fail("ACTION_INVALID");
  }
  if (result.transport === "session"
      && result.action !== "reconcile" && !result.adminSessionFile) {
    fail("ADMIN_SESSION_REQUIRED");
  }
  if (result.transport === "browser" && result.adminSessionFile !== undefined) {
    fail("ADMIN_SESSION_UNEXPECTED");
  }
  return result;
}

async function main() {
  try {
    const args = parseProductionCollectionControlArguments(process.argv.slice(2));
    if (args.action === "reconcile" && args.adminSessionFile !== undefined) {
      fail("ADMIN_SESSION_UNEXPECTED");
    }
    const session = args.adminSessionFile === undefined
      ? null
      : await readProductionCollectionAdminSession(args.adminSessionFile);
    const successorArtifact = args.successorArtifact === undefined
      ? null
      : await readProductionCollectionSuccessorArtifact(args.successorArtifact);
    const result = await runProductionCollectionControl({
      accountId: args.accountId,
      workerName: args.workerName,
      repositoryRoot: args.repositoryRoot,
      operationDirectory: args.operationDirectory,
      successorOutput: args.successorOutput ?? null,
      successorArtifact,
      approvedSuccessorSha256: args.approvedSuccessorSha256 ?? null,
      action: args.action,
      transport: args.transport,
      confirmation: args.confirmation ?? null,
      session,
      resume: args.resume,
      reconcileOnly: args.action === "reconcile",
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === "pending" || result.status === "action_required") {
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${typeof error?.code === "string"
      ? error.code
      : "PRODUCTION_COLLECTION_CONTROL_FAILED"}\n`);
    process.exitCode = 1;
  }
}

if (pathToFileURL(resolve(process.argv[1] ?? "")).href === import.meta.url) {
  await main();
}
