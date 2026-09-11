import {
  analyzeQuotaPace,
  SEVEN_DAY_WINDOW_MINUTES,
} from "@app-usagemonitor/quota-analysis";
import { sanitizeAccountScope } from "./providers/codex/account.js";

// v0.2 (2026-08-19): mirrors quota-pace-forecast-v0.2 - the single ambiguous
// `percentagePointsPerHour` is replaced by a named working-time rate and a
// named wall-clock rate, and the ETA follows the wall-clock one.
const SCHEMA_VERSION = "local-weekly-pace-forecast-v0.2";
export const WEEKLY_PACE_OUTLOOK_SCHEMA_VERSION =
  "local-weekly-pace-outlook-v0.1";
const PROVIDER = "openai_codex";
const LIMIT_ID = "codex";
const SLOT_PRIORITY = Object.freeze(["primary", "secondary"]);
const MAX_OBSERVATION_COUNT = 8_192;
const APP_SERVER_SOURCES = new Set([
  "app_server_read",
  "app_server_notification",
]);
const MAX_CURRENT_AGE_MS = 30 * 60_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const PACE_ON_TRACK_LOWER_RATIO = 0.85;
const PACE_ON_TRACK_UPPER_RATIO = 1.15;
const PACE_CRITICAL_RATIO = 2;
const PACE_AVERAGE_MINIMUM_HOURS = 1;
const ACTIVE_MARKER_MINIMUM_LEAD_FACTOR = 0.95;
const PUBLIC_FORECAST_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "currentUsedPercent",
  "remainingPercent",
  "resetsAt",
  "pace",
  "observationCount",
  "etaAt",
  "hoursToExhaustion",
  "hoursToReset",
]);
const PUBLIC_FORECAST_PACE_KEYS = Object.freeze([
  "method",
  "sampleCount",
  "elapsedHours",
  "movementPp",
  "activePercentagePointsPerHour",
  "overallPercentagePointsPerHour",
]);
const PUBLIC_FORECAST_STATUSES = new Set([
  "unavailable",
  "insufficient_observations",
  "available",
  "will_reach_reset_first",
]);

