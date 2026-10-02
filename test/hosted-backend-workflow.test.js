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

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = ".github/workflows/hosted-backend.yml";
const CONTAINER_SCRIPT = "apps/worker/scripts/ci-postgres-container.mjs";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
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
const EDGE_SPEC = "apps/worker/postgres-test/edge-origin-e2e.spec.mjs";
const TRANSFER_SPEC = "apps/worker/postgres-test/postgres-v12-transfer.spec.mjs";
const TOOLCHAIN_NODE = "26.2.0";
const IMAGE_NODE = "22.16.0";
// Every job runs the repository toolchain. Only the PostgreSQL 17 suite also
// installs the Cloud Run image runtime, first, so the toolchain stays first on
// PATH. The Cloud Run image runtime is allowed in this workflow only; see
// scripts/check-release-workflow-policy.mjs.
const NODE_PLAN = Object.freeze({
  "worker-gate": Object.freeze([TOOLCHAIN_NODE]),
  "cloud-run-check": Object.freeze([TOOLCHAIN_NODE]),
  "postgres-17-suite": Object.freeze([IMAGE_NODE, TOOLCHAIN_NODE]),
});
const INSTALL_COMMANDS = Object.freeze(["npm --prefix apps/worker ci", "npm --prefix apps/worker/cloud-run ci"]);
// The components of gcp:production-tooling:local-check. The first is split: its
// offline half runs inside the Cloud Run check and its PostgreSQL-backed spec in
// the PostgreSQL 17 suite. The rest run in the Cloud Run job, one step each.
const SPLIT_PRODUCTION_TOOLING = "postgres:production-migrations:check";
const OFFLINE_PRODUCTION_TOOLING = Object.freeze([
  "gcp:production-rollout:check",
  "gcp:ops:infra:check",
  "postgres:cutover-seal:check",
]);
const LOCAL_CHECK = "gcp:production-tooling:local-check";
const workerNpm = (script) => `npm --prefix apps/worker run ${script}`;

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
    assert.ok([CHECKOUT, SETUP_NODE].includes(action), `${action} is a reviewed pin`);
  }
  for (const [id, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.permissions, undefined, `${id} inherits contents: read`);
    assert.equal(job.environment, undefined, `${id} has no environment`);
    for (const step of job.steps) {
      if (step.uses === CHECKOUT) {
        assert.deepEqual(step.with, { "fetch-depth": 1, "persist-credentials": false });
      }
      if (step.uses === SETUP_NODE) {
        assert.deepEqual(step.with, {
          "node-version": step.with["node-version"],
          "check-latest": false,
          "package-manager-cache": false,
        });
      }
    }
    assert.equal(job.steps.filter(({ uses: action }) => action === CHECKOUT).length, 1);
    assert.deepEqual(
      job.steps.filter(({ uses: action }) => action === SETUP_NODE).map((step) => step.with["node-version"]),
      NODE_PLAN[id],
      `${id} installs exactly its reviewed Node.js versions, in order`,
    );
  }
});

