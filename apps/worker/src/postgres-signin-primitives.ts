/**
 * Hosted sign-in preconditions shared by the PostgreSQL Google and Apple web
 * sign-in routes and hosted enrollment.
 *
 * These are production primitives. Unlike the test-composition adapter in
 * postgres-google-handoff.ts, the identity-link pin here is SELECT-only: a
 * production PostgreSQL primary must already hold the pin imported from D1,
 * and an absent row fails closed instead of silently founding a new pseudonym
 * namespace. Every helper keeps the Worker's error codes; none of them logs,
 * returns, or persists a secret, fingerprint, address, state, or proof.
 */
import { configuredEnrollmentMode } from "./admission";
import { ApiError } from "./errors";
import {
  IDENTITY_LINK_SECRET_VERSION_PATTERN,
  identityLinkSecretFingerprint,
} from "./identity-link-configuration";
import {
  normalizePostgresError,
  PostgresStorageError,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
} from "./postgres-client";
import {
  assertSignInStartAdmissionConfiguration,
  SIGN_IN_START_ADMISSION_WINDOW_MILLISECONDS,
} from "./signin-admission";

/** At most this many expired handoff rows are purged per request (Worker parity). */
export const MAX_EXPIRED_SIGNIN_HANDOFFS_PER_REQUEST = 100;

/** The closed set of handoff tables a purge may address. */
export const SIGNIN_HANDOFF_TABLES = Object.freeze([
  "google_signin_handoffs",
  "apple_signin_handoffs",
] as const);

export type PostgresSignInHandoffTable = (typeof SIGNIN_HANDOFF_TABLES)[number];

/**
 * The shared collection-control check for "enrollment". It is injected
 * because the PostgreSQL collection-controls module is composed separately.
 * It either rejects with the reader's ApiError (COLLECTION_ENROLLMENT_DISABLED
 * or COLLECTION_CONTROL_UNAVAILABLE) or resolves. When it resolves with the
 * controls snapshot, the enrollment flag is re-checked here, so wiring a
 * non-asserting reader can never admit a paused service.
 */
export type PostgresSignInCollectionControlCheck = (
  pool: PostgresPool,
  schema: string,
  name: "enrollment",
) => Promise<unknown>;

export interface PostgresHostedSignInStartOptions {
  readonly readControl: PostgresSignInCollectionControlCheck;
}

export interface PostgresSignInStartAdmission {
  readonly acceptedCount: number;
  readonly windowStartedAt: string;
}

const STATEMENT_TIMEOUT_MILLISECONDS = 5_000;
const LOCK_TIMEOUT_MILLISECONDS = 2_000;
const PROPAGATED_CONTROL_CODES: ReadonlySet<string> = new Set([
  "COLLECTION_CONTROL_UNAVAILABLE",
  "COLLECTION_ENROLLMENT_DISABLED",
]);

interface IdentityLinkPinRow {
  readonly key_version: unknown;
  readonly secret_fingerprint: unknown;
}

function isPool(value: unknown): value is PostgresPool {
  return value !== null && typeof value === "object"
    && typeof (value as Partial<PostgresClient>).release !== "function"
    && typeof (value as Partial<PostgresPool>).connect === "function";
}

function isClient(value: unknown): value is PostgresClient {
  return value !== null && typeof value === "object"
    && typeof (value as Partial<PostgresClient>).query === "function";
}

function assertPoolOrClient(value: unknown): asserts value is PostgresPool | PostgresClient {
  if (!isPool(value) && !isClient(value)) {
    throw new TypeError("POSTGRES_SIGNIN_STORAGE_INVALID");
  }
}

function assertPool(value: unknown): asserts value is PostgresPool {
  if (!isPool(value)) throw new TypeError("POSTGRES_SIGNIN_STORAGE_INVALID");
}

function assertEnvironment(env: unknown): asserts env is Env {
  if (env === null || typeof env !== "object") {
    throw new TypeError("POSTGRES_SIGNIN_ENVIRONMENT_INVALID");
  }
}

function assertEpoch(nowEpoch: unknown): asserts nowEpoch is number {
  if (!Number.isSafeInteger(nowEpoch) || (nowEpoch as number) < 0) {
    throw new TypeError("POSTGRES_SIGNIN_CLOCK_INVALID");
  }
}

function identityConfigurationInvalid(): ApiError {
  return new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
}

/**
 * Require the pinned identity-link secret that D1 already established.
 *
 * Configuration: IDENTITY_LINK_SECRET is at least 32 characters and
 * IDENTITY_LINK_SECRET_VERSION matches the Worker's version pattern. The
 * fingerprint is the Worker's exported identityLinkSecretFingerprint. An
 * absent row, a version mismatch or a fingerprint mismatch is
 * 503 IDENTITY_CONFIGURATION_INVALID; a storage fault is
 * 503 BACKEND_STORAGE_UNAVAILABLE.
 *
 * This deliberately never INSERTs: the Worker's first-use establishment would
 * let an empty or restored primary adopt whatever secret the host happens to
 * carry. A pool runs the lookup in its own read-only transaction; a client
 * runs it inside the caller's transaction.
 */
