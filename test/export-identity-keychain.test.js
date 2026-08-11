import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  CONTRIBUTION_DEVICE_READER_CODE_IDENTIFIER,
  CONTRIBUTION_DEVICE_READER_TEAM_IDENTIFIER,
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  ExportIdentityKeychainError,
  KEYTAR_DARWIN_ARM64_SHA256,
  KEYTAR_SIGNING_CODE_IDENTIFIER,
  KEYTAR_SIGNING_TEAM_IDENTIFIER,
  contributionDeviceDurableAddArguments,
  contributionDeviceReaderRequirement,
  contributionDeviceReaderRequirementVerificationArguments,
  createExportIdentityKeychainBackend,
  deleteExportIdentityKeychainItemByAttributes,
  exportIdentityKeychainAttributeDeleteArguments,
  keytarSignedBindingRequirement,
  keytarSignedBindingVerificationArguments,
  loadExportIdentityKeychainBinding,
} from "../src/export-identity-keychain.js";

const require = createRequire(import.meta.url);
const EXPORT_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity;
const ACCOUNT_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;
const CLAUDE_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym;
const DEVICE_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice;

function credentialKey(service, account) {
  return `${service}\u0000${account}`;
}

function memoryBinding(entries = []) {
  const values = new Map(entries.map(([capability, value]) => [
    credentialKey(capability.service, capability.account),
    value,
  ]));
  const calls = [];
  return {
    calls,
    values,
    async getPassword(service, account) {
      calls.push(["getPassword", service, account]);
      return values.get(credentialKey(service, account)) ?? null;
    },
    async setPassword(service, account, password) {
      calls.push(["setPassword", service, account, password]);
      values.set(credentialKey(service, account), password);
    },
    async deletePassword(service, account) {
      calls.push(["deletePassword", service, account]);
      return values.delete(credentialKey(service, account));
    },
  };
}

function encoded(fill) {
  return Buffer.alloc(32, fill).toString("base64url");
}

