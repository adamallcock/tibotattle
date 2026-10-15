import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";

import {
  checkReleaseWorkflowPolicy,
  inspectWorkflowSource,
} from "../scripts/check-release-workflow-policy.mjs";
import {
  ACTIVATION_PRODUCER_FILES,
  runActivationProducerSuite,
  selectActivationProducerPlan,
} from "../apps/worker/scripts/ci-postgres-activation-producer-suite.mjs";
import { planPostgresSuite } from "../apps/worker/scripts/ci-postgres-suite.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = ".github/workflows/hosted-backend.yml";
const CONTAINER_SCRIPT = "apps/worker/scripts/ci-postgres-container.mjs";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const UPLOAD_ARTIFACT = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ARTIFACT = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const EXPECTED_PATHS = Object.freeze([
  "apps/worker/**",
  "apps/web/public/**",
  "apps/electron/**",
  "config/**",
  "native/**",
  "packages/**",
  "schemas/**",
  "scripts/**",
  "src/**",
  "test/**",
  "package.json",
  "pnpm-lock.yaml",
  ".github/workflows/hosted-backend.yml",
]);
const START_POSTGRES = "node apps/worker/scripts/ci-postgres-container.mjs --export-socket-profile";
const STOP_POSTGRES = "node apps/worker/scripts/ci-postgres-container.mjs --stop";
const SUITE_SCRIPT = "apps/worker/scripts/ci-postgres-suite.mjs";
const ACTIVATION_PRODUCER_SUITE_SCRIPT = "apps/worker/scripts/ci-postgres-activation-producer-suite.mjs";
const EDGE_SPEC = "apps/worker/postgres-test/edge-origin-e2e.spec.mjs";
const TRANSFER_SPEC = "apps/worker/postgres-test/postgres-v12-transfer.spec.mjs";
const SELECTED_SOURCE_EXPRESSION = "${{ github.event.pull_request.head.sha || github.sha }}";
const TOOLCHAIN_NODE = "26.2.0";
const IMAGE_NODE = "22.16.0";
// Worker producer jobs and PostgreSQL producers run the repository toolchain.
// The Worker aggregate is metadata-only. PostgreSQL producers also install the
// Cloud Run image runtime first; see scripts/check-release-workflow-policy.mjs.
const NODE_PLAN = Object.freeze({
  "worker-foundation": Object.freeze([TOOLCHAIN_NODE]),
  "worker-runtime-tests": Object.freeze([TOOLCHAIN_NODE]),
  "worker-analytics-fastpath": Object.freeze([TOOLCHAIN_NODE]),
  "worker-gate": Object.freeze([]),
  "cloud-run-check": Object.freeze([TOOLCHAIN_NODE]),
  "postgres-17-core-a": Object.freeze([IMAGE_NODE, TOOLCHAIN_NODE]),
  "postgres-17-core-b": Object.freeze([IMAGE_NODE, TOOLCHAIN_NODE]),
  "postgres-17-edge-e2e": Object.freeze([IMAGE_NODE, TOOLCHAIN_NODE]),
  "postgres-17-suite": Object.freeze([TOOLCHAIN_NODE]),
  "activation-producer-postgres-17": Object.freeze([TOOLCHAIN_NODE]),
});
// The Worker runtime-tests stage runs vendored-kernel identity and transition
// checks against pinned production commits and the reviewed historical facade.
// The Cloud Run check reads pinned restore-base and production commits, and the
// PostgreSQL 17 suite archives its pinned READ-EXPANSION base. Every checkout
// job needs these immutable Git objects and fails without full history.
const FETCH_DEPTH = Object.freeze(Object.fromEntries(Object.keys(NODE_PLAN)
  .filter((id) => id !== "worker-gate").map((id) => [id, 0])));
const INSTALL_COMMANDS = Object.freeze(["npm --prefix apps/worker ci", "npm --prefix apps/worker/cloud-run ci"]);
// The components of gcp:production-tooling:local-check. The first is split: its
// offline half runs inside the Cloud Run check and its PostgreSQL-backed spec in
// the PostgreSQL 17 suite. The rest run in the Cloud Run job, one step each.
const SPLIT_PRODUCTION_TOOLING = "postgres:production-migrations:check";
const OFFLINE_PRODUCTION_TOOLING = Object.freeze([
  "gcp:production-rollout:check",
  "gcp:barrier-capture:check",
  "gcp:ops:infra:check",
  "postgres:cutover-seal:check",
]);
const LOCAL_CHECK = "gcp:production-tooling:local-check";
const workerNpm = (script) => `npm --prefix apps/worker run ${script}`;
const WORKER_STAGE_PLAN = Object.freeze([
  Object.freeze({ id: "worker-foundation", script: "check:foundation", start: 0, end: 12 }),
  Object.freeze({ id: "worker-runtime-tests", script: "check:runtime-tests", start: 12, end: 18 }),
  Object.freeze({ id: "worker-analytics-fastpath", script: "check:analytics-fastpath", start: 18, end: 22 }),
]);
const WORKER_STAGE_IDS = Object.freeze(WORKER_STAGE_PLAN.map(({ id }) => id));
const WORKER_CHECK_COMMANDS = Object.freeze([
  "npm run postgres:migrations:check",
  "npm run append-only:absence:check",
  "npm run postgres:source-transfer:check",
  "npm run postgres:accountless-retention-import:check",
  "npm run postgres:analytics-transfer:check",
  "npm run postgres:object-transfer:check",
  "npm run workspace-packages:check",
  "npm run deployment:endpoints:check",
  "npm run types:check",
  "npm run typecheck",
  "npm run scripts:check",
  "npm run gcp:origin-smoke:check",
  "npm test",
  "npm run test:node",
  "npm run vendor:kernels:check",
  "npm run v0x:admission:check",
  "npm run postgres:retired-readers:check",
  "npm run catalog:manifest:check",
  "npm run analytics-v2:check",
  "npm run gcp:fastpath:scripts-check",
  "npm run deploy:dry",
  "npm run staging:check",
]);
const WORKER_GATE_COMMAND = [
  "set -euo pipefail",
  'test "$CI_WORKER_FOUNDATION_RESULT" = "success"',
  'test "$CI_WORKER_RUNTIME_RESULT" = "success"',
  'test "$CI_WORKER_ANALYTICS_RESULT" = "success"',
  'test "$CI_WORKER_FOUNDATION_HEAD" = "$CI_WORKER_EXPECTED_HEAD"',
  'test "$CI_WORKER_RUNTIME_HEAD" = "$CI_WORKER_EXPECTED_HEAD"',
  'test "$CI_WORKER_ANALYTICS_HEAD" = "$CI_WORKER_EXPECTED_HEAD"',
  'test "$CI_WORKER_FOUNDATION_HEAD" = "$CI_WORKER_RUNTIME_HEAD"',
  'test "$CI_WORKER_RUNTIME_HEAD" = "$CI_WORKER_ANALYTICS_HEAD"',
  'test "$CI_WORKER_FOUNDATION_RUN_ID" = "$GITHUB_RUN_ID"',
  'test "$CI_WORKER_RUNTIME_RUN_ID" = "$GITHUB_RUN_ID"',
  'test "$CI_WORKER_ANALYTICS_RUN_ID" = "$GITHUB_RUN_ID"',
  'test "$CI_WORKER_FOUNDATION_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"',
  'test "$CI_WORKER_RUNTIME_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"',
  'test "$CI_WORKER_ANALYTICS_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"',
].join("\n");

// ---------------------------------------------------------------------------
// A line-wise reader for the block YAML subset this workflow uses: mappings,
// sequences, `|` block scalars, quoted and plain scalars, and comments.
// ---------------------------------------------------------------------------

function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/u.test(line[index - 1]))) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line.trimEnd();
}

function scalar(value) {
  const text = value.trim();
  if (text.length >= 2 && text[0] === "\"" && text.at(-1) === "\"") return JSON.parse(text);
  if (text.length >= 2 && text[0] === "'" && text.at(-1) === "'") return text.slice(1, -1).replaceAll("''", "'");
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/u.test(text)) return Number(text);
  return text;
}

function readWorkflow(text) {
  const lines = String(text).split(/\r?\n/u).map((raw) => {
    const content = stripComment(raw);
    return { raw, content, indent: raw.length - raw.trimStart().length, blank: content.trim() === "" };
  });
  let cursor = 0;
  const skipBlank = () => {
    while (cursor < lines.length && lines[cursor].blank) cursor += 1;
  };
  const blockScalar = (parentIndent) => {
    const collected = [];
    let blockIndent = null;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.raw.trim() !== "") {
        if (line.indent <= parentIndent) break;
        blockIndent ??= line.indent;
      }
      collected.push(line.raw);
      cursor += 1;
    }
    while (collected.length > 0 && collected.at(-1).trim() === "") collected.pop();
    return `${collected.map((line) => line.slice(blockIndent ?? 0)).join("\n")}\n`;
  };
  const keyValue = (content) => {
    const match = /^([A-Za-z0-9_.-]+|"[^"]+"):(?:\s+(.*))?$/u.exec(content);
    if (match === null) throw new Error(`unsupported YAML line: ${content}`);
    return [scalar(match[1]), match[2] ?? ""];
  };
  const value = (rest, indent) => {
    if (rest === "|") return blockScalar(indent);
    if (rest !== "") return scalar(rest);
    skipBlank();
    if (cursor >= lines.length || lines[cursor].indent <= indent) return null;
    return node(lines[cursor].indent);
  };
  const mapping = (indent, first = null) => {
    const result = {};
    if (first !== null) {
      const [key, rest] = keyValue(first);
      result[key] = value(rest, indent);
    }
    for (;;) {
      skipBlank();
      if (cursor >= lines.length) break;
      const line = lines[cursor];
      if (line.indent !== indent || line.content.trimStart().startsWith("- ")) break;
      cursor += 1;
      const [key, rest] = keyValue(line.content.trim());
      assert.ok(!Object.hasOwn(result, key), `duplicate YAML key ${key}`);
      result[key] = value(rest, indent);
    }
    return result;
  };
  const sequence = (indent) => {
    const result = [];
    for (;;) {
      skipBlank();
      if (cursor >= lines.length) break;
      const line = lines[cursor];
      const content = line.content.trimStart();
      if (line.indent !== indent || !content.startsWith("- ")) break;
      cursor += 1;
      const item = content.slice(2);
      result.push(/^([A-Za-z0-9_.-]+|"[^"]+"):(?:\s|$)/u.test(item)
        ? mapping(indent + 2, item)
        : scalar(item));
    }
    return result;
  };
  function node(indent) {
    skipBlank();
    return lines[cursor].content.trimStart().startsWith("- ") ? sequence(indent) : mapping(indent);
  }
  const document = node(0);
  skipBlank();
  assert.equal(cursor, lines.length, "the whole workflow was read");
  return document;
}

async function loadWorkflow() {
  const text = await readFile(join(REPOSITORY_ROOT, WORKFLOW_PATH), "utf8");
  return { text, workflow: readWorkflow(text) };
}

const runs = (job) => job.steps.filter((step) => typeof step.run === "string").map((step) => step.run.trim());

// ---------------------------------------------------------------------------
// Workflow contract
// ---------------------------------------------------------------------------

test("hosted-backend passes the repository workflow policy", async () => {
  const { text } = await loadWorkflow();
  assert.deepEqual(inspectWorkflowSource(text, { path: WORKFLOW_PATH }), []);
  const policy = await checkReleaseWorkflowPolicy();
  assert.ok(policy.files.includes(WORKFLOW_PATH));
});

test("hosted-backend triggers on pull requests, main pushes and dispatch with the same broad paths", async () => {
  const { text, workflow } = await loadWorkflow();
  assert.equal(workflow.name, "Hosted backend");
  assert.deepEqual(Object.keys(workflow.on), ["pull_request", "push", "workflow_dispatch"]);
  assert.doesNotMatch(text, /pull_request_target/u);
  assert.deepEqual(workflow.on.pull_request, { paths: [...EXPECTED_PATHS] });
  assert.deepEqual(workflow.on.push, { branches: ["main"], paths: [...EXPECTED_PATHS] });
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.deepEqual(workflow.concurrency, {
    group: "hosted-backend-${{ github.ref }}",
    "cancel-in-progress": true,
  });
});

test("hosted-backend is read-only: contents read, no secrets, no environments, pinned actions", async () => {
  const { text, workflow } = await loadWorkflow();
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(text, /\bsecrets\./u);
  assert.doesNotMatch(text, /^\s*environment:/mu);
  assert.doesNotMatch(text, /id-token|: write\b/u);
  const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  for (const action of uses) {
    assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/u, `${action} is pinned to a full commit SHA`);
    assert.ok([CHECKOUT, SETUP_NODE, UPLOAD_ARTIFACT, DOWNLOAD_ARTIFACT].includes(action), `${action} is a reviewed pin`);
  }
  for (const [id, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.permissions, undefined, `${id} inherits contents: read`);
    assert.equal(job.environment, undefined, `${id} has no environment`);
    for (const step of job.steps) {
      if (step.uses === CHECKOUT) {
        assert.deepEqual(step.with, { ref: SELECTED_SOURCE_EXPRESSION, "fetch-depth": FETCH_DEPTH[id], "persist-credentials": false },
          `${id} checks out its reviewed history depth without persisted credentials`);
      }
      if (step.uses === SETUP_NODE) {
        assert.deepEqual(step.with, {
          "node-version": step.with["node-version"],
          "check-latest": false,
          "package-manager-cache": false,
        });
      }
    }
    assert.equal(job.steps.filter(({ uses: action }) => action === CHECKOUT).length, id === "worker-gate" ? 0 : 1);
    assert.deepEqual(
      job.steps.filter(({ uses: action }) => action === SETUP_NODE).map((step) => step.with["node-version"]),
      NODE_PLAN[id],
      `${id} installs exactly its reviewed Node.js versions, in order`,
    );
  }
});

