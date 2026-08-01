export {
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION,
  MAX_TELEMETRY_BROWSER_BYTES,
  TELEMETRY_ENVELOPE_SCHEMA_VERSION,
  TELEMETRY_SCHEMA_VERSION,
  validateAccountScopedTelemetryContribution,
  validateContributionForUpload,
  validateTelemetryContribution,
} from "./telemetry-shared.generated.js";
export {
  ENVELOPE_SCHEMA_VERSION,
  SYNTHETIC_SCHEMA_VERSION,
  buildSyntheticFixture,
  bytesToBase64Url,
  createSyntheticEnvelope,
  createTelemetryEnvelope,
  validateSyntheticFixture,
} from "./telemetry-envelope.js";
import { bytesToBase64Url } from "./telemetry-envelope.js";

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const JSON_SIMPLE_ESCAPES = Object.freeze({
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
});

function duplicateJsonObjectKeyError() {
  const error = new SyntaxError(
    "Duplicate JSON object keys are not accepted.",
  );
  error.code = "duplicate_json_object_key";
  return error;
}

/**
 * Parse JSON only after verifying that every object has unique member names.
 *
 * Native JSON.parse keeps the last occurrence of a duplicate member, which can
 * hide an earlier privacy-forbidden value before the closed-schema validator
 * sees it. This small recursive-descent preflight intentionally retains no
 * values beyond the current object's member-name set. Error messages never
 * include a key, value, or source excerpt.
 */
export function parseJsonWithUniqueObjectKeys(serialized) {
  if (typeof serialized !== "string") {
    throw new TypeError("JSON input must be a string.");
  }

  let cursor = 0;

  const invalidJson = () => {
    throw new SyntaxError("Invalid JSON.");
  };

  const skipWhitespace = () => {
    while (JSON_WHITESPACE.has(serialized[cursor])) cursor += 1;
  };

  const parseString = (decode = true) => {
    if (serialized[cursor] !== '"') invalidJson();
    cursor += 1;
    let decoded = "";
    while (cursor < serialized.length) {
      const character = serialized[cursor];
      cursor += 1;
      if (character === '"') return decoded;
      if (character === "\\") {
        if (cursor >= serialized.length) invalidJson();
        const escape = serialized[cursor];
        cursor += 1;
        if (escape === "u") {
          const codeUnit = serialized.slice(cursor, cursor + 4);
          if (!/^[0-9a-f]{4}$/iu.test(codeUnit)) invalidJson();
          if (decode) {
            decoded += String.fromCharCode(Number.parseInt(codeUnit, 16));
          }
          cursor += 4;
        } else if (Object.hasOwn(JSON_SIMPLE_ESCAPES, escape)) {
          if (decode) decoded += JSON_SIMPLE_ESCAPES[escape];
        } else {
          invalidJson();
        }
        continue;
      }
      if (character.codePointAt(0) < 0x20) invalidJson();
      if (decode) decoded += character;
    }
    invalidJson();
  };

  const parseLiteral = (literal) => {
    if (serialized.slice(cursor, cursor + literal.length) !== literal) {
      invalidJson();
    }
    cursor += literal.length;
  };

  const parseNumber = () => {
    if (serialized[cursor] === "-") cursor += 1;
    if (serialized[cursor] === "0") {
      cursor += 1;
    } else if (/[1-9]/u.test(serialized[cursor] ?? "")) {
      cursor += 1;
      while (/\d/u.test(serialized[cursor] ?? "")) cursor += 1;
    } else {
      invalidJson();
    }
    if (serialized[cursor] === ".") {
      cursor += 1;
      if (!/\d/u.test(serialized[cursor] ?? "")) invalidJson();
      while (/\d/u.test(serialized[cursor] ?? "")) cursor += 1;
    }
    if (serialized[cursor] === "e" || serialized[cursor] === "E") {
      cursor += 1;
      if (serialized[cursor] === "+" || serialized[cursor] === "-") {
        cursor += 1;
      }
      if (!/\d/u.test(serialized[cursor] ?? "")) invalidJson();
      while (/\d/u.test(serialized[cursor] ?? "")) cursor += 1;
    }
  };

  let parseValue;

  const parseArray = () => {
    cursor += 1;
    skipWhitespace();
    if (serialized[cursor] === "]") {
      cursor += 1;
      return;
    }
    while (cursor < serialized.length) {
      parseValue();
      skipWhitespace();
      if (serialized[cursor] === "]") {
        cursor += 1;
        return;
      }
      if (serialized[cursor] !== ",") invalidJson();
      cursor += 1;
      skipWhitespace();
    }
    invalidJson();
  };

  const parseObject = () => {
    cursor += 1;
    skipWhitespace();
    const memberNames = new Set();
    if (serialized[cursor] === "}") {
      cursor += 1;
      return;
    }
    while (cursor < serialized.length) {
      const memberName = parseString();
      if (memberNames.has(memberName)) {
        throw duplicateJsonObjectKeyError();
      }
      memberNames.add(memberName);
      skipWhitespace();
      if (serialized[cursor] !== ":") invalidJson();
      cursor += 1;
      parseValue();
      skipWhitespace();
      if (serialized[cursor] === "}") {
        cursor += 1;
        return;
      }
      if (serialized[cursor] !== ",") invalidJson();
      cursor += 1;
      skipWhitespace();
    }
    invalidJson();
  };

  parseValue = () => {
    skipWhitespace();
    const character = serialized[cursor];
    if (character === "{") {
      parseObject();
    } else if (character === "[") {
      parseArray();
    } else if (character === '"') {
      parseString(false);
    } else if (character === "t") {
      parseLiteral("true");
    } else if (character === "f") {
      parseLiteral("false");
    } else if (character === "n") {
      parseLiteral("null");
    } else {
      parseNumber();
    }
  };

  parseValue();
  skipWhitespace();
  if (cursor !== serialized.length) invalidJson();
  return JSON.parse(serialized);
}

