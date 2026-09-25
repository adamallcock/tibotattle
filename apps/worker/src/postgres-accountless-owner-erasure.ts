import { sha256Hex } from "./crypto";
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
import {
  PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT,
  type ParticipantErasureObjectRef,
  type ParticipantErasureObjectStore,
} from "./erasure-object-store";

const ACCOUNTLESS_PARTICIPANT = /^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const TOKEN = /^[0-9a-f]{32}$/u;
const RECEIPT_SCHEMA = "postgres-accountless-owner-erasure-v1";
const OPERATION_DOMAIN = "app-usagemonitor/postgres-accountless-owner-erasure/v1\0";
const TIMEOUTS = Object.freeze({
  operation: "postgres.accountless_owner_erasure",
  statementTimeoutMilliseconds: 10_000,
  lockTimeoutMilliseconds: 5_000,
});

export type PostgresAccountlessOwnerErasureCode =
  | "ACCOUNTLESS_OWNER_ERASURE_TARGET_INVALID"
  | "ACCOUNTLESS_OWNER_ERASURE_PARTICIPANT_NOT_FOUND"
  | "ACCOUNTLESS_OWNER_ERASURE_STATE_UNEXPECTED"
  | "ACCOUNTLESS_OWNER_ERASURE_FAMILY_UNSUPPORTED"
  | "ACCOUNTLESS_OWNER_ERASURE_UPLOAD_IN_PROGRESS"
  | "ACCOUNTLESS_OWNER_ERASURE_REFERENCE_MISMATCH"
  | "ACCOUNTLESS_OWNER_ERASURE_PENDING_UNATTRIBUTED"
  | "ACCOUNTLESS_OWNER_ERASURE_OBJECT_STORE_FAILED"
  | "ACCOUNTLESS_OWNER_ERASURE_LEDGER_FAILED"
  | "ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED";

export class PostgresAccountlessOwnerErasureError extends Error {
  readonly code: PostgresAccountlessOwnerErasureCode;

  constructor(code: PostgresAccountlessOwnerErasureCode) {
    super(code);
    this.name = "PostgresAccountlessOwnerErasureError";
    this.code = code;
  }
}

export interface PostgresAccountlessOwnerErasureOptions {
  readonly primaryPool: PostgresPool;
  readonly ledgerPool: PostgresPool;
  readonly objectStore: ParticipantErasureObjectStore;
  readonly participantId: string;
  readonly schema?: PostgresSchemaOptions;
}

export type PostgresAccountlessOwnerErasureResult =
  | { readonly status: "complete" | "already_complete"; readonly objectsDeleted: number }
  | { readonly status: "incomplete"; readonly code: PostgresAccountlessOwnerErasureCode };

interface ParticipantRow {
  readonly id: string;
  readonly state: string;
  readonly owner_kind: string;
  readonly deletion_session_id: string | null;
  readonly identity_link_key: string | null;
}

