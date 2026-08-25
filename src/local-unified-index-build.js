import { availableParallelism } from "node:os";
import { basename, dirname, resolve, win32 } from "node:path";
import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { Worker } from "node:worker_threads";

import {
  codexRolloutDiscoveryReceipt,
  createLeadingRateLimitGate,
  discoverCodexRolloutInfos,
} from "./codex-log-scan.js";
import { recognizedExportModelId } from "./export/index.js";
import {
  createLineageSnapshots,
  extractRolloutUsage,
  inheritedTierSeed,
  ownObservedTier,
  rolloutContentQuarantineReason,
} from "./local-unified-index-extract.js";
import { createHistoryBaseSeedResolver } from "./local-unified-index-history.js";
import { withStableRolloutSource } from "./rollout-source-snapshot.js";
import {
  assertSafeLocalUnifiedIndexTarget,
  assertWindowsUnifiedIndexStagingUnavailable,
  createUnifiedIndexWriter,
  createLocalUnifiedIndexSecondaryIndexes,
  beginUnifiedIndexGeneration,
  recoverUnifiedIndexGenerations,
  defaultLocalUnifiedIndexPath,
  defaultLocalUnifiedIndexSecretPath,
  LOCAL_UNIFIED_INDEX_SOURCE_IDENTITY_VERSION,
  localDigest,
  openLocalUnifiedIndex,
  outcomeOrdinal,
  publishStagedUnifiedIndex,
  readOrCreateDeviceSalt,
  readUnifiedIndexGenerationDescriptor,
  reasoningEffortOrdinal,
  removeIfPresent,
  sessionLocal,
  snapshotLocal,
  sourceLocal,
} from "./local-unified-index.js";

// Rebuild the unified index from source.
//
// A cold rebuild is deliberately ONE run. The collector's per-run source-byte
// budget (1.5 GiB) exists to keep a background daemon from monopolising the
// machine; applied to a 78.99 GiB corpus it would need ~53 runs to reach
// coverage, which is why a complete index had never actually been produced.
// This path has no per-run byte budget at all. It is safe to remove because
// peak memory here is a function of the 64 KiB bounded-line cap and the commit
// batch size, not of corpus or file size, and because the whole rebuild lands
// in a staging file that is published by atomic rename — an interruption
// leaves the previous index untouched and costs only the work done so far.

const MAXIMUM_WORKERS = 10;

// Off-main Electron runs own one immutable, parent-generated token for the
// whole ingest attempt. It is deliberately narrow: the bounded abandoned-
// stage scanner can classify a hard-terminated worker's orphan without
// enumerating or globbing the state directory by token prefix. Direct/native
// callers leave this unset and retain the historical pid/timestamp stage names.
export const LOCAL_UNIFIED_INDEX_ATTEMPT_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;

export function validateLocalUnifiedIndexAttemptToken(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string"
      || !LOCAL_UNIFIED_INDEX_ATTEMPT_TOKEN_PATTERN.test(value)) {
    throw fixedError("local_unified_index_attempt_token_invalid");
  }
  return value;
}

export function localUnifiedIndexStageFile(
  indexFile,
  kind,
  attemptToken = null,
) {
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw fixedError("local_unified_index_worker_options_invalid");
  }
  if (kind !== "building" && kind !== "incremental") {
    throw fixedError("local_unified_index_worker_options_invalid");
  }
  const resolvedIndexFile = resolve(indexFile);
  const token = validateLocalUnifiedIndexAttemptToken(attemptToken);
  return token === null
    ? `${resolvedIndexFile}.${kind}-${process.pid}-${Date.now().toString(36)}`
    // Keep the parent-generated capability exact while retaining the owner
    // PID in the filename. If a worker is hard-terminated, the normal
    // bounded abandoned-stage scanner can recognize this orphan without a
    // token-prefix enumeration or parent-side pathname deletion.
    : `${resolvedIndexFile}.${kind}-${process.pid}-${token}`;
}

// The host consumes worker messages through synchronous SQLite calls. Keep a
// single delivery turn bounded without changing the writer's independent
// commitRows policy (10,000 by default).
export const LOCAL_UNIFIED_INDEX_WORKER_BATCH_EVENTS = 500;

// A cooperative checkpoint is deliberately much less frequent than a worker
// delivery batch. It closes any sub-threshold writer transaction before
// yielding, so cancellation can be observed without introducing an async
// boundary in the middle of an open transaction or turning every event into a
// commit.
export const LOCAL_UNIFIED_INDEX_COOPERATIVE_CHECKPOINT_ROWS = 10_000;

const CODEX_BILLING_SURFACE = "chatgpt_subscription";

export function sourceIdentityForInfo(info) {
  return typeof info?.sourceIdentity === "string"
      && info.sourceIdentity.length > 0
    ? info.sourceIdentity
    : info.rolloutKey;
}

export function sourceRepresentationIdentityForInfo(info) {
  return typeof info?.path === "string" && info.path.length > 0
    ? `representation:${info.path}`
    : `representation:${info?.rolloutKey ?? "unknown"}`;
}

export function sourcePhysicalIdentityToken(info) {
  const values = [info?.dev, info?.ino, info?.birthtimeMs].map(Number);
  if (!values.every(Number.isFinite)) return null;
  return values.map((value) => String(value)).join(":");
}

export function sourcePhysicalStateToken(info) {
  const values = [info?.mtimeMs, info?.ctimeMs].map(Number);
  if (!values.every(Number.isFinite)) return null;
  return values.map((value) => String(value)).join(":");
}

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Create a bounded cancellation/event-loop checkpoint for synchronous ingest.
 *
 * Callers invoke the returned function immediately after one sink operation.
 * At the fixed threshold, `flush` closes any residual SQLite transaction and
 * the next event-loop turn gives the companion's abort/control messages a
 * chance to run. The default threshold intentionally matches commitRows.
 */
export function createLocalUnifiedIndexCooperativeCheckpoint({
  signal = null,
  flush = null,
  every = LOCAL_UNIFIED_INDEX_COOPERATIVE_CHECKPOINT_ROWS,
} = {}) {
  if (signal !== null
      && (typeof signal !== "object"
        || typeof signal.aborted !== "boolean")) {
    throw new TypeError("signal must be an AbortSignal or null");
  }
  if (flush !== null && typeof flush !== "function") {
    throw new TypeError("flush must be a function or null");
  }
  if (!Number.isSafeInteger(every) || every < 1) {
    throw new TypeError("every must be a positive safe integer");
  }
  let sinceCheckpoint = 0;
  return () => {
    if (signal?.aborted === true) {
      throw fixedError("local_unified_index_aborted");
    }
    sinceCheckpoint += 1;
    if (sinceCheckpoint < every) return null;
    sinceCheckpoint = 0;
    flush?.();
    return setImmediatePromise().then(() => {
      if (signal?.aborted === true) {
        throw fixedError("local_unified_index_aborted");
      }
    });
  };
}

/**
 * Every usage row carries a model declaration triple that the upload contract
 * validates: recognized ids keep their id, an observed-but-unreviewed id
 * becomes `unrecognized`, and never having seen one at all is `missing`. The
 * old collector collapsed the last two into the same `"unknown"` string, which
 * is precisely why a data gap could hide in it.
 */
