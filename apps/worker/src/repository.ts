import {
  hashInviteGrantSecret,
  inviteGrantHashMatches,
  type ParsedInviteGrant,
} from "./admission";
import {
  encodeBase64Url,
  hashCapability,
  randomSecret,
  sha256,
  sha256Hex,
  timingSafeEqual,
} from "./crypto";
import {
  RECOVERY_RETRY_LIMIT,
  RECOVERY_RETRY_TTL_MILLISECONDS,
  SESSION_TTL_MILLISECONDS,
} from "./constants";
import { contributionQuarantineLifecycle } from "./contribution-lifecycle";
import {
  createDevicePairingMaterial,
  devicePairingInsert,
  type DevicePairingMaterial,
} from "./device-auth";
import { ApiError } from "./errors";
import {
  createSessionMaterial,
  createSessionMaterialFromSecret,
  sessionInsert,
  type SessionMaterial,
} from "./session";
import type { SyntheticContribution, SyntheticEnvelope } from "./validation";

export interface Participant {
  id: string;
  createdAt: string;
  state: "active" | "deleting";
  consentVersion: string;
}

interface RecoveryAuthRow {
  id: string;
  recovery_token_id: string;
  recovery_token_hash: ArrayBuffer;
  state: "active" | "deleting";
  consent_version: string;
}

interface RecoveryRetryRow {
  old_recovery_token_hash: ArrayBuffer;
  recovery_attempt_hash: ArrayBuffer;
  participant_id: string;
  derivation_nonce: string;
  replacement_recovery_token_id: string;
  replacement_session_id: string;
  expires_at: string;
  replay_count: number;
  current_recovery_token_id: string;
  current_recovery_token_hash: ArrayBuffer;
  participant_state: "active" | "deleting";
  participant_consent_version: string;
  deletion_session_id: string | null;
  session_secret_hash: ArrayBuffer;
  session_csrf_hash: ArrayBuffer;
  session_state: "active" | "revoked";
  session_scope: "personal" | "deletion_only";
  session_issued_at: string;
  session_expires_at: string;
}

interface InviteGrantRow {
  id: string;
  secret_hash: ArrayBuffer;
  state: "issued" | "redeemed";
  expires_at: string;
}

export interface ContributionRow {
  id: string;
  participant_id: string;
  envelope_digest: string;
  r2_key: string;
  status: "accepted_synthetic" | "deleting";
  fixture_id: string;
  range_start: string;
  range_end: string;
  quota_window_minutes: number;
  quota_used_percent_before: number;
  quota_used_percent_after: number;
  quota_display_precision: number;
  model_id: string;
  subscription_speed: "standard" | "fast";
  api_tier_assumption: "standard" | "priority" | "flex";
  input_uncached_tokens: number;
  input_cached_tokens: number;
  output_text_tokens: number;
  output_reasoning_tokens: number;
  web_search_calls: number;
  unknown_tool_units: number;
  estimated_api_cost_usd: string;
  priced_event_coverage_percent: number;
  unknown_billable_units: number;
  price_basis: "current-api-price-sensitivity";
  created_at: string;
  quarantine_deleted_at?: string | null;
}

export interface Enrollment {
  participantId: string;
  recoveryCode: string;
  csrfToken: string;
  session: SessionMaterial;
  pairing: DevicePairingMaterial | null;
  invitation: {
    state: "not_required" | "redeemed";
    redeemedAt: string | null;
    expiresAt: string | null;
  };
}

export interface EnrollmentOptions {
  deviceBootstrap?: boolean;
  nowEpoch?: number;
  /**
   * Pairwise hosted-identity link key (hex HMAC of issuer+subject). Stored
   * on the participant row under a partial unique index; never the raw
   * subject. Callers must first attempt reattachParticipantByLinkKey.
   */
  identityLinkKey?: string | null;
  /**
   * Purpose-separated short-lived anti-reissue digest. It is supplied only
   * to the primary-D1 INSERT trigger and cleared from the participant row in
   * the same enrollment transaction after admission succeeds.
   */
  identityCooldownDigest?: string | null;
  /**
   * Open (non-invite) production enrollment still records community
   * eligibility through a server-issued, immediately redeemed grant so the
   * grant-backed eligibility trigger and audit trail hold for every cohort
   * member.
   */
  openCommunityEligibility?: boolean;
}

function capability(prefix: "um_recovery"): {
  id: string;
  secret: string;
  encoded: string;
} {
  const id = crypto.randomUUID();
  const secret = randomSecret(32);
  return { id, secret, encoded: `${prefix}_${id}.${secret}` };
}

function parseRecoveryCode(recoveryCode: unknown): { id: string; secret: string } {
  if (typeof recoveryCode !== "string") throw new ApiError(401, "AUTH_INVALID");
  const match = /^um_recovery_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u.exec(recoveryCode);
  if (!match?.[1] || !match[2]) throw new ApiError(401, "AUTH_INVALID");
  return { id: match[1], secret: match[2] };
}

