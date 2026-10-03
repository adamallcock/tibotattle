/**
 * The refresh Job's opt-in CPU profiler (analytics-refresh-profile.mjs),
 * without a database: its settings are refused under a production target,
 * its frame keys and summary lines are content-free (repository-relative
 * files and code identifiers, counts and timings only), its fold counts a
 * recursive frame's total once per sample, and a run that is refused after
 * the profiler started still writes its exit summary.
 */

import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  ANALYTICS_REFRESH_PROFILE_SCHEMA,
  ANALYTICS_REFRESH_PROFILE_STAGING_ENV,
  analyticsRefreshBundleModules,
  analyticsRefreshFrameKey,
  createAnalyticsRefreshProfileTotals,
  createAnalyticsRefreshProfiler,
  foldAnalyticsRefreshProfile,
  readAnalyticsRefreshProfileSettings,
} from "./analytics-refresh-profile.mjs";
import { runAnalyticsRefresh } from "./analytics-refresh.mjs";

const refused = (code, field) => (error) => {
  assert.equal(error.code, code);
  if (field !== undefined) assert.equal(error.field, field);
  return true;
};

/** Every place a private path could leak from, as text a line must never contain. */
const PRIVATE_FRAGMENTS = Object.freeze(["file://", homedir(), tmpdir(), process.cwd(), "/Users/", "/private/",
  "/home/", "/app/"]);

