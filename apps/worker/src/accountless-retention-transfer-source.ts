/**
 * Private source-side snapshot support for transferring opted-out accountless
 * retention markers: v1.1 markers, and since ingestion-isolation migration 0014
 * also v1.2-only markers, whose rows carry the successor grant in their grant
 * fields (see that migration). This module has no route or authorization surface;
 * its caller must be an owner-only migration operator. Never log returned rows,
 * participant/device identifiers, or either device-secret hash.
 *
 * D1's batch API is a SQL transaction: its statements run sequentially and
 * non-concurrently, and a failed statement rolls the complete batch back. The
 * first batch below therefore captures the revision, candidate counts, and all
 * eligible proof rows from one D1 state. Subsequent bounded pages read only
 * this immutable materialization. Source triggers advance the authority epoch
 * and invalidate the run in the same transaction as any relevant source
 * mutation.
 */

export const ACCOUNTLESS_RETENTION_TRANSFER_DEFAULT_PAGE_SIZE = 200;
export const ACCOUNTLESS_RETENTION_TRANSFER_MAX_PAGE_SIZE = 500;

const EXPECTED_SOURCE_MIGRATIONS = Object.freeze([
  "0061_accountless_history_retention.sql",
  "0062_v1_acquisition_vocabulary.sql",
  "0063_accountless_history_transfer_source.sql",
]);
const LATEST_SOURCE_MIGRATION = EXPECTED_SOURCE_MIGRATIONS.at(-1)!;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_UTC_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const SNAPSHOT_FIELDS = Object.freeze([
  "participant_id",
  "marker_enrollment_device_id",
  "marker_device_credential_id",
  "marker_generation_id",
  "marker_head_revision",
  "marker_retained_at",
  "participant_owner_kind",
  "participant_state",
  "owner_participant_id",
  "owner_enrollment_device_id",
  "owner_device_credential_id",
  "owner_policy_version",
  "owner_authorization_basis",
  "owner_expires_at",
  "owner_state",
  "owner_revoked_at",
  "owner_revocation_reason",
  "ledger_device_id",
  "ledger_device_secret_hash",
  "ledger_schema_version",
  "ledger_policy_version",
  "ledger_authorization_basis",
  "ledger_expires_at",
  "ledger_state",
  "ledger_revoked_at",
  "ledger_revocation_reason",
  "device_id",
  "device_participant_id",
  "device_authority_kind",
  "device_enrollment_device_id",
  "device_secret_hash",
  "device_paired_via_pairing_id",
  "device_social_verified_at",
  "device_expires_at",
  "device_state",
  "device_revoked_at",
  "grant_enrollment_device_id",
  "grant_participant_id",
  "grant_device_credential_id",
  "grant_telemetry_schema_version",
  "grant_field_dictionary_version",
  "grant_privacy_contract_version",
  "grant_expires_at",
  "grant_state",
  "grant_revoked_at",
  "grant_revocation_reason",
  "head_participant_id",
  "head_generation_id",
  "head_revision",
  "domain_id",
  "domain_participant_id",
  "domain_device_id",
]);

const SNAPSHOT_PROJECTION = SNAPSHOT_FIELDS.map((field) => `candidate.${field}`).join(",\n  ");
const SNAPSHOT_COLUMN_LIST = SNAPSHOT_FIELDS.join(",\n  ");

type SnapshotScalar = string | number | null | ArrayBuffer | Uint8Array | readonly number[];
export type AccountlessRetentionSourceRow = Readonly<Record<string, SnapshotScalar>>;

export interface AccountlessRetentionSnapshot {
  readonly runId: string;
  readonly state: "sealed";
  readonly sourceRevision: number;
  readonly latestMigrationName: string;
  readonly snapshotAt: string;
  readonly rowCount: number;
  readonly migrationReceipts: readonly string[];
}

