import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';

/**
 * The analytics-history reproduction contract shared by the D1 export oracle
 * (HX-4) and the PostgreSQL verification (HX-5). Pure: no database access.
 *
 * Everything here is content-free by construction. The oracle document holds
 * counts, closed states, public day strings and sha256 values of public
 * aggregates or of whole tables; it never holds an owner digest, a
 * participant, device or session identifier, a path or any payload text. The
 * closed validator refuses any key it does not name, so a later field cannot
 * slip identifiers into a receipt unreviewed.
 */

export const ANALYTICS_HISTORY_ORACLE_SCHEMA = 'analytics-history-oracle-v2';
/** The admin allowance preview window the graph lane maintains (days). The
 * oracle refuses to run if the Worker constant ever differs. */
export const ANALYTICS_HISTORY_GRAPH_WINDOW_DAYS = 70;
export const ANALYTICS_HISTORY_ORACLE_MAX_BYTES = 4 * 1024 * 1024;
export const ANALYTICS_HISTORY_FOLD_HISTORY_LIMIT = 256;

export class AnalyticsHistoryProofError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const invalid = (): AnalyticsHistoryProofError => new AnalyticsHistoryProofError('ANALYTICS_HISTORY_ORACLE_INVALID');

// ---------------------------------------------------------------------------
// Payload normalization (H10)
// ---------------------------------------------------------------------------

function parsedObject(value: string | object): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw invalid(); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  return parsed as Record<string, unknown>;
}

function without(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) if (!keys.includes(key)) copy[key] = value[key];
  return copy;
}

/** The three top-level keys that differ between two revisions of the same
 * published daily content. Nothing else is stripped: a changed total, cell,
 * spend figure or schema version is a real difference. */
export const DAILY_PAYLOAD_REVISION_KEYS = Object.freeze(['revision', 'releasedAt', 'aggregateId']);

export async function normalizedDailyPayloadSha256(payload: string | object): Promise<string> {
  return sha256Hex(canonicalJson(without(parsedObject(payload), DAILY_PAYLOAD_REVISION_KEYS)));
}

/** A model day's payload carries its ready or refused state; all of it counts. */
export async function normalizedModelDaySha256(payload: string | object): Promise<string> {
  return sha256Hex(canonicalJson(parsedObject(payload)));
}

/** The preview without its generation instant. Freshness columns live beside
 * the payload and are never part of it. */
export async function normalizedPreviewSha256(payload: string | object): Promise<string> {
  return sha256Hex(canonicalJson(without(parsedObject(payload), ['generatedAt'])));
}

// ---------------------------------------------------------------------------
// Canonical table hashing (shared with the HX-2 codec)
// ---------------------------------------------------------------------------

/**
 * Column projection types. `i64` renders a decimal string, `f64` uses
 * Number#toString, `json_bytes` keeps the stored text byte for byte and
 * `json_canonical` re-serializes the parsed value with `canonicalJson`. NULL
 * stays null. One row is `canonicalJson([...projected values])`.
 *
 * A table digest is sha256 over the concatenation of `sha256(rowLine) + "\n"`
 * for every row in primary-key order (BINARY on SQLite, COLLATE "C" on
 * PostgreSQL). It does not depend on how the rows were paged, so each side
 * may page as its driver prefers.
 */
export type AnalyticsHistoryColumnType = 'text' | 'i64' | 'f64' | 'json_bytes' | 'json_canonical';
export interface AnalyticsHistoryTableProjection {
  readonly orderBy: readonly string[];
  readonly columns: readonly (readonly [string, AnalyticsHistoryColumnType])[];
}

const projection = (orderBy: string[], columns: [string, AnalyticsHistoryColumnType][]):
  AnalyticsHistoryTableProjection => Object.freeze({ orderBy: Object.freeze(orderBy),
  columns: Object.freeze(columns.map(column => Object.freeze(column))) });

