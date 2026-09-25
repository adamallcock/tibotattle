import {
  buildCommunityModelCompositionDay,
  type AdminCommunityModelCompositionDay,
} from "./admin-community-allowance";
import { projectAdminModelHistoryDay } from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { validCompleteCachedComposition, type CommunityModelComposition } from "./community-allowance";
import { modelHistoryWindow } from "./model-history-window";
import {
  createPostgresSourceIdentityConfig,
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import { V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "./quota-analysis-v11";
import { MODEL_HISTORY_METHOD_VERSION } from "./quota-analysis-v1";

const MAX_MEMBERS = 1_024;
const MAX_COHORT_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_TOTAL_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_PUBLICATION_BYTES = 16 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const fail = () => new Error("POSTGRES_COMMUNITY_GRAPH_UNAVAILABLE");

export type PostgresCommunityGraphSourceKind =
  | "effective"
  | "v1.1"
  | "v1"
  | "mixed"
  | "v0.2";

/** The reader supplies this complete, source-pinned cohort. Revisions are
 * checked again inside the publication transaction; the owner digest is the
 * only owner identifier retained in publication membership. */
export interface PostgresCommunityGraphMember {
  readonly participantId: string;
  readonly ownerDigest: string;
  readonly inputRevision: number;
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  readonly sourceKind: PostgresCommunityGraphSourceKind;
  /** Exact effective-history dependency fingerprint used by the model result.
   * It is present only for source families the reviewed reader can calculate. */
  readonly inputFingerprint?: string;
}

/** Global source watermarks captured with the effective-owner inventory. A
 * changed watermark defers publication so a page assembled across concurrent
 * source revisions can never be mistaken for a complete cohort. */
export interface PostgresCommunityGraphSourcePin {
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly sourceAuthorityEpoch: number;
  readonly analyticsAuthorityEpoch: number;
  readonly sequence: number;
}

export interface PostgresCommunityGraphPublicationOptions {
  readonly sourcePin: PostgresCommunityGraphSourcePin;
  readonly members: readonly PostgresCommunityGraphMember[];
  readonly day: string;
  readonly nowMs?: number;
  readonly schema?: PostgresSchemaOptions;
}

export type PostgresCommunityGraphPublicationProgress =
  | { readonly state: "published" | "unchanged"; readonly memberCount: number; readonly generation: string }
  | { readonly state: "deferred"; readonly reason: "source_changed" | "cache_pending" | "capacity"; readonly memberCount: number };

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
}

interface ModelResultRow {
  readonly owner_digest: string;
  readonly input_revision: string | number;
  readonly owner_revision: string | number;
  readonly authority_epoch: string | number;
  readonly public_authority_epoch: string | number;
  readonly source_epoch: string | number;
  readonly sequence: string | number;
  readonly method: string;
  readonly status: "ready" | "not_testable";
  readonly reason: string | null;
  readonly payload_json: string;
  readonly payload_sha256: string;
  readonly computed_at_ms: string | number;
}

type MemberProof = readonly [
  ownerDigest: string,
  sourceKind: PostgresCommunityGraphSourceKind,
  inputRevision: number,
  ownerRevision: number,
  authorityEpoch: number,
  inputFingerprint: string | null,
  resultSha256: string | null,
];

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

function normalizedMembers(input: unknown): NormalizedMember[] {
  if (!Array.isArray(input) || input.length > MAX_MEMBERS) throw fail();
  const result: NormalizedMember[] = [];
  let bytes = 0;
  let previous = "";
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
    const member = raw as PostgresCommunityGraphMember;
    if (typeof member.participantId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(member.participantId)
        || typeof member.ownerDigest !== "string" || !/^[a-f0-9]{64}$/u.test(member.ownerDigest)
        || member.ownerDigest <= previous
        || !["effective", "v1.1", "v1", "mixed", "v0.2"].includes(member.sourceKind)) throw fail();
    previous = member.ownerDigest;
    const inputRevision = integer(member.inputRevision);
    const ownerRevision = integer(member.ownerRevision);
    const authorityEpoch = integer(member.authorityEpoch);
    const supported = member.sourceKind === "effective" || member.sourceKind === "v1.1" || member.sourceKind === "v1";
    const validFingerprint = typeof member.inputFingerprint === "string"
      && /^[a-f0-9]{64}$/u.test(member.inputFingerprint);
    if (supported ? !validFingerprint : member.inputFingerprint !== undefined) throw fail();
    const normalized: NormalizedMember = Object.freeze({
      participantId: member.participantId,
      ownerDigest: member.ownerDigest,
      inputRevision,
      ownerRevision,
      authorityEpoch,
      sourceKind: member.sourceKind,
      ...(supported ? { inputFingerprint: member.inputFingerprint } : {}),
      modelMethod: member.sourceKind === "effective" || member.sourceKind === "v1.1"
        ? V11_PLAN_ATTRIBUTION_ADAPTER_VERSION
        : member.sourceKind === "v1" ? MODEL_HISTORY_METHOD_VERSION : null,
    });
    bytes += new TextEncoder().encode(canonicalJson({
      ownerDigest: normalized.ownerDigest,
      inputRevision: normalized.inputRevision,
      ownerRevision: normalized.ownerRevision,
      authorityEpoch: normalized.authorityEpoch,
      sourceKind: normalized.sourceKind,
      inputFingerprint: normalized.inputFingerprint ?? null,
    })).byteLength;
    if (bytes > MAX_COHORT_BYTES) throw fail();
    result.push(normalized);
  }
  return result;
}

