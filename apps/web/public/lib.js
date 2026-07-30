const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export const SYNTHETIC_SCHEMA_VERSION = "synthetic-contribution-v0.1";
export const ENVELOPE_SCHEMA_VERSION = "synthetic-envelope-v0.1";
export const TELEMETRY_SCHEMA_VERSION = "telemetry-contribution-v0.1";
export const ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION =
  "telemetry-contribution-v0.2";
export const ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION =
  "privacy-safe-telemetry-v0.2";
export const TELEMETRY_ENVELOPE_SCHEMA_VERSION = "telemetry-envelope-v0.1";
export const MAX_TELEMETRY_BROWSER_BYTES = 1_310_720;

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

export function buildSyntheticFixture() {
  return {
    schemaVersion: SYNTHETIC_SCHEMA_VERSION,
    synthetic: true,
    fixtureId: "codex-weekly-demo-v0.1",
    timeRange: {
      start: "2026-07-14T00:00:00.000Z",
      end: "2026-07-21T00:00:00.000Z"
    },
    quota: {
      windowMinutes: 10080,
      usedPercentBefore: 26,
      usedPercentAfter: 31,
      displayPrecision: 0
    },
    usage: {
      modelId: "gpt-5.6-sol",
      subscriptionSpeed: "standard",
      apiTierAssumption: "standard",
      inputUncachedTokens: 150000,
      inputCachedTokens: 900000,
      outputTextTokens: 28000,
      outputReasoningTokens: 16000,
      providerToolUnits: {
        webSearchCalls: 2,
        unknownUnits: 1
      }
    },
    accounting: {
      estimatedApiCostUsd: "12.840000",
      pricedEventCoveragePercent: 100,
      unknownBillableUnits: 1,
      priceBasis: "current-api-price-sensitivity"
    }
  };
}

export function validateSyntheticFixture(fixture) {
  if (!fixture || fixture.synthetic !== true || fixture.schemaVersion !== SYNTHETIC_SCHEMA_VERSION) {
    throw new TypeError("Only the fixed synthetic fixture can be contributed.");
  }
  const canonical = JSON.stringify(buildSyntheticFixture());
  if (JSON.stringify(fixture) !== canonical) {
    throw new TypeError("The synthetic fixture must not be modified.");
  }
  return true;
}

export function bytesToBase64Url(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Expected Uint8Array.");
  }
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    output += BASE64_ALPHABET[(triple >> 18) & 63];
    output += BASE64_ALPHABET[(triple >> 12) & 63];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "=";
  }
  return output.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function createSyntheticEnvelope({ publicJwk, keyId, cryptoImpl = globalThis.crypto } = {}) {
  const fixture = buildSyntheticFixture();
  validateSyntheticFixture(fixture);
  return createEncryptedEnvelope({
    payload: fixture,
    publicJwk,
    keyId,
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    synthetic: true,
    cryptoImpl
  });
}

/**
 * Encrypts an already privacy-stripped telemetry contribution.
 *
 * This browser-side check is intentionally conservative and is not a substitute
 * for server-side schema validation, content-key rejection, size limits,
 * decompression limits, deduplication, quarantine, or aggregate privacy gates.
 */
export async function createTelemetryEnvelope({ payload, publicJwk, keyId, cryptoImpl = globalThis.crypto } = {}) {
  validateContributionForUpload(payload);
  return createEncryptedEnvelope({
    payload,
    publicJwk,
    keyId,
    schemaVersion: TELEMETRY_ENVELOPE_SCHEMA_VERSION,
    synthetic: false,
    cryptoImpl
  });
}

async function createEncryptedEnvelope({
  payload,
  publicJwk,
  keyId,
  schemaVersion,
  synthetic,
  cryptoImpl
}) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
    throw new Error("Web Crypto is unavailable in this browser.");
  }
  if (!publicJwk || typeof keyId !== "string" || !/^key:[A-Za-z0-9._-]+$/.test(keyId)) {
    throw new TypeError("A public JWK and key ID are required.");
  }

  const wrappingKey = await cryptoImpl.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
  const payloadKey = await cryptoImpl.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await cryptoImpl.subtle.encrypt(
    { name: "AES-GCM", iv },
    payloadKey,
    plaintext
  );
  const rawPayloadKey = await cryptoImpl.subtle.exportKey("raw", payloadKey);
  const wrappedKey = await cryptoImpl.subtle.encrypt(
    { name: "RSA-OAEP" },
    wrappingKey,
    rawPayloadKey
  );

  return {
    schemaVersion,
    synthetic,
    keyId,
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedKey)),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext))
  };
}

