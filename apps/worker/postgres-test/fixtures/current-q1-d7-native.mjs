/** Current-source D7 native probes with parent-supervised diagnostic reads.
 *
 * This helper executes only current Worker graph APIs. Each compute invocation
 * receives a fresh production-sized query meter shared by that call's source
 * and target bindings. A dedicated owner-bound child owns diagnostic D1 reads
 * and is terminated/reaped on timeout. Raw rows, checkpoint controls and error
 * stacks remain transient. Only closed digests and verified current DTOs leave
 * this module.
 */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";

import * as D7 from "./current-q1-d7-recompute.mjs";
import { createCurrentQ1D7DiagnosticClient } from "./current-q1-d7-diagnostic.mjs";

const CASE_KEYS = Object.freeze(["conflictPreserving", "conflictFreePositive"]);
const OWNER_KEYS = Object.freeze(["a", "b", "c", "d"]);
const MODEL_METRIC = "model";
const FITS_DAY = "2026-10-01";
const PAGE_METHOD = "effective-telemetry-owner-day-v1";
const COMPUTE_DEADLINE_MS = 20_000;
const FAILURE = Object.freeze({
  invalid: "CURRENT_Q1_D7_NATIVE_INPUT_INVALID",
  deadline: "CURRENT_Q1_D7_DEADLINE",
  queryBound: "CURRENT_Q1_D7_NATIVE_QUERY_BOUND",
  execution: "CURRENT_Q1_D7_NATIVE_EXECUTION_FAILED",
  progress: "CURRENT_Q1_D7_NATIVE_PROGRESS_INVALID",
  checkpoint: "CURRENT_Q1_D7_NATIVE_CHECKPOINT_INVALID",
  page: "CURRENT_Q1_D7_NATIVE_PAGE_INVALID",
  sourceChanged: "CURRENT_Q1_D7_SOURCE_CHANGED",
  unresolved: "CURRENT_Q1_D7_NATIVE_UNRESOLVED",
});
const DIAGNOSTIC_METHODS = Object.freeze({
  captureScope: Object.freeze(["ownerKey", "metric", "day"]),
  readResult: Object.freeze(["scopeSha256"]),
  checkpointProgress: Object.freeze(["scopeSha256"]),
  proveEffectiveConflictPage: Object.freeze(["scopeSha256"]),
  captureIngestionInvariant: Object.freeze([]),
});
const INTERNAL_FAILURES = new Set(Object.values(FAILURE));
const SHA = /^[a-f0-9]{64}$/u;
const SOURCE_HEAD = /^[a-f0-9]{40,64}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const ownKeys = (value) => object(value) ? Object.keys(value).sort() : [];
const exactKeys = (value, expected) => object(value)
  && isDeepStrictEqual(ownKeys(value), [...expected].sort());
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const requireFact = (fact, code = FAILURE.invalid) => { if (!fact) fail(code); };
const jsonSha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hash = (value) => typeof value === "string" && SHA.test(value);

function checkDeadline(deadlineMonotonicMs) {
  requireFact(Number.isFinite(deadlineMonotonicMs) && performance.now() < deadlineMonotonicMs, FAILURE.deadline);
}

export function assertCurrentQ1D7DiagnosticClientClosed(result) {
  const normal = exactKeys(result, ["closed", "closedDatabaseHandles", "closedVite", "cacheRemoved", "processGroupGone"])
    && result.closed === true && result.closedDatabaseHandles === 2
    && result.closedVite === true && result.cacheRemoved === true && result.processGroupGone === true;
  const terminated = exactKeys(result, ["closed", "processGroupGone"])
    && result.closed === true && result.processGroupGone === true;
  requireFact(normal || terminated, FAILURE.execution);
  return result;
}

/** Guard one child-supervised diagnostic call with the caller's monotonic deadline.
 * The client owns a 30-second process-group watchdog; this boundary also checks
 * the original case deadline immediately before and after every awaited call.
 */
