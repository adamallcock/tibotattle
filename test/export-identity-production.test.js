import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli.js";
import {
  renderParticipantIdentityBackendMode,
  renderParticipantIdentityFileResidueState,
  renderParticipantIdentitySourceState,
  selectProductionParticipantIdentity,
} from "../src/export-identity-production.js";
import { EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES } from "../src/export-identity-keychain.js";

function fakeBackend() {
  return Object.freeze({
    read: async () => null,
    createIfMissing: async () => "created",
    replaceExact: async () => "replaced",
    deleteExact: async () => "deleted",
    describe: async () => ({ backend: "macos_keychain", status: "available" }),
  });
}

for (const architecture of ["arm64", "x64"]) {
  test(`macOS ${architecture} production selection constructs only the injected Keychain route`, () => {
    const backend = fakeBackend();
    let constructions = 0;
    const selected = selectProductionParticipantIdentity({
      environmentSecret: null,
      explicitSecretFile: null,
      platform: "darwin",
      architecture,
      appStateSecretFile: "/fixed/app-state/export-secret",
      createKeychainBackend() {
        constructions += 1;
        return backend;
      },
    });
    assert.equal(constructions, 1);
    assert.equal(selected.mode, "macos_keychain");
    assert.equal(selected.identityOptions.environmentSecret, null);
    assert.equal(selected.identityOptions.secretFile, "/fixed/app-state/export-secret");
    assert.equal(selected.identityOptions.participantSecretBackend, backend);
    assert.equal(
      selected.identityOptions.participantSecretCapability,
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity,
    );
    assert.equal(Object.hasOwn(selected.identityOptions, "legacySecretFile"), false);
  });
}

test("Windows x64 export-identity production selection remains fail closed", () => {
  let constructions = 0;
  assert.throws(
    () => selectProductionParticipantIdentity({
      environmentSecret: null,
      explicitSecretFile: null,
      platform: "win32",
      architecture: "x64",
      createKeychainBackend() {
        constructions += 1;
        return fakeBackend();
      },
    }),
    (error) => error.code === "EXPORT_IDENTITY_PRODUCTION_BACKEND_UNAVAILABLE",
  );
  assert.equal(constructions, 0);
});

test("explicit file and environment development overrides never construct or mix with Keychain", () => {
  let constructions = 0;
  const createKeychainBackend = () => {
    constructions += 1;
    return fakeBackend();
  };
  const file = selectProductionParticipantIdentity({
    environmentSecret: null,
    explicitSecretFile: "/development/secret",
    platform: "darwin",
    architecture: "arm64",
    createKeychainBackend,
  });
  assert.deepEqual(file, {
    mode: "owner_file_override",
    identityOptions: {
      environmentSecret: null,
      secretFile: "/development/secret",
      legacySecretFile: null,
    },
  });

  const environment = selectProductionParticipantIdentity({
    environmentSecret: "external-secret-canary",
    explicitSecretFile: null,
    platform: "darwin",
    architecture: "arm64",
    appStateSecretFile: "/fixed/app-state/export-secret",
    createKeychainBackend,
  });
  assert.equal(environment.mode, "external_environment_override");
  assert.deepEqual(environment.identityOptions, {
    environmentSecret: "external-secret-canary",
    secretFile: "/fixed/app-state/export-secret",
    legacySecretFile: null,
  });
  assert.equal(constructions, 0);

  assert.throws(
    () => selectProductionParticipantIdentity({
      environmentSecret: "external-secret-canary",
      explicitSecretFile: "/development/secret",
      createKeychainBackend,
    }),
    (error) => error.code === "EXPORT_IDENTITY_OVERRIDE_CONFLICT"
      && error.message === "Production participant identity backend selection failed",
  );
  assert.equal(constructions, 0);
});

test("unsupported production platforms fail closed unless a development override is explicit", () => {
  for (const [platform, architecture] of [["linux", "arm64"], ["linux", "x64"], ["darwin", "ia32"], ["darwin", "x86_64"]]) {
    assert.throws(
      () => selectProductionParticipantIdentity({
        environmentSecret: null,
        platform,
        architecture,
      }),
      (error) => error.code === "EXPORT_IDENTITY_PRODUCTION_BACKEND_UNAVAILABLE",
    );
  }
});

