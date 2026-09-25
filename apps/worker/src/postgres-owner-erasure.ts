import { participantDeletionDigest } from "./participant-deletion-digest";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import { hasPostgresDeletionTombstone, recordPostgresDeletionTombstone } from "./postgres-ledger-authority";
import type { ParticipantErasureObjectRef, ParticipantErasureObjectStore } from "./erasure-object-store";

const SYNTHETIC_PARTICIPANT = /^synthetic-v12-smoke-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const OBJECT_ID = /^chunk:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RECEIPT_SCHEMA = "postgres-synthetic-owner-erasure-v1";
const OWNER_ERASURE_OPERATION_DOMAIN = "app-usagemonitor/synthetic-v12-owner-erasure/v1\0";
const MIGRATION_TIMEOUTS = Object.freeze({
  operation: "postgres.owner_erasure",
  statementTimeoutMilliseconds: 10_000,
  lockTimeoutMilliseconds: 5_000,
});

export type SyntheticPostgresOwnerErasureCode =
  | "SYNTHETIC_OWNER_ERASURE_TARGET_INVALID"
  | "SYNTHETIC_OWNER_ERASURE_PARTICIPANT_NOT_FOUND"
  | "SYNTHETIC_OWNER_ERASURE_STATE_UNEXPECTED"
  | "SYNTHETIC_OWNER_ERASURE_FAMILY_UNSUPPORTED"
  | "SYNTHETIC_OWNER_ERASURE_UPLOAD_IN_PROGRESS"
  | "SYNTHETIC_OWNER_ERASURE_REFERENCE_MISMATCH"
  | "SYNTHETIC_OWNER_ERASURE_PENDING_UNATTRIBUTED"
  | "SYNTHETIC_OWNER_ERASURE_OBJECT_STORE_FAILED"
  | "SYNTHETIC_OWNER_ERASURE_LEDGER_FAILED"
  | "SYNTHETIC_OWNER_ERASURE_READBACK_FAILED";

export class SyntheticPostgresOwnerErasureError extends Error {
  readonly code: SyntheticPostgresOwnerErasureCode;

  constructor(code: SyntheticPostgresOwnerErasureCode) {
    super(code);
    this.name = "SyntheticPostgresOwnerErasureError";
    this.code = code;
  }
}

export interface SyntheticPostgresOwnerErasureOptions {
  readonly primaryPool: PostgresPool;
  readonly ledgerPool: PostgresPool;
  readonly objectStore: ParticipantErasureObjectStore;
  readonly participantId: string;
  readonly schema?: PostgresSchemaOptions;
}

export type SyntheticPostgresOwnerErasureResult =
  | { readonly status: "complete" | "already_complete"; readonly objectsDeleted: number }
  | { readonly status: "incomplete"; readonly code: SyntheticPostgresOwnerErasureCode };

interface OwnerLinkRow {
  readonly owner_digest: string;
  readonly state: string;
}

interface ParticipantRow {
  readonly id: string;
  readonly state: string;
  readonly owner_kind: string;
  readonly deletion_session_id: string | null;
  readonly identity_link_key: string | null;
}

interface ChunkRow {
  readonly id: string;
  readonly r2_key: string;
  readonly created_at: Date | string;
}

interface PendingRow {
  readonly contribution_id: string;
  readonly object_key: string;
  readonly object_kind: string;
  readonly reconciliation_state: string;
  readonly registration_token: string;
}

interface StoredRef extends ParticipantErasureObjectRef {
  readonly registrationToken: string;
}

interface ReceiptRow {
  readonly operation_id: string;
  readonly participant_digest: string;
  readonly outcome: "started" | "completed" | "failed";
  readonly details_json: string;
}

interface ReceiptDetails {
  readonly schemaVersion: typeof RECEIPT_SCHEMA;
  readonly phase: "fenced" | "pending_unattributed" | "object_delete_retry" | "objects_deleted" | "completed";
  readonly ownerDigest: string;
  readonly objectCount: number;
}