function assertContentFree(line) {
  const text = typeof line === "string" ? line : JSON.stringify(line);
  for (const fragment of PRIVATE_FRAGMENTS) assert.equal(text.includes(fragment), false, fragment);
  const value = JSON.parse(text);
  assert.equal(value.profile, ANALYTICS_REFRESH_PROFILE_SCHEMA);
  // Never mistaken for the run's status line by the deploy wrapper.
  assert.equal(Object.hasOwn(value, "status"), false);
  assert.deepEqual(Object.keys(value).filter((key) => key !== "error").sort(), ["cpu", "elapsedSeconds", "eventLoop",
    "gc", "memory", "phase", "profile", "profiledSeconds", "progress", "reason", "sampleIntervalUs", "samples",
    "sequence", "top", "windowSeconds"]);
  for (const list of Object.values(value.top)) {
    for (const [key, milliseconds, percent] of list) {
      assert.match(key, /^(?:\([a-z ]+\)|(?:\([a-z]+\)|node:[a-z0-9_/.()-]+|(?:apps|packages|src|scripts|tools|node_modules)\/[A-Za-z0-9@_.+/-]+)(?::[A-Za-z0-9_$.#<> ()[\]-]+)?)$/u, key);
      assert.ok(Number.isSafeInteger(milliseconds) && milliseconds >= 0);
      assert.ok(Number.isFinite(percent) && percent >= 0 && percent <= 100);
    }
  }
  return value;
}

test("settings: absent is null; production refuses every profiler variable; staging refuses a directory", () => {
  assert.equal(readAnalyticsRefreshProfileSettings({}), null);
  assert.equal(readAnalyticsRefreshProfileSettings({ ANALYTICS_V2_MEMORY_BUDGET_MIB: "10752" }), null);
  assert.deepEqual(readAnalyticsRefreshProfileSettings({ ANALYTICS_V2_REFRESH_PROFILE: "cpu" }),
    { mode: "cpu", sampleUs: 10_000, summaryMs: 1_800_000, directory: null });
  for (const name of ["ANALYTICS_V2_REFRESH_PROFILE", "ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US",
    "ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS", "ANALYTICS_V2_REFRESH_PROFILE_DIR", "ANALYTICS_V2_REFRESH_PROFILEX"]) {
    assert.throws(() => readAnalyticsRefreshProfileSettings({ [name]: "cpu" }, { target: "production" }),
      refused("ANALYTICS_V2_REFRESH_PROFILE_FORBIDDEN", name), name);
    assert.throws(() => readAnalyticsRefreshProfileSettings({ [name]: "" }, { target: "production" }),
      refused("ANALYTICS_V2_REFRESH_PROFILE_FORBIDDEN", name), name);
  }
  assert.deepEqual(readAnalyticsRefreshProfileSettings({ ANALYTICS_V2_REFRESH_PROFILE: "cpu",
    ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US: "5000", ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS: "600" },
  { target: "staging" }), { mode: "cpu", sampleUs: 5_000, summaryMs: 600_000, directory: null });
  assert.deepEqual([...ANALYTICS_REFRESH_PROFILE_STAGING_ENV], ["ANALYTICS_V2_REFRESH_PROFILE",
    "ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US", "ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS"]);
  const directory = { ANALYTICS_V2_REFRESH_PROFILE: "cpu", ANALYTICS_V2_REFRESH_PROFILE_DIR: "/tmp/profiles" };
  assert.throws(() => readAnalyticsRefreshProfileSettings(directory, { target: "staging" }),
    refused("ANALYTICS_V2_REFRESH_PROFILE_FORBIDDEN", "ANALYTICS_V2_REFRESH_PROFILE_DIR"));
  assert.throws(() => readAnalyticsRefreshProfileSettings({ ...directory, CLOUD_RUN_JOB: "example-refresh" }),
    refused("ANALYTICS_V2_REFRESH_PROFILE_FORBIDDEN", "ANALYTICS_V2_REFRESH_PROFILE_DIR"));
  assert.equal(readAnalyticsRefreshProfileSettings(directory).directory, "/tmp/profiles");
  for (const [env, field] of [
    [{ ANALYTICS_V2_REFRESH_PROFILE: "heap" }, "ANALYTICS_V2_REFRESH_PROFILE"],
    [{ ANALYTICS_V2_REFRESH_PROFILE: "" }, "ANALYTICS_V2_REFRESH_PROFILE"],
    [{ ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US: "5000" }, "ANALYTICS_V2_REFRESH_PROFILE"],
    [{ ANALYTICS_V2_REFRESH_PROFILE: "cpu", ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US: "999" },
      "ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US"],
    [{ ANALYTICS_V2_REFRESH_PROFILE: "cpu", ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US: "100001" },
      "ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US"],
    [{ ANALYTICS_V2_REFRESH_PROFILE: "cpu", ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS: "9" },
      "ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS"],
    [{ ANALYTICS_V2_REFRESH_PROFILE: "cpu", ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS: "1e3" },
      "ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS"],
    [{ ANALYTICS_V2_REFRESH_PROFILE: "cpu", ANALYTICS_V2_REFRESH_PROFILE_DIR: "relative/dir" },
      "ANALYTICS_V2_REFRESH_PROFILE_DIR"],
    [{ ANALYTICS_V2_REFRESH_PROFILE: "cpu", ANALYTICS_V2_REFRESH_PROFILE_HEAP: "1" }, "ANALYTICS_V2_REFRESH_PROFILE_HEAP"],
  ]) {
    assert.throws(() => readAnalyticsRefreshProfileSettings(env), refused("ANALYTICS_V2_REFRESH_PROFILE_INVALID", field),
      JSON.stringify(env));
  }
});

test("frame keys: bundle lines map to repository modules; paths are cut; odd names are not echoed", () => {
  const bundle = ["#!/usr/bin/env node", "", "// ../src/analytics-v2/compute.ts", "function plan() {}", "",
    "// ../node_modules/@app-usagemonitor/telemetry-contract/src/primitives.js", "function decode() {}",
    "// analytics-refresh.mjs", "async function main() {}",
    "// ../vendor/analytics-d43c8f92/packages/quota-analysis/src/quota-windows.js", "function windows() {}",
    "// ../../../../../../outside/thing.js", "function outside() {}"].join("\n");
  const modules = analyticsRefreshBundleModules(bundle);
  assert.deepEqual(modules, [[2, "apps/worker/src/analytics-v2/compute.ts"],
    [5, "node_modules/@app-usagemonitor/telemetry-contract/src/primitives.js"],
    [7, "apps/worker/cloud-run/analytics-refresh.mjs"],
    [9, "apps/worker/vendor/analytics-d43c8f92/packages/quota-analysis/src/quota-windows.js"],
    [11, "(external)"]]);
  const url = "file:///app/apps/worker/cloud-run/dist/analytics-refresh.mjs";
  const bundles = new Map([[url, modules]]);
  const key = (functionName, frameUrl, lineNumber = 0) => analyticsRefreshFrameKey({ functionName, url: frameUrl,
    lineNumber, columnNumber: 0, scriptId: "1" }, bundles);
  assert.equal(key("plan", url, 3), "apps/worker/src/analytics-v2/compute.ts:plan");
  assert.equal(key("decode", url, 6), "node_modules/@app-usagemonitor/telemetry-contract/src/primitives.js:decode");
  assert.equal(key("main", url, 8), "apps/worker/cloud-run/analytics-refresh.mjs:main");
  assert.equal(key("outside", url, 12), "(external):outside");
  assert.equal(key("header", url, 0), "(bundle):header");
  assert.equal(key("", url, 3), "apps/worker/src/analytics-v2/compute.ts:(anonymous)");
  assert.equal(key("get value", url, 3), "apps/worker/src/analytics-v2/compute.ts:get value");
  for (const odd of ["owner 1f2e3d@example.com", "a/b", "x".repeat(200), "name\nwith newline", "'quoted'"]) {
    assert.equal(key(odd, url, 3), "apps/worker/src/analytics-v2/compute.ts:(unnamed)", odd);
  }
  assert.equal(key("(garbage collector)", ""), "(garbage collector)");
  assert.equal(key("(program)", ""), "(program)");
  assert.equal(key("nativeThing", ""), "(native):nativeThing");
  assert.equal(key("RegExp: ^account:v1:[a-f0-9]{64}$", ""), "(native):(regexp)");
  assert.equal(key("processTicksAndRejections", "node:internal/process/task_queues"),
    "node:internal/process/task_queues:processTicksAndRejections");
  assert.equal(key("parse", pathToFileURL("/Users/someone/work/apps/worker/cloud-run/node_modules/pg/lib/result.js").href),
    "node_modules/pg/lib/result.js:parse");
  assert.equal(key("compute", pathToFileURL("/Users/someone/clone/apps/worker/src/analytics-v2/compute.ts").href),
    "apps/worker/src/analytics-v2/compute.ts:compute");
  assert.equal(key("loose", pathToFileURL("/Users/someone/private-session/loose.js").href), "(external):loose");
  assert.equal(key("evaluated", "evalmachine.<anonymous>"), "(external):evaluated");
  assert.equal(key("weird", "node:internal\nx"), "node:(internal):weird");
});

test("fold: self time per frame, total once per sample however a frame recurs, files by self time", () => {
  const url = "file:///app/apps/worker/cloud-run/dist/analytics-refresh.mjs";
  const bundles = new Map([[url, [[0, "apps/worker/src/a.ts"], [10, "apps/worker/src/b.ts"]]]]);
  const frame = (id, functionName, lineNumber, children = []) => ({ id, callFrame: { functionName, url,
    lineNumber, columnNumber: 0, scriptId: "1" }, hitCount: 0, children });
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1, scriptId: "0" },
        children: [2, 6] },
      frame(2, "walk", 1, [3]), frame(3, "walk", 1, [4]), frame(4, "leaf", 12, [5]), frame(5, "walk", 1),
      { id: 6, callFrame: { functionName: "(garbage collector)", url: "", lineNumber: -1, columnNumber: -1,
        scriptId: "0" }, children: [] },
    ],
    // samples: walk/walk/leaf, walk/walk/leaf/walk, gc, walk
    samples: [4, 5, 6, 2],
    timeDeltas: [0, 1_000, 2_000, 3_000],
  };
  const totals = createAnalyticsRefreshProfileTotals();
  const folded = foldAnalyticsRefreshProfile(profile, totals, bundles);
  // Durations: sample i lasts timeDeltas[i + 1]; the last takes the mean (2,000).
  assert.equal(folded.samples, 4);
  assert.equal(folded.windowUs, 1_000 + 2_000 + 3_000 + 2_000);
  assert.equal(totals.self.get("apps/worker/src/b.ts:leaf"), 1_000);
  assert.equal(totals.self.get("apps/worker/src/a.ts:walk"), 2_000 + 2_000);
  assert.equal(totals.self.get("(garbage collector)"), 3_000);
  // walk is on every non-GC stack, counted once per sample despite recursion.
  assert.equal(totals.total.get("apps/worker/src/a.ts:walk"), 1_000 + 2_000 + 2_000);
  assert.equal(totals.total.get("apps/worker/src/b.ts:leaf"), 1_000 + 2_000);
  assert.equal(totals.total.has("(root)"), false);
  assert.equal(totals.files.get("apps/worker/src/a.ts"), 4_000);
  assert.equal(totals.files.get("(garbage collector)"), 3_000);
  // A second window adds to the same totals.
  foldAnalyticsRefreshProfile(profile, totals, bundles);
  assert.equal(totals.samples, 8);
  assert.equal(totals.total.get("apps/worker/src/a.ts:walk"), 10_000);
});

