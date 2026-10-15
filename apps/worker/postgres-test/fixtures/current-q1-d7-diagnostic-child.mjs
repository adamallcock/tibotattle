/** Fixed D7-only IPC child. It owns the current Worker loader and readonly DB handles. */
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, realpath, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import * as D1 from "./current-q1-d1-reference.mjs";
import * as Contract from "./current-q1-d7-contract.mjs";
import * as ConflictProof from "../../scripts/current-q1-conflict-proof.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(HERE, "../..");
const PROTOCOL = "current-q1-d7-diagnostic-v1";
const SOURCE_ID = D1.CURRENT_Q1_REFERENCE_SOURCE_ID;
const CASE_KEYS = Object.freeze(["conflictPreserving", "conflictFreePositive"]);
const OWNER_KEYS = Object.freeze(["a", "b", "c", "d"]);
const MODEL_DAYS = new Set(Contract.currentQ1D7GraphDays());
const FITS_DAY = "2026-10-01";
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_SCOPE_BYTES = 512 * 1024;
const MAX_SCOPES = 284;
const SHA = /^[a-f0-9]{64}$/u;
const SOURCE_HEAD = /^[a-f0-9]{40,64}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected) => object(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

const ERROR = Object.freeze({
  init: "CURRENT_Q1_D7_DIAGNOSTIC_INIT_FAILED",
  method: "CURRENT_Q1_D7_DIAGNOSTIC_METHOD_INVALID",
  scope: "CURRENT_Q1_D7_DIAGNOSTIC_SCOPE_INVALID",
  scopeFailed: "CURRENT_Q1_D7_DIAGNOSTIC_SCOPE_FAILED",
  result: "CURRENT_Q1_D7_DIAGNOSTIC_RESULT_FAILED",
  checkpoint: "CURRENT_Q1_D7_DIAGNOSTIC_CHECKPOINT_FAILED",
  page: "CURRENT_Q1_D7_DIAGNOSTIC_PAGE_FAILED",
  sourceChanged: "CURRENT_Q1_D7_SOURCE_CHANGED",
  deadline: "CURRENT_Q1_D7_DEADLINE",
});

let runtime = null;
let inputBuffer = Buffer.alloc(0);
let busy = false;
let closed = false;
let initializationStarted = false;
let testScenario = null;

function safeTree(value, depth = 0) {
  if (depth > 28) fail(ERROR.scope);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(ERROR.scope); return; }
  if (Array.isArray(value)) {
    if (value.length > 4096) fail(ERROR.scope);
    for (const item of value) safeTree(item, depth + 1);
    return;
  }
  if (!object(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 4096) {
    fail(ERROR.scope);
  }
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 256) fail(ERROR.scope);
    safeTree(item, depth + 1);
  }
}

function boundedJson(value, limit, code = ERROR.method) {
  let text;
  try { safeTree(value); text = JSON.stringify(value); } catch { fail(code); }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > limit) fail(code);
  return text;
}

function send(message) {
  const line = `${boundedJson(message, MAX_OUTPUT_BYTES, ERROR.method)}\n`;
  return new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(line, "utf8", (error) => error ? rejectWrite(error) : resolveWrite());
  });
}

function validateExpectedOwners(expectedOwners) {
  if (!Array.isArray(expectedOwners) || expectedOwners.length !== OWNER_KEYS.length) fail(ERROR.init);
  const digests = new Set();
  for (let i = 0; i < expectedOwners.length; i++) {
    const owner = expectedOwners[i];
    if (!exactKeys(owner, ["ownerKey", "ownerDigest", "ownerRevision", "authorityEpoch"])
        || owner.ownerKey !== OWNER_KEYS[i] || typeof owner.ownerDigest !== "string" || !SHA.test(owner.ownerDigest)
        || !Number.isSafeInteger(owner.ownerRevision) || owner.ownerRevision < 1
        || !Number.isSafeInteger(owner.authorityEpoch) || owner.authorityEpoch < 1
        || digests.has(owner.ownerDigest)) fail(ERROR.init);
    digests.add(owner.ownerDigest);
  }
}

