#!/usr/bin/env node

import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRODUCT_BRAND,
  SEMANTIC_OPEN_TARGET_PLACEHOLDER,
} from "../config/product-brand.js";
import {
  TELEMETRY_BROWSER_MIRROR_FILE,
  readVerifiedTelemetryBrowserMirror,
} from "./generate-telemetry-browser-mirror.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_SOURCE = join(REPOSITORY_ROOT, "apps", "web", "public");
const TELEMETRY_BROWSER_MIRROR_BASENAME =
  parse(TELEMETRY_BROWSER_MIRROR_FILE).base;
const TELEMETRY_BROWSER_CRYPTO_ADAPTER_BASENAME =
  "telemetry-envelope.js";
const REQUIRED_TELEMETRY_MODULE_BASENAMES = Object.freeze([
  TELEMETRY_BROWSER_MIRROR_BASENAME,
  TELEMETRY_BROWSER_CRYPTO_ADAPTER_BASENAME,
]);
const SOCIAL_PREVIEW_FILENAME = "social-preview.png";
const ROBOTS_FILENAME = "robots.txt";
const MAXIMUM_SOCIAL_PREVIEW_BYTES = 10 * 1024 * 1024;
const SEMANTIC_OPEN_TARGET_META_NAME = "usage-monitor-semantic-open-target";
const REQUIRED_META = Object.freeze({
  "usage-monitor-installer-url": "installerUrl",
  "usage-monitor-installer-version": "installerVersion",
  "usage-monitor-installer-sha256": "installerSha256",
  "usage-monitor-installer-bytes": "installerBytes",
  "usage-monitor-minimum-macos": "minimumMacos",
  "usage-monitor-architectures": "architecturesText",
  "usage-monitor-release-notes-url": "releaseNotesUrl",
  "usage-monitor-privacy-url": "privacyUrl",
  "usage-monitor-security-url": "securityUrl",
  "usage-monitor-support-url": "supportUrl",
});
const REQUIRED_STATIC_SOCIAL_TAGS = Object.freeze([
  '<meta property="og:type" content="website">',
  '<meta property="og:image:width" content="1200">',
  '<meta property="og:image:height" content="630">',
  '<meta name="twitter:card" content="summary_large_image">',
]);
const RELEASE_ARCHITECTURE = "arm64";

