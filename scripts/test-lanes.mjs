#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as fileSystemConstants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PORTABLE_TEST_FILES,
  WINDOWS_PORTABLE_TEST_FILES,
} from "./portable-test-manifest.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const TEST_REPORTER_ENVIRONMENT_VARIABLE = "USAGE_MONITOR_TEST_LANE_REPORTER";
const SUPPORTED_TEST_REPORTERS = new Set(["dot", "spec", "tap"]);

// The app-bundle test file explicitly tags its three package-building tests
// with macOSArtifactTest. The source lane activates that tag's source scope,
// so a future title edit cannot silently change which test bodies run.
export const MACOS_SOURCE_TEST_FILES = Object.freeze([
  "test/i18n-foundation.test.js",
  "test/macos-localization.test.js",
  "test/macos-app-bundle.test.js",
  "test/macos-keychain-migration-artifact.test.js",
  "test/macos-keychain-migration-runner.test.js",
  "test/macos-keychain-migration-ui.test.js",
]);

export const MACOS_ARTIFACT_TEST_FILES = Object.freeze([
  "test/macos-app-bundle.test.js",
  "test/macos-keychain-migration-artifact.test.js",
  "test/macos-keychain-migration-runner.test.js",
  "test/macos-keychain-migration-ui.test.js",
  "test/macos-updater.test.js",
  "test/macos-updater-release.test.mjs",
]);

export const MACOS_SMOKE_TEST_FILES = Object.freeze([
  "test/macos-test-build.test.mjs",
]);

export const LANE_REGRESSION_TEST_FILES = Object.freeze([
  "test/test-lanes.test.js",
  "test/benchmark-test-lanes.test.js",
]);

const ALL_EXPLICIT_TEST_FILES = Object.freeze([
  ...new Set([
    ...MACOS_SOURCE_TEST_FILES,
    ...MACOS_ARTIFACT_TEST_FILES,
    ...MACOS_SMOKE_TEST_FILES,
    ...LANE_REGRESSION_TEST_FILES,
    ...PORTABLE_TEST_FILES,
  ]),
]);

const LANE_ORDER = Object.freeze([
  "macos-source",
  "i18n",
  "macos-smoke",
  "macos-artifact",
  "full",
]);

const VALID_COMMANDS = new Set([
  "preflight",
  "portable",
  "fast",
  "changed",
  "plan",
  "macos-source",
  "macos-smoke",
  "macos-artifact",
]);

function normalizePath(path) {
  return path.split(sep).join("/").replace(/^\.\//u, "");
}

function canonicalRepositoryPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    return null;
  }
  const selected = resolve(REPOSITORY_ROOT, path);
  const selectedRelative = relative(REPOSITORY_ROOT, selected);
  if (selectedRelative === ""
      || selectedRelative === ".."
      || selectedRelative.startsWith(`..${sep}`)) {
    return null;
  }
  return normalizePath(selectedRelative);
}

function requiredOptionValue(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("-")) {
    throw new Error(`${option} must be provided with a non-option value`);
  }
  return value;
}

function requiredRepositoryPath(arguments_, index) {
  const value = requiredOptionValue(arguments_, index, "--path");
  const path = canonicalRepositoryPath(value);
  if (path === null) {
    throw new Error("--path must be a non-empty repository-relative path");
  }
  return path;
}

function isDocumentationPath(path) {
  return path === "README.md"
    || path.startsWith("docs/")
    || path.endsWith(".md");
}

function isNativeAppPath(path) {
  return path.startsWith("apps/macos/")
    || path === "scripts/build-macos-app.js";
}

function nativePathNeedsArtifactLane(path) {
  return path === "scripts/build-macos-app.js"
    || path.startsWith("apps/macos/Assets/")
    || path.startsWith("apps/macos/Resources/");
}

