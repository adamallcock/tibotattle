import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const PATCH_PATH = resolve("patches/app-builder-lib@26.15.7.patch");
const RELEASE_CONFIG_PATH = resolve("apps/electron/electron-builder.release.config.cjs");
const LOCKFILE_PATH = resolve("pnpm-lock.yaml");
const PATCH = readFileSync(PATCH_PATH, "utf8");

function installedAppBuilderRoot() {
  const electronBuilderEntry = require.resolve("electron-builder");
  return resolve(dirname(electronBuilderEntry), "..", "..", "app-builder-lib");
}

function installedAppBuilderSource(relativePath) {
  return readFileSync(join(installedAppBuilderRoot(), relativePath), "utf8");
}

test("the production config enables one content-free app-builder signing ledger", () => {
  const source = readFileSync(RELEASE_CONFIG_PATH, "utf8");
  assert.match(source, /signExts:\s*\["\.dll",\s*"!\.node"\]/u);
  assert.match(source, /\.release-build\/electron-production\/windows-x64\/evidence/u);
  assert.match(source, /windowsSigningOperationEvidenceRoot:\s+WINDOWS_SIGNING_OPERATION_EVIDENCE_ROOT/u);
  assert.match(source, /windowsSigningOperationLedgerLeaf:\s+WINDOWS_SIGNING_OPERATION_LEDGER_LEAF/u);
  assert.equal((source.match(/windowsSigningOperationEvidenceRoot/g) ?? []).length, 1);
  assert.equal((source.match(/windowsSigningOperationLedgerLeaf/g) ?? []).length, 1);
});

