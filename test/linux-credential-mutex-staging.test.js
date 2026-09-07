import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  buildLinuxCredentialMutexBindingManifest,
} from "../scripts/build-linux-credential-mutex-manifest.mjs";
import {
  stageLinuxCredentialMutexBinding,
} from "../scripts/stage-linux-credential-mutex-binding.mjs";
import {
  LINUX_CREDENTIAL_MUTEX_BINDING_MANIFEST_RELATIVE_PATH,
  LINUX_CREDENTIAL_MUTEX_BINDING_RELATIVE_PATH,
  LINUX_CREDENTIAL_MUTEX_GENERATED_BINDING_RELATIVE_PATH,
} from "../src/platform/linux-credential-mutex.js";

const BYTES = Buffer.from("node-gyp generated Linux credential mutex fixture", "utf8");

function binding() {
  return {
    credentialMutexContractVersion: "linux-credential-mutex-v1",
    credentialMutexCrossProcessSafe: true,
    credentialMutexSameNetworkNamespaceOnly: true,
    credentialMutexDurableMarker: true,
    productionSafe: false,
    acquireCredentialMutex: () => ({ lease: Object.create(null), abandoned: false }),
    releaseCredentialMutex: () => {},
    abandonCredentialMutex: () => {},
  };
}

test("Linux mutex qualification keeps node-gyp, staged binding, and sidecar paths distinct", async () => {
  assert.equal(
    LINUX_CREDENTIAL_MUTEX_GENERATED_BINDING_RELATIVE_PATH,
    "native/linux-credential-mutex/build/Release/linux_credential_mutex.node",
  );
  assert.equal(
    LINUX_CREDENTIAL_MUTEX_BINDING_RELATIVE_PATH,
    "native/linux-credential-mutex/build/qualification/linux_credential_mutex.node",
  );
  assert.equal(
    LINUX_CREDENTIAL_MUTEX_BINDING_MANIFEST_RELATIVE_PATH,
    "native/linux-credential-mutex/build/qualification/linux_credential_mutex.node.manifest.json",
  );
  const loaderSource = await readFile(
    new URL("../src/platform/linux-credential-mutex.js", import.meta.url),
    "utf8",
  );
  assert.match(
    loaderSource,
    /const NATIVE_BINDING_PATH = resolve\([\s\S]*LINUX_CREDENTIAL_MUTEX_BINDING_RELATIVE_PATH,[\s\S]*\);/u,
  );
});

test("Linux mutex staging detaches node-gyp's hard link before manifest qualification", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-mutex-stage-"));
  try {
    const canonicalRoot = await realpath(root);
    const generatedPath = join(canonicalRoot, "Release", "linux_credential_mutex.node");
    const objectTargetPath = join(canonicalRoot, "obj.target", "linux_credential_mutex.node");
    const qualificationPath = join(
      canonicalRoot,
      "qualification",
      "linux_credential_mutex.node",
    );
    await mkdir(dirname(generatedPath), { recursive: true, mode: 0o700 });
    await mkdir(dirname(objectTargetPath), { recursive: true, mode: 0o700 });
    await writeFile(generatedPath, BYTES, { mode: 0o644 });
    await chmod(generatedPath, 0o644);
    await link(generatedPath, objectTargetPath);
    const generatedMetadata = await lstat(generatedPath);
    assert.equal(generatedMetadata.nlink, 2);

    const syncedDirectories = [];
    const staged = await stageLinuxCredentialMutexBinding({
      generatedBindingPath: generatedPath,
      qualificationBindingPath: qualificationPath,
      syncDirectory: async (path) => {
        syncedDirectories.push(path);
      },
    });
    const qualificationMetadata = await lstat(qualificationPath);
    assert.equal(qualificationMetadata.nlink, 1);
    assert.equal(qualificationMetadata.mode & 0o777, 0o644);
    assert.notEqual(
      `${qualificationMetadata.dev}:${qualificationMetadata.ino}`,
      `${generatedMetadata.dev}:${generatedMetadata.ino}`,
    );
    assert.deepEqual(await readFile(qualificationPath), BYTES);
    assert.deepEqual(staged, {
      bytes: BYTES.byteLength,
      sha256: createHash("sha256").update(BYTES).digest("hex"),
    });
    assert.deepEqual(syncedDirectories, [dirname(qualificationPath)]);

    await writeFile(objectTargetPath, "changed node-gyp source bytes\n", { mode: 0o644 });
    await chmod(objectTargetPath, 0o644);
    assert.deepEqual(
      await readFile(qualificationPath),
      BYTES,
      "a post-stage change through node-gyp's source hard link cannot change the qualification copy",
    );

    const manifestPath = `${qualificationPath}.manifest.json`;
    const manifest = await buildLinuxCredentialMutexBindingManifest({
      bindingPath: qualificationPath,
      manifestPath,
      readBinding: readFile,
      loadBinding: () => binding(),
    });
    assert.equal(manifest.bytes, staged.bytes);
    assert.equal(manifest.sha256, staged.sha256);
    assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux mutex staging refuses stale targets and generated aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-linux-mutex-stage-refusal-"));
  try {
    const canonicalRoot = await realpath(root);
    const generatedPath = join(canonicalRoot, "Release", "linux_credential_mutex.node");
    const qualificationPath = join(
      canonicalRoot,
      "qualification",
      "linux_credential_mutex.node",
    );
    await mkdir(dirname(generatedPath), { recursive: true, mode: 0o700 });
    await mkdir(dirname(qualificationPath), { recursive: true, mode: 0o700 });
    await writeFile(generatedPath, BYTES, { mode: 0o644 });
    await chmod(generatedPath, 0o644);
    await writeFile(qualificationPath, "foreign qualification bytes\n", { mode: 0o644 });
    await chmod(qualificationPath, 0o644);
    await assert.rejects(
      stageLinuxCredentialMutexBinding({
        generatedBindingPath: generatedPath,
        qualificationBindingPath: qualificationPath,
        syncDirectory: async () => {},
      }),
      (error) => error?.code === "linux_credential_mutex_staging_qualification_path_exists",
    );
    assert.equal(await readFile(qualificationPath, "utf8"), "foreign qualification bytes\n");

    const unprotectedDirectory = join(canonicalRoot, "unprotected-qualification");
    await mkdir(unprotectedDirectory, { recursive: true, mode: 0o755 });
    await chmod(unprotectedDirectory, 0o755);
    await assert.rejects(
      stageLinuxCredentialMutexBinding({
        generatedBindingPath: generatedPath,
        qualificationBindingPath: join(unprotectedDirectory, "linux_credential_mutex.node"),
        syncDirectory: async () => {},
      }),
      (error) => error?.code === "linux_credential_mutex_staging_qualification_directory_unsafe",
    );

    const generatedAlias = join(canonicalRoot, "Release", "generated.alias.node");
    await symlink(generatedPath, generatedAlias);
    await assert.rejects(
      stageLinuxCredentialMutexBinding({
        generatedBindingPath: generatedAlias,
        qualificationBindingPath: join(
          canonicalRoot,
          "qualification",
          "other-linux_credential_mutex.node",
        ),
        syncDirectory: async () => {},
      }),
      (error) => error?.code === "linux_credential_mutex_staging_generated_path_unsafe",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
