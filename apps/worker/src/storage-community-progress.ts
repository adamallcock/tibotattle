import { captureStorageCommunityAuthority, readStorageCommunityDeliveredTerminalEpoch,
 readStorageCommunitySourceTerminalEpoch, storageCommunityCalculationAuthorityIsCurrent,
 storageCommunityPublicationVisible, type StorageCommunityAuthority } from './storage-community-authority';
import { STORAGE_GRAPH_METHOD } from './storage-community-graph';
import { ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS } from './admin-community-allowance';
import { COMMUNITY_MODEL_REFUSAL_REASONS } from './community-allowance';
import type { StorageAnalyticsBindings } from './analytics-delivery';
import { ApiError } from './errors';
import { validStorageModelPublication, type StorageModelPublicationValue } from './storage-community-publication-value';

/** Same census bound as the typed admin overview. Every row read below is
 * either an aggregate or capped by this limit. A cap reached by a count that
 * feeds `missing`, `completeAccounts` or `work.state` is fail-closed; a cap
 * reached by a display-only counter reports null instead of taking the panel
 * down, because an uncounted total is not a smaller total. */
const MAX_ADMIN_AGGREGATE_ROWS = 10_000;
const HOUR_MS = 3_600_000, DAY_MS = 86_400_000;
/** The staged-checkpoint control vocabulary. `control_json.phase` is the outer
 * kernel phase (`acquisition`/`finish`/`usage`); while it is `acquisition` the
 * meaningful position is the inner `acquisition.phase`. Anything else is
 * reported as `other`, never invented and never dropped. */
const CHECKPOINT_PHASES: readonly string[] = ['plan', 'clusters', 'fitability', 'endpoints', 'usage', 'finish'];
const OTHER_PHASE = 'other', OTHER_REASON = 'other';
/** The projector's own token shape, applied to both closed vocabularies. */
const CLOSED_TOKEN = /^[a-z][a-z0-9_]{2,63}$/u;

export type StorageCommunityProgressMetric = 'model' | 'fits';
export type StorageCommunityProgressWorkState = 'building' | 'queued' | 'idle';
export interface StorageCommunityProgressDay {
 day: string; ready: number; refused: number; unsupported: number; missing: number;
 published: boolean; publishedAt: string | null;
}
export interface StorageCommunityProgressRefusal { reason: string; owners: number }
export interface StorageCommunityProgressCheckpointPhase { phase: string; stages: number; parts: number }
export interface StorageCommunityProgressCheckpoints {
 stages: number; parts: number; bytes: number; phases: StorageCommunityProgressCheckpointPhase[];
}
export interface StorageCommunityProgressGraph {
 window: { days: number; from: string; to: string };
 owners: { active: number };
 /** A current fit is a JSON array of selected fits, not a status document: a
  * refused or unusable analysis is persisted as an empty array. `noFit` is
  * that empty-array outcome, never a missing or pending owner. */
 currentFits: { day: string; ready: number; noFit: number; missing: number };
 days: StorageCommunityProgressDay[];
 /** Model refusals only. The fits payload carries no reason to count. */
 refusals: StorageCommunityProgressRefusal[];
 work: {
  state: StorageCommunityProgressWorkState;
  activeDay: string | null;
  activeMetric: StorageCommunityProgressMetric | null;
  leaseExpiresAt: string | null;
  selections: { pending: number; claimed: number };
  checkpoints: StorageCommunityProgressCheckpoints | null;
 };
 throughput: {
  resultsLastHour: number | null; resultsLast6Hours: number | null;
  remainingResults: number; estimatedHoursRemaining: number | null;
 };
 retirement: { staleResults: number | null };
}
/** Where analytics processing stands between an upload and a publication.
 * Counts, UTC days and instants only: no digest, owner or content crosses. */