/** Fence tables of the ingestion export (H4) and the cache-retention tables
 * the oracle rebuilds (H1, V4b). HX-2's codec must hash these exactly so. */
export const ANALYTICS_HISTORY_CANONICAL_TABLES: Readonly<Record<string, AnalyticsHistoryTableProjection>> = Object.freeze({
  storage_ingestion_changes: projection(['sequence'], [['sequence', 'i64'], ['event_digest', 'text'],
    ['owner_digest', 'text'], ['revision', 'i64'], ['kind', 'text'], ['object_digest', 'text'],
    ['content_digest', 'text'], ['authority_epoch', 'i64'], ['public_authority_epoch', 'i64'],
    ['recorded_ms', 'i64']]),
  storage_owner_revisions: projection(['owner_digest'], [['owner_digest', 'text'], ['revision', 'i64'],
    ['authority_epoch', 'i64'], ['state', 'text']]),
  community_analytical_input_versions: projection(['participant_id'], [['participant_id', 'text'],
    ['revision', 'i64']]),
  storage_v11_owner_links: projection(['participant_id'], [['participant_id', 'text'], ['owner_digest', 'text'],
    ['state', 'text'], ['generation_id', 'text'], ['head_revision', 'i64'], ['object_digest', 'text'],
    ['manifest_digest', 'text']]),
  analytics_cache_retention_day_marks: projection(['mark_key'], [['mark_key', 'text'], ['source_id', 'text'],
    ['source_layout', 'text'], ['source_namespace', 'text'], ['owner_digest', 'text'], ['device_id', 'text'],
    ['manifest_id', 'text'], ['manifest_digest', 'text'], ['day', 'text'], ['method_version', 'text'],
    ['carry_digest', 'text'], ['carry_days', 'i64'], ['value_count', 'i64'], ['events_read', 'i64'],
    ['unreadable_events', 'i64'], ['values_digest', 'text'], ['refusal', 'text']]),
  analytics_cache_retention_day_carry: projection(['mark_key', 'day'], [['mark_key', 'text'], ['day', 'text'],
    ['source_id', 'text'], ['owner_digest', 'text'], ['device_id', 'text'], ['manifest_digest', 'text']]),
  analytics_cache_retention_day_values: projection(['value_key'], [['value_key', 'text'], ['mark_key', 'text'],
    ['source_id', 'text'], ['owner_digest', 'text'], ['day', 'text'], ['method_version', 'text'],
    ['carry_digest', 'text'], ['model', 'text'], ['effort', 'text'], ['adjacencies', 'i64'],
    ['sessions', 'i64'], ['bands_digest', 'text']]),
  analytics_cache_retention_day_bands: projection(['value_key', 'band'], [['value_key', 'text'], ['band', 'text'],
    ['source_id', 'text'], ['owner_digest', 'text'], ['day', 'text'], ['method_version', 'text'],
    ['adjacencies', 'i64'], ['reused_more_than_half', 'i64'], ['matched_or_exceeded', 'i64'],
    ['unordered_ties', 'i64'], ['excluded_insufficient_evidence', 'i64'],
    ['excluded_context_contracted', 'i64'], ['sessions', 'i64']]),
  analytics_cache_retention_day_progress: projection(['progress_key'], [['progress_key', 'text'],
    ['source_id', 'text'], ['source_layout', 'text'], ['source_namespace', 'text'], ['owner_digest', 'text'],
    ['device_id', 'text'], ['manifest_id', 'text'], ['manifest_digest', 'text'], ['day', 'text'],
    ['method_version', 'text'], ['carry_digest', 'text'], ['progress_revision', 'i64'],
    ['state_json', 'json_bytes'], ['state_digest', 'text']]),
});

/** The cache-retention tables in the order a rebuild must clear them: marks
 * first, so the retained-row triggers of the lower tiers release their rows. */
