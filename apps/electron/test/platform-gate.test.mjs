import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProductionDistributionMetadata,
  validateProductionDistributionMetadata,
} from "../desktop-updater.js";
import {
  ElectronShellError,
} from "../errors.js";
import {
  launchElectronShell,
} from "../main.js";
import {
  assertElectronPlatformGate,
} from "../platform-gate.js";

function refusal(code) {
  return (error) => {
    assert.equal(error instanceof ElectronShellError, true);
    assert.equal(error.code, `electron_shell_${code}`);
    assert.equal(error.message, "Electron shell operation failed");
    return true;
  };
}

async function withRuntimePlatform({ platform, architecture }, callback) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const architectureDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  Object.defineProperty(process, "arch", { ...architectureDescriptor, value: architecture });
  try {
    return await callback();
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    Object.defineProperty(process, "arch", architectureDescriptor);
  }
}

test("Linux development remains available while every stable packaged selection fails before composition", () => {
  assert.deepEqual(assertElectronPlatformGate({
    platform: "linux",
    architecture: "x64",
  }), {
    platform: "linux",
    architecture: "x64",
    windowsProductionReady: false,
  });

  const productionDistribution = createProductionDistributionMetadata({
    target: "linux-x64",
    sourceRevision: "a".repeat(40),
    buildNumber: "2026090701",
  });
  assert.deepEqual(validateProductionDistributionMetadata(productionDistribution, {
    platform: "linux",
    architecture: "x64",
  }), productionDistribution);

  assert.throws(
    () => assertElectronPlatformGate({
      platform: "linux",
      architecture: "x64",
      qualificationContext: { developmentOnly: true },
      productionDistribution,
    }),
    refusal("linux_readiness_unavailable"),
  );
});

test("a packaged Linux stable manifest quits before companion or credential composition", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-production-gate-"));
  const productionDistribution = createProductionDistributionMetadata({
    target: "linux-x64",
    sourceRevision: "b".repeat(40),
    buildNumber: "2026090702",
  });
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({
      tibotattleDistribution: productionDistribution,
    }));
    const app = new EventEmitter();
    app.isPackaged = true;
    app.getName = () => "TiboTattle";
    app.getAppPath = () => root;
    app.quitCalls = 0;
    app.quit = () => { app.quitCalls += 1; };

    await withRuntimePlatform({ platform: "linux", architecture: "x64" }, async () => {
      await assert.rejects(
        launchElectronShell({ electron: { app }, environment: {} }),
        refusal("linux_readiness_unavailable"),
      );
    });
    assert.equal(app.quitCalls, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
