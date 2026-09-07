#!/usr/bin/env node

import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { homedir } from "node:os";
import {
  basename,
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
  collectMacOSWebModuleGraph,
} from "./build-macos-app.js";
import {
  validateMacOSDMG,
  validateMacOSSignedReleaseArtifact,
} from "./macos-release-core.js";
import {
  RELEASE_EVIDENCE_PLATFORM_ASSURANCES,
  RELEASE_EVIDENCE_MAX_MANIFEST_BYTES,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
} from "../config/release-evidence.js";
import {
  digestRegularFile,
  readJsonFile,
  readTextFile,
  validateReleaseEvidenceManifest,
} from "./release-evidence.js";
import { PRODUCT_BRAND } from "../config/product-brand.js";
import {
  createPublicReleaseSourceProvenance,
  PUBLIC_RELEASE_MANIFEST_SCHEMA,
} from "./public-release-provenance.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_SOURCE = join(REPOSITORY_ROOT, "apps", "web", "public");
const SOCIAL_PREVIEW_FILENAME = "social-preview.png";
const ROBOTS_FILENAME = "robots.txt";
const SITEMAP_FILENAME = "sitemap.xml";
const PUBLIC_COMMUNITY_ROUTE_FILENAME = "community.html";
const PUBLIC_FALLBACK_ROUTE_FILENAME = "404.html";
const SITE_ENTRY_MODULE_BASENAME = "community.js";
/**
 * The public site is built from the community entry, not from the dashboard
 * entry. The dashboard is the Mac app's own interface: every control in it
 * needs the loopback companion, so publishing it puts dead controls on a page
 * that can never make them work.
 */
const SITE_INDEX_SOURCE_BASENAME = "community.html";
const PUBLIC_AUXILIARY_PAGE_BASENAMES = Object.freeze([
  "docs.html",
  "privacy.html",
]);
// Source filenames do not define public canonical URLs. Keeping this mapping
// beside the generator ensures HTML metadata, the sitemap, and robots policy
// stay in lockstep with the configured public origin.
const PUBLIC_PAGE_ROUTE_BY_SOURCE_BASENAME = Object.freeze({
  [SITE_INDEX_SOURCE_BASENAME]: "/",
  "docs.html": "/docs",
  "privacy.html": "/privacy",
});
/**
 * Defense-in-depth absence ledger for the in-app dashboard surface. The
 * release is selected from the public module and asset closures below; these
 * exact names are checked again after staging so a future selection change
 * cannot silently publish an app-only surface.
 */
const APP_ONLY_SOURCE_BASENAMES = Object.freeze([
  "admin-client.js",
  "admin.css",
  "admin.html",
  "admin.js",
  "app.js",
  "data-client.js",
  "index.html",
  "lib.js",
  "navigation.js",
  "telemetry-envelope.js",
  "telemetry-shared.generated.js",
]);
const MAXIMUM_SOCIAL_PREVIEW_BYTES = 10 * 1024 * 1024;
const INSTALLER_FETCH_TIMEOUT_MS = 120_000;
const MAXIMUM_INSTALLER_REDIRECTS = 5;
const INSTALLER_META = Object.freeze({
  "usage-monitor-installer-url": "installerUrl",
  "usage-monitor-installer-version": "installerVersion",
  "usage-monitor-installer-sha256": "installerSha256",
  "usage-monitor-installer-bytes": "installerBytes",
  "usage-monitor-minimum-macos": "minimumMacos",
  "usage-monitor-architectures": "architecturesText",
});
const SITE_META = Object.freeze({
  "usage-monitor-release-notes-url": "releaseNotesUrl",
  "usage-monitor-privacy-url": "privacyUrl",
  "usage-monitor-security-url": "securityUrl",
  "usage-monitor-support-url": "supportUrl",
});
const INSTALLER_OPTION_KEYS = Object.freeze([
  "installerPath",
  "installerReleaseManifest",
  "installerUrl",
  "installerVersion",
  "installerSha256",
  "minimumMacos",
  "architectures",
]);
const INTEL_INSTALLER_OPTION_KEYS = Object.freeze([
  "intelInstallerPath", "intelInstallerUrl", "intelMinimumMacos",
]);
const PUBLIC_ROUTE_MARKERS = Object.freeze([
  "./app.js",
  "/app.js",
  '"app.js"',
  "'app.js'",
  "./data-client.js",
  "/data-client.js",
  '"data-client.js"',
  "'data-client.js'",
  "./navigation.js",
  "/navigation.js",
  '"navigation.js"',
  "'navigation.js'",
  "./admin.js",
  "/admin.js",
  '"admin.js"',
  "'admin.js'",
  "./admin-client.js",
  "/admin-client.js",
  '"admin-client.js"',
  "'admin-client.js'",
  "./admin.css",
  "/admin.css",
  '"admin.css"',
  "'admin.css'",
  "./admin.html",
  "/admin.html",
  '"admin.html"',
  "'admin.html'",
  'id="refresh-button"',
  'id="connection-notice"',
  'id="companion-setup"',
  'id="setup-card"',
  'id="quota-cards"',
  'id="weekly-chart"',
  'id="timeline-chart"',
  'id="connect-community"',
  'id="contribution-form"',
  'id="identity-signin"',
  'id="identity-google-signin"',
  'id="identity-apple-signin"',
  'id="sign-in"',
  'id="signin"',
  'id="admin"',
  'id="app-open"',
  'id="open-installed-app"',
  'id="contribution-',
  'id="identity-',
  'id="sign-in-',
  'id="admin-',
  'id="app-open-',
  'name="contribution',
  'href="#contribution',
  'href="#sign-in',
  'href="#signin',
  'href="#admin',
  'href="#app-open',
  'class="dashboard-shell"',
  'class="dashboard-sidebar"',
  "data-dashboard-page=",
  "data-requires-evidence",
  "/api/local/",
  "LocalCompanionClient",
  "/sign-in",
  "/signin",
  "/contribution",
  "/admin",
  "usage-monitor-semantic-open-target",
  "usagemonitor://",
]);
const REQUIRED_STATIC_SOCIAL_TAGS = Object.freeze([
  '<meta property="og:type" content="website">',
  '<meta property="og:image:width" content="1200">',
  '<meta property="og:image:height" content="630">',
  '<meta name="twitter:card" content="summary_large_image">',
]);
const RELEASE_ARCHITECTURE = "arm64";
const RELEASE_PRODUCT_NAME = PRODUCT_BRAND.displayName;
const RELEASE_SOURCE_REPOSITORY =
  "https://github.com/adamallcock/tibotattle";
const RELEASE_EVIDENCE_MACOS_NATIVE_ASSURANCES =
  RELEASE_EVIDENCE_PLATFORM_ASSURANCES.macos.direct;

function releaseEvidenceErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/build-public-release-site.js \\",
    "    --output /absolute/output/directory \\",
    "    --site-url https://approved.example/ \\",
    "    --release-notes-url https://approved.example/releases/1.2.3 \\",
    "    --privacy-url https://approved.example/privacy \\",
    "    --security-url https://approved.example/security \\",
    "    --support-url https://approved.example/support \\",
    "    --social-image /absolute/path/to/1200x630.png \\",
    "    [--installer-release-manifest /absolute/path/to/UsageMonitor.dmg.release.json \\",
    "     --installer-path /absolute/path/to/UsageMonitor.dmg \\",
    "     --installer-url https://downloads.approved.example/UsageMonitor.dmg \\",
    "     --installer-version 1.2.3 \\",
    "     --installer-sha256 <64 lowercase hex> \\",
    "     --minimum-macos 14.0 --architectures arm64]",
    "    [--intel-installer-path /absolute/path/to/TiboTattle-1.2.3-macOS-x64.dmg \\",
    "     --intel-installer-url https://downloads.approved.example/TiboTattle-1.2.3-macOS-x64.dmg \\",
    "     --intel-minimum-macos 14.0]",
    "    Intel requires the same canonical cross-platform release manifest as Apple silicon.",
    "    [--replace]",
  ].join("\n");
}

