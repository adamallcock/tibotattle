import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  APPROVED_R2_BUCKET,
  APPCAST_CACHE_CONTROL,
  CANONICAL_APPCAST_URL,
  CANONICAL_UPDATE_ORIGIN,
  IMMUTABLE_CACHE_CONTROL,
  parseSparkleUpdatePublisherArguments,
  publishSparkleUpdate,
} from "../scripts/publish-sparkle-update.js";

const TEST_KEY_PAIR = generateKeyPairSync("ed25519");
const TEST_PUBLIC_ED_KEY = TEST_KEY_PAIR.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createReleaseFixture({
  appcastURL = CANONICAL_APPCAST_URL,
  bundleVersion = "1",
  dmgbBytes = Buffer.from("signed-notarized-dmg-fixture"),
  mutateAppcast = (value) => value,
  mutateManifest = (value) => value,
} = {}) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "tibotattle-r2-publisher-test-"),
  );
  const fileName = "TiboTattle-0.1.0-macOS-arm64.dmg";
  const dmgPath = join(root, fileName);
  const appcastPath = join(root, "appcast.xml");
  const releaseManifestPath = join(root, `${fileName}.release.json`);
  const digest = sha256(dmgbBytes);
  const signature = sign(null, dmgbBytes, TEST_KEY_PAIR.privateKey)
    .toString("base64");
  const artifactURL = `${CANONICAL_UPDATE_ORIGIN}/releases/${bundleVersion}/${digest}/${fileName}`;
  const manifest = mutateManifest({
    schemaVersion: "usage-monitor-macos-release-v0.2",
    application: {
      bundleIdentifier: "com.usagemonitor.local",
      bundleVersion,
      shortVersion: "0.1.0",
    },
    artifact: { bytes: dmgbBytes.length, fileName, sha256: digest },
    assurances: {
      appNotarizationAccepted: true,
      appTicketStapled: true,
      candidateReproducedFromCheckedOutSource: true,
      cleanProfileSmokePassed: true,
      developerIDHardenedRuntime: true,
      dmgGatekeeperAssessmentPassed: true,
      dmgNotarizationAccepted: true,
      dmgTicketStapled: true,
    },
    updater: {
      appcastURL,
      enabled: true,
      publicEdKeySha256: sha256(
        Buffer.from(TEST_PUBLIC_ED_KEY, "base64"),
      ),
      requiresSignedFeed: true,
    },
  });
  const appcast = mutateAppcast(`<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>
<enclosure url="${artifactURL}" length="${dmgbBytes.length}" sparkle:version="${bundleVersion}" sparkle:edSignature="${signature}" />
</item></channel></rss>
`);
  await Promise.all([
    writeFile(dmgPath, dmgbBytes),
    writeFile(appcastPath, appcast),
    writeFile(releaseManifestPath, `${JSON.stringify(manifest)}\n`),
  ]);
  return {
    appcastPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
    dmgPath,
    releaseManifestPath,
  };
}

function missingRemoteObjectRunner() {
  return remoteObjectRunner();
}

function remoteObjectRunner(objects = new Map()) {
  const calls = [];
  const run = async (arguments_) => {
    calls.push(arguments_);
    if (arguments_.at(2) === "get") {
      const object = objects.get(arguments_[3]);
      if (object === undefined) {
        return { status: 1, stderr: "Object not found" };
      }
      const destination = arguments_[arguments_.indexOf("--file") + 1];
      await writeFile(destination, object);
    }
    return { status: 0 };
  };
  return { calls, run };
}

function appcastEnclosure({ bytes, deltaFrom, signature, url, version }) {
  const delta = deltaFrom === undefined
    ? ""
    : ` sparkle:deltaFrom="${deltaFrom}"`;
  const enclosureSignature = signature
    ?? sign(null, bytes, TEST_KEY_PAIR.privateKey).toString("base64");
  return `<item><enclosure url="${url}" length="${bytes.length}" sparkle:version="${version}"${delta} sparkle:edSignature="${enclosureSignature}" /></item>`;
}

