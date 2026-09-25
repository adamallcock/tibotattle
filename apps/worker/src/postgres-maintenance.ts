/**
 * Bounded Cloud Run maintenance operations backed by the operational
 * PostgreSQL schemas. This currently covers expiring identity handoffs and
 * the two-pass orphan-object journal. Owner restore replay and age-based
 * telemetry retention remain explicit incomplete gates; this module must not
 * report a full lifecycle pass while either is absent.
 */
import {
  createPostgresSchemaConfig,
  PostgresStorageError,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import {
  purgePostgresStaleDeviceLifecycleRows,
  type PostgresDeviceLifecycleReceipt,
} from "./postgres-device-lifecycle";
import {
  reconcilePostgresPendingObjects,
  DEFAULT_POSTGRES_PENDING_OBJECT_SAFETY_WINDOW_MILLISECONDS,
  type PostgresPendingObjectReconciliationResult,
} from "./postgres-quarantine-reconciliation";
import type { QuarantineObjectStore } from "./quarantine-object-store";

export const POSTGRES_SCHEDULED_MAINTENANCE_LOCK_DOMAIN =
  "tibotattle/postgres-scheduled-maintenance/v1" as const;
export const POSTGRES_MAINTENANCE_IDENTITY_PAGE_SIZE = 100;
export const POSTGRES_MAINTENANCE_SIGNIN_ADMISSION_PAGE_SIZE = 1_000;
export const POSTGRES_MAINTENANCE_OBJECT_PAGE_SIZE = 5;
export const POSTGRES_SIGNIN_ADMISSION_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;

type PurgeSpec = Readonly<{
  readonly table: string;
  readonly column: string;
  readonly key: string;
  readonly comparison: "<" | "<=";
  readonly batchSize: number;
  readonly operation: string;
}>;

const IDENTITY_PURGES: readonly PurgeSpec[] = Object.freeze([
  { table: "apple_signin_handoffs", column: "expires_at", key: "state", comparison: "<=", batchSize: 100, operation: "maintenance.purge.apple_handoffs" },
  { table: "google_signin_handoffs", column: "expires_at", key: "state", comparison: "<=", batchSize: 100, operation: "maintenance.purge.google_handoffs" },
  { table: "identity_reenrollment_cooldowns", column: "expires_at", key: "identity_cooldown_digest", comparison: "<=", batchSize: 100, operation: "maintenance.purge.primary_cooldowns" },
  { table: "sign_in_start_admission_windows", column: "window_started_at", key: "window_started_at", comparison: "<", batchSize: 1_000, operation: "maintenance.purge.signin_admission_windows" },
]);

const LEDGER_PURGES: readonly PurgeSpec[] = Object.freeze([
  { table: "identity_reenrollment_cooldowns", column: "retain_until", key: "identity_cooldown_digest", comparison: "<=", batchSize: 100, operation: "maintenance.purge.ledger_cooldowns" },
]);

export interface PostgresScheduledMaintenanceOptions {
  readonly primaryPool: PostgresPool;
  readonly ledgerPool: PostgresPool;
  readonly objectStore: Pick<QuarantineObjectStore, "head" | "delete">;
  readonly schema?: PostgresSchemaOptions;
  readonly nowEpoch?: number;
}

export interface PostgresIdentityPurgeReceipt {
  readonly purged: number;
  readonly complete: boolean;
}

export interface PostgresScheduledMaintenanceResult {
  readonly outcome: "partial" | "skipped" | "failure";
  readonly code: string;
  readonly complete: false;
  readonly leaseAcquired: boolean;
  readonly identityPurge: Readonly<{
    readonly primary: PostgresIdentityPurgeReceipt;
    readonly ledger: PostgresIdentityPurgeReceipt;
    readonly complete: boolean;
  }>;
  readonly objectReconciliation: PostgresPendingObjectReconciliationResult | null;
  readonly objectReconciliationComplete: boolean;
  readonly deviceLifecycle: PostgresDeviceLifecycleReceipt;
  readonly deviceLifecycleComplete: boolean;
  readonly ownerErasureJobsComplete: false;
  readonly restoreReplayComplete: false;
  readonly telemetryRetentionComplete: false;
  readonly deletionTombstoneRetentionComplete: false;
  readonly analyticsMaintenanceComplete: false;
}

interface PurgeCountRow { readonly deleted: number | string; }
interface ExistsRow { readonly pending: boolean; }
interface LockRow { readonly acquired: boolean; }
interface UnlockRow { readonly released: boolean; }

function invalidOptions(): never {
  throw new PostgresStorageError("invalid", "maintenance.options");
}

function safeSchema(options: PostgresSchemaOptions | undefined): {
  readonly primary: string;
  readonly ledger: string;
} {
  const configured = createPostgresSchemaConfig(options ?? {});
  return Object.freeze({
    primary: quotePostgresIdentifier(configured.primarySchema),
    ledger: quotePostgresIdentifier(configured.ledgerSchema),
  });
}

function validateNow(nowEpoch: unknown): number {
  if (!Number.isSafeInteger(nowEpoch) || Number(nowEpoch) < 0
      || Number(nowEpoch) > 9_999_999_999_999) return invalidOptions();
  return Number(nowEpoch);
}

function purgeTable(schema: string, spec: PurgeSpec): string {
  // Every identifier comes from the closed local specifications above.
  return `${schema}."${spec.table}"`;
}

function parseDeleted(rows: readonly PurgeCountRow[], maximum: number): number {
  if (!Array.isArray(rows) || rows.length > maximum) {
    throw new PostgresStorageError("unavailable", "maintenance.purge.result");
  }
  const count = rows.length === 1 ? Number(rows[0]?.deleted) : rows.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > maximum) {
    throw new PostgresStorageError("unavailable", "maintenance.purge.result");
  }
  return count;
}

