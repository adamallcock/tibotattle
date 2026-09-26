/**
 * D1 export oracle: the D1-side truth for the analytics history port.
 *
 * Operator-local tooling only. It runs the Worker's OWN analytics modules over
 * SCRATCH COPIES of the sealed ingestion, analytics and ledger exports and
 * re-implements no policy: authority, visibility, the daily publisher, the
 * graph lane, publication, retirement and the cache-retention lane are the
 * exact functions the deployed Worker runs. Several steps write (the
 * stale-head selector may publish, the forced recomputes bump the collection
 * revision and rebuild caches), so the caller must hand it disposable copies
 * and discard them afterwards, whatever the outcome. It is never bundled into
 * the Cloud Run image and never touches a live binding.
 *
 * Every step runs at the pinned instant (H10). Several Worker kernels stamp
 * `Date.now()` directly (graph results' computed_ms, for one, which gates the
 * preview's freshness), so for the duration of a run `Date.now()` reads
 * `pinnedNowMs` process-wide. One oracle runs per process at a time; a
 * concurrent call is refused with ORACLE_BUSY.
 *
 * The result is the closed, content-free `analytics-history-oracle-v2`
 * document (see analytics-history-proof.ts). Refusals are closed codes:
 *   ANALYTICS_EXPORT_NOT_QUIESCENT   the export was not drained (with reasons)
 *   ORACLE_NOT_CONVERGED             a forced recompute did not become idle
 *   ANALYTICS_EXPORT_INPUT_INVALID   caller arguments are malformed
 *   ANALYTICS_EXPORT_SCHEMA_INVALID  an export lacks a required table/row
 *   ANALYTICS_EXPORT_IDENTITY_MISMATCH  source identity differs across exports
 *   ANALYTICS_EXPORT_INTEGRITY_FAILED   a stored hash or head is inconsistent
 *   ORACLE_BUSY                      another oracle run holds the pinned clock
 */
import { ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS } from './admin-community-allowance';
import { setCollectionControls } from './admin-operations';
import {
  advanceCacheRetentionDayLane, createCacheRetentionDaySourceBuild, readCacheRetentionCommunitySeries,
} from './cache-retention-day';
import { canonicalJson } from './canonical-json';
import { readCollectionControls } from './collection-controls';
import { sha256Hex } from './crypto';
import {
  ANALYTICS_HISTORY_CACHE_RETENTION_TABLES, ANALYTICS_HISTORY_CANONICAL_TABLES, ANALYTICS_HISTORY_GRAPH_WINDOW_DAYS,
  ANALYTICS_HISTORY_ORACLE_SCHEMA, CanonicalTableHasher, analyticsHistoryGraphWindow, canonicalRowLine,
  liveCohortMemberLine, normalizedDailyPayloadSha256, normalizedModelDaySha256, normalizedPreviewSha256,
  validAnalyticsHistoryDay, validateAnalyticsHistoryFoldHistory, validateAnalyticsHistoryOracle,
  type AnalyticsHistoryDailyForced, type AnalyticsHistoryFenceAuthority, type AnalyticsHistoryFenceCounters,
  type AnalyticsHistoryFoldHistoryEntry, type AnalyticsHistoryOracle, type AnalyticsHistoryQuiescence,
  type AnalyticsHistoryTableDigest,
} from './analytics-history-proof';
import { advanceStorageAnalytics } from './storage-analytics-runtime';
import {
  captureStorageCommunityAuthority, readStorageCommunityDeliveredTerminalEpoch, readStorageCommunityOwnerPage,
  readStorageCommunitySourceTerminalEpoch, type StorageCommunityAuthority,
} from './storage-community-authority';
import { advanceNextStorageCommunityDaily, readPublishedStorageCommunityDaily } from './storage-community-daily';
import { STORAGE_GRAPH_METHOD } from './storage-community-graph';
import { advanceStorageCommunityGraphWork } from './storage-community-graph-work';
import {
  publishStorageCommunityGraphPreview, publishStorageCommunityModelDay, readPublishedStorageCommunityGraph,
  retireStorageCommunityGraphPublications,
} from './storage-community-graph-publication';
import { validStorageModelPublication, type StorageModelPublicationValue } from './storage-community-publication-value';
import type { StorageAnalyticsBindings } from './analytics-delivery';

export const D1_ANALYTICS_EXPORT_ORACLE_ERRORS = Object.freeze([
  'ANALYTICS_EXPORT_NOT_QUIESCENT', 'ORACLE_NOT_CONVERGED', 'ANALYTICS_EXPORT_INPUT_INVALID',
  'ANALYTICS_EXPORT_SCHEMA_INVALID', 'ANALYTICS_EXPORT_IDENTITY_MISMATCH', 'ANALYTICS_EXPORT_INTEGRITY_FAILED',
  'ORACLE_BUSY',
] as const);
export type D1AnalyticsExportOracleErrorCode = typeof D1_ANALYTICS_EXPORT_ORACLE_ERRORS[number];

