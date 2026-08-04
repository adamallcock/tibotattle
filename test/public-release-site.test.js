import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  PRODUCT_BRAND,
  SEMANTIC_OPEN_TARGET_PLACEHOLDER,
} from "../config/product-brand.js";
import {
  buildPublicReleaseSite,
  verifyPublishedInstallerRemote,
} from "../scripts/build-public-release-site.js";
import {
  createMacOSSignedReplacementContract,
} from "../scripts/macos-release-core.js";
import { SPARKLE_VERSION } from "../scripts/macos-updater-core.js";
import {
  collectMacOSWebModuleGraph,
} from "../scripts/build-macos-app.js";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function grayscalePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const scanlines = Buffer.alloc((width + 1) * height);
  const idat = deflateSync(scanlines);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const SOCIAL_IMAGE = grayscalePng(1200, 630);
const PUBLIC_SOURCE = fileURLToPath(
  new URL("../apps/web/public/", import.meta.url),
);

function sourceHtml() {
  return [
    "<!doctype html>",
    '<meta name="usage-monitor-installer-url" content="">',
    '<meta name="usage-monitor-installer-version" content="">',
    '<meta name="usage-monitor-installer-sha256" content="">',
    '<meta name="usage-monitor-installer-bytes" content="">',
    '<meta name="usage-monitor-minimum-macos" content="">',
    '<meta name="usage-monitor-architectures" content="">',
    '<meta name="usage-monitor-release-notes-url" content="">',
    '<meta name="usage-monitor-privacy-url" content="">',
    '<meta name="usage-monitor-security-url" content="">',
    '<meta name="usage-monitor-support-url" content="">',
    `<meta name="usage-monitor-semantic-open-target" content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}">`,
    '<link rel="canonical" href="">',
    '<meta property="og:type" content="website">',
    '<meta property="og:url" content="">',
    '<meta property="og:image" content="">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:image" content="">',
    '<link rel="stylesheet" href="./styles.css">',
    '<script type="module" src="./community.js"></script>',
    '<img src="./tibotattle-icon.png" alt="">',
    "<title>Usage Monitor</title>",
    "",
  ].join("\n");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-release-site-"));
  const source = join(root, "source");
  await mkdir(source);
  // The site is built from the community entry. The dashboard entry is
  // written here too so the build is proven to withhold it, not merely to
  // ignore a file that never existed.
  await writeFile(join(source, "community.html"), sourceHtml());
  await writeFile(
    join(source, "community.js"),
    'import "./community-view.js";\nimport "./localization.js";\nconsole.log("safe");\n',
  );
  await writeFile(
    join(source, "community-view.js"),
    'import "./ui-format.js";\nexport const safeView = true;\n',
  );
  await writeFile(
    join(source, "ui-format.js"),
    "export const safeFormat = true;\n",
  );
  await writeFile(join(source, "localization.js"), "export const safeLocale = true;\n");
  await writeFile(join(source, "styles.css"), "body { color: green; }\n");
  await writeFile(join(source, "tibotattle-icon.png"), "reviewed public asset\n");
  await writeFile(
    join(source, "index.html"),
    "<!doctype html><title>dashboard</title>\n",
  );
  await writeFile(join(source, "app.js"), "console.log('dashboard');\n");
  await writeFile(join(source, "navigation.js"), "export const nav = 1;\n");
  for (const basename of [
    "telemetry-envelope.js",
    "telemetry-shared.generated.js",
  ]) {
    await writeFile(
      join(source, basename),
      await readFile(join(PUBLIC_SOURCE, basename)),
    );
  }
  const installerPath = join(root, "TiboTattle-1.2.3-macOS-arm64.dmg");
  const installerBytes = Buffer.from("deterministic signed release evidence fixture");
  await writeFile(installerPath, installerBytes);
  const installerReleaseManifest = `${installerPath}.release.json`;
  const releaseManifest = {
    schemaVersion: "usage-monitor-macos-release-v0.2",
    application: {
      bundleIdentifier: "com.usagemonitor.local",
      bundleVersion: "1",
      shortVersion: "1.2.3",
    },
    artifact: {
      bytes: installerBytes.length,
      fileName: "TiboTattle-1.2.3-macOS-arm64.dmg",
      sha256: createHash("sha256").update(installerBytes).digest("hex"),
    },
    source: {
      commit: "a".repeat(40),
      tag: "v1.2.3",
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
      appcastURL: "https://updates.tibotattle.com/appcast.xml",
      automaticChecks: true,
      automaticUpdateOptInAvailable: true,
      automaticUpdatesEnabledByDefault: true,
      afterUserOptIn: {
        automaticDownload: true,
        installOnQuit: true,
      },
      enabled: true,
      frameworkVersion: SPARKLE_VERSION,
      publicEdKeySha256: "b".repeat(64),
      requiresSignedFeed: true,
    },
    replacement: createMacOSSignedReplacementContract(),
  };
  await writeFile(
    installerReleaseManifest,
    `${JSON.stringify(releaseManifest)}\n`,
  );
  const socialImage = join(root, "release-preview.png");
  await writeFile(socialImage, SOCIAL_IMAGE);
  return {
    root,
    source,
    output: join(root, "release"),
    installerPath,
    installerBytes,
    installerSha256: createHash("sha256").update(installerBytes).digest("hex"),
    installerReleaseManifest,
    releaseManifest,
    socialImage,
  };
}

