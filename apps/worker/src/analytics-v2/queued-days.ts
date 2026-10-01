/**
 * analytics-v2 queued days (A-1): the observed days named by
 * storage_ingestion_changes events after a journal cursor.
 *
 * Production publishes only queued days (STORAGE_DAILY_PENDING_DAYS_SQL: the
 * analytics_community_daily_queue fed by journal deliveries, plus heads whose
 * publication method changed). The fast path keeps those queue semantics and
 * derives each event's days directly from the source rows the event names,
 * following the d43c8f92 queue producers:
 *   - a v1 chunk event (typed_v1_event_sources): the chunk's day
 *     (analytics_community_daily_v1_* triggers over analytics_v1_chunk_values);
 *   - a v1.1 head event (storage_v11_event_sources): the generation's domain
 *     days and those of the generation it replaced (the v11 owner-head
 *     insert/update triggers re-queue the new and the old event's days);
 *   - a v1.2 head event (storage_v12_event_sources): the days whose
 *     (day, manifest digest) differ between the generation and its
 *     predecessor (v12-storage-journal.ts advanceV12StorageAcknowledgement).
 * Terminal events (owner-withdrawn, owner-erased) re-queue the days the owner
 * contributed to, which only the publisher's own owner-day rows know; they
 * are returned as owner digests for the caller to resolve, never guessed.
 * Under the 2026-09-26 owner decisions these stop future uploads only.
 */

import type { AnalyticsV2Day, AnalyticsV2OwnerDigest } from "./contract";
import {
  onReadSnapshot,
  quotedSchema,
  safeInteger,
  sourceFail,
  type AnalyticsV2SnapshotContext,
} from "./owners";

export interface ReadQueuedDaysOptions {
  /** Last journal sequence already consumed (0 for a fresh start). */
  readonly afterSequence: number;
  /** Events read per call; the caller loops while `complete` is false. */
  readonly limit?: number;
}

export interface AnalyticsV2QueuedDays {
  /** Distinct queued days, ascending. */
  readonly days: readonly AnalyticsV2Day[];
  /** Highest sequence read; equals afterSequence when nothing was read. */
  readonly lastSequence: number;
  /** Owners with a terminal event in the range (their days are the caller's to resolve). */
  readonly terminalOwners: readonly AnalyticsV2OwnerDigest[];
  /** Events read, and whether the journal was read to its end. */
  readonly events: number;
  readonly complete: boolean;
}

const DEFAULT_LIMIT = 100_000;
const MAX_LIMIT = 1_000_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

function queuedDaysSql(s: string): string {
  return `WITH changes AS MATERIALIZED (
      SELECT change.sequence,change.event_digest,change.owner_digest,change.kind
        FROM ${s}.storage_ingestion_changes change
        JOIN ${s}.storage_source_state source ON source.singleton=1 AND source.source_id=change.source_id
       WHERE change.sequence>$1
       ORDER BY change.sequence LIMIT $2
    ), v1_days AS (
      SELECT to_char(chunk.chunk_day,'YYYY-MM-DD') AS day
        FROM changes
        JOIN ${s}.typed_v1_event_sources event ON event.event_digest=changes.event_digest
         AND event.owner_digest=changes.owner_digest
        JOIN ${s}.telemetry_v1_chunks chunk ON chunk.id=event.chunk_id
       WHERE changes.kind NOT IN ('owner-withdrawn','owner-erased')
    ), v11_days AS (
      SELECT to_char(domain_day.observed_day,'YYYY-MM-DD') AS day
        FROM changes
        JOIN ${s}.storage_v11_event_sources event ON event.event_digest=changes.event_digest
         AND event.owner_digest=changes.owner_digest
        JOIN ${s}.telemetry_v11_domains generation ON generation.id=event.generation_id
        JOIN ${s}.telemetry_v11_domain_days domain_day
          ON domain_day.generation_id IN (generation.id,generation.previous_generation_id)
       WHERE changes.kind NOT IN ('owner-withdrawn','owner-erased')
    ), v12_pairs AS (
      SELECT event.generation_id,event.previous_generation_id
        FROM changes
        JOIN ${s}.storage_v12_event_sources event ON event.event_digest=changes.event_digest
         AND event.owner_digest=changes.owner_digest
       WHERE changes.kind NOT IN ('owner-withdrawn','owner-erased')
    ), v12_days AS (
      SELECT to_char(changed.observed_day,'YYYY-MM-DD') AS day FROM v12_pairs pair
      CROSS JOIN LATERAL (
        (SELECT observed_day,manifest_digest FROM ${s}.telemetry_v12_domain_days WHERE generation_id=pair.generation_id
         EXCEPT SELECT observed_day,manifest_digest FROM ${s}.telemetry_v12_domain_days
          WHERE generation_id=pair.previous_generation_id)
        UNION
        (SELECT observed_day,manifest_digest FROM ${s}.telemetry_v12_domain_days
          WHERE generation_id=pair.previous_generation_id
         EXCEPT SELECT observed_day,manifest_digest FROM ${s}.telemetry_v12_domain_days
          WHERE generation_id=pair.generation_id)
      ) changed
    )
    SELECT 'day' AS kind,day AS value FROM (
      SELECT day FROM v1_days UNION SELECT day FROM v11_days UNION SELECT day FROM v12_days) days
    UNION ALL
    SELECT 'terminal',owner_digest FROM (SELECT DISTINCT owner_digest FROM changes
      WHERE kind IN ('owner-withdrawn','owner-erased')) terminal
    UNION ALL
    SELECT 'range',count(*)::text||':'||COALESCE(max(sequence),0)::text FROM changes`;
}

/** Read the days named by journal events with sequence > afterSequence. */
export async function readQueuedDays(
  context: AnalyticsV2SnapshotContext,
  options: ReadQueuedDaysOptions,
): Promise<AnalyticsV2QueuedDays> {
  const s = quotedSchema(context.schema);
  const afterSequence = safeInteger(options?.afterSequence, 0);
  const limit = options?.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  return onReadSnapshot(context, async (client) => {
    const result = await client.query<{ kind: unknown; value: unknown }>(queuedDaysSql(s), [afterSequence, limit]);
    const days = new Set<AnalyticsV2Day>();
    const terminalOwners: AnalyticsV2OwnerDigest[] = [];
    let range: string | null = null;
    for (const row of result.rows) {
      if (typeof row.value !== "string") sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
      if (row.kind === "day" && DAY.test(row.value)) days.add(row.value);
      else if (row.kind === "terminal" && /^[0-9a-f]{64}$/u.test(row.value)) terminalOwners.push(row.value);
      else if (row.kind === "range" && range === null) range = row.value;
      else sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
    }
    const match = range === null ? null : /^(\d+):(\d+)$/u.exec(range);
    if (!match) return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
    const events = safeInteger(match[1]);
    const lastSequence = events === 0 ? afterSequence : safeInteger(match[2], afterSequence + 1);
    return Object.freeze({
      days: Object.freeze([...days].sort()),
      lastSequence,
      terminalOwners: Object.freeze(terminalOwners.sort()),
      events,
      complete: events < limit,
    });
  });
}
