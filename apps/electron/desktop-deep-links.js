/**
 * Content-free desktop app-link contract.
 *
 * The native client deliberately registers one semantic wake target:
 * `usagemonitor://open`.  It is not an OAuth redirect and it never carries a
 * provider, account, token, path, selector, or navigation destination.  A
 * browser completes hosted sign-in in its own page and uses this link only to
 * wake the existing app so that the page can poll its already-owned handoff.
 *
 * Keep this module independent of Electron.  The main process can feed it
 * macOS `open-url` values, Windows second-instance argv, and Linux argv while
 * tests exercise the exact same parser and queue.
 */

export const DESKTOP_DEEP_LINK_SCHEME = "usagemonitor";
export const DESKTOP_DEEP_LINK_HOST = "open";
export const DESKTOP_DEEP_LINK_CANONICAL_URL =
  `${DESKTOP_DEEP_LINK_SCHEME}://${DESKTOP_DEEP_LINK_HOST}`;
export const DESKTOP_DEEP_LINK_TARGETS = Object.freeze([
  DESKTOP_DEEP_LINK_HOST,
]);

// A desktop link is intentionally much smaller than this limit.  The bound
// prevents an argv or open-url caller from turning the shell's pending queue
// into an unbounded string-retention surface if the contract grows later.
export const DESKTOP_DEEP_LINK_MAX_BYTES = 256;
export const DESKTOP_DEEP_LINK_QUEUE_LIMIT = 8;

const ROOT_SLASH_URL = `${DESKTOP_DEEP_LINK_CANONICAL_URL}/`;
const OPEN_TARGET = Object.freeze({
  target: DESKTOP_DEEP_LINK_HOST,
  canonicalURL: DESKTOP_DEEP_LINK_CANONICAL_URL,
});

function isPrintableAscii(value) {
  // The accepted URL has an ASCII scheme/host and an optional ASCII root
  // slash.  Rejecting every other code point before normalization also stops
  // WHATWG URL parsing from trimming controls or normalizing Unicode into a
  // different URL than the user supplied.
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint < 0x21 || codePoint > 0x7e) return false;
    if (codePoint > 0xffff) index += 1;
  }
  return true;
}

function byteLength(value) {
  // The printable-ASCII check currently makes this equal to value.length,
  // but retaining a byte-oriented limit makes the contract safe if the
  // parser gains another ASCII-only target with a different representation.
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Parse and normalize one external app-link value.
 *
 * Native `SemanticOpenTarget` compares scheme and host case-insensitively and
 * permits only an empty path or `/`.  The exact ASCII comparison below is
 * stricter than generic URL parsing: it rejects credentials, ports, query and
 * fragment data, percent-encoded host/path tricks, backslashes, whitespace,
 * and every arbitrary navigation payload before returning a semantic value.
 *
 * @returns {Readonly<{target: "open", canonicalURL: "usagemonitor://open"}>|null}
 */
export function parseDesktopDeepLink(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.length > DESKTOP_DEEP_LINK_MAX_BYTES
      || !isPrintableAscii(value)
      || byteLength(value) > DESKTOP_DEEP_LINK_MAX_BYTES) {
    return null;
  }

  const lower = value.toLowerCase();
  if (lower !== DESKTOP_DEEP_LINK_CANONICAL_URL && lower !== ROOT_SLASH_URL) {
    return null;
  }
  return OPEN_TARGET;
}

/** Alias whose name makes the canonicalization boundary explicit to callers. */
export function normalizeDesktopDeepLink(value) {
  return parseDesktopDeepLink(value);
}

export function isDesktopDeepLink(value) {
  return parseDesktopDeepLink(value) !== null;
}

/**
 * Select accepted links from a platform argv vector.
 *
 * Non-link arguments are ignored because the normal executable path, Electron
 * switches, and unrelated user arguments are expected in argv.  A malformed
 * custom-scheme value is never converted into a navigation request; it simply
 * produces no semantic target.
 */
export function extractDesktopDeepLinks(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const accepted = [];
  for (const value of argv) {
    const link = parseDesktopDeepLink(value);
    if (link !== null) accepted.push(link);
  }
  return Object.freeze(accepted);
}

function queueLimit(value) {
  if (value === undefined) return DESKTOP_DEEP_LINK_QUEUE_LIMIT;
  if (!Number.isSafeInteger(value)
      || value < 1
      || value > DESKTOP_DEEP_LINK_QUEUE_LIMIT) {
    throw new TypeError("maxSize must be a positive bounded integer");
  }
  return value;
}

/**
 * Create a FIFO queue for links received before the dashboard is ready.
 *
 * The queue owns only frozen semantic targets, never the raw URL.  Overflow
 * drops the oldest entry so a recent foreground/wake event remains available;
 * callers can drain after the lifecycle reaches a usable state.  The optional
 * smaller maxSize is useful for a test or a deliberately tighter embedding;
 * values above the fixed production bound are rejected.
 */
export function createDesktopDeepLinkQueue(options = {}) {
  if (options === null
      || typeof options !== "object"
      || Array.isArray(options)
      || Object.getPrototypeOf(options) !== Object.prototype
      || Reflect.ownKeys(options).some((key) => key !== "maxSize")) {
    throw new TypeError("queue options must be a plain object");
  }
  const { maxSize } = options;
  const limit = queueLimit(maxSize);
  const pending = [];

  function enqueue(value) {
    const link = parseDesktopDeepLink(value);
    if (link === null) return null;
    if (pending.length >= limit) pending.shift();
    pending.push(link);
    return link;
  }

  function enqueueMany(values) {
    if (!Array.isArray(values)) throw new TypeError("values must be an array");
    const accepted = [];
    for (const value of values) {
      const link = enqueue(value);
      if (link !== null) accepted.push(link);
    }
    return Object.freeze(accepted);
  }

  function peek() {
    return pending[0] ?? null;
  }

  function drain() {
    return Object.freeze(pending.splice(0));
  }

  function clear() {
    pending.length = 0;
  }

  return Object.freeze({
    enqueue,
    enqueueMany,
    peek,
    drain,
    clear,
    get size() {
      return pending.length;
    },
    get maxSize() {
      return limit;
    },
  });
}
