import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
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
const BUILDER_CONFIG_PATH = resolve("apps/electron/electron-builder.config.cjs");

function loadBuilderConfigForTarget(target) {
  const source = [
    `const config = require(${JSON.stringify(BUILDER_CONFIG_PATH)});`,
    "process.stdout.write(JSON.stringify(config));",
  ].join("\n");
  return JSON.parse(execFileSync(process.execPath, ["-e", source], {
    cwd: resolve("."),
    env: { ...process.env, TIBOTATTLE_ELECTRON_TARGET: target },
    encoding: "utf8",
  }));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

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
  assert.equal(BUILDER_CONFIG.extraMetadata.name, "app-usagemonitor");
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
        "config/**",
        "contracts/**",
        "native/windows-filesystem/build/Release/windows_filesystem.node",
        "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
        "schemas/**",
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
  assert.deepEqual(BUILDER_CONFIG.asarUnpack, [
    "node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node",
  ]);
  assert.equal(BUILDER_CONFIG.extraMetadata.main, "apps/electron/main.js");
  assert.equal(BUILDER_CONFIG.publish, "never");
  assert.equal(BUILDER_CONFIG.forceCodeSigning, false);
  assert.equal(BUILDER_CONFIG.beforeBuild(), false);
  assert.equal(BUILDER_CONFIG.npmRebuild, true);
  assert.equal(BUILDER_CONFIG.buildDependenciesFromSource, false);
  assert.equal(BUILDER_CONFIG.nodeGypRebuild, false);
  assert.deepEqual(BUILDER_CONFIG.mac.target, [{ target: "dir", arch: ["arm64"] }]);
  assert.equal(BUILDER_CONFIG.mac.identity, null);
  assert.equal(BUILDER_CONFIG.mac.notarize, false);
});

test("Electron builder configuration exposes an unsigned Windows x64 directory target", () => {
  const config = loadBuilderConfigForTarget("win32");
  assert.match(config.directories.app, /\.release-build\/electron-dev\/windows-x64\/app$/u);
  assert.match(config.directories.output, /\.release-build\/electron-dev\/windows-x64\/artifacts$/u);
  assert.deepEqual(config.asarUnpack, [
    "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
    "native/windows-filesystem/build/Release/windows_filesystem.node",
  ]);
  assert.deepEqual(config.win.target, [{ target: "dir", arch: ["x64"] }]);
  assert.equal(config.win.signAndEditExecutable, false);
  assert.equal(config.win.signExecutable, false);
  assert.equal(config.publish, "never");
  assert.equal(config.forceCodeSigning, false);
});

test("Windows Electron staging requires the reviewed native binding pair", async () => {
  await withTemporaryDirectory(async (root) => {
    await assert.rejects(
      () => buildElectronApp({
        output: join(root, "missing-inputs"),
        target: "win32",
        windowsBindingPath: join(root, "missing.node"),
        windowsManifestPath: join(root, "missing.node.manifest.json"),
      }),
      (error) => error.code === "ELECTRON_APP_WINDOWS_INPUT_REQUIRED",
    );
  });
});

test("Windows Electron staging includes the exact binding pair and shell", async () => {
  await withTemporaryDirectory(async (root) => {
    const bindingPath = join(root, "windows_filesystem.node");
    const manifestPath = join(root, "windows_filesystem.node.manifest.json");
    const binding = Buffer.from("synthetic reviewed Windows binding\n", "utf8");
    await writeFile(bindingPath, binding, { mode: 0o600 });
    await writeFile(manifestPath, `${JSON.stringify({
      bindingFile: "windows_filesystem.node",
      platform: "win32",
      architecture: "x64",
      bytes: binding.byteLength,
      sha256: sha256(binding),
    })}\n`, { mode: 0o600 });

    const result = await buildElectronApp({
      output: join(root, "windows-app"),
      target: "windows",
      windowsBindingPath: bindingPath,
      windowsManifestPath: manifestPath,
    });
    const packageJson = JSON.parse(await readFile(join(result.output, "package.json"), "utf8"));
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const paths = manifest.files.map(({ path }) => path);

    assert.equal(packageJson.main, "apps/electron/main.js");
    assert.equal(manifest.target, "win32");
    assert.equal(manifest.architecture, "x64");
    assert.equal(manifest.entrypoint, "apps/electron/main.js");
    assert.equal(manifest.windowsBinding.included, true);
    assert.equal(manifest.windowsBinding.verified, false);
    assert.equal(manifest.windowsBinding.status, "included_unverified");
    assert.ok(paths.includes("native/windows-filesystem/build/Release/windows_filesystem.node"));
    assert.ok(paths.includes("native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json"));
    for (const relativePath of ELECTRON_SHELL_RUNTIME_FILES) {
      await access(join(result.output, relativePath));
      assert.ok(paths.includes(relativePath), relativePath);
    }
    assert.ok(!paths.some((path) => path.includes("windows_filesystem_qualification")));
    assert.ok(!paths.some((path) => /(^|\/)(?:docs?|tests?)(?:\/|$)/iu.test(path)));
  });
});

test("Electron app argument parsing selects macOS or Windows inputs explicitly", () => {
  assert.deepEqual(parseElectronAppArguments([]), {
    output: DEFAULT_ELECTRON_APP_OUTPUT,
    target: "darwin",
    replace: false,
  });
  assert.deepEqual(parseElectronAppArguments(["--target", "windows"]), {
    output: resolve(".release-build/electron-dev/windows-x64/app"),
    target: "win32",
    replace: false,
  });
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
  assert.deepEqual(
    parseElectronAppArguments([
      "--target", "windows",
      "--output", "/private/tmp/tibotattle-electron-windows-app",
      "--windows-binding", "/private/tmp/windows_filesystem.node",
      "--windows-manifest", "/private/tmp/windows_filesystem.node.manifest.json",
      "--replace",
    ]),
    {
      output: "/private/tmp/tibotattle-electron-windows-app",
      target: "win32",
      replace: true,
      windowsBindingPath: "/private/tmp/windows_filesystem.node",
      windowsManifestPath: "/private/tmp/windows_filesystem.node.manifest.json",
    },
  );
  assert.throws(
    () => parseElectronAppArguments(["--target", "windows", "--windows-binding", "/tmp/binding.node"]),
    (error) => error.code === "ELECTRON_APP_WINDOWS_INPUT_PAIR",
  );
});

test("Electron app staging default remains a disposable reviewed destination", () => {
  assert.match(DEFAULT_ELECTRON_APP_OUTPUT, /\.release-build\/electron-dev\/mac-arm64\/app$/u);
  assert.doesNotMatch(DEFAULT_ELECTRON_APP_OUTPUT, /(?:docs?|tests?)(?:\/|$)/iu);
});
