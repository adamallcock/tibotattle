import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";

import {
  WINDOWS_PRODUCTION_AUTHENTICODE_ARTIFACTS_ROOT,
  WINDOWS_PRODUCTION_AUTHENTICODE_EVIDENCE_ROOT,
  WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_FILE,
  WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST,
  WINDOWS_PRODUCTION_AUTHENTICODE_ELECTRON_VERSION,
  WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS,
  WINDOWS_PRODUCTION_AUTHENTICODE_MAIN_EXECUTABLE,
  WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES,
  WINDOWS_PRODUCTION_AUTHENTICODE_PROBE_SCHEMA,
  WINDOWS_PRODUCTION_AUTHENTICODE_PROBE_STATUS,
  WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
  WINDOWS_PRODUCTION_AUTHENTICODE_TARGET,
  WINDOWS_PRODUCTION_AUTHENTICODE_UNINSTALLER,
  WINDOWS_PRODUCTION_AUTHENTICODE_FIXED_STATUS as STATUS,
  WindowsProductionAuthenticodeInventoryError,
  assertNativeWindowsProductionAuthenticodeInventoryReceipt,
  buildWindowsProductionAuthenticodeInventory,
  buildWindowsProductionAuthenticodeProbeEvidence,
  buildWindowsProductionAuthenticodeProbeCommand,
  parseWindowsProductionAuthenticodeInventoryReceipt,
  runWindowsProductionAuthenticodeProbe,
  runWindowsProductionAuthenticodeInventory,
  serializeWindowsProductionAuthenticodeInventoryReceipt,
  validateWindowsProductionAuthenticodeInventoryReceipt,
  verifyWindowsProductionAuthenticodeInventory,
  writeWindowsProductionAuthenticodeInventoryReceipt,
  writeWindowsProductionAuthenticodeInventoryReceiptForTest,
} from "../scripts/verify-windows-production-authenticode-inventory.mjs";

const REVISION = "a".repeat(40);
const VERSION = "0.1.16";
const INSTALLER_NAME = `TiboTattle-${VERSION}-Windows-x64.exe`;
const DLLS = WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST;
const BINDING = {
  installerSha256: sha256(Buffer.from(`installer:${INSTALLER_NAME}\n`, "utf8")),
  packageVersion: VERSION,
  publisher: WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
  revision: REVISION,
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function authenticode(overrides = {}) {
  return {
    policy: "authenticode-pa",
    publisher: WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
    signtoolPaValid: true,
    status: "Valid",
    timestampPresent: true,
    ...overrides,
  };
}

function fileRow(role, path, index) {
  const bytes = 100 + index;
  return {
    authenticode: authenticode(),
    bytes,
    fileKind: "regular",
    linkStatus: "none",
    path,
    role,
    sha256: role === "installer" ? BINDING.installerSha256 : sha256(`${role}:${path}`),
  };
}

function evidence(overrides = {}) {
  const files = [
    fileRow("main-executable", WINDOWS_PRODUCTION_AUTHENTICODE_MAIN_EXECUTABLE, 1),
    ...DLLS.map((path, index) => fileRow("electron-dll", path, index + 2)),
    fileRow("installer", INSTALLER_NAME, 8),
    ...WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES.map(({ path }, index) =>
      fileRow("native-module", path, index + 9)),
  ];
  return {
    schemaVersion: WINDOWS_PRODUCTION_AUTHENTICODE_PROBE_SCHEMA,
    status: WINDOWS_PRODUCTION_AUTHENTICODE_PROBE_STATUS,
    target: WINDOWS_PRODUCTION_AUTHENTICODE_TARGET,
    revision: REVISION,
    packageVersion: VERSION,
    publisher: WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
    probeMode: "injected",
    installer: {
      bytes: files.find((row) => row.role === "installer").bytes,
      sha256: BINDING.installerSha256,
    },
    files,
    ...overrides,
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error instanceof WindowsProductionAuthenticodeInventoryError, true);
    assert.equal(error.code, code);
    assert.equal(
      error.message,
      "Windows production Authenticode inventory verification failed",
    );
    return true;
  };
}

