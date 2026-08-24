import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
} from "../scripts/windows-native-presign.mjs";
import {
  WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_BINDING_PATH as BINDING_PATH,
  WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_KEYTAR_PATH as KEYTAR_PATH,
  WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_LOCKFILE_PATH as LOCKFILE_PATH,
  WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_PACKAGE_PATH as PACKAGE_PATH,
  WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_PREPARATION_WORKFLOW as PREPARATION_WORKFLOW,
  WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_REF as REF,
  WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_STATUS as HANDOFF_STATUS,
  WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_TARGET as TARGET,
  WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_WORKFLOW as SOURCE_WORKFLOW,
  FIXED_STATUS,
  buildWindowsProductionFinalizerPreparationHandoff,
  buildWindowsProductionFinalizerPreparationHandoffFromFiles,
  decodeWindowsProductionFinalizerPreparationHandoff,
  encodeWindowsProductionFinalizerPreparationHandoff,
  parseWindowsProductionFinalizerPreparationHandoff,
  parseWindowsProductionFinalizerPreparationHandoffArguments,
  serializeWindowsProductionFinalizerPreparationHandoff,
  validateWindowsProductionFinalizerPreparationHandoff,
  verifyWindowsProductionFinalizerPreparationHandoff,
} from "../scripts/build-windows-production-finalizer-preparation-handoff.mjs";

const REVISION = "a".repeat(40);
const HASH = (value) => createHash("sha256").update(value).digest("hex");
const KEYTAR_HASH = WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256;

function row(path, bytes = 11, sha256 = HASH(path)) {
  return { bytes, path, sha256 };
}

function fixtureInput(overrides = {}) {
  const binding = row(BINDING_PATH, 19, "b".repeat(64));
  const keytar = row(KEYTAR_PATH, 23, KEYTAR_HASH);
  const files = [
    row("app/main.js", 17),
    binding,
    keytar,
  ].sort((left, right) => left.path.localeCompare(right.path));
  return {
    lockfile: row(LOCKFILE_PATH, 37, "c".repeat(64)),
    native: {
      filesystemBinding: binding,
      keytar,
    },
    package: {
      bytes: 41,
      name: "app-usagemonitor",
      path: PACKAGE_PATH,
      sha256: "d".repeat(64),
      version: "0.1.16",
    },
    qualification: {
      binding,
      receipts: {
        clean: { bytes: 101, sha256: "e".repeat(64) },
        warm: { bytes: 99, sha256: "f".repeat(64) },
      },
      revision: REVISION,
      run: 32678463671,
      runAttempt: 2,
      status: "passed",
      workflow: SOURCE_WORKFLOW,
    },
    source: {
      ref: REF,
      revision: REVISION,
    },
    staged: { files },
    workflow: {
      path: PREPARATION_WORKFLOW,
      ref: REF,
      revision: REVISION,
      run: 32680000001,
      runAttempt: 1,
    },
    ...overrides,
  };
}

function buildFixture(overrides = {}) {
  return buildWindowsProductionFinalizerPreparationHandoff(fixtureInput(overrides));
}

function assertCode(action, code) {
  const accepted = new Set(Array.isArray(code) ? code : [code]);
  assert.throws(action, (error) => accepted.has(error?.code));
}

test("builds a closed manifest and round-trips canonical JSON/base64", () => {
  const manifest = buildFixture();
  assert.equal(manifest.status, HANDOFF_STATUS);
  assert.equal(manifest.target, TARGET);
  assert.equal(manifest.repository, "adamallcock/tibotattle");
  assert.deepEqual(manifest.source, { ref: REF, revision: REVISION });
  assert.equal(manifest.qualification.run, 32678463671);
  assert.equal(manifest.workflow.path, PREPARATION_WORKFLOW);
  assert.equal(manifest.staged.tree.count, 3);
  assert.equal(manifest.staged.tree.bytes, 17 + 19 + 23);
  const serialized = serializeWindowsProductionFinalizerPreparationHandoff(manifest);
  assert.equal(parseWindowsProductionFinalizerPreparationHandoff(serialized).staged.tree.sha256, manifest.staged.tree.sha256);
  const encoded = encodeWindowsProductionFinalizerPreparationHandoff(manifest);
  assert.equal(encoded.bytes, Buffer.byteLength(serialized));
  assert.equal(decodeWindowsProductionFinalizerPreparationHandoff(encoded.base64, encoded.sha256).package.version, "0.1.16");
  assert.match(serialized, /"sha256"/u);
  assert.doesNotMatch(serialized, /(?:token|secret|password|credential|\.log)/iu);
});

