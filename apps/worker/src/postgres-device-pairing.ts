import {
  DEFAULT_DEVICE_LIFECYCLE_POLICY,
  createDevicePairingMaterial,
  type DeviceTransportConsentVersion,
} from "./device-auth";
import {
  ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION,
  ONGOING_TELEMETRY_CONSENT_VERSION,
} from "./constants";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresSchemaOptions,
  type PostgresPool,
} from "./postgres-client";

interface PairingAuthorityRow {
  readonly participant_state: string;
  readonly participant_owner_kind: string;
  readonly participant_consent_version: string | null;
  readonly session_state: string;
  readonly session_scope: string;
  readonly session_expires_at: Date | string;
  readonly session_issued_at: Date | string;
  readonly active_device_count: string | number;
  readonly recent_pairing_count: string | number;
}

function table(schema: string, name: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(name)}`;
}

function canonicalInstant(value: Date | string): string | null {
  const epoch = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString();
}

function count(value: string | number): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Issue a Worker-compatible, one-use device pairing from a social web session.
 * The transaction locks the owner and session while enforcing the same active
 * device and one-hour pairing issue bounds as the D1 route.
 */
export async function createPostgresDevicePairing(
  pool: PostgresPool,
  participantId: string,
  sessionId: string,
  participantConsentVersion: string,
  requestedTransportConsentVersion: DeviceTransportConsentVersion,
  options: { readonly schema?: PostgresSchemaOptions; readonly nowEpoch?: number } = {},
): Promise<{ readonly pairingCode: string; readonly expiresAt: string }> {
  if (typeof participantId !== "string" || participantId.length === 0
      || typeof sessionId !== "string" || sessionId.length === 0) {
    throw new ApiError(401, "AUTH_INVALID");
  }
  const nowEpoch = options.nowEpoch ?? Date.now();
  if (!Number.isFinite(nowEpoch)) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  const schemas = createPostgresSchemaConfig(options.schema);
  const primary = quotePostgresIdentifier(schemas.primarySchema);
  const policy = DEFAULT_DEVICE_LIFECYCLE_POLICY;
  const material = await createDevicePairingMaterial(
    participantId,
    sessionId,
    participantConsentVersion,
    nowEpoch,
    requestedTransportConsentVersion,
  );
  const now = material.issuedAt;
  const idleCutoff = new Date(nowEpoch - policy.idleMilliseconds).toISOString();
  const issueCutoff = new Date(nowEpoch - policy.pairingIssueWindowMilliseconds).toISOString();

  await withPostgresMutation(pool, async (client) => {
    const authorityResult = await client.query<PairingAuthorityRow>(
      `SELECT participant.state AS participant_state,
              participant.owner_kind AS participant_owner_kind,
              participant.consent_version AS participant_consent_version,
              session.state AS session_state,
              session.scope AS session_scope,
              session.expires_at AS session_expires_at,
              session.issued_at AS session_issued_at,
              (SELECT count(*)::text FROM ${primary}."device_credentials" device
                WHERE device.participant_id = participant.id
                  AND device.state = 'active'
                  AND device.expires_at > $3::timestamptz
                  AND device.last_used_at > $4::timestamptz) AS active_device_count,
              (SELECT count(*)::text FROM ${primary}."device_pairings" recent
                WHERE recent.participant_id = participant.id
                  AND recent.issued_at > $5::timestamptz) AS recent_pairing_count
         FROM ${primary}."participants" participant
         JOIN ${primary}."web_sessions" session
           ON session.participant_id = participant.id
        WHERE participant.id = $1 AND session.id = $2
        FOR UPDATE OF participant, session`,
      [participantId, sessionId, now, idleCutoff, issueCutoff],
    );
    const authority = authorityResult.rows[0];
    const sessionExpiry = authority && canonicalInstant(authority.session_expires_at);
    const sessionIssued = authority && canonicalInstant(authority.session_issued_at);
    if (!authority
        || authority.participant_state !== "active"
        || authority.participant_owner_kind !== "social"
        || authority.participant_consent_version !== participantConsentVersion
        || authority.session_state !== "active"
        || authority.session_scope !== "personal"
        || sessionExpiry === null || sessionExpiry === undefined
        || Date.parse(sessionExpiry) <= nowEpoch
        || sessionIssued === null || sessionIssued === undefined) {
      throw new ApiError(401, "AUTH_INVALID");
    }

    const activeDevices = count(authority.active_device_count);
    const recentPairings = count(authority.recent_pairing_count);
    if (activeDevices === null || recentPairings === null) {
      throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }
    if (activeDevices >= policy.activeDeviceLimit) {
      // Match the Worker re-pair recovery: only revoke a device that this new
      // personal session demonstrably superseded, and only when the issue-rate
      // bound still permits a mint. Both updates and the retry are atomic.
      if (recentPairings >= policy.pairingIssueLimit) {
        throw new ApiError(429, "LIFECYCLE_BOUNDS_EXCEEDED");
      }
      const target = await client.query<{ readonly id: string }>(
        `SELECT device.id
           FROM ${primary}."device_credentials" device
           JOIN ${primary}."web_sessions" session
             ON session.id = $2 AND session.participant_id = device.participant_id
            AND session.scope = 'personal' AND session.state = 'active'
            AND session.expires_at > $3::timestamptz
          WHERE device.participant_id = $1
            AND device.state = 'active'
            AND device.expires_at > $3::timestamptz
            AND device.last_used_at > $4::timestamptz
            AND COALESCE(device.last_used_at, device.issued_at) < session.issued_at
          ORDER BY COALESCE(device.last_used_at, device.issued_at), device.id
          LIMIT 1
          FOR UPDATE OF device`,
        [participantId, sessionId, now, idleCutoff],
      );
      const supersededDeviceId = target.rows[0]?.id;
      if (typeof supersededDeviceId !== "string") {
        throw new ApiError(429, "LIFECYCLE_BOUNDS_EXCEEDED");
      }
      const revoked = await client.query(
        `UPDATE ${primary}."device_credentials"
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, $1::timestamptz)
          WHERE id = $2 AND participant_id = $3 AND state = 'active'
            AND COALESCE(last_used_at, issued_at) < (
              SELECT issued_at FROM ${primary}."web_sessions"
               WHERE id = $4 AND participant_id = $3
                 AND scope = 'personal' AND state = 'active'
            )`,
        [now, supersededDeviceId, participantId, sessionId],
      );
      if (revoked.rowCount !== 1) throw new ApiError(429, "LIFECYCLE_BOUNDS_EXCEEDED");
      await client.query(
        `UPDATE ${primary}."device_upload_authorizations"
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, $1::timestamptz),
                consume_lease_expires_at = NULL
          WHERE issued_by_device_id = $2 AND participant_id = $3
            AND state IN ('unused', 'consuming')`,
        [now, supersededDeviceId, participantId],
      );
    }
    if (recentPairings >= policy.pairingIssueLimit) {
      throw new ApiError(429, "LIFECYCLE_BOUNDS_EXCEEDED");
    }

    const pinnedConsentVersion = material.transportConsentVersion
        === ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION
      ? ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION
      : ONGOING_TELEMETRY_CONSENT_VERSION;
    const inserted = await client.query(
      `INSERT INTO ${primary}."device_pairings" (
         id, participant_id, issued_by_session_id, secret_hash, consent_version,
         transport_consent_version, state, issued_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'unused', $7::timestamptz, $8::timestamptz)
       RETURNING id`,
      [material.id, participantId, sessionId, material.secretHash, pinnedConsentVersion,
        material.transportConsentVersion, material.issuedAt, material.expiresAt],
    );
    if (inserted.rowCount !== 1 || inserted.rows[0]?.id !== material.id) {
      throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }
  }, {
    operation: "device_pairing.create",
    statementTimeoutMilliseconds: 5_000,
    lockTimeoutMilliseconds: 2_000,
    preserveSafeError: (error) => error instanceof ApiError ? error : null,
  });

  return Object.freeze({ pairingCode: material.pairingCode, expiresAt: material.expiresAt });
}