async function createFixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-authenticode-")));
  const productionRoot = join(parent, "production");
  const artifactsRoot = join(productionRoot, "artifacts");
  const winUnpackedRoot = join(artifactsRoot, "win-unpacked");
  const evidenceRoot = join(productionRoot, "evidence");
  await mkdir(winUnpackedRoot, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  const files = [
    ["main-executable", WINDOWS_PRODUCTION_AUTHENTICODE_MAIN_EXECUTABLE],
    ...WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST.map((path) => ["electron-dll", path]),
    ["installer", INSTALLER_NAME],
    ...WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES.map(({ path }) => ["native-module", path]),
  ];
  for (const [role, path] of files) {
    const absolutePath = role === "installer"
      ? join(artifactsRoot, path)
      : join(winUnpackedRoot, path);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, Buffer.from(`${role}:${path}\n`, "utf8"));
  }
  return {
    parent,
    productionRoot,
    artifactsRoot,
    winUnpackedRoot,
    evidenceRoot,
    async cleanup() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

async function captureFile(path) {
  const bytes = await readFile(path);
  return {
    bytes: bytes.byteLength,
    fileKind: "regular",
    linkStatus: "none",
    sha256: sha256(bytes),
  };
}

async function buildFixtureReceipt(fixture, dependencies = {}) {
  return buildWindowsProductionAuthenticodeInventory({
    revision: REVISION,
    packageVersion: VERSION,
    publisher: WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
  }, {
    platform: "darwin",
    testOnly: true,
    testRoot: fixture.productionRoot,
    captureFile,
    probe: async () => authenticode(),
    ...dependencies,
  }, BINDING);
}

test("verifies the exact packaged PE inventory and defers the standalone uninstaller", async () => {
  assert.equal(WINDOWS_PRODUCTION_AUTHENTICODE_ELECTRON_VERSION, "43.2.0");
  assert.deepEqual(WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST, [
    "d3dcompiler_47.dll",
    "ffmpeg.dll",
    "libEGL.dll",
    "libGLESv2.dll",
    "vk_swiftshader.dll",
    "vulkan-1.dll",
  ]);
  assert.equal(Object.isFrozen(WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST), true);
  const fixture = await createFixture();
  try {
    const receipt = await buildFixtureReceipt(fixture);
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.isFrozen(receipt.inventory), true);
    assert.equal(receipt.status, WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS);
    assert.equal(receipt.probeMode, "injected");
    assert.deepEqual(receipt.deferred, {
      reason: "uninstaller-authenticode-requires-installed-lifecycle",
      status: "deferred",
    });
    assert.deepEqual(receipt.inventory.roles, {
      electronDlls: 6,
      installer: 1,
      mainExecutable: 1,
      nativeModules: 2,
      uninstaller: 0,
    });
    assert.equal(receipt.files.length, 10);
    assert.equal(receipt.files.some(({ path }) => path === WINDOWS_PRODUCTION_AUTHENTICODE_UNINSTALLER), false);
    const serialized = serializeWindowsProductionAuthenticodeInventoryReceipt(receipt);
    assert.equal(Buffer.byteLength(serialized, "utf8") < 64 * 1024, true);
    assert.equal(serialized.includes(fixture.parent), false);
    assert.equal(serialized.includes("SignerCertificate"), false);
    assert.deepEqual(
      parseWindowsProductionAuthenticodeInventoryReceipt(serialized, BINDING),
      receipt,
    );
    assert.throws(
      () => parseWindowsProductionAuthenticodeInventoryReceipt(`${serialized} `, BINDING),
      expectCode(STATUS.receiptInvalid),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects missing, extra, duplicate, and case-colliding inventory paths", () => {
  const missing = evidence({
    files: evidence().files.filter((row) => row.role !== "electron-dll" || row.path !== DLLS[1]),
  });
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(missing),
    expectCode(STATUS.missingEntry),
  );

  const extra = evidence({
    files: evidence().files.map((row) => row.role === "electron-dll" && row.path === DLLS[1]
      ? { ...row, path: "vulkan-1.dll" }
      : row),
  });
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(extra),
    expectCode(STATUS.extraEntry),
  );

  const duplicate = evidence({
    files: [...evidence().files, evidence().files[0]],
  });
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(duplicate),
    expectCode(STATUS.extraEntry),
  );

  const collision = evidence({
    files: evidence().files.map((row) => row.path === DLLS[0]
      ? { ...row, path: "D3DCOMPILER_47.dll" }
      : row),
  });
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(collision),
    expectCode(STATUS.caseCollision),
  );
});

