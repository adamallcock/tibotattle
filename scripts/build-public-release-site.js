#!/usr/bin/env node

import {
  copyFile,
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
  collectMacOSWebModuleGraph,
} from "./build-macos-app.js";
import {
  validateMacOSDMG,
  validateMacOSSignedReleaseArtifact,
} from "./macos-release-core.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_SOURCE = join(REPOSITORY_ROOT, "apps", "web", "public");
const SOCIAL_PREVIEW_FILENAME = "social-preview.png";
const ROBOTS_FILENAME = "robots.txt";
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
    "     --minimum-macos 13.0 --architectures arm64] [--replace]",
  ].join("\n");
}

function parseArgs(argv) {
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
  const releaseInputs = [installerPath, installerReleaseManifest].filter(Boolean);
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
    throw new TypeError("Minimum macOS must be a canonical version such as 13.0");
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

function injectReleaseMetadata(html, values) {
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
  if (options.installerConfigured) {
    installerEvidence = await validateMacOSSignedReleaseArtifact({
      releaseManifestPath: options.installerReleaseManifest,
      artifactPath: options.installerPath,
      validateArtifact: validateInstallerArtifact,
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
  };
  const releaseHtml = injectReleaseMetadata(sourceHtml, releaseValues);

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
      const auxiliaryHtml = renderAuxiliaryPublicHtml(
        await readFile(sourceFile, "utf8"),
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
  const robots = "User-agent: *\nAllow: /\n";
  await writeFile(
    join(options.output, ROBOTS_FILENAME),
    robots,
    { encoding: "utf8", mode: 0o644 },
  );
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
    ...(installerEvidence
      ? {
        installer: {
          url: options.installerUrl,
          version: options.installerVersion,
          sha256: installerEvidence.artifact.sha256,
          bytes: installerEvidence.artifact.bytes,
          minimumMacos: options.minimumMacos,
          architectures: options.architectures,
          verifiedSignedReleaseEvidence: true,
          releaseEvidence: {
            schemaVersion: installerEvidence.manifest.schemaVersion,
            verification: "signed-release-manifest-and-platform-validation",
          },
        },
      }
      : {}),
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
    installer: manifest.installer ?? null,
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
