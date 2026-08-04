#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_BRAND } from "../config/product-brand.js";
import {
  MACOS_PREVIEW_DISTRIBUTION_CHANNEL,
  normalizeMacOSCentralOrigin,
  validateMacOSPreviewApp,
} from "./build-macos-app.js";
import { normalizeMacOSUpdaterMetadata } from "./macos-updater-core.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const DEFAULT_PREVIEW_APP_PATH = join(
  REPOSITORY_ROOT,
  ".release-build",
  "macos-preview",
  "current",
  PRODUCT_BRAND.bundleName,
);
const PLIST_MAX_BYTES = 1024 * 1024;
const MAX_APPCAST_BYTES = 1024 * 1024;
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const SPARKLE_NAMESPACE =
  "http://www.andymatuschak.org/xml-namespaces/sparkle";
const XML_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/u;
const XML_ENTITY_PATTERN = /&(?:amp|lt|gt|apos|quot|#[0-9]+|#x[0-9A-Fa-f]+);/gu;

export const MACOS_PREVIEW_REMOTE_HEALTH_PATHS = Object.freeze([
  "/api/health",
  "/api/ready",
]);

export const MACOS_PREVIEW_REMOTE_CODES = Object.freeze({
  APPCAST_BODY_TOO_LARGE: "MACOS_PREVIEW_REMOTE_APPCAST_BODY_TOO_LARGE",
  APPCAST_INVALID: "MACOS_PREVIEW_REMOTE_APPCAST_INVALID",
  APPCAST_NOT_PUBLISHED: "MACOS_PREVIEW_REMOTE_APPCAST_NOT_PUBLISHED",
  APPCAST_URL_MISMATCH: "MACOS_PREVIEW_REMOTE_APPCAST_URL_MISMATCH",
  ARGUMENTS_INVALID: "MACOS_PREVIEW_REMOTE_ARGUMENTS_INVALID",
  ARTIFACT_BODY_TOO_LARGE: "MACOS_PREVIEW_REMOTE_ARTIFACT_BODY_TOO_LARGE",
  ARTIFACT_INVALID: "MACOS_PREVIEW_REMOTE_ARTIFACT_INVALID",
  FETCH_FAILED: "MACOS_PREVIEW_REMOTE_FETCH_FAILED",
  FETCH_REDIRECT: "MACOS_PREVIEW_REMOTE_FETCH_REDIRECT",
  METADATA_INVALID: "MACOS_PREVIEW_REMOTE_METADATA_INVALID",
  PLIST_INVALID: "MACOS_PREVIEW_REMOTE_PLIST_INVALID",
  RECEIPT_EXISTS: "MACOS_PREVIEW_REMOTE_RECEIPT_EXISTS",
  RECEIPT_INVALID: "MACOS_PREVIEW_REMOTE_RECEIPT_INVALID",
  RESPONSE_INVALID: "MACOS_PREVIEW_REMOTE_RESPONSE_INVALID",
  TIMEOUT: "MACOS_PREVIEW_REMOTE_TIMEOUT",
});

export const MACOS_PREVIEW_REMOTE_RECEIPT_SCHEMA =
  "usage-monitor-macos-internal-update-rehearsal-v1";

const DEFAULT_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
});

function remoteError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredString(value, label, code = MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw remoteError(code, `${label} is required`);
  }
  return value;
}

function normalizeAppPath(value) {
  return resolve(requiredString(value, "Preview application path"));
}

function normalizeTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      `Timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} milliseconds`,
    );
  }
  return value;
}

function parseTimeoutArgument(value) {
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "--timeout-ms must be a positive decimal integer",
    );
  }
  return normalizeTimeout(Number(value));
}

function parseOptionValue(argv, index, argument) {
  if (index + 1 >= argv.length) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      `${argument} requires a value`,
    );
  }
  return argv[index + 1];
}

function setUniqueOption(target, key, value, argument) {
  if (Object.hasOwn(target, key)) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      `${argument} may be provided only once`,
    );
  }
  target[key] = value;
}

export function parseMacOSPreviewRemoteArguments(
  argv,
  environment = process.env,
) {
  if (!Array.isArray(argv)) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "CLI arguments must be an array",
    );
  }
  const environmentApp = environment?.USAGE_MONITOR_PREVIEW_OUTPUT;
  let appPath = normalizeAppPath(
    environmentApp === undefined || environmentApp === ""
      ? DEFAULT_PREVIEW_APP_PATH
      : environmentApp,
  );
  let live = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let help = false;
  let productionClaim = false;
  let receiptPath = null;
  const endpointConfig = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--app") {
      if (index + 1 >= argv.length) {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
          "--app requires a value",
        );
      }
      appPath = normalizeAppPath(argv[++index]);
    } else if (argument === "--live") {
      if (live) {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
          "--live may be provided only once",
        );
      }
      live = true;
    } else if (argument === "--timeout-ms") {
      timeoutMs = parseTimeoutArgument(
        parseOptionValue(argv, index, "--timeout-ms"),
      );
      index += 1;
    } else if (argument === "--central-origin") {
      setUniqueOption(
        endpointConfig,
        "centralOrigin",
        parseOptionValue(argv, index, "--central-origin"),
        "--central-origin",
      );
      index += 1;
    } else if (argument === "--appcast-url") {
      setUniqueOption(
        endpointConfig,
        "appcastURL",
        parseOptionValue(argv, index, "--appcast-url"),
        "--appcast-url",
      );
      index += 1;
    } else if (argument === "--artifact-url") {
      setUniqueOption(
        endpointConfig,
        "artifactURL",
        parseOptionValue(argv, index, "--artifact-url"),
        "--artifact-url",
      );
      index += 1;
    } else if (argument === "--artifact-sha256") {
      setUniqueOption(
        endpointConfig,
        "artifactSha256",
        parseOptionValue(argv, index, "--artifact-sha256"),
        "--artifact-sha256",
      );
      index += 1;
    } else if (argument === "--artifact-bytes") {
      const value = parseOptionValue(argv, index, "--artifact-bytes");
      if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
          "--artifact-bytes must be a non-negative decimal integer",
        );
      }
      setUniqueOption(
        endpointConfig,
        "artifactBytes",
        Number(value),
        "--artifact-bytes",
      );
      index += 1;
    } else if (argument === "--health-path") {
      const path = parseOptionValue(argv, index, "--health-path");
      if (!Array.isArray(endpointConfig.healthPaths)) {
        endpointConfig.healthPaths = [];
      }
      endpointConfig.healthPaths.push(path);
      index += 1;
    } else if (argument === "--production-claim") {
      if (productionClaim) {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
          "--production-claim may be provided only once",
        );
      }
      productionClaim = true;
    } else if (argument === "--receipt" || argument === "--receipt-file") {
      if (receiptPath !== null) {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
          "A receipt output may be provided only once",
        );
      }
      receiptPath = resolve(
        requiredString(
          parseOptionValue(argv, index, argument),
          `${argument} path`,
        ),
      );
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
        "Unknown macOS preview remote verifier argument",
      );
    }
  }
  const parsed = {
    appPath,
    help,
    live,
    timeoutMs,
  };
  if (Object.keys(endpointConfig).length > 0) {
    parsed.endpointConfig = Object.freeze(endpointConfig);
  }
  if (productionClaim) parsed.productionClaim = true;
  if (receiptPath !== null) parsed.receiptPath = receiptPath;
  return Object.freeze(parsed);
}