test("the Worker runtime stage keeps the full-history vendored-kernel identity gate", async () => {
  const { workflow } = await loadWorkflow();
  const workerPackage = JSON.parse(await readFile(join(REPOSITORY_ROOT, "apps/worker/package.json"), "utf8"));
  assert.ok(workerPackage.scripts.check.split(" && ").includes("npm run vendor:kernels:check"),
    "the original Worker check retains vendored-kernel identity verification");
  assert.ok(workerPackage.scripts["check:runtime-tests"].split(" && ").includes("npm run vendor:kernels:check"),
    "the runtime stage retains vendored-kernel identity verification");
  const vendorJobs = Object.entries(workflow.jobs)
    .filter(([, job]) => runs(job).includes(workerNpm("check:runtime-tests")));
  assert.deepEqual(vendorJobs.map(([id]) => id), ["worker-runtime-tests"]);
  for (const [id, job] of vendorJobs) {
    const checkout = job.steps.find(({ uses: action }) => action === CHECKOUT);
    assert.equal(checkout.with["fetch-depth"], 0,
      `${id} needs pinned production, historical-facade and transition commit objects`);
  }
});

test("every job that runs the cutover seal check checks out full history", async () => {
  const { workflow } = await loadWorkflow();
  const sealJobs = Object.entries(workflow.jobs)
    .filter(([, job]) => runs(job).includes(workerNpm("postgres:cutover-seal:check")));
  assert.deepEqual(sealJobs.map(([id]) => id), ["cloud-run-check"]);
  for (const [id, job] of sealJobs) {
    const checkout = job.steps.find(({ uses: action }) => action === CHECKOUT);
    assert.equal(checkout.with["fetch-depth"], 0, `${id} needs the pinned commit objects the seal check reads`);
  }
});

