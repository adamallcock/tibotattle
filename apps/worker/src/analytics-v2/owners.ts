/**
 * analytics-v2 input side (A-1): the eligible owner roster and its per-owner
 * source routing, read from the existing PostgreSQL tables.
 *
 * This is a PostgreSQL port of d43c8f92 storage-community-authority.ts
 * readStorageCommunityOwnerPage (:265-324) and of the source routing in
 * d43c8f92 storage-community-graph.ts:365. Production-parity eligibility
 * (OD-3): an owner is listed only when its participant is active and present
 * in community_public_source_owners (primary 0046), exactly as production
 * computes it. Two deliberate translations, both documented here:
 *
 *  - Clock. D1 evaluates the retained v1.2 authorization scope with
 *    strftime('now'); this port evaluates it at the run's pinned nowMs, so a
 *    recompute with an injected test clock is reproducible.
 *  - Usage-correction runtime. PostgreSQL 0034 keeps the copied runtime row
 *    operationally `staged` (CHECK state = 'staged') and records the sealed D1
 *    row's state in `source_state`. Production's "runtime id=1 is active"
 *    predicate is therefore read from `source_state = 'active'`.
 *
 * The module also holds the small read primitives the other A-1 readers
 * share: the read-only snapshot, schema quoting, the typed-id decoder SQL and
 * the two v1.2 retained-authorization scopes. Every read runs inside a
 * read-only transaction; nothing here writes. Errors carry a closed code and
 * never an identifier, digest or row value.
 */

import { quotePostgresIdentifier, withPostgresRead, type PostgresClient } from "../postgres-client";
import {
  ANALYTICS_V2_OWNER_DIGEST_PATTERN,
  type AnalyticsV2Owner,
  type AnalyticsV2OwnerSource,
  type AnalyticsV2ReadContext,
} from "./contract";

// ---------------------------------------------------------------------------
// Shared read primitives
// ---------------------------------------------------------------------------

export type AnalyticsV2SourceErrorCode =
  | "ANALYTICS_V2_SOURCE_INVALID"
  | "ANALYTICS_V2_SOURCE_UNAVAILABLE"
  | "ANALYTICS_V2_SOURCE_CONFLICT"
  | "ANALYTICS_V2_SOURCE_LIMIT";

/** A closed, content-free failure of an A-1 source read. */
export class AnalyticsV2SourceError extends Error {
  constructor(readonly code: AnalyticsV2SourceErrorCode) {
    super(code);
    this.name = "AnalyticsV2SourceError";
  }
}

export function sourceFail(code: AnalyticsV2SourceErrorCode = "ANALYTICS_V2_SOURCE_UNAVAILABLE"): never {
  throw new AnalyticsV2SourceError(code);
}

/**
 * A read context that may carry the client of an open read-only snapshot.
 * A-3 opens one snapshot (withAnalyticsV2ReadSnapshot) and passes it to every
 * reader so the owner roster, occurrences, devices and queued days are one
 * consistent view; a reader called without `client` opens its own.
 */
export interface AnalyticsV2SnapshotContext extends AnalyticsV2ReadContext {
  readonly client?: PostgresClient;
}

const READ_TIMEOUT_MS = 300_000;