export function modelDeclaration(rawModel) {
  if (typeof rawModel !== "string" || rawModel.length === 0) {
    return { modelId: "unknown", recognition: "missing" };
  }
  const recognized = recognizedExportModelId(rawModel);
  if (recognized !== null && recognized !== undefined) {
    return { modelId: recognized, recognition: "recognized" };
  }
  return { modelId: "unknown", recognition: "unrecognized" };
}

function tierRow(tier) {
  if (tier === null || tier === undefined) {
    return {
      apiServiceTier: "unknown",
      billingSurface: CODEX_BILLING_SURFACE,
      codexSpeedMode: "unknown",
      tierSource: "unobserved",
      providerTierRaw: null,
    };
  }
  const raw = tier.providerTierRaw;
  const normalized = typeof raw === "string" ? raw.toLowerCase() : null;
  let codexSpeedMode = "unknown";
  if (normalized === "default" || normalized === "standard") codexSpeedMode = "standard";
  else if (normalized === "priority" || normalized === "fast") codexSpeedMode = "fast";
  else if (normalized !== null) codexSpeedMode = "other";
  return {
    apiServiceTier: "unknown",
    billingSurface: CODEX_BILLING_SURFACE,
    codexSpeedMode,
    // Provenance, not observation strength: a tier seeded from the fork/parent
    // ancestor chain must not masquerade as a declaration read from this
    // file. Pricing keys off `codexSpeedMode` alone, so an inherited Fast
    // still prices Fast — the label only records where the value came from.
    tierSource: tier.inherited === true
      ? "lineage_inherited"
      : "rollout_thread_settings",
    providerTierRaw: raw ?? null,
  };
}

export function surfaceRow(surfaceClassification) {
  return {
    agentScope: surfaceClassification?.agentScope ?? "unknown",
    surface: surfaceClassification?.surface ?? "local_rollout_unclassified",
    threadSource: surfaceClassification?.threadSource ?? "unknown",
    lineageDisposition: surfaceClassification?.lineageDisposition ?? "standalone",
  };
}

/**
 * Group discovered sources into lineage components — a fork and every one of
 * its ancestors and descendants stay together — and order each component
 * parent-first. That ordering is what lets a forked child inherit its parent's
 * model, and keeping a component whole is what lets the same inheritance work
 * when components are spread across worker threads.
 */
export function lineageComponents(infos) {
  const byThreadId = new Map();
  const byRolloutId = new Map();
  for (const info of infos) {
    const threadId = info.threadId ?? info.lineage?.sessionId;
    if (threadId) {
      const members = byThreadId.get(threadId) ?? [];
      members.push(info);
      byThreadId.set(threadId, members);
    }
    if (info.rolloutId) byRolloutId.set(info.rolloutId, info);
  }
  const dependencies = new Map(infos.map((info) => [info, new Set()]));
  const neighbors = new Map(infos.map((info) => [info, new Set()]));
  function connect(info, dependency) {
    if (dependency === undefined || dependency === info) return;
    dependencies.get(info).add(dependency);
    neighbors.get(info).add(dependency);
    neighbors.get(dependency).add(info);
  }
  for (const info of infos) {
    const baseId = info.lineage?.historyBase?.rolloutId ?? null;
    if (baseId !== null) connect(info, byRolloutId.get(baseId));
    const parentId = info.lineage?.parentId ?? null;
    for (const parent of byThreadId.get(parentId) ?? []) {
      connect(info, parent);
    }
  }

  const components = [];
  const assigned = new Set();
  for (const start of infos) {
    if (assigned.has(start)) continue;
    const members = [];
    const queue = [start];
    let queueIndex = 0;
    assigned.add(start);
    while (queueIndex < queue.length) {
      const current = queue[queueIndex];
      queueIndex += 1;
      members.push(current);
      for (const neighbor of neighbors.get(current)) {
        if (assigned.has(neighbor)) continue;
        assigned.add(neighbor);
        queue.push(neighbor);
      }
    }
    const depthMemo = new Map();
    function depth(startInfo) {
      if (depthMemo.has(startInfo)) return depthMemo.get(startInfo);
      const active = new Set();
      const stack = [{ info: startInfo, expanded: false }];
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (depthMemo.has(frame.info)) {
          active.delete(frame.info);
          stack.pop();
          continue;
        }
        if (!frame.expanded) {
          frame.expanded = true;
          active.add(frame.info);
          for (const parent of dependencies.get(frame.info)) {
            if (!depthMemo.has(parent) && !active.has(parent)) {
              stack.push({ info: parent, expanded: false });
            }
          }
          continue;
        }
        let maximumParentDepth = -1;
        for (const parent of dependencies.get(frame.info)) {
          maximumParentDepth = Math.max(
            maximumParentDepth,
            depthMemo.get(parent) ?? 0,
          );
        }
        depthMemo.set(frame.info, maximumParentDepth + 1);
        active.delete(frame.info);
        stack.pop();
      }
      return depthMemo.get(startInfo) ?? 0;
    }
    members.sort((left, right) => (
      depth(left) - depth(right)
      || left.rolloutKey.localeCompare(right.rolloutKey)
    ));
    components.push({
      root: members[0],
      members,
      bytes: members.reduce((sum, info) => sum + Number(info.size ?? 0), 0),
    });
  }
  return components.sort((left, right) => right.bytes - left.bytes);
}

export { createLineageSnapshots };

export function balanceComponents(components, workerCount) {
  const lanes = Array.from(
    { length: workerCount },
    () => ({ bytes: 0, members: [], components: [] }),
  );
  for (const component of components) {
    let lightest = lanes[0];
    for (const lane of lanes) if (lane.bytes < lightest.bytes) lightest = lane;
    lightest.bytes += component.bytes;
    // A lane keeps its components separable, not just concatenated: the worker
    // holds fork-replay snapshot sets for one component at a time and frees
    // them at its boundary, so a lane's peak is its largest component rather
    // than the whole lane.
    lightest.components.push(component.members);
    for (const member of component.members) lightest.members.push(member);
  }
  return lanes.filter((lane) => lane.members.length > 0);
}

/**
 * Resolve a paginated rollout's carried state at the exact physical history
 * boundary named by Codex. The scan is content-free and emits no facts; its
 * only output is the same bounded model/tier/counter and replay-snapshot state
 * the normal extractor would hold after that prefix. Results are cached by
 * immutable rollout id and cutoff so successive generations do not re-read
 * one base boundary within a pass.
 */
export { createHistoryBaseSeedResolver };

function accumulate(totals, source, oversizedLines) {
  totals.relevantLines += source.relevantLines;
  totals.malformedLines += source.malformedLines;
  totals.partialLines += source.partialLines;
  totals.salvagedRecords += source.salvagedRecords;
  totals.forkReplayEventsSkipped += source.forkReplayEventsSkipped;
  totals.unattributedForkReplayEventsSkipped
    += source.unattributedForkReplayEventsSkipped;
  totals.compactionEvents += source.compactionEvents ?? 0;
  totals.oversizedLines += oversizedLines;
}

