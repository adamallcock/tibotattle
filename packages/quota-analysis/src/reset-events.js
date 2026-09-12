import { isValidQuotaWindowDuration } from "./quota-windows.js";

export const QUOTA_RESET_EVENT_SCHEMA_VERSION = "quota-reset-event-v0.1";
export const RESET_EVENT_CONTINUITY_SCHEMA_VERSION =
  "reset-event-continuity-v0.1";

export const QUOTA_RESET_EVENT_KINDS = Object.freeze([
  "scheduled_reset",
  "banked_reset_used",
  "unknown_reset",
  "reset_credit_granted",
  "reset_credit_expired",
]);

export const QUOTA_RESET_EVENT_PRECISIONS = Object.freeze([
  "provider_schedule",
  "observation_interval",
  "provider_timestamp",
]);

export const QUOTA_RESET_EVENT_REASONS = Object.freeze([
  "scheduled_boundary",
  "credit_count_decreased_before_expiry",
  "confirmed_unscheduled_quota_drop",
  "reset_credit_id_added",
  "reset_credit_expiry_elapsed",
  "overlapping_scheduled_and_credit_evidence",
]);

export const QUOTA_RESET_CLASSIFICATION_POLICY = Object.freeze({
  materialDropPercentagePoints: 5,
  resetScheduleJitterMs: 3 * 60 * 60 * 1_000,
  maximumObservations: 100_000,
  maximumCredits: 1_024,
  maximumWindowsPerObservation: 256,
  maximumEventsPerObservation: 2_304,
  maximumCreditContinuityGapMs: 36 * 60 * 60 * 1_000,
});

const EVENT_KINDS = new Set(QUOTA_RESET_EVENT_KINDS);
const EVENT_PRECISIONS = new Set(QUOTA_RESET_EVENT_PRECISIONS);
const EVENT_REASONS = new Set(QUOTA_RESET_EVENT_REASONS);
const EVENT_CONTRACTS = Object.freeze({
  scheduled_reset: Object.freeze({ scheduled_boundary: "provider_schedule" }),
  banked_reset_used: Object.freeze({
    credit_count_decreased_before_expiry: "observation_interval",
  }),
  unknown_reset: Object.freeze({
    confirmed_unscheduled_quota_drop: "observation_interval",
    overlapping_scheduled_and_credit_evidence: "provider_schedule",
  }),
  reset_credit_granted: Object.freeze({
    reset_credit_id_added: "provider_timestamp",
  }),
  reset_credit_expired: Object.freeze({
    reset_credit_expiry_elapsed: "provider_timestamp",
  }),
});
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_CREDIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const DETAIL_STATUSES = new Set(["complete", "partial", "unavailable"]);
const EVENT_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "occurredAt",
  "observedAt",
  "intervalStartedAt",
  "precision",
  "reason",
  "provider",
  "planType",
  "limitId",
  "windowDurationMins",
]);

function canonicalInstant(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
      && new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

function safeToken(value) {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : null;
}

function epochSecondsInstant(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  const milliseconds = value * 1_000;
  if (!Number.isSafeInteger(milliseconds)) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

function normalizeWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const provider = safeToken(value.provider);
  const planType = safeToken(value.planType);
  const limitId = safeToken(value.limitId);
  const duration = value.windowDurationMins ?? value.durationMinutes;
  const resetsAt = Number.isSafeInteger(value.resetsAt)
    ? epochSecondsInstant(value.resetsAt)
    : canonicalInstant(value.resetAt ?? value.resetsAt);
  if (provider === null || planType === null || limitId === null
      || !isValidQuotaWindowDuration(duration)
      || !Number.isFinite(value.usedPercent)
      || value.usedPercent < 0 || value.usedPercent > 100
      || resetsAt === null) return null;
  return {
    provider,
    planType,
    limitId,
    windowDurationMins: duration,
    usedPercent: value.usedPercent,
    resetsAt,
  };
}

function windowKey(window) {
  return JSON.stringify([
    window.provider,
    window.planType,
    window.limitId,
    window.windowDurationMins,
  ]);
}

function normalizeObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const observedAt = canonicalInstant(value.observedAt);
  const accountScopeId = typeof value.accountScopeId === "string"
      && SAFE_SCOPE.test(value.accountScopeId)
    ? value.accountScopeId
    : null;
  if (observedAt === null || accountScopeId === null
      || !Array.isArray(value.windows)
      || value.windows.length
        > QUOTA_RESET_CLASSIFICATION_POLICY.maximumWindowsPerObservation) return null;
  const windows = value.windows.map(normalizeWindow);
  if (windows.includes(null)) return null;
  const byKey = new Map();
  for (const window of windows) {
    const key = windowKey(window);
    if (byKey.has(key)) return null;
    byKey.set(key, window);
  }
  return { observedAt, observedAtMs: Date.parse(observedAt), accountScopeId, windows };
}