export function createQuotaTimelineLookup(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError("Quota timeline rows must be an array.");
  }
  const entries = rows.flatMap((row, sourceIndex) => {
    const timestampMs = Date.parse(row?.observedAt);
    return Number.isFinite(timestampMs)
      ? [{ row, sourceIndex, timestampMs }]
      : [];
  }).sort((left, right) => (
    left.timestampMs - right.timestampMs
    || left.sourceIndex - right.sourceIndex
  )).map(({ row, timestampMs }) => Object.freeze({ row, timestampMs }));

  return Object.freeze({
    size: entries.length,
    atOrBefore(timestampMs) {
      if (typeof timestampMs !== "number" || Number.isNaN(timestampMs)) {
        return null;
      }
      let lower = 0;
      let upper = entries.length;
      while (lower < upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        if (entries[middle].timestampMs <= timestampMs) {
          lower = middle + 1;
        } else {
          upper = middle;
        }
      }
      return lower === 0 ? null : entries[lower - 1];
    }
  });
}

export function contributionBatchAdmission({
  estimatedBatches,
  participantAdmission = null,
  localReviewLimit = 100,
} = {}) {
  if (!Number.isSafeInteger(estimatedBatches)
      || estimatedBatches < 0
      || !Number.isSafeInteger(localReviewLimit)
      || localReviewLimit < 1) {
    throw new TypeError("Contribution batch admission inputs are invalid.");
  }
  const admissionKnown =
    ["available", "exhausted"].includes(participantAdmission?.state)
    && Number.isSafeInteger(participantAdmission?.remainingBatches)
    && participantAdmission.remainingBatches >= 0
    && Number.isSafeInteger(participantAdmission?.maximumBatches)
    && participantAdmission.maximumBatches > 0
    && participantAdmission.remainingBatches
      <= participantAdmission.maximumBatches
    && participantAdmission.state === (
      participantAdmission.remainingBatches > 0 ? "available" : "exhausted"
    );
  const remainingBatches = admissionKnown
    ? participantAdmission.remainingBatches
    : null;
  const exceedsLocalReviewLimit = estimatedBatches > localReviewLimit;
  const exceedsParticipantAdmission = admissionKnown
    && estimatedBatches > remainingBatches;
  return Object.freeze({
    admissionKnown,
    remainingBatches,
    maximumBatches: admissionKnown
      ? participantAdmission.maximumBatches
      : null,
    renewsAt: admissionKnown
        && typeof participantAdmission.renewsAt === "string"
      ? participantAdmission.renewsAt
      : "",
    localReviewLimit,
    effectiveBatchLimit: admissionKnown
      ? Math.min(localReviewLimit, remainingBatches)
      : localReviewLimit,
    exceedsLocalReviewLimit,
    exceedsParticipantAdmission,
    blocked: exceedsLocalReviewLimit || exceedsParticipantAdmission,
  });
}

