import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inventoryClaudeDesktopSources } from "../src/claude-desktop-source-inventory.js";
import { detectClaudeDesktopRetention } from "../src/claude-desktop-retention.js";

const SECRET = Buffer.alloc(32, 29);
const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/claude-desktop-phase0/", import.meta.url));

async function json(name) {
  return JSON.parse(await readFile(join(FIXTURE_ROOT, name), "utf8"));
}

async function materializeCorpus() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-desktop-inventory-"));
  await chmod(root, 0o700);
  const metadataDirectory = join(root, "metadata");
  const projectsDirectory = join(root, "projects");
  const marker = join(root, ".last-cleanup");
  await mkdir(metadataDirectory, { mode: 0o700 });
  await mkdir(projectsDirectory, { mode: 0o700 });
  const fixture = await json("desktop-corpus-v1.json");
  for (const item of fixture.metadata) {
    await writeFile(join(metadataDirectory, item.filename), `${JSON.stringify(item.value)}\n`, { mode: 0o600 });
  }
  for (const item of fixture.transcripts) {
    const path = join(projectsDirectory, item.relativePath);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, item.rows.length === 0 ? "" : `${item.rows.map(JSON.stringify).join("\n")}\n`, {
      mode: 0o600,
    });
  }
  await writeFile(marker, "2026-08-16T17:12:48.034Z\n", { mode: 0o600 });
  return { root, metadataDirectory, projectsDirectory, marker, fixture };
}

test("Phase 0 fixture manifest freezes every content-minimized source shape", async () => {
  const manifest = await json("manifest-v1.json");
  const names = (await readdir(FIXTURE_ROOT))
    .filter((name) => name !== "manifest-v1.json")
    .sort();
  assert.deepEqual(manifest.files.map((item) => item.name), names);
  for (const item of manifest.files) {
    const digest = createHash("sha256")
      .update(await readFile(join(FIXTURE_ROOT, item.name)))
      .digest("hex");
    assert.equal(digest, item.sha256, item.name);
  }
  const serialized = JSON.stringify(await Promise.all(names.map(json)));
  assert.equal(serialized.includes("/Users/"), false);
  assert.equal(serialized.includes("PRIVATE_"), false);
  assert.equal(serialized.includes("sk-ant-"), false);
});

test("Desktop inventory selects a parent and its bounded children without exposing identity", async () => {
  const value = await materializeCorpus();
  try {
    const inventory = await inventoryClaudeDesktopSources({
      metadataDirectory: value.metadataDirectory,
      projectsDirectory: value.projectsDirectory,
      cleanupMarkerPath: value.marker,
      secret: SECRET,
    });
    assert.equal(inventory.status, "complete");
    assert.equal(inventory.metadataFileCount, 5);
    assert.equal(inventory.topLevelTranscriptCount, 2);
    assert.equal(inventory.nestedTranscriptCount, 3);
    assert.equal(inventory.selectedChildTranscriptCount, 1);
    assert.equal(inventory.unselectedChildTranscriptCount, 1);
    assert.equal(inventory.orphanTranscriptCount, 1);
    assert.deepEqual(inventory.statusCounts, {
      identifier_unavailable: 1,
      parent_missing: 1,
      selected: 1,
      unsupported_surface: 1,
    });
    assert.equal(Object.hasOwn(inventory, "privatePlan"), false);
    const serialized = JSON.stringify(inventory);
    for (const item of value.fixture.metadata) {
      assert.equal(serialized.includes(item.value.sessionId ?? "not-present"), false);
      if (item.value.cliSessionId) assert.equal(serialized.includes(item.value.cliSessionId), false);
    }
    assert.equal(serialized.includes(value.root), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Desktop inventory marks a generation partial when cleanup races discovery", async () => {
  const value = await materializeCorpus();
  try {
    const inventory = await inventoryClaudeDesktopSources({
      metadataDirectory: value.metadataDirectory,
      projectsDirectory: value.projectsDirectory,
      cleanupMarkerPath: value.marker,
      secret: SECRET,
      afterEnumeration: async () => {
        await writeFile(value.marker, "2026-08-16T18:00:00.000Z\n", { mode: 0o600 });
      },
    });
    assert.equal(inventory.status, "partial");
    assert.equal(inventory.cleanupRaced, true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("retention detection follows scope precedence and emits only the effective setting", async () => {
  const fixture = await json("retention-cases-v1.json");
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-retention-"));
  await chmod(root, 0o700);
  try {
    for (const [index, item] of fixture.cases.entries()) {
      const caseRoot = join(root, String(index));
      const project = join(caseRoot, "project");
      const userRoot = join(caseRoot, ".claude");
      const managedPath = join(caseRoot, "managed-settings.json");
      await mkdir(join(project, ".claude"), { recursive: true, mode: 0o700 });
      await mkdir(userRoot, { recursive: true, mode: 0o700 });
      const settings = (days) => JSON.stringify({
        cleanupPeriodDays: days,
        unrelatedSecretCanary: "must-not-escape",
      });
      if (item.user !== undefined) await writeFile(join(userRoot, "settings.json"), settings(item.user), { mode: 0o600 });
      if (item.project !== undefined) await writeFile(join(project, ".claude", "settings.json"), settings(item.project), { mode: 0o600 });
      if (item.local !== undefined) await writeFile(join(project, ".claude", "settings.local.json"), settings(item.local), { mode: 0o600 });
      if (item.managed !== undefined) await writeFile(managedPath, settings(item.managed), { mode: 0o600 });
      const result = await detectClaudeDesktopRetention({
        homeDirectory: caseRoot,
        projectDirectory: project,
        managedSettingsPaths: [managedPath],
      });
      assert.equal(result.effectiveDays, item.expectedDays, item.name);
      assert.equal(result.effectiveScope, item.expectedScope, item.name);
      if (item.invalidScope) assert.deepEqual(result.invalidScopes, [item.invalidScope]);
      assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retention detection respects a custom CLAUDE_CONFIG_DIR and keeps guidance read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-config-root-"));
  await chmod(root, 0o700);
  try {
    const config = join(root, "custom-config");
    const project = join(root, "project");
    await mkdir(config, { recursive: true, mode: 0o700 });
    await mkdir(project, { recursive: true, mode: 0o700 });
    await writeFile(join(config, "settings.json"), JSON.stringify({ cleanupPeriodDays: 90 }), { mode: 0o600 });
    const result = await detectClaudeDesktopRetention({
      homeDirectory: root,
      projectDirectory: project,
      claudeConfigDirectory: config,
      managedSettingsPaths: [],
    });
    assert.equal(result.effectiveDays, 90);
    assert.equal(result.effectiveScope, "user");
    assert.equal(result.configRootKind, "custom");
    assert.equal(result.guidance.changesFutureCleanupOnly, true);
    assert.equal(result.guidance.restoresDeletedHistory, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
