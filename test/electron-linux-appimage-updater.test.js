import assert from "node:assert/strict";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseArguments,
  runSelfTest,
} from "../scripts/smoke-electron-linux-appimage-updater.mjs";

const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";

test("Linux AppImage updater smoke arguments keep self-test and execution lanes closed", () => {
  const parsed = parseArguments(["--self-test", "--receipt", "/tmp/linux-updater-receipt.json"]);
  assert.deepEqual(parsed, {
    mode: "self-test",
    receiptPath: "/tmp/linux-updater-receipt.json",
    currentAppImage: null,
    nextAppImage: null,
    currentVersion: null,
    nextVersion: null,
    sourceRevision: null,
    buildNumber: null,
  });
  assert.throws(
    () => parseArguments(["--self-test", "--current-appimage", "/tmp/current.AppImage"]),
    { code: "ELECTRON_LINUX_APPIMAGE_UPDATER_SMOKE_ARGUMENT_INVALID" },
  );
  assert.throws(
    () => parseArguments(["--self-test", "--self-test", "--receipt", "/tmp/receipt.json"]),
    { code: "ELECTRON_LINUX_APPIMAGE_UPDATER_SMOKE_ARGUMENT_INVALID" },
  );
  assert.throws(
    () => parseArguments([
      "--execute",
      "--receipt", "/tmp/receipt.json",
      "--current-appimage", "/tmp/current.AppImage",
      "--next-appimage", "/tmp/next.AppImage",
      "--current-version", "0.1.18",
      "--next-version", "0.1.19",
      "--source-revision", SOURCE_REVISION,
      "--build-number", "1",
    ]),
    { code: "ELECTRON_LINUX_APPIMAGE_UPDATER_SMOKE_REAL_PRODUCT_EXECUTION_REQUIRES_ISOLATED_LANE" },
  );
});

test("Linux AppImage updater self-test proves the adapter boundary and claim limits", {
  skip: process.platform !== "linux" || process.arch !== "x64"
    ? "requires the pinned Linux x64 runner"
    : false,
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-updater-test-"));
  const receiptPath = join(root, "receipt.json");
  try {
    const receipt = await runSelfTest(receiptPath);
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.target, "linux-x64");
    assert.equal(receipt.updaterVersion, "6.8.9");
    assert.equal(receipt.httpExecutor, "builder-util-runtime-9.7.0-digest-transform");
    assert.equal(receipt.nodeQuitShim, true);
    assert.deepEqual(receipt.feedRequests, { latest: 1, artifact: 1, unexpected: 0 });
    assert.equal(receipt.replacement, "isolated-clone-only");
    assert.equal(receipt.network, "loopback-only");
    assert.equal(receipt.productionFeed, "untouched");
    assert.equal(receipt.sourceRevisionKind, "synthetic-fixture");
    assert.equal(receipt.productInstalledIntegration, "not_verified");
    assert.equal(receipt.realElectronProductLaunch, "not_verified");
    assert.equal(receipt.nativeCredentialQualification, "not_exercised");
    assert.equal(receipt.notifications, "not_exercised");
    assert.equal(receipt.sourceInputsUnchanged, true);
    assert.match(receipt.claimLimit, /no installed product update claim/u);
    assert.notEqual(receipt.currentSourceSha256, receipt.nextSourceSha256);
    assert.equal(receipt.replacedCloneSha256, receipt.nextSourceSha256);
    const details = await lstat(receiptPath);
    assert.equal(details.isFile(), true);
    assert.equal(details.nlink, 1);
    assert.equal(details.mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
