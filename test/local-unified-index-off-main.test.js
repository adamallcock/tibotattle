import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  ingestLocalUnifiedIndexOffMain,
  runLocalUnifiedIndexOffMainWorker,
  shouldRunLocalUnifiedIndexOffMain,
} from "../src/local-unified-index-off-main.js";
import {
  localUnifiedIndexStageFile,
} from "../src/local-unified-index-build.js";
import {
  removeAbandonedLocalUnifiedIndexStages,
} from "../src/local-unified-index.js";

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

test("off-main worker transfers a bounded plural Codex root list", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-off-main-roots-"));
  const codexHomes = [
    { path: join(root, "primary"), id: "primary-owner" },
    { path: join(root, "history"), rootId: "history-owner" },
  ];
  let capturedWorkerData = null;

  class CompletedWorker extends EventEmitter {
    constructor(_url, { workerData }) {
      super();
      capturedWorkerData = workerData;
      setImmediate(() => {
        this.emit("message", { type: "result", result: { status: "ingested" } });
        this.emit("exit", 0);
      });
    }

    postMessage() {}

    terminate() {
      return Promise.resolve(0);
    }
  }

  try {
    const result = await runLocalUnifiedIndexOffMainWorker(
      {
        codexHomes,
        indexFile: join(root, "index.sqlite"),
        contractVersion: CONTRACT,
      },
      { WorkerClass: CompletedWorker },
    );
    assert.deepEqual(result, { status: "ingested" });
    assert.deepEqual(capturedWorkerData.options.codexHomes, [
      { path: codexHomes[0].path, id: "primary-owner" },
      { path: codexHomes[1].path, id: "history-owner" },
    ]);
    assert.notEqual(capturedWorkerData.options.codexHomes, codexHomes);
    assert.equal("codexHome" in capturedWorkerData.options, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("off-main stage names are token-exact and direct callers retain timestamps", () => {
  const indexFile = "/tmp/tibotattle-unified/index.sqlite";
  const token = "a".repeat(32);
  assert.equal(
    localUnifiedIndexStageFile(indexFile, "incremental", token),
    `${indexFile}.incremental-${process.pid}-${token}`,
  );
  assert.equal(
    localUnifiedIndexStageFile(indexFile, "building", token),
    `${indexFile}.building-${process.pid}-${token}`,
  );
  assert.match(
    localUnifiedIndexStageFile(indexFile, "building"),
    /\.building-[1-9][0-9]*-[0-9a-z]+$/u,
  );
  assert.throws(
    () => localUnifiedIndexStageFile(indexFile, "building", "not-a-token"),
    (error) => error?.code === "local_unified_index_attempt_token_invalid",
  );
});

test("same-PID token cleanup preserves the active and legacy stages", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-off-main-orphan-"));
  const activeToken = "c".repeat(32);
  const oldToken = "d".repeat(32);
  const indexFile = join(root, "index.sqlite");
  const activeStage = localUnifiedIndexStageFile(
    indexFile,
    "building",
    activeToken,
  );
  const oldStage = localUnifiedIndexStageFile(
    indexFile,
    "incremental",
    oldToken,
  );
  const legacyStage = `${indexFile}.building-${process.pid}-legacy`;
  const nowMs = Date.now();
  try {
    await Promise.all([
      writeFile(activeStage, "active"),
      writeFile(oldStage, "old"),
      writeFile(legacyStage, "legacy"),
    ]);
    const fresh = await removeAbandonedLocalUnifiedIndexStages(indexFile, {
      nowMs,
      minimumAgeMs: 60_000,
      platform: "darwin",
      activeAttemptToken: activeToken,
      // The old token must be classified as terminated by token identity,
      // rather than by this callback, while the active and legacy names use
      // the callback's live-PID result.
      isProcessAlive: () => true,
    });
    assert.deepEqual(fresh, { inspected: 3, removed: 0, skipped: 3 });
    await Promise.all([
      assert.doesNotReject(() => access(activeStage)),
      assert.doesNotReject(() => access(oldStage)),
      assert.doesNotReject(() => access(legacyStage)),
    ]);

    const old = new Date(nowMs - 60_001);
    await utimes(oldStage, old, old);
    const reclaimed = await removeAbandonedLocalUnifiedIndexStages(indexFile, {
      nowMs,
      minimumAgeMs: 60_000,
      platform: "darwin",
      activeAttemptToken: activeToken,
      isProcessAlive: () => true,
    });
    assert.equal(reclaimed.removed, 1);
    assert.equal(reclaimed.skipped, 2);
    await assert.rejects(() => access(oldStage));
    await Promise.all([
      assert.doesNotReject(() => access(activeStage)),
      assert.doesNotReject(() => access(legacyStage)),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hard cancellation waits for termination and leaves a bounded orphan, ignoring late results", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-off-main-hard-abort-"));
  const controller = new AbortController();
  const token = "c".repeat(32);
  const indexFile = join(root, "index.sqlite");
  const incremental = localUnifiedIndexStageFile(indexFile, "incremental", token);
  const building = localUnifiedIndexStageFile(indexFile, "building", token);
  const unrelated = join(root, "index.sqlite.building-other");
  const timers = [];
  let workerInstance = null;
  let terminateCalled = false;
  let releaseTermination = null;
  let timerWasUnrefed = false;

  class HangingWorker extends EventEmitter {
    constructor(_url, { workerData }) {
      super();
      this.workerData = workerData;
      workerInstance = this;
    }

    postMessage(message) {
      this.lastMessage = message;
    }

    terminate() {
      terminateCalled = true;
      return new Promise((resolve) => {
        releaseTermination = () => {
          // Node can emit `exit` before the terminate promise resolves; the
          // parent must wait for both before touching stage candidates.
          this.emit("exit", 1);
          resolve(1);
        };
      });
    }
  }

  try {
    await writeFile(incremental, "incremental");
    await writeFile(building, "building");
    await writeFile(unrelated, "unrelated");
    const pending = runLocalUnifiedIndexOffMainWorker(
      {
        codexHome: root,
        indexFile,
        contractVersion: CONTRACT,
      },
      {
        signal: controller.signal,
        attemptToken: token,
        WorkerClass: HangingWorker,
        abortGraceMs: 30,
        setTimeoutImpl(callback, delay) {
          const timer = {
            callback,
            delay,
            unref() {
              timerWasUnrefed = true;
            },
          };
          timers.push(timer);
          return timer;
        },
        clearTimeoutImpl(timer) {
          timer.cleared = true;
        },
      },
    );
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workerInstance.lastMessage.type, "abort");
    assert.equal(workerInstance.workerData.options.attemptToken, token);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 30);
    assert.equal(timerWasUnrefed, true);

    // A result from the aborted worker is late and must not resolve the pass.
    workerInstance.emit("message", { type: "result", result: { status: "built" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(terminateCalled, false);
    await assert.doesNotReject(() => access(incremental));
    assert.equal(releaseTermination, null);

    timers[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(terminateCalled, true);
    assert.equal(releaseTermination !== null, true);
    await assert.doesNotReject(() => access(incremental));
    await assert.doesNotReject(() => access(building));

    releaseTermination();
    await assert.rejects(
      pending,
      (error) => error?.code === "local_unified_index_aborted",
    );
    // Parent-side pathname cleanup is intentionally absent after hard
    // termination. The PID/token names are reclaimed by the bounded startup
    // abandoned-stage scanner once this owner is dead and the age threshold
    // has elapsed.
    await assert.doesNotReject(() => access(incremental));
    await assert.doesNotReject(() => access(building));
    await assert.doesNotReject(() => access(unrelated));
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("parent hard termination does not traverse a missing or replaced stage root", async () => {
  for (const mode of ["missing", "replaced"]) {
    const root = await mkdtemp(join(tmpdir(), `unified-index-off-main-${mode}-root-`));
    const originalRoot = `${root}.original`;
    const outsideRoot = await mkdtemp(join(tmpdir(), `unified-index-off-main-${mode}-outside-`));
    const controller = new AbortController();
    const token = "d".repeat(32);
    const indexFile = join(root, "index.sqlite");
    const stage = localUnifiedIndexStageFile(indexFile, "incremental", token);
    const outsideStage = join(outsideRoot, basename(stage));
    let workerInstance = null;
    let timerCallback = null;
    let releaseTermination = null;

    class HangingWorker extends EventEmitter {
      constructor() {
        super();
        workerInstance = this;
      }

      postMessage() {}

      terminate() {
        return new Promise((resolve) => {
          releaseTermination = () => {
            this.emit("exit", 1);
            resolve(1);
          };
        });
      }
    }

    try {
      await writeFile(stage, "owned stage");
      if (mode === "replaced") await writeFile(outsideStage, "must remain");
      const pending = runLocalUnifiedIndexOffMainWorker(
        {
          codexHome: root,
          indexFile,
          contractVersion: CONTRACT,
        },
        {
          signal: controller.signal,
          attemptToken: token,
          WorkerClass: HangingWorker,
          abortGraceMs: 0,
          setTimeoutImpl(callback) {
            timerCallback = callback;
            return { unref() {} };
          },
          clearTimeoutImpl() {},
        },
      );
      controller.abort();
      timerCallback();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(workerInstance !== null, true);
      assert.equal(typeof releaseTermination, "function");

      if (mode === "missing") {
        await rm(root, { recursive: true, force: true });
      } else {
        await rename(root, originalRoot);
        await symlink(outsideRoot, root);
      }

      releaseTermination();
      await assert.rejects(
        pending,
        (error) => error?.code === "local_unified_index_aborted",
      );
      if (mode === "replaced") {
        await assert.doesNotReject(() => access(outsideStage));
      }
    } finally {
      controller.abort();
      await rm(root, { recursive: true, force: true });
      await rm(originalRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  }
});

test("queued progress after abort is acknowledged without reanimating the callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-off-main-progress-order-"));
  const controller = new AbortController();
  const messages = [];
  const progress = [];
  let workerInstance = null;

  class QueuedProgressWorker extends EventEmitter {
    constructor() {
      super();
      workerInstance = this;
    }

    postMessage(message) {
      messages.push(message);
    }

    terminate() {
      return Promise.resolve(0);
    }
  }

  try {
    const pending = runLocalUnifiedIndexOffMainWorker(
      {
        codexHome: root,
        indexFile: join(root, "index.sqlite"),
        contractVersion: CONTRACT,
      },
      {
        signal: controller.signal,
        WorkerClass: QueuedProgressWorker,
        onProgress: (value) => progress.push(value),
      },
    );

    workerInstance.emit("message", {
      type: "progress",
      id: 17,
      value: { phase: "queued-before-abort" },
    });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(progress, []);
    assert.deepEqual(messages, [
      { type: "abort" },
      { type: "progress_ack", id: 17 },
    ]);

    workerInstance.emit("exit", 0);
    await assert.rejects(
      pending,
      (error) => error?.code === "local_unified_index_aborted",
    );
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("off-main admission rejects a concurrent token for the same index", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-off-main-concurrency-"));
  const firstController = new AbortController();
  const firstToken = "e".repeat(32);
  const secondToken = "f".repeat(32);
  const indexFile = join(root, "index.sqlite");
  let firstWorker = null;
  let firstTimer = null;
  let releaseTermination = null;
  let secondWorkerConstructed = false;

  class HangingWorker extends EventEmitter {
    constructor() {
      super();
      firstWorker = this;
    }

    postMessage() {}

    terminate() {
      return new Promise((resolve) => {
        releaseTermination = () => {
          this.emit("exit", 1);
          resolve(1);
        };
      });
    }
  }

  class UnexpectedSecondWorker extends EventEmitter {
    constructor() {
      super();
      secondWorkerConstructed = true;
    }
  }

  class CompletingWorker extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => {
        this.emit("message", { type: "result", result: { status: "built" } });
        this.emit("exit", 0);
      });
    }

    postMessage() {}
  }

  try {
    const first = runLocalUnifiedIndexOffMainWorker(
      {
        codexHome: root,
        indexFile,
        contractVersion: CONTRACT,
      },
      {
        signal: firstController.signal,
        attemptToken: firstToken,
        WorkerClass: HangingWorker,
        abortGraceMs: 0,
        setTimeoutImpl(callback) {
          firstTimer = callback;
          return { unref() {} };
        },
        clearTimeoutImpl() {},
      },
    );

    const second = runLocalUnifiedIndexOffMainWorker(
      {
        codexHome: root,
        indexFile,
        contractVersion: CONTRACT,
      },
      {
        attemptToken: secondToken,
        WorkerClass: UnexpectedSecondWorker,
      },
    );
    await assert.rejects(
      second,
      (error) => error?.code === "local_unified_index_worker_busy",
    );
    assert.equal(secondWorkerConstructed, false);

    firstController.abort();
    assert.equal(typeof firstTimer, "function");
    firstTimer();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(firstWorker !== null, true);
    assert.equal(typeof releaseTermination, "function");
    releaseTermination();
    await assert.rejects(
      first,
      (error) => error?.code === "local_unified_index_aborted",
    );

    // The guard is released only after shutdown, allowing the next retry to
    // claim the same index with a new token.
    const retry = await runLocalUnifiedIndexOffMainWorker(
      {
        codexHome: root,
        indexFile,
        contractVersion: CONTRACT,
      },
      {
        attemptToken: secondToken,
        WorkerClass: CompletingWorker,
      },
    );
    assert.deepEqual(retry, { status: "built" });
  } finally {
    firstController.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("termination failure stays pending without parent cleanup until worker exit is confirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-off-main-termination-failure-"));
  const controller = new AbortController();
  const token = "e".repeat(32);
  const indexFile = join(root, "index.sqlite");
  const incremental = localUnifiedIndexStageFile(indexFile, "incremental", token);
  let workerInstance = null;
  let timerCallback = null;

  class RejectingWorker extends EventEmitter {
    constructor() {
      super();
      workerInstance = this;
    }

    postMessage(message) {
      this.lastMessage = message;
    }

    terminate() {
      return Promise.reject(new Error("termination failed"));
    }
  }

  try {
    await writeFile(incremental, "incremental");
    const pending = runLocalUnifiedIndexOffMainWorker(
      { codexHome: root, indexFile, contractVersion: CONTRACT },
      {
        signal: controller.signal,
        attemptToken: token,
        WorkerClass: RejectingWorker,
        setTimeoutImpl(callback) {
          timerCallback = callback;
          return { unref() {} };
        },
        clearTimeoutImpl() {},
      },
    );
    controller.abort();
    assert.equal(typeof timerCallback, "function");
    timerCallback();
    await new Promise((resolve) => setImmediate(resolve));

    // terminate() rejected, so the worker is not yet gone and the orphan
    // remains untouched.
    await assert.doesNotReject(() => access(incremental));

    workerInstance.emit("exit", 1);
    await assert.rejects(
      pending,
      (error) => error?.code === "local_unified_index_worker_termination_failed",
    );
    await assert.doesNotReject(() => access(incremental));
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("termination waits for a pending rejection when exit arrives first", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-off-main-exit-first-"));
  const controller = new AbortController();
  const token = "f".repeat(32);
  const indexFile = join(root, "index.sqlite");
  const incremental = localUnifiedIndexStageFile(indexFile, "incremental", token);
  let workerInstance = null;
  let timerCallback = null;
  let rejectTermination = null;

  class ExitFirstWorker extends EventEmitter {
    constructor() {
      super();
      workerInstance = this;
    }

    postMessage(message) {
      this.lastMessage = message;
    }

    terminate() {
      return new Promise((_resolve, reject) => {
        rejectTermination = () => reject(new Error("termination failed"));
      });
    }
  }

  try {
    await writeFile(incremental, "incremental");
    const pending = runLocalUnifiedIndexOffMainWorker(
      { codexHome: root, indexFile, contractVersion: CONTRACT },
      {
        signal: controller.signal,
        attemptToken: token,
        WorkerClass: ExitFirstWorker,
        setTimeoutImpl(callback) {
          timerCallback = callback;
          return { unref() {} };
        },
        clearTimeoutImpl() {},
      },
    );
    controller.abort();
    timerCallback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof rejectTermination, "function");

    // Exit alone is not enough while terminate() is still unresolved.
    workerInstance.emit("exit", 1);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.doesNotReject(() => access(incremental));

    rejectTermination();
    await assert.rejects(
      pending,
      (error) => error?.code === "local_unified_index_worker_termination_failed",
    );
    await assert.doesNotReject(() => access(incremental));
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("cooperative cancellation does not need parent pathname cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-off-main-soft-abort-"));
  const controller = new AbortController();
  const token = "d".repeat(32);
  const indexFile = join(root, "index.sqlite");
  const incremental = localUnifiedIndexStageFile(indexFile, "incremental", token);
  let workerInstance = null;
  let terminateCalled = false;
  let graceCallback = null;

  class CooperativeWorker extends EventEmitter {
    constructor() {
      super();
      workerInstance = this;
    }

    postMessage(message) {
      if (message?.type === "abort") queueMicrotask(() => this.emit("exit", 0));
    }

    terminate() {
      terminateCalled = true;
      return Promise.resolve(0);
    }
  }

  try {
    await writeFile(incremental, "incremental");
    const pending = runLocalUnifiedIndexOffMainWorker(
      { codexHome: root, indexFile, contractVersion: CONTRACT },
      {
        signal: controller.signal,
        attemptToken: token,
        WorkerClass: CooperativeWorker,
        abortGraceMs: 30,
        setTimeoutImpl(callback) {
          graceCallback = callback;
          return { unref() {} };
        },
        clearTimeoutImpl() {},
      },
    );
    controller.abort();
    await assert.rejects(
      pending,
      (error) => error?.code === "local_unified_index_aborted",
    );
    assert.equal(workerInstance !== null, true);
    assert.equal(terminateCalled, false);
    assert.equal(typeof graceCallback, "function");
    await assert.doesNotReject(() => access(incremental));
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
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
