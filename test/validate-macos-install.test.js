import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { RELEASE_MANIFEST } from "../config/release-manifest.js";
import {
  main,
  parseArguments,
} from "../scripts/validate-macos-install.js";

const APP_PATH = resolve("TiboTattle.app");
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
    options: { channel: "stable", production: true },
  }]);
});