const ALLOWED_PARTICIPANT_TABLES = Object.freeze({
  attribution_enrollments: [0, 1],
  participants: [1, 1],
  web_sessions: [1, 1],
  device_pairings: [1, 1],
  device_credentials: [1, 1],
  device_upload_authorizations: [0, 4],
  telemetry_v12_device_capabilities: [1, 1],
  storage_v11_owner_links: [1, 1],
  telemetry_v12_day_manifests: [0, 1],
  telemetry_v12_chunks: [0, 1],
  // Created for every participant by migration 0026 and incremented when the
  // cleanup fences active -> deleting. It cascades with that exact owner.
  community_analytical_input_versions: [1, 1],
  input_versions: [0, 1],
  // Migration 0014 appends one bounded source digest for admitted v1.2 data.
  // This row is owner-scoped and cascades with the participant.
  input_source_digests: [0, 1],
  current_queue: [0, 1],
  telemetry_transport_participant_floors: [0, 1],
  telemetry_transport_device_floors: [0, 1],
} as const);

function fail(code: SyntheticPostgresOwnerErasureCode): never {
  throw new SyntheticPostgresOwnerErasureError(code);
}

function preserveSafeError(error: unknown): Error | null {
  return error instanceof SyntheticPostgresOwnerErasureError ? error : null;
}

