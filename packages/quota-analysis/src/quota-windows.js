export const FIVE_HOUR_WINDOW_MINUTES = 300;
export const SEVEN_DAY_WINDOW_MINUTES = 10_080;
export const MAX_QUOTA_WINDOW_DURATION_MINUTES = 525_600;
export const MAX_QUOTA_LIMIT_DISPLAY_NAME_LENGTH = 80;

export const CODEX_PRIMARY_LIMIT_ID = "codex";
export const CODEX_SPARK_LIMIT_ID = "codex_bengalfox";
export const CODEX_SPARK_RESERVED_LIMIT_ID = "codex-spark";
export const CODEX_SPARK_LIMIT_IDS = Object.freeze([
  CODEX_SPARK_LIMIT_ID,
  CODEX_SPARK_RESERVED_LIMIT_ID,
]);

// Audited product aliases are deliberately separate from provider-supplied
// display metadata. Only an exact technical id can select one of these names;
// a future provider label can improve local presentation but can never promote
// an unknown pool into the normal Codex or Spark accounting tracks.
export const QUOTA_LIMIT_DISPLAY_ALIASES = Object.freeze({
  [CODEX_PRIMARY_LIMIT_ID]: "Codex",
  [CODEX_SPARK_LIMIT_ID]: "Spark",
  [CODEX_SPARK_RESERVED_LIMIT_ID]: "Spark",
});

// Keep the named-window list for compatibility; provider-reported windows use
// the bounded validators below.
export const SUPPORTED_QUOTA_WINDOW_DURATIONS = Object.freeze([
  FIVE_HOUR_WINDOW_MINUTES,
  SEVEN_DAY_WINDOW_MINUTES,
]);

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const SAFE_QUOTA_LIMIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const SAFE_QUOTA_LIMIT_DISPLAY_NAME =
  /^[\p{L}\p{N}][\p{L}\p{N}\p{M}\p{Pd} ._()+:]{0,79}$/u;

export function sanitizeQuotaLimitId(value) {
  return typeof value === "string" && SAFE_QUOTA_LIMIT_ID.test(value)
    ? value
    : "unknown";
}

/**
 * Keep a provider name only when it is short, single-line product copy. This
 * rejects paths, URLs, email/account identifiers, markup, and control text.
 * The result is local display metadata only and must never define identity.
 */
export function sanitizeQuotaLimitDisplayName(value) {
  if (typeof value !== "string") return null;
  let normalized;
  try {
    normalized = value.normalize("NFKC").trim();
  } catch {
    return null;
  }
  if (normalized.length === 0
      || Array.from(normalized).length > MAX_QUOTA_LIMIT_DISPLAY_NAME_LENGTH
      || !SAFE_QUOTA_LIMIT_DISPLAY_NAME.test(normalized)) {
    return null;
  }
  return normalized;
}

export function quotaLimitDisplayAlias(limitId) {
  const normalized = sanitizeQuotaLimitId(limitId);
  return Object.hasOwn(QUOTA_LIMIT_DISPLAY_ALIASES, normalized)
    ? QUOTA_LIMIT_DISPLAY_ALIASES[normalized]
    : null;
}

export function isSparkQuotaLimitId(value) {
  return CODEX_SPARK_LIMIT_IDS.includes(value);
}

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
    if (candidate?.limitId !== CODEX_PRIMARY_LIMIT_ID) continue;
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

export const QUOTA_WINDOW_KINDS = Object.freeze([
  "codex_five_hour",
  "codex_seven_day",
  "codex_provider_reported",
  "spark_five_hour",
  "spark_seven_day",
  "spark_other",
  "other",
]);

export function classifyQuotaWindowKind(limitId, durationMinutes) {
  if (!isValidQuotaWindowDuration(durationMinutes)) return "other";
  if (limitId === CODEX_PRIMARY_LIMIT_ID) {
    if (durationMinutes === FIVE_HOUR_WINDOW_MINUTES) return "codex_five_hour";
    if (durationMinutes === SEVEN_DAY_WINDOW_MINUTES) return "codex_seven_day";
    return "codex_provider_reported";
  }
  if (isSparkQuotaLimitId(limitId)) {
    if (durationMinutes === FIVE_HOUR_WINDOW_MINUTES) return "spark_five_hour";
    if (durationMinutes === SEVEN_DAY_WINDOW_MINUTES) return "spark_seven_day";
    return "spark_other";
  }
  return "other";
}

export function quotaWindowLabel(limitId, durationMinutes, limitName = null) {
  switch (classifyQuotaWindowKind(limitId, durationMinutes)) {
    case "codex_five_hour":
      return "Five-hour allowance";
    case "codex_seven_day":
      return "Seven-day allowance";
    case "codex_provider_reported":
      return `Provider-reported ${formatQuotaWindowDuration(durationMinutes)} window`;
    case "spark_five_hour":
      return "Spark five-hour allowance";
    case "spark_seven_day":
      return "Spark seven-day allowance";
    case "spark_other":
      return "Spark allowance";
    default:
      break;
  }
  if (limitId === CODEX_PRIMARY_LIMIT_ID) return "Unknown quota window";
  const duration = formatQuotaWindowDuration(durationMinutes);
  const providerName = sanitizeQuotaLimitDisplayName(limitName);
  if (duration === null) {
    return providerName === null
      ? "Other observed allowance"
      : `${providerName} allowance`;
  }
  return providerName === null
    ? `Other observed ${duration} allowance`
    : `${providerName} · ${duration} allowance`;
}
