import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  WINDOWS_NATIVE_PRESIGN_FIXED_STATUS,
  WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
  WINDOWS_NATIVE_PRESIGN_MODULES,
  WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY,
  WINDOWS_NATIVE_PRESIGN_SCHEMA,
  WINDOWS_NATIVE_PRESIGN_STATUS,
  WINDOWS_NATIVE_PRESIGN_TARGET,
  WindowsNativePresignError,
  buildTrustedSigningPowerShellCommand,
  buildWindowsNativePresignReceipt,
  parseWindowsNativePresignReceipt,
  runWindowsNativePresign,
  serializeWindowsNativePresignReceipt,
  validateAuthenticodeAggregate,
  validateWindowsNativePresignReceipt,
  validateWindowsNativePresignOptions,
  writeWindowsNativePresignReceipt,
} from "../scripts/windows-native-presign.mjs";

const REVISION = "a".repeat(40);
const HANDOFF_SHA = "b".repeat(64);
const PUBLISHER = "CN=TiboTattle Test";
const THUMBPRINT = "c".repeat(40);
const KEYTAR_SOURCE = resolve(
  "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
);
const KEYTAR_BYTES = await readFile(KEYTAR_SOURCE);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function authenticode(overrides = {}) {
  return {
    status: "Valid",
    publisher: PUBLISHER,
    signerThumbprint: THUMBPRINT,
    timestampPresent: true,
    policy: "authenticode-pa",
    signtoolPaValid: true,
    ...overrides,
  };
}

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-presign-")));
  const stagingRoot = join(parent, "app");
  const filesystemBytes = Buffer.from("reviewed-unsigned-filesystem-binding", "utf8");
  const filesystemPath = join(
    stagingRoot,
    ...WINDOWS_NATIVE_PRESIGN_MODULES[0].packagedPath.split("/"),
  );
  const keytarPath = join(
    stagingRoot,
    ...WINDOWS_NATIVE_PRESIGN_MODULES[1].packagedPath.split("/"),
  );
  await mkdir(dirname(filesystemPath), { recursive: true });
  await mkdir(dirname(keytarPath), { recursive: true });
  await writeFile(filesystemPath, filesystemBytes, { mode: 0o600 });
  await copyFile(KEYTAR_SOURCE, keytarPath);
  const receiptRoot = join(parent, "evidence");
  await mkdir(receiptRoot);
  const receiptPath = join(receiptRoot, `windows-native-presign-${REVISION}.json`);
  const options = {
    stagingRoot,
    revision: REVISION,
    packageVersion: "0.1.15",
    qualificationHandoffSha256: HANDOFF_SHA,
    filesystemBinding: {
      bytes: filesystemBytes.byteLength,
      sha256: sha256(filesystemBytes),
    },
    keytarSha256: WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
    azure: {
      endpoint: "https://eus.codesigning.azure.net/",
      codeSigningAccountName: "tibotattle-test",
      certificateProfileName: "profile-test",
      publisher: PUBLISHER,
    },
  };
  return {
    parent,
    stagingRoot,
    filesystemPath,
    keytarPath,
    receiptRoot,
    receiptPath,
    filesystemBytes,
    options,
    async cleanup() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

function expectedBinding(options) {
  return {
    revision: options.revision,
    packageVersion: options.packageVersion,
    qualificationHandoffSha256: options.qualificationHandoffSha256,
    filesystemBinding: options.filesystemBinding,
    publisher: PUBLISHER,
  };
}

function injectedSigner(calls = []) {
  return async ({ name, path, command, azure }) => {
    calls.push({ name, path, command, azure });
    const before = await readFile(path);
    await writeFile(path, Buffer.concat([before, Buffer.from(`signed:${name}`, "utf8")]));
    return authenticode();
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error instanceof WindowsNativePresignError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, "Windows native pre-sign failed");
    return true;
  };
}

