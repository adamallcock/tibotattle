import assert from "node:assert/strict";
import test from "node:test";

import {
  awaitDesktopSecureStorageOperation,
  classifyDesktopSecureStorageFailure,
  createDesktopSecureStorageDialog,
  createDesktopSecureStorageFailure,
  DESKTOP_SECURE_STORAGE_FAILURE_REASONS,
  isDesktopSecureStorageFailure,
  normalizeDesktopSecureStorageFailureReason,
} from "../desktop-secure-storage-readiness.js";

const CODE_CASES = Object.freeze([
  ["KEYCHAIN_LOCKED", "locked", "SECURE_STORAGE_LOCKED"],
  ["KEYCHAIN_DENIED", "denied", "SECURE_STORAGE_DENIED"],
  ["KEYCHAIN_MIGRATION_REQUIRED", "migration_required", "SECURE_STORAGE_MIGRATION_REQUIRED"],
  ["broker_timeout", "timeout", "SECURE_STORAGE_TIMEOUT"],
  ["KEYCHAIN_CREDENTIAL_INVALID", "credential_invalid", "SECURE_STORAGE_CREDENTIAL_INVALID"],
  ["adapter_integrity_failed", "adapter_integrity_failed", "SECURE_STORAGE_ADAPTER_INTEGRITY_FAILED"],
  ["broker_unavailable", "security_unavailable", "SECURE_STORAGE_UNAVAILABLE"],
]);

test("secure storage failures keep a closed content-free reason and support code", () => {
  assert.deepEqual(DESKTOP_SECURE_STORAGE_FAILURE_REASONS, CODE_CASES.map((entry) => entry[1]));
  for (const [code, reason, supportCode] of CODE_CASES) {
    const error = Object.assign(new Error("private native detail"), { code });
    assert.equal(isDesktopSecureStorageFailure(error), true);
    assert.equal(classifyDesktopSecureStorageFailure(error), reason);
    const dialog = createDesktopSecureStorageDialog(reason);
    assert.equal(dialog.type, "warning");
    assert.equal(dialog.title, "Unable to prepare secure storage");
    assert.match(dialog.detail, new RegExp(`Support code: ${supportCode}\\.$`, "u"));
    assert.doesNotMatch(JSON.stringify(dialog), /private native detail/u);
    assert.deepEqual(dialog.buttons, ["Quit", "Retry"]);
    assert.equal(dialog.defaultId, 0);
    assert.equal(dialog.cancelId, 0);
  }
});

test("unknown or hostile failures collapse to security unavailable", () => {
  const hostile = new Proxy({}, { get() { throw new Error("private detail"); } });
  for (const value of [undefined, null, {}, hostile]) {
    assert.equal(classifyDesktopSecureStorageFailure(value), "security_unavailable");
    assert.equal(isDesktopSecureStorageFailure(value), false);
  }
  assert.equal(normalizeDesktopSecureStorageFailureReason("not-a-reason"),
    "security_unavailable");
});

test("explicit readiness failures retain only a fixed reason", () => {
  const error = createDesktopSecureStorageFailure("credential_invalid");
  assert.equal(error.code, "desktop_secure_storage_unavailable");
  assert.equal(error.secureStorageReason, "credential_invalid");
  assert.equal(classifyDesktopSecureStorageFailure(error), "credential_invalid");
  assert.equal(isDesktopSecureStorageFailure(error), true);
});

test("secure storage operations have a bounded content-free timeout", async () => {
  let resolveLateRead;
  const lateSecret = Buffer.alloc(32, 19);
  await assert.rejects(
    awaitDesktopSecureStorageOperation(() => new Promise((resolve) => {
      resolveLateRead = resolve;
    }), {
      timeoutMs: 5,
      disposeLateResult(value) {
        value.fill(0);
      },
    }),
    (error) => error?.code === "desktop_secure_storage_unavailable"
      && error.secureStorageReason === "timeout",
  );
  resolveLateRead(lateSecret);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lateSecret, Buffer.alloc(32));
  await assert.rejects(
    awaitDesktopSecureStorageOperation(() => null, { timeoutMs: 0 }),
    (error) => error?.secureStorageReason === "adapter_integrity_failed",
  );
});
