import {
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
} from "./accountless-enrollment";
import {
  ACCOUNTLESS_RENEWAL_GENERATION_MAXIMUM,
  ACCOUNTLESS_RENEWAL_SCHEMA_VERSION,
  ACCOUNTLESS_RENEWAL_SCOPE,
  ACCOUNTLESS_RENEWAL_WINDOW_MILLISECONDS,
  parseAccountlessRenewalRequest,
  type AccountlessRenewalRequest,
  type AccountlessRenewalResponse,
} from "./accountless-renewal";
import { ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION } from "./accountless-ownership";
import {
  ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS,
  ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
  ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION,
} from "./telemetry-transport-policy";
import {
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import { deviceHash, parseDeviceAuthorization } from "./device-auth";
import { timingSafeEqual } from "./crypto";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";

export interface PostgresAccountlessRenewalOptions {
  readonly nowEpoch?: number;
  readonly schema?: PostgresSchemaConfig;
}

interface RenewalLedgerRow {
  device_id: string;
  device_secret_hash: Uint8Array;
  policy_version: string;
  authorization_basis: string;
  state: "active" | "revoked";
  issued_at: Date | string;
  issued_at_millisecond_aligned: boolean;
  expires_at: Date | string;
  expires_at_millisecond_aligned: boolean;
  renewal_generation: number | string;
  renewed_at: Date | string | null;
  renewed_at_millisecond_aligned: boolean | null;
}

interface NormalizedRenewalLedger extends RenewalLedgerRow {
  device_secret_hash: Uint8Array;
  issued_at: string;
  expires_at: string;
  renewal_generation: number;
  renewed_at: string | null;
}

interface RenewalGraphRow {
  participant_id: string;
  participant_state: string;
  participant_owner_kind: string;
  access_token_id: string | null;
  access_token_hash: Uint8Array | null;
  recovery_token_id: string | null;
  recovery_token_hash: Uint8Array | null;
  consent_version: string | null;
  consented_at: Date | string | null;
  device_id: string;
  device_participant_id: string;
  device_authority_kind: string;
  device_enrollment_device_id: string | null;
  device_secret_hash: Uint8Array;
  device_state: string;
  device_expires_at: Date | string;
  device_expires_at_millisecond_aligned: boolean;
  device_social_verified_at: Date | string | null;
  owner_enrollment_device_id: string;
  owner_participant_id: string;
  owner_device_credential_id: string;
  owner_policy_version: string;
  owner_authorization_basis: string;
  owner_state: string;
  owner_expires_at: Date | string;
  owner_expires_at_millisecond_aligned: boolean;
  authorization_enrollment_device_id: string;
  authorization_participant_id: string;
  authorization_device_credential_id: string;
  authorization_telemetry_schema_version: string;
  authorization_state: string;
  authorization_expires_at: Date | string;
  authorization_expires_at_millisecond_aligned: boolean;
}

interface NormalizedRenewalGraph extends RenewalGraphRow {
  device_expires_at: string;
  owner_expires_at: string;
  authorization_expires_at: string;
}

function unavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function safeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function schemaName(options: PostgresAccountlessRenewalOptions): string {
  const schema = createPostgresSchemaConfig(options.schema ?? {});
  return quotePostgresIdentifier(schema.primarySchema);
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function validNow(nowEpoch: number): void {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0
      || !Number.isFinite(new Date(nowEpoch).getTime())) {
    throw new TypeError("nowEpoch must be a non-negative safe integer");
  }
}

function bytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function epoch(value: Date | string | null): number | null {
  if (value === null) return null;
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function canonicalInstant(value: Date | string | null): string | null {
  const valueEpoch = epoch(value);
  return valueEpoch === null ? null : new Date(valueEpoch).toISOString();
}

function normalizeLedger(row: RenewalLedgerRow | undefined): NormalizedRenewalLedger | null {
  if (!row) return null;
  const secretHash = bytes(row.device_secret_hash);
  const issuedAt = canonicalInstant(row.issued_at);
  const expiresAt = canonicalInstant(row.expires_at);
  const renewedAt = canonicalInstant(row.renewed_at);
  const generation = Number(row.renewal_generation);
  if (typeof row.device_id !== "string" || secretHash === null || secretHash.byteLength !== 32
      || typeof row.policy_version !== "string" || typeof row.authorization_basis !== "string"
      || row.state !== "active" && row.state !== "revoked"
      || issuedAt === null || row.issued_at_millisecond_aligned !== true
      || expiresAt === null || row.expires_at_millisecond_aligned !== true
      || row.renewed_at !== null && (renewedAt === null
        || row.renewed_at_millisecond_aligned !== true)
      || row.renewed_at === null && row.renewed_at_millisecond_aligned !== null
      || !Number.isSafeInteger(generation) || generation < 0
      || generation > ACCOUNTLESS_RENEWAL_GENERATION_MAXIMUM) {
    return null;
  }
  return {
    ...row,
    device_secret_hash: secretHash,
    issued_at: issuedAt,
    expires_at: expiresAt,
    renewal_generation: generation,
    renewed_at: renewedAt,
  };
}

function leaseExpiryEpoch(ledger: NormalizedRenewalLedger): number | null {
  const issuedEpoch = Date.parse(ledger.issued_at);
  const expiryEpoch = Date.parse(ledger.expires_at);
  if (ledger.renewal_generation === 0) {
    if (ledger.renewed_at !== null
        || expiryEpoch !== issuedEpoch + ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS) {
      return null;
    }
    return expiryEpoch;
  }
  if (ledger.renewed_at === null) return null;
  const renewedEpoch = Date.parse(ledger.renewed_at);
  if (renewedEpoch < issuedEpoch
      || expiryEpoch !== renewedEpoch + ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS) {
    return null;
  }
  return expiryEpoch;
}

async function readLedger(
  client: PostgresClient,
  schema: string,
  deviceId: string,
  lock: boolean,
): Promise<NormalizedRenewalLedger | null> {
  const result = await client.query<RenewalLedgerRow>(
    `SELECT device_id, device_secret_hash, policy_version, authorization_basis, state,
            issued_at, date_trunc('milliseconds', issued_at) = issued_at
              AS issued_at_millisecond_aligned,
            expires_at, date_trunc('milliseconds', expires_at) = expires_at
              AS expires_at_millisecond_aligned,
            renewal_generation, renewed_at,
            CASE WHEN renewed_at IS NULL THEN NULL
              ELSE date_trunc('milliseconds', renewed_at) = renewed_at END
              AS renewed_at_millisecond_aligned
       FROM ${table(schema, "accountless_enrollment_ledger")}
      WHERE device_id = $1${lock ? " FOR UPDATE" : ""}`,
    [deviceId],
  );
  if (result.rows.length > 1) throw unavailable();
  const ledger = normalizeLedger(result.rows[0]);
  if (result.rows.length === 1 && ledger === null) throw unavailable();
  return ledger;
}

async function readGraph(
  client: PostgresClient,
  schema: string,
  deviceId: string,
  lock: boolean,
): Promise<NormalizedRenewalGraph | null> {
  const result = await client.query<RenewalGraphRow>(
    `SELECT participant.id AS participant_id,
            participant.state AS participant_state,
            participant.owner_kind AS participant_owner_kind,
            participant.access_token_id, participant.access_token_hash,
            participant.recovery_token_id, participant.recovery_token_hash,
            participant.consent_version, participant.consented_at,
            device.id AS device_id, device.participant_id AS device_participant_id,
            device.authority_kind AS device_authority_kind,
            device.accountless_enrollment_device_id AS device_enrollment_device_id,
            device.secret_hash AS device_secret_hash, device.state AS device_state,
            device.expires_at AS device_expires_at,
            date_trunc('milliseconds', device.expires_at) = device.expires_at
              AS device_expires_at_millisecond_aligned,
            device.social_verified_at AS device_social_verified_at,
            owner.enrollment_device_id AS owner_enrollment_device_id,
            owner.participant_id AS owner_participant_id,
            owner.device_credential_id AS owner_device_credential_id,
            owner.policy_version AS owner_policy_version,
            owner.authorization_basis AS owner_authorization_basis,
            owner.state AS owner_state, owner.expires_at AS owner_expires_at,
            date_trunc('milliseconds', owner.expires_at) = owner.expires_at
              AS owner_expires_at_millisecond_aligned,
            grant_row.enrollment_device_id AS authorization_enrollment_device_id,
            grant_row.participant_id AS authorization_participant_id,
            grant_row.device_credential_id AS authorization_device_credential_id,
            grant_row.telemetry_schema_version AS authorization_telemetry_schema_version,
            grant_row.state AS authorization_state,
            grant_row.expires_at AS authorization_expires_at,
            date_trunc('milliseconds', grant_row.expires_at) = grant_row.expires_at
              AS authorization_expires_at_millisecond_aligned
       FROM ${table(schema, "accountless_upload_owners")} owner
       JOIN ${table(schema, "participants")} participant
         ON participant.id = owner.participant_id
       JOIN ${table(schema, "device_credentials")} device
         ON device.id = owner.device_credential_id
       JOIN ${table(schema, "accountless_v11_device_authorizations")} grant_row
         ON grant_row.enrollment_device_id = owner.enrollment_device_id
        AND grant_row.participant_id = owner.participant_id
        AND grant_row.device_credential_id = owner.device_credential_id
      WHERE owner.enrollment_device_id = $1${lock ? " FOR UPDATE OF participant, device, owner, grant_row" : ""}`,
    [deviceId],
  );
  if (result.rows.length > 1) throw unavailable();
  const row = result.rows[0];
  if (!row) return null;
  const deviceExpiry = canonicalInstant(row.device_expires_at);
  const ownerExpiry = canonicalInstant(row.owner_expires_at);
  const authorizationExpiry = canonicalInstant(row.authorization_expires_at);
  if (deviceExpiry === null || row.device_expires_at_millisecond_aligned !== true
      || ownerExpiry === null || row.owner_expires_at_millisecond_aligned !== true
      || authorizationExpiry === null
      || row.authorization_expires_at_millisecond_aligned !== true) {
    return null;
  }
  return {
    ...row,
    device_expires_at: deviceExpiry,
    owner_expires_at: ownerExpiry,
    authorization_expires_at: authorizationExpiry,
  };
}

function validGraph(
  ledger: NormalizedRenewalLedger,
  graph: NormalizedRenewalGraph | null,
): graph is NormalizedRenewalGraph {
  return graph !== null
    && graph.participant_state === "active"
    && graph.participant_owner_kind === "accountless"
    && graph.access_token_id === null
    && graph.access_token_hash === null
    && graph.recovery_token_id === null
    && graph.recovery_token_hash === null
    && graph.consent_version === null
    && graph.consented_at === null
    && graph.device_id === ledger.device_id
    && graph.device_participant_id === graph.participant_id
    && graph.device_authority_kind === "accountless"
    && graph.device_enrollment_device_id === ledger.device_id
    && timingSafeEqual(graph.device_secret_hash, ledger.device_secret_hash)
    && graph.device_state === "active"
    && graph.device_social_verified_at === null
    && graph.owner_enrollment_device_id === ledger.device_id
    && graph.owner_participant_id === graph.participant_id
    && graph.owner_device_credential_id === ledger.device_id
    && graph.owner_policy_version === ledger.policy_version
    && graph.owner_authorization_basis === ledger.authorization_basis
    && graph.owner_state === "active"
    && graph.authorization_enrollment_device_id === ledger.device_id
    && graph.authorization_participant_id === graph.participant_id
    && graph.authorization_device_credential_id === ledger.device_id
    && graph.authorization_telemetry_schema_version
      === ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION
    && graph.authorization_state === "active"
    && graph.device_expires_at === ledger.expires_at
    && graph.owner_expires_at === ledger.expires_at
    && graph.authorization_expires_at === ledger.expires_at;
}

function renewalResponse(
  ledger: NormalizedRenewalLedger,
  state: AccountlessRenewalResponse["state"],
): AccountlessRenewalResponse {
  return Object.freeze({
    schemaVersion: ACCOUNTLESS_RENEWAL_SCHEMA_VERSION,
    state,
    deviceId: ledger.device_id,
    expiresAt: ledger.expires_at,
    renewalGeneration: ledger.renewal_generation,
    policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    scope: ACCOUNTLESS_RENEWAL_SCOPE,
    telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  });
}

async function authenticatedRenewableGraph(
  client: PostgresClient,
  schema: string,
  deviceId: string,
  presentedHash: Uint8Array,
  lock: boolean,
): Promise<{ ledger: NormalizedRenewalLedger; graph: NormalizedRenewalGraph }> {
  if (lock) {
    // Upload authentication locks device/participant before it shares the
    // accountless ledger graph. Follow that order to avoid a device↔ledger
    // deadlock while renewal and uploads overlap.
    await client.query(
      `SELECT device.id
         FROM ${table(schema, "device_credentials")} device
         JOIN ${table(schema, "participants")} participant
           ON participant.id = device.participant_id
        WHERE device.id = $1
        FOR UPDATE OF device, participant`,
      [deviceId],
    );
  }
  const ledger = await readLedger(client, schema, deviceId, lock);
  if (!ledger || !timingSafeEqual(presentedHash, ledger.device_secret_hash)) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  if (ledger.policy_version !== ACCOUNTLESS_ENROLLMENT_POLICY_VERSION
      || ledger.authorization_basis !== ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS
      || leaseExpiryEpoch(ledger) === null) {
    throw unavailable();
  }
  if (ledger.state === "revoked") {
    throw new ApiError(401, "ACCOUNTLESS_OWNERSHIP_REVOKED");
  }
  const graph = await readGraph(client, schema, ledger.device_id, lock);
  if (!validGraph(ledger, graph)) {
    // Renewal cannot repair a ledger-only enrollment or a partial/revoked graph.
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  return { ledger, graph };
}

/**
 * Renew only the exact active v1.1 accountless owner graph. Lock bearer rows
 * before the ledger, matching the upload path; row locks serialize renewals
 * for one device. Any exact, active v1.2 grant is extended in the same
 * transaction; absent, revoked, or mismatched grants are never created or
 * reactivated. Every fenced update and readback commits or rolls back together.
 */
export async function renewPostgresAccountlessUploadOwner(
  pool: PostgresPool,
  authorizationHeader: string | null,
  request: AccountlessRenewalRequest,
  options: PostgresAccountlessRenewalOptions = {},
): Promise<AccountlessRenewalResponse> {
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function") {
    throw unavailable();
  }
  parseAccountlessRenewalRequest(request);
  const nowEpoch = options.nowEpoch ?? Date.now();
  validNow(nowEpoch);
  const schema = schemaName(options);
  const parsed = parseDeviceAuthorization(authorizationHeader);
  const presentedHash = await deviceHash(parsed.id, parsed.secret);
  let observedGeneration: number | null = null;

  try {
    return await withPostgresMutation(pool, async (client) => {
      const { ledger, graph } = await authenticatedRenewableGraph(
        client, schema, parsed.id, presentedHash, true,
      );
      observedGeneration = ledger.renewal_generation;
      const expiryEpoch = leaseExpiryEpoch(ledger);
      if (expiryEpoch === null) throw unavailable();
      if (expiryEpoch > nowEpoch
          && expiryEpoch - nowEpoch > ACCOUNTLESS_RENEWAL_WINDOW_MILLISECONDS) {
        return renewalResponse(ledger, "existing");
      }
      if (ledger.renewal_generation >= ACCOUNTLESS_RENEWAL_GENERATION_MAXIMUM) {
        throw new ApiError(409, "LIFECYCLE_BOUNDS_EXCEEDED");
      }

      const renewedAt = new Date(nowEpoch).toISOString();
      const nextExpiryEpoch = nowEpoch + ACCOUNTLESS_ENROLLMENT_LEASE_MILLISECONDS;
      if (!Number.isFinite(new Date(nextExpiryEpoch).getTime())) throw unavailable();
      const expiresAt = new Date(nextExpiryEpoch).toISOString();
      const nextGeneration = ledger.renewal_generation + 1;
      const ledgerUpdate = await client.query(
        `UPDATE ${table(schema, "accountless_enrollment_ledger")}
            SET expires_at = $1::timestamptz, renewed_at = $2::timestamptz,
                renewal_generation = $3
          WHERE device_id = $4 AND device_secret_hash = $5
            AND policy_version = $6 AND authorization_basis = $7
            AND state = 'active' AND expires_at = $8::timestamptz
            AND renewal_generation = $9
            AND renewed_at IS NOT DISTINCT FROM $10::timestamptz
          RETURNING device_id`,
        [expiresAt, renewedAt, nextGeneration, ledger.device_id, presentedHash,
          ACCOUNTLESS_ENROLLMENT_POLICY_VERSION, ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
          ledger.expires_at, ledger.renewal_generation, ledger.renewed_at],
      );
      if (ledgerUpdate.rowCount !== 1) throw unavailable();

      // v1.2 is optional authority layered on top of the v1.1 owner lease.
      // Extend only an existing exact grant whose previous expiry matched the
      // complete old graph; a missing/revoked/mismatched row is an intentional
      // no-op and never gains authority as a side effect of renewal.
      const v12AuthorizationUpdate = await client.query(
        `UPDATE ${table(schema, "accountless_v12_device_authorizations")}
            SET expires_at = $1::timestamptz
          WHERE enrollment_device_id = $2 AND participant_id = $3
            AND device_credential_id = $4
            AND schema_version = $5 AND policy_version = $6 AND authorization_basis = $7
            AND telemetry_schema_version = $8 AND field_dictionary_version = $9
            AND privacy_contract_version = $10
            AND state = 'active' AND expires_at = $11::timestamptz
            AND EXISTS (
              SELECT 1 FROM ${table(schema, "accountless_enrollment_ledger")} ledger
                JOIN ${table(schema, "accountless_upload_owners")} owner
                  ON owner.enrollment_device_id = ledger.device_id
                JOIN ${table(schema, "device_credentials")} device
                  ON device.id = owner.device_credential_id
                JOIN ${table(schema, "accountless_v11_device_authorizations")} grant_row
                  ON grant_row.enrollment_device_id = ledger.device_id
                 AND grant_row.participant_id = owner.participant_id
                 AND grant_row.device_credential_id = device.id
               WHERE ledger.device_id = $2 AND ledger.state = 'active'
                 AND ledger.expires_at = $1::timestamptz
                 AND ledger.renewal_generation = $12 AND ledger.renewed_at = $13::timestamptz
                 AND owner.participant_id = $3 AND owner.device_credential_id = $4
                 AND owner.state = 'active' AND owner.expires_at = $11::timestamptz
                 AND device.participant_id = owner.participant_id
                 AND device.authority_kind = 'accountless'
                 AND device.accountless_enrollment_device_id = ledger.device_id
                 AND device.secret_hash = ledger.device_secret_hash
                 AND device.state = 'active' AND device.social_verified_at IS NULL
                 AND device.expires_at = $11::timestamptz
                 AND grant_row.state = 'active'
                 AND grant_row.telemetry_schema_version = $14
                 AND grant_row.expires_at = $11::timestamptz
            )
          RETURNING enrollment_device_id`,
        [expiresAt, ledger.device_id, graph.participant_id, ledger.device_id,
          ACCOUNTLESS_V12_UPLOAD_SCHEMA_VERSION, ACCOUNTLESS_V12_UPLOAD_POLICY_VERSION,
          ACCOUNTLESS_V12_UPLOAD_AUTHORIZATION_BASIS, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
          TELEMETRY_V12_FIELD_DICTIONARY_VERSION, TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
          ledger.expires_at, nextGeneration, renewedAt,
          ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION],
      );
      if ((v12AuthorizationUpdate.rowCount ?? 0) > 1) throw unavailable();

      const deviceUpdate = await client.query(
        `UPDATE ${table(schema, "device_credentials")}
            SET expires_at = $1::timestamptz
          WHERE id = $2 AND participant_id = $3
            AND authority_kind = 'accountless'
            AND accountless_enrollment_device_id = $2
            AND state = 'active' AND social_verified_at IS NULL
            AND secret_hash = $4 AND expires_at = $5::timestamptz
          RETURNING id`,
        [expiresAt, ledger.device_id, graph.participant_id, presentedHash, ledger.expires_at],
      );
      if (deviceUpdate.rowCount !== 1) throw unavailable();

      const ownerUpdate = await client.query(
        `UPDATE ${table(schema, "accountless_upload_owners")}
            SET expires_at = $1::timestamptz
          WHERE enrollment_device_id = $2 AND participant_id = $3
            AND device_credential_id = $2 AND state = 'active'
            AND policy_version = $4 AND authorization_basis = $5
            AND expires_at = $6::timestamptz
          RETURNING enrollment_device_id`,
        [expiresAt, ledger.device_id, graph.participant_id,
          ACCOUNTLESS_ENROLLMENT_POLICY_VERSION, ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
          ledger.expires_at],
      );
      if (ownerUpdate.rowCount !== 1) throw unavailable();

      const authorizationUpdate = await client.query(
        `UPDATE ${table(schema, "accountless_v11_device_authorizations")}
            SET expires_at = $1::timestamptz
          WHERE enrollment_device_id = $2 AND participant_id = $3
            AND device_credential_id = $2 AND state = 'active'
            AND telemetry_schema_version = $4
            AND expires_at = $5::timestamptz
          RETURNING enrollment_device_id`,
        [expiresAt, ledger.device_id, graph.participant_id,
          ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION, ledger.expires_at],
      );
      if (authorizationUpdate.rowCount !== 1) throw unavailable();

      const renewed = await authenticatedRenewableGraph(
        client, schema, parsed.id, presentedHash, false,
      );
      const actualExpiry = leaseExpiryEpoch(renewed.ledger);
      if (renewed.ledger.renewal_generation !== nextGeneration
          || renewed.ledger.renewed_at !== renewedAt
          || renewed.ledger.expires_at !== expiresAt
          || actualExpiry !== nextExpiryEpoch
          || !validGraph(renewed.ledger, renewed.graph)) {
        throw unavailable();
      }
      return renewalResponse(renewed.ledger, "renewed");
    }, { operation: "accountless.renewal", preserveSafeError: safeError });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (observedGeneration !== null) {
      try {
        const replay = await withPostgresRead(
          pool,
          (client) => authenticatedRenewableGraph(
            client, schema, parsed.id, presentedHash, false,
          ),
          { operation: "accountless.renewal.replay", preserveSafeError: safeError },
        );
        const replayExpiry = leaseExpiryEpoch(replay.ledger);
        if (replay.ledger.renewal_generation > observedGeneration
            && replayExpiry !== null && replayExpiry > nowEpoch) {
          return renewalResponse(replay.ledger, "existing");
        }
      } catch (replayError) {
        if (replayError instanceof ApiError) throw replayError;
      }
    }
    throw unavailable();
  }
}
