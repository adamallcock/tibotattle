import { ApiError, errorResponse, jsonResponse } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import { randomSecret, sha256Hex } from "./crypto";
import { assertSameOrigin } from "./session";
import { configuredEnrollmentMode } from "./admission";
import { MAX_REQUEST_BYTES } from "./constants";
import { readBoundedRequestBody } from "./bounded-body";
import {
  exchangeGoogleAuthorizationCode,
  googleAuthorizeUrl,
  googleCodeChallenge,
  googleSignInConfiguration,
  GOOGLE_SIGNIN_STATE_PATTERN,
  GOOGLE_PKCE_VERIFIER_PATTERN,
} from "./identity-google";
import { identityRequired, verifyHostedIdentity } from "./identity-oidc";

const AUTHORIZATION_TTL_MS = 10 * 60 * 1_000;
const DELIVERY_TTL_MS = 5 * 60 * 1_000;
const CLAIM_LEASE_MS = 60 * 1_000;
const MAX_CALLBACK_URL_LENGTH = 8 * 1024;
const MAX_EXPIRED_ROWS_PER_REQUEST = 100;
const HANDOFF_VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const HANDOFF_BINDING_PATTERN = /^[0-9a-f]{64}$/u;
const HANDOFF_PROOF_PATTERN = /^[A-Za-z0-9_-]{64}$/u;
const GOOGLE_LINK_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const IDENTITY_SECRET_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const IDENTITY_SECRET_FINGERPRINT_DOMAIN =
  "app-usagemonitor/identity-link-secret-fingerprint/v1\0";
const SIGN_IN_ADMISSION_WINDOW_MS = 60 * 1_000;
const SIGN_IN_ADMISSION_LIMIT = 1_200;
const CONTROL_BODY_READ_POLICY = Object.freeze({
  maximumTotalMilliseconds: 15_000,
  maximumIdleMilliseconds: 5_000,
});
const CALLBACK_APP_URL = "usagemonitor://open";
const COMPLETED_MESSAGE = "Signed in — return to TiboTattle.";
const NOT_COMPLETED_MESSAGE =
  "Sign-in was not completed. Return to TiboTattle and start the sign-in again.";

export type PostgresGoogleHandoffEnvironment = Env;

export interface PostgresGoogleHandoffDispatchOptions {
  readonly primaryPool: PostgresPool;
  readonly schemaOptions?: PostgresSchemaOptions;
  readonly privateOrigin: string;
  readonly env: PostgresGoogleHandoffEnvironment;
  readonly assertAdmissionBindings: (env: PostgresGoogleHandoffEnvironment) => void;
  readonly assertAttemptAllowed: (
    coarseLimiter: unknown,
    clientLimiter: unknown,
    request: Request,
    env: PostgresGoogleHandoffEnvironment,
    purpose: "sign_in_start",
  ) => Promise<void>;
  readonly healthDispatch: (request: Request) => Promise<Response>;
  readonly exchangeCode?: (
    env: PostgresGoogleHandoffEnvironment,
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ) => Promise<string>;
  readonly verifyIdentity?: (
    env: PostgresGoogleHandoffEnvironment,
    idToken: string,
  ) => Promise<{ readonly provider: "google"; readonly linkKeyHex: string }>;
  readonly now?: () => number;
}

interface GoogleHandoffRow {
  readonly proof: string;
}

function apiError(status: number, code: ConstructorParameters<typeof ApiError>[1]): ApiError {
  return new ApiError(status, code);
}

function tableName(schema: string): string {
  return `${quotePostgresIdentifier(schema)}."google_signin_handoffs"`;
}

function databaseError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

async function mutate<T>(
  pool: PostgresPool,
  operation: string,
  callback: Parameters<typeof withPostgresMutation<T>>[1],
): Promise<T> {
  return withPostgresMutation(pool, callback, {
    operation,
    statementTimeoutMilliseconds: 5_000,
    lockTimeoutMilliseconds: 2_000,
    preserveSafeError: databaseError,
  });
}

