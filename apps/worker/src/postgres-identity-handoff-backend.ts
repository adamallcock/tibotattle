import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryResult,
  type PostgresSchemaOptions,
} from "./postgres-client";
import type {
  AppleDeliveredSignInHandoff,
  ApplePendingSignInHandoff,
  AppleSignInHandoffStore,
  GoogleDeliveredSignInHandoff,
  GooglePendingSignInHandoff,
  GoogleSignInHandoffStore,
  IdentityHandoffBackend,
  SignInHandoffConsumedIdentity,
} from "./identity-handoff-backend";

/** Structural aliases; pool lifecycle and transaction policy live in the shared boundary. */
export type PostgresIdentityHandoffPool = PostgresPool;
export type PostgresIdentityHandoffClient = PostgresClient;
export type PostgresIdentityHandoffResult = PostgresQueryResult<Record<string, unknown>>;

function rowCount(result: PostgresIdentityHandoffResult): number {
  if (result.rowCount === null || !Number.isSafeInteger(result.rowCount) || result.rowCount < 0) {
    throw new Error("identity_handoff_row_count_unavailable");
  }
  return result.rowCount;
}

function pending(row: Record<string, unknown> | undefined): ApplePendingSignInHandoff | null {
  if (!row || typeof row.state !== "string" || typeof row.nonce_hash !== "string") return null;
  return { state: row.state, nonceHash: row.nonce_hash };
}

function googlePending(row: Record<string, unknown> | undefined): GooglePendingSignInHandoff | null {
  if (!row || typeof row.state !== "string" || typeof row.code_verifier !== "string") return null;
  return { state: row.state, codeVerifier: row.code_verifier };
}

function consumed(row: Record<string, unknown> | undefined): SignInHandoffConsumedIdentity | null {
  if (!row || typeof row.link_key_hex !== "string") return null;
  return { linkKeyHex: row.link_key_hex };
}

