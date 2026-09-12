/** Transactional ingestion outbox and independently committed analytics inbox.
 * Retained journal identifiers are digests, never bearer credentials or records.
 * This module supplies no authorization: admission owns that check and includes
 * its accepted source writes and prepareIngestionChange() in the same D1 batch.
 */
export const STORAGE_OPERATING_BUDGET_BYTES = 9_000_000_000;
export const MAX_DELIVERY_PAGE = 100;
export const MAX_PROJECTION_STATEMENTS = 800;
export type StorageChangeKind = "source-updated" | "owner-active" | "owner-withdrawn" | "owner-erased";
export interface StorageChangeInput {
  sourceId: string;
  eventDigest: string;
  ownerDigest: string;
  revision: number;
  kind: StorageChangeKind;
  objectDigest: string;
  contentDigest: string;
  recordedMs: number;
}
export interface StorageChange extends StorageChangeInput {
  sequence: number;
  authorityEpoch: number;
  publicAuthorityEpoch: number;
}
interface ChangeRow {
  sequence: number; event_digest: string; owner_digest: string; revision: number;
  kind: StorageChangeKind; object_digest: string; content_digest: string;
  authority_epoch: number; public_authority_epoch: number; recorded_ms: number;
}
const kinds = new Set<StorageChangeKind>(["source-updated", "owner-active", "owner-withdrawn", "owner-erased"]);
const digest = /^[0-9a-f]{64}$/;
function sourceId(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(value)) throw new Error("STORAGE_SOURCE_INVALID");
}
function integer(value: number, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) throw new Error("STORAGE_INTEGER_INVALID");
}
function validate(input: StorageChangeInput): void {
  sourceId(input.sourceId);
  for (const value of [input.eventDigest, input.ownerDigest, input.objectDigest, input.contentDigest]) {
    if (typeof value !== "string" || !digest.test(value)) throw new Error("STORAGE_DIGEST_INVALID");
  }
  integer(input.revision, 1); integer(input.recordedMs);
  if (!kinds.has(input.kind)) throw new Error("STORAGE_CHANGE_INVALID");
}
function decode(id: string, row: ChangeRow): StorageChange {
  const value = { sourceId: id, sequence: row.sequence, eventDigest: row.event_digest,
    ownerDigest: row.owner_digest, revision: row.revision, kind: row.kind,
    objectDigest: row.object_digest, contentDigest: row.content_digest,
    authorityEpoch: row.authority_epoch, publicAuthorityEpoch: row.public_authority_epoch,
    recordedMs: row.recorded_ms };
  validate(value); integer(value.sequence, 1); integer(value.authorityEpoch, 1); integer(value.publicAuthorityEpoch, 1);
  return value;
}

export async function initializeStorageSource(db: D1Database, id: string): Promise<void> {
  sourceId(id);
  await db.prepare("INSERT INTO storage_source_state(singleton,source_id) VALUES(1,?) ON CONFLICT(singleton) DO NOTHING").bind(id).run();
  const state = await db.prepare("SELECT source_id FROM storage_source_state WHERE singleton=1").first<{ source_id: string }>();
  if (state?.source_id !== id) throw new Error("STORAGE_SOURCE_MISMATCH");
}

export function prepareIngestionChange(db: D1Database, input: StorageChangeInput): D1PreparedStatement {
  validate(input);
  const authorityDelta = input.kind === "source-updated" ? 0 : 1;
  // VALUES rather than INSERT SELECT: a missing/mismatched source produces NULL
  // and fails the batch instead of silently acknowledging an unjournaled upload.
  return db.prepare(`INSERT INTO storage_ingestion_changes
    (event_digest,owner_digest,revision,kind,object_digest,content_digest,authority_epoch,public_authority_epoch,recorded_ms)
    VALUES(?1,?2,?3,?4,?5,?6,
      COALESCE((SELECT authority_epoch FROM storage_owner_revisions WHERE owner_digest=?2),0)+?7,
      (SELECT authority_epoch FROM storage_source_state WHERE singleton=1 AND source_id=?8)+?7,?9)`)
    .bind(input.eventDigest, input.ownerDigest, input.revision, input.kind,
      input.objectDigest, input.contentDigest, authorityDelta, input.sourceId, input.recordedMs);
}

export async function readIngestionChanges(db: D1Database, id: string, afterSequence: number, limit = MAX_DELIVERY_PAGE): Promise<StorageChange[]> {
  sourceId(id); integer(afterSequence); integer(limit, 1);
  if (limit > MAX_DELIVERY_PAGE) throw new Error("STORAGE_PAGE_LIMIT");
  const state = await db.prepare("SELECT source_id FROM storage_source_state WHERE singleton=1").first<{ source_id: string }>();
  if (state?.source_id !== id) throw new Error("STORAGE_SOURCE_MISMATCH");
  const rows = await db.prepare("SELECT * FROM storage_ingestion_changes WHERE sequence>? ORDER BY sequence LIMIT ?")
    .bind(afterSequence, limit).all<ChangeRow>();
  return rows.results.map(row => decode(id, row));
}

