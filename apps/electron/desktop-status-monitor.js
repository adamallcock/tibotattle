import { isExactLoopbackOrigin } from "./loopback-policy.js";
import {
  DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
  validateDesktopShellStatus,
} from "../../src/desktop-shell-status.js";

/**
 * Main-process-only poller for the content-free companion status route.
 *
 * The monitor is intentionally a very small boundary.  It constructs one
 * fixed URL from the companion origin supplied by the main process, accepts
 * one exact JSON status contract, and exposes only a frozen validated status
 * to its caller.  It never forwards a response, error, URL, path, or
 * provider/account detail to the shell.
 */

export const DESKTOP_STATUS_PATH = "/api/local/desktop-status";
export const DESKTOP_STATUS_DEFAULT_INTERVAL_MS = 5_000;
export const DESKTOP_STATUS_DEFAULT_TIMEOUT_MS = 5_000;
export const DESKTOP_STATUS_MIN_INTERVAL_MS = 1;
export const DESKTOP_STATUS_MAX_INTERVAL_MS = 60_000;
export const DESKTOP_STATUS_MIN_TIMEOUT_MS = 1;
export const DESKTOP_STATUS_MAX_TIMEOUT_MS = 60_000;
export const DESKTOP_STATUS_DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const DESKTOP_STATUS_MIN_BODY_BYTES = 1;
export const DESKTOP_STATUS_MAX_BODY_BYTES = 256 * 1024;

const UNAVAILABLE_STATUS = validateDesktopShellStatus({
  schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
  state: "unavailable",
  allowance: null,
  notificationEvidence: null,
});
const STARTING_STATUS = validateDesktopShellStatus({
  schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
  state: "starting",
  allowance: null,
  notificationEvidence: null,
});

function assertBoundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `${label} must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function assertOrigin(value) {
  if (!isExactLoopbackOrigin(value)) {
    throw new TypeError("desktop status origin is invalid");
  }
  return value;
}

function exactStatusURL(origin) {
  const url = `${origin}${DESKTOP_STATUS_PATH}`;
  // The origin has already been validated by loopback-policy.js.  Keep this
  // second check local to the route boundary so a future path edit cannot
  // silently broaden the request to an arbitrary URL.
  const parsed = new URL(url);
  if (parsed.origin !== origin
      || parsed.protocol !== "http:"
      || parsed.hostname !== "127.0.0.1"
      || parsed.pathname !== DESKTOP_STATUS_PATH
      || parsed.search !== ""
      || parsed.hash !== ""
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.href !== url) {
    throw new TypeError("desktop status URL is invalid");
  }
  return url;
}

function responseHeader(response, name) {
  const headers = response?.headers;
  if (headers === null || headers === undefined) return null;
  if (typeof headers.get !== "function") {
    throw new TypeError("desktop status response headers are invalid");
  }
  const value = headers.get(name);
  return value === null || value === undefined ? null : value;
}

function validateResponseEnvelope(response, requestURL) {
  if (response === null
      || typeof response !== "object"
      || response.status !== 200
      || response.redirected === true) {
    throw new TypeError("desktop status response is invalid");
  }
  // Native fetch exposes the final URL. A test double may omit it, but if it
  // is present it must prove that no redirect or alternate origin occurred.
  if (response.url !== undefined
      && (typeof response.url !== "string" || response.url !== requestURL)) {
    throw new TypeError("desktop status response URL is invalid");
  }
  const contentType = responseHeader(response, "content-type");
  if (contentType !== null
      && (typeof contentType !== "string"
        || contentType.split(";", 1)[0].trim().toLowerCase()
          !== "application/json")) {
    throw new TypeError("desktop status response type is invalid");
  }
  const declaredLength = responseHeader(response, "content-length");
  if (declaredLength !== null) {
    if (typeof declaredLength !== "string" || !/^\d+$/u.test(declaredLength)) {
      throw new TypeError("desktop status response length is invalid");
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError("desktop status response length is invalid");
    }
  }
}

function declaredResponseLength(response) {
  const declaredLength = responseHeader(response, "content-length");
  if (declaredLength === null) return null;
  return Number(declaredLength);
}

function ignoreCancellationRejection(value) {
  if (value === null || value === undefined) return;
  try {
    Promise.resolve(value).catch(() => {});
  } catch {
    // Cancellation is best-effort and must never surface raw body errors.
  }
}

function cancelBody(body) {
  if (body === null || body === undefined
      || typeof body.cancel !== "function") {
    return false;
  }
  try {
    ignoreCancellationRejection(body.cancel());
    return true;
  } catch {
    return false;
  }
}

function cancelReadableBody(body) {
  if (cancelBody(body)) return true;
  if (body === null || body === undefined
      || typeof body.getReader !== "function") {
    return false;
  }
  let reader;
  try {
    reader = body.getReader();
  } catch {
    return false;
  }
  const cancelled = cancelBody(reader);
  try {
    reader.releaseLock?.();
  } catch {
    // Releasing a cancelled native reader is best-effort.
  }
  return cancelled;
}

async function readBoundedText(response, maximumBytes, {
  abort,
  isCancelled,
  registerReader,
  unregisterReader,
}) {
  const declaredLength = declaredResponseLength(response);
  if (declaredLength !== null && declaredLength > maximumBytes) {
    abort();
    throw new TypeError("desktop status response is too large");
  }

  if (response.body !== null
      && response.body !== undefined
      && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    registerReader(reader, response.body);
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        if (isCancelled()) {
          throw new TypeError("desktop status response cancelled");
        }
        const item = await reader.read();
        if (isCancelled()) {
          throw new TypeError("desktop status response cancelled");
        }
        if (item?.done === true) break;
        const chunk = item?.value;
        if (!(chunk instanceof Uint8Array)) {
          abort();
          throw new TypeError("desktop status response body is invalid");
        }
        total += chunk.byteLength;
        if (total > maximumBytes) {
          abort();
          cancelBody(reader);
          throw new TypeError("desktop status response is too large");
        }
        chunks.push(chunk);
      }
    } finally {
      unregisterReader(reader, response.body);
      try {
        reader.releaseLock?.();
      } catch {
        // Releasing a cancelled native reader is best-effort.
      }
    }
    if (isCancelled()) {
      throw new TypeError("desktop status response cancelled");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new TypeError("desktop status response text is invalid");
    }
  }

  if (typeof response.text !== "function") {
    throw new TypeError("desktop status response body is unavailable");
  }
  const body = response.body;
  registerReader(null, body);
  try {
    const text = await response.text();
    if (isCancelled()) {
      throw new TypeError("desktop status response cancelled");
    }
    if (typeof text !== "string") {
      throw new TypeError("desktop status response text is invalid");
    }
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      abort();
      throw new TypeError("desktop status response is too large");
    }
    return text;
  } finally {
    unregisterReader(null, body);
  }
}

function unrefTimer(timer) {
  timer?.unref?.();
  return timer;
}

function fixedUnavailable() {
  return UNAVAILABLE_STATUS;
}

function safeNotify(onStatus, status) {
  try {
    onStatus(status);
  } catch {
    // A shell observer must not turn a valid poll into an unbounded or raw
    // error-bearing rejection. The monitor remains usable on the next tick.
  }
}

function assertOptions(options) {
  if (options === null
      || typeof options !== "object"
      || Array.isArray(options)) {
    throw new TypeError("desktop status monitor options are invalid");
  }
  const allowed = new Set([
    "fetchImpl",
    "setTimeoutImpl",
    "clearTimeoutImpl",
    "AbortControllerImpl",
    "intervalMs",
    "timeoutMs",
    "maxBodyBytes",
    "onStatus",
  ]);
  if (Reflect.ownKeys(options).some((key) => !allowed.has(key))) {
    throw new TypeError("desktop status monitor options have unexpected fields");
  }
  return options;
}

export function createDesktopStatusMonitor(options = {}) {
  const configuration = assertOptions(options);
  const fetchImpl = configuration.fetchImpl ?? globalThis.fetch;
  const setTimeoutImpl = configuration.setTimeoutImpl ?? globalThis.setTimeout;
  const clearTimeoutImpl = configuration.clearTimeoutImpl ?? globalThis.clearTimeout;
  const AbortControllerImpl = configuration.AbortControllerImpl
    ?? globalThis.AbortController;
  const intervalMs = assertBoundedInteger(
    configuration.intervalMs ?? DESKTOP_STATUS_DEFAULT_INTERVAL_MS,
    "desktop status intervalMs",
    DESKTOP_STATUS_MIN_INTERVAL_MS,
    DESKTOP_STATUS_MAX_INTERVAL_MS,
  );
  const timeoutMs = assertBoundedInteger(
    configuration.timeoutMs ?? DESKTOP_STATUS_DEFAULT_TIMEOUT_MS,
    "desktop status timeoutMs",
    DESKTOP_STATUS_MIN_TIMEOUT_MS,
    DESKTOP_STATUS_MAX_TIMEOUT_MS,
  );
  const maxBodyBytes = assertBoundedInteger(
    configuration.maxBodyBytes ?? DESKTOP_STATUS_DEFAULT_MAX_BODY_BYTES,
    "desktop status maxBodyBytes",
    DESKTOP_STATUS_MIN_BODY_BYTES,
    DESKTOP_STATUS_MAX_BODY_BYTES,
  );
  const onStatus = configuration.onStatus ?? (() => {});

  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  if (typeof setTimeoutImpl !== "function") throw new TypeError("setTimeoutImpl is required");
  if (typeof clearTimeoutImpl !== "function") throw new TypeError("clearTimeoutImpl is required");
  if (typeof AbortControllerImpl !== "function") {
    throw new TypeError("AbortControllerImpl is required");
  }
  if (typeof onStatus !== "function") throw new TypeError("onStatus is required");

  let running = false;
  let origin = null;
  let generation = 0;
  let scheduledTimer = null;
  let inFlight = null;
  let activeBodyOperations = 0;

  function clearScheduledTimer() {
    if (scheduledTimer === null) return;
    try {
      clearTimeoutImpl(scheduledTimer);
    } catch {
      // Timer cleanup must remain best-effort during shutdown.
    }
    scheduledTimer = null;
  }

  function abortInFlight() {
    try {
      inFlight?.controller?.abort?.();
    } catch {
      // The generation check below still prevents a late response from being
      // delivered even if a test double/native controller rejects abort().
    }
  }

  function cancelInFlight() {
    const request = inFlight;
    if (request === null) return;
    abortInFlight();
    try {
      request.settle?.(null);
    } catch {
      // A shutdown path remains best-effort even if an injected timer cleanup
      // implementation throws. The generation check still blocks late work.
    }
    if (inFlight === request) inFlight = null;
  }

  function unavailableWhileBodyIsPending(nextGeneration) {
    const status = fixedUnavailable();
    if (running && generation === nextGeneration) {
      safeNotify(onStatus, status);
      schedule(nextGeneration);
    }
    return status;
  }

  function schedule(nextGeneration) {
    if (!running || generation !== nextGeneration || scheduledTimer !== null) {
      return;
    }
    try {
      scheduledTimer = unrefTimer(setTimeoutImpl(() => {
        scheduledTimer = null;
        void pollGeneration(nextGeneration);
      }, intervalMs));
    } catch {
      if (running && generation === nextGeneration) {
        safeNotify(onStatus, fixedUnavailable());
      }
    }
  }

  function pollGeneration(nextGeneration) {
    if (!running || generation !== nextGeneration || origin === null) return null;
    if (inFlight !== null) return inFlight.promise;
    // A response body can ignore both AbortSignal and reader.cancel(). Keep
    // at most one such abandoned body alive; starting another read on every
    // retry would otherwise retain an unbounded chain of readers/promises.
    if (activeBodyOperations > 0) {
      return unavailableWhileBodyIsPending(nextGeneration);
    }

    let controller;
    try {
      controller = new AbortControllerImpl();
    } catch {
      const status = fixedUnavailable();
      if (running && generation === nextGeneration) safeNotify(onStatus, status);
      schedule(nextGeneration);
      return status;
    }
    const requestURL = exactStatusURL(origin);
    const request = {
      controller,
      promise: null,
      timeoutTimer: null,
      settled: false,
      settle: null,
      response: null,
      activeReader: null,
      activeBody: null,
      bodyCancelled: false,
      bodyOperationActive: false,
    };

    let resolveRequest;
    request.promise = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    request.cancelBody = () => {
      if (request.bodyCancelled) return;
      request.bodyCancelled = true;
      const readerCancelled = cancelBody(request.activeReader);
      if (!readerCancelled) cancelReadableBody(request.activeBody);
    };

    request.settle = (status) => {
      if (request.settled) return;
      request.settled = true;
      if (status === null || status === UNAVAILABLE_STATUS) {
        request.cancelBody();
      }
      if (request.timeoutTimer !== null) {
        try {
          clearTimeoutImpl(request.timeoutTimer);
        } catch {
          // Timer cleanup is best-effort.
        }
        request.timeoutTimer = null;
      }
      if (inFlight === request) inFlight = null;
      if (!running || generation !== nextGeneration) {
        resolveRequest(null);
        return;
      }
      if (status !== null) safeNotify(onStatus, status);
      schedule(nextGeneration);
      resolveRequest(status);
    };

    // Publish the request before starting either the timer or the operation.
    // This keeps an injected timer that fires synchronously from leaving a
    // stale request in `inFlight` after its hard timeout has settled.
    inFlight = request;

    try {
      const timeoutTimer = unrefTimer(setTimeoutImpl(() => {
        if (request.settled) return;
        try {
          controller.abort();
        } catch {
          // The hard timeout below remains authoritative even if an injected
          // or native controller rejects abort().
        }
        request.settle(fixedUnavailable());
      }, timeoutMs));
      if (request.settled) {
        try {
          clearTimeoutImpl(timeoutTimer);
        } catch {
          // Timer cleanup is best-effort.
        }
      } else {
        request.timeoutTimer = timeoutTimer;
      }
    } catch {
      request.settle(fixedUnavailable());
      return request.promise;
    }

    void (async () => {
      const response = await fetchImpl(requestURL, {
        method: "GET",
        headers: Object.freeze({ Accept: "application/json" }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      request.response = response;
      request.activeBody = response?.body ?? null;
      if (request.settled || !running || generation !== nextGeneration) {
        cancelReadableBody(response?.body);
        return null;
      }
      validateResponseEnvelope(response, requestURL);
      activeBodyOperations += 1;
      request.bodyOperationActive = true;
      const body = await readBoundedText(
        response,
        maxBodyBytes,
        {
          abort: () => controller.abort(),
          isCancelled: () => request.settled
            || !running
            || generation !== nextGeneration,
          registerReader: (reader, bodyStream) => {
            request.activeReader = reader;
            request.activeBody = bodyStream;
          },
          unregisterReader: (reader, bodyStream) => {
            if (request.activeReader === reader) request.activeReader = null;
            if (request.activeBody === bodyStream) request.activeBody = null;
          },
        },
      );
      return validateDesktopShellStatus(JSON.parse(body));
    })().finally(() => {
      if (request.bodyOperationActive) {
        request.bodyOperationActive = false;
        activeBodyOperations -= 1;
      }
    }).then(
      (status) => request.settle(status),
      () => request.settle(fixedUnavailable()),
    );
    return request.promise;
  }

  function start(nextOrigin) {
    const selectedOrigin = assertOrigin(nextOrigin);
    clearScheduledTimer();
    generation += 1;
    cancelInFlight();
    origin = selectedOrigin;
    running = true;
    safeNotify(onStatus, STARTING_STATUS);
    const nextGeneration = generation;
    try {
      scheduledTimer = unrefTimer(setTimeoutImpl(() => {
        scheduledTimer = null;
        void pollGeneration(nextGeneration);
      }, 0));
    } catch {
      safeNotify(onStatus, fixedUnavailable());
    }
    return Object.freeze({ origin: selectedOrigin });
  }

  function stop() {
    running = false;
    generation += 1;
    origin = null;
    clearScheduledTimer();
    cancelInFlight();
    return undefined;
  }

  function pollNow() {
    if (!running || origin === null) return Promise.resolve(null);
    return pollGeneration(generation);
  }

  return Object.freeze({
    start,
    stop,
    pollNow,
  });
}