test("rejects noncanonical JSON and unexpected manifest keys", () => {
  const serialized = serializeWindowsProductionFinalizerPreparationHandoff(buildFixture());
  assertCode(() => parseWindowsProductionFinalizerPreparationHandoff(`${serialized} `), FIXED_STATUS.noncanonical);
  const duplicate = serialized.replace(
    /("status": "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_BUILT")/u,
    '$1,\n  "status": "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_BUILT"',
  );
  assertCode(() => parseWindowsProductionFinalizerPreparationHandoff(duplicate), FIXED_STATUS.duplicateJsonKey);
  const extra = JSON.parse(serialized);
  extra.token = "do-not-serialize";
  assertCode(() => validateWindowsProductionFinalizerPreparationHandoff(extra), FIXED_STATUS.inputInvalid);
});

test("rejects absolute, traversal, backslash, log, and sensitive staged paths", () => {
  for (const path of ["/tmp/escape", "../escape", "app/../escape", "app\\escape", "out.log", "private-token.txt"]) {
    const input = fixtureInput({
      staged: {
        files: [
          row(path),
          row(BINDING_PATH, 19, "b".repeat(64)),
          row(KEYTAR_PATH, 23, KEYTAR_HASH),
        ].sort((left, right) => left.path.localeCompare(right.path)),
      },
    });
    assertCode(() => buildWindowsProductionFinalizerPreparationHandoff(input), FIXED_STATUS.stagedInvalid);
  }
});

test("rejects mismatched source, qualification, workflow, binding, and native values", () => {
  const cases = [
    { source: { ref: REF, revision: "b".repeat(40) } },
    { qualification: { ...fixtureInput().qualification, revision: "b".repeat(40) } },
    { workflow: { ...fixtureInput().workflow, ref: "refs/heads/other" }, expected: FIXED_STATUS.workflowInvalid },
    { native: { ...fixtureInput().native, filesystemBinding: row(BINDING_PATH, 20, "1".repeat(64)) }, expected: FIXED_STATUS.mismatch },
    { native: { ...fixtureInput().native, keytar: row(KEYTAR_PATH, 23, "1".repeat(64)) }, expected: FIXED_STATUS.nativeInvalid },
  ];
  for (const override of cases) {
    const expected = override.expected ?? FIXED_STATUS.mismatch;
    delete override.expected;
    assertCode(() => buildFixture(override), expected);
  }
});

test("rejects duplicate, unsorted, and oversized staged inventory", () => {
  const input = fixtureInput();
  const duplicateFiles = [
    input.staged.files[0],
    input.staged.files[0],
    input.staged.files[1],
    input.staged.files[2],
  ].sort((left, right) => left.path.localeCompare(right.path));
  assertCode(() => buildFixture({ staged: { files: duplicateFiles } }), FIXED_STATUS.stagedInvalid);
  assertCode(() => buildFixture({ staged: { files: [...input.staged.files].reverse() } }), FIXED_STATUS.stagedInvalid);
  const oversized = row("app/large.bin", 128 * 1024 * 1024 + 1, "1".repeat(64));
  assertCode(() => buildFixture({ staged: { files: [...input.staged.files, oversized].sort((left, right) => left.path.localeCompare(right.path)) } }), FIXED_STATUS.stagedInvalid);
});

test("expected identity checks reject stale source and workflow values", async () => {
  const manifest = buildFixture();
  const expected = {
    packageVersion: "0.1.16",
    qualificationRun: 32678463671,
    qualificationRunAttempt: 2,
    revision: REVISION,
    sourceRef: REF,
    sourceRunId: 32678463671,
    sourceRunAttempt: 2,
    workflowRun: 32680000001,
    workflowRunAttempt: 1,
  };
  await verifyWindowsProductionFinalizerPreparationHandoff(manifest, { expected });
  for (const key of ["revision", "sourceRunId", "workflowRunAttempt"]) {
    const stale = { ...expected, [key]: key === "revision" ? "b".repeat(40) : 999 };
    await assert.rejects(() => verifyWindowsProductionFinalizerPreparationHandoff(manifest, { expected: stale }), (error) => error?.code === FIXED_STATUS.stale);
  }
});