function releaseArgs(value, overrides = {}) {
  return {
    source: value.source,
    output: value.output,
    siteUrl: "https://usagemonitor.app/",
    installerPath: value.installerPath,
    installerReleaseManifest: value.installerReleaseManifest,
    installerUrl:
      "https://downloads.usagemonitor.app/releases/TiboTattle-1.2.3-macOS-arm64.dmg",
    installerVersion: "1.2.3",
    installerSha256: value.installerSha256,
    minimumMacos: "13.0",
    architectures: "arm64",
    releaseNotesUrl: "https://usagemonitor.app/releases/1.2.3",
    privacyUrl: "https://usagemonitor.app/privacy",
    securityUrl: "https://usagemonitor.app/security",
    supportUrl: "https://usagemonitor.app/support",
    socialImage: value.socialImage,
    replace: false,
    ...overrides,
  };
}

function buildFixtureSite(args, overrides = {}) {
  return buildPublicReleaseSite(args, {
    validateInstallerArtifact: async () => {},
    verifyPublishedInstaller: async ({
      installerUrl,
      expectedBytes,
      expectedSha256,
    }) => ({
      bytes: expectedBytes,
      finalUrl: installerUrl,
      sha256: expectedSha256,
    }),
    ...overrides,
  });
}

async function serveReleaseOutput(output) {
  const routeFiles = new Map([
    ["/", "index.html"],
    ["/community", "community.html"],
    ["/community/", "community.html"],
    ["/privacy", "privacy.html"],
    ["/privacy/", "privacy.html"],
    ["/docs", "docs.html"],
    ["/docs/", "docs.html"],
  ]);
  const server = createServer(async (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      response.end("method_not_allowed");
      return;
    }
    const pathname = new URL(
      request.url ?? "/",
      "http://release-site.test",
    ).pathname;
    const knownRoute = routeFiles.has(pathname);
    const filename = routeFiles.get(pathname) ?? "404.html";
    try {
      const body = await readFile(join(output, filename));
      response.writeHead(knownRoute ? 200 : 404, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(body);
    } catch {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("release_route_missing");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function assertPublicEntryClaimBoundary(html, label = "public entry") {
  assert.match(html, /Community activity snapshot/u, label);
  assert.match(html, /delayed, aggregate activity/u, label);
  assert.doesNotMatch(
    html,
    /Community seven-day estimate|community allowance|community estimate|community capacity|best guess|privacy[- ]reviewed|privacy and quality checks|privacy-safe community/u,
    label,
  );
  for (const forbidden of [
    'id="community-estimate-hero"',
    'id="community-estimate-panel-state"',
    'id="community-estimate-result"',
  ]) {
    assert.equal(html.includes(forbidden), false, `${label}: ${forbidden}`);
  }
}

test("release-site build verifies artifacts and materializes complete public metadata", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const validatedArtifacts = [];
  const verifiedPublishedInstallers = [];
  const result = await buildPublicReleaseSite(releaseArgs(value), {
    validateInstallerArtifact: async (...args) => validatedArtifacts.push(args),
    verifyPublishedInstaller: async (evidence) => {
      verifiedPublishedInstallers.push(evidence);
      return {
        bytes: evidence.expectedBytes,
        finalUrl: evidence.installerUrl,
        sha256: evidence.expectedSha256,
      };
    },
  });

  assert.equal(result.fileCount, 12);
  assert.deepEqual(validatedArtifacts, [[
    value.installerPath,
    { production: true },
  ]]);
  assert.deepEqual(verifiedPublishedInstallers, [{
    expectedBytes: value.installerBytes.length,
    expectedSha256: value.installerSha256,
    installerUrl:
      "https://downloads.usagemonitor.app/releases/TiboTattle-1.2.3-macOS-arm64.dmg",
  }]);
  assert.equal(result.installer.bytes, value.installerBytes.length);
  assert.equal(result.installer.verifiedSignedReleaseEvidence, true);
  assert.equal(Object.hasOwn(result.installer, "verifiedFromLocalArtifact"), false);
  assert.deepEqual(result.installer.architectures, ["arm64"]);
  assert.equal(result.site.socialPreview.width, 1200);
  assert.equal(result.site.socialPreview.height, 630);

  const html = await readFile(join(value.output, "index.html"), "utf8");
  assert.match(
    html,
    /content="https:\/\/downloads\.usagemonitor\.app\/releases\/TiboTattle-1\.2\.3-macOS-arm64\.dmg"/u,
  );
  assert.match(html, /usage-monitor-installer-version" content="1\.2\.3"/u);
  assert.match(
    html,
    new RegExp(
      `usage-monitor-installer-sha256" content="${value.installerSha256}"`,
      "u",
    ),
  );
  assert.match(
    html,
    new RegExp(
      `usage-monitor-installer-bytes" content="${value.installerBytes.length}"`,
      "u",
    ),
  );
  assert.match(html, /usage-monitor-minimum-macos" content="13\.0"/u);
  assert.match(
    html,
    /usage-monitor-architectures" content="arm64"/u,
  );
  assert.equal(
    html.includes(
      `<meta name="usage-monitor-semantic-open-target" content="${PRODUCT_BRAND.appOpenURL}">`,
    ),
    true,
  );
  assert.equal(html.includes(SEMANTIC_OPEN_TARGET_PLACEHOLDER), false);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/usagemonitor\.app\/">/u,
  );
  assert.match(
    html,
    /property="og:image" content="https:\/\/usagemonitor\.app\/social-preview\.png"/u,
  );
  assert.match(
    html,
    /name="twitter:image" content="https:\/\/usagemonitor\.app\/social-preview\.png"/u,
  );
  assert.equal(
    await readFile(join(value.output, "robots.txt"), "utf8"),
    "User-agent: *\nAllow: /\n",
  );
  assert.deepEqual(
    await readFile(join(value.output, "social-preview.png")),
    SOCIAL_IMAGE,
  );

  const manifestText = await readFile(
    join(value.output, "release-site-manifest.json"),
    "utf8",
  );
  const manifest = JSON.parse(manifestText);
  assert.equal(
    manifest.schemaVersion,
    "usage-monitor-release-site-manifest-v0.2",
  );
  assert.equal(manifest.installer.minimumMacos, "13.0");
  assert.equal(manifest.site.robots.policy, "allow_all");
  assert.deepEqual(
    manifest.files.map(({ path }) => path),
    [
      "404.html",
      "community-view.js",
      "community.html",
      "community.js",
      "index.html",
      "localization.js",
      "robots.txt",
      "social-preview.png",
      "styles.css",
      "tibotattle-icon.png",
      "ui-format.js",
    ],
  );
  assert.equal(Object.hasOwn(manifest.installer, "path"), false);
  assert.equal(
    manifest.installer.releaseEvidence.schemaVersion,
    "usage-monitor-macos-release-v0.2",
  );
  assert.doesNotMatch(manifestText, /release-preview\.png/u);
});

test("no-installer release-site build succeeds without installer claims and disables the CTA", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const {
    installerPath,
    installerReleaseManifest,
    installerUrl,
    installerVersion,
    installerSha256,
    minimumMacos,
    architectures,
    ...noInstallerArgs
  } = releaseArgs(value);
  noInstallerArgs.source = PUBLIC_SOURCE;
  void installerPath;
  void installerReleaseManifest;
  void installerUrl;
  void installerVersion;
  void installerSha256;
  void minimumMacos;
  void architectures;

  const result = await buildFixtureSite(noInstallerArgs);
  assert.equal(result.installer, null);
  const html = await readFile(join(value.output, "index.html"), "utf8");
  assertPublicEntryClaimBoundary(html);
  assert.match(html, /Signed release coming soon\./u);
  assert.match(html, /id="installer-link"[^>]*hidden/u);
  assert.match(html, /id="installer-unavailable-action"[^>]*disabled/u);
  assert.match(html, /id="installer-unavailable"/u);
  assert.doesNotMatch(html, /id="installer-link"[^>]*href=/u);
  assert.doesNotMatch(html, /TiboTattle-[^"']+\.dmg/u);
  assert.doesNotMatch(html, /usage-monitor-installer-/u);
  const manifest = JSON.parse(
    await readFile(join(value.output, "release-site-manifest.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(manifest, "installer"), false);
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /verified(?:FromLocalArtifact|SignedReleaseEvidence)/u,
  );
});

test("public static routes keep root, community, privacy, and fallback out of the loopback dashboard", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const noInstallerArgs = {
    ...releaseArgs(value),
    source: PUBLIC_SOURCE,
  };
  for (const key of [
    "installerPath",
    "installerReleaseManifest",
    "installerUrl",
    "installerVersion",
    "installerSha256",
    "minimumMacos",
    "architectures",
  ]) {
    delete noInstallerArgs[key];
  }
  await buildFixtureSite(noInstallerArgs);
  const routeServer = await serveReleaseOutput(value.output);
  t.after(() => routeServer.close());

  const responses = new Map();
  for (const [route, expectedStatus] of [
    ["/", 200],
    ["/community", 200],
    ["/privacy", 200],
    ["/unknown/fallback", 404],
  ]) {
    const response = await fetch(`${routeServer.baseUrl}${route}`);
    assert.equal(response.status, expectedStatus, route);
    responses.set(route, await response.text());
  }

  const root = responses.get("/");
  const community = responses.get("/community");
  const privacy = responses.get("/privacy");
  const fallback = responses.get("/unknown/fallback");
  for (const [route, html] of [
    ["/", root],
    ["/community", community],
    ["/unknown/fallback", fallback],
  ]) {
    assertPublicEntryClaimBoundary(html, route);
  }
  for (const [route, html] of responses) {
    assert.match(html, /TiboTattle/u, route);
    for (const forbidden of [
      'src="./app.js"',
      'src="./data-client.js"',
      'src="./navigation.js"',
      'id="refresh-button"',
      'id="contribution-form"',
      'id="identity-signin"',
      'class="dashboard-shell"',
      "data-dashboard-page=",
      "/api/local/",
    ]) {
      assert.equal(html.includes(forbidden), false, `${route}: ${forbidden}`);
    }
  }
  assert.match(root, /<h1 id="install-title">Understand your Codex week\.<\/h1>/u);
  assert.match(root, /id="community-result"/u);
  assert.match(root, /id="installer-unavailable-action"[\s\S]*disabled/u);
  assert.match(root, /Signed release coming soon\./u);
  assert.equal(community, root, "the community route must use the public entry alias");
  assert.match(privacy, /<h1>Your dashboard belongs on your Mac\.<\/h1>/u);
  assert.match(privacy, /This website cannot read local Codex files\./u);
  assert.doesNotMatch(privacy, /<script\b/iu);
  assert.equal(fallback, root, "the fallback must return the public entry, not the dashboard");

  for (const forbiddenAsset of [
    "app.js",
    "data-client.js",
    "lib.js",
    "navigation.js",
    "telemetry-envelope.js",
    "telemetry-shared.generated.js",
  ]) {
    const response = await fetch(`${routeServer.baseUrl}/${forbiddenAsset}`);
    assert.equal(response.status, 404, forbiddenAsset);
    assert.doesNotMatch(await response.text(), /LocalCompanionClient|id="refresh-button"/u);
  }

  const loopbackDashboard = await readFile(join(PUBLIC_SOURCE, "index.html"), "utf8");
  assert.match(loopbackDashboard, /<script type="module" src="\.\/app\.js"><\/script>/u);
  assert.match(loopbackDashboard, /id="refresh-button"/u);
});

test("arbitrary text fixture with a matching caller hash cannot enable installer metadata", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const plainPath = join(value.root, "not-an-installer.txt");
  const plainBytes = Buffer.from("plain text is not signed release evidence\n");
  await writeFile(plainPath, plainBytes);
  await assert.rejects(
    buildFixtureSite({
      ...releaseArgs(value),
      installerPath: plainPath,
      installerReleaseManifest: plainPath,
      installerSha256: createHash("sha256").update(plainBytes).digest("hex"),
    }),
    /release manifest|JSON|signed macOS/u,
  );
  assert.equal(
    await readFile(plainPath, "utf8"),
    plainBytes.toString(),
  );
  await assert.rejects(readFile(join(value.output, "release-site-manifest.json")));
});

test("release-site build withholds installer claims when the public artifact cannot be reverified", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await assert.rejects(
    buildFixtureSite(releaseArgs(value), {
      verifyPublishedInstaller: async () => {
        throw new Error("Published installer digest does not match signed evidence");
      },
    }),
    /Published installer digest does not match signed evidence/u,
  );
  await assert.rejects(readFile(join(value.output, "release-site-manifest.json")));
});

test("published installer verification follows only public HTTPS redirects and rehashes bytes", async () => {
  const installerBytes = Buffer.from("signed installer bytes");
  const installerSha256 = createHash("sha256")
    .update(installerBytes)
    .digest("hex");
  const requests = [];
  const result = await verifyPublishedInstallerRemote({
    installerUrl: "https://downloads.usagemonitor.app/TiboTattle.dmg",
    expectedBytes: installerBytes.length,
    expectedSha256: installerSha256,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (requests.length === 1) {
        return new Response(null, {
          headers: {
            location: "https://objects.usagemonitor.app/signed/TiboTattle.dmg?token=reviewed",
          },
          status: 302,
        });
      }
      return new Response(installerBytes, {
        headers: { "content-length": String(installerBytes.length) },
        status: 200,
      });
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.redirect, "manual");
  assert.equal(
    requests[1].url,
    "https://objects.usagemonitor.app/signed/TiboTattle.dmg?token=reviewed",
  );
  assert.deepEqual(result, {
    bytes: installerBytes.length,
    finalUrl: "https://objects.usagemonitor.app/signed/TiboTattle.dmg?token=reviewed",
    sha256: installerSha256,
  });
  await assert.rejects(
    verifyPublishedInstallerRemote({
      installerUrl: "https://downloads.usagemonitor.app/TiboTattle.dmg",
      expectedBytes: installerBytes.length,
      expectedSha256: installerSha256,
      fetchImpl: async () => new Response(Buffer.from("wrong bytes"), {
        headers: { "content-length": "11" },
        status: 200,
      }),
    }),
    /byte length|digest/u,
  );
});

test("checked-in public source satisfies the complete release contract", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = await buildFixtureSite(
    releaseArgs(value, { source: PUBLIC_SOURCE }),
  );
  assert.equal(result.fileCount, 20);
  const manifest = JSON.parse(
    await readFile(join(value.output, "release-site-manifest.json"), "utf8"),
  );
  // The exact published surface: the community entry and the modules it
  // shares with the app, and nothing that needs the local companion.
  assert.deepEqual(
    manifest.files.map(({ path }) => path),
    [
      "404.html",
      "apple.svg",
      "community-data.js",
      "community-view.js",
      "community.html",
      "community.js",
      "docs.html",
      "github.svg",
      "index.html",
      "install-cta.js",
      "localization.js",
      "privacy.html",
      "robots.txt",
      "social-preview.png",
      "styles.css",
      "tibotattle-icon.png",
      "tibotattle-weekly-preview.jpg",
      "ui-format.js",
      "x.svg",
    ],
  );
  // The builder copies the community entry's real import closure, so extracting
  // a shared module cannot publish an index whose imports 404.
  const publishedNames = new Set(manifest.files.map(({ path }) => path));
  for (const publicAsset of [
    "apple.svg",
    "github.svg",
    "tibotattle-icon.png",
    "tibotattle-weekly-preview.jpg",
    "x.svg",
  ]) {
    assert.ok(publishedNames.has(publicAsset), `Missing public asset ${publicAsset}`);
  }
  const communityClosure = await collectMacOSWebModuleGraph({
    entrypoints: ["apps/web/public/community.js"],
  });
  for (const relativeFile of communityClosure.relativeFiles) {
    const name = relativeFile.slice("apps/web/public/".length);
    assert.ok(
      publishedNames.has(name),
      `Release site imports ${name} but does not publish it`,
    );
  }
  const html = await readFile(join(value.output, "index.html"), "utf8");
  const communityHtml = await readFile(join(value.output, "community.html"), "utf8");
  const fallbackHtml = await readFile(join(value.output, "404.html"), "utf8");
  const docsHtml = await readFile(join(value.output, "docs.html"), "utf8");
  const privacyHtml = await readFile(join(value.output, "privacy.html"), "utf8");
  assertPublicEntryClaimBoundary(html);
  assert.equal(communityHtml, html, "the community route output stays identical to the index");
  assert.equal(fallbackHtml, html, "the fallback output stays identical to the index");
  assert.match(html, /id="installer-compatibility"/u);
  assert.match(html, /id="release-notes-link"/u);
  assert.match(html, /href="\.\/docs\.html"/u);
  assert.match(html, /href="\.\/privacy\.html"/u);
  for (const auxiliaryHtml of [docsHtml, privacyHtml]) {
    assert.match(auxiliaryHtml, /href="\.\/index\.html#download"/u);
    assert.doesNotMatch(auxiliaryHtml, /href="\.\/community\.html/u);
    assert.doesNotMatch(auxiliaryHtml, /<script/u);
  }
  // The install call to action and the community view are present; the
  // companion-only dashboard surfaces are not.
  assert.match(html, /id="installer-link"/u);
  assert.match(html, /id="community-result"/u);
  assert.match(html, /src="\.\/community\.js"/u);
  assert.match(html, /id="community-title">Community activity snapshot<\/h2>/u);
  const publishedHtml = [html, docsHtml, privacyHtml].join("\n");
  for (
    const dashboardOnly of [
      "./app.js",
      "./data-client.js",
      "./lib.js",
      "./navigation.js",
      "./admin-client.js",
      "./admin.css",
      "./admin.html",
      "./admin.js",
      'id="contribution-form"',
      'id="identity-signin"',
      'id="connect-community"',
      'id="quota-cards"',
      'id="weekly-chart"',
      'id="refresh-button"',
    ]
  ) {
    assert.equal(publishedHtml.includes(dashboardOnly), false, dashboardOnly);
  }
  for (const privateModule of [
    "app.js",
    "data-client.js",
    "lib.js",
    "navigation.js",
    "telemetry-envelope.js",
    "telemetry-shared.generated.js",
  ]) {
    assert.equal(publishedNames.has(privateModule), false, privateModule);
  }
  const publishedJavaScript = (
    await Promise.all(
      manifest.files
        .filter(({ path }) => path.endsWith(".js"))
        .map(({ path }) => readFile(join(value.output, path), "utf8")),
    )
  ).join("\n");
  const publishedCommunityEntry = await readFile(
    join(value.output, "community.js"),
    "utf8",
  );
  assert.doesNotMatch(
    publishedCommunityEntry,
    /renderCommunityEstimate|estimateContainer|estimateHero|estimateStates|id="community-estimate/u,
  );
  for (const privateCapability of [
    "/api/local",
    "/identity/",
    "/me/contributions",
    "LocalCompanionClient",
    "createTelemetryEnvelope",
    "deleteParticipant",
  ]) {
    assert.equal(
      publishedJavaScript.includes(privateCapability),
      false,
      privateCapability,
    );
  }
  assert.match(publishedJavaScript, /COMMUNITY_ROOT = "\/api\/v1"/u);
  assert.match(publishedJavaScript, /stats\/aggregate/u);
  assert.doesNotMatch(
    html,
    /<meta name="usage-monitor-installer-bytes" content="">/u,
  );
});

test("release-site build rejects an unreviewed script reference", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.source, "community.html"),
    `${sourceHtml()}<script src="./app.js"></script>\n`,
  );

  await assert.rejects(
    buildFixtureSite(releaseArgs(value)),
    /Public HTML may load only community\.js/u,
  );
});

test("release-site build fails closed before staging dashboard-only source", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.source, "data-client.js"),
    "export const localOnly = true;\n",
  );
  await writeFile(
    join(value.source, "community.js"),
    'import "./data-client.js";\nexport const publicEntry = true;\n',
  );
  await assert.rejects(
    buildFixtureSite(releaseArgs(value)),
    /dashboard-only source: data-client\.js/u,
  );
  await assert.rejects(
    readFile(join(value.output, "release-site-manifest.json")),
    { code: "ENOENT" },
  );

  await writeFile(
    join(value.source, "community.js"),
    'export const publicEntry = true;\n',
  );
  await writeFile(
    join(value.source, "community.html"),
    `${sourceHtml()}<section class="dashboard-shell"></section>\n`,
  );
  await assert.rejects(
    buildFixtureSite(releaseArgs(value)),
    /local-only route or control: class="dashboard-shell"/u,
  );
  await assert.rejects(
    readFile(join(value.output, "release-site-manifest.json")),
    { code: "ENOENT" },
  );
});

