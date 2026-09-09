import {
  COMMUNITY_ATTRIBUTION_METHOD_VERSION, COMMUNITY_MODEL_CACHE_MAX_BYTES,
  COMPOSITION_CACHE_KEY_SUFFIX, V1_FIT_CACHE_KEY_SUFFIX, parsedCachedFits,
  validCompleteCachedComposition,
  type CachedCommunityAllowanceCorpus, type CachedCommunityModelCompositions,
  type CommunityAllowanceFit, type CommunityModelCacheReadBudget,
} from "./community-allowance";
import { V1_ANALYSIS_WINDOW_DAYS, V1_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "./quota-analysis-v1";
import { V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "./quota-analysis-v11";

/** Bounds are per invocation/page, not a physical participant admission limit. */
export const COMMUNITY_PUBLICATION_PAGE_SIZE = 64;
export const COMMUNITY_PUBLICATION_PAGE_BYTES = 2 * 1024 * 1024;
const DAY_MS = 86_400_000;
type Source = "v0.2" | "v1" | "mixed" | "v1.1";
interface Head {
  generation: string; utc_day: string; from_day: string; method_version: string;
  source_epoch: number; hard_epoch: number; cache_revision: number;
  membership_watermark: number; capture_cursor: number; load_cursor: number;
  phase: "capturing" | "loading" | "ready" | "retiring"; published: number;
  member_count: number; prepared_count: number; payload_bytes: number; progress_revision: number;
}
interface Control { mutation_epoch: number; graph_invalidation_epoch: number; cache_revision: number; }
export interface CommunityPublicationOptions { budget: CommunityModelCacheReadBudget; maxPages?: number; }
export interface CommunityPublicationProgress {
  status: "ready" | "deferred" | "unavailable";
  generation?: string; sourceEpoch?: number; hardEpoch?: number;
  memberCount?: number; preparedCount?: number; payloadBytes?: number;
}
export interface CapturedCommunityPublication {
  generation: string;
  /** Epoch when capture began, NOT a claim that every input is current at that epoch. */
  sourceEpoch: number;
  hardEpoch: number;
  corpus: CachedCommunityAllowanceCorpus;
  compositions: CachedCommunityModelCompositions;
}
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const fingerprint = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const utf8 = (value: string): number => new TextEncoder().encode(value).byteLength;
function charge(budget: CommunityModelCacheReadBudget, queries = 1): boolean {
  const now = (budget.now ?? Date.now)(), reserve = budget.reserveQueries ?? 0;
  if (!count(budget.remainingQueries) || !count(reserve) || !Number.isFinite(now)
      || !Number.isFinite(budget.deadlineMs) || now >= budget.deadlineMs
      || budget.remainingQueries - reserve < queries) return false;
  budget.remainingQueries -= queries;
  return true;
}
function validHead(head: Head): boolean {
  return typeof head.generation === "string" && head.generation.length === 36
    && [head.source_epoch, head.hard_epoch, head.cache_revision, head.membership_watermark,
      head.capture_cursor, head.load_cursor, head.member_count, head.prepared_count,
      head.payload_bytes, head.progress_revision].every(count)
    && head.hard_epoch <= head.source_epoch && head.prepared_count <= head.member_count
    && head.payload_bytes <= COMMUNITY_MODEL_CACHE_MAX_BYTES
    && ["capturing", "loading", "ready", "retiring"].includes(head.phase)
    && [0, 1].includes(head.published);
}
const CONTROL_SQL = `SELECT s.mutation_epoch,s.graph_invalidation_epoch,c.revision AS cache_revision
  FROM community_snapshot_mutation_control s,community_publication_changes c
  WHERE s.singleton_id=1 AND c.singleton=1`;
const HEAD_SQL = "SELECT * FROM community_publication_generation WHERE singleton=1";

/** Bound to a precise immutable generation and the immediate hard/privacy fence. */
export const COMMUNITY_PUBLICATION_AUTHORITY_SQL = `EXISTS (
  SELECT 1 FROM community_publication_generation g,community_snapshot_mutation_control s
  WHERE g.singleton=1 AND g.generation=?1 AND g.phase='ready'
    AND g.source_epoch=?2 AND g.hard_epoch=?3 AND g.method_version=?4
    AND s.singleton_id=1 AND s.graph_invalidation_epoch=g.hard_epoch
    AND s.mutation_epoch>=g.source_epoch AND g.prepared_count=g.member_count)`;

export function communityPublicationAuthoritySql(firstParameter: number): string {
  if (!count(firstParameter) || firstParameter < 1 || firstParameter > 90) throw new TypeError("invalid publication SQL offset");
  return COMMUNITY_PUBLICATION_AUTHORITY_SQL.replace(/\?(\d+)/gu, (_match, index: string) => `?${Number(index)+firstParameter-1}`);
}

function guard(head: Head): string {
  return `EXISTS (SELECT 1 FROM community_publication_generation g,community_snapshot_mutation_control s
    WHERE g.singleton=1 AND g.generation='${head.generation}' AND g.progress_revision=${head.progress_revision}
      AND s.singleton_id=1 AND s.graph_invalidation_epoch=${head.hard_epoch})`;
}
// UUIDs enter SQL only after this stricter internal check; all external/cache
// strings remain bound parameters. Progress revisions are safe integers.
function writableHead(head: Head): boolean {
  return validHead(head) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(head.generation);
}
function progress(head: Head, status: CommunityPublicationProgress["status"]): CommunityPublicationProgress {
  return { status, generation: head.generation, sourceEpoch: head.source_epoch, hardEpoch: head.hard_epoch,
    memberCount: head.member_count, preparedCount: head.prepared_count, payloadBytes: head.payload_bytes };
}

const SOURCE_FLAGS = `EXISTS (SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id
    AND c.status='accepted' AND c.transport_schema_version='telemetry-contribution-v0.2') AS has_legacy,
  EXISTS (SELECT 1 FROM telemetry_v1_chunks c INDEXED BY telemetry_v1_chunks_current_identity
    WHERE c.participant_id=p.id AND c.superseded_at IS NULL) AS has_v1,
  EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id=p.id) AS has_v11`;
interface MembershipRow {
  member_id: number; participant_id: string; input_revision: number;
  has_legacy: number; has_v1: number; has_v11: number; legacy_overlap: number;
}
const CAPTURE_SQL = `WITH candidates AS MATERIALIZED (
  SELECT q.id AS member_id,p.id AS participant_id,v.revision AS input_revision,${SOURCE_FLAGS}
  FROM community_current_analysis_queue q JOIN participants p ON p.id=q.participant_id AND p.state='active'
  JOIN community_analytical_input_versions v ON v.participant_id=p.id
  WHERE q.id>?1 AND q.id<=?2 AND (
    EXISTS (SELECT 1 FROM telemetry_v1_chunks c INDEXED BY telemetry_v1_chunks_current_identity
      WHERE c.participant_id=p.id AND c.superseded_at IS NULL)
    OR EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id=p.id)
    OR EXISTS (SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id
      AND c.status='accepted' AND c.transport_schema_version='telemetry-contribution-v0.2'))
  ORDER BY q.id LIMIT ?3)
SELECT *,CASE WHEN has_v11=0 AND has_v1=1 AND has_legacy=1 THEN EXISTS (
  SELECT 1 FROM telemetry_records r INDEXED BY telemetry_records_participant_time
  WHERE r.participant_id=candidates.participant_id AND r.observed_at>=?4 AND r.record_kind='quota'
    AND r.provider='openai_codex' AND r.limit_id='codex' AND EXISTS (
      SELECT 1 FROM telemetry_contribution_occurrences o INDEXED BY telemetry_contribution_occurrences_record
      JOIN telemetry_contributions c ON c.id=o.contribution_id
      WHERE o.participant_id=r.participant_id AND o.record_kind=r.record_kind
        AND o.occurrence_id=r.occurrence_id AND c.status='accepted'
        AND c.transport_schema_version='telemetry-contribution-v0.2')) ELSE 0 END AS legacy_overlap
FROM candidates ORDER BY member_id`;

async function capturePage(db: D1Database, head: Head, budget: CommunityModelCacheReadBudget): Promise<boolean> {
  if (!charge(budget, 3)) return false;
  const rows = (await db.prepare(CAPTURE_SQL).bind(head.capture_cursor, head.membership_watermark,
    COMMUNITY_PUBLICATION_PAGE_SIZE, `${head.from_day}T00:00:00.000Z`).all<MembershipRow>()).results;
  if (!Array.isArray(rows) || rows.length > COMMUNITY_PUBLICATION_PAGE_SIZE) throw new Error("publication membership unavailable");
  let cursor = head.capture_cursor;
  const members = rows.map(row => {
    if (!count(row.member_id) || row.member_id <= cursor || row.member_id > head.membership_watermark
        || typeof row.participant_id !== "string" || row.participant_id.length < 1 || row.participant_id.length > 128
        || !count(row.input_revision) || ![row.has_legacy,row.has_v1,row.has_v11,row.legacy_overlap].every(flag => flag === 0 || flag === 1)) {
      throw new Error("publication membership invalid");
    }
    cursor = row.member_id;
    const source: Source = row.has_v11 ? "v1.1" : row.has_v1 ? row.has_legacy ? "mixed" : "v1" : "v0.2";
    return { id: row.member_id, participant: row.participant_id, revision: row.input_revision, source,
      supported: row.has_v11 || (row.has_v1 && !row.legacy_overlap) ? 1 : 0 };
  });
  const fence = guard(head), complete = rows.length < COMMUNITY_PUBLICATION_PAGE_SIZE;
  const results = await db.batch([
    db.prepare(`INSERT INTO community_publication_members
      (generation,member_id,participant_id,minimum_revision,source,composition_supported)
      SELECT ?1,json_extract(j.value,'$.id'),json_extract(j.value,'$.participant'),
        json_extract(j.value,'$.revision'),json_extract(j.value,'$.source'),json_extract(j.value,'$.supported')
      FROM json_each(?2) j WHERE ${fence}`)
      .bind(head.generation, JSON.stringify(members)),
    db.prepare(`UPDATE community_publication_generation SET member_count=member_count+changes(),
      capture_cursor=?1,phase=?2,progress_revision=progress_revision+1 WHERE singleton=1 AND ${fence}
      RETURNING generation`).bind(cursor, complete ? "loading" : "capturing"),
  ]);
  return results[1]!.results.length === 1;
}

interface PayloadRow {
  member_id: number; participant_id: string; minimum_revision: number; source: Source; composition_supported: number;
  fits_json: string | null; fit_key: string | null; fit_fingerprint: string | null; fit_method: string | null;
  composition_json: string | null; composition_key: string | null; composition_fingerprint: string | null; composition_method: string | null;
  input_revision: number; row_bytes: number; running_bytes: number;
}
const LOAD_SQL = `WITH page AS MATERIALIZED (
  SELECT m.member_id,m.participant_id,m.minimum_revision,m.source,m.composition_supported,
    v.revision AS input_revision,f.cache_key AS fit_key,f.input_fingerprint AS fit_fingerprint,
    f.source_method_version AS fit_method,c.cache_key AS composition_key,c.input_fingerprint AS composition_fingerprint,
    c.source_method_version AS composition_method,
    COALESCE(length(CAST(f.fits_json AS BLOB)),0)+CASE WHEN m.composition_supported=1
      THEN COALESCE(length(CAST(c.composition_json AS BLOB)),0) ELSE 0 END AS row_bytes
  FROM community_publication_members m JOIN participants p ON p.id=m.participant_id AND p.state='active'
  JOIN community_analytical_input_versions v ON v.participant_id=m.participant_id
  LEFT JOIN community_allowance_fit_cache f ON f.participant_id=m.participant_id
  LEFT JOIN community_model_composition_cache c ON c.participant_id=m.participant_id
  WHERE m.generation=?1 AND m.selected_revision IS NULL AND m.member_id>?2
  ORDER BY m.member_id LIMIT ?3
), weighted AS MATERIALIZED (SELECT *,SUM(row_bytes) OVER (ORDER BY member_id) AS running_bytes,
    ROW_NUMBER() OVER (ORDER BY member_id) AS page_rank FROM page)
SELECT w.member_id,w.participant_id,w.minimum_revision,w.source,w.composition_supported,w.input_revision,
  w.fit_key,w.fit_fingerprint,w.fit_method,w.composition_key,w.composition_fingerprint,w.composition_method,
  w.row_bytes,w.running_bytes,
  CASE WHEN w.running_bytes<=?4 OR (w.page_rank=1 AND w.row_bytes<=?5) THEN f.fits_json ELSE NULL END AS fits_json,
  CASE WHEN (w.running_bytes<=?4 OR (w.page_rank=1 AND w.row_bytes<=?5)) AND w.composition_supported=1
    THEN c.composition_json ELSE NULL END AS composition_json
FROM weighted w LEFT JOIN community_allowance_fit_cache f ON f.participant_id=w.participant_id
LEFT JOIN community_model_composition_cache c ON c.participant_id=w.participant_id ORDER BY w.member_id`;

function cacheRevision(key: unknown, source: Source, fromDay: string, suffix: string): number | null {
  if (typeof key !== "string" || !key.startsWith(`${source}:`) || !key.endsWith(`:${fromDay}:${suffix}`)) return null;
  const revision = key.slice(source.length + 1, -(fromDay.length + suffix.length + 2));
  if (!/^(?:0|[1-9][0-9]*)$/u.test(revision)) return null;
  const number = Number(revision);
  return count(number) ? number : null;
}

async function loadPage(db: D1Database, head: Head, budget: CommunityModelCacheReadBudget): Promise<boolean> {
  if (!charge(budget, 3)) return false;
  const rows = (await db.prepare(LOAD_SQL).bind(head.generation, head.load_cursor,
    COMMUNITY_PUBLICATION_PAGE_SIZE, COMMUNITY_PUBLICATION_PAGE_BYTES,
    COMMUNITY_MODEL_CACHE_MAX_BYTES-head.payload_bytes).all<PayloadRow>()).results;
  if (!Array.isArray(rows) || rows.length > COMMUNITY_PUBLICATION_PAGE_SIZE) throw new Error("publication payload page unavailable");
  let cursor = head.load_cursor, bytes = 0, blockedByBytes = false;
  const selected: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!count(row.member_id) || row.member_id <= cursor || !count(row.minimum_revision)
        || !count(row.input_revision) || !count(row.row_bytes) || !count(row.running_bytes)) throw new Error("publication page invalid");
    if (row.running_bytes > COMMUNITY_PUBLICATION_PAGE_BYTES && row !== rows[0]) { blockedByBytes = true; break; }
    if (row.row_bytes>COMMUNITY_MODEL_CACHE_MAX_BYTES-head.payload_bytes) throw new Error("publication member byte limit");
    cursor = row.member_id;
    const revision = cacheRevision(row.fit_key, row.source, head.from_day, V1_FIT_CACHE_KEY_SUFFIX);
    if(revision===null && row.fit_method===COMMUNITY_ATTRIBUTION_METHOD_VERSION && fingerprint(row.fit_fingerprint)) {
      const changedFamily=(["v0.2","v1","mixed","v1.1"] as const).some(source=>{
        const other=source===row.source?null:cacheRevision(row.fit_key,source,head.from_day,V1_FIT_CACHE_KEY_SUFFIX);
        return other!==null&&other>=row.minimum_revision&&other<=row.input_revision;
      });
      if(changedFamily) {
        // Source-family/cutover changes are not ordinary newer revisions. A
        // first v1 upload to a legacy-only account must not leave a captured
        // legacy member waiting forever for a cache that can no longer exist.
        await db.prepare(`UPDATE community_publication_generation SET phase='retiring',progress_revision=progress_revision+1
          WHERE singleton=1 AND ${guard(head)}`).run();
        return false;
      }
    }
    if (revision === null || revision < row.minimum_revision || revision > row.input_revision
        || row.fit_method !== COMMUNITY_ATTRIBUTION_METHOD_VERSION || !fingerprint(row.fit_fingerprint)
        || typeof row.fits_json !== "string" || parsedCachedFits(row.fits_json, row.participant_id) === null) continue;
    let compositionFingerprint: string | null = null, compositionKey: string | null = null;
    if (row.composition_supported === 1) {
      if (row.composition_method !== COMMUNITY_ATTRIBUTION_METHOD_VERSION || !fingerprint(row.composition_fingerprint)
          || typeof row.composition_json !== "string" || utf8(row.composition_json) > 16 * 1024
          || cacheRevision(row.composition_key, row.source === "v1.1" ? "v1.1" : "v1", head.from_day,
            COMPOSITION_CACHE_KEY_SUFFIX) !== revision) continue;
      let composition: unknown;
      try { composition = JSON.parse(row.composition_json); } catch { continue; }
      if (!validCompleteCachedComposition(composition, row.composition_fingerprint,
        row.source === "v1.1" ? V11_PLAN_ATTRIBUTION_ADAPTER_VERSION : V1_PLAN_ATTRIBUTION_ADAPTER_VERSION)) continue;
      compositionFingerprint = row.composition_fingerprint; compositionKey = row.composition_key;
    }
    const payloadBytes = utf8(row.fits_json) + (row.composition_supported ? utf8(row.composition_json!) : 0);
    if (payloadBytes !== row.row_bytes || head.payload_bytes + (bytes += payloadBytes) > COMMUNITY_MODEL_CACHE_MAX_BYTES) {
      throw new Error("publication corpus byte limit");
    }
    selected.push({ id: row.member_id, revision, fits: row.fits_json, fitKey: row.fit_key, fitFingerprint: row.fit_fingerprint,
      composition: row.composition_supported ? row.composition_json : null, compositionKey, compositionFingerprint, bytes: payloadBytes });
  }
  const fence = guard(head), payload = JSON.stringify(selected);
  const results = await db.batch([
    db.prepare(`WITH selected AS MATERIALIZED (SELECT value FROM json_each(?2))
      UPDATE community_publication_members AS m SET
        (selected_revision,fit_fingerprint,composition_fingerprint,fits_json,composition_json,payload_bytes)=
        (SELECT json_extract(value,'$.revision'),json_extract(value,'$.fitFingerprint'),
          json_extract(value,'$.compositionFingerprint'),json_extract(value,'$.fits'),
          json_extract(value,'$.composition'),json_extract(value,'$.bytes')
          FROM selected WHERE json_extract(value,'$.id')=m.member_id)
      WHERE m.generation=?1 AND m.member_id IN (SELECT json_extract(value,'$.id') FROM selected)
        AND m.selected_revision IS NULL AND ${fence} AND EXISTS (
        SELECT 1 FROM selected j JOIN community_allowance_fit_cache f ON f.participant_id=m.participant_id
        LEFT JOIN community_model_composition_cache c ON c.participant_id=m.participant_id
        WHERE json_extract(j.value,'$.id')=m.member_id AND f.cache_key=json_extract(j.value,'$.fitKey')
          AND f.input_fingerprint=json_extract(j.value,'$.fitFingerprint') AND f.fits_json=json_extract(j.value,'$.fits')
          AND f.source_method_version=?3 AND (m.composition_supported=0 OR (
            c.cache_key=json_extract(j.value,'$.compositionKey') AND c.input_fingerprint=json_extract(j.value,'$.compositionFingerprint')
            AND c.composition_json=json_extract(j.value,'$.composition') AND c.source_method_version=?3)))`)
      .bind(head.generation,payload,COMMUNITY_ATTRIBUTION_METHOD_VERSION),
    db.prepare(`UPDATE community_publication_generation SET
      prepared_count=prepared_count+changes(),payload_bytes=payload_bytes+COALESCE((
        SELECT SUM((SELECT m.payload_bytes FROM community_publication_members m
          WHERE m.generation=?2 AND m.member_id=json_extract(j.value,'$.id') AND m.selected_revision IS NOT NULL))
        FROM json_each(?1) j),0),
      phase=CASE WHEN prepared_count+changes()=member_count THEN 'ready' ELSE 'loading' END,
      load_cursor=?3,progress_revision=progress_revision+1 WHERE singleton=1 AND ${fence} RETURNING generation`)
      .bind(payload,head.generation,!blockedByBytes && rows.length < COMMUNITY_PUBLICATION_PAGE_SIZE ? 0 : cursor),
  ]);
  return results[1]!.results.length === 1 && !(rows.length < COMMUNITY_PUBLICATION_PAGE_SIZE
    && selected.length === 0 && head.prepared_count < head.member_count);
}