function sourcePin(value: unknown, sourceId: string, sourceNamespace: string): PostgresCommunityGraphSourcePin {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const pin = value as PostgresCommunityGraphSourcePin;
  if (pin.sourceId !== sourceId || pin.sourceNamespace !== sourceNamespace) throw fail();
  return Object.freeze({
    sourceId,
    sourceNamespace,
    sourceAuthorityEpoch: integer(pin.sourceAuthorityEpoch),
    analyticsAuthorityEpoch: integer(pin.analyticsAuthorityEpoch),
    sequence: integer(pin.sequence),
  });
}

function schemaName(options: PostgresSchemaOptions | undefined): string {
  return quotePostgresIdentifier(createPostgresSchemaConfig(options).primarySchema);
}

async function hashMatches(value: string, expected: string): Promise<boolean> {
  return await sha256Hex(value) === expected;
}

function asSourceRow(value: SourceRow | undefined, pin: PostgresCommunityGraphSourcePin): {
  readonly policyRevision: number;
  readonly collectionRevision: number;
  readonly sourceEpoch: number;
} | null {
  if (!value || value.source_id !== pin.sourceId || value.publication_state !== "ready"
      || value.control_state !== "operational" || value.publication_enabled !== true) return null;
  const sourceEpoch = integer(value.source_authority_epoch);
  const sequence = integer(value.analytics_sequence);
  const authorityEpoch = integer(value.analytics_authority_epoch);
  const latestSequence = integer(value.latest_sequence);
  const policyRevision = integer(value.policy_revision, 1);
  const collectionRevision = integer(value.collection_revision, 1);
  if (sourceEpoch !== pin.sourceAuthorityEpoch || authorityEpoch !== pin.analyticsAuthorityEpoch
      || sequence !== pin.sequence || latestSequence !== sequence || authorityEpoch !== sourceEpoch) return null;
  return { policyRevision, collectionRevision, sourceEpoch };
}

/** Publish one historical model-composition day from already-completed,
 * revision-pinned owner results. Calculation stays in the source adapter;
 * this transaction proves cohort completeness and records the exact members
 * needed by later erasure invalidation. */
