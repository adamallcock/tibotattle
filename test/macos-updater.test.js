import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  SPARKLE_ARCHIVE_SHA256,
  SPARKLE_ARCHIVE_URL,
  SPARKLE_FRAMEWORK_SHA256,
  SPARKLE_LICENSE_SHA256,
  SPARKLE_TOOL_FILES,
  SPARKLE_TOOLS_DIRECTORY_NAME,
  SPARKLE_VERSION,
  inspectPinnedSparkleFramework,
  inspectPinnedSparkleTools,
  normalizeMacOSUpdaterConfiguration,
  normalizeMacOSUpdaterMetadata,
} from "../scripts/macos-updater-core.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("Sparkle dependency is exact, licensed, and development-disabled", async () => {
  assert.equal(SPARKLE_VERSION, "2.9.3");
  assert.equal(
    SPARKLE_ARCHIVE_URL,
    "https://github.com/sparkle-project/Sparkle/releases/download/2.9.3/Sparkle-2.9.3.tar.xz",
  );
  assert.equal(
    SPARKLE_ARCHIVE_SHA256,
    "74a07da821f92b79310009954c0e15f350173374a3abe39095b4fc5096916be6",
  );
  assert.equal(
    SPARKLE_FRAMEWORK_SHA256,
    "2a43f8c41a29b195982354d7580036c178ed89e3b3e5dc0d8ab295290d91a0ac",
  );
  assert.equal(
    createHash("sha256").update(await readFile(join(
      REPOSITORY_ROOT,
      "third_party_licenses",
      "sparkle-2.9.3.txt",
    ))).digest("hex"),
    SPARKLE_LICENSE_SHA256,
  );
  assert.deepEqual(
    await normalizeMacOSUpdaterConfiguration({
      externalDistribution: false,
    }),
    {
      appcastURL: null,
      automaticChecks: false,
      automaticUpdatesEnabledByDefault: false,
      allowsAutomaticUpdateOptIn: false,
      enabled: false,
      framework: null,
      publicEdKey: null,
      version: null,
    },
  );
  await assert.rejects(
    normalizeMacOSUpdaterConfiguration({
      appcastURL: "https://updates.example/appcast.xml",
      externalDistribution: false,
    }),
    { code: "MACOS_UPDATER_FORBIDDEN_IN_DEVELOPMENT" },
  );
  await assert.rejects(
    normalizeMacOSUpdaterConfiguration({
      externalDistribution: true,
    }),
    { code: "MACOS_UPDATER_REQUIRED_FOR_DISTRIBUTION" },
  );
  await assert.rejects(
    normalizeMacOSUpdaterConfiguration({
      previewDistribution: true,
    }),
    { code: "MACOS_UPDATER_REQUIRED_FOR_DISTRIBUTION" },
  );
  await assert.rejects(
    normalizeMacOSUpdaterConfiguration({
      externalDistribution: true,
      previewDistribution: true,
    }),
    { code: "MACOS_UPDATER_CHANNEL_CONFLICT" },
  );
});

test("prepared Sparkle framework matches the reviewed tree when present", async (context) => {
  const preparedFramework = join(
    REPOSITORY_ROOT,
    ".release-deps",
    "Sparkle.framework",
  );
  let metadata;
  try {
    metadata = await lstat(preparedFramework);
  } catch (error) {
    if (error.code === "ENOENT") {
      context.skip("pinned framework has not been prepared in this checkout");
      return;
    }
    throw error;
  }
  assert.equal(metadata.isDirectory(), true);
  const inspected = await inspectPinnedSparkleFramework(preparedFramework);
  assert.equal(inspected.sha256, SPARKLE_FRAMEWORK_SHA256);
  assert.equal(inspected.version, SPARKLE_VERSION);
});

