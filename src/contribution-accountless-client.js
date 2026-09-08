import {
  ensureContributionDeviceCapability,
  withContributionDeviceSecret,
} from "./contribution-device-capability.js";
import {
  accountlessTransportOrigin,
  ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCOPE,
  ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
} from "./contribution/index.js";
import { runIncrementalContributionSyncOnce } from "./contribution-incremental-sync.js";

export const ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION = "accountless-enrollment-v0.1";
export const ACCOUNTLESS_ENROLLMENT_POLICY_VERSION = "accountless-opt-out-v1";
export const ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS = "accountless-policy-v1";
// Keep this bound aligned with the enrollment-only Worker lease. The small
// skew allowance handles independent desktop/Worker clocks without accepting
// an arbitrarily long-lived receipt.
export const ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS =
  30 * 24 * 60 * 60 * 1000;
export const ACCOUNTLESS_RENEWAL_SCHEMA_VERSION = "accountless-renewal-v0.1";
export const ACCOUNTLESS_RENEWAL_WINDOW_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
export const ACCOUNTLESS_ENROLLMENT_CLOCK_SKEW_MILLISECONDS = 5 * 60 * 1000;

const MAXIMUM_RESPONSE_BYTES = 16_384;
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS = 60_000;
const DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const RECEIPT_KEYS =
  "authorizationBasis\0deviceId\0expiresAt\0policyVersion\0schemaVersion\0scope\0state";
const OWNERSHIP_RECEIPT_KEYS =
  "authorizationBasis\0deviceId\0expiresAt\0policyVersion\0schemaVersion\0scope\0state\0telemetrySchemaVersion";
const RENEWAL_RECEIPT_KEYS =
  "authorizationBasis\0deviceId\0expiresAt\0policyVersion\0renewalGeneration\0schemaVersion\0scope\0state\0telemetrySchemaVersion";
const REVOKED_CODES = new Set([
  "DEVICE_AUTH_INVALID",
  "DEVICE_REVOKED",
  "ACCOUNTLESS_DEVICE_REVOKED",
  "ACCOUNTLESS_ENROLLMENT_REVOKED",
  "ACCOUNTLESS_ENROLLMENT_EXPIRED",
  "ACCOUNTLESS_OWNERSHIP_REVOKED",
  "ACCOUNTLESS_OWNERSHIP_EXPIRED",
]);
const MAXIMUM_RETRY_AFTER_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const RUN_SCHEMA_VERSION = "incremental-contribution-sync-run-v1.0";
const ACCOUNTLESS_RUN_AUTHORIZATION = Object.freeze({
  schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
});

const ERROR_CODES = new Set([
  "invalid_configuration",
  "preference_unavailable",
  "preference_ineligible",
  "credential_recovery_required",
  "credential_unavailable",
  "service_unavailable",
  "device_unavailable",
  "enrollment_rejected",
  "enrollment_expired",
  "ownership_rejected",
  "ownership_expired",
  "response_invalid",
  "interrupted",
]);
const RETRYABLE_CREDENTIAL_AVAILABILITY_CODES = new Set([
  "contribution_device_credential_unavailable",
  "contribution_device_credential_mutation_uncertain",
]);

export class ContributionAccountlessClientError extends Error {
  constructor(code, { retryable = false, retryAfterMilliseconds = null } = {}) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown accountless contribution client error code");
    }
    if (retryAfterMilliseconds !== null
        && (!Number.isSafeInteger(retryAfterMilliseconds)
          || retryAfterMilliseconds < 0
          || retryAfterMilliseconds > MAXIMUM_RETRY_AFTER_MILLISECONDS)) {
      throw new TypeError("Invalid accountless contribution retry delay");
    }
    super("Accountless contribution transport failed");
    this.name = "ContributionAccountlessClientError";
    this.code = `contribution_accountless_client_${code}`;
    this.retryable = retryable;
    this.retryAfterMilliseconds = retryAfterMilliseconds;
  }
}

