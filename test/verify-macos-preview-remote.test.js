import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createMacOSPreviewRemoteReceipt,
  MACOS_PREVIEW_REMOTE_RECEIPT_SCHEMA,
  parseMacOSPreviewRemoteArguments,
  runMacOSPreviewRemoteCLI,
  verifyMacOSPreviewRemote,
  writeMacOSPreviewRemoteReceipt,
} from "../scripts/verify-macos-preview-remote.js";

const APP_PATH = "/tmp/TiboTattle.app";
const BUNDLE_VERSION = "42";
const CENTRAL_ORIGIN = "https://central.example.test";
const APPCAST_URL = "https://updates.example.test/appcast.xml";
const ARTIFACT_BYTES = Buffer.from("mocked-signed-dmg-bytes", "utf8");
const ARTIFACT_SHA256 = createHash("sha256")
  .update(ARTIFACT_BYTES)
  .digest("hex");
const ARTIFACT_URL =
  `https://updates.example.test/releases/${BUNDLE_VERSION}/${ARTIFACT_SHA256}/TiboTattle.dmg`;
const STABLE_CENTRAL_ORIGIN = "https://stable-central.example.test";
const STABLE_APPCAST_URL = "https://stable-updates.example.test/appcast.xml";
const STABLE_ARTIFACT_URL =
  `https://stable-updates.example.test/releases/${BUNDLE_VERSION}/${ARTIFACT_SHA256}/TiboTattle.dmg`;
const PUBLIC_ED_KEY = Buffer.alloc(32, 4).toString("base64");
const PUBLIC_ED_KEY_SHA256 = createHash("sha256")
  .update(Buffer.alloc(32, 4))
  .digest("hex");
const SPARKLE_SIGNATURE = Buffer.alloc(64, 7).toString("base64");
const STABLE_PUBLIC_ED_KEY = Buffer.alloc(32, 8).toString("base64");
const STABLE_PUBLIC_ED_KEY_SHA256 = createHash("sha256")
  .update(Buffer.alloc(32, 8))
  .digest("hex");
const VALID_APPCAST = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <item>
      <enclosure url="${ARTIFACT_URL}" length="${ARTIFACT_BYTES.length}"
        sparkle:version="${BUNDLE_VERSION}" sparkle:edSignature="${SPARKLE_SIGNATURE}" />
    </item>
  </channel>