function table(schema: string, name: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(name)}`;
}

/**
 * PostgreSQL Apple handoffs retain only the same content-free digests as the
 * D1 implementation. Every operation goes through the bounded shared
 * transaction helper, so provider errors and SQL text never reach callers.
 */
export function createPostgresIdentityHandoffBackend(
  pool: PostgresIdentityHandoffPool,
  schemaOptions: PostgresSchemaOptions = {},
): IdentityHandoffBackend {
  const schema = createPostgresSchemaConfig(schemaOptions);
  const handoffs = table(schema.primarySchema, "apple_signin_handoffs");
  const googleHandoffs = table(schema.primarySchema, "google_signin_handoffs");

  async function lockState(client: PostgresClient, state: string): Promise<void> {
    await client.query(`SELECT state FROM ${handoffs} WHERE state = $1 FOR UPDATE`, [state]);
  }

  async function lockGoogleState(client: PostgresClient, state: string): Promise<void> {
    await client.query(`SELECT state FROM ${googleHandoffs} WHERE state = $1 FOR UPDATE`, [state]);
  }

  const apple: AppleSignInHandoffStore = {
    insert(input) {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        const result = await client.query(`INSERT INTO ${handoffs}
          (state, nonce_hash, binding_hash, identity_link_key, proof, created_at, expires_at, delivered_at)
          VALUES ($1, $2, $3, NULL, NULL, $4, $5, NULL)`, [
          snapshot.state, snapshot.nonceHash, snapshot.bindingHash,
          snapshot.createdAt, snapshot.expiresAt,
        ]);
        if (rowCount(result) !== 1) throw new Error("identity_handoff_insert_failed");
      }, { operation: "identity.handoff.insert" });
    },

    readPending(input) {
      const snapshot = { ...input };
      return withPostgresRead(pool, async (client) => {
        const binding = snapshot.bindingHash ?? null;
        const result = await client.query(`SELECT state, nonce_hash
          FROM ${handoffs}
          WHERE state = $1 AND identity_link_key IS NULL AND proof IS NULL
            AND delivered_at IS NULL AND ($2::text IS NULL OR binding_hash = $2)
            AND expires_at > clock_timestamp()`, [snapshot.state, binding]);
        return pending(result.rows[0]);
      }, { operation: "identity.handoff.read" });
    },

    claim(input) {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        // Lock before checking expiry. PostgreSQL can evaluate UPDATE
        // predicates before waiting for a concurrent row lock, allowing a
        // claim that waited past expiry to succeed without this fence.
        await lockState(client, snapshot.state);
        const result = await client.query(`UPDATE ${handoffs}
          SET claim_id = $1, claimed_at = clock_timestamp()
          WHERE state = $2 AND identity_link_key IS NULL AND proof IS NULL
            AND delivered_at IS NULL AND expires_at > clock_timestamp()
            AND (claim_id IS NULL OR claimed_at <= $3)
          RETURNING state, nonce_hash`, [
          snapshot.claimId, snapshot.state, snapshot.staleClaimBeforeIso,
        ]);
        return pending(result.rows[0]);
      }, { operation: "identity.handoff.claim" });
    },

    complete(input) {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        await lockState(client, snapshot.state);
        const result = await client.query(`UPDATE ${handoffs}
          SET identity_link_key = $1, proof = $2, expires_at = $3
          WHERE state = $4 AND claim_id = $5 AND identity_link_key IS NULL
            AND proof IS NULL AND delivered_at IS NULL AND expires_at > clock_timestamp()
            AND $3::timestamptz > clock_timestamp()`, [
          snapshot.identityLinkKey, snapshot.proof, snapshot.deliveryExpiresAtIso,
          snapshot.state, snapshot.claimId,
        ]);
        return rowCount(result) === 1;
      }, { operation: "identity.handoff.complete" });
    },

    deliver(input): Promise<AppleDeliveredSignInHandoff | null> {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        await lockState(client, snapshot.state);
        const result = await client.query(`UPDATE ${handoffs}
          SET delivered_at = COALESCE(delivered_at, clock_timestamp())
          WHERE state = $1 AND binding_hash = $2 AND identity_link_key IS NOT NULL
            AND proof IS NOT NULL AND expires_at > clock_timestamp()
          RETURNING proof`, [snapshot.state, snapshot.bindingHash]);
        const proof = result.rows[0]?.proof;
        return typeof proof === "string" ? { proof } : null;
      }, { operation: "identity.handoff.deliver" });
    },

    consume(input): Promise<SignInHandoffConsumedIdentity | null> {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        const result = await client.query(`DELETE FROM ${handoffs}
          WHERE proof = $1 AND binding_hash = $2 AND identity_link_key IS NOT NULL
            AND delivered_at IS NOT NULL AND expires_at > clock_timestamp()
          RETURNING identity_link_key AS link_key_hex`, [snapshot.proof, snapshot.bindingHash]);
        return consumed(result.rows[0]);
      }, { operation: "identity.handoff.consume" });
    },

    hasExpired(input): Promise<boolean> {
      const snapshot = { ...input };
      return withPostgresRead(pool, async (client) => {
        const result = await client.query(`SELECT 1 AS found FROM ${handoffs}
          WHERE expires_at <= $1 LIMIT 1`, [snapshot.nowIso]);
        return result.rows.length === 1;
      }, { operation: "identity.handoff.has-expired" });
    },

    discardPending(input) {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        await lockState(client, snapshot.state);
        await client.query(`DELETE FROM ${handoffs}
          WHERE state = $1 AND claim_id IS NULL AND identity_link_key IS NULL
            AND proof IS NULL AND delivered_at IS NULL AND expires_at > clock_timestamp()`, [
          snapshot.state,
        ]);
      }, { operation: "identity.handoff.discard-pending" });
    },

    discardClaimed(input) {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        await lockState(client, snapshot.state);
        await client.query(`DELETE FROM ${handoffs}
          WHERE state = $1 AND claim_id = $2 AND identity_link_key IS NULL
            AND proof IS NULL AND delivered_at IS NULL AND expires_at > clock_timestamp()`, [
          snapshot.state, snapshot.claimId,
        ]);
      }, { operation: "identity.handoff.discard-claimed" });
    },

    purge(input) {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        const result = await client.query(`WITH expired AS (
            SELECT state FROM ${handoffs}
            WHERE expires_at <= $1 ORDER BY expires_at, state LIMIT $2
          ) DELETE FROM ${handoffs} h USING expired
            WHERE h.state = expired.state AND h.expires_at <= $1`, [
          snapshot.nowIso, snapshot.maximumRows,
        ]);
        return rowCount(result);
      }, { operation: "identity.handoff.purge" });
    },
  };
  const google: GoogleSignInHandoffStore = {
    insert(input) {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        const result = await client.query(`INSERT INTO ${googleHandoffs}
          (state, code_verifier, binding_hash, identity_link_key, proof, created_at, expires_at, delivered_at)
          VALUES ($1, $2, $3, NULL, NULL, $4, $5, NULL)`, [
          snapshot.state, snapshot.codeVerifier, snapshot.bindingHash,
          snapshot.createdAt, snapshot.expiresAt,
        ]);
        if (rowCount(result) !== 1) throw new Error("identity_handoff_insert_failed");
      }, { operation: "identity.google-handoff.insert" });
    },

    readPending(input) {
      const snapshot = { ...input };
      return withPostgresRead(pool, async (client) => {
        const binding = snapshot.bindingHash ?? null;
        const result = await client.query(`SELECT state, code_verifier
          FROM ${googleHandoffs}
          WHERE state = $1 AND identity_link_key IS NULL AND proof IS NULL
            AND delivered_at IS NULL AND ($2::text IS NULL OR binding_hash = $2)
            AND expires_at > clock_timestamp()`, [snapshot.state, binding]);
        return googlePending(result.rows[0]);
      }, { operation: "identity.google-handoff.read" });
    },

    claim(input) {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        await lockGoogleState(client, snapshot.state);
        const result = await client.query(`UPDATE ${googleHandoffs}
          SET claim_id = $1, claimed_at = clock_timestamp()
          WHERE state = $2 AND identity_link_key IS NULL AND proof IS NULL
            AND delivered_at IS NULL AND expires_at > clock_timestamp()
            AND (claim_id IS NULL OR claimed_at <= $3)
          RETURNING state, code_verifier`, [
          snapshot.claimId, snapshot.state, snapshot.staleClaimBeforeIso,
        ]);
        return googlePending(result.rows[0]);
      }, { operation: "identity.google-handoff.claim" });
    },

    complete(input) {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        await lockGoogleState(client, snapshot.state);
        const result = await client.query(`UPDATE ${googleHandoffs}
          SET code_verifier = NULL, identity_link_key = $1, proof = $2, expires_at = $3
          WHERE state = $4 AND claim_id = $5 AND identity_link_key IS NULL
            AND proof IS NULL AND delivered_at IS NULL AND expires_at > clock_timestamp()
            AND $3::timestamptz > clock_timestamp()`, [
          snapshot.identityLinkKey, snapshot.proof, snapshot.deliveryExpiresAtIso,
          snapshot.state, snapshot.claimId,
        ]);
        return rowCount(result) === 1;
      }, { operation: "identity.google-handoff.complete" });
    },

    deliver(input): Promise<GoogleDeliveredSignInHandoff | null> {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        await lockGoogleState(client, snapshot.state);
        const result = await client.query(`UPDATE ${googleHandoffs}
          SET delivered_at = COALESCE(delivered_at, clock_timestamp())
          WHERE state = $1 AND binding_hash = $2 AND identity_link_key IS NOT NULL
            AND proof IS NOT NULL AND expires_at > clock_timestamp()
          RETURNING proof`, [snapshot.state, snapshot.bindingHash]);
        const proof = result.rows[0]?.proof;
        return typeof proof === "string" ? { proof } : null;
      }, { operation: "identity.google-handoff.deliver" });
    },

    consume(input): Promise<SignInHandoffConsumedIdentity | null> {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        const result = await client.query(`DELETE FROM ${googleHandoffs}
          WHERE proof = $1 AND binding_hash = $2 AND identity_link_key IS NOT NULL
            AND delivered_at IS NOT NULL AND expires_at > clock_timestamp()
          RETURNING identity_link_key AS link_key_hex`, [snapshot.proof, snapshot.bindingHash]);
        return consumed(result.rows[0]);
      }, { operation: "identity.google-handoff.consume" });
    },

    hasExpired(input): Promise<boolean> {
      const snapshot = { ...input };
      return withPostgresRead(pool, async (client) => {
        const result = await client.query(`SELECT 1 AS found FROM ${googleHandoffs}
          WHERE expires_at <= $1 LIMIT 1`, [snapshot.nowIso]);
        return result.rows.length === 1;
      }, { operation: "identity.google-handoff.has-expired" });
    },

    discardPending(input) {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        await lockGoogleState(client, snapshot.state);
        await client.query(`DELETE FROM ${googleHandoffs}
          WHERE state = $1 AND claim_id IS NULL AND identity_link_key IS NULL
            AND proof IS NULL AND delivered_at IS NULL AND expires_at > clock_timestamp()`, [
          snapshot.state,
        ]);
      }, { operation: "identity.google-handoff.discard-pending" });
    },

    discardClaimed(input) {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        await lockGoogleState(client, snapshot.state);
        await client.query(`DELETE FROM ${googleHandoffs}
          WHERE state = $1 AND claim_id = $2 AND identity_link_key IS NULL
            AND proof IS NULL AND delivered_at IS NULL AND expires_at > clock_timestamp()`, [
          snapshot.state, snapshot.claimId,
        ]);
      }, { operation: "identity.google-handoff.discard-claimed" });
    },

    purge(input) {
      const snapshot = { ...input };
      return withPostgresMutation(pool, async (client) => {
        const result = await client.query(`WITH expired AS (
            SELECT state FROM ${googleHandoffs}
            WHERE expires_at <= $1 ORDER BY expires_at, state LIMIT $2
          ) DELETE FROM ${googleHandoffs} h USING expired
            WHERE h.state = expired.state AND h.expires_at <= $1`, [
          snapshot.nowIso, snapshot.maximumRows,
        ]);
        return rowCount(result);
      }, { operation: "identity.google-handoff.purge" });
    },
  };
  return { apple, google };
}
