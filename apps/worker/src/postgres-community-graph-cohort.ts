/**
 * Read-only, keyset-paged inventory for the PostgreSQL public model graph.
 *
 * Membership uses the reviewed effective-owner reader's exact current-source
 * predicate. In PostgreSQL today that predicate admits owners with retained,
 * authorized typed v1.2 domains. Legacy v1/v1.1 receipts are still mandatory
 * for the reader to prove those families were inventoried, but this module
 * does not turn legacy presence into graph eligibility or infer corrections.
 *
 * A page cursor carries the full legacy-source pin plus graph publication and
 * collection revisions. Every page re-reads those global values, requires
 * analytics to have applied the complete ingestion journal, and refuses to
 * continue if any pinned authority changed. The keyset remains over all
 * effective-reader owners; therefore callers must follow `next` even when a
 * page contains no eligible v1.2 graph owners. There is no cohort-size cap.
 * The bounded `limit` applies to each database page only.
 *
 * This operation inventories membership and owner revisions. It does not
 * calculate history dependency fingerprints, calculate model results, or
 * publish a cohort. The caller must complete those steps and retain this pin.
 */

import {
  listPostgresEffectiveOwners,
  listPostgresEffectiveOwnersOnClient,
  PostgresLegacyEffectiveError,
  type PostgresEffectiveOwnerPin,
  type PostgresEffectiveOwnersCursor,
  type PostgresEffectiveSourcePin,
} from "./postgres-typed-legacy-effective-reader";
import {
  createPostgresSchemaConfig,
  createPostgresSourceIdentityConfig,
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";
import type { PostgresCommunityGraphSourceKind } from "./postgres-community-graph-contract";

const MAX_PAGE_SIZE = 200;
const SHA256 = /^[a-f0-9]{64}$/u;
const fail = (code: PostgresCommunityGraphCohortErrorCode): never => {
  throw new PostgresCommunityGraphCohortError(code);
};

export type PostgresCommunityGraphCohortErrorCode =
  | "POSTGRES_COMMUNITY_GRAPH_COHORT_INVALID"
  | "POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE"
  | "POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED";

export class PostgresCommunityGraphCohortError extends Error {
  constructor(readonly code: PostgresCommunityGraphCohortErrorCode) {
    super(code);
    this.name = "PostgresCommunityGraphCohortError";
  }
}

/** The publisher-compatible source pin plus the extra fences needed while
 * pages are assembled. `effectiveSourcePin` binds the source-family receipts
 * required to prove legacy-family inventory; policy and collection revisions
 * fence graph eligibility even when no telemetry row changed. */
export interface PostgresCommunityGraphCohortSourcePin {
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly sourceAuthorityEpoch: number;
  readonly analyticsAuthorityEpoch: number;
  readonly sequence: number;
  readonly telemetryV12RuntimeState: string;
  readonly telemetryV12RuntimeRevision: number;
  readonly telemetryV12TypedRuntimeState: string;
  readonly telemetryV12TypedRuntimePolicyRevision: number;
  /** Time-based accountless authorization can change graph membership without
   * a journal row. Pin the active authorization count and next expiry, then
   * force a restart if that boundary is crossed during the scan. */
  readonly accountlessAuthorizationCount: number;
  readonly nextAccountlessAuthorizationExpiry: string | null;
  readonly effectiveSourcePin: PostgresEffectiveSourcePin;
  readonly policyRevision: number;
  readonly collectionRevision: number;
}

export interface PostgresCommunityGraphCohortCursor {
  readonly afterOwnerDigest: string;
  readonly sourcePin: PostgresCommunityGraphCohortSourcePin;
}

/** Known source flags accompany eligible owners so downstream calculation can
 * preserve the distinction between the current effective v1.2 lane and
 * separately observed legacy-family presence. */
export interface PostgresCommunityGraphCohortOwner {
  readonly participantId: string;
  readonly ownerDigest: string;
  /** Publisher/cache fence from `input_versions`. The effective-source reader
   * retains its independent analytical input revision at `ownerPin.inputRevision`. */
  readonly inputRevision: number;
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  readonly sourceKind: Extract<PostgresCommunityGraphSourceKind, "effective">;
  readonly hasV1: boolean;
  readonly hasV11: boolean;
  readonly hasLegacy: boolean;
  readonly hasV12: true;
  readonly v12GenerationId: string;
  readonly ownerPin: PostgresEffectiveOwnerPin;
}

export interface PostgresCommunityGraphCohortPage {
  readonly available: true;
  readonly sourcePin: PostgresCommunityGraphCohortSourcePin;
  readonly owners: readonly PostgresCommunityGraphCohortOwner[];
  /** Number of effective-reader rows examined, before the v1.2 eligibility
   * filter. This is at most the requested page size. */
  readonly scannedOwnerCount: number;
  readonly next: PostgresCommunityGraphCohortCursor | null;
}

export interface ListPostgresCommunityGraphCohortOptions {
  readonly sourceId?: unknown;
  readonly sourceNamespace?: unknown;
  readonly after?: PostgresCommunityGraphCohortCursor;
  /** A page size from 1 through 200. This is not a total cohort limit. */
  readonly limit?: number;
  readonly schema?: PostgresSchemaConfig;
}

interface GraphAuthorityRow {
  readonly source_id: string;
  readonly source_authority_epoch: string | number;
  readonly analytics_sequence: string | number;
  readonly analytics_authority_epoch: string | number;
  readonly latest_sequence: string | number;
  readonly policy_revision: string | number;
  readonly collection_revision: string | number;
  readonly publication_state: string;
  readonly control_state: string;
  readonly publication_enabled: boolean;
  readonly v12_runtime_state: string;
  readonly v12_runtime_revision: string | number;
  readonly v12_typed_runtime_state: string;
  readonly v12_typed_runtime_policy_revision: string | number;
  readonly accountless_authorization_count: string | number;
  readonly next_accountless_authorization_expiry: string | Date | null;
}

interface CapturedGraphAuthority {
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly sourceAuthorityEpoch: number;
  readonly analyticsAuthorityEpoch: number;
  readonly sequence: number;
  readonly policyRevision: number;
  readonly collectionRevision: number;
  readonly telemetryV12RuntimeState: string;
  readonly telemetryV12RuntimeRevision: number;
  readonly telemetryV12TypedRuntimeState: string;
  readonly telemetryV12TypedRuntimePolicyRevision: number;
  readonly accountlessAuthorizationCount: number;
  readonly nextAccountlessAuthorizationExpiry: string | null;
}

function safeInteger(value: unknown, minimum = 0): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE");
  }
  return parsed;
}