</rss>`;
const STABLE_APPCAST = VALID_APPCAST.replace(ARTIFACT_URL, STABLE_ARTIFACT_URL);
const PLIST = Object.freeze({
  SUFeedURL: APPCAST_URL,
  SUPublicEDKey: PUBLIC_ED_KEY,
  UsageMonitorBuildChannel: "preview_distribution",
  UsageMonitorCentralOrigin: CENTRAL_ORIGIN,
  UsageMonitorCentralOriginMode: "production_https",
  UsageMonitorPreviewDistribution: true,
  UsageMonitorReleaseChannel: "preview_distribution",
  UsageMonitorUpdaterEnabled: true,
});
const MANIFEST = Object.freeze({
  release: {
    channel: "preview_distribution",
    channelName: "preview_distribution",
  },
});
const STABLE_PLIST = Object.freeze({
  SUFeedURL: STABLE_APPCAST_URL,
  SUPublicEDKey: STABLE_PUBLIC_ED_KEY,
  UsageMonitorBuildChannel: "production",
  UsageMonitorCentralOrigin: STABLE_CENTRAL_ORIGIN,
  UsageMonitorCentralOriginMode: "production_https",
  UsageMonitorPublicWebsiteOrigin: "https://stable-web.example.test",
  UsageMonitorReleaseChannel: "stable",
  UsageMonitorUpdaterEnabled: true,
});
const STABLE_MANIFEST = Object.freeze({
  release: {
    channel: "production",
    channelName: "stable",
  },
});
const STABLE_POLICY = Object.freeze({
  configured: true,
  name: "stable",
  publicWebsiteOrigin: "https://stable-web.example.test",
  serviceOrigin: STABLE_CENTRAL_ORIGIN,
  serviceOriginMode: "production_https",
  sparkle: Object.freeze({
    appcastURL: STABLE_APPCAST_URL,
    objectPrefix: "releases",
    publicEdKeySha256: STABLE_PUBLIC_ED_KEY_SHA256,
  }),
});
const ENDPOINT_CONFIG = Object.freeze({
  appcastURL: APPCAST_URL,
  artifactURL: ARTIFACT_URL,
  centralOrigin: CENTRAL_ORIGIN,
});

function clock() {
  return {
    now: () => 1_000,
    setTimeout: () => Symbol("timer"),
    clearTimeout: () => {},
  };
}

function response(status, body = "", url = "", contentType = "application/xml") {
  return {
    body: null,
    headers: {
      get: (name) => name === "content-type" ? contentType : null,
    },
    status,
    text: async () => body,
    url,
  };
}

function streamingBody(bytes) {
  let emitted = false;
  return {
    getReader: () => ({
      cancel: async () => {},
      read: async () => {
        if (emitted) return { done: true, value: undefined };
        emitted = true;
        return { done: false, value: Uint8Array.from(bytes) };
      },
      releaseLock: () => {},
    }),
  };
}

function artifactResponse(
  url = ARTIFACT_URL,
  bytes = ARTIFACT_BYTES,
  contentLength = bytes.length,
) {
  return {
    body: streamingBody(bytes),
    headers: {
      get: (name) => name === "content-length"
        ? (contentLength === null ? null : String(contentLength))
        : null,
    },
    arrayBuffer: async () => assert.fail("artifact fallback materialization must not be used"),
    status: 200,
    url,
  };
}

function injectedDependencies(overrides = {}) {
  return {
    readBuildManifest: async () => MANIFEST,
    readInfoPlist: async () => PLIST,
    validatePreviewApp: async () => ({
      bundleIdentifier: "com.usagemonitor.local",
      bundleVersion: BUNDLE_VERSION,
      channel: "preview_distribution",
      updaterEnabled: true,
    }),
    ...overrides,
  };
}

function strictOptions(overrides = {}) {
  return {
    appPath: APP_PATH,
    channel: "preview_distribution",
    clock: clock(),
    endpointConfig: ENDPOINT_CONFIG,
    live: true,
    remoteFeedPreflight: true,
    ...injectedDependencies(),
    ...overrides,
  };
}

function healthyOrFeedResponse(url, appcastBody = VALID_APPCAST) {
  if (url === `${CENTRAL_ORIGIN}/api/health`) {
    return response(200, '{"status":"ok"}', url, "application/json");
  }
  if (url === `${CENTRAL_ORIGIN}/api/ready`) {
    return response(200, '{"status":"ready"}', url, "application/json");
  }
  if (url === APPCAST_URL) return response(200, appcastBody, url);
  if (url === ARTIFACT_URL) return artifactResponse(url);
  assert.fail(`unexpected mocked URL: ${url}`);
}

test("explicit endpoint CLI configuration remains opt-in and network-free by default", () => {
  const options = parseMacOSPreviewRemoteArguments([
    "--app", APP_PATH,
    "--channel", "preview_distribution",
    "--central-origin", CENTRAL_ORIGIN,
    "--appcast-url", APPCAST_URL,
    "--artifact-url", ARTIFACT_URL,
    "--remote-feed-preflight",
    "--receipt", "/tmp/tibotattle-update-rehearsal.json",
  ]);
  assert.deepEqual(options.endpointConfig, {
    appcastURL: APPCAST_URL,
    artifactURL: ARTIFACT_URL,
    centralOrigin: CENTRAL_ORIGIN,
  });
  assert.equal(options.live, false);
  assert.equal(options.channel, "preview_distribution");
  assert.equal(options.remoteFeedPreflight, true);
  assert.equal(options.receiptPath, "/tmp/tibotattle-update-rehearsal.json");
  assert.throws(
    () => parseMacOSPreviewRemoteArguments([
      "--channel", "preview_distribution", "--production-claim",
    ]),
    { code: "MACOS_PREVIEW_REMOTE_ARGUMENTS_INVALID" },
  );
});

test("named stable verification uses policy endpoints and never claims native acceptance", async () => {
  const calls = [];
  let inspectedOptions;
  const result = await verifyMacOSPreviewRemote({
    appPath: APP_PATH,
    channel: "stable",
    clock: clock(),
    fetchImpl: async (url, options) => {
      calls.push({ options, url });
      if (url === `${STABLE_CENTRAL_ORIGIN}/api/health`) {
        return response(200, '{"status":"ok"}', url, "application/json");
      }
      if (url === `${STABLE_CENTRAL_ORIGIN}/api/ready`) {
        return response(200, '{"status":"ready"}', url, "application/json");
      }
      if (url === STABLE_APPCAST_URL) return response(200, STABLE_APPCAST, url);
      if (url === STABLE_ARTIFACT_URL) return artifactResponse(url);
      assert.fail(`unexpected policy URL: ${url}`);
    },
    getReleaseChannelImpl: (name) => {
      assert.equal(name, "stable");
      return STABLE_POLICY;
    },
    inspectMacOSAppImpl: async (path, options) => {
      assert.equal(path, APP_PATH);
      inspectedOptions = options;
      return {
        bundleIdentifier: "com.usagemonitor.local",
        bundleVersion: BUNDLE_VERSION,
      };
    },
    live: true,
    readBuildManifest: async () => STABLE_MANIFEST,
    readInfoPlist: async () => STABLE_PLIST,
    remoteFeedPreflight: true,
  });
  assert.deepEqual(inspectedOptions, {
    channel: "stable",
    requireExternalDistribution: true,
  });
  assert.equal(result.metadata.channel, "stable");
  assert.equal(result.metadata.centralOrigin, STABLE_CENTRAL_ORIGIN);
  assert.equal(result.metadata.appcastURL, STABLE_APPCAST_URL);
  assert.equal(result.appcast.valid, true);
  assert.equal(result.artifact.valid, true);
  assert.equal(result.remotePublicationReadback.passed, true);
  assert.equal(result.sparkleAcceptance.cryptographicSignatureVerified, false);
  assert.equal(result.sparkleAcceptance.nativeClientRehearsalVerified, false);
  assert.equal(result.claim.passed, false);
  assert.equal(result.overall, "remote_feed_preflight_passed");
  assert.deepEqual(calls.map(({ url }) => url), [
    `${STABLE_CENTRAL_ORIGIN}/api/health`,
    `${STABLE_CENTRAL_ORIGIN}/api/ready`,
    STABLE_APPCAST_URL,
    STABLE_ARTIFACT_URL,
  ]);
});

test("named release channels reject endpoint overrides before local or remote work", async () => {
  let inspected = false;
  let fetched = false;
  await assert.rejects(
    verifyMacOSPreviewRemote({
      appPath: APP_PATH,
      channel: "stable",
      endpointConfig: {
        appcastURL: APPCAST_URL,
        centralOrigin: CENTRAL_ORIGIN,
      },
      fetchImpl: async () => {
        fetched = true;
        throw new Error("network must not be called");
      },
      getReleaseChannelImpl: () => STABLE_POLICY,
      inspectMacOSAppImpl: async () => {
        inspected = true;
        return {};
      },
    }),
    {
      code: "MACOS_PREVIEW_REMOTE_CHANNEL_ENDPOINT_OVERRIDE_FORBIDDEN",
    },
  );
  assert.equal(inspected, false);
  assert.equal(fetched, false);
});

test("an injected unconfigured internal-dogfood policy fails before any remote request", async () => {
  let fetched = false;
  await assert.rejects(
    verifyMacOSPreviewRemote({
      appPath: APP_PATH,
      channel: "internal-dogfood",
      fetchImpl: async () => {
        fetched = true;
        throw new Error("network must not be called");
      },
      getReleaseChannelImpl: (name) => {
        assert.equal(name, "internal-dogfood");
        return {
          configured: false,
          name: "internal-dogfood",
        };
      },
    }),
    (error) => {
      assert.equal(error.code, "MACOS_PREVIEW_REMOTE_CHANNEL_NOT_CONFIGURED");
      assert.match(error.message, /config\/release-channels\.js/u);
      return true;
    },
  );
  assert.equal(fetched, false);
});

test("sealed channel fields are both required and must match the selected channel", async () => {
  const mismatchedManifest = {
    release: {
      channel: "preview_distribution",
      channelName: "stable",
    },
  };
  await assert.rejects(
    verifyMacOSPreviewRemote({
      ...strictOptions({
        fetchImpl: async () => assert.fail("network must not be called"),
        readBuildManifest: async () => mismatchedManifest,
      }),
    }),
    { code: "MACOS_PREVIEW_REMOTE_CHANNEL_METADATA_MISMATCH" },
  );
  await assert.rejects(
    verifyMacOSPreviewRemote({
      ...strictOptions({
        fetchImpl: async () => assert.fail("network must not be called"),
        readInfoPlist: async () => {
          const { UsageMonitorReleaseChannel: _ignored, ...withoutChannel } = PLIST;
          return withoutChannel;
        },
      }),
    }),
    { code: "MACOS_PREVIEW_REMOTE_CHANNEL_METADATA_MISMATCH" },
  );
});

test("no-network remote feed preflight is blocked and receipt contains no payload content", async () => {
  let fetchCalls = 0;
  const result = await verifyMacOSPreviewRemote({
    ...strictOptions({ live: false, fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("network must not be called");
    } }),
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.overall, "remote_feed_preflight_unchecked");
  assert.equal(result.claim.status, "blocked");
  assert.equal(result.claim.reason, "network_not_enabled");
  const receipt = createMacOSPreviewRemoteReceipt(result, {
    recordedOn: "2026-08-04",
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(receipt.schemaVersion, MACOS_PREVIEW_REMOTE_RECEIPT_SCHEMA);
  assert.equal(receipt.contentFree, true);
  assert.equal(receipt.payloadsRecorded, false);
  assert.equal(serialized.includes(VALID_APPCAST), false);
  assert.equal(serialized.includes(ARTIFACT_BYTES.toString("utf8")), false);
});

test("HTTP 404 appcast is not published and blocks the remote feed preflight", async () => {
  const calls = [];
  const result = await verifyMacOSPreviewRemote(strictOptions({
    fetchImpl: async (url, options) => {
      calls.push({ method: options.method, url });
      if (url === APPCAST_URL) return response(404, "not found", url);
      return healthyOrFeedResponse(url);
    },
  }));
  assert.equal(result.central.passed, true);
  assert.equal(result.appcast.status, "not_published");
  assert.equal(result.appcast.httpStatus, 404);
  assert.equal(result.artifact.checked, false);
  assert.equal(result.claim.passed, false);
  assert.equal(result.overall, "remote_feed_preflight_blocked");
  assert.deepEqual(calls.map(({ url }) => url), [
    `${CENTRAL_ORIGIN}/api/health`,
    `${CENTRAL_ORIGIN}/api/ready`,
    APPCAST_URL,
  ]);
});

test("malformed XML is invalid and never triggers an artifact read", async () => {
  const calls = [];
  const result = await verifyMacOSPreviewRemote(strictOptions({
    fetchImpl: async (url, options) => {
      calls.push({ method: options.method, url });
      if (url === APPCAST_URL) return response(200, "<rss><channel>", url);
      return healthyOrFeedResponse(url);
    },
  }));
  assert.equal(result.appcast.status, "invalid");
  assert.equal(result.appcast.reason, "invalid_xml_or_sparkle_structure");
  assert.equal(result.artifact.checked, false);
  assert.equal(calls.some(({ url }) => url === ARTIFACT_URL), false);
});

test("invalid enclosure metadata is rejected before any remote artifact bytes are read", async () => {
  const invalidAppcast = `<?xml version="1.0"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel><item><enclosure url="https://updates.example.test/releases/bad.dmg"
    length="not-a-number" sparkle:version="${BUNDLE_VERSION}"
    sparkle:edSignature="bad" /></item></channel>
