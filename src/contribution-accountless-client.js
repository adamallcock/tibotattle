import { ensureContributionDeviceCapability } from "./contribution-device-capability.js";

export const ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION = "accountless-enrollment-v0.1";
export const ACCOUNTLESS_ENROLLMENT_POLICY_VERSION = "accountless-opt-out-v1";
export const ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS = "accountless-policy-v1";
// Keep this bound aligned with the enrollment-only Worker lease. The small
// skew allowance handles independent desktop/Worker clocks without accepting
// an arbitrarily long-lived receipt.
export const ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS =
  30 * 24 * 60 * 60 * 1000;
export const ACCOUNTLESS_ENROLLMENT_CLOCK_SKEW_MILLISECONDS = 5 * 60 * 1000;

const MAXIMUM_RESPONSE_BYTES = 16_384;
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS = 60_000;
const DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const RECEIPT_KEYS =
  "authorizationBasis\0deviceId\0expiresAt\0policyVersion\0schemaVersion\0scope\0state";
const REVOKED_CODES = new Set([
  "DEVICE_AUTH_INVALID",
  "DEVICE_REVOKED",
  "ACCOUNTLESS_DEVICE_REVOKED",
  "ACCOUNTLESS_ENROLLMENT_REVOKED",
]);

const ERROR_CODES = new Set([
  "invalid_configuration",
  "preference_unavailable",
  "preference_ineligible",
  "credential_unavailable",
  "service_unavailable",
  "device_unavailable",
  "enrollment_rejected",
  "response_invalid",
]);

export class ContributionAccountlessClientError extends Error {
  constructor(code, { retryable = false } = {}) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown accountless contribution client error code");
    }
    super("Accountless contribution enrollment failed");
    this.name = "ContributionAccountlessClientError";
    this.code = `contribution_accountless_client_${code}`;
    this.retryable = retryable;
  }
}

function fail(code, options = {}) {
  throw new ContributionAccountlessClientError(code, options);
}

function canonicalOrigin(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    fail("invalid_configuration");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid_configuration");
  }
  const loopback = parsed.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !loopback)
      || parsed.username !== "" || parsed.password !== ""
      || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""
      || parsed.origin === "null") {
    fail("invalid_configuration");
  }
  return parsed.origin;
}

function assertCapability(value, origin) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.origin !== origin
      || !["created", "existing"].includes(value.status)
      || typeof value.deviceId !== "string"
      || !DEVICE_ID_PATTERN.test(value.deviceId)
      || typeof value.deviceSecretHash !== "string"
      || !SECRET_HASH_PATTERN.test(value.deviceSecretHash)) {
    fail("credential_unavailable");
  }
  return Object.freeze({
    origin,
    deviceId: value.deviceId,
    deviceSecretHash: value.deviceSecretHash,
  });
}

function assertEligiblePreference(value, origin) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.available !== true) {
    fail("preference_unavailable");
  }
  if (value.current !== true || value.enabled !== true
      || value.policyVersion !== ACCOUNTLESS_ENROLLMENT_POLICY_VERSION
      || value.destinationOrigin !== origin) {
    fail("preference_ineligible");
  }
}

