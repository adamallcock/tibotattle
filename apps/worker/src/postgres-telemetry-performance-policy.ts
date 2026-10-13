/**
 * PostgreSQL accountless performance policy: the grant (v1 and v2 bodies),
 * per-device field-dictionary resolution, and the capability read.
 *
 * Port of the Worker's telemetry-performance-policy.ts accountless grant and
 * capability paths onto primary 0079_performance_telemetry.sql, widened from
 * the Worker's single pinned dictionary to every accepted dictionary
 * (owner decisions 2026-10-10, docs/decisions/2026-10-10-community-model-speed.md;
 * orchestrator gate answers 2026-10-11). The signed-in consent route stays
 * retired, so there is no social grant here.
 *
 * DICTIONARY. Each grant stores the dictionary its device emits, and the
 * capability echoes it in requiredConsent.fieldDictionaryVersion:
 *   - a v2 body (accountless-performance-owner-v2) declares it; the server
 *     accepts any dictionary the contract registry marks accepted (basis
 *     client_declared). Declared beats inferred.
 *   - a v1 body names none. A client that sends v1 predates the declaring
 *     grant (SPD-C2b) and, since the two ship together, the v2 bucket switch
 *     (SPD-C2a), so it emits at most 2026-09-29.1. Its dictionary is inferred
 *     from the parser of its newest v1.2 day manifest
 *     (resolvePostgresTelemetryPerformanceParserDictionary; basis
 *     v12_parser_inference). Release tags confirm the mapping: v0.1.24 to
 *     v0.1.26 write unified-rollout-typed-v18 and emit 2026-09-21.1; v0.1.27
 *     writes v19 and v0.1.28 writes v20, and both emit 2026-09-29.1.
 *   - gate answer 1 (OVERRIDE of the plan's refusal): a v1 grant whose device
 *     has no v1.2 manifest, or whose newest manifest names an unmapped parser,
 *     is not refused. It is granted 2026-09-29.1 with the closed basis
 *     default_no_manifest. 0.1.27 and 0.1.28 devices then work, and a
 *     0.1.24-0.1.26 device ends where a refusal would leave it (its own
 *     capability check pauses until restart); a later manifest corrects the
 *     choice on the next grant.
 * The latest grant wins: a changed dictionary, basis or expiry appends a
 * revision; a revoked tuple is never reactivated.
 *
 * INFERENCE LAG. Right after an upgrade the newest manifest can still name the
 * old parser; that client pauses until a restart re-grants. Clients that
 * declare their dictionary (v2) avoid it.
 *
 * PRIVACY. No participant, device or enrollment identifier, body, bearer, SQL
 * text or driver message is logged or copied into an answer. Every failure is
 * a closed ApiError: 400 BODY_INVALID, 403 TELEMETRY_CONSENT_INVALID,
 * 403 TELEMETRY_TRANSPORT_BLOCKED or 503 BACKEND_STORAGE_UNAVAILABLE.
 *
 * INSTANTS. Every instant this module writes or answers is an ISO string at
 * millisecond precision (24 characters). The 0079 triggers join grant,
 * capability and owner expiries by equality, so the grant copies the owner's
 * expiry inside SQL rather than round-tripping it through JavaScript, and the
 * capability read refuses a stored instant with sub-millisecond digits.
 *
 * This module is not imported by any analytics-kernel closure root.
 */

import {
  PERFORMANCE_FIELD_DICTIONARIES,
  PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21,
  PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_29,
  PERFORMANCE_PRIVACY_CONTRACT_VERSION,
  PERFORMANCE_RECORD_SCHEMA_VERSION,
  type PerformanceFieldDictionary,
  type PerformanceFieldDictionaryVersion,
} from "@app-usagemonitor/telemetry-contract";
import { ApiError } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import {
  ACCOUNTLESS_TELEMETRY_PERFORMANCE_AUTHORIZATION_BASIS,
  ACCOUNTLESS_TELEMETRY_PERFORMANCE_POLICY_VERSION,
  ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION,
  TELEMETRY_PERFORMANCE_AUTHORIZATION_VERSION,
  TELEMETRY_PERFORMANCE_CAPABILITIES_VERSION,
  TELEMETRY_PERFORMANCE_SCOPE,
  TELEMETRY_PERFORMANCE_SUPPORTED_SPEED_METHODS,
} from "./telemetry-performance-policy";

export const ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION_V1 =
  ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION;
export const ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION_V2 =
  "accountless-performance-owner-v2" as const;

/** The dictionary a v1 grant receives without a mapped manifest (gate answer 1). */
export const POSTGRES_TELEMETRY_PERFORMANCE_DEFAULT_DICTIONARY =
  PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_29;