function equal(a: StorageChange, b: StorageChange): boolean {
  return a.sourceId === b.sourceId && a.sequence === b.sequence && a.eventDigest === b.eventDigest
    && a.ownerDigest === b.ownerDigest && a.revision === b.revision && a.kind === b.kind
    && a.objectDigest === b.objectDigest && a.contentDigest === b.contentDigest
    && a.authorityEpoch === b.authorityEpoch && a.publicAuthorityEpoch === b.publicAuthorityEpoch
    && a.recordedMs === b.recordedMs;
}
async function receipt(db: D1Database, change: StorageChange): Promise<StorageChange | null> {
  const row = await db.prepare("SELECT * FROM analytics_applied_events WHERE source_id=? AND sequence=?")
    .bind(change.sourceId, change.sequence).first<ChangeRow>();
  return row ? decode(change.sourceId, row) : null;
}

export type PrepareAnalyticsProjection = (target: D1Database, change: Readonly<StorageChange>) => Promise<D1PreparedStatement[]>;

export async function applyAnalyticsChange(
  target: D1Database, change: StorageChange, prepareProjection: PrepareAnalyticsProjection,
): Promise<"applied" | "already-applied"> {
  validate(change); integer(change.sequence, 1); integer(change.authorityEpoch, 1); integer(change.publicAuthorityEpoch, 1);
  const prior = await receipt(target, change);
  if (prior) {
    if (!equal(prior, change)) throw new Error("ANALYTICS_RECEIPT_CONFLICT");
    return "already-applied";
  }
  // The callback prepares bounded SQL only. It must resolve an immutable source
  // revision matching contentDigest; fetching the newest mutable state is unsafe.
  // Withdrawal/erasure must remove or fence its owner projection in this batch.
  const statements = await prepareProjection(target, Object.freeze({ ...change }));
  if (!Array.isArray(statements) || statements.length > MAX_PROJECTION_STATEMENTS) throw new Error("ANALYTICS_PROJECTION_LIMIT");
  if (change.kind !== "owner-active" && statements.length === 0) throw new Error("ANALYTICS_PROJECTION_MISSING");
  const guard = target.prepare(`INSERT INTO analytics_applied_events
    (source_id,sequence,event_digest,owner_digest,revision,kind,object_digest,content_digest,authority_epoch,public_authority_epoch,recorded_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(change.sourceId, change.sequence, change.eventDigest,
    change.ownerDigest, change.revision, change.kind, change.objectDigest, change.contentDigest,
    change.authorityEpoch, change.publicAuthorityEpoch, change.recordedMs);
  try {
    await target.batch([guard, ...statements]);
    return "applied";
  } catch {
    // Another consumer may have committed, or the response may have been lost.
    // Only an exact durable receipt makes this an acknowledged success.
    const durable = await receipt(target, change);
    if (durable && equal(durable, change)) return "already-applied";
    throw new Error("ANALYTICS_DELIVERY_UNACKNOWLEDGED");
  }
}

export async function deliverAnalyticsPage(options: {
  source: D1Database; target: D1Database; sourceId: string;
  prepareProjection: PrepareAnalyticsProjection; limit?: number; signal?: AbortSignal;
}): Promise<{ applied: number; alreadyApplied: number; sequence: number; pageFull: boolean }> {
  sourceId(options.sourceId);
  const limit = options.limit ?? MAX_DELIVERY_PAGE;
  integer(limit, 1); if (limit > MAX_DELIVERY_PAGE) throw new Error("STORAGE_PAGE_LIMIT");
  const cursor = await options.target.prepare("SELECT sequence FROM analytics_source_cursors WHERE source_id=?")
    .bind(options.sourceId).first<{ sequence: number }>();
  let sequence = cursor?.sequence ?? 0, applied = 0, alreadyApplied = 0;
  integer(sequence);
  const page = await readIngestionChanges(options.source, options.sourceId, sequence, limit);
  for (const change of page) {
    options.signal?.throwIfAborted();
    if (change.sequence !== sequence + 1) throw new Error("ANALYTICS_SOURCE_GAP");
    const outcome = await applyAnalyticsChange(options.target, change, options.prepareProjection);
    if (outcome === "applied") applied++; else alreadyApplied++;
    sequence = change.sequence;
  }
  return { applied, alreadyApplied, sequence, pageFull: page.length === limit };
}

/** Final public-serving fence, separate from data-freshness/backfill progress.
 * Call immediately before publishing/serving an eligible analytics snapshot.
 * Missing or unavailable authority is not equivalent to an eligible owner.
 */
export async function analyticsAuthorityIsCurrent(source: D1Database, target: D1Database, id: string,
  snapshotAuthorityEpoch: number): Promise<boolean> {
  sourceId(id); integer(snapshotAuthorityEpoch);
  const projected = await target.prepare("SELECT authority_epoch FROM analytics_source_cursors WHERE source_id=?")
    .bind(id).first<{ authority_epoch: number }>();
  if (projected === null || projected.authority_epoch !== snapshotAuthorityEpoch) return false;
  // This final authoritative read is the serving operation's linearization point.
  // A later withdrawal affects subsequent reads; two independent databases cannot
  // retroactively retract a response already authorized here. The caller must
  // stamp the snapshot when it is built, not substitute the latest cursor epoch.
  const authoritative = await source.prepare("SELECT source_id,authority_epoch FROM storage_source_state WHERE singleton=1")
    .first<{ source_id: string; authority_epoch: number }>();
  if (authoritative?.source_id !== id) throw new Error("STORAGE_SOURCE_MISMATCH");
  return authoritative.authority_epoch === snapshotAuthorityEpoch;
}
