/**
 * MP-2-lite: the PostgreSQL lifecycle and quarantine-reconciliation pass.
 *
 * It writes exactly the two singleton rows GET /api/ready reads
 * (retention_state and quarantine_reconciliation_state, primary 0049), with
 * the d43c8f92 Worker's values, so the GCP readiness body is Worker-exact
 * (owner decision OD-CR-4). An origin whose rows were never written by a pass
 * reads not_ready; after one complete pass it reads ready.
 *
 * Worker parity (src/retention.ts runBackendLifecycle and
 * src/quarantine-reconciliation.ts reconcilePendingQuarantineObjects, called
 * in that order by the scheduled handler with the cron scheduledTime):
 *   - lifecycle: QUARANTINE_RETENTION_MILLISECONDS is null in every shipped
 *     configuration, so the quarantine retention phase deletes nothing and is
 *     complete with a null cutoff. Completion stamps last_started_at and
 *     maintenance_run_at with the cycle instant and last_completed_at with the
 *     clock;
 *   - restore replay does not exist under the append-only decisions (D1, D2,
 *     D4 and D6 of 2026-09-26). retention_state.restore_replay_complete and
 *     restored_participants_suppressed are pinned (primary 0064 section 4) and
 *     this pass never writes them: it requires true and 0 and refuses
 *     otherwise. OD-4 reports the erasure items as constant true, marked not
 *     applicable (POSTGRES_APPEND_ONLY_NOT_APPLICABLE);
 *   - reconciliation: one page of the existing two-pass PostgreSQL reconciler
 *     (src/postgres-quarantine-reconciliation.ts) under a running/lease row,
 *     then completed with cumulative counters while a backlog is resumed,
 *     exactly as the Worker resumes its cursor. The page is the Worker's
 *     batch, 100 registrations (QUARANTINE_RECONCILIATION_BATCH_SIZE, one
 *     batch per one-minute cron), so a backlog of up to 100 due registrations
 *     completes in one pass, as it does on the Worker. The page is complete
 *     when nothing due remains beyond it and no candidate was deferred.
 *     Throughput parity needs the trigger to run every minute, like the
 *     Worker cron;
 *   - purges (MAINT-PURGE): the identity and device-lifecycle purges of the
 *     scheduled slice (src/postgres-maintenance.ts), which the Worker's
 *     scheduled handler runs every invocation: one bounded page each of
 *     expired Apple and Google sign-in handoffs, aged sign-in admission
 *     windows (purgePostgresExpiredIdentityRows), then stale device pairings,
 *     credentials and upload authorizations and expired rotation and
 *     pairing-event history (purgePostgresStaleDeviceLifecycleRows). The
 *     cutoff is the completion clock, not the cycle, as the Worker purges
 *     handoffs at its actual run time. They run after the lifecycle write
 *     (so after the receipt, the 0064 pins and the cycle order are proved
 *     under the fence) and before the reconciliation lease, so a purge
 *     failure leaves readiness not_ready on the unmatched cycle, as a Worker
 *     whose required identity phase fails. A cycle already complete in both
 *     rows ran them with its first complete pass and skips them. A purge
 *     backlog beyond one page leaves readiness alone and reports partial,
 *     MAINTENANCE_PURGE_BACKLOG; later cycles drain it. Each page deletes or
 *     revokes only rows past its cutoff and skips rows another transaction
 *     holds, so a replay changes nothing twice.
 *
 * Safety:
 *   - one session-level advisory lock, shared with the scheduled maintenance
 *     slice (POSTGRES_SCHEDULED_MAINTENANCE_LOCK_DOMAIN); a held lock skips the
 *     pass with no write. Holding it is what makes taking over a 'running'
 *     reconciliation row left by a killed pass safe;
 *   - a migration fence: on the same session the pass holds, in shared mode,
 *     the lock the primary migration runner takes exclusively for a whole
 *     migration run (cloud-run/postgres-migrations.mjs,
 *     'tibotattle:primary:<schema>'). While a migration runs the pass is
 *     skipped with no write; while a pass runs the runner refuses
 *     POSTGRES_MIGRATION_CONFLICT. So the reviewed runner never commits a
 *     migration in the middle of a pass, including the purge pages and the
 *     reconciler's own per-object transactions and object-store calls;
 *   - every transaction this module opens (the lifecycle write, the lease,
 *     the completion and the failure record) first proves the primary
 *     migration receipt equals the caller's expected manifest. The
 *     reconciler's per-object transactions and the purge pages do not
 *     re-check it; the fence covers them. A schema change made outside the runner is caught at the
 *     pass's next own transaction, after the page in flight;
 *   - idempotent per cycle: a pass whose cycle is already complete in both
 *     rows writes nothing. A cycle older than either stored marker is refused;
 *   - refusals: one raised inside the lifecycle transaction (receipt, pins,
 *     lease pair, regression, shape, or a CHECK violation, SQLSTATE 23514, on
 *     the lifecycle write) rolls back and leaves both rows unchanged. One
 *     raised while the reconciliation lease is taken, a separate transaction,
 *     leaves the lifecycle row on the new cycle (already committed) and the
 *     reconciliation row unchanged, so readiness reads not_ready on the
 *     unmatched cycle, as the Worker does when its reconciliation cannot
 *     start after runBackendLifecycle committed. A retry of the same cycle
 *     takes the lease only. After the lease is taken a failure is recorded
 *     as failed, unless the receipt no longer matches, in which case the row
 *     stays running and the next pass takes it over.
 *
 * Every result, error and code is content-free: counts, booleans, instants
 * and closed codes only.
 */