</rss>`;
  const calls = [];
  const result = await verifyMacOSPreviewRemote(strictOptions({
    fetchImpl: async (url, options) => {
      calls.push({ method: options.method, url });
      if (url === APPCAST_URL) return response(200, invalidAppcast, url);
      return healthyOrFeedResponse(url);
    },
  }));
  assert.equal(result.appcast.status, "invalid");
  assert.equal(result.appcast.reason, "invalid_xml_or_sparkle_structure");
  assert.equal(result.artifact.checked, false);
  assert.equal(calls.some(({ url }) => url.endsWith("bad.dmg")), false);
});

test("mismatched explicit artifact URL is a blocking feed proof failure", async () => {
  const mismatchedURL =
    `https://updates.example.test/releases/${BUNDLE_VERSION}/${ARTIFACT_SHA256}/other.dmg`;
  const result = await verifyMacOSPreviewRemote(strictOptions({
    endpointConfig: {
      ...ENDPOINT_CONFIG,
      artifactURL: mismatchedURL,
    },
    fetchImpl: async (url) => healthyOrFeedResponse(url),
  }));
  assert.equal(result.appcast.status, "invalid");
  assert.equal(result.appcast.reason, "mismatched_url");
  assert.equal(result.artifact.checked, false);
  assert.equal(result.claim.passed, false);
});

