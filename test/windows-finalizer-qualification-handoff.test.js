import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  buildWindowsElectronQualificationReceipt,
} from "../scripts/build-windows-electron-qualification-receipt.mjs";
import {
  FIXED_STATUS,
  WINDOWS_FINALIZER_EVENT,
  WINDOWS_FINALIZER_EXPECTED_REPOSITORY,
  WINDOWS_FINALIZER_HANDOFF_SCHEMA,
  WINDOWS_FINALIZER_HANDOFF_STATUS,
  WINDOWS_FINALIZER_PRODUCTION_READINESS,
  WINDOWS_FINALIZER_RUN_CONCLUSION,
  WINDOWS_FINALIZER_RUN_STATUS,
  WINDOWS_FINALIZER_TARGET,
  WINDOWS_FINALIZER_WORKFLOW_PATH,
  buildWindowsFinalizerQualificationHandoff,
  validateWindowsElectronQualificationReceipt,
  validateWindowsFinalizerQualificationHandoff,
  validateWindowsPortabilityRunMetadata,
} from "../scripts/verify-windows-finalizer-qualification-handoff.mjs";

const REVISION = "a".repeat(40);
const BINDING_SHA256 = "b".repeat(64);
const REPOSITORY = WINDOWS_FINALIZER_EXPECTED_REPOSITORY;
const REF = "refs/heads/codex/windows-electron-current-main";
const RUN_ID = 32484301053;
const RUN_ATTEMPT = 2;
const WARM_RECEIPT_SHA256 = "d".repeat(64);
const CLEAN_RECEIPT_SHA256 = "e".repeat(64);
const RECEIPT_BYTES = 2345;
const WARM_ARTIFACT_ID = 901;
const CLEAN_ARTIFACT_ID = 902;

function receiptFixture({ cacheMode = "warm", revision = REVISION, bindingSha256 = BINDING_SHA256 } = {}) {
  const aggregate = {
    bytes: 4567,
    count: 89,
    sha256: "c".repeat(64),
  };
  const bindingBytes = 1234;
  return buildWindowsElectronQualificationReceipt({
    revision,
    target: WINDOWS_FINALIZER_TARGET,
    cacheMode,
    bindingSha256,
    bindingBytes,
    qualificationResult: [
      "WINDOWS_SECURITY_QUALIFICATION_PASSED",
      "files=22",
      "filesystem=10",
      "credentials=8",
      `revision=${revision}`,
      `cache=${cacheMode}`,
      `binding_bytes=${bindingBytes}`,
      `binding_sha256=${bindingSha256}`,
      "tests=37",
      "passed=37",
      "failed=0",
      "skipped=0",
      "duration_ms=42",
    ].join(" "),
    packagedEvidence: {
      artifact: aggregate,
      asar: aggregate,
      binding: {
        bytes: bindingBytes,
        sha256: bindingSha256,
        status: "included_unverified",
      },
      nativeFileCount: 2,
      staged: aggregate,
      status: "ELECTRON_DEVELOPMENT_ARTIFACT_VERIFIED",
      target: WINDOWS_FINALIZER_TARGET,
      unpacked: aggregate,
    },
    runtimeEvidence: {
      artifact: true,
      cleanQuit: true,
      contentFree: true,
      credentialPersistence: true,
      dashboardReady: true,
      failureReason: "none",
      failureStage: "none",
      noOrphan: true,
      relaunchPersistence: true,
      secondInstanceRejected: true,
      showHideTrayLifecycle: true,
      statePersistence: true,
      status: "passed",
      syntheticRefresh: true,
      target: WINDOWS_FINALIZER_TARGET,
    },
  });
}

function receiptProvenanceFixture({ cacheMode = "warm", runId = RUN_ID } = {}) {
  return {
    bytes: RECEIPT_BYTES,
    runId,
    sha256: cacheMode === "warm" ? WARM_RECEIPT_SHA256 : CLEAN_RECEIPT_SHA256,
  };
}