async function recoveryAttemptHash(recoveryAttemptId: unknown): Promise<Uint8Array> {
  if (typeof recoveryAttemptId !== "string"
      || !/^um_recovery_attempt_[A-Za-z0-9_-]{43}$/u.test(recoveryAttemptId)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return sha256(`app-usagemonitor/recovery-attempt/v1\0${recoveryAttemptId}`);
}

function bytes(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value);
}

function canonicalFutureInstant(value: string, nowEpoch: number): boolean {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch)
    && new Date(epoch).toISOString() === value
    && epoch > nowEpoch;
}

export async function enroll(
  db: D1Database,
  consentVersion: string,
  inviteGrant: ParsedInviteGrant | null = null,
  options: EnrollmentOptions = {},
): Promise<Enrollment> {
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = new Date(nowEpoch).toISOString();
  const participantId = `participant:${crypto.randomUUID()}`;
  const legacyAccessId = crypto.randomUUID();
  const legacyAccessSecret = randomSecret(32);
  const recovery = capability("um_recovery");
  const session = await createSessionMaterial(participantId, nowEpoch);
  const pairing = options.deviceBootstrap
    ? await createDevicePairingMaterial(
      participantId,
      session.id,
      consentVersion,
      nowEpoch,
    )
    : null;
  const [legacyAccessHash, recoveryHash] = await Promise.all([
    hashCapability("access", legacyAccessId, legacyAccessSecret),
    hashCapability("recovery", recovery.id, recovery.secret),
  ]);
  const participantInsert = db.prepare(
    `INSERT INTO participants (
      id, access_token_id, access_token_hash, recovery_token_id,
      recovery_token_hash, state, consent_version, consented_at, created_at,
      identity_link_key, identity_cooldown_digest
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  ).bind(
    participantId,
    legacyAccessId,
    legacyAccessHash,
    recovery.id,
    recoveryHash,
    consentVersion,
    now,
    now,
    options.identityLinkKey ?? null,
    options.identityCooldownDigest ?? null,
  );
  const clearIdentityCooldownDigest = options.identityCooldownDigest === null
    || options.identityCooldownDigest === undefined
    ? []
    : [db.prepare(
      `UPDATE participants
          SET identity_cooldown_digest = NULL
        WHERE id = ? AND identity_cooldown_digest IS NOT NULL`,
    ).bind(participantId)];
  const enrollmentStatements = [
    participantInsert,
    ...clearIdentityCooldownDigest,
    sessionInsert(db, session),
    ...(pairing ? [devicePairingInsert(db, pairing, consentVersion)] : []),
  ];
  let invitationExpiresAt: string | null = null;
  if (!inviteGrant) {
    if (options.openCommunityEligibility) {
      const grantId = `open:${crypto.randomUUID()}`;
      const grantSecretHash = await hashInviteGrantSecret(
        grantId,
        randomSecret(32),
      );
      const grantExpiresAt = new Date(nowEpoch + 5 * 60 * 1_000).toISOString();
      const eligibilityId = `eligibility:${crypto.randomUUID()}`;
      const results = await db.batch([
        participantInsert,
        ...clearIdentityCooldownDigest,
        db.prepare(
          `INSERT INTO enrollment_grants (
            id, secret_hash, state, issued_at, expires_at
          ) VALUES (?, ?, 'issued', ?, ?)`,
        ).bind(grantId, grantSecretHash, now, grantExpiresAt),
        db.prepare(
          `UPDATE enrollment_grants
              SET state = 'redeemed', redeemed_at = ?, redeemed_participant_id = ?
            WHERE id = ? AND state = 'issued'`,
        ).bind(now, participantId, grantId),
        db.prepare(
          `INSERT INTO participant_community_eligibility (
            id, participant_id, grant_id, created_at
          ) VALUES (?, ?, ?, ?)`,
        ).bind(eligibilityId, participantId, grantId, now),
        sessionInsert(db, session),
        ...(pairing ? [devicePairingInsert(db, pairing, consentVersion)] : []),
      ]);
      if (results.some((entry) => entry.meta.changes !== 1)) {
        throw new ApiError(500, "INTERNAL_ERROR");
      }
    } else {
      const results = await db.batch(enrollmentStatements);
      if (results.some((entry) => entry.meta.changes !== 1)) {
        throw new ApiError(500, "INTERNAL_ERROR");
      }
    }
  } else {
    const grant = await db.prepare(
      `SELECT id, secret_hash, state, expires_at
         FROM enrollment_grants WHERE id = ?`,
    ).bind(inviteGrant.id).first<InviteGrantRow>();
    if (!inviteGrantHashMatches(inviteGrant.secretHash, grant?.secret_hash ?? null)
        || !grant
        || grant.state !== "issued"
        || !canonicalFutureInstant(grant.expires_at, nowEpoch)) {
      throw new ApiError(400, "INVITE_GRANT_INVALID");
    }
    invitationExpiresAt = grant.expires_at;
    const eligibilityId = `eligibility:${crypto.randomUUID()}`;
    try {
      const result = await db.batch([
        participantInsert,
        ...clearIdentityCooldownDigest,
        db.prepare(
          `UPDATE enrollment_grants
              SET state = 'redeemed', redeemed_at = ?, redeemed_participant_id = ?
            WHERE id = ? AND state = 'issued' AND expires_at > ?`,
        ).bind(now, participantId, inviteGrant.id, now),
        db.prepare(
          `INSERT INTO participant_community_eligibility (
            id, participant_id, grant_id, created_at
          ) VALUES (?, ?, ?, ?)`,
        ).bind(eligibilityId, participantId, inviteGrant.id, now),
        sessionInsert(db, session),
        ...(pairing ? [devicePairingInsert(db, pairing, consentVersion)] : []),
      ]);
      if (result.some((entry) => entry.meta.changes !== 1)) {
        throw new ApiError(400, "INVITE_GRANT_INVALID");
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const current = await db.prepare(
        "SELECT state, expires_at FROM enrollment_grants WHERE id = ?",
      ).bind(inviteGrant.id).first<{ state: string; expires_at: string }>();
      if (!current || current.state !== "issued"
          || !canonicalFutureInstant(current.expires_at, Date.now())) {
        throw new ApiError(400, "INVITE_GRANT_INVALID");
      }
      throw error;
    }
  }
  return {
    participantId,
    recoveryCode: recovery.encoded,
    csrfToken: session.csrfToken,
    session,
    pairing,
    invitation: {
      state: inviteGrant ? "redeemed" : "not_required",
      redeemedAt: inviteGrant ? now : null,
      expiresAt: invitationExpiresAt,
    },
  };
}

/**
 * Resolves an existing participant by hosted-identity link key and, when one
 * exists and is active, issues a fresh session, rotated recovery code, and
 * optional device pairing for it — the signed-in equivalent of recovery.
 * Returns null when no participant holds the key; throws while a deletion is
 * in progress so a deleting identity cannot silently resurrect.
 */
export async function reattachParticipantByLinkKey(
  db: D1Database,
  identityLinkKey: string,
  consentVersion: string,
  options: EnrollmentOptions = {},
): Promise<Enrollment | null> {
  const row = await db.prepare(
    `SELECT id, state FROM participants WHERE identity_link_key = ?`,
  ).bind(identityLinkKey).first<{ id: string; state: string }>();
  if (!row) return null;
  if (row.state !== "active") throw new ApiError(409, "PARTICIPANT_DELETING");
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = new Date(nowEpoch).toISOString();
  const recovery = capability("um_recovery");
  const recoveryHash = await hashCapability("recovery", recovery.id, recovery.secret);
  const session = await createSessionMaterial(row.id, nowEpoch);
  const pairing = options.deviceBootstrap
    ? await createDevicePairingMaterial(row.id, session.id, consentVersion, nowEpoch)
    : null;
  const results = await db.batch([
    db.prepare(
      `UPDATE participants
          SET recovery_token_id = ?, recovery_token_hash = ?
        WHERE id = ? AND state = 'active'`,
    ).bind(recovery.id, recoveryHash, row.id),
    sessionInsert(db, session),
    ...(pairing ? [devicePairingInsert(db, pairing, consentVersion)] : []),
  ]);
  if (results.some((entry) => entry.meta.changes !== 1)) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  return {
    participantId: row.id,
    recoveryCode: recovery.encoded,
    csrfToken: session.csrfToken,
    session,
    pairing,
    invitation: { state: "not_required", redeemedAt: null, expiresAt: null },
  };
}

/**
 * Reads only the lifecycle state for a pairwise link key. Callers use this to
 * distinguish an active account (which may reattach) from a deleted account
 * (which is subject to the short anti-reissue cooldown). No provider subject
 * or raw identity material is returned.
 */
export async function participantIdentityLinkState(
  db: D1Database,
  identityLinkKey: string,
): Promise<{ id: string; state: "active" | "deleting" } | null> {
  const row = await db.prepare(
    `SELECT id, state
       FROM participants
      WHERE identity_link_key = ?`,
  ).bind(identityLinkKey).first<{ id: string; state: string }>();
  if (!row) return null;
  if (row.state !== "active" && row.state !== "deleting") {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return { id: row.id, state: row.state };
}

/**
 * Returns the pairwise link key only while the authenticated deletion session
 * owns the deleting participant. The key is consumed immediately by the
 * purpose-separated cooldown HMAC and is never persisted by this helper.
 */
export async function participantIdentityLinkKeyForDeletion(
  db: D1Database,
  participantId: string,
  sessionId: string,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT identity_link_key
       FROM participants
      WHERE id = ? AND state = 'deleting' AND deletion_session_id = ?`,
  ).bind(participantId, sessionId).first<{
    identity_link_key: string | null;
  }>();
  if (row === null) throw new ApiError(409, "PARTICIPANT_DELETING");
  return row.identity_link_key;
}