function canonicalInstant(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

function finite(value, { minimum = -Infinity, maximum = Infinity } = {}) {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
    ? value
    : null;
}

function hasExactKeys(value, expectedKeys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function nullableFinite(value, options) {
  return value === null || finite(value, options) !== null;
}

export function isExactWeeklyPaceForecast(value) {
  if (!hasExactKeys(value, PUBLIC_FORECAST_KEYS)
      || value.schemaVersion !== SCHEMA_VERSION
      || !PUBLIC_FORECAST_STATUSES.has(value.status)
      || !hasExactKeys(value.pace, PUBLIC_FORECAST_PACE_KEYS)
      || (value.pace.method !== null
        && value.pace.method !== "median_adjacent_quota_slope")
      || !Number.isSafeInteger(value.pace.sampleCount)
      || value.pace.sampleCount < 0
      || value.pace.sampleCount >= MAX_OBSERVATION_COUNT
      || !Number.isSafeInteger(value.observationCount)
      || (value.observationCount !== value.pace.sampleCount + 1
        && !(value.status === "unavailable"
          && value.observationCount === 0
          && value.pace.sampleCount === 0))
      || !nullableFinite(value.currentUsedPercent, { minimum: 0, maximum: 100 })
      || !nullableFinite(value.remainingPercent, { minimum: 0, maximum: 100 })
      || !nullableFinite(value.pace.elapsedHours, { minimum: 0 })
      || !nullableFinite(value.pace.movementPp, { minimum: 0 })
      || !nullableFinite(value.pace.activePercentagePointsPerHour, {
        minimum: 0,
        maximum: 100,
      })
      || !nullableFinite(value.pace.overallPercentagePointsPerHour, {
        minimum: 0,
        maximum: 100,
      })
      || !nullableFinite(value.hoursToExhaustion, { minimum: 0 })
      || !nullableFinite(value.hoursToReset, { minimum: 0 })
      || (value.resetsAt !== null && canonicalInstant(value.resetsAt) === null)
      || (value.etaAt !== null && canonicalInstant(value.etaAt) === null)
      || (value.currentUsedPercent === null)
        !== (value.remainingPercent === null)) return false;

  if (value.status === "unavailable") {
    return value.currentUsedPercent === null
      && value.remainingPercent === null
      && value.resetsAt === null
      && value.pace.method === null
      && value.pace.sampleCount === 0
      && value.pace.elapsedHours === null
      && value.pace.movementPp === null
      && value.pace.activePercentagePointsPerHour === null
      && value.pace.overallPercentagePointsPerHour === null
      && value.observationCount === 0
      && value.etaAt === null
      && value.hoursToExhaustion === null
      && value.hoursToReset === null;
  }

  const hasCurrent = value.currentUsedPercent !== null;
  if (hasCurrent) {
    if (value.pace.method !== "median_adjacent_quota_slope"
        || value.resetsAt === null
        || value.hoursToReset === null
        || Math.abs(
          value.currentUsedPercent + value.remainingPercent - 100
        ) > 1e-6) return false;
  } else if (value.status !== "unavailable"
      || value.resetsAt !== null
      || value.pace.method !== null
      || value.observationCount !== 0
      || value.hoursToReset !== null) return false;

  if (value.status === "available") {
    return value.currentUsedPercent !== null
      && value.remainingPercent !== null
      && value.resetsAt !== null
      && value.etaAt !== null
      && value.pace.elapsedHours > 0
      && value.pace.overallPercentagePointsPerHour > 0
      && value.observationCount >= 2
      && value.hoursToExhaustion !== null
      && value.hoursToReset !== null
      && Date.parse(value.etaAt) < Date.parse(value.resetsAt);
  }
  if (value.etaAt !== null || value.hoursToExhaustion !== null) return false;
  if (value.status === "will_reach_reset_first") {
    return value.currentUsedPercent !== null
      && value.remainingPercent !== null
      && value.resetsAt !== null
      && value.pace.elapsedHours > 0
      && value.pace.overallPercentagePointsPerHour > 0
      && value.observationCount >= 2
      && value.hoursToReset !== null;
  }
  if (value.status === "insufficient_observations") {
    return value.currentUsedPercent !== null
      && value.remainingPercent !== null
      && value.resetsAt !== null
      && value.observationCount === 1
      && value.pace.sampleCount === 0
      && value.pace.elapsedHours === 0
      && value.pace.movementPp === 0
      && value.pace.activePercentagePointsPerHour === null
      && value.pace.overallPercentagePointsPerHour === null
      && value.hoursToReset !== null;
  }
  return false;
}

function safePlanType(value) {
  return typeof value === "string"
    && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)
    ? value
    : "unknown";
}

function opaqueAccountTrackId(record) {
  const scope = sanitizeAccountScope(record?.accountScope);
  return scope.status === "available" ? scope.scopeId : null;
}

function resetInstant(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  const instant = new Date(value * 1_000);
  return Number.isFinite(instant.valueOf()) ? instant.toISOString() : null;
}

function normalizedSnapshot(record, window) {
  if (record?.kind !== "codex_quota_snapshot"
      || record.provider !== PROVIDER
      || !APP_SERVER_SOURCES.has(record.source)
      || record.stalenessMs !== 0
      || !window
      || typeof window !== "object"
      || window.limitId !== LIMIT_ID
      || !SLOT_PRIORITY.includes(window.slot)
      || window.windowDurationMins !== SEVEN_DAY_WINDOW_MINUTES) return null;
  const accountTrackId = opaqueAccountTrackId(record);
  const observedAt = canonicalInstant(record.observedAt);
  const receivedAt = canonicalInstant(record.receivedAt);
  const resetsAt = resetInstant(window.resetsAt);
  const usedPercent = finite(window.usedPercent, { minimum: 0, maximum: 100 });
  if (accountTrackId === null
      || observedAt === null
      || receivedAt === null
      || resetsAt === null
      || usedPercent === null) return null;
  return {
    accountTrackId,
    provider: PROVIDER,
    planType: safePlanType(window.planType),
    // The shared quota-analysis pace contract requires a non-empty planVariant
    // track field (validateSnapshot / plainExact), so it stays on the wire even
    // though the local plan cohort is now carried by planType. This forecast is
    // confined to one current reset and never infers a plan tier across resets.
    planVariant: "current_reset_unobserved",
    limitId: LIMIT_ID,
    slot: window.slot,
    windowDurationMinutes: SEVEN_DAY_WINDOW_MINUTES,
    resetsAt,
    observedAt,
    receivedAt,
    usedPercent,
    policyEpoch: "current_reset_only",
  };
}

/**
 * Converts one retained local app-server quota record into private, in-memory
 * pace inputs. The opaque account key is deliberately not part of the public
 * forecast projection.
 */
export function weeklyPaceSnapshotsFromCollectorRecord(record) {
  const windows = Array.isArray(record?.windows) ? record.windows : [];
  return windows.flatMap((window) => {
    const snapshot = normalizedSnapshot(record, window);
    return snapshot === null ? [] : [snapshot];
  });
}

// Track identity is (limit, duration) plus reset/plan facets. Slot is a
// server-assigned UI role — the weekly window flipped secondary -> primary
// around 2026-07-06 — so it stays visible metadata on the snapshot but never
// splits one continuous track's observations.
function sameTrack(left, right) {
  return left.accountTrackId === right.accountTrackId
    && left.provider === right.provider
    && left.planType === right.planType
    && left.planVariant === right.planVariant
    && left.limitId === right.limitId
    && left.windowDurationMinutes === right.windowDurationMinutes
    && left.resetsAt === right.resetsAt
    && left.policyEpoch === right.policyEpoch;
}

function chooseCurrent(rows) {
  return [...rows].sort((left, right) => (
    SLOT_PRIORITY.indexOf(left.slot) - SLOT_PRIORITY.indexOf(right.slot)
    || left.usedPercent - right.usedPercent
  )).at(0) ?? null;
}

function numberOrNull(value, { minimum = -Infinity, maximum = Infinity } = {}) {
  return finite(value, { minimum, maximum });
}

function publicForecast(result) {
  const status = [
    "unavailable",
    "insufficient_observations",
    "available",
    "will_reach_reset_first",
  ].includes(result?.status)
    ? result.status
    : "unavailable";
  const pace = result?.pace && typeof result.pace === "object"
    && !Array.isArray(result.pace)
    ? result.pace
    : {};
  const sampleCount = Number.isSafeInteger(pace.sampleCount)
    && pace.sampleCount >= 0
    && pace.sampleCount < MAX_OBSERVATION_COUNT
    ? pace.sampleCount
    : 0;
  const resetsAt = canonicalInstant(result?.resetsAt);
  const etaAt = canonicalInstant(result?.etaAt);
  return {
    schemaVersion: SCHEMA_VERSION,
    status,
    currentUsedPercent: numberOrNull(result?.currentUsedPercent, {
      minimum: 0,
      maximum: 100,
    }),
    remainingPercent: numberOrNull(result?.remainingPercent, {
      minimum: 0,
      maximum: 100,
    }),
    resetsAt,
    pace: {
      method: pace.method === "median_adjacent_quota_slope"
        ? pace.method
        : null,
      sampleCount,
      elapsedHours: numberOrNull(pace.elapsedHours, { minimum: 0 }),
      movementPp: numberOrNull(pace.movementPp, { minimum: 0 }),
      // Both rates travel to the surface. The active one is the "if you never
      // pause" edge; the overall one is what `etaAt` below is built from.
      activePercentagePointsPerHour: numberOrNull(
        pace.activePercentagePointsPerHour,
        { minimum: 0, maximum: 100 },
      ),
      overallPercentagePointsPerHour: numberOrNull(
        pace.overallPercentagePointsPerHour,
        { minimum: 0, maximum: 100 },
      ),
    },
    observationCount: Math.min(MAX_OBSERVATION_COUNT, sampleCount + 1),
    etaAt: status === "available" ? etaAt : null,
    hoursToExhaustion: status === "available"
      ? numberOrNull(result?.hoursToExhaustion, { minimum: 0 })
      : null,
    hoursToReset: numberOrNull(result?.hoursToReset, { minimum: 0 }),
  };
}

function unavailableForecast() {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: "unavailable",
    currentUsedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    pace: {
      method: null,
      sampleCount: 0,
      elapsedHours: null,
      movementPp: null,
      activePercentagePointsPerHour: null,
      overallPercentagePointsPerHour: null,
    },
    observationCount: 0,
    etaAt: null,
    hoursToExhaustion: null,
    hoursToReset: null,
  };
}