import { QUARANTINE_RETENTION_MILLISECONDS } from "./constants";
import {
  createPostgresSchemaConfig,
  PostgresStorageError,
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import {
  readPostgresQuarantineReconciliationState,
  readPostgresRetentionState,
  StateShapeError,
  type PostgresQuarantineReconciliationState,
  type PostgresRetentionState,
} from "./postgres-lifecycle-state";
import {
  purgePostgresStaleDeviceLifecycleRows,
  type PostgresDeviceLifecycleReceipt,
} from "./postgres-device-lifecycle";
import {
  POSTGRES_SCHEDULED_MAINTENANCE_LOCK_DOMAIN,
  purgePostgresExpiredIdentityRows,
  type PostgresIdentityPurgeReceipt,
} from "./postgres-maintenance";
import {
  DEFAULT_POSTGRES_PENDING_OBJECT_SAFETY_WINDOW_MILLISECONDS,
  POSTGRES_PENDING_OBJECT_RECONCILIATION_BATCH_LIMIT,
  reconcilePostgresPendingObjects,
  type PostgresPendingObjectReconciliationResult,
} from "./postgres-quarantine-reconciliation";
import type { PostgresRuntimeMigrationReceipt } from "./postgres-runtime-schema";
import { POSTGRES_SCHEMA_RECEIPT_MAJOR, readSchemaReceipt } from "./postgres-schema-receipt";
import type { QuarantineObjectStore } from "./quarantine-object-store";

export const POSTGRES_LIFECYCLE_PASS_RECEIPT_VERSION = "postgres-lifecycle-pass-v1" as const;
/**
 * Registrations one pass reconciles: the d43c8f92 Worker's
 * QUARANTINE_RECONCILIATION_BATCH_SIZE (100, one batch per one-minute cron),
 * which is also the PostgreSQL reconciler's own upper bound.
 */
export const POSTGRES_LIFECYCLE_PASS_RECONCILIATION_PAGE_SIZE = POSTGRES_PENDING_OBJECT_RECONCILIATION_BATCH_LIMIT;
/** The reconciler's two-pass safety window; the recorded cutoff is cycle minus this. */
export const POSTGRES_LIFECYCLE_PASS_SAFETY_WINDOW_MILLISECONDS =
  DEFAULT_POSTGRES_PENDING_OBJECT_SAFETY_WINDOW_MILLISECONDS;
export const POSTGRES_LIFECYCLE_PASS_LOCK_DOMAIN = POSTGRES_SCHEDULED_MAINTENANCE_LOCK_DOMAIN;
/**
 * The primary migration runner's lock key prefix (cloud-run/postgres-migrations.mjs
 * takes `tibotattle:${role}:${schema}` exclusively for a whole run). The pass
 * holds `${prefix}${primarySchema}` in shared mode as its migration fence.
 */
export const POSTGRES_LIFECYCLE_PASS_MIGRATION_LOCK_PREFIX = "tibotattle:primary:";
export const POSTGRES_LIFECYCLE_PASS_POSTGRES_MAJOR = POSTGRES_SCHEMA_RECEIPT_MAJOR;

/**
 * OD-4 (owner decision 2026-10-02): under append-only there is no restore
 * replay, deletion-tombstone retention or online owner-erasure job, so
 * maintenance reports these as constant true, marked not applicable by the
 * key that holds them. They are never measured and never false.
 */
export const POSTGRES_APPEND_ONLY_NOT_APPLICABLE = Object.freeze({
  restoreReplayComplete: true,
  deletionTombstoneRetentionComplete: true,
  ownerErasureJobsComplete: true,
} as const);

export const POSTGRES_LIFECYCLE_PASS_OUTCOMES = Object.freeze([
  "complete",
  "partial",
  "skipped",
  "refused",
  "failure",
] as const);

/** The closed result codes, by outcome. */
export const POSTGRES_LIFECYCLE_PASS_CODES = Object.freeze({
  complete: Object.freeze(["LIFECYCLE_PASS_COMPLETE", "LIFECYCLE_CYCLE_ALREADY_COMPLETE"] as const),
  partial: Object.freeze(["QUARANTINE_RECONCILIATION_BACKLOG", "MAINTENANCE_PURGE_BACKLOG"] as const),
  skipped: Object.freeze(["MAINTENANCE_IN_PROGRESS", "MIGRATION_IN_PROGRESS"] as const),
  refused: Object.freeze([
    "POSTGRES_VERSION_UNSUPPORTED",
    "POSTGRES_SCHEMA_RECEIPT_MISMATCH",
    "LIFECYCLE_STATE_MISSING",
    "LIFECYCLE_STATE_SHAPE_INVALID",
    "LIFECYCLE_RESTORE_PIN_CONFLICT",
    "LIFECYCLE_LEASE_CONFLICT",
    "LIFECYCLE_CYCLE_REGRESSED",
    "LIFECYCLE_STATE_CHECK_CONFLICT",
    "LIFECYCLE_QUARANTINE_RETENTION_UNPORTED",
  ] as const),
  failure: Object.freeze([
    "POSTGRES_MAINTENANCE_UNAVAILABLE",
    "QUARANTINE_OBJECT_STORAGE_UNAVAILABLE",
  ] as const),
});

export type PostgresLifecyclePassOutcome = (typeof POSTGRES_LIFECYCLE_PASS_OUTCOMES)[number];
type RefusalCode = (typeof POSTGRES_LIFECYCLE_PASS_CODES.refused)[number];
type FailureCode = (typeof POSTGRES_LIFECYCLE_PASS_CODES.failure)[number];
type SkippedCode = (typeof POSTGRES_LIFECYCLE_PASS_CODES.skipped)[number];
export type PostgresLifecyclePassCode =
  (typeof POSTGRES_LIFECYCLE_PASS_CODES)[keyof typeof POSTGRES_LIFECYCLE_PASS_CODES][number];

export interface PostgresLifecyclePassOptions {
  /** A pool of at least two connections: the lock session plus one transaction. */
  readonly pool: PostgresPool;
  readonly objectStore: Pick<QuarantineObjectStore, "head" | "delete">;
  readonly schema?: PostgresSchemaOptions;
  /**
   * The maintenance cycle instant in epoch milliseconds: the Worker's cron
   * scheduledTime. Both rows record it as maintenance_run_at.
   */
  readonly cycleEpoch: number;
  /** The image's primary migration manifest (POSTGRES_RUNTIME_MIGRATIONS.primary). */
  readonly expectedPrimaryMigrations: readonly PostgresRuntimeMigrationReceipt[];
  /** Completion clock in epoch milliseconds; defaults to Date.now. */
  readonly clock?: () => number;
}

export interface PostgresLifecyclePassReconciliation {
  readonly registrationsExamined: number;
  readonly deletionGraceStarted: number;
  readonly legacyLeasesAdopted: number;
  readonly orphanObjectsDeleted: number;
  readonly orphanObjectsAlreadyAbsent: number;
  readonly referencedObjectsPreserved: number;
  readonly candidatesDeferred: number;
  readonly hasMore: boolean;
}

/** One run of the folded scheduled purges (MAINT-PURGE): counts and completeness only. */
export interface PostgresLifecyclePassPurges {
  /** Expired Apple and Google handoffs plus aged sign-in admission windows. */
  readonly identity: PostgresIdentityPurgeReceipt;
  readonly deviceLifecycle: PostgresDeviceLifecycleReceipt;
  /** Nothing past any cutoff remains (both readbacks found none). */
  readonly complete: boolean;
}

export interface PostgresLifecyclePassResult {
  readonly schemaVersion: typeof POSTGRES_LIFECYCLE_PASS_RECEIPT_VERSION;
  readonly outcome: PostgresLifecyclePassOutcome;
  readonly code: PostgresLifecyclePassCode;
  /** True when this pass committed a write to either singleton row. */
  readonly changed: boolean;
  readonly cycle: string;
  /** Both the maintenance lock and the shared migration fence were held. */
  readonly lockAcquired: boolean;
  /** retention_state records this cycle as completed (written now or before). */
  readonly lifecycleComplete: boolean;
  readonly lifecycleWritten: boolean;
  /** Worker parity: retention is disabled, so nothing is due and nothing is deleted. */
  readonly quarantineRetentionComplete: boolean;
  readonly quarantineObjectsDeleted: 0;
  readonly reconciliation: PostgresLifecyclePassReconciliation | null;
  readonly quarantineReconciliationComplete: boolean;
  /**
   * The folded purges of this pass (MAINT-PURGE), or null when this pass did
   * not finish them: skipped, refused or failed before or during them, or a
   * cycle already complete. Their pages are committed as they run, so a null
   * after a failure does not mean nothing was purged.
   */
  readonly maintenancePurges: PostgresLifecyclePassPurges | null;
  readonly appendOnlyNotApplicable: typeof POSTGRES_APPEND_ONLY_NOT_APPLICABLE;
}

/** Invalid options, thrown before any connection. The message is the code. */
export class PostgresLifecyclePassOptionsError extends Error {
  readonly code = "POSTGRES_LIFECYCLE_PASS_OPTIONS_INVALID" as const;

  constructor() {
    super("POSTGRES_LIFECYCLE_PASS_OPTIONS_INVALID");
    this.name = "PostgresLifecyclePassOptionsError";
  }
}

class LifecyclePassRefusal extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode) {
    super(code);
    this.name = "LifecyclePassRefusal";
    this.code = code;
  }
}

