import { parentPort, workerData } from "node:worker_threads";

import {
  createLineageSnapshots,
  extractRolloutUsage,
  inheritedTierSeed,
  ownObservedTier,
  rolloutContentQuarantineReason,
} from "./local-unified-index-extract.js";
import { createHistoryBaseSeedResolver } from "./local-unified-index-history.js";
import { withStableRolloutSource } from "./rollout-source-snapshot.js";

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
  // The host writes each received batch through synchronous node:sqlite calls.
  // Keep that main-thread turn deliberately short so the companion can answer
  // health/status/cancel requests between batches while a cold index is built.
  // Transaction commits remain governed independently by the host's larger
  // commitRows setting, so this responsiveness bound does not multiply fsyncs.
  const batchEvents = workerData?.batchEvents;
  if (batchEvents !== 1) {
    throw new Error("unified index worker batch bound is invalid");
  }
  const batchAcknowledgement = workerData?.batchAcknowledgement;
  if (!(batchAcknowledgement instanceof SharedArrayBuffer)
      || batchAcknowledgement.byteLength !== Int32Array.BYTES_PER_ELEMENT) {
    throw new Error("unified index worker acknowledgement is invalid");
  }
  const batchSequence = new Int32Array(batchAcknowledgement);

  for (const members of components) {
    // `createLineageSnapshots` wants lineage-shaped members; the wire form is
    // flat, so adapt rather than widen the message.
    const shaped = members.map((source) => ({
      ...source,
      lineage: {
        sessionId: source.sessionId,
        parentId: source.parentId,
        isFork: source.isFork === true,
        isInlineFork: source.isInlineFork === true,
        historyMode: source.historyMode,
        historyBase: source.historyBase,
        startOrdinal: source.startOrdinal,
      },
    }));
    const snapshots = createLineageSnapshots(shaped);
    const finalBySessionId = new Map();
    const historySeeds = createHistoryBaseSeedResolver(shaped, {
      maximumLineBytes,
    });
    const invalidRolloutIds = new Set();
    const invalidSessionIds = new Set();
    const dependencyUnavailable = (source) => {
      const baseId = source.historyBase?.rolloutId ?? null;
      if (baseId !== null && invalidRolloutIds.has(baseId)) return true;
      return source.isInlineFork === true
        && typeof source.parentId === "string"
        && invalidSessionIds.has(source.parentId);
    };
    const markUnavailable = (source) => {
      if (typeof source.rolloutId === "string") {
        invalidRolloutIds.add(source.rolloutId);
      }
      if (typeof source.sessionId === "string") {
        invalidSessionIds.add(source.sessionId);
      }
    };
    try {
      for (const source of shaped) {
        const logicalSeed = source.parentId === null || source.parentId === undefined
          ? null
          : finalBySessionId.get(source.parentId) ?? null;
        if (dependencyUnavailable(source)) {
          markUnavailable(source);
          parentPort.postMessage({
            type: "batch",
            rolloutKey: source.rolloutKey,
            events: [],
            boundaries: [],
            tools: [],
            snapshotKeys: [],
            snapshotReset: false,
            snapshotSeedKeys: [],
            final: true,
            diagnostics: {},
            cursor: null,
            quarantineReason: "codex_rollout_lineage_invalid",
          });
          continue;
        }
        const collector = snapshots.collectorFor(source);
        const historySeed = await historySeeds.resolveSeed(source, {
          includeSnapshots: collector !== null,
        });
        const snapshotReset = collector !== null && historySeed !== null
          && snapshots.replaceFor(source, historySeed.seedSnapshots);
        let snapshotResetPending = snapshotReset;
        let snapshotSeedKeys = snapshotReset
          ? [...historySeed.seedSnapshots]
          : [];
        let events = [];
        let boundaries = [];
        let tools = [];
        let snapshotKeys = [];
        const flush = (
          rolloutKey,
          final,
          diagnostics,
          cursor = null,
          quarantineReason = null,
        ) => {
          const sequence = Atomics.load(batchSequence, 0);
          const seedKeys = snapshotSeedKeys.splice(0, batchEvents);
          parentPort.postMessage({
            type: "batch",
            rolloutKey,
            events,
            boundaries,
            tools,
            // Snapshot keys collected for descendants — "|"-joined token
            // counters, nothing that can hold content. The host persists them
            // so a later incremental ingest can answer for this ancestor.
            snapshotKeys,
            snapshotReset: snapshotResetPending,
            snapshotSeedKeys: seedKeys,
            final,
            diagnostics,
            cursor,
            quarantineReason,
          });
          while (Atomics.load(batchSequence, 0) === sequence) {
            if (Atomics.wait(batchSequence, 0, sequence, 30_000) === "timed-out") {
              throw new Error("unified index worker acknowledgement timed out");
            }
          }
          events = [];
          boundaries = [];
          tools = [];
          snapshotKeys = [];
          snapshotResetPending = false;
        };
        while (snapshotSeedKeys.length > batchEvents) {
          flush(source.rolloutKey, false, null);
        }
        const outcome = await withStableRolloutSource(source, (stableSource) => (
          extractRolloutUsage(stableSource, {
          size: source.size,
          isFork: source.isInlineFork === true,
          inheritedSnapshots: source.isInlineFork === true
            ? snapshots.inheritedFor(source)
            : null,
          collectSnapshots: collector === null ? null : {
            add(key) {
              collector.add(key);
              snapshotKeys.push(key);
              if (events.length + boundaries.length + tools.length
                  + snapshotKeys.length >= batchEvents) {
                flush(source.rolloutKey, false, null);
              }
            },
          },
          seedModel: historySeed?.seedModel ?? logicalSeed?.model ?? null,
          seedEffort: historySeed?.seedEffort ?? logicalSeed?.effort ?? null,
          // Lineage speed carry-forward: the parent's final tier already folds
          // in its own seed, so a direct-parent lookup spans the whole chain.
          seedTier: historySeed?.seedTier
            ?? inheritedTierSeed(logicalSeed?.tier ?? null),
          seedTotals: historySeed?.seedTotals ?? null,
          ...(maximumLineBytes === undefined ? {} : { maximumLineBytes }),
          onEvent: (event) => {
            events.push(event);
            if (events.length + boundaries.length + tools.length >= batchEvents) {
              flush(source.rolloutKey, false, null);
            }
          },
          onBoundary: (event) => {
            boundaries.push(event);
            if (events.length + boundaries.length + tools.length >= batchEvents) {
              flush(source.rolloutKey, false, null);
            }
          },
            onTool: (event) => {
            tools.push(event);
            if (events.length + boundaries.length + tools.length >= batchEvents) {
              flush(source.rolloutKey, false, null);
            }
            },
          })
        ));
        const quarantineReason = rolloutContentQuarantineReason(outcome);
        if (quarantineReason !== null) markUnavailable(source);
        if (source.sessionId && quarantineReason === null) {
          finalBySessionId.set(source.sessionId, {
            model: outcome.finalModel,
            effort: outcome.finalEffort,
            tier: outcome.finalTier,
          });
        }
        flush(source.rolloutKey, true, {
          relevantLines: outcome.diagnostics.relevantLines,
          malformedLines: outcome.diagnostics.malformedLines,
          malformedAccountingRecords:
            outcome.diagnostics.malformedAccountingRecords,
          malformedUsageRecords: outcome.diagnostics.malformedUsageRecords,
          malformedRateLimitRecords:
            outcome.diagnostics.malformedRateLimitRecords,
          partialLines: outcome.diagnostics.partialLines,
          salvagedRecords: outcome.diagnostics.salvagedRecords,
          compactionEvents: outcome.diagnostics.compactionEvents,
          forkReplayEventsSkipped: outcome.diagnostics.forkReplayEventsSkipped,
          unattributedForkReplayEventsSkipped:
            outcome.diagnostics.unattributedForkReplayEventsSkipped,
          toolRecords: outcome.diagnostics.toolRecords,
          toolEvents: outcome.diagnostics.toolEvents,
          toolRecordsSkipped: outcome.diagnostics.toolRecordsSkipped,
          oversizedLines: outcome.read.oversizedLines,
          retainedSnapshotKeys: snapshots.retainedKeys,
          seeded: historySeed?.seedModel != null || logicalSeed?.model != null,
        }, quarantineReason === null ? {
          nextOffset: outcome.read.nextOffset,
          finalModel: outcome.finalModel,
          finalEffort: outcome.finalEffort,
          // Own-file declarations only: an inherited seed is re-derived from
          // the ancestor chain on the next pass, keeping its provenance.
          finalTierRaw: ownObservedTier(outcome.finalTier)?.providerTierRaw ?? null,
          finalTierObservedAtMs: ownObservedTier(outcome.finalTier)?.observedAtMs ?? null,
          finalTotals: outcome.finalTotals,
          finalCompactionPending: outcome.finalCompactionPending,
          finalTurnContextPending: outcome.finalTurnContextPending,
          turnContextSeen: outcome.finalTurnContextSeen,
          snapshotsPersisted: collector !== null,
        } : null, quarantineReason);
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
