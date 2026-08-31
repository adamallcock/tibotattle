import {
  QUARANTINE_RECONCILIATION_GRACE_MILLISECONDS,
} from "./constants";
import { ApiError } from "./errors";

const QUARANTINE_RECONCILIATION_BATCH_SIZE = 100;
const QUARANTINE_RECONCILIATION_LEASE_MILLISECONDS = 15 * 60 * 1000;

export type QuarantineObjectKind = "synthetic" | "telemetry";

export interface PendingQuarantineRegistration {
  contributionId: string;
  objectKind: QuarantineObjectKind;
  r2Key: string;
  registeredAt: string;
}

interface PendingQuarantineRow {
  r2_key: string;
  registered_at: string;
}

interface ReconciliationStateRow {
  state: "never_run" | "running" | "completed" | "failed";
  last_started_at: string | null;
  last_completed_at: string | null;
  maintenance_run_at: string | null;
  cutoff_at: string | null;
  cursor_registered_at: string | null;
  cursor_r2_key: string | null;
  registrations_examined: number;
  orphan_objects_deleted: number;
  referenced_objects_preserved: number;
  reconciliation_complete: number;
  failure_code: "QUARANTINE_RECONCILIATION_FAILED" | null;
}

export interface QuarantineReconciliationStatus {
  state: ReconciliationStateRow["state"];
  lastCompletedAt: string | null;
  maintenanceRunAt: string | null;
  cutoffAt: string | null;
  registrationsExamined: number;
  orphanObjectsDeleted: number;
  referencedObjectsPreserved: number;
  reconciliationComplete: boolean;
  failureCode: ReconciliationStateRow["failure_code"];
}

export interface QuarantineReconciliationResult {
  reconciliationCutoffAt: string;
  registrationsExamined: number;
  orphanObjectsDeleted: number;
  referencedObjectsPreserved: number;
  reconciliationComplete: boolean;
}

function canonicalInstant(epoch: number): string {
  const instant = new Date(epoch);
  if (!Number.isFinite(epoch) || !Number.isFinite(instant.getTime())) {
    throw new TypeError("invalid quarantine reconciliation time");
  }
  return instant.toISOString();
}

function assertCanonicalInstant(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || canonicalInstant(parsed) !== value) {
    throw new TypeError("invalid quarantine registration time");
  }
}

function assertRegistration(
  registration: PendingQuarantineRegistration,
): void {
  const expectedPrefix = `${registration.objectKind}/`;
  // v0.1 envelopes register under their contribution id; v1.0 chunk
  // envelopes register under their chunk journal row id.
  if (!registration.r2Key.startsWith(expectedPrefix)
      || !(registration.contributionId.startsWith("contribution:")
        || registration.contributionId.startsWith("chunk:"))) {
    throw new TypeError("invalid quarantine registration");
  }
  assertCanonicalInstant(registration.registeredAt);
}

export async function registerPendingQuarantineObject(
  db: D1Database,
  registration: PendingQuarantineRegistration,
): Promise<void> {
  assertRegistration(registration);
  const result = await db.prepare(
    `INSERT INTO pending_quarantine_objects (
      r2_key, contribution_id, object_kind, registered_at
    ) VALUES (?, ?, ?, ?)`,
  ).bind(
    registration.r2Key,
    registration.contributionId,
    registration.objectKind,
    registration.registeredAt,
  ).run();
  if (result.meta.changes !== 1) {
    throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
  }
}

export async function putTrackedQuarantineObject(
  db: D1Database,
  quarantine: R2Bucket,
  registration: PendingQuarantineRegistration,
  value: string,
  options?: R2PutOptions,
): Promise<void> {
  await registerPendingQuarantineObject(db, registration);
  await quarantine.put(registration.r2Key, value, options);
}

export async function clearPendingQuarantineObject(
  db: D1Database,
  registration: Pick<
    PendingQuarantineRegistration,
    "contributionId" | "r2Key"
  >,
): Promise<void> {
  await db.prepare(
    `DELETE FROM pending_quarantine_objects
      WHERE r2_key = ? AND contribution_id = ?`,
  ).bind(registration.r2Key, registration.contributionId).run();
}