export interface AccountlessRetentionSnapshotPage {
  readonly runId: string;
  readonly pageNumber: number;
  readonly afterParticipantId: string;
  readonly throughParticipantId: string;
  readonly rows: readonly AccountlessRetentionSourceRow[];
  readonly rowDigests: readonly Readonly<{ participantId: string; sha256: string }>[];
  readonly pageSha256: string;
  readonly manifestSha256: string;
  readonly hasMore: boolean;
}

export interface AccountlessRetentionExtraction {
  readonly runId: string;
  readonly state: "extracted";
  readonly sourceRevision: number;
  readonly rowCount: number;
  readonly pageCount: number;
  readonly manifestSha256: string;
}

export class AccountlessRetentionTransferSourceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AccountlessRetentionTransferSourceError";
    this.code = code;
  }
}

interface RunStatusRow {
  state: string;
  source_revision: number;
  latest_migration_name: string | null;
  snapshot_at: string;
  candidate_count: number;
  row_count: number;
  invalid_marker_count: number;
  migration_count: number;
  invalidation_code: string | null;
  authority_revision: number;
  latest_applied_migration: string | null;
  applied_source_migration_count: number;
  recorded_source_migration_count: number;
}

interface PageReceiptRow {
  page_number: number;
  after_participant_id: string;
  through_participant_id: string;
  row_count: number;
  page_sha256: string;
  manifest_sha256: string;
}

interface SnapshotRowResult extends Record<string, SnapshotScalar> {
  participant_id: string;
}

function fail(code: string): never {
  throw new AccountlessRetentionTransferSourceError(code);
}

function validateRunId(runId: string): void {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    fail("SOURCE_RUN_ID_INVALID");
  }
}

function validateCanonicalTimestamp(value: string): void {
  if (typeof value !== "string"
      || !ISO_UTC_MILLIS_PATTERN.test(value)
      || new Date(value).toISOString() !== value) {
    fail("SOURCE_TIMESTAMP_NON_CANONICAL");
  }
}

function validatePositiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
}

function batchRows<T>(result: D1Result | undefined, code: string): T[] {
  if (!result || result.success !== true || !Array.isArray(result.results)) {
    fail(code);
  }
  return result.results as T[];
}

function batchChanged(result: D1Result | undefined, code: string): number {
  if (!result || result.success !== true || !result.meta
      || !Number.isSafeInteger(result.meta.changes)) {
    fail(code);
  }
  return result.meta.changes;
}

function assertRunCurrent(row: RunStatusRow | undefined): asserts row is RunStatusRow {
  if (!row) fail("SOURCE_SNAPSHOT_UNKNOWN");
  if (row.state !== "sealed" && row.state !== "extracted") {
    fail(row.invalidation_code ?? "SOURCE_SNAPSHOT_INVALIDATED");
  }
  if (row.source_revision !== row.authority_revision) {
    fail("SOURCE_AUTHORITY_REVISION_CHANGED");
  }
  if (row.latest_migration_name !== LATEST_SOURCE_MIGRATION
      || row.latest_applied_migration !== LATEST_SOURCE_MIGRATION
      || row.migration_count !== EXPECTED_SOURCE_MIGRATIONS.length
      || row.applied_source_migration_count !== EXPECTED_SOURCE_MIGRATIONS.length
      || row.recorded_source_migration_count !== EXPECTED_SOURCE_MIGRATIONS.length) {
    fail("SOURCE_MIGRATION_RECEIPT_MISMATCH");
  }
  if (row.invalid_marker_count !== 0 || row.row_count !== row.candidate_count) {
    fail("SOURCE_MARKER_INELIGIBLE");
  }
}