function assertKeychainError(code) {
  return (error) => {
    assert.equal(error instanceof ExportIdentityKeychainError, true);
    assert.equal(error.code, `export_identity_keychain_${code}`);
    assert.equal(error.message, "macOS Keychain backend failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

test("capabilities are frozen public constants with separate fixed credential pairs", () => {
  assert.equal(Object.isFrozen(EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES), true);
  assert.equal(Object.isFrozen(EXPORT_CAPABILITY), true);
  assert.equal(Object.isFrozen(ACCOUNT_CAPABILITY), true);
  assert.equal(Object.isFrozen(CLAUDE_CAPABILITY), true);
  assert.equal(Object.isFrozen(DEVICE_CAPABILITY), true);
  assert.deepEqual(EXPORT_CAPABILITY, {
    service: "app-usagemonitor.export-identity.v1",
    account: "installation",
  });
  assert.deepEqual(ACCOUNT_CAPABILITY, {
    service: "app-usagemonitor.account-observation.v1",
    account: "installation",
  });
  assert.deepEqual(CLAUDE_CAPABILITY, {
    service: "app-usagemonitor.claude-session-pseudonym.v1",
    account: "installation",
  });
  assert.deepEqual(DEVICE_CAPABILITY, {
    service: "app-usagemonitor.contribution-device.v1",
    account: "installation",
  });
  assert.notDeepEqual(EXPORT_CAPABILITY, ACCOUNT_CAPABILITY);
  assert.notDeepEqual(EXPORT_CAPABILITY, CLAUDE_CAPABILITY);
  assert.notDeepEqual(ACCOUNT_CAPABILITY, CLAUDE_CAPABILITY);
  assert.notDeepEqual(EXPORT_CAPABILITY, DEVICE_CAPABILITY);
  assert.notDeepEqual(ACCOUNT_CAPABILITY, DEVICE_CAPABILITY);
  assert.notDeepEqual(CLAUDE_CAPABILITY, DEVICE_CAPABILITY);
});

test("native loader accepts only the exact audited darwin-arm64 prebuild", () => {
  const actualPath = require.resolve("@github/keytar/prebuilds/darwin-arm64/keytar.node");
  let resolvedSpecifier;
  let requiredPath;
  const fakeBinding = memoryBinding();
  const loaded = loadExportIdentityKeychainBinding({
    platform: "darwin",
    architecture: "arm64",
    resolveBinding(specifier) {
      resolvedSpecifier = specifier;
      return actualPath;
    },
    requireBinding(path) {
      requiredPath = path;
      return fakeBinding;
    },
  });
  assert.equal(KEYTAR_DARWIN_ARM64_SHA256, "855c21e1e702967230bd87f600d04c311b77f29150f3372d547e72882c58de6a");
  assert.equal(resolvedSpecifier, "@github/keytar/prebuilds/darwin-arm64/keytar.node");
  assert.equal(requiredPath, actualPath);
  assert.equal(loaded, fakeBinding);
});

test("native loader rejects unsupported platforms, architectures, paths, hashes, and bindings", () => {
  const fakePath = "/private/tmp/prebuilds/darwin-arm64/keytar.node";
  const validBytes = Buffer.from("not-the-audited-native-binding");
  assert.throws(
    () => loadExportIdentityKeychainBinding(null),
    assertKeychainError("invalid_configuration"),
  );
  assert.throws(
    () => loadExportIdentityKeychainBinding({ platform: "linux", architecture: "arm64" }),
    assertKeychainError("unsupported_platform"),
  );
  assert.throws(
    () => loadExportIdentityKeychainBinding({ platform: "darwin", architecture: "x64" }),
    assertKeychainError("unsupported_architecture"),
  );
  assert.throws(
    () => loadExportIdentityKeychainBinding({
      platform: "darwin",
      architecture: "arm64",
      resolveBinding: () => "/private/tmp/keytar.node",
    }),
    assertKeychainError("invalid_configuration"),
  );
  assert.throws(
    () => loadExportIdentityKeychainBinding({
      platform: "darwin",
      architecture: "arm64",
      resolveBinding: () => fakePath,
      readBinding: () => validBytes,
      runVerificationCommand: () => ({ status: 1 }),
    }),
    assertKeychainError("binding_integrity"),
  );

  const actualPath = require.resolve("@github/keytar/prebuilds/darwin-arm64/keytar.node");
  assert.throws(
    () => loadExportIdentityKeychainBinding({
      platform: "darwin",
      architecture: "arm64",
      resolveBinding: () => actualPath,
      requireBinding: () => ({}),
    }),
    assertKeychainError("invalid_configuration"),
  );
});

test("the audited bytes load without ever invoking signature verification", () => {
  const actualPath = require.resolve("@github/keytar/prebuilds/darwin-arm64/keytar.node");
  const fakeBinding = memoryBinding();
  const loaded = loadExportIdentityKeychainBinding({
    platform: "darwin",
    architecture: "arm64",
    resolveBinding: () => actualPath,
    requireBinding: () => fakeBinding,
    runVerificationCommand: () => {
      throw new Error("the byte-pinned path must not shell out");
    },
  });
  assert.equal(loaded, fakeBinding);
});

test("a signed derivative loads only through the exact designated-requirement verification (2026-08-10)", () => {
  // The Developer ID pipeline re-signs keytar.node in place, so a production
  // install can never match the audited byte pin — the first signed Sparkle
  // update proved that live as a total Keychain outage. Signed bytes are
  // accepted if and only if codesign proves the team-and-identifier
  // designated requirement, which is stable across every properly signed
  // build.
  const fakePath = "/private/tmp/prebuilds/darwin-arm64/keytar.node";
  const signedBytes = Buffer.from("signed-derivative-of-the-audited-binding");
  const fakeBinding = memoryBinding();
  const invocations = [];
  const loaded = loadExportIdentityKeychainBinding({
    platform: "darwin",
    architecture: "arm64",
    resolveBinding: () => fakePath,
    readBinding: () => signedBytes,
    requireBinding: () => fakeBinding,
    runVerificationCommand: (command, commandArguments) => {
      invocations.push([command, commandArguments]);
      return { status: 0 };
    },
  });
  assert.equal(loaded, fakeBinding);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0][0], "/usr/bin/codesign");
  assert.deepEqual([...invocations[0][1]], [
    "--verify",
    "--strict",
    "-R=anchor apple generic"
      + ' and certificate leaf[subject.OU] = "43RTH622SB"'
      + ' and identifier "keytar"',
    "--",
    fakePath,
  ]);
  assert.equal(KEYTAR_SIGNING_TEAM_IDENTIFIER, "43RTH622SB");
  assert.equal(KEYTAR_SIGNING_CODE_IDENTIFIER, "keytar");
  assert.equal(
    `-R=${keytarSignedBindingRequirement()}`,
    invocations[0][1][2],
  );
  assert.deepEqual(
    [...keytarSignedBindingVerificationArguments(fakePath)],
    [...invocations[0][1]],
  );
});

test("unaudited bytes that fail signature verification stay failed closed and content-free", () => {
  const canary = "DO-NOT-LEAK-codesign-outcome";
  const fakePath = "/private/tmp/prebuilds/darwin-arm64/keytar.node";
  const unauditedBytes = Buffer.from("not-the-audited-native-binding");
  for (const runVerificationCommand of [
    () => ({ status: 3 }),
    () => ({ status: 1 }),
    () => ({ status: null }),
    () => null,
    () => "satisfied",
    () => { throw new Error(canary); },
  ]) {
    assert.throws(
      () => loadExportIdentityKeychainBinding({
        platform: "darwin",
        architecture: "arm64",
        resolveBinding: () => fakePath,
        readBinding: () => unauditedBytes,
        requireBinding: () => memoryBinding(),
        runVerificationCommand,
      }),
      (error) => {
        assertKeychainError("binding_integrity")(error);
        assert.equal(error.stack.includes(canary), false);
        assert.equal(JSON.stringify(error).includes(canary), false);
        return true;
      },
    );
  }
});

test("native loader binding failures are content-free", () => {
  const canary = "DO-NOT-LEAK-native-binding-upstream";
  const actualPath = require.resolve("@github/keytar/prebuilds/darwin-arm64/keytar.node");
  for (const options of [
    { resolveBinding: () => { throw new Error(canary); } },
    { resolveBinding: () => actualPath, readBinding: () => { throw new Error(canary); } },
    { resolveBinding: () => actualPath, requireBinding: () => { throw new Error(canary); } },
  ]) {
    assert.throws(
      () => loadExportIdentityKeychainBinding({ platform: "darwin", architecture: "arm64", ...options }),
      (error) => {
        assertKeychainError("binding_unavailable")(error);
        assert.equal(error.stack.includes(canary), false);
        assert.equal(JSON.stringify(error).includes(canary), false);
        return true;
      },
    );
  }
});

test("backend injection failures are content-free", () => {
  const canary = "DO-NOT-LEAK-injected-binding-failure";
  assert.throws(
    () => createExportIdentityKeychainBackend(null),
    assertKeychainError("invalid_configuration"),
  );
  assert.throws(
    () => createExportIdentityKeychainBackend({ loadBinding: () => { throw new Error(canary); } }),
    (error) => {
      assertKeychainError("binding_unavailable")(error);
      assert.equal(error.stack.includes(canary), false);
      return true;
    },
  );
  const hostileBinding = new Proxy({}, {
    get() {
      throw new Error(canary);
    },
  });
  assert.throws(
    () => createExportIdentityKeychainBackend({ binding: hostileBinding }),
    (error) => {
      assertKeychainError("invalid_configuration")(error);
      assert.equal(error.stack.includes(canary), false);
      return true;
    },
  );
});

test("read returns an exact copied 32-byte Buffer or null and rejects malformed storage", async () => {
  const binding = memoryBinding([[EXPORT_CAPABILITY, encoded(3)]]);
  const backend = createExportIdentityKeychainBackend({ binding });
  const first = await backend.read(EXPORT_CAPABILITY);
  assert.equal(Buffer.isBuffer(first), true);
  assert.equal(first.byteLength, 32);
  first.fill(9);
  assert.deepEqual(await backend.read(EXPORT_CAPABILITY), Buffer.alloc(32, 3));
  assert.equal(await backend.read(ACCOUNT_CAPABILITY), null);

  for (const malformed of [
    "",
    `${encoded(4)}\n`,
    encoded(4).slice(0, 42),
    "!".repeat(43),
    `${encoded(0).slice(0, -1)}B`,
  ]) {
    binding.values.set(credentialKey(EXPORT_CAPABILITY.service, EXPORT_CAPABILITY.account), malformed);
    await assert.rejects(backend.read(EXPORT_CAPABILITY), assertKeychainError("stored_value_invalid"));
  }
});

test("describe is capability-bound and never reads or returns credential values", async () => {
  const binding = memoryBinding([[EXPORT_CAPABILITY, encoded(27)]]);
  const backend = createExportIdentityKeychainBackend({ binding });
  assert.deepEqual(await backend.describe(EXPORT_CAPABILITY), {
    backend: "macos_keychain",
    status: "available",
  });
  assert.equal(binding.calls.length, 0);
  await assert.rejects(
    backend.describe({ ...EXPORT_CAPABILITY }),
    assertKeychainError("invalid_capability"),
  );
});

test("locked and denied native failures map to distinct fixed content-free codes", async () => {
  const canary = "DO-NOT-LEAK-keychain-policy";
  for (const [nativeCode, expectedCode] of [
    ["ERR_KEYCHAIN_LOCKED", "locked"],
    ["errSecInteractionNotAllowed", "locked"],
    [-25308, "locked"],
    ["ERR_KEYCHAIN_DENIED", "denied"],
    ["errSecAuthFailed", "denied"],
    [-25293, "denied"],
  ]) {
    const binding = memoryBinding();
    binding.getPassword = async () => {
      const error = new Error(canary);
      error.code = nativeCode;
      throw error;
    };
    await assert.rejects(
      createExportIdentityKeychainBackend({ binding }).read(EXPORT_CAPABILITY),
      (error) => {
        assertKeychainError(expectedCode)(error);
        const rendered = `${error.stack}\n${JSON.stringify(error)}`;
        assert.equal(rendered.includes(canary), false);
        assert.equal(rendered.includes(EXPORT_CAPABILITY.service), false);
        return true;
      },
    );
  }


  for (const [nativeMessage, expectedCode] of [
    ["User interaction is not allowed.", "locked"],
    ["The user name or passphrase you entered is not correct.", "denied"],
    ["User canceled the operation.", "denied"],
  ]) {
    const binding = memoryBinding();
    binding.getPassword = async () => { throw new Error(nativeMessage); };
    await assert.rejects(
      createExportIdentityKeychainBackend({ binding }).read(EXPORT_CAPABILITY),
      (error) => {
        assertKeychainError(expectedCode)(error);
        assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(nativeMessage), false);
        return true;
      },
    );
  }
});

