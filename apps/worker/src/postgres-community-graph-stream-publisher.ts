import {
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  buildCommunityModelCompositionDayFromSummary,
  normalizeCommunityModelCompositionForDay,
  type CommunityModelCompositionDaySummary,
} from "./admin-community-allowance";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { validCompleteCachedComposition, type CommunityModelComposition } from "./community-allowance";
import { modelHistoryWindow } from "./model-history-window";
import {
  createPostgresSchemaConfig,
  createPostgresSourceIdentityConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import {
  listPostgresCommunityGraphCohortPage,
  listPostgresCommunityGraphCohortPageOnClient,
  PostgresCommunityGraphCohortError,
  type PostgresCommunityGraphCohortOwner,
  type PostgresCommunityGraphCohortPage,
  type PostgresCommunityGraphCohortSourcePin,
} from "./postgres-community-graph-cohort";
import {
  StreamingMemberProofAccumulator,
  STREAMED_MEMBER_PROOF_ALGORITHM,
  type PostgresCommunityGraphMemberProof,
} from "./postgres-community-graph-proof";
import type {
  PostgresCommunityGraphMember,
  PostgresCommunityGraphPublicationOptions,
  PostgresCommunityGraphPublicationProgress,
  PostgresCommunityGraphSourceKind,
  PostgresCommunityGraphSourcePin,
  PostgresCommunityGraphStreamPublicationOptions,
} from "./postgres-community-graph-contract";
import { MODEL_HISTORY_METHOD_VERSION } from "./quota-analysis-v1";
import { V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "./quota-analysis-v11";

const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_MEMBER_INSERT_BATCH = 1_000;
const MAX_RESULT_CANDIDATE_ROWS = 512;
const MAX_RESULT_BATCH_BYTES = 1024 * 1024;
const MAX_PUBLICATION_BYTES = 16 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const fail = () => new Error("POSTGRES_COMMUNITY_GRAPH_UNAVAILABLE");

interface NormalizedMember extends PostgresCommunityGraphMember {
  readonly modelMethod: string | null;
}

interface SourceRow {
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
  readonly telemetry_v12_runtime_state: string;
  readonly telemetry_v12_runtime_revision: string | number;
  readonly telemetry_v12_typed_runtime_state: string;
  readonly telemetry_v12_typed_runtime_policy_revision: string | number;
  readonly accountless_authorization_count: string | number;
  readonly next_accountless_authorization_expiry: string | Date | null;
}

interface StreamResultRow {
  readonly owner_digest: string;
  readonly participant_id: string;
  readonly input_revision: string | number;
  readonly owner_revision: string | number;
  readonly authority_epoch: string | number;
  readonly source_kind: PostgresCommunityGraphSourceKind;
  readonly input_fingerprint: string | null;
  readonly result_owner_digest: string | null;
  readonly result_input_revision: string | number | null;
  readonly result_owner_revision: string | number | null;
  readonly result_authority_epoch: string | number | null;
  readonly public_authority_epoch: string | number | null;
  readonly source_epoch: string | number | null;
  readonly sequence: string | number | null;
  readonly method: string | null;
  readonly status: "ready" | "not_testable" | null;
  readonly reason: string | null;
  readonly payload_json: string | null;
  readonly payload_sha256: string | null;
  readonly computed_at_ms: string | number | null;
  readonly cumulative_payload_bytes: string | number;
  readonly page_ordinal: string | number;
  readonly candidate_count: string | number;
}

function integer(value: unknown, minimum = 0): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum) throw fail();
  return parsed;
}

function isSerializationFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  try {
    return Reflect.get(error, "code") === "40001";
  } catch {
    return false;
  }
}

function normalizedTimestamp(value: unknown): string | null {
  if (value === null) return null;
  const epoch = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw fail();
  return new Date(epoch).toISOString();
}

function validDay(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
      || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw fail();
  modelHistoryWindow(value);
  return value;
}

function normalizeMember(raw: unknown, allowMissingFingerprint: boolean): NormalizedMember {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
  const member = raw as PostgresCommunityGraphMember;
  if (typeof member.participantId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(member.participantId)
      || typeof member.ownerDigest !== "string" || !/^[a-f0-9]{64}$/u.test(member.ownerDigest)
      || !["effective", "v1.1", "v1", "mixed", "v0.2"].includes(member.sourceKind)) throw fail();
  const inputRevision = integer(member.inputRevision);
  const ownerRevision = integer(member.ownerRevision);
  const authorityEpoch = integer(member.authorityEpoch);
  const supported = member.sourceKind === "effective" || member.sourceKind === "v1.1" || member.sourceKind === "v1";
  const validFingerprint = typeof member.inputFingerprint === "string"
    && /^[a-f0-9]{64}$/u.test(member.inputFingerprint);
  if (supported ? !validFingerprint && !(allowMissingFingerprint && member.inputFingerprint === undefined)
    : member.inputFingerprint !== undefined) throw fail();
  return Object.freeze({
    participantId: member.participantId,
    ownerDigest: member.ownerDigest,
    inputRevision,
    ownerRevision,
    authorityEpoch,
    sourceKind: member.sourceKind,
    ...(supported && validFingerprint ? { inputFingerprint: member.inputFingerprint } : {}),
    modelMethod: member.sourceKind === "effective" || member.sourceKind === "v1.1"
      ? V11_PLAN_ATTRIBUTION_ADAPTER_VERSION
      : member.sourceKind === "v1" ? MODEL_HISTORY_METHOD_VERSION : null,
  });
}