test("release-site build rejects an unreviewed public page", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.source, "community.html"),
    `${sourceHtml()}<a href="./account.html">Account</a>\n`,
  );

  await assert.rejects(
    buildFixtureSite(releaseArgs(value)),
    /Public source contains an unreviewed HTML page: account\.html/u,
  );
});

test("release-site build keeps auxiliary public pages static", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.source, "community.html"),
    `${sourceHtml()}<a href="./docs.html">Docs</a>\n`,
  );
  await writeFile(
    join(value.source, "docs.html"),
    '<!doctype html><a href="./community.html">Home</a><script>void 0</script>\n',
  );

  await assert.rejects(
    buildFixtureSite(releaseArgs(value)),
    /Public auxiliary page must be static and script-free: docs\.html/u,
  );
});

test("release-site build resolves alternate quoting in auxiliary page links", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.source, "community.html"),
    `${sourceHtml()}<a href='./docs.html'>Docs</a>\n`,
  );
  await writeFile(
    join(value.source, "docs.html"),
    "<!doctype html><a href='./community.html#download'>Download</a>\n",
  );

  await buildFixtureSite(releaseArgs(value));
  const docsHtml = await readFile(join(value.output, "docs.html"), "utf8");
  assert.match(docsHtml, /href='\.\/index\.html#download'/u);
  assert.doesNotMatch(docsHtml, /community\.html/u);
});