test("artifact digest and length overrides cannot replace the selected feed enclosure", async () => {
  let artifactReads = 0;
  const result = await verifyMacOSPreviewRemote(strictOptions({
    endpointConfig: {
      ...ENDPOINT_CONFIG,
      artifactBytes: ARTIFACT_BYTES.length + 1,
      artifactSha256: "0".repeat(64),
    },
    fetchImpl: async (url) => {
      if (url === ARTIFACT_URL) artifactReads += 1;
      return healthyOrFeedResponse(url);
    },
  }));
  assert.equal(artifactReads, 0);
  assert.equal(result.artifact.checked, false);
  assert.equal(result.artifact.reason, "configured_artifact_digest_mismatch");
  assert.equal(result.remotePublicationReadback.passed, false);
  assert.equal(result.claim.passed, false);
});

test("the update gate rejects deltas and ambiguous full-DMG candidates", async () => {
  const deltaURL =
    `https://updates.example.test/releases/${BUNDLE_VERSION}/${ARTIFACT_SHA256}/TiboTattle.delta`;
  const ambiguousAppcast = VALID_APPCAST.replace(
    "    </item>",
    `      <enclosure url="${deltaURL}" length="${ARTIFACT_BYTES.length}"
        sparkle:version="${BUNDLE_VERSION}" sparkle:edSignature="${SPARKLE_SIGNATURE}" />
    </item>`,
  );
  let artifactReads = 0;
  const result = await verifyMacOSPreviewRemote(strictOptions({
    fetchImpl: async (url) => {
      if (url === ARTIFACT_URL || url === deltaURL) artifactReads += 1;
      return healthyOrFeedResponse(url, ambiguousAppcast);
    },
  }));
  assert.equal(artifactReads, 0);
  assert.equal(result.appcast.valid, false);
  assert.equal(result.appcast.reason, "single_full_dmg_required");
  assert.equal(result.artifact.checked, false);
  assert.equal(result.claim.passed, false);
});

