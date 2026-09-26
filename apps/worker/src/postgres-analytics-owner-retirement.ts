import {
  createPostgresSchemaConfig,
  PostgresStorageError,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";

const OWNER_DIGEST = /^[0-9a-f]{64}$/u;
const MAX_SOURCE_COUNT = 64;
const TIMEOUTS = Object.freeze({
  operation: "postgres.analytics_owner_retirement",
  statementTimeoutMilliseconds: 10_000,
  lockTimeoutMilliseconds: 5_000,
});

/** Closed inventory of every PostgreSQL primary relation carrying owner_digest
 * at migration 0046. New owner-bearing relations block retirement until they
 * receive an explicit deletion or retained-proof decision here.
 */
const OWNER_DIGEST_TABLES = Object.freeze([
  "analytics_analysis_work_heads",
  "analytics_analysis_work_parts",
  "analytics_applied_events",
  "analytics_owner_results",
  "analytics_owner_state",
  "analytics_prepared_source_controls",
  "analytics_prepared_source_heads",
  "analytics_prepared_source_outputs",
  "analytics_prepared_source_rows",
  "analytics_prepared_source_streams",
  "analytics_publication_invalidations",
  "analytics_publication_owner_members",
  "analytics_scheduler_delivery_cursors",
  "storage_ingestion_changes",
  "storage_owner_erasure_receipts",
  // Retained tombstone: the owner's journal revision head (see
  // RETAINED_OWNER_TABLES).
  "storage_owner_revisions",
  "storage_v11_event_sources",
  "storage_v11_owner_links",
  // v1.2 publication receipts cascade with the participant; retirement
  // requires them gone (assertNoResidualOwnerFamilyRows).
  "storage_v12_event_sources",
  "telemetry_usage_correction_history",
  "typed_v1_event_sources",
] as const);

const SOURCE_OWNER_TABLES = Object.freeze([
  "analytics_analysis_work_heads",
  "analytics_analysis_work_parts",
  "analytics_applied_events",
  "analytics_owner_results",
  "analytics_owner_state",
  "analytics_prepared_source_controls",
  "analytics_prepared_source_heads",
  "analytics_prepared_source_outputs",
  "analytics_prepared_source_rows",
  "analytics_prepared_source_streams",
  "analytics_publication_invalidations",
  "analytics_publication_owner_members",
  "analytics_scheduler_delivery_cursors",
  "storage_ingestion_changes",
  "storage_owner_revisions",
] as const);

/** Owner-bearing relations that retirement keeps as proof or marks in place. */
const RETAINED_OWNER_TABLES: ReadonlySet<string> = new Set([
  "analytics_applied_events",
  "analytics_owner_state",
  "analytics_publication_invalidations",
  "storage_ingestion_changes",
  // The revision head is a retained tombstone derived from the retained
  // journal; it is never deleted, so it is never residue.
  "storage_owner_revisions",
]);

export type PostgresAnalyticsOwnerRetirementCode =
  | "ANALYTICS_OWNER_RETIREMENT_TARGET_INVALID"
  | "ANALYTICS_OWNER_RETIREMENT_ERASURE_PROOF_MISSING"
  | "ANALYTICS_OWNER_RETIREMENT_PARTICIPANT_REMAINS"
  | "ANALYTICS_OWNER_RETIREMENT_FAMILY_UNSUPPORTED"
  | "ANALYTICS_OWNER_RETIREMENT_SOURCE_UNAVAILABLE"
  | "ANALYTICS_OWNER_RETIREMENT_SOURCE_MISMATCH"
  | "ANALYTICS_OWNER_RETIREMENT_JOURNAL_NOT_CAUGHT_UP"
  | "ANALYTICS_OWNER_RETIREMENT_STATE_UNEXPECTED"
  | "ANALYTICS_OWNER_RETIREMENT_RESIDUAL_OWNER_ROWS"
  | "ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED";

export class PostgresAnalyticsOwnerRetirementError extends Error {
  readonly code: PostgresAnalyticsOwnerRetirementCode;

  constructor(code: PostgresAnalyticsOwnerRetirementCode) {
    super(code);
    this.name = "PostgresAnalyticsOwnerRetirementError";
    this.code = code;
  }
}

export interface RetirePostgresAnalyticsOwnerOptions {
  readonly primaryPool: PostgresPool;
  readonly ownerDigest: string;
  readonly schema?: PostgresSchemaOptions;
}

export interface PostgresAnalyticsOwnerRetirementCounts {
  readonly analysisWorkParts: number;
  readonly analysisWorkHeads: number;
  readonly preparedOutputs: number;
  readonly preparedControls: number;
  readonly preparedStreams: number;
  readonly preparedRows: number;
  readonly preparedHeads: number;
  readonly ownerResults: number;
  readonly deliveryCursors: number;
  readonly publications: number;
  readonly publicationCaptures: number;
  readonly publicationMembers: number;
  readonly adminHistoryCache: number;
  readonly adminAllowanceCache: number;
  readonly adminProgressCache: number;
  readonly dailyPreviewCache: number;
  readonly dailyRevisionsWithdrawn: number;
  readonly modelCompositionDaysCleared: number;
  readonly previewCacheRowsCleared: number;
}

export interface PostgresAnalyticsOwnerRetirementEvidence {
  /** The immutable owner-erasure gate is retained as durable proof. */
  readonly erasureReceipts: 1;
  /** Erased owner rows remain as anti-resurrection sentinels. */
  readonly ownerStateTombstones: number;
  /** Append-only source events and applied receipts preserve shared sequence history. */
  readonly sourceJournalRows: number;
  readonly appliedEventReceipts: number;
  /** Shared monotone cursors are preserved and must already be caught up. */
  readonly sourceCursors: number;
  /** Publication invalidations retain an owner digest as a terminal marker. */
  readonly publicationInvalidations: number;
  /** Daily aggregate payloads are immutable; withdrawn revisions remain stored. */
  readonly withdrawnDailyRevisions: number;
}

export interface PostgresAnalyticsOwnerRetirementResult {
  readonly status: "complete";
  readonly sourceCount: number;
  readonly deleted: PostgresAnalyticsOwnerRetirementCounts;
  readonly retained: PostgresAnalyticsOwnerRetirementEvidence;
}

interface CountRow { readonly count: string | number }
interface SourceRow { readonly source_id: string }
interface OwnerStateRow { readonly source_id: string; readonly state: string }
interface ReceiptRow { readonly owner_digest: string }
interface SourceAuthorityRow { readonly source_id: string; readonly authority_epoch: string | number }
interface CursorRow { readonly sequence: string | number; readonly authority_epoch: string | number }
interface LatestChangeRow {
  readonly sequence: string | number;
  readonly event_digest: string;
  readonly owner_digest: string;
  readonly event_tuple_version: number;
  readonly revision: string | number | null;
  readonly kind: string | null;
  readonly object_digest: string | null;
  readonly content_digest: string | null;
  readonly authority_epoch: string | number;
  readonly public_authority_epoch: string | number | null;
  readonly recorded_ms: string | number | null;
  readonly applied_event_digest: string | null;
  readonly applied_owner_digest: string | null;
  readonly applied_tuple_version: number | null;
  readonly applied_revision: string | number | null;
  readonly applied_kind: string | null;
  readonly applied_object_digest: string | null;
  readonly applied_content_digest: string | null;
  readonly applied_authority_epoch: string | number | null;
  readonly applied_public_authority_epoch: string | number | null;
  readonly applied_recorded_ms: string | number | null;
}

function fail(code: PostgresAnalyticsOwnerRetirementCode): never {
  throw new PostgresAnalyticsOwnerRetirementError(code);
}

function preserveSafeError(error: unknown): Error | null {
  return error instanceof PostgresAnalyticsOwnerRetirementError ? error : null;
}

function table(schema: string, name: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(name)}`;
}

function parseRows<Row extends object>(value: unknown): readonly Row[] {
  if (value === null || typeof value !== "object") {
    fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");
  }
  const rows = Reflect.get(value, "rows");
  if (!Array.isArray(rows)) fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");
  return rows as readonly Row[];
}

function parseCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");
  }
  return count;
}

function rowCount(clientResult: { readonly rowCount: number | null }): number {
  if (!Number.isSafeInteger(clientResult.rowCount) || clientResult.rowCount! < 0) {
    fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");
  }
  return clientResult.rowCount!;
}

function safeSequence(value: unknown): number {
  const sequence = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");
  }
  return sequence;
}

function sameAppliedChange(change: LatestChangeRow): boolean {
  return change.applied_event_digest === change.event_digest
    && change.applied_owner_digest === change.owner_digest
    && change.applied_tuple_version === change.event_tuple_version
    && change.applied_revision === change.revision
    && change.applied_kind === change.kind
    && change.applied_object_digest === change.object_digest
    && change.applied_content_digest === change.content_digest
    && change.applied_authority_epoch === change.authority_epoch
    && change.applied_public_authority_epoch === change.public_authority_epoch
    && change.applied_recorded_ms === change.recorded_ms;
}

function supportedSourceId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/u.test(value);
}

async function assertKnownOwnerDigestTables(client: PostgresClient, schema: string): Promise<void> {
  const rows = parseRows<{ readonly table_name: string }>(await client.query(
    `SELECT DISTINCT candidate.relname::text AS table_name
       FROM pg_class candidate
       JOIN pg_namespace candidate_schema ON candidate_schema.oid=candidate.relnamespace
      WHERE candidate_schema.nspname=$1 AND candidate.relkind IN ('r','p')
        AND EXISTS (
          SELECT 1 FROM information_schema.columns columns
           WHERE columns.table_schema=$1 AND columns.table_name=candidate.relname
             AND columns.column_name='owner_digest'
        )
      ORDER BY table_name`,
    [schema],
  ));
  const known = new Set<string>(OWNER_DIGEST_TABLES);
  if (rows.some(({ table_name: name }) => typeof name !== "string" || !known.has(name))) {
    fail("ANALYTICS_OWNER_RETIREMENT_FAMILY_UNSUPPORTED");
  }
  if (rows.length !== OWNER_DIGEST_TABLES.length) {
    fail("ANALYTICS_OWNER_RETIREMENT_FAMILY_UNSUPPORTED");
  }
}

async function readAffectedSources(
  client: PostgresClient,
  schema: string,
  ownerDigest: string,
): Promise<readonly string[]> {
  const sourceRows = SOURCE_OWNER_TABLES.map((name) =>
    `SELECT source_id FROM ${table(schema, name)} WHERE owner_digest=$1`).join("\nUNION ALL\n");
  const rows = parseRows<SourceRow>(await client.query(
    `SELECT DISTINCT source_id COLLATE "C" AS source_id FROM (${sourceRows}) owner_sources
      ORDER BY source_id LIMIT $2`,
    [ownerDigest, MAX_SOURCE_COUNT + 1],
  ));
  if (rows.length > MAX_SOURCE_COUNT || rows.some(({ source_id: sourceId }) =>
    typeof sourceId !== "string" || !supportedSourceId(sourceId))) {
    fail("ANALYTICS_OWNER_RETIREMENT_SOURCE_MISMATCH");
  }
  return Object.freeze(rows.map(({ source_id: sourceId }) => sourceId));
}

async function assertNoLiveOwnerMapping(
  client: PostgresClient,
  schema: string,
  ownerDigest: string,
): Promise<void> {
  const receipts = parseRows<ReceiptRow>(await client.query(
    `SELECT owner_digest FROM ${table(schema, "storage_owner_erasure_receipts")}
      WHERE owner_digest=$1 FOR UPDATE`,
    [ownerDigest],
  ));
  if (receipts.length !== 1 || receipts[0]?.owner_digest !== ownerDigest) {
    fail("ANALYTICS_OWNER_RETIREMENT_ERASURE_PROOF_MISSING");
  }
  const links = parseRows<{ readonly participant_id: string }>(await client.query(
    `SELECT participant_id FROM ${table(schema, "storage_v11_owner_links")}
      WHERE owner_digest=$1 FOR UPDATE`,
    [ownerDigest],
  ));
  if (links.length !== 0) fail("ANALYTICS_OWNER_RETIREMENT_PARTICIPANT_REMAINS");
}

async function assertSourceAuthorityCaughtUp(
  client: PostgresClient,
  schema: string,
  sourceIds: readonly string[],
): Promise<number> {
  if (sourceIds.length === 0) return 0;
  const authorities = parseRows<SourceAuthorityRow>(await client.query(
    `SELECT source_id,authority_epoch FROM ${table(schema, "storage_source_state")}
      WHERE singleton=1 FOR UPDATE`,
  ));
  if (authorities.length !== 1 || !sourceIds.includes(authorities[0]!.source_id)) {
    fail("ANALYTICS_OWNER_RETIREMENT_SOURCE_UNAVAILABLE");
  }
  safeSequence(authorities[0]!.authority_epoch);
  const sourceId = authorities[0]!.source_id;
  if (!supportedSourceId(sourceId)) fail("ANALYTICS_OWNER_RETIREMENT_SOURCE_MISMATCH");
  if (sourceIds.some((value) => value !== sourceId)) {
    fail("ANALYTICS_OWNER_RETIREMENT_SOURCE_MISMATCH");
  }

  const cursors = parseRows<CursorRow>(await client.query(
    `SELECT sequence,authority_epoch FROM ${table(schema, "analytics_source_cursors")}
      WHERE source_id=$1 FOR UPDATE`,
    [sourceId],
  ));
  if (cursors.length > 1) fail("ANALYTICS_OWNER_RETIREMENT_SOURCE_MISMATCH");
  const maxRows = parseRows<{ readonly sequence: string | number }>(await client.query(
    `SELECT COALESCE(max(sequence),0)::text AS sequence
       FROM ${table(schema, "storage_ingestion_changes")} WHERE source_id=$1`,
    [sourceId],
  ));
  const maxSequence = safeSequence(maxRows[0]?.sequence);
  let cursorSequence = 0;
  if (cursors.length === 1) {
    cursorSequence = safeSequence(cursors[0]!.sequence);
    const cursorAuthorityEpoch = safeSequence(cursors[0]!.authority_epoch);
    if (cursorAuthorityEpoch !== safeSequence(authorities[0]!.authority_epoch)) {
      fail("ANALYTICS_OWNER_RETIREMENT_JOURNAL_NOT_CAUGHT_UP");
    }
  }
  if (cursorSequence !== maxSequence) {
    fail("ANALYTICS_OWNER_RETIREMENT_JOURNAL_NOT_CAUGHT_UP");
  }
  const countRows = parseRows<{ readonly count: string | number }>(await client.query(
    `SELECT count(*)::text AS count FROM ${table(schema, "storage_ingestion_changes")}
      WHERE source_id=$1`,
    [sourceId],
  ));
  if (parseCount(countRows[0]?.count) !== maxSequence) {
    fail("ANALYTICS_OWNER_RETIREMENT_JOURNAL_NOT_CAUGHT_UP");
  }
  if (maxSequence === 0) return 0;

  const latestRows = parseRows<LatestChangeRow>(await client.query(
    `SELECT change.sequence,change.event_digest,change.owner_digest,change.event_tuple_version,
            change.revision,change.kind,change.object_digest,change.content_digest,
            change.authority_epoch,change.public_authority_epoch,change.recorded_ms,
            applied.event_digest AS applied_event_digest,applied.owner_digest AS applied_owner_digest,
            applied.event_tuple_version AS applied_tuple_version,applied.revision AS applied_revision,
            applied.kind AS applied_kind,applied.object_digest AS applied_object_digest,
            applied.content_digest AS applied_content_digest,
            applied.authority_epoch AS applied_authority_epoch,
            applied.public_authority_epoch AS applied_public_authority_epoch,
            applied.recorded_ms AS applied_recorded_ms
       FROM ${table(schema, "storage_ingestion_changes")} change
       LEFT JOIN ${table(schema, "analytics_applied_events")} applied
         ON applied.source_id=change.source_id AND applied.sequence=change.sequence
      WHERE change.source_id=$1 AND change.sequence=$2`,
    [sourceId, maxSequence],
  ));
  if (latestRows.length !== 1 || !sameAppliedChange(latestRows[0]!)) {
    fail("ANALYTICS_OWNER_RETIREMENT_JOURNAL_NOT_CAUGHT_UP");
  }
  return cursors.length;
}

async function readOwnerStates(
  client: PostgresClient,
  schema: string,
  ownerDigest: string,
): Promise<readonly OwnerStateRow[]> {
  const rows = parseRows<OwnerStateRow>(await client.query(
    `SELECT source_id,state FROM ${table(schema, "analytics_owner_state")}
      WHERE owner_digest=$1 ORDER BY source_id COLLATE "C" FOR UPDATE`,
    [ownerDigest],
  ));
  if (rows.some((row) => !["active", "withdrawn", "erased"].includes(row.state))) {
    fail("ANALYTICS_OWNER_RETIREMENT_STATE_UNEXPECTED");
  }
  return rows;
}

async function assertNoResidualOwnerFamilyRows(
  client: PostgresClient,
  schema: string,
  ownerDigest: string,
): Promise<void> {
  const residuals = parseRows<{ readonly count: string | number }>(await client.query(
    `SELECT
       (SELECT count(*) FROM ${table(schema, "storage_v11_event_sources")} WHERE owner_digest=$1)
       + (SELECT count(*) FROM ${table(schema, "storage_v12_event_sources")} WHERE owner_digest=$1)
       + (SELECT count(*) FROM ${table(schema, "typed_v1_event_sources")} WHERE owner_digest=$1)
       + (SELECT count(*) FROM ${table(schema, "telemetry_usage_correction_history")}
           WHERE encode(owner_digest,'hex')=$1) AS count`,
    [ownerDigest],
  ));
  if (parseCount(residuals[0]?.count) !== 0) {
    fail("ANALYTICS_OWNER_RETIREMENT_RESIDUAL_OWNER_ROWS");
  }
}

async function deleteCount(client: PostgresClient, sql: string, values: unknown[] = []): Promise<number> {
  return rowCount(await client.query(sql, values));
}

async function retainedCount(
  client: PostgresClient,
  sql: string,
  values: unknown[] = [],
): Promise<number> {
  const rows = parseRows<CountRow>(await client.query(sql, values));
  return parseCount(rows[0]?.count);
}

/**
 * Read-only check for owner-scoped analytics that retirement would remove, or
 * an owner state it would mark erased. Erasers use it where a terminal ledger
 * receipt cannot record a later refusal, such as re-erasing a restored primary.
 */
export async function hasPostgresAnalyticsOwnerResidue(
  options: RetirePostgresAnalyticsOwnerOptions,
): Promise<boolean> {
  if (options === null || typeof options !== "object"
      || typeof options.ownerDigest !== "string" || !OWNER_DIGEST.test(options.ownerDigest)
      || options.primaryPool === null || typeof options.primaryPool !== "object"
      || typeof options.primaryPool.connect !== "function") {
    fail("ANALYTICS_OWNER_RETIREMENT_TARGET_INVALID");
  }
  let config;
  try {
    config = createPostgresSchemaConfig(options.schema);
  } catch {
    fail("ANALYTICS_OWNER_RETIREMENT_TARGET_INVALID");
  }
  const schema = config.primarySchema;
  const ownerDigest = options.ownerDigest;
  const residueTables = SOURCE_OWNER_TABLES.filter((name) =>
    !RETAINED_OWNER_TABLES.has(name));
  try {
    return await withPostgresRead(options.primaryPool, async (client) => {
      const rows = parseRows<{ readonly residue: boolean }>(await client.query(
        `SELECT EXISTS (SELECT 1 FROM ${table(schema, "analytics_owner_state")}
                         WHERE owner_digest=$1 AND state <> 'erased')
                ${residueTables.map((name) =>
                  `OR EXISTS (SELECT 1 FROM ${table(schema, name)} WHERE owner_digest=$1)`).join("\n")}
                AS residue`,
        [ownerDigest],
      ));
      if (rows.length !== 1 || typeof rows[0]?.residue !== "boolean") {
        fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");
      }
      return rows[0].residue;
    }, { ...TIMEOUTS, operation: "postgres.analytics_owner_retirement.residue" });
  } catch (error) {
    if (error instanceof PostgresAnalyticsOwnerRetirementError) throw error;
    if (error instanceof PostgresStorageError) throw error;
    fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");
  }
}

/**
 * Retire derived PostgreSQL analytics for an owner whose core participant
 * deletion has committed. The immutable storage erasure receipt is the gate;
 * source/cursor locking and a caught-up projection high-water prevent a stale
 * queued event from reactivating the owner during cleanup.
 *
 * Owner-state rows, append-only ingestion/applied-event evidence, invalidation
 * markers, source cursors, and the erasure receipt are intentionally retained.
 * Daily aggregates are immutable by schema: affected revisions are withdrawn
 * and remain stored, while all owner-bearing calculation/work rows and
 * affected graph publication generations are removed. Admin metric snapshots
 * are aggregate gauge history without owner digests; like the Worker's D1
 * erasure, retirement keeps them and clears only regenerable caches.
 *
 * Every owner-bearing index leads with source_id, so owner deletes are bounded
 * to the affected sources. The discovery and residual proofs still scan by
 * owner_digest alone and must be qualified against real snapshot sizes.
 */
export async function retirePostgresAnalyticsOwner(
  options: RetirePostgresAnalyticsOwnerOptions,
): Promise<PostgresAnalyticsOwnerRetirementResult> {
  if (options === null || typeof options !== "object"
      || typeof options.ownerDigest !== "string" || !OWNER_DIGEST.test(options.ownerDigest)
      || options.primaryPool === null || typeof options.primaryPool !== "object"
      || typeof options.primaryPool.connect !== "function") {
    fail("ANALYTICS_OWNER_RETIREMENT_TARGET_INVALID");
  }

  let config;
  try {
    config = createPostgresSchemaConfig(options.schema);
  } catch {
    fail("ANALYTICS_OWNER_RETIREMENT_TARGET_INVALID");
  }
  const schema = config.primarySchema;
  const ownerDigest = options.ownerDigest;

  try {
    return await withPostgresMutation(options.primaryPool, async (client) => {
      await assertKnownOwnerDigestTables(client, schema);
      await assertNoLiveOwnerMapping(client, schema, ownerDigest);
      await assertNoResidualOwnerFamilyRows(client, schema, ownerDigest);

      const sourceIds = await readAffectedSources(client, schema, ownerDigest);
      const sourceCursorCount = await assertSourceAuthorityCaughtUp(client, schema, sourceIds);
      const ownerStates = await readOwnerStates(client, schema, ownerDigest);

      // Preserve the erased owner-state sentinel so stale calculation paths
      // cannot treat a formerly active owner as eligible again.
      const ownerStateUpdate = await client.query(
        `UPDATE ${table(schema, "analytics_owner_state")} SET state='erased'
          WHERE owner_digest=$1 AND state <> 'erased'`,
        [ownerDigest],
      );
      const expectedStateChanges = ownerStates.filter((row) => row.state !== "erased").length;
      if (rowCount(ownerStateUpdate) !== expectedStateChanges) {
        fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");
      }

      // Recreate the durable invalidation idempotently before removing cohort
      // membership and aggregate snapshots for every affected generation.
      for (const sourceId of sourceIds) {
        await client.query(
          `SELECT ${table(schema, "invalidate_analytics_publications_for_owner")}
             ($1,$2,'owner-erased')`,
          [sourceId, ownerDigest],
        );
      }

      const deleted: {
        analysisWorkParts: number; analysisWorkHeads: number;
        preparedOutputs: number; preparedControls: number; preparedStreams: number;
        preparedRows: number; preparedHeads: number; ownerResults: number; deliveryCursors: number;
        publications: number; publicationCaptures: number; publicationMembers: number;
        adminHistoryCache: number; adminAllowanceCache: number;
        adminProgressCache: number; dailyPreviewCache: number; dailyRevisionsWithdrawn: number;
        modelCompositionDaysCleared: number; previewCacheRowsCleared: number;
      } = {
        analysisWorkParts: 0, analysisWorkHeads: 0,
        preparedOutputs: 0, preparedControls: 0, preparedStreams: 0,
        preparedRows: 0, preparedHeads: 0, ownerResults: 0, deliveryCursors: 0,
        publications: 0, publicationCaptures: 0, publicationMembers: 0,
        adminHistoryCache: 0, adminAllowanceCache: 0,
        adminProgressCache: 0, dailyPreviewCache: 0, dailyRevisionsWithdrawn: 0,
        modelCompositionDaysCleared: 0, previewCacheRowsCleared: 0,
      };
      const sourceArray = [...sourceIds];

      // Discovery read every owner row's source, so an empty source set means
      // there is nothing owner-scoped to delete; the residual proof rechecks.
      if (sourceArray.length > 0) {
        const ownerGenerations =
          `SELECT DISTINCT source_id, day, metric, generation
             FROM ${table(schema, "analytics_publication_owner_members")}
            WHERE source_id=ANY($2::text[]) AND owner_digest=$1`;
        deleted.publications = await deleteCount(client,
          `DELETE FROM ${table(schema, "analytics_publications")} publication
            USING (${ownerGenerations}) target
            WHERE publication.source_id=target.source_id AND publication.day=target.day
              AND publication.metric=target.metric AND publication.generation=target.generation`,
          [ownerDigest, sourceArray]);
        deleted.publicationCaptures = await deleteCount(client,
          `DELETE FROM ${table(schema, "analytics_publication_captures")} capture
            USING (${ownerGenerations}) target
            WHERE capture.source_id=target.source_id AND capture.day=target.day
              AND capture.metric=target.metric AND capture.generation=target.generation`,
          [ownerDigest, sourceArray]);
        // Cohort siblings leave with the invalidated generation they belong to.
        deleted.publicationMembers = await deleteCount(client,
          `DELETE FROM ${table(schema, "analytics_publication_owner_members")} doomed
            USING (${ownerGenerations}) target
            WHERE doomed.source_id=target.source_id AND doomed.day=target.day
              AND doomed.metric=target.metric AND doomed.generation=target.generation`,
          [ownerDigest, sourceArray]);

        const ownerRows = (name: string): string =>
          `DELETE FROM ${table(schema, name)} WHERE source_id=ANY($2::text[]) AND owner_digest=$1`;
        const ownerValues = [ownerDigest, sourceArray];
        deleted.analysisWorkParts = await deleteCount(client, ownerRows("analytics_analysis_work_parts"), ownerValues);
        deleted.analysisWorkHeads = await deleteCount(client, ownerRows("analytics_analysis_work_heads"), ownerValues);
        deleted.preparedOutputs = await deleteCount(client, ownerRows("analytics_prepared_source_outputs"), ownerValues);
        deleted.preparedControls = await deleteCount(client, ownerRows("analytics_prepared_source_controls"), ownerValues);
        deleted.preparedStreams = await deleteCount(client, ownerRows("analytics_prepared_source_streams"), ownerValues);
        deleted.preparedRows = await deleteCount(client, ownerRows("analytics_prepared_source_rows"), ownerValues);
        deleted.preparedHeads = await deleteCount(client, ownerRows("analytics_prepared_source_heads"), ownerValues);
        deleted.ownerResults = await deleteCount(client, ownerRows("analytics_owner_results"), ownerValues);
        deleted.deliveryCursors = await deleteCount(client,
          ownerRows("analytics_scheduler_delivery_cursors"), ownerValues);

        for (const [name, key] of [
          ["analytics_admin_metrics_history_cache", "adminHistoryCache"],
          ["analytics_admin_allowance_preview_cache", "adminAllowanceCache"],
          ["analytics_admin_progress_cache", "adminProgressCache"],
          ["community_daily_allowance_preview_cache", "dailyPreviewCache"],
        ] as const) {
          deleted[key] = await deleteCount(client,
            `DELETE FROM ${table(schema, name)} WHERE source_id=ANY($1::text[])`, [sourceArray]);
        }
        deleted.dailyRevisionsWithdrawn = rowCount(await client.query(
          `UPDATE ${table(schema, "community_daily_aggregates")}
              SET release_state='withdrawn',withdrawn_at=clock_timestamp()
            WHERE source_id=ANY($1::text[]) AND release_state='published'`,
          [sourceArray],
        ));
        await client.query(
          `UPDATE ${table(schema, "community_daily_allowance_publication_state")}
              SET publication_state='updating',updated_at=clock_timestamp()
            WHERE source_id=ANY($1::text[])`,
          [sourceArray],
        );
      }

      // These two rows are global derived caches in the legacy analytical
      // lane. Any owner retirement invalidates their combined view.
      deleted.previewCacheRowsCleared = await deleteCount(client,
        `DELETE FROM ${table(schema, "preview_cache")}`);
      deleted.modelCompositionDaysCleared = await deleteCount(client,
        `DELETE FROM ${table(schema, "community_model_composition_days")}`);

      await assertNoResidualOwnerFamilyRows(client, schema, ownerDigest);
      const perOwnerResiduals = await retainedCount(client,
        `SELECT (SELECT count(*) FROM ${table(schema, "analytics_analysis_work_heads")} WHERE owner_digest=$1)
              + (SELECT count(*) FROM ${table(schema, "analytics_analysis_work_parts")} WHERE owner_digest=$1)
              + (SELECT count(*) FROM ${table(schema, "analytics_owner_results")} WHERE owner_digest=$1)
              + (SELECT count(*) FROM ${table(schema, "analytics_prepared_source_controls")} WHERE owner_digest=$1)
              + (SELECT count(*) FROM ${table(schema, "analytics_prepared_source_heads")} WHERE owner_digest=$1)
              + (SELECT count(*) FROM ${table(schema, "analytics_prepared_source_outputs")} WHERE owner_digest=$1)
              + (SELECT count(*) FROM ${table(schema, "analytics_prepared_source_rows")} WHERE owner_digest=$1)
              + (SELECT count(*) FROM ${table(schema, "analytics_prepared_source_streams")} WHERE owner_digest=$1)
              + (SELECT count(*) FROM ${table(schema, "analytics_scheduler_delivery_cursors")} WHERE owner_digest=$1)
              + (SELECT count(*) FROM ${table(schema, "analytics_publication_owner_members")} WHERE owner_digest=$1) AS count`,
        [ownerDigest]);
      if (perOwnerResiduals !== 0) fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");

      const erasedStates = await retainedCount(client,
        `SELECT count(*) FROM ${table(schema, "analytics_owner_state")}
          WHERE owner_digest=$1 AND state='erased'`, [ownerDigest]);
      const nonErasedStates = await retainedCount(client,
        `SELECT count(*) FROM ${table(schema, "analytics_owner_state")}
          WHERE owner_digest=$1 AND state <> 'erased'`, [ownerDigest]);
      if (nonErasedStates !== 0 || erasedStates !== ownerStates.length) {
        fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");
      }

      const ownerJournalRows = await retainedCount(client,
        `SELECT count(*) FROM ${table(schema, "storage_ingestion_changes")} WHERE owner_digest=$1`, [ownerDigest]);
      const appliedRows = await retainedCount(client,
        `SELECT count(*) FROM ${table(schema, "analytics_applied_events")} WHERE owner_digest=$1`, [ownerDigest]);
      const invalidationRows = await retainedCount(client,
        `SELECT count(*) FROM ${table(schema, "analytics_publication_invalidations")} WHERE owner_digest=$1`, [ownerDigest]);
      const receiptCount = await retainedCount(client,
        `SELECT count(*) FROM ${table(schema, "storage_owner_erasure_receipts")} WHERE owner_digest=$1`, [ownerDigest]);
      if (receiptCount !== 1) fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");

      const unwithdrawnDaily = sourceArray.length === 0 ? 0 : await retainedCount(client,
        `SELECT count(*) FROM ${table(schema, "community_daily_aggregates")}
          WHERE source_id=ANY($1::text[]) AND release_state='published'`, [sourceArray]);
      if (unwithdrawnDaily !== 0) fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");
      const withdrawnDaily = sourceArray.length === 0 ? 0 : await retainedCount(client,
        `SELECT count(*) FROM ${table(schema, "community_daily_aggregates")}
          WHERE source_id=ANY($1::text[]) AND release_state='withdrawn'`, [sourceArray]);
      const uninvalidatedCaches = sourceArray.length === 0 ? 0 : await retainedCount(client,
        `SELECT (SELECT count(*) FROM ${table(schema, "analytics_admin_metrics_history_cache")} WHERE source_id=ANY($1::text[]))
              + (SELECT count(*) FROM ${table(schema, "analytics_admin_allowance_preview_cache")} WHERE source_id=ANY($1::text[]))
              + (SELECT count(*) FROM ${table(schema, "analytics_admin_progress_cache")} WHERE source_id=ANY($1::text[]))
              + (SELECT count(*) FROM ${table(schema, "community_daily_allowance_preview_cache")} WHERE source_id=ANY($1::text[])) AS count`,
        [sourceArray]);
      const unclearedGlobalCaches = await retainedCount(client,
        `SELECT (SELECT count(*) FROM ${table(schema, "preview_cache")})
              + (SELECT count(*) FROM ${table(schema, "community_model_composition_days")}) AS count`);
      const liveOwnerLinks = await retainedCount(client,
        `SELECT count(*) FROM ${table(schema, "storage_v11_owner_links")} WHERE owner_digest=$1`, [ownerDigest]);
      if (uninvalidatedCaches !== 0 || unclearedGlobalCaches !== 0 || liveOwnerLinks !== 0) {
        fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");
      }

      return Object.freeze({
        status: "complete" as const,
        sourceCount: sourceIds.length,
        deleted: Object.freeze(deleted),
        retained: Object.freeze({
          erasureReceipts: 1 as const,
          ownerStateTombstones: erasedStates,
          sourceJournalRows: ownerJournalRows,
          appliedEventReceipts: appliedRows,
          sourceCursors: sourceCursorCount,
          publicationInvalidations: invalidationRows,
          withdrawnDailyRevisions: withdrawnDaily,
        }),
      });
    }, { ...TIMEOUTS, operation: TIMEOUTS.operation, preserveSafeError });
  } catch (error) {
    if (error instanceof PostgresAnalyticsOwnerRetirementError) throw error;
    if (error instanceof PostgresStorageError) throw error;
    fail("ANALYTICS_OWNER_RETIREMENT_READBACK_FAILED");
  }
}
