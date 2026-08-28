import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MACOS_PREVIEW_REMOTE_HEALTH_PATHS,
  parseMacOSPreviewRemoteArguments,
  runMacOSPreviewRemoteCLI,
  validateSparkleAppcastXML,
  verifyMacOSPreviewRemote,
} from "../scripts/verify-macos-preview-remote.js";

const APP_PATH = "/tmp/TiboTattle Preview.app";
const CENTRAL_ORIGIN = "https://central.example.test";
const APPCAST_URL = "https://updates.example.test/appcast.xml";
const PUBLIC_ED_KEY = Buffer.alloc(32, 4).toString("base64");
const SPARKLE_SIGNATURE = Buffer.alloc(64, 7).toString("base64");
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

test("the preview remote package command selects the sealed preview channel", async () => {
  const packageManifest = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  assert.match(
    packageManifest.scripts["product:macos:preview:remote"],
    /--channel preview_distribution/u,
  );
});

const VALID_APPCAST = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <item>
      <enclosure url="https://updates.example.test/releases/1/TiboTattle.dmg"
        length="123" sparkle:version="1" sparkle:edSignature="${SPARKLE_SIGNATURE}" />
    </item>
  </channel>
</rss>`;

function clock() {
  return {
    now: () => 1_000,
    setTimeout: () => Symbol("timer"),
    clearTimeout: () => {},
  };
}

function response(status, body = "", url = "") {
  return {
    body: null,
    headers: {
      get: (name) => name === "content-type" ? "application/xml" : null,
    },
    status,
    text: async () => body,
    url,
  };
}

function injectedDependencies(overrides = {}) {
  return {
    readBuildManifest: async () => MANIFEST,
    readInfoPlist: async () => PLIST,
    validatePreviewApp: async () => ({
      bundleIdentifier: "com.usagemonitor.local.preview",
      bundleVersion: "42",
      channel: "preview_distribution",
      updaterEnabled: true,
    }),
    ...overrides,
  };
}

test("CLI parsing is offline by default and bounds the opt-in timeout", () => {
  assert.throws(
    () => parseMacOSPreviewRemoteArguments([], {}),
    { code: "MACOS_PREVIEW_REMOTE_CHANNEL_INVALID" },
  );
  const defaulted = parseMacOSPreviewRemoteArguments(
    ["--channel", "preview_distribution"],
    {},
  );
  assert.match(
    defaulted.appPath,
    /\.release-build\/macos-preview\/current\/TiboTattle Preview\.app$/u,
  );
  assert.equal(defaulted.live, false);
  assert.deepEqual(
    parseMacOSPreviewRemoteArguments([
      "--app", APP_PATH,
      "--channel", "preview_distribution",
    ]),
    {
      appPath: APP_PATH,
      channel: "preview_distribution",
      help: false,
      live: false,
      timeoutMs: 5_000,
    },
  );
  assert.equal(
    parseMacOSPreviewRemoteArguments([
      "--app",
      APP_PATH,
      "--channel",
      "preview_distribution",
      "--live",
      "--timeout-ms",
      "2500",
    ]).live,
    true,
  );
  assert.throws(
    () => parseMacOSPreviewRemoteArguments([
      "--app",
      APP_PATH,
      "--channel",
      "preview_distribution",
      "--timeout-ms",
      "30001",
    ]),
    { code: "MACOS_PREVIEW_REMOTE_ARGUMENTS_INVALID" },
  );
});

test("offline verification validates locally and never calls fetch", async () => {
  let validatorCalls = 0;
  let fetchCalls = 0;
  const result = await verifyMacOSPreviewRemote({
    appPath: APP_PATH,
    channel: "preview_distribution",
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("network must not be called");
    },
    ...injectedDependencies({
      validatePreviewApp: async (path) => {
        validatorCalls += 1;
        assert.equal(path, APP_PATH);
        return {
          bundleIdentifier: "com.usagemonitor.local.preview",
          bundleVersion: "42",
          channel: "preview_distribution",
          updaterEnabled: true,
        };
      },
    }),
  });
  assert.equal(validatorCalls, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(result.live, false);
  assert.equal(result.overall, "local_valid_remote_unchecked");
  assert.equal(result.metadata.centralOrigin, CENTRAL_ORIGIN);
  assert.equal(result.metadata.appcastURL, APPCAST_URL);
  assert.equal(result.central.checked, false);
  assert.equal(result.appcast.checked, false);
});

test("live verification checks health and reports an unpublished appcast as blocked preflight", async () => {
  const calls = [];
  const result = await verifyMacOSPreviewRemote({
    appPath: APP_PATH,
    channel: "preview_distribution",
    clock: clock(),
    fetchImpl: async (url, options) => {
      calls.push({ options, url });
      if (url === `${CENTRAL_ORIGIN}/api/health`) {
        return response(200, JSON.stringify({ status: "ok" }), url);
      }
      if (url === `${CENTRAL_ORIGIN}/api/ready`) {
        return response(200, JSON.stringify({ status: "ready" }), url);
      }
      assert.equal(url, APPCAST_URL);
      return response(404, "not found", url);
    },
    live: true,
    ...injectedDependencies(),
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    `${CENTRAL_ORIGIN}/api/health`,
    `${CENTRAL_ORIGIN}/api/ready`,
    APPCAST_URL,
  ]);
  assert.deepEqual(calls.map(({ options }) => options.method), ["GET", "GET", "GET"]);
  assert.deepEqual(calls.map(({ options }) => options.redirect), ["manual", "manual", "manual"]);
  assert.deepEqual(calls.map(({ options }) => options.credentials), ["omit", "omit", "omit"]);
  assert.equal(Object.hasOwn(calls[2].options.headers, "authorization"), false);
  assert.equal(result.central.passed, true);
  assert.equal(result.appcast.status, "not_published");
  assert.equal(result.appcast.reason, "not_published");
  assert.equal(result.appcast.httpStatus, 404);
  assert.equal(result.overall, "remote_feed_preflight_blocked");
  assert.equal(result.remotePublicationReadback.status, "blocked");
  assert.equal(result.remotePublicationReadback.reason, "appcast_not_published");
  assert.equal(result.claim.requested, false);
  assert.equal(result.sparkleAcceptance.status, "not_verified");
  assert.equal(JSON.stringify(result).includes(PUBLIC_ED_KEY), false);
});

test("valid Sparkle RSS/XML is distinguished from malformed or empty appcast content", async () => {
  assert.equal(validateSparkleAppcastXML(VALID_APPCAST).valid, true);
  assert.equal(
    validateSparkleAppcastXML("<rss><channel><item /></channel></rss>").valid,
    false,
  );
  assert.equal(validateSparkleAppcastXML("not XML").valid, false);

  const result = await verifyMacOSPreviewRemote({
    appPath: APP_PATH,
    channel: "preview_distribution",
    clock: clock(),
    fetchImpl: async (url) => {
      if (url.endsWith("/api/health")) return response(200, '{"status":"ok"}', url);
      if (url.endsWith("/api/ready")) return response(200, '{"status":"ready"}', url);
      return response(200, VALID_APPCAST, url);
    },
    live: true,
    ...injectedDependencies(),
  });
  assert.equal(result.appcast.status, "valid");
  assert.equal(result.appcast.valid, true);
  assert.equal(result.appcast.itemCount, 1);
  assert.equal(result.appcast.enclosureCount, 1);
  assert.equal(result.overall, "remote_feed_preflight_passed");
  assert.equal(result.remotePublicationReadback.passed, true);
  assert.equal(result.claim.requested, false);
  assert.equal(result.sparkleAcceptance.status, "not_verified");
});

test("legacy zero-first appcasts require an exact migration-source opt-in", () => {
  const legacyVersion = "0.1.16";
  const legacyArtifactURL =
    `https://updates.example.test/releases/${legacyVersion}/`
    + `${"a".repeat(64)}/TiboTattle.dmg`;
  const appcast = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel><item><enclosure url="${legacyArtifactURL}" length="123"
    sparkle:version="${legacyVersion}" sparkle:edSignature="${SPARKLE_SIGNATURE}" />
  </item></channel>
