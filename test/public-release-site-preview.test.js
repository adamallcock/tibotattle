import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";

import {
  extractPublicReleaseMetadata,
  parsePublicReleaseSitePreviewArgs,
  startPublicReleaseSitePreview,
} from "../scripts/preview-public-release-site.js";

const SHA256 = "a".repeat(64);
const PUBLISHED_HOME = [
  "<!doctype html>",
  "<html><head>",
  '<meta name="usage-monitor-installer-url" content="https://downloads.tibotattle.com/TiboTattle-1.2.3-macOS-arm64.dmg">',
  '<meta name="usage-monitor-installer-version" content="1.2.3">',
  `<meta name="usage-monitor-installer-sha256" content="${SHA256}">`,
  '<meta name="usage-monitor-installer-bytes" content="48992442">',
  '<meta name="usage-monitor-minimum-macos" content="14.0">',
  '<meta name="usage-monitor-architectures" content="arm64">',
  '<meta name="usage-monitor-release-notes-url" content="https://tibotattle.com/docs.html">',
  '<meta name="usage-monitor-privacy-url" content="https://tibotattle.com/privacy.html">',
  '<meta name="usage-monitor-security-url" content="https://tibotattle.com/docs.html">',
  '<meta name="usage-monitor-support-url" content="https://tibotattle.com/docs.html">',
  "</head><body>Published homepage</body></html>",
].join("\n");

const DAILY_PAYLOAD = Object.freeze({
  allowanceState: "ready",
  days: [],
  from: "2026-08-01",
  schemaVersion: "community-daily-read-v1.0",
  to: "2026-08-17",
});

const INTEL_META = [
  '<meta name="usage-monitor-intel-installer-url" content="https://downloads.tibotattle.com/TiboTattle-1.2.3-macOS-x64.dmg">',
  '<meta name="usage-monitor-intel-installer-version" content="1.2.3">',
  `<meta name="usage-monitor-intel-installer-sha256" content="${"b".repeat(64)}">`,
  '<meta name="usage-monitor-intel-installer-bytes" content="50000000">',
  '<meta name="usage-monitor-intel-minimum-macos" content="14.0">',
  '<meta name="usage-monitor-intel-architectures" content="x64">',
].join("\n");
const DUAL_HOME = PUBLISHED_HOME.replace("</head>", `${INTEL_META}</head>`);

