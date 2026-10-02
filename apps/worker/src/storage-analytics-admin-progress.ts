import type { StorageAnalyticsBindings } from './analytics-delivery';
import { readAnalyticsPipelineRuntime } from './storage-analytics-runtime-controls';

const LIMIT = 10_000;
const HOUR = 3_600_000;
export const ADMIN_ANALYTICS_STAGES = ['canonical', 'features', 'activity', 'fits', 'cache', 'publication', 'cleanup'] as const;
export const ADMIN_ANALYTICS_REASONS = ['delivery', 'dependencies', 'evidence', 'query_budget', 'deadline', 'capacity', 'retry', 'scheduled', 'other'] as const;
type Stage = typeof ADMIN_ANALYTICS_STAGES[number];
type Reason = typeof ADMIN_ANALYTICS_REASONS[number];
export interface AdminAnalyticsQueueDetail {
 fromDay: string | null; throughDay: string | null;
 latestCompletedAt: string | null; completedLastHour: number; completedLast6Hours: number;
 latestUpdatedAt: string | null; lastFailureAt: string | null;
 delayed: number; retrying: number; expiredLeases: number;
 reasons: { code: Reason; jobs: number }[];
}
export interface AdminAnalyticsQueue {
 ready: number; leased: number; complete: number; refused: number;
 detail: AdminAnalyticsQueueDetail | null;
}
export interface AdminAnalyticsStore {
 unit: 'feature_days' | 'rolling_segments' | 'activity_parts' | 'cache_days';
 retained: number; complete: number | null; headMatched: number | null;
 fromDay: string | null; throughDay: string | null;
 latestUpdatedAt: string | null; updatedLastHour: number | null; updatedLast6Hours: number | null;
 inputEvents: number | null; adjacencyPairs: number | null;
}
export interface AdminAnalyticsPublication {
 unit: 'days' | 'snapshot'; retained: number; fromDay: string | null; throughDay: string | null;
 latestPublishedAt: string | null; publishedLastHour: number; publishedLast6Hours: number;
 /** This compact read does not run the source-authority or dependency proof. */
 freshness: 'not_checked';
}
export interface AdminAnalyticsRuntime {
 role: 'analytics' | 'publication' | 'cache'; method: 'maintained-analytics-v1';
 canonicalEnabled: boolean; sharedFeaturesEnabled: boolean; modelBlocksEnabled: boolean;
 degree: 1 | 2 | 4 | 8; maxQueries: number; observedAt: string;
}
export interface AdminMaintainedPipeline {
 schemaVersion: 1;
 queues: Record<Stage, AdminAnalyticsQueue> | null;
 stores: Record<'features' | 'rolling' | 'activity' | 'cache', AdminAnalyticsStore | null>;
 publications: Record<'daily' | 'model' | 'cache', AdminAnalyticsPublication | null>;
 runtime: AdminAnalyticsRuntime[] | null;
}
const integer = (value: unknown): number => {
 if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('admin_metadata_invalid');
 return value;
};
const time = (value: unknown): string | null => {
 if (value === null) return null;
 const epoch = integer(value);
 if (!Number.isFinite(new Date(epoch).getTime())) throw new Error('admin_metadata_invalid');
 return new Date(epoch).toISOString();
};
const day = (value: unknown): string | null => {
 if (value === null) return null;
 if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
  || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw new Error('admin_metadata_invalid');
 return value;
};
async function isolated<T>(read: () => Promise<T>): Promise<T | null> {
 try { return await read(); } catch { return null; }
}
/** Codes are classified before aggregation. Unknown tokens never cross the
 * admin boundary: even a syntactically valid token may contain private text. */