async function assertCaseDatabaseFiles(scratchDirectory, identities = null) {
  if (typeof scratchDirectory !== "string" || !scratchDirectory.startsWith("/")
      || await realpath(scratchDirectory) !== scratchDirectory) fail(ERROR.init);
  const dir = await lstat(scratchDirectory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid()
      || (dir.mode & 0o777) !== 0o700) fail(ERROR.init);
  const paths = { ingestion: join(scratchDirectory, "ingestion.sqlite"),
    analytics: join(scratchDirectory, "analytics.sqlite") };
  const output = {};
  for (const role of ["ingestion", "analytics"]) {
    const path = paths[role], stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || await realpath(path) !== path
        || (identities && (stat.dev !== identities[role].dev || stat.ino !== identities[role].ino))) fail(ERROR.init);
    output[role] = stat;
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try { await lstat(`${path}${suffix}`); fail(ERROR.init); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }
  return { paths, identities: output };
}

async function initialize(payload) {
  if (initializationStarted || !exactKeys(payload, ["scratchDirectory", "caseKey", "sourceId",
    "sourceNamespace", "nowMs", "expectedOwners", "runtime", "sourceFence",
    "expectedChildSha256", "expectedGuardianSha256"]) || !CASE_KEYS.includes(payload.caseKey)
      || payload.sourceId !== SOURCE_ID || payload.sourceNamespace !== SOURCE_ID
      || payload.nowMs !== Contract.CURRENT_Q1_D7_NOW_MS
      || !exactKeys(payload.runtime, ["path", "version", "binarySha256"])
      || typeof payload.runtime.path !== "string" || !payload.runtime.path.startsWith("/")
      || payload.runtime.version !== "v26.2.0" || !SHA.test(payload.runtime.binarySha256)
      || !exactKeys(payload.sourceFence, ["head", "sha256"])
      || typeof payload.sourceFence.head !== "string" || !SOURCE_HEAD.test(payload.sourceFence.head)
      || !SHA.test(payload.sourceFence.sha256)
      || !SHA.test(payload.expectedChildSha256) || !SHA.test(payload.expectedGuardianSha256)) fail(ERROR.init);
  validateExpectedOwners(payload.expectedOwners);
  if (process.version !== "v26.2.0") fail(ERROR.init);
  initializationStarted = true;

  let measured, actualRuntime;
  try {
    measured = await D1.measureCurrentQ1Runtime();
    actualRuntime = { path: await realpath(process.execPath), version: measured.version,
      binarySha256: measured.binarySha256 };
  } catch { fail(ERROR.init); }
  if (!isDeepStrictEqual(actualRuntime, payload.runtime)) fail(ERROR.init);

  const { paths, identities } = await assertCaseDatabaseFiles(payload.scratchDirectory);
  const { openSealedSqliteD1 } = await import("../../cloud-run/sealed-sqlite-d1-adapter.mjs");
  const handles = [];
  let vite, cacheRoot, cacheIdentity;
  try {
    handles.push(openSealedSqliteD1(paths.ingestion, { readOnly: true, pinnedNowMs: payload.nowMs }));
    handles.push(openSealedSqliteD1(paths.analytics, { readOnly: true, pinnedNowMs: payload.nowMs }));
    cacheRoot = await mkdtemp(join(tmpdir(), "current-q1-d7-diagnostic-vite-"));
    await chmod(cacheRoot, 0o700);
    cacheIdentity = await lstat(cacheRoot);
    if (!cacheIdentity.isDirectory() || cacheIdentity.isSymbolicLink() || cacheIdentity.uid !== process.getuid()
        || (cacheIdentity.mode & 0o077) !== 0) fail(ERROR.init);
    const { createServer } = await import("vite");
    vite = await createServer({ root: WORKER_ROOT, cacheDir: cacheRoot, configFile: false, envDir: false,
      appType: "custom", logLevel: "silent",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
    const P = await D1.loadCurrentQ1WorkerModules(vite);
    const after = await assertCaseDatabaseFiles(payload.scratchDirectory, identities);
    runtime = { caseKey: payload.caseKey, sourceId: payload.sourceId, sourceNamespace: payload.sourceNamespace,
      nowMs: payload.nowMs, expectedOwners: structuredClone(payload.expectedOwners), scratchDirectory: payload.scratchDirectory,
      paths, identities: after.identities, handles, vite, cacheRoot, cacheIdentity, P,
      source: handles[0].database, target: handles[1].database, scopeByDigest: new Map(), ownerByKey: null,
      ConflictProof: await import("../../scripts/current-q1-conflict-proof.mjs"), Contract,
      sourceFence: structuredClone(payload.sourceFence), runtimeBinding: structuredClone(payload.runtime) };
    return { ready: true, runtime: actualRuntime, readonlyHandles: 2, viteLoaded: true };
  } catch {
    for (const handle of handles.reverse()) { try { handle.close(); } catch { /* Fail closed after best-effort cleanup. */ } }
    try { await vite?.close(); } catch { /* Fail closed after best-effort cleanup. */ }
    if (cacheRoot && cacheIdentity) {
      try { await rm(cacheRoot, { recursive: true, force: true }); } catch { /* No raw cleanup detail crosses IPC. */ }
    }
    throw Object.assign(new Error(ERROR.init), { code: ERROR.init });
  }
}

function currentOwnerMap() {
  if (runtime.ownerByKey) return runtime.ownerByKey;
  return runtime.P.readStorageCommunityOwnerPage(runtime.source, { limit: 64 }).then((rows) => {
    if (!Array.isArray(rows) || rows.length !== runtime.expectedOwners.length) fail(ERROR.scope);
    const byDigest = new Map();
    for (const row of rows) {
      if (!object(row) || typeof row.ownerDigest !== "string" || !SHA.test(row.ownerDigest)
          || byDigest.has(row.ownerDigest)) fail(ERROR.scope);
      byDigest.set(row.ownerDigest, row);
    }
    const owners = new Map();
    for (const expected of runtime.expectedOwners) {
      const owner = byDigest.get(expected.ownerDigest);
      if (!owner || owner.ownerRevision !== expected.ownerRevision || owner.authorityEpoch !== expected.authorityEpoch
          || typeof owner.participantId !== "string" || owner.participantId.length < 1) fail(ERROR.scope);
      owners.set(expected.ownerKey, owner);
    }
    runtime.ownerByKey = owners;
    return owners;
  });
}

function scopeSha256(scope) {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

async function captureScope(payload) {
  if (!exactKeys(payload, ["ownerKey", "metric", "day"]) || !OWNER_KEYS.includes(payload.ownerKey)
      || !["fits", "model"].includes(payload.metric) || typeof payload.day !== "string"
      || (payload.metric === "fits" ? payload.day !== FITS_DAY : !MODEL_DAYS.has(payload.day))) fail(ERROR.scope);
  const owners = await currentOwnerMap();
  const owner = owners.get(payload.ownerKey);
  if (!owner) fail(ERROR.scope);
  let scope;
  try {
    scope = await runtime.P.captureStorageGraphScope(runtime.source, { owner, metric: payload.metric, day: payload.day,
      sourceId: runtime.sourceId, sourceNamespace: runtime.sourceNamespace, preparedFold: false });
  } catch { fail(ERROR.scopeFailed); }
  if (!object(scope) || scope.owner?.ownerDigest !== owner.ownerDigest || scope.metric !== payload.metric
      || scope.day !== payload.day || !["effective", "v1.1", "v1", "mixed", "v0.2"].includes(scope.source)) fail(ERROR.scope);
  try {
    safeTree(scope);
    const serialized = JSON.stringify(scope);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SCOPE_BYTES) fail(ERROR.scope);
    const digest = scopeSha256(scope);
    const existing = runtime.scopeByDigest.get(digest);
    if (existing && !isDeepStrictEqual(existing, scope)) fail(ERROR.scope);
    if (!existing && runtime.scopeByDigest.size >= MAX_SCOPES) fail(ERROR.scope);
    runtime.scopeByDigest.set(digest, scope);
    return { scope, scopeSha256: digest };
  } catch { fail(ERROR.scope); }
}

function scopeForDigest(digest, { effectiveModel = false } = {}) {
  if (typeof digest !== "string" || !SHA.test(digest)) fail(ERROR.scope);
  const scope = runtime.scopeByDigest.get(digest);
  if (!scope || scopeSha256(scope) !== digest) fail(ERROR.scope);
  if (effectiveModel && (scope.source !== "effective" || scope.metric !== "model"
      || !scope.owner || !SHA.test(scope.owner.ownerDigest)
      || !Number.isSafeInteger(scope.owner.ownerRevision) || !Number.isSafeInteger(scope.owner.authorityEpoch)
      || !SHA.test(scope.checkpointDependencyDigest))) fail(ERROR.scope);
  return scope;
}

async function checkpointProgress(payload) {
  const scope = scopeForDigest(payload.scopeSha256);
  let result;
  try { result = await D1.nativeCheckpointProgress({ P: runtime.P, analytics: runtime.target }, scope); }
  catch { fail(ERROR.checkpoint); }
  if (typeof result !== "string" || !SHA.test(result)) fail(ERROR.checkpoint);
  return result;
}

function validManifest(manifest, partCount) {
  if (!Array.isArray(manifest) || manifest.length !== partCount || manifest.length > 1024) return false;
  let previous = "";
  for (const entry of manifest) {
    if (!exactKeys(entry, ["component", "sha256", "bytes"]) || typeof entry.component !== "string"
        || entry.component.length < 1 || entry.component.length > 128 || !SHA.test(entry.sha256)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 2 || entry.bytes > 131_072
        || entry.component < previous) return false;
    previous = entry.component;
  }
  return true;
}

async function readPromotedEffectiveCheckpoint(scope) {
  const P = runtime.P;
  if (scope.source !== "effective" || scope.metric !== "model" || !SHA.test(scope.checkpointDependencyDigest)) {
    fail(ERROR.checkpoint);
  }
  const method = P.STORAGE_GRAPH_EFFECTIVE_MODEL_CHECKPOINT_METHOD;
  const key = { sourceId: runtime.sourceId, sourceNamespace: runtime.sourceNamespace,
    ownerDigest: scope.owner.ownerDigest, day: scope.day,
    dependencyDigest: scope.checkpointDependencyDigest, method };
  const keyDigest = await P.storageHistoryKeyDigest(key);
  const stage = await runtime.target.prepare(`SELECT h.generation AS head_generation,h.retired,
      s.generation,s.expected_head,s.control_json,s.manifest_json,s.part_count,
      s.owner_revision,s.authority_epoch,s.source_id,s.owner_digest,s.day,
      s.dependency_digest,s.source_namespace,s.method
    FROM analytics_history_checkpoint_heads h
    JOIN analytics_history_checkpoint_stages s
      ON s.key_digest=h.key_digest AND s.generation=h.generation
    WHERE h.key_digest=? AND EXISTS (SELECT 1 FROM analytics_owner_state o
      WHERE o.source_id=s.source_id AND o.owner_digest=s.owner_digest AND o.state='active'
        AND o.authority_epoch=s.authority_epoch)`).bind(keyDigest).first();
  if (!object(stage) || stage.head_generation !== stage.generation || !SHA.test(stage.generation)
      || stage.retired !== 0 || !(stage.expected_head === null || SHA.test(stage.expected_head))
      || stage.source_id !== key.sourceId || stage.source_namespace !== key.sourceNamespace
      || stage.owner_digest !== key.ownerDigest || stage.day !== key.day
      || stage.dependency_digest !== key.dependencyDigest || stage.method !== key.method
      || stage.owner_revision !== scope.owner.ownerRevision || stage.authority_epoch !== scope.owner.authorityEpoch
      || typeof stage.control_json !== "string" || typeof stage.manifest_json !== "string"
      || !Number.isSafeInteger(stage.part_count) || stage.part_count < 0 || stage.part_count > 1024) fail(ERROR.checkpoint);

  let control, manifest;
  try { control = JSON.parse(stage.control_json); manifest = JSON.parse(stage.manifest_json); }
  catch { fail(ERROR.checkpoint); }
  if (!validManifest(manifest, stage.part_count)) fail(ERROR.checkpoint);
  const generation = await P.sha256Hex(P.canonicalJson({ key, expectedHead: stage.expected_head,
    authorityEpoch: stage.authority_epoch, control: stage.control_json, manifest }));
  if (generation !== stage.generation || !exactKeys(control, ["version", "source", "day", "layout", "identity",
    "effectiveCursor", "effectiveDays", "phase", "acquisition", "usage"])
      || control.version !== 1 || control.source !== "effective" || control.day !== scope.day
      || control.layout !== `effective:${runtime.sourceNamespace}` || !["finish", "usage"].includes(control.phase)
      || !exactKeys(control.effectiveDays, ["quota", "usage"]) || !Array.isArray(control.effectiveDays.usage)
      || control.effectiveDays.usage.length < 1 || control.effectiveDays.usage.length > 101
      || !control.effectiveDays.usage.every((day, index, days) => DAY.test(day)
        && (index === 0 || days[index - 1] < day)) || !object(control.identity)) fail(ERROR.checkpoint);

  let sourceDay, after;
  if (control.phase === "finish") {
    if (control.usage !== null) fail(ERROR.checkpoint);
    sourceDay = control.effectiveDays.usage[0];
    after = null;
  } else {
    const cursor = control.usage;
    const cursorKeys = ["version", "identity", "days", "dayIndex", "cursorTime", "cursorOccurrence", "rowsRead",
      "complete", "commonRefusal", "scalarReduced", "scalarRefusal", "modelRefusal", "usageEventCount",
      "unpricedUsageEventCount", "attributionUnresolved"];
    if (!exactKeys(cursor, cursorKeys) || cursor.version !== 1 || !isDeepStrictEqual(cursor.identity, control.identity)
        || !isDeepStrictEqual(cursor.days, control.effectiveDays.usage) || !Number.isSafeInteger(cursor.dayIndex)
        || cursor.dayIndex < 0 || cursor.dayIndex >= cursor.days.length || typeof cursor.cursorTime !== "string"
        || !Number.isFinite(Date.parse(cursor.cursorTime)) || cursor.cursorTime.slice(0, 10) !== cursor.days[cursor.dayIndex]
        || typeof cursor.cursorOccurrence !== "string" || cursor.complete !== false) fail(ERROR.checkpoint);
    sourceDay = cursor.days[cursor.dayIndex];
    after = cursor.cursorOccurrence === "" ? null : { observedAtMs: Date.parse(cursor.cursorTime),
      occurrenceId: cursor.cursorOccurrence };
    if (after !== null && (!Number.isSafeInteger(after.observedAtMs)
        || !/^[A-Za-z0-9._:-]{8,128}$/u.test(after.occurrenceId))) fail(ERROR.checkpoint);
  }
  const fromDay = new Date(Date.parse(`${scope.day}T00:00:00.000Z`) - 100 * 86_400_000).toISOString().slice(0, 10);
  if (sourceDay < fromDay || sourceDay > scope.day) fail(ERROR.checkpoint);
  const cursorSha256 = createHash("sha256").update(JSON.stringify({ sourceDay, after })).digest("hex");
  return { keyDigest, dependencyDigest: scope.checkpointDependencyDigest, method,
    headDigest: stage.generation, sourceDay, after, cursorSha256 };
}

async function proveEffectiveConflictPage(payload) {
  const scope = scopeForDigest(payload.scopeSha256, { effectiveModel: true });
  const checkpoint = await readPromotedEffectiveCheckpoint(scope);
  const authorityBefore = await runtime.P.captureStorageCommunityAuthority(runtime.source,
    { sourceId: runtime.sourceId, sourceNamespace: runtime.sourceNamespace });
  const expectedAssociation = {
    sourceId: runtime.sourceId, sourceNamespace: runtime.sourceNamespace,
    ownerDigest: scope.owner.ownerDigest, ownerRevision: scope.owner.ownerRevision,
    authorityEpoch: scope.owner.authorityEpoch, methodVersion: "effective-telemetry-owner-day-v1",
    stream: "usage", day: checkpoint.sourceDay, after: checkpoint.after, limit: 200,
    checkpoint: { keyDigest: checkpoint.keyDigest, dependencyDigest: checkpoint.dependencyDigest,
      method: checkpoint.method, headDigest: checkpoint.headDigest },
  };
  const observedAssociation = structuredClone(expectedAssociation);
  const readerInput = { sourceNamespace: runtime.sourceNamespace, ownerDigest: scope.owner.ownerDigest,
    ownerRevision: scope.owner.ownerRevision, authorityEpoch: scope.owner.authorityEpoch,
    day: checkpoint.sourceDay, stream: "usage", limit: 200,
    ...(checkpoint.after === null ? {} : { after: checkpoint.after }) };
  const page = await runtime.P.readEffectiveTelemetryOwnerDayPage(runtime.source, readerInput);
  const pageProof = ConflictProof.validateCurrentQ1ConflictPageProof({ page, expectedAssociation, observedAssociation });
  if (pageProof?.schemaVersion !== "current-q1-effective-conflict-page-proof-v1"
      || pageProof.rowCount < 1 || pageProof.conflictCount < 1
      || pageProof.compatibleRowsSchemaValid !== true || pageProof.compatibleRowsTimeValid !== true
      || pageProof.conflictFieldsNull !== true) fail(ERROR.page);
  const authorityAfter = await runtime.P.captureStorageCommunityAuthority(runtime.source,
    { sourceId: runtime.sourceId, sourceNamespace: runtime.sourceNamespace });
  if (!isDeepStrictEqual(authorityBefore, authorityAfter)) fail(ERROR.sourceChanged);
  await assertCaseDatabaseFiles(runtime.scratchDirectory, runtime.identities);
  return { checkpoint: { keyDigest: checkpoint.keyDigest, dependencyDigest: checkpoint.dependencyDigest,
    method: checkpoint.method, headDigest: checkpoint.headDigest, sourceDay: checkpoint.sourceDay,
    cursorSha256: checkpoint.cursorSha256 }, pageProof,
  authorityBeforeSha256: Contract.currentQ1D7JsonSha256(authorityBefore),
  authorityAfterSha256: Contract.currentQ1D7JsonSha256(authorityAfter) };
}

async function captureIngestionInvariant() {
  const value = await D1.captureCurrentQ1IngestionInvariantDetails(runtime.source);
  if (!object(value) || !SHA.test(value.sha256) || !SHA.test(value.schemaSha256)
      || !SHA.test(value.fullSourceCaptureSha256)) fail(ERROR.sourceChanged);
  await assertCaseDatabaseFiles(runtime.scratchDirectory, runtime.identities);
  return { sha256: value.sha256, schemaSha256: value.schemaSha256,
    fullSourceCaptureSha256: value.fullSourceCaptureSha256 };
}

async function closeRuntime() {
  if (!runtime || closed) return { closed: true, closedDatabaseHandles: 2, closedVite: true, cacheRemoved: true };
  let closedDatabaseHandles = 0, closedVite = false, cacheRemoved = false;
  for (const handle of runtime.handles) {
    try { handle.close(); closedDatabaseHandles++; } catch { /* Report only the closed status. */ }
  }
  try { await runtime.vite.close(); closedVite = true; } catch { /* Report only the closed status. */ }
  try {
    const after = await lstat(runtime.cacheRoot);
    if (after.isDirectory() && !after.isSymbolicLink() && after.dev === runtime.cacheIdentity.dev
        && after.ino === runtime.cacheIdentity.ino && after.uid === process.getuid()
        && (after.mode & 0o077) === 0) {
      await rm(runtime.cacheRoot, { recursive: true });
      cacheRemoved = true;
    }
  } catch { /* Cleanup status is checked by the parent. */ }
  closed = closedDatabaseHandles === 2 && closedVite && cacheRemoved;
  return { closed, closedDatabaseHandles, closedVite, cacheRemoved };
}

async function dispatch(request) {
  if (!object(request) || !exactKeys(request, ["protocol", "id", "method", "payload"])
      || request.protocol !== PROTOCOL || !Number.isSafeInteger(request.id) || request.id < 0
      || typeof request.method !== "string" || !object(request.payload)) fail(ERROR.method);
  if (request.method === "initialize") {
    if (request.id !== 0) fail(ERROR.method);
    return initialize(request.payload);
  }
  if (!runtime || closed || request.id === 0) fail(ERROR.method);
  if (testScenario === "blocked") {
    process.on("SIGTERM", () => {});
    writeSync(2, "CURRENT_Q1_D7_TEST_BLOCKED\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
    await new Promise(() => {});
  }
  if (testScenario === "blocked-stalled-guardian") {
    process.on("SIGTERM", () => {});
    writeSync(2, "CURRENT_Q1_D7_TEST_BLOCKED\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 35_000);
    await new Promise(() => {});
  }
  if (testScenario === "early-exit") process.exit(47);
  if (testScenario === "malformed") {
    process.stdout.write("not-json\n");
    await new Promise(() => {});
  }
  if (testScenario === "oversized") {
    process.stdout.write(Buffer.alloc(MAX_OUTPUT_BYTES + 1024, 0x78));
    await new Promise(() => {});
  }

  const method = request.method;
  if (method === "captureScope") return captureScope(request.payload);
  if (method === "readResult") {
    if (!exactKeys(request.payload, ["scopeSha256"])) fail(ERROR.method);
    const scope = scopeForDigest(request.payload.scopeSha256);
    let result;
    try { result = await runtime.P.readStorageGraphResult({ source: runtime.source, target: runtime.target,
      sourceId: runtime.sourceId, sourceNamespace: runtime.sourceNamespace }, scope); }
    catch { fail(ERROR.result); }
    if (result !== null) {
      try { safeTree(result); if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_OUTPUT_BYTES / 2) fail(ERROR.result); }
      catch { fail(ERROR.result); }
    }
    await assertCaseDatabaseFiles(runtime.scratchDirectory, runtime.identities);
    return result;
  }
  if (method === "checkpointProgress") {
    if (!exactKeys(request.payload, ["scopeSha256"])) fail(ERROR.method);
    try { return await checkpointProgress(request.payload); } catch (error) {
      if (error?.code === ERROR.deadline || error?.code === ERROR.scope) throw error;
      fail(ERROR.checkpoint);
    }
  }
  if (method === "proveEffectiveConflictPage") {
    if (!exactKeys(request.payload, ["scopeSha256"])) fail(ERROR.method);
    try { return await proveEffectiveConflictPage(request.payload); } catch (error) {
      if ([ERROR.sourceChanged, ERROR.scope, ERROR.checkpoint, ERROR.page].includes(error?.code)) throw error;
      fail(ERROR.page);
    }
  }
  if (method === "captureIngestionInvariant") {
    if (!exactKeys(request.payload, [])) fail(ERROR.method);
    try { return await captureIngestionInvariant(); } catch (error) {
      if (error?.code === ERROR.sourceChanged) throw error;
      fail(ERROR.sourceChanged);
    }
  }
  if (method === "close") {
    if (!exactKeys(request.payload, [])) fail(ERROR.method);
    return closeRuntime();
  }
  fail(ERROR.method);
}

async function consumeLine(line) {
  let request;
  try {
    if (line.length === 0 || line.length > MAX_INPUT_BYTES) fail(ERROR.method);
    request = JSON.parse(line.toString("utf8"));
    boundedJson(request, MAX_INPUT_BYTES, ERROR.method);
  } catch {
    process.exitCode = 1;
    await closeRuntime();
    return;
  }
  busy = true;
  let response;
  try {
    const result = await dispatch(request);
    response = { protocol: PROTOCOL, id: request.id, ok: true, result };
  } catch (error) {
    const allowed = new Set(Object.values(ERROR));
    const code = allowed.has(error?.code) ? error.code : (request.method === "initialize" ? ERROR.init : ERROR.method);
    response = { protocol: PROTOCOL, id: request.id, ok: false, code };
  }
  try { await send(response); }
  catch { process.exitCode = 1; await closeRuntime(); return; }
  busy = false;
  if (request.method === "close" && response.ok && response.result?.closed === true) {
    if (testScenario === "closed-reader-ignored-descendant") {
      const descendant = spawn(process.execPath, ["-e",
        "process.on('SIGTERM', () => {}); setTimeout(() => {}, 6000)"], {
        detached: false, stdio: "ignore",
      });
      descendant.once("spawn", () => {
        writeSync(2, "CURRENT_Q1_D7_TEST_DESCENDANT_SPAWNED\n");
        process.exit(47);
      });
      descendant.once("error", () => process.exit(48));
      return;
    }
    process.stdin.pause();
    process.exitCode = 0;
    return;
  }
  if (testScenario === "exited-reader-inherited-pipe" && request.method === "captureIngestionInvariant"
      && response.ok) {
    // This test-only same-group descendant inherits the reader's stdout pipe.
    // The reader exits first, so ChildProcess `exit` precedes `close`.
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 800)"], {
      detached: false, stdio: ["ignore", 1, "ignore"],
    });
    process.exit(47);
  }
  if (request.method === "initialize" && !response.ok) {
    process.stdin.pause();
    process.exitCode = 1;
  }
}

