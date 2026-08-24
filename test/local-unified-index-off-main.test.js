import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ingestLocalUnifiedIndexOffMain,
  shouldRunLocalUnifiedIndexOffMain,
} from "../src/local-unified-index-off-main.js";

const CONTRACT = "usage-event-v0.2";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";

function sessionMeta() {
  return JSON.stringify({
    timestamp: "2026-08-24T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: THREAD_ID,
      session_id: THREAD_ID,
      thread_source: "user",
      originator: "codex_cli_rs",
    },
  });
}

function rolloutFixture() {
  return [
    sessionMeta(),
    JSON.stringify({
      timestamp: "2026-08-24T00:00:01.000Z",
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    }),
    JSON.stringify({
      timestamp: "2026-08-24T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
          },
          last_token_usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
          },
        },
      },
    }),
  ].join("\n") + "\n";
}

async function withElectronCompanionEnvironment(callback) {
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previous;
  }
}

test("Electron companions select the off-main unified-index boundary only off Windows", () => {
  assert.equal(
    shouldRunLocalUnifiedIndexOffMain({
      platform: "darwin",
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    }),
    true,
  );
  assert.equal(
    shouldRunLocalUnifiedIndexOffMain({
      platform: "linux",
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    }),
    true,
  );
  assert.equal(
    shouldRunLocalUnifiedIndexOffMain({
      platform: "win32",
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    }),
    false,
  );
  assert.equal(
    shouldRunLocalUnifiedIndexOffMain({
      platform: "darwin",
      environment: {},
    }),
    false,
  );
});

test("Electron unified-index ingestion completes through the worker boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-off-main-"));
  try {
    const sessions = join(root, "sessions", "2026", "08", "24");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, `rollout-2026-08-24T00-00-00-${THREAD_ID}.jsonl`),
      rolloutFixture(),
    );
    const progress = [];
    const result = await withElectronCompanionEnvironment(() => (
      ingestLocalUnifiedIndexOffMain({
        codexHome: root,
        indexFile: join(root, "index.sqlite"),
        secretFile: join(root, "salt"),
        contractVersion: CONTRACT,
        windowsFilesystemAdapter: null,
        windowsProtectedStateStore: null,
        windowsQualificationModeContext: null,
        windowsSqliteStateStaging: null,
        stateRoot: join(root, "state"),
        resourceRoot: join(root, "resource"),
        onProgress: (value) => progress.push(value),
      })
    ));
    assert.equal(result.status, "ingested");
    assert.equal(result.generation.status, "complete");
    assert.equal(result.sourcesScanned, 1);
    assert.equal(progress.length > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker progress errors retain their fixed error code", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-off-main-progress-"));
  try {
    const sessions = join(root, "sessions", "2026", "08", "24");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, `rollout-2026-08-24T00-00-00-${THREAD_ID}.jsonl`),
      rolloutFixture(),
    );
    await withElectronCompanionEnvironment(() => assert.rejects(
      ingestLocalUnifiedIndexOffMain({
        codexHome: root,
        indexFile: join(root, "index.sqlite"),
        secretFile: join(root, "salt"),
        contractVersion: CONTRACT,
        onProgress: () => {
          const error = new Error("progress callback failed");
          error.code = "local_unified_index_progress_failed";
          throw error;
        },
      }),
      (error) => error?.code === "local_unified_index_progress_failed",
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker cancellation settles a progress acknowledgement that never returns", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-off-main-progress-abort-"));
  const controller = new AbortController();
  try {
    const sessions = join(root, "sessions", "2026", "08", "24");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, `rollout-2026-08-24T00-00-00-${THREAD_ID}.jsonl`),
      rolloutFixture(),
    );
    await withElectronCompanionEnvironment(() => assert.rejects(
      ingestLocalUnifiedIndexOffMain({
        codexHome: root,
        indexFile: join(root, "index.sqlite"),
        secretFile: join(root, "salt"),
        contractVersion: CONTRACT,
        signal: controller.signal,
        onProgress: () => {
          controller.abort();
          return new Promise(() => {});
        },
      }),
      (error) => error?.code === "local_unified_index_aborted",
    ));
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker-bound unified-index ingestion observes cancellation and cleans up", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-off-main-cancel-"));
  const controller = new AbortController();
  try {
    const sessions = join(root, "sessions", "2026", "08", "24");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, `rollout-2026-08-24T00-00-00-${THREAD_ID}.jsonl`),
      rolloutFixture(),
    );
    await withElectronCompanionEnvironment(() => assert.rejects(
      ingestLocalUnifiedIndexOffMain({
        codexHome: root,
        indexFile: join(root, "index.sqlite"),
        secretFile: join(root, "salt"),
        contractVersion: CONTRACT,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
      (error) => error?.code === "local_unified_index_aborted",
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