function parsePlistJSON(path) {
  const result = spawnSync("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    path,
  ], {
    encoding: "utf8",
    maxBuffer: PLIST_MAX_BYTES,
  });
  if (result.error || result.status !== 0) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.PLIST_INVALID,
      "Preview application Info.plist could not be read as public metadata",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.PLIST_INVALID,
      "Preview application Info.plist is not valid JSON metadata",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.PLIST_INVALID,
      "Preview application Info.plist must be a metadata object",
    );
  }
  return parsed;
}

export function readMacOSPreviewInfoPlist(appPath) {
  const selected = normalizeAppPath(appPath);
  if (basename(selected) !== PRODUCT_BRAND.bundleName) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.PLIST_INVALID,
      `Preview application must be named ${PRODUCT_BRAND.bundleName}`,
    );
  }
  return parsePlistJSON(join(selected, "Contents", "Info.plist"));
}

function publicPreviewMetadata(plist) {
  if (!plist || typeof plist !== "object" || Array.isArray(plist)) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.METADATA_INVALID,
      "Preview application public metadata is not an object",
    );
  }
  if (plist.UsageMonitorBuildChannel !== MACOS_PREVIEW_DISTRIBUTION_CHANNEL
      || plist.UsageMonitorPreviewDistribution !== true
      || plist.UsageMonitorCentralOriginMode !== "production_https"
      || plist.UsageMonitorUpdaterEnabled !== true) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.METADATA_INVALID,
      "Preview application public metadata is outside the preview distribution boundary",
    );
  }
  let centralService;
  let updater;
  try {
    centralService = normalizeMacOSCentralOrigin(
      plist.UsageMonitorCentralOrigin,
    );
    updater = normalizeMacOSUpdaterMetadata({
      appcastURL: plist.SUFeedURL,
      publicEdKey: plist.SUPublicEDKey,
    });
  } catch {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.METADATA_INVALID,
      "Preview application public origin or appcast metadata is invalid",
    );
  }
  if (centralService.mode !== "production_https") {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.METADATA_INVALID,
      "Preview application central origin is not a public HTTPS origin",
    );
  }
  return Object.freeze({
    appcastURL: updater.appcastURL,
    centralOrigin: centralService.origin,
  });
}

export async function readMacOSPreviewPublicMetadata(
  appPath,
  { readInfoPlist = readMacOSPreviewInfoPlist } = {},
) {
  const selected = normalizeAppPath(appPath);
  return publicPreviewMetadata(await readInfoPlist(selected));
}

function validatorSummary(validation) {
  return Object.freeze({
    bundleIdentifier: validation?.bundleIdentifier ?? null,
    bundleVersion: validation?.bundleVersion ?? null,
    channel: validation?.channel ?? MACOS_PREVIEW_DISTRIBUTION_CHANNEL,
    passed: true,
    updaterEnabled: validation?.updaterEnabled === true,
  });
}

function publicHttpsURL(value, label) {
  requiredString(value, label, MACOS_PREVIEW_REMOTE_CODES.RESPONSE_INVALID);
  let selected;
  try {
    selected = new URL(value);
  } catch {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.RESPONSE_INVALID,
      `${label} is not an HTTPS URL`,
    );
  }
  if (selected.protocol !== "https:"
      || selected.username
      || selected.password
      || selected.search
      || selected.hash
      || selected.href !== value) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.RESPONSE_INVALID,
      `${label} must be an exact credential-free HTTPS URL`,
    );
  }
  return selected.href;
}

function normalizeHealthPaths(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "At least one central health or ready endpoint is required",
    );
  }
  const paths = [];
  for (const path of value) {
    if (typeof path !== "string"
        || !/^\/[^/]/u.test(path)
        || path.includes("?")
        || path.includes("#")
        || paths.includes(path)) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
        "Central health endpoint paths must be unique absolute paths",
      );
    }
    paths.push(path);
  }
  return Object.freeze(paths);
}

function normalizeArtifactDigest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "Artifact SHA-256 must be 64 lowercase hexadecimal characters",
    );
  }
  return value;
}

function normalizeArtifactBytes(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ARTIFACT_BYTES) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      `Artifact byte length must be an integer from 1 to ${MAX_ARTIFACT_BYTES}`,
    );
  }
  return value;
}

/**
 * Normalize only public, credential-free endpoint configuration. The app
 * bundle remains the source of embedded metadata; an explicit configuration
 * is compared with that metadata before any network request is made.
 */
export function normalizeMacOSPreviewEndpointConfiguration(value = null) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "Endpoint configuration must be an object",
    );
  }
  const normalized = {};
  if (Object.hasOwn(value, "centralOrigin")) {
    try {
      const central = normalizeMacOSCentralOrigin(value.centralOrigin);
      if (central.mode !== "production_https") throw new Error("origin mode");
      normalized.centralOrigin = central.origin;
    } catch {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
        "Endpoint configuration centralOrigin must be a public HTTPS origin",
      );
    }
  }
  if (Object.hasOwn(value, "appcastURL")) {
    normalized.appcastURL = publicHttpsURL(
      value.appcastURL,
      "Endpoint configuration appcastURL",
    );
  }
  if (Object.hasOwn(value, "artifactURL")) {
    if (!publicArtifactURL(value.artifactURL)) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
        "Endpoint configuration artifactURL must be a public HTTPS URL",
      );
    }
    normalized.artifactURL = value.artifactURL;
  }
  if (Object.hasOwn(value, "artifactSha256")) {
    normalized.artifactSha256 = normalizeArtifactDigest(value.artifactSha256);
  }
  if (Object.hasOwn(value, "artifactBytes")) {
    normalized.artifactBytes = normalizeArtifactBytes(value.artifactBytes);
  }
  if (Object.hasOwn(value, "healthPaths")) {
    normalized.healthPaths = normalizeHealthPaths(value.healthPaths);
  }
  if (Object.keys(normalized).length === 0) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "Endpoint configuration must name at least one public endpoint",
    );
  }
  if (normalized.artifactSha256 !== undefined
      && normalized.artifactURL === undefined) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "Artifact SHA-256 requires an explicit artifactURL",
    );
  }
  if (normalized.artifactBytes !== undefined
      && normalized.artifactURL === undefined) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "Artifact byte length requires an explicit artifactURL",
    );
  }
  return Object.freeze(normalized);
}

function responseHeader(response, name) {
  if (response?.headers && typeof response.headers.get === "function") {
    return response.headers.get(name);
  }
  return null;
}

async function cancelReader(reader) {
  if (typeof reader?.cancel === "function") {
    try {
      await reader.cancel();
    } catch {
      // The request has already failed closed; cancellation is best effort.
    }
  }
}

async function readBoundedResponseText(response, maximumBytes) {
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maximumBytes) {
          await cancelReader(reader);
          throw remoteError(
            MACOS_PREVIEW_REMOTE_CODES.APPCAST_BODY_TOO_LARGE,
            "Remote response exceeded the bounded body limit",
          );
        }
        chunks.push(chunk);
      }
    } catch (error) {
      await cancelReader(reader);
      throw error;
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  if (typeof response?.text !== "function") return "";
  const text = await response.text();
  if (typeof text !== "string"
      || Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.APPCAST_BODY_TOO_LARGE,
      "Remote response exceeded the bounded body limit",
    );
  }
  return text;
}