function fail(code, options = {}) {
  throw new ContributionAccountlessClientError(code, options);
}

// The protected credential layer distinguishes explicitly transient provider or
// private-channel availability from malformed, missing, conflicting, or revoked
// local state. Only the former may ask the scheduler for a later bounded pass.
function credentialAccessFailure(error) {
  let code;
  try {
    code = error?.code;
  } catch {
    code = undefined;
  }
  if (code === "contribution_device_credential_recovery_required") {
    fail("credential_recovery_required");
  }
  let retryable = false;
  try {
    retryable = error?.retryable === true
      && RETRYABLE_CREDENTIAL_AVAILABILITY_CODES.has(code);
  } catch {
    retryable = false;
  }
  fail("credential_unavailable", { retryable });
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

function retryAfterMilliseconds(response, now = Date.now) {
  const value = response.headers.get("retry-after")?.trim() ?? "";
  if (value.length === 0 || value.length > 128) return null;
  let milliseconds = null;
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return null;
    milliseconds = seconds * 1_000;
  } else {
    const then = Date.parse(value);
    let current;
    try { current = epochMilliseconds(now()); } catch { return null; }
    if (!Number.isFinite(then)) return null;
    milliseconds = Math.max(0, then - current);
  }
  return Number.isSafeInteger(milliseconds)
    && milliseconds <= MAXIMUM_RETRY_AFTER_MILLISECONDS ? milliseconds : null;
}

function accountlessRevocationCode(value) {
  return typeof value === "string"
    && /^ACCOUNTLESS_[A-Z0-9_]{1,120}$/u.test(value);
}

async function readJsonResponse(response, signal, {
  rejectionCode = "enrollment_rejected",
  ownership = false,
  enrollment = false,
  now = Date.now,
} = {}) {
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
      fail("service_unavailable", {
        retryable: true,
        retryAfterMilliseconds: retryAfterMilliseconds(response, now),
      });
    }
    const backendCode = payload?.error?.code;
    if (enrollment && response.status === 410
        && backendCode === "ACCOUNTLESS_ENROLLMENT_EXPIRED") {
      fail("enrollment_expired");
    }
    if (ownership && response.status === 410
        && backendCode === "ACCOUNTLESS_OWNERSHIP_EXPIRED") {
      fail("ownership_expired");
    }
    // A version or body mismatch remains a terminal contract error even if
    // its machine code happens to share the accountless namespace.
    if (ownership && response.status === 409) fail("ownership_rejected");
    if (response.status === 401 || REVOKED_CODES.has(backendCode)
        || (ownership && accountlessRevocationCode(backendCode))) {
      fail("device_unavailable");
    }
    fail(rejectionCode);
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
  responseOptions = undefined,
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
        ...options,
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (controller.signal.aborted) fail("service_unavailable");
      return readJsonResponse(response, controller.signal, responseOptions);
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

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === keys;
}

function assertTransportDestination(laboratory, rehearsal, production, origin) {
  const selected = accountlessTransportOrigin({ laboratory, rehearsal, production, origin });
  if (selected === null) fail("invalid_configuration");
  return selected;
}

function assertLeasedDevice(value, origin) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.origin !== origin || typeof value.deviceId !== "string"
      || !DEVICE_ID_PATTERN.test(value.deviceId)) {
    fail("credential_unavailable");
  }
  return Object.freeze({ origin, deviceId: value.deviceId });
}

