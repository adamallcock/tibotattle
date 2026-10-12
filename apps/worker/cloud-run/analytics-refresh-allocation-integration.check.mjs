import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { createWorkerProfileCoordinator } from "./analytics-refresh-worker-profile.mjs";

const moduleUrl = new URL("./analytics-refresh-worker-profile.mjs", import.meta.url).href;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "allocation-integration-")));
  chmodSync(root, 0o700);
  const directory = join(root, "profiles");
  return { directory, coordinator: createWorkerProfileCoordinator(
    { directory, source: "a".repeat(40), allocation: true, memory: true },
    { workerUrl: new URL(import.meta.url), mainUrl: new URL(import.meta.url), runId: "failure-integration" }) };
}
function worker(config, mode) {
  return new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { startWorkerProfile } = await import(${JSON.stringify(moduleUrl)});
      const p = startWorkerProfile(workerData.config);
      const retained = Array.from({ length: 1000 }, (_, id) => ({ id, values: [id, id + 1] }));
      p?.checkpoint?.(2);
      if (workerData.mode === 'wait') {
        const timer = setInterval(() => {}, 1000);
        parentPort.once('message', () => {
          clearInterval(timer); p?.finish(); parentPort.postMessage({ result: retained.length });
        });
        parentPort.postMessage('ready');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
      let result;
      try { throw new Error('synthetic-compute-failure'); }
      catch (error) { result = { error: error.message, count: retained.length }; }
      finally { p?.finish('work-failed'); }
      parentPort.postMessage(result);
    })().catch(() => { process.exitCode = 2; });
  `, { eval: true, workerData: { config, mode } });
}
const read = path => JSON.parse(readFileSync(path, "utf8"));

// Separate real-isolate failure gates complement the success and corruption tests.
test("extended capture preserves actual Worker failure output and exit while retaining verified incomplete evidence", async () => {
  const baseline = worker(null, "failure"), baselineExit = once(baseline, "exit");
  const expected = (await once(baseline, "message"))[0];
  assert.equal((await baselineExit)[0], 0);
  const { directory, coordinator } = fixture();
  const config = coordinator.grant("owner"), actual = worker(config, "failure");
  const exit = once(actual, "exit");
  assert.deepEqual((await once(actual, "message"))[0], expected);
  const [code] = await exit; coordinator.exited(config.id, code); coordinator.finish();
  assert.equal(code, 0);
  const manifest = read(join(directory, "manifest.json")), capture = manifest.captures[0];
  assert.equal(manifest.completeCoverage, false);
  assert.equal(capture.coverage, "incomplete");
  assert.equal(capture.reason, "work-failed");
  assert.deepEqual(capture.identity, { id: config.id, role: "owner", parentId: null, attempt: 0 });
  assert.equal(capture.termination.exitCode, 0);
  for (const [name, metadata] of [["capture.cpuprofile", { bytes: capture.profileBytes, sha256: capture.profileSha256 }],
    ...["allocation", "memory", "phases"].map(name => [`${name}.json`, capture.extension[name]])]) {
    const bytes = readFileSync(join(config.directory, name));
    assert.ok(metadata.bytes > 0, name);
    assert.equal(bytes.length, metadata.bytes, name);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), metadata.sha256, name);
  }
});

test("forced real Worker termination with all capture modes cannot qualify partial capture", async () => {
  const { directory, coordinator } = fixture();
  const owner = coordinator.grant("owner"), config = coordinator.grant("model-block", owner.id);
  const actual = worker(config, "wait");
  try {
    assert.equal((await once(actual, "message"))[0], "ready");
    const code = await actual.terminate();
    coordinator.exited(config.id, code); coordinator.finish();
    const manifest = read(join(directory, "manifest.json"));
    assert.equal(manifest.completeCoverage, false);
    assert.equal(manifest.captures[1].coverage, "incomplete");
    assert.equal(manifest.captures[1].error, "WORKER_PROFILE_CAPTURE_MISSING_OR_INVALID");
    assert.equal(manifest.captures[1].termination.exitCode, code);
    assert.equal(manifest.captures[1].parentId, owner.id);
  } finally { await actual.terminate(); }
});

test("finalization before delayed Worker handoff remains incomplete after late artifacts arrive", async () => {
  const { directory, coordinator } = fixture();
  const config = coordinator.grant("owner"), actual = worker(config, "wait");
  try {
    assert.equal((await once(actual, "message"))[0], "ready");
    coordinator.finish();
    const before = readFileSync(join(directory, "manifest.json"), "utf8");
    assert.equal(JSON.parse(before).completeCoverage, false);
    const result = once(actual, "message"), exit = once(actual, "exit");
    actual.postMessage("finish");
    assert.deepEqual((await result)[0], { result: 1000 });
    coordinator.exited(config.id, (await exit)[0]); coordinator.finish();
    assert.equal(read(join(config.directory, "summary.json")).coverage, "complete");
    assert.equal(readFileSync(join(directory, "manifest.json"), "utf8"), before);
  } finally { await actual.terminate(); }
});

test("actual main refresh database refusal preserves original error and extended main evidence", async () => {
  const { runAnalyticsRefresh } = await import("./analytics-refresh.mjs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "allocation-main-refusal-")));
  chmodSync(root, 0o700);
  const directory = join(root, "profiles");
  const env = {
    ANALYTICS_V2_LOCAL_WORKER_PROFILE_DIR: directory,
    ANALYTICS_V2_LOCAL_WORKER_PROFILE_SOURCE: "a".repeat(40),
    ANALYTICS_V2_LOCAL_WORKER_PROFILE_ALLOCATION: "1",
    ANALYTICS_V2_LOCAL_WORKER_PROFILE_MEMORY: "1",
  };
  await assert.rejects(runAnalyticsRefresh({
    argv: ["--mode=full", "--schema=tibotattle_runtime"], env,
    dependencies: { heapLimitBytes: 16 * 1024 ** 3, profileSignals: false,
      createPool() { assert.fail("database refusal must precede pool creation"); } },
  }), { code: "ANALYTICS_V2_REFRESH_DATABASE_UNCONFIGURED" });
  const manifest = read(join(directory, "manifest.json"));
  assert.equal(manifest.completeCoverage, false);
  assert.equal(manifest.captures.length, 1);
  const capture = manifest.captures[0];
  assert.deepEqual(capture.identity, { id: 0, role: "main", parentId: null, attempt: 0 });
  assert.equal(capture.termination, null);
  assert.equal(capture.reason, "work-failed");
  assert.equal(capture.coverage, "incomplete");
  for (const name of ["allocation", "memory", "phases"]) {
    const bytes = readFileSync(join(directory, "isolate-000", `${name}.json`));
    assert.ok(capture.extension[name].bytes > 0);
    assert.equal(bytes.length, capture.extension[name].bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), capture.extension[name].sha256);
  }
});