async function purgePage(
  pool: PostgresPool,
  schema: string,
  spec: PurgeSpec,
  cutoff: string,
): Promise<PostgresIdentityPurgeReceipt> {
  const target = purgeTable(schema, spec);
  const deletedRows = await withPostgresMutation(pool, async (client) => {
    const result = await client.query<PurgeCountRow>(
      `WITH candidates AS (
         SELECT ${spec.key}
           FROM ${target}
          WHERE ${spec.column} ${spec.comparison} $1::timestamptz
          ORDER BY ${spec.column}, ${spec.key}
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM ${target} AS expired
        USING candidates
        WHERE expired.${spec.key} = candidates.${spec.key}
       RETURNING 1 AS deleted`,
      [cutoff, spec.batchSize],
    );
    return result.rows;
  }, { operation: spec.operation });
  const purged = parseDeleted(deletedRows, spec.batchSize);
  if (purged < spec.batchSize) return Object.freeze({ purged, complete: true });

  const remaining = await withPostgresRead(pool, async (client) => {
    const result = await client.query<ExistsRow>(
      `SELECT EXISTS (
         SELECT 1 FROM ${target}
          WHERE ${spec.column} ${spec.comparison} $1::timestamptz
       ) AS pending`,
      [cutoff],
    );
    const pending = result.rows[0]?.pending;
    if (typeof pending !== "boolean") {
      throw new PostgresStorageError("unavailable", "maintenance.purge.readback");
    }
    return pending;
  }, { operation: `${spec.operation}.readback` });
  return Object.freeze({ purged, complete: !remaining });
}

async function purgeSpecs(
  pool: PostgresPool,
  schema: string,
  specs: readonly PurgeSpec[],
  cutoff: string,
): Promise<PostgresIdentityPurgeReceipt> {
  let purged = 0;
  let complete = true;
  for (const spec of specs) {
    const receipt = await purgePage(pool, schema, spec, cutoff);
    purged += receipt.purged;
    complete &&= receipt.complete;
  }
  return Object.freeze({ purged, complete });
}

