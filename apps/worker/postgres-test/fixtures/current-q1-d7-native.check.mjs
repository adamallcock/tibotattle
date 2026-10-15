import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import * as D7 from "./current-q1-d7-recompute.mjs";
import { assertCurrentQ1D7DiagnosticClientClosed, awaitCurrentQ1D7Diagnostic,
  buildCurrentQ1D7DiagnosticBootstrapPins, createCurrentQ1D7InvocationQueryBudget,
  invokeCurrentQ1D7DiagnosticClient,
  invokeCurrentQ1D7Compute, refreshCurrentQ1D7WindowProofs } from "./current-q1-d7-native.mjs";
import { createCurrentQ1D7DiagnosticClient } from "./current-q1-d7-diagnostic.mjs";
import * as Contract from "./current-q1-d7-contract.mjs";
import * as Expect from "./current-q1-d7-expectation.mjs";

function database() {
  return { prepare() {
    return { first: async () => 1, run: async () => ({ success: true }) };
  } };
}

const budgets = [];
const invocations = [];
const createQueryBudget = () => {
  const budget = createCurrentQ1D7InvocationQueryBudget();
  budgets.push(budget);
  return budget;
};
const computeStorageGraphResult = async (bindings, scope, options) => {
  const started = performance.now();
  invocations.push({ started, options });
  await bindings.source.prepare("SELECT source").first();
  await bindings.target.prepare("UPDATE target").run();
  return { state: "complete", reused: true, scope };
};
const bindings = { source: database(), target: database(), sourceId: "source", sourceNamespace: "source" };
const scope = { metric: "model", day: "2026-07-24" };
const deadlineMonotonicMs = performance.now() + 60_000;
const diagnostics = [];

const first = await invokeCurrentQ1D7Compute({ bindings, scope, deadlineMonotonicMs,
  computeStorageGraphResult, createQueryBudget, onQueryDiagnostic: (value) => diagnostics.push(value) });
const second = await invokeCurrentQ1D7Compute({ bindings, scope, deadlineMonotonicMs,
  computeStorageGraphResult, createQueryBudget, onQueryDiagnostic: (value) => diagnostics.push(value) });

assert.equal(budgets.length, 2);
assert.notEqual(budgets[0], budgets[1], "each graph invocation starts with a fresh meter");
for (const budget of budgets) {
  assert.equal(budget.limit, D7.CURRENT_Q1_D7_NATIVE_QUERY_LIMIT);
  assert.equal(budget.used, 2, "source and target executions share that invocation's meter");
  assert.equal(budget.remaining, D7.CURRENT_Q1_D7_NATIVE_QUERY_LIMIT - 2);
}
assert.deepEqual(first.queryDiagnostic, { limit: 900, used: 2, remaining: 898 });
assert.deepEqual(second.queryDiagnostic, first.queryDiagnostic);
assert.deepEqual(diagnostics, [first.queryDiagnostic, second.queryDiagnostic]);
assert.equal(invocations.length, 2);
for (const { started, options } of invocations) {
  assert.equal(options.maxQueries, 900);
  assert.equal(options.preparedFold, false);
  assert.equal(typeof options.now, "function");
  assert.ok(options.deadlineMs > started);
  assert.ok(options.deadlineMs <= started + 20_000, "preserve the source's per-compute 20-second deadline");
}

const deadlineTrace = [];
let monotonicMs = 4;
const guardedResult = await awaitCurrentQ1D7Diagnostic(10, async () => {
  deadlineTrace.push("operation");
  monotonicMs = 5;
  return "verified";
}, { now: () => { deadlineTrace.push("clock"); return monotonicMs; } });
assert.equal(guardedResult, "verified");
assert.deepEqual(deadlineTrace, ["clock", "operation", "clock"],
  "diagnostic reads are checked immediately before and after awaiting the operation");
assert.equal(typeof createCurrentQ1D7DiagnosticClient, "function",
  "the native adapter is wired to the owned fixed diagnostic client");

