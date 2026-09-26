import {
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";
import { assertPostgresTelemetryTransportWriteAllowed as assertPostgresV12FormatAuthority } from "./postgres-telemetry-format-authority";
import {
  assertPostgresTypedV12WriteAllowed,
  type PostgresTypedV12Principal,
} from "./postgres-typed-v12-admission";
import {
  telemetryTransportSchemaForEnvelope,
  telemetryTransportSchemaVersion,
  type TelemetryTransportPrincipal,
  type TelemetryTransportSchemaVersion,
} from "./telemetry-transport-policy";

/**
 * The single PostgreSQL write-authority assertion for every telemetry
 * transport format: an exact port of the Worker's
 * assertTelemetryTransportWriteAllowed (src/telemetry-transport-policy.ts).
 *
 * The schema parsers are the Worker's own functions, re-exported rather than
 * copied, so both runtimes accept and refuse exactly the same identifiers.
 */
export { telemetryTransportSchemaForEnvelope, telemetryTransportSchemaVersion };
export type { TelemetryTransportPrincipal, TelemetryTransportSchemaVersion };

/**
 * Write rank of each transport format, as the D1 format table fixes them
 * (migrations/0044:33-42). v1.2 has no rank: the Worker negotiates it as a
 * separate successor whose authority is its runtime and device capability,
 * and it never reads or changes a transport floor. (PostgreSQL's own format
 * table carries a v1.2 row at rank 12; no write decision reads it.)
 */
export const TELEMETRY_TRANSPORT_FORMAT_RANKS: Readonly<
  Record<TelemetryTransportSchemaVersion, number | null>
> = Object.freeze({
  "telemetry-contribution-v0.1": 1,
  "telemetry-contribution-v0.2": 2,
  "telemetry-contribution-v1.0": 10,
  "telemetry-contribution-v1.1": 11,
  "telemetry-contribution-v1.2": null,
});

export interface PostgresTransportWriteAuthorityOptions {
  readonly schema?: PostgresSchemaConfig;
  /** Request time; defaults to Date.now(). Replaces D1's strftime('now'). */
  readonly nowEpoch?: number;
  /**
   * Take FOR SHARE locks on the participant, device, both floors and the
   * v1.1 grant rows before reading, so the decision holds until the caller's
   * transaction ends. Requires a client inside that transaction; a pool is
   * refused, because its read transaction would release the locks at once.
   */
  readonly lock?: boolean;
}

interface TransportAuthorityRow {
  readonly lifecycle: string;
  readonly format_rank: number;
  readonly minimum_rank: number;
  readonly consent_v11: boolean;
  readonly owner_kind: string;
  readonly authority_kind: string;
  readonly accountless_v11: boolean;
  readonly incompatible_history: boolean;
}

type Target =
  | { readonly kind: "pool"; readonly pool: PostgresPool }
  | { readonly kind: "client"; readonly client: PostgresClient };

const OPERATION = "telemetry_transport.write_authority";

function target(value: PostgresClient | PostgresPool): Target {
  if (value !== null && typeof value === "object") {
    if (typeof (value as PostgresClient).release !== "function"
        && typeof (value as PostgresPool).connect === "function") {
      return { kind: "pool", pool: value as PostgresPool };
    }
    if (typeof (value as PostgresClient).query === "function") {
      return { kind: "client", client: value as PostgresClient };
    }
  }
  throw new TypeError("invalid PostgreSQL transport authority connection");
}

function requestEpoch(value: unknown): number {
  const epoch = value === undefined ? Date.now() : value;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0
      || !Number.isFinite(new Date(epoch).getTime())) {
    throw new TypeError("invalid PostgreSQL transport authority time");
  }
  return epoch;
}

