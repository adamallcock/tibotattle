/**
 * analytics-v2 occurrence adapter (A-1): one owner's effective telemetry
 * occurrences per OBSERVED day, read from the existing PostgreSQL tables.
 *
 * This is a PostgreSQL port of d43c8f92 telemetry-usage-effective-reader.ts
 * readEffectiveTelemetryOwnerDayPage (:793-830 for usage, and its quota/session
 * branch), run over a whole day range in one read-only snapshot instead of
 * one bounded page per day:
 *
 *  1. Candidates are selected per observed day, exactly as production's
 *     candidate SQL does: a v1 typed record whose observed day is D, a v1.1
 *     typed record admitted to a ready manifest of an owner-linked generation
 *     on day D, a v1.2 record of a ready manifest whose domain day is D, and
 *     (usage only, runtime active) a correction fact whose event time falls on
 *     D. An occurrence is a candidate of every day any of its sources names.
 *  2. Each candidate group is expanded across ALL days (no day filter), so a
 *     source with a different event time is folded into the same group.
 *  3. Groups are reconciled with the vendored d43c8f92 reconcileGroups (usage,
 *     correction-aware) and genericOccurrence/genericRecordJson (quota and
 *     session), unchanged.
 *
 * Corrections never move an event across days: an event-time disagreement
 * makes the occurrence a conflict (eventTime null, status 'conflict') on
 * every candidate day it appears on, which blocks those days downstream
 * (A-2/A-3). Rows are ordered by (candidate observedAtMs, occurrenceId),
 * production's page order; for compatible rows observedAtMs is the event time.
 *
 * Production-to-PostgreSQL mapping (data model only, no semantic change):
 * D1's typed_telemetry_compatibility_records view is the typed row decoded
 * with the same codec; typed_v1/v11_owner_memberships are
 * typed_telemetry_owner_memberships rows of source_format 10/11; D1's
 * typed_v11_record_admissions view is its definition over
 * typed_v11_record_proofs, typed_v11_chunk_allocations and
 * typed_v11_manifest_memberships; D1's compact v1.2 tables are 0025's
 * telemetry_v12_typed_* tables. The usage-correction family is read only
 * when the sealed source's runtime was active (owners.ts), and the retained
 * v1.2 authorization scope is evaluated at the pinned nowMs.
 */

import {
  canonicalTelemetryV11Json,
  parseTelemetryV11Record,
  type TelemetryV11Attribution,
  type TelemetryV11Record,
  type TelemetryV12Record,
} from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import type { PostgresClient } from "../postgres-client";
import { decodeTelemetryV12Record, type TelemetryV12TypedRecordRow } from "../telemetry-v12-typed-codec";
import { prepareAnalyticsReplayUsageCorrectionAssertion } from "../telemetry-usage-reconciliation";
import {
  decodeTypedTelemetryId,
  encodeTypedTelemetryId,
  typedTelemetryCanonicalRecords,
  type TypedTelemetryFields,
} from "../typed-telemetry-codec";
import {
  genericOccurrence,
  reconcileGroups,
  type EffectiveTelemetryOccurrence,
  type EffectiveTelemetryStream,
  type EffectiveUsageOccurrence,
  type TelemetryUsageCorrectionFactRow,
  type TelemetryV12EffectiveRecord,
  type TypedTelemetryCompatibilityRecord,
} from "../../vendor/analytics-d43c8f92/entry";
import {
  ANALYTICS_V2_OWNER_DIGEST_PATTERN,
  type AnalyticsV2Day,
} from "./contract";
import {
  DAY_MS,
  analyticsV2PreparedStatement,
  analyticsV2Statement,
  correctionRuntimeActiveSql,
  dayFromNumber,
  dayNumber,
  nowTimestamp,
  onReadSnapshot,
  participantExclusionsWatermarkSql,
  queryPrepared,
  quotedSchema,
  readParticipantActiveExclusions,
  safeInteger,
  sourceFail,
  typedIdTextSql,
  v12RetainedAuthorizationScopeSql,
  withGenericPlans,
  type AnalyticsV2PreparedStatement,
  type AnalyticsV2SnapshotContext,
} from "./owners";
import { analyticsV2ExclusionsOn } from "./exclusions";

export type { EffectiveTelemetryOccurrence, EffectiveTelemetryStream };

export interface ReadOwnerOccurrencesOptions {
  readonly ownerDigest: string;
  readonly stream: EffectiveTelemetryStream;
  readonly fromDay: AnalyticsV2Day;
  readonly throughDay: AnalyticsV2Day;
  /**
   * Distinct (day, occurrence) candidates this read may select before it
   * fails closed with ANALYTICS_V2_SOURCE_LIMIT, so a caller can refuse a
   * dense owner before expansion. Defaults to (and may not exceed)
   * MAX_ANALYTICS_V2_CANDIDATES.
   */
  readonly maxCandidates?: number;
}

/** Widest day range one call reads (the kernels' 170-day horizon plus slack). */
export const MAX_ANALYTICS_V2_OCCURRENCE_DAYS = 400;
/**
 * The first day readOwnerFirstEvidenceDay considers: the lower end of the
 * observed-day domain the reader parses (safeInteger(observed_day, -100_000,
 * ...)), so the first-evidence read has no window, only the representable range.
 */
const FIRST_EVIDENCE_FLOOR_DAY_NUMBER = -100_000;
/** Occurrence ids expanded per source batch (production's page bound). */
const EXPANSION_BATCH = 200;
const EXPANSION_GROUP_IDS = 2_000;
/** A statement buffers at most G+1 raw rows, preserving the old batch bound. */
export const MAX_ANALYTICS_V2_EXPANSION_GROUP_ROWS = 40_001;
const EXPANSION_GROUP_ROWS = MAX_ANALYTICS_V2_EXPANSION_GROUP_ROWS;
/**
 * Distinct legacy or correction source variants one 200-id batch may expand
 * to: 200 variants per occurrence. d43c8f92's Worker reader stops at 3,200
 * (telemetry-usage-effective-reader.ts), a D1 statement bound; the GCP job
 * holds one batch in memory (about 2 KB per variant), so it reconciles every
 * variant production's reconcileGroups would see up to this bound.
 */
export const MAX_ANALYTICS_V2_BATCH_SOURCE_ROWS = 40_000;
/** Distinct v1.2 variants one 200-id batch may expand to (production's Worker bound is 16,384). */
export const MAX_ANALYTICS_V2_BATCH_V12_ROWS = 40_000;
const MAX_BATCH_SOURCE_ROWS = MAX_ANALYTICS_V2_BATCH_SOURCE_ROWS;
const MAX_BATCH_V12_ROWS = MAX_ANALYTICS_V2_BATCH_V12_ROWS;
/**
 * Candidate coordinates one call may select before failing closed. The Job
 * splits its reads by the exact counts of countOwnerOccurrences so that a
 * call stays near its configured read chunk; this is the hard ceiling, and a
 * day larger than it refuses its owner before any read (resources.ts
 * ANALYTICS_V2_MAX_READ_DAY_OCCURRENCES).
 */
export const MAX_ANALYTICS_V2_CANDIDATES = 2_000_000;

const OCCURRENCE_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const MIN_MS = -8_640_000_000_000_000;
const MAX_MS = 8_640_000_000_000_000;
const STREAM_CODES: Readonly<Record<EffectiveTelemetryStream, number>> = Object.freeze({ usage: 1, quota: 2, session: 3 });
const ACCOUNT_BASES = ["unavailable", "same_source", "provisional_marker"] as const;
const PLAN_BASES = ["unavailable", "same_source_occurrence", "provisional_marker", "conflicted"] as const;

// ---------------------------------------------------------------------------
// Small value guards
// ---------------------------------------------------------------------------

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
}

function hex(value: unknown): string {
  return Buffer.from(bytes(value)).toString("hex");
}

function text(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
  return value;
}

function nullableInteger(value: unknown, maximum = 1_000_000_000_000): number | null {
  return value === null || value === undefined ? null : safeInteger(value, 0, maximum);
}