test("createIfMissing stores strict base64url, verifies readback, and preserves an existing value", async () => {
  const binding = memoryBinding();
  const backend = createExportIdentityKeychainBackend({ binding });
  const secret = Buffer.alloc(32, 5);
  assert.equal(await backend.createIfMissing(EXPORT_CAPABILITY, secret), "created");
  const set = binding.calls.find(([method]) => method === "setPassword");
  assert.deepEqual(set.slice(0, 3), ["setPassword", EXPORT_CAPABILITY.service, EXPORT_CAPABILITY.account]);
  assert.match(set[3], /^[A-Za-z0-9_-]{43}$/);
  assert.equal(set[3], secret.toString("base64url"));
  assert.deepEqual(secret, Buffer.alloc(32, 5), "backend must zero only its own generated-secret copy");

  binding.calls.length = 0;
  assert.equal(await backend.createIfMissing(EXPORT_CAPABILITY, Buffer.alloc(32, 6)), "existing");
  assert.equal(binding.calls.some(([method]) => method === "setPassword"), false);
  assert.deepEqual(await backend.read(EXPORT_CAPABILITY), secret);
});

test("replaceExact reports missing and conflict, then replaces only an exact value", async () => {
  const oldSecret = Buffer.alloc(32, 7);
  const replacement = Buffer.alloc(32, 8);
  const binding = memoryBinding();
  const backend = createExportIdentityKeychainBackend({ binding });
  assert.equal(await backend.replaceExact(EXPORT_CAPABILITY, oldSecret, replacement), "missing");

  binding.values.set(credentialKey(EXPORT_CAPABILITY.service, EXPORT_CAPABILITY.account), encoded(9));
  assert.equal(await backend.replaceExact(EXPORT_CAPABILITY, oldSecret, replacement), "conflict");
  assert.deepEqual(await backend.read(EXPORT_CAPABILITY), Buffer.alloc(32, 9));

  binding.values.set(credentialKey(EXPORT_CAPABILITY.service, EXPORT_CAPABILITY.account), oldSecret.toString("base64url"));
  assert.equal(await backend.replaceExact(EXPORT_CAPABILITY, oldSecret, replacement), "replaced");
  assert.deepEqual(await backend.read(EXPORT_CAPABILITY), replacement);
  assert.deepEqual(oldSecret, Buffer.alloc(32, 7));
  assert.deepEqual(replacement, Buffer.alloc(32, 8));
});

