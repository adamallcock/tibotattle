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

test("agent guidance requires current documentation and removal of obsolete guidance", async () => {
  const [rootGuidance, documentationGuidance] = await Promise.all([
    readRepositoryFile("AGENTS.md"),
    readRepositoryFile("docs/AGENTS.md"),
  ]);

  assert.match(
    rootGuidance,
    /current READMEs[\s\S]*same change[\s\S]*Git-remove[\s\S]*obsolete docs/u,
  );
  assert.match(
    rootGuidance,
    /old path and basename[\s\S]*security allowlists/u,
  );
  assert.match(documentationGuidance, /Git history is the default archive/u);
  assert.match(
    documentationGuidance,
    /Retain historical evidence only when its audit, recovery, or release value is[\s\S]*enduring/u,
  );
  assert.match(
    documentationGuidance,
    /root README, component READMEs, public docs,[\s\S]*every stale statement/u,
  );
  assert.match(
    documentationGuidance,
    /old[\s\S]*path and basename[\s\S]*ignore files[\s\S]*security allowlists/u,
  );
  assert.match(
    documentationGuidance,
    /`current`, `canonical`, `maintained`, and[\s\S]*`operational` status[\s\S]*invalid unless the document is indexed/u,
  );
  assert.match(documentationGuidance, /npm run docs:check/u);
});

test("agent guidance preserves owner erasure and restore after self-service retirement", async () => {
  const [root, worker, local, web, docs] = await Promise.all([
    readRepositoryFile("AGENTS.md"),
    readRepositoryFile("apps/worker/AGENTS.md"),
    readRepositoryFile("apps/local/AGENTS.md"),
    readRepositoryFile("apps/web/AGENTS.md"),
    readRepositoryFile("docs/AGENTS.md"),
  ]);
  assert.match(root, /hosted erasure is owner-only/u);
  for (const marker of [
    "404 NOT_FOUND",
    "participantDeletion: false",
    "deletionSafeRestoreReplay: true",
    "POST /api/v1/admin/action",
    "run_maintenance",
    "participantErasure",
    "Access-owner and CSRF",
    "digest-only",
  ]) {
    assert.ok(worker.includes(marker), `Worker guidance retains ${marker}`);
  }
  assert.match(local, /Do not relay retired participant deletion or private owner-erasure requests/u);
  assert.match(local, /`device_disconnected` before revocation or\s+credential cleanup/u);
  assert.match(local, /pause across restart/u);
  assert.match(worker, /`--owner-access-file` before enrollment or other writes/u);
  assert.match(web, /confirmed \*\*Disconnect this Mac\*\*/u);
  assert.match(docs, /does not retire owner erasure, privacy-request\s+handling, retention disclosures, or deletion-safe restore/u);
});

test("agent guidance treats unexpected Keychain prompts as a release blocker without weakening security", async () => {
  const [root, native, scripts, runbook] = await Promise.all([
    readRepositoryFile("AGENTS.md"),
    readRepositoryFile("apps/macos/AGENTS.md"),
    readRepositoryFile("scripts/AGENTS.md"),
    readRepositoryFile("docs/runbooks/macos-stable-release-runbook.md"),
  ]);

  assert.match(root, /Unexpected Keychain security prompts block release/u);
  assert.match(root, /never weaken protection to suppress prompts/u);
  assert.match(native, /Disable Keychain interaction for startup, refresh, background work/u);
  assert.match(native, /bounded silent retries/u);
  assert.match(native, /signing identity and designated\s+requirement/u);
  assert.match(native, /deliberate approval can enable an OS\s+dialog/u);
  assert.match(native, /Cancel must be the default/u);
  assert.match(native, /denial\/cancellation preserve credentials\s+and history/u);
  assert.match(native, /Never broaden ACLs, entitlements, or access groups/u);
  assert.match(native, /same-identity upgrades with exact signed artifacts/u);
  assert.match(native, /prompts block dogfood replacement and public release/u);
  assert.match(native, /`--prepare-candidate` flag continues into signing and\s+notarization/u);
  assert.match(scripts, /never automate prompt approval or broaden key access/u);
  assert.match(runbook, /Signing-key access on the release machine is a separate owner provisioning\s+step/u);
  assert.doesNotMatch(runbook, /choose \*\*Always Allow\*\*/u);
});

test("historical Keychain prompt advice points to the prompt-free contract before its original narrative", async () => {
  const [historical, index] = await Promise.all([
    readRepositoryFile("docs/design/2026-08-19-first-pairing-keychain-prompt.md"),
    readRepositoryFile("docs/README.md"),
  ]);
  const boundary = historical.split("## Original investigation and implementation record")[0];
  assert.match(boundary, /^status: superseded$/mu);
  assert.match(boundary, /0\.1\.13 build 1015/u);
  assert.match(boundary, /It is not current product or release guidance/u);
  assert.match(boundary, /Automatic operation must be\s+noninteractive/u);
  assert.match(boundary, /Cancel as the default/u);
  assert.match(boundary, /Do not\s+follow the historical Always Allow recommendation, reset credentials/u);
  assert.match(boundary, /silent-keychain-migration\.md/u);
  assert.match(boundary, /macos-stable-release-runbook\.md#native-keychain-migration-gate/u);
  assert.match(index, /\[Silent native Keychain migration\]\(\.\/decisions\/2026-08-31-silent-keychain-migration\.md\)/u);
});