test("no run block interpolates GitHub expressions into a shell", async () => {
  const { text, workflow } = await loadWorkflow();
  assert.doesNotMatch(text.replaceAll(SELECTED_SOURCE_EXPRESSION, "reviewed-source"), /\$\{\{\s*github\.event/u, "the reviewed SHA selection is the only event expression");
  for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const command of runs(job)) {
      assert.doesNotMatch(command, /\$\{\{/u, `${id} run blocks use environment variables, not expressions`);
    }
    for (const step of job.steps) {
      if (step.env !== undefined) assert.deepEqual(step.env, reviewedReceiptEnvironment(id), `${id} uses only immutable source and job-result env`);
    }
    for (const [name, value] of Object.entries(job.env ?? {})) {
      assert.equal(typeof value, "string", `${id} env ${name} is a quoted literal`);
      assert.doesNotMatch(value, /\$\{\{/u, `${id} env ${name} is static`);
    }
  }
});

function workerStageFailures(workflow, workerPackage) {
  const failures = [];
  if (workerPackage.scripts.check !== WORKER_CHECK_COMMANDS.join(" && ")) {
    failures.push("the original Worker check command chain changed");
  }
  const canonical = workerPackage.scripts.check?.split(" && ") ?? [];
  const partition = [];
  for (const { id, script, start, end } of WORKER_STAGE_PLAN) {
    const stageCommands = workerPackage.scripts[script]?.split(" && ") ?? [];
    if (JSON.stringify(stageCommands) !== JSON.stringify(canonical.slice(start, end))) {
      failures.push(`${script} is not its exact disjoint slice of the original Worker check`);
    }
    partition.push(...stageCommands);
    const job = workflow.jobs[id];
    if (!job) { failures.push(`${id} is missing`); continue; }
    if (job.if !== undefined || job["continue-on-error"] !== undefined) failures.push(`${id} is conditional or permits failure`);
    if (job["timeout-minutes"] !== 60) failures.push(`${id} changes the 60 minute deadline`);
    if (JSON.stringify(job.env) !== JSON.stringify({ WRANGLER_SEND_METRICS: "false" })) failures.push(`${id} changes the reviewed Wrangler environment`);
    if (JSON.stringify(job.outputs) !== JSON.stringify({
      source_sha: "${{ steps.report-worker-stage.outputs.source_sha }}",
      run_id: "${{ steps.report-worker-stage.outputs.run_id }}",
      run_attempt: "${{ steps.report-worker-stage.outputs.run_attempt }}",
    })) failures.push(`${id} does not expose its success-only source, run and attempt provenance`);
    const stageRun = workerNpm(script);
    const gate = job.steps.filter((step) => step.run?.trim() === stageRun);
    if (gate.length !== 1 || gate[0]?.if !== undefined || gate[0]?.["continue-on-error"] !== undefined) {
      failures.push(`${id} does not run its exact stage exactly once as a required step`);
    }
    if (job.steps.some((step) => WORKER_STAGE_PLAN.some((other) => other.script !== script
      && step.run?.trim() === workerNpm(other.script)))) failures.push(`${id} runs a different Worker stage`);
    if (job.steps.some((step) => /\bEDGE_E2E_(?:NODE|GOLDEN|REHEARSAL_NODE|S9_COMPARISON_MODE)\b|POSTGRES_V12_TRANSFER_Q1_DUMP|22\.16/u.test(`${step.run ?? ""}${step.with?.["node-version"] ?? ""}`))) {
      failures.push(`${id} carries PostgreSQL edge-runtime inputs outside the routed PostgreSQL producer`);
    }
    const stageOwners = Object.entries(workflow.jobs)
      .filter(([, candidate]) => runs(candidate).includes(stageRun))
      .map(([owner]) => owner);
    if (JSON.stringify(stageOwners) !== JSON.stringify([id])) failures.push(`${script} must run only in its one reviewed producer job`);
    const sourceChecks = job.steps.filter((step) => step.run?.trim() === 'test "$(git rev-parse HEAD)" = "$CI_WORKER_EXPECTED_HEAD"');
    if (sourceChecks.length !== 1 || JSON.stringify(sourceChecks[0]?.env) !== JSON.stringify({
      CI_WORKER_EXPECTED_HEAD: SELECTED_SOURCE_EXPRESSION,
    })) failures.push(`${id} does not bind its stage to the selected source`);
    const report = job.steps.filter((step) => step.id === "report-worker-stage");
    const reportRun = report[0]?.run ?? "";
    const reportLines = [
      'test "$(git rev-parse HEAD)" = "$CI_WORKER_EXPECTED_HEAD"',
      `printf 'source_sha=%s\\n' "$(git rev-parse HEAD)"`,
      `printf 'run_id=%s\\n' "$GITHUB_RUN_ID"`,
      `printf 'run_attempt=%s\\n' "$GITHUB_RUN_ATTEMPT"`,
    ];
    const outputLines = reportLines.slice(1).map((line) => `${line} >> "$GITHUB_OUTPUT"`);
    if (report.length !== 1 || job.steps.at(-1) !== report[0] || report[0]?.if !== undefined
      || report[0]?.["continue-on-error"] !== undefined
      || JSON.stringify(report[0]?.env) !== JSON.stringify({ CI_WORKER_EXPECTED_HEAD: SELECTED_SOURCE_EXPRESSION })
      || reportLines.some((line) => !reportRun.includes(line))
      || outputLines.some((line) => !reportRun.includes(line))) {
      failures.push(`${id} does not report successful source/run/attempt provenance after cleanup`);
    }
    const starts = job.steps.filter((step) => step.run?.trim() === START_POSTGRES);
    const stops = job.steps.filter((step) => step.run?.trim() === STOP_POSTGRES);
    if (starts.length !== 1 || stops.length !== 1 || stops[0]?.if !== "always()") failures.push(`${id} does not preserve its private PostgreSQL lifecycle`);
    const stageIndex = job.steps.indexOf(gate[0]);
    const sourceIndex = job.steps.indexOf(sourceChecks[0]);
    const startIndex = job.steps.indexOf(starts[0]);
    const stopIndex = job.steps.indexOf(stops[0]);
    const reportIndex = job.steps.indexOf(report[0]);
    if (!(startIndex >= 0 && sourceIndex > startIndex && stageIndex > sourceIndex && stopIndex > stageIndex && reportIndex > stopIndex)) {
      failures.push(`${id} must start PostgreSQL, verify source, run its stage, stop PostgreSQL, then report provenance`);
    }
    if (id === "worker-foundation") {
      const guard = job.steps.findIndex((step) => step.run?.includes("node --test test/hosted-backend-workflow.test.js"));
      if (!(guard > sourceIndex && guard < stageIndex)) failures.push("the foundation stage omits its workflow, migration and PostgreSQL routing contract checks");
    }
    if (id === "worker-analytics-fastpath") {
      const measure = job.steps.findIndex((step) => step.name === "Install and verify measurement check prerequisites");
      const site = job.steps.findIndex((step) => step.name === "Build a synthetic public release site for the dry-run asset stage");
      if (!(measure > startIndex && measure < sourceIndex && site > measure && site < sourceIndex)) failures.push("the analytics stage omits or misorders measurement and synthetic release-site prerequisites");
      if (!job.steps[site]?.run?.includes('--output "$GITHUB_WORKSPACE/.release-build/public-release-site"')
        || !job.steps[site]?.run?.includes('--social-image "$social_card"')) failures.push("the analytics stage does not build the synthetic release site at the expected path");
    } else if (job.steps.some((step) => step.name === "Install and verify measurement check prerequisites"
      || step.name === "Build a synthetic public release site for the dry-run asset stage")) {
      failures.push(`${id} carries analytics/deploy-only prerequisites`);
    }
  }
  if (JSON.stringify(partition) !== JSON.stringify(canonical)) failures.push("Worker stages are not a complete ordered union of the original check chain");
  if (new Set(partition).size !== partition.length) failures.push("Worker stage command partitions overlap");
  if (Object.values(workflow.jobs).some((job) => runs(job).includes(workerNpm("check")))) {
    failures.push("hosted Worker jobs must use the reviewed stages while the local serial check remains unchanged");
  }
  if (canonical[11] !== "npm run gcp:origin-smoke:check" || canonical[12] !== "npm test"
    || canonical[17] !== "npm run catalog:manifest:check" || canonical[18] !== "npm run analytics-v2:check"
    || canonical.at(-1) !== "npm run staging:check") failures.push("Worker stage boundaries moved away from the reviewed gate groups");

  const aggregate = workflow.jobs["worker-gate"];
  if (!aggregate) return [...failures, "worker-gate aggregate is missing"];
  if (JSON.stringify(aggregate.needs) !== JSON.stringify(WORKER_STAGE_IDS)) failures.push("worker-gate does not need all Worker stage producers");
  if (aggregate.if !== "always()" || aggregate["continue-on-error"] !== undefined || aggregate["timeout-minutes"] !== 5) failures.push("worker-gate does not fail closed after every producer completes");
  if (aggregate.steps.length !== 1 || aggregate.steps.some((step) => step.if !== undefined || step["continue-on-error"] !== undefined)) failures.push("worker-gate aggregate has conditional or failure-tolerant steps");
  if (aggregate.steps.some((step) => step.uses === CHECKOUT || step.uses === SETUP_NODE)
    || runs(aggregate).some((command) => command.includes("npm ") || command.includes(START_POSTGRES) || command.includes(STOP_POSTGRES))) {
    failures.push("worker-gate aggregate must only validate producer outputs, without checkout, runtime, tests or database");
  }
  const gate = aggregate.steps[0];
  if (gate?.run?.trim() !== WORKER_GATE_COMMAND || JSON.stringify(gate?.env) !== JSON.stringify(reviewedReceiptEnvironment("worker-gate"))) {
    failures.push("worker-gate does not require all success results and exact same-source/run/attempt outputs");
  }
  return failures;
}

test("hosted Worker stages exactly partition the unchanged serial check and require same-source same-attempt success", async () => {
  const { workflow } = await loadWorkflow();
  const workerPackage = JSON.parse(await readFile(join(REPOSITORY_ROOT, "apps/worker/package.json"), "utf8"));
  assert.deepEqual(workerStageFailures(workflow, workerPackage), []);
});


test("hosted execution jobs preserve the reviewed runtime, dependency and PostgreSQL gate inventory", async () => {
  const { workflow } = await loadWorkflow();
  assert.deepEqual(Object.keys(workflow.jobs), Object.keys(NODE_PLAN));
  const timeouts = {
    "worker-foundation": 60,
    "worker-runtime-tests": 60,
    "worker-analytics-fastpath": 60,
    "worker-gate": 5,
    "cloud-run-check": 30,
    "postgres-17-suite": 45,
    "activation-producer-postgres-17": 30,
    ...Object.fromEntries(PARTITION_PLAN.map(({ id }) => [id, 45])),
  };
  const gates = {
    "worker-foundation": workerNpm("check:foundation"),
    "worker-runtime-tests": workerNpm("check:runtime-tests"),
    "worker-analytics-fastpath": workerNpm("check:analytics-fastpath"),
    "cloud-run-check": "npm --prefix apps/worker/cloud-run run check",
    "postgres-17-suite": aggregateCommand(),
    "activation-producer-postgres-17": activationProducerCommand(),
    ...Object.fromEntries(PARTITION_PLAN.map(({ id, partition, stem }) => [id, partitionCommand(partition, stem)])),
  };
  for (const [id, job] of Object.entries(workflow.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-24.04", id);
    assert.equal(job["timeout-minutes"], timeouts[id], id);
    assert.equal(job.services, undefined, `${id} starts PostgreSQL through the reviewed script`);
    const commands = runs(job);
    if (id === "worker-gate") {
      assert.equal(job.steps.filter((step) => step.uses === CHECKOUT || step.uses === SETUP_NODE).length, 0);
      assert.equal(job.steps.some((step) => step.run?.includes("pnpm install")), false);
      assert.equal(commands.length, 1);
      assert.equal(commands[0], WORKER_GATE_COMMAND);
      continue;
    }
    const install = commands.find((command) => command.includes("pnpm install"));
    assert.match(install, /npm install --global corepack@0\.34\.0 --force --ignore-scripts/u);
    assert.match(install, /corepack prepare pnpm@11\.9\.0 --activate/u);
    assert.match(install, /pnpm install --frozen-lockfile --ignore-scripts/u);
    assert.match(install, /^npm --prefix apps\/worker ci$/mu);
    assert.match(install, /^npm --prefix apps\/worker\/cloud-run ci$/mu, `${id} installs the Cloud Run lockfile`);

    const socketRoot = commands.findIndex((command) => command.includes("sudo mkdir -p /private/tmp"));
    const start = commands.indexOf(START_POSTGRES);
    const gate = commands.indexOf(gates[id]);
    if (id === "postgres-17-suite") {
      assert.equal(socketRoot, -1);
      assert.equal(start, -1);
      assert.equal(commands.filter((command) => command === gates[id]).length, 1);
      assert.equal(job.steps.filter((step) => step.if !== undefined).length, 0);
      continue;
    }
    assert.ok(socketRoot >= 0 && start > socketRoot, `${id} prepares /private/tmp before PostgreSQL`);
    assert.match(commands[socketRoot], /sudo chmod 1777 \/private\/tmp/u);
    assert.ok(gate > start, `${id} runs its gate with the SOCKET profile exported`);
    assert.equal(commands.filter((command) => command === gates[id]).length, 1);

    const last = job.steps.find((step) => step.run?.trim() === STOP_POSTGRES);
    assert.deepEqual([last.if, last.run?.trim()], ["always()", STOP_POSTGRES], `${id} always stops PostgreSQL`);
  }
});

test("the focused producer qualification is part of the fail-closed PostgreSQL aggregate", async () => {
  const { workflow } = await loadWorkflow();
  const job = workflow.jobs["activation-producer-postgres-17"];
  assert.equal(job.if, undefined);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(job.env, undefined, "the focused job uses only its exported private socket profile");
  const gate = job.steps.filter((step) => step.run?.trim() === activationProducerCommand());
  assert.equal(gate.length, 1);
  assert.deepEqual(gate[0].env, reviewedReceiptEnvironment("activation-producer-postgres-17"));

  const aggregate = workflow.jobs["postgres-17-suite"];
  assert.ok(aggregate.needs.includes("activation-producer-postgres-17"));
  assert.equal(aggregate.steps.filter((step) => step.run?.trim() === aggregateCommand()).length, 1);
  assert.equal(aggregate.steps.at(-1).env.CI_POSTGRES_ACTIVATION_RESULT,
    "${{ needs.activation-producer-postgres-17.result }}");
});

test("the focused producer job selects only the registered socket-profile regressions", async () => {
  const { workflow } = await loadWorkflow();
  const selected = selectActivationProducerPlan(await planPostgresSuite());
  const expectedFiles = [
    "postgres-test/classification-correction.spec.mjs",
    "postgres-test/typed-v12-domain-unchanged.spec.mjs",
    "postgres-test/typed-v12-predecessor-day-count.spec.mjs",
  ];
  assert.deepEqual(selected.files.map(({ file }) => file), expectedFiles);
  assert.deepEqual(ACTIVATION_PRODUCER_FILES, expectedFiles);
  assert.ok(selected.files.every(({ runner, profile }) => runner === "node" && profile === "SOCKET"));

  const job = workflow.jobs["activation-producer-postgres-17"];
  assert.equal(runs(job).filter((command) => command === activationProducerCommand()).length, 1);
  const omitted = { ...selected, files: selected.files.slice(1) };
  assert.throws(() => selectActivationProducerPlan(omitted), { code: "ACTIVATION_SPEC_NOT_REGISTERED" });
  const wrongProfile = {
    ...selected,
    files: selected.files.map((entry, index) => index === 0 ? { ...entry, profile: "HOST" } : entry),
  };
  assert.throws(() => selectActivationProducerPlan(wrongProfile), { code: "ACTIVATION_SPEC_PROFILE_DRIFT" });
});

test("the focused runner reuses TAP parsing and rejects skipped PostgreSQL tests", async () => {
  const calls = [];
  const skippedTap = `TAP version 13
# Subtest: synthetic gated test
ok 1 - synthetic gated test # SKIP
1..1
# tests 1
# suites 0
# pass 0
# fail 0
# cancelled 0
# skipped 1
# todo 0
`;
  const summary = await runActivationProducerSuite({
    environment: {
      PG_TEST_SOCKET: "/private/tmp/tibotattle-pg-focused/socket",
      PG_TEST_PORT: "5432",
    },
    run: async (args, options) => {
      calls.push({ args, cwd: options.cwd, socket: options.env.PG_TEST_SOCKET });
      return { exitCode: 0, stdout: skippedTap };
    },
  });
  assert.equal(calls.length, ACTIVATION_PRODUCER_FILES.length);
  assert.deepEqual(calls.map(({ args }) => args.at(-1)), ACTIVATION_PRODUCER_FILES.map((file) => `./${file}`));
  assert.ok(calls.every(({ socket }) => socket === "/private/tmp/tibotattle-pg-focused/socket"));
  assert.equal(summary.status, "failed");
  assert.equal(summary.skipped.length, ACTIVATION_PRODUCER_FILES.length);
  assert.ok(summary.failures.every(({ code }) => code === "SILENTLY_SKIPPED"));
});

test("Worker partition contract rejects missing, overlapping, weakened or cross-attempt stage aggregation", async () => {
  const { workflow } = await loadWorkflow();
  const workerPackage = JSON.parse(await readFile(join(REPOSITORY_ROOT, "apps/worker/package.json"), "utf8"));
  for (const mutate of [
    (copy) => { delete copy.jobs["worker-runtime-tests"]; },
    (copy) => { copy.jobs["worker-runtime-tests"].steps.find((step) => step.run?.trim() === workerNpm("check:runtime-tests")).run = workerNpm("check:foundation"); },
    (copy) => { copy.jobs["worker-gate"].needs.pop(); },
    (copy) => { copy.jobs["worker-gate"].if = "success()"; },
    (copy) => { copy.jobs["worker-gate"]["continue-on-error"] = true; },
    (copy) => { copy.jobs["worker-gate"].steps[0].env.CI_WORKER_RUNTIME_RESULT = "success"; },
    (copy) => { copy.jobs["worker-gate"].steps[0].run = WORKER_GATE_COMMAND.replace('test "$CI_WORKER_RUNTIME_RESULT" = "success"', "true"); },
    (copy) => { copy.jobs["worker-gate"].steps[0].env.CI_WORKER_RUNTIME_RUN_ATTEMPT = "${{ github.run_attempt }}"; },
    (copy) => { copy.jobs["worker-foundation"].steps.find((step) => step.run?.trim() === workerNpm("check:foundation"))["continue-on-error"] = true; },
    (copy) => {
      const report = copy.jobs["worker-foundation"].steps.find((step) => step.id === "report-worker-stage");
      report.run = report.run.replace(' >> "$GITHUB_OUTPUT"', ' >> "$GITHUB_ENV"');
    },
  ]) {
    const changed = structuredClone(workflow);
    mutate(changed);
    assert.ok(workerStageFailures(changed, workerPackage).length > 0);
  }
  const changedPackage = structuredClone(workerPackage);
  changedPackage.scripts["check:runtime-tests"] += " && npm run analytics-v2:check";
  assert.ok(workerStageFailures(workflow, changedPackage).length > 0, "overlapping command is rejected");
  const changedChain = structuredClone(workerPackage);
  changedChain.scripts.check += " && npm run unclassified:check";
  assert.ok(workerStageFailures(workflow, changedChain).length > 0, "changed serial check requires reclassification");
});

function assertMeasurementPrerequisites(workflow) {
  const steps = workflow.jobs["worker-analytics-fastpath"].steps;
  const matching = steps.filter(step => step.name === "Install and verify measurement check prerequisites");
  assert.equal(matching.length, 1, "exactly one measurement prerequisite step");
  const step = matching[0], index = steps.indexOf(step);
  assert.equal(step.if, undefined, "measurement prerequisites are unconditional");
  assert.equal(step["continue-on-error"], undefined, "measurement prerequisite failures block the gate");
  assert.doesNotMatch(step.run, /\|\|\s*(?:true|:)/u, "measurement failures are never swallowed");
  for (const command of ["set -euo pipefail", "sudo apt-get update",
    "sudo apt-get install --yes --no-install-recommends zsh time",
    `zsh -c 'zmodload zsh/datetime; [[ -n "$EPOCHREALTIME" ]]'`,
    "test -x /usr/bin/time", '[[ "$(/usr/bin/time --version)" == *"GNU Time"* ]]',
    "/usr/bin/time -f '%e %U %S %M' /bin/true"]) {
    assert.ok(step.run.trim().split("\n").includes(command), `${command} is retained`);
  }
  const gate = steps.findIndex(candidate => candidate.run?.trim() === workerNpm("check:analytics-fastpath"));
  assert.ok(index >= 0 && index < gate, "prerequisites precede the analytics gate");
}

test("the Linux analytics stage provisions and exercises real measurement prerequisites before its gate", async () => {
  const { workflow } = await loadWorkflow();
  assertMeasurementPrerequisites(workflow);
});

test("the measurement prerequisite contract rejects missing, weakened, duplicate or late setup", async () => {
  const { workflow } = await loadWorkflow();
  for (const weaken of [
    steps => steps.splice(steps.findIndex(step => step.name === "Install and verify measurement check prerequisites"), 1),
    steps => steps.push(structuredClone(steps.find(step => step.name === "Install and verify measurement check prerequisites"))),
    steps => { const index = steps.findIndex(step => step.name === "Install and verify measurement check prerequisites"); steps.push(...steps.splice(index, 1)); },
    steps => { steps.find(step => step.name === "Install and verify measurement check prerequisites").if = "false"; },
    steps => { steps.find(step => step.name === "Install and verify measurement check prerequisites")["continue-on-error"] = true; },
    steps => { const step = steps.find(candidate => candidate.name === "Install and verify measurement check prerequisites"); step.run += "true || true\n"; },
    ...["set -euo pipefail", "sudo apt-get update", "zsh time", "zmodload zsh/datetime", "test -x /usr/bin/time",
      "GNU Time", "/usr/bin/time -f"].map(command => steps => {
        const step = steps.find(candidate => candidate.name === "Install and verify measurement check prerequisites");
        step.run = step.run.split("\n").filter(line => !line.includes(command)).join("\n");
      }),
  ]) {
    const changed = structuredClone(workflow);
    weaken(changed.jobs["worker-analytics-fastpath"].steps);
    assert.throws(() => assertMeasurementPrerequisites(changed));
  }
});

test("only the three PostgreSQL partition jobs get the container's loopback TCP pair", async () => {
  // Without the pair the journal-transfer spec's TCP tests skip, which the
  // suite reports as SILENTLY_SKIPPED; with a wrong port they fail to connect.
  const { workflow } = await loadWorkflow();
  const container = await readFile(join(REPOSITORY_ROOT, CONTAINER_SCRIPT), "utf8");
  const publish = [...container.matchAll(/^export const LOOPBACK_PUBLISH = "127\.0\.0\.1:(\d+):5432";$/gmu)];
  assert.equal(publish.length, 1, "the container publishes exactly one loopback TCP port");
  for (const id of ["postgres-17-core-a", "postgres-17-core-b", "postgres-17-edge-e2e"]) {
    assert.deepEqual(workflow.jobs[id].env, { PG_TEST_TCP_HOST: "127.0.0.1", PG_TEST_TCP_PORT: publish[0][1] });
  }
  for (const id of [...WORKER_STAGE_IDS, "worker-gate", "cloud-run-check", "postgres-17-suite", "activation-producer-postgres-17"]) {
    assert.equal(Object.keys(workflow.jobs[id].env ?? {}).some((name) => name.startsWith("PG_TEST_")), false,
      `${id} never dials the TCP pair`);
  }
  assert.match(container, /^export function ciPostgresTcpProfile\(/mu);
});

test("the Cloud Run check sets no PostgreSQL TCP or retired daily-activation variables", async () => {
  // The A2 daily-activation check, the only Cloud Run test that dialled the
  // container over loopback TCP, is retired with the legacy GCP daily
  // publisher (E-RETIRE); the job keeps only the socket profile its steps export.
  const { workflow } = await loadWorkflow();
  assert.equal(workflow.jobs["cloud-run-check"].env, undefined);
  const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, "apps/worker/cloud-run/package.json"), "utf8"));
  assert.doesNotMatch(packageJson.scripts.check, /postgres-community-daily-/u,
    "the Cloud Run check runs no retired daily publication job or check");
});

test("the PostgreSQL image is PostgreSQL 17 pinned by digest", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, CONTAINER_SCRIPT), "utf8");
  const declarations = [...source.matchAll(/^export const POSTGRES_IMAGE =\s*"([^"]+)";$/gmu)];
  assert.equal(declarations.length, 1);
  const image = /^postgres:(\d+)\.(\d+)-bookworm@sha256:([0-9a-f]{64})$/u.exec(declarations[0][1]);
  assert.ok(image, "the image carries an exact digest");
  assert.equal(image[1], "17");
  assert.match(source, /PGDG postgresql-17 apt package/u, "the fallback is documented");
  assert.doesNotMatch(source, /:\/var\/run\/postgresql`/u);
});

// ---------------------------------------------------------------------------
// Path-filter closure
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);
const EXTRA_REFERENCES = [
  /\brequire\s*\(\s*(["'])(\.{1,2}\/[^"'\n]*)\1\s*\)/gu,
  /\bnew\s+URL\s*\(\s*(["'])(\.{1,2}\/[^"'\n]*)\1\s*,\s*import\.meta\.url\s*\)/gu,
];

function toPosix(path) {
  return path.split(sep).join("/");
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function codeFiles(directory, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".wrangler")) continue;
      await codeFiles(path, found);
    } else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
      found.push(path);
    }
  }
  return found;
}

async function resolveRelative(importer, specifier) {
  const base = resolve(dirname(importer), specifier.split(/[?#]/u)[0]);
  const candidates = extname(base) !== ""
    ? [base]
    : [base, ...[...CODE_EXTENSIONS].map((extension) => `${base}${extension}`),
      ...[...CODE_EXTENSIONS].map((extension) => join(base, `index${extension}`))];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

async function relativeReferences(path) {
  const source = await readFile(path, "utf8");
  const specifiers = new Set();
  const [imports] = parse(source, path);
  for (const entry of imports) {
    if (typeof entry.n === "string" && /^\.{1,2}\//u.test(entry.n)) specifiers.add(entry.n);
  }
  for (const pattern of EXTRA_REFERENCES) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[2]);
  }
  return [...specifiers];
}

/**
 * Follow every relative import (and require / new URL(..., import.meta.url))
 * from the seeds, through root source it reaches, and return the repository
 * files outside apps/worker that the gates read.
 */
async function importClosure({ repositoryRoot, seeds, boundary }) {
  await init;
  const pending = [...seeds];
  const visited = new Set();
  const outside = new Map();
  for (const seed of seeds) {
    if (!seed.startsWith(`${boundary}${sep}`)) {
      outside.set(toPosix(relative(repositoryRoot, seed)), "the workflow");
    }
  }
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const specifier of await relativeReferences(current)) {
      const target = await resolveRelative(current, specifier);
      if (target === null) continue;
      const repositoryPath = toPosix(relative(repositoryRoot, target));
      if (repositoryPath.startsWith("../")) continue;
      if (target.startsWith(`${boundary}${sep}`)) continue;
      if (!outside.has(repositoryPath)) outside.set(repositoryPath, toPosix(relative(repositoryRoot, current)));
      if (CODE_EXTENSIONS.has(extname(target))) pending.push(target);
    }
  }
  return outside;
}

function coveredBy(path, filters) {
  return filters.some((filter) => (filter.endsWith("/**")
    ? path.startsWith(filter.slice(0, -2))
    : path === filter));
}

async function uncoveredInputs({ repositoryRoot, workflowText, filters }) {
  const boundary = join(repositoryRoot, "apps", "worker");
  const seeds = await codeFiles(boundary);
  for (const match of workflowText.matchAll(/(?:^|\s)node\s+((?:scripts|apps)\/[^\s"']+\.(?:m?js|cjs))/gmu)) {
    seeds.push(join(repositoryRoot, match[1]));
  }
  const outside = await importClosure({ repositoryRoot, seeds, boundary });
  return {
    outside,
    uncovered: [...outside].filter(([path]) => !coveredBy(path, filters))
      .map(([path, importer]) => `${path} (imported by ${importer})`),
  };
}

test("every root input the gates import is covered by the path filters", async () => {
  const { text, workflow } = await loadWorkflow();
  for (const filter of EXPECTED_PATHS) {
    assert.match(filter, /^(?:[A-Za-z0-9_.-]+\/)*(?:\*\*|[A-Za-z0-9_.-]+)$/u, `${filter} is a directory or exact file`);
  }
  const { outside, uncovered } = await uncoveredInputs({
    repositoryRoot: REPOSITORY_ROOT,
    workflowText: text,
    filters: workflow.on.pull_request.paths,
  });
  assert.deepEqual(uncovered, []);
  const roots = new Set([...outside.keys()].map((path) => path.split("/")[0]));
  for (const root of ["src", "scripts", "config", "packages", "test", "apps"]) {
    assert.ok(roots.has(root), `the closure reaches ${root}/`);
  }
  assert.ok([...outside.keys()].some((path) => path.startsWith("apps/web/public/")));
});

test("the closure scan reports an import that no path filter covers", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-hosted-backend-closure-"));
  try {
    await mkdir(join(root, "apps/worker/scripts"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "tools"), { recursive: true });
    await writeFile(join(root, "apps/worker/scripts/gate.mjs"),
      "import { helper } from \"../../../src/helper.js\";\nexport const value = helper;\n");
    await writeFile(join(root, "src/helper.js"),
      "export { tool as helper } from \"../tools/tool.mjs\";\n");
    await writeFile(join(root, "tools/tool.mjs"), "export const tool = 1;\n");
    const { uncovered } = await uncoveredInputs({
      repositoryRoot: root,
      workflowText: "",
      filters: ["apps/worker/**", "src/**"],
    });
    assert.deepEqual(uncovered, ["tools/tool.mjs (imported by src/helper.js)"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Hosted CI wiring: dependencies, offline production tooling, edge runtime
//
// Each contract is a function from the parsed workflow (and the sources it is
// pinned to) to a list of failures, so the checked-in workflow is held to it and
// the negative tests below hold a mutated copy to it too.
// ---------------------------------------------------------------------------

const stepAt = (job, predicate) => job.steps.findIndex((step) => predicate(step));
const isSetupNode = (version) => (step) => step.uses === SETUP_NODE && step.with?.["node-version"] === version;
const runMatches = (pattern) => (step) => typeof step.run === "string" && pattern.test(step.run);

/** Every execution job installs lockfiles under the repository toolchain; the Worker aggregate is tool-free. */
function toolchainFailures(workflow) {
  const failures = [];
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const plan = NODE_PLAN[id];
    if (plan === undefined) {
      failures.push(`${id} is not a reviewed job`);
      continue;
    }
    const setups = job.steps.filter(({ uses }) => uses === SETUP_NODE);
    const versions = setups.map((step) => step.with?.["node-version"]);
    if (id === "worker-gate") {
      if (setups.length !== 0 || job.steps.some((step) => step.uses === CHECKOUT)
          || job.steps.some((step) => step.run?.includes("pnpm install"))) {
        failures.push("worker-gate must be a tool-free aggregate without checkout or dependency installation");
      }
      continue;
    }
    if (JSON.stringify(versions) !== JSON.stringify(plan)) {
      failures.push(`${id} installs Node.js ${JSON.stringify(versions)}, not ${JSON.stringify(plan)}`);
    }
    const install = stepAt(job, runMatches(/pnpm install/u));
    const lastSetup = job.steps.findLastIndex(({ uses }) => uses === SETUP_NODE);
    if (install < 0 || install < lastSetup) failures.push(`${id} installs dependencies before its last Node.js setup`);
    const command = job.steps[install]?.run ?? "";
    if (!command.includes(`test "$(node --version)" = "v${TOOLCHAIN_NODE}"`)) {
      failures.push(`${id} does not check that Node.js ${TOOLCHAIN_NODE} is the active runtime before installing`);
    }
    const lines = command.split("\n");
    for (const required of INSTALL_COMMANDS) {
      if (!lines.includes(required)) failures.push(`${id} does not run \`${required}\``);
    }
  }
  return failures;
}

