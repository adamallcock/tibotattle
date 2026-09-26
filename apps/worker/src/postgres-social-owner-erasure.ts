import { sha256Hex } from "./crypto";
import { participantDeletionDigest } from "./participant-deletion-digest";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaConfig,
  type PostgresSchemaOptions,
} from "./postgres-client";
import {
  IDENTITY_LINK_SECRET_VERSION_PATTERN,
  identityLinkSecretFingerprint,
} from "./identity-link-configuration";
import { hasPostgresDeletionTombstone, recordPostgresDeletionTombstone } from "./postgres-ledger-authority";
import {
  IDENTITY_REENROLLMENT_COOLDOWN_MILLISECONDS,
  identityReenrollmentCooldownDigest,
} from "./retention";
import {
  PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT,
  type ParticipantErasureObjectRef,
  type ParticipantErasureObjectStore,
} from "./erasure-object-store";
import {
  inspectPostgresSocialOwnerErasureClient,
  PostgresSocialOwnerErasurePreflightError,
  readPostgresSocialOwnerErasureObjectPage,
  type PostgresSocialOwnerErasureObjectCursor,
} from "./postgres-social-owner-erasure-preflight";
import {
  hasPostgresAnalyticsOwnerResidue,
  retirePostgresAnalyticsOwner,
} from "./postgres-analytics-owner-retirement";

const SOCIAL_PARTICIPANT = /^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const RECEIPT_SCHEMA = "postgres-social-owner-erasure-v1";
const OPERATION_DOMAIN = "app-usagemonitor/postgres-social-owner-erasure/v1\0";
const COOLDOWN_SCHEMA = "identity-reenrollment-cooldown-v0.1";
const TIMEOUTS = Object.freeze({
  operation: "postgres.social_owner_erasure",
  statementTimeoutMilliseconds: 10_000,
  lockTimeoutMilliseconds: 5_000,
});

export type PostgresSocialOwnerErasureCode =
  | "SOCIAL_OWNER_ERASURE_TARGET_INVALID"
  | "SOCIAL_OWNER_ERASURE_PARTICIPANT_NOT_FOUND"
  | "SOCIAL_OWNER_ERASURE_STATE_UNEXPECTED"
  | "SOCIAL_OWNER_ERASURE_FAMILY_UNSUPPORTED"
  | "SOCIAL_OWNER_ERASURE_AUTHORITY_MISMATCH"
  | "SOCIAL_OWNER_ERASURE_UPLOAD_IN_PROGRESS"
  | "SOCIAL_OWNER_ERASURE_PENDING_UNATTRIBUTED"
  | "SOCIAL_OWNER_ERASURE_REFERENCE_MISMATCH"
  | "SOCIAL_OWNER_ERASURE_GRANT_POLICY_REQUIRED"
  | "SOCIAL_OWNER_ERASURE_IDENTITY_CONFIGURATION_INVALID"
  | "SOCIAL_OWNER_ERASURE_OBJECT_STORE_FAILED"
  | "SOCIAL_OWNER_ERASURE_ANALYTICS_RETIREMENT_FAILED"
  | "SOCIAL_OWNER_ERASURE_LEDGER_FAILED"
  | "SOCIAL_OWNER_ERASURE_READBACK_FAILED";

export class PostgresSocialOwnerErasureError extends Error {
  readonly code: PostgresSocialOwnerErasureCode;

  constructor(code: PostgresSocialOwnerErasureCode) {
    super(code);
    this.name = "PostgresSocialOwnerErasureError";
    this.code = code;
  }
}

export interface PostgresSocialOwnerErasureOptions {
  readonly primaryPool: PostgresPool;
  readonly ledgerPool: PostgresPool;
  readonly objectStore: ParticipantErasureObjectStore;
  readonly participantId: string;
  /** Required only when the owner still carries an identity-link key. */
  readonly identityLinkSecret?: string;
  /** Must match the pinned primary identity-link configuration with the secret. */
  readonly identityLinkSecretVersion?: string;
  readonly schema?: PostgresSchemaOptions;
}

export type PostgresSocialOwnerErasureResult =
  | { readonly status: "complete" | "already_complete"; readonly objectsDeleted: number }
  | { readonly status: "incomplete"; readonly code: PostgresSocialOwnerErasureCode };

interface ParticipantRow {
  readonly id: string;
  readonly state: string;
  readonly owner_kind: string;
  readonly deletion_session_id: string | null;
  readonly identity_link_key: string | null;
}

