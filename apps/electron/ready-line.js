import { shellError } from "./errors.js";

export const COMPANION_READY_LINE_PREFIX = "USAGE_MONITOR_READY ";
export const COMPANION_READY_LINE_MAX_BYTES = 1_024;

const READY_LINE = /^USAGE_MONITOR_READY (http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/)\n$/u;

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Parse the one line the companion is allowed to use as a readiness signal.
 * Other stdout lines are deliberately ignored so diagnostics cannot become a
 * control channel. A line that starts like the readiness signal but is not
 * exact is an error, not a best-effort URL parse.
 */
export function parseCompanionReadyLine(line) {
  if (typeof line !== "string") return null;
  if (!line.startsWith(COMPANION_READY_LINE_PREFIX)) return null;
  if (byteLength(line) > COMPANION_READY_LINE_MAX_BYTES) {
    throw shellError("companion_ready_overflow");
  }
  const match = READY_LINE.exec(line);
  if (!match) throw shellError("companion_ready_invalid");
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw shellError("companion_ready_invalid");
  }
  return Object.freeze({
    origin: match[1].slice(0, -1),
    url: match[1],
    port,
  });
}

/**
 * Incrementally parse child stdout without buffering unbounded output. The
 * callback receives at most one readiness record. Once ready is observed,
 * later output is ignored and cannot alter the selected origin.
 */
export function createCompanionReadyLineParser({ onReady } = {}) {
  if (onReady !== undefined && typeof onReady !== "function") {
    throw new TypeError("onReady must be a function");
  }
  let buffer = "";
  let ready = null;
  let finished = false;

  function feed(chunk) {
    if (finished) return ready;
    const text = typeof chunk === "string"
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : null;
    if (text === null) throw new TypeError("chunk must be text or a buffer");
    buffer += text;
    if (byteLength(buffer) > COMPANION_READY_LINE_MAX_BYTES * 2) {
      // The parser permits ordinary bounded diagnostics before readiness, but
      // never allows a child to make the launcher retain arbitrary output.
      throw shellError("companion_ready_overflow");
    }
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        if (byteLength(buffer) > COMPANION_READY_LINE_MAX_BYTES) {
          throw shellError("companion_ready_overflow");
        }
        break;
      }
      const line = buffer.slice(0, newline + 1);
      buffer = buffer.slice(newline + 1);
      const parsed = parseCompanionReadyLine(line);
      if (parsed !== null) {
        ready = parsed;
        finished = true;
        onReady?.(parsed);
        break;
      }
    }
    return ready;
  }

  function finish() {
    if (finished) return ready;
    if (buffer.startsWith(COMPANION_READY_LINE_PREFIX)) {
      throw shellError("companion_ready_invalid");
    }
    finished = true;
    return ready;
  }

  return Object.freeze({
    feed,
    finish,
    get ready() {
      return ready;
    },
  });
}
