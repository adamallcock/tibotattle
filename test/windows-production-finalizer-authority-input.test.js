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
  WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_STATUS,
  WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_DRIVER_OUTPUT,
  WindowsProductionFinalizerAuthorityInputBuilderError,
  buildWindowsProductionFinalizerAuthorityInput,
  parseWindowsProductionFinalizerAuthorityInputArguments,
  serializeWindowsProductionFinalizerAuthorityInput,
  writeWindowsProductionFinalizerAuthorityInput,
} from "../scripts/build-windows-production-finalizer-authority-input.mjs";
import {
  buildWindowsProductionFinalizerAuthority,
} from "../scripts/build-windows-production-finalizer-authority.mjs";
import {
  runWindowsProductionFinalizerAuthorityArguments,
} from "../scripts/run-windows-production-finalizer-authority.mjs";
import {
  WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY,
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
  WINDOWS_FINALIZER_PRODUCTION_READINESS,
  WINDOWS_FINALIZER_RUN_CONCLUSION,
  WINDOWS_FINALIZER_RUN_STATUS,
  WINDOWS_FINALIZER_TARGET,
  WINDOWS_FINALIZER_WORKFLOW_PATH,
  WINDOWS_FINALIZER_HANDOFF_STATUS,
} from "../scripts/verify-windows-finalizer-qualification-handoff.mjs";
import {
  selectWindowsFinalizerSourceEvidence,
  serializeWindowsFinalizerSourceEvidenceRunMetadata,
  serializeWindowsFinalizerSourceEvidenceSelection,
} from "../scripts/select-windows-finalizer-source-evidence.mjs";
import {
  WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
  WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
  WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
  WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW,
  serializeWindowsProductionAuthorityManifest,
} from "../src/platform/windows-production-authority-manifest.js";

const REVISION = "a".repeat(40);
const SOURCE_RUN = 123456789;
const SOURCE_ATTEMPT = 2;
const FINALIZER_RUN = 987654321;
const FINALIZER_ATTEMPT = 1;
const PACKAGE_VERSION = "0.1.16";
const PUBLISHER = WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.publisher;
const BINDING_UNSIGNED = Buffer.from("unsigned-windows-filesystem", "utf8");
const BINDING_SIGNED = Buffer.from("signed-windows-filesystem", "utf8");
const SIDECAR = Buffer.from("{\"bindingFile\":\"windows_filesystem.node\"}\n", "utf8");
const KEYTAR_UNSIGNED = Buffer.from("unsigned-keytar", "utf8");
const KEYTAR_SIGNED = Buffer.from("signed-keytar", "utf8");
const BINDING_PATH = WINDOWS_NATIVE_PRESIGN_MODULES[0].packagedPath;
const BINDING_MANIFEST_PATH = `${BINDING_PATH}.manifest.json`;
const KEYTAR_PATH = WINDOWS_NATIVE_PRESIGN_MODULES[1].packagedPath;
const RUNTIME_FILE = "electron-runtime-manifest.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

function packageValue() {
  return {
    engines: { node: ">=22.13.0" },
    main: "apps/electron/main.js",
    name: "app-usagemonitor",
    private: true,
    type: "module",
    version: PACKAGE_VERSION,
  };
}

function qualificationArtifact(mode, id) {
  const digest = mode === "warm" ? "b".repeat(64) : "c".repeat(64);
  return {
    digest: `sha256:${digest}`,
    expired: false,
    head_sha: REVISION,
    id,
    name: `tibotattle-windows-electron-qualification-${SOURCE_RUN}-${SOURCE_ATTEMPT}-${REVISION}-${mode}.json`,
    size_in_bytes: mode === "warm" ? 101 : 102,
    workflow_run: { head_sha: REVISION, id: SOURCE_RUN },
  };
}