export async function awaitCurrentQ1D7Diagnostic(deadlineMonotonicMs, operation,
  { now = () => performance.now() } = {}) {
  requireFact(Number.isFinite(deadlineMonotonicMs) && typeof operation === "function"
    && typeof now === "function");
  const before = now();
  requireFact(Number.isFinite(before) && before < deadlineMonotonicMs, FAILURE.deadline);

  let result;
  try {
    result = await operation();
  } catch (error) {
    const after = now();
    requireFact(Number.isFinite(after) && after < deadlineMonotonicMs, FAILURE.deadline);
    throw error;
  }
  const after = now();
  requireFact(Number.isFinite(after) && after < deadlineMonotonicMs, FAILURE.deadline);
  return result;
}

/** Dispatch only the diagnostic operations wired to the fixed child protocol. */
export function invokeCurrentQ1D7DiagnosticClient(client, method, payload, deadlineMonotonicMs,
  { now = () => performance.now() } = {}) {
  requireFact(object(client) && Object.hasOwn(DIAGNOSTIC_METHODS, method)
    && typeof client[method] === "function" && exactKeys(payload, DIAGNOSTIC_METHODS[method]), FAILURE.invalid);
  return awaitCurrentQ1D7Diagnostic(deadlineMonotonicMs, () => method === "captureIngestionInvariant"
    ? client.captureIngestionInvariant() : client[method](payload), { now });
}

/** A diagnostic mirror of graph.ts's per-compute statement meter. One instance
 * is created for each compute call and shared by that call's two databases. */
export function createCurrentQ1D7InvocationQueryBudget(
  limit = D7.CURRENT_Q1_D7_NATIVE_QUERY_LIMIT) {
  requireFact(Number.isSafeInteger(limit) && limit === D7.CURRENT_Q1_D7_NATIVE_QUERY_LIMIT);
  let used = 0;
  const charge = (amount = 1) => {
    requireFact(Number.isSafeInteger(amount) && amount > 0 && used + amount <= limit, FAILURE.queryBound);
    used += amount;
  };
  const originals = new WeakMap();
  const wrapStatement = (statement) => {
    const wrapped = new Proxy(statement, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "bind" && typeof value === "function") {
        return (...args) => wrapStatement(Reflect.apply(value, target, args));
      }
      if (["run", "all", "first", "raw", "get"].includes(property) && typeof value === "function") {
        return (...args) => { charge(); return Reflect.apply(value, target, args); };
      }
      return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(wrapped, statement);
    return wrapped;
  };
  const wrapDatabase = (database) => new Proxy(database, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === "prepare" && typeof value === "function") {
      return (...args) => wrapStatement(Reflect.apply(value, target, args));
    }
    if (property === "batch" && typeof value === "function") return (statements) => {
      requireFact(Array.isArray(statements) && statements.every((statement) => originals.has(statement)),
        FAILURE.queryBound);
      charge(statements.length || 1);
      return Reflect.apply(value, target, [statements.map((statement) => originals.get(statement))]);
    };
    if (property === "exec" && typeof value === "function") {
      return (...args) => { charge(); return Reflect.apply(value, target, args); };
    }
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return Object.freeze({ limit, get used() { return used; }, get remaining() { return limit - used; }, wrapDatabase });
}

function reportProgress(progress, details) {
  if (typeof progress === "function") {
    progress(details);
    return;
  }
  if (object(progress) && typeof progress.counts === "function") {
    progress.counts(details);
    return;
  }
  fail(FAILURE.progress);
}