function event({
  kind,
  occurredAt,
  observedAt,
  intervalStartedAt,
  precision,
  reason,
  window = null,
  provider = null,
}) {
  return Object.freeze({
    schemaVersion: QUOTA_RESET_EVENT_SCHEMA_VERSION,
    kind,
    occurredAt,
    observedAt,
    intervalStartedAt,
    precision,
    reason,
    provider: window?.provider ?? provider ?? "openai_codex",
    planType: window?.planType ?? null,
    limitId: window?.limitId ?? null,
    windowDurationMins: window?.windowDurationMins ?? null,
  });
}

export function normalizeQuotaResetEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== EVENT_KEYS.length
      || EVENT_KEYS.some((key) => !Object.hasOwn(value, key))
      || value.schemaVersion !== QUOTA_RESET_EVENT_SCHEMA_VERSION
      || !EVENT_KINDS.has(value.kind)
      || !EVENT_PRECISIONS.has(value.precision)
      || !EVENT_REASONS.has(value.reason)
      || EVENT_CONTRACTS[value.kind]?.[value.reason] !== value.precision) return null;
  const occurredAt = canonicalInstant(value.occurredAt);
  const observedAt = canonicalInstant(value.observedAt);
  const intervalStartedAt = canonicalInstant(value.intervalStartedAt);
  const provider = safeToken(value.provider);
  const planType = value.planType === null ? null : safeToken(value.planType);
  const limitId = value.limitId === null ? null : safeToken(value.limitId);
  const duration = value.windowDurationMins;
  const lifecycle = value.kind === "reset_credit_granted"
    || value.kind === "reset_credit_expired";
  if (occurredAt === null || observedAt === null || intervalStartedAt === null
      || provider === null || Date.parse(intervalStartedAt) >= Date.parse(observedAt)
      || Date.parse(occurredAt) < Date.parse(intervalStartedAt)
      || Date.parse(occurredAt) > Date.parse(observedAt)
      || (lifecycle
        ? planType !== null || limitId !== null || duration !== null
        : planType === null || limitId === null
          || !isValidQuotaWindowDuration(duration))) return null;
  return event({
    kind: value.kind,
    occurredAt,
    observedAt,
    intervalStartedAt,
    precision: value.precision,
    reason: value.reason,
    provider,
    window: lifecycle ? null : {
      provider,
      planType,
      limitId,
      windowDurationMins: duration,
    },
  });
}

function orderedObservations(values) {
  if (!Array.isArray(values)
      || values.length > QUOTA_RESET_CLASSIFICATION_POLICY.maximumObservations) {
    return [];
  }
  const normalized = values.map(normalizeObservation);
  if (normalized.includes(null)) return [];
  normalized.sort((left, right) => left.observedAtMs - right.observedAtMs);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].observedAtMs >= normalized[index].observedAtMs) {
      return [];
    }
  }
  return normalized;
}

/**
 * Reconstruct reset boundaries from provider quota schedules and displayed
 * percentage tracks. This deliberately has no access to reset-credit state;
 * banked classifications are overlaid from prospective derived events.
 */
