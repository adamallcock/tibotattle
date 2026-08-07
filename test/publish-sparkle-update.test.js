import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  RELEASE_MANIFEST,
  RELEASE_VERSION,
} from "../config/release-manifest.js";
import { createMacOSSignedReplacementContract } from "../scripts/macos-release-core.js";
import { SPARKLE_VERSION } from "../scripts/macos-updater-core.js";
import { getReleaseChannel } from "../config/release-channels.js";
import { CANONICAL_STABLE_APPCAST_POLICY } from "../config/sparkle-appcast-policy.js";
import {
  APPROVED_R2_BUCKET,
  APPCAST_ATOMIC_GUARD_SCHEMA,
  APPCAST_ATOMIC_GUARD_ROUTE,
  APPCAST_ATOMIC_GUARD_TOKEN_ENV,
  APPCAST_CACHE_CONTROL,
  CANONICAL_APPCAST_URL,
  CANONICAL_UPDATE_ORIGIN,
  IMMUTABLE_CACHE_CONTROL,
  parseSparkleUpdatePublisherArguments,
  publishSparkleUpdate as publishSparkleUpdateRaw,
} from "../scripts/publish-sparkle-update.js";

const TEST_KEY_PAIR = generateKeyPairSync("ed25519");
const TEST_PUBLIC_ED_KEY = TEST_KEY_PAIR.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64");
const STABLE_CHANNEL = getReleaseChannel("stable");
const DOGFOOD_CHANNEL = getReleaseChannel("internal-dogfood");
const TEST_PUBLIC_ED_KEY_SHA256 = sha256(
  Buffer.from(TEST_PUBLIC_ED_KEY, "base64"),
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function publishSparkleUpdate(options) {
  return publishSparkleUpdateRaw({
    atomicAppcastGuard: options.atomicAppcastGuard
      ?? options.runWrangler?.atomicAppcastGuard
      ?? null,
    stableBootstrap: true,
    ...options,
  });
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
  const fileName = RELEASE_MANIFEST.macOS.arm64DmgFileName;
  const dmgPath = join(root, fileName);
  const appcastPath = join(root, "appcast.xml");
  const releaseManifestPath = join(root, `${fileName}.release.json`);
  const digest = sha256(dmgbBytes);
  const signature = sign(null, dmgbBytes, TEST_KEY_PAIR.privateKey)
    .toString("base64");
  const artifactURL = `${STABLE_CHANNEL.sparkle.origin}/${STABLE_CHANNEL.sparkle.objectPrefix}/${bundleVersion}/${digest}/${fileName}`;
  const manifest = mutateManifest({
    schemaVersion: "usage-monitor-macos-release-v0.2",
    application: {
      bundleIdentifier: "com.usagemonitor.local",
      bundleVersion,
      shortVersion: RELEASE_VERSION,
    },
    artifact: { bytes: dmgbBytes.length, fileName, sha256: digest },
    channel: {
      name: STABLE_CHANNEL.name,
      serviceOriginMode: STABLE_CHANNEL.serviceOriginMode,
      serviceOrigin: STABLE_CHANNEL.serviceOrigin,
      publicWebsiteOrigin: STABLE_CHANNEL.publicWebsiteOrigin,
      sparkle: {
        origin: STABLE_CHANNEL.sparkle.origin,
        appcastURL: STABLE_CHANNEL.sparkle.appcastURL,
        appcastObjectKey: STABLE_CHANNEL.sparkle.appcastObjectKey,
        r2Bucket: STABLE_CHANNEL.sparkle.r2Bucket,
        objectPrefix: STABLE_CHANNEL.sparkle.objectPrefix,
        atomicGuardURL: STABLE_CHANNEL.sparkle.atomicGuardURL,
        publicEdKeySha256: TEST_PUBLIC_ED_KEY_SHA256,
      },
    },
    replacement: createMacOSSignedReplacementContract(),
    source: {
      commit: "a".repeat(40),
      tag: "v0.1.0",
    },
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
      afterUserOptIn: {
        automaticDownload: true,
        installOnQuit: true,
      },
      automaticChecks: true,
      automaticUpdateOptInAvailable: true,
      automaticUpdatesEnabledByDefault: true,
      enabled: true,
      frameworkVersion: SPARKLE_VERSION,
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
    appcast,
    appcastPath,
    artifactURL,
    cleanup: () => rm(root, { recursive: true, force: true }),
    dmgBytes: dmgbBytes,
    dmgPath,
    releaseManifestPath,
  };
}

function publicReadbackFixture(fixture, {
  appcastBody = fixture.appcast,
  appcastContentLength = true,
  artifactBody = fixture.dmgBytes,
  artifactContentLength = true,
} = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options = {}) => {
      calls.push({ method: options.method ?? "GET", url });
      if (url === CANONICAL_APPCAST_URL) {
        return new Response(appcastBody, {
          headers: {
            "Cache-Control": APPCAST_CACHE_CONTROL,
            ...(appcastContentLength
              ? { "Content-Length": String(Buffer.byteLength(appcastBody)) }
              : {}),
            "Content-Type": "application/xml; charset=utf-8",
          },
          status: 200,
        });
      }
      if (url === fixture.artifactURL) {
        return new Response(artifactBody, {
          headers: {
            "Cache-Control": IMMUTABLE_CACHE_CONTROL,
            ...(artifactContentLength
              ? { "Content-Length": String(artifactBody.length) }
              : {}),
            "Content-Type": "application/x-apple-diskimage",
          },
          status: 200,
        });
      }
      return new Response(null, { status: 404 });
    },
  };
}

function missingRemoteObjectRunner() {
  return remoteObjectRunner();
}

function nonMaterializedRemoteObjectRunner() {
  const calls = [];
  const run = async (arguments_) => {
    calls.push(arguments_);
    return { status: 0 };
  };
  const runner = { calls, objects: new Map(), run };
  run.atomicAppcastGuard = createTestAtomicAppcastGuard(runner);
  return runner;
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
  const runner = { calls, objects, run };
  run.atomicAppcastGuard = createTestAtomicAppcastGuard(runner);
  return runner;
}

function statefulRemoteObjectRunner({
  failures = new Map(),
  objects = new Map(),
} = {}) {
  const calls = [];
  const remoteObjects = new Map(objects);
  const remainingFailures = new Map(failures);
  const run = async (arguments_) => {
    calls.push(arguments_);
    const operation = arguments_.at(2);
    const objectPath = arguments_.at(3);
    if (operation === "get") {
      if (!remoteObjects.has(objectPath)) {
        return { status: 1, stderr: "Object not found" };
      }
      const destination = arguments_[arguments_.indexOf("--file") + 1];
      await writeFile(destination, remoteObjects.get(objectPath));
      return { status: 0 };
    }
    if (operation === "put") {
      const remaining = remainingFailures.get(objectPath) ?? 0;
      if (remaining > 0) {
        remainingFailures.set(objectPath, remaining - 1);
        return { status: 1, stderr: "simulated publication failure" };
      }
      const source = arguments_[arguments_.indexOf("--file") + 1];
      remoteObjects.set(objectPath, await readFile(source));
      return { status: 0 };
    }
    return { status: 1, stderr: `unsupported mocked operation: ${operation}` };
  };
  const runner = { calls, objects: remoteObjects, run };
  run.atomicAppcastGuard = createTestAtomicAppcastGuard(runner);
  return runner;
}

