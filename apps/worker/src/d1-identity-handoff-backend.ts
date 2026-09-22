import type {
  AppleDeliveredSignInHandoff,
  ApplePendingSignInHandoff,
  AppleSignInHandoffInsert,
  AppleSignInHandoffStore,
  IdentityHandoffBackend,
} from "./identity-handoff-backend";

type Row = Record<string, unknown>;

function count(result: D1Result<unknown>): number {
  if (!Number.isSafeInteger(result.meta.changes) || result.meta.changes < 0) {
    throw new Error("D1 handoff row count is unavailable");
  }
  return result.meta.changes;
}

function pending(row: Row | null): ApplePendingSignInHandoff | null {
  if (!row || typeof row.state !== "string" || typeof row.nonceHash !== "string") return null;
  return { state: row.state, nonceHash: row.nonceHash };
}

export function createD1IdentityHandoffBackend(db: D1Database): IdentityHandoffBackend {
  const apple: AppleSignInHandoffStore = {
    async insert(input: AppleSignInHandoffInsert): Promise<void> {
      await db.prepare(`INSERT INTO apple_signin_handoffs
        (state, nonce_hash, binding_hash, identity_link_key, proof, created_at, expires_at, delivered_at)
        VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL)`)
        .bind(input.state, input.nonceHash, input.bindingHash, input.createdAt, input.expiresAt).run();
    },
    async readPending(input) {
      const binding = input.bindingHash ?? null;
      return pending(await db.prepare(`SELECT state, nonce_hash AS nonceHash
        FROM apple_signin_handoffs
        WHERE state = ? AND identity_link_key IS NULL AND proof IS NULL
          AND delivered_at IS NULL AND (? IS NULL OR binding_hash = ?) AND expires_at > ?`)
        .bind(input.state, binding, binding, input.nowIso).first<Row>());
    },
    async claim(input) {
      return pending(await db.prepare(`UPDATE apple_signin_handoffs
        SET claim_id = ?, claimed_at = ?
        WHERE state = ? AND identity_link_key IS NULL AND proof IS NULL
          AND delivered_at IS NULL AND expires_at > ?
          AND (claim_id IS NULL OR claimed_at <= ?)
        RETURNING state, nonce_hash AS nonceHash`)
        .bind(input.claimId, input.nowIso, input.state, input.nowIso, input.staleClaimBeforeIso)
        .first<Row>());
    },
    async complete(input) {
      const result = await db.prepare(`UPDATE apple_signin_handoffs
        SET identity_link_key = ?, proof = ?, expires_at = ?
        WHERE state = ? AND claim_id = ? AND identity_link_key IS NULL AND proof IS NULL
          AND delivered_at IS NULL AND expires_at > ?`)
        .bind(input.identityLinkKey, input.proof, input.deliveryExpiresAtIso, input.state,
          input.claimId, input.nowIso).run();
      return count(result) === 1;
    },
    async deliver(input): Promise<AppleDeliveredSignInHandoff | null> {
      const row = await db.prepare(`UPDATE apple_signin_handoffs
        SET delivered_at = COALESCE(delivered_at, ?)
        WHERE state = ? AND binding_hash = ? AND identity_link_key IS NOT NULL
          AND proof IS NOT NULL AND expires_at > ?
        RETURNING proof`)
        .bind(input.nowIso, input.state, input.bindingHash, input.nowIso).first<Row>();
      return typeof row?.proof === "string" ? { proof: row.proof } : null;
    },
    async discardPending(input): Promise<void> {
      await db.prepare(`DELETE FROM apple_signin_handoffs
        WHERE state = ? AND claim_id IS NULL AND identity_link_key IS NULL
          AND proof IS NULL AND delivered_at IS NULL AND expires_at > ?`)
        .bind(input.state, input.nowIso).run();
    },
    async discardClaimed(input): Promise<void> {
      await db.prepare(`DELETE FROM apple_signin_handoffs
        WHERE state = ? AND claim_id = ? AND identity_link_key IS NULL
          AND proof IS NULL AND delivered_at IS NULL AND expires_at > ?`)
        .bind(input.state, input.claimId, input.nowIso).run();
    },
    async purge(input): Promise<number> {
      const result = await db.prepare(`DELETE FROM apple_signin_handoffs
        WHERE state IN (SELECT state FROM apple_signin_handoffs
          WHERE expires_at <= ? ORDER BY expires_at, state LIMIT ?)`)
        .bind(input.nowIso, input.maximumRows).run();
      return count(result);
    },
  };
  return { apple };
}
