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

import { formatNumber } from "./ui-format.js";

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
    },
    // The forward complement of atOrBefore: the earliest observation at or
    // after the instant. A rolling window whose start edge falls inside a
    // collection silence has no backward observation to anchor on, but often
    // has one just inside the window; the caller can anchor there and shrink
    // the window to the actually-measured span instead of discarding it.
    atOrAfter(timestampMs) {
      if (typeof timestampMs !== "number" || Number.isNaN(timestampMs)) {
        return null;
      }
      let lower = 0;
      let upper = entries.length;
      while (lower < upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        if (entries[middle].timestampMs < timestampMs) {
          lower = middle + 1;
        } else {
          upper = middle;
        }
      }
      return lower === entries.length ? null : entries[lower];
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
  return formatNumber(total, { notation: "compact", maximumFractionDigits: 1 });
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
  "fast_mode_preference",
  "hosted_identity",
  "hosted_privacy",
  "local_refresh",
  // 2026-08-08 (deletion honesty): the "Delete my contributions" action files
  // its failures like every other journey. The companion accepts the same
  // fixed name.
  "participant_deletion"
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
 * reference, and the service request id when the service supplied one. The
 * local-log claim is emitted only when the awaited companion response confirms
 * that the same reference was recorded.
 */
export function diagnosticReferenceSentence({
  reference,
  requestId = "",
  writtenToLocalLog = false
} = {}) {
  if (!DIAGNOSTIC_REFERENCE_PATTERN.test(reference ?? "")) return "";
  if (writtenToLocalLog !== true) return `Reference ${reference}.`;
  const service = serviceRequestId(requestId);
  return service === ""
    ? `Reference ${reference}, also written to the local diagnostics log.`
    : `Reference ${reference} · service request ${service}. Both are written to the local diagnostics log.`;
}

// --- Deviation-period detector ---------------------------------------------
//
// A deviation period is a SUSTAINED stretch where the re-anchored cumulative
// drift — the running sum of each non-overlapping bucket's observed-minus-priced
// quota movement, restarted at every reset boundary or track change, exactly
// the `cumulativeResidual` series `liveTimelinePoints` draws and the signed AUC
// in src/simple-quota-gradient.js integrates — moves materially away from zero
// and stays there. It is deliberately NOT a single spike: a short excursion
// that returns to zero, or a +spike immediately cancelled by a -spike, must not
// be reported. The detector reads the same live timeline points the residual
// chart uses (each carries `cumulativeResidual` and, at a fresh anchor, a
// `driftReanchor` flag) and returns an ordered list of periods.

// |cumulative drift| must exceed this, in percentage points, for a bucket to
// count as diverging. Pinned to the 5 pp minimum displayed span the weekly
// calibration contract already treats as the smallest movement worth reading
// (WEEKLY_CALIBRATION_MINIMUM_DISPLAYED_SPAN_PP in localization.js): a drift
// smaller than the smallest span we will draw is not a finding.
export const DEVIATION_DRIFT_THRESHOLD_PP = 5;
// A run must persist at least this long before it is a "period" rather than a
// transient. The residual series is a 3-hour rolling window, so a genuine
// sustained disagreement outlives a large share of that window; two hours is
// long enough that a single window's settling cannot manufacture a period, and
// short enough to catch a real half-window run.
export const DEVIATION_MIN_DURATION_MS = 2 * 60 * 60 * 1_000;
// Same-sign runs separated only by a brief sub-threshold dip (no reset, no data
// gap between them) are one period, not two. 45 minutes is three 15-minute
// buckets — long enough to bridge a shallow wobble, short enough that a real
// return to zero still ends the period.
export const DEVIATION_MERGE_GAP_MS = 45 * 60 * 1_000;
// The list is capped so the panel stays readable. Anything beyond the cap is
// counted and reported (see `totalFound`/`truncated`), never silently dropped.
export const DEVIATION_MAX_PERIODS = 20;

function deviationNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function deviationNonNegative(value) {
  const number = deviationNumberOrNull(value);
  return number === null || number < 0 ? 0 : number;
}

function deviationPointMs(point) {
  const stamped = point?.timestampMs;
  if (typeof stamped === "number" && Number.isFinite(stamped)) return stamped;
  return Date.parse(point?.timestamp ?? "");
}

// The signed observed-minus-priced area, in pp·hours, over the period's points.
// Trapezoidal over the per-window residual, matching buildRollingResidual's
// signed AUC in src/simple-quota-gradient.js so the two statistics agree.
function deviationSignedAuc(points) {
  let area = 0;
  for (let index = 1; index < points.length; index += 1) {
    const prior = points[index - 1];
    const current = points[index];
    if (prior.residual === null || current.residual === null) continue;
    const elapsedHours = (current.timestampMs - prior.timestampMs) / 3_600_000;
    if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) continue;
    area += elapsedHours * (prior.residual + current.residual) / 2;
  }
  return area;
}