test("deleteExact reports missing and conflict, then deletes only an exact value", async () => {
  const expected = Buffer.alloc(32, 10);
  const binding = memoryBinding();
  const backend = createExportIdentityKeychainBackend({ binding });
  assert.equal(await backend.deleteExact(EXPORT_CAPABILITY, expected), "missing");

  binding.values.set(credentialKey(EXPORT_CAPABILITY.service, EXPORT_CAPABILITY.account), encoded(11));
  assert.equal(await backend.deleteExact(EXPORT_CAPABILITY, expected), "conflict");
  assert.equal(binding.calls.some(([method]) => method === "deletePassword"), false);

  binding.values.set(credentialKey(EXPORT_CAPABILITY.service, EXPORT_CAPABILITY.account), expected.toString("base64url"));
  assert.equal(await backend.deleteExact(EXPORT_CAPABILITY, expected), "deleted");
  assert.equal(await backend.read(EXPORT_CAPABILITY), null);
  assert.deepEqual(expected, Buffer.alloc(32, 10));
});

test("mutations fail closed when create, replace, or delete readback disagrees", async () => {
  const oldSecret = Buffer.alloc(32, 12);
  const replacement = Buffer.alloc(32, 13);

  let createReads = 0;
  const createBinding = memoryBinding();
  createBinding.getPassword = async () => {
    createReads += 1;
    return createReads === 1 ? null : encoded(14);
  };
  await assert.rejects(
    createExportIdentityKeychainBackend({ binding: createBinding }).createIfMissing(EXPORT_CAPABILITY, replacement),
    assertKeychainError("readback_mismatch"),
  );

  let replaceReads = 0;
  const replaceBinding = memoryBinding();
  replaceBinding.getPassword = async () => {
    replaceReads += 1;
    return replaceReads === 1 ? oldSecret.toString("base64url") : null;
  };
  await assert.rejects(
    createExportIdentityKeychainBackend({ binding: replaceBinding }).replaceExact(EXPORT_CAPABILITY, oldSecret, replacement),
    assertKeychainError("readback_mismatch"),
  );

  let deleteReads = 0;
  const deleteBinding = memoryBinding();
  deleteBinding.getPassword = async () => {
    deleteReads += 1;
    return oldSecret.toString("base64url");
  };
  await assert.rejects(
    createExportIdentityKeychainBackend({ binding: deleteBinding }).deleteExact(EXPORT_CAPABILITY, oldSecret),
    assertKeychainError("readback_mismatch"),
  );
});

