import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { lstat, mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { identityDigest, openOperation } from "../scripts/lib/release-operation.mjs";
import { QUALIFICATION_CACHE_POLICY, qualifyWithCache, validateAdmissionResult } from "../scripts/lib/release-qualification-cache.mjs";
import { parseAdmissionTap, parseQualificationArgs, runAdmissionTests } from "../scripts/qualify-release.mjs";

const GOOD = { tests: 3, passed: 3, failed: 0, cancelled: 0, skipped: 0, todo: 0, durationMs: 1250, exitCode: 0 };
const INPUTS = { digest: "a".repeat(64), fileCount: 10, reusable: true };
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qualification-cache-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cacheDirectory: join(root, "cache"), computeInputs: async () => INPUTS, execute: async () => GOOD };
}
const keyFor = (digest) => identityDigest({ policy: QUALIFICATION_CACHE_POLICY, inputDigest: digest });

test("inspection is inert and completed exact-input admission avoids a second execution", async (t) => {
  const f = await fixture(t); let executions = 0;
  f.execute = async () => { executions += 1; return GOOD; };
  assert.equal((await qualifyWithCache({ ...f, inspect: true })).status, "not_run");
  await assert.rejects(lstat(f.cacheDirectory), { code: "ENOENT" });
  const first = await qualifyWithCache(f);
  assert.equal(first.status, "passed"); assert.equal(first.releaseReady, false);
  const inspected = await qualifyWithCache({ ...f, inspect: true });
  assert.equal(inspected.status, "reusable");
  const second = await qualifyWithCache(f);
  assert.equal(second.status, "reused"); assert.equal(second.savedRunDurationMs, 1250); assert.equal(executions, 1);
  assert.equal((await qualifyWithCache({ ...f, refresh: true })).status, "passed"); assert.equal(executions, 2);
  const changed = { ...INPUTS, digest: "b".repeat(64) };
  assert.equal((await qualifyWithCache({ ...f, computeInputs: async () => changed })).status, "passed"); assert.equal(executions, 3);
});

test("failed, skipped, cancelled and incomplete runs never become reusable", async (t) => {
  for (const overrides of [{ exitCode: 1 }, { skipped: 1 }, { cancelled: 1 }, { todo: 1 }, { failed: 1 }, { passed: 2 }, { tests: 0, passed: 0 }]) {
    const f = await fixture(t);
    assert.equal((await qualifyWithCache({ ...f, execute: async () => ({ ...GOOD, ...overrides }) })).status, "failed");
    assert.equal((await qualifyWithCache({ ...f, inspect: true })).status, "run_required");
    assert.equal((await qualifyWithCache(f)).status, "passed");
  }
});

test("exceptions, malformed results and unknown dependencies cannot promote a cached proof", async (t) => {
  const f = await fixture(t);
  await assert.rejects(qualifyWithCache({ ...f, execute: async () => { throw new Error("PRIVATE_CANARY"); } }),
    { code: "RELEASE_QUALIFICATION_EXECUTION_FAILED", message: "RELEASE_QUALIFICATION_EXECUTION_FAILED" });
  await assert.rejects(qualifyWithCache({ ...f, execute: async () => ({ ...GOOD, rawOutput: "PRIVATE_CANARY" }) }), { code: "RELEASE_QUALIFICATION_RESULT_INVALID" });
  const unknown = { ...f, computeInputs: async () => ({ ...INPUTS, reusable: false }) };
  assert.equal((await qualifyWithCache(unknown)).status, "passed_not_reusable");
  assert.equal((await qualifyWithCache(unknown)).status, "passed_not_reusable");
  assert.throws(() => validateAdmissionResult({ ...GOOD, tests: NaN }), { code: "RELEASE_QUALIFICATION_RESULT_INVALID" });
});

test("input drift during a run prevents promoting the earlier source fingerprint", async (t) => {
  const f = await fixture(t); let digest = INPUTS.digest;
  f.computeInputs = async () => ({ ...INPUTS, digest });
  f.execute = async () => { digest = "b".repeat(64); return GOOD; };
  await assert.rejects(qualifyWithCache(f), { code: "RELEASE_QUALIFICATION_INPUTS_CHANGED" });
  const state = JSON.parse(await readFile(join(f.cacheDirectory, keyFor(INPUTS.digest), "operation.json"), "utf8")).state;
  assert.equal(state.status, "failed"); assert.equal(state.proof, null);
});