export async function readQuarantineReconciliationStatus(
  db: D1Database,
): Promise<QuarantineReconciliationStatus> {
  const state = await db.prepare(
    `SELECT state, last_completed_at, maintenance_run_at,
            cutoff_at, registrations_examined, orphan_objects_deleted,
            referenced_objects_preserved, reconciliation_complete, failure_code
       FROM quarantine_reconciliation_state
      WHERE singleton = 1`,
  ).first<Pick<
    ReconciliationStateRow,
    | "state"
    | "last_completed_at"
    | "maintenance_run_at"
    | "cutoff_at"
    | "registrations_examined"
    | "orphan_objects_deleted"
    | "referenced_objects_preserved"
    | "reconciliation_complete"
    | "failure_code"
  >>();
  if (!state) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return {
    state: state.state,
    lastCompletedAt: state.last_completed_at,
    maintenanceRunAt: state.maintenance_run_at,
    cutoffAt: state.cutoff_at,
    registrationsExamined: state.registrations_examined,
    orphanObjectsDeleted: state.orphan_objects_deleted,
    referencedObjectsPreserved: state.referenced_objects_preserved,
    reconciliationComplete: state.reconciliation_complete === 1,
    failureCode: state.failure_code,
  };
}

async function readReconciliationState(
  db: D1Database,
): Promise<ReconciliationStateRow> {
  const state = await db.prepare(
    `SELECT state, last_started_at, last_completed_at, maintenance_run_at,
            cutoff_at,
            cursor_registered_at, cursor_r2_key, registrations_examined,
            orphan_objects_deleted, referenced_objects_preserved,
            reconciliation_complete, failure_code
       FROM quarantine_reconciliation_state
      WHERE singleton = 1`,
  ).first<ReconciliationStateRow>();
  if (!state) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return state;
}

async function acquireReconciliationLease(
  db: D1Database,
  nowEpoch: number,
): Promise<{
  cutoffAt: string;
  cursorRegisteredAt: string | null;
  cursorR2Key: string | null;
  leaseId: string;
  orphanObjectsDeleted: number;
  referencedObjectsPreserved: number;
  registrationsExamined: number;
}> {
  const current = await readReconciliationState(db);
  const resume = current.reconciliation_complete === 0
    && current.cutoff_at !== null;
  if (!resume
      && (current.cursor_registered_at !== null
        || current.cursor_r2_key !== null)) {
    throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
  }
  const requestedCutoffAt = canonicalInstant(
    nowEpoch - QUARANTINE_RECONCILIATION_GRACE_MILLISECONDS,
  );
  if (current.cutoff_at !== null) assertCanonicalInstant(current.cutoff_at);
  const cutoffAt = current.cutoff_at !== null
      && current.cutoff_at > requestedCutoffAt
    ? current.cutoff_at
    : requestedCutoffAt;
  assertCanonicalInstant(cutoffAt);
  const cursorRegisteredAt = resume ? current.cursor_registered_at : null;
  const cursorR2Key = resume ? current.cursor_r2_key : null;
  if ((cursorRegisteredAt === null) !== (cursorR2Key === null)) {
    throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
  }
  if (cursorRegisteredAt !== null) assertCanonicalInstant(cursorRegisteredAt);

  const startedAt = canonicalInstant(nowEpoch);
  const leaseCutoffAt = canonicalInstant(
    nowEpoch - QUARANTINE_RECONCILIATION_LEASE_MILLISECONDS,
  );
  const leaseId = crypto.randomUUID();
  const registrationsExamined = resume ? current.registrations_examined : 0;
  const orphanObjectsDeleted = resume ? current.orphan_objects_deleted : 0;
  const referencedObjectsPreserved = resume
    ? current.referenced_objects_preserved
    : 0;
  const acquired = await db.prepare(
    `UPDATE quarantine_reconciliation_state
        SET state = 'running',
            last_started_at = ?,
            maintenance_run_at = ?,
            cutoff_at = ?,
            cursor_registered_at = ?,
            cursor_r2_key = ?,
            lease_id = ?,
            registrations_examined = ?,
            orphan_objects_deleted = ?,
            referenced_objects_preserved = ?,
            reconciliation_complete = 0,
            failure_code = NULL
      WHERE singleton = 1
        AND (
          state != 'running'
          OR last_started_at IS NULL
          OR last_started_at <= ?
        )`,
  ).bind(
    startedAt,
    startedAt,
    cutoffAt,
    cursorRegisteredAt,
    cursorR2Key,
    leaseId,
    registrationsExamined,
    orphanObjectsDeleted,
    referencedObjectsPreserved,
    leaseCutoffAt,
  ).run();
  if (acquired.meta.changes !== 1) {
    throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
  }
  return {
    cutoffAt,
    cursorRegisteredAt,
    cursorR2Key,
    leaseId,
    orphanObjectsDeleted,
    referencedObjectsPreserved,
    registrationsExamined,
  };
}

