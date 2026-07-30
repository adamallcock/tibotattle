import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  SPARKLE_FRAMEWORK_SHA256,
  SPARKLE_VERSION,
  normalizeMacOSUpdaterConfiguration,
} from "../scripts/macos-updater-core.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("prepared dependency enables the complete external updater contract", async () => {
  const preparedFramework = join(
    REPOSITORY_ROOT,
    ".release-deps",
    "Sparkle.framework",
  );
  const metadata = await lstat(preparedFramework);
  assert.equal(metadata.isDirectory(), true);
  const publicEdKey = Buffer.alloc(32, 7).toString("base64");
  const configured = await normalizeMacOSUpdaterConfiguration({
    appcastURL: "https://updates.example.test/usage-monitor/appcast.xml",
    externalDistribution: true,
    frameworkPath: preparedFramework,
    publicEdKey,
  });
  assert.equal(configured.enabled, true);
  assert.equal(
    configured.appcastURL,
    "https://updates.example.test/usage-monitor/appcast.xml",
  );
  assert.equal(configured.publicEdKey, publicEdKey);
  assert.equal(configured.framework.sha256, SPARKLE_FRAMEWORK_SHA256);
  assert.equal(configured.version, SPARKLE_VERSION);

  const reused = spawnSync(process.execPath, [
    join(REPOSITORY_ROOT, "scripts", "prepare-sparkle-framework.js"),
    "--output",
    preparedFramework,
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(reused.status, 0, reused.stderr || reused.stdout);
  assert.match(reused.stdout, /verified and reused/u);
});