function validPrincipal(principal: TelemetryTransportPrincipal): boolean {
  return principal !== null && typeof principal === "object"
    && typeof principal.participantId === "string" && principal.participantId.length > 0
    && typeof principal.deviceId === "string" && principal.deviceId.length > 0;
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function storageUnavailable(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

/**
 * The Worker refuses every v1.2 condition with one code (v12Unavailable:
 * 403 TELEMETRY_TRANSPORT_BLOCKED). The existing PostgreSQL v1.2 authority
 * distinguishes some of them (401 DEVICE_AUTH_INVALID, 400
 * TELEMETRY_REQUIRED); each such refusal is the Worker's 403 here. Storage
 * failures stay 503.
 */
function workerV12Refusal(error: unknown): ApiError {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  return storageUnavailable(error);
}

async function assertV12WriteAllowed(
  connection: Target,
  principal: TelemetryTransportPrincipal,
  nowEpoch: number,
  schema: PostgresSchemaConfig,
): Promise<void> {
  try {
    if (connection.kind === "pool") {
      // The existing PostgreSQL v1.2 authority, unchanged: it opens its own
      // bounded transaction around the typed v1.2 admission check.
      await assertPostgresV12FormatAuthority(connection.pool, principal,
        TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION, { nowEpoch, schema });
      return;
    }
    // Inside the caller's transaction: the same typed v1.2 check the format
    // authority delegates to (it takes its own FOR SHARE locks).
    await assertPostgresTypedV12WriteAllowed(connection.client,
      principal as PostgresTypedV12Principal, nowEpoch, { schema });
  } catch (error) {
    throw workerV12Refusal(error);
  }
}

/**
 * Lock order: participant, device, participant floor, device floor, v1.1
 * consent, accountless ledger, owner and v1.1 grant. It matches the floor
 * writers (participant floor before device floor). Absent rows cannot be
 * locked; the following read decides on what exists.
 */
async function lockAuthorityRows(
  client: PostgresClient,
  schema: string,
  principal: TelemetryTransportPrincipal,
): Promise<void> {
  const participant = principal.participantId;
  const device = principal.deviceId;
  await client.query(
    `SELECT 1 FROM ${table(schema, "participants")} WHERE id = $1 FOR SHARE`, [participant]);
  const credential = await client.query<{ accountless_enrollment_device_id: string | null }>(
    `SELECT accountless_enrollment_device_id FROM ${table(schema, "device_credentials")}
      WHERE id = $1 FOR SHARE`, [device]);
  await client.query(
    `SELECT 1 FROM ${table(schema, "telemetry_transport_participant_floors")}
      WHERE participant_id = $1 FOR SHARE`, [participant]);
  await client.query(
    `SELECT 1 FROM ${table(schema, "telemetry_transport_device_floors")}
      WHERE participant_id = $1 AND device_id = $2 FOR SHARE`, [participant, device]);
  await client.query(
    `SELECT 1 FROM ${table(schema, "telemetry_v11_device_consents")}
      WHERE participant_id = $1 AND device_id = $2 FOR SHARE`, [participant, device]);
  const enrollment = credential.rows[0]?.accountless_enrollment_device_id ?? null;
  if (enrollment !== null) {
    await client.query(
      `SELECT 1 FROM ${table(schema, "accountless_enrollment_ledger")}
        WHERE device_id = $1 FOR SHARE`, [enrollment]);
    await client.query(
      `SELECT 1 FROM ${table(schema, "accountless_upload_owners")}
        WHERE enrollment_device_id = $1 FOR SHARE`, [enrollment]);
    await client.query(
      `SELECT 1 FROM ${table(schema, "accountless_v11_device_authorizations")}
        WHERE enrollment_device_id = $1 FOR SHARE`, [enrollment]);
  }
}

/**
 * The Worker's one joined read (telemetry-transport-policy.ts:172-205) with
 * the device floor table present: the effective floor is
 * COALESCE(device floor, participant floor), and a missing participant
 * floor, format row, or active unexpired participant and device yields no
 * row. PostgreSQL binds the request time where D1 reads strftime('now').
 */
async function readAuthorityRow(
  client: PostgresClient,
  schema: string,
  principal: TelemetryTransportPrincipal,
  version: TelemetryTransportSchemaVersion,
  nowIso: string,
): Promise<TransportAuthorityRow | undefined> {
  const result = await client.query<TransportAuthorityRow>(
    `SELECT formats.lifecycle, formats.format_rank,
            COALESCE(device_floors.minimum_rank, floors.minimum_rank) AS minimum_rank,
            grant_v11.device_id IS NOT NULL AS consent_v11,
            p.owner_kind, d.authority_kind,
            accountless_grant.enrollment_device_id IS NOT NULL AS accountless_v11,
            EXISTS (SELECT 1 FROM ${table(schema, "telemetry_contributions")} legacy
              WHERE legacy.participant_id = p.id AND legacy.status = 'accepted'
                AND legacy.transport_schema_version = 'telemetry-contribution-v0.2') AS incompatible_history
       FROM ${table(schema, "participants")} p
       JOIN ${table(schema, "device_credentials")} d ON d.participant_id = p.id
       JOIN ${table(schema, "telemetry_transport_participant_floors")} floors ON floors.participant_id = p.id
       LEFT JOIN ${table(schema, "telemetry_transport_device_floors")} device_floors
         ON device_floors.participant_id = p.id AND device_floors.device_id = d.id
       JOIN ${table(schema, "telemetry_transport_formats")} formats ON formats.schema_version = $3
       LEFT JOIN ${table(schema, "telemetry_v11_device_consents")} grant_v11
         ON grant_v11.participant_id = p.id AND grant_v11.device_id = d.id
       LEFT JOIN ${table(schema, "accountless_enrollment_ledger")} ledger
         ON ledger.device_id = d.accountless_enrollment_device_id
        AND ledger.state = 'active' AND ledger.expires_at > $4::timestamptz
        AND ledger.expires_at = d.expires_at
       LEFT JOIN ${table(schema, "accountless_upload_owners")} owner
         ON owner.enrollment_device_id = ledger.device_id
        AND owner.participant_id = p.id AND owner.device_credential_id = d.id
        AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
       LEFT JOIN ${table(schema, "accountless_v11_device_authorizations")} accountless_grant
         ON accountless_grant.enrollment_device_id = ledger.device_id
        AND owner.enrollment_device_id = ledger.device_id
        AND accountless_grant.participant_id = p.id
        AND accountless_grant.device_credential_id = d.id
        AND accountless_grant.state = 'active'
        AND accountless_grant.expires_at = ledger.expires_at
      WHERE p.id = $1 AND d.id = $2 AND p.state = 'active' AND d.state = 'active'
        AND d.expires_at > $4::timestamptz`,
    [principal.participantId, principal.deviceId, version, nowIso],
  );
  const row = result.rows[0];
  if (row !== undefined && (!Number.isSafeInteger(row.format_rank)
      || !Number.isSafeInteger(row.minimum_rank)
      || typeof row.consent_v11 !== "boolean" || typeof row.accountless_v11 !== "boolean"
      || typeof row.incompatible_history !== "boolean")) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  return row;
}

/** The Worker's decision on the joined row, in the Worker's order. */
function decide(row: TransportAuthorityRow | undefined, version: TelemetryTransportSchemaVersion): void {
  if (!row) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const accountless = row.owner_kind === "accountless";
  if ((accountless && row.authority_kind !== "accountless")
      || (!accountless && row.owner_kind !== "social")
      || (!accountless && row.authority_kind !== "social")) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  if (row.lifecycle !== "accepted" || row.format_rank < row.minimum_rank
      || (version === TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION && row.incompatible_history)) {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  if (accountless && version !== TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION) {
    throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  if (version === TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION
      && (accountless ? !row.accountless_v11 : !row.consent_v11)) {
    throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  }
}

/**
 * Shared by upload authorization, contribution claims, staging and
 * activation, for all five formats. A pool call reads in its own bounded
 * read-only transaction; a client call runs inside the caller's transaction
 * and, with `lock`, holds FOR SHARE locks on the rows it decided on.
 *
 * Codes are the Worker's: an unknown or non-string schema is 403
 * TELEMETRY_TRANSPORT_BLOCKED; no joined row or an owner/authority mismatch
 * is 401 DEVICE_AUTH_INVALID; a non-accepted lifecycle, a rank below the
 * effective floor, v1.1 over accepted v0.2 history, or an accountless owner
 * on any format but v1.1 is 403 TELEMETRY_TRANSPORT_BLOCKED; v1.1 without
 * the social consent or the accountless ledger/owner/v1.1 grant chain is 403
 * TELEMETRY_CONSENT_INVALID. v1.2 delegates to the existing PostgreSQL v1.2
 * authority. A storage failure is 503 BACKEND_STORAGE_UNAVAILABLE.
 */
export async function assertPostgresTelemetryTransportWriteAllowed(
  clientOrPool: PostgresClient | PostgresPool,
  principal: TelemetryTransportPrincipal,
  schemaVersion: unknown,
  options: PostgresTransportWriteAuthorityOptions = {},
): Promise<void> {
  const connection = target(clientOrPool);
  const lock = options.lock ?? false;
  if (typeof lock !== "boolean") throw new TypeError("invalid PostgreSQL transport authority lock option");
  if (lock && connection.kind === "pool") {
    throw new TypeError("PostgreSQL transport authority locks require the caller's transaction client");
  }
  const nowEpoch = requestEpoch(options.nowEpoch);
  const schemaConfig = createPostgresSchemaConfig(options.schema ?? {});
  const version = telemetryTransportSchemaVersion(schemaVersion);
  if (version === TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION) {
    await assertV12WriteAllowed(connection, principal, nowEpoch, schemaConfig);
    return;
  }
  if (!validPrincipal(principal)) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const schema = quotePostgresIdentifier(schemaConfig.primarySchema);
  const nowIso = new Date(nowEpoch).toISOString();
  let row: TransportAuthorityRow | undefined;
  try {
    if (connection.kind === "pool") {
      row = await withPostgresRead(
        connection.pool,
        (client) => readAuthorityRow(client, schema, principal, version, nowIso),
        { operation: OPERATION, preserveSafeError: (error) => (error instanceof ApiError ? error : null) },
      );
    } else {
      if (lock) await lockAuthorityRows(connection.client, schema, principal);
      row = await readAuthorityRow(connection.client, schema, principal, version, nowIso);
    }
  } catch (error) {
    throw storageUnavailable(error);
  }
  decide(row, version);
}