function sourceSelection() {
  const selected = selectWindowsFinalizerSourceEvidence({
    artifactListBytes: Buffer.from(JSON.stringify({
      artifacts: [qualificationArtifact("clean", 222), qualificationArtifact("warm", 111)],
      total_count: 2,
    }), "utf8"),
    ref: WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
    repository: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
    revision: REVISION,
    runId: SOURCE_RUN,
    runMetadataBytes: Buffer.from(JSON.stringify({
      conclusion: WINDOWS_FINALIZER_RUN_CONCLUSION,
      event: WINDOWS_FINALIZER_EVENT,
      head_branch: "main",
      head_sha: REVISION,
      id: SOURCE_RUN,
      path: `${WINDOWS_FINALIZER_WORKFLOW_PATH}@${WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF}`,
      repository: { full_name: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY },
      run_attempt: SOURCE_ATTEMPT,
      status: WINDOWS_FINALIZER_RUN_STATUS,
    }), "utf8"),
  });
  return selected;
}

function qualificationReceipt(mode) {
  const digest = mode === "warm" ? "b".repeat(64) : "c".repeat(64);
  const id = mode === "warm" ? 111 : 222;
  const bytes = mode === "warm" ? 101 : 102;
  return {
    artifact: {
      digest: `sha256:${digest}`,
      headSha: REVISION,
      id,
      name: `tibotattle-windows-electron-qualification-${SOURCE_RUN}-${SOURCE_ATTEMPT}-${REVISION}-${mode}.json`,
      runId: SOURCE_RUN,
      sizeInBytes: bytes,
    },
    binding: { bytes: BINDING_UNSIGNED.byteLength, sha256: sha256(BINDING_UNSIGNED) },
    cacheMode: mode,
    qualification: {
      failed: 0,
      passed: 4,
      skipped: 0,
      status: "WINDOWS_SECURITY_QUALIFICATION_PASSED",
      tests: 4,
    },
    receiptProvenance: { bytes, runId: SOURCE_RUN, sha256: digest },
    runtimeStatus: "WINDOWS_ELECTRON_RUNTIME_SMOKE_PASSED",
    status: "WINDOWS_ELECTRON_DEVELOPMENT_QUALIFICATION_PASSED",
  };
}

function handoffValue() {
  return {
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
      runAttempt: SOURCE_ATTEMPT,
      status: WINDOWS_FINALIZER_RUN_STATUS,
    },
    schemaVersion: WINDOWS_FINALIZER_HANDOFF_SCHEMA,
    status: WINDOWS_FINALIZER_HANDOFF_STATUS,
    target: WINDOWS_FINALIZER_TARGET,
  };
}

function authenticode() {
  return {
    policy: "authenticode-pa",
    publisher: PUBLISHER,
    signtoolPaValid: true,
    signerThumbprint: "e".repeat(40),
    status: "Valid",
    timestampPresent: true,
  };
}

function nativePresign(handoffHash) {
  return {
    modules: [
      {
        authenticode: authenticode(),
        name: WINDOWS_NATIVE_PRESIGN_MODULES[0].name,
        packagedPath: BINDING_PATH,
        signedBytes: BINDING_SIGNED.byteLength,
        signedSha256: sha256(BINDING_SIGNED),
        unsignedBytes: BINDING_UNSIGNED.byteLength,
        unsignedSha256: sha256(BINDING_UNSIGNED),
      },
      {
        authenticode: authenticode(),
        name: WINDOWS_NATIVE_PRESIGN_MODULES[1].name,
        packagedPath: KEYTAR_PATH,
        signedBytes: KEYTAR_SIGNED.byteLength,
        signedSha256: sha256(KEYTAR_SIGNED),
        unsignedBytes: KEYTAR_UNSIGNED.byteLength,
        unsignedSha256: WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
      },
    ],
    packageVersion: PACKAGE_VERSION,
    qualificationHandoffSha256: handoffHash,
    revision: REVISION,
    schemaVersion: WINDOWS_NATIVE_PRESIGN_SCHEMA,
    signingRequestPolicy: WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY,
    status: WINDOWS_NATIVE_PRESIGN_STATUS,
    target: WINDOWS_NATIVE_PRESIGN_TARGET,
  };
}