interface RecoveryResult {
  participantId: string;
  recoveryCode: string;
  csrfToken: string;
  consentVersion: string;
  session: SessionMaterial;
}

async function derivedRecoverySecret(
  purpose: "recovery" | "session",
  oldRecoveryId: string,
  oldRecoverySecret: string,
  nonce: string,
): Promise<string> {
  return encodeBase64Url(await sha256(
    `app-usagemonitor/recovery-retry-${purpose}/v1`
      + `\0${oldRecoveryId}\0${oldRecoverySecret}\0${nonce}`,
  ));
}

async function retryRecoveredAccess(
  db: D1Database,
  parsed: { id: string; secret: string },
  attemptHash: Uint8Array,
): Promise<RecoveryResult | null> {
  const row = await db.prepare(
    `SELECT
      r.old_recovery_token_hash, r.recovery_attempt_hash,
      r.participant_id, r.derivation_nonce,
      r.replacement_recovery_token_id, r.replacement_session_id,
      r.expires_at, r.replay_count,
      p.recovery_token_id AS current_recovery_token_id,
      p.recovery_token_hash AS current_recovery_token_hash,
      p.state AS participant_state,
      p.consent_version AS participant_consent_version,
      p.deletion_session_id,
      s.secret_hash AS session_secret_hash, s.csrf_hash AS session_csrf_hash,
      s.state AS session_state, s.scope AS session_scope,
      s.issued_at AS session_issued_at,
      s.expires_at AS session_expires_at
    FROM recovery_retry_receipts r
    JOIN participants p ON p.id = r.participant_id
    JOIN web_sessions s ON s.id = r.replacement_session_id
    WHERE r.old_recovery_token_id = ?`,
  ).bind(parsed.id).first<RecoveryRetryRow>();
  const presentedOldHash = await hashCapability("recovery", parsed.id, parsed.secret);
  if (!row
      || !timingSafeEqual(presentedOldHash, bytes(row.old_recovery_token_hash))
      || !timingSafeEqual(attemptHash, bytes(row.recovery_attempt_hash))
      || !(
        (row.session_scope === "personal" && row.participant_state === "active")
        || (
          row.session_scope === "deletion_only"
          && row.participant_state === "deleting"
          && row.deletion_session_id === row.replacement_session_id
        )
      )
      || row.current_recovery_token_id !== row.replacement_recovery_token_id
      || row.session_state !== "active"
      || !canonicalFutureInstant(row.expires_at, Date.now())
      || !canonicalFutureInstant(row.session_expires_at, Date.now())
      || row.replay_count >= RECOVERY_RETRY_LIMIT) {
    return null;
  }
  const [replacementRecoverySecret, replacementSessionSecret] = await Promise.all([
    derivedRecoverySecret("recovery", parsed.id, parsed.secret, row.derivation_nonce),
    derivedRecoverySecret("session", parsed.id, parsed.secret, row.derivation_nonce),
  ]);
  const session = await createSessionMaterialFromSecret(
    row.participant_id,
    row.replacement_session_id,
    replacementSessionSecret,
    row.session_issued_at,
    row.session_expires_at,
    row.session_scope,
  );
  const replacementRecoveryHash = await hashCapability(
    "recovery",
    row.replacement_recovery_token_id,
    replacementRecoverySecret,
  );
  if (!timingSafeEqual(replacementRecoveryHash, bytes(row.current_recovery_token_hash))
      || !timingSafeEqual(session.secretHash, bytes(row.session_secret_hash))
      || !timingSafeEqual(session.csrfHash, bytes(row.session_csrf_hash))) {
    return null;
  }
  const now = new Date().toISOString();
  const replay = await db.prepare(
    `UPDATE recovery_retry_receipts
        SET replay_count = replay_count + 1
      WHERE old_recovery_token_id = ?
        AND replay_count < ?
        AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM participants
           WHERE id = ? AND recovery_token_id = ?
             AND (
               (? = 'personal' AND state = 'active')
               OR (
                 ? = 'deletion_only' AND state = 'deleting'
                 AND deletion_session_id = ?
               )
             )
        )`,
  ).bind(
    parsed.id,
    RECOVERY_RETRY_LIMIT,
    now,
    row.participant_id,
    row.replacement_recovery_token_id,
    row.session_scope,
    row.session_scope,
    row.replacement_session_id,
  ).run();
  if (replay.meta.changes !== 1) return null;
  return {
    participantId: row.participant_id,
    recoveryCode:
      `um_recovery_${row.replacement_recovery_token_id}.${replacementRecoverySecret}`,
    csrfToken: session.csrfToken,
    consentVersion: row.participant_consent_version,
    session,
  };
}