interface ReceiptRow {
  readonly operation_id: string;
  readonly participant_digest: string;
  readonly outcome: "started" | "completed" | "failed";
  readonly details_json: string;
}

interface ReceiptDetails {
  readonly schemaVersion: typeof RECEIPT_SCHEMA;
  readonly phase: "fenced" | "object_delete_retry" | "objects_deleted" | "primary_deleted" | "completed";
  /** Null only for a participant that never received an analytics owner link. */
  readonly ownerDigest: string | null;
  readonly objectCount: number;
  readonly identityCooldownRecorded: boolean;
}

interface FencedSnapshot {
  readonly absent: boolean;
  readonly ownerDigest: string | null;
  readonly objectCount: number;
  readonly identityCooldownDigest: string | null;
}

interface StoredObject extends ParticipantErasureObjectRef {
  readonly registrationToken: string | null;
}

function fail(code: PostgresSocialOwnerErasureCode): never {
  throw new PostgresSocialOwnerErasureError(code);
}

function preserveSafeError(error: unknown): Error | null {
  if (error instanceof PostgresSocialOwnerErasureError
      || error instanceof PostgresSocialOwnerErasurePreflightError) return error;
  return null;
}

function table(schema: string, name: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(name)}`;
}

function parseRows<Row extends object>(value: unknown): readonly Row[] {
  if (value === null || typeof value !== "object") fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  const valueRows = Reflect.get(value, "rows");
  if (!Array.isArray(valueRows)) fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  return valueRows as readonly Row[];
}

function parseCount(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  return number;
}

async function operationIdFor(participantDigest: string): Promise<string> {
  const hex = (await sha256Hex(`${OPERATION_DOMAIN}${participantDigest}`)).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function details(
  ownerDigest: string | null,
  phase: ReceiptDetails["phase"],
  objectCount: number,
  identityCooldownRecorded: boolean,
): ReceiptDetails {
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA,
    phase,
    ownerDigest,
    objectCount,
    identityCooldownRecorded,
  });
}

function parseDetails(row: ReceiptRow): ReceiptDetails | null {
  let value: unknown;
  try { value = JSON.parse(row.details_json); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const phase = Reflect.get(value, "phase");
  const ownerDigest = Reflect.get(value, "ownerDigest");
  const objectCount = Reflect.get(value, "objectCount");
  const identityCooldownRecorded = Reflect.get(value, "identityCooldownRecorded");
  if (Reflect.get(value, "schemaVersion") !== RECEIPT_SCHEMA
      || ownerDigest !== null && (typeof ownerDigest !== "string" || !DIGEST.test(ownerDigest))
      || !Number.isSafeInteger(objectCount) || objectCount < 0
      || typeof identityCooldownRecorded !== "boolean"
      || !["fenced", "object_delete_retry", "objects_deleted", "primary_deleted", "completed"].includes(phase)) {
    return null;
  }
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA,
    phase: phase as ReceiptDetails["phase"],
    ownerDigest: ownerDigest as string | null,
    objectCount,
    identityCooldownRecorded,
  });
}

async function readReceipt(
  ledgerPool: PostgresPool,
  ledgerSchema: string,
  operationId: string,
): Promise<ReceiptRow | null> {
  try {
    return await withPostgresRead(ledgerPool, async (client) => {
      const receiptRows = parseRows<ReceiptRow>(await client.query(
        `SELECT operation_id,participant_digest,outcome,details_json
           FROM ${table(ledgerSchema, "participant_erasure_receipts")}
          WHERE operation_id=$1 LIMIT 2`, [operationId],
      ));
      if (receiptRows.length > 1) fail("SOCIAL_OWNER_ERASURE_LEDGER_FAILED");
      return receiptRows[0] ?? null;
    }, { ...TIMEOUTS, operation: "postgres.social_owner_erasure.receipt_read" });
  } catch (error) {
    if (error instanceof PostgresSocialOwnerErasureError) throw error;
    fail("SOCIAL_OWNER_ERASURE_LEDGER_FAILED");
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
           operation_id,participant_digest,outcome,details_json,created_at,
           completed_at
         ) VALUES ($1,$2,$3,$4,clock_timestamp(),
                   CASE WHEN $3='completed' THEN clock_timestamp() ELSE NULL END)
         ON CONFLICT (operation_id) DO UPDATE SET
           outcome=EXCLUDED.outcome,
           details_json=EXCLUDED.details_json,
           completed_at=EXCLUDED.completed_at
         WHERE participant_erasure_receipts.participant_digest=EXCLUDED.participant_digest
           AND participant_erasure_receipts.outcome <> 'completed'
         RETURNING operation_id`,
        [operationId, participantDigest, outcome, JSON.stringify(receiptDetails)],
      );
      if (parseRows<{ readonly operation_id: string }>(result).length === 1) return;
      const existing = parseRows<ReceiptRow>(await client.query(
        `SELECT operation_id,participant_digest,outcome,details_json
           FROM ${table(ledgerSchema, "participant_erasure_receipts")}
          WHERE operation_id=$1 LIMIT 1`, [operationId],
      ))[0];
      if (existing?.participant_digest !== participantDigest || existing.outcome !== "completed") {
        fail("SOCIAL_OWNER_ERASURE_LEDGER_FAILED");
      }
    }, { ...TIMEOUTS, operation: "postgres.social_owner_erasure.receipt_write", preserveSafeError });
  } catch (error) {
    if (error instanceof PostgresSocialOwnerErasureError) throw error;
    fail("SOCIAL_OWNER_ERASURE_LEDGER_FAILED");
  }
}

