import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertLinuxDevelopmentPackageLayout,
  buildLinuxDevelopmentEnvironment,
  buildLinuxDevelopmentLaunchSpec,
  LINUX_DEVELOPMENT_APPIMAGE_PATTERN,
  LINUX_DEVELOPMENT_TARGET,
  parseLinuxDevelopmentLaunchArguments,
  prepareLinuxDevelopmentProfile,
  runLinuxDevelopmentLaunch,
} from "../scripts/launch-electron-linux-development.mjs";

async function fakeUnpackedApp(root) {
  const app = join(root, "linux-unpacked", "tibotattle-dev");
  const resources = join(root, "linux-unpacked", "resources");
  await mkdir(join(resources, "app.asar.unpacked"), { recursive: true, mode: 0o755 });
  await writeFile(app, "synthetic executable\n", { mode: 0o755 });
  await writeFile(join(resources, "app.asar"), "synthetic asar\n", { mode: 0o644 });
  await chmod(app, 0o755);
  return app;
}

test("Linux development launcher parses only an explicit x64 candidate and profile", () => {
  assert.equal(LINUX_DEVELOPMENT_TARGET, "linux-x64");
  assert.equal(LINUX_DEVELOPMENT_APPIMAGE_PATTERN.test(
    "TiboTattle-Dev-0.1.18-linux-x86_64.AppImage",
  ), true);
  const options = parseLinuxDevelopmentLaunchArguments([
    "--app",
    "/candidate/tibotattle-dev",
    "--profile",
    "/private/profile",
    "--dry-run",
  ]);
  assert.deepEqual(options, {
    help: false,
    appPath: "/candidate/tibotattle-dev",
    profilePath: "/private/profile",
    dryRun: true,
  });
  assert.throws(
    () => parseLinuxDevelopmentLaunchArguments(["--app", "tibotattle-dev"]),
    /ELECTRON_LINUX_DEVELOPMENT_ARGUMENT_INVALID/u,
  );
  assert.throws(
    () => parseLinuxDevelopmentLaunchArguments([
      "--app",
      "/candidate/tibotattle-dev",
      "--app",
      "/other/tibotattle-dev",
    ]),
    /ELECTRON_LINUX_DEVELOPMENT_ARGUMENT_INVALID/u,
  );
});

test("Linux development profile and child environment stay private and credential-free", async () => {
  const root = await mkdtemp(join(
    await realpath(tmpdir()),
    "tibotattle-electron-linux-launcher-",
  ));
  try {
    const appPath = await fakeUnpackedApp(root);
    const profilePath = join(root, "profile");
    const profile = await prepareLinuxDevelopmentProfile({ appPath, profilePath });
    const environment = buildLinuxDevelopmentEnvironment({
      profile,
      environment: {
        PATH: "/safe/bin",
        DISPLAY: ":99",
        XDG_RUNTIME_DIR: "/run/user/1000",
        HOME: "/untrusted/home",
        GH_TOKEN: "secret",
        APP_USAGEMONITOR_EXPORT_SECRET: "secret",
        USAGE_MONITOR_CENTRAL_ORIGIN: "https://example.invalid",
        NODE_OPTIONS: "--require=private.js",
      },
    });
    assert.equal(environment.PATH, "/safe/bin");
    assert.equal(environment.DISPLAY, ":99");
    assert.equal(environment.HOME, profile.home);
    assert.equal(environment.TMPDIR, profile.tmp);
    assert.equal(environment.CODEX_HOME, profile.codex);
    assert.equal(environment.USAGE_MONITOR_STATE_ROOT, profile.state);
    assert.equal(environment.XDG_RUNTIME_DIR, "/run/user/1000");
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.APP_USAGEMONITOR_EXPORT_SECRET, undefined);
    assert.equal(environment.USAGE_MONITOR_CENTRAL_ORIGIN, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(JSON.stringify(environment).includes("secret"), false);

    const spec = buildLinuxDevelopmentLaunchSpec({
      appPath,
      profile,
      environment: { PATH: "/safe/bin", DISPLAY: ":99" },
    });
    assert.deepEqual(spec.args, [`--user-data-dir=${profile.userData}`]);
    assert.equal(spec.options.shell, false);
    assert.equal(spec.options.env.HOME, profile.home);
    assert.equal(spec.options.env.USAGE_MONITOR_CENTRAL_ORIGIN, undefined);
    assert.equal(spec.args.includes("--no-sandbox"), false);
    const metadata = await lstat(profile.root);
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o077, 0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Linux development launcher keeps production and credential qualification closed", async () => {
  const dryRun = await runLinuxDevelopmentLaunch({
    options: parseLinuxDevelopmentLaunchArguments([
      "--app",
      "/candidate/tibotattle-dev",
      "--dry-run",
    ]),
    platform: "darwin",
    architecture: "arm64",
  });
  assert.deepEqual(dryRun, {
    status: "dry_run",
    target: "linux-x64",
    linuxProductionReady: false,
    profileIsolated: true,
    hostedContribution: false,
    credentialSmoke: false,
    sandboxDisablingArgs: false,
  });
});

test("Linux development launcher requires a native x64 display and launches only the fixed profile argument", async () => {
  const root = await mkdtemp(join(
    await realpath(tmpdir()),
    "tibotattle-electron-linux-launcher-run-",
  ));
  try {
    const appPath = await fakeUnpackedApp(root);
    const profilePath = join(root, "profile");
    const spawnCalls = [];
    const child = new EventEmitter();
    const resultPromise = runLinuxDevelopmentLaunch({
      options: parseLinuxDevelopmentLaunchArguments([
        "--app",
        appPath,
        "--profile",
        profilePath,
      ]),
      platform: "linux",
      architecture: "x64",
      environment: {
        PATH: "/safe/bin",
        DISPLAY: ":99",
        HOME: "/untrusted/home",
        GH_TOKEN: "secret",
      },
      spawnProcess(command, args, options) {
        spawnCalls.push({ command, args, options });
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      },
    });
    const result = await resultPromise;
    assert.deepEqual(result, {
      status: "exited",
      exitCode: 0,
      target: "linux-x64",
    });
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, appPath);
    assert.deepEqual(spawnCalls[0].args, [
      `--user-data-dir=${profilePath}/user-data`,
    ]);
    assert.equal(spawnCalls[0].options.shell, false);
    assert.equal(spawnCalls[0].options.env.HOME, `${profilePath}/home`);
    assert.equal(spawnCalls[0].options.env.GH_TOKEN, undefined);

    await assert.rejects(
      runLinuxDevelopmentLaunch({
        options: parseLinuxDevelopmentLaunchArguments([
          "--app",
          appPath,
          "--profile",
          join(root, "no-display-profile"),
        ]),
        platform: "linux",
        architecture: "x64",
        environment: { PATH: "/safe/bin" },
        spawnProcess() {
          throw new Error("must not launch without a display");
        },
      }),
      /ELECTRON_LINUX_DEVELOPMENT_DISPLAY_UNAVAILABLE/u,
    );
    await assert.rejects(
      assertLinuxDevelopmentPackageLayout({
        appPath,
        platform: "darwin",
        architecture: "arm64",
      }),
      /ELECTRON_LINUX_DEVELOPMENT_PACKAGE_INVALID/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
