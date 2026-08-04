import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
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
