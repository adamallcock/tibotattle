import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  mkdir,
  open,
  readdir,
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
  writeLocalLegacyReport,
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

test("canonical report writes replace atomically, remain owner-only, and clean their exact staging file", async () => {
  const root = await fixtureRoot();
  const destination = localLegacyReportPath(root, "artifact.json");
  const reportDirectory = join(root, ".usage-monitor", "legacy-reports");
  try {
    assert.equal(await writeLocalLegacyReport(root, "artifact.json", "first\n"), destination);
    assert.equal(await readFile(destination, "utf8"), "first\n");
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(reportDirectory), ["artifact.json"]);

    assert.equal(await writeLocalLegacyReport(root, "artifact.json", "second\n"), destination);
    assert.equal(await readFile(destination, "utf8"), "second\n");
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(reportDirectory), ["artifact.json"]);
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
    await assert.rejects(
      writeLocalLegacyReport(root, "artifact.json", "must not publish\n"),
      { code: "unsafe_report_path" },
    );
    assert.equal(await readFile(outsideSecret, "utf8"), "must remain private\n");

    await rm(join(root, ".usage-monitor"), { force: true, recursive: true });
    await symlink(outside, join(root, ".usage-monitor"));
    await assert.rejects(
      resolveLocalLegacyReportReadPath(root, "artifact.json"),
      { code: "unsafe_report_path" },
    );
    await assert.rejects(ensureLocalLegacyReportDirectory(root), { code: "unsafe_report_path" });
    await assert.rejects(
      writeLocalLegacyReport(root, "artifact.json", "must not publish\n"),
      { code: "unsafe_report_path" },
    );
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

// The migration read pulls bytes through FileHandle#read, and FileHandle
// instances share one prototype per process, so wrapping that method is a
// deterministic seam: an append awaited inside a chosen read call is
// guaranteed to interleave with the descriptor read. A timer racing the
// inspection (the previous simulation) could miss the whole read window under
// CPU load, because a page-cached 16 MiB read finishes in a few milliseconds
// while the first 1 ms tick plus the append's threadpool round-trips can land
// later. If a refactor stops routing the migration read through
// FileHandle#read, the seam counts zero growths and the tests fail loudly.
async function fileHandlePrototypeFor(path) {
  const handle = await open(path, "r");
  try {
    return Object.getPrototypeOf(handle);
  } finally {
    await handle.close();
  }
}

test("migration fails closed when a validated legacy source grows during its descriptor read", async (t) => {
  const root = await fixtureRoot();
  const source = join(root, "artifact.json");
  const maximumBytes = 16 * 1024 * 1024;
  try {
    await writeFile(source, Buffer.alloc(maximumBytes, 0x61), { mode: 0o600 });
    // Growing the file inside the first bounded read pins the append after
    // the open-descriptor validation and before the overflow probe.
    const fileHandlePrototype = await fileHandlePrototypeFor(source);
    const realRead = fileHandlePrototype.read;
    let growths = 0;
    t.mock.method(fileHandlePrototype, "read", async function interceptedRead(...args) {
      if (growths === 0) {
        growths += 1;
        await appendFile(source, Buffer.from("x"));
      }
      return realRead.apply(this, args);
    });
    const result = await inspectLocalLegacyReportMigration({
      files: ["artifact.json"],
      root,
    });
    assert.equal(growths, 1, "the growth seam never saw a descriptor read");
    assert.equal(result.entries[0].state, "source_changed");
    assert.equal(result.status, "nothing_to_migrate");
    await assert.rejects(readFile(localLegacyReportPath(root, "artifact.json")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("migration fails closed when a validated legacy source grows between the overflow probe and the descriptor recheck", async (t) => {
  const root = await fixtureRoot();
  const source = join(root, "artifact.json");
  const maximumBytes = 16 * 1024 * 1024;
  try {
    await writeFile(source, Buffer.alloc(maximumBytes, 0x61), { mode: 0o600 });
    // The overflow probe is the only read issued at the validated size, so an
    // append awaited right after it lands in the last window a read can no
    // longer see; only the closing descriptor recheck can refuse it.
    const fileHandlePrototype = await fileHandlePrototypeFor(source);
    const realRead = fileHandlePrototype.read;
    let growths = 0;
    t.mock.method(fileHandlePrototype, "read", async function interceptedRead(...args) {
      const read = await realRead.apply(this, args);
      const [, , length, position] = args;
      if (growths === 0 && length === 1 && position === maximumBytes) {
        growths += 1;
        await appendFile(source, Buffer.from("x"));
      }
      return read;
    });
    const result = await inspectLocalLegacyReportMigration({
      files: ["artifact.json"],
      root,
    });
    assert.equal(growths, 1, "the growth seam never saw the overflow probe");
    assert.equal(result.entries[0].state, "source_changed");
    assert.equal(result.status, "nothing_to_migrate");
    await assert.rejects(readFile(localLegacyReportPath(root, "artifact.json")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
