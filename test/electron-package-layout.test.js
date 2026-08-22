import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildElectronRuntime,
  electronRuntimeStatFingerprintForTest,
  electronRuntimeStatOptionsForTest,
  parseElectronRuntimeArguments,
  validateElectronRuntimeOutput,
} from "../scripts/build-electron-runtime.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function withTemporaryDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-package-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function filePaths(manifest) {
  return manifest.files.map(({ path }) => path);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function payloadFor(rows) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of rows) {
    bytes += row.bytes;
    hash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  return { bytes, sha256: hash.digest("hex") };
}

test("Windows runtime capture requests BigInt stats and preserves above-safe identities", () => {
  assert.deepEqual(electronRuntimeStatOptionsForTest("win32"), { bigint: true });
  assert.equal(electronRuntimeStatOptionsForTest("darwin"), undefined);
  const common = {
    mode: 0o100644n,
    size: 1n,
    mtimeMs: 2n,
    ctimeMs: 3n,
  };
  const first = electronRuntimeStatFingerprintForTest({
    ...common,
    dev: 2n ** 60n,
    ino: (2n ** 60n) + 1n,
  });
  const second = electronRuntimeStatFingerprintForTest({
    ...common,
    dev: 2n ** 60n,
    ino: (2n ** 60n) + 2n,
  });
  assert.notEqual(first, second);
  assert.equal(first.startsWith("1152921504606846976\0"), true);
});

test("Electron runtime staging is deterministic and contains only the reviewed companion closure", async () => {
  await withTemporaryDirectory(async (root) => {
    const first = await buildElectronRuntime({
      output: join(root, "first"),
      target: "darwin",
    });
    const second = await buildElectronRuntime({
      output: join(root, "second"),
      target: "darwin",
    });
    const firstManifest = await readFile(first.manifestPath, "utf8");
    const secondManifest = await readFile(second.manifestPath, "utf8");

    assert.equal(firstManifest, secondManifest);
    assert.equal(first.manifest.target, "darwin");
    assert.equal(first.manifest.windowsBinding.included, false);
    assert.equal(first.manifest.windowsBinding.verified, false);
    assert.equal(first.manifest.entrypoint, "apps/local/server.js");
    assert.equal(first.manifest.dashboardRoot, "apps/web/public");
    assert.ok(first.manifest.files.length > 300);
    assert.equal(
      first.manifest.payload.bytes,
      first.manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    );
    assert.match(first.manifest.payload.sha256, /^[0-9a-f]{64}$/u);
    assert.doesNotMatch(firstManifest, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));

    const paths = filePaths(first.manifest);
    assert.ok(paths.includes("apps/local/server.js"));
    assert.ok(paths.includes("apps/web/public/index.html"));
    assert.ok(paths.includes("apps/web/public/styles.css"));
    assert.ok(paths.includes("node_modules/@app-usagemonitor/accounting/index.js"));
    assert.ok(paths.includes("node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node"));
    assert.deepEqual(
      paths.filter((path) => path.startsWith("node_modules/@github/keytar/"))
        .sort(),
      [
        "node_modules/@github/keytar/LICENSE.md",
        "node_modules/@github/keytar/package.json",
        "node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node",
      ],
    );
    assert.ok(paths.every((path) => !/(^|\/)(?:\.git|docs|test|tests|\.usage-monitor)(?:\/|$)/u.test(path)));
    assert.ok(paths.every((path) => !path.startsWith("native/windows-filesystem/build/")));
    assert.ok(paths.every((path) => !/(^|\/)(?:credentials?|secrets?|quarantine|uploads?)(?:\/|$)/iu.test(path)));
    assert.ok(!paths.some((path) => path.endsWith("windows_filesystem_qualification.node")));
  });
});

test("Electron runtime output rejects broad or source destinations", async () => {
  await assert.rejects(
    () => validateElectronRuntimeOutput({ output: REPOSITORY_ROOT }),
    (error) => error.code === "ELECTRON_RUNTIME_UNSAFE_OUTPUT",
  );
  await assert.rejects(
    () => validateElectronRuntimeOutput({ output: join(REPOSITORY_ROOT, "src") }),
    (error) => error.code === "ELECTRON_RUNTIME_UNSAFE_OUTPUT",
  );
  await assert.rejects(
    () => validateElectronRuntimeOutput({ output: "/" }),
    (error) => error.code === "ELECTRON_RUNTIME_UNSAFE_OUTPUT",
  );
  await assert.rejects(
    () => validateElectronRuntimeOutput({ output: join(REPOSITORY_ROOT, ".usage-monitor") }),
    (error) => error.code === "ELECTRON_RUNTIME_UNSAFE_OUTPUT",
  );
});