function normalizeSourcePin(
  value: unknown,
  sourceId: string,
  sourceNamespace: string,
): PostgresCommunityGraphSourcePin {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const pin = value as PostgresCommunityGraphSourcePin;
  if (pin.sourceId !== sourceId || pin.sourceNamespace !== sourceNamespace
      || pin.telemetryV12RuntimeState !== "active" || pin.telemetryV12TypedRuntimeState !== "active") throw fail();
  return Object.freeze({
    sourceId,
    sourceNamespace,
    sourceAuthorityEpoch: integer(pin.sourceAuthorityEpoch),
    analyticsAuthorityEpoch: integer(pin.analyticsAuthorityEpoch),
    sequence: integer(pin.sequence),
    policyRevision: integer(pin.policyRevision, 1),
    collectionRevision: integer(pin.collectionRevision, 1),
    telemetryV12RuntimeState: "active",
    telemetryV12RuntimeRevision: integer(pin.telemetryV12RuntimeRevision),
    telemetryV12TypedRuntimeState: "active",
    telemetryV12TypedRuntimePolicyRevision: integer(pin.telemetryV12TypedRuntimePolicyRevision, 1),
    accountlessAuthorizationCount: integer(pin.accountlessAuthorizationCount),
    nextAccountlessAuthorizationExpiry: normalizedTimestamp(pin.nextAccountlessAuthorizationExpiry),
  });
}

function schemaName(options: PostgresSchemaOptions | undefined): string {
  return quotePostgresIdentifier(createPostgresSchemaConfig(options).primarySchema);
}

async function hashMatches(value: string, expected: string): Promise<boolean> {
  return await sha256Hex(value) === expected;
}

function sourceAuthorityMatches(value: SourceRow | undefined, pin: PostgresCommunityGraphSourcePin): {
  readonly policyRevision: number;
  readonly collectionRevision: number;
} | null {
  if (!value || value.source_id !== pin.sourceId || value.publication_state !== "ready"
      || value.control_state !== "operational" || value.publication_enabled !== true) return null;
  const sourceEpoch = integer(value.source_authority_epoch);
  const sequence = integer(value.analytics_sequence);
  const authorityEpoch = integer(value.analytics_authority_epoch);
  const latestSequence = integer(value.latest_sequence);
  const policyRevision = integer(value.policy_revision, 1);
  const collectionRevision = integer(value.collection_revision, 1);
  const runtimeRevision = integer(value.telemetry_v12_runtime_revision);
  const typedRuntimePolicyRevision = integer(value.telemetry_v12_typed_runtime_policy_revision, 1);
  const accountlessAuthorizationCount = integer(value.accountless_authorization_count);
  const nextAccountlessAuthorizationExpiry = normalizedTimestamp(value.next_accountless_authorization_expiry);
  if (sourceEpoch !== pin.sourceAuthorityEpoch || authorityEpoch !== pin.analyticsAuthorityEpoch
      || sequence !== pin.sequence || latestSequence !== sequence || authorityEpoch !== sourceEpoch
      || policyRevision !== pin.policyRevision || collectionRevision !== pin.collectionRevision
      || value.telemetry_v12_runtime_state !== pin.telemetryV12RuntimeState
      || runtimeRevision !== pin.telemetryV12RuntimeRevision
      || value.telemetry_v12_typed_runtime_state !== pin.telemetryV12TypedRuntimeState
      || typedRuntimePolicyRevision !== pin.telemetryV12TypedRuntimePolicyRevision
      || accountlessAuthorizationCount !== pin.accountlessAuthorizationCount
      || nextAccountlessAuthorizationExpiry !== pin.nextAccountlessAuthorizationExpiry) return null;
  return { policyRevision, collectionRevision };
}

function sourceKindMethod(sourceKind: PostgresCommunityGraphSourceKind): string | null {
  if (sourceKind === "effective" || sourceKind === "v1.1") return V11_PLAN_ATTRIBUTION_ADAPTER_VERSION;
  if (sourceKind === "v1") return MODEL_HISTORY_METHOD_VERSION;
  return null;
}

async function* arrayStream(members: readonly PostgresCommunityGraphMember[]): AsyncGenerator<PostgresCommunityGraphMember> {
  for (const member of members) yield member;
}

/** Compatibility entrypoint for a caller that already has its member array.
 * The publisher itself no longer imposes a cohort-row ceiling. */
export function publishPostgresCommunityModelDay(
  pool: PostgresPool,
  options: PostgresCommunityGraphPublicationOptions,
): Promise<PostgresCommunityGraphPublicationProgress> {
  if (!Array.isArray(options.members)) throw fail();
  return publishPostgresCommunityModelDayStream(pool, {
    sourcePin: options.sourcePin,
    members: arrayStream(options.members),
    day: options.day,
    nowMs: options.nowMs,
    schema: options.schema,
  }).then((result) => result.state === "deferred" && result.memberCount === 0 && options.members.length > 0
    ? { ...result, memberCount: options.members.length }
    : result);
}

/** Read the authoritative effective cohort through its bounded keyset pager
 * and publish it in one source-pinned transaction. Per-owner model results are
 * consumed from the previously completed analytics cache. */