export async function recoverAccess(
  db: D1Database,
  recoveryCode: unknown,
  recoveryAttemptId: unknown,
): Promise<RecoveryResult> {
  const parsed = parseRecoveryCode(recoveryCode);
  const attemptHash = await recoveryAttemptHash(recoveryAttemptId);
  const row = await db.prepare(
    `SELECT id, recovery_token_id, recovery_token_hash, state, consent_version
       FROM participants
      WHERE recovery_token_id = ?`,
  ).bind(parsed.id).first<RecoveryAuthRow>();
  const presentedHash = await hashCapability("recovery", parsed.id, parsed.secret);
  const expectedHash = row ? bytes(row.recovery_token_hash) : new Uint8Array(32);
  if (!timingSafeEqual(presentedHash, expectedHash) || !row) {
    const retried = await retryRecoveredAccess(db, parsed, attemptHash);
    if (retried) return retried;
    throw new ApiError(401, "AUTH_INVALID");
  }
  const nowEpoch = Date.now();
  const now = new Date(nowEpoch).toISOString();
  const nonce = randomSecret(32);
  const replacementId = crypto.randomUUID();
  const replacementSecret = await derivedRecoverySecret(
    "recovery",
    parsed.id,
    parsed.secret,
    nonce,
  );
  const replacement = {
    id: replacementId,
    secret: replacementSecret,
    encoded: `um_recovery_${replacementId}.${replacementSecret}`,
  };
  const replacementHash = await hashCapability(
    "recovery",
    replacement.id,
    replacement.secret,
  );
  const sessionId = crypto.randomUUID();
  const sessionSecret = await derivedRecoverySecret(
    "session",
    parsed.id,
    parsed.secret,
    nonce,
  );
  const session = await createSessionMaterialFromSecret(
    row.id,
    sessionId,
    sessionSecret,
    now,
    new Date(nowEpoch + SESSION_TTL_MILLISECONDS).toISOString(),
    row.state === "deleting" ? "deletion_only" : "personal",
  );
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
        `UPDATE participants
            SET recovery_token_id = ?, recovery_token_hash = ?,
                deletion_session_id = CASE
                  WHEN state = 'deleting' THEN ?
                  ELSE deletion_session_id
                END
          WHERE id = ? AND recovery_token_id = ?
            AND state IN ('active', 'deleting')`,
      ).bind(replacement.id, replacementHash, session.id, row.id, parsed.id),
      db.prepare(
        `UPDATE web_sessions SET state = 'revoked', revoked_at = ?
          WHERE participant_id = ? AND state = 'active'
            AND EXISTS (
              SELECT 1 FROM participants
               WHERE id = ? AND recovery_token_id = ?
            )`,
      ).bind(now, row.id, row.id, replacement.id),
      db.prepare(
        `UPDATE upload_authorizations SET state = 'revoked', revoked_at = ?
          WHERE participant_id = ? AND state = 'unused'
            AND EXISTS (
              SELECT 1 FROM participants
               WHERE id = ? AND recovery_token_id = ?
            )`,
      ).bind(now, row.id, row.id, replacement.id),
      db.prepare(
        `INSERT INTO web_sessions (
          id, participant_id, secret_hash, csrf_hash, scope, state,
          issued_at, expires_at, last_used_at
        )
        SELECT ?, id, ?, ?, ?, 'active', ?, ?, ?
          FROM participants
         WHERE id = ? AND recovery_token_id = ?
           AND (
             (? = 'personal' AND state = 'active')
             OR (
               ? = 'deletion_only' AND state = 'deleting'
               AND deletion_session_id = ?
             )
           )`,
      ).bind(
        session.id,
        session.secretHash,
        session.csrfHash,
        session.scope,
        session.issuedAt,
        session.expiresAt,
        session.issuedAt,
        row.id,
        replacement.id,
        session.scope,
        session.scope,
        session.id,
      ),
      db.prepare(
        `INSERT INTO recovery_retry_receipts (
          old_recovery_token_id, old_recovery_token_hash, participant_id,
          recovery_attempt_hash, derivation_nonce, replacement_recovery_token_id,
          replacement_session_id, issued_at, expires_at, replay_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ).bind(
        parsed.id,
        presentedHash,
        row.id,
        attemptHash,
        nonce,
        replacement.id,
        session.id,
        now,
        new Date(nowEpoch + RECOVERY_RETRY_TTL_MILLISECONDS).toISOString(),
      ),
      db.prepare(
        `UPDATE device_pairings SET state = 'revoked', revoked_at = ?
          WHERE participant_id = ? AND state = 'unused'
            AND EXISTS (
              SELECT 1 FROM participants
               WHERE id = ? AND recovery_token_id = ?
            )`,
      ).bind(now, row.id, row.id, replacement.id),
      db.prepare(
        `UPDATE device_credentials SET state = 'revoked', revoked_at = ?
          WHERE participant_id = ? AND state = 'active'
            AND EXISTS (
              SELECT 1 FROM participants
               WHERE id = ? AND recovery_token_id = ?
            )`,
      ).bind(now, row.id, row.id, replacement.id),
      db.prepare(
        `UPDATE device_upload_authorizations SET state = 'revoked', revoked_at = ?
          WHERE participant_id = ? AND state = 'unused'
            AND EXISTS (
              SELECT 1 FROM participants
               WHERE id = ? AND recovery_token_id = ?
            )`,
      ).bind(now, row.id, row.id, replacement.id),
    ]);
  } catch (error) {
    const retried = await retryRecoveredAccess(db, parsed, attemptHash);
    if (retried) return retried;
    throw error;
  }
  if (results[0]?.meta.changes !== 1
      || results[3]?.meta.changes !== 1
      || results[4]?.meta.changes !== 1) {
    const retried = await retryRecoveredAccess(db, parsed, attemptHash);
    if (retried) return retried;
    throw new ApiError(401, "AUTH_INVALID");
  }
  return {
    participantId: row.id,
    recoveryCode: replacement.encoded,
    csrfToken: session.csrfToken,
    consentVersion: row.consent_version,
    session,
  };
}

export async function revokeSession(
  db: D1Database,
  participantId: string,
  sessionId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE web_sessions SET state = 'revoked', revoked_at = ?
        WHERE id = ? AND participant_id = ? AND state = 'active'`,
    ).bind(now, sessionId, participantId),
    db.prepare(
      `UPDATE upload_authorizations SET state = 'revoked', revoked_at = ?
        WHERE participant_id = ? AND issued_by_session_id = ?
          AND state = 'unused'`,
    ).bind(now, participantId, sessionId),
    db.prepare(
      `UPDATE device_pairings SET state = 'revoked', revoked_at = ?
        WHERE participant_id = ? AND issued_by_session_id = ?
          AND state = 'unused'`,
    ).bind(now, participantId, sessionId),
  ]);
  if (results[0]?.meta.changes !== 1) throw new ApiError(401, "AUTH_INVALID");
}

