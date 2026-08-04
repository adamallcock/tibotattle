#!/usr/bin/env node
import { spawnSync } from "node:child_process";
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
  ARGUMENTS_INVALID: "MACOS_PREVIEW_REMOTE_ARGUMENTS_INVALID",
  FETCH_FAILED: "MACOS_PREVIEW_REMOTE_FETCH_FAILED",
  FETCH_REDIRECT: "MACOS_PREVIEW_REMOTE_FETCH_REDIRECT",
  METADATA_INVALID: "MACOS_PREVIEW_REMOTE_METADATA_INVALID",
  PLIST_INVALID: "MACOS_PREVIEW_REMOTE_PLIST_INVALID",
  RESPONSE_INVALID: "MACOS_PREVIEW_REMOTE_RESPONSE_INVALID",
  TIMEOUT: "MACOS_PREVIEW_REMOTE_TIMEOUT",
});

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
      if (index + 1 >= argv.length) {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
          "--timeout-ms requires a value",
        );
      }
      timeoutMs = parseTimeoutArgument(argv[++index]);
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
        "Unknown macOS preview remote verifier argument",
      );
    }
  }
  return Object.freeze({
    appPath,
    help,
    live,
    timeoutMs,
  });
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
  const outcome = code === MACOS_PREVIEW_REMOTE_CODES.TIMEOUT
    ? "timeout"
    : code === MACOS_PREVIEW_REMOTE_CODES.FETCH_REDIRECT
      ? "redirect_refused"
      : code === MACOS_PREVIEW_REMOTE_CODES.RESPONSE_INVALID
        ? "invalid_response"
        : code === MACOS_PREVIEW_REMOTE_CODES.APPCAST_BODY_TOO_LARGE
          ? "body_too_large"
          : "network_error";
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

function validSparkleSignature(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9+/]{86}==$/u.test(value)
    && Buffer.from(value, "base64").length === 64
    && Buffer.from(value, "base64").toString("base64") === value;
}

function validateAppcastStructure(value) {
  const root = parseXMLDocument(value);
  if (root.name !== "rss"
      || (root.attributes.has("version")
        && root.attributes.get("version") !== "2.0")
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
  for (const item of items) {
    const enclosures = childElements(item, "enclosure");
    if (enclosures.length === 0) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
        "Appcast update item contains no enclosure",
      );
    }
    for (const enclosure of enclosures) {
      const attributes = enclosure.attributes;
      const length = attributes.get("length");
      if (!publicArtifactURL(attributes.get("url"))
          || !/^(?:0|[1-9][0-9]*)$/u.test(length ?? "")
          || typeof attributes.get("sparkle:version") !== "string"
          || attributes.get("sparkle:version").length === 0
          || !validSparkleSignature(attributes.get("sparkle:edSignature"))
          || enclosure.children.length > 0
          || enclosure.text.trim() !== "") {
        throw remoteError(
          MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
          "Appcast enclosure is not structurally suitable for Sparkle",
        );
      }
      enclosureCount += 1;
    }
  }
  return Object.freeze({
    channelCount: channels.length,
    enclosureCount,
    itemCount: items.length,
    root: root.name,
  });
}

export function validateSparkleAppcastXML(value) {
  try {
    return Object.freeze({
      ...validateAppcastStructure(value),
      valid: true,
    });
  } catch (error) {
    return Object.freeze({
      reason: error?.code === MACOS_PREVIEW_REMOTE_CODES.APPCAST_BODY_TOO_LARGE
        ? "body_too_large"
        : "invalid_xml_or_sparkle_structure",
      valid: false,
    });
  }
}

function appcastFailure(error) {
  const failure = requestFailureResult(error);
  return Object.freeze({
    checked: true,
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
      httpStatus: response.status,
      reason: "not_published",
      status: "not_published",
      valid: false,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    return Object.freeze({
      checked: true,
      httpStatus: response.status,
      reason: "http_error",
      status: "unavailable",
      valid: false,
    });
  }
  const structure = validateSparkleAppcastXML(response.body);
  if (!structure.valid) {
    return Object.freeze({
      checked: true,
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

function localOnlyRemoteResult(local, metadata) {
  return Object.freeze({
    appcast: Object.freeze({
      checked: false,
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
    live: false,
    local,
    metadata,
    overall: "local_valid_remote_unchecked",
  });
}

export async function verifyMacOSPreviewRemote({
  appPath,
  clock = DEFAULT_CLOCK,
  fetchImpl = globalThis.fetch,
  healthPaths = MACOS_PREVIEW_REMOTE_HEALTH_PATHS,
  live = false,
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
  const boundedTimeout = normalizeTimeout(timeoutMs);
  if (!Array.isArray(healthPaths) || healthPaths.length === 0) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      "At least one central health or ready endpoint is required",
    );
  }
  const validation = await validatePreviewApp(selectedAppPath);
  const local = validatorSummary(validation);
  const metadata = await readMacOSPreviewPublicMetadata(selectedAppPath, {
    readInfoPlist,
  });
  if (!live) return localOnlyRemoteResult(local, metadata);
  const requestOptions = {
    clock,
    fetchImpl,
    timeoutMs: boundedTimeout,
  };
  const endpoints = [];
  for (const path of healthPaths) {
    if (typeof path !== "string" || !/^\/[^/]/u.test(path)) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
        "Central health endpoint paths must be absolute paths",
      );
    }
    const expectedStatuses = path.endsWith("/ready") ? ["ready"] : ["ok"];
    endpoints.push(await checkCentralEndpoint(
      metadata.centralOrigin,
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
  const appcast = await checkAppcast(metadata.appcastURL, requestOptions);
  return Object.freeze({
    appcast,
    central,
    live: true,
    local,
    metadata,
    overall: central.passed && appcast.valid ? "ready" : "not_ready",
  });
}

const APPCAST_DIAGNOSTICS = Object.freeze({
  body_too_large: "the response exceeded the bounded body limit",
  http_error: "the configured appcast endpoint returned an unexpected HTTP status",
  invalid_xml_or_sparkle_structure:
    "the response was not structurally suitable Sparkle RSS/XML",
  live_not_requested: "live network checks were not requested",
  network_error: "the HTTPS request failed before a usable response",
  not_published:
    "no signed release appcast is published at the configured URL yet",
  redirect_refused: "a redirect was returned and was not followed",
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
  writeLine(
    stdout,
    `Preview remote readiness: ${result.overall === "ready" ? "ready" : "not ready"}`,
  );
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
      writeLine(stdout, "  --timeout-ms N      Per-request timeout, 1..30000 (default 5000)");
      return Object.freeze({ exitCode: 0, result: null });
    }
    const result = await verifyRemote(options);
    renderResult(result, stdout);
    const exitCode = options.live && result.overall !== "ready" ? 1 : 0;
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
