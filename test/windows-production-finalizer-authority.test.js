import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS,
  WindowsProductionFinalizerAuthorityError,
  buildWindowsProductionFinalizerAuthority,
} from "../scripts/build-windows-production-finalizer-authority.mjs";
import {
  WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
  WINDOWS_NATIVE_PRESIGN_MODULES,
  WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY,
  WINDOWS_NATIVE_PRESIGN_SCHEMA,
  WINDOWS_NATIVE_PRESIGN_STATUS,
  WINDOWS_NATIVE_PRESIGN_TARGET,
  serializeWindowsNativePresignReceipt,
} from "../scripts/windows-native-presign.mjs";
import {
  WINDOWS_FINALIZER_EVENT,
  WINDOWS_FINALIZER_HANDOFF_SCHEMA,
  WINDOWS_FINALIZER_HANDOFF_STATUS,
  WINDOWS_FINALIZER_PRODUCTION_READINESS,
  WINDOWS_FINALIZER_RUN_CONCLUSION,
  WINDOWS_FINALIZER_RUN_STATUS,
  WINDOWS_FINALIZER_TARGET,
  WINDOWS_FINALIZER_WORKFLOW_PATH,
} from "../scripts/verify-windows-finalizer-qualification-handoff.mjs";
import {
  WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
  WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
  WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW,
} from "../src/platform/windows-production-authority-manifest.js";

const REVISION = "a".repeat(40);
const PACKAGE_VERSION = "0.1.15";
const PUBLISHER = "CN=TiboTattle Test";
const SOURCE_RUN = 123456789;
const SOURCE_RUN_ATTEMPT = 2;
const FINALIZER_RUN = 987654321;
const BINDING_BYTES = 41;
const BINDING_SHA256 = "b".repeat(64);
const WARM_RECEIPT_SHA256 = "c".repeat(64);
const CLEAN_RECEIPT_SHA256 = "d".repeat(64);
const SIGNER_THUMBPRINT = "e".repeat(40);