function createTestAtomicAppcastGuard(runner, { beforeCompare = null } = {}) {
  return {
    schemaVersion: APPCAST_ATOMIC_GUARD_SCHEMA,
    ownerOnly: true,
    compareAndSwap: async ({
      bucket,
      cacheControl,
      contentType,
      content,
      expectedCurrent,
      key,
      path,
    }) => {
      if (beforeCompare) await beforeCompare({ bucket, key });
      const objectPath = `${bucket}/${key}`;
      const actual = runner.objects.get(objectPath) ?? null;
      const matches = expectedCurrent === null
        ? actual === null
        : actual !== null
          && actual.length === expectedCurrent.bytes
          && sha256(actual) === expectedCurrent.sha256
          && actual.equals(expectedCurrent.content);
      if (!matches) return { status: "conflict" };
      assert.deepEqual(content, await readFile(path));
      const result = await runner.run([
        "r2",
        "object",
        "put",
        objectPath,
        "--file",
        path,
        "--content-type",
        contentType,
        "--cache-control",
        cacheControl,
        "--remote",
      ]);
      if (result?.status !== 0) {
        const error = new Error("simulated atomic appcast mutation failed");
        error.code = "SPARKLE_UPDATE_WRANGLER_FAILED";
        throw error;
      }
      return { status: "committed" };
    },
  };
}

function appcastEnclosure({ bytes, deltaFrom, signature, url, version }) {
  const delta = deltaFrom === undefined
    ? ""
    : ` sparkle:deltaFrom="${deltaFrom}"`;
  const enclosureSignature = signature
    ?? sign(null, bytes, TEST_KEY_PAIR.privateKey).toString("base64");
  return `<item><enclosure url="${url}" length="${bytes.length}" sparkle:version="${version}"${delta} sparkle:edSignature="${enclosureSignature}" /></item>`;
}

function deltaEnclosureBlock(deltas) {
  if (deltas.length === 0) return "";
  return `<sparkle:deltas>\n${deltas.map((delta) =>
    `<enclosure url="${delta.url}" sparkle:deltaFrom="${delta.deltaFrom}" length="${delta.bytes.length}" type="application/octet-stream" sparkle:edSignature="${delta.signature}" />`).join("\n")}\n</sparkle:deltas>\n`;
}

/**
 * A dogfood release fixture mirroring what generate-sparkle-appcast.js emits:
 * one item carrying the signed full DMG enclosure plus signed delta
 * enclosures inside the item's sparkle:deltas container, with the delta
 * artifacts beside the DMG.
 */
async function createDogfoodReleaseFixture({
  bundleVersion = "2",
  deltaSources = ["1"],
  mutateAppcast = (value) => value,
  writeDeltaFiles = true,
} = {}) {
  const channel = DOGFOOD_CHANNEL;
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "tibotattle-dogfood-publisher-test-"),
  );
  const fileName = RELEASE_MANIFEST.macOS.arm64DmgFileName;
  const dmgBytes = Buffer.from(`signed-dogfood-dmg-fixture-${bundleVersion}`);
  const dmgPath = join(root, fileName);
  const appcastPath = join(root, "appcast.xml");
  const releaseManifestPath = join(root, `${fileName}.release.json`);
  const digest = sha256(dmgBytes);
  const signature = sign(null, dmgBytes, TEST_KEY_PAIR.privateKey)
    .toString("base64");
  const prefix = `${channel.sparkle.origin}/${channel.sparkle.objectPrefix}`;
  const artifactURL = `${prefix}/${bundleVersion}/${digest}/${fileName}`;
  const deltaBase = fileName.slice(0, -".dmg".length);
  const deltas = deltaSources.map((deltaFrom) => {
    const bytes = Buffer.from(
      `sparkle-binary-delta-${deltaFrom}-to-${bundleVersion}`,
    );
    const deltaFileName = `${deltaBase}-from-${deltaFrom}.delta`;
    return {
      bytes,
      deltaFrom,
      fileName: deltaFileName,
      path: join(root, deltaFileName),
      sha256: sha256(bytes),
      signature: sign(null, bytes, TEST_KEY_PAIR.privateKey)
        .toString("base64"),
      url: `${prefix}/${bundleVersion}/${sha256(bytes)}/${deltaFileName}`,
    };
  });
  const manifest = {
    schemaVersion: "usage-monitor-macos-release-v0.2",
    application: {
      bundleIdentifier: "com.usagemonitor.local",
      bundleVersion,
      shortVersion: RELEASE_VERSION,
    },
    artifact: { bytes: dmgBytes.length, fileName, sha256: digest },
    channel: {
      name: channel.name,
      serviceOriginMode: channel.serviceOriginMode,
      serviceOrigin: channel.serviceOrigin,
      publicWebsiteOrigin: channel.publicWebsiteOrigin,
      sparkle: {
        origin: channel.sparkle.origin,
        appcastURL: channel.sparkle.appcastURL,
        appcastObjectKey: channel.sparkle.appcastObjectKey,
        r2Bucket: channel.sparkle.r2Bucket,
        objectPrefix: channel.sparkle.objectPrefix,
        atomicGuardURL: channel.sparkle.atomicGuardURL,
        publicEdKeySha256: channel.sparkle.publicEdKeySha256,
      },
    },
    replacement: createMacOSSignedReplacementContract(),
    source: { commit: "a".repeat(40), tag: "v0.1.1" },
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
      appcastURL: channel.sparkle.appcastURL,
      afterUserOptIn: { automaticDownload: true, installOnQuit: true },
      automaticChecks: true,
      automaticUpdateOptInAvailable: true,
      automaticUpdatesEnabledByDefault: true,
      enabled: true,
      frameworkVersion: SPARKLE_VERSION,
      publicEdKeySha256: TEST_PUBLIC_ED_KEY_SHA256,
      requiresSignedFeed: true,
    },
  };
  const appcast = mutateAppcast(`<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel><item>
<sparkle:version>${bundleVersion}</sparkle:version>
<enclosure url="${artifactURL}" length="${dmgBytes.length}" type="application/x-apple-diskimage" sparkle:edSignature="${signature}" />
${deltaEnclosureBlock(deltas)}</item></channel></rss>
`);
  await Promise.all([
    writeFile(dmgPath, dmgBytes),
    writeFile(appcastPath, appcast),
    writeFile(releaseManifestPath, `${JSON.stringify(manifest)}\n`),
    ...(writeDeltaFiles
      ? deltas.map((delta) => writeFile(delta.path, delta.bytes))
      : []),
  ]);
  return {
    appcast,
    appcastPath,
    artifactURL,
    bucket: channel.sparkle.r2Bucket,
    channel,
    cleanup: () => rm(root, { recursive: true, force: true }),
    deltas,
    dmgBytes,
    dmgPath,
    releaseManifestPath,
  };
}