/** The files a `node --test` segment of an npm script names, as given. */
function nodeTestFiles(segment) {
  const parts = segment.trim().split(/\s+/u);
  if (parts[0] !== "node" || parts[1] !== "--test") return [];
  return parts.slice(2).filter((part) => !part.startsWith("--"));
}

/**
 * The Cloud Run job runs each offline component of gcp:production-tooling:local-check
 * and nothing PostgreSQL-backed from it; the split component is covered where the
 * Cloud Run check and the suite registration say it is.
 */
function productionToolingFailures(workflow, { localCheck, migrationsCheck, cloudRunCheck, suite, offlineSources }) {
  const failures = [];
  const components = localCheck.split(" && ").map((part) => /^npm run (\S+)$/u.exec(part.trim())?.[1] ?? null);
  const reviewed = [SPLIT_PRODUCTION_TOOLING, ...OFFLINE_PRODUCTION_TOOLING];
  if (JSON.stringify([...components].sort()) !== JSON.stringify([...reviewed].sort())) {
    failures.push(`${LOCAL_CHECK} runs ${JSON.stringify(components)}, not the reviewed ${JSON.stringify(reviewed)}; `
      + "account for each difference in the Cloud Run job");
  }
  const commands = runs(workflow.jobs["cloud-run-check"]);
  for (const script of OFFLINE_PRODUCTION_TOOLING) {
    if (commands.filter((command) => command === workerNpm(script)).length !== 1) {
      failures.push(`cloud-run-check does not run ${script} exactly once`);
    }
  }
  for (const forbidden of [LOCAL_CHECK, SPLIT_PRODUCTION_TOOLING]) {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (runs(job).includes(workerNpm(forbidden))) {
        failures.push(`${id} runs ${forbidden}, whose PostgreSQL-backed spec belongs to the PostgreSQL 17 suite`);
      }
    }
  }
  const [offlineHalf, ...rest] = migrationsCheck.split(" && ");
  const offlineFiles = nodeTestFiles(offlineHalf);
  if (offlineFiles.length === 0 || offlineFiles.some((file) => file.includes("postgres-test/"))) {
    failures.push(`${SPLIT_PRODUCTION_TOOLING} no longer starts with an offline node --test half`);
  }
  for (const file of offlineFiles) {
    if (!cloudRunCheck.includes(file.split("/").at(-1))) {
      failures.push(`the Cloud Run check does not run ${file}, the offline half of ${SPLIT_PRODUCTION_TOOLING}`);
    }
  }
  const pgFiles = rest.flatMap(nodeTestFiles);
  if (!(pgFiles.length > 0 && pgFiles.every((file) => file.startsWith("./postgres-test/")))) {
    failures.push(`${SPLIT_PRODUCTION_TOOLING} no longer ends with PostgreSQL-backed specs only`);
  }
  if (!/EXTRA_REGISTRATION_SCRIPTS = Object\.freeze\(\[[^\]]*"postgres:production-migrations:check"/u.test(suite)) {
    failures.push(`the PostgreSQL 17 suite does not register ${SPLIT_PRODUCTION_TOOLING}'s spec`);
  }
  for (const [file, text] of offlineSources) {
    if (/PG_TEST_/u.test(text)) failures.push(`${file} reads PG_TEST_*, so it is not an offline check`);
  }
  return failures;
}

/** Cloud Run's host and offline production-tooling checks are required gates. */
function cloudRunGateFailures(workflow) {
  const failures = [];
  const job = workflow.jobs["cloud-run-check"];
  if (!job) return ["cloud-run-check is missing"];
  if (job.if !== undefined) failures.push("cloud-run-check is conditional");
  if (job["continue-on-error"] !== undefined) failures.push("cloud-run-check permits job failure");
  const requiredCommands = ["npm --prefix apps/worker/cloud-run run check", ...OFFLINE_PRODUCTION_TOOLING.map(workerNpm)];
  for (const command of requiredCommands) {
    const steps = job.steps.filter((step) => step.run?.trim() === command);
    if (steps.length !== 1) {
      failures.push(`cloud-run-check does not run ${command} exactly once`);
      continue;
    }
    if (steps[0].if !== undefined) failures.push(`cloud-run-check makes ${command} conditional`);
    if (steps[0]["continue-on-error"] !== undefined) failures.push(`cloud-run-check permits ${command} to fail`);
  }
  return failures;
}

