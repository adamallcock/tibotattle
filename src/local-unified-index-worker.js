import { parentPort, workerData } from "node:worker_threads";

import { extractRolloutUsage } from "./local-unified-index-extract.js";

// One lane of a parallel rebuild.
//
// A lane is a whole lineage component: a fork and all of its ancestors and
// descendants are always scanned by the same worker, in parent-first order.
// That is what lets a forked child inherit the model its parent was last using
// — the fix for the measured `model: "unknown"` gap — without any cross-thread
// coordination.
//
// Only typed scalars cross the thread boundary. No line, no record and no
// buffer from a rollout file is ever posted; the batch below carries integers,
// a model identifier and a tier classification, nothing that can hold content.

const BATCH_EVENTS = 5_000;

function validSource(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.path === "string"
    && value.path.length > 0
    && Number.isSafeInteger(value.size)
    && value.size >= 0
    && typeof value.rolloutKey === "string";
}

async function run() {
  if (parentPort === null) throw new Error("unified index worker requires a parent port");
  const sources = workerData?.sources;
  if (!Array.isArray(sources) || !sources.every(validSource)) {
    throw new Error("unified index worker input is invalid");
  }
  const maximumLineBytes = workerData?.maximumLineBytes;
  const finalBySessionId = new Map();

  for (const source of sources) {
    const seed = source.parentId === null || source.parentId === undefined
      ? null
      : finalBySessionId.get(source.parentId) ?? null;
    let events = [];
    const flush = (rolloutKey, final, diagnostics) => {
      parentPort.postMessage({
        type: "batch",
        rolloutKey,
        events,
        final,
        diagnostics,
      });
      events = [];
    };
    const outcome = await extractRolloutUsage(source.path, {
      size: source.size,
      seedModel: seed?.model ?? null,
      seedEffort: seed?.effort ?? null,
      ...(maximumLineBytes === undefined ? {} : { maximumLineBytes }),
      onEvent: (event) => {
        events.push(event);
        if (events.length >= BATCH_EVENTS) flush(source.rolloutKey, false, null);
      },
    });
    if (source.sessionId) {
      finalBySessionId.set(source.sessionId, {
        model: outcome.finalModel,
        effort: outcome.finalEffort,
      });
    }
    flush(source.rolloutKey, true, {
      relevantLines: outcome.diagnostics.relevantLines,
      malformedLines: outcome.diagnostics.malformedLines,
      partialLines: outcome.diagnostics.partialLines,
      salvagedRecords: outcome.diagnostics.salvagedRecords,
      oversizedLines: outcome.read.oversizedLines,
      seeded: seed?.model != null,
    });
  }
}

run().then(
  () => {
    parentPort?.close();
  },
  (error) => {
    // Content-free: only the error's own code or name is reported upward, and
    // a non-zero exit code is what the host actually keys off.
    process.exitCode = 1;
    parentPort?.postMessage({
      type: "failed",
      code: error?.code ?? error?.name ?? "unified_index_worker_failed",
    });
    parentPort?.close();
  },
);