function emptyOutlook() {
  return {
    schemaVersion: WEEKLY_PACE_OUTLOOK_SCHEMA_VERSION,
    status: "unavailable",
    standing: null,
    critical: false,
    earlyEstimate: false,
    remainingPercent: null,
    resetsAt: null,
    observationCount: 0,
    elapsedHours: null,
    rates: {
      activePercentagePointsPerHour: null,
      overallPercentagePointsPerHour: null,
      headlinePercentagePointsPerHour: null,
      sustainablePercentagePointsPerHour: null,
      ratio: null,
    },
    projection: {
      hoursToReset: null,
      coveredHours: null,
      dryHours: null,
      sparePercent: null,
      projectedExhaustionAt: null,
    },
    track: {
      coveredFraction: null,
      activeExhaustionFraction: null,
    },
  };
}

function positive(value, { maximum = Infinity } = {}) {
  const number = finite(value, { minimum: 0, maximum });
  return number !== null && number > 0 ? number : null;
}

function outlookRates(forecast) {
  const pace = forecast?.pace && typeof forecast.pace === "object"
      && !Array.isArray(forecast.pace)
    ? forecast.pace
    : {};
  const active = positive(pace.activePercentagePointsPerHour, { maximum: 100 });
  const elapsedHours = finite(pace.elapsedHours, { minimum: 0 });
  const movementPp = finite(pace.movementPp, { minimum: 0 });
  const derivedOverall = elapsedHours !== null
      && elapsedHours >= PACE_AVERAGE_MINIMUM_HOURS
      && movementPp !== null
      && movementPp > 0
    ? movementPp / elapsedHours
    : null;
  const reportedOverall = positive(
    pace.overallPercentagePointsPerHour,
    { maximum: 100 },
  );
  const overall = reportedOverall ?? derivedOverall;
  return {
    active,
    overall,
    headline: overall ?? active,
    elapsedHours,
  };
}

