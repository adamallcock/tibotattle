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
const PUBLIC_ED_KEY = Buffer.alloc(32, 4).toString("base64");
const SPARKLE_SIGNATURE = Buffer.alloc(64, 7).toString("base64");
const VALID_APPCAST = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <item>
      <enclosure url="${ARTIFACT_URL}" length="${ARTIFACT_BYTES.length}"
        sparkle:version="${BUNDLE_VERSION}" sparkle:edSignature="${SPARKLE_SIGNATURE}" />
    </item>
  </channel>
</rss>`;
const PLIST = Object.freeze({
  SUFeedURL: APPCAST_URL,
  SUPublicEDKey: PUBLIC_ED_KEY,
  UsageMonitorBuildChannel: "preview_distribution",
  UsageMonitorCentralOrigin: CENTRAL_ORIGIN,
  UsageMonitorCentralOriginMode: "production_https",
  UsageMonitorPreviewDistribution: true,
  UsageMonitorUpdaterEnabled: true,
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

function artifactResponse(url = ARTIFACT_URL, bytes = ARTIFACT_BYTES) {
  return {
    body: null,
    headers: {
      get: (name) => name === "content-length" ? String(bytes.length) : null,
    },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    status: 200,
    url,
  };
}

function injectedDependencies(overrides = {}) {
  return {
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
    clock: clock(),
    endpointConfig: ENDPOINT_CONFIG,
    live: true,
    productionClaim: true,
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
    "--central-origin", CENTRAL_ORIGIN,
    "--appcast-url", APPCAST_URL,
    "--artifact-url", ARTIFACT_URL,
    "--production-claim",
    "--receipt", "/tmp/tibotattle-update-rehearsal.json",
  ]);
  assert.deepEqual(options.endpointConfig, {
    appcastURL: APPCAST_URL,
    artifactURL: ARTIFACT_URL,
    centralOrigin: CENTRAL_ORIGIN,
  });
  assert.equal(options.live, false);
  assert.equal(options.productionClaim, true);
  assert.equal(options.receiptPath, "/tmp/tibotattle-update-rehearsal.json");
});

test("no-network production claim is blocked and receipt contains no payload content", async () => {
  let fetchCalls = 0;
  const result = await verifyMacOSPreviewRemote({
    ...strictOptions({ live: false, fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("network must not be called");
    } }),
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.overall, "not_ready");
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

test("HTTP 404 appcast is not published and blocks the production claim", async () => {
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
  assert.equal(result.overall, "not_ready");
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

test("valid mocked feed and content-addressed artifact produce a passing claim", async () => {
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
  assert.equal(result.claim.passed, true);
  assert.equal(result.claim.reason, "feed_and_artifact_verified");
  assert.equal(result.overall, "ready");
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
  assert.equal(receipt.claim.status, "passed");
  assert.equal(receipt.contentFree, true);
  assert.equal(serialized.includes(VALID_APPCAST), false);
  assert.equal(serialized.includes(SPARKLE_SIGNATURE), false);
  assert.equal(serialized.includes(ARTIFACT_BYTES.toString("utf8")), false);
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
