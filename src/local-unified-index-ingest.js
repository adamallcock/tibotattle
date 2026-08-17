import { resolve } from "node:path";

import { discoverCodexRolloutInfos } from "./codex-log-scan.js";
import {
  createLineageSnapshots,
  extractRolloutUsage,
  inheritedTierSeed,
  ownObservedTier,
} from "./local-unified-index-extract.js";
import {
  createEventSink,
  lineageComponents,
  persistingCollector,
  surfaceRow,
  writeCursorForOutcome,
} from "./local-unified-index-build.js";
import {
  createUnifiedIndexWriter,
  defaultLocalUnifiedIndexPath,
  defaultLocalUnifiedIndexSecretPath,
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  openLocalUnifiedIndex,
  readOrCreateDeviceSalt,
  sessionLocal,
  snapshotLocal,
  sourceLocal,
} from "./local-unified-index.js";

// Incremental ingest: advance the live unified index by exactly the bytes the
// rollout corpus grew since the last pass.
//
// A cold rebuild reads the whole 79 GiB corpus in one run, which is fine once
// and absurd per refresh. This path resumes from per-source cursors — the
// same shape as the collector's checkpoint — so an ordinary pass reads only
// appended bytes plus whatever sources are new.
//
// Two facts make resuming SAFE rather than merely cheap:
//
//   1. Event keys are deterministic over (session, byte offset, observed-at),
//      so a crash between committing events and committing their cursor costs
//      one re-scan that re-inserts identical keys into `ON CONFLICT DO
//      NOTHING`. Nothing is ever double-counted.
//   2. The fork-replay boundary's ancestor snapshot sets are persisted
//      (`lineage_snapshot`, salted digests). The in-memory-only design was
//      recorded as valid strictly for one-pass rebuilds; an incremental pass
//      must answer for ancestors it is not currently scanning, and the
//      persisted sets are what answers.
//
// Memory stays bounded regardless of corpus or file size: the bounded-line
// cap governs the read, commit batches govern the write, and in-memory
// snapshot sets exist only for sources actually scanned in this pass, one
// lineage component at a time.

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function loadCursors(database) {
  const cursors = new Map();
  // The cursor's ingest run names the parser version its rows were derived
  // under. A LEFT JOIN keeps a cursor loadable even if its run row is somehow
  // missing; a NULL parser_version then reads as "unknown", which classifies
  // as a forced rescan — the safe direction.
  const rows = database.prepare(`
    SELECT sc.source_local, sc.session_local, sc.scanned_bytes, sc.size_bytes,
           sc.mtime_ms, sc.snapshots_persisted, sc.turn_context_seen,
           sc.carry_model, sc.carry_effort, sc.carry_tier_raw,
           sc.carry_tier_observed_at_ms, sc.carry_total_input,
           sc.carry_total_cached, sc.carry_total_cache_write,
           sc.carry_total_output, sc.carry_total_reasoning,
           sc.carry_total_total, cs.compacted_at_ms,
           cs.source_offset AS compaction_source_offset,
           cs.turn_context_pending,
           pv.parser_version AS parser_version
    FROM source_cursor sc
    LEFT JOIN source_boundary_state cs ON cs.source_local = sc.source_local
    LEFT JOIN ingest_run ir ON ir.id = sc.ingest_run_id
    LEFT JOIN parser_version pv ON pv.id = ir.parser_version_id`).all();
  for (const row of rows) {
    cursors.set(Buffer.from(row.source_local).toString("hex"), row);
  }
  return cursors;
}

function carriedTotals(cursor) {
  const totals = {
    input_tokens: cursor.carry_total_input,
    cached_input_tokens: cursor.carry_total_cached,
    cache_write_input_tokens: cursor.carry_total_cache_write,
    output_tokens: cursor.carry_total_output,
    reasoning_output_tokens: cursor.carry_total_reasoning,
    total_tokens: cursor.carry_total_total,
  };
  for (const value of Object.values(totals)) {
    if (!Number.isSafeInteger(Number(value))) return null;
  }
  return Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [key, Number(value)]),
  );
}

function carriedTier(cursor) {
  const observedAtMs = cursor.carry_tier_observed_at_ms;
  if (observedAtMs === null) return null;
  return {
    providerTierRaw: cursor.carry_tier_raw ?? null,
    observedAtMs: Number(observedAtMs),
  };
}

