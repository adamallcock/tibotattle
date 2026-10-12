import { ApiError } from "./errors";
import {
  withPostgresMutation,
  quotePostgresIdentifier,
  createPostgresSchemaConfig,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import { authenticatePostgresPersonalSession } from "./postgres-personal-devices";

export interface PostgresPersonalSessionOptions {
  readonly schema?: PostgresSchemaOptions;
  readonly nowEpoch?: number;
}

export interface PostgresPersonalSessionPrincipal {
  readonly participantId: string;
  readonly participantCreatedAt: string;
  readonly consentVersion: string | null;
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly csrfToken: string;
}

/** Authenticate the Worker social-session cookie against PostgreSQL authority. */
export function authenticatePostgresPersonalSessionForRead(
  pool: PostgresPool,
  cookieHeader: string | null,
  options: PostgresPersonalSessionOptions = {},
): Promise<PostgresPersonalSessionPrincipal> {
  return authenticatePostgresPersonalSession(pool, cookieHeader, options);
}

/** Revoke one authenticated session and its still-unused session-issued grants atomically. */
export async function revokePostgresPersonalSession(
  pool: PostgresPool,
  participantId: string,
  sessionId: string,
  options: { readonly schema?: PostgresSchemaOptions } = {},
): Promise<void> {
  if (typeof participantId !== "string" || participantId.length === 0
      || typeof sessionId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sessionId)) {
    throw new ApiError(401, "AUTH_INVALID");
  }
  const schemas = createPostgresSchemaConfig(options.schema);
  const primary = quotePostgresIdentifier(schemas.primarySchema);
  const now = new Date().toISOString();

  await withPostgresMutation(pool, async (client) => {
    const session = await client.query<{ readonly id: string }>(
      `UPDATE ${primary}."web_sessions"
          SET state = 'revoked', revoked_at = $3::timestamptz
        WHERE id = $1 AND participant_id = $2 AND state = 'active'
        RETURNING id`,
      [sessionId, participantId, now],
    );
    if (session.rowCount !== 1 || session.rows[0]?.id !== sessionId) {
      throw new ApiError(401, "AUTH_INVALID");
    }
    await client.query(
      `UPDATE ${primary}."upload_authorizations"
          SET state = 'revoked', revoked_at = $3::timestamptz
        WHERE participant_id = $1 AND issued_by_session_id = $2 AND state = 'unused'`,
      [participantId, sessionId, now],
    );
    await client.query(
      `UPDATE ${primary}."device_pairings"
          SET state = 'revoked', revoked_at = $3::timestamptz
        WHERE participant_id = $1 AND issued_by_session_id = $2 AND state = 'unused'`,
      [participantId, sessionId, now],
    );
  }, {
    operation: "personal_session.logout",
    statementTimeoutMilliseconds: 5_000,
    lockTimeoutMilliseconds: 2_000,
    preserveSafeError: (error) => error instanceof ApiError ? error : null,
  });
}