function dogfoodPublicReadbackFixture(fixture) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options = {}) => {
      const method = options.method ?? "GET";
      calls.push({ method, url });
      if (url === fixture.channel.sparkle.appcastURL) {
        return new Response(fixture.appcast, {
          headers: {
            "Cache-Control": APPCAST_CACHE_CONTROL,
            "Content-Length": String(Buffer.byteLength(fixture.appcast)),
            "Content-Type": "application/xml; charset=utf-8",
          },
          status: 200,
        });
      }
      if (url === fixture.artifactURL) {
        return new Response(fixture.dmgBytes, {
          headers: {
            "Cache-Control": IMMUTABLE_CACHE_CONTROL,
            "Content-Length": String(fixture.dmgBytes.length),
            "Content-Type": "application/x-apple-diskimage",
          },
          status: 200,
        });
      }
      const delta = fixture.deltas.find((entry) => entry.url === url);
      if (delta !== undefined) {
        return new Response(method === "HEAD" ? null : delta.bytes, {
          headers: {
            "Cache-Control": IMMUTABLE_CACHE_CONTROL,
            "Content-Length": String(delta.bytes.length),
            "Content-Type": "application/octet-stream",
          },
          status: 200,
        });
      }
      return new Response(null, { status: 404 });
    },
  };
}

test("validates an explicitly supplied canonical signed update without invoking Wrangler by default", async () => {
  const fixture = await createReleaseFixture();
  const verified = [];
  try {
    assert.deepEqual(CANONICAL_STABLE_APPCAST_POLICY, {
      allowDeltaFrom: false,
      channelItemCount: 1,
      enclosureCount: 1,
      fullDmgOnly: true,
      retainHistory: false,
      schemaVersion: "usage-monitor-sparkle-canonical-stable-appcast-v1",
    });
    const publication = await publishSparkleUpdate({
      appcastPath: fixture.appcastPath,
      bucket: APPROVED_R2_BUCKET,
      channel: "stable",
      dmgPath: fixture.dmgPath,
      releaseManifestPath: fixture.releaseManifestPath,
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      runWrangler: async () => assert.fail("dry run must not call Wrangler"),
      validateDMG: async (...arguments_) => verified.push(arguments_),
    });
    const digest = publication.artifact.sha256;
    assert.equal(publication.published, false);
    assert.equal(publication.status, "validated");
    assert.equal(publication.verified, false);
    assert.equal(publication.appcast.url, CANONICAL_APPCAST_URL);
    assert.equal(
      publication.artifact.key,
      `releases/1/${digest}/${RELEASE_MANIFEST.macOS.arm64DmgFileName}`,
    );
    assert.equal(
      publication.manifest.key,
      `releases/1/${digest}/release-manifest.json`,
    );
    assert.equal(publication.artifact.cacheControl, IMMUTABLE_CACHE_CONTROL);
    assert.equal(publication.manifest.cacheControl, IMMUTABLE_CACHE_CONTROL);
    assert.equal(publication.appcast.cacheControl, APPCAST_CACHE_CONTROL);
    assert.deepEqual(verified, [[fixture.dmgPath, {
      channel: "stable",
      expectedBundleIdentifier: "com.usagemonitor.local",
      expectedBundleVersion: "1",
      expectedShortVersion: "0.1.0",
      production: true,
    }]]);
  } finally {
    await fixture.cleanup();
  }
});

test("accepts the empty paired enclosure emitted by the reviewed Sparkle generator", async () => {
  const fixture = await createReleaseFixture({
    mutateAppcast: (value) => value
      .replace(' sparkle:version="1"', "")
      .replace("<enclosure ", "<sparkle:version>1</sparkle:version>\n<enclosure ")
      .replace(" />", "></enclosure>"),
  });
  try {
    const publication = await publishSparkleUpdate({
      appcastPath: fixture.appcastPath,
      bucket: APPROVED_R2_BUCKET,
      channel: "stable",
      dmgPath: fixture.dmgPath,
      releaseManifestPath: fixture.releaseManifestPath,
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      validateDMG: async () => {},
    });
    assert.equal(publication.status, "validated");
    assert.equal(publication.artifact.url, fixture.artifactURL);
  } finally {
    await fixture.cleanup();
  }
});

test("does not consume a remote guard token during validation-only runs", async () => {
  const fixture = await createReleaseFixture();
  const token = "validation-only-guard-token-012345678901";
  const previousToken = process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV];
  process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV] = token;
  try {
    await publishSparkleUpdateRaw({
      appcastPath: fixture.appcastPath,
      atomicAppcastGuardEndpoint: `${STABLE_CHANNEL.serviceOrigin}${APPCAST_ATOMIC_GUARD_ROUTE}`,
      atomicAppcastGuardTokenEnv: APPCAST_ATOMIC_GUARD_TOKEN_ENV,
      bucket: APPROVED_R2_BUCKET,
      channel: "stable",
      dmgPath: fixture.dmgPath,
      releaseManifestPath: fixture.releaseManifestPath,
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      stableBootstrap: true,
      validateDMG: async () => {
        assert.equal(process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV], token);
      },
    });
    assert.equal(process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV], token);
  } finally {
    if (previousToken === undefined) {
      delete process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV];
    } else {
      process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV] = previousToken;
    }
    await fixture.cleanup();
  }
});

