import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MILLISECONDS,
  UPLOAD_AUTHORIZATION_TTL_MILLISECONDS,
  UPLOAD_CONSUME_LEASE_MILLISECONDS,
} from "./constants";
import {
  encodeBase64Url,
  hashCapability,
  randomSecret,
  timingSafeEqual,
} from "./crypto";
import { ApiError } from "./errors";
import type { TelemetryAuthorityBackend } from "./telemetry-authority-backend";

type SessionSource = D1Database | TelemetryAuthorityBackend;

function authorityBackend(source: SessionSource): TelemetryAuthorityBackend | null {
  return typeof (source as Partial<TelemetryAuthorityBackend>).sessions?.read === "function"
    ? source as TelemetryAuthorityBackend : null;
}

export interface SessionMaterial {
  id: string;
  participantId: string;
  token: string;
  secretHash: Uint8Array;
  csrfToken: string;
  csrfHash: Uint8Array;
  scope: "personal" | "deletion_only";
  issuedAt: string;
  expiresAt: string;
}

export interface SessionPrincipal {
  participantId: string;
  participantCreatedAt: string;
  participantState: "active" | "deleting";
  consentVersion: string;
  sessionId: string;
  sessionScope: "personal" | "deletion_only";
  sessionSecret: string;
  csrfToken: string;
  expiresAt: string;
}

interface SessionRow {
  session_id: string;
  participant_id: string;
  secret_hash: ArrayBuffer;
  csrf_hash: ArrayBuffer;
  session_scope: "personal" | "deletion_only";
  expires_at: string;
  session_state: "active" | "revoked";
  participant_created_at: string;
  participant_state: "active" | "deleting";
  consent_version: string;
}

export interface UploadAuthorizationMaterial {
  id: string;
  participantId: string;
  issuedBySessionId: string;
  encoded: string;
  secretHash: Uint8Array;
  envelopeDigest: string;
  bodyBytes: number;
  contentType: "application/json";
  issuedAt: string;
  expiresAt: string;
}

interface UploadAuthorizationRow {
  id: string;
  participant_id: string;
  issued_by_session_id: string;
  secret_hash: ArrayBuffer;
  envelope_digest: string;
  body_bytes: number;
  content_type: "application/json";
  state: "unused" | "consuming" | "consumed" | "revoked";
  expires_at: string;
  participant_state: "active" | "deleting";
  issuing_session_state: "active" | "revoked";
  issuing_session_expires_at: string;
}

function bytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
}

function futureInstant(value: string, nowEpoch = Date.now()): boolean {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch)
    && new Date(epoch).toISOString() === value
    && epoch > nowEpoch;
}

function parseSessionToken(value: string): { id: string; secret: string } {
  const match = /^um_session_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u
    .exec(value);
  if (!match?.[1] || !match[2]) throw new ApiError(401, "AUTH_INVALID");
  return { id: match[1], secret: match[2] };
}

function sessionCookieValue(cookieHeader: string | null): string {
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
  return values[0]!;
}

export function hasSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((part) => (
    part.slice(0, Math.max(0, part.indexOf("="))).trim() === SESSION_COOKIE_NAME
  ));
}

export async function createSessionMaterial(
  participantId: string,
  nowEpoch = Date.now(),
  scope: "personal" | "deletion_only" = "personal",
): Promise<SessionMaterial> {
  const id = crypto.randomUUID();
  const secret = randomSecret(32);
  return createSessionMaterialFromSecret(
    participantId,
    id,
    secret,
    new Date(nowEpoch).toISOString(),
    new Date(nowEpoch + SESSION_TTL_MILLISECONDS).toISOString(),
    scope,
  );
}

export async function createSessionMaterialFromSecret(
  participantId: string,
  id: string,
  secret: string,
  issuedAt: string,
  expiresAt: string,
  scope: "personal" | "deletion_only" = "personal",
): Promise<SessionMaterial> {
  const token = `um_session_${id}.${secret}`;
  const csrfToken = `um_csrf_${encodeBase64Url(await hashCapability("csrf", id, secret))}`;
  const [secretHash, csrfHash] = await Promise.all([
    hashCapability("session", id, secret),
    hashCapability("csrf-binding", id, csrfToken),
  ]);
  return {
    id,
    participantId,
    token,
    secretHash,
    csrfToken,
    csrfHash,
    scope,
    issuedAt,
    expiresAt,
  };
}

