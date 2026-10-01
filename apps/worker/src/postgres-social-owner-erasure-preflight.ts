import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";

const PARTICIPANT_ID = /^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const TOKEN = /^[0-9a-f]{32}$/u;
const TIMEOUTS = Object.freeze({
  operation: "postgres.social_erasure.preflight",
  statementTimeoutMilliseconds: 10_000,
  lockTimeoutMilliseconds: 5_000,
});

export type PostgresSocialOwnerErasurePreflightCode =
  | "SOCIAL_OWNER_ERASURE_TARGET_INVALID"
  | "SOCIAL_OWNER_ERASURE_PARTICIPANT_NOT_FOUND"
  | "SOCIAL_OWNER_ERASURE_STATE_UNEXPECTED"
  | "SOCIAL_OWNER_ERASURE_FAMILY_UNSUPPORTED"
  | "SOCIAL_OWNER_ERASURE_AUTHORITY_MISMATCH"
  | "SOCIAL_OWNER_ERASURE_UPLOAD_IN_PROGRESS"
  | "SOCIAL_OWNER_ERASURE_PENDING_UNATTRIBUTED"
  | "SOCIAL_OWNER_ERASURE_REFERENCE_MISMATCH"
  | "SOCIAL_OWNER_ERASURE_GRANT_POLICY_REQUIRED"
  | "SOCIAL_OWNER_ERASURE_READBACK_FAILED";

export class PostgresSocialOwnerErasurePreflightError extends Error {
  readonly code: PostgresSocialOwnerErasurePreflightCode;

  constructor(code: PostgresSocialOwnerErasurePreflightCode) {
    super(code);
    this.name = "PostgresSocialOwnerErasurePreflightError";
    this.code = code;
  }
}

export interface PostgresSocialOwnerErasurePreflightOptions {
  readonly primaryPool: PostgresPool;
  readonly participantId: string;
  readonly schema?: PostgresSchemaOptions;
}

/**
 * Transaction-only validation context for the owner eraser. Callers must first
 * lock the exact participant row; the optional fence then permits only the
 * same already-claimed deletion to resume. This keeps the detailed inspection
 * logic shared with the public read-only preflight without treating the
 * preflight's result as authorization.
 */
export interface PostgresSocialOwnerErasureClientInspectionOptions {
  readonly client: PostgresClient;
  readonly participantId: string;
  readonly schema: PostgresSchemaOptions;
  readonly deletionFenceId: string;
  readonly lockRows?: boolean;
}

export interface PostgresSocialOwnerErasureInventory {
  readonly status: "inspectable";
  /** This inspection is read-only and is not authorization or proof of erasure. */
  readonly erasureAuthorized: false;
  readonly identityCooldownRequired: boolean;
  readonly ownerDigest: string | null;
  readonly participantFamilyTables: number;
  readonly webSessions: number;
  readonly pairings: number;
  readonly deviceCredentials: number;
  readonly communityGrants: number;
  readonly objectCounts: Readonly<Record<"telemetry" | "telemetry_v1" | "telemetry_v11" | "telemetry_v12", number>>;
}

interface ParticipantRow {
  readonly id: string;
  readonly state: string;
  readonly owner_kind: string;
  readonly deletion_session_id: string | null;
  readonly identity_link_key: string | null;
}

interface ObjectInventoryRow {
  readonly source: "telemetry" | "telemetry_v1" | "telemetry_v11" | "telemetry_v12";
  readonly ref_id: string;
  readonly cursor_id: string;
  readonly object_key: string;
  readonly created_at: string;
  readonly pending_object_key: string | null;
  readonly object_kind: string | null;
  readonly reconciliation_state: string | null;
  readonly registration_token: string | null;
}

interface Cursor {
  readonly source: ObjectInventoryRow["source"];
  readonly cursorId: string;
}

export interface PostgresSocialOwnerErasureObjectCursor {
  readonly source: ObjectInventoryRow["source"];
  readonly cursorId: string;
}

export interface PostgresSocialOwnerErasureObjectRef {
  readonly source: ObjectInventoryRow["source"];
  readonly id: string;
  readonly key: string;
  readonly createdAt: string;
  /** A pending registration token exists only for a still-registered live row. */
  readonly registrationToken: string | null;
}