/** The closed, content-free reasons a grant's dictionary was chosen (0079 CHECK). */
export const POSTGRES_TELEMETRY_PERFORMANCE_DICTIONARY_BASES = Object.freeze([
  "v12_parser_inference", "default_no_manifest", "client_declared",
] as const);
export type PostgresTelemetryPerformanceDictionaryBasis =
  typeof POSTGRES_TELEMETRY_PERFORMANCE_DICTIONARY_BASES[number];

export type PostgresTelemetryPerformanceGrantSchemaVersion =
  | typeof ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION_V1
  | typeof ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION_V2;

export interface PostgresTelemetryPerformancePrincipal {
  readonly participantId: string;
  readonly deviceId: string;
}

export interface PostgresTelemetryPerformanceGrantRequest {
  /** The exact accepted body, echoed by the route on success. */
  readonly echo: Readonly<Record<string, string>>;
  readonly schemaVersion: PostgresTelemetryPerformanceGrantSchemaVersion;
  readonly declaredFieldDictionaryVersion: PerformanceFieldDictionaryVersion | null;
}

export interface PostgresTelemetryPerformanceGrantResult {
  readonly echo: Readonly<Record<string, string>>;
  readonly outcome: "granted" | "idempotent";
  readonly fieldDictionaryVersion: PerformanceFieldDictionaryVersion;
  readonly dictionaryBasis: PostgresTelemetryPerformanceDictionaryBasis;
  readonly capabilityRevision: number;
  readonly authorityEpoch: number;
}

export interface PostgresTelemetryPerformanceAuthorization {
  readonly schemaVersion: typeof TELEMETRY_PERFORMANCE_AUTHORIZATION_VERSION;
  readonly capabilityRevision: number;
  readonly authorityEpoch: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly scope: typeof TELEMETRY_PERFORMANCE_SCOPE;
}

export interface PostgresTelemetryPerformanceRequiredConsent {
  readonly schemaVersion: typeof PERFORMANCE_RECORD_SCHEMA_VERSION;
  readonly fieldDictionaryVersion: PerformanceFieldDictionaryVersion;
  readonly privacyContractVersion: typeof PERFORMANCE_PRIVACY_CONTRACT_VERSION;
  readonly scope: typeof TELEMETRY_PERFORMANCE_SCOPE;
}

/** The Worker's capability response shape, key for key and in the same order. */
export interface PostgresTelemetryPerformanceCapability {
  readonly schemaVersion: typeof TELEMETRY_PERFORMANCE_CAPABILITIES_VERSION;
  readonly lifecycle: "accepted";
  readonly consentCurrent: true;
  readonly authorizationCurrent: true;
  readonly supportedSpeedMethods: typeof TELEMETRY_PERFORMANCE_SUPPORTED_SPEED_METHODS;
  readonly requiredConsent: PostgresTelemetryPerformanceRequiredConsent;
  readonly authorization: PostgresTelemetryPerformanceAuthorization;
}

export interface PostgresTelemetryPerformanceParseOptions {
  /** Test seam only: a synthetic registry (for a draft entry). Defaults to the contract's. */
  readonly dictionaries?: Readonly<Record<string, PerformanceFieldDictionary>>;
}

const V1_KEYS = Object.freeze(["authorizationBasis", "policyVersion", "schemaVersion"]);
const V2_KEYS = Object.freeze(["authorizationBasis", "fieldDictionaryVersion", "policyVersion", "schemaVersion"]);
const PARSER_VERSION = /^unified-rollout-typed-v([1-9][0-9]*)$/u;
const MAX_REVISION = 2_147_483_647;
const ISO_MILLISECONDS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const ISO_MICROSECONDS = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const TRIGGER_SQLSTATE = "P1005";
const UNIQUE_SQLSTATE = "23505";
const STATEMENT_TIMEOUT_MILLISECONDS = 5_000;
const LOCK_TIMEOUT_MILLISECONDS = 2_000;

function blocked(): ApiError {
  return new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
}

function consentInvalid(): ApiError {
  return new ApiError(403, "TELEMETRY_CONSENT_INVALID");
}

function unavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === keys.join("\0");
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function instant(value: unknown): value is string {
  return typeof value === "string" && value.length === 24
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function knownDictionary(value: unknown): value is PerformanceFieldDictionaryVersion {
  return typeof value === "string" && Object.hasOwn(PERFORMANCE_FIELD_DICTIONARIES, value);
}

function knownBasis(value: unknown): value is PostgresTelemetryPerformanceDictionaryBasis {
  return typeof value === "string"
    && (POSTGRES_TELEMETRY_PERFORMANCE_DICTIONARY_BASES as readonly string[]).includes(value);
}

function sqlState(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  try {
    const code: unknown = Reflect.get(error, "code");
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

function validPrincipal(value: unknown): value is PostgresTelemetryPerformancePrincipal {
  return plainObject(value)
    && typeof value.participantId === "string" && value.participantId.length > 0
    && value.participantId.length <= 200
    && typeof value.deviceId === "string" && value.deviceId.length > 0 && value.deviceId.length <= 200;
}

function requestEpoch(nowEpoch: unknown): number {
  const epoch = nowEpoch === undefined ? Date.now() : nowEpoch;
  if (!integer(epoch, 0, 8_640_000_000_000_000)) throw unavailable();
  return epoch;
}

function schemaName(schema: PostgresSchemaOptions | undefined): string {
  try {
    return quotePostgresIdentifier(createPostgresSchemaConfig(schema ?? {}).primarySchema);
  } catch {
    throw unavailable();
  }
}

/**
 * Parse an accountless performance grant body. Exactly the three v1 keys or
 * the four v2 keys are accepted; any other key set is 400 BODY_INVALID. A
 * wrong value, or a v2 dictionary the registry does not hold in state
 * accepted, is 403 TELEMETRY_CONSENT_INVALID.
 */
export function parsePostgresTelemetryPerformanceGrantRequest(
  value: unknown,
  { dictionaries = PERFORMANCE_FIELD_DICTIONARIES }: PostgresTelemetryPerformanceParseOptions = {},
): PostgresTelemetryPerformanceGrantRequest {
  if (!plainObject(value)) throw new ApiError(400, "BODY_INVALID");
  const v1 = sameKeys(value, V1_KEYS);
  const v2 = !v1 && sameKeys(value, V2_KEYS);
  if (!v1 && !v2) throw new ApiError(400, "BODY_INVALID");
  if (value.policyVersion !== ACCOUNTLESS_TELEMETRY_PERFORMANCE_POLICY_VERSION
      || value.authorizationBasis !== ACCOUNTLESS_TELEMETRY_PERFORMANCE_AUTHORIZATION_BASIS
      || value.schemaVersion !== (v1
        ? ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION_V1
        : ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION_V2)) {
    throw consentInvalid();
  }
  let declaredFieldDictionaryVersion: PerformanceFieldDictionaryVersion | null = null;
  if (v2) {
    const declared = value.fieldDictionaryVersion;
    const entry = typeof declared === "string" && plainObject(dictionaries)
      && Object.hasOwn(dictionaries, declared) ? dictionaries[declared] : undefined;
    if (typeof declared !== "string" || !knownDictionary(declared)
        || entry === undefined || entry.fieldDictionaryVersion !== declared || entry.state !== "accepted") {
      throw consentInvalid();
    }
    declaredFieldDictionaryVersion = declared;
  }
  const echo = Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, field as string]),
  ));
  return Object.freeze({
    echo,
    schemaVersion: value.schemaVersion as PostgresTelemetryPerformanceGrantSchemaVersion,
    declaredFieldDictionaryVersion,
  });
}

/**
 * The dictionary a v1.2 manifest parser version implies (gate answer 2):
 * unified-rollout-typed-v18 is 2026-09-21.1, v19 and above (open range) are
 * 2026-09-29.1, and every other value (v1-v17, another family, a malformed
 * string) is null. There is no prefix matching.
 */
export function resolvePostgresTelemetryPerformanceParserDictionary(
  parserVersion: unknown,
): PerformanceFieldDictionaryVersion | null {
  if (typeof parserVersion !== "string") return null;
  const match = PARSER_VERSION.exec(parserVersion);
  if (match === null) return null;
  const generation = BigInt(match[1]!);
  if (generation === 18n) return PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_21;
  if (generation >= 19n) return PERFORMANCE_FIELD_DICTIONARY_VERSION_2026_09_29;
  return null;
}

/**
 * Infer a device's dictionary from its newest v1.2 day manifest (gate answer
 * 3: the newest evidence day's latest manifest). The order matches the
 * telemetry_v12_manifests_device_day index, so the read is one backward index
 * probe. An absent manifest or an unmapped parser is null. Runs on the
 * caller's client (inside the grant transaction).
 */
export async function inferPostgresTelemetryPerformanceDictionary(
  client: PostgresClient,
  { schema, principal }: {
    readonly schema?: PostgresSchemaOptions;
    readonly principal: PostgresTelemetryPerformancePrincipal;
  },
): Promise<PerformanceFieldDictionaryVersion | null> {
  if (!validPrincipal(principal)) throw blocked();
  const s = schemaName(schema);
  const newest = await client.query<{ readonly parser_version: unknown }>(
    `SELECT manifest.parser_version
       FROM ${s}."telemetry_v12_day_manifests" manifest
      WHERE manifest.participant_id = $1 AND manifest.device_id = $2
      ORDER BY manifest.chunk_day DESC, manifest.created_at DESC, manifest.id DESC
      LIMIT 1`,
    [principal.participantId, principal.deviceId],
  );
  return resolvePostgresTelemetryPerformanceParserDictionary(newest.rows[0]?.parser_version);
}

/**
 * The PostgreSQL counterpart of the Worker's
 * requireTelemetryPerformanceStorageMode: the deployment must select typed
 * storage (`mode` is parseTelemetryStorageMode's result) and the performance
 * runtime row must exist. Any miss, and any driver error, is
 * 503 BACKEND_STORAGE_UNAVAILABLE. Like the Worker gate it does not require
 * the runtime to be active; the grant and capability fences do.
 */