export const ANALYTICS_HISTORY_CACHE_RETENTION_TABLES = Object.freeze([
  'analytics_cache_retention_day_marks',
  'analytics_cache_retention_day_progress',
  'analytics_cache_retention_day_values',
  'analytics_cache_retention_day_bands',
  'analytics_cache_retention_day_carry',
]);

export function canonicalColumnValue(type: AnalyticsHistoryColumnType, value: unknown): string | null {
  if (value === null) return null;
  switch (type) {
    case 'text':
    case 'json_bytes':
      if (typeof value !== 'string') throw invalid();
      return value;
    case 'i64':
      if (typeof value === 'bigint') return value.toString(10);
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid();
      return String(value);
    case 'f64':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid();
      return value.toString();
    case 'json_canonical':
      if (typeof value !== 'string') throw invalid();
      try { return canonicalJson(JSON.parse(value)); } catch { throw invalid(); }
  }
}

export function canonicalRowLine(projectionValue: AnalyticsHistoryTableProjection,
  row: Record<string, unknown>): string {
  return canonicalJson(projectionValue.columns.map(([name, type]) => {
    if (!Object.hasOwn(row, name)) throw invalid();
    return canonicalColumnValue(type, row[name]);
  }));
}

/** Order-sensitive, paging-independent digest of canonical lines. */
export class CanonicalTableHasher {
  #rows = 0;
  #digests: string[] = [];
  async add(lines: readonly string[]): Promise<void> {
    const digests = await Promise.all(lines.map(line => sha256Hex(line)));
    for (const digest of digests) this.#digests.push(`${digest}\n`);
    this.#rows += lines.length;
  }
  get rows(): number { return this.#rows; }
  async digest(): Promise<string> { return sha256Hex(this.#digests.join('')); }
}

/** One live-cohort member line: the complete owner-page row, never partial. */
export function liveCohortMemberLine(owner: {
  participantId: string; ownerDigest: string | null; inputRevision: number; ownerRevision: number;
  authorityEpoch: number; hasV1: boolean; hasV11: boolean; hasV12: boolean; hasLegacy: boolean;
  hasEffective?: boolean;
}): string {
  return canonicalJson({ participantId: owner.participantId, ownerDigest: owner.ownerDigest,
    inputRevision: owner.inputRevision, ownerRevision: owner.ownerRevision, authorityEpoch: owner.authorityEpoch,
    hasV1: owner.hasV1, hasV11: owner.hasV11, hasV12: owner.hasV12, hasLegacy: owner.hasLegacy,
    hasEffective: owner.hasEffective === true });
}

// ---------------------------------------------------------------------------
// The oracle document (closed)
// ---------------------------------------------------------------------------

export interface AnalyticsHistoryTableDigest { rows: number; sha256: string }
export interface AnalyticsHistoryFenceAuthority {
  sourceId: string; sourceNamespace: string; publicAuthorityEpoch: number; policyRevision: number;
  collectionRevision: number; graphInvalidationEpoch: number; sourceEpoch: number; sequence: number;
}
export interface AnalyticsHistoryFenceCounters {
  sourceId: string; v1Namespace: string; v11Namespace: string;
  v12Runtime: { state: 'staged' | 'active'; policyRevision: number } | null;
  sourceAuthorityEpoch: number; policyRevision: number;
  collectionControls: { revision: number; enrollment: boolean; uploadRegistration: boolean;
    processing: boolean; publication: boolean; controlState: 'operational' | 'degraded' | 'contained' };
  mutationEpoch: number; graphInvalidationEpoch: number;
  bootstrap: { completed: boolean; policyVersion: string };
  journal: { maxSequence: number; rows: number; sha256: string };
  sourceTerminalEpoch: number; deliveredTerminalEpoch: number;
  ownerRevisions: AnalyticsHistoryTableDigest; inputVersions: AnalyticsHistoryTableDigest;
  ownerLinks: AnalyticsHistoryTableDigest;
}
export interface AnalyticsHistoryQuiescence {
  queueRows: number; staleHeadIdle: boolean; cursorSequence: number; journalMax: number;
  deliveredTerminal: number; sourceTerminal: number; pendingErasureJobs: number;
  cacheRetentionIncompleteDays: number;
}
export interface AnalyticsHistoryDailyForced {
  day: string; cohortDigest: string; recomputedSha256: string; importedSha256: string | null; d1Drift: boolean;
}
export interface AnalyticsHistoryFoldHistoryEntry {
  value: 'enabled' | 'disabled'; fromMs: number; untilMs: number | null;
}
export interface AnalyticsHistoryOracle {
  schema: typeof ANALYTICS_HISTORY_ORACLE_SCHEMA;
  pinnedNowMs: number;
  fenceAuthority: AnalyticsHistoryFenceAuthority;
  fenceCounters: AnalyticsHistoryFenceCounters;
  quiescence: AnalyticsHistoryQuiescence;
  liveCohort: { members: number; sha256: string };
  importSelection: {
    daily: { day: string; revision: number; sha256: string }[];
    modelDays: { day: string; sha256: string }[];
    preview: { sha256: string } | null;
  };
  dailyForced: AnalyticsHistoryDailyForced[];
  graphForced: { modelDays: { day: string; recomputedSha256: string | null }[]; previewSha256: string | null };
  cacheRetention: { fromDay: string | null; resumeSeriesSha256: string; rebuildSeriesSha256: string;
    rebuildTableSha256: Record<string, string> };
  foldHistory: AnalyticsHistoryFoldHistoryEntry[];
  moduleDigest: string;
}

const SHA = /^[0-9a-f]{64}$/u;
const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/u;

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw invalid();
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}
function positive(value: unknown): number {
  if (count(value) < 1) throw invalid();
  return value as number;
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !SHA.test(value)) throw invalid();
  return value;
}
function shaOrNull(value: unknown): string | null { return value === null ? null : sha(value); }
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}
export function validAnalyticsHistoryDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString().slice(0, 10) === value;
}
function day(value: unknown): string {
  if (!validAnalyticsHistoryDay(value)) throw invalid();
  return value;
}
function namespace(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) throw invalid();
  return value;
}
function tableDigest(value: unknown): void {
  const digest = object(value, ['rows', 'sha256']);
  count(digest.rows); sha(digest.sha256);
}
function strictlyAscendingDays<T extends { day: string }>(entries: readonly T[]): void {
  for (let index = 1; index < entries.length; index += 1) {
    if (!(entries[index - 1]!.day < entries[index]!.day)) throw invalid();
  }
}