function busy(milliseconds) {
  const until = performance.now() + milliseconds;
  let value = 0;
  while (performance.now() < until) value += Math.sqrt(value + 1);
  return value;
}

test("profiler: interval and exit summaries are content-free lines with ranked frames and progress", async () => {
  const lines = [];
  let now = 1_000_000;
  let phase = "read";
  const profiler = await createAnalyticsRefreshProfiler({
    settings: { mode: "cpu", sampleUs: 1_000, summaryMs: 60_000, directory: null },
    phase: () => phase, write: (line) => lines.push(line), wallClock: () => now,
    bundleUrls: [import.meta.url],
  });
  profiler.start();
  busy(60);
  profiler.checkpoint({ kind: "plan", owners: [{}, {}, {}], ownerDigest: "f".repeat(64) });
  assert.equal(lines.length, 0);
  now += 60_000;
  phase = "compute";
  profiler.checkpoint({ kind: "owner", index: 0, ownerDigest: "f".repeat(64) });
  assert.equal(lines.length, 1, "a checkpoint past the period folds the window synchronously");
  busy(60);
  profiler.checkpoint({ kind: "ownerDone", index: 0 });
  now += 1_000;
  await profiler.finish("exit");
  assert.equal(lines.length, 2);
  const [interval, exit] = lines.map(assertContentFree);
  assert.equal(interval.reason, "interval");
  assert.equal(interval.sequence, 0);
  assert.equal(interval.phase, "compute");
  assert.equal(interval.windowSeconds, 60, "the folded window's length, not the next one's");
  assert.equal(exit.reason, "exit");
  assert.equal(exit.sequence, 1);
  assert.equal(exit.sampleIntervalUs, 1_000);
  assert.deepEqual(exit.progress, { ownersPlanned: 3, ownersStarted: 1, ownersDone: 1, segments: 0, scalarSteps: 0,
    modelSteps: 0, lastKind: "ownerDone" });
  assert.ok(exit.samples.total > interval.samples.total);
  assert.ok(exit.top.self.length > 0 && exit.top.self.length <= 40);
  assert.ok(exit.top.total.length > 0 && exit.top.total.length <= 40);
  assert.ok(exit.top.files.length <= 20 && exit.top.windowSelf.length <= 15);
  // This file is not a bundle, so its frames name it by its repository path.
  assert.ok(exit.top.total.some(([key]) => key === "apps/worker/cloud-run/analytics-refresh-profile.check.mjs:busy"),
    JSON.stringify(exit.top.total.slice(0, 10)));
  assert.ok(exit.memory.heapLimitMiB > 0 && exit.memory.rssMiB > 0);
  assert.ok(exit.eventLoop.utilizationTotal >= 0 && exit.eventLoop.utilizationTotal <= 1);
  // The digest the checkpoint carried is never written.
  assert.equal(lines.join("\n").includes("f".repeat(16)), false);
});

