import assert from "node:assert/strict";
import { isProxy } from "node:util/types";
import test from "node:test";

import {
  WINDOWS_PRODUCTION_AUTHORITY_APP_ID,
  WINDOWS_PRODUCTION_AUTHORITY_ARCHITECTURE,
  WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_EVENT,
  WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
  WINDOWS_PRODUCTION_AUTHORITY_HANDOFF_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS,
  WINDOWS_PRODUCTION_AUTHORITY_MAXIMUM_OBJECT_GRAPH_DEPTH,
  WINDOWS_PRODUCTION_AUTHORITY_MAXIMUM_OBJECT_GRAPH_NODES,
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_STATUS,
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_TARGET,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_NAME,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_PATH,
  WINDOWS_PRODUCTION_AUTHORITY_PLATFORM,
  WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
  WINDOWS_PRODUCTION_AUTHORITY_PRODUCT,
  WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
  WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW,
  WINDOWS_PRODUCTION_AUTHORITY_UNAVAILABLE_CAPABILITIES,
  WINDOWS_PRODUCTION_AUTHORITY_PROMOTED_CAPABILITIES,
  buildWindowsProductionAuthorityManifest,
  createWindowsProductionAuthorityManifest,
  parseWindowsProductionAuthorityManifest,
  serializeWindowsProductionAuthorityManifest,
  validateWindowsProductionAuthorityManifest,
  WindowsProductionAuthorityManifestError,
} from "../src/platform/windows-production-authority-manifest.js";

const REVISION = "a".repeat(40);
const HANDOFF_SHA = "b".repeat(64);
const WARM_RECEIPT_SHA = "c".repeat(64);
const CLEAN_RECEIPT_SHA = "d".repeat(64);
const WARM_ARTIFACT_DIGEST = `sha256:${WARM_RECEIPT_SHA}`;
const CLEAN_ARTIFACT_DIGEST = `sha256:${CLEAN_RECEIPT_SHA}`;
const BINDING_BYTES = 1234;
const BINDING_SHA = "e".repeat(64);
const NATIVE_PRESIGN_RECEIPT_SHA = "6".repeat(64);
const SOURCE_PACKAGE_BYTES = 12949;
const SOURCE_PACKAGE_SHA = "7".repeat(64);

function fixture(overrides = {}) {
  const base = {
    schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA,
    status: WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS,
    product: WINDOWS_PRODUCTION_AUTHORITY_PRODUCT,
    appId: WINDOWS_PRODUCTION_AUTHORITY_APP_ID,
    packageVersion: "0.1.15",
    platform: WINDOWS_PRODUCTION_AUTHORITY_PLATFORM,
    architecture: WINDOWS_PRODUCTION_AUTHORITY_ARCHITECTURE,
    repository: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
    sourceRevision: REVISION,
    sourcePackage: {
      path: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_PATH,
      name: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_NAME,
      version: "0.1.15",
      revision: REVISION,
      bytes: SOURCE_PACKAGE_BYTES,
      sha256: SOURCE_PACKAGE_SHA,
    },
    sourceQualification: {
      workflow: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW,
      run: 123456789,
      runAttempt: 2,
      ref: "refs/heads/main",
      revision: REVISION,
      handoff: {
        schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_HANDOFF_SCHEMA,
        sha256: HANDOFF_SHA,
      },
      binding: {
        bytes: BINDING_BYTES,
        sha256: BINDING_SHA,
      },
      receipts: [
        {
          cacheMode: "warm",
          run: 123456789,
          runAttempt: 2,
          revision: REVISION,
          artifactId: 111,
          artifactDigest: WARM_ARTIFACT_DIGEST,
          rawReceiptSha256: WARM_RECEIPT_SHA,
        },
        {
          cacheMode: "clean",
          run: 123456789,
          runAttempt: 2,
          revision: REVISION,
          artifactId: 222,
          artifactDigest: CLEAN_ARTIFACT_DIGEST,
          rawReceiptSha256: CLEAN_RECEIPT_SHA,
        },
      ],
    },
    finalizer: {
      workflow: WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
      repository: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
      run: 987654321,
      runAttempt: 1,
      ref: WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
      event: WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_EVENT,
      headSha: REVISION,
      sourceRevision: REVISION,
    },
    nativeModules: [
      {
        name: "windows-filesystem",
        packagedPath: "native/windows-filesystem/build/Release/windows_filesystem.node",
        unsignedBytes: BINDING_BYTES,
        signedBytes: 100002,
        unsignedSha256: BINDING_SHA,
        signedSha256: "2".repeat(64),
      },
      {
        name: "keytar",
        packagedPath: "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
        unsignedBytes: 200002,
        signedBytes: 200003,
        unsignedSha256: "3".repeat(64),
        signedSha256: "4".repeat(64),
      },
    ],
    nativePresign: {
      receiptSha256: NATIVE_PRESIGN_RECEIPT_SHA,
      schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_SCHEMA,
      status: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_STATUS,
      target: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_TARGET,
      revision: REVISION,
      packageVersion: "0.1.15",
      qualificationHandoffSha256: HANDOFF_SHA,
    },
    runtimeManifest: {
      packagedPath: WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
      bytes: 300003,
      sha256: "5".repeat(64),
    },
    signerPolicy: {
      publisher: "CN=TiboTattle Test",
      match: "exact",
    },
    promotedCapabilities: [...WINDOWS_PRODUCTION_AUTHORITY_PROMOTED_CAPABILITIES],
    unavailableCapabilities: [...WINDOWS_PRODUCTION_AUTHORITY_UNAVAILABLE_CAPABILITIES],
  };
  return merge(base, overrides);
}

