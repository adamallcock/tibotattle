import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  FIXED_STATUS as STATUS,
  WINDOWS_NATIVE_PRESIGN_INPUT_STATUS,
  WindowsNativePresignInputBuilderError,
  buildWindowsNativePresignInput,
  parseWindowsNativePresignInputBuilderArguments,
  serializeWindowsNativePresignInput,
  validateWindowsNativePresignInputBuilderOptions,
  writeWindowsNativePresignInput,
} from "../scripts/build-windows-native-presign-input.mjs";
import {
  WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY,
  WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
} from "../scripts/windows-native-presign.mjs";
import {
  canonicalElectronBuilderPackageJsonBytes,
} from "../scripts/lib/electron-builder-package-json.mjs";
import {
  WINDOWS_FINALIZER_HANDOFF_SCHEMA,
  WINDOWS_FINALIZER_HANDOFF_STATUS,
  WINDOWS_FINALIZER_PRODUCTION_READINESS,
  WINDOWS_FINALIZER_TARGET,
  WINDOWS_FINALIZER_WORKFLOW_PATH,
  WINDOWS_FINALIZER_EVENT,
  WINDOWS_FINALIZER_RUN_STATUS,
  WINDOWS_FINALIZER_RUN_CONCLUSION,
} from "../scripts/verify-windows-finalizer-qualification-handoff.mjs";

