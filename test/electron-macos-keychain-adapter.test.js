import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  MACOS_KEYCHAIN_ADAPTER_ARCHITECTURES,
  MACOS_KEYCHAIN_ADAPTER_CLANG_ARCHITECTURES,
  MACOS_KEYCHAIN_ADAPTER_MINIMUM_MACOS,
  MACOS_KEYCHAIN_ADAPTER_NODE_INCLUDE,
  MACOS_KEYCHAIN_ADAPTER_SOURCE,
  compileMacOSKeychainAdapter,
  macOSKeychainAdapterClangArchitecture,
  macOSKeychainAdapterCompilerArguments,
} from "../scripts/build-electron-macos-keychain-adapter.mjs";
import {
  MACOS_KEYCHAIN_ADAPTER_CAPABILITIES,
  MACOS_KEYCHAIN_ADAPTER_CONTRACT_VERSION,
  MacOSKeychainAdapterContractError,
  createMacOSKeychainAdapterFacade,
  isMacOSKeychainAdapterContractError,
} from "../native/macos-keychain/contract.js";

const nativeRequire = createRequire(import.meta.url);

function binding(overrides = {}) {
  return {
    capabilities: [...MACOS_KEYCHAIN_ADAPTER_CAPABILITIES],
    contractVersion: MACOS_KEYCHAIN_ADAPTER_CONTRACT_VERSION,
    identityStatus: () => "valid",
    inspect: async () => "absent",
    read: async () => ({ status: "absent", value: null }),
    store: async () => "stored",
    remove: async () => "deleted",
    createIfMissing: async () => "created",
    deleteExact: async () => "deleted",
    ...overrides,
  };
}

test("macOS Keychain adapter facade preserves its closed Promise contract", async () => {
  let inspected = false;
  const facade = createMacOSKeychainAdapterFacade(binding({
    inspect: async (capability) => {
      inspected = capability === "export_identity";
      return "locked";
    },
    remove: async () => "absent",
  }));

  assert.equal(facade.identityStatus(), "valid");
  const pending = facade.inspect("export_identity");
  assert.equal(typeof pending.then, "function");
  assert.equal(await pending, "locked");
  assert.equal(inspected, true);
  assert.equal(await facade.remove("contribution_device"), "absent");
  assert.equal(await facade.createIfMissing(
    "accountless_installation",
    Buffer.alloc(32, 5),
  ), "created");
  await assert.rejects(
    facade.inspect("arbitrary_service"),
    (error) => isMacOSKeychainAdapterContractError(error)
      && error.code === "macos_keychain_adapter_invalid_capability",
  );
});

test("macOS Keychain adapter facade preserves migration-required outcomes", async () => {
  const facade = createMacOSKeychainAdapterFacade(binding({
    inspect: async () => "migration_required",
    read: async () => ({ status: "migration_required", value: null }),
    store: async () => "migration_required",
  }));

  assert.equal(await facade.inspect("export_identity"), "migration_required");
  assert.deepEqual(await facade.read("export_identity"), {
    status: "migration_required",
    value: null,
  });
  assert.equal(await facade.store("export_identity", Buffer.alloc(32, 7)),
    "migration_required");
});

test("macOS Keychain adapter facade copies and clears native boundary secrets", async () => {
  const rawRead = Buffer.alloc(32, 23);
  let nativeStoreInput;
  const facade = createMacOSKeychainAdapterFacade(binding({
    read: async () => ({ status: "present", value: rawRead }),
    store: async (_capability, secret) => {
      nativeStoreInput = secret;
      return "stored";
    },
  }));
  const callerSecret = Buffer.alloc(32, 91);

  const read = await facade.read("account_observation");
  assert.equal(read.status, "present");
  assert.deepEqual(read.value, Buffer.alloc(32, 23));
  assert.deepEqual(rawRead, Buffer.alloc(32));

  assert.equal(await facade.store("account_observation", callerSecret), "stored");
  assert.deepEqual(nativeStoreInput, Buffer.alloc(32));
  assert.deepEqual(callerSecret, Buffer.alloc(32, 91));

  await assert.rejects(
    facade.createIfMissing("contribution_device", Buffer.alloc(32, 4)),
    (error) => isMacOSKeychainAdapterContractError(error)
      && error.code === "macos_keychain_adapter_invalid_capability",
  );
  await assert.rejects(
    facade.store("accountless_installation", Buffer.alloc(32, 4)),
    (error) => isMacOSKeychainAdapterContractError(error)
      && error.code === "macos_keychain_adapter_invalid_capability",
  );
  await assert.rejects(
    facade.remove("accountless_installation"),
    (error) => isMacOSKeychainAdapterContractError(error)
      && error.code === "macos_keychain_adapter_invalid_capability",
  );
});

