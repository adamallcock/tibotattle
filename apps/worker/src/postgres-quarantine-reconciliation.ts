/**
 * Reconcile aged PostgreSQL object registrations against quarantine storage.
 *
 * This adapter is source-only: a host must explicitly schedule/invoke it and
 * inject both PostgreSQL and the quarantine object store. It is not wired into
 * the Cloud Run request path or a hosted maintenance schedule.
 */
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
import {
  assertQuarantineObjectKey,
  QuarantineObjectStorageUnavailableError,
  type QuarantineObjectStore,
} from "./quarantine-object-store";

export const DEFAULT_POSTGRES_PENDING_OBJECT_SAFETY_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;
export const MINIMUM_POSTGRES_PENDING_OBJECT_SAFETY_WINDOW_MILLISECONDS = 60 * 60 * 1000;
export const MAXIMUM_POSTGRES_PENDING_OBJECT_SAFETY_WINDOW_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
export const POSTGRES_PENDING_OBJECT_RECONCILIATION_BATCH_LIMIT = 100;

/**
 * The E-PT4 cutover guard (staged primary migration
 * *_pending_object_transfer_holds.sql). A pending_objects row whose
 * object_key has an unreleased hold names an object that may still live only
 * in Cloudflare R2 until the post-switch PT-7 copy; the reconciler never
 * selects or claims it, so it can neither be cleared as "already absent" nor
 * deleted. PT-7 releases each hold with releasePostgresPendingObjectTransferHolds.
 * While the table is absent (the migration not applied) there are no holds;
 * PT-8 preflight P13 refuses a cutover target without the table unless the
 * owner recorded accept-orphan-registration-clearing.
 */
export const POSTGRES_PENDING_OBJECT_TRANSFER_HOLD_TABLE = "pending_object_transfer_holds";
export const POSTGRES_PENDING_OBJECT_TRANSFER_HOLD_RELEASE_LIMIT = 1_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const LEASE_PREFIX = "pgq1";
const LEASE_PATTERN = /^pgq1:([0-9]{13}):([0-9a-f]{32})$/u;
const LEASE_SQL_PATTERN = "^pgq1:[0-9]{13}:[0-9a-f]{32}$";

export interface PostgresPendingObjectReconciliationOptions {
  readonly schema?: PostgresSchemaOptions;
  readonly nowEpoch?: number;
  readonly safetyWindowMilliseconds?: number;
  readonly maximumRegistrations?: number;
}

export interface PostgresPendingObjectReconciliationResult {
  /** Rows selected for this bounded page, including races resolved as no-ops. */
  readonly registrationsExamined: number;
  /** Old registered rows moved to `deleting`; a later pass may delete them. */
  readonly deletionGraceStarted: number;
  /** Stale deleting leases adopted and held for another safety window. */
  readonly legacyLeasesAdopted: number;
  /** Objects whose GCS delete was acknowledged. */
  readonly orphanObjectsDeleted: number;
  /** Journal rows cleared after authoritative absence was proved by `head`. */
  readonly orphanObjectsAlreadyAbsent: number;
  /** Referenced object rows left untouched or restored to `registered`. */
  readonly referencedObjectsPreserved: number;
  /** Candidates that another writer/reconciler made ineligible before claim. */
  readonly candidatesDeferred: number;
  /** More due orphan registrations exist beyond this page. */
  readonly hasMore: boolean;
}

interface PendingObjectRow {
  contribution_id: string;
  object_key: string;
  object_kind: string;
  registered_at: string | Date;
  reconciliation_state: "registered" | "deleting";
  reconciliation_lease_id: string | null;
  registration_token: string;
}

interface ClaimedObject {
  readonly row: PendingObjectRow;
  readonly leaseId: string;
  readonly action: "grace_started" | "delete" | "referenced" | "deferred";
}

function safeInvalidOptions(): never {
  throw new PostgresStorageError("invalid", "quarantine.reconcile.options");
}