const REASON_SQL = `CASE
 WHEN reason_code IN('source_prefix_pending','delivery_pending','owner_unavailable','source_binding_unavailable') THEN 'delivery'
 WHEN reason_code IN('query_budget') THEN 'query_budget'
 WHEN reason_code IN('deadline','deadline_exceeded') THEN 'deadline'
 WHEN reason_code IN('capacity','publication_capacity','partition_capacity','analytics_work_capacity') THEN 'capacity'
 WHEN reason_code IN('usage_row_refused','input_scope_invalid','partition_invalid','unsupported_work_stage','native_kernel_refused') OR state='refused' THEN 'evidence'
 WHEN reason_code IN('lease_changed','retry','producer_failed','producer_error') THEN 'retry'
 WHEN reason_code IN('source_changed','source_prefix_changed','manifest_changed','canonical_effects_pending','cohort_pending',
 'cache_partition_changed','cache_coverage_pending','cache_completion_pending','closure_changed','publication_changed',
 'expected_capture_pending','window_preparation_pending','session_proofs_pending','rolling_scope_pending','rolling_pending',
 'features_pending','partition_pending','producer_deferred','deferred') THEN 'dependencies'
 WHEN reason_code IS NULL THEN 'scheduled' ELSE 'other' END`;

/** At most 28 compact population rows plus 10,001 queue metadata rows. A
 * capped detail read leaves exact compact populations intact and detail null. */