test("capabilities never cross service boundaries", async () => {
  const binding = memoryBinding([
    [EXPORT_CAPABILITY, encoded(15)],
    [ACCOUNT_CAPABILITY, encoded(16)],
    [CLAUDE_CAPABILITY, encoded(18)],
    [DEVICE_CAPABILITY, encoded(19)],
  ]);
  const backend = createExportIdentityKeychainBackend({ binding });
  assert.deepEqual(await backend.read(EXPORT_CAPABILITY), Buffer.alloc(32, 15));
  assert.deepEqual(await backend.read(ACCOUNT_CAPABILITY), Buffer.alloc(32, 16));
  assert.deepEqual(await backend.read(CLAUDE_CAPABILITY), Buffer.alloc(32, 18));
  assert.deepEqual(await backend.read(DEVICE_CAPABILITY), Buffer.alloc(32, 19));
  await backend.replaceExact(ACCOUNT_CAPABILITY, Buffer.alloc(32, 16), Buffer.alloc(32, 17));
  assert.deepEqual(await backend.read(EXPORT_CAPABILITY), Buffer.alloc(32, 15));
  assert.deepEqual(await backend.read(ACCOUNT_CAPABILITY), Buffer.alloc(32, 17));
  assert.deepEqual(await backend.read(CLAUDE_CAPABILITY), Buffer.alloc(32, 18));
  assert.deepEqual(await backend.read(DEVICE_CAPABILITY), Buffer.alloc(32, 19));
  await assert.rejects(
    backend.read({ ...EXPORT_CAPABILITY }),
    assertKeychainError("invalid_capability"),
  );
});