export async function assertPostgresTelemetryPerformanceStorage(
  pool: PostgresPool,
  { schema, mode }: { readonly schema?: PostgresSchemaOptions; readonly mode: unknown },
): Promise<void> {
  if (!plainObject(mode) || mode.kind !== "typed"
      || typeof mode.sourceNamespace !== "string" || mode.sourceNamespace.length === 0) {
    throw unavailable();
  }
  const s = schemaName(schema);
  let ready = false;
  try {
    ready = await withPostgresRead(pool, async (client) => {
      const row = await client.query<{ readonly ready: unknown }>(
        `SELECT 1 AS ready FROM ${s}."telemetry_performance_runtime" WHERE id = 1`,
      );
      return row.rowCount === 1 && row.rows[0]?.ready === 1;
    }, {
      operation: "telemetry_performance.storage",
      statementTimeoutMilliseconds: STATEMENT_TIMEOUT_MILLISECONDS,
      lockTimeoutMilliseconds: LOCK_TIMEOUT_MILLISECONDS,
    });
  } catch {
    throw unavailable();
  }
  if (!ready) throw unavailable();
}

interface GrantHeadRow {
  readonly participant_id: string;
  readonly device_id: string;
  readonly capability_revision: number;
  readonly authority_epoch: number;
  readonly field_dictionary_version: string;
  readonly dictionary_basis: string;
  readonly state: string;
  readonly expires_at_us: string;
}

interface GrantHeads {
  readonly authorization: GrantHeadRow | null;
  readonly capability: GrantHeadRow | null;
}

interface ResolvedDictionary {
  readonly fieldDictionaryVersion: PerformanceFieldDictionaryVersion;
  readonly dictionaryBasis: PostgresTelemetryPerformanceDictionaryBasis;
}

interface OwnerRow {
  readonly enrollment_device_id: string;
  readonly expires_at_us: string;
}

/** Both heads are current, equal, unexpired at the owner's expiry, and carry this dictionary and basis. */
function currentGrant(
  heads: GrantHeads,
  principal: PostgresTelemetryPerformancePrincipal,
  ownerExpiresAtUs: string,
  resolved: ResolvedDictionary,
): boolean {
  const { authorization, capability } = heads;
  return authorization !== null && capability !== null
    && authorization.state === "active" && capability.state === "accepted"
    && authorization.participant_id === principal.participantId
    && authorization.device_id === principal.deviceId
    && authorization.capability_revision === capability.capability_revision
    && authorization.authority_epoch === capability.authority_epoch
    && authorization.expires_at_us === ownerExpiresAtUs
    && capability.expires_at_us === ownerExpiresAtUs
    && authorization.field_dictionary_version === resolved.fieldDictionaryVersion
    && capability.field_dictionary_version === resolved.fieldDictionaryVersion
    && authorization.dictionary_basis === resolved.dictionaryBasis
    && capability.dictionary_basis === resolved.dictionaryBasis;
}

/**
 * The next tuple after the heads (the Worker's nextGrantTuple and the 0079
 * triggers): revision + 1, and epoch + 1 only on the first grant or after a
 * revoked head. Heads that disagree are 403 TELEMETRY_CONSENT_INVALID.
 */
function nextGrantTuple(heads: GrantHeads): { capabilityRevision: number; authorityEpoch: number } {
  const { authorization, capability } = heads;
  if ((authorization === null) !== (capability === null)) throw consentInvalid();
  if (authorization !== null && capability !== null
      && (authorization.capability_revision !== capability.capability_revision
        || authorization.authority_epoch !== capability.authority_epoch
        || (authorization.state === "revoked") !== (capability.state === "revoked"))) {
    throw consentInvalid();
  }
  const capabilityRevision = (authorization?.capability_revision ?? 0) + 1;
  const authorityEpoch = (authorization?.authority_epoch ?? 0)
    + (authorization === null || authorization.state === "revoked" ? 1 : 0);
  if (!integer(capabilityRevision, 1, MAX_REVISION) || !integer(authorityEpoch, 1, MAX_REVISION)) {
    throw consentInvalid();
  }
  return { capabilityRevision, authorityEpoch };
}