/** The graph window the oracle records: seventy consecutive UTC days ending
 * on the pinned day. */
export function analyticsHistoryGraphWindow(pinnedNowMs: number): string[] {
  if (!Number.isSafeInteger(pinnedNowMs) || pinnedNowMs < 0) throw invalid();
  const today = Date.parse(new Date(pinnedNowMs).toISOString().slice(0, 10));
  return Array.from({ length: ANALYTICS_HISTORY_GRAPH_WINDOW_DAYS }, (_, index) =>
    new Date(today - (ANALYTICS_HISTORY_GRAPH_WINDOW_DAYS - 1 - index) * 86_400_000).toISOString().slice(0, 10));
}

export function validateAnalyticsHistoryFoldHistory(value: unknown): AnalyticsHistoryFoldHistoryEntry[] {
  if (!Array.isArray(value) || value.length > ANALYTICS_HISTORY_FOLD_HISTORY_LIMIT) throw invalid();
  let previous = -1;
  for (const raw of value) {
    const entry = object(raw, ['value', 'fromMs', 'untilMs']);
    if (entry.value !== 'enabled' && entry.value !== 'disabled') throw invalid();
    const from = count(entry.fromMs);
    if (from <= previous) throw invalid();
    if (entry.untilMs !== null && count(entry.untilMs) < from) throw invalid();
    previous = from;
  }
  return value as AnalyticsHistoryFoldHistoryEntry[];
}