function statusQuery(): string {
  return `SELECT run.state, run.source_revision, run.latest_migration_name,
      run.snapshot_at, run.candidate_count, run.row_count,
      run.invalid_marker_count, run.migration_count, run.invalidation_code,
      control.authority_revision,
      (SELECT MAX(name) FROM d1_migrations) AS latest_applied_migration,
      (SELECT COUNT(*) FROM d1_migrations
        WHERE name IN (${EXPECTED_SOURCE_MIGRATIONS.map(() => "?").join(", ")}))
        AS applied_source_migration_count,
      (SELECT COUNT(*) FROM accountless_history_transfer_migration_receipts
        WHERE run_id = run.run_id) AS recorded_source_migration_count
    FROM accountless_history_transfer_runs run
    JOIN accountless_history_transfer_control control ON control.singleton_id = 1
    WHERE run.run_id = ?`;
}

function statusBindings(runId: string): (string)[] {
  return [...EXPECTED_SOURCE_MIGRATIONS, runId];
}

function bindStatus(db: D1Database, runId: string): D1PreparedStatement {
  return db.prepare(statusQuery()).bind(...statusBindings(runId));
}

function byteHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function canonicalCell(value: SnapshotScalar): readonly [string, string] {
  if (value === null) return ["null", ""];
  if (typeof value === "string") return ["text", value];
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("SOURCE_ROW_NUMBER_INVALID");
    return ["integer", String(value)];
  }
  // D1 test runtimes may return an ArrayBuffer/typed view from another realm,
  // so instanceof checks alone do not reliably identify byte values.
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return ["blob-hex", byteHex(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))];
  }
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return ["blob-hex", byteHex(new Uint8Array(value as ArrayBuffer))];
  }
  if (Array.isArray(value)) {
    if (!value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      fail("SOURCE_ROW_BLOB_INVALID");
    }
    return ["blob-hex", byteHex(Uint8Array.from(value))];
  }
  fail("SOURCE_ROW_VALUE_INVALID");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return byteHex(new Uint8Array(digest));
}

async function rowSha256(row: AccountlessRetentionSourceRow): Promise<string> {
  const ordered = SNAPSHOT_FIELDS.map((field) => {
    if (!Object.hasOwn(row, field)) fail("SOURCE_ROW_FIELD_MISSING");
    return [field, canonicalCell(row[field]!)];
  });
  const json = JSON.stringify(ordered);
  return sha256(`tibotattle-accountless-retention-row-v1\n${json}`);
}

async function manifestSeed(runId: string, sourceRevision: number): Promise<string> {
  return sha256(`tibotattle-accountless-retention-manifest-v1\n${runId}\n${sourceRevision}`);
}

async function manifestStep(
  priorSha256: string,
  pageNumber: number,
  afterParticipantId: string,
  throughParticipantId: string,
  rowCount: number,
  pageSha256: string,
): Promise<string> {
  return sha256([
    "tibotattle-accountless-retention-manifest-page-v1",
    priorSha256,
    String(pageNumber),
    afterParticipantId,
    throughParticipantId,
    String(rowCount),
    pageSha256,
  ].join("\n"));
}

function assertProofTimestamps(row: AccountlessRetentionSourceRow): void {
  for (const field of [
    "marker_retained_at",
    "owner_expires_at",
    "owner_revoked_at",
    "ledger_expires_at",
    "ledger_revoked_at",
    "device_expires_at",
    "device_revoked_at",
    "grant_expires_at",
    "grant_revoked_at",
  ]) {
    const value = row[field];
    if (typeof value !== "string") fail("SOURCE_PROOF_TIMESTAMP_MISSING");
    validateCanonicalTimestamp(value);
  }
}

function migrationReceiptInsert(db: D1Database, runId: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO accountless_history_transfer_migration_receipts
      (run_id, migration_name)
    SELECT ?1, name FROM d1_migrations
     WHERE name IN (?2, ?3, ?4)
     ORDER BY name`).bind(runId, ...EXPECTED_SOURCE_MIGRATIONS);
}

function captureRowsInsert(db: D1Database, runId: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO accountless_history_transfer_rows (
      run_id, ${SNAPSHOT_COLUMN_LIST}
    )
    SELECT ?1, ${SNAPSHOT_PROJECTION}
      FROM accountless_history_transfer_candidates candidate
     WHERE candidate.is_eligible = 1
       AND EXISTS (
         SELECT 1 FROM accountless_history_transfer_runs run
          WHERE run.run_id = ?1 AND run.state = 'capturing'
            AND run.invalid_marker_count = 0
            AND run.migration_count = 3
            AND run.latest_migration_name = ?2
       )
     ORDER BY candidate.participant_id COLLATE BINARY`)
    .bind(runId, LATEST_SOURCE_MIGRATION);
}