export function classifyQuotaResetTimeline(values) {
  const observations = orderedObservations(values);
  if (observations.length === 0) return [];
  const tracks = new Map();
  const events = [];
  let activeAccount = observations[0].accountScopeId;

  for (const observation of observations) {
    if (observation.accountScopeId !== activeAccount) {
      tracks.clear();
      activeAccount = observation.accountScopeId;
    }
    const present = new Set();
    for (const window of observation.windows) {
      const key = windowKey(window);
      present.add(key);
      const currentResetMs = Date.parse(window.resetsAt);
      const track = tracks.get(key);
      if (track === undefined) {
        tracks.set(key, {
          ...window,
          observedAt: observation.observedAt,
          observedAtMs: observation.observedAtMs,
          maximumUsedPercent: window.usedPercent,
          pendingDrop: null,
        });
        continue;
      }

      const previousResetMs = Date.parse(track.resetsAt);
      const scheduleAdvanced = currentResetMs
        > previousResetMs + QUOTA_RESET_CLASSIFICATION_POLICY.resetScheduleJitterMs;
      const scheduledBoundary = previousResetMs > track.observedAtMs
        && previousResetMs <= observation.observedAtMs
        && scheduleAdvanced;
      if (scheduledBoundary) {
        events.push(event({
          kind: "scheduled_reset",
          occurredAt: track.resetsAt,
          observedAt: observation.observedAt,
          intervalStartedAt: track.observedAt,
          precision: "provider_schedule",
          reason: "scheduled_boundary",
          window,
        }));
        tracks.set(key, {
          ...window,
          observedAt: observation.observedAt,
          observedAtMs: observation.observedAtMs,
          maximumUsedPercent: window.usedPercent,
          pendingDrop: null,
        });
        continue;
      }

      const dropped = window.usedPercent
        < track.maximumUsedPercent
          - QUOTA_RESET_CLASSIFICATION_POLICY.materialDropPercentagePoints;
      const resetScheduleChangedEarly = scheduleAdvanced
        && observation.observedAtMs < previousResetMs;
      if (dropped && resetScheduleChangedEarly) {
        events.push(event({
          kind: "unknown_reset",
          occurredAt: observation.observedAt,
          observedAt: observation.observedAt,
          intervalStartedAt: track.observedAt,
          precision: "observation_interval",
          reason: "confirmed_unscheduled_quota_drop",
          window,
        }));
        tracks.set(key, {
          ...window,
          observedAt: observation.observedAt,
          observedAtMs: observation.observedAtMs,
          maximumUsedPercent: window.usedPercent,
          pendingDrop: null,
        });
        continue;
      }

      if (dropped) {
        const confirmed = track.pendingDrop !== null
          && window.usedPercent <= track.pendingDrop.usedPercent
            + QUOTA_RESET_CLASSIFICATION_POLICY.materialDropPercentagePoints;
        if (confirmed) {
          events.push(event({
            kind: "unknown_reset",
            occurredAt: track.pendingDrop.observedAt,
            observedAt: observation.observedAt,
            intervalStartedAt: track.pendingDrop.intervalStartedAt,
            precision: "observation_interval",
            reason: "confirmed_unscheduled_quota_drop",
            window,
          }));
          tracks.set(key, {
            ...window,
            observedAt: observation.observedAt,
            observedAtMs: observation.observedAtMs,
            maximumUsedPercent: window.usedPercent,
            pendingDrop: null,
          });
        } else {
          track.pendingDrop = {
            observedAt: observation.observedAt,
            intervalStartedAt: track.observedAt,
            usedPercent: window.usedPercent,
          };
          track.observedAt = observation.observedAt;
          track.observedAtMs = observation.observedAtMs;
        }
        continue;
      }

      track.pendingDrop = null;
      track.maximumUsedPercent = Math.max(
        track.maximumUsedPercent,
        window.usedPercent,
      );
      track.observedAt = observation.observedAt;
      track.observedAtMs = observation.observedAtMs;
      track.resetsAt = window.resetsAt;
    }
    for (const key of tracks.keys()) {
      if (!present.has(key)) tracks.delete(key);
    }
  }
  return events;
}

function normalizeCredit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.id !== "string" || !SAFE_CREDIT_ID.test(value.id)) {
    return null;
  }
  const grantedAt = value.grantedAt === null
    ? null
    : canonicalInstant(value.grantedAt);
  const expiresAt = value.expiresAt === null
    ? null
    : canonicalInstant(value.expiresAt);
  if ((value.grantedAt !== null && grantedAt === null)
      || (value.expiresAt !== null && expiresAt === null)) return null;
  return { id: value.id, grantedAt, expiresAt };
}

function normalizeInventory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Number.isSafeInteger(value.availableCount)
      || value.availableCount < 0
      || !DETAIL_STATUSES.has(value.detailsStatus)
      || !Array.isArray(value.credits)
      || value.credits.length > QUOTA_RESET_CLASSIFICATION_POLICY.maximumCredits) {
    return null;
  }
  const credits = value.credits.map(normalizeCredit);
  if (credits.includes(null)) return null;
  const ids = new Set(credits.map((credit) => credit.id));
  if (ids.size !== credits.length
      || (value.detailsStatus === "complete"
        && credits.length !== value.availableCount)) return null;
  return {
    availableCount: value.availableCount,
    detailsStatus: value.detailsStatus,
    credits,
  };
}