export function sessionInsert(
  db: D1Database,
  session: SessionMaterial,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO web_sessions (
      id, participant_id, secret_hash, csrf_hash, scope, state,
      issued_at, expires_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).bind(
    session.id,
    session.participantId,
    session.secretHash,
    session.csrfHash,
    session.scope,
    session.issuedAt,
    session.expiresAt,
    session.issuedAt,
  );
}

export function sessionCookie(session: SessionMaterial): string {
  const maxAge = Math.max(
    0,
    Math.floor((Date.parse(session.expiresAt) - Date.parse(session.issuedAt)) / 1000),
  );
  return `${SESSION_COOKIE_NAME}=${session.token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

export async function authenticateSession(
  db: SessionSource,
  cookieHeader: string | null,
  {
    allowDeleting = false,
    allowDeletionOnly = false,
  }: {
    allowDeleting?: boolean;
    allowDeletionOnly?: boolean;
  } = {},
): Promise<SessionPrincipal> {
  const parsed = parseSessionToken(sessionCookieValue(cookieHeader));
  const backend = authorityBackend(db);
  const authorityRow = backend ? await backend.sessions.read(parsed.id) : null;
  const row = backend ? authorityRow && {
    session_id: authorityRow.id,
    participant_id: authorityRow.participantId,
    secret_hash: authorityRow.secretHash,
    csrf_hash: authorityRow.csrfHash,
    expires_at: authorityRow.expiresAt,
    session_state: authorityRow.state,
    session_scope: authorityRow.scope,
    participant_created_at: authorityRow.participantCreatedAt,
    participant_state: authorityRow.participantState,
    consent_version: authorityRow.consentVersion,
  } : await (db as D1Database).prepare(
    `SELECT
      s.id AS session_id, s.participant_id, s.secret_hash, s.csrf_hash,
      s.expires_at, s.state AS session_state, s.scope AS session_scope,
      p.created_at AS participant_created_at, p.state AS participant_state,
      p.consent_version
    FROM web_sessions s
    JOIN participants p ON p.id = s.participant_id
    WHERE s.id = ?`,
  ).bind(parsed.id).first<SessionRow>();
  const [presentedHash, csrfToken] = await Promise.all([
    hashCapability("session", parsed.id, parsed.secret),
    hashCapability("csrf", parsed.id, parsed.secret).then(
      (digest) => `um_csrf_${encodeBase64Url(digest)}`,
    ),
  ]);
  const csrfHash = await hashCapability("csrf-binding", parsed.id, csrfToken);
  const secretMatches = timingSafeEqual(
    presentedHash,
    row ? bytes(row.secret_hash) : new Uint8Array(32),
  );
  const csrfMatches = timingSafeEqual(
    csrfHash,
    row ? bytes(row.csrf_hash) : new Uint8Array(32),
  );
  if (!secretMatches
      || !csrfMatches
      || !row
      || row.session_state !== "active"
      || !futureInstant(row.expires_at)) {
    throw new ApiError(401, "AUTH_INVALID");
  }
  if (row.session_scope === "deletion_only" && !allowDeletionOnly) {
    throw new ApiError(401, "AUTH_INVALID");
  }
  if (row.participant_state === "deleting" && !allowDeleting) {
    throw new ApiError(409, "PARTICIPANT_DELETING");
  }
  return {
    participantId: row.participant_id,
    participantCreatedAt: row.participant_created_at,
    participantState: row.participant_state,
    consentVersion: row.consent_version,
    sessionId: row.session_id,
    sessionScope: row.session_scope,
    sessionSecret: parsed.secret,
    csrfToken,
    expiresAt: row.expires_at,
  };
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin) {
    throw new ApiError(403, "CSRF_INVALID");
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") {
    throw new ApiError(403, "CSRF_INVALID");
  }
}

export function assertCsrf(request: Request, session: SessionPrincipal): void {
  assertSameOrigin(request);
  const value = request.headers.get("x-usage-monitor-csrf");
  if (typeof value !== "string"
      || value.length > 96
      || !timingSafeEqual(
        new TextEncoder().encode(value),
        new TextEncoder().encode(session.csrfToken),
      )) {
    throw new ApiError(403, "CSRF_INVALID");
  }
}

/**
 * Session-independent CSRF defense for the admin hostname, where authentication
 * is the Cloudflare Access JWT rather than the app __Host- session (so there is
 * no session-bound double-submit token). Exact-origin is the load-bearing,
 * browser-enforced, unforgeable control — it refuses both a cookie-borne
 * cross-site POST (even under a pessimistic SameSite=None assumption) and an
 * absent Origin. The mandatory non-CORS-safelisted header additionally forces a
 * preflight the admin host never answers, so a cross-origin request never even
 * reaches this check.
 */
export function assertAdminCsrf(request: Request): void {
  assertSameOrigin(request);
  if (request.headers.get("x-usage-monitor-admin") !== "1") {
    throw new ApiError(403, "CSRF_INVALID");
  }
}

export async function createUploadAuthorizationMaterial(
  participantId: string,
  issuedBySessionId: string,
  envelopeDigest: string,
  bodyBytes: number,
  nowEpoch = Date.now(),
): Promise<UploadAuthorizationMaterial> {
  const id = crypto.randomUUID();
  const secret = randomSecret(32);
  return {
    id,
    participantId,
    issuedBySessionId,
    encoded: `um_upload_${id}.${secret}`,
    secretHash: await hashCapability("upload", id, secret),
    envelopeDigest,
    bodyBytes,
    contentType: "application/json",
    issuedAt: new Date(nowEpoch).toISOString(),
    expiresAt: new Date(nowEpoch + UPLOAD_AUTHORIZATION_TTL_MILLISECONDS).toISOString(),
  };
}

export async function storeUploadAuthorization(
  db: SessionSource,
  authorization: UploadAuthorizationMaterial,
): Promise<void> {
  const backend = authorityBackend(db);
  if (backend) {
    await backend.sessionUploads.insert({
      id: authorization.id,
      participantId: authorization.participantId,
      issuedBySessionId: authorization.issuedBySessionId,
      secretHash: authorization.secretHash,
      envelopeDigest: authorization.envelopeDigest,
      bodyBytes: authorization.bodyBytes,
      contentType: authorization.contentType,
      issuedAt: authorization.issuedAt,
      expiresAt: authorization.expiresAt,
    });
    return;
  }
  const result = await (db as D1Database).prepare(
    `INSERT INTO upload_authorizations (
      id, participant_id, issued_by_session_id, secret_hash, envelope_digest, body_bytes,
      content_type, state, issued_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unused', ?, ?)`,
  ).bind(
    authorization.id,
    authorization.participantId,
    authorization.issuedBySessionId,
    authorization.secretHash,
    authorization.envelopeDigest,
    authorization.bodyBytes,
    authorization.contentType,
    authorization.issuedAt,
    authorization.expiresAt,
  ).run();
  if (result.meta.changes !== 1) throw new ApiError(500, "INTERNAL_ERROR");
}

