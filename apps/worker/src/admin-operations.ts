import { readCollectionControls, type CollectionControls } from "./collection-controls";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import { readQuarantineReconciliationStatus } from "./quarantine-reconciliation";
import { parseStoredJson } from "./stored-record";
import type { UploadIngressStatus } from "./upload-ingress-admission";

const ADMIN_IDENTITY_DOMAIN = "app-usagemonitor/admin-actor/v1\0";
const DIAGNOSTIC_RETENTION_DAYS = 30;
const MAX_DIAGNOSTIC_EVENTS = 256;
const DIAGNOSTIC_SAMPLE_SUFFIX = "00";
const MAX_ADMIN_AGGREGATE_ROWS = 10_000;
const DIAGNOSTIC_REFERENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type AdminAction = "set_collection_controls" | "run_maintenance";
export type CollectionControlReason =
  | "drill_containment"
  | "drill_restore"
  | "privacy_incident"
  | "security_incident"
  | "abuse_or_cost"
  | "maintenance";

export interface AdminOverviewOptions {
  readonly environment: string;
  readonly enrollmentMode: string;
  readonly accountScopedIngestMode: string;
  readonly diagnosticReference?: string;
  /**
   * Upload-ingress pressure read separately from the budget Durable Object;
   * `null` keeps the overview readable when that binding is unavailable.
   */
  readonly ingress?: UploadIngressStatus | null;
  readonly nowEpoch?: number;
}

interface CountRow {
  total: number;
  active?: number;
  deleting?: number;
  accepted?: number;
  processing?: number;
  enrolled_last_24h?: number;
  enrolled_last_7d?: number;
  accepted_last_24h?: number;
  accepted_last_7d?: number;
}

interface BoundedCount {
  readonly total: number;
  readonly bounded: boolean;
}

interface RetentionRow {
  state: string;
  last_started_at: string | null;
  last_completed_at: string | null;
  maintenance_run_at: string | null;
  quarantine_cutoff_at: string | null;
  quarantine_objects_deleted: number;
  quarantine_retention_complete: number;
  restored_participants_suppressed: number;
  restore_replay_complete: number;
  failure_code: string | null;
}

interface DiagnosticRow {
  request_id: string;
  route_class: string;
  error_code: string;
  status: number;
  occurred_at: string;
}

interface ErrorGroupRow {
  route_class: string;
  error_code: string;
  status: number;
  occurrences: number;
  latest_at: string;
}

interface SnapshotRow {
  snapshot_id: string;
  week_start: string;
  week_end: string;
  revision: number;
  source_mutation_epoch: number;
  release_state: "published" | "suppressed" | "withdrawn";
  released_at: string;
}

function nowIso(nowEpoch: number): string {
  if (!Number.isFinite(nowEpoch)) throw new Error("invalid admin operation time");
  return new Date(nowEpoch).toISOString();
}

function bool(value: number | undefined): boolean {
  return value === 1;
}

function safeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (typeof json !== "string" || json.length > 2000) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return json;
}

function publicDiagnostic(row: DiagnosticRow | null): object | null {
  return row === null
    ? null
    : {
      requestId: row.request_id,
      routeClass: row.route_class,
      errorCode: row.error_code,
      status: row.status,
      occurredAt: row.occurred_at,
    };
}

