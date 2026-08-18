import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recoverOwnerOnlyPairTransactions,
  withExportDestinationLease,
  writeOwnerOnlyNoClobberDurable,
  writeOwnerOnlyPairNoClobber,
} from "../src/storage.js";

test("single-file durable publication preserves text and binary bytes without clobbering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-single-publication-"));
  const textFile = join(directory, "text");
  const binaryFile = join(directory, "binary");
  try {
    await writeOwnerOnlyNoClobberDurable(textFile, "durable text\n");
    await writeOwnerOnlyNoClobberDurable(binaryFile, new Uint8Array([0x00, 0xff, 0x41]));
    assert.equal(await readFile(textFile, "utf8"), "durable text\n");
    assert.deepEqual(await readFile(binaryFile), Buffer.from([0x00, 0xff, 0x41]));
    for (const path of [textFile, binaryFile]) {
      const stats = await stat(path);
      if (process.platform !== "win32") {
        assert.equal(stats.mode & 0o777, 0o600);
      }
      assert.equal(stats.nlink, 1);
    }
    await assert.rejects(
      writeOwnerOnlyNoClobberDurable(textFile, "replacement"),
      (error) => error.code === "EEXIST",
    );
    assert.equal(await readFile(textFile, "utf8"), "durable text\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("single-file durable publication rejects oversize content before copy and unsafe paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-single-policy-"));
  const safe = join(root, "safe");
  const unsafe = join(root, "unsafe");
  const alias = join(root, "alias");
  const outside = join(root, "outside");
  await mkdir(safe, { mode: 0o700 });
  await mkdir(unsafe, { mode: 0o700 });
  await chmod(unsafe, 0o777);
  await symlink(safe, alias);
  await writeFile(outside, "outside", { mode: 0o600 });
  try {
    const oversized = Buffer.alloc(17, 0x61);
    await assert.rejects(
      writeOwnerOnlyNoClobberDurable(join(safe, "oversized"), oversized, { maximumBytes: 16 }),
      /exceeds its byte bound/,
    );
    await assert.rejects(stat(join(safe, "oversized")), { code: "ENOENT" });
    await assert.rejects(
      writeOwnerOnlyNoClobberDurable(join(safe, "default-oversized"), Buffer.alloc((1024 * 1024) + 1)),
      /exceeds its byte bound/,
    );
    await assert.rejects(
      writeOwnerOnlyNoClobberDurable(join(safe, "invalid-bound"), "value", { maximumBytes: (1024 * 1024) + 1 }),
      /at most 1 MiB/,
    );
    await assert.rejects(
      writeOwnerOnlyNoClobberDurable(join(safe, "unsupported"), { private: "value" }),
      /string, Buffer, or Uint8Array/,
    );
    if (process.platform !== "win32") {
      await assert.rejects(
        writeOwnerOnlyNoClobberDurable(join(unsafe, "file"), "value"),
        /group- or world-writable/,
      );
    }
    await assert.rejects(
      writeOwnerOnlyNoClobberDurable(join(alias, "file"), "value"),
      /real directory/,
    );
    await symlink(outside, join(safe, "target-link"));
    await assert.rejects(
      writeOwnerOnlyNoClobberDurable(join(safe, "target-link"), "value"),
      (error) => error.code === "EEXIST",
    );
    assert.equal(await readFile(outside, "utf8"), "outside");
    await assert.rejects(
      writeOwnerOnlyNoClobberDurable(join(root, "missing", "file"), "value"),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("single-file durable publication cleans only its own inode before directory durability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-single-cleanup-"));
  const failed = join(directory, "failed");
  const substituted = join(directory, "substituted");
  try {
    await assert.rejects(
      writeOwnerOnlyNoClobberDurable(failed, "uncommitted", {
        failpoint(point) {
          if (point === "after_file_sync") throw new Error("injected publication failure");
        },
      }),
      /injected publication failure/,
    );
    await assert.rejects(stat(failed), { code: "ENOENT" });

    await assert.rejects(
      writeOwnerOnlyNoClobberDurable(substituted, "uncommitted", {
        async failpoint(point) {
          if (point !== "after_file_sync") return;
          await unlink(substituted);
          await writeFile(substituted, "replacement", { mode: 0o600 });
          throw new Error("injected replacement race");
        },
      }),
      /injected replacement race/,
    );
    assert.equal(await readFile(substituted, "utf8"), "replacement");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("destination lease returns callback results, excludes contenders, and cleans its lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-destination-lease-"));
  const lockPath = join(directory, ".app-usagemonitor-export.lock");
  let release;
  let reached;
  const acquired = new Promise((resolve) => { reached = resolve; });
  const continueLease = new Promise((resolve) => { release = resolve; });
  try {
    const first = withExportDestinationLease(directory, async () => {
      assert.equal((await lstat(lockPath)).isSymbolicLink(), true);
      reached();
      await continueLease;
      return "callback-result";
    });
    await acquired;
    await assert.rejects(
      withExportDestinationLease(directory, async () => {}),
      /destination is busy/,
    );
    release();
    assert.equal(await first, "callback-result");
    await assert.rejects(stat(lockPath), { code: "ENOENT" });
    await assert.rejects(
      withExportDestinationLease(directory, async () => { throw new Error("callback failure"); }),
      /callback failure/,
    );
    await assert.rejects(stat(lockPath), { code: "ENOENT" });
  } finally {
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("paired exports publish receipt then bundle without overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-pair-"));
  const bundle = join(directory, "review.umx.json");
  const receipt = join(directory, "review.privacy-receipt.json");
  try {
    await writeOwnerOnlyPairNoClobber({
      firstPath: bundle,
      firstContent: "bundle",
      secondPath: receipt,
      secondContent: "receipt",
    });
    assert.equal(await readFile(bundle, "utf8"), "bundle");
    assert.equal(await readFile(receipt, "utf8"), "receipt");
    if (process.platform !== "win32") {
      assert.equal((await stat(bundle)).mode & 0o777, 0o600);
      assert.equal((await stat(receipt)).mode & 0o777, 0o600);
    }
    assert.equal((await stat(bundle)).nlink, 1);
    assert.equal((await stat(receipt)).nlink, 1);
    assert.deepEqual((await readdir(directory)).sort(), ["review.privacy-receipt.json", "review.umx.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paired exports preserve Buffer and Uint8Array bytes exactly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-pair-binary-"));
  const bundle = join(directory, "review.umx");
  const receipt = join(directory, "review.privacy-receipt");
  const bundleBytes = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0a]);
  const receiptBacking = new Uint8Array([0x99, 0xfe, 0x00, 0x42, 0x98]);
  const receiptBytes = receiptBacking.subarray(1, 4);
  try {
    await writeOwnerOnlyPairNoClobber({
      firstPath: bundle,
      firstContent: bundleBytes,
      secondPath: receipt,
      secondContent: receiptBytes,
    });
    assert.deepEqual(await readFile(bundle), bundleBytes);
    assert.deepEqual(await readFile(receipt), Buffer.from([0xfe, 0x00, 0x42]));
    if (process.platform !== "win32") {
      assert.equal((await stat(bundle)).mode & 0o777, 0o600);
      assert.equal((await stat(receipt)).mode & 0o777, 0o600);
    }
    assert.equal((await stat(bundle)).nlink, 1);
    assert.equal((await stat(receipt)).nlink, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paired exports reject unsupported content types without rendering content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-pair-type-"));
  const bundle = join(directory, "bundle");
  const receipt = join(directory, "receipt");
  const canary = "private-content-canary";
  try {
    const unsupported = {
      toString() {
        return canary;
      },
    };
    await assert.rejects(
      writeOwnerOnlyPairNoClobber({
        firstPath: bundle,
        firstContent: unsupported,
        secondPath: receipt,
        secondContent: "receipt",
      }),
      (error) => {
        assert.match(error.message, /strings, Buffers, or Uint8Arrays/);
        assert.equal(error.message.includes(canary), false);
        return true;
      },
    );
    await assert.rejects(stat(bundle), { code: "ENOENT" });
    await assert.rejects(stat(receipt), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paired exports reject equal paths, separate parents, and existing destinations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-pair-policy-"));
  const bundle = join(directory, "bundle");
  const receipt = join(directory, "receipt");
  try {
    await assert.rejects(
      writeOwnerOnlyPairNoClobber({ firstPath: bundle, firstContent: "a", secondPath: bundle, secondContent: "b" }),
      /distinct/,
    );
    await assert.rejects(
      writeOwnerOnlyPairNoClobber({ firstPath: bundle, firstContent: "a", secondPath: join(directory, "other", "receipt"), secondContent: "b" }),
      /share one canonical/,
    );
    await writeFile(bundle, "original", { mode: 0o600 });
    await assert.rejects(
      writeOwnerOnlyPairNoClobber({ firstPath: bundle, firstContent: "replacement", secondPath: receipt, secondContent: "receipt" }),
      /Refusing to overwrite/,
    );
    assert.equal(await readFile(bundle, "utf8"), "original");
    await assert.rejects(stat(receipt), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a bundle-link failure preserves a durable receipt-first transaction for recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-pair-rollback-"));
  const bundle = join(directory, "bundle");
  const receipt = join(directory, "receipt");
  let calls = 0;
  try {
    await assert.rejects(
      writeOwnerOnlyPairNoClobber(
        { firstPath: bundle, firstContent: "bundle", secondPath: receipt, secondContent: "receipt" },
        {
          async linkFile(source, destination) {
            calls += 1;
            if (calls === 2) throw Object.assign(new Error("injected bundle commit failure"), { code: "EIO" });
            return link(source, destination);
          },
        },
      ),
      /injected bundle commit failure/,
    );
    assert.equal(calls, 2);
    assert.deepEqual((await readdir(directory)).sort(), [".app-usagemonitor-export-transactions", "receipt"]);
    assert.equal(await readFile(receipt, "utf8"), "receipt");
    assert.deepEqual(
      await recoverOwnerOnlyPairTransactions({ directory }),
      { recovered: 1, transactionsFound: 1 },
    );
    assert.equal(await readFile(bundle, "utf8"), "bundle");
    assert.equal(await readFile(receipt, "utf8"), "receipt");
    assert.deepEqual((await readdir(directory)).sort(), ["bundle", "receipt"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paired export commits to the canonical parent after an alias is swapped", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-pair-canonical-"));
  const firstDirectory = join(root, "first");
  const secondDirectory = join(root, "second");
  const alias = join(root, "alias");
  await mkdir(join(firstDirectory, "child"), { recursive: true });
  await mkdir(join(secondDirectory, "child"), { recursive: true });
  await symlink(firstDirectory, alias);
  try {
    await writeOwnerOnlyPairNoClobber({
      firstPath: join(alias, "child", "bundle"),
      firstContent: "bundle",
      secondPath: join(alias, "child", "receipt"),
      secondContent: "receipt",
    }, {
      async failpoint(name) {
        if (name === "after_manifest") {
          await unlink(alias);
          await symlink(secondDirectory, alias);
        }
      },
    });
    assert.equal(await readFile(join(firstDirectory, "child", "bundle"), "utf8"), "bundle");
    assert.equal(await readFile(join(firstDirectory, "child", "receipt"), "utf8"), "receipt");
    await assert.rejects(stat(join(secondDirectory, "child", "bundle")), { code: "ENOENT" });
    await assert.rejects(stat(join(secondDirectory, "child", "receipt")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