function pagePersistenceGuardSql(firstParameter: number): string {
  const parameter = (offset: number) => `?${firstParameter + offset}`;
  return `EXISTS (
    SELECT 1
      FROM accountless_history_transfer_runs run
      JOIN accountless_history_transfer_control control ON control.singleton_id = 1
     WHERE run.run_id = ${parameter(0)} AND run.state = 'sealed'
       AND run.source_revision = control.authority_revision
       AND run.latest_migration_name = ${parameter(1)}
       AND (SELECT MAX(name) FROM d1_migrations) = ${parameter(1)}
       AND (SELECT COUNT(*) FROM d1_migrations
             WHERE name IN (${parameter(2)}, ${parameter(3)}, ${parameter(4)})) = 3
       AND (SELECT COUNT(*) FROM accountless_history_transfer_migration_receipts
             WHERE run_id = run.run_id) = 3
       AND COALESCE((SELECT MAX(page_number)
             FROM accountless_history_transfer_pages WHERE run_id = run.run_id), 0) = ${parameter(5)}
       AND COALESCE((SELECT through_participant_id
             FROM accountless_history_transfer_pages WHERE run_id = run.run_id
             ORDER BY page_number DESC LIMIT 1), '') = ${parameter(6)}
  )`;
}

/**
 * Materialize an exact source state. All D1 work that reads or writes authority
 * and snapshot rows happens in one transaction. Invalid or unknown markers
 * cause a failed run; they are counted but are not copied into the snapshot.
 */