/** The suite runs the edge spec under Node.js 22.16.0 with the golden, from the repository toolchain. */
function edgeRuntimeFailures(workflow, { suite, spec, transferSpec, goldenFiles }) {
  const failures = [];
  const declared = (name, value) => new RegExp(`^export const ${name} = "${value}";$`, "mu").test(suite);
  if (!declared("EDGE_E2E_NODE_VERSION", `v${IMAGE_NODE}`)) failures.push(`the suite no longer requires Node.js v${IMAGE_NODE}`);
  if (!declared("EDGE_E2E_NODE_VARIABLE", "EDGE_E2E_NODE")) failures.push("the suite no longer reads EDGE_E2E_NODE");
  if (!declared("EDGE_E2E_GOLDEN_VARIABLE", "EDGE_E2E_GOLDEN")) failures.push("the suite no longer reads EDGE_E2E_GOLDEN");
  if (!/process\.env\.EDGE_E2E_REHEARSAL_NODE\b/u.test(spec)) failures.push("the edge spec no longer reads EDGE_E2E_REHEARSAL_NODE");
  if (!/process\.env\.EDGE_E2E_GOLDEN\b/u.test(spec)) failures.push("the edge spec no longer reads EDGE_E2E_GOLDEN");
  if (!/process\.env\.EDGE_E2E_S9_COMPARISON_MODE\b/u.test(spec)) {
    failures.push("the edge spec no longer reads the explicit D7 S9 comparison mode");
  }
  if (!/process\.env\.POSTGRES_V12_TRANSFER_Q1_DUMP\b/u.test(transferSpec)) {
    failures.push("the transfer spec no longer reads POSTGRES_V12_TRANSFER_Q1_DUMP");
  }
  for (const file of goldenFiles) {
    if (file.exists !== true) failures.push(`the golden lacks ${file.path}, which the edge spec's S9 stage reads`);
  }
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (id === "postgres-17-core-a" || id === "postgres-17-core-b") continue;
    if (id !== "postgres-17-edge-e2e") {
      if (job.steps.some((step) => /\bEDGE_E2E_(?:NODE|GOLDEN|REHEARSAL_NODE|S9_COMPARISON_MODE)\b|POSTGRES_V12_TRANSFER_Q1_DUMP|22\.16/u.test(`${step.run ?? ""}${step.with?.["node-version"] ?? ""}`))) {
        failures.push(`${id} names the edge runtime; only postgres-17-edge-e2e runs the edge spec`);
      }
      continue;
    }
    const image = stepAt(job, isSetupNode(IMAGE_NODE));
    const name = stepAt(job, runMatches(/EDGE_E2E_NODE=/u));
    const toolchain = stepAt(job, isSetupNode(TOOLCHAIN_NODE));
    const rehearsal = stepAt(job, runMatches(/EDGE_E2E_REHEARSAL_NODE=/u));
    const gate = stepAt(job, (step) => step.run?.trim() === partitionCommand("EDGE_E2E", "edge-e2e"));
    if (!(image >= 0 && image < name && name < toolchain && toolchain < rehearsal && rehearsal < gate)) {
      failures.push("the image runtime, its naming step, the toolchain, the rehearsal runtime and the suite are out of order");
    }
    const naming = job.steps[name]?.run ?? "";
    if (!naming.includes(`test "$(node --version)" = "v${IMAGE_NODE}"`)) {
      failures.push(`the image runtime is not checked to be v${IMAGE_NODE} before it is named`);
    }
    if (!/printf 'EDGE_E2E_NODE=%s\\n' "\$\(command -v node\)"/u.test(naming)) {
      failures.push("EDGE_E2E_NODE is not the absolute path `command -v node` reports");
    }
    if (!naming.includes("golden=\"$GITHUB_WORKSPACE/apps/worker/analytics-v2-test/golden\"")
        || !/printf 'EDGE_E2E_GOLDEN=%s\\n' "\$golden"/u.test(naming)) {
      failures.push("EDGE_E2E_GOLDEN is not the checked-out analytics-v2-test/golden directory");
    }
    if (!naming.includes("test -f \"$golden/dump/usage-monitor-db.json\"")
        || !/printf 'POSTGRES_V12_TRANSFER_Q1_DUMP=%s\\n' "\$golden\/dump\/usage-monitor-db\.json"/u.test(naming)) {
      failures.push("POSTGRES_V12_TRANSFER_Q1_DUMP is not the committed golden's dump/usage-monitor-db.json");
    }
    if (!naming.includes("printf 'EDGE_E2E_S9_COMPARISON_MODE=%s\\n' 'current-worker-d1-d7'")) {
      failures.push("the edge S9 mode is not explicitly current-worker-d1-d7");
    }
    if (Object.hasOwn(job.env ?? {}, "EDGE_E2E_S9_COMPARISON_MODE")) {
      failures.push("the edge S9 mode is a job literal; it must be set by the checked static step");
    }
    if (!/>> "\$GITHUB_ENV"/u.test(naming) || /\$\{\{/u.test(naming)) {
      failures.push("the edge runtime is not exported through GITHUB_ENV from static shell");
    }
    const rehearsalRun = job.steps[rehearsal]?.run ?? "";
    if (!rehearsalRun.includes(`test "$(node --version)" = "v${TOOLCHAIN_NODE}"`)
        || !/printf 'EDGE_E2E_REHEARSAL_NODE=%s\\n' "\$\(command -v node\)" >> "\$GITHUB_ENV"/u.test(rehearsalRun)) {
      failures.push(`EDGE_E2E_REHEARSAL_NODE is not the v${TOOLCHAIN_NODE} binary`);
    }
    for (const name of ["EDGE_E2E_NODE", "EDGE_E2E_GOLDEN", "EDGE_E2E_REHEARSAL_NODE", "POSTGRES_V12_TRANSFER_Q1_DUMP"]) {
      if (Object.hasOwn(job.env ?? {}, name)) failures.push(`${name} is a job literal; it must be an absolute path set by a step`);
    }
  }
  return failures;
}

async function loadContractInputs() {
  const readRepository = (path) => readFile(join(REPOSITORY_ROOT, path), "utf8");
  const worker = JSON.parse(await readRepository("apps/worker/package.json"));
  const cloudRun = JSON.parse(await readRepository("apps/worker/cloud-run/package.json"));
  const offlineSources = new Map();
  for (const script of OFFLINE_PRODUCTION_TOOLING) {
    for (const segment of worker.scripts[script].split(" && ")) {
      for (const file of nodeTestFiles(segment)) {
        const path = `apps/worker/${file.replace(/^\.\//u, "")}`;
        offlineSources.set(path, await readRepository(path));
      }
    }
  }
  const golden = "apps/worker/analytics-v2-test";
  const goldenFiles = [];
  for (const path of ["golden/community-daily-response.json", "golden/preview.json", "golden/manifest.json",
    "golden/dump/usage-monitor-db.json", "golden-q1-node/per-date-expected.json"]) {
    goldenFiles.push({ path: `${golden}/${path}`, exists: await isFile(join(REPOSITORY_ROOT, golden, path)) });
  }
  return {
    worker,
    cloudRun,
    localCheck: worker.scripts[LOCAL_CHECK],
    migrationsCheck: worker.scripts[SPLIT_PRODUCTION_TOOLING],
    cloudRunCheck: cloudRun.scripts.check,
    suite: await readRepository(SUITE_SCRIPT),
    spec: await readRepository(EDGE_SPEC),
    transferSpec: await readRepository(TRANSFER_SPEC),
    offlineSources,
    goldenFiles,
  };
}

test("every job installs the root, Worker and Cloud Run lockfiles under the repository toolchain", async () => {
  const { workflow } = await loadWorkflow();
  assert.deepEqual(toolchainFailures(workflow), []);
});

test("the Worker analytics stage needs the Cloud Run dependencies: its scripts check reaches a module importing the Cloud SQL connector", async () => {
  // gcp:fastpath:scripts-check ran under the Worker gate without the Cloud Run
  // lockfile and exited 1 with ERR_MODULE_NOT_FOUND from cloud-run/analytics-refresh.mjs.
  await init;
  const { worker, cloudRun } = await loadContractInputs();
  const connector = "@google-cloud/cloud-sql-connector";
  assert.ok(Object.hasOwn(cloudRun.dependencies, connector));
  assert.equal(Object.hasOwn(worker.dependencies ?? {}, connector), false, "the Worker lockfile does not provide it");
  assert.match(worker.scripts["check:analytics-fastpath"], /(?:^| && )npm run gcp:fastpath:scripts-check(?: && |$)/u);
  const workerRoot = join(REPOSITORY_ROOT, "apps", "worker");
  const seeds = worker.scripts["gcp:fastpath:scripts-check"].split(" && ").flatMap(nodeTestFiles)
    .map((file) => resolve(workerRoot, file));
  assert.ok(seeds.length > 0);
  const seen = new Set();
  const pending = [...seeds];
  const importers = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const source = await readFile(current, "utf8");
    const [imports] = parse(source, current);
    if (imports.some((entry) => entry.n === connector)) importers.push(toPosix(relative(REPOSITORY_ROOT, current)));
    for (const specifier of await relativeReferences(current)) {
      const target = await resolveRelative(current, specifier);
      if (target !== null && CODE_EXTENSIONS.has(extname(target)) && !target.includes(`${sep}node_modules${sep}`)) {
        pending.push(target);
      }
    }
  }
  assert.ok(importers.some((path) => path.startsWith("apps/worker/cloud-run/")),
    `the closure of gcp:fastpath:scripts-check reaches a Cloud Run module that imports ${connector}`);
  const { workflow } = await loadWorkflow();
  const gate = workflow.jobs["worker-analytics-fastpath"];
  assert.ok(runs(gate).some((command) => /^npm --prefix apps\/worker\/cloud-run ci$/mu.test(command)));
});

test("the Cloud Run job runs the offline parts of gcp:production-tooling:local-check and nothing PostgreSQL-backed from it", async () => {
  const { workflow } = await loadWorkflow();
  const inputs = await loadContractInputs();
  assert.deepEqual(productionToolingFailures(workflow, inputs), []);
  // The steps are real npm scripts of the Worker package.
  for (const script of OFFLINE_PRODUCTION_TOOLING) assert.equal(typeof inputs.worker.scripts[script], "string", script);
  assert.ok(inputs.offlineSources.size >= 10, "the offline checks name their test files");
  const job = workflow.jobs["cloud-run-check"];
  const names = job.steps.map((step) => step.name);
  assert.ok(names.indexOf("Run the Cloud Run check") < names.indexOf("Check the production rollout tooling offline"));
  assert.equal(job.steps.at(-1).run.trim(), STOP_POSTGRES);
});

test("Cloud Run and offline production-tooling checks remain unconditional required gates", async () => {
  const { workflow } = await loadWorkflow();
  assert.deepEqual(cloudRunGateFailures(workflow), []);
  const requiredCommands = ["npm --prefix apps/worker/cloud-run run check", ...OFFLINE_PRODUCTION_TOOLING.map(workerNpm)];
  for (const field of ["if", "continue-on-error"]) {
    const changed = structuredClone(workflow);
    changed.jobs["cloud-run-check"][field] = field === "if" ? "always()" : true;
    assert.ok(cloudRunGateFailures(changed).length > 0, `Cloud Run job ${field} is refused`);
  }
  for (const command of requiredCommands) {
    for (const field of ["if", "continue-on-error"]) {
      const changed = structuredClone(workflow);
      const step = changed.jobs["cloud-run-check"].steps.find((candidate) => candidate.run?.trim() === command);
      assert.ok(step, `fixture includes ${command}`);
      step[field] = field === "if" ? "always()" : true;
      assert.ok(cloudRunGateFailures(changed).length > 0, `${command} ${field} is refused`);
    }
  }
});

test("the PostgreSQL 17 suite runs the edge end-to-end spec under Node.js 22.16.0 and the Q-1 dump case, both from the committed golden", async () => {
  const { workflow } = await loadWorkflow();
  assert.deepEqual(edgeRuntimeFailures(workflow, await loadContractInputs()), []);
  const job = workflow.jobs["postgres-17-edge-e2e"];
  assert.deepEqual(job.steps.filter(({ uses }) => uses === SETUP_NODE).map((step) => step.with["node-version"]),
    [IMAGE_NODE, TOOLCHAIN_NODE]);
  // Still the suite's single gate, still no skips: the suite is not given an
  // opt-out for the edge spec.
  assert.equal(runs(job).filter((command) => command === partitionCommand("EDGE_E2E", "edge-e2e")).length, 1);
  assert.equal(job.env.EDGE_E2E_NODE, undefined);
});

test("hosted CI contract: a job that drops the Cloud Run lockfile or the toolchain check is reported", async () => {
  const { workflow } = await loadWorkflow();
  const withoutCloudRun = structuredClone(workflow);
  const gate = withoutCloudRun.jobs["worker-foundation"];
  const install = gate.steps[stepAt(gate, runMatches(/pnpm install/u))];
  install.run = install.run.replace("npm --prefix apps/worker/cloud-run ci\n", "");
  assert.deepEqual(toolchainFailures(withoutCloudRun), ["worker-foundation does not run `npm --prefix apps/worker/cloud-run ci`"]);

  const unchecked = structuredClone(workflow);
  const job = unchecked.jobs["cloud-run-check"];
  const step = job.steps[stepAt(job, runMatches(/pnpm install/u))];
  step.run = step.run.replace(`test "$(node --version)" = "v${TOOLCHAIN_NODE}"\n`, "");
  assert.deepEqual(toolchainFailures(unchecked),
    [`cloud-run-check does not check that Node.js ${TOOLCHAIN_NODE} is the active runtime before installing`]);

  const second = structuredClone(workflow);
  second.jobs["worker-foundation"].steps.splice(1, 0, structuredClone(
    second.jobs["postgres-17-edge-e2e"].steps[stepAt(second.jobs["postgres-17-edge-e2e"], isSetupNode(IMAGE_NODE))]));
  assert.match(toolchainFailures(second).join("\n"), /worker-foundation installs Node\.js \["22\.16\.0","26\.2\.0"\]/u);

  const imageLast = structuredClone(workflow);
  const suite = imageLast.jobs["postgres-17-edge-e2e"];
  const [imageSetup] = suite.steps.splice(stepAt(suite, isSetupNode(IMAGE_NODE)), 1);
  suite.steps.splice(stepAt(suite, runMatches(/pnpm install/u)), 0, imageSetup);
  assert.ok(toolchainFailures(imageLast).length > 0, "the image runtime may not follow the toolchain");

  const unknownJob = structuredClone(workflow);
  unknownJob.jobs.extra = structuredClone(unknownJob.jobs["worker-gate"]);
  assert.deepEqual(toolchainFailures(unknownJob), ["extra is not a reviewed job"]);
});

test("hosted CI contract: a missing, extra or unclassified production-tooling check is reported", async () => {
  const { workflow } = await loadWorkflow();
  const inputs = await loadContractInputs();

  for (const script of OFFLINE_PRODUCTION_TOOLING) {
    const missing = structuredClone(workflow);
    const job = missing.jobs["cloud-run-check"];
    job.steps.splice(stepAt(job, (step) => step.run === workerNpm(script)), 1);
    assert.deepEqual(productionToolingFailures(missing, inputs), [`cloud-run-check does not run ${script} exactly once`]);
  }

  const duplicated = structuredClone(workflow);
  const cloudRun = duplicated.jobs["cloud-run-check"];
  cloudRun.steps.splice(1, 0, { name: "again", run: workerNpm(OFFLINE_PRODUCTION_TOOLING[0]) });
  assert.deepEqual(productionToolingFailures(duplicated, inputs),
    [`cloud-run-check does not run ${OFFLINE_PRODUCTION_TOOLING[0]} exactly once`]);

  // The whole command would run its PostgreSQL-backed spec in the offline job.
  for (const script of [LOCAL_CHECK, SPLIT_PRODUCTION_TOOLING]) {
    const whole = structuredClone(workflow);
    whole.jobs["cloud-run-check"].steps.splice(1, 0, { name: "whole", run: workerNpm(script) });
    assert.match(productionToolingFailures(whole, inputs).join("\n"), new RegExp(`cloud-run-check runs ${script}`, "u"));
  }

  // A component added to the local check without a decision here.
  const grown = { ...inputs, localCheck: `${inputs.localCheck} && npm run gcp:new-tooling:check` };
  assert.match(productionToolingFailures(workflow, grown).join("\n"), /gcp:new-tooling:check/u);
  const shrunk = { ...inputs, localCheck: inputs.localCheck.replace(" && npm run gcp:ops:infra:check", "") };
  assert.match(productionToolingFailures(workflow, shrunk).join("\n"), /not the reviewed/u);
  const raw = { ...inputs, localCheck: `${inputs.localCheck} && node ./scripts/other.mjs` };
  assert.match(productionToolingFailures(workflow, raw).join("\n"), /null/u);

  // The split component: its offline half must stay in the Cloud Run check and
  // its PostgreSQL-backed spec must stay registered with the suite.
  const dropped = { ...inputs, cloudRunCheck: inputs.cloudRunCheck.replaceAll("postgres-production-migrations.check.mjs", "") };
  assert.match(productionToolingFailures(workflow, dropped).join("\n"), /the Cloud Run check does not run .*postgres-production-migrations\.check\.mjs/u);
  const unregistered = { ...inputs, suite: inputs.suite.replace('"postgres:production-migrations:check"', '"other"') };
  assert.match(productionToolingFailures(workflow, unregistered).join("\n"), /does not register/u);
  const reshaped = { ...inputs, migrationsCheck: "node --test ./postgres-test/postgres-production-migrations.spec.mjs" };
  assert.match(productionToolingFailures(workflow, reshaped).join("\n"), /no longer starts with an offline/u);
  const offlineTail = { ...inputs, migrationsCheck: `${inputs.migrationsCheck} ./scripts/other.check.mjs` };
  assert.match(productionToolingFailures(workflow, offlineTail).join("\n"), /no longer ends with PostgreSQL-backed specs only/u);

  // An offline check that starts reading the PostgreSQL profile is not offline.
  const [firstFile] = [...inputs.offlineSources.keys()];
  const gated = { ...inputs, offlineSources: new Map(inputs.offlineSources).set(firstFile, "const host = process.env.PG_TEST_SOCKET;") };
  assert.deepEqual(productionToolingFailures(workflow, gated), [`${firstFile} reads PG_TEST_*, so it is not an offline check`]);
});