test("builds a frozen, fixed-path, content-free pre-sign receipt", async () => {
  const value = await fixture();
  try {
    const calls = [];
    const receipt = await buildWindowsNativePresignReceipt(value.options, {
      platform: "darwin",
      expectedStagingRoot: value.stagingRoot,
      expectedReceiptRoot: value.receiptRoot,
      signAndProbe: injectedSigner(calls),
    });
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.isFrozen(receipt.modules), true);
    assert.equal(Object.isFrozen(receipt.modules[0].authenticode), true);
    assert.deepEqual(
      {
        schemaVersion: receipt.schemaVersion,
        status: receipt.status,
        target: receipt.target,
        revision: receipt.revision,
        packageVersion: receipt.packageVersion,
        qualificationHandoffSha256: receipt.qualificationHandoffSha256,
        signingRequestPolicy: receipt.signingRequestPolicy,
      },
      {
        schemaVersion: WINDOWS_NATIVE_PRESIGN_SCHEMA,
        status: WINDOWS_NATIVE_PRESIGN_STATUS,
        target: WINDOWS_NATIVE_PRESIGN_TARGET,
        revision: REVISION,
        packageVersion: "0.1.15",
        qualificationHandoffSha256: HANDOFF_SHA,
        signingRequestPolicy: WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY,
      },
    );
    assert.deepEqual(
      receipt.modules.map(({ name, packagedPath }) => ({ name, packagedPath })),
      WINDOWS_NATIVE_PRESIGN_MODULES,
    );
    assert.equal(receipt.modules.every((row) => row.unsignedSha256 !== row.signedSha256), true);
    const filesystemSuffix = Buffer.from("signed:windows-filesystem", "utf8");
    const keytarSuffix = Buffer.from("signed:keytar", "utf8");
    assert.deepEqual(receipt.modules[0], {
      name: "windows-filesystem",
      packagedPath: WINDOWS_NATIVE_PRESIGN_MODULES[0].packagedPath,
      unsignedBytes: value.filesystemBytes.byteLength,
      signedBytes: value.filesystemBytes.byteLength + filesystemSuffix.byteLength,
      unsignedSha256: sha256(value.filesystemBytes),
      signedSha256: sha256(Buffer.concat([value.filesystemBytes, filesystemSuffix])),
      authenticode: {
        status: "Valid",
        publisher: PUBLISHER,
        signerThumbprint: THUMBPRINT,
        timestampPresent: true,
        policy: "authenticode-pa",
        signtoolPaValid: true,
      },
    });
    assert.equal(receipt.modules[1].unsignedBytes, KEYTAR_BYTES.byteLength);
    assert.equal(
      receipt.modules[1].signedSha256,
      sha256(Buffer.concat([KEYTAR_BYTES, keytarSuffix])),
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].path, value.filesystemPath);
    assert.equal(calls[1].path, value.keytarPath);
    assert.equal(JSON.stringify(receipt).includes(value.parent), false);
    const binding = expectedBinding(value.options);
    const validated = validateWindowsNativePresignReceipt(receipt, binding);
    assert.equal(Object.isFrozen(validated), true);
    assert.equal(Object.isFrozen(validated.modules[0]), true);
    const serialized = serializeWindowsNativePresignReceipt(receipt);
    assert.equal(serialized.endsWith("\n"), true);
    assert.deepEqual(parseWindowsNativePresignReceipt(serialized, binding), validated);
    assert.throws(
      () => parseWindowsNativePresignReceipt(`${serialized} `, binding),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid),
    );
  } finally {
    await value.cleanup();
  }
});

