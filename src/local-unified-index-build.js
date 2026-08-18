import { availableParallelism } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  createLeadingRateLimitGate,
  discoverCodexRolloutInfos,
} from "./codex-log-scan.js";
import { recognizedExportModelId } from "./export/index.js";
import {
  createLineageSnapshots,
  extractRolloutUsage,
  inheritedTierSeed,
  ownObservedTier,
} from "./local-unified-index-extract.js";
import {
  assertSafeLocalUnifiedIndexTarget,
  createUnifiedIndexWriter,
  createLocalUnifiedIndexSecondaryIndexes,
  beginUnifiedIndexGeneration,
  recoverUnifiedIndexGenerations,
  defaultLocalUnifiedIndexPath,
  defaultLocalUnifiedIndexSecretPath,
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

const CODEX_BILLING_SURFACE = "chatgpt_subscription";

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
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
  const bySessionId = new Map();
  for (const info of infos) {
    if (info.lineage?.sessionId) bySessionId.set(info.lineage.sessionId, info);
  }
  const componentOf = new Map();
  const components = [];

  function rootOf(info, seen = new Set()) {
    const parentId = info.lineage?.parentId;
    if (!parentId || seen.has(parentId)) return info;
    const parent = bySessionId.get(parentId);
    if (!parent) return info;
    seen.add(parentId);
    return rootOf(parent, seen);
  }

  for (const info of infos) {
    const root = rootOf(info);
    let component = componentOf.get(root);
    if (component === undefined) {
      component = { root, members: [], bytes: 0 };
      componentOf.set(root, component);
      components.push(component);
    }
    component.members.push(info);
    component.bytes += Number(info.size ?? 0);
  }
  // `infos` already arrives sorted parent-before-child by lineage depth, so
  // member order within a component is preserved by the push above.
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
}) {
  writer.writeSourceCursor({
    sourceLocal: sourceLocal(deviceSalt, info.rolloutKey),
    sourceOrdinal: state.sourceOrdinal ?? null,
    sessionLocal: state.sessionLocal,
    scannedBytes: nextOffset,
    sizeBytes: Number(info.size ?? 0),
    mtimeMs: Number.isSafeInteger(info.mtimeMs)
      ? info.mtimeMs
      : Math.floor(Number(info.mtimeMs ?? 0)),
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

function eventKeyFor(deviceSalt, sessionLocalKey, sourceOffset, observedAtMs) {
  // 32 raw bytes, deterministic, content-free, and stable across rebuilds: the
  // same (session, byte offset) always produces the same key, so a rerun is
  // idempotent rather than duplicating history. The old key was 64 hex
  // characters of SHA-256 over a JSON re-encoding of the entire record, which
  // meant every stored field had to be reproduced byte-for-byte to recompute
  // it.
  return localDigest(
    deviceSalt,
    "unified-index-event",
    `${sessionLocalKey.toString("hex")}\0${sourceOffset}\0${observedAtMs}`,
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
    if (admission === "admitted") counts.quotaOccurrences += 1;
  }

  return {
    counts,
    write(source, event) {
      const declaration = modelDeclaration(event.model);
      if (declaration.recognition === "missing") counts.modelMissing += 1;
      if (declaration.recognition === "unrecognized") counts.modelUnrecognized += 1;
      if (event.partial) counts.partialEvents += 1;
      let quotaObservationId = null;
      const gate = gateFor(source);
      for (const [slotOrder, window] of event.quota.entries()) {
        const id = writer.internQuota(window);
        counts.quotaObservations += 1;
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
          counts.contradictedLeadingSnapshotsSkipped += 1;
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
          source.sessionLocal,
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
      counts.usageEvents += 1;
      if (counts.usageEvents % 50_000 === 0) onCounts?.(counts);
    },
    writeBoundary(source, event) {
      writer.writeUsageEventBoundary({
        currentEventKey: eventKeyFor(
          deviceSalt,
          source.sessionLocal,
          event.currentSourceOffset,
          event.currentObservedAtMs,
        ),
        compactionBefore: event.compactionBefore,
        turnContextBefore: event.turnContextBefore,
        compactedAtMs: event.compactedAtMs,
        sessionLocal: source.sessionLocal,
      });
      counts.boundaryLinks += 1;
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
      counts.toolEvents += inserted;
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
  };
}

async function runWorkerLane(lane, laneIndex, { maximumLineBytes, signal, onBatch }) {
  return new Promise((settle, fail) => {
    const worker = new Worker(
      new URL("./local-unified-index-worker.js", import.meta.url),
      {
        workerData: {
          maximumLineBytes,
          components: lane.components.map((members) => members.map((info) => ({
            path: info.path,
            size: Number(info.size ?? 0),
            sessionId: info.lineage?.sessionId ?? null,
            parentId: info.lineage?.parentId ?? null,
            isFork: info.lineage?.isFork === true,
            rolloutKey: info.rolloutKey,
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
  signal = null,
  onProgress = null,
  discoveryLimits = null,
} = {}) {
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
  const startedAt = performance.now();
  const resolvedIndexFile = resolve(indexFile);
  await assertSafeLocalUnifiedIndexTarget(resolvedIndexFile, {
    allowMissing: true,
  });
  const deviceSalt = await readOrCreateDeviceSalt(
    secretFile ?? defaultLocalUnifiedIndexSecretPath(resolvedIndexFile),
  );
  const infos = await discoverCodexRolloutInfos({
    codexHome,
    startAt,
    endAt,
    signal,
    discoveryLimits,
  });
  const discoveredAt = performance.now();
  const sourceBytes = infos.reduce((total, info) => total + Number(info.size ?? 0), 0);

  const stageFile = `${resolvedIndexFile}.building-${process.pid}-${Date.now().toString(36)}`;
  await removeIfPresent(stageFile);
  let database = null;
  let generation = null;
  let writer = null;
  let sink = null;
  try {
    database = openLocalUnifiedIndex(stageFile, {
      readOnly: false,
      create: true,
      staging: true,
      deferSecondaryIndexes,
    });
    recoverUnifiedIndexGenerations(database);
    generation = beginUnifiedIndexGeneration(database, {
      contractVersion,
      discoveredSourceCount: infos.length,
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
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the setup failure; the incomplete stage is discarded below.
    }
    await removeIfPresent(stageFile);
    throw error;
  }
  const diagnostics = {
    sources: infos.length,
    sourceBytes,
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

  const sourceOrdinals = new Map(
    infos.map((info, ordinal) => [info.rolloutKey, ordinal]),
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
      const local = sourceLocal(deviceSalt, info.rolloutKey);
      const surface = surfaceRow(info.lineage?.surfaceClassification);
      state = {
        sessionLocal: sessionLocal(deviceSalt, sessionId),
        sourceLocal: local,
        sourceId: writer.internSource(local),
        sourceOrdinal: sourceOrdinals.get(info.rolloutKey),
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

  const bySessionId = new Map();
  for (const info of infos) {
    if (info.lineage?.sessionId) bySessionId.set(info.lineage.sessionId, info);
  }
  function seedFor(info) {
    const none = { seedModel: null, seedEffort: null, seedTier: null };
    const parentId = info.lineage?.parentId;
    if (!parentId) return none;
    const parent = bySessionId.get(parentId);
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
            const seed = seedFor(info);
            if (seed.seedModel !== null) diagnostics.modelSeededFromLineage += 1;
            const collector = snapshots.collectorFor(info);
            const outcome = await extractRolloutUsage(info.path, {
              size: Number(info.size ?? 0),
              isFork: info.lineage?.isFork === true,
              inheritedSnapshots: snapshots.inheritedFor(info),
              collectSnapshots: persistingCollector(
                collector,
                writer,
                deviceSalt,
                state.sessionLocal,
              ),
              seedModel: seed.seedModel,
              seedEffort: seed.seedEffort,
              seedTier: seed.seedTier,
              maximumLineBytes,
              signal,
              onEvent: (event) => sink.write(state, event),
              onBoundary: (event) => sink.writeBoundary(state, event),
              onTool: (event) => sink.writeTool(state, event),
            });
            state.finalModel = outcome.finalModel;
            state.finalEffort = outcome.finalEffort;
            state.finalTier = outcome.finalTier;
            sink.finishSource(state);
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
            writer.writeSourceDiagnostics(state.sourceLocal, {
              ...outcome.diagnostics,
              oversizedLines: outcome.read.oversizedLines,
              ...sink.diagnosticsForSource(state),
            });
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
            diagnostics.sourcesScanned += 1;
            diagnostics.bytesScanned += Number(info.size ?? 0);
            accumulate(diagnostics, outcome.diagnostics, outcome.read.oversizedLines);
            diagnostics.peakRetainedSnapshotKeys = Math.max(
              diagnostics.peakRetainedSnapshotKeys,
              snapshots.retainedKeys,
            );
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
            if (message.cursor) {
              writeCursorForOutcome(
                writer,
                deviceSalt,
                info,
                state,
                message.cursor,
              );
            }
            writer.writeSourceDiagnostics(state.sourceLocal, {
              ...message.diagnostics,
              oversizedLines: message.diagnostics.oversizedLines,
              ...sink.diagnosticsForSource(state),
            });
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
            if (message.diagnostics.seeded) diagnostics.modelSeededFromLineage += 1;
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
    writer.writeMeta("source_count", infos.length);
    writer.writeMeta("source_bytes", sourceBytes);
    writer.writeMeta("usage_events", sink.counts.usageEvents);
    writer.writeMeta("boundary_links", sink.counts.boundaryLinks);
    writer.writeMeta("generated_at", new Date().toISOString());
    writer.writeMeta("contract_version", contractVersion);
    if (signal?.aborted) throw fixedError("local_unified_index_aborted");
    writer.writeMeta("status", "complete");
    writer.finalizeGeneration({
      status: "complete",
      discoveredSourceCount: infos.length,
      discoveredSourceBytes: sourceBytes,
      indexedSourceCount: infos.length,
      indexedSourceBytes: sourceBytes,
      discoveryComplete: true,
      diagnosticsComplete: true,
    });
    const generationDescriptor = readUnifiedIndexGenerationDescriptor(
      database,
      generation.generationId,
    );
    const closed = await writer.close({ integrityCheck: true, fsyncPath: null });
    await publishStagedUnifiedIndex(stageFile, resolvedIndexFile);
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
    await removeIfPresent(stageFile);
    throw error;
  }
}

export function defaultRebuildWorkerCount() {
  return Math.min(MAXIMUM_WORKERS, Math.max(1, availableParallelism() - 2));
}

export function rebuildSourceLabel(info) {
  return basename(dirname(info.path));
}