/** Closed validator: every object has exactly its named keys, every value its
 * type, every array its order. Anything else refuses the whole document. */
export function validateAnalyticsHistoryOracle(value: unknown): AnalyticsHistoryOracle {
  const root = object(value, ['schema', 'pinnedNowMs', 'fenceAuthority', 'fenceCounters', 'quiescence',
    'liveCohort', 'importSelection', 'dailyForced', 'graphForced', 'cacheRetention', 'foldHistory', 'moduleDigest']);
  if (root.schema !== ANALYTICS_HISTORY_ORACLE_SCHEMA) throw invalid();
  const pinnedNowMs = count(root.pinnedNowMs);

  const authority = object(root.fenceAuthority, ['sourceId', 'sourceNamespace', 'publicAuthorityEpoch',
    'policyRevision', 'collectionRevision', 'graphInvalidationEpoch', 'sourceEpoch', 'sequence']);
  if (typeof authority.sourceId !== 'string' || !SOURCE_ID.test(authority.sourceId)) throw invalid();
  namespace(authority.sourceNamespace);
  count(authority.publicAuthorityEpoch); positive(authority.policyRevision); positive(authority.collectionRevision);
  count(authority.graphInvalidationEpoch); count(authority.sourceEpoch); count(authority.sequence);

  const counters = object(root.fenceCounters, ['sourceId', 'v1Namespace', 'v11Namespace', 'v12Runtime',
    'sourceAuthorityEpoch', 'policyRevision', 'collectionControls', 'mutationEpoch', 'graphInvalidationEpoch',
    'bootstrap', 'journal', 'sourceTerminalEpoch', 'deliveredTerminalEpoch', 'ownerRevisions', 'inputVersions',
    'ownerLinks']);
  if (counters.sourceId !== authority.sourceId) throw invalid();
  namespace(counters.v1Namespace); namespace(counters.v11Namespace);
  if (counters.v12Runtime !== null) {
    const runtime = object(counters.v12Runtime, ['state', 'policyRevision']);
    if (runtime.state !== 'staged' && runtime.state !== 'active') throw invalid();
    positive(runtime.policyRevision);
  }
  count(counters.sourceAuthorityEpoch); positive(counters.policyRevision);
  const controls = object(counters.collectionControls, ['revision', 'enrollment', 'uploadRegistration',
    'processing', 'publication', 'controlState']);
  positive(controls.revision);
  bool(controls.enrollment); bool(controls.uploadRegistration); bool(controls.processing); bool(controls.publication);
  if (!['operational', 'degraded', 'contained'].includes(controls.controlState as string)) throw invalid();
  count(counters.mutationEpoch); count(counters.graphInvalidationEpoch);
  const bootstrap = object(counters.bootstrap, ['completed', 'policyVersion']);
  bool(bootstrap.completed);
  if (typeof bootstrap.policyVersion !== 'string' || !/^[a-z0-9.-]{1,64}$/u.test(bootstrap.policyVersion)) throw invalid();
  const journal = object(counters.journal, ['maxSequence', 'rows', 'sha256']);
  count(journal.maxSequence); count(journal.rows); sha(journal.sha256);
  count(counters.sourceTerminalEpoch); count(counters.deliveredTerminalEpoch);
  tableDigest(counters.ownerRevisions); tableDigest(counters.inputVersions); tableDigest(counters.ownerLinks);

  const quiescence = object(root.quiescence, ['queueRows', 'staleHeadIdle', 'cursorSequence', 'journalMax',
    'deliveredTerminal', 'sourceTerminal', 'pendingErasureJobs', 'cacheRetentionIncompleteDays']);
  // A document exists only for a quiescent export.
  if (count(quiescence.queueRows) !== 0 || bool(quiescence.staleHeadIdle) !== true
    || count(quiescence.cursorSequence) !== count(quiescence.journalMax)
    || count(quiescence.deliveredTerminal) < count(quiescence.sourceTerminal)
    || count(quiescence.pendingErasureJobs) !== 0 || count(quiescence.cacheRetentionIncompleteDays) !== 0
    || quiescence.journalMax !== journal.maxSequence) throw invalid();

  const cohort = object(root.liveCohort, ['members', 'sha256']);
  count(cohort.members); sha(cohort.sha256);

  const selection = object(root.importSelection, ['daily', 'modelDays', 'preview']);
  if (!Array.isArray(selection.daily) || !Array.isArray(selection.modelDays)) throw invalid();
  for (const raw of selection.daily) {
    const entry = object(raw, ['day', 'revision', 'sha256']);
    day(entry.day); positive(entry.revision); sha(entry.sha256);
  }
  strictlyAscendingDays(selection.daily as { day: string }[]);
  const window = analyticsHistoryGraphWindow(pinnedNowMs);
  for (const raw of selection.modelDays) {
    const entry = object(raw, ['day', 'sha256']);
    if (!window.includes(day(entry.day))) throw invalid();
    sha(entry.sha256);
  }
  strictlyAscendingDays(selection.modelDays as { day: string }[]);
  if (selection.preview !== null) sha(object(selection.preview, ['sha256']).sha256);

  if (!Array.isArray(root.dailyForced)) throw invalid();
  for (const raw of root.dailyForced) {
    const entry = object(raw, ['day', 'cohortDigest', 'recomputedSha256', 'importedSha256', 'd1Drift']);
    day(entry.day); sha(entry.cohortDigest); sha(entry.recomputedSha256);
    const imported = shaOrNull(entry.importedSha256);
    if (bool(entry.d1Drift) !== (imported !== null && imported !== entry.recomputedSha256)) throw invalid();
  }
  strictlyAscendingDays(root.dailyForced as { day: string }[]);

  const graph = object(root.graphForced, ['modelDays', 'previewSha256']);
  if (!Array.isArray(graph.modelDays) || graph.modelDays.length !== window.length) throw invalid();
  graph.modelDays.forEach((raw, index) => {
    const entry = object(raw, ['day', 'recomputedSha256']);
    if (entry.day !== window[index]) throw invalid();
    shaOrNull(entry.recomputedSha256);
  });
  shaOrNull(graph.previewSha256);

  const retention = object(root.cacheRetention, ['fromDay', 'resumeSeriesSha256', 'rebuildSeriesSha256',
    'rebuildTableSha256']);
  if (retention.fromDay !== null) day(retention.fromDay);
  sha(retention.resumeSeriesSha256); sha(retention.rebuildSeriesSha256);
  const tables = object(retention.rebuildTableSha256, ANALYTICS_HISTORY_CACHE_RETENTION_TABLES);
  for (const table of ANALYTICS_HISTORY_CACHE_RETENTION_TABLES) sha(tables[table]);

  validateAnalyticsHistoryFoldHistory(root.foldHistory);
  sha(root.moduleDigest);
  if (new TextEncoder().encode(canonicalJson(root)).byteLength > ANALYTICS_HISTORY_ORACLE_MAX_BYTES) throw invalid();
  return root as unknown as AnalyticsHistoryOracle;
}

