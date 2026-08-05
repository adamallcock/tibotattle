const MAX_QUOTA_WINDOW_DURATION_MINUTES = 525_600;

export function isValidProviderQuotaWindowDuration(value) {
  return Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_QUOTA_WINDOW_DURATION_MINUTES;
}

function canBecomeIsoInstant(epochSeconds) {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds <= 0) return false;
  try {
    new Date(epochSeconds * 1_000).toISOString();
    return true;
  } catch {
    return false;
  }
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalize one provider rate-limit window while retaining the provider's
 * numeric duration. Invalid values are omitted rather than relabeled as a
 * five-hour or weekly window.
 */
export function normalizeProviderQuotaWindow(window) {
  if (!window || typeof window !== "object" || Array.isArray(window)) return null;
  const usedPercent = finiteNumber(window.usedPercent ?? window.used_percent);
  const windowDurationMins = finiteNumber(
    window.windowDurationMins
      ?? window.windowDurationMinutes
      ?? window.window_minutes,
  );
  const resetsAt = finiteNumber(window.resetsAt ?? window.resets_at);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100) return null;
  if (!isValidProviderQuotaWindowDuration(windowDurationMins)) return null;
  if (!canBecomeIsoInstant(resetsAt)) return null;
  return { usedPercent, windowDurationMins, resetsAt };
}
