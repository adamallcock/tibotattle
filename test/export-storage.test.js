import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverOwnerOnlyPairTransactions, writeOwnerOnlyPairNoClobber } from "../src/storage.js";

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
    assert.equal((await stat(bundle)).mode & 0o777, 0o600);
    assert.equal((await stat(receipt)).mode & 0o777, 0o600);
    assert.equal((await stat(bundle)).nlink, 1);
    assert.equal((await stat(receipt)).nlink, 1);
    assert.deepEqual((await readdir(directory)).sort(), ["review.privacy-receipt.json", "review.umx.json"]);
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