function parseOwnershipReceipt(value, device, origin, now, renewal = false) {
  if (!exactKeys(value, renewal ? RENEWAL_RECEIPT_KEYS : OWNERSHIP_RECEIPT_KEYS)
      || value.schemaVersion !== (renewal ? ACCOUNTLESS_RENEWAL_SCHEMA_VERSION : ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION)
      || (renewal && (!Number.isSafeInteger(value.renewalGeneration)
        || value.renewalGeneration < 0 || value.renewalGeneration > 2_147_483_647))
      || value.policyVersion !== ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION
      || value.authorizationBasis !== ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS
      || value.telemetrySchemaVersion !== ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION
      || value.scope !== ACCOUNTLESS_UPLOAD_OWNER_SCOPE
      || !(renewal ? ["renewed", "existing"] : ["created", "existing"]).includes(value.state)
      || value.deviceId !== device.deviceId
      || typeof value.expiresAt !== "string"
      || !Number.isFinite(Date.parse(value.expiresAt))
      || new Date(value.expiresAt).toISOString() !== value.expiresAt) {
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
    deviceId: device.deviceId,
    scope: ACCOUNTLESS_UPLOAD_OWNER_SCOPE,
    ...(renewal ? { renewalGeneration: value.renewalGeneration } : {}),
    expiresAt: new Date(value.expiresAt).toISOString(),
  });
}

function safeLeaseFailure(error) {
  if (error instanceof ContributionAccountlessClientError) {
    const code = error.code.slice("contribution_accountless_client_".length);
    if (ERROR_CODES.has(code)) return Object.freeze({
      type: "failure",
      code,
      retryable: error.retryable === true,
      retryAfterMilliseconds: error.retryAfterMilliseconds ?? null,
    });
  }
  return Object.freeze({
    type: "failure",
    code: "service_unavailable",
    retryable: true,
    retryAfterMilliseconds: null,
  });
}

function assertOwnershipRequestOptions({
  fetchImpl,
  readPreference,
  backend,
  withDeviceSecret,
  stateFile,
  signal,
  requestTimeoutMilliseconds,
  now,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  if (typeof fetchImpl !== "function" || typeof readPreference !== "function"
      || !backend || typeof backend !== "object" || Array.isArray(backend)
      || typeof withDeviceSecret !== "function"
      || (stateFile !== undefined && (typeof stateFile !== "string" || !stateFile))
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
  } catch (error) {
    credentialAccessFailure(error);
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
    responseOptions: { enrollment: true, now },
  });
  assertSignalActive(signal);
  const receipt = parseReceipt(response, capability, selectedOrigin, now);
  assertSignalActive(signal);
  await readEligiblePreference(readPreference, selectedOrigin);
  assertSignalActive(signal);
  return receipt;
}

/**
 * Ownership registration for an explicitly selected laboratory, rehearsal, or production
 * destination. Enrollment remains a separate, non-upload-capable operation.
 */