test("artifact Content-Length must match the appcast before the stream is read", async () => {
  let streamed = false;
  const result = await verifyMacOSPreviewRemote(strictOptions({
    fetchImpl: async (url) => {
      if (url !== ARTIFACT_URL) return healthyOrFeedResponse(url);
      return {
        ...artifactResponse(url, ARTIFACT_BYTES, ARTIFACT_BYTES.length + 1),
        body: {
          getReader: () => ({
            cancel: async () => {},
            read: async () => {
              streamed = true;
              return { done: true, value: undefined };
            },
            releaseLock: () => {},
          }),
        },
      };
    },
  }));
  assert.equal(streamed, false);
  assert.equal(result.artifact.status, "unavailable");
  assert.equal(result.artifact.reason, "content_length_mismatch");
  assert.equal(result.claim.passed, false);
});

test("artifact readback fails closed when Content-Length is absent", async () => {
  let streamed = false;
  const result = await verifyMacOSPreviewRemote(strictOptions({
    fetchImpl: async (url) => {
      if (url !== ARTIFACT_URL) return healthyOrFeedResponse(url);
      return {
        ...artifactResponse(url, ARTIFACT_BYTES, null),
        body: {
          getReader: () => {
            streamed = true;
            return streamingBody(ARTIFACT_BYTES).getReader();
          },
        },
      };
    },
  }));
  assert.equal(streamed, false);
  assert.equal(result.artifact.status, "unavailable");
  assert.equal(result.artifact.reason, "content_length_missing");
  assert.equal(result.claim.passed, false);
});