/** The reconciler's and the lease token's 13-digit epoch bound (year 2286). */
const MAX_EPOCH = 9_999_999_999_999;
const SHA256 = /^[0-9a-f]{64}$/u;
const MIGRATION_NAME = /^[0-9]{4}_[a-z0-9_]{1,120}\.sql$/u;

function invalidOptions(): never {
  throw new PostgresLifecyclePassOptionsError();
}

function validEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_EPOCH;
}

function canonical(epoch: number): string {
  return new Date(epoch).toISOString();
}

function validManifest(value: unknown): value is readonly PostgresRuntimeMigrationReceipt[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((entry: unknown, index) => entry !== null && typeof entry === "object"
    && Reflect.get(entry, "version") === index + 1
    && typeof Reflect.get(entry, "name") === "string"
    && MIGRATION_NAME.test(Reflect.get(entry, "name") as string)
    && typeof Reflect.get(entry, "sha256") === "string"
    && SHA256.test(Reflect.get(entry, "sha256") as string));
}

interface ValidatedOptions {
  readonly pool: PostgresPool;
  readonly objectStore: Pick<QuarantineObjectStore, "head" | "delete">;
  readonly schemaOptions: PostgresSchemaOptions;
  readonly primarySchema: string;
  readonly quotedSchema: string;
  readonly migrationLockKey: string;
  readonly cycleEpoch: number;
  readonly cycle: string;
  readonly expected: readonly PostgresRuntimeMigrationReceipt[];
  readonly clock: () => number;
}