/** The pinned clock as a timestamptz bind value (millisecond ISO-8601). */
export function nowTimestamp(nowMs: unknown): string {
  if (typeof nowMs !== "number" || !Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000) {
    sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  return new Date(nowMs).toISOString();
}

/** The validated, quoted schema identifier. */
export function quotedSchema(schema: unknown): string {
  try {
    return quotePostgresIdentifier(schema);
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
}

function preserve(error: unknown): Error | null {
  return error instanceof AnalyticsV2SourceError ? error : null;
}

async function assertReadOnly(client: PostgresClient): Promise<void> {
  const result = await client.query<{ read_only: unknown }>("SELECT current_setting('transaction_read_only') AS read_only");
  if (result.rows.length !== 1 || result.rows[0]?.read_only !== "on") sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
}

/**
 * Open ONE repeatable-read, read-only snapshot and run `operation` in it.
 * Any write attempted inside it is refused by PostgreSQL (SQLSTATE 25006).
 */
export async function withAnalyticsV2ReadSnapshot<T>(
  context: AnalyticsV2ReadContext,
  operation: (snapshot: AnalyticsV2SnapshotContext & { readonly client: PostgresClient }) => Promise<T>,
): Promise<T> {
  quotedSchema(context.schema);
  nowTimestamp(context.nowMs);
  return withPostgresRead(context.pool, async (client) => {
    await assertReadOnly(client);
    return operation({ pool: context.pool, schema: context.schema, nowMs: context.nowMs, client });
  }, { operation: "analytics_v2.read", isolationLevel: "repeatable_read",
    statementTimeoutMilliseconds: READ_TIMEOUT_MS, lockTimeoutMilliseconds: 5_000, preserveSafeError: preserve });
}

/** Run one reader on the caller's snapshot, or in a snapshot of its own. */
export async function onReadSnapshot<T>(
  context: AnalyticsV2SnapshotContext,
  operation: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  if (context.client === undefined) {
    return withAnalyticsV2ReadSnapshot(context, (snapshot) => operation(snapshot.client));
  }
  quotedSchema(context.schema);
  nowTimestamp(context.nowMs);
  await assertReadOnly(context.client);
  return operation(context.client);
}

/** A non-negative safe integer from a bigint column read as text or number. */
export function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "string" && /^-?\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
  return parsed;
}

export const DAY_MS = 86_400_000;

/** UTC day number of a YYYY-MM-DD day. */
export function dayNumber(day: unknown): number {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(day)) sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  return ms / DAY_MS;
}

export function dayFromNumber(value: number): string {
  return new Date(value * DAY_MS).toISOString().slice(0, 10);
}

/**
 * SQL decoding a typed-telemetry identifier blob to its text form: the
 * layout-version-1 codec of typed-telemetry-codec.ts (and of the D1
 * typed_telemetry_compatibility_records view). Unknown tags decode to NULL.
 */
export function typedIdTextSql(column: string): string {
  const encoded = `encode(substring(${column} from 2), 'hex')`;
  const uuid = `substr(${encoded},1,8)||'-'||substr(${encoded},9,4)||'-'||substr(${encoded},13,4)||'-'||substr(${encoded},17,4)||'-'||substr(${encoded},21,12)`;
  const cases: readonly (readonly [number, string, number, number])[] = [
    [0, `convert_from(substring(${column} from 2), 'UTF8')`, 2, 257],
    [1, uuid, 17, 17],
    [2, `'participant:'||(${uuid})`, 17, 17],
    [3, `'device:'||(${uuid})`, 17, 17],
    [4, `'v1:'||(${uuid})`, 17, 17],
    [5, `'contribution:'||(${uuid})`, 17, 17],
    [6, encoded, 33, 33],
    [7, `'event:v2:'||(${encoded})`, 33, 33],
    [8, `'quota-occurrence:v1:'||(${encoded})`, 33, 33],
    [9, `'account-track:v2:'||(${encoded})`, 33, 33],
    [10, `'plan-era:v1:'||(${encoded})`, 33, 33],
    [11, `'chunk:'||(${uuid})`, 17, 17],
  ];
  return `(CASE ${cases.map(([tag, value, minimum, maximum]) =>
    `WHEN get_byte(${column},0)=${tag} AND octet_length(${column}) BETWEEN ${minimum} AND ${maximum} THEN ${value}`)
    .join(" ")} ELSE NULL END)`;
}

/**
 * telemetry_v12_typed_active_authorizations (primary 0025), the PostgreSQL
 * port of D1's telemetry_v12_active_authorizations, with its two now()
 * comparisons bound to the pinned clock parameter `now` instead.
 */
