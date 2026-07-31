import assert from "node:assert/strict";
import test from "node:test";

import {
  selectProductionParticipantIdentity,
} from "../src/application/index.js";

const EXPORT_CAPABILITY = Object.freeze({ name: "export-identity" });
const ACCOUNT_CAPABILITY = Object.freeze({ name: "account-observation" });

function baseOptions(overrides = {}) {
  return {
    environmentSecret: null,
    explicitSecretFile: null,
    platform: "darwin",
    architecture: "arm64",
    appStateSecretFile: "/fixed/app-state/export-secret",
    createKeychainBackend: () => Object.freeze({ kind: "fixture" }),
    keychainCapability: EXPORT_CAPABILITY,
    allowedKeychainCapability: EXPORT_CAPABILITY,
    ...overrides,
  };
}

test("application identity selection is runtime-neutral and port-driven", () => {
  const selected = selectProductionParticipantIdentity(baseOptions());
  assert.equal(selected.mode, "macos_keychain");
  assert.equal(
    selected.identityOptions.secretFile,
    "/fixed/app-state/export-secret",
  );
  assert.equal(
    selected.identityOptions.participantSecretCapability,
    EXPORT_CAPABILITY,
  );
  assert.equal(selected.identityOptions.participantSecretBackend.kind, "fixture");
});

test("identity overrides win before native backend construction", () => {
  let constructions = 0;
  const selected = selectProductionParticipantIdentity(baseOptions({
    explicitSecretFile: "/development/secret",
    createKeychainBackend: () => {
      constructions += 1;
      return {};
    },
  }));
  assert.equal(selected.mode, "owner_file_override");
  assert.equal(constructions, 0);
});

test("identity selection rejects wrong capabilities and collapses backend errors", () => {
  assert.throws(
    () => selectProductionParticipantIdentity(baseOptions({
      keychainCapability: ACCOUNT_CAPABILITY,
    })),
    (error) => error.code === "EXPORT_IDENTITY_PRODUCTION_BACKEND_INVALID",
  );
  const canary = "PRIVATE-UPSTREAM-KEYCHAIN-ERROR";
  assert.throws(
    () => selectProductionParticipantIdentity(baseOptions({
      createKeychainBackend() {
        throw new Error(canary);
      },
    })),
    (error) => error.code
      === "EXPORT_IDENTITY_PRODUCTION_BACKEND_UNAVAILABLE"
      && !`${error.stack}\n${JSON.stringify(error)}`.includes(canary),
  );
});