test("no run block interpolates GitHub expressions into a shell", async () => {
  const { text, workflow } = await loadWorkflow();
  assert.doesNotMatch(text, /\$\{\{\s*github\.event/u);
  for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const command of runs(job)) {
      assert.doesNotMatch(command, /\$\{\{/u, `${id} run blocks use environment variables, not expressions`);
    }
    for (const step of job.steps) assert.equal(step.env, undefined, `${id} steps take no expression env`);
    for (const [name, value] of Object.entries(job.env ?? {})) {
      assert.equal(typeof value, "string", `${id} env ${name} is a quoted literal`);
      assert.doesNotMatch(value, /\$\{\{/u, `${id} env ${name} is static`);
    }
  }
});

test("three jobs run the Worker gate, the Cloud Run check and the routed PostgreSQL 17 suite", async () => {
  const { workflow } = await loadWorkflow();
  assert.deepEqual(Object.keys(workflow.jobs), ["worker-gate", "cloud-run-check", "postgres-17-suite"]);
  const timeouts = { "worker-gate": 60, "cloud-run-check": 30, "postgres-17-suite": 45 };
  const gates = {
    "worker-gate": "npm --prefix apps/worker run check",
    "cloud-run-check": "npm --prefix apps/worker/cloud-run run check",
    "postgres-17-suite": "node apps/worker/scripts/ci-postgres-suite.mjs",
  };
  for (const [id, job] of Object.entries(workflow.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-24.04", id);
    assert.equal(job["timeout-minutes"], timeouts[id], id);
    assert.equal(job.services, undefined, `${id} starts PostgreSQL through the reviewed script`);
    const commands = runs(job);
    const install = commands.find((command) => command.includes("pnpm install"));
    assert.match(install, /npm install --global corepack@0\.34\.0 --force --ignore-scripts/u);
    assert.match(install, /corepack prepare pnpm@11\.9\.0 --activate/u);
    assert.match(install, /pnpm install --frozen-lockfile --ignore-scripts/u);
    assert.match(install, /^npm --prefix apps\/worker ci$/mu);
    assert.match(install, /^npm --prefix apps\/worker\/cloud-run ci$/mu, `${id} installs the Cloud Run lockfile`);

    const socketRoot = commands.findIndex((command) => command.includes("sudo mkdir -p /private/tmp"));
    const start = commands.indexOf(START_POSTGRES);
    const gate = commands.indexOf(gates[id]);
    assert.ok(socketRoot >= 0 && start > socketRoot, `${id} prepares /private/tmp before PostgreSQL`);
    assert.match(commands[socketRoot], /sudo chmod 1777 \/private\/tmp/u);
    assert.ok(gate > start, `${id} runs its gate with the SOCKET profile exported`);
    assert.equal(commands.filter((command) => command === gates[id]).length, 1);

    const last = job.steps.at(-1);
    assert.deepEqual([last.if, last.run?.trim()], ["always()", STOP_POSTGRES], `${id} always stops PostgreSQL`);
    assert.equal(job.steps.filter((step) => step.if !== undefined).length, 1, `${id} has one conditional step`);
  }
  const worker = runs(workflow.jobs["worker-gate"]);
  // This contract test runs in CI too, so a change that only a local root
  // `npm test` would catch (a new uncovered import, a dropped stop step) fails
  // the Worker gate.
  const guard = worker.indexOf([
    "node --test",
    "test/hosted-backend-workflow.test.js",
    "apps/worker/scripts/migration-numbering.check.mjs",
    "apps/worker/scripts/ci-postgres-suite.check.mjs",
  ].join(" "));
  const site = worker.findIndex((command) => command.includes("node scripts/build-public-release-site.js"));
  assert.ok(guard >= 0 && site > guard && worker.indexOf(gates["worker-gate"]) > site);
  assert.match(worker[site], /--output "\$GITHUB_WORKSPACE\/\.release-build\/public-release-site"/u);
  assert.match(worker[site], /--social-image "\$social_card"/u);
  assert.deepEqual(workflow.jobs["worker-gate"].env, { WRANGLER_SEND_METRICS: "false" });
});

test("the PostgreSQL 17 suite gets the container's loopback TCP pair, and only that job does", async () => {
  // Without the pair the journal-transfer spec's TCP tests skip, which the
  // suite reports as SILENTLY_SKIPPED; with a wrong port they fail to connect.
  const { workflow } = await loadWorkflow();
  const container = await readFile(join(REPOSITORY_ROOT, CONTAINER_SCRIPT), "utf8");
  const publish = [...container.matchAll(/^export const LOOPBACK_PUBLISH = "127\.0\.0\.1:(\d+):5432";$/gmu)];
  assert.equal(publish.length, 1, "the container publishes exactly one loopback TCP port");
  assert.deepEqual(workflow.jobs["postgres-17-suite"].env, {
    PG_TEST_TCP_HOST: "127.0.0.1",
    PG_TEST_TCP_PORT: publish[0][1],
  });
  for (const id of ["worker-gate", "cloud-run-check"]) {
    assert.equal(Object.keys(workflow.jobs[id].env ?? {}).some((name) => name.startsWith("PG_TEST_")), false,
      `${id} never dials the TCP pair`);
  }
  assert.match(container, /^export function ciPostgresTcpProfile\(/mu);
});

test("the Cloud Run check gives the daily-activation integration test the container's loopback TCP port", async () => {
  // Without these two variables the real PostgreSQL 17 test in
  // postgres-community-daily-activation.check.mjs skips and the job stays green.
  const { workflow } = await loadWorkflow();
  const container = await readFile(join(REPOSITORY_ROOT, CONTAINER_SCRIPT), "utf8");
  const publish = [...container.matchAll(/^export const LOOPBACK_PUBLISH = "127\.0\.0\.1:(\d+):5432";$/gmu)];
  assert.equal(publish.length, 1, "the container publishes exactly one loopback TCP port");
  assert.deepEqual(workflow.jobs["cloud-run-check"].env, {
    A2_DAILY_ACTIVATION_TEST_HOST: "127.0.0.1",
    A2_DAILY_ACTIVATION_TEST_PORT: publish[0][1],
  });

  const cloudRun = "apps/worker/cloud-run";
  const activation = "postgres-community-daily-activation.check.mjs";
  const source = await readFile(join(REPOSITORY_ROOT, cloudRun, activation), "utf8");
  assert.match(source, /process\.env\.A2_DAILY_ACTIVATION_TEST_HOST\b/u);
  assert.match(source, /process\.env\.A2_DAILY_ACTIVATION_TEST_PORT\b/u);
  assert.match(source, /REAL_PG_HOST === "127\.0\.0\.1"/u);
  const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, cloudRun, "package.json"), "utf8"));
  assert.match(packageJson.scripts.check, new RegExp(`node --test [^&]*\\./${activation.replaceAll(".", "\\.")}`, "u"),
    "the Cloud Run check runs the daily-activation check under node --test");
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

/** Every job installs all three lockfiles and ends with the repository toolchain active. */
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
  if (!(pgFiles.length === 1 && pgFiles[0].startsWith("./postgres-test/"))) {
    failures.push(`${SPLIT_PRODUCTION_TOOLING} no longer ends with one PostgreSQL-backed spec`);
  }
  if (!/EXTRA_REGISTRATION_SCRIPTS = Object\.freeze\(\[[^\]]*"postgres:production-migrations:check"/u.test(suite)) {
    failures.push(`the PostgreSQL 17 suite does not register ${SPLIT_PRODUCTION_TOOLING}'s spec`);
  }
  for (const [file, text] of offlineSources) {
    if (/PG_TEST_/u.test(text)) failures.push(`${file} reads PG_TEST_*, so it is not an offline check`);
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
  if (!/process\.env\.POSTGRES_V12_TRANSFER_Q1_DUMP\b/u.test(transferSpec)) {
    failures.push("the transfer spec no longer reads POSTGRES_V12_TRANSFER_Q1_DUMP");
  }
  for (const file of goldenFiles) {
    if (file.exists !== true) failures.push(`the golden lacks ${file.path}, which the edge spec's S9 stage reads`);
  }
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (id !== "postgres-17-suite") {
      if (job.steps.some((step) => /EDGE_E2E_|POSTGRES_V12_TRANSFER_Q1_DUMP|22\.16/u.test(`${step.run ?? ""}${step.with?.["node-version"] ?? ""}`))) {
        failures.push(`${id} names the edge runtime; only postgres-17-suite runs the edge spec`);
      }
      continue;
    }
    const image = stepAt(job, isSetupNode(IMAGE_NODE));
    const name = stepAt(job, runMatches(/EDGE_E2E_NODE=/u));
    const toolchain = stepAt(job, isSetupNode(TOOLCHAIN_NODE));
    const rehearsal = stepAt(job, runMatches(/EDGE_E2E_REHEARSAL_NODE=/u));
    const gate = stepAt(job, (step) => step.run?.trim() === `node ${SUITE_SCRIPT}`);
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

test("the Worker gate needs the Cloud Run dependencies: its scripts check reaches a module importing the Cloud SQL connector", async () => {
  // gcp:fastpath:scripts-check ran under the Worker gate without the Cloud Run
  // lockfile and exited 1 with ERR_MODULE_NOT_FOUND from cloud-run/analytics-refresh.mjs.
  await init;
  const { worker, cloudRun } = await loadContractInputs();
  const connector = "@google-cloud/cloud-sql-connector";
  assert.ok(Object.hasOwn(cloudRun.dependencies, connector));
  assert.equal(Object.hasOwn(worker.dependencies ?? {}, connector), false, "the Worker lockfile does not provide it");
  assert.match(worker.scripts.check, /(?:^| && )npm run gcp:fastpath:scripts-check(?: && |$)/u);
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
  const gate = workflow.jobs["worker-gate"];
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

test("the PostgreSQL 17 suite runs the edge end-to-end spec under Node.js 22.16.0 and the Q-1 dump case, both from the committed golden", async () => {
  const { workflow } = await loadWorkflow();
  assert.deepEqual(edgeRuntimeFailures(workflow, await loadContractInputs()), []);
  const job = workflow.jobs["postgres-17-suite"];
  assert.deepEqual(job.steps.filter(({ uses }) => uses === SETUP_NODE).map((step) => step.with["node-version"]),
    [IMAGE_NODE, TOOLCHAIN_NODE]);
  // Still the suite's single gate, still no skips: the suite is not given an
  // opt-out for the edge spec.
  assert.equal(runs(job).filter((command) => command === `node ${SUITE_SCRIPT}`).length, 1);
  assert.equal(job.env.EDGE_E2E_NODE, undefined);
});

test("hosted CI contract: a job that drops the Cloud Run lockfile or the toolchain check is reported", async () => {
  const { workflow } = await loadWorkflow();
  const withoutCloudRun = structuredClone(workflow);
  const gate = withoutCloudRun.jobs["worker-gate"];
  const install = gate.steps[stepAt(gate, runMatches(/pnpm install/u))];
  install.run = install.run.replace("npm --prefix apps/worker/cloud-run ci\n", "");
  assert.deepEqual(toolchainFailures(withoutCloudRun), ["worker-gate does not run `npm --prefix apps/worker/cloud-run ci`"]);

  const unchecked = structuredClone(workflow);
  const job = unchecked.jobs["cloud-run-check"];
  const step = job.steps[stepAt(job, runMatches(/pnpm install/u))];
  step.run = step.run.replace(`test "$(node --version)" = "v${TOOLCHAIN_NODE}"\n`, "");
  assert.deepEqual(toolchainFailures(unchecked),
    [`cloud-run-check does not check that Node.js ${TOOLCHAIN_NODE} is the active runtime before installing`]);

  const second = structuredClone(workflow);
  second.jobs["worker-gate"].steps.splice(1, 0, structuredClone(
    second.jobs["postgres-17-suite"].steps[stepAt(second.jobs["postgres-17-suite"], isSetupNode(IMAGE_NODE))]));
  assert.match(toolchainFailures(second).join("\n"), /worker-gate installs Node\.js \["22\.16\.0","26\.2\.0"\]/u);

  const imageLast = structuredClone(workflow);
  const suite = imageLast.jobs["postgres-17-suite"];
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
    change(copy.jobs["postgres-17-suite"], copy);
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

  // Order: the toolchain must be installed last so it is first on PATH.
  assert.ok(mutate((job) => {
    const [tool] = job.steps.splice(stepAt(job, isSetupNode(TOOLCHAIN_NODE)), 1);
    job.steps.splice(stepAt(job, isSetupNode(IMAGE_NODE)), 0, tool);
  }).some((failure) => failure.includes("out of order")));
  assert.ok(mutate((job) => {
    const [gate] = job.steps.splice(stepAt(job, (step) => step.run?.trim() === `node ${SUITE_SCRIPT}`), 1);
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

  // The other two jobs never name the edge runtime.
  for (const id of ["worker-gate", "cloud-run-check"]) {
    const leaked = structuredClone(workflow);
    leaked.jobs[id].steps.splice(1, 0, { name: "leak", run: "printf 'EDGE_E2E_NODE=x\\n' >> \"$GITHUB_ENV\"" });
    assert.deepEqual(edgeRuntimeFailures(leaked, inputs), [`${id} names the edge runtime; only postgres-17-suite runs the edge spec`]);
  }

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
  assert.equal(widened.length, 1, "the checked-in image runtime step is refused in any other workflow");
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