function validateInputs({ ctx, ownerRows, caseKey, binding, sourceWitnesses, windowProofs,
  deadlineMonotonicMs, progress }, { D1, Contract }) {
  requireFact(object(ctx) && object(ctx.P) && ctx.ingestion && ctx.analytics
    && typeof ctx.scratchDirectory === "string"
    && ctx.server && typeof ctx.server.ssrFixStacktrace === "function");
  requireFact(CASE_KEYS.includes(caseKey) && Array.isArray(ownerRows) && ownerRows.length === 4);
  requireFact(Array.isArray(sourceWitnesses) && Array.isArray(windowProofs));
  requireFact(Number.isFinite(deadlineMonotonicMs) && deadlineMonotonicMs > performance.now());
  requireFact(typeof progress === "function" || object(progress) && typeof progress.counts === "function",
    FAILURE.progress);
  Contract.validateCurrentQ1D7Binding(binding);
  requireFact(binding.cases[caseKey].caseId === caseKey
    && binding.sourceId === D1.CURRENT_Q1_REFERENCE_SOURCE_ID
    && binding.sourceNamespace === binding.sourceId);

  const seenKeys = new Set(), seenDigests = new Set();
  for (const row of ownerRows) {
    requireFact(exactKeys(row, ["key", "owner"]) && OWNER_KEYS.includes(row.key)
      && object(row.owner) && hash(row.owner.ownerDigest)
      && typeof row.owner.participantId === "string" && row.owner.participantId.length > 0
      && Number.isSafeInteger(row.owner.ownerRevision) && row.owner.ownerRevision >= 1
      && Number.isSafeInteger(row.owner.authorityEpoch) && row.owner.authorityEpoch >= 1);
    requireFact(!seenKeys.has(row.key) && !seenDigests.has(row.owner.ownerDigest));
    seenKeys.add(row.key); seenDigests.add(row.owner.ownerDigest);
  }
  requireFact(isDeepStrictEqual([...seenKeys].sort(), OWNER_KEYS));

  if (caseKey === "conflictFreePositive") {
    requireFact(sourceWitnesses.length === 0 && windowProofs.length === 0);
  } else {
    requireFact(typeof Contract.currentQ1D7ConflictAssociationSha256 === "function");
    requireFact(sourceWitnesses.length === 6 && windowProofs.length > 0);
    requireFact(sourceWitnesses.every((w) => object(w) && w.owner === "a"
      && ["quota", "session", "usage"].includes(w.stream) && Array.isArray(w.nativePages)
      && w.nativePages.length === 0));
  }
}

/** Project the measured runtime tuple plus closed source and script fences from
 * the already-validated binding. Production supplies the canonical realpath of
 * this process's fixed `process.execPath`; the diagnostic client independently
 * verifies its bytes before forking and never accepts a runtime selector.
 */
export function buildCurrentQ1D7DiagnosticBootstrapPins(binding, measuredRuntime, runtimePath) {
  requireFact(object(binding) && object(binding.runtime) && object(measuredRuntime)
    && isDeepStrictEqual(measuredRuntime, binding.runtime) && object(binding.source)
    && Array.isArray(binding.source.files) && typeof runtimePath === "string"
    && runtimePath.startsWith("/") && measuredRuntime.version === "v26.2.0"
    && hash(measuredRuntime.binarySha256) && SOURCE_HEAD.test(binding.source.head)
    && hash(binding.source.sha256), FAILURE.sourceChanged);
  const childSource = binding.source.files.find((entry) =>
    entry.path === "apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic-child.mjs");
  const guardianSource = binding.source.files.find((entry) =>
    entry.path === "apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic-guardian.mjs");
  requireFact(hash(childSource?.sha256) && hash(guardianSource?.sha256), FAILURE.sourceChanged);
  return Object.freeze({
    runtime: Object.freeze({ path: runtimePath, version: measuredRuntime.version,
      binarySha256: measuredRuntime.binarySha256 }),
    sourceFence: Object.freeze({ head: binding.source.head, sha256: binding.source.sha256 }),
    expectedChildSha256: childSource.sha256,
    expectedGuardianSha256: guardianSource.sha256,
  });
}

/** Invoke the current graph API with one fresh meter shared by both databases.
 * The 20-second operation deadline uses the same monotonic clock as the
 * caller's enclosing deadline; `scope.fixedNow` remains the pinned model time.
 */
