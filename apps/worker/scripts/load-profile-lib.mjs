export const FULL_PROFILE = Object.freeze({
  participants: 1_000,
  attemptsPerParticipant: 100,
  recordsPerAttempt: 200,
});

export const LOAD_LIMITS = Object.freeze({
  participants: 1_000,
  attemptsPerParticipant: 100,
  recordsPerAttempt: 200,
  concurrency: 50,
  enrollmentSpacingMilliseconds: 60_000,
  requestTimeoutMilliseconds: 120_000,
});

const MINIMUM_FULL_ATTEMPTS = 10_000;
const MINIMUM_FULL_EXPANDED_RECORDS = 20_000_000;
const UNPACED_ENROLLMENT_LIMIT = 20;
const SAFE_ENROLLMENT_SPACING_MILLISECONDS = 3_100;

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function loopbackOrigin(value) {
  const origin = new URL(value);
  if (origin.protocol !== "http:"
      || !["127.0.0.1", "localhost"].includes(origin.hostname)
      || origin.username
      || origin.password) {
    throw new TypeError("The load runner accepts only an unauthenticated loopback HTTP origin");
  }
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  return origin;
}

export function readOwnerOnlyInvitation(path) {
  const flags = process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  let descriptor;
  try {
    descriptor = openSync(path, flags);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()
        || metadata.size < 10
        || metadata.size > 512
        || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new TypeError("invalid invitation file");
    }
    const value = readFileSync(descriptor, { encoding: "utf8" }).trim();
    if (!/^um_invite_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u
      .test(value)) {
      throw new TypeError("invalid invitation file");
    }
    return value;
  } catch {
    throw new TypeError("invalid invitation file");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function deriveLoadProfile(input = {}) {
  const participants = boundedInteger(
    input.participants,
    "participants",
    1,
    LOAD_LIMITS.participants,
  );
  const attemptsPerParticipant = boundedInteger(
    input.attemptsPerParticipant,
    "attemptsPerParticipant",
    1,
    LOAD_LIMITS.attemptsPerParticipant,
  );
  const recordsPerAttempt = boundedInteger(
    input.recordsPerAttempt,
    "recordsPerAttempt",
    1,
    LOAD_LIMITS.recordsPerAttempt,
  );
  const concurrency = boundedInteger(
    input.concurrency,
    "concurrency",
    1,
    LOAD_LIMITS.concurrency,
  );
  const hotParticipantCount = boundedInteger(
    input.hotParticipantCount ?? 0,
    "hotParticipantCount",
    0,
    participants,
  );
  const hotAttemptsPerParticipant = hotParticipantCount === 0
    ? attemptsPerParticipant
    : boundedInteger(
      input.hotAttemptsPerParticipant,
      "hotAttemptsPerParticipant",
      attemptsPerParticipant,
      LOAD_LIMITS.attemptsPerParticipant,
    );
  const requestTimeoutMilliseconds = boundedInteger(
    input.requestTimeoutMilliseconds,
    "requestTimeoutMilliseconds",
    1_000,
    LOAD_LIMITS.requestTimeoutMilliseconds,
  );
  const enrollmentSpacingMilliseconds = boundedInteger(
    input.enrollmentSpacingMilliseconds,
    "enrollmentSpacingMilliseconds",
    0,
    LOAD_LIMITS.enrollmentSpacingMilliseconds,
  );
  if (participants > UNPACED_ENROLLMENT_LIMIT
      && enrollmentSpacingMilliseconds < SAFE_ENROLLMENT_SPACING_MILLISECONDS) {
    throw new Error(
      `More than ${UNPACED_ENROLLMENT_LIMIT} enrollments require at least`
      + ` ${SAFE_ENROLLMENT_SPACING_MILLISECONDS}ms pacing`,
    );
  }
  const normalParticipantCount = participants - hotParticipantCount;
  const bundleAttempts = normalParticipantCount * attemptsPerParticipant
    + hotParticipantCount * hotAttemptsPerParticipant;
  const expandedRecords = bundleAttempts * recordsPerAttempt;
  if (!Number.isSafeInteger(bundleAttempts) || !Number.isSafeInteger(expandedRecords)) {
    throw new RangeError("The derived workload exceeds safe integer arithmetic");
  }
  const fullProfileSatisfied = participants >= FULL_PROFILE.participants
    && bundleAttempts >= MINIMUM_FULL_ATTEMPTS
    && expandedRecords >= MINIMUM_FULL_EXPANDED_RECORDS;
  if (fullProfileSatisfied && input.allowFullProfile !== true) {
    throw new Error("The literal full profile requires --allow-full-profile");
  }
  return Object.freeze({
    schemaVersion: "backend-load-profile-v0.1",
    participants,
    attemptsPerParticipant,
    hotParticipantCount,
    hotAttemptsPerParticipant,
    recordsPerAttempt,
    concurrency,
    enrollmentSpacingMilliseconds,
    minimumEnrollmentDurationMilliseconds:
      Math.max(0, participants - 1) * enrollmentSpacingMilliseconds,
    requestTimeoutMilliseconds,
    bundleAttempts,
    expandedRecords,
    fullProfileSatisfied,
    minimumFullBundleAttempts: MINIMUM_FULL_ATTEMPTS,
    minimumFullExpandedRecords: MINIMUM_FULL_EXPANDED_RECORDS,
    enrollmentRateLimit: {
      globalAttempts: UNPACED_ENROLLMENT_LIMIT,
      periodMilliseconds: 60_000,
    },
  });
}

export function percentile(values, quantile) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (typeof quantile !== "number" || !Number.isFinite(quantile)
      || quantile < 0 || quantile > 1
      || values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new TypeError("A percentile requires finite non-negative samples and a 0..1 quantile");
  }
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(quantile * ordered.length) - 1] ?? ordered[0];
}

export function latencySummary(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { count: 0, minimumMs: null, medianMs: null, p95Ms: null, maximumMs: null };
  }
  let minimumMs = Number.POSITIVE_INFINITY;
  let maximumMs = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError("Latency samples must be finite and non-negative");
    }
    minimumMs = Math.min(minimumMs, value);
    maximumMs = Math.max(maximumMs, value);
  }
  return {
    count: values.length,
    minimumMs,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maximumMs,
  };
}

export async function mapConcurrent(items, concurrency, operation) {
  boundedInteger(concurrency, "concurrency", 1, LOAD_LIMITS.concurrency);
  if (!Array.isArray(items) || typeof operation !== "function") {
    throw new TypeError("Concurrent mapping requires an array and operation");
  }
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