test("rejects links, path leaks, raw diagnostics, and full certificate blobs", () => {
  const linked = evidence({
    files: evidence().files.map((row) => row.role === "installer"
      ? { ...row, linkStatus: "reparse-point" }
      : row),
  });
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(linked),
    expectCode(STATUS.linkRejected),
  );

  const absolute = evidence({
    files: evidence().files.map((row) => row.role === "installer"
      ? { ...row, path: `/outside/TiboTattle-${VERSION}-Windows-x64.exe` }
      : row),
  });
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(absolute),
    expectCode(STATUS.pathLeak),
  );

  const diagnostics = evidence({
    files: evidence().files.map((row) => row.role === "installer"
      ? { ...row, authenticode: { ...row.authenticode, diagnostics: "raw" } }
      : row),
  });
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(diagnostics),
    expectCode(STATUS.signatureInvalid),
  );

  const certificate = evidence({
    files: evidence().files.map((row) => row.role === "installer"
      ? { ...row, authenticode: { ...row.authenticode, certificate: { raw: "AA==" } } }
      : row),
  });
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(certificate),
    expectCode(STATUS.signatureInvalid),
  );
});

test("requires Valid, timestamped, exact-SimpleName, signtool PA evidence", () => {
  for (const [field, value] of [
    ["status", "Unknown"],
    ["publisher", "Adam Allcock, Inc."],
    ["timestampPresent", false],
    ["policy", "authenticode"],
    ["signtoolPaValid", false],
  ]) {
    const invalid = evidence({
      files: evidence().files.map((row) => row.role === "installer"
        ? { ...row, authenticode: authenticode({ [field]: value }) }
        : row),
    });
    assert.throws(
      () => verifyWindowsProductionAuthenticodeInventory(invalid),
      expectCode(STATUS.signatureInvalid),
    );
  }
  const fullSubject = evidence({
    files: evidence().files.map((row) => row.role === "installer"
      ? { ...row, authenticode: { ...row.authenticode, subject: "CN=Adam Allcock" } }
      : row),
  });
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(fullSubject),
    expectCode(STATUS.signatureInvalid),
  );
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(
      evidence({ probeMode: "native-windows" }),
    ),
    expectCode(STATUS.probeModeInvalid),
  );
});

test("binds revision, version, installer digest, and publisher", () => {
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(evidence(), {
      ...BINDING,
      revision: "b".repeat(40),
    }),
    expectCode(STATUS.bindingMismatch),
  );
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(evidence(), {
      ...BINDING,
      packageVersion: "0.1.17",
    }),
    expectCode(STATUS.bindingMismatch),
  );
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(evidence(), {
      ...BINDING,
      installerSha256: "e".repeat(64),
    }),
    expectCode(STATUS.bindingMismatch),
  );
  assert.throws(
    () => verifyWindowsProductionAuthenticodeInventory(evidence(), {
      ...BINDING,
      publisher: "Another Publisher",
    }),
    expectCode(STATUS.bindingMismatch),
  );
});