test("validates an explicitly supplied canonical signed update without invoking Wrangler by default", async () => {
  const fixture = await createReleaseFixture();
  const verified = [];
  try {
    const publication = await publishSparkleUpdate({
      appcastPath: fixture.appcastPath,
      bucket: APPROVED_R2_BUCKET,
      dmgPath: fixture.dmgPath,
      releaseManifestPath: fixture.releaseManifestPath,
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      runWrangler: async () => assert.fail("dry run must not call Wrangler"),
      validateDMG: async (...arguments_) => verified.push(arguments_),
    });
    const digest = publication.artifact.sha256;
    assert.equal(publication.published, false);
    assert.equal(publication.appcast.url, CANONICAL_APPCAST_URL);
    assert.equal(
      publication.artifact.key,
      `releases/1/${digest}/TiboTattle-0.1.0-macOS-arm64.dmg`,
    );
    assert.equal(
      publication.manifest.key,
      `releases/1/${digest}/release-manifest.json`,
    );
    assert.equal(publication.artifact.cacheControl, IMMUTABLE_CACHE_CONTROL);
    assert.equal(publication.manifest.cacheControl, IMMUTABLE_CACHE_CONTROL);
    assert.equal(publication.appcast.cacheControl, APPCAST_CACHE_CONTROL);
    assert.deepEqual(verified, [[fixture.dmgPath, {
      expectedBundleIdentifier: "com.usagemonitor.local",
      expectedBundleVersion: "1",
      expectedShortVersion: "0.1.0",
      production: true,
    }]]);
  } finally {
    await fixture.cleanup();
  }
});

