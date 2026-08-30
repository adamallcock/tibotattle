/**
 * Named-channel appcast generation must adopt the OFFICIAL feed-signed
 * generate_appcast output — never the hand-built minimal shape — because
 * every installed client on BOTH named channels ships
 * SURequireSignedFeed=true (2026-08-10 incident). Tests here inject the
 * test-only generate_appcast seam (the real pinned binary needs Keychain or
 * an operator key file plus a mountable DMG) and pin that:
 *   - the DMG is staged alone and the tool output is adopted byte-for-byte;
 *   - the output is locally validated (shape, envelope, enclosure vs DMG);
 *   - tampered or unsigned tool output fails closed without writing the
 *     appcast;
 *   - the retained-archive machinery still runs for stable;
 *   - internal-dogfood routes through the same official path and can select
 *     its own Keychain signing key via --account.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getReleaseChannel } from "../config/release-channels.js";
import {
  RETAINED_ARCHIVE_METADATA_FILE,
  RETAINED_ARCHIVE_SCHEMA,
  generateSparkleAppcast,
  parseGenerateSparkleAppcastArguments,
} from "../scripts/generate-sparkle-appcast.js";
import { validateSignedSparkleFeed } from "../scripts/sparkle-signed-feed-validation.js";
import { validateCandidateAppcastShape } from "../scripts/publish-sparkle-update.js";

const STABLE_CHANNEL = getReleaseChannel("stable");
const TEST_KEY_PAIR = generateKeyPairSync("ed25519");
const TEST_PUBLIC_ED_KEY = TEST_KEY_PAIR.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeFakeAppBundle(root, { bundleVersion, shortVersion }) {
  const appPath = join(root, "TiboTattle.app");
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    join(appPath, "Contents", "MacOS", "TiboTattle"),
    Buffer.from(`fake-binary-${bundleVersion}`),
  );
  await writeFile(join(appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>CFBundleIdentifier</key><string>com.usagemonitor.local</string>
<key>CFBundleVersion</key><string>${bundleVersion}</string>
<key>CFBundleShortVersionString</key><string>${shortVersion}</string>
<key>SURequireSignedFeed</key><true/>
</dict>
</plist>
`);
  return appPath;
}

function officialToolOutput({
  artifactBytes,
  bundleVersion,
  downloadURLPrefix,
  fileName,
  shortVersion,
  urlDigestOverride = null,
  unsigned = false,
}) {
  const artifactSignature = sign(null, artifactBytes, TEST_KEY_PAIR.privateKey)
    .toString("base64");
  const url = urlDigestOverride === null
    ? `${downloadURLPrefix}${fileName}`
    : `${STABLE_CHANNEL.sparkle.origin}/${STABLE_CHANNEL.sparkle.objectPrefix}/${bundleVersion}/${urlDigestOverride}/${fileName}`;
  if (unsigned) {
    return `<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel><item>
<enclosure url="${url}" length="${artifactBytes.length}" sparkle:version="${bundleVersion}" sparkle:edSignature="${artifactSignature}" />
</item></channel></rss>
`;
  }
  const prefix = `<?xml version="1.0" standalone="yes"?><!-- sparkle-sign-warning:
IMPORTANT: This file was signed by Sparkle. Any modifications to this file requires re-signing this file with generate_appcast or sign_update! The signed signature will be embedded at the end of this file.
--><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>TiboTattle</title>
        <item>
            <title>${shortVersion}</title>
            <pubDate>Sun, 10 Aug 2026 12:00:00 -0400</pubDate>
            <sparkle:version>${bundleVersion}</sparkle:version>
            <sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
            <enclosure url="${url}" length="${artifactBytes.length}" type="application/octet-stream" sparkle:edSignature="${artifactSignature}"></enclosure>
        </item>
    </channel>
</rss>`;
  const envelopeSignature = sign(
    null,
    Buffer.from(prefix, "utf8"),
    TEST_KEY_PAIR.privateKey,
  ).toString("base64");
  return `${prefix}<!-- sparkle-signatures:
edSignature: ${envelopeSignature}
length: ${Buffer.byteLength(prefix, "utf8")}
-->
`;
}

async function createStableFixture({ bundleVersion = "3", shortVersion = "0.1.3" } = {}) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "tibotattle-stable-feed-generator-test-"),
  );
  const appPath = await writeFakeAppBundle(root, { bundleVersion, shortVersion });
  const dmgFileName = `TiboTattle-${shortVersion}-macOS-arm64.dmg`;
  const dmgBytes = Buffer.from(`stable-signed-dmg-${bundleVersion}`);
  const dmgPath = join(root, dmgFileName);
  await writeFile(dmgPath, dmgBytes);
  return {
    appPath,
    bundleVersion,
    cleanup: () => rm(root, { recursive: true, force: true }),
    dmgBytes,
    dmgFileName,
    dmgPath,
    root,
    shortVersion,
  };
}

function fakeGenerateAppcastTool(fixture, { calls, mutateOutput = null } = {}) {
  return async ({
    account,
    appcastOutputPath,
    downloadURLPrefix,
    edKeyFile,
    generateAppcastPath,
    stagingDirectory,
  }) => {
    const staged = await readdir(stagingDirectory);
    calls?.push({
      account,
      downloadURLPrefix,
      edKeyFile,
      generateAppcastPath,
      staged: [...staged].sort(),
    });
    // The staged directory must contain the release DMG ALONE, byte-for-byte:
    // generate_appcast signs and (with priors present) delta-generates from
    // every archive it finds there.
    assert.deepEqual(staged, [fixture.dmgFileName]);
    const stagedBytes = await readFile(join(stagingDirectory, fixture.dmgFileName));
    assert.deepEqual(stagedBytes, fixture.dmgBytes);
    let output = officialToolOutput({
      artifactBytes: stagedBytes,
      bundleVersion: fixture.bundleVersion,
      downloadURLPrefix,
      fileName: fixture.dmgFileName,
      shortVersion: fixture.shortVersion,
    });
    if (mutateOutput !== null) output = mutateOutput(output, stagedBytes);
    await writeFile(appcastOutputPath, output);
  };
}

function stableOptions(fixture, extraArguments = []) {
  return parseGenerateSparkleAppcastArguments([
    "--channel", "stable",
    "--app", fixture.appPath,
    "--dmg", fixture.dmgPath,
    "--bundle-version", fixture.bundleVersion,
    "--short-version", fixture.shortVersion,
    "--archive-root", join(fixture.root, "release-archive"),
    "--sparkle-public-ed-key", TEST_PUBLIC_ED_KEY,
    ...extraArguments,
  ]);
}

test("stable path adopts the official tool output byte-for-byte after validating it", async () => {
  const fixture = await createStableFixture();
  const calls = [];
  try {
    const result = await generateSparkleAppcast({
      ...stableOptions(fixture),
      runGenerateAppcastTool: fakeGenerateAppcastTool(fixture, { calls }),
    });
    assert.equal(result.channel, "stable");
    assert.equal(result.feedSigned, true);
    assert.deepEqual(result.deltas, []);
    const digest = sha256(fixture.dmgBytes);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].downloadURLPrefix,
      `${STABLE_CHANNEL.sparkle.origin}/${STABLE_CHANNEL.sparkle.objectPrefix}/${fixture.bundleVersion}/${digest}/`,
    );
    assert.equal(calls[0].edKeyFile, null);
    assert.equal(
      result.full.url,
      `${STABLE_CHANNEL.sparkle.origin}/${STABLE_CHANNEL.sparkle.objectPrefix}/${fixture.bundleVersion}/${digest}/${fixture.dmgFileName}`,
    );
    assert.equal(result.full.sha256, digest);

    const written = await readFile(result.appcastPath, "utf8");
    assert.match(written, /^<\?xml version="1\.0" standalone="yes"\?>/u);
    assert.match(written, /<!-- sparkle-signatures:\n/u);
    // The written bytes revalidate against the guard-mirroring validator and
    // the publisher's candidate shape check.
    const validated = validateSignedSparkleFeed({
      appcastText: written,
      dmg: {
        bytes: fixture.dmgBytes,
        fileName: fixture.dmgFileName,
        sha256: digest,
        size: fixture.dmgBytes.length,
      },
      objectPrefix: STABLE_CHANNEL.sparkle.objectPrefix,
      publicEdKey: TEST_PUBLIC_ED_KEY,
      updateOrigin: STABLE_CHANNEL.sparkle.origin,
    });
    assert.equal(validated.bundleVersion, fixture.bundleVersion);
    assert.equal(validated.shortVersion, fixture.shortVersion);
    validateCandidateAppcastShape(written, "stable");

    // Stable still retains the archive so delta machinery stays ready.
    const retainedMetadata = JSON.parse(await readFile(
      join(
        fixture.root,
        "release-archive",
        "stable",
        fixture.bundleVersion,
        RETAINED_ARCHIVE_METADATA_FILE,
      ),
      "utf8",
    ));
    assert.equal(retainedMetadata.schemaVersion, RETAINED_ARCHIVE_SCHEMA);
    assert.equal(retainedMetadata.bundleVersion, fixture.bundleVersion);
  } finally {
    await fixture.cleanup();
  }
});

test("internal-dogfood routes through the official signed path with its own Keychain account", async () => {
  const DOGFOOD_CHANNEL = getReleaseChannel("internal-dogfood");
  const fixture = await createStableFixture({
    bundleVersion: "1011",
    shortVersion: "0.1.13",
  });
  const calls = [];
  try {
    const result = await generateSparkleAppcast({
      ...parseGenerateSparkleAppcastArguments([
        "--channel", "internal-dogfood",
        "--app", fixture.appPath,
        "--dmg", fixture.dmgPath,
        "--bundle-version", fixture.bundleVersion,
        "--short-version", fixture.shortVersion,
        "--archive-root", join(fixture.root, "release-archive"),
        "--sparkle-public-ed-key", TEST_PUBLIC_ED_KEY,
        "--account", "tibotattle-internal-dogfood-v1",
      ]),
      runGenerateAppcastTool: async (call) => {
        // The fake output embeds the channel-correct content address, so the
        // local guard-mirroring validation exercises the dogfood origin.
        calls.push({ account: call.account, edKeyFile: call.edKeyFile });
        const stagedBytes = await readFile(
          join(call.stagingDirectory, fixture.dmgFileName),
        );
        await writeFile(call.appcastOutputPath, officialToolOutput({
          artifactBytes: stagedBytes,
          bundleVersion: fixture.bundleVersion,
          downloadURLPrefix: call.downloadURLPrefix,
          fileName: fixture.dmgFileName,
          shortVersion: fixture.shortVersion,
        }));
      },
    });
    assert.equal(result.channel, "internal-dogfood");
    assert.equal(result.feedSigned, true);
    assert.deepEqual(result.deltas, []);
    assert.deepEqual(calls, [{
      account: "tibotattle-internal-dogfood-v1",
      edKeyFile: null,
    }]);
    const digest = sha256(fixture.dmgBytes);
    assert.equal(
      result.full.url,
      `${DOGFOOD_CHANNEL.sparkle.origin}/${DOGFOOD_CHANNEL.sparkle.objectPrefix}/${fixture.bundleVersion}/${digest}/${fixture.dmgFileName}`,
    );
    const written = await readFile(result.appcastPath, "utf8");
    assert.match(written, /<!-- sparkle-signatures:\n/u);
    const validated = validateSignedSparkleFeed({
      appcastText: written,
      dmg: {
        bytes: fixture.dmgBytes,
        fileName: fixture.dmgFileName,
        sha256: digest,
        size: fixture.dmgBytes.length,
      },
      objectPrefix: DOGFOOD_CHANNEL.sparkle.objectPrefix,
      publicEdKey: TEST_PUBLIC_ED_KEY,
      updateOrigin: DOGFOOD_CHANNEL.sparkle.origin,
    });
    assert.equal(validated.bundleVersion, fixture.bundleVersion);
    validateCandidateAppcastShape(written, "internal-dogfood");
  } finally {
    await fixture.cleanup();
  }
});

test("--account refuses unsafe names and combination with --ed-key-file", async () => {
  const fixture = await createStableFixture();
  try {
    assert.throws(
      () => parseGenerateSparkleAppcastArguments([
        "--channel", "internal-dogfood",
        "--app", fixture.appPath,
        "--dmg", fixture.dmgPath,
        "--bundle-version", fixture.bundleVersion,
        "--account", "bad name with spaces",
      ]),
      /--account must be a short safe Keychain account name/u,
    );
    assert.throws(
      () => parseGenerateSparkleAppcastArguments([
        "--channel", "internal-dogfood",
        "--app", fixture.appPath,
        "--dmg", fixture.dmgPath,
        "--bundle-version", fixture.bundleVersion,
        "--account", "tibotattle-internal-dogfood-v1",
        "--ed-key-file", join(fixture.root, "unused-key"),
      ]),
      /--account and --ed-key-file are mutually exclusive/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("appcast CLI rejects bundle versions outside Apple's component bounds", () => {
  const argumentsFor = (bundleVersion) => [
    "--channel", "stable",
    "--app", "/tmp/TiboTattle.app",
    "--dmg", "/tmp/TiboTattle.dmg",
    "--bundle-version", bundleVersion,
  ];
  for (const bundleVersion of [
    "0",
    "0.1.16",
    "0.1.17",
    "0.2.0",
    "01",
    "12345",
    "1.100",
    "1.2.100",
    "1.2.3.4",
  ]) {
    assert.throws(
      () => parseGenerateSparkleAppcastArguments(
        argumentsFor(bundleVersion),
      ),
      /Apple-compatible CFBundleVersion/u,
      bundleVersion,
    );
  }
  for (const bundleVersion of ["1", "1.2", "1.2.3", "1234.99.99"]) {
    assert.equal(
      parseGenerateSparkleAppcastArguments(
        argumentsFor(bundleVersion),
      ).bundleVersion,
      bundleVersion,
    );
  }
});

test("stable path passes --ed-key-file through to the official tool", async () => {
  const fixture = await createStableFixture();
  const keyFilePath = join(fixture.root, "test-sparkle-ed-key");
  await writeFile(keyFilePath, "unused-by-the-fake-tool");
  const calls = [];
  try {
    await generateSparkleAppcast({
      ...stableOptions(fixture, ["--ed-key-file", keyFilePath, "--skip-retain"]),
      runGenerateAppcastTool: fakeGenerateAppcastTool(fixture, { calls }),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].edKeyFile, keyFilePath);
  } finally {
    await fixture.cleanup();
  }
});

test("stable path fails closed on unsigned tool output without writing the appcast", async () => {
  const fixture = await createStableFixture();
  try {
    await assert.rejects(
      generateSparkleAppcast({
        ...stableOptions(fixture, ["--skip-retain"]),
        runGenerateAppcastTool: fakeGenerateAppcastTool(fixture, {
          mutateOutput: (output, stagedBytes) => officialToolOutput({
            artifactBytes: stagedBytes,
            bundleVersion: fixture.bundleVersion,
            downloadURLPrefix: `${STABLE_CHANNEL.sparkle.origin}/${STABLE_CHANNEL.sparkle.objectPrefix}/${fixture.bundleVersion}/${sha256(stagedBytes)}/`,
            fileName: fixture.dmgFileName,
            shortVersion: fixture.shortVersion,
            unsigned: true,
          }),
        }),
      }),
      { code: "SPARKLE_SIGNED_FEED_TRAILER_MISSING" },
    );
    const outputExists = await readFile(join(fixture.root, "appcast.xml"))
      .then(() => true, () => false);
    assert.equal(outputExists, false);
  } finally {
    await fixture.cleanup();
  }
});

test("stable path fails closed when the tool output content address is wrong", async () => {
  const fixture = await createStableFixture();
  try {
    await assert.rejects(
      generateSparkleAppcast({
        ...stableOptions(fixture, ["--skip-retain"]),
        runGenerateAppcastTool: fakeGenerateAppcastTool(fixture, {
          mutateOutput: (output, stagedBytes) => officialToolOutput({
            artifactBytes: stagedBytes,
            bundleVersion: fixture.bundleVersion,
            downloadURLPrefix: "ignored",
            fileName: fixture.dmgFileName,
            shortVersion: fixture.shortVersion,
            urlDigestOverride: "b".repeat(64),
          }),
        }),
      }),
      { code: "SPARKLE_SIGNED_FEED_ARTIFACT_MISMATCH" },
    );
    const outputExists = await readFile(join(fixture.root, "appcast.xml"))
      .then(() => true, () => false);
    assert.equal(outputExists, false);
  } finally {
    await fixture.cleanup();
  }
});

test("stable path fails closed when the tool reports a different bundle version", async () => {
  const fixture = await createStableFixture();
  try {
    await assert.rejects(
      generateSparkleAppcast({
        ...stableOptions(fixture, ["--skip-retain"]),
        runGenerateAppcastTool: async ({ appcastOutputPath, stagingDirectory }) => {
          const stagedBytes = await readFile(
            join(stagingDirectory, fixture.dmgFileName),
          );
          const wrongVersion = "9";
          await writeFile(appcastOutputPath, officialToolOutput({
            artifactBytes: stagedBytes,
            bundleVersion: wrongVersion,
            downloadURLPrefix: `${STABLE_CHANNEL.sparkle.origin}/${STABLE_CHANNEL.sparkle.objectPrefix}/${wrongVersion}/${sha256(stagedBytes)}/`,
            fileName: fixture.dmgFileName,
            shortVersion: fixture.shortVersion,
          }));
        },
      }),
      { code: "SPARKLE_APPCAST_GENERATION_INVALID" },
    );
  } finally {
    await fixture.cleanup();
  }
});