function elapsedMilliseconds(clock, start) {
  const finish = clock.now();
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return null;
  return Math.max(0, Math.round(finish - start));
}

function normalizeClock(clock) {
  const selected = clock ?? DEFAULT_CLOCK;
  if (typeof selected.now !== "function"
      || typeof selected.setTimeout !== "function"
      || typeof selected.clearTimeout !== "function") {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "A clock with now, setTimeout, and clearTimeout functions is required",
    );
  }
  return selected;
}

function requestFailure(code, status = null) {
  const error = remoteError(code, "Bounded remote request failed");
  error.status = Number.isInteger(status) ? status : null;
  return error;
}

/**
 * Make exactly one credential-free, GET-only HTTPS request. Redirects are
 * deliberately not followed, and both the response body and request time are
 * bounded. The response body is returned only to the caller for local parsing.
 */
export async function fetchBoundedMacOSPreviewHTTPS(
  url,
  {
    accept = "*/*",
    clock = DEFAULT_CLOCK,
    fetchImpl = globalThis.fetch,
    maximumBytes = MAX_HEALTH_RESPONSE_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  const selected = publicHttpsURL(url, "Remote request URL");
  const selectedClock = normalizeClock(clock);
  const boundedTimeout = normalizeTimeout(timeoutMs);
  if (typeof fetchImpl !== "function") {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.FETCH_FAILED,
      "The runtime does not provide a fetch implementation",
    );
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "Remote response body limit must be a positive integer",
    );
  }
  const controller = new AbortController();
  const start = selectedClock.now();
  let timedOut = false;
  let timerScheduled = false;
  let timer;
  const operation = (async () => {
    let response;
    try {
      response = await fetchImpl(selected, {
        credentials: "omit",
        headers: { accept },
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw requestFailure(MACOS_PREVIEW_REMOTE_CODES.FETCH_FAILED);
    }
    const status = response?.status;
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw requestFailure(MACOS_PREVIEW_REMOTE_CODES.RESPONSE_INVALID);
    }
    if (status >= 300 && status < 400) {
      throw requestFailure(MACOS_PREVIEW_REMOTE_CODES.FETCH_REDIRECT, status);
    }
    if (typeof response.url === "string"
        && response.url.length > 0
        && response.url !== selected) {
      throw requestFailure(MACOS_PREVIEW_REMOTE_CODES.FETCH_REDIRECT, status);
    }
    let body;
    try {
      body = await readBoundedResponseText(response, maximumBytes);
    } catch (error) {
      if (!Number.isInteger(error?.status)) error.status = status;
      throw error;
    }
    return Object.freeze({
      body,
      contentType: responseHeader(response, "content-type"),
      durationMs: elapsedMilliseconds(selectedClock, start),
      status,
    });
  })();
  const timeout = new Promise((_, reject) => {
    timer = selectedClock.setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // AbortController is best effort; the race still enforces the bound.
      }
      reject(requestFailure(MACOS_PREVIEW_REMOTE_CODES.TIMEOUT));
    }, boundedTimeout);
    timerScheduled = true;
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (timedOut || error?.code === MACOS_PREVIEW_REMOTE_CODES.TIMEOUT) {
      throw requestFailure(MACOS_PREVIEW_REMOTE_CODES.TIMEOUT);
    }
    if (error?.code) throw error;
    throw requestFailure(MACOS_PREVIEW_REMOTE_CODES.FETCH_FAILED);
  } finally {
    if (timerScheduled) selectedClock.clearTimeout(timer);
  }
}

function declaredResponseBytes(response) {
  const value = responseHeader(response, "content-length");
  if (value === null || value.trim() === "") return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value.trim())) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARTIFACT_INVALID,
      "Remote artifact Content-Length is invalid",
    );
  }
  const selected = Number(value.trim());
  if (!Number.isSafeInteger(selected) || selected > MAX_ARTIFACT_BYTES) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARTIFACT_BODY_TOO_LARGE,
      "Remote artifact Content-Length exceeds the bounded byte limit",
    );
  }
  return selected;
}

async function readBoundedResponseDigest(response, maximumBytes) {
  const hash = createHash("sha256");
  let bytes = 0;
  const consume = (chunk) => {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.ARTIFACT_BODY_TOO_LARGE,
        "Remote artifact exceeded the bounded body limit",
      );
    }
    hash.update(value);
  };
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        consume(next.value);
      }
    } catch (error) {
      await cancelReader(reader);
      throw error;
    }
  } else if (typeof response?.arrayBuffer === "function") {
    consume(await response.arrayBuffer());
  } else if (typeof response?.text === "function") {
    consume(await response.text());
  } else {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.RESPONSE_INVALID,
      "Remote artifact response has no readable body",
    );
  }
  return Object.freeze({
    bytes,
    sha256: hash.digest("hex"),
  });
}

/**
 * Fetch an installer enclosure without retaining or returning its contents.
 * Only its bounded byte count and SHA-256 are returned to the verifier.
 */
export async function fetchBoundedMacOSPreviewArtifact(
  url,
  {
    clock = DEFAULT_CLOCK,
    fetchImpl = globalThis.fetch,
    maximumBytes = MAX_ARTIFACT_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  const selected = publicHttpsURL(url, "Remote artifact URL");
  const selectedClock = normalizeClock(clock);
  const boundedTimeout = normalizeTimeout(timeoutMs);
  if (typeof fetchImpl !== "function") {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.FETCH_FAILED,
      "The runtime does not provide a fetch implementation",
    );
  }
  if (!Number.isSafeInteger(maximumBytes)
      || maximumBytes < 1
      || maximumBytes > MAX_ARTIFACT_BYTES) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "Remote artifact body limit is outside the bounded range",
    );
  }
  const controller = new AbortController();
  const start = selectedClock.now();
  let timedOut = false;
  let timerScheduled = false;
  let timer;
  const operation = (async () => {
    let response;
    try {
      response = await fetchImpl(selected, {
        credentials: "omit",
        headers: { accept: "application/octet-stream, application/x-apple-diskimage" },
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw requestFailure(MACOS_PREVIEW_REMOTE_CODES.FETCH_FAILED);
    }
    const status = response?.status;
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw requestFailure(MACOS_PREVIEW_REMOTE_CODES.RESPONSE_INVALID);
    }
    if (status >= 300 && status < 400) {
      throw requestFailure(MACOS_PREVIEW_REMOTE_CODES.FETCH_REDIRECT, status);
    }
    if (typeof response.url === "string"
        && response.url.length > 0
        && response.url !== selected) {
      throw requestFailure(MACOS_PREVIEW_REMOTE_CODES.FETCH_REDIRECT, status);
    }
    const contentLength = declaredResponseBytes(response);
    if (contentLength !== null && contentLength > maximumBytes) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.ARTIFACT_BODY_TOO_LARGE,
        "Remote artifact Content-Length exceeds the bounded body limit",
      );
    }
    if (status < 200 || status >= 300) {
      return Object.freeze({
        bytes: null,
        contentLength,
        durationMs: elapsedMilliseconds(selectedClock, start),
        sha256: null,
        status,
      });
    }
    const digest = await readBoundedResponseDigest(response, maximumBytes);
    return Object.freeze({
      ...digest,
      contentLength,
      durationMs: elapsedMilliseconds(selectedClock, start),
      status,
    });
  })();
  const timeout = new Promise((_, reject) => {
    timer = selectedClock.setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // AbortController is best effort; the race still enforces the bound.
      }
      reject(requestFailure(MACOS_PREVIEW_REMOTE_CODES.TIMEOUT));
    }, boundedTimeout);
    timerScheduled = true;
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (timedOut || error?.code === MACOS_PREVIEW_REMOTE_CODES.TIMEOUT) {
      throw requestFailure(MACOS_PREVIEW_REMOTE_CODES.TIMEOUT);
    }
    if (error?.code) throw error;
    throw requestFailure(MACOS_PREVIEW_REMOTE_CODES.FETCH_FAILED);
  } finally {
    if (timerScheduled) selectedClock.clearTimeout(timer);
  }
}