test("release-site build fails closed for unsafe or incomplete release metadata", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const base = releaseArgs(value);

  await assert.rejects(
    buildFixtureSite({
      ...base,
      installerUrl: "http://downloads.usagemonitor.app/app.dmg",
    }),
    /public HTTPS/u,
  );
  await assert.rejects(
    buildFixtureSite({
      ...base,
      installerUrl: "https://example.com/app.dmg",
    }),
    /public HTTPS/u,
  );
  await assert.rejects(
    buildFixtureSite({ ...base, siteUrl: "https://usagemonitor.app" }),
    /must end with \//u,
  );
  await assert.rejects(
    buildFixtureSite({
      ...base,
      supportUrl: "https://usagemonitor.app/support?source=release",
    }),
    /no port, query, or fragment/u,
  );
  await assert.rejects(
    buildFixtureSite({ ...base, installerVersion: "v1.2.3" }),
    /numeric three- or four-part/u,
  );
  await assert.rejects(
    buildFixtureSite({ ...base, installerSha256: "A".repeat(64) }),
    /lowercase hexadecimal/u,
  );
  await assert.rejects(
    buildFixtureSite({ ...base, minimumMacos: "latest" }),
    /canonical version/u,
  );
  await assert.rejects(
    buildFixtureSite({ ...base, architectures: "arm64,amd64" }),
    /Architectures must be exactly arm64/u,
  );
  await assert.rejects(
    buildFixtureSite({ ...base, privacyUrl: "" }),
    /Site metadata and artifact paths are incomplete/u,
  );
});

