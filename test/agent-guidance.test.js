import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  ARCHITECTURE_APPLICATION_ROOTS,
} from "../scripts/lib/application-layout-policy.mjs";
import { ROOT_WORKSPACE_POLICY } from "../scripts/check-root-workspace-hygiene.mjs";

const execFile = promisify(execFileCallback);

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const MAX_GUIDANCE_LINES = 200;
// Codex's current default project-doc ceiling is 32 KiB. Retain 25% headroom
// for separators and future narrow rules rather than treating truncation as a
// usable budget.
const MAX_INSTRUCTION_CHAIN_BYTES = 24 * 1024;

async function readRepositoryFile(path) {
  return readFile(join(REPOSITORY_ROOT, path), "utf8");
}

async function discoverGuidancePaths() {
  const { stdout } = await execFile("git", [
    "-C",
    REPOSITORY_ROOT,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ":(glob)**/AGENTS.md",
  ], { encoding: "utf8" });
  return stdout.split("\0").filter(Boolean).sort();
}

async function directSubdirectories(path) {
  const entries = await readdir(join(REPOSITORY_ROOT, path), {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => posix.join(path, entry.name))
    .sort();
}

function instructionChain(path, guidancePaths) {
  const guidanceSet = new Set(guidancePaths);
  const parts = posix.dirname(path).split("/");
  const chain = ["AGENTS.md"];
  for (let length = 1; length <= parts.length; length += 1) {
    const candidate = posix.join(...parts.slice(0, length), "AGENTS.md");
    if (guidanceSet.has(candidate)) chain.push(candidate);
  }
  return chain;
}

function routingDestinations(rootGuidance) {
  return rootGuidance.split("\n")
    .filter((line) => /^\|[^-]/u.test(line))
    .map((line) => line.split("|")[2]?.trim() ?? "");
}

function lineCount(value) {
  return value.replace(/\n+$/u, "").split("\n").length;
}

test("agent guidance has one canonical Claude-compatible root", async () => {
  const [rootGuidance, claudeBridge, guidancePaths] = await Promise.all([
    readRepositoryFile("AGENTS.md"),
    readRepositoryFile("CLAUDE.md"),
    discoverGuidancePaths(),
  ]);

  assert.equal(claudeBridge.trim(), "@AGENTS.md");
  for (const path of ["AGENTS.md", "CLAUDE.md"]) {
    assert.ok(
      ROOT_WORKSPACE_POLICY.files.includes(path),
      `root workspace policy does not allow ${path}`,
    );
  }
  assert.ok(
    lineCount(rootGuidance) <= MAX_GUIDANCE_LINES,
    `AGENTS.md exceeds ${MAX_GUIDANCE_LINES} lines`,
  );

  assert.ok(guidancePaths.includes("AGENTS.md"));
  const guidanceSet = new Set(guidancePaths);
  const destinations = routingDestinations(rootGuidance);
  const scopedGuidancePaths = guidancePaths.filter((path) => path !== "AGENTS.md");
  for (const path of scopedGuidancePaths) {
    assert.ok(
      destinations.some((destination) => destination.includes(`\`${path}\``)),
      `the progressive-disclosure table does not route agents to ${path}`,
    );
  }

  const referencedGuidance = destinations.flatMap((destination) =>
    [...destination.matchAll(/`([^`]*AGENTS\.md)`/gu)]
      .map((match) => match[1]));
  for (const path of referencedGuidance) {
    assert.ok(guidanceSet.has(path), `routing table references missing ${path}`);
  }

  const requiredScopedDirectories = new Set([
    ...ARCHITECTURE_APPLICATION_ROOTS,
    ...await directSubdirectories("apps"),
    ...await directSubdirectories("packages"),
  ]);
  for (const directory of [...requiredScopedDirectories].sort()) {
    const expected = posix.join(directory, "AGENTS.md");
    assert.ok(
      guidanceSet.has(expected),
      `${directory} has no scoped AGENTS.md`,
    );
  }
});

test("scoped guidance remains concise and within the project-doc budget", async () => {
  const guidancePaths = await discoverGuidancePaths();
  const guidance = new Map(await Promise.all(guidancePaths.map(async (path) => [
    path,
    await readRepositoryFile(path),
  ])));

  for (const [path, contents] of guidance) {
    assert.ok(
      lineCount(contents) <= MAX_GUIDANCE_LINES,
      `${path} exceeds ${MAX_GUIDANCE_LINES} lines`,
    );
  }

  for (const path of guidancePaths.filter((entry) => entry !== "AGENTS.md")) {
    const chain = instructionChain(path, guidancePaths);
    const combined = chain.map((entry) => guidance.get(entry)).join("\n\n");
    const combinedBytes = Buffer.byteLength(combined, "utf8");
    assert.ok(
      combinedBytes <= MAX_INSTRUCTION_CHAIN_BYTES,
      `${chain.join(" -> ")} uses ${combinedBytes} bytes; `
        + `budget is ${MAX_INSTRUCTION_CHAIN_BYTES}`,
    );
  }
});
