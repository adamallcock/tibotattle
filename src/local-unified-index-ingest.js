import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
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
  rebuildLocalUnifiedIndex,
  surfaceRow,
  writeCursorForOutcome,
} from "./local-unified-index-build.js";
import {
  assertSafeLocalUnifiedIndexTarget,
  createUnifiedIndexWriter,
  beginUnifiedIndexGeneration,
  defaultLocalUnifiedIndexPath,
  defaultLocalUnifiedIndexSecretPath,
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
  LOCAL_UNIFIED_INDEX_USER_VERSION,
  openLocalUnifiedIndex,
  publishStagedUnifiedIndex,
  recoverUnifiedIndexGenerations,
  readOrCreateDeviceSalt,
  readUnifiedIndexGenerationDescriptor,
  removeIfPresent,
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
    SELECT sc.source_local, sc.source_ordinal, sc.session_local,
           sc.scanned_bytes, sc.size_bytes,
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
    return mtimeMs === cursorMtime
      ? { mode: "skip" }
      : { mode: "rescan", reason: "same_size_changed" };
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
  const sourceBytes = infos.reduce(
    (total, info) => total + Number(info.size ?? 0),
    0,
  );
  let coldRebuildReason = null;
  // Read-only preflight avoids cloning/publishing when every current source
  // is byte-for-byte unchanged. A same-size mtime change is deliberately a
  // rescan (classifySource's conservative race policy), so this reads no
  // rollout body bytes and still catches replacement files.
  if (!signal?.aborted) {
    let unchangedDatabase = null;
    try {
      unchangedDatabase = openLocalUnifiedIndex(resolvedIndexFile, { readOnly: true });
      const schema = unchangedDatabase.prepare(
        "SELECT value FROM meta WHERE key = 'schema_version'",
      ).get()?.value;
      const userVersion = Number(
        unchangedDatabase.prepare("PRAGMA user_version").get()?.user_version,
      );
      if (schema !== LOCAL_UNIFIED_INDEX_SCHEMA_VERSION
          || userVersion !== LOCAL_UNIFIED_INDEX_USER_VERSION) {
        coldRebuildReason = "legacy_schema";
      }
      const storedContract = unchangedDatabase.prepare(
        "SELECT value FROM meta WHERE key = 'contract_version'",
      ).get()?.value;
      if (coldRebuildReason === null && storedContract !== contractVersion) {
        coldRebuildReason = "contract_changed";
      }
      if (coldRebuildReason === null
          && schema === LOCAL_UNIFIED_INDEX_SCHEMA_VERSION
          && storedContract === contractVersion) {
        const cursors = loadCursors(unchangedDatabase);
        const descriptor = readUnifiedIndexGenerationDescriptor(
          unchangedDatabase,
        );
        if (descriptor !== null && (
          descriptor.status !== "complete"
          || descriptor.discoveryComplete !== true
          || descriptor.diagnosticsComplete !== true
          || descriptor.usageProvenanceComplete !== true
          || descriptor.sourceOrderComplete !== true
          || descriptor.quotaProvenanceComplete !== true
          || descriptor.toolProvenanceComplete !== true
        )) {
          coldRebuildReason = "incomplete_generation";
        }
        if (coldRebuildReason === null && descriptor !== null) {
          const unattestedSources = Number(unchangedDatabase.prepare(`
            SELECT (
              (SELECT COUNT(*) FROM source_cursor sc
               WHERE NOT EXISTS (
                 SELECT 1 FROM generation_source gs
                 WHERE gs.generation_id = ?
                   AND gs.source_local = sc.source_local))
              +
              (SELECT COUNT(*) FROM usage_event u
               WHERE u.source_local IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM generation_source gs
                 WHERE gs.generation_id = ?
                   AND gs.source_local = u.source_local))
              +
              (SELECT COUNT(*) FROM quota_occurrence q
               WHERE NOT EXISTS (
                 SELECT 1 FROM generation_source gs
                 WHERE gs.generation_id = ?
                   AND gs.source_local = q.source_local))
              +
              (SELECT COUNT(*) FROM usage_event u
               WHERE u.source_local IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM source_cursor sc
                 WHERE sc.source_local = u.source_local))
              +
              (SELECT COUNT(*) FROM quota_occurrence q
               WHERE NOT EXISTS (
                 SELECT 1 FROM source_cursor sc
                 WHERE sc.source_local = q.source_local))
            ) AS count`).get(
            descriptor.id,
            descriptor.id,
            descriptor.id,
          )?.count ?? 0);
          if (unattestedSources > 0) {
            coldRebuildReason = "source_attestation_incomplete";
          }
        }
        const generationAuthoritative = descriptor?.status === "complete"
          && descriptor.discoveryComplete === true
          && descriptor.diagnosticsComplete === true
          && descriptor.usageProvenanceComplete === true
          && descriptor.sourceOrderComplete === true
          && descriptor.quotaProvenanceComplete === true
          && descriptor.toolProvenanceComplete === true;
        const sourceSetUnchanged = descriptor?.discoveredSourceCount
            === infos.length
          && descriptor?.discoveredSourceBytes === sourceBytes;
        const unchanged = generationAuthoritative
          && sourceSetUnchanged
          && infos.every((info) => classifySource(
            info,
            cursors.get(
              sourceLocal(deviceSalt, info.rolloutKey).toString("hex"),
            ),
            LOCAL_UNIFIED_INDEX_PARSER_VERSION,
          ).mode === "skip");
        if (unchanged) {
          const totalBoundaryLinks = Number(
            unchangedDatabase.prepare(
              "SELECT COUNT(*) AS count FROM usage_event_boundary",
            ).get()?.count ?? 0,
          );
          return {
            status: "ingested",
            unchanged: true,
            indexFile: resolvedIndexFile,
            generation: descriptor,
            generationDescriptor: descriptor,
            sources: infos.length,
            sourceBytes,
            sourcesSkipped: infos.length,
            sourcesTouched: 0,
            sourcesResumed: 0,
            sourcesRescanned: 0,
            sourcesReparsedForParserVersion: 0,
            usageRowsDeletedForReparse: 0,
            sourcesScanned: 0,
            bytesScanned: 0,
            insertedUsageEvents: 0,
            insertedBoundaryLinks: 0,
            totalUsageEvents: descriptor.usageEvents ?? 0,
            totalBoundaryLinks,
            quotaOccurrences: descriptor.quotaOccurrences ?? 0,
            discoveryWallMs: discoveredAt - startedAt,
            scanWallMs: 0,
            wallMs: performance.now() - startedAt,
            peakRssBytes: process.memoryUsage.rss(),
          };
        }
      }
    } catch {
      // The normal staged path handles missing/legacy indexes and any cursor
      // shape mismatch. Preflight is an optimization, never a gate.
    } finally {
      unchangedDatabase?.close();
    }
  }
  if (coldRebuildReason !== null) {
    const rebuilt = await rebuildLocalUnifiedIndex({
      codexHome,
      indexFile: resolvedIndexFile,
      secretFile: secretFile
        ?? defaultLocalUnifiedIndexSecretPath(resolvedIndexFile),
      startAt,
      endAt,
      contractVersion,
      workerCount: 1,
      commitRows,
      maximumLineBytes,
      signal,
      onProgress,
      discoveryLimits,
    });
    return {
      ...rebuilt,
      status: "ingested",
      unchanged: false,
      rebuilt: true,
      rebuildReason: coldRebuildReason,
      sourcesSkipped: 0,
      sourcesTouched: 0,
      sourcesResumed: 0,
      sourcesRescanned: rebuilt.sourcesScanned,
      sourcesReparsedForParserVersion: 0,
      usageRowsDeletedForReparse: 0,
      quotaOccurrenceRowsDeletedForRescan: 0,
      insertedUsageEvents: rebuilt.usageEvents,
      insertedBoundaryLinks: rebuilt.boundaryLinks ?? 0,
      totalUsageEvents: rebuilt.usageEvents,
      totalBoundaryLinks: rebuilt.boundaryLinks ?? 0,
    };
  }
  const stageFile = `${resolvedIndexFile}.incremental-${process.pid}-${Date.now().toString(36)}`;
  await removeIfPresent(stageFile);
  let database = null;
  let writer = null;
  let generation = null;
  try {
    const liveExists = await assertSafeLocalUnifiedIndexTarget(
      resolvedIndexFile,
      { allowMissing: true },
    ) !== null;
    if (liveExists) {
      try {
        await copyFile(
          resolvedIndexFile,
          stageFile,
          constants.COPYFILE_FICLONE ?? 0,
        );
      } catch {
        // APFS clone is the cheap path, but not every filesystem supports it.
        // A regular copy preserves the same atomic publication boundary.
        await copyFile(resolvedIndexFile, stageFile);
      }
    }
    database = openLocalUnifiedIndex(stageFile, {
      readOnly: false,
      create: !liveExists,
      staging: true,
    });
    const previousGenerationValue = database.prepare(
      "SELECT value FROM meta WHERE key = 'current_generation_id'",
    ).get()?.value;
    const previousGenerationId = previousGenerationValue === undefined
      ? null
      : Number(previousGenerationValue);
    recoverUnifiedIndexGenerations(database);
    generation = beginUnifiedIndexGeneration(database, {
      contractVersion,
      discoveredSourceCount: infos.length,
      discoveredSourceBytes: sourceBytes,
    });
    const cursors = loadCursors(database);
    const selectLineageSnapshot = database.prepare(`
      SELECT 1 AS present FROM lineage_snapshot
      WHERE session_local = ? AND snapshot_local = ? LIMIT 1`);
    writer = createUnifiedIndexWriter(database, {
      commitRows,
      contractVersion,
      generationId: generation.generationId,
      parserVersionId: generation.parserVersionId,
      ingestRunId: generation.ingestRunId,
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
      generationId: generation.generationId,
      onCounts: null,
    });
    const countSourceBoundaries = database.prepare(`
      SELECT COUNT(*) AS count
      FROM usage_event_boundary boundary
      JOIN usage_event event
        ON event.event_key = boundary.current_event_key
      WHERE event.source_local = ?`);

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
      quotaOccurrenceRowsDeletedForRescan: 0,
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
    const sourceOrdinals = new Map();
    let nextSourceOrdinal = -1;
    for (const cursor of cursors.values()) {
      const ordinal = Number(cursor.source_ordinal);
      if (Number.isSafeInteger(ordinal) && ordinal >= 0) {
        nextSourceOrdinal = Math.max(nextSourceOrdinal, ordinal);
      }
    }
    for (const info of infos) {
      const sourceKey = sourceLocal(deviceSalt, info.rolloutKey).toString("hex");
      const existing = cursors.get(sourceKey);
      const stored = Number(existing?.source_ordinal);
      if (Number.isSafeInteger(stored) && stored >= 0) {
        sourceOrdinals.set(info.rolloutKey, stored);
      } else {
        // Allocate missing ordinals in deterministic discovery order. The
        // ordinal is only a local ordering token; no path is persisted.
        sourceOrdinals.set(info.rolloutKey, ++nextSourceOrdinal);
      }
    }
    const currentSourceKeys = new Set(infos.map((info) => (
      sourceLocal(deviceSalt, info.rolloutKey).toString("hex")
    )));
    const previousRetainedSource = previousGenerationId === null
      ? null
      : database.prepare(`
        SELECT source_ordinal, session_local, surface_id, status,
               discovered_size_bytes, scanned_bytes, mtime_ms,
               diagnostics_complete
        FROM generation_source
        WHERE generation_id = ? AND source_local = ?`);
    for (const [sourceHex, cursor] of cursors) {
      if (currentSourceKeys.has(sourceHex) || previousRetainedSource === null) {
        continue;
      }
      const sourceKey = Buffer.from(sourceHex, "hex");
      const retained = previousRetainedSource.get(previousGenerationId, sourceKey);
      if (retained === undefined) continue;
      writer.copySourceDiagnostics(sourceKey, previousGenerationId);
      if (cursor.parser_version !== LOCAL_UNIFIED_INDEX_PARSER_VERSION) {
        // This source rotated away before the v8 typed-tool pass could rescan
        // it. Preserve its usage/quota facts, but permanently attest the tool
        // history gap instead of publishing a false zero.
        writer.writeSourceDiagnostics(sourceKey, {
          toolSourceHistoryUnavailable: 1,
        });
      }
      writer.rebindToolFactsForSource(sourceKey);
      writer.writeGenerationSource({
        sourceLocal: sourceKey,
        sourceOrdinal: Number(retained.source_ordinal),
        sessionLocal: retained.session_local === null
          ? cursor.session_local
          : Buffer.from(retained.session_local),
        surfaceId: Number(retained.surface_id),
        status: "skipped",
        discoveredSizeBytes: Number(retained.discovered_size_bytes),
        scannedBytes: Number(retained.scanned_bytes),
        mtimeMs: Number(retained.mtime_ms),
        diagnosticsComplete: Number(retained.diagnostics_complete) === 1,
      });
    }

    const deleteUsageForSource = database.prepare(
      "DELETE FROM usage_event WHERE source_local = ?",
    );
    const affectedQuotaForSource = database.prepare(`
      SELECT DISTINCT canonical_observation_id AS id
      FROM quota_occurrence WHERE source_local = ?`);
    const deleteQuotaForSource = database.prepare(
      "DELETE FROM quota_occurrence WHERE source_local = ?",
    );
    const replacementQuota = database.prepare(`
      SELECT plan_type, used_percent, resets_at_ms, duration_mins
      FROM quota_occurrence WHERE canonical_observation_id = ?
      ORDER BY used_percent DESC, COALESCE(resets_at_ms, -1) DESC, id ASC
      LIMIT 1`);
    const updateCanonicalQuota = database.prepare(`
      UPDATE quota_observation SET plan_type = ?, used_percent = ?,
        resets_at_ms = ?, duration_mins = ? WHERE id = ?`);
    const deleteOrphanQuota = database.prepare(`
      DELETE FROM quota_observation WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM quota_occurrence WHERE canonical_observation_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM usage_event WHERE quota_observation_id = ?)`);
    const deleteLineageSnapshots = database.prepare(
      "DELETE FROM lineage_snapshot WHERE session_local = ?",
    );
    const deleteToolCounts = database.prepare(
      "DELETE FROM tool_class_count WHERE session_local = ?",
    );
    const deleteToolFactsForSource = database.prepare(
      "DELETE FROM tool_class_fact WHERE source_local = ?",
    );
    const resetSessions = new Set();

    function replaceSourceFacts(sourceKey, sessionKey, { parserReparse }) {
      const deletedBoundaries = Number(
        countSourceBoundaries.get(sourceKey)?.count ?? 0,
      );
      const affectedQuotaIds = affectedQuotaForSource.all(sourceKey)
        .map((row) => Number(row.id));
      const deletedUsage = Number(
        deleteUsageForSource.run(sourceKey).changes ?? 0,
      );
      diagnostics.quotaOccurrenceRowsDeletedForRescan += Number(
        deleteQuotaForSource.run(sourceKey).changes ?? 0,
      );
      deleteToolFactsForSource.run(sourceKey);
      for (const quotaId of affectedQuotaIds) {
        const replacement = replacementQuota.get(quotaId);
        if (replacement === undefined) {
          deleteOrphanQuota.run(quotaId, quotaId, quotaId);
        } else {
          updateCanonicalQuota.run(
            replacement.plan_type,
            replacement.used_percent,
            replacement.resets_at_ms,
            replacement.duration_mins,
            quotaId,
          );
        }
      }
      if (parserReparse) {
        diagnostics.sourcesReparsedForParserVersion += 1;
        diagnostics.usageRowsDeletedForReparse += deletedUsage;
        diagnostics.boundaryRowsDeletedForReparse += deletedBoundaries;
      } else {
        diagnostics.usageRowsDeletedForSourceRescan += deletedUsage;
        diagnostics.boundaryRowsDeletedForSourceRescan += deletedBoundaries;
      }
      const sessionHex = sessionKey.toString("hex");
      if (!resetSessions.has(sessionHex)) {
        resetSessions.add(sessionHex);
        deleteLineageSnapshots.run(sessionKey);
        deleteToolCounts.run(sessionKey);
      }
    }

    const replacementReasons = new Set([
      "parser_version",
      "same_size_changed",
      "shrink",
    ]);
    const replacementSessionIds = new Set();
    for (const info of infos) {
      const cursor = cursors.get(
        sourceLocal(deviceSalt, info.rolloutKey).toString("hex"),
      );
      const classification = classifySource(
        info,
        cursor,
        LOCAL_UNIFIED_INDEX_PARSER_VERSION,
      );
      if (cursor !== undefined && replacementReasons.has(classification.reason)) {
        replacementSessionIds.add(
          info.lineage?.sessionId ?? info.rolloutKey,
        );
      }
    }
    for (const sessionId of replacementSessionIds) {
      const sessionKey = localForSession(sessionId);
      resetSessions.add(sessionKey.toString("hex"));
      deleteLineageSnapshots.run(sessionKey);
      deleteToolCounts.run(sessionKey);
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
      })).map((plan) => (
        replacementSessionIds.has(
          plan.info.lineage?.sessionId ?? plan.info.rolloutKey,
        ) && plan.mode !== "rescan"
          ? { ...plan, mode: "rescan", reason: "session_rescan" }
          : plan
      ));
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
              ancestor.reason = "snapshot_persistence";
              changed = true;
            }
            parentId = bySessionId.get(parentId)?.lineage?.parentId ?? null;
          }
        }
        const rescanSessions = new Set(plans
          .filter((plan) => plan.mode === "rescan")
          .map((plan) => plan.info.lineage?.sessionId ?? plan.info.rolloutKey));
        for (const plan of plans) {
          const sessionId = plan.info.lineage?.sessionId ?? plan.info.rolloutKey;
          if (plan.mode !== "rescan" && rescanSessions.has(sessionId)) {
            plan.mode = "rescan";
            plan.reason = "session_rescan";
            changed = true;
          }
        }
      }
      const snapshots = createLineageSnapshots(component.members);
      try {
        for (const plan of plans) {
          if (signal?.aborted) throw fixedError("local_unified_index_aborted");
          const {
            info,
            cursor,
            mode,
            reason,
          } = plan;
          const sourceKey = sourceLocal(deviceSalt, info.rolloutKey);
          const sourceOrdinal = sourceOrdinals.get(info.rolloutKey);
          const sessionId = info.lineage?.sessionId ?? info.rolloutKey;
          const surface = surfaceRow(info.lineage?.surfaceClassification);
          const surfaceId = writer.internSurface(surface);
          const sessionKey = localForSession(sessionId);
          const previousSource = writer.previousGenerationSource(
            sourceKey,
            previousGenerationId,
          );
          writer.writeGenerationSource({
            sourceLocal: sourceKey,
            sourceOrdinal,
            sessionLocal: sessionKey,
            surfaceId,
            status: "pending",
            discoveredSizeBytes: Number(info.size ?? 0),
            scannedBytes: Number(cursor?.scanned_bytes ?? 0),
            mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
            diagnosticsComplete: false,
          });
          if (mode === "skip") {
            diagnostics.sourcesSkipped += 1;
            writer.rebindToolFactsForSource(sourceKey);
            writer.copySourceDiagnostics(sourceKey, previousGenerationId);
            writer.writeGenerationSource({
              sourceLocal: sourceKey,
              sourceOrdinal,
              sessionLocal: sessionKey,
              surfaceId,
              status: "skipped",
              discoveredSizeBytes: Number(info.size ?? 0),
              scannedBytes: Number(cursor?.scanned_bytes ?? 0),
              mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
              diagnosticsComplete: previousSource?.diagnosticsComplete === true,
            });
            continue;
          }
          const state = {
            sessionLocal: sessionKey,
            sourceLocal: sourceKey,
            sourceId: writer.internSource(sourceKey),
            sourceOrdinal,
            surface,
            surfaceId,
          };
          if (mode === "touch") {
            diagnostics.sourcesTouched += 1;
            writer.rebindToolFactsForSource(sourceKey);
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
            writer.copySourceDiagnostics(sourceKey, previousGenerationId);
            writer.writeGenerationSource({
              sourceLocal: sourceKey,
              sourceOrdinal,
              sessionLocal: sessionKey,
              surfaceId,
              status: "touched",
              discoveredSizeBytes: Number(info.size ?? 0),
              scannedBytes: Number(cursor.scanned_bytes),
              mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
              diagnosticsComplete: previousSource?.diagnosticsComplete === true,
            });
            continue;
          }
          const resuming = mode === "resume";
          if (resuming) {
            // Existing facts from the scanned prefix remain authoritative;
            // bind them to this publication before appending the new tail.
            writer.rebindToolFactsForSource(sourceKey);
          }
          if (!resuming && cursor !== undefined
              && replacementReasons.has(reason)) {
            replaceSourceFacts(sourceKey, sessionKey, {
              parserReparse: reason === "parser_version",
            });
          }
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
            onTool: (event) => sink.writeTool(state, event),
          });
          sink.finishSource(state);
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
            status: resuming ? "resumed" : "rescanned",
            discoveredSizeBytes: Number(info.size ?? 0),
            scannedBytes: outcome.read.nextOffset,
            mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
            diagnosticsComplete: true,
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
    const indexedSources = database.prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(discovered_size_bytes), 0) AS bytes
      FROM generation_source WHERE generation_id = ?`).get(
      generation.generationId,
    );
    writer.writeMeta("source_count", infos.length);
    writer.writeMeta("source_bytes", sourceBytes);
    writer.writeMeta("usage_events", totalUsageEvents);
    writer.writeMeta("boundary_links", totalBoundaryLinks);
    writer.writeMeta("generated_at", new Date().toISOString());
    writer.writeMeta("contract_version", contractVersion);
    if (signal?.aborted) throw fixedError("local_unified_index_aborted");
    writer.writeMeta("status", "complete");
    writer.finalizeGeneration({
      status: "complete",
      discoveredSourceCount: infos.length,
      discoveredSourceBytes: sourceBytes,
      indexedSourceCount: Number(indexedSources.count),
      indexedSourceBytes: Number(indexedSources.bytes),
      discoveryComplete: true,
      diagnosticsComplete: true,
    });
    const generationDescriptor = readUnifiedIndexGenerationDescriptor(
      database,
      generation.generationId,
    );
    const closed = await writer.close({
      integrityCheck: true,
      fsyncPath: stageFile,
    });
    writer = null;
    await publishStagedUnifiedIndex(stageFile, resolvedIndexFile);
    return {
      status: "ingested",
      indexFile: resolvedIndexFile,
      generation: generationDescriptor,
      generationDescriptor,
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
    if (writer !== null) {
      try {
        writer.failGeneration(error?.code === "local_unified_index_aborted"
          ? "aborted"
          : "exception");
      } catch {
        // If the stage is already closed or storage failed, it is discarded.
      }
    }
    if (database?.isOpen) {
      try {
        database.close();
      } catch {
        // The connection may already be closed.
      }
    }
    await removeIfPresent(stageFile);
    throw error;
  }
}
