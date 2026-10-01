// Settled cache-retention reference: production's cache-retention lane driven
// directly, without the Worker's per-invocation budget, on scratch copies of a
// run's databases.
//
// The scheduled builder (cache-retention-day-worker.ts) gives every pass one
// 1,000-statement meter: 650 target statements, 350 source statements and the
// shared remainder. A dense owner-day can need more than one pass affords, and
// the lane then defers on `query_budget` every pass (measured on the dense
// corpus: owner e's first day stays at progress revision 2 for hundreds of
// passes and no later cache day is built). The cache values therefore depend
// on how far the interleaved lanes got, which is why Q-1 kept cache counts
// informational.
//
// This module computes what that same lane publishes once it can finish:
//
//   1. clone the source (read-only) and the analytics target;
//   2. on the target clone, delete every cache-retention row (marks, values,
//      bands, carry, progress and the owner cursor), keeping everything else:
//      the daily lane's owner pages, which select each candidate's layout, and
//      the shared feature days;
//   3. call d43c8f92's advanceCacheRetentionDayLane with the scheduled
//      worker's build (createCacheRetentionDaySourceBuild over the same source,
//      target and namespace, shared features as configured), its
//      maxWrites (CACHE_RETENTION_WORKER_WRITES) and one shard, but with the
//      target, source and shared statement allowances and the deadline
//      unbounded, until it reports `idle`/`complete`;
//   4. read back every owner-day's values and bands, the marks by layout and
//      refusal, and the published series (readCacheRetentionCommunitySeries).
//
// Only the budget differs from a scheduled pass: candidate selection, layout
// choice, the carry, the build, refusals and the atomic day writes are the
// lane's own. The source clone is opened read-only.
import { chmodSync, copyFileSync, constants as fsConstants, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** In the order the retention triggers allow deletion: a mark retains its
 * values, carry and promoted progress, and a value retains its bands. */
export const CACHE_RETENTION_TABLES = Object.freeze([
  "analytics_cache_retention_day_marks", "analytics_cache_retention_day_values",
  "analytics_cache_retention_day_bands", "analytics_cache_retention_day_carry",
  "analytics_cache_retention_day_progress", "analytics_cache_retention_owner_cursor",
]);
/** Larger than any corpus here needs; every value stays a safe integer. */
const UNBOUNDED = 1_000_000_000_000;
/** Consecutive lane calls without a built, staged or refused day before the rebuild is reported stuck. */
const STALL_CALLS = 64;

const VALUES_SQL = `SELECT v.owner_digest,v.day,v.method_version,v.model,v.effort,v.adjacencies,v.sessions,
  m.source_layout,b.band,b.adjacencies AS band_adjacencies,b.reused_more_than_half,b.matched_or_exceeded,b.unordered_ties,
  b.excluded_insufficient_evidence,b.excluded_context_contracted,b.sessions AS band_sessions
  FROM analytics_cache_retention_day_values v JOIN analytics_cache_retention_day_marks m ON m.mark_key=v.mark_key
  JOIN analytics_cache_retention_day_bands b ON b.value_key=v.value_key
  WHERE v.source_id=? ORDER BY v.owner_digest,v.day,m.source_layout,v.model,v.effort,b.band`;

/**
 * Returns { ownerDays, marks, series, lane } where ownerDays maps
 * `${ownerKey}:${day}` to band rows (Q-1's cache-owner-days shape), marks
 * lists every mark (owner, day, layout, refusal), series is the published
 * cacheRetention object, and lane records the calls and their outcome. The
 * settled target clone stays at `<scratchDir>/<files.target>` for the caller's
 * public read; the caller removes `scratchDir`.
 */
export async function runSettledCache({ P, openSealedSqliteD1, dbDir, scratchDir, files, sourceId, sourceNamespace,
  nowMs, sharedFeatures, ownerKeyOf, onCall = () => {} }) {
  mkdirSync(scratchDir, { recursive: true });
  const sourcePath = join(scratchDir, files.source), targetPath = join(scratchDir, files.target);
  rmSync(sourcePath, { force: true }); rmSync(targetPath, { force: true });
  copyFileSync(join(dbDir, files.source), sourcePath, fsConstants.COPYFILE_FICLONE);
  copyFileSync(join(dbDir, files.target), targetPath, fsConstants.COPYFILE_FICLONE);
  chmodSync(sourcePath, 0o400); chmodSync(targetPath, 0o600);
  const sourceHandle = openSealedSqliteD1(sourcePath, { readOnly: true, pinnedNowMs: nowMs });
  const targetHandle = openSealedSqliteD1(targetPath, { pinnedNowMs: nowMs });
  const source = sourceHandle.database, target = targetHandle.database;
  const started = performance.now();
  const lane = { calls: 0, built: 0, staged: 0, refused: 0, skipped: 0, outcome: null, stalledAt: null,
    configuration: { sharedFeatures, maxDays: P.CACHE_RETENTION_WORKER_DAYS, maxWrites: P.CACHE_RETENTION_WORKER_WRITES,
      shards: 1, budget: "target, source and shared statement allowances and the deadline unbounded" } };
  try {
    const cleared = {};
    for (const table of CACHE_RETENTION_TABLES) {
      cleared[table] = (await target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n"));
    }
    await target.batch(CACHE_RETENTION_TABLES.map((table) => target.prepare(`DELETE FROM ${table}`)));
    lane.cleared = cleared;
    const build = P.createCacheRetentionDaySourceBuild({ source, target, sourceNamespace, sharedFeatures, now: () => nowMs });
    let idle = 0;
    for (;;) {
      lane.calls++;
      const result = await P.advanceCacheRetentionDayLane({ target, sourceId, build,
        sharedRemainingQueries: () => UNBOUNDED, deadlineMs: Number.MAX_SAFE_INTEGER, remainingQueries: UNBOUNDED,
        sourceQueries: UNBOUNDED, maxDays: P.CACHE_RETENTION_WORKER_DAYS, maxWrites: P.CACHE_RETENTION_WORKER_WRITES,
        shardIndex: 0, shardCount: 1, now: () => nowMs });
      for (const key of ["built", "staged", "refused", "skipped"]) lane[key] += result[key];
      onCall(lane.calls, result);
      if (result.state === "idle" && result.reason === "complete") { lane.outcome = "complete"; break; }
      // A skipped day is retried on a later rotation and is not progress.
      const moved = result.built + result.staged + result.refused;
      idle = moved > 0 ? 0 : idle + 1;
      if (idle >= STALL_CALLS) { lane.outcome = "stalled"; lane.stalledAt = { state: result.state, reason: result.reason }; break; }
    }
    lane.ms = Math.round(performance.now() - started);
    const rows = (await target.prepare(VALUES_SQL).bind(sourceId).all()).results;
    const ownerDays = {};
    for (const row of rows) {
      const key = `${ownerKeyOf(row.owner_digest)}:${row.day}`;
      (ownerDays[key] ??= []).push({ layout: row.source_layout, method: row.method_version, model: row.model,
        effort: row.effort, band: row.band, adjacencies: row.band_adjacencies, reusedMoreThanHalf: row.reused_more_than_half,
        matchedOrExceeded: row.matched_or_exceeded, unorderedTies: row.unordered_ties,
        excludedInsufficientEvidence: row.excluded_insufficient_evidence,
        excludedContextContracted: row.excluded_context_contracted, sessions: row.band_sessions });
    }
    const marks = (await target.prepare(`SELECT owner_digest,day,source_layout,carry_days,value_count,events_read,
      unreadable_events,refusal FROM analytics_cache_retention_day_marks WHERE source_id=?
      ORDER BY owner_digest,day,source_layout`).bind(sourceId).all())
      .results.map((row) => ({ owner: ownerKeyOf(row.owner_digest), day: row.day, layout: row.source_layout,
        carryDays: row.carry_days, values: row.value_count, eventsRead: row.events_read,
        unreadableEvents: row.unreadable_events, refusal: row.refusal ?? null }));
    const progress = (await target.prepare(`SELECT owner_digest,day,source_layout,progress_revision
      FROM analytics_cache_retention_day_progress WHERE source_id=? ORDER BY owner_digest,day`).bind(sourceId).all())
      .results.map((row) => ({ owner: ownerKeyOf(row.owner_digest), day: row.day, layout: row.source_layout,
        progressRevision: row.progress_revision }));
    const series = await P.readCacheRetentionCommunitySeries({ target, sourceId, nowMs });
    return { ownerDays, marks, progress, series, lane, targetPath, sourcePath };
  } finally {
    sourceHandle.close(); targetHandle.close();
  }
}