export const ANALYTICS_EXPORT_NOT_QUIESCENT_REASONS = Object.freeze([
  'queue_rows', 'cursor_not_at_journal_max', 'cursor_receipt', 'terminal_undelivered',
  'erasure_jobs_pending', 'cache_retention_incomplete', 'stale_head',
] as const);
export type AnalyticsExportNotQuiescentReason = typeof ANALYTICS_EXPORT_NOT_QUIESCENT_REASONS[number];

export class D1AnalyticsExportOracleError extends Error {
  readonly code: D1AnalyticsExportOracleErrorCode;
  /** Closed reason tokens, never values. */
  readonly reasons: readonly AnalyticsExportNotQuiescentReason[];
  constructor(code: D1AnalyticsExportOracleErrorCode, reasons: readonly AnalyticsExportNotQuiescentReason[] = []) {
    super(code); this.code = code; this.reasons = Object.freeze([...reasons]);
  }
}
const refuse = (code: D1AnalyticsExportOracleErrorCode): D1AnalyticsExportOracleError =>
  new D1AnalyticsExportOracleError(code);

/** The collection-controls audit actor on the scratch copy. It never reaches a
 * live database; the audit row is discarded with the copy. */
const ORACLE_ACTOR_KEY = 'analytics-history-oracle-scratch';
const HASH_PAGE_ROWS = 500;
const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const CACHE_RETENTION_LANE_PASSES = 4_096;
/** The Worker's graph-cache tables. Both sides start the graph recompute with
 * all of them empty; published model days and the preview are left for the
 * Worker's own retirement to judge. */
const GRAPH_CACHE_TABLES = Object.freeze([
  'analytics_community_graph_results', 'analytics_community_graph_execution', 'analytics_community_graph_scan',
  'analytics_community_graph_work_selection', 'analytics_history_checkpoint_heads',
  'analytics_history_checkpoint_parts', 'analytics_history_checkpoint_stages',
]);

export type D1AnalyticsExportOracleStep = 'fence' | 'quiescence' | 'cohort' | 'selection'
  | 'cache_retention_resume' | 'daily_forced' | 'graph_forced' | 'cache_retention_rebuild';

export interface D1AnalyticsExportOracleInput {
  ingestion: D1Database; analytics: D1Database; ledger: D1Database;
  /** The drain's quiescent instant. Every time the oracle computes with. */
  pinnedNowMs: number;
  sourceId: string; sourceNamespace: string;
  /** The inventory's CACHE_RETENTION_FROM_DAY; null means every delivered day. */
  cacheRetentionFromDay: string | null;
  /** Informational FOLD history copied from the inventory. */
  foldHistory?: AnalyticsHistoryFoldHistoryEntry[];
  /** Digest of the exact oracle module inputs that ran (the bundle). */
  moduleDigest: string;
  /** Counts-only progress observer for operator logs. */
  onStep?: (step: D1AnalyticsExportOracleStep, counts: Readonly<Record<string, number>>) => void;
}

function bindings(input: D1AnalyticsExportOracleInput): StorageAnalyticsBindings {
  return { source: input.ingestion, target: input.analytics, sourceId: input.sourceId,
    sourceNamespace: input.sourceNamespace };
}

function count(value: unknown, code: D1AnalyticsExportOracleErrorCode = 'ANALYTICS_EXPORT_SCHEMA_INVALID'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw refuse(code);
  return value;
}

async function tableExists(database: D1Database, table: string): Promise<boolean> {
  return (await database.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?")
    .bind(table).first()) !== null;
}