async function requestAccountlessAuthority({
  laboratory = false,
  rehearsal = false,
  production = false,
  origin,
  readPreference,
  backend,
  stateFile = undefined,
  fetchImpl = globalThis.fetch,
  withDeviceSecret = withContributionDeviceSecret,
  signal = undefined,
  requestTimeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
  now = () => Date.now(),
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}, renewal = false) {
  assertOwnershipRequestOptions({
    fetchImpl,
    readPreference,
    backend,
    withDeviceSecret,
    stateFile,
    signal,
    requestTimeoutMilliseconds,
    now,
    setTimeoutImpl,
    clearTimeoutImpl,
  });
  const selectedOrigin = canonicalOrigin(origin);
  assertTransportDestination(laboratory, rehearsal, production, selectedOrigin);
  assertSignalActive(signal);
  await readEligiblePreference(readPreference, selectedOrigin);
  assertSignalActive(signal);

  let leased;
  try {
    leased = await withDeviceSecret({
      backend,
      ...(stateFile === undefined ? {} : { stateFile }),
      expectedOrigin: selectedOrigin,
      operation: async (secret, leasedDevice) => {
        try {
          const device = assertLeasedDevice(leasedDevice, selectedOrigin);
          assertSignalActive(signal);
          await readEligiblePreference(readPreference, selectedOrigin);
          assertSignalActive(signal);
          const response = await requestJsonWithDeadline({
            fetchImpl,
            url: new URL(renewal ? "/api/v1/accountless/renewal" : "/api/v1/accountless/ownership", selectedOrigin),
            options: {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: `Device um_device_${device.deviceId}.${secret.toString("base64url")}`,
              },
              body: JSON.stringify(renewal
                ? { ...ACCOUNTLESS_RUN_AUTHORIZATION, schemaVersion: ACCOUNTLESS_RENEWAL_SCHEMA_VERSION }
                : ACCOUNTLESS_RUN_AUTHORIZATION),
            },
            signal,
            requestTimeoutMilliseconds,
            setTimeoutImpl,
            clearTimeoutImpl,
            responseOptions: {
              rejectionCode: "ownership_rejected",
              ownership: true,
              now,
            },
          });
          assertSignalActive(signal);
          const receipt = parseOwnershipReceipt(response, device, selectedOrigin, now, renewal);
          assertSignalActive(signal);
          await readEligiblePreference(readPreference, selectedOrigin);
          assertSignalActive(signal);
          return Object.freeze({ type: "success", receipt });
        } catch (error) {
          // Carry only a fixed transport classification across the zeroized
          // secret lease; never return its header, request, or error message.
          return safeLeaseFailure(error);
        }
      },
    });
  } catch (error) {
    if (error instanceof ContributionAccountlessClientError) throw error;
    credentialAccessFailure(error);
  }
  if (!leased || typeof leased !== "object" || Array.isArray(leased)) {
    fail("credential_unavailable");
  }
  if (leased.type === "success") {
    if (!Object.hasOwn(leased, "receipt")) fail("credential_unavailable");
    return leased.receipt;
  }
  if (leased.type !== "failure" || !ERROR_CODES.has(leased.code)
      || typeof leased.retryable !== "boolean"
      || (leased.retryAfterMilliseconds !== null
        && (!Number.isSafeInteger(leased.retryAfterMilliseconds)
          || leased.retryAfterMilliseconds < 0
          || leased.retryAfterMilliseconds > MAXIMUM_RETRY_AFTER_MILLISECONDS))) {
    fail("credential_unavailable");
  }
  fail(leased.code, {
    retryable: leased.retryable,
    retryAfterMilliseconds: leased.retryAfterMilliseconds,
  });
}

export function claimAccountlessContributionOwnership(options = {}) {
  return requestAccountlessAuthority(options);
}

/** Renew only the held installation graph; never enroll or rotate a secret. */
export function renewAccountlessContributionOwnership(options = {}) {
  return requestAccountlessAuthority(options, true);
}

