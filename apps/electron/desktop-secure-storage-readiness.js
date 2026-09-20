const FAILURE_REASONS = Object.freeze([
  "locked",
  "denied",
  "migration_required",
  "timeout",
  "credential_invalid",
  "adapter_integrity_failed",
  "security_unavailable",
]);

const FAILURE_REASON_SET = new Set(FAILURE_REASONS);
const MAX_OPERATION_TIMEOUT_MS = 15_000;

const ERROR_CODE_REASONS = new Map([
  ["KEYCHAIN_LOCKED", "locked"],
  ["KEYCHAIN_DENIED", "denied"],
  ["KEYCHAIN_MIGRATION_REQUIRED", "migration_required"],
  ["KEYCHAIN_CREDENTIAL_INVALID", "credential_invalid"],
  ["broker_timeout", "timeout"],
  ["adapter_integrity_failed", "adapter_integrity_failed"],
  ["broker_unavailable", "security_unavailable"],
  ["contribution_device_credential_recovery_required", "migration_required"],
]);

const SUPPORT_CODES = Object.freeze({
  locked: "SECURE_STORAGE_LOCKED",
  denied: "SECURE_STORAGE_DENIED",
  migration_required: "SECURE_STORAGE_MIGRATION_REQUIRED",
  timeout: "SECURE_STORAGE_TIMEOUT",
  credential_invalid: "SECURE_STORAGE_CREDENTIAL_INVALID",
  adapter_integrity_failed: "SECURE_STORAGE_ADAPTER_INTEGRITY_FAILED",
  security_unavailable: "SECURE_STORAGE_UNAVAILABLE",
});

const COPY = Object.freeze({
  locked: Object.freeze({
    message: "A Keychain required by TiboTattle is locked.",
    detail: "Open Keychain Access and unlock your login Keychain and any custom Keychains in its search list, then choose Retry.",
  }),
  denied: Object.freeze({
    message: "macOS denied TiboTattle access to a required secure credential.",
    detail: "In Keychain Access, confirm the signed TiboTattle app is permitted to read its existing item, then choose Retry. Do not delete or reset the credential.",
  }),
  migration_required: Object.freeze({
    message: "An existing TiboTattle credential needs a secure upgrade.",
    detail: "Quit and use the signed TiboTattle Secure upgrade recovery flow before trying again. The legacy credential is retained as the recovery copy.",
  }),
  timeout: Object.freeze({
    message: "macOS did not finish the secure credential check in time.",
    detail: "Wait for Keychain Access to become responsive, then choose Retry. TiboTattle will not retry automatically.",
  }),
  credential_invalid: Object.freeze({
    message: "A required TiboTattle credential could not be validated.",
    detail: "The credential was preserved. Do not delete or reset it; quit and contact support with the support code below.",
  }),
  adapter_integrity_failed: Object.freeze({
    message: "TiboTattle's secure storage component failed verification.",
    detail: "Quit and reinstall an untouched TiboTattle release for this Mac, then try again.",
  }),
  security_unavailable: Object.freeze({
    message: "macOS secure storage is currently unavailable to TiboTattle.",
    detail: "Open Keychain Access and confirm your Keychains are available, then choose Retry. If this continues, contact support.",
  }),
});

export const DESKTOP_SECURE_STORAGE_FAILURE_REASONS = FAILURE_REASONS;

export function normalizeDesktopSecureStorageFailureReason(value) {
  return FAILURE_REASON_SET.has(value) ? value : "security_unavailable";
}

export function isDesktopSecureStorageFailure(error) {
  try {
    return FAILURE_REASON_SET.has(error?.secureStorageReason)
      || ERROR_CODE_REASONS.has(error?.code);
  } catch {
    return false;
  }
}

export function classifyDesktopSecureStorageFailure(error) {
  try {
    if (FAILURE_REASON_SET.has(error?.secureStorageReason)) {
      return error.secureStorageReason;
    }
    return ERROR_CODE_REASONS.get(error?.code) ?? "security_unavailable";
  } catch {
    return "security_unavailable";
  }
}

export function createDesktopSecureStorageFailure(reason) {
  const selected = normalizeDesktopSecureStorageFailureReason(reason);
  return Object.assign(new Error("Desktop secure storage is unavailable"), {
    code: "desktop_secure_storage_unavailable",
    secureStorageReason: selected,
  });
}

export async function awaitDesktopSecureStorageOperation(operation, {
  timeoutMs = MAX_OPERATION_TIMEOUT_MS,
  disposeLateResult = () => {},
} = {}) {
  if (typeof operation !== "function"
      || typeof disposeLateResult !== "function"
      || !Number.isInteger(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw createDesktopSecureStorageFailure("adapter_integrity_failed");
  }
  let timer;
  let timedOut = false;
  const pending = Promise.resolve().then(operation);
  void pending.then((value) => {
    if (timedOut) disposeLateResult(value);
  }, () => {});
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            timedOut = true;
            reject(createDesktopSecureStorageFailure("timeout"));
          },
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createDesktopSecureStorageDialog(reason) {
  const selected = normalizeDesktopSecureStorageFailureReason(reason);
  const copy = COPY[selected];
  return Object.freeze({
    type: "warning",
    title: "Unable to prepare secure storage",
    message: copy.message,
    detail: `${copy.detail} No credential was created, replaced, or deleted. Support code: ${SUPPORT_CODES[selected]}.`,
    // Quit is the safe Return/Escape default. Retry happens only after an
    // explicit click and never schedules an automatic prompt or retry loop.
    buttons: Object.freeze(["Quit", "Retry"]),
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
}