export async function publishPostgresCommunityModelDayFromCohort(
  pool: PostgresPool,
  options: {
    readonly sourceId?: unknown;
    readonly sourceNamespace?: unknown;
    readonly day: string;
    readonly nowMs?: number;
    readonly limit?: number;
    readonly schema?: PostgresSchemaOptions;
  },
): Promise<PostgresCommunityGraphPublicationProgress> {
  const schemaConfig = createPostgresSchemaConfig(options.schema ?? {});
  const first = await listPostgresCommunityGraphCohortPage(pool, {
    sourceId: options.sourceId,
    sourceNamespace: options.sourceNamespace,
    limit: options.limit,
    schema: schemaConfig,
  });
  const identity = createPostgresSourceIdentityConfig({
    sourceId: first.sourcePin.sourceId,
    sourceNamespace: first.sourcePin.sourceNamespace,
  });
  async function* membersFromClient(client: import("./postgres-client").PostgresClient): AsyncGenerator<PostgresCommunityGraphMember> {
    let page: PostgresCommunityGraphCohortPage = await listPostgresCommunityGraphCohortPageOnClient(client, {
      ...identity,
      limit: options.limit,
      schema: schemaConfig,
    });
    if (canonicalJson(page.sourcePin) !== canonicalJson(first.sourcePin)) {
      throw new PostgresCommunityGraphCohortError("POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED");
    }
    let cursorDigest = "";
    let lastOwnerDigest = "";
    while (true) {
      if (canonicalJson(page.sourcePin) !== canonicalJson(first.sourcePin)) {
        throw new PostgresCommunityGraphCohortError("POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED");
      }
      for (const owner of page.owners) {
        if (owner.ownerDigest <= lastOwnerDigest) {
          throw new PostgresCommunityGraphCohortError("POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED");
        }
        lastOwnerDigest = owner.ownerDigest;
        yield memberFromCohortOwner(owner);
      }
      if (page.next === null) return;
      if (page.next.afterOwnerDigest <= cursorDigest || page.next.afterOwnerDigest < lastOwnerDigest) {
        throw new PostgresCommunityGraphCohortError("POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED");
      }
      cursorDigest = page.next.afterOwnerDigest;
      page = await listPostgresCommunityGraphCohortPageOnClient(client, {
        ...identity,
        after: page.next,
        limit: options.limit,
        schema: schemaConfig,
      });
    }
  }
  return await publishPostgresCommunityModelDayStreamWithClientMembers(pool, {
    sourcePin: first.sourcePin,
    day: options.day,
    nowMs: options.nowMs,
    schema: options.schema,
    fingerprintFromResult: true,
  }, membersFromClient);
}

function memberFromCohortOwner(owner: PostgresCommunityGraphCohortOwner): PostgresCommunityGraphMember {
  return {
    participantId: owner.participantId,
    ownerDigest: owner.ownerDigest,
    inputRevision: owner.inputRevision,
    ownerRevision: owner.ownerRevision,
    authorityEpoch: owner.authorityEpoch,
    sourceKind: owner.sourceKind,
  };
}

/** Publish an async stream without collecting its members or result cache in
 * application memory. The transaction stages member metadata in a temporary
 * table, locks owners in erasure-safe order, pages result JSON by key and byte
 * budget, and delegates exact medians to PostgreSQL's ordered-set aggregate. */
export async function publishPostgresCommunityModelDayStream(
  pool: PostgresPool,
  options: PostgresCommunityGraphStreamPublicationOptions,
): Promise<PostgresCommunityGraphPublicationProgress> {
  if (!options.members || typeof options.members[Symbol.asyncIterator] !== "function") throw fail();
  return await publishPostgresCommunityModelDayStreamWithClientMembers(
    pool,
    options,
    () => options.members,
  );
}

