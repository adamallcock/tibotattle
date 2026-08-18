import assert from "node:assert/strict";
import test from "node:test";

import {
  KEYTAR_WIN32_X64_SHA256,
  loadAuditedWindowsCredentialBinding,
  runWindowsCredentialManagerProbe,
} from "../src/platform/windows-credential-manager-probe.js";

function memoryBinding() {
  const values = new Map();
  return {
    async getPassword(service, account) {
      return values.get(`${service}\0${account}`) ?? null;
    },
    async setPassword(service, account, value) {
      values.set(`${service}\0${account}`, value);
    },
    async deletePassword(service, account) {
      return values.delete(`${service}\0${account}`);
    },
  };
}

test("Credential Manager probe reports only status, binding identity, and cleanup", async () => {
  const secret = Buffer.alloc(32, 7).toString("base64url");
  const receipt = await runWindowsCredentialManagerProbe({
    binding: memoryBinding(),
    identifier: "11111111-1111-4111-8111-111111111111",
    secret,
  });
  assert.deepEqual(receipt, {
    status: "passed",
    platform: "win32",
    architecture: "x64",
    bindingSha256: KEYTAR_WIN32_X64_SHA256,
    cleanup: "confirmed",
  });
  assert.equal(JSON.stringify(receipt).includes(secret), false);
});

test("Credential Manager probe confirms cleanup after a failed readback", async () => {
  let stored = null;
  const binding = {
    async setPassword(_service, _account, value) { stored = value; },
    async getPassword() { return stored === null ? null : "wrong-value"; },
    async deletePassword() { stored = null; return true; },
  };
  await assert.rejects(
    runWindowsCredentialManagerProbe({
      binding,
      identifier: "22222222-2222-4222-8222-222222222222",
      secret: Buffer.alloc(32, 8).toString("base64url"),
    }),
    { code: "WINDOWS_CREDENTIAL_MANAGER_ROUND_TRIP" },
  );
  assert.equal(stored, null);
});

test("Credential Manager cleanup failure takes precedence over operation failure", async () => {
  const secret = Buffer.alloc(32, 9).toString("base64url");
  let reads = 0;
  const binding = {
    async setPassword() {},
    async getPassword() {
      reads += 1;
      return reads === 1 ? "wrong-value" : secret;
    },
    async deletePassword() { return false; },
  };
  await assert.rejects(
    runWindowsCredentialManagerProbe({
      binding,
      identifier: "33333333-3333-4333-8333-333333333333",
      secret,
    }),
    { code: "WINDOWS_CREDENTIAL_MANAGER_CLEANUP_FAILED" },
  );
});

test("Credential Manager native x64 binding completes a disposable round trip", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, async () => {
  const binding = loadAuditedWindowsCredentialBinding();
  const receipt = await runWindowsCredentialManagerProbe({ binding });
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.cleanup, "confirmed");
});