function parseUploadAuthorization(header: string | null): { id: string; secret: string } {
  if (!header?.startsWith("Upload ")) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  const match = /^um_upload_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u
    .exec(header.slice(7));
  if (!match?.[1] || !match[2]) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  return { id: match[1], secret: match[2] };
}

export async function claimUploadAuthorization(
  db: SessionSource,
  authorizationHeader: string | null,
  {
    envelopeDigest,
    bodyBytes,
    contentType,
  }: {
    envelopeDigest: string;
    bodyBytes: number;
    contentType: string;
  },
): Promise<{
  authorizationId: string;
  participantId: string;
  authorizationKind: "session";
  leaseExpiresAt: string;
}> {
  const parsed = parseUploadAuthorization(authorizationHeader);
  const backend = authorityBackend(db);
  if (backend) {
    const row = await backend.sessionUploads.read(parsed.id);
    const presentedHash = await hashCapability("upload", parsed.id, parsed.secret);
    if (!row || !timingSafeEqual(presentedHash, row.secretHash)
        || row.state !== "unused" || row.participantState !== "active"
        || row.issuingSessionState !== "active"
        || !futureInstant(row.issuingSessionExpiresAt) || !futureInstant(row.expiresAt)
        || row.envelopeDigest !== envelopeDigest || row.bodyBytes !== bodyBytes
        || row.contentType !== contentType) {
      throw new ApiError(401, "UPLOAD_AUTH_INVALID");
    }
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + UPLOAD_CONSUME_LEASE_MILLISECONDS).toISOString();
    const claimedLease = await backend.sessionUploads.claim({
      authorizationId: parsed.id, participantId: row.participantId, envelopeDigest,
      bodyBytes, contentType, leaseExpiresAt, now,
    });
    if (claimedLease === null) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
    return { authorizationId: parsed.id, participantId: row.participantId,
      authorizationKind: "session", leaseExpiresAt: claimedLease };
  }
  const row = await (db as D1Database).prepare(
    `SELECT u.*, p.state AS participant_state,
            s.state AS issuing_session_state,
            s.expires_at AS issuing_session_expires_at
       FROM upload_authorizations u
       JOIN participants p ON p.id = u.participant_id
       JOIN web_sessions s ON s.id = u.issued_by_session_id
      WHERE u.id = ?`,
  ).bind(parsed.id).first<UploadAuthorizationRow>();
  const presentedHash = await hashCapability("upload", parsed.id, parsed.secret);
  if (!timingSafeEqual(
    presentedHash,
    row ? bytes(row.secret_hash) : new Uint8Array(32),
  )
      || !row
      || row.state !== "unused"
      || row.participant_state !== "active"
      || row.issuing_session_state !== "active"
      || !futureInstant(row.issuing_session_expires_at)
      || !futureInstant(row.expires_at)
      || row.envelope_digest !== envelopeDigest
      || row.body_bytes !== bodyBytes
      || row.content_type !== contentType) {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(
    Date.now() + UPLOAD_CONSUME_LEASE_MILLISECONDS,
  ).toISOString();
  const result = await (db as D1Database).prepare(
    `UPDATE upload_authorizations
        SET state = 'consuming', consume_lease_expires_at = ?
      WHERE id = ? AND state = 'unused' AND expires_at > ?`,
  ).bind(leaseExpiresAt, parsed.id, now).run();
  if (result.meta.changes !== 1) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  return {
    authorizationId: parsed.id,
    participantId: row.participant_id,
    authorizationKind: "session" as const,
    leaseExpiresAt,
  };
}