function merge(base, overrides) {
  const result = { ...base, ...overrides };
  for (const key of ["sourceQualification", "sourcePackage", "finalizer", "runtimeManifest", "signerPolicy"]) {
    if (overrides[key]) result[key] = { ...base[key], ...overrides[key] };
  }
  if (overrides.sourceQualification?.handoff) {
    result.sourceQualification.handoff = {
      ...base.sourceQualification.handoff,
      ...overrides.sourceQualification.handoff,
    };
  }
  if (overrides.sourceQualification?.binding) {
    result.sourceQualification.binding = {
      ...base.sourceQualification.binding,
      ...overrides.sourceQualification.binding,
    };
  }
  if (overrides.sourceQualification?.receipts) {
    result.sourceQualification.receipts = overrides.sourceQualification.receipts;
  }
  if (overrides.nativeModules) result.nativeModules = overrides.nativeModules;
  if (overrides.nativePresign) {
    result.nativePresign = { ...base.nativePresign, ...overrides.nativePresign };
  }
  return result;
}

function invalid(value, code = null) {
  assert.throws(
    () => validateWindowsProductionAuthorityManifest(value),
    (error) => {
      assert.equal(error instanceof WindowsProductionAuthorityManifestError, true);
      if (code !== null) assert.equal(error.code, `windows_production_authority_manifest_${code}`);
      return true;
    },
  );
}

test("builds a frozen content-free Windows authority snapshot", () => {
  const source = fixture();
  const manifest = createWindowsProductionAuthorityManifest(source);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.sourceQualification), true);
  assert.equal(Object.isFrozen(manifest.sourceQualification.receipts), true);
  assert.equal(Object.isFrozen(manifest.nativeModules[0]), true);
  assert.equal(Object.isFrozen(manifest.sourcePackage), true);
  assert.equal(Object.isFrozen(manifest.nativePresign), true);
  assert.deepEqual(manifest.sourceQualification.binding, {
    bytes: BINDING_BYTES,
    sha256: BINDING_SHA,
  });
  assert.deepEqual(manifest.sourcePackage, {
    path: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_PATH,
    name: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_NAME,
    version: "0.1.15",
    revision: REVISION,
    bytes: SOURCE_PACKAGE_BYTES,
    sha256: SOURCE_PACKAGE_SHA,
  });
  assert.equal(manifest.nativeModules[0].unsignedBytes, BINDING_BYTES);
  assert.equal(Object.hasOwn(manifest.nativeModules[0], "bytes"), false);
  assert.equal(Object.hasOwn(manifest.finalizer, "status"), false);
  assert.equal(Object.hasOwn(manifest.finalizer, "conclusion"), false);
  assert.equal(Object.hasOwn(manifest, "authority"), false);
  assert.equal(Object.hasOwn(manifest, "brand"), false);
  assert.equal(Object.values(manifest).some((value) => typeof value === "boolean"), false);
  assert.notEqual(manifest, source);
  assert.notEqual(manifest.nativeModules, source.nativeModules);
  assert.deepEqual(manifest, fixture());
});

