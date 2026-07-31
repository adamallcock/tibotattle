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

export function safeApiError(payload, fallback) {
  const candidate = typeof payload?.error === "string"
    ? payload.error
    : payload?.error?.code;
  if (typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(candidate)) {
    return candidate.replace(/_/g, " ");
  }
  return fallback;
}