// Within one drift segment (no reset, no gap), the maximal same-sign runs whose
// |drift| exceeds the threshold, merging two same-sign runs separated only by a
// brief sub-threshold dip. A sign flip between two runs is never bridged, so a
// spike that cancels can never merge into its own rebound.
function deviationSegmentExcursions(segment, { thresholdPp, mergeGapMs }) {
  const runs = [];
  let run = null;
  for (const point of segment) {
    const sign = point.drift > thresholdPp ? 1
      : point.drift < -thresholdPp ? -1
        : 0;
    if (sign === 0) {
      run = null;
      continue;
    }
    if (run && run.sign === sign) {
      run.points.push(point);
    } else {
      run = { sign, points: [point] };
      runs.push(run);
    }
  }
  const merged = [];
  for (const candidate of runs) {
    const last = merged.at(-1);
    if (last
        && last.sign === candidate.sign
        && candidate.points[0].timestampMs
          - last.points.at(-1).timestampMs <= mergeGapMs) {
      last.points.push(...candidate.points);
    } else {
      merged.push({ sign: candidate.sign, points: [...candidate.points] });
    }
  }
  return merged;
}

// Aggregate the exact usage buckets whose end falls inside the period. This is
// the only per-period contributor evidence available client-side: cost, token
// volume, usage-change count, and the unpriced-change share. The per-period
// model and speed MIX is not in the timeline payload — those breakdowns exist
// only at the whole-selected-period grain (byModel/bySpeed) — so the renderer
// layers the range-level dominant model/speed on top, clearly marked as
// range context rather than a period-specific claim.
function deviationBucketContributors(buckets, startMs, endMs) {
  let costUsd = 0;
  let totalTokens = 0;
  let usageEvents = 0;
  let unpricedEvents = 0;
  let bucketCount = 0;
  for (const bucket of buckets) {
    if (bucket.endMs < startMs || bucket.endMs > endMs) continue;
    costUsd += bucket.cost;
    totalTokens += bucket.tokens;
    usageEvents += bucket.events;
    unpricedEvents += bucket.unpriced;
    bucketCount += 1;
  }
  return {
    costUsd,
    totalTokens,
    usageEvents,
    unpricedEvents,
    pricedEvents: Math.max(0, usageEvents - unpricedEvents),
    unpricedEventShare: usageEvents > 0 ? unpricedEvents / usageEvents : null,
    bucketCount,
  };
}

/**
 * Find the sustained periods where observed quota movement persistently
 * disagrees with priced (cost-implied) usage.
 *
 * @param {Array} points  Live timeline points, each `{ timestampMs, timestamp,
 *   cumulativeResidual, residual, driftReanchor }`. A null/absent
 *   `cumulativeResidual` is a data gap that ends any run; a `driftReanchor`
 *   point starts a fresh segment (a reset boundary or track change), which ends
 *   the preceding period by construction.
 * @param {Object} [options]
 * @param {Array}  [options.usageBuckets]  Raw `data.timeline.usage` buckets,
 *   used only to attach the exact per-period contributor totals.
 * @returns {{ periods: Array, totalFound: number, truncated: boolean,
 *   thresholdPp: number, minDurationMs: number, hasDriftSeries: boolean }}
 */