async function readGrantHeads(
  client: PostgresClient,
  s: string,
  principal: PostgresTelemetryPerformancePrincipal,
  enrollmentDeviceId: string,
  lock: boolean,
): Promise<GrantHeads> {
  const suffix = lock ? " FOR UPDATE" : "";
  const authorization = await client.query<GrantHeadRow>(
    `SELECT head.participant_id, head.device_credential_id AS device_id,
            head.capability_revision, head.authority_epoch, head.field_dictionary_version,
            head.dictionary_basis, head.state,
            to_char(head.expires_at AT TIME ZONE 'UTC', ${ISO_MICROSECONDS}) AS expires_at_us
       FROM ${s}."accountless_telemetry_performance_authorizations" head
      WHERE head.enrollment_device_id = $1
      ORDER BY head.capability_revision DESC, head.authority_epoch DESC
      LIMIT 1${suffix}`,
    [enrollmentDeviceId],
  );
  const capability = await client.query<GrantHeadRow>(
    `SELECT head.participant_id, head.device_id,
            head.capability_revision, head.authority_epoch, head.field_dictionary_version,
            head.dictionary_basis, head.state,
            to_char(head.expires_at AT TIME ZONE 'UTC', ${ISO_MICROSECONDS}) AS expires_at_us
       FROM ${s}."telemetry_performance_device_capabilities" head
      WHERE head.participant_id = $1 AND head.device_id = $2
      ORDER BY head.capability_revision DESC, head.authority_epoch DESC
      LIMIT 1${suffix}`,
    [principal.participantId, principal.deviceId],
  );
  return { authorization: authorization.rows[0] ?? null, capability: capability.rows[0] ?? null };
}

/**
 * Re-prove the active accountless owner graph (owner, ledger, participant,
 * device, equal expiries) and an active runtime, holding them FOR SHARE for
 * the transaction. Null when any part is missing, inactive or expired.
 */
async function readActiveOwner(
  client: PostgresClient,
  s: string,
  principal: PostgresTelemetryPerformancePrincipal,
  nowIso: string,
  lock: boolean,
): Promise<OwnerRow | null> {
  const owner = await client.query<OwnerRow>(
    `SELECT owner.enrollment_device_id,
            to_char(owner.expires_at AT TIME ZONE 'UTC', ${ISO_MICROSECONDS}) AS expires_at_us
       FROM ${s}."accountless_upload_owners" owner
       JOIN ${s}."accountless_enrollment_ledger" ledger ON ledger.device_id = owner.enrollment_device_id
       JOIN ${s}."participants" p ON p.id = owner.participant_id
       JOIN ${s}."device_credentials" d ON d.id = owner.device_credential_id
       JOIN ${s}."telemetry_performance_runtime" r ON r.id = 1
      WHERE owner.participant_id = $1 AND owner.device_credential_id = $2
        AND owner.state = 'active' AND owner.expires_at > $3::timestamptz
        AND ledger.state = 'active' AND ledger.expires_at = owner.expires_at
        AND p.state = 'active' AND p.owner_kind = 'accountless'
        AND d.state = 'active' AND d.authority_kind = 'accountless'
        AND d.participant_id = p.id
        AND d.accountless_enrollment_device_id = owner.enrollment_device_id
        AND d.expires_at = owner.expires_at
        AND r.state = 'active'
        AND r.schema_version = $4 AND r.privacy_contract_version = $5${lock ? `
      FOR SHARE OF owner, ledger, p, d, r` : ""}`,
    [principal.participantId, principal.deviceId, nowIso,
      PERFORMANCE_RECORD_SCHEMA_VERSION, PERFORMANCE_PRIVACY_CONTRACT_VERSION],
  );
  return owner.rowCount === 1 ? owner.rows[0] ?? null : null;
}

/** A refusal raised by a 0079 trigger or a unique key inside the grant: re-read before answering. */
class GrantRaceRefusal extends Error {
  constructor() {
    super("telemetry_performance_grant_race");
    this.name = "GrantRaceRefusal";
  }
}

function preserveGrantError(error: unknown): Error | null {
  if (error instanceof ApiError) return error;
  const state = sqlState(error);
  if (state === TRIGGER_SQLSTATE || state === UNIQUE_SQLSTATE) return new GrantRaceRefusal();
  return null;
}

/**
 * Establish the accountless performance grant (the owner flow's performance
 * step), in one transaction:
 *   1. take the enrollment's grant advisory lock through 0079's own key
 *      function (the authorization trigger takes the same lock);
 *   2. re-prove the active owner graph and an active runtime FOR SHARE, else
 *      403 TELEMETRY_TRANSPORT_BLOCKED (the staged answer) with no write;
 *   3. resolve the dictionary: declared (v2), inferred, or the gate-answer-1
 *      default (v1);
 *   4. read both heads FOR UPDATE; a current, equal tuple at the owner's
 *      expiry with the same dictionary and basis is idempotent;
 *   5. otherwise append the next authorization and capability tuple.
 * A trigger refusal is re-read in a fresh transaction: a now-current grant is
 * idempotent, anything else 403 TELEMETRY_CONSENT_INVALID. A driver failure is
 * 503 BACKEND_STORAGE_UNAVAILABLE.
 */
