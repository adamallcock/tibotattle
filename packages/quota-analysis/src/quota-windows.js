export const FIVE_HOUR_WINDOW_MINUTES = 300;
export const SEVEN_DAY_WINDOW_MINUTES = 10_080;
export const MAX_QUOTA_WINDOW_DURATION_MINUTES = 525_600;

// Keep the named-window list for compatibility; provider-reported windows use
// the bounded validators below.
export const SUPPORTED_QUOTA_WINDOW_DURATIONS = Object.freeze([
  FIVE_HOUR_WINDOW_MINUTES,
  SEVEN_DAY_WINDOW_MINUTES,
]);

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

function windowDurationMinutes(window) {
  if (!window || typeof window !== "object" || Array.isArray(window)) return null;
  for (const key of ["windowDurationMinutes", "durationMinutes", "windowDurationMins"]) {
    if (Object.hasOwn(window, key)) {
      const value = window[key];
      return isValidQuotaWindowDuration(value) ? value : null;
    }
  }
  return null;
}

function quotaWindowSlotRank(slot) {
  if (slot === "primary") return 0;
  if (slot === "secondary") return 1;
  return 2;
}

export function isValidQuotaWindowDuration(value) {
  return Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_QUOTA_WINDOW_DURATION_MINUTES;
}

export function isSupportedQuotaWindowDuration(value) {
  return isValidQuotaWindowDuration(value);
}

/**
 * Select the provider window used as the normal Codex allowance headline.
 * The provider's limit id, not its slot name, defines the normal Codex pool.
 * Longer valid windows win; equal durations prefer the provider's primary
 * slot, with input order retained for any remaining tie.
 */
export function selectPrimaryQuotaWindow(windows) {
  let selected = null;
  let selectedDuration = null;
  for (const candidate of Array.isArray(windows) ? windows : []) {
    if (candidate?.limitId !== "codex") continue;
    const duration = windowDurationMinutes(candidate);
    if (duration === null) continue;
    if (selected === null
        || duration > selectedDuration
        || (duration === selectedDuration
          && quotaWindowSlotRank(candidate.slot) < quotaWindowSlotRank(selected.slot))) {
      selected = candidate;
      selectedDuration = duration;
    }
  }
  return selected;
}

/**
 * Return a fixed, provider-neutral duration phrase. A duration never implies
 * a calendar month or billing cycle, so 43,200 minutes is explicitly a
 * provider-reported 30-day-like duration when rendered by quotaWindowLabel.
 */
export function formatQuotaWindowDuration(value) {
  if (!isValidQuotaWindowDuration(value)) return null;
  if (value % MINUTES_PER_DAY === 0) return `${value / MINUTES_PER_DAY}-day`;
  if (value % MINUTES_PER_HOUR === 0) return `${value / MINUTES_PER_HOUR}-hour`;
  return `${value}-minute`;
}

export function quotaWindowLabel(limitId, durationMinutes) {
  if (limitId !== "codex") return "Other observed allowance";
  if (durationMinutes === FIVE_HOUR_WINDOW_MINUTES) return "Five-hour allowance";
  if (durationMinutes === SEVEN_DAY_WINDOW_MINUTES) return "Seven-day allowance";
  const duration = formatQuotaWindowDuration(durationMinutes);
  return duration === null
    ? "Unknown quota window"
    : `Provider-reported ${duration} window`;
}