const REVISION = "a".repeat(40);
const SOURCE_RUN = 123456;
const SOURCE_ATTEMPT = 2;
const PACKAGE_VERSION = "0.1.16";
const BINDING = Buffer.from("reviewed-unsigned-windows-filesystem", "utf8");
const SIDECAR = Buffer.from("{\"bindingFile\":\"windows_filesystem.node\"}\n", "utf8");
const KEYTAR_SOURCE = "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node";
const BINDING_PATH = "native/windows-filesystem/build/Release/windows_filesystem.node";
const SIDECAR_PATH = `${BINDING_PATH}.manifest.json`;
const KEYTAR_PATH = "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const CERTIFICATE_SUBJECT_SHA256 = "d".repeat(64);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function payload(rows) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of rows) {
    bytes += row.bytes;
    hash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function rewriteRuntimeManifest(value, mutate) {
  const path = join(value.stagingRoot, "electron-runtime-manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  mutate(manifest);
  manifest.payload = payload(manifest.files);
  await writeFile(path, Buffer.from(stableJson(manifest), "utf8"));
}

function receipt(mode) {
  const receiptSha = mode === "warm" ? "b".repeat(64) : "c".repeat(64);
  const artifactId = mode === "warm" ? 11 : 12;
  const receiptBytes = mode === "warm" ? 101 : 102;
  return {
    artifact: {
      digest: `sha256:${receiptSha}`,
      headSha: REVISION,
      id: artifactId,
      name: `tibotattle-windows-electron-qualification-${SOURCE_RUN}-${SOURCE_ATTEMPT}-${REVISION}-${mode}.json`,
      runId: SOURCE_RUN,
      sizeInBytes: receiptBytes,
    },
    binding: { bytes: BINDING.byteLength, sha256: sha256(BINDING) },
    cacheMode: mode,
    qualification: {
      failed: 0,
      passed: 4,
      skipped: 0,
      status: "WINDOWS_SECURITY_QUALIFICATION_PASSED",
      tests: 4,
    },
    receiptProvenance: { bytes: receiptBytes, runId: SOURCE_RUN, sha256: receiptSha },
    runtimeStatus: "WINDOWS_ELECTRON_RUNTIME_SMOKE_PASSED",
    status: "WINDOWS_ELECTRON_DEVELOPMENT_QUALIFICATION_PASSED",
  };
}

function handoffValue(overrides = {}) {
  return {
    productionReadiness: WINDOWS_FINALIZER_PRODUCTION_READINESS,
    receipts: [receipt("warm"), receipt("clean")],
    repository: "adamallcock/tibotattle",
    revision: REVISION,
    run: {
      conclusion: WINDOWS_FINALIZER_RUN_CONCLUSION,
      databaseId: SOURCE_RUN,
      event: WINDOWS_FINALIZER_EVENT,
      headSha: REVISION,
      ref: "refs/heads/main",
      runAttempt: SOURCE_ATTEMPT,
      status: WINDOWS_FINALIZER_RUN_STATUS,
    },
    schemaVersion: WINDOWS_FINALIZER_HANDOFF_SCHEMA,
    status: WINDOWS_FINALIZER_HANDOFF_STATUS,
    target: WINDOWS_FINALIZER_TARGET,
    ...overrides,
  };
}

function packageValue(version = PACKAGE_VERSION) {
  return {
    engines: { node: ">=22.13.0" },
    main: "apps/electron/main.js",
    name: "app-usagemonitor",
    private: true,
    type: "module",
    version,
  };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-presign-input-")));
  const stagingRoot = join(root, "app");
  const evidenceRoot = join(root, "evidence");
  const packageJsonPath = join(root, "checkout-package.json");
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  const keytar = await readFile(KEYTAR_SOURCE);
  const stagedPackage = canonicalElectronBuilderPackageJsonBytes(
    "package.json",
    Buffer.from(stableJson(packageValue()), "utf8"),
    { packageVersion: PACKAGE_VERSION, profile: "windows-production" },
  );
  const rows = [
    { bytes: stagedPackage.byteLength, kind: "runtime_metadata", path: "package.json", sha256: sha256(stagedPackage) },
    { bytes: BINDING.byteLength, kind: "windows_native_binding", path: BINDING_PATH, sha256: sha256(BINDING) },
    { bytes: SIDECAR.byteLength, kind: "windows_native_binding", path: SIDECAR_PATH, sha256: sha256(SIDECAR) },
    { bytes: keytar.byteLength, kind: "third_party_dependency", path: KEYTAR_PATH, sha256: sha256(keytar) },
  ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const manifest = {
    architecture: "x64",
    dashboardRoot: "apps/web/public",
    entrypoint: "apps/electron/main.js",
    files: rows,
    payload: payload(rows),
    releaseVersion: PACKAGE_VERSION,
    schemaVersion: "usage-monitor-electron-runtime-v0.1",
    target: "win32",
    windowsBinding: {
      binding: { bytes: BINDING.byteLength, path: BINDING_PATH, sha256: sha256(BINDING) },
      included: true,
      manifest: { path: SIDECAR_PATH },
      status: "included_unverified",
      verified: false,
    },
  };
  const files = new Map([
    ["package.json", stagedPackage],
    [BINDING_PATH, BINDING],
    [SIDECAR_PATH, SIDECAR],
    [KEYTAR_PATH, keytar],
    ["electron-runtime-manifest.json", Buffer.from(stableJson(manifest), "utf8")],
  ]);
  for (const [path, bytes] of files) {
    const destination = join(stagingRoot, ...path.split("/"));
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, bytes, { mode: 0o600 });
  }
  const handoffBytes = Buffer.from(`${JSON.stringify(handoffValue(), null, 2)}\n`, "utf8");
  await writeFile(join(evidenceRoot, "handoff.json"), handoffBytes, { mode: 0o600 });
  await writeFile(packageJsonPath, Buffer.from(stableJson(packageValue()), "utf8"), { mode: 0o600 });
  return {
    root,
    stagingRoot,
    evidenceRoot,
    packageJsonPath,
    options: {
      evidenceRoot,
      handoff: "handoff.json",
      output: "native-input.json",
      certificateSubjectSha256: CERTIFICATE_SUBJECT_SHA256,
    },
    dependencies: {
      expectedStagingRoot: stagingRoot,
      expectedReceiptRoot: evidenceRoot,
      expectedPackageJsonPath: packageJsonPath,
    },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error instanceof WindowsNativePresignInputBuilderError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, "Windows native pre-sign input build failed");
    assert.equal(typeof error.requiresAttemptCleanup, "boolean");
    return true;
  };
}

test("builds the closed input from canonical handoff, package, and staged runtime bytes", async () => {
  const value = await fixture();
  try {
    const result = await buildWindowsNativePresignInput(value.options, value.dependencies);
    assert.equal(result.status, WINDOWS_NATIVE_PRESIGN_INPUT_STATUS);
    assert.deepEqual(result.input, {
      stagingRoot: value.stagingRoot,
      revision: REVISION,
      packageVersion: PACKAGE_VERSION,
      qualificationHandoffSha256: sha256(await readFile(join(value.evidenceRoot, "handoff.json"))),
      filesystemBinding: { bytes: BINDING.byteLength, sha256: sha256(BINDING) },
      keytarSha256: WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
      certificateSubjectSha256: CERTIFICATE_SUBJECT_SHA256,
      azure: {
        endpoint: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.endpoint,
        codeSigningAccountName: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.codeSigningAccountName,
        certificateProfileName: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.certificateProfileName,
        publisher: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.publisher,
      },
    });
    assert.equal(JSON.stringify(result.input).includes("AZURE_CLIENT_SECRET"), false);
    const serialized = serializeWindowsNativePresignInput(result.input, value.dependencies);
    assert.equal(serialized.endsWith("\n"), true);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.stagingRoot, value.stagingRoot);
    assert.equal(parsed.revision, REVISION);
  } finally {
    await value.cleanup();
  }
});