function parseReportedStatus(body) {
  if (typeof body !== "string" || body.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const status = parsed?.status;
  return typeof status === "string"
    && /^[A-Za-z][A-Za-z0-9_]*$/u.test(status)
    ? status
    : null;
}

function requestFailureResult(error) {
  const code = error?.code;
  let outcome = "network_error";
  if (code === MACOS_PREVIEW_REMOTE_CODES.TIMEOUT) {
    outcome = "timeout";
  } else if (code === MACOS_PREVIEW_REMOTE_CODES.FETCH_REDIRECT) {
    outcome = "redirect_refused";
  } else if (code === MACOS_PREVIEW_REMOTE_CODES.RESPONSE_INVALID
      || code === MACOS_PREVIEW_REMOTE_CODES.ARTIFACT_INVALID) {
    outcome = "invalid_response";
  } else if (code === MACOS_PREVIEW_REMOTE_CODES.APPCAST_BODY_TOO_LARGE
      || code === MACOS_PREVIEW_REMOTE_CODES.ARTIFACT_BODY_TOO_LARGE) {
    outcome = "body_too_large";
  }
  return {
    httpStatus: Number.isInteger(error?.status) ? error.status : null,
    outcome,
  };
}

async function checkCentralEndpoint(
  centralOrigin,
  path,
  expectedStatuses,
  options,
) {
  const url = new URL(path, `${centralOrigin}/`).href;
  try {
    const response = await fetchBoundedMacOSPreviewHTTPS(url, {
      ...options,
      accept: "application/json",
      maximumBytes: MAX_HEALTH_RESPONSE_BYTES,
    });
    const reportedStatus = parseReportedStatus(response.body);
    const httpSuccess = response.status >= 200 && response.status < 300;
    const reportedOkay = reportedStatus === null
      || expectedStatuses.includes(reportedStatus);
    const passed = httpSuccess && reportedOkay;
    const outcome = passed
      ? "healthy"
      : response.status === 503
        ? "not_ready"
        : response.status === 404
          ? "missing"
          : "http_error";
    return Object.freeze({
      httpStatus: response.status,
      outcome,
      path,
      passed,
      reportedStatus,
      url,
    });
  } catch (error) {
    const failure = requestFailureResult(error);
    return Object.freeze({
      httpStatus: failure.httpStatus,
      outcome: failure.outcome,
      path,
      passed: false,
      reportedStatus: null,
      url,
    });
  }
}

function xmlWhitespace(value) {
  return /^\s*$/u.test(value);
}

function validateXmlEntities(value) {
  let index = 0;
  for (;;) {
    const ampersand = value.indexOf("&", index);
    if (ampersand < 0) return;
    const match = XML_ENTITY_PATTERN.exec(value.slice(ampersand));
    XML_ENTITY_PATTERN.lastIndex = 0;
    if (!match || match.index !== 0) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
        "Appcast XML contains an invalid entity reference",
      );
    }
    index = ampersand + match[0].length;
  }
}

function parseXMLTag(source) {
  let value = source.trim();
  let selfClosing = false;
  if (value.endsWith("/")) {
    selfClosing = true;
    value = value.slice(0, -1).trimEnd();
  }
  let index = 0;
  while (/\s/u.test(value[index] ?? "")) index += 1;
  const nameStart = index;
  while (index < value.length && !/\s|=/u.test(value[index])) index += 1;
  const name = value.slice(nameStart, index);
  if (!XML_NAME_PATTERN.test(name)) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
      "Appcast XML contains an invalid element name",
    );
  }
  const attributes = new Map();
  while (index < value.length) {
    while (/\s/u.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    const attributeStart = index;
    while (index < value.length && !/\s|=/u.test(value[index])) index += 1;
    const attributeName = value.slice(attributeStart, index);
    if (!XML_NAME_PATTERN.test(attributeName) || attributes.has(attributeName)) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
        "Appcast XML contains an invalid or duplicate attribute",
      );
    }
    while (/\s/u.test(value[index] ?? "")) index += 1;
    if (value[index] !== "=") {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
        "Appcast XML attribute is missing its value",
      );
    }
    index += 1;
    while (/\s/u.test(value[index] ?? "")) index += 1;
    const quote = value[index];
    if (quote !== "\"" && quote !== "'") {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
        "Appcast XML attribute values must be quoted",
      );
    }
    index += 1;
    const valueStart = index;
    const end = value.indexOf(quote, valueStart);
    if (end < 0) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
        "Appcast XML contains an unterminated attribute",
      );
    }
    const attributeValue = value.slice(valueStart, end);
    validateXmlEntities(attributeValue);
    attributes.set(attributeName, attributeValue);
    index = end + 1;
  }
  return { attributes, name, selfClosing };
}

function parseXMLDocument(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
      "Appcast response is empty",
    );
  }
  if (Buffer.byteLength(value, "utf8") > MAX_APPCAST_BYTES) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.APPCAST_BODY_TOO_LARGE,
      "Appcast response exceeds the bounded body limit",
    );
  }
  const source = value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  const roots = [];
  const stack = [];
  let index = 0;
  const appendText = (text, raw = false) => {
    if (!raw) validateXmlEntities(text);
    if (stack.length === 0) {
      if (!xmlWhitespace(text)) {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
          "Appcast XML has text outside its root element",
        );
      }
      return;
    }
    stack[stack.length - 1].text += text;
  };
  while (index < source.length) {
    if (source[index] !== "<") {
      const next = source.indexOf("<", index);
      const end = next < 0 ? source.length : next;
      appendText(source.slice(index, end));
      index = end;
      continue;
    }
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end < 0) {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
          "Appcast XML comment is unterminated",
        );
      }
      index = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      const end = source.indexOf("]]>", index + 9);
      if (end < 0) {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
          "Appcast XML CDATA is unterminated",
        );
      }
      appendText(source.slice(index + 9, end), true);
      index = end + 3;
      continue;
    }
    if (source.startsWith("<!DOCTYPE", index)
        || source.startsWith("<!ENTITY", index)
        || source.startsWith("<!", index)) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
        "Appcast XML declarations are not allowed",
      );
    }
    if (source.startsWith("<?", index)) {
      const end = source.indexOf("?>", index + 2);
      if (end < 0) {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
          "Appcast XML processing instruction is unterminated",
        );
      }
      index = end + 2;
      continue;
    }
    const end = source.indexOf(">", index + 1);
    if (end < 0) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
        "Appcast XML element is unterminated",
      );
    }
    const tag = source.slice(index + 1, end).trim();
    if (tag.startsWith("/")) {
      const closingName = tag.slice(1).trim();
      if (!XML_NAME_PATTERN.test(closingName)
          || stack.length === 0
          || stack[stack.length - 1].name !== closingName) {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
          "Appcast XML element nesting is invalid",
        );
      }
      stack.pop();
    } else {
      const parsed = parseXMLTag(tag);
      if (stack.length === 0 && roots.length > 0) {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
          "Appcast XML contains multiple root elements",
        );
      }
      const node = {
        attributes: parsed.attributes,
        children: [],
        name: parsed.name,
        text: "",
      };
      if (stack.length > 0) stack[stack.length - 1].children.push(node);
      else roots.push(node);
      if (!parsed.selfClosing) stack.push(node);
    }
    index = end + 1;
  }
  if (stack.length !== 0 || roots.length !== 1) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
      "Appcast XML root is incomplete",
    );
  }
  return roots[0];
}

