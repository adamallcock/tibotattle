import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { BaseSequencer } from "vitest/node";
import {
  parseWorkerSuiteArguments,
  planWorkerSuite,
  runWorkerSuite,
  workerSuitePlan,
  WORKER_ROOT,
  WORKER_SUITE_SHARDS,
} from "./ci-worker-suite.mjs";

const scripts = JSON.parse(await readFile(join(WORKER_ROOT, "package.json"), "utf8")).scripts;
const names = (commands) => commands.map(({ script }) => script);
const canonicalNames = scripts.check.split(" && ").map((command) => command === "npm test" ? "test" : command.slice("npm run ".length));

test("the four routes cover every canonical command, retaining the checks order and full analytics chain", async () => {
  const plan = await planWorkerSuite();
  assert.deepEqual(WORKER_SUITE_SHARDS, ["vitest-1", "vitest-2", "analytics", "checks"]);
  assert.deepEqual(Object.keys(plan.shards), WORKER_SUITE_SHARDS);
  assert.deepEqual(names(plan.canonical), canonicalNames);
  assert.deepEqual(names(plan.shards.checks), canonicalNames.filter((name) => !["test", "analytics-v2:check"].includes(name)));
  assert.ok(names(plan.shards.checks).includes("test:node"));
  assert.deepEqual(plan.shards.analytics, [
    { script: "vendor:kernels:check", args: ["run", "vendor:kernels:check"] },
    { script: "analytics-v2:check", args: ["run", "analytics-v2:check"] },
  ]);
  for (const [index, shard] of ["vitest-1", "vitest-2"].entries()) {
    assert.deepEqual(plan.shards[shard], [{ script: "test", args: ["test", "--", `--shard=${index + 1}/2`, "--no-file-parallelism"] }]);
  }
  const counts = new Map();
  for (const command of Object.values(plan.shards).flat()) counts.set(command.script, (counts.get(command.script) ?? 0) + 1);
  assert.deepEqual([...counts.keys()].sort(), [...canonicalNames].sort(), "no command is omitted or added");
  for (const name of canonicalNames) {
    assert.equal(counts.get(name), ["test", "vendor:kernels:check"].includes(name) ? 2 : 1,
      "only the two native main shards and repeated vendor prerequisite may share a command");
  }
});

test("new canonical commands automatically join checks at their original position", () => {
  const updated = { ...scripts, "future:check": "node ./future.check.mjs" };
  updated.check = scripts.check.replace("npm test", "npm run future:check && npm test");
  const plan = workerSuitePlan(updated);
  const expected = canonicalNames.filter((name) => !["test", "analytics-v2:check"].includes(name));
  expected.splice(canonicalNames.indexOf("test"), 0, "future:check");
  assert.deepEqual(names(plan.shards.checks), expected);
  assert.equal(Object.values(plan.shards).flat().filter(({ script }) => script === "future:check").length, 1);
});

test("routing refuses changed main or analytics commands, ambiguous commands and incomplete canonical plans", () => {
  for (const mutate of [
    (copy) => { delete copy.check; },
    (copy) => { copy.check = ""; },
    (copy) => { copy.test += " test/one.spec.ts"; },
    (copy) => { copy.test += " --exclude test/one.spec.ts"; },
    (copy) => { copy["analytics-v2:check"] = "vitest run --config vitest.analytics-v2.config.mjs"; },
    (copy) => { copy["analytics-v2:check"] += " --passWithNoTests"; },
    (copy) => { copy.check = copy.check.replace("npm test", "npm run test"); },
    (copy) => { copy.check = copy.check.replace("npm test", "npm test -- --shard=1/2"); },
    (copy) => { copy.check += " && npm run missing:check"; },
    (copy) => { copy.check += " && npm run check"; },
    (copy) => { copy.check += " && npm test"; },
    (copy) => { copy.check += " || true"; },
    (copy) => { copy.check = copy.check.replace(" && npm test", ""); },
    (copy) => { copy.check = copy.check.replace(" && npm run analytics-v2:check", ""); },
    (copy) => { copy.check = copy.check.replace(" && npm run vendor:kernels:check", ""); },
    (copy) => { copy.check = copy.check.replace(" && npm run vendor:kernels:check", "") + " && npm run vendor:kernels:check"; },
    (copy) => { delete copy["vendor:kernels:check"]; },
    (copy) => { copy["test:node"] = ""; },
  ]) {
    const copy = { ...scripts };
    mutate(copy);
    assert.throws(() => workerSuitePlan(copy), /CI_WORKER_ROUTING_DRIFT/u);
  }
});

