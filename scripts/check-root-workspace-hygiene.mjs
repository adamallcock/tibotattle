#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");

/**
 * These are the top-level entries currently present in the repository. Keep
 * this policy deliberately small: a new root entry should be an intentional
 * project-layout decision, not an accidental report or build output.
 */
export const ROOT_WORKSPACE_POLICY = Object.freeze({
  files: Object.freeze([
    ".dockerignore",
    ".gitattributes",
    ".gitignore",
    ".gitleaksignore",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ]),
  directories: Object.freeze([
    ".claude",
    ".github",
    "apps",
    "config",
    "containers",
    "contracts",
    "docs",
    "experiments",
    "generated",
    "local-review",
    "native",
    "packages",
    // Exact-version pnpm patches are reviewed source inputs. They pin
    // release-tool behavior and are not generated build output.
    "patches",
    // Per-version release notes. The macOS stable release runbook requires a
    // release-notes/X.Y.Z.md for every version, so this is deliberate project
    // structure rather than a generated report.
    "release-notes",
    "schemas",
    "scripts",
    "src",
    "test",
    "third_party_licenses",
    "tools",
  ]),
});

const EXPECTED_ROOT_KINDS = new Map([
  ...ROOT_WORKSPACE_POLICY.files.map((name) => [name, "file"]),
  ...ROOT_WORKSPACE_POLICY.directories.map((name) => [name, "directory"]),
]);
const VCS_METADATA_ENTRY = ".git";
const KNOWN_ROOT_GENERATED_FILENAMES = new Set([
  "artifact.json",
]);
const KNOWN_ROOT_BUILD_DIRECTORIES = new Set([
  ".build",
  "build",
  "coverage",
  "dist",
]);
const DATED_ROOT_ENTRY_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[._-]|$)/u;
const GENERATED_MARKER_RE = /(?:^|[._-])(?:report|artifact|receipt|verification|evidence|snapshot)(?:[._-]|$)/iu;
const GENERATED_OUTPUT_RE = /\.(?:html?|jsonl?|csv|md|pdf|png|svg|txt)(?:$|\.tmp(?:[._-].*)?$)/iu;
const TEMP_OUTPUT_RE = /\.tmp(?:[._-].*)?$/iu;

function issue(code, path, detail) {
  return { code, detail, path };
}

function rootEntryName(path) {
  if (typeof path !== "string" || path.length === 0) return null;
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return normalized.split("/", 1)[0] || null;
}

function normalizeTrackedRootEntries(paths) {
  return [...new Set(
    paths
      .map(rootEntryName)
      .filter((name) => name !== null),
  )].sort();
}

async function discoverTrackedRootEntries(rootDirectory) {
  const result = await execFile(
    "git",
    ["-C", rootDirectory, "ls-files", "-z", "--"],
    { encoding: "utf8" },
  );
  return normalizeTrackedRootEntries(
    result.stdout.split("\0").filter(Boolean),
  );
}