export async function runReviewedContributionGate({
  reviewToken,
  hasPendingAutomaticConsent,
  runReviewedSend,
  enableAutomaticContribution,
} = {}) {
  if (typeof reviewToken !== "string"
      || reviewToken.length === 0
      || typeof hasPendingAutomaticConsent !== "boolean"
      || typeof runReviewedSend !== "function"
      || typeof enableAutomaticContribution !== "function") {
    throw new TypeError("Reviewed contribution gate inputs are invalid.");
  }
  const result = await runReviewedSend(reviewToken);
  const accepted =
    result?.status === "completed"
    && Number.isSafeInteger(result.accepted)
    && result.accepted > 0;
  let automatic = null;
  let automaticError = null;
  if (accepted && hasPendingAutomaticConsent) {
    try {
      automatic = await enableAutomaticContribution();
    } catch (error) {
      automaticError = error;
    }
  }
  return Object.freeze({
    accepted,
    automatic,
    automaticError,
    result,
  });
}

export function createRefreshPollingBudget({
  now = () => Date.now(),
  windowMs = 6 * 60 * 1_000,
  settlementGraceMs = 30 * 1_000,
  maximumContinuations = 2
} = {}) {
  if (typeof now !== "function"
      || !Number.isSafeInteger(windowMs)
      || windowMs < 1_000
      || !Number.isSafeInteger(settlementGraceMs)
      || settlementGraceMs < 1_000
      || !Number.isSafeInteger(maximumContinuations)
      || maximumContinuations < 1) {
    throw new TypeError("Refresh polling budget is invalid.");
  }
  let deadlineMs = now() + windowMs;
  let continuations = 0;
  return Object.freeze({
    hasTime() {
      return now() < deadlineMs;
    },
    noteSettling() {
      deadlineMs = Math.max(deadlineMs, now() + settlementGraceMs);
    },
    canContinue() {
      return continuations < maximumContinuations;
    },
    noteContinuation() {
      if (continuations >= maximumContinuations) return false;
      continuations += 1;
      deadlineMs = now() + windowMs;
      return true;
    },
    get continuations() {
      return continuations;
    }
  });
}

export function refreshNeedsContinuation({
  outcome,
  errorCode = null,
  progress = null,
} = {}) {
  if (progress?.status !== "bounded_pause") return false;
  return outcome === "succeeded"
    || (outcome === "failed" && errorCode === "refresh_timed_out");
}

export function formatTokenTotal(usage) {
  const total = usage.inputUncachedTokens
    + usage.inputCachedTokens
    + usage.outputTextTokens
    + usage.outputReasoningTokens;
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(total);
}

export function safeFilename(participantId) {
  const suffix = typeof participantId === "string"
    ? participantId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32)
    : "participant";
  return `usage-monitor-${suffix || "participant"}-export.json`;
}

const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_RESULT_STORAGE_KEY =
  "tibotattle-google-oauth-result";
const GOOGLE_OAUTH_CALLBACK_SUFFIX = "/oauth/google/callback";
const MAXIMUM_GOOGLE_AUTHORIZATION_CODE_LENGTH = 2_048;

/**
 * Build one PKCE Google sign-in authorization request.
 *
 * The verifier and state are fresh WebCrypto randomness; only the S256
 * challenge and the state travel to the provider. Scope is fixed to
 * "openid": no email, name, or profile scope is ever requested, matching
 * the service's irreversible-hash-only identity storage.
 */
export async function createGoogleSignInRequest({
  clientId,
  redirectUri,
  cryptoImpl = globalThis.crypto
} = {}) {
  if (typeof clientId !== "string"
      || clientId.length === 0
      || clientId.length > 256
      || typeof redirectUri !== "string"
      || !redirectUri.endsWith(GOOGLE_OAUTH_CALLBACK_SUFFIX)) {
    throw new TypeError("Google sign-in request inputs are invalid.");
  }
  const codeVerifier = bytesToBase64Url(
    cryptoImpl.getRandomValues(new Uint8Array(48))
  );
  const state = bytesToBase64Url(
    cryptoImpl.getRandomValues(new Uint8Array(32))
  );
  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier)
  );
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set(
    "code_challenge",
    bytesToBase64Url(new Uint8Array(digest))
  );
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return Object.freeze({
    url: url.href,
    state,
    codeVerifier,
    redirectUri
  });
}

/**
 * Validate the JSON the loopback callback page wrote to localStorage.
 *
 * Fails closed on shape drift, a missing or mismatched state, and stale or
 * future timestamps, so a leftover result from an earlier attempt can never
 * complete a newer sign-in. Error messages never include the code or state.
 */
