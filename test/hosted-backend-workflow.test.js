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
          "node-version": "26.2.0",
          "check-latest": false,
          "package-manager-cache": false,
        });
      }
    }
    assert.equal(job.steps.filter(({ uses: action }) => action === CHECKOUT).length, 1);
    assert.equal(job.steps.filter(({ uses: action }) => action === SETUP_NODE).length, 1);
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
    assert.equal(/^npm --prefix apps\/worker\/cloud-run ci$/mu.test(install), id !== "worker-gate", id);

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
