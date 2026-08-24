import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  FIXED_STATUS,
  WINDOWS_FINALIZER_SOURCE_EVIDENCE_ARTIFACT_EXPECTATION,
  WINDOWS_FINALIZER_SOURCE_EVIDENCE_CLEAN_ARTIFACT_FILE,
  WINDOWS_FINALIZER_SOURCE_EVIDENCE_DOWNLOAD_ACTION,
  WINDOWS_FINALIZER_SOURCE_EVIDENCE_REF,
  WINDOWS_FINALIZER_SOURCE_EVIDENCE_REPOSITORY,
  WINDOWS_FINALIZER_SOURCE_EVIDENCE_RUN_METADATA_FILE,
  WINDOWS_FINALIZER_SOURCE_EVIDENCE_SELECTION_FILE,
  WINDOWS_FINALIZER_SOURCE_EVIDENCE_STATUS,
  WINDOWS_FINALIZER_SOURCE_EVIDENCE_WARM_ARTIFACT_FILE,
  WINDOWS_FINALIZER_SOURCE_EVIDENCE_WARM_DESTINATION,
  WINDOWS_FINALIZER_SOURCE_EVIDENCE_CLEAN_DESTINATION,
  WINDOWS_FINALIZER_SOURCE_EVIDENCE_MAXIMUM_JSON_DEPTH,
  WindowsFinalizerSourceEvidenceError,
  parseWindowsFinalizerSourceEvidenceArguments,
  runWindowsFinalizerSourceEvidence,
  runWindowsFinalizerSourceEvidenceForTest,
  selectWindowsFinalizerSourceEvidence,
  serializeWindowsFinalizerSourceEvidenceSelection,
  validateWindowsFinalizerSourceEvidenceSelection,
} from "../scripts/select-windows-finalizer-source-evidence.mjs";
import {
  validateWindowsPortabilityRunMetadata,
} from "../scripts/verify-windows-finalizer-qualification-handoff.mjs";

const REVISION = "a".repeat(40);
const RUN_ID = 123456789;
const RUN_ATTEMPT = 2;
const SCRIPT = "scripts/select-windows-finalizer-source-evidence.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runValue(overrides = {}) {
  return {
    id: RUN_ID,
    path: ".github/workflows/windows-portability.yml@refs/heads/main",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_sha: REVISION,
    run_attempt: RUN_ATTEMPT,
    head_branch: "main",
    repository: { full_name: WINDOWS_FINALIZER_SOURCE_EVIDENCE_REPOSITORY },
    html_url: "https://github.invalid/private-run",
    ...overrides,
  };
}

function artifactValue(mode, id, overrides = {}) {
  return {
    id,
    name:
      `tibotattle-windows-electron-qualification-${RUN_ID}-${RUN_ATTEMPT}-${REVISION}-${mode}.json`,
    digest: `sha256:${mode === "warm" ? "b" : "c".repeat(64)}`,
    expired: false,
    size_in_bytes: 41,
    workflow_run: { id: RUN_ID, head_sha: REVISION },
    archive_download_url: "https://github.invalid/private-artifact",
    ...overrides,
  };
}

function fixedArtifactValue(mode, id, overrides = {}) {
  const value = artifactValue(mode, id, overrides);
  if (!Object.hasOwn(overrides, "digest")) {
    value.digest = `sha256:${(mode === "warm" ? "b" : "c").repeat(64)}`;
  }
  return value;
}

function artifactListValue(artifacts = [
  fixedArtifactValue("clean", 222),
  fixedArtifactValue("warm", 111),
]) {
  return { total_count: artifacts.length, artifacts };
}

function inputValue(overrides = {}) {
  const run = runValue();
  const artifacts = artifactListValue();
  return {
    repository: WINDOWS_FINALIZER_SOURCE_EVIDENCE_REPOSITORY,
    revision: REVISION,
    ref: WINDOWS_FINALIZER_SOURCE_EVIDENCE_REF,
    runId: RUN_ID,
    runMetadataBytes: Buffer.from(JSON.stringify({ ...run, ...overrides.run }), "utf8"),
    artifactListBytes: Buffer.from(
      JSON.stringify(overrides.artifactList ?? artifacts),
      "utf8",
    ),
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error instanceof WindowsFinalizerSourceEvidenceError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, "Windows finalizer source evidence selection failed");
    return true;
  };
}