test("binds source package identity and raw bytes to the authority revision", () => {
  const manifest = createWindowsProductionAuthorityManifest(fixture());
  assert.equal(manifest.sourcePackage.revision, manifest.sourceRevision);
  assert.equal(manifest.sourcePackage.version, manifest.packageVersion);

  for (const [field, value, code] of [
    ["path", "other.json", "mismatch"],
    ["name", "other-product", "mismatch"],
    ["version", "0.1.16", "mismatch"],
    ["revision", "f".repeat(40), "mismatch"],
    ["bytes", 0, "invalid"],
    ["bytes", 64 * 1024 + 1, "invalid"],
    ["sha256", "z".repeat(64), "invalid"],
  ]) {
    invalid(fixture({ sourcePackage: { [field]: value } }), code);
  }

  const extra = fixture();
  extra.sourcePackage.extra = "no";
  invalid(extra, "invalid");

  const missing = fixture();
  delete missing.sourcePackage.sha256;
  invalid(missing, "invalid");
});

test("binds the native presign receipt hash and provenance identity exactly", () => {
  const manifest = createWindowsProductionAuthorityManifest(fixture());
  assert.deepEqual(manifest.nativePresign, {
    receiptSha256: NATIVE_PRESIGN_RECEIPT_SHA,
    schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_SCHEMA,
    status: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_STATUS,
    target: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_TARGET,
    revision: REVISION,
    packageVersion: "0.1.15",
    qualificationHandoffSha256: HANDOFF_SHA,
  });

  for (const [field, value, code] of [
    ["receiptSha256", "z".repeat(64), "invalid"],
    ["schemaVersion", "tibotattle-windows-native-presign-v2", "mismatch"],
    ["status", "WINDOWS_NATIVE_PRESIGN_INPUT_INVALID", "mismatch"],
    ["target", "linux-x64", "mismatch"],
    ["revision", "f".repeat(40), "mismatch"],
    ["packageVersion", "0.1.16", "mismatch"],
    ["qualificationHandoffSha256", "f".repeat(64), "mismatch"],
  ]) {
    invalid(fixture({ nativePresign: { [field]: value } }), code);
  }

  const extra = fixture();
  extra.nativePresign.extra = "no";
  invalid(extra, "invalid");

  const missing = fixture();
  delete missing.nativePresign.receiptSha256;
  invalid(missing, "invalid");
});

test("supports the explicit generator aliases without minting authority", () => {
  const source = fixture();
  assert.deepEqual(buildWindowsProductionAuthorityManifest(source), createWindowsProductionAuthorityManifest(source));
  assert.equal(isProxy(createWindowsProductionAuthorityManifest(source)), false);
});

test("canonical serialization and JSON round trip are deterministic", () => {
  const first = createWindowsProductionAuthorityManifest(fixture());
  const reordered = JSON.parse(JSON.stringify(first, (key, value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).reverse());
  }));
  const serialized = serializeWindowsProductionAuthorityManifest(first);
  assert.equal(serialized, serializeWindowsProductionAuthorityManifest(reordered));
  const parsed = parseWindowsProductionAuthorityManifest(serialized);
  assert.deepEqual(parsed, first);
  assert.equal(serializeWindowsProductionAuthorityManifest(parsed), serialized);
  assert.deepEqual(parseWindowsProductionAuthorityManifest(`${serialized} `), first);
});

test("rejects extra or missing keys at every schema level", () => {
  invalid({ ...fixture(), unexpected: "field" });
  const missing = fixture();
  delete missing.finalizer;
  invalid(missing);
  const missingNested = fixture();
  delete missingNested.signerPolicy.match;
  invalid(missingNested);
  const nested = fixture();
  nested.sourceQualification.handoff.extra = "no";
  invalid(nested);
});