test("macOS Keychain adapter facade refuses synchronous or malformed native replies", async () => {
  const synchronous = createMacOSKeychainAdapterFacade(binding({
    inspect: () => "present",
  }));
  await assert.rejects(
    synchronous.inspect("export_identity"),
    (error) => isMacOSKeychainAdapterContractError(error)
      && error.code === "macos_keychain_adapter_non_async_response",
  );

  const malformed = createMacOSKeychainAdapterFacade(binding({
    read: async () => ({ status: "present", value: Buffer.alloc(31) }),
  }));
  await assert.rejects(
    malformed.read("export_identity"),
    (error) => error instanceof MacOSKeychainAdapterContractError
      && error.code === "macos_keychain_adapter_invalid_response",
  );

  assert.throws(
    () => createMacOSKeychainAdapterFacade({}),
    (error) => error instanceof MacOSKeychainAdapterContractError
      && error.code === "macos_keychain_adapter_invalid_binding",
  );
});

test("macOS Keychain adapter compiler maps both Electron architectures exactly", () => {
  assert.deepEqual(MACOS_KEYCHAIN_ADAPTER_ARCHITECTURES, ["arm64", "x64"]);
  assert.deepEqual(MACOS_KEYCHAIN_ADAPTER_CLANG_ARCHITECTURES, {
    arm64: "arm64",
    x64: "x86_64",
  });
  assert.equal(macOSKeychainAdapterClangArchitecture("arm64"), "arm64");
  assert.equal(macOSKeychainAdapterClangArchitecture("x64"), "x86_64");
  assert.throws(() => macOSKeychainAdapterClangArchitecture("ia32"),
    (error) => error?.code === "macos_keychain_adapter_invalid_architecture");

  for (const architecture of MACOS_KEYCHAIN_ADAPTER_ARCHITECTURES) {
    const output = resolve(tmpdir(), `macos-keychain-${architecture}.node`);
    const argumentsList = macOSKeychainAdapterCompilerArguments({
      output,
      architecture,
      nodeIncludeDirectory: MACOS_KEYCHAIN_ADAPTER_NODE_INCLUDE,
    });
    assert.deepEqual(argumentsList.slice(0, 3), ["--sdk", "macosx", "clang++"]);
    assert.equal(argumentsList.includes("-arch"), true);
    assert.equal(argumentsList[argumentsList.indexOf("-arch") + 1],
      MACOS_KEYCHAIN_ADAPTER_CLANG_ARCHITECTURES[architecture]);
    assert.equal(argumentsList.includes(`-mmacosx-version-min=${MACOS_KEYCHAIN_ADAPTER_MINIMUM_MACOS}`), true);
    assert.equal(argumentsList.includes("-bundle"), true);
    assert.equal(argumentsList.includes("dynamic_lookup"), true);
    assert.equal(argumentsList.includes(MACOS_KEYCHAIN_ADAPTER_SOURCE), true);
  }
});