function childElements(node, name) {
  return node.children.filter((child) => child.name === name);
}

function publicArtifactURL(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  let selected;
  try {
    selected = new URL(value);
  } catch {
    return false;
  }
  return selected.protocol === "https:"
    && !selected.username
    && !selected.password
    && !selected.search
    && !selected.hash
    && selected.pathname !== "/"
    && selected.href === value;
}

function contentAddressedArtifact(value) {
  if (!publicArtifactURL(value)) return null;
  const selected = new URL(value);
  const segments = selected.pathname.slice(1).split("/");
  if (segments.length !== 4
      || segments[0] !== "releases"
      || !/^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,2}$/u.test(
        segments[1] ?? "",
      )
      || !/^[a-f0-9]{64}$/u.test(segments[2] ?? "")
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:dmg|delta)$/u.test(
        segments[3] ?? "",
      )) {
    return null;
  }
  return Object.freeze({
    bundleVersion: segments[1],
    fileName: segments[3],
    sha256: segments[2],
  });
}

function validSparkleSignature(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9+/]{86}==$/u.test(value)
    && Buffer.from(value, "base64").length === 64
    && Buffer.from(value, "base64").toString("base64") === value;
}

function validateAppcastStructure(value, {
  expectedArtifactOrigin = null,
  expectedArtifactURL = null,
  expectedBundleVersion = null,
  requireContentAddressed = false,
} = {}) {
  const root = parseXMLDocument(value);
  if (root.name !== "rss"
      || root.attributes.get("version") !== "2.0"
      || root.attributes.get("xmlns:sparkle") !== SPARKLE_NAMESPACE) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
      "Appcast root is not Sparkle-compatible RSS",
    );
  }
  const channels = childElements(root, "channel");
  if (channels.length !== 1) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
      "Appcast RSS must contain one channel",
    );
  }
  const items = childElements(channels[0], "item");
  if (items.length === 0) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
      "Appcast RSS channel contains no update item",
    );
  }
  let enclosureCount = 0;
  const enclosures = [];
  for (const item of items) {
    const itemEnclosures = childElements(item, "enclosure");
    if (itemEnclosures.length === 0) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
        "Appcast update item contains no enclosure",
      );
    }
    for (const enclosure of itemEnclosures) {
      const attributes = enclosure.attributes;
      const artifactURL = attributes.get("url");
      const version = attributes.get("sparkle:version");
      const length = attributes.get("length");
      const lengthNumber = Number(length);
      const contentAddress = contentAddressedArtifact(artifactURL);
      if (!publicArtifactURL(artifactURL)
          || !/^(?:0|[1-9][0-9]*)$/u.test(length ?? "")
          || !Number.isSafeInteger(lengthNumber)
          || lengthNumber < 1
          || lengthNumber > MAX_ARTIFACT_BYTES
          || typeof version !== "string"
          || version.length === 0
          || !validSparkleSignature(attributes.get("sparkle:edSignature"))
          || enclosure.children.length > 0
          || enclosure.text.trim() !== ""
          || (expectedArtifactOrigin !== null
            && new URL(artifactURL).origin !== expectedArtifactOrigin)
          || (requireContentAddressed && contentAddress === null)
          || (contentAddress !== null
            && contentAddress.bundleVersion !== version)) {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
          "Appcast enclosure is not structurally suitable for Sparkle",
        );
      }
      enclosureCount += 1;
      enclosures.push(Object.freeze({
        artifactSha256: contentAddress?.sha256 ?? null,
        artifactVersion: contentAddress?.bundleVersion ?? null,
        length: lengthNumber,
        signaturePresent: true,
        url: artifactURL,
        version,
      }));
    }
  }
  if (expectedArtifactURL !== null) {
    const matches = enclosures.filter(
      (enclosure) => enclosure.url === expectedArtifactURL,
    );
    if (matches.length !== 1) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.APPCAST_URL_MISMATCH,
        "Appcast does not contain exactly one enclosure at the configured artifact URL",
      );
    }
  }
  if (expectedBundleVersion !== null
      && !enclosures.some(({ version }) => version === expectedBundleVersion)) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.APPCAST_URL_MISMATCH,
      "Appcast does not contain an enclosure for the candidate bundle version",
    );
  }
  return Object.freeze({
    channelCount: channels.length,
    enclosureCount,
    enclosures: Object.freeze(enclosures),
    itemCount: items.length,
    root: root.name,
  });
}

export function validateSparkleAppcastXML(value, options = {}) {
  try {
    return Object.freeze({
      ...validateAppcastStructure(value, options),
      valid: true,
    });
  } catch (error) {
    return Object.freeze({
      reason: error?.code === MACOS_PREVIEW_REMOTE_CODES.APPCAST_BODY_TOO_LARGE
        ? "body_too_large"
        : error?.code === MACOS_PREVIEW_REMOTE_CODES.APPCAST_URL_MISMATCH
          ? "mismatched_url"
          : "invalid_xml_or_sparkle_structure",
      valid: false,
    });
  }
}

function appcastFailure(error) {
  const failure = requestFailureResult(error);
  return Object.freeze({
    checked: true,
    enclosures: Object.freeze([]),
    httpStatus: failure.httpStatus,
    reason: failure.outcome,
    status: "unavailable",
    valid: false,
  });
}

