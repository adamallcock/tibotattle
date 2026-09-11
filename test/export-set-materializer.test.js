import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVerifiedLocalMetadataBundleBytes } from "../src/bundle-verifier.js";
import {
  decompressExportBytes,
  ExportCompressionError,
  EXPORT_GZIP_PROFILE,
} from "../src/export-compression.js";
import {
  combinedSourcePlanCommitment,
  EXPORT_SET_MANIFEST_BASENAME,
  EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
  ExportSetError,
} from "../src/export/index.js";
import { exportSetChunkBasenames, validateExportSetManifest } from "../src/export-set-schema.js";
import {
  localExportSetMaterialization,
  localExportSetVerification,
  localExportSourcePipeline,
  localExportWorkspace,
} from "../src/local-node-runtime.js";

const { createLocalExportWorkspace } = localExportSourcePipeline.controller;
const { materializeLocalExportSet } = localExportSetMaterialization;
const { verifyLocalExportSet } = localExportSetVerification;
const { openExportWorkspace } = localExportWorkspace;

const SECRET = Buffer.alloc(32, 61);
const PRIVATE_MATERIALIZER_CANARY = "PRIVATE_MATERIALIZER_PROMPT_DO_NOT_EXPORT";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadCompressedChunk(output, chunk, names) {
  const artifactBytes = await readFile(join(output, names.bundle));
  const receiptBytes = await readFile(join(output, names.receipt));
  assert.equal(artifactBytes.length, chunk.artifactBytes);
  assert.equal(sha256(artifactBytes), chunk.artifactSha256);
  const bundleBytes = decompressExportBytes(artifactBytes, {
    maximumEncodedBytes: chunk.artifactBytes,
    maximumDecodedBytes: chunk.bundleBytes,
  });
  return {
    artifactBytes,
    bundleBytes,
    verified: loadVerifiedLocalMetadataBundleBytes({ bundleBytes, receiptBytes }),
  };
}

function usage(input, output, cached, reasoning) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

async function fixture({
  completeWorkspace = true,
  empty = false,
  resourceLimits = {},
  collectorContents = null,
  codexHome = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-materializer-"));
  const home = codexHome ?? join(root, "codex-home");
  const workspace = join(root, "workspace");
  const output = join(root, "output");
  const collectorPath = collectorContents === null ? null : join(root, "collector.jsonl");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const first = usage(100, 20, 40, 8);
  const second = usage(150, 30, 60, 11);
  const lines = [
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "PRIVATE_SESSION", prompt: PRIVATE_MATERIALIZER_CANARY },
    }),
    ...(empty ? [] : [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    JSON.stringify({
      timestamp: "2026-07-24T12:02:00.000Z", type: "event_msg",
      payload: {
        type: "token_count", info: { total_token_usage: first, last_token_usage: first },
        rate_limits: {
          limit_id: "codex", plan_type: "pro",
          primary: { used_percent: 12, window_minutes: 300, resets_at: 1784912400 },
          secondary: { used_percent: 6, window_minutes: 10080, resets_at: 1785430800 },
        },
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:04:00.000Z", type: "event_msg",
      payload: {
        type: "token_count", info: { total_token_usage: second, last_token_usage: usage(50, 10, 20, 3) },
        rate_limits: {
          limit_id: "codex", plan_type: "pro",
          primary: { used_percent: 13, window_minutes: 300, resets_at: 1784912400 },
          secondary: { used_percent: 7, window_minutes: 10080, resets_at: 1785430800 },
        },
      },
    }),
    ]),
  ];
  await writeFile(join(home, "sessions", "rollout-2026-07-24T12-00-00-materializer.jsonl"), `${lines.join("\n")}\n`);
  if (collectorPath !== null) await writeFile(collectorPath, collectorContents, { mode: 0o600 });
  if (completeWorkspace) {
    await createLocalExportWorkspace({
      directory: workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: home,
      secret: SECRET,
      resourceLimits,
      ...(collectorPath === null ? {} : { collectorPath }),
    });
  } else {
    await assert.rejects(createLocalExportWorkspace({
      directory: workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: home,
      secret: SECRET,
      resourceLimits,
      ...(collectorPath === null ? {} : { collectorPath }),
      async failpoint(stage) {
        if (stage === "after_record_batch") throw new Error("leave workspace incomplete");
      },
    }), /leave workspace incomplete/);
  }
  return { root, home, workspace, output, collectorPath };
}

