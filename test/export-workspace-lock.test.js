import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportWorkspaceLockError, withExportWorkspaceLease } from "../src/export-workspace-lock.js";

test("workspace lease excludes a concurrent owner and releases after completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-workspace-lock-"));
  try {
    await withExportWorkspaceLease(directory, async () => {
      await assert.rejects(
        withExportWorkspaceLease(directory, async () => {}),
        (error) => error instanceof ExportWorkspaceLockError
          && error.code === "export_workspace_lock_contended",
      );
    });
    await withExportWorkspaceLease(directory, async () => {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace lease reaps a strict dead-process lock and rejects malformed locks", async () => {
  for (const malformed of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "usage-monitor-workspace-lock-"));
    const lock = join(directory, ".app-usagemonitor-export-workspace.lock");
    try {
      await writeFile(lock, malformed
        ? "not-json\n"
        : JSON.stringify({ version: "export-workspace-lock-v1", pid: 999_999_999, token: "11111111-1111-4111-8111-111111111111" }) + "\n", { mode: 0o600 });
      if (malformed) {
        await assert.rejects(
          withExportWorkspaceLease(directory, async () => {}),
          (error) => error instanceof ExportWorkspaceLockError
            && error.code === "export_workspace_lock_invalid",
        );
      } else {
        await withExportWorkspaceLease(directory, async () => {});
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