export function detectDeviationPeriods(points, {
  usageBuckets = [],
  thresholdPp = DEVIATION_DRIFT_THRESHOLD_PP,
  minDurationMs = DEVIATION_MIN_DURATION_MS,
  mergeGapMs = DEVIATION_MERGE_GAP_MS,
  maxPeriods = DEVIATION_MAX_PERIODS,
} = {}) {
  const series = (Array.isArray(points) ? points : [])
    .map((point) => ({
      timestampMs: deviationPointMs(point),
      timestamp: typeof point?.timestamp === "string" ? point.timestamp : null,
      drift: deviationNumberOrNull(point?.cumulativeResidual),
      residual: deviationNumberOrNull(point?.residual),
      reanchor: point?.driftReanchor === true,
    }))
    .filter((point) => Number.isFinite(point.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  // Whether any drift evidence exists at all separates "nothing diverged" from
  // "this view carries no cumulative-drift series to judge" — the historical
  // artifact view has no per-window reset anchors, so it can only ever report
  // the latter, and the panel must not read it as a clean bill of health.
  const hasDriftSeries = series.some((point) => point.drift !== null);

  // Split into segments at data gaps (null drift) and reset re-anchors.
  const segments = [];
  let segment = [];
  for (const point of series) {
    if (point.drift === null) {
      if (segment.length) segments.push(segment);
      segment = [];
      continue;
    }
    if (point.reanchor && segment.length) {
      segments.push(segment);
      segment = [];
    }
    segment.push(point);
  }
  if (segment.length) segments.push(segment);

  const buckets = (Array.isArray(usageBuckets) ? usageBuckets : [])
    .map((bucket) => ({
      endMs: Date.parse(bucket?.endAt ?? ""),
      cost: deviationNonNegative(bucket?.apiPriceEquivalentUsd),
      tokens: deviationNonNegative(bucket?.totalTokens),
      events: deviationNonNegative(bucket?.usageEvents),
      unpriced: deviationNonNegative(bucket?.pricingCoverage?.unpricedEvents),
    }))
    .filter((bucket) => Number.isFinite(bucket.endMs));

  const found = [];
  for (const currentSegment of segments) {
    for (const run of deviationSegmentExcursions(currentSegment, {
      thresholdPp,
      mergeGapMs,
    })) {
      const runPoints = run.points;
      const startMs = runPoints[0].timestampMs;
      const endMs = runPoints.at(-1).timestampMs;
      const durationMs = endMs - startMs;
      if (durationMs < minDurationMs) continue;
      let peakDriftPp = 0;
      for (const point of runPoints) {
        if (Math.abs(point.drift) > Math.abs(peakDriftPp)) {
          peakDriftPp = point.drift;
        }
      }
      found.push({
        startAt: runPoints[0].timestamp,
        endAt: runPoints.at(-1).timestamp,
        startMs,
        endMs,
        durationMs,
        directionSign: run.sign,
        direction: run.sign > 0 ? "under_costed" : "over_costed",
        peakDriftPp,
        absPeakDriftPp: Math.abs(peakDriftPp),
        netDriftPp: runPoints.at(-1).drift - runPoints[0].drift,
        signedAucPpHours: deviationSignedAuc(runPoints),
        pointCount: runPoints.length,
        contributors: deviationBucketContributors(buckets, startMs, endMs),
      });
    }
  }

  found.sort((left, right) => right.absPeakDriftPp - left.absPeakDriftPp);
  return {
    periods: found.slice(0, maxPeriods),
    totalFound: found.length,
    truncated: found.length > maxPeriods,
    thresholdPp,
    minDurationMs,
    hasDriftSeries,
  };
}

const CONTRIBUTION_REVIEWABLE_QUEUE_STATES = new Set([
  "ready",
  "retry_wait",
  "paused",
]);

/**
 * Delivery scheduling never changes whether a locally verified payload can be
 * reviewed. A retry deadline or a paused uploader is transport state only.
 */
export function isContributionReviewableQueueState(state) {
  return CONTRIBUTION_REVIEWABLE_QUEUE_STATES.has(state);
}

/**
 * Decide the next local-only review-bootstrap action from the bounded preview.
 * No usable preview is an explicit recovery state; it must never degrade into
 * an indefinitely disabled approval button with no explanation.
 */
export function contributionReviewBootstrapAction(preview) {
  if (preview?.status !== "available") return "unavailable";
  if (preview.state === "empty") {
    return preview.item === null ? "prepare" : "unavailable";
  }
  return isContributionReviewableQueueState(preview.state)
      && preview.item !== null
      && typeof preview.item === "object"
      && !Array.isArray(preview.item)
    ? "review"
    : "unavailable";
}

/**
 * Whether the silent bootstrap may PREPARE a new review instance. Preparing
 * is the bootstrap's only step that mints durable state — a prepared set the
 * v0.1 queue will hold until it delivers or is retired — so it additionally
 * requires a positively read pre-consent verdict from the incremental sync
 * status. An unreadable verdict must never prepare: on an approved Mac the
 * set could never deliver and would only strand disk and queue weight
 * (observed live 2026-08-19). A consent-version change reads approved with
 * current=false and stays permitted — that ceremony needs its fresh review.
 */
export function contributionReviewPreparationPermitted(incrementalStatus) {
  return incrementalStatus?.status === "available"
    && !(incrementalStatus.consent?.approved === true
      && incrementalStatus.consent?.current === true);
}

/**
 * A local preparation or exact-review read crosses native Keychain, SQLite,
 * and loopback boundaries. None may leave the contribution ceremony busy
 * forever: after one minute the page exposes its explicit retry so the caller
 * can record a bounded diagnostic, while the local operation remains free to
 * settle safely in the companion.
 */
export function withContributionReviewDeadline(operation, {
  timeoutMilliseconds = 60_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1
      || timeoutMilliseconds > 60_000
      || typeof setTimer !== "function"
      || typeof clearTimer !== "function") {
    throw new TypeError("Contribution review deadline is invalid.");
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      const error = new Error("The local contribution review did not finish.");
      error.code = "local_review_timed_out";
      reject(error);
    }, timeoutMilliseconds);
    Promise.resolve(operation).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        reject(error);
      },
    );
  });
}

/**
 * Fence asynchronous review reads by a monotonically increasing generation.
 * A timeout cannot cancel every native/loopback operation already in flight,
 * so callers must also refuse to commit results from any superseded attempt.
 */
export function createLatestContributionReviewFence() {
  let generation = 0;
  return Object.freeze({
    begin() {
      generation = generation === Number.MAX_SAFE_INTEGER ? 1 : generation + 1;
      return generation;
    },
    isCurrent(candidate) {
      return Number.isSafeInteger(candidate) && candidate === generation;
    },
    current() {
      return generation;
    },
  });
}