function artifactFixture({
  cacheMode = "warm",
  id = cacheMode === "warm" ? WARM_ARTIFACT_ID : CLEAN_ARTIFACT_ID,
  revision = REVISION,
  runId = RUN_ID,
  runAttempt = RUN_ATTEMPT,
  receiptProvenance = receiptProvenanceFixture({ cacheMode, runId }),
} = {}) {
  return {
    digest: `sha256:${receiptProvenance.sha256}`,
    expired: false,
    id,
    name: `tibotattle-windows-electron-qualification-${runId}-${runAttempt}-${revision}-${cacheMode}.json`,
    size_in_bytes: receiptProvenance.bytes,
    workflow_run: {
      head_sha: revision,
      id: runId,
    },
  };
}

function runMetadataFixture({ revision = REVISION, ref = REF } = {}) {
  return {
    conclusion: WINDOWS_FINALIZER_RUN_CONCLUSION,
    event: WINDOWS_FINALIZER_EVENT,
    headSha: revision,
    databaseId: RUN_ID,
    ref,
    repository: REPOSITORY,
    runAttempt: RUN_ATTEMPT,
    status: WINDOWS_FINALIZER_RUN_STATUS,
    workflowPath: WINDOWS_FINALIZER_WORKFLOW_PATH,
  };
}