test("release-site build rejects Intel and universal compatibility declarations", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const base = releaseArgs(value);

  for (const architectures of [
    "x86_64",
    "arm64,x86_64",
    "universal",
    "arm64,universal",
  ]) {
    await assert.rejects(
      buildFixtureSite({ ...base, architectures }),
      {
        name: "TypeError",
        message:
          "Architectures must be exactly arm64; Intel and universal releases are not supported",
      },
      `must reject ${architectures}`,
    );
  }
});

test("release-site build compares digest, dimensions, and regular artifact paths", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));

  await assert.rejects(
    buildFixtureSite({
      ...releaseArgs(value),
      installerSha256: "0".repeat(64),
    }),
    /does not match the signed macOS release manifest/u,
  );

  const wrongSize = join(value.root, "wrong-size.png");
  await writeFile(wrongSize, grayscalePng(1199, 630));
  await assert.rejects(
    buildFixtureSite({
      ...releaseArgs(value),
      socialImage: wrongSize,
    }),
    /exactly 1200x630/u,
  );

  const linkedInstaller = join(value.root, "linked.dmg");
  await symlink(value.installerPath, linkedInstaller);
  await assert.rejects(
    buildFixtureSite({
      ...releaseArgs(value),
      installerPath: linkedInstaller,
    }),
    /does not match the release manifest artifact/u,
  );
});