export interface StoragePipelineProgress {
 /** The ingestion journal every accepted change is written to. */
 ingestion: { journalHead: number; latestRecordedAt: string | null };
 /** Ordered delivery of journal changes into analytics. A device activation
  * is folded day by day; `current` is the change being folded now. */
 delivery: {
  appliedSequence: number; pendingChanges: number; pendingActivations: number;
  current: { fromDay: string; throughDay: string; nextDay: string; daysDone: number; daysTotal: number } | null;
 };
 /** The daily lane publishes a day only once every public owner's latest
  * change has been delivered, so a delivery backlog holds the whole queue. */
 daily: {
  queuedDays: number; oldestQueuedDay: string | null; newestQueuedDay: string | null;
  lastReleasedAt: string | null; releasedLastHour: number;
 };
}
export interface StorageCommunityProgress {
 schemaVersion: 3;
 preparation?: null;
 /** Null when this block alone could not be read; the graph view still stands. */
 pipeline: StoragePipelineProgress | null;
 generatedAt: string;
 publication: { state: 'ready' | 'invalidated' | 'empty'; requestedGeneration: number; preparedGeneration: number | null;
  publishedGeneration: number | null; publishedAt: string | null };
 work: { state: StorageCommunityProgressWorkState; phase: 'current' | 'history' | 'daily' | null;
  updatedAt: string | null; trigger: null; restartReason: null };
 history: { resolvedDays: number; requiredDays: number; activeDay: string | null;
  completeAccounts: number | null; requiredAccounts: number };
 graph: StorageCommunityProgressGraph;
}

