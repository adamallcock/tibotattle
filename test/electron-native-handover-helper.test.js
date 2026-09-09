import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("same-identity Foundation bundles cannot use their own identifier as a defaults suite", {
  skip: SKIP,
  timeout: 120_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-native-handover-defaults-domain-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const contents = join(root, "TiboTattle.app", "Contents");
  const executable = join(contents, "MacOS", "TiboTattleDefaultsFixture");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(join(root, "main.swift"), `import Foundation
let identifier = "com.usagemonitor.local"
let result: [String: Any] = [
  "bundleMatches": Bundle.main.bundleIdentifier == identifier,
  "sameIdentitySuiteAvailable": UserDefaults(suiteName: identifier) != nil,
]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
`);
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.usagemonitor.local</string>
<key>CFBundleExecutable</key><string>TiboTattleDefaultsFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`);
  const compile = spawnSync("/usr/bin/swiftc", [
    "-module-cache-path", join(root, "swift-module-cache"),
    join(root, "main.swift"), "-o", executable,
  ], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024,
  });
  assert.equal(compile.status, 0, compile.stderr);
  const result = spawnSync(executable, [], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    bundleMatches: true,
    sameIdentitySuiteAvailable: false,
  });
});

test("native handover helper reads legacy preferences through the native default domain", async () => {
  const source = await readFile("apps/macos/Helpers/NativeElectronHandoverHelper.swift", "utf8");
  const start = source.indexOf("private static func readPreferences");
  const end = source.indexOf("private static func failureResponse", start);
  assert.ok(start >= 0 && end > start, "preference bridge functions must remain present");
  const reader = source.slice(start, end);
  assert.match(reader, /let defaults = UserDefaults\.standard/u);
  assert.doesNotMatch(reader, /UserDefaults\(suiteName:/u);
});

test("native handover helper classifies selected, unrelated, and other same-identity process fixtures", { skip: SKIP }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-native-handover-process-classifier-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const executable = await compileNativeElectronHandoverHelper({
    output: join(root, "TiboTattleNativeHandover"),
    architecture: process.arch,
  });
  const result = spawnSync(executable, ["--process-classifier-smoke-test"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
    status: "process_classifier_ok",
  });
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