function table(schema: string, name: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(name)}`;
}

function parseRows<Row extends object>(value: unknown): readonly Row[] {
  if (value === null || typeof value !== "object") {
    fail("SYNTHETIC_OWNER_ERASURE_READBACK_FAILED");
  }
  const rows = Reflect.get(value, "rows");
  if (!Array.isArray(rows)) fail("SYNTHETIC_OWNER_ERASURE_READBACK_FAILED");
  return rows as readonly Row[];
}

function parseCount(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail("SYNTHETIC_OWNER_ERASURE_READBACK_FAILED");
  }
  return number;
}

function stableOperationId(participantDigest: string): string {
  const source = participantDigest.slice(0, 32).split("");
  source[12] = "4";
  source[16] = ((Number.parseInt(source[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = source.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function makeReceiptDetails(
  ownerDigest: string,
  phase: ReceiptDetails["phase"],
  objectCount: number,
): ReceiptDetails {
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA,
    phase,
    ownerDigest,
    objectCount,
  });
}

function readReceiptDetails(row: ReceiptRow): ReceiptDetails | null {
  let parsed: unknown;
  try { parsed = JSON.parse(row.details_json); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const phase = Reflect.get(parsed, "phase");
  const ownerDigest = Reflect.get(parsed, "ownerDigest");
  const objectCount = Reflect.get(parsed, "objectCount");
  if (Reflect.get(parsed, "schemaVersion") !== RECEIPT_SCHEMA
      || !DIGEST.test(ownerDigest ?? "")
      || !Number.isSafeInteger(objectCount) || objectCount < 0
      || !["fenced", "pending_unattributed", "object_delete_retry", "objects_deleted", "completed"].includes(phase)) {
    return null;
  }
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA,
    phase: phase as ReceiptDetails["phase"],
    ownerDigest,
    objectCount,
  });
}

async function readReceipt(
  ledgerPool: PostgresPool,
  ledgerSchema: string,
  operationId: string,
): Promise<ReceiptRow | null> {
  try {
    return await withPostgresRead(ledgerPool, async (client) => {
      const rows = parseRows<ReceiptRow>(await client.query(
        `SELECT operation_id, participant_digest, outcome, details_json
           FROM ${table(ledgerSchema, "participant_erasure_receipts")}
          WHERE operation_id = $1 LIMIT 1`,
        [operationId],
      ));
      if (rows.length > 1) fail("SYNTHETIC_OWNER_ERASURE_LEDGER_FAILED");
      return rows[0] ?? null;
    }, { ...MIGRATION_TIMEOUTS, operation: "postgres.owner_erasure.receipt_read" });
  } catch (error) {
    if (error instanceof SyntheticPostgresOwnerErasureError) throw error;
    fail("SYNTHETIC_OWNER_ERASURE_LEDGER_FAILED");
  }
}

async function writeReceipt(
  ledgerPool: PostgresPool,
  ledgerSchema: string,
  operationId: string,
  participantDigest: string,
  outcome: ReceiptRow["outcome"],
  details: ReceiptDetails,
): Promise<void> {
  try {
    await withPostgresMutation(ledgerPool, async (client) => {
      const result = await client.query(
        `INSERT INTO ${table(ledgerSchema, "participant_erasure_receipts")} (
           operation_id, participant_digest, outcome, details_json, created_at, completed_at
         ) VALUES ($1, $2, $3, $4, clock_timestamp(),
                   CASE WHEN $3 = 'completed' THEN clock_timestamp() ELSE NULL END)
         ON CONFLICT (operation_id) DO UPDATE SET
           outcome = EXCLUDED.outcome,
           details_json = EXCLUDED.details_json,
           completed_at = EXCLUDED.completed_at
         WHERE participant_erasure_receipts.participant_digest = EXCLUDED.participant_digest
           AND participant_erasure_receipts.outcome <> 'completed'
         RETURNING operation_id`,
        [operationId, participantDigest, outcome, JSON.stringify(details)],
      );
      const rows = parseRows<{ readonly operation_id: string }>(result);
      if (rows.length === 0 && outcome !== "completed") {
        const existing = await client.query(
          `SELECT operation_id, participant_digest, outcome
             FROM ${table(ledgerSchema, "participant_erasure_receipts")}
            WHERE operation_id = $1 LIMIT 1`,
          [operationId],
        );
        const current = parseRows<{ readonly operation_id: string; readonly participant_digest: string; readonly outcome: string }>(existing)[0];
        if (current?.participant_digest === participantDigest && current.outcome === "completed") return;
      }
      if (rows.length !== 1 && outcome !== "completed") fail("SYNTHETIC_OWNER_ERASURE_LEDGER_FAILED");
      if (outcome === "completed" && rows.length === 0) {
        const existing = await client.query(
          `SELECT operation_id, participant_digest, outcome, details_json
             FROM ${table(ledgerSchema, "participant_erasure_receipts")}
            WHERE operation_id = $1 LIMIT 1`,
          [operationId],
        );
        const current = parseRows<ReceiptRow>(existing)[0];
        if (current?.participant_digest !== participantDigest || current.outcome !== "completed") {
          fail("SYNTHETIC_OWNER_ERASURE_LEDGER_FAILED");
        }
      }
    }, {
      ...MIGRATION_TIMEOUTS,
      operation: "postgres.owner_erasure.receipt_write",
      preserveSafeError,
    });
  } catch (error) {
    if (error instanceof SyntheticPostgresOwnerErasureError) throw error;
    fail("SYNTHETIC_OWNER_ERASURE_LEDGER_FAILED");
  }
}

async function validateParticipantFamily(
  client: PostgresClient,
  primarySchema: string,
  participantId: string,
): Promise<void> {
  const catalog = parseRows<{ readonly table_name: string }>(await client.query(
    `SELECT DISTINCT columns.table_name
       FROM information_schema.columns columns
       JOIN information_schema.tables tables
         ON tables.table_schema = columns.table_schema
        AND tables.table_name = columns.table_name
        AND tables.table_type = 'BASE TABLE'
      WHERE columns.table_schema = $1 AND columns.column_name = 'participant_id'
      ORDER BY columns.table_name`,
    [primarySchema],
  ));
  const names = catalog.map((row) => row.table_name);
  if (names.some((name) => typeof name !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/u.test(name))) {
    fail("SYNTHETIC_OWNER_ERASURE_FAMILY_UNSUPPORTED");
  }
  const required = [
    "attribution_enrollments", "web_sessions", "device_pairings", "device_credentials",
    "device_upload_authorizations", "telemetry_v12_device_capabilities",
    "telemetry_v12_day_manifests", "telemetry_v12_chunks", "storage_v11_owner_links",
  ];
  if (required.some((name) => !names.includes(name))) {
    fail("SYNTHETIC_OWNER_ERASURE_FAMILY_UNSUPPORTED");
  }
  const countsSql = names.map((name) =>
    `SELECT '${name}'::text AS table_name, count(*)::text AS row_count FROM ${table(primarySchema, name)} WHERE participant_id = $1`,
  ).join(" UNION ALL ");
  const rows = parseRows<{ readonly table_name: string; readonly row_count: string | number }>(
    await client.query(countsSql, [participantId]),
  );
  if (rows.length !== names.length) fail("SYNTHETIC_OWNER_ERASURE_FAMILY_UNSUPPORTED");
  for (const row of rows) {
    const count = parseCount(row.row_count);
    const limit = Object.hasOwn(ALLOWED_PARTICIPANT_TABLES, row.table_name)
      ? ALLOWED_PARTICIPANT_TABLES[row.table_name as keyof typeof ALLOWED_PARTICIPANT_TABLES]
      : [0, 0];
    if (count < limit[0] || count > limit[1]) {
      fail("SYNTHETIC_OWNER_ERASURE_FAMILY_UNSUPPORTED");
    }
  }
}

async function readChunkReferences(
  client: PostgresClient,
  primarySchema: string,
  participantId: string,
): Promise<readonly StoredRef[]> {
  const chunks = parseRows<ChunkRow>(await client.query(
    `SELECT id, r2_key, created_at
       FROM ${table(primarySchema, "telemetry_v12_chunks")}
      WHERE participant_id = $1 ORDER BY id FOR UPDATE`,
    [participantId],
  ));
  if (chunks.length > 1) fail("SYNTHETIC_OWNER_ERASURE_FAMILY_UNSUPPORTED");
  const refs: StoredRef[] = [];
  for (const chunk of chunks) {
    if (!OBJECT_ID.test(chunk.id) || typeof chunk.r2_key !== "string"
        || chunk.r2_key.length === 0 || chunk.r2_key.length > 1024) {
      fail("SYNTHETIC_OWNER_ERASURE_REFERENCE_MISMATCH");
    }
    const pendingRows = parseRows<PendingRow>(await client.query(
      `SELECT contribution_id, object_key, object_kind, reconciliation_state, registration_token
         FROM ${table(primarySchema, "pending_objects")}
        WHERE contribution_id = $1 FOR UPDATE`,
      [chunk.id],
    ));
    const pending = pendingRows[0];
    if (pendingRows.length !== 1 || pending?.contribution_id !== chunk.id
        || pending.object_key !== chunk.r2_key || pending.object_kind !== "telemetry_v12"
        || !/^[0-9a-f]{32}$/u.test(pending.registration_token)) {
      fail("SYNTHETIC_OWNER_ERASURE_REFERENCE_MISMATCH");
    }
    if (pending.reconciliation_state !== "registered") {
      fail("SYNTHETIC_OWNER_ERASURE_REFERENCE_MISMATCH");
    }
    const createdAt = chunk.created_at instanceof Date
      ? chunk.created_at.toISOString()
      : new Date(chunk.created_at).toISOString();
    if (!Number.isFinite(Date.parse(createdAt))) fail("SYNTHETIC_OWNER_ERASURE_REFERENCE_MISMATCH");
    refs.push(Object.freeze({
      source: "telemetry_v12",
      id: chunk.id,
      key: chunk.r2_key,
      createdAt,
      // PostgreSQL stores the exact opaque key, but not a GCS generation. The
      // GCS erasure adapter enumerates and verifies every generation for this
      // exact DB-referenced key before it reports success.
      version: null,
      registrationToken: pending.registration_token,
    }));
  }
  return Object.freeze(refs);
}

async function hasUnattributedV12PendingObject(
  client: PostgresClient,
  primarySchema: string,
): Promise<boolean> {
  const rows = parseRows<{ readonly orphan_count: string | number }>(await client.query(
    `SELECT count(*)::text AS orphan_count
       FROM ${table(primarySchema, "pending_objects")} pending
      WHERE pending.object_kind = 'telemetry_v12'
        AND NOT EXISTS (
          SELECT 1 FROM ${table(primarySchema, "telemetry_v12_chunks")} chunk
           WHERE chunk.id = pending.contribution_id AND chunk.r2_key = pending.object_key
        )`,
  ));
  if (rows.length !== 1) fail("SYNTHETIC_OWNER_ERASURE_READBACK_FAILED");
  return parseCount(rows[0]?.orphan_count) > 0;
}

interface FencedSnapshot {
  readonly absent: boolean;
  readonly ownerDigest: string | null;
  readonly refs: readonly StoredRef[];
  readonly unattributed: boolean;
}

async function fenceAndRead(
  primaryPool: PostgresPool,
  primarySchema: string,
  participantId: string,
  fenceId: string,
): Promise<FencedSnapshot> {
  try {
    return await withPostgresMutation(primaryPool, async (client) => {
      const participantRows = parseRows<ParticipantRow>(await client.query(
        `SELECT id, state, owner_kind, deletion_session_id, identity_link_key
           FROM ${table(primarySchema, "participants")}
          WHERE id = $1 FOR UPDATE`,
        [participantId],
      ));
      const participant = participantRows[0];
      if (participantRows.length === 0) {
        return Object.freeze({ absent: true, ownerDigest: null, refs: Object.freeze([]), unattributed: false });
      }
      if (participantRows.length !== 1 || participant === undefined || participant.owner_kind !== "social"
          || participant.identity_link_key !== null
          || participant.state !== "active" && participant.state !== "deleting"
          || participant.state === "deleting" && participant.deletion_session_id !== fenceId) {
        fail("SYNTHETIC_OWNER_ERASURE_STATE_UNEXPECTED");
      }
      await validateParticipantFamily(client, primarySchema, participantId);
      const ownerRows = parseRows<OwnerLinkRow>(await client.query(
        `SELECT owner_digest, state
           FROM ${table(primarySchema, "storage_v11_owner_links")}
          WHERE participant_id = $1 FOR UPDATE`,
        [participantId],
      ));
      const owner = ownerRows[0];
      if (ownerRows.length !== 1 || owner === undefined
          || !DIGEST.test(owner.owner_digest) || owner.state !== "active") {
        fail("SYNTHETIC_OWNER_ERASURE_STATE_UNEXPECTED");
      }
      const consuming = parseRows<{ readonly count: string | number }>(await client.query(
        `SELECT count(*)::text AS count FROM ${table(primarySchema, "device_upload_authorizations")}
          WHERE participant_id = $1 AND state = 'consuming'`,
        [participantId],
      ));
      if (consuming.length !== 1 || parseCount(consuming[0]?.count) !== 0) {
        fail("SYNTHETIC_OWNER_ERASURE_UPLOAD_IN_PROGRESS");
      }
      const manifestRows = parseRows<{ readonly count: string | number }>(await client.query(
        `SELECT count(*)::text AS count FROM ${table(primarySchema, "telemetry_v12_day_manifests")}
          WHERE participant_id = $1`,
        [participantId],
      ));
      const refs = await readChunkReferences(client, primarySchema, participantId);
      if (parseCount(manifestRows[0]?.count) > 1 || refs.length > 1
          || refs.length === 1 && parseCount(manifestRows[0]?.count) !== 1) {
        fail("SYNTHETIC_OWNER_ERASURE_FAMILY_UNSUPPORTED");
      }
      if (participant.state === "active") {
        await client.query(
          `UPDATE ${table(primarySchema, "participants")}
              SET state = 'deleting', deletion_session_id = $2
            WHERE id = $1 AND state = 'active'`,
          [participantId, fenceId],
        );
      }
      await client.query(
        `UPDATE ${table(primarySchema, "web_sessions")}
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, clock_timestamp())
          WHERE participant_id = $1 AND state = 'active'`,
        [participantId],
      );
      await client.query(
        `UPDATE ${table(primarySchema, "device_pairings")}
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, clock_timestamp())
          WHERE participant_id = $1 AND state = 'unused'`,
        [participantId],
      );
      await client.query(
        `UPDATE ${table(primarySchema, "device_credentials")}
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, clock_timestamp())
          WHERE participant_id = $1 AND state = 'active'`,
        [participantId],
      );
      await client.query(
        `UPDATE ${table(primarySchema, "device_upload_authorizations")}
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, clock_timestamp())
          WHERE participant_id = $1 AND state = 'unused'`,
        [participantId],
      );
      await client.query(
        `UPDATE ${table(primarySchema, "telemetry_v12_device_capabilities")}
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, clock_timestamp())
          WHERE participant_id = $1 AND state = 'accepted'`,
        [participantId],
      );
      return Object.freeze({
        absent: false,
        ownerDigest: owner.owner_digest,
        refs,
        unattributed: await hasUnattributedV12PendingObject(client, primarySchema),
      });
    }, {
      ...MIGRATION_TIMEOUTS,
      operation: "postgres.owner_erasure.fence",
      preserveSafeError,
    });
  } catch (error) {
    if (error instanceof SyntheticPostgresOwnerErasureError) throw error;
    fail("SYNTHETIC_OWNER_ERASURE_READBACK_FAILED");
  }
}

async function finishPrimaryDelete(
  primaryPool: PostgresPool,
  primarySchema: string,
  participantId: string,
  fenceId: string,
  ownerDigest: string,
  refs: readonly StoredRef[],
): Promise<void> {
  try {
    await withPostgresMutation(primaryPool, async (client) => {
      const participantRows = parseRows<ParticipantRow>(await client.query(
        `SELECT id, state, owner_kind, deletion_session_id, identity_link_key
           FROM ${table(primarySchema, "participants")}
          WHERE id = $1 FOR UPDATE`,
        [participantId],
      ));
      if (participantRows.length !== 1 || participantRows[0]?.state !== "deleting"
          || participantRows[0]?.deletion_session_id !== fenceId
          || participantRows[0]?.owner_kind !== "social"
          || participantRows[0]?.identity_link_key !== null) {
        fail("SYNTHETIC_OWNER_ERASURE_STATE_UNEXPECTED");
      }
      const ownerRows = parseRows<OwnerLinkRow>(await client.query(
        `SELECT owner_digest, state FROM ${table(primarySchema, "storage_v11_owner_links")}
          WHERE participant_id = $1 FOR UPDATE`,
        [participantId],
      ));
      if (ownerRows.length !== 1 || ownerRows[0]?.owner_digest !== ownerDigest
          || ownerRows[0]?.state !== "active") {
        fail("SYNTHETIC_OWNER_ERASURE_STATE_UNEXPECTED");
      }
      const currentRefs = await readChunkReferences(client, primarySchema, participantId);
      if (currentRefs.length !== refs.length || currentRefs.some((current, index) =>
        current.id !== refs[index]?.id || current.key !== refs[index]?.key
          || current.registrationToken !== refs[index]?.registrationToken)) {
        fail("SYNTHETIC_OWNER_ERASURE_REFERENCE_MISMATCH");
      }
      for (const ref of refs) {
        const deleted = await client.query(
          `DELETE FROM ${table(primarySchema, "pending_objects")}
            WHERE contribution_id = $1 AND object_key = $2 AND object_kind = 'telemetry_v12'
              AND reconciliation_state = 'registered' AND registration_token = $3`,
          [ref.id, ref.key, ref.registrationToken],
        );
        if (deleted.rowCount !== 1) fail("SYNTHETIC_OWNER_ERASURE_REFERENCE_MISMATCH");
      }
      const deleted = await client.query(
        `DELETE FROM ${table(primarySchema, "participants")}
          WHERE id = $1 AND state = 'deleting' AND deletion_session_id = $2`,
        [participantId, fenceId],
      );
      if (deleted.rowCount !== 1) fail("SYNTHETIC_OWNER_ERASURE_STATE_UNEXPECTED");
      const proofRows = parseRows<{ readonly owner_digest: string }>(await client.query(
        `SELECT owner_digest FROM ${table(primarySchema, "storage_owner_erasure_receipts")}
          WHERE owner_digest = $1`,
        [ownerDigest],
      ));
      if (proofRows.length !== 1 || proofRows[0]?.owner_digest !== ownerDigest) {
        fail("SYNTHETIC_OWNER_ERASURE_READBACK_FAILED");
      }
    }, {
      ...MIGRATION_TIMEOUTS,
      operation: "postgres.owner_erasure.delete",
      preserveSafeError,
    });
  } catch (error) {
    if (error instanceof SyntheticPostgresOwnerErasureError) throw error;
    fail("SYNTHETIC_OWNER_ERASURE_READBACK_FAILED");
  }
}

async function verifyPrimaryCompletion(
  primaryPool: PostgresPool,
  primarySchema: string,
  participantId: string,
  ownerDigest: string,
): Promise<boolean> {
  try {
    return await withPostgresRead(primaryPool, async (client) => {
      const participants = parseRows<{ readonly id: string }>(await client.query(
        `SELECT id FROM ${table(primarySchema, "participants")} WHERE id = $1 LIMIT 1`,
        [participantId],
      ));
      const receipts = parseRows<{ readonly owner_digest: string }>(await client.query(
        `SELECT owner_digest FROM ${table(primarySchema, "storage_owner_erasure_receipts")}
          WHERE owner_digest = $1 LIMIT 1`,
        [ownerDigest],
      ));
      return participants.length === 0 && receipts.length === 1
        && receipts[0]?.owner_digest === ownerDigest;
    }, { ...MIGRATION_TIMEOUTS, operation: "postgres.owner_erasure.verify" });
  } catch (error) {
    if (error instanceof SyntheticPostgresOwnerErasureError) throw error;
    fail("SYNTHETIC_OWNER_ERASURE_READBACK_FAILED");
  }
}

async function incomplete(
  ledgerPool: PostgresPool,
  ledgerSchema: string,
  operationId: string,
  participantDigest: string,
  ownerDigest: string,
  phase: ReceiptDetails["phase"],
  objectCount: number,
  code: SyntheticPostgresOwnerErasureCode,
): Promise<SyntheticPostgresOwnerErasureResult> {
  await writeReceipt(
    ledgerPool,
    ledgerSchema,
    operationId,
    participantDigest,
    "failed",
    makeReceiptDetails(ownerDigest, phase, objectCount),
  );
  return Object.freeze({ status: "incomplete", code });
}

/**
 * Erase one explicitly supplied synthetic v1.2 smoke participant. This is an
 * operational test adapter, not an API route: every target is pinned by its
 * caller and the adapter refuses all other owner families. Primary and ledger
 * commits are separate; durable digests plus the primary migration-0029 owner
 * receipt make interrupted retries verifiable.
 */
export async function eraseSyntheticPostgresV12Owner(
  options: SyntheticPostgresOwnerErasureOptions,
): Promise<SyntheticPostgresOwnerErasureResult> {
  if (!SYNTHETIC_PARTICIPANT.test(options?.participantId ?? "")
      || options.primaryPool === options.ledgerPool
      || typeof options.primaryPool?.connect !== "function"
      || typeof options.ledgerPool?.connect !== "function"
      || typeof options.objectStore?.deleteBatch !== "function") {
    fail("SYNTHETIC_OWNER_ERASURE_TARGET_INVALID");
  }
  let schemas;
  try { schemas = createPostgresSchemaConfig(options.schema); } catch {
    fail("SYNTHETIC_OWNER_ERASURE_TARGET_INVALID");
  }
  const participantDigest = await participantDeletionDigest(options.participantId);
  const operationId = stableOperationId(participantDigest);
  const fenceId = operationId;
  const priorReceipt = await readReceipt(options.ledgerPool, schemas.ledgerSchema, operationId);
  if (priorReceipt !== null && priorReceipt.participant_digest !== participantDigest) {
    fail("SYNTHETIC_OWNER_ERASURE_LEDGER_FAILED");
  }
  const priorDetails = priorReceipt === null ? null : readReceiptDetails(priorReceipt);
  if (priorReceipt !== null && priorDetails === null) fail("SYNTHETIC_OWNER_ERASURE_LEDGER_FAILED");

  const snapshot = await fenceAndRead(
    options.primaryPool,
    schemas.primarySchema,
    options.participantId,
    fenceId,
  );
  if (snapshot.absent) {
    if (priorReceipt === null || priorDetails === null
        || !["objects_deleted", "completed"].includes(priorDetails.phase)
        || !await hasPostgresDeletionTombstone(
          options.ledgerPool, options.participantId, Date.now(), { schema: schemas },
        )
        || !await verifyPrimaryCompletion(
          options.primaryPool, schemas.primarySchema, options.participantId, priorDetails.ownerDigest,
        )) {
      fail("SYNTHETIC_OWNER_ERASURE_PARTICIPANT_NOT_FOUND");
    }
    if (priorReceipt.outcome !== "completed") {
      await writeReceipt(
        options.ledgerPool,
        schemas.ledgerSchema,
        operationId,
        participantDigest,
        "completed",
        makeReceiptDetails(priorDetails.ownerDigest, "completed", priorDetails.objectCount),
      );
    }
    return Object.freeze({ status: "already_complete", objectsDeleted: priorDetails.objectCount });
  }

  const ownerDigest = snapshot.ownerDigest;
  if (ownerDigest === null || priorDetails !== null && priorDetails.ownerDigest !== ownerDigest) {
    fail("SYNTHETIC_OWNER_ERASURE_LEDGER_FAILED");
  }
  if (priorReceipt?.outcome === "completed") fail("SYNTHETIC_OWNER_ERASURE_STATE_UNEXPECTED");

  await recordPostgresDeletionTombstone(options.ledgerPool, options.participantId, Date.now(), { schema: schemas });
  await writeReceipt(
    options.ledgerPool,
    schemas.ledgerSchema,
    operationId,
    participantDigest,
    "started",
    makeReceiptDetails(ownerDigest, "fenced", snapshot.refs.length),
  );
  if (snapshot.unattributed) {
    return incomplete(
      options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
      ownerDigest, "pending_unattributed", snapshot.refs.length,
      "SYNTHETIC_OWNER_ERASURE_PENDING_UNATTRIBUTED",
    );
  }

  try {
    await options.objectStore.deleteBatch(snapshot.refs.map(({ registrationToken: _token, ...ref }) => ref));
  } catch {
    return incomplete(
      options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
      ownerDigest, "object_delete_retry", snapshot.refs.length,
      "SYNTHETIC_OWNER_ERASURE_OBJECT_STORE_FAILED",
    );
  }
  await writeReceipt(
    options.ledgerPool,
    schemas.ledgerSchema,
    operationId,
    participantDigest,
    "started",
    makeReceiptDetails(ownerDigest, "objects_deleted", snapshot.refs.length),
  );

  try {
    await finishPrimaryDelete(
      options.primaryPool,
      schemas.primarySchema,
      options.participantId,
      fenceId,
      ownerDigest,
      snapshot.refs,
    );
  } catch (error) {
    if (error instanceof SyntheticPostgresOwnerErasureError) {
      return incomplete(
        options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
        ownerDigest, "objects_deleted", snapshot.refs.length, error.code,
      );
    }
    throw error;
  }
  if (!await verifyPrimaryCompletion(
    options.primaryPool, schemas.primarySchema, options.participantId, ownerDigest,
  )) {
    return incomplete(
      options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
      ownerDigest, "objects_deleted", snapshot.refs.length,
      "SYNTHETIC_OWNER_ERASURE_READBACK_FAILED",
    );
  }
  await writeReceipt(
    options.ledgerPool,
    schemas.ledgerSchema,
    operationId,
    participantDigest,
    "completed",
    makeReceiptDetails(ownerDigest, "completed", snapshot.refs.length),
  );
  return Object.freeze({ status: "complete", objectsDeleted: snapshot.refs.length });
}
