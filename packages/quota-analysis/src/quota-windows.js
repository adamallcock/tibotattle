export const FIVE_HOUR_WINDOW_MINUTES = 300;
export const SEVEN_DAY_WINDOW_MINUTES = 10_080;

export const SUPPORTED_QUOTA_WINDOW_DURATIONS = Object.freeze([
  FIVE_HOUR_WINDOW_MINUTES,
  SEVEN_DAY_WINDOW_MINUTES,
]);

const SUPPORTED_DURATION_SET = new Set(SUPPORTED_QUOTA_WINDOW_DURATIONS);

export function isSupportedQuotaWindowDuration(value) {
  return SUPPORTED_DURATION_SET.has(value);
}