test("prepared Sparkle appcast tools match the reviewed binaries when present", async (context) => {
  const preparedTools = join(
    REPOSITORY_ROOT,
    ".release-deps",
    SPARKLE_TOOLS_DIRECTORY_NAME,
  );
  let metadata;
  try {
    metadata = await lstat(preparedTools);
  } catch (error) {
    if (error.code === "ENOENT") {
      context.skip("pinned appcast tools have not been prepared in this checkout");
      return;
    }
    throw error;
  }
  assert.equal(metadata.isDirectory(), true);
  const inspected = await inspectPinnedSparkleTools(preparedTools);
  assert.deepEqual(
    inspected.tools.map((tool) => tool.name),
    Object.keys(SPARKLE_TOOL_FILES).sort(),
  );
  for (const tool of inspected.tools) {
    assert.equal(tool.sha256, SPARKLE_TOOL_FILES[tool.name].sha256);
    assert.equal(tool.mode, "755");
    const help = spawnSync(tool.path, ["--help"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(help.status, 0, help.stderr || help.stdout);
  }
});

test("Sparkle appcast tools fail closed on aliases and unexpected files", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-updater-tools-test-"),
  );
  try {
    const actual = join(temporaryRoot, SPARKLE_TOOLS_DIRECTORY_NAME);
    await mkdir(actual, { recursive: true });
    await writeFile(join(actual, "unexpected"), "modified");
    await assert.rejects(
      inspectPinnedSparkleTools(actual),
      { code: "MACOS_UPDATER_CONFIGURATION_INVALID" },
    );
    const alias = join(temporaryRoot, "SparkleTools-alias");
    await symlink(actual, alias);
    await assert.rejects(
      inspectPinnedSparkleTools(alias),
      { code: "MACOS_UPDATER_CONFIGURATION_INVALID" },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preview updater metadata rejects unsafe feeds and malformed public keys", () => {
  const publicEdKey = Buffer.alloc(32, 3).toString("base64");
  assert.deepEqual(
    normalizeMacOSUpdaterMetadata({
      appcastURL: "https://updates.example.test/tibotattle/appcast.xml",
      publicEdKey,
    }),
    {
      appcastURL: "https://updates.example.test/tibotattle/appcast.xml",
      publicEdKey,
    },
  );
  for (const appcastURL of [
    "http://updates.example.test/appcast.xml",
    "https://localhost/appcast.xml",
    "https://10.0.0.1/appcast.xml",
    "https://[::ffff:7f00:1]/appcast.xml",
    "https://updates.example.test/",
    "https://user:secret@updates.example.test/appcast.xml",
    "https://updates.example.test/appcast.xml?channel=preview",
  ]) {
    assert.throws(
      () => normalizeMacOSUpdaterMetadata({ appcastURL, publicEdKey }),
      { code: "MACOS_UPDATER_CONFIGURATION_INVALID" },
      appcastURL,
    );
  }
  for (const invalidKey of [
    "not-base64",
    Buffer.alloc(31, 3).toString("base64"),
    `${Buffer.alloc(32, 3).toString("base64").slice(0, -1)}A`,
  ]) {
    assert.throws(
      () => normalizeMacOSUpdaterMetadata({
        appcastURL: "https://updates.example.test/appcast.xml",
        publicEdKey: invalidKey,
      }),
      { code: "MACOS_UPDATER_CONFIGURATION_INVALID" },
      invalidKey,
    );
  }
  assert.throws(
    () => normalizeMacOSUpdaterMetadata({
      appcastURL: "https://updates.example.test/appcast.xml",
      publicEdKey: "",
    }),
    { code: "MACOS_UPDATER_REQUIRED_FOR_DISTRIBUTION" },
  );
});

test("Sparkle framework input fails closed on aliases and modified trees", async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-updater-test-"),
  );
  try {
    const actual = join(temporaryRoot, "actual", "Sparkle.framework");
    await mkdir(actual, { recursive: true });
    await writeFile(join(actual, "unexpected"), "modified");
    await assert.rejects(
      inspectPinnedSparkleFramework(actual),
      { code: "MACOS_UPDATER_CONFIGURATION_INVALID" },
    );
    const alias = join(temporaryRoot, "Sparkle.framework");
    await symlink(actual, alias);
    await assert.rejects(
      inspectPinnedSparkleFramework(alias),
      { code: "MACOS_UPDATER_CONFIGURATION_INVALID" },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
