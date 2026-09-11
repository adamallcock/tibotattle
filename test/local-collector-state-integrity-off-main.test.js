import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  commitLocalCollectorState,
  defaultLocalCollectorStatePath,
} from "../src/local-collector-state.js";
import {
  verifyLocalCollectorStateIntegrityOffMain,
} from "../src/local-collector-state-integrity-off-main.js";

const CLOCK = () => Date.parse("2026-09-08T00:00:00.000Z");

function checkpoint() {
  return {
    schemaVersion: "0.3",
    collectionStartedAt: "2026-09-01T00:00:00.000Z",
    recentEventKeys: [],
    diagnostics: {},
  };
}

function record() {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    eventKey: "integrity-worker-record",
    observedAt: "2026-09-08T00:00:00.000Z",
    accountScope: { status: "unavailable" },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "collector-state-integrity-worker-"));
  const stateFile = defaultLocalCollectorStatePath(root);
  await commitLocalCollectorState({
    stateFile,
    checkpoint: checkpoint(),
    records: [record()],
    clock: CLOCK,
  });
  return { root, stateFile };
}

async function stateIdentity(stateFile) {
  const metadata = await lstat(stateFile);
  return { dev: metadata.dev, ino: metadata.ino };
}

test("integrity worker verifies an exact owner state without returning metadata", async () => {
  const value = await fixture();
  try {
    const result = await verifyLocalCollectorStateIntegrityOffMain({
      stateFile: value.stateFile,
      expectedIdentity: await stateIdentity(value.stateFile),
    });
    assert.equal(result, undefined);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("integrity worker refuses a same-path identity mismatch with a fixed error", async () => {
  const value = await fixture();
  try {
    const identity = await stateIdentity(value.stateFile);
    const differentIdentity = {
      dev: identity.dev,
      ino: identity.ino === Number.MAX_SAFE_INTEGER ? identity.ino - 1 : identity.ino + 1,
    };
    await assert.rejects(
      verifyLocalCollectorStateIntegrityOffMain({
        stateFile: value.stateFile,
        expectedIdentity: differentIdentity,
      }),
      (error) => error?.code === "local_collector_state_unavailable"
        && error.message === "local_collector_state_unavailable"
        && !error.message.includes(value.root),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("integrity worker aborts a pending worker with a fixed terminal error", async () => {
  const controller = new AbortController();
  let instance = null;
  class HangingWorker extends EventEmitter {
    constructor() {
      super();
      instance = this;
    }

    terminate() {
      this.terminated = (this.terminated ?? 0) + 1;
      queueMicrotask(() => this.emit("exit", 1));
      return Promise.resolve(1);
    }
  }
  const pending = verifyLocalCollectorStateIntegrityOffMain({
    stateFile: "/private/collector-state.sqlite",
    expectedIdentity: { dev: 0, ino: 0 },
  }, {
    signal: controller.signal,
    WorkerClass: HangingWorker,
  });
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error?.code === "local_collector_state_integrity_aborted"
      && error.message === "local_collector_state_integrity_aborted",
  );
  assert.equal(instance?.terminated, 1);
});

test("integrity worker observes an abort raced with listener registration", async () => {
  const controller = new AbortController();
  let instance = null;
  class HangingWorker extends EventEmitter {
    constructor() {
      super();
      instance = this;
    }

    terminate() {
      this.terminated = (this.terminated ?? 0) + 1;
      queueMicrotask(() => this.emit("exit", 1));
      return Promise.resolve(1);
    }
  }
  const racedSignal = {
    get aborted() { return controller.signal.aborted; },
    addEventListener(...args) {
      controller.abort();
      return controller.signal.addEventListener(...args);
    },
    removeEventListener: (...args) => controller.signal.removeEventListener(...args),
  };
  await assert.rejects(
    verifyLocalCollectorStateIntegrityOffMain({
      stateFile: "/private/collector-state.sqlite",
      expectedIdentity: { dev: 0, ino: 0 },
    }, {
      signal: racedSignal,
      WorkerClass: HangingWorker,
    }),
    { code: "local_collector_state_integrity_aborted" },
  );
  assert.equal(instance?.terminated, 1);
});

test("a nominal worker result followed by a nonzero exit fails closed", async () => {
  class ResultThenFailingWorker extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => {
        this.emit("message", { type: "result" });
        queueMicrotask(() => this.emit("exit", 1));
      });
    }

    terminate() {
      return Promise.resolve(1);
    }
  }
  await assert.rejects(
    verifyLocalCollectorStateIntegrityOffMain({
      stateFile: "/private/collector-state.sqlite",
      expectedIdentity: { dev: 0, ino: 0 },
    }, { WorkerClass: ResultThenFailingWorker }),
    { code: "local_collector_state_integrity_worker_failed" },
  );
});

test("a nominal worker result without an exit is bounded and refused", async () => {
  let instance = null;
  class ResultWithoutExitWorker extends EventEmitter {
    constructor() {
      super();
      instance = this;
      queueMicrotask(() => this.emit("message", { type: "result" }));
    }

    terminate() {
      this.terminated = (this.terminated ?? 0) + 1;
      return Promise.resolve(1);
    }
  }
  const startedAt = performance.now();
  await assert.rejects(
    verifyLocalCollectorStateIntegrityOffMain({
      stateFile: "/private/collector-state.sqlite",
      expectedIdentity: { dev: 0, ino: 0 },
    }, { WorkerClass: ResultWithoutExitWorker }),
    { code: "local_collector_state_integrity_worker_failed" },
  );
  assert.equal(instance?.terminated, 1);
  assert.ok(
    performance.now() - startedAt < 1_000,
    "worker settlement did not remain within its fixed bound",
  );
});

test("malformed worker output is terminated and reduced to a fixed content-free error", async () => {
  let instance = null;
  class MalformedWorker extends EventEmitter {
    constructor() {
      super();
      instance = this;
      queueMicrotask(() => {
        this.emit("message", {
          type: "result",
          privatePath: "/Users/private/collector.sqlite",
          privateAddress: "private@example.test",
        });
      });
    }

    terminate() {
      this.terminated = (this.terminated ?? 0) + 1;
      queueMicrotask(() => this.emit("exit", 1));
      return Promise.resolve(1);
    }
  }
  await assert.rejects(
    verifyLocalCollectorStateIntegrityOffMain({
      stateFile: "/private/collector-state.sqlite",
      expectedIdentity: { dev: 0, ino: 0 },
    }, { WorkerClass: MalformedWorker }),
    (error) => error?.code === "local_collector_state_integrity_worker_failed"
      && error.message === "local_collector_state_integrity_worker_failed"
      && !error.message.includes("/Users/")
      && !error.message.includes("@"),
  );
  assert.equal(instance?.terminated, 1);
});