export async function invokeCurrentQ1D7Compute({ bindings, scope, deadlineMonotonicMs,
  computeStorageGraphResult, createQueryBudget = createCurrentQ1D7InvocationQueryBudget,
  onQueryDiagnostic = () => {} }) {
  requireFact(object(bindings) && bindings.source && bindings.target
    && typeof computeStorageGraphResult === "function" && typeof createQueryBudget === "function"
    && typeof onQueryDiagnostic === "function");
  checkDeadline(deadlineMonotonicMs);
  const queryBudget = createQueryBudget();
  requireFact(object(queryBudget) && queryBudget.limit === D7.CURRENT_Q1_D7_NATIVE_QUERY_LIMIT
    && queryBudget.used === 0 && queryBudget.remaining === queryBudget.limit
    && typeof queryBudget.wrapDatabase === "function", FAILURE.queryBound);
  const startedMonotonicMs = performance.now();
  const invocationDeadlineMs = Math.min(startedMonotonicMs + COMPUTE_DEADLINE_MS, deadlineMonotonicMs);
  requireFact(invocationDeadlineMs > startedMonotonicMs, FAILURE.deadline);
  const meteredBindings = { ...bindings,
    source: queryBudget.wrapDatabase(bindings.source),
    target: queryBudget.wrapDatabase(bindings.target) };
  const queryDiagnostic = () => ({ limit: queryBudget.limit, used: queryBudget.used,
    remaining: queryBudget.remaining });
  let outcome;
  try {
    outcome = await computeStorageGraphResult(meteredBindings, scope, {
      preparedFold: false, maxQueries: queryBudget.limit, deadlineMs: invocationDeadlineMs,
      now: () => performance.now(),
    });
  } catch (error) {
    onQueryDiagnostic(queryDiagnostic());
    throw error;
  }
  const diagnostic = queryDiagnostic();
  onQueryDiagnostic(diagnostic);
  return { outcome, queryDiagnostic: diagnostic };
}

function sourceWindowDays(binding, caseKey) {
  if (caseKey === "conflictFreePositive") return [];
  const c = binding.cases[caseKey];
  return c.modelDays.filter((modelDay) => c.conflictDays.some((sourceDay) => {
    const fromDay = new Date(Date.parse(`${modelDay}T00:00:00.000Z`) - 100 * 86_400_000)
      .toISOString().slice(0, 10);
    return sourceDay >= fromDay && sourceDay <= modelDay;
  }));
}