export function adminIdentityKeyConfigured(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export function validDiagnosticReference(value: string): boolean {
  return DIAGNOSTIC_REFERENCE_PATTERN.test(value);
}

function boundedCount(row: CountRow | { total: number }): BoundedCount {
  const total = Number(row.total);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return {
    total: Math.min(total, MAX_ADMIN_AGGREGATE_ROWS),
    bounded: total >= MAX_ADMIN_AGGREGATE_ROWS,
  };
}

function collectionControlState(flags: {
  enrollment: boolean;
  uploadRegistration: boolean;
  processing: boolean;
  publication: boolean;
}): CollectionControls["state"] {
  const enabledCount = Object.values(flags).filter(Boolean).length;
  return enabledCount === 4
    ? "operational"
    : enabledCount === 0
      ? "contained"
      : "degraded";
}

async function adminIdentityDigest(actorIdentityKey: string): Promise<string> {
  return sha256Hex(`${ADMIN_IDENTITY_DOMAIN}${actorIdentityKey}`);
}

export async function authorizeAdminIdentity(
  db: D1Database,
  participantId: string,
  configuredIdentityKey: unknown,
): Promise<string> {
  if (!adminIdentityKeyConfigured(configuredIdentityKey)) {
    throw new ApiError(503, "ADMIN_NOT_CONFIGURED");
  }
  const row = await db.prepare(
    `SELECT 1 AS present
       FROM participants
      WHERE id = ? AND state = 'active' AND identity_link_key = ?`,
  ).bind(participantId, configuredIdentityKey).first<{ present: number }>();
  if (row?.present !== 1) throw new ApiError(403, "ADMIN_REQUIRED");
  return configuredIdentityKey;
}

export async function beginAdminOperation(
  db: D1Database,
  actorIdentityKey: string,
  action: AdminAction,
  details: unknown,
  nowEpoch = Date.now(),
): Promise<string> {
  const operationId = crypto.randomUUID();
  const actorIdentityDigest = await adminIdentityDigest(actorIdentityKey);
  await db.prepare(
    `INSERT INTO admin_action_audit (
      operation_id, action, actor_identity_digest, outcome, details_json, created_at
    ) VALUES (?, ?, ?, 'started', ?, ?)`,
  ).bind(
    operationId,
    action,
    actorIdentityDigest,
    safeJson(details),
    nowIso(nowEpoch),
  ).run();
  return operationId;
}

export async function finishAdminOperation(
  db: D1Database,
  operationId: string,
  outcome: "success" | "failure",
  details: unknown,
): Promise<void> {
  const result = await db.prepare(
    `UPDATE admin_action_audit
        SET outcome = ?, details_json = ?
      WHERE operation_id = ? AND outcome = 'started'`,
  ).bind(outcome, safeJson(details), operationId).run();
  if (result.meta.changes !== 1) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

/**
 * Best-effort request failure recording. The failure response must remain
 * available even if a partially unavailable D1 cannot accept its own audit
 * row, so this function deliberately swallows storage errors.
 */
export async function recordDiagnosticError(
  db: D1Database | undefined,
  requestId: string,
  routeClass: string,
  errorCode: string,
  status: number,
  nowEpoch = Date.now(),
): Promise<void> {
  if (!db
      || status < 500
      || !DIAGNOSTIC_REFERENCE_PATTERN.test(requestId)
      || !requestId.endsWith(DIAGNOSTIC_SAMPLE_SUFFIX)) {
    return;
  }
  try {
    await db.prepare(
      `INSERT INTO diagnostic_error_events (
        request_id, route_class, error_code, status, occurred_at
      ) SELECT ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM diagnostic_error_events) < ?`,
    ).bind(
      requestId,
      routeClass.slice(0, 80),
      errorCode.slice(0, 80),
      status,
      nowIso(nowEpoch),
      MAX_DIAGNOSTIC_EVENTS,
    ).run();
  } catch {
    // Diagnostics cannot be allowed to turn a useful error response into a
    // second failure, especially while the database itself is unhealthy.
  }
}

export async function pruneDiagnosticErrors(
  db: D1Database,
  nowEpoch = Date.now(),
): Promise<void> {
  const cutoff = new Date(
    nowEpoch - DIAGNOSTIC_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  await db.prepare(
    "DELETE FROM diagnostic_error_events WHERE occurred_at < ?",
  ).bind(cutoff).run();
}

export async function setCollectionControls(
  db: D1Database,
  actorIdentityKey: string,
  flags: {
    enrollment: boolean;
    uploadRegistration: boolean;
    processing: boolean;
    publication: boolean;
  },
  reasonCode: CollectionControlReason,
  expectedRevision: number,
  nowEpoch = Date.now(),
): Promise<CollectionControls> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const state = collectionControlState(flags);
  const nextRevision = expectedRevision + 1;
  const updatedAt = nowIso(nowEpoch);
  const actorIdentityDigest = await adminIdentityDigest(actorIdentityKey);
  const operationId = crypto.randomUUID();
  const requestedDetails = safeJson({
    expectedRevision,
    flags,
    reasonCode,
  });
  const successDetails = safeJson({
    expectedRevision,
    revision: nextRevision,
    state,
    flags,
    reasonCode,
  });
  const failureDetails = safeJson({
    expectedRevision,
    flags,
    reasonCode,
    code: "ADMIN_ACTION_CONFLICT",
  });
  const results = await db.batch([
    db.prepare(
      `INSERT INTO admin_action_audit (
        operation_id, action, actor_identity_digest, outcome, details_json, created_at
      ) VALUES (?, 'set_collection_controls', ?, 'started', ?, ?)`,
    ).bind(operationId, actorIdentityDigest, requestedDetails, updatedAt),
    db.prepare(
      `UPDATE collection_controls
        SET enrollment_enabled = ?,
            upload_registration_enabled = ?,
            processing_enabled = ?,
            publication_enabled = ?,
            control_state = ?,
            revision = revision + 1,
            reason_code = ?,
            updated_at = ?
      WHERE singleton = 1 AND revision = ?`,
    ).bind(
      Number(flags.enrollment),
    Number(flags.uploadRegistration),
    Number(flags.processing),
    Number(flags.publication),
      state,
      reasonCode,
      updatedAt,
      expectedRevision,
    ),
    db.prepare(
      `UPDATE admin_action_audit
          SET outcome = 'success', details_json = ?
        WHERE operation_id = ? AND outcome = 'started'
          AND EXISTS (
            SELECT 1 FROM collection_controls
             WHERE singleton = 1
               AND revision = ?
               AND enrollment_enabled = ?
               AND upload_registration_enabled = ?
               AND processing_enabled = ?
               AND publication_enabled = ?
               AND control_state = ?
               AND reason_code = ?
               AND updated_at = ?
          )`,
    ).bind(
      successDetails,
      operationId,
      nextRevision,
      Number(flags.enrollment),
      Number(flags.uploadRegistration),
      Number(flags.processing),
      Number(flags.publication),
      state,
      reasonCode,
      updatedAt,
    ),
    db.prepare(
      `UPDATE admin_action_audit
          SET outcome = 'failure', details_json = ?
        WHERE operation_id = ? AND outcome = 'started'`,
    ).bind(failureDetails, operationId),
  ]);
  if (results[1]?.meta.changes === 0
      && results[2]?.meta.changes === 0
      && results[3]?.meta.changes === 1) {
    throw new ApiError(409, "ADMIN_ACTION_CONFLICT");
  }
  if (results[0]?.meta.changes !== 1
      || results[1]?.meta.changes !== 1
      || results[2]?.meta.changes !== 1
      || results[3]?.meta.changes !== 0) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return Object.freeze({
    schemaVersion: "collection-controls-v0.1",
    state,
    revision: nextRevision,
    ...flags,
  } satisfies CollectionControls);
}

export async function readAdminOverview(
  db: D1Database,
  deletionLedger: D1Database,
  options: AdminOverviewOptions,
): Promise<object> {
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = nowIso(nowEpoch);
  const since = new Date(
    nowEpoch - 24 * 60 * 60 * 1_000,
  ).toISOString();
  const sinceWeek = new Date(
    nowEpoch - 7 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const diagnosticSince = new Date(
    nowEpoch - DIAGNOSTIC_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const [
    controls,
    participants,
    syntheticContributions,
    telemetryContributions,
    telemetryRecords,
    pendingQuarantine,
    retention,
    reconciliation,
    snapshots,
    pendingRebuilds,
    deletionTombstones,
    errorGroups,
    recentDiagnostics,
    diagnosticLookup,
    adminAudit,
  ] = await Promise.all([
    readCollectionControls(db),
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN state = 'deleting' THEN 1 ELSE 0 END) AS deleting,
              SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS enrolled_last_24h,
              SUM(CASE WHEN created_at >= ?2 THEN 1 ELSE 0 END) AS enrolled_last_7d
         FROM (
           SELECT state, created_at FROM participants ORDER BY id LIMIT ?3
         )`,
    ).bind(since, sinceWeek, MAX_ADMIN_AGGREGATE_ROWS).first<CountRow>(),
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'accepted_synthetic' THEN 1 ELSE 0 END) AS accepted,
              SUM(CASE WHEN status = 'deleting' THEN 1 ELSE 0 END) AS deleting
         FROM (
           SELECT status FROM contributions ORDER BY id LIMIT ?
         )`,
    ).bind(MAX_ADMIN_AGGREGATE_ROWS).first<CountRow>(),
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
              SUM(CASE WHEN status = 'deleting' THEN 1 ELSE 0 END) AS deleting,
              SUM(CASE WHEN status = 'accepted' AND created_at >= ?1 THEN 1 ELSE 0 END)
                AS accepted_last_24h,
              SUM(CASE WHEN status = 'accepted' AND created_at >= ?2 THEN 1 ELSE 0 END)
                AS accepted_last_7d
         FROM (
           SELECT status, created_at FROM telemetry_contributions ORDER BY id LIMIT ?3
         )`,
    ).bind(since, sinceWeek, MAX_ADMIN_AGGREGATE_ROWS).first<CountRow>(),
    db.prepare(
      "SELECT COUNT(*) AS total FROM (SELECT 1 FROM telemetry_records LIMIT ?)",
    ).bind(MAX_ADMIN_AGGREGATE_ROWS).first<CountRow>(),
    db.prepare(
      "SELECT COUNT(*) AS total FROM (SELECT 1 FROM pending_quarantine_objects LIMIT ?)",
    ).bind(MAX_ADMIN_AGGREGATE_ROWS).first<CountRow>(),
    db.prepare(
      `SELECT state, last_started_at, last_completed_at, maintenance_run_at,
              quarantine_cutoff_at, quarantine_objects_deleted,
              quarantine_retention_complete, restored_participants_suppressed,
              restore_replay_complete, failure_code
         FROM retention_state WHERE singleton = 1`,
    ).first<RetentionRow>(),
    readQuarantineReconciliationStatus(db),
    db.prepare(
      `SELECT snapshot_id, week_start, week_end, revision,
              source_mutation_epoch, release_state, released_at
         FROM community_weekly_snapshots
        ORDER BY week_end DESC, revision DESC
        LIMIT 12`,
    ).all<SnapshotRow>(),
    db.prepare(
      `SELECT COUNT(*) AS total FROM (
         SELECT 1 FROM community_weekly_snapshot_rebuilds LIMIT ?
       )`,
    ).bind(MAX_ADMIN_AGGREGATE_ROWS).first<{ total: number }>(),
    deletionLedger.prepare(
      `SELECT COUNT(*) AS total, MIN(retain_until) AS earliest_retain_until
         FROM (
           SELECT retain_until FROM deletion_tombstones ORDER BY retain_until LIMIT ?
         )`,
    ).bind(MAX_ADMIN_AGGREGATE_ROWS).first<{ total: number; earliest_retain_until: string | null }>(),
    db.prepare(
      `SELECT route_class, error_code, status, COUNT(*) AS occurrences,
              MAX(occurred_at) AS latest_at
         FROM diagnostic_error_events
        WHERE occurred_at >= ?
        GROUP BY route_class, error_code, status
        ORDER BY occurrences DESC, latest_at DESC
        LIMIT 20`,
    ).bind(diagnosticSince).all<ErrorGroupRow>(),
    db.prepare(
      `SELECT request_id, route_class, error_code, status, occurred_at
         FROM diagnostic_error_events
        WHERE occurred_at >= ?
        ORDER BY occurred_at DESC, id DESC
        LIMIT 20`,
    ).bind(diagnosticSince).all<DiagnosticRow>(),
    options.diagnosticReference
      ? db.prepare(
        `SELECT request_id, route_class, error_code, status, occurred_at
           FROM diagnostic_error_events WHERE request_id = ? LIMIT 1`,
      ).bind(options.diagnosticReference).first<DiagnosticRow>()
      : Promise.resolve(null),
    db.prepare(
      `SELECT action, outcome, details_json, created_at
         FROM admin_action_audit
        ORDER BY created_at DESC, id DESC
        LIMIT 20`,
    ).all<{
      action: AdminAction;
      outcome: "started" | "success" | "failure";
      details_json: string;
      created_at: string;
    }>(),
  ]);
  if (!participants || !syntheticContributions || !telemetryContributions
      || !telemetryRecords || !pendingQuarantine || !retention
      || !deletionTombstones) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return {
    schemaVersion: "admin-overview-v0.1",
    generatedAt: now,
    service: {
      environment: options.environment,
      enrollmentMode: options.enrollmentMode,
      accountScopedIngestMode: options.accountScopedIngestMode,
    },
    collection: controls,
    counts: {
      participants: {
        total: boundedCount(participants).total,
        bounded: boundedCount(participants).bounded,
        active: Number(participants.active ?? 0),
        deleting: Number(participants.deleting ?? 0),
        enrolledLast24Hours: Number(participants.enrolled_last_24h ?? 0),
        enrolledLast7Days: Number(participants.enrolled_last_7d ?? 0),
      },
      contributions: {
        synthetic: {
          total: boundedCount(syntheticContributions).total,
          bounded: boundedCount(syntheticContributions).bounded,
          accepted: Number(syntheticContributions.accepted ?? 0),
          deleting: Number(syntheticContributions.deleting ?? 0),
        },
        telemetry: {
          total: boundedCount(telemetryContributions).total,
          bounded: boundedCount(telemetryContributions).bounded,
          accepted: Number(telemetryContributions.accepted ?? 0),
          deleting: Number(telemetryContributions.deleting ?? 0),
          acceptedLast24Hours: Number(telemetryContributions.accepted_last_24h ?? 0),
          acceptedLast7Days: Number(telemetryContributions.accepted_last_7d ?? 0),
        },
        storedTelemetryRecords: boundedCount(telemetryRecords).total,
        storedTelemetryRecordsBounded: boundedCount(telemetryRecords).bounded,
      },
      pendingQuarantineObjects: boundedCount(pendingQuarantine).total,
      pendingQuarantineObjectsBounded: boundedCount(pendingQuarantine).bounded,
    },
    lifecycle: {
      state: retention.state,
      lastStartedAt: retention.last_started_at,
      lastCompletedAt: retention.last_completed_at,
      maintenanceRunAt: retention.maintenance_run_at,
      quarantineCutoffAt: retention.quarantine_cutoff_at,
      quarantineObjectsDeleted: retention.quarantine_objects_deleted,
      quarantineRetentionComplete: bool(retention.quarantine_retention_complete),
      restoredParticipantsSuppressed: retention.restored_participants_suppressed,
      restoreReplayComplete: bool(retention.restore_replay_complete),
      failureCode: retention.failure_code,
    },
    reconciliation,
    ingress: options.ingress ?? null,
    deletionLedger: {
      total: boundedCount(deletionTombstones).total,
      bounded: boundedCount(deletionTombstones).bounded,
      earliestRetainUntil: deletionTombstones.earliest_retain_until,
    },
    snapshots: snapshots.results.map((row) => ({
      snapshotId: row.snapshot_id,
      weekStart: row.week_start,
      weekEnd: row.week_end,
      revision: row.revision,
      sourceMutationEpoch: row.source_mutation_epoch,
      releaseState: row.release_state,
      releasedAt: row.released_at,
    })),
    pendingHistoricalRebuilds: boundedCount(pendingRebuilds ?? { total: 0 }).total,
    pendingHistoricalRebuildsBounded:
      boundedCount(pendingRebuilds ?? { total: 0 }).bounded,
    errors: {
      retentionDays: DIAGNOSTIC_RETENTION_DAYS,
      sampled: true,
      capacity: MAX_DIAGNOSTIC_EVENTS,
      groups: errorGroups.results.map((row) => ({
        routeClass: row.route_class,
        errorCode: row.error_code,
        status: row.status,
        occurrences: Number(row.occurrences),
        ratePerDay: Number((Number(row.occurrences) / DIAGNOSTIC_RETENTION_DAYS).toFixed(2)),
        latestAt: row.latest_at,
      })),
      recentDiagnostics: recentDiagnostics.results.map((row) => publicDiagnostic(row)),
      lookup: publicDiagnostic(diagnosticLookup),
    },
    audit: adminAudit.results.map((row) => ({
      action: row.action,
      outcome: row.outcome,
      details: parseStoredJson(row.details_json),
      createdAt: row.created_at,
    })),
  };
}