export async function captureAccountlessRetentionSourceSnapshot(
  db: D1Database,
  input: { readonly runId: string; readonly snapshotAt: string },
): Promise<AccountlessRetentionSnapshot> {
  validateRunId(input.runId);
  validateCanonicalTimestamp(input.snapshotAt);

  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(`INSERT INTO accountless_history_transfer_runs (
          run_id, state, source_revision, latest_migration_name,
          candidate_count, row_count, invalid_marker_count, migration_count,
          snapshot_at
        )
        SELECT ?1, 'capturing', control.authority_revision,
          (SELECT MAX(name) FROM d1_migrations),
          (SELECT COUNT(*) FROM accountless_history_transfer_candidates),
          0,
          (SELECT COUNT(*) FROM accountless_history_transfer_candidates
            WHERE is_eligible = 0),
          (SELECT COUNT(*) FROM d1_migrations WHERE name IN (?3, ?4, ?5)),
          ?2
        FROM accountless_history_transfer_control control
        WHERE control.singleton_id = 1
          AND NOT EXISTS (SELECT 1 FROM accountless_history_transfer_runs
                           WHERE state IN ('capturing', 'sealed', 'extracted'))`)
        .bind(input.runId, input.snapshotAt, ...EXPECTED_SOURCE_MIGRATIONS),
      migrationReceiptInsert(db, input.runId),
      captureRowsInsert(db, input.runId),
      db.prepare(`UPDATE accountless_history_transfer_runs
         SET row_count = CASE
               WHEN invalid_marker_count = 0 AND migration_count = 3
                AND latest_migration_name = ?2
                AND (SELECT COUNT(*) FROM accountless_history_transfer_rows
                      WHERE run_id = ?1) = candidate_count
               THEN candidate_count ELSE 0 END,
             state = CASE
               WHEN invalid_marker_count = 0 AND migration_count = 3
                AND latest_migration_name = ?2
                AND (SELECT COUNT(*) FROM accountless_history_transfer_rows
                      WHERE run_id = ?1) = candidate_count
               THEN 'sealed' ELSE 'invalidated' END,
             invalidation_code = CASE
               WHEN latest_migration_name IS NOT ?2 OR migration_count != 3
                 THEN 'SOURCE_MIGRATION_RECEIPT_MISMATCH'
               WHEN invalid_marker_count != 0
                 THEN 'SOURCE_MARKER_INELIGIBLE'
               WHEN (SELECT COUNT(*) FROM accountless_history_transfer_rows
                      WHERE run_id = ?1) != candidate_count
                 THEN 'SOURCE_MARKER_INELIGIBLE'
               ELSE NULL END
       WHERE run_id = ?1 AND state = 'capturing'`)
        .bind(input.runId, LATEST_SOURCE_MIGRATION),
      db.prepare(`${statusQuery()}`).bind(...statusBindings(input.runId)),
      db.prepare(`SELECT migration_name FROM accountless_history_transfer_migration_receipts
        WHERE run_id = ? ORDER BY migration_name COLLATE BINARY`).bind(input.runId),
    ]);
  } catch {
    fail("SOURCE_SNAPSHOT_CAPTURE_FAILED");
  }

  for (const result of results) {
    if (!result || result.success !== true) fail("SOURCE_SNAPSHOT_CAPTURE_FAILED");
  }
  const insertedRunCount = batchChanged(results[0], "SOURCE_SNAPSHOT_ALREADY_OPEN");
  if (insertedRunCount !== 1) fail("SOURCE_SNAPSHOT_ALREADY_OPEN");
  const status = batchRows<RunStatusRow>(results[4], "SOURCE_SNAPSHOT_CAPTURE_FAILED")[0];
  const receipts = batchRows<{ migration_name: string }>(
    results[5],
    "SOURCE_SNAPSHOT_CAPTURE_FAILED",
  ).map((row) => row.migration_name);
  if (!status) fail("SOURCE_SNAPSHOT_CAPTURE_FAILED");
  if (status.state !== "sealed") {
    fail(status.invalidation_code ?? "SOURCE_SNAPSHOT_REFUSED");
  }
  if (receipts.length !== EXPECTED_SOURCE_MIGRATIONS.length
      || EXPECTED_SOURCE_MIGRATIONS.some((name) => !receipts.includes(name))) {
    fail("SOURCE_MIGRATION_RECEIPT_MISMATCH");
  }
  validatePositiveInteger(status.source_revision, "SOURCE_REVISION_INVALID");
  validatePositiveInteger(status.row_count, "SOURCE_ROW_COUNT_INVALID");
  validateCanonicalTimestamp(status.snapshot_at);
  return Object.freeze({
    runId: input.runId,
    state: "sealed",
    sourceRevision: status.source_revision,
    latestMigrationName: LATEST_SOURCE_MIGRATION,
    snapshotAt: status.snapshot_at,
    rowCount: status.row_count,
    migrationReceipts: Object.freeze(receipts),
  });
}

/**
 * Read and checksum one bounded keyset page from the immutable D1 artifact.
 * A page receipt and per-row hashes are persisted only if the source revision,
 * migration receipts, and expected contiguous cursor are still current.
 */
