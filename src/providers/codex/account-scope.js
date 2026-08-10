import { createHmac } from "node:crypto";
import { sanitizeProviderPlanLabel } from "./plan-normalization.js";

/**
 * A versioned, privacy-preserving account partition.  It is deliberately not
 * an account identifier: the source subject is used only long enough to
 * calculate the keyed digest and is never returned from this module.
 */
export const OPENAI_ACCOUNT_SCOPE_VERSION = "openai-account-v1";
export const OPENAI_ACCOUNT_SCOPE_PREFIX = "openai-account:v1:";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const SCOPE_ID_PATTERN = /^openai-account:v1:[A-Za-z0-9_-]{43}$/u;
const HMAC_DOMAIN = "app-usagemonitor/openai-account-scope/v1\u0000";

function unavailable(reason, planType = null) {
  return {
    status: "unavailable",
    reason,
    version: OPENAI_ACCOUNT_SCOPE_VERSION,
    scopeId: null,
    planType,
  };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function firstEmailCandidate(accountRead) {
  if (!accountRead || typeof accountRead !== "object" || Array.isArray(accountRead)) return { state: "missing_account" };

  const containers = [
    accountRead,
    accountRead.account,
    accountRead.user,
    accountRead.result,
    accountRead.result?.account,
    accountRead.result?.user,
  ];
  let foundAccountObject = false;

  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    foundAccountObject = true;
    if (hasOwn(container, "email")) return { state: "candidate", value: container.email };
  }

  return { state: foundAccountObject ? "malformed_subject" : "missing_account" };
}

function normalizedEmail(accountRead) {
  const candidate = firstEmailCandidate(accountRead);
  if (candidate.state !== "candidate") return candidate;
  if (typeof candidate.value !== "string") return { state: "malformed_subject" };

  const value = candidate.value.trim().toLowerCase();
  if (!value || value.length > 320 || !EMAIL_PATTERN.test(value)) return { state: "malformed_subject" };
  return { state: "available", value };
}

function usableSecret(secret) {
  if (typeof secret === "string") return secret.trim().length > 0 ? secret : null;
  if (Buffer.isBuffer(secret) || secret instanceof Uint8Array) return secret.byteLength > 0 ? secret : null;
  return null;
}

/**
 * Restrict plan labels to a small, identifier-safe value before it is put in a
 * local observation. Invalid values are omitted rather than echoed.
 */
export function sanitizePlanType(planType) {
  return sanitizeProviderPlanLabel(planType);
}

/**
 * Derive a keyed account scope from an in-memory `account/read` response.
 *
 * The response may expose its current email as `email`, `account.email`,
 * `user.email`, or the same fields under `result`. This function intentionally
 * does not fall back to provider IDs, display names, or arbitrary fields.
 * Callers must inject a non-empty secret (for example, from macOS Keychain).
 */
export function deriveOpenAIAccountScope(accountRead, {
  secret,
  planType = null,
  unavailableSecretReason = "missing_secret",
} = {}) {
  const safePlanType = sanitizePlanType(planType);
  const subject = normalizedEmail(accountRead);
  if (subject.state !== "available") return unavailable(subject.state, safePlanType);

  const key = usableSecret(secret);
  if (!key) {
    const reason = ["credential_locked", "credential_unavailable"].includes(unavailableSecretReason)
      ? unavailableSecretReason
      : "missing_secret";
    return unavailable(reason, safePlanType);
  }

  const digest = createHmac("sha256", key)
    .update(HMAC_DOMAIN, "utf8")
    .update(subject.value, "utf8")
    .digest("base64url");

  return {
    status: "available",
    reason: null,
    version: OPENAI_ACCOUNT_SCOPE_VERSION,
    scopeId: `${OPENAI_ACCOUNT_SCOPE_PREFIX}${digest}`,
    planType: safePlanType,
  };
}

/**
 * Keep only the stable, non-sensitive account-scope schema when loading a
 * previously persisted observation. Unknown fields, including any accidental
 * raw account subject, are discarded.
 */
export function sanitizeAccountScope(value) {
  const planType = sanitizePlanType(value?.planType);
  if (value?.status === "available" && value?.version === OPENAI_ACCOUNT_SCOPE_VERSION && SCOPE_ID_PATTERN.test(value?.scopeId ?? "")) {
    return {
      status: "available",
      reason: null,
      version: OPENAI_ACCOUNT_SCOPE_VERSION,
      scopeId: value.scopeId,
      planType,
    };
  }

  const reason = ["missing_account", "malformed_subject", "missing_secret", "credential_locked", "credential_unavailable"].includes(value?.reason)
    ? value.reason
    : "missing_account";
  return unavailable(reason, planType);
}
