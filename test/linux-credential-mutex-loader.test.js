import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  LINUX_CREDENTIAL_MUTEX_BINDING_MANIFEST_SCHEMA_VERSION,
  LinuxCredentialMutexBindingError,
  linuxCredentialMutexBindingEvidence,
  loadLinuxCredentialMutexBinding,
  readLinuxCredentialMutexManifestFile,
  validateLinuxCredentialMutexBindingManifest,
} from "../src/platform/linux-credential-mutex.js";

const BYTES = Buffer.from("linux credential mutex native fixture", "utf8");

function binding(overrides = {}) {
  return {
    credentialMutexContractVersion: "linux-credential-mutex-v1",
    credentialMutexCrossProcessSafe: true,
    credentialMutexSameNetworkNamespaceOnly: true,
    credentialMutexDurableMarker: true,
    productionSafe: false,
    acquireCredentialMutex: () => ({ lease: Object.create(null), abandoned: false }),
    releaseCredentialMutex: () => {},
    abandonCredentialMutex: () => {},
    readAccountlessInstallationCredential: () => null,
    createAccountlessInstallationCredentialIfMissing: () => "created",
    deleteAccountlessInstallationCredentialExact: () => "deleted",
    ...overrides,
  };
}

function manifest(bytes = BYTES, overrides = {}) {
  return {
    schemaVersion: LINUX_CREDENTIAL_MUTEX_BINDING_MANIFEST_SCHEMA_VERSION,
    bindingFile: "linux_credential_mutex.node",
    platform: "linux",
    architecture: "x64",
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contractVersion: "linux-credential-mutex-v1",
    requiredMethods: [
      "acquireCredentialMutex",
      "releaseCredentialMutex",
      "abandonCredentialMutex",
      "readAccountlessInstallationCredential",
      "createAccountlessInstallationCredentialIfMissing",
      "deleteAccountlessInstallationCredentialExact",
    ],
    nativeClaims: {
      credentialMutexCrossProcessSafe: true,
      sameNetworkNamespaceOnly: true,
      durableAbandonmentMarker: true,
      productionSafe: false,
    },
    approvedPolicy: {
      credentialMutexCrossProcessSafe: true,
      sameNetworkNamespaceOnly: true,
      durableAbandonmentMarker: true,
      productionSafe: false,
    },
    ...overrides,
  };
}