async function checkAppcast(appcastURL, options) {
  let response;
  try {
    response = await fetchBoundedMacOSPreviewHTTPS(appcastURL, {
      ...options,
      accept: "application/rss+xml, application/xml, text/xml;q=0.9",
      maximumBytes: MAX_APPCAST_BYTES,
    });
  } catch (error) {
    if (error?.status === 404 || error?.status === 410) {
      return Object.freeze({
        checked: true,
        enclosures: Object.freeze([]),
        httpStatus: error.status,
        reason: "not_published",
        status: "not_published",
        valid: false,
      });
    }
    return appcastFailure(error);
  }
  if (response.status === 404 || response.status === 410) {
    return Object.freeze({
      checked: true,
      enclosures: Object.freeze([]),
      httpStatus: response.status,
      reason: "not_published",
      status: "not_published",
      valid: false,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    return Object.freeze({
      checked: true,
      enclosures: Object.freeze([]),
      httpStatus: response.status,
      reason: "http_error",
      status: "unavailable",
      valid: false,
    });
  }
  const structure = validateSparkleAppcastXML(response.body, options);
  if (!structure.valid) {
    return Object.freeze({
      checked: true,
      enclosures: Object.freeze([]),
      httpStatus: response.status,
      reason: structure.reason,
      status: "invalid",
      valid: false,
    });
  }
  return Object.freeze({
    ...structure,
    checked: true,
    httpStatus: response.status,
    status: "valid",
    valid: true,
  });
}

function artifactNotChecked(reason = "production_claim_not_requested") {
  return Object.freeze({
    checked: false,
    bytes: null,
    httpStatus: null,
    reason,
    sha256: null,
    status: "not_checked",
    valid: false,
  });
}

function artifactFailure(error) {
  const failure = requestFailureResult(error);
  return Object.freeze({
    checked: true,
    bytes: null,
    httpStatus: failure.httpStatus,
    reason: failure.outcome,
    sha256: null,
    status: "unavailable",
    valid: false,
  });
}

async function checkArtifact({
  artifact,
  clock,
  endpointConfig,
  fetchImpl,
  timeoutMs,
}) {
  if (!artifact || typeof artifact.url !== "string") {
    return Object.freeze({
      checked: true,
      bytes: null,
      httpStatus: null,
      reason: "missing_enclosure",
      sha256: null,
      status: "invalid",
      valid: false,
    });
  }
  let response;
  try {
    response = await fetchBoundedMacOSPreviewArtifact(artifact.url, {
      clock,
      fetchImpl,
      maximumBytes: Math.min(MAX_ARTIFACT_BYTES, Math.max(artifact.length, 1)),
      timeoutMs,
    });
  } catch (error) {
    return artifactFailure(error);
  }
  if (response.status === 404 || response.status === 410) {
    return Object.freeze({
      checked: true,
      bytes: null,
      httpStatus: response.status,
      reason: "missing",
      sha256: null,
      status: "unavailable",
      valid: false,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    return Object.freeze({
      checked: true,
      bytes: null,
      httpStatus: response.status,
      reason: "http_error",
      sha256: null,
      status: "unavailable",
      valid: false,
    });
  }
  const expectedDigest = endpointConfig?.artifactSha256
    ?? artifact.artifactSha256;
  const expectedBytes = endpointConfig?.artifactBytes ?? artifact.length;
  if (response.bytes !== expectedBytes) {
    return Object.freeze({
      checked: true,
      bytes: response.bytes,
      httpStatus: response.status,
      reason: "bytes_mismatch",
      sha256: response.sha256,
      status: "invalid",
      valid: false,
    });
  }
  if (expectedDigest === null || expectedDigest === undefined) {
    return Object.freeze({
      checked: true,
      bytes: response.bytes,
      httpStatus: response.status,
      reason: "digest_missing",
      sha256: response.sha256,
      status: "invalid",
      valid: false,
    });
  }
  if (response.sha256 !== expectedDigest) {
    return Object.freeze({
      checked: true,
      bytes: response.bytes,
      httpStatus: response.status,
      reason: "sha256_mismatch",
      sha256: response.sha256,
      status: "invalid",
      valid: false,
    });
  }
  return Object.freeze({
    checked: true,
    bytes: response.bytes,
    httpStatus: response.status,
    reason: "verified",
    sha256: response.sha256,
    status: "valid",
    valid: true,
  });
}

function claimResult(requested, passed = false, reason = "not_requested") {
  return Object.freeze({
    passed,
    reason,
    requested,
    status: requested ? (passed ? "passed" : "blocked") : "not_requested",
  });
}

function endpointConfigurationResult(metadata, endpointConfig, healthPaths) {
  const mismatchFields = [];
  if (endpointConfig?.centralOrigin !== undefined
      && endpointConfig.centralOrigin !== metadata.centralOrigin) {
    mismatchFields.push("centralOrigin");
  }
  if (endpointConfig?.appcastURL !== undefined
      && endpointConfig.appcastURL !== metadata.appcastURL) {
    mismatchFields.push("appcastURL");
  }
  return Object.freeze({
    appcastURL: endpointConfig?.appcastURL ?? metadata.appcastURL,
    centralOrigin: endpointConfig?.centralOrigin ?? metadata.centralOrigin,
    configured: endpointConfig !== null,
    healthPaths: Object.freeze(
      endpointConfig?.healthPaths ?? healthPaths,
    ),
    matched: mismatchFields.length === 0,
    mismatchFields: Object.freeze(mismatchFields),
    source: endpointConfig === null ? "bundle_metadata" : "explicit",
    status: mismatchFields.length === 0 ? "matched" : "mismatched_urls",
  });
}

function localOnlyRemoteResult(
  local,
  metadata,
  {
    endpointConfiguration,
    productionClaim = false,
    claimReason = "network_not_enabled",
  } = {},
) {
  const blockedReason = endpointConfiguration?.matched === false
    ? "endpoint_urls_mismatch"
    : claimReason;
  return Object.freeze({
    appcast: Object.freeze({
      checked: false,
      enclosures: Object.freeze([]),
      reason: "live_not_requested",
      status: "not_checked",
      valid: false,
    }),
    central: Object.freeze({
      checked: false,
      endpoints: Object.freeze([]),
      passed: false,
      status: "not_checked",
    }),
    artifact: artifactNotChecked(),
    claim: claimResult(productionClaim, false, blockedReason),
    endpointConfiguration,
    live: false,
    local,
    metadata,
    overall: productionClaim
      ? "not_ready"
      : "local_valid_remote_unchecked",
  });
}

export async function verifyMacOSPreviewRemote({
  appPath,
  clock = DEFAULT_CLOCK,
  endpointConfig = null,
  fetchImpl = globalThis.fetch,
  healthPaths = MACOS_PREVIEW_REMOTE_HEALTH_PATHS,
  live = false,
  productionClaim = false,
  readInfoPlist = readMacOSPreviewInfoPlist,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  validatePreviewApp = validateMacOSPreviewApp,
} = {}) {
  const selectedAppPath = normalizeAppPath(appPath);
  if (typeof live !== "boolean") {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "live must be a boolean",
    );
  }
  if (typeof productionClaim !== "boolean") {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "productionClaim must be a boolean",
    );
  }
  const boundedTimeout = normalizeTimeout(timeoutMs);
  const normalizedHealthPaths = normalizeHealthPaths(healthPaths);
  const normalizedEndpointConfig =
    normalizeMacOSPreviewEndpointConfiguration(endpointConfig);
  const validation = await validatePreviewApp(selectedAppPath);
  const local = validatorSummary(validation);
  const metadata = await readMacOSPreviewPublicMetadata(selectedAppPath, {
    readInfoPlist,
  });
  const endpointConfiguration = endpointConfigurationResult(
    metadata,
    normalizedEndpointConfig,
    normalizedHealthPaths,
  );
  const explicitClaimConfiguration = normalizedEndpointConfig !== null
    && typeof normalizedEndpointConfig.centralOrigin === "string"
    && typeof normalizedEndpointConfig.appcastURL === "string";
  if (productionClaim && !explicitClaimConfiguration) {
    return localOnlyRemoteResult(local, metadata, {
      claimReason: "explicit_endpoint_configuration_required",
      endpointConfiguration,
      productionClaim,
    });
  }
  if (!endpointConfiguration.matched) {
    return localOnlyRemoteResult(local, metadata, {
      claimReason: "endpoint_urls_mismatch",
      endpointConfiguration,
      productionClaim,
    });
  }
  if (!live) {
    return localOnlyRemoteResult(local, metadata, {
      endpointConfiguration,
      productionClaim,
    });
  }
  const requestOptions = {
    clock,
    fetchImpl,
    timeoutMs: boundedTimeout,
  };
  const endpoints = [];
  for (const path of endpointConfiguration.healthPaths) {
    const expectedStatuses = path.endsWith("/ready") ? ["ready"] : ["ok"];
    endpoints.push(await checkCentralEndpoint(
      endpointConfiguration.centralOrigin,
      path,
      expectedStatuses,
      requestOptions,
    ));
  }
  const central = Object.freeze({
    checked: true,
    endpoints: Object.freeze(endpoints),
    passed: endpoints.every((endpoint) => endpoint.passed),
    status: endpoints.every((endpoint) => endpoint.passed)
      ? "healthy"
      : "not_ready_or_unavailable",
  });
  const appcastOrigin = new URL(endpointConfiguration.appcastURL).origin;
  const appcast = await checkAppcast(
    endpointConfiguration.appcastURL,
    {
      ...requestOptions,
      expectedArtifactOrigin: productionClaim ? appcastOrigin : null,
      expectedArtifactURL: normalizedEndpointConfig?.artifactURL
        ?? null,
      expectedBundleVersion: productionClaim ? local.bundleVersion : null,
      requireContentAddressed: productionClaim,
    },
  );
  let artifact = artifactNotChecked();
  if (productionClaim && appcast.valid) {
    const expectedArtifactURL = normalizedEndpointConfig.artifactURL ?? null;
    const candidate = appcast.enclosures.find(
      (enclosure) => expectedArtifactURL === null
        ? enclosure.version === local.bundleVersion
        : enclosure.url === expectedArtifactURL,
    );
    artifact = await checkArtifact({
      artifact: candidate,
      clock,
      endpointConfig: normalizedEndpointConfig,
      fetchImpl,
      timeoutMs: boundedTimeout,
    });
  } else if (productionClaim) {
    artifact = artifactNotChecked("appcast_proof_missing");
  }
  const claimPassed = productionClaim
    && central.passed
    && appcast.valid
    && artifact.valid;
  return Object.freeze({
    appcast,
    artifact,
    claim: claimResult(
      productionClaim,
      claimPassed,
      claimPassed
        ? "feed_and_artifact_verified"
        : !central.passed
          ? "central_endpoint_not_healthy"
          : !appcast.valid
            ? `appcast_${appcast.reason}`
            : `artifact_${artifact.reason}`,
    ),
    central,
    endpointConfiguration,
    live: true,
    local,
    metadata,
    overall: productionClaim
      ? (claimPassed ? "ready" : "not_ready")
      : (central.passed && appcast.valid ? "ready" : "not_ready"),
  });
}

function receiptDate(value) {
  if (value === undefined) return new Date().toISOString().slice(0, 10);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.RECEIPT_INVALID,
      "Receipt recordedOn must be an ISO calendar date",
    );
  }
  return value;
}

