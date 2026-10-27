#!/usr/bin/env node
/**
 * Partition the canonical package.json check, without maintaining another gate.
 * The two main Vitest routes use native whole-file shards. Analytics first
 * verifies the committed vendor tree; checks retains that same canonical vendor
 * check in place for its downstream consumers. Only all four routes prove check.
 *
 * node scripts/ci-worker-suite.mjs --plan
 * node scripts/ci-worker-suite.mjs --shard vitest-1
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const WORKER_ROOT = resolve(dirname(SCRIPT_FILE), "..");
export const WORKER_SUITE_SHARDS = Object.freeze(["vitest-1", "vitest-2", "analytics", "checks"]);
const MAIN_SCRIPT = "test";
const ANALYTICS_SCRIPT = "analytics-v2:check";
const VENDOR_SCRIPT = "vendor:kernels:check";
const MAIN_COMMAND = "vitest run";
const ANALYTICS_COMMAND = "npm run analytics-v2:pricer:check && npm run analytics-v2:model-blocks:check && vitest run --config vitest.analytics-v2.config.mjs";

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

/** New canonical npm commands automatically join checks, in canonical order. */
export function workerSuitePlan(scripts) {
  if (typeof scripts?.check !== "string" || scripts.check.trim() === "") {
    fail("CI_WORKER_ROUTING_DRIFT", "package.json scripts.check is missing");
  }
  if (scripts[MAIN_SCRIPT] !== MAIN_COMMAND || scripts[ANALYTICS_SCRIPT] !== ANALYTICS_COMMAND) {
    fail("CI_WORKER_ROUTING_DRIFT", "the main or analytics command changed; review its partition contract");
  }
  const canonical = scripts.check.split("&&").map((part) => {
    const command = part.trim();
    const match = /^npm run ([a-z0-9][a-z0-9:-]*)$/u.exec(command);
    const script = command === "npm test" ? MAIN_SCRIPT : match?.[1];
    if (!script || script === "check" || (script === MAIN_SCRIPT && command !== "npm test")
        || typeof scripts[script] !== "string" || scripts[script].trim() === "") {
      fail("CI_WORKER_ROUTING_DRIFT", `unsupported or missing canonical command ${JSON.stringify(command)}`);
    }
    return Object.freeze({ script, args: Object.freeze(script === MAIN_SCRIPT ? ["test"] : ["run", script]) });
  });
  const names = canonical.map(({ script }) => script);
  if (new Set(names).size !== names.length
      || [MAIN_SCRIPT, ANALYTICS_SCRIPT, VENDOR_SCRIPT].some((script) => !names.includes(script))
      || names.indexOf(VENDOR_SCRIPT) > names.indexOf(ANALYTICS_SCRIPT)) {
    fail("CI_WORKER_ROUTING_DRIFT", "canonical commands must be unique and include main, vendor, then analytics");
  }
  const vendor = canonical.find(({ script }) => script === VENDOR_SCRIPT);
  const analytics = canonical.find(({ script }) => script === ANALYTICS_SCRIPT);
  return Object.freeze({
    canonical: Object.freeze(canonical),
    shards: Object.freeze({
      "vitest-1": Object.freeze([{ script: MAIN_SCRIPT, args: Object.freeze(["test", "--", "--shard=1/2", "--no-file-parallelism"]) }]),
      "vitest-2": Object.freeze([{ script: MAIN_SCRIPT, args: Object.freeze(["test", "--", "--shard=2/2", "--no-file-parallelism"]) }]),
      analytics: Object.freeze([vendor, analytics]),
      checks: Object.freeze(canonical.filter(({ script }) => script !== MAIN_SCRIPT && script !== ANALYTICS_SCRIPT)),
    }),
  });
}

export async function planWorkerSuite({ workerRoot = WORKER_ROOT } = {}) {
  const { scripts } = JSON.parse(await readFile(join(workerRoot, "package.json"), "utf8"));
  return workerSuitePlan(scripts);
}

export function parseWorkerSuiteArguments(argv) {
  let shard = null, planOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--plan" && !planOnly) planOnly = true;
    else if (argv[index] === "--shard" && shard === null && WORKER_SUITE_SHARDS.includes(argv[index + 1])) {
      shard = argv[++index];
    } else fail("CI_WORKER_USAGE", "expected [--plan] [--shard <vitest-1|vitest-2|analytics|checks>]");
  }
  if (!planOnly && shard === null) fail("CI_WORKER_USAGE", "execution requires a closed --shard selector");
  return { shard, planOnly };
}

export function executeWorkerCommand({ args, cwd, env }) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn("npm", args, { cwd, env, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveCommand({ code, signal }));
  });
}

export async function runWorkerSuite({ shard, workerRoot = WORKER_ROOT, env = process.env,
  execute = executeWorkerCommand } = {}) {
  if (!WORKER_SUITE_SHARDS.includes(shard)) fail("CI_WORKER_USAGE", "unknown shard");
  const plan = await planWorkerSuite({ workerRoot });
  for (const { script, args } of plan.shards[shard]) {
    process.stdout.write(`[worker:${shard}] npm ${args.join(" ")}\n`);
    const result = await execute({ args: [...args], cwd: workerRoot, env });
    if (result?.code !== 0 || result?.signal) {
      fail("CI_WORKER_COMMAND_FAILED", `${script} exited ${result?.code ?? "without status"}${result?.signal ? ` (${result.signal})` : ""}`);
    }
  }
  return { status: "passed", shard, commands: plan.shards[shard].map(({ script }) => script) };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    const { planOnly, shard } = parseWorkerSuiteArguments(process.argv.slice(2));
    if (planOnly) {
      const plan = await planWorkerSuite();
      process.stdout.write(`${JSON.stringify(shard === null ? plan : { shard, commands: plan.shards[shard] }, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(await runWorkerSuite({ shard }))}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
