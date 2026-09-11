import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileNativeElectronHandoverHelper } from "../scripts/build-electron-native-handover-helper.mjs";

test("compiled handover helper recognizes the enclosing app only in the production MacOS location", {
  skip: process.platform !== "darwin" ? "Requires Apple's Foundation runtime and Swift compiler" : false,
  timeout: 120_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "electron-handover-bundle-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = join(root, "TiboTattle.app", "Contents");
  const executable = join(contents, "MacOS", "TiboTattleNativeHandover");
  const wrongExecutable = join(contents, "Resources", "native", "TiboTattleNativeHandover");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources", "native"), { recursive: true });
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.usagemonitor.local</string>
<key>CFBundleExecutable</key><string>TiboTattle</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>\n`);
  await compileNativeElectronHandoverHelper({ output: executable });
  await copyFile(executable, wrongExecutable);
  const run = (path) => spawnSync(path, ["--bundle-context-smoke-test"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  const correct = run(executable);
  assert.equal(correct.status, 0, "the packaged helper must see the production app bundle");
  assert.deepEqual(JSON.parse(correct.stdout), {
    schemaVersion: "tibotattle-native-electron-handover-bridge-v1", status: "bundle_context_ok",
  });
  // Retained-state preparation must reject a lookalike bundle launched by an
  // unsigned/test parent before it can stop processes or change login items.
  // Supplying no predecessor is valid syntax, but is not identity evidence.
  for (const command of ["--prepare-retained-state", "--prepare-retained-state-preflight"]) {
    const rejected = spawnSync(executable, [command], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    assert.equal(rejected.status, 1);
    assert.deepEqual(JSON.parse(rejected.stdout), {
      schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
      status: "failed",
      failureStage: "identity",
    });
    const unexpectedArgument = spawnSync(executable, [command, "--native-app", "/synthetic.app"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    assert.equal(unexpectedArgument.status, 1);
    assert.deepEqual(JSON.parse(unexpectedArgument.stdout), {
      schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
      status: "failed",
      failureStage: "invalid_request",
    });
  }
  const wrong = run(wrongExecutable);
  assert.equal(wrong.status, 1, "Resources must not qualify as the app's executable context");
  assert.deepEqual(JSON.parse(wrong.stdout), {
    schemaVersion: "tibotattle-native-electron-handover-bridge-v1", status: "failed",
  });
});

test("helper preparation preflight refuses a synthetic service context with only a fixed code", {
  skip: process.platform !== "darwin" ? "Requires Apple's Foundation runtime and Swift compiler" : false,
  timeout: 120_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "electron-handover-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = join(root, "TiboTattle.app", "Contents");
  const executable = join(contents, "MacOS", "TiboTattleNativeHandover");
  const nativeContents = join(root, "Native.app", "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(nativeContents, { recursive: true });
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.usagemonitor.local</string>
<key>CFBundleExecutable</key><string>TiboTattle</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>\n`);
  await writeFile(join(nativeContents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.usagemonitor.local</string>
<key>CFBundleShortVersionString</key><string>0.1.18</string>
<key>CFBundleVersion</key><string>20260905.1</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>\n`);
  await compileNativeElectronHandoverHelper({ output: executable });
  const before = await readdir(root);
  const result = spawnSync(executable, ["--prepare-preflight", "--native-app", join(root, "Native.app")], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
    status: "failed",
    failureStage: "login_item_not_found",
  });
  assert.deepEqual(await readdir(root), before, "preflight must not create a handover state tree");
});