export async function publishPostgresCommunityModelDay(
  pool: PostgresPool,
  options: PostgresCommunityGraphPublicationOptions,
): Promise<PostgresCommunityGraphPublicationProgress> {
  const identity = createPostgresSourceIdentityConfig({ sourceId: options.sourcePin?.sourceId,
    sourceNamespace: options.sourcePin?.sourceNamespace });
  const capturedPin = sourcePin(options.sourcePin, identity.sourceId, identity.sourceNamespace);
  const capturedDay = day(options.day);
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw fail();
  const members = normalizedMembers(options.members);
  const schema = schemaName(options.schema);
  const ownerDigests = members.map((member) => member.ownerDigest);
  const normalizedByDigest = new Map(members.map((member) => [member.ownerDigest, member]));
  const memberCount = members.length;
  const capturedAt = await withPostgresMutation(pool, async (client) => {
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
              controls.publication_enabled
         FROM ${schema}.storage_source_state source
         JOIN ${schema}.analytics_source_cursors cursor ON cursor.source_id = source.source_id
         JOIN ${schema}.publication_state policy ON policy.singleton = 1
         JOIN ${schema}.collection_controls controls ON controls.singleton = 1
        WHERE source.singleton = 1
        FOR SHARE OF source, cursor, policy, controls`,
    );
    const authority = asSourceRow(authorityResult.rows[0], capturedPin);
    if (!authority) return { state: "deferred" as const, reason: "source_changed" as const };

    if (members.length > 0) {
      // Participant erasure locks participant -> owner link before cascading.
      // Acquire shared locks in that same order so publication cannot deadlock
      // an erasure that won the participant row first.
      const participantIds = [...new Set(members.map((member) => member.participantId))];
      const participantRows = await client.query<{ id: string }>(
        `SELECT id FROM ${schema}.participants
          WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE`,
        [participantIds],
      );
      if (participantRows.rows.length !== participantIds.length) {
        return { state: "deferred" as const, reason: "source_changed" as const };
      }
      const linkRows = await client.query<{ owner_digest: string; participant_id: string; state: string }>(
        `SELECT owner_digest, participant_id, state FROM ${schema}.storage_v11_owner_links
          WHERE owner_digest = ANY($1::text[]) ORDER BY participant_id FOR SHARE`,
        [ownerDigests],
      );
      const linkByDigest = new Map(linkRows.rows.map((row) => [row.owner_digest, row]));
      const ownerRows = await client.query<{
        owner_digest: string; revision: string | number; authority_epoch: string | number; state: string;
      }>(
        `SELECT owner_digest, revision, authority_epoch, state FROM ${schema}.analytics_owner_state
          WHERE source_id = $1 AND owner_digest = ANY($2::text[]) ORDER BY owner_digest FOR SHARE`,
        [capturedPin.sourceId, ownerDigests],
      );
      const ownerByDigest = new Map(ownerRows.rows.map((row) => [row.owner_digest, row]));
      const versionRows = await client.query<{ participant_id: string; revision: string | number }>(
        `SELECT participant_id, revision FROM ${schema}.input_versions
          WHERE participant_id = ANY($1::text[]) ORDER BY participant_id FOR SHARE`,
        [participantIds],
      );
      const versionByParticipant = new Map(versionRows.rows.map((row) => [row.participant_id, row]));
      const terminalRows = await client.query<{ owner_digest: string }>(
        `SELECT DISTINCT owner_digest FROM ${schema}.storage_ingestion_changes
          WHERE source_id = $1 AND owner_digest = ANY($2::text[])
            AND kind IN ('owner-withdrawn', 'owner-erased')`,
        [capturedPin.sourceId, ownerDigests],
      );
      const terminalOwners = new Set(terminalRows.rows.map((row) => row.owner_digest));
      if (linkRows.rows.length !== members.length || ownerRows.rows.length !== members.length
          || versionRows.rows.length !== participantIds.length) {
        return { state: "deferred" as const, reason: "source_changed" as const };
      }
      for (const member of members) {
        const link = linkByDigest.get(member.ownerDigest);
        const owner = ownerByDigest.get(member.ownerDigest);
        const version = versionByParticipant.get(member.participantId);
        if (!link || link.participant_id !== member.participantId || link.state !== "active"
            || !owner || owner.state !== "active"
            || integer(version?.revision) !== member.inputRevision
            || integer(owner.revision) !== member.ownerRevision
            || integer(owner.authority_epoch) !== member.authorityEpoch
            || terminalOwners.has(member.ownerDigest)) {
          return { state: "deferred" as const, reason: "source_changed" as const };
        }
      }
    }

    const supported = members.filter((member) => member.modelMethod !== null);
    const resultRows = supported.length === 0 ? [] : (await client.query<ModelResultRow>(
      `SELECT result.owner_digest, result.input_revision, result.owner_revision,
              result.authority_epoch, result.public_authority_epoch, result.source_epoch, result.sequence, result.method,
              result.status, result.reason, result.payload_json, result.payload_sha256,
              result.computed_at_ms
         FROM ${schema}.analytics_owner_results result
        WHERE result.source_id = $1 AND result.source_namespace = $2
          AND result.observed_day = $3::date AND result.metric = 'model'
          AND result.owner_digest = ANY($4::text[])
        ORDER BY result.owner_digest
        FOR SHARE OF result`,
      [capturedPin.sourceId, capturedPin.sourceNamespace, capturedDay,
        supported.map((member) => member.ownerDigest)],
    )).rows;
    if (resultRows.length !== supported.length) return { state: "deferred" as const, reason: "cache_pending" as const };

    const resultByDigest = new Map(resultRows.map((row) => [row.owner_digest, row]));
    const compositions: CommunityModelComposition[] = [];
    let refusedParticipantCount = 0;
    let totalResultBytes = 0;
    for (const member of members) {
      if (member.modelMethod === null) continue;
      const row = resultByDigest.get(member.ownerDigest);
      if (!row) return { state: "deferred" as const, reason: "cache_pending" as const };
      if (integer(row.input_revision) !== member.inputRevision
          || integer(row.owner_revision) !== member.ownerRevision
          || integer(row.authority_epoch) !== member.authorityEpoch
          || integer(row.public_authority_epoch) > capturedPin.analyticsAuthorityEpoch
          || integer(row.source_epoch) > capturedPin.analyticsAuthorityEpoch
          || integer(row.sequence) > capturedPin.sequence
          || row.method !== member.modelMethod) return { state: "deferred" as const, reason: "cache_pending" as const };
      const resultBytes = new TextEncoder().encode(row.payload_json).byteLength;
      totalResultBytes += resultBytes;
      if (resultBytes > MAX_RESULT_BYTES || totalResultBytes > MAX_TOTAL_RESULT_BYTES) {
        return { state: "deferred" as const, reason: "capacity" as const };
      }
      if (!await hashMatches(row.payload_json, row.payload_sha256)) throw fail();
      let parsed: unknown;
      try { parsed = JSON.parse(row.payload_json); } catch { throw fail(); }
      if (!validCompleteCachedComposition(parsed, member.inputFingerprint!, member.modelMethod)) throw fail();
      if (row.status !== parsed.status
          || (parsed.status === "not_testable" && row.reason !== parsed.reason)
          || (parsed.status === "ready" && row.reason !== null)
          || integer(row.computed_at_ms) > nowMs + MAX_FUTURE_SKEW_MS) throw fail();
      if (parsed.status === "not_testable") refusedParticipantCount += 1;
      else {
        if (Date.parse(parsed.latestQuotaObservedAt) >= Date.parse(modelHistoryWindow(capturedDay).observedAtBefore)) throw fail();
        compositions.push({ participantId: member.ownerDigest, composition: parsed });
      }
    }

    const payload = buildCommunityModelCompositionDay({
      compositions,
      v1ParticipantCount: supported.length,
      unsupportedSourceParticipantCount: memberCount - supported.length,
      refusedParticipantCount,
    }, capturedDay);
    const payloadJson = canonicalJson(payload);
    if (new TextEncoder().encode(payloadJson).byteLength > MAX_PUBLICATION_BYTES) {
      return { state: "deferred" as const, reason: "capacity" as const };
    }
    const payloadSha256 = await sha256Hex(payloadJson);
    const memberProof: MemberProof[] = members.map((member) => {
      const row = resultByDigest.get(member.ownerDigest);
      return [member.ownerDigest, member.sourceKind, member.inputRevision, member.ownerRevision,
        member.authorityEpoch, member.inputFingerprint ?? null, row?.payload_sha256 ?? null];
    });
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
      "postgres-community-model-day-v1", capturedDay, authorityJson, memberProof,
    ]));
    const generation = cohortDigest;
    const captureJson = canonicalJson({
      schema: "postgres-community-model-capture-v1",
      authority: JSON.parse(authorityJson),
      memberProof,
    });
    const existingInvalidation = await client.query(
      `SELECT 1 FROM ${schema}.analytics_publication_invalidations
        WHERE source_id = $1 AND day = $2::date AND metric = 'model' AND generation = $3 LIMIT 1`,
      [capturedPin.sourceId, capturedDay, generation],
    );
    if (existingInvalidation.rows.length > 0) {
      return { state: "deferred" as const, reason: "source_changed" as const };
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
      const expectedCapture = captureJson;
      if (!storedCapture || storedCapture.cohort_digest !== cohortDigest
          || integer(storedCapture.expected_members) !== memberCount
          || storedCapture.payload_json !== expectedCapture
          || integer(storedCapture.policy_revision, 1) !== authority.policyRevision
          || integer(storedCapture.collection_revision, 1) !== authority.collectionRevision) throw fail();
      const membership = await client.query<{
        owner_digest: string; input_revision: string | number;
        owner_revision: string | number; authority_epoch: string | number;
      }>(
        `SELECT owner_digest, input_revision, owner_revision, authority_epoch
           FROM ${schema}.analytics_publication_owner_members
          WHERE source_id = $1 AND day = $2::date AND metric = 'model' AND generation = $3
          ORDER BY owner_digest`,
        [capturedPin.sourceId, capturedDay, generation],
      );
      if (membership.rows.length !== memberCount || membership.rows.some((row, index) => {
        const member = members[index];
        return !member || row.owner_digest !== member.ownerDigest
          || integer(row.input_revision) !== member.inputRevision
          || integer(row.owner_revision) !== member.ownerRevision
          || integer(row.authority_epoch) !== member.authorityEpoch;
      })) throw fail();
      return { state: "unchanged" as const, generation };
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
    const expectedCapture = captureJson;
    if (!storedCapture || storedCapture.cohort_digest !== cohortDigest
        || integer(storedCapture.expected_members) !== memberCount
        || storedCapture.payload_json !== expectedCapture
        || integer(storedCapture.policy_revision, 1) !== authority.policyRevision
        || integer(storedCapture.collection_revision, 1) !== authority.collectionRevision) throw fail();
    if (members.length > 0) {
      await client.query(
        `INSERT INTO ${schema}.analytics_publication_owner_members
          (source_id, day, metric, generation, owner_digest, input_revision, owner_revision, authority_epoch)
         SELECT $1, $2::date, 'model', $3, member.owner_digest, member.input_revision,
                member.owner_revision, member.authority_epoch
           FROM unnest($4::text[], $5::bigint[], $6::bigint[], $7::bigint[])
                AS member(owner_digest, input_revision, owner_revision, authority_epoch)
         ON CONFLICT (source_id, day, metric, generation, owner_digest) DO NOTHING`,
        [capturedPin.sourceId, capturedDay, generation, ownerDigests,
          members.map((member) => member.inputRevision), members.map((member) => member.ownerRevision),
          members.map((member) => member.authorityEpoch)],
      );
      const memberReceipt = await client.query<{ count: string | number }>(
        `SELECT count(*) AS count FROM ${schema}.analytics_publication_owner_members
          WHERE source_id = $1 AND day = $2::date AND metric = 'model' AND generation = $3`,
        [capturedPin.sourceId, capturedDay, generation],
      );
      if (integer(memberReceipt.rows[0]?.count) !== memberCount) throw fail();
      const membership = await client.query<{
        owner_digest: string; input_revision: string | number;
        owner_revision: string | number; authority_epoch: string | number;
      }>(
        `SELECT owner_digest, input_revision, owner_revision, authority_epoch
           FROM ${schema}.analytics_publication_owner_members
          WHERE source_id = $1 AND day = $2::date AND metric = 'model' AND generation = $3
          ORDER BY owner_digest`,
        [capturedPin.sourceId, capturedDay, generation],
      );
      if (membership.rows.length !== memberCount || membership.rows.some((row, index) => {
        const member = members[index];
        return !member || row.owner_digest !== member.ownerDigest
          || integer(row.input_revision) !== member.inputRevision
          || integer(row.owner_revision) !== member.ownerRevision
          || integer(row.authority_epoch) !== member.authorityEpoch;
      })) throw fail();
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
    if (invalidated.rows.length > 0) return { state: "deferred" as const, reason: "source_changed" as const };
    return { state: "published" as const, generation };
  }, { operation: "postgres.community_graph.publish_model_day", isolationLevel: "read_committed" });

  if (capturedAt.state === "deferred") return { state: "deferred", reason: capturedAt.reason, memberCount };
  return { state: capturedAt.state, memberCount, generation: capturedAt.generation };
}

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
  const schema = schemaName(options.schema);
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
      actual_members: string | number;
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
              capture.collection_revision AS capture_collection_revision,
              (SELECT count(*) FROM ${schema}.analytics_publication_owner_members member
                WHERE member.source_id = publication.source_id AND member.day = publication.day
                  AND member.metric = publication.metric AND member.generation = publication.generation) AS actual_members
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
              AND invalidation.metric = publication.metric AND invalidation.generation = publication.generation)
          AND NOT EXISTS (SELECT 1 FROM ${schema}.analytics_publication_owner_members member
            LEFT JOIN ${schema}.analytics_owner_state owner
              ON owner.source_id = member.source_id AND owner.owner_digest = member.owner_digest
            LEFT JOIN ${schema}.storage_v11_owner_links link ON link.owner_digest = member.owner_digest
            LEFT JOIN ${schema}.participants participant ON participant.id = link.participant_id
            WHERE member.source_id = publication.source_id AND member.day = publication.day
              AND member.metric = publication.metric AND member.generation = publication.generation
              AND (owner.state IS DISTINCT FROM 'active' OR link.state IS DISTINCT FROM 'active'
                OR participant.state IS DISTINCT FROM 'active'))`,
      [identity.sourceId, capturedDay],
    );
    const row = result.rows[0];
    if (!row || row.policy_state !== "ready" || row.control_state !== "operational" || row.publication_enabled !== true
        || integer(row.policy_revision, 1) !== integer(row.current_policy_revision, 1)
        || integer(row.collection_revision, 1) !== integer(row.current_collection_revision, 1)
        || integer(row.expected_members) !== integer(row.actual_members)
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
        || captureRecord.schema !== "postgres-community-model-capture-v1"
        || canonicalJson(captureRecord.authority) !== canonicalJson(authority)
        || !Array.isArray(captureRecord.memberProof)
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
    const memberRows = await client.query<{
      owner_digest: string; input_revision: string | number;
      owner_revision: string | number; authority_epoch: string | number;
    }>(
      `SELECT owner_digest, input_revision, owner_revision, authority_epoch
         FROM ${schema}.analytics_publication_owner_members
        WHERE source_id = $1 AND day = $2::date AND metric = 'model' AND generation = $3
        ORDER BY owner_digest`,
      [identity.sourceId, capturedDay, row.generation],
    );
    if (memberRows.rows.length !== memberProof.length || memberRows.rows.some((member, index) => {
      const proof = memberProof[index];
      return !proof || member.owner_digest !== proof[0]
        || integer(member.input_revision) !== proof[2]
        || integer(member.owner_revision) !== proof[3]
        || integer(member.authority_epoch) !== proof[4];
    })) return null;
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