export async function securityReset(
  db: D1Database,
  participantId: string,
  currentSessionId: string,
): Promise<{ recoveryCode: string }> {
  const row = await db.prepare(
    `SELECT recovery_token_id FROM participants
      WHERE id = ? AND state = 'active'`,
  ).bind(participantId).first<{ recovery_token_id: string }>();
  if (!row) throw new ApiError(401, "AUTH_INVALID");
  const replacement = capability("um_recovery");
  const replacementHash = await hashCapability(
    "recovery",
    replacement.id,
    replacement.secret,
  );
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE participants
          SET recovery_token_id = ?, recovery_token_hash = ?
        WHERE id = ? AND recovery_token_id = ? AND state = 'active'`,
    ).bind(replacement.id, replacementHash, participantId, row.recovery_token_id),
    db.prepare(
      `UPDATE web_sessions SET state = 'revoked', revoked_at = ?
        WHERE participant_id = ? AND id <> ? AND state = 'active'
          AND EXISTS (
            SELECT 1 FROM participants
             WHERE id = ? AND recovery_token_id = ?
          )`,
    ).bind(now, participantId, currentSessionId, participantId, replacement.id),
    db.prepare(
      `UPDATE upload_authorizations SET state = 'revoked', revoked_at = ?
        WHERE participant_id = ? AND state = 'unused'
          AND EXISTS (
            SELECT 1 FROM participants
             WHERE id = ? AND recovery_token_id = ?
          )`,
    ).bind(now, participantId, participantId, replacement.id),
    db.prepare(
      `UPDATE device_pairings SET state = 'revoked', revoked_at = ?
        WHERE participant_id = ? AND state = 'unused'
          AND EXISTS (
            SELECT 1 FROM participants
             WHERE id = ? AND recovery_token_id = ?
          )`,
    ).bind(now, participantId, participantId, replacement.id),
    db.prepare(
      `UPDATE device_credentials SET state = 'revoked', revoked_at = ?
        WHERE participant_id = ? AND state = 'active'
          AND EXISTS (
            SELECT 1 FROM participants
             WHERE id = ? AND recovery_token_id = ?
          )`,
    ).bind(now, participantId, participantId, replacement.id),
    db.prepare(
      `UPDATE device_upload_authorizations SET state = 'revoked', revoked_at = ?
        WHERE participant_id = ? AND state = 'unused'
          AND EXISTS (
            SELECT 1 FROM participants
             WHERE id = ? AND recovery_token_id = ?
          )`,
    ).bind(now, participantId, participantId, replacement.id),
  ]);
  if (results[0]?.meta.changes !== 1) throw new ApiError(409, "AUTH_INVALID");
  return { recoveryCode: replacement.encoded };
}

export async function envelopeDigest(envelope: SyntheticEnvelope): Promise<string> {
  return sha256Hex([
    envelope.schemaVersion,
    envelope.keyId,
    envelope.wrappedKey,
    envelope.iv,
    envelope.ciphertext,
  ].join("\0"));
}

export async function existingContribution(
  db: D1Database,
  participantId: string,
  digest: string,
): Promise<ContributionRow | null> {
  return db.prepare(
    `SELECT *
       FROM contributions
      WHERE participant_id = ? AND envelope_digest = ?`,
  ).bind(participantId, digest).first<ContributionRow>();
}

export async function contributionCount(
  db: D1Database,
  participantId: string,
): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS total FROM contributions WHERE participant_id = ?",
  ).bind(participantId).first<{ total: number }>();
  return row?.total ?? 0;
}

export async function insertContribution(
  db: D1Database,
  participantId: string,
  uploadAuthorization: {
    authorizationId: string;
    authorizationKind: "session" | "device";
  },
  contributionId: string,
  r2Key: string,
  digest: string,
  envelope: SyntheticEnvelope,
  record: SyntheticContribution,
  createdAt: string,
): Promise<void> {
  const result = await db.prepare(
    `INSERT INTO contributions (
      id, participant_id, envelope_digest, r2_key, envelope_schema_version,
      key_id, status, fixture_id, range_start, range_end, quota_window_minutes,
      quota_used_percent_before, quota_used_percent_after, quota_display_precision,
      model_id, subscription_speed, api_tier_assumption, input_uncached_tokens,
      input_cached_tokens, output_text_tokens, output_reasoning_tokens,
      web_search_calls, unknown_tool_units, estimated_api_cost_usd,
      priced_event_coverage_percent, unknown_billable_units, price_basis, created_at,
      upload_authorization_id, device_upload_authorization_id
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 'accepted_synthetic',
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`,
  ).bind(
    contributionId,
    participantId,
    digest,
    r2Key,
    envelope.schemaVersion,
    envelope.keyId,
    record.fixtureId,
    record.timeRange.start,
    record.timeRange.end,
    record.quota.windowMinutes,
    record.quota.usedPercentBefore,
    record.quota.usedPercentAfter,
    record.quota.displayPrecision,
    record.usage.modelId,
    record.usage.subscriptionSpeed,
    record.usage.apiTierAssumption,
    record.usage.inputUncachedTokens,
    record.usage.inputCachedTokens,
    record.usage.outputTextTokens,
    record.usage.outputReasoningTokens,
    record.usage.providerToolUnits.webSearchCalls,
    record.usage.providerToolUnits.unknownUnits,
    record.accounting.estimatedApiCostUsd,
    record.accounting.pricedEventCoveragePercent,
    record.accounting.unknownBillableUnits,
    record.accounting.priceBasis,
    createdAt,
    uploadAuthorization.authorizationKind === "session"
      ? uploadAuthorization.authorizationId
      : null,
    uploadAuthorization.authorizationKind === "device"
      ? uploadAuthorization.authorizationId
      : null,
  ).run();
  if (result.meta.changes < 1) throw new ApiError(409, "PARTICIPANT_DELETING");
}

export async function listContributions(
  db: D1Database,
  participantId: string,
): Promise<ContributionRow[]> {
  const result = await db.prepare(
    `SELECT *
       FROM contributions
      WHERE participant_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1001`,
  ).bind(participantId).all<ContributionRow>();
  return result.results;
}

export async function markParticipantDeleting(
  db: D1Database,
  participantId: string,
  currentSessionId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE upload_authorizations
          SET state = 'revoked', revoked_at = ?,
              consume_lease_expires_at = NULL
        WHERE participant_id = ? AND state = 'consuming'
          AND consume_lease_expires_at <= ?`,
    ).bind(now, participantId, now),
    db.prepare(
      `UPDATE device_upload_authorizations
          SET state = 'revoked', revoked_at = ?,
              consume_lease_expires_at = NULL
        WHERE participant_id = ? AND state = 'consuming'
          AND consume_lease_expires_at <= ?`,
    ).bind(now, participantId, now),
    db.prepare(
      `UPDATE participants
          SET state = 'deleting', deletion_session_id = ?
        WHERE id = ? AND state = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM upload_authorizations
             WHERE participant_id = ? AND state = 'consuming'
          )
          AND NOT EXISTS (
            SELECT 1 FROM device_upload_authorizations
             WHERE participant_id = ? AND state = 'consuming'
          )`,
    ).bind(currentSessionId, participantId, participantId, participantId),
    db.prepare(
      `UPDATE web_sessions SET state = 'revoked', revoked_at = ?
        WHERE participant_id = ? AND id <> ? AND state = 'active'
          AND EXISTS (
            SELECT 1 FROM participants
             WHERE id = ? AND deletion_session_id = ?
          )`,
    ).bind(now, participantId, currentSessionId, participantId, currentSessionId),
    db.prepare(
      `UPDATE upload_authorizations SET state = 'revoked', revoked_at = ?
        WHERE participant_id = ? AND state = 'unused'
          AND EXISTS (
            SELECT 1 FROM participants
             WHERE id = ? AND deletion_session_id = ?
          )`,
    ).bind(now, participantId, participantId, currentSessionId),
    db.prepare(
      `UPDATE device_pairings SET state = 'revoked', revoked_at = ?
        WHERE participant_id = ? AND state = 'unused'
          AND EXISTS (
            SELECT 1 FROM participants
             WHERE id = ? AND deletion_session_id = ?
          )`,
    ).bind(now, participantId, participantId, currentSessionId),
    db.prepare(
      `UPDATE device_credentials SET state = 'revoked', revoked_at = ?
        WHERE participant_id = ? AND state = 'active'
          AND EXISTS (
            SELECT 1 FROM participants
             WHERE id = ? AND deletion_session_id = ?
          )`,
    ).bind(now, participantId, participantId, currentSessionId),
    db.prepare(
      `UPDATE device_upload_authorizations SET state = 'revoked', revoked_at = ?
        WHERE participant_id = ? AND state = 'unused'
          AND EXISTS (
            SELECT 1 FROM participants
             WHERE id = ? AND deletion_session_id = ?
          )`,
    ).bind(now, participantId, participantId, currentSessionId),
  ]);
  if ((results[2]?.meta.changes ?? 0) < 1) {
    const consuming = await db.prepare(
      `SELECT (
          (SELECT COUNT(*) FROM upload_authorizations
            WHERE participant_id = ? AND state = 'consuming')
          +
          (SELECT COUNT(*) FROM device_upload_authorizations
            WHERE participant_id = ? AND state = 'consuming')
        ) AS total`,
    ).bind(participantId, participantId).first<{ total: number }>();
    throw new ApiError(
      409,
      (consuming?.total ?? 0) > 0 ? "UPLOAD_IN_PROGRESS" : "PARTICIPANT_DELETING",
    );
  }
}

