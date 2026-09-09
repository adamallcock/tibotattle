import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import {
  KEYTAR_WIN32_X64_SHA256,
  loadAuditedWindowsCredentialBinding,
  runWindowsCredentialManagerProbe,
} from "../src/platform/windows-credential-manager-probe.js";
import {
  windowsNativeUnsignedContentDigest,
} from "../src/platform/index.js";

const require = createRequire(import.meta.url);
const WINDOWS_KEYTAR_PATH = require.resolve(
  "@github/keytar/prebuilds/win32-x64/keytar.node",
);

function nativeBinding() {
  return {
    getPassword() {},
    setPassword() {},
    deletePassword() {},
  };
}

function signedAuthenticodeCopy(bytes) {
  const pe = bytes.readUInt32LE(0x3c);
  const optional = pe + 24;
  const security = optional + 112 + 32;
  assert.equal(bytes.length % 8, 0);
  assert.equal(bytes.readUInt32LE(security), 0);
  assert.equal(bytes.readUInt32LE(security + 4), 0);
  const signed = Buffer.alloc(bytes.length + 8);
  bytes.copy(signed);
  signed.writeUInt32LE(7, optional + 64);
  signed.writeUInt32LE(bytes.length, security);
  signed.writeUInt32LE(8, security + 4);
  signed.fill(1, bytes.length);
  return signed;
}

function loadFixtureBinding(bytes, requireBinding = nativeBinding) {
  return loadAuditedWindowsCredentialBinding({
    platform: "win32",
    architecture: "x64",
    resolveBinding: () => WINDOWS_KEYTAR_PATH,
    readBinding: () => bytes,
    requireBinding,
  });
}

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

test("Credential Manager probe reports only status, binding content identity, and cleanup", async () => {
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
    bindingUnsignedContentSha256: KEYTAR_WIN32_X64_SHA256,
    cleanup: "confirmed",
  });
  assert.equal(JSON.stringify(receipt).includes(secret), false);
});

test("Credential Manager binding accepts only vendor-pinned PE content after Authenticode changes", () => {
  const vendor = readFileSync(WINDOWS_KEYTAR_PATH);
  assert.equal(createHash("sha256").update(vendor).digest("hex"), KEYTAR_WIN32_X64_SHA256);
  assert.equal(windowsNativeUnsignedContentDigest(vendor), KEYTAR_WIN32_X64_SHA256);

  const signed = signedAuthenticodeCopy(vendor);
  assert.notEqual(createHash("sha256").update(signed).digest("hex"), KEYTAR_WIN32_X64_SHA256);
  assert.equal(windowsNativeUnsignedContentDigest(signed), KEYTAR_WIN32_X64_SHA256);
  const expectedBinding = nativeBinding();
  assert.equal(loadFixtureBinding(signed, () => expectedBinding), expectedBinding);

  const altered = Buffer.from(signed);
  altered[512] ^= 1;
  let required = false;
  assert.throws(
    () => loadFixtureBinding(altered, () => {
      required = true;
      return nativeBinding();
    }),
    { code: "WINDOWS_CREDENTIAL_MANAGER_BINDING_INTEGRITY" },
  );
  assert.equal(required, false);

  const malformed = Buffer.from(signed);
  malformed.writeUInt32LE(32, 0x3c);
  assert.throws(
    () => loadFixtureBinding(malformed),
    { code: "WINDOWS_CREDENTIAL_MANAGER_BINDING_INTEGRITY" },
  );
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