const unavailable = () => new Error('graph progress unavailable');
function count(value: unknown): number {
 const result = Number(value);
 if (!Number.isSafeInteger(result) || result < 0) throw unavailable();
 return result;
}
function utcDay(value: unknown): string {
 if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
  || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw unavailable();
 return value;
}
function instant(value: unknown): string {
 const epoch = count(value), date = new Date(epoch);
 if (!Number.isFinite(date.getTime())) throw unavailable();
 return date.toISOString();
}
function metricOf(value: unknown): StorageCommunityProgressMetric {
 if (value !== 'model' && value !== 'fits') throw unavailable();
 return value;
}
/** A capped census that decides a shown quantity is unavailable, not smaller. */
function bounded(total: number): number {
 if (total > MAX_ADMIN_AGGREGATE_ROWS) throw unavailable();
 return total;
}
const inclusiveDays = (from: string, through: string): number =>
 Math.round((Date.parse(`${through}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS) + 1;

/** Read separately from the graph census and never allowed to take it down:
 * a failure here reports the pipeline as unavailable, not the whole panel. */
export async function readStoragePipelineProgress(bindings: StorageAnalyticsBindings,
 nowMs: number): Promise<StoragePipelineProgress | null> {
 try {
  const cursor = await bindings.target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?')
   .bind(bindings.sourceId).first<{ sequence: number }>();
  const appliedSequence = count(cursor?.sequence ?? 0);
  const [head, pending, next] = await bindings.source.batch([
   bindings.source.prepare(`SELECT sequence, recorded_ms FROM storage_ingestion_changes
    ORDER BY sequence DESC LIMIT 1`),
   bindings.source.prepare(`SELECT COUNT(*) AS changes,
     COALESCE(SUM(CASE WHEN kind='owner-active' THEN 1 ELSE 0 END),0) AS activations
    FROM storage_ingestion_changes WHERE sequence>?`).bind(appliedSequence),
   bindings.source.prepare('SELECT event_digest FROM storage_ingestion_changes WHERE sequence>? ORDER BY sequence LIMIT 1')
    .bind(appliedSequence),
  ]);
  const headRow = head!.results[0] as { sequence: number; recorded_ms: number } | undefined;
  const pendingRow = pending!.results[0] as { changes: number; activations: number } | undefined;
  const nextDigest = (next!.results[0] as { event_digest: string } | undefined)?.event_digest ?? null;
  const journalHead = count(headRow?.sequence ?? 0);
  const pendingChanges = count(pendingRow?.changes ?? 0), pendingActivations = count(pendingRow?.activations ?? 0);
  if (appliedSequence > journalHead || pendingActivations > pendingChanges) return null;
  const [work, queue, published] = await bindings.target.batch([
   bindings.target.prepare(`SELECT from_day, through_day, next_day FROM analytics_v11_projection_work
    WHERE source_id=? AND event_digest=? AND phase='building'`).bind(bindings.sourceId, nextDigest ?? ''),
   bindings.target.prepare(`SELECT COUNT(*) AS days, MIN(day) AS oldest, MAX(day) AS newest
    FROM analytics_community_daily_queue WHERE source_id=?`).bind(bindings.sourceId),
   bindings.target.prepare(`SELECT MAX(released_at) AS last,
     COALESCE(SUM(CASE WHEN released_at>=? THEN 1 ELSE 0 END),0) AS last_hour
    FROM analytics_community_daily_publications WHERE source_id=?`)
    .bind(new Date(nowMs - HOUR_MS).toISOString(), bindings.sourceId),
  ]);
  const workRow = work!.results[0] as { from_day: string; through_day: string; next_day: string } | undefined;
  let current: StoragePipelineProgress['delivery']['current'] = null;
  if (workRow) {
   const fromDay = utcDay(workRow.from_day), throughDay = utcDay(workRow.through_day), nextDay = utcDay(workRow.next_day);
   const daysTotal = inclusiveDays(fromDay, throughDay), daysDone = inclusiveDays(fromDay, nextDay) - 1;
   if (daysTotal < 1 || daysDone < 0 || daysDone > daysTotal) return null;
   current = { fromDay, throughDay, nextDay, daysDone, daysTotal };
  }
  const queueRow = queue!.results[0] as { days: number; oldest: string | null; newest: string | null } | undefined;
  const publishedRow = published!.results[0] as { last: string | null; last_hour: number } | undefined;
  const queuedDays = count(queueRow?.days ?? 0);
  return {
   ingestion: { journalHead, latestRecordedAt: headRow ? instant(headRow.recorded_ms) : null },
   delivery: { appliedSequence, pendingChanges, pendingActivations, current },
   daily: {
    queuedDays,
    oldestQueuedDay: queuedDays > 0 && queueRow?.oldest ? utcDay(queueRow.oldest) : null,
    newestQueuedDay: queuedDays > 0 && queueRow?.newest ? utcDay(queueRow.newest) : null,
    lastReleasedAt: publishedRow?.last ? new Date(Date.parse(publishedRow.last)).toISOString() : null,
    releasedLastHour: count(publishedRow?.last_hour ?? 0),
   },
  };
 } catch { return null; }
}

/** The same cap for a display-only counter: null rather than a 503. */
function counted(total: number): number | null {
 return total > MAX_ADMIN_AGGREGATE_ROWS ? null : total;
}

let refusalReasonSql: string | null = null;
/** The closed vocabulary is a code constant, so the bucketing happens inside
 * the aggregate: mapping in JS afterwards would count an owner that refused
 * under two different unknown reasons twice in `other`. Each reason is
 * re-checked against the projector's token shape before it reaches SQL. */
function refusalReasonExpression(): string {
 if (refusalReasonSql !== null) return refusalReasonSql;
 const tokens = [...COMMUNITY_MODEL_REFUSAL_REASONS].sort();
 if (tokens.length === 0 || tokens.some((reason) => !CLOSED_TOKEN.test(reason))) throw unavailable();
 const reason = `json_extract(r.payload_json,'$.reason')`;
 refusalReasonSql = `CASE WHEN ${reason} IN(${tokens.map((token) => `'${token}'`).join(',')})
    THEN ${reason} ELSE '${OTHER_REASON}' END`;
 return refusalReasonSql;
}
function checkpointPhase(value: unknown): string {
 if (CHECKPOINT_PHASES.some((phase) => !CLOSED_TOKEN.test(phase))) throw unavailable();
 return typeof value === 'string' && CLOSED_TOKEN.test(value) && CHECKPOINT_PHASES.includes(value)
  ? value : OTHER_PHASE;
}

/** Owner-only progress reads bounded analytical metadata. A cached point is
 * counted only under the current hard authority; pending owners are not inferred
 * from row totals, nor are source records read to manufacture a progress estimate.
 *
 * The schemaVersion 3 `graph` block adds the live typed-storage census: per-day
 * model coverage, current-day fits, closed-vocabulary refusal counts, selection
 * and staged-checkpoint work, throughput and retirement. Every count is an
 * aggregate or an explicitly capped row read; no owner digest, payload or
 * envelope leaves this reader. In particular a fits payload embeds the owner
 * digest in each selected fit, so only its array length is ever inspected. */
export async function readStorageCommunityProgress(bindings: StorageAnalyticsBindings, nowMs: number,
 options: { includePreparation?: boolean } = {}): Promise<StorageCommunityProgress> {
 try {
  const authority = await captureStorageCommunityAuthority(bindings.source, bindings);
  const terminalEpoch = Math.max(await readStorageCommunitySourceTerminalEpoch(bindings.source),
   await readStorageCommunityDeliveredTerminalEpoch(bindings.target, bindings.sourceId));
  const generatedAt = new Date(nowMs).toISOString(), today = generatedAt.slice(0, 10);
  const requiredDays = ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS - 1;
  const from = new Date(Date.parse(today) - requiredDays * DAY_MS).toISOString().slice(0, 10);
  const sixHoursFrom = nowMs - 6 * HOUR_MS, oneHourFrom = nowMs - HOUR_MS;
  const cap = MAX_ADMIN_AGGREGATE_ROWS + 1;
  const metadata = await bindings.target.batch([
   bindings.target.prepare(`SELECT day,authority_json,payload_json,payload_sha256,computed_ms FROM analytics_community_model_publications
    WHERE source_id=? AND day>=? AND day<? AND method=? ORDER BY day LIMIT ?`)
    .bind(bindings.sourceId, from, today, STORAGE_GRAPH_METHOD, requiredDays + 1),
   bindings.target.prepare(`SELECT authority_json,generated_at,inputs_current FROM analytics_community_graph_previews
    WHERE source_id=? AND method=?`).bind(bindings.sourceId, STORAGE_GRAPH_METHOD),
   bindings.target.prepare('SELECT updated_ms FROM analytics_community_graph_scan WHERE source_id=?').bind(bindings.sourceId),
   bindings.target.prepare('SELECT day FROM analytics_community_daily_queue WHERE source_id=? ORDER BY day LIMIT 1').bind(bindings.sourceId),
   // 4: active owner census. Withdrawn and erased owners are excluded here and
   // by the joins below, so a retained result can never outnumber the cohort.
   bindings.target.prepare(`SELECT COUNT(*) AS total FROM (
     SELECT 1 FROM analytics_owner_state WHERE source_id=? AND state='active' LIMIT ?)`)
    .bind(bindings.sourceId, cap),
   // 5: per-day model coverage under the current method. `not_testable` is the
   // analytical refusal; `unsupported_source` is a legacy/overlap owner the
   // kernel cannot compose at all. Neither is a ready composition.
   bindings.target.prepare(`SELECT r.day AS day,
     COALESCE(SUM(CASE WHEN json_extract(r.payload_json,'$.status')='not_testable' THEN 1 ELSE 0 END),0) AS refused,
     COALESCE(SUM(CASE WHEN json_extract(r.payload_json,'$.status')='unsupported_source' THEN 1 ELSE 0 END),0) AS unsupported,
     COALESCE(SUM(CASE WHEN json_extract(r.payload_json,'$.status') IN('not_testable','unsupported_source')
       THEN 0 ELSE 1 END),0) AS ready
    FROM analytics_community_graph_results r
    JOIN analytics_owner_state o ON o.source_id=r.source_id AND o.owner_digest=r.owner_digest AND o.state='active'
    WHERE r.source_id=? AND r.metric='model' AND r.method=? AND r.day>=? AND r.day<?
    GROUP BY r.day ORDER BY r.day LIMIT ?`)
    .bind(bindings.sourceId, STORAGE_GRAPH_METHOD, from, today, requiredDays + 1),
   // 6: current-day fits. The payload is a JSON array of selected fits, so an
   // unusable or refused analysis is the empty array, and each element carries
   // the owner digest: only the length is read, never an element.
   bindings.target.prepare(`SELECT
     COALESCE(SUM(CASE WHEN json_array_length(r.payload_json)>0 THEN 1 ELSE 0 END),0) AS ready,
     COALESCE(SUM(CASE WHEN json_array_length(r.payload_json)>0 THEN 0 ELSE 1 END),0) AS no_fit
    FROM analytics_community_graph_results r
    JOIN analytics_owner_state o ON o.source_id=r.source_id AND o.owner_digest=r.owner_digest AND o.state='active'
    WHERE r.source_id=? AND r.metric='fits' AND r.method=? AND r.day=?`)
    .bind(bindings.sourceId, STORAGE_GRAPH_METHOD, today),
   // 7: distinct refusing owners per model reason over the window. Only the
   // reason token and the count cross the boundary; the digest is consumed
   // inside the aggregate.
   bindings.target.prepare(`SELECT ${refusalReasonExpression()} AS reason,
     COUNT(DISTINCT r.owner_digest) AS owners
    FROM analytics_community_graph_results r
    JOIN analytics_owner_state o ON o.source_id=r.source_id AND o.owner_digest=r.owner_digest AND o.state='active'
    WHERE r.source_id=? AND r.method=? AND r.metric='model'
      AND json_extract(r.payload_json,'$.status')='not_testable' AND r.day>=? AND r.day<?
    GROUP BY reason ORDER BY owners DESC,reason LIMIT ?`)
    .bind(bindings.sourceId, STORAGE_GRAPH_METHOD, from, today, cap),
   // 8: selection census. `live` counts only unexpired claims: an expired
   // lease is outstanding work, not a running build.
   bindings.target.prepare(`SELECT COUNT(*) AS total,
     COALESCE(SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END),0) AS pending,
     COALESCE(SUM(CASE WHEN state='claimed' THEN 1 ELSE 0 END),0) AS claimed,
     COALESCE(SUM(CASE WHEN state='claimed' AND claim_expires_ms>?1 THEN 1 ELSE 0 END),0) AS live
    FROM (SELECT state,claim_expires_ms FROM analytics_community_graph_work_selection
      WHERE source_id=?2 LIMIT ?3)`).bind(nowMs, bindings.sourceId, cap),
   // 9/10: the position shown to the operator. The stored day/metric columns
   // are the selection key the envelope is fenced against, so the envelope
   // body is never parsed here.
   bindings.target.prepare(`SELECT day,metric,claim_expires_ms FROM analytics_community_graph_work_selection
    WHERE source_id=? AND state='claimed' AND claim_expires_ms>? ORDER BY updated_ms DESC,day DESC,metric LIMIT 1`)
    .bind(bindings.sourceId, nowMs),
   bindings.target.prepare(`SELECT day,metric FROM analytics_community_graph_work_selection
    WHERE source_id=? AND state='pending' ORDER BY updated_ms,day,metric LIMIT 1`).bind(bindings.sourceId),
   // 11: staged generations a resuming pass can still load: present head, not
   // retired, pointing at that exact generation.
   bindings.target.prepare(`SELECT CASE WHEN json_valid(s.control_json) THEN
      CASE WHEN json_extract(s.control_json,'$.phase')='acquisition'
        THEN json_extract(s.control_json,'$.acquisition.phase')
        ELSE json_extract(s.control_json,'$.phase') END END AS phase,
     COUNT(*) AS stages,COALESCE(SUM(s.part_count),0) AS parts
    FROM analytics_history_checkpoint_stages s
    JOIN analytics_history_checkpoint_heads h ON h.key_digest=s.key_digest AND h.retired=0 AND h.generation=s.generation
    WHERE s.source_id=? GROUP BY phase ORDER BY parts DESC,phase LIMIT ?`).bind(bindings.sourceId, cap),
   // 12: retained bytes of those same generations.
   bindings.target.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(payload_bytes),0) AS bytes FROM (
     SELECT p.payload_bytes AS payload_bytes FROM analytics_history_checkpoint_parts p
     JOIN analytics_history_checkpoint_stages s ON s.key_digest=p.key_digest AND s.generation=p.generation
     JOIN analytics_history_checkpoint_heads h ON h.key_digest=s.key_digest AND h.retired=0 AND h.generation=s.generation
     WHERE s.source_id=? LIMIT ?)`).bind(bindings.sourceId, cap),
   // 13: completed results in the trailing windows, both metrics.
   bindings.target.prepare(`SELECT COUNT(*) AS total,
     COALESCE(SUM(CASE WHEN computed_ms>=?1 THEN 1 ELSE 0 END),0) AS last_hour
    FROM (SELECT computed_ms FROM analytics_community_graph_results
      WHERE source_id=?2 AND method=?3 AND computed_ms>=?4 LIMIT ?5)`)
    .bind(oneHourFrom, bindings.sourceId, STORAGE_GRAPH_METHOD, sixHoursFrom, cap),
   // 14: results left behind by a method change, awaiting retirement.
   bindings.target.prepare(`SELECT COUNT(*) AS total FROM (
     SELECT 1 FROM analytics_community_graph_results WHERE source_id=? AND method<>? LIMIT ?)`)
    .bind(bindings.sourceId, STORAGE_GRAPH_METHOD, cap),
  ]);
  const days = new Set<string>(), publishedAtByDay = new Map<string, string>();
  for (const raw of metadata[0]!.results) {
   const row = raw as StorageModelPublicationValue & { computed_ms: number };
   if (!await validStorageModelPublication(row, authority, terminalEpoch)) continue;
   days.add(row.day);
   publishedAtByDay.set(row.day, instant(row.computed_ms));
  }
  if (days.size > requiredDays) throw new Error('history count unavailable');
  let activeDay: string | null = null;
  for (let offset = 1; offset <= requiredDays; offset++) {
   const day = new Date(Date.parse(today) - offset * DAY_MS).toISOString().slice(0, 10);
   if (!days.has(day)) { activeDay = day; break; }
  }
  const preview = metadata[1]!.results[0] as { authority_json: string; generated_at: string; inputs_current: number } | undefined;
  const published = preview ? JSON.parse(preview.authority_json) as StorageCommunityAuthority : null;
  const ready = published !== null && storageCommunityPublicationVisible(published, authority, terminalEpoch);
  const current = ready && preview!.inputs_current === 1 && published!.sourceEpoch === authority.sourceEpoch
   && preview!.generated_at.slice(0, 10) === today;
  const phase = !current ? 'current' as const : activeDay !== null ? 'history' as const
   : metadata[3]!.results.length ? 'daily' as const : null;
  const updatedMs = Number((metadata[2]!.results[0] as { updated_ms: number } | undefined)?.updated_ms ?? 0);
  if (!Number.isSafeInteger(updatedMs) || updatedMs < 0) throw new Error('work time unavailable');

  const activeOwners = bounded(count((metadata[4]!.results[0] as { total: number } | undefined)?.total));
  const coverage = new Map<string, { ready: number; refused: number; unsupported: number }>();
  const modelRows = metadata[5]!.results as { day: string; ready: number; refused: number; unsupported: number }[];
  if (modelRows.length > requiredDays) throw unavailable();
  for (const row of modelRows) {
   coverage.set(utcDay(row.day),
    { ready: count(row.ready), refused: count(row.refused), unsupported: count(row.unsupported) });
  }
  const empty = { ready: 0, refused: 0, unsupported: 0 };
  const windowDays: StorageCommunityProgressDay[] = [];
  for (let offset = 1; offset <= requiredDays; offset++) {
   const day = new Date(Date.parse(today) - offset * DAY_MS).toISOString().slice(0, 10);
   const covered = coverage.get(day) ?? empty;
   windowDays.push({ day, ready: covered.ready, refused: covered.refused, unsupported: covered.unsupported,
    missing: count(activeOwners - covered.ready - covered.refused - covered.unsupported),
    published: days.has(day), publishedAt: publishedAtByDay.get(day) ?? null });
  }
  if (coverage.size > windowDays.length
   || [...coverage.keys()].some((day) => !windowDays.some((entry) => entry.day === day))) throw unavailable();
  const fitsRow = metadata[6]!.results[0] as { ready: number; no_fit: number } | undefined;
  const fitsReady = count(fitsRow?.ready ?? 0), fitsNoFit = count(fitsRow?.no_fit ?? 0);
  const currentFits = { day: today, ready: fitsReady, noFit: fitsNoFit,
   missing: count(activeOwners - fitsReady - fitsNoFit) };

  const refusalTotals = new Map<string, StorageCommunityProgressRefusal>();
  const refusalRows = metadata[7]!.results as { reason: unknown; owners: number }[];
  bounded(refusalRows.length);
  for (const row of refusalRows) {
   const reason = typeof row.reason === 'string' && COMMUNITY_MODEL_REFUSAL_REASONS.has(row.reason)
    ? row.reason : OTHER_REASON;
   const existing = refusalTotals.get(reason), owners = count(row.owners);
   if (existing) existing.owners = count(existing.owners + owners);
   else refusalTotals.set(reason, { reason, owners });
  }
  const refusals = [...refusalTotals.values()]
   .sort((a, b) => b.owners - a.owners || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));

  const selectionRow = metadata[8]!.results[0] as
   { total: number; pending: number; claimed: number; live: number } | undefined;
  bounded(count(selectionRow?.total ?? 0));
  const pendingSelections = count(selectionRow?.pending ?? 0), claimedSelections = count(selectionRow?.claimed ?? 0);
  const liveClaims = count(selectionRow?.live ?? 0);
  if (liveClaims > claimedSelections) throw unavailable();
  const claimedPosition = metadata[9]!.results[0] as
   { day: string; metric: string; claim_expires_ms: number } | undefined;
  const pendingPosition = metadata[10]!.results[0] as { day: string; metric: string } | undefined;
  const position = claimedPosition ?? pendingPosition ?? null;

  const phaseRows = metadata[11]!.results as { phase: unknown; stages: number; parts: number }[];
  const partsRow = metadata[12]!.results[0] as { total: number; bytes: number } | undefined;
  const phaseTotals = new Map<string, StorageCommunityProgressCheckpointPhase>();
  for (const row of phaseRows) {
   const name = checkpointPhase(row.phase);
   const existing = phaseTotals.get(name), stages = count(row.stages), parts = count(row.parts);
   if (existing) { existing.stages = count(existing.stages + stages); existing.parts = count(existing.parts + parts); }
   else phaseTotals.set(name, { phase: name, stages, parts });
  }
  const phases = [...phaseTotals.values()]
   .sort((a, b) => b.parts - a.parts || (a.phase < b.phase ? -1 : a.phase > b.phase ? 1 : 0));
  // Parts and bytes describe the same generations, so an uncounted part census
  // makes the whole block unavailable rather than an understated size.
  const checkpoints: StorageCommunityProgressCheckpoints | null =
   counted(phaseRows.length) === null || counted(count(partsRow?.total ?? 0)) === null ? null
    : { stages: count(phases.reduce((sum, entry) => sum + entry.stages, 0)),
      parts: count(phases.reduce((sum, entry) => sum + entry.parts, 0)),
      bytes: count(partsRow?.bytes ?? 0), phases };

  const throughputRow = metadata[13]!.results[0] as { total: number; last_hour: number } | undefined;
  const resultsLast6Hours = counted(count(throughputRow?.total ?? 0));
  const resultsLastHour = resultsLast6Hours === null ? null : count(throughputRow?.last_hour ?? 0);
  if (resultsLastHour !== null && resultsLast6Hours !== null && resultsLastHour > resultsLast6Hours) throw unavailable();
  const remainingResults = count(windowDays.reduce((sum, entry) => sum + entry.missing, 0) + currentFits.missing);
  const estimatedHoursRemaining = resultsLast6Hours === null || resultsLast6Hours === 0 ? null
   : Math.round(remainingResults / (resultsLast6Hours / 6) * 10) / 10;
  if (estimatedHoursRemaining !== null && !Number.isFinite(estimatedHoursRemaining)) throw unavailable();
  const staleResults = counted(count((metadata[14]!.results[0] as { total: number } | undefined)?.total));

  const workState: StorageCommunityProgressWorkState = liveClaims > 0 ? 'building'
   : pendingSelections > 0 || remainingResults > 0 ? 'queued' : 'idle';
  if (!await storageCommunityCalculationAuthorityIsCurrent(bindings.source, authority)) throw new Error('source changed');
  const activeCoverage = activeDay === null ? null : coverage.get(activeDay) ?? empty;
  const pipeline = await readStoragePipelineProgress(bindings, nowMs);
  return {
   ...(options.includePreparation ? { schemaVersion: 3 as const, preparation: null } : { schemaVersion: 3 as const }),
   generatedAt,
   pipeline,
   publication: { state: ready ? 'ready' as const : preview ? 'invalidated' as const : 'empty' as const,
    requestedGeneration: authority.sourceEpoch, preparedGeneration: phase === null ? authority.sourceEpoch : null,
    publishedGeneration: ready ? published!.sourceEpoch : null, publishedAt: ready ? preview!.generated_at : null },
   work: { state: workState, phase, updatedAt: updatedMs ? new Date(updatedMs).toISOString() : null,
    trigger: null, restartReason: null },
   history: { resolvedDays: days.size, requiredDays, activeDay,
    completeAccounts: activeCoverage === null ? null
     : count(activeCoverage.ready + activeCoverage.refused + activeCoverage.unsupported),
    requiredAccounts: activeOwners },
   graph: {
    window: { days: requiredDays, from: windowDays.at(-1)!.day, to: windowDays[0]!.day },
    owners: { active: activeOwners },
    currentFits,
    days: windowDays,
    refusals,
    work: { state: workState,
     activeDay: position === null ? null : utcDay(position.day),
     activeMetric: position === null ? null : metricOf(position.metric),
     leaseExpiresAt: claimedPosition === undefined ? null : instant(claimedPosition.claim_expires_ms),
     selections: { pending: pendingSelections, claimed: claimedSelections },
     checkpoints },
    throughput: { resultsLastHour, resultsLast6Hours, remainingResults, estimatedHoursRemaining },
    retirement: { staleResults },
   },
  };
 } catch { throw new ApiError(503, 'ADMIN_RECONSTRUCTION_PROGRESS_UNAVAILABLE'); }
}