export async function assertExistingPostgresIdentityLinkPin(
  poolOrClient: PostgresPool | PostgresClient,
  schema: string,
  env: Env,
): Promise<void> {
  assertPoolOrClient(poolOrClient);
  const table = `${quotePostgresIdentifier(schema)}."identity_link_secret_configuration"`;
  assertEnvironment(env);
  const secret = Reflect.get(env, "IDENTITY_LINK_SECRET");
  const version = Reflect.get(env, "IDENTITY_LINK_SECRET_VERSION");
  if (typeof secret !== "string" || secret.length < 32
      || typeof version !== "string"
      || !IDENTITY_LINK_SECRET_VERSION_PATTERN.test(version)) {
    throw identityConfigurationInvalid();
  }
  const fingerprint = await identityLinkSecretFingerprint(secret);
  const read = async (client: PostgresClient): Promise<readonly IdentityLinkPinRow[]> => {
    const result = await client.query<IdentityLinkPinRow>(
      `SELECT key_version, secret_fingerprint
         FROM ${table}
        WHERE singleton = 1`,
    );
    if (!Array.isArray(result?.rows)) {
      throw new PostgresStorageError("unavailable", "signin.identity_link_pin");
    }
    return result.rows;
  };
  let rows: readonly IdentityLinkPinRow[];
  try {
    rows = isPool(poolOrClient)
      ? await withPostgresRead(poolOrClient, read, {
        operation: "signin.identity_link_pin",
        statementTimeoutMilliseconds: STATEMENT_TIMEOUT_MILLISECONDS,
        lockTimeoutMilliseconds: LOCK_TIMEOUT_MILLISECONDS,
      })
      : await read(poolOrClient);
  } catch {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row?.key_version !== version || row.secret_fingerprint !== fingerprint) {
    throw identityConfigurationInvalid();
  }
}

function assertEnrollmentControlResult(controls: unknown): void {
  if (controls === undefined) return;
  if (controls === null || typeof controls !== "object") {
    throw new ApiError(503, "COLLECTION_CONTROL_UNAVAILABLE");
  }
  const enrollment = Reflect.get(controls, "enrollment");
  if (enrollment === true) return;
  if (enrollment === false) throw new ApiError(503, "COLLECTION_ENROLLMENT_DISABLED");
  throw new ApiError(503, "COLLECTION_CONTROL_UNAVAILABLE");
}

/**
 * The hosted sign-in start preconditions, in Worker order
 * (assertHostedSignInStartAllowed in index.ts):
 * 1. the enrollment mode is configured (an invalid value, or local_open
 *    outside development, is 503 ADMISSION_CONFIGURATION_INVALID; 'disabled'
 *    is allowed because existing participants reattach through sign-in);
 * 2. the 'enrollment' collection control is enabled;
 * 3. the existing identity-link pin matches.
 *
 * The pin is checked unconditionally: this primitive is hosted-only, and a
 * production host never establishes a pin.
 */
export async function assertPostgresHostedSignInStartAllowed(
  pool: PostgresPool,
  schema: string,
  env: Env,
  options: PostgresHostedSignInStartOptions,
): Promise<void> {
  assertPool(pool);
  quotePostgresIdentifier(schema);
  assertEnvironment(env);
  const readControl = options?.readControl;
  if (typeof readControl !== "function") {
    throw new TypeError("POSTGRES_SIGNIN_CONTROL_READER_INVALID");
  }
  configuredEnrollmentMode(env);
  let controls: unknown;
  try {
    controls = await readControl(pool, schema, "enrollment");
  } catch (error) {
    if (error instanceof ApiError && error.status === 503
        && PROPAGATED_CONTROL_CODES.has(error.code)) {
      throw error;
    }
    throw new ApiError(503, "COLLECTION_CONTROL_UNAVAILABLE");
  }
  assertEnrollmentControlResult(controls);
  await assertExistingPostgresIdentityLinkPin(pool, schema, env);
}

/**
 * Consume one slot of the GLOBAL origin-tier sign-in-start window.
 *
 * SIGN_IN_START_MAX_PER_MINUTE must be a decimal integer from 1 to 1200
 * (the Worker's own validator). One compare-and-increment upsert on the
 * floor(now / 60 s) row of sign_in_start_admission_windows admits while
 * accepted_count < limit. When the window is exhausted the result is
 * 429 SIGN_IN_START_LIMIT_REACHED with retry-after =
 * max(1, ceil((windowEnd - now) / 1000)). A storage fault is
 * 503 ADMISSION_RATE_LIMIT_UNAVAILABLE with the Worker's retry-after of 60.
 *
 * The address-keyed sign_in_start attempt limit is a separate edge-tier
 * control and is not applied here. Only the minute bucket and an aggregate
 * count are stored.
 */
