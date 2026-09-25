import { ApiError, errorResponse, jsonResponse } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import {
  configuredEnrollmentMode,
  hashInviteGrantSecret,
  parseInviteGrant,
} from "./admission";
import { assertAccountScopedLocalPreview } from "./account-scoped-ingest";
import {
  DEFAULT_DEVICE_LIFECYCLE_POLICY,
  createDevicePairingMaterial,
  type DevicePairingMaterial,
} from "./device-auth";
import {
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  MAX_REQUEST_BYTES,
  ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  ONGOING_TELEMETRY_CONSENT_VERSION,
  TELEMETRY_CONSENT_VERSION,
} from "./constants";
import { readBoundedRequestBody } from "./bounded-body";
import {
  hashCapability,
  randomSecret,
  sha256Hex,
  timingSafeEqual,
} from "./crypto";
import { identityRequired } from "./identity-oidc";
import { identityReenrollmentCooldownDigest } from "./retention";
import {
  createSessionMaterial,
  sessionCookie,
  assertSameOrigin,
  type SessionMaterial,
} from "./session";

const HANDOFF_PROOF_PATTERN = /^[A-Za-z0-9_-]{64}$/u;
const HANDOFF_VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const IDENTITY_LINK_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const IDENTITY_SECRET_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const IDENTITY_SECRET_FINGERPRINT_DOMAIN =
  "app-usagemonitor/identity-link-secret-fingerprint/v1\0";
const CONTROL_BODY_READ_POLICY = Object.freeze({
  maximumTotalMilliseconds: 15_000,
  maximumIdleMilliseconds: 5_000,
});
const GOOGLE_PROOF_CONSUME_TTL_SQL = "expires_at > $3::timestamptz";

export interface PostgresGoogleEnrollmentEnvironment extends Env {}

export interface PostgresGoogleEnrollmentDispatchOptions {
  readonly primaryPool: PostgresPool;
  readonly ledgerPool: PostgresPool;
  readonly schemaOptions?: PostgresSchemaOptions;
  readonly privateOrigin: string;
  readonly env: PostgresGoogleEnrollmentEnvironment;
  readonly assertAdmissionBindings: (env: PostgresGoogleEnrollmentEnvironment) => void;
  readonly assertAttemptAllowed: (
    coarseLimiter: unknown,
    clientLimiter: unknown,
    request: Request,
    env: PostgresGoogleEnrollmentEnvironment,
    purpose: "enrollment",
  ) => Promise<void>;
  readonly healthDispatch: (request: Request) => Promise<Response>;
  readonly now?: () => number;
};

interface GoogleIdentityProof {
  readonly provider: "google";
  readonly proof: string;
  readonly verifier: string;
}

interface EnrollmentMaterial {
  readonly participantId: string;
  readonly recoveryCode: string;
  readonly csrfToken: string;
  readonly session: SessionMaterial;
  readonly pairing: DevicePairingMaterial | null;
  readonly invitation: {
    readonly state: "not_required" | "redeemed";
    readonly redeemedAt: string | null;
    readonly expiresAt: string | null;
  };
}

interface ParticipantIdentityRow {
  readonly id: string;
  readonly state: string;
  readonly consent_version: string | null;
}

interface InviteGrantRow {
  readonly id: string;
  readonly secret_hash: Uint8Array;
  readonly state: string;
  readonly expires_at: Date | string;
}

function apiError(status: number, code: ConstructorParameters<typeof ApiError>[1]): ApiError {
  return new ApiError(status, code);
}

