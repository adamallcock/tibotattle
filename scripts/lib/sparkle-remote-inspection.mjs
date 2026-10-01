/** Bounded HTTPS and strict Sparkle XML inspection for release readiness. */
import { isAppleMacOSBundleVersion, isLegacyZeroFirstMacOSBundleVersion } from "../macos-bundle-version.js";

const MAX_APPCAST_BYTES = 1024 * 1024;
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
// A TiboTattle DMG is a product-sized installer, not an arbitrary remote
// object. Keep the readback cap finite enough that a bad endpoint cannot turn
// this observer into a multi-GB downloader.
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const SPARKLE_NAMESPACE =
  "http://www.andymatuschak.org/xml-namespaces/sparkle";
const XML_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/u;
const XML_ENTITY_PATTERN = /&(?:amp|lt|gt|apos|quot|#[0-9]+|#x[0-9A-Fa-f]+);/gu;
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const MACOS_PREVIEW_REMOTE_CODES = Object.freeze({
  APPCAST_BODY_TOO_LARGE: "MACOS_PREVIEW_REMOTE_APPCAST_BODY_TOO_LARGE",
  APPCAST_CANDIDATE_INVALID: "MACOS_PREVIEW_REMOTE_APPCAST_CANDIDATE_INVALID",
  APPCAST_INVALID: "MACOS_PREVIEW_REMOTE_APPCAST_INVALID",
  APPCAST_NOT_PUBLISHED: "MACOS_PREVIEW_REMOTE_APPCAST_NOT_PUBLISHED",
  APPCAST_URL_MISMATCH: "MACOS_PREVIEW_REMOTE_APPCAST_URL_MISMATCH",
  ARGUMENTS_INVALID: "MACOS_PREVIEW_REMOTE_ARGUMENTS_INVALID",
  ARTIFACT_BODY_TOO_LARGE: "MACOS_PREVIEW_REMOTE_ARTIFACT_BODY_TOO_LARGE",
  ARTIFACT_CONTENT_LENGTH_MISMATCH:
    "MACOS_PREVIEW_REMOTE_ARTIFACT_CONTENT_LENGTH_MISMATCH",
  ARTIFACT_CONTENT_LENGTH_MISSING:
    "MACOS_PREVIEW_REMOTE_ARTIFACT_CONTENT_LENGTH_MISSING",
  ARTIFACT_INVALID: "MACOS_PREVIEW_REMOTE_ARTIFACT_INVALID",
  FETCH_FAILED: "MACOS_PREVIEW_REMOTE_FETCH_FAILED",
  FETCH_REDIRECT: "MACOS_PREVIEW_REMOTE_FETCH_REDIRECT",
  CHANNEL_ENDPOINT_OVERRIDE_FORBIDDEN:
    "MACOS_PREVIEW_REMOTE_CHANNEL_ENDPOINT_OVERRIDE_FORBIDDEN",
  CHANNEL_INVALID: "MACOS_PREVIEW_REMOTE_CHANNEL_INVALID",
  CHANNEL_METADATA_MISMATCH: "MACOS_PREVIEW_REMOTE_CHANNEL_METADATA_MISMATCH",
  CHANNEL_NOT_CONFIGURED: "MACOS_PREVIEW_REMOTE_CHANNEL_NOT_CONFIGURED",
  CHANNEL_REMOTE_FORBIDDEN: "MACOS_PREVIEW_REMOTE_CHANNEL_REMOTE_FORBIDDEN",
  CHANNEL_POLICY_INVALID: "MACOS_PREVIEW_REMOTE_CHANNEL_POLICY_INVALID",
  METADATA_INVALID: "MACOS_PREVIEW_REMOTE_METADATA_INVALID",
  PLIST_INVALID: "MACOS_PREVIEW_REMOTE_PLIST_INVALID",
  RECEIPT_EXISTS: "MACOS_PREVIEW_REMOTE_RECEIPT_EXISTS",
  RECEIPT_INVALID: "MACOS_PREVIEW_REMOTE_RECEIPT_INVALID",
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

function normalizeTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.ARGUMENTS_INVALID,
      `Timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} milliseconds`,
    );
  }
  return value;
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

function contentAddressedArtifact(value, {
  allowLegacyZeroFirstBundleVersion = false,
  objectPrefix = "releases",
} = {}) {
  if (!publicArtifactURL(value)) return null;
  const selected = new URL(value);
  const segments = selected.pathname.slice(1).split("/");
  const prefixSegments = objectPrefix.split("/");
  if (!prefixSegments.every((segment) =>
    SAFE_PATH_SEGMENT_PATTERN.test(segment)
    && segment !== "."
    && segment !== "..")) {
    return null;
  }
  const versionIndex = prefixSegments.length;
  if (segments.length !== versionIndex + 3
      || !prefixSegments.every((segment, index) => segments[index] === segment)
      || (!isAppleMacOSBundleVersion(segments[versionIndex] ?? "")
        && !(allowLegacyZeroFirstBundleVersion
          && isLegacyZeroFirstMacOSBundleVersion(
            segments[versionIndex] ?? "",
          )))
      || !/^[a-f0-9]{64}$/u.test(segments[versionIndex + 1] ?? "")
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:dmg|delta)$/u.test(
        segments[versionIndex + 2] ?? "",
      )) {
    return null;
  }
  return Object.freeze({
    artifactType: segments[versionIndex + 2].endsWith(".dmg")
      ? "full_dmg"
      : "delta",
    bundleVersion: segments[versionIndex],
    fileName: segments[versionIndex + 2],
    sha256: segments[versionIndex + 1],
  });
}