export async function readAccountlessRetentionSourcePage(
  db: D1Database,
  input: {
    readonly runId: string;
    readonly afterParticipantId?: string;
    readonly limit?: number;
  },
): Promise<AccountlessRetentionSnapshotPage | null> {
  validateRunId(input.runId);
  const afterParticipantId = input.afterParticipantId ?? "";
  if (typeof afterParticipantId !== "string" || afterParticipantId.length > 120) {
    fail("SOURCE_PAGE_CURSOR_INVALID");
  }
  const limit = input.limit ?? ACCOUNTLESS_RETENTION_TRANSFER_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1
      || limit > ACCOUNTLESS_RETENTION_TRANSFER_MAX_PAGE_SIZE) {
    fail("SOURCE_PAGE_LIMIT_INVALID");
  }

  let readResults: D1Result[];
  try {
    readResults = await db.batch([
      bindStatus(db, input.runId),
      db.prepare(`SELECT * FROM accountless_history_transfer_pages
        WHERE run_id = ? ORDER BY page_number DESC LIMIT 1`).bind(input.runId),
      db.prepare(`SELECT ${SNAPSHOT_FIELDS.join(", ")}
        FROM accountless_history_transfer_rows
        WHERE run_id = ? AND participant_id COLLATE BINARY > ?
        ORDER BY participant_id COLLATE BINARY LIMIT ?`)
        .bind(input.runId, afterParticipantId, limit + 1),
    ]);
  } catch {
    fail("SOURCE_PAGE_READ_FAILED");
  }
  const run = batchRows<RunStatusRow>(readResults[0], "SOURCE_PAGE_READ_FAILED")[0];
  assertRunCurrent(run);
  const priorPage = batchRows<PageReceiptRow>(readResults[1], "SOURCE_PAGE_READ_FAILED")[0];
  const expectedCursor = priorPage?.through_participant_id ?? "";
  if (expectedCursor !== afterParticipantId) fail("SOURCE_PAGE_CURSOR_CONFLICT");
  const fetchedRows = batchRows<SnapshotRowResult>(readResults[2], "SOURCE_PAGE_READ_FAILED");
  if (fetchedRows.length === 0) return null;

  const rows = fetchedRows.slice(0, limit);
  for (const row of rows) assertProofTimestamps(row);
  const rowDigests = await Promise.all(rows.map(async (row) => Object.freeze({
    participantId: row.participant_id,
    sha256: await rowSha256(row),
  })));
  const pageNumber = (priorPage?.page_number ?? 0) + 1;
  const throughParticipantId = rows.at(-1)!.participant_id;
  const pageSha256 = await sha256([
    "tibotattle-accountless-retention-page-v1",
    ...rowDigests.map((row) => `${row.participantId}\0${row.sha256}`),
  ].join("\n"));
  const priorManifest = priorPage?.manifest_sha256
    ?? await manifestSeed(input.runId, run.source_revision);
  const manifestSha256 = await manifestStep(
    priorManifest,
    pageNumber,
    afterParticipantId,
    throughParticipantId,
    rows.length,
    pageSha256,
  );
  const digestInput = JSON.stringify(rowDigests.map((row) => ({
    participantId: row.participantId,
    sha256: row.sha256,
  })));
  const rowDigestGuard = pagePersistenceGuardSql(3);
  const pageReceiptGuard = pagePersistenceGuardSql(8);

  let persistResults: D1Result[];
  try {
    persistResults = await db.batch([
      db.prepare(`INSERT INTO accountless_history_transfer_row_digests
          (run_id, participant_id, row_sha256)
        SELECT ?1, json_extract(value, '$.participantId'),
               json_extract(value, '$.sha256')
          FROM json_each(?2)
         WHERE ${rowDigestGuard}`)
        .bind(input.runId, digestInput, input.runId, LATEST_SOURCE_MIGRATION,
          ...EXPECTED_SOURCE_MIGRATIONS, pageNumber - 1, afterParticipantId),
      db.prepare(`INSERT INTO accountless_history_transfer_pages (
          run_id, page_number, after_participant_id, through_participant_id,
          row_count, page_sha256, manifest_sha256
        )
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE ${pageReceiptGuard}`)
        .bind(input.runId, pageNumber, afterParticipantId, throughParticipantId,
          rows.length, pageSha256, manifestSha256, input.runId, LATEST_SOURCE_MIGRATION,
          ...EXPECTED_SOURCE_MIGRATIONS, pageNumber - 1, afterParticipantId),
      db.prepare(`SELECT page_number, after_participant_id, through_participant_id,
          row_count, page_sha256, manifest_sha256
        FROM accountless_history_transfer_pages
        WHERE run_id = ? AND page_number = ?`).bind(input.runId, pageNumber),
    ]);
  } catch {
    fail("SOURCE_PAGE_CHECKPOINT_FAILED");
  }
  const persisted = batchRows<PageReceiptRow>(
    persistResults[2],
    "SOURCE_PAGE_CHECKPOINT_FAILED",
  )[0];
  if (!persisted
      || persisted.after_participant_id !== afterParticipantId
      || persisted.through_participant_id !== throughParticipantId
      || persisted.row_count !== rows.length
      || persisted.page_sha256 !== pageSha256
      || persisted.manifest_sha256 !== manifestSha256) {
    fail("SOURCE_SNAPSHOT_INVALIDATED");
  }

  return Object.freeze({
    runId: input.runId,
    pageNumber,
    afterParticipantId,
    throughParticipantId,
    rows: Object.freeze(rows),
    rowDigests: Object.freeze(rowDigests),
    pageSha256,
    manifestSha256,
    hasMore: fetchedRows.length > limit,
  });
}