test("rejects accessors, proxies, symbols, and inherited objects", () => {
  const accessor = fixture();
  Object.defineProperty(accessor, "packageVersion", {
    enumerable: true,
    get() {
      return "0.1.15";
    },
  });
  invalid(accessor, "unsafe");

  const proxied = new Proxy(fixture(), {});
  invalid(proxied, "unsafe");

  const symbolized = fixture();
  symbolized[Symbol("secret")] = "no";
  invalid(symbolized, "unsafe");

  const inherited = Object.create({ packageVersion: "0.1.15" });
  Object.assign(inherited, fixture());
  invalid(inherited, "unsafe");

  const nestedAccessor = fixture();
  Object.defineProperty(nestedAccessor.nativeModules[0], "bytes", {
    enumerable: true,
    get() {
      return 100001;
    },
  });
  invalid(nestedAccessor, "unsafe");

  const cyclic = fixture();
  cyclic.sourceQualification.receipts[0].revision = cyclic.sourceQualification;
  invalid(cyclic, "unsafe");
});

test("rejects object graphs beyond the bounded unsafe traversal", () => {
  const deep = {};
  let cursor = deep;
  for (let index = 0; index <= WINDOWS_PRODUCTION_AUTHORITY_MAXIMUM_OBJECT_GRAPH_DEPTH; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  invalid(deep, "unsafe");

  const wide = [];
  for (let index = 0; index <= WINDOWS_PRODUCTION_AUTHORITY_MAXIMUM_OBJECT_GRAPH_NODES; index += 1) {
    wide.push({});
  }
  invalid(wide, "unsafe");
});

test("rejects unsafe paths and invalid numeric/version/ref/hash values", () => {
  for (const packagedPath of [
    "../native/windows-filesystem/build/Release/windows_filesystem.node",
    "native\\windows-filesystem\\build\\Release\\windows_filesystem.node",
    "/absolute/native.node",
    "C:/native.node",
  ]) {
    invalid(fixture({
      nativeModules: [
        { ...fixture().nativeModules[0], packagedPath },
        fixture().nativeModules[1],
      ],
    }), "unsafe");
  }
  for (const packageVersion of ["1.2", "01.2.3", "1.2.3-beta", 1.2]) {
    invalid(fixture({ packageVersion }), "invalid");
  }
  invalid(fixture({ sourceRevision: "A".repeat(40) }), "invalid");
  invalid(fixture({ finalizer: { sourceRevision: "b".repeat(40) } }), "mismatch");
  invalid(fixture({ sourceQualification: { ref: "refs/heads/../main" } }), "invalid");
  invalid(fixture({ sourceQualification: { ref: "refs/heads/main..candidate" } }), "invalid");
  invalid(fixture({ runtimeManifest: { bytes: 0 } }), "invalid");
  invalid(fixture({ runtimeManifest: { sha256: "z".repeat(64) } }), "invalid");
  invalid(fixture({
    sourceQualification: {
      handoff: { sha256: "0".repeat(63) },
    },
  }), "invalid");
  invalid(fixture({
    sourceQualification: {
      binding: { sha256: "0".repeat(63) },
    },
  }), "invalid");
  invalid(fixture({ finalizer: { run: 123456789 } }), "mismatch");
});

test("requires exactly the qualified native pair and signed bytes to differ", () => {
  const duplicateName = fixture();
  duplicateName.nativeModules = [
    duplicateName.nativeModules[0],
    { ...duplicateName.nativeModules[1], name: "windows-filesystem", packagedPath: duplicateName.nativeModules[0].packagedPath },
  ];
  invalid(duplicateName, "duplicate");

  const duplicatePath = fixture();
  duplicatePath.nativeModules = [
    duplicatePath.nativeModules[0],
    {
      ...duplicatePath.nativeModules[1],
      packagedPath: duplicatePath.nativeModules[0].packagedPath,
    },
  ];
  invalid(duplicatePath, "mismatch");

  const sameHash = fixture();
  sameHash.nativeModules = [
    { ...sameHash.nativeModules[0], signedSha256: sameHash.nativeModules[0].unsignedSha256 },
    sameHash.nativeModules[1],
  ];
  invalid(sameHash, "mismatch");

  const bindingMismatch = fixture({
    sourceQualification: { binding: { bytes: BINDING_BYTES + 1 } },
  });
  invalid(bindingMismatch, "mismatch");

  const bindingHashMismatch = fixture({
    sourceQualification: { binding: { sha256: "f".repeat(64) } },
  });
  invalid(bindingHashMismatch, "mismatch");

  const nativeUnsignedHashMismatch = fixture();
  nativeUnsignedHashMismatch.nativeModules[0].unsignedSha256 = "f".repeat(64);
  invalid(nativeUnsignedHashMismatch, "mismatch");

  const ambiguousBytes = fixture();
  ambiguousBytes.nativeModules[0].bytes = BINDING_BYTES;
  invalid(ambiguousBytes, "invalid");

  const missingModule = fixture({ nativeModules: [fixture().nativeModules[0]] });
  invalid(missingModule, "invalid");
});

test("binds warm and clean receipts to the exact source run and keeps all identities distinct", () => {
  const wrongRun = fixture();
  wrongRun.sourceQualification.receipts[1] = {
    ...wrongRun.sourceQualification.receipts[1],
    run: 999,
  };
  invalid(wrongRun, "mismatch");

  const duplicateArtifact = fixture();
  duplicateArtifact.sourceQualification.receipts[1] = {
    ...duplicateArtifact.sourceQualification.receipts[1],
    artifactId: duplicateArtifact.sourceQualification.receipts[0].artifactId,
  };
  invalid(duplicateArtifact, "duplicate");

  const duplicateDigest = fixture();
  duplicateDigest.sourceQualification.receipts[1] = {
    ...duplicateDigest.sourceQualification.receipts[1],
    artifactDigest: duplicateDigest.sourceQualification.receipts[0].artifactDigest,
    rawReceiptSha256: duplicateDigest.sourceQualification.receipts[0].rawReceiptSha256,
  };
  invalid(duplicateDigest, "duplicate");

  const duplicateRawHash = fixture();
  duplicateRawHash.sourceQualification.receipts[1] = {
    ...duplicateRawHash.sourceQualification.receipts[1],
    artifactDigest: duplicateRawHash.sourceQualification.receipts[0].artifactDigest,
    rawReceiptSha256: duplicateRawHash.sourceQualification.receipts[0].rawReceiptSha256,
  };
  invalid(duplicateRawHash, "duplicate");

  const artifactDigestMismatch = fixture();
  artifactDigestMismatch.sourceQualification.receipts[0] = {
    ...artifactDigestMismatch.sourceQualification.receipts[0],
    artifactDigest: `sha256:${"a".repeat(64)}`,
  };
  invalid(artifactDigestMismatch, "mismatch");

  const reversed = fixture();
  reversed.sourceQualification.receipts.reverse();
  invalid(reversed, "invalid");
});

test("enforces the production finalizer workflow, repository, and run binding", () => {
  for (const [field, value] of [
    ["workflow", WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW],
    ["repository", "someone-else/tibotattle"],
    ["ref", "refs/heads/release"],
    ["event", "push"],
    ["headSha", "b".repeat(40)],
    ["sourceRevision", "b".repeat(40)],
  ]) {
    invalid(fixture({ finalizer: { [field]: value } }), "mismatch");
  }
  invalid(fixture({ finalizer: { status: "completed" } }), "invalid");
  invalid(fixture({ finalizer: { conclusion: "success" } }), "invalid");
});

test("does not promote capabilities outside the explicit local Windows surface", () => {
  const altered = fixture({
    promotedCapabilities: [...WINDOWS_PRODUCTION_AUTHORITY_PROMOTED_CAPABILITIES, "updater"],
  });
  invalid(altered, "mismatch");
  const missingUnavailable = fixture({
    unavailableCapabilities: WINDOWS_PRODUCTION_AUTHORITY_UNAVAILABLE_CAPABILITIES.slice(0, 2),
  });
  invalid(missingUnavailable, "mismatch");
  const booleans = fixture({ promotedCapabilities: [true, false, false] });
  invalid(booleans, "mismatch");
});