function classifyKnownPath(path, lanes) {
  if (isNativeAppPath(path)) {
    lanes.add("macos-source");
    lanes.add("macos-smoke");
    if (nativePathNeedsArtifactLane(path)) lanes.add("macos-artifact");
    return true;
  }
  if (path === "scripts/prepare-sparkle-framework.js") {
    lanes.add("macos-artifact");
    return true;
  }
  if (path === "test/macos-app-bundle.test.js") {
    lanes.add("macos-source");
    lanes.add("macos-artifact");
    return true;
  }
  if (path === "test/macos-keychain-migration-artifact.test.js"
      || path === "test/macos-keychain-migration-runner.test.js"
      || path === "test/macos-keychain-migration-ui.test.js") {
    lanes.add("macos-source");
    lanes.add("macos-artifact");
    return true;
  }
  if (path === "test/macos-localization.test.js") {
    lanes.add("macos-source");
    return true;
  }
  if (path === "test/macos-test-build.test.mjs") {
    lanes.add("macos-smoke");
    return true;
  }
  if (path === "test/macos-updater.test.js"
      || path === "test/macos-updater-release.test.mjs") {
    lanes.add("macos-artifact");
    return true;
  }
  if (path.startsWith("packages/i18n/")
      || path === "scripts/generate-i18n-browser-mirror.js") {
    lanes.add("i18n");
    return true;
  }
  return false;
}

/**
 * Selects a narrow lane only when this runner executes every relevant test
 * family. Shared, cross-surface, or unfamiliar paths deliberately use the
 * complete `npm run check` gate instead of reporting a scoped false green.
 */
export function selectTestLanes(paths, { full = false } = {}) {
  const lanes = new Set();
  const unknownPaths = [];
  const normalizedPaths = [];

  for (const candidate of paths) {
    const path = canonicalRepositoryPath(candidate);
    if (path === null) {
      const displayed = typeof candidate === "string" ? candidate : String(candidate);
      normalizedPaths.push(displayed);
      unknownPaths.push(displayed);
      continue;
    }
    normalizedPaths.push(path);
    if (isDocumentationPath(path)) continue;
    if (!classifyKnownPath(path, lanes)) unknownPaths.push(path);
  }

  if (full && (lanes.has("macos-source") || lanes.has("macos-smoke"))) {
    lanes.add("macos-artifact");
  }
  if (unknownPaths.length > 0) {
    return Object.freeze({
      lanes: Object.freeze(["full"]),
      paths: Object.freeze(normalizedPaths),
      unknownPaths: Object.freeze(unknownPaths),
    });
  }
  return Object.freeze({
    lanes: Object.freeze(LANE_ORDER.filter((lane) => lanes.has(lane))),
    paths: Object.freeze(normalizedPaths),
    unknownPaths: Object.freeze([]),
  });
}

export function parseTestLaneArguments(argv) {
  const arguments_ = [...argv];
  const command = arguments_.shift() ?? "fast";
  if (command === "--help" || command === "-h") {
    return Object.freeze({ command: "help", base: null, full: false, paths: Object.freeze([]) });
  }

  const paths = [];
  let base = null;
  let full = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--base") {
      if (base !== null) throw new Error("--base must be provided at most once");
      base = requiredOptionValue(arguments_, index, "--base");
      index += 1;
    } else if (argument === "--full") {
      if (full) throw new Error("--full must be provided at most once");
      full = true;
    } else if (argument === "--path") {
      paths.push(requiredRepositoryPath(arguments_, index));
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      return Object.freeze({ command: "help", base: null, full: false, paths: Object.freeze([]) });
    } else {
      throw new Error(`Unknown test-lane argument: ${argument}`);
    }
  }
  if (!VALID_COMMANDS.has(command)) {
    throw new Error(`Unknown test lane: ${command}`);
  }
  if (command !== "changed" && command !== "plan"
      && (base !== null || full || paths.length > 0)) {
    throw new Error("--base, --path, and --full are only valid with changed or plan");
  }
  return Object.freeze({ command, base, full, paths: Object.freeze(paths) });
}

