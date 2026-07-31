import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  checkLocalWorkspacePackage,
} from "./check-local-workspace-package.mjs";

const PACKAGE_NAME = "@app-usagemonitor/example";
const ERROR_CODE = "EXAMPLE_PACKAGE_STALE";

async function withPackageCopies(run) {
  const root = await mkdtemp(join(tmpdir(), "workspace-package-copy-"));
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
      name: PACKAGE_NAME,
      files: ["index.js", "index.d.ts", "src"],
    }));
    await cp(sourceRoot, installedRoot, { recursive: true });
    await run({
      errorCode: ERROR_CODE,
      installedRoot,
      packageName: PACKAGE_NAME,
      sourceRoot,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("accepts an exact package copy with an immutable deterministic receipt", async () => {
  await withPackageCopies(async (options) => {
    const first = await checkLocalWorkspacePackage(options);
    const second = await checkLocalWorkspacePackage(options);
    assert.deepEqual(first.files, [
      "index.d.ts",
      "index.js",
      "package.json",
      "src/kernel.js",
    ]);
    assert.equal(first.fileCount, 4);
    assert.equal(first.packageName, PACKAGE_NAME);
    assert.match(first.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(first.sha256, second.sha256);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.files), true);
    assert.throws(() => first.files.push("later.js"), TypeError);
  });
});

test("rejects stale installed bytes with the caller error code", async () => {
  await withPackageCopies(async (options) => {
    await writeFile(join(options.installedRoot, "src", "kernel.js"), "stale\n");
    await assert.rejects(
      checkLocalWorkspacePackage(options),
      {
        code: ERROR_CODE,
        message: `installed ${PACKAGE_NAME} package is stale: src/kernel.js`,
      },
    );
  });
});

test("rejects unexpected installed files", async () => {
  await withPackageCopies(async (options) => {
    await writeFile(join(options.installedRoot, "unexpected.js"), "unexpected\n");
    await assert.rejects(
      checkLocalWorkspacePackage(options),
      {
        code: ERROR_CODE,
        message: `installed ${PACKAGE_NAME} package file inventory differs from the source package`,
      },
    );
  });
});

test("rejects unsafe manifest entries and package symlinks", async (t) => {
  for (const selected of [
    "../outside.js",
    "/absolute.js",
    "C:\\absolute.js",
    "src//kernel.js",
    "./index.js",
  ]) {
    await t.test(`unsafe manifest path ${JSON.stringify(selected)}`, async () => {
      await withPackageCopies(async (options) => {
        await writeFile(join(options.sourceRoot, "package.json"), JSON.stringify({
          name: PACKAGE_NAME,
          files: [selected],
        }));
        await assert.rejects(
          checkLocalWorkspacePackage(options),
          {
            code: ERROR_CODE,
            message: `${PACKAGE_NAME} package files entries must be safe relative paths`,
          },
        );
      });
    });
  }

  await t.test("source symlink", async () => {
    await withPackageCopies(async (options) => {
      await symlink(
        join(options.sourceRoot, "index.js"),
        join(options.sourceRoot, "linked.js"),
      );
      await writeFile(join(options.sourceRoot, "package.json"), JSON.stringify({
        name: PACKAGE_NAME,
        files: ["linked.js"],
      }));
      await assert.rejects(
        checkLocalWorkspacePackage(options),
        { code: ERROR_CODE },
      );
    });
  });

  await t.test("installed symlink", async () => {
    await withPackageCopies(async (options) => {
      await symlink(
        join(options.installedRoot, "index.js"),
        join(options.installedRoot, "linked.js"),
      );
      await assert.rejects(
        checkLocalWorkspacePackage(options),
        { code: ERROR_CODE },
      );
    });
  });
});

test("rejects missing roots, manifests, and declared package files", async (t) => {
  await t.test("installed root", async () => {
    await withPackageCopies(async (options) => {
      await rm(options.installedRoot, { force: true, recursive: true });
      await assert.rejects(
        checkLocalWorkspacePackage(options),
        {
          code: ERROR_CODE,
          message: `installed ${PACKAGE_NAME} package is missing`,
        },
      );
    });
  });

  await t.test("source manifest", async () => {
    await withPackageCopies(async (options) => {
      await rm(join(options.sourceRoot, "package.json"));
      await assert.rejects(
        checkLocalWorkspacePackage(options),
        {
          code: ERROR_CODE,
          message: `${PACKAGE_NAME} package manifest is missing`,
        },
      );
    });
  });

  await t.test("declared source file", async () => {
    await withPackageCopies(async (options) => {
      await writeFile(join(options.sourceRoot, "package.json"), JSON.stringify({
        name: PACKAGE_NAME,
        files: ["missing.js"],
      }));
      await assert.rejects(
        checkLocalWorkspacePackage(options),
        {
          code: ERROR_CODE,
          message: `${PACKAGE_NAME} package file missing.js is missing`,
        },
      );
    });
  });
});

test("rejects a package manifest with the wrong identity", async () => {
  await withPackageCopies(async (options) => {
    await writeFile(join(options.sourceRoot, "package.json"), JSON.stringify({
      name: "@app-usagemonitor/not-example",
      files: ["index.js"],
    }));
    await assert.rejects(
      checkLocalWorkspacePackage(options),
      {
        code: ERROR_CODE,
        message: `${PACKAGE_NAME} package manifest must declare the expected package name`,
      },
    );
  });
});
