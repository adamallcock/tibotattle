import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, readFileSync, existsSync, symlinkSync, readdirSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { readWorkerProfileSettings, createWorkerProfileCoordinator, startWorkerProfile, WORKER_PROFILE_LIMITS } from "./analytics-refresh-worker-profile.mjs";
import { ANALYTICS_KERNEL_CLOSURE_ROOTS } from "./analytics-kernel-closure.mjs";
const fixture = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "worker-profile-test-"))); chmodSync(root, 0o700); return root; };
const settings = (root) => ({ directory: join(root, "profiles"), source: "a".repeat(40) });
const coordinator = (root) => createWorkerProfileCoordinator(settings(root), { workerUrl: new URL(import.meta.url), runId: "synthetic-run" });
const fake = (profile) => ({ connect() {}, disconnect() {}, post(method, params, callback) { callback(null, method === "Profiler.stop" ? { profile } : {}); } });
const empty = { nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 1 };
const noObserver = () => ({ observe() {}, disconnect() {}, takeRecords() { return [{ duration: 2 }]; } });

test("disabled has no inspector, observer or file hooks; local settings are closed", () => {
  assert.equal(readWorkerProfileSettings({}), null);
  assert.equal(startWorkerProfile(null, { createSession() { assert.fail(); }, observerFactory() { assert.fail(); } }), null);
  const env = { ANALYTICS_V2_LOCAL_WORKER_PROFILE_DIR: "/private/tmp/profiles", ANALYTICS_V2_LOCAL_WORKER_PROFILE_SOURCE: "a".repeat(40) };
  assert.throws(() => readWorkerProfileSettings(env, { target: "production" }), { code: "WORKER_PROFILE_FORBIDDEN" });
  assert.throws(() => readWorkerProfileSettings({ ...env, CLOUD_RUN_JOB: "synthetic" }), { code: "WORKER_PROFILE_FORBIDDEN" });
  assert.throws(() => readWorkerProfileSettings({ ...env, ANALYTICS_V2_LOCAL_WORKER_PROFILE_UNKNOWN: "x" }), { code: "WORKER_PROFILE_SETTINGS_INVALID" });
});

test("private exact ownership, no reuse or symlink; count and reserved output caps", () => {
  const root = fixture(), c = coordinator(root);
  assert.throws(() => coordinator(root));
  const first = c.grant("owner", null, 0);
  for (let index = 1; index < 256; index++) assert.equal(c.grant("model-block", first.id, 0).id, index);
  assert.equal(c.grant("owner"), null);
  assert.ok(256 * (WORKER_PROFILE_LIMITS.profileBytes + 4096) + 1024 * 1024 <= WORKER_PROFILE_LIMITS.totalBytes);
  c.finish(); const m = JSON.parse(readFileSync(join(settings(root).directory, "manifest.json")));
  assert.equal(m.skipped, 1); assert.equal(m.completeCoverage, false); assert.equal(m.captures[1].parentId, 0);
  assert.equal(lstatSync(settings(root).directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(settings(root).directory, "manifest.json")).mode & 0o777, 0o600);
  const other = fixture(); symlinkSync(root, join(other, "alias"));
  assert.throws(() => createWorkerProfileCoordinator(settings(join(other, "alias")), { workerUrl: new URL(import.meta.url) }), { code: "WORKER_PROFILE_PATH_INVALID" });
});

test("stop drains GC once, sanitizes frames, and reports persistence overhead", () => {
  const root = fixture(), c = coordinator(root), config = c.grant("owner");
  const p = startWorkerProfile(config, { createSession: () => fake({ ...empty, nodes: [{ id: 1, callFrame: { url: "/private/secret/location.js", functionName: "private value!" } }] }), observerFactory: noObserver });
  p.finish(); p.finish(); c.finish();
  const raw = readFileSync(join(config.directory, "capture.cpuprofile"), "utf8"); assert.ok(!raw.includes("secret")); assert.ok(!raw.includes("private value"));
  const s = JSON.parse(readFileSync(join(config.directory, "summary.json"))); assert.equal(s.gc.count, 1); assert.equal(s.gc.ms, 2); assert.equal(s.coverage, "complete"); assert.ok(s.stopAndPersistMs >= 0);
});