test("verification catches tampered manifest digest and hash mismatch", async () => {
  const manifest = buildFixture();
  const tampered = JSON.parse(serializeWindowsProductionFinalizerPreparationHandoff(manifest));
  tampered.package.sha256 = "1".repeat(64);
  assert.doesNotThrow(() => validateWindowsProductionFinalizerPreparationHandoff(tampered));
  await assert.rejects(
    () => verifyWindowsProductionFinalizerPreparationHandoff(tampered, {
      packageJsonBytes: Buffer.from(JSON.stringify({ name: "app-usagemonitor", private: true, type: "module", version: "0.1.16" })),
    }),
    (error) => error?.code === FIXED_STATUS.tampered,
  );
  await assert.rejects(
    () => verifyWindowsProductionFinalizerPreparationHandoff(tampered, {
      lockfileBytes: Buffer.from("lockfileVersion: '9.0'\n"),
    }),
    (error) => error?.code === FIXED_STATUS.tampered,
  );
  const encoded = encodeWindowsProductionFinalizerPreparationHandoff(manifest);
  assertCode(() => decodeWindowsProductionFinalizerPreparationHandoff(encoded.base64, "1".repeat(64)), FIXED_STATUS.mismatch);
});

test("file-backed preparation requires explicit proof when v2 handoff is omitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-preparation-") );
  const stage = join(root, "stage");
  const repo = join(root, "repo");
  try {
    await mkdir(join(stage, "app"), { recursive: true });
    await mkdir(join(stage, "native/windows-filesystem/build/Release"), { recursive: true });
    await mkdir(join(stage, "node_modules/@github/keytar/prebuilds/win32-x64"), { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(join(stage, "app/main.js"), "main-stage");
    await writeFile(join(stage, BINDING_PATH), "binding-stage");
    const keytar = await readFile(resolve("node_modules", "@github/keytar/prebuilds/win32-x64/keytar.node"));
    await writeFile(join(stage, KEYTAR_PATH), keytar);
    const packageBytes = Buffer.from(JSON.stringify({ name: "app-usagemonitor", private: true, type: "module", version: "0.1.16" }));
    const lockfileBytes = Buffer.from("lockfileVersion: '9.0'\n");
    await writeFile(join(repo, "package.json"), packageBytes);
    await writeFile(join(repo, "pnpm-lock.yaml"), lockfileBytes);
    const bindingBytes = Buffer.from("binding-stage");
    const proof = fixtureInput().qualification;
    proof.binding.bytes = bindingBytes.length;
    proof.binding.sha256 = HASH(bindingBytes);
    const prepared = await buildWindowsProductionFinalizerPreparationHandoffFromFiles({
      qualification: proof,
      stagingRoot: stage,
      sourceRevision: REVISION,
      sourceRef: REF,
      sourceRunId: proof.run,
      packageJsonPath: join(repo, "package.json"),
      lockfilePath: join(repo, "pnpm-lock.yaml"),
      workflowRunId: 32680000001,
      workflowRunAttempt: 1,
    });
    assert.equal(prepared.native.keytar.sha256, KEYTAR_HASH);
    assert.equal(prepared.native.filesystemBinding.sha256, HASH(bindingBytes));
    await assert.rejects(
      () => buildWindowsProductionFinalizerPreparationHandoffFromFiles({
        qualification: { ...proof, binding: { ...proof.binding, sha256: "1".repeat(64) } },
        stagingRoot: stage,
        sourceRevision: REVISION,
        sourceRef: REF,
        sourceRunId: proof.run,
        packageJsonPath: join(repo, "package.json"),
        lockfilePath: join(repo, "pnpm-lock.yaml"),
        workflowRunId: 32680000001,
        workflowRunAttempt: 1,
      }),
      (error) => error?.code === FIXED_STATUS.mismatch,
    );
    await assert.rejects(
      () => buildWindowsProductionFinalizerPreparationHandoffFromFiles({
        stagingRoot: stage,
        sourceRevision: REVISION,
        sourceRef: REF,
        sourceRunId: proof.run,
      }),
      (error) => error?.code === FIXED_STATUS.qualificationInvalid,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file-backed preparation rejects a hard-linked input before reading it", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-preparation-link-"));
  const stage = join(root, "stage");
  const repo = join(root, "repo");
  try {
    await mkdir(join(stage, "native/windows-filesystem/build/Release"), { recursive: true });
    await mkdir(join(stage, "node_modules/@github/keytar/prebuilds/win32-x64"), { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(join(stage, BINDING_PATH), "binding-stage");
    const keytar = await readFile(resolve("node_modules", "@github/keytar/prebuilds/win32-x64/keytar.node"));
    await writeFile(join(stage, KEYTAR_PATH), keytar);
    await writeFile(join(stage, "app.js"), "stage");
    const packagePath = join(repo, "package.json");
    await writeFile(packagePath, JSON.stringify({ name: "app-usagemonitor", private: true, type: "module", version: "0.1.16" }));
    const linkedPackagePath = join(repo, "package-hardlink.json");
    await link(packagePath, linkedPackagePath);
    await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const proof = fixtureInput().qualification;
    const binding = Buffer.from("binding-stage");
    proof.binding = { bytes: binding.length, path: BINDING_PATH, sha256: HASH(binding) };
    await assert.rejects(
      () => buildWindowsProductionFinalizerPreparationHandoffFromFiles({
        qualification: proof,
        stagingRoot: stage,
        sourceRevision: REVISION,
        sourceRef: REF,
        sourceRunId: proof.run,
        packageJsonPath: linkedPackagePath,
        lockfilePath: join(repo, "pnpm-lock.yaml"),
      }),
      (error) => error?.code === FIXED_STATUS.packageInvalid,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI argument parser supports optional source handoff only with proof", () => {
  const base = [
    "--output", "/tmp/manifest.json",
    "--staging-root", "/tmp/stage",
    "--source-revision", REVISION,
    "--source-ref", REF,
    "--source-run-id", "123",
  ];
  const withHandoff = parseWindowsProductionFinalizerPreparationHandoffArguments([
    ...base,
    "--source-handoff", "/tmp/handoff.json",
  ]);
  assert.equal(withHandoff.sourceHandoff, "/tmp/handoff.json");
  const withProof = parseWindowsProductionFinalizerPreparationHandoffArguments([
    ...base,
    "--qualification-proof", "/tmp/proof.json",
  ]);
  assert.equal(withProof.qualificationProof, "/tmp/proof.json");
  assertCode(() => parseWindowsProductionFinalizerPreparationHandoffArguments(base), FIXED_STATUS.inputMissing);
});

test("CLI verification requires every preparation identity and root-file path", () => {
  const base = [
    "--verify",
    "--manifest", "/tmp/manifest.json",
    "--expected-sha256", "a".repeat(64),
    "--staging-root", "/tmp/stage",
    "--source-revision", REVISION,
    "--source-ref", REF,
    "--source-run-id", "123",
    "--source-run-attempt", "2",
    "--workflow-run-id", "456",
    "--workflow-run-attempt", "1",
    "--package-json", "/tmp/package.json",
    "--lockfile", "/tmp/pnpm-lock.yaml",
  ];
  const parsed = parseWindowsProductionFinalizerPreparationHandoffArguments(base);
  assert.equal(parsed.verify, true);
  for (const [flag, value] of [
    ["--source-run-attempt", "2"],
    ["--workflow-run-id", "456"],
    ["--workflow-run-attempt", "1"],
    ["--package-json", "/tmp/package.json"],
    ["--lockfile", "/tmp/pnpm-lock.yaml"],
  ]) {
    const index = base.indexOf(flag);
    assert.equal(base[index + 1], value);
    const missing = [...base.slice(0, index), ...base.slice(index + 2)];
    assertCode(
      () => parseWindowsProductionFinalizerPreparationHandoffArguments(missing),
      FIXED_STATUS.inputMissing,
    );
  }
});