function carriedCompaction(cursor) {
  if (cursor.compacted_at_ms === null || cursor.compaction_source_offset === null) {
    return null;
  }
  const observedAtMs = Number(cursor.compacted_at_ms);
  const sourceOffset = Number(cursor.compaction_source_offset);
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0
      || !Number.isSafeInteger(sourceOffset) || sourceOffset < 0) {
    return null;
  }
  return { observedAtMs, sourceOffset };
}

function carriedTurnContextPending(cursor) {
  return Number(cursor.turn_context_pending ?? 0) === 1;
}

/**
 * Decide what this pass has to do for one source.
 *
 * - `skip`: nothing appended, cursor already current.
 * - `touch`: nothing appended but the file was touched; refresh the cursor's
 *   change-detection fields without reading a byte.
 * - `resume`: the file grew; scan from the cursor with carried state.
 * - `rescan`: no cursor, or the file shrank (rotation/truncation), or the
 *   cursor was stamped by an older parser version (`reason:
 *   "parser_version"`) — the stored rows may be poisoned by the old
 *   derivation, so the whole file is re-derived and its old rows replaced.
 */
export function classifySource(info, cursor, expectedParserVersion = null) {
  const size = Number(info.size ?? 0);
  // Cursors store whole milliseconds; filesystems report fractions. Compare
  // at the stored precision or every unchanged file reads as touched.
  const mtimeMs = Math.floor(Number(info.mtimeMs ?? 0));
  if (cursor === undefined) return { mode: "rescan" };
  if (expectedParserVersion !== null
      && cursor.parser_version !== expectedParserVersion) {
    return { mode: "rescan", reason: "parser_version" };
  }
  const cursorSize = Number(cursor.size_bytes);
  const cursorMtime = Number(cursor.mtime_ms);
  if (size === cursorSize) {
    return mtimeMs === cursorMtime ? { mode: "skip" } : { mode: "touch" };
  }
  if (size > cursorSize) return { mode: "resume" };
  return { mode: "rescan", reason: "shrink" };
}

/**
 * Advance the live unified index incrementally. Returns measured counts and
 * timings; `usageEvents` counts only rows actually inserted by this pass.
 */
