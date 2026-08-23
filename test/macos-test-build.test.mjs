import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MACOS_BUILD_PROFILES,
  buildMacOSApp,
} from "../scripts/build-macos-app.js";

const BUILD_SUPPORTED =
  process.platform === "darwin"
  && process.arch === "arm64"
  && process.version === "v26.2.0";

test("test compiler profile builds a development-only launcher that runs", {
  skip: BUILD_SUPPORTED ? false : "requires pinned macOS arm64 Node v26.2.0 builder",
  timeout: 90_000,
}, async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-macos-test-profile-"),
  );
  const output = join(temporaryRoot, "TiboTattle.app");
  try {
    const build = await buildMacOSApp({
      output,
      buildProfile: MACOS_BUILD_PROFILES.test,
    });
    assert.deepEqual(
      {
        buildProfile: build.buildProfile,
        channel: build.channel,
        externalDistributionRequested: build.externalDistributionRequested,
        updaterEnabled: build.updaterEnabled,
      },
      {
        buildProfile: MACOS_BUILD_PROFILES.test,
        channel: "development",
        externalDistributionRequested: false,
        updaterEnabled: false,
      },
    );
    const launcher = join(output, "Contents", "MacOS", "TiboTattle");
    const smoke = spawnSync(launcher, ["--updater-contract-smoke-test"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(smoke.status, 0, smoke.error?.message ?? smoke.stderr);
    assert.match(smoke.stdout, /runtime=development_disabled/u);
    const progressSmoke = spawnSync(
      launcher,
      ["--native-analysis-progress-contract-smoke-test"],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(
      progressSmoke.status,
      0,
      progressSmoke.error?.message ?? progressSmoke.stderr,
    );
    assert.match(
      progressSmoke.stdout,
      /phases=allowlisted[\s\S]*counts=bounded[\s\S]*unknown=generic[\s\S]*free_text=ignored/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
