import { createHash, timingSafeEqual } from "node:crypto";

import { createAccountlessChildChannel } from "../../src/platform/index.js";

const SCHEMA = "windows-accountless-qualification-smoke-v1";
const PHASES = new Set(["create-v1", "verify-delete-v1"]);
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isStartMessage(message) {
  try {
    return message !== null
      && typeof message === "object"
      && !Array.isArray(message)
      && Object.keys(message).sort().join(",") === "kind,phase,runId,schemaVersion"
      && message.schemaVersion === SCHEMA
      && message.kind === "start-v1"
      && PHASES.has(message.phase)
      && typeof message.runId === "string"
      && RUN_ID.test(message.runId);
  } catch {
    return false;
  }
}

function syntheticSecret(runId) {
  return createHash("sha256")
    .update(`tibotattle-windows-accountless-fd3-smoke-v1:${runId.toLowerCase()}`)
    .digest();
}

function sameSecret(left, right) {
  try {
    return Buffer.isBuffer(left)
      && Buffer.isBuffer(right)
      && left.byteLength === 32
      && right.byteLength === 32
      && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

async function readExact(backend, expected) {
  let observed = null;
  try {
    observed = await backend.read();
    return sameSecret(observed, expected);
  } finally {
    observed?.fill?.(0);
  }
}

async function runPhase({ phase, runId }) {
  const bridge = createAccountlessChildChannel({
    channel: process,
    timeoutMilliseconds: 5_000,
  });
  const expected = syntheticSecret(runId);
  try {
    if (phase === "create-v1") {
      let existing = null;
      try {
        existing = await bridge.backend.read();
        if (existing !== null) throw new Error("existing synthetic credential");
      } finally {
        existing?.fill?.(0);
      }
      if (await bridge.backend.createIfMissing(null, expected) !== "created") {
        throw new Error("synthetic credential was not created");
      }
      if (!(await readExact(bridge.backend, expected))) {
        throw new Error("synthetic credential readback mismatch");
      }
      return;
    }
    if (!(await readExact(bridge.backend, expected))) {
      throw new Error("synthetic credential restart read mismatch");
    }
    if (await bridge.backend.deleteExact(null, expected) !== "deleted") {
      throw new Error("synthetic credential was not deleted");
    }
    let remaining = null;
    try {
      remaining = await bridge.backend.read();
      if (remaining !== null) throw new Error("synthetic credential remains after delete");
    } finally {
      remaining?.fill?.(0);
    }
  } finally {
    expected.fill(0);
    bridge.dispose();
  }
}

let started = false;
let finished = false;

function finish(status) {
  if (finished) return;
  finished = true;
  process.off("message", onMessage);
  const result = Object.freeze({
    schemaVersion: SCHEMA,
    kind: "result-v1",
    status,
  });
  const disconnect = () => {
    try {
      process.disconnect?.();
    } catch {
      // The owned parent may already have closed the inherited pipe.
    }
  };
  try {
    if (typeof process.send !== "function") throw new Error("missing parent IPC");
    process.send(result, disconnect);
  } catch {
    process.exitCode = 1;
    disconnect();
  }
}

function onMessage(message) {
  if (started || !isStartMessage(message)) return;
  started = true;
  void runPhase({ phase: message.phase, runId: message.runId })
    .then(() => finish("passed-v1"), () => finish("failed-v1"));
}

process.on("message", onMessage);
try {
  if (typeof process.send !== "function") throw new Error("missing parent IPC");
  process.send(Object.freeze({ schemaVersion: SCHEMA, kind: "ready-v1" }));
} catch {
  process.exitCode = 1;
}