function formatCommand(command, arguments_) {
  return [command, ...arguments_]
    .map((part) => /[\s"']/u.test(part) ? JSON.stringify(part) : part)
    .join(" ");
}

export async function runCommand(command, arguments_, {
  cwd = REPOSITORY_ROOT,
  env = process.env,
  stdio = "inherit",
} = {}) {
  console.log(`\n> ${formatCommand(command, arguments_)}`);
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, { cwd, env, stdio });
    child.once("error", (error) => {
      rejectRun(new Error(`${formatCommand(command, arguments_)} could not start: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(
        `${formatCommand(command, arguments_)} failed with ${signal ?? `exit code ${code}`}`,
      ));
    });
  });
}

async function readCommandOutput(command, arguments_, {
  acceptedExitCodes = [0],
} = {}) {
  const chunks = [];
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd: REPOSITORY_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (acceptedExitCodes.includes(code)) resolveRun();
      else rejectRun(new Error(Buffer.concat(chunks).toString("utf8").trim()));
    });
  });
  return Buffer.concat(chunks).toString("utf8");
}

export function mergeChangedPaths(outputs) {
  const merged = new Set();
  for (const output of outputs) {
    for (const candidate of output.split("\0").filter(Boolean)) {
      merged.add(canonicalRepositoryPath(candidate) ?? candidate);
    }
  }
  return Object.freeze([...merged].sort());
}

async function untrackedPaths() {
  const output = await readCommandOutput("git", [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  return mergeChangedPaths([output]);
}

async function validateExplicitTestFiles() {
  await Promise.all(ALL_EXPLICIT_TEST_FILES.map(async (path) => {
    const selected = resolve(REPOSITORY_ROOT, path);
    const selectedRelative = relative(REPOSITORY_ROOT, selected);
    if (selectedRelative === ".." || selectedRelative.startsWith(`..${sep}`)) {
      throw new Error(`Test target escapes the repository: ${path}`);
    }
    const metadata = await lstat(selected);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Test target is not a regular file: ${path}`);
    }
    await access(selected, fileSystemConstants.R_OK);
  }));
}

function testReporterArguments(environment = process.env) {
  const reporter = environment[TEST_REPORTER_ENVIRONMENT_VARIABLE];
  if (reporter === undefined) return [];
  if (!SUPPORTED_TEST_REPORTERS.has(reporter)) {
    throw new Error(
      `${TEST_REPORTER_ENVIRONMENT_VARIABLE} must be one of dot, spec, or tap`,
    );
  }
  return [`--test-reporter=${reporter}`];
}

async function checkUntrackedWhitespace() {
  for (const path of await untrackedPaths()) {
    const output = await readCommandOutput("git", [
      "diff",
      "--no-index",
      "--check",
      "--",
      NULL_DEVICE,
      resolve(REPOSITORY_ROOT, path),
    ], { acceptedExitCodes: [0, 1] });
    if (output.trim().length > 0) {
      throw new Error(`Untracked-file whitespace check failed for ${path}: ${output.trim()}`);
    }
  }
}

export async function runPreflight() {
  testReporterArguments();
  await validateExplicitTestFiles();
  await runCommand("git", ["diff", "--check"]);
  await runCommand("git", ["diff", "--cached", "--check"]);
  await checkUntrackedWhitespace();
  await runCommand(process.execPath, [
    "./tools/operations/validate-documentation.mjs",
  ]);
  await runNodeTests([
    "test/documentation-governance.test.js",
    "test/agent-guidance.test.js",
  ]);
}

async function runNodeTests(arguments_, { environment = process.env } = {}) {
  await runCommand(process.execPath, [
    "--test",
    ...testReporterArguments(environment),
    ...arguments_,
  ], { env: environment });
}

function assertMacOSSmokeBuildSupported() {
  if (process.platform !== "darwin"
      || process.arch !== "arm64"
      || process.version !== "v26.2.0") {
    throw new Error(
      "macos-smoke requires macOS arm64 with pinned Node v26.2.0; no smoke build was run",
    );
  }
}