async function withSessionLock<T>(
  pool: PostgresPool,
  operation: () => Promise<T>,
): Promise<{ readonly acquired: false } | { readonly acquired: true; readonly value: T }> {
  let client: Awaited<ReturnType<PostgresPool["connect"]>>;
  try {
    client = await pool.connect();
  } catch {
    throw new PostgresStorageError("unavailable", "maintenance.lock.connect");
  }
  let acquired = false;
  let discard = false;
  let acquisitionAcknowledged = false;
  try {
    const result = await client.query<LockRow>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [POSTGRES_SCHEDULED_MAINTENANCE_LOCK_DOMAIN],
    );
    acquisitionAcknowledged = true;
    const value = result.rows[0]?.acquired;
    if (typeof value !== "boolean") {
      discard = true;
      throw new PostgresStorageError("unavailable", "maintenance.lock.acquire");
    }
    if (!value) return Object.freeze({ acquired: false });
    acquired = true;
    return Object.freeze({ acquired: true, value: await operation() });
  } catch (error) {
    if (!acquisitionAcknowledged) discard = true;
    if (error instanceof PostgresStorageError
        || (error instanceof Error && error.name === "QuarantineObjectStorageUnavailableError")) {
      throw error;
    }
    throw new PostgresStorageError("unavailable", "maintenance.run");
  } finally {
    if (acquired) {
      try {
        const result = await client.query<UnlockRow>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
          [POSTGRES_SCHEDULED_MAINTENANCE_LOCK_DOMAIN],
        );
        if (result.rows[0]?.released !== true) discard = true;
      } catch {
        // Discarding the session releases a session-level lock even if the
        // explicit unlock acknowledgement is lost.
        discard = true;
      }
    }
    try { await client.release(discard); } catch {
      // Returning a broken locked connection to the pool would strand the lock.
      try { await client.release(true); } catch { /* connection loss releases it */ }
    }
  }
}

function baseResult(
  outcome: PostgresScheduledMaintenanceResult["outcome"],
  code: string,
  leaseAcquired: boolean,
  primary: PostgresIdentityPurgeReceipt = Object.freeze({ purged: 0, complete: false }),
  ledger: PostgresIdentityPurgeReceipt = Object.freeze({ purged: 0, complete: false }),
  objectReconciliation: PostgresPendingObjectReconciliationResult | null = null,
  objectReconciliationComplete = false,
  deviceLifecycle: PostgresDeviceLifecycleReceipt = Object.freeze({
    pairingsRevoked: 0,
    devicesRevoked: 0,
    uploadsRevoked: 0,
    rotationsPurged: 0,
    pairingEventsPurged: 0,
    complete: false,
  }),
): PostgresScheduledMaintenanceResult {
  return Object.freeze({
    outcome,
    code,
    complete: false,
    leaseAcquired,
    identityPurge: Object.freeze({ primary, ledger, complete: primary.complete && ledger.complete }),
    objectReconciliation,
    objectReconciliationComplete,
    deviceLifecycle,
    deviceLifecycleComplete: deviceLifecycle.complete,
    ownerErasureJobsComplete: false,
    restoreReplayComplete: false,
    telemetryRetentionComplete: false,
    deletionTombstoneRetentionComplete: false,
    analyticsMaintenanceComplete: false,
  });
}

/**
 * Runs one bounded PostgreSQL maintenance slice under a connection-scoped
 * advisory lock. The lock cannot expire while a worker is still executing;
 * terminating the Cloud Run process drops the database session and releases it.
 */