function timestamp(value: unknown): string | null {
  if (value === null) return null;
  const epoch = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(epoch) || epoch < 0) return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE");
  return new Date(epoch).toISOString();
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function normalizeEffectiveSourcePin(
  value: unknown,
  identity: { readonly sourceId: string; readonly sourceNamespace: string },
): PostgresEffectiveSourcePin {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_INVALID");
  }
  const pin = value as Record<string, unknown>;
  if (!exactKeys(pin, [
    "sourceId", "sourceNamespace", "storageAuthorityEpoch", "sourceCursorSequence",
    "sourceCursorAuthorityEpoch", "v1ImportGeneration", "v1ImportDigest",
    "v11ImportGeneration", "v11ImportDigest",
  ]) || pin.sourceId !== identity.sourceId || pin.sourceNamespace !== identity.sourceNamespace
      || typeof pin.v1ImportDigest !== "string" || !SHA256.test(pin.v1ImportDigest)
      || typeof pin.v11ImportDigest !== "string" || !SHA256.test(pin.v11ImportDigest)) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_INVALID");
  }
  return Object.freeze({
    sourceId: identity.sourceId,
    sourceNamespace: identity.sourceNamespace,
    storageAuthorityEpoch: safeInteger(pin.storageAuthorityEpoch),
    sourceCursorSequence: safeInteger(pin.sourceCursorSequence),
    sourceCursorAuthorityEpoch: safeInteger(pin.sourceCursorAuthorityEpoch),
    v1ImportGeneration: safeInteger(pin.v1ImportGeneration, 1),
    v1ImportDigest: pin.v1ImportDigest,
    v11ImportGeneration: safeInteger(pin.v11ImportGeneration, 1),
    v11ImportDigest: pin.v11ImportDigest,
  });
}