function configuredAccountlessSync(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)
      || ["consent", "authorization", "approve", "approval"].some((key) => Object.hasOwn(options, key))) {
    fail("invalid_configuration");
  }
  const {
    laboratory = false,
    rehearsal = false,
    production = false,
    origin,
    readPreference,
    backend,
    stateFile = undefined,
    indexFile,
    fetchImpl = globalThis.fetch,
    ensureCapability = ensureContributionDeviceCapability,
    withDeviceSecret = withContributionDeviceSecret,
    enroll = enrollAccountlessContribution,
    claimOwnership = claimAccountlessContributionOwnership,
    renewOwnership = renewAccountlessContributionOwnership,
    runIncrementalSync = runIncrementalContributionSyncOnce,
    signal = undefined,
    requestTimeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
    maximumChunks = 500,
    maximumDurationMilliseconds = 60_000,
    now = Date.now,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    readAccountMarkers = async () => [],
    loadExistingAccountObservationSecret = async () => null,
    onAttributionBinding = null,
    progressStore = undefined,
    progressFile = null,
  } = options;
  if (typeof readPreference !== "function" || !backend || typeof backend !== "object"
      || Array.isArray(backend) || typeof indexFile !== "string" || !indexFile
      || (stateFile !== undefined && (typeof stateFile !== "string" || !stateFile))
      || [fetchImpl, ensureCapability, withDeviceSecret, enroll, claimOwnership, renewOwnership,
        runIncrementalSync, now, setTimeoutImpl, clearTimeoutImpl, readAccountMarkers,
        loadExistingAccountObservationSecret].some((value) => typeof value !== "function")
      || (onAttributionBinding !== null && typeof onAttributionBinding !== "function")
      || (progressFile !== null && (typeof progressFile !== "string" || !progressFile))
      || (progressStore !== undefined && (!progressStore || typeof progressStore.read !== "function"
        || typeof progressStore.write !== "function"))
      || !Number.isSafeInteger(requestTimeoutMilliseconds)
      || requestTimeoutMilliseconds < 1_000
      || requestTimeoutMilliseconds > MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS
      || !Number.isSafeInteger(maximumChunks) || maximumChunks < 1 || maximumChunks > 2_000
      || !Number.isSafeInteger(maximumDurationMilliseconds)
      || maximumDurationMilliseconds < 1 || maximumDurationMilliseconds > 300_000
      || (signal !== undefined && !(signal instanceof AbortSignal))) {
    fail("invalid_configuration");
  }
  const selectedOrigin = canonicalOrigin(origin);
  assertTransportDestination(laboratory, rehearsal, production, selectedOrigin);
  return Object.freeze({
    laboratory,
    rehearsal,
    production,
    origin: selectedOrigin,
    readPreference,
    backend,
    stateFile,
    indexFile,
    fetchImpl,
    ensureCapability,
    withDeviceSecret,
    enroll,
    claimOwnership,
    renewOwnership,
    runIncrementalSync,
    signal,
    requestTimeoutMilliseconds,
    maximumChunks,
    maximumDurationMilliseconds,
    now,
    setTimeoutImpl,
    clearTimeoutImpl,
    readAccountMarkers,
    loadExistingAccountObservationSecret,
    onAttributionBinding,
    progressStore,
    progressFile,
  });
}

function accountlessRunFailure(error, { networkActivity = false, signal = undefined } = {}) {
  let code = "service_unavailable";
  let retryable = true;
  let retryAfterMilliseconds = null;
  if (signal?.aborted) {
    code = "interrupted";
  } else if (error instanceof ContributionAccountlessClientError) {
    const candidate = error.code.slice("contribution_accountless_client_".length);
    if (ERROR_CODES.has(candidate)) {
      code = candidate;
      retryable = error.retryable === true;
      retryAfterMilliseconds = error.retryAfterMilliseconds ?? null;
    }
  }
  if (code === "interrupted") retryable = true;
  return Object.freeze({
    schemaVersion: RUN_SCHEMA_VERSION,
    status: "failed",
    daysTotal: 0,
    daysSynced: 0,
    daysPending: 0,
    chunksUploaded: 0,
    chunksSkipped: 0,
    recordsUploaded: 0,
    acknowledgedThroughDay: null,
    orphanChunkIds: Object.freeze([]),
    stagedDays: 0,
    domainGenerationId: null,
    networkActivity,
    failure: Object.freeze({
      code,
      retryable,
      deviceUnavailable: code === "device_unavailable",
      retryAfterMilliseconds,
    }),
  });
}

/**
 * Run one bounded accountless pass against an explicitly selected destination.
 * Each actual request is
 * fenced by a fresh protected preference read; Electron additionally aborts
 * the signal on opt-out, so a stale pass cannot proceed to a later request.
 */