function totalObjects(counts: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const amount of Object.values(counts)) {
    total += amount;
    if (!Number.isSafeInteger(total)) fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  }
  return total;
}

async function fenceAndRead(
  primaryPool: PostgresPool,
  schema: PostgresSchemaConfig,
  participantId: string,
  fenceId: string,
  identityLinkSecret: string | undefined,
  identityLinkSecretVersion: string | undefined,
  nowEpoch: number,
): Promise<FencedSnapshot> {
  try {
    return await withPostgresMutation(primaryPool, async (client) => {
      const participants = parseRows<ParticipantRow>(await client.query(
        `SELECT id,state,owner_kind,deletion_session_id,identity_link_key
           FROM ${table(schema.primarySchema, "participants")}
          WHERE id=$1 FOR UPDATE`, [participantId],
      ));
      if (participants.length === 0) {
        return Object.freeze({ absent: true, ownerDigest: null, objectCount: 0, identityCooldownDigest: null });
      }
      const participant = participants[0]!;
      if (participants.length !== 1 || participant.owner_kind !== "social"
          || !["active", "deleting"].includes(participant.state)
          || participant.state === "deleting" && participant.deletion_session_id !== fenceId
          || participant.state === "active" && participant.deletion_session_id !== null) {
        fail("SOCIAL_OWNER_ERASURE_STATE_UNEXPECTED");
      }
      const inventory = await inspectPostgresSocialOwnerErasureClient({
        client,
        participantId,
        schema: { primarySchema: schema.primarySchema },
        deletionFenceId: fenceId,
        lockRows: true,
      });
      // A participant that never uploaded has no analytics owner link, so it
      // has no owner receipt or analytics state to retire.
      const ownerDigest = inventory.ownerDigest;
      if (ownerDigest !== null && !DIGEST.test(ownerDigest)) fail("SOCIAL_OWNER_ERASURE_STATE_UNEXPECTED");
      let identityCooldownDigest: string | null = null;
      if (participant.identity_link_key !== null) {
        // A cooldown derived from any other secret would never match a later
        // sign-in, so the secret must equal the pinned configuration.
        if (typeof identityLinkSecret !== "string" || identityLinkSecret.length < 32
            || typeof identityLinkSecretVersion !== "string"
            || !IDENTITY_LINK_SECRET_VERSION_PATTERN.test(identityLinkSecretVersion)) {
          fail("SOCIAL_OWNER_ERASURE_IDENTITY_CONFIGURATION_INVALID");
        }
        const pinned = parseRows<{ readonly key_version: string; readonly secret_fingerprint: string }>(
          await client.query(
            `SELECT key_version,secret_fingerprint
               FROM ${table(schema.primarySchema, "identity_link_secret_configuration")}
              WHERE singleton=1`,
          ),
        );
        if (pinned.length !== 1 || pinned[0]?.key_version !== identityLinkSecretVersion
            || pinned[0]?.secret_fingerprint !== await identityLinkSecretFingerprint(identityLinkSecret)) {
          fail("SOCIAL_OWNER_ERASURE_IDENTITY_CONFIGURATION_INVALID");
        }
        identityCooldownDigest = await identityReenrollmentCooldownDigest(
          identityLinkSecret,
          participant.identity_link_key,
        );
        if (!DIGEST.test(identityCooldownDigest)) fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
      }
      const objectCount = totalObjects(inventory.objectCounts);
      if (participant.state === "active") {
        const claimed = await client.query(
          `UPDATE ${table(schema.primarySchema, "participants")}
              SET state='deleting',deletion_session_id=$2
            WHERE id=$1 AND state='active' AND deletion_session_id IS NULL`,
          [participantId, fenceId],
        );
        if (claimed.rowCount !== 1) fail("SOCIAL_OWNER_ERASURE_STATE_UNEXPECTED");
      }
      const markedAt = new Date(nowEpoch).toISOString();
      if (identityCooldownDigest !== null) {
        const expiresAt = new Date(nowEpoch + IDENTITY_REENROLLMENT_COOLDOWN_MILLISECONDS).toISOString();
        await client.query(
          `INSERT INTO ${table(schema.primarySchema, "identity_reenrollment_cooldowns")} (
             identity_cooldown_digest,participant_id,created_at,expires_at
           ) VALUES ($1,NULL,$2::timestamptz,$3::timestamptz)
           ON CONFLICT (identity_cooldown_digest) DO UPDATE SET
             expires_at=GREATEST(identity_reenrollment_cooldowns.expires_at,EXCLUDED.expires_at)`,
          [identityCooldownDigest, markedAt, expiresAt],
        );
        const cooldown = parseRows<{ readonly identity_cooldown_digest: string; readonly retained: boolean }>(await client.query(
          `SELECT identity_cooldown_digest,expires_at >= $2::timestamptz AS retained
             FROM ${table(schema.primarySchema, "identity_reenrollment_cooldowns")}
            WHERE identity_cooldown_digest=$1 LIMIT 2`, [identityCooldownDigest, expiresAt],
        ));
        if (cooldown.length !== 1 || cooldown[0]?.identity_cooldown_digest !== identityCooldownDigest
            || cooldown[0]?.retained !== true) fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
      }
      const revokeAt = markedAt;
      await client.query(
        `UPDATE ${table(schema.primarySchema, "web_sessions")}
            SET state='revoked',revoked_at=COALESCE(revoked_at,$2::timestamptz)
          WHERE participant_id=$1 AND state='active'`, [participantId, revokeAt],
      );
      await client.query(
        `UPDATE ${table(schema.primarySchema, "device_pairings")}
            SET state='revoked',revoked_at=COALESCE(revoked_at,$2::timestamptz)
          WHERE participant_id=$1 AND state='unused'`, [participantId, revokeAt],
      );
      await client.query(
        `UPDATE ${table(schema.primarySchema, "device_credentials")}
            SET state='revoked',revoked_at=COALESCE(revoked_at,$2::timestamptz)
          WHERE participant_id=$1 AND state='active'`, [participantId, revokeAt],
      );
      await client.query(
        `UPDATE ${table(schema.primarySchema, "upload_authorizations")}
            SET state='revoked',revoked_at=COALESCE(revoked_at,$2::timestamptz)
          WHERE participant_id=$1 AND state='unused'`, [participantId, revokeAt],
      );
      await client.query(
        `UPDATE ${table(schema.primarySchema, "device_upload_authorizations")}
            SET state='revoked',revoked_at=COALESCE(revoked_at,$2::timestamptz)
          WHERE participant_id=$1 AND state='unused'`, [participantId, revokeAt],
      );
      await client.query(
        `UPDATE ${table(schema.primarySchema, "telemetry_v12_device_capabilities")}
            SET state='revoked',revoked_at=COALESCE(revoked_at,$2::timestamptz)
          WHERE participant_id=$1 AND state='accepted'`, [participantId, revokeAt],
      );
      return Object.freeze({ absent: false, ownerDigest, objectCount, identityCooldownDigest });
    }, { ...TIMEOUTS, operation: "postgres.social_owner_erasure.fence", preserveSafeError });
  } catch (error) {
    if (error instanceof PostgresSocialOwnerErasureError
        || error instanceof PostgresSocialOwnerErasurePreflightError) throw error;
    fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  }
}

