import assert from "node:assert/strict";
import test from "node:test";

import {
  LinuxQualificationError,
  assertLinuxNativeQualificationReceipt,
  assertLinuxQualificationReceipt,
  createLinuxQualificationContext,
  createLinuxQualificationReceipt,
} from "../linux-qualification.js";

const REVISION = "a".repeat(40);
const DIGEST = "b".repeat(64);

function fields(overrides = {}) {
  return {
    platform: "linux",
    architecture: "x64",
    sourceRevision: REVISION,
    distribution: "ubuntu-24.04",
    desktopProtocol: "wayland",
    credentialStoreMode: "isolated-secret-service",
    subjectKind: "installed",
    artifactDigest: DIGEST,
    developmentOnly: true,
    ...overrides,
  };
}

function qualificationError(code) {
  return (error) => {
    assert.equal(error instanceof LinuxQualificationError, true);
    assert.equal(error.code, `linux_electron_qualification_${code}`);
    assert.equal(error.message, "Linux Electron qualification context is invalid");
    return true;
  };
}

test("Linux L0 qualification receipt is exact, content-free, and native x64", () => {
  const context = createLinuxQualificationContext(fields());
  const receipt = createLinuxQualificationReceipt(context);
  assert.deepEqual(Object.keys(receipt), [
    "contractVersion",
    "platform",
    "architecture",
    "sourceRevision",
    "distribution",
    "desktopProtocol",
    "credentialStoreMode",
    "subjectKind",
    "artifactDigest",
    "developmentOnly",
  ]);
  assert.equal(assertLinuxQualificationReceipt(receipt).architecture, "x64");
  assert.equal(assertLinuxNativeQualificationReceipt(receipt).platform, "linux");
  assert.equal(JSON.stringify(receipt).includes("/home/"), false);
  assert.equal(JSON.stringify(receipt).includes("dbus"), false);
  assert.throws(
    () => createLinuxQualificationReceipt({ ...context }),
    qualificationError("context_untrusted"),
  );
});

test("ARM64 source evidence cannot cross the native x64 acceptance assertion", () => {
  const context = createLinuxQualificationContext(fields({
    architecture: "arm64",
    distribution: "debian-bookworm",
    desktopProtocol: "x11",
    credentialStoreMode: "unavailable",
    subjectKind: "source",
    artifactDigest: null,
  }));
  const receipt = createLinuxQualificationReceipt(context);
  assert.equal(assertLinuxQualificationReceipt(receipt).architecture, "arm64");
  assert.throws(
    () => assertLinuxNativeQualificationReceipt(receipt),
    qualificationError("native_identity_invalid"),
  );
});

test("Linux qualification rejects extra, inherited, accessor, proxy, and symbol fields", () => {
  const invalid = [
    { ...fields(), path: "/home/ada/private" },
    Object.assign(Object.create({ inherited: true }), fields()),
    new Proxy(fields(), {}),
    { ...fields(), [Symbol("secret")]: "value" },
  ];
  for (const value of invalid) {
    assert.throws(
      () => createLinuxQualificationContext(value),
      qualificationError("shape_invalid"),
    );
  }

  let getterCalls = 0;
  const getter = fields();
  Object.defineProperty(getter, "distribution", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "ubuntu-24.04";
    },
  });
  assert.throws(
    () => createLinuxQualificationContext(getter),
    qualificationError("shape_invalid"),
  );
  assert.equal(getterCalls, 0);
});

test("Linux qualification binds subject kind to artifact digest and development-only state", () => {
  const cases = [
    [fields({ subjectKind: "source", artifactDigest: DIGEST }), "artifact_invalid"],
    [fields({ subjectKind: "installed", artifactDigest: null }), "artifact_invalid"],
    [fields({ developmentOnly: false }), "development_only_required"],
    [fields({ sourceRevision: "A".repeat(40) }), "source_revision_invalid"],
    [fields({ distribution: "/home/ada" }), "matrix_invalid"],
    [fields({ artifactDigest: Symbol("secret") }), "artifact_invalid"],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => createLinuxQualificationContext(value),
      qualificationError(code),
    );
  }
});

test("Linux qualification rejects copied or expanded receipts", () => {
  const receipt = createLinuxQualificationReceipt(
    createLinuxQualificationContext(fields()),
  );
  assert.throws(
    () => assertLinuxQualificationReceipt({ ...receipt, privatePath: "/tmp/private" }),
    qualificationError("shape_invalid"),
  );
  assert.throws(
    () => assertLinuxQualificationReceipt({ ...receipt, contractVersion: "future" }),
    qualificationError("contract_invalid"),
  );
});