const FORBIDDEN_CONTENT_KEYS = new Set([
  "prompt",
  "prompts",
  "response",
  "responses",
  "message",
  "messages",
  "content",
  "text",
  "body",
  "command",
  "commands",
  "argument",
  "arguments",
  "args",
  "path",
  "paths",
  "filepath",
  "filepaths",
  "filename",
  "filenames",
  "file",
  "files",
  "cwd",
  "workingdirectory",
  "repository",
  "repo",
  "email",
  "account",
  "accountid",
  "commandarguments",
  "participantid",
  "sessionid",
  "threadid"
]);

export function validateTelemetryContribution(payload, {
  maxSerializedBytes = MAX_TELEMETRY_BROWSER_BYTES,
  maxDepth = 12,
  maxArrayItems = 200
} = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("The export must be one JSON object.");
  }
  if (payload.schemaVersion !== TELEMETRY_SCHEMA_VERSION || payload.synthetic !== false) {
    throw new TypeError("Choose a real privacy-safe Usage Monitor telemetry export.");
  }
  const topLevelKeys = [
    "schemaVersion", "synthetic", "createdAt", "coveredAt", "clientPlatform",
    "providerPolicyEpoch", "usageEvents", "quotaSnapshots", "activityMarkers", "accounting"
  ];
  if (
    Object.keys(payload).length !== topLevelKeys.length
    || topLevelKeys.some((key) => !Object.hasOwn(payload, key))
  ) {
    throw new TypeError("The export does not match the closed telemetry contribution schema.");
  }
  if (
    !payload.coveredAt
    || typeof payload.coveredAt !== "object"
    || Array.isArray(payload.coveredAt)
    || Object.keys(payload.coveredAt).length !== 2
    || typeof payload.coveredAt.startAt !== "string"
    || typeof payload.coveredAt.endAt !== "string"
  ) {
    throw new TypeError("The export has an invalid coveredAt interval.");
  }

  const serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).byteLength > maxSerializedBytes) {
    throw new RangeError("The export is larger than the browser validation limit.");
  }
  for (const [key, maximum] of [
    ["usageEvents", 200],
    ["quotaSnapshots", 200],
    ["activityMarkers", 100]
  ]) {
    if (!Array.isArray(payload[key])) {
      throw new TypeError(`The export must include a ${key} array.`);
    }
    if (payload[key].length > maximum) {
      throw new RangeError(`The export contains too many ${key} records.`);
    }
  }
  const totalRecords = payload.usageEvents.length + payload.quotaSnapshots.length + payload.activityMarkers.length;
  if (totalRecords < 1) {
    throw new RangeError("The export contains no telemetry records.");
  }
  if (totalRecords > 200) {
    throw new RangeError("The export contains more than 200 telemetry records and must be contributed in smaller batches.");
  }

  const visit = (value, depth) => {
    if (depth > maxDepth) throw new RangeError("The export is nested too deeply.");
    if (Array.isArray(value)) {
      if (value.length > maxArrayItems) throw new RangeError("The export contains too many records.");
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (FORBIDDEN_CONTENT_KEYS.has(normalized)) {
        throw new TypeError(`The export contains a forbidden content field: ${key}.`);
      }
      visit(child, depth + 1);
    }
  };
  visit(payload, 0);
  return true;
}

/**
 * Conservative browser preflight for the account-scoped local-preview
 * contract. The Worker remains the authoritative closed-schema validator.
 */
