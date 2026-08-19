import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import {
  assertWindowsUnifiedIndexStagingUnavailable,
  openLocalUnifiedIndex,
  publishStagedUnifiedIndex,
  readOrCreateDeviceSalt,
  removeIfPresent,
} from "../src/local-unified-index.js";

const CONTRACT = "usage-event-v0.2";

async function withPlatform(platform, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return await callback();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

test("Windows unified index rejects every ordinary SQLite, secret, and staging fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-windows-boundary-"));
  const indexFile = join(root, "index.sqlite");
  const stageFile = join(root, "index.sqlite.building-test");
  const secretFile = join(root, "missing", "device-salt");
  await writeFile(stageFile, "untouched", { mode: 0o600 });
  try {
    await withPlatform("win32", async () => {
      assert.throws(
        () => openLocalUnifiedIndex(indexFile),
        (error) => error?.code === "local_unified_index_windows_state_unqualified",
      );
      await assert.rejects(
        () => readOrCreateDeviceSalt(secretFile),
        (error) => error?.code === "local_unified_index_windows_state_unqualified",
      );
      await assert.rejects(
        () => rebuildLocalUnifiedIndex({
          codexHome: root,
          indexFile,
          secretFile,
          contractVersion: CONTRACT,
        }),
        (error) => error?.code === "local_unified_index_windows_staging_unavailable",
      );
      await assert.rejects(
        () => ingestLocalUnifiedIndexIncrement({
          codexHome: root,
          indexFile,
          secretFile,
          contractVersion: CONTRACT,
        }),
        (error) => error?.code === "local_unified_index_windows_staging_unavailable",
      );
      assert.throws(
        () => assertWindowsUnifiedIndexStagingUnavailable(),
        (error) => error?.code === "local_unified_index_windows_staging_unavailable",
      );
      await assert.rejects(
        () => publishStagedUnifiedIndex(stageFile, indexFile),
        (error) => error?.code === "local_unified_index_windows_staging_unavailable",
      );
      await assert.rejects(
        () => removeIfPresent(stageFile),
        (error) => error?.code === "local_unified_index_windows_staging_unavailable",
      );
    });

    assert.equal(await readFile(stageFile, "utf8"), "untouched");
    await assert.rejects(() => lstat(indexFile), { code: "ENOENT" });
    await assert.rejects(() => lstat(secretFile), { code: "ENOENT" });
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes(".building-") || name.includes(".incremental-")),
      ["index.sqlite.building-test"],
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
