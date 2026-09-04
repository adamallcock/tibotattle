import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDesktopSharingBackend,
  createDesktopSharingCoordinator,
  DESKTOP_SHARING_FILE_NAME,
} from "../desktop-sharing.js";

const DAY = 86_400_000;
const START = Date.parse("2026-09-04T12:00:00.000Z");
const OPTIONS = { destinationOrigin: "https://example.test", installationState: "fresh" };
function memoryBackend() {
  let text = null;
  return { load: async () => text, save: async (value) => { text = value; }, read: () => text };
}

test("Electron explicitly selects default-on but exposes only a safe preference projection", async () => {
  const backend = memoryBackend();
  const coordinator = createDesktopSharingCoordinator({ ...OPTIONS, backend, now: () => new Date(START) });
  const value = await coordinator.initialize();
  assert.equal(value.enabled, true);
  assert.equal(value.basis, "default_on");
  assert.equal(value.transportStatus, "unavailable");
  assert.deepEqual(Object.keys(value).sort(), [
    "available", "basis", "current", "earliestActivationAt", "enabled", "nextNoticeAt",
    "nextNoticeIndex", "noticeCount", "noticeDue", "state", "transportStatus",
  ]);
  assert.equal(backend.read().includes("consentedAt"), false);
  assert.equal((await coordinator.setEnabled(false)).transportStatus, "off");
  coordinator.dispose();
  await assert.rejects(coordinator.inspect(), { code: "desktop_sharing_unavailable" });
});

test("three actual notice receipts survive restart and activate only after the final grace period", async () => {
  const backend = memoryBackend();
  let clock = START;
  const create = () => createDesktopSharingCoordinator({ ...OPTIONS, backend,
    installationState: "existing_unselected", now: () => new Date(clock) });
  let coordinator = create();
  assert.equal((await coordinator.initialize()).enabled, false);
  clock += 30 * DAY;
  assert.equal((await coordinator.inspect()).enabled, false, "time alone cannot deliver notices");
  for (let index = 1; index <= 3; index += 1) {
    assert.equal((await coordinator.inspect()).nextNoticeIndex, index);
    assert.equal((await coordinator.markNoticePresented(index)).noticeCount, index);
    coordinator.dispose();
    coordinator = create();
    assert.equal((await coordinator.initialize()).noticeCount, index);
    assert.equal((await coordinator.inspect()).enabled, false);
    if (index < 3) clock += DAY;
  }
  clock += DAY - 1;
  assert.equal((await coordinator.inspect()).enabled, false);
  clock += 1;
  const activated = await coordinator.inspect();
  assert.equal(activated.enabled, true);
  assert.equal(activated.basis, "migration_default_on");
  assert.equal(activated.nextNoticeIndex, null);
  assert.equal(activated.transportStatus, "unavailable");
});

test("either explicit choice cancels pending notices across restart", async () => {
  for (const enabled of [true, false]) {
    const backend = memoryBackend();
    let clock = START;
    const create = () => createDesktopSharingCoordinator({ ...OPTIONS, backend,
      installationState: "existing_unselected", now: () => new Date(clock) });
    let coordinator = create();
    await coordinator.initialize();
    await coordinator.markNoticePresented(1);
    await coordinator.setEnabled(enabled);
    clock += 50 * DAY;
    coordinator = create();
    const saved = await coordinator.inspect();
    assert.equal(saved.enabled, enabled);
    assert.equal(saved.basis, "user_choice");
    assert.equal(saved.noticeCount, 1);
    assert.equal(saved.nextNoticeIndex, null);
    assert.equal(saved.noticeDue, false);
  }
});

test("protected POSIX record preserves opt-out even when a later launch claims fresh", {
  skip: process.platform === "win32" ? "POSIX mode checks are not Windows ACL evidence" : false,
}, async (t) => {
  const rootPath = await mkdtemp(join(tmpdir(), "tibotattle-sharing-test-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  await chmod(rootPath, 0o700);
  const create = () => createDesktopSharingCoordinator({ ...OPTIONS,
    backend: createDesktopSharingBackend({ rootPath }), now: () => new Date(START) });
  const first = create();
  await first.initialize();
  await first.setEnabled(false);
  const path = join(rootPath, DESKTOP_SHARING_FILE_NAME);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.basis, "user_choice");
  assert.equal((await create().initialize()).enabled, false);
  await writeFile(path, "{corrupt", { mode: 0o600 });
  const corrupt = await create().initialize();
  assert.equal(corrupt.available, false);
  assert.equal(corrupt.enabled, false);
});

test("failed persistence cannot report a completed opt-out or allow later automatic activation", async () => {
  const backend = memoryBackend();
  const coordinator = createDesktopSharingCoordinator({ ...OPTIONS, backend: {
    load: backend.load,
    save: async (value) => {
      if (JSON.parse(value).basis === "user_choice") throw new Error("synthetic failure");
      await backend.save(value);
    },
  }, now: () => new Date(START) });
  await coordinator.initialize();
  await assert.rejects(coordinator.setEnabled(false));
  await assert.rejects(coordinator.inspect());
});