const boundRuntime = { version: "v26.2.0", binarySha256: "7".repeat(64) };
const boundChildSha256 = "8".repeat(64);
const boundGuardianSha256 = "9".repeat(64);
const boundSource = { head: "a".repeat(40), sha256: "b".repeat(64), files: [
  { path: "apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic-child.mjs",
    sha256: boundChildSha256 },
  { path: "apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic-guardian.mjs",
    sha256: boundGuardianSha256 },
] };
const diagnosticPins = buildCurrentQ1D7DiagnosticBootstrapPins({ runtime: boundRuntime, source: boundSource },
  boundRuntime, "/fixed/realpath/node");
assert.deepEqual(diagnosticPins, { runtime: { path: "/fixed/realpath/node", version: "v26.2.0",
  binarySha256: boundRuntime.binarySha256 },
sourceFence: { head: boundSource.head, sha256: boundSource.sha256 }, expectedChildSha256: boundChildSha256,
expectedGuardianSha256: boundGuardianSha256 },
"child bootstrap pins use measured binding runtime and closure head/digest plus exact child/guardian hashes");
assert.throws(() => buildCurrentQ1D7DiagnosticBootstrapPins({ runtime: boundRuntime,
  source: { files: [{ path: "apps/worker/postgres-test/fixtures/current-q1-d7-diagnostic-child.mjs",
    sha256: boundChildSha256 }] } }, boundRuntime, "/fixed/realpath/node"),
{ code: "CURRENT_Q1_D7_SOURCE_CHANGED" });
assert.throws(() => buildCurrentQ1D7DiagnosticBootstrapPins({ runtime: boundRuntime,
  source: boundSource }, { ...boundRuntime, binarySha256: "6".repeat(64) }, "/fixed/realpath/node"),
{ code: "CURRENT_Q1_D7_SOURCE_CHANGED" });
assert.throws(() => buildCurrentQ1D7DiagnosticBootstrapPins({ runtime: boundRuntime,
  source: boundSource }, boundRuntime, "relative/node"), { code: "CURRENT_Q1_D7_SOURCE_CHANGED" });

const clientTrace = [];
let clientMonotonicMs = 14;
const fakeDiagnosticClient = { captureScope(payload) {
  clientTrace.push({ method: "captureScope", payload });
  clientMonotonicMs = 15;
  return { scope: { metric: "model", day: "2026-07-24" }, scopeSha256: "a".repeat(64) };
} };
const capturedScope = await invokeCurrentQ1D7DiagnosticClient(fakeDiagnosticClient, "captureScope",
  { ownerKey: "a", metric: "model", day: "2026-07-24" }, 20,
  { now: () => { clientTrace.push("clock"); return clientMonotonicMs; } });
assert.equal(capturedScope.scopeSha256, "a".repeat(64));
assert.deepEqual(clientTrace, ["clock", { method: "captureScope",
  payload: { ownerKey: "a", metric: "model", day: "2026-07-24" } }, "clock"],
"native dispatch sends a closed request through the child client with pre/post deadline checks");
assert.throws(() => invokeCurrentQ1D7DiagnosticClient(fakeDiagnosticClient, "readResult",
  { scopeSha256: "a".repeat(64), sql: "SELECT 1" }, 20),
{ code: "CURRENT_Q1_D7_NATIVE_INPUT_INVALID" });

let readStartedAfterDeadline = false;
await assert.rejects(invokeCurrentQ1D7DiagnosticClient({ readResult() {
  readStartedAfterDeadline = true;
} }, "readResult", { scopeSha256: "a".repeat(64) }, 20, { now: () => 20 }),
{ code: "CURRENT_Q1_D7_DEADLINE" });
assert.equal(readStartedAfterDeadline, false,
  "canonical verification is not started after the original case deadline");

