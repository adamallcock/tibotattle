#!/usr/bin/env node

// Local, generated public-site preview.
//
// This deliberately builds the same closed public-site output used for a
// release, then serves that ephemeral output on loopback. In its default mode
// it reads the *already public* homepage metadata and aggregate community
// series from the reviewed public origin for visual comparison only. It never
// sends cookies, credentials, local dashboard data, or write requests upstream.

import { createServer } from "node:http";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { DEPLOYMENT_ENDPOINTS } from "../config/deployment-endpoints.js";
import { buildPublicReleaseSite } from "./build-public-release-site.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_SOURCE = join(REPOSITORY_ROOT, "apps", "web", "public");
const DEFAULT_UPSTREAM = DEPLOYMENT_ENDPOINTS.public.origin;
const PREVIEW_ROOT_PREFIX = "tibotattle-public-preview-";
const MAXIMUM_REMOTE_RESPONSE_BYTES = 2 * 1024 * 1024;
const REMOTE_FETCH_TIMEOUT_MS = 10_000;
const COMMUNITY_DAILY_PATH = "/api/v1/community/daily";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const ENTRY_PAGE_FILES = new Set(["index.html", "community.html", "404.html"]);
const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
});
const ROUTE_FILES = new Map([
  ["/", "index.html"],
  ["/community", "community.html"],
  ["/community/", "community.html"],
  ["/docs", "docs.html"],
  ["/docs/", "docs.html"],
  ["/privacy", "privacy.html"],
  ["/privacy/", "privacy.html"],
]);
const METADATA_FIELDS = Object.freeze([
  "usage-monitor-installer-url",
  "usage-monitor-installer-version",
  "usage-monitor-installer-sha256",
  "usage-monitor-installer-bytes",
  "usage-monitor-minimum-macos",
  "usage-monitor-installer-architectures",
  "usage-monitor-architectures",
  "usage-monitor-release-notes-url",
  "usage-monitor-privacy-url",
  "usage-monitor-security-url",
  "usage-monitor-support-url",
]);

function usage() {
  return [
    "Usage:",
    "  npm run product:release-site:preview",
    "  npm run product:release-site:preview -- --port 4175",
    "  npm run product:release-site:preview -- --offline",
    "  npm run product:release-site:preview -- --upstream https://tibotattle.com",
    "",
    "The default mode fetches only published homepage metadata and the",
    "published aggregate daily community endpoint. --offline serves the",
    "generated site without either remote input.",
  ].join("\n");
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

function publicHttpsUrl(raw, label, { requireOrigin = false, dmg = false } = {}) {
  if (typeof raw !== "string" || raw !== raw.trim()) {
    throw new TypeError(`${label} must be a public HTTPS URL`);
  }
  let selected;
  try {
    selected = new URL(raw);
  } catch {
    throw new TypeError(`${label} must be a public HTTPS URL`);
  }
  if (selected.protocol !== "https:"
      || !selected.hostname
      || selected.username
      || selected.password
      || selected.port
      || selected.search
      || selected.hash
      || rejectedPublicHostname(selected.hostname)) {
    throw new TypeError(
      `${label} must be credential-free public HTTPS with no port, query, or fragment`,
    );
  }
  if (requireOrigin && selected.pathname !== "/") {
    throw new TypeError(`${label} must be an HTTPS origin with no path`);
  }
  if (dmg && !selected.pathname.toLowerCase().endsWith(".dmg")) {
    throw new TypeError(`${label} must end in .dmg`);
  }
  return selected;
}

function publicOrigin(raw, label = "Upstream") {
  const selected = publicHttpsUrl(raw, label, { requireOrigin: true });
  return new URL(`${selected.origin}/`);
}

function parsedPort(raw) {
  if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(raw)) {
    throw new TypeError("--port must be an integer from 0 to 65535");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new TypeError("--port must be an integer from 0 to 65535");
  }
  return port;
}

export function parsePublicReleaseSitePreviewArgs(argv) {
  const parsed = {
    offline: false,
    port: 0,
    upstream: DEFAULT_UPSTREAM,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--offline") {
      parsed.offline = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--port" || arg === "--upstream") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new TypeError(`Missing value for ${arg}\n${usage()}`);
      }
      index += 1;
      parsed[arg === "--port" ? "port" : "upstream"] = arg === "--port"
        ? parsedPort(value)
        : publicOrigin(value).href;
      continue;
    }
    throw new TypeError(`Unknown argument: ${arg}\n${usage()}`);
  }
  return parsed;
}

function htmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function metaAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = tag.match(new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>]+))`,
    "iu",
  ));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function metaValues(html) {
  if (typeof html !== "string") {
    throw new TypeError("Published homepage must be HTML text");
  }
  const values = new Map();
  for (const tag of html.matchAll(/<meta\b[^>]*>/giu)) {
    const name = metaAttribute(tag[0], "name")?.toLowerCase();
    if (!name || !METADATA_FIELDS.includes(name)) continue;
    const content = metaAttribute(tag[0], "content");
    if (content === null || values.has(name)) {
      throw new TypeError(`Published homepage has invalid ${name} metadata`);
    }
    values.set(name, content);
  }
  return values;
}

function requiredMeta(values, name) {
  const value = values.get(name);
  if (!value) {
    throw new TypeError(`Published homepage is missing ${name} metadata`);
  }
  return value;
}

function verifiedArchitecture(value) {
  if (!/^(?:arm64|x86_64)(?:,(?:arm64|x86_64))?$/u.test(value)) {
    throw new TypeError("Published homepage has an invalid installer architecture");
  }
  const architectures = value.split(",");
  if (new Set(architectures).size !== architectures.length) {
    throw new TypeError("Published homepage has duplicate installer architectures");
  }
  return value;
}

/**
 * Extract the display metadata from an already-public page. The result is
 * intentionally only a preview input: it does not verify the installer
 * artifact or make a release claim.
 */
export function extractPublicReleaseMetadata(html) {
  const values = metaValues(html);
  const installerUrl = publicHttpsUrl(
    requiredMeta(values, "usage-monitor-installer-url"),
    "Published installer URL",
    { dmg: true },
  ).href;
  const installerVersion = requiredMeta(
    values,
    "usage-monitor-installer-version",
  );
  if (!/^[0-9]+(?:\.[0-9]+){2,3}$/u.test(installerVersion)) {
    throw new TypeError("Published homepage has an invalid installer version");
  }
  const installerSha256 = requiredMeta(values, "usage-monitor-installer-sha256");
  if (!/^[a-f0-9]{64}$/u.test(installerSha256)) {
    throw new TypeError("Published homepage has an invalid installer SHA-256");
  }
  const installerBytes = requiredMeta(values, "usage-monitor-installer-bytes");
  if (!/^[1-9][0-9]{0,15}$/u.test(installerBytes)
      || !Number.isSafeInteger(Number(installerBytes))) {
    throw new TypeError("Published homepage has an invalid installer byte count");
  }
  const minimumMacos = requiredMeta(values, "usage-monitor-minimum-macos");
  if (!/^(?:1[0-9]|[2-9][0-9])\.(?:0|[1-9][0-9]?)(?:\.(?:0|[1-9][0-9]?))?$/u
    .test(minimumMacos)) {
    throw new TypeError("Published homepage has an invalid minimum macOS version");
  }
  // The older public metadata name appears only for backwards-compatible
  // previews; newly generated pages use the second name.
  const architectures = values.get("usage-monitor-architectures")
    ?? values.get("usage-monitor-installer-architectures");
  if (!architectures) {
    throw new TypeError("Published homepage is missing installer architecture metadata");
  }
  return Object.freeze({
    architectures: verifiedArchitecture(architectures),
    installerBytes,
    installerSha256,
    installerUrl,
    installerVersion,
    minimumMacos,
    privacyUrl: publicHttpsUrl(
      requiredMeta(values, "usage-monitor-privacy-url"),
      "Published privacy URL",
    ).href,
    releaseNotesUrl: publicHttpsUrl(
      requiredMeta(values, "usage-monitor-release-notes-url"),
      "Published release notes URL",
    ).href,
    securityUrl: publicHttpsUrl(
      requiredMeta(values, "usage-monitor-security-url"),
      "Published security URL",
    ).href,
    supportUrl: publicHttpsUrl(
      requiredMeta(values, "usage-monitor-support-url"),
      "Published support URL",
    ).href,
  });
}

function fallbackSiteMetadata(upstream) {
  return {
    privacyUrl: new URL("/privacy.html", upstream).href,
    releaseNotesUrl: new URL("/docs.html", upstream).href,
    securityUrl: new URL("/docs.html", upstream).href,
    supportUrl: new URL("/docs.html", upstream).href,
  };
}

function metadataTags(metadata) {
  const values = [
    ["usage-monitor-installer-url", metadata.installerUrl],
    ["usage-monitor-installer-version", metadata.installerVersion],
    ["usage-monitor-installer-sha256", metadata.installerSha256],
    ["usage-monitor-installer-bytes", metadata.installerBytes],
    ["usage-monitor-minimum-macos", metadata.minimumMacos],
    ["usage-monitor-architectures", metadata.architectures],
    ["usage-monitor-release-notes-url", metadata.releaseNotesUrl],
    ["usage-monitor-privacy-url", metadata.privacyUrl],
    ["usage-monitor-security-url", metadata.securityUrl],
    ["usage-monitor-support-url", metadata.supportUrl],
  ];
  return values.map(([name, value]) =>
    `<meta name="${name}" content="${htmlAttribute(value)}">`).join("\n");
}

function injectPreviewMetadata(html, metadata) {
  if (metadata === null) return html;
  const closingHead = "</head>";
  if (html.split(closingHead).length - 1 !== 1) {
    throw new TypeError("Generated preview entry must contain exactly one closing head tag");
  }
  return html.replace(
    closingHead,
    `${metadataTags(metadata)}\n  ${closingHead}`,
  );
}

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

function placeholderSocialPreview() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1200, 0);
  ihdr.writeUInt32BE(630, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const scanlines = Buffer.alloc((1200 + 1) * 630);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function readBoundedBody(response, maximumBytes, label) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)
        || !Number.isSafeInteger(parsedLength)
        || parsedLength > maximumBytes) {
      throw new Error(`${label} response exceeds its byte limit`);
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) {
      throw new Error(`${label} response exceeds its byte limit`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

async function fetchBounded(fetchImpl, url, accept, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: accept },
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${label} request returned HTTP ${response.status}`);
    }
    return {
      body: await readBoundedBody(response, MAXIMUM_REMOTE_RESPONSE_BYTES, label),
      contentType: response.headers.get("content-type") ?? "",
      status: response.status,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} request timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