test("macOS Keychain adapter source retains the fixed, prompt-free modern policy", async () => {
  const [source, bindingGyp, searchScopePolicy] = await Promise.all([
    readFile(MACOS_KEYCHAIN_ADAPTER_SOURCE, "utf8"),
    readFile(new URL("../native/macos-keychain/binding.gyp", import.meta.url), "utf8"),
    readFile(new URL("../native/macos-keychain/search-scope-policy.h", import.meta.url), "utf8"),
  ]);

  for (const service of [
    "app-usagemonitor.export-identity.app.v1",
    "app-usagemonitor.account-observation.app.v1",
    "app-usagemonitor.claude-session-pseudonym.app.v1",
    "app-usagemonitor.contribution-device.app.v1",
    "app-usagemonitor.accountless-installation.app.v1",
  ]) {
    assert.equal(source.includes(service), true);
  }
  for (const legacyService of [
    "app-usagemonitor.export-identity.v1",
    "app-usagemonitor.account-observation.v1",
    "app-usagemonitor.claude-session-pseudonym.v1",
    "app-usagemonitor.contribution-device.v1",
    "app-usagemonitor.accountless-installation.v1",
  ]) {
    assert.equal(source.includes(legacyService), true);
  }
  assert.match(source, /SecKeychainSetUserInteractionAllowed\(false\)/u);
  assert.match(source, /SecKeychainCopyDefault\(/u);
  assert.match(source, /SecKeychainCopySearchList\(/u);
  assert.match(source, /CFDictionarySetValue\(query, kSecMatchSearchList, search_scope\)/u);
  assert.match(source, /SecKeychainGetStatus\(/u);
  assert.match(source, /SecKeychainGetPath\(/u);
  assert.match(source, /ClassifySearchScopeMemberForAbsence/u);
  assert.match(source, /kSecUnlockStateStatus/u);
  assert.match(searchScopePolicy, /if \(!readable\) return SearchScopeMemberStatus::kDenied/u);
  assert.match(source, /CFDictionarySetValue\(attributes, kSecUseKeychain, destination_keychain\)/u);
  assert.match(source, /SecTrustedApplicationCreateFromPath\(nullptr/u);
  assert.match(source, /SecAccessCreate\(/u);
  assert.match(source, /SecRequirementCreateWithString\(/u);
  assert.match(source, /SecCodeCheckValidity\(/u);
  assert.match(source, /napi_create_async_work\(/u);
  const legacyProbe = source.slice(
    source.indexOf("ItemStatus ItemPresenceNoInteraction"),
    source.indexOf("ItemStatus ResultAfterLegacyPresenceProbeNoInteraction"),
  );
  assert.match(legacyProbe, /kSecReturnAttributes/u);
  assert.doesNotMatch(legacyProbe, /kSecReturnData/u);
  assert.equal((source.match(/ItemPresenceNoInteraction\(capability, search_scope, true\)/gu) ?? []).length, 1);
  const readImplementation = source.slice(
    source.indexOf("ReadResult ReadModernSecret"),
    source.indexOf("ItemStatus InspectModernSecret"),
  );
  assert.ok(readImplementation.indexOf("if (status == errSecItemNotFound)")
    < readImplementation.indexOf("SearchScopeStatusForAbsenceNoInteraction"),
  "a successful modern read must not be refused because another keychain is locked");
  assert.match(readImplementation, /BaseQuery\(capability, false, search_scope.value\)/u);
  const storeImplementation = source.slice(
    source.indexOf("ItemStatus StoreModernSecret"),
    source.indexOf("ItemStatus RemoveModernSecret"),
  );
  assert.ok(storeImplementation.indexOf("ResultAfterLegacyPresenceProbeNoInteraction")
    < storeImplementation.indexOf("StoreAttributes"));
  assert.match(storeImplementation, /\bSecItemUpdate\s*\(/u);
  assert.doesNotMatch(storeImplementation, /\bSecItemDelete\s*\(/u);
  const removeImplementation = source.slice(
    source.indexOf("ItemStatus RemoveModernSecret"),
    source.indexOf("ConditionalStatus CreateModernSecretIfMissing"),
  );
  assert.match(removeImplementation, /\bSecItemDelete\s*\(/u);
  const createIfMissingImplementation = source.slice(
    source.indexOf("ConditionalStatus CreateModernSecretIfMissing"),
    source.indexOf("ConditionalStatus DeleteModernSecretExact"),
  );
  assert.match(createIfMissingImplementation, /\bSecItemAdd\s*\(/u);
  assert.match(createIfMissingImplementation, /errSecDuplicateItem/u);
  assert.doesNotMatch(createIfMissingImplementation, /\bSecItemUpdate\s*\(/u);
  assert.doesNotMatch(createIfMissingImplementation, /\bSecItemDelete\s*\(/u);
  const deleteExactImplementation = source.slice(
    source.indexOf("ConditionalStatus DeleteModernSecretExact"),
    source.indexOf("struct OperationContext"),
  );
  assert.match(deleteExactImplementation, /kSecReturnPersistentRef/u);
  assert.match(deleteExactImplementation, /kSecValuePersistentRef/u);
  assert.match(deleteExactImplementation, /\bSecItemDelete\s*\(/u);
  const storeCallback = source.slice(
    source.indexOf("napi_value StoreCallback"),
    source.indexOf("napi_value RemoveCallback"),
  );
  const removeCallback = source.slice(
    source.indexOf("napi_value RemoveCallback"),
    source.indexOf("napi_value CreateIfMissingCallback"),
  );
  assert.match(storeCallback, /IsAccountlessInstallationCapability/u);
  assert.match(removeCallback, /IsAccountlessInstallationCapability/u);
  assert.match(bindingGyp, /"macos-keychain\.mm"/u);
  assert.match(bindingGyp, /"NAPI_VERSION=8"/u);
});

test("macOS Keychain adapter compiles both architectures without loading Keychain data", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "macos-keychain-adapter-test-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });

  const outputs = new Map();
  for (const architecture of MACOS_KEYCHAIN_ADAPTER_ARCHITECTURES) {
    const output = join(directory, `${architecture}.node`);
    assert.equal(await compileMacOSKeychainAdapter({ output, architecture }), output);
    assert.ok((await stat(output)).size > 0);
    outputs.set(architecture, output);
  }

  // Module initialization exposes only constants and functions. It does not
  // invoke identityStatus or any Security/Keychain operation.
  const loaded = nativeRequire(outputs.get(process.arch));
  assert.deepEqual(Object.keys(loaded).sort(), [
    "capabilities",
    "contractVersion",
    "createIfMissing",
    "deleteExact",
    "identityStatus",
    "inspect",
    "read",
    "remove",
    "store",
  ]);
  assert.equal(loaded.contractVersion, MACOS_KEYCHAIN_ADAPTER_CONTRACT_VERSION);
  assert.deepEqual(loaded.capabilities, [...MACOS_KEYCHAIN_ADAPTER_CAPABILITIES]);
});