async function queues(db: D1Database, sourceId: string, nowMs: number): Promise<AdminMaintainedPipeline['queues']> {
 return isolated(async () => {
  const hooks = await db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name IN
   ('analytics_partition_counts_insert','analytics_partition_counts_state','analytics_partition_counts_delete')`).first<number>('n');
  if (hooks !== 3) throw new Error('admin_metadata_missing');
  const rows = (await db.prepare('SELECT stage,state,jobs FROM analytics_partition_work_counts WHERE source_id=? LIMIT 29')
   .bind(sourceId).all<{ stage: Stage; state: 'ready' | 'leased' | 'complete' | 'refused'; jobs: number }>()).results;
  if (rows.length > 28) throw new Error('admin_metadata_invalid');
  const result = Object.fromEntries(ADMIN_ANALYTICS_STAGES.map(stage => [stage,
   { ready: 0, leased: 0, complete: 0, refused: 0, detail: null }])) as Record<Stage, AdminAnalyticsQueue>;
  for (const row of rows) {
   if (!ADMIN_ANALYTICS_STAGES.includes(row.stage) || !['ready','leased','complete','refused'].includes(row.state)) throw new Error('admin_metadata_invalid');
   result[row.stage][row.state] = integer(row.jobs);
  }
  let inconsistent = false;
  const detail = await isolated(async () => {
   const rows = (await db.prepare(`WITH bounded AS (SELECT stage,state,day,updated_ms,ready_ms,attempts,claim_expires_ms,reason_code
    FROM analytics_partition_work WHERE source_id=? LIMIT ${LIMIT + 1})
    SELECT stage,state,${REASON_SQL} reason,COUNT(*) jobs,MIN(day) from_day,MAX(day) through_day,
     MAX(updated_ms) latest, SUM(updated_ms>=?) last_hour,SUM(updated_ms>=?) last_six,
     SUM(state='ready' AND ready_ms>?) delayed,SUM(state='ready' AND attempts>0) retrying,
     SUM(state='leased' AND claim_expires_ms<=?) expired FROM bounded GROUP BY stage,state,reason`)
    .bind(sourceId, nowMs - HOUR, nowMs - 6 * HOUR, nowMs, nowMs)
    .all<{ stage: Stage; state: string; reason: Reason; jobs: number; from_day: string | null; through_day: string | null;
     latest: number; last_hour: number; last_six: number; delayed: number; retrying: number; expired: number }>()).results;
   const total = rows.reduce((sum, row) => sum + integer(row.jobs), 0);
   const population = Object.values(result).reduce((sum, row) => sum + row.ready + row.leased + row.complete + row.refused, 0);
   if (total > LIMIT) throw new Error('admin_metadata_partial');
   if (total !== population) { inconsistent = true; throw new Error('admin_metadata_inconsistent'); }
   for (const stage of ADMIN_ANALYTICS_STAGES) {
    const selected = rows.filter(row => row.stage === stage), active = selected.filter(row => row.state !== 'complete');
    const completed = selected.filter(row => row.state === 'complete');
    const latest = (items: typeof rows) => items.length ? time(Math.max(...items.map(row => integer(row.latest)))) : null;
    const reasons = ADMIN_ANALYTICS_REASONS.map(code => ({ code,
     jobs: active.filter(row => row.reason === code).reduce((sum, row) => sum + integer(row.jobs), 0) })).filter(row => row.jobs > 0);
    const dates = selected.flatMap(row => [day(row.from_day), day(row.through_day)]).filter((value): value is string => value !== null).sort();
    result[stage].detail = { fromDay: dates[0] ?? null, throughDay: dates.at(-1) ?? null,
     latestCompletedAt: latest(completed), latestUpdatedAt: latest(selected),
     lastFailureAt: latest(active.filter(row => row.state === 'refused' || row.reason === 'retry')),
     completedLastHour: completed.reduce((sum, row) => sum + integer(row.last_hour), 0),
     completedLast6Hours: completed.reduce((sum, row) => sum + integer(row.last_six), 0),
     delayed: active.reduce((sum, row) => sum + integer(row.delayed), 0),
     retrying: active.reduce((sum, row) => sum + integer(row.retrying), 0),
     expiredLeases: active.reduce((sum, row) => sum + integer(row.expired), 0), reasons };
   }
  });
  if (inconsistent) throw new Error('admin_metadata_inconsistent');
  if (detail === null) for (const stage of ADMIN_ANALYTICS_STAGES) result[stage].detail = null;
  return result;
 });
}

async function store(db: D1Database, sourceId: string, nowMs: number, unit: AdminAnalyticsStore['unit'], sql: string,
 hasTime: boolean, hasComplete: boolean, hasHead: boolean): Promise<AdminAnalyticsStore | null> {
 return isolated(async () => {
  const row = await db.prepare(`SELECT COUNT(*) retained,SUM(complete) complete,SUM(head_matched) head_matched,
   MIN(day) from_day,MAX(day) through_day,MAX(updated_ms) latest,
   SUM(updated_ms>=?2) last_hour,SUM(updated_ms>=?3) last_six,SUM(input_events) input_events,SUM(pairs) pairs
   FROM (${sql} LIMIT ${LIMIT + 1})`).bind(sourceId, nowMs - HOUR, nowMs - 6 * HOUR).first<Record<string, unknown>>();
  if (!row || integer(row.retained) > LIMIT) throw new Error('admin_metadata_partial');
  return { unit, retained: integer(row.retained), complete: hasComplete ? integer(row.complete ?? 0) : null,
   headMatched: hasHead ? integer(row.head_matched ?? 0) : null, fromDay: day(row.from_day), throughDay: day(row.through_day),
   latestUpdatedAt: hasTime ? time(row.latest) : null, updatedLastHour: hasTime ? integer(row.last_hour ?? 0) : null,
   updatedLast6Hours: hasTime ? integer(row.last_six ?? 0) : null,
   inputEvents: unit === 'cache_days' ? integer(row.input_events ?? 0) : null, adjacencyPairs: null };
 });
}

async function publication(db: D1Database, sourceId: string, nowMs: number, unit: AdminAnalyticsPublication['unit'], sql: string): Promise<AdminAnalyticsPublication | null> {
 return isolated(async () => {
  const row = await db.prepare(`SELECT COUNT(*) retained,MIN(day) from_day,MAX(day) through_day,MAX(published_ms) latest,
   SUM(published_ms>=?2) last_hour,SUM(published_ms>=?3) last_six FROM (${sql} LIMIT ${LIMIT + 1})`)
   .bind(sourceId, nowMs - HOUR, nowMs - 6 * HOUR).first<Record<string, unknown>>();
  if (!row || integer(row.retained) > LIMIT) throw new Error('admin_metadata_partial');
  return { unit, retained: integer(row.retained), fromDay: day(row.from_day), throughDay: day(row.through_day),
   latestPublishedAt: time(row.latest), publishedLastHour: integer(row.last_hour ?? 0), publishedLast6Hours: integer(row.last_six ?? 0), freshness: 'not_checked' };
 });
}

/** Read-only closed metadata, never source facts, feature payloads or histories.
 * Each unavailable or capped population stays null independently. */
export async function readAdminMaintainedPipeline(bindings: StorageAnalyticsBindings, nowMs: number): Promise<AdminMaintainedPipeline> {
 const db = bindings.target, sourceId = bindings.sourceId;
 const [queue, features, rolling, activity, cache, daily, model, cachePublication, runtime] = await Promise.all([
  queues(db, sourceId, nowMs),
  store(db, sourceId, nowMs, 'feature_days', `SELECT day,state='complete' complete,NULL head_matched,updated_ms,NULL input_events,NULL pairs
   FROM analytics_shared_feature_days WHERE source_id=?1`, true, true, false),
  store(db, sourceId, nowMs, 'rolling_segments', `SELECT day,state='complete' complete,NULL head_matched,NULL updated_ms,NULL input_events,NULL pairs
   FROM analytics_canonical_rolling_segments WHERE source_id=?1`, false, true, false),
  store(db, sourceId, nowMs, 'activity_parts', `SELECT p.day,1 complete,
   EXISTS(SELECT 1 FROM analytics_canonical_publication_part_heads h JOIN analytics_canonical_partition_heads c
    ON c.partition_key=h.partition_key AND c.content_revision=p.content_revision WHERE h.source_id=p.source_id AND h.revision=p.revision) head_matched,
   p.created_ms updated_ms,NULL input_events,NULL pairs FROM analytics_canonical_publication_parts p WHERE p.source_id=?1`, true, true, true),
  store(db, sourceId, nowMs, 'cache_days', `SELECT day,NULL complete,NULL head_matched,NULL updated_ms,events_read input_events,NULL pairs
   FROM analytics_canonical_cache_days WHERE source_id=?1`, false, false, false),
  publication(db, sourceId, nowMs, 'days', `SELECT h.day,CAST((julianday(p.released_at)-2440587.5)*86400000 AS INTEGER) published_ms
   FROM analytics_community_daily_heads h JOIN analytics_community_daily_publications p ON p.source_id=h.source_id AND p.day=h.day AND p.revision=h.revision WHERE h.source_id=?1`),
  publication(db, sourceId, nowMs, 'days', 'SELECT day,computed_ms published_ms FROM analytics_community_model_publications WHERE source_id=?1'),
  publication(db, sourceId, nowMs, 'snapshot', 'SELECT anchor_day day,computed_ms published_ms FROM analytics_canonical_cache_publications WHERE source_id=?1'),
  isolated(async () => {
   const rows = await readAnalyticsPipelineRuntime(db, sourceId);
   return rows === null ? null : rows.map(row => ({ role: row.role, method: row.method,
    canonicalEnabled: row.canonicalPipeline, sharedFeaturesEnabled: row.sharedFeatures,
    modelBlocksEnabled: row.modelBlocks, degree: row.degree, maxQueries: row.queryLimit,
    observedAt: time(row.observedMs)! }));
  }),
 ]);
 if (cache) cache.adjacencyPairs = await isolated(async () => {
  const row = await db.prepare(`SELECT COUNT(*) groups,COALESCE(SUM(adjacencies),0) pairs FROM
   (SELECT adjacencies FROM analytics_canonical_cache_counters WHERE source_id=? LIMIT ${LIMIT + 1})`).bind(sourceId).first<{ groups: number; pairs: number }>();
  if (!row || integer(row.groups) > LIMIT) throw new Error('admin_metadata_partial');
  return integer(row.pairs);
 });
 return { schemaVersion: 1, queues: queue, stores: { features, rolling, activity, cache },
  publications: { daily, model, cache: cachePublication }, runtime };
}