export function parseGoogleSignInResult(serialized, {
  expectedState,
  nowMs = Date.now(),
  maximumAgeMs = 10 * 60 * 1_000
} = {}) {
  if (typeof expectedState !== "string" || expectedState.length === 0) {
    throw new TypeError("Google sign-in state is required.");
  }
  let payload;
  try {
    payload = JSON.parse(typeof serialized === "string" ? serialized : "");
  } catch {
    throw new Error("The Google sign-in result could not be read. Sign in again.");
  }
  const shapeValid = payload
    && typeof payload === "object"
    && !Array.isArray(payload)
    && Object.keys(payload).sort().join("\u0000")
      === "code\u0000receivedAt\u0000state";
  const receivedAtMs = shapeValid ? Date.parse(payload.receivedAt) : Number.NaN;
  if (!shapeValid
      || typeof payload.code !== "string"
      || payload.code.length === 0
      || payload.code.length > MAXIMUM_GOOGLE_AUTHORIZATION_CODE_LENGTH
      || typeof payload.state !== "string"
      || !Number.isFinite(receivedAtMs)
      || receivedAtMs > nowMs + 60_000
      || nowMs - receivedAtMs > maximumAgeMs) {
    throw new Error("The Google sign-in result was invalid or expired. Sign in again.");
  }
  if (payload.state !== expectedState) {
    throw new Error("The Google sign-in result did not match this dashboard tab. Sign in again.");
  }
  return Object.freeze({ code: payload.code });
}

export function safeApiError(payload, fallback) {
  const candidate = typeof payload?.error === "string"
    ? payload.error
    : payload?.error?.code;
  if (typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(candidate)) {
    return candidate.replace(/_/g, " ");
  }
  return fallback;
}

// Crockford base32 without I, L, O and U, so a reference read aloud or
// retyped into a support conversation cannot be confused with 1 or 0.
const DIAGNOSTIC_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DIAGNOSTIC_REFERENCE_SYMBOLS = 6;
const DIAGNOSTIC_REFERENCE_PREFIX = "TT-";
export const DIAGNOSTIC_REFERENCE_PATTERN =
  /^TT-[0-9A-HJKMNP-TV-Z]{6}$/u;
// Fixed, content-free journey names. A note may only be filed against one of
// these, so the local log can never accumulate a free-form label.
export const DIAGNOSTIC_SURFACES = Object.freeze([
  "automatic_contribution",
  "community_results",
  "contribution_connect",
  "contribution_prepare",
  "contribution_send",
  "device_credential_reset",
  "hosted_identity",
  "hosted_privacy",
  "local_refresh"
]);
const DIAGNOSTIC_SURFACE_SET = new Set(DIAGNOSTIC_SURFACES);
// The same shape the Worker mints with crypto.randomUUID.
const SERVICE_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// The same identifier shape both boundaries answer with: SCREAMING_SNAKE from
// the contribution service, lower_snake from the local companion. Neither can
// carry a sentence, a path, or a quoted value, so a matching code is safe to
// branch on and to record. It is still never rendered as copy.
const DIAGNOSTIC_CODE_PATTERN =
  /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_]{1,63})$/u;

/**
 * Mint one short support reference for a user-visible failure.
 *
 * The value is pure WebCrypto randomness. It is never derived from a
 * participant id, an error body, a hostname, or a timestamp, so it correlates
 * a support conversation with one local log line and discloses nothing else.
 */
export function createDiagnosticReference(cryptoImpl = globalThis.crypto) {
  const bytes = cryptoImpl.getRandomValues(
    new Uint8Array(DIAGNOSTIC_REFERENCE_SYMBOLS)
  );
  let reference = DIAGNOSTIC_REFERENCE_PREFIX;
  // 256 is an exact multiple of 32, so the remainder stays uniform.
  for (const byte of bytes) {
    reference += DIAGNOSTIC_REFERENCE_ALPHABET[byte % 32];
  }
  return reference;
}

export function diagnosticSurface(candidate) {
  return DIAGNOSTIC_SURFACE_SET.has(candidate) ? candidate : "";
}

/**
 * The Worker returns a UUID requestId in every error body. Surfacing it lets a
 * support conversation join the local reference to one server-side record;
 * anything that is not exactly that shape is discarded.
 */
export function serviceRequestId(candidate) {
  return typeof candidate === "string"
    && SERVICE_REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : "";
}

export function diagnosticErrorCode(candidate) {
  return typeof candidate === "string" && DIAGNOSTIC_CODE_PATTERN.test(candidate)
    ? candidate
    : "";
}

/**
 * The trailing sentence appended to every user-visible failure.
 *
 * It carries only identifiers this page minted or validated: the local
 * reference, and the service request id when the service supplied one.
 */
export function diagnosticReferenceSentence({
  reference,
  requestId = ""
} = {}) {
  if (!DIAGNOSTIC_REFERENCE_PATTERN.test(reference ?? "")) return "";
  const service = serviceRequestId(requestId);
  return service === ""
    ? `Reference ${reference}, also written to the local diagnostics log.`
    : `Reference ${reference} · service request ${service}. Both are written to the local diagnostics log.`;
}