interface OwnerRow {
  readonly enrollment_device_id: string;
  readonly participant_id: string;
  readonly device_credential_id: string;
  readonly owner_state: string;
  readonly owner_revocation_reason: string | null;
  readonly device_state: string;
  readonly authority_kind: string;
  readonly paired_via_pairing_id: string | null;
  readonly device_enrollment_device_id: string | null;
  readonly social_verified_at: Date | string | null;
  readonly enrollment_state: string;
  readonly owner_digest: string;
  readonly owner_link_state: string;
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

interface ObjectInventoryRow {
  readonly source: "telemetry_v1" | "telemetry_v11" | "telemetry_v12";
  readonly ref_id: string;
  readonly cursor_id: string;
  readonly object_key: string;
  readonly created_at: string;
  readonly object_kind: string | null;
  readonly reconciliation_state: string | null;
  readonly registration_token: string | null;
}

interface StoredRef extends ParticipantErasureObjectRef {
  readonly registrationToken: string | null;
}

interface Cursor {
  readonly source: ObjectInventoryRow["source"];
  readonly refId: string;
}

interface FencedSnapshot {
  readonly absent: boolean;
  readonly ownerDigest: string | null;
  readonly enrollmentDeviceId: string | null;
}

// This is the complete current owner-scoped table set on migrations through
// 0041. It is a fail-closed schema fence: adding a participant-owned table
// requires reviewing whether it contains an external object or an accountless
// authority edge before this eraser can proceed.
const ACCOUNTLESS_PARTICIPANT_TABLES = new Set(`
  accountless_public_history_retention accountless_upload_owners accountless_v11_device_authorizations
  accountless_v12_device_authorizations attribution_enrollments community_analytical_input_versions
  community_model_history_dependencies current_queue device_credential_rotations device_credentials
  device_pairing_events device_pairings device_upload_authorizations historical_telemetry_v11_chunk_headers
  historical_telemetry_v11_manifest_headers historical_telemetry_v1_chunk_headers identity_reenrollment_cooldowns
  input_source_digests input_versions participant_community_eligibility prepared_source_days recovery_retry_receipts
  storage_v11_event_sources storage_v11_owner_links telemetry_additive_correction_facts
  telemetry_additive_correction_receipts telemetry_contribution_occurrences telemetry_contributions
  telemetry_correction_receipts telemetry_records telemetry_transport_device_floors
  telemetry_transport_floor_rollbacks telemetry_transport_participant_floors telemetry_usage_correction_history
  telemetry_v11_chunks telemetry_v11_day_manifests telemetry_v11_device_consents telemetry_v11_domain_heads
  telemetry_v11_domain_predecessors telemetry_v11_domains telemetry_v12_chunks telemetry_v12_day_manifests
  telemetry_v12_device_capabilities telemetry_v12_domain_heads telemetry_v12_domain_predecessors
  telemetry_v12_domains telemetry_v1_chunk_admission_windows telemetry_v1_chunks telemetry_v1_device_consents
  telemetry_v1_quota_fit_rows telemetry_v1_records typed_telemetry_owner_memberships typed_v1_event_sources
  upload_authorizations web_sessions
`.trim().split(/\s+/u));

function fail(code: PostgresAccountlessOwnerErasureCode): never {
  throw new PostgresAccountlessOwnerErasureError(code);
}

function preserveSafeError(error: unknown): Error | null {
  return error instanceof PostgresAccountlessOwnerErasureError ? error : null;
}

function table(schema: string, name: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(name)}`;
}

function parseRows<Row extends object>(value: unknown): readonly Row[] {
  if (value === null || typeof value !== "object") fail("ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED");
  const rows = Reflect.get(value, "rows");
  if (!Array.isArray(rows)) fail("ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED");
  return rows as readonly Row[];
}

function parseCount(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail("ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED");
  return number;
}

async function operationIdFor(participantDigest: string): Promise<string> {
  const hex = (await sha256Hex(`${OPERATION_DOMAIN}${participantDigest}`)).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function details(ownerDigest: string, phase: ReceiptDetails["phase"], objectCount: number): ReceiptDetails {
  return Object.freeze({ schemaVersion: RECEIPT_SCHEMA, phase, ownerDigest, objectCount });
}

function parseDetails(row: ReceiptRow): ReceiptDetails | null {
  let value: unknown;
  try { value = JSON.parse(row.details_json); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const phase = Reflect.get(value, "phase");
  const ownerDigest = Reflect.get(value, "ownerDigest");
  const objectCount = Reflect.get(value, "objectCount");
  if (Reflect.get(value, "schemaVersion") !== RECEIPT_SCHEMA
      || typeof ownerDigest !== "string" || !DIGEST.test(ownerDigest)
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

async function readReceipt(ledgerPool: PostgresPool, ledgerSchema: string, operationId: string): Promise<ReceiptRow | null> {
  try {
    return await withPostgresRead(ledgerPool, async (client) => {
      const rows = parseRows<ReceiptRow>(await client.query(
        `SELECT operation_id, participant_digest, outcome, details_json
           FROM ${table(ledgerSchema, "participant_erasure_receipts")}
          WHERE operation_id=$1 LIMIT 1`,
        [operationId],
      ));
      if (rows.length > 1) fail("ACCOUNTLESS_OWNER_ERASURE_LEDGER_FAILED");
      return rows[0] ?? null;
    }, { ...TIMEOUTS, operation: "postgres.accountless_owner_erasure.receipt_read" });
  } catch (error) {
    if (error instanceof PostgresAccountlessOwnerErasureError) throw error;
    fail("ACCOUNTLESS_OWNER_ERASURE_LEDGER_FAILED");
  }
}

async function writeReceipt(
  ledgerPool: PostgresPool,
  ledgerSchema: string,
  operationId: string,
  participantDigest: string,
  outcome: ReceiptRow["outcome"],
  receiptDetails: ReceiptDetails,
): Promise<void> {
  try {
    await withPostgresMutation(ledgerPool, async (client) => {
      const result = await client.query(
        `INSERT INTO ${table(ledgerSchema, "participant_erasure_receipts")} (
           operation_id, participant_digest, outcome, details_json, created_at, completed_at
         ) VALUES ($1,$2,$3,$4,clock_timestamp(),CASE WHEN $3='completed' THEN clock_timestamp() ELSE NULL END)
         ON CONFLICT (operation_id) DO UPDATE SET
           outcome=EXCLUDED.outcome, details_json=EXCLUDED.details_json, completed_at=EXCLUDED.completed_at
         WHERE participant_erasure_receipts.participant_digest=EXCLUDED.participant_digest
           AND participant_erasure_receipts.outcome <> 'completed'
         RETURNING operation_id`,
        [operationId, participantDigest, outcome, JSON.stringify(receiptDetails)],
      );
      const rows = parseRows<{ readonly operation_id: string }>(result);
      if (rows.length === 1) return;
      const existing = parseRows<ReceiptRow>(await client.query(
        `SELECT operation_id, participant_digest, outcome, details_json
           FROM ${table(ledgerSchema, "participant_erasure_receipts")}
          WHERE operation_id=$1 LIMIT 1`,
        [operationId],
      ))[0];
      if (existing?.participant_digest !== participantDigest
          || existing.outcome !== "completed") fail("ACCOUNTLESS_OWNER_ERASURE_LEDGER_FAILED");
    }, { ...TIMEOUTS, operation: "postgres.accountless_owner_erasure.receipt_write", preserveSafeError });
  } catch (error) {
    if (error instanceof PostgresAccountlessOwnerErasureError) throw error;
    fail("ACCOUNTLESS_OWNER_ERASURE_LEDGER_FAILED");
  }
}

async function assertKnownOwnerTables(client: PostgresClient, primarySchema: string): Promise<void> {
  const rows = parseRows<{ readonly table_name: string }>(await client.query(
    `SELECT DISTINCT columns.table_name
       FROM information_schema.columns columns
       JOIN information_schema.tables tables
         ON tables.table_schema=columns.table_schema AND tables.table_name=columns.table_name
        AND tables.table_type='BASE TABLE'
      WHERE columns.table_schema=$1 AND columns.column_name='participant_id'
      ORDER BY columns.table_name`,
    [primarySchema],
  ));
  if (rows.some((row) => typeof row.table_name !== "string"
      || !ACCOUNTLESS_PARTICIPANT_TABLES.has(row.table_name))) {
    fail("ACCOUNTLESS_OWNER_ERASURE_FAMILY_UNSUPPORTED");
  }
}

async function readOwner(
  client: PostgresClient,
  primarySchema: string,
  participantId: string,
): Promise<{ readonly owner: OwnerRow; readonly markerCount: number }> {
  const rows = parseRows<OwnerRow>(await client.query(
    `SELECT owner.enrollment_device_id, owner.participant_id, owner.device_credential_id,
            owner.state AS owner_state, owner.revocation_reason AS owner_revocation_reason,
            device.state AS device_state, device.authority_kind, device.paired_via_pairing_id,
            device.accountless_enrollment_device_id AS device_enrollment_device_id,
            device.social_verified_at,
            ledger.state AS enrollment_state, owner_link.owner_digest, owner_link.state AS owner_link_state
       FROM ${table(primarySchema, "accountless_upload_owners")} owner
       JOIN ${table(primarySchema, "accountless_enrollment_ledger")} ledger
         ON ledger.device_id=owner.enrollment_device_id
       JOIN ${table(primarySchema, "device_credentials")} device
         ON device.id=owner.device_credential_id
       JOIN ${table(primarySchema, "storage_v11_owner_links")} owner_link
         ON owner_link.participant_id=owner.participant_id
      WHERE owner.participant_id=$1
      FOR UPDATE OF owner, ledger, device, owner_link`,
    [participantId],
  ));
  if (rows.length !== 1) fail("ACCOUNTLESS_OWNER_ERASURE_STATE_UNEXPECTED");
  const owner = rows[0]!;
  if (owner.participant_id !== participantId
      || owner.enrollment_device_id !== owner.device_credential_id
      || owner.device_enrollment_device_id !== owner.enrollment_device_id
      || owner.authority_kind !== "accountless"
      || owner.paired_via_pairing_id !== null
      || owner.social_verified_at !== null
      || !DIGEST.test(owner.owner_digest)
      || !["active", "revoked"].includes(owner.owner_state)
      || !["active", "revoked"].includes(owner.device_state)
      || !["active", "revoked"].includes(owner.enrollment_state)
      || !["active", "withdrawn"].includes(owner.owner_link_state)) {
    fail("ACCOUNTLESS_OWNER_ERASURE_STATE_UNEXPECTED");
  }
  const credentials = parseRows<{ readonly id: string }>(await client.query(
    `SELECT id FROM ${table(primarySchema, "device_credentials")}
      WHERE participant_id=$1 ORDER BY id FOR UPDATE`,
    [participantId],
  ));
  if (credentials.length !== 1 || credentials[0]?.id !== owner.device_credential_id) {
    fail("ACCOUNTLESS_OWNER_ERASURE_FAMILY_UNSUPPORTED");
  }
  const markers = parseRows<{
    readonly enrollment_device_id: string;
    readonly device_credential_id: string;
    readonly generation_id: string;
    readonly head_revision: number;
  }>(await client.query(
    `SELECT enrollment_device_id, device_credential_id, generation_id, head_revision
       FROM ${table(primarySchema, "accountless_public_history_retention")}
      WHERE participant_id=$1 FOR UPDATE`,
    [participantId],
  ));
  if (markers.length > 1 || markers.some((marker) =>
    marker.enrollment_device_id !== owner.enrollment_device_id
      || marker.device_credential_id !== owner.device_credential_id
      || typeof marker.generation_id !== "string" || !Number.isSafeInteger(marker.head_revision)
      || marker.head_revision < 1)) {
    fail("ACCOUNTLESS_OWNER_ERASURE_STATE_UNEXPECTED");
  }
  return { owner, markerCount: markers.length };
}

async function validateAccountlessGrants(
  client: PostgresClient,
  primarySchema: string,
  participantId: string,
  enrollmentDeviceId: string,
  deviceCredentialId: string,
): Promise<void> {
  const checks = [
    ["accountless_v11_device_authorizations", `SELECT enrollment_device_id, device_credential_id, state
       FROM ${table(primarySchema, "accountless_v11_device_authorizations")} WHERE participant_id=$1 FOR UPDATE`],
    ["accountless_v12_device_authorizations", `SELECT enrollment_device_id, device_credential_id, state
       FROM ${table(primarySchema, "accountless_v12_device_authorizations")} WHERE participant_id=$1 FOR UPDATE`],
  ] as const;
  for (const [_name, sql] of checks) {
    const rows = parseRows<{
      readonly enrollment_device_id: string;
      readonly device_credential_id: string;
      readonly state: string;
    }>(await client.query(sql, [participantId]));
    if (rows.length > 1 || rows.some((row) =>
      row.enrollment_device_id !== enrollmentDeviceId
        || row.device_credential_id !== deviceCredentialId
        || !["active", "revoked"].includes(row.state))) {
      fail("ACCOUNTLESS_OWNER_ERASURE_FAMILY_UNSUPPORTED");
    }
  }
  for (const [name, expectedCount] of [
    ["telemetry_v1_device_consents", 1],
    ["telemetry_v11_device_consents", 1],
    ["telemetry_v12_device_capabilities", 1],
  ] as const) {
    const rows = parseRows<{ readonly device_id: string; readonly state?: string }>(await client.query(
      `SELECT device_id${name === "telemetry_v12_device_capabilities" ? ", state" : ""}
         FROM ${table(primarySchema, name)} WHERE participant_id=$1 FOR UPDATE`,
      [participantId],
    ));
    if (rows.length > expectedCount || rows.some((row) => row.device_id !== deviceCredentialId
        || row.state !== undefined && !["accepted", "revoked"].includes(row.state))) {
      fail("ACCOUNTLESS_OWNER_ERASURE_FAMILY_UNSUPPORTED");
    }
  }
}

async function fenceAndRead(
  primaryPool: PostgresPool,
  primarySchema: string,
  participantId: string,
  fenceId: string,
): Promise<FencedSnapshot> {
  try {
    return await withPostgresMutation(primaryPool, async (client) => {
      const participants = parseRows<ParticipantRow>(await client.query(
        `SELECT id, state, owner_kind, deletion_session_id, identity_link_key
           FROM ${table(primarySchema, "participants")} WHERE id=$1 FOR UPDATE`,
        [participantId],
      ));
      if (participants.length === 0) {
        return Object.freeze({ absent: true, ownerDigest: null, enrollmentDeviceId: null });
      }
      const participant = participants[0]!;
      if (participant.owner_kind !== "accountless" || participant.identity_link_key !== null
          || !["active", "deleting"].includes(participant.state)
          || participant.state === "deleting" && participant.deletion_session_id !== fenceId) {
        fail("ACCOUNTLESS_OWNER_ERASURE_STATE_UNEXPECTED");
      }
      await assertKnownOwnerTables(client, primarySchema);
      const { owner } = await readOwner(client, primarySchema, participantId);
      await validateAccountlessGrants(
        client, primarySchema, participantId, owner.enrollment_device_id, owner.device_credential_id,
      );
      const socialSessions = parseRows<{ readonly count: string | number }>(await client.query(
        `SELECT count(*)::text AS count FROM ${table(primarySchema, "web_sessions")} WHERE participant_id=$1`,
        [participantId],
      ));
      const pairings = parseRows<{ readonly count: string | number }>(await client.query(
        `SELECT count(*)::text AS count FROM ${table(primarySchema, "device_pairings")} WHERE participant_id=$1`,
        [participantId],
      ));
      if (parseCount(socialSessions[0]?.count) !== 0 || parseCount(pairings[0]?.count) !== 0) {
        fail("ACCOUNTLESS_OWNER_ERASURE_FAMILY_UNSUPPORTED");
      }
      const consuming = parseRows<{ readonly count: string | number }>(await client.query(
        `SELECT count(*)::text AS count FROM ${table(primarySchema, "device_upload_authorizations")}
          WHERE participant_id=$1 AND state='consuming'`,
        [participantId],
      ));
      if (parseCount(consuming[0]?.count) !== 0) fail("ACCOUNTLESS_OWNER_ERASURE_UPLOAD_IN_PROGRESS");

      if (participant.state === "active") {
        await client.query(
          `UPDATE ${table(primarySchema, "participants")}
              SET state='deleting', deletion_session_id=$2 WHERE id=$1 AND state='active'`,
          [participantId, fenceId],
        );
      }
      await client.query(
        `UPDATE ${table(primarySchema, "accountless_enrollment_ledger")}
            SET state='revoked', revoked_at=COALESCE(revoked_at,clock_timestamp()),
                revocation_reason=COALESCE(revocation_reason,'security_reset')
          WHERE device_id=$1`,
        [owner.enrollment_device_id],
      );
      await client.query(
        `UPDATE ${table(primarySchema, "accountless_upload_owners")}
            SET state='revoked', revoked_at=COALESCE(revoked_at,clock_timestamp()),
                revocation_reason=COALESCE(revocation_reason,'security_reset')
          WHERE participant_id=$1 AND enrollment_device_id=$2`,
        [participantId, owner.enrollment_device_id],
      );
      await client.query(
        `UPDATE ${table(primarySchema, "accountless_v11_device_authorizations")}
            SET state='revoked', revoked_at=COALESCE(revoked_at,clock_timestamp()),
                revocation_reason=COALESCE(revocation_reason,'security_reset')
          WHERE participant_id=$1 AND enrollment_device_id=$2`,
        [participantId, owner.enrollment_device_id],
      );
      await client.query(
        `UPDATE ${table(primarySchema, "accountless_v12_device_authorizations")}
            SET state='revoked', revoked_at=COALESCE(revoked_at,clock_timestamp()),
                revocation_reason=COALESCE(revocation_reason,'security_reset')
          WHERE participant_id=$1 AND enrollment_device_id=$2`,
        [participantId, owner.enrollment_device_id],
      );
      await client.query(
        `UPDATE ${table(primarySchema, "device_credentials")}
            SET state='revoked', revoked_at=COALESCE(revoked_at,clock_timestamp())
          WHERE id=$1 AND participant_id=$2 AND state='active'`,
        [owner.device_credential_id, participantId],
      );
      await client.query(
        `UPDATE ${table(primarySchema, "device_upload_authorizations")}
            SET state='revoked', revoked_at=COALESCE(revoked_at,clock_timestamp())
          WHERE participant_id=$1 AND state='unused'`,
        [participantId],
      );
      await client.query(
        `UPDATE ${table(primarySchema, "telemetry_v12_device_capabilities")}
            SET state='revoked', revoked_at=COALESCE(revoked_at,clock_timestamp())
          WHERE participant_id=$1 AND state='accepted'`,
        [participantId],
      );
      return Object.freeze({
        absent: false,
        ownerDigest: owner.owner_digest,
        enrollmentDeviceId: owner.enrollment_device_id,
      });
    }, { ...TIMEOUTS, operation: "postgres.accountless_owner_erasure.fence", preserveSafeError });
  } catch (error) {
    if (error instanceof PostgresAccountlessOwnerErasureError) throw error;
    fail("ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED");
  }
}

function inventorySql(primarySchema: string): string {
  const live = (name: "telemetry_v1_chunks" | "telemetry_v11_chunks" | "telemetry_v12_chunks", source: "telemetry_v1" | "telemetry_v11" | "telemetry_v12") =>
    `SELECT '${source}'::text AS source, chunk.id::text AS ref_id,
            ('0:' || chunk.id)::text AS cursor_id, chunk.r2_key::text AS object_key,
            chunk.created_at::text AS created_at, pending.object_kind::text AS object_kind,
            pending.reconciliation_state::text AS reconciliation_state,
            pending.registration_token::text AS registration_token
       FROM ${table(primarySchema, name)} chunk
       LEFT JOIN ${table(primarySchema, "pending_objects")} pending
         ON pending.contribution_id=chunk.id AND pending.object_key=chunk.r2_key
      WHERE chunk.participant_id=$1`;
  const archivedV1 = `SELECT 'telemetry_v1'::text AS source,
            (archive.source_import_id || ':' || archive.id)::text AS ref_id,
            ('1:' || archive.source_import_id || ':' || archive.id)::text AS cursor_id,
            archive.r2_key::text AS object_key, archive.created_at::text AS created_at,
            NULL::text AS object_kind, NULL::text AS reconciliation_state, NULL::text AS registration_token
       FROM ${table(primarySchema, "historical_telemetry_v1_chunk_headers")} archive
      WHERE archive.participant_id=$1`;
  const archivedV11 = `SELECT 'telemetry_v11'::text AS source,
            (archive.source_import_id || ':' || archive.id)::text AS ref_id,
            ('1:' || archive.source_import_id || ':' || archive.id)::text AS cursor_id,
            archive.r2_key::text AS object_key, archive.created_at::text AS created_at,
            NULL::text AS object_kind, NULL::text AS reconciliation_state, NULL::text AS registration_token
       FROM ${table(primarySchema, "historical_telemetry_v11_chunk_headers")} archive
      WHERE archive.participant_id=$1`;
  return `SELECT * FROM (${[
    live("telemetry_v1_chunks", "telemetry_v1"), archivedV1,
    live("telemetry_v11_chunks", "telemetry_v11"), archivedV11,
    live("telemetry_v12_chunks", "telemetry_v12"),
  ].join(" UNION ALL ")}) inventory
  WHERE $2::text IS NULL OR (source,cursor_id) > ($2::text,$3::text)
  ORDER BY source,cursor_id LIMIT $4`;
}

async function readObjectPage(
  pool: PostgresPool,
  primarySchema: string,
  participantId: string,
  cursor: Cursor | null,
): Promise<readonly { readonly stored: StoredRef; readonly cursor: Cursor }[]> {
  try {
    return await withPostgresRead(pool, async (client) => {
      const rows = parseRows<ObjectInventoryRow>(await client.query(inventorySql(primarySchema), [
        participantId, cursor?.source ?? null, cursor?.refId ?? null, PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT,
      ]));
      return Object.freeze(rows.map((row) => {
        if (!["telemetry_v1", "telemetry_v11", "telemetry_v12"].includes(row.source)
            || typeof row.ref_id !== "string" || row.ref_id.length === 0 || row.ref_id.length > 1024
            || typeof row.cursor_id !== "string" || row.cursor_id.length === 0 || row.cursor_id.length > 2048
            || typeof row.object_key !== "string" || row.object_key.length === 0
            || new TextEncoder().encode(row.object_key).byteLength > 1024
            || /[\u0000-\u001f\u007f]/u.test(row.object_key)) {
          fail("ACCOUNTLESS_OWNER_ERASURE_REFERENCE_MISMATCH");
        }
        const created = Date.parse(row.created_at);
        if (!Number.isFinite(created)) fail("ACCOUNTLESS_OWNER_ERASURE_REFERENCE_MISMATCH");
        const live = row.registration_token !== null;
        if (live && (row.object_kind !== row.source || row.reconciliation_state !== "registered"
            || !TOKEN.test(row.registration_token ?? ""))) {
          fail("ACCOUNTLESS_OWNER_ERASURE_REFERENCE_MISMATCH");
        }
        if (!live && (row.object_kind !== null || row.reconciliation_state !== null)) {
          fail("ACCOUNTLESS_OWNER_ERASURE_REFERENCE_MISMATCH");
        }
        const stored = Object.freeze({
          source: row.source,
          id: row.ref_id,
          key: row.object_key,
          createdAt: new Date(created).toISOString(),
          version: null,
          registrationToken: row.registration_token,
        });
        return Object.freeze({ stored, cursor: Object.freeze({ source: row.source, refId: row.cursor_id }) });
      }));
    }, { ...TIMEOUTS, operation: "postgres.accountless_owner_erasure.inventory_read" });
  } catch (error) {
    if (error instanceof PostgresAccountlessOwnerErasureError) throw error;
    fail("ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED");
  }
}

async function hasUnattributablePendingObject(client: PostgresClient, primarySchema: string): Promise<boolean> {
  const rows = parseRows<{ readonly contribution_id: string }>(await client.query(
    `SELECT pending.contribution_id
       FROM ${table(primarySchema, "pending_objects")} pending
      WHERE pending.object_kind IN ('telemetry_v1','telemetry_v11','telemetry_v12')
        AND NOT EXISTS (SELECT 1 FROM ${table(primarySchema, "telemetry_v1_chunks")} chunk
          WHERE chunk.id=pending.contribution_id AND chunk.r2_key=pending.object_key)
        AND NOT EXISTS (SELECT 1 FROM ${table(primarySchema, "telemetry_v11_chunks")} chunk
          WHERE chunk.id=pending.contribution_id AND chunk.r2_key=pending.object_key)
        AND NOT EXISTS (SELECT 1 FROM ${table(primarySchema, "telemetry_v12_chunks")} chunk
          WHERE chunk.id=pending.contribution_id AND chunk.r2_key=pending.object_key)
      LIMIT 1`,
  ));
  return rows.length > 0;
}

async function assertInventoryComplete(
  primaryPool: PostgresPool,
  primarySchema: string,
  participantId: string,
): Promise<{ readonly count: number; readonly unattributable: boolean }> {
  try {
    return await withPostgresRead(primaryPool, async (client) => {
      const pendingBad = parseRows<{ readonly contribution_id: string }>(await client.query(
        `SELECT pending.contribution_id FROM ${table(primarySchema, "pending_objects")} pending
          WHERE pending.object_kind IN ('telemetry_v1','telemetry_v11','telemetry_v12')
            AND pending.reconciliation_state <> 'registered'
            AND EXISTS (
              SELECT 1 FROM ${table(primarySchema, "telemetry_v1_chunks")} chunk
               WHERE chunk.id=pending.contribution_id AND chunk.participant_id=$1
              UNION ALL
              SELECT 1 FROM ${table(primarySchema, "telemetry_v11_chunks")} chunk
               WHERE chunk.id=pending.contribution_id AND chunk.participant_id=$1
              UNION ALL
              SELECT 1 FROM ${table(primarySchema, "telemetry_v12_chunks")} chunk
               WHERE chunk.id=pending.contribution_id AND chunk.participant_id=$1
            ) LIMIT 1`,
        [participantId],
      ));
      if (pendingBad.length > 0) fail("ACCOUNTLESS_OWNER_ERASURE_REFERENCE_MISMATCH");
      let count = 0;
      let cursor: Cursor | null = null;
      for (;;) {
        const page = await readObjectPage(primaryPool, primarySchema, participantId, cursor);
        if (page.length === 0) break;
        count += page.length;
        if (!Number.isSafeInteger(count)) fail("ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED");
        cursor = page[page.length - 1]!.cursor;
      }
      return Object.freeze({ count, unattributable: await hasUnattributablePendingObject(client, primarySchema) });
    }, { ...TIMEOUTS, operation: "postgres.accountless_owner_erasure.inventory_audit" });
  } catch (error) {
    if (error instanceof PostgresAccountlessOwnerErasureError) throw error;
    fail("ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED");
  }
}

async function deleteStoredObjects(
  primaryPool: PostgresPool,
  primarySchema: string,
  objectStore: ParticipantErasureObjectStore,
  participantId: string,
): Promise<number> {
  let deleted = 0;
  let cursor: Cursor | null = null;
  for (;;) {
    const page = await readObjectPage(primaryPool, primarySchema, participantId, cursor);
    if (page.length === 0) return deleted;
    await objectStore.deleteBatch(page.map(({ stored }) => ({
      source: stored.source,
      id: stored.id,
      key: stored.key,
      createdAt: stored.createdAt,
      version: null,
    })));
    deleted += page.length;
    if (!Number.isSafeInteger(deleted)) fail("ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED");
    cursor = page[page.length - 1]!.cursor;
  }
}

async function finishPrimaryDelete(
  primaryPool: PostgresPool,
  primarySchema: string,
  participantId: string,
  fenceId: string,
  ownerDigest: string,
  enrollmentDeviceId: string,
): Promise<void> {
  try {
    await withPostgresMutation(primaryPool, async (client) => {
      const participants = parseRows<ParticipantRow>(await client.query(
        `SELECT id, state, owner_kind, deletion_session_id, identity_link_key
           FROM ${table(primarySchema, "participants")} WHERE id=$1 FOR UPDATE`,
        [participantId],
      ));
      if (participants.length !== 1 || participants[0]?.state !== "deleting"
          || participants[0]?.deletion_session_id !== fenceId
          || participants[0]?.owner_kind !== "accountless"
          || participants[0]?.identity_link_key !== null) {
        fail("ACCOUNTLESS_OWNER_ERASURE_STATE_UNEXPECTED");
      }
      const current = await readOwner(client, primarySchema, participantId);
      if (current.owner.owner_digest !== ownerDigest
          || current.owner.enrollment_device_id !== enrollmentDeviceId) {
        fail("ACCOUNTLESS_OWNER_ERASURE_STATE_UNEXPECTED");
      }
      let cursor: Cursor | null = null;
      for (;;) {
        const page = await readObjectPage(primaryPool, primarySchema, participantId, cursor);
        if (page.length === 0) break;
        for (const { stored } of page) {
          if (stored.registrationToken === null) continue;
          const deleted = await client.query(
            `DELETE FROM ${table(primarySchema, "pending_objects")}
              WHERE contribution_id=$1 AND object_key=$2 AND object_kind=$3
                AND reconciliation_state='registered' AND registration_token=$4`,
            [stored.id, stored.key, stored.source, stored.registrationToken],
          );
          if (deleted.rowCount !== 1) fail("ACCOUNTLESS_OWNER_ERASURE_REFERENCE_MISMATCH");
        }
        cursor = page[page.length - 1]!.cursor;
      }
      const terminalOwner = await client.query(
        `UPDATE ${table(primarySchema, "storage_v11_owner_links")}
            SET state='erased'
          WHERE participant_id=$1 AND owner_digest=$2 AND state <> 'erased'`,
        [participantId, ownerDigest],
      );
      if (terminalOwner.rowCount !== 1) fail("ACCOUNTLESS_OWNER_ERASURE_STATE_UNEXPECTED");
      // Delete source chunks while their participant and input_versions rows
      // still exist. v1 chunk-delete triggers update the analytical revision;
      // the owner-link transition above writes terminal proof required by
      // append-only source-membership retention guards during FK cascades.
      await client.query(
        `DELETE FROM ${table(primarySchema, "telemetry_v12_chunks")} WHERE participant_id=$1`,
        [participantId],
      );
      await client.query(
        `DELETE FROM ${table(primarySchema, "telemetry_v11_chunks")} WHERE participant_id=$1`,
        [participantId],
      );
      await client.query(
        `DELETE FROM ${table(primarySchema, "telemetry_v1_chunks")} WHERE participant_id=$1`,
        [participantId],
      );
      const deletedParticipant = await client.query(
        `DELETE FROM ${table(primarySchema, "participants")}
          WHERE id=$1 AND state='deleting' AND deletion_session_id=$2`,
        [participantId, fenceId],
      );
      if (deletedParticipant.rowCount !== 1) fail("ACCOUNTLESS_OWNER_ERASURE_STATE_UNEXPECTED");
      const enrollment = await client.query(
        `DELETE FROM ${table(primarySchema, "accountless_enrollment_ledger")} WHERE device_id=$1`,
        [enrollmentDeviceId],
      );
      if (enrollment.rowCount !== 1) fail("ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED");
      const ownerProof = parseRows<{ readonly owner_digest: string }>(await client.query(
        `SELECT owner_digest FROM ${table(primarySchema, "storage_owner_erasure_receipts")}
          WHERE owner_digest=$1`,
        [ownerDigest],
      ));
      if (ownerProof.length !== 1 || ownerProof[0]?.owner_digest !== ownerDigest) {
        fail("ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED");
      }
    }, { ...TIMEOUTS, operation: "postgres.accountless_owner_erasure.delete", preserveSafeError });
  } catch (error) {
    if (error instanceof PostgresAccountlessOwnerErasureError) throw error;
    fail("ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED");
  }
}

async function verifyPrimaryCompletion(
  primaryPool: PostgresPool,
  primarySchema: string,
  participantId: string,
  ownerDigest: string,
  enrollmentDeviceId: string | null,
): Promise<boolean> {
  try {
    return await withPostgresRead(primaryPool, async (client) => {
      const participant = parseRows<{ readonly id: string }>(await client.query(
        `SELECT id FROM ${table(primarySchema, "participants")} WHERE id=$1 LIMIT 1`, [participantId],
      ));
      const proof = parseRows<{ readonly owner_digest: string }>(await client.query(
        `SELECT owner_digest FROM ${table(primarySchema, "storage_owner_erasure_receipts")}
          WHERE owner_digest=$1 LIMIT 1`, [ownerDigest],
      ));
      const marker = parseRows<{ readonly participant_id: string }>(await client.query(
        `SELECT participant_id FROM ${table(primarySchema, "accountless_public_history_retention")}
          WHERE participant_id=$1 LIMIT 1`, [participantId],
      ));
      const enrollment = enrollmentDeviceId === null ? [] : parseRows<{ readonly device_id: string }>(await client.query(
        `SELECT device_id FROM ${table(primarySchema, "accountless_enrollment_ledger")}
          WHERE device_id=$1 LIMIT 1`, [enrollmentDeviceId],
      ));
      return participant.length === 0 && proof.length === 1
        && proof[0]?.owner_digest === ownerDigest && marker.length === 0 && enrollment.length === 0;
    }, { ...TIMEOUTS, operation: "postgres.accountless_owner_erasure.verify" });
  } catch (error) {
    if (error instanceof PostgresAccountlessOwnerErasureError) throw error;
    fail("ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED");
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
  code: PostgresAccountlessOwnerErasureCode,
): Promise<PostgresAccountlessOwnerErasureResult> {
  await writeReceipt(ledgerPool, ledgerSchema, operationId, participantDigest, "failed",
    details(ownerDigest, phase, objectCount));
  return Object.freeze({ status: "incomplete", code });
}

/**
 * Internal owner-operated cleanup for accountless PostgreSQL participants.
 * This is not a participant route. It retains no accountless identity rows,
 * removes exact live/archive object keys before source rows, and relies on the
 * independent deletion ledger plus the primary owner receipt for replay proof.
 */
export async function erasePostgresAccountlessOwner(
  options: PostgresAccountlessOwnerErasureOptions,
): Promise<PostgresAccountlessOwnerErasureResult> {
  if (!ACCOUNTLESS_PARTICIPANT.test(options?.participantId ?? "")
      || options.primaryPool === options.ledgerPool
      || typeof options.primaryPool?.connect !== "function"
      || typeof options.ledgerPool?.connect !== "function"
      || typeof options.objectStore?.deleteBatch !== "function") {
    fail("ACCOUNTLESS_OWNER_ERASURE_TARGET_INVALID");
  }
  let schemas;
  try { schemas = createPostgresSchemaConfig(options.schema); } catch {
    fail("ACCOUNTLESS_OWNER_ERASURE_TARGET_INVALID");
  }
  const participantDigest = await participantDeletionDigest(options.participantId);
  const operationId = await operationIdFor(participantDigest);
  const priorReceipt = await readReceipt(options.ledgerPool, schemas.ledgerSchema, operationId);
  if (priorReceipt !== null && priorReceipt.participant_digest !== participantDigest) {
    fail("ACCOUNTLESS_OWNER_ERASURE_LEDGER_FAILED");
  }
  const priorDetails = priorReceipt === null ? null : parseDetails(priorReceipt);
  if (priorReceipt !== null && priorDetails === null) fail("ACCOUNTLESS_OWNER_ERASURE_LEDGER_FAILED");

  const snapshot = await fenceAndRead(
    options.primaryPool, schemas.primarySchema, options.participantId, operationId,
  );
  if (snapshot.absent) {
    if (priorReceipt === null || priorDetails === null
        || !["objects_deleted", "completed"].includes(priorDetails.phase)
        || !await hasPostgresDeletionTombstone(
          options.ledgerPool, options.participantId, Date.now(), { schema: schemas },
        )
        || !await verifyPrimaryCompletion(
          options.primaryPool, schemas.primarySchema, options.participantId,
          priorDetails.ownerDigest, null,
        )) {
      fail("ACCOUNTLESS_OWNER_ERASURE_PARTICIPANT_NOT_FOUND");
    }
    if (priorReceipt.outcome !== "completed") {
      await writeReceipt(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
        "completed", details(priorDetails.ownerDigest, "completed", priorDetails.objectCount));
    }
    return Object.freeze({ status: "already_complete", objectsDeleted: priorDetails.objectCount });
  }

  const ownerDigest = snapshot.ownerDigest;
  const enrollmentDeviceId = snapshot.enrollmentDeviceId;
  if (ownerDigest === null || enrollmentDeviceId === null
      || priorDetails !== null && priorDetails.ownerDigest !== ownerDigest) {
    fail("ACCOUNTLESS_OWNER_ERASURE_LEDGER_FAILED");
  }
  await recordPostgresDeletionTombstone(
    options.ledgerPool, options.participantId, Date.now(), { schema: schemas },
  );
  await writeReceipt(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
    "started", details(ownerDigest, "fenced", priorDetails?.objectCount ?? 0));

  const inventory = await assertInventoryComplete(
    options.primaryPool, schemas.primarySchema, options.participantId,
  );
  if (inventory.unattributable) {
    return incomplete(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
      ownerDigest, "pending_unattributed", inventory.count, "ACCOUNTLESS_OWNER_ERASURE_PENDING_UNATTRIBUTED");
  }
  await writeReceipt(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
    "started", details(ownerDigest, "object_delete_retry", inventory.count));
  let objectsDeleted: number;
  try {
    objectsDeleted = await deleteStoredObjects(
      options.primaryPool, schemas.primarySchema, options.objectStore, options.participantId,
    );
  } catch {
    return incomplete(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
      ownerDigest, "object_delete_retry", inventory.count, "ACCOUNTLESS_OWNER_ERASURE_OBJECT_STORE_FAILED");
  }
  if (objectsDeleted !== inventory.count) {
    return incomplete(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
      ownerDigest, "object_delete_retry", inventory.count, "ACCOUNTLESS_OWNER_ERASURE_REFERENCE_MISMATCH");
  }
  await writeReceipt(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
    "started", details(ownerDigest, "objects_deleted", objectsDeleted));

  try {
    await finishPrimaryDelete(
      options.primaryPool, schemas.primarySchema, options.participantId,
      operationId, ownerDigest, enrollmentDeviceId,
    );
  } catch (error) {
    if (error instanceof PostgresAccountlessOwnerErasureError) {
      return incomplete(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
        ownerDigest, "objects_deleted", objectsDeleted, error.code);
    }
    throw error;
  }
  if (!await verifyPrimaryCompletion(
    options.primaryPool, schemas.primarySchema, options.participantId, ownerDigest, enrollmentDeviceId,
  )) {
    return incomplete(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
      ownerDigest, "objects_deleted", objectsDeleted, "ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED");
  }
  await writeReceipt(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
    "completed", details(ownerDigest, "completed", objectsDeleted));
  return Object.freeze({ status: "complete", objectsDeleted });
}
