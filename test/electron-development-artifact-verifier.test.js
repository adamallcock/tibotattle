import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ELECTRON_SHELL_RUNTIME_FILES,
} from "../scripts/build-electron-runtime.mjs";
import {
  ELECTRON_SHELL_FILES,
  FIXED_STATUS,
  normalizeArchivePath,
  parseArguments,
  parseFixedStatusOutput,
  verifyElectronDevelopmentArtifact,
} from "../scripts/verify-electron-development-artifact.mjs";

const require = createRequire(import.meta.url);
const asar = createRequire(require.resolve("electron-builder"))("@electron/asar");
const SHELL_FILES = [
  "apps/electron/companion-supervisor.js",
  "apps/electron/desktop-command.js",
  "apps/electron/desktop-contract.js",
  "apps/electron/desktop-codex-roots.js",
  "apps/electron/desktop-deep-links.js",
  "apps/electron/desktop-diagnostics.js",
  "apps/electron/desktop-controller.js",
  "apps/electron/desktop-copy.js",
  "apps/electron/desktop-first-run.js",
  "apps/electron/desktop-first-run-login.js",
  "apps/electron/desktop-hosted-signin.js",
  "apps/electron/desktop-recovery-settings.js",
  "apps/electron/desktop-ipc.js",
  "apps/electron/desktop-owned-downloads.js",
  "apps/electron/desktop-menu.js",
  "apps/electron/desktop-lifecycle.js",
  "apps/electron/desktop-notification-coordinator.js",
  "apps/electron/desktop-notification-delivery.js",
  "apps/electron/desktop-notification-policy.js",
  "apps/electron/desktop-platform-services.js",
  "apps/electron/desktop-runtime.js",
  "apps/electron/desktop-settings-backends.js",
  "apps/electron/desktop-settings-store.js",
  "apps/electron/desktop-sharing.js",
  "apps/electron/desktop-sharing-installation.js",
  "apps/electron/desktop-tray.js",
  "apps/electron/desktop-status-monitor.js",
  "apps/electron/desktop-tray-status.js",
  "apps/electron/errors.js",
  "apps/electron/loopback-policy.js",
  "apps/electron/main.js",
  "apps/electron/platform-gate.js",
  "apps/electron/preload.cjs",
  "apps/electron/recovery-preload.cjs",
  "apps/electron/recovery-window.js",
  "apps/electron/ready-line.js",
  "apps/electron/windows-qualification.js",
  "config/deployment-endpoints.js",
  "src/desktop-shell-status.js",
  "src/platform/windows-credential-manager-probe.js",
];
const KEYTAR = Object.freeze({
  "darwin-arm64": "node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node",
  "win32-x64": "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
});
const WINDOWS_BINDING =
  "native/windows-filesystem/build/Release/windows_filesystem.node";
const WINDOWS_BINDING_MANIFEST = `${WINDOWS_BINDING}.manifest.json`;
const REAL_MAC_STAGED_APP = resolve(".release-build/electron-dev/mac-arm64/app");
const REAL_MAC_ASAR = resolve(
  ".release-build/electron-dev/artifacts/mac-arm64/TiboTattle Dev.app/Contents/Resources/app.asar",
);
const REAL_MAC_UNPACKED = `${REAL_MAC_ASAR}.unpacked`;
const REAL_MAC_ARTIFACT_AVAILABLE = [
  REAL_MAC_STAGED_APP,
  REAL_MAC_ASAR,
  REAL_MAC_UNPACKED,
].every((path) => existsSync(path));

