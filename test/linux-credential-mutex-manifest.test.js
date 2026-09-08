import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildLinuxCredentialMutexBindingManifest,
  createLinuxCredentialMutexBindingManifest,
  writeLinuxCredentialMutexManifestFile,
} from "../scripts/build-linux-credential-mutex-manifest.mjs";

const BYTES = Buffer.from("reviewed native linux mutex bytes", "utf8");

function binding(overrides = {}) {
  return {
    credentialMutexContractVersion: "linux-credential-mutex-v1",
    credentialMutexCrossProcessSafe: true,
    credentialMutexSameNetworkNamespaceOnly: true,
    credentialMutexDurableMarker: true,
    productionSafe: false,
    prepareLinuxCredentialState: () => {},
    acquireCredentialMutex: () => ({ lease: Object.create(null), abandoned: false }),
    releaseCredentialMutex: () => {},
    abandonCredentialMutex: () => {},
    readAccountlessInstallationCredential: () => null,
    createAccountlessInstallationCredentialIfMissing: () => "created",
    deleteAccountlessInstallationCredentialExact: () => "deleted",
    readAccountObservationCredential: () => Promise.resolve(null),
    createAccountObservationCredentialIfMissing: () => Promise.resolve("created"),
    ...overrides,
  };
}

test("Linux credential mutex manifest is deterministic, content-free, and production-disabled", () => {
  const manifest = createLinuxCredentialMutexBindingManifest({
    bytes: BYTES,
    binding: binding(),
  });
  assert.deepEqual(manifest, {
    schemaVersion: "linux-credential-mutex-binding-manifest-v1",
    bindingFile: "linux_credential_mutex.node",
    platform: "linux",
    architecture: "x64",
    bytes: BYTES.byteLength,
    sha256: createHash("sha256").update(BYTES).digest("hex"),
    contractVersion: "linux-credential-mutex-v1",
    requiredMethods: [
      "prepareLinuxCredentialState",
      "acquireCredentialMutex",
      "releaseCredentialMutex",
      "abandonCredentialMutex",
      "readAccountlessInstallationCredential",
      "createAccountlessInstallationCredentialIfMissing",
      "deleteAccountlessInstallationCredentialExact",
      "readAccountObservationCredential",
      "createAccountObservationCredentialIfMissing",
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
  });
  assert.equal(
    Object.keys(manifest).some((key) => /path|account|secret|content/iu.test(key)),
    false,
  );
});

test("Linux credential mutex manifest refuses broadening or malformed native claims", () => {
  for (const candidate of [
    binding({ productionSafe: true }),
    binding({ credentialMutexCrossProcessSafe: false }),
    binding({ credentialMutexSameNetworkNamespaceOnly: false }),
    binding({ credentialMutexDurableMarker: false }),
    binding({ prepareLinuxCredentialState: null }),
    binding({ abandonCredentialMutex: null }),
    binding({ acquireCredentialMutex: null }),
    binding({ createAccountlessInstallationCredentialIfMissing: null }),
    binding({ createAccountObservationCredentialIfMissing: null }),
  ]) {
    assert.throws(
      () => createLinuxCredentialMutexBindingManifest({ bytes: BYTES, binding: candidate }),
      (error) => error?.code === "linux_credential_mutex_manifest_invalid_binding",
    );
  }
});

test("Linux credential mutex manifest builder writes only a fixed sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-mutex-manifest-"));
  try {
    const manifestPath = join(
      await realpath(root),
      "linux_credential_mutex.node.manifest.json",
    );
    const result = await buildLinuxCredentialMutexBindingManifest({
      bindingPath: join(root, "linux_credential_mutex.node"),
      manifestPath,
      readBinding: async () => BYTES,
      loadBinding: () => binding(),
    });
    assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), result);
    const rewritten = await buildLinuxCredentialMutexBindingManifest({
      bindingPath: join(root, "linux_credential_mutex.node"),
      manifestPath,
      readBinding: async () => BYTES,
      loadBinding: () => binding(),
    });
    assert.deepEqual(rewritten, result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux credential mutex manifest writer refuses unsafe existing sidecars", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-mutex-sidecar-"));
  try {
    const canonicalRoot = await realpath(root);
    const target = join(canonicalRoot, "target.manifest.json");
    const symlinkPath = join(canonicalRoot, "sidecar.manifest.json");
    await writeFile(target, "foreign bytes\n", { mode: 0o600 });
    await chmod(target, 0o600);
    await symlink(target, symlinkPath);
    await assert.rejects(
      writeLinuxCredentialMutexManifestFile(symlinkPath, "{\"safe\":true}\n"),
      (error) => error?.code === "linux_credential_mutex_manifest_manifest_path_unsafe",
    );
    assert.equal(await readFile(target, "utf8"), "foreign bytes\n");

    const hardlinkPath = join(canonicalRoot, "hardlink.manifest.json");
    await writeLinuxCredentialMutexManifestFile(hardlinkPath, "{\"safe\":true}\n");
    await link(hardlinkPath, join(canonicalRoot, "hardlink-copy.manifest.json"));
    await assert.rejects(
      writeLinuxCredentialMutexManifestFile(hardlinkPath, "{\"replaced\":true}\n"),
      (error) => error?.code === "linux_credential_mutex_manifest_manifest_path_unsafe",
    );
    assert.equal(await readFile(hardlinkPath, "utf8"), "{\"safe\":true}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