test("selects an order-independent warm/clean pair and emits content-free contract", () => {
  const input = inputValue({
    artifactList: artifactListValue([
      fixedArtifactValue("warm", 111),
      {
        ...fixedArtifactValue("warm", 333),
        name: "tibotattle-windows-x64-electron-other",
      },
      fixedArtifactValue("clean", 222),
    ]),
  });
  const selected = selectWindowsFinalizerSourceEvidence(input);
  assert.equal(selected.status, WINDOWS_FINALIZER_SOURCE_EVIDENCE_STATUS);
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected.selectionReceipt), true);
  assert.deepEqual(
    Object.keys(selected.artifacts),
    ["warm", "clean"],
  );
  assert.equal(selected.artifacts.warm.id, 111);
  assert.equal(selected.artifacts.clean.id, 222);
  assert.equal(selected.selectionReceipt.download.action, WINDOWS_FINALIZER_SOURCE_EVIDENCE_DOWNLOAD_ACTION);
  assert.equal(
    selected.selectionReceipt.download.artifactExpectation,
    WINDOWS_FINALIZER_SOURCE_EVIDENCE_ARTIFACT_EXPECTATION,
  );
  assert.deepEqual(selected.selectionReceipt.download.artifactIds, { clean: 222, warm: 111 });
  assert.equal(
    selected.selectionReceipt.download.destinations.warm,
    WINDOWS_FINALIZER_SOURCE_EVIDENCE_WARM_DESTINATION,
  );
  assert.equal(
    selected.selectionReceipt.download.destinations.clean,
    WINDOWS_FINALIZER_SOURCE_EVIDENCE_CLEAN_DESTINATION,
  );
  assert.equal(selected.selectionReceipt.receiptHandling, "deferred_to_handoff_verifier");
  assert.equal("receiptBytes" in selected.selectionReceipt, false);
  assert.equal(
    selected.selectionReceipt.rawMetadata.runSha256,
    sha256(input.runMetadataBytes),
  );
  assert.equal(
    selected.selectionReceipt.rawMetadata.artifactListSha256,
    sha256(input.artifactListBytes),
  );
  const serialized = serializeWindowsFinalizerSourceEvidenceSelection(
    selected.selectionReceipt,
  );
  assert.equal(serialized.endsWith("\n"), true);
  assert.deepEqual(
    validateWindowsFinalizerSourceEvidenceSelection(JSON.parse(serialized)),
    selected.selectionReceipt,
  );
});

test("binds the direct raw upload artifact name to the prepared receipt basename", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/windows-portability.yml", import.meta.url),
    "utf8",
  );
  const uploadId = workflow.indexOf("id: windows_qualification_receipt_raw_upload");
  assert.ok(uploadId >= 0);
  const uploadStart = workflow.lastIndexOf("      - name:", uploadId);
  const uploadEnd = workflow.indexOf("\n      - name:", uploadId + 1);
  assert.ok(uploadStart >= 0);
  assert.ok(uploadEnd > uploadStart);
  const uploadStep = workflow.slice(uploadStart, uploadEnd);
  assert.match(
    uploadStep,
    /name: \$\{\{ env\.TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_BASENAME \}\}/u,
  );
  assert.match(
    uploadStep,
    /path: \$\{\{ env\.TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_RAW_PATH \}\}/u,
  );
  assert.match(uploadStep, /archive: false/u);
  assert.doesNotMatch(uploadStep, /path:\s*\|/u);
});