export async function assertDeletionOwner(
  db: D1Database,
  participantId: string,
  sessionId: string,
): Promise<void> {
  const row = await db.prepare(
    `SELECT 1 AS allowed FROM participants
      WHERE id = ? AND state = 'deleting' AND deletion_session_id = ?`,
  ).bind(participantId, sessionId).first<{ allowed: number }>();
  if (row?.allowed !== 1) throw new ApiError(409, "PARTICIPANT_DELETING");
}

export async function finishParticipantDeletion(
  db: D1Database,
  participantId: string,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM contributions WHERE participant_id = ?").bind(participantId),
    db.prepare("DELETE FROM participants WHERE id = ?").bind(participantId),
  ]);
}

export function contributionForResponse(row: ContributionRow): object {
  return {
    contributionId: row.id,
    status: row.status,
    synthetic: true,
    fixtureId: row.fixture_id,
    timeRange: { start: row.range_start, end: row.range_end },
    quota: {
      windowMinutes: row.quota_window_minutes,
      usedPercentBefore: row.quota_used_percent_before,
      usedPercentAfter: row.quota_used_percent_after,
      displayPrecision: row.quota_display_precision,
    },
    usage: {
      modelId: row.model_id,
      subscriptionSpeed: row.subscription_speed,
      apiTierAssumption: row.api_tier_assumption,
      inputUncachedTokens: row.input_uncached_tokens,
      inputCachedTokens: row.input_cached_tokens,
      outputTextTokens: row.output_text_tokens,
      outputReasoningTokens: row.output_reasoning_tokens,
      providerToolUnits: {
        webSearchCalls: row.web_search_calls,
        unknownUnits: row.unknown_tool_units,
      },
    },
    accounting: {
      estimatedApiCostUsd: row.estimated_api_cost_usd,
      pricedEventCoveragePercent: row.priced_event_coverage_percent,
      unknownBillableUnits: row.unknown_billable_units,
      priceBasis: row.price_basis,
      limitation: "API-price sensitivity only; no provider allowance formula is claimed.",
    },
    quarantine: contributionQuarantineLifecycle(
      row.created_at,
      row.quarantine_deleted_at,
    ),
    createdAt: row.created_at,
  };
}

export function contributionHistoryMetadata(row: ContributionRow): object {
  return {
    contributionId: row.id,
    status: row.status,
    synthetic: true,
    schemaVersion: "synthetic-contribution-v0.1",
    transportSchemaVersion: "synthetic-contribution-v0.1",
    coveredAt: { startAt: row.range_start, endAt: row.range_end },
    clientPlatform: "unknown",
    providerPolicyEpoch: "unknown",
    serverAccounting: {
      apiPriceEquivalentUsd: null,
      verification: "server_repricing_unavailable",
    },
    recordCounts: null,
    quarantine: contributionQuarantineLifecycle(
      row.created_at,
      row.quarantine_deleted_at,
    ),
    createdAt: row.created_at,
  };
}
