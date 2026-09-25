import type { AdminCommunityModelCompositionDay } from "./admin-community-allowance";
import { StreamingMemberProofAccumulator, STREAMED_MEMBER_PROOF_ALGORITHM } from "./postgres-community-graph-proof";
import { projectAdminModelHistoryDay } from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { modelHistoryWindow } from "./model-history-window";
import { postgresCommunityGraphMemberReadbackSelect } from "./postgres-community-graph-readback-query";
import {
  createPostgresSourceIdentityConfig,
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import type {
  PostgresCommunityGraphSourceKind,
} from "./postgres-community-graph-contract";

export type {
  PostgresCommunityGraphMember,
  PostgresCommunityGraphPublicationOptions,
  PostgresCommunityGraphPublicationProgress,
  PostgresCommunityGraphSourceKind,
  PostgresCommunityGraphSourcePin,
  PostgresCommunityGraphStreamPublicationOptions,
} from "./postgres-community-graph-contract";

const MAX_PUBLICATION_BYTES = 16 * 1024;
const MEMBER_READBACK_FETCH_SIZE = 4_096;
const MEMBER_READBACK_CURSOR = "postgres_community_graph_member_readback";
const fail = () => new Error("POSTGRES_COMMUNITY_GRAPH_UNAVAILABLE");

type MemberProof = readonly [
  ownerDigest: string,
  sourceKind: PostgresCommunityGraphSourceKind,
  inputRevision: number,
  ownerRevision: number,
  authorityEpoch: number,
  inputFingerprint: string | null,
  resultSha256: string | null,
];

interface PublicationMemberReadbackRow {
  readonly owner_digest: string;
  readonly input_revision: string | number;
  readonly owner_revision: string | number;
  readonly authority_epoch: string | number;
  readonly source_kind: string | null;
  readonly input_fingerprint: string | null;
  readonly result_sha256: string | null;
  readonly owner_state: string | null;
  readonly link_state: string | null;
  readonly participant_state: string | null;
}

interface PublicationMemberReadbackScope {
  readonly sourceId: string;
  readonly day: string;
  readonly generation: string;
}

/** Read member receipts and current authority rows in bounded batches without
 * reopening the ordered index scan for every keyset page. The repeatable-read
 * transaction keeps the page checks on the same snapshot as publication gates. */
async function readPublicationMembers(
  client: PostgresClient,
  schema: string,
  scope: PublicationMemberReadbackScope,
  visit: (row: PublicationMemberReadbackRow, index: number) => Promise<boolean>,
): Promise<{ readonly complete: boolean; readonly count: number }> {
  await client.query(
    `DECLARE ${MEMBER_READBACK_CURSOR} NO SCROLL CURSOR FOR ${postgresCommunityGraphMemberReadbackSelect(
      schema,
    )}`,
    [scope.sourceId, scope.day, scope.generation],
  );
  let count = 0;
  try {
    while (true) {
      const page = await client.query<PublicationMemberReadbackRow>(
        `FETCH FORWARD ${MEMBER_READBACK_FETCH_SIZE} FROM ${MEMBER_READBACK_CURSOR}`,
      );
      if (!Array.isArray(page.rows) || page.rows.length > MEMBER_READBACK_FETCH_SIZE) throw fail();
      for (const row of page.rows) {
        const index = count;
        count += 1;
        if (row.owner_state !== "active" || row.link_state !== "active" || row.participant_state !== "active"
            || !await visit(row, index)) return { complete: false, count };
      }
      if (page.rows.length < MEMBER_READBACK_FETCH_SIZE) return { complete: true, count };
    }
  } finally {
    await client.query(`CLOSE ${MEMBER_READBACK_CURSOR}`);
  }
}

function integer(value: unknown, minimum = 0): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum) throw fail();
  return parsed;
}

function day(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
      || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw fail();
  modelHistoryWindow(value);
  return value;
}

async function hashMatches(value: string, expected: string): Promise<boolean> {
  return await sha256Hex(value) === expected;
}

/** Stream complete pinned cohort members into a PostgreSQL publication. The
 * array entrypoint remains for compatibility; larger callers should use the
 * keyset cohort entrypoint so selection itself is streamed. */