test("hosted CI contract: an edge runtime that is unnamed, misplaced, drifted or leaked into another job is reported", async () => {
  const { workflow } = await loadWorkflow();
  const inputs = await loadContractInputs();
  const mutate = (change) => {
    const copy = structuredClone(workflow);
    change(copy.jobs["postgres-17-edge-e2e"], copy);
    return edgeRuntimeFailures(copy, inputs);
  };

  assert.ok(mutate((job) => job.steps.splice(stepAt(job, isSetupNode(IMAGE_NODE)), 1)).length > 0, "no image runtime");
  assert.ok(mutate((job) => job.steps.splice(stepAt(job, runMatches(/EDGE_E2E_NODE=/u)), 1)).length > 0, "unnamed runtime");
  assert.ok(mutate((job) => job.steps.splice(stepAt(job, runMatches(/EDGE_E2E_REHEARSAL_NODE=/u)), 1)).length > 0,
    "no rehearsal runtime");
  assert.ok(mutate((job) => {
    const at = stepAt(job, runMatches(/EDGE_E2E_NODE=/u));
    job.steps[at].run = job.steps[at].run.replace("EDGE_E2E_GOLDEN", "EDGE_E2E_OTHER");
  }).some((failure) => failure.startsWith("EDGE_E2E_GOLDEN")), "golden not exported");
  assert.ok(mutate((job) => {
    const at = stepAt(job, runMatches(/EDGE_E2E_NODE=/u));
    job.steps[at].run = job.steps[at].run.replace("analytics-v2-test/golden", "analytics-v2-test/golden-dense");
  }).some((failure) => failure.startsWith("EDGE_E2E_GOLDEN")), "wrong golden");
  assert.ok(mutate((job) => {
    const at = stepAt(job, runMatches(/EDGE_E2E_NODE=/u));
    job.steps[at].run = job.steps[at].run.replace("command -v node", "echo node");
  }).some((failure) => failure.startsWith("EDGE_E2E_NODE is not")), "not an absolute path");
  assert.ok(mutate((job) => {
    const at = stepAt(job, runMatches(/EDGE_E2E_NODE=/u));
    job.steps[at].run = job.steps[at].run.replace(`v${IMAGE_NODE}`, "v22");
  }).some((failure) => failure.includes(`before it is named`)), "unchecked version");
  assert.ok(mutate((job) => {
    const at = stepAt(job, runMatches(/EDGE_E2E_NODE=/u));
    job.steps[at].run = job.steps[at].run.replace("$(command -v node)", "${{ github.event.head_commit.message }}");
  }).some((failure) => failure.includes("static shell")), "event value");
  assert.ok(mutate((job) => {
    job.env.EDGE_E2E_GOLDEN = "analytics-v2-test/golden";
  }).some((failure) => failure.includes("job literal")), "relative job literal");

  assert.ok(mutate((job) => {
    const at = stepAt(job, runMatches(/EDGE_E2E_NODE=/u));
    job.steps[at].run = job.steps[at].run.replace(/printf 'EDGE_E2E_S9_COMPARISON_MODE[^\n]*\n/u, "");
  }).some((failure) => failure.includes("not explicitly current-worker-d1-d7")), "missing versioned S9 mode");
  assert.ok(mutate((job) => {
    const at = stepAt(job, runMatches(/EDGE_E2E_NODE=/u));
    job.steps[at].run = job.steps[at].run.replace("current-worker-d1-d7", "current-worker-d1");
  }).some((failure) => failure.includes("not explicitly current-worker-d1-d7")), "silent v2 fallback");
  assert.ok(mutate((job) => {
    job.env.EDGE_E2E_S9_COMPARISON_MODE = "current-worker-d1-d7";
  }).some((failure) => failure.includes("mode is a job literal")), "unchecked mode literal");

  // Order: the toolchain must be installed last so it is first on PATH.
  assert.ok(mutate((job) => {
    const [tool] = job.steps.splice(stepAt(job, isSetupNode(TOOLCHAIN_NODE)), 1);
    job.steps.splice(stepAt(job, isSetupNode(IMAGE_NODE)), 0, tool);
  }).some((failure) => failure.includes("out of order")));
  assert.ok(mutate((job) => {
    const [gate] = job.steps.splice(stepAt(job, (step) => step.run?.trim() === partitionCommand("EDGE_E2E", "edge-e2e")), 1);
    job.steps.splice(stepAt(job, isSetupNode(IMAGE_NODE)), 0, gate);
  }).some((failure) => failure.includes("out of order")), "suite before runtimes");

  // The Q-1 dump the transfer spec's case needs must be the committed golden's.
  assert.ok(mutate((job) => {
    const at = stepAt(job, runMatches(/EDGE_E2E_NODE=/u));
    job.steps[at].run = job.steps[at].run.replace(/printf 'POSTGRES_V12_TRANSFER_Q1_DUMP[^\n]*\n/u, "");
  }).some((failure) => failure.startsWith("POSTGRES_V12_TRANSFER_Q1_DUMP")), "no Q-1 dump");
  assert.ok(mutate((job) => {
    const at = stepAt(job, runMatches(/EDGE_E2E_NODE=/u));
    job.steps[at].run = job.steps[at].run.replace('"$golden/dump/usage-monitor-db.json"', '"$golden/dump/storage-analytics-db.json"');
  }).some((failure) => failure.startsWith("POSTGRES_V12_TRANSFER_Q1_DUMP")), "wrong Q-1 dump");

  // Worker stages, both aggregates, and Cloud Run never name the edge runtime.
  for (const id of [...WORKER_STAGE_IDS, "worker-gate", "cloud-run-check"]) {
    const leaked = structuredClone(workflow);
    leaked.jobs[id].steps.splice(1, 0, { name: "leak", run: "printf 'EDGE_E2E_NODE=x\\n' >> \"$GITHUB_ENV\"" });
    assert.deepEqual(edgeRuntimeFailures(leaked, inputs), [`${id} names the edge runtime; only postgres-17-edge-e2e runs the edge spec`]);
  }

  for (const id of [...WORKER_STAGE_IDS, "worker-gate", "cloud-run-check"]) {
    const leaked = structuredClone(workflow);
    leaked.jobs[id].steps.splice(1, 0, { name: "mode leak", run: "printf 'EDGE_E2E_S9_COMPARISON_MODE=current-worker-d1-d7\\n' >> \"$GITHUB_ENV\"" });
    assert.deepEqual(edgeRuntimeFailures(leaked, inputs), [`${id} names the edge runtime; only postgres-17-edge-e2e runs the edge spec`]);
  }
  assert.deepEqual(edgeRuntimeFailures(workflow, { ...inputs,
    spec: inputs.spec.replaceAll("EDGE_E2E_S9_COMPARISON_MODE", "MODE_REMOVED") }),
  ["the edge spec no longer reads the explicit D7 S9 comparison mode"]);

  // The names and the version are pinned to the suite and the spec.
  assert.deepEqual(edgeRuntimeFailures(workflow, { ...inputs, suite: inputs.suite.replace(`"v${IMAGE_NODE}"`, '"v22.17.0"') }),
    [`the suite no longer requires Node.js v${IMAGE_NODE}`]);
  assert.deepEqual(edgeRuntimeFailures(workflow, { ...inputs, suite: inputs.suite.replace('"EDGE_E2E_GOLDEN"', '"GOLDEN"') }),
    ["the suite no longer reads EDGE_E2E_GOLDEN"]);
  assert.deepEqual(edgeRuntimeFailures(workflow, { ...inputs, spec: inputs.spec.replaceAll("EDGE_E2E_REHEARSAL_NODE", "X") }),
    ["the edge spec no longer reads EDGE_E2E_REHEARSAL_NODE"]);
  assert.deepEqual(edgeRuntimeFailures(workflow, {
    ...inputs, transferSpec: inputs.transferSpec.replaceAll("POSTGRES_V12_TRANSFER_Q1_DUMP", "X") }),
  ["the transfer spec no longer reads POSTGRES_V12_TRANSFER_Q1_DUMP"]);
  const missingGolden = inputs.goldenFiles.map((file, index) => (index === 0 ? { ...file, exists: false } : file));
  assert.deepEqual(edgeRuntimeFailures(workflow, { ...inputs, goldenFiles: missingGolden }),
    [`the golden lacks ${inputs.goldenFiles[0].path}, which the edge spec's S9 stage reads`]);
});

// ---------------------------------------------------------------------------
// The repository policy for the second Node.js version
// ---------------------------------------------------------------------------

function setupNodeStep(version, extra = "") {
  return `jobs:\n  job:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: ${SETUP_NODE}\n        with:\n          node-version: ${version}\n${extra}`;
}

test("the workflow policy allows the reviewed Node.js versions only, and 22.16.0 only in this workflow", async () => {
  const { text } = await loadWorkflow();
  const otherPath = ".github/workflows/linux-portability.yml";
  assert.deepEqual(inspectWorkflowSource(setupNodeStep(TOOLCHAIN_NODE), { path: otherPath }), []);
  assert.deepEqual(inspectWorkflowSource(setupNodeStep(`"${TOOLCHAIN_NODE}"`), { path: otherPath }), []);
  assert.deepEqual(inspectWorkflowSource(setupNodeStep(IMAGE_NODE), { path: WORKFLOW_PATH }), []);
  assert.deepEqual(inspectWorkflowSource(setupNodeStep(IMAGE_NODE, "          check-latest: false\n"), { path: WORKFLOW_PATH }), []);

  const rejected = [
    [IMAGE_NODE, otherPath, "the image runtime outside the hosted backend workflow"],
    ["22", WORKFLOW_PATH, "a major alias"],
    ["22.x", WORKFLOW_PATH, "a minor range"],
    ["22.16", WORKFLOW_PATH, "a partial version"],
    ["^22.16.0", WORKFLOW_PATH, "a caret range"],
    ["v22.16.0", WORKFLOW_PATH, "a v-prefixed spelling the allowlist does not name"],
    ["22.16.1", WORKFLOW_PATH, "an unreviewed patch release"],
    ["26.2.1", WORKFLOW_PATH, "an unreviewed toolchain release"],
    ["lts/*", WORKFLOW_PATH, "an LTS alias"],
    ["latest", WORKFLOW_PATH, "latest"],
    ["${{ matrix.node }}", WORKFLOW_PATH, "an expression"],
    ["${{ github.event.inputs.node }}", WORKFLOW_PATH, "an event-controlled expression"],
    ["\"\"", WORKFLOW_PATH, "an empty version"],
  ];
  for (const [version, path, why] of rejected) {
    const failures = inspectWorkflowSource(setupNodeStep(version), { path });
    assert.equal(failures.length, 1, why);
    assert.match(failures[0], /actions\/setup-node node-version must be 26\.2\.0, or 22\.16\.0 in \.github\/workflows\/hosted-backend\.yml only/u, why);
  }

  const mutated = inspectWorkflowSource(text.replace(`node-version: ${IMAGE_NODE}`, "node-version: 22"), { path: WORKFLOW_PATH });
  assert.equal(mutated.length, 1, "the checked-in workflow, with its image runtime loosened to a major alias");
  const widened = inspectWorkflowSource(text, { path: ".github/workflows/electron-linux-production-package.yml" });
  assert.equal(widened.length, 3, "all three checked-in PostgreSQL image runtime steps are refused in any other workflow");
});

test("the workflow policy refuses a setup-node step without one exact version or with a floating one", () => {
  const path = WORKFLOW_PATH;
  const noWith = inspectWorkflowSource(`jobs:\n  job:\n    steps:\n      - uses: ${SETUP_NODE}\n`, { path });
  assert.equal(noWith.length, 1);
  assert.match(noWith[0], /must set node-version exactly once/u);

  const envOnly = inspectWorkflowSource(
    `jobs:\n  job:\n    steps:\n      - uses: ${SETUP_NODE}\n        env:\n          node-version: ${TOOLCHAIN_NODE}\n`, { path });
  assert.equal(envOnly.length, 1, "a node-version under env: is not an input");
  assert.match(envOnly[0], /must set node-version exactly once/u);

  const twice = inspectWorkflowSource(setupNodeStep(TOOLCHAIN_NODE, `          node-version: ${IMAGE_NODE}\n`), { path });
  assert.equal(twice.length, 1);
  assert.match(twice[0], /must set node-version exactly once/u);

  const fromFile = inspectWorkflowSource(setupNodeStep(TOOLCHAIN_NODE, "          node-version-file: .nvmrc\n"), { path });
  assert.equal(fromFile.length, 1);
  assert.match(fromFile[0], /node-version-file/u);

  for (const value of ["true", "TRUE", "\"true\"", "${{ github.event_name == 'push' }}"]) {
    const failures = inspectWorkflowSource(setupNodeStep(TOOLCHAIN_NODE, `          check-latest: ${value}\n`), { path });
    assert.equal(failures.length, 1, value);
    assert.match(failures[0], /check-latest/u, value);
  }
  for (const value of ["false", "FALSE", "'false'"]) {
    assert.deepEqual(inspectWorkflowSource(setupNodeStep(TOOLCHAIN_NODE, `          check-latest: ${value}\n`), { path }), [], value);
  }

  // Text that merely mentions the action or its inputs is not a step.
  assert.deepEqual(inspectWorkflowSource(
    `# uses: actions/setup-node@v1 with node-version: 22\njobs:\n  job:\n    steps:\n      - run: echo "node-version: 22"\n`, { path }), []);

  // The checkout rule still works beside it, and the two steps do not borrow each other's inputs.
  const both = inspectWorkflowSource(
    `jobs:\n  job:\n    steps:\n      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n`
    + `      - uses: ${SETUP_NODE}\n        with:\n          node-version: ${TOOLCHAIN_NODE}\n`, { path });
  assert.deepEqual(both, []);
  const borrowed = inspectWorkflowSource(
    `jobs:\n  job:\n    steps:\n      - uses: ${SETUP_NODE}\n        with:\n          persist-credentials: false\n`
    + `      - uses: ${CHECKOUT}\n        with:\n          node-version: ${TOOLCHAIN_NODE}\n`, { path });
  assert.equal(borrowed.length, 3);
  assert.ok(borrowed.some((failure) => failure.includes("must set node-version exactly once")));
  assert.ok(borrowed.some((failure) => failure.includes("persist-credentials explicitly to false")));
  assert.ok(borrowed.some((failure) => failure.includes("setup-node input persist-credentials is not reviewed")),
    "persist-credentials is a checkout input, not a setup-node one");
});

test("the workflow policy closes the setup-node inputs to the reviewed list and its architectures", async () => {
  const path = WORKFLOW_PATH;
  const reviewedInputs = "          check-latest: false\n          package-manager-cache: false\n          architecture: x64\n";
  assert.deepEqual(inspectWorkflowSource(setupNodeStep(TOOLCHAIN_NODE, reviewedInputs), { path }), [],
    "the inputs the checked-in workflows use");
  for (const architecture of ["x64", "arm64", "\"x64\"", "'arm64'"]) {
    assert.deepEqual(inspectWorkflowSource(setupNodeStep(TOOLCHAIN_NODE, `          architecture: ${architecture}\n`), { path }), [], architecture);
  }

  // Inputs that choose where the toolchain comes from, which credential it
  // sees or what it caches are not reviewed, in either spelling of the key and
  // wherever they sit in the mapping.
  const unreviewed = [
    ["          mirror: https://mirror.example\n", "mirror"],
    ["          mirror-token: ${{ github.token }}\n", "mirror-token"],
    ["          token: ${{ github.token }}\n", "token"],
    ["          registry-url: https://registry.example\n", "registry-url"],
    ["          always-auth: true\n", "always-auth"],
    ["          scope: '@example'\n", "scope"],
    ["          cache: npm\n", "cache"],
    ["          cache-dependency-path: package-lock.json\n", "cache-dependency-path"],
    ["          \"mirror\": https://mirror.example\n", "mirror"],
    ["          'token': ${{ github.token }}\n", "token"],
    ["          some-future-input: true\n", "some-future-input"],
  ];
  for (const [extra, key] of unreviewed) {
    for (const [where, source] of [
      ["after the version", setupNodeStep(TOOLCHAIN_NODE, extra)],
      ["before the version", `jobs:\n  job:\n    steps:\n      - uses: ${SETUP_NODE}\n        with:\n${extra}          node-version: ${TOOLCHAIN_NODE}\n`],
    ]) {
      const failures = inspectWorkflowSource(source, { path });
      assert.equal(failures.length, 1, `${key} ${where}`);
      assert.match(failures[0], new RegExp(`actions/setup-node input ${key} is not reviewed`, "u"), `${key} ${where}`);
      assert.match(failures[0], /only node-version, check-latest, package-manager-cache, architecture are allowed/u, `${key} ${where}`);
    }
  }

  // Two unreviewed inputs are two failures; the policy does not stop at the first.
  assert.equal(inspectWorkflowSource(
    setupNodeStep(TOOLCHAIN_NODE, "          mirror: https://mirror.example\n          registry-url: https://registry.example\n"), { path }).length, 2);

  // An architecture outside the reviewed pair is refused, however it is written.
  for (const architecture of ["x86", "arm", "ia32", "\"\"", "${{ matrix.arch }}", "${{ github.event.inputs.arch }}"]) {
    const failures = inspectWorkflowSource(setupNodeStep(TOOLCHAIN_NODE, `          architecture: ${architecture}\n`), { path });
    assert.equal(failures.length, 1, architecture);
    assert.match(failures[0], /actions\/setup-node architecture must be one of x64, arm64/u, architecture);
  }

  // A flow-style mapping hides its inputs from the line reader, so it fails closed on the missing version.
  const flow = inspectWorkflowSource(
    `jobs:\n  job:\n    steps:\n      - uses: ${SETUP_NODE}\n        with: { node-version: ${TOOLCHAIN_NODE}, mirror: "https://mirror.example" }\n`, { path });
  assert.equal(flow.length, 1);
  assert.match(flow[0], /must set node-version exactly once/u);

  // The checked-in workflow with an extra input on its image runtime step, and on
  // its toolchain step, is refused; the policy applies in every workflow.
  const { text } = await loadWorkflow();
  const withMirror = inspectWorkflowSource(
    text.replace(`node-version: ${IMAGE_NODE}`, `node-version: ${IMAGE_NODE}\n          mirror: https://mirror.example`), { path });
  assert.equal(withMirror.length, 1, "the checked-in workflow with a mirror added to its image runtime step");
  assert.match(withMirror[0], /input mirror is not reviewed/u);
  const otherPath = ".github/workflows/linux-portability.yml";
  assert.equal(inspectWorkflowSource(setupNodeStep(TOOLCHAIN_NODE, "          mirror: https://mirror.example\n"), { path: otherPath }).length, 1);

  // Text that mentions an unreviewed input outside a setup-node step is not a step.
  assert.deepEqual(inspectWorkflowSource(
    `jobs:\n  job:\n    steps:\n      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n          mirror: not-a-setup-node-input\n`, { path }), []);
});


const PARTITION_PLAN = Object.freeze([
  Object.freeze({ id: "postgres-17-core-a", partition: "CORE_A", stem: "core-a" }),
  Object.freeze({ id: "postgres-17-core-b", partition: "CORE_B", stem: "core-b" }),
  Object.freeze({ id: "postgres-17-edge-e2e", partition: "EDGE_E2E", stem: "edge-e2e" }),
]);
const CORE_JOB_IDS = Object.freeze(PARTITION_PLAN
  .filter(({ partition }) => partition.startsWith("CORE_"))
  .map(({ id }) => id));
function reviewedReceiptEnvironment(id) {
  if (WORKER_STAGE_IDS.includes(id)) return { CI_WORKER_EXPECTED_HEAD: SELECTED_SOURCE_EXPRESSION };
  if (id === "worker-gate") return {
    CI_WORKER_EXPECTED_HEAD: SELECTED_SOURCE_EXPRESSION,
    CI_WORKER_FOUNDATION_RESULT: "${{ needs.worker-foundation.result }}",
    CI_WORKER_RUNTIME_RESULT: "${{ needs.worker-runtime-tests.result }}",
    CI_WORKER_ANALYTICS_RESULT: "${{ needs.worker-analytics-fastpath.result }}",
    CI_WORKER_FOUNDATION_HEAD: "${{ needs.worker-foundation.outputs.source_sha }}",
    CI_WORKER_RUNTIME_HEAD: "${{ needs.worker-runtime-tests.outputs.source_sha }}",
    CI_WORKER_ANALYTICS_HEAD: "${{ needs.worker-analytics-fastpath.outputs.source_sha }}",
    CI_WORKER_FOUNDATION_RUN_ID: "${{ needs.worker-foundation.outputs.run_id }}",
    CI_WORKER_RUNTIME_RUN_ID: "${{ needs.worker-runtime-tests.outputs.run_id }}",
    CI_WORKER_ANALYTICS_RUN_ID: "${{ needs.worker-analytics-fastpath.outputs.run_id }}",
    CI_WORKER_FOUNDATION_RUN_ATTEMPT: "${{ needs.worker-foundation.outputs.run_attempt }}",
    CI_WORKER_RUNTIME_RUN_ATTEMPT: "${{ needs.worker-runtime-tests.outputs.run_attempt }}",
    CI_WORKER_ANALYTICS_RUN_ATTEMPT: "${{ needs.worker-analytics-fastpath.outputs.run_attempt }}",
  };
  const source = { CI_POSTGRES_EXPECTED_HEAD: SELECTED_SOURCE_EXPRESSION };
  if (id === "postgres-17-suite") return { ...source,
    CI_POSTGRES_CORE_A_RESULT: "${{ needs.postgres-17-core-a.result }}",
    CI_POSTGRES_CORE_B_RESULT: "${{ needs.postgres-17-core-b.result }}",
    CI_POSTGRES_EDGE_E2E_RESULT: "${{ needs.postgres-17-edge-e2e.result }}",
    CI_POSTGRES_ACTIVATION_RESULT: "${{ needs.activation-producer-postgres-17.result }}" };
  if (id === "activation-producer-postgres-17") return source;
  assert.ok(PARTITION_PLAN.some((entry) => entry.id === id), `${id} has no reviewed expression env`);
  return source;
}
function receiptArtifactName(stem) {
  return `postgres-17-${stem}-receipt-${"${{ github.run_id }}"}-${"${{ github.run_attempt }}"}`;
}
function partitionCommand(partition, stem) {
  return ["set -euo pipefail", 'test "$(git rev-parse HEAD)" = "$CI_POSTGRES_EXPECTED_HEAD"',
    `node ${SUITE_SCRIPT} --partition ${partition} --receipt "$RUNNER_TEMP/postgres-17-${stem}.json"`].join("\n");
}
function aggregateCommand() {
  return ["set -euo pipefail", 'test "$(git rev-parse HEAD)" = "$CI_POSTGRES_EXPECTED_HEAD"',
    'test "$CI_POSTGRES_CORE_A_RESULT" = "success"', 'test "$CI_POSTGRES_CORE_B_RESULT" = "success"',
    'test "$CI_POSTGRES_EDGE_E2E_RESULT" = "success"', 'test "$CI_POSTGRES_ACTIVATION_RESULT" = "success"',
    `node ${SUITE_SCRIPT} --aggregate "$RUNNER_TEMP/postgres-17-core-a/postgres-17-core-a.json" "$RUNNER_TEMP/postgres-17-core-b/postgres-17-core-b.json" "$RUNNER_TEMP/postgres-17-edge-e2e/postgres-17-edge-e2e.json"`].join("\n");
}
function activationProducerCommand() {
  return ["set -euo pipefail", 'test "$(git rev-parse HEAD)" = "$CI_POSTGRES_EXPECTED_HEAD"',
    `node ${ACTIVATION_PRODUCER_SUITE_SCRIPT}`].join("\n");
}
function partitionWorkflowFailures(workflow) {
  const failures = [];
  if (JSON.stringify(Object.keys(workflow.jobs)) !== JSON.stringify(Object.keys(NODE_PLAN))) failures.push("the ten reviewed jobs are not present exactly once");
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const checkouts = job.steps.filter(step => step.uses === CHECKOUT);
    if (id === "worker-gate") {
      if (checkouts.length !== 0) failures.push("worker-gate must remain a metadata-only aggregate without checkout");
      continue;
    }
    if (checkouts.length !== 1 || checkouts[0]?.with?.ref !== SELECTED_SOURCE_EXPRESSION) failures.push(`${id} does not select the exact provider PR head or non-PR revision`);
  }
  for (const { id, partition, stem } of PARTITION_PLAN) {
    const job = workflow.jobs[id];
    if (!job) { failures.push(`${id} is missing`); continue; }
    if (job.if !== undefined || job["continue-on-error"] !== undefined) failures.push(`${id} is conditional or permits failure`);
    if (job["timeout-minutes"] !== 45) failures.push(`${id} changes the 45 minute deadline`);
    if (JSON.stringify(job.env) !== JSON.stringify({ PG_TEST_TCP_HOST: "127.0.0.1", PG_TEST_TCP_PORT: "55432" })) failures.push(`${id} changes trusted job environment`);
    if (job.steps.some(step => step["continue-on-error"] !== undefined
      || (step.if !== undefined && step.run?.trim() !== STOP_POSTGRES && step.uses !== UPLOAD_ARTIFACT))) failures.push(`${id} makes execution prerequisites conditional or permits failure`);
    const suiteSteps = job.steps.filter(step => step.run?.includes(`node ${SUITE_SCRIPT}`));
    if (suiteSteps.length !== 1) failures.push(`${id} must invoke the canonical runner exactly once`);
    const gate = job.steps.filter(step => step.run?.trim() === partitionCommand(partition, stem));
    if (gate.length !== 1 || JSON.stringify(gate[0]?.env) !== JSON.stringify(reviewedReceiptEnvironment(id))) failures.push(`${id} does not run its one exact source-bound partition`);
    if (gate[0]?.if !== undefined || gate[0]?.["continue-on-error"] !== undefined) failures.push(`${id} gate permits conditional or failed execution`);
    const uploads = job.steps.filter(step => step.uses?.startsWith("actions/upload-artifact@"));
    const expected = { name: receiptArtifactName(stem), path: `\${{ runner.temp }}/postgres-17-${stem}.json`, "if-no-files-found": "error", "retention-days": 7 };
    if (uploads.length !== 1 || uploads[0]?.uses !== UPLOAD_ARTIFACT || uploads[0]?.if !== "always()"
      || uploads[0]?.["continue-on-error"] !== undefined || JSON.stringify(uploads[0]?.with) !== JSON.stringify(expected)) failures.push(`${id} does not always retain its one exact seven-day receipt`);
    if (job.steps.at(-1) !== uploads[0]) failures.push(`${id} receipt upload must follow database cleanup`);
    const start = stepAt(job, step => step.run?.trim() === START_POSTGRES);
    const build = stepAt(job, step => step.run?.trim() === "node apps/worker/cloud-run/build.mjs");
    const gateIndex = job.steps.indexOf(gate[0]);
    const stopIndex = stepAt(job, step => step.run?.trim() === STOP_POSTGRES);
    const uploadIndex = job.steps.indexOf(uploads[0]);
    if (!(start >= 0 && start < build && build < gateIndex && gateIndex < stopIndex && stopIndex < uploadIndex)) failures.push(`${id} must start PostgreSQL, build Cloud Run, run the partition, stop PostgreSQL, then upload its receipt`);
    if (job.steps.filter(step => step.run?.trim() === "node apps/worker/cloud-run/build.mjs").length !== 1) failures.push(`${id} must build Cloud Run exactly once`);
    const stop = job.steps.filter(step => step.run?.trim() === STOP_POSTGRES);
    if (stop.length !== 1 || stop[0]?.if !== "always()" || stop[0]?.["continue-on-error"] !== undefined) failures.push(`${id} does not always stop its own PostgreSQL`);
  }
  const aggregate = workflow.jobs["postgres-17-suite"];
  if (!aggregate) { failures.push("the required aggregate is missing"); return failures; }
  if (JSON.stringify(aggregate.needs) !== JSON.stringify([
    ...PARTITION_PLAN.map(entry => entry.id), "activation-producer-postgres-17",
  ])) failures.push("the aggregate needs every exact partition and the focused activation producer");
  if (aggregate.if !== "always()" || aggregate["continue-on-error"] !== undefined || aggregate["timeout-minutes"] !== 45) failures.push("the aggregate must always run and fail closed within 45 minutes");
  if (aggregate.env !== undefined || aggregate.steps.some(step => step.if !== undefined || step["continue-on-error"] !== undefined)) failures.push("aggregate provenance and prerequisites must not be overridden or conditional");
  if (aggregate.services !== undefined || runs(aggregate).some(command => command === START_POSTGRES || command === STOP_POSTGRES)) failures.push("the aggregate must not execute PostgreSQL tests or a database");
  const downloads = aggregate.steps.filter(step => step.uses?.startsWith("actions/download-artifact@"));
  if (downloads.length !== 3) failures.push("the aggregate must download exactly three receipts");
  for (const { stem } of PARTITION_PLAN) {
    const item = downloads.find(step => step.with?.name === receiptArtifactName(stem));
    const expected = { name: receiptArtifactName(stem), path: `\${{ runner.temp }}/postgres-17-${stem}` };
    if (!item || item.uses !== DOWNLOAD_ARTIFACT || JSON.stringify(item.with) !== JSON.stringify(expected)
      || item.if !== undefined || item["continue-on-error"] !== undefined) failures.push(`the aggregate does not download the exact same-run ${stem} receipt`);
  }
  const gates = aggregate.steps.filter(step => step.run?.trim() === aggregateCommand());
  if (gates.length !== 1 || JSON.stringify(gates[0]?.env) !== JSON.stringify(reviewedReceiptEnvironment("postgres-17-suite"))
    || gates[0]?.if !== undefined || gates[0]?.["continue-on-error"] !== undefined) failures.push("the aggregate does not require every successful child result and immutable source metadata");
  if (aggregate.steps.at(-1) !== gates[0]) failures.push("the exact aggregate gate must be last");
  return failures;
}
function coreRuntimeFailures(workflow) {
  const failures = [];
  for (const { id, partition, stem } of PARTITION_PLAN.filter(entry => entry.partition.startsWith("CORE_"))) {
    const job = workflow.jobs[id];
    if (!job) { failures.push(`${id} is missing`); continue; }
    const image = stepAt(job, isSetupNode(IMAGE_NODE));
    const name = stepAt(job, runMatches(/EDGE_E2E_NODE=/u));
    const toolchain = stepAt(job, isSetupNode(TOOLCHAIN_NODE));
    const gate = stepAt(job, step => step.run?.trim() === partitionCommand(partition, stem));
    if (!(image >= 0 && image < name && name < toolchain && toolchain < gate)) failures.push(`${id} runtime naming order changed`);
    const command = job.steps[name]?.run ?? "";
    for (const line of [`test "$(node --version)" = "v${IMAGE_NODE}"`,
      'dump="$GITHUB_WORKSPACE/apps/worker/analytics-v2-test/golden/dump/usage-monitor-db.json"',
      'test -f "$dump"', `printf 'EDGE_E2E_NODE=%s\\n' "$(command -v node)"`,
      `printf 'POSTGRES_V12_TRANSFER_Q1_DUMP=%s\\n' "$dump"`]) {
      if (!command.split("\n").map(line => line.trim()).includes(line)) failures.push(`${id} lacks ${line}`);
    }
    if (!command.includes('>> "$GITHUB_ENV"')) failures.push(`${id} runtime and Q-1 dump must be exported through GITHUB_ENV`);
    if (job.steps.some(step => /EDGE_E2E_GOLDEN|EDGE_E2E_REHEARSAL_NODE/u.test(step.run ?? ""))) failures.push(`${id} must not execute edge prerequisites`);
  }
  return failures;
}
test("all PostgreSQL producers retain full history, private independent PostgreSQL, locked dependencies, exact runtime and a required same-run aggregate", async () => {
  const { text, workflow } = await loadWorkflow();
  assert.match(text, /When retrying this gate, re-run all jobs; re-run failed jobs alone cannot/u, "same-attempt receipts require retrying all producers");
  assert.deepEqual(partitionWorkflowFailures(workflow), []);
  assert.deepEqual(coreRuntimeFailures(workflow), []);
});

test("partition contract rejects omitted or overlapping partitions, failed child masking, wrong artifact, retention, source, runtime and conditional aggregation", async () => {
  const { workflow } = await loadWorkflow();
  for (const mutate of [
    copy => { delete copy.jobs["postgres-17-core-a"]; },
    copy => { copy.jobs["postgres-17-edge-e2e"].steps.find(step => step.run?.includes(" --partition ")).run = partitionCommand("CORE_A", "core-a"); },
    copy => { copy.jobs["postgres-17-suite"].needs.pop(); },
    copy => { delete copy.jobs["postgres-17-suite"].if; },
    copy => { copy.jobs["postgres-17-suite"]["continue-on-error"] = true; },
    copy => { copy.jobs["postgres-17-suite"].steps.at(-1).run = aggregateCommand().replace('test "$CI_POSTGRES_CORE_A_RESULT" = "success"', 'true'); },
    copy => { copy.jobs["postgres-17-suite"].steps.at(-1).env.CI_POSTGRES_CORE_A_RESULT = "success"; },
    copy => { copy.jobs["postgres-17-suite"].steps.at(-1).env.CI_POSTGRES_EXPECTED_HEAD = "${{ github.event.pull_request.head.sha }}"; },
    copy => { copy.jobs["postgres-17-suite"].steps.find(step => step.uses === DOWNLOAD_ARTIFACT).with.name = "postgres-17-edge-e2e-receipt"; },
    copy => { copy.jobs["postgres-17-suite"].steps.find(step => step.uses === DOWNLOAD_ARTIFACT).with["run-id"] = "old-run"; },
    copy => { copy.jobs["postgres-17-suite"].steps.find(step => step.uses === DOWNLOAD_ARTIFACT).with.path = "shared"; },
    copy => { copy.jobs["postgres-17-core-a"].steps.at(-1).with["retention-days"] = 1; },
    copy => { copy.jobs["postgres-17-core-a"].steps.at(-1).with["if-no-files-found"] = "warn"; },
    copy => { delete copy.jobs["postgres-17-core-a"].steps.at(-1).if; },
    copy => { copy.jobs["postgres-17-core-a"].steps.at(-1).uses = "actions/upload-artifact@v7"; },
    copy => { copy.jobs["postgres-17-core-a"]["timeout-minutes"] = 90; },
    copy => { copy.jobs["postgres-17-core-a"].steps.find(step => step.uses === CHECKOUT).with.ref = "${{ github.sha }}"; },
    copy => { copy.jobs["postgres-17-suite"].steps.at(-1).run = aggregateCommand().replace("$CI_POSTGRES_EXPECTED_HEAD", "$GITHUB_SHA"); },
    copy => { copy.jobs["postgres-17-core-a"].steps.find(step => step.run?.includes(" --partition ")).env.CI_POSTGRES_EXPECTED_HEAD = "${{ github.sha }}"; },
    copy => { copy.jobs["postgres-17-core-a"].steps.find(step => step.run?.includes("pnpm install"))["continue-on-error"] = true; },
    copy => { copy.jobs["postgres-17-core-a"].env.GITHUB_RUN_ID = "old-run"; },
    copy => { copy.jobs["postgres-17-suite"].env = { GITHUB_SHA: "other" }; },
    copy => { copy.jobs["postgres-17-core-a"].steps.push({ run: partitionCommand("EDGE_E2E", "edge-e2e") }); },
    copy => { const job = copy.jobs["postgres-17-core-a"]; job.steps.splice(stepAt(job, step => step.run?.trim() === "node apps/worker/cloud-run/build.mjs"), 1); },
    copy => { const job = copy.jobs["postgres-17-core-a"], index = stepAt(job, step => step.run?.trim() === "node apps/worker/cloud-run/build.mjs"); job.steps.push(...job.steps.splice(index, 1)); },
    copy => { const job = copy.jobs["postgres-17-core-a"], index = stepAt(job, step => step.run?.trim() === STOP_POSTGRES); job.steps.splice(stepAt(job, step => step.run?.trim() === START_POSTGRES), 0, ...job.steps.splice(index, 1)); },
    copy => { copy.jobs["postgres-17-core-a"].steps.at(-1).with.name = "postgres-17-core-a-receipt"; },
    copy => { copy.jobs["postgres-17-suite"].steps.find(step => step.uses === DOWNLOAD_ARTIFACT).with.name = "postgres-17-core-a-receipt-${{ github.run_id }}-old-attempt"; },
  ]) {
    const changed = structuredClone(workflow); mutate(changed);
    assert.ok(partitionWorkflowFailures(changed).length > 0);
  }
  for (const mutate of [
    job => job.steps.splice(stepAt(job, isSetupNode(IMAGE_NODE)), 1),
    job => { job.steps[stepAt(job, runMatches(/EDGE_E2E_NODE=/u))].run = "echo no runtime"; },
    job => { job.steps[stepAt(job, runMatches(/EDGE_E2E_NODE=/u))].run = job.steps[stepAt(job, runMatches(/EDGE_E2E_NODE=/u))].run.replace("POSTGRES_V12_TRANSFER_Q1_DUMP", "OTHER"); },
    job => job.steps.push({ run: "export EDGE_E2E_GOLDEN=somewhere" }),
  ]) {
    const changed = structuredClone(workflow); mutate(changed.jobs[CORE_JOB_IDS[0]]);
    assert.ok(coreRuntimeFailures(changed).length > 0);
  }
});


test("PR source selection binds the actual PR head while preserving the distinct provider synthetic merge SHA", async () => {
  const { workflow } = await loadWorkflow();
  const providerMergeSha = "a".repeat(40), actualPrHead = "b".repeat(40);
  assert.notEqual(actualPrHead, providerMergeSha);
  const sourceFor = ({ pullRequestHead, providerSha }) => pullRequestHead || providerSha;
  assert.equal(sourceFor({ pullRequestHead: actualPrHead, providerSha: providerMergeSha }), actualPrHead);
  assert.equal(sourceFor({ providerSha: providerMergeSha }), providerMergeSha);
  assert.equal(providerMergeSha, "a".repeat(40), "provider GITHUB_SHA is not repurposed");
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const checkout = job.steps.find(step => step.uses === CHECKOUT);
    if (id === "worker-gate") assert.equal(checkout, undefined, "the metadata-only Worker aggregate has no checkout");
    else assert.equal(checkout?.with?.ref, SELECTED_SOURCE_EXPRESSION, `${id} selects the exact provider PR head or non-PR revision`);
  }
  for (const { id } of PARTITION_PLAN) {
    const gate = workflow.jobs[id].steps.find(step => step.run?.includes(" --partition "));
    assert.equal(gate.env.CI_POSTGRES_EXPECTED_HEAD, SELECTED_SOURCE_EXPRESSION);
    assert.match(gate.run, /test "\$\(git rev-parse HEAD\)" = "\$CI_POSTGRES_EXPECTED_HEAD"/u);
    assert.doesNotMatch(gate.run, /\$GITHUB_SHA\b/u);
  }
  const aggregate = workflow.jobs["postgres-17-suite"].steps.at(-1);
  assert.equal(aggregate.env.CI_POSTGRES_EXPECTED_HEAD, SELECTED_SOURCE_EXPRESSION);
  assert.doesNotMatch(aggregate.run, /\$GITHUB_SHA\b/u);
});
