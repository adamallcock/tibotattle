export const FIVE_HOUR_WINDOW_MINUTES = 300;
export const SEVEN_DAY_WINDOW_MINUTES = 10_080;
export const MAX_QUOTA_WINDOW_DURATION_MINUTES = 525_600;

// Keep the named-window list for compatibility; provider-reported windows use
// the bounded validators below.
export const SUPPORTED_QUOTA_WINDOW_DURATIONS = Object.freeze([
  FIVE_HOUR_WINDOW_MINUTES,
  SEVEN_DAY_WINDOW_MINUTES,
]);

export function isValidQuotaWindowDuration(value) {
  return Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_QUOTA_WINDOW_DURATION_MINUTES;
}

export function isSupportedQuotaWindowDuration(value) {
  return isValidQuotaWindowDuration(value);
}