export {
  publishPostgresCommunityModelDay,
  publishPostgresCommunityModelDayStream,
  publishPostgresCommunityModelDayFromCohort,
} from "./postgres-community-graph-stream-publisher";

/** Read back a single valid model day. Ordinary newer input can remain queued
 * behind this completed snapshot; changed hard authority, a terminal event,
 * unavailable publication control, or durable invalidation withholds it. */
export async function readPostgresCommunityModelDay(
  pool: PostgresPool,
  options: {
    readonly sourceId: string;
    readonly sourceNamespace: string;
    readonly day: string;
    readonly schema?: PostgresSchemaOptions;
  },
): Promise<AdminCommunityModelCompositionDay | null> {
  const identity = createPostgresSourceIdentityConfig(options);
  const capturedDay = day(options.day);
  const primarySchema = createPostgresSchemaConfig(options.schema).primarySchema;
  const schema = quotePostgresIdentifier(primarySchema);
  return withPostgresRead(pool, async (client) => {
    const result = await client.query<{
      payload_json: string;
      payload_sha256: string;
      capture_json: string;
      cohort_digest: string;
      generation: string;
      authority_json: string;
      policy_revision: string | number;
      collection_revision: string | number;
      source_authority_epoch: string | number;
      delivery_sequence: string | number;
      latest_sequence: string | number;
      terminal_sequence: string | number;
      policy_state: string;
      current_policy_revision: string | number;
      current_collection_revision: string | number;
      control_state: string;
      publication_enabled: boolean;
      expected_members: string | number;
      capture_policy_revision: string | number;
      capture_collection_revision: string | number;
    }>(
      `SELECT publication.payload_json, publication.payload_sha256, publication.generation,
              publication.cohort_digest,
              publication.authority_json, publication.policy_revision, publication.collection_revision,
              source.authority_epoch AS source_authority_epoch,
              cursor.sequence AS delivery_sequence,
              COALESCE((SELECT max(change.sequence) FROM ${schema}.storage_ingestion_changes change
                WHERE change.source_id = source.source_id), 0) AS latest_sequence,
              COALESCE((SELECT max(change.sequence) FROM ${schema}.storage_ingestion_changes change
                 WHERE change.source_id = source.source_id
                   AND change.kind IN ('owner-withdrawn', 'owner-erased')), 0) AS terminal_sequence,
              policy.publication_state AS policy_state, policy.policy_revision AS current_policy_revision,
              controls.revision AS current_collection_revision, controls.control_state, controls.publication_enabled,
              capture.expected_members, capture.payload_json AS capture_json,
              capture.policy_revision AS capture_policy_revision,
              capture.collection_revision AS capture_collection_revision
         FROM ${schema}.analytics_publications publication
         JOIN ${schema}.storage_source_state source ON source.singleton = 1 AND source.source_id = publication.source_id
         JOIN ${schema}.analytics_source_cursors cursor ON cursor.source_id = source.source_id
         JOIN ${schema}.publication_state policy ON policy.singleton = 1
         JOIN ${schema}.collection_controls controls ON controls.singleton = 1
         JOIN ${schema}.analytics_publication_captures capture
           ON capture.source_id = publication.source_id AND capture.day = publication.day
          AND capture.metric = publication.metric AND capture.generation = publication.generation
          AND capture.cohort_digest = publication.cohort_digest
        WHERE publication.source_id = $1 AND publication.day = $2::date AND publication.metric = 'model'
          AND NOT EXISTS (SELECT 1 FROM ${schema}.analytics_publication_invalidations invalidation
            WHERE invalidation.source_id = publication.source_id AND invalidation.day = publication.day
              AND invalidation.metric = publication.metric AND invalidation.generation = publication.generation)`,
      [identity.sourceId, capturedDay],
    );
    const row = result.rows[0];
    if (!row || row.policy_state !== "ready" || row.control_state !== "operational" || row.publication_enabled !== true
        || integer(row.policy_revision, 1) !== integer(row.current_policy_revision, 1)
        || integer(row.collection_revision, 1) !== integer(row.current_collection_revision, 1)
        || new TextEncoder().encode(row.payload_json).byteLength > MAX_PUBLICATION_BYTES
        || !await hashMatches(row.payload_json, row.payload_sha256)) return null;
    let authority: unknown;
    let payload: unknown;
    let capture: unknown;
    try { authority = JSON.parse(row.authority_json); payload = JSON.parse(row.payload_json); capture = JSON.parse(row.capture_json); } catch { return null; }
    if (!authority || typeof authority !== "object" || Array.isArray(authority)
        || (authority as Record<string, unknown>).sourceId !== identity.sourceId
        || (authority as Record<string, unknown>).sourceNamespace !== identity.sourceNamespace
        || integer((authority as Record<string, unknown>).policyRevision, 1) !== integer(row.policy_revision, 1)
        || integer((authority as Record<string, unknown>).collectionRevision, 1) !== integer(row.collection_revision, 1)
        || integer((authority as Record<string, unknown>).sequence) > integer(row.latest_sequence)
        || integer((authority as Record<string, unknown>).sourceAuthorityEpoch) > integer(row.source_authority_epoch)
        || integer((authority as Record<string, unknown>).analyticsAuthorityEpoch)
          !== integer((authority as Record<string, unknown>).sourceAuthorityEpoch)
        || (integer(row.terminal_sequence) > integer(row.delivery_sequence)
          && integer((authority as Record<string, unknown>).sequence) < integer(row.terminal_sequence))
        || !capture || typeof capture !== "object" || Array.isArray(capture)) return null;
    const captureRecord = capture as Record<string, unknown>;
    if (Object.keys(captureRecord).sort().join(",") !== "authority,memberProof,schema"
        || canonicalJson(captureRecord.authority) !== canonicalJson(authority)) return null;
    if (captureRecord.schema === "postgres-community-model-capture-v1") {
      if (!Array.isArray(captureRecord.memberProof)
          || captureRecord.memberProof.length !== integer(row.expected_members)) return null;
      const memberProof: MemberProof[] = [];
      let previousDigest = "";
      for (const raw of captureRecord.memberProof) {
        if (!Array.isArray(raw) || raw.length !== 7) return null;
        const [ownerDigest, sourceKind, inputRevision, ownerRevision, authorityEpoch, fingerprint, resultHash] = raw;
        if (typeof ownerDigest !== "string" || !/^[a-f0-9]{64}$/u.test(ownerDigest) || ownerDigest <= previousDigest
            || typeof sourceKind !== "string" || !["effective", "v1.1", "v1", "mixed", "v0.2"].includes(sourceKind)
            || typeof inputRevision !== "number" || !Number.isSafeInteger(inputRevision) || inputRevision < 0
            || typeof ownerRevision !== "number" || !Number.isSafeInteger(ownerRevision) || ownerRevision < 0
            || typeof authorityEpoch !== "number" || !Number.isSafeInteger(authorityEpoch) || authorityEpoch < 0
            || fingerprint !== null && (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint))
            || resultHash !== null && (typeof resultHash !== "string" || !/^[a-f0-9]{64}$/u.test(resultHash))) return null;
        const supported = sourceKind === "effective" || sourceKind === "v1.1" || sourceKind === "v1";
        if (supported ? fingerprint === null || resultHash === null
            : fingerprint !== null || resultHash !== null) return null;
        memberProof.push([ownerDigest, sourceKind as PostgresCommunityGraphSourceKind, inputRevision,
          ownerRevision, authorityEpoch, fingerprint as string | null, resultHash as string | null]);
        previousDigest = ownerDigest;
      }
      const computedGeneration = await sha256Hex(canonicalJson([
        "postgres-community-model-day-v1", capturedDay, row.authority_json, memberProof,
      ]));
      if (computedGeneration !== row.generation || row.cohort_digest !== computedGeneration
          || integer(row.capture_policy_revision, 1) !== integer(row.policy_revision, 1)
          || integer(row.capture_collection_revision, 1) !== integer(row.collection_revision, 1)) return null;
      const memberReadback = await readPublicationMembers(client, primarySchema, {
        sourceId: identity.sourceId, day: capturedDay, generation: row.generation,
      }, async (member, index) => {
        const proof = memberProof[index];
        if (!proof) return false;
        return member.owner_digest === proof[0]
          && integer(member.input_revision) === proof[2]
          && integer(member.owner_revision) === proof[3]
          && integer(member.authority_epoch) === proof[4]
          && member.source_kind === null && member.input_fingerprint === null
          && member.result_sha256 === null;
      });
      if (!memberReadback.complete || memberReadback.count !== memberProof.length) return null;
    } else if (captureRecord.schema === "postgres-community-model-capture-v2") {
      const memberProof = captureRecord.memberProof;
      if (!memberProof || typeof memberProof !== "object" || Array.isArray(memberProof)) return null;
      const proofRecord = memberProof as Record<string, unknown>;
      if (Object.keys(proofRecord).sort().join(",") !== "algorithm,count,root"
          || proofRecord.algorithm !== STREAMED_MEMBER_PROOF_ALGORITHM
          || typeof proofRecord.root !== "string" || !/^[a-f0-9]{64}$/u.test(proofRecord.root)
          || typeof proofRecord.count !== "number" || !Number.isSafeInteger(proofRecord.count)
          || proofRecord.count !== integer(row.expected_members)) return null;
      const expectedMemberCount = proofRecord.count;
      const computedGeneration = await sha256Hex(canonicalJson([
        "postgres-community-model-day-v2", capturedDay, row.authority_json,
        STREAMED_MEMBER_PROOF_ALGORITHM, expectedMemberCount, proofRecord.root,
      ]));
      if (computedGeneration !== row.generation || row.cohort_digest !== computedGeneration
          || integer(row.capture_policy_revision, 1) !== integer(row.policy_revision, 1)
          || integer(row.capture_collection_revision, 1) !== integer(row.collection_revision, 1)) return null;
      const proof = new StreamingMemberProofAccumulator();
      let observedCount = 0;
      let previousDigest = "";
      const memberReadback = await readPublicationMembers(client, primarySchema, {
        sourceId: identity.sourceId, day: capturedDay, generation: row.generation,
      }, async (member) => {
        const ownerDigest = member.owner_digest;
        const sourceKind = member.source_kind;
        const inputRevision = integer(member.input_revision);
        const ownerRevision = integer(member.owner_revision);
        const authorityEpoch = integer(member.authority_epoch);
        if (!/^[a-f0-9]{64}$/u.test(ownerDigest) || ownerDigest <= previousDigest
            || typeof sourceKind !== "string"
            || !["effective", "v1.1", "v1", "mixed", "v0.2"].includes(sourceKind)
            || member.input_fingerprint !== null
              && (typeof member.input_fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(member.input_fingerprint))
            || member.result_sha256 !== null
              && (typeof member.result_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(member.result_sha256))) return false;
        const supported = sourceKind === "effective" || sourceKind === "v1.1" || sourceKind === "v1";
        if (supported ? member.input_fingerprint === null || member.result_sha256 === null
            : member.input_fingerprint !== null || member.result_sha256 !== null) return false;
        await proof.add([ownerDigest, sourceKind as PostgresCommunityGraphSourceKind,
          inputRevision, ownerRevision, authorityEpoch,
          member.input_fingerprint, member.result_sha256]);
        observedCount += 1;
        previousDigest = ownerDigest;
        return observedCount <= expectedMemberCount;
      });
      if (!memberReadback.complete || memberReadback.count !== expectedMemberCount
          || observedCount !== expectedMemberCount || proof.count !== observedCount
          || await proof.root() !== proofRecord.root) return null;
    } else return null;
    const projected = projectDay(payload);
    if (!projected || projected.day !== capturedDay) return null;
    return projected;
  }, { operation: "postgres.community_graph.read_model_day", isolationLevel: "repeatable_read" });
}

function projectDay(value: unknown): AdminCommunityModelCompositionDay | null {
  // The public contract validator is the same versioned projection used by
  // the D1-backed publisher and refuses unknown or partial fields.
  try { return projectAdminModelHistoryDay(value) as AdminCommunityModelCompositionDay | null; }
  catch { return null; }
}