test("invalid inputs and native operation failures never disclose credentials or secrets", async () => {
  const secret = Buffer.alloc(32, 231);
  const secretCanary = secret.toString("base64url");
  const upstreamCanary = "DO-NOT-LEAK-keychain-upstream";
  const binding = memoryBinding();
  for (const method of ["getPassword", "setPassword", "deletePassword"]) {
    binding[method] = async (...args) => {
      throw new Error(`${upstreamCanary}:${args.join(":")}`);
    };
  }
  const backend = createExportIdentityKeychainBackend({ binding });
  for (const operation of [
    () => backend.read(EXPORT_CAPABILITY),
    () => backend.createIfMissing(EXPORT_CAPABILITY, secret),
    () => backend.replaceExact(EXPORT_CAPABILITY, secret, Buffer.alloc(32, 1)),
    () => backend.deleteExact(EXPORT_CAPABILITY, secret),
  ]) {
    await assert.rejects(operation(), (error) => {
      assertKeychainError("operation_failed")(error);
      const rendered = `${error.stack}\n${JSON.stringify(error)}`;
      for (const forbidden of [upstreamCanary, secretCanary, EXPORT_CAPABILITY.service, EXPORT_CAPABILITY.account]) {
        assert.equal(rendered.includes(forbidden), false);
      }
      return true;
    });
  }

  const safeBinding = memoryBinding();
  const safeBackend = createExportIdentityKeychainBackend({ binding: safeBinding });
  for (const invalid of [Buffer.alloc(31), Buffer.alloc(33), new Uint8Array(32), secretCanary]) {
    await assert.rejects(
      safeBackend.createIfMissing(EXPORT_CAPABILITY, invalid),
      assertKeychainError("invalid_secret"),
    );
  }
});