async function runLane(lane) {
  if (lane === "portable") {
    const files = process.platform === "win32"
      ? WINDOWS_PORTABLE_TEST_FILES
      : PORTABLE_TEST_FILES;
    await runNodeTests(["--test-concurrency=1", ...files]);
    return;
  }
  if (lane === "i18n") {
    await runNodeTests(["--test-concurrency=1", "test/i18n-foundation.test.js"]);
    await runCommand(NPM_COMMAND, ["run", "product:ui:test"]);
    return;
  }
  if (lane === "macos-source") {
    await runNodeTests([
      "--test-concurrency=1",
      "test/i18n-foundation.test.js",
      "test/macos-localization.test.js",
    ]);
    await runNodeTests([
      "--test-concurrency=1",
      "test/macos-app-bundle.test.js",
      "test/macos-keychain-migration-artifact.test.js",
      "test/macos-keychain-migration-runner.test.js",
      "test/macos-keychain-migration-ui.test.js",
    ], {
      environment: {
        ...process.env,
        USAGE_MONITOR_TEST_LANES: "1",
        USAGE_MONITOR_MACOS_TEST_SCOPE: "source",
      },
    });
    return;
  }
  if (lane === "macos-smoke") {
    assertMacOSSmokeBuildSupported();
    await runNodeTests(["--test-concurrency=1", ...MACOS_SMOKE_TEST_FILES]);
    return;
  }
  if (lane === "macos-artifact") {
    await runCommand(NPM_COMMAND, ["run", "product:macos:updater:prepare"]);
    await runNodeTests([
      "--test-concurrency=1",
      "test/macos-app-bundle.test.js",
      "test/macos-keychain-migration-artifact.test.js",
      "test/macos-keychain-migration-runner.test.js",
      "test/macos-keychain-migration-ui.test.js",
    ], {
      environment: {
        ...process.env,
        USAGE_MONITOR_TEST_LANES: "1",
        USAGE_MONITOR_MACOS_TEST_SCOPE: "artifact",
      },
    });
    await runNodeTests([
      "--test-concurrency=1",
      "test/macos-updater.test.js",
      "test/macos-updater-release.test.mjs",
    ]);
    return;
  }
  if (lane === "full") {
    await runCommand(NPM_COMMAND, ["run", "check"], {
      env: {
        ...process.env,
        USAGE_MONITOR_TEST_LANES: "0",
        USAGE_MONITOR_MACOS_TEST_SCOPE: "all",
      },
    });
    return;
  }
  throw new Error(`Unknown executable test lane: ${lane}`);
}

async function runSelectedLanes(lanes) {
  for (const lane of lanes) {
    await runLane(lane);
  }
}

async function changedPaths(base) {
  // A base comparison supplies committed branch work. The active checkout and
  // untracked files are added deliberately, so local changes cannot be hidden
  // merely because the caller also supplied a merge-base revision.
  const revisions = base === null ? ["HEAD"] : [`${base}...HEAD`, "HEAD"];
  const outputs = await Promise.all([
    ...revisions.map((revision) => readCommandOutput("git", [
      "diff",
      "--name-only",
      "-z",
      revision,
    ])),
    readCommandOutput("git", [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  return mergeChangedPaths(outputs);
}

function usage() {
  console.log(`Usage: node scripts/test-lanes.mjs <lane> [options]

Lanes:
  preflight       Validate selected tests, whitespace, docs governance, and agent guidance.
  portable        Run the explicit platform-neutral Node, web, and companion manifest.
  fast            Run fast macOS source/configuration checks.
  changed         Select conservative lanes from branch plus active-worktree paths.
  plan            Print the selected lanes without running them.
  macos-source    Run only source/configuration assertions from the macOS suite.
  macos-smoke     Build one test-profile development app and smoke it (pinned builder only).
  macos-artifact  Prepare Sparkle and run the native artifact and updater tests.

Options for changed and plan:
  --base <rev>    Include <rev>...HEAD plus staged, unstaged, and untracked paths.
  --path <path>   Supply a repository-relative changed path (repeatable).
  --full          Escalate selected native source changes to the artifact lane.
`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseTestLaneArguments(argv);
  if (options.command === "help") {
    usage();
    return;
  }
  if (options.command === "preflight") {
    await runPreflight();
    return;
  }

  let selection;
  if (options.command === "changed" || options.command === "plan") {
    const paths = options.paths.length > 0
      ? options.paths
      : await changedPaths(options.base);
    selection = selectTestLanes(paths, { full: options.full });
    console.log(JSON.stringify(selection, null, 2));
    if (options.command === "plan") return;
  } else if (options.command === "fast") {
    selection = Object.freeze({ lanes: Object.freeze(["macos-source"]) });
  } else {
    selection = Object.freeze({ lanes: Object.freeze([options.command]) });
  }

  await runPreflight();
  if (selection.lanes.length === 0) {
    console.log("No code or test paths selected; preflight completed.");
    return;
  }
  await runSelectedLanes(selection.lanes);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    console.error(`test-lanes: ${error.message}`);
    process.exitCode = 1;
  });
}