test("rejects every requested workflow-run mismatch", () => {
  const cases = [
    ["id", RUN_ID + 1, FIXED_STATUS.runMismatch],
    ["head_sha", "b".repeat(40), FIXED_STATUS.runMismatch],
    ["path", ".github/workflows/other.yml@refs/heads/main", FIXED_STATUS.runInvalid],
    ["path", ".github/workflows/windows-portability.yml@refs/heads/feature", FIXED_STATUS.runInvalid],
    ["event", "push", FIXED_STATUS.runInvalid],
    ["status", "in_progress", FIXED_STATUS.runInvalid],
    ["conclusion", "failure", FIXED_STATUS.runInvalid],
    ["run_attempt", 0, FIXED_STATUS.runInvalid],
    ["head_branch", "feature", FIXED_STATUS.runMismatch],
    ["repository", { full_name: "evil/example" }, FIXED_STATUS.runInvalid],
  ];
  for (const [field, value, code] of cases) {
    const overrides = { run: { [field]: value } };
    assert.throws(
      () => selectWindowsFinalizerSourceEvidence(inputValue(overrides)),
      expectCode(code),
      field,
    );
  }
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence(inputValue({
      run: {
        path: ".github/workflows/windows-portability.yml",
        head_branch: undefined,
      },
    })),
    expectCode(FIXED_STATUS.runInvalid),
  );
  assert.equal(
    selectWindowsFinalizerSourceEvidence(inputValue({
      run: { path: ".github/workflows/windows-portability.yml" },
    })).runMetadata.workflowPath,
    ".github/workflows/windows-portability.yml",
  );
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence({
      ...inputValue(),
      ref: "refs/heads/feature",
    }),
    expectCode(FIXED_STATUS.inputInvalid),
  );
});

test("requires one complete warm/clean direct-artifact pair", () => {
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence(inputValue({
      artifactList: artifactListValue([fixedArtifactValue("warm", 111)]),
    })),
    expectCode(FIXED_STATUS.artifactMismatch),
  );
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence(inputValue({
      artifactList: artifactListValue([
        fixedArtifactValue("warm", 111),
        fixedArtifactValue("warm", 112),
        fixedArtifactValue("clean", 222),
      ]),
    })),
    expectCode(FIXED_STATUS.duplicateArtifact),
  );
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence(inputValue({
      artifactList: artifactListValue([
        {
          ...fixedArtifactValue("diagnostic", 111),
          name: "unrelated-diagnostic-artifact",
        },
        fixedArtifactValue("warm", 111),
        fixedArtifactValue("clean", 222),
      ]),
    })),
    expectCode(FIXED_STATUS.duplicateArtifact),
  );
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence(inputValue({
      artifactList: {
        total_count: 3,
        artifacts: [fixedArtifactValue("warm", 111), fixedArtifactValue("clean", 222)],
      },
    })),
    expectCode(FIXED_STATUS.artifactListIncomplete),
  );
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence(inputValue({
      artifactList: {
        total_count: 257,
        artifacts: [],
      },
    })),
    expectCode(FIXED_STATUS.artifactListIncomplete),
  );
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence(inputValue({
      artifactList: {
        total_count: 2,
        artifacts: artifactListValue().artifacts,
        next_page: 2,
      },
    })),
    expectCode(FIXED_STATUS.artifactListIncomplete),
  );
});

test("rejects direct-artifact field, digest, expiry, size, and source-run mismatches", () => {
  const cases = [
    ["expired", true, FIXED_STATUS.artifactInvalid],
    ["size_in_bytes", 0, FIXED_STATUS.artifactInvalid],
    ["size_in_bytes", 16_777_217, FIXED_STATUS.artifactInvalid],
    ["digest", "sha256:not-a-digest", FIXED_STATUS.artifactInvalid],
    ["id", "111", FIXED_STATUS.artifactInvalid],
    ["workflow_run", { id: RUN_ID + 1, head_sha: REVISION }, FIXED_STATUS.artifactMismatch],
    ["workflow_run", { id: RUN_ID, head_sha: "b".repeat(40) }, FIXED_STATUS.artifactMismatch],
    ["name", "tibotattle-windows-electron-qualification-wrong.json", FIXED_STATUS.artifactMismatch],
  ];
  for (const [field, value, code] of cases) {
    const artifacts = artifactListValue([
      fixedArtifactValue("clean", 222),
      fixedArtifactValue("warm", 111, { [field]: value }),
    ]);
    assert.throws(
      () => selectWindowsFinalizerSourceEvidence(inputValue({ artifactList: artifacts })),
      expectCode(code),
      field,
    );
  }
});