test("release-site build never replaces an existing output without explicit scope", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const base = releaseArgs(value);
  await buildFixtureSite(base);
  await assert.rejects(buildFixtureSite(base), /Output already exists/u);
  await buildFixtureSite({ ...base, replace: true });
  assert.equal(
    JSON.parse(
      await readFile(join(value.output, "release-site-manifest.json"), "utf8"),
    ).schemaVersion,
    "usage-monitor-release-site-manifest-v0.2",
  );
});

test("release-site source must expose each empty metadata slot exactly once", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.source, "community.html"),
    sourceHtml().replace(
      '<meta name="usage-monitor-installer-url" content="">',
      '<meta name="usage-monitor-installer-url" content="already-filled">',
    ),
  );
  await assert.rejects(
    buildFixtureSite(releaseArgs(value)),
    /exactly one empty usage-monitor-installer-url/u,
  );
});

test("release-site source must expose the semantic open target placeholder exactly once", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const semanticMeta =
    `<meta name="usage-monitor-semantic-open-target" `
    + `content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}">`;

  await writeFile(
    join(value.source, "community.html"),
    sourceHtml().replace(semanticMeta, ""),
  );
  await assert.rejects(
    buildFixtureSite(releaseArgs(value)),
    /exactly one semantic open target placeholder/u,
  );

  await writeFile(
    join(value.source, "community.html"),
    sourceHtml().replace(semanticMeta, `${semanticMeta}\n${semanticMeta}`),
  );
  await assert.rejects(
    buildFixtureSite(releaseArgs(value)),
    /exactly one semantic open target placeholder/u,
  );
});
