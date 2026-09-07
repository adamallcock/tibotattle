import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compileNativeElectronHandoverHelper,
  nativeElectronHandoverHelperSwiftArchitecture,
  runNativeElectronHandoverHelperContractSmoke,
} from "../scripts/build-electron-native-handover-helper.mjs";
import {
  createMacNativeElectronGuidedInstallPlan,
} from "../scripts/plan-macos-native-electron-guided-handover.mjs";

const SKIP = process.platform === "darwin"
  ? false
  : "native handover helper source compilation requires macOS SDK";

test("Electron architecture names map to the Swift target triples", () => {
  assert.equal(nativeElectronHandoverHelperSwiftArchitecture("arm64"), "arm64");
  assert.equal(nativeElectronHandoverHelperSwiftArchitecture("x64"), "x86_64");
  assert.throws(() => nativeElectronHandoverHelperSwiftArchitecture("ia32"));
});

test("native-to-Electron handover helper compiles and exposes only its no-side-effect contract smoke", { skip: SKIP }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-native-handover-helper-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const executable = await compileNativeElectronHandoverHelper({
    output: join(root, "TiboTattleNativeHandover"),
    architecture: process.arch,
  });
  assert.deepEqual(
    runNativeElectronHandoverHelperContractSmoke({ executable }),
    { status: "contract_ok" },
  );
});

test("Apple Silicon source preparation cross-compiles the thin Intel helper", {
  skip: process.platform === "darwin" && process.arch === "arm64"
    ? false
    : "Intel helper cross-compilation is exercised on Apple Silicon",
  timeout: 120_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-native-handover-helper-x64-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const executable = await compileNativeElectronHandoverHelper({
    output: join(root, "TiboTattleNativeHandover"),
    architecture: "x64",
  });
  const bytes = await readFile(executable);
  assert.ok(bytes.length >= 8);
  assert.equal(bytes.readUInt32LE(0), 0xfeedfacf);
  assert.equal(bytes.readUInt32LE(4), 0x01000007);
});

test("guided install plan retains the old app at one exact backup path without performing a move", () => {
  const plan = createMacNativeElectronGuidedInstallPlan({
    legacyAppPath: "/Applications/TiboTattle.app",
    homeDirectory: "/Users/synthetic",
  });
  assert.deepEqual(plan, {
    schemaVersion: "tibotattle-macos-guided-native-electron-install-v1",
    route: "guided_signed_install",
    nativeStateRoot: "/Users/synthetic/Library/Application Support/Usage Monitor",
    legacyAppPath: "/Applications/TiboTattle.app",
    preservedNativeAppPath: "/Users/synthetic/Library/Application Support/TiboTattle Native Handover/native-app/TiboTattle.app",
    electronInstallPath: "/Applications/TiboTattle.app",
    backupRoot: "/Users/synthetic/Library/Application Support/TiboTattle Native Handover",
  });
});