test("hashes raw bytes before parse and rejects duplicate keys and oversize", () => {
  const duplicateRun = Buffer.from(
    `{"id":${RUN_ID},"id":${RUN_ID},"path":".github/workflows/windows-portability.yml","event":"workflow_dispatch","status":"completed","conclusion":"success","head_sha":"${REVISION}","run_attempt":${RUN_ATTEMPT},"repository":{"full_name":"${WINDOWS_FINALIZER_SOURCE_EVIDENCE_REPOSITORY}"}}`,
    "utf8",
  );
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence({
      ...inputValue(),
      runMetadataBytes: duplicateRun,
    }),
    expectCode(FIXED_STATUS.duplicateJsonKey),
  );
  const duplicateList = Buffer.from(
    '{"total_count":2,"total_count":2,"artifacts":[]}',
    "utf8",
  );
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence({
      ...inputValue(),
      artifactListBytes: duplicateList,
    }),
    expectCode(FIXED_STATUS.duplicateJsonKey),
  );
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence({
      ...inputValue(),
      runMetadataBytes: Buffer.alloc(512 * 1024 + 1, 0x20),
    }),
    expectCode(FIXED_STATUS.rawRunInvalid),
  );
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence({
      ...inputValue(),
      artifactListBytes: Buffer.alloc(512 * 1024 + 1, 0x20),
    }),
    expectCode(FIXED_STATUS.rawArtifactListInvalid),
  );
  let nested = "0";
  for (let index = 0; index <= WINDOWS_FINALIZER_SOURCE_EVIDENCE_MAXIMUM_JSON_DEPTH; index += 1) {
    nested = `{"x":${nested}}`;
  }
  const deepRunText = `${JSON.stringify(runValue()).slice(0, -1)},"nested":${nested}}`;
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence({
      ...inputValue(),
      runMetadataBytes: Buffer.from(deepRunText, "utf8"),
    }),
    expectCode(FIXED_STATUS.rawRunInvalid),
  );
});

async function fileFixture() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-source-selector-"));
  const inputRoot = join(root, "inputs");
  const outputRoot = join(root, "output");
  await mkdir(inputRoot);
  await mkdir(outputRoot);
  const input = inputValue();
  const runPath = join(inputRoot, "run.json");
  const artifactPath = join(inputRoot, "artifacts.json");
  await writeFile(runPath, input.runMetadataBytes, { mode: 0o600 });
  await writeFile(artifactPath, input.artifactListBytes, { mode: 0o600 });
  return { root, input, runPath, artifactPath, outputRoot };
}

function runnerOptions(fixture, overrides = {}) {
  return {
    artifactListPath: fixture.artifactPath,
    outputRoot: fixture.outputRoot,
    ref: WINDOWS_FINALIZER_SOURCE_EVIDENCE_REF,
    repository: WINDOWS_FINALIZER_SOURCE_EVIDENCE_REPOSITORY,
    revision: REVISION,
    runId: RUN_ID,
    runMetadataPath: fixture.runPath,
    ...overrides,
  };
}