export function v12ActiveAuthorizationsSql(s: string, now: string): string {
  return `SELECT c.participant_id, c.device_id
  FROM ${s}.telemetry_v12_device_capabilities c
  JOIN ${s}.telemetry_v12_runtime r ON r.id = 1 AND r.state = 'active'
  JOIN ${s}.telemetry_v12_typed_runtime typed_runtime ON typed_runtime.id = 1 AND typed_runtime.state = 'active'
  JOIN ${s}.participants p ON p.id = c.participant_id
  JOIN ${s}.device_credentials d ON d.id = c.device_id AND d.participant_id = p.id
 WHERE c.state = 'accepted'
   AND c.telemetry_schema_version = typed_runtime.schema_version
   AND c.field_dictionary_version = typed_runtime.field_dictionary_version
   AND c.privacy_contract_version = typed_runtime.privacy_contract_version
   AND p.state = 'active' AND p.owner_kind = 'social'
   AND d.state = 'active' AND d.authority_kind = 'social'
UNION ALL
SELECT a.participant_id, a.device_credential_id AS device_id
  FROM ${s}.accountless_v12_device_authorizations a
  JOIN ${s}.telemetry_v12_runtime r ON r.id = 1 AND r.state = 'active'
  JOIN ${s}.telemetry_v12_typed_runtime typed_runtime ON typed_runtime.id = 1 AND typed_runtime.state = 'active'
  JOIN ${s}.participants p ON p.id = a.participant_id
  JOIN ${s}.device_credentials d ON d.id = a.device_credential_id AND d.participant_id = p.id
  JOIN ${s}.accountless_enrollment_ledger ledger ON ledger.device_id = a.enrollment_device_id
  JOIN ${s}.accountless_upload_owners owner ON owner.enrollment_device_id = a.enrollment_device_id
 WHERE a.state = 'active' AND a.expires_at > ${now}
   AND a.schema_version = 'accountless-upload-owner-v1.2'
   AND a.policy_version = 'accountless-telemetry-v1.2-policy-v1'
   AND a.authorization_basis = 'accountless-policy-v1.2'
   AND a.telemetry_schema_version = typed_runtime.schema_version
   AND a.field_dictionary_version = typed_runtime.field_dictionary_version
   AND a.privacy_contract_version = typed_runtime.privacy_contract_version
   AND p.state = 'active' AND p.owner_kind = 'accountless'
   AND d.state = 'active' AND d.authority_kind = 'accountless'
   AND d.accountless_enrollment_device_id = a.enrollment_device_id
   AND d.expires_at = a.expires_at
   AND ledger.state = 'active' AND ledger.expires_at = a.expires_at AND ledger.expires_at > ${now}
   AND owner.participant_id = a.participant_id
   AND owner.device_credential_id = a.device_credential_id
   AND owner.state = 'active' AND owner.expires_at = a.expires_at`;
}

/**
 * The two retained v1.2 authorization scopes production uses, at the pinned
 * clock. `community`: d43c8f92 storage-community-authority.ts
 * V12_RETAINED_AUTHORIZATION_SCOPE (owner roster, device counts; its active
 * branch has no owner-link join, as 0053's view). `reader`: d43c8f92
 * telemetry-v12-effective-reader.ts RETAINED_AUTHORIZATION_SCOPE (occurrence
 * reads; every branch requires the active owner link, as 0025's view).
 */