export interface PostgresSocialOwnerErasureObjectPage {
  readonly objects: readonly PostgresSocialOwnerErasureObjectRef[];
  readonly nextCursor: PostgresSocialOwnerErasureObjectCursor | null;
}

function fail(code: PostgresSocialOwnerErasurePreflightCode): never {
  throw new PostgresSocialOwnerErasurePreflightError(code);
}

function table(schema: string, name: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(name)}`;
}

function rows<Row extends object>(value: unknown): readonly Row[] {
  if (value === null || typeof value !== "object") fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  const result = Reflect.get(value, "rows");
  if (!Array.isArray(result)) fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  return result as readonly Row[];
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  return parsed;
}

function safeError(error: unknown): Error | null {
  return error instanceof PostgresSocialOwnerErasurePreflightError ? error : null;
}

/*
 * Keep this list local to the preflight boundary: it is an explicit allowlist,
 * not an instruction to cascade through any table the database happens to
 * contain. It currently mirrors the accountless eraser's participant-owned
 * families plus the social grant family; storage_v12_event_sources (staged
 * 0046) and telemetry_contribution_admission_windows (primary 0061,
 * legacy_contribution_admission: counters only, no object) cascade
 * with their participant; storage_v11_append_transitions (primary 0060:
 * immutable v1.1 head classifications, no object) cascades with its
 * telemetry_v11_domains generation. The two erasers intentionally remain
 * independently fail-closed until a reviewed shared contract replaces them.
 */
const KNOWN_PARTICIPANT_TABLES = new Set(`
  accountless_public_history_retention accountless_public_history_import_claims
  accountless_upload_owners accountless_v11_device_authorizations
  accountless_v12_device_authorizations attribution_enrollments community_analytical_input_versions
  community_model_history_dependencies current_queue device_credential_rotations device_credentials
  device_pairing_events device_pairings device_upload_authorizations enrollment_grants historical_telemetry_v11_chunk_headers
  historical_telemetry_v11_manifest_headers historical_telemetry_v1_chunk_headers identity_reenrollment_cooldowns
  input_source_digests input_versions participant_community_eligibility prepared_source_days recovery_retry_receipts
  storage_v11_append_transitions storage_v11_event_sources storage_v11_owner_links storage_v12_event_sources
  telemetry_additive_correction_facts telemetry_additive_correction_receipts telemetry_contribution_admission_windows
  telemetry_contribution_occurrences telemetry_contributions
  telemetry_correction_receipts telemetry_records telemetry_transport_device_floors
  telemetry_transport_floor_rollbacks telemetry_transport_participant_floors telemetry_usage_correction_history
  telemetry_v11_chunks telemetry_v11_day_manifests telemetry_v11_device_consents telemetry_v11_domain_heads
  telemetry_v11_domain_predecessors telemetry_v11_domains telemetry_v12_chunks telemetry_v12_day_manifests
  telemetry_v12_device_capabilities telemetry_v12_domain_heads telemetry_v12_domain_predecessors
  telemetry_v12_domains telemetry_v1_chunk_admission_windows telemetry_v1_chunks telemetry_v1_device_consents
  telemetry_v1_quota_fit_rows telemetry_v1_records typed_telemetry_owner_memberships typed_v1_event_sources
  upload_authorizations web_sessions
