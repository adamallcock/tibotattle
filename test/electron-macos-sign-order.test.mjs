import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  orderMacOSSigningChildren,
  readCFBundleExecutable,
  signWithCFBundleExecutableOrder,
} from "../scripts/electron-macos-sign-order.mjs";

const ROOT_APP = "/synthetic/TiboTattle.app";

function executableReader(entries) {
  return async (bundlePath) => entries.get(bundlePath);
}

test("orders a same-directory helper before the actual CFBundleExecutable", async () => {
  const main = join(ROOT_APP, "Contents", "MacOS", "TiboTattle");
  const helper = join(ROOT_APP, "Contents", "MacOS", "TiboTattleNativeHandover");
  const nestedBinary = join(ROOT_APP, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework");
  const ordered = await orderMacOSSigningChildren([main, helper, nestedBinary], {
    appPath: ROOT_APP,
    readBundleExecutable: executableReader(new Map([[ROOT_APP, "TiboTattle"]])),
  });
  assert.deepEqual(ordered, [nestedBinary, helper, main]);
});

test("uses each nested app's own CFBundleExecutable before its enclosing bundle", async () => {
  const nestedApp = join(ROOT_APP, "Contents", "Frameworks", "TiboTattle Renderer.app");
  const outerMain = join(ROOT_APP, "Contents", "MacOS", "TiboTattle");
  const outerHelper = join(ROOT_APP, "Contents", "MacOS", "TiboTattleNativeHandover");
  const nestedMain = join(nestedApp, "Contents", "MacOS", "TiboTattle Renderer");
  const nestedHelper = join(nestedApp, "Contents", "MacOS", "RendererBridge");
  const ordered = await orderMacOSSigningChildren([
    outerMain,
    outerHelper,
    nestedApp,
    nestedMain,
    nestedHelper,
  ], {
    appPath: ROOT_APP,
    readBundleExecutable: executableReader(new Map([
      [ROOT_APP, "TiboTattle"],
      [nestedApp, "TiboTattle Renderer"],
    ])),
  });
  assert.deepEqual(ordered, [nestedHelper, nestedMain, outerHelper, nestedApp, outerMain]);
});

test("refuses ambiguous discovery and unsafe bundle executable metadata", async () => {
  const main = join(ROOT_APP, "Contents", "MacOS", "TiboTattle");
  await assert.rejects(
    () => orderMacOSSigningChildren([main, main], {
      appPath: ROOT_APP,
      readBundleExecutable: executableReader(new Map([[ROOT_APP, "TiboTattle"]])),
    }),
    (error) => error?.code === "ELECTRON_MACOS_SIGN_ORDER_DISCOVERY_INVALID",
  );
  await assert.rejects(
    () => orderMacOSSigningChildren([main], {
      appPath: ROOT_APP,
      readBundleExecutable: executableReader(new Map([[ROOT_APP, "../TiboTattle"]])),
    }),
    (error) => error?.code === "ELECTRON_MACOS_SIGN_ORDER_BUNDLE_EXECUTABLE_INVALID",
  );
});

test("restores the pinned walk function after the signer fails", async () => {
  const main = join(ROOT_APP, "Contents", "MacOS", "TiboTattle");
  const helper = join(ROOT_APP, "Contents", "MacOS", "TiboTattleNativeHandover");
  const originalWalk = async () => [main, helper];
  const expectedFailure = new Error("synthetic signer failure");
  const observed = [];
  const runtime = {
    readBundleExecutable: executableReader(new Map([[ROOT_APP, "TiboTattle"]])),
    util: { walkAsync: originalWalk },
    sign: async (signOptions) => {
      assert.equal(signOptions.identity, "synthetic-identity");
      assert.equal(signOptions.strictVerify, true);
      observed.push(await runtime.util.walkAsync(join(ROOT_APP, "Contents")));
      throw expectedFailure;
    },
  };
  await assert.rejects(
    () => signWithCFBundleExecutableOrder({
      app: ROOT_APP,
      identity: "synthetic-identity",
      strictVerify: true,
    }, runtime),
    (error) => error === expectedFailure,
  );
  assert.deepEqual(observed, [[helper, main]]);
  assert.equal(runtime.util.walkAsync, originalWalk);
  assert.deepEqual(await runtime.util.walkAsync(join(ROOT_APP, "Contents")), [main, helper]);
});

test("restores the pinned walk function when bundle metadata is refused", async () => {
  const main = join(ROOT_APP, "Contents", "MacOS", "TiboTattle");
  const originalWalk = async () => [main];
  const runtime = {
    readBundleExecutable: executableReader(new Map([[ROOT_APP, "../TiboTattle"]])),
    util: { walkAsync: originalWalk },
    sign: async () => runtime.util.walkAsync(join(ROOT_APP, "Contents")),
  };
  await assert.rejects(
    () => signWithCFBundleExecutableOrder({ app: ROOT_APP }, runtime),
    (error) => error?.code === "ELECTRON_MACOS_SIGN_ORDER_BUNDLE_EXECUTABLE_INVALID",
  );
  assert.equal(runtime.util.walkAsync, originalWalk);
});

test("reads a regular CFBundleExecutable plist without signing", {
  skip: process.platform === "darwin" ? false : "plutil is a macOS-only production dependency",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-sign-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "TiboTattle.app");
  const contents = join(app, "Contents");
  await mkdir(contents, { recursive: true });
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>TiboTattle</string>
</dict></plist>\n`, { mode: 0o600 });
  assert.equal(await readCFBundleExecutable(app), "TiboTattle");
});
