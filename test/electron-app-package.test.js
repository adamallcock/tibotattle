import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  access,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildElectronApp,
  DEFAULT_ELECTRON_APP_OUTPUT,
  parseElectronAppArguments,
} from "../scripts/build-electron-app.mjs";
import {
  ELECTRON_SHELL_RUNTIME_FILES,
} from "../scripts/build-electron-runtime.mjs";

const require = createRequire(import.meta.url);
const BUILDER_CONFIG = require("../apps/electron/electron-builder.config.cjs");

async function withTemporaryDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-app-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Electron app staging includes the shell and keeps the companion manifest valid", async () => {
  await withTemporaryDirectory(async (root) => {
    const result = await buildElectronApp({ output: join(root, "app") });
    const packageJson = JSON.parse(await readFile(join(result.output, "package.json"), "utf8"));
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const paths = manifest.files.map(({ path }) => path);

    assert.equal(result.output, resolve(root, "app"));
    assert.equal(packageJson.main, "apps/electron/main.js");
    assert.equal(manifest.entrypoint, "apps/electron/main.js");
    assert.equal(manifest.target, "darwin");
    assert.equal(manifest.architecture, "arm64");
    for (const relativePath of ELECTRON_SHELL_RUNTIME_FILES) {
      await access(join(result.output, relativePath));
      assert.ok(paths.includes(relativePath), relativePath);
    }
    await access(join(result.output, "apps/local/server.js"));
    await access(join(result.output, "apps/web/public/index.html"));
    assert.ok(paths.every((path) => !/(^|\/)(?:docs?|tests?)(?:\/|$)/iu.test(path)));
    assert.ok(!paths.some((path) => path.includes("windows_filesystem_qualification")));
    assert.ok(!paths.some((path) => path.startsWith("native/windows-filesystem/")));
  });
});

test("Electron builder configuration is an unsigned macOS arm64 directory build", () => {
  assert.equal(BUILDER_CONFIG.appId, "com.adamallcock.tibotattle.electron.dev");
  assert.equal(BUILDER_CONFIG.productName, "TiboTattle Dev");
  assert.equal(BUILDER_CONFIG.extraMetadata.name, "tibotattle-electron-dev");
  assert.equal(BUILDER_CONFIG.extraMetadata.productName, "TiboTattle Dev");
  assert.equal(BUILDER_CONFIG.directories.app, DEFAULT_ELECTRON_APP_OUTPUT);
  assert.deepEqual(BUILDER_CONFIG.files, [
    {
      from: ".",
      to: ".",
      filter: [
        "package.json",
        "electron-runtime-manifest.json",
        "apps/electron/**",
        "apps/local/**",
        "apps/web/public/**",
        "src/**",
        "generated/**",
      ],
    },
    {
      from: "node_modules",
      to: "node_modules",
      filter: ["**/*"],
    },
  ]);
  assert.equal(BUILDER_CONFIG.asar, true);
  assert.deepEqual(BUILDER_CONFIG.asarUnpack, ["**/*.node"]);
  assert.equal(BUILDER_CONFIG.extraMetadata.main, "apps/electron/main.js");
  assert.equal(BUILDER_CONFIG.publish, "never");
  assert.equal(BUILDER_CONFIG.forceCodeSigning, false);
  assert.equal(BUILDER_CONFIG.npmRebuild, false);
  assert.equal(BUILDER_CONFIG.buildDependenciesFromSource, false);
  assert.equal(BUILDER_CONFIG.nodeGypRebuild, false);
  assert.deepEqual(BUILDER_CONFIG.mac.target, [{ target: "dir", arch: ["arm64"] }]);
  assert.equal(BUILDER_CONFIG.mac.identity, null);
  assert.equal(BUILDER_CONFIG.mac.notarize, false);
});

test("Electron app argument parsing is macOS-only until Windows packaging is qualified", () => {
  assert.deepEqual(
    parseElectronAppArguments([
      "--output", "/private/tmp/tibotattle-electron-app",
      "--platform", "macos",
      "--replace",
    ]),
    {
      output: "/private/tmp/tibotattle-electron-app",
      target: "darwin",
      replace: true,
    },
  );
  assert.throws(
    () => parseElectronAppArguments(["--target", "windows"]),
    (error) => error.code === "ELECTRON_APP_UNSUPPORTED_TARGET",
  );
});

test("Electron app staging default remains a disposable reviewed destination", () => {
  assert.match(DEFAULT_ELECTRON_APP_OUTPUT, /\.release-build\/electron-dev\/mac-arm64\/app$/u);
  assert.doesNotMatch(DEFAULT_ELECTRON_APP_OUTPUT, /(?:docs?|tests?)(?:\/|$)/iu);
});
