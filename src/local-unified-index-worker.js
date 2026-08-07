import { parentPort, workerData } from "node:worker_threads";

import {
  createLineageSnapshots,
  extractRolloutUsage,
} from "./local-unified-index-extract.js";

// One lane of a parallel rebuild.
//
// A lane is a list of whole lineage components: a fork and all of its
// ancestors and descendants are always scanned by the same worker, in
// parent-first order. That is what lets fork-replay suppression work without
// any cross-thread coordination — the ancestor snapshot sets a fork has to be
// checked against are built in this thread, moments earlier, and are released
// at the component boundary so a lane's peak is its largest component rather
// than the whole lane.
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
  const components = workerData?.components;
  if (!Array.isArray(components)
      || !components.every((members) => Array.isArray(members) && members.every(validSource))) {
    throw new Error("unified index worker input is invalid");
  }
  const maximumLineBytes = workerData?.maximumLineBytes;

  for (const members of components) {
    // `createLineageSnapshots` wants lineage-shaped members; the wire form is
    // flat, so adapt rather than widen the message.
    const shaped = members.map((source) => ({
      ...source,
      lineage: {
        sessionId: source.sessionId,
        parentId: source.parentId,
        isFork: source.isFork === true,
      },
    }));
    const snapshots = createLineageSnapshots(shaped);
    const finalBySessionId = new Map();
    try {
      for (const source of shaped) {
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
          isFork: source.isFork === true,
          inheritedSnapshots: snapshots.inheritedFor(source),
          collectSnapshots: snapshots.collectorFor(source),
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
          forkReplayEventsSkipped: outcome.diagnostics.forkReplayEventsSkipped,
          unattributedForkReplayEventsSkipped:
            outcome.diagnostics.unattributedForkReplayEventsSkipped,
          oversizedLines: outcome.read.oversizedLines,
          retainedSnapshotKeys: snapshots.retainedKeys,
          seeded: seed?.model != null,
        });
      }
    } finally {
      snapshots.release();
    }
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