async function recordLedgerCooldown(
  ledgerPool: PostgresPool,
  ledgerSchema: string,
  identityCooldownDigest: string,
  nowEpoch: number,
): Promise<void> {
  const deletedAt = new Date(nowEpoch).toISOString();
  const retainUntil = new Date(nowEpoch + IDENTITY_REENROLLMENT_COOLDOWN_MILLISECONDS).toISOString();
  try {
    await withPostgresMutation(ledgerPool, async (client) => {
      await client.query(
        `INSERT INTO ${table(ledgerSchema, "identity_reenrollment_cooldowns")} (
           identity_cooldown_digest,schema_version,deleted_at,retain_until
         ) VALUES ($1,$2,$3::timestamptz,$4::timestamptz)
         ON CONFLICT (identity_cooldown_digest) DO UPDATE SET
           retain_until=GREATEST(identity_reenrollment_cooldowns.retain_until,EXCLUDED.retain_until)`,
        [identityCooldownDigest, COOLDOWN_SCHEMA, deletedAt, retainUntil],
      );
      const rows = parseRows<{ readonly identity_cooldown_digest: string; readonly retained: boolean }>(await client.query(
        `SELECT identity_cooldown_digest,retain_until >= $2::timestamptz AS retained
           FROM ${table(ledgerSchema, "identity_reenrollment_cooldowns")}
          WHERE identity_cooldown_digest=$1 LIMIT 2`, [identityCooldownDigest, retainUntil],
      ));
      if (rows.length !== 1 || rows[0]?.identity_cooldown_digest !== identityCooldownDigest
          || rows[0]?.retained !== true) fail("SOCIAL_OWNER_ERASURE_LEDGER_FAILED");
    }, { ...TIMEOUTS, operation: "postgres.social_owner_erasure.ledger_cooldown", preserveSafeError });
  } catch (error) {
    if (error instanceof PostgresSocialOwnerErasureError) throw error;
    fail("SOCIAL_OWNER_ERASURE_LEDGER_FAILED");
  }
}

