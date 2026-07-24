import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVerifiedLocalMetadataBundleFiles } from "../src/bundle-verifier.js";
import { createLocalExportWorkspace } from "../src/export-set-controller.js";
import {
  EXPORT_SET_MANIFEST_BASENAME,
  ExportSetError,
  materializeLocalExportSet,
} from "../src/export-set-materializer.js";
import { exportSetChunkBasenames, validateExportSetManifest } from "../src/export-set-schema.js";
import { verifyLocalExportSet } from "../src/export-set-verifier.js";

const SECRET = Buffer.alloc(32, 61);

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

async function fixture({ completeWorkspace = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-materializer-"));
  const home = join(root, "codex-home");
  const workspace = join(root, "workspace");
  const output = join(root, "output");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const first = usage(100, 20, 40, 8);
  const second = usage(150, 30, 60, 11);
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_SESSION" } }),
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
  ];
  await writeFile(join(home, "sessions", "rollout-2026-07-24T12-00-00-materializer.jsonl"), `${lines.join("\n")}\n`);
  if (completeWorkspace) {
    await createLocalExportWorkspace({
      directory: workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: home,
      secret: SECRET,
    });
  } else {
    await assert.rejects(createLocalExportWorkspace({
      directory: workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: home,
      secret: SECRET,
      async failpoint(stage) {
        if (stage === "after_record_batch") throw new Error("leave workspace incomplete");
      },
    }), /leave workspace incomplete/);
  }
  return { root, home, workspace, output };
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
    assert.equal(first.manifest.chunks.length, 3);
    assert.deepEqual(first.manifest.totals.recordCounts, {
      usageEvents: 2,
      quotaSnapshots: 4,
      activityMarkers: 0,
    });
    for (const chunk of first.manifest.chunks) {
      const names = exportSetChunkBasenames(chunk.index);
      const verified = await loadVerifiedLocalMetadataBundleFiles({
        bundleFile: join(value.output, names.bundle),
        receiptFile: join(value.output, names.receipt),
      });
      assert.equal(verified.bundle.bundleId, chunk.bundleId);
      assert.equal(verified.bundleSha256, chunk.bundleSha256);
    }
    assert.equal((await stat(join(value.output, EXPORT_SET_MANIFEST_BASENAME))).mode & 0o777, 0o600);

    const repeated = await materializeLocalExportSet({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      secret: SECRET,
      maximumRecordsPerChunk: 2,
    });
    assert.deepEqual(repeated.manifest, first.manifest);
    assert.deepEqual(repeated.manifestReceipt, first.manifestReceipt);
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
    const resumed = await materializeLocalExportSet({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      secret: SECRET,
      maximumRecordsPerChunk: 2,
    });
    assert.equal(resumed.manifest.chunks.length, 3);
  } finally {
    await rm(value.root, { recursive: true, force: true });
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