/**
 * Return a bounded receipt containing only public metadata and verification
 * outcomes. Response bodies, appcast XML, artifact bytes, keys, and paths are
 * intentionally not represented.
 */
export function createMacOSPreviewRemoteReceipt(result, { recordedOn } = {}) {
  if (!result || typeof result !== "object") {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.RECEIPT_INVALID,
      "A verifier result is required for a receipt",
    );
  }
  const endpointConfiguration = result.endpointConfiguration ?? {};
  const appcast = result.appcast ?? {};
  const artifact = result.artifact ?? artifactNotChecked();
  const central = result.central ?? {};
  const claim = result.claim ?? claimResult(false);
  return Object.freeze({
    appcast: Object.freeze({
      checked: appcast.checked === true,
      enclosureCount: Number.isSafeInteger(appcast.enclosureCount)
        ? appcast.enclosureCount
        : 0,
      httpStatus: Number.isInteger(appcast.httpStatus)
        ? appcast.httpStatus
        : null,
      itemCount: Number.isSafeInteger(appcast.itemCount)
        ? appcast.itemCount
        : 0,
      reason: typeof appcast.reason === "string" ? appcast.reason : null,
      status: typeof appcast.status === "string"
        ? appcast.status
        : "not_checked",
      valid: appcast.valid === true,
    }),
    artifact: Object.freeze({
      bytes: Number.isSafeInteger(artifact.bytes) ? artifact.bytes : null,
      checked: artifact.checked === true,
      httpStatus: Number.isInteger(artifact.httpStatus)
        ? artifact.httpStatus
        : null,
      reason: typeof artifact.reason === "string" ? artifact.reason : null,
      sha256: typeof artifact.sha256 === "string" ? artifact.sha256 : null,
      status: typeof artifact.status === "string"
        ? artifact.status
        : "not_checked",
      valid: artifact.valid === true,
    }),
    central: Object.freeze({
      checked: central.checked === true,
      endpointCount: Array.isArray(central.endpoints)
        ? central.endpoints.length
        : 0,
      passed: central.passed === true,
      status: typeof central.status === "string"
        ? central.status
        : "not_checked",
    }),
    claim: Object.freeze({
      passed: claim.passed === true,
      reason: typeof claim.reason === "string" ? claim.reason : null,
      requested: claim.requested === true,
      status: typeof claim.status === "string" ? claim.status : "blocked",
    }),
    contentFree: true,
    endpoint: Object.freeze({
      appcastURL: typeof endpointConfiguration.appcastURL === "string"
        ? endpointConfiguration.appcastURL
        : null,
      centralOrigin: typeof endpointConfiguration.centralOrigin === "string"
        ? endpointConfiguration.centralOrigin
        : null,
      configured: endpointConfiguration.configured === true,
      healthPaths: Object.freeze(
        Array.isArray(endpointConfiguration.healthPaths)
          ? [...endpointConfiguration.healthPaths]
          : [],
      ),
      matched: endpointConfiguration.matched === true,
      mismatchFields: Object.freeze(
        Array.isArray(endpointConfiguration.mismatchFields)
          ? [...endpointConfiguration.mismatchFields]
          : [],
      ),
      source: typeof endpointConfiguration.source === "string"
        ? endpointConfiguration.source
        : "unknown",
      status: typeof endpointConfiguration.status === "string"
        ? endpointConfiguration.status
        : "unknown",
    }),
    local: Object.freeze({
      bundleIdentifier: result.local?.bundleIdentifier ?? null,
      bundleVersion: result.local?.bundleVersion ?? null,
      channel: result.local?.channel ?? null,
      passed: result.local?.passed === true,
      updaterEnabled: result.local?.updaterEnabled === true,
    }),
    networkChecked: result.live === true,
    outcome: typeof result.overall === "string" ? result.overall : "not_ready",
    payloadsRecorded: false,
    recordedOn: receiptDate(recordedOn),
    schemaVersion: MACOS_PREVIEW_REMOTE_RECEIPT_SCHEMA,
  });
}