test("profile overflow and startup failures remain diagnostic only", () => {
  for (const kind of ["overflow", "startup"]) {
    const root = fixture(), c = coordinator(root), config = c.grant("owner");
    const p = startWorkerProfile({ ...config, profileBytes: 10 }, { createSession: () => { if (kind === "startup") throw Error("private"); return fake(empty); }, observerFactory: noObserver });
    p.finish("work-failed"); c.finish();
    const s = JSON.parse(readFileSync(join(config.directory, "summary.json"))); assert.equal(s.coverage, "incomplete"); assert.ok(s.error); assert.equal(existsSync(join(config.directory, "capture.cpuprofile")), false);
  }
});

async function realWorker(config, failure = false, wait = false) {
  const module = pathToFileURL(join(import.meta.dirname, "analytics-refresh-worker-profile.mjs")).href;
  const code = `const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {startWorkerProfile}=await import(${JSON.stringify(module)});const p=startWorkerProfile(workerData.config);if(workerData.wait){parentPort.postMessage('ready');await new Promise(()=>{});return;}let outcome='original-success';try{const end=performance.now()+65;while(performance.now()<end)Math.sqrt(123);if(workerData.failure)throw Error('original-work-failure');}catch{outcome='original-work-failure';}finally{p?.finish(workerData.failure?'work-failed':'complete');}parentPort.postMessage(outcome);})()`;
  const worker = new Worker(code, { eval: true, workerData: { config, failure, wait } });
  return worker;
}
test("actual owner and block isolate captures preserve success/failure identity", async () => {
  const root = fixture(), c = coordinator(root), owner = c.grant("owner"), block = c.grant("model-block", owner.id);
  for (const [config, failure] of [[owner, false], [block, true]]) {
    const w = await realWorker(config, failure); const [outcome] = await once(w, "message"); assert.equal(outcome, failure ? "original-work-failure" : "original-success"); await once(w, "exit");
    assert.ok(JSON.parse(readFileSync(join(config.directory, "capture.cpuprofile"))).samples.length > 0);
  }
  c.finish(); const m = JSON.parse(readFileSync(join(settings(root).directory, "manifest.json"))); assert.equal(m.captures[1].identity.parentId, owner.id); assert.equal(m.completeCoverage, false);
});
test("forced cancellation records missing coverage without altering termination", async () => {
  const root = fixture(), c = coordinator(root), config = c.grant("owner"), w = await realWorker(config, false, true);
  await once(w, "message"); await w.terminate(); c.finish(); const m = JSON.parse(readFileSync(join(settings(root).directory, "manifest.json")));
  assert.equal(m.captures[0].error, "WORKER_PROFILE_CAPTURE_MISSING_OR_INVALID"); assert.equal(m.completeCoverage, false);
});
test("Worker wrapper remains a compute closure root and covers both result handoffs", () => {
  assert.ok(ANALYTICS_KERNEL_CLOSURE_ROOTS.includes("apps/worker/cloud-run/analytics-refresh-worker.mjs"));
  const text = readFileSync(new URL("./analytics-refresh-worker.mjs", import.meta.url), "utf8");
  assert.match(text, /isolateProfile\?\.finish\("complete"\);\s+port.postMessage/u);
  assert.match(text, /isolateProfile\?\.finish\("complete"\);\s+parentPort.postMessage\(\{ type: "result"/u);
});

test("cooperative duration overshoot is incomplete and cannot claim full coverage", () => {
  const root = fixture(), c = coordinator(root), config = c.grant("owner");
  let time = 0;
  const p = startWorkerProfile(config, { createSession: () => fake(empty), observerFactory: noObserver, now: () => time });
  time = WORKER_PROFILE_LIMITS.durationMs + 9; p.finish(); c.exited(config.id, 0); c.finish();
  const m = JSON.parse(readFileSync(join(settings(root).directory, "manifest.json")));
  assert.equal(m.completeCoverage, false); assert.equal(m.captures[0].durationOvershootMs, 9);
});

test("observer start failure stops inspector and leaves closed incomplete evidence", () => {
  const root = fixture(), c = coordinator(root), config = c.grant("owner"), calls = [];
  const p = startWorkerProfile(config, { createSession: () => ({ ...fake(empty), post(method, params, callback) { calls.push(method); callback(null, method === "Profiler.stop" ? { profile: empty } : {}); } }), observerFactory() { throw Error("private"); } });
  p.finish(); c.finish(); assert.ok(calls.includes("Profiler.stop")); assert.ok(calls.includes("Profiler.disable"));
  assert.equal(existsSync(join(config.directory, "capture.cpuprofile")), false);
});


test("identity, unknown metadata and altered raw profile cannot qualify coverage", () => {
  for (const corruption of ["identity", "unknown", "profile"]) {
    const root = fixture(), c = coordinator(root), config = c.grant("owner");
    const p = startWorkerProfile(config, { createSession: () => fake(empty), observerFactory: noObserver }); p.finish();
    const path = join(config.directory, "summary.json"), summary = JSON.parse(readFileSync(path));
    if (corruption === "identity") summary.identity.id = 200;
    if (corruption === "unknown") summary.privateRowValue = "must-not-escape";
    if (corruption === "profile") writeFileSync(join(config.directory, "capture.cpuprofile"), "{}", { mode: 0o600 });
    writeFileSync(path, JSON.stringify(summary), { mode: 0o600 });
    c.exited(config.id, 1); c.finish();
    const text = readFileSync(join(settings(root).directory, "manifest.json"), "utf8"), manifest = JSON.parse(text);
    assert.equal(manifest.completeCoverage, false); assert.equal(manifest.captures[0].error, "WORKER_PROFILE_CAPTURE_MISSING_OR_INVALID");
    assert.ok(!text.includes("must-not-escape"));
  }
});


test("complete capture requires coupled verified profile, outcome and duration facts", () => {
  const corruptions = [
    (s) => { s.profileSha256 = null; s.profileBytes = 0; },
    (s) => { s.profileBytes = 0; },
    (s) => { s.reason = "work-failed"; },
    (s) => { s.reason = "duration-limit"; },
    (s) => { s.error = "WORKER_PROFILE_CAPTURE_FAILED"; },
    (s) => { s.elapsedMs = WORKER_PROFILE_LIMITS.durationMs + 1; s.durationOvershootMs = 1; },
    (s) => { s.elapsedMs = WORKER_PROFILE_LIMITS.durationMs + 1; s.durationOvershootMs = 0; },
    (s) => { s.durationOvershootMs = 1; },
    (s) => { s.stoppedAt = null; },
  ];
  for (const corrupt of corruptions) {
    const root = fixture(), c = coordinator(root), config = c.grant("owner");
    startWorkerProfile(config, { createSession: () => fake(empty), observerFactory: noObserver }).finish();
    const path = join(config.directory, "summary.json"), summary = JSON.parse(readFileSync(path));
    assert.equal(summary.coverage, "complete"); corrupt(summary);
    writeFileSync(path, JSON.stringify(summary), { mode: 0o600 }); c.exited(config.id, 1); c.finish();
    const manifest = JSON.parse(readFileSync(join(settings(root).directory, "manifest.json")));
    assert.equal(manifest.completeCoverage, false);
    assert.equal(manifest.captures[0].error, "WORKER_PROFILE_CAPTURE_MISSING_OR_INVALID");
  }
});

test("zero-capture runs cannot claim complete Worker coverage", () => {
  const root = fixture(), c = coordinator(root); c.finish();
  const manifest = JSON.parse(readFileSync(join(settings(root).directory, "manifest.json")));
  assert.equal(manifest.captures.length, 0); assert.equal(manifest.completeCoverage, false);
});