async function dueRegistrations(
  db: D1Database,
  cutoffAt: string,
  cursorRegisteredAt: string | null,
  cursorR2Key: string | null,
  maximumRegistrations: number,
): Promise<PendingQuarantineRow[]> {
  const statement = cursorRegisteredAt === null
    ? db.prepare(
      `SELECT r2_key, registered_at
         FROM pending_quarantine_objects
        WHERE registered_at <= ?
        ORDER BY registered_at, r2_key
        LIMIT ?`,
    ).bind(cutoffAt, maximumRegistrations + 1)
    : db.prepare(
      `SELECT r2_key, registered_at
         FROM pending_quarantine_objects
        WHERE registered_at <= ?
          AND (
            registered_at > ?
            OR (registered_at = ? AND r2_key > ?)
          )
        ORDER BY registered_at, r2_key
        LIMIT ?`,
    ).bind(
      cutoffAt,
      cursorRegisteredAt,
      cursorRegisteredAt,
      cursorR2Key,
      maximumRegistrations + 1,
    );
  const result = await statement.all<PendingQuarantineRow>();
  return result.results;
}

async function quarantineObjectReferenced(
  db: D1Database,
  r2Key: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT CASE
      WHEN EXISTS (SELECT 1 FROM contributions WHERE r2_key = ?)
        OR EXISTS (
          SELECT 1 FROM telemetry_contributions WHERE r2_key = ?
        )
        OR EXISTS (
          SELECT 1 FROM telemetry_v1_chunks WHERE r2_key = ?
        )
        OR EXISTS (
          SELECT 1 FROM telemetry_v11_chunks WHERE r2_key = ?
        )
      THEN 1 ELSE 0
    END AS referenced`,
  ).bind(r2Key, r2Key, r2Key, r2Key).first<{ referenced: number }>();
  if (row?.referenced !== 0 && row?.referenced !== 1) {
    throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
  }
  return row.referenced === 1;
}

async function clearReconciledRegistration(
  db: D1Database,
  r2Key: string,
): Promise<void> {
  await db.prepare(
    "DELETE FROM pending_quarantine_objects WHERE r2_key = ?",
  ).bind(r2Key).run();
}

async function claimOrphanRegistration(
  db: D1Database,
  row: PendingQuarantineRow,
  leaseId: string,
): Promise<"claimed" | "gone" | "referenced"> {
  const claimed = await db.prepare(
    `UPDATE pending_quarantine_objects
        SET reconciliation_state = 'deleting',
            reconciliation_lease_id = ?
      WHERE r2_key = ?
        AND registered_at = ?
        AND reconciliation_state IN ('registered', 'deleting')
        AND NOT EXISTS (
          SELECT 1 FROM contributions WHERE r2_key = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM telemetry_contributions WHERE r2_key = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM telemetry_v1_chunks WHERE r2_key = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM telemetry_v11_chunks WHERE r2_key = ?
        )
        AND EXISTS (
          SELECT 1
            FROM quarantine_reconciliation_state
           WHERE singleton = 1
             AND state = 'running'
             AND lease_id = ?
        )`,
  ).bind(
    leaseId,
    row.r2_key,
    row.registered_at,
    row.r2_key,
    row.r2_key,
    row.r2_key,
    row.r2_key,
    leaseId,
  ).run();
  if (claimed.meta.changes === 1) return "claimed";
  if (await quarantineObjectReferenced(db, row.r2_key)) return "referenced";
  const pending = await db.prepare(
    "SELECT 1 AS pending FROM pending_quarantine_objects WHERE r2_key = ?",
  ).bind(row.r2_key).first<{ pending: number }>();
  if (!pending) return "gone";
  throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
}

async function assertActiveReconciliationLease(
  db: D1Database,
  leaseId: string,
): Promise<void> {
  const lease = await db.prepare(
    `SELECT CASE WHEN EXISTS (
      SELECT 1
        FROM quarantine_reconciliation_state
       WHERE singleton = 1
         AND state = 'running'
         AND lease_id = ?
    ) THEN 1 ELSE 0 END AS lease_active`,
  ).bind(leaseId).first<{ lease_active: number }>();
  if (lease?.lease_active !== 1) {
    throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
  }
}

async function reconcileRegistration(
  db: D1Database,
  quarantine: R2Bucket,
  row: PendingQuarantineRow,
  leaseId: string,
): Promise<{
  orphanDeleted: number;
  referencedPreserved: number;
}> {
  if (await quarantineObjectReferenced(db, row.r2_key)) {
    await clearReconciledRegistration(db, row.r2_key);
    return { orphanDeleted: 0, referencedPreserved: 1 };
  }
  const claim = await claimOrphanRegistration(db, row, leaseId);
  if (claim === "referenced") {
    await clearReconciledRegistration(db, row.r2_key);
    return { orphanDeleted: 0, referencedPreserved: 1 };
  }
  if (claim === "gone") {
    return { orphanDeleted: 0, referencedPreserved: 0 };
  }

  await assertActiveReconciliationLease(db, leaseId);
  const object = await quarantine.head(row.r2_key);
  if (object) {
    await assertActiveReconciliationLease(db, leaseId);
    await quarantine.delete(row.r2_key);
  }
  const cleared = await db.prepare(
    `DELETE FROM pending_quarantine_objects
      WHERE r2_key = ?
        AND reconciliation_state = 'deleting'
        AND reconciliation_lease_id = ?`,
  ).bind(row.r2_key, leaseId).run();
  if (cleared.meta.changes !== 1) {
    throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
  }
  return {
    orphanDeleted: object ? 1 : 0,
    referencedPreserved: 0,
  };
}

async function recordReconciliationFailure(
  db: D1Database,
  leaseId: string,
): Promise<void> {
  await db.prepare(
    `UPDATE quarantine_reconciliation_state
        SET state = 'failed',
            lease_id = NULL,
            reconciliation_complete = 0,
            failure_code = 'QUARANTINE_RECONCILIATION_FAILED'
      WHERE singleton = 1
        AND state = 'running'
        AND lease_id = ?`,
  ).bind(leaseId).run();
}

export async function reconcilePendingQuarantineObjects(
  db: D1Database,
  quarantine: R2Bucket,
  nowEpoch = Date.now(),
  maximumRegistrations = QUARANTINE_RECONCILIATION_BATCH_SIZE,
): Promise<QuarantineReconciliationResult> {
  if (!Number.isFinite(nowEpoch)
      || !Number.isSafeInteger(maximumRegistrations)
      || maximumRegistrations < 1
      || maximumRegistrations > QUARANTINE_RECONCILIATION_BATCH_SIZE) {
    throw new TypeError("invalid quarantine reconciliation request");
  }
  const lease = await acquireReconciliationLease(db, nowEpoch);
  try {
    const due = await dueRegistrations(
      db,
      lease.cutoffAt,
      lease.cursorRegisteredAt,
      lease.cursorR2Key,
      maximumRegistrations,
    );
    const batch = due.slice(0, maximumRegistrations);
    let orphanObjectsDeleted = 0;
    let referencedObjectsPreserved = 0;
    for (const row of batch) {
      const result = await reconcileRegistration(
        db,
        quarantine,
        row,
        lease.leaseId,
      );
      orphanObjectsDeleted += result.orphanDeleted;
      referencedObjectsPreserved += result.referencedPreserved;
    }
    const reconciliationComplete = due.length <= maximumRegistrations;
    const last = batch[batch.length - 1];
    const completedAt = canonicalInstant(nowEpoch);
    const registrationsExamined = lease.registrationsExamined + batch.length;
    const cumulativeOrphans = lease.orphanObjectsDeleted
      + orphanObjectsDeleted;
    const cumulativeReferences = lease.referencedObjectsPreserved
      + referencedObjectsPreserved;
    const completed = await db.prepare(
      `UPDATE quarantine_reconciliation_state
          SET state = 'completed',
              last_completed_at = ?,
              cursor_registered_at = ?,
              cursor_r2_key = ?,
              lease_id = NULL,
              registrations_examined = ?,
              orphan_objects_deleted = ?,
              referenced_objects_preserved = ?,
              reconciliation_complete = ?,
              failure_code = NULL
        WHERE singleton = 1
          AND state = 'running'
          AND lease_id = ?`,
    ).bind(
      completedAt,
      reconciliationComplete ? null : last?.registered_at ?? null,
      reconciliationComplete ? null : last?.r2_key ?? null,
      registrationsExamined,
      cumulativeOrphans,
      cumulativeReferences,
      Number(reconciliationComplete),
      lease.leaseId,
    ).run();
    if (completed.meta.changes !== 1) {
      throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
    }
    return {
      reconciliationCutoffAt: lease.cutoffAt,
      registrationsExamined: batch.length,
      orphanObjectsDeleted,
      referencedObjectsPreserved,
      reconciliationComplete,
    };
  } catch (error) {
    try {
      await recordReconciliationFailure(db, lease.leaseId);
    } catch {
      // The next pass reclaims an expired lease if D1 was unavailable here.
    }
    throw error;
  }
}
