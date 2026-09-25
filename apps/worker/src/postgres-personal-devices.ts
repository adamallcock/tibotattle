import { SESSION_COOKIE_NAME } from "./constants";
import { encodeBase64Url, hashCapability, timingSafeEqual } from "./crypto";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";

const SESSION_TOKEN = /^um_session_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UTC_MILLISECOND_INSTANT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const MAX_PARTICIPANT_DEVICES = 100;

interface PersonalSessionRow {
  readonly participant_id: string;
  readonly secret_hash: Uint8Array;
  readonly csrf_hash: Uint8Array;
  readonly session_scope: "personal" | "deletion_only";
  readonly session_state: "active" | "revoked";
  readonly expires_at: string;
  readonly participant_state: "active" | "deleting";
  // Worker personal-session authentication returns this field, but device
  // listing does not require fresh consent. Keep it selected for parity while
  // deliberately applying no consent-version gate here.
  readonly consent_version: string | null;
}

interface ParticipantDeviceRow {
  readonly id: string;
  readonly state: "active" | "revoked";
  readonly created_at: string;
  readonly expires_at: string;
  readonly last_used_at: string;
  readonly revoked_at: string | null;
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function parseSessionCookie(cookieHeader: string | null): { id: string; secret: string } {
  if (!cookieHeader) throw new ApiError(401, "AUTH_REQUIRED");
  const values = cookieHeader.split(";").flatMap((part) => {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== SESSION_COOKIE_NAME) return [];
    return [part.slice(index + 1).trim()];
  });
  if (values.length === 0) throw new ApiError(401, "AUTH_REQUIRED");
  if (values.length !== 1 || values[0]!.length > 128) {
    throw new ApiError(401, "AUTH_INVALID");
  }
  const match = SESSION_TOKEN.exec(values[0]!);
  if (!match?.[1] || !match[2]) throw new ApiError(401, "AUTH_INVALID");
  return { id: match[1], secret: match[2] };
}

function futureCanonicalInstant(value: unknown, nowEpoch: number): value is string {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch)
    && new Date(epoch).toISOString() === value
    && epoch > nowEpoch;
}

function storedHash(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(32);
}

/** Authenticate the Worker personal-session cookie against PostgreSQL state. */
export async function authenticatePostgresPersonalSession(
  pool: PostgresPool,
  cookieHeader: string | null,
  options: { readonly schema?: PostgresSchemaOptions; readonly nowEpoch?: number } = {},
): Promise<{ readonly participantId: string; readonly csrfToken: string }> {
  const parsed = parseSessionCookie(cookieHeader);
  const schemas = createPostgresSchemaConfig(options.schema);
  const primary = quotePostgresIdentifier(schemas.primarySchema);
  const nowEpoch = options.nowEpoch ?? Date.now();
  if (!Number.isFinite(nowEpoch)) throw new ApiError(401, "AUTH_INVALID");

  const result = await withPostgresRead(pool, async (client) => client.query<PersonalSessionRow>(
    `SELECT session.participant_id,
            session.secret_hash,
            session.csrf_hash,
            session.scope AS session_scope,
            session.state AS session_state,
            to_char(session.expires_at AT TIME ZONE 'UTC', '${UTC_MILLISECOND_INSTANT}') AS expires_at,
            participant.state AS participant_state,
            participant.consent_version
       FROM ${primary}."web_sessions" session
       JOIN ${primary}."participants" participant ON participant.id = session.participant_id
      WHERE session.id = $1`,
    [parsed.id],
  ), {
    operation: "personal_devices.session_read",
    statementTimeoutMilliseconds: 5_000,
    lockTimeoutMilliseconds: 2_000,
  });
  const row = result.rows[0] ?? null;

  const [presentedHash, csrfToken] = await Promise.all([
    hashCapability("session", parsed.id, parsed.secret),
    hashCapability("csrf", parsed.id, parsed.secret).then(
      (digest) => `um_csrf_${encodeBase64Url(digest)}`,
    ),
  ]);
  const csrfHash = await hashCapability("csrf-binding", parsed.id, csrfToken);
  const secretMatches = timingSafeEqual(presentedHash, storedHash(row?.secret_hash));
  const csrfMatches = timingSafeEqual(csrfHash, storedHash(row?.csrf_hash));
  if (!secretMatches || !csrfMatches || row === null
      || row.session_state !== "active"
      || !futureCanonicalInstant(row.expires_at, nowEpoch)) {
    throw new ApiError(401, "AUTH_INVALID");
  }
  if (row.session_scope === "deletion_only") throw new ApiError(401, "AUTH_INVALID");
  if (row.participant_state === "deleting") throw new ApiError(409, "PARTICIPANT_DELETING");
  if (typeof row.participant_id !== "string" || row.participant_id.length === 0) {
    throw new ApiError(401, "AUTH_INVALID");
  }
  return Object.freeze({ participantId: row.participant_id, csrfToken });
}