function acceptLine(line) {
  if (busy || closed) { process.exitCode = 1; void closeRuntime(); return; }
  void consumeLine(line);
}

function parseTestScenario() {
  const args = process.argv.slice(2);
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== "--test-fixture"
      || process.env.CURRENT_Q1_D7_DIAGNOSTIC_TEST_FIXTURE !== "1"
      || !new Set(["success", "blocked", "blocked-stalled-guardian", "early-exit", "malformed", "oversized",
        "exited-reader-inherited-pipe", "closed-reader-ignored-descendant"]).has(args[1])) {
    fail(ERROR.init);
  }
  return args[1];
}

try { testScenario = parseTestScenario(); }
catch { process.exitCode = 1; process.stdin.pause(); }

process.stdin.on("data", (chunk) => {
  if (!Buffer.isBuffer(chunk) || inputBuffer.length + chunk.length > MAX_INPUT_BYTES) {
    process.exitCode = 1; void closeRuntime(); return;
  }
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  let newline;
  while ((newline = inputBuffer.indexOf(0x0a)) >= 0) {
    const line = inputBuffer.subarray(0, newline);
    inputBuffer = inputBuffer.subarray(newline + 1);
    acceptLine(line);
  }
});

process.stdin.on("end", () => { if (inputBuffer.length > 0 || busy) process.exitCode = 1; });
process.on("uncaughtException", () => {
  process.exitCode = 1;
  process.stdin.pause();
  void closeRuntime();
});
process.on("unhandledRejection", () => {
  process.exitCode = 1;
  process.stdin.pause();
  void closeRuntime();
});