let expiredRequestStarted = false;
await assert.rejects(invokeCurrentQ1D7DiagnosticClient({ readResult() {
  expiredRequestStarted = true;
} }, "readResult", { scopeSha256: "a".repeat(64) }, 20, { now: () => 21 }),
{ code: "CURRENT_Q1_D7_DEADLINE" });
assert.equal(expiredRequestStarted, false,
  "a diagnostic request starting beyond the shared global deadline is rejected before client work");

const cleanClose = { closed: true, closedDatabaseHandles: 2, closedVite: true,
  cacheRemoved: true, processGroupGone: true };
assert.deepEqual(assertCurrentQ1D7DiagnosticClientClosed(cleanClose), cleanClose);
assert.deepEqual(assertCurrentQ1D7DiagnosticClientClosed({ closed: true, processGroupGone: true }),
  { closed: true, processGroupGone: true }, "a timed-out child is accepted as closed only after group reaping");
assert.throws(() => assertCurrentQ1D7DiagnosticClientClosed({ closed: true, processGroupGone: false }),
{ code: "CURRENT_Q1_D7_NATIVE_EXECUTION_FAILED" });

let startedAfterDeadline = false;
await assert.rejects(awaitCurrentQ1D7Diagnostic(10, async () => {
  startedAfterDeadline = true;
}, { now: () => 10 }), { code: "CURRENT_Q1_D7_DEADLINE" });
assert.equal(startedAfterDeadline, false, "ordinary diagnostics do not start after the caller deadline");

let diagnosticFinishedAt = 11;
let overrunReadRan = false;
await assert.rejects(awaitCurrentQ1D7Diagnostic(10, async () => {
  overrunReadRan = true;
}, { now: () => overrunReadRan ? diagnosticFinishedAt : 9 }),
{ code: "CURRENT_Q1_D7_DEADLINE" });
assert.equal(overrunReadRan, true, "deadline overrun is detected after the read returns, not by cancelling it");

const sourceInvariantSha256 = "1".repeat(64);
const bindingForWindow = { cases: { conflictPreserving: { sourceInvariantSha256 } } };
const windowDay = "2026-07-01";
const sourceDay = "2026-03-23";
const sourceWitnesses = ["quota", "session", "usage"].map((stream) => ({ owner: "a", day: sourceDay,
  stream, nativePages: [] }));
const staleWindow = { owner: "a", day: windowDay, fromDay: sourceDay, throughDay: windowDay,
  sourceWitnessSha256: ["0".repeat(64)], sourceWindowSha256: "0".repeat(64) };
const enrichedWitnesses = structuredClone(sourceWitnesses);
enrichedWitnesses[2].nativePages.push({ modelDay: windowDay, checkpointMethod: "effective-model-v1",
  dependencyDigest: "2".repeat(64), keyDigest: "3".repeat(64), headDigest: "4".repeat(64),
  cursorSha256: "5".repeat(64), pageSha256: "6".repeat(64) });
const refreshed = refreshCurrentQ1D7WindowProofs([staleWindow], enrichedWitnesses,
  { binding: bindingForWindow, caseKey: "conflictPreserving", Contract, Expect })[0];
const expectedWitnessDigests = enrichedWitnesses.map((witness) => Contract.currentQ1D7JsonSha256(witness));
const expectedWindowDigest = Expect.currentQ1D7SourceWindowSha256({
  caseId: "conflictPreserving", bindingSha256: Contract.currentQ1D7JsonSha256(bindingForWindow),
  owner: "a", day: windowDay, fromDay: sourceDay, throughDay: windowDay,
  sourceInvariantSha256, sourceWitnessSha256: expectedWitnessDigests,
}, Contract);
assert.deepEqual(refreshed.sourceWitnessSha256, expectedWitnessDigests);
assert.equal(refreshed.sourceWindowSha256, expectedWindowDigest,
  "window proof reseals from the enriched source witnesses using the canonical formula");
assert.notEqual(refreshed.sourceWindowSha256, staleWindow.sourceWindowSha256);

process.stdout.write("current D7 meter, diagnostic runtime/source pins, supervised cleanup, and window reseal checks passed\n");