export function validateAccountScopedTelemetryContribution(payload, {
  maxSerializedBytes = MAX_TELEMETRY_BROWSER_BYTES,
  maxDepth = 12,
  maxArrayItems = 200
} = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("The export must be one JSON object.");
  }
  if (
    payload.schemaVersion !== ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION
    || payload.consentVersion !== ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION
    || payload.status !== "implementation_disabled"
    || payload.synthetic !== false
  ) {
    throw new TypeError("Choose a privacy-safe account-scoped Usage Monitor export.");
  }
  const topLevelKeys = [
    "schemaVersion", "consentVersion", "status", "synthetic", "datasetId",
    "partIndex", "partCount", "completeness", "createdAt", "coveredAt",
    "clientPlatform", "providerPolicyEpoch", "usageEvents", "quotaSnapshots",
    "activityMarkers", "accountingDiagnostic"
  ];
  if (
    Object.keys(payload).length !== topLevelKeys.length
    || topLevelKeys.some((key) => !Object.hasOwn(payload, key))
    || typeof payload.datasetId !== "string"
    || !/^dataset:v1:[a-f0-9]{64}$/u.test(payload.datasetId)
    || !Number.isSafeInteger(payload.partIndex)
    || !Number.isSafeInteger(payload.partCount)
    || payload.partIndex < 1
    || payload.partCount < 1
    || payload.partCount > 100
    || payload.partIndex > payload.partCount
    || !["complete", "partial"].includes(payload.completeness)
  ) {
    throw new TypeError("The export does not match the account-scoped contribution contract.");
  }
  if (
    !payload.coveredAt
    || typeof payload.coveredAt !== "object"
    || Array.isArray(payload.coveredAt)
    || Object.keys(payload.coveredAt).length !== 2
    || typeof payload.coveredAt.startAt !== "string"
    || typeof payload.coveredAt.endAt !== "string"
    || !Number.isFinite(Date.parse(payload.coveredAt.startAt))
    || !Number.isFinite(Date.parse(payload.coveredAt.endAt))
    || Date.parse(payload.coveredAt.endAt) < Date.parse(payload.coveredAt.startAt)
  ) {
    throw new TypeError("The export has an invalid coveredAt interval.");
  }
  for (const [key, maximum, schemaVersion] of [
    ["usageEvents", 200, "usage-event-v0.2"],
    ["quotaSnapshots", 200, "quota-snapshot-v0.2"],
    ["activityMarkers", 100, "activity-marker-v0.2"]
  ]) {
    if (!Array.isArray(payload[key]) || payload[key].length > maximum) {
      throw new RangeError(`The export has an invalid ${key} array.`);
    }
    for (const row of payload[key]) {
      if (
        !row
        || typeof row !== "object"
        || Array.isArray(row)
        || row.schemaVersion !== schemaVersion
        || !(
          row.accountTrackId === "unattributed"
          || /^account-track:v1:[a-f0-9]{64}$/u.test(row.accountTrackId)
        )
      ) {
        throw new TypeError(`The export contains an invalid ${key} record.`);
      }
    }
  }
  const totalRecords = payload.usageEvents.length
    + payload.quotaSnapshots.length
    + payload.activityMarkers.length;
  if (totalRecords < 1 || totalRecords > 200) {
    throw new RangeError("The export must contain between 1 and 200 telemetry records.");
  }
  const serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).byteLength > maxSerializedBytes) {
    throw new RangeError("The export is larger than the browser validation limit.");
  }
  if (
    /(?:openai-)?account:v1:[a-f0-9]{64}/iu.test(serialized)
    || /(?:\/Users\/|\/home\/|[A-Z]:\\|@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/u.test(serialized)
  ) {
    throw new TypeError("The export contains a direct identity or local-path canary.");
  }
  const visit = (value, depth) => {
    if (depth > maxDepth) throw new RangeError("The export is nested too deeply.");
    if (Array.isArray(value)) {
      if (value.length > maxArrayItems) throw new RangeError("The export contains too many records.");
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (FORBIDDEN_CONTENT_KEYS.has(normalized)) {
        throw new TypeError(`The export contains a forbidden content field: ${key}.`);
      }
      visit(child, depth + 1);
    }
  };
  visit(payload, 0);
  return true;
}

export function validateContributionForUpload(payload, options = {}) {
  if (payload?.schemaVersion === ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION) {
    return validateAccountScopedTelemetryContribution(payload, options);
  }
  return validateTelemetryContribution(payload, options);
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

export function safeApiError(payload, fallback) {
  const candidate = typeof payload?.error === "string"
    ? payload.error
    : payload?.error?.code;
  if (typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(candidate)) {
    return candidate.replace(/_/g, " ");
  }
  return fallback;
}