function proveSourceConflict({ diagnosticProof, scope, ownerKey, binding, sourceWitnesses,
  windowProofs, origin, sourceInvariantSha256, Contract }) {
  requireFact(ownerKey === "a" && scope.source === "effective" && scope.metric === "model"
    && object(origin) && origin.guardLabel === "effective_history_guard_544"
    && hash(origin.originProofSha256), FAILURE.page);
  requireFact(exactKeys(diagnosticProof, ["checkpoint", "pageProof", "authorityBeforeSha256", "authorityAfterSha256"]));
  const { checkpoint, pageProof } = diagnosticProof;
  requireFact(exactKeys(checkpoint, ["keyDigest", "dependencyDigest", "method", "headDigest", "sourceDay", "cursorSha256"])
    && [checkpoint.keyDigest, checkpoint.dependencyDigest, checkpoint.headDigest, checkpoint.cursorSha256].every(hash)
    && typeof checkpoint.method === "string" && /^[A-Za-z0-9._:-]{1,1024}$/u.test(checkpoint.method)
    && DAY.test(checkpoint.sourceDay)
    && exactKeys(pageProof, ["schemaVersion", "pageSha256", "associationSha256", "rowCount", "compatibleCount",
      "conflictCount", "compatibleRowsSchemaValid", "compatibleRowsTimeValid", "conflictFieldsNull"])
    && pageProof.schemaVersion === "current-q1-effective-conflict-page-proof-v1"
    && hash(pageProof.pageSha256) && hash(pageProof.associationSha256)
    && [pageProof.rowCount, pageProof.compatibleCount, pageProof.conflictCount].every(Number.isSafeInteger)
    && pageProof.rowCount >= 1 && pageProof.rowCount <= 200
    && pageProof.compatibleCount + pageProof.conflictCount === pageProof.rowCount
    && pageProof.conflictCount >= 1 && pageProof.compatibleRowsSchemaValid === true
    && pageProof.compatibleRowsTimeValid === true && pageProof.conflictFieldsNull === true
    && hash(diagnosticProof.authorityBeforeSha256) && hash(diagnosticProof.authorityAfterSha256)
    && diagnosticProof.authorityBeforeSha256 === diagnosticProof.authorityAfterSha256, FAILURE.page);
  const witness = sourceWitnesses.find((entry) => entry.owner === ownerKey
    && entry.day === checkpoint.sourceDay && entry.stream === "usage");
  const window = windowProofs.find((entry) => entry.owner === ownerKey && entry.day === scope.day);
  requireFact(witness && window && checkpoint.sourceDay >= window.fromDay
    && checkpoint.sourceDay <= window.throughDay, FAILURE.page);

  const nativePage = { modelDay: scope.day, checkpointMethod: checkpoint.method,
    dependencyDigest: checkpoint.dependencyDigest, keyDigest: checkpoint.keyDigest,
    headDigest: checkpoint.headDigest,
    cursorSha256: checkpoint.cursorSha256, pageSha256: pageProof.pageSha256 };
  requireFact(!witness.nativePages.some((entry) => entry.modelDay === scope.day), FAILURE.page);
  witness.nativePages.push(nativePage);

  const proof = {
    schemaVersion: Contract.CURRENT_Q1_D7_SCHEMAS.conflict,
    caseId: "conflictPreserving",
    bindingSha256: Contract.currentQ1D7JsonSha256(binding),
    scope: { owner: ownerKey, metric: MODEL_METRIC, day: scope.day, sourceKind: scope.source,
      dependencyDigest: checkpoint.dependencyDigest, keyDigest: checkpoint.keyDigest,
      headDigest: checkpoint.headDigest, cursorSha256: nativePage.cursorSha256,
      checkpointMethod: checkpoint.method },
    origin: { label: origin.guardLabel,
      moduleSha256: binding.source.files.find((entry) => entry.path === "apps/worker/src/storage-effective-history.ts")?.sha256,
      originProofSha256: origin.originProofSha256, factoryLine: 26, guardLine: 544,
      observerSha256: binding.source.files.find((entry) => entry.path === "apps/worker/scripts/current-q1-conflict-proof.mjs")?.sha256 },
    reader: { method: PAGE_METHOD, stream: "usage", pageSha256: pageProof.pageSha256,
      rows: pageProof.rowCount, compatibleRows: pageProof.compatibleCount,
      conflictRows: pageProof.conflictCount,
      compatibleRowsValid: pageProof.compatibleRowsSchemaValid
        && pageProof.compatibleRowsTimeValid,
      conflictRecordJsonNull: pageProof.conflictFieldsNull,
      conflictEventTimeNull: pageProof.conflictFieldsNull,
      cursorMatched: true, sourceDay: checkpoint.sourceDay,
      sourceWitnessSha256: Contract.currentQ1D7JsonSha256(witness), associationSha256: "" },
    fences: { authorityBeforeSha256: diagnosticProof.authorityBeforeSha256,
      authorityAfterSha256: diagnosticProof.authorityAfterSha256,
      sourceBeforeSha256: sourceInvariantSha256, sourceAfterSha256: sourceInvariantSha256 },
  };
  proof.reader.associationSha256 = Contract.currentQ1D7ConflictAssociationSha256(proof, witness);
  return proof;
}

export function refreshCurrentQ1D7WindowProofs(windowProofs, sourceWitnesses,
  { binding, caseKey, Contract, Expect }) {
  const bindingSha256 = Contract.currentQ1D7JsonSha256(binding);
  const sourceInvariantSha256 = binding.cases[caseKey].sourceInvariantSha256;
  return windowProofs.map((proof) => {
    const sourceWitnessSha256 = sourceWitnesses.filter((witness) => witness.owner === proof.owner
      && witness.day >= proof.fromDay && witness.day <= proof.throughDay).map(jsonSha256);
    const sourceWindowSha256 = Expect.currentQ1D7SourceWindowSha256({ caseId: caseKey, bindingSha256,
      owner: proof.owner, day: proof.day, fromDay: proof.fromDay, throughDay: proof.throughDay,
      sourceInvariantSha256, sourceWitnessSha256 }, Contract);
    return { ...proof, sourceWitnessSha256, sourceWindowSha256 };
  });
}

/** Execute one complete D7 case's four-owner × seventy-day model vector and
 * four pinned current-fit scopes. Every graph compute call gets a fresh source
 * plus target meter; aggregate query usage is returned only as diagnostics. */