test("the pinned app-builder seam is exact, path-free, and rejects native or unexpected classes", async () => {
  // Initialize electron-builder's public entrypoint before loading the
  // internal WinPackager module directly; otherwise its CommonJS module graph
  // can observe PlatformPackager mid-cycle on Node 26.
  require("electron-builder");
  const packageJson = JSON.parse(installedAppBuilderSource("package.json"));
  assert.equal(packageJson.version, "26.15.7");
  const source = installedAppBuilderSource("out/winPackager.js");
  const platformSource = installedAppBuilderSource("out/platformPackager.js");
  const appBuilder = require(join(installedAppBuilderRoot(), "out/winPackager.js"));

  assert.equal(appBuilder.WINDOWS_SIGNING_OPERATION_LEDGER_SCHEMA,
    "tibotattle-windows-signing-operation-ledger-v1");
  assert.equal(appBuilder.WINDOWS_SIGNING_OPERATION_LEDGER_STATUS,
    "WINDOWS_SIGNING_OPERATION_LEDGER_RECORDED");
  assert.deepEqual(appBuilder.WINDOWS_SIGNING_OPERATION_LEDGER_CLASSES,
    ["exe", "dll", "node", "unexpected"]);
  assert.equal(appBuilder.classifyWindowsSigningOperation("main.EXE"), "exe");
  assert.equal(appBuilder.classifyWindowsSigningOperation("lib.DLL"), "dll");
  assert.equal(appBuilder.classifyWindowsSigningOperation("binding.NODE"), "node");
  assert.equal(appBuilder.classifyWindowsSigningOperation("helper.sys"), "unexpected");

  const ledger = appBuilder.createWindowsSigningOperationLedger({
    exe: 4,
    dll: 7,
    node: 0,
    unexpected: 0,
  });
  assert.deepEqual(ledger, {
    schemaVersion: "tibotattle-windows-signing-operation-ledger-v1",
    status: "WINDOWS_SIGNING_OPERATION_LEDGER_RECORDED",
    builder: "app-builder-lib",
    builderVersion: "26.15.7",
    ledgerCount: 1,
    operationCount: 11,
    classes: { exe: 4, dll: 7, node: 0, unexpected: 0 },
  });
  const serialized = JSON.stringify(ledger);
  assert.doesNotMatch(serialized, /(?:[A-Za-z]:[\\/]|\/|\\\\|secret|token|password|diagnostic|log)/iu);

  const signMethod = source.indexOf("async _sign(file)");
  const nodeGuard = source.indexOf('operationClass === "node"', signMethod);
  const signerCall = source.indexOf("(0, windowsCodeSign_1.signWindows)", signMethod);
  const countIncrement = source.indexOf("windowsSigningOperationCounts[operationClass] += 1", signMethod);
  assert.equal(signMethod >= 0 && signMethod < nodeGuard && nodeGuard < signerCall, true);
  assert.equal(signerCall < countIncrement, true);
  assert.equal((source.match(/\(0, windowsCodeSign_1\.signWindows\)/g) ?? []).length, 1);
  assert.equal((source.match(/windowsSigningOperationCounts\[operationClass\] \+= 1/g) ?? []).length, 1);
  const signIfBody = source.slice(source.indexOf("async signIf(file)"), signMethod);
  assert.doesNotMatch(signIfBody, /signWindows|windowsSigningOperationCounts/u);
  await assert.rejects(
    () => appBuilder.WinPackager.prototype._sign.call({}, "x.node"),
    /native \.node signing attempt/u,
  );
  await assert.rejects(
    () => appBuilder.WinPackager.prototype._sign.call({}, "x.sys"),
    /unexpected signing class/u,
  );
  assert.match(source, /promises_1\.open\)\(ledgerPath, "wx"\)/u);
  assert.match(source, /!path\.isAbsolute\(value\)/u);
  assert.match(source, /windowsSigningOperationEvidenceRoot/u);
  assert.match(source, /windowsSigningOperationLedgerLeaf/u);
  assert.match(source, /path\.relative\(root, ledgerPath\)/u);
  assert.match(source, /canonical !== root/u);
  assert.match(source, /promises_1\.lstat/u);
  assert.match(source, /promises_1\.realpath/u);
  assert.match(source, /metadata\.nlink !== 1/u);
  assert.doesNotMatch(source, /promises_1\.mkdir/u);
  assert.match(source, /ledgerCount: 1/u);
  assert.match(source, /windowsSigningOperationLedgerWritten/u);
  assert.equal((source.match(/writeWindowsSigningOperationLedger\(/g) ?? []).length, 1);
  assert.match(platformSource, /finalizeSigningOperationLedger/u);
  assert.equal((platformSource.match(/await finalizeSigningOperationLedger\(\)/g) ?? []).length, 2);
  assert.match(platformSource, /subTaskManager\.awaitTasks\(\)/u);
  assert.match(platformSource, /cancellationToken\.cancelled/u);
  const targetBuild = platformSource.indexOf("await target.build(appOutDir, arch)");
  const ledgerFinalize = platformSource.indexOf("await finalizeSigningOperationLedger()", targetBuild);
  assert.equal(targetBuild >= 0 && ledgerFinalize > targetBuild, true);
});

test("the lockfile binds the exact reviewed patch and the patch contains one ledger implementation", () => {
  const patchHash = createHash("sha256").update(PATCH).digest("hex");
  const lockfile = readFileSync(LOCKFILE_PATH, "utf8");
  assert.match(lockfile, new RegExp(`app-builder-lib@26\\.15\\.7:\\s+${patchHash}`, "u"));
  assert.match(lockfile, new RegExp(`patch_hash=${patchHash}`, "u"));
  assert.equal((PATCH.match(/^diff --git a\/out\/winPackager\.js b\/out\/winPackager\.js$/gmu) ?? []).length, 1);
  assert.equal((PATCH.match(/tibotattle-windows-signing-operation-ledger-v1/g) ?? []).length, 1);
  assert.equal((PATCH.match(/ledgerCount: 1/g) ?? []).length, 1);
  assert.equal((PATCH.match(/promises_1\.open\)\(ledgerPath, "wx"\)/g) ?? []).length, 1);
  assert.equal((PATCH.match(/^diff --git a\/out\/platformPackager\.js b\/out\/platformPackager\.js$/gmu) ?? []).length, 1);
  assert.match(PATCH, /rejected a native \.node signing attempt/u);
  assert.match(PATCH, /rejected an unexpected signing class/u);
  assert.doesNotMatch(PATCH, /process\.env|AZURE_CLIENT_SECRET|CSC_LINK|PFX/u);
});