export async function runPostgresScheduledMaintenance(
  options: PostgresScheduledMaintenanceOptions,
): Promise<PostgresScheduledMaintenanceResult> {
  if (!options || typeof options !== "object"
      || !options.primaryPool || typeof options.primaryPool.connect !== "function"
      || !options.ledgerPool || typeof options.ledgerPool.connect !== "function"
      || !options.objectStore || typeof options.objectStore.head !== "function"
      || typeof options.objectStore.delete !== "function") return invalidOptions();
  const schema = safeSchema(options.schema);
  const nowEpoch = validateNow(options.nowEpoch ?? Date.now());
  const cutoff = new Date(nowEpoch).toISOString();
  let leaseAcquired = false;
  let primary: PostgresIdentityPurgeReceipt = Object.freeze({ purged: 0, complete: false });
  let ledger: PostgresIdentityPurgeReceipt = Object.freeze({ purged: 0, complete: false });
  let objectReconciliation: PostgresPendingObjectReconciliationResult | null = null;
  let deviceLifecycle: PostgresDeviceLifecycleReceipt = Object.freeze({
    pairingsRevoked: 0,
    devicesRevoked: 0,
    uploadsRevoked: 0,
    rotationsPurged: 0,
    pairingEventsPurged: 0,
    complete: false,
  });
  try {
    const locked = await withSessionLock(options.primaryPool, async () => {
      leaseAcquired = true;
      const primaryHandoffs = await purgeSpecs(
        options.primaryPool,
        schema.primary,
        IDENTITY_PURGES.slice(0, 3),
        cutoff,
      );
      const admission = await purgePage(
        options.primaryPool,
        schema.primary,
        IDENTITY_PURGES[3]!,
        new Date(nowEpoch - POSTGRES_SIGNIN_ADMISSION_RETENTION_MILLISECONDS).toISOString(),
      );
      primary = Object.freeze({
        purged: primaryHandoffs.purged + admission.purged,
        complete: primaryHandoffs.complete && admission.complete,
      });
      ledger = await purgeSpecs(options.ledgerPool, schema.ledger, LEDGER_PURGES, cutoff);
      deviceLifecycle = await purgePostgresStaleDeviceLifecycleRows(options.primaryPool, {
        schema: options.schema,
        nowEpoch,
      });
      objectReconciliation = await reconcilePostgresPendingObjects(
        options.primaryPool,
        options.objectStore,
        {
          schema: options.schema,
          nowEpoch,
          safetyWindowMilliseconds: DEFAULT_POSTGRES_PENDING_OBJECT_SAFETY_WINDOW_MILLISECONDS,
          maximumRegistrations: POSTGRES_MAINTENANCE_OBJECT_PAGE_SIZE,
        },
      );
      return Object.freeze({ primary, ledger, deviceLifecycle, objectReconciliation });
    });
    if (!locked.acquired) {
      return baseResult("skipped", "MAINTENANCE_IN_PROGRESS", false);
    }
    const {
      primary: completedPrimary,
      ledger: completedLedger,
      deviceLifecycle: completedDeviceLifecycle,
      objectReconciliation: completedObjects,
    } = locked.value;
    const reconciliationComplete = !completedObjects.hasMore
      && completedObjects.candidatesDeferred === 0;
    const identityComplete = completedPrimary.complete && completedLedger.complete;
    const code = !identityComplete || !reconciliationComplete || !completedDeviceLifecycle.complete
      ? "POSTGRES_MAINTENANCE_BACKLOG"
      : "POSTGRES_MAINTENANCE_INCOMPLETE_UNSUPPORTED_PHASES";
    return baseResult("partial", code, true, completedPrimary, completedLedger,
      completedObjects, reconciliationComplete, completedDeviceLifecycle);
  } catch (error) {
    const code = error instanceof PostgresStorageError
      ? "POSTGRES_MAINTENANCE_UNAVAILABLE"
      : error instanceof Error && error.name === "QuarantineObjectStorageUnavailableError"
        ? "QUARANTINE_OBJECT_STORAGE_UNAVAILABLE"
        : "POSTGRES_MAINTENANCE_UNAVAILABLE";
    return baseResult("failure", code, leaseAcquired, primary, ledger, objectReconciliation, false,
      deviceLifecycle);
  }
}
