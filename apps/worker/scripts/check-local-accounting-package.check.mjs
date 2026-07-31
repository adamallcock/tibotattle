import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  checkLocalAccountingPackage,
} from "./check-local-accounting-package.mjs";

async function withPackageCopies(run) {
  const root = await mkdtemp(join(tmpdir(), "accounting-package-copy-"));
  const sourceRoot = join(root, "source");
  const installedRoot = join(root, "installed");
  try {
    await mkdir(join(sourceRoot, "src"), { recursive: true });
    await writeFile(join(sourceRoot, "index.js"), "export const value = 1;\n");
    await writeFile(join(sourceRoot, "index.d.ts"), "export const value: number;\n");
    await writeFile(
      join(sourceRoot, "src", "kernel.js"),
      "export const kernel = 1;\n",
    );
    await writeFile(join(sourceRoot, "package.json"), JSON.stringify({
      name: "@app-usagemonitor/accounting",
      files: ["index.js", "index.d.ts", "src"],
    }));
    await cp(sourceRoot, installedRoot, { recursive: true });
    await run({ installedRoot, sourceRoot });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("accepts an exact installed accounting package copy", async () => {
  await withPackageCopies(async (options) => {
    const result = await checkLocalAccountingPackage(options);
    assert.equal(result.fileCount, 4);
    assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  });
});

test("rejects stale installed bytes and unexpected files", async () => {
  await withPackageCopies(async (options) => {
    await writeFile(join(options.installedRoot, "src", "kernel.js"), "stale\n");
    await assert.rejects(
      checkLocalAccountingPackage(options),
      { code: "ACCOUNTING_PACKAGE_STALE" },
    );
  });
  await withPackageCopies(async (options) => {
    await writeFile(join(options.installedRoot, "unexpected.js"), "unexpected\n");
    await assert.rejects(
      checkLocalAccountingPackage(options),
      { code: "ACCOUNTING_PACKAGE_STALE" },
    );
  });
});

test("rejects unsafe package file entries", async () => {
  await withPackageCopies(async (options) => {
    await writeFile(join(options.sourceRoot, "package.json"), JSON.stringify({
      name: "@app-usagemonitor/accounting",
      files: ["../outside.js"],
    }));
    await assert.rejects(
      checkLocalAccountingPackage(options),
      { code: "ACCOUNTING_PACKAGE_STALE" },
    );
  });
});
