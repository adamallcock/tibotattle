import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectClaudeDesktopShadowReadiness,
} from "../src/claude-desktop-shadow-readiness.js";

async function materialize() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-readiness-"));
  await chmod(root, 0o700);
  const support = join(root, "Library", "Application Support", "Claude");
  const metadata = join(support, "claude-code-sessions");
  const projects = join(root, ".claude", "projects");
  await mkdir(metadata, { recursive: true, mode: 0o700 });
  await mkdir(projects, { recursive: true, mode: 0o700 });
  await writeFile(join(support, "plan-usage-history.json"), "{}", { mode: 0o600 });
  return { root, support, metadata, projects };
}

test("shadow readiness is content-free, ready, and disabled by default", async () => {
  const fixture = await materialize();
  try {
    const value = await inspectClaudeDesktopShadowReadiness({
      homeDirectory: fixture.root,
      projectDirectory: fixture.root,
      platform: "darwin",
    });
    assert.equal(value.status, "ready");
    assert.equal(value.shadowMode, "disabled");
    assert.equal(value.usageSources.metadata.status, "available");
    assert.equal(value.usageSources.projects.status, "available");
    assert.equal(value.quotaSource.status, "available");
    assert.equal(value.retention.effectiveDays, 30);
    assert.equal(value.retention.canOfferNinetyDayInstructions, true);
    assert.equal(value.includesContent, false);
    assert.equal(value.includesPaths, false);
    assert.equal(value.includesIdentifiers, false);
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes(fixture.root), false);
    assert.equal(serialized.includes("plan-usage-history.json"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unsafe or missing usage roots block shadow readiness without leaking them", async () => {
  const fixture = await materialize();
  try {
    await chmod(fixture.projects, 0o777);
    await rm(fixture.metadata, { recursive: true, force: true });
    const value = await inspectClaudeDesktopShadowReadiness({
      homeDirectory: fixture.root,
      projectDirectory: fixture.root,
      platform: "darwin",
      shadowEnabled: true,
    });
    assert.equal(value.status, "blocked");
    assert.equal(value.shadowMode, "enabled");
    assert.equal(value.usageSources.metadata.status, "missing");
    assert.equal(value.usageSources.projects.status, "unsafe");
    assert.equal(JSON.stringify(value).includes(fixture.root), false);
  } finally {
    await chmod(fixture.projects, 0o700).catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing independent quota evidence is partial rather than falsely ready", async () => {
  const fixture = await materialize();
  try {
    await rm(join(fixture.support, "plan-usage-history.json"));
    const value = await inspectClaudeDesktopShadowReadiness({
      homeDirectory: fixture.root,
      projectDirectory: fixture.root,
      platform: "darwin",
    });
    assert.equal(value.status, "partial");
    assert.equal(value.usageSources.metadata.status, "available");
    assert.equal(value.usageSources.projects.status, "available");
    assert.equal(value.quotaSource.status, "missing");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unsupported platforms and malformed configuration fail closed", async () => {
  const value = await inspectClaudeDesktopShadowReadiness({
    homeDirectory: "/tmp",
    projectDirectory: "/tmp",
    platform: "linux",
  });
  assert.equal(value.status, "blocked");
  assert.equal(value.shadowMode, "disabled");
  assert.deepEqual(value.usageSources, {
    metadata: { status: "missing" },
    projects: { status: "missing" },
  });
  await assert.rejects(
    inspectClaudeDesktopShadowReadiness({ homeDirectory: "relative" }),
    /normalized absolute path/u,
  );
});