test("materializer publishes deterministic independently verifiable chunks and a complete manifest", async () => {
  const value = await fixture();
  try {
    const first = await materializeLocalExportSet({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      secret: SECRET,
      maximumRecordsPerChunk: 2,
    });
    assert.deepEqual(validateExportSetManifest(first.manifest), { valid: true, errors: [] });
    // Frozen literal logical-record golden. This catches a shared
    // scanner/materializer regression that current-run comparisons do not.
    assert.equal(
      first.manifest.totals.logicalRecordsSha256,
      "23c66a5910c17582ea76d15f095029e5b9e4ff8408646b9bb6efce35f792a5bc",
    );
    assert.equal(first.manifest.chunks.length, 3);
    assert.deepEqual(first.manifest.totals.recordCounts, {
      usageEvents: 2,
      quotaSnapshots: 4,
      activityMarkers: 0,
    });
    assert.ok(first.manifest.totals.decodedBundleBytes > 0);
    assert.ok(first.manifest.totals.encodedArtifactBytes > 0);
    assert.ok(first.manifest.totals.encodedArtifactBytes < first.manifest.totals.decodedBundleBytes);
    assert.deepEqual(first.manifest.compressionRuntime, {
      nodeVersion: process.versions.node,
      zlibVersion: process.versions.zlib,
    });
    const firstArtifacts = [];
    const decodedBundles = [];
    for (const chunk of first.manifest.chunks) {
      const names = exportSetChunkBasenames(chunk.index);
      assert.match(names.bundle, /\.bundle\.json\.gz$/);
      assert.equal(chunk.contentEncoding, EXPORT_GZIP_PROFILE.contentEncoding);
      assert.equal(chunk.compressionProfile, EXPORT_GZIP_PROFILE.profile);
      assert.ok(chunk.artifactBytes <= first.manifest.chunking.maximumEncodedArtifactBytes);
      const loaded = await loadCompressedChunk(value.output, chunk, names);
      const { verified } = loaded;
      firstArtifacts.push(loaded.artifactBytes);
      decodedBundles.push(loaded.bundleBytes);
      assert.equal(verified.bundle.bundleId, chunk.bundleId);
      assert.equal(verified.bundleSha256, chunk.bundleSha256);
      assert.equal(loaded.bundleBytes.length, chunk.bundleBytes);
    }
    assert.equal((await stat(join(value.output, EXPORT_SET_MANIFEST_BASENAME))).mode & 0o777, 0o600);
    const privateArtifacts = [
      join(value.workspace, "workspace.sqlite3"),
      join(value.output, EXPORT_SET_MANIFEST_BASENAME),
      join(value.output, EXPORT_SET_MANIFEST_RECEIPT_BASENAME),
      ...first.manifest.chunks.flatMap((chunk) => {
        const names = exportSetChunkBasenames(chunk.index);
        return [join(value.output, names.bundle), join(value.output, names.receipt)];
      }),
    ];
    for (const artifact of privateArtifacts) {
      assert.equal((await readFile(artifact)).includes(Buffer.from(PRIVATE_MATERIALIZER_CANARY)), false);
    }
    for (const bundleBytes of decodedBundles) {
      assert.equal(bundleBytes.includes(Buffer.from(PRIVATE_MATERIALIZER_CANARY)), false);
    }
    const workspace = await openExportWorkspace({ directory: value.workspace });
    try {
      const descriptor = workspace.getDescriptor();
      const durable = workspace.resourceUsage();
      assert.deepEqual(first.resourceUsage.limits, descriptor.resourceLimits);
      assert.ok(durable.cumulativeElapsedMs >= first.resourceUsage.cumulativeElapsedMs);
      assert.equal(first.resourceUsage.counters.outputRecords, durable.outputRecords);
      assert.equal(first.resourceUsage.counters.expandedRecordBytes, durable.expandedRecordBytes);
    } finally {
      workspace.close();
    }

    const repeated = await materializeLocalExportSet({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      secret: SECRET,
      maximumRecordsPerChunk: 2,
    });
    assert.deepEqual(repeated.manifest, first.manifest);
    assert.deepEqual(repeated.manifestReceipt, first.manifestReceipt);
    for (const [index, chunk] of repeated.manifest.chunks.entries()) {
      const names = exportSetChunkBasenames(chunk.index);
      assert.deepEqual(await readFile(join(value.output, names.bundle)), firstArtifacts[index]);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("materializer adopts an exactly published chunk after interruption", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      materializeLocalExportSet({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
        secret: SECRET,
        maximumRecordsPerChunk: 2,
        async failpoint(stage, index) {
          if (stage === "after_chunk_publish" && index === 0) throw new Error("simulated materialization interruption");
        },
      }),
      /simulated materialization interruption/,
    );
    const firstChunkNames = exportSetChunkBasenames(0);
    const interruptedArtifact = await readFile(join(value.output, firstChunkNames.bundle));
    const resumed = await materializeLocalExportSet({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      secret: SECRET,
      maximumRecordsPerChunk: 2,
    });
    assert.equal(resumed.manifest.chunks.length, 3);
    assert.deepEqual(await readFile(join(value.output, firstChunkNames.bundle)), interruptedArtifact);
    await loadCompressedChunk(value.output, resumed.manifest.chunks[0], firstChunkNames);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("materializer refuses crash adoption when a gzip artifact digest changed", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      materializeLocalExportSet({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
        secret: SECRET,
        maximumRecordsPerChunk: 2,
        async failpoint(stage, index) {
          if (stage === "after_chunk_publish" && index === 0) throw new Error("interrupt before adoption");
        },
      }),
      /interrupt before adoption/,
    );
    const names = exportSetChunkBasenames(0);
    const artifactFile = join(value.output, names.bundle);
    const corrupted = await readFile(artifactFile);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0x01;
    await writeFile(artifactFile, corrupted);
    await assert.rejects(
      materializeLocalExportSet({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
        secret: SECRET,
        maximumRecordsPerChunk: 2,
      }),
      (error) => error instanceof ExportSetError && error.code === "export_set_chunk_conflict",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("fresh same-runtime materializations produce identical gzip artifacts", async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const firstResult = await materializeLocalExportSet({
      workspaceDirectory: first.workspace,
      outputDirectory: first.output,
      secret: SECRET,
      maximumRecordsPerChunk: 2,
    });
    const secondResult = await materializeLocalExportSet({
      workspaceDirectory: second.workspace,
      outputDirectory: second.output,
      secret: SECRET,
      maximumRecordsPerChunk: 2,
    });
    assert.deepEqual(secondResult.manifest, firstResult.manifest);
    for (const chunk of firstResult.manifest.chunks) {
      const names = exportSetChunkBasenames(chunk.index);
      assert.deepEqual(
        await readFile(join(second.output, names.bundle)),
        await readFile(join(first.output, names.bundle)),
      );
    }
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

test("materializer resumes safely from every exported set-level failpoint", async () => {
  for (const failureStage of ["after_chunk_plan", "after_chunk_verify", "after_manifest_publish"]) {
    const value = await fixture();
    try {
      let failed = false;
      await assert.rejects(
        materializeLocalExportSet({
          workspaceDirectory: value.workspace,
          outputDirectory: value.output,
          secret: SECRET,
          maximumRecordsPerChunk: 2,
          async failpoint(stage, index) {
            if (!failed && stage === failureStage && (index === 0 || index === null)) {
              failed = true;
              throw new Error("simulated set-level interruption");
            }
          },
        }),
        /simulated set-level interruption/,
      );
      const resumed = await materializeLocalExportSet({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
        secret: SECRET,
        maximumRecordsPerChunk: 2,
      });
      assert.equal(resumed.manifest.completionStatus, "complete");
      assert.equal((await verifyLocalExportSet({ directory: value.output })).verdict, "passed");
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("logical records and source-plan digest are invariant to deterministic chunk size", async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const one = await materializeLocalExportSet({
      workspaceDirectory: first.workspace,
      outputDirectory: first.output,
      secret: SECRET,
      maximumRecordsPerChunk: 1,
    });
    const three = await materializeLocalExportSet({
      workspaceDirectory: second.workspace,
      outputDirectory: second.output,
      secret: SECRET,
      maximumRecordsPerChunk: 3,
    });
    assert.equal(one.manifest.totals.logicalRecordsSha256, three.manifest.totals.logicalRecordsSha256);
    assert.equal(one.manifest.sourcePlan.sha256, three.manifest.sourcePlan.sha256);
    assert.deepEqual(one.manifest.totals.recordCounts, three.manifest.totals.recordCounts);
    assert.notEqual(one.manifest.exportSetId, three.manifest.exportSetId);
    assert.notEqual(one.manifest.chunks.length, three.manifest.chunks.length);
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

test("combined source-plan commitment frames both digests and totals", () => {
  const codexDigest = "a".repeat(64);
  const supplementalDigest = "b".repeat(64);
  const commitment = combinedSourcePlanCommitment({
    sourcePlan: {
      sourcePlanSha256: codexDigest,
      sourceFiles: 3,
      sourceBytes: 1_024,
    },
    supplementalSourcePlan: {
      supplementalSourcePlanSha256: supplementalDigest,
      sourceFiles: 5,
      sourceBytes: 2_048,
    },
  });
  assert.deepEqual(commitment, {
    sha256: "5534f26efdb1f4ae693ed569e8c24f16a791953dfde475534fe6fb2bf820451d",
    sourceFiles: 8,
    sourceBytes: 3_072,
  });
  assert.notEqual(commitment.sha256, combinedSourcePlanCommitment({
    sourcePlan: {
      sourcePlanSha256: codexDigest,
      sourceFiles: 3,
      sourceBytes: 1_024,
    },
    supplementalSourcePlan: {
      supplementalSourcePlanSha256: "c".repeat(64),
      sourceFiles: 5,
      sourceBytes: 2_048,
    },
  }).sha256);
});

test("materializer binds supplemental source commitments into set and bundle identities", async () => {
  const first = await fixture({ collectorContents: "" });
  const second = await fixture({ collectorContents: "", codexHome: first.home });
  try {
    const firstResult = await materializeLocalExportSet({
      workspaceDirectory: first.workspace,
      outputDirectory: first.output,
      secret: SECRET,
      maximumRecordsPerChunk: 2,
    });
    const secondResult = await materializeLocalExportSet({
      workspaceDirectory: second.workspace,
      outputDirectory: second.output,
      secret: SECRET,
      maximumRecordsPerChunk: 2,
    });
    assert.equal(firstResult.manifest.totals.logicalRecordsSha256, secondResult.manifest.totals.logicalRecordsSha256);
    const firstWorkspace = await openExportWorkspace({ directory: first.workspace });
    const secondWorkspace = await openExportWorkspace({ directory: second.workspace });
    let firstDescriptor;
    let secondDescriptor;
    try {
      firstDescriptor = firstWorkspace.getDescriptor();
      secondDescriptor = secondWorkspace.getDescriptor();
    } finally {
      firstWorkspace.close();
      secondWorkspace.close();
    }
    assert.equal(firstDescriptor.sourcePlan.sourcePlanSha256, secondDescriptor.sourcePlan.sourcePlanSha256);
    assert.notEqual(
      firstDescriptor.supplementalSourcePlan.supplementalSourcePlanSha256,
      secondDescriptor.supplementalSourcePlan.supplementalSourcePlanSha256,
    );
    assert.notEqual(firstResult.manifest.sourcePlan.sha256, secondResult.manifest.sourcePlan.sha256);
    assert.notEqual(firstResult.manifest.exportSetId, secondResult.manifest.exportSetId);
    assert.notEqual(firstResult.manifest.chunks[0].bundleId, secondResult.manifest.chunks[0].bundleId);
    for (const [result, descriptor] of [
      [firstResult, firstDescriptor],
      [secondResult, secondDescriptor],
    ]) {
      assert.deepEqual(result.manifest.sourcePlan, {
        sha256: combinedSourcePlanCommitment(descriptor).sha256,
        sourceFiles: descriptor.sourcePlan.sourceFiles + descriptor.supplementalSourcePlan.sourceFiles,
        sourceBytes: descriptor.sourcePlan.sourceBytes + descriptor.supplementalSourcePlan.sourceBytes,
      });
    }
    assert.equal((await verifyLocalExportSet({ directory: first.output })).verdict, "passed");
    assert.equal((await verifyLocalExportSet({ directory: second.output })).verdict, "passed");
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

test("materializer refuses an incomplete workspace", async () => {
  const value = await fixture({ completeWorkspace: false });
  try {
    await assert.rejects(
      materializeLocalExportSet({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
        secret: SECRET,
      }),
      (error) => error instanceof ExportSetError && error.code === "export_set_workspace_incomplete",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("materializer enforces the persisted workspace policy before publishing output", async () => {
  const value = await fixture({ resourceLimits: { maximumCanonicalBundleBytes: 1_024 } });
  try {
    await assert.rejects(
      materializeLocalExportSet({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
        secret: SECRET,
      }),
      /Materialization limits exceed the workspace resource policy/,
    );
    await assert.rejects(stat(value.output), (error) => error.code === "ENOENT");

    await assert.rejects(
      materializeLocalExportSet({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
        secret: Buffer.alloc(32, 62),
        maximumCanonicalBundleBytes: 1_024,
      }),
      (error) => error instanceof ExportSetError && error.code === "export_set_workspace_incomplete",
    );
    await assert.rejects(stat(value.output), (error) => error.code === "ENOENT");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("materializer enforces the encoded artifact cap before publishing", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      materializeLocalExportSet({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
        secret: SECRET,
        maximumEncodedArtifactBytes: 64,
      }),
      (error) => error instanceof ExportCompressionError
        && error.code === "export_compression_encoded_bytes",
    );
    await assert.rejects(stat(value.output), (error) => error.code === "ENOENT");
    const workspace = await openExportWorkspace({ directory: value.workspace });
    try {
      assert.deepEqual(workspace.chunks(), []);
    } finally {
      workspace.close();
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("materializer rejects a destination containing an opposite plain chunk representation", async () => {
  const value = await fixture();
  try {
    await mkdir(value.output, { mode: 0o700 });
    const opposite = join(value.output, "chunk-000000.bundle.json");
    await writeFile(opposite, "{}", { mode: 0o600 });
    await assert.rejects(
      materializeLocalExportSet({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
        secret: SECRET,
      }),
      (error) => error instanceof ExportSetError
        && error.code === "export_set_mixed_representation"
        && !error.message.includes(value.output),
    );
    assert.equal(await readFile(opposite, "utf8"), "{}");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("materializer bounds destination enumeration before scanning arbitrary entries", async () => {
  const value = await fixture({ resourceLimits: { maximumDirectoryEntries: 5 } });
  try {
    await mkdir(value.output, { mode: 0o700 });
    for (let index = 0; index < 6; index += 1) {
      await writeFile(join(value.output, `unrelated-${index}`), "x", { mode: 0o600 });
    }
    await assert.rejects(
      materializeLocalExportSet({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
        secret: SECRET,
      }),
      (error) => error.code === "export_resource_directory_entries"
        && !error.message.includes(value.output),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("empty-set materialization enforces its canonical ceiling before side effects", async () => {
  const value = await fixture({
    empty: true,
    resourceLimits: { maximumCanonicalBundleBytes: 1_024 },
  });
  try {
    await assert.rejects(
      materializeLocalExportSet({
        workspaceDirectory: value.workspace,
        outputDirectory: value.output,
        secret: SECRET,
        maximumCanonicalBundleBytes: 1_024,
      }),
      (error) => error.code === "export_resource_canonical_bundle_bytes",
    );
    await assert.rejects(stat(value.output), (error) => error.code === "ENOENT");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