/** Scheduled only. Each committed page survives cancellation/retry. No raw
 * analyzer runs here; newer soft inputs do not revoke a captured member. */
export async function advanceCommunityPublication(db: D1Database, nowMs: number,
  options: CommunityPublicationOptions): Promise<CommunityPublicationProgress> {
  const { budget } = options, maxPages = options.maxPages ?? 32;
  if (!Number.isFinite(nowMs) || !count(maxPages) || maxPages < 1 || maxPages > 64) return { status: "unavailable" };
  const utcDay = new Date(nowMs).toISOString().slice(0,10);
  const fromDay = new Date(nowMs - V1_ANALYSIS_WINDOW_DAYS * DAY_MS).toISOString().slice(0,10);
  let head: Head | null = null;
  try {
    for (let page = 0; page < maxPages; page++) {
      if (!charge(budget,2)) return head ? progress(head,"deferred") : { status: "deferred" };
      const [heads,controls] = await db.batch([db.prepare(HEAD_SQL),db.prepare(CONTROL_SQL)]);
      head = (heads!.results[0] as unknown as Head | undefined) ?? null;
      const control = controls!.results[0] as unknown as Control | undefined;
      if (!control || ![control.mutation_epoch,control.graph_invalidation_epoch,control.cache_revision].every(count)
          || control.graph_invalidation_epoch > control.mutation_epoch || (head && !writableHead(head))) return { status: "unavailable" };
      if (head === null) {
        if (!charge(budget)) return { status: "deferred" };
        await db.prepare(`INSERT INTO community_publication_generation
          (singleton,generation,utc_day,from_day,method_version,source_epoch,hard_epoch,cache_revision,
            membership_watermark,capture_cursor,load_cursor,phase,member_count,prepared_count,payload_bytes,progress_revision,created_at)
          SELECT 1,?1,?2,?3,?4,s.mutation_epoch,s.graph_invalidation_epoch,c.revision,
            COALESCE((SELECT MAX(id) FROM community_current_analysis_queue),0),0,0,'capturing',0,0,0,0,?5
          FROM community_snapshot_mutation_control s,community_publication_changes c
          WHERE s.singleton_id=1 AND c.singleton=1 ON CONFLICT(singleton) DO NOTHING`)
          .bind(crypto.randomUUID(),utcDay,fromDay,COMMUNITY_ATTRIBUTION_METHOD_VERSION,new Date(nowMs).toISOString()).run();
        continue;
      }
      const obsolete = head.utc_day !== utcDay || head.from_day !== fromDay
        || head.method_version !== COMMUNITY_ATTRIBUTION_METHOD_VERSION || head.hard_epoch !== control.graph_invalidation_epoch;
      const dirty = head.source_epoch !== control.mutation_epoch || head.cache_revision !== control.cache_revision;
      if (obsolete || head.phase === "retiring" || (head.phase === "ready" && head.published === 1 && dirty)) {
        if (!charge(budget,3)) return progress(head,"deferred");
        // Bound retirement too. The published aggregate is independent and is
        // not deleted here. Hard-invalidated aggregates already fail serving.
        await db.batch([
          db.prepare("UPDATE community_publication_generation SET phase='retiring',progress_revision=progress_revision+1 WHERE generation=?1")
            .bind(head.generation),
          db.prepare(`DELETE FROM community_publication_members WHERE generation=?1 AND member_id IN
            (SELECT member_id FROM community_publication_members WHERE generation=?1 ORDER BY member_id LIMIT ?2)`)
            .bind(head.generation,COMMUNITY_PUBLICATION_PAGE_SIZE),
          db.prepare(`DELETE FROM community_publication_generation WHERE generation=?1
            AND NOT EXISTS(SELECT 1 FROM community_publication_members WHERE generation=?1)`).bind(head.generation),
        ]);
        continue;
      }
      if (head.phase === "ready") return progress(head,"ready");
      const advanced = head.phase === "capturing" ? await capturePage(db,head,budget) : await loadPage(db,head,budget);
      if (!advanced) return progress(head,"deferred");
    }
    if (!charge(budget)) return head ? progress(head,"deferred") : {status:"deferred"};
    head = await db.prepare(HEAD_SQL).first<Head>();
    return head && validHead(head) ? progress(head,head.phase === "ready" ? "ready" : "deferred") : { status: "deferred" };
  } catch { return head ? progress(head,"unavailable") : { status: "unavailable" }; }
}