test("attribute delete constructs the exact security invocation and never needs the native binding", () => {
  // The repair path for a credential the ordinary backend cannot read: an
  // attribute-addressed delete never decrypts the item, so it works with a
  // broken access control list and even when keytar cannot load (both
  // observed live 2026-08-10).
  assert.deepEqual([...exportIdentityKeychainAttributeDeleteArguments(DEVICE_CAPABILITY)], [
    "delete-generic-password",
    "-s",
    "app-usagemonitor.contribution-device.v1",
    "-a",
    "installation",
  ]);
  const invocations = [];
  const outcome = deleteExportIdentityKeychainItemByAttributes(DEVICE_CAPABILITY, {
    platform: "darwin",
    runCommand: (command, commandArguments) => {
      invocations.push([command, commandArguments]);
      return { status: 0 };
    },
  });
  assert.equal(outcome, "deleted");
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0][0], "/usr/bin/security");
  assert.deepEqual(
    [...invocations[0][1]],
    [...exportIdentityKeychainAttributeDeleteArguments(DEVICE_CAPABILITY)],
  );
});

test("attribute delete reports an absent item honestly and fails closed on anything else", () => {
  const canary = "DO-NOT-LEAK-security-outcome";
  // errSecItemNotFound (exit 44) is the one non-zero status with a meaning:
  // there was nothing to delete.
  assert.equal(
    deleteExportIdentityKeychainItemByAttributes(DEVICE_CAPABILITY, {
      platform: "darwin",
      runCommand: () => ({ status: 44 }),
    }),
    "missing",
  );
  for (const runCommand of [
    () => ({ status: 1 }),
    () => ({ status: null }),
    () => null,
    () => "deleted",
    () => { throw new Error(canary); },
  ]) {
    assert.throws(
      () => deleteExportIdentityKeychainItemByAttributes(DEVICE_CAPABILITY, {
        platform: "darwin",
        runCommand,
      }),
      (error) => {
        assertKeychainError("operation_failed")(error);
        const rendered = `${error.stack}\n${JSON.stringify(error)}`;
        assert.equal(rendered.includes(canary), false);
        assert.equal(rendered.includes(DEVICE_CAPABILITY.service), false);
        return true;
      },
    );
  }
  assert.throws(
    () => deleteExportIdentityKeychainItemByAttributes({ ...DEVICE_CAPABILITY }, {
      platform: "darwin",
      runCommand: () => ({ status: 0 }),
    }),
    assertKeychainError("invalid_capability"),
  );
  assert.throws(
    () => deleteExportIdentityKeychainItemByAttributes(DEVICE_CAPABILITY, {
      platform: "linux",
      runCommand: () => ({ status: 0 }),
    }),
    assertKeychainError("unsupported_platform"),
  );
});

const READER_PATH =
  "/Applications/TiboTattle.app/Contents/Resources/runtime/bin/node";

test("the contribution-device reader requirement pins only the durable team and identifier", () => {
  assert.equal(CONTRIBUTION_DEVICE_READER_TEAM_IDENTIFIER, "43RTH622SB");
  assert.equal(CONTRIBUTION_DEVICE_READER_CODE_IDENTIFIER, "node");
  assert.equal(
    contributionDeviceReaderRequirement(),
    "anchor apple generic"
      + ' and certificate leaf[subject.OU] = "43RTH622SB"'
      + ' and identifier "node"',
  );
  assert.deepEqual(
    [...contributionDeviceReaderRequirementVerificationArguments(READER_PATH)],
    [
      "--verify",
      "--strict",
      `-R=${contributionDeviceReaderRequirement()}`,
      "--",
      READER_PATH,
    ],
  );
});

test("the durable add invocation binds the ACL to the reader path and rejects bad input", () => {
  const secret = Buffer.alloc(32, 5).toString("base64url");
  assert.deepEqual(
    [...contributionDeviceDurableAddArguments({
      service: "app-usagemonitor.contribution-device.v1",
      account: "installation",
      secret,
      readerPath: READER_PATH,
    })],
    [
      "add-generic-password",
      "-U",
      "-s",
      "app-usagemonitor.contribution-device.v1",
      "-a",
      "installation",
      "-T",
      READER_PATH,
      "-w",
      secret,
    ],
  );
  for (const bad of [
    { service: "", account: "installation", secret, readerPath: READER_PATH },
    { service: "svc", account: "installation", secret: "too-short", readerPath: READER_PATH },
    { service: "svc", account: "installation", secret, readerPath: "relative/node" },
    undefined,
  ]) {
    assert.throws(
      () => contributionDeviceDurableAddArguments(bad),
      assertKeychainError("invalid_configuration"),
    );
  }
});