test("validates the closed receipt contract and every expected binding", async () => {
  const value = await fixture();
  try {
    const receipt = await buildWindowsNativePresignReceipt(value.options, {
      platform: "darwin",
      expectedStagingRoot: value.stagingRoot,
      expectedReceiptRoot: value.receiptRoot,
      signAndProbe: injectedSigner(),
    });
    const binding = expectedBinding(value.options);
    const invalidReceipt = (mutate, code = WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid) => {
      const candidate = JSON.parse(JSON.stringify(receipt));
      mutate(candidate);
      assert.throws(
        () => validateWindowsNativePresignReceipt(candidate, binding),
        expectCode(code),
      );
    };

    for (const [field, replacement] of [
      ["schemaVersion", "tibotattle-windows-native-presign-v2"],
      ["status", "WINDOWS_NATIVE_PRESIGN_INPUT_INVALID"],
      ["target", "linux-x64"],
      ["revision", "f".repeat(40)],
      ["packageVersion", "0.1.16"],
      ["qualificationHandoffSha256", "f".repeat(64)],
    ]) {
      invalidReceipt((candidate) => { candidate[field] = replacement; });
    }

    invalidReceipt((candidate) => {
      candidate.signingRequestPolicy.requestedFileDigest = "SHA1";
    });
    invalidReceipt((candidate) => {
      candidate.modules.reverse();
    });
    invalidReceipt((candidate) => {
      candidate.modules[0].packagedPath = candidate.modules[1].packagedPath;
    });
    invalidReceipt((candidate) => {
      candidate.modules[1].unsignedSha256 = "0".repeat(64);
    });
    invalidReceipt((candidate) => {
      candidate.modules[0].signedSha256 = candidate.modules[0].unsignedSha256;
    });
    invalidReceipt((candidate) => {
      candidate.modules[0].authenticode.timestampPresent = false;
    }, WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid);
    invalidReceipt((candidate) => {
      candidate.modules[0].authenticode.signerThumbprint = THUMBPRINT.toUpperCase();
    }, WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid);
    invalidReceipt((candidate) => {
      candidate.modules[0].authenticode.extra = "no";
    }, WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid);
    invalidReceipt((candidate) => {
      candidate.extra = "no";
    });

    const accessor = JSON.parse(JSON.stringify(receipt));
    Object.defineProperty(accessor, "revision", {
      enumerable: true,
      get: () => REVISION,
    });
    assert.throws(
      () => validateWindowsNativePresignReceipt(accessor, binding),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid),
    );

    const symbolized = JSON.parse(JSON.stringify(receipt));
    symbolized[Symbol("secret")] = "no";
    assert.throws(
      () => validateWindowsNativePresignReceipt(symbolized, binding),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid),
    );

    const proxied = new Proxy(JSON.parse(JSON.stringify(receipt)), {});
    assert.throws(
      () => validateWindowsNativePresignReceipt(proxied, binding),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid),
    );

    const divergentPublisher = JSON.parse(JSON.stringify(receipt));
    divergentPublisher.modules[1].authenticode.publisher = "CN=Different Publisher";
    assert.throws(
      () => validateWindowsNativePresignReceipt(divergentPublisher),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid),
    );

    const arrayExtra = JSON.parse(JSON.stringify(receipt));
    arrayExtra.modules.extra = "no";
    assert.throws(
      () => validateWindowsNativePresignReceipt(arrayExtra, binding),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid),
    );

    for (const [field, replacement] of [
      ["revision", "f".repeat(40)],
      ["packageVersion", "0.1.16"],
      ["qualificationHandoffSha256", "f".repeat(64)],
      ["filesystemBinding", { bytes: binding.filesystemBinding.bytes + 1, sha256: binding.filesystemBinding.sha256 }],
      ["publisher", "CN=Someone Else"],
    ]) {
      assert.throws(
        () => validateWindowsNativePresignReceipt(receipt, {
          ...binding,
          [field]: replacement,
        }),
        expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid),
      );
    }
    assert.throws(
      () => validateWindowsNativePresignReceipt(receipt, { ...binding, extra: "no" }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid),
    );
    const missingExpected = { ...binding };
    delete missingExpected.publisher;
    assert.throws(
      () => validateWindowsNativePresignReceipt(receipt, missingExpected),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid),
    );
    assert.throws(
      () => serializeWindowsNativePresignReceipt({
        ...JSON.parse(JSON.stringify(receipt)),
        extra: "no",
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid),
    );
    assert.throws(
      () => parseWindowsNativePresignReceipt(`${"x".repeat(64 * 1024)}\n`, binding),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid),
    );
  } finally {
    await value.cleanup();
  }
});