/**
 * Persist one source's finished cursor so a later incremental ingest can skip
 * or resume it. Everything carried is typed metadata; no path, no content.
 */
export function writeCursorForOutcome(writer, deviceSalt, info, state, {
  nextOffset,
  finalModel,
  finalEffort,
  finalTierRaw,
  finalTierObservedAtMs,
  finalTotals,
  finalCompactionPending = null,
  finalTurnContextPending = false,
  turnContextSeen,
  snapshotsPersisted = false,
  quarantineCode = null,
}) {
  writer.writeSourceCursor({
    sourceLocal: sourceLocal(deviceSalt, sourceIdentityForInfo(info)),
    sourceOrdinal: state.sourceOrdinal ?? null,
    sessionLocal: state.sessionLocal,
    scannedBytes: nextOffset,
    sizeBytes: Number(info.size ?? 0),
    mtimeMs: Number.isSafeInteger(info.mtimeMs)
      ? info.mtimeMs
      : Math.floor(Number(info.mtimeMs ?? 0)),
    sourceDev: Number.isSafeInteger(Number(info.dev)) ? Number(info.dev) : null,
    sourceIno: Number.isSafeInteger(Number(info.ino)) ? Number(info.ino) : null,
    sourceBirthtimeMs: Number.isFinite(Number(info.birthtimeMs))
      ? Math.floor(Number(info.birthtimeMs))
      : null,
    sourceCtimeMs: Number.isFinite(Number(info.ctimeMs))
      ? Math.floor(Number(info.ctimeMs))
      : null,
    sourceIdentityToken: sourcePhysicalIdentityToken(info),
    sourceStateToken: sourcePhysicalStateToken(info),
    quarantineCode,
    snapshotsPersisted,
    turnContextSeen,
    carryModel: finalModel,
    carryEffort: finalEffort,
    carryTierRaw: finalTierRaw,
    carryTierObservedAtMs: finalTierObservedAtMs,
    carryTotals: finalTotals,
    compactionPending: finalCompactionPending,
    turnContextPending: finalTurnContextPending,
  });
}

/**
 * A collector-set wrapper that also persists every collected snapshot key.
 * The in-memory set stays the hot path within this pass; the persisted digest
 * is what lets a LATER incremental pass answer for this ancestor.
 */
export function persistingCollector(collector, writer, deviceSalt, sessionLocalKey) {
  if (collector === null) return null;
  return {
    add(key) {
      collector.add(key);
      writer.addLineageSnapshot(sessionLocalKey, snapshotLocal(deviceSalt, key));
    },
  };
}

function replacePersistedSnapshotsFromHistory({
  snapshots,
  info,
  historySeed,
  collector,
  writer,
  deviceSalt,
  sessionLocalKey,
}) {
  if (collector === null || historySeed === null) return;
  if (!snapshots.replaceFor(info, historySeed.seedSnapshots)) return;
  writer.clearLineageSnapshots(sessionLocalKey);
  for (const key of historySeed.seedSnapshots) {
    writer.addLineageSnapshot(sessionLocalKey, snapshotLocal(deviceSalt, key));
  }
}

function eventKeyFor(deviceSalt, sourceLocalKey, sourceOffset, observedAtMs) {
  // 32 raw bytes, deterministic, content-free, and stable across rebuilds: the
  // same (physical rollout, byte offset) always produces the same key, so a
  // rerun is idempotent rather than duplicating history. The old key was 64 hex
  // characters of SHA-256 over a JSON re-encoding of the entire record, which
  // meant every stored field had to be reproduced byte-for-byte to recompute
  // it.
  return localDigest(
    deviceSalt,
    "unified-index-event",
    `${Buffer.from(sourceLocalKey).toString("hex")}\0${sourceOffset}\0${observedAtMs}`,
  );
}

function toolFactKey(deviceSalt, sourceLocalKey, sourceOffset, toolOrdinal) {
  return localDigest(
    deviceSalt,
    "unified-index-tool-event",
    `${Buffer.from(sourceLocalKey).toString("hex")}\0${sourceOffset}\0${toolOrdinal}`,
  );
}

