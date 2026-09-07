import assert from "node:assert/strict";
import test from "node:test";

import {
  qualifyLinuxCredentialMutex,
} from "../scripts/qualify-linux-credential-mutex.mjs";

function evidenceBinding() {
  return Object.freeze({
    acquireCredentialMutex() {},
    releaseCredentialMutex() {},
    abandonCredentialMutex() {},
    readAccountlessInstallationCredential() { return null; },
    createAccountlessInstallationCredentialIfMissing() { return "created"; },
    deleteAccountlessInstallationCredentialExact() { return "deleted"; },
    credentialMutexContractVersion: "linux-credential-mutex-v1",
    credentialMutexCrossProcessSafe: true,
    credentialMutexSameNetworkNamespaceOnly: true,
    credentialMutexDurableMarker: true,
    productionSafe: false,
  });
}

function evidence() {
  return {
    target: "linux-x64",
    pathSafetyVerified: true,
    manifestPathSafetyVerified: true,
    bindingIntegrityVerifiedBeforeAndAfter: true,
    crossProcessScope: "same_linux_network_namespace",
    productionSafe: false,
  };
}

test("Linux mutex qualification is native Linux x64-only and keeps a production-disabled receipt", () => {
  for (const [platform, architecture, code] of [
    ["darwin", "arm64", "native_linux_required"],
    ["linux", "arm64", "native_linux_x64_required"],
  ]) {
    assert.throws(
      () => qualifyLinuxCredentialMutex({ platform, architecture }),
      (error) => error?.code === `linux_credential_mutex_qualification_${code}`,
    );
  }
});

test("Linux mutex qualification invokes only the fixed native test and returns a narrow receipt", () => {
  const calls = [];
  const receipt = qualifyLinuxCredentialMutex({
    platform: "linux",
    architecture: "x64",
    executable: "/fixed/node",
    environment: { SAFE: "1" },
    loadBinding() {
      return evidenceBinding();
    },
    bindingEvidence: evidence,
    spawnSync(executable, argumentsList, options) {
      calls.push({ executable, argumentsList, options });
      return { status: 0, signal: null, error: null };
    },
  });
  assert.deepEqual(receipt, {
    schemaVersion: "linux-credential-mutex-qualification-v1",
    status: "passed",
    scope: "native_mutex_only",
    syntheticAccountlessInstallationRecordTested: true,
    productionCredentialAccessed: false,
    platform: "linux",
    architecture: "x64",
    contractVersion: "linux-credential-mutex-v1",
    crossProcessSafe: true,
    crossProcessScope: "same_linux_network_namespace",
    durableAbandonmentMarker: true,
    productionSafe: false,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argumentsList, [
    "--test",
    "test/linux-credential-mutex-native.test.js",
  ]);
  assert.equal(calls[0].options.env.SAFE, "1");
  assert.equal(calls[0].options.env.USAGE_MONITOR_LINUX_CREDENTIAL_MUTEX_NATIVE_TEST, "1");
});

test("Linux mutex qualification refuses a missing binding or failed native test", () => {
  assert.throws(
    () => qualifyLinuxCredentialMutex({
      platform: "linux",
      architecture: "x64",
      loadBinding() {
        throw new Error("missing binding");
      },
    }),
    (error) => error?.code === "linux_credential_mutex_qualification_binding_unavailable",
  );
  assert.throws(
    () => qualifyLinuxCredentialMutex({
      platform: "linux",
      architecture: "x64",
      loadBinding() {
        return evidenceBinding();
      },
      bindingEvidence: evidence,
      spawnSync() {
        return { status: 1, signal: null, error: null };
      },
    }),
    (error) => error?.code === "linux_credential_mutex_qualification_native_test_failed",
  );
});