export async function runAccountlessContributionSyncOnce(options = {}) {
  const configured = configuredAccountlessSync(options);
  const {
    laboratory,
    rehearsal,
    production,
    origin,
    readPreference,
    backend,
    stateFile,
    indexFile,
    fetchImpl,
    ensureCapability,
    withDeviceSecret,
    enroll,
    claimOwnership,
    renewOwnership,
    runIncrementalSync,
    signal,
    requestTimeoutMilliseconds,
    maximumChunks,
    maximumDurationMilliseconds,
    now,
    setTimeoutImpl,
    clearTimeoutImpl,
    readAccountMarkers,
    loadExistingAccountObservationSecret,
    onAttributionBinding,
    progressStore,
    progressFile,
  } = configured;
  let networkActivity = false;
  const guardedFetch = async (...args) => {
    assertSignalActive(signal);
    await readEligiblePreference(readPreference, origin);
    assertSignalActive(signal);
    const response = await fetchImpl(...args);
    networkActivity = true;
    assertSignalActive(signal);
    return response;
  };
  try {
    assertSignalActive(signal);
    await readEligiblePreference(readPreference, origin);
    assertSignalActive(signal);
    const authorityOptions = {
      laboratory, rehearsal, production, origin, readPreference, backend,
      ...(stateFile === undefined ? {} : { stateFile }),
      fetchImpl: guardedFetch, withDeviceSecret, signal,
      requestTimeoutMilliseconds, now, setTimeoutImpl, clearTimeoutImpl,
    };
    let renewedAfterExpiry = false;
    try {
      await enroll({
        origin,
        readPreference,
        fetchImpl: guardedFetch,
        ensureCapability,
        capabilityOptions: {
          backend,
          ...(stateFile === undefined ? {} : { stateFile }),
        },
        signal,
        requestTimeoutMilliseconds,
        now,
        setTimeoutImpl,
        clearTimeoutImpl,
      });
    } catch (error) {
      // Expiry stops uploads but does not destroy an active installation.
      // Only this exact enrollment failure enters authenticated renewal.
      if (!(error instanceof ContributionAccountlessClientError)
          || error.code !== "contribution_accountless_client_enrollment_expired") throw error;
      await renewOwnership(authorityOptions);
      renewedAfterExpiry = true;
    }
    assertSignalActive(signal);
    await readEligiblePreference(readPreference, origin);
    assertSignalActive(signal);
    let ownership;
    try {
      ownership = await claimOwnership(authorityOptions);
    } catch (error) {
      // The lease can expire between enrollment and owner verification.
      // Recover once through the same authenticated route; never loop.
      if (renewedAfterExpiry || !(error instanceof ContributionAccountlessClientError)
          || error.code !== "contribution_accountless_client_ownership_expired") throw error;
      await renewOwnership(authorityOptions);
      renewedAfterExpiry = true;
      ownership = await claimOwnership(authorityOptions);
    }
    if (!renewedAfterExpiry && typeof ownership?.expiresAt === "string"
        && Date.parse(ownership.expiresAt) - epochMilliseconds(now())
          <= ACCOUNTLESS_RENEWAL_WINDOW_MILLISECONDS) {
      await renewOwnership(authorityOptions);
    }
    assertSignalActive(signal);
    await readEligiblePreference(readPreference, origin);
    assertSignalActive(signal);
    const result = await runIncrementalSync({
      laboratory,
      rehearsal,
      production,
      origin,
      backend,
      ...(stateFile === undefined ? {} : { stateFile }),
      indexFile,
      authorization: ACCOUNTLESS_RUN_AUTHORIZATION,
      fetchImpl: guardedFetch,
      withDeviceSecret,
      maximumChunks,
      requestTimeoutMilliseconds,
      maximumDurationMilliseconds,
      now,
      readAccountMarkers,
      loadExistingAccountObservationSecret,
      onAttributionBinding,
      progressStore,
      progressFile,
      signal,
    });
    assertSignalActive(signal);
    await readEligiblePreference(readPreference, origin);
    assertSignalActive(signal);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new ContributionAccountlessClientError("response_invalid");
    }
    return Object.freeze({
      ...result,
      networkActivity: result.networkActivity === true || networkActivity,
    });
  } catch (error) {
    return accountlessRunFailure(error, { networkActivity, signal });
  }
}

export {
  DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
  MAXIMUM_RESPONSE_BYTES,
};