export function createEventSink({
  writer,
  deviceSalt,
  accountScopeId,
  generationId = null,
  onCounts,
}) {
  const counts = {
    usageEvents: 0,
    boundaryLinks: 0,
    quotaObservations: 0,
    quotaOccurrences: 0,
    contradictedLeadingSnapshotsSkipped: 0,
    toolEvents: 0,
    modelMissing: 0,
    modelUnrecognized: 0,
    partialEvents: 0,
  };
  const gates = new Map();
  const settled = new Map();
  const sourceSuppressed = new Map();
  const perSourceCounts = new Map();

  function sourceKey(source) {
    return source.sourceLocal.toString("hex");
  }

  function add(source, field, value = 1) {
    counts[field] += value;
    const key = sourceKey(source);
    const sourceCounts = perSourceCounts.get(key) ?? {};
    sourceCounts[field] = (sourceCounts[field] ?? 0) + value;
    perSourceCounts.set(key, sourceCounts);
  }

  function gateFor(source) {
    const key = source.sourceLocal.toString("hex");
    let gate = gates.get(key);
    if (gate !== undefined) return gate;
    const windows = settled.get(key)
      ?? writer.loadSettledQuotaWindows(source.sourceLocal);
    settled.set(key, windows);
    gate = createLeadingRateLimitGate(windows);
    gates.set(key, gate);
    return gate;
  }

  function occurrence(entry, admission) {
    writer.writeQuotaOccurrence({ ...entry, generationId, admission });
    if (admission === "admitted") add(entry, "quotaOccurrences");
  }

  return {
    counts,
    write(source, event) {
      const declaration = modelDeclaration(event.model);
      if (declaration.recognition === "missing") add(source, "modelMissing");
      if (declaration.recognition === "unrecognized") {
        add(source, "modelUnrecognized");
      }
      if (event.partial) add(source, "partialEvents");
      let quotaObservationId = null;
      const gate = gateFor(source);
      for (const [slotOrder, window] of event.quota.entries()) {
        const id = writer.internQuota(window);
        add(source, "quotaObservations");
        if (quotaObservationId === null || window.slot === "primary") {
          quotaObservationId = id;
        }
        const entry = {
          sourceLocal: source.sourceLocal,
          sourceOffset: event.sourceOffset,
          sourceOrdinal: source.sourceOrdinal,
          surfaceId: source.surfaceId,
          canonicalObservationId: id,
          observedAtMs: window.observedAtMs,
          provider: "openai_codex",
          planType: window.planType ?? null,
          limitId: window.limitId,
          slot: window.slot,
          slotOrder,
          usedPercent: window.usedPercent,
          resetsAtMs: window.resetsAtMs ?? null,
          durationMins: window.durationMins,
        };
        // The replay callback contract requires a positive reset epoch. Keep
        // the canonical observation for diagnostics, but never admit a
        // reset-less window into the source-scoped callback series.
        if (entry.resetsAtMs === null || entry.resetsAtMs <= 0) {
          occurrence(entry, "suppressed");
          continue;
        }
        const decision = gate.offer({
          provider: entry.provider,
          planType: entry.planType,
          limitId: entry.limitId,
          slot: entry.slot,
          usedPercent: entry.usedPercent,
          resetsAt: entry.resetsAtMs,
          windowDurationMins: entry.durationMins,
        }, entry.observedAtMs, entry);
        for (const withheld of decision.withheld) {
          add(source, "contradictedLeadingSnapshotsSkipped");
          const key = source.sourceLocal.toString("hex");
          sourceSuppressed.set(key, (sourceSuppressed.get(key) ?? 0) + 1);
          occurrence(withheld, "suppressed");
        }
        for (const released of decision.released) occurrence(released, "admitted");
        if (decision.released.length === 0 && decision.withheld.length === 0) {
          occurrence(entry, "held");
        }
      }
      const components = event.components;
      writer.writeUsageEvent({
        eventKey: eventKeyFor(
          deviceSalt,
          source.sourceLocal,
          event.sourceOffset,
          event.observedAtMs,
        ),
        sourceId: source.sourceId,
        sourceOffset: event.sourceOffset,
        observedAtMs: event.observedAtMs,
        generationId,
        sourceLocal: source.sourceLocal,
        sourceOffset: event.sourceOffset,
        sourceOrdinal: source.sourceOrdinal,
        tierObservedAtMs: event.tier?.observedAtMs ?? null,
        sessionLocal: source.sessionLocal,
        accountScopeId,
        modelId: writer.internModel(declaration.modelId, declaration.recognition),
        tierId: writer.internTier(tierRow(event.tier)),
        surfaceId: source.surfaceId,
        quotaObservationId,
        reasoningEffort: reasoningEffortOrdinal(event.reasoningEffort ?? "unknown"),
        outcome: outcomeOrdinal("unknown"),
        tokensInUncached: components?.inputUncachedTokens ?? null,
        tokensInCacheRead: components?.inputCacheReadTokens ?? null,
        tokensInCacheWrite: components?.inputCacheWriteTokens ?? null,
        tokensInCacheWrite5m: null,
        tokensInCacheWrite1h: null,
        tokensOutText: components?.outputTextTokens ?? null,
        tokensOutReasoning: components?.outputReasoningTokens ?? null,
        tokensOutCombined: null,
        totalInputContext: null,
        partial: event.partial === true,
      });
      add(source, "usageEvents");
      if (counts.usageEvents % 50_000 === 0) onCounts?.(counts);
    },
    writeBoundary(source, event) {
      writer.writeUsageEventBoundary({
        currentEventKey: eventKeyFor(
          deviceSalt,
          source.sourceLocal,
          event.currentSourceOffset,
          event.currentObservedAtMs,
        ),
        compactionBefore: event.compactionBefore,
        turnContextBefore: event.turnContextBefore,
        compactedAtMs: event.compactedAtMs,
        sessionLocal: source.sessionLocal,
      });
      add(source, "boundaryLinks");
    },
    writeTool(source, event) {
      const inserted = writer.writeToolClassFact({
        eventKey: toolFactKey(
          deviceSalt,
          source.sourceLocal,
          event.sourceOffset,
          event.toolOrdinal,
        ),
        generationId,
        sourceLocal: source.sourceLocal,
        sourceOffset: event.sourceOffset,
        sourceOrdinal: source.sourceOrdinal,
        sessionLocal: source.sessionLocal,
        observedAtMs: event.observedAtMs,
        toolOrdinal: event.toolOrdinal,
        toolClass: event.toolClass,
        sourceKind: event.sourceKind,
      });
      add(source, "toolEvents", inserted);
    },
    finishSource(source) {
      const gate = gates.get(source.sourceLocal.toString("hex"));
      if (gate === undefined) return;
      for (const entry of gate.flush()) occurrence(entry, "admitted");
    },
    diagnosticsForSource(source) {
      return {
        contradictedLeadingSnapshotsSkipped:
          sourceSuppressed.get(source.sourceLocal.toString("hex")) ?? 0,
      };
    },
    discardSource(source) {
      const key = sourceKey(source);
      const sourceCounts = perSourceCounts.get(key) ?? {};
      for (const [field, value] of Object.entries(sourceCounts)) {
        counts[field] -= value;
      }
      perSourceCounts.delete(key);
      gates.delete(key);
      settled.delete(key);
      sourceSuppressed.delete(key);
    },
  };
}

async function runWorkerLane(lane, laneIndex, { maximumLineBytes, signal, onBatch }) {
  return new Promise((settle, fail) => {
    const worker = new Worker(
      new URL("./local-unified-index-worker.js", import.meta.url),
      {
        workerData: {
          maximumLineBytes,
          batchEvents: LOCAL_UNIFIED_INDEX_WORKER_BATCH_EVENTS,
          components: lane.components.map((members) => members.map((info) => ({
            path: info.path,
            size: Number(info.size ?? 0),
            sessionId: info.lineage?.sessionId ?? null,
            parentId: info.lineage?.parentId ?? null,
            isFork: info.lineage?.isFork === true,
            isInlineFork: info.lineage?.isInlineFork === true,
            historyMode: info.lineage?.historyMode ?? "legacy",
            historyBase: info.lineage?.historyBase ?? null,
            startOrdinal: info.lineage?.startOrdinal ?? 0,
            rolloutId: info.rolloutId ?? null,
            rolloutKey: info.rolloutKey,
            dev: info.dev,
            ino: info.ino,
            birthtimeMs: info.birthtimeMs,
            mtimeMs: info.mtimeMs,
            ctimeMs: info.ctimeMs,
          }))),
        },
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          codeRangeSizeMb: 16,
          stackSizeMb: 2,
        },
      },
    );
    let failed = null;
    const abort = () => worker.terminate();
    signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", (message) => {
      if (message.type === "batch") {
        try {
          onBatch(laneIndex, message);
        } catch (error) {
          failed = error;
          worker.terminate();
        }
        return;
      }
      if (message.type === "failed") {
        failed ??= fixedError(message.code ?? "local_unified_index_worker_failed");
      }
    });
    worker.on("error", (error) => {
      failed ??= error;
    });
    worker.on("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      if (failed) fail(failed);
      else if (signal?.aborted) fail(fixedError("local_unified_index_aborted"));
      else if (code !== 0) fail(fixedError("local_unified_index_worker_failed"));
      else settle();
    });
  });
}

/**
 * Rebuild the whole index from the Codex rollout corpus.
 *
 * Returns measured counts and timings. `workerCount: 1` runs the identical
 * extraction in-process, which is the reference implementation the worker path
 * is checked against.
 */