test("writes closed verifier-compatible files only once under a fresh root", async (t) => {
  const fixture = await fileFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const first = await runWindowsFinalizerSourceEvidence(runnerOptions(fixture));
  assert.equal(first.status, WINDOWS_FINALIZER_SOURCE_EVIDENCE_STATUS);
  const runBytes = await readFile(join(fixture.outputRoot, WINDOWS_FINALIZER_SOURCE_EVIDENCE_RUN_METADATA_FILE));
  const run = JSON.parse(runBytes);
  assert.deepEqual(
    validateWindowsPortabilityRunMetadata(run, {
      repository: WINDOWS_FINALIZER_SOURCE_EVIDENCE_REPOSITORY,
      revision: REVISION,
      ref: WINDOWS_FINALIZER_SOURCE_EVIDENCE_REF,
    }),
    {
      conclusion: "success",
      databaseId: RUN_ID,
      event: "workflow_dispatch",
      headSha: REVISION,
      ref: WINDOWS_FINALIZER_SOURCE_EVIDENCE_REF,
      repository: WINDOWS_FINALIZER_SOURCE_EVIDENCE_REPOSITORY,
      runAttempt: RUN_ATTEMPT,
      status: "completed",
      workflowPath: ".github/workflows/windows-portability.yml",
    },
  );
  for (const file of [
    WINDOWS_FINALIZER_SOURCE_EVIDENCE_WARM_ARTIFACT_FILE,
    WINDOWS_FINALIZER_SOURCE_EVIDENCE_CLEAN_ARTIFACT_FILE,
    WINDOWS_FINALIZER_SOURCE_EVIDENCE_SELECTION_FILE,
  ]) {
    const bytes = await readFile(join(fixture.outputRoot, file));
    assert.equal(bytes.toString("utf8").endsWith("\n"), true);
    assert.equal((await readFile(join(fixture.outputRoot, file))).includes(0), false);
  }
  const preserved = await readFile(join(fixture.outputRoot, WINDOWS_FINALIZER_SOURCE_EVIDENCE_SELECTION_FILE));
  await assert.rejects(
    runWindowsFinalizerSourceEvidence(runnerOptions(fixture)),
    expectCode(FIXED_STATUS.outputExists),
  );
  assert.deepEqual(
    await readFile(join(fixture.outputRoot, WINDOWS_FINALIZER_SOURCE_EVIDENCE_SELECTION_FILE)),
    preserved,
  );
});

test("rolls back a mid-publication failure without leaving partial output", async (t) => {
  const fixture = await fileFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(
    runWindowsFinalizerSourceEvidenceForTest(
      runnerOptions(fixture),
      "after-publish",
    ),
    expectCode(FIXED_STATUS.outputInvalid),
  );
  assert.deepEqual(await readdir(fixture.outputRoot), []);
});

test("refuses a replaced output root during publication", async (t) => {
  const fixture = await fileFixture();
  const replacementRoot = `${fixture.outputRoot}.replaced`;
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  t.after(() => rm(replacementRoot, { recursive: true, force: true }));
  await assert.rejects(
    runWindowsFinalizerSourceEvidenceForTest(
      runnerOptions(fixture),
      "replace-root-before-publish",
    ),
    expectCode(FIXED_STATUS.outputInvalid),
  );
  assert.deepEqual(await readdir(fixture.outputRoot), []);
  assert.equal((await readdir(replacementRoot)).includes(".tibotattle-source-evidence-attempt"), true);
});

test("rejects output reuse, output symlink roots, input symlinks, and input hardlinks", async (t) => {
  const fixture = await fileFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const reused = join(fixture.root, "reused");
  await mkdir(reused);
  await writeFile(join(reused, "sentinel"), "keep", { mode: 0o600 });
  assert.rejects(
    runWindowsFinalizerSourceEvidence(runnerOptions(fixture, { outputRoot: reused })),
    expectCode(FIXED_STATUS.outputExists),
  );

  const linkedRoot = join(fixture.root, "linked-output");
  await symlink(fixture.outputRoot, linkedRoot);
  await assert.rejects(
    runWindowsFinalizerSourceEvidence(runnerOptions(fixture, { outputRoot: linkedRoot })),
    expectCode(FIXED_STATUS.outputInvalid),
  );

  if (process.platform !== "win32") {
    const linkedInput = join(fixture.root, "linked-run.json");
    await symlink(fixture.runPath, linkedInput);
    await assert.rejects(
      runWindowsFinalizerSourceEvidence(runnerOptions(fixture, { runMetadataPath: linkedInput })),
      expectCode(FIXED_STATUS.rawRunInvalid),
    );

    const hardlinkedInput = join(fixture.root, "hardlinked-run.json");
    await link(fixture.runPath, hardlinkedInput);
    await assert.rejects(
      runWindowsFinalizerSourceEvidence(runnerOptions(fixture, { runMetadataPath: hardlinkedInput })),
      expectCode(FIXED_STATUS.rawRunInvalid),
    );
  } else {
    t.diagnostic("symlink/hardlink refusal is covered on POSIX hosts");
  }
});