export async function admitPostgresSignInStart(
  pool: PostgresPool,
  schema: string,
  env: Env,
  nowEpoch: number,
): Promise<PostgresSignInStartAdmission> {
  assertPool(pool);
  const table = `${quotePostgresIdentifier(schema)}."sign_in_start_admission_windows"`;
  assertEnvironment(env);
  assertEpoch(nowEpoch);
  assertSignInStartAdmissionConfiguration(env);
  const limit = Number(Reflect.get(env, "SIGN_IN_START_MAX_PER_MINUTE"));
  const startedAtEpoch = Math.floor(nowEpoch / SIGN_IN_START_ADMISSION_WINDOW_MILLISECONDS)
    * SIGN_IN_START_ADMISSION_WINDOW_MILLISECONDS;
  const windowEndsAt = startedAtEpoch + SIGN_IN_START_ADMISSION_WINDOW_MILLISECONDS;
  const windowStartedAt = new Date(startedAtEpoch).toISOString();
  let acceptedCount: unknown;
  try {
    acceptedCount = await withPostgresMutation(pool, async (client) => {
      const result = await client.query<{ readonly accepted_count: unknown }>(
        `INSERT INTO ${table} AS admission (
           window_started_at, accepted_count, last_accepted_at
         ) VALUES ($1::timestamptz, 1, $2::timestamptz)
         ON CONFLICT (window_started_at) DO UPDATE SET
           accepted_count = admission.accepted_count + 1,
           last_accepted_at = EXCLUDED.last_accepted_at
         WHERE admission.accepted_count < $3
         RETURNING accepted_count`,
        [windowStartedAt, new Date(nowEpoch).toISOString(), limit],
      );
      if (!Array.isArray(result?.rows) || result.rows.length > 1) {
        throw new PostgresStorageError("unavailable", "signin.start_admission");
      }
      return result.rows[0]?.accepted_count ?? null;
    }, {
      operation: "signin.start_admission",
      statementTimeoutMilliseconds: STATEMENT_TIMEOUT_MILLISECONDS,
      lockTimeoutMilliseconds: LOCK_TIMEOUT_MILLISECONDS,
    });
  } catch {
    throw new ApiError(503, "ADMISSION_RATE_LIMIT_UNAVAILABLE", {
      responseHeaders: { "retry-after": "60" },
    });
  }
  if (typeof acceptedCount !== "number" || !Number.isSafeInteger(acceptedCount)
      || acceptedCount < 1 || acceptedCount > limit) {
    throw new ApiError(429, "SIGN_IN_START_LIMIT_REACHED", {
      responseHeaders: {
        "retry-after": String(Math.max(1, Math.ceil((windowEndsAt - nowEpoch) / 1_000))),
      },
    });
  }
  return Object.freeze({ acceptedCount, windowStartedAt });
}

/**
 * Delete at most 100 expired rows (expires_at <= now) from one handoff table,
 * oldest first by (expires_at, state), and return how many were deleted.
 *
 * A pool runs the delete in its own bounded transaction; a client runs it in
 * the caller's transaction. Storage faults surface as a sanitized
 * PostgresStorageError so each route keeps its own fault mapping.
 */
export async function purgeExpiredHandoffs(
  poolOrClient: PostgresPool | PostgresClient,
  schema: string,
  table: PostgresSignInHandoffTable,
  nowEpoch: number,
): Promise<number> {
  assertPoolOrClient(poolOrClient);
  if (!(SIGNIN_HANDOFF_TABLES as readonly string[]).includes(table)) {
    throw new TypeError("POSTGRES_SIGNIN_HANDOFF_TABLE_INVALID");
  }
  const qualified = `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table)}`;
  assertEpoch(nowEpoch);
  const nowIso = new Date(nowEpoch).toISOString();
  const operation = "signin.purge_expired_handoffs";
  const purge = async (client: PostgresClient): Promise<number> => {
    const result = await client.query(
      `WITH expired AS (
         SELECT state FROM ${qualified}
          WHERE expires_at <= $1::timestamptz
          ORDER BY expires_at, state
          LIMIT $2
       )
       DELETE FROM ${qualified} AS handoff USING expired
        WHERE handoff.state = expired.state`,
      [nowIso, MAX_EXPIRED_SIGNIN_HANDOFFS_PER_REQUEST],
    );
    const purged = result?.rowCount;
    if (typeof purged !== "number" || !Number.isSafeInteger(purged)
        || purged < 0 || purged > MAX_EXPIRED_SIGNIN_HANDOFFS_PER_REQUEST) {
      throw new PostgresStorageError("unavailable", operation);
    }
    return purged;
  };
  if (isPool(poolOrClient)) {
    return withPostgresMutation(poolOrClient, purge, {
      operation,
      statementTimeoutMilliseconds: STATEMENT_TIMEOUT_MILLISECONDS,
      lockTimeoutMilliseconds: LOCK_TIMEOUT_MILLISECONDS,
    });
  }
  try {
    return await purge(poolOrClient);
  } catch (error) {
    throw normalizePostgresError(error, operation);
  }
}
