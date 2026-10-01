import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDesktopCrashCapture,
  createDesktopCrashCaptureBackend,
  DESKTOP_CRASH_CAPTURE_FILE_NAME,
  DESKTOP_CRASH_CAPTURE_SCHEMA_VERSION,
} from "../desktop-crash-capture.js";

function fixture(stored = null) {
  let value = stored;
  const starts = [];
  const capture = createDesktopCrashCapture({
    backend: {
      load: async () => value,
      save: async (next) => { value = next; },
    },
    crashReporter: { start: (options) => starts.push(options) },
  });
  return { capture, starts, saved: () => value };
}

test("crash capture defaults off and an opt-in takes effect only at next launch", async () => {
  const first = fixture();
  assert.deepEqual(await first.capture.initialize(), {
    available: true, enabled: false, active: false,
  });
  assert.deepEqual(first.starts, []);
  assert.deepEqual(await first.capture.setEnabled(true), {
    available: true, enabled: true, active: false,
  });
  assert.deepEqual(first.starts, []);
  const next = fixture(first.saved());
  assert.deepEqual(await next.capture.initialize(), {
    available: true, enabled: true, active: true,
  });
  assert.deepEqual(next.starts, [{ uploadToServer: false }]);
  assert.deepEqual(await next.capture.setEnabled(false), {
    available: true, enabled: false, active: true,
  });
  const stopped = fixture(next.saved());
  assert.equal((await stopped.capture.initialize()).active, false);
  assert.deepEqual(stopped.starts, []);
});

test("crash capture refuses malformed preferences and failed writes", async () => {
  const malformed = fixture({
    schemaVersion: DESKTOP_CRASH_CAPTURE_SCHEMA_VERSION,
    enabled: true,
    privatePath: "/Users/private",
  });
  assert.deepEqual(await malformed.capture.initialize(), {
    available: false, enabled: false, active: false,
  });
  assert.deepEqual(malformed.starts, []);
  assert.deepEqual(await malformed.capture.setEnabled(true), {
    available: false, enabled: false, active: false,
  });
  const failedWrite = createDesktopCrashCapture({
    backend: { load: async () => null, save: async () => { throw new Error("private path"); } },
    crashReporter: { start: () => { throw new Error("must not start"); } },
  });
  assert.equal((await failedWrite.setEnabled(true)).enabled, false);
});

test("crash capture never treats reporter failure as successful active capture", async () => {
  const capture = createDesktopCrashCapture({
    backend: { load: async () => ({
      schemaVersion: DESKTOP_CRASH_CAPTURE_SCHEMA_VERSION, enabled: true,
    }), save: async () => {} },
    crashReporter: { start: () => { throw new Error("private native failure"); } },
  });
  assert.deepEqual(await capture.initialize(), {
    available: true, enabled: true, active: false,
  });
});

test("crash capture persists only its closed owner-only preference", {
  skip: process.platform === "win32",
}, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "tibotattle-crash-capture-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rootPath = join(base, "desktop-settings");
  const backend = createDesktopCrashCaptureBackend({ rootPath, platform: "darwin" });
  const capture = createDesktopCrashCapture({
    backend, crashReporter: { start: () => { throw new Error("must not start yet"); } },
  });
  assert.equal((await capture.initialize()).enabled, false);
  assert.equal((await capture.setEnabled(true)).enabled, true);
  const path = join(rootPath, DESKTOP_CRASH_CAPTURE_FILE_NAME);
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(stored, {
    schemaVersion: DESKTOP_CRASH_CAPTURE_SCHEMA_VERSION, enabled: true,
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("a newer crash preference blocks old-app writes", async () => {
  let loads = 0;
  let saves = 0;
  const capture = createDesktopCrashCapture({
    backend: {
      load: async () => ++loads === 1 ? null : { schemaVersion: "future", enabled: true },
      save: async () => { saves += 1; },
    },
    crashReporter: { start: () => { throw new Error("must not start"); } },
  });
  assert.deepEqual(await capture.setEnabled(true), {
    available: false, enabled: false, active: false,
  });
  assert.equal(saves, 0);
});