function normalizeSourcePin(
  value: unknown,
  identity: { readonly sourceId: string; readonly sourceNamespace: string },
): PostgresCommunityGraphCohortSourcePin {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_INVALID");
  }
  const raw = value as Record<string, unknown>;
  if (!exactKeys(raw, [
    "sourceId", "sourceNamespace", "sourceAuthorityEpoch", "analyticsAuthorityEpoch", "sequence",
    "telemetryV12RuntimeState", "telemetryV12RuntimeRevision", "telemetryV12TypedRuntimeState",
    "telemetryV12TypedRuntimePolicyRevision", "accountlessAuthorizationCount",
    "nextAccountlessAuthorizationExpiry", "effectiveSourcePin", "policyRevision", "collectionRevision",
  ]) || raw.sourceId !== identity.sourceId || raw.sourceNamespace !== identity.sourceNamespace
      || raw.telemetryV12RuntimeState !== "active" || raw.telemetryV12TypedRuntimeState !== "active") {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_INVALID");
  }
  return Object.freeze({
    sourceId: identity.sourceId,
    sourceNamespace: identity.sourceNamespace,
    sourceAuthorityEpoch: safeInteger(raw.sourceAuthorityEpoch),
    analyticsAuthorityEpoch: safeInteger(raw.analyticsAuthorityEpoch),
    sequence: safeInteger(raw.sequence),
    telemetryV12RuntimeState: "active",
    telemetryV12RuntimeRevision: safeInteger(raw.telemetryV12RuntimeRevision),
    telemetryV12TypedRuntimeState: "active",
    telemetryV12TypedRuntimePolicyRevision: safeInteger(raw.telemetryV12TypedRuntimePolicyRevision, 1),
    accountlessAuthorizationCount: safeInteger(raw.accountlessAuthorizationCount),
    nextAccountlessAuthorizationExpiry: timestamp(raw.nextAccountlessAuthorizationExpiry),
    effectiveSourcePin: normalizeEffectiveSourcePin(raw.effectiveSourcePin, identity),
    policyRevision: safeInteger(raw.policyRevision, 1),
    collectionRevision: safeInteger(raw.collectionRevision, 1),
  });
}

function normalizeCursor(
  value: PostgresCommunityGraphCohortCursor | undefined,
  identity: { readonly sourceId: string; readonly sourceNamespace: string },
): PostgresCommunityGraphCohortCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_INVALID");
  }
  const raw = value as unknown as Record<string, unknown>;
  if (!exactKeys(raw, ["afterOwnerDigest", "sourcePin"])
      || typeof raw.afterOwnerDigest !== "string" || !SHA256.test(raw.afterOwnerDigest)) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_INVALID");
  }
  return Object.freeze({
    afterOwnerDigest: raw.afterOwnerDigest,
    sourcePin: normalizeSourcePin(raw.sourcePin, identity),
  });
}

function sameEffectiveSourcePin(left: PostgresEffectiveSourcePin, right: PostgresEffectiveSourcePin): boolean {
  return left.sourceId === right.sourceId && left.sourceNamespace === right.sourceNamespace
    && left.storageAuthorityEpoch === right.storageAuthorityEpoch
    && left.sourceCursorSequence === right.sourceCursorSequence
    && left.sourceCursorAuthorityEpoch === right.sourceCursorAuthorityEpoch
    && left.v1ImportGeneration === right.v1ImportGeneration && left.v1ImportDigest === right.v1ImportDigest
    && left.v11ImportGeneration === right.v11ImportGeneration && left.v11ImportDigest === right.v11ImportDigest;
}