export function v12RetainedAuthorizationScopeSql(s: string, now: string, variant: "community" | "reader"): string {
  const activeOwnerLink = variant === "reader"
    ? `JOIN ${s}.storage_v11_owner_links owner_link
          ON owner_link.participant_id=active_auth.participant_id AND owner_link.state='active'` : "";
  return `SELECT active_auth.participant_id,active_auth.device_id
        FROM (${v12ActiveAuthorizationsSql(s, now)}) active_auth
        ${activeOwnerLink}
      UNION
      SELECT capability.participant_id,capability.device_id
        FROM ${s}.telemetry_v12_device_capabilities capability
        JOIN ${s}.participants participant ON participant.id=capability.participant_id AND participant.state='active'
        JOIN ${s}.storage_v11_owner_links owner_link
          ON owner_link.participant_id=capability.participant_id AND owner_link.state='active'
       WHERE capability.state IN ('accepted','revoked')
         AND capability.telemetry_schema_version='telemetry-contribution-v1.2'
      UNION
      SELECT retained_auth.participant_id,retained_auth.device_credential_id
        FROM ${s}.accountless_v12_device_authorizations retained_auth
        JOIN ${s}.participants participant ON participant.id=retained_auth.participant_id AND participant.state='active'
        JOIN ${s}.storage_v11_owner_links owner_link
          ON owner_link.participant_id=retained_auth.participant_id AND owner_link.state='active'
       WHERE (retained_auth.state='active' AND retained_auth.expires_at <= ${now})
          OR (retained_auth.state='revoked' AND retained_auth.revocation_reason='user_opt_out')`;
}

/**
 * Production's "usage-correction runtime id=1 is active" predicate, read from
 * the sealed source state 0034 records (see the module comment).
 */
export function correctionRuntimeActiveSql(s: string): string {
  return `EXISTS(SELECT 1 FROM ${s}.telemetry_usage_correction_runtime r
      WHERE r.id=1 AND r.source_state='active' AND r.schema_version='telemetry-usage-correction-v1'
        AND r.method_version='usage-total-correction-v1')`;
}

// ---------------------------------------------------------------------------
// Owner roster
// ---------------------------------------------------------------------------

/**
 * An eligible participant that has no active storage owner link. Production
 * keeps such owners explicit (ownerDigest null): the daily lane refuses them
 * and the graph treats them as pending. They are reported, never dropped and
 * never given an inferred digest.
 */
export interface AnalyticsV2UnlinkedOwner {
  readonly participantId: string;
  readonly hasV1: boolean;
  readonly hasV11: boolean;
  readonly hasV12: boolean;
  readonly hasLegacy: boolean;
  readonly hasEffective: boolean;
  readonly source: AnalyticsV2OwnerSource;
}

export interface AnalyticsV2OwnerListing {
  /** Linked eligible owners in participant-id byte order. */
  readonly owners: readonly AnalyticsV2Owner[];
  readonly unlinked: readonly AnalyticsV2UnlinkedOwner[];
  /** Production's correction-runtime state as the sealed source recorded it. */
  readonly correctionRuntimeActive: boolean;
}

/** Bound on one roster read; a larger population fails closed (LIMIT). */
export const MAX_ANALYTICS_V2_OWNERS = 100_000;
const PARTICIPANT_ID = /^[A-Za-z0-9._:-]{1,256}$/u;

/** d43c8f92 storage-community-graph.ts:365. */
export function analyticsV2OwnerSource(flags: {
  readonly hasV1: boolean; readonly hasV11: boolean; readonly hasLegacy: boolean; readonly hasEffective: boolean;
}): AnalyticsV2OwnerSource {
  return flags.hasEffective ? "effective" : flags.hasV11 ? "v1.1" : flags.hasV1 ? flags.hasLegacy ? "mixed" : "v1" : "v0.2";
}

interface OwnerRow {
  readonly participant_id: unknown;
  readonly owner_digest: unknown;
  readonly has_v1: unknown;
  readonly has_v11: unknown;
  readonly has_v12: unknown;
  readonly has_effective: unknown;
  readonly has_legacy: unknown;
}