function checkoutPackageJsonBytes(overrides = {}) {
  return Buffer.from(JSON.stringify({
    name: "app-usagemonitor",
    version: PACKAGE_VERSION,
    private: true,
    type: "module",
    ...overrides,
  }), "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function qualificationReceipt(cacheMode) {
  const rawReceiptSha256 = cacheMode === "warm"
    ? WARM_RECEIPT_SHA256
    : CLEAN_RECEIPT_SHA256;
  const artifactId = cacheMode === "warm" ? 111 : 222;
  const receiptBytes = cacheMode === "warm" ? 333 : 444;
  return {
    artifact: {
      digest: `sha256:${rawReceiptSha256}`,
      headSha: REVISION,
      id: artifactId,
      name: `tibotattle-windows-electron-qualification-${SOURCE_RUN}-${SOURCE_RUN_ATTEMPT}-${REVISION}-${cacheMode}.json`,
      runId: SOURCE_RUN,
      sizeInBytes: receiptBytes,
    },
    binding: {
      bytes: BINDING_BYTES,
      sha256: BINDING_SHA256,
    },
    cacheMode,
    qualification: {
      failed: 0,
      passed: 37,
      skipped: 0,
      status: "WINDOWS_SECURITY_QUALIFICATION_PASSED",
      tests: 37,
    },
    receiptProvenance: {
      bytes: receiptBytes,
      runId: SOURCE_RUN,
      sha256: rawReceiptSha256,
    },
    runtimeStatus: "WINDOWS_ELECTRON_RUNTIME_SMOKE_PASSED",
    status: "WINDOWS_ELECTRON_DEVELOPMENT_QUALIFICATION_PASSED",
  };
}

function handoffFixture(overrides = {}) {
  const value = {
    productionReadiness: WINDOWS_FINALIZER_PRODUCTION_READINESS,
    receipts: [qualificationReceipt("warm"), qualificationReceipt("clean")],
    repository: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
    revision: REVISION,
    run: {
      conclusion: WINDOWS_FINALIZER_RUN_CONCLUSION,
      databaseId: SOURCE_RUN,
      event: WINDOWS_FINALIZER_EVENT,
      headSha: REVISION,
      ref: WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
      runAttempt: SOURCE_RUN_ATTEMPT,
      status: WINDOWS_FINALIZER_RUN_STATUS,
    },
    schemaVersion: WINDOWS_FINALIZER_HANDOFF_SCHEMA,
    status: WINDOWS_FINALIZER_HANDOFF_STATUS,
    target: WINDOWS_FINALIZER_TARGET,
  };
  return {
    ...value,
    ...overrides,
    run: { ...value.run, ...overrides.run },
  };
}

function handoffBytes(value = handoffFixture()) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sourceRunMetadata(overrides = {}) {
  const value = {
    conclusion: WINDOWS_FINALIZER_RUN_CONCLUSION,
    event: WINDOWS_FINALIZER_EVENT,
    head_branch: "main",
    head_sha: REVISION,
    id: SOURCE_RUN,
    path: `${WINDOWS_FINALIZER_WORKFLOW_PATH}@${WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF}`,
    repository: { full_name: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY },
    run_attempt: SOURCE_RUN_ATTEMPT,
    status: WINDOWS_FINALIZER_RUN_STATUS,
  };
  return {
    ...value,
    ...overrides,
    repository: { ...value.repository, ...overrides.repository },
  };
}

function authenticode(overrides = {}) {
  return {
    status: "Valid",
    publisher: PUBLISHER,
    signerThumbprint: SIGNER_THUMBPRINT,
    timestampPresent: true,
    policy: "authenticode-pa",
    signtoolPaValid: true,
    ...overrides,
  };
}

function presignReceipt(qualificationHandoffSha256, overrides = {}) {
  const value = {
    schemaVersion: WINDOWS_NATIVE_PRESIGN_SCHEMA,
    status: WINDOWS_NATIVE_PRESIGN_STATUS,
    target: WINDOWS_NATIVE_PRESIGN_TARGET,
    revision: REVISION,
    packageVersion: PACKAGE_VERSION,
    qualificationHandoffSha256,
    signingRequestPolicy: { ...WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY },
    modules: [
      {
        name: WINDOWS_NATIVE_PRESIGN_MODULES[0].name,
        packagedPath: WINDOWS_NATIVE_PRESIGN_MODULES[0].packagedPath,
        unsignedBytes: BINDING_BYTES,
        signedBytes: BINDING_BYTES + 10,
        unsignedSha256: BINDING_SHA256,
        signedSha256: "1".repeat(64),
        authenticode: authenticode(),
      },
      {
        name: WINDOWS_NATIVE_PRESIGN_MODULES[1].name,
        packagedPath: WINDOWS_NATIVE_PRESIGN_MODULES[1].packagedPath,
        unsignedBytes: 200,
        signedBytes: 210,
        unsignedSha256: WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
        signedSha256: "2".repeat(64),
        authenticode: authenticode(),
      },
    ],
  };
  return {
    ...value,
    ...overrides,
    signingRequestPolicy: {
      ...value.signingRequestPolicy,
      ...overrides.signingRequestPolicy,
    },
    modules: overrides.modules ?? value.modules,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function uncheckedPresignBytes(value) {
  return Buffer.from(`${JSON.stringify(stableValue(value))}\n`, "utf8");
}

function fixture() {
  const selectedHandoffBytes = handoffBytes();
  const selectedPresign = presignReceipt(sha256(selectedHandoffBytes));
  return {
    handoffBytes: selectedHandoffBytes,
    nativePresignBytes: Buffer.from(
      serializeWindowsNativePresignReceipt(selectedPresign),
      "utf8",
    ),
    sourceRunMetadata: sourceRunMetadata(),
    checkoutPackageJsonBytes: checkoutPackageJsonBytes(),
    publisher: PUBLISHER,
    runtimeManifest: {
      packagedPath: WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
      bytes: 512,
      sha256: "f".repeat(64),
    },
    finalizer: {
      run: FINALIZER_RUN,
      runAttempt: 1,
      headSha: REVISION,
    },
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error instanceof WindowsProductionFinalizerAuthorityError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, "Windows production finalizer authority build failed");
    return true;
  };
}

test("joins exact raw qualification and presign evidence into authority v2", () => {
  const input = fixture();
  const manifest = buildWindowsProductionFinalizerAuthority(input);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.nativePresign), true);
  assert.equal(manifest.schemaVersion, WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA);
  assert.equal(manifest.sourceQualification.workflow, WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW);
  assert.equal(manifest.sourceQualification.run, SOURCE_RUN);
  assert.equal(manifest.sourceQualification.runAttempt, SOURCE_RUN_ATTEMPT);
  assert.equal(manifest.sourceQualification.handoff.sha256, sha256(input.handoffBytes));
  assert.deepEqual(manifest.sourceQualification.receipts.map((row) => row.cacheMode), [
    "warm",
    "clean",
  ]);
  assert.deepEqual(manifest.nativePresign, {
    receiptSha256: sha256(input.nativePresignBytes),
    schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_SCHEMA,
    status: WINDOWS_NATIVE_PRESIGN_STATUS,
    target: WINDOWS_NATIVE_PRESIGN_TARGET,
    revision: REVISION,
    packageVersion: PACKAGE_VERSION,
    qualificationHandoffSha256: sha256(input.handoffBytes),
  });
  assert.deepEqual(manifest.sourcePackage, {
    path: "package.json",
    name: "app-usagemonitor",
    version: PACKAGE_VERSION,
    revision: REVISION,
    bytes: input.checkoutPackageJsonBytes.byteLength,
    sha256: sha256(input.checkoutPackageJsonBytes),
  });
  const parsedPresign = JSON.parse(input.nativePresignBytes.toString("utf8"));
  assert.deepEqual(
    manifest.nativeModules,
    parsedPresign.modules.map(({ authenticode: _authenticode, ...module }) => module),
  );
  assert.deepEqual(manifest.signerPolicy, { publisher: PUBLISHER, match: "exact" });
  assert.equal(manifest.finalizer.workflow, WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW);
  assert.equal(Object.hasOwn(manifest, "authority"), false);
  assert.equal(JSON.stringify(manifest).includes("signerThumbprint"), false);
});