// ---------------------------------------------------------------------------
// Reproduction classification (H8 P2-P4, V3), closed counts of newSchema
// ---------------------------------------------------------------------------

export interface AnalyticsHistoryDailyCounts {
  heads: number; oracleMismatch: number; cohortDigestMismatch: number; unexplained: number;
  d1RecomputeDrift: number; foldRowsMismatch: number; foldRowsNotComparable: number;
}
export interface AnalyticsHistoryGcpDailyHead {
  day: string; cohortDigest: string; recomputedSha256: string; importedSha256: string | null;
}

/**
 * P3: every head day's normalized recompute and cohort digest equal the
 * oracle's; a head present on only one side is a mismatch of both. P2: an
 * imported day whose GCP recompute differs from it is unexplained unless the
 * oracle recorded the same D1 drift. P4 fold comparison counts are measured by
 * the caller and carried through.
 */
export function classifyDailyReproduction(oracle: Pick<AnalyticsHistoryOracle, 'dailyForced'>, gcp: {
  heads: readonly AnalyticsHistoryGcpDailyHead[]; foldRowsMismatch: number; foldRowsNotComparable: number;
}): AnalyticsHistoryDailyCounts {
  const expected = new Map(oracle.dailyForced.map(entry => [entry.day, entry]));
  const actual = new Map<string, AnalyticsHistoryGcpDailyHead>();
  for (const head of gcp.heads) {
    day(head.day); sha(head.cohortDigest); sha(head.recomputedSha256); shaOrNull(head.importedSha256);
    if (actual.has(head.day)) throw invalid();
    actual.set(head.day, head);
  }
  let oracleMismatch = 0, cohortDigestMismatch = 0, unexplained = 0;
  for (const dayValue of new Set([...expected.keys(), ...actual.keys()])) {
    const want = expected.get(dayValue), got = actual.get(dayValue);
    if (!want || !got) { oracleMismatch += 1; cohortDigestMismatch += 1; }
    else {
      if (want.recomputedSha256 !== got.recomputedSha256) oracleMismatch += 1;
      if (want.cohortDigest !== got.cohortDigest) cohortDigestMismatch += 1;
    }
    if (got && got.importedSha256 !== null && got.importedSha256 !== got.recomputedSha256
      && want?.d1Drift !== true) unexplained += 1;
  }
  return { heads: expected.size, oracleMismatch, cohortDigestMismatch, unexplained,
    d1RecomputeDrift: oracle.dailyForced.filter(entry => entry.d1Drift).length,
    foldRowsMismatch: count(gcp.foldRowsMismatch), foldRowsNotComparable: count(gcp.foldRowsNotComparable) };
}

