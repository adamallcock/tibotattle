import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
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
import {
  RETAINED_ARCHIVE_METADATA_FILE,
  RETAINED_ARCHIVE_SCHEMA,
} from "../scripts/generate-sparkle-appcast.js";
import { validateCandidateAppcastShape } from "../scripts/publish-sparkle-update.js";

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

function sparkleEdKeyFixture() {
  const pair = generateKeyPairSync("ed25519");
  const pkcs8 = pair.privateKey.export({ format: "der", type: "pkcs8" });
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const publicRaw = pair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  // Sparkle's sign_update key-file format: base64 of the 64-byte expanded
  // Ed25519 secret followed by the 32-byte public key.
  const expanded = createHash("sha512").update(seed).digest();
  expanded[0] &= 248;
  expanded[31] &= 127;
  expanded[31] |= 64;
  return Object.freeze({
    keyFileContents: Buffer.concat([expanded, publicRaw]).toString("base64"),
    publicEdKey: publicRaw.toString("base64"),
    publicKeyObject: createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        publicRaw,
      ]),
      format: "der",
      type: "spki",
    }),
  });
}

async function writeFakeAppBundle(root, { bundleVersion, payloadSuffix }) {
  const appPath = join(root, "TiboTattle.app");
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    join(appPath, "Contents", "MacOS", "TiboTattle"),
    Buffer.concat([
      Buffer.alloc(150_000, 65),
      Buffer.from(payloadSuffix),
    ]),
  );
  await writeFile(join(appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>CFBundleIdentifier</key><string>com.usagemonitor.local</string>
<key>CFBundleVersion</key><string>${bundleVersion}</string>
<key>CFBundleShortVersionString</key><string>0.1.${bundleVersion}</string>
</dict>
</plist>
`);
  return appPath;
}

function runAppcastGenerator(generatorArguments) {
  return spawnSync(process.execPath, [
    join(REPOSITORY_ROOT, "scripts", "generate-sparkle-appcast.js"),
    ...generatorArguments,
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: 240_000,
  });
}

test("appcast generator fails open to full-only, then produces a signed validated delta", async (context) => {
  const preparedTools = join(
    REPOSITORY_ROOT,
    ".release-deps",
    SPARKLE_TOOLS_DIRECTORY_NAME,
  );
  try {
    await lstat(preparedTools);
  } catch (error) {
    if (error.code === "ENOENT") {
      context.skip("pinned appcast tools have not been prepared in this checkout");
      return;
    }
    throw error;
  }
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-delta-generator-test-"),
  );
  try {
    const key = sparkleEdKeyFixture();
    const keyFilePath = join(temporaryRoot, "test-sparkle-ed-key");
    await writeFile(keyFilePath, key.keyFileContents);
    const archiveRoot = join(temporaryRoot, "release-archive");
    const releases = [];
    for (const bundleVersion of ["1", "2"]) {
      const releaseRoot = join(temporaryRoot, `release-${bundleVersion}`);
      await mkdir(releaseRoot, { recursive: true });
      const appPath = await writeFakeAppBundle(releaseRoot, {
        bundleVersion,
        payloadSuffix: `release-payload-${bundleVersion}`,
      });
      const dmgPath = join(
        releaseRoot,
        `TiboTattle-0.1.${bundleVersion}-macOS-arm64.dmg`,
      );
      await writeFile(
        dmgPath,
        Buffer.concat([
          Buffer.from(`fake-dmg-${bundleVersion}-`),
          Buffer.alloc(180_000, 66),
        ]),
      );
      releases.push({ appPath, bundleVersion, dmgPath, releaseRoot });
    }

    // First release: no retained archive exists yet. The generator must fail
    // OPEN to a full-only appcast with a loud warning and must not block.
    const first = runAppcastGenerator([
      "--channel", "internal-dogfood",
      "--app", releases[0].appPath,
      "--dmg", releases[0].dmgPath,
      "--bundle-version", "1",
      "--short-version", "0.1.1",
      "--archive-root", archiveRoot,
      "--ed-key-file", keyFilePath,
      "--sparkle-public-ed-key", key.publicEdKey,
    ]);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stderr, /FULL-ONLY appcast/u);
    assert.match(first.stderr, /never blocks a release/u);
    const firstAppcast = await readFile(
      join(releases[0].releaseRoot, "appcast.xml"),
      "utf8",
    );
    assert.equal(firstAppcast.includes("sparkle:deltas"), false);
    const retainedMetadata = JSON.parse(await readFile(
      join(archiveRoot, "internal-dogfood", "1", RETAINED_ARCHIVE_METADATA_FILE),
      "utf8",
    ));
    assert.equal(retainedMetadata.schemaVersion, RETAINED_ARCHIVE_SCHEMA);
    assert.equal(retainedMetadata.bundleVersion, "1");
    assert.equal(retainedMetadata.appName, "TiboTattle.app");

    // Second release: the retained archive provides version 1, so the
    // generator must produce a signed delta plus the full fallback.
    const second = runAppcastGenerator([
      "--channel", "internal-dogfood",
      "--app", releases[1].appPath,
      "--dmg", releases[1].dmgPath,
      "--bundle-version", "2",
      "--short-version", "0.1.2",
      "--archive-root", archiveRoot,
      "--ed-key-file", keyFilePath,
      "--sparkle-public-ed-key", key.publicEdKey,
    ]);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /Delta from 1:/u);
    const secondAppcast = await readFile(
      join(releases[1].releaseRoot, "appcast.xml"),
      "utf8",
    );
    const enclosures = validateCandidateAppcastShape(
      secondAppcast,
      "internal-dogfood",
    );
    assert.equal(enclosures.length, 2);
    const fullEnclosure = enclosures.find(
      (enclosure) => enclosure.deltaFrom === undefined,
    );
    const deltaEnclosure = enclosures.find(
      (enclosure) => enclosure.deltaFrom !== undefined,
    );
    assert.equal(fullEnclosure.version, "2");
    assert.equal(deltaEnclosure.version, "2");
    assert.equal(deltaEnclosure.deltaFrom, "1");
    assert.equal(deltaEnclosure.objectKey.endsWith(".delta"), true);

    const deltaFileName = deltaEnclosure.objectKey.split("/").at(-1);
    const deltaPath = join(releases[1].releaseRoot, deltaFileName);
    const deltaBytes = await readFile(deltaPath);
    assert.equal(deltaBytes.length, deltaEnclosure.length);
    assert.equal(
      createHash("sha256").update(deltaBytes).digest("hex"),
      deltaEnclosure.objectSha256,
    );
    assert.equal(
      verify(
        null,
        deltaBytes,
        key.publicKeyObject,
        Buffer.from(deltaEnclosure.signature, "base64"),
      ),
      true,
    );
    const dmgBytes = await readFile(releases[1].dmgPath);
    assert.equal(deltaBytes.length < dmgBytes.length, true);
    assert.equal(
      verify(
        null,
        dmgBytes,
        key.publicKeyObject,
        Buffer.from(fullEnclosure.signature, "base64"),
      ),
      true,
    );

    // The generator's own BinaryDelta apply-check ran (it fails the run on a
    // mismatch), and both versions are now retained for the next release.
    await lstat(join(archiveRoot, "internal-dogfood", "2", "TiboTattle.app"));

    // The stable channel stays policy-gated: same inputs, full-only appcast.
    const stable = runAppcastGenerator([
      "--channel", "stable",
      "--app", releases[1].appPath,
      "--dmg", releases[1].dmgPath,
      "--bundle-version", "2",
      "--short-version", "0.1.2",
      "--archive-root", archiveRoot,
      "--ed-key-file", keyFilePath,
      "--sparkle-public-ed-key", key.publicEdKey,
      "--replace",
    ]);
    assert.equal(stable.status, 0, stable.stderr || stable.stdout);
    assert.match(stable.stderr, /disabled for the stable channel/u);
    const stableAppcast = await readFile(
      join(releases[1].releaseRoot, "appcast.xml"),
      "utf8",
    );
    assert.equal(stableAppcast.includes("sparkle:deltas"), false);
    validateCandidateAppcastShape(stableAppcast, "stable");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
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