test("a fresh contribution-device mint is written through the designated-requirement ACL", async () => {
  const binding = memoryBinding();
  const invocations = [];
  const runCommand = (command, commandArguments) => {
    const argv = [...commandArguments];
    invocations.push([command, argv]);
    // Simulate the security CLI writing the item that keytar then reads back.
    const service = argv[argv.indexOf("-s") + 1];
    const account = argv[argv.indexOf("-a") + 1];
    const secret = argv[argv.indexOf("-w") + 1];
    binding.values.set(credentialKey(service, account), secret);
    return { status: 0 };
  };
  const backend = createExportIdentityKeychainBackend({
    binding,
    durableAccess: { platform: "darwin", readerPath: READER_PATH, runCommand },
  });
  const outcome = await backend.createIfMissing(DEVICE_CAPABILITY, Buffer.alloc(32, 5));
  assert.equal(outcome, "created");
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0][0], "/usr/bin/security");
  assert.deepEqual(invocations[0][1], [
    "add-generic-password",
    "-U",
    "-s",
    "app-usagemonitor.contribution-device.v1",
    "-a",
    "installation",
    "-T",
    READER_PATH,
    "-w",
    Buffer.alloc(32, 5).toString("base64url"),
  ]);
  // keytar never wrote the value; the durable CLI mint did.
  assert.equal(binding.calls.some(([method]) => method === "setPassword"), false);
  assert.deepEqual(await backend.read(DEVICE_CAPABILITY), Buffer.alloc(32, 5));
});

test("a failed durable mint falls back to keytar so availability never regresses", async () => {
  const binding = memoryBinding();
  const backend = createExportIdentityKeychainBackend({
    binding,
    durableAccess: {
      platform: "darwin",
      readerPath: READER_PATH,
      runCommand: () => ({ status: 1 }),
    },
  });
  const outcome = await backend.createIfMissing(DEVICE_CAPABILITY, Buffer.alloc(32, 9));
  assert.equal(outcome, "created");
  // The CLI mint reported failure, so keytar's default path created the item.
  assert.equal(binding.calls.some(([method]) => method === "setPassword"), true);
  assert.deepEqual(await backend.read(DEVICE_CAPABILITY), Buffer.alloc(32, 9));
});

test("durable access applies to the contribution-device capability only, and only on darwin", async () => {
  // Other capabilities keep using keytar even when durable access is configured.
  const bindingA = memoryBinding();
  let ran = 0;
  const backendA = createExportIdentityKeychainBackend({
    binding: bindingA,
    durableAccess: {
      platform: "darwin",
      readerPath: READER_PATH,
      runCommand: () => { ran += 1; return { status: 0 }; },
    },
  });
  assert.equal(await backendA.createIfMissing(EXPORT_CAPABILITY, Buffer.alloc(32, 3)), "created");
  assert.equal(ran, 0, "the security CLI is never used for the export identity");
  assert.equal(bindingA.calls.some(([method]) => method === "setPassword"), true);

  // A non-darwin platform makes durable access inert; keytar is used.
  const bindingB = memoryBinding();
  const backendB = createExportIdentityKeychainBackend({
    binding: bindingB,
    durableAccess: {
      platform: "linux",
      readerPath: READER_PATH,
      runCommand: () => { throw new Error("must not run off darwin"); },
    },
  });
  assert.equal(await backendB.createIfMissing(DEVICE_CAPABILITY, Buffer.alloc(32, 4)), "created");
  assert.equal(bindingB.calls.some(([method]) => method === "setPassword"), true);
});