function digestPayload(rows) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of rows) {
    bytes += row.bytes;
    hash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-authority-input-")));
  const evidenceRoot = join(root, "evidence");
  const stagingRoot = join(root, "staging");
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const packageBytes = Buffer.from(stableJson(packageValue()), "utf8");
  const sidecarRow = {
    bytes: SIDECAR.byteLength,
    kind: "windows_native_binding",
    path: BINDING_MANIFEST_PATH,
    sha256: sha256(SIDECAR),
  };
  const rows = [
    {
      bytes: packageBytes.byteLength,
      kind: "runtime_metadata",
      path: "package.json",
      sha256: sha256(packageBytes),
    },
    {
      bytes: BINDING_UNSIGNED.byteLength,
      kind: "windows_native_binding",
      path: BINDING_PATH,
      sha256: sha256(BINDING_UNSIGNED),
    },
    sidecarRow,
    {
      bytes: KEYTAR_UNSIGNED.byteLength,
      kind: "third_party_dependency",
      path: KEYTAR_PATH,
      sha256: WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
    },
  ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const runtime = {
    architecture: "x64",
    dashboardRoot: "apps/web/public",
    entrypoint: "apps/electron/main.js",
    files: rows,
    payload: digestPayload(rows),
    releaseVersion: PACKAGE_VERSION,
    schemaVersion: "usage-monitor-electron-runtime-v0.1",
    target: "win32",
    windowsBinding: {
      binding: {
        bytes: BINDING_UNSIGNED.byteLength,
        path: BINDING_PATH,
        sha256: sha256(BINDING_UNSIGNED),
      },
      included: true,
      manifest: { path: BINDING_MANIFEST_PATH },
      status: "included_unverified",
      verified: false,
    },
  };
  const handoffBytes = Buffer.from(`${JSON.stringify(handoffValue(), null, 2)}\n`, "utf8");
  const selection = sourceSelection();
  const selectionBytes = Buffer.from(
    serializeWindowsFinalizerSourceEvidenceSelection(selection.selectionReceipt),
    "utf8",
  );
  const sourceRunBytes = Buffer.from(
    serializeWindowsFinalizerSourceEvidenceRunMetadata(selection.runMetadata, {
      ref: selection.runMetadata.ref,
      repository: selection.runMetadata.repository,
      revision: selection.runMetadata.headSha,
      runId: selection.runMetadata.databaseId,
    }),
    "utf8",
  );
  const presignBytes = Buffer.from(
    serializeWindowsNativePresignReceipt(nativePresign(sha256(handoffBytes))),
    "utf8",
  );
  const policyBytes = Buffer.from(stableJson({
    certificateProfileName: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.certificateProfileName,
    codeSigningAccountName: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.codeSigningAccountName,
    endpoint: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.endpoint,
    publisher: PUBLISHER,
    timestampRfc3161: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.timestampRfc3161,
  }), "utf8");
  const finalizerBytes = Buffer.from(stableJson({
    event: "workflow_dispatch",
    headSha: REVISION,
    ref: "refs/heads/main",
    repository: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
    run: FINALIZER_RUN,
    runAttempt: FINALIZER_ATTEMPT,
    workflow: WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
  }), "utf8");
  await Promise.all([
    writeFile(join(evidenceRoot, "selection.json"), selectionBytes, { mode: 0o600 }),
    writeFile(join(evidenceRoot, "handoff.json"), handoffBytes, { mode: 0o600 }),
    writeFile(join(evidenceRoot, "native-presign.json"), presignBytes, { mode: 0o600 }),
    writeFile(join(evidenceRoot, "package.json"), packageBytes, { mode: 0o600 }),
    writeFile(join(evidenceRoot, "source-run.json"), sourceRunBytes, { mode: 0o600 }),
    writeFile(join(evidenceRoot, "policy.json"), policyBytes, { mode: 0o600 }),
    writeFile(join(evidenceRoot, "finalizer.json"), finalizerBytes, { mode: 0o600 }),
  ]);
  const stageFiles = new Map([
    ["package.json", packageBytes],
    [BINDING_PATH, BINDING_SIGNED],
    [BINDING_MANIFEST_PATH, SIDECAR],
    [KEYTAR_PATH, KEYTAR_SIGNED],
    [RUNTIME_FILE, Buffer.from(stableJson(runtime), "utf8")],
  ]);
  for (const [path, bytes] of stageFiles) {
    const destination = join(stagingRoot, ...path.split("/"));
    await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { mode: 0o600 });
  }
  const options = {
    checkoutPackageJson: "package.json",
    evidenceRoot,
    finalizerMetadata: "finalizer.json",
    handoff: "handoff.json",
    nativePresign: "native-presign.json",
    output: "authority-input.json",
    policy: "policy.json",
    selection: "selection.json",
    sourceRunMetadata: "source-run.json",
    stagingRoot,
  };
  return {
    evidenceRoot,
    options,
    root,
    stagingRoot,
    async cleanup() {
      await rm(root, { force: true, recursive: true });
    },
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error instanceof WindowsProductionFinalizerAuthorityInputBuilderError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, "Windows production finalizer authority input build failed");
    return true;
  };
}