export async function runCurrentQ1D7NativeProbe({ ctx, ownerRows, caseKey, binding,
  sourceWitnesses, windowProofs, deadlineMonotonicMs, progress }) {
  const [D1, Contract, ConflictProof, Expect] = await Promise.all([
    import("./current-q1-d1-reference.mjs"),
    import("./current-q1-d7-contract.mjs"),
    import("../../scripts/current-q1-conflict-proof.mjs"),
    import("./current-q1-d7-expectation.mjs"),
  ]);
  const input = { ctx, ownerRows, caseKey, binding, sourceWitnesses, windowProofs,
    deadlineMonotonicMs, progress };
  validateInputs(input, { D1, Contract });
  checkDeadline(deadlineMonotonicMs);

  const owners = [...ownerRows].sort((left, right) => left.key.localeCompare(right.key));
  const enrichedSourceWitnesses = structuredClone(sourceWitnesses);
  const frozenWindowProofs = structuredClone(windowProofs);
  const expectedConflictDays = new Set(sourceWindowDays(binding, caseKey));
  requireFact(caseKey === "conflictPreserving"
    ? isDeepStrictEqual([...expectedConflictDays], frozenWindowProofs.map((proof) => proof.day))
    : expectedConflictDays.size === 0);

  const [measuredRuntime, runtimePath] = await Promise.all([
    D1.measureCurrentQ1Runtime(), realpath(process.execPath),
  ]);
  checkDeadline(deadlineMonotonicMs);
  requireFact(isDeepStrictEqual(measuredRuntime, binding.runtime), FAILURE.sourceChanged);
  const diagnosticPins = buildCurrentQ1D7DiagnosticBootstrapPins(binding, measuredRuntime, runtimePath);
  const diagnosticClient = await createCurrentQ1D7DiagnosticClient({
    scratchDirectory: ctx.scratchDirectory,
    caseKey,
    sourceId: binding.sourceId,
    sourceNamespace: binding.sourceNamespace,
    nowMs: Contract.CURRENT_Q1_D7_NOW_MS,
    expectedOwners: owners.map(({ key, owner }) => ({ ownerKey: key, ownerDigest: owner.ownerDigest,
      ownerRevision: owner.ownerRevision, authorityEpoch: owner.authorityEpoch })),
    deadlineMonotonicMs,
    ...diagnosticPins,
  });
  let primaryError = null;
  try {
    const nativeBindings = D1.currentQ1DatabaseBindings(ctx);
    const sourceBefore = await invokeCurrentQ1D7DiagnosticClient(diagnosticClient,
      "captureIngestionInvariant", {}, deadlineMonotonicMs);
    const sourceInvariantSha256 = binding.cases[caseKey].sourceInvariantSha256;
    requireFact(exactKeys(sourceBefore, ["sha256", "schemaSha256", "fullSourceCaptureSha256"])
      && [sourceBefore.sha256, sourceBefore.schemaSha256, sourceBefore.fullSourceCaptureSha256].every(hash)
      && sourceBefore.sha256 === sourceInvariantSha256, FAILURE.sourceChanged);
  const nativeEvidence = [];
  const conflictProofs = [];
  const ownerResults = new Map();
  const computeQueryDiagnostics = { invocationCount: 0, totalExecuted: 0,
    perInvocation: [] };
  const recordQueryDiagnostic = (entry) => {
    computeQueryDiagnostics.invocationCount++;
    computeQueryDiagnostics.totalExecuted += entry.used;
    computeQueryDiagnostics.perInvocation.push(entry);
  };
  const scopeOrdinalForModel = (ownerIndex, dayIndex) => ownerIndex * 70 + dayIndex + 1;

  async function runScope({ ownerKey, owner, metric, day, scopeOrdinal, expectedConflict }) {
    checkDeadline(deadlineMonotonicMs);
    reportProgress(progress, { scopeOrdinal, iteration: 0, owner: ownerKey, metric, day });
    let scope, scopeSha256;
    try {
      const captured = await invokeCurrentQ1D7DiagnosticClient(diagnosticClient,
        "captureScope", { ownerKey, metric, day }, deadlineMonotonicMs);
      requireFact(exactKeys(captured, ["scope", "scopeSha256"])
        && hash(captured.scopeSha256)
        && Contract.currentQ1D7JsonSha256(captured.scope) === captured.scopeSha256, FAILURE.execution);
      scope = captured.scope;
      scopeSha256 = captured.scopeSha256;
    } catch (error) {
      if (error && INTERNAL_FAILURES.has(error.code)) throw error;
      fail(FAILURE.execution);
    }
    requireFact(object(scope) && scope.metric === metric && scope.day === day
      && scope.owner?.ownerDigest === owner.ownerDigest
      && scope.owner?.ownerRevision === owner.ownerRevision
      && scope.owner?.authorityEpoch === owner.authorityEpoch, FAILURE.execution);
    if (expectedConflict) requireFact(scope.source === "effective", FAILURE.checkpoint);

    let previous = null;
    let stall = 0;
    for (let invocation = 1; invocation <= D7.CURRENT_Q1_D7_NATIVE_INVOCATIONS; invocation++) {
      checkDeadline(deadlineMonotonicMs);
      reportProgress(progress, { scopeOrdinal, iteration: invocation, owner: ownerKey, metric, day });
      let outcome;
      try {
        ({ outcome } = await invokeCurrentQ1D7Compute({ bindings: nativeBindings, scope,
          deadlineMonotonicMs, computeStorageGraphResult: ctx.P.computeStorageGraphResult,
          onQueryDiagnostic: recordQueryDiagnostic }));
      } catch (error) {
        if (expectedConflict) {
          let origin = null;
          try { origin = ConflictProof.observeCurrentQ1EffectiveHistoryGuard(error, ctx.server); } catch { origin = null; }
          if (origin) {
            const diagnosticProof = await invokeCurrentQ1D7DiagnosticClient(diagnosticClient,
              "proveEffectiveConflictPage", { scopeSha256 }, deadlineMonotonicMs);
            const proof = proveSourceConflict({ diagnosticProof, scope, ownerKey, binding,
              sourceWitnesses: enrichedSourceWitnesses, windowProofs: frozenWindowProofs,
              origin, sourceInvariantSha256, Contract });
            conflictProofs.push(proof);
            const native = { owner: ownerKey, metric: MODEL_METRIC, day, state: "expected_source_conflict",
              invocations: invocation, verifiedSha256: null, reason: null, proofSha256: jsonSha256(proof) };
            return { native, verified: null };
          }
        }
        if (error && INTERNAL_FAILURES.has(error.code)) throw error;
        fail(FAILURE.execution);
      }

      requireFact(object(outcome) && ["complete", "deferred"].includes(outcome.state), FAILURE.execution);
      if (outcome.state === "complete") {
        // Acceptance always requires a canonical read through the current
        // facade in the supervised child. A crossed case deadline fails closed.
        let verified;
        try {
          verified = await invokeCurrentQ1D7DiagnosticClient(diagnosticClient,
            "readResult", { scopeSha256 }, deadlineMonotonicMs);
        } catch (error) {
          if (error && INTERNAL_FAILURES.has(error.code)) throw error;
          fail(FAILURE.execution);
        }
        const classification = D1.classifyCurrentQ1VerifiedNativeOutcome({ metric, outcome, verified,
          knownNotTestableReasons: ctx.P.COMMUNITY_MODEL_REFUSAL_REASONS });
        requireFact(["complete", "not_testable"].includes(classification?.state), FAILURE.unresolved);
        requireFact(hash(classification.payloadSha256), FAILURE.unresolved);
        if (expectedConflict) fail(FAILURE.page);
        if (metric === "fits") {
          requireFact(classification.state === "complete" && Array.isArray(verified.fits)
            && verified.composition === null, FAILURE.unresolved);
          return { native: { owner: ownerKey, state: "complete",
            verifiedSha256: classification.payloadSha256 }, verified };
        }
        requireFact(object(verified.composition), FAILURE.unresolved);
        ownerResults.set(`${ownerKey}/${day}`, verified.composition);
        return { native: { owner: ownerKey, metric: MODEL_METRIC, day,
          state: classification.state, invocations: invocation,
          verifiedSha256: classification.payloadSha256,
          reason: classification.state === "not_testable" ? classification.reason : null,
          proofSha256: null }, verified };
      }

      // Deferred is progress, never proof. Generic reasons are deliberately
      // not copied into native evidence or converted to an owner refusal.
      if (invocation === D7.CURRENT_Q1_D7_NATIVE_INVOCATIONS) fail(FAILURE.unresolved);
      const next = await invokeCurrentQ1D7DiagnosticClient(diagnosticClient,
        "checkpointProgress", { scopeSha256 }, deadlineMonotonicMs);
      stall = previous !== null && next === previous ? stall + 1 : 0;
      previous = next;
      if (stall >= D7.CURRENT_Q1_D7_NATIVE_STALL) fail(FAILURE.unresolved);
    }
    fail(FAILURE.unresolved);
  }

  // Current fits are direct current-source claims at the pinned current day.
  const currentFits = [];
  for (const [ownerIndex, entry] of owners.entries()) {
    checkDeadline(deadlineMonotonicMs);
    const result = await runScope({ ownerKey: entry.key, owner: entry.owner,
      metric: "fits", day: FITS_DAY, scopeOrdinal: ownerIndex + 1, expectedConflict: false });
    currentFits.push(result.native);
  }

  const modelDays = binding.cases[caseKey].modelDays;
  requireFact(modelDays.length === 70);
  for (const [ownerIndex, entry] of owners.entries()) {
    for (const [dayIndex, day] of modelDays.entries()) {
      checkDeadline(deadlineMonotonicMs);
      const expectedConflict = entry.key === "a" && expectedConflictDays.has(day);
      const result = await runScope({ ownerKey: entry.key, owner: entry.owner, metric: MODEL_METRIC,
        day, scopeOrdinal: scopeOrdinalForModel(ownerIndex, dayIndex), expectedConflict });
      nativeEvidence.push(result.native);
      if (!result.native || result.native.metric !== MODEL_METRIC) fail(FAILURE.execution);
    }
  }

  checkDeadline(deadlineMonotonicMs);
  const sourceAfter = await invokeCurrentQ1D7DiagnosticClient(diagnosticClient,
    "captureIngestionInvariant", {}, deadlineMonotonicMs);
  checkDeadline(deadlineMonotonicMs);
  requireFact(isDeepStrictEqual(sourceBefore, sourceAfter)
    && sourceAfter.sha256 === sourceInvariantSha256, FAILURE.sourceChanged);
  requireFact(caseKey === "conflictPreserving"
    ? conflictProofs.length === expectedConflictDays.size
      && new Set(conflictProofs.map((proof) => proof.scope.day)).size === expectedConflictDays.size
    : conflictProofs.length === 0, FAILURE.page);

  const finalWindowProofs = refreshCurrentQ1D7WindowProofs(frozenWindowProofs, enrichedSourceWitnesses,
    { binding, caseKey, Contract, Expect });
  for (const proof of conflictProofs) Contract.validateCurrentQ1D7SourceConflictProof(proof, binding,
    { sourceWitnesses: enrichedSourceWitnesses, windowProofs: finalWindowProofs });
  requireFact(currentFits.length === 4 && currentFits.every((entry) => entry.state === "complete")
    && nativeEvidence.length === 280 && ownerResults.size === 280 - conflictProofs.length,
  FAILURE.unresolved);
  checkDeadline(deadlineMonotonicMs);
  return { nativeEvidence, conflictProofs, currentFits, sourceWitnesses: enrichedSourceWitnesses,
    windowProofs: finalWindowProofs,
    ownerResults, computeQueryDiagnostics };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      assertCurrentQ1D7DiagnosticClientClosed(await diagnosticClient.close());
    } catch (error) {
      // If the case deadline expired during cleanup, the client has already
      // terminated, reaped, and verified its process group before reporting it.
      if (error?.code === FAILURE.deadline) {
        if (primaryError === null) fail(FAILURE.deadline);
      } else fail(FAILURE.execution);
    }
    if (primaryError === null) checkDeadline(deadlineMonotonicMs);
  }
}