/**
 * Turns the evidence-facing forecast into the complete presentation reading
 * shared by native and web. This DTO contains no account identifier, path,
 * provider payload, reset-credit state, or free text. Consumers validate and
 * render these values; they do not independently classify the pace.
 */
export function projectWeeklyPaceOutlook({ forecast, nowMs = Date.now() } = {}) {
  const unavailable = emptyOutlook();
  if (!isExactWeeklyPaceForecast(forecast)
      || !Number.isFinite(nowMs)) return unavailable;

  const resetsAt = canonicalInstant(forecast.resetsAt);
  const resetMs = resetsAt === null ? Number.NaN : Date.parse(resetsAt);
  const remainingPercent = finite(forecast.remainingPercent, {
    minimum: 0,
    maximum: 100,
  });
  const observationCount = Number.isSafeInteger(forecast.observationCount)
      && forecast.observationCount >= 0
      && forecast.observationCount <= MAX_OBSERVATION_COUNT
    ? forecast.observationCount
    : null;
  const elapsedHours = finite(forecast.pace?.elapsedHours, { minimum: 0 });
  const hoursToReset = Number.isFinite(resetMs)
    ? (resetMs - nowMs) / HOUR_MS
    : null;
  if (remainingPercent === null
      || observationCount === null
      || elapsedHours === null
      || !(hoursToReset > 0)) return unavailable;

  if (forecast.status === "insufficient_observations"
      && observationCount === 1) {
    return {
      ...unavailable,
      status: "collecting",
      remainingPercent,
      resetsAt,
      observationCount,
      elapsedHours,
      projection: {
        ...unavailable.projection,
        hoursToReset,
      },
    };
  }
  if (![
    "available",
    "will_reach_reset_first",
  ].includes(forecast.status)
      || observationCount < 2
      || remainingPercent <= 0
      || elapsedHours <= 0) {
    return unavailable;
  }

  const rates = outlookRates(forecast);
  if (!(rates.headline > 0)) return unavailable;
  if (forecast.status === "available") {
    const etaAt = canonicalInstant(forecast.etaAt);
    const etaMs = etaAt === null ? Number.NaN : Date.parse(etaAt);
    if (!(etaMs > nowMs && etaMs < resetMs)) return unavailable;
  }

  const sustainable = remainingPercent / hoursToReset;
  const ratio = rates.headline / sustainable;
  if (!(sustainable > 0) || !(ratio > 0) || !Number.isFinite(ratio)) {
    return unavailable;
  }
  const standing = ratio > PACE_ON_TRACK_UPPER_RATIO
    ? "over"
    : ratio < PACE_ON_TRACK_LOWER_RATIO ? "under" : "on";
  const coveredHours = Math.min(
    hoursToReset,
    remainingPercent / rates.headline,
  );
  const dryHours = Math.max(0, hoursToReset - coveredHours);
  const sparePercent = Math.max(
    0,
    remainingPercent - rates.headline * hoursToReset,
  );
  const coveredFraction = Math.max(
    0,
    Math.min(1, coveredHours / hoursToReset),
  );
  const activeExhaustionHours = rates.active === null
    ? null
    : remainingPercent / rates.active;
  const activeExhaustionFraction = activeExhaustionHours !== null
      && activeExhaustionHours < coveredHours * ACTIVE_MARKER_MINIMUM_LEAD_FACTOR
    ? Math.max(0, Math.min(1, activeExhaustionHours / hoursToReset))
    : null;
  const projectedExhaustionAt = standing === "over"
    ? new Date(nowMs + coveredHours * HOUR_MS).toISOString()
    : null;

  return {
    schemaVersion: WEEKLY_PACE_OUTLOOK_SCHEMA_VERSION,
    status: "available",
    standing,
    critical: standing === "over" && ratio >= PACE_CRITICAL_RATIO,
    earlyEstimate: forecast.status === "available" && (
      observationCount <= 2 || elapsedHours < PACE_AVERAGE_MINIMUM_HOURS
    ),
    remainingPercent,
    resetsAt,
    observationCount,
    elapsedHours,
    rates: {
      activePercentagePointsPerHour: rates.active,
      overallPercentagePointsPerHour: rates.overall,
      headlinePercentagePointsPerHour: rates.headline,
      sustainablePercentagePointsPerHour: sustainable,
      ratio,
    },
    projection: {
      hoursToReset,
      coveredHours,
      dryHours,
      sparePercent,
      projectedExhaustionAt,
    },
    track: {
      coveredFraction,
      activeExhaustionFraction,
    },
  };
}