async function fetchPublishedMetadata(fetchImpl, upstream) {
  const response = await fetchBounded(
    fetchImpl,
    upstream,
    "text/html",
    "Published homepage metadata",
  );
  if (!/^text\/html(?:;|$)/iu.test(response.contentType)) {
    throw new Error("Published homepage metadata did not return HTML");
  }
  return extractPublicReleaseMetadata(response.body.toString("utf8"));
}

function cleanRelativeAsset(pathname, allowedFiles) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/")
      || decoded.includes("\\")
      || decoded.includes("\0")
      || decoded.split("/").some((part) => part === "." || part === "..")) {
    return null;
  }
  const mapped = ROUTE_FILES.get(decoded);
  const filename = mapped ?? decoded.slice(1);
  return allowedFiles.has(filename) ? filename : null;
}

function responseHeaders(mode, contentType) {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "x-tibotattle-preview": mode,
  };
}

function writeResponse(response, status, headers, body, method) {
  response.writeHead(status, headers);
  response.end(method === "HEAD" ? undefined : body);
}

function requestMethodAllowed(request, response, mode) {
  if (request.method === "GET" || request.method === "HEAD") return true;
  writeResponse(
    response,
    405,
    { ...responseHeaders(mode, "text/plain; charset=utf-8"), Allow: "GET, HEAD" },
    "method_not_allowed\n",
    request.method,
  );
  return false;
}

function safeCommunityQuery(url) {
  const allowed = new Set(["from", "to"]);
  for (const [name] of url.searchParams) {
    if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1) {
      return null;
    }
  }
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  return from && to && DAY_PATTERN.test(from) && DAY_PATTERN.test(to)
    ? { from, to }
    : null;
}

async function proxyCommunityDaily({
  fetchImpl,
  mode,
  request,
  requestUrl,
  response,
  upstream,
}) {
  if (!requestMethodAllowed(request, response, mode)) return;
  if (mode === "generated-source-offline") {
    writeResponse(
      response,
      503,
      responseHeaders(mode, "application/json; charset=utf-8"),
      JSON.stringify({ error: { code: "PREVIEW_OFFLINE" } }),
      request.method,
    );
    return;
  }
  const query = safeCommunityQuery(requestUrl);
  if (query === null) {
    writeResponse(
      response,
      400,
      responseHeaders(mode, "application/json; charset=utf-8"),
      JSON.stringify({ error: { code: "INVALID_PREVIEW_QUERY" } }),
      request.method,
    );
    return;
  }
  const target = new URL(COMMUNITY_DAILY_PATH, upstream);
  target.search = new URLSearchParams(query).toString();
  try {
    const remote = await fetchBounded(
      fetchImpl,
      target,
      "application/json",
      "Published community data",
    );
    if (!/^application\/json(?:;|$)/iu.test(remote.contentType)) {
      throw new Error("Published community data did not return JSON");
    }
    writeResponse(
      response,
      remote.status,
      responseHeaders(mode, "application/json; charset=utf-8"),
      remote.body,
      request.method,
    );
  } catch {
    writeResponse(
      response,
      502,
      responseHeaders(mode, "application/json; charset=utf-8"),
      JSON.stringify({ error: { code: "PREVIEW_UPSTREAM_UNAVAILABLE" } }),
      request.method,
    );
  }
}

