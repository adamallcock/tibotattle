import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RELEASE_MANIFEST,
  RELEASE_VERSION,
} from "../config/release-manifest.js";
import { createMacOSSignedReplacementContract } from "../scripts/macos-release-core.js";
import { SPARKLE_VERSION } from "../scripts/macos-updater-core.js";
import { getReleaseChannel } from "../config/release-channels.js";
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
  artifactBody = fixture.dmgBytes,
  preservedArtifacts = new Map(),
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
            "Content-Length": String(Buffer.byteLength(appcastBody)),
            "Content-Type": "application/xml; charset=utf-8",
          },
          status: 200,
        });
      }
      if (url === fixture.artifactURL) {
        return new Response(artifactBody, {
          headers: {
            "Cache-Control": IMMUTABLE_CACHE_CONTROL,
            "Content-Length": String(artifactBody.length),
            "Content-Type": "application/x-apple-diskimage",
          },
          status: 200,
        });
      }
      if (preservedArtifacts.has(url)) {
        const body = preservedArtifacts.get(url);
        return new Response(options.method === "HEAD" ? null : body, {
          headers: {
            "Cache-Control": IMMUTABLE_CACHE_CONTROL,
            "Content-Length": String(body.length),
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

test("validates an explicitly supplied canonical signed update without invoking Wrangler by default", async () => {
  const fixture = await createReleaseFixture();
  const verified = [];
  try {
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
      validateDMG: async () => {},
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
    previousStableManifestPath: fixture.releaseManifestPath,
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

test("does not report publication success when a retained enclosure is missing from the public origin", async () => {
  const staleBytes = Buffer.from("previous-signed-release");
  const staleDigest = sha256(staleBytes);
  const staleFileName = "TiboTattle-0.1.0-macOS-arm64.dmg";
  const staleKey = `releases/0/${staleDigest}/${staleFileName}`;
  const staleURL = `${CANONICAL_UPDATE_ORIGIN}/${staleKey}`;
  const fixture = await createReleaseFixture({
    mutateAppcast: (value) => value.replace(
      "</channel>",
      `${appcastEnclosure({
        bytes: staleBytes,
        url: staleURL,
        version: "0",
      })}</channel>`,
    ),
  });
  const runner = remoteObjectRunner(new Map([
    [`${APPROVED_R2_BUCKET}/${staleKey}`, staleBytes],
  ]));
  const publicReadback = publicReadbackFixture(fixture);
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
      { code: "SPARKLE_UPDATE_PUBLIC_READBACK_FAILED" },
    );
    assert.deepEqual(publicReadback.calls, [
      { method: "GET", url: CANONICAL_APPCAST_URL },
      { method: "HEAD", url: staleURL },
    ]);
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
        previousStableManifestPath: fixture.releaseManifestPath,
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
        channel: "stable",
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
  const publicReadback = publicReadbackFixture(fixture, {
    preservedArtifacts: new Map([[deltaURL, deltaBytes]]),
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
        channel: "stable",
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
        channel: "stable",
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

test("rejects a changed equal-version live appcast before any remote mutation", async () => {
  const candidate = await createReleaseFixture({ bundleVersion: "2" });
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
        previousStableManifestPath: candidate.releaseManifestPath,
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
    await candidate.cleanup();
  }
});

test("rejects an ambiguous equal-version live appcast before any remote mutation", async () => {
  const candidate = await createReleaseFixture();
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
        previousStableManifestPath: candidate.releaseManifestPath,
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
    await candidate.cleanup();
  }
});

test("verifies an exact appcast retry without overwriting or reporting a new publish", async () => {
  const fixture = await createReleaseFixture();
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
      previousStableManifestPath: fixture.releaseManifestPath,
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