function assertRequestOptions({
  fetchImpl,
  ensureCapability,
  readPreference,
  capabilityOptions,
  signal,
  requestTimeoutMilliseconds,
  now,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  if (typeof fetchImpl !== "function" || typeof ensureCapability !== "function"
      || typeof readPreference !== "function"
      || !capabilityOptions || typeof capabilityOptions !== "object"
      || Array.isArray(capabilityOptions)
      || (signal !== undefined && !(signal instanceof AbortSignal))
      || !Number.isSafeInteger(requestTimeoutMilliseconds)
      || requestTimeoutMilliseconds < 1
      || requestTimeoutMilliseconds > MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS
      || typeof now !== "function"
      || typeof setTimeoutImpl !== "function"
      || typeof clearTimeoutImpl !== "function") {
    fail("invalid_configuration");
  }
}

function contentLengthWithinLimit(response) {
  const raw = response.headers.get("content-length");
  if (raw === null) return true;
  return /^\d+$/u.test(raw) && Number(raw) <= MAXIMUM_RESPONSE_BYTES;
}

function cancelReader(reader) {
  try {
    const pending = reader.cancel();
    pending?.catch?.(() => {});
  } catch {
    // A response is already being discarded; cancellation is best effort.
  }
}

function discardResponseBody(response) {
  if (!(response instanceof Response)) return;
  try {
    const reader = response.body?.getReader?.();
    if (!reader) return;
    cancelReader(reader);
    try { reader.releaseLock(); } catch { /* best effort */ }
  } catch {
    // The body may already be locked or unavailable; the response is rejected.
  }
}

async function readBoundedResponseText(response, signal) {
  const reader = response.body?.getReader?.();
  if (!reader || typeof reader.read !== "function") fail("response_invalid");
  let aborted = signal?.aborted === true;
  let complete = false;
  let onAbort = null;
  const chunks = [];
  let totalBytes = 0;
  if (signal !== undefined) {
    onAbort = () => {
      aborted = true;
      cancelReader(reader);
    };
    if (aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    while (true) {
      if (aborted) fail("service_unavailable");
      let next;
      try {
        next = await reader.read();
      } catch {
        if (aborted) fail("service_unavailable");
        fail("service_unavailable", { retryable: true });
      }
      if (aborted) fail("service_unavailable");
      if (!next || typeof next !== "object" || typeof next.done !== "boolean") {
        fail("response_invalid");
      }
      if (next.done) {
        complete = true;
        break;
      }
      if (!(next.value instanceof Uint8Array)) fail("response_invalid");
      totalBytes += next.value.byteLength;
      if (totalBytes > MAXIMUM_RESPONSE_BYTES) {
        cancelReader(reader);
        fail("response_invalid");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      fail("response_invalid");
    }
  } finally {
    if (!complete) cancelReader(reader);
    if (signal !== undefined && onAbort !== null) {
      try { signal.removeEventListener("abort", onAbort); } catch { /* best effort */ }
    }
    try { reader.releaseLock(); } catch { /* best effort */ }
  }
}

async function readJsonResponse(response, signal) {
  const validHeaders = response instanceof Response
    && response.headers.get("cache-control") === "no-store"
    && (response.headers.get("content-type") ?? "")
      .toLowerCase().startsWith("application/json")
    && contentLengthWithinLimit(response);
  if (!validHeaders) {
    discardResponseBody(response);
    fail("response_invalid");
  }
  let text;
  try {
    text = await readBoundedResponseText(response, signal);
  } catch (error) {
    if (error instanceof ContributionAccountlessClientError) throw error;
    fail("service_unavailable", { retryable: true });
  }
  let payload;
  try {
    payload = text.length === 0 ? null : JSON.parse(text);
  } catch {
    fail("response_invalid");
  }
  if (!response.ok) {
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      fail("service_unavailable", { retryable: true });
    }
    const backendCode = payload?.error?.code;
    if (response.status === 401 || REVOKED_CODES.has(backendCode)) {
      fail("device_unavailable");
    }
    fail("enrollment_rejected");
  }
  return payload;
}

async function requestJsonWithDeadline({
  fetchImpl,
  url,
  options,
  signal,
  requestTimeoutMilliseconds,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  if (signal?.aborted) fail("service_unavailable");
  const controller = new AbortController();
  let timer = null;
  let onAbort = null;
  let externalAbort = false;
  try {
    const fetchPromise = Promise.resolve().then(async () => {
      if (controller.signal.aborted) fail("service_unavailable");
      const response = await fetchImpl(url, {
        credentials: "omit",
        redirect: "error",
        ...options,
        signal: controller.signal,
      });
      if (controller.signal.aborted) fail("service_unavailable");
      return readJsonResponse(response, controller.signal);
    });
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeoutImpl(() => {
        reject(new ContributionAccountlessClientError("service_unavailable", {
          retryable: true,
        }));
        controller.abort();
      }, requestTimeoutMilliseconds);
    });
    const abortPromise = signal === undefined
      ? null
      : new Promise((_, reject) => {
        onAbort = () => {
          externalAbort = true;
          reject(new ContributionAccountlessClientError("service_unavailable"));
          controller.abort();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    return await Promise.race(
      abortPromise === null
        ? [fetchPromise, timeoutPromise]
        : [fetchPromise, timeoutPromise, abortPromise],
    );
  } catch (error) {
    if (error instanceof ContributionAccountlessClientError) throw error;
    fail("service_unavailable", { retryable: !externalAbort });
  } finally {
    if (timer !== null) {
      try { clearTimeoutImpl(timer); } catch { /* cleanup is best effort */ }
    }
    if (signal !== undefined && onAbort !== null) {
      try { signal.removeEventListener("abort", onAbort); } catch { /* best effort */ }
    }
  }
}

function epochMilliseconds(value) {
  const numeric = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(numeric) || numeric < 0) fail("invalid_configuration");
  return numeric;
}

async function readEligiblePreference(readPreference, origin) {
  let value;
  try {
    value = await readPreference();
  } catch {
    fail("preference_unavailable");
  }
  assertEligiblePreference(value, origin);
}

function assertSignalActive(signal) {
  if (signal?.aborted) fail("service_unavailable");
}

function parseReceipt(value, capability, origin, now) {
  const keys = Object.keys(value ?? {}).sort().join("\0");
  if (!value || typeof value !== "object" || Array.isArray(value)
      || keys !== RECEIPT_KEYS
      || value.schemaVersion !== ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION
      || value.policyVersion !== ACCOUNTLESS_ENROLLMENT_POLICY_VERSION
      || value.authorizationBasis !== ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS
      || value.deviceId !== capability.deviceId
      || typeof value.expiresAt !== "string"
      || !Number.isFinite(Date.parse(value.expiresAt))
      || new Date(value.expiresAt).toISOString() !== value.expiresAt) {
    fail("response_invalid");
  }
  if (value.scope !== "enrollment_only"
      || !["enrolled", "existing"].includes(value.state)) {
    fail("response_invalid");
  }
  const expiresEpoch = Date.parse(value.expiresAt);
  let currentTime;
  try {
    currentTime = now();
  } catch {
    fail("invalid_configuration");
  }
  const nowEpoch = epochMilliseconds(currentTime);
  if (expiresEpoch <= nowEpoch
      || expiresEpoch > nowEpoch
        + ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS
        + ACCOUNTLESS_ENROLLMENT_CLOCK_SKEW_MILLISECONDS) {
    fail("response_invalid");
  }
  return Object.freeze({
    status: value.state,
    origin,
    deviceId: capability.deviceId,
    scope: "enrollment_only",
    expiresAt: new Date(value.expiresAt).toISOString(),
  });
}

/**
 * Enroll one local installation capability without granting upload authority.
 * The caller supplies a preference reader; this
 * function never chooses a default or creates consent. The reader is checked
 * before capability creation, immediately before the request, and after the
 * receipt to reject stale preference snapshots. The composition root must also
 * abort or serialize enrollment with opt-out to close the final read/send race. The
 * secure capability helper creates or reuses the local device secret before
 * the one bounded enrollment request.
 */
export async function enrollAccountlessContribution({
  origin,
  readPreference,
  fetchImpl = globalThis.fetch,
  ensureCapability = ensureContributionDeviceCapability,
  capabilityOptions = {},
  signal = undefined,
  requestTimeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
  now = () => Date.now(),
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  assertRequestOptions({
    fetchImpl,
    ensureCapability,
    readPreference,
    capabilityOptions,
    signal,
    requestTimeoutMilliseconds,
    now,
    setTimeoutImpl,
    clearTimeoutImpl,
  });
  const selectedOrigin = canonicalOrigin(origin);
  assertSignalActive(signal);
  await readEligiblePreference(readPreference, selectedOrigin);
  assertSignalActive(signal);

  let capability;
  try {
    capability = await ensureCapability({ ...capabilityOptions, origin: selectedOrigin });
  } catch {
    fail("credential_unavailable");
  }
  capability = assertCapability(capability, selectedOrigin);
  assertSignalActive(signal);
  await readEligiblePreference(readPreference, selectedOrigin);
  assertSignalActive(signal);

  const payload = {
    schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
    deviceId: capability.deviceId,
    deviceSecretHash: capability.deviceSecretHash,
    policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  };
  const response = await requestJsonWithDeadline({
    fetchImpl,
    url: new URL("/api/v1/accountless/enrollment", selectedOrigin),
    options: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    signal,
    requestTimeoutMilliseconds,
    setTimeoutImpl,
    clearTimeoutImpl,
  });
  assertSignalActive(signal);
  const receipt = parseReceipt(response, capability, selectedOrigin, now);
  assertSignalActive(signal);
  await readEligiblePreference(readPreference, selectedOrigin);
  assertSignalActive(signal);
  return receipt;
}

export {
  DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
  MAXIMUM_RESPONSE_BYTES,
};