test("publishes only the three validated objects with cache-safe Wrangler metadata", async () => {
  const fixture = await createReleaseFixture();
  const runner = missingRemoteObjectRunner();
  try {
    const publication = await publishSparkleUpdate({
      appcastPath: fixture.appcastPath,
      bucket: APPROVED_R2_BUCKET,
      dmgPath: fixture.dmgPath,
      publish: true,
      releaseManifestPath: fixture.releaseManifestPath,
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      runWrangler: runner.run,
      validateDMG: async () => {},
    });
    assert.equal(publication.published, true);
    assert.equal(runner.calls.length, 6);
    assert.deepEqual(runner.calls.slice(0, 3).map((call) => call.slice(0, 4)), [
      ["r2", "object", "get", `${APPROVED_R2_BUCKET}/${publication.artifact.key}`],
      ["r2", "object", "get", `${APPROVED_R2_BUCKET}/${publication.manifest.key}`],
      ["r2", "object", "get", `${APPROVED_R2_BUCKET}/appcast.xml`],
    ]);
    assert.deepEqual(runner.calls.slice(3).map((call) => call.slice(0, 4)), [
      ["r2", "object", "put", `${APPROVED_R2_BUCKET}/${publication.artifact.key}`],
      ["r2", "object", "put", `${APPROVED_R2_BUCKET}/${publication.manifest.key}`],
      ["r2", "object", "put", `${APPROVED_R2_BUCKET}/appcast.xml`],
    ]);
    assert.equal(runner.calls[3].includes("application/x-apple-diskimage"), true);
    assert.equal(runner.calls[3].includes(IMMUTABLE_CACHE_CONTROL), true);
    assert.equal(runner.calls[4].includes("application/json; charset=utf-8"), true);
    assert.equal(runner.calls[4].includes(IMMUTABLE_CACHE_CONTROL), true);
    assert.equal(runner.calls[5].includes("application/xml; charset=utf-8"), true);
    assert.equal(runner.calls[5].includes(APPCAST_CACHE_CONTROL), true);
    assert.equal(runner.calls.flat().includes("--force"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("refuses an existing immutable object before it can be overwritten", async () => {
  const fixture = await createReleaseFixture();
  const calls = [];
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: async (arguments_) => {
          calls.push(arguments_);
          return { status: 0 };
        },
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_OBJECT_EXISTS" },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], "get");
  } finally {
    await fixture.cleanup();
  }
});

test("requires an explicit appcast replacement after immutable preflight passes", async () => {
  const fixture = await createReleaseFixture();
  const calls = [];
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: async (arguments_) => {
          calls.push(arguments_);
          return { status: arguments_[2] === "get" && calls.length === 3 ? 0 : 1, stderr: "Object not found" };
        },
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_APPCAST_REPLACE_REQUIRED" },
    );
    assert.equal(calls.length, 3);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a preserved enclosure whose R2 object is unavailable before writing", async () => {
  const olderBytes = Buffer.from("older-release");
  const olderDigest = sha256(olderBytes);
  const olderFileName = "TiboTattle-0.1.0-macOS-arm64.dmg";
  const olderURL = `${CANONICAL_UPDATE_ORIGIN}/releases/0/${olderDigest}/${olderFileName}`;
  const fixture = await createReleaseFixture({
    mutateAppcast: (value) => value.replace(
      "</channel>",
      `${appcastEnclosure({
        bytes: olderBytes,
        url: olderURL,
        version: "0",
      })}</channel>`,
    ),
  });
  const runner = missingRemoteObjectRunner();
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: runner.run,
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_APPCAST_OBJECT_MISSING" },
    );
    assert.equal(
      runner.calls.some((call) => call[3] === `${APPROVED_R2_BUCKET}/releases/0/${olderDigest}/${olderFileName}`),
      true,
    );
    assert.equal(
      runner.calls.some((call) => call[2] === "put"),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("verifies preserved delta bytes and checksum before publication", async () => {
  const deltaBytes = Buffer.from("delta-release");
  const deltaDigest = sha256(deltaBytes);
  const deltaFileName = "TiboTattle-0.1.0-macOS-arm64.delta";
  const deltaKey = `releases/1/${deltaDigest}/${deltaFileName}`;
  const deltaURL = `${CANONICAL_UPDATE_ORIGIN}/${deltaKey}`;
  const fixture = await createReleaseFixture({
    mutateAppcast: (value) => value.replace(
      "</channel>",
      `${appcastEnclosure({
        bytes: deltaBytes,
        deltaFrom: "0",
        url: deltaURL,
        version: "1",
      })}</channel>`,
    ),
  });
  const runner = remoteObjectRunner(new Map([
    [`${APPROVED_R2_BUCKET}/${deltaKey}`, deltaBytes],
  ]));
  try {
    const publication = await publishSparkleUpdate({
      appcastPath: fixture.appcastPath,
      bucket: APPROVED_R2_BUCKET,
      dmgPath: fixture.dmgPath,
      publish: true,
      releaseManifestPath: fixture.releaseManifestPath,
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      runWrangler: runner.run,
      validateDMG: async () => {},
    });
    assert.equal(publication.published, true);
    assert.equal(
      runner.calls.some((call) => call[3] === `${APPROVED_R2_BUCKET}/${deltaKey}`),
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a preserved enclosure whose R2 bytes do not match its URL digest", async () => {
  const deltaBytes = Buffer.from("delta-release");
  const deltaDigest = sha256(deltaBytes);
  const deltaFileName = "TiboTattle-0.1.0-macOS-arm64.delta";
  const deltaKey = `releases/1/${deltaDigest}/${deltaFileName}`;
  const fixture = await createReleaseFixture({
    mutateAppcast: (value) => value.replace(
      "</channel>",
      `${appcastEnclosure({
        bytes: deltaBytes,
        deltaFrom: "0",
        url: `${CANONICAL_UPDATE_ORIGIN}/${deltaKey}`,
        version: "1",
      })}</channel>`,
    ),
  });
  const runner = remoteObjectRunner(new Map([
    [`${APPROVED_R2_BUCKET}/${deltaKey}`, Buffer.alloc(deltaBytes.length)],
  ]));
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: runner.run,
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_APPCAST_OBJECT_CHECKSUM_MISMATCH" },
    );
    assert.equal(
      runner.calls.some((call) => call[2] === "put"),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a preserved enclosure whose signature does not match its R2 bytes", async () => {
  const deltaBytes = Buffer.from("delta-release");
  const deltaDigest = sha256(deltaBytes);
  const deltaFileName = "TiboTattle-0.1.0-macOS-arm64.delta";
  const deltaKey = `releases/1/${deltaDigest}/${deltaFileName}`;
  const unrelatedKeyPair = generateKeyPairSync("ed25519");
  const fixture = await createReleaseFixture({
    mutateAppcast: (value) => value.replace(
      "</channel>",
      `${appcastEnclosure({
        bytes: deltaBytes,
        deltaFrom: "0",
        signature: sign(null, deltaBytes, unrelatedKeyPair.privateKey)
          .toString("base64"),
        url: `${CANONICAL_UPDATE_ORIGIN}/${deltaKey}`,
        version: "1",
      })}</channel>`,
    ),
  });
  const runner = remoteObjectRunner(new Map([
    [`${APPROVED_R2_BUCKET}/${deltaKey}`, deltaBytes],
  ]));
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: runner.run,
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_SIGNATURE_INVALID" },
    );
    assert.equal(
      runner.calls.some((call) => call[2] === "put"),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a candidate that is not newer than the live appcast", async () => {
  const previous = await createReleaseFixture({ bundleVersion: "2" });
  const candidate = await createReleaseFixture({ bundleVersion: "2" });
  const currentAppcast = await readFile(previous.appcastPath);
  const runner = remoteObjectRunner(new Map([
    [`${APPROVED_R2_BUCKET}/appcast.xml`, currentAppcast],
  ]));
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: candidate.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        dmgPath: candidate.dmgPath,
        publish: true,
        releaseManifestPath: candidate.releaseManifestPath,
        replaceAppcast: true,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: runner.run,
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_VERSION_NOT_NEWER" },
    );
    assert.equal(
      runner.calls.some((call) => call[2] === "put"), false);
  } finally {
    await previous.cleanup();
    await candidate.cleanup();
  }
});

test("fails closed when the appcast signature, URL, or manifest checksum is invalid", async () => {
  const unsigned = await createReleaseFixture({
    mutateAppcast: (value) => value.replace(/ sparkle:edSignature="[^"]+"/u, ""),
  });
  const badSignature = await createReleaseFixture({
    mutateAppcast: (value) => value.replace(
      /sparkle:edSignature="[^"]+"/u,
      `sparkle:edSignature="${Buffer.alloc(64, 11).toString("base64")}"`,
    ),
  });
  const wrongOrigin = await createReleaseFixture({
    mutateAppcast: (value) => value.replace(CANONICAL_UPDATE_ORIGIN, "https://updates.example.test"),
  });
  const wrongChecksum = await createReleaseFixture({
    mutateManifest: (value) => ({ ...value, artifact: { ...value.artifact, sha256: "a".repeat(64) } }),
  });
  const nonCanonicalFeed = await createReleaseFixture({
    mutateManifest: (value) => ({
      ...value,
      updater: { ...value.updater, appcastURL: "https://example.test/appcast.xml" },
    }),
  });
  try {
    for (const fixture of [
      unsigned,
      badSignature,
      wrongOrigin,
      wrongChecksum,
      nonCanonicalFeed,
    ]) {
      await assert.rejects(
        publishSparkleUpdate({
          appcastPath: fixture.appcastPath,
          bucket: APPROVED_R2_BUCKET,
          dmgPath: fixture.dmgPath,
          releaseManifestPath: fixture.releaseManifestPath,
          sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
          runWrangler: async () => assert.fail("invalid input must not call Wrangler"),
          validateDMG: async () => {},
        }),
      );
    }
  } finally {
    await Promise.all([
      unsigned.cleanup(),
      badSignature.cleanup(),
      wrongOrigin.cleanup(),
      wrongChecksum.cleanup(),
      nonCanonicalFeed.cleanup(),
    ]);
  }
});

test("requires the supplied public key to match the release manifest fingerprint", async () => {
  const fixture = await createReleaseFixture();
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        dmgPath: fixture.dmgPath,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: Buffer.alloc(32, 9).toString("base64"),
        runWrangler: async () => assert.fail("key mismatch must not call Wrangler"),
        validateDMG: async () => assert.fail("key mismatch must not validate the DMG"),
      }),
      { code: "SPARKLE_UPDATE_PUBLIC_KEY_MISMATCH" },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("requires the approved explicit bucket and does not accept signing-key arguments", async () => {
  const parsed = parseSparkleUpdatePublisherArguments([
    "--bucket", APPROVED_R2_BUCKET,
    "--dmg", "release.dmg",
    "--appcast", "appcast.xml",
    "--release-manifest", "release.json",
    "--sparkle-public-ed-key", TEST_PUBLIC_ED_KEY,
  ]);
  assert.equal(parsed.sparklePublicEdKey, TEST_PUBLIC_ED_KEY);
  assert.throws(
    () => parseSparkleUpdatePublisherArguments([
      "--bucket", "other-bucket",
      "--dmg", "release.dmg",
      "--appcast", "appcast.xml",
      "--release-manifest", "release.json",
      "--private-key", "not-accepted",
    ]),
    /Unknown or repeated argument/u,
  );
  assert.throws(
    () => parseSparkleUpdatePublisherArguments([
      "--bucket", APPROVED_R2_BUCKET,
      "--dmg", "release.dmg",
      "--appcast", "appcast.xml",
      "--release-manifest", "release.json",
      "--sparkle-public-ed-key", TEST_PUBLIC_ED_KEY,
      "--replace-appcast",
    ]),
    /requires --publish/u,
  );
  await assert.rejects(
    publishSparkleUpdate({
      appcastPath: "appcast.xml",
      bucket: "another-bucket",
      dmgPath: "release.dmg",
      releaseManifestPath: "release.json",
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      runWrangler: async () => assert.fail("an unapproved bucket must not run Wrangler"),
      validateDMG: async () => assert.fail("an unapproved bucket must not validate inputs"),
    }),
    /approved bucket/u,
  );
});