test("rejects proxies, accessors, and open-schema option objects", () => {
  const input = inputValue();
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence(new Proxy(input, {})),
    expectCode(FIXED_STATUS.inputInvalid),
  );
  const getterInput = { ...input };
  Object.defineProperty(getterInput, "revision", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("private revision");
    },
  });
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence(getterInput),
    expectCode(FIXED_STATUS.inputInvalid),
  );
  const getterRun = runValue();
  Object.defineProperty(getterRun, "head_sha", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("private head sha");
    },
  });
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence({
      ...input,
      runMetadataBytes: Buffer.from(JSON.stringify(getterRun)),
    }),
    // JSON.stringify evaluates the getter before the selector; the public
    // raw-byte boundary is intentionally the point at which accessors stop.
    /private head sha/,
  );
  const getterArtifact = fixedArtifactValue("warm", 111);
  Object.defineProperty(getterArtifact, "digest", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("private digest");
    },
  });
  const list = artifactListValue([fixedArtifactValue("clean", 222), getterArtifact]);
  // Constructing raw REST bytes from a getter is caller-side and therefore
  // not accepted as evidence; the selector itself never invokes it.
  assert.throws(
    () => JSON.stringify(list),
    /private digest/,
  );
  assert.throws(
    () => selectWindowsFinalizerSourceEvidence({ ...input, extra: true }),
    expectCode(FIXED_STATUS.inputInvalid),
  );
  const receipt = selectWindowsFinalizerSourceEvidence(input).selectionReceipt;
  assert.throws(
    () => validateWindowsFinalizerSourceEvidenceSelection(new Proxy(receipt, {})),
    expectCode(FIXED_STATUS.inputInvalid),
  );
  const getterReceipt = structuredClone(receipt);
  Object.defineProperty(getterReceipt, "status", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("private selector status");
    },
  });
  assert.throws(
    () => validateWindowsFinalizerSourceEvidenceSelection(getterReceipt),
    expectCode(FIXED_STATUS.inputInvalid),
  );
});

test("CLI rejects duplicate/unknown flags and never leaks paths", async (t) => {
  const fixture = await fileFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const base = [
    SCRIPT,
    "--artifact-list", fixture.artifactPath,
    "--output-root", fixture.outputRoot,
    "--ref", WINDOWS_FINALIZER_SOURCE_EVIDENCE_REF,
    "--repository", WINDOWS_FINALIZER_SOURCE_EVIDENCE_REPOSITORY,
    "--revision", REVISION,
    "--run-id", String(RUN_ID),
    "--run-metadata", fixture.runPath,
  ];
  const success = spawnSync(process.execPath, base, { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, `${WINDOWS_FINALIZER_SOURCE_EVIDENCE_STATUS}\n`);
  assert.equal(success.stderr, "");
  assert.doesNotMatch(success.stdout, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));

  const duplicate = spawnSync(process.execPath, [
    ...base,
    "--ref", WINDOWS_FINALIZER_SOURCE_EVIDENCE_REF,
  ], { encoding: "utf8" });
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.stdout, "");
  assert.equal(duplicate.stderr.trim(), FIXED_STATUS.duplicateFlag);
  assert.doesNotMatch(duplicate.stderr, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));

  const unknown = spawnSync(process.execPath, [
    ...base.slice(0, -2),
    "--unknown", fixture.root,
  ], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, "");
  assert.equal(unknown.stderr.trim(), FIXED_STATUS.inputInvalid);
  assert.doesNotMatch(unknown.stderr, /private|run\.json|selection-receipt|output/iu);
});

test("argument parser accepts only the fixed flag vector", () => {
  assert.throws(
    () => parseWindowsFinalizerSourceEvidenceArguments(["--unknown", "/tmp/private"]),
    expectCode(FIXED_STATUS.inputInvalid),
  );
  assert.throws(
    () => parseWindowsFinalizerSourceEvidenceArguments([
      "--run-id", "1", "--run-id", "2",
    ]),
    expectCode(FIXED_STATUS.duplicateFlag),
  );
  assert.throws(
    () => parseWindowsFinalizerSourceEvidenceArguments([]),
    expectCode(FIXED_STATUS.inputMissing),
  );
});