function validateOptions(options: PostgresLifecyclePassOptions): ValidatedOptions {
  if (options === null || typeof options !== "object") return invalidOptions();
  const { pool, objectStore } = options;
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function") {
    return invalidOptions();
  }
  if (objectStore === null || typeof objectStore !== "object"
      || typeof objectStore.head !== "function" || typeof objectStore.delete !== "function") {
    return invalidOptions();
  }
  if (!validEpoch(options.cycleEpoch)) return invalidOptions();
  if (!validManifest(options.expectedPrimaryMigrations)) return invalidOptions();
  const clock = options.clock ?? Date.now;
  if (typeof clock !== "function") return invalidOptions();
  let primarySchema: string;
  try {
    primarySchema = createPostgresSchemaConfig(options.schema ?? {}).primarySchema;
  } catch {
    return invalidOptions();
  }
  return Object.freeze({
    pool,
    objectStore,
    schemaOptions: Object.freeze({ primarySchema }),
    primarySchema,
    quotedSchema: quotePostgresIdentifier(primarySchema),
    migrationLockKey: `${POSTGRES_LIFECYCLE_PASS_MIGRATION_LOCK_PREFIX}${primarySchema}`,
    cycleEpoch: options.cycleEpoch,
    cycle: canonical(options.cycleEpoch),
    expected: Object.freeze([...options.expectedPrimaryMigrations]),
    clock,
  });
}

function nowFrom(clock: () => number): number {
  let value: unknown;
  try {
    value = clock();
  } catch {
    throw new PostgresStorageError("unavailable", "lifecycle_pass.clock");
  }
  if (!validEpoch(value)) throw new PostgresStorageError("unavailable", "lifecycle_pass.clock");
  return value;
}