test("derives driver facts and matches the direct authority builder", async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const result = await buildWindowsProductionFinalizerAuthorityInput(value.options);
  assert.equal(result.status, WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_STATUS);
  assert.equal(result.input.output, WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_DRIVER_OUTPUT);
  assert.deepEqual(result.input.facts.filesystemBinding, {
    bytes: BINDING_UNSIGNED.byteLength,
    sha256: sha256(BINDING_UNSIGNED),
  });
  assert.deepEqual(result.input.facts.keytarBinding, {
    bytes: KEYTAR_UNSIGNED.byteLength,
    sha256: WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
  });
  assert.deepEqual(result.input.facts.signerPolicy, { match: "exact", publisher: PUBLISHER });
  assert.equal(result.input.facts.nativeModules[0].signedSha256, sha256(BINDING_SIGNED));
  assert.equal(Object.hasOwn(result.input.facts.nativeModules[0], "authenticode"), false);
  assert.equal(result.input.facts.runtimeManifest.packagedPath, WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH);

  const handoffBytes = await readFile(join(value.evidenceRoot, "handoff.json"));
  const presignBytes = await readFile(join(value.evidenceRoot, "native-presign.json"));
  const packageBytes = await readFile(join(value.evidenceRoot, "package.json"));
  const sourceRun = JSON.parse(await readFile(join(value.evidenceRoot, "source-run.json"), "utf8"));
  const direct = buildWindowsProductionFinalizerAuthority({
    checkoutPackageJsonBytes: packageBytes,
    finalizer: result.input.facts.finalizer,
    handoffBytes,
    nativePresignBytes: presignBytes,
    publisher: PUBLISHER,
    runtimeManifest: result.input.facts.runtimeManifest,
    sourceRunMetadata: sourceRun,
  });
  assert.deepEqual(direct.nativeModules, result.input.facts.nativeModules);
  assert.deepEqual(direct.runtimeManifest, result.input.facts.runtimeManifest);
  assert.deepEqual(direct.signerPolicy, result.input.facts.signerPolicy);
  assert.deepEqual(direct.finalizer, {
    event: "workflow_dispatch",
    headSha: REVISION,
    ref: "refs/heads/main",
    repository: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
    run: FINALIZER_RUN,
    runAttempt: FINALIZER_ATTEMPT,
    sourceRevision: REVISION,
    workflow: WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
  });
  assert.equal(direct.sourceQualification.workflow, WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW);
});

