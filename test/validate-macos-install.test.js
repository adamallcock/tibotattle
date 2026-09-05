import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { RELEASE_MANIFEST } from "../config/release-manifest.js";
import { parseArguments as parseReleaseArguments } from "../scripts/release-macos-app.js";
import { parseArguments as parseDMGArguments } from "../scripts/package-macos-dmg.js";
import {
  main,
  parseArguments,
} from "../scripts/validate-macos-install.js";

const APP_PATH = resolve("TiboTattle.app");
const PREVIEW_APP_PATH = resolve("TiboTattle Preview.app");
const DMG_PATH = resolve("TiboTattle.dmg");

test("Intel release and packaging CLIs preserve explicit architecture through validation", async () => {
  const runtime = resolve("synthetic-intel/bin/node");
  const release = parseReleaseArguments([
    "--app", APP_PATH, "--channel", "stable", "--architecture", "x64",
    "--node-runtime", runtime, "--stable-bootstrap",
  ]);
  assert.equal(release.architecture, "x64");
  assert.equal(release.nodeRuntime, runtime);
  assert.equal(release.stableBootstrap, true);
  assert.equal(release.output, resolve(".release-build/macos-release", RELEASE_MANIFEST.macOS.x64DmgFileName));
  assert.throws(() => parseReleaseArguments([
    "--app", APP_PATH, "--channel", "stable", "--architecture", "x64",
  ]), /require --node-runtime/u);
  assert.throws(() => parseReleaseArguments([
    "--app", APP_PATH, "--channel", "stable", "--node-runtime", runtime,
  ]), /ARM releases use/u);
  const dmg = parseDMGArguments(["--app", APP_PATH, "--development", "--architecture", "x64"]);
  assert.equal(dmg.architecture, "x64");
  assert.match(dmg.output, /-macOS-x64-development\.dmg$/u);
  const validation = parseArguments(["--release", "--channel", "stable", "--architecture", "x64"]);
  assert.equal(validation.architecture, "x64");
  assert.equal(validation.dmgPath, release.output);
  await assert.rejects(main([
    "--app", APP_PATH, "--channel", "stable", "--architecture", "x64", "--development",
  ], {
    async validateInstalledMacOSApp(path, options) {
      assert.equal(path, APP_PATH);
      assert.equal(options.architecture, "x64");
      assert.equal(options.production, false);
      throw Object.assign(new Error("selected Intel"), { code: "INTEL_VALIDATION_SELECTED" });
    },
  }), { code: "INTEL_VALIDATION_SELECTED" });
});

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
      architecture: "arm64",
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
      architecture: "arm64",
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
      architecture: "arm64",
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
      architecture: "arm64",
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
      architecture: "arm64",
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
      architecture: "arm64",
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
          architecture: "arm64",
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