function rawRunMetadataFixture({ revision = REVISION, ref = REF } = {}) {
  const headBranch = ref.replace(/^refs\/heads\//u, "");
  return {
    conclusion: WINDOWS_FINALIZER_RUN_CONCLUSION,
    event: WINDOWS_FINALIZER_EVENT,
    head_branch: headBranch,
    head_sha: revision,
    id: RUN_ID,
    path: `${WINDOWS_FINALIZER_WORKFLOW_PATH}@${ref}`,
    repository: { full_name: REPOSITORY },
    run_attempt: RUN_ATTEMPT,
    status: WINDOWS_FINALIZER_RUN_STATUS,
  };
}

function fullRestRunMetadataFixture({ revision = REVISION, ref = REF } = {}) {
  const headBranch = ref.replace(/^refs\/heads\//u, "");
  return {
    ...rawRunMetadataFixture({ revision, ref }),
    name: "Windows portability canary",
    node_id: "WFR_kwDOA",
    run_number: 123,
    workflow_id: 456,
    url: "https://api.github.com/repos/adamallcock/tibotattle/actions/runs/32484301053",
    html_url: "https://github.com/adamallcock/tibotattle/actions/runs/32484301053",
    jobs_url: "https://api.github.com/repos/adamallcock/tibotattle/actions/runs/32484301053/jobs",
    logs_url: "https://api.github.com/repos/adamallcock/tibotattle/actions/runs/32484301053/logs",
    artifacts_url: "https://api.github.com/repos/adamallcock/tibotattle/actions/runs/32484301053/artifacts",
    created_at: "2026-08-21T12:00:00Z",
    updated_at: "2026-08-21T12:05:00Z",
    path: WINDOWS_FINALIZER_WORKFLOW_PATH,
    head_branch: headBranch,
    repository: {
      full_name: REPOSITORY,
      id: 987654,
      node_id: "R_kgDOA",
      name: "tibotattle",
      private: true,
      url: "https://api.github.com/repos/adamallcock/tibotattle",
      html_url: "https://github.com/adamallcock/tibotattle",
    },
    head_commit: {
      id: revision,
      message: "qualification",
      timestamp: "2026-08-21T12:00:00Z",
    },
    actor: {
      login: "adamallcock",
      id: 123,
    },
  };
}

function fullRestArtifactFixture(artifact) {
  return {
    ...artifact,
    node_id: "MDg6QXJ0aWZhY3Q5MDE",
    url: `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifact.id}`,
    archive_download_url: `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`,
    created_at: "2026-08-21T12:04:00Z",
    expires_at: "2026-09-20T12:04:00Z",
    updated_at: "2026-08-21T12:04:00Z",
    workflow_run: {
      ...artifact.workflow_run,
      repository_id: 987654,
      head_repository_id: 987654,
      head_branch: "codex/windows-electron-current-main",
    },
  };
}

function buildFixture({ warmFirst = true } = {}) {
  const warm = receiptFixture({ cacheMode: "warm" });
  const clean = receiptFixture({ cacheMode: "clean" });
  const warmProvenance = receiptProvenanceFixture({ cacheMode: "warm" });
  const cleanProvenance = receiptProvenanceFixture({ cacheMode: "clean" });
  return {
    repository: REPOSITORY,
    revision: REVISION,
    ref: REF,
    runMetadata: rawRunMetadataFixture(),
    receipts: warmFirst
      ? [
        { artifact: artifactFixture({ cacheMode: "warm", receiptProvenance: warmProvenance }), receipt: warm, receiptProvenance: warmProvenance },
        { artifact: artifactFixture({ cacheMode: "clean", receiptProvenance: cleanProvenance }), receipt: clean, receiptProvenance: cleanProvenance },
      ]
      : [
        { artifact: artifactFixture({ cacheMode: "clean", receiptProvenance: cleanProvenance }), receipt: clean, receiptProvenance: cleanProvenance },
        { artifact: artifactFixture({ cacheMode: "warm", receiptProvenance: warmProvenance }), receipt: warm, receiptProvenance: warmProvenance },
      ],
  };
}

function receiptEntryFixture(cacheMode, overrides = {}) {
  const fixture = buildFixture();
  const entry = fixture.receipts.find((candidate) => candidate.receipt.cacheMode === cacheMode);
  return { ...entry, ...overrides };
}

function cliReceiptFixture(entry) {
  const text = `${JSON.stringify(entry.receipt)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const receiptProvenance = { bytes, runId: RUN_ID, sha256 };
  return {
    artifact: artifactFixture({
      cacheMode: entry.receipt.cacheMode,
      id: entry.artifact.id,
      receiptProvenance,
    }),
    receiptProvenance,
    text,
  };
}

function assertFrozenDeep(value) {
  assert.equal(Object.isFrozen(value), true);
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) assertFrozenDeep(child);
  }
}

test("builds a deeply frozen, content-free prerequisite handoff", () => {
  const handoff = buildWindowsFinalizerQualificationHandoff(buildFixture());
  assert.deepEqual(handoff, {
    productionReadiness: WINDOWS_FINALIZER_PRODUCTION_READINESS,
    receipts: [
      {
        artifact: {
          digest: `sha256:${WARM_RECEIPT_SHA256}`,
          headSha: REVISION,
          id: WARM_ARTIFACT_ID,
          name: `tibotattle-windows-electron-qualification-${RUN_ID}-${RUN_ATTEMPT}-${REVISION}-warm.json`,
          runId: RUN_ID,
          sizeInBytes: RECEIPT_BYTES,
        },
        binding: { bytes: 1234, sha256: BINDING_SHA256 },
        cacheMode: "warm",
        qualification: {
          failed: 0,
          passed: 37,
          skipped: 0,
          status: "WINDOWS_SECURITY_QUALIFICATION_PASSED",
          tests: 37,
        },
        receiptProvenance: {
          bytes: RECEIPT_BYTES,
          runId: RUN_ID,
          sha256: WARM_RECEIPT_SHA256,
        },
        runtimeStatus: "WINDOWS_ELECTRON_RUNTIME_SMOKE_PASSED",
        status: "WINDOWS_ELECTRON_DEVELOPMENT_QUALIFICATION_PASSED",
      },
      {
        artifact: {
          digest: `sha256:${CLEAN_RECEIPT_SHA256}`,
          headSha: REVISION,
          id: CLEAN_ARTIFACT_ID,
          name: `tibotattle-windows-electron-qualification-${RUN_ID}-${RUN_ATTEMPT}-${REVISION}-clean.json`,
          runId: RUN_ID,
          sizeInBytes: RECEIPT_BYTES,
        },
        binding: { bytes: 1234, sha256: BINDING_SHA256 },
        cacheMode: "clean",
        qualification: {
          failed: 0,
          passed: 37,
          skipped: 0,
          status: "WINDOWS_SECURITY_QUALIFICATION_PASSED",
          tests: 37,
        },
        receiptProvenance: {
          bytes: RECEIPT_BYTES,
          runId: RUN_ID,
          sha256: CLEAN_RECEIPT_SHA256,
        },
        runtimeStatus: "WINDOWS_ELECTRON_RUNTIME_SMOKE_PASSED",
        status: "WINDOWS_ELECTRON_DEVELOPMENT_QUALIFICATION_PASSED",
      },
    ],
    repository: REPOSITORY,
    revision: REVISION,
    run: {
      conclusion: WINDOWS_FINALIZER_RUN_CONCLUSION,
      databaseId: RUN_ID,
      event: WINDOWS_FINALIZER_EVENT,
      headSha: REVISION,
      ref: REF,
      runAttempt: RUN_ATTEMPT,
      status: WINDOWS_FINALIZER_RUN_STATUS,
    },
    schemaVersion: WINDOWS_FINALIZER_HANDOFF_SCHEMA,
    status: WINDOWS_FINALIZER_HANDOFF_STATUS,
    target: WINDOWS_FINALIZER_TARGET,
  });
  assertFrozenDeep(handoff);
  const serialized = JSON.stringify(handoff);
  assert.doesNotMatch(serialized, /workflowPath|source|log|stdout|stderr|diagnostic|(?:password|secret|token|credential|username|pid)/iu);
  assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/u);
  assert.doesNotMatch(serialized, /\/Users\/|\/home\//u);
});

test("run metadata accepts only the exact repository, revision, workflow, and success state", () => {
  const valid = validateWindowsPortabilityRunMetadata(runMetadataFixture(), {
    repository: REPOSITORY,
    revision: REVISION,
    ref: REF,
  });
  assert.deepEqual(valid, runMetadataFixture({ revision: REVISION }));
  assert.equal(Object.isFrozen(valid), true);
  for (const [field, replacement] of [
    ["repository", "https://github.com/adamallcock/tibotattle"],
    ["workflowPath", ".github/workflows/other.yml"],
    ["event", "push"],
    ["status", "in_progress"],
    ["conclusion", "failure"],
    ["headSha", "not-a-revision"],
    ["databaseId", Number.MAX_SAFE_INTEGER + 1],
  ]) {
    assert.throws(
      () => validateWindowsPortabilityRunMetadata({ ...runMetadataFixture(), [field]: replacement }, {
        repository: REPOSITORY,
        revision: REVISION,
        ref: REF,
      }),
      (error) => [
        FIXED_STATUS.runInvalid,
        FIXED_STATUS.repositoryInvalid,
        FIXED_STATUS.revisionInvalid,
        FIXED_STATUS.receiptMismatch,
        FIXED_STATUS.numericInvalid,
      ].includes(error.code),
      field,
    );
  }
  assert.throws(
    () => validateWindowsPortabilityRunMetadata({
      ...runMetadataFixture(),
      extra: "C:\\Users\\owner\\secret-token",
    }, { repository: REPOSITORY, revision: REVISION, ref: REF }),
    (error) => error.code === FIXED_STATUS.runInvalid,
  );
});

test("run metadata strictly normalizes the REST response and optional path ref", () => {
  const valid = validateWindowsPortabilityRunMetadata(rawRunMetadataFixture(), {
    repository: REPOSITORY,
    revision: REVISION,
    ref: REF,
  });
  assert.deepEqual(valid, runMetadataFixture());
  assert.equal(Object.isFrozen(valid), true);
  const noPathRef = rawRunMetadataFixture();
  noPathRef.path = WINDOWS_FINALIZER_WORKFLOW_PATH;
  assert.deepEqual(
    validateWindowsPortabilityRunMetadata(noPathRef, {
      repository: REPOSITORY,
      revision: REVISION,
      ref: REF,
    }),
    runMetadataFixture(),
  );
  const noPathOrBranchRef = { ...noPathRef };
  delete noPathOrBranchRef.head_branch;
  assert.deepEqual(
    validateWindowsPortabilityRunMetadata(noPathOrBranchRef, {
      repository: REPOSITORY,
      revision: REVISION,
      ref: REF,
    }),
    runMetadataFixture(),
  );
  for (const replacement of [
    `${WINDOWS_FINALIZER_WORKFLOW_PATH}@refs/heads/other`,
    `${WINDOWS_FINALIZER_WORKFLOW_PATH}@refs/tags/v0.1.15`,
  ]) {
    assert.throws(
      () => validateWindowsPortabilityRunMetadata(
        { ...rawRunMetadataFixture(), path: replacement },
        { repository: REPOSITORY, revision: REVISION, ref: REF },
      ),
      (error) => [FIXED_STATUS.receiptMismatch, FIXED_STATUS.runInvalid].includes(error.code),
    );
  }
  assert.throws(
    () => validateWindowsPortabilityRunMetadata(
      { ...rawRunMetadataFixture(), repository: { full_name: "evil/example" } },
      { repository: REPOSITORY, revision: REVISION, ref: REF },
    ),
    (error) => error.code === FIXED_STATUS.repositoryInvalid,
  );
});

test("run metadata projects a full REST response without retaining extra fields", () => {
  const valid = validateWindowsPortabilityRunMetadata(fullRestRunMetadataFixture(), {
    repository: REPOSITORY,
    revision: REVISION,
    ref: REF,
  });
  assert.deepEqual(valid, runMetadataFixture());
  assert.doesNotMatch(JSON.stringify(valid), /api\.github|actor|head_commit|logs_url|private/iu);
});

test("receipt validation binds exact current schema, status, target, mode, readiness, and identity", () => {
  const warm = validateWindowsElectronQualificationReceipt(receiptFixture(), {
    revision: REVISION,
    expectedCacheMode: "warm",
  });
  assert.equal(warm.cacheMode, "warm");
  assert.equal(warm.productionReadiness, WINDOWS_FINALIZER_PRODUCTION_READINESS);
  assert.equal(Object.isFrozen(warm), true);
  for (const [field, replacement] of [
    ["schemaVersion", "old-schema"],
    ["status", "success"],
    ["target", "win32-arm64"],
    ["mode", "production"],
    ["productionReadiness", "claimed"],
    ["revision", "d".repeat(40)],
    ["cacheMode", "other"],
  ]) {
    assert.throws(
      () => validateWindowsElectronQualificationReceipt({ ...receiptFixture(), [field]: replacement }, {
        revision: REVISION,
      }),
      (error) => [
        FIXED_STATUS.receiptInvalid,
        FIXED_STATUS.receiptMismatch,
        FIXED_STATUS.cacheModeInvalid,
      ].includes(error.code),
      field,
    );
  }
  const mismatchedBinding = receiptFixture({ cacheMode: "clean", bindingSha256: "e".repeat(64) });
  const fixture = buildFixture();
  assert.throws(
    () => buildWindowsFinalizerQualificationHandoff({
      ...fixture,
      receipts: [
        fixture.receipts[0],
        { ...fixture.receipts[1], receipt: mismatchedBinding },
      ],
    }),
    (error) => error.code === FIXED_STATUS.receiptMismatch,
  );
});

test("rejects cross-run receipt and artifact splices", () => {
  const fixture = buildFixture();
  const warm = fixture.receipts[0];
  const clean = fixture.receipts[1];
  for (const receipts of [
    [
      {
        ...warm,
        artifact: artifactFixture({
          cacheMode: "warm",
          runId: RUN_ID + 1,
          receiptProvenance: warm.receiptProvenance,
        }),
      },
      clean,
    ],
    [
      {
        ...warm,
        artifact: {
          ...warm.artifact,
          workflow_run: { ...warm.artifact.workflow_run, head_sha: "f".repeat(40) },
        },
      },
      clean,
    ],
    [
      { ...warm, receiptProvenance: { ...warm.receiptProvenance, runId: RUN_ID + 1 } },
      clean,
    ],
  ]) {
    assert.throws(
      () => buildWindowsFinalizerQualificationHandoff({ ...fixture, receipts }),
      (error) => [FIXED_STATUS.artifactMismatch, FIXED_STATUS.artifactInvalid].includes(error.code),
    );
  }

  const handoff = buildWindowsFinalizerQualificationHandoff(fixture);
  const tampered = structuredClone(handoff);
  tampered.receipts[0].artifact.runId += 1;
  assert.throws(
    () => validateWindowsFinalizerQualificationHandoff(tampered, { revision: REVISION, ref: REF }),
    (error) => error.code === FIXED_STATUS.artifactMismatch,
  );
});

test("handoff requires exactly two distinct warm and clean receipts", () => {
  for (const receipts of [
    [receiptEntryFixture("warm"), receiptEntryFixture("warm")],
    [receiptEntryFixture("clean"), receiptEntryFixture("clean")],
    [receiptEntryFixture("warm")],
    [receiptEntryFixture("warm"), receiptEntryFixture("clean"), receiptEntryFixture("warm")],
  ]) {
    assert.throws(
      () => buildWindowsFinalizerQualificationHandoff({ ...buildFixture(), receipts }),
      (error) => [
        FIXED_STATUS.duplicateCacheMode,
        FIXED_STATUS.receiptInvalid,
        FIXED_STATUS.cacheModeInvalid,
      ].includes(error.code),
    );
  }
});

test("handoff requires distinct warm and clean artifact IDs", () => {
  const fixture = buildFixture();
  fixture.receipts[1] = {
    ...fixture.receipts[1],
    artifact: {
      ...fixture.receipts[1].artifact,
      id: fixture.receipts[0].artifact.id,
    },
  };
  assert.throws(
    () => buildWindowsFinalizerQualificationHandoff(fixture),
    (error) => error.code === FIXED_STATUS.duplicateArtifactId,
  );

  const valid = buildWindowsFinalizerQualificationHandoff(buildFixture());
  const tampered = structuredClone(valid);
  tampered.receipts[1].artifact.id = tampered.receipts[0].artifact.id;
  assert.throws(
    () => validateWindowsFinalizerQualificationHandoff(tampered, {
      repository: REPOSITORY,
      revision: REVISION,
      ref: REF,
    }),
    (error) => error.code === FIXED_STATUS.duplicateArtifactId,
  );
});

test("hostile getters, proxies, symbols, inherited fields, and open data fail without evaluation", () => {
  const fixture = buildFixture();
  let getterCalls = 0;
  const getterReceipt = { ...receiptFixture() };
  Object.defineProperty(getterReceipt, "status", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("getter secret");
    },
  });
  assert.throws(
    () => validateWindowsElectronQualificationReceipt(getterReceipt, { revision: REVISION }),
    (error) => error.code === FIXED_STATUS.receiptInvalid,
  );
  assert.equal(getterCalls, 0);

  const proxiedRun = new Proxy(runMetadataFixture(), {
    get() {
      throw new Error("proxy getter secret");
    },
  });
  assert.throws(
    () => validateWindowsPortabilityRunMetadata(proxiedRun, { revision: REVISION, ref: REF }),
    (error) => error.code === FIXED_STATUS.runInvalid,
  );

  const symbolicRun = runMetadataFixture();
  symbolicRun[Symbol("unexpected")] = true;
  assert.throws(
    () => validateWindowsPortabilityRunMetadata(symbolicRun, { revision: REVISION, ref: REF }),
    (error) => error.code === FIXED_STATUS.runInvalid,
  );

  const inheritedRun = Object.create({ extra: "secret" });
  Object.assign(inheritedRun, runMetadataFixture());
  assert.throws(
    () => validateWindowsPortabilityRunMetadata(inheritedRun, { revision: REVISION, ref: REF }),
    (error) => error.code === FIXED_STATUS.runInvalid,
  );

  const openReceipt = { ...receiptFixture() };
  openReceipt.open = "/Users/owner/private.log";
  assert.throws(
    () => validateWindowsElectronQualificationReceipt(openReceipt, { revision: REVISION }),
    (error) => error.code === FIXED_STATUS.receiptInvalid,
  );
  assert.deepEqual(fixture.receipts.map((entry) => entry.receipt.cacheMode), ["warm", "clean"]);
});

test("built handoff validates as a safe snapshot and rejects tampering", () => {
  const handoff = buildWindowsFinalizerQualificationHandoff(buildFixture({ warmFirst: false }));
  const validated = validateWindowsFinalizerQualificationHandoff(handoff, {
    repository: REPOSITORY,
    revision: REVISION,
    ref: REF,
  });
  assert.deepEqual(validated, handoff);
  assertFrozenDeep(validated);
  for (const mutation of [
    { ...handoff, productionReadiness: "ready" },
    { ...handoff, extra: "log=/private/tmp/secret" },
    { ...handoff, revision: "z".repeat(40) },
  ]) {
    assert.throws(
      () => validateWindowsFinalizerQualificationHandoff(mutation, { revision: REVISION, ref: REF }),
      (error) => [
        FIXED_STATUS.contentInvalid,
        FIXED_STATUS.receiptMismatch,
        FIXED_STATUS.revisionInvalid,
      ].includes(error.code),
    );
  }
});

test("CLI writes a content-free handoff once and never clobbers output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-windows-finalizer-"));
  const runPath = join(directory, "run.json");
  const warmPath = join(directory, "warm.json");
  const cleanPath = join(directory, "clean.json");
  const warmArtifactPath = join(directory, "warm-artifact.json");
  const cleanArtifactPath = join(directory, "clean-artifact.json");
  const outputPath = join(directory, "handoff.json");
  try {
    const fixture = buildFixture();
    const warmFile = cliReceiptFixture(fixture.receipts[0]);
    const cleanFile = cliReceiptFixture(fixture.receipts[1]);
    await Promise.all([
      writeFile(runPath, `${JSON.stringify(fullRestRunMetadataFixture())}\n`),
      writeFile(warmPath, warmFile.text),
      writeFile(cleanPath, cleanFile.text),
      writeFile(
        warmArtifactPath,
        `${JSON.stringify(fullRestArtifactFixture(warmFile.artifact))}\n`,
      ),
      writeFile(
        cleanArtifactPath,
        `${JSON.stringify(fullRestArtifactFixture(cleanFile.artifact))}\n`,
      ),
    ]);
    const args = [
      "scripts/verify-windows-finalizer-qualification-handoff.mjs",
      "--output", outputPath,
      "--repository", REPOSITORY,
      "--revision", REVISION,
      "--ref", REF,
      "--run-metadata", runPath,
      "--warm-receipt", warmPath,
      "--clean-receipt", cleanPath,
      "--warm-artifact", warmArtifactPath,
      "--clean-artifact", cleanArtifactPath,
    ];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), {
      cacheModes: ["clean", "warm"],
      revision: REVISION,
      status: WINDOWS_FINALIZER_HANDOFF_STATUS,
      target: WINDOWS_FINALIZER_TARGET,
    });
    const serialized = await readFile(outputPath, "utf8");
    assert.equal(JSON.parse(serialized).schemaVersion, WINDOWS_FINALIZER_HANDOFF_SCHEMA);
    assert.equal(serialized.endsWith("\n"), true);
    const preserved = serialized;
    const second = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(second.status, 1);
    assert.equal(second.stdout, "");
    assert.equal(second.stderr.trim(), FIXED_STATUS.outputInvalid);
    assert.equal(await readFile(outputPath, "utf8"), preserved);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI failures expose only fixed status tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-windows-finalizer-invalid-"));
  const outputPath = join(directory, "handoff.json");
  const runPath = join(directory, "run.json");
  const warmPath = join(directory, "warm.json");
  const cleanPath = join(directory, "clean.json");
  const warmArtifactPath = join(directory, "warm-artifact.json");
  const cleanArtifactPath = join(directory, "clean-artifact.json");
  try {
    const fixture = buildFixture();
    const warmFile = cliReceiptFixture(fixture.receipts[0]);
    const cleanFile = cliReceiptFixture(fixture.receipts[1]);
    await Promise.all([
      writeFile(
        runPath,
        `${JSON.stringify({
          ...fixture.runMetadata,
          logs: "secret",
          repository: { full_name: "evil/example", private_log: "secret" },
        })}\n`,
      ),
      writeFile(warmPath, warmFile.text),
      writeFile(cleanPath, cleanFile.text),
      writeFile(warmArtifactPath, `${JSON.stringify(warmFile.artifact)}\n`),
      writeFile(cleanArtifactPath, `${JSON.stringify(cleanFile.artifact)}\n`),
    ]);
    const result = spawnSync(process.execPath, [
      "scripts/verify-windows-finalizer-qualification-handoff.mjs",
      "--output", outputPath,
      "--repository", REPOSITORY,
      "--revision", REVISION,
      "--ref", REF,
      "--run-metadata", runPath,
      "--warm-receipt", warmPath,
      "--clean-receipt", cleanPath,
      "--warm-artifact", warmArtifactPath,
      "--clean-artifact", cleanArtifactPath,
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr.trim(), /^WINDOWS_FINALIZER_HANDOFF_[A-Z_]+$/u);
    assert.doesNotMatch(result.stderr, /secret|logs|run\.json/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects oversized, symlink, and special-file inputs before parsing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-windows-finalizer-inputs-"));
  const runPath = join(directory, "run.json");
  const warmPath = join(directory, "warm.json");
  const cleanPath = join(directory, "clean.json");
  const warmArtifactPath = join(directory, "warm-artifact.json");
  const cleanArtifactPath = join(directory, "clean-artifact.json");
  const outputPath = join(directory, "handoff.json");
  const oversizedPath = join(directory, "oversized.json");
  const specialPath = join(directory, "special");
  const symlinkPath = join(directory, "warm-artifact-link.json");
  try {
    const fixture = buildFixture();
    const warmFile = cliReceiptFixture(fixture.receipts[0]);
    const cleanFile = cliReceiptFixture(fixture.receipts[1]);
    await Promise.all([
      writeFile(runPath, `${JSON.stringify(fixture.runMetadata)}\n`),
      writeFile(warmPath, warmFile.text),
      writeFile(cleanPath, cleanFile.text),
      writeFile(warmArtifactPath, `${JSON.stringify(warmFile.artifact)}\n`),
      writeFile(cleanArtifactPath, `${JSON.stringify(cleanFile.artifact)}\n`),
      writeFile(oversizedPath, Buffer.alloc(512 * 1024 + 1, 0x20)),
      mkdir(specialPath),
    ]);
    const args = (overrides = {}) => [
      "scripts/verify-windows-finalizer-qualification-handoff.mjs",
      "--output", outputPath,
      "--repository", REPOSITORY,
      "--revision", REVISION,
      "--ref", REF,
      "--run-metadata", overrides.runMetadata ?? runPath,
      "--warm-receipt", overrides.warmReceipt ?? warmPath,
      "--clean-receipt", cleanPath,
      "--warm-artifact", overrides.warmArtifact ?? warmArtifactPath,
      "--clean-artifact", cleanArtifactPath,
    ];
    const oversized = spawnSync(process.execPath, args({ runMetadata: oversizedPath }), {
      encoding: "utf8",
    });
    assert.equal(oversized.status, 1);
    assert.equal(oversized.stderr.trim(), FIXED_STATUS.runInvalid);

    const special = spawnSync(process.execPath, args({ warmArtifact: specialPath }), {
      encoding: "utf8",
    });
    assert.equal(special.status, 1);
    assert.equal(special.stderr.trim(), FIXED_STATUS.artifactInvalid);

    if (process.platform !== "win32") {
      await symlink(cleanArtifactPath, symlinkPath);
      const linked = spawnSync(process.execPath, args({ warmArtifact: symlinkPath }), {
        encoding: "utf8",
      });
      assert.equal(linked.status, 1);
      assert.equal(linked.stderr.trim(), FIXED_STATUS.artifactInvalid);
    } else {
      t.diagnostic("symlink refusal is covered on POSIX; Windows hosted runners may disallow creation");
    }

    const mismatchedReceiptPath = join(directory, "mismatched-receipt.json");
    await writeFile(mismatchedReceiptPath, '{"secret":"must not be parsed"}\n');
    const mismatched = spawnSync(process.execPath, [
      ...args({ warmReceipt: mismatchedReceiptPath }),
    ], { encoding: "utf8" });
    assert.equal(mismatched.status, 1);
    assert.equal(mismatched.stderr.trim(), FIXED_STATUS.artifactMismatch);
    assert.doesNotMatch(mismatched.stderr, /secret|parsed/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