function continuityObservation(value) {
  const normalized = normalizeObservation(value);
  if (normalized === null) return null;
  return {
    observedAt: normalized.observedAt,
    accountScopeId: normalized.accountScopeId,
    windows: normalized.windows.map((window) => ({
      provider: window.provider,
      planType: window.planType,
      limitId: window.limitId,
      usedPercent: window.usedPercent,
      resetAt: window.resetsAt,
      durationMinutes: window.windowDurationMins,
    })),
  };
}

function continuityCreditObservation(value) {
  const observation = continuityObservation(value);
  const resetCredits = normalizeInventory(value?.resetCredits);
  if (observation === null || resetCredits === null) return null;
  return {
    ...observation,
    resetCredits: {
      availableCount: resetCredits.availableCount,
      detailsStatus: resetCredits.detailsStatus,
      credits: resetCredits.credits.map((credit) => ({ ...credit })),
    },
  };
}

/**
 * Validate and copy the bounded JSON-safe state used to bridge ordinary
 * companion restarts. Credit identifiers are opaque to this package; the
 * Codex provider supplies keyed fingerprints rather than provider IDs.
 */
export function normalizeResetEventContinuity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 3
      || value.schemaVersion !== RESET_EVENT_CONTINUITY_SCHEMA_VERSION
      || !Array.isArray(value.timeline)
      || value.timeline.length > 3) return null;
  const timeline = value.timeline.map(continuityObservation);
  if (timeline.includes(null)) return null;
  for (let index = 1; index < timeline.length; index += 1) {
    if (timeline[index - 1].accountScopeId !== timeline[index].accountScopeId
        || Date.parse(timeline[index - 1].observedAt)
          >= Date.parse(timeline[index].observedAt)) return null;
  }
  const creditBaseline = value.creditBaseline === null
    ? null
    : continuityCreditObservation(value.creditBaseline);
  if (value.creditBaseline !== null && creditBaseline === null) return null;
  const latest = timeline.at(-1) ?? null;
  if (creditBaseline !== null
      && (latest === null
        || latest.accountScopeId !== creditBaseline.accountScopeId
        || latest.observedAt !== creditBaseline.observedAt)) return null;
  return {
    schemaVersion: RESET_EVENT_CONTINUITY_SCHEMA_VERSION,
    timeline,
    creditBaseline,
  };
}

function intervalQuotaResetWindows(previous, current) {
  const priorByKey = new Map(previous.windows.map((window) => [
    windowKey(window),
    window,
  ]));
  const reset = [];
  for (const window of current.windows) {
    const prior = priorByKey.get(windowKey(window));
    if (prior === undefined) continue;
    const priorResetMs = Date.parse(prior.resetsAt);
    const currentResetMs = Date.parse(window.resetsAt);
    const scheduleAdvanced = currentResetMs
      > priorResetMs + QUOTA_RESET_CLASSIFICATION_POLICY.resetScheduleJitterMs;
    const due = priorResetMs > previous.observedAtMs
      && priorResetMs <= current.observedAtMs;
    const materialDrop = window.usedPercent
      < prior.usedPercent
        - QUOTA_RESET_CLASSIFICATION_POLICY.materialDropPercentagePoints;
    if (materialDrop && (!due || !scheduleAdvanced)) {
      reset.push(window);
    }
  }
  return reset;
}

function conflictingScheduledWindows(previous, current) {
  const priorByKey = new Map(previous.windows.map((window) => [
    windowKey(window),
    window,
  ]));
  const conflicts = [];
  for (const window of current.windows) {
    const prior = priorByKey.get(windowKey(window));
    if (prior === undefined) continue;
    const priorResetMs = Date.parse(prior.resetsAt);
    const currentResetMs = Date.parse(window.resetsAt);
    const scheduleAdvanced = currentResetMs
      > priorResetMs + QUOTA_RESET_CLASSIFICATION_POLICY.resetScheduleJitterMs;
    const due = priorResetMs > previous.observedAtMs
      && priorResetMs <= current.observedAtMs;
    const materialDrop = window.usedPercent
      < prior.usedPercent
        - QUOTA_RESET_CLASSIFICATION_POLICY.materialDropPercentagePoints;
    if (materialDrop && due && scheduleAdvanced) {
      conflicts.push({ window, scheduledAt: prior.resetsAt });
    }
  }
  return conflicts;
}