function sqlState(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  try {
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/** preserveSafeError: closed refusals pass through; a CHECK violation becomes one. */
function safeRefusal(error: unknown): Error | null {
  if (error instanceof LifecyclePassRefusal) return error;
  if (error instanceof StateShapeError) return new LifecyclePassRefusal("LIFECYCLE_STATE_SHAPE_INVALID");
  if (sqlState(error) === "23514") return new LifecyclePassRefusal("LIFECYCLE_STATE_CHECK_CONFLICT");
  return null;
}

function table(config: ValidatedOptions, name: string): string {
  // Names are the closed local constants of this module.
  return `${config.quotedSchema}."${name}"`;
}

/**
 * The receipt gate the origin's storage check applies, read inside this
 * transaction through the one shared reader (src/postgres-schema-receipt.ts;
 * owner decision OWN-19, consolidated by D-CRB): PostgreSQL 17 and a
 * migration history exactly equal to the image's manifest (version, name and
 * checksum, in order). A missing, older, newer or drifted schema refuses.
 */
async function assertReceipt(client: PostgresClient, config: ValidatedOptions): Promise<void> {
  const status = await readSchemaReceipt(client, { schema: config.primarySchema, expected: config.expected });
  if (status === "unsupported_postgres_version") throw new LifecyclePassRefusal("POSTGRES_VERSION_UNSUPPORTED");
  if (status !== "current") throw new LifecyclePassRefusal("POSTGRES_SCHEMA_RECEIPT_MISMATCH");
}

interface LockedRows {
  readonly retention: PostgresRetentionState;
  readonly reconciliation: PostgresQuarantineReconciliationState;
}

/** Lock both singletons, then read them through the shared closed readers. */
async function lockRows(client: PostgresClient, config: ValidatedOptions): Promise<LockedRows> {
  const retentionLock = await client.query<{ lease_free: unknown }>(
    `SELECT lease_id IS NULL AND lease_expires_at IS NULL AS lease_free
       FROM ${table(config, "retention_state")}
      WHERE singleton = 1
      FOR UPDATE`,
  );
  const reconciliationLock = await client.query(
    `SELECT singleton
       FROM ${table(config, "quarantine_reconciliation_state")}
      WHERE singleton = 1
      FOR UPDATE`,
  );
  if (retentionLock.rows.length !== 1 || reconciliationLock.rows.length !== 1) {
    throw new LifecyclePassRefusal("LIFECYCLE_STATE_MISSING");
  }
  const retention = await readPostgresRetentionState(client, config.schemaOptions);
  const reconciliation = await readPostgresQuarantineReconciliationState(client, config.schemaOptions);
  if (retention === null || reconciliation === null) {
    throw new LifecyclePassRefusal("LIFECYCLE_STATE_MISSING");
  }
  // The 0064 pins: nothing on PostgreSQL replays a restore or suppresses a
  // restored participant. A row outside them is refused, never repaired.
  if (retention.restoreReplayComplete !== true || retention.restoredParticipantsSuppressed !== 0) {
    throw new LifecyclePassRefusal("LIFECYCLE_RESTORE_PIN_CONFLICT");
  }
  // No PostgreSQL writer holds the 0049 lease pair; one that is set belongs to
  // something this pass does not know, so it is refused rather than broken.
  if (retentionLock.rows[0]?.lease_free !== true) throw new LifecyclePassRefusal("LIFECYCLE_LEASE_CONFLICT");
  // Canonical ISO millisecond instants order lexically within years 0001-9999.
  for (const marker of [retention.maintenanceRunAtIso, reconciliation.maintenanceRunAtIso]) {
    if (marker !== null && marker > config.cycle) throw new LifecyclePassRefusal("LIFECYCLE_CYCLE_REGRESSED");
  }
  return Object.freeze({ retention, reconciliation });
}

function lifecycleCompleteFor(retention: PostgresRetentionState, cycle: string): boolean {
  return retention.state === "completed"
    && retention.maintenanceRunAtIso === cycle
    && retention.quarantineRetentionComplete
    && retention.failureCode === null;
}

function reconciliationCompleteFor(
  reconciliation: PostgresQuarantineReconciliationState,
  cycle: string,
): boolean {
  return reconciliation.state === "completed"
    && reconciliation.reconciliationComplete
    && reconciliation.maintenanceRunAtIso === cycle
    && reconciliation.failureCode === null;
}

interface LifecyclePhase {
  readonly noop: boolean;
  readonly lifecycleWritten: boolean;
}

async function lifecyclePhase(config: ValidatedOptions): Promise<LifecyclePhase> {
  return withPostgresMutation(config.pool, async (client) => {
    await assertReceipt(client, config);
    const { retention, reconciliation } = await lockRows(client, config);
    const lifecycleDone = lifecycleCompleteFor(retention, config.cycle);
    if (lifecycleDone && reconciliationCompleteFor(reconciliation, config.cycle)) {
      return Object.freeze({ noop: true, lifecycleWritten: false });
    }
    if (lifecycleDone) return Object.freeze({ noop: false, lifecycleWritten: false });
    const completedAt = canonical(nowFrom(config.clock));
    // restore_replay_complete and restored_participants_suppressed are not
    // written: the WHERE clause re-asserts their pins under the row lock.
    const written = await client.query(
      `UPDATE ${table(config, "retention_state")}
          SET state = 'completed',
              last_started_at = $1::timestamptz,
              last_completed_at = $2::timestamptz,
              maintenance_run_at = $1::timestamptz,
              quarantine_cutoff_at = NULL,
              quarantine_objects_deleted = 0,
              quarantine_retention_complete = true,
              failure_code = NULL
        WHERE singleton = 1
          AND restore_replay_complete
          AND restored_participants_suppressed = 0
          AND lease_id IS NULL
        RETURNING singleton`,
      [config.cycle, completedAt],
    );
    if (written.rows.length !== 1) throw new LifecyclePassRefusal("LIFECYCLE_RESTORE_PIN_CONFLICT");
    return Object.freeze({ noop: false, lifecycleWritten: true });
  }, { operation: "lifecycle_pass.lifecycle", preserveSafeError: safeRefusal });
}

function leaseId(cycleEpoch: number): string {
  return `pglp1:${String(cycleEpoch).padStart(13, "0")}:${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Take the reconciliation row for this cycle. Holding the maintenance lock,
 * any 'running' row is a killed pass's, so it is taken over at once. A
 * backlog left incomplete (state completed or failed, cutoff recorded and not
 * complete) is resumed with its counters, as the Worker resumes its cursor.
 */
async function acquireReconciliation(config: ValidatedOptions, lease: string): Promise<void> {
  await withPostgresMutation(config.pool, async (client) => {
    await assertReceipt(client, config);
    const { reconciliation } = await lockRows(client, config);
    const resume = !reconciliation.reconciliationComplete && reconciliation.cutoffAt !== null;
    const cutoff = canonical(Math.max(0, config.cycleEpoch - POSTGRES_LIFECYCLE_PASS_SAFETY_WINDOW_MILLISECONDS));
    const acquired = await client.query(
      `UPDATE ${table(config, "quarantine_reconciliation_state")}
          SET state = 'running',
              last_started_at = $1::timestamptz,
              maintenance_run_at = $1::timestamptz,
              cutoff_at = $2::timestamptz,
              lease_id = $3,
              registrations_examined = CASE WHEN $4::boolean THEN registrations_examined ELSE 0 END,
              orphan_objects_deleted = CASE WHEN $4::boolean THEN orphan_objects_deleted ELSE 0 END,
              referenced_objects_preserved =
                CASE WHEN $4::boolean THEN referenced_objects_preserved ELSE 0 END,
              reconciliation_complete = false,
              failure_code = NULL
        WHERE singleton = 1
        RETURNING singleton`,
      [config.cycle, cutoff, lease, resume],
    );
    if (acquired.rows.length !== 1) throw new LifecyclePassRefusal("LIFECYCLE_STATE_MISSING");
  }, { operation: "lifecycle_pass.reconciliation_acquire", preserveSafeError: safeRefusal });
}

async function completeReconciliation(
  config: ValidatedOptions,
  lease: string,
  page: PostgresPendingObjectReconciliationResult,
  complete: boolean,
): Promise<void> {
  await withPostgresMutation(config.pool, async (client) => {
    await assertReceipt(client, config);
    const completedAt = canonical(nowFrom(config.clock));
    const completed = await client.query(
      `UPDATE ${table(config, "quarantine_reconciliation_state")}
          SET state = 'completed',
              last_completed_at = $2::timestamptz,
              lease_id = NULL,
              registrations_examined = registrations_examined + $3::bigint,
              orphan_objects_deleted = orphan_objects_deleted + $4::bigint,
              referenced_objects_preserved = referenced_objects_preserved + $5::bigint,
              reconciliation_complete = $6::boolean,
              failure_code = NULL
        WHERE singleton = 1
          AND state = 'running'
          AND lease_id = $1
        RETURNING singleton`,
      [lease, completedAt, page.registrationsExamined, page.orphanObjectsDeleted,
        page.referencedObjectsPreserved, complete],
    );
    if (completed.rows.length !== 1) {
      throw new PostgresStorageError("conflict", "lifecycle_pass.reconciliation_lease");
    }
  }, { operation: "lifecycle_pass.reconciliation_complete", preserveSafeError: safeRefusal });
}

/**
 * Best effort, as the Worker's recordReconciliationFailure: a lost write is
 * taken over next pass. It proves the receipt like every other transaction of
 * the pass, so a schema that no longer matches is left running, not written.
 */
async function recordReconciliationFailure(config: ValidatedOptions, lease: string): Promise<void> {
  try {
    await withPostgresMutation(config.pool, async (client) => {
      await assertReceipt(client, config);
      await client.query(
        `UPDATE ${table(config, "quarantine_reconciliation_state")}
            SET state = 'failed',
                lease_id = NULL,
                reconciliation_complete = false,
                failure_code = 'QUARANTINE_RECONCILIATION_FAILED'
          WHERE singleton = 1
            AND state = 'running'
            AND lease_id = $1`,
        [lease],
      );
    }, { operation: "lifecycle_pass.reconciliation_failure" });
  } catch {
    // The next pass holds the maintenance lock and takes the running row over.
  }
}

interface LockRow { readonly acquired: unknown }
interface UnlockRow { readonly released: unknown }

type Locked<T> =
  | { readonly acquired: false; readonly code: SkippedCode }
  | { readonly acquired: true; readonly value: T };

const MAINTENANCE_LOCK_SQL = "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired";
const MAINTENANCE_UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released";
const MIGRATION_FENCE_SQL = "SELECT pg_try_advisory_lock_shared(hashtextextended($1, 0)) AS acquired";
const MIGRATION_FENCE_RELEASE_SQL = "SELECT pg_advisory_unlock_shared(hashtextextended($1, 0)) AS released";

/**
 * Run `operation` on a dedicated session holding the maintenance lock
 * (exclusive) and then the primary migration fence (shared). Either one held
 * elsewhere skips with its code and runs nothing. A connection whose unlock is
 * not acknowledged is discarded, which releases its locks with the session.
 */
async function withMaintenanceLocks<T>(
  pool: PostgresPool,
  migrationLockKey: string,
  operation: () => Promise<T>,
): Promise<Locked<T>> {
  let client: PostgresClient;
  try {
    client = await pool.connect();
  } catch {
    throw new PostgresStorageError("unavailable", "lifecycle_pass.lock.connect");
  }
  let maintenanceHeld = false;
  let migrationFenceHeld = false;
  let discard = false;
  const tryLock = async (text: string, key: string): Promise<boolean> => {
    let result;
    try {
      result = await client.query<LockRow>(text, [key]);
    } catch {
      discard = true;
      throw new PostgresStorageError("unavailable", "lifecycle_pass.lock.acquire");
    }
    const value = result.rows[0]?.acquired;
    if (typeof value !== "boolean") {
      discard = true;
      throw new PostgresStorageError("unavailable", "lifecycle_pass.lock.acquire");
    }
    return value;
  };
  const unlock = async (text: string, key: string): Promise<void> => {
    try {
      const released = await client.query<UnlockRow>(text, [key]);
      if (released.rows[0]?.released !== true) discard = true;
    } catch {
      discard = true;
    }
  };
  try {
    maintenanceHeld = await tryLock(MAINTENANCE_LOCK_SQL, POSTGRES_LIFECYCLE_PASS_LOCK_DOMAIN);
    if (!maintenanceHeld) return Object.freeze({ acquired: false, code: "MAINTENANCE_IN_PROGRESS" } as const);
    migrationFenceHeld = await tryLock(MIGRATION_FENCE_SQL, migrationLockKey);
    if (!migrationFenceHeld) return Object.freeze({ acquired: false, code: "MIGRATION_IN_PROGRESS" } as const);
    const value = await operation();
    return Object.freeze({ acquired: true, value } as const);
  } finally {
    if (migrationFenceHeld) await unlock(MIGRATION_FENCE_RELEASE_SQL, migrationLockKey);
    if (maintenanceHeld) await unlock(MAINTENANCE_UNLOCK_SQL, POSTGRES_LIFECYCLE_PASS_LOCK_DOMAIN);
    try {
      await client.release(discard);
    } catch {
      try { await client.release(true); } catch { /* the lost session releases the lock */ }
    }
  }
}

interface PassBody {
  readonly lifecycleWritten: boolean;
  readonly lifecycleComplete: boolean;
  readonly reconciliation: PostgresLifecyclePassReconciliation | null;
  readonly reconciliationComplete: boolean;
  readonly reconciliationWritten: boolean;
  readonly purges: PostgresLifecyclePassPurges | null;
  readonly code: PostgresLifecyclePassCode;
  readonly outcome: PostgresLifecyclePassOutcome;
}

function result(
  config: { readonly cycle: string },
  lockAcquired: boolean,
  body: PassBody,
): PostgresLifecyclePassResult {
  return Object.freeze({
    schemaVersion: POSTGRES_LIFECYCLE_PASS_RECEIPT_VERSION,
    outcome: body.outcome,
    code: body.code,
    changed: body.lifecycleWritten || body.reconciliationWritten,
    cycle: config.cycle,
    lockAcquired,
    lifecycleComplete: body.lifecycleComplete,
    lifecycleWritten: body.lifecycleWritten,
    quarantineRetentionComplete: body.lifecycleComplete,
    quarantineObjectsDeleted: 0,
    reconciliation: body.reconciliation,
    quarantineReconciliationComplete: body.reconciliationComplete,
    maintenancePurges: body.purges,
    appendOnlyNotApplicable: POSTGRES_APPEND_ONLY_NOT_APPLICABLE,
  });
}

function idle(outcome: PostgresLifecyclePassOutcome, code: PostgresLifecyclePassCode): PassBody {
  return Object.freeze({
    lifecycleWritten: false,
    lifecycleComplete: false,
    reconciliation: null,
    reconciliationComplete: false,
    reconciliationWritten: false,
    purges: null,
    code,
    outcome,
  });
}

function failureCode(error: unknown): FailureCode {
  return error instanceof Error && error.name === "QuarantineObjectStorageUnavailableError"
    ? "QUARANTINE_OBJECT_STORAGE_UNAVAILABLE"
    : "POSTGRES_MAINTENANCE_UNAVAILABLE";
}

function pageSummary(page: PostgresPendingObjectReconciliationResult): PostgresLifecyclePassReconciliation {
  return Object.freeze({
    registrationsExamined: page.registrationsExamined,
    deletionGraceStarted: page.deletionGraceStarted,
    legacyLeasesAdopted: page.legacyLeasesAdopted,
    orphanObjectsDeleted: page.orphanObjectsDeleted,
    orphanObjectsAlreadyAbsent: page.orphanObjectsAlreadyAbsent,
    referencedObjectsPreserved: page.referencedObjectsPreserved,
    candidatesDeferred: page.candidatesDeferred,
    hasMore: page.hasMore,
  });
}

/**
 * One page of each folded scheduled purge, at the completion clock. Each
 * opens its own transactions on the pass's pool; the migration fence the
 * pass holds covers them, like the reconciler's.
 */
async function maintenancePurges(config: ValidatedOptions): Promise<PostgresLifecyclePassPurges> {
  const nowEpoch = nowFrom(config.clock);
  const identity = await purgePostgresExpiredIdentityRows(config.pool, {
    schema: config.schemaOptions,
    nowEpoch,
  });
  const deviceLifecycle = await purgePostgresStaleDeviceLifecycleRows(config.pool, {
    schema: config.schemaOptions,
    nowEpoch,
  });
  return Object.freeze({
    identity,
    deviceLifecycle,
    complete: identity.complete && deviceLifecycle.complete,
  });
}

async function passUnderLock(config: ValidatedOptions): Promise<PassBody> {
  let lifecycleWritten = false;
  let lifecycleComplete = false;
  let reconciliationWritten = false;
  let purges: PostgresLifecyclePassPurges | null = null;
  try {
    const lifecycle = await lifecyclePhase(config);
    lifecycleWritten = lifecycle.lifecycleWritten;
    lifecycleComplete = true;
    if (lifecycle.noop) {
      return Object.freeze({
        lifecycleWritten: false,
        lifecycleComplete: true,
        reconciliation: null,
        reconciliationComplete: true,
        reconciliationWritten: false,
        purges: null,
        code: "LIFECYCLE_CYCLE_ALREADY_COMPLETE",
        outcome: "complete",
      });
    }
    const ran = await maintenancePurges(config);
    purges = ran;
    const lease = leaseId(config.cycleEpoch);
    await acquireReconciliation(config, lease);
    reconciliationWritten = true;
    let page: PostgresPendingObjectReconciliationResult;
    try {
      page = await reconcilePostgresPendingObjects(config.pool, config.objectStore, {
        schema: config.schemaOptions,
        nowEpoch: config.cycleEpoch,
        safetyWindowMilliseconds: POSTGRES_LIFECYCLE_PASS_SAFETY_WINDOW_MILLISECONDS,
        maximumRegistrations: POSTGRES_LIFECYCLE_PASS_RECONCILIATION_PAGE_SIZE,
      });
    } catch (error) {
      await recordReconciliationFailure(config, lease);
      throw error;
    }
    const complete = !page.hasMore && page.candidatesDeferred === 0;
    try {
      await completeReconciliation(config, lease, page, complete);
    } catch (error) {
      await recordReconciliationFailure(config, lease);
      throw error;
    }
    return Object.freeze({
      lifecycleWritten,
      lifecycleComplete,
      reconciliation: pageSummary(page),
      reconciliationComplete: complete,
      reconciliationWritten,
      purges,
      code: !complete
        ? "QUARANTINE_RECONCILIATION_BACKLOG"
        : ran.complete ? "LIFECYCLE_PASS_COMPLETE" : "MAINTENANCE_PURGE_BACKLOG",
      outcome: complete && ran.complete ? "complete" : "partial",
    });
  } catch (error) {
    const base = {
      lifecycleWritten,
      lifecycleComplete,
      reconciliation: null,
      reconciliationComplete: false,
      reconciliationWritten,
      purges,
    };
    if (error instanceof LifecyclePassRefusal) {
      return Object.freeze({ ...base, code: error.code, outcome: "refused" });
    }
    return Object.freeze({ ...base, code: failureCode(error), outcome: "failure" });
  }
}

/**
 * Run one MP-2-lite pass for `cycleEpoch`. Invalid options throw
 * PostgresLifecyclePassOptionsError before any connection; every other
 * outcome is a result, never a thrown provider error.
 */
export async function runPostgresLifecyclePass(
  options: PostgresLifecyclePassOptions,
): Promise<PostgresLifecyclePassResult> {
  const config = validateOptions(options);
  // Age-based quarantine retention is not ported; a configuration that
  // enables it must not report the retention phase complete.
  if (QUARANTINE_RETENTION_MILLISECONDS !== null) {
    return result(config, false, idle("refused", "LIFECYCLE_QUARANTINE_RETENTION_UNPORTED"));
  }
  let locked: Locked<PassBody>;
  try {
    locked = await withMaintenanceLocks(config.pool, config.migrationLockKey, () => passUnderLock(config));
  } catch (error) {
    return result(config, false, idle("failure", failureCode(error)));
  }
  if (!locked.acquired) return result(config, false, idle("skipped", locked.code));
  return result(config, true, locked.value);
}