/**
 * Projects a safe current-reset pace estimate from account-scoped local
 * app-server records. It intentionally refuses the account-unattributed
 * rollout-log history used elsewhere for price calibration.
 */
export function projectWeeklyPaceForecast({
  currentRecord,
  observations = [],
  nowMs = Date.now(),
} = {}) {
  const current = chooseCurrent(
    weeklyPaceSnapshotsFromCollectorRecord(currentRecord),
  );
  if (current === null || !Array.isArray(observations)) {
    return unavailableForecast();
  }
  const currentObservedMs = Date.parse(current.observedAt);
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (currentObservedMs < effectiveNowMs - MAX_CURRENT_AGE_MS
      || currentObservedMs > effectiveNowMs + MAX_FUTURE_CLOCK_SKEW_MS) {
    return unavailableForecast();
  }
  const compatible = observations
    .filter((row) => row && typeof row === "object" && sameTrack(row, current))
    .sort((left, right) => (
      left.observedAt.localeCompare(right.observedAt)
      || left.receivedAt.localeCompare(right.receivedAt)
      || left.usedPercent - right.usedPercent
    ))
    .slice(-MAX_OBSERVATION_COUNT);
  try {
    return publicForecast(analyzeQuotaPace({
      currentSnapshot: current,
      observations: compatible,
    }));
  } catch {
    return unavailableForecast();
  }
}