/**
 * Keep only a short prospective comparison window and credit inventory while
 * returning privacy-safe reset and lifecycle events for durable storage. The
 * bounded snapshot/restore contract lets the owner-controlled collector state
 * bridge an ordinary restart without retaining provider credit identifiers.
 */
export function createResetEventClassifier() {
  let previousCreditObservation = null;
  let timelineHistory = [];
  return Object.freeze({
    reset() {
      previousCreditObservation = null;
      timelineHistory = [];
    },
    snapshot() {
      return normalizeResetEventContinuity({
        schemaVersion: RESET_EVENT_CONTINUITY_SCHEMA_VERSION,
        timeline: timelineHistory.map(continuityObservation),
        creditBaseline: previousCreditObservation === null
          ? null
          : continuityCreditObservation({
              ...previousCreditObservation,
              resetCredits: previousCreditObservation.resetCredits,
            }),
      });
    },
    restore(value) {
      const continuity = normalizeResetEventContinuity(value);
      previousCreditObservation = null;
      timelineHistory = [];
      if (continuity === null) return false;
      timelineHistory = continuity.timeline.map(normalizeObservation);
      if (continuity.creditBaseline !== null) {
        const observation = normalizeObservation(continuity.creditBaseline);
        previousCreditObservation = {
          ...observation,
          resetCredits: normalizeInventory(continuity.creditBaseline.resetCredits),
        };
      }
      return true;
    },
    observe(value) {
      const observation = normalizeObservation(value);
      if (observation === null) {
        previousCreditObservation = null;
        timelineHistory = [];
        return [];
      }
      const lastTimelineObservation = timelineHistory.at(-1) ?? null;
      if (lastTimelineObservation !== null
          && (lastTimelineObservation.accountScopeId !== observation.accountScopeId
            || lastTimelineObservation.observedAtMs >= observation.observedAtMs)) {
        timelineHistory = [];
      }
      timelineHistory.push(observation);
      timelineHistory = timelineHistory.slice(-3);
      const timelineEvents = classifyQuotaResetTimeline(timelineHistory)
        .filter((value) => value.observedAt === observation.observedAt);

      const resetCredits = normalizeInventory(value?.resetCredits);
      if (resetCredits === null) {
        previousCreditObservation = null;
        return timelineEvents;
      }
      const current = { ...observation, resetCredits };
      if (previousCreditObservation === null
          || previousCreditObservation.accountScopeId !== current.accountScopeId
          || previousCreditObservation.observedAtMs >= current.observedAtMs) {
        previousCreditObservation = current;
        return timelineEvents;
      }

      const events = [];
      const previous = previousCreditObservation;
      const creditContinuityFresh = current.observedAtMs - previous.observedAtMs
        <= QUOTA_RESET_CLASSIFICATION_POLICY.maximumCreditContinuityGapMs;
      const priorCredits = previous.resetCredits;
      const previousById = new Map(
        priorCredits.credits.map((credit) => [credit.id, credit]),
      );
      const currentById = new Map(
        current.resetCredits.credits.map((credit) => [credit.id, credit]),
      );

      if (priorCredits.detailsStatus === "complete"
          && current.resetCredits.detailsStatus === "complete") {
        for (const credit of current.resetCredits.credits) {
          if (previousById.has(credit.id) || credit.grantedAt === null) continue;
          const grantedAtMs = Date.parse(credit.grantedAt);
          if (grantedAtMs <= previous.observedAtMs
              || grantedAtMs > current.observedAtMs) continue;
          events.push(event({
            kind: "reset_credit_granted",
            occurredAt: credit.grantedAt,
            observedAt: current.observedAt,
            intervalStartedAt: previous.observedAt,
            precision: "provider_timestamp",
            reason: "reset_credit_id_added",
          }));
        }
      }

      const removedCredits = priorCredits.detailsStatus === "complete"
        ? priorCredits.credits.filter((credit) => (
          current.resetCredits.detailsStatus === "complete"
            ? !currentById.has(credit.id)
            : current.resetCredits.availableCount
              < priorCredits.availableCount
        ))
        : [];
      const expired = removedCredits.filter((credit) => {
        if (credit.expiresAt === null) return false;
        const expiresAtMs = Date.parse(credit.expiresAt);
        return expiresAtMs > previous.observedAtMs
          && expiresAtMs <= current.observedAtMs;
      });
      if (current.resetCredits.detailsStatus === "complete") {
        for (const credit of expired) {
          events.push(event({
            kind: "reset_credit_expired",
            occurredAt: credit.expiresAt,
            observedAt: current.observedAt,
            intervalStartedAt: previous.observedAt,
            precision: "provider_timestamp",
            reason: "reset_credit_expiry_elapsed",
          }));
        }
      } else {
        const countDrop = priorCredits.availableCount
          - current.resetCredits.availableCount;
        if (countDrop > 0 && expired.length === countDrop) {
          for (const credit of expired) {
            events.push(event({
              kind: "reset_credit_expired",
              occurredAt: credit.expiresAt,
              observedAt: current.observedAt,
              intervalStartedAt: previous.observedAt,
              precision: "provider_timestamp",
              reason: "reset_credit_expiry_elapsed",
            }));
          }
        }
      }

      const countDrop = priorCredits.availableCount
        - current.resetCredits.availableCount;
      const unexpiredRemoved = removedCredits.filter((credit) => (
        credit.expiresAt === null
          || Date.parse(credit.expiresAt) > current.observedAtMs
      ));
      const provesUnexpiredRemoval = creditContinuityFresh
        && countDrop > 0
        && priorCredits.detailsStatus === "complete"
        && (current.resetCredits.detailsStatus === "complete"
          ? unexpiredRemoved.length > 0
          : expired.length < countDrop);
      if (provesUnexpiredRemoval) {
        for (const window of intervalQuotaResetWindows(previous, current)) {
          events.push(event({
            kind: "banked_reset_used",
            occurredAt: current.observedAt,
            observedAt: current.observedAt,
            intervalStartedAt: previous.observedAt,
            precision: "observation_interval",
            reason: "credit_count_decreased_before_expiry",
            window,
          }));
        }
        for (const conflict of conflictingScheduledWindows(previous, current)) {
          events.push(event({
            kind: "unknown_reset",
            occurredAt: conflict.scheduledAt,
            observedAt: current.observedAt,
            intervalStartedAt: previous.observedAt,
            precision: "provider_schedule",
            reason: "overlapping_scheduled_and_credit_evidence",
            window: conflict.window,
          }));
        }
      }

      previousCreditObservation = current;
      const merged = mergeQuotaResetEvents(timelineEvents, events);
      return merged.length
          <= QUOTA_RESET_CLASSIFICATION_POLICY.maximumEventsPerObservation
        ? merged
        : [];
    },
  });
}