for (const architecture of ["arm64", "x64"]) {
  test(`macOS ${architecture} backend construction errors are fixed and content-free`, () => {
    const canary = "DO-NOT-LEAK-production-selector";
    assert.throws(
      () => selectProductionParticipantIdentity({
        environmentSecret: null,
        platform: "darwin",
        architecture,
        createKeychainBackend() { throw new Error(canary); },
      }),
      (error) => {
        assert.equal(error.code, "EXPORT_IDENTITY_PRODUCTION_BACKEND_UNAVAILABLE");
        assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(canary), false);
        return true;
      },
    );
  });
}

for (const architecture of ["arm64", "x64"]) {
  test(`macOS ${architecture} production selection refuses account-observation or arbitrary Keychain capabilities`, () => {
    let constructions = 0;
    const createKeychainBackend = () => {
      constructions += 1;
      return fakeBackend();
    };
    for (const keychainCapability of [
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
      { service: "private-service", account: "private-account", secretPrefix: "private-prefix" },
    ]) {
      assert.throws(
        () => selectProductionParticipantIdentity({
          environmentSecret: null,
          platform: "darwin",
          architecture,
          keychainCapability,
          createKeychainBackend,
        }),
        (error) => error.code === "EXPORT_IDENTITY_PRODUCTION_BACKEND_INVALID"
          && error.message === "Production participant identity backend selection failed",
      );
    }
    assert.equal(constructions, 0);
  });
}

test("CLI rotation preflight and confirmation use injected selection without disclosing backend details", async () => {
  const canaries = [
    "/private/app-state/secret",
    "app-usagemonitor.export-identity.v1",
    "installation",
    "PRIVATE-SECRET",
  ];
  const identityOptions = Object.freeze({ opaque: "test-only-options" });
  const selectParticipantIdentity = () => ({ mode: "macos_keychain", identityOptions });
  const lines = [];
  const originalLog = console.log;
  console.log = (...values) => { lines.push(values.join(" ")); };
  try {
    let inspectedOptions;
    await run(["rotate-local-identity"], {
      selectParticipantIdentity,
      async inspectIdentity(options) {
        inspectedOptions = options;
        return {
          status: "ready",
          source: "secret_backend",
          conflict: false,
          rotatable: true,
        };
      },
    });
    assert.equal(inspectedOptions, identityOptions);
    assert.match(lines.join("\n"), /preflight: ready/);
    assert.match(lines.join("\n"), /Storage backend: macos_keychain/);
    assert.match(lines.join("\n"), /Identity source: keychain/);
    assert.match(lines.join("\n"), /Rotatable: true/);
    for (const canary of canaries) assert.equal(lines.join("\n").includes(canary), false);

    lines.length = 0;
    let rotationOptions;
    await run(["rotate-local-identity", "--confirm"], {
      selectParticipantIdentity,
      async rotateIdentity(options) {
        rotationOptions = options;
        return { ownerFileRetired: true, secretFilesRemoved: 1, secretFilesRetained: 0, secureErasure: false };
      },
    });
    assert.deepEqual(rotationOptions, { ...identityOptions, confirmRotation: true });
    assert.match(lines.join("\n"), /rotation: completed/);
    assert.match(lines.join("\n"), /Storage backend: macos_keychain/);
    assert.match(lines.join("\n"), /Fallback retirement markers committed: true/);
    assert.match(lines.join("\n"), /Retired secret files removed this operation: 1/);
    assert.match(lines.join("\n"), /Retired secret files retained after operation: 0/);
    for (const canary of canaries) assert.equal(lines.join("\n").includes(canary), false);
  } finally {
    console.log = originalLog;
  }
});

test("CLI state renderers expose only closed source and backend vocabularies", () => {
  assert.equal(renderParticipantIdentityBackendMode("macos_keychain"), "macos_keychain");
  assert.equal(renderParticipantIdentityBackendMode("windows_credential_manager"), "windows_credential_manager");
  assert.equal(renderParticipantIdentityBackendMode("PRIVATE"), "invalid");
  assert.equal(renderParticipantIdentitySourceState({ source: "environment" }), "external_override");
  assert.equal(renderParticipantIdentitySourceState({ source: "secret_backend" }), "keychain");
  assert.equal(renderParticipantIdentitySourceState({
    source: "secret_backend",
    backend: { backend: "windows_credential_manager" },
  }), "keychain");
  assert.equal(renderParticipantIdentitySourceState({ status: "PRIVATE" }), "invalid");
  assert.equal(renderParticipantIdentityFileResidueState("retired_removed"), "absent");
  assert.equal(renderParticipantIdentityFileResidueState("retired_retained"), "retained");
  assert.equal(renderParticipantIdentityFileResidueState("PRIVATE"), "invalid");
});
