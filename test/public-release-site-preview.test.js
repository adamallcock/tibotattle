import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";

import {
  extractPublicReleaseMetadata,
  parsePublicReleaseSitePreviewArgs,
  safeModelPerformanceQuery,
  startPublicReleaseSitePreview,
  syntheticCommunityModelPerformance,
  SYNTHETIC_MODEL_PERFORMANCE_FIXTURE_HEADER,
  SYNTHETIC_MODEL_PERFORMANCE_FIXTURE_LABEL,
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

const MODEL_PERFORMANCE_PATH = "/api/v1/community/model-performance";
const PERIODS = ["1", "7", "30", "all"];
const SPEED_MODES = ["standard", "fast", "ultrafast"];
// A minimal published slot as the upstream would return it; the preview passes
// the bytes through and never interprets them.
const PERFORMANCE_PAYLOAD = Object.freeze({
  schemaVersion: "community-model-performance-v1",
  period: "7",
  speedMode: "fast",
  models: [],
});
const UNPUBLISHED_PAYLOAD = Object.freeze({
  error: { code: "COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED" },
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
    if (url.pathname === MODEL_PERFORMANCE_PATH) {
      const speedMode = url.searchParams.get("speedMode");
      if (speedMode === "ultrafast") {
        return new Response(JSON.stringify(UNPUBLISHED_PAYLOAD), {
          headers: { "content-type": "application/json; charset=utf-8" },
          status: 404,
        });
      }
      if (speedMode === "standard" && url.searchParams.get("period") === "1") {
        return new Response("<html>not json</html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (speedMode === "standard" && url.searchParams.get("period") === "30") {
        return new Response(JSON.stringify({ error: { code: "BACKEND_STORAGE_UNAVAILABLE" } }), {
          headers: { "content-type": "application/json; charset=utf-8" },
          status: 503,
        });
      }
      return new Response(JSON.stringify(PERFORMANCE_PAYLOAD), {
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

function previewUrl(base, search) {
  return new URL(`${MODEL_PERFORMANCE_PATH}${search}`, base);
}

test("model-performance query admits exactly one canonical enum slot", () => {
  const query = (search) => safeModelPerformanceQuery(new URL(`http://preview.local/x${search}`));
  for (const period of PERIODS) {
    for (const speedMode of SPEED_MODES) {
      assert.deepEqual(query(`?period=${period}&speedMode=${speedMode}`), { period, speedMode });
      assert.deepEqual(query(`?speedMode=${speedMode}&period=${period}`), { period, speedMode });
    }
  }
  for (const search of [
    "",
    "?period=7",
    "?speedMode=fast",
    "?period=7&speedMode=fast&extra=1",
    "?period=7&period=7&speedMode=fast",
    "?period=7&speedMode=fast&speedMode=fast",
    "?period=07&speedMode=fast",
    "?period=14&speedMode=fast",
    "?period=ALL&speedMode=fast",
    "?period=7&speedMode=Fast",
    "?period=7&speedMode=priority",
    "?period=7&speed_mode=fast",
    "?period=7%20&speedMode=fast",
    "?period=&speedMode=fast",
  ]) assert.equal(query(search), null, search);
});

test("live preview forwards only the canonical model-performance slot", async (t) => {
  const requests = [];
  const preview = await startPublicReleaseSitePreview({
    fetchImpl: publishedFetch(requests),
    upstream: "https://tibotattle.com",
  });
  t.after(() => preview.close());

  const published = await fetch(previewUrl(preview.url, "?speedMode=fast&period=7"));
  assert.equal(published.status, 200);
  assert.equal(published.headers.get("cache-control"), "no-store");
  assert.equal(
    published.headers.get("x-tibotattle-preview"),
    "generated-source-with-live-public-data",
  );
  assert.equal(published.headers.get(SYNTHETIC_MODEL_PERFORMANCE_FIXTURE_HEADER), null);
  assert.deepEqual(await published.json(), PERFORMANCE_PAYLOAD);
  const forwarded = requests.at(-1);
  // Rebuilt in canonical order, whatever order the page used.
  assert.equal(
    forwarded.url.href,
    "https://tibotattle.com/api/v1/community/model-performance?period=7&speedMode=fast",
  );
  assert.equal(forwarded.options.method, "GET");
  assert.equal(forwarded.options.redirect, "error");
  assert.deepEqual(Object.keys(forwarded.options.headers), ["Accept"]);
  assert.equal(forwarded.options.headers.Accept, "application/json");

  // An explicit unpublished slot reaches the page as the upstream said it.
  const unpublished = await fetch(previewUrl(preview.url, "?period=all&speedMode=ultrafast"));
  assert.equal(unpublished.status, 404);
  assert.deepEqual(await unpublished.json(), UNPUBLISHED_PAYLOAD);

  // Any other upstream failure or a non-JSON answer is a bounded local 502.
  for (const search of ["?period=30&speedMode=standard", "?period=1&speedMode=standard"]) {
    const failed = await fetch(previewUrl(preview.url, search));
    assert.equal(failed.status, 502, search);
    assert.deepEqual(await failed.json(), { error: { code: "PREVIEW_UPSTREAM_UNAVAILABLE" } });
  }

  const forwardedCount = requests.length;
  for (const search of [
    "",
    "?period=7",
    "?period=7&speedMode=fast&extra=1",
    "?period=7&period=7&speedMode=fast",
    "?period=14&speedMode=fast",
    "?period=7&speedMode=Fast",
  ]) {
    const rejected = await fetch(previewUrl(preview.url, search));
    assert.equal(rejected.status, 400, search);
    assert.deepEqual(await rejected.json(), { error: { code: "INVALID_PREVIEW_QUERY" } });
  }
  const rejectedPost = await fetch(previewUrl(preview.url, "?period=7&speedMode=fast"), {
    method: "POST",
  });
  assert.equal(rejectedPost.status, 405);
  // Sibling paths are not proxied; they fall through to the closed asset map.
  for (const path of [
    `${MODEL_PERFORMANCE_PATH}/`,
    `${MODEL_PERFORMANCE_PATH}s?period=7&speedMode=fast`,
    "/api/v1/community/model-history?period=7",
    "/api/v1/admin/performance-intake",
  ]) {
    const sibling = await fetch(new URL(path, preview.url));
    assert.equal(sibling.status, 404, path);
  }
  assert.equal(requests.length, forwardedCount);
});

test("offline preview answers model performance with the labelled synthetic fixture", async (t) => {
  let calls = 0;
  const preview = await startPublicReleaseSitePreview({
    fetchImpl: async () => {
      calls += 1;
      throw new Error("offline preview must not fetch");
    },
    offline: true,
  });
  t.after(() => preview.close());

  for (const period of PERIODS) {
    for (const speedMode of SPEED_MODES) {
      const response = await fetch(
        previewUrl(preview.url, `?period=${period}&speedMode=${speedMode}`),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-tibotattle-preview"), "generated-source-offline");
      assert.equal(
        response.headers.get(SYNTHETIC_MODEL_PERFORMANCE_FIXTURE_HEADER),
        SYNTHETIC_MODEL_PERFORMANCE_FIXTURE_LABEL,
      );
      assert.deepEqual(
        await response.json(),
        syntheticCommunityModelPerformance({ period, speedMode }),
      );
    }
  }
  const rejected = await fetch(previewUrl(preview.url, "?period=7&speedMode=fast&from=x"));
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: { code: "INVALID_PREVIEW_QUERY" } });
  const head = await fetch(previewUrl(preview.url, "?period=7&speedMode=fast"), {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  // The daily series stays visibly unavailable offline; only model performance
  // has a synthetic stand-in.
  const daily = await fetch(
    new URL("/api/v1/community/daily?from=2026-08-01&to=2026-08-17", preview.url),
  );
  assert.equal(daily.status, 503);
  assert.equal(daily.headers.get(SYNTHETIC_MODEL_PERFORMANCE_FIXTURE_HEADER), null);
  assert.equal(calls, 0);
});

const DAY_MS = 86_400_000;
const SLOT_KEYS = [
  "schemaVersion", "methodVersion", "population", "approximate", "revision",
  "generatedAt", "period", "interval", "start", "end", "speedMode",
  "excludedUnknownTurns", "contributors", "devices", "reports", "models",
].sort();
const MODEL_KEYS = [
  "provider", "modelId", "turns", "speedTurns", "ttftTurns", "timedResponses",
  "toolFreeTurns", "contributors", "devices", "speed", "ttft",
].sort();
const POINT_KEYS = ["day", "n", "unresolved", "p10", "p25", "median", "p75", "p90"].sort();
const PERCENTILES = ["p10", "p25", "median", "p75", "p90"];

test("synthetic fixture keeps the closed community-model-performance-v1 shape", () => {
  // This line carries no community contract module, so the closed shape is
  // restated here; the fixture was checked against parseCommunityModelPerformance
  // on the client line when it was written.
  for (const period of PERIODS) {
    for (const speedMode of SPEED_MODES) {
      const slot = syntheticCommunityModelPerformance({ period, speedMode });
      assert.deepEqual(Object.keys(slot).sort(), SLOT_KEYS);
      assert.equal(slot.schemaVersion, "community-model-performance-v1");
      assert.equal(slot.methodVersion, "performance-histogram-pool-type7-bounds-v1");
      assert.equal(slot.population, "reported_samples");
      assert.equal(slot.approximate, true);
      assert.equal(slot.period, period);
      assert.equal(slot.speedMode, speedMode);
      assert.equal(slot.interval, period === "all" ? "week" : "day");
      const start = Date.parse(`${slot.start}T00:00:00.000Z`);
      const end = Date.parse(`${slot.end}T00:00:00.000Z`);
      if (period !== "all") assert.equal(end - start, (Number(period) - 1) * DAY_MS);
      assert.ok(slot.devices >= slot.contributors && slot.reports >= slot.devices);
      assert.ok(slot.models.length > 0);
      for (const model of slot.models) {
        assert.deepEqual(Object.keys(model).sort(), MODEL_KEYS);
        assert.equal(model.provider, "openai_codex");
        assert.ok(model.contributors <= slot.contributors && model.devices <= slot.devices);
        assert.ok(model.devices >= model.contributors);
        assert.ok(model.speedTurns <= model.turns && model.ttftTurns <= model.turns);
        assert.ok(model.toolFreeTurns <= model.speedTurns);
        for (const [metric, unit, total] of [
          ["speed", "tokens_per_second", model.speedTurns],
          ["ttft", "milliseconds", model.ttftTurns],
        ]) {
          const series = model[metric];
          assert.equal(series.unit, unit);
          let sum = 0;
          let previous = -Infinity;
          for (const point of series.points) {
            assert.deepEqual(Object.keys(point).sort(), POINT_KEYS);
            const epoch = Date.parse(`${point.day}T00:00:00.000Z`);
            assert.ok(epoch > previous && epoch <= end && epoch >= start);
            if (slot.interval === "week") assert.equal(new Date(epoch).getUTCDay(), 1);
            previous = epoch;
            assert.ok(point.n >= 1 && point.unresolved >= 0 && point.unresolved <= point.n);
            if (metric === "ttft") assert.equal(point.unresolved, 0);
            let prior = null;
            for (const name of PERCENTILES) {
              const quantile = point[name];
              if (point.n < 5 && name !== "median") {
                assert.equal(quantile, null);
                continue;
              }
              assert.ok(quantile.lower <= quantile.estimate);
              assert.ok(quantile.estimate <= quantile.upper);
              if (prior) {
                assert.ok(quantile.lower >= prior.lower && quantile.upper >= prior.upper);
              }
              prior = quantile;
            }
            sum += point.n;
          }
          assert.equal(sum, total);
        }
      }
      // Content-free: no identifier-shaped field anywhere in the fixture.
      assert.doesNotMatch(
        JSON.stringify(slot),
        /owner|participant|device_?id|account|session|prompt|path/iu,
      );
    }
  }
  assert.throws(
    () => syntheticCommunityModelPerformance({ period: "14", speedMode: "fast" }),
    /reviewed period/u,
  );
});