function sameSourcePin(left: PostgresCommunityGraphCohortSourcePin,
  right: PostgresCommunityGraphCohortSourcePin): boolean {
  return left.sourceId === right.sourceId && left.sourceNamespace === right.sourceNamespace
    && left.sourceAuthorityEpoch === right.sourceAuthorityEpoch
    && left.analyticsAuthorityEpoch === right.analyticsAuthorityEpoch && left.sequence === right.sequence
    && left.telemetryV12RuntimeState === right.telemetryV12RuntimeState
    && left.telemetryV12RuntimeRevision === right.telemetryV12RuntimeRevision
    && left.telemetryV12TypedRuntimeState === right.telemetryV12TypedRuntimeState
    && left.telemetryV12TypedRuntimePolicyRevision === right.telemetryV12TypedRuntimePolicyRevision
    && left.accountlessAuthorizationCount === right.accountlessAuthorizationCount
    && left.nextAccountlessAuthorizationExpiry === right.nextAccountlessAuthorizationExpiry
    && left.policyRevision === right.policyRevision && left.collectionRevision === right.collectionRevision
    && sameEffectiveSourcePin(left.effectiveSourcePin, right.effectiveSourcePin);
}

function cohortOwner(
  owner: Awaited<ReturnType<typeof listPostgresEffectiveOwners>>["owners"][number],
  publisherInputRevision: number,
)
  : PostgresCommunityGraphCohortOwner {
  // hasEffective is currently exactly `has_v12`; reassert the independent
  // owner pin so schema drift or an incomplete eligibility SQL change fails
  // closed before a caller counts the row as a graph member.
  if (!owner.hasEffective || !owner.hasV12 || owner.pin.v12State !== "active:active"
      || owner.pin.v12GenerationId === null) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE");
  }
  return Object.freeze({
    participantId: owner.participantId,
    ownerDigest: owner.ownerDigest,
    inputRevision: publisherInputRevision,
    ownerRevision: owner.ownerRevision,
    authorityEpoch: owner.authorityEpoch,
    sourceKind: "effective",
    hasV1: owner.hasV1,
    hasV11: owner.hasV11,
    hasLegacy: owner.hasLegacy,
    hasV12: true,
    v12GenerationId: owner.pin.v12GenerationId,
    ownerPin: owner.pin,
  });
}

async function readPublisherInputRevisionsOnClient(
  client: PostgresClient,
  schemaName: string,
  owners: readonly Awaited<ReturnType<typeof listPostgresEffectiveOwners>>["owners"][number][],
): Promise<ReadonlyMap<string, number>> {
  if (owners.length === 0) return new Map();
  const result = await client.query<{ participant_id: string; revision: string | number }>(
    `SELECT participant_id, revision FROM ${schemaName}.input_versions
      WHERE participant_id = ANY($1::text[]) ORDER BY participant_id`,
    [owners.map((owner) => owner.participantId)],
  );
  if (result.rows.length !== owners.length) return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE");
  const revisions = new Map(result.rows.map((row) => [row.participant_id, safeInteger(row.revision)]));
  if (owners.some((owner) => !revisions.has(owner.participantId))) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE");
  }
  return revisions;
}