async function publishPostgresCommunityModelDayStreamWithClientMembers(
  pool: PostgresPool,
  options: Omit<PostgresCommunityGraphStreamPublicationOptions, "members">,
  getMembers: (client: import("./postgres-client").PostgresClient) => AsyncIterable<PostgresCommunityGraphMember>,
): Promise<PostgresCommunityGraphPublicationProgress> {
  const identity = createPostgresSourceIdentityConfig({
    sourceId: options.sourcePin?.sourceId,
    sourceNamespace: options.sourcePin?.sourceNamespace,
  });
  const capturedPin = normalizeSourcePin(options.sourcePin, identity.sourceId, identity.sourceNamespace);
  const capturedDay = validDay(options.day);
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || typeof getMembers !== "function") throw fail();
  const schema = schemaName(options.schema);
  let memberCount = 0;

  let outcome: PostgresCommunityGraphPublicationProgress;
  try {
    outcome = await withPostgresMutation(pool, async (client) => {
      const authorityResult = await client.query<SourceRow>(
        `SELECT source.source_id,
                source.authority_epoch AS source_authority_epoch,
                cursor.sequence AS analytics_sequence,
                cursor.authority_epoch AS analytics_authority_epoch,
                COALESCE((SELECT max(change.sequence) FROM ${schema}.storage_ingestion_changes change
                           WHERE change.source_id = source.source_id), 0) AS latest_sequence,
                policy.policy_revision,
                controls.revision AS collection_revision,
                policy.publication_state,
                controls.control_state,
                controls.publication_enabled,
                telemetry_v12_runtime.state AS telemetry_v12_runtime_state,
                telemetry_v12_runtime.revision AS telemetry_v12_runtime_revision,
                telemetry_v12_typed_runtime.state AS telemetry_v12_typed_runtime_state,
                telemetry_v12_typed_runtime.policy_revision AS telemetry_v12_typed_runtime_policy_revision,
                (SELECT count(*) FROM ${schema}.accountless_v12_device_authorizations account_auth
                  WHERE account_auth.state='active' AND account_auth.expires_at > statement_timestamp())
                  AS accountless_authorization_count,
                (SELECT min(account_auth.expires_at) FROM ${schema}.accountless_v12_device_authorizations account_auth
                  WHERE account_auth.state='active' AND account_auth.expires_at > statement_timestamp())
                  AS next_accountless_authorization_expiry
           FROM ${schema}.storage_source_state source
           JOIN ${schema}.analytics_source_cursors cursor ON cursor.source_id = source.source_id
           JOIN ${schema}.publication_state policy ON policy.singleton = 1
           JOIN ${schema}.collection_controls controls ON controls.singleton = 1
           JOIN ${schema}.telemetry_v12_runtime telemetry_v12_runtime ON telemetry_v12_runtime.id=1
           JOIN ${schema}.telemetry_v12_typed_runtime telemetry_v12_typed_runtime ON telemetry_v12_typed_runtime.id=1
          WHERE source.singleton = 1
          FOR SHARE OF source, cursor, policy, controls, telemetry_v12_runtime, telemetry_v12_typed_runtime`,
      );
      const authority = sourceAuthorityMatches(authorityResult.rows[0], capturedPin);
      if (!authority) return { state: "deferred" as const, reason: "source_changed" as const, memberCount };

      await client.query(`CREATE TEMP TABLE pg_community_graph_members (
        owner_digest text PRIMARY KEY CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
        participant_id text NOT NULL UNIQUE,
        input_revision bigint NOT NULL,
        owner_revision bigint NOT NULL,
        authority_epoch bigint NOT NULL,
        source_kind text NOT NULL,
        model_method text,
        input_fingerprint text,
        result_sha256 text
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE pg_community_graph_capacities (
        owner_digest text NOT NULL,
        model_id text NOT NULL,
        capacity double precision NOT NULL,
        PRIMARY KEY(owner_digest, model_id)
      ) ON COMMIT DROP`);

      let previousDigest = "";
      let staged: NormalizedMember[] = [];
      const flushMembers = async () => {
        if (staged.length === 0) return;
        await client.query(
          `INSERT INTO pg_temp.pg_community_graph_members
            (owner_digest, participant_id, input_revision, owner_revision, authority_epoch,
             source_kind, model_method, input_fingerprint)
           SELECT member.owner_digest, member.participant_id, member.input_revision,
                  member.owner_revision, member.authority_epoch, member.source_kind,
                  member.model_method, member.input_fingerprint
             FROM unnest($1::text[], $2::text[], $3::bigint[], $4::bigint[], $5::bigint[],
                         $6::text[], $7::text[], $8::text[])
                  AS member(owner_digest, participant_id, input_revision, owner_revision,
                            authority_epoch, source_kind, model_method, input_fingerprint)`,
          [
            staged.map((member) => member.ownerDigest),
            staged.map((member) => member.participantId),
            staged.map((member) => member.inputRevision),
            staged.map((member) => member.ownerRevision),
            staged.map((member) => member.authorityEpoch),
            staged.map((member) => member.sourceKind),
            staged.map((member) => member.modelMethod),
            staged.map((member) => member.inputFingerprint ?? null),
          ],
        );
        memberCount += staged.length;
        staged = [];
      };
      try {
        const members = getMembers(client);
        if (!members || typeof members[Symbol.asyncIterator] !== "function") throw fail();
        for await (const raw of members) {
          const member = normalizeMember(raw, options.fingerprintFromResult === true);
          if (member.ownerDigest <= previousDigest) throw fail();
          previousDigest = member.ownerDigest;
          staged.push(member);
          if (staged.length >= MAX_MEMBER_INSERT_BATCH) await flushMembers();
        }
        await flushMembers();
      } catch (error) {
        if (error instanceof PostgresCommunityGraphCohortError
            && error.code === "POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED") {
          return { state: "deferred" as const, reason: "source_changed" as const, memberCount };
        }
        throw error;
      }

      // Lock participant rows in the same global order as owner erasure, then
      // lock links, owner state, and cache revisions by digest. The temporary
      // table keeps all locks server-side without a JavaScript ID vector.
      const participantLocks = await client.query<{ count: string | number }>(
        `WITH locked AS MATERIALIZED (
           SELECT participant.id
             FROM ${schema}.participants participant
             JOIN pg_temp.pg_community_graph_members member ON member.participant_id=participant.id
            ORDER BY participant.id
            FOR SHARE OF participant
         ) SELECT count(*) AS count FROM locked`,
      );
      if (integer(participantLocks.rows[0]?.count) !== memberCount) {
        return { state: "deferred" as const, reason: "source_changed" as const, memberCount };
      }
      const ownerLocks = await client.query<{ count: string | number; mismatches: string | number }>(
        `WITH locked AS MATERIALIZED (
           SELECT member.owner_digest, member.participant_id,
                  member.input_revision AS expected_input_revision,
                  member.owner_revision AS expected_owner_revision,
                  member.authority_epoch AS expected_authority_epoch,
                  link.participant_id AS linked_participant_id, link.state AS link_state,
                  owner.revision AS actual_owner_revision, owner.authority_epoch AS actual_authority_epoch,
                  owner.state AS owner_state, input.revision AS actual_input_revision
             FROM pg_temp.pg_community_graph_members member
             JOIN ${schema}.storage_v11_owner_links link ON link.owner_digest=member.owner_digest
             JOIN ${schema}.analytics_owner_state owner
               ON owner.source_id=$1 AND owner.owner_digest=member.owner_digest
             JOIN ${schema}.input_versions input ON input.participant_id=member.participant_id
            ORDER BY member.owner_digest COLLATE "C"
            FOR SHARE OF link, owner, input
         )
         SELECT count(*) AS count,
                count(*) FILTER (WHERE linked_participant_id IS DISTINCT FROM participant_id
                  OR link_state IS DISTINCT FROM 'active' OR owner_state IS DISTINCT FROM 'active'
                  OR actual_input_revision IS DISTINCT FROM expected_input_revision
                  OR actual_owner_revision IS DISTINCT FROM expected_owner_revision
                  OR actual_authority_epoch IS DISTINCT FROM expected_authority_epoch) AS mismatches
           FROM locked`,
        [capturedPin.sourceId],
      );
      if (integer(ownerLocks.rows[0]?.count) !== memberCount
          || integer(ownerLocks.rows[0]?.mismatches) !== 0) {
        return { state: "deferred" as const, reason: "source_changed" as const, memberCount };
      }
      const terminal = await client.query<{ count: string | number }>(
        `SELECT count(*) AS count FROM pg_temp.pg_community_graph_members member
          WHERE EXISTS (SELECT 1 FROM ${schema}.storage_ingestion_changes change
            WHERE change.source_id=$1 AND change.owner_digest=member.owner_digest
              AND change.kind IN ('owner-withdrawn','owner-erased'))`,
        [capturedPin.sourceId],
      );
      if (integer(terminal.rows[0]?.count) !== 0) {
        return { state: "deferred" as const, reason: "source_changed" as const, memberCount };
      }

      const proof = new StreamingMemberProofAccumulator();
      const primaryModelIds = new Set<string>(ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG
        .filter((model) => model.allowanceTrack === "primary").map((model) => model.modelId));
      const proofUpdates: Array<{ ownerDigest: string; fingerprint: string; resultHash: string }> = [];
      const capacityRows: Array<{ ownerDigest: string; modelId: string; capacity: number }> = [];
      const counters = {
        supportedParticipantCount: 0,
        refusedParticipantCount: 0,
        fittedParticipantCount: 0,
        unstableParticipantCount: 0,
        staleParticipantCount: 0,
      };
      let resultCursor = "";
      while (true) {
        const results = await client.query<StreamResultRow>(
          `WITH member_page AS MATERIALIZED (
             SELECT member.owner_digest, member.participant_id, member.input_revision,
                    member.owner_revision, member.authority_epoch, member.source_kind,
                    member.input_fingerprint, member.model_method
               FROM pg_temp.pg_community_graph_members member
              WHERE member.owner_digest COLLATE "C" > $4::text COLLATE "C"
              ORDER BY member.owner_digest COLLATE "C"
              LIMIT $5
           ), candidates AS MATERIALIZED (
             SELECT member.owner_digest, member.participant_id, member.input_revision,
                    member.owner_revision, member.authority_epoch, member.source_kind,
                    member.input_fingerprint,
                    result.owner_digest AS result_owner_digest,
                    result.input_revision AS result_input_revision,
                    result.owner_revision AS result_owner_revision,
                    result.authority_epoch AS result_authority_epoch,
                    result.public_authority_epoch, result.source_epoch, result.sequence,
                    result.method, result.status, result.reason, result.payload_json,
                    result.payload_sha256, result.computed_at_ms,
                    COALESCE(octet_length(result.payload_json),0) AS result_payload_bytes
               FROM member_page member
               LEFT JOIN LATERAL (
                 SELECT result.owner_digest, result.input_revision, result.owner_revision,
                        result.authority_epoch, result.public_authority_epoch, result.source_epoch,
                        result.sequence, result.method, result.status, result.reason,
                        result.payload_json, result.payload_sha256, result.computed_at_ms
                   FROM ${schema}.analytics_owner_results result
                  WHERE member.model_method IS NOT NULL AND result.source_id=$1
                    AND result.source_namespace=$2 AND result.observed_day=$3::date
                    AND result.metric='model' AND result.owner_digest=member.owner_digest
                  FOR SHARE OF result
               ) result ON true
              ORDER BY member.owner_digest COLLATE "C"
           ), sized AS MATERIALIZED (
             SELECT candidates.*,
                    sum(result_payload_bytes) OVER (ORDER BY owner_digest COLLATE "C") AS cumulative_payload_bytes,
                    row_number() OVER (ORDER BY owner_digest COLLATE "C") AS page_ordinal,
                    count(*) OVER () AS candidate_count
               FROM candidates
           )
           SELECT owner_digest, participant_id, input_revision, owner_revision, authority_epoch,
                  source_kind, input_fingerprint, result_owner_digest, result_input_revision,
                  result_owner_revision, result_authority_epoch, public_authority_epoch, source_epoch,
                  sequence, method, status, reason, payload_json, payload_sha256, computed_at_ms,
                  cumulative_payload_bytes, page_ordinal, candidate_count
             FROM sized
            WHERE cumulative_payload_bytes <= $6 OR page_ordinal=1
            ORDER BY owner_digest COLLATE "C"`,
          [capturedPin.sourceId, capturedPin.sourceNamespace, capturedDay, resultCursor,
            MAX_RESULT_CANDIDATE_ROWS + 1, MAX_RESULT_BATCH_BYTES],
        );
        if (results.rows.length === 0) break;
        for (const row of results.rows) {
          const sourceKind = row.source_kind;
          const modelMethod = sourceKindMethod(sourceKind);
          let fingerprint: string | null = null;
          let resultHash: string | null = null;
          if (modelMethod !== null) {
            counters.supportedParticipantCount += 1;
            if (row.result_owner_digest === null || row.payload_json === null || row.payload_sha256 === null
                || row.result_input_revision === null || row.result_owner_revision === null
                || row.result_authority_epoch === null || row.public_authority_epoch === null
                || row.source_epoch === null || row.sequence === null || row.method === null
                || row.status === null || row.computed_at_ms === null) {
              return { state: "deferred" as const, reason: "cache_pending" as const, memberCount };
            }
            if (row.result_owner_digest !== row.owner_digest
                || integer(row.result_input_revision) !== integer(row.input_revision)
                || integer(row.result_owner_revision) !== integer(row.owner_revision)
                || integer(row.result_authority_epoch) !== integer(row.authority_epoch)
                || integer(row.public_authority_epoch) > capturedPin.analyticsAuthorityEpoch
                || integer(row.source_epoch) > capturedPin.analyticsAuthorityEpoch
                || integer(row.sequence) > capturedPin.sequence || row.method !== modelMethod) {
              return { state: "deferred" as const, reason: "cache_pending" as const, memberCount };
            }
            const resultBytes = new TextEncoder().encode(row.payload_json).byteLength;
            if (resultBytes > MAX_RESULT_BYTES) {
              return { state: "deferred" as const, reason: "capacity" as const, memberCount };
            }
            if (!await hashMatches(row.payload_json, row.payload_sha256)) throw fail();
            let parsed: unknown;
            try { parsed = JSON.parse(row.payload_json); } catch { throw fail(); }
            const parsedRecord = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
              ? parsed as Record<string, unknown> : null;
            const candidateFingerprint = row.input_fingerprint
              ?? (options.fingerprintFromResult ? parsedRecord?.inputFingerprint : undefined);
            if (typeof candidateFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(candidateFingerprint)
                || row.input_fingerprint !== null && row.input_fingerprint !== candidateFingerprint
                || !validCompleteCachedComposition(parsed, candidateFingerprint, modelMethod)) throw fail();
            fingerprint = candidateFingerprint;
            resultHash = row.payload_sha256;
            if (row.status !== parsedRecord!.status
                || (parsedRecord!.status === "not_testable" && row.reason !== parsedRecord!.reason)
                || (parsedRecord!.status === "ready" && row.reason !== null)
                || integer(row.computed_at_ms) > nowMs + MAX_FUTURE_SKEW_MS) throw fail();
            if (parsedRecord!.status === "not_testable") {
              counters.refusedParticipantCount += 1;
            } else {
              const composition = parsed as CommunityModelComposition["composition"];
              if (Date.parse(composition.latestQuotaObservedAt)
                  >= Date.parse(modelHistoryWindow(capturedDay).observedAtBefore)) throw fail();
              const normalized = normalizeCommunityModelCompositionForDay(composition, capturedDay);
              if (normalized.state === "stale") counters.staleParticipantCount += 1;
              else if (normalized.state === "unstable") counters.unstableParticipantCount += 1;
              else {
                counters.fittedParticipantCount += 1;
                for (const [modelId, capacity] of Object.entries(normalized.values)) {
                  if (primaryModelIds.has(modelId) && Number.isFinite(capacity) && capacity > 0) {
                    capacityRows.push({ ownerDigest: row.owner_digest, modelId, capacity });
                  }
                }
              }
            }
            proofUpdates.push({ ownerDigest: row.owner_digest, fingerprint, resultHash });
          }
          const proofTuple: PostgresCommunityGraphMemberProof = [
            row.owner_digest,
            sourceKind,
            integer(row.input_revision),
            integer(row.owner_revision),
            integer(row.authority_epoch),
            fingerprint,
            resultHash,
          ];
          await proof.add(proofTuple);
          resultCursor = row.owner_digest;
        }
        if (proofUpdates.length > 0) {
          await client.query(
            `UPDATE pg_temp.pg_community_graph_members member
                SET input_fingerprint = proof.input_fingerprint,
                    result_sha256 = proof.result_sha256
               FROM unnest($1::text[], $2::text[], $3::text[])
                    AS proof(owner_digest, input_fingerprint, result_sha256)
              WHERE member.owner_digest=proof.owner_digest`,
            [proofUpdates.map((item) => item.ownerDigest),
              proofUpdates.map((item) => item.fingerprint), proofUpdates.map((item) => item.resultHash)],
          );
          proofUpdates.length = 0;
        }
        if (capacityRows.length > 0) {
          await client.query(
            `INSERT INTO pg_temp.pg_community_graph_capacities(owner_digest, model_id, capacity)
             SELECT capacity.owner_digest, capacity.model_id, capacity.value
               FROM unnest($1::text[], $2::text[], $3::float8[])
                    AS capacity(owner_digest, model_id, value)`,
            [capacityRows.map((item) => item.ownerDigest), capacityRows.map((item) => item.modelId),
              capacityRows.map((item) => item.capacity)],
          );
          capacityRows.length = 0;
        }
        const candidatesInPage = integer(results.rows[0]?.candidate_count);
        if (candidatesInPage <= results.rows.length && results.rows.length <= MAX_RESULT_CANDIDATE_ROWS) break;
      }

      // A supported result must have been visited exactly once. The keyset query
      // includes unsupported rows too, so this count detects accidental gaps.
      const stagedCount = await client.query<{ count: string | number }>(
        "SELECT count(*) AS count FROM pg_temp.pg_community_graph_members",
      );
      if (integer(stagedCount.rows[0]?.count) !== memberCount || proof.count !== memberCount) throw fail();

      const capacityAggregates = await client.query<{
        model_id: string; median: string | number; participant_count: string | number;
      }>(
        `SELECT model_id,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY capacity) AS median,
                count(*) AS participant_count
           FROM pg_temp.pg_community_graph_capacities
          GROUP BY model_id`,
      );
      const mediansByModel = new Map(capacityAggregates.rows.map((row) => [row.model_id, {
        median: Number(row.median), participantCount: integer(row.participant_count, 1),
      }]));
      const summary: CommunityModelCompositionDaySummary = {
        mediansByModel,
        fittedParticipantCount: counters.fittedParticipantCount,
        unstableParticipantCount: counters.unstableParticipantCount,
        staleParticipantCount: counters.staleParticipantCount,
        refusedParticipantCount: counters.refusedParticipantCount,
        v1ParticipantCount: counters.supportedParticipantCount,
        unsupportedSourceParticipantCount: memberCount - counters.supportedParticipantCount,
      };
      const payload = buildCommunityModelCompositionDayFromSummary(summary, capturedDay);
      const payloadJson = canonicalJson(payload);
      if (new TextEncoder().encode(payloadJson).byteLength > MAX_PUBLICATION_BYTES) {
        return { state: "deferred" as const, reason: "capacity" as const, memberCount };
      }
      const payloadSha256 = await sha256Hex(payloadJson);
      const memberProofRoot = await proof.root();
      const authorityJson = canonicalJson({
        schema: "postgres-community-model-authority-v1",
        sourceId: capturedPin.sourceId,
        sourceNamespace: capturedPin.sourceNamespace,
        sourceAuthorityEpoch: capturedPin.sourceAuthorityEpoch,
        analyticsAuthorityEpoch: capturedPin.analyticsAuthorityEpoch,
        sequence: capturedPin.sequence,
        policyRevision: authority.policyRevision,
        collectionRevision: authority.collectionRevision,
      });
      const cohortDigest = await sha256Hex(canonicalJson([
        "postgres-community-model-day-v2",
        capturedDay,
        authorityJson,
        STREAMED_MEMBER_PROOF_ALGORITHM,
        memberCount,
        memberProofRoot,
      ]));
      const generation = cohortDigest;
      const captureJson = canonicalJson({
        schema: "postgres-community-model-capture-v2",
        authority: JSON.parse(authorityJson),
        memberProof: {
          algorithm: STREAMED_MEMBER_PROOF_ALGORITHM,
          count: memberCount,
          root: memberProofRoot,
        },
      });
      const existingInvalidation = await client.query(
        `SELECT 1 FROM ${schema}.analytics_publication_invalidations
          WHERE source_id = $1 AND day = $2::date AND metric = 'model' AND generation = $3 LIMIT 1`,
        [capturedPin.sourceId, capturedDay, generation],
      );
      if (existingInvalidation.rows.length > 0) {
        return { state: "deferred" as const, reason: "source_changed" as const, memberCount };
      }
      const previous = await client.query<{ cohort_digest: string; payload_sha256: string; payload_json: string }>(
        `SELECT cohort_digest, payload_sha256, payload_json
           FROM ${schema}.analytics_publications
          WHERE source_id = $1 AND day = $2::date AND metric = 'model'`,
        [capturedPin.sourceId, capturedDay],
      );
      const current = previous.rows[0];
      if (current?.cohort_digest === cohortDigest && current.payload_sha256 === payloadSha256
          && current.payload_json === payloadJson && await hashMatches(current.payload_json, current.payload_sha256)) {
        const capture = await client.query<{
          cohort_digest: string; expected_members: string | number; payload_json: string;
          policy_revision: string | number; collection_revision: string | number;
        }>(
          `SELECT cohort_digest, expected_members, payload_json, policy_revision, collection_revision
             FROM ${schema}.analytics_publication_captures
            WHERE source_id = $1 AND day = $2::date AND metric = 'model' AND generation = $3`,
          [capturedPin.sourceId, capturedDay, generation],
        );
        const storedCapture = capture.rows[0];
        if (!storedCapture || storedCapture.cohort_digest !== cohortDigest
            || integer(storedCapture.expected_members) !== memberCount
            || storedCapture.payload_json !== captureJson
            || integer(storedCapture.policy_revision, 1) !== authority.policyRevision
            || integer(storedCapture.collection_revision, 1) !== authority.collectionRevision) throw fail();
        const membership = await memberReceipt(client, schema, capturedPin.sourceId, capturedDay, generation, memberCount);
        if (!membership) throw fail();
        return { state: "unchanged" as const, generation, memberCount };
      }

      await client.query(
        `INSERT INTO ${schema}.analytics_publication_captures
          (source_id, day, metric, generation, cohort_digest, expected_members, payload_json,
           policy_revision, collection_revision)
         VALUES ($1, $2::date, 'model', $3, $4, $5, $6, $7, $8)
         ON CONFLICT (source_id, day, metric, generation) DO NOTHING`,
        [capturedPin.sourceId, capturedDay, generation, cohortDigest, memberCount, captureJson,
          authority.policyRevision, authority.collectionRevision],
      );
      const captureReceipt = await client.query<{
        cohort_digest: string; expected_members: string | number; payload_json: string;
        policy_revision: string | number; collection_revision: string | number;
      }>(
        `SELECT cohort_digest, expected_members, payload_json, policy_revision, collection_revision
           FROM ${schema}.analytics_publication_captures
          WHERE source_id = $1 AND day = $2::date AND metric = 'model' AND generation = $3`,
        [capturedPin.sourceId, capturedDay, generation],
      );
      const storedCapture = captureReceipt.rows[0];
      if (!storedCapture || storedCapture.cohort_digest !== cohortDigest
          || integer(storedCapture.expected_members) !== memberCount
          || storedCapture.payload_json !== captureJson
          || integer(storedCapture.policy_revision, 1) !== authority.policyRevision
          || integer(storedCapture.collection_revision, 1) !== authority.collectionRevision) throw fail();
      await client.query(
        `INSERT INTO ${schema}.analytics_publication_owner_members
          (source_id, day, metric, generation, owner_digest, input_revision, owner_revision,
           authority_epoch, source_kind, input_fingerprint, result_sha256)
         SELECT $1, $2::date, 'model', $3, member.owner_digest, member.input_revision,
                member.owner_revision, member.authority_epoch, member.source_kind,
                member.input_fingerprint, member.result_sha256
           FROM pg_temp.pg_community_graph_members member
         ON CONFLICT (source_id, day, metric, generation, owner_digest) DO NOTHING`,
        [capturedPin.sourceId, capturedDay, generation],
      );
      if (!await memberReceipt(client, schema, capturedPin.sourceId, capturedDay, generation, memberCount)) throw fail();

      if (capturedPin.nextAccountlessAuthorizationExpiry !== null) {
        const clock = await client.query<{ current_time: Date | string }>(
          "SELECT clock_timestamp() AS current_time",
        );
        const currentTime = clock.rows[0]?.current_time;
        const currentEpoch = currentTime instanceof Date ? currentTime.getTime()
          : typeof currentTime === "string" ? Date.parse(currentTime) : NaN;
        if (!Number.isSafeInteger(currentEpoch)
            || currentEpoch >= Date.parse(capturedPin.nextAccountlessAuthorizationExpiry)) {
          return { state: "deferred" as const, reason: "source_changed" as const, memberCount };
        }
      }
      await client.query(
        `INSERT INTO ${schema}.analytics_publications AS existing
          (source_id, day, metric, generation, cohort_digest, authority_json, payload_json,
           payload_sha256, computed_at_ms, policy_revision, collection_revision)
         VALUES ($1, $2::date, 'model', $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (source_id, day, metric) DO UPDATE SET
           generation = EXCLUDED.generation,
           cohort_digest = EXCLUDED.cohort_digest,
           authority_json = EXCLUDED.authority_json,
           payload_json = EXCLUDED.payload_json,
           payload_sha256 = EXCLUDED.payload_sha256,
           computed_at_ms = EXCLUDED.computed_at_ms,
           policy_revision = EXCLUDED.policy_revision,
           collection_revision = EXCLUDED.collection_revision
         WHERE existing.generation IS DISTINCT FROM EXCLUDED.generation`,
        [capturedPin.sourceId, capturedDay, generation, cohortDigest, authorityJson, payloadJson,
          payloadSha256, nowMs, authority.policyRevision, authority.collectionRevision],
      );
      const receipt = await client.query<{ generation: string; cohort_digest: string; payload_json: string; payload_sha256: string }>(
        `SELECT generation, cohort_digest, payload_json, payload_sha256
           FROM ${schema}.analytics_publications
          WHERE source_id = $1 AND day = $2::date AND metric = 'model'`,
        [capturedPin.sourceId, capturedDay],
      );
      const stored = receipt.rows[0];
      if (stored?.generation !== generation || stored.cohort_digest !== cohortDigest
          || stored.payload_json !== payloadJson || stored.payload_sha256 !== payloadSha256
          || !await hashMatches(stored.payload_json, stored.payload_sha256)) throw fail();
      const invalidated = await client.query(
        `SELECT 1 FROM ${schema}.analytics_publication_invalidations
          WHERE source_id = $1 AND day = $2::date AND metric = 'model' AND generation = $3 LIMIT 1`,
        [capturedPin.sourceId, capturedDay, generation],
      );
      if (invalidated.rows.length > 0) {
        return { state: "deferred" as const, reason: "source_changed" as const, memberCount };
      }
      return { state: "published" as const, generation, memberCount };
    }, {
      operation: "postgres.community_graph.publish_model_day",
      isolationLevel: "repeatable_read",
      preserveSafeError: (error) => {
        if (error instanceof PostgresCommunityGraphCohortError) return error;
        return isSerializationFailure(error)
          ? new PostgresCommunityGraphCohortError("POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED")
          : null;
      },
    });
  } catch (error) {
    // Repeatable-read cannot continue after a concurrent authority/owner write
    // invalidates the snapshot. Treat SQLSTATE 40001 as the same fail-closed
    // source-change outcome returned by an explicit pin comparison.
    if (error instanceof PostgresCommunityGraphCohortError
        && error.code === "POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED") {
      return { state: "deferred", reason: "source_changed", memberCount };
    }
    throw error;
  }
  return outcome;
}

