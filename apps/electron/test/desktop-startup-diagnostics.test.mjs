import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDesktopStartupDiagnostics,
  DESKTOP_STARTUP_DIAGNOSTIC_FILE,
  DESKTOP_STARTUP_DIAGNOSTIC_SCHEMA,
} from "../desktop-startup-diagnostics.js";
import { createDesktopSecureStorageFailure } from "../desktop-secure-storage-readiness.js";
import { shellError } from "../errors.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-startup-diagnostic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function clock(...instants) {
  let index = 0;
  return () => new Date(instants[Math.min(index++, instants.length - 1)]);
}

test("startup diagnostics persist one owner-only content-free failure record", async (t) => {
  const parent = await fixture(t);
  const rootPath = join(parent, "desktop-settings");
  const diagnostics = createDesktopStartupDiagnostics({
    app: { getVersion: () => "0.1.24" },
    rootPath,
    platform: "darwin",
    architecture: "arm64",
    now: clock("2026-09-22T14:00:00.000Z", "2026-09-22T14:00:01.000Z"),
  });

  assert.equal(await diagnostics.start(), true);
  diagnostics.mark("native_handover");
  assert.equal(await diagnostics.fail(createDesktopSecureStorageFailure("locked")), true);

  const path = join(rootPath, DESKTOP_STARTUP_DIAGNOSTIC_FILE);
  const value = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(value, {
    schemaVersion: DESKTOP_STARTUP_DIAGNOSTIC_SCHEMA,
    recordedAt: "2026-09-22T14:00:01.000Z",
    startedAt: "2026-09-22T14:00:00.000Z",
    phase: "native_handover",
    outcome: "failed",
    code: "secure_storage_locked",
    platform: "darwin",
    architecture: "arm64",
    version: "0.1.24",
  });
  assert.equal((await lstat(path)).mode & 0o077, 0);
  assert.equal(await diagnostics.complete(), false);
});

test("startup diagnostics overwrite an in-progress record with ready state", async (t) => {
  const parent = await fixture(t);
  const rootPath = join(parent, "desktop-settings");
  const diagnostics = createDesktopStartupDiagnostics({
    app: { getVersion: () => "0.1.24" }, rootPath,
    now: clock("2026-09-22T14:00:00.000Z", "2026-09-22T14:00:00.100Z"),
  });
  await diagnostics.start();
  diagnostics.mark("lifecycle");
  assert.equal(await diagnostics.complete(), true);
  const value = JSON.parse(await readFile(join(rootPath, DESKTOP_STARTUP_DIAGNOSTIC_FILE), "utf8"));
  assert.equal(value.outcome, "ready");
  assert.equal(value.phase, "ready");
  assert.equal(value.code, null);
});

test("startup checkpoints durably retain the last accepted phase before an interrupted launch", async (t) => {
  const parent = await fixture(t);
  const rootPath = join(parent, "desktop-settings");
  const diagnostics = createDesktopStartupDiagnostics({
    app: { getVersion: () => "0.1.24" }, rootPath,
    now: clock("2026-09-26T06:47:36.000Z", "2026-09-26T06:47:36.100Z",
      "2026-09-26T06:47:36.200Z", "2026-09-26T06:47:36.300Z"),
  });
  assert.equal(await diagnostics.start(), true);
  assert.equal(await diagnostics.checkpoint("native_handover"), true);
  assert.equal(await diagnostics.checkpoint("private path"), false);
  const path = join(rootPath, DESKTOP_STARTUP_DIAGNOSTIC_FILE);
  const value = JSON.parse(await readFile(path, "utf8"));
  assert.equal(value.phase, "native_handover");
  assert.equal(value.outcome, "in_progress");
  assert.equal(value.code, null);
  assert.equal(value.recordedAt, "2026-09-26T06:47:36.200Z");
  assert.equal((await lstat(path)).mode & 0o077, 0);
  assert.equal(await diagnostics.stop("native_handover_blocked"), true);
  assert.equal(await diagnostics.checkpoint("ready"), false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    ...value,
    recordedAt: "2026-09-26T06:47:36.300Z",
    outcome: "stopped",
    code: "native_handover_blocked",
  });
});

test("startup diagnostics retain only allowlisted error and stop codes", async (t) => {
  const parent = await fixture(t);
  const firstRoot = join(parent, "first");
  const first = createDesktopStartupDiagnostics({
    app: { getVersion: () => "0.1.24" }, rootPath: firstRoot,
  });
  await first.start();
  first.mark("settings");
  await first.fail(shellError("desktop_codex_roots_invalid"));
  assert.equal(JSON.parse(await readFile(join(firstRoot,
    DESKTOP_STARTUP_DIAGNOSTIC_FILE), "utf8")).code,
  "electron_shell_desktop_codex_roots_invalid");

  const secondRoot = join(parent, "second");
  const second = createDesktopStartupDiagnostics({
    app: { getVersion: () => "private path must not persist" }, rootPath: secondRoot,
  });
  await second.start();
  second.mark("not-a-real-phase");
  await second.stop("untrusted-value");
  const value = JSON.parse(await readFile(join(secondRoot,
    DESKTOP_STARTUP_DIAGNOSTIC_FILE), "utf8"));
  assert.equal(value.phase, "bootstrap");
  assert.equal(value.code, "startup_stopped");
  assert.equal(value.version, "unknown");
});

test("startup diagnostics refuse a symlinked root without affecting startup", async (t) => {
  const parent = await fixture(t);
  const target = join(parent, "target");
  const linked = join(parent, "linked");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, linked);
  const diagnostics = createDesktopStartupDiagnostics({
    app: { getVersion: () => "0.1.24" }, rootPath: linked,
  });
  assert.equal(await diagnostics.start(), false);
  diagnostics.mark("settings");
  assert.equal(await diagnostics.fail(new Error("private material")), false);
  await assert.rejects(readFile(join(target, DESKTOP_STARTUP_DIAGNOSTIC_FILE)),
    { code: "ENOENT" });
});

test("startup diagnostics remain optional when the clock or filesystem is unavailable", async (t) => {
  const parent = await fixture(t);
  const diagnostics = createDesktopStartupDiagnostics({
    app: { getVersion: () => "0.1.24" },
    rootPath: join(parent, "desktop-settings"),
    now() { throw new Error("synthetic clock failure"); },
  });
  assert.equal(await diagnostics.start(), false);
  assert.equal(await diagnostics.fail(new Error("private material")), false);
});