function usage() {
  return [
    "Usage:",
    "  node scripts/build-public-release-site.js \\",
    "    --output /absolute/output/directory \\",
    "    --site-url https://approved.example/ \\",
    "    --installer-path /absolute/path/to/notarized/UsageMonitor.dmg \\",
    "    --installer-url https://downloads.approved.example/UsageMonitor.dmg \\",
    "    --installer-version 1.2.3 \\",
    "    --installer-sha256 <64 lowercase hex> \\",
    "    --minimum-macos 13.0 \\",
    "    --architectures arm64 \\",
    "    --release-notes-url https://approved.example/releases/1.2.3 \\",
    "    --privacy-url https://approved.example/privacy \\",
    "    --security-url https://approved.example/security \\",
    "    --support-url https://approved.example/support \\",
    "    --social-image /absolute/path/to/1200x630.png [--replace]",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = { replace: false, source: DEFAULT_SOURCE };
  const keys = {
    "--output": "output",
    "--source": "source",
    "--site-url": "siteUrl",
    "--installer-path": "installerPath",
    "--installer-url": "installerUrl",
    "--installer-version": "installerVersion",
    "--installer-sha256": "installerSha256",
    "--minimum-macos": "minimumMacos",
    "--architectures": "architectures",
    "--release-notes-url": "releaseNotesUrl",
    "--privacy-url": "privacyUrl",
    "--security-url": "securityUrl",
    "--support-url": "supportUrl",
    "--social-image": "socialImage",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--replace") {
      parsed.replace = true;
      continue;
    }
    if (!Object.hasOwn(keys, arg)) {
      throw new TypeError(`Unknown argument: ${arg}\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TypeError(`Missing value for ${arg}\n${usage()}`);
    }
    index += 1;
    parsed[keys[arg]] = value;
  }
  return parsed;
}

function isWithin(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function rejectedPublicHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return isIP(normalized) !== 0
    || normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal")
    || normalized === "example.com"
    || normalized.endsWith(".example.com")
    || normalized === "example.org"
    || normalized.endsWith(".example.org")
    || normalized === "example.net"
    || normalized.endsWith(".example.net")
    || normalized.endsWith(".example")
    || normalized.endsWith(".invalid")
    || normalized.endsWith(".test");
}

function validatedPublicHttpsUrl(
  raw,
  label,
  { requiredSuffix = "", requireTrailingSlash = false } = {},
) {
  if (typeof raw !== "string" || raw !== raw.trim()) {
    throw new TypeError(`${label} must be an absolute public HTTPS URL`);
  }
  let selected;
  try {
    selected = new URL(raw);
  } catch {
    throw new TypeError(`${label} must be an absolute public HTTPS URL`);
  }
  if (selected.protocol !== "https:"
      || !selected.hostname
      || selected.username
      || selected.password
      || selected.port
      || selected.hash
      || selected.search
      || rejectedPublicHostname(selected.hostname)) {
    throw new TypeError(
      `${label} must be stable, credential-free public HTTPS with no port, query, or fragment`,
    );
  }
  if (requiredSuffix
      && !selected.pathname.toLowerCase().endsWith(requiredSuffix)) {
    throw new TypeError(`${label} must end in ${requiredSuffix}`);
  }
  if (requireTrailingSlash
      && (!raw.endsWith("/") || !selected.pathname.endsWith("/"))) {
    throw new TypeError(`${label} must end with / so release assets resolve deterministically`);
  }
  return selected.href;
}

function normalizedArchitectures(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError("Architectures are required");
  }
  if (raw !== RELEASE_ARCHITECTURE) {
    throw new TypeError(
      "Architectures must be exactly arm64; Intel and universal releases are not supported",
    );
  }
  return [RELEASE_ARCHITECTURE];
}

function validateInputs(args) {
  const required = [
    "output",
    "siteUrl",
    "installerPath",
    "installerUrl",
    "installerVersion",
    "installerSha256",
    "minimumMacos",
    "architectures",
    "releaseNotesUrl",
    "privacyUrl",
    "securityUrl",
    "supportUrl",
    "socialImage",
  ];
  if (required.some((key) => !args[key])) {
    throw new TypeError(`All release metadata and artifact paths are required\n${usage()}`);
  }
  if (!isAbsolute(args.output)
      || !isAbsolute(args.installerPath)
      || !isAbsolute(args.socialImage)) {
    throw new TypeError(
      "--output, --installer-path, and --social-image must be absolute paths",
    );
  }
  const source = resolve(args.source);
  const output = resolve(args.output);
  const installerPath = resolve(args.installerPath);
  const socialImage = resolve(args.socialImage);
  if (output === source
      || output === REPOSITORY_ROOT
      || output === homedir()
      || output === parse(output).root
      || isWithin(output, source)
      || isWithin(source, output)
      || isWithin(output, installerPath)
      || isWithin(output, socialImage)) {
    throw new TypeError(
      "Output cannot replace or contain the source, repository, home, or release inputs",
    );
  }
  if (isWithin(source, installerPath) || isWithin(source, socialImage)) {
    throw new TypeError(
      "Installer and social preview inputs must stay outside the copied public source",
    );
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u.test(args.installerVersion)) {
    throw new TypeError("Installer version must be a numeric three- or four-part version");
  }
  if (!/^[a-f0-9]{64}$/u.test(args.installerSha256)) {
    throw new TypeError("Installer SHA-256 must be exactly 64 lowercase hexadecimal characters");
  }
  if (!/^(?:1[0-9]|[2-9][0-9])\.(?:0|[1-9][0-9]?)(?:\.(?:0|[1-9][0-9]?))?$/u
    .test(args.minimumMacos)) {
    throw new TypeError("Minimum macOS must be a canonical version such as 13.0");
  }
  if (extname(socialImage).toLowerCase() !== ".png") {
    throw new TypeError("Social preview must be a PNG file");
  }
  const architectures = normalizedArchitectures(args.architectures);
  const siteUrl = validatedPublicHttpsUrl(args.siteUrl, "Site URL", {
    requireTrailingSlash: true,
  });
  return {
    source,
    output,
    installerPath,
    socialImage,
    siteUrl,
    socialImageUrl: new URL(SOCIAL_PREVIEW_FILENAME, siteUrl).href,
    installerUrl: validatedPublicHttpsUrl(
      args.installerUrl,
      "Installer URL",
      { requiredSuffix: ".dmg" },
    ),
    installerVersion: args.installerVersion,
    installerSha256: args.installerSha256,
    minimumMacos: args.minimumMacos,
    architectures,
    architecturesText: architectures.join(","),
    releaseNotesUrl: validatedPublicHttpsUrl(
      args.releaseNotesUrl,
      "Release notes URL",
    ),
    privacyUrl: validatedPublicHttpsUrl(args.privacyUrl, "Privacy URL"),
    securityUrl: validatedPublicHttpsUrl(args.securityUrl, "Security URL"),
    supportUrl: validatedPublicHttpsUrl(args.supportUrl, "Support URL"),
    replace: args.replace,
  };
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function regularFile(path, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new TypeError(`${label} does not exist or cannot be inspected`);
  }
  if (!stats.isFile()
      || stats.isSymbolicLink()
      || !Number.isSafeInteger(stats.size)
      || stats.size < 1
      || stats.size > maximumBytes) {
    throw new TypeError(`${label} must be a non-empty regular file within its size bound`);
  }
  return stats;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function inspectPng(bytes) {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) {
    throw new TypeError("Social preview must be a complete PNG file");
  }
  let offset = 8;
  let width = null;
  let height = null;
  let sawIdat = false;
  let sawIend = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new TypeError("Social preview must be a complete PNG file");
    }
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const end = offset + 12 + length;
    if (end > bytes.length) {
      throw new TypeError("Social preview must be a complete PNG file");
    }
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) {
        throw new TypeError("Social preview must begin with a valid PNG IHDR");
      }
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
    } else if (type === "IHDR") {
      throw new TypeError("Social preview must contain one PNG IHDR");
    }
    if (type === "IDAT" && length > 0) sawIdat = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length) {
        throw new TypeError("Social preview must end with one PNG IEND");
      }
      sawIend = true;
    }
    offset = end;
  }
  if (!sawIdat || !sawIend) {
    throw new TypeError("Social preview must contain PNG image data and an end marker");
  }
  if (width !== 1200 || height !== 630) {
    throw new TypeError("Social preview must be exactly 1200x630 pixels");
  }
  return { width, height };
}

function htmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function replaceExactlyOnce(html, token, replacement, label) {
  const count = html.split(token).length - 1;
  if (count !== 1) {
    throw new TypeError(`Source must contain exactly one ${label}`);
  }
  return html.replace(token, replacement);
}

function injectReleaseMetadata(html, values) {
  let output = html;
  const semanticPlaceholderCount =
    output.split(SEMANTIC_OPEN_TARGET_PLACEHOLDER).length - 1;
  if (semanticPlaceholderCount !== 1) {
    throw new TypeError(
      "Source must contain exactly one semantic open target placeholder",
    );
  }
  const semanticMetaToken =
    `<meta name="${SEMANTIC_OPEN_TARGET_META_NAME}" `
    + `content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}">`;
  output = replaceExactlyOnce(
    output,
    semanticMetaToken,
    `<meta name="${SEMANTIC_OPEN_TARGET_META_NAME}" `
      + `content="${htmlAttribute(PRODUCT_BRAND.appOpenURL)}">`,
    "semantic open target meta placeholder",
  );
  for (const [name, valueKey] of Object.entries(REQUIRED_META)) {
    const token = `<meta name="${name}" content="">`;
    output = replaceExactlyOnce(
      output,
      token,
      `<meta name="${name}" content="${htmlAttribute(values[valueKey])}">`,
      `empty ${name} meta tag`,
    );
  }
  for (const token of REQUIRED_STATIC_SOCIAL_TAGS) {
    if (output.split(token).length - 1 !== 1) {
      throw new TypeError(`Source must contain exactly one ${token}`);
    }
  }
  for (const [token, replacement, label] of [
    [
      '<link rel="canonical" href="">',
      `<link rel="canonical" href="${htmlAttribute(values.siteUrl)}">`,
      "empty canonical link",
    ],
    [
      '<meta property="og:url" content="">',
      `<meta property="og:url" content="${htmlAttribute(values.siteUrl)}">`,
      "empty Open Graph URL",
    ],
    [
      '<meta property="og:image" content="">',
      `<meta property="og:image" content="${htmlAttribute(values.socialImageUrl)}">`,
      "empty Open Graph image",
    ],
    [
      '<meta name="twitter:image" content="">',
      `<meta name="twitter:image" content="${htmlAttribute(values.socialImageUrl)}">`,
      "empty Twitter image",
    ],
  ]) {
    output = replaceExactlyOnce(output, token, replacement, label);
  }
  return output;
}

async function fileManifest(root, { excludedFiles = new Set() } = {}) {
  const rows = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        if (excludedFiles.has(resolve(path))) continue;
        const bytes = await readFile(path);
        rows.push({
          path: relative(root, path).split(sep).join("/"),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else {
        throw new TypeError("Release-site source contains an unsupported filesystem entry");
      }
    }
  }
  await visit(root);
  return rows;
}

function verifiedMirrorRecord(record) {
  if (record === null || typeof record !== "object"
      || typeof record.sourceText !== "string"
      || typeof record.sha256 !== "string"
      || !Number.isSafeInteger(record.byteLength)
      || record.byteLength < 0) {
    throw new TypeError("Verified telemetry mirror reader returned an invalid record");
  }
  const sha256 = createHash("sha256").update(record.sourceText, "utf8").digest("hex");
  const byteLength = Buffer.byteLength(record.sourceText, "utf8");
  if (record.sha256 !== sha256 || record.byteLength !== byteLength) {
    throw new TypeError("Verified telemetry mirror reader returned inconsistent bytes");
  }
  return Object.freeze({ sourceText: record.sourceText, sha256, byteLength });
}

export async function buildPublicReleaseSite(rawArgs, {
  readVerifiedMirror = readVerifiedTelemetryBrowserMirror,
} = {}) {
  if (typeof readVerifiedMirror !== "function") {
    throw new TypeError("readVerifiedMirror must be a function");
  }
  const options = validateInputs(rawArgs);
  const requiredTelemetryModules = REQUIRED_TELEMETRY_MODULE_BASENAMES.map(
    (basename) => join(options.source, basename),
  );
  for (let index = 0; index < requiredTelemetryModules.length; index += 1) {
    await regularFile(
      requiredTelemetryModules[index],
      `Required public telemetry module ${
        REQUIRED_TELEMETRY_MODULE_BASENAMES[index]
      }`,
    );
  }
  const telemetryMirror = verifiedMirrorRecord(await readVerifiedMirror({
    outputFile: requiredTelemetryModules[0],
  }));
  const sourceIndex = join(options.source, "index.html");
  const sourceHtml = await readFile(sourceIndex, "utf8");
  const installerStats = await regularFile(
    options.installerPath,
    "Installer artifact",
  );
  const installerSha256 = await sha256File(options.installerPath);
  if (installerSha256 !== options.installerSha256) {
    throw new TypeError(
      "Installer SHA-256 does not match the selected local installer artifact",
    );
  }
  const socialStats = await regularFile(
    options.socialImage,
    "Social preview",
    MAXIMUM_SOCIAL_PREVIEW_BYTES,
  );
  const socialBytes = await readFile(options.socialImage);
  const socialDimensions = inspectPng(socialBytes);
  const socialSha256 = createHash("sha256").update(socialBytes).digest("hex");
  const releaseValues = {
    ...options,
    installerBytes: installerStats.size,
  };
  const releaseHtml = injectReleaseMetadata(sourceHtml, releaseValues);
  await fileManifest(options.source, {
    excludedFiles: new Set([requiredTelemetryModules[0]]),
  });

  if (await pathExists(options.output)) {
    if (!options.replace) {
      throw new TypeError("Output already exists; pass --replace to replace this exact directory");
    }
    await rm(options.output, { recursive: true });
  }
  await mkdir(dirname(options.output), { recursive: true });
  await cp(options.source, options.output, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
    filter(source) {
      return resolve(source) !== requiredTelemetryModules[0];
    },
  });
  await writeFile(
    join(options.output, TELEMETRY_BROWSER_MIRROR_BASENAME),
    telemetryMirror.sourceText,
    { encoding: "utf8", mode: 0o644, flag: "wx" },
  );
  await writeFile(join(options.output, "index.html"), releaseHtml, {
    encoding: "utf8",
    mode: 0o644,
  });
  await writeFile(
    join(options.output, SOCIAL_PREVIEW_FILENAME),
    socialBytes,
    { mode: 0o644 },
  );
  const robots = "User-agent: *\nAllow: /\n";
  await writeFile(
    join(options.output, ROBOTS_FILENAME),
    robots,
    { encoding: "utf8", mode: 0o644 },
  );
  const files = await fileManifest(options.output);
  const stagedMirror = files.find(({ path }) =>
    path === TELEMETRY_BROWSER_MIRROR_BASENAME);
  if (stagedMirror === undefined
      || stagedMirror.sha256 !== telemetryMirror.sha256
      || stagedMirror.bytes !== telemetryMirror.byteLength) {
    throw new Error("Release output did not stage the verified telemetry mirror bytes");
  }
  const manifest = {
    schemaVersion: "usage-monitor-release-site-manifest-v0.2",
    site: {
      canonicalUrl: options.siteUrl,
      releaseNotesUrl: options.releaseNotesUrl,
      privacyUrl: options.privacyUrl,
      securityUrl: options.securityUrl,
      supportUrl: options.supportUrl,
      socialPreview: {
        url: options.socialImageUrl,
        path: SOCIAL_PREVIEW_FILENAME,
        mediaType: "image/png",
        width: socialDimensions.width,
        height: socialDimensions.height,
        bytes: socialStats.size,
        sha256: socialSha256,
      },
      robots: {
        path: ROBOTS_FILENAME,
        policy: "allow_all",
      },
    },
    installer: {
      url: options.installerUrl,
      version: options.installerVersion,
      sha256: options.installerSha256,
      bytes: installerStats.size,
      minimumMacos: options.minimumMacos,
      architectures: options.architectures,
      verifiedFromLocalArtifact: true,
    },
    files,
  };
  await writeFile(
    join(options.output, "release-site-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );

  const verifiedHtml = await readFile(join(options.output, "index.html"), "utf8");
  for (const name of Object.keys(REQUIRED_META)) {
    if (verifiedHtml.includes(`<meta name="${name}" content="">`)) {
      throw new Error(`Release output retained empty ${name} metadata`);
    }
  }
  const semanticTargetMeta =
    `<meta name="${SEMANTIC_OPEN_TARGET_META_NAME}" `
    + `content="${htmlAttribute(PRODUCT_BRAND.appOpenURL)}">`;
  if (verifiedHtml.includes(SEMANTIC_OPEN_TARGET_PLACEHOLDER)
      || verifiedHtml.split(semanticTargetMeta).length - 1 !== 1) {
    throw new Error(
      "Release output did not contain exactly one configured semantic open target",
    );
  }
  for (const token of [
    '<link rel="canonical" href="">',
    '<meta property="og:url" content="">',
    '<meta property="og:image" content="">',
    '<meta name="twitter:image" content="">',
  ]) {
    if (verifiedHtml.includes(token)) {
      throw new Error("Release output retained empty canonical or social metadata");
    }
  }
  if (await readFile(join(options.output, ROBOTS_FILENAME), "utf8") !== robots) {
    throw new Error("Release output robots policy was not written deterministically");
  }
  return {
    output: options.output,
    site: manifest.site,
    installer: manifest.installer,
    fileCount: manifest.files.length + 1,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildPublicReleaseSite(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
