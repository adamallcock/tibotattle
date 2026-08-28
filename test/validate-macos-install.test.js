import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { RELEASE_MANIFEST } from "../config/release-manifest.js";
import {
  main,
  parseArguments,
} from "../scripts/validate-macos-install.js";

const APP_PATH = resolve("TiboTattle.app");
const PREVIEW_APP_PATH = resolve("TiboTattle Preview.app");
const DMG_PATH = resolve("TiboTattle.dmg");

test("production installed-app validation requires and resolves a named channel", () => {
  assert.throws(
    () => parseArguments(["--app", APP_PATH]),
    /--channel is required/u,
  );
  assert.throws(
    () => parseArguments(["--app", APP_PATH, "--channel", "not-a-channel"]),
    { code: "RELEASE_CHANNEL_UNKNOWN" },
  );
  assert.deepEqual(
    parseArguments(["--app", APP_PATH, "--channel", "stable"]),
    {
      appPath: APP_PATH,
      channel: "stable",
      distribution: "release",
      dmgPath: null,
      production: true,
    },
  );
});

test("production DMG and release validation also require an explicit channel", () => {
  assert.throws(
    () => parseArguments(["--dmg", DMG_PATH]),
    /--channel is required/u,
  );
  assert.throws(
    () => parseArguments(["--release"]),
    /--channel is required/u,
  );
  assert.deepEqual(
    parseArguments(["--release", "--channel", "stable"]),
    {
      appPath: null,
      channel: "stable",
      distribution: "release",
      dmgPath: resolve(
        ".release-build/macos-release",
        RELEASE_MANIFEST.macOS.arm64DmgFileName,
      ),
      production: true,
    },
  );
});

test("development validation remains non-release when an explicit stable channel is given", () => {
  assert.throws(
    () => parseArguments(["--app", APP_PATH, "--development"]),
    /--channel is required/u,
  );
  assert.deepEqual(
    parseArguments([
      "--app",
      APP_PATH,
      "--development",
      "--channel",
      "stable",
    ]),
    {
      appPath: APP_PATH,
      channel: "stable",
      distribution: "development",
      dmgPath: null,
      production: false,
    },
  );
});

test("the resolved channel is passed into installed-app validation and mismatches remain fatal", async () => {
  const calls = [];
  const mismatch = Object.assign(
    new Error("Release app does not match the named stable channel"),
    { code: "MACOS_RELEASE_CHANNEL_MISMATCH" },
  );
  await assert.rejects(
    main(["--app", APP_PATH, "--channel", "stable"], {
      validateInstalledMacOSApp: async (appPath, options) => {
        calls.push({ appPath, options: { ...options } });
        assert.equal(options.channel, "stable");
        throw mismatch;
      },
    }),
    { code: "MACOS_RELEASE_CHANNEL_MISMATCH" },
  );
  assert.deepEqual(calls, [{
    appPath: APP_PATH,
    options: {
      channel: "stable",
      distribution: "release",
      production: true,
    },
  }]);
});

test("preview validation requires its isolated distribution channel and mode", () => {
  assert.throws(
    () => parseArguments([
      "--app", PREVIEW_APP_PATH, "--preview", "--channel", "stable",
    ]),
    /--preview requires --channel preview_distribution/u,
  );
  assert.throws(
    () => parseArguments([
      "--app", PREVIEW_APP_PATH, "--preview", "--development",
      "--channel", "preview_distribution",
    ]),
    /mutually exclusive/u,
  );
  assert.deepEqual(
    parseArguments([
      "--app", PREVIEW_APP_PATH, "--preview",
      "--channel", "preview_distribution",
    ]),
    {
      appPath: PREVIEW_APP_PATH,
      channel: "preview_distribution",
      distribution: "preview",
      dmgPath: null,
      production: false,
    },
  );
  assert.deepEqual(
    parseArguments([
      "--dmg", DMG_PATH, "--preview", "--channel", "preview_distribution",
    ]),
    {
      appPath: null,
      channel: "preview_distribution",
      distribution: "preview",
      dmgPath: DMG_PATH,
      production: false,
    },
  );
});

test("preview app validation cannot fall through to the stable validator", async () => {
  const sentinel = Object.assign(new Error("preview checked"), {
    code: "PREVIEW_CHECKED",
  });
  await assert.rejects(
    main([
      "--app", PREVIEW_APP_PATH, "--preview",
      "--channel", "preview_distribution",
    ], {
      validateInstalledMacOSApp: async () => assert.fail(
        "stable validator must not inspect a preview app",
      ),
      validateMacOSPreviewApp: async (appPath) => {
        assert.equal(appPath, PREVIEW_APP_PATH);
        throw sentinel;
      },
    }),
    { code: "PREVIEW_CHECKED" },
  );
});

test("preview DMG validation carries the preview distribution boundary", async () => {
  const sentinel = Object.assign(new Error("preview DMG checked"), {
    code: "PREVIEW_DMG_CHECKED",
  });
  await assert.rejects(
    main([
      "--dmg", DMG_PATH, "--preview", "--channel", "preview_distribution",
    ], {
      validateMacOSDMG: async (dmgPath, options) => {
        assert.equal(dmgPath, DMG_PATH);
        assert.deepEqual(options, {
          channel: "preview_distribution",
          distribution: "preview",
          production: false,
        });
        throw sentinel;
      },
    }),
    { code: "PREVIEW_DMG_CHECKED" },
  );
});