</rss>`;
  const options = {
    expectedArtifactOrigin: "https://updates.example.test",
    expectedArtifactPrefix: "releases",
    expectedBundleVersion: legacyVersion,
    requireContentAddressed: true,
    requireSingleFullDmg: true,
  };
  assert.equal(validateSparkleAppcastXML(appcast, options).valid, false);
  assert.equal(validateSparkleAppcastXML(appcast, {
    ...options,
    allowLegacyZeroFirstBundleVersion: true,
  }).valid, true);
  assert.equal(validateSparkleAppcastXML(appcast, {
    ...options,
    allowLegacyZeroFirstBundleVersion: true,
    expectedBundleVersion: "0.1.15",
  }).valid, false);
});

test("a bounded timeout blocks remote feed preflight without leaking response content", async () => {
  const timeoutClock = {
    now: () => 2_000,
    setTimeout: (callback) => {
      callback();
      return Symbol("timer");
    },
    clearTimeout: () => {},
  };
  const result = await verifyMacOSPreviewRemote({
    appPath: APP_PATH,
    channel: "preview_distribution",
    clock: timeoutClock,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
    live: true,
    ...injectedDependencies(),
  });
  assert.deepEqual(
    result.central.endpoints.map(({ outcome }) => outcome),
    ["timeout", "timeout"],
  );
  assert.equal(result.appcast.status, "unavailable");
  assert.equal(result.appcast.reason, "timeout");
  assert.equal(result.overall, "remote_feed_preflight_blocked");
  assert.equal(result.remotePublicationReadback.status, "blocked");
  assert.equal(result.claim.requested, false);
  assert.equal(result.sparkleAcceptance.status, "not_verified");
});

test("CLI reports blocked remote preflight without claiming release acceptance or printing the signing key", async () => {
  const output = [];
  const result = await runMacOSPreviewRemoteCLI(
    ["--app", APP_PATH, "--channel", "preview_distribution", "--live"],
    {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(`stderr:${line}`),
      verifyRemote: async (options) => verifyMacOSPreviewRemote({
        ...options,
        clock: clock(),
        fetchImpl: async (url) => url.endsWith("appcast.xml")
          ? response(404, "", url)
          : response(
            200,
            url.endsWith("/ready")
              ? '{"status":"ready"}'
              : '{"status":"ok"}',
            url,
          ),
        ...injectedDependencies(),
      }),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(output.some((line) => line.includes("not_published")), false);
  assert.equal(output.some((line) => line.includes("no signed release appcast")), true);
  assert.equal(output.some((line) => line.includes(PUBLIC_ED_KEY)), false);
  assert.equal(output.some((line) => line.includes("Remote feed preflight: blocked")), true);
  assert.equal(output.some((line) => line.includes("Sparkle update acceptance: not verified")), true);
  assert.equal(output.some((line) => line.includes("Update acceptance gate: passed")), false);
});

assert.deepEqual(MACOS_PREVIEW_REMOTE_HEALTH_PATHS, ["/api/health", "/api/ready"]);