export interface AnalyticsHistoryGraphCounts {
  modelDays: number; oracleMismatch: number; modelDayPresenceMismatch: number; previewMismatch: number;
  d1RecomputeDrift: number;
}

/**
 * V3: every window day's model recompute must equal the oracle's, including
 * whether a day exists at all, and so must the preview. d1RecomputeDrift
 * counts imported model days whose D1 recompute differs from what D1 was
 * serving; it is informational and never a mismatch.
 */
export function classifyGraphReproduction(oracle: Pick<AnalyticsHistoryOracle, 'graphForced' | 'importSelection'>,
  gcp: { modelDays: readonly { day: string; recomputedSha256: string | null }[]; previewSha256: string | null }):
  AnalyticsHistoryGraphCounts {
  const expected = new Map(oracle.graphForced.modelDays.map(entry => [entry.day, entry.recomputedSha256]));
  const actual = new Map<string, string | null>();
  for (const entry of gcp.modelDays) {
    day(entry.day); shaOrNull(entry.recomputedSha256);
    if (actual.has(entry.day)) throw invalid();
    actual.set(entry.day, entry.recomputedSha256);
  }
  shaOrNull(gcp.previewSha256);
  let oracleMismatch = 0, modelDayPresenceMismatch = 0;
  for (const dayValue of new Set([...expected.keys(), ...actual.keys()])) {
    const want = expected.get(dayValue) ?? null, got = actual.get(dayValue) ?? null;
    if ((want === null) !== (got === null)) modelDayPresenceMismatch += 1;
    else if (want !== null && want !== got) oracleMismatch += 1;
  }
  const d1RecomputeDrift = oracle.importSelection.modelDays
    .filter(entry => (expected.get(entry.day) ?? null) !== entry.sha256).length;
  return { modelDays: expected.size, oracleMismatch, modelDayPresenceMismatch,
    previewMismatch: oracle.graphForced.previewSha256 === gcp.previewSha256 ? 0 : 1, d1RecomputeDrift };
}
