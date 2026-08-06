import { ApiError } from "./errors";

/**
 * The Apple state row is deliberately kept behind a tiny repository surface.
 * Callers pass the state-row nonce digest, never the raw nonce or an ID token.
 * All callback/result operations retain the existing time-bounded and one-use
 * predicates so an expired or already claimed transaction cannot write an
 * identity link, proof, participant, session, or device.
 *
 * `expires_at` is phase-dependent and always holds the deadline of the phase
 * the row is in: while the row is empty it is the authorization deadline set
 * by the start route, and the write that fills the row replaces it with the
 * delivery deadline of the proof minted by that same write. A row is therefore
 * bounded by exactly one live deadline at any moment, which is why the purge
 * query, its index, and the rule that an expired-but-filled row reads as
 * invalid rather than pending are all unaffected. `created_at` is retained, so
 * the authorization deadline of a filled row is still reconstructible.
 */

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const NONCE_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const LINK_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const PROOF_PATTERN = /^[A-Za-z0-9_-]{64}$/u;

export interface AppleSignInHandoffInsert {
  readonly state: string;
  readonly nonceHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ApplePendingSignInHandoff {
  readonly state: string;
  readonly nonceHash: string;
}

export interface AppleDeliveredSignInHandoff {
  readonly proof: string;
}

function internalError(): never {
  throw new ApiError(500, "INTERNAL_ERROR");
}

function assertNonceHash(value: string): void {
  if (!NONCE_HASH_PATTERN.test(value)) internalError();
}

function assertIdentityLinkKey(value: string): void {
  if (!LINK_KEY_PATTERN.test(value)) internalError();
}

function assertProof(value: string): void {
  if (!PROOF_PATTERN.test(value)) internalError();
}

function assertInstant(value: string): void {
  if (!INSTANT_PATTERN.test(value)) internalError();
}

/** Inserts an empty, live Apple transaction before redirecting to Apple. */
export async function insertAppleSignInHandoff(
  db: D1Database,
  handoff: AppleSignInHandoffInsert,
): Promise<void> {
  assertNonceHash(handoff.nonceHash);
  await db.prepare(
    `INSERT INTO apple_signin_handoffs
       (state, nonce_hash, identity_link_key, proof, created_at, expires_at, delivered_at)
       VALUES (?, ?, NULL, NULL, ?, ?, NULL)`,
  ).bind(
    handoff.state,
    handoff.nonceHash,
    handoff.createdAt,
    handoff.expiresAt,
  ).run();
}

/**
 * Returns the nonce digest only for an empty, live row.  An unknown, filled,
 * delivered, or expired state is indistinguishable from no callback attempt.
 */
export async function readPendingAppleSignInHandoff(
  db: D1Database,
  state: string,
  nowIso: string,
): Promise<ApplePendingSignInHandoff | null> {
  const row = await db.prepare(
    `SELECT state, nonce_hash AS nonceHash
       FROM apple_signin_handoffs
      WHERE state = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(state, nowIso).first<ApplePendingSignInHandoff>();
  if (!row || typeof row.state !== "string" || typeof row.nonceHash !== "string") {
    return null;
  }
  if (!NONCE_HASH_PATTERN.test(row.nonceHash)) return null;
  return { state: row.state, nonceHash: row.nonceHash };
}

/**
 * Atomically fills a pending handoff with the already verified pairwise link
 * key and a fresh opaque proof.  A false result means it expired, was filled,
 * or was delivered while provider verification was in flight.
 *
 * The same statement moves the row from its authorization phase into its
 * delivery phase: the WHERE clause still enforces the authorization deadline
 * (SQLite evaluates it against the pre-update row), while `expires_at` is
 * rewritten to the window the freshly minted proof gets from this instant.
 * The caller must pass a deadline strictly after `nowIso`, so a proof can
 * never be minted already expired or expire before it is first collectable.
 */
export async function completeAppleSignInHandoff(
  db: D1Database,
  state: string,
  identityLinkKey: string,
  proof: string,
  nowIso: string,
  deliveryExpiresAtIso: string,
): Promise<boolean> {
  assertIdentityLinkKey(identityLinkKey);
  assertProof(proof);
  // Both instants are canonical `toISOString()` output, so the ordering
  // comparison below is a lexicographic one on identical formats. Rejecting
  // any other shape is what makes that comparison sound rather than lucky.
  assertInstant(nowIso);
  assertInstant(deliveryExpiresAtIso);
  if (!(deliveryExpiresAtIso > nowIso)) internalError();
  const result = await db.prepare(
    `UPDATE apple_signin_handoffs
        SET identity_link_key = ?, proof = ?, expires_at = ?
      WHERE state = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(
    identityLinkKey,
    proof,
    deliveryExpiresAtIso,
    state,
    nowIso,
  ).run();
  return result.meta.changes === 1;
}

/**
 * Delivers a proof exactly once. The caller must subsequently consume that
 * proof through the existing enrollment path; this row operation never writes
 * participant, session, or device state.
 */
export async function deliverAppleSignInHandoff(
  db: D1Database,
  state: string,
  nowIso: string,
): Promise<AppleDeliveredSignInHandoff | null> {
  const row = await db.prepare(
    `UPDATE apple_signin_handoffs
        SET delivered_at = ?
      WHERE state = ?
        AND identity_link_key IS NOT NULL
        AND proof IS NOT NULL
        AND delivered_at IS NULL
        AND expires_at > ?
      RETURNING proof`,
  ).bind(nowIso, state, nowIso).first<{ proof: string }>();
  if (!row || typeof row.proof !== "string" || !PROOF_PATTERN.test(row.proof)) {
    return null;
  }
  return { proof: row.proof };
}

/** Deletes a live, still-empty handoff after provider cancellation/exchange failure. */
export async function discardPendingAppleSignInHandoff(
  db: D1Database,
  state: string,
  nowIso: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM apple_signin_handoffs
      WHERE state = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(state, nowIso).run();
}

/** Purges expired rows in a bounded batch for scheduled/opportunistic cleanup. */
export async function deleteExpiredAppleSignInHandoffs(
  db: D1Database,
  nowIso: string,
  maximumRows = 100,
): Promise<number> {
  if (!Number.isInteger(maximumRows) || maximumRows < 1 || maximumRows > 1000) {
    internalError();
  }
  const result = await db.prepare(
    `DELETE FROM apple_signin_handoffs
      WHERE state IN (
        SELECT state FROM apple_signin_handoffs
         WHERE expires_at <= ?
         ORDER BY expires_at, state
         LIMIT ?
      )`,
  ).bind(nowIso, maximumRows).run();
  return result.meta.changes;
}