function validSparkleSignatureShape(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9+/]{86}==$/u.test(value)
    && Buffer.from(value, "base64").length === 64
    && Buffer.from(value, "base64").toString("base64") === value;
}

function validateAppcastStructure(value, {
  allowLegacyZeroFirstBundleVersion = false,
  expectedArtifactOrigin = null,
  expectedArtifactURL = null,
  expectedArtifactPrefix = "releases",
  expectedBundleVersion = null,
  requireContentAddressed = false,
  requireSingleFullDmg = false,
} = {}) {
  const acceptsExactLegacyBundleVersion =
    allowLegacyZeroFirstBundleVersion
    && isLegacyZeroFirstMacOSBundleVersion(expectedBundleVersion);
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
    const itemVersionElements = childElements(item, "sparkle:version");
    if (itemVersionElements.length > 1) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
        "Appcast update item contains multiple Sparkle versions",
      );
    }
    const itemVersionElement = itemVersionElements[0] ?? null;
    const itemVersion = itemVersionElement === null
      ? null
      : itemVersionElement.text.trim();
    if (itemVersionElement !== null
        && (itemVersionElement.children.length > 0 || itemVersion === "")) {
      throw remoteError(
        MACOS_PREVIEW_REMOTE_CODES.APPCAST_INVALID,
        "Appcast update item has an invalid Sparkle version",
      );
    }
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
      const enclosureVersion = attributes.get("sparkle:version") ?? null;
      const version = enclosureVersion ?? itemVersion;
      const length = attributes.get("length");
      const lengthNumber = Number(length);
      const contentAddress = contentAddressedArtifact(artifactURL, {
        allowLegacyZeroFirstBundleVersion: acceptsExactLegacyBundleVersion,
        objectPrefix: expectedArtifactPrefix,
      });
      if (!publicArtifactURL(artifactURL)
          || !/^(?:0|[1-9][0-9]*)$/u.test(length ?? "")
          || !Number.isSafeInteger(lengthNumber)
          || lengthNumber < 1
          || lengthNumber > MAX_ARTIFACT_BYTES
          || typeof version !== "string"
          || version.length === 0
          || (enclosureVersion !== null
            && itemVersion !== null
            && enclosureVersion !== itemVersion)
          || !validSparkleSignatureShape(attributes.get("sparkle:edSignature"))
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
        artifactType: contentAddress?.artifactType ?? null,
        artifactVersion: contentAddress?.bundleVersion ?? null,
        length: lengthNumber,
        // Base64/64-byte shape only; this is never cryptographic proof.
        signatureStructurallyValid: true,
        url: artifactURL,
        version,
      }));
    }
  }
  if (requireSingleFullDmg
      && (enclosures.length !== 1
        || enclosures[0]?.artifactType !== "full_dmg")) {
    throw remoteError(
      MACOS_PREVIEW_REMOTE_CODES.APPCAST_CANDIDATE_INVALID,
      "The update gate requires exactly one full-DMG enclosure and rejects deltas or ambiguity",
    );
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
        : error?.code === MACOS_PREVIEW_REMOTE_CODES.APPCAST_CANDIDATE_INVALID
          ? "single_full_dmg_required"
        : error?.code === MACOS_PREVIEW_REMOTE_CODES.APPCAST_URL_MISMATCH
          ? "mismatched_url"
          : "invalid_xml_or_sparkle_structure",
      valid: false,
    });
  }
}