test("binds only the current signed finalizer run and rejects preflight/path/ref drift", async (t) => {
  const mutations = [
    ["preflight workflow", { workflow: ".github/workflows/windows-production-finalizer.yml" }],
    [
      "signed workflow @ref alias",
      { workflow: `${WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW}@refs/heads/main` },
    ],
    ["event", { event: "push" }],
    ["ref", { ref: "refs/heads/release" }],
    ["repository", { repository: "someone-else/tibotattle" }],
    ["source revision", { headSha: "b".repeat(40) }],
    ["same source run", { run: SOURCE_RUN }],
    ["invalid run attempt", { runAttempt: 0 }],
  ];
  for (const [name, mutation] of mutations) {
    const value = await fixture();
    t.after(() => value.cleanup());
    const path = join(value.evidenceRoot, "finalizer.json");
    const finalizer = JSON.parse(await readFile(path, "utf8"));
    Object.assign(finalizer, mutation);
    await writeFile(path, Buffer.from(stableJson(finalizer), "utf8"));
    await assert.rejects(
      buildWindowsProductionFinalizerAuthorityInput(value.options),
      expectCode(STATUS.finalizerInvalid),
      name,
    );
  }

  const extra = await fixture();
  t.after(() => extra.cleanup());
  const extraPath = join(extra.evidenceRoot, "finalizer.json");
  const extraFinalizer = JSON.parse(await readFile(extraPath, "utf8"));
  extraFinalizer.unexpected = true;
  await writeFile(extraPath, Buffer.from(stableJson(extraFinalizer), "utf8"));
  await assert.rejects(
    buildWindowsProductionFinalizerAuthorityInput(extra.options),
    expectCode(STATUS.finalizerInvalid),
  );
});

test("feeds the generated options document through the existing authority driver", async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const generated = await writeWindowsProductionFinalizerAuthorityInput(value.options);
  const driven = await runWindowsProductionFinalizerAuthorityArguments([
    "--options",
    generated.outputPath,
  ]);
  assert.equal(
    driven.status,
    "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_PASSED",
  );
  const authorityPath = join(value.evidenceRoot, "authority.json");
  const authorityBytes = await readFile(authorityPath, "utf8");
  assert.equal(
    authorityBytes,
    serializeWindowsProductionAuthorityManifest(driven.authority),
  );
  const authority = JSON.parse(authorityBytes);
  assert.equal(authority.status, "WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_VALID");
  assert.equal(authority.platform, "win32");
  assert.equal(authority.architecture, "x64");
  assert.equal(authority.nativeModules.length, 2);
  await assert.rejects(
    readFile(join(value.evidenceRoot, "authority.json.tmp")),
    (error) => error?.code === "ENOENT",
  );
});

test("writes one canonical no-clobber driver document and retains no private payload", async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const result = await writeWindowsProductionFinalizerAuthorityInput(value.options);
  const output = await readFile(result.outputPath, "utf8");
  assert.equal(output, serializeWindowsProductionFinalizerAuthorityInput(result.input));
  assert.equal(output.includes("signerThumbprint"), false);
  assert.equal(output.includes("AZURE_CLIENT_SECRET"), false);
  assert.equal(output.includes("https://github.invalid"), false);
  await assert.rejects(
    writeWindowsProductionFinalizerAuthorityInput(value.options),
    expectCode(STATUS.outputExists),
  );
  await assert.rejects(
    readFile(`${result.outputPath}.tmp`),
    (error) => error?.code === "ENOENT",
  );
});

test("does not remove a raced replacement of the temporary output", async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const result = await writeWindowsProductionFinalizerAuthorityInput(
    value.options,
    { testOnlyFault: "replace-temp-before-cleanup" },
  );
  assert.equal(result.status, WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_STATUS);
  assert.equal(
    await readFile(`${result.outputPath}.tmp`, "utf8"),
    "raced temporary payload\n",
  );
  assert.equal(
    (await readFile(result.outputPath, "utf8"))
      .includes('"output": "authority.json"'),
    true,
  );
});