function bindingError(code) {
  return (error) => {
    assert.equal(error instanceof LinuxCredentialMutexBindingError, true);
    assert.equal(error.code, `linux_credential_mutex_binding_${code}`);
    assert.equal(error.message, "Linux credential mutex binding failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

function syntheticLoader(overrides = {}) {
  const selectedBinding = binding();
  return {
    platform: "linux",
    architecture: "x64",
    resolveBinding(path) {
      return path;
    },
    verifyBindingPath: () => true,
    readManifest: () => JSON.stringify(manifest()),
    readBindingBytes: () => BYTES,
    requireBinding: () => selectedBinding,
    ...overrides,
  };
}

test("Linux credential mutex loader gates platform and architecture before a path is selected", () => {
  let resolverCalls = 0;
  for (const [platform, architecture, code] of [
    ["darwin", "arm64", "unsupported_platform"],
    ["win32", "x64", "unsupported_platform"],
    ["linux", "arm64", "unsupported_architecture"],
  ]) {
    assert.throws(
      () => loadLinuxCredentialMutexBinding({
        platform,
        architecture,
        resolveBinding() {
          resolverCalls += 1;
        },
      }),
      bindingError(code),
    );
  }
  assert.equal(resolverCalls, 0);
});

test("Linux credential mutex loader accepts only the fixed sidecar path and a safe regular file", () => {
  assert.throws(
    () => loadLinuxCredentialMutexBinding(syntheticLoader({
      resolveBinding: () => "/tmp/foreign/linux_credential_mutex.node",
    })),
    bindingError("binding_path_invalid"),
  );
  assert.throws(
    () => loadLinuxCredentialMutexBinding(syntheticLoader({
      verifyBindingPath: () => false,
    })),
    bindingError("binding_path_unsafe"),
  );
});

test("Linux credential mutex sidecar validator is pure, closed, and freezes its copy", () => {
  const candidate = manifest();
  const validated = validateLinuxCredentialMutexBindingManifest(candidate);
  assert.deepEqual(validated, candidate);
  assert.notEqual(validated, candidate);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.requiredMethods), true);
  assert.equal(Object.isFrozen(validated.nativeClaims), true);
  assert.throws(
    () => validateLinuxCredentialMutexBindingManifest(manifest(BYTES, {
      sha256: "A".repeat(64),
    })),
    bindingError("manifest_invalid"),
  );
});

test("Linux credential mutex loader maps only its module-owned app.asar binding to unpacked", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-mutex-asar-"));
  try {
    const canonicalRoot = await realpath(root);
    const virtualModulePath = join(
      canonicalRoot,
      "resources",
      "app.asar",
      "src",
      "platform",
      "linux-credential-mutex.js",
    );
    const virtualBindingPath = join(
      canonicalRoot,
      "resources",
      "app.asar",
      "native",
      "linux-credential-mutex",
      "build",
      "qualification",
      "linux_credential_mutex.node",
    );
    const unpackedBindingPath = join(
      canonicalRoot,
      "resources",
      "app.asar.unpacked",
      "native",
      "linux-credential-mutex",
      "build",
      "qualification",
      "linux_credential_mutex.node",
    );
    await mkdir(dirname(virtualModulePath), { recursive: true, mode: 0o700 });
    await copyFile(
      new URL("../src/platform/linux-credential-mutex.js", import.meta.url),
      virtualModulePath,
    );
    const copied = await import(`${pathToFileURL(virtualModulePath).href}?test=${Date.now()}`);
    const observed = [];
    const loaded = copied.loadLinuxCredentialMutexBinding({
      platform: "linux",
      architecture: "x64",
      resolveBinding(path) {
        observed.push(["resolve", path]);
        return path;
      },
      verifyBindingPath(path) {
        observed.push(["verify", path]);
        return path === unpackedBindingPath;
      },
      readManifest(path) {
        observed.push(["manifest", path]);
        return JSON.stringify(manifest());
      },
      readBindingBytes(path) {
        observed.push(["bytes", path]);
        return BYTES;
      },
      requireBinding(path) {
        observed.push(["require", path]);
        return binding();
      },
    });
    assert.equal(typeof loaded.acquireCredentialMutex, "function");
    assert.deepEqual(observed, [
      ["resolve", virtualBindingPath],
      ["verify", unpackedBindingPath],
      ["manifest", `${unpackedBindingPath}.manifest.json`],
      ["bytes", unpackedBindingPath],
      ["require", unpackedBindingPath],
      ["bytes", unpackedBindingPath],
    ]);
    assert.throws(
      () => copied.loadLinuxCredentialMutexBinding({
        ...syntheticLoader(),
        resolveBinding: () => join(
          canonicalRoot,
          "resources",
          "app.asar",
          "foreign",
          "linux_credential_mutex.node",
        ),
      }),
      (error) => error?.code === "linux_credential_mutex_binding_binding_path_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux credential mutex loader snapshots the closed native surface without production credit", () => {
  const original = binding();
  const loaded = loadLinuxCredentialMutexBinding(syntheticLoader({
    requireBinding: () => original,
  }));
  assert.equal(Object.isFrozen(loaded), true);
  assert.deepEqual(linuxCredentialMutexBindingEvidence(loaded), {
    target: "linux-x64",
    bytes: BYTES.byteLength,
    sha256: createHash("sha256").update(BYTES).digest("hex"),
    pathSafetyVerified: false,
    manifestPathSafetyVerified: false,
    bindingIntegrityVerifiedBeforeAndAfter: true,
    crossProcessScope: "same_linux_network_namespace",
    productionSafe: false,
  });
  original.acquireCredentialMutex = () => {
    throw new Error("mutated native export must not run");
  };
  assert.deepEqual(loaded.acquireCredentialMutex(0), {
    lease: Object.create(null),
    abandoned: false,
  });
});

test("Linux credential mutex loader rejects malformed claims and byte replacement", () => {
  assert.throws(
    () => loadLinuxCredentialMutexBinding(syntheticLoader({
      readManifest: () => JSON.stringify(manifest(BYTES, {
        approvedPolicy: {
          credentialMutexCrossProcessSafe: true,
          sameNetworkNamespaceOnly: true,
          durableAbandonmentMarker: true,
          productionSafe: true,
        },
      })),
    })),
    bindingError("manifest_invalid"),
  );
  assert.throws(
    () => loadLinuxCredentialMutexBinding(syntheticLoader({
      requireBinding: () => binding({ productionSafe: true }),
    })),
    bindingError("binding_invalid"),
  );
  assert.throws(
    () => loadLinuxCredentialMutexBinding(syntheticLoader({
      readBindingBytes: () => Buffer.from("replaced", "utf8"),
    })),
    bindingError("binding_integrity"),
  );
});

test("Linux credential mutex manifest reader pins a bounded regular sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-mutex-loader-"));
  try {
    const manifestPath = join(await realpath(root), "binding.manifest.json");
    await writeFile(manifestPath, "{\"safe\":true}\n", { mode: 0o600 });
    await chmod(manifestPath, 0o600);
    assert.equal(
      readLinuxCredentialMutexManifestFile(manifestPath).toString("utf8"),
      "{\"safe\":true}\n",
    );

    const symlinkPath = join(root, "binding.manifest.symlink.json");
    await symlink(manifestPath, symlinkPath);
    assert.throws(
      () => readLinuxCredentialMutexManifestFile(symlinkPath),
      bindingError("manifest_path_unsafe"),
    );

    const hardlinkPath = join(root, "binding.manifest.hardlink.json");
    await link(manifestPath, hardlinkPath);
    assert.throws(
      () => readLinuxCredentialMutexManifestFile(manifestPath),
      bindingError("manifest_path_unsafe"),
    );

    const oversizedPath = join(root, "binding.manifest.oversized.json");
    await writeFile(oversizedPath, Buffer.alloc(64 * 1024 + 1), { mode: 0o600 });
    await chmod(oversizedPath, 0o600);
    assert.throws(
      () => readLinuxCredentialMutexManifestFile(oversizedPath),
      bindingError("manifest_path_unsafe"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux credential mutex loader detects an after-load binary mutation", () => {
  let reads = 0;
  assert.throws(
    () => loadLinuxCredentialMutexBinding(syntheticLoader({
      readBindingBytes: () => {
        reads += 1;
        return reads === 1 ? BYTES : Buffer.from("changed after native load", "utf8");
      },
    })),
    bindingError("binding_mutated"),
  );
  assert.equal(reads, 2);
});

test("Linux credential mutex loader collapses hostile injected boundaries", () => {
  assert.throws(
    () => loadLinuxCredentialMutexBinding(syntheticLoader({
      readManifest() {
        throw new Error("manifest path must not escape");
      },
    })),
    bindingError("binding_unavailable"),
  );
  const hostile = new Proxy({}, {
    get() {
      throw new Error("binding export must not escape");
    },
  });
  assert.throws(
    () => loadLinuxCredentialMutexBinding(syntheticLoader({
      requireBinding: () => hostile,
    })),
    bindingError("binding_invalid"),
  );
});