async function memberReceipt(
  client: import("./postgres-client").PostgresClient,
  schema: string,
  sourceId: string,
  capturedDay: string,
  generation: string,
  expectedCount: number,
): Promise<boolean> {
  const result = await client.query<{ stored_count: string | number; mismatch_count: string | number }>(
    `WITH stored AS MATERIALIZED (
       SELECT owner_digest, input_revision, owner_revision, authority_epoch,
              source_kind, input_fingerprint, result_sha256
         FROM ${schema}.analytics_publication_owner_members
        WHERE source_id=$1 AND day=$2::date AND metric='model' AND generation=$3
     ), compared AS MATERIALIZED (
       SELECT stored.owner_digest AS stored_digest, candidate.owner_digest AS candidate_digest,
              stored.input_revision, candidate.input_revision AS candidate_input_revision,
              stored.owner_revision, candidate.owner_revision AS candidate_owner_revision,
              stored.authority_epoch, candidate.authority_epoch AS candidate_authority_epoch,
              stored.source_kind, candidate.source_kind AS candidate_source_kind,
              stored.input_fingerprint, candidate.input_fingerprint AS candidate_input_fingerprint,
              stored.result_sha256, candidate.result_sha256 AS candidate_result_sha256
         FROM stored FULL JOIN pg_temp.pg_community_graph_members candidate
           ON candidate.owner_digest=stored.owner_digest
     )
     SELECT count(*) FILTER (WHERE stored_digest IS NOT NULL) AS stored_count,
            count(*) FILTER (WHERE stored_digest IS DISTINCT FROM candidate_digest
              OR input_revision IS DISTINCT FROM candidate_input_revision
              OR owner_revision IS DISTINCT FROM candidate_owner_revision
              OR authority_epoch IS DISTINCT FROM candidate_authority_epoch
              OR source_kind IS DISTINCT FROM candidate_source_kind
              OR input_fingerprint IS DISTINCT FROM candidate_input_fingerprint
              OR result_sha256 IS DISTINCT FROM candidate_result_sha256) AS mismatch_count
       FROM compared`,
    [sourceId, capturedDay, generation],
  );
  return integer(result.rows[0]?.stored_count) === expectedCount
    && integer(result.rows[0]?.mismatch_count) === 0;
}