test("rejects evidence and staging roots that contain one another", async (t) => {
  const nestedStaging = await fixture();
  t.after(() => nestedStaging.cleanup());
  const nestedStagingRoot = join(nestedStaging.evidenceRoot, "nested-staging");
  await mkdir(nestedStagingRoot, { mode: 0o700 });
  await assert.rejects(
    buildWindowsProductionFinalizerAuthorityInput({
      ...nestedStaging.options,
      stagingRoot: nestedStagingRoot,
    }),
    expectCode(STATUS.stagingRootInvalid),
  );

  const nestedEvidence = await fixture();
  t.after(() => nestedEvidence.cleanup());
  await assert.rejects(
    buildWindowsProductionFinalizerAuthorityInput({
      ...nestedEvidence.options,
      stagingRoot: nestedEvidence.root,
    }),
    expectCode(STATUS.stagingRootInvalid),
  );
});

test("rejects dependency options outside the closed test-fault schema", async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const getter = {};
  Object.defineProperty(getter, "testOnlyFault", {
    enumerable: true,
    get() {
      return null;
    },
  });
  for (const dependencies of [
    { unexpected: true },
    Object.create(null),
    Object.create({ testOnlyFault: null }),
    getter,
  ]) {
    await assert.rejects(
      buildWindowsProductionFinalizerAuthorityInput(value.options, dependencies),
      expectCode(STATUS.inputInvalid),
    );
  }
});

test("re-captures evidence and staging identities before publication", async (t) => {
  for (const fault of [
    "replace-evidence-before-temp",
    "replace-evidence-before-publication",
  ]) {
    const value = await fixture();
    t.after(() => value.cleanup());
    await assert.rejects(
      writeWindowsProductionFinalizerAuthorityInput(value.options, { testOnlyFault: fault }),
      expectCode(STATUS.evidenceRootInvalid),
    );
    await assert.rejects(
      readFile(join(value.evidenceRoot, value.options.output)),
      (error) => error?.code === "ENOENT",
    );
  }
  for (const fault of ["mutate-handoff-before-publication", "mutate-runtime-before-publication"]) {
    const value = await fixture();
    t.after(() => value.cleanup());
    await assert.rejects(
      writeWindowsProductionFinalizerAuthorityInput(value.options, { testOnlyFault: fault }),
      fault === "mutate-runtime-before-publication"
        ? expectCode(STATUS.runtimeInvalid)
        : expectCode(STATUS.handoffInvalid),
    );
    await assert.rejects(
      readFile(join(value.evidenceRoot, value.options.output)),
      (error) => error?.code === "ENOENT",
    );
  }
});

test("rejects symlink and hard-link evidence/staging aliases", async (t) => {
  const symlinked = await fixture();
  t.after(() => symlinked.cleanup());
  const outside = join(symlinked.root, "outside.json");
  await writeFile(outside, await readFile(join(symlinked.evidenceRoot, "handoff.json")), { mode: 0o600 });
  await rm(join(symlinked.evidenceRoot, "handoff.json"));
  await symlink(outside, join(symlinked.evidenceRoot, "handoff.json"));
  await assert.rejects(
    buildWindowsProductionFinalizerAuthorityInput(symlinked.options),
    expectCode(STATUS.handoffInvalid),
  );

  const hardlinked = await fixture();
  t.after(() => hardlinked.cleanup());
  await link(
    join(hardlinked.evidenceRoot, "policy.json"),
    join(hardlinked.evidenceRoot, "policy-alias.json"),
  );
  const withAlias = { ...hardlinked.options, policy: "policy-alias.json" };
  await assert.rejects(
    buildWindowsProductionFinalizerAuthorityInput(withAlias),
    expectCode(STATUS.policyInvalid),
  );

  const stagedAlias = await fixture();
  t.after(() => stagedAlias.cleanup());
  const extra = join(stagedAlias.stagingRoot, "native-alias.node");
  await link(join(stagedAlias.stagingRoot, BINDING_PATH), extra);
  await assert.rejects(
    buildWindowsProductionFinalizerAuthorityInput(stagedAlias.options),
    expectCode(STATUS.stagingInvalid),
  );
});

