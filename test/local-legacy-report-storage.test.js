import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureLocalLegacyReportDirectory,
  inspectLocalLegacyReportMigration,
  localLegacyReportPath,
  migrateLocalLegacyReports,
  resolveLocalLegacyReportReadPath,
} from "../src/local-legacy-report-storage.js";

async function fixtureRoot() {
  return mkdtemp(join(tmpdir(), "usage-monitor-legacy-report-storage-"));
}

test("legacy report migration previews exact hashes without mutating files", async () => {
  const root = await fixtureRoot();
  const source = join(root, "artifact.json");
  try {
    await writeFile(source, "{\"private\":true}\n", { mode: 0o600 });
    const result = await inspectLocalLegacyReportMigration({
      files: ["artifact.json"],
      root,
    });
    assert.equal(result.status, "ready");
    assert.equal(result.entries[0].state, "migratable");
    assert.equal(result.entries[0].bytes, 17);
    assert.match(result.entries[0].sha256, /^[a-f0-9]{64}$/u);
    assert.equal(await readFile(source, "utf8"), "{\"private\":true}\n");
    await assert.rejects(readFile(localLegacyReportPath(root, "artifact.json")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("legacy report migration moves known files into an owner-only directory without copying", async () => {
  const root = await fixtureRoot();
  const source = join(root, "artifact.json");
  const destination = localLegacyReportPath(root, "artifact.json");
  try {
    await writeFile(source, "{\"private\":true}\n", { mode: 0o644 });
    const result = await migrateLocalLegacyReports({
      apply: true,
      files: ["artifact.json"],
      root,
    });
    assert.equal(result.status, "migrated");
    assert.equal(result.entries[0].state, "migrated");
    assert.equal(await readFile(destination, "utf8"), "{\"private\":true}\n");
    await assert.rejects(readFile(source));
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, ".usage-monitor", "legacy-reports"))).mode & 0o777, 0o700);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("migration refuses to overwrite an existing private report", async () => {
  const root = await fixtureRoot();
  const source = join(root, "artifact.json");
  const destination = localLegacyReportPath(root, "artifact.json");
  try {
    await mkdir(join(root, ".usage-monitor", "legacy-reports"), { recursive: true });
    await writeFile(source, "{\"root\":true}\n", { mode: 0o600 });
    await writeFile(destination, "{\"canonical\":true}\n", { mode: 0o600 });
    const result = await migrateLocalLegacyReports({
      apply: true,
      files: ["artifact.json"],
      root,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.entries[0].state, "destination_conflict");
    assert.equal(await readFile(source, "utf8"), "{\"root\":true}\n");
    assert.equal(await readFile(destination, "utf8"), "{\"canonical\":true}\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("read resolution prefers the canonical report but preserves old root reports as a compatibility fallback", async () => {
  const root = await fixtureRoot();
  const source = join(root, "artifact.json");
  const destination = localLegacyReportPath(root, "artifact.json");
  try {
    await writeFile(source, "{\"root\":true}\n", { mode: 0o600 });
    assert.equal(await resolveLocalLegacyReportReadPath(root, "artifact.json"), source);
    await mkdir(join(root, ".usage-monitor", "legacy-reports"), { recursive: true });
    await writeFile(destination, "{\"canonical\":true}\n", { mode: 0o600 });
    assert.equal(await resolveLocalLegacyReportReadPath(root, "artifact.json"), destination);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("canonical final and ancestor symlinks are rejected before a report read or write", async () => {
  const root = await fixtureRoot();
  const outside = await fixtureRoot();
  const outsideSecret = join(outside, "secret.json");
  const canonicalDirectory = join(root, ".usage-monitor", "legacy-reports");
  const canonicalPath = localLegacyReportPath(root, "artifact.json");
  try {
    await writeFile(outsideSecret, "must remain private\n", { mode: 0o600 });
    await mkdir(canonicalDirectory, { recursive: true });
    await symlink(outsideSecret, canonicalPath);
    await assert.rejects(
      resolveLocalLegacyReportReadPath(root, "artifact.json"),
      { code: "unsafe_report_path" },
    );
    await assert.rejects(ensureLocalLegacyReportDirectory(root), { code: "unsafe_report_path" });
    assert.equal(await readFile(outsideSecret, "utf8"), "must remain private\n");

    await rm(join(root, ".usage-monitor"), { force: true, recursive: true });
    await symlink(outside, join(root, ".usage-monitor"));
    await assert.rejects(
      resolveLocalLegacyReportReadPath(root, "artifact.json"),
      { code: "unsafe_report_path" },
    );
    await assert.rejects(ensureLocalLegacyReportDirectory(root), { code: "unsafe_report_path" });
    assert.equal(await readFile(outsideSecret, "utf8"), "must remain private\n");
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("legacy source symlinks are blocked instead of being migrated from outside the owner tree", async () => {
  const root = await fixtureRoot();
  const outside = await fixtureRoot();
  const outsideSecret = join(outside, "secret.json");
  try {
    await writeFile(outsideSecret, "outside-only\n", { mode: 0o600 });
    await symlink(outsideSecret, join(root, "artifact.json"));
    const result = await migrateLocalLegacyReports({
      apply: true,
      files: ["artifact.json"],
      root,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.entries[0].state, "unsafe_source");
    await assert.rejects(readFile(localLegacyReportPath(root, "artifact.json")));
    assert.equal(await readFile(outsideSecret, "utf8"), "outside-only\n");
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("migration fails closed when a validated legacy source grows during its descriptor read", async () => {
  const root = await fixtureRoot();
  const source = join(root, "artifact.json");
  const maximumBytes = 16 * 1024 * 1024;
  let growthTimer;
  let growthWrites = Promise.resolve();
  try {
    await writeFile(source, Buffer.alloc(maximumBytes, 0x61), { mode: 0o600 });
    growthTimer = setInterval(() => {
      growthWrites = growthWrites.then(() => appendFile(source, Buffer.from("x")));
    }, 1);
    const result = await inspectLocalLegacyReportMigration({
      files: ["artifact.json"],
      root,
    });
    clearInterval(growthTimer);
    growthTimer = undefined;
    await growthWrites;
    assert.notEqual(result.entries[0].state, "migratable");
    assert.ok(["source_changed", "source_too_large"].includes(result.entries[0].state));
    assert.equal(result.status, "nothing_to_migrate");
    await assert.rejects(readFile(localLegacyReportPath(root, "artifact.json")));
  } finally {
    if (growthTimer) clearInterval(growthTimer);
    await rm(root, { force: true, recursive: true });
  }
});