async function captureGraphAuthorityOnClient(
  client: PostgresClient,
  schemaName: string,
  identity: { readonly sourceId: string; readonly sourceNamespace: string },
): Promise<CapturedGraphAuthority> {
  const row = await client.query<GraphAuthorityRow>(
    `SELECT source.source_id,
            source.authority_epoch AS source_authority_epoch,
            cursor.sequence AS analytics_sequence,
            cursor.authority_epoch AS analytics_authority_epoch,
            COALESCE((SELECT max(change.sequence) FROM ${schemaName}.storage_ingestion_changes change
                       WHERE change.source_id=source.source_id), 0) AS latest_sequence,
            policy.policy_revision,
            controls.revision AS collection_revision,
            policy.publication_state,
            controls.control_state,
            controls.publication_enabled,
            legacy_runtime.state AS v12_runtime_state,
            legacy_runtime.revision AS v12_runtime_revision,
            typed_runtime.state AS v12_typed_runtime_state,
            typed_runtime.policy_revision AS v12_typed_runtime_policy_revision,
            (SELECT count(*) FROM ${schemaName}.accountless_v12_device_authorizations account_auth
              WHERE account_auth.state='active' AND account_auth.expires_at > statement_timestamp())
              AS accountless_authorization_count,
            (SELECT min(account_auth.expires_at) FROM ${schemaName}.accountless_v12_device_authorizations account_auth
              WHERE account_auth.state='active' AND account_auth.expires_at > statement_timestamp())
              AS next_accountless_authorization_expiry
       FROM ${schemaName}.storage_source_state source
       JOIN ${schemaName}.analytics_source_cursors cursor ON cursor.source_id=source.source_id
       JOIN ${schemaName}.publication_state policy ON policy.singleton=1
       JOIN ${schemaName}.collection_controls controls ON controls.singleton=1
       JOIN ${schemaName}.telemetry_v12_runtime legacy_runtime ON legacy_runtime.id=1
       JOIN ${schemaName}.telemetry_v12_typed_runtime typed_runtime ON typed_runtime.id=1
      WHERE source.singleton=1`,
  );
  if (row.rows.length !== 1) return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE");
  const current = row.rows[0]!;
  if (current.source_id !== identity.sourceId || current.publication_state !== "ready"
      || current.control_state !== "operational" || current.publication_enabled !== true) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE");
  }
  const sourceAuthorityEpoch = safeInteger(current.source_authority_epoch);
  const analyticsAuthorityEpoch = safeInteger(current.analytics_authority_epoch);
  const sequence = safeInteger(current.analytics_sequence);
  const latestSequence = safeInteger(current.latest_sequence);
  const policyRevision = safeInteger(current.policy_revision, 1);
  const collectionRevision = safeInteger(current.collection_revision, 1);
  if (latestSequence !== sequence || sourceAuthorityEpoch !== analyticsAuthorityEpoch) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED");
  }
  return Object.freeze({
    sourceId: identity.sourceId,
    sourceNamespace: identity.sourceNamespace,
    sourceAuthorityEpoch,
    analyticsAuthorityEpoch,
    sequence,
    policyRevision,
    collectionRevision,
    telemetryV12RuntimeState: current.v12_runtime_state,
    telemetryV12RuntimeRevision: safeInteger(current.v12_runtime_revision),
    telemetryV12TypedRuntimeState: current.v12_typed_runtime_state,
    telemetryV12TypedRuntimePolicyRevision: safeInteger(current.v12_typed_runtime_policy_revision, 1),
    accountlessAuthorizationCount: safeInteger(current.accountless_authorization_count),
    nextAccountlessAuthorizationExpiry: timestamp(current.next_accountless_authorization_expiry),
  });
}

function sourcePinFromAuthority(
  authority: CapturedGraphAuthority,
  effectiveSourcePin: PostgresEffectiveSourcePin,
): PostgresCommunityGraphCohortSourcePin {
  if (authority.sourceId !== effectiveSourcePin.sourceId
      || authority.sourceNamespace !== effectiveSourcePin.sourceNamespace
      || authority.sourceAuthorityEpoch !== effectiveSourcePin.storageAuthorityEpoch
    || authority.analyticsAuthorityEpoch !== effectiveSourcePin.sourceCursorAuthorityEpoch
      || authority.sequence !== effectiveSourcePin.sourceCursorSequence) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED");
  }
  return Object.freeze({ ...authority, effectiveSourcePin });
}

/** Read one bounded page of the exact currently effective PostgreSQL graph
 * cohort. A source, transfer, policy, collection, or analytics-cursor change
 * between pages raises a closed SOURCE_CHANGED error; discard all prior pages
 * from that scan and restart from the beginning. */
export async function listPostgresCommunityGraphCohortPage(
  pool: PostgresPool,
  input: ListPostgresCommunityGraphCohortOptions = {},
): Promise<PostgresCommunityGraphCohortPage> {
  try {
    return await withPostgresRead(pool, async (client) =>
      await listPostgresCommunityGraphCohortPageOnClient(client, input), {
      operation: "postgres.community_graph.cohort_page",
      statementTimeoutMilliseconds: 15_000,
      lockTimeoutMilliseconds: 5_000,
      preserveSafeError: (error) => error instanceof PostgresCommunityGraphCohortError ? error : null,
    });
  } catch (error) {
    if (error instanceof PostgresCommunityGraphCohortError) throw error;
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE");
  }
}

/** Read a source-pinned cohort page using an already-owned client. Publishers
 * call this while holding their transaction connection so nested pages cannot
 * exhaust the pool or assemble the cohort through unrelated snapshots. */
