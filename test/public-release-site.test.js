import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { buildPublicReleaseSite } from "../scripts/build-public-release-site.js";
import {
  readVerifiedTelemetryBrowserMirror,
} from "../scripts/generate-telemetry-browser-mirror.js";

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
    "<title>Usage Monitor</title>",
    "",
  ].join("\n");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-release-site-"));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "index.html"), sourceHtml());
  await writeFile(join(source, "app.js"), "console.log('safe');\n");
  for (const basename of [
    "telemetry-envelope.js",
    "telemetry-shared.generated.js",
  ]) {
    await writeFile(
      join(source, basename),
      await readFile(join(PUBLIC_SOURCE, basename)),
    );
  }
  const installerPath = join(root, "UsageMonitor-1.2.3.dmg");
  const installerBytes = Buffer.from("deterministic notarized installer fixture");
  await writeFile(installerPath, installerBytes);
  const socialImage = join(root, "release-preview.png");
  await writeFile(socialImage, SOCIAL_IMAGE);
  return {
    root,
    source,
    output: join(root, "release"),
    installerPath,
    installerBytes,
    installerSha256: createHash("sha256").update(installerBytes).digest("hex"),
    socialImage,
  };
}

function releaseArgs(value, overrides = {}) {
  return {
    source: value.source,
    output: value.output,
    siteUrl: "https://usagemonitor.app/",
    installerPath: value.installerPath,
    installerUrl:
      "https://downloads.usagemonitor.app/releases/UsageMonitor-1.2.3.dmg",
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

test("release-site build verifies artifacts and materializes complete public metadata", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = await buildPublicReleaseSite(releaseArgs(value));

  assert.equal(result.fileCount, 7);
  assert.equal(result.installer.bytes, value.installerBytes.length);
  assert.equal(result.installer.verifiedFromLocalArtifact, true);
  assert.deepEqual(result.installer.architectures, ["arm64"]);
  assert.equal(result.site.socialPreview.width, 1200);
  assert.equal(result.site.socialPreview.height, 630);

  const html = await readFile(join(value.output, "index.html"), "utf8");
  assert.match(
    html,
    /content="https:\/\/downloads\.usagemonitor\.app\/releases\/UsageMonitor-1\.2\.3\.dmg"/u,
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
      "app.js",
      "index.html",
      "robots.txt",
      "social-preview.png",
      "telemetry-envelope.js",
      "telemetry-shared.generated.js",
    ],
  );
  assert.equal(Object.hasOwn(manifest.installer, "path"), false);
  assert.doesNotMatch(manifestText, /release-preview\.png/u);
});

test("release-site stages the verified telemetry snapshot if the source changes after capture", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const mirror = join(value.source, "telemetry-shared.generated.js");
  let verified;
  await buildPublicReleaseSite(releaseArgs(value), {
    readVerifiedMirror: async (options) => {
      verified = await readVerifiedTelemetryBrowserMirror(options);
      await writeFile(mirror, "// changed after verification\n");
      return verified;
    },
  });
  assert.equal(await readFile(mirror, "utf8"), "// changed after verification\n");
  assert.equal(
    await readFile(join(value.output, "telemetry-shared.generated.js"), "utf8"),
    verified.sourceText,
  );
  const manifest = JSON.parse(
    await readFile(join(value.output, "release-site-manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.files.find(({ path }) => path === "telemetry-shared.generated.js"),
    {
      path: "telemetry-shared.generated.js",
      bytes: verified.byteLength,
      sha256: verified.sha256,
    },
  );
});

test("checked-in public source satisfies the complete release contract", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = await buildPublicReleaseSite(
    releaseArgs(value, { source: PUBLIC_SOURCE }),
  );
  assert.equal(result.fileCount, 11);
  const html = await readFile(join(value.output, "index.html"), "utf8");
  assert.match(html, /id="installer-compatibility"/u);
  assert.match(html, /id="release-notes-link"/u);
  assert.match(
    await readFile(
      join(value.output, "telemetry-shared.generated.js"),
      "utf8",
    ),
    /^\/\/ @generated by scripts\/generate-telemetry-browser-mirror\.js\n/u,
  );
  assert.match(
    await readFile(join(value.output, "telemetry-envelope.js"), "utf8"),
    /from "\.\/telemetry-shared\.generated\.js";/u,
  );
  assert.doesNotMatch(
    html,
    /<meta name="usage-monitor-installer-bytes" content="">/u,
  );
});