async function deleteStoredObjects(
  primaryPool: PostgresPool,
  schema: PostgresSchemaConfig,
  objectStore: ParticipantErasureObjectStore,
  participantId: string,
): Promise<number> {
  let deleted = 0;
  let cursor: PostgresSocialOwnerErasureObjectCursor | null = null;
  for (;;) {
    let page;
    try {
      page = await withPostgresRead(primaryPool, (client) =>
        readPostgresSocialOwnerErasureObjectPage(
          client, { primarySchema: schema.primarySchema }, participantId, cursor,
        ), { ...TIMEOUTS, operation: "postgres.social_owner_erasure.object_read" });
    } catch (error) {
      if (error instanceof PostgresSocialOwnerErasurePreflightError) throw error;
      fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
    }
    if (page.objects.length === 0) return deleted;
    if (page.objects.length > PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT) {
      fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
    }
    const objects: StoredObject[] = page.objects.map((object) => Object.freeze({
      source: object.source,
      id: object.id,
      key: object.key,
      createdAt: object.createdAt,
      version: null,
      registrationToken: object.registrationToken,
    }));
    try {
      await objectStore.deleteBatch(objects.map(({ registrationToken: _token, ...object }) => object));
    } catch {
      fail("SOCIAL_OWNER_ERASURE_OBJECT_STORE_FAILED");
    }
    deleted += objects.length;
    if (!Number.isSafeInteger(deleted)) fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
    cursor = page.nextCursor;
  }
}

/** Tables whose rows either authorize the participant or reference stored objects. */
const PARTICIPANT_RESIDUE_TABLES = Object.freeze([
  "web_sessions", "device_pairings", "device_credentials", "upload_authorizations",
  "device_upload_authorizations", "telemetry_contributions", "telemetry_v1_chunks",
  "telemetry_v11_chunks", "telemetry_v12_chunks", "historical_telemetry_v1_chunk_headers",
  "historical_telemetry_v11_chunk_headers", "storage_v11_owner_links",
] as const);