/** Verify the complete ordered snapshot and seal its persisted manifest. */
export async function completeAccountlessRetentionSourceExtraction(
  db: D1Database,
  runId: string,
): Promise<AccountlessRetentionExtraction> {
  validateRunId(runId);
  let summaryResults: D1Result[];
  try {
    summaryResults = await db.batch([
      bindStatus(db, runId),
      db.prepare(`SELECT COUNT(*) AS row_digest_count FROM accountless_history_transfer_row_digests
        WHERE run_id = ?`).bind(runId),
      db.prepare(`SELECT COALESCE(SUM(row_count), 0) AS page_row_count,
          COUNT(*) AS page_count, MAX(page_number) AS max_page,
          MIN(page_number) AS min_page, MAX(through_participant_id) AS last_page_key
        FROM accountless_history_transfer_pages WHERE run_id = ?`).bind(runId),
      db.prepare(`SELECT MAX(participant_id) AS last_snapshot_key
        FROM accountless_history_transfer_rows WHERE run_id = ?`).bind(runId),
      db.prepare(`SELECT manifest_sha256
        FROM accountless_history_transfer_pages WHERE run_id = ?
        ORDER BY page_number DESC LIMIT 1`).bind(runId),
    ]);
  } catch {
    fail("SOURCE_EXTRACTION_VERIFY_FAILED");
  }
  const run = batchRows<RunStatusRow>(summaryResults[0], "SOURCE_EXTRACTION_VERIFY_FAILED")[0];
  assertRunCurrent(run);
  const digestCount = batchRows<{ row_digest_count: number }>(
    summaryResults[1], "SOURCE_EXTRACTION_VERIFY_FAILED",
  )[0]?.row_digest_count;
  const pages = batchRows<{
    page_row_count: number;
    page_count: number;
    max_page: number | null;
    min_page: number | null;
    last_page_key: string | null;
  }>(summaryResults[2], "SOURCE_EXTRACTION_VERIFY_FAILED")[0];
  const lastRow = batchRows<{ last_snapshot_key: string | null }>(
    summaryResults[3], "SOURCE_EXTRACTION_VERIFY_FAILED",
  )[0]?.last_snapshot_key ?? null;
  const lastPageManifest = batchRows<{ manifest_sha256: string }>(
    summaryResults[4], "SOURCE_EXTRACTION_VERIFY_FAILED",
  )[0]?.manifest_sha256 ?? null;
  if (!pages || digestCount !== run.row_count || pages.page_row_count !== run.row_count
      || (pages.page_count > 0
        && (pages.min_page !== 1 || pages.max_page !== pages.page_count
          || pages.last_page_key !== lastRow))
      || (run.row_count > 0 && pages.page_count === 0)) {
    fail("SOURCE_EXTRACTION_INCOMPLETE");
  }
  validatePositiveInteger(pages.page_count, "SOURCE_PAGE_COUNT_INVALID");
  const manifestSha256 = lastPageManifest
    ?? await manifestSeed(runId, run.source_revision);
  if (!SHA256_PATTERN.test(manifestSha256)) fail("SOURCE_MANIFEST_INVALID");

  let finishResults: D1Result[];
  try {
    finishResults = await db.batch([
      db.prepare(`UPDATE accountless_history_transfer_runs
         SET state = 'extracted', manifest_sha256 = ?2, page_count = ?3
       WHERE run_id = ?1 AND state = 'sealed'
         AND source_revision = (SELECT authority_revision
           FROM accountless_history_transfer_control WHERE singleton_id = 1)
         AND latest_migration_name = ?4
         AND (SELECT MAX(name) FROM d1_migrations) = ?4
         AND (SELECT COUNT(*) FROM d1_migrations WHERE name IN (?5, ?6, ?7)) = 3
         AND (SELECT COUNT(*) FROM accountless_history_transfer_migration_receipts
               WHERE run_id = ?1) = 3
         AND (SELECT COUNT(*) FROM accountless_history_transfer_rows
               WHERE run_id = ?1) = row_count
         AND (SELECT COUNT(*) FROM accountless_history_transfer_row_digests
               WHERE run_id = ?1) = row_count
         AND (SELECT COALESCE(SUM(row_count), 0)
               FROM accountless_history_transfer_pages WHERE run_id = ?1) = row_count`)
        .bind(runId, manifestSha256, pages.page_count, LATEST_SOURCE_MIGRATION,
          ...EXPECTED_SOURCE_MIGRATIONS),
      bindStatus(db, runId),
    ]);
  } catch {
    fail("SOURCE_EXTRACTION_SEAL_FAILED");
  }
  const finalRun = batchRows<RunStatusRow>(finishResults[1], "SOURCE_EXTRACTION_SEAL_FAILED")[0];
  if (batchChanged(finishResults[0], "SOURCE_EXTRACTION_SEAL_FAILED") !== 1
      || !finalRun || finalRun.state !== "extracted"
      || finalRun.source_revision !== finalRun.authority_revision) {
    fail(finalRun?.invalidation_code ?? "SOURCE_SNAPSHOT_INVALIDATED");
  }
  return Object.freeze({
    runId,
    state: "extracted",
    sourceRevision: finalRun.source_revision,
    rowCount: finalRun.row_count,
    pageCount: pages.page_count,
    manifestSha256,
  });
}