/** Full immutable corpus, read in byte-bounded multi-account pages. Completeness
 * is checked against the captured counts, not the live uploading revision. */
export async function readCapturedCommunityPublication(db: D1Database, nowMs: number,
  options: { budget: CommunityModelCacheReadBudget }): Promise<CapturedCommunityPublication | null> {
  const {budget} = options;
  if (!Number.isFinite(nowMs) || !charge(budget)) return null;
  try {
    const head = await db.prepare(HEAD_SQL).first<Head>();
    if (!head || !writableHead(head) || head.phase !== "ready" || head.prepared_count !== head.member_count
        || head.utc_day !== new Date(nowMs).toISOString().slice(0,10)
        || head.method_version !== COMMUNITY_ATTRIBUTION_METHOD_VERSION) return null;
    const participantIds: string[] = [], fits: CommunityAllowanceFit[] = [];
    const compositions: CachedCommunityModelCompositions = { compositions:[],v1ParticipantCount:0,
      unsupportedSourceParticipantCount:0,refusedParticipantCount:0,storeAvailable:true };
    let cursor = 0, bytes = 0,metadataBytes=0;
    while (participantIds.length < head.member_count) {
      if (!charge(budget)) return null;
      const rows = (await db.prepare(`WITH page AS MATERIALIZED (
        SELECT member_id,payload_bytes FROM community_publication_members WHERE generation=?1 AND member_id>?2
        ORDER BY member_id LIMIT ?3), weighted AS MATERIALIZED (
          SELECT *,SUM(payload_bytes) OVER(ORDER BY member_id) AS running_bytes,
            ROW_NUMBER() OVER(ORDER BY member_id) AS page_rank FROM page)
        SELECT m.* FROM weighted w JOIN community_publication_members m ON m.generation=?1 AND m.member_id=w.member_id
        WHERE w.running_bytes<=?4 OR (w.page_rank=1 AND w.payload_bytes<=?5) ORDER BY m.member_id`)
        .bind(head.generation,cursor,COMMUNITY_PUBLICATION_PAGE_SIZE,COMMUNITY_PUBLICATION_PAGE_BYTES,
          COMMUNITY_MODEL_CACHE_MAX_BYTES-bytes)
        .all<{ member_id:number;participant_id:string;minimum_revision:number;selected_revision:number;source:Source;
          composition_supported:number;fit_fingerprint:string;composition_fingerprint:string|null;
          fits_json:string;composition_json:string|null;payload_bytes:number }>()).results;
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > COMMUNITY_PUBLICATION_PAGE_SIZE) return null;
      for (const row of rows) {
        if (!count(row.member_id) || row.member_id <= cursor || !count(row.minimum_revision)
            || typeof row.participant_id!=="string" || row.participant_id.length<1 || row.participant_id.length>128
            || !count(row.selected_revision) || row.selected_revision < row.minimum_revision || !fingerprint(row.fit_fingerprint)
            || ![0,1].includes(row.composition_supported) || !["v0.2","v1","mixed","v1.1"].includes(row.source)
            || typeof row.fits_json !== "string" || !count(row.payload_bytes)) return null;
        cursor = row.member_id;
        // Empty-fit accounts still occupy cohort/identity memory. Bound that
        // separate metadata allocation, not just their tiny JSON payloads.
        metadataBytes+=utf8(row.participant_id)+64;
        if(metadataBytes>COMMUNITY_PUBLICATION_PAGE_BYTES)return null;
        const parsed = parsedCachedFits(row.fits_json,row.participant_id);
        if (!parsed) return null;
        const actualBytes = utf8(row.fits_json)+(row.composition_json === null ? 0 : utf8(row.composition_json));
        if (actualBytes !== row.payload_bytes || (bytes += actualBytes) > COMMUNITY_MODEL_CACHE_MAX_BYTES) return null;
        participantIds.push(row.participant_id);
        for (const fit of parsed) fits.push(fit);
        if (!row.composition_supported) { compositions.unsupportedSourceParticipantCount++; continue; }
        if (typeof row.composition_json !== "string" || !fingerprint(row.composition_fingerprint)) return null;
        const composition: unknown = JSON.parse(row.composition_json);
        if (!validCompleteCachedComposition(composition,row.composition_fingerprint,
          row.source === "v1.1" ? V11_PLAN_ATTRIBUTION_ADAPTER_VERSION : V1_PLAN_ATTRIBUTION_ADAPTER_VERSION)) return null;
        compositions.v1ParticipantCount++;
        if (composition.status === "ready") compositions.compositions.push({participantId:row.participant_id,composition});
        else compositions.refusedParticipantCount++;
      }
    }
    if (participantIds.length !== head.member_count || bytes !== head.payload_bytes || !charge(budget)) return null;
    const authorized = await db.prepare(`SELECT 1 AS valid WHERE ${COMMUNITY_PUBLICATION_AUTHORITY_SQL}`)
      .bind(head.generation,head.source_epoch,head.hard_epoch,COMMUNITY_ATTRIBUTION_METHOD_VERSION).first();
    if (!authorized) return null;
    fits.sort((left,right) => left.lastObservedAt.localeCompare(right.lastObservedAt)
      || left.capacityNanousd-right.capacityNanousd || left.participantId.localeCompare(right.participantId));
    return {generation:head.generation,sourceEpoch:head.source_epoch,hardEpoch:head.hard_epoch,
      corpus:{participantIds:participantIds.sort(),fits},compositions};
  } catch { return null; }
}

export function markCommunityPublicationPublished(db: D1Database, captured: Pick<CapturedCommunityPublication,
  "generation"|"sourceEpoch"|"hardEpoch">): D1PreparedStatement {
  return db.prepare(`UPDATE community_publication_generation SET published=1
    WHERE singleton=1 AND ${COMMUNITY_PUBLICATION_AUTHORITY_SQL} RETURNING generation`)
    .bind(captured.generation,captured.sourceEpoch,captured.hardEpoch,COMMUNITY_ATTRIBUTION_METHOD_VERSION);
}