test("runs the injected stage and writes one canonical no-clobber receipt", async () => {
  const value = await fixture();
  try {
    const receipt = await runWindowsNativePresign(value.options, {
      platform: "darwin",
      expectedStagingRoot: value.stagingRoot,
      expectedReceiptRoot: value.receiptRoot,
      signAndProbe: injectedSigner(),
    });
    assert.equal(await readFile(value.receiptPath, "utf8"), serializeWindowsNativePresignReceipt(receipt));
    await assert.rejects(
      writeWindowsNativePresignReceipt(value.receiptPath, receipt, {
        expectedReceiptRoot: value.receiptRoot,
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.outputExists),
    );
  } finally {
    await value.cleanup();
  }
});

test("accepts only the closed exact input and fixed production staging root", async () => {
  const value = await fixture();
  try {
    const selected = validateWindowsNativePresignOptions(value.options, {
      expectedStagingRoot: value.stagingRoot,
      expectedReceiptRoot: value.receiptRoot,
    });
    assert.equal(selected.stagingRoot, value.stagingRoot);
    for (const candidate of [
      { ...value.options, modulePath: "elsewhere.node" },
      { ...value.options, stagingRoot: value.parent },
      { ...value.options, keytarSha256: "0".repeat(64) },
      { ...value.options, revision: "A".repeat(40) },
      { ...value.options, packageVersion: "0.1.15-beta" },
      { ...value.options, azure: { ...value.options.azure, endpoint: "https://evil.example/" } },
    ]) {
      assert.throws(
        () => validateWindowsNativePresignOptions(candidate, {
          expectedStagingRoot: value.stagingRoot,
          expectedReceiptRoot: value.receiptRoot,
        }),
        expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid),
      );
    }
    const accessor = { ...value.options };
    Object.defineProperty(accessor, "revision", { enumerable: true, get: () => REVISION });
    assert.throws(
      () => validateWindowsNativePresignOptions(accessor, {
        expectedStagingRoot: value.stagingRoot,
        expectedReceiptRoot: value.receiptRoot,
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid),
    );
    assert.throws(
      () => validateWindowsNativePresignOptions(value.options, {
        expectedStagingRoot: value.stagingRoot,
        expectedReceiptRoot: join(value.stagingRoot, "evidence"),
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid),
    );
  } finally {
    await value.cleanup();
  }
});

test("constructs the exact pinned Trusted Signing command without a credential", async () => {
  const value = await fixture();
  try {
    const command = buildTrustedSigningPowerShellCommand(
      value.filesystemPath,
      value.options.azure,
    );
    assert.match(command, /Import-Module TrustedSigning -RequiredVersion 0\.5\.0 -Force/u);
    assert.match(command, /Invoke-TrustedSigning/u);
    assert.match(command, /-TimestampRfc3161 'http:\/\/timestamp\.acs\.microsoft\.com'/u);
    assert.match(command, /-TimestampDigest 'SHA256'/u);
    assert.match(command, /-FileDigest 'SHA256'/u);
    assert.match(command, /-Files '/u);
    assert.doesNotMatch(command, /client.secret|password|token|pfx/iu);
  } finally {
    await value.cleanup();
  }
});

test("Authenticode aggregate is exact, publisher-bound, timestamped, and PA-verified", () => {
  const selected = validateAuthenticodeAggregate(authenticode(), PUBLISHER);
  assert.equal(selected.signerThumbprint, THUMBPRINT);
  for (const candidate of [
    authenticode({ status: "UnknownError" }),
    authenticode({ publisher: "CN=Someone Else" }),
    authenticode({ signerThumbprint: "z".repeat(40) }),
    authenticode({ timestampPresent: false }),
    authenticode({ policy: "authenticode" }),
    authenticode({ signtoolPaValid: false }),
    { ...authenticode(), privatePath: "C:\\private" },
  ]) {
    assert.throws(
      () => validateAuthenticodeAggregate(candidate, PUBLISHER),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid),
    );
  }
});

test("fails before signing when the qualified filesystem or pinned keytar bytes differ", async () => {
  const filesystem = await fixture();
  try {
    await assert.rejects(
      buildWindowsNativePresignReceipt({
        ...filesystem.options,
        filesystemBinding: {
          ...filesystem.options.filesystemBinding,
          sha256: "0".repeat(64),
        },
      }, {
        expectedStagingRoot: filesystem.stagingRoot,
        expectedReceiptRoot: filesystem.receiptRoot,
        signAndProbe: injectedSigner(),
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.unsignedMismatch),
    );
  } finally {
    await filesystem.cleanup();
  }

  const keytar = await fixture();
  try {
    await writeFile(keytar.keytarPath, "not-the-pinned-keytar");
    await assert.rejects(
      buildWindowsNativePresignReceipt(keytar.options, {
        expectedStagingRoot: keytar.stagingRoot,
        expectedReceiptRoot: keytar.receiptRoot,
        signAndProbe: injectedSigner(),
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.unsignedMismatch),
    );
  } finally {
    await keytar.cleanup();
  }
});

test("rejects symlink and oversized module inputs without exposing their paths", async () => {
  const linked = await fixture();
  try {
    const target = join(linked.parent, "target.node");
    await writeFile(target, "target");
    await rm(linked.filesystemPath);
    await symlink(target, linked.filesystemPath);
    await assert.rejects(
      buildWindowsNativePresignReceipt(linked.options, {
        expectedStagingRoot: linked.stagingRoot,
        expectedReceiptRoot: linked.receiptRoot,
        signAndProbe: injectedSigner(),
      }),
      (error) => {
        assert.equal(expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.fileInvalid)(error), true);
        assert.equal(error.message.includes(linked.parent), false);
        return true;
      },
    );
  } finally {
    await linked.cleanup();
  }

  const oversized = await fixture();
  try {
    await truncate(oversized.filesystemPath, 64 * 1024 * 1024 + 1);
    await assert.rejects(
      buildWindowsNativePresignReceipt(oversized.options, {
        expectedStagingRoot: oversized.stagingRoot,
        expectedReceiptRoot: oversized.receiptRoot,
        signAndProbe: injectedSigner(),
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.fileInvalid),
    );
  } finally {
    await oversized.cleanup();
  }
});

test("fails closed for invalid signature evidence, signer errors, and unchanged bytes", async () => {
  const invalidSignature = await fixture();
  try {
    await assert.rejects(
      buildWindowsNativePresignReceipt(invalidSignature.options, {
        expectedStagingRoot: invalidSignature.stagingRoot,
        expectedReceiptRoot: invalidSignature.receiptRoot,
        signAndProbe: async () => authenticode({ publisher: "CN=Wrong" }),
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid),
    );
  } finally {
    await invalidSignature.cleanup();
  }

  const signerFailure = await fixture();
  try {
    await assert.rejects(
      buildWindowsNativePresignReceipt(signerFailure.options, {
        expectedStagingRoot: signerFailure.stagingRoot,
        expectedReceiptRoot: signerFailure.receiptRoot,
        signAndProbe: async () => { throw new Error("private signer diagnostic"); },
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.signingFailed),
    );
  } finally {
    await signerFailure.cleanup();
  }

  const unchanged = await fixture();
  try {
    await assert.rejects(
      buildWindowsNativePresignReceipt(unchanged.options, {
        expectedStagingRoot: unchanged.stagingRoot,
        expectedReceiptRoot: unchanged.receiptRoot,
        signAndProbe: async () => authenticode(),
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.signedBytesInvalid),
    );
  } finally {
    await unchanged.cleanup();
  }
});

test("a second-module failure invalidates the disposable staging attempt and forbids retry", async () => {
  const value = await fixture();
  try {
    let calls = 0;
    const signer = async ({ name, path }) => {
      calls += 1;
      if (name === "keytar") throw new Error("private second signer failure");
      const before = await readFile(path);
      await writeFile(path, Buffer.concat([before, Buffer.from("signed:first")]));
      return authenticode();
    };
    await assert.rejects(
      runWindowsNativePresign(value.options, {
        platform: "darwin",
        expectedStagingRoot: value.stagingRoot,
        expectedReceiptRoot: value.receiptRoot,
        signAndProbe: signer,
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.signingFailed),
    );
    assert.equal(calls, 2);
    assert.equal(
      await readFile(
        join(value.stagingRoot, ".tibotattle-windows-native-presign-invalidated"),
        "utf8",
      ),
      "WINDOWS_NATIVE_PRESIGN_STAGING_INVALIDATED\n",
    );
    await assert.rejects(
      runWindowsNativePresign(value.options, {
        platform: "darwin",
        expectedStagingRoot: value.stagingRoot,
        expectedReceiptRoot: value.receiptRoot,
        signAndProbe: signer,
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.stagingInvalidated),
    );
    assert.equal(calls, 2);
  } finally {
    await value.cleanup();
  }
});

test("an occupied receipt path fails before any module is signed", async () => {
  const value = await fixture();
  try {
    await writeFile(`${value.receiptPath}.tmp`, "untrusted prior attempt");
    let calls = 0;
    await assert.rejects(
      runWindowsNativePresign(value.options, {
        platform: "darwin",
        expectedStagingRoot: value.stagingRoot,
        expectedReceiptRoot: value.receiptRoot,
        signAndProbe: async () => {
          calls += 1;
          return authenticode();
        },
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.outputExists),
    );
    assert.equal(calls, 0);
    await assert.rejects(
      readFile(join(value.stagingRoot, ".tibotattle-windows-native-presign-invalidated")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await value.cleanup();
  }
});

test("a redirected staging root fails before signing or invalidation output", async () => {
  const value = await fixture();
  try {
    const realStagingRoot = join(value.parent, "redirected-app");
    await rename(value.stagingRoot, realStagingRoot);
    await symlink(realStagingRoot, value.stagingRoot, "dir");
    let calls = 0;
    await assert.rejects(
      runWindowsNativePresign(value.options, {
        platform: "darwin",
        expectedStagingRoot: value.stagingRoot,
        expectedReceiptRoot: value.receiptRoot,
        signAndProbe: async () => {
          calls += 1;
          return authenticode();
        },
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.stagingInvalidated),
    );
    assert.equal(calls, 0);
    await assert.rejects(
      readFile(join(realStagingRoot, ".tibotattle-windows-native-presign-invalidated")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await value.cleanup();
  }
});

test("a native-module parent link may not escape the canonical staging root", async () => {
  const value = await fixture();
  try {
    const releaseDirectory = dirname(value.filesystemPath);
    const escapedDirectory = join(value.parent, "escaped-release");
    await rename(releaseDirectory, escapedDirectory);
    await symlink(escapedDirectory, releaseDirectory, "dir");
    let calls = 0;
    await assert.rejects(
      buildWindowsNativePresignReceipt(value.options, {
        platform: "darwin",
        expectedStagingRoot: value.stagingRoot,
        expectedReceiptRoot: value.receiptRoot,
        signAndProbe: async () => {
          calls += 1;
          return authenticode();
        },
      }),
      expectCode(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.fileInvalid),
    );
    assert.equal(calls, 0);
  } finally {
    await value.cleanup();
  }
});

test("real CLI invocation is fail-closed away from native Windows", () => {
  if (process.platform === "win32") return;
  const child = spawnSync(process.execPath, ["scripts/windows-native-presign.mjs"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(child.status, 1);
  assert.equal(child.stderr, "");
  assert.equal(
    child.stdout,
    `${WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.platformRequired}\n`,
  );
});