test("Electron runtime replacement refuses foreign or tampered directories", async () => {
  await withTemporaryDirectory(async (root) => {
    const output = join(root, "runtime");
    await buildElectronRuntime({ output });
    await mkdir(join(output, "foreign"));
    await writeFile(join(output, "foreign", "marker.txt"), "foreign\n", "utf8");
    await assert.rejects(
      () => buildElectronRuntime({ output, replace: true }),
      (error) => error.code === "ELECTRON_RUNTIME_EXISTING_OUTPUT_INVALID",
    );
    assert.equal(await readFile(join(output, "foreign", "marker.txt"), "utf8"), "foreign\n");

    const manifestPath = join(output, "electron-runtime-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files[0].path = "Docs/foreign.txt";
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    await assert.rejects(
      () => buildElectronRuntime({ output, replace: true }),
      (error) => error.code === "ELECTRON_RUNTIME_FORBIDDEN_SOURCE",
    );
  });
});

test("Electron shell replacement accepts an authenticated older reviewed closure", async () => {
  await withTemporaryDirectory(async (root) => {
    const output = join(root, "runtime");
    const built = await buildElectronRuntime({
      output,
      includeElectronShell: true,
    });
    const historicalModule = "apps/electron/windows-qualification.js";
    const historicalManifest = {
      ...built.manifest,
      files: built.manifest.files.filter(({ path }) => path !== historicalModule),
    };
    historicalManifest.payload = payloadFor(historicalManifest.files);
    await rm(join(output, ...historicalModule.split("/")));
    await chmod(join(output, "electron-runtime-manifest.json"), 0o600);
    await writeFile(
      join(output, "electron-runtime-manifest.json"),
      `${JSON.stringify(historicalManifest)}\n`,
      "utf8",
    );

    const replaced = await buildElectronRuntime({
      output,
      includeElectronShell: true,
      replace: true,
    });
    assert.ok(filePaths(replaced.manifest).includes(historicalModule));
  });
});

test("Electron runtime rejects symlinked output components", async () => {
  await withTemporaryDirectory(async (root) => {
    const target = join(root, "target");
    const link = join(root, "linked-output");
    await mkdir(target);
    await symlink(target, link, "dir");
    await assert.rejects(
      () => validateElectronRuntimeOutput({ output: join(link, "runtime") }),
      (error) => error.code === "ELECTRON_RUNTIME_SYMLINK_PATH",
    );
  });
});

test("Windows target can include an exact binding pair while remaining explicitly unverified", async () => {
  await withTemporaryDirectory(async (root) => {
    const bindingPath = join(root, "windows_filesystem.node");
    const manifestPath = join(root, "windows_filesystem.node.manifest.json");
    const bytes = Buffer.from("synthetic Windows binding bytes\n", "utf8");
    await writeFile(bindingPath, bytes, { mode: 0o600 });
    await writeFile(manifestPath, `${JSON.stringify({
      bindingFile: "windows_filesystem.node",
      platform: "win32",
      architecture: "x64",
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    })}\n`, { mode: 0o600 });

    const result = await buildElectronRuntime({
      output: join(root, "windows-runtime"),
      target: "win32",
      windowsBindingPath: bindingPath,
      windowsManifestPath: manifestPath,
    });
    assert.equal(result.manifest.target, "win32");
    assert.deepEqual(result.manifest.windowsBinding, {
      binding: {
        bytes: bytes.byteLength,
        path: "native/windows-filesystem/build/Release/windows_filesystem.node",
        sha256: sha256(bytes),
      },
      included: true,
      manifest: {
        path: "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
      },
      status: "included_unverified",
      verified: false,
    });
    const paths = filePaths(result.manifest);
    assert.ok(paths.includes("native/windows-filesystem/build/Release/windows_filesystem.node"));
    assert.ok(paths.includes("native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json"));
    assert.deepEqual(
      result.manifest.files.find(
        ({ path }) => path === "native/windows-filesystem/build/Release/windows_filesystem.node",
      ),
      {
        bytes: bytes.byteLength,
        kind: "windows_native_binding",
        path: "native/windows-filesystem/build/Release/windows_filesystem.node",
        sha256: sha256(bytes),
      },
    );
    assert.ok(paths.includes("src/platform/windows-qualification-mode.js"));
    assert.ok(!paths.includes("apps/electron/windows-qualification.js"));
    assert.ok(!paths.some((path) => path.endsWith("windows_filesystem_qualification.node")));
    assert.equal(
      await readFile(join(result.output, "native/windows-filesystem/build/Release/windows_filesystem.node"), "utf8"),
      bytes.toString("utf8"),
    );
  });
});

test("Electron runtime argument parsing requires an output and paired Windows inputs", () => {
  assert.deepEqual(
    parseElectronRuntimeArguments([
      "--output",
      "/tmp/tibotattle-runtime",
      "--platform",
      "windows",
      "--replace",
    ]),
    {
      output: "/tmp/tibotattle-runtime",
      target: "win32",
      replace: true,
      windowsBindingPath: null,
      windowsManifestPath: null,
    },
  );
  assert.throws(
    () => parseElectronRuntimeArguments(["--output", "/tmp/runtime", "--windows-binding", "/tmp/binding.node"]),
    (error) => error.code === "ELECTRON_RUNTIME_WINDOWS_BINDING_PAIR",
  );
  assert.throws(
    () => parseElectronRuntimeArguments([
      "--output", "/tmp/runtime", "--target", "darwin",
      "--windows-binding", "/tmp/windows_filesystem.node",
      "--windows-manifest", "/tmp/windows_filesystem.node.manifest.json",
    ]),
    (error) => error.code === "ELECTRON_RUNTIME_WINDOWS_BINDING_TARGET",
  );
});