test("native PowerShell probe is closed and platform-gated", () => {
  const command = buildWindowsProductionAuthenticodeProbeCommand("C:\\safe\\TiboTattle.exe");
  assert.match(command, /Get-Item -LiteralPath/u);
  assert.match(command, /ReparsePoint/u);
  assert.match(command, /FileShare\]::Read/u);
  assert.match(command, /Get-AuthenticodeSignature/u);
  assert.match(command, /GetNameInfo\(/u);
  assert.match(command, /signtool\.exe verify \/pa \/all/u);
  assert.doesNotMatch(command, /SignerCertificate \|/u);
  assert.doesNotMatch(command, /Format-List/u);

  assert.throws(
    () => runWindowsProductionAuthenticodeProbe("/private/tmp/TiboTattle.exe", {
      platform: "darwin",
    }),
    expectCode(STATUS.platformRequired),
  );

  const calls = [];
  const aggregate = runWindowsProductionAuthenticodeProbe("C:\\safe\\TiboTattle.exe", {
    platform: "win32",
    spawn: (...args) => {
      calls.push(args);
      return {
        status: 0,
        stdout: JSON.stringify({
          ...authenticode(),
          bytes: 123,
          sha256: "a".repeat(64),
        }),
      };
    },
  });
  assert.deepEqual(aggregate, {
    ...authenticode(),
    bytes: 123,
    sha256: "a".repeat(64),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "powershell.exe");
  assert.deepEqual(calls[0][1].slice(0, 2), ["-NoLogo", "-NoProfile"]);
  assert.match(calls[0][1].at(-1), /SHA256\]::Create/u);
  assert.match(calls[0][1].at(-1), /bytes = \[int64\]\$bytes/u);
  assert.match(calls[0][1].at(-1), /sha256 = \$sha256/u);
  assert.throws(
    () => runWindowsProductionAuthenticodeProbe("C:\\safe\\TiboTattle.exe", {
      platform: "win32",
      spawn: () => ({
        status: 0,
        stdout: JSON.stringify(authenticode()),
      }),
    }),
    expectCode(STATUS.probeInvalid),
  );
});

test("portable collection uses injected capture/probe functions only", async () => {
  const fixture = await createFixture();
  try {
    const calls = [];
    const receipt = await buildFixtureReceipt(fixture, {
      probe: async (path) => {
        calls.push(path);
        return authenticode();
      },
    });
    assert.equal(receipt.status, WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS);
    assert.equal(calls.length, 10);
    assert.equal(calls.every((path) => path.startsWith(fixture.parent)), true);
    assert.equal(JSON.stringify(receipt).includes(fixture.parent), false);
  } finally {
    await fixture.cleanup();
  }
});