test("the CLI permits only complete reviewed routes or a read-only plan", () => {
  assert.deepEqual(parseWorkerSuiteArguments(["--plan"]), { shard: null, planOnly: true });
  for (const shard of WORKER_SUITE_SHARDS) {
    assert.deepEqual(parseWorkerSuiteArguments(["--shard", shard]), { shard, planOnly: false });
    assert.deepEqual(parseWorkerSuiteArguments(["--plan", "--shard", shard]), { shard, planOnly: true });
    assert.deepEqual(parseWorkerSuiteArguments(["--shard", shard, "--plan"]), { shard, planOnly: true });
  }
  for (const args of [[], ["--shard"], ["--shard", "unknown"], ["--shard", "all"], ["--plan", "--plan"],
    ["--shard", "vitest-1", "--shard", "vitest-2"], ["--files", "test/one.spec.ts"], ["--shard=vitest-1"]]) {
    assert.throws(() => parseWorkerSuiteArguments(args), /CI_WORKER_USAGE/u);
  }
  const result = spawnSync(process.execPath, [join(WORKER_ROOT, "scripts/ci-worker-suite.mjs"), "--plan"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), workerSuitePlan(scripts));
});

test("every route executes its canonical commands serially with the Worker cwd and inherited environment", async () => {
  const plan = await planWorkerSuite();
  const env = { PG_TEST_SOCKET: "/private/tmp/synthetic-worker-check/socket", SYNTHETIC: "fixture" };
  for (const shard of WORKER_SUITE_SHARDS) {
    const calls = [];
    let active = false;
    const result = await runWorkerSuite({ shard, env, execute: async (command) => {
      assert.equal(active, false);
      active = true;
      await Promise.resolve();
      calls.push(command);
      active = false;
      return { code: 0, signal: null };
    } });
    assert.deepEqual(calls, plan.shards[shard].map(({ args }) => ({ args, cwd: WORKER_ROOT, env })));
    assert.deepEqual(result, { status: "passed", shard, commands: names(plan.shards[shard]) });
  }
});

test("command failures, missing exits and signals stop a route before any downstream command", async () => {
  for (const exit of [{ code: 1, signal: null }, { code: null, signal: null }, { code: 0, signal: "SIGTERM" }, undefined]) {
    let calls = 0;
    await assert.rejects(runWorkerSuite({ shard: "checks", execute: async () => { calls += 1; return exit; } }), /CI_WORKER_COMMAND_FAILED/u);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(runWorkerSuite({ shard: "analytics", execute: async () => {
    calls += 1;
    throw new Error("synthetic spawn failure");
  } }), /synthetic spawn failure/u);
  assert.equal(calls, 1, "analytics cannot run after its vendor prerequisite fails");
});

test("execution validates the full canonical plan before starting even one selected command", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-worker-suite-check-"));
  let calls = 0;
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { ...scripts, test: "vitest run test/one.spec.ts" } }));
    await assert.rejects(runWorkerSuite({ shard: "checks", workerRoot: root, execute: async () => { calls += 1; } }), /CI_WORKER_ROUTING_DRIFT/u);
    await assert.rejects(runWorkerSuite({ shard: "unknown", execute: async () => { calls += 1; } }), /CI_WORKER_USAGE/u);
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the installed native Vitest sequencer partitions the complete discovered main suite once by whole file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-worker-suite-inventory-"));
  try {
    // `list --filesOnly` discovers through the unchanged main config without
    // executing tests. Native execution applies BaseSequencer.shard afterwards;
    // the list command itself does not apply --shard.
    const result = spawnSync(process.execPath, [join(WORKER_ROOT, "node_modules/vitest/vitest.mjs"), "list", "--filesOnly", "--json"], {
      cwd: WORKER_ROOT, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(root, "wrangler.log") },
    });
    assert.equal(result.status, 0, result.stderr);
    const files = JSON.parse(result.stdout).map(({ file }) => file);
    assert.ok(files.length > 0);
    assert.ok(files.every((file) => typeof file === "string"));
    assert.equal(new Set(files).size, files.length);
    assert.ok(files.some((file) => relative(WORKER_ROOT, file) === "src/postgres-classification-correction.test.ts"),
      "native discovery includes the main test outside test/");
    const specs = files.map((moduleId) => ({ moduleId }));
    const partitions = [];
    const plan = await planWorkerSuite();
    for (const shard of ["vitest-1", "vitest-2"]) {
      const flag = plan.shards[shard][0].args.find((arg) => arg.startsWith("--shard="));
      const [, index, count] = /^--shard=(\d+)\/(\d+)$/u.exec(flag);
      const sequencer = new BaseSequencer({ config: { root: WORKER_ROOT, shard: { index: Number(index), count: Number(count) } } });
      const partition = await sequencer.shard(specs);
      assert.ok(partition.length > 0);
      assert.deepEqual(await sequencer.shard([...specs].reverse()), partition, "native membership is discovery-order independent");
      assert.ok(partition.every((spec) => specs.includes(spec)), "sharding preserves each entire discovered file");
      partitions.push(partition);
    }
    const all = partitions.flat().map(({ moduleId }) => moduleId);
    assert.equal(new Set(all).size, files.length, "the main shards are disjoint");
    assert.deepEqual(all.sort(), [...files].sort(), "no discovered file is added or omitted");
    assert.ok(Math.abs(partitions[0].length - partitions[1].length) <= 1);
    context.diagnostic(`Native Vitest inventory: ${files.length} files, shards ${partitions.map((partition) => partition.length).join("/")}, no overlap or omissions`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
