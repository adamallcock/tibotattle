import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const wrong = run(wrongExecutable);
  assert.equal(wrong.status, 1, "Resources must not qualify as the app's executable context");
  assert.deepEqual(JSON.parse(wrong.stdout), {
    schemaVersion: "tibotattle-native-electron-handover-bridge-v1", status: "failed",
  });
});