test("raw handoff bytes are canonical and linked into the presign receipt", () => {
  const whitespace = fixture();
  whitespace.handoffBytes = Buffer.concat([whitespace.handoffBytes, Buffer.from(" ")]);
  assert.throws(
    () => buildWindowsProductionFinalizerAuthority(whitespace),
    expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.handoffNoncanonical),
  );

  const stale = fixture();
  const changedHandoff = handoffFixture();
  changedHandoff.receipts[0].artifact.id += 1;
  stale.handoffBytes = handoffBytes(changedHandoff);
  assert.throws(
    () => buildWindowsProductionFinalizerAuthority(stale),
    expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.presignInvalid),
  );
});

test("the presign receipt must be canonical and match checkout/package/signing policy", () => {
  const whitespace = fixture();
  whitespace.nativePresignBytes = Buffer.concat([
    whitespace.nativePresignBytes,
    Buffer.from(" "),
  ]);
  assert.throws(
    () => buildWindowsProductionFinalizerAuthority(whitespace),
    expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.presignInvalid),
  );

  for (const mutate of [
    (value) => { value.checkoutPackageJsonBytes = checkoutPackageJsonBytes({ version: "0.1.16" }); },
    (value) => { value.publisher = "CN=Other Publisher"; },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => buildWindowsProductionFinalizerAuthority(value),
      expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.presignInvalid),
    );
  }
});