export function parseArgs(argv) {
  const parsed = { replace: false, source: DEFAULT_SOURCE };
  const keys = {
    "--output": "output",
    "--source": "source",
    "--site-url": "siteUrl",
    "--installer-path": "installerPath",
    "--installer-release-manifest": "installerReleaseManifest",
    "--installer-url": "installerUrl",
    "--installer-version": "installerVersion",
    "--installer-sha256": "installerSha256",
    "--minimum-macos": "minimumMacos",
    "--architectures": "architectures",
    "--intel-installer-path": "intelInstallerPath",
    "--intel-installer-url": "intelInstallerUrl",
    "--intel-minimum-macos": "intelMinimumMacos",
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

// A configured public download URL can legitimately redirect (for example,
// from a GitHub Release to object storage). Each hop must nevertheless remain
// public HTTPS. Query parameters are allowed here because signed object-store
// redirects use them; the configured, visible URL itself stays stable.
function validatedPublishedInstallerUrl(raw, base = undefined) {
  let selected;
  try {
    selected = new URL(raw, base);
  } catch {
    throw new TypeError("Published installer redirect is not a valid URL");
  }
  if (selected.protocol !== "https:"
      || !selected.hostname
      || selected.username
      || selected.password
      || selected.port
      || selected.hash
      || rejectedPublicHostname(selected.hostname)) {
    throw new TypeError(
      "Published installer redirects must remain credential-free public HTTPS",
    );
  }
  return selected;
}

/**
 * A local DMG and its signed release manifest are necessary but insufficient:
 * the public URL must serve those exact bytes before the landing page may call
 * it a signed installer. Stream and hash the remote artifact rather than
 * trusting a content-length, a filename, or a caller-provided URL.
 */
export async function verifyPublishedInstallerRemote({
  installerUrl,
  expectedBytes,
  expectedSha256,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Published installer verification requires fetch support");
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1
      || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new TypeError("Published installer verification received invalid signed evidence");
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    INSTALLER_FETCH_TIMEOUT_MS,
  );
  let target = validatedPublishedInstallerUrl(installerUrl);
  try {
    for (let redirects = 0; redirects <= MAXIMUM_INSTALLER_REDIRECTS; redirects += 1) {
      let response;
      try {
        response = await fetchImpl(target, {
          headers: { Accept: "application/octet-stream" },
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error("Published installer verification timed out");
        }
        throw new Error(
          `Published installer could not be fetched for verification: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        if (redirects === MAXIMUM_INSTALLER_REDIRECTS) {
          throw new Error("Published installer exceeded the redirect limit");
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("Published installer redirect omitted its location");
        }
        target = validatedPublishedInstallerUrl(location, target);
        continue;
      }
      if (!response.ok || !response.body) {
        throw new Error(
          `Published installer verification returned HTTP ${response.status}`,
        );
      }
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        const declaredBytes = Number(declaredLength);
        if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)
            || !Number.isSafeInteger(declaredBytes)
            || declaredBytes !== expectedBytes) {
          throw new Error("Published installer byte length does not match signed evidence");
        }
      }
      const hash = createHash("sha256");
      let receivedBytes = 0;
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        receivedBytes += bytes.length;
        if (receivedBytes > expectedBytes) {
          throw new Error("Published installer exceeds the signed byte length");
        }
        hash.update(bytes);
      }
      const receivedSha256 = hash.digest("hex");
      if (receivedBytes !== expectedBytes || receivedSha256 !== expectedSha256) {
        throw new Error("Published installer digest does not match signed evidence");
      }
      return Object.freeze({
        bytes: receivedBytes,
        finalUrl: target.href,
        sha256: receivedSha256,
      });
    }
    throw new Error("Published installer could not be resolved");
  } finally {
    clearTimeout(timeout);
  }
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
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError(`Release-site build options are required\n${usage()}`);
  }
  const required = [
    "output",
    "siteUrl",
    "releaseNotesUrl",
    "privacyUrl",
    "securityUrl",
    "supportUrl",
    "socialImage",
  ];
  if (required.some((key) => !args[key])) {
    throw new TypeError(`Site metadata and artifact paths are incomplete\n${usage()}`);
  }
  const installerConfigured = INSTALLER_OPTION_KEYS.some((key) => {
    const value = args[key];
    return value !== undefined && value !== null && value !== "";
  });
  const intelInstallerConfigured = INTEL_INSTALLER_OPTION_KEYS.some((key) =>
    args[key] !== undefined && args[key] !== null && args[key] !== "");
  if (intelInstallerConfigured && (!installerConfigured
      || INTEL_INSTALLER_OPTION_KEYS.some((key) => !args[key]))) {
    throw new TypeError("Intel installer metadata requires the Apple silicon release and complete Intel artifact metadata");
  }
  if (intelInstallerConfigured && (!isAbsolute(args.intelInstallerPath)
      || !/^(?:1[0-9]|[2-9][0-9])\.(?:0|[1-9][0-9]?)(?:\.(?:0|[1-9][0-9]?))?$/u.test(args.intelMinimumMacos))) {
    throw new TypeError("Intel installer path must be absolute and minimum macOS must be canonical");
  }
  const requiredInstallerMetadata = [
    "installerReleaseManifest",
    "installerUrl",
    "installerVersion",
    "minimumMacos",
    "architectures",
  ];
  if (installerConfigured
      && requiredInstallerMetadata.some((key) => !args[key])) {
    throw new TypeError(
      `Installer metadata requires an exact signed macOS release manifest and complete metadata\n${usage()}`,
    );
  }
  if (!isAbsolute(args.output) || !isAbsolute(args.socialImage)) {
    throw new TypeError(
      "--output and --social-image must be absolute paths",
    );
  }
  const source = resolve(args.source ?? DEFAULT_SOURCE);
  const output = resolve(args.output);
  const installerPath = args.installerPath ? resolve(args.installerPath) : null;
  const installerReleaseManifest = args.installerReleaseManifest
    ? resolve(args.installerReleaseManifest)
    : null;
  const socialImage = resolve(args.socialImage);
  const intelInstaller = intelInstallerConfigured ? {
    installerPath: resolve(args.intelInstallerPath),
    installerUrl: validatedPublicHttpsUrl(args.intelInstallerUrl, "Intel installer URL", { requiredSuffix: ".dmg" }),
    installerVersion: args.installerVersion,
    minimumMacos: args.intelMinimumMacos,
    architectures: ["x64"],
    architecturesText: "x64",
  } : null;
  const releaseInputs = [installerPath, installerReleaseManifest, intelInstaller?.installerPath].filter(Boolean);
  if (output === source
      || output === REPOSITORY_ROOT
      || output === homedir()
      || output === parse(output).root
      || isWithin(output, source)
      || isWithin(source, output)
      || releaseInputs.some((path) => isWithin(output, path))
      || isWithin(output, socialImage)) {
    throw new TypeError(
      "Output cannot replace or contain the source, repository, home, or release inputs",
    );
  }
  if (releaseInputs.some((path) => isWithin(source, path))
      || isWithin(source, socialImage)) {
    throw new TypeError(
      "Release and social preview inputs must stay outside the copied public source",
    );
  }
  if (extname(socialImage).toLowerCase() !== ".png") {
    throw new TypeError("Social preview must be a PNG file");
  }
  const siteUrl = validatedPublicHttpsUrl(args.siteUrl, "Site URL", {
    requireTrailingSlash: true,
  });
  const options = {
    source,
    output,
    installerPath,
    installerReleaseManifest,
    socialImage,
    siteUrl,
    socialImageUrl: new URL(SOCIAL_PREVIEW_FILENAME, siteUrl).href,
    releaseNotesUrl: validatedPublicHttpsUrl(
      args.releaseNotesUrl,
      "Release notes URL",
    ),
    privacyUrl: validatedPublicHttpsUrl(args.privacyUrl, "Privacy URL"),
    securityUrl: validatedPublicHttpsUrl(args.securityUrl, "Security URL"),
    supportUrl: validatedPublicHttpsUrl(args.supportUrl, "Support URL"),
    replace: args.replace,
    installerConfigured,
    intelInstaller,
  };
  if (!installerConfigured) return options;

  if (args.installerPath && !isAbsolute(args.installerPath)) {
    throw new TypeError("--installer-path must be an absolute path when supplied");
  }
  if (!isAbsolute(args.installerReleaseManifest)) {
    throw new TypeError("--installer-release-manifest must be an absolute path");
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u.test(args.installerVersion)) {
    throw new TypeError("Installer version must be a numeric three- or four-part version");
  }
  if (args.installerSha256 !== undefined
      && !/^[a-f0-9]{64}$/u.test(args.installerSha256)) {
    throw new TypeError("Installer SHA-256 must be exactly 64 lowercase hexadecimal characters");
  }
  if (!/^(?:1[0-9]|[2-9][0-9])\.(?:0|[1-9][0-9]?)(?:\.(?:0|[1-9][0-9]?))?$/u
    .test(args.minimumMacos)) {
    throw new TypeError("Minimum macOS must be a canonical version such as 14.0");
  }
  const architectures = normalizedArchitectures(args.architectures);
  return {
    ...options,
    installerUrl: validatedPublicHttpsUrl(
      args.installerUrl,
      "Installer URL",
      { requiredSuffix: ".dmg" },
    ),
    installerVersion: args.installerVersion,
    installerSha256: args.installerSha256 ?? null,
    minimumMacos: args.minimumMacos,
    architectures,
    architecturesText: architectures.join(","),
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

/**
 * Resolve the path boundaries used by a site build before any source copy or
 * replacement. macOS exposes /var as a compatibility symlink to /private/var;
 * that one system alias is permitted, while an operator-supplied symlinked
 * root or ancestor is rejected. The returned canonical path is used only for
 * containment checks; the original path remains the I/O spelling so /var
 * callers continue to work.
 */
async function canonicalReleasePath(path, label, {
  directory = false,
  allowMissing = false,
} = {}) {
  const selected = resolve(path);
  const root = parse(selected).root;
  const components = selected.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new TypeError(`${label} cannot be inspected`);
      }
      if (!allowMissing || directory) {
        throw new TypeError(`${label} does not exist or cannot be inspected`);
      }
      let existingParent = dirname(current);
      while (true) {
        try {
          const canonicalParent = await realpath(existingParent);
          return join(canonicalParent, ...components.slice(index));
        } catch (parentError) {
          if (parentError?.code !== "ENOENT") {
            throw new TypeError(`${label} has no safe existing parent`);
          }
          const nextParent = dirname(existingParent);
          if (nextParent === existingParent) {
            throw new TypeError(`${label} has no safe existing parent`);
          }
          existingParent = nextParent;
        }
      }
    }
    // /var is the only expected system alias on macOS. All other symlinked
    // components make lexical containment checks unreliable.
    if (metadata.isSymbolicLink() && current !== "/var") {
      throw new TypeError(`${label} must not traverse a symbolic link`);
    }
    if (index === components.length - 1
        && directory
        && !metadata.isDirectory()) {
      throw new TypeError(`${label} must be a directory`);
    }
  }
  try {
    return await realpath(selected);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      let existingParent = dirname(selected);
      while (true) {
        try {
          return join(await realpath(existingParent), basename(selected));
        } catch (parentError) {
          if (parentError?.code !== "ENOENT") {
            throw new TypeError(`${label} cannot be resolved safely`);
          }
          const nextParent = dirname(existingParent);
          if (nextParent === existingParent) {
            throw new TypeError(`${label} cannot be resolved safely`);
          }
          existingParent = nextParent;
        }
      }
    }
    throw new TypeError(`${label} cannot be resolved safely`);
  }
}

async function assertReleaseSitePathBoundaries(options) {
  const source = await canonicalReleasePath(options.source, "Public source", {
    directory: true,
  });
  const output = await canonicalReleasePath(options.output, "Release output", {
    allowMissing: true,
  });
  const socialImage = await canonicalReleasePath(
    options.socialImage,
    "Social preview",
  );
  const installerPath = options.installerPath === null
    ? null
    : await canonicalReleasePath(options.installerPath, "Installer artifact");
  const installerManifest = options.installerReleaseManifest === null
    ? null
    : await canonicalReleasePath(
      options.installerReleaseManifest,
      "Installer release manifest",
    );
  const intelInstallerPath = options.intelInstaller === null ? null
    : await canonicalReleasePath(options.intelInstaller.installerPath, "Intel installer artifact");
  const releaseInputs = [installerPath, installerManifest, intelInstallerPath].filter(Boolean);
  if (output === source
      || isWithin(output, source)
      || isWithin(source, output)
      || releaseInputs.some((path) => isWithin(output, path))
      || isWithin(output, socialImage)
      || releaseInputs.some((path) => isWithin(source, path))
      || isWithin(source, socialImage)) {
    throw new TypeError(
      "Release paths must remain outside the canonical public source and output boundaries",
    );
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

function canonicalPageUrl(siteUrl, sourceBasename) {
  if (!Object.hasOwn(PUBLIC_PAGE_ROUTE_BY_SOURCE_BASENAME, sourceBasename)) {
    throw new TypeError(
      `Public source page has no reviewed canonical route: ${sourceBasename}`,
    );
  }
  return new URL(PUBLIC_PAGE_ROUTE_BY_SOURCE_BASENAME[sourceBasename], siteUrl).href;
}

function canonicalMetadataCounts(html) {
  return {
    canonical: [...html.matchAll(
      /<link\b[^>]*\brel\s*=\s*(?:"canonical"|'canonical'|canonical)(?=\s|\/?>)/giu,
    )].length,
    openGraphUrl: [...html.matchAll(
      /<meta\b[^>]*\bproperty\s*=\s*(?:"og:url"|'og:url'|og:url)(?=\s|\/?>)/giu,
    )].length,
  };
}

function assertCanonicalMetadata(html, canonicalUrl, label, ErrorType = TypeError) {
  const expectedCanonical =
    `<link rel="canonical" href="${htmlAttribute(canonicalUrl)}">`;
  const expectedOpenGraphUrl =
    `<meta property="og:url" content="${htmlAttribute(canonicalUrl)}">`;
  const counts = canonicalMetadataCounts(html);
  if (counts.canonical !== 1
      || counts.openGraphUrl !== 1
      || !html.includes(expectedCanonical)
      || !html.includes(expectedOpenGraphUrl)) {
    throw new ErrorType(
      `${label} must contain exactly one generated canonical and Open Graph URL`,
    );
  }
}

function injectCanonicalMetadata(
  html,
  canonicalUrl,
  label,
  { requireSlots = false } = {},
) {
  const canonicalSlot = '<link rel="canonical" href="">';
  const openGraphUrlSlot = '<meta property="og:url" content="">';
  const hasCanonicalSlot = html.includes(canonicalSlot);
  const hasOpenGraphUrlSlot = html.includes(openGraphUrlSlot);
  let output = html;
  if (hasCanonicalSlot || hasOpenGraphUrlSlot) {
    if (!hasCanonicalSlot || !hasOpenGraphUrlSlot) {
      throw new TypeError(
        `${label} must expose canonical and Open Graph URL slots together`,
      );
    }
    output = replaceExactlyOnce(
      output,
      canonicalSlot,
      `<link rel="canonical" href="${htmlAttribute(canonicalUrl)}">`,
      "empty canonical link",
    );
    output = replaceExactlyOnce(
      output,
      openGraphUrlSlot,
      `<meta property="og:url" content="${htmlAttribute(canonicalUrl)}">`,
      "empty Open Graph URL",
    );
  } else {
    if (requireSlots) {
      throw new TypeError(
        `${label} must expose empty canonical and Open Graph URL slots`,
      );
    }
    const counts = canonicalMetadataCounts(output);
    if (counts.canonical !== 0 || counts.openGraphUrl !== 0) {
      throw new TypeError(
        `${label} must not hard-code canonical or Open Graph URLs`,
      );
    }
    const closingHead = output.match(/(^|\n)([\t ]*)<\/head>/u);
    const indentation = closingHead?.[2] ?? "";
    const closingHeadToken = closingHead
      ? `${indentation}</head>`
      : "</head>";
    output = replaceExactlyOnce(
      output,
      closingHeadToken,
      [
        `${indentation}  <link rel="canonical" href="${htmlAttribute(canonicalUrl)}">`,
        `${indentation}  <meta property="og:url" content="${htmlAttribute(canonicalUrl)}">`,
        `${indentation}</head>`,
      ].join("\n"),
      `closing </head> tag for ${label}`,
    );
  }
  assertCanonicalMetadata(output, canonicalUrl, label);
  return output;
}

function injectReleaseMetadata(html, values, canonicalUrl) {
  let output = html;
  for (const [name, valueKey] of Object.entries(SITE_META)) {
    const token = `<meta name="${name}" content="">`;
    output = replaceExactlyOnce(
      output,
      token,
      `<meta name="${name}" content="${htmlAttribute(values[valueKey])}">`,
      `empty ${name} meta tag`,
    );
  }
  for (const [name, valueKey] of Object.entries(INSTALLER_META)) {
    const token = `<meta name="${name}" content="">`;
    output = replaceExactlyOnce(
      output,
      token,
      values.installerConfigured
        ? `<meta name="${name}" content="${htmlAttribute(values[valueKey])}">`
        : "",
      values.installerConfigured
        ? `empty ${name} meta tag`
        : `empty ${name} no-installer metadata slot`,
    );
    const intelName = name.replace("usage-monitor-", "usage-monitor-intel-");
    output = replaceExactlyOnce(
      output,
      `<meta name="${intelName}" content="">`,
      values.intelInstaller
        ? `<meta name="${intelName}" content="${htmlAttribute(values.intelInstaller[valueKey])}">`
        : "",
      `empty ${intelName} meta tag`,
    );
  }
  for (const token of REQUIRED_STATIC_SOCIAL_TAGS) {
    if (output.split(token).length - 1 !== 1) {
      throw new TypeError(`Source must contain exactly one ${token}`);
    }
  }
  for (const [token, replacement, label] of [
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
  return injectCanonicalMetadata(
    output,
    canonicalUrl,
    "Public community entry",
    { requireSlots: true },
  );
}

function publicPageSourceBasenames(source, publicSourceFiles) {
  const selectedNames = new Set(publicSourceFiles.map((sourceFile) =>
    relativePublicSourceName(source, sourceFile)));
  return [
    SITE_INDEX_SOURCE_BASENAME,
    ...PUBLIC_AUXILIARY_PAGE_BASENAMES.filter((basename) =>
      selectedNames.has(basename)),
  ];
}

function xmlText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderSitemap(canonicalUrls) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...canonicalUrls.map((url) => `  <url><loc>${xmlText(url)}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
}

function renderRobots(siteUrl) {
  return [
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${new URL(SITEMAP_FILENAME, siteUrl).href}`,
    "",
  ].join("\n");
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

function localPublicReferences(
  source,
  { allowEntryModule = false, css = false } = {},
) {
  const candidates = css
    ? [...source.matchAll(
      /url\(\s*["']?\.\/([^"'()?#]+)(?:[?#][^"'()]*)?["']?\s*\)/gu,
    )].map((match) => match[1])
    : [...source.matchAll(
      /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu,
    )]
      .map((match) => match[1] ?? match[2] ?? match[3])
      .filter((value) => value.startsWith("./"))
      .map((value) => value.slice(2).split(/[?#]/u, 1)[0]);
  const references = new Set();
  for (const name of candidates) {
    if (!name
        || name.includes("/")
        || name.includes("\\")
        || ![".css", ".html", ".ico", ".jpeg", ".jpg", ".js", ".png", ".svg", ".webp"]
          .includes(extname(name).toLowerCase())) {
      throw new TypeError(`Public source contains an unreviewed local reference: ${name}`);
    }
    const extension = extname(name).toLowerCase();
    if (extension === ".js"
        && (!allowEntryModule || name !== SITE_ENTRY_MODULE_BASENAME)) {
      throw new TypeError(`Public HTML may load only ${SITE_ENTRY_MODULE_BASENAME}`);
    }
    if (extension === ".html"
        && name !== SITE_INDEX_SOURCE_BASENAME
        && !PUBLIC_AUXILIARY_PAGE_BASENAMES.includes(name)) {
      throw new TypeError(`Public source contains an unreviewed HTML page: ${name}`);
    }
    if (APP_ONLY_SOURCE_BASENAMES.includes(name)) {
      throw new TypeError(`Public source references an app-only asset: ${name}`);
    }
    references.add(name);
  }
  return references;
}

function relativePublicSourceName(sourceRoot, sourcePath) {
  return relative(sourceRoot, sourcePath).split(sep).join("/");
}

/**
 * The mixed web source intentionally contains the loopback dashboard beside
 * the public entry. Only the selected public closure may be copied. Check the
 * closure before creating the output directory so a failed build cannot leave
 * a deployable partial site containing a local client module.
 */
function assertPublicClosureHasNoDashboardSource(sourceRoot, sourceFiles) {
  for (const sourceFile of sourceFiles) {
    const relativeName = relativePublicSourceName(sourceRoot, sourceFile);
    if (APP_ONLY_SOURCE_BASENAMES.includes(parse(relativeName).base)) {
      throw new TypeError(
        `Public release closure contains dashboard-only source: ${relativeName}`,
      );
    }
  }
}

function assertNoForbiddenPublicReferences(contents, label, errorType = Error) {
  for (const marker of PUBLIC_ROUTE_MARKERS) {
    if (contents.includes(marker)) {
      throw new errorType(
        `${label} referenced a local-only route or control: ${marker}`,
      );
    }
  }
}

/**
 * Select the exact public closure, rather than copying the mixed web source
 * directory. HTML and CSS references are constrained locally; JavaScript is
 * resolved through the same static module-graph checker used by the sealed
 * macOS client. This makes both accidental app-client imports and symlink
 * escapes release-time failures.
 */
function renderAuxiliaryPublicHtml(sourceHtml) {
  return sourceHtml.replace(
    /\bhref\s*=\s*(?:"(\.\/community\.html(?:[?#][^"]*)?)"|'(\.\/community\.html(?:[?#][^']*)?)'|(\.\/community\.html(?:[?#][^\s"'=<>`]*)?))/gu,
    (_attribute, doubleQuoted, singleQuoted, unquoted) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted;
      const rendered = value.replace("./community.html", "./index.html");
      if (doubleQuoted !== undefined) return `href="${rendered}"`;
      if (singleQuoted !== undefined) return `href='${rendered}'`;
      return `href=${rendered}`;
    },
  );
}

function assertStaticAuxiliaryPublicHtml(sourceHtml, basename) {
  if (/<script\b/iu.test(sourceHtml)) {
    throw new TypeError(
      `Public auxiliary page must be static and script-free: ${basename}`,
      );
  }
}
async function collectPublicSourceFiles({ source, sourceHtml }) {
  const sourceParent = dirname(source);
  const entrypoint = `${relative(sourceParent, source).split(sep).join("/")}/${SITE_ENTRY_MODULE_BASENAME}`;
  const moduleGraph = await collectMacOSWebModuleGraph({
    allowedRoot: source,
    entrypoints: [entrypoint],
    repositoryRoot: sourceParent,
  });
  const files = new Set(moduleGraph.files.map((file) => resolve(file)));
  const pending = [
    ...localPublicReferences(sourceHtml, { allowEntryModule: true }),
  ];
  const inspected = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (inspected.has(name)) continue;
    inspected.add(name);
    if (name === SITE_INDEX_SOURCE_BASENAME) continue;
    const path = resolve(join(source, name));
    await regularFile(path, `Referenced public source ${name}`);
    files.add(path);
    if (extname(name).toLowerCase() === ".css") {
      const css = await readFile(path, "utf8");
      if (/@import\b/u.test(css)) {
        throw new TypeError("Public CSS imports must be bundled before release");
      }
      pending.push(...localPublicReferences(css, { css: true }));
    } else if (extname(name).toLowerCase() === ".html") {
      const html = await readFile(path, "utf8");
      assertStaticAuxiliaryPublicHtml(html, name);
      pending.push(...localPublicReferences(html));
    }
  }
  return [...files].sort((left, right) =>
    relative(source, left).localeCompare(relative(source, right)));
}

async function digestInstallerFile(path) {
  try {
    const digest = await digestRegularFile(path, "Installer artifact");
    return {
      path: digest.path,
      bytes: digest.bytes,
      sha256: digest.sha256,
    };
  } catch (error) {
    throw new TypeError(
      `Installer artifact could not be read: ${releaseEvidenceErrorMessage(error)}`,
    );
  }
}

async function verifyPublishedSourceClosure({
  source,
  output,
  sourceProvenance,
  releaseValues,
  releaseHtml,
  canonicalUrlBySourceBasename,
}) {
  for (const expected of sourceProvenance.files) {
    const sourcePath = resolve(source, expected.path);
    const extension = extname(expected.path).toLowerCase();
    let sourceDigest;
    let rendered = null;
    if (extension === ".html") {
      const sourceText = await readTextFile(
        sourcePath,
        `Public release source ${expected.path}`,
        RELEASE_EVIDENCE_MAX_MANIFEST_BYTES,
        source,
      );
      sourceDigest = sourceText;
      const canonicalUrl = canonicalUrlBySourceBasename.get(expected.path);
      if (canonicalUrl === undefined) {
        throw new TypeError(
          `Public source page has no generated canonical URL: ${expected.path}`,
        );
      }
      rendered = expected.path === SITE_INDEX_SOURCE_BASENAME
        ? injectReleaseMetadata(sourceText.text, releaseValues, canonicalUrl)
        : injectCanonicalMetadata(
          renderAuxiliaryPublicHtml(sourceText.text),
          canonicalUrl,
          `Public auxiliary page ${expected.path}`,
        );
      if (expected.path === SITE_INDEX_SOURCE_BASENAME
          && rendered !== releaseHtml) {
        throw new TypeError(
          "Public release source changed while its rendered entry was prepared",
        );
      }
    } else {
      sourceDigest = await digestRegularFile(
        sourcePath,
        `Public release source ${expected.path}`,
        null,
        source,
      );
    }
    if (sourceDigest.bytes !== expected.bytes
        || sourceDigest.sha256 !== expected.sha256) {
      throw new TypeError(
        `Public release source changed after provenance capture: ${expected.path}`,
      );
    }
    const outputName = expected.path === SITE_INDEX_SOURCE_BASENAME
      ? "index.html"
      : expected.path;
    const outputPath = resolve(output, outputName);
    const outputDigest = await digestRegularFile(
      outputPath,
      `Published public release source ${outputName}`,
      null,
      output,
    );
    const expectedOutput = rendered === null
      ? sourceDigest
      : {
        bytes: Buffer.byteLength(rendered, "utf8"),
        sha256: createHash("sha256").update(rendered, "utf8").digest("hex"),
      };
    if (outputDigest.bytes !== expectedOutput.bytes
        || outputDigest.sha256 !== expectedOutput.sha256) {
      throw new TypeError(
        `Published public release source does not match the captured closure: ${outputName}`,
      );
    }
  }
}

async function readReleaseManifestJson(path) {
  let value;
  try {
    value = (await readJsonFile(
      path,
      "release-manifest.json",
      RELEASE_EVIDENCE_MAX_MANIFEST_BYTES,
    )).value;
  } catch (error) {
    // Preserve the legacy validator's established diagnostics for old
    // receipts and malformed inputs. New evidence manifests are selected by
    // schemaVersion below and validated by their canonical validator.
    if (error?.code === "RELEASE_EVIDENCE_JSON_INVALID") return null;
    throw new TypeError(
      `Installer release manifest could not be read: ${releaseEvidenceErrorMessage(error)}`,
    );
  }
  if (value?.schemaVersion !== RELEASE_EVIDENCE_SCHEMA_VERSION) return null;
  await validateReleaseEvidenceManifest(value, {
    artifactRoot: dirname(path),
    manifestPath: path,
  });
  return value;
}

function assertMacOSReleaseEvidenceTrust(artifact) {
  for (const assurance of RELEASE_EVIDENCE_MACOS_NATIVE_ASSURANCES) {
    if (artifact.assurances?.[assurance] !== true) {
      throw new TypeError(
        `Cross-platform release manifest is missing required macOS assurance: ${assurance}`,
      );
    }
  }
  const signerIdentity = artifact.nativeTrust?.signerIdentity;
  const teamId = artifact.nativeTrust?.teamId;
  if (typeof signerIdentity !== "string"
      || !/^Developer ID Application:\s*\S/u.test(signerIdentity)
      || typeof teamId !== "string"
      || !/^[A-Z0-9]{10}$/u.test(teamId)) {
    throw new TypeError(
      "Cross-platform release manifest does not identify a valid macOS Developer ID signer",
    );
  }
}

function assertMacOSNativeValidationMatches(artifact, validation) {
  const authority = validation?.developerIdAuthority;
  const teamIdentifier = validation?.teamIdentifier;
  if (typeof authority !== "string"
      || typeof teamIdentifier !== "string"
      || artifact.nativeTrust?.signerIdentity !== authority
      || artifact.nativeTrust?.teamId !== teamIdentifier) {
    throw new TypeError(
      "macOS native validation does not match the cross-platform release signer",
    );
  }
}

function installerUrlFileName(installerUrl) {
  let pathname;
  try {
    pathname = new URL(installerUrl).pathname;
    return decodeURIComponent(pathname.split("/").at(-1) ?? "");
  } catch {
    throw new TypeError("Installer URL contains an invalid encoded artifact name");
  }
}

async function validateCrossPlatformReleaseArtifact({
  releaseManifestPath,
  releaseManifest: suppliedReleaseManifest = null,
  artifactPath,
  installerUrl,
  installerVersion,
  installerSha256,
  validateArtifact,
  architecture = "arm64",
  minimumMacos = null,
  requireSourceMatch = false,
}) {
  if (artifactPath === null) {
    throw new TypeError(
      "Cross-platform release manifests require an explicit local installer artifact",
    );
  }
  const releaseManifest = suppliedReleaseManifest
    ?? await readReleaseManifestJson(releaseManifestPath);
  if (releaseManifest === null) {
    throw new TypeError("Expected a cross-platform release evidence manifest");
  }
  if (releaseManifest.product?.name !== RELEASE_PRODUCT_NAME
      || releaseManifest.repository !== RELEASE_SOURCE_REPOSITORY
      || releaseManifest.tag !== `v${installerVersion}`) {
    throw new TypeError(
      "Cross-platform release manifest is not the exact TiboTattle tagged release",
    );
  }
  const candidates = releaseManifest.artifacts.filter((artifact) =>
    artifact.platform === "macos"
      && artifact.channel === "direct"
      && artifact.architecture === architecture
      && artifact.format === "dmg");
  if (candidates.length !== 1) {
    throw new TypeError(
      `Cross-platform release manifest must contain exactly one macOS direct ${architecture} DMG (found ${candidates.length})`,
    );
  }
  const selected = candidates[0];
  if (architecture === "x64" && selected.fileName !== `TiboTattle-${installerVersion}-macOS-x64.dmg`) {
    throw new TypeError("Intel release artifact must use the canonical macOS-x64 DMG filename");
  }
  if (releaseManifest.version !== installerVersion
      || selected.version !== installerVersion) {
    throw new TypeError(
      "Installer version does not match the cross-platform release manifest",
    );
  }
  if (selected.fileName !== installerUrlFileName(installerUrl)
      || selected.downloadUrl !== installerUrl) {
    throw new TypeError(
      "Installer URL does not match the canonical cross-platform release artifact",
    );
  }
  const localArtifact = await digestInstallerFile(artifactPath);
  if (localArtifact.bytes !== selected.bytes
      || localArtifact.sha256 !== selected.sha256) {
    throw new TypeError(
      "Installer artifact does not match the cross-platform release manifest",
    );
  }
  if (installerSha256 !== null && installerSha256 !== localArtifact.sha256) {
    throw new TypeError(
      "Installer SHA-256 does not match the cross-platform release manifest",
    );
  }
  assertMacOSReleaseEvidenceTrust(selected);
  const nativeValidation = await validateArtifact(localArtifact.path, {
    architecture,
    expectedShortVersion: installerVersion,
    production: true,
  });
  assertMacOSNativeValidationMatches(selected, nativeValidation);
  if (architecture === "x64" || requireSourceMatch) {
    if (nativeValidation.architecture !== architecture
        || nativeValidation.minimumMacos !== minimumMacos
        || nativeValidation.source?.commit !== releaseManifest.commit
        || nativeValidation.source?.tag !== releaseManifest.tag) {
      throw new TypeError("macOS native architecture, minimum OS, or source does not match the release metadata");
    }
  }
  const finalArtifact = await digestInstallerFile(localArtifact.path);
  if (finalArtifact.bytes !== selected.bytes
      || finalArtifact.sha256 !== selected.sha256) {
    throw new TypeError(
      "Installer artifact changed after native validation",
    );
  }
  return Object.freeze({
    artifact: Object.freeze(finalArtifact),
    manifest: Object.freeze({
      schemaVersion: releaseManifest.schemaVersion,
      version: releaseManifest.version,
      tag: releaseManifest.tag,
      commit: releaseManifest.commit,
      repository: releaseManifest.repository,
      application: Object.freeze({ shortVersion: releaseManifest.version }),
      artifact: Object.freeze({
        fileName: selected.fileName,
        bytes: selected.bytes,
        sha256: selected.sha256,
      }),
      evidencePresence: Object.freeze({
        sbom: selected.sbom !== null,
        provenance: selected.provenance !== null,
        sbomAttestation: selected.sbom?.attestation != null,
      }),
    }),
  });
}

export async function buildPublicReleaseSite(rawArgs, {
  validateInstallerArtifact = validateMacOSDMG,
  verifyPublishedInstaller = verifyPublishedInstallerRemote,
} = {}) {
  if (typeof validateInstallerArtifact !== "function") {
    throw new TypeError("validateInstallerArtifact must be a function");
  }
  if (typeof verifyPublishedInstaller !== "function") {
    throw new TypeError("verifyPublishedInstaller must be a function");
  }
  const options = validateInputs(rawArgs);
  await assertReleaseSitePathBoundaries(options);
  const sourceIndex = join(options.source, SITE_INDEX_SOURCE_BASENAME);
  await regularFile(
    sourceIndex,
    `Release-site index source ${SITE_INDEX_SOURCE_BASENAME}`,
  );
  const sourceHtml = await readFile(sourceIndex, "utf8");
  // Reject unsupported source entries before selecting the public closure.
  // A symlink or special file may not hide alongside an otherwise valid entry.
  await fileManifest(options.source);
  const publicSourceFiles = await collectPublicSourceFiles({
    source: options.source,
    sourceHtml,
  });
  const sourceProvenance = await createPublicReleaseSourceProvenance({
    repositoryRoot: REPOSITORY_ROOT,
    sourceRoot: options.source,
    sourceFiles: [...new Set([sourceIndex, ...publicSourceFiles])],
  });
  const publicPageSources = publicPageSourceBasenames(
    options.source,
    publicSourceFiles,
  );
  const canonicalUrlBySourceBasename = new Map(
    publicPageSources.map((basename) => [
      basename,
      canonicalPageUrl(options.siteUrl, basename),
    ]),
  );
  const canonicalPageUrls = [...canonicalUrlBySourceBasename.values()];
  assertPublicClosureHasNoDashboardSource(options.source, publicSourceFiles);
  for (const sourceFile of publicSourceFiles) {
    const extension = extname(sourceFile).toLowerCase();
    if (extension === ".css"
        || ![".html", ".js", ".json", ".txt"].includes(extension)) {
      continue;
    }
    assertNoForbiddenPublicReferences(
      await readFile(sourceFile, "utf8"),
      `Public release source ${relativePublicSourceName(options.source, sourceFile)}`,
      TypeError,
    );
  }
  // Check the selected source before any release metadata or output writes.
  // This catches a dashboard shell/control accidentally added to the public
  // entry even when it does not have a recognizable app-only filename.
  assertNoForbiddenPublicReferences(
    sourceHtml,
    `Public release source ${SITE_INDEX_SOURCE_BASENAME}`,
    TypeError,
  );
  let installerEvidence = null;
  let intelInstallerEvidence = null;
  if (options.installerConfigured) {
    // The platform-neutral v1 manifest is the forward path.  A receipt that
    // does not carry that exact schema is deliberately handed to the legacy
    // macOS validator so existing v0.1.12 web-only rebuilds keep working.
    const releaseManifest = await readReleaseManifestJson(
      options.installerReleaseManifest,
    );
    if (options.intelInstaller !== null && releaseManifest === null) {
      throw new TypeError("Intel requires one canonical cross-platform release manifest for both architectures");
    }
    installerEvidence = releaseManifest === null
      ? await validateMacOSSignedReleaseArtifact({
        releaseManifestPath: options.installerReleaseManifest,
        artifactPath: options.installerPath,
        validateArtifact: validateInstallerArtifact,
      })
      : await validateCrossPlatformReleaseArtifact({
        releaseManifestPath: options.installerReleaseManifest,
        releaseManifest,
        artifactPath: options.installerPath,
        installerUrl: options.installerUrl,
        installerVersion: options.installerVersion,
        installerSha256: options.installerSha256,
        validateArtifact: validateInstallerArtifact,
        minimumMacos: options.minimumMacos,
        requireSourceMatch: options.intelInstaller !== null,
      });
    const releaseVersion = installerEvidence.manifest.application.shortVersion;
    if (releaseVersion !== options.installerVersion) {
      throw new TypeError(
        "Installer version does not match the signed macOS release manifest",
      );
    }
    if (!/(?:^|[-_.])arm64(?:[-_.]|$)/u.test(
      installerEvidence.manifest.artifact.fileName,
    )) {
      throw new TypeError(
        "Signed macOS release artifact must be the supported arm64 DMG",
      );
    }
    const installerURL = new URL(options.installerUrl);
    let installerURLFileName;
    try {
      installerURLFileName = decodeURIComponent(
        installerURL.pathname.split("/").at(-1) ?? "",
      );
    } catch {
      throw new TypeError("Installer URL contains an invalid encoded artifact name");
    }
    if (installerURLFileName !== installerEvidence.manifest.artifact.fileName) {
      throw new TypeError(
        "Installer URL artifact name does not match the signed macOS release manifest",
      );
    }
    if (options.installerSha256 !== null
        && options.installerSha256 !== installerEvidence.artifact.sha256) {
      throw new TypeError(
        "Installer SHA-256 does not match the signed macOS release manifest",
      );
    }
    await verifyPublishedInstaller({
      expectedBytes: installerEvidence.artifact.bytes,
      expectedSha256: installerEvidence.artifact.sha256,
      installerUrl: options.installerUrl,
    });
    if (options.intelInstaller !== null) {
      const intel = options.intelInstaller;
      intelInstallerEvidence = await validateCrossPlatformReleaseArtifact({
        releaseManifestPath: options.installerReleaseManifest,
        releaseManifest,
        artifactPath: intel.installerPath,
        installerUrl: intel.installerUrl,
        installerVersion: intel.installerVersion,
        installerSha256: null,
        architecture: "x64",
        minimumMacos: intel.minimumMacos,
        validateArtifact: validateInstallerArtifact,
      });
      await verifyPublishedInstaller({
        expectedBytes: intelInstallerEvidence.artifact.bytes,
        expectedSha256: intelInstallerEvidence.artifact.sha256,
        installerUrl: intel.installerUrl,
      });
    }
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
    installerBytes: installerEvidence?.artifact.bytes ?? null,
    installerSha256: installerEvidence?.artifact.sha256 ?? null,
    intelInstaller: intelInstallerEvidence ? {
      ...options.intelInstaller,
      installerBytes: intelInstallerEvidence.artifact.bytes,
      installerSha256: intelInstallerEvidence.artifact.sha256,
    } : null,
  };
  const releaseHtml = injectReleaseMetadata(
    sourceHtml,
    releaseValues,
    canonicalUrlBySourceBasename.get(SITE_INDEX_SOURCE_BASENAME),
  );

  if (await pathExists(options.output)) {
    if (!options.replace) {
      throw new TypeError("Output already exists; pass --replace to replace this exact directory");
    }
    await rm(options.output, { recursive: true });
  }
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.output, { recursive: true, mode: 0o755 });
  for (const sourceFile of publicSourceFiles) {
    const outputFile = join(
      options.output,
      relative(options.source, sourceFile),
    );
    await mkdir(dirname(outputFile), { recursive: true });
    if (extname(sourceFile).toLowerCase() === ".html") {
      const sourceBasename = relativePublicSourceName(options.source, sourceFile);
      const canonicalUrl = canonicalUrlBySourceBasename.get(sourceBasename);
      if (canonicalUrl === undefined) {
        throw new TypeError(
          `Public source page has no generated canonical URL: ${sourceBasename}`,
        );
      }
      const auxiliaryHtml = injectCanonicalMetadata(
        renderAuxiliaryPublicHtml(await readFile(sourceFile, "utf8")),
        canonicalUrl,
        `Public auxiliary page ${sourceBasename}`,
      );
      await writeFile(outputFile, auxiliaryHtml, {
        encoding: "utf8",
        mode: 0o644,
      });
    } else {
      await copyFile(sourceFile, outputFile);
    }
  }
  await writeFile(join(options.output, "index.html"), releaseHtml, {
    encoding: "utf8",
    mode: 0o644,
  });
  // Keep explicit aliases for hosts that map extensionless `/community` and
  // unknown routes to static HTML files. Both aliases are the public entry;
  // neither may ever fall through to the loopback dashboard source.
  for (const routeFilename of [
    PUBLIC_COMMUNITY_ROUTE_FILENAME,
    PUBLIC_FALLBACK_ROUTE_FILENAME,
  ]) {
    await writeFile(join(options.output, routeFilename), releaseHtml, {
      encoding: "utf8",
      mode: 0o644,
    });
  }
  await writeFile(
    join(options.output, SOCIAL_PREVIEW_FILENAME),
    socialBytes,
    { mode: 0o644 },
  );
  const sitemap = renderSitemap(canonicalPageUrls);
  await writeFile(
    join(options.output, SITEMAP_FILENAME),
    sitemap,
    { encoding: "utf8", mode: 0o644 },
  );
  const robots = renderRobots(options.siteUrl);
  await writeFile(
    join(options.output, ROBOTS_FILENAME),
    robots,
    { encoding: "utf8", mode: 0o644 },
  );
  await verifyPublishedSourceClosure({
    source: options.source,
    output: options.output,
    sourceProvenance,
    releaseValues,
    releaseHtml,
    canonicalUrlBySourceBasename,
  });
  const files = await fileManifest(options.output);
  const publishedNames = new Set(files.map(({ path }) => path));
  // `index.html` is the rendered community entry. Every app-only file must
  // remain absent even if a future selection rule accidentally finds it.
  for (const withheld of APP_ONLY_SOURCE_BASENAMES.filter(
    (name) => name !== "index.html",
  )) {
    if (publishedNames.has(withheld)) {
      throw new Error(
        `Release output published the in-app dashboard surface: ${withheld}`,
      );
    }
  }
  const generatedNames = new Set([
    ...publicSourceFiles.map((sourceFile) =>
      relative(options.source, sourceFile).split(sep).join("/")),
    "index.html",
    PUBLIC_COMMUNITY_ROUTE_FILENAME,
    PUBLIC_FALLBACK_ROUTE_FILENAME,
    ROBOTS_FILENAME,
    SITEMAP_FILENAME,
    SOCIAL_PREVIEW_FILENAME,
  ]);
  for (const publishedName of publishedNames) {
    if (!generatedNames.has(publishedName)) {
      throw new Error(
        `Release output published an unreviewed public asset: ${publishedName}`,
      );
    }
  }
  for (const { path } of files.filter(({ path }) =>
    /\.(?:css|html|js|json|txt)$/u.test(path))) {
    const contents = await readFile(join(options.output, path), "utf8");
    // The shared stylesheet deliberately retains selectors used only by the
    // loopback dashboard; selectors are not served/imported dashboard source
    // and must not make the public community CSS fail closed. Markup and
    // executable/data assets are checked for the actual boundary markers.
    if (!path.endsWith(".css")) {
      assertNoForbiddenPublicReferences(contents, `Release output asset ${path}`);
    }
  }
  const manifest = {
    schemaVersion: PUBLIC_RELEASE_MANIFEST_SCHEMA,
    source: sourceProvenance,
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
      sitemap: {
        path: SITEMAP_FILENAME,
        canonicalUrls: canonicalPageUrls,
      },
    },
    ...(installerEvidence
      ? {
        installer: {
          url: options.installerUrl,
          version: options.installerVersion,
          sha256: installerEvidence.artifact.sha256,
          bytes: installerEvidence.artifact.bytes,
          minimumMacos: options.minimumMacos,
          architectures: options.architectures,
          ...(installerEvidence.manifest.schemaVersion === RELEASE_EVIDENCE_SCHEMA_VERSION
            ? { artifactAndNativeTrustVerified: true }
            : { verifiedSignedReleaseEvidence: true }),
          releaseEvidence: {
            schemaVersion: installerEvidence.manifest.schemaVersion,
            verificationScope: installerEvidence.manifest.schemaVersion === RELEASE_EVIDENCE_SCHEMA_VERSION
              ? ["artifact-bytes", "native-platform-trust"]
              : ["signed-release-manifest", "native-platform-trust"],
            ...(installerEvidence.manifest.schemaVersion === RELEASE_EVIDENCE_SCHEMA_VERSION
              ? {
                evidenceDeclared: installerEvidence.manifest.evidencePresence,
                attestationVerificationPerformedBySiteBuild: false,
              }
              : {}),
          },
        },
      }
      : {}),
    ...(intelInstallerEvidence ? {
      intelInstaller: {
        url: options.intelInstaller.installerUrl,
        version: options.intelInstaller.installerVersion,
        sha256: intelInstallerEvidence.artifact.sha256,
        bytes: intelInstallerEvidence.artifact.bytes,
        minimumMacos: options.intelInstaller.minimumMacos,
        architectures: ["x64"],
        artifactAndNativeTrustVerified: true,
        releaseEvidence: {
          schemaVersion: intelInstallerEvidence.manifest.schemaVersion,
          verificationScope: ["artifact-bytes", "native-platform-trust", "architecture", "minimum-macos", "tagged-source"],
          evidenceDeclared: intelInstallerEvidence.manifest.evidencePresence,
          attestationVerificationPerformedBySiteBuild: false,
        },
      },
    } : {}),
    files,
  };
  await writeFile(
    join(options.output, "release-site-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );

  const verifiedHtml = await readFile(join(options.output, "index.html"), "utf8");
  if (verifiedHtml !== releaseHtml) {
    throw new Error("Release output index did not keep the rendered community entry");
  }
  for (const routeFilename of [
    PUBLIC_COMMUNITY_ROUTE_FILENAME,
    PUBLIC_FALLBACK_ROUTE_FILENAME,
  ]) {
    if (await readFile(join(options.output, routeFilename), "utf8") !== releaseHtml) {
      throw new Error(
        `Release output ${routeFilename} did not keep the rendered community entry`,
      );
    }
  }
  for (const [sourceBasename, canonicalUrl] of canonicalUrlBySourceBasename) {
    const outputFilename = sourceBasename === SITE_INDEX_SOURCE_BASENAME
      ? "index.html"
      : sourceBasename;
    assertCanonicalMetadata(
      await readFile(join(options.output, outputFilename), "utf8"),
      canonicalUrl,
      `Release output ${outputFilename}`,
      Error,
    );
  }
  for (const name of Object.keys(SITE_META)) {
    if (verifiedHtml.includes(`<meta name="${name}" content="">`)) {
      throw new Error(`Release output retained empty ${name} metadata`);
    }
  }
  if (installerEvidence) {
    for (const name of Object.keys(INSTALLER_META)) {
      if (verifiedHtml.includes(`<meta name="${name}" content="">`)) {
        throw new Error(`Release output retained empty ${name} metadata`);
      }
    }
  } else if (Object.keys(INSTALLER_META).some((name) =>
    verifiedHtml.includes(`<meta name="${name}"`))) {
    throw new Error("No-installer release output retained installer metadata");
  }
  for (const name of Object.keys(INSTALLER_META)) {
    const intelName = name.replace("usage-monitor-", "usage-monitor-intel-");
    if (verifiedHtml.includes(`<meta name="${intelName}" content="">`)
        || (!intelInstallerEvidence && verifiedHtml.includes(`<meta name="${intelName}"`))) {
      throw new Error("Release output retained unverified Intel installer metadata");
    }
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
  if (await readFile(join(options.output, SITEMAP_FILENAME), "utf8") !== sitemap) {
    throw new Error("Release output sitemap was not written deterministically");
  }
  return {
    output: options.output,
    site: manifest.site,
    installer: manifest.installer ?? null,
    intelInstaller: manifest.intelInstaller ?? null,
    source: manifest.source,
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