function qtable(schema: string, table: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table)}`;
}

function preservedError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function mutate<T>(
  pool: PostgresPool,
  operation: string,
  callback: Parameters<typeof withPostgresMutation<T>>[1],
): Promise<T> {
  return withPostgresMutation(pool, callback, {
    operation,
    statementTimeoutMilliseconds: 5_000,
    lockTimeoutMilliseconds: 2_000,
    preserveSafeError: preservedError,
  });
}

function methodNotAllowed(): ApiError {
  const error = apiError(405, "METHOD_NOT_ALLOWED");
  Object.defineProperty(error, "allowed", { value: Object.freeze(["POST"]) });
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

function unsupported(): Response {
  return jsonResponse({
    status: "not_ready",
    error: "POSTGRES_WORKER_REQUEST_PATH_UNSUPPORTED",
  }, 503);
}

function validOrigin(privateOrigin: string): boolean {
  try {
    const parsed = new URL(privateOrigin);
    return parsed.protocol === "https:" && parsed.origin === privateOrigin;
  } catch {
    return false;
  }
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
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch {
    throw apiError(400, "BODY_INVALID");
  }
}

function normalizedInstant(value: Date | string): string | null {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

async function assertPostgresCollectionControl(
  pool: PostgresPool,
  schema: string,
  name: "enrollment" | "uploadRegistration",
): Promise<void> {
  const controls = qtable(schema, "collection_controls");
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
           FROM ${controls} WHERE singleton = 1`,
      );
      return result.rows[0];
    }, { operation: "google_enrollment.collection_control", statementTimeoutMilliseconds: 5_000 });
  } catch {
    throw apiError(503, "COLLECTION_CONTROL_UNAVAILABLE");
  }
  const flags = [row?.enrollment_enabled, row?.upload_registration_enabled,
    row?.processing_enabled, row?.publication_enabled];
  const revision = Number(row?.revision);
  if (row === undefined
      || !["operational", "degraded", "contained"].includes(String(row.control_state))
      || flags.some((flag) => typeof flag !== "boolean")
      || !Number.isSafeInteger(revision) || revision < 1) {
    throw apiError(503, "COLLECTION_CONTROL_UNAVAILABLE");
  }
  const enabledCount = flags.filter(Boolean).length;
  if ((row.control_state === "operational" && enabledCount !== 4)
      || (row.control_state === "contained" && enabledCount !== 0)
      || (row.control_state === "degraded" && (enabledCount === 0 || enabledCount === 4))) {
    throw apiError(503, "COLLECTION_CONTROL_UNAVAILABLE");
  }
  const enabled = name === "enrollment"
    ? row.enrollment_enabled === true
    : row.upload_registration_enabled === true;
  if (!enabled) {
    throw apiError(503, name === "enrollment"
      ? "COLLECTION_ENROLLMENT_DISABLED"
      : "UPLOAD_REGISTRATION_DISABLED");
  }
}