function publishedFetch(requests) {
  return async (input, options) => {
    const url = new URL(String(input));
    requests.push({ options, url });
    if (url.href === "https://tibotattle.com/") {
      return new Response(PUBLISHED_HOME, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/api/v1/community/daily") {
      return new Response(JSON.stringify(DAILY_PAYLOAD), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    throw new Error(`Unexpected preview fetch: ${url.href}`);
  };
}

test("preview arguments accept only reviewed public loopback-preview settings", () => {
  assert.deepEqual(
    parsePublicReleaseSitePreviewArgs([
      "--offline",
      "--port", "4175",
      "--upstream", "https://tibotattle.com",
    ]),
    {
      offline: true,
      port: 4175,
      upstream: "https://tibotattle.com/",
    },
  );
  assert.throws(
    () => parsePublicReleaseSitePreviewArgs(["--upstream", "http://localhost:8787"]),
    /public HTTPS/u,
  );
  assert.throws(
    () => parsePublicReleaseSitePreviewArgs(["--port", "65536"]),
    /0 to 65535/u,
  );
  assert.throws(
    () => parsePublicReleaseSitePreviewArgs(["--source", "anything"]),
    /Unknown argument/u,
  );
});

test("published release metadata stays display-safe and complete", () => {
  assert.deepEqual(extractPublicReleaseMetadata(PUBLISHED_HOME), {
    architectures: "arm64",
    installerBytes: "48992442",
    installerSha256: SHA256,
    installerUrl: "https://downloads.tibotattle.com/TiboTattle-1.2.3-macOS-arm64.dmg",
    installerVersion: "1.2.3",
    minimumMacos: "14.0",
    privacyUrl: "https://tibotattle.com/privacy.html",
    releaseNotesUrl: "https://tibotattle.com/docs.html",
    securityUrl: "https://tibotattle.com/docs.html",
    supportUrl: "https://tibotattle.com/docs.html",
  });
  assert.throws(
    () => extractPublicReleaseMetadata(
      PUBLISHED_HOME.replace("https://tibotattle.com/privacy.html", "http://localhost/privacy.html"),
    ),
    /Published privacy URL/u,
  );
  assert.throws(
    () => extractPublicReleaseMetadata(
      PUBLISHED_HOME.replace('content="1.2.3"', 'content="preview"'),
    ),
    /installer version/u,
  );
  assert.throws(
    () => extractPublicReleaseMetadata(
      PUBLISHED_HOME.replace(
        'name="usage-monitor-installer-url"',
        'data-usage-monitor-installer-url',
      ),
    ),
    /missing usage-monitor-installer-url/u,
  );
});

test("Intel preview metadata is optional but must be complete and match the ARM release", async (t) => {
  const metadata = extractPublicReleaseMetadata(DUAL_HOME);
  assert.equal(metadata.intelInstaller.architectures, "x64");
  assert.equal(metadata.intelInstaller.installerSha256, "b".repeat(64));
  assert.equal(metadata.intelInstaller.installerVersion, metadata.installerVersion);
  assert.equal(extractPublicReleaseMetadata(PUBLISHED_HOME).intelInstaller, undefined);
  for (const invalid of [
    DUAL_HOME.replace('name="usage-monitor-intel-installer-bytes"', 'name="missing-intel-bytes"'),
    DUAL_HOME.replace('name="usage-monitor-intel-installer-version" content="1.2.3"', 'name="usage-monitor-intel-installer-version" content="1.2.4"'),
    DUAL_HOME.replace('name="usage-monitor-intel-architectures" content="x64"', 'name="usage-monitor-intel-architectures" content="arm64"'),
    DUAL_HOME.replace("TiboTattle-1.2.3-macOS-x64.dmg", "TiboTattle-1.2.3-macOS-arm64.dmg"),
  ]) assert.throws(() => extractPublicReleaseMetadata(invalid));
  const preview = await startPublicReleaseSitePreview({
    fetchImpl: async () => new Response(DUAL_HOME, {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
    upstream: "https://tibotattle.com",
  });
  t.after(() => preview.close());
  const html = await (await fetch(preview.url)).text();
  assert.ok(html.includes('name="usage-monitor-intel-architectures" content="x64"'));
  assert.ok(html.includes(`name="usage-monitor-intel-installer-sha256" content="${"b".repeat(64)}"`));
});

test("live-data preview serves only generated public output and its one aggregate read", async (t) => {
  const requests = [];
  const preview = await startPublicReleaseSitePreview({
    fetchImpl: publishedFetch(requests),
    upstream: "https://tibotattle.com",
  });
  t.after(() => preview.close());

  assert.equal(preview.mode, "generated-source-with-live-public-data");
  const homepage = await fetch(preview.url);
  assert.equal(homepage.status, 200);
  assert.equal(
    homepage.headers.get("x-tibotattle-preview"),
    "generated-source-with-live-public-data",
  );
  assert.equal(homepage.headers.get("cache-control"), "no-store");
  const html = await homepage.text();
  assert.match(html, /What the Codex allowance is really worth\./u);
  assert.match(
    html,
    /name="usage-monitor-installer-version" content="1\.2\.3"/u,
  );
  assert.doesNotMatch(html, /app\.js/u);

  const daily = await fetch(
    new URL(
      "/api/v1/community/daily?from=2026-08-01&to=2026-08-17",
      preview.url,
    ),
  );
  assert.equal(daily.status, 200);
  assert.deepEqual(await daily.json(), DAILY_PAYLOAD);
  const dailyRequest = requests.at(-1);
  assert.equal(
    dailyRequest.url.href,
    "https://tibotattle.com/api/v1/community/daily?from=2026-08-01&to=2026-08-17",
  );
  assert.equal(dailyRequest.options.method, "GET");
  assert.equal(dailyRequest.options.redirect, "error");
  assert.equal(dailyRequest.options.headers.Accept, "application/json");
  assert.equal(Object.hasOwn(dailyRequest.options.headers, "Cookie"), false);
  assert.equal(Object.hasOwn(dailyRequest.options.headers, "Authorization"), false);

  const rejectedQuery = await fetch(
    new URL(
      "/api/v1/community/daily?from=2026-08-01&to=2026-08-17&extra=1",
      preview.url,
    ),
  );
  assert.equal(rejectedQuery.status, 400);
  const localOnly = await fetch(new URL("/api/local/health", preview.url));
  assert.equal(localOnly.status, 404);
  const manifest = await fetch(new URL("/release-site-manifest.json", preview.url));
  assert.equal(manifest.status, 404);
  const post = await fetch(preview.url, { method: "POST" });
  assert.equal(post.status, 405);

  await preview.close();
  await assert.rejects(access(preview.root));
});

test("offline preview neither reads public metadata nor proxies public data", async (t) => {
  let calls = 0;
  const preview = await startPublicReleaseSitePreview({
    fetchImpl: async () => {
      calls += 1;
      throw new Error("offline preview must not fetch");
    },
    offline: true,
  });
  t.after(() => preview.close());

  assert.equal(preview.mode, "generated-source-offline");
  assert.equal(calls, 0);
  const homepage = await fetch(preview.url);
  assert.equal(homepage.status, 200);
  assert.doesNotMatch(
    await homepage.text(),
    /usage-monitor-installer-url/u,
  );
  const daily = await fetch(
    new URL(
      "/api/v1/community/daily?from=2026-08-01&to=2026-08-17",
      preview.url,
    ),
  );
  assert.equal(daily.status, 503);
  assert.deepEqual(await daily.json(), { error: { code: "PREVIEW_OFFLINE" } });
  assert.equal(calls, 0);
});