async function finishPrimaryDelete(
  primaryPool: PostgresPool,
  schema: PostgresSchemaConfig,
  participantId: string,
  fenceId: string,
  ownerDigest: string | null,
  expectedObjectCount: number,
): Promise<void> {
  try {
    await withPostgresMutation(primaryPool, async (client) => {
      const participants = parseRows<ParticipantRow>(await client.query(
        `SELECT id,state,owner_kind,deletion_session_id,identity_link_key
           FROM ${table(schema.primarySchema, "participants")}
          WHERE id=$1 FOR UPDATE`, [participantId],
      ));
      if (participants.length !== 1 || participants[0]?.state !== "deleting"
          || participants[0]?.deletion_session_id !== fenceId
          || participants[0]?.owner_kind !== "social") {
        fail("SOCIAL_OWNER_ERASURE_STATE_UNEXPECTED");
      }
      const inventory = await inspectPostgresSocialOwnerErasureClient({
        client,
        participantId,
        schema: { primarySchema: schema.primarySchema },
        deletionFenceId: fenceId,
        lockRows: true,
      });
      if (inventory.ownerDigest !== ownerDigest) fail("SOCIAL_OWNER_ERASURE_STATE_UNEXPECTED");
      // An object registered after provider deletion would be orphaned by the
      // cascades below, so the locked inventory must match what was deleted.
      if (totalObjects(inventory.objectCounts) !== expectedObjectCount) {
        fail("SOCIAL_OWNER_ERASURE_REFERENCE_MISMATCH");
      }
      let cursor: PostgresSocialOwnerErasureObjectCursor | null = null;
      for (;;) {
        const page = await readPostgresSocialOwnerErasureObjectPage(
          client, { primarySchema: schema.primarySchema }, participantId, cursor,
        );
        if (page.objects.length === 0) break;
        for (const object of page.objects) {
          if (object.registrationToken === null) continue;
          const deleted = await client.query(
            `DELETE FROM ${table(schema.primarySchema, "pending_objects")}
              WHERE contribution_id=$1 AND object_key=$2 AND object_kind=$3
                AND reconciliation_state='registered' AND registration_token=$4`,
            [object.id, object.key, object.source, object.registrationToken],
          );
          if (deleted.rowCount !== 1) fail("SOCIAL_OWNER_ERASURE_REFERENCE_MISMATCH");
        }
        cursor = page.nextCursor;
      }
      if (ownerDigest !== null) {
        // The erased link writes the immutable owner receipt and publication
        // invalidations that source-retention guards require during cascades.
        const terminalOwner = await client.query(
          `UPDATE ${table(schema.primarySchema, "storage_v11_owner_links")}
              SET state='erased'
            WHERE participant_id=$1 AND owner_digest=$2 AND state <> 'erased'`,
          [participantId, ownerDigest],
        );
        if (terminalOwner.rowCount !== 1) fail("SOCIAL_OWNER_ERASURE_STATE_UNEXPECTED");
      }
      // Delete source chunks while their participant and input_versions rows
      // still exist, matching the accountless eraser's trigger ordering.
      for (const name of ["telemetry_v12_chunks", "telemetry_v11_chunks", "telemetry_v1_chunks"] as const) {
        await client.query(
          `DELETE FROM ${table(schema.primarySchema, name)} WHERE participant_id=$1`, [participantId],
        );
      }
      const deletedParticipant = await client.query(
        `DELETE FROM ${table(schema.primarySchema, "participants")}
          WHERE id=$1 AND state='deleting' AND deletion_session_id=$2`,
        [participantId, fenceId],
      );
      if (deletedParticipant.rowCount !== 1) fail("SOCIAL_OWNER_ERASURE_STATE_UNEXPECTED");
      if (ownerDigest !== null) {
        const ownerProof = parseRows<{ readonly owner_digest: string }>(await client.query(
          `SELECT owner_digest FROM ${table(schema.primarySchema, "storage_owner_erasure_receipts")}
            WHERE owner_digest=$1`, [ownerDigest],
        ));
        if (ownerProof.length !== 1 || ownerProof[0]?.owner_digest !== ownerDigest) {
          fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
        }
      }
    }, { ...TIMEOUTS, operation: "postgres.social_owner_erasure.delete", preserveSafeError });
  } catch (error) {
    if (error instanceof PostgresSocialOwnerErasureError
        || error instanceof PostgresSocialOwnerErasurePreflightError) throw error;
    fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  }
}

async function verifyPrimaryCompletion(
  primaryPool: PostgresPool,
  schema: PostgresSchemaConfig,
  participantId: string,
  ownerDigest: string | null,
): Promise<boolean> {
  try {
    return await withPostgresRead(primaryPool, async (client) => {
      const residue = parseRows<{ readonly count: string | number }>(await client.query(
        `SELECT (SELECT count(*) FROM ${table(schema.primarySchema, "participants")} WHERE id=$1)
                ${PARTICIPANT_RESIDUE_TABLES.map((name) =>
                  `+ (SELECT count(*) FROM ${table(schema.primarySchema, name)} WHERE participant_id=$1)`).join("\n")}
                AS count`,
        [participantId],
      ));
      if (residue.length !== 1 || parseCount(residue[0]?.count) !== 0) return false;
      if (ownerDigest === null) return true;
      const ownerProof = parseRows<{ readonly owner_digest: string }>(await client.query(
        `SELECT owner_digest FROM ${table(schema.primarySchema, "storage_owner_erasure_receipts")}
          WHERE owner_digest=$1 LIMIT 2`, [ownerDigest],
      ));
      const ownerLinks = parseRows<{ readonly count: string | number }>(await client.query(
        `SELECT count(*)::text AS count FROM ${table(schema.primarySchema, "storage_v11_owner_links")}
          WHERE owner_digest=$1`, [ownerDigest],
      ));
      return ownerProof.length === 1 && ownerProof[0]?.owner_digest === ownerDigest
        && ownerLinks.length === 1 && parseCount(ownerLinks[0]?.count) === 0;
    }, { ...TIMEOUTS, operation: "postgres.social_owner_erasure.verify" });
  } catch {
    fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  }
}