export async function recordUploadReceipt(
  db: SessionSource,
  authorizationId: string,
  contributionId: string,
  leaseExpiresAt: string,
): Promise<void> {
  const now = new Date().toISOString();
  const backend = authorityBackend(db);
  if (backend) {
    const current = await backend.sessionUploads.read(authorizationId);
    if (!current) throw new ApiError(500, "INTERNAL_ERROR");
    const accepted = await backend.sessionUploads.recordReceipt({
      authorizationId, participantId: current.participantId, contributionId,
      leaseExpiresAt, now,
    });
    if (!accepted) throw new ApiError(500, "INTERNAL_ERROR");
    return;
  }
  const current = await (db as D1Database).prepare(
    `SELECT participant_id FROM upload_authorizations WHERE id = ?`,
  ).bind(authorizationId).first<{participant_id: string}>();
  if (!current) throw new ApiError(500, "INTERNAL_ERROR");
  const result = await (db as D1Database).prepare(
    `UPDATE upload_authorizations
        SET state = 'consumed', consumed_at = ?,
            consumed_contribution_id = ?, consume_lease_expires_at = NULL
      WHERE id = ? AND state = 'consuming'
        AND consume_lease_expires_at = ?
        AND consume_lease_expires_at > ?
        AND expires_at > ?`,
  ).bind(now, contributionId, authorizationId, leaseExpiresAt, now, now).run();
  if (result.meta.changes === 1) return;
  const existing = await (db as D1Database).prepare(
    `SELECT state, consumed_contribution_id
       FROM upload_authorizations WHERE id = ?`,
  ).bind(authorizationId).first<{
    state: string;
    consumed_contribution_id: string | null;
  }>();
  if (existing?.state !== "consumed"
      || existing.consumed_contribution_id !== contributionId) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
}

export async function abandonUploadAuthorization(
  db: SessionSource,
  authorizationId: string,
  participantId: string,
  leaseExpiresAt: string,
): Promise<void> {
  const now = new Date().toISOString();
  const backend = authorityBackend(db);
  if (backend) {
    await backend.sessionUploads.abandon({ authorizationId, participantId, leaseExpiresAt, now });
    return;
  }
  await (db as D1Database).prepare(
    `UPDATE upload_authorizations
        SET state = 'revoked', revoked_at = ?, consume_lease_expires_at = NULL
      WHERE id = ? AND participant_id = ? AND state = 'consuming'
        AND consume_lease_expires_at = ?`,
  ).bind(now, authorizationId, participantId, leaseExpiresAt).run();
}
