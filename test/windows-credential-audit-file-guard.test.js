import assert from "node:assert/strict";
import test from "node:test";

import {
  WindowsCredentialAuditFileGuardError,
  createWindowsCredentialAuditFileGuardContext,
  isWindowsCredentialAuditFileGuardContext,
  isWindowsCredentialAuditFileGuardError,
} from "../src/platform/windows-credential-audit-file-guard.js";

const DATABASE_PATH = "C:\\Users\\Ada\\AppData\\Local\\app-usagemonitor\\private\\windows-credential-operation-audit-v1.sqlite";
const IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00000000000000000000000000000002",
  linkCount: 1,
});

function guardError(code) {
  return (error) => {
    assert.equal(error instanceof WindowsCredentialAuditFileGuardError, true);
    assert.equal(isWindowsCredentialAuditFileGuardError(error), true);
    assert.equal(error.code, `windows_credential_audit_file_guard_${code}`);
    assert.equal(error.message, "Windows credential audit file guard failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

function bindingFixture() {
  const calls = [];
  return {
    calls,
    binding: {
      credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
      credentialAuditFileGuardSafe: true,
      ensureDirectory(path) {
        calls.push(["ensure", path]);
        return IDENTITY;
      },
      createFile(path, bytes) {
        calls.push(["create", path, bytes.byteLength]);
        return IDENTITY;
      },
      acquireCredentialAuditFileGuard(path) {
        const guard = { path };
        calls.push(["acquire", path]);
        return { guard, identity: IDENTITY };
      },
      releaseCredentialAuditFileGuard(guard) {
        calls.push(["release", guard.path]);
      },
    },
  };
}

test("credential audit file guard pins the database and persistent journal", () => {
  const fixture = bindingFixture();
  const context = createWindowsCredentialAuditFileGuardContext({
    platform: "win32",
    architecture: "x64",
    binding: fixture.binding,
  });
  assert.equal(isWindowsCredentialAuditFileGuardContext(context), true);
  assert.equal(context.filesystemProtected, true);
  assert.equal(context.productionSafe, false);
  const lease = context.acquire(DATABASE_PATH);
  assert.deepEqual(fixture.calls, [
    ["ensure", "C:\\Users\\Ada\\AppData\\Local\\app-usagemonitor"],
    ["ensure", "C:\\Users\\Ada\\AppData\\Local\\app-usagemonitor\\private"],
    ["create", DATABASE_PATH, 0],
    ["create", `${DATABASE_PATH}-journal`, 0],
    ["acquire", DATABASE_PATH],
    ["acquire", `${DATABASE_PATH}-journal`],
  ]);
  context.release(lease);
  assert.deepEqual(fixture.calls.slice(-2), [
    ["release", `${DATABASE_PATH}-journal`],
    ["release", DATABASE_PATH],
  ]);
  assert.throws(() => context.release(lease), guardError("foreign"));
});

test("credential audit file guard accepts files created by a concurrent owner", () => {
  const fixture = bindingFixture();
  fixture.binding.createFile = () => {
    const error = new Error("already exists");
    error.code = "WINDOWS_FILESYSTEM_ALREADY_EXISTS";
    throw error;
  };
  const context = createWindowsCredentialAuditFileGuardContext({
    platform: "win32",
    architecture: "x64",
    binding: fixture.binding,
  });
  const lease = context.acquire(DATABASE_PATH);
  context.release(lease);
});

test("credential audit file guard rejects caller-selected names and foreign leases", () => {
  const context = createWindowsCredentialAuditFileGuardContext({
    platform: "win32",
    architecture: "x64",
    binding: bindingFixture().binding,
  });
  assert.throws(
    () => context.acquire("C:\\Users\\Ada\\private\\other.sqlite"),
    guardError("invalid_configuration"),
  );
  assert.throws(() => context.release({}), guardError("foreign"));
});

test("credential audit file guard collapses native policy and malformed results", () => {
  const fixture = bindingFixture();
  fixture.binding.acquireCredentialAuditFileGuard = () => {
    const error = new Error("DO-NOT-LEAK-native-policy");
    error.code = "WINDOWS_FILESYSTEM_REPARSE_POINT";
    throw error;
  };
  const context = createWindowsCredentialAuditFileGuardContext({
    platform: "win32",
    architecture: "x64",
    binding: fixture.binding,
  });
  assert.throws(() => context.acquire(DATABASE_PATH), guardError("security_policy"));

  fixture.binding.acquireCredentialAuditFileGuard = () => ({ guard: {}, identity: null });
  const malformed = createWindowsCredentialAuditFileGuardContext({
    platform: "win32",
    architecture: "x64",
    binding: fixture.binding,
  });
  assert.throws(() => malformed.acquire(DATABASE_PATH), guardError("unavailable"));
});