test("release-site build requires both browser telemetry modules", async (t) => {
  for (const basename of [
    "telemetry-envelope.js",
    "telemetry-shared.generated.js",
  ]) {
    const value = await fixture();
    t.after(() => rm(value.root, { recursive: true, force: true }));
    await rm(join(value.source, basename));

    await assert.rejects(
      buildPublicReleaseSite(releaseArgs(value)),
      new RegExp(
        `Required public telemetry module ${
          basename.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
        }`,
        "u",
      ),
    );
  }
});

test("release-site build refuses a stale browser telemetry mirror", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.source, "telemetry-shared.generated.js"),
    "// @generated by scripts/generate-telemetry-browser-mirror.js\nstale\n",
  );

  await assert.rejects(
    buildPublicReleaseSite(releaseArgs(value)),
    /is stale; regenerate it without --check/u,
  );
});

test("release-site build fails closed for unsafe or incomplete release metadata", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const base = releaseArgs(value);

  await assert.rejects(
    buildPublicReleaseSite({
      ...base,
      installerUrl: "http://downloads.usagemonitor.app/app.dmg",
    }),
    /public HTTPS/u,
  );
  await assert.rejects(
    buildPublicReleaseSite({
      ...base,
      installerUrl: "https://example.com/app.dmg",
    }),
    /public HTTPS/u,
  );
  await assert.rejects(
    buildPublicReleaseSite({ ...base, siteUrl: "https://usagemonitor.app" }),
    /must end with \//u,
  );
  await assert.rejects(
    buildPublicReleaseSite({
      ...base,
      supportUrl: "https://usagemonitor.app/support?source=release",
    }),
    /no port, query, or fragment/u,
  );
  await assert.rejects(
    buildPublicReleaseSite({ ...base, installerVersion: "v1.2.3" }),
    /numeric three- or four-part/u,
  );
  await assert.rejects(
    buildPublicReleaseSite({ ...base, installerSha256: "A".repeat(64) }),
    /lowercase hexadecimal/u,
  );
  await assert.rejects(
    buildPublicReleaseSite({ ...base, minimumMacos: "latest" }),
    /canonical version/u,
  );
  await assert.rejects(
    buildPublicReleaseSite({ ...base, architectures: "arm64,amd64" }),
    /Architectures must be exactly arm64/u,
  );
  await assert.rejects(
    buildPublicReleaseSite({ ...base, privacyUrl: "" }),
    /All release metadata/u,
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
      buildPublicReleaseSite({ ...base, architectures }),
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
    buildPublicReleaseSite({
      ...releaseArgs(value),
      installerSha256: "0".repeat(64),
    }),
    /does not match the selected local installer/u,
  );

  const wrongSize = join(value.root, "wrong-size.png");
  await writeFile(wrongSize, grayscalePng(1199, 630));
  await assert.rejects(
    buildPublicReleaseSite({
      ...releaseArgs(value),
      socialImage: wrongSize,
    }),
    /exactly 1200x630/u,
  );

  const linkedInstaller = join(value.root, "linked.dmg");
  await symlink(value.installerPath, linkedInstaller);
  await assert.rejects(
    buildPublicReleaseSite({
      ...releaseArgs(value),
      installerPath: linkedInstaller,
    }),
    /regular file/u,
  );
});

test("release-site build never replaces an existing output without explicit scope", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const base = releaseArgs(value);
  await buildPublicReleaseSite(base);
  await assert.rejects(buildPublicReleaseSite(base), /Output already exists/u);
  await buildPublicReleaseSite({ ...base, replace: true });
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
    join(value.source, "index.html"),
    sourceHtml().replace(
      '<meta name="usage-monitor-installer-url" content="">',
      '<meta name="usage-monitor-installer-url" content="already-filled">',
    ),
  );
  await assert.rejects(
    buildPublicReleaseSite(releaseArgs(value)),
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
    join(value.source, "index.html"),
    sourceHtml().replace(semanticMeta, ""),
  );
  await assert.rejects(
    buildPublicReleaseSite(releaseArgs(value)),
    /exactly one semantic open target placeholder/u,
  );

  await writeFile(
    join(value.source, "index.html"),
    sourceHtml().replace(semanticMeta, `${semanticMeta}\n${semanticMeta}`),
  );
  await assert.rejects(
    buildPublicReleaseSite(releaseArgs(value)),
    /exactly one semantic open target placeholder/u,
  );
});
