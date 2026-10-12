import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { ALLOCATION_PROFILE_LIMITS, sanitizeAllocationTree, startAllocationProfile, validateAllocationArtifact } from "./analytics-refresh-allocation-profile.mjs";
const node = (bytes = 0, children = []) => ({ id: 99, selfSize: bytes, callFrame: { functionName: "syntheticAllocation", url: "file:///private/secret/private.js" }, children });
const artifact = (head = node(10)) => ({ schemaVersion: "analytics-local-allocation-v1", samplingIntervalBytes: 131072,
  includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true,
  semantics: "statistical sampled JS allocation including collected objects; not retained heap or peak RAM",
  startedAt: "2026-10-03T00:00:00.000Z", stoppedAt: "2026-10-03T00:00:00.001Z", elapsedMs: 1,
  ...sanitizeAllocationTree(head) });

test("disabled allocation performs no protocol hook", () => {
  assert.equal(startAllocationProfile({ post() { assert.fail(); } }), null);
});
test("closed sanitized tree drops sample, object and node identity and unknown values", () => {
  const raw = node(10, [node(20)]); raw.objectValue = "must-not-escape";
  const result = artifact(raw), text = JSON.stringify(result);
  assert.equal(result.estimatedAllocationBytes, 30); assert.equal(result.nodeCount, 2);
  for (const secret of ["private.js", "secret", "must-not-escape", '"id"']) assert.ok(!text.includes(secret));
  assert.deepEqual(Object.keys(result.tree).sort(), ["children", "estimatedSelfBytes", "frame"]);
  assert.equal(validateAllocationArtifact(result), result);
});
test("cyclic, broad, deep and nonfinite allocation trees fail closed", () => {
  const cycle = node(); cycle.children.push(cycle);
  const broad = node(0, Array.from({ length: ALLOCATION_PROFILE_LIMITS.maxNodes }, () => node()));
  const deep = node(); let cursor = deep; for (let i = 0; i < 130; i++) { const child = node(); cursor.children.push(child); cursor = child; }
  for (const invalid of [cycle, broad, deep, node(NaN), node(Infinity), node(-1), node(Number.MAX_SAFE_INTEGER, [node(1)])]) {
    assert.throws(() => sanitizeAllocationTree(invalid), { code: "ALLOCATION_PROFILE_INVALID_OR_LIMIT" });
  }
});
test("sample meaning, collected flags, bytes and unknown fields cannot be relabeled", () => {
  for (const corrupt of [(a) => { a.includeObjectsCollectedByMajorGC = false; }, (a) => { a.includeObjectsCollectedByMinorGC = false; },
    (a) => { a.samplingIntervalBytes = 4096; }, (a) => { a.estimatedAllocationBytes = 0; },
    (a) => { a.semantics = "exact retained heap"; }, (a) => { a.objectValue = "private"; },
    (a) => { a.tree.nodeId = 1; }, (a) => { a.tree.frame = "/private/secret"; }, (a) => { a.nodeCount = 2; }]) {
    const value = artifact(); corrupt(value); assert.throws(() => validateAllocationArtifact(value), { code: "ALLOCATION_PROFILE_INVALID_OR_LIMIT" });
  }
});
test("start and stop use sampled HeapProfiler only and explicit collected flags", () => {
  const calls = []; const p = startAllocationProfile({ enabled: true, post(method, params) { calls.push([method, params]); return method === "HeapProfiler.stopSampling" ? { profile: { head: node(20), samples: [{ nodeId: 99, size: 20 }] } } : {}; } });
  const result = p.finish(); assert.equal(p.finish(), null); assert.equal(result.error, null); assert.ok(result.artifact);
  assert.deepEqual(calls.map(([method]) => method), ["HeapProfiler.enable", "HeapProfiler.startSampling", "HeapProfiler.stopSampling", "HeapProfiler.disable"]);
  assert.deepEqual(calls[1][1], { samplingInterval: 131072, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true });
});
test("init, stop, overflow and close failures remain diagnostic and cleanup is attempted", () => {
  for (const where of ["HeapProfiler.startSampling", "HeapProfiler.stopSampling", "HeapProfiler.disable", "oversize"]) {
    const calls = []; const p = startAllocationProfile({ enabled: true, post(method) {
      calls.push(method); if (method === where) throw Error("private-fault");
      return method === "HeapProfiler.stopSampling" ? { profile: { head: where === "oversize" ? node(0, Array.from({ length: 4096 }, () => node())) : node() } } : {};
    } });
    const result = p.finish(); assert.ok(result.error); assert.ok(calls.includes("HeapProfiler.disable"));
  }
});
test("actual Node22.16 recognizes flags and differentiates collected from live sampled weights", () => {
  const result = spawnSync(join(homedir(), ".nvm/versions/node/v22.16.0/bin/node"), ["--expose-gc", join(import.meta.dirname, "analytics-refresh-allocation-conformance.mjs")], { encoding: "utf8", timeout: 10_000, maxBuffer: 8192 });
  assert.equal(result.status, 0, result.stderr); const proof = JSON.parse(result.stdout);
  assert.equal(proof.node, "v22.16.0"); assert.equal(proof.typedFlagsRecognized.includeObjectsCollectedByMinorGC, true);
  assert.equal(proof.typedFlagsRecognized.includeObjectsCollectedByMajorGC, true);
  assert.ok(proof.includingCollected.estimatedSampleWeightBytes > proof.liveOnly.estimatedSampleWeightBytes + 16 * 1024 * 1024);
});


test("valid bounded node count still rejects serialized artifact byte overflow", () => {
  const value = artifact();
  value.tree.children = Array.from({ length: 2000 }, () => ({ frame: "x".repeat(512), estimatedSelfBytes: 0, children: [] }));
  value.nodeCount = 2001;
  assert.throws(() => validateAllocationArtifact(value), { code: "ALLOCATION_PROFILE_INVALID_OR_LIMIT" });
});
