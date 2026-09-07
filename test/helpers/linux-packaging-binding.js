import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLinuxCredentialMutexBindingManifest } from "../../scripts/build-linux-credential-mutex-manifest.mjs";
import { LINUX_CREDENTIAL_MUTEX_BINDING_REQUIRED_METHODS } from "../../src/platform/linux-credential-mutex.js";

export const SYNTHETIC_LINUX_BINDING_BYTES = Buffer.from("synthetic Linux packaging fixture; never executable\n");

export function syntheticLinuxBindingManifest(bytes = SYNTHETIC_LINUX_BINDING_BYTES) {
  return createLinuxCredentialMutexBindingManifest({
    bytes,
    binding: {
      ...Object.fromEntries(LINUX_CREDENTIAL_MUTEX_BINDING_REQUIRED_METHODS.map((key) => [key, () => {}])),
      credentialMutexContractVersion: "linux-credential-mutex-v1",
      credentialMutexCrossProcessSafe: true,
      credentialMutexSameNetworkNamespaceOnly: true,
      credentialMutexDurableMarker: true,
      productionSafe: false,
    },
  });
}

export async function writeSyntheticLinuxBindingPair(root) {
  const linuxBindingPath = join(root, "linux-fixture.node");
  const linuxManifestPath = `${linuxBindingPath}.manifest.json`;
  await writeFile(linuxBindingPath, SYNTHETIC_LINUX_BINDING_BYTES, { flag: "wx", mode: 0o600 });
  await writeFile(linuxManifestPath, JSON.stringify(syntheticLinuxBindingManifest()), { flag: "wx", mode: 0o600 });
  return { linuxBindingPath, linuxManifestPath };
}