test("packager and verifier retain the exact same Electron shell closure", () => {
  assert.deepEqual(
    [...ELECTRON_SHELL_FILES].sort(),
    [...ELECTRON_SHELL_RUNTIME_FILES].sort(),
  );
  assert.deepEqual(
    [...new Set(SHELL_FILES)].sort(),
    [...ELECTRON_SHELL_FILES].sort(),
  );
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function payloadDigest(rows) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of [...rows].sort((left, right) => left.path.localeCompare(right.path))) {
    bytes += row.bytes;
    hash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function archiveLookupPath(path) {
  return process.platform === "win32" ? path.replaceAll("/", "\\") : path;
}

function bindingManifest(bytes) {
  return {
    schemaVersion: "windows-filesystem-binding-manifest-v1",
    bindingFile: "windows_filesystem.node",
    platform: "win32",
    architecture: "x64",
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    companionInstanceMutexContractVersion: "windows-companion-instance-mutex-v1",
    preparedArtifactContractVersion: "windows-prepared-artifact-v1",
    requiredMethods: [
      "inspectPath",
      "ensureDirectory",
      "readFile",
      "readFileBounded",
      "createFile",
      "deleteFile",
      "replaceFile",
      "inspectProtectedChild",
      "readProtectedChild",
      "createProtectedChild",
      "deleteProtectedChild",
      "replaceProtectedChild",
      "acquireSqliteStateLease",
      "releaseSqliteStateLease",
      "acquireCredentialAuditFileGuard",
      "releaseCredentialAuditFileGuard",
      "acquireCredentialMutex",
      "releaseCredentialMutex",
      "acquireCompanionInstanceMutex",
      "releaseCompanionInstanceMutex",
      "inspectPreparedChild",
      "ensurePreparedDirectory",
      "enumeratePreparedDirectory",
      "removePreparedDirectory",
      "renamePreparedDirectory",
      "createPreparedFile",
      "readPreparedFile",
      "deletePreparedFile",
      "publishPreparedFile",
    ],
    nativeClaims: {
      productionSafe: false,
      pathWalkRaceSafe: false,
      credentialMutexSafe: true,
      companionInstanceMutexSafe: false,
      credentialAuditFileGuardSafe: true,
      sqliteStateLeaseSafe: false,
      preparedArtifactSafe: false,
    },
    approvedPolicy: {
      productionSafe: false,
      pathWalkRaceSafe: false,
      credentialMutexSafe: true,
      companionInstanceMutexSafe: false,
      credentialAuditFileGuardSafe: true,
      sqliteStateLeaseSafe: false,
      preparedArtifactSafe: false,
    },
    bindingProvenance: {
      contractVersion: "windows-binding-provenance-v1",
      status: "unqualified",
      source: "unsigned-development-binding",
    },
  };
}

async function writeRelative(root, path, bytes) {
  const destination = join(root, ...path.split("/"));
  await mkdir(resolve(destination, ".."), { recursive: true });
  await writeFile(destination, bytes);
}

async function makeFixture(
  target,
  {
    bindingManifestMutation = null,
    foreignUnpacked = null,
    extraArchive = null,
    keytarMutation = null,
    physicalUnpackedMutation = null,
    unpackPattern = "**/*.node",
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-artifact-"));
  const appPath = join(root, "app");
  const archiveSource = join(root, "archive-source");
  const asarPath = join(root, "app.asar");
  const unpackedPath = join(root, "app.asar.unpacked");
  await mkdir(appPath, { recursive: true });
  await mkdir(archiveSource, { recursive: true });
  await mkdir(unpackedPath, { recursive: true });

  const files = new Map([
    ["package.json", Buffer.from(JSON.stringify({
      main: "apps/electron/main.js",
      name: "app-usagemonitor",
      private: true,
      type: "module",
      version: "0.1.12",
    }) + "\n")],
    ["apps/local/server.js", Buffer.from("export default {};\n")],
    ["apps/web/public/index.html", Buffer.from("<!doctype html>\n")],
  ]);
  for (const path of SHELL_FILES) files.set(path, Buffer.from(`// ${path}\n`));

  const keytar = target === "win32-x64"
    ? Buffer.from(await readFile(require.resolve(
      "@github/keytar/prebuilds/win32-x64/keytar.node",
    )))
    : Buffer.from(`${target} keytar bytes\n`);
  const fixtureKeytar = keytarMutation === null
    ? keytar
    : Buffer.from(keytarMutation(Buffer.from(keytar)));
  files.set(KEYTAR[target], fixtureKeytar);
  const binding = Buffer.from("reviewed Windows production binding\n");
  if (target === "win32-x64") {
    files.set(WINDOWS_BINDING, binding);
    const sidecar = bindingManifest(binding);
    bindingManifestMutation?.(sidecar);
    files.set(
      WINDOWS_BINDING_MANIFEST,
      Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`),
    );
  }

  const kinds = new Map([
    ["package.json", "runtime_metadata"],
    ["apps/local/server.js", "companion_source"],
    ["apps/web/public/index.html", "dashboard_asset"],
    ...SHELL_FILES.map((path) => [path, "electron_shell"]),
    [KEYTAR[target], "third_party_dependency"],
  ]);
  if (target === "win32-x64") {
    kinds.set(WINDOWS_BINDING, "windows_native_binding");
    kinds.set(WINDOWS_BINDING_MANIFEST, "windows_native_binding");
  }
  for (const [path, bytes] of files) await writeRelative(appPath, path, bytes);
  const rows = [...files.entries()]
    .map(([path, bytes]) => ({
      bytes: bytes.byteLength,
      kind: kinds.get(path),
      path,
      sha256: sha256(bytes),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const runtimeManifest = {
    schemaVersion: "usage-monitor-electron-runtime-v0.1",
    target: target === "win32-x64" ? "win32" : "darwin",
    architecture: target === "win32-x64" ? "x64" : "arm64",
    releaseVersion: "0.1.12",
    entrypoint: "apps/electron/main.js",
    dashboardRoot: "apps/web/public",
    files: rows,
    payload: payloadDigest(rows),
    windowsBinding: target === "win32-x64"
      ? {
        binding: {
          bytes: binding.byteLength,
          path: WINDOWS_BINDING,
          sha256: sha256(binding),
        },
        included: true,
        manifest: { path: WINDOWS_BINDING_MANIFEST },
        status: "included_unverified",
        verified: false,
      }
      : {
        included: false,
        status: "not_requested",
        verified: false,
      },
  };
  const runtimeManifestBytes = Buffer.from(`${JSON.stringify(runtimeManifest, null, 2)}\n`);
  await writeRelative(appPath, "electron-runtime-manifest.json", runtimeManifestBytes);

  for (const [path, bytes] of files) {
    await writeRelative(archiveSource, path, bytes);
  }
  await writeRelative(archiveSource, "electron-runtime-manifest.json", runtimeManifestBytes);
  if (extraArchive) {
    await writeRelative(archiveSource, extraArchive, Buffer.from("unexpected archive file\n"));
  }
  await asar.createPackageWithOptions(archiveSource, asarPath, {
    // Exercise the same asar header metadata electron-builder emits for its
    // target-specific asarUnpack rules. The native files are copied into the
    // adjacent .asar.unpacked directory by @electron/asar itself.
    unpack: unpackPattern,
  });
  await physicalUnpackedMutation?.({
    binding,
    keytar: fixtureKeytar,
    target,
    unpackedPath,
  });
  if (foreignUnpacked) {
    await writeRelative(unpackedPath, foreignUnpacked, Buffer.from("foreign native\n"));
  }
  return { root, appPath, asarPath, unpackedPath, binding };
}

async function withFixture(target, options, run) {
  const fixture = await makeFixture(target, options);
  try {
    return await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function verify(fixture, target) {
  return verifyElectronDevelopmentArtifact({
    target,
    appPath: fixture.appPath,
    asarPath: fixture.asarPath,
    unpackedPath: fixture.unpackedPath,
  });
}

test("verifies a macOS arm64 archive/unpacked union with aggregate-only output", async () => {
  await withFixture("darwin-arm64", {}, async (fixture) => {
    const result = await verify(fixture, "darwin-arm64");
    assert.equal(result.status, FIXED_STATUS.verified);
    assert.equal(result.target, "darwin-arm64");
    assert.equal(result.nativeFileCount, 1);
    assert.equal(result.binding.status, "not_applicable");
    assert.equal(result.staged.count, result.artifact.count);
    assert.equal(result.staged.bytes > result.unpacked.bytes, true);
    assert.equal(result.staged.sha256, result.artifact.sha256);
    // Compare against JSON's escaped representation so this remains a real
    // leak check when the fixture root contains Windows backslashes.
    const escapedFixtureRoot = JSON.stringify(fixture.root).slice(1, -1);
    assert.equal(JSON.stringify(result).includes(escapedFixtureRoot), false);
    assert.deepEqual(Object.keys(result).sort(), [
      "asar", "artifact", "binding", "nativeFileCount", "staged", "status", "target", "unpacked",
    ].sort());
  });
});

test("verifies the rebuilt macOS arm64 Electron directory artifact when present", {
  skip: !REAL_MAC_ARTIFACT_AVAILABLE,
}, async () => {
  const result = await verifyElectronDevelopmentArtifact({
    target: "darwin-arm64",
    appPath: REAL_MAC_STAGED_APP,
    asarPath: REAL_MAC_ASAR,
    unpackedPath: REAL_MAC_UNPACKED,
  });
  assert.equal(result.status, FIXED_STATUS.verified);
  assert.equal(result.target, "darwin-arm64");
  assert.equal(result.staged.count, result.artifact.count);
  assert.equal(result.nativeFileCount, 1);
});

test("verifies Windows x64 binding and sidecar digests without promoting provenance", async () => {
  await withFixture("win32-x64", {}, async (fixture) => {
    const result = await verify(fixture, "win32-x64");
    assert.equal(result.status, FIXED_STATUS.verified);
    assert.equal(result.nativeFileCount, 2);
    assert.equal(result.binding.status, "included_unverified");
    assert.equal(result.binding.bytes, fixture.binding.byteLength);
    assert.equal(result.binding.sha256, sha256(fixture.binding));
    assert.equal(result.staged.sha256, result.artifact.sha256);
  });
});

test("round-trips every Windows ASAR list entry through native lookups", {
  skip: process.platform !== "win32",
}, async () => {
  await withFixture("win32-x64", {}, async (fixture) => {
    // The full verifier exercises the production canonicalization and lookup
    // path conversion before the explicit per-entry assertions below.
    const result = await verify(fixture, "win32-x64");
    assert.equal(result.status, FIXED_STATUS.verified);

    const listed = asar.listPackage(fixture.asarPath);
    assert.equal(listed.length > 0, true);
    const canonical = listed.map((rawPath) => normalizeArchivePath(rawPath, "win32"));
    assert.equal(new Set(canonical).size, listed.length);

    for (const [index, rawPath] of listed.entries()) {
      assert.match(rawPath, /^\\[^\\]/u);
      assert.doesNotMatch(rawPath, /\//u);
      assert.doesNotMatch(canonical[index], /\\/u);
      const nativeLookupPath = canonical[index].replaceAll("/", "\\");
      const stat = asar.statFile(fixture.asarPath, nativeLookupPath);
      assert.equal(stat !== null && typeof stat === "object", true);
      if (stat.files !== undefined || stat.link !== undefined || stat.unpacked === true) {
        continue;
      }
      const bytes = asar.extractFile(fixture.asarPath, nativeLookupPath);
      assert.equal(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, true);
      assert.equal(bytes.byteLength, stat.size);
    }
  });
});

test("rejects a Windows keytar prebuild whose bytes do not match the pinned digest", async () => {
  await withFixture(
    "win32-x64",
    {
      keytarMutation: (bytes) => {
        bytes[0] ^= 0xff;
        return bytes;
      },
    },
    async (fixture) => {
      await assert.rejects(
        () => verify(fixture, "win32-x64"),
        (error) => error.code === FIXED_STATUS.bindingInvalid
          && error.message === FIXED_STATUS.bindingInvalid
          && !error.message.includes(fixture.root),
      );
    },
  );
});

test("requires the exact versioned Windows sidecar schema and policy consistency", async () => {
  const cases = [
    {
      label: "missing top-level schema field",
      mutate: (sidecar) => {
        delete sidecar.requiredMethods;
      },
    },
    {
      label: "missing companion mutex contract field",
      mutate: (sidecar) => {
        delete sidecar.companionInstanceMutexContractVersion;
      },
    },
    {
      label: "extra top-level schema field",
      mutate: (sidecar) => {
        sidecar.unexpected = true;
      },
    },
    {
      label: "wrong required method order",
      mutate: (sidecar) => {
        sidecar.requiredMethods.reverse();
      },
    },
    {
      label: "extra native claim field",
      mutate: (sidecar) => {
        sidecar.nativeClaims.extra = false;
      },
    },
    {
      label: "policy and native claim disagreement",
      mutate: (sidecar) => {
        sidecar.nativeClaims.credentialMutexSafe = false;
      },
    },
    {
      label: "missing approved policy field",
      mutate: (sidecar) => {
        delete sidecar.approvedPolicy.pathWalkRaceSafe;
      },
    },
  ];
  for (const { label, mutate } of cases) {
    await withFixture(
      "win32-x64",
      { bindingManifestMutation: mutate },
      async (fixture) => {
        await assert.rejects(
          () => verify(fixture, "win32-x64"),
          (error) => error.code === FIXED_STATUS.bindingInvalid
            && error.message === FIXED_STATUS.bindingInvalid
            && !error.message.includes(fixture.root),
          label,
        );
      },
    );
  }
});

test("keeps the Windows native sidecar in virtual ASAR beside an unpacked .node", async () => {
  await withFixture("win32-x64", {}, async (fixture) => {
    const bindingStat = asar.statFile(
      fixture.asarPath,
      archiveLookupPath(WINDOWS_BINDING),
    );
    const sidecarStat = asar.statFile(
      fixture.asarPath,
      archiveLookupPath(WINDOWS_BINDING_MANIFEST),
    );
    assert.equal(bindingStat.unpacked, true);
    assert.notEqual(sidecarStat.unpacked, true);
    assert.equal(
      existsSync(join(fixture.unpackedPath, ...WINDOWS_BINDING.split("/"))),
      true,
    );
    assert.equal(
      existsSync(join(fixture.unpackedPath, ...WINDOWS_BINDING_MANIFEST.split("/"))),
      false,
    );
    const result = await verify(fixture, "win32-x64");
    assert.equal(result.status, FIXED_STATUS.verified);
  });
});

test("rejects a physical unpacked native file without an ASAR unpack marker", async () => {
  await withFixture(
    "darwin-arm64",
    {
      physicalUnpackedMutation: async ({ keytar, unpackedPath }) => {
        await writeRelative(unpackedPath, KEYTAR["darwin-arm64"], keytar);
      },
      unpackPattern: "native/windows-filesystem/**/*.node",
    },
    async (fixture) => {
      await assert.rejects(
        () => verify(fixture, "darwin-arm64"),
        (error) => error.code === FIXED_STATUS.nativeInventoryInvalid
          && !error.message.includes(fixture.root),
      );
    },
  );
});

test("rejects an ASAR unpack marker without its physical unpacked file", async () => {
  await withFixture(
    "darwin-arm64",
    {
      physicalUnpackedMutation: async ({ unpackedPath }) => {
        await rm(
          join(unpackedPath, ...KEYTAR["darwin-arm64"].split("/")),
          { force: true },
        );
      },
    },
    async (fixture) => {
      await assert.rejects(
        () => verify(fixture, "darwin-arm64"),
        (error) => error.code === FIXED_STATUS.nativeInventoryInvalid
          && !error.message.includes(fixture.root),
      );
    },
  );
});

test("rejects qualification and other-platform native binaries", async () => {
  await withFixture(
    "win32-x64",
    { foreignUnpacked: "node_modules/@github/keytar/prebuilds/win32-ia32/keytar.node" },
    async (fixture) => {
      await assert.rejects(
        () => verify(fixture, "win32-x64"),
        (error) => error.code === FIXED_STATUS.nativeInventoryInvalid
          && error.message === FIXED_STATUS.nativeInventoryInvalid
          && !error.message.includes(fixture.root),
      );
    },
  );
  await withFixture(
    "darwin-arm64",
    { foreignUnpacked: "native/windows-filesystem/build/Release/windows_filesystem_qualification.node" },
    async (fixture) => {
      await assert.rejects(
        () => verify(fixture, "darwin-arm64"),
        (error) => error.code === FIXED_STATUS.nativeInventoryInvalid,
      );
    },
  );
});

test("rejects an unpacked directory that contains an extra non-native file", async () => {
  await withFixture("darwin-arm64", {}, async (fixture) => {
    await writeRelative(fixture.unpackedPath, "unexpected.txt", Buffer.from("unexpected\n"));
    await assert.rejects(
      () => verify(fixture, "darwin-arm64"),
      (error) => error.code === FIXED_STATUS.nativeInventoryInvalid
        && !error.message.includes(fixture.root),
    );
  });
});

test("rejects symlinked staged inputs instead of reading outside the app root", async () => {
  await withFixture("darwin-arm64", {}, async (fixture) => {
    const stagedLink = join(fixture.appPath, "apps/local/server.js");
    await rm(stagedLink);
    await symlink(join(fixture.appPath, "apps/electron/main.js"), stagedLink);
    await assert.rejects(
      () => verify(fixture, "darwin-arm64"),
      (error) => error.code === FIXED_STATUS.inputInvalid
        && error.message === FIXED_STATUS.inputInvalid
        && !error.message.includes(fixture.root),
    );
  });
});

test("rejects an archive containing a file outside the staged manifest", async () => {
  await withFixture("darwin-arm64", { extraArchive: "unexpected.txt" }, async (fixture) => {
    await assert.rejects(
      () => verify(fixture, "darwin-arm64"),
      (error) => error.code === FIXED_STATUS.inventoryMismatch
        && !error.message.includes(fixture.root),
    );
  });
});

test("rejects a Windows binding whose sidecar digest disagrees with the runtime manifest", async () => {
  await withFixture("win32-x64", {}, async (fixture) => {
    const sidecarPath = join(fixture.appPath, ...WINDOWS_BINDING_MANIFEST.split("/"));
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    sidecar.sha256 = "0".repeat(64);
    await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    await assert.rejects(
      () => verify(fixture, "win32-x64"),
      (error) => error.code === FIXED_STATUS.stagedInventoryInvalid
        && !error.message.includes(fixture.root),
    );
  });
});

test("fails closed for missing inputs without exposing their paths", async () => {
  await withFixture("darwin-arm64", {}, async (fixture) => {
    const missing = join(fixture.root, "missing.asar");
    await assert.rejects(
      () => verifyElectronDevelopmentArtifact({
        target: "darwin-arm64",
        appPath: fixture.appPath,
        asarPath: missing,
        unpackedPath: fixture.unpackedPath,
      }),
      (error) => error.code === FIXED_STATUS.inputMissing
        && error.message === FIXED_STATUS.inputMissing
        && !error.message.includes(fixture.root),
    );
  });
});

test("requires explicit target and artifact paths", () => {
  assert.deepEqual(parseArguments([
    "--target", "win32-x64",
    "--app", "/tmp/app",
    "--asar", "/tmp/app.asar",
    "--unpacked", "/tmp/app.asar.unpacked",
  ]), {
    target: "win32-x64",
    appPath: "/tmp/app",
    asarPath: "/tmp/app.asar",
    unpackedPath: "/tmp/app.asar.unpacked",
  });
  assert.throws(
    () => parseArguments(["--target", "windows"]),
    (error) => error.code === FIXED_STATUS.inputInvalid,
  );
});

test("normalizes Windows-rooted ASAR list paths on macOS", async () => {
  await withFixture("darwin-arm64", {}, async (fixture) => {
    const listed = asar.listPackage(fixture.asarPath);
    // @electron/asar emits paths with the host platform's separator. Build
    // both explicitly rooted representations from the canonical inventory so
    // this contract remains meaningful on both POSIX and Windows hosts.
    const canonicalPaths = listed.map((path) => normalizeArchivePath(
      path,
      process.platform,
    ));
    const posixPaths = canonicalPaths.map((path) => normalizeArchivePath(
      `/${path}`,
      "darwin",
    ));
    const windowsPaths = canonicalPaths.map((path) => normalizeArchivePath(
      `\\${path.replaceAll("/", "\\")}`,
      "win32",
    ));
    assert.deepEqual(windowsPaths.sort(), posixPaths.sort());
    assert.equal(
      normalizeArchivePath(String.raw`\apps\electron\main.js`, "win32"),
      "apps/electron/main.js",
    );
  });
});

test("rejects non-canonical ASAR list paths", () => {
  const invalid = [
    ["win32", "apps\\electron\\main.js"],
    ["win32", "/apps/electron/main.js"],
    ["win32", String.raw`\apps/electron/main.js`],
    ["win32", String.raw`\apps\\electron\main.js`],
    ["win32", String.raw`\\server\share\main.js`],
    ["win32", String.raw`C:\apps\main.js`],
    ["win32", String.raw`\C:\apps\main.js`],
    ["win32", String.raw`\apps\.\main.js`],
    ["win32", String.raw`\apps\..\main.js`],
    ["win32", `\\apps\\main\0.js`],
    ["darwin", "apps/electron/main.js"],
    ["darwin", "//apps/electron/main.js"],
    ["darwin", "/apps//electron/main.js"],
    ["darwin", "/apps\\electron/main.js"],
    ["darwin", "/C:/apps/main.js"],
    ["darwin", "/apps/./main.js"],
    ["darwin", "/apps/../main.js"],
    ["darwin", "/apps/main\0.js"],
  ];
  for (const [platform, raw] of invalid) {
    assert.throws(
      () => normalizeArchivePath(raw, platform),
      (error) => error.code === FIXED_STATUS.archiveInvalid,
      `${platform}: ${JSON.stringify(raw)}`,
    );
  }
});

test("parses only one allowlisted content-free verifier status", () => {
  assert.equal(
    parseFixedStatusOutput(`${FIXED_STATUS.bindingInvalid}\r\n`),
    FIXED_STATUS.bindingInvalid,
  );
  assert.equal(
    parseFixedStatusOutput(`${FIXED_STATUS.inputMissing}\n`),
    FIXED_STATUS.inputMissing,
  );
  assert.equal(
    parseFixedStatusOutput(`${FIXED_STATUS.bindingInvalid}\nextra output\n`),
    FIXED_STATUS.failed,
  );
  assert.equal(
    parseFixedStatusOutput("ELECTRON_DEVELOPMENT_ARTIFACT_UNKNOWN\n"),
    FIXED_STATUS.failed,
  );
  assert.equal(
    parseFixedStatusOutput(`${FIXED_STATUS.verified}\n`),
    FIXED_STATUS.failed,
  );
  assert.equal(
    parseFixedStatusOutput(`${FIXED_STATUS.bindingInvalid} path=/private/secret\n`),
    FIXED_STATUS.failed,
  );
  assert.equal(parseFixedStatusOutput(null), FIXED_STATUS.failed);
});