function occurrenceText(blob: unknown): string {
  let decoded: string;
  try {
    decoded = decodeTypedTelemetryId(bytes(blob));
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
  if (!OCCURRENCE_ID.test(decoded)) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  return decoded;
}

function occurrenceHex(id: string): string {
  try {
    return Buffer.from(encodeTypedTelemetryId(id)).toString("hex");
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
}

/** ASCII code-point order, which is SQLite BINARY TEXT order for these ids. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}

function normalizeOptions(options: ReadOwnerOccurrencesOptions): {
  ownerDigest: string; stream: EffectiveTelemetryStream; fromDay: number; throughDay: number; maxCandidates: number;
} {
  if (!options || typeof options !== "object") sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  if (typeof options.ownerDigest !== "string" || !ANALYTICS_V2_OWNER_DIGEST_PATTERN.test(options.ownerDigest)) {
    sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  if (options.stream !== "usage" && options.stream !== "quota" && options.stream !== "session") {
    sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  const fromDay = dayNumber(options.fromDay);
  const throughDay = dayNumber(options.throughDay);
  if (throughDay < fromDay || throughDay - fromDay + 1 > MAX_ANALYTICS_V2_OCCURRENCE_DAYS) {
    sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  const maxCandidates = options.maxCandidates ?? MAX_ANALYTICS_V2_CANDIDATES;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > MAX_ANALYTICS_V2_CANDIDATES) {
    sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  return { ownerDigest: options.ownerDigest, stream: options.stream, fromDay, throughDay, maxCandidates };
}

// ---------------------------------------------------------------------------
// Owner scope (d43c8f92 readOwnerScope)
// ---------------------------------------------------------------------------

interface OwnerScope {
  readonly participantId: string;
  readonly v1Namespace: string | null;
  readonly v11Namespace: string | null;
  readonly correctionActive: boolean;
  /** Same-snapshot existence proof for empty correction expansion. */
  readonly correctionFactsPresent: boolean;
  /** Ready manifests are a necessary condition for v1.2 expansion. */
  readonly v12ReadyManifests: boolean;
  readonly legacyOwnerIndexReady: boolean;
  /** v1.2 runtime active (production's `v12_state === "active"`). */
  readonly v12RuntimeActive: boolean;
  /** ...and the participant has a v1.2 head (production's candidate and usage-source gate). */
  readonly v12HeadActive: boolean;
}

function ownerScopeSql(s: string): string {
  return `SELECT link.participant_id,v1.source_namespace AS v1_namespace,v11.source_namespace AS v11_namespace,
          EXISTS(SELECT 1 FROM ${s}.telemetry_usage_correction_runtime r WHERE r.id=1
            AND r.schema_version='telemetry-usage-correction-v1' AND r.method_version='usage-total-correction-v1')
            AS correction_present,
          ${correctionRuntimeActiveSql(s)} AS correction_active,
          EXISTS(SELECT 1 FROM ${s}.telemetry_usage_correction_history h
            JOIN ${s}.telemetry_usage_correction_facts f ON f.history_id=h.id AND f.method_version=1
            WHERE h.owner_digest=decode($1,'hex')) AS correction_facts_present,
          EXISTS(SELECT 1 FROM ${s}.telemetry_v12_day_manifests m
            WHERE m.participant_id=link.participant_id AND m.state='ready') AS v12_ready_manifests,
          EXISTS(SELECT 1 FROM pg_catalog.pg_index i
            WHERE i.indexrelid=pg_catalog.to_regclass('${s}.typed_telemetry_owner_occurrence')
              AND i.indrelid=pg_catalog.to_regclass('${s}.typed_telemetry_records')
              AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
              AND i.indnkeyatts=3
              AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
                JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
                WHERE k.ord<=3 ORDER BY k.ord)=ARRAY['owner_id','stream','occurrence_id']) AS legacy_owner_index_ready,
          v12head.generation_id AS v12_generation_id,v12runtime.state AS v12_state
     FROM ${s}.storage_v11_owner_links link
     JOIN ${s}.storage_source_state source ON source.singleton=1
     JOIN ${s}.storage_owner_revisions owner ON owner.source_id=source.source_id
      AND owner.owner_digest=link.owner_digest AND owner.state='active'
     JOIN ${s}.participants participant ON participant.id=link.participant_id AND participant.state='active'
     LEFT JOIN ${s}.typed_v1_admission_state v1 ON v1.id=1 AND v1.runtime_contract_version=1
     LEFT JOIN ${s}.typed_v11_admission_state v11 ON v11.id=1 AND v11.runtime_contract_version=1
     LEFT JOIN ${s}.telemetry_v12_domain_heads v12head ON v12head.participant_id=link.participant_id
     LEFT JOIN ${s}.telemetry_v12_runtime v12runtime ON v12runtime.id=1
    WHERE link.owner_digest=$1 AND link.state='active' LIMIT 2`;
}

async function readOwnerScope(client: PostgresClient, s: string, ownerDigest: string): Promise<OwnerScope> {
  const result = await queryPrepared<{
    participant_id: unknown; v1_namespace: unknown; v11_namespace: unknown; correction_present: unknown;
    correction_active: unknown; correction_facts_present: unknown; v12_ready_manifests: unknown; legacy_owner_index_ready: unknown;
    v12_generation_id: unknown; v12_state: unknown;
  }>(client, (await readerStatements(s)).scope, [ownerDigest]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined || typeof row.participant_id !== "string"
      || row.correction_present !== true || typeof row.correction_active !== "boolean"
      || typeof row.correction_facts_present !== "boolean" || typeof row.v12_ready_manifests !== "boolean"
      || typeof row.legacy_owner_index_ready !== "boolean") {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
  const v1Namespace = row.v1_namespace === null ? null : text(row.v1_namespace);
  const v11Namespace = row.v11_namespace === null ? null : text(row.v11_namespace);
  const v12RuntimeActive = row.v12_state === "active";
  const v12HeadActive = v12RuntimeActive && typeof row.v12_generation_id === "string";
  // One source namespace for both legacy families (authority capture's rule).
  if (v1Namespace !== null && v11Namespace !== null && v1Namespace !== v11Namespace) {
    sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  // d43c8f92 readOwnerScope's CAS refusal: no legacy family and no active v1.2 runtime.
  if (v1Namespace === null && v11Namespace === null && !v12RuntimeActive) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  return Object.freeze({ participantId: row.participant_id, v1Namespace, v11Namespace,
    correctionActive: row.correction_active, correctionFactsPresent: row.correction_facts_present,
    v12ReadyManifests: row.v12_ready_manifests, legacyOwnerIndexReady: row.legacy_owner_index_ready, v12RuntimeActive, v12HeadActive });
}

// ---------------------------------------------------------------------------
// v1 / v1.1 typed sources
// ---------------------------------------------------------------------------

/**
 * The typed v1 and v1.1 rows the effective reader admits for owner $1 /
 * participant $2 and stream ($3 code, $4 name), restricted by `filter` on the
 * typed `record` alias. Mirrors d43c8f92 CANDIDATE_SQL / DIRECT_SOURCE_SQL,
 * except for one predicate it leaves to the caller: the v1.1 chunk
 * completeness test (`chunk.record_count` equal to the chunk's proof count).
 * A v1.1 row carries its chunk as v11_chunk_id and v11_chunk_records (null on
 * a v1 row), and a caller admits exactly the rows legacyV11CompleteSql keeps,
 * with v11ChunkProofsSql over the same records. Correlated here, the count ran
 * once per candidate record and walked every proof of the record's chunk (up
 * to 200), four passes per record (REFRESH-OPT d3); per statement it runs once
 * per chunk. v1 chunks keep their (small) inline completeness count.
 */
function legacyDirectSql(s: string, filter: string): string {
  const v1Device = typedIdTextSql("typed_device.original_id");
  const columns = `record.id AS storage_row_id,record.format,record.occurrence_id,record.observed_at_ms,
         record.observed_day,record.canonical_digest,typed_device.original_id AS device_blob`;
  return `SELECT ${columns},NULL::text AS v11_chunk_id,NULL::integer AS v11_chunk_records
      FROM ${s}.typed_telemetry_owner_memberships membership
      JOIN ${s}.typed_v1_admission_state v1 ON v1.id=1 AND v1.runtime_contract_version=1
       AND v1.source_namespace=membership.source_namespace AND v1.namespace_id=membership.namespace_id
      JOIN ${s}.typed_telemetry_records record ON record.namespace_id=membership.namespace_id
       AND record.owner_id=membership.owner_id AND record.format=10 AND record.stream=$3
      JOIN ${s}.typed_telemetry_devices typed_device ON typed_device.id=record.device_id
       AND typed_device.namespace_id=record.namespace_id
      JOIN ${s}.typed_v1_record_admissions admission ON admission.typed_record_id=record.id
      JOIN ${s}.telemetry_v1_chunks chunk ON chunk.id=admission.chunk_id
       AND chunk.participant_id=membership.participant_id AND chunk.device_id=(${v1Device})
       AND chunk.stream=$4 AND chunk.superseded_at IS NULL AND chunk.accepted_record_count=chunk.record_count
       AND chunk.record_count=(SELECT count(*) FROM ${s}.typed_v1_record_admissions complete
         WHERE complete.chunk_id=chunk.id)
      JOIN ${s}.typed_v1_event_sources event ON event.chunk_id=chunk.id AND event.owner_digest=$1
       AND event.source_namespace=v1.source_namespace
     WHERE membership.participant_id=$2 AND membership.source_format=10 AND ${filter}
    UNION ALL
    SELECT ${columns},chunk.id AS v11_chunk_id,chunk.record_count AS v11_chunk_records
      FROM ${s}.typed_telemetry_owner_memberships membership
      JOIN ${s}.typed_v11_admission_state v11 ON v11.id=1 AND v11.runtime_contract_version=1
       AND v11.source_namespace=membership.source_namespace AND v11.namespace_id=membership.namespace_id
      JOIN ${s}.typed_telemetry_records record ON record.namespace_id=membership.namespace_id
       AND record.owner_id=membership.owner_id AND record.format=11 AND record.stream=$3
      JOIN ${s}.typed_telemetry_devices typed_device ON typed_device.id=record.device_id
       AND typed_device.namespace_id=record.namespace_id
      JOIN ${s}.typed_v11_record_proofs proof ON proof.typed_record_id=record.id
      JOIN ${s}.typed_telemetry_chunks proof_chunk ON proof_chunk.id=proof.chunk_key
      JOIN ${s}.typed_v11_chunk_allocations allocation ON allocation.namespace_id=proof_chunk.namespace_id
       AND allocation.chunk_original=proof_chunk.original_id
      JOIN ${s}.typed_v11_manifest_memberships admitted_manifest
        ON admitted_manifest.typed_manifest_id=proof.manifest_key
      JOIN ${s}.telemetry_v11_chunks chunk ON chunk.id=allocation.chunk_id AND chunk.stream=$4
      JOIN ${s}.telemetry_v11_domain_days domain_day ON domain_day.manifest_id=admitted_manifest.manifest_id
      JOIN ${s}.telemetry_v11_day_manifests manifest ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
      JOIN ${s}.storage_v11_event_sources event ON event.generation_id=domain_day.generation_id
       AND event.owner_digest=$1 AND event.participant_id=$2
      JOIN ${s}.telemetry_v11_domains generation ON generation.id=event.generation_id
       AND generation.id=domain_day.generation_id
       AND generation.participant_id=chunk.participant_id AND generation.device_id=chunk.device_id
       AND event.manifest_digest=generation.manifest_digest
       AND event.from_day=generation.from_day AND event.through_day=generation.through_day
       AND event.input_revision=generation.input_revision
      JOIN ${s}.device_credentials generation_device ON generation_device.id=generation.device_id
       AND generation_device.participant_id=generation.participant_id
     WHERE membership.participant_id=$2 AND membership.source_format=11 AND ${filter}`;
}

/**
 * A MATERIALIZED CTE `v11_chunk_proofs` (chunk_id, proof_count): for every
 * v1.1 chunk a typed record of CTE `fence` (column `id`) reaches through its
 * proof and the chunk allocation, which is the path legacyDirectSql joins, the
 * count d43c8f92's completeness subquery takes for that chunk, unchanged.
 */
function v11ChunkProofsSql(s: string, fence: string): string {
  return `v11_chunk_proofs AS MATERIALIZED (
      SELECT count_allocation.chunk_id,count(*) AS proof_count
        FROM ${s}.typed_v11_chunk_allocations count_allocation
        JOIN ${s}.typed_telemetry_chunks physical_chunk
          ON physical_chunk.namespace_id=count_allocation.namespace_id AND physical_chunk.format=11
         AND physical_chunk.original_id=count_allocation.chunk_original
        JOIN ${s}.typed_v11_record_proofs count_proof ON count_proof.chunk_key=physical_chunk.id
        JOIN ${s}.typed_v11_manifest_memberships count_membership
          ON count_membership.typed_manifest_id=count_proof.manifest_key
       WHERE count_allocation.chunk_id IN (
         SELECT reach_allocation.chunk_id FROM ${fence} reach
           JOIN ${s}.typed_v11_record_proofs reach_proof ON reach_proof.typed_record_id=reach.id
           JOIN ${s}.typed_telemetry_chunks reach_chunk ON reach_chunk.id=reach_proof.chunk_key
           JOIN ${s}.typed_v11_chunk_allocations reach_allocation
             ON reach_allocation.namespace_id=reach_chunk.namespace_id
            AND reach_allocation.chunk_original=reach_chunk.original_id)
       GROUP BY count_allocation.chunk_id)`;
}

/**
 * The completeness predicate legacyDirectSql leaves out, on its row `alias`:
 * a v1 row passes, and a v1.1 row passes exactly when its chunk's
 * record_count equals the chunk's proof count. A chunk absent from
 * v11_chunk_proofs has none (count 0), which no record_count (1 to 200)
 * equals, as before.
 */
function legacyV11CompleteSql(alias: string): string {
  return `(${alias}.format=10 OR (${alias}.v11_chunk_id,${alias}.v11_chunk_records::bigint) IN (
      SELECT complete.chunk_id,complete.proof_count FROM v11_chunk_proofs complete))`;
}

/**
 * Selection-only v1.1 eligibility. Every join below the record proof is a
 * function of its (chunk_key, manifest_key) pair and the binds. The final
 * candidate grouping is insensitive to the multiplicity EXISTS removes.
 * Expansion retains its existing builders and row multiplicity.
 */
function legacySelectionPairCtesSql(s: string, fence: string, completenessCte?: string): string {
  return `selection_pairs AS MATERIALIZED (
      SELECT DISTINCT proof.chunk_key,proof.manifest_key FROM ${fence} selected
        JOIN ${s}.typed_v11_record_proofs proof ON proof.typed_record_id=selected.id
    ), ${completenessCte === undefined ? `selection_chunk_proofs AS MATERIALIZED (
      SELECT count_allocation.chunk_id,count(*) AS proof_count
        FROM ${s}.typed_v11_chunk_allocations count_allocation
        JOIN ${s}.typed_telemetry_chunks physical_chunk
          ON physical_chunk.namespace_id=count_allocation.namespace_id AND physical_chunk.format=11
         AND physical_chunk.original_id=count_allocation.chunk_original
        JOIN ${s}.typed_v11_record_proofs count_proof ON count_proof.chunk_key=physical_chunk.id
        JOIN ${s}.typed_v11_manifest_memberships count_membership
          ON count_membership.typed_manifest_id=count_proof.manifest_key
       WHERE count_allocation.chunk_id IN (
         SELECT reach_allocation.chunk_id FROM selection_pairs pairs
           JOIN ${s}.typed_telemetry_chunks reach_chunk ON reach_chunk.id=pairs.chunk_key
           JOIN ${s}.typed_v11_chunk_allocations reach_allocation
             ON reach_allocation.namespace_id=reach_chunk.namespace_id
            AND reach_allocation.chunk_original=reach_chunk.original_id)
       GROUP BY count_allocation.chunk_id

    ), ` : ""}selection_pairs_ok AS MATERIALIZED (
      SELECT pairs.chunk_key,pairs.manifest_key FROM selection_pairs pairs
       WHERE EXISTS (SELECT 1 FROM ${s}.typed_telemetry_chunks proof_chunk
          JOIN ${s}.typed_v11_chunk_allocations allocation ON allocation.namespace_id=proof_chunk.namespace_id
           AND allocation.chunk_original=proof_chunk.original_id
          JOIN ${s}.typed_v11_manifest_memberships admitted_manifest
            ON admitted_manifest.typed_manifest_id=pairs.manifest_key
          JOIN ${s}.telemetry_v11_chunks chunk ON chunk.id=allocation.chunk_id AND chunk.stream=$4
          JOIN ${s}.telemetry_v11_domain_days domain_day ON domain_day.manifest_id=admitted_manifest.manifest_id
          JOIN ${s}.telemetry_v11_day_manifests manifest ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
          JOIN ${s}.storage_v11_event_sources event ON event.generation_id=domain_day.generation_id
           AND event.owner_digest=$1 AND event.participant_id=$2
          JOIN ${s}.telemetry_v11_domains generation ON generation.id=event.generation_id
           AND generation.id=domain_day.generation_id
           AND generation.participant_id=chunk.participant_id AND generation.device_id=chunk.device_id
           AND event.manifest_digest=generation.manifest_digest
           AND event.from_day=generation.from_day AND event.through_day=generation.through_day
           AND event.input_revision=generation.input_revision
          JOIN ${s}.device_credentials generation_device ON generation_device.id=generation.device_id
           AND generation_device.participant_id=generation.participant_id
         WHERE proof_chunk.id=pairs.chunk_key
           AND (chunk.id,chunk.record_count::bigint) IN (
             SELECT complete.chunk_id,complete.proof_count FROM ${completenessCte ?? "selection_chunk_proofs"} complete))
    )`;
}

/**
 * Candidate-only v1 selection. Resolve membership/runtime once, then count
 * every admission of each reached chunk once before selecting its records.
 * The old per-record LATERAL repeated these checks (and its chunk count) for
 * every owned record, including records of the v1.1 arm. Expansion keeps its
 * existing multiplicity and builders; candidate grouping ignores duplicate
 * event-source evidence, so the eligible chunk/device keys are a set.
 */
function legacyV1SelectionCtesSql(s: string, fence: string): string {
  const v1Device = typedIdTextSql("typed_device.original_id");
  return `selection_v1_memberships AS MATERIALIZED (
      SELECT membership.namespace_id,membership.owner_id,membership.participant_id,v1.source_namespace
        FROM ${s}.typed_telemetry_owner_memberships membership
        JOIN ${s}.typed_v1_admission_state v1 ON v1.id=1 AND v1.runtime_contract_version=1
         AND v1.source_namespace=membership.source_namespace AND v1.namespace_id=membership.namespace_id
       WHERE membership.participant_id=$2 AND membership.source_format=10
    ), selection_v1_records AS MATERIALIZED (
      SELECT record.id,record.namespace_id,record.device_id,record.observed_day,record.occurrence_id,
             record.observed_at_ms,admission.chunk_id
        FROM ${fence}
        JOIN ${s}.typed_telemetry_records record ON record.id=${fence}.id AND record.format=10 AND record.stream=$3
        JOIN selection_v1_memberships membership ON membership.namespace_id=record.namespace_id
         AND membership.owner_id=record.owner_id
        JOIN ${s}.typed_v1_record_admissions admission ON admission.typed_record_id=record.id
    ), selection_v1_devices AS MATERIALIZED (
      SELECT DISTINCT typed_device.id,typed_device.namespace_id,typed_device.original_id
        FROM selection_v1_records record
        JOIN ${s}.typed_telemetry_devices typed_device ON typed_device.id=record.device_id
         AND typed_device.namespace_id=record.namespace_id
    ), selection_v1_chunk_counts AS MATERIALIZED (
      SELECT complete.chunk_id,count(*) AS admission_count
        FROM ${s}.typed_v1_record_admissions complete
        JOIN (SELECT DISTINCT chunk_id FROM selection_v1_records) reached ON reached.chunk_id=complete.chunk_id
       GROUP BY complete.chunk_id
    ), selection_v1_chunks_ok AS MATERIALIZED (
      SELECT DISTINCT chunk.id AS chunk_id,typed_device.id AS device_id,typed_device.namespace_id
        FROM selection_v1_chunk_counts complete
        JOIN ${s}.telemetry_v1_chunks chunk ON chunk.id=complete.chunk_id
         AND chunk.stream=$4 AND chunk.superseded_at IS NULL AND chunk.accepted_record_count=chunk.record_count
         AND chunk.record_count=complete.admission_count
        JOIN selection_v1_memberships membership ON membership.participant_id=chunk.participant_id
        JOIN selection_v1_devices typed_device ON typed_device.namespace_id=membership.namespace_id
         AND chunk.device_id=(${v1Device})
        JOIN ${s}.typed_v1_event_sources event ON event.chunk_id=chunk.id AND event.owner_digest=$1
         AND event.source_namespace=membership.source_namespace
    )`;
}

/** Selection over a fenced id CTE and the candidate-only eligibility sets. */
function legacySelectionSql(s: string, fence: string, filter: string): string {
  return `
      SELECT record.observed_day,record.occurrence_id,record.observed_at_ms
        FROM selection_v1_records record
        JOIN selection_v1_chunks_ok chunk ON chunk.chunk_id=record.chunk_id AND chunk.device_id=record.device_id
         AND chunk.namespace_id=record.namespace_id
       WHERE ${filter}
    UNION ALL
    SELECT record.observed_day,record.occurrence_id,record.observed_at_ms
      FROM ${fence}
      JOIN ${s}.typed_telemetry_records record ON record.id=${fence}.id AND record.format=11 AND record.stream=$3
      JOIN ${s}.typed_telemetry_owner_memberships membership ON membership.namespace_id=record.namespace_id
       AND membership.owner_id=record.owner_id AND membership.participant_id=$2 AND membership.source_format=11
      JOIN ${s}.typed_v11_admission_state v11 ON v11.id=1 AND v11.runtime_contract_version=1
       AND v11.source_namespace=membership.source_namespace AND v11.namespace_id=membership.namespace_id
      JOIN ${s}.typed_telemetry_devices typed_device ON typed_device.id=record.device_id
       AND typed_device.namespace_id=record.namespace_id
      JOIN ${s}.typed_v11_record_proofs proof ON proof.typed_record_id=record.id
      JOIN selection_pairs_ok ON selection_pairs_ok.chunk_key=proof.chunk_key
       AND selection_pairs_ok.manifest_key=proof.manifest_key
     WHERE ${filter}`;
}

/** $1 owner, $2 participant, $3 stream code, $4 name, $5/$6 observed days. */
function legacyCandidatesSql(s: string): string {
  return `WITH owned AS MATERIALIZED (
      SELECT owned_record.id FROM ${s}.typed_telemetry_owner_memberships owned_membership
        JOIN ${s}.typed_telemetry_records owned_record ON owned_record.namespace_id=owned_membership.namespace_id
         AND owned_record.owner_id=owned_membership.owner_id AND owned_record.format=owned_membership.source_format
         AND owned_record.stream=$3
         AND owned_record.observed_at_ms>=$5::integer::bigint*${DAY_MS}
         AND owned_record.observed_at_ms<($6::integer::bigint+1)*${DAY_MS}
       WHERE owned_membership.participant_id=$2 AND owned_membership.source_format IN (10,11)
    ), ${legacyV1SelectionCtesSql(s, "owned")}, ${legacySelectionPairCtesSql(s, "owned")}, direct AS (
      ${legacySelectionSql(s, "owned", "record.observed_day BETWEEN $5::integer AND $6::integer")}
    )
    SELECT observed_day,occurrence_id,min(observed_at_ms)::text AS observed_at_ms
      FROM direct GROUP BY observed_day,occurrence_id`;
}



/**
 * Expansion-local grouped proof count. Count physical (chunk, manifest)
 * groups first, then join UNIQUE typed_manifest_id memberships and allocations.
 * This sums exactly d3's allocation -> physical format11 -> proof -> membership
 * join multiplicity; requested sub-batches never change physical completeness.
 */
function expansionChunkProofsSql(s: string, fence: string): string {
  return `expansion_reached_chunks AS MATERIALIZED (
      SELECT DISTINCT allocation.chunk_id FROM ${fence} reached
        JOIN ${s}.typed_v11_record_proofs proof ON proof.typed_record_id=reached.id
        JOIN ${s}.typed_telemetry_chunks physical ON physical.id=proof.chunk_key
        JOIN ${s}.typed_v11_chunk_allocations allocation
          ON allocation.namespace_id=physical.namespace_id AND allocation.chunk_original=physical.original_id
    ), expansion_physical_counts AS MATERIALIZED (
      SELECT proof.chunk_key,proof.manifest_key,count(*) AS proof_count
        FROM ${s}.typed_v11_record_proofs proof
       WHERE proof.chunk_key IN (
         SELECT physical.id FROM ${s}.typed_v11_chunk_allocations allocation
           JOIN expansion_reached_chunks reached ON reached.chunk_id=allocation.chunk_id
           JOIN ${s}.typed_telemetry_chunks physical ON physical.namespace_id=allocation.namespace_id
            AND physical.format=11 AND physical.original_id=allocation.chunk_original)
       GROUP BY proof.chunk_key,proof.manifest_key
    ), v11_chunk_proofs AS MATERIALIZED (
      SELECT allocation.chunk_id,sum(counted.proof_count)::bigint AS proof_count
        FROM ${s}.typed_v11_chunk_allocations allocation
        JOIN expansion_reached_chunks reached ON reached.chunk_id=allocation.chunk_id
        JOIN ${s}.typed_telemetry_chunks physical ON physical.namespace_id=allocation.namespace_id
         AND physical.format=11 AND physical.original_id=allocation.chunk_original
        JOIN expansion_physical_counts counted ON counted.chunk_key=physical.id
        JOIN ${s}.typed_v11_manifest_memberships membership ON membership.typed_manifest_id=counted.manifest_key
       GROUP BY allocation.chunk_id
    )`;
}

/**
 * UNION ALL of 200-id DIRECT_SOURCE_SQL expansions. SQL ordinal membership
 * follows compareText input order, never bytea order. The narrow representative
 * rows are capped per logical batch before dictionary joins, then by G+1.
 *
 * With the staged index ready, the owner membership probe is a superset of
 * admitted rows: 0030 ties each record's namespace/format/owner to membership
 * and its device/manifest to that owner. The direct admission joins still
 * enforce namespace state, source ownership, completeness and generation CAS.
 * Without a ready index the existing parent probes remain available.
 */
function legacySourcesSql(s: string, ownerProbe = false): string {
  const requested = "ARRAY(SELECT wanted.occurrence_id FROM requested wanted)";
  return `WITH requested AS MATERIALIZED (
      SELECT decode(value,'hex') AS occurrence_id,((ordinal-1)/${EXPANSION_BATCH})::integer AS sub_batch
        FROM unnest($5::text[]) WITH ORDINALITY AS input(value,ordinal)
    ), ${ownerProbe ? `matched AS MATERIALIZED (
      SELECT probed.id,wanted.sub_batch
        FROM ${s}.typed_telemetry_owner_memberships membership
        JOIN ${s}.typed_telemetry_records probed ON probed.namespace_id=membership.namespace_id
         AND probed.owner_id=membership.owner_id AND probed.format=membership.source_format AND probed.stream=$3
        JOIN requested wanted ON wanted.occurrence_id=probed.occurrence_id
       WHERE membership.participant_id=$2 AND membership.source_format IN (10,11)
    )` : `owner_parents AS MATERIALIZED (
      SELECT 10 AS format,parent_device.id AS parent_id
        FROM ${s}.typed_telemetry_owner_memberships parent_membership
        JOIN ${s}.typed_telemetry_devices parent_device ON parent_device.namespace_id=parent_membership.namespace_id
         AND parent_device.owner_id=parent_membership.owner_id
       WHERE parent_membership.participant_id=$2 AND parent_membership.source_format=10
      UNION ALL
      SELECT 11 AS format,parent_manifest.id AS parent_id
        FROM ${s}.typed_telemetry_owner_memberships parent_membership
        JOIN ${s}.typed_telemetry_manifests parent_manifest
          ON parent_manifest.namespace_id=parent_membership.namespace_id
         AND parent_manifest.owner_id=parent_membership.owner_id
       WHERE parent_membership.participant_id=$2 AND parent_membership.source_format=11
    ), matched AS MATERIALIZED (
      SELECT probe.id,wanted.sub_batch FROM owner_parents parent
        CROSS JOIN LATERAL (
          SELECT probed.id FROM ${s}.typed_telemetry_records probed
           WHERE parent.format=10 AND probed.format=10 AND probed.device_id=parent.parent_id AND probed.stream=$3
             AND probed.occurrence_id=ANY(${requested})
          UNION ALL
          SELECT probed.id FROM ${s}.typed_telemetry_records probed
           WHERE parent.format=11 AND probed.format=11 AND probed.manifest_id=parent.parent_id AND probed.stream=$3
             AND probed.occurrence_id=ANY(${requested})
          OFFSET 0
        ) probe JOIN ${s}.typed_telemetry_records matched_record ON matched_record.id=probe.id
      JOIN requested wanted ON wanted.occurrence_id=matched_record.occurrence_id
    )`}, ${expansionChunkProofsSql(s, "matched")},
    ${legacySelectionPairCtesSql(s, "matched", "v11_chunk_proofs")}, direct AS MATERIALIZED (
      SELECT eligible.*,matched.sub_batch FROM matched CROSS JOIN LATERAL (
        ${legacyDirectSql(s, "record.id=matched.id AND record.format=10")}
        OFFSET 0) eligible
       WHERE ${legacyV11CompleteSql("eligible")}
      UNION ALL
      SELECT record.id AS storage_row_id,record.format,record.occurrence_id,record.observed_at_ms,
             record.observed_day,record.canonical_digest,typed_device.original_id AS device_blob,
             NULL::text AS v11_chunk_id,NULL::integer AS v11_chunk_records,matched.sub_batch
        FROM matched
        JOIN ${s}.typed_telemetry_records record ON record.id=matched.id AND record.format=11 AND record.stream=$3
        JOIN ${s}.typed_telemetry_owner_memberships membership ON membership.namespace_id=record.namespace_id
         AND membership.owner_id=record.owner_id AND membership.participant_id=$2 AND membership.source_format=11
        JOIN ${s}.typed_v11_admission_state v11 ON v11.id=1 AND v11.runtime_contract_version=1
         AND v11.source_namespace=membership.source_namespace AND v11.namespace_id=membership.namespace_id
        JOIN ${s}.typed_telemetry_devices typed_device ON typed_device.id=record.device_id
         AND typed_device.namespace_id=record.namespace_id
        JOIN ${s}.typed_v11_record_proofs proof ON proof.typed_record_id=record.id
        JOIN selection_pairs_ok ON selection_pairs_ok.chunk_key=proof.chunk_key
         AND selection_pairs_ok.manifest_key=proof.manifest_key
    ),
    grouped AS MATERIALIZED (
      SELECT min(storage_row_id) AS storage_row_id,sub_batch FROM direct
       GROUP BY sub_batch,device_blob,occurrence_id,observed_at_ms,canonical_digest,format
    ), ranked AS MATERIALIZED (
      SELECT *,row_number() OVER (PARTITION BY sub_batch ORDER BY storage_row_id) AS batch_row FROM grouped
    ), selected AS MATERIALIZED (
      SELECT storage_row_id,sub_batch FROM ranked WHERE batch_row<=${MAX_BATCH_SOURCE_ROWS + 1}
       ORDER BY sub_batch,storage_row_id LIMIT ${EXPANSION_GROUP_ROWS + 1}
    )
    SELECT selected.sub_batch,record.id AS storage_row_id,record.source_row_id,record.format,record.stream,record.occurrence_id,
           record.observed_at_ms,record.canonical_digest,typed_device.original_id AS device_blob,
           provider.value AS provider,identifier.value AS session_id,
           model.value AS model,speed.value AS speed_mode,tier.value AS api_service_tier,
           surface.value AS surface,billing.value AS billing_surface,effort.value AS reasoning_effort,
           scope.value AS agent_scope,outcome.value AS outcome,
           usage.total_input_context_tokens,usage.input_uncached_tokens,usage.input_cache_read_tokens,
           usage.input_cache_write_tokens,usage.output_text_tokens,usage.output_reasoning_tokens,
           usage.output_combined_tokens,
           dimensions_plan.value AS plan_type,dimensions_variant.value AS plan_variant,
           limit_row.value AS limit_id,slot_row.value AS slot,quota.used_percent,
           quota.window_duration_minutes,quota.resets_at_ms,
           attribution.account_basis,attribution.account_track,attribution.plan_basis,
           attribution_plan.value AS attribution_plan_type,attribution.plan_era,
           CASE WHEN record.stream=3 THEN COALESCE((
             SELECT jsonb_object_agg(tool.value,tool_count.count)::text
               FROM ${s}.typed_telemetry_session_tools tool_count
               JOIN ${s}.typed_telemetry_dictionary tool ON tool.id=tool_count.tool_class_id
              WHERE tool_count.record_id=record.id
           ),'{}') ELSE NULL END AS tool_json
      FROM selected
      JOIN ${s}.typed_telemetry_records record ON record.id=selected.storage_row_id
      JOIN ${s}.typed_telemetry_devices typed_device ON typed_device.id=record.device_id
      JOIN ${s}.typed_telemetry_dictionary provider ON provider.id=record.provider_id
      LEFT JOIN ${s}.typed_telemetry_usage usage ON usage.record_id=record.id
      LEFT JOIN ${s}.typed_telemetry_identifiers identifier ON identifier.id=usage.session_id
      LEFT JOIN ${s}.typed_telemetry_dictionary model ON model.id=usage.model_id
      LEFT JOIN ${s}.typed_telemetry_dictionary speed ON speed.id=usage.speed_mode_id
      LEFT JOIN ${s}.typed_telemetry_dictionary tier ON tier.id=usage.api_service_tier_id
      LEFT JOIN ${s}.typed_telemetry_dictionary surface ON surface.id=usage.surface_id
      LEFT JOIN ${s}.typed_telemetry_dictionary billing ON billing.id=usage.billing_surface_id
      LEFT JOIN ${s}.typed_telemetry_dictionary effort ON effort.id=usage.reasoning_effort_id
      LEFT JOIN ${s}.typed_telemetry_dictionary scope ON scope.id=usage.agent_scope_id
      LEFT JOIN ${s}.typed_telemetry_dictionary outcome ON outcome.id=usage.outcome_id
      LEFT JOIN ${s}.typed_telemetry_quota quota ON quota.record_id=record.id
      LEFT JOIN ${s}.typed_telemetry_quota_dimensions dimensions ON dimensions.id=quota.dimensions_id
      LEFT JOIN ${s}.typed_telemetry_dictionary dimensions_plan ON dimensions_plan.id=dimensions.plan_type_id
      LEFT JOIN ${s}.typed_telemetry_dictionary dimensions_variant ON dimensions_variant.id=dimensions.plan_variant_id
      LEFT JOIN ${s}.typed_telemetry_dictionary limit_row ON limit_row.id=quota.limit_id
      LEFT JOIN ${s}.typed_telemetry_dictionary slot_row ON slot_row.id=quota.slot_id
      LEFT JOIN ${s}.typed_telemetry_attributions attribution
        ON attribution.id=COALESCE(usage.attribution_id,dimensions.attribution_id)
      LEFT JOIN ${s}.typed_telemetry_dictionary attribution_plan ON attribution_plan.id=attribution.plan_type_id
     ORDER BY selected.sub_batch,record.id`;
}

interface LegacyRow {
  readonly storage_row_id: unknown; readonly source_row_id: unknown; readonly format: unknown; readonly stream: unknown;
  readonly occurrence_id: unknown; readonly observed_at_ms: unknown; readonly canonical_digest: unknown;
  readonly device_blob: unknown; readonly provider: unknown; readonly session_id: unknown;
  readonly model: unknown; readonly speed_mode: unknown; readonly api_service_tier: unknown; readonly surface: unknown;
  readonly billing_surface: unknown; readonly reasoning_effort: unknown; readonly agent_scope: unknown;
  readonly outcome: unknown; readonly total_input_context_tokens: unknown; readonly input_uncached_tokens: unknown;
  readonly input_cache_read_tokens: unknown; readonly input_cache_write_tokens: unknown;
  readonly output_text_tokens: unknown; readonly output_reasoning_tokens: unknown;
  readonly output_combined_tokens: unknown; readonly plan_type: unknown; readonly plan_variant: unknown;
  readonly limit_id: unknown; readonly slot: unknown; readonly used_percent: unknown;
  readonly window_duration_minutes: unknown; readonly resets_at_ms: unknown; readonly account_basis: unknown;
  readonly account_track: unknown; readonly plan_basis: unknown; readonly attribution_plan_type: unknown;
  readonly plan_era: unknown; readonly tool_json: unknown;
}

function legacyAttribution(row: LegacyRow, format: "v1" | "v11", stream: EffectiveTelemetryStream): TelemetryV11Attribution | null {
  const present = row.account_basis !== null;
  if (format === "v1" || stream === "session") {
    if (present) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
    return null;
  }
  if (!present) return sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  const accountBasis = ACCOUNT_BASES[safeInteger(row.account_basis, 0, 2)]!;
  const planBasis = PLAN_BASES[safeInteger(row.plan_basis, 0, 3)]!;
  const track = bytes(row.account_track);
  const era = bytes(row.plan_era);
  return {
    accountBasis,
    accountTrackId: track.length === 0 ? null : decodeTypedTelemetryId(track),
    planBasis,
    planType: text(row.attribution_plan_type, 64),
    planEraId: era.length === 0 ? null : decodeTypedTelemetryId(era),
  } as TelemetryV11Attribution;
}

function sessionTools(value: unknown): Record<string, number> {
  if (typeof value !== "string") return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(parsed as Record<string, unknown>)) {
    result[key] = safeInteger(count, 0, 1_000_000_000);
  }
  return result;
}

/**
 * Decode one typed legacy row into the fields the vendored kernels read from
 * a TypedTelemetryCompatibilityRecord (format, source_row_id, stream,
 * occurrence_id, observed_at, record_json), after verifying its canonical
 * digest exactly as the D1 compatibility reader does.
 */
async function decodeLegacyRow(row: LegacyRow, participantId: string, sourceNamespace: string,
  stream: EffectiveTelemetryStream): Promise<TypedTelemetryCompatibilityRecord> {
  const formatCode = safeInteger(row.format, 10, 11);
  const format = formatCode === 10 ? "v1" : "v11";
  if (safeInteger(row.stream, 1, 3) !== STREAM_CODES[stream] || typeof row.provider !== "string") {
    sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  const observedAtMs = safeInteger(row.observed_at_ms, MIN_MS, MAX_MS);
  const fields: TypedTelemetryFields = {
    format, stream, occurrenceId: bytes(row.occurrence_id), observedAtMs, provider: text(row.provider, 64),
    attribution: legacyAttribution(row, format, stream), usage: null, quota: null, tools: null,
  };
  if (stream === "usage") {
    fields.usage = {
      sessionId: bytes(row.session_id),
      modelId: text(row.model, 64), speedMode: text(row.speed_mode, 64), apiServiceTier: text(row.api_service_tier, 64),
      surface: text(row.surface, 64), billingSurface: text(row.billing_surface, 64),
      reasoningEffort: text(row.reasoning_effort, 64), agentScope: text(row.agent_scope, 64), outcome: text(row.outcome, 64),
      totalInputContextTokens: nullableInteger(row.total_input_context_tokens),
      components: {
        inputUncachedTokens: nullableInteger(row.input_uncached_tokens),
        inputCacheReadTokens: nullableInteger(row.input_cache_read_tokens),
        inputCacheWriteTokens: nullableInteger(row.input_cache_write_tokens),
        outputTextTokens: nullableInteger(row.output_text_tokens),
        outputReasoningTokens: nullableInteger(row.output_reasoning_tokens),
        outputCombinedTokens: nullableInteger(row.output_combined_tokens),
      },
    };
  } else if (stream === "quota") {
    const usedPercent = row.used_percent === null ? null : Number(row.used_percent);
    if (usedPercent !== null && !Number.isFinite(usedPercent)) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
    fields.quota = {
      planType: text(row.plan_type, 64), planVariant: text(row.plan_variant, 64),
      limitId: text(row.limit_id, 64), slot: text(row.slot, 64), usedPercent,
      windowDurationMinutes: nullableInteger(row.window_duration_minutes, 527_040),
      resetsAtMs: row.resets_at_ms === null ? null : safeInteger(row.resets_at_ms, MIN_MS, MAX_MS),
    };
  } else {
    fields.tools = sessionTools(row.tool_json);
  }
  let canonical: ReturnType<typeof typedTelemetryCanonicalRecords>;
  try {
    canonical = typedTelemetryCanonicalRecords(fields);
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  if (await sha256Hex(canonical.canonicalRecord) !== hex(row.canonical_digest)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  const sourceRowId = safeInteger(row.source_row_id, 1);
  // Only the fields the vendored reconcileGroups/genericOccurrence/
  // genericRecordJson read are populated; the rest of the D1 view's columns
  // are not analytical inputs.
  return Object.freeze({
    source_namespace: sourceNamespace,
    format,
    source_row_id: sourceRowId,
    id: sourceRowId,
    participant_id: participantId,
    device_id: decodeTypedTelemetryId(bytes(row.device_blob)),
    stream,
    occurrence_id: occurrenceText(row.occurrence_id),
    observed_at_ms: observedAtMs,
    observed_at: new Date(observedAtMs).toISOString(),
    record_json: canonical.canonicalRecord,
  }) as unknown as TypedTelemetryCompatibilityRecord;
}

// ---------------------------------------------------------------------------
// v1.2 typed sources (d43c8f92 telemetry-v12-effective-reader.ts)
// ---------------------------------------------------------------------------

function v12SourceJoins(s: string): string {
  return `JOIN ${s}.telemetry_v12_day_manifests manifest ON manifest.id=domain_day.manifest_id
      AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id
      AND manifest.chunk_day=domain_day.observed_day AND manifest.manifest_digest=domain_day.manifest_digest
      AND manifest.state='ready'
    JOIN ${s}.telemetry_v12_chunks chunk ON chunk.manifest_id=manifest.id
      AND chunk.participant_id=generation.participant_id AND chunk.device_id=generation.device_id
      AND chunk.chunk_day=manifest.chunk_day AND chunk.stream=$2
      AND chunk.record_count=(SELECT count(*) FROM ${s}.telemetry_v12_typed_records complete
        WHERE complete.chunk_id=chunk.id)
    JOIN ${s}.telemetry_v12_typed_records r ON r.chunk_id=chunk.id AND r.manifest_id=manifest.id AND r.stream=$2
    JOIN (${v12RetainedAuthorizationScopeSql(s, "$3::timestamptz", "reader")}) retained_auth
      ON retained_auth.participant_id=generation.participant_id AND retained_auth.device_id=generation.device_id`;
}

/** $1 participant, $2 stream, $3 now, $4/$5 first/last day. */
function v12CandidatesSql(s: string): string {
  return `SELECT (domain_day.observed_day-DATE '1970-01-01')::integer AS observed_day,r.occurrence_id,
          min(r.observed_at_ms)::text AS observed_at_ms
     FROM ${s}.telemetry_v12_domains generation
     JOIN ${s}.telemetry_v12_domain_days domain_day ON domain_day.generation_id=generation.id
      AND domain_day.observed_day BETWEEN $4::date AND $5::date
     ${v12SourceJoins(s)}
    WHERE generation.participant_id=$1
    GROUP BY domain_day.observed_day,r.occurrence_id`;
}

/**
 * $1 participant, $2 stream, $3 now, $4 occurrence ids (hex text[]), $5 limit.
 *
 * The selection is production's: every record of a requested occurrence and
 * stream in a complete chunk of a ready manifest of the participant's
 * owner-linked generation on a retained authorization. The statement is
 * shaped so its cost follows the batch, not the owner. No index leads with
 * occurrence_id, and the planner's estimate of the chunk-completeness chain
 * collapses to one row, so an unfenced join walks every record of the owner
 * for each 200-id batch (about 1.7 s a batch for a 300,000-record owner: a
 * read quadratic in owner size). Here the participant's ready manifests are
 * fenced first, each is probed once on its (manifest_id, stream,
 * occurrence_id) key for the batch's ids, and each matched record is then
 * checked against the same joins in a fenced LATERAL (OFFSET 0 keeps it per
 * record). The manifest filter is implied by the joins it precedes
 * (manifest.participant_id = chunk.participant_id =
 * generation.participant_id = $1, state ready), so the rows, their
 * multiplicity and the grouping below are unchanged.
 */
function v12OccurrencesSql(s: string): string {
  return `WITH requested AS MATERIALIZED (
      SELECT decode(value,'hex') AS occurrence_id,((ordinal-1)/${EXPANSION_BATCH})::integer AS sub_batch
        FROM unnest($4::text[]) WITH ORDINALITY AS input(value,ordinal)
    ), owner_manifests AS MATERIALIZED (
      SELECT owned.id FROM ${s}.telemetry_v12_day_manifests owned
       WHERE owned.participant_id=$1 AND owned.state='ready'
    ), matched AS MATERIALIZED (
      SELECT probe.id,wanted.sub_batch FROM owner_manifests owned
        CROSS JOIN LATERAL (
          SELECT r.id FROM ${s}.telemetry_v12_typed_records r
           WHERE r.manifest_id=owned.id AND r.stream=$2
             AND r.occurrence_id=ANY(ARRAY(SELECT wanted.occurrence_id FROM requested wanted))
          OFFSET 0
        ) probe JOIN ${s}.telemetry_v12_typed_records matched_record ON matched_record.id=probe.id
      JOIN requested wanted ON wanted.occurrence_id=matched_record.occurrence_id
    ), retained_auth AS MATERIALIZED (
      ${v12RetainedAuthorizationScopeSql(s, "$3::timestamptz", "reader")}
    ), eligible AS MATERIALIZED (
      SELECT matched.sub_batch,r.id,r.occurrence_id,r.observed_at_ms,r.canonical_digest,scope.source_device_id
        FROM matched
        JOIN ${s}.telemetry_v12_typed_records r ON r.id=matched.id
        CROSS JOIN LATERAL (
          SELECT generation.device_id AS source_device_id
            FROM ${s}.telemetry_v12_chunks chunk
            JOIN ${s}.telemetry_v12_day_manifests manifest ON manifest.id=r.manifest_id
             AND manifest.participant_id=chunk.participant_id AND manifest.device_id=chunk.device_id
             AND manifest.state='ready'
            JOIN ${s}.telemetry_v12_domain_days domain_day ON domain_day.manifest_id=manifest.id
             AND domain_day.manifest_digest=manifest.manifest_digest
            JOIN ${s}.telemetry_v12_domains generation ON generation.id=domain_day.generation_id
             AND generation.participant_id=chunk.participant_id AND generation.device_id=chunk.device_id
            JOIN retained_auth ON retained_auth.participant_id=generation.participant_id
             AND retained_auth.device_id=generation.device_id
           WHERE chunk.id=r.chunk_id AND chunk.manifest_id=r.manifest_id AND chunk.stream=$2
             AND chunk.record_count=(SELECT count(*) FROM ${s}.telemetry_v12_typed_records complete
               WHERE complete.chunk_id=chunk.id)
             AND generation.participant_id=$1
          OFFSET 0
        ) scope
    ), grouped AS MATERIALIZED (
      SELECT min(id) AS id,sub_batch FROM eligible
       GROUP BY sub_batch,source_device_id,occurrence_id,observed_at_ms,canonical_digest
    ), ranked AS MATERIALIZED (
      SELECT *,row_number() OVER (PARTITION BY sub_batch ORDER BY id) AS batch_row FROM grouped
    ), selected AS MATERIALIZED (
      SELECT id,sub_batch FROM ranked WHERE batch_row<=$5
       ORDER BY sub_batch,id LIMIT ${EXPANSION_GROUP_ROWS + 1}
    )
    SELECT selected.sub_batch,selected.id::text AS storage_row_id,r.manifest_id,r.record_index,
           r.stream,r.occurrence_id,r.observed_at_ms,r.observed_day,r.canonical_digest,
           provider.value AS provider,
           u.session_id,model.value AS model,speed.value AS speed_mode,
           tier.value AS api_service_tier,surface.value AS surface,
           billing.value AS billing_surface,effort.value AS reasoning_effort,
           scope.value AS agent_scope,outcome.value AS outcome,
           u.total_input_context_tokens,u.input_uncached_tokens,u.input_cache_read_tokens,
           u.input_cache_write_tokens,u.output_text_tokens,u.output_reasoning_tokens,u.output_combined_tokens,
           u.boundary_flags,u.tie_order,u.cache_write_ttl_five_minute_tokens,u.cache_write_ttl_one_hour_tokens,
           qplan.value AS plan_type,qvariant.value AS plan_variant,qlimit.value AS limit_id,qslot.value AS slot,
           q.used_percent,q.window_duration_minutes,q.resets_at_ms,
           COALESCE(ua.account_basis,qa.account_basis) AS account_basis,
           COALESCE(ua.account_track,qa.account_track) AS account_track,
           COALESCE(ua.plan_basis,qa.plan_basis) AS plan_basis,
           COALESCE(uaplan.value,qaplan.value) AS attribution_plan_type,
           COALESCE(ua.plan_era,qa.plan_era) AS plan_era,
           CASE WHEN r.stream='session' THEN COALESCE((
             SELECT jsonb_object_agg(tool.value,session_tool.count)::text
               FROM ${s}.telemetry_v12_typed_session_tools session_tool
               JOIN ${s}.typed_telemetry_dictionary tool ON tool.id=session_tool.tool_class_id
              WHERE session_tool.record_id=r.id),'{}') ELSE NULL END AS tool_json
      FROM selected
      JOIN ${s}.telemetry_v12_typed_records r ON r.id=selected.id
      JOIN ${s}.typed_telemetry_dictionary provider ON provider.id=r.provider_id
      LEFT JOIN ${s}.telemetry_v12_typed_usage u ON u.record_id=r.id
      LEFT JOIN ${s}.typed_telemetry_dictionary model ON model.id=u.model_id
      LEFT JOIN ${s}.typed_telemetry_dictionary speed ON speed.id=u.speed_mode_id
      LEFT JOIN ${s}.typed_telemetry_dictionary tier ON tier.id=u.api_service_tier_id
      LEFT JOIN ${s}.typed_telemetry_dictionary surface ON surface.id=u.surface_id
      LEFT JOIN ${s}.typed_telemetry_dictionary billing ON billing.id=u.billing_surface_id
      LEFT JOIN ${s}.typed_telemetry_dictionary effort ON effort.id=u.reasoning_effort_id
      LEFT JOIN ${s}.typed_telemetry_dictionary scope ON scope.id=u.agent_scope_id
      LEFT JOIN ${s}.typed_telemetry_dictionary outcome ON outcome.id=u.outcome_id
      LEFT JOIN ${s}.telemetry_v12_typed_attributions ua ON ua.id=u.attribution_id
      LEFT JOIN ${s}.typed_telemetry_dictionary uaplan ON uaplan.id=ua.plan_type_id
      LEFT JOIN ${s}.telemetry_v12_typed_quota q ON q.record_id=r.id
      LEFT JOIN ${s}.typed_telemetry_dictionary qplan ON qplan.id=q.plan_type_id
      LEFT JOIN ${s}.typed_telemetry_dictionary qvariant ON qvariant.id=q.plan_variant_id
      LEFT JOIN ${s}.typed_telemetry_dictionary qlimit ON qlimit.id=q.limit_id
      LEFT JOIN ${s}.typed_telemetry_dictionary qslot ON qslot.id=q.slot_id
      LEFT JOIN ${s}.telemetry_v12_typed_attributions qa ON qa.id=q.attribution_id
      LEFT JOIN ${s}.typed_telemetry_dictionary qaplan ON qaplan.id=qa.plan_type_id
     ORDER BY selected.sub_batch,r.occurrence_id,r.observed_at_ms,r.manifest_id COLLATE "C",r.record_index`;
}

/** d43c8f92 telemetry-v12-effective-reader.ts normalizeV12Record. */
function v12AnalyticalRecord(stream: EffectiveTelemetryStream, value: TelemetryV12Record): string {
  const projected: Record<string, unknown> = { ...(value as unknown as Record<string, unknown>) };
  if (stream === "usage") {
    projected.schemaVersion = "usage-event-v1.1";
    delete projected.boundaryFlags;
    delete projected.tieOrder;
    delete projected.cacheWriteTtl;
  } else {
    projected.schemaVersion = stream === "quota" ? "quota-observation-v1.1" : "session-dimension-v1.1";
  }
  try {
    return canonicalTelemetryV11Json(parseTelemetryV11Record(stream, projected) as TelemetryV11Record);
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
}

type V12StorageRow = Record<string, unknown>;

/** d43c8f92 telemetry-v12-effective-reader.ts decodedRow, over 0025's columns. */
async function decodeV12Row(stream: EffectiveTelemetryStream, row: V12StorageRow): Promise<TelemetryV12EffectiveRecord> {
  const storageRowId = safeInteger(row.storage_row_id, 1);
  if (typeof row.manifest_id !== "string" || !/^[0-9a-f-]{36}$/iu.test(row.manifest_id)
      || row.stream !== stream) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  safeInteger(row.record_index, 0, 199);
  const typed = {
    ...row,
    occurrence_id: bytes(row.occurrence_id),
    observed_at_ms: safeInteger(row.observed_at_ms, MIN_MS, MAX_MS),
    observed_day: safeInteger(row.observed_day, -100_000, 100_000),
    canonical_digest: bytes(row.canonical_digest),
    session_id: row.session_id === null || row.session_id === undefined ? null : bytes(row.session_id),
    total_input_context_tokens: nullableInteger(row.total_input_context_tokens),
    input_uncached_tokens: nullableInteger(row.input_uncached_tokens),
    input_cache_read_tokens: nullableInteger(row.input_cache_read_tokens),
    input_cache_write_tokens: nullableInteger(row.input_cache_write_tokens),
    output_text_tokens: nullableInteger(row.output_text_tokens),
    output_reasoning_tokens: nullableInteger(row.output_reasoning_tokens),
    output_combined_tokens: nullableInteger(row.output_combined_tokens),
    cache_write_ttl_five_minute_tokens: nullableInteger(row.cache_write_ttl_five_minute_tokens),
    cache_write_ttl_one_hour_tokens: nullableInteger(row.cache_write_ttl_one_hour_tokens),
    used_percent: row.used_percent === null ? null : Number(row.used_percent),
    window_duration_minutes: nullableInteger(row.window_duration_minutes, 527_040),
    resets_at_ms: row.resets_at_ms === null ? null : safeInteger(row.resets_at_ms, MIN_MS, MAX_MS),
    account_basis: row.account_basis === null ? null : safeInteger(row.account_basis, 0, 2),
    account_track: row.account_track === null || row.account_track === undefined ? null : bytes(row.account_track),
    plan_basis: row.plan_basis === null ? null : safeInteger(row.plan_basis, 0, 3),
    plan_era: row.plan_era === null || row.plan_era === undefined ? null : bytes(row.plan_era),
  } as unknown as TelemetryV12TypedRecordRow;
  let decoded: ReturnType<typeof decodeTelemetryV12Record>;
  try {
    decoded = decodeTelemetryV12Record(typed, stream === "session" ? sessionTools(row.tool_json) : null);
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  if (hex(typed.canonical_digest) !== await sha256Hex(decoded.canonicalRecord)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  let sourceRecord: TelemetryV12Record;
  try {
    sourceRecord = JSON.parse(decoded.canonicalRecord) as TelemetryV12Record;
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  const record = sourceRecord as unknown as Record<string, unknown>;
  const occurrenceId = stream === "usage" ? record.eventId : stream === "quota" ? record.observationId : record.sessionUuid;
  if (typeof occurrenceId !== "string" || !OCCURRENCE_ID.test(occurrenceId)
      || occurrenceId !== occurrenceText(typed.occurrence_id)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  const observedAtMs = safeInteger(decoded.observedAtMs, MIN_MS, MAX_MS);
  if (Math.floor(observedAtMs / DAY_MS) !== typed.observed_day) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  return Object.freeze({
    stream, occurrenceId, observedAt: new Date(observedAtMs).toISOString(), observedAtMs,
    sourceRecordJson: decoded.canonicalRecord,
    recordJson: v12AnalyticalRecord(stream, sourceRecord),
    sourceRecordKey: `v12:record:${storageRowId}`,
  }) as TelemetryV12EffectiveRecord;
}

// ---------------------------------------------------------------------------
// Usage-correction facts (d43c8f92 telemetry-usage-correction-repository.ts)
// ---------------------------------------------------------------------------

/** $1 owner digest hex, $2/$3 event-time window [from, through). */
function correctionCandidatesSql(s: string): string {
  return `SELECT div(h.event_time_ms,${DAY_MS})::integer AS observed_day,h.occurrence_id,
          min(h.event_time_ms)::text AS observed_at_ms
     FROM ${s}.telemetry_usage_correction_history h
     JOIN ${s}.telemetry_usage_correction_facts f ON f.history_id=h.id
    WHERE h.owner_digest=decode($1,'hex') AND h.event_time_ms>=$2 AND h.event_time_ms<$3
    GROUP BY div(h.event_time_ms,${DAY_MS}),h.occurrence_id`;
}

/** $1 owner digest hex, $2 occurrence ids (hex text[]), $3 limit. */
function correctionVariantsSql(s: string): string {
  return `WITH requested AS MATERIALIZED (
      SELECT decode(value,'hex') AS occurrence_id,((ordinal-1)/${EXPANSION_BATCH})::integer AS sub_batch
        FROM unnest($2::text[]) WITH ORDINALITY AS input(value,ordinal)
    ), representatives AS MATERIALIZED (
      SELECT min(f.id) AS fact_id,wanted.sub_batch
        FROM ${s}.telemetry_usage_correction_history h
        JOIN ${s}.telemetry_usage_correction_facts f ON f.history_id=h.id AND f.method_version=1
       JOIN requested wanted ON wanted.occurrence_id=h.occurrence_id
       WHERE h.owner_digest=decode($1,'hex')
       GROUP BY wanted.sub_batch,h.source_format,h.device_id,h.occurrence_id,h.event_time_ms,h.record_digest
    ), ranked AS MATERIALIZED (
      SELECT *,row_number() OVER (PARTITION BY sub_batch ORDER BY fact_id) AS batch_row FROM representatives
    ), selected AS MATERIALIZED (
      SELECT fact_id,sub_batch FROM ranked WHERE batch_row<=$3
       ORDER BY sub_batch,fact_id
    )
    SELECT selected.sub_batch,h.*,f.id AS fact_id,f.method_version AS fact_method_version,f.captured_at_ms AS fact_captured_at_ms,
           provider.value AS provider_value,session.value AS session_blob,model.value AS model_value,
           speed.value AS speed_mode_value,tier.value AS api_service_tier_value,surface.value AS surface_value,
           billing.value AS billing_surface_value,effort.value AS reasoning_effort_value,
           scope.value AS agent_scope_value,outcome.value AS outcome_value,
           attribution.account_basis AS attribution_account_basis,
           attribution.account_track AS attribution_account_track_blob,
           attribution.plan_basis AS attribution_plan_basis,
           attribution_plan.value AS attribution_plan_type_value,
           attribution.plan_era AS attribution_plan_era_blob
      FROM selected
      JOIN ${s}.telemetry_usage_correction_facts f ON f.id=selected.fact_id AND f.method_version=1
      JOIN ${s}.telemetry_usage_correction_history h ON h.id=f.history_id
      JOIN ${s}.typed_telemetry_dictionary provider ON provider.id=h.provider_id
      JOIN ${s}.typed_telemetry_identifiers session ON session.id=h.session_id
      JOIN ${s}.typed_telemetry_dictionary model ON model.id=h.model_id
      JOIN ${s}.typed_telemetry_dictionary speed ON speed.id=h.speed_mode_id
      JOIN ${s}.typed_telemetry_dictionary tier ON tier.id=h.api_service_tier_id
      JOIN ${s}.typed_telemetry_dictionary surface ON surface.id=h.surface_id
      JOIN ${s}.typed_telemetry_dictionary billing ON billing.id=h.billing_surface_id
      JOIN ${s}.typed_telemetry_dictionary effort ON effort.id=h.reasoning_effort_id
      JOIN ${s}.typed_telemetry_dictionary scope ON scope.id=h.agent_scope_id
      JOIN ${s}.typed_telemetry_dictionary outcome ON outcome.id=h.outcome_id
      LEFT JOIN ${s}.typed_telemetry_attributions attribution ON attribution.id=h.attribution_id
      LEFT JOIN ${s}.typed_telemetry_dictionary attribution_plan ON attribution_plan.id=attribution.plan_type_id
     ORDER BY selected.sub_batch,f.id LIMIT ${EXPANSION_GROUP_ROWS + 1}`;
}

function nullableId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const blob = bytes(value);
  return blob.length === 0 ? null : decodeTypedTelemetryId(blob);
}

/** d43c8f92 parseHistory/parseFact: rebuild, rehash and verify the source bytes. */
async function parseCorrectionFact(row: Record<string, unknown>): Promise<TelemetryUsageCorrectionFactRow> {
  const format = safeInteger(row.source_format, 10, 11) === 10 ? "v1" : "v11";
  const eventTimeMs = safeInteger(row.event_time_ms, MIN_MS, MAX_MS);
  const record: Record<string, unknown> = {
    schemaVersion: format === "v1" ? "usage-event-v1.0" : "usage-event-v1.1",
    eventId: occurrenceText(row.occurrence_id),
    eventTime: new Date(eventTimeMs).toISOString(),
    sessionUuid: decodeTypedTelemetryId(bytes(row.session_blob)),
    provider: text(row.provider_value, 64), modelId: text(row.model_value, 64),
    speedMode: text(row.speed_mode_value, 64), apiServiceTier: text(row.api_service_tier_value, 64),
    surface: text(row.surface_value, 64), billingSurface: text(row.billing_surface_value, 64),
    reasoningEffort: text(row.reasoning_effort_value, 64), agentScope: text(row.agent_scope_value, 64),
    outcome: text(row.outcome_value, 64), totalInputContextTokens: nullableInteger(row.total_input_context_tokens),
    components: {
      inputUncachedTokens: nullableInteger(row.input_uncached_tokens),
      inputCacheReadTokens: nullableInteger(row.input_cache_read_tokens),
      inputCacheWriteTokens: nullableInteger(row.input_cache_write_tokens),
      outputTextTokens: nullableInteger(row.output_text_tokens),
      outputReasoningTokens: nullableInteger(row.output_reasoning_tokens),
      outputCombinedTokens: nullableInteger(row.output_combined_tokens),
    },
  };
  if (format === "v11") {
    record.accountPlanAttribution = {
      accountBasis: ACCOUNT_BASES[safeInteger(row.attribution_account_basis, 0, 2)],
      accountTrackId: nullableId(row.attribution_account_track_blob),
      planBasis: PLAN_BASES[safeInteger(row.attribution_plan_basis, 0, 3)],
      planType: text(row.attribution_plan_type_value, 64),
      planEraId: nullableId(row.attribution_plan_era_blob),
    };
  }
  const recordJson = canonicalTelemetryV11Json(record);
  let assertion: Awaited<ReturnType<typeof prepareAnalyticsReplayUsageCorrectionAssertion>>;
  try {
    assertion = await prepareAnalyticsReplayUsageCorrectionAssertion({ format, recordJson });
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  if (assertion.recordDigest !== hex(row.record_digest) || assertion.baseDigest !== hex(row.base_digest)
      || safeInteger(row.fact_method_version, 1, 1) !== 1) {
    sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  const historyId = safeInteger(row.id, 1);
  // The fields reconcileGroups reads: id, source.format, source.occurrenceId
  // and recordJson. The remaining audit fields are filled from the same row.
  return Object.freeze({
    id: safeInteger(row.fact_id, 1),
    sourceHistoryId: historyId,
    participantId: text(row.participant_id),
    ownerDigest: hex(row.owner_digest),
    ownerRevision: safeInteger(row.owner_revision, 1),
    authorityEpoch: safeInteger(row.authority_epoch, 1),
    source: Object.freeze({
      format, namespaceId: safeInteger(row.namespace_id, 1), ownerId: safeInteger(row.owner_id, 1),
      deviceId: safeInteger(row.device_id, 1), chunkId: safeInteger(row.chunk_id, 1), manifestId: null,
      storageRowId: safeInteger(row.source_storage_row_id, 1), rowId: safeInteger(row.source_row_id, 1),
      occurrenceId: assertion.occurrenceId, eventTime: assertion.eventTime,
      chunkDigest: hex(row.source_chunk_digest), eventDigest: hex(row.source_event_digest),
      recordDigest: assertion.recordDigest, baseDigest: assertion.baseDigest,
    }),
    totalInputContextTokens: nullableInteger(row.total_input_context_tokens),
    outputCombinedTokens: nullableInteger(row.output_combined_tokens),
    recordJson,
    methodVersion: "usage-total-correction-v1",
    capturedAt: new Date(safeInteger(row.fact_captured_at_ms, 0, MAX_MS)).toISOString(),
  }) as TelemetryUsageCorrectionFactRow;
}

// ---------------------------------------------------------------------------
// Prepared statements (K-READ)
// ---------------------------------------------------------------------------

/**
 * The statements a reader call issues once per call or once per 200-id batch,
 * prepared per connection (owners.ts analyticsV2PreparedStatement). The
 * candidate, count and first-evidence statements stay unnamed: they run once
 * per span with range parameters a generic plan could misjudge.
 */
interface ReaderStatements {
  readonly scope: AnalyticsV2PreparedStatement;
  readonly legacySources: AnalyticsV2PreparedStatement;
  readonly legacyOwnerSources: AnalyticsV2PreparedStatement;
  readonly v12Sources: AnalyticsV2PreparedStatement;
  readonly correctionSources: AnalyticsV2PreparedStatement;
}

const READER_STATEMENT_SCHEMAS = 64;
const readerStatementCache = new Map<string, Promise<ReaderStatements>>();

/** The prepared statements for quoted schema `s` (a pure function of `s`, cached). */
function readerStatements(s: string): Promise<ReaderStatements> {
  let cached = readerStatementCache.get(s);
  if (cached === undefined) {
    if (readerStatementCache.size >= READER_STATEMENT_SCHEMAS) readerStatementCache.clear();
    cached = (async () => Object.freeze({
      scope: await analyticsV2PreparedStatement("occurrences.scope", ownerScopeSql(s)),
      legacySources: await analyticsV2PreparedStatement("occurrences.legacy_sources", legacySourcesSql(s)),
      legacyOwnerSources: await analyticsV2PreparedStatement("occurrences.legacy_sources", legacySourcesSql(s, true)),
      v12Sources: await analyticsV2PreparedStatement("occurrences.v12_sources", v12OccurrencesSql(s)),
      correctionSources: await analyticsV2PreparedStatement("occurrences.correction_sources", correctionVariantsSql(s)),
    }))();
    readerStatementCache.set(s, cached);
  }
  return cached;
}

/** Raw driver rows are clone-friendly; only the SQL ordinal is a helper. */
interface RawExpansionBatch {
  readonly ids: readonly string[];
  readonly legacy: LegacyRow[];
  readonly v12: V12StorageRow[];
  readonly facts: Record<string, unknown>[];
}

function expansionOrdinal(row: object, count: number): number {
  return safeInteger((row as Record<string, unknown>).sub_batch, 0, count - 1);
}

function stripExpansionOrdinal<Row extends object>(row: Row): Row {
  const { sub_batch: _ordinal, ...source } = row as Record<string, unknown>;
  return source as Row;
}

/**
 * Fetch UNION ALL logical batches with SQL bounds, yielding only complete
 * leading batches. A G+1 result's final ordinal is incomplete; reissue it.
 * Each family holds <=G+1 rows; a logical batch holds <=40,001 per family.
 * A failing grouped SQL statement is rolled back to a read-only savepoint and
 * reissued at the old 200-id granularity; cancellation is terminal. Per-batch
 * SQL errors are deferred by family, preserving preceding decode refusals. No query or snapshot work escapes this iterator.
 */
async function* fetchRawExpansion(client: PostgresClient, s: string, now: string, scope: OwnerScope,
  ownerDigest: string, stream: EffectiveTelemetryStream, occurrenceIds: readonly string[],
  corrections: boolean, expandV12: boolean): AsyncGenerator<RawExpansionBatch> {
  const statements = await readerStatements(s);
  for (const group of chunks(occurrenceIds, EXPANSION_GROUP_IDS)) {
    const batches = chunks(group, EXPANSION_BATCH);
    let first = 0;
    let singleBatch = false;
    while (first < batches.length) {
      const remaining = batches.slice(first, singleBatch ? first + 1 : batches.length);
      const savepoint = remaining.length > 1;
      if (savepoint) await client.query(analyticsV2Statement("snapshot.control", "SAVEPOINT analytics_v2_expansion"));
      let queryFailure: unknown;
      const encoded = remaining.flat().map(occurrenceHex);
      // Fetch in legacy/v12/correction order; hold failures until the same
      // logical position at which the old per-batch reader would see them.
      const result = async <Row extends object>(active: boolean, statement: AnalyticsV2PreparedStatement,
        binds: unknown[]): Promise<{ rows: Row[]; error?: unknown }> => {
        if (!active || queryFailure !== undefined) return { rows: [] };
        try { return await queryPrepared<Row>(client, statement, binds); }
        catch (error) { queryFailure = error; return { rows: [], error }; }
      };
      const legacy = await result<LegacyRow>(scope.v1Namespace !== null || scope.v11Namespace !== null,
        (scope.legacyOwnerIndexReady ? statements.legacyOwnerSources : statements.legacySources), [ownerDigest, scope.participantId, STREAM_CODES[stream], stream, encoded]);
      const v12 = await result<V12StorageRow>(expandV12 && scope.v12ReadyManifests,
        statements.v12Sources, [scope.participantId, stream, now, encoded, MAX_BATCH_V12_ROWS + 1]);
      const facts = await result<Record<string, unknown>>(corrections && scope.correctionFactsPresent,
        statements.correctionSources, [ownerDigest, encoded, MAX_BATCH_SOURCE_ROWS + 1]);
      if (savepoint) {
        if (queryFailure !== undefined) {
          await client.query(analyticsV2Statement("snapshot.control", "ROLLBACK TO SAVEPOINT analytics_v2_expansion"));
        }
        await client.query(analyticsV2Statement("snapshot.control", "RELEASE SAVEPOINT analytics_v2_expansion"));
      }
      if (queryFailure !== undefined && savepoint) {
        // Cancellation and lock timeouts are operational failures, not source
        // defects. Preserve them without starting another bounded SQL attempt.
        const cancelled = queryFailure as { code?: unknown };
        if (cancelled?.code === "57014" || cancelled?.code === "55P03") {
          throw queryFailure;
        }
        // Other SQL defects can belong to a later batch. Re-run the original
        // logical granularity before decoding/refusing.
        singleBatch = true;
        continue;
      }
      let complete = remaining.length;
      for (const family of [legacy, v12, facts]) {
        if (family.rows.length > EXPANSION_GROUP_ROWS + 1) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
        if (family.rows.length > EXPANSION_GROUP_ROWS) {
          complete = Math.min(complete, expansionOrdinal(family.rows.at(-1)!, remaining.length));
        }
      }
      if (complete === 0) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
      const rowsFor = <Row extends object>(family: { rows: Row[]; error?: unknown }, ordinal: number): Row[] => {
        if (family.error !== undefined) throw family.error;
        return family.rows.filter((row) => expansionOrdinal(row, remaining.length) === ordinal)
          .map(stripExpansionOrdinal);
      };
      for (let ordinal = 0; ordinal < complete; ordinal += 1) {
        // Getter errors are raised by the assembler in family precedence.
        yield { ids: remaining[ordinal]!, get legacy() { return rowsFor(legacy, ordinal); },
          get v12() { return rowsFor(v12, ordinal); }, get facts() { return rowsFor(facts, ordinal); } };
      }
      first += complete;
    }
  }
}

interface ExpandedSources {
  readonly direct: Map<string, TypedTelemetryCompatibilityRecord[]>;
  readonly v12: Map<string, TelemetryV12EffectiveRecord[]>;
  readonly facts: Map<string, TelemetryUsageCorrectionFactRow[]>;
}

function pushSource<T>(target: Map<string, T[]>, id: string, value: T): void {
  const group = target.get(id);
  if (group) group.push(value); else target.set(id, [value]);
}

/** Pure decode/verify seam: no driver, transaction or platform operations. */
async function assembleRawExpansion(raw: RawExpansionBatch, scope: OwnerScope, ownerDigest: string,
  stream: EffectiveTelemetryStream, target: ExpandedSources): Promise<void> {
  const requested = new Set(raw.ids);
  const legacy = raw.legacy;
  if (legacy.length > MAX_BATCH_SOURCE_ROWS) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
  const decoded: TypedTelemetryCompatibilityRecord[] = [];
  for (const row of legacy) decoded.push(await decodeLegacyRow(row, scope.participantId,
    scope.v1Namespace ?? scope.v11Namespace ?? "", stream));
  const physical = new Map(legacy.map((row, index) => [decoded[index]!, safeInteger(row.storage_row_id, 1)]));
  decoded.sort((left, right) => compareText(left.occurrence_id, right.occurrence_id)
    || physical.get(left)! - physical.get(right)!);
  for (const row of decoded) {
    if (!requested.has(row.occurrence_id)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
    pushSource(target.direct, row.occurrence_id, row);
  }
  const v12 = raw.v12;
  if (v12.length > MAX_BATCH_V12_ROWS) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
  for (const row of v12) {
    const record = await decodeV12Row(stream, row);
    if (!requested.has(record.occurrenceId)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
    pushSource(target.v12, record.occurrenceId, record);
  }
  const facts = raw.facts;
  if (facts.length > MAX_BATCH_SOURCE_ROWS) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
  for (const row of facts) {
    const fact = await parseCorrectionFact(row);
    if (fact.ownerDigest !== ownerDigest || fact.participantId !== scope.participantId
        || !requested.has(fact.source.occurrenceId)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
    pushSource(target.facts, fact.source.occurrenceId, fact);
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

interface Candidate {
  readonly occurrence_id: string;
  readonly observed_at_ms: number;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return left.observed_at_ms - right.observed_at_ms || compareText(left.occurrence_id, right.occurrence_id);
}

function addCandidates(target: Map<number, Map<string, Candidate>>, rows: readonly Record<string, unknown>[],
  fromDay: number, throughDay: number): void {
  for (const row of rows) {
    const day = safeInteger(row.observed_day, -100_000, 100_000);
    if (day < fromDay || day > throughDay) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
    const candidate = { occurrence_id: occurrenceText(row.occurrence_id),
      observed_at_ms: safeInteger(row.observed_at_ms, MIN_MS, MAX_MS) };
    let byOccurrence = target.get(day);
    if (!byOccurrence) target.set(day, byOccurrence = new Map());
    const previous = byOccurrence.get(candidate.occurrence_id);
    // Production keeps the earliest coordinate of an occurrence on a day.
    if (!previous || compareCandidates(candidate, previous) < 0) byOccurrence.set(candidate.occurrence_id, candidate);
  }
}

function usageRow(row: EffectiveUsageOccurrence): EffectiveTelemetryOccurrence {
  // d43c8f92 readEffectiveTelemetryOwnerDayPage's usage mapping.
  return Object.freeze({
    methodVersion: "effective-telemetry-owner-day-v1" as const, stream: "usage" as const,
    participantId: row.participantId, ownerDigest: row.ownerDigest, occurrenceId: row.occurrenceId,
    eventTime: row.eventTime, eventTimeConflict: row.eventTimeConflict,
    status: row.status === "compatible" ? "compatible" as const : "conflict" as const,
    sourceCount: row.sourceCount, sourceFormats: row.sourceFormats, sourceRowIds: row.sourceRowIds,
    sourceRecordKeys: row.sourceRecordKeys, recordJson: row.analyticalRecordJson,
  });
}

/**
 * The candidates of one owner, stream and day range (step 1 of the module
 * comment), and what step 2 expands: every candidate group across all days.
 * Production expands v1.2 usage sources only for a participant with a v1.2
 * head (readV12EffectiveUsageSources), and v1.2 quota/session sources
 * whenever the v1.2 runtime is active (readEffectiveTelemetryOwnerDayPage).
 */
async function readCandidates(client: PostgresClient, s: string, now: string, scope: OwnerScope, options: {
  readonly ownerDigest: string; readonly stream: EffectiveTelemetryStream; readonly fromDay: number;
  readonly throughDay: number; readonly maxCandidates: number;
}): Promise<{
  candidates: Map<number, Map<string, Candidate>>; corrections: boolean; expandV12: boolean; occurrenceIds: string[];
}> {
  const { ownerDigest, stream, fromDay, throughDay, maxCandidates } = options;
  const participantId = scope.participantId;
  const streamBinds = [ownerDigest, participantId, STREAM_CODES[stream], stream];
  const candidates = new Map<number, Map<string, Candidate>>();
  if (scope.v1Namespace !== null || scope.v11Namespace !== null) {
    const legacy = await client.query<Record<string, unknown>>(
      analyticsV2Statement("occurrences.legacy_candidates", legacyCandidatesSql(s)), [...streamBinds, fromDay, throughDay]);
    addCandidates(candidates, legacy.rows, fromDay, throughDay);
  }
  if (scope.v12HeadActive) {
    const v12 = await client.query<Record<string, unknown>>(
      analyticsV2Statement("occurrences.v12_candidates", v12CandidatesSql(s)),
      [participantId, stream, now, dayFromNumber(fromDay), dayFromNumber(throughDay)]);
    addCandidates(candidates, v12.rows, fromDay, throughDay);
  }
  const corrections = stream === "usage" && scope.correctionActive;
  if (corrections) {
    const archive = await client.query<Record<string, unknown>>(
      analyticsV2Statement("occurrences.correction_candidates", correctionCandidatesSql(s)),
      [ownerDigest, fromDay * DAY_MS, (throughDay + 1) * DAY_MS]);
    addCandidates(candidates, archive.rows, fromDay, throughDay);
  }
  let candidateCount = 0;
  for (const byOccurrence of candidates.values()) candidateCount += byOccurrence.size;
  if (candidateCount > maxCandidates) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
  const expandV12 = stream === "usage" ? scope.v12HeadActive : scope.v12RuntimeActive;
  const occurrenceIds = [...new Set([...candidates.values()].flatMap((byOccurrence) => [...byOccurrence.keys()]))]
    .sort(compareText);
  return { candidates, corrections, expandV12, occurrenceIds };
}

/**
 * Read one owner's effective occurrences for one stream over
 * [fromDay, throughDay], grouped by observed day. Days without candidates
 * are absent from the map (absence is "no evidence", never zero). Throws
 * AnalyticsV2SourceError (closed codes) or the vendored reader's
 * EffectiveUsageReaderError when a source group cannot be reconciled.
 */
export async function readOwnerOccurrences(
  context: AnalyticsV2SnapshotContext,
  options: ReadOwnerOccurrencesOptions,
): Promise<Map<AnalyticsV2Day, EffectiveTelemetryOccurrence[]>> {
  const s = quotedSchema(context.schema);
  const now = nowTimestamp(context.nowMs);
  const { ownerDigest, stream, fromDay, throughDay, maxCandidates } = normalizeOptions(options);
  return onReadSnapshot(context, async (client) => {
    const scope = await readOwnerScope(client, s, ownerDigest);
    const participantId = scope.participantId;
    const sourceNamespace = scope.v1Namespace ?? scope.v11Namespace ?? "";
    const streamBinds = [ownerDigest, participantId, STREAM_CODES[stream], stream];

    // 1. Candidates per observed day.
    const { candidates, corrections, expandV12, occurrenceIds } = await readCandidates(client, s, now, scope,
      { ownerDigest, stream, fromDay, throughDay, maxCandidates });
    const direct = new Map<string, TypedTelemetryCompatibilityRecord[]>();
    const v12 = new Map<string, TelemetryV12EffectiveRecord[]>();
    const facts = new Map<string, TelemetryUsageCorrectionFactRow[]>();
    if (occurrenceIds.length > 0) await withGenericPlans(client, async () => {
      for await (const raw of fetchRawExpansion(client, s, now, scope, ownerDigest, stream,
        occurrenceIds, corrections, expandV12)) {
        await assembleRawExpansion(raw, scope, ownerDigest, stream, { direct, v12, facts });
      }
    });

    return assembleOccurrences(candidates, scope.participantId, ownerDigest, stream, { direct, v12, facts });
  });
}

/** Pure reconciliation seam; preserves candidate coordinate and output key order. */
async function assembleOccurrences(candidates: Map<number, Map<string, Candidate>>, participantId: string,
  ownerDigest: string, stream: EffectiveTelemetryStream, sources: ExpandedSources):
  Promise<Map<AnalyticsV2Day, EffectiveTelemetryOccurrence[]>> {
    const output = new Map<AnalyticsV2Day, EffectiveTelemetryOccurrence[]>();
    for (const day of [...candidates.keys()].sort((left, right) => left - right)) {
      const ordered = [...candidates.get(day)!.values()].sort(compareCandidates);
      const ids = ordered.map((candidate) => candidate.occurrence_id);
      const dayDirect = ids.flatMap((id) => sources.direct.get(id) ?? []);
      const dayV12 = ids.flatMap((id) => sources.v12.get(id) ?? []);
      let rows: EffectiveTelemetryOccurrence[];
      if (stream === "usage") {
        const dayFacts = ids.flatMap((id) => sources.facts.get(id) ?? []).sort((left, right) => left.id - right.id);
        const v12Sources = dayV12.map((record) => ({ source_record_key: record.sourceRecordKey,
          occurrence_id: record.occurrenceId, observed_at: record.observedAt,
          record_json: record.sourceRecordJson, canonical_digest: "" }));
        const reconciled = await reconcileGroups(ownerDigest, participantId, dayFromNumber(day), ordered,
          dayDirect, v12Sources, dayFacts, { jsonParsing: "internal_analytics_replay" });
        rows = reconciled.map(usageRow);
      } else {
        rows = ordered.map((candidate) => genericOccurrence(ownerDigest, participantId, stream, candidate,
          dayDirect, dayV12));
      }
      output.set(dayFromNumber(day), rows);
    }
    return output;
}

/** Renumber a statement's $n parameters by `offset` so several statements share one parameter list. */
function shiftParameters(sql: string, offset: number): string {
  return sql.replace(/\$(\d+)/gu, (_match, index: string) => `$${Number(index) + offset}`);
}

/**
 * The exact number of occurrences readOwnerOccurrences returns for each
 * observed day of [fromDay, throughDay], without expanding or decoding any
 * source: the distinct (observed day, occurrence) candidates of the same
 * selection (v1/v1.1 typed records, v1.2 domain days, and usage-correction
 * facts when the runtime is active), counted in SQL. The reader emits one
 * occurrence per candidate and day, so the analytics-refresh Job uses these
 * counts for its memory guard and read spans before reading anything, and
 * A-2 refuses a load whose counts differ. Days without candidates are absent.
 */
export async function countOwnerOccurrences(
  context: AnalyticsV2SnapshotContext,
  options: Omit<ReadOwnerOccurrencesOptions, "maxCandidates">,
): Promise<Map<AnalyticsV2Day, number>> {
  const s = quotedSchema(context.schema);
  const now = nowTimestamp(context.nowMs);
  const { ownerDigest, stream, fromDay, throughDay } = normalizeOptions({
    ownerDigest: options?.ownerDigest, stream: options?.stream, fromDay: options?.fromDay,
    throughDay: options?.throughDay,
  } as ReadOwnerOccurrencesOptions);
  return onReadSnapshot(context, async (client) => {
    const scope = await readOwnerScope(client, s, ownerDigest);
    const participantId = scope.participantId;
    const sources: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, binds: readonly unknown[]): void => {
      sources.push(`SELECT observed_day,occurrence_id FROM (${shiftParameters(sql, values.length)}) source`);
      values.push(...binds);
    };
    if (scope.v1Namespace !== null || scope.v11Namespace !== null) {
      add(legacyCandidatesSql(s), [ownerDigest, participantId, STREAM_CODES[stream], stream, fromDay, throughDay]);
    }
    if (scope.v12HeadActive) {
      add(v12CandidatesSql(s), [participantId, stream, now, dayFromNumber(fromDay), dayFromNumber(throughDay)]);
    }
    if (stream === "usage" && scope.correctionActive) {
      add(correctionCandidatesSql(s), [ownerDigest, fromDay * DAY_MS, (throughDay + 1) * DAY_MS]);
    }
    const counts = new Map<AnalyticsV2Day, number>();
    if (sources.length === 0) return counts;
    const result = await client.query<Record<string, unknown>>(analyticsV2Statement("occurrences.counts",
      `SELECT observed_day,count(*)::text AS occurrences FROM (${sources.join("\nUNION\n")}) candidate
        GROUP BY observed_day ORDER BY observed_day`), values);
    for (const row of result.rows) {
      const day = safeInteger(row.observed_day, -100_000, 100_000);
      if (day < fromDay || day > throughDay) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
      counts.set(dayFromNumber(day), safeInteger(row.occurrences, 1));
    }
    return counts;
  });
}

/**
 * The earliest observed day the reader's own candidate selection names on or
 * before `throughDay`, over every stream, or null when the owner has none.
 *
 * Production builds cache-retention days for every delivered day
 * (d43c8f92 cache-retention-day-worker.ts: CACHE_RETENTION_FROM_DAY unset
 * "means every delivered day"), so the cache horizon has no lower bound. This
 * read gives analytics-refresh that first day with exactly the candidate
 * predicates readOwnerOccurrences uses (v1/v1.1 typed records, v1.2 domain
 * days, and usage-correction facts when the runtime is active), over the
 * whole representable day domain, so no evidence older than a fixed window is
 * ever left out. It reads in the caller's snapshot and expands nothing.
 */
export async function readOwnerFirstEvidenceDay(
  context: AnalyticsV2SnapshotContext,
  options: { readonly ownerDigest: string; readonly throughDay: AnalyticsV2Day },
): Promise<AnalyticsV2Day | null> {
  if (!options || typeof options !== "object" || typeof options.ownerDigest !== "string"
      || !ANALYTICS_V2_OWNER_DIGEST_PATTERN.test(options.ownerDigest)) {
    sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  const ownerDigest = options.ownerDigest;
  const throughDay = dayNumber(options.throughDay);
  const fromDay = FIRST_EVIDENCE_FLOOR_DAY_NUMBER;
  const s = quotedSchema(context.schema);
  const now = nowTimestamp(context.nowMs);
  return onReadSnapshot(context, async (client) => {
    const scope = await readOwnerScope(client, s, ownerDigest);
    let first: number | null = null;
    const take = (rows: readonly Record<string, unknown>[]): void => {
      const value = rows[0]?.first_day;
      if (value === null || value === undefined) return;
      const day = safeInteger(value, fromDay, throughDay);
      if (first === null || day < first) first = day;
    };
    const firstOf = (sql: string): string => analyticsV2Statement("occurrences.first_evidence",
      `SELECT min(candidate.observed_day)::integer AS first_day FROM (${sql}) candidate`);
    for (const stream of ["usage", "quota", "session"] as const) {
      if (scope.v1Namespace !== null || scope.v11Namespace !== null) {
        take((await client.query<Record<string, unknown>>(firstOf(legacyCandidatesSql(s)),
          [ownerDigest, scope.participantId, STREAM_CODES[stream], stream, fromDay, throughDay])).rows);
      }
      if (scope.v12HeadActive) {
        take((await client.query<Record<string, unknown>>(firstOf(v12CandidatesSql(s)),
          [scope.participantId, stream, now, dayFromNumber(fromDay), dayFromNumber(throughDay)])).rows);
      }
      if (stream === "usage" && scope.correctionActive) {
        take((await client.query<Record<string, unknown>>(firstOf(correctionCandidatesSql(s)),
          [ownerDigest, fromDay * DAY_MS, (throughDay + 1) * DAY_MS])).rows);
      }
    }
    return first === null ? null : dayFromNumber(first);
  });
}

export interface ReadOwnerEvidencePlanOptions {
  readonly ownerDigest: string;
  readonly streams: readonly EffectiveTelemetryStream[];
  readonly fromDay: AnalyticsV2Day;
  readonly throughDay: AnalyticsV2Day;
  readonly firstEvidenceThroughDay: AnalyticsV2Day;
}

/**
 * Caller-readonly maps: Object.freeze seals their own properties, while
 * native Map mutators remain available at runtime. Consumers must not mutate
 * the returned maps. Range validation uses private snapshot aggregates.
 */
export interface AnalyticsV2StreamEvidencePlan {
  readonly counts: ReadonlyMap<AnalyticsV2Day, number>;
  readonly firstEvidenceDay: AnalyticsV2Day | null;
}

export type AnalyticsV2OwnerEvidencePlan = ReadonlyMap<EffectiveTelemetryStream, AnalyticsV2StreamEvidencePlan>;
interface EvidencePlanProof {
  readonly ownerDigest: string;
  readonly fromDay: number;
  readonly throughDay: number;
  readonly pool: AnalyticsV2SnapshotContext["pool"];
  readonly schema: string;
  readonly nowMs: number;
  readonly client: AnalyticsV2SnapshotContext["client"];
  readonly rows: ReadonlyMap<EffectiveTelemetryStream, readonly Record<string, unknown>[]>;
  readonly correctionBoundaries: ReadonlyMap<EffectiveTelemetryStream, ReadonlySet<number>>;
}
// Keep validation coordinates private and content-free. A plan cannot be forged
// or applied to another owner, and never contains occurrence identifiers.
const evidencePlanProofs = new WeakMap<AnalyticsV2OwnerEvidencePlan, EvidencePlanProof>();

/**
 * One scope read and one unnamed counts statement per requested stream, in
 * the caller's snapshot. Selection is set-based; no source is decoded or
 * expanded. First-evidence validation happens in the old stream/source order.
 * Count validation is deferred to countOwnerEvidencePlanRange so the job can
 * preserve its first-evidence → range → chunked-count refusal precedence.
 */
export async function readOwnerEvidencePlan(
  context: AnalyticsV2SnapshotContext,
  options: ReadOwnerEvidencePlanOptions,
): Promise<AnalyticsV2OwnerEvidencePlan> {
  if (!options || typeof options !== "object" || typeof options.ownerDigest !== "string"
      || !ANALYTICS_V2_OWNER_DIGEST_PATTERN.test(options.ownerDigest)
      || !Array.isArray(options.streams) || options.streams.length < 1 || options.streams.length > 3
      || new Set(options.streams).size !== options.streams.length
      || options.streams.some((stream) => !["usage", "quota", "session"].includes(stream))) {
    sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  const fromDay = dayNumber(options.fromDay);
  const throughDay = dayNumber(options.throughDay);
  const firstThrough = dayNumber(options.firstEvidenceThroughDay);
  if (fromDay < FIRST_EVIDENCE_FLOOR_DAY_NUMBER || throughDay < fromDay || firstThrough > throughDay
      || firstThrough < FIRST_EVIDENCE_FLOOR_DAY_NUMBER) sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  const s = quotedSchema(context.schema);
  const now = nowTimestamp(context.nowMs);
  return onReadSnapshot(context, async (client) => {
    const scope = await readOwnerScope(client, s, options.ownerDigest);
    const plan = new Map<EffectiveTelemetryStream, AnalyticsV2StreamEvidencePlan>();
    const rowsByStream = new Map<EffectiveTelemetryStream, readonly Record<string, unknown>[]>();
    const boundaries = new Map<EffectiveTelemetryStream, ReadonlySet<number>>();
    for (const stream of options.streams) {
      const sources: string[] = [];
      const firsts: string[] = [];
      const values: unknown[] = [];
      let correctionName: string | null = null;
      const add = (sql: string, binds: readonly unknown[], correction = false): void => {
        const name = `plan_source_${sources.length}`;
        sources.push(`${name} AS MATERIALIZED (${shiftParameters(sql, values.length)})`);
        values.push(...binds);
        const firstFilter = correction
          ? `observed_at_ms::bigint<${(firstThrough + 1) * DAY_MS}::bigint`
          : `observed_day<=${firstThrough}::integer`;
        firsts.push(`SELECT 'first'::text AS kind,${firsts.length}::integer AS ordinal,
          min(observed_day)::integer AS observed_day,NULL::text AS occurrences,NULL::text AS start_occurrences
          FROM ${name} WHERE ${firstFilter}`);
        if (correction) correctionName = name;
      };
      if (scope.v1Namespace !== null || scope.v11Namespace !== null) {
        add(legacyCandidatesSql(s), [options.ownerDigest, scope.participantId, STREAM_CODES[stream], stream,
          FIRST_EVIDENCE_FLOOR_DAY_NUMBER, throughDay]);
      }
      if (scope.v12HeadActive) {
        add(v12CandidatesSql(s), [scope.participantId, stream, now,
          dayFromNumber(FIRST_EVIDENCE_FLOOR_DAY_NUMBER), dayFromNumber(throughDay)]);
      }
      if (stream === "usage" && scope.correctionActive) {
        add(correctionCandidatesSql(s).replace("min(h.event_time_ms)::text AS observed_at_ms",
          "min(h.event_time_ms)::text AS observed_at_ms,max(h.event_time_ms)::text AS latest_event_at_ms"),
          [options.ownerDigest, FIRST_EVIDENCE_FLOOR_DAY_NUMBER * DAY_MS,
          (throughDay + 1) * DAY_MS], true);
      }
      const counts = new Map<AnalyticsV2Day, number>();
      const boundaryDays = new Set<number>();
      let first: number | null = null;
      let countRows: readonly Record<string, unknown>[] = [];
      if (sources.length > 0) {
        const candidates = sources.map((_, index) => {
          const name = `plan_source_${index}`;
          const regular = name === correctionName
            ? `latest_event_at_ms::bigint>=observed_day::bigint*${DAY_MS}` : "true";
          return `SELECT observed_day,occurrence_id,${regular} AS regular FROM ${name}`;
        });
        // Negative non-midnight corrections select by floor(event day), but
        // div() names the following day. Only these can cross a count chunk's
        // upper bound. min(event time) preserves their existence per group.
        const boundary = correctionName === null ? [] : [`SELECT 'boundary'::text AS kind,0::integer AS ordinal,
          observed_day,NULL::text AS occurrences,NULL::text AS start_occurrences FROM ${correctionName}
          WHERE observed_at_ms::bigint<0 AND mod(observed_at_ms::bigint,${DAY_MS})<>0`];
        const result = await client.query<Record<string, unknown>>(analyticsV2Statement("occurrences.counts",
          `WITH ${sources.join(",\n")}, plan_coordinates AS (${candidates.join("\nUNION ALL\n")}),
           plan_candidates AS (SELECT observed_day,occurrence_id,bool_or(regular) AS regular
             FROM plan_coordinates GROUP BY observed_day,occurrence_id)
           ${[...firsts, `SELECT 'count'::text AS kind,0::integer AS ordinal,observed_day,
             count(*)::text AS occurrences,count(*) FILTER (WHERE regular)::text AS start_occurrences
             FROM plan_candidates GROUP BY observed_day`, ...boundary].join("\nUNION ALL\n")}
           ORDER BY kind,ordinal,observed_day`), values);
        // The old first-evidence reader validates each source minimum, even
        // if an earlier source already supplied a smaller, valid minimum.
        for (const row of result.rows.filter((row) => row.kind === "first")) {
          if (row.observed_day === null) continue;
          const day = safeInteger(row.observed_day, FIRST_EVIDENCE_FLOOR_DAY_NUMBER, firstThrough);
          if (first === null || day < first) first = day;
        }
        countRows = Object.freeze(result.rows.filter((row) => row.kind === "count"));
        for (const row of countRows) {
          // Do not surface count-derived refusals before the job's range
          // checkpoint. The exact raw aggregate is validated per chunk below.
          const day = Number(row.observed_day);
          if (Number.isSafeInteger(day) && day >= fromDay && day <= throughDay
              && day >= FIRST_EVIDENCE_FLOOR_DAY_NUMBER && day <= 100_000) {
            const count = Number(row.occurrences);
            if (Number.isSafeInteger(count) && count > 0) counts.set(dayFromNumber(day), count);
          }
        }
        for (const row of result.rows.filter((row) => row.kind === "boundary")) {
          const day = Number(row.observed_day);
          if (Number.isSafeInteger(day)) boundaryDays.add(day);
        }
      }
      rowsByStream.set(stream, countRows);
      boundaries.set(stream, boundaryDays);
      plan.set(stream, Object.freeze({ counts: Object.freeze(counts),
        firstEvidenceDay: first === null ? null : dayFromNumber(first) }));
    }
    evidencePlanProofs.set(plan, Object.freeze({ ownerDigest: options.ownerDigest, fromDay, throughDay,
      pool: context.pool, schema: context.schema, nowMs: context.nowMs, client: context.client,
      rows: rowsByStream, correctionBoundaries: boundaries }));
    return Object.freeze(plan);
  });
}

/**
 * Restrict a plan to exactly one old-reader chunk, including its negative
 * correction refusal. Below FLOOR or outside the plan's domain use the old
 * bounded reader; those reads must not widen first-evidence selection.
 */
export async function countOwnerEvidencePlanRange(
  context: AnalyticsV2SnapshotContext,
  plan: AnalyticsV2OwnerEvidencePlan,
  options: Omit<ReadOwnerOccurrencesOptions, "maxCandidates">,
): Promise<Map<AnalyticsV2Day, number>> {
  const normalized = normalizeOptions(options as ReadOwnerOccurrencesOptions);
  const proof = evidencePlanProofs.get(plan);
  if (proof === undefined || proof.ownerDigest !== normalized.ownerDigest || !plan.has(normalized.stream)
      || proof.pool !== context.pool || proof.schema !== context.schema || proof.nowMs !== context.nowMs
      || proof.client !== context.client) {
    return sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  if (normalized.fromDay < proof.fromDay || normalized.throughDay > proof.throughDay) {
    return countOwnerOccurrences(context, options);
  }
  if (proof.correctionBoundaries.get(normalized.stream)?.has(normalized.throughDay + 1)) {
    sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  const counts = new Map<AnalyticsV2Day, number>();
  for (const row of proof.rows.get(normalized.stream) ?? []) {
    const coordinate = Number(row.observed_day);
    // A normal candidate is in this chunk by observed day. A correction
    // can only additionally name throughDay+1, checked just above.
    if (coordinate < normalized.fromDay || coordinate > normalized.throughDay) continue;
    const day = safeInteger(row.observed_day, FIRST_EVIDENCE_FLOOR_DAY_NUMBER, 100_000);
    const count = safeInteger(day === normalized.fromDay ? row.start_occurrences : row.occurrences);
    if (count > 0) counts.set(dayFromNumber(day), count);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Evidence identity (K-READ): the owner watermark W(o) and the day fingerprint F(o,d)
// ---------------------------------------------------------------------------

/**
 * Version of the fingerprint and watermark constructions below (v2: both
 * carry the community aggregate exclusions, N-EXCL).
 */
export const ANALYTICS_V2_EVIDENCE_IDENTITY_METHOD = "analytics-v2-evidence-identity-v2" as const;

/** A driver row as canonical data: bytea as hex, every column by name. */
function canonicalRow(row: Record<string, unknown>): Array<[string, unknown]> {
  return Object.keys(row).sort().map((key) => {
    const value = row[key];
    return [key, value instanceof Uint8Array ? `\\x${Buffer.from(value).toString("hex")}`
      : value instanceof Date ? value.toISOString() : value ?? null];
  });
}

/**
 * F(o,d) for every day of [fromDay, throughDay] on which the owner has a
 * candidate in any stream: a sha256 over each stream's candidates of the day
 * (occurrence id and candidate time, in reader order) and, for each of them,
 * every source row the reader's expansion selects for that occurrence on any
 * day (all columns of the legacy, v1.2 and correction rows, in physical
 * order), with the owner scope that decides which families are read, and the
 * participant's active community aggregate exclusions that cover d (N-EXCL:
 * id and interval, exclusions.ts), which decide whether the owner's d enters
 * the community aggregates. It runs exactly the reader's statements (the same
 * candidate SQL and the same prepared expansion statements) and skips
 * decoding and reconciliation, so an unchanged F(o,d) means
 * readOwnerOccurrences returns the same occurrences for (o, d), and so the
 * same analyticsV2DayDigest, and the same exclusion of (o, d): the reader's
 * output is a pure function of the scope, the candidates and those rows. A day absent
 * from the map has no candidate (known empty); the reader's refusals
 * (ANALYTICS_V2_SOURCE_*) are the reader's here too. Content-free: the
 * fingerprint is a digest of rows the snapshot already holds, never stored
 * with them.
 */
export async function readOwnerDayFingerprints(
  context: AnalyticsV2SnapshotContext,
  options: Omit<ReadOwnerOccurrencesOptions, "stream">,
): Promise<Map<AnalyticsV2Day, string>> {
  const s = quotedSchema(context.schema);
  const now = nowTimestamp(context.nowMs);
  const base = normalizeOptions({ ...options, stream: "usage" } as ReadOwnerOccurrencesOptions);
  return onReadSnapshot(context, async (client) => {
    const scope = await readOwnerScope(client, s, base.ownerDigest);
    const scopeKey = [scope.participantId, scope.v1Namespace, scope.v11Namespace, scope.correctionActive,
      scope.v12RuntimeActive, scope.v12HeadActive];
    const exclusions = await readParticipantActiveExclusions(client, s, scope.participantId);
    const statements = await readerStatements(s);
    const byDay = new Map<number, Record<EffectiveTelemetryStream, string | null>>();
    for (const stream of ["usage", "quota", "session"] as const) {
      const { candidates, corrections, expandV12, occurrenceIds } = await readCandidates(client, s, now, scope,
        { ...base, stream });
      const streamBinds = [base.ownerDigest, scope.participantId, STREAM_CODES[stream], stream];
      // Each occurrence's selected source rows, digested once.
      const sourceDigests = new Map<string, string>();
      if (occurrenceIds.length > 0) await withGenericPlans(client, async () => {
        for await (const raw of fetchRawExpansion(client, s, now, scope, base.ownerDigest, stream,
          occurrenceIds, corrections, expandV12)) {
          const byOccurrence = new Map<string, { legacy: unknown[]; v12: unknown[]; facts: unknown[] }>(
            raw.ids.map((id) => [id, { legacy: [], v12: [], facts: [] }]));
          const keyed = (blob: unknown) => byOccurrence.get(occurrenceText(blob)) ?? sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
          const legacy = raw.legacy;
          if (legacy.length > MAX_BATCH_SOURCE_ROWS) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
          const ordered = [...legacy].sort((left, right) =>
            safeInteger(left.storage_row_id, 1) - safeInteger(right.storage_row_id, 1));
          for (const row of ordered) keyed(row.occurrence_id).legacy.push(canonicalRow(row as unknown as Record<string, unknown>));
          const v12 = raw.v12;
          if (v12.length > MAX_BATCH_V12_ROWS) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
          for (const row of v12) keyed(row.occurrence_id).v12.push(canonicalRow(row));
          const facts = raw.facts;
          if (facts.length > MAX_BATCH_SOURCE_ROWS) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
          for (const row of facts) keyed(row.occurrence_id).facts.push(canonicalRow(row));
          for (const [id, sources] of byOccurrence) {
            sourceDigests.set(id, await sha256Hex(canonicalJson([sources.legacy, sources.v12, sources.facts])));
          }
        }
      });
      for (const [day, byOccurrence] of candidates) {
        const ordered = [...byOccurrence.values()].sort(compareCandidates)
          .map((candidate) => [candidate.occurrence_id, candidate.observed_at_ms, sourceDigests.get(candidate.occurrence_id)!]);
        const entry = byDay.get(day) ?? { usage: null, quota: null, session: null };
        entry[stream] = await sha256Hex(canonicalJson([ANALYTICS_V2_EVIDENCE_IDENTITY_METHOD, stream, dayFromNumber(day),
          scopeKey, ordered]));
        byDay.set(day, entry);
      }
    }
    const output = new Map<AnalyticsV2Day, string>();
    for (const day of [...byDay.keys()].sort((left, right) => left - right)) {
      const entry = byDay.get(day)!;
      const covering = analyticsV2ExclusionsOn(exclusions, dayFromNumber(day))
        .map((exclusion) => [exclusion.exclusionId, exclusion.effectiveAtUs, exclusion.expiresAtUs]);
      output.set(dayFromNumber(day), await sha256Hex(canonicalJson([ANALYTICS_V2_EVIDENCE_IDENTITY_METHOD,
        dayFromNumber(day), entry.usage, entry.quota, entry.session, covering])));
    }
    return output;
  });
}

/** Owners one watermark statement reads (the roster is paged by this). */
export const MAX_ANALYTICS_V2_WATERMARK_OWNERS = 1_000;

/**
 * W(o) for each of `ownerDigests`: a sha256 over the owner's monotonic
 * journal head (storage_owner_revisions: revision, authority epoch, state,
 * last sequence, content digest), its active owner link and participant
 * state, the reader's retained v1.2 authorization scope rows for the
 * participant at the pinned clock, the participant's v1.2 domain head, its
 * community aggregate exclusion rows of any state (N-EXCL), and the runtime
 * and admission states that decide which source families the reader reads.
 * One statement covers every requested owner. An owner without
 * an active link or journal head gets the digest of its absence, never an
 * inferred value.
 *
 * Advisory (K-READ): the incremental planner (K-INCR) may skip an owner only
 * once its mutation tests prove that every intake, correction, generation
 * replacement and link change moves one of these inputs; until then nothing
 * reads W(o) to skip work, and F(o,d) is the evidence identity of record.
 */
export async function readOwnerWatermarks(context: AnalyticsV2SnapshotContext,
  ownerDigests: readonly string[]): Promise<Map<string, string>> {
  if (!Array.isArray(ownerDigests) || ownerDigests.length > MAX_ANALYTICS_V2_WATERMARK_OWNERS
      || !ownerDigests.every((digest) => typeof digest === "string" && ANALYTICS_V2_OWNER_DIGEST_PATTERN.test(digest))
      || new Set(ownerDigests).size !== ownerDigests.length) {
    sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  const s = quotedSchema(context.schema);
  const now = nowTimestamp(context.nowMs);
  return onReadSnapshot(context, async (client) => {
    const output = new Map<string, string>();
    if (ownerDigests.length === 0) return output;
    const result = await client.query<Record<string, unknown>>(analyticsV2Statement("occurrences.watermark",
      `WITH requested AS MATERIALIZED (
         SELECT DISTINCT value AS owner_digest FROM unnest($1::text[]) value
       ), retained AS MATERIALIZED (
         ${v12RetainedAuthorizationScopeSql(s, "$2::timestamptz", "reader")}
       )
       SELECT requested.owner_digest,
              link.participant_id,
              participant.state AS participant_state,
              owner_revision.revision::text AS revision,
              owner_revision.authority_epoch::text AS authority_epoch,
              owner_revision.state AS owner_state,
              owner_revision.last_sequence::text AS last_sequence,
              owner_revision.content_digest,
              (SELECT string_agg(retained.device_id, ',' ORDER BY retained.device_id COLLATE "C")
                 FROM retained WHERE retained.participant_id = link.participant_id) AS retained_devices,
              (SELECT head.generation_id FROM ${s}.telemetry_v12_domain_heads head
                WHERE head.participant_id = link.participant_id) AS v12_generation_id,
              ${participantExclusionsWatermarkSql(s, "link.participant_id")} AS exclusions,
              (SELECT state FROM ${s}.telemetry_v12_runtime WHERE id = 1) AS v12_state,
              ${correctionRuntimeActiveSql(s)} AS correction_active,
              (SELECT namespace_id::text || ':' || source_namespace FROM ${s}.typed_v1_admission_state
                WHERE id = 1 AND runtime_contract_version = 1) AS v1_namespace,
              (SELECT namespace_id::text || ':' || source_namespace FROM ${s}.typed_v11_admission_state
                WHERE id = 1 AND runtime_contract_version = 1) AS v11_namespace
         FROM requested
         LEFT JOIN ${s}.storage_v11_owner_links link
           ON link.owner_digest = requested.owner_digest AND link.state = 'active'
         LEFT JOIN ${s}.participants participant ON participant.id = link.participant_id
         LEFT JOIN ${s}.storage_source_state source ON source.singleton = 1
         LEFT JOIN ${s}.storage_owner_revisions owner_revision
           ON owner_revision.source_id = source.source_id AND owner_revision.owner_digest = requested.owner_digest
        ORDER BY requested.owner_digest`), [[...ownerDigests], now]);
    for (const row of result.rows) {
      const digest = row.owner_digest;
      if (typeof digest !== "string" || output.has(digest) || !ownerDigests.includes(digest)) {
        sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
      }
      output.set(digest, await sha256Hex(canonicalJson([ANALYTICS_V2_EVIDENCE_IDENTITY_METHOD, "watermark",
        canonicalRow(row)])));
    }
    if (output.size !== ownerDigests.length) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
    return output;
  });
}