function requestOriginAllowed(privateOrigin: string): boolean {
  try {
    const origin = new URL(privateOrigin);
    return origin.origin === privateOrigin && origin.protocol === "https:";
  } catch {
    return false;
  }
}

function callbackUrl(request: Request, env: PostgresGoogleHandoffEnvironment): string {
  const requestUrl = new URL(request.url);
  if (requestUrl.protocol !== "https:") {
    throw apiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  if (!identityRequired(env)) {
    return `${requestUrl.origin}/api/v1/identity/google/callback`;
  }
  const rawOrigin = Reflect.get(env, "PUBLIC_ORIGIN");
  let configured: URL;
  try {
    configured = new URL(typeof rawOrigin === "string" ? rawOrigin : "");
  } catch {
    throw apiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  if (configured.protocol !== "https:"
      || configured.origin !== rawOrigin
      || configured.pathname !== "/"
      || configured.search !== ""
      || configured.hash !== "") {
    throw apiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  if (requestUrl.origin !== configured.origin) throw apiError(404, "NOT_FOUND");
  return `${configured.origin}/api/v1/identity/google/callback`;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw apiError(415, "CONTENT_TYPE_INVALID");
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) throw apiError(400, "BODY_INVALID");
    if (length > MAX_REQUEST_BYTES) throw apiError(413, "BODY_TOO_LARGE");
  }
  const bytes = await readBoundedRequestBody(request, MAX_REQUEST_BYTES, CONTROL_BODY_READ_POLICY);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return JSON.parse(raw) as unknown;
  } catch {
    throw apiError(400, "BODY_INVALID");
  }
}