function eventIdentity(value, { ignoreKind = false } = {}) {
  return JSON.stringify([
    ignoreKind ? null : value.kind,
    value.occurredAt,
    value.provider,
    value.planType,
    value.limitId,
    value.windowDurationMins,
  ]);
}

/** Merge reconstructed and prospective events, preferring banked evidence. */
export function mergeQuotaResetEvents(reconstructed, prospective) {
  const safeReconstructed = Array.isArray(reconstructed)
    ? reconstructed.map(normalizeQuotaResetEvent).filter(Boolean)
    : [];
  const safeProspective = Array.isArray(prospective)
    ? prospective.map(normalizeQuotaResetEvent).filter(Boolean)
    : [];
  const bankedTracks = new Set(safeProspective
    .filter((value) => value.kind === "banked_reset_used")
    .map((value) => eventIdentity(value, { ignoreKind: true })));
  const conflictingTracks = new Set(safeProspective
    .filter((value) => (
      value.kind === "unknown_reset"
      && value.reason === "overlapping_scheduled_and_credit_evidence"
    ))
    .map((value) => eventIdentity(value, { ignoreKind: true })));
  const byIdentity = new Map();
  for (const value of [...safeReconstructed, ...safeProspective]) {
    if (value.kind === "unknown_reset"
        && bankedTracks.has(eventIdentity(value, { ignoreKind: true }))) continue;
    if (value.kind === "scheduled_reset"
        && conflictingTracks.has(eventIdentity(value, { ignoreKind: true }))) continue;
    byIdentity.set(eventIdentity(value), value);
  }
  return [...byIdentity.values()].sort((left, right) => (
    left.occurredAt.localeCompare(right.occurredAt)
    || left.kind.localeCompare(right.kind)
    || (left.windowDurationMins ?? 0) - (right.windowDurationMins ?? 0)
  ));
}