/** Close an abandoned local/test run so another source snapshot can be made. */
export async function abortAccountlessRetentionSourceSnapshot(
  db: D1Database,
  runId: string,
): Promise<void> {
  validateRunId(runId);
  try {
    const result = await db.prepare(`UPDATE accountless_history_transfer_runs
       SET state = 'aborted', invalidation_code = 'SOURCE_SNAPSHOT_ABORTED'
     WHERE run_id = ? AND state IN ('sealed', 'extracted')`).bind(runId).run();
    if (!result.success) fail("SOURCE_SNAPSHOT_ABORT_FAILED");
  } catch (error) {
    if (error instanceof AccountlessRetentionTransferSourceError) throw error;
    fail("SOURCE_SNAPSHOT_ABORT_FAILED");
  }
}

/** Recheck the source fence before using an extracted artifact elsewhere. */
export async function assertAccountlessRetentionSourceSnapshotCurrent(
  db: D1Database,
  runId: string,
): Promise<{ readonly sourceRevision: number; readonly state: "sealed" | "extracted" }> {
  validateRunId(runId);
  let row: RunStatusRow | null;
  try {
    row = await bindStatus(db, runId).first<RunStatusRow>();
  } catch {
    fail("SOURCE_FENCE_READ_FAILED");
  }
  const current = row ?? undefined;
  assertRunCurrent(current);
  return Object.freeze({
    sourceRevision: current.source_revision,
    state: current.state as "sealed" | "extracted",
  });
}