test("writes one canonical no-clobber input and cleans temporary output on collision", async () => {
  const value = await fixture();
  try {
    const result = await writeWindowsNativePresignInput(value.options, value.dependencies);
    const outputPath = join(value.evidenceRoot, value.options.output);
    assert.equal(result.outputPath, outputPath);
    assert.equal((await readFile(outputPath, "utf8"))[0], "{");
    await assert.rejects(
      writeWindowsNativePresignInput(value.options, value.dependencies),
      expectCode(STATUS.outputExists),
    );
    await assert.rejects(readFile(`${outputPath}.tmp`), (error) => error?.code === "ENOENT");
  } finally {
    await value.cleanup();
  }
});

test("cleans a partial temporary output after a test-only write fault", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      writeWindowsNativePresignInput(value.options, {
        ...value.dependencies,
        testOnlyFault: "after-temp-write",
      }),
      expectCode(STATUS.outputInvalid),
    );
    await assert.rejects(
      readFile(join(value.evidenceRoot, value.options.output)),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(
      readFile(join(value.evidenceRoot, `${value.options.output}.tmp`)),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await value.cleanup();
  }
});

test("retains the first runtime-manifest snapshot across inventory and publication", async () => {
  const afterInventory = await fixture();
  try {
    await assert.rejects(
      buildWindowsNativePresignInput(afterInventory.options, {
        ...afterInventory.dependencies,
        testOnlyFault: "mutate-runtime-after-inventory",
      }),
      expectCode(STATUS.runtimeInvalid),
    );
  } finally {
    await afterInventory.cleanup();
  }

  const beforePublication = await fixture();
  try {
    await assert.rejects(
      writeWindowsNativePresignInput(beforePublication.options, {
        ...beforePublication.dependencies,
        testOnlyFault: "mutate-runtime-before-publication",
      }),
      expectCode(STATUS.runtimeInvalid),
    );
    await assert.rejects(
      readFile(join(beforePublication.evidenceRoot, beforePublication.options.output)),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(
      readFile(join(beforePublication.evidenceRoot, `${beforePublication.options.output}.tmp`)),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await beforePublication.cleanup();
  }
});

test("revalidates the original evidence root before temp creation and publication", async () => {
  for (const fault of ["replace-evidence-before-temp", "replace-evidence-before-publication"]) {
    const value = await fixture();
    const replacement = `${value.evidenceRoot}.replaced`;
    try {
      await assert.rejects(
        writeWindowsNativePresignInput(value.options, {
          ...value.dependencies,
          testOnlyFault: fault,
        }),
        (error) => {
          const cleanupRequired = fault === "replace-evidence-before-publication";
          assert.equal(expectCode(cleanupRequired
            ? STATUS.attemptCleanupRequired
            : STATUS.evidenceRootInvalid)(error), true);
          assert.equal(
            error.requiresAttemptCleanup,
            cleanupRequired,
          );
          return true;
        },
      );
      await assert.rejects(
        readFile(join(value.evidenceRoot, value.options.output)),
        (error) => error?.code === "ENOENT",
      );
      if (fault === "replace-evidence-before-publication") {
        const displacedTemporary = await readFile(
          join(replacement, `${value.options.output}.tmp`),
        );
        assert.equal(displacedTemporary.length > 0, true);
      }
    } finally {
      await rm(replacement, { recursive: true, force: true });
      await value.cleanup();
    }
  }
});

test("rejects tampered or noncanonical handoff, package, and runtime manifest", async () => {
  const cases = [
    ["handoff revision", async (value) => {
      const text = await readFile(join(value.evidenceRoot, "handoff.json"), "utf8");
      await writeFile(
        join(value.evidenceRoot, "handoff.json"),
        text.replace(`  "revision": "${REVISION}",`, `  "revision": "${"f".repeat(40)}",`),
      );
    }, STATUS.handoffInvalid],
    ["handoff whitespace", async (value) => {
      const text = await readFile(join(value.evidenceRoot, "handoff.json"), "utf8");
      await writeFile(join(value.evidenceRoot, "handoff.json"), ` ${text}`);
    }, STATUS.handoffNoncanonical],
    ["handoff duplicate key", async (value) => {
      const text = await readFile(join(value.evidenceRoot, "handoff.json"), "utf8");
      await writeFile(join(value.evidenceRoot, "handoff.json"), text.replace("{\n", "{\n  \"revision\": \"aaaa\",\n"));
    }, STATUS.duplicateJsonKey],
    ["package duplicate key", async (value) => {
      await writeFile(value.packageJsonPath, '{"name":"app-usagemonitor","name":"evil","version":"0.1.16","private":true,"type":"module"}');
    }, STATUS.duplicateJsonKey],
    ["runtime noncanonical", async (value) => {
      const path = join(value.stagingRoot, "electron-runtime-manifest.json");
      const text = await readFile(path, "utf8");
      await writeFile(path, text.replace(/^\{/u, "{\n"));
    }, STATUS.runtimeInvalid],
  ];
  for (const [name, mutate, code] of cases) {
    const value = await fixture();
    try {
      await mutate(value);
      await assert.rejects(
        buildWindowsNativePresignInput(value.options, value.dependencies),
        expectCode(code),
        name,
      );
    } finally {
      await value.cleanup();
    }
  }
});

test("derives and binds target, version, revision, and native hashes", async () => {
  const mutations = [
    ["root package version", async (value) => {
      await writeFile(value.packageJsonPath, Buffer.from(stableJson(packageValue("0.1.17"))));
    }, STATUS.packageInvalid],
    ["staged package version", async (value) => {
      await writeFile(join(value.stagingRoot, "package.json"), Buffer.from(stableJson(packageValue("0.1.17"))));
    }, STATUS.stagingInvalid],
    ["runtime target", async (value) => {
      const path = join(value.stagingRoot, "electron-runtime-manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.target = "linux";
      await writeFile(path, Buffer.from(stableJson(manifest)));
    }, STATUS.runtimeInvalid],
    ["filesystem bytes versus handoff binding", async (value) => {
      const bytes = Buffer.from("tampered-filesystem-binding", "utf8");
      await writeFile(join(value.stagingRoot, BINDING_PATH), bytes);
      await rewriteRuntimeManifest(value, (manifest) => {
        const row = manifest.files.find(({ path }) => path === BINDING_PATH);
        row.bytes = bytes.byteLength;
        row.sha256 = sha256(bytes);
        manifest.windowsBinding.binding.bytes = bytes.byteLength;
        manifest.windowsBinding.binding.sha256 = sha256(bytes);
      });
    }, STATUS.nativeInvalid],
    ["pinned keytar", async (value) => {
      const bytes = Buffer.from("tampered-keytar-binding", "utf8");
      await writeFile(join(value.stagingRoot, KEYTAR_PATH), bytes);
      await rewriteRuntimeManifest(value, (manifest) => {
        const row = manifest.files.find(({ path }) => path === KEYTAR_PATH);
        row.bytes = bytes.byteLength;
        row.sha256 = sha256(bytes);
      });
    }, STATUS.nativeInvalid],
  ];
  for (const [name, mutate, code] of mutations) {
    const value = await fixture();
    try {
      await mutate(value);
      await assert.rejects(
        buildWindowsNativePresignInput(value.options, value.dependencies),
        expectCode(code),
        name,
      );
    } finally {
      await value.cleanup();
    }
  }
});

test("rejects symlink, hardlink, escape, and case-collision staging entries", async () => {
  const linked = await fixture();
  try {
    const path = join(linked.stagingRoot, BINDING_PATH);
    const target = join(linked.root, "outside.node");
    await writeFile(target, BINDING);
    await rm(path);
    await symlink(target, path);
    await assert.rejects(
      buildWindowsNativePresignInput(linked.options, linked.dependencies),
      expectCode(STATUS.stagingInvalid),
    );
  } finally {
    await linked.cleanup();
  }

  const hardlinked = await fixture();
  try {
    const path = join(hardlinked.stagingRoot, "extra.bin");
    await link(join(hardlinked.stagingRoot, BINDING_PATH), path);
    await assert.rejects(
      buildWindowsNativePresignInput(hardlinked.options, hardlinked.dependencies),
      expectCode(STATUS.stagingInvalid),
    );
  } finally {
    await hardlinked.cleanup();
  }

  const collision = await fixture();
  try {
    await copyFile(
      join(collision.stagingRoot, "package.json"),
      join(collision.stagingRoot, "PACKAGE.JSON"),
    );
    const entries = await (await import("node:fs/promises")).readdir(collision.stagingRoot);
    if (entries.includes("package.json") && entries.includes("PACKAGE.JSON")) {
      await assert.rejects(
        buildWindowsNativePresignInput(collision.options, collision.dependencies),
        expectCode(STATUS.stagingInvalid),
      );
    }
  } finally {
    await collision.cleanup();
  }
});

test("rejects proxies, accessors, open schemas, and unsafe roots without path diagnostics", async () => {
  const value = await fixture();
  try {
    for (const candidate of [
      { ...value.options, extra: true },
      new Proxy(value.options, {}),
    ]) {
      assert.throws(
        () => validateWindowsNativePresignInputBuilderOptions(candidate),
        expectCode(STATUS.inputInvalid),
      );
    }
    const accessor = { ...value.options };
    Object.defineProperty(accessor, "output", { enumerable: true, get: () => "native-input.json" });
    assert.throws(
      () => validateWindowsNativePresignInputBuilderOptions(accessor),
      expectCode(STATUS.inputInvalid),
    );
    const dependencyAccessor = { ...value.dependencies };
    Object.defineProperty(dependencyAccessor, "expectedStagingRoot", {
      enumerable: true,
      get: () => value.stagingRoot,
    });
    await assert.rejects(
      buildWindowsNativePresignInput(value.options, dependencyAccessor),
      expectCode(STATUS.inputInvalid),
    );
    await assert.rejects(
      buildWindowsNativePresignInput(
        { ...value.options, evidenceRoot: join(value.stagingRoot, "nested") },
        value.dependencies,
      ),
      (error) => {
        assert.equal(expectCode(STATUS.evidenceRootInvalid)(error), true);
        assert.equal(error.message.includes(value.root), false);
        return true;
      },
    );
  } finally {
    await value.cleanup();
  }
});

test("parses only the closed fixed-path CLI shape", () => {
  const evidenceRoot = join(tmpdir(), "evidence");
  assert.deepEqual(
    parseWindowsNativePresignInputBuilderArguments([
      "--evidence-root", evidenceRoot,
      "--handoff", "handoff.json",
      "--output", "native-input.json",
      "--certificate-subject-sha256", CERTIFICATE_SUBJECT_SHA256,
    ]),
    {
      evidenceRoot,
      handoff: "handoff.json",
      output: "native-input.json",
      certificateSubjectSha256: CERTIFICATE_SUBJECT_SHA256,
    },
  );
  assert.throws(
    () => parseWindowsNativePresignInputBuilderArguments([
      "--options", join(tmpdir(), "options.json"),
    ]),
    expectCode(STATUS.inputInvalid),
  );
  assert.throws(
    () => validateWindowsNativePresignInputBuilderOptions({
      evidenceRoot,
      handoff: "handoff.json",
      output: "HANDOFF.JSON",
      certificateSubjectSha256: CERTIFICATE_SUBJECT_SHA256,
    }),
    expectCode(STATUS.inputInvalid),
  );
});

test("native Windows qualification uses canonical separators and rejects junctions, hard links, and manifest case-fold collisions", {
  skip: process.platform !== "win32",
}, async () => {
  const canonical = await fixture();
  try {
    // On native Windows the fixture path is an absolute drive path with
    // backslash separators.  Exercise the production CLI shape with that
    // path rather than manufacturing a POSIX-compatible stand-in.
    assert.deepEqual(
      parseWindowsNativePresignInputBuilderArguments([
        "--evidence-root", canonical.evidenceRoot,
        "--handoff", "handoff.json",
        "--output", "native-input.json",
        "--certificate-subject-sha256", CERTIFICATE_SUBJECT_SHA256,
      ]),
      canonical.options,
    );
  } finally {
    await canonical.cleanup();
  }

  const junction = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "tibotattle-presign-junction-outside-"));
  const redirect = join(junction.stagingRoot, "redirect");
  try {
    await writeFile(join(outside, "escaped.txt"), "outside\n", { mode: 0o600 });
    await symlink(outside, redirect, "junction");
    await assert.rejects(
      buildWindowsNativePresignInput(junction.options, junction.dependencies),
      expectCode(STATUS.stagingInvalid),
    );
  } finally {
    await rm(redirect, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await junction.cleanup();
  }

  const hardlinked = await fixture();
  try {
    await link(
      join(hardlinked.stagingRoot, BINDING_PATH),
      join(hardlinked.stagingRoot, "native-binding-alias.node"),
    );
    await assert.rejects(
      buildWindowsNativePresignInput(hardlinked.options, hardlinked.dependencies),
      expectCode(STATUS.stagingInvalid),
    );
  } finally {
    await hardlinked.cleanup();
  }

  const collision = await fixture();
  try {
    await rewriteRuntimeManifest(collision, (manifest) => {
      const packageRow = manifest.files.find(({ path }) => path === "package.json");
      manifest.files.push({ ...packageRow, path: "PACKAGE.JSON" });
      manifest.files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
    });
    await assert.rejects(
      buildWindowsNativePresignInput(collision.options, collision.dependencies),
      expectCode(STATUS.runtimeInvalid),
    );
  } finally {
    await collision.cleanup();
  }
});