test("a run refused after the profiler started still writes its exit summary first", async () => {
  const lines = [];
  await assert.rejects(runAnalyticsRefresh({
    argv: ["--mode=full", "--schema=tibotattle_runtime"],
    // No PG_TEST_* endpoint: refused ANALYTICS_V2_REFRESH_DATABASE_UNCONFIGURED in configuration.
    env: { ANALYTICS_V2_REFRESH_PROFILE: "cpu", ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US: "1000" },
    dependencies: { heapLimitBytes: 16 * 1_024 ** 3, writeProfileLine: (line) => lines.push(line),
      profileSignals: false },
  }), refused("ANALYTICS_V2_REFRESH_DATABASE_UNCONFIGURED"));
  assert.equal(lines.length, 1);
  const exit = assertContentFree(lines[0]);
  assert.equal(exit.reason, "exit-failed");
  assert.equal(exit.phase, "configuration");
  // A production target refuses the profiler before any profiler exists.
  let created = 0;
  await assert.rejects(runAnalyticsRefresh({ argv: ["--mode=full"], env: {
    ANALYTICS_REFRESH_TARGET: "production", PRIMARY_SCHEMA: "tibotattle_runtime", ANALYTICS_V2_REFRESH_PROFILE: "cpu" },
  dependencies: { createProfiler: () => { created += 1; }, heapLimitBytes: 16 * 1_024 ** 3 } }),
  refused("ANALYTICS_V2_REFRESH_PROFILE_FORBIDDEN", "ANALYTICS_V2_REFRESH_PROFILE"));
  assert.equal(created, 0);
});