export async function rebuildLocalUnifiedIndex({
  codexHome,
  indexFile = defaultLocalUnifiedIndexPath(),
  secretFile = null,
  startAt = "1970-01-01T00:00:00.000Z",
  endAt = null,
  contractVersion,
  workerCount = 1,
  commitRows = 10_000,
  deferSecondaryIndexes = true,
  maximumLineBytes,
  attemptToken = null,
  signal = null,
  onProgress = null,
  discoveryLimits = null,
  windowsProtectedStateStore = null,
  windowsFilesystemAdapter = null,
  windowsQualificationModeContext = null,
  stateRoot = null,
  resourceRoot = null,
  windowsSqliteStateSession = null,
  windowsSqliteStateSessionFactory = null,
  windowsSqliteStateStaging = null,
} = {}) {
  assertWindowsUnifiedIndexStagingUnavailable({
    windowsSqliteStateStaging,
    windowsQualificationModeContext,
    windowsFilesystemAdapter,
    path: indexFile,
    stateRoot,
    resourceRoot,
  });
  if (typeof codexHome !== "string" || codexHome.length < 1) {
    throw new TypeError("codexHome must be a non-empty string");
  }
  if (typeof contractVersion !== "string" || contractVersion.length < 1) {
    throw new TypeError("contractVersion must be a non-empty string");
  }
  if (!Number.isSafeInteger(workerCount) || workerCount < 1
      || workerCount > MAXIMUM_WORKERS) {
    throw new TypeError(`workerCount must be between 1 and ${MAXIMUM_WORKERS}`);
  }
  if (typeof deferSecondaryIndexes !== "boolean") {
    throw new TypeError("deferSecondaryIndexes must be a boolean");
  }
  validateLocalUnifiedIndexAttemptToken(attemptToken);
  const startedAt = performance.now();
  const resolvedIndexFile = resolve(indexFile);
  let expectedTargetIdentity = null;
  if (process.platform === "win32") {
    // The native staging object owns the root-relative inspection on Windows.
    // Do not fall back to assertSafeLocalUnifiedIndexTarget here: callers
    // normally provide a staging context and session factory, not a pre-opened
    // live target session.
    const targetName = win32.basename(resolvedIndexFile.replaceAll("/", "\\"));
    try {
      expectedTargetIdentity = windowsSqliteStateStaging.inspect(targetName);
    } catch (error) {
      if (error?.code !== "windows_sqlite_state_staging_database_missing") throw error;
    }
  } else {
    await assertSafeLocalUnifiedIndexTarget(resolvedIndexFile, {
      allowMissing: true,
      windowsSqliteStateSession,
      windowsQualificationModeContext,
      windowsFilesystemAdapter,
      stateRoot,
      resourceRoot,
    });
  }
  const deviceSalt = await readOrCreateDeviceSalt(
    secretFile ?? defaultLocalUnifiedIndexSecretPath(resolvedIndexFile),
    {
      windowsProtectedStateStore,
      windowsQualificationModeContext,
      windowsFilesystemAdapter,
      stateRoot,
      resourceRoot,
    },
  );
  const infos = await discoverCodexRolloutInfos({
    codexHome,
    startAt,
    endAt,
    signal,
    discoveryLimits,
  });
  const discovery = codexRolloutDiscoveryReceipt(infos);
  const discoveredAt = performance.now();
  const sourceBytes = discovery.discoveredSourceBytes;

  const stageFile = localUnifiedIndexStageFile(
    resolvedIndexFile,
    "building",
    attemptToken,
  );
  await removeIfPresent(stageFile, {
    windowsSqliteStateStaging,
    windowsQualificationModeContext,
    windowsFilesystemAdapter,
    stateRoot,
    resourceRoot,
  });
  let database = null;
  let generation = null;
  let writer = null;
  let sink = null;
  let stageSession = null;
  let cooperativeCheckpoint = null;
  try {
    if (process.platform === "win32") {
      const stageName = win32.basename(stageFile.replaceAll("/", "\\"));
      const targetName = win32.basename(resolvedIndexFile.replaceAll("/", "\\"));
      try {
        expectedTargetIdentity = windowsSqliteStateStaging.inspect(targetName);
      } catch (error) {
        if (error?.code !== "windows_sqlite_state_staging_database_missing") throw error;
      }
      windowsSqliteStateStaging.create(stageName);
      if (typeof windowsSqliteStateSessionFactory !== "function") {
        throw fixedError("local_unified_index_windows_state_unqualified");
      }
      stageSession = windowsSqliteStateSessionFactory({
        rootPath: win32.dirname(stageFile.replaceAll("/", "\\")),
        databaseName: stageName,
        readOnly: false,
        create: true,
        windowsQualificationModeContext,
        windowsQualificationResourceRoot: resourceRoot,
      });
    }
    database = openLocalUnifiedIndex(stageFile, {
      readOnly: false,
      create: true,
      staging: true,
      deferSecondaryIndexes,
      windowsSqliteStateSession: stageSession,
      windowsQualificationModeContext,
      windowsFilesystemAdapter,
      stateRoot,
      resourceRoot,
    });
    recoverUnifiedIndexGenerations(database);
    generation = beginUnifiedIndexGeneration(database, {
      contractVersion,
      discoveredSourceCount: discovery.discoveredSourceCount,
      discoveredSourceBytes: sourceBytes,
    });
    writer = createUnifiedIndexWriter(database, {
      commitRows,
      contractVersion,
      generationId: generation.generationId,
      parserVersionId: generation.parserVersionId,
      ingestRunId: generation.ingestRunId,
    });

    // Rollout logs carry no account identity at all; the account scope the
    // collector attaches comes from a contemporaneous app-server marker, which a
    // historical rebuild has no honest way to reconstruct.
    const accountScopeId = writer.internAccountScope({
      status: "unavailable",
      reason: "missing_account",
      planType: null,
      scopeLocal: null,
    });

    sink = createEventSink({
      writer,
      deviceSalt,
      accountScopeId,
      generationId: generation.generationId,
      onCounts: null,
    });
    cooperativeCheckpoint = createLocalUnifiedIndexCooperativeCheckpoint({
      signal,
      flush: () => writer.flush(),
    });
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the setup failure; the incomplete stage is discarded below.
    }
    await removeIfPresent(stageFile, {
      windowsSqliteStateStaging,
      windowsQualificationModeContext,
      windowsFilesystemAdapter,
      stateRoot,
      resourceRoot,
    });
    throw error;
  }
  const diagnostics = {
    sources: discovery.discoveredSourceCount,
    sourceBytes,
    skippedSourceCount: discovery.skippedSourceCount,
    skippedSourceBytes: discovery.skippedSourceBytes,
    skippedThreadCount: discovery.skippedThreadCount,
    quarantineReasonCounts: { ...discovery.reasonCounts },
    sourcesScanned: 0,
    bytesScanned: 0,
    relevantLines: 0,
    malformedLines: 0,
    partialLines: 0,
    salvagedRecords: 0,
    compactionEvents: 0,
    modelSeededFromLineage: 0,
    oversizedLines: 0,
    forkReplayEventsSkipped: 0,
    unattributedForkReplayEventsSkipped: 0,
    peakRetainedSnapshotKeys: 0,
  };

  const allSources = [...infos, ...discovery.quarantined]
    .toSorted((left, right) => (
      left.rolloutKey.localeCompare(right.rolloutKey)
      || left.path.localeCompare(right.path)
    ));
  const sourceOrdinals = new Map(
    allSources.map((info, ordinal) => [info, ordinal]),
  );
  let progressTail = Promise.resolve();
  let progressFailure = null;
  function queueProgress() {
    if (onProgress === null) return;
    const progress = {
      ...diagnostics,
      usageEvents: sink.counts.usageEvents,
    };
    progressTail = progressTail
      .then(() => onProgress(progress))
      .catch((error) => {
        progressFailure ??= error;
      });
  }
  const sourceState = new Map();
  function stateFor(info) {
    const key = info.rolloutKey;
    let state = sourceState.get(key);
    if (state === undefined) {
      const sessionId = info.lineage?.sessionId ?? info.rolloutKey;
      const local = sourceLocal(deviceSalt, sourceIdentityForInfo(info));
      const surface = surfaceRow(info.lineage?.surfaceClassification);
      state = {
        sessionLocal: sessionLocal(deviceSalt, sessionId),
        sourceLocal: local,
        sourceId: writer.internSource(local),
        sourceOrdinal: sourceOrdinals.get(info),
        surface,
        surfaceId: writer.internSurface(surface),
        finalModel: null,
        finalEffort: null,
        finalTier: null,
      };
      // The raw session UUID travels in v1.0 contribution records (owner
      // decision). The writer refuses anything that is not UUID-shaped, so a
      // rollout-key fallback id is never recorded.
      writer.recordSessionIdentity(state.sessionLocal, sessionId);
      writer.writeGenerationSource({
        sourceLocal: local,
        sourceOrdinal: state.sourceOrdinal,
        sessionLocal: state.sessionLocal,
        surfaceId: state.surfaceId,
        status: "pending",
        discoveredSizeBytes: Number(info.size ?? 0),
        scannedBytes: 0,
        mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
      });
      sourceState.set(key, state);
    }
    return state;
  }

  const issueTotals = new Map();
  const issueGroups = new Map();
  const issueThreadCounts = new Map();
  const skippedThreadLocals = new Set();
  for (const info of discovery.quarantined) {
    const sessionId = info.threadId ?? info.lineage?.sessionId ?? info.rolloutKey;
    const sessionKey = sessionLocal(deviceSalt, sessionId);
    // Failed discovery rows represent each physical filename separately. They
    // carry no facts or cursor; accepted facts use sourceIdentityForInfo.
    const sourceKey = sourceLocal(
      deviceSalt,
      sourceRepresentationIdentityForInfo(info),
    );
    const surface = surfaceRow(info.lineage?.surfaceClassification);
    writer.recordSessionIdentity(sessionKey, sessionId);
    writer.writeGenerationSource({
      sourceLocal: sourceKey,
      sourceOrdinal: sourceOrdinals.get(info),
      sessionLocal: sessionKey,
      surfaceId: writer.internSurface(surface),
      status: "failed",
      discoveredSizeBytes: Number(info.size ?? 0),
      scannedBytes: 0,
      mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
      diagnosticsComplete: true,
    });
    const totals = issueTotals.get(info.quarantineReason) ?? {
      sourceCount: 0,
      sourceBytes: 0,
    };
    totals.sourceCount += 1;
    totals.sourceBytes += Number(info.size ?? 0);
    issueTotals.set(info.quarantineReason, totals);
    const groupKey = `${sessionKey.toString("hex")}\0${info.quarantineReason}`;
    skippedThreadLocals.add(sessionKey.toString("hex"));
    const newGroup = !issueGroups.has(groupKey);
    const group = issueGroups.get(groupKey) ?? {
      groupLocal: sessionKey,
      code: info.quarantineReason,
      sourceCount: 0,
      sourceBytes: 0,
    };
    group.sourceCount += 1;
    group.sourceBytes += Number(info.size ?? 0);
    issueGroups.set(groupKey, group);
    if (newGroup) {
      issueThreadCounts.set(
        info.quarantineReason,
        (issueThreadCounts.get(info.quarantineReason) ?? 0) + 1,
      );
    }
  }
  for (const [code, totals] of issueTotals) {
    writer.writeGenerationIssue(code, {
      ...totals,
      threadCount: issueThreadCounts.get(code) ?? 0,
    });
  }
  for (const group of issueGroups.values()) {
    writer.writeGenerationIssueGroup(group.groupLocal, group.code, group);
  }

  function recordRuntimeIssue(info, code, state) {
    const totals = issueTotals.get(code) ?? { sourceCount: 0, sourceBytes: 0 };
    totals.sourceCount += 1;
    totals.sourceBytes += Number(info.size ?? 0);
    issueTotals.set(code, totals);
    const sessionHex = state.sessionLocal.toString("hex");
    skippedThreadLocals.add(sessionHex);
    const groupKey = `${sessionHex}\0${code}`;
    const newGroup = !issueGroups.has(groupKey);
    const group = issueGroups.get(groupKey) ?? {
      groupLocal: state.sessionLocal,
      code,
      sourceCount: 0,
      sourceBytes: 0,
    };
    group.sourceCount += 1;
    group.sourceBytes += Number(info.size ?? 0);
    issueGroups.set(groupKey, group);
    if (newGroup) {
      issueThreadCounts.set(code, (issueThreadCounts.get(code) ?? 0) + 1);
    }
    writer.writeGenerationIssue(code, {
      ...totals,
      threadCount: issueThreadCounts.get(code) ?? 0,
    });
    writer.writeGenerationIssueGroup(group.groupLocal, code, group);
    diagnostics.skippedSourceCount += 1;
    diagnostics.skippedSourceBytes += Number(info.size ?? 0);
    diagnostics.skippedThreadCount = skippedThreadLocals.size;
    if (newGroup) {
      diagnostics.quarantineReasonCounts[code]
        = (diagnostics.quarantineReasonCounts[code] ?? 0) + 1;
    }
  }

  const invalidRolloutIds = new Set();
  const invalidSessionIds = new Set();
  function dependencyUnavailable(info) {
    const baseId = info.lineage?.historyBase?.rolloutId ?? null;
    if (baseId !== null && invalidRolloutIds.has(baseId)) return true;
    const parentId = info.lineage?.parentId ?? null;
    return info.lineage?.isInlineFork === true
      && parentId !== null
      && invalidSessionIds.has(parentId);
  }
  function markUnavailable(info) {
    if (typeof info.rolloutId === "string") invalidRolloutIds.add(info.rolloutId);
    if (typeof info.lineage?.sessionId === "string") {
      invalidSessionIds.add(info.lineage.sessionId);
    }
  }

  function quarantineSource(info, state, reason, sourceDiagnostics = {}) {
    writer.deleteSourceFacts(state.sourceLocal, state.sessionLocal);
    sink.discardSource(state);
    if (reason === "codex_rollout_content_invalid"
        || reason === "codex_rollout_tail_incomplete"
        || reason === "codex_rollout_lineage_invalid") {
      writeCursorForOutcome(writer, deviceSalt, info, state, {
        nextOffset: 0,
        finalModel: null,
        finalEffort: null,
        finalTierRaw: null,
        finalTierObservedAtMs: null,
        finalTotals: null,
        turnContextSeen: false,
        snapshotsPersisted: false,
        quarantineCode: reason,
      });
    }
    writer.writeSourceDiagnostics(state.sourceLocal, sourceDiagnostics);
    writer.writeGenerationSource({
      sourceLocal: state.sourceLocal,
      sourceOrdinal: state.sourceOrdinal,
      sessionLocal: state.sessionLocal,
      surfaceId: state.surfaceId,
      status: "failed",
      discoveredSizeBytes: Number(info.size ?? 0),
      scannedBytes: 0,
      mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
      diagnosticsComplete: true,
    });
    recordRuntimeIssue(info, reason, state);
    markUnavailable(info);
  }

  const bySessionId = new Map();
  for (const info of infos) {
    if (!info.lineage?.sessionId) continue;
    const generations = bySessionId.get(info.lineage.sessionId) ?? [];
    generations.push(info);
    bySessionId.set(info.lineage.sessionId, generations);
  }
  function seedFor(info) {
    const none = { seedModel: null, seedEffort: null, seedTier: null };
    const parentId = info.lineage?.parentId;
    if (!parentId) return none;
    const parent = bySessionId.get(parentId)?.at(-1);
    if (!parent) return none;
    const parentState = sourceState.get(parent.rolloutKey);
    if (parentState === undefined) return none;
    return {
      seedModel: parentState.finalModel,
      seedEffort: parentState.finalEffort,
      // Lineage speed carry-forward. The direct parent's final tier already
      // folds in ITS seed (components run parent-first), so this one lookup
      // carries the nearest observed declaration down an arbitrarily deep
      // chain — and stays strictly lineage-scoped by construction.
      seedTier: inheritedTierSeed(parentState.finalTier),
    };
  }
  const historySeeds = createHistoryBaseSeedResolver(infos, {
    maximumLineBytes,
    signal,
  });

  try {
    if (workerCount === 1) {
      // Iterated by lineage component, exactly as the worker lanes are, so the
      // ancestor snapshot sets a fork needs are alive when it is scanned and
      // are dropped the moment its component finishes.
      for (const component of lineageComponents(infos)) {
        const snapshots = createLineageSnapshots(component.members);
        try {
          for (const info of component.members) {
            if (signal?.aborted) throw fixedError("local_unified_index_aborted");
            const state = stateFor(info);
            if (dependencyUnavailable(info)) {
              quarantineSource(
                info,
                state,
                "codex_rollout_lineage_invalid",
              );
              await onProgress?.({
                ...diagnostics,
                usageEvents: sink.counts.usageEvents,
              });
              continue;
            }
            const logicalSeed = seedFor(info);
            const collector = snapshots.collectorFor(info);
            const historySeed = await historySeeds.resolveSeed(info, {
              // Exact history snapshots are only needed when another inline
              // fork can replay this logical session. Ordinary paginated
              // continuations need only the constant-size carried state.
              includeSnapshots: collector !== null,
            });
            if ((historySeed !== null && historySeed.seedModel !== null)
                || logicalSeed.seedModel !== null) {
              diagnostics.modelSeededFromLineage += 1;
            }
            replacePersistedSnapshotsFromHistory({
              snapshots,
              info,
              historySeed,
              collector,
              writer,
              deviceSalt,
              sessionLocalKey: state.sessionLocal,
            });
            const outcome = await withStableRolloutSource(info, (source) => (
              extractRolloutUsage(source, {
              size: Number(info.size ?? 0),
              isFork: info.lineage?.isInlineFork === true,
              inheritedSnapshots: info.lineage?.isInlineFork === true
                ? snapshots.inheritedFor(info)
                : null,
              collectSnapshots: persistingCollector(
                collector,
                writer,
                deviceSalt,
                state.sessionLocal,
              ),
              seedModel: historySeed?.seedModel ?? logicalSeed.seedModel,
              seedEffort: historySeed?.seedEffort ?? logicalSeed.seedEffort,
              seedTier: historySeed?.seedTier ?? logicalSeed.seedTier,
              seedTotals: historySeed?.seedTotals ?? null,
              maximumLineBytes,
              signal,
              onEvent: (event) => {
                sink.write(state, event);
                return cooperativeCheckpoint?.();
              },
              onBoundary: (event) => {
                sink.writeBoundary(state, event);
                return cooperativeCheckpoint?.();
              },
              onTool: (event) => {
                sink.writeTool(state, event);
                return cooperativeCheckpoint?.();
              },
              })
            ));
            sink.finishSource(state);
            const sourceDiagnostics = {
              ...outcome.diagnostics,
              oversizedLines: outcome.read.oversizedLines,
              ...sink.diagnosticsForSource(state),
            };
            diagnostics.sourcesScanned += 1;
            diagnostics.bytesScanned += Number(info.size ?? 0);
            accumulate(diagnostics, outcome.diagnostics, outcome.read.oversizedLines);
            diagnostics.peakRetainedSnapshotKeys = Math.max(
              diagnostics.peakRetainedSnapshotKeys,
              snapshots.retainedKeys,
            );
            const quarantineReason = rolloutContentQuarantineReason(outcome);
            if (quarantineReason !== null) {
              quarantineSource(
                info,
                state,
                quarantineReason,
                sourceDiagnostics,
              );
              await onProgress?.({
                ...diagnostics,
                usageEvents: sink.counts.usageEvents,
              });
              continue;
            }
            state.finalModel = outcome.finalModel;
            state.finalEffort = outcome.finalEffort;
            state.finalTier = outcome.finalTier;
            writeCursorForOutcome(writer, deviceSalt, info, state, {
              nextOffset: outcome.read.nextOffset,
              finalModel: outcome.finalModel,
              finalEffort: outcome.finalEffort,
              // Only this file's own declarations are carried. An inherited
              // seed is re-derived from the ancestor chain on the next pass,
              // so its lineage_inherited provenance survives a resume.
              finalTierRaw: ownObservedTier(outcome.finalTier)?.providerTierRaw ?? null,
              finalTierObservedAtMs: ownObservedTier(outcome.finalTier)?.observedAtMs ?? null,
              finalTotals: outcome.finalTotals,
              finalCompactionPending: outcome.finalCompactionPending,
              finalTurnContextPending: outcome.finalTurnContextPending,
              turnContextSeen: outcome.finalTurnContextSeen,
              snapshotsPersisted: collector !== null,
            });
            writer.writeSourceDiagnostics(state.sourceLocal, sourceDiagnostics);
            writer.writeGenerationSource({
              sourceLocal: state.sourceLocal,
              sourceOrdinal: state.sourceOrdinal,
              sessionLocal: state.sessionLocal,
              surfaceId: state.surfaceId,
              status: "complete",
              discoveredSizeBytes: Number(info.size ?? 0),
              scannedBytes: outcome.read.nextOffset,
              mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
              diagnosticsComplete: true,
            });
            await onProgress?.({ ...diagnostics, usageEvents: sink.counts.usageEvents });
          }
        } finally {
          snapshots.release();
        }
      }
    } else {
      const lanes = balanceComponents(lineageComponents(infos), workerCount);
      const byRolloutKey = new Map(infos.map((info) => [info.rolloutKey, info]));
      await Promise.all(lanes.map((lane, laneIndex) => runWorkerLane(lane, laneIndex, {
        maximumLineBytes,
        signal,
        onBatch: (_index, message) => {
          const info = byRolloutKey.get(message.rolloutKey);
          if (info === undefined) return;
          const state = stateFor(info);
          if (message.snapshotReset === true) {
            writer.clearLineageSnapshots(state.sessionLocal);
            for (const key of message.snapshotSeedKeys ?? []) {
              writer.addLineageSnapshot(
                state.sessionLocal,
                snapshotLocal(deviceSalt, key),
              );
            }
          }
          for (const event of message.events) sink.write(state, event);
          for (const event of message.boundaries ?? []) {
            sink.writeBoundary(state, event);
          }
          for (const event of message.tools ?? []) {
            sink.writeTool(state, event);
          }
          for (const key of message.snapshotKeys ?? []) {
            writer.addLineageSnapshot(
              state.sessionLocal,
              snapshotLocal(deviceSalt, key),
            );
          }
          if (message.final === true) {
            sink.finishSource(state);
            const sourceDiagnostics = {
              ...message.diagnostics,
              oversizedLines: message.diagnostics.oversizedLines ?? 0,
              ...sink.diagnosticsForSource(state),
            };
            const sourceWasScanned = Number.isSafeInteger(
              message.diagnostics.relevantLines,
            );
            if (sourceWasScanned) {
              diagnostics.sourcesScanned += 1;
              diagnostics.bytesScanned += Number(info.size ?? 0);
              accumulate(
                diagnostics,
                message.diagnostics,
                message.diagnostics.oversizedLines,
              );
              diagnostics.peakRetainedSnapshotKeys = Math.max(
                diagnostics.peakRetainedSnapshotKeys,
                message.diagnostics.retainedSnapshotKeys ?? 0,
              );
              if (message.diagnostics.seeded) {
                diagnostics.modelSeededFromLineage += 1;
              }
            }
            if (typeof message.quarantineReason === "string") {
              quarantineSource(
                info,
                state,
                message.quarantineReason,
                sourceDiagnostics,
              );
              queueProgress();
              return;
            }
            if (message.cursor) {
              writeCursorForOutcome(
                writer,
                deviceSalt,
                info,
                state,
                message.cursor,
              );
            }
            writer.writeSourceDiagnostics(state.sourceLocal, sourceDiagnostics);
            writer.writeGenerationSource({
              sourceLocal: state.sourceLocal,
              sourceOrdinal: state.sourceOrdinal,
              sessionLocal: state.sessionLocal,
              surfaceId: state.surfaceId,
              status: "complete",
              discoveredSizeBytes: Number(info.size ?? 0),
              scannedBytes: Number(message.cursor?.nextOffset ?? info.size ?? 0),
              mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
              diagnosticsComplete: true,
            });
            queueProgress();
          }
        },
      })));
      await progressTail;
      if (progressFailure !== null) throw progressFailure;
    }

    const scannedAt = performance.now();
    if (signal?.aborted) throw fixedError("local_unified_index_aborted");
    if (deferSecondaryIndexes) {
      // All fact writes are settled before SQLite builds the reader-only
      // indexes in one fixed-order operation. Primary/UNIQUE indexes remain
      // online throughout the load because the writer's conflict semantics
      // depend on them.
      writer.flush();
      createLocalUnifiedIndexSecondaryIndexes(database);
    }
    writer.writeMeta("source_count", discovery.discoveredSourceCount);
    writer.writeMeta("source_bytes", sourceBytes);
    writer.writeMeta("usage_events", sink.counts.usageEvents);
    writer.writeMeta("boundary_links", sink.counts.boundaryLinks);
    writer.writeMeta("generated_at", new Date().toISOString());
    writer.writeMeta("contract_version", contractVersion);
    writer.writeMeta(
      "source_identity_version",
      LOCAL_UNIFIED_INDEX_SOURCE_IDENTITY_VERSION,
    );
    writer.writeMeta("rollout_discovery_fingerprint", discovery.fingerprint);
    writer.writeMeta(
      "rollout_quarantine_fingerprint",
      discovery.quarantineFingerprint,
    );
    if (signal?.aborted) throw fixedError("local_unified_index_aborted");
    writer.flush();
    const indexedSources = database.prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(discovered_size_bytes), 0) AS bytes
      FROM generation_source
      WHERE generation_id = ? AND status <> 'failed'`).get(
      generation.generationId,
    );
    const totalSkippedSourceCount = [...issueTotals.values()]
      .reduce((sum, totals) => sum + totals.sourceCount, 0);
    const totalSkippedSourceBytes = [...issueTotals.values()]
      .reduce((sum, totals) => sum + totals.sourceBytes, 0);
    const generationStatus = totalSkippedSourceCount > 0
      ? "partial"
      : "complete";
    writer.writeMeta("status", generationStatus);
    writer.finalizeGeneration({
      status: generationStatus,
      blockReason: generationStatus === "partial"
        ? "codex_rollout_sources_quarantined"
        : null,
      discoveredSourceCount: discovery.discoveredSourceCount,
      discoveredSourceBytes: sourceBytes,
      indexedSourceCount: Number(indexedSources.count),
      indexedSourceBytes: Number(indexedSources.bytes),
      skippedSourceCount: totalSkippedSourceCount,
      skippedSourceBytes: totalSkippedSourceBytes,
      skippedThreadCount: skippedThreadLocals.size,
      discoveryComplete: true,
      diagnosticsComplete: true,
    });
    const generationDescriptor = readUnifiedIndexGenerationDescriptor(
      database,
      generation.generationId,
    );
    const closed = await writer.close({
      integrityCheck: true,
      fsyncPath: null,
      windowsSqliteStateStaging,
      windowsQualificationModeContext,
      windowsFilesystemAdapter,
      stateRoot,
      resourceRoot,
    });
    await publishStagedUnifiedIndex(stageFile, resolvedIndexFile, {
      windowsSqliteStateStaging,
      expectedTargetIdentity,
      windowsQualificationModeContext,
      windowsFilesystemAdapter,
      stateRoot,
      resourceRoot,
    });
    return {
      status: "built",
      indexFile: resolvedIndexFile,
      generation: generationDescriptor,
      generationDescriptor,
      ...diagnostics,
      ...sink.counts,
      batches: closed.batches,
      workerCount,
      discoveryWallMs: discoveredAt - startedAt,
      scanWallMs: scannedAt - discoveredAt,
      wallMs: performance.now() - startedAt,
      peakRssBytes: process.memoryUsage.rss(),
    };
  } catch (error) {
    try {
      writer?.failGeneration(error?.code === "local_unified_index_aborted"
        ? "aborted"
        : "exception");
    } catch {
      // The staging file is discarded below; an uncommitted generation cannot
      // affect the live publication.
    }
    try {
      database?.close();
    } catch {
      // The connection may already be closed by the writer.
    }
    await removeIfPresent(stageFile, {
      windowsSqliteStateStaging,
      windowsQualificationModeContext,
      windowsFilesystemAdapter,
      stateRoot,
      resourceRoot,
    });
    throw error;
  }
}

export function defaultRebuildWorkerCount() {
  return Math.min(MAXIMUM_WORKERS, Math.max(1, availableParallelism() - 2));
}

export function rebuildSourceLabel(info) {
  return basename(dirname(info.path));
}