test("structurally valid arbitrary signature bytes only pass remote readback, never update acceptance", async () => {
  const calls = [];
  const result = await verifyMacOSPreviewRemote(strictOptions({
    fetchImpl: async (url, options) => {
      calls.push({ method: options.method, url });
      return healthyOrFeedResponse(url);
    },
  }));
  assert.equal(result.appcast.status, "valid");
  assert.equal(result.appcast.enclosureCount, 1);
  assert.equal(result.artifact.status, "valid");
  assert.equal(result.artifact.bytes, ARTIFACT_BYTES.length);
  assert.equal(result.artifact.sha256, ARTIFACT_SHA256);
  assert.equal(result.remotePublicationReadback.passed, true);
  assert.equal(result.remotePublicationReadback.reason, "remote_publication_readback_verified");
  assert.equal(result.sparkleAcceptance.cryptographicSignatureVerified, false);
  assert.equal(result.sparkleAcceptance.nativeClientRehearsalVerified, false);
  assert.equal(result.sparkleAcceptance.status, "not_verified");
  assert.equal(result.claim.passed, false);
  assert.equal(result.claim.reason, "installed_client_rehearsal_required");
  assert.equal(result.overall, "remote_feed_preflight_passed");
  assert.deepEqual(calls.map(({ url }) => url), [
    `${CENTRAL_ORIGIN}/api/health`,
    `${CENTRAL_ORIGIN}/api/ready`,
    APPCAST_URL,
    ARTIFACT_URL,
  ]);
  const receipt = createMacOSPreviewRemoteReceipt(result, {
    recordedOn: "2026-08-04",
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(receipt.claim.status, "blocked");
  assert.equal(receipt.remotePublicationReadback.status, "passed");
  assert.equal(receipt.cryptographicSignatureVerified, false);
  assert.equal(receipt.binding.channel, "preview_distribution");
  assert.equal(receipt.binding.appcastURL, APPCAST_URL);
  assert.equal(receipt.binding.artifactURL, ARTIFACT_URL);
  assert.equal(receipt.binding.artifactSha256, ARTIFACT_SHA256);
  assert.equal(receipt.binding.artifactBytes, ARTIFACT_BYTES.length);
  assert.equal(receipt.binding.bundleVersion, BUNDLE_VERSION);
  assert.equal(receipt.binding.publicEdKeySha256, PUBLIC_ED_KEY_SHA256);
  assert.equal(receipt.contentFree, true);
  assert.equal(serialized.includes(VALID_APPCAST), false);
  assert.equal(serialized.includes(SPARKLE_SIGNATURE), false);
  assert.equal(serialized.includes(ARTIFACT_BYTES.toString("utf8")), false);
  assert.throws(
    () => createMacOSPreviewRemoteReceipt({ ...result, claim: { passed: true } }),
    { code: "MACOS_PREVIEW_REMOTE_RECEIPT_INVALID" },
  );

  const output = [];
  const cli = await runMacOSPreviewRemoteCLI(
    ["--app", APP_PATH, "--channel", "preview_distribution", "--live", "--remote-feed-preflight"],
    {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(`stderr:${line}`),
      verifyRemote: async () => result,
    },
  );
  assert.equal(cli.exitCode, 1);
  assert.equal(output.includes("Remote feed preflight: passed"), true);
  assert.equal(output.some((line) => line.includes("Sparkle update acceptance: not verified")), true);
  assert.equal(output.some((line) => line.includes("Update acceptance gate: blocked")), true);
});

test("receipt writer is content-free and refuses to overwrite an attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-update-receipt-test-"));
  const receiptPath = join(root, "attempt.json");
  try {
    const result = await verifyMacOSPreviewRemote(strictOptions({
      fetchImpl: async (url) => healthyOrFeedResponse(url),
    }));
    const written = await writeMacOSPreviewRemoteReceipt(receiptPath, result);
    const contents = await readFile(receiptPath, "utf8");
    assert.equal(JSON.parse(contents).schemaVersion, written.schemaVersion);
    assert.equal(JSON.parse(contents).contentFree, true);
    await assert.rejects(
      writeMacOSPreviewRemoteReceipt(receiptPath, result),
      { code: "MACOS_PREVIEW_REMOTE_RECEIPT_EXISTS" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
