import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/cli.js"));
const { generateAppRunScript } = builderRequire("app-builder-lib/out/targets/appimage/appImageUtil.js");
const exec = promisify(execFile);

test("the pinned AppImage launcher keeps sandbox requirements when unshare is absent", {
  skip: process.platform === "win32" ? "POSIX launcher execution" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-apprun-"));
  try {
    const launcher = join(root, "AppRun");
    await writeFile(launcher, generateAppRunScript({ ExecutableName: "app" }), { mode: 0o700 });
    await writeFile(join(root, "app"), '#!/bin/sh\nprintf "launched\\n"\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    // No `unshare` or any other system utilities are on this PATH. The old
    // vendor launcher silently inserted --no-sandbox in this exact case.
    const env = { PATH: root, APPDIR: root };
    const ordinary = await exec("/bin/bash", [launcher, "--test", "path with spaces"], { env, timeout: 2_000 });
    assert.equal(ordinary.stdout, "launched\n--test\npath with spaces\n");
    assert.equal(ordinary.stderr, "");
    for (const arg of ["--no-sandbox", "--no-sandbox=true", "--disable-setuid-sandbox"]) {
      await assert.rejects(exec("/bin/bash", [launcher, arg], { env, timeout: 2_000 }), (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.equal(error.stderr, "TiboTattle requires Chromium sandboxing.\n");
        return true;
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