/**
 * Lease IDs carry only an epoch and a random claim identity. The schema's
 * `reconciliation_lease_id` is opaque text, and this lets a retry establish
 * when an earlier delete claim stopped being fresh without a new column.
 */
export function createPostgresPendingObjectReconciliationLeaseId(
  nowEpoch = Date.now(),
): string {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0 || nowEpoch > 9_999_999_999_999) {
    return safeInvalidOptions();
  }
  return `${LEASE_PREFIX}:${String(nowEpoch).padStart(13, "0")}:${crypto.randomUUID().replaceAll("-", "")}`;
}

function leaseEpoch(value: string | null): number | null {
  if (typeof value !== "string") return null;
  const match = LEASE_PATTERN.exec(value);
  if (!match?.[1]) return null;
  const epoch = Number(match[1]);
  return Number.isSafeInteger(epoch) ? epoch : null;
}

function validateOptions(options: PostgresPendingObjectReconciliationOptions): {
  schema: string;
  nowEpoch: number;
  safetyWindowMilliseconds: number;
  maximumRegistrations: number;
} {
  const nowEpoch = options.nowEpoch ?? Date.now();
  const safetyWindowMilliseconds = options.safetyWindowMilliseconds
    ?? DEFAULT_POSTGRES_PENDING_OBJECT_SAFETY_WINDOW_MILLISECONDS;
  const maximumRegistrations = options.maximumRegistrations ?? 50;
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0 || nowEpoch > 9_999_999_999_999
      || !Number.isSafeInteger(safetyWindowMilliseconds)
      || safetyWindowMilliseconds < MINIMUM_POSTGRES_PENDING_OBJECT_SAFETY_WINDOW_MILLISECONDS
      || safetyWindowMilliseconds > MAXIMUM_POSTGRES_PENDING_OBJECT_SAFETY_WINDOW_MILLISECONDS
      || !Number.isSafeInteger(maximumRegistrations) || maximumRegistrations < 1
      || maximumRegistrations > POSTGRES_PENDING_OBJECT_RECONCILIATION_BATCH_LIMIT) {
    return safeInvalidOptions();
  }
  const { primarySchema } = createPostgresSchemaConfig(options.schema ?? {});
  return {
    schema: quotePostgresIdentifier(primarySchema),
    nowEpoch,
    safetyWindowMilliseconds,
    maximumRegistrations,
  };
}

function refsSql(schema: string, keyExpression: string): string {
  return `EXISTS (SELECT 1 FROM ${schema}."telemetry_contributions" WHERE r2_key = ${keyExpression})
    OR EXISTS (SELECT 1 FROM ${schema}."telemetry_v1_chunks" WHERE r2_key = ${keyExpression})
    OR EXISTS (SELECT 1 FROM ${schema}."telemetry_v11_chunks" WHERE r2_key = ${keyExpression})
    OR EXISTS (SELECT 1 FROM ${schema}."telemetry_v12_chunks" WHERE r2_key = ${keyExpression})`;
}

function unheldSql(schema: string, keyExpression: string): string {
  return `NOT EXISTS (SELECT 1 FROM ${schema}."${POSTGRES_PENDING_OBJECT_TRANSFER_HOLD_TABLE}" hold
    WHERE hold.object_key = ${keyExpression} AND hold.released_at IS NULL)`;
}