async function pinnedIdentitySecretFingerprint(secret: string): Promise<string> {
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
  return [...new Uint8Array(fingerprint)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function assertPinnedIdentitySecret(
  pool: PostgresPool,
  schema: string,
  env: PostgresGoogleEnrollmentEnvironment,
  nowEpoch: number,
): Promise<void> {
  const secret = Reflect.get(env, "IDENTITY_LINK_SECRET");
  const version = Reflect.get(env, "IDENTITY_LINK_SECRET_VERSION");
  if (typeof secret !== "string" || secret.length < 32
      || typeof version !== "string" || !IDENTITY_SECRET_VERSION_PATTERN.test(version)) {
    throw apiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  const table = qtable(schema, "identity_link_secret_configuration");
  const fingerprint = await pinnedIdentitySecretFingerprint(secret);
  try {
    await mutate(pool, "google_enrollment.identity_secret_pin", async (client) => {
      await client.query(
        `INSERT INTO ${table} (singleton, key_version, secret_fingerprint, recorded_at)
         VALUES (1, $1, $2, $3::timestamptz)
         ON CONFLICT (singleton) DO NOTHING`,
        [version, fingerprint, new Date(nowEpoch).toISOString()],
      );
      const result = await client.query(
        `SELECT key_version, secret_fingerprint FROM ${table} WHERE singleton = 1`,
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

function parseGoogleProof(value: unknown): GoogleIdentityProof {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw apiError(401, "IDENTITY_TOKEN_INVALID");
  }
  const provider = Reflect.get(value, "provider");
  const proof = Reflect.get(value, "proof");
  const verifier = Reflect.get(value, "verifier");
  if (Object.keys(value).sort().join("\0") !== ["proof", "provider", "verifier"].join("\0")
      || provider !== "google"
      || typeof proof !== "string" || !HANDOFF_PROOF_PATTERN.test(proof)
      || typeof verifier !== "string" || !HANDOFF_VERIFIER_PATTERN.test(verifier)) {
    throw apiError(401, "IDENTITY_TOKEN_INVALID");
  }
  return { provider, proof, verifier };
}

async function consumeGoogleProof(
  pool: PostgresPool,
  schema: string,
  identity: unknown,
  nowEpoch: number,
): Promise<string> {
  const { proof, verifier } = parseGoogleProof(identity);
  const bindingHash = await sha256Hex(verifier);
  const table = qtable(schema, "google_signin_handoffs");
  let linkKey: string | null;
  try {
    linkKey = await mutate(pool, "google_enrollment.consume_handoff", async (client) => {
      const result = await client.query<{ readonly identity_link_key: string | null }>(
        `DELETE FROM ${table}
          WHERE proof = $1
            AND binding_hash = $2
            AND identity_link_key IS NOT NULL
            AND delivered_at IS NOT NULL
            AND ${GOOGLE_PROOF_CONSUME_TTL_SQL}
          RETURNING identity_link_key`,
        [proof, bindingHash, new Date(nowEpoch).toISOString()],
      );
      return result.rows[0]?.identity_link_key ?? null;
    });
  } catch {
    throw apiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  if (linkKey === null || !IDENTITY_LINK_KEY_PATTERN.test(linkKey)) {
    throw apiError(401, "IDENTITY_TOKEN_INVALID");
  }
  return linkKey;
}

async function readIdentityCooldown(
  ledgerPool: PostgresPool,
  ledgerSchema: string,
  digest: string,
  nowIso: string,
): Promise<boolean> {
  const table = qtable(ledgerSchema, "identity_reenrollment_cooldowns");
  try {
    return await withPostgresRead(ledgerPool, async (client) => {
      const result = await client.query(
        `SELECT 1 FROM ${table}
          WHERE identity_cooldown_digest = $1 AND retain_until > $2::timestamptz
          LIMIT 1`,
        [digest, nowIso],
      );
      return result.rows.length > 0;
    }, { operation: "google_enrollment.ledger_cooldown", statementTimeoutMilliseconds: 5_000 });
  } catch {
    throw apiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

async function cooldownDigestForIdentity(
  env: PostgresGoogleEnrollmentEnvironment,
  linkKey: string,
): Promise<string | null> {
  const secret = Reflect.get(env, "IDENTITY_LINK_SECRET");
  if (typeof secret !== "string" || secret.length < 32) {
    if (identityRequired(env)) throw apiError(503, "IDENTITY_CONFIGURATION_INVALID");
    return null;
  }
  return identityReenrollmentCooldownDigest(secret, linkKey);
}

async function sessionAndRecovery(
  participantId: string,
  nowEpoch: number,
): Promise<{
  readonly accessTokenId: string;
  readonly accessTokenHash: Uint8Array;
  readonly recoveryTokenId: string;
  readonly recoveryTokenHash: Uint8Array;
  readonly recoveryCode: string;
  readonly session: SessionMaterial;
}> {
  const accessTokenId = crypto.randomUUID();
  const accessSecret = randomSecret(32);
  const recoveryTokenId = crypto.randomUUID();
  const recoverySecret = randomSecret(32);
  const recoveryCode = `um_recovery_${recoveryTokenId}.${recoverySecret}`;
  const session = await createSessionMaterial(participantId, nowEpoch);
  const [accessTokenHash, recoveryTokenHash] = await Promise.all([
    hashCapability("access", accessTokenId, accessSecret),
    hashCapability("recovery", recoveryTokenId, recoverySecret),
  ]);
  return {
    accessTokenId,
    accessTokenHash,
    recoveryTokenId,
    recoveryTokenHash,
    recoveryCode,
    session,
  };
}

async function optionalPairing(
  participantId: string,
  session: SessionMaterial,
  consentVersion: string,
  requested: boolean,
  nowEpoch: number,
): Promise<DevicePairingMaterial | null> {
  return requested
    ? createDevicePairingMaterial(participantId, session.id, consentVersion, nowEpoch)
    : null;
}

async function insertPairing(
  client: Parameters<typeof withPostgresMutation>[1] extends (client: infer C) => unknown
    ? C : never,
  schema: string,
  participantId: string,
  consentVersion: string,
  session: SessionMaterial,
  pairing: DevicePairingMaterial,
): Promise<boolean> {
  const participants = qtable(schema, "participants");
  const sessions = qtable(schema, "web_sessions");
  const pairings = qtable(schema, "device_pairings");
  const policy = DEFAULT_DEVICE_LIFECYCLE_POLICY;
  const now = pairing.issuedAt;
  const result = await client.query(
    `INSERT INTO ${pairings} (
       id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at
     )
     SELECT $1, participant.id, session.id, $2, $3, $4, 'unused', $5::timestamptz, $6::timestamptz
       FROM ${participants} participant
       JOIN ${sessions} session ON session.participant_id = participant.id
      WHERE participant.id = $7
        AND participant.state = 'active'
        AND participant.consent_version = $8
        AND session.id = $9
        AND session.state = 'active'
        AND session.scope = 'personal'
        AND session.expires_at > $5::timestamptz
        AND (SELECT count(*) FROM ${qtable(schema, "device_credentials")} device
              WHERE device.participant_id = participant.id
                AND device.state = 'active'
                AND device.expires_at > $5::timestamptz
                AND device.last_used_at > $10::timestamptz) < $11
        AND (SELECT count(*) FROM ${pairings} recent
              WHERE recent.participant_id = participant.id
                AND recent.issued_at > $12::timestamptz) < $13`,
    [
      pairing.id,
      pairing.secretHash,
      pairing.transportConsentVersion === ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION
        ? ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION
        : ONGOING_TELEMETRY_CONSENT_VERSION,
      pairing.transportConsentVersion,
      now,
      pairing.expiresAt,
      participantId,
      consentVersion,
      session.id,
      new Date(Date.parse(now) - policy.idleMilliseconds).toISOString(),
      policy.activeDeviceLimit,
      new Date(Date.parse(now) - policy.pairingIssueWindowMilliseconds).toISOString(),
      policy.pairingIssueLimit,
    ],
  );
  return result.rowCount === 1;
}

function enrollmentPayload(
  enrollment: EnrollmentMaterial,
  consentVersion: string,
): Record<string, unknown> {
  return {
    schemaVersion: "participant-bootstrap-v0.1",
    state: enrollment.pairing ? "pairing_ready" : "enrolled",
    participantId: enrollment.participantId,
    csrfToken: enrollment.csrfToken,
    recoveryCode: enrollment.recoveryCode,
    consentVersion,
    invitation: enrollment.invitation,
    session: {
      state: "active",
      issuedAt: enrollment.session.issuedAt,
      expiresAt: enrollment.session.expiresAt,
    },
    recovery: {
      state: "issued",
      issuedAt: enrollment.session.issuedAt,
      expiresAt: null,
      requiresAcknowledgement: true,
    },
    pairing: enrollment.pairing ? {
      state: "claimable",
      scope: "upload_registration",
      oneUse: true,
      pairingCode: enrollment.pairing.pairingCode,
      issuedAt: enrollment.pairing.issuedAt,
      expiresAt: enrollment.pairing.expiresAt,
    } : null,
  };
}

/**
 * PostgreSQL implementation of the existing Google proof enrollment sink.
 * The Google proof is deleted in its own committed transaction before account
 * continuity, cooldown, or participant writes, matching the Worker's one-use
 * semantics. Only this private Cloud Run test composition registers the route.
 */
export function createPostgresGoogleEnrollmentDispatch(
  options: PostgresGoogleEnrollmentDispatchOptions,
): (request: Request) => Promise<Response> {
  const {
    primaryPool,
    ledgerPool,
    privateOrigin,
    env,
    assertAdmissionBindings,
    assertAttemptAllowed,
    healthDispatch,
  } = options;
  if (primaryPool === null || typeof primaryPool !== "object"
      || typeof primaryPool.connect !== "function"
      || ledgerPool === null || typeof ledgerPool !== "object"
      || typeof ledgerPool.connect !== "function"
      || !validOrigin(privateOrigin)
      || env === null || typeof env !== "object"
      || typeof assertAdmissionBindings !== "function"
      || typeof assertAttemptAllowed !== "function"
      || typeof healthDispatch !== "function") {
    throw new TypeError("POSTGRES_GOOGLE_ENROLLMENT_CONFIGURATION_INVALID");
  }
  const schemas = createPostgresSchemaConfig(options.schemaOptions);
  const primarySchema = schemas.primarySchema;
  const ledgerSchema = schemas.ledgerSchema;
  const now = options.now ?? Date.now;

  return async function dispatchPostgresGoogleEnrollment(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url);
    } catch {
      return responseForError(apiError(400, "BODY_INVALID"), requestId);
    }
    if (requestUrl.pathname !== "/api/v1/enroll" || requestUrl.origin !== privateOrigin) {
      return unsupported();
    }
    if (request.method !== "POST") return responseForError(methodNotAllowed(), requestId);

    try {
      assertSameOrigin(request);
      const health = await healthDispatch(new Request(`${privateOrigin}/api/health`));
      if (health.status !== 200) throw apiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      const mode = configuredEnrollmentMode(env);
      assertAdmissionBindings(env);
      await assertPostgresCollectionControl(primaryPool, primarySchema, "enrollment");
      await assertAttemptAllowed(
        Reflect.get(env, "ENROLLMENT_RATE_LIMIT"),
        Reflect.get(env, "CLIENT_ATTEMPT_RATE_LIMIT"),
        request,
        env,
        "enrollment",
      );

      const body = await readBoundedJson(request);
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw apiError(400, "BODY_INVALID");
      }
      const accountScopedEnrollment = Reflect.get(body, "consentVersion")
          === ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION
        && Reflect.get(body, "syntheticOnly") === false;
      const consentVersionValue = Reflect.get(body, "consentVersion");
      const syntheticOnly = Reflect.get(body, "syntheticOnly");
      if (!Object.hasOwn(body, "consentVersion") || !Object.hasOwn(body, "syntheticOnly")
          || !((consentVersionValue === "synthetic-preview-v0.1" && syntheticOnly === true)
            || (consentVersionValue === TELEMETRY_CONSENT_VERSION && syntheticOnly === false)
            || accountScopedEnrollment)) {
        throw apiError(400, "BODY_INVALID");
      }
      if (accountScopedEnrollment) assertAccountScopedLocalPreview(request, env);

      const consentVersion = consentVersionValue as string;
      const deviceBootstrap = Reflect.get(body, "deviceBootstrap");
      const deviceBootstrapRequested = deviceBootstrap !== undefined;
      const ongoingConsentVersion = accountScopedEnrollment
        ? ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION
        : ONGOING_TELEMETRY_CONSENT_VERSION;
      if (deviceBootstrapRequested
          && (syntheticOnly !== false
            || typeof deviceBootstrap !== "object" || deviceBootstrap === null
            || Array.isArray(deviceBootstrap)
            || Object.keys(deviceBootstrap).length !== 2
            || Reflect.get(deviceBootstrap, "ongoingUpload") !== true
            || Reflect.get(deviceBootstrap, "consentVersion") !== ongoingConsentVersion)) {
        throw apiError(400, "BODY_INVALID");
      }
      const identityValue = Reflect.get(body, "identity");
      const identityProvided = identityValue !== undefined;
      const allowedKeys = mode === "invite_only"
        ? ["consentVersion", "syntheticOnly", "inviteCode", "deviceBootstrap", "identity"]
        : ["consentVersion", "syntheticOnly", "deviceBootstrap", "identity"];
      const keys = Object.keys(body);
      if (keys.some((key) => !allowedKeys.includes(key))
          || ((mode === "local_open" || mode === "open")
            && keys.length !== 2 + (deviceBootstrapRequested ? 1 : 0) + (identityProvided ? 1 : 0))) {
        throw apiError(400, "BODY_INVALID");
      }
      if (identityRequired(env) && !identityProvided) throw apiError(401, "IDENTITY_REQUIRED");
      if (identityRequired(env)) {
        await assertPinnedIdentitySecret(primaryPool, primarySchema, env, now());
      }
      const identityLinkKey = identityProvided
        ? await consumeGoogleProof(primaryPool, primarySchema, identityValue, now())
        : null;
      const identityCooldownDigest = identityLinkKey === null
        ? null
        : await cooldownDigestForIdentity(env, identityLinkKey);

      if (deviceBootstrapRequested) {
        await assertPostgresCollectionControl(primaryPool, primarySchema, "uploadRegistration");
      }

      const nowEpoch = now();
      const nowIso = new Date(nowEpoch).toISOString();
      const participants = qtable(primarySchema, "participants");
      const sessions = qtable(primarySchema, "web_sessions");
      const cooldowns = qtable(primarySchema, "identity_reenrollment_cooldowns");
      const grants = qtable(primarySchema, "enrollment_grants");
      const eligibility = qtable(primarySchema, "participant_community_eligibility");

      const enrollment = await mutate(primaryPool, "google_enrollment.issue_authority", async (client) => {
        let existing: ParticipantIdentityRow | null = null;
        if (identityLinkKey !== null) {
          // The advisory lock serializes the only PostgreSQL route that can
          // create a social identity link. The row lock also fences reattach
          // against any participant lifecycle transition already using it.
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [identityLinkKey],
          );
          const found = await client.query<ParticipantIdentityRow>(
            `SELECT id, state, consent_version FROM ${participants}
              WHERE identity_link_key = $1 ORDER BY id LIMIT 2 FOR UPDATE`,
            [identityLinkKey],
          );
          if (found.rows.length > 1) throw apiError(503, "BACKEND_STORAGE_UNAVAILABLE");
          existing = found.rows[0] ?? null;
          if (existing && existing.state !== "active") {
            if (existing.state === "deleting") throw apiError(409, "PARTICIPANT_DELETING");
            throw apiError(503, "BACKEND_STORAGE_UNAVAILABLE");
          }
          if (existing === null && identityCooldownDigest !== null) {
            const primaryCooling = await client.query(
              `SELECT 1 FROM ${cooldowns}
                WHERE identity_cooldown_digest = $1 AND expires_at > $2::timestamptz
                LIMIT 1`,
              [identityCooldownDigest, nowIso],
            );
            const ledgerCooling = await readIdentityCooldown(
              ledgerPool,
              ledgerSchema,
              identityCooldownDigest,
              nowIso,
            );
            if (primaryCooling.rows.length > 0 || ledgerCooling) {
              throw apiError(409, "IDENTITY_REENROLLMENT_COOLDOWN");
            }
          }
        }
        if (existing === null && mode === "disabled") throw apiError(503, "ENROLLMENT_DISABLED");

        const inviteGrant = existing === null && mode === "invite_only"
          ? await parseInviteGrant(Reflect.get(body, "inviteCode"))
          : null;
        let invitationExpiresAt: string | null = null;
        let grantId: string | null = null;
        if (inviteGrant !== null) {
          const grantResult = await client.query<InviteGrantRow>(
            `SELECT id, secret_hash, state, expires_at FROM ${grants}
              WHERE id = $1 FOR UPDATE`,
            [inviteGrant.id],
          );
          const grant = grantResult.rows[0];
          const presentedHash = inviteGrant.secretHash;
          const storedHash = grant?.secret_hash instanceof Uint8Array
            ? Uint8Array.from(grant.secret_hash)
            : new Uint8Array(32);
          const expiresAt = grant ? normalizedInstant(grant.expires_at) : null;
          if (!grant || grant.id !== inviteGrant.id
              || !timingSafeEqual(presentedHash, storedHash)
              || grant.state !== "issued"
              || expiresAt === null || Date.parse(expiresAt) <= nowEpoch) {
            throw apiError(400, "INVITE_GRANT_INVALID");
          }
          invitationExpiresAt = expiresAt;
          grantId = grant.id;
        }

        const participantId = existing?.id ?? `participant:${crypto.randomUUID()}`;
        const credentials = await sessionAndRecovery(participantId, nowEpoch);
        const pairing = await optionalPairing(
          participantId,
          credentials.session,
          consentVersion,
          deviceBootstrapRequested,
          nowEpoch,
        );

        if (existing !== null) {
          const rotated = await client.query(
            `UPDATE ${participants}
                SET recovery_token_id = $1, recovery_token_hash = $2
              WHERE id = $3 AND state = 'active' RETURNING id`,
            [credentials.recoveryTokenId, credentials.recoveryTokenHash, participantId],
          );
          if (rotated.rowCount !== 1 || rotated.rows[0]?.id !== participantId) {
            throw apiError(500, "INTERNAL_ERROR");
          }
        } else {
          const accessHash = credentials.accessTokenHash;
          const accessId = credentials.accessTokenId;
          const inserted = await client.query(
            `INSERT INTO ${participants} (
               id, access_token_id, access_token_hash, recovery_token_id,
               recovery_token_hash, owner_kind, state, consent_version, consented_at,
               created_at, identity_link_key, identity_cooldown_digest
             ) VALUES ($1, $2, $3, $4, $5, 'social', 'active', $6,
                       $7::timestamptz, $7::timestamptz, $8, $9)
             RETURNING id`,
            [participantId, accessId, accessHash, credentials.recoveryTokenId,
              credentials.recoveryTokenHash, consentVersion, nowIso, identityLinkKey,
              identityCooldownDigest],
          );
          if (inserted.rowCount !== 1 || inserted.rows[0]?.id !== participantId) {
            throw apiError(500, "INTERNAL_ERROR");
          }
          if (identityCooldownDigest !== null) {
            const cleared = await client.query(
              `UPDATE ${participants} SET identity_cooldown_digest = NULL
                WHERE id = $1 AND identity_cooldown_digest IS NOT NULL`,
              [participantId],
            );
            if (cleared.rowCount !== 1) throw apiError(500, "INTERNAL_ERROR");
          }
          if (grantId === null && mode === "open" && syntheticOnly === false) {
            const openGrantId = `open:${crypto.randomUUID()}`;
            const openGrantSecretHash = await hashInviteGrantSecret(openGrantId, randomSecret(32));
            const openGrantExpiresAt = new Date(nowEpoch + 5 * 60_000).toISOString();
            const eligibilityId = `eligibility:${crypto.randomUUID()}`;
            await client.query(
              `INSERT INTO ${grants} (id, secret_hash, state, issued_at, expires_at)
               VALUES ($1, $2, 'issued', $3::timestamptz, $4::timestamptz)`,
              [openGrantId, openGrantSecretHash, nowIso, openGrantExpiresAt],
            );
            const redeemed = await client.query(
              `UPDATE ${grants}
                  SET state = 'redeemed', redeemed_at = $1::timestamptz,
                      redeemed_participant_id = $2
                WHERE id = $3 AND state = 'issued' RETURNING id`,
              [nowIso, participantId, openGrantId],
            );
            if (redeemed.rowCount !== 1) throw apiError(500, "INTERNAL_ERROR");
            await client.query(
              `INSERT INTO ${eligibility} (id, participant_id, grant_id, created_at)
               VALUES ($1, $2, $3, $4::timestamptz)`,
              [eligibilityId, participantId, openGrantId, nowIso],
            );
          } else if (grantId !== null) {
            const eligibilityId = `eligibility:${crypto.randomUUID()}`;
            const redeemed = await client.query(
              `UPDATE ${grants}
                  SET state = 'redeemed', redeemed_at = $1::timestamptz,
                      redeemed_participant_id = $2
                WHERE id = $3 AND state = 'issued' AND expires_at > $1::timestamptz
                RETURNING id`,
              [nowIso, participantId, grantId],
            );
            if (redeemed.rowCount !== 1) throw apiError(400, "INVITE_GRANT_INVALID");
            await client.query(
              `INSERT INTO ${eligibility} (id, participant_id, grant_id, created_at)
               VALUES ($1, $2, $3, $4::timestamptz)`,
              [eligibilityId, participantId, grantId, nowIso],
            );
          }
        }

        const sessionInsert = await client.query(
          `INSERT INTO ${sessions} (
             id, participant_id, secret_hash, csrf_hash, scope, state,
             issued_at, expires_at, last_used_at
           ) VALUES ($1, $2, $3, $4, $5, 'active', $6::timestamptz,
                    $7::timestamptz, $6::timestamptz) RETURNING id`,
          [credentials.session.id, participantId, credentials.session.secretHash,
            credentials.session.csrfHash, credentials.session.scope,
            credentials.session.issuedAt, credentials.session.expiresAt],
        );
        if (sessionInsert.rowCount !== 1) throw apiError(500, "INTERNAL_ERROR");
        if (pairing !== null && !await insertPairing(
          client, primarySchema, participantId, consentVersion, credentials.session, pairing,
        )) {
          throw apiError(500, "INTERNAL_ERROR");
        }

        return {
          participantId,
          recoveryCode: credentials.recoveryCode,
          csrfToken: credentials.session.csrfToken,
          session: credentials.session,
          pairing,
          invitation: {
            state: grantId !== null ? "redeemed" : "not_required",
            redeemedAt: grantId !== null ? nowIso : null,
            expiresAt: grantId !== null ? invitationExpiresAt : null,
          },
        } satisfies EnrollmentMaterial;
      });
      return jsonResponse(
        enrollmentPayload(enrollment, consentVersion),
        201,
        { "set-cookie": sessionCookie(enrollment.session) },
      );
    } catch (error) {
      return responseForError(error, requestId);
    }
  };
}
