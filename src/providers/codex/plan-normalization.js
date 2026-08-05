import { TELEMETRY_PLAN_TYPES } from "@app-usagemonitor/telemetry-contract";

const PLAN_TYPE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const KNOWN_PLAN_TYPES = new Set(TELEMETRY_PLAN_TYPES);

/**
 * Keep a provider label bounded and identifier-safe without treating it as a
 * plan entitlement. This path intentionally permits a provider label that is
 * not yet in the telemetry vocabulary so account-scope sanitation remains
 * forward-compatible; evidence normalization can still map it to unknown.
 */
export function sanitizeProviderPlanLabel(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return PLAN_TYPE_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Normalize provider plan_type evidence to the bounded vocabulary used by
 * telemetry and analysis. Exact plan variants, including Pro multipliers,
 * are deliberately not part of this mapping.
 */
export function normalizeProviderPlanType(value) {
  const label = sanitizeProviderPlanLabel(value);
  return label !== null && KNOWN_PLAN_TYPES.has(label) ? label : "unknown";
}