test("tampered completed proof and copied unrelated journal fail closed", async (t) => {
  const f = await fixture(t); await qualifyWithCache(f);
  const path = join(f.cacheDirectory, keyFor(INPUTS.digest), "operation.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  record.state.proof.tests += 1;
  await writeFile(path, JSON.stringify(record));
  await assert.rejects(qualifyWithCache(f), { code: "RELEASE_QUALIFICATION_RECORD_INVALID" });
  record.kind = "native"; await writeFile(path, JSON.stringify(record));
  await assert.rejects(qualifyWithCache({ ...f, inspect: true }), { code: "RELEASE_QUALIFICATION_RECORD_INVALID" });
});

test("an interrupted empty or running journal reruns, and a live owner excludes a contender", async (t) => {
  const f = await fixture(t);
  const binding = { policy: QUALIFICATION_CACHE_POLICY, inputDigest: INPUTS.digest };
  const options = { directory: join(f.cacheDirectory, identityDigest(binding)), kind: "qualification", binding };
  const operation = await openOperation(options);
  await assert.rejects(qualifyWithCache(f), { code: "RELEASE_OPERATION_BUSY" });
  operation.close();
  assert.equal((await qualifyWithCache(f)).status, "passed");
  const interrupted = await openOperation({ ...options, resume: true });
  await interrupted.save({ policy: QUALIFICATION_CACHE_POLICY, inputDigest: INPUTS.digest, status: "running", attempts: 2, proof: null, proofDigest: null });
  interrupted.close();
  const result = await qualifyWithCache(f); assert.equal(result.status, "passed"); assert.equal(result.attempts, 3);
});

test("qualification arguments expose only bounded local modes and TAP must contain one complete summary", () => {
  assert.equal(parseQualificationArgs([]).mode, "inspect");
  assert.equal(parseQualificationArgs(["run", "--refresh", "--timeout-ms", "1000"]).refresh, true);
  for (const args of [["publish"], ["inspect", "--refresh"], ["run", "--timeout-ms", "999"], ["run", "--timeout-ms", "180001"], ["run", "--cache", "x", "--cache", "y"]]) {
    assert.throws(() => parseQualificationArgs(args), { code: "RELEASE_QUALIFICATION_USAGE" });
  }
  const output = "# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  assert.deepEqual(parseAdmissionTap(output, 0, 1250), GOOD);
  assert.throws(() => parseAdmissionTap(output + "# tests 3\n", 0, 1), { code: "RELEASE_QUALIFICATION_SUMMARY_INVALID" });
});

test("child execution scrubs injected hooks and secrets and uses only the reviewed full test files", async (t) => {
  const f = await fixture(t); let captured;
  const result = await runAdmissionTests({ runDirectory: f.root, spawnProcess(command, args, options) {
    captured = { command, args, options };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => { child.stdout.end("# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"); child.emit("close", 0); });
    return child;
  } });
  assert.equal(result.tests, 3); assert.equal(captured.command, process.execPath);
  assert.equal(captured.options.env.NODE_OPTIONS, undefined); assert.equal(captured.options.env.GITHUB_TOKEN, undefined);
  assert.ok(captured.args.includes("--test-concurrency=1"));
  assert.ok(captured.args.includes("test/local-unified-index.test.js"));
  assert.ok(captured.args.includes("--import=data:text/javascript,process.umask(0o022)"));
  assert.deepEqual((await readdir(f.root)).sort(), ["home", "tmp"]);
});

test("an actually stuck synthetic child is terminated at the bounded admission deadline", async (t) => {
  const f = await fixture(t);
  let child;
  await assert.rejects(runAdmissionTests({ runDirectory: f.root, timeoutMs: 1000,
    spawnProcess: (command, _args, options) => {
      child = spawn(command, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"], options);
      return child;
    },
  }), { code: "RELEASE_QUALIFICATION_TIMEOUT", message: "RELEASE_QUALIFICATION_TIMEOUT" });
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(child.exitCode, null);
});

test("a real synthetic output flood is killed instead of retaining unbounded test output", async (t) => {
  const f = await fixture(t);
  let child;
  await assert.rejects(runAdmissionTests({ runDirectory: f.root,
    spawnProcess: (command, _args, options) => {
      child = spawn(command, ["-e", "process.stdout.write(Buffer.alloc(9*1024*1024,120));setInterval(()=>{},1000);"], options);
      return child;
    },
  }), { code: "RELEASE_QUALIFICATION_OUTPUT_LIMIT", message: "RELEASE_QUALIFICATION_OUTPUT_LIMIT" });
  assert.equal(child.signalCode, "SIGKILL");
});

test("an actual spawn failure is bounded and never exposes its synthetic private executable path", async (t) => {
  const f = await fixture(t);
  await assert.rejects(runAdmissionTests({ runDirectory: f.root,
    spawnProcess: (_command, args, options) => spawn(join(f.root, "PRIVATE-CANARY-missing-node"), args, options),
  }), { code: "RELEASE_QUALIFICATION_CHILD_FAILED", message: "RELEASE_QUALIFICATION_CHILD_FAILED" });
});

test("unconfirmed child termination cannot become a completed admission result", async (t) => {
  const f = await fixture(t);
  let kills = 0;
  await assert.rejects(runAdmissionTests({ runDirectory: f.root,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      // No PID means the implementation can only invoke this synthetic kill;
      // no real process or process group is signalled by this fixture.
      child.kill = () => { kills += 1; return false; };
      queueMicrotask(() => child.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, 120)));
      return child;
    },
  }), { code: "RELEASE_QUALIFICATION_TERMINATION_UNCONFIRMED", message: "RELEASE_QUALIFICATION_TERMINATION_UNCONFIRMED" });
  assert.equal(kills, 1);
});