/** Apply the Worker session-bound same-origin and CSRF checks to a private-host mutation. */
export function assertPostgresPersonalSessionCsrf(
  request: Request,
  csrfToken: string,
): void {
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin) throw new ApiError(403, "CSRF_INVALID");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") {
    throw new ApiError(403, "CSRF_INVALID");
  }
  const value = request.headers.get("x-usage-monitor-csrf");
  if (typeof value !== "string"
      || value.length > 96
      || !timingSafeEqual(
        new TextEncoder().encode(value),
        new TextEncoder().encode(csrfToken),
      )) {
    throw new ApiError(403, "CSRF_INVALID");
  }
}

/** Read the same bounded device projection as Worker listParticipantDevices. */
export async function listPostgresParticipantDevices(
  pool: PostgresPool,
  participantId: string,
  options: { readonly schema?: PostgresSchemaOptions } = {},
): Promise<Array<{
  deviceId: string;
  state: "active" | "revoked";
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
}>> {
  if (typeof participantId !== "string" || participantId.length === 0) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  const schemas = createPostgresSchemaConfig(options.schema);
  const primary = quotePostgresIdentifier(schemas.primarySchema);
  const result = await withPostgresRead(pool, async (client) => client.query<ParticipantDeviceRow>(
    `SELECT device.id,
            device.state,
            to_char(device.issued_at AT TIME ZONE 'UTC', '${UTC_MILLISECOND_INSTANT}') AS created_at,
            to_char(device.expires_at AT TIME ZONE 'UTC', '${UTC_MILLISECOND_INSTANT}') AS expires_at,
            to_char(device.last_used_at AT TIME ZONE 'UTC', '${UTC_MILLISECOND_INSTANT}') AS last_used_at,
            CASE WHEN device.revoked_at IS NULL THEN NULL
                 ELSE to_char(device.revoked_at AT TIME ZONE 'UTC', '${UTC_MILLISECOND_INSTANT}')
            END AS revoked_at
       FROM ${primary}."device_credentials" device
      WHERE device.participant_id = $1
      ORDER BY device.issued_at DESC, device.id DESC
      LIMIT 101`,
    [participantId],
  ), {
    operation: "personal_devices.list",
    statementTimeoutMilliseconds: 5_000,
    lockTimeoutMilliseconds: 2_000,
  });
  if (result.rows.length > MAX_PARTICIPANT_DEVICES) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  return result.rows.map((row) => {
    if (typeof row.id !== "string"
        || (row.state !== "active" && row.state !== "revoked")
        || typeof row.created_at !== "string"
        || typeof row.expires_at !== "string"
        || typeof row.last_used_at !== "string"
        || (row.revoked_at !== null && typeof row.revoked_at !== "string")) {
      throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }
    return {
      deviceId: row.id,
      state: row.state,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    };
  });
}

/** Revoke an owner-held device and its pending upload capabilities atomically. */
export async function revokePostgresParticipantDevice(
  pool: PostgresPool,
  participantId: string,
  deviceId: string,
  options: { readonly schema?: PostgresSchemaOptions } = {},
): Promise<boolean> {
  if (typeof participantId !== "string" || participantId.length === 0) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId)) return false;

  const schemas = createPostgresSchemaConfig(options.schema);
  const primary = quotePostgresIdentifier(schemas.primarySchema);
  return withPostgresMutation(pool, async (client) => {
    const ownerDevice = await client.query<{ readonly id: string }>(
      `SELECT device.id
         FROM ${primary}."device_credentials" device
        WHERE device.id = $1 AND device.participant_id = $2
        FOR UPDATE`,
      [deviceId, participantId],
    );
    if (ownerDevice.rows.length !== 1) return false;

    const now = new Date().toISOString();
    await client.query(
      `UPDATE ${primary}."device_credentials"
          SET state = 'revoked', revoked_at = $3::timestamptz
        WHERE id = $1 AND participant_id = $2 AND state = 'active'`,
      [deviceId, participantId, now],
    );
    await client.query(
      `UPDATE ${primary}."device_upload_authorizations"
          SET state = 'revoked', revoked_at = $3::timestamptz,
              consume_lease_expires_at = NULL
        WHERE participant_id = $1 AND issued_by_device_id = $2
          AND state IN ('unused', 'consuming')`,
      [participantId, deviceId, now],
    );
    return true;
  }, {
    operation: "personal_devices.revoke",
    statementTimeoutMilliseconds: 5_000,
    lockTimeoutMilliseconds: 2_000,
  });
}