/** Keyset-paged canonical digest of one whole table (primary-key order). */
export async function canonicalD1TableDigest(database: D1Database, table: string): Promise<AnalyticsHistoryTableDigest> {
  const projection = ANALYTICS_HISTORY_CANONICAL_TABLES[table];
  if (!projection) throw refuse('ANALYTICS_EXPORT_INPUT_INVALID');
  if (!await tableExists(database, table)) throw refuse('ANALYTICS_EXPORT_SCHEMA_INVALID');
  const columns = projection.columns.map(([name]) => name).join(',');
  const order = projection.orderBy.join(',');
  const key = projection.orderBy.length === 1 ? projection.orderBy[0]! : `(${order})`;
  const marker = projection.orderBy.length === 1 ? '?' : `(${projection.orderBy.map(() => '?').join(',')})`;
  const hasher = new CanonicalTableHasher();
  let after: unknown[] | null = null;
  for (;;) {
    const statement: D1PreparedStatement = after === null
      ? database.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${order} LIMIT ?`).bind(HASH_PAGE_ROWS)
      : database.prepare(`SELECT ${columns} FROM ${table} WHERE ${key}>${marker} ORDER BY ${order} LIMIT ?`)
        .bind(...after, HASH_PAGE_ROWS);
    const rows = (await statement.all<Record<string, unknown>>()).results;
    await hasher.add(rows.map(row => canonicalRowLine(projection, row)));
    if (rows.length < HASH_PAGE_ROWS) break;
    const last = rows.at(-1)!;
    after = projection.orderBy.map(name => last[name]);
  }
  return { rows: hasher.rows, sha256: await hasher.digest() };
}

async function seriesSha256(input: D1AnalyticsExportOracleInput): Promise<string> {
  const series = await readCacheRetentionCommunitySeries({ target: input.analytics, sourceId: input.sourceId,
    nowMs: input.pinnedNowMs });
  return sha256Hex(canonicalJson(series));
}

/** One bounded cache-retention lane pass at the pinned time, one shard. */
function cacheRetentionPass(input: D1AnalyticsExportOracleInput, maxDays: number) {
  const now = (): number => input.pinnedNowMs;
  return advanceCacheRetentionDayLane({ target: input.analytics, sourceId: input.sourceId,
    build: createCacheRetentionDaySourceBuild({ source: input.ingestion, target: input.analytics,
      sourceNamespace: input.sourceNamespace, now }),
    // A pinned clock never reaches the deadline; the statement allowance and
    // the pass bound below are what bound the work.
    deadlineMs: input.pinnedNowMs + 1, remainingQueries: 100_000, sourceQueries: 100_000,
    maxDays, maxWrites: 64, now, shardIndex: 0, shardCount: 1,
    ...(input.cacheRetentionFromDay === null ? {} : { fromDay: input.cacheRetentionFromDay }) });
}

async function runCacheRetentionToCompletion(input: D1AnalyticsExportOracleInput): Promise<number> {
  let built = 0;
  for (let pass = 0; pass < CACHE_RETENTION_LANE_PASSES; pass += 1) {
    const lane = await cacheRetentionPass(input, 64);
    built += lane.built;
    if (lane.state === 'idle') return built;
  }
  throw refuse('ORACLE_NOT_CONVERGED');
}

// ---------------------------------------------------------------------------
// (a) fence authority and counters
// ---------------------------------------------------------------------------

async function readFenceCounters(input: D1AnalyticsExportOracleInput,
  authority: StorageCommunityAuthority): Promise<AnalyticsHistoryFenceCounters> {
  const source = input.ingestion;
  const identity = await source.prepare(`SELECT s.source_id AS sourceId,s.authority_epoch AS authorityEpoch,
      a.source_namespace AS v1Namespace,b.source_namespace AS v11Namespace
    FROM storage_source_state s
    JOIN typed_v1_admission_state a ON a.id=1 AND a.runtime_contract_version=1
    JOIN typed_v11_admission_state b ON b.id=1 AND b.runtime_contract_version=1
    WHERE s.singleton=1`).first<{ sourceId: string; authorityEpoch: number; v1Namespace: string; v11Namespace: string }>();
  if (!identity) throw refuse('ANALYTICS_EXPORT_SCHEMA_INVALID');
  if (identity.sourceId !== input.sourceId || identity.v1Namespace !== input.sourceNamespace
    || identity.v11Namespace !== input.sourceNamespace) throw refuse('ANALYTICS_EXPORT_IDENTITY_MISMATCH');
  const v12 = await tableExists(source, 'telemetry_v12_runtime')
    ? await source.prepare('SELECT state,policy_revision AS policyRevision FROM telemetry_v12_runtime WHERE id=1')
      .first<{ state: 'staged' | 'active'; policyRevision: number }>()
    : null;
  if (v12 !== null && ((v12.state !== 'staged' && v12.state !== 'active') || count(v12.policyRevision) < 1)) {
    throw refuse('ANALYTICS_EXPORT_SCHEMA_INVALID');
  }
  const separation = await source.prepare('SELECT policy_revision AS policyRevision FROM ingestion_analytics_separation WHERE id=1')
    .first<{ policyRevision: number }>();
  const mutation = await source.prepare(`SELECT mutation_epoch AS mutationEpoch,
      graph_invalidation_epoch AS graphInvalidationEpoch FROM community_snapshot_mutation_control WHERE singleton_id=1`)
    .first<{ mutationEpoch: number; graphInvalidationEpoch: number }>();
  const bootstrap = await source.prepare(`SELECT completed,policy_version AS policyVersion
      FROM community_public_source_bootstrap WHERE singleton=1`).first<{ completed: number; policyVersion: string }>();
  if (!separation || !mutation || !bootstrap || typeof bootstrap.policyVersion !== 'string'
    || (bootstrap.completed !== 0 && bootstrap.completed !== 1)) throw refuse('ANALYTICS_EXPORT_SCHEMA_INVALID');
  const controls = await readCollectionControls(source);
  const journalMax = count(await source.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM storage_ingestion_changes')
    .first<number>('n'));
  // The authority stamp and the counters must describe the same fence.
  if (authority.sequence !== journalMax) throw refuse('ANALYTICS_EXPORT_INTEGRITY_FAILED');
  const journal = await canonicalD1TableDigest(source, 'storage_ingestion_changes');
  return {
    sourceId: identity.sourceId, v1Namespace: identity.v1Namespace, v11Namespace: identity.v11Namespace,
    v12Runtime: v12 === null ? null : { state: v12.state, policyRevision: v12.policyRevision },
    sourceAuthorityEpoch: count(identity.authorityEpoch), policyRevision: count(separation.policyRevision),
    collectionControls: { revision: controls.revision, enrollment: controls.enrollment,
      uploadRegistration: controls.uploadRegistration, processing: controls.processing,
      publication: controls.publication, controlState: controls.state },
    mutationEpoch: count(mutation.mutationEpoch), graphInvalidationEpoch: count(mutation.graphInvalidationEpoch),
    bootstrap: { completed: bootstrap.completed === 1, policyVersion: bootstrap.policyVersion },
    journal: { maxSequence: journalMax, rows: journal.rows, sha256: journal.sha256 },
    sourceTerminalEpoch: await readStorageCommunitySourceTerminalEpoch(source),
    deliveredTerminalEpoch: await readStorageCommunityDeliveredTerminalEpoch(input.analytics, input.sourceId),
    ownerRevisions: await canonicalD1TableDigest(source, 'storage_owner_revisions'),
    inputVersions: await canonicalD1TableDigest(source, 'community_analytical_input_versions'),
    ownerLinks: await canonicalD1TableDigest(source, 'storage_v11_owner_links'),
  };
}

// ---------------------------------------------------------------------------
// (b) quiescence
// ---------------------------------------------------------------------------

async function proveQuiescence(input: D1AnalyticsExportOracleInput,
  counters: AnalyticsHistoryFenceCounters): Promise<AnalyticsHistoryQuiescence> {
  const reasons: AnalyticsExportNotQuiescentReason[] = [];
  const queueRows = count(await input.analytics.prepare(
    'SELECT count(*) AS n FROM analytics_community_daily_queue WHERE source_id=?').bind(input.sourceId).first('n'));
  if (queueRows !== 0) reasons.push('queue_rows');
  const cursorSequence = count(await input.analytics.prepare(
    'SELECT COALESCE((SELECT sequence FROM analytics_source_cursors WHERE source_id=?),0) AS n')
    .bind(input.sourceId).first('n'));
  const journalMax = counters.journal.maxSequence;
  if (cursorSequence !== journalMax) reasons.push('cursor_not_at_journal_max');
  else {
    // The Worker's own ordinary-dispatch admission re-proves the cursor's
    // applied-event receipt against the journal row, field for field. At the
    // journal MAX there is no next change, so this reads only.
    try {
      const idle = await advanceStorageAnalytics(bindings(input));
      if (idle.state !== 'idle' || !('sequence' in idle) || idle.sequence !== journalMax) reasons.push('cursor_receipt');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message !== 'ANALYTICS_SOURCE_RESTORE_RECONCILIATION_REQUIRED'
        && message !== 'STORAGE_ANALYTICS_CONTRACT_UNAVAILABLE') throw error;
      reasons.push('cursor_receipt');
    }
  }
  if (counters.deliveredTerminalEpoch < counters.sourceTerminalEpoch) reasons.push('terminal_undelivered');
  if (!await tableExists(input.ledger, 'storage_erasure_jobs')) throw refuse('ANALYTICS_EXPORT_SCHEMA_INVALID');
  const pendingErasureJobs = count(await input.ledger.prepare(
    "SELECT count(*) AS n FROM storage_erasure_jobs WHERE state='pending'").first('n'));
  if (pendingErasureJobs !== 0) reasons.push('erasure_jobs_pending');
  if (reasons.length) throw new D1AnalyticsExportOracleError('ANALYTICS_EXPORT_NOT_QUIESCENT', reasons);
  // The two remaining probes are the Worker's own lanes and may write: they
  // run only after every read-only check held, on the scratch copy.
  const probe = await cacheRetentionPass(input, 64);
  const cacheRetentionIncompleteDays = count(probe.candidates);
  if (cacheRetentionIncompleteDays !== 0 || probe.state !== 'idle') {
    throw new D1AnalyticsExportOracleError('ANALYTICS_EXPORT_NOT_QUIESCENT', ['cache_retention_incomplete']);
  }
  const selector = await advanceNextStorageCommunityDaily({ ...bindings(input), preferStaleHead: true,
    nowMs: input.pinnedNowMs });
  if (selector.state !== 'idle') throw new D1AnalyticsExportOracleError('ANALYTICS_EXPORT_NOT_QUIESCENT', ['stale_head']);
  return { queueRows, staleHeadIdle: true, cursorSequence, journalMax,
    deliveredTerminal: counters.deliveredTerminalEpoch, sourceTerminal: counters.sourceTerminalEpoch,
    pendingErasureJobs, cacheRetentionIncompleteDays };
}

// ---------------------------------------------------------------------------
// (c) live cohort
// ---------------------------------------------------------------------------

async function readLiveCohort(source: D1Database): Promise<{ members: number; sha256: string }> {
  const hasher = new CanonicalTableHasher();
  let after = '';
  for (;;) {
    const page = await readStorageCommunityOwnerPage(source, { afterParticipantId: after, limit: 64 });
    await hasher.add(page.map(owner => liveCohortMemberLine(owner)));
    if (page.length < 64) break;
    after = page.at(-1)!.participantId;
  }
  return { members: hasher.rows, sha256: await hasher.digest() };
}

// ---------------------------------------------------------------------------
// (d) import selection
// ---------------------------------------------------------------------------

export interface D1AnalyticsImportSelection {
  daily: { day: string; revision: number; sha256: string }[];
  modelDays: { day: string; sha256: string }[];
  preview: { sha256: string } | null;
  /** Every daily head, imported whatever its latest revision's visibility. */
  heads: { day: string; revision: number }[];
}

async function modelDayRows(input: StorageAnalyticsBindings, window: readonly string[]):
  Promise<StorageModelPublicationValue[]> {
  return (await input.target.prepare(`SELECT day,authority_json,payload_json,payload_sha256
    FROM analytics_community_model_publications WHERE source_id=? AND method=? AND day BETWEEN ? AND ?
    ORDER BY day`).bind(input.sourceId, STORAGE_GRAPH_METHOD, window[0], window.at(-1))
    .all<StorageModelPublicationValue>()).results;
}

async function visibleModelDays(input: StorageAnalyticsBindings, pinnedNowMs: number):
  Promise<Map<string, string>> {
  const window = analyticsHistoryGraphWindow(pinnedNowMs);
  const authority = await captureStorageCommunityAuthority(input.source, input);
  const terminal = Math.max(await readStorageCommunitySourceTerminalEpoch(input.source),
    await readStorageCommunityDeliveredTerminalEpoch(input.target, input.sourceId));
  const visible = new Map<string, string>();
  for (const row of await modelDayRows(input, window)) {
    if (await validStorageModelPublication(row, authority, terminal)) {
      visible.set(row.day, await normalizedModelDaySha256(row.payload_json));
    }
  }
  return visible;
}

/**
 * What the HX import may carry: per day the MAX revision, and only when the
 * Worker's own public reader would serve it (never an older revision); the
 * STORAGE_GRAPH_METHOD model days the graph lane treats as complete inside the
 * window; and the preview the Worker's own reader serves. Heads are listed in
 * full, because they are imported whatever their latest revision's state.
 * Hashes are normalized (H10) so they compare with recomputed values.
 */
export async function readD1AnalyticsImportSelection(input: StorageAnalyticsBindings & { pinnedNowMs: number }):
  Promise<D1AnalyticsImportSelection> {
  const heads = (await input.target.prepare(`SELECT day,revision FROM analytics_community_daily_heads
    WHERE source_id=? ORDER BY day`).bind(input.sourceId).all<{ day: string; revision: number }>()).results;
  const maxRevisions = new Map((await input.target.prepare(`SELECT day,MAX(revision) AS revision
    FROM analytics_community_daily_publications WHERE source_id=? GROUP BY day`).bind(input.sourceId)
    .all<{ day: string; revision: number }>()).results.map(row => [row.day, row.revision]));
  for (const head of heads) {
    const latest = maxRevisions.get(head.day);
    if (!validAnalyticsHistoryDay(head.day) || (latest !== undefined && latest !== head.revision)) {
      throw refuse('ANALYTICS_EXPORT_INTEGRITY_FAILED');
    }
  }
  const daily: D1AnalyticsImportSelection['daily'] = [];
  const days = [...maxRevisions.keys()].sort();
  if (days.length) {
    const first = Date.parse(days[0]!), last = Date.parse(days.at(-1)!);
    for (let from = first; from <= last; from += 366 * 86_400_000) {
      const through = Math.min(last, from + 365 * 86_400_000);
      const read = await readPublishedStorageCommunityDaily({ ...input,
        fromDay: new Date(from).toISOString().slice(0, 10), throughDay: new Date(through).toISOString().slice(0, 10) });
      for (const row of read.rows) {
        // The reader returns only the MAX revision of a day, and only when it
        // is visible; it never substitutes an older one.
        if (maxRevisions.get(row.day) !== row.revision) throw refuse('ANALYTICS_EXPORT_INTEGRITY_FAILED');
        daily.push({ day: row.day, revision: row.revision, sha256: await normalizedDailyPayloadSha256(row.payload_json) });
      }
    }
  }
  const models = await visibleModelDays(input, input.pinnedNowMs);
  const previewRow = await readPublishedStorageCommunityGraph(input, input.pinnedNowMs);
  return {
    daily,
    modelDays: [...models.entries()].map(([day, sha256]) => ({ day, sha256 })),
    preview: previewRow === null ? null : { sha256: await normalizedPreviewSha256(previewRow.payload_json) },
    heads,
  };
}

// ---------------------------------------------------------------------------
// (f) forced daily recompute
// ---------------------------------------------------------------------------

/** The same collection-revision bump the GCP side applies: identical flags,
 * reason drill_restore, expected revision = current. Every head becomes stale. */
async function bumpCollectionRevision(input: D1AnalyticsExportOracleInput): Promise<number> {
  const controls = await readCollectionControls(input.ingestion);
  const bumped = await setCollectionControls(input.ingestion, ORACLE_ACTOR_KEY, {
    enrollment: controls.enrollment, uploadRegistration: controls.uploadRegistration,
    processing: controls.processing, publication: controls.publication,
  }, 'drill_restore', controls.revision, input.pinnedNowMs);
  return bumped.revision;
}

async function forceDailyRecompute(input: D1AnalyticsExportOracleInput,
  imported: ReadonlyMap<string, string>): Promise<{ entries: AnalyticsHistoryDailyForced[]; iterations: number }> {
  await input.analytics.prepare('DELETE FROM analytics_community_daily_owners WHERE source_id=?')
    .bind(input.sourceId).run();
  const heads = count(await input.analytics.prepare(
    'SELECT count(*) AS n FROM analytics_community_daily_heads WHERE source_id=?').bind(input.sourceId).first('n'));
  const bound = Math.max(1, heads) * 64;
  let iterations = 0;
  for (;;) {
    if (iterations >= bound) throw refuse('ORACLE_NOT_CONVERGED');
    iterations += 1;
    const step = await advanceNextStorageCommunityDaily({ ...bindings(input), preferStaleHead: true,
      nowMs: input.pinnedNowMs });
    if (step.state === 'idle') break;
  }
  const rows = (await input.analytics.prepare(`SELECT h.day,h.cohort_digest,p.payload_json,p.payload_sha256
    FROM analytics_community_daily_heads h JOIN analytics_community_daily_publications p
      ON p.source_id=h.source_id AND p.day=h.day AND p.revision=h.revision
    WHERE h.source_id=? ORDER BY h.day`).bind(input.sourceId)
    .all<{ day: string; cohort_digest: string; payload_json: string; payload_sha256: string }>()).results;
  if (rows.length !== heads) throw refuse('ANALYTICS_EXPORT_INTEGRITY_FAILED');
  const entries: AnalyticsHistoryDailyForced[] = [];
  for (const row of rows) {
    if (!SHA.test(row.cohort_digest) || await sha256Hex(row.payload_json) !== row.payload_sha256) {
      throw refuse('ANALYTICS_EXPORT_INTEGRITY_FAILED');
    }
    const recomputedSha256 = await normalizedDailyPayloadSha256(row.payload_json);
    const importedSha256 = imported.get(row.day) ?? null;
    entries.push({ day: row.day, cohortDigest: row.cohort_digest, recomputedSha256, importedSha256,
      d1Drift: importedSha256 !== null && importedSha256 !== recomputedSha256 });
  }
  return { entries, iterations };
}

// ---------------------------------------------------------------------------
// (g) forced graph recompute
// ---------------------------------------------------------------------------

async function clearGraphCaches(analytics: D1Database): Promise<void> {
  for (const table of GRAPH_CACHE_TABLES) {
    if (!await tableExists(analytics, table)) throw refuse('ANALYTICS_EXPORT_SCHEMA_INVALID');
  }
  // Live checkpoint heads guard their stages and parts; release them first.
  await analytics.batch(GRAPH_CACHE_TABLES.map(table => analytics.prepare(`DELETE FROM ${table}`)));
}

/**
 * The Worker's graph lane order (runGraphLane): one work step with the fold
 * off, then the model day it completed, then the preview, then retirement,
 * all at the pinned time. The lane is idle for the window once a whole
 * rotation of every current position and history tick changes nothing.
 */
async function forceGraphRecompute(input: D1AnalyticsExportOracleInput, cohortMembers: number):
  Promise<{ modelDays: { day: string; recomputedSha256: string | null }[]; previewSha256: string | null;
    iterations: number }> {
  await clearGraphCaches(input.analytics);
  const b = bindings(input);
  const members = Math.max(1, cohortMembers);
  const bound = ANALYTICS_HISTORY_GRAPH_WINDOW_DAYS * members * 64;
  const rotation = 6 * members + 6;
  let quiet = 0, iterations = 0;
  while (quiet < rotation) {
    if (iterations >= bound) throw refuse('ORACLE_NOT_CONVERGED');
    iterations += 1;
    const graph = await advanceStorageCommunityGraphWork({ ...b, nowMs: input.pinnedNowMs, preparedFold: false });
    let changed = graph.state !== 'reused' && graph.state !== 'idle';
    if (graph.state === 'complete' || graph.state === 'reused') {
      if (graph.metric === 'model' && graph.day) {
        const model = await publishStorageCommunityModelDay(b, { day: graph.day, nowMs: input.pinnedNowMs });
        if (model.state === 'published') changed = true;
      }
      const preview = await publishStorageCommunityGraphPreview(b, { nowMs: input.pinnedNowMs });
      if (preview.state === 'published') changed = true;
    }
    if (await retireStorageCommunityGraphPublications(b, input.pinnedNowMs) > 0) changed = true;
    quiet = changed ? 0 : quiet + 1;
  }
  const window = analyticsHistoryGraphWindow(input.pinnedNowMs);
  const visible = await visibleModelDays(b, input.pinnedNowMs);
  const preview = await readPublishedStorageCommunityGraph(b, input.pinnedNowMs);
  return { modelDays: window.map(day => ({ day, recomputedSha256: visible.get(day) ?? null })),
    previewSha256: preview === null ? null : await normalizedPreviewSha256(preview.payload_json), iterations };
}

// ---------------------------------------------------------------------------
// (h) cache-retention rebuild
// ---------------------------------------------------------------------------

async function rebuildCacheRetention(input: D1AnalyticsExportOracleInput):
  Promise<{ seriesSha256: string; tables: Record<string, string>; built: number }> {
  for (const table of ANALYTICS_HISTORY_CACHE_RETENTION_TABLES) {
    if (!await tableExists(input.analytics, table)) throw refuse('ANALYTICS_EXPORT_SCHEMA_INVALID');
  }
  await input.analytics.batch(ANALYTICS_HISTORY_CACHE_RETENTION_TABLES.map(table =>
    input.analytics.prepare(`DELETE FROM ${table}`)));
  const built = await runCacheRetentionToCompletion(input);
  const tables: Record<string, string> = {};
  for (const table of ANALYTICS_HISTORY_CACHE_RETENTION_TABLES) {
    tables[table] = (await canonicalD1TableDigest(input.analytics, table)).sha256;
  }
  return { seriesSha256: await seriesSha256(input), tables, built };
}

function validateInput(input: D1AnalyticsExportOracleInput): void {
  const handles = [input?.ingestion, input?.analytics, input?.ledger];
  if (!input || handles.some(handle => !handle || typeof handle.prepare !== 'function'
      || typeof handle.batch !== 'function') || new Set(handles).size !== 3
    || !Number.isSafeInteger(input.pinnedNowMs) || input.pinnedNowMs <= 0
    || typeof input.sourceId !== 'string' || !SOURCE_ID.test(input.sourceId)
    || typeof input.sourceNamespace !== 'string' || input.sourceNamespace.length < 1
    || input.sourceNamespace.length > 256
    || (input.cacheRetentionFromDay !== null && !validAnalyticsHistoryDay(input.cacheRetentionFromDay))
    || typeof input.moduleDigest !== 'string' || !SHA.test(input.moduleDigest)
    || (input.onStep !== undefined && typeof input.onStep !== 'function')) throw refuse('ANALYTICS_EXPORT_INPUT_INVALID');
  try { validateAnalyticsHistoryFoldHistory(input.foldHistory ?? []); }
  catch { throw refuse('ANALYTICS_EXPORT_INPUT_INVALID'); }
  if (ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS !== ANALYTICS_HISTORY_GRAPH_WINDOW_DAYS) {
    throw refuse('ANALYTICS_EXPORT_SCHEMA_INVALID');
  }
}

async function assertSingleSource(input: D1AnalyticsExportOracleInput): Promise<void> {
  const rows = (await input.analytics.prepare(
    'SELECT source_id,source_namespace,contract_version FROM analytics_runtime_sources').all<{
      source_id: string; source_namespace: string; contract_version: number }>()).results;
  // The graph and cache-retention caches are cleared table-wide, so an export
  // serving more than one source is refused rather than partially rebuilt.
  if (rows.length !== 1) throw refuse('ANALYTICS_EXPORT_SCHEMA_INVALID');
  if (rows[0]!.source_id !== input.sourceId || rows[0]!.source_namespace !== input.sourceNamespace
    || rows[0]!.contract_version !== 1) throw refuse('ANALYTICS_EXPORT_IDENTITY_MISMATCH');
}

let pinnedClockHeld = false;

/** Run `operation` with `Date.now()` reading `nowMs`, then restore the clock. */
async function withPinnedClock<T>(nowMs: number, operation: () => Promise<T>): Promise<T> {
  if (pinnedClockHeld) throw refuse('ORACLE_BUSY');
  pinnedClockHeld = true;
  const original = Date.now;
  Date.now = () => nowMs;
  try {
    return await operation();
  } finally {
    Date.now = original;
    pinnedClockHeld = false;
  }
}

/**
 * Run steps (a)-(h) in order over scratch copies, at the pinned instant. The
 * returned document has passed the closed validator.
 */
export async function runD1AnalyticsExportOracle(input: D1AnalyticsExportOracleInput): Promise<AnalyticsHistoryOracle> {
  validateInput(input);
  return withPinnedClock(input.pinnedNowMs, () => runPinnedOracle(input));
}

async function runPinnedOracle(input: D1AnalyticsExportOracleInput): Promise<AnalyticsHistoryOracle> {
  const step = (name: D1AnalyticsExportOracleStep, counts: Record<string, number>): void => {
    input.onStep?.(name, Object.freeze({ ...counts }));
  };
  await assertSingleSource(input);

  // (a) Fence authority and counters.
  const captured = await captureStorageCommunityAuthority(input.ingestion,
    { sourceId: input.sourceId, sourceNamespace: input.sourceNamespace });
  const fenceAuthority: AnalyticsHistoryFenceAuthority = {
    sourceId: captured.sourceId, sourceNamespace: captured.sourceNamespace,
    publicAuthorityEpoch: captured.publicAuthorityEpoch, policyRevision: captured.policyRevision,
    collectionRevision: captured.collectionRevision, graphInvalidationEpoch: captured.graphInvalidationEpoch,
    sourceEpoch: captured.sourceEpoch, sequence: captured.sequence,
  };
  const fenceCounters = await readFenceCounters(input, captured);
  step('fence', { journalRows: fenceCounters.journal.rows, ownerRevisions: fenceCounters.ownerRevisions.rows });

  // (b) Quiescence, re-proved from the exports.
  const quiescence = await proveQuiescence(input, fenceCounters);
  step('quiescence', { queueRows: quiescence.queueRows, pendingErasureJobs: quiescence.pendingErasureJobs });

  // (c) Live cohort.
  const liveCohort = await readLiveCohort(input.ingestion);
  step('cohort', { members: liveCohort.members });

  // (d) Import selection, before anything is recomputed.
  const selection = await readD1AnalyticsImportSelection({ ...bindings(input), pinnedNowMs: input.pinnedNowMs });
  step('selection', { daily: selection.daily.length, heads: selection.heads.length,
    modelDays: selection.modelDays.length, preview: selection.preview === null ? 0 : 1 });

  // (e) Cache-retention resume, before any bump.
  const resumed = await runCacheRetentionToCompletion(input);
  const resumeSeriesSha256 = await seriesSha256(input);
  step('cache_retention_resume', { built: resumed });

  // (f) Forced daily recompute after the bump.
  await bumpCollectionRevision(input);
  const daily = await forceDailyRecompute(input,
    new Map(selection.daily.map(entry => [entry.day, entry.sha256])));
  step('daily_forced', { heads: daily.entries.length, iterations: daily.iterations,
    d1Drift: daily.entries.filter(entry => entry.d1Drift).length });

  // (g) Forced graph recompute from empty graph caches, fold off.
  const graph = await forceGraphRecompute(input, liveCohort.members);
  step('graph_forced', { iterations: graph.iterations,
    modelDays: graph.modelDays.filter(entry => entry.recomputedSha256 !== null).length,
    preview: graph.previewSha256 === null ? 0 : 1 });

  // (h) Cache-retention rebuild from zero.
  const rebuilt = await rebuildCacheRetention(input);
  step('cache_retention_rebuild', { built: rebuilt.built });

  return validateAnalyticsHistoryOracle({
    schema: ANALYTICS_HISTORY_ORACLE_SCHEMA,
    pinnedNowMs: input.pinnedNowMs,
    fenceAuthority,
    fenceCounters,
    quiescence,
    liveCohort,
    importSelection: { daily: selection.daily, modelDays: selection.modelDays, preview: selection.preview },
    dailyForced: daily.entries,
    graphForced: { modelDays: graph.modelDays, previewSha256: graph.previewSha256 },
    cacheRetention: { fromDay: input.cacheRetentionFromDay, resumeSeriesSha256,
      rebuildSeriesSha256: rebuilt.seriesSha256, rebuildTableSha256: rebuilt.tables },
    foldHistory: (input.foldHistory ?? []).map(entry => ({ value: entry.value, fromMs: entry.fromMs,
      untilMs: entry.untilMs })),
    moduleDigest: input.moduleDigest,
  });
}