/** Whether this schema carries the transfer-hold table (read once per pass). */
async function transferHoldsPresent(pool: PostgresPool, schema: string): Promise<boolean> {
  const result = await withPostgresRead(pool, async (client) => client.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${schema}."${POSTGRES_PENDING_OBJECT_TRANSFER_HOLD_TABLE}"`],
  ), { operation: "quarantine.reconcile.holds" });
  const present = result.rows[0]?.present;
  if (typeof present !== "boolean") {
    throw new PostgresStorageError("unavailable", "quarantine.reconcile.holds");
  }
  return present;
}

async function isTransferHeld(
  client: PostgresClient,
  schema: string,
  objectKey: string,
): Promise<boolean> {
  const result = await client.query<{ unheld: boolean }>(
    `SELECT ${unheldSql(schema, "$1")} AS unheld WHERE $1::text IS NOT NULL`,
    [objectKey],
  );
  const value: unknown = result.rows[0]?.unheld;
  if (typeof value !== "boolean") {
    throw new PostgresStorageError("unavailable", "quarantine.reconcile.holds");
  }
  return !value;
}

function referenceSelect(schema: string): string {
  return `SELECT (${refsSql(schema, "$1")}) AS referenced`;
}

async function isReferenced(
  client: PostgresClient,
  schema: string,
  objectKey: string,
): Promise<boolean> {
  const result = await client.query<{ referenced: boolean }>(
    `${referenceSelect(schema)} WHERE $1::text IS NOT NULL`,
    [objectKey],
  );
  const value = result.rows[0]?.referenced;
  if (typeof value !== "boolean") {
    throw new PostgresStorageError("unavailable", "quarantine.reconcile.reference");
  }
  return value;
}

function staleLeaseSql(alias: string): string {
  // CASE guarantees malformed/legacy UUIDv4 lease text is never cast. Such a
  // row is adopted for a fresh grace period in application code instead.
  return `CASE WHEN ${alias}.reconciliation_lease_id ~ '${LEASE_SQL_PATTERN}'
    THEN substring(${alias}.reconciliation_lease_id FROM 6 FOR 13)::bigint <= $2::bigint
    ELSE false END`;
}

async function dueRows(
  pool: PostgresPool,
  schema: string,
  nowEpoch: number,
  safetyWindowMilliseconds: number,
  maximumRegistrations: number,
  holds: boolean,
): Promise<{ rows: PendingObjectRow[]; hasMore: boolean }> {
  const registeredCutoff = new Date(nowEpoch - safetyWindowMilliseconds).toISOString();
  const leaseCutoff = nowEpoch - safetyWindowMilliseconds;
  const refs = refsSql(schema, "pending.object_key");
  const unheld = holds ? `AND ${unheldSql(schema, "pending.object_key")}` : "";
  const result = await withPostgresRead(pool, async (client) => client.query<PendingObjectRow>(
    `SELECT pending.contribution_id, pending.object_key, pending.object_kind,
            pending.registered_at, pending.reconciliation_state,
            pending.reconciliation_lease_id, pending.registration_token
       FROM ${schema}."pending_objects" pending
      WHERE pending.registered_at <= $1::timestamptz
        AND (
          pending.reconciliation_state = 'registered'
          OR (pending.reconciliation_state = 'deleting' AND (
            (${refs})
            OR pending.reconciliation_lease_id IS NULL
            OR NOT (pending.reconciliation_lease_id ~ '${LEASE_SQL_PATTERN}')
            OR (${staleLeaseSql("pending")})
          ))
        )
        ${unheld}
      ORDER BY pending.registered_at, pending.contribution_id
      LIMIT $3`,
    [registeredCutoff, leaseCutoff, maximumRegistrations + 1],
  ), { operation: "quarantine.reconcile.scan" });
  const rows = [...result.rows];
  return {
    rows: rows.slice(0, maximumRegistrations),
    hasMore: rows.length > maximumRegistrations,
  };
}

async function claimObject(
  pool: PostgresPool,
  schema: string,
  candidate: PendingObjectRow,
  nowEpoch: number,
  safetyWindowMilliseconds: number,
  holds: boolean,
): Promise<ClaimedObject> {
  return withPostgresMutation(pool, async (client) => {
    const currentResult = await client.query<PendingObjectRow>(
      `SELECT contribution_id, object_key, object_kind, registered_at,
              reconciliation_state, reconciliation_lease_id, registration_token
         FROM ${schema}."pending_objects"
        WHERE contribution_id = $1
        FOR UPDATE`,
      [candidate.contribution_id],
    );
    const current = currentResult.rows[0];
    if (!current || current.object_key !== candidate.object_key
        || current.registration_token !== candidate.registration_token) {
      return { row: candidate, leaseId: "", action: "deferred" };
    }

    const registeredAt = current.registered_at instanceof Date
      ? current.registered_at.getTime() : Date.parse(current.registered_at);
    if (!Number.isFinite(registeredAt) || registeredAt > nowEpoch - safetyWindowMilliseconds) {
      return { row: current, leaseId: "", action: "deferred" };
    }
    // Re-checked under the row lock: a held registration is never claimed.
    if (holds && await isTransferHeld(client, schema, current.object_key)) {
      return { row: current, leaseId: "", action: "deferred" };
    }

    if (await isReferenced(client, schema, current.object_key)) {
      const removed = await client.query(
        `DELETE FROM ${schema}."pending_objects"
          WHERE contribution_id = $1 AND object_key = $2
            AND registration_token = $3 AND reconciliation_state = $4
            AND reconciliation_lease_id IS NOT DISTINCT FROM $5
          RETURNING contribution_id`,
        [current.contribution_id, current.object_key, current.registration_token,
          current.reconciliation_state, current.reconciliation_lease_id],
      );
      if (removed.rows.length !== 1) {
        return { row: current, leaseId: "", action: "deferred" };
      }
      // A journal row is needed only while an object might be orphaned. Once
      // a durable source row references it, remove that exact journal entry
      // while leaving the provider object untouched.
      return { row: current, leaseId: "", action: "referenced" };
    }

    const previousLeaseEpoch = leaseEpoch(current.reconciliation_lease_id);
    const legacyLease = current.reconciliation_state === "deleting"
      && previousLeaseEpoch === null;
    const staleLease = current.reconciliation_state === "deleting"
      && previousLeaseEpoch !== null
      && previousLeaseEpoch <= nowEpoch - safetyWindowMilliseconds;
    if (current.reconciliation_state === "deleting" && !legacyLease && !staleLease) {
      return { row: current, leaseId: "", action: "deferred" };
    }

    const leaseId = createPostgresPendingObjectReconciliationLeaseId(nowEpoch);
    const updated = await client.query(
      `UPDATE ${schema}."pending_objects"
          SET reconciliation_state = 'deleting', reconciliation_lease_id = $4
        WHERE contribution_id = $1 AND object_key = $2
          AND registration_token = $3
          AND reconciliation_state = $5
          AND reconciliation_lease_id IS NOT DISTINCT FROM $6
        RETURNING contribution_id`,
      [current.contribution_id, current.object_key, current.registration_token,
        leaseId, current.reconciliation_state, current.reconciliation_lease_id],
    );
    if (updated.rows.length !== 1) {
      return { row: current, leaseId: "", action: "deferred" };
    }

    if (current.reconciliation_state === "registered" || legacyLease) {
      return { row: current, leaseId, action: "grace_started" };
    }
    return { row: current, leaseId, action: "delete" };
  }, { operation: "quarantine.reconcile.claim" });
}

async function clearDeletedObject(
  pool: PostgresPool,
  schema: string,
  claim: ClaimedObject,
): Promise<void> {
  const result = await withPostgresMutation(pool, async (client) => {
    const rowResult = await client.query<PendingObjectRow>(
      `SELECT contribution_id, object_key, object_kind, registered_at,
              reconciliation_state, reconciliation_lease_id, registration_token
         FROM ${schema}."pending_objects"
        WHERE contribution_id = $1
        FOR UPDATE`,
      [claim.row.contribution_id],
    );
    const row = rowResult.rows[0];
    if (!row) return "already-cleared" as const;
    if (row.object_key !== claim.row.object_key
        || row.registration_token !== claim.row.registration_token
        || row.reconciliation_state !== "deleting"
        || row.reconciliation_lease_id !== claim.leaseId) {
      throw new PostgresStorageError("conflict", "quarantine.reconcile.lease", { retryable: true });
    }
    if (await isReferenced(client, schema, row.object_key)) {
      // The INSERT triggers serialize v1/v1.1/v1.2 writers with this journal
      // row. Reaching this branch means the DB contract changed or a source
      // path bypassed the guard; preserve the registration and fail closed.
      throw new PostgresStorageError("conflict", "quarantine.reconcile.reference", { retryable: true });
    }
    const removed = await client.query(
      `DELETE FROM ${schema}."pending_objects"
        WHERE contribution_id = $1 AND object_key = $2
          AND registration_token = $3 AND reconciliation_state = 'deleting'
          AND reconciliation_lease_id = $4
        RETURNING contribution_id`,
      [row.contribution_id, row.object_key, row.registration_token, claim.leaseId],
    );
    if (removed.rows.length !== 1) {
      throw new PostgresStorageError("conflict", "quarantine.reconcile.clear", { retryable: true });
    }
    return "cleared" as const;
  }, { operation: "quarantine.reconcile.clear" });
  if (result !== "cleared" && result !== "already-cleared") {
    throw new PostgresStorageError("conflict", "quarantine.reconcile.clear", { retryable: true });
  }
}

function validHead(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || value === null) return false;
  const version = Reflect.get(value, "version");
  const size = Reflect.get(value, "size");
  return typeof version === "string" && version.length > 0
    && Number.isSafeInteger(size) && Number(size) >= 0;
}

/**
 * Reconcile at most `maximumRegistrations` due objects.
 *
 * The two-pass lease is intentional. The first pass puts an aged, unreferenced
 * registration behind the PostgreSQL chunk-insert fence and records the time
 * in an opaque lease token, but performs no GCS call. Only after another full
 * safety window may a later pass inspect/delete the object. This covers a PUT
 * that started just before the first claim and completed after it: the second
 * pass observes the resulting object. The one-hour minimum exceeds the GCS
 * adapter's 300-second request deadline; raise it if a host can keep a PUT
 * operation or request alive longer. PostgreSQL triggers prevent a chunk from
 * being inserted after the deleting claim. An unbounded provider-side PUT
 * completion would need provider-specific operation identity to be proven
 * safe and is outside this adapter's contract.
 *
 * The Cloud Run scheduled path opts into this function only when its explicit
 * maintenance enable flag is set. The Cloudflare scheduled handler does not
 * call it, and tests use only a synthetic object store.
 */
export async function reconcilePostgresPendingObjects(
  pool: PostgresPool,
  objectStore: Pick<QuarantineObjectStore, "head" | "delete">,
  options: PostgresPendingObjectReconciliationOptions = {},
): Promise<PostgresPendingObjectReconciliationResult> {
  if (objectStore === null || typeof objectStore !== "object"
      || typeof objectStore.head !== "function" || typeof objectStore.delete !== "function") {
    return safeInvalidOptions();
  }
  const config = validateOptions(options);
  const holds = await transferHoldsPresent(pool, config.schema);
  const page = await dueRows(
    pool,
    config.schema,
    config.nowEpoch,
    config.safetyWindowMilliseconds,
    config.maximumRegistrations,
    holds,
  );
  let orphanObjectsDeleted = 0;
  let orphanObjectsAlreadyAbsent = 0;
  let deletionGraceStarted = 0;
  let legacyLeasesAdopted = 0;
  let referencedObjectsPreserved = 0;
  let candidatesDeferred = 0;

  for (const candidate of page.rows) {
    assertQuarantineObjectKey(candidate.object_key);
    const claim = await claimObject(
      pool, config.schema, candidate, config.nowEpoch, config.safetyWindowMilliseconds, holds,
    );
    if (claim.action === "deferred") {
      candidatesDeferred += 1;
      continue;
    }
    if (claim.action === "referenced") {
      referencedObjectsPreserved += 1;
      continue;
    }
    if (claim.action === "grace_started") {
      deletionGraceStarted += 1;
      if (candidate.reconciliation_state === "deleting") legacyLeasesAdopted += 1;
      continue;
    }

    let head: Awaited<ReturnType<QuarantineObjectStore["head"]>>;
    try {
      head = await objectStore.head(candidate.object_key);
    } catch {
      throw new QuarantineObjectStorageUnavailableError();
    }
    if (!validHead(head)) throw new QuarantineObjectStorageUnavailableError();
    if (head !== null) {
      try {
        await objectStore.delete(candidate.object_key);
      } catch {
        // Keep the exact deleting lease. A later pass waits a full safety
        // window, then checks the provider again before clearing the row.
        throw new QuarantineObjectStorageUnavailableError();
      }
      orphanObjectsDeleted += 1;
    } else {
      orphanObjectsAlreadyAbsent += 1;
    }
    await clearDeletedObject(pool, config.schema, claim);
  }

  return Object.freeze({
    registrationsExamined: page.rows.length,
    deletionGraceStarted,
    legacyLeasesAdopted,
    orphanObjectsDeleted,
    orphanObjectsAlreadyAbsent,
    referencedObjectsPreserved,
    candidatesDeferred,
    hasMore: page.hasMore,
  });
}

export interface PostgresPendingObjectTransferHoldRelease {
  readonly schema?: PostgresSchemaOptions;
  /** The objects PT-7 copied to GCS or proved absent from R2. */
  readonly objectKeys: readonly string[];
  /** sha256 of PT-7's owner-directory receipt covering these objects. */
  readonly releaseReceiptSha256: string;
}

export interface PostgresPendingObjectTransferHoldReleaseResult {
  /** Holds released by this call. */
  readonly released: number;
  /** Keys whose hold was already released (a retry); never re-released. */
  readonly alreadyReleased: number;
  /** Keys with no hold at all. */
  readonly unknown: number;
}

/**
 * Release the E-PT4 transfer holds for objects PT-7 has copied to GCS or
 * proved absent from R2 (post-switch, owner-run). One-way and idempotent: a
 * released hold keeps its first receipt digest, and the table's guard refuses
 * any other change. Counts only; no key leaves this function.
 */
export async function releasePostgresPendingObjectTransferHolds(
  pool: PostgresPool,
  release: PostgresPendingObjectTransferHoldRelease,
): Promise<PostgresPendingObjectTransferHoldReleaseResult> {
  if (release === null || typeof release !== "object"
      || !Array.isArray(release.objectKeys)
      || release.objectKeys.length === 0
      || release.objectKeys.length > POSTGRES_PENDING_OBJECT_TRANSFER_HOLD_RELEASE_LIMIT
      || new Set(release.objectKeys).size !== release.objectKeys.length
      || typeof release.releaseReceiptSha256 !== "string"
      || !SHA256_PATTERN.test(release.releaseReceiptSha256)) {
    return safeInvalidOptions();
  }
  for (const key of release.objectKeys) assertQuarantineObjectKey(key);
  const { primarySchema } = createPostgresSchemaConfig(release.schema ?? {});
  const schema = quotePostgresIdentifier(primarySchema);
  const keys = [...release.objectKeys];
  return withPostgresMutation(pool, async (client) => {
    const updated = await client.query<{ object_key: string }>(
      `UPDATE ${schema}."${POSTGRES_PENDING_OBJECT_TRANSFER_HOLD_TABLE}"
          SET released_at = clock_timestamp(), release_receipt_sha256 = $2
        WHERE object_key = ANY($1::text[]) AND released_at IS NULL
        RETURNING object_key`,
      [keys, release.releaseReceiptSha256],
    );
    const known = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${schema}."${POSTGRES_PENDING_OBJECT_TRANSFER_HOLD_TABLE}"
        WHERE object_key = ANY($1::text[])`,
      [keys],
    );
    const present = Number(known.rows[0]?.n);
    if (!Number.isSafeInteger(present) || present < updated.rows.length) {
      throw new PostgresStorageError("unavailable", "quarantine.reconcile.holds");
    }
    return Object.freeze({
      released: updated.rows.length,
      alreadyReleased: present - updated.rows.length,
      unknown: keys.length - present,
    });
  }, { operation: "quarantine.reconcile.holds.release" });
}