function callbackPage(message: string, completed = false): Response {
  const title = completed ? "You're signed in" : "Sign-in was not completed";
  const detail = completed
    ? "TiboTattle is opening now. You can close this browser tab."
    : "No data was uploaded. TiboTattle is reopening so you can try again.";
  const refresh = `<meta http-equiv="refresh" content="${completed ? "0" : "2"}; url=${CALLBACK_APP_URL}">`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}<title>TiboTattle sign-in</title><style>
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; } body { align-items: center; background: #f5f3ec; color: #16211d; display: flex; justify-content: center; margin: 0; min-height: 100vh; padding: 28px; }
main { background: #fffefa; border: 1px solid #d7d5cc; border-radius: 20px; box-shadow: 0 18px 54px rgba(24, 39, 32, .14); max-width: 34rem; padding: 38px; width: 100%; }
.brand { color: #176052; font-size: .78rem; font-weight: 750; letter-spacing: .12em; margin: 0 0 18px; text-transform: uppercase; } h1 { font-family: ui-serif, Georgia, serif; font-size: clamp(2rem, 7vw, 3.1rem); letter-spacing: -.035em; line-height: 1.04; margin: 0 0 16px; }
p { color: #52625b; font-size: 1rem; line-height: 1.55; margin: 0; } .action { background: #155f51; border-radius: 11px; color: #fff; display: inline-block; font-weight: 700; margin-top: 28px; padding: 13px 18px; text-decoration: none; } .hint { color: #718078; font-size: .9rem; margin-top: 16px; }
@media (prefers-color-scheme: dark) { body { background: #16201d; color: #f5f4ed; } main { background: #202b27; border-color: #425048; box-shadow: none; } p { color: #c1cbc4; } .hint { color: #9dab9f; } }
</style></head><body><main><p class="brand">TiboTattle</p><h1>${title}</h1><p>${message}</p><p class="hint">${detail}</p><a class="action" href="${CALLBACK_APP_URL}">Open TiboTattle</a></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

async function assertPostgresCollectionControl(
  pool: PostgresPool,
  schema: string,
  name: "enrollment",
): Promise<void> {
  const primary = quotePostgresIdentifier(schema);
  let row: {
    readonly control_state: unknown;
    readonly enrollment_enabled: unknown;
    readonly upload_registration_enabled: unknown;
    readonly processing_enabled: unknown;
    readonly publication_enabled: unknown;
    readonly revision: unknown;
  } | undefined;
  try {
    row = await withPostgresRead(pool, async (client) => {
      const result = await client.query<{
        readonly control_state: unknown;
        readonly enrollment_enabled: unknown;
        readonly upload_registration_enabled: unknown;
        readonly processing_enabled: unknown;
        readonly publication_enabled: unknown;
        readonly revision: unknown;
      }>(
        `SELECT control_state, enrollment_enabled, upload_registration_enabled,
                processing_enabled, publication_enabled, revision::text AS revision
           FROM ${primary}."collection_controls" WHERE singleton = 1`,
      );
      return result.rows[0];
    }, { operation: "google_handoff.collection_control", statementTimeoutMilliseconds: 5_000 });
  } catch {
    throw apiError(503, "COLLECTION_CONTROL_UNAVAILABLE");
  }
  const revision = Number(row?.revision);
  const flags = [row?.enrollment_enabled, row?.upload_registration_enabled,
    row?.processing_enabled, row?.publication_enabled];
  if (row === undefined || !["operational", "degraded", "contained"].includes(String(row.control_state))
      || flags.some((flag) => typeof flag !== "boolean")
      || !Number.isSafeInteger(revision) || revision < 0) {
    throw apiError(503, "COLLECTION_CONTROL_UNAVAILABLE");
  }
  const enabledCount = flags.filter(Boolean).length;
  if ((row.control_state === "operational" && enabledCount !== 4)
      || (row.control_state === "contained" && enabledCount !== 0)
      || (row.control_state === "degraded" && (enabledCount === 0 || enabledCount === 4))) {
    throw apiError(503, "COLLECTION_CONTROL_UNAVAILABLE");
  }
  if (name === "enrollment" && row.enrollment_enabled !== true) {
    throw apiError(503, "COLLECTION_ENROLLMENT_DISABLED");
  }
}

async function pinnedSecretFingerprint(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const fingerprint = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(IDENTITY_SECRET_FINGERPRINT_DOMAIN),
  );
  return [...new Uint8Array(fingerprint)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function assertPinnedPostgresIdentitySecret(
  pool: PostgresPool,
  schema: string,
  env: PostgresGoogleHandoffEnvironment,
  now: number,
): Promise<void> {
  const secret = Reflect.get(env, "IDENTITY_LINK_SECRET");
  const version = Reflect.get(env, "IDENTITY_LINK_SECRET_VERSION");
  if (typeof secret !== "string" || secret.length < 32
      || typeof version !== "string" || !IDENTITY_SECRET_VERSION_PATTERN.test(version)) {
    throw apiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  const primary = quotePostgresIdentifier(schema);
  const fingerprint = await pinnedSecretFingerprint(secret);
  try {
    await mutate(pool, "google_handoff.identity_secret_pin", async (client) => {
      await client.query(
        `INSERT INTO ${primary}."identity_link_secret_configuration" (
           singleton, key_version, secret_fingerprint, recorded_at
         ) VALUES (1, $1, $2, $3::timestamptz)
         ON CONFLICT (singleton) DO NOTHING`,
        [version, fingerprint, new Date(now).toISOString()],
      );
      const result = await client.query(
        `SELECT key_version, secret_fingerprint
           FROM ${primary}."identity_link_secret_configuration"
          WHERE singleton = 1`,
      );
      const row = result.rows[0];
      if (row?.key_version !== version || row.secret_fingerprint !== fingerprint) {
        throw apiError(503, "IDENTITY_CONFIGURATION_INVALID");
      }
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw apiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

async function assertSignInStartAdmission(
  pool: PostgresPool,
  schema: string,
  rawLimit: unknown,
  nowEpoch: number,
): Promise<void> {
  if (typeof rawLimit !== "string" || !/^\d+$/u.test(rawLimit)) {
    throw apiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SIGN_IN_ADMISSION_LIMIT) {
    throw apiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
  const startedAtEpoch = Math.floor(nowEpoch / SIGN_IN_ADMISSION_WINDOW_MS)
    * SIGN_IN_ADMISSION_WINDOW_MS;
  const startedAt = new Date(startedAtEpoch).toISOString();
  const now = new Date(nowEpoch).toISOString();
  const primary = quotePostgresIdentifier(schema);
  let acceptedCount: number | null = null;
  try {
    acceptedCount = await mutate(pool, "google_handoff.start_admission", async (client) => {
      const result = await client.query<{ readonly accepted_count: number }>(
        `INSERT INTO ${primary}."sign_in_start_admission_windows" AS admission (
           window_started_at, accepted_count, last_accepted_at
         ) VALUES ($1::timestamptz, 1, $2::timestamptz)
         ON CONFLICT (window_started_at) DO UPDATE SET
           accepted_count = admission.accepted_count + 1,
           last_accepted_at = EXCLUDED.last_accepted_at
         WHERE admission.accepted_count < $3
         RETURNING accepted_count`,
        [startedAt, now, limit],
      );
      return result.rows[0]?.accepted_count ?? null;
    });
  } catch {
    throw apiError(503, "ADMISSION_RATE_LIMIT_UNAVAILABLE");
  }
  if (!Number.isSafeInteger(acceptedCount) || acceptedCount === null
      || acceptedCount < 1 || acceptedCount > limit) {
    throw new ApiError(429, "SIGN_IN_START_LIMIT_REACHED", {
      responseHeaders: {
        "retry-after": String(Math.max(1, Math.ceil(
          (startedAtEpoch + SIGN_IN_ADMISSION_WINDOW_MS - nowEpoch) / 1_000,
        ))),
      },
    });
  }
}

async function purgeExpiredHandoffs(
  pool: PostgresPool,
  table: string,
  nowIso: string,
): Promise<void> {
  await mutate(pool, "google_handoff.purge_expired", async (client) => {
    await client.query(
      `WITH expired AS (
         SELECT state FROM ${table}
          WHERE expires_at <= $1::timestamptz
          ORDER BY expires_at, state
          LIMIT $2
       )
       DELETE FROM ${table} AS handoff USING expired
        WHERE handoff.state = expired.state`,
      [nowIso, MAX_EXPIRED_ROWS_PER_REQUEST],
    );
  });
}

async function discardPendingHandoff(
  pool: PostgresPool,
  table: string,
  state: string,
  nowIso: string,
): Promise<void> {
  await mutate(pool, "google_handoff.discard_pending", async (client) => {
    await client.query(
      `DELETE FROM ${table}
        WHERE state = $1 AND claim_id IS NULL
          AND identity_link_key IS NULL AND proof IS NULL AND delivered_at IS NULL
          AND expires_at > $2::timestamptz`,
      [state, nowIso],
    );
  });
}

async function discardClaimedHandoff(
  pool: PostgresPool,
  table: string,
  state: string,
  claimId: string,
  nowIso: string,
): Promise<void> {
  await mutate(pool, "google_handoff.discard_claimed", async (client) => {
    await client.query(
      `DELETE FROM ${table}
        WHERE state = $1 AND claim_id = $2
          AND identity_link_key IS NULL AND proof IS NULL AND delivered_at IS NULL
          AND expires_at > $3::timestamptz`,
      [state, claimId, nowIso],
    );
  });
}

async function claimHandoff(
  pool: PostgresPool,
  table: string,
  state: string,
  claimId: string,
  nowIso: string,
  staleBeforeIso: string,
): Promise<string | null> {
  return mutate(pool, "google_handoff.claim", async (client) => {
    const result = await client.query<{ readonly code_verifier: string }>(
      `UPDATE ${table}
          SET claim_id = $1, claimed_at = $2::timestamptz
        WHERE state = $3
          AND identity_link_key IS NULL
          AND proof IS NULL
          AND delivered_at IS NULL
          AND expires_at > $2::timestamptz
          AND (claim_id IS NULL OR claimed_at <= $4::timestamptz)
        RETURNING code_verifier`,
      [claimId, nowIso, state, staleBeforeIso],
    );
    return result.rows[0]?.code_verifier ?? null;
  });
}

async function fillHandoff(
  pool: PostgresPool,
  table: string,
  state: string,
  claimId: string,
  linkKeyHex: string,
  proof: string,
  nowIso: string,
  expiresAt: string,
): Promise<boolean> {
  return mutate(pool, "google_handoff.fill", async (client) => {
    const result = await client.query(
      `UPDATE ${table}
          SET code_verifier = NULL, identity_link_key = $1, proof = $2,
              expires_at = $3::timestamptz
        WHERE state = $4
          AND claim_id = $5
          AND identity_link_key IS NULL
          AND proof IS NULL
          AND delivered_at IS NULL
          AND expires_at > $6::timestamptz`,
      [linkKeyHex, proof, expiresAt, state, claimId, nowIso],
    );
    return result.rowCount === 1;
  });
}

async function deliverHandoff(
  pool: PostgresPool,
  schema: string,
  state: string,
  bindingHash: string,
  nowIso: string,
): Promise<GoogleHandoffRow | null> {
  const primary = quotePostgresIdentifier(schema);
  return mutate(pool, "google_handoff.deliver", async (client) => {
    const result = await client.query<GoogleHandoffRow>(
      `UPDATE ${primary}."google_signin_handoffs"
          SET delivered_at = COALESCE(delivered_at, $1::timestamptz)
        WHERE state = $2
          AND binding_hash = $3
          AND identity_link_key IS NOT NULL
          AND proof IS NOT NULL
          AND expires_at > $1::timestamptz
        RETURNING proof`,
      [nowIso, state, bindingHash],
    );
    return result.rows[0] ?? null;
  });
}

async function isPendingHandoff(
  pool: PostgresPool,
  schema: string,
  state: string,
  bindingHash: string,
  nowIso: string,
): Promise<boolean> {
  const primary = quotePostgresIdentifier(schema);
  return withPostgresRead(pool, async (client) => {
    const result = await client.query(
      `SELECT state FROM ${primary}."google_signin_handoffs"
        WHERE state = $1 AND binding_hash = $2
          AND identity_link_key IS NULL AND proof IS NULL AND delivered_at IS NULL
          AND expires_at > $3::timestamptz`,
      [state, bindingHash, nowIso],
    );
    return result.rows.length > 0;
  }, { operation: "google_handoff.pending_read", statementTimeoutMilliseconds: 5_000 });
}

function validatedStateAndBinding(value: unknown): { state: string; binding: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw apiError(400, "BODY_INVALID");
  }
  const state = Reflect.get(value, "state");
  const verifier = Reflect.get(value, "verifier");
  if (Object.keys(value).length !== 2
      || typeof state !== "string" || !GOOGLE_SIGNIN_STATE_PATTERN.test(state)
      || typeof verifier !== "string" || !HANDOFF_VERIFIER_PATTERN.test(verifier)) {
    throw apiError(400, "BODY_INVALID");
  }
  return { state, binding: verifier };
}

function methodNotAllowed(allowed: string[]): ApiError {
  const error = apiError(405, "METHOD_NOT_ALLOWED");
  Object.defineProperty(error, "allowed", { value: Object.freeze(allowed) });
  return error;
}

function responseForError(error: unknown, requestId: string): Response {
  const safe = error instanceof ApiError
    ? error
    : apiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  const response = errorResponse(safe, requestId);
  const allowed = Reflect.get(safe, "allowed");
  if (Array.isArray(allowed) && allowed.every((value) => typeof value === "string")) {
    response.headers.set("allow", allowed.join(", "));
  }
  return response;
}

/**
 * Build the Google authorization handoff for a PostgreSQL-backed host.
 * It returns only the same opaque proof as the Worker; participant/session
 * creation remains the separate enrollment authority sink.
 */
export function createPostgresGoogleHandoffDispatch(
  options: PostgresGoogleHandoffDispatchOptions,
): (request: Request) => Promise<Response> {
  const {
    primaryPool,
    privateOrigin,
    env,
    assertAdmissionBindings,
    assertAttemptAllowed,
    healthDispatch,
  } = options;
  if (primaryPool === null || typeof primaryPool !== "object"
      || typeof primaryPool.connect !== "function"
      || !requestOriginAllowed(privateOrigin)
      || env === null || typeof env !== "object"
      || typeof assertAdmissionBindings !== "function"
      || typeof assertAttemptAllowed !== "function"
      || typeof healthDispatch !== "function") {
    throw new TypeError("POSTGRES_GOOGLE_HANDOFF_CONFIGURATION_INVALID");
  }
  const schema = createPostgresSchemaConfig(options.schemaOptions).primarySchema;
  const handoffTable = tableName(schema);
  const now = options.now ?? Date.now;
  const exchangeCode = options.exchangeCode ?? exchangeGoogleAuthorizationCode;
  const verifyIdentity = options.verifyIdentity ?? (async (runtimeEnv, idToken) => {
    if (identityRequired(runtimeEnv as Env)) {
      return verifyHostedIdentity(runtimeEnv as Env, { provider: "google", idToken });
    }
    return {
      provider: "google" as const,
      linkKeyHex: await sha256Hex(`app-usagemonitor/development-handoff/v1\0google\0${idToken}`),
    };
  });

  return async function dispatchPostgresGoogleHandoff(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url);
    } catch {
      return responseForError(apiError(400, "BODY_INVALID"), requestId);
    }
    const route = requestUrl.pathname;
    const isStart = route === "/api/v1/identity/google/start";
    const isCallback = route === "/api/v1/identity/google/callback";
    const isResult = route === "/api/v1/identity/google/result";
    if (requestUrl.origin !== privateOrigin || (!isStart && !isCallback && !isResult)) {
      return jsonResponse({ status: "not_ready", error: "POSTGRES_WORKER_REQUEST_PATH_UNSUPPORTED" }, 503);
    }
    const requiredMethod = isCallback ? "GET" : "POST";
    if (request.method !== requiredMethod) {
      return responseForError(methodNotAllowed([requiredMethod]), requestId);
    }

    try {
      const health = await healthDispatch(new Request(`${privateOrigin}/api/health`));
      if (health.status !== 200) throw apiError(503, "BACKEND_STORAGE_UNAVAILABLE");

      if (isStart) {
        assertSameOrigin(request);
        configuredEnrollmentMode(env);
        await assertPostgresCollectionControl(primaryPool, schema, "enrollment");
        if (identityRequired(env)) {
          await assertPinnedPostgresIdentitySecret(primaryPool, schema, env, now());
        }
        assertAdmissionBindings(env);
        await assertAttemptAllowed(
          Reflect.get(env, "ENROLLMENT_RATE_LIMIT"),
          Reflect.get(env, "CLIENT_ATTEMPT_RATE_LIMIT"),
          request,
          env,
          "sign_in_start",
        );
        const configuration = googleSignInConfiguration(env);
        const redirectUri = callbackUrl(request, env);
        const body = await readBoundedJson(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)
            || Object.keys(body).length !== 1
            || typeof Reflect.get(body, "binding") !== "string"
            || !HANDOFF_BINDING_PATTERN.test(Reflect.get(body, "binding") as string)) {
          throw apiError(400, "BODY_INVALID");
        }
        const binding = Reflect.get(body, "binding") as string;
        const nowMs = now();
        const nowIso = new Date(nowMs).toISOString();
        await assertSignInStartAdmission(
          primaryPool,
          schema,
          Reflect.get(env, "SIGN_IN_START_MAX_PER_MINUTE"),
          nowMs,
        );
        await purgeExpiredHandoffs(primaryPool, handoffTable, nowIso);
        const state = randomSecret(48);
        const codeVerifier = randomSecret(48);
        await mutate(primaryPool, "google_handoff.start", async (client) => {
          await client.query(
            `INSERT INTO ${handoffTable} (
               state, code_verifier, binding_hash, identity_link_key, proof,
               created_at, expires_at, delivered_at
             ) VALUES ($1, $2, $3, NULL, NULL, $4::timestamptz, $5::timestamptz, NULL)`,
            [state, codeVerifier, binding, nowIso, new Date(nowMs + AUTHORIZATION_TTL_MS).toISOString()],
          );
        });
        return jsonResponse({
          schemaVersion: "identity-google-start-v0.1",
          state,
          authorizeUrl: googleAuthorizeUrl(
            configuration,
            redirectUri,
            state,
            await googleCodeChallenge(codeVerifier),
          ),
        });
      }

      if (isCallback) {
        const redirectUri = callbackUrl(request, env);
        const failure = callbackPage(NOT_COMPLETED_MESSAGE);
        if (request.url.length > MAX_CALLBACK_URL_LENGTH) return failure;
        const parameters = requestUrl.searchParams;
        const state = parameters.get("state");
        const code = parameters.get("code");
        if (typeof state !== "string" || !GOOGLE_SIGNIN_STATE_PATTERN.test(state)) return failure;
        const nowMs = now();
        const nowIso = new Date(nowMs).toISOString();
        if (parameters.get("error") !== null) {
          await discardPendingHandoff(primaryPool, handoffTable, state, nowIso);
          return failure;
        }
        if (typeof code !== "string" || code.length === 0) return failure;
        const claimId = randomSecret(48);
        const verifier = await claimHandoff(
          primaryPool,
          handoffTable,
          state,
          claimId,
          nowIso,
          new Date(nowMs - CLAIM_LEASE_MS).toISOString(),
        );
        if (verifier === null) return failure;
        let linkKeyHex: string;
        try {
          if (identityRequired(env)) {
            await assertPinnedPostgresIdentitySecret(primaryPool, schema, env, now());
          }
          const idToken = await exchangeCode(env, code, verifier, redirectUri);
          const verified = await verifyIdentity(env, idToken);
          if (verified.provider !== "google" || !GOOGLE_LINK_KEY_PATTERN.test(verified.linkKeyHex)) {
            throw apiError(401, "IDENTITY_TOKEN_INVALID");
          }
          linkKeyHex = verified.linkKeyHex;
        } catch {
          await discardClaimedHandoff(
            primaryPool,
            handoffTable,
            state,
            claimId,
            new Date(now()).toISOString(),
          );
          return failure;
        }
        const filledAt = now();
        const stored = await fillHandoff(
          primaryPool,
          handoffTable,
          state,
          claimId,
          linkKeyHex,
          randomSecret(48),
          new Date(filledAt).toISOString(),
          new Date(filledAt + DELIVERY_TTL_MS).toISOString(),
        );
        return stored ? callbackPage(COMPLETED_MESSAGE, true) : failure;
      }

      assertSameOrigin(request);
      const body = await readBoundedJson(request);
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw apiError(400, "BODY_INVALID");
      }
      const { state, binding: verifier } = validatedStateAndBinding(body);
      const bindingHash = await sha256Hex(verifier);
      const nowIso = new Date(now()).toISOString();
      await purgeExpiredHandoffs(primaryPool, handoffTable, nowIso);
      const delivered = await deliverHandoff(primaryPool, schema, state, bindingHash, nowIso);
      if (delivered) {
        if (typeof delivered.proof !== "string" || !HANDOFF_PROOF_PATTERN.test(delivered.proof)) {
          throw apiError(503, "BACKEND_STORAGE_UNAVAILABLE");
        }
        return jsonResponse({ schemaVersion: "identity-google-result-v0.1", proof: delivered.proof });
      }
      if (await isPendingHandoff(primaryPool, schema, state, bindingHash, nowIso)) {
        throw apiError(404, "IDENTITY_RESULT_PENDING");
      }
      throw apiError(401, "IDENTITY_TOKEN_INVALID");
    } catch (error) {
      return responseForError(error, requestId);
    }
  };
}