export async function writeMacOSPreviewRemoteReceipt(path, receipt) {
  const selected = resolve(requiredString(path, "Receipt output path"));
  const document = createMacOSPreviewRemoteReceipt(receipt);
  try {
    await writeFile(
      selected,
      `${JSON.stringify(document, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.RECEIPT_EXISTS,
        "Receipt output already exists",
      );
    }
    throw error;
  }
  return document;
}

const APPCAST_DIAGNOSTICS = Object.freeze({
  bytes_mismatch: "the remote artifact byte count did not match the feed",
  body_too_large: "the response exceeded the bounded body limit",
  digest_missing: "the feed did not provide a content-addressed artifact proof",
  endpoint_urls_mismatch:
    "the explicit endpoints did not match the candidate bundle metadata",
  feed_and_artifact_verified: "the public feed and artifact bytes were verified",
  http_error: "the configured appcast endpoint returned an unexpected HTTP status",
  invalid_response: "the remote response metadata was invalid",
  invalid_xml_or_sparkle_structure:
    "the response was not structurally suitable Sparkle RSS/XML",
  live_not_requested: "live network checks were not requested",
  mismatched_url: "the feed enclosure did not match the configured artifact URL",
  missing: "the configured artifact endpoint returned no artifact",
  network_error: "the HTTPS request failed before a usable response",
  not_published:
    "no signed release appcast is published at the configured URL yet",
  redirect_refused: "a redirect was returned and was not followed",
  sha256_mismatch: "the remote artifact hash did not match the feed proof",
  timeout: "the bounded HTTPS request timed out",
});

export function redactMacOSPreviewDiagnostic(value) {
  let message = typeof value === "string" ? value : "verification failed";
  message = message
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gu, "[redacted]")
    .replace(/\b(?:sk|rk|pk|api[_-]?key|token|secret)[A-Za-z0-9_-]{8,}\b/giu, "[redacted]")
    .replace(/\b[A-Za-z0-9+/]{43}=\b/gu, "[redacted]")
    .replace(/\/Users\/[^\s)]+/gu, "[local-path]");
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

function writeLine(writer, value) {
  if (typeof writer === "function") {
    writer(value);
  } else {
    writer.write(`${value}\n`);
  }
}

function httpStatusLabel(status) {
  return Number.isInteger(status) ? `HTTP ${status}` : "no HTTP response";
}

function renderResult(result, stdout) {
  writeLine(stdout, "Preview application validation: passed");
  writeLine(stdout, `Central origin: ${result.metadata.centralOrigin}`);
  writeLine(stdout, `Sparkle appcast: ${result.metadata.appcastURL}`);
  if (!result.live) {
    writeLine(
      stdout,
      "Remote checks: not run (pass --live for bounded read-only HTTPS checks)",
    );
    writeLine(stdout, "Preview remote readiness: not checked");
    return;
  }
  for (const endpoint of result.central.endpoints) {
    writeLine(
      stdout,
      `Central ${endpoint.path}: ${endpoint.outcome} (${httpStatusLabel(endpoint.httpStatus)})`,
    );
  }
  if (result.appcast.status === "valid") {
    writeLine(
      stdout,
      `Sparkle appcast: valid XML/RSS structurally suitable for Sparkle (${httpStatusLabel(result.appcast.httpStatus)})`,
    );
  } else {
    const diagnostic = APPCAST_DIAGNOSTICS[result.appcast.reason]
      ?? "no valid appcast was observed";
    const status = result.appcast.status.replaceAll("_", " ");
    writeLine(
      stdout,
      `Sparkle appcast: ${status} (${httpStatusLabel(result.appcast.httpStatus)}; ${diagnostic})`,
    );
  }
  if (result.artifact?.checked || result.claim?.requested) {
    const artifactDiagnostic = APPCAST_DIAGNOSTICS[result.artifact?.reason]
      ?? "no verified artifact proof was observed";
    const artifactStatus = result.artifact?.status ?? "not_checked";
    writeLine(
      stdout,
      `Sparkle artifact: ${artifactStatus} (${httpStatusLabel(result.artifact?.httpStatus)}; ${artifactDiagnostic})`,
    );
  }
  writeLine(
    stdout,
    `Preview remote readiness: ${result.overall === "ready" ? "ready" : "not ready"}`,
  );
  if (result.claim?.requested) {
    writeLine(
      stdout,
      `Production claim: ${result.claim.passed ? "passed" : "blocked"}`,
    );
  }
}

export async function runMacOSPreviewRemoteCLI(
  argv,
  {
    environment = process.env,
    stderr = process.stderr,
    stdout = process.stdout,
    verifyRemote = verifyMacOSPreviewRemote,
  } = {},
) {
  try {
    const options = parseMacOSPreviewRemoteArguments(argv, environment);
    if (options.help) {
      writeLine(stdout, "Usage: node scripts/verify-macos-preview-remote.js [options]");
      writeLine(stdout, "  --app PATH          Preview TiboTattle.app to validate");
      writeLine(stdout, "  --live              Perform bounded read-only HTTPS checks");
      writeLine(stdout, "  --central-origin URL  Explicit public central-service origin");
      writeLine(stdout, "  --appcast-url URL   Explicit public Sparkle appcast URL");
      writeLine(stdout, "  --artifact-url URL  Expected public enclosure URL");
      writeLine(stdout, "  --artifact-sha256 HEX64  Expected public artifact SHA-256");
      writeLine(stdout, "  --artifact-bytes N  Expected public artifact byte length");
      writeLine(stdout, "  --health-path PATH  Central health/ready path (repeatable)");
      writeLine(stdout, "  --production-claim  Require a valid feed and artifact proof");
      writeLine(stdout, "  --receipt FILE      Write a content-free JSON receipt");
      writeLine(stdout, "  --timeout-ms N      Per-request timeout, 1..30000 (default 5000)");
      return Object.freeze({ exitCode: 0, result: null });
    }
    const result = await verifyRemote(options);
    if (options.receiptPath !== undefined) {
      await writeMacOSPreviewRemoteReceipt(options.receiptPath, result);
      writeLine(stdout, "Content-free receipt: written");
    }
    renderResult(result, stdout);
    const exitCode = options.productionClaim
      ? (result.claim?.passed === true ? 0 : 1)
      : (options.live && result.overall !== "ready" ? 1 : 0);
    return Object.freeze({ exitCode, result });
  } catch (error) {
    const code = error?.code ?? "MACOS_PREVIEW_REMOTE_FAILED";
    writeLine(
      stderr,
      `macos-preview-remote: ${code}: ${redactMacOSPreviewDiagnostic(error?.message)}`,
    );
    return Object.freeze({ exitCode: 1, result: null });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  runMacOSPreviewRemoteCLI(process.argv.slice(2)).then(({ exitCode }) => {
    if (exitCode !== 0) process.exitCode = exitCode;
  });
}