function entryKind(entry) {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

function classifyGeneratedRootEntry(name, kind = "file") {
  if (KNOWN_ROOT_GENERATED_FILENAMES.has(name)) {
    return "known legacy report/artifact";
  }
  if (kind === "directory" && KNOWN_ROOT_BUILD_DIRECTORIES.has(name)) {
    return "known transient build/test output";
  }

  const isGeneratedMarker = GENERATED_MARKER_RE.test(name);
  if (!isGeneratedMarker) return null;

  if (DATED_ROOT_ENTRY_RE.test(name)
      && (kind === "directory" || GENERATED_OUTPUT_RE.test(name))) {
    return "dated report/artifact";
  }
  if (TEMP_OUTPUT_RE.test(name)) return "temporary report/artifact";
  return null;
}

function generatedEntryDetail(name, classification) {
  return [
    "Detected " + classification + " at repository root: " + name + ".",
    "Keep private report output under .usage-monitor/legacy-reports/,",
    "reviewed documents under docs/, and generated output under a",
    "purpose-specific ignored directory. Relocate the path, then rerun",
    "the root-workspace hygiene check.",
  ].join(" ");
}

function unexpectedTrackedEntryDetail() {
  return [
    "Tracked root entries must be added deliberately to",
    "ROOT_WORKSPACE_POLICY. Keep generated reports/artifacts under",
    ".usage-monitor/legacy-reports/ or a purpose-specific output directory;",
    "update the policy only for intentional project structure.",
  ].join(" ");
}

function wrongKindDetail(expected, actual) {
  return "The root policy expects a " + expected + "; found " + actual
    + ". Repair the entry or update the reviewed policy.";
}

/**
 * Checks the tracked top-level layout and catches the narrow class of root
 * report/artifact outputs that can be created without becoming tracked.
 *
 * trackedRootEntries is injectable for deterministic fixture tests. The CLI
 * discovers it from Git so ignored build/state directories do not become
 * accidental policy entries.
 */
export async function checkRootWorkspaceHygiene({
  rootDirectory = DEFAULT_REPOSITORY_ROOT,
  trackedRootEntries = null,
} = {}) {
  const absoluteRoot = resolve(rootDirectory);
  const tracked = trackedRootEntries === null
    ? await discoverTrackedRootEntries(absoluteRoot)
    : normalizeTrackedRootEntries(trackedRootEntries);
  const physicalEntries = await readdir(absoluteRoot, { withFileTypes: true });
  physicalEntries.sort((left, right) => left.name.localeCompare(right.name));
  const physicalByName = new Map(
    physicalEntries.map((entry) => [entry.name, entry]),
  );
  const trackedSet = new Set(tracked);
  const issues = [];

  for (const name of tracked) {
    const actualEntry = physicalByName.get(name);
    const generatedClassification = classifyGeneratedRootEntry(
      name,
      actualEntry ? entryKind(actualEntry) : "file",
    );
    const expectedKind = EXPECTED_ROOT_KINDS.get(name);
    if (expectedKind === undefined && generatedClassification === null) {
      issues.push(issue(
        "unexpected_tracked_root_entry",
        name,
        unexpectedTrackedEntryDetail(),
      ));
      continue;
    }
    if (expectedKind !== undefined && actualEntry !== undefined) {
      const actualKind = entryKind(actualEntry);
      if (actualKind !== expectedKind) {
        issues.push(issue(
          "tracked_root_entry_kind",
          name,
          wrongKindDetail(expectedKind, actualKind),
        ));
      }
    }
    if (generatedClassification !== null) {
      issues.push(issue(
        "generated_root_artifact",
        name,
        generatedEntryDetail(name, generatedClassification),
      ));
    }
  }

  for (const entry of physicalEntries) {
    if (entry.name === VCS_METADATA_ENTRY || trackedSet.has(entry.name)) {
      continue;
    }
    const classification = classifyGeneratedRootEntry(
      entry.name,
      entryKind(entry),
    );
    if (classification !== null) {
      issues.push(issue(
        "generated_root_artifact",
        entry.name,
        generatedEntryDetail(entry.name, classification),
      ));
    }
  }

  issues.sort(
    (left, right) =>
      left.code.localeCompare(right.code)
      || left.path.localeCompare(right.path)
      || left.detail.localeCompare(right.detail),
  );
  return {
    issues,
    ok: issues.length === 0,
    physicalRootEntries: physicalEntries.map((entry) => entry.name),
    policy: ROOT_WORKSPACE_POLICY,
    trackedRootEntries: tracked,
  };
}

export function formatRootWorkspaceHygieneReport(result) {
  if (result.ok) {
    return [
      "Root workspace hygiene is clean.",
      "Tracked root entries: " + result.trackedRootEntries.length,
      "Policy: " + ROOT_WORKSPACE_POLICY.files.length + " files, "
        + ROOT_WORKSPACE_POLICY.directories.length + " directories.",
    ].join("\n");
  }
  return [
    "Root workspace hygiene check failed with " + result.issues.length + " issue(s).",
    ...result.issues.map(
      ({ code, detail, path }) => "- [" + code + "] " + path + ": " + detail,
    ),
  ].join("\n");
}

function parseArguments(arguments_) {
  let rootDirectory = process.cwd();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--root") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--root requires a directory.");
      }
      rootDirectory = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { help: true, rootDirectory };
    }
    throw new Error("Unknown argument: " + argument);
  }
  return { help: false, rootDirectory };
}

function usage() {
  return [
    "Usage: node ./scripts/check-root-workspace-hygiene.mjs [--root <directory>]",
    "",
    "Validate the reviewed tracked root layout and reject dated report/artifact",
    "or report/artifact temporary outputs in the repository root.",
  ].join("\n");
}

async function runCli() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage() + "\n");
      return;
    }
    const result = await checkRootWorkspaceHygiene(options);
    const output = formatRootWorkspaceHygieneReport(result);
    if (result.ok) {
      process.stdout.write(output + "\n");
    } else {
      process.stderr.write(output + "\n");
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(error.message + "\n" + usage() + "\n");
    process.exitCode = 2;
  }
}

if (resolve(process.argv[1] ?? "") === SCRIPT_FILE) {
  await runCli();
}