test("package provenance comes only from bounded raw checkout package.json bytes", () => {
  const wrongVersion = fixture();
  wrongVersion.checkoutPackageJsonBytes = checkoutPackageJsonBytes({ version: "0.1.16" });
  assert.throws(
    () => buildWindowsProductionFinalizerAuthority(wrongVersion),
    expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.presignInvalid),
  );

  for (const checkoutPackageJsonBytes of [
    Buffer.from([0xff, 0xfe, 0xfd]),
    Buffer.from("{not-json", "utf8"),
    Buffer.from(JSON.stringify({ name: "other", version: PACKAGE_VERSION, private: true, type: "module" }), "utf8"),
    Buffer.from(JSON.stringify({ name: "app-usagemonitor", version: PACKAGE_VERSION }), "utf8"),
    Buffer.alloc(64 * 1024 + 1, 0x20),
  ]) {
    const value = fixture();
    value.checkoutPackageJsonBytes = checkoutPackageJsonBytes;
    assert.throws(
      () => buildWindowsProductionFinalizerAuthority(value),
      expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid),
    );
  }
});

test("source REST workflow provenance and run identity are independently cross-matched", () => {
  const wrongWorkflow = fixture();
  wrongWorkflow.sourceRunMetadata = sourceRunMetadata({
    path: `.github/workflows/other.yml@${WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF}`,
  });
  assert.throws(
    () => buildWindowsProductionFinalizerAuthority(wrongWorkflow),
    expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.sourceRunInvalid),
  );

  for (const overrides of [
    { id: SOURCE_RUN + 1 },
    { run_attempt: SOURCE_RUN_ATTEMPT + 1 },
  ]) {
    const value = fixture();
    value.sourceRunMetadata = sourceRunMetadata(overrides);
    assert.throws(
      () => buildWindowsProductionFinalizerAuthority(value),
      expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.sourceRunMismatch),
    );
  }
});

test("module, keytar, path, order, and Authenticode drift fail before authority", () => {
  const mutations = [
    (receipt) => { receipt.modules.reverse(); },
    (receipt) => { receipt.modules[0].packagedPath = "native/elsewhere.node"; },
    (receipt) => { receipt.modules[1].unsignedSha256 = "0".repeat(64); },
    (receipt) => { receipt.modules[0].authenticode.publisher = "CN=Other Publisher"; },
    (receipt) => { receipt.modules[0].authenticode.timestampPresent = false; },
    (receipt) => { receipt.signingRequestPolicy.requestedFileDigest = "SHA1"; },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    const receipt = JSON.parse(value.nativePresignBytes.toString("utf8"));
    mutate(receipt);
    value.nativePresignBytes = uncheckedPresignBytes(receipt);
    assert.throws(
      () => buildWindowsProductionFinalizerAuthority(value),
      expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.presignInvalid),
    );
  }
});

test("top-level, runtime, and finalizer inputs are closed and content-free", () => {
  assert.throws(
    () => buildWindowsProductionFinalizerAuthority({ ...fixture(), nativeModules: [] }),
    expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid),
  );
  const nakedVersion = fixture();
  delete nakedVersion.checkoutPackageJsonBytes;
  nakedVersion.checkoutPackageVersion = PACKAGE_VERSION;
  assert.throws(
    () => buildWindowsProductionFinalizerAuthority(nakedVersion),
    expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid),
  );

  const accessor = fixture();
  Object.defineProperty(accessor, "publisher", {
    enumerable: true,
    get() {
      return "private hostile publisher";
    },
  });
  assert.throws(
    () => buildWindowsProductionFinalizerAuthority(accessor),
    expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid),
  );
  assert.throws(
    () => buildWindowsProductionFinalizerAuthority(new Proxy(fixture(), {})),
    expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid),
  );

  const runtime = fixture();
  runtime.runtimeManifest = { ...runtime.runtimeManifest, packagedPath: "private.json" };
  assert.throws(
    () => buildWindowsProductionFinalizerAuthority(runtime),
    expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.runtimeInvalid),
  );

  const finalizer = fixture();
  finalizer.finalizer = { ...finalizer.finalizer, headSha: "9".repeat(40) };
  assert.throws(
    () => buildWindowsProductionFinalizerAuthority(finalizer),
    expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.finalizerInvalid),
  );

  const sameRun = fixture();
  sameRun.finalizer = { ...sameRun.finalizer, run: SOURCE_RUN };
  assert.throws(
    () => buildWindowsProductionFinalizerAuthority(sameRun),
    expectCode(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.authorityInvalid),
  );
});