export async function grantPostgresTelemetryPerformanceAccountlessAuthorization(
  pool: PostgresPool,
  { schema, principal, request, nowEpoch }: {
    readonly schema?: PostgresSchemaOptions;
    readonly principal: PostgresTelemetryPerformancePrincipal;
    readonly request: PostgresTelemetryPerformanceGrantRequest;
    readonly nowEpoch?: number;
  },
): Promise<PostgresTelemetryPerformanceGrantResult> {
  if (!plainObject(request) || !plainObject(request.echo)) throw consentInvalid();
  // Re-validate against the real registry: a parse result is the only accepted request.
  const parsed = parsePostgresTelemetryPerformanceGrantRequest(request.echo);
  if (parsed.schemaVersion !== request.schemaVersion
      || parsed.declaredFieldDictionaryVersion !== request.declaredFieldDictionaryVersion) {
    throw consentInvalid();
  }
  if (!validPrincipal(principal)) throw blocked();
  const epoch = requestEpoch(nowEpoch);
  const nowIso = new Date(epoch).toISOString();
  const s = schemaName(schema);
  let attempted: { readonly resolved: ResolvedDictionary; readonly ownerExpiresAtUs: string } | null = null;

  try {
    return await withPostgresMutation(pool, async (client) => {
      const locked = await client.query(
        `SELECT pg_advisory_xact_lock(${s}.telemetry_performance_grant_lock_key(d.accountless_enrollment_device_id))
           FROM ${s}."device_credentials" d
          WHERE d.id = $2 AND d.participant_id = $1
            AND d.accountless_enrollment_device_id IS NOT NULL`,
        [principal.participantId, principal.deviceId],
      );
      if (locked.rowCount !== 1) throw blocked();
      const owner = await readActiveOwner(client, s, principal, nowIso, true);
      if (owner === null) throw blocked();

      let resolved: ResolvedDictionary;
      if (parsed.declaredFieldDictionaryVersion !== null) {
        resolved = { fieldDictionaryVersion: parsed.declaredFieldDictionaryVersion, dictionaryBasis: "client_declared" };
      } else {
        const inferred = await inferPostgresTelemetryPerformanceDictionary(client, { schema, principal });
        resolved = inferred === null
          ? { fieldDictionaryVersion: POSTGRES_TELEMETRY_PERFORMANCE_DEFAULT_DICTIONARY, dictionaryBasis: "default_no_manifest" }
          : { fieldDictionaryVersion: inferred, dictionaryBasis: "v12_parser_inference" };
      }
      attempted = { resolved, ownerExpiresAtUs: owner.expires_at_us };

      const heads = await readGrantHeads(client, s, principal, owner.enrollment_device_id, true);
      if (currentGrant(heads, principal, owner.expires_at_us, resolved)) {
        return grantResult(parsed, "idempotent", resolved, heads.authorization!);
      }
      const next = nextGrantTuple(heads);
      const authorization = await client.query(
        `INSERT INTO ${s}."accountless_telemetry_performance_authorizations" (
           enrollment_device_id, participant_id, device_credential_id, schema_version, policy_version,
           authorization_basis, performance_schema_version, field_dictionary_version, dictionary_basis,
           privacy_contract_version, scope, capability_revision, authority_epoch, authorized_at,
           expires_at, state
         )
         SELECT owner.enrollment_device_id, owner.participant_id, owner.device_credential_id, $3, $4,
                $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, owner.expires_at, 'active'
           FROM ${s}."accountless_upload_owners" owner
          WHERE owner.enrollment_device_id = $1 AND owner.device_credential_id = $2`,
        [owner.enrollment_device_id, principal.deviceId, parsed.schemaVersion,
          ACCOUNTLESS_TELEMETRY_PERFORMANCE_POLICY_VERSION, ACCOUNTLESS_TELEMETRY_PERFORMANCE_AUTHORIZATION_BASIS,
          PERFORMANCE_RECORD_SCHEMA_VERSION, resolved.fieldDictionaryVersion, resolved.dictionaryBasis,
          PERFORMANCE_PRIVACY_CONTRACT_VERSION, TELEMETRY_PERFORMANCE_SCOPE,
          next.capabilityRevision, next.authorityEpoch, nowIso],
      );
      const capability = await client.query(
        `INSERT INTO ${s}."telemetry_performance_device_capabilities" (
           participant_id, device_id, schema_version, field_dictionary_version, dictionary_basis,
           privacy_contract_version, scope, capability_revision, authority_epoch, issued_at,
           expires_at, state, consented_at
         )
         SELECT owner.participant_id, owner.device_credential_id, $3, $4, $5, $6, $7, $8, $9,
                $10::timestamptz, owner.expires_at, 'accepted', $10::timestamptz
           FROM ${s}."accountless_upload_owners" owner
          WHERE owner.enrollment_device_id = $1 AND owner.device_credential_id = $2`,
        [owner.enrollment_device_id, principal.deviceId, PERFORMANCE_RECORD_SCHEMA_VERSION,
          resolved.fieldDictionaryVersion, resolved.dictionaryBasis, PERFORMANCE_PRIVACY_CONTRACT_VERSION,
          TELEMETRY_PERFORMANCE_SCOPE, next.capabilityRevision, next.authorityEpoch, nowIso],
      );
      if (authorization.rowCount !== 1 || capability.rowCount !== 1) throw blocked();
      return Object.freeze({
        echo: parsed.echo,
        outcome: "granted" as const,
        fieldDictionaryVersion: resolved.fieldDictionaryVersion,
        dictionaryBasis: resolved.dictionaryBasis,
        capabilityRevision: next.capabilityRevision,
        authorityEpoch: next.authorityEpoch,
      });
    }, {
      operation: "telemetry_performance.grant",
      statementTimeoutMilliseconds: STATEMENT_TIMEOUT_MILLISECONDS,
      lockTimeoutMilliseconds: LOCK_TIMEOUT_MILLISECONDS,
      preserveSafeError: preserveGrantError,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof GrantRaceRefusal) {
      return raceReread(pool, s, principal, parsed, attempted, nowIso);
    }
    throw unavailable();
  }
}

function grantResult(
  parsed: PostgresTelemetryPerformanceGrantRequest,
  outcome: "granted" | "idempotent",
  resolved: ResolvedDictionary,
  head: GrantHeadRow,
): PostgresTelemetryPerformanceGrantResult {
  return Object.freeze({
    echo: parsed.echo,
    outcome,
    fieldDictionaryVersion: resolved.fieldDictionaryVersion,
    dictionaryBasis: resolved.dictionaryBasis,
    capabilityRevision: head.capability_revision,
    authorityEpoch: head.authority_epoch,
  });
}

/** After a trigger refusal: a grant now current for the same choice is idempotent; anything else is refused. */
async function raceReread(
  pool: PostgresPool,
  s: string,
  principal: PostgresTelemetryPerformancePrincipal,
  parsed: PostgresTelemetryPerformanceGrantRequest,
  attempted: { readonly resolved: ResolvedDictionary; readonly ownerExpiresAtUs: string } | null,
  nowIso: string,
): Promise<PostgresTelemetryPerformanceGrantResult> {
  if (attempted === null) throw consentInvalid();
  let raced: GrantHeads | null = null;
  try {
    raced = await withPostgresRead(pool, async (client) => {
      const owner = await readActiveOwner(client, s, principal, nowIso, false);
      if (owner === null || owner.expires_at_us !== attempted.ownerExpiresAtUs) return null;
      return readGrantHeads(client, s, principal, owner.enrollment_device_id, false);
    }, {
      operation: "telemetry_performance.grant_reread",
      statementTimeoutMilliseconds: STATEMENT_TIMEOUT_MILLISECONDS,
      lockTimeoutMilliseconds: LOCK_TIMEOUT_MILLISECONDS,
    });
  } catch {
    throw unavailable();
  }
  if (raced !== null && currentGrant(raced, principal, attempted.ownerExpiresAtUs, attempted.resolved)) {
    return grantResult(parsed, "idempotent", attempted.resolved, raced.authorization!);
  }
  throw consentInvalid();
}

interface CapabilityRow {
  readonly capability_revision: number;
  readonly authority_epoch: number;
  readonly schema_version: string;
  readonly field_dictionary_version: string;
  readonly dictionary_basis: string;
  readonly privacy_contract_version: string;
  readonly scope: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly millisecond_exact: boolean;
}

/**
 * Read the device's current performance capability through the full fence:
 * an active runtime; an active accountless participant and device; the
 * capability head accepted and unexpired; the authorization head active with
 * the same tuple, dictionary, basis and expiry; the owner and ledger active
 * at that expiry. The answer is the Worker's response shape with the stored
 * head dictionary. Any miss is 403 TELEMETRY_TRANSPORT_BLOCKED.
 */
export async function readPostgresTelemetryPerformanceCapability(
  pool: PostgresPool,
  { schema, principal, nowEpoch }: {
    readonly schema?: PostgresSchemaOptions;
    readonly principal: PostgresTelemetryPerformancePrincipal;
    readonly nowEpoch?: number;
  },
): Promise<PostgresTelemetryPerformanceCapability> {
  if (!validPrincipal(principal)) throw blocked();
  const epoch = requestEpoch(nowEpoch);
  const nowIso = new Date(epoch).toISOString();
  const s = schemaName(schema);
  let row: CapabilityRow | null;
  try {
    row = await withPostgresRead(pool, async (client) => {
      const result = await client.query<CapabilityRow>(
        `SELECT c.capability_revision, c.authority_epoch, c.schema_version,
                c.field_dictionary_version, c.dictionary_basis, c.privacy_contract_version, c.scope,
                to_char(c.issued_at AT TIME ZONE 'UTC', ${ISO_MILLISECONDS}) AS issued_at,
                to_char(c.expires_at AT TIME ZONE 'UTC', ${ISO_MILLISECONDS}) AS expires_at,
                (date_trunc('milliseconds', c.issued_at) = c.issued_at
                  AND date_trunc('milliseconds', c.expires_at) = c.expires_at) AS millisecond_exact
           FROM ${s}."telemetry_performance_runtime" r
           JOIN ${s}."participants" p ON p.id = $1
           JOIN ${s}."device_credentials" d ON d.id = $2 AND d.participant_id = p.id
           JOIN LATERAL (
             SELECT head.*
               FROM ${s}."telemetry_performance_device_capabilities" head
              WHERE head.participant_id = p.id AND head.device_id = d.id
              ORDER BY head.capability_revision DESC, head.authority_epoch DESC
              LIMIT 1
           ) c ON true
           JOIN LATERAL (
             SELECT head.*
               FROM ${s}."accountless_telemetry_performance_authorizations" head
              WHERE head.enrollment_device_id = d.accountless_enrollment_device_id
              ORDER BY head.capability_revision DESC, head.authority_epoch DESC
              LIMIT 1
           ) a ON true
           JOIN ${s}."accountless_upload_owners" owner ON owner.enrollment_device_id = a.enrollment_device_id
           JOIN ${s}."accountless_enrollment_ledger" ledger ON ledger.device_id = owner.enrollment_device_id
          WHERE r.id = 1 AND r.state = 'active'
            AND p.state = 'active' AND p.owner_kind = 'accountless'
            AND d.state = 'active' AND d.authority_kind = 'accountless'
            AND c.state = 'accepted' AND c.scope = $4
            AND c.expires_at > $3::timestamptz
            AND c.schema_version = r.schema_version
            AND c.privacy_contract_version = r.privacy_contract_version
            AND a.state = 'active'
            AND a.participant_id = p.id AND a.device_credential_id = d.id
            AND a.policy_version = $5 AND a.authorization_basis = $6
            AND a.capability_revision = c.capability_revision
            AND a.authority_epoch = c.authority_epoch
            AND a.field_dictionary_version = c.field_dictionary_version
            AND a.dictionary_basis = c.dictionary_basis
            AND a.performance_schema_version = c.schema_version
            AND a.privacy_contract_version = c.privacy_contract_version
            AND a.scope = c.scope
            AND a.expires_at = c.expires_at
            AND owner.state = 'active'
            AND owner.participant_id = p.id AND owner.device_credential_id = d.id
            AND ledger.state = 'active'
            AND owner.expires_at = a.expires_at AND ledger.expires_at = a.expires_at`,
        [principal.participantId, principal.deviceId, nowIso, TELEMETRY_PERFORMANCE_SCOPE,
          ACCOUNTLESS_TELEMETRY_PERFORMANCE_POLICY_VERSION, ACCOUNTLESS_TELEMETRY_PERFORMANCE_AUTHORIZATION_BASIS],
      );
      return result.rowCount === 1 ? result.rows[0] ?? null : null;
    }, {
      operation: "telemetry_performance.capability",
      statementTimeoutMilliseconds: STATEMENT_TIMEOUT_MILLISECONDS,
      lockTimeoutMilliseconds: LOCK_TIMEOUT_MILLISECONDS,
    });
  } catch {
    throw unavailable();
  }
  if (row === null
      || row.millisecond_exact !== true
      || row.schema_version !== PERFORMANCE_RECORD_SCHEMA_VERSION
      || row.privacy_contract_version !== PERFORMANCE_PRIVACY_CONTRACT_VERSION
      || row.scope !== TELEMETRY_PERFORMANCE_SCOPE
      || !knownDictionary(row.field_dictionary_version)
      || !knownBasis(row.dictionary_basis)
      || !integer(row.capability_revision, 1, MAX_REVISION)
      || !integer(row.authority_epoch, 1, MAX_REVISION)
      || !instant(row.issued_at) || !instant(row.expires_at)
      || Date.parse(row.expires_at) <= epoch) {
    throw blocked();
  }
  return Object.freeze({
    schemaVersion: TELEMETRY_PERFORMANCE_CAPABILITIES_VERSION,
    lifecycle: "accepted" as const,
    consentCurrent: true as const,
    authorizationCurrent: true as const,
    supportedSpeedMethods: TELEMETRY_PERFORMANCE_SUPPORTED_SPEED_METHODS,
    requiredConsent: Object.freeze({
      schemaVersion: PERFORMANCE_RECORD_SCHEMA_VERSION,
      fieldDictionaryVersion: row.field_dictionary_version,
      privacyContractVersion: PERFORMANCE_PRIVACY_CONTRACT_VERSION,
      scope: TELEMETRY_PERFORMANCE_SCOPE,
    }),
    authorization: Object.freeze({
      schemaVersion: TELEMETRY_PERFORMANCE_AUTHORIZATION_VERSION,
      capabilityRevision: row.capability_revision,
      authorityEpoch: row.authority_epoch,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      scope: TELEMETRY_PERFORMANCE_SCOPE,
    }),
  });
}