function closeServer(server) {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function listenLoopback(server, port) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Preview server did not expose a loopback port");
  }
  return address.port;
}

/**
 * Build the checked-in public site into a disposable directory and serve it
 * from loopback. The returned close() removes that generated output.
 */
export async function startPublicReleaseSitePreview({
  fetchImpl = globalThis.fetch,
  offline = false,
  port = 0,
  source = DEFAULT_SOURCE,
  upstream = DEFAULT_UPSTREAM,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Public-site preview requires fetch support");
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Preview port must be an integer from 0 to 65535");
  }
  const selectedUpstream = publicOrigin(upstream);
  const root = await mkdtemp(join(tmpdir(), PREVIEW_ROOT_PREFIX));
  let server = null;
  try {
    const metadata = offline
      ? null
      : await fetchPublishedMetadata(fetchImpl, selectedUpstream);
    const socialImage = join(root, "preview-social.png");
    const output = join(root, "site");
    await writeFile(socialImage, placeholderSocialPreview(), { mode: 0o600 });
    const siteMetadata = metadata ?? fallbackSiteMetadata(selectedUpstream);
    await buildPublicReleaseSite({
      output,
      privacyUrl: siteMetadata.privacyUrl,
      releaseNotesUrl: siteMetadata.releaseNotesUrl,
      securityUrl: siteMetadata.securityUrl,
      siteUrl: selectedUpstream.href,
      socialImage,
      source: resolve(source),
      supportUrl: siteMetadata.supportUrl,
    });
    const manifest = JSON.parse(
      await readFile(join(output, "release-site-manifest.json"), "utf8"),
    );
    if (!Array.isArray(manifest.files)
        || manifest.files.some((file) => typeof file?.path !== "string")) {
      throw new Error("Generated preview did not contain a valid release-site manifest");
    }
    const allowedFiles = new Set(manifest.files.map((file) => file.path));
    const mode = offline
      ? "generated-source-offline"
      : "generated-source-with-live-public-data";
    server = createServer(async (request, response) => {
      const requestUrl = new URL(
        request.url ?? "/",
        "http://preview.local",
      );
      if (requestUrl.pathname === COMMUNITY_DAILY_PATH) {
        await proxyCommunityDaily({
          fetchImpl,
          mode,
          request,
          requestUrl,
          response,
          upstream: selectedUpstream,
        });
        return;
      }
      if (!requestMethodAllowed(request, response, mode)) return;
      const filename = cleanRelativeAsset(requestUrl.pathname, allowedFiles);
      if (filename === null) {
        writeResponse(
          response,
          404,
          responseHeaders(mode, "text/plain; charset=utf-8"),
          "not_found\n",
          request.method,
        );
        return;
      }
      try {
        const body = await readFile(join(output, filename));
        const isEntry = ENTRY_PAGE_FILES.has(filename);
        const rendered = isEntry
          ? Buffer.from(injectPreviewMetadata(body.toString("utf8"), metadata))
          : body;
        writeResponse(
          response,
          200,
          responseHeaders(
            mode,
            isEntry ? MIME_TYPES[".html"] : MIME_TYPES[extname(filename)]
              ?? "application/octet-stream",
          ),
          rendered,
          request.method,
        );
      } catch {
        writeResponse(
          response,
          500,
          responseHeaders(mode, "text/plain; charset=utf-8"),
          "preview_asset_unavailable\n",
          request.method,
        );
      }
    });
    const selectedPort = await listenLoopback(server, port);
    let closed = false;
    return {
      mode,
      output,
      root,
      url: `http://127.0.0.1:${selectedPort}/`,
      async close() {
        if (closed) return;
        closed = true;
        await closeServer(server);
        await rm(root, { force: true, recursive: true });
      },
    };
  } catch (error) {
    if (server) await closeServer(server).catch(() => {});
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

async function runCli() {
  const options = parsePublicReleaseSitePreviewArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const preview = await startPublicReleaseSitePreview(options);
  process.stdout.write(
    [
      `Preview ready: ${preview.url}`,
      `Mode: ${preview.mode}`,
      "This is generated local source; live public metadata and aggregate data are visual-review inputs, not release proof.",
      "Press Ctrl+C to stop and remove the temporary output.",
    ].join("\n") + "\n",
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await preview.close();
  };
  const stopFromSignal = () => {
    void stop().catch((error) => {
      process.stderr.write(
        `Preview cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stopFromSignal);
  process.once("SIGTERM", stopFromSignal);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