export async function ingestLocalUnifiedIndexIncrement({
  codexHome,
  indexFile = defaultLocalUnifiedIndexPath(),
  secretFile = null,
  contractVersion,
  startAt = "1970-01-01T00:00:00.000Z",
  endAt = null,
  commitRows = 10_000,
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
  const startedAt = performance.now();
  const resolvedIndexFile = resolve(indexFile);
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

  const database = openLocalUnifiedIndex(resolvedIndexFile, {
    readOnly: false,
    create: true,
  });
  let writer = null;
  try {
    const cursors = loadCursors(database);
    const selectLineageSnapshot = database.prepare(`
      SELECT 1 AS present FROM lineage_snapshot
      WHERE session_local = ? AND snapshot_local = ? LIMIT 1`);
    writer = createUnifiedIndexWriter(database, {
      commitRows,
      contractVersion,
    });
    const accountScopeId = writer.internAccountScope({
      status: "unavailable",
      reason: "missing_account",
      planType: null,
      scopeLocal: null,
    });
    const sink = createEventSink({
      writer,
      deviceSalt,
      accountScopeId,
      onCounts: null,
    });
    const countSourceBoundaries = database.prepare(`
      SELECT COUNT(*) AS count
      FROM usage_event_boundary boundary
      JOIN usage_event event
        ON event.event_key = boundary.current_event_key
      WHERE event.source_id = ?`);
    const deleteSourceUsage = database.prepare(`
      DELETE FROM usage_event WHERE source_id = ?`);

    const diagnostics = {
      sources: infos.length,
      sourcesSkipped: 0,
      sourcesTouched: 0,
      sourcesResumed: 0,
      sourcesRescanned: 0,
      sourcesReparsedForParserVersion: 0,
      usageRowsDeletedForReparse: 0,
      boundaryRowsDeletedForReparse: 0,
      usageRowsDeletedForSourceRescan: 0,
      boundaryRowsDeletedForSourceRescan: 0,
      sourcesScanned: 0,
      bytesScanned: 0,
      relevantLines: 0,
      malformedLines: 0,
      partialLines: 0,
      salvagedRecords: 0,
      compactionEvents: 0,
      oversizedLines: 0,
      forkReplayEventsSkipped: 0,
      unattributedForkReplayEventsSkipped: 0,
      cumulativeCounterRegressions: 0,
      lineageSnapshotLookups: 0,
      peakRetainedSnapshotKeys: 0,
    };

    const bySessionId = new Map();
    for (const info of infos) {
      if (info.lineage?.sessionId) bySessionId.set(info.lineage.sessionId, info);
    }
    const sessionLocals = new Map();
    const localForSession = (sessionId) => {
      let cached = sessionLocals.get(sessionId);
      if (cached === undefined) {
        cached = sessionLocal(deviceSalt, sessionId);
        // The raw session UUID travels in v1.0 contribution records (owner
        // decision). The writer refuses anything that is not UUID-shaped, so
        // a rollout-key fallback id is never recorded.
        writer.recordSessionIdentity(cached, sessionId);
        sessionLocals.set(sessionId, cached);
      }
      return cached;
    };
    // Final carried state for sources scanned in THIS pass, keyed by session
    // id, so a child scanned after its parent seeds from the freshest values.
    const finalBySessionId = new Map();

    // Parser-version healing. A cursor stamped by an older parser version
    // names a source whose stored rows were derived by the old (possibly
    // poisoned) logic. Re-derived rows share their event keys with the old
    // ones — the key is (session, byte offset, observed-at), not the token
    // values — so `ON CONFLICT DO NOTHING` would silently keep the poison.
    // Delete those sessions' rows up front, before anything is scanned, so
    // the forced whole-file rescans below re-insert clean values. Rows whose
    // rollout files have rotated away have no discovered source here and are
    // untouched, exactly as the parser-version design records.
    {
      const deleteSessionUsage = database.prepare(
        "DELETE FROM usage_event WHERE session_local = ?",
      );
      const deleteSessionBoundaries = database.prepare(
        "DELETE FROM usage_event_boundary WHERE session_local = ?",
      );
      const healedSessions = new Set();
      for (const info of infos) {
        const cursor = cursors.get(
          sourceLocal(deviceSalt, info.rolloutKey).toString("hex"),
        );
        if (cursor === undefined) continue;
        if (cursor.parser_version === LOCAL_UNIFIED_INDEX_PARSER_VERSION) {
          continue;
        }
        diagnostics.sourcesReparsedForParserVersion += 1;
        const sessionKey = cursor.session_local === null
          ? localForSession(info.lineage?.sessionId ?? info.rolloutKey)
          : Buffer.from(cursor.session_local);
        const sessionHex = sessionKey.toString("hex");
        if (healedSessions.has(sessionHex)) continue;
        healedSessions.add(sessionHex);
        diagnostics.boundaryRowsDeletedForReparse +=
          Number(deleteSessionBoundaries.run(sessionKey).changes ?? 0);
        diagnostics.usageRowsDeletedForReparse +=
          Number(deleteSessionUsage.run(sessionKey).changes ?? 0);
      }
    }

    function seedForNew(info) {
      const parentId = info.lineage?.parentId;
      if (!parentId) return { seedModel: null, seedEffort: null };
      const scanned = finalBySessionId.get(parentId);
      if (scanned !== undefined) {
        return { seedModel: scanned.model, seedEffort: scanned.effort };
      }
      const parent = bySessionId.get(parentId);
      if (parent === undefined) return { seedModel: null, seedEffort: null };
      const cursor = cursors.get(
        sourceLocal(deviceSalt, parent.rolloutKey).toString("hex"),
      );
      if (cursor === undefined) return { seedModel: null, seedEffort: null };
      return {
        seedModel: cursor.carry_model ?? null,
        seedEffort: cursor.carry_effort ?? null,
      };
    }

    // Lineage speed carry-forward (design: composition-aware-expected-line
    // §4). Walk the fork/parent ancestor chain nearest-first and seed the
    // child's initial tier from the first ancestor whose final tier is known —
    // this pass's freshest derived state when the ancestor was scanned here,
    // its persisted cursor otherwise. Strictly lineage-scoped: only the chain
    // named by `lineage.parentId` is ever consulted, never concurrent
    // unrelated threads — Codex `service_tier` is per-thread, and a global
    // "most recent switch anywhere" carry would mislabel the majority of Fast
    // sessions. No reachable declaration anywhere up the chain leaves the
    // seed null and the child's turns unobserved.
    function lineageSeedTier(info) {
      const seen = new Set();
      let parentId = info.lineage?.parentId ?? null;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const scanned = finalBySessionId.get(parentId);
        if (scanned !== undefined) {
          // Freshly scanned this pass: its final tier already folds in ITS
          // own seed, so a non-null value is the nearest observed
          // declaration. A null keeps walking — harmlessly redundant, since
          // the ancestor's own derivation covered the same chain.
          if (scanned.tier !== null && scanned.tier !== undefined) {
            return inheritedTierSeed(scanned.tier);
          }
        } else {
          const parent = bySessionId.get(parentId);
          const cursor = parent === undefined
            ? undefined
            : cursors.get(
              sourceLocal(deviceSalt, parent.rolloutKey).toString("hex"),
            );
          const carried = cursor === undefined ? null : carriedTier(cursor);
          if (carried !== null) return inheritedTierSeed(carried);
        }
        parentId = bySessionId.get(parentId)?.lineage?.parentId ?? null;
      }
      return null;
    }

    function ancestorSessionLocalsFor(info) {
      const chain = [];
      const seen = new Set();
      let parentId = info.lineage?.parentId ?? null;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        chain.push(localForSession(parentId));
        parentId = bySessionId.get(parentId)?.lineage?.parentId ?? null;
      }
      return chain;
    }

    // Group into lineage components exactly as the rebuild does, so a fork is
    // always processed after its ancestors within one pass.
    for (const component of lineageComponents(infos)) {
      const plans = component.members.map((info) => ({
        info,
        cursor: cursors.get(
          sourceLocal(deviceSalt, info.rolloutKey).toString("hex"),
        ),
      })).map((plan) => ({
        ...plan,
        ...classifySource(
          plan.info,
          plan.cursor,
          LOCAL_UNIFIED_INDEX_PARSER_VERSION,
        ),
      }));
      const planBySessionId = new Map();
      for (const plan of plans) {
        if (plan.info.lineage?.sessionId) {
          planBySessionId.set(plan.info.lineage.sessionId, plan);
        }
      }
      // Fork-boundary durability. A fork about to be scanned checks its
      // ancestors' persisted snapshot sets — but an ancestor scanned before
      // anything forked from it was never asked to collect one. Re-scan such
      // an ancestor once, from the start, so its set becomes durable before
      // the fork reads it. Repeat to a fixpoint because the upgraded ancestor
      // may itself be a fork with unpersisted ancestors.
      for (let changed = true; changed;) {
        changed = false;
        for (const plan of plans) {
          if (plan.mode === "skip" || plan.mode === "touch") continue;
          if (plan.info.lineage?.isFork !== true) continue;
          let parentId = plan.info.lineage?.parentId ?? null;
          const seen = new Set();
          while (parentId && !seen.has(parentId)) {
            seen.add(parentId);
            const ancestor = planBySessionId.get(parentId);
            if (ancestor !== undefined
                && ["skip", "touch", "resume"].includes(ancestor.mode)
                && Number(ancestor.cursor?.snapshots_persisted ?? 0) !== 1) {
              ancestor.mode = "rescan";
              changed = true;
            }
            parentId = bySessionId.get(parentId)?.lineage?.parentId ?? null;
          }
        }
      }
      if (plans.every((plan) => plan.mode === "skip")) {
        diagnostics.sourcesSkipped += plans.length;
        continue;
      }
      const snapshots = createLineageSnapshots(component.members);
      try {
        for (const plan of plans) {
          if (signal?.aborted) throw fixedError("local_unified_index_aborted");
          const { info, cursor, mode } = plan;
          if (mode === "skip") {
            diagnostics.sourcesSkipped += 1;
            continue;
          }
          const sessionId = info.lineage?.sessionId ?? info.rolloutKey;
          const sourceKey = sourceLocal(deviceSalt, info.rolloutKey);
          const state = {
            sessionLocal: localForSession(sessionId),
            sourceLocal: sourceKey,
            sourceId: writer.internSource(sourceKey),
            surface: surfaceRow(info.lineage?.surfaceClassification),
          };
          if (mode === "touch") {
            diagnostics.sourcesTouched += 1;
            writeCursorForOutcome(writer, deviceSalt, info, state, {
              nextOffset: Number(cursor.scanned_bytes),
              finalModel: cursor.carry_model ?? null,
              finalEffort: cursor.carry_effort ?? null,
              finalTierRaw: cursor.carry_tier_raw ?? null,
              finalTierObservedAtMs: cursor.carry_tier_observed_at_ms === null
                ? null
                : Number(cursor.carry_tier_observed_at_ms),
              finalTotals: carriedTotals(cursor),
              finalCompactionPending: carriedCompaction(cursor),
              finalTurnContextPending: carriedTurnContextPending(cursor),
              turnContextSeen: Number(cursor.turn_context_seen) === 1,
              snapshotsPersisted: Number(cursor.snapshots_persisted) === 1,
            });
            continue;
          }
          // A same-parser shrink means bytes previously indexed from this
          // exact source no longer exist. Deterministic re-insertion replaces
          // rows that remain, but it cannot collide with (and therefore
          // remove) a truncated tail. Delete only rows owned by this interned
          // salted source before the whole-file rescan; boundary links cascade
          // from usage_event. Parser-version healing is session-wide
          // above and therefore does not enter this branch.
          if (plan.reason === "shrink") {
            diagnostics.boundaryRowsDeletedForSourceRescan += Number(
              countSourceBoundaries.get(state.sourceId)?.count ?? 0,
            );
            diagnostics.usageRowsDeletedForSourceRescan += Number(
              deleteSourceUsage.run(state.sourceId).changes ?? 0,
            );
          }
          const resuming = mode === "resume";
          const seed = resuming
            ? {
              seedModel: cursor.carry_model ?? null,
              seedEffort: cursor.carry_effort ?? null,
            }
            : seedForNew(info);
          const memoryInherited = snapshots.inheritedFor(info);
          const ancestors = info.lineage?.isFork === true
            ? ancestorSessionLocalsFor(info)
            : [];
          const inherited = ancestors.length === 0
            ? memoryInherited
            : {
              has: (key) => {
                if (memoryInherited?.has(key) === true) return true;
                const digest = snapshotLocal(deviceSalt, key);
                diagnostics.lineageSnapshotLookups += 1;
                return ancestors.some((ancestor) => (
                  selectLineageSnapshot.get(ancestor, digest) !== undefined
                ));
              },
            };
          const startOffset = resuming ? Number(cursor.scanned_bytes) : 0;
          const collector = snapshots.collectorFor(info);
          const outcome = await extractRolloutUsage(info.path, {
            size: Number(info.size ?? 0),
            startOffset,
            isFork: info.lineage?.isFork === true,
            inheritedSnapshots: inherited,
            collectSnapshots: persistingCollector(
              collector,
              writer,
              deviceSalt,
              state.sessionLocal,
            ),
            seedModel: seed.seedModel,
            seedEffort: seed.seedEffort,
            // A resumed segment carries its own cursor tier (own-file
            // declarations, still `rollout_thread_settings`). When the cursor
            // carries none — the file never declared, or only ever inherited —
            // the ancestor chain is consulted, exactly as a whole-file rescan
            // would, so provenance survives resume instead of degrading to
            // unobserved.
            seedTier: resuming
              ? carriedTier(cursor) ?? lineageSeedTier(info)
              : lineageSeedTier(info),
            seedTotals: resuming ? carriedTotals(cursor) : null,
            seedCompactionPending: resuming ? carriedCompaction(cursor) : null,
            seedTurnContextPending: resuming
              && carriedTurnContextPending(cursor),
            seedTurnContextSeen: resuming
              && Number(cursor.turn_context_seen) === 1,
            ...(maximumLineBytes === undefined ? {} : { maximumLineBytes }),
            signal,
            onEvent: (event) => sink.write(state, event),
            onBoundary: (event) => sink.writeBoundary(state, event),
          });
          if (info.lineage?.sessionId) {
            finalBySessionId.set(info.lineage.sessionId, {
              model: outcome.finalModel,
              effort: outcome.finalEffort,
              tier: outcome.finalTier,
            });
          }
          writeCursorForOutcome(writer, deviceSalt, info, state, {
            nextOffset: outcome.read.nextOffset,
            finalModel: outcome.finalModel,
            finalEffort: outcome.finalEffort,
            // Only this file's own declarations are carried in the cursor. An
            // inherited seed is re-derived from the ancestor chain on the
            // next pass, so `lineage_inherited` provenance is never laundered
            // into an own observation by a resume.
            finalTierRaw: ownObservedTier(outcome.finalTier)?.providerTierRaw ?? null,
            finalTierObservedAtMs: ownObservedTier(outcome.finalTier)?.observedAtMs ?? null,
            finalTotals: outcome.finalTotals,
            finalCompactionPending: outcome.finalCompactionPending,
            finalTurnContextPending: outcome.finalTurnContextPending,
            turnContextSeen: outcome.finalTurnContextSeen,
            // A whole-file scan makes the collected set durable; a resumed
            // tail keeps whatever durability the earlier scan established.
            snapshotsPersisted: collector !== null
              && (startOffset === 0
                || Number(cursor?.snapshots_persisted ?? 0) === 1),
          });
          diagnostics[resuming ? "sourcesResumed" : "sourcesRescanned"] += 1;
          diagnostics.sourcesScanned += 1;
          diagnostics.bytesScanned +=
            Math.max(0, Number(info.size ?? 0) - startOffset);
          diagnostics.relevantLines += outcome.diagnostics.relevantLines;
          diagnostics.malformedLines += outcome.diagnostics.malformedLines;
          diagnostics.partialLines += outcome.diagnostics.partialLines;
          diagnostics.salvagedRecords += outcome.diagnostics.salvagedRecords;
          diagnostics.compactionEvents += outcome.diagnostics.compactionEvents;
          diagnostics.oversizedLines += outcome.read.oversizedLines;
          diagnostics.forkReplayEventsSkipped
            += outcome.diagnostics.forkReplayEventsSkipped;
          diagnostics.unattributedForkReplayEventsSkipped
            += outcome.diagnostics.unattributedForkReplayEventsSkipped;
          diagnostics.cumulativeCounterRegressions
            += outcome.diagnostics.cumulativeCounterRegressions;
          diagnostics.peakRetainedSnapshotKeys = Math.max(
            diagnostics.peakRetainedSnapshotKeys,
            snapshots.retainedKeys,
          );
          await onProgress?.({
            ...diagnostics,
            usageEvents: sink.counts.usageEvents,
          });
        }
      } finally {
        snapshots.release();
      }
    }

    const scannedAt = performance.now();
    writer.flush();
    const totalUsageEvents = Number(
      database.prepare("SELECT COUNT(*) AS events FROM usage_event").get().events,
    );
    const totalBoundaryLinks = Number(
      database.prepare("SELECT COUNT(*) AS events FROM usage_event_boundary").get().events,
    );
    const sourceBytes = infos.reduce(
      (total, info) => total + Number(info.size ?? 0),
      0,
    );
    writer.writeMeta("source_count", infos.length);
    writer.writeMeta("source_bytes", sourceBytes);
    writer.writeMeta("usage_events", totalUsageEvents);
    writer.writeMeta("boundary_links", totalBoundaryLinks);
    writer.writeMeta("generated_at", new Date().toISOString());
    writer.writeMeta("contract_version", contractVersion);
    writer.writeMeta("status", signal?.aborted ? "partial" : "complete");
    const closed = await writer.close({
      integrityCheck: true,
      fsyncPath: resolvedIndexFile,
    });
    writer = null;
    return {
      status: "ingested",
      indexFile: resolvedIndexFile,
      ...diagnostics,
      ...sink.counts,
      // `usageEvents` above counts write attempts; a resumed pass can re-scan
      // rows it already holds and those land in `ON CONFLICT DO NOTHING`.
      // This is the number of rows this pass actually added.
      insertedUsageEvents: closed.usageRows,
      insertedBoundaryLinks: closed.boundaryRows,
      totalUsageEvents,
      totalBoundaryLinks,
      batches: closed.batches,
      discoveryWallMs: discoveredAt - startedAt,
      scanWallMs: scannedAt - discoveredAt,
      wallMs: performance.now() - startedAt,
      peakRssBytes: process.memoryUsage.rss(),
    };
  } catch (error) {
    if (writer === null && database.isOpen) database.close();
    else if (writer !== null) {
      try {
        database.close();
      } catch {
        // The connection may already be closed.
      }
    }
    throw error;
  }
}