/** Residue left by a refused retirement that a terminal receipt could not record. */
async function analyticsResidueRemains(
  primaryPool: PostgresPool,
  schema: PostgresSchemaConfig,
  ownerDigest: string,
): Promise<boolean> {
  try {
    return await hasPostgresAnalyticsOwnerResidue({
      primaryPool,
      ownerDigest,
      schema: { primarySchema: schema.primarySchema, ledgerSchema: schema.ledgerSchema },
    });
  } catch {
    fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  }
}

/** Retirement is idempotent; a refusal leaves the eraser resumable. */
async function retireOwnerAnalytics(
  primaryPool: PostgresPool,
  schema: PostgresSchemaConfig,
  ownerDigest: string,
): Promise<boolean> {
  try {
    const result = await retirePostgresAnalyticsOwner({
      primaryPool,
      ownerDigest,
      schema: { primarySchema: schema.primarySchema, ledgerSchema: schema.ledgerSchema },
    });
    return result.status === "complete";
  } catch {
    return false;
  }
}

async function incomplete(
  ledgerPool: PostgresPool,
  ledgerSchema: string,
  operationId: string,
  participantDigest: string,
  receiptDetails: ReceiptDetails,
  code: PostgresSocialOwnerErasureCode,
): Promise<PostgresSocialOwnerErasureResult> {
  await writeReceipt(ledgerPool, ledgerSchema, operationId, participantDigest, "failed", receiptDetails);
  return Object.freeze({ status: "incomplete", code });
}