test("requires explicit stable continuity state even for validation-only publisher runs", async () => {
  const fixture = await createReleaseFixture();
  try {
    await assert.rejects(
      publishSparkleUpdateRaw({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        releaseManifestPath: fixture.releaseManifestPath,
        runWrangler: async () => assert.fail("continuity must fail before Wrangler"),
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        validateDMG: async () => {},
      }),
      { code: "MACOS_STABLE_PREVIOUS_MANIFEST_REQUIRED" },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("fails closed before any remote mutation without the owner atomic appcast guard", async () => {
  const fixture = await createReleaseFixture();
  const runner = missingRemoteObjectRunner();
  try {
    await assert.rejects(
      publishSparkleUpdateRaw({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        stableBootstrap: true,
        runWrangler: runner.run,
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_ATOMIC_GUARD_REQUIRED" },
    );
    assert.equal(runner.calls.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("requires both explicit guard endpoint and token before any remote mutation", async () => {
  const fixture = await createReleaseFixture();
  const runner = missingRemoteObjectRunner();
  try {
    await assert.rejects(
      publishSparkleUpdateRaw({
        appcastPath: fixture.appcastPath,
        atomicAppcastGuardEndpoint: `${STABLE_CHANNEL.serviceOrigin}${APPCAST_ATOMIC_GUARD_ROUTE}`,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        stableBootstrap: true,
        runWrangler: runner.run,
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_ATOMIC_GUARD_OPTIONS_REQUIRED" },
    );
    assert.equal(runner.calls.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects injected atomic guards combined with either remote guard option", async () => {
  const injectedGuard = {
    schemaVersion: APPCAST_ATOMIC_GUARD_SCHEMA,
    ownerOnly: true,
    compareAndSwap: async () => ({ status: "committed" }),
  };
  for (const remoteOptions of [
    {
      atomicAppcastGuardEndpoint:
        `${STABLE_CHANNEL.serviceOrigin}${APPCAST_ATOMIC_GUARD_ROUTE}`,
    },
    { atomicAppcastGuardTokenEnv: APPCAST_ATOMIC_GUARD_TOKEN_ENV },
  ]) {
    await assert.rejects(
      publishSparkleUpdateRaw({
        ...remoteOptions,
        appcastPath: "not-read-appcast.xml",
        atomicAppcastGuard: injectedGuard,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: "not-read.dmg",
        publish: true,
        releaseManifestPath: "not-read-release.json",
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        stableBootstrap: true,
      }),
      { code: "SPARKLE_UPDATE_ATOMIC_GUARD_OPTIONS_CONFLICT" },
    );
  }
});

test("fails closed when the explicit guard token environment variable is unset", async () => {
  const fixture = await createReleaseFixture();
  const runner = missingRemoteObjectRunner();
  const previousToken = process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV];
  delete process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV];
  try {
    await assert.rejects(
      publishSparkleUpdateRaw({
        appcastPath: fixture.appcastPath,
        atomicAppcastGuardEndpoint: `${STABLE_CHANNEL.serviceOrigin}${APPCAST_ATOMIC_GUARD_ROUTE}`,
        atomicAppcastGuardTokenEnv: APPCAST_ATOMIC_GUARD_TOKEN_ENV,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        stableBootstrap: true,
        runWrangler: runner.run,
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_ATOMIC_GUARD_TOKEN_REQUIRED" },
    );
    assert.equal(runner.calls.length, 0);
  } finally {
    if (previousToken === undefined) {
      delete process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV];
    } else {
      process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV] = previousToken;
    }
    await fixture.cleanup();
  }
});

test("publishes through the explicit owner guard endpoint without exposing its token", async () => {
  const fixture = await createReleaseFixture();
  const runner = missingRemoteObjectRunner();
  const publicReadback = publicReadbackFixture(fixture);
  const guardCalls = [];
  const token = "owner-release-guard-token-012345678901";
  const previousToken = process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV];
  process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV] = token;
  try {
    const publication = await publishSparkleUpdateRaw({
      appcastPath: fixture.appcastPath,
      atomicAppcastGuardEndpoint: `${STABLE_CHANNEL.serviceOrigin}${APPCAST_ATOMIC_GUARD_ROUTE}`,
      atomicAppcastGuardTokenEnv: APPCAST_ATOMIC_GUARD_TOKEN_ENV,
      bucket: APPROVED_R2_BUCKET,
      channel: "stable",
      dmgPath: fixture.dmgPath,
      publish: true,
      releaseManifestPath: fixture.releaseManifestPath,
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      stableBootstrap: true,
      runWrangler: runner.run,
      fetchGuard: async (url, options) => {
        guardCalls.push({ url, options });
        return Response.json({
          schemaVersion: APPCAST_ATOMIC_GUARD_SCHEMA,
          status: "committed",
        });
      },
      fetchPublic: publicReadback.fetch,
      validateDMG: async () => {
        assert.equal(process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV], undefined);
      },
    });
    assert.equal(publication.status, "published");
    assert.equal(guardCalls.length, 1);
    assert.equal(guardCalls[0].url, `${STABLE_CHANNEL.serviceOrigin}${APPCAST_ATOMIC_GUARD_ROUTE}`);
    assert.equal(guardCalls[0].options.method, "POST");
    assert.equal(guardCalls[0].options.headers["x-usage-monitor-release-signature"].length, 43);
    assert.equal(guardCalls[0].options.body.includes(token), false);
    assert.equal(process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV], undefined);
    assert.equal(runner.calls.some((call) => call[2] === "put"
      && call[3] === `${APPROVED_R2_BUCKET}/appcast.xml`), false);
  } finally {
    if (previousToken === undefined) {
      delete process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV];
    } else {
      process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV] = previousToken;
    }
    await fixture.cleanup();
  }
});

test("removes a remote guard token before a failing DMG validation", async () => {
  const fixture = await createReleaseFixture();
  const token = "failing-validation-guard-token-012345678901";
  const previousToken = process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV];
  process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV] = token;
  try {
    await assert.rejects(
      publishSparkleUpdateRaw({
        appcastPath: fixture.appcastPath,
        atomicAppcastGuardEndpoint: `${STABLE_CHANNEL.serviceOrigin}${APPCAST_ATOMIC_GUARD_ROUTE}`,
        atomicAppcastGuardTokenEnv: APPCAST_ATOMIC_GUARD_TOKEN_ENV,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        stableBootstrap: true,
        validateDMG: async () => {
          assert.equal(process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV], undefined);
          throw new Error("synthetic DMG validation failure");
        },
      }),
      { message: "synthetic DMG validation failure" },
    );
    assert.equal(process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV], undefined);
  } finally {
    if (previousToken === undefined) {
      delete process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV];
    } else {
      process.env[APPCAST_ATOMIC_GUARD_TOKEN_ENV] = previousToken;
    }
    await fixture.cleanup();
  }
});

test("publishes only the three validated objects with cache-safe Wrangler metadata", async () => {
  const fixture = await createReleaseFixture();
  const runner = missingRemoteObjectRunner();
  const publicReadback = publicReadbackFixture(fixture);
  try {
    const publication = await publishSparkleUpdate({
      appcastPath: fixture.appcastPath,
      bucket: APPROVED_R2_BUCKET,
      channel: "stable",
      dmgPath: fixture.dmgPath,
      publish: true,
      releaseManifestPath: fixture.releaseManifestPath,
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      runWrangler: runner.run,
      fetchPublic: publicReadback.fetch,
      validateDMG: async () => {},
    });
    assert.equal(publication.published, true);
    assert.equal(publication.status, "published");
    assert.equal(publication.verified, true);
    assert.equal(runner.calls.length, 7);
    assert.deepEqual(runner.calls.slice(0, 3).map((call) => call.slice(0, 4)), [
      ["r2", "object", "get", `${APPROVED_R2_BUCKET}/${publication.artifact.key}`],
      ["r2", "object", "get", `${APPROVED_R2_BUCKET}/${publication.manifest.key}`],
      ["r2", "object", "get", `${APPROVED_R2_BUCKET}/appcast.xml`],
    ]);
    assert.deepEqual(runner.calls.slice(3, 5).map((call) => call.slice(0, 4)), [
      ["r2", "object", "put", `${APPROVED_R2_BUCKET}/${publication.artifact.key}`],
      ["r2", "object", "put", `${APPROVED_R2_BUCKET}/${publication.manifest.key}`],
    ]);
    assert.deepEqual(runner.calls[5].slice(0, 4), [
      "r2", "object", "get", `${APPROVED_R2_BUCKET}/appcast.xml`,
    ]);
    assert.deepEqual(runner.calls[6].slice(0, 4), [
      "r2", "object", "put", `${APPROVED_R2_BUCKET}/appcast.xml`,
    ]);
    assert.equal(runner.calls[3].includes("application/x-apple-diskimage"), true);
    assert.equal(runner.calls[3].includes(IMMUTABLE_CACHE_CONTROL), true);
    assert.equal(runner.calls[4].includes("application/json; charset=utf-8"), true);
    assert.equal(runner.calls[4].includes(IMMUTABLE_CACHE_CONTROL), true);
    assert.equal(runner.calls[6].includes("application/xml; charset=utf-8"), true);
    assert.equal(runner.calls[6].includes(APPCAST_CACHE_CONTROL), true);
    assert.equal(runner.calls.flat().includes("--force"), false);
    assert.deepEqual(publicReadback.calls, [
      { method: "GET", url: CANONICAL_APPCAST_URL },
      { method: "GET", url: fixture.artifactURL },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a concurrent appcast change through the owner atomic guard", async () => {
  const fixture = await createReleaseFixture();
  const runner = statefulRemoteObjectRunner();
  const atomicAppcastGuard = createTestAtomicAppcastGuard(runner, {
    beforeCompare: async ({ bucket, key }) => {
      runner.objects.set(
        `${bucket}/${key}`,
        Buffer.from("concurrent appcast state"),
      );
    },
  });
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        atomicAppcastGuard,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: runner.run,
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_APPCAST_ATOMIC_CONFLICT" },
    );
    assert.equal(
      runner.objects.get(`${APPROVED_R2_BUCKET}/appcast.xml`).toString(),
      "concurrent appcast state",
    );
    assert.equal(
      runner.calls.some((call) => call[2] === "put"
        && call[3] === `${APPROVED_R2_BUCKET}/appcast.xml`),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("retries after an artifact-only partial publication and resumes missing work", async () => {
  const fixture = await createReleaseFixture();
  const digest = sha256(fixture.dmgBytes);
  const artifactObjectPath = `${APPROVED_R2_BUCKET}/releases/1/${digest}/${RELEASE_MANIFEST.macOS.arm64DmgFileName}`;
  const manifestObjectPath = `${APPROVED_R2_BUCKET}/releases/1/${digest}/release-manifest.json`;
  const appcastObjectPath = `${APPROVED_R2_BUCKET}/appcast.xml`;
  const runner = statefulRemoteObjectRunner({
    failures: new Map([[manifestObjectPath, 1]]),
  });
  const publicReadback = publicReadbackFixture(fixture);
  const options = {
    appcastPath: fixture.appcastPath,
    bucket: APPROVED_R2_BUCKET,
    channel: "stable",
    dmgPath: fixture.dmgPath,
    publish: true,
    releaseManifestPath: fixture.releaseManifestPath,
    sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
    runWrangler: runner.run,
    fetchPublic: publicReadback.fetch,
    validateDMG: async () => {},
  };
  try {
    await assert.rejects(publishSparkleUpdate(options), {
      code: "SPARKLE_UPDATE_WRANGLER_FAILED",
    });
    assert.deepEqual(runner.objects.get(artifactObjectPath), fixture.dmgBytes);
    assert.equal(runner.objects.has(manifestObjectPath), false);
    assert.equal(runner.objects.has(appcastObjectPath), false);

    const publication = await publishSparkleUpdate(options);
    assert.equal(publication.published, true);
    assert.equal(publication.status, "published");
    assert.deepEqual(
      runner.calls.filter((call) => call[2] === "put").map((call) => call[3]),
      [artifactObjectPath, manifestObjectPath, manifestObjectPath, appcastObjectPath],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("retries after artifact and manifest publication and writes the appcast last", async () => {
  const fixture = await createReleaseFixture();
  const digest = sha256(fixture.dmgBytes);
  const artifactObjectPath = `${APPROVED_R2_BUCKET}/releases/1/${digest}/${RELEASE_MANIFEST.macOS.arm64DmgFileName}`;
  const manifestObjectPath = `${APPROVED_R2_BUCKET}/releases/1/${digest}/release-manifest.json`;
  const appcastObjectPath = `${APPROVED_R2_BUCKET}/appcast.xml`;
  const runner = statefulRemoteObjectRunner({
    failures: new Map([[appcastObjectPath, 1]]),
  });
  const publicReadback = publicReadbackFixture(fixture);
  const options = {
    appcastPath: fixture.appcastPath,
    bucket: APPROVED_R2_BUCKET,
    channel: "stable",
    dmgPath: fixture.dmgPath,
    publish: true,
    releaseManifestPath: fixture.releaseManifestPath,
    sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
    runWrangler: runner.run,
    fetchPublic: publicReadback.fetch,
    validateDMG: async () => {},
  };
  try {
    await assert.rejects(publishSparkleUpdate(options), {
      code: "SPARKLE_UPDATE_WRANGLER_FAILED",
    });
    assert.deepEqual(runner.objects.get(artifactObjectPath), fixture.dmgBytes);
    assert.deepEqual(
      runner.objects.get(manifestObjectPath),
      await readFile(fixture.releaseManifestPath),
    );
    assert.equal(runner.objects.has(appcastObjectPath), false);

    const publication = await publishSparkleUpdate(options);
    assert.equal(publication.published, true);
    assert.equal(publication.status, "published");
    assert.deepEqual(
      runner.calls.filter((call) => call[2] === "put").map((call) => call[3]),
      [artifactObjectPath, manifestObjectPath, appcastObjectPath, appcastObjectPath],
    );
    assert.deepEqual(runner.objects.get(appcastObjectPath), await readFile(fixture.appcastPath));
  } finally {
    await fixture.cleanup();
  }
});

test("recovers an appcast written before public readback failed without writing again", async () => {
  const fixture = await createReleaseFixture();
  const previous = await createReleaseFixture({ bundleVersion: "0" });
  const digest = sha256(fixture.dmgBytes);
  const artifactObjectPath = `${APPROVED_R2_BUCKET}/releases/1/${digest}/${RELEASE_MANIFEST.macOS.arm64DmgFileName}`;
  const manifestObjectPath = `${APPROVED_R2_BUCKET}/releases/1/${digest}/release-manifest.json`;
  const appcastObjectPath = `${APPROVED_R2_BUCKET}/appcast.xml`;
  const runner = statefulRemoteObjectRunner();
  const publicReadback = publicReadbackFixture(fixture);
  let failPublicReadback = true;
  const fetchPublic = async (...arguments_) => {
    if (failPublicReadback) {
      failPublicReadback = false;
      return new Response("transient readback failure", { status: 503 });
    }
    return publicReadback.fetch(...arguments_);
  };
  const options = {
    appcastPath: fixture.appcastPath,
    bucket: APPROVED_R2_BUCKET,
    channel: "stable",
    dmgPath: fixture.dmgPath,
    publish: true,
    releaseManifestPath: fixture.releaseManifestPath,
    previousStableManifestPath: previous.releaseManifestPath,
    replaceAppcast: true,
    sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
    stableBootstrap: false,
    runWrangler: runner.run,
    fetchPublic,
    validateDMG: async () => {},
  };
  try {
    await assert.rejects(publishSparkleUpdate(options), {
      code: "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
    });
    assert.deepEqual(
      runner.objects.get(appcastObjectPath),
      await readFile(fixture.appcastPath),
    );

    const publication = await publishSparkleUpdate(options);
    assert.equal(publication.published, true);
    assert.equal(publication.status, "resumed_verified");
    assert.equal(publication.resumed, true);
    assert.equal(publication.verified, true);
    assert.deepEqual(
      runner.calls.filter((call) => call[2] === "put").map((call) => call[3]),
      [artifactObjectPath, manifestObjectPath, appcastObjectPath],
    );
    assert.deepEqual(publicReadback.calls, [
      { method: "GET", url: CANONICAL_APPCAST_URL },
      { method: "GET", url: fixture.artifactURL },
    ]);
  } finally {
    await previous.cleanup();
    await fixture.cleanup();
  }
});

test("does not report publication success when the public appcast is unavailable", async () => {
  const fixture = await createReleaseFixture();
  const runner = missingRemoteObjectRunner();
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: runner.run,
        fetchPublic: async () => new Response("not found", { status: 404 }),
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED" },
    );
    assert.equal(runner.calls.length, 7);
  } finally {
    await fixture.cleanup();
  }
});

test("verifies exact public GET bodies when HTTP omits Content-Length", async () => {
  const fixture = await createReleaseFixture();
  const runner = missingRemoteObjectRunner();
  const publicReadback = publicReadbackFixture(fixture, {
    appcastContentLength: false,
    artifactContentLength: false,
  });
  try {
    const publication = await publishSparkleUpdate({
      appcastPath: fixture.appcastPath,
      bucket: APPROVED_R2_BUCKET,
      channel: "stable",
      dmgPath: fixture.dmgPath,
      publish: true,
      releaseManifestPath: fixture.releaseManifestPath,
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      runWrangler: runner.run,
      fetchPublic: publicReadback.fetch,
      validateDMG: async () => {},
    });
    assert.equal(publication.published, true);
    assert.equal(publication.verified, true);
    assert.deepEqual(publicReadback.calls, [
      { method: "GET", url: CANONICAL_APPCAST_URL },
      { method: "GET", url: fixture.artifactURL },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("does not report publication success when the public DMG bytes differ", async () => {
  const fixture = await createReleaseFixture();
  const runner = missingRemoteObjectRunner();
  const publicReadback = publicReadbackFixture(fixture, {
    artifactBody: Buffer.alloc(fixture.dmgBytes.length, 42),
  });
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: runner.run,
        fetchPublic: publicReadback.fetch,
        validateDMG: async () => {},
      }),
      {
        code: "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED",
        message: /SHA-256/u,
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("retains matching immutable objects without overwriting them", async () => {
  const fixture = await createReleaseFixture();
  const digest = sha256(fixture.dmgBytes);
  const runner = statefulRemoteObjectRunner({
    objects: new Map([
      [`${APPROVED_R2_BUCKET}/releases/1/${digest}/${RELEASE_MANIFEST.macOS.arm64DmgFileName}`, fixture.dmgBytes],
      [`${APPROVED_R2_BUCKET}/releases/1/${digest}/release-manifest.json`, await readFile(fixture.releaseManifestPath)],
    ]),
  });
  const publicReadback = publicReadbackFixture(fixture);
  try {
    const publication = await publishSparkleUpdate({
      appcastPath: fixture.appcastPath,
      bucket: APPROVED_R2_BUCKET,
      channel: "stable",
      dmgPath: fixture.dmgPath,
      publish: true,
      releaseManifestPath: fixture.releaseManifestPath,
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      runWrangler: runner.run,
      fetchPublic: publicReadback.fetch,
      validateDMG: async () => {},
    });
    assert.equal(publication.published, true);
    assert.deepEqual(
      runner.calls.filter((call) => call[2] === "put").map((call) => call[3]),
      [`${APPROVED_R2_BUCKET}/appcast.xml`],
    );
    assert.deepEqual(
      runner.objects.get(`${APPROVED_R2_BUCKET}/${publication.artifact.key}`),
      fixture.dmgBytes,
    );
    assert.deepEqual(
      runner.objects.get(`${APPROVED_R2_BUCKET}/${publication.manifest.key}`),
      await readFile(fixture.releaseManifestPath),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("aborts on mismatched existing immutable bytes before appcast mutation", async () => {
  const fixture = await createReleaseFixture();
  const digest = sha256(fixture.dmgBytes);
  const artifactKey = `${APPROVED_R2_BUCKET}/releases/1/${digest}/${RELEASE_MANIFEST.macOS.arm64DmgFileName}`;
  const runner = statefulRemoteObjectRunner({
    objects: new Map([[artifactKey, Buffer.alloc(fixture.dmgBytes.length, 42)]]),
  });
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: runner.run,
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_IMMUTABLE_OBJECT_MISMATCH" },
    );
    assert.equal(runner.calls.some((call) => call[2] === "put"), false);
    assert.equal(
      runner.calls.some((call) => call[3] === `${APPROVED_R2_BUCKET}/appcast.xml`),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("fails closed on a successful remote read with no materialized object", async () => {
  const fixture = await createReleaseFixture();
  const runner = nonMaterializedRemoteObjectRunner();
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: runner.run,
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_R2_OBJECT_INVALID" },
    );
    assert.equal(runner.calls.some((call) => call[2] === "put"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("requires an explicit appcast replacement after immutable preflight passes", async () => {
  const current = await createReleaseFixture({ bundleVersion: "0" });
  const fixture = await createReleaseFixture();
  const runner = statefulRemoteObjectRunner({
    objects: new Map([[`${APPROVED_R2_BUCKET}/appcast.xml`, await readFile(current.appcastPath)]]),
  });
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        previousStableManifestPath: current.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        stableBootstrap: false,
        runWrangler: runner.run,
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_APPCAST_REPLACE_REQUIRED" },
    );
    assert.equal(runner.calls.some((call) => call[2] === "put"), false);
  } finally {
    await current.cleanup();
    await fixture.cleanup();
  }
});

test("rejects stable appcast history before any remote mutation", async () => {
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
  const calls = [];
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: async (...arguments_) => {
          calls.push(arguments_);
          assert.fail("non-canonical stable appcast must not call Wrangler");
        },
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_APPCAST_HISTORY_UNSUPPORTED" },
    );
    assert.deepEqual(calls, []);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a stable Sparkle delta before any remote mutation", async () => {
  const fixture = await createReleaseFixture({
    mutateAppcast: (value) => value.replace(
      'sparkle:version="1"',
      'sparkle:version="1" sparkle:deltaFrom="0"',
    ),
  });
  const calls = [];
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: async (...arguments_) => {
          calls.push(arguments_);
          assert.fail("delta stable appcast must not call Wrangler");
        },
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_DELTA_UNSUPPORTED" },
    );
    assert.deepEqual(calls, []);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a changed equal-version live appcast before any remote mutation", async () => {
  const candidate = await createReleaseFixture({ bundleVersion: "2" });
  const previous = await createReleaseFixture({ bundleVersion: "1" });
  const candidateAppcast = await readFile(candidate.appcastPath, "utf8");
  const currentAppcast = Buffer.from(`${candidateAppcast} `);
  const runner = remoteObjectRunner(new Map([
    [`${APPROVED_R2_BUCKET}/appcast.xml`, currentAppcast],
  ]));
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: candidate.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: candidate.dmgPath,
        publish: true,
        releaseManifestPath: candidate.releaseManifestPath,
        previousStableManifestPath: previous.releaseManifestPath,
        replaceAppcast: true,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        stableBootstrap: false,
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

test("rejects an ambiguous equal-version live appcast before any remote mutation", async () => {
  const candidate = await createReleaseFixture();
  const previous = await createReleaseFixture({ bundleVersion: "0" });
  const candidateAppcast = await readFile(candidate.appcastPath, "utf8");
  const duplicateItem = candidateAppcast.match(/<item>[\s\S]*?<\/item>/u)?.[0];
  assert.equal(typeof duplicateItem, "string");
  const currentAppcast = Buffer.from(
    candidateAppcast.replace("</channel>", `${duplicateItem}</channel>`),
  );
  const runner = remoteObjectRunner(new Map([
    [`${APPROVED_R2_BUCKET}/appcast.xml`, currentAppcast],
  ]));
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: candidate.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: candidate.dmgPath,
        publish: true,
        releaseManifestPath: candidate.releaseManifestPath,
        previousStableManifestPath: previous.releaseManifestPath,
        replaceAppcast: true,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        stableBootstrap: false,
        runWrangler: runner.run,
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_APPCAST_AMBIGUOUS" },
    );
    assert.equal(runner.calls.some((call) => call[2] === "put"), false);
  } finally {
    await previous.cleanup();
    await candidate.cleanup();
  }
});

test("verifies an exact appcast retry without overwriting or reporting a new publish", async () => {
  const fixture = await createReleaseFixture();
  const previous = await createReleaseFixture({ bundleVersion: "0" });
  const digest = sha256(fixture.dmgBytes);
  const runner = statefulRemoteObjectRunner({
    objects: new Map([
      [`${APPROVED_R2_BUCKET}/releases/1/${digest}/${RELEASE_MANIFEST.macOS.arm64DmgFileName}`, fixture.dmgBytes],
      [`${APPROVED_R2_BUCKET}/releases/1/${digest}/release-manifest.json`, await readFile(fixture.releaseManifestPath)],
      [`${APPROVED_R2_BUCKET}/appcast.xml`, await readFile(fixture.appcastPath)],
    ]),
  });
  const publicReadback = publicReadbackFixture(fixture);
  try {
    const publication = await publishSparkleUpdate({
      appcastPath: fixture.appcastPath,
      bucket: APPROVED_R2_BUCKET,
      channel: "stable",
      dmgPath: fixture.dmgPath,
      publish: true,
      releaseManifestPath: fixture.releaseManifestPath,
      previousStableManifestPath: previous.releaseManifestPath,
      replaceAppcast: true,
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      stableBootstrap: false,
      runWrangler: runner.run,
      fetchPublic: publicReadback.fetch,
      validateDMG: async () => {},
    });
    assert.equal(publication.status, "resumed_verified");
    assert.equal(publication.resumed, true);
    assert.equal(publication.verified, true);
    assert.equal(runner.calls.some((call) => call[2] === "put"), false);
    assert.deepEqual(publicReadback.calls, [
      { method: "GET", url: CANONICAL_APPCAST_URL },
      { method: "GET", url: fixture.artifactURL },
    ]);
  } finally {
    await previous.cleanup();
    await fixture.cleanup();
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
          channel: "stable",
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

test("does not introduce a new Sparkle delta enclosure", async () => {
  const fixture = await createReleaseFixture({
    mutateAppcast: (value) => value.replace(
      'sparkle:version="1"',
      'sparkle:version="1" sparkle:deltaFrom="0"',
    ),
  });
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
        dmgPath: fixture.dmgPath,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: async () => assert.fail("unsupported delta must not call Wrangler"),
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_DELTA_UNSUPPORTED" },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("requires the supplied public key to match the release manifest fingerprint", async () => {
  const fixture = await createReleaseFixture();
  try {
    await assert.rejects(
      publishSparkleUpdate({
        appcastPath: fixture.appcastPath,
        bucket: APPROVED_R2_BUCKET,
        channel: "stable",
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
    "--channel", "stable",
    "--dmg", "release.dmg",
    "--appcast", "appcast.xml",
    "--release-manifest", "release.json",
    "--sparkle-public-ed-key", TEST_PUBLIC_ED_KEY,
  ]);
  assert.equal(parsed.sparklePublicEdKey, TEST_PUBLIC_ED_KEY);
  const guarded = parseSparkleUpdatePublisherArguments([
    "--atomic-appcast-guard-endpoint",
    `${STABLE_CHANNEL.serviceOrigin}${APPCAST_ATOMIC_GUARD_ROUTE}`,
    "--atomic-appcast-guard-token-env",
    APPCAST_ATOMIC_GUARD_TOKEN_ENV,
    "--bucket", APPROVED_R2_BUCKET,
    "--channel", "stable",
    "--dmg", "release.dmg",
    "--appcast", "appcast.xml",
    "--release-manifest", "release.json",
    "--sparkle-public-ed-key", TEST_PUBLIC_ED_KEY,
  ]);
  assert.equal(guarded.atomicAppcastGuardTokenEnv, APPCAST_ATOMIC_GUARD_TOKEN_ENV);
  assert.throws(
    () => parseSparkleUpdatePublisherArguments([
      "--bucket", APPROVED_R2_BUCKET,
      "--channel", "stable",
      "--dmg", "release.dmg",
      "--appcast", "appcast.xml",
      "--release-manifest", "release.json",
      "--sparkle-public-ed-key", TEST_PUBLIC_ED_KEY,
      "--atomic-appcast-guard-token", "literal-secret-must-not-be-accepted",
    ]),
    /Unknown or repeated argument/u,
  );
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
      "--channel", "stable",
      "--dmg", "release.dmg",
      "--appcast", "appcast.xml",
      "--release-manifest", "release.json",
      "--sparkle-public-ed-key", TEST_PUBLIC_ED_KEY,
      "--replace-appcast",
    ]),
    /requires --publish/u,
  );
  assert.throws(
    () => parseSparkleUpdatePublisherArguments([
      "--bucket", APPROVED_R2_BUCKET,
      "--dmg", "release.dmg",
      "--appcast", "appcast.xml",
      "--release-manifest", "release.json",
      "--sparkle-public-ed-key", TEST_PUBLIC_ED_KEY,
    ]),
    /--channel is required/u,
  );
  await assert.rejects(
    publishSparkleUpdate({
      appcastPath: "appcast.xml",
      bucket: "another-bucket",
      channel: "stable",
      dmgPath: "release.dmg",
      releaseManifestPath: "release.json",
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      runWrangler: async () => assert.fail("an unapproved bucket must not run Wrangler"),
      validateDMG: async () => assert.fail("an unapproved bucket must not validate inputs"),
    }),
    /approved bucket/u,
  );
});

test("validates a delta-carrying dogfood appcast and receipts the local signed delta", async () => {
  const fixture = await createDogfoodReleaseFixture();
  try {
    const publication = await publishSparkleUpdateRaw({
      appcastPath: fixture.appcastPath,
      bucket: fixture.bucket,
      channel: "internal-dogfood",
      dmgPath: fixture.dmgPath,
      releaseManifestPath: fixture.releaseManifestPath,
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      runWrangler: async () => assert.fail("dry run must not call Wrangler"),
      validateDMG: async () => {},
    });
    assert.equal(publication.published, false);
    assert.equal(publication.status, "validated");
    assert.equal(publication.deltas.length, 1);
    const [delta] = publication.deltas;
    assert.equal(delta.deltaFrom, "1");
    assert.equal(delta.contentType, "application/octet-stream");
    assert.equal(delta.cacheControl, IMMUTABLE_CACHE_CONTROL);
    assert.equal(delta.bytes, fixture.deltas[0].bytes.length);
    assert.equal(delta.sha256, fixture.deltas[0].sha256);
    assert.equal(
      delta.key,
      `${fixture.channel.sparkle.objectPrefix}/2/${fixture.deltas[0].sha256}/${fixture.deltas[0].fileName}`,
    );
    assert.equal(delta.path, fixture.deltas[0].path);
  } finally {
    await fixture.cleanup();
  }
});

test("publishes the delta as a fourth immutable object and read-backs delta and full fallback", async () => {
  const fixture = await createDogfoodReleaseFixture();
  const runner = missingRemoteObjectRunner();
  const publicReadback = dogfoodPublicReadbackFixture(fixture);
  try {
    const publication = await publishSparkleUpdateRaw({
      appcastPath: fixture.appcastPath,
      atomicAppcastGuard: runner.run.atomicAppcastGuard,
      bucket: fixture.bucket,
      channel: "internal-dogfood",
      dmgPath: fixture.dmgPath,
      publish: true,
      releaseManifestPath: fixture.releaseManifestPath,
      sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
      runWrangler: runner.run,
      fetchPublic: publicReadback.fetch,
      validateDMG: async () => {},
    });
    assert.equal(publication.published, true);
    assert.equal(publication.status, "published");
    assert.equal(publication.verified, true);
    assert.equal(publication.deltas.length, 1);
    const deltaKey = publication.deltas[0].key;
    const putCalls = runner.calls.filter((call) => call[2] === "put");
    assert.deepEqual(putCalls.map((call) => call[3]), [
      `${fixture.bucket}/${publication.artifact.key}`,
      `${fixture.bucket}/${publication.manifest.key}`,
      `${fixture.bucket}/${deltaKey}`,
      `${fixture.bucket}/${fixture.channel.sparkle.appcastObjectKey}`,
    ]);
    const deltaPut = putCalls[2];
    assert.equal(deltaPut.includes("application/octet-stream"), true);
    assert.equal(deltaPut.includes(IMMUTABLE_CACHE_CONTROL), true);
    assert.deepEqual(publicReadback.calls, [
      { method: "GET", url: fixture.channel.sparkle.appcastURL },
      { method: "HEAD", url: fixture.deltas[0].url },
      { method: "GET", url: fixture.artifactURL },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("fails closed before any remote call when an advertised delta is not beside the DMG", async () => {
  const fixture = await createDogfoodReleaseFixture({ writeDeltaFiles: false });
  try {
    await assert.rejects(
      publishSparkleUpdateRaw({
        appcastPath: fixture.appcastPath,
        bucket: fixture.bucket,
        channel: "internal-dogfood",
        dmgPath: fixture.dmgPath,
        publish: true,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: async () => assert.fail("missing delta must not call Wrangler"),
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_DELTA_ARTIFACT_MISSING" },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("fails closed when the local delta bytes do not match the content-addressed enclosure", async () => {
  const fixture = await createDogfoodReleaseFixture();
  await writeFile(fixture.deltas[0].path, Buffer.from("tampered-delta-bytes"));
  try {
    await assert.rejects(
      publishSparkleUpdateRaw({
        appcastPath: fixture.appcastPath,
        bucket: fixture.bucket,
        channel: "internal-dogfood",
        dmgPath: fixture.dmgPath,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: async () => assert.fail("tampered delta must not call Wrangler"),
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_DELTA_ARTIFACT_INVALID" },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("fails closed when the delta signature does not verify against the release public key", async () => {
  const fixture = await createDogfoodReleaseFixture({
    mutateAppcast: (value) => value.replace(
      /(<sparkle:deltas>[\s\S]*?)sparkle:edSignature="[^"]+"/u,
      `$1sparkle:edSignature="${sign(
        null,
        Buffer.from("some other artifact"),
        TEST_KEY_PAIR.privateKey,
      ).toString("base64")}"`,
    ),
  });
  try {
    await assert.rejects(
      publishSparkleUpdateRaw({
        appcastPath: fixture.appcastPath,
        bucket: fixture.bucket,
        channel: "internal-dogfood",
        dmgPath: fixture.dmgPath,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: async () => assert.fail("unsigned delta must not call Wrangler"),
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_SIGNATURE_INVALID" },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a delta enclosure outside the sparkle:deltas fallback container", async () => {
  const fixture = await createDogfoodReleaseFixture({
    mutateAppcast: (value) => value
      .replace("<sparkle:deltas>\n", "")
      .replace("\n</sparkle:deltas>", ""),
  });
  try {
    await assert.rejects(
      publishSparkleUpdateRaw({
        appcastPath: fixture.appcastPath,
        bucket: fixture.bucket,
        channel: "internal-dogfood",
        dmgPath: fixture.dmgPath,
        releaseManifestPath: fixture.releaseManifestPath,
        sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
        runWrangler: async () => assert.fail("misplaced delta must not call Wrangler"),
        validateDMG: async () => {},
      }),
      { code: "SPARKLE_UPDATE_APPCAST_DELTA_INVALID" },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("stable delta publication turns on with the reviewed policy flip and no publisher change", async () => {
  const deltaBytes = Buffer.from("stable-binary-delta-0-to-1");
  const deltaDigest = sha256(deltaBytes);
  const deltaFileName = `${RELEASE_MANIFEST.macOS.arm64DmgFileName.slice(0, -".dmg".length)}-from-0.delta`;
  const deltaURL = `${CANONICAL_UPDATE_ORIGIN}/releases/1/${deltaDigest}/${deltaFileName}`;
  const deltaSignature = sign(null, deltaBytes, TEST_KEY_PAIR.privateKey)
    .toString("base64");
  const deltasBlock = `<sparkle:deltas>\n<enclosure url="${deltaURL}" sparkle:version="1" sparkle:deltaFrom="0" length="${deltaBytes.length}" type="application/octet-stream" sparkle:edSignature="${deltaSignature}" />\n</sparkle:deltas>\n`;
  const fixture = await createReleaseFixture({
    mutateAppcast: (value) => value.replace("</item>", `${deltasBlock}</item>`),
  });
  await writeFile(
    join(dirname(fixture.dmgPath), deltaFileName),
    deltaBytes,
  );
  const options = {
    appcastPath: fixture.appcastPath,
    bucket: APPROVED_R2_BUCKET,
    channel: "stable",
    dmgPath: fixture.dmgPath,
    releaseManifestPath: fixture.releaseManifestPath,
    sparklePublicEdKey: TEST_PUBLIC_ED_KEY,
    runWrangler: async () => assert.fail("validation-only must not call Wrangler"),
    validateDMG: async () => {},
  };
  try {
    // Identical inputs: today's reviewed policy refuses the delta appcast...
    await assert.rejects(
      publishSparkleUpdate(options),
      { code: "SPARKLE_UPDATE_DELTA_UNSUPPORTED" },
    );
    // ...and the flipped policy accepts it with the delta fully validated,
    // so the config/guard change is the only remaining stable gate.
    const publication = await publishSparkleUpdate({
      ...options,
      appcastPolicy: {
        ...CANONICAL_STABLE_APPCAST_POLICY,
        allowDeltaFrom: true,
      },
    });
    assert.equal(publication.status, "validated");
    assert.equal(publication.deltas.length, 1);
    assert.equal(publication.deltas[0].deltaFrom, "0");
    assert.equal(
      publication.deltas[0].key,
      `releases/1/${deltaDigest}/${deltaFileName}`,
    );
  } finally {
    await fixture.cleanup();
  }
});


// ---------------------------------------------------------------------------
// Appcast generator gate. This lived in test/macos-updater.test.js, but that
// file ships in the reviewed client test set, and the generator statically
// imports the publisher, which is deliberately forbidden from the client
// artifact - so the spec's imports poisoned the client closure. It moves here,
// beside the publisher's own tests, which are already outside that closure.
// Moved 2026-08-07; behaviour unchanged.
import { spawnSync } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPARKLE_TOOLS_DIRECTORY_NAME,
} from "../scripts/macos-updater-core.js";
import {
  RETAINED_ARCHIVE_METADATA_FILE,
  RETAINED_ARCHIVE_SCHEMA,
} from "../scripts/generate-sparkle-appcast.js";
import { validateCandidateAppcastShape } from "../scripts/publish-sparkle-update.js";

const REPOSITORY_ROOT = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

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

