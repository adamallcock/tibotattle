#!/usr/bin/env node
/**
 * Run the source-level PostgreSQL activation producer regression set with the
 * same TAP parsing and zero-skip semantics as the complete PostgreSQL suite.
 * The fixed list is intentionally narrow: this job gives the changed producer
 * fixtures a separately schedulable CI result without replacing or filtering
 * the complete suite.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluatePostgresSuite,
  NODE_RUNNER,
  parseNodeTap,
  passEnvironment,
  planPostgresSuite,
  PROFILE_SOCKET,
  readSocketProfileInput,
  WORKER_ROOT,
} from "./ci-postgres-suite.mjs";

export const ACTIVATION_PRODUCER_FILES = Object.freeze([
  "postgres-test/classification-correction.spec.mjs",
  "postgres-test/typed-v12-domain-unchanged.spec.mjs",
  "postgres-test/typed-v12-predecessor-day-count.spec.mjs",
]);

export class ActivationProducerSuiteError extends Error {
  constructor(code) {
    super(code);
    this.name = "ActivationProducerSuiteError";
    this.code = code;
  }
}

/** Select only the fixed producer specs and fail closed if registration drifts. */
export function selectActivationProducerPlan(plan) {
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.files)
      || !Array.isArray(plan.failures)) {
    throw new ActivationProducerSuiteError("ACTIVATION_PLAN_INVALID");
  }

  const files = ACTIVATION_PRODUCER_FILES.map((file) => {
    const entries = plan.files.filter((entry) => entry?.file === file);
    if (entries.length !== 1) throw new ActivationProducerSuiteError("ACTIVATION_SPEC_NOT_REGISTERED");
    const [entry] = entries;
    if (entry.runner !== NODE_RUNNER || entry.profile !== PROFILE_SOCKET) {
      throw new ActivationProducerSuiteError("ACTIVATION_SPEC_PROFILE_DRIFT");
    }
    if (plan.failures.some((failure) => failure?.file === file)) {
      throw new ActivationProducerSuiteError("ACTIVATION_SPEC_REGISTRATION_FAILED");
    }
    return entry;
  });
  return Object.freeze({ files: Object.freeze(files), failures: Object.freeze([]) });
}

function runNodeTest(args, { cwd, env }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolvePromise({
        exitCode: code ?? (signal === null ? 1 : 128),
        stdout: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}

export async function runActivationProducerSuite({
  workerRoot = WORKER_ROOT,
  environment = process.env,
  run = runNodeTest,
} = {}) {
  const profile = readSocketProfileInput(environment);
  const discovered = await planPostgresSuite({ workerRoot });
  const plan = selectActivationProducerPlan(discovered);
  const passEnv = passEnvironment(environment, PROFILE_SOCKET, profile);
  const records = [];

  for (const entry of plan.files) {
    const absoluteFile = resolve(workerRoot, entry.file);
    const { exitCode, stdout } = await run([
      "--test",
      "--test-concurrency=1",
      "--test-reporter=tap",
      `./${entry.file}`,
    ], { cwd: workerRoot, env: passEnv });
    const parsed = parseNodeTap(stdout, { absoluteFile, cwd: workerRoot });
    if (exitCode !== 0 || parsed.tests.some(({ status }) => status !== "passed") || parsed.fileFailure) {
      process.stderr.write(`\n--- ${entry.file} ---\n${stdout}\n`);
    }
    records.push({
      pass: PROFILE_SOCKET,
      runner: NODE_RUNNER,
      file: entry.file,
      exitCode,
      files: new Map([[entry.file, { tests: parsed.tests, fileFailure: parsed.fileFailure }]]),
      parseFailures: parsed.parseFailures,
    });
  }

  return evaluatePostgresSuite({ plan, records });
}

async function main(argv) {
  if (argv.length !== 0) throw new ActivationProducerSuiteError("ACTIVATION_SUITE_USAGE");
  const summary = await runActivationProducerSuite();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof ActivationProducerSuiteError
      ? error.code
      : error?.code === "CI_SUITE_PROFILE_INVALID" ? "CI_SUITE_PROFILE_INVALID" : "ACTIVATION_SUITE_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "error", code })}\n`);
    process.exitCode = 1;
  }
}