function eraserError(error: unknown): PostgresSocialOwnerErasureError {
  if (error instanceof PostgresSocialOwnerErasureError) return error;
  if (error instanceof PostgresSocialOwnerErasurePreflightError) {
    return new PostgresSocialOwnerErasureError(error.code);
  }
  return new PostgresSocialOwnerErasureError("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
}

/**
 * Internal owner-operated erasure for one social PostgreSQL participant. This
 * is not a participant route. It fences and revokes the participant's
 * authority, records the independent tombstone and identity cooldown, deletes
 * exact stored objects before their source rows, removes the participant, and
 * then retires derived analytics for its owner digest. Every phase is recorded
 * in the independent ledger so an interrupted erasure resumes, and a completed
 * receipt is never downgraded by restore replay.
 */
export async function erasePostgresSocialOwner(
  options: PostgresSocialOwnerErasureOptions,
): Promise<PostgresSocialOwnerErasureResult> {
  if (!SOCIAL_PARTICIPANT.test(options?.participantId ?? "")
      || options.primaryPool === options.ledgerPool
      || typeof options.primaryPool?.connect !== "function"
      || typeof options.ledgerPool?.connect !== "function"
      || typeof options.objectStore?.deleteBatch !== "function") {
    fail("SOCIAL_OWNER_ERASURE_TARGET_INVALID");
  }
  let schemas: PostgresSchemaConfig;
  try { schemas = createPostgresSchemaConfig(options.schema); } catch {
    fail("SOCIAL_OWNER_ERASURE_TARGET_INVALID");
  }
  const participantDigest = await participantDeletionDigest(options.participantId);
  const operationId = await operationIdFor(participantDigest);
  const priorReceipt = await readReceipt(options.ledgerPool, schemas.ledgerSchema, operationId);
  if (priorReceipt !== null && priorReceipt.participant_digest !== participantDigest) {
    fail("SOCIAL_OWNER_ERASURE_LEDGER_FAILED");
  }
  const priorDetails = priorReceipt === null ? null : parseDetails(priorReceipt);
  if (priorReceipt !== null && priorDetails === null) fail("SOCIAL_OWNER_ERASURE_LEDGER_FAILED");

  let snapshot: FencedSnapshot;
  try {
    snapshot = await fenceAndRead(
      options.primaryPool, schemas, options.participantId, operationId,
      options.identityLinkSecret, options.identityLinkSecretVersion, Date.now(),
    );
  } catch (error) {
    throw eraserError(error);
  }
  if (snapshot.absent) {
    if (priorReceipt === null || priorDetails === null
        || !["objects_deleted", "primary_deleted", "completed"].includes(priorDetails.phase)
        || !await hasPostgresDeletionTombstone(
          options.ledgerPool, options.participantId, Date.now(), { schema: schemas },
        )
        || !await verifyPrimaryCompletion(
          options.primaryPool, schemas, options.participantId, priorDetails.ownerDigest,
        )) {
      fail("SOCIAL_OWNER_ERASURE_PARTICIPANT_NOT_FOUND");
    }
    if (priorReceipt.outcome !== "completed") {
      const resumed = details(priorDetails.ownerDigest, "primary_deleted", priorDetails.objectCount,
        priorDetails.identityCooldownRecorded);
      if (priorDetails.ownerDigest !== null
          && !await retireOwnerAnalytics(options.primaryPool, schemas, priorDetails.ownerDigest)) {
        return incomplete(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
          resumed, "SOCIAL_OWNER_ERASURE_ANALYTICS_RETIREMENT_FAILED");
      }
      await writeReceipt(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
        "completed", details(priorDetails.ownerDigest, "completed", priorDetails.objectCount,
          priorDetails.identityCooldownRecorded));
    } else if (priorDetails.ownerDigest !== null
        && await analyticsResidueRemains(options.primaryPool, schemas, priorDetails.ownerDigest)) {
      // Re-erasing a restored primary cannot downgrade the terminal receipt,
      // so a retirement refused then is completed on this retry instead.
      if (!await retireOwnerAnalytics(options.primaryPool, schemas, priorDetails.ownerDigest)) {
        return Object.freeze({ status: "incomplete", code: "SOCIAL_OWNER_ERASURE_ANALYTICS_RETIREMENT_FAILED" });
      }
    }
    return Object.freeze({ status: "already_complete", objectsDeleted: priorDetails.objectCount });
  }

  const ownerDigest = snapshot.ownerDigest;
  if (priorDetails !== null && priorDetails.ownerDigest !== ownerDigest) {
    fail("SOCIAL_OWNER_ERASURE_LEDGER_FAILED");
  }
  await recordPostgresDeletionTombstone(
    options.ledgerPool, options.participantId, Date.now(), { schema: schemas },
  );
  const identityCooldownRecorded = snapshot.identityCooldownDigest !== null;
  if (snapshot.identityCooldownDigest !== null) {
    await recordLedgerCooldown(options.ledgerPool, schemas.ledgerSchema, snapshot.identityCooldownDigest, Date.now());
  }
  const phase = (name: ReceiptDetails["phase"], objectCount: number) =>
    details(ownerDigest, name, objectCount, identityCooldownRecorded);
  await writeReceipt(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
    "started", phase("fenced", snapshot.objectCount));

  await writeReceipt(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
    "started", phase("object_delete_retry", snapshot.objectCount));
  let objectsDeleted: number;
  try {
    objectsDeleted = await deleteStoredObjects(
      options.primaryPool, schemas, options.objectStore, options.participantId,
    );
  } catch (error) {
    return incomplete(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
      phase("object_delete_retry", snapshot.objectCount), eraserError(error).code);
  }
  if (objectsDeleted !== snapshot.objectCount) {
    return incomplete(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
      phase("object_delete_retry", snapshot.objectCount), "SOCIAL_OWNER_ERASURE_REFERENCE_MISMATCH");
  }
  await writeReceipt(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
    "started", phase("objects_deleted", objectsDeleted));

  try {
    await finishPrimaryDelete(
      options.primaryPool, schemas, options.participantId, operationId, ownerDigest, objectsDeleted,
    );
  } catch (error) {
    return incomplete(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
      phase("objects_deleted", objectsDeleted), eraserError(error).code);
  }
  if (!await verifyPrimaryCompletion(options.primaryPool, schemas, options.participantId, ownerDigest)) {
    return incomplete(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
      phase("objects_deleted", objectsDeleted), "SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  }
  await writeReceipt(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
    "started", phase("primary_deleted", objectsDeleted));
  if (ownerDigest !== null && !await retireOwnerAnalytics(options.primaryPool, schemas, ownerDigest)) {
    return incomplete(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
      phase("primary_deleted", objectsDeleted), "SOCIAL_OWNER_ERASURE_ANALYTICS_RETIREMENT_FAILED");
  }
  await writeReceipt(options.ledgerPool, schemas.ledgerSchema, operationId, participantDigest,
    "completed", phase("completed", objectsDeleted));
  return Object.freeze({ status: "complete", objectsDeleted });
}
