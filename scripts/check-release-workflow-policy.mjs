#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/u;
// Keep this an explicit allowlist rather than accepting any label with a
// familiar prefix.  A repository-owned runner group can otherwise be named
// `ubuntu-custom` and still pass a prefix-only check.  These are the standard
// GitHub-hosted labels documented at:
// https://docs.github.com/en/actions/reference/runners/github-hosted-runners
const GITHUB_HOSTED_RUNNER_LABELS = new Set([
  "ubuntu-slim",
  "ubuntu-latest",
  "ubuntu-22.04",
  "ubuntu-24.04",
  "ubuntu-26.04",
  "ubuntu-22.04-arm",
  "ubuntu-24.04-arm",
  "ubuntu-26.04-arm",
  "windows-latest",
  "windows-2022",
  "windows-2025",
  "windows-2025-vs2026",
  "windows-11-arm",
  "windows-11-vs2026-arm",
  "macos-latest",
  "macos-14",
  "macos-15",
  "macos-26",
  "macos-15-intel",
  "macos-26-intel",
]);
const WORKFLOW_EXTENSIONS = new Set([".yml", ".yaml"]);
// Toolchain versions are supply-chain inputs, so actions/setup-node may only
// select an exact version from this reviewed allowlist, never a range, alias or
// expression. Every workflow may select the repository toolchain. The Cloud Run
// image runtime is selected only by the hosted-backend workflow, where the edge
// end-to-end spec runs under it beside the repository toolchain; no release or
// packaging workflow may pick it up by accident.
const REPOSITORY_NODE_VERSION = "26.2.0";
const CLOUD_RUN_IMAGE_NODE_VERSION = "22.16.0";
const CLOUD_RUN_IMAGE_NODE_WORKFLOWS = new Set([".github/workflows/hosted-backend.yml"]);
// The `with:` inputs actions/setup-node may be given, and the only values the
// reviewed workflows use for `architecture`. Any other input is refused, so a
// mirror, registry, token or cache input cannot change where the toolchain is
// downloaded from or what it is allowed to trust without a policy review.
// `node-version` and `check-latest` carry their own value rules below.
const SETUP_NODE_INPUTS = new Set(["node-version", "check-latest", "package-manager-cache", "architecture"]);
const SETUP_NODE_ARCHITECTURES = new Set(["x64", "arm64"]);

function normalizePath(path) {
  return path.split(sep).join("/");
}

async function workflowFiles(root) {
  const selected = resolve(root);
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && WORKFLOW_EXTENSIONS.has(extname(entry.name))) {
        files.push(path);
      }
    }
  }

  for (const directory of [
    resolve(selected, ".github", "workflows"),
    resolve(selected, ".github", "actions"),
  ]) {
    await visit(directory).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return files;
}

function stripYamlComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "'" && character === "'" && line[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (quote === '"' && character === "\\") {
      index += 1;
      continue;
    }
    if ((character === "'" || character === '"') && quote === null) {
      quote = character;
      continue;
    }
    if (character === quote) {
      quote = null;
      continue;
    }
    if (character === "#" && quote === null
        && (index === 0 || /\s/u.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquoteYamlScalar(value) {
  const selected = value.trim();
  if (selected.length >= 2 && selected.startsWith("'") && selected.endsWith("'")) {
    return selected.slice(1, -1).replaceAll("''", "'");
  }
  if (selected.length >= 2 && selected.startsWith('"') && selected.endsWith('"')) {
    try {
      return JSON.parse(selected);
    } catch {
      return selected.slice(1, -1);
    }
  }
  return selected;
}

function runnerLabels(value, block) {
  const selected = value.trim();
  if (selected.startsWith("[") && selected.endsWith("]")) {
    return selected.slice(1, -1).split(",").map((item) => unquoteYamlScalar(item));
  }
  if (selected === "") {
    return block.map(({ line }) => unquoteYamlScalar(line.replace(/^\s*-\s*/u, "")));
  }
  return [unquoteYamlScalar(selected)];
}

function parseYamlKeyValue(line) {
  const clean = stripYamlComment(line);
  const match = clean.match(/^(\s*)(?:-\s*)?(?:(["'])([A-Za-z0-9_.-]+)\2|([A-Za-z0-9_.-]+))\s*:(.*)$/u);
  if (!match) return null;
  return Object.freeze({
    indent: match[1].length,
    key: match[3] ?? match[4],
    value: match[5].trim(),
  });
}

function indentedBlock(lines, start, parentIndent) {
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const clean = stripYamlComment(lines[index]);
    if (clean.trim() === "") continue;
    const indent = clean.match(/^\s*/u)[0].length;
    if (indent <= parentIndent) break;
    block.push({ line: clean, lineNumber: index + 1 });
  }
  return block;
}

const FLOW_POLICY_KEYS = new Set([
  "uses",
  "runs-on",
  "persist-credentials",
  "pull_request_target",
]);

function inspectFlowStylePolicyKeys(lines, path) {
  const failures = [];
  const keys = new Set();
  let flowDepth = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const clean = stripYamlComment(lines[lineIndex]);
    let quote = null;
    for (let index = 0; index < clean.length; index += 1) {
      const character = clean[index];
      if (quote === null && flowDepth > 0) {
        const triggerScalar = clean.slice(index).match(
          /^(?:(['"])pull_request_target\1|pull_request_target)(?=\s*[,}\]])/u,
        );
        if (triggerScalar !== null) {
          keys.add(`${lineIndex + 1}:pull_request_target`);
          failures.push(`${path}:${lineIndex + 1}: pull_request_target is forbidden`);
          index += triggerScalar[0].length - 1;
          continue;
        }
        const keyMatch = clean.slice(index).match(
          /^(?:(['"])(uses|runs-on|persist-credentials|pull_request_target)\1|(uses|runs-on|persist-credentials|pull_request_target))\s*:/u,
        );
        if (keyMatch !== null) {
          const key = keyMatch[2] ?? keyMatch[3];
          keys.add(`${lineIndex + 1}:${key}`);
          const message = key === "pull_request_target"
            ? "pull_request_target is forbidden"
            : `${key} is forbidden in flow-style mappings; use block YAML`;
          failures.push(`${path}:${lineIndex + 1}: ${message}`);
          index += keyMatch[0].length - 1;
          continue;
        }
      }
      if (quote === "'" && character === "'" && clean[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (quote === '"' && character === "\\") {
        index += 1;
        continue;
      }
      if ((character === "'" || character === '"') && quote === null) {
        quote = character;
        continue;
      }
      if (character === quote) {
        quote = null;
        continue;
      }
      if (quote !== null) continue;

      if (character === "{" || character === "[") {
        flowDepth += 1;
      } else if (character === "}" || character === "]") {
        flowDepth = Math.max(0, flowDepth - 1);
      }
    }
  }
  return Object.freeze({ failures: Object.freeze(failures), keys });
}

function stepBlock(lines, start, parentIndent) {
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const clean = stripYamlComment(lines[index]);
    if (clean.trim() === "") continue;
    const indent = clean.match(/^\s*/u)[0].length;
    if (indent <= parentIndent) break;
    block.push({ line: clean, lineNumber: index + 1 });
  }
  return block;
}

function stepParentIndent(lines, start, entryIndent) {
  const current = stripYamlComment(lines[start]);
  if (/^\s*-\s*/u.test(current)) return entryIndent;
  for (let index = start - 1; index >= 0; index -= 1) {
    const clean = stripYamlComment(lines[index]);
    if (clean.trim() === "") continue;
    const listItem = clean.match(/^(\s*)-\s+/u);
    if (listItem !== null && listItem[1].length < entryIndent) {
      return listItem[1].length;
    }
    const indent = clean.match(/^\s*/u)[0].length;
    if (indent < entryIndent) break;
  }
  return Math.max(0, entryIndent - 2);
}

/**
 * The direct children of a step's `with:` mapping, in order. A key nested
 * deeper, or set under another mapping such as `env:`, is not one of them.
 */
function stepWithEntries(lines, start, stepIndent) {
  const block = stepBlock(lines, start, stepIndent);
  const entries = [];
  for (let index = 0; index < block.length; index += 1) {
    const withEntry = parseYamlKeyValue(block[index].line);
    if (withEntry?.key !== "with") continue;
    let childIndent;
    for (let nestedIndex = index + 1; nestedIndex < block.length; nestedIndex += 1) {
      const nestedLine = block[nestedIndex];
      const nestedIndent = nestedLine.line.match(/^\s*/u)[0].length;
      if (nestedIndent <= withEntry.indent) break;
      const nestedEntry = parseYamlKeyValue(nestedLine.line);
      if (nestedEntry === null) continue;
      childIndent ??= nestedIndent;
      if (nestedIndent === childIndent) entries.push(nestedEntry);
    }
  }
  return entries;
}

function checkoutPersistenceEntry(lines, start, stepIndent) {
  return stepWithEntries(lines, start, stepIndent).find(({ key }) => key === "persist-credentials");
}

/** Failures for one actions/setup-node step; `entries` are its with: children. */
function setupNodeFailures(entries, { path, lineNumber }) {
  const failures = [];
  const versions = entries.filter(({ key }) => key === "node-version");
  if (versions.length !== 1) {
    failures.push(`${path}:${lineNumber}: actions/setup-node must set node-version exactly once, to a reviewed exact version`);
  } else {
    const version = unquoteYamlScalar(versions[0].value);
    const allowed = version === REPOSITORY_NODE_VERSION
      || (version === CLOUD_RUN_IMAGE_NODE_VERSION && CLOUD_RUN_IMAGE_NODE_WORKFLOWS.has(path));
    if (!allowed) {
      failures.push(`${path}:${lineNumber}: actions/setup-node node-version must be ${REPOSITORY_NODE_VERSION}`
        + `, or ${CLOUD_RUN_IMAGE_NODE_VERSION} in ${[...CLOUD_RUN_IMAGE_NODE_WORKFLOWS].join(", ")} only`
        + `; a range, alias, expression or unreviewed version is forbidden`);
    }
  }
  for (const entry of entries) {
    if (entry.key === "node-version-file") {
      failures.push(`${path}:${lineNumber}: actions/setup-node must not read its version from node-version-file`);
      continue;
    }
    if (!SETUP_NODE_INPUTS.has(entry.key)) {
      failures.push(`${path}:${lineNumber}: actions/setup-node input ${entry.key} is not reviewed`
        + `; only ${[...SETUP_NODE_INPUTS].join(", ")} are allowed, so a mirror, registry, token or cache input is forbidden`);
      continue;
    }
    if (entry.key === "check-latest" && unquoteYamlScalar(entry.value).toLowerCase() !== "false") {
      failures.push(`${path}:${lineNumber}: actions/setup-node must not set check-latest to anything but false`);
    }
    if (entry.key === "architecture" && !SETUP_NODE_ARCHITECTURES.has(unquoteYamlScalar(entry.value))) {
      failures.push(`${path}:${lineNumber}: actions/setup-node architecture must be one of ${[...SETUP_NODE_ARCHITECTURES].join(", ")}`);
    }
  }
  return failures;
}

export function inspectWorkflowSource(source, { path = "workflow.yml" } = {}) {
  const failures = [];
  const lines = String(source).split(/\r?\n/u);
  const flow = inspectFlowStylePolicyKeys(lines, path);
  failures.push(...flow.failures);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const entry = parseYamlKeyValue(lines[index]);
    if (entry === null) continue;
    const value = unquoteYamlScalar(entry.value);
    const flowKey = `${lineNumber}:${entry.key}`;
    if (FLOW_POLICY_KEYS.has(entry.key) && flow.keys.has(flowKey)) continue;

    if (entry.key === "uses") {
      if (value.startsWith("./")) continue;
      const at = value.lastIndexOf("@");
      const ref = at < 1 ? "" : value.slice(at + 1);
      if (!FULL_COMMIT_SHA.test(ref)) {
        failures.push(`${path}:${lineNumber}: action reference must use a full commit SHA`);
      }
      if (value.startsWith("actions/checkout@")) {
        const stepIndent = stepParentIndent(lines, index, entry.indent);
        const persist = checkoutPersistenceEntry(lines, index, stepIndent);
        if (persist === undefined) {
          failures.push(`${path}:${lineNumber}: actions/checkout must set persist-credentials explicitly to false`);
        }
      }
      if (value.startsWith("actions/setup-node@")) {
        const stepIndent = stepParentIndent(lines, index, entry.indent);
        failures.push(...setupNodeFailures(stepWithEntries(lines, index, stepIndent), { path, lineNumber }));
      }
    }
    if (entry.key === "pull_request_target") {
      failures.push(`${path}:${lineNumber}: pull_request_target is forbidden`);
    }
    if (entry.key === "persist-credentials" && value.toLowerCase() !== "false") {
      failures.push(`${path}:${lineNumber}: checkout credentials must not persist; set explicitly to false`);
    }
    if (entry.key === "runs-on") {
      const runnerLines = [{ line: value, lineNumber }, ...indentedBlock(lines, index, entry.indent)];
      const labels = runnerLabels(value, runnerLines.slice(1));
      const selfHosted = runnerLines.find(({ line }) => /\bself-hosted\b/iu.test(line));
      const invalidLabel = labels.find((label) => !GITHUB_HOSTED_RUNNER_LABELS.has(label));
      if (selfHosted !== undefined) {
        failures.push(`${path}:${selfHosted.lineNumber}: persistent self-hosted release runners are forbidden`);
      } else if (value.includes("${{")) {
        failures.push(`${path}:${lineNumber}: runner selector must be a static GitHub-hosted label`);
      } else if (invalidLabel !== undefined || labels.length !== 1) {
        failures.push(`${path}:${lineNumber}: runner selector must be one static ubuntu-/windows-/macos- GitHub-hosted label`);
      }
    }
  }

  return Object.freeze(failures);
}

export async function checkReleaseWorkflowPolicy({
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  const root = resolve(repositoryRoot);
  const failures = [];
  const files = await workflowFiles(root);
  for (const file of files) {
    const path = normalizePath(relative(root, file));
    failures.push(...inspectWorkflowSource(await readFile(file, "utf8"), { path }));
  }
  if (failures.length > 0) {
    const error = new Error(`GitHub workflow policy failed:\n${failures.join("\n")}`);
    error.code = "RELEASE_WORKFLOW_POLICY_FAILED";
    error.failures = Object.freeze([...failures]);
    throw error;
  }
  return Object.freeze({ files: Object.freeze(files.map((file) =>
    normalizePath(relative(root, file)))) });
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  checkReleaseWorkflowPolicy().then(({ files }) => {
    console.log(`Release workflow policy: ${files.length} files verified`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