`.trim().split(/\s+/u));

const ACCOUNTLESS_PARTICIPANT_TABLES = Object.freeze([
  "accountless_public_history_retention",
  "accountless_public_history_import_claims",
  "accountless_upload_owners",
  "accountless_v11_device_authorizations",
  "accountless_v12_device_authorizations",
]);

async function assertKnownParticipantTables(
  client: PostgresClient,
  primarySchema: string,
): Promise<number> {
  const found = rows<{ readonly table_name: string }>(await client.query(
    `SELECT DISTINCT candidate.relname::text AS table_name
       FROM pg_class candidate
       JOIN pg_namespace candidate_schema ON candidate_schema.oid=candidate.relnamespace
       JOIN pg_class participants
         ON participants.relnamespace=candidate_schema.oid AND participants.relname='participants'
        AND participants.relkind='r'
      WHERE candidate_schema.nspname=$1 AND candidate.relkind='r'
        AND (
          EXISTS (SELECT 1 FROM information_schema.columns columns
                   WHERE columns.table_schema=$1 AND columns.table_name=candidate.relname
                     AND columns.column_name='participant_id')
          OR EXISTS (SELECT 1 FROM pg_constraint ownership
                      WHERE ownership.conrelid=candidate.oid
                        AND ownership.confrelid=participants.oid AND ownership.contype='f')
        )
      ORDER BY table_name`,
    [primarySchema],
  ));
  if (found.some((row) => typeof row.table_name !== "string"
      || !KNOWN_PARTICIPANT_TABLES.has(row.table_name))) {
    fail("SOCIAL_OWNER_ERASURE_FAMILY_UNSUPPORTED");
  }
  return found.length;
}

function objectInventorySql(primarySchema: string): string {
  const live = (
    name: "telemetry_contributions" | "telemetry_v1_chunks" | "telemetry_v11_chunks" | "telemetry_v12_chunks",
    source: ObjectInventoryRow["source"],
  ) => `SELECT '${source}'::text AS source, source.id::text AS ref_id,
            ('0:' || source.id)::text AS cursor_id, source.r2_key::text AS object_key,
            source.created_at::text AS created_at, pending.object_key::text AS pending_object_key,
            pending.object_kind::text AS object_kind,
            pending.reconciliation_state::text AS reconciliation_state,
            pending.registration_token::text AS registration_token
       FROM ${table(primarySchema, name)} source
       LEFT JOIN ${table(primarySchema, "pending_objects")} pending
         ON pending.contribution_id=source.id
      WHERE source.participant_id=$1`;
  const archived = (
    name: "historical_telemetry_v1_chunk_headers" | "historical_telemetry_v11_chunk_headers",
    source: "telemetry_v1" | "telemetry_v11",
  ) => `SELECT '${source}'::text AS source,
            (archive.source_import_id || ':' || archive.id)::text AS ref_id,
            ('1:' || archive.source_import_id || ':' || archive.id)::text AS cursor_id,
            archive.r2_key::text AS object_key, archive.created_at::text AS created_at,
            NULL::text AS pending_object_key, NULL::text AS object_kind,
            NULL::text AS reconciliation_state, NULL::text AS registration_token
       FROM ${table(primarySchema, name)} archive
      WHERE archive.participant_id=$1`;
  return `SELECT * FROM (${[
    live("telemetry_contributions", "telemetry"),
    live("telemetry_v1_chunks", "telemetry_v1"), archived("historical_telemetry_v1_chunk_headers", "telemetry_v1"),
    live("telemetry_v11_chunks", "telemetry_v11"), archived("historical_telemetry_v11_chunk_headers", "telemetry_v11"),
    live("telemetry_v12_chunks", "telemetry_v12"),
  ].join(" UNION ALL ")}) inventory
  WHERE $2::text IS NULL OR (source,cursor_id) > ($2::text,$3::text)
  ORDER BY source,cursor_id LIMIT 100`;
}

function validateObject(row: ObjectInventoryRow): void {
  if (!["telemetry", "telemetry_v1", "telemetry_v11", "telemetry_v12"].includes(row.source)
      || typeof row.ref_id !== "string" || row.ref_id.length === 0 || row.ref_id.length > 1024
      || typeof row.cursor_id !== "string" || row.cursor_id.length === 0 || row.cursor_id.length > 2048
      || typeof row.object_key !== "string" || row.object_key.length === 0
      || new TextEncoder().encode(row.object_key).byteLength > 1024
      || /[\u0000-\u001f\u007f]/u.test(row.object_key)
      || !Number.isFinite(Date.parse(row.created_at))) {
    fail("SOCIAL_OWNER_ERASURE_REFERENCE_MISMATCH");
  }
  const hasRegistration = row.registration_token !== null || row.object_kind !== null
    || row.reconciliation_state !== null;
  if (hasRegistration && (row.object_kind !== row.source
      || row.pending_object_key !== row.object_key
      || row.reconciliation_state !== "registered"
      || !TOKEN.test(row.registration_token ?? ""))) {
    fail("SOCIAL_OWNER_ERASURE_REFERENCE_MISMATCH");
  }
  if (row.source === "telemetry_v1" || row.source === "telemetry_v11") {
    const archivedCursor = row.cursor_id.startsWith("1:");
    if (archivedCursor && hasRegistration) fail("SOCIAL_OWNER_ERASURE_REFERENCE_MISMATCH");
  }
}

async function inventoryObjects(
  client: PostgresClient,
  primarySchema: string,
  participantId: string,
): Promise<PostgresSocialOwnerErasureInventory["objectCounts"]> {
  const result: Record<keyof PostgresSocialOwnerErasureInventory["objectCounts"], number> = {
    telemetry: 0, telemetry_v1: 0, telemetry_v11: 0, telemetry_v12: 0,
  };
  let cursor: Cursor | null = null;
  for (;;) {
    const page = await readPostgresSocialOwnerErasureObjectPage(
      client, { primarySchema }, participantId, cursor,
    );
    if (page.objects.length === 0) break;
    for (const object of page.objects) {
      result[object.source] += 1;
      if (!Number.isSafeInteger(result[object.source])) fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
    }
    cursor = page.nextCursor;
  }
  return Object.freeze(result);
}

/**
 * Read the next bounded set of exact object identities using the same closed
 * family inventory validated by preflight. Keys remain inside the private
 * erasure adapter; callers must not return them through an HTTP surface or
 * include them in receipts.
 */
export async function readPostgresSocialOwnerErasureObjectPage(
  client: PostgresClient,
  schemaOptions: PostgresSchemaOptions,
  participantId: string,
  cursor: PostgresSocialOwnerErasureObjectCursor | null = null,
): Promise<PostgresSocialOwnerErasureObjectPage> {
  if (!PARTICIPANT_ID.test(participantId)
      || typeof client?.query !== "function"
      || cursor !== null && (!Object.hasOwn({ telemetry: true, telemetry_v1: true, telemetry_v11: true, telemetry_v12: true }, cursor.source)
        || typeof cursor.cursorId !== "string" || cursor.cursorId.length === 0 || cursor.cursorId.length > 2048)) {
    fail("SOCIAL_OWNER_ERASURE_TARGET_INVALID");
  }
  let primarySchema: string;
  try { primarySchema = createPostgresSchemaConfig(schemaOptions).primarySchema; } catch {
    fail("SOCIAL_OWNER_ERASURE_TARGET_INVALID");
  }
  try {
    const page = rows<ObjectInventoryRow>(await client.query(objectInventorySql(primarySchema), [
      participantId, cursor?.source ?? null, cursor?.cursorId ?? null,
    ]));
    const objects = page.map((row) => {
      validateObject(row);
      return Object.freeze({
        source: row.source,
        id: row.ref_id,
        key: row.object_key,
        createdAt: new Date(Date.parse(row.created_at)).toISOString(),
        registrationToken: row.registration_token,
      });
    });
    const last = page.at(-1);
    return Object.freeze({
      objects: Object.freeze(objects),
      nextCursor: last === undefined ? null : Object.freeze({ source: last.source, cursorId: last.cursor_id }),
    });
  } catch (error) {
    if (error instanceof PostgresSocialOwnerErasurePreflightError) throw error;
    fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  }
}

async function hasUnattributedPendingObject(client: PostgresClient, primarySchema: string): Promise<boolean> {
  const matches = [
    ["telemetry_contributions", "telemetry"],
    ["telemetry_v1_chunks", "telemetry_v1"],
    ["telemetry_v11_chunks", "telemetry_v11"],
    ["telemetry_v12_chunks", "telemetry_v12"],
  ] as const;
  const known = matches.map(([name, kind]) =>
    `NOT EXISTS (SELECT 1 FROM ${table(primarySchema, name)} source
                  WHERE source.id=pending.contribution_id AND source.r2_key=pending.object_key
                    AND pending.object_kind='${kind}')`).join(" AND ");
  const result = rows<{ readonly count: string | number }>(await client.query(
    `SELECT count(*)::text AS count FROM ${table(primarySchema, "pending_objects")} pending
      WHERE pending.object_kind IN ('synthetic','telemetry','telemetry_v1','telemetry_v11','telemetry_v12')
        AND (${known})`,
  ));
  return result.length !== 1 || count(result[0]?.count) > 0;
}

/**
 * Read-only evidence boundary for social owner erasure. It inventories social
 * pairing/device authority and every GCS-backed source family without
 * mutating either database or deleting objects. The eraser reuses the same
 * validation against its participant-row-locked transaction before fencing.
 */
export async function inspectPostgresSocialOwnerErasureTarget(
  options: PostgresSocialOwnerErasurePreflightOptions,
): Promise<PostgresSocialOwnerErasureInventory> {
  if (!PARTICIPANT_ID.test(options?.participantId ?? "")
      || typeof options.primaryPool?.connect !== "function") {
    fail("SOCIAL_OWNER_ERASURE_TARGET_INVALID");
  }
  let schema: string;
  try { schema = createPostgresSchemaConfig(options.schema).primarySchema; } catch {
    fail("SOCIAL_OWNER_ERASURE_TARGET_INVALID");
  }
  try {
    return await withPostgresRead(options.primaryPool, async (client) => {
      return inspectPostgresSocialOwnerErasureClient({
        client,
        participantId: options.participantId,
        schema: { primarySchema: schema },
        deletionFenceId: "",
        lockRows: false,
      });
    }, { ...TIMEOUTS, preserveSafeError: safeError });
  } catch (error) {
    if (error instanceof PostgresSocialOwnerErasurePreflightError) throw error;
    fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  }
}

/**
 * Repeat the reviewed authority/source-family inventory from inside a caller's
 * already-open, participant-row-locked transaction. The caller supplies its
 * deterministic fence; an active row is allowed only before this transaction
 * claims it, while a deleting row is accepted only for that same fence.
 */
export async function inspectPostgresSocialOwnerErasureClient(
  options: PostgresSocialOwnerErasureClientInspectionOptions,
): Promise<PostgresSocialOwnerErasureInventory> {
  if (!PARTICIPANT_ID.test(options?.participantId ?? "")
      || typeof options.client?.query !== "function"
      || typeof options.deletionFenceId !== "string"
      || options.deletionFenceId !== "" && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(options.deletionFenceId)) {
    fail("SOCIAL_OWNER_ERASURE_TARGET_INVALID");
  }
  let schema: string;
  try { schema = createPostgresSchemaConfig(options.schema).primarySchema; } catch {
    fail("SOCIAL_OWNER_ERASURE_TARGET_INVALID");
  }
  try {
    const client = options.client;
    const participants = rows<ParticipantRow>(await client.query(
      `SELECT id,state,owner_kind,deletion_session_id,identity_link_key
         FROM ${table(schema, "participants")} WHERE id=$1 LIMIT 2`, [options.participantId],
    ));
    if (participants.length === 0) fail("SOCIAL_OWNER_ERASURE_PARTICIPANT_NOT_FOUND");
    const participant = participants[0]!;
    const stateAllowed = options.deletionFenceId === ""
      ? participant.state === "active" && participant.deletion_session_id === null
      : participant.state === "active" && participant.deletion_session_id === null
        || participant.state === "deleting" && participant.deletion_session_id === options.deletionFenceId;
    if (participants.length !== 1 || participant.owner_kind !== "social" || !stateAllowed
        || participant.identity_link_key !== null && !DIGEST.test(participant.identity_link_key)) {
      fail("SOCIAL_OWNER_ERASURE_STATE_UNEXPECTED");
    }
    const participantFamilyTables = await assertKnownParticipantTables(client, schema);
    for (const name of ACCOUNTLESS_PARTICIPANT_TABLES) {
      const ownerColumn = name === "accountless_public_history_import_claims"
        ? "target_participant_id" : "participant_id";
      const result = rows<{ readonly count: string | number }>(await client.query(
        `SELECT count(*)::text AS count FROM ${table(schema, name)} WHERE ${quotePostgresIdentifier(ownerColumn)}=$1`,
        [options.participantId],
      ));
      if (result.length !== 1 || count(result[0]?.count) !== 0) fail("SOCIAL_OWNER_ERASURE_FAMILY_UNSUPPORTED");
    }
    // This legacy typed projection owns a RESTRICT edge to participants and
    // may retain normalized source records with no GCS key to enumerate. It is
    // not covered by the live/history object inventory, so only a dedicated
    // typed-family eraser may accept a participant that still has this map.
    const typedMemberships = rows<{ readonly count: string | number }>(await client.query(
      `SELECT count(*)::text AS count FROM ${table(schema, "typed_telemetry_owner_memberships")}
        WHERE participant_id=$1`, [options.participantId],
    ));
    if (typedMemberships.length !== 1 || count(typedMemberships[0]?.count) !== 0) {
      fail("SOCIAL_OWNER_ERASURE_FAMILY_UNSUPPORTED");
    }
    const lock = options.lockRows === true ? " FOR UPDATE" : "";
    const sessions = rows<{ readonly id: string; readonly scope: string; readonly state: string }>(await client.query(
      `SELECT id,scope,state FROM ${table(schema, "web_sessions")} WHERE participant_id=$1 ORDER BY id${lock}`,
      [options.participantId],
    ));
    if (sessions.some((session) => !["personal", "deletion_only"].includes(session.scope)
        || !["active", "revoked"].includes(session.state))) fail("SOCIAL_OWNER_ERASURE_AUTHORITY_MISMATCH");
    const sessionIds = new Set(sessions.map((session) => session.id));
    const pairings = rows<{
      readonly id: string; readonly issued_by_session_id: string; readonly state: string;
      readonly claimed_device_id: string | null;
    }>(await client.query(
      `SELECT id,issued_by_session_id,state,claimed_device_id
         FROM ${table(schema, "device_pairings")} WHERE participant_id=$1 ORDER BY id${lock}`,
      [options.participantId],
    ));
    const pairingById = new Map<string, typeof pairings[number]>();
    for (const pairing of pairings) {
      if (!sessionIds.has(pairing.issued_by_session_id)
          || !["unused", "consumed", "revoked"].includes(pairing.state)
          || pairing.state === "consumed" && typeof pairing.claimed_device_id !== "string"
          || pairing.state !== "consumed" && pairing.claimed_device_id !== null) {
        fail("SOCIAL_OWNER_ERASURE_AUTHORITY_MISMATCH");
      }
      pairingById.set(pairing.id, pairing);
    }
    const credentials = rows<{
      readonly id: string; readonly authority_kind: string; readonly state: string;
      readonly paired_via_pairing_id: string | null; readonly accountless_enrollment_device_id: string | null;
    }>(await client.query(
      `SELECT id,authority_kind,state,paired_via_pairing_id,accountless_enrollment_device_id
         FROM ${table(schema, "device_credentials")} WHERE participant_id=$1 ORDER BY id${lock}`,
      [options.participantId],
    ));
    const credentialsById = new Map(credentials.map((credential) => [credential.id, credential]));
    for (const credential of credentials) {
      const pairing = credential.paired_via_pairing_id === null ? undefined : pairingById.get(credential.paired_via_pairing_id);
      if (credential.authority_kind !== "social" || !["active", "revoked"].includes(credential.state)
          || credential.accountless_enrollment_device_id !== null || !pairing
          || pairing.state !== "consumed" || pairing.claimed_device_id !== credential.id) {
        fail("SOCIAL_OWNER_ERASURE_AUTHORITY_MISMATCH");
      }
    }
    for (const pairing of pairings) {
      if (pairing.state === "consumed") {
        const credential = credentialsById.get(pairing.claimed_device_id!);
        if (credential?.paired_via_pairing_id !== pairing.id) fail("SOCIAL_OWNER_ERASURE_AUTHORITY_MISMATCH");
      }
    }
    for (const [name, stateful] of [
      ["telemetry_v1_device_consents", false],
      ["telemetry_v11_device_consents", false],
      ["telemetry_v12_device_capabilities", true],
    ] as const) {
      const consentRows = rows<{
        readonly device_id: string;
        readonly state?: string;
      }>(await client.query(
        `SELECT device_id${stateful ? ",state" : ""}
           FROM ${table(schema, name)} WHERE participant_id=$1 ORDER BY device_id${lock}`,
        [options.participantId],
      ));
      if (consentRows.some((consent) => !credentialsById.has(consent.device_id)
          || stateful && !["accepted", "revoked"].includes(consent.state ?? ""))) {
        fail("SOCIAL_OWNER_ERASURE_AUTHORITY_MISMATCH");
      }
    }
    const badEvents = rows<{ readonly count: string | number }>(await client.query(
      `SELECT count(*)::text AS count FROM ${table(schema, "device_pairing_events")} event
        WHERE event.participant_id=$1 AND NOT EXISTS (
          SELECT 1 FROM ${table(schema, "device_pairings")} pairing
           WHERE pairing.id=event.pairing_id AND pairing.participant_id=event.participant_id
        )`, [options.participantId],
    ));
    if (badEvents.length !== 1 || count(badEvents[0]?.count) !== 0) fail("SOCIAL_OWNER_ERASURE_AUTHORITY_MISMATCH");
    const deviceUploads = rows<{
      readonly id: string; readonly state: string; readonly issued_by_device_id: string;
    }>(await client.query(
      `SELECT id,state,issued_by_device_id FROM ${table(schema, "device_upload_authorizations")}
        WHERE participant_id=$1 ORDER BY id${lock}`, [options.participantId],
    ));
    if (deviceUploads.some((upload) => upload.state === "consuming")) fail("SOCIAL_OWNER_ERASURE_UPLOAD_IN_PROGRESS");
    if (deviceUploads.some((upload) => !["unused", "consuming", "consumed", "revoked"].includes(upload.state)
        || !credentialsById.has(upload.issued_by_device_id))) fail("SOCIAL_OWNER_ERASURE_AUTHORITY_MISMATCH");
    const webUploads = rows<{
      readonly id: string; readonly issued_by_session_id: string; readonly state: string;
    }>(await client.query(
      `SELECT id,issued_by_session_id,state FROM ${table(schema, "upload_authorizations")}
        WHERE participant_id=$1 ORDER BY id${lock}`, [options.participantId],
    ));
    if (webUploads.some((upload) => upload.state === "consuming")) fail("SOCIAL_OWNER_ERASURE_UPLOAD_IN_PROGRESS");
    if (webUploads.some((upload) => !["unused", "consuming", "consumed", "revoked"].includes(upload.state)
        || !sessionIds.has(upload.issued_by_session_id))) {
      fail("SOCIAL_OWNER_ERASURE_AUTHORITY_MISMATCH");
    }
    const grants = rows<{ readonly count: string | number }>(await client.query(
      `SELECT count(*)::text AS count FROM ${table(schema, "enrollment_grants")}
        WHERE redeemed_participant_id=$1`, [options.participantId],
    ));
    const communityGrants = count(grants[0]?.count);
    if (grants.length !== 1) fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
    if (communityGrants > 0) fail("SOCIAL_OWNER_ERASURE_GRANT_POLICY_REQUIRED");
    const ownerLinks = rows<{ readonly owner_digest: string; readonly state: string }>(await client.query(
      `SELECT owner_digest,state FROM ${table(schema, "storage_v11_owner_links")}
        WHERE participant_id=$1 LIMIT 2${lock}`, [options.participantId],
    ));
    if (ownerLinks.length > 1 || ownerLinks.some((link) => !DIGEST.test(link.owner_digest)
        || !["active", "withdrawn"].includes(link.state))) fail("SOCIAL_OWNER_ERASURE_STATE_UNEXPECTED");
    const objectCounts = await inventoryObjects(client, schema, options.participantId);
    if (await hasUnattributedPendingObject(client, schema)) fail("SOCIAL_OWNER_ERASURE_PENDING_UNATTRIBUTED");
    return Object.freeze({
      status: "inspectable", erasureAuthorized: false,
      identityCooldownRequired: participant.identity_link_key !== null,
      ownerDigest: ownerLinks[0]?.owner_digest ?? null,
      participantFamilyTables, webSessions: sessions.length, pairings: pairings.length,
      deviceCredentials: credentials.length, communityGrants, objectCounts,
    });
  } catch (error) {
    if (error instanceof PostgresSocialOwnerErasurePreflightError) throw error;
    fail("SOCIAL_OWNER_ERASURE_READBACK_FAILED");
  }
}