/** The SQL of the roster read (exported for the spec's plan checks only). */
export function analyticsV2OwnersSql(s: string): string {
  const v1 = `EXISTS(SELECT 1 FROM ${s}.telemetry_v1_chunks c WHERE c.participant_id=p.id
      AND c.superseded_at IS NULL AND c.accepted_record_count>0)`;
  const v11 = `EXISTS(SELECT 1 FROM ${s}.telemetry_v11_domain_heads h WHERE h.participant_id=p.id)`;
  const v12 = `EXISTS(
      SELECT 1 FROM ${s}.telemetry_v12_domain_heads h
      JOIN ${s}.telemetry_v12_domains d ON d.id=h.generation_id AND d.participant_id=h.participant_id
      JOIN ${s}.telemetry_v12_domain_days dd ON dd.generation_id=d.id
      JOIN ${s}.telemetry_v12_day_manifests m ON m.id=dd.manifest_id
        AND m.participant_id=d.participant_id AND m.device_id=d.device_id
        AND m.chunk_day=dd.observed_day AND m.manifest_digest=dd.manifest_digest AND m.state='ready'
      JOIN (${v12RetainedAuthorizationScopeSql(s, "$1::timestamptz", "community")}) retained
        ON retained.participant_id=d.participant_id AND retained.device_id=d.device_id
      WHERE h.participant_id=p.id
    )`;
  const effective = `(${v12} OR ((${v1} OR ${v11}) AND ${correctionRuntimeActiveSql(s)}))`;
  return `SELECT p.id AS participant_id,l.owner_digest,
          ${v1} AS has_v1,
          ${v11} AS has_v11,
          ${v12} AS has_v12,
          ${effective} AS has_effective,
          EXISTS(SELECT 1 FROM ${s}.telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
            AND c.transport_schema_version='telemetry-contribution-v0.2') AS has_legacy
     FROM ${s}.participants p
     LEFT JOIN ${s}.storage_v11_owner_links l ON l.participant_id=p.id AND l.state='active'
    WHERE p.state='active' AND EXISTS(
      SELECT 1 FROM ${s}.community_public_source_owners eligible WHERE eligible.participant_id=p.id)
    ORDER BY p.id COLLATE "C" LIMIT $2`;
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  return value;
}

/**
 * List every eligible owner with production's hasV1/hasV11/hasV12/hasLegacy/
 * hasEffective flags and source routing, evaluated at context.nowMs.
 */
export async function listAnalyticsV2Owners(context: AnalyticsV2SnapshotContext): Promise<AnalyticsV2OwnerListing> {
  const s = quotedSchema(context.schema);
  const now = nowTimestamp(context.nowMs);
  return onReadSnapshot(context, async (client) => {
    const runtime = await client.query<{ active: unknown }>(`SELECT ${correctionRuntimeActiveSql(s)} AS active`);
    const correctionRuntimeActive = flag(runtime.rows[0]?.active);
    const result = await client.query<OwnerRow>(analyticsV2OwnersSql(s), [now, MAX_ANALYTICS_V2_OWNERS + 1]);
    if (result.rows.length > MAX_ANALYTICS_V2_OWNERS) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
    const owners: AnalyticsV2Owner[] = [];
    const unlinked: AnalyticsV2UnlinkedOwner[] = [];
    for (const row of result.rows) {
      if (typeof row.participant_id !== "string" || !PARTICIPANT_ID.test(row.participant_id)
          || (row.owner_digest !== null
            && (typeof row.owner_digest !== "string" || !ANALYTICS_V2_OWNER_DIGEST_PATTERN.test(row.owner_digest)))) {
        sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
      }
      const flags = {
        hasV1: flag(row.has_v1),
        hasV11: flag(row.has_v11),
        hasV12: flag(row.has_v12),
        hasLegacy: flag(row.has_legacy),
        hasEffective: flag(row.has_effective),
      };
      const source = analyticsV2OwnerSource(flags);
      if (row.owner_digest === null) {
        unlinked.push(Object.freeze({ participantId: row.participant_id, ...flags, source }));
      } else {
        owners.push(Object.freeze({ participantId: row.participant_id, ownerDigest: row.owner_digest as string,
          ...flags, source }));
      }
    }
    if (new Set(owners.map((owner) => owner.ownerDigest)).size !== owners.length) {
      sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
    }
    return Object.freeze({ owners: Object.freeze(owners), unlinked: Object.freeze(unlinked), correctionRuntimeActive });
  });
}
