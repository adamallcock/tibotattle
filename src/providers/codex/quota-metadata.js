// This provider-local validator intentionally mirrors the canonical display
// metadata rules in @app-usagemonitor/quota-analysis. The Codex provider is an
// isolated source boundary and must not import application analysis packages;
// parity is enforced in the provider tests.
const MAX_QUOTA_LIMIT_DISPLAY_NAME_LENGTH = 80;
const SAFE_QUOTA_LIMIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const SAFE_QUOTA_LIMIT_DISPLAY_NAME =
  /^[\p{L}\p{N}][\p{L}\p{N}\p{M}\p{Pd} ._()+:]{0,79}$/u;

export function sanitizeProviderQuotaLimitId(value) {
  return typeof value === "string" && SAFE_QUOTA_LIMIT_ID.test(value)
    ? value
    : "unknown";
}

export function sanitizeProviderQuotaLimitDisplayName(value) {
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
