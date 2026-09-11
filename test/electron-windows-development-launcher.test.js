import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildWindowsDevelopmentEnvironment,
  buildWindowsDevelopmentLaunchSpec,
  parseWindowsDevelopmentLaunchArguments,
  prepareWindowsDevelopmentProfile,
  runWindowsDevelopmentLaunch,
  WINDOWS_ELECTRON_BINDING_RELATIVE_PATH as LAUNCHER_BINDING_PATH,
  WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH as LAUNCHER_KEYTAR_PATH,
  WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_KEY as LAUNCHER_ENVIRONMENT_KEY,
  WINDOWS_ELECTRON_QUALIFICATION_MARKER as LAUNCHER_MARKER,
  WINDOWS_ELECTRON_TEST_LANE as LAUNCHER_TEST_LANE,
} from "../scripts/launch-electron-windows-development.mjs";
import {
  WINDOWS_ELECTRON_BINDING_RELATIVE_PATH,
  WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH,
  WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_KEY,
  WINDOWS_ELECTRON_QUALIFICATION_MARKER,
  WINDOWS_ELECTRON_TEST_LANE,
} from "../apps/electron/windows-qualification.js";

test("Windows development distribution wrapper is self-contained", async () => {
  const wrapper = await readFile(
    new URL("../scripts/launch-electron-windows-development.cmd", import.meta.url),
    "utf8",
  );
  assert.match(wrapper, /^@echo off\r?\n/u);
  assert.match(wrapper, /set "APP=%~dp0win-unpacked\\TiboTattle Dev\.exe"/u);
  assert.match(wrapper, /set "LAUNCHER=%~dp0TiboTattle-Windows-Development-Launcher\.mjs"/u);
  assert.match(wrapper, /set "PROFILE=%LOCALAPPDATA%\\TiboTattle\\electron-user-test\\win32-x64\\profile"/u);
  assert.match(wrapper, /set "ELECTRON_RUN_AS_NODE=1"/u);
  assert.match(wrapper, /"%APP%" "%LAUNCHER%" --app "%APP%" --profile "%PROFILE%"/u);
  assert.match(wrapper, /set "ELECTRON_RUN_AS_NODE="/u);
  assert.match(wrapper, /exit \/b %EXIT_CODE%/u);
  assert.doesNotMatch(wrapper, /(?:--)?source|(?:^|[\\/])node(?:\.exe)?\b/iu);
});

test("Windows development launcher parses one absolute app and isolated profile", () => {
  assert.equal(LAUNCHER_BINDING_PATH, WINDOWS_ELECTRON_BINDING_RELATIVE_PATH);
  assert.equal(LAUNCHER_KEYTAR_PATH, WINDOWS_ELECTRON_KEYTAR_RELATIVE_PATH);
  assert.equal(LAUNCHER_ENVIRONMENT_KEY, WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_KEY);
  assert.equal(LAUNCHER_MARKER, WINDOWS_ELECTRON_QUALIFICATION_MARKER);
  assert.equal(LAUNCHER_TEST_LANE, WINDOWS_ELECTRON_TEST_LANE);
  const options = parseWindowsDevelopmentLaunchArguments([
    "--app",
    "/candidate/TiboTattle Dev.exe",
    "--profile",
    "/private/profile",
    "--dry-run",
  ]);
  assert.deepEqual(options, {
    help: false,
    appPath: "/candidate/TiboTattle Dev.exe",
    profilePath: "/private/profile",
    dryRun: true,
  });
  assert.throws(
    () => parseWindowsDevelopmentLaunchArguments(["--app", "TiboTattle Dev.exe"]),
    /ELECTRON_WINDOWS_DEVELOPMENT_ARGUMENT_INVALID/u,
  );
  assert.throws(
    () => parseWindowsDevelopmentLaunchArguments([
      "--app",
      "/candidate/TiboTattle Dev.exe",
      "--app",
      "/other/TiboTattle Dev.exe",
    ]),
    /ELECTRON_WINDOWS_DEVELOPMENT_ARGUMENT_INVALID/u,
  );
});

test("Windows development profile and child environment stay private and credential-free", async () => {
  const root = await mkdtemp(join(
    await realpath(tmpdir()),
    "tibotattle-electron-windows-launcher-",
  ));
  try {
    const appPath = join(root, "candidate", "TiboTattle Dev.exe");
    const profilePath = join(root, "profile");
    const profile = await prepareWindowsDevelopmentProfile({ appPath, profilePath });
    const environment = buildWindowsDevelopmentEnvironment({
      profile,
      environment: {
        PATH: "/safe/bin",
        HOME: "/untrusted/home",
        GH_TOKEN: "secret",
        USAGE_MONITOR_CENTRAL_ORIGIN: "https://example.invalid",
        NODE_OPTIONS: "--require=private.js",
      },
    });
    assert.equal(environment.PATH, "/safe/bin");
    assert.equal(environment.HOME, profile.home);
    assert.equal(environment.USAGE_MONITOR_STATE_ROOT, profile.state);
    assert.equal(
      environment[WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_KEY],
      WINDOWS_ELECTRON_QUALIFICATION_MARKER,
    );
    assert.equal(environment.USAGE_MONITOR_TEST_LANE, WINDOWS_ELECTRON_TEST_LANE);
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.USAGE_MONITOR_CENTRAL_ORIGIN, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);

    const spec = buildWindowsDevelopmentLaunchSpec({
      appPath,
      profile,
      environment: { PATH: "/safe/bin" },
    });
    assert.deepEqual(spec.args, [`--user-data-dir=${profile.userData}`]);
    assert.equal(spec.options.shell, false);
    assert.equal(spec.options.windowsHide, true);
    assert.equal(spec.options.env.HOME, profile.home);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Windows development dry-run stays an explicit non-production handoff", async () => {
  const result = await runWindowsDevelopmentLaunch({
    options: parseWindowsDevelopmentLaunchArguments([
      "--app",
      "/candidate/TiboTattle Dev.exe",
      "--dry-run",
    ]),
    platform: "darwin",
    architecture: "arm64",
  });
  assert.deepEqual(result, {
    status: "dry_run",
    target: "win32-x64",
    windowsQualificationRequested: true,
    windowsProductionReady: false,
    profileIsolated: true,
    hostedContribution: false,
    credentialSmoke: false,
  });
});