test("rejects policy, receipt, handoff, package, and native drift", async (t) => {
  const cases = [
    ["policy publisher", async (value) => {
      const path = join(value.evidenceRoot, "policy.json");
      const policy = JSON.parse(await readFile(path, "utf8"));
      policy.publisher = "Other Publisher";
      await writeFile(path, Buffer.from(stableJson(policy)));
    }, STATUS.policyInvalid],
    ["certificate DN", async (value) => {
      const path = join(value.evidenceRoot, "policy.json");
      const policy = JSON.parse(await readFile(path, "utf8"));
      policy.subject = "CN=private certificate subject";
      await writeFile(path, Buffer.from(stableJson(policy)));
    }, STATUS.policyInvalid],
    ["package version", async (value) => {
      await writeFile(join(value.evidenceRoot, "package.json"), Buffer.from(
        stableJson({ ...packageValue(), version: "0.1.17" }),
      ));
    }, STATUS.packageInvalid],
    ["receipt signed hash", async (value) => {
      const path = join(value.evidenceRoot, "native-presign.json");
      const receipt = JSON.parse(await readFile(path, "utf8"));
      receipt.modules[0].signedSha256 = "f".repeat(64);
      await writeFile(path, Buffer.from(serializeWindowsNativePresignReceipt(receipt)));
    }, STATUS.nativeInvalid],
    ["handoff whitespace", async (value) => {
      const path = join(value.evidenceRoot, "handoff.json");
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from(" ")]));
    }, STATUS.handoffNoncanonical],
  ];
  for (const [name, mutate, code] of cases) {
    const value = await fixture();
    t.after(() => value.cleanup());
    await mutate(value);
    await assert.rejects(
      buildWindowsProductionFinalizerAuthorityInput(value.options),
      expectCode(code),
      name,
    );
  }
});

test("keeps the CLI shape closed and does not expose network or signer entrypoints", async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const parsed = parseWindowsProductionFinalizerAuthorityInputArguments([
    "--evidence-root", value.evidenceRoot,
    "--staging-root", value.stagingRoot,
    "--selection", "selection.json",
    "--handoff", "handoff.json",
    "--native-presign", "native-presign.json",
    "--checkout-package-json", "package.json",
    "--source-run-metadata", "source-run.json",
    "--policy", "policy.json",
    "--finalizer-metadata", "finalizer.json",
    "--output", "authority-input.json",
  ]);
  assert.deepEqual(parsed.values, value.options);
  assert.throws(
    () => parseWindowsProductionFinalizerAuthorityInputArguments([
      "--evidence-root", value.evidenceRoot,
      "--staging-root", value.stagingRoot,
    ]),
    expectCode(STATUS.inputMissing),
  );
  const source = await readFile(new URL(
    "../scripts/build-windows-production-finalizer-authority-input.mjs",
    import.meta.url,
  ), "utf8");
  for (const forbidden of [
    "azure/login",
    "Invoke-TrustedSigning",
    "electron-builder",
    "upload-artifact",
    "fetch(",
    "spawnSync",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

test("native Windows path qualification remains explicit", { skip: process.platform !== "win32" }, async () => {
  const value = await fixture();
  try {
    const junctionTarget = join(value.root, "junction-target");
    const junctionPath = join(value.stagingRoot, "junction");
    await mkdir(junctionTarget, { mode: 0o700 });
    await symlink(junctionTarget, junctionPath, "junction");
    await assert.rejects(
      buildWindowsProductionFinalizerAuthorityInput(value.options),
      expectCode(STATUS.stagingInvalid),
    );
    await rm(junctionPath, { force: true, recursive: true });

    const result = await writeWindowsProductionFinalizerAuthorityInput(value.options);
    assert.equal(result.status, WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_STATUS);
    await assert.rejects(
      readFile(`${result.outputPath}.tmp`),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(
      writeWindowsProductionFinalizerAuthorityInput(value.options),
      expectCode(STATUS.outputExists),
    );
  } finally {
    await value.cleanup();
  }
});