export async function listPostgresCommunityGraphCohortPageOnClient(
  client: PostgresClient,
  input: ListPostgresCommunityGraphCohortOptions = {},
): Promise<PostgresCommunityGraphCohortPage> {
  try {
    return await listCommunityGraphCohortPageOnClient(client, input);
  } catch (error) {
    if (error instanceof PostgresCommunityGraphCohortError) throw error;
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE");
  }
}

async function listCommunityGraphCohortPageOnClient(
  client: PostgresClient,
  input: ListPostgresCommunityGraphCohortOptions,
): Promise<PostgresCommunityGraphCohortPage> {
  let identity: { readonly sourceId: string; readonly sourceNamespace: string };
  let schema: PostgresSchemaConfig;
  try {
    identity = createPostgresSourceIdentityConfig({ sourceId: input.sourceId, sourceNamespace: input.sourceNamespace });
    schema = createPostgresSchemaConfig(input.schema ?? {});
  } catch {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_INVALID");
  }
  const after = normalizeCursor(input.after, identity);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_INVALID");
  }

  const schemaName = quotePostgresIdentifier(schema.primarySchema);
  const before = await captureGraphAuthorityOnClient(client, schemaName, identity);
  const beforePin = after ? sourcePinFromAuthority(before, after.sourcePin.effectiveSourcePin) : null;
  if (after && !sameSourcePin(beforePin!, after.sourcePin)) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED");
  }
  if (before.telemetryV12RuntimeState !== "active" || before.telemetryV12TypedRuntimeState !== "active") {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE");
  }

  let effectivePage: Awaited<ReturnType<typeof listPostgresEffectiveOwners>>;
  try {
    effectivePage = await listPostgresEffectiveOwnersOnClient(client, {
      sourceId: identity.sourceId,
      sourceNamespace: identity.sourceNamespace,
      ...(after ? { after: {
        ownerDigest: after.afterOwnerDigest,
        sourcePin: after.sourcePin.effectiveSourcePin,
      } satisfies PostgresEffectiveOwnersCursor } : {}),
      limit,
      schema,
    });
  } catch (error) {
    if (error instanceof PostgresLegacyEffectiveError
        && error.code === "POSTGRES_LEGACY_EFFECTIVE_CAS_MISMATCH") {
      return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED");
    }
    if (error instanceof PostgresLegacyEffectiveError) {
      return fail(error.code === "POSTGRES_LEGACY_EFFECTIVE_INVALID"
        || error.code === "POSTGRES_LEGACY_EFFECTIVE_LIMIT"
        ? "POSTGRES_COMMUNITY_GRAPH_COHORT_INVALID" : "POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE");
    }
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE");
  }

  const sourcePinBefore = sourcePinFromAuthority(before, effectivePage.sourcePin);
  if (after && !sameSourcePin(sourcePinBefore, after.sourcePin)) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED");
  }
  // Read authority again after the owner page. This brackets the independent
  // snapshot used by the public effective-owner reader so a policy, source,
  // or collection change during the query cannot be stamped as its own pin.
  const afterAuthority = await captureGraphAuthorityOnClient(client, schemaName, identity);
  const sourcePin = sourcePinFromAuthority(afterAuthority, effectivePage.sourcePin);
  if (!sameSourcePin(sourcePinBefore, sourcePin)) {
    return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED");
  }
  const eligibleOwners = effectivePage.owners.filter((owner) => owner.hasEffective);
  const publisherInputRevisions = await readPublisherInputRevisionsOnClient(client, schemaName, eligibleOwners);
  const owners = Object.freeze(eligibleOwners.map((owner) => {
    const publisherInputRevision = publisherInputRevisions.get(owner.participantId);
    if (publisherInputRevision === undefined) return fail("POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE");
    return cohortOwner(owner, publisherInputRevision);
  }));
  const next = effectivePage.next === null ? null : Object.freeze({
    afterOwnerDigest: effectivePage.next.ownerDigest,
    sourcePin,
  });
  return Object.freeze({
    available: true,
    sourcePin,
    owners,
    scannedOwnerCount: effectivePage.owners.length,
    next,
  });
}