test("derives relative subjects from sealed roots and rejects path forgery", async () => {
  const fixture = await createFixture();
  try {
    const observed = [];
    await buildFixtureReceipt(fixture, {
      captureFile: async (path) => {
        observed.push(path);
        return captureFile(path);
      },
    });
    assert.equal(observed.length, 20);
    const observedRelative = observed.map((path) => relative(fixture.productionRoot, path));
    assert.equal(
      observedRelative.every((path) => path.length > 0 && !isAbsolute(path)),
      true,
    );
    assert.equal(
      observedRelative.every((path) => !path.split(sep).includes("..")),
      true,
    );
    assert.equal(observed.some((path) => path === WINDOWS_PRODUCTION_AUTHENTICODE_ARTIFACTS_ROOT), false);

    await assert.rejects(
      () => buildWindowsProductionAuthenticodeInventory({
        revision: REVISION,
        packageVersion: VERSION,
        publisher: WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
        files: [{ absolutePath: "/outside.exe", path: "TiboTattle.exe", role: "main-executable" }],
      }, {
        platform: "darwin",
        testOnly: true,
        testRoot: fixture.productionRoot,
        captureFile,
        probe: async () => authenticode(),
      }),
      expectCode(STATUS.inputInvalid),
    );
    await assert.rejects(
      () => buildWindowsProductionAuthenticodeInventory({
        revision: REVISION,
        packageVersion: VERSION,
        publisher: WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
        expectedDlls: ["arbitrary.dll"],
      }, {
        platform: "darwin",
        testOnly: true,
        testRoot: fixture.productionRoot,
        captureFile,
        probe: async () => authenticode(),
      }),
      expectCode(STATUS.inputInvalid),
    );
    await assert.rejects(
      () => buildFixtureReceipt(fixture, {
        testOnly: false,
        testRoot: "//server/share/tibotattle",
      }),
      expectCode(STATUS.rootsInvalid),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("portable collection cannot silently invoke a native probe", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      () => buildFixtureReceipt(fixture, { probe: undefined }),
      expectCode(STATUS.platformRequired),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("re-captures every PE after probing to close the byte mutation window", async () => {
  const fixture = await createFixture();
  try {
    let calls = 0;
    await assert.rejects(
      () => buildFixtureReceipt(fixture, {
        captureFile: async (path) => {
          const captured = await captureFile(path);
          calls += 1;
          if (calls === 2) {
            return {
              ...captured,
              bytes: captured.bytes + 1,
              sha256: "e".repeat(64),
            };
          }
          return captured;
        },
      }),
      expectCode(STATUS.probeInvalid),
    );
    assert.equal(calls, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("captured collector roots are revalidated when a root swaps during collection", async () => {
  const fixture = await createFixture();
  try {
    const rootState = async (path) => {
      const metadata = await lstat(path);
      return {
        dev: metadata.dev,
        ino: metadata.ino,
        path,
        platform: "darwin",
      };
    };
    const rootStates = {
      artifacts: await rootState(fixture.artifactsRoot),
      evidence: await rootState(fixture.evidenceRoot),
      production: await rootState(fixture.productionRoot),
      winUnpacked: await rootState(fixture.winUnpackedRoot),
    };
    let swapped = false;
    const movedRoot = join(fixture.parent, "swapped-production");
    await assert.rejects(
      () => buildWindowsProductionAuthenticodeProbeEvidence({
        revision: REVISION,
        packageVersion: VERSION,
        publisher: WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
      }, {
        platform: "darwin",
        rootStates,
        captureFile: async (path) => {
          const captured = await captureFile(path);
          if (!swapped) {
            swapped = true;
            await rename(fixture.productionRoot, movedRoot);
            await mkdir(fixture.productionRoot);
          }
          return captured;
        },
        probe: async () => authenticode(),
      }),
      expectCode(STATUS.rootReplaced),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a parent junction/symlink and a symlinked PE subject", async () => {
  const fixture = await createFixture();
  try {
    const moved = join(fixture.parent, "moved-artifacts");
    await symlink(fixture.artifactsRoot, moved, "junction").catch(async () => {
      await symlink(fixture.artifactsRoot, moved, "dir");
    });
    const forgedRoot = join(fixture.parent, "forged-production");
    await mkdir(forgedRoot);
    await symlink(moved, join(forgedRoot, "artifacts"), "dir");
    await assert.rejects(
      () => buildFixtureReceipt({ ...fixture, productionRoot: forgedRoot }),
      (error) => error.code === STATUS.rootsInvalid || error.code === STATUS.linkRejected,
    );

    const target = join(fixture.winUnpackedRoot, "real.dll");
    await writeFile(target, "real\n", "utf8");
    const linked = join(fixture.winUnpackedRoot, WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST[0]);
    await rm(linked);
    await symlink(target, linked);
    await assert.rejects(
      () => buildFixtureReceipt(fixture),
      expectCode(STATUS.linkRejected),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("receipt rows recompute the aggregate and reject tampering", async () => {
  const fixture = await createFixture();
  try {
    const receipt = await buildFixtureReceipt(fixture);
    const hashTampered = {
      ...receipt,
      files: receipt.files.map((row, index) => index === 0
        ? { ...row, sha256: "e".repeat(64) }
        : row),
    };
    assert.throws(
      () => validateWindowsProductionAuthenticodeInventoryReceipt(hashTampered, BINDING),
      expectCode(STATUS.receiptInvalid),
    );
    const aggregateTampered = {
      ...receipt,
      inventory: { ...receipt.inventory, bytes: receipt.inventory.bytes + 1 },
    };
    assert.throws(
      () => validateWindowsProductionAuthenticodeInventoryReceipt(aggregateTampered, BINDING),
      expectCode(STATUS.receiptInvalid),
    );
    const pathTampered = {
      ...receipt,
      files: receipt.files.map((row, index) => index === 0
        ? { ...row, path: "/outside/TiboTattle.exe" }
        : row),
    };
    assert.throws(
      () => validateWindowsProductionAuthenticodeInventoryReceipt(pathTampered, BINDING),
      expectCode(STATUS.pathLeak),
    );
    const deferredTampered = {
      ...receipt,
      deferred: { reason: "accepted", status: "verified" },
    };
    assert.throws(
      () => validateWindowsProductionAuthenticodeInventoryReceipt(deferredTampered, BINDING),
      expectCode(STATUS.deferredInvalid),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("production entrypoints have a closed zero-argument shape and reject injected claims", async () => {
  await assert.rejects(
    () => runWindowsProductionAuthenticodeInventory({ probeMode: "native-windows" }),
    expectCode(STATUS.optionsInvalid),
  );
  const fixture = await createFixture();
  try {
    const receipt = await buildFixtureReceipt(fixture);
    await assert.rejects(
      () => writeWindowsProductionAuthenticodeInventoryReceipt(receipt),
      process.platform === "win32"
        ? expectCode(STATUS.probeModeInvalid)
        : expectCode(STATUS.platformRequired),
    );
    if (process.platform !== "win32") {
      await assert.rejects(
        () => runWindowsProductionAuthenticodeInventory(),
        expectCode(STATUS.platformRequired),
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("native composition rejects injected and forged canonical receipts", async () => {
  const fixture = await createFixture();
  try {
    const injected = await buildFixtureReceipt(fixture);
    assert.throws(
      () => assertNativeWindowsProductionAuthenticodeInventoryReceipt(injected),
      expectCode(STATUS.probeModeInvalid),
    );
    const forged = JSON.parse(
      serializeWindowsProductionAuthenticodeInventoryReceipt({
        ...injected,
        probeMode: "native-windows",
      }),
    );
    assert.throws(
      () => assertNativeWindowsProductionAuthenticodeInventoryReceipt(forged),
      expectCode(STATUS.probeModeInvalid),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("portable receipt publication is canonical, transactional, and no-clobber", async () => {
  const fixture = await createFixture();
  try {
    const receipt = await buildFixtureReceipt(fixture);
    assert.equal(
      WINDOWS_PRODUCTION_AUTHENTICODE_EVIDENCE_ROOT.toLowerCase().endsWith("evidence"),
      true,
    );
    const result = await writeWindowsProductionAuthenticodeInventoryReceiptForTest(
      fixture.evidenceRoot,
      receipt,
    );
    const outputPath = join(fixture.evidenceRoot, WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_FILE);
    assert.equal(result.path, outputPath);
    assert.equal(await readFile(outputPath, "utf8"), serializeWindowsProductionAuthenticodeInventoryReceipt(receipt));
    await assert.rejects(
      () => writeWindowsProductionAuthenticodeInventoryReceiptForTest(
        fixture.evidenceRoot,
        receipt,
      ),
      expectCode(STATUS.outputExists),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("portable receipt publication rejects hard-linked output and root replacement", async () => {
  const fixture = await createFixture();
  try {
    const receipt = await buildFixtureReceipt(fixture);
    const outputPath = join(fixture.evidenceRoot, WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_FILE);
    const existing = join(fixture.evidenceRoot, "existing.json");
    await writeFile(existing, "existing\n", "utf8");
    await link(existing, outputPath);
    await assert.rejects(
      () => writeWindowsProductionAuthenticodeInventoryReceiptForTest(
        fixture.evidenceRoot,
        receipt,
      ),
      expectCode(STATUS.linkRejected),
    );
    await rm(outputPath);
    await rm(existing);

    const movedRoot = join(fixture.parent, "moved-evidence");
    await assert.rejects(
      () => writeWindowsProductionAuthenticodeInventoryReceiptForTest(
        fixture.evidenceRoot,
        receipt,
        {
          beforeOutputPublish: async () => {
            await rename(fixture.evidenceRoot, movedRoot);
            await mkdir(fixture.evidenceRoot);
          },
        },
      ),
      expectCode(STATUS.rootReplaced),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("native Windows junction qualification is skipped off Windows", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture();
  try {
    const receipt = await buildFixtureReceipt(fixture);
    const movedRoot = join(fixture.parent, "moved-evidence");
    await rename(fixture.evidenceRoot, movedRoot);
    await symlink(movedRoot, fixture.evidenceRoot, "junction");
    await assert.rejects(
      () => writeWindowsProductionAuthenticodeInventoryReceiptForTest(
        fixture.evidenceRoot,
        receipt,
      ),
      (error) => error.code === STATUS.rootsInvalid || error.code === STATUS.linkRejected,
    );
  } finally {
    await fixture.cleanup();
  }
});
