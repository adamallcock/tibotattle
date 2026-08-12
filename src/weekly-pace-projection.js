import {
  analyzeQuotaPace,
  SEVEN_DAY_WINDOW_MINUTES,
} from "@app-usagemonitor/quota-analysis";
import { sanitizeAccountScope } from "./providers/codex/account.js";

const SCHEMA_VERSION = "local-weekly-pace-forecast-v0.1";
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
      percentagePointsPerHour: numberOrNull(
        pace.percentagePointsPerHour,
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
      percentagePointsPerHour: null,
    },
    observationCount: 0,
    etaAt: null,
    hoursToExhaustion: null,
    hoursToReset: null,
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
