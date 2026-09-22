import {
  canonicalTelemetryV11Json,
  parseTelemetryV11Attribution,
  parseTelemetryV11Record,
  type TelemetryV11Attribution,
} from "@app-usagemonitor/telemetry-contract";
import {
  MAX_TELEMETRY_USAGE_CORRECTION_PAGE,
  MAX_TELEMETRY_USAGE_CORRECTION_SOURCE_VARIANTS,
  readTelemetryUsageCorrectionEffectiveSourceVariants,
  readTelemetryUsageCorrectionCandidates,
  type TelemetryUsageCorrectionFactRow,
} from "./telemetry-usage-correction-repository";
import {
  MAX_TYPED_TELEMETRY_COMPATIBILITY_PAGE,
  readTypedTelemetryRowsByStorageIds,
  type TypedTelemetryCompatibilityRecord,
} from "./typed-telemetry-compatibility";
import {
  createUsageCorrectionOccurrenceAccumulator,
  type UsageCorrectionFormat,
  type UsageCorrectionSource,
} from "./telemetry-usage-reconciliation";
import { sha256Hex } from "./crypto";
import {
  readTelemetryV12EffectiveCandidatePage,
  readTelemetryV12EffectiveOccurrences,
  readTelemetryV12EffectiveDays,
  type TelemetryV12EffectiveRecord,
} from "./telemetry-v12-effective-reader";

/**
 * Usage-only source reader for the mixed v1/v1.1/v1.2 lane.
 *
 * This module deliberately sits below daily/quota/graph arithmetic. It proves
 * the current owner scope, enumerates every admitted v1 chunk and every
 * owner-linked retained v1.1 generation, adds qualified correction history,
 * then reconciles by occurrence before returning an analytical record. The
 * old one-device winner selection is not used here.
 */
export const EFFECTIVE_USAGE_READER_METHOD = "effective-usage-owner-day-v1" as const;
export const MAX_EFFECTIVE_USAGE_PAGE = 200;
/** Maximum number of semantically distinct correction variants retained for a
 * selected occurrence page. Repeated retained revisions with the same device,
 * occurrence, event time, format, and canonical record digest are one source
 * variant; the physical archive may therefore contain more rows than this
 * bound without making a valid page unreadable. A genuinely larger set of
 * distinct variants still fails closed instead of dropping evidence. */
export const MAX_EFFECTIVE_USAGE_ARCHIVE_ROWS = MAX_TELEMETRY_USAGE_CORRECTION_SOURCE_VARIANTS;
export const MAX_EFFECTIVE_USAGE_SOURCE_ROWS = 3_200;
const MAX_EFFECTIVE_USAGE_ARCHIVE_PAGES = Math.ceil(
  MAX_EFFECTIVE_USAGE_ARCHIVE_ROWS / MAX_TELEMETRY_USAGE_CORRECTION_PAGE,
) + 1;

export type EffectiveUsageReaderErrorCode =
  | "EFFECTIVE_USAGE_INVALID"
  | "EFFECTIVE_USAGE_UNAVAILABLE"
  | "EFFECTIVE_USAGE_LIMIT"
  | "EFFECTIVE_USAGE_CAS_MISMATCH"
  | "EFFECTIVE_USAGE_SOURCE_CONFLICT";

export class EffectiveUsageReaderError extends Error {
  constructor(readonly code: EffectiveUsageReaderErrorCode) {
    super(code);
    this.name = "EffectiveUsageReaderError";
  }
}

export interface EffectiveUsageReaderCursor {
  readonly observedAtMs: number;
  readonly occurrenceId: string;
}

export interface EffectiveUsageReaderOptions {
  readonly sourceNamespace: string;
  readonly ownerDigest: string;
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  readonly day: string;
  readonly after?: EffectiveUsageReaderCursor;
  readonly limit?: number;
  readonly stream?: EffectiveTelemetryStream;
}

export type EffectiveTelemetryStream = "usage" | "quota" | "session";

export interface EffectiveTelemetryReaderOptions extends EffectiveUsageReaderOptions {
  readonly stream: EffectiveTelemetryStream;
}

export interface EffectiveTelemetryOccurrence {
  readonly methodVersion: "effective-telemetry-owner-day-v1";
  readonly stream: EffectiveTelemetryStream;
  readonly participantId: string;
  readonly ownerDigest: string;
  readonly occurrenceId: string;
  readonly eventTime: string | null;
  readonly eventTimeConflict: boolean;
  readonly status: "compatible" | "conflict";
  readonly sourceCount: number;
  readonly sourceFormats: readonly ("v1" | "v11" | "v12")[];
  readonly sourceRowIds: readonly number[];
  readonly sourceRecordKeys: readonly string[];
  readonly recordJson: string | null;
}

export interface EffectiveTelemetryOwnerDayPage {
  readonly methodVersion: "effective-telemetry-owner-day-v1";
  readonly stream: EffectiveTelemetryStream;
  readonly participantId: string;
  readonly ownerDigest: string;
  readonly day: string;
  readonly rows: readonly EffectiveTelemetryOccurrence[];
  readonly next: EffectiveUsageReaderCursor | null;
}

export interface EffectiveUsageOccurrence {
  readonly methodVersion: typeof EFFECTIVE_USAGE_READER_METHOD;
  readonly participantId: string;
  readonly ownerDigest: string;
  readonly occurrenceId: string;
  /** Null means that authoritative variants disagree about event time. */
  readonly eventTime: string | null;
  readonly eventTimeConflict: boolean;
  readonly status: "compatible" | "total_conflict" | "base_conflict";
  readonly sourceCount: number;
  readonly sourceFormats: readonly ("v1" | "v11" | "v12")[];
  readonly sourceRowIds: readonly number[];
  /** v1.2 has no typed compatibility row id; these are its immutable
   * manifest/record coordinates, retained for audit without exposing content. */
  readonly sourceRecordKeys: readonly string[];
  readonly correctionHistoryIds: readonly number[];
  /** Same effective accounting with independently reconciled attribution. */
  readonly analyticalRecordJson: string | null;
  /** Canonical v1 analytical projection; null for a conflict. */
  readonly recordJson: string | null;
}

export interface EffectiveUsageOwnerDayPage {
  readonly methodVersion: typeof EFFECTIVE_USAGE_READER_METHOD;
  readonly participantId: string;
  readonly ownerDigest: string;
  readonly day: string;
  readonly rows: readonly EffectiveUsageOccurrence[];
  readonly next: EffectiveUsageReaderCursor | null;
}

interface OwnerScope {
  participant_id: string;
  owner_digest: string;
  revision: number;
  authority_epoch: number;
  v1_namespace: string | null;
  v11_namespace: string | null;
  v12_generation_id: string | null;
  v12_state: string | null;
  correction_state: string;
}

interface CandidateRow {
  occurrence_id: string;
  observed_at_ms: number;
}

interface DirectSourceRow {
  storage_row_id: number;
  source_namespace: string;
  participant_id: string;
  occurrence_id: string;
}

interface V12SourceRow {
  source_record_key: string;
  occurrence_id: string;
  observed_at: string;
  record_json: string;
  canonical_digest: string;
}

interface ReconciledSourceEntry {
  source: UsageCorrectionSource;
  format: UsageCorrectionFormat;
  sourceRowId: number | null;
  sourceKey: string;
  historyId: number | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const OWNER_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const OCCURRENCE_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const V12_READER_TABLES = Object.freeze([
  "telemetry_v12_runtime", "telemetry_v12_device_capabilities", "telemetry_v12_day_manifests",
  "telemetry_v12_chunks", "telemetry_v12_records", "telemetry_v12_domain_predecessors",
  "telemetry_v12_domains", "telemetry_v12_domain_days", "telemetry_v12_domain_heads",
]);

/** The correction-aware usage lane is effective only after its facts runtime
 * is active. Callers use this probe to keep the frozen v1/v1.1 path alive
 * while the forward-only correction migration is staged. Missing or partial
 * tables are an unavailable effective lane, never a source-family fallback. */
export async function effectiveTelemetryReaderAvailable(db: D1Database): Promise<boolean> {
  try {
    const required = [
      "telemetry_usage_correction_runtime", "telemetry_usage_correction_history",
      "telemetry_usage_correction_facts", "typed_v1_admission_state",
      "typed_v11_admission_state",
    ] as const;
    const rows = (await db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name IN (${required.map(() => "?").join(",")})`)
      .bind(...required).all<{ name: string }>()).results;
    if (rows.length !== required.length) return false;
    const runtime = await db.prepare(`SELECT state,schema_version,method_version
      FROM telemetry_usage_correction_runtime WHERE id=1`)
      .first<{ state: string; schema_version: string; method_version: string }>();
    return runtime?.state === "active"
      && runtime.schema_version === "telemetry-usage-correction-v1"
      && runtime.method_version === "usage-total-correction-v1";
  } catch {
    return false;
  }
}

function fail(code: EffectiveUsageReaderErrorCode = "EFFECTIVE_USAGE_INVALID"): never {
  throw new EffectiveUsageReaderError(code);
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  return value;
}

function ownerDigest(value: unknown): string {
  if (typeof value !== "string" || !HEX64.test(value)) fail();
  return value;
}

function identifier(value: unknown, expression: RegExp = OWNER_ID): string {
  if (typeof value !== "string" || !expression.test(value)) fail();
  return value;
}

function validDay(value: unknown): string {
  if (typeof value !== "string" || !DAY.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
      || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) fail();
  return value;
}

async function readV12Availability(db: D1Database): Promise<boolean> {
  try {
    const rows = (await db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name IN (${V12_READER_TABLES.map(() => "?").join(",")})`)
      .bind(...V12_READER_TABLES).all<{ name: string }>()).results;
    if (rows.length === 0) return false;
    if (rows.length !== V12_READER_TABLES.length) fail("EFFECTIVE_USAGE_UNAVAILABLE");
    return true;
  } catch (error) {
    if (error instanceof EffectiveUsageReaderError) throw error;
    fail("EFFECTIVE_USAGE_UNAVAILABLE");
  }
}

function normalizeOptions(options: EffectiveUsageReaderOptions): Readonly<{
  sourceNamespace: string;
  ownerDigest: string;
  ownerRevision: number;
  authorityEpoch: number;
  day: string;
  after: EffectiveUsageReaderCursor;
  limit: number;
  stream: EffectiveTelemetryStream;
}> {
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !["after", "authorityEpoch", "day", "limit", "ownerDigest", "ownerRevision", "sourceNamespace", "stream"].includes(key))) {
    fail();
  }
  const after = options.after;
  if (after !== undefined && (!after || typeof after !== "object" || Array.isArray(after)
      || Object.keys(after).sort().join(",") !== "observedAtMs,occurrenceId"
      || !OCCURRENCE_ID.test(after.occurrenceId))) fail();
  return Object.freeze({
    sourceNamespace: identifier(options.sourceNamespace),
    ownerDigest: ownerDigest(options.ownerDigest),
    ownerRevision: integer(options.ownerRevision, 1, 0x7fffffff),
    authorityEpoch: integer(options.authorityEpoch, 1, 0x7fffffff),
    day: validDay(options.day),
    stream: options.stream === undefined ? "usage" : (options.stream === "usage" || options.stream === "quota" || options.stream === "session" ? options.stream : fail()),
    after: Object.freeze({
      observedAtMs: after === undefined ? -8_640_000_000_000_000 : integer(after.observedAtMs, -8_640_000_000_000_000, 8_640_000_000_000_000),
      occurrenceId: after === undefined ? "" : identifier(after.occurrenceId, OCCURRENCE_ID),
    }),
    limit: integer(options.limit ?? 100, 1, MAX_EFFECTIVE_USAGE_PAGE),
  });
}

function cursorAfter(row: CandidateRow, cursor: EffectiveUsageReaderCursor): boolean {
  return row.observed_at_ms > cursor.observedAtMs
    || row.observed_at_ms === cursor.observedAtMs && row.occurrence_id > cursor.occurrenceId;
}

function compareCandidates(left: CandidateRow, right: CandidateRow): number {
  return left.observed_at_ms - right.observed_at_ms
    || (left.occurrence_id < right.occurrence_id ? -1 : left.occurrence_id > right.occurrence_id ? 1 : 0);
}

async function readOwnerScope(
  db: D1Database,
  options: ReturnType<typeof normalizeOptions>,
  v12Available: boolean,
): Promise<OwnerScope> {
  try {
    const v12Select = v12Available
      ? ",v12head.generation_id AS v12_generation_id,v12runtime.state AS v12_state"
      : ",NULL AS v12_generation_id,NULL AS v12_state";
    const v12Join = v12Available
      ? `LEFT JOIN telemetry_v12_domain_heads v12head ON v12head.participant_id=link.participant_id
      LEFT JOIN telemetry_v12_runtime v12runtime ON v12runtime.id=1`
      : "";
    const row = await db.prepare(`SELECT link.participant_id,link.owner_digest,owner.revision,owner.authority_epoch,
        v1.source_namespace AS v1_namespace,v11.source_namespace AS v11_namespace,correction.state AS correction_state${v12Select}
      FROM storage_v11_owner_links link
      JOIN storage_owner_revisions owner ON owner.owner_digest=link.owner_digest
      JOIN participants participant ON participant.id=link.participant_id AND participant.state='active'
      LEFT JOIN typed_v1_admission_state v1 ON v1.id=1 AND v1.runtime_contract_version=1
      LEFT JOIN typed_v11_admission_state v11 ON v11.id=1 AND v11.runtime_contract_version=1
      JOIN telemetry_usage_correction_runtime correction ON correction.id=1
        AND correction.schema_version='telemetry-usage-correction-v1' AND correction.method_version='usage-total-correction-v1'
      ${v12Join}
      WHERE link.owner_digest=? AND link.state='active' AND owner.state='active' LIMIT 2`)
      .bind(options.ownerDigest).first<OwnerScope>();
    if (!row || row.owner_digest !== options.ownerDigest || row.revision !== options.ownerRevision
        || row.authority_epoch !== options.authorityEpoch
        || (row.v1_namespace !== null && row.v1_namespace !== options.sourceNamespace)
        || (row.v11_namespace !== null && row.v11_namespace !== options.sourceNamespace)
        || (row.v1_namespace === null && row.v11_namespace === null
          && !(v12Available && row.v12_state === "active"))) {
      fail("EFFECTIVE_USAGE_CAS_MISMATCH");
    }
    return row;
  } catch (error) {
    if (error instanceof EffectiveUsageReaderError) throw error;
    fail("EFFECTIVE_USAGE_UNAVAILABLE");
  }
}

async function assertOwnerScopeCurrent(
  db: D1Database,
  options: ReturnType<typeof normalizeOptions>,
  participantId: string,
  scope: OwnerScope,
  v12Available: boolean,
): Promise<void> {
  const v12Select = v12Available
    ? ",v12head.generation_id AS v12_generation_id,v12runtime.state AS v12_state"
    : ",NULL AS v12_generation_id,NULL AS v12_state";
  const v12Join = v12Available
    ? `LEFT JOIN telemetry_v12_domain_heads v12head ON v12head.participant_id=link.participant_id
    LEFT JOIN telemetry_v12_runtime v12runtime ON v12runtime.id=1`
    : "";
  const row = await db.prepare(`SELECT link.participant_id,link.owner_digest,owner.revision,owner.authority_epoch,correction.state AS correction_state${v12Select}
    FROM storage_v11_owner_links link JOIN storage_owner_revisions owner ON owner.owner_digest=link.owner_digest
    JOIN participants participant ON participant.id=link.participant_id AND participant.state='active'
    JOIN telemetry_usage_correction_runtime correction ON correction.id=1
      AND correction.schema_version='telemetry-usage-correction-v1' AND correction.method_version='usage-total-correction-v1'
    ${v12Join}
    WHERE link.owner_digest=? AND link.state='active' AND owner.state='active' LIMIT 2`)
    .bind(options.ownerDigest).first<OwnerScope>();
  if (!row || row.participant_id !== participantId || row.owner_digest !== options.ownerDigest
      || row.revision !== options.ownerRevision || row.authority_epoch !== options.authorityEpoch
      || row.correction_state !== scope.correction_state
      || row.v12_generation_id !== scope.v12_generation_id || row.v12_state !== scope.v12_state) {
    fail("EFFECTIVE_USAGE_CAS_MISMATCH");
  }
}

/** Candidate occurrences are selected from the requested observed day before
 * any totals are folded. Expansion later deliberately removes the day filter
 * so a conflicting/misaligned timestamp for the same occurrence cannot become
 * an independently priced row on another day. */
const CANDIDATE_SQL = `
  WITH direct AS (
    SELECT r.occurrence_id,r.observed_at_ms
      FROM typed_telemetry_compatibility_records r
      JOIN typed_v1_admission_state v1
       ON v1.id=1 AND v1.runtime_contract_version=1 AND v1.source_namespace=?
      JOIN typed_v1_owner_memberships owner_membership
       ON owner_membership.participant_id=r.participant_id
      JOIN typed_telemetry_owners typed_owner
       ON typed_owner.id=owner_membership.typed_owner_id
      AND typed_owner.namespace_id=v1.namespace_id
      JOIN typed_v1_record_admissions admission ON admission.typed_record_id=r.storage_row_id
      JOIN telemetry_v1_chunks chunk ON chunk.id=admission.chunk_id
       AND chunk.participant_id=r.participant_id AND chunk.device_id=r.device_id
       AND chunk.stream='usage' AND chunk.superseded_at IS NULL
       AND chunk.accepted_record_count=chunk.record_count
      JOIN typed_v1_event_sources event ON event.chunk_id=chunk.id
       AND event.owner_digest=? AND event.source_namespace=v1.source_namespace
      WHERE r.participant_id=? AND r.source_namespace=v1.source_namespace
        AND r.namespace_id=v1.namespace_id AND r.owner_id=typed_owner.id AND r.format_code=10
        AND r.stream='usage' AND r.observed_day=?
        AND chunk.record_count=(SELECT count(*) FROM typed_v1_record_admissions p WHERE p.chunk_id=chunk.id)
    UNION ALL
    SELECT r.occurrence_id,r.observed_at_ms
      FROM typed_telemetry_compatibility_records r
      JOIN typed_v11_admission_state v11
       ON v11.id=1 AND v11.runtime_contract_version=1
      JOIN typed_v11_owner_memberships owner_membership
       ON owner_membership.participant_id=r.participant_id
      JOIN typed_telemetry_owners typed_owner
       ON typed_owner.id=owner_membership.typed_owner_id
      AND typed_owner.namespace_id=v11.namespace_id
      JOIN typed_v11_record_admissions admission ON admission.typed_record_id=r.storage_row_id
      JOIN telemetry_v11_chunks chunk ON chunk.id=admission.chunk_id AND chunk.stream='usage'
      JOIN telemetry_v11_domain_days domain_day ON domain_day.manifest_id=admission.manifest_id
      JOIN telemetry_v11_day_manifests manifest
       ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
      JOIN typed_v11_manifest_memberships manifest_membership
       ON manifest_membership.manifest_id=domain_day.manifest_id
      JOIN storage_v11_event_sources event ON event.generation_id=domain_day.generation_id
       AND event.owner_digest=? AND event.participant_id=?
      JOIN telemetry_v11_domains generation
       ON generation.id=event.generation_id AND generation.id=domain_day.generation_id
       AND generation.participant_id=chunk.participant_id AND generation.device_id=chunk.device_id
       AND event.manifest_digest=generation.manifest_digest
       AND event.from_day=generation.from_day AND event.through_day=generation.through_day
       AND event.input_revision=generation.input_revision
      JOIN device_credentials generation_device
       ON generation_device.id=generation.device_id
       AND generation_device.participant_id=generation.participant_id
      WHERE v11.source_namespace=? AND r.participant_id=? AND r.source_namespace=v11.source_namespace
        AND r.namespace_id=v11.namespace_id AND r.owner_id=typed_owner.id AND r.format_code=11
        AND r.stream='usage' AND r.observed_day=?
        AND chunk.record_count=(SELECT count(*) FROM typed_v11_record_admissions p WHERE p.chunk_id=chunk.id)
  ), grouped AS (
    SELECT occurrence_id,MIN(observed_at_ms) AS observed_at_ms FROM direct GROUP BY occurrence_id
  )
  SELECT occurrence_id,observed_at_ms FROM grouped
   WHERE observed_at_ms>? OR (observed_at_ms=? AND occurrence_id>?)
   ORDER BY observed_at_ms,occurrence_id LIMIT ?`;

async function readDirectCandidates(db: D1Database, scope: OwnerScope, options: ReturnType<typeof normalizeOptions>): Promise<CandidateRow[]> {
  try {
    const rows = (await db.prepare(CANDIDATE_SQL).bind(
      options.sourceNamespace, options.ownerDigest, scope.participant_id, options.day,
      options.ownerDigest, scope.participant_id, options.sourceNamespace, scope.participant_id, options.day,
      options.after.observedAtMs, options.after.observedAtMs, options.after.occurrenceId, options.limit + 1,
    ).all<CandidateRow>()).results;
    return rows.map((row) => ({ occurrence_id: identifier(row.occurrence_id, OCCURRENCE_ID), observed_at_ms: integer(row.observed_at_ms, -8_640_000_000_000_000, 8_640_000_000_000_000) }));
  } catch (error) {
    if (error instanceof EffectiveUsageReaderError) throw error;
    fail("EFFECTIVE_USAGE_UNAVAILABLE");
  }
}

const DIRECT_SOURCE_SQL = `
  WITH requested(occurrence_id) AS MATERIALIZED (SELECT value FROM json_each(?)),
  direct AS (
    SELECT r.storage_row_id,r.source_namespace,r.participant_id,r.device_id,r.occurrence_id,
           r.observed_at_ms,r.canonical_sha256,r.format_code
      FROM typed_telemetry_compatibility_records r
      JOIN typed_v1_admission_state v1
       ON v1.id=1 AND v1.runtime_contract_version=1 AND v1.source_namespace=?
      JOIN typed_v1_owner_memberships owner_membership
       ON owner_membership.participant_id=r.participant_id
      JOIN typed_telemetry_owners typed_owner
       ON typed_owner.id=owner_membership.typed_owner_id
      AND typed_owner.namespace_id=v1.namespace_id
      JOIN requested wanted ON wanted.occurrence_id=r.occurrence_id
      JOIN typed_v1_record_admissions admission ON admission.typed_record_id=r.storage_row_id
      JOIN telemetry_v1_chunks chunk ON chunk.id=admission.chunk_id
       AND chunk.participant_id=r.participant_id AND chunk.device_id=r.device_id
       AND chunk.stream='usage' AND chunk.superseded_at IS NULL
       AND chunk.accepted_record_count=chunk.record_count
      JOIN typed_v1_event_sources event ON event.chunk_id=chunk.id
       AND event.owner_digest=? AND event.source_namespace=v1.source_namespace
      WHERE r.participant_id=? AND r.source_namespace=v1.source_namespace
        AND r.namespace_id=v1.namespace_id AND r.owner_id=typed_owner.id
        AND r.format_code=10 AND r.stream='usage'
        AND chunk.record_count=(SELECT count(*) FROM typed_v1_record_admissions p WHERE p.chunk_id=chunk.id)
    UNION
    SELECT r.storage_row_id,r.source_namespace,r.participant_id,r.device_id,r.occurrence_id,
           r.observed_at_ms,r.canonical_sha256,r.format_code
      FROM typed_telemetry_compatibility_records r
      JOIN typed_v11_admission_state v11
       ON v11.id=1 AND v11.runtime_contract_version=1
      JOIN typed_v11_owner_memberships owner_membership
       ON owner_membership.participant_id=r.participant_id
      JOIN typed_telemetry_owners typed_owner
       ON typed_owner.id=owner_membership.typed_owner_id
      AND typed_owner.namespace_id=v11.namespace_id
      JOIN requested wanted ON wanted.occurrence_id=r.occurrence_id
      JOIN typed_v11_record_admissions admission ON admission.typed_record_id=r.storage_row_id
      JOIN telemetry_v11_chunks chunk ON chunk.id=admission.chunk_id AND chunk.stream='usage'
      JOIN telemetry_v11_domain_days domain_day ON domain_day.manifest_id=admission.manifest_id
      JOIN telemetry_v11_day_manifests manifest
       ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
      JOIN typed_v11_manifest_memberships manifest_membership
       ON manifest_membership.manifest_id=domain_day.manifest_id
      JOIN storage_v11_event_sources event ON event.generation_id=domain_day.generation_id
       AND event.owner_digest=? AND event.participant_id=?
      JOIN telemetry_v11_domains generation
       ON generation.id=event.generation_id AND generation.id=domain_day.generation_id
       AND generation.participant_id=chunk.participant_id AND generation.device_id=chunk.device_id
       AND event.manifest_digest=generation.manifest_digest
       AND event.from_day=generation.from_day AND event.through_day=generation.through_day
       AND event.input_revision=generation.input_revision
      JOIN device_credentials generation_device
       ON generation_device.id=generation.device_id
       AND generation_device.participant_id=generation.participant_id
      WHERE v11.source_namespace=? AND r.participant_id=? AND r.source_namespace=v11.source_namespace
        AND r.namespace_id=v11.namespace_id AND r.owner_id=typed_owner.id
        AND r.format_code=11 AND r.stream='usage'
        AND chunk.record_count=(SELECT count(*) FROM typed_v11_record_admissions p WHERE p.chunk_id=chunk.id)
  ), grouped AS (
    /* Repeated retained revisions with identical canonical bytes are one
     * semantic source variant. Keep the earliest physical row for audit, but
     * retain every device, timestamp, format, and digest variant so conflicts
     * remain visible to the reconciliation fold. */
    SELECT MIN(storage_row_id) AS storage_row_id,MIN(source_namespace) AS source_namespace,
           MIN(participant_id) AS participant_id,occurrence_id
      FROM direct
     GROUP BY device_id,occurrence_id,observed_at_ms,canonical_sha256,format_code
  )
  SELECT storage_row_id,source_namespace,participant_id,occurrence_id FROM grouped
   ORDER BY occurrence_id,storage_row_id LIMIT ?`;

async function readDirectSourceRows(db: D1Database, scope: OwnerScope, options: ReturnType<typeof normalizeOptions>, occurrenceIds: readonly string[]): Promise<DirectSourceRow[]> {
  if (occurrenceIds.length < 1 || occurrenceIds.length > MAX_EFFECTIVE_USAGE_PAGE) return [];
  try {
    const rows = (await db.prepare(DIRECT_SOURCE_SQL).bind(
      JSON.stringify(occurrenceIds), options.sourceNamespace, options.ownerDigest, scope.participant_id,
      options.ownerDigest, scope.participant_id, options.sourceNamespace, scope.participant_id,
      MAX_EFFECTIVE_USAGE_SOURCE_ROWS + 1,
    ).all<DirectSourceRow>()).results;
    if (rows.length > MAX_EFFECTIVE_USAGE_SOURCE_ROWS) fail("EFFECTIVE_USAGE_LIMIT");
    return rows.map((row) => ({
      storage_row_id: integer(row.storage_row_id, 1),
      source_namespace: identifier(row.source_namespace),
      participant_id: identifier(row.participant_id),
      occurrence_id: identifier(row.occurrence_id, OCCURRENCE_ID),
    }));
  } catch (error) {
    if (error instanceof EffectiveUsageReaderError) throw error;
    fail("EFFECTIVE_USAGE_UNAVAILABLE");
  }
}

async function decodeDirectRows(db: D1Database, rows: readonly DirectSourceRow[], scope: OwnerScope, options: ReturnType<typeof normalizeOptions>): Promise<TypedTelemetryCompatibilityRecord[]> {
  const decoded: TypedTelemetryCompatibilityRecord[] = [];
  for (let offset = 0; offset < rows.length; offset += MAX_TYPED_TELEMETRY_COMPATIBILITY_PAGE) {
    const page = rows.slice(offset, offset + MAX_TYPED_TELEMETRY_COMPATIBILITY_PAGE);
    const result = await readTypedTelemetryRowsByStorageIds(db, {
      sourceNamespace: options.sourceNamespace,
      participantId: scope.participant_id,
      storageRowIds: page.map((row) => row.storage_row_id),
    });
    if (result.some((row, index) => row.participant_id !== scope.participant_id
        || row.source_namespace !== options.sourceNamespace
        || row.stream !== "usage"
        || row.occurrence_id !== page[index]?.occurrence_id)) {
      fail("EFFECTIVE_USAGE_SOURCE_CONFLICT");
    }
    decoded.push(...result);
  }
  return decoded;
}

async function readAllCorrectionFacts(db: D1Database, options: ReturnType<typeof normalizeOptions>, occurrenceIds:readonly string[]): Promise<readonly TelemetryUsageCorrectionFactRow[]> {
  const rows: TelemetryUsageCorrectionFactRow[] = [];
  let afterId = 0;
  let pages = 0;
  for (;;) {
    pages += 1;
    if (pages > MAX_EFFECTIVE_USAGE_ARCHIVE_PAGES) {
      fail("EFFECTIVE_USAGE_LIMIT");
    }
    const page = await readTelemetryUsageCorrectionEffectiveSourceVariants(db, {
      ownerDigest: options.ownerDigest, ownerRevision: options.ownerRevision, authorityEpoch: options.authorityEpoch,
      occurrenceIds, afterId, limit: MAX_TELEMETRY_USAGE_CORRECTION_PAGE,
    });
    rows.push(...page.rows);
    if (rows.length > MAX_EFFECTIVE_USAGE_ARCHIVE_ROWS) fail("EFFECTIVE_USAGE_LIMIT");
    if (page.nextAfterId === null) {
      return Object.freeze(rows);
    }
    if (page.nextAfterId <= afterId) fail("EFFECTIVE_USAGE_SOURCE_CONFLICT");
    afterId = page.nextAfterId;
  }
}

function directSource(ownerScope: string, row: TypedTelemetryCompatibilityRecord): UsageCorrectionSource {
  if (row.format !== "v1" && row.format !== "v11") fail("EFFECTIVE_USAGE_SOURCE_CONFLICT");
  return { ownerScope, format: row.format, recordJson: row.record_json };
}

function v12Source(ownerScope: string, row: V12SourceRow): UsageCorrectionSource {
  return { ownerScope, format: "v12", recordJson: row.record_json };
}

function archiveSource(ownerScope: string, row: TelemetryUsageCorrectionFactRow): UsageCorrectionSource {
  if (row.source.format !== "v1" && row.source.format !== "v11") fail("EFFECTIVE_USAGE_SOURCE_CONFLICT");
  return { ownerScope, format: row.source.format, recordJson: row.recordJson };
}

/** Missing old-client attribution is not conflicting evidence. Preserve a
 * single reported value, but never elect one of two contradictory account or
 * plan assertions. Source occurrence/accounting identity is proven separately. */
function reconciledAttribution(records: readonly Record<string, unknown>[], quota = false): TelemetryV11Attribution {
  const facts = records.map(record => {
    if (record.accountPlanAttribution !== undefined) return parseTelemetryV11Attribution(record.accountPlanAttribution);
    const planType = quota && typeof record.planType === "string" ? record.planType : "unknown";
    return parseTelemetryV11Attribution({ accountBasis: "unavailable", accountTrackId: null,
      planBasis: planType === "unknown" ? "unavailable" : "same_source_occurrence", planType, planEraId: null });
  });
  const accounts = facts.filter(fact => fact.accountBasis !== "unavailable");
  const tracks = new Set(accounts.map(fact => fact.accountTrackId));
  const account = tracks.size === 1 ? accounts.find(fact => fact.accountBasis === "same_source") ?? accounts[0]! : null;
  const plans = facts.filter(fact => !["unavailable", "conflicted"].includes(fact.planBasis));
  const types = new Set(plans.map(fact => fact.planType));
  const eras = new Set(plans.flatMap(fact => fact.planEraId === null ? [] : [fact.planEraId]));
  const conflict = facts.some(fact => fact.planBasis === "conflicted") || types.size > 1 || eras.size > 1;
  const plan = !conflict && types.size === 1 ? plans.find(fact => fact.planBasis === "same_source_occurrence") ?? plans[0]! : null;
  return parseTelemetryV11Attribution({ accountBasis: account?.accountBasis ?? "unavailable",
    accountTrackId: account?.accountTrackId ?? null,
    planBasis: conflict ? "conflicted" : plan?.planBasis ?? "unavailable",
    planType: plan?.planType ?? "unknown", planEraId: plan ? [...eras][0] ?? null : null });
}

async function reconcileGroups(
  ownerScope: string,
  participantId: string,
  day: string,
  ordered: readonly CandidateRow[],
  direct: readonly TypedTelemetryCompatibilityRecord[],
  v12: readonly V12SourceRow[],
  facts: readonly TelemetryUsageCorrectionFactRow[],
): Promise<readonly EffectiveUsageOccurrence[]> {
  const selectedIds = new Set(ordered.map((row) => row.occurrence_id));
  const sources = new Map<string, ReconciledSourceEntry[]>();
  for (const id of selectedIds) sources.set(id, []);
  for (const row of direct) {
    const group = sources.get(row.occurrence_id);
    if (!group) fail("EFFECTIVE_USAGE_SOURCE_CONFLICT");
    group.push({ source: directSource(ownerScope, row), format: row.format,
      sourceRowId: row.source_row_id, sourceKey: `${row.format}:${row.source_row_id}`, historyId: null });
  }
  for (const row of v12) {
    const group = sources.get(row.occurrence_id);
    if (!group) fail("EFFECTIVE_USAGE_SOURCE_CONFLICT");
    group.push({ source: v12Source(ownerScope, row), format: "v12", sourceRowId: null,
      sourceKey: row.source_record_key, historyId: null });
  }
  for (const row of facts) {
    const id = row.source.occurrenceId;
    const group = sources.get(id);
    if (group) group.push({ source: archiveSource(ownerScope, row), format: row.source.format,
      sourceRowId: null, sourceKey: `${row.source.format}:history:${row.id}`, historyId: row.id });
  }
  const output: EffectiveUsageOccurrence[] = [];
  for (const candidate of ordered) {
    const group = sources.get(candidate.occurrence_id)!;
    const all = group;
    if (!all.length) fail("EFFECTIVE_USAGE_SOURCE_CONFLICT");
    const accumulator = createUsageCorrectionOccurrenceAccumulator({ ownerScope, occurrenceId: candidate.occurrence_id });
    for (let offset = 0; offset < all.length; offset += 200) {
      await accumulator.append(all.slice(offset, offset + 200).map((entry) => entry.source));
    }
    const result = accumulator.close();
    const formats = [...new Set(all.map((entry) => entry.format))].sort() as ("v1" | "v11" | "v12")[];
    const sourceRowIds = [...new Set(all.flatMap((entry) => entry.sourceRowId === null ? [] : [entry.sourceRowId]))].sort((a, b) => a - b);
    const sourceRecordKeys = [...new Set(all.map((entry) => entry.sourceKey))].sort();
    const correctionHistoryIds = [...new Set(all.flatMap((entry) => entry.historyId === null ? [] : [entry.historyId]))].sort((a, b) => a - b);
    output.push(Object.freeze({
      methodVersion: EFFECTIVE_USAGE_READER_METHOD, participantId, ownerDigest: ownerScope,
      occurrenceId: result.occurrenceId, eventTime: result.eventTime, eventTimeConflict: result.eventTimeConflict,
      status: result.status, sourceCount: result.sourceCount, sourceFormats: Object.freeze(formats),
      sourceRowIds: Object.freeze(sourceRowIds), sourceRecordKeys: Object.freeze(sourceRecordKeys),
      correctionHistoryIds: Object.freeze(correctionHistoryIds),
      recordJson: result.effectiveLegacyRecord,
      analyticalRecordJson: result.effectiveLegacyRecord === null ? null : canonicalTelemetryV11Json(
        parseTelemetryV11Record("usage", { ...JSON.parse(result.effectiveLegacyRecord), schemaVersion: "usage-event-v1.1",
          accountPlanAttribution: reconciledAttribution(all.map(entry => JSON.parse(entry.source.recordJson))) })),
    }));
  }
  return Object.freeze(output);
}

/**
 * Read one bounded page of complete occurrence groups. The returned cursor is
 * a group cursor, never a physical-row cursor, so a caller cannot resume in
 * the middle of an occurrence and silently lose a late v1/v1.1 variant.
 */
export async function readEffectiveUsageOwnerDayPage(
  db: D1Database,
  input: EffectiveUsageReaderOptions,
): Promise<EffectiveUsageOwnerDayPage> {
  const options = normalizeOptions(input);
  const v12Available = await readV12Availability(db);
  const scope = await readOwnerScope(db, options, v12Available);
  const directCandidates = await readDirectCandidates(db, scope, options);
  const v12Candidates = v12Available
    ? await readAllV12GenericCandidates(db, scope, { ...options, stream: "usage" }) : [];
  const archiveCandidates:CandidateRow[] = scope.correction_state==='active' ? (await readTelemetryUsageCorrectionCandidates(db, {
    ownerDigest:options.ownerDigest,ownerRevision:options.ownerRevision,authorityEpoch:options.authorityEpoch,
    day:options.day,limit:options.limit,after:options.after,
  })).map(row=>({occurrence_id:row.occurrenceId,observed_at_ms:row.observedAtMs})) : [];
  // A late correction fact can carry a timestamp that differs from the
  // current row. Keep the earliest candidate coordinate so the same
  // occurrence remains on the first eligible page; qualification below still
  // expands every source and refuses crossed-day conflicts.
  const candidateByOccurrence = new Map<string, CandidateRow>();
  for (const row of [...directCandidates, ...v12Candidates, ...archiveCandidates]) {
    const previous = candidateByOccurrence.get(row.occurrence_id);
    if (!previous || compareCandidates(row, previous) < 0) {
      candidateByOccurrence.set(row.occurrence_id, row);
    }
  }
  const candidates = [...candidateByOccurrence.values()]
    .filter((row) => cursorAfter(row, options.after)).sort(compareCandidates);
  if (candidates.length < 1) {
    await assertOwnerScopeCurrent(db, options, scope.participant_id, scope, v12Available);
    return Object.freeze({ methodVersion: EFFECTIVE_USAGE_READER_METHOD, participantId: scope.participant_id,
      ownerDigest: options.ownerDigest, day: options.day, rows: Object.freeze([]), next: null });
  }
  const hasMore = candidates.length > options.limit;
  const selected = candidates.slice(0, options.limit);
  const directRows = await readDirectSourceRows(db, scope, options, selected.map((row) => row.occurrence_id));
  const decoded = await decodeDirectRows(db, directRows, scope, options);
  const v12Rows = v12Available
    ? await readV12EffectiveUsageSources(db, scope, selected.map((row) => row.occurrence_id)) : [];
  const facts = scope.correction_state==='active' ? await readAllCorrectionFacts(db,options,selected.map(row=>row.occurrence_id)) : [];
  const rows = await reconcileGroups(options.ownerDigest, scope.participant_id, options.day, selected, decoded, v12Rows, facts);
  await assertOwnerScopeCurrent(db, options, scope.participant_id, scope, v12Available);
  const last = selected.at(-1)!;
  return Object.freeze({ methodVersion: EFFECTIVE_USAGE_READER_METHOD, participantId: scope.participant_id,
    ownerDigest: options.ownerDigest, day: options.day, rows,
    next: hasMore ? Object.freeze({ observedAtMs: last.observed_at_ms, occurrenceId: last.occurrence_id }) : null });
}

/* ------------------------------------------------------------------------- *
 * Version-neutral quota/session cursor.
 *
 * Usage keeps the correction-aware implementation above because only usage
 * has the null-to-known repair contract. Quota and session have no correction
 * facts, but they still need the same owner/domain authority, keyset cursor,
 * all-family occurrence union, and explicit conflict behavior. This additive
 * path returns canonical v1.1-shaped bytes so the existing fold and quota
 * kernels can consume it without a second v1.2 representation.
 * ------------------------------------------------------------------------- */

const EFFECTIVE_TELEMETRY_METHOD = "effective-telemetry-owner-day-v1" as const;
const GENERIC_CANDIDATE_SQL = CANDIDATE_SQL
  .replaceAll("chunk.stream='usage'", "chunk.stream=?")
  .replaceAll("r.stream='usage'", "r.stream=?");
const GENERIC_SOURCE_SQL = DIRECT_SOURCE_SQL
  .replaceAll("chunk.stream='usage'", "chunk.stream=?")
  .replaceAll("r.stream='usage'", "r.stream=?");

interface GenericSourceRow {
  storage_row_id: number;
  source_namespace: string;
  participant_id: string;
  occurrence_id: string;
}

interface GenericCandidateRow extends CandidateRow {}

async function readGenericDirectCandidates(
  db: D1Database,
  scope: OwnerScope,
  options: ReturnType<typeof normalizeOptions>,
): Promise<GenericCandidateRow[]> {
  try {
    const rows = (await db.prepare(GENERIC_CANDIDATE_SQL).bind(
      options.sourceNamespace, options.stream, options.ownerDigest, scope.participant_id, options.stream, options.day,
      options.stream, options.ownerDigest, scope.participant_id, options.sourceNamespace, scope.participant_id,
      options.stream, options.day, options.after.observedAtMs, options.after.observedAtMs,
      options.after.occurrenceId, options.limit + 1,
    ).all<CandidateRow>()).results;
    if (rows.length > MAX_EFFECTIVE_USAGE_SOURCE_ROWS) fail("EFFECTIVE_USAGE_LIMIT");
    return rows.map((row) => ({ occurrence_id: identifier(row.occurrence_id, OCCURRENCE_ID),
      observed_at_ms: integer(row.observed_at_ms, -8_640_000_000_000_000, 8_640_000_000_000_000) }));
  } catch (error) {
    if (error instanceof EffectiveUsageReaderError) throw error;
    fail("EFFECTIVE_USAGE_UNAVAILABLE");
  }
}

async function readGenericSourceRows(
  db: D1Database,
  scope: OwnerScope,
  options: ReturnType<typeof normalizeOptions>,
  occurrenceIds: readonly string[],
): Promise<GenericSourceRow[]> {
  if (occurrenceIds.length < 1 || occurrenceIds.length > MAX_EFFECTIVE_USAGE_PAGE) return [];
  try {
    const rows = (await db.prepare(GENERIC_SOURCE_SQL).bind(
      JSON.stringify(occurrenceIds), options.sourceNamespace, options.stream, options.ownerDigest,
      scope.participant_id, options.stream, options.stream, options.ownerDigest, scope.participant_id,
      options.sourceNamespace, scope.participant_id, options.stream, MAX_EFFECTIVE_USAGE_SOURCE_ROWS + 1,
    ).all<GenericSourceRow>()).results;
    if (rows.length > MAX_EFFECTIVE_USAGE_SOURCE_ROWS) fail("EFFECTIVE_USAGE_LIMIT");
    return rows.map((row) => ({ storage_row_id: integer(row.storage_row_id, 1),
      source_namespace: identifier(row.source_namespace), participant_id: identifier(row.participant_id),
      occurrence_id: identifier(row.occurrence_id, OCCURRENCE_ID) }));
  } catch (error) {
    if (error instanceof EffectiveUsageReaderError) throw error;
    fail("EFFECTIVE_USAGE_UNAVAILABLE");
  }
}

async function decodeGenericRows(
  db: D1Database,
  rows: readonly GenericSourceRow[],
  scope: OwnerScope,
  options: ReturnType<typeof normalizeOptions>,
): Promise<TypedTelemetryCompatibilityRecord[]> {
  const decoded: TypedTelemetryCompatibilityRecord[] = [];
  for (let offset = 0; offset < rows.length; offset += MAX_TYPED_TELEMETRY_COMPATIBILITY_PAGE) {
    const page = rows.slice(offset, offset + MAX_TYPED_TELEMETRY_COMPATIBILITY_PAGE);
    const result = await readTypedTelemetryRowsByStorageIds(db, {
      sourceNamespace: options.sourceNamespace, participantId: scope.participant_id,
      storageRowIds: page.map((row) => row.storage_row_id),
    });
    // The decoder preserves requested physical-ID order. source_row_id is
    // format-scoped and can collide between concurrently retained families.
    if (result.length !== page.length) fail("EFFECTIVE_USAGE_SOURCE_CONFLICT");
    for (const [index, source] of page.entries()) {
      const row = result[index];
      if (!row || row.participant_id !== scope.participant_id || row.source_namespace !== options.sourceNamespace
          || row.stream !== options.stream || row.occurrence_id !== source.occurrence_id) {
        fail("EFFECTIVE_USAGE_SOURCE_CONFLICT");
      }
      decoded.push(row);
    }
  }
  return decoded;
}

async function readAllV12GenericCandidates(
  db: D1Database,
  scope: OwnerScope,
  options: ReturnType<typeof normalizeOptions>,
): Promise<CandidateRow[]> {
  if (scope.v12_state !== "active" || scope.v12_generation_id === null) return [];
  const output=new Map<string,CandidateRow>();
  let scanned=0;
  let after: EffectiveUsageReaderCursor | undefined = options.after.observedAtMs === -8_640_000_000_000_000
    && options.after.occurrenceId === "" ? undefined : options.after;
  for (;;) {
    const page = await readTelemetryV12EffectiveCandidatePage(db, { participantId: scope.participant_id, day: options.day,
      stream: options.stream, after, limit: Math.min(200, options.limit + 1 - output.size) });
    if (!page.available) return [];
    scanned+=page.records.length;
    if(scanned>MAX_EFFECTIVE_USAGE_SOURCE_ROWS)fail('EFFECTIVE_USAGE_LIMIT');
    for(const row of page.records){
      const prior=output.get(row.occurrenceId);
      if(!prior||row.observedAtMs<prior.observed_at_ms)output.set(row.occurrenceId,{
        occurrence_id:row.occurrenceId,observed_at_ms:row.observedAtMs});
    }
    if(output.size>=options.limit+1||!page.next)return [...output.values()];
    if(after&&page.next.observedAtMs===after.observedAtMs&&page.next.occurrenceId===after.occurrenceId)
      fail('EFFECTIVE_USAGE_SOURCE_CONFLICT');
    after=page.next;
  }
}

/** Usage uses the same public v1.2 decoder as quota/session. The correction
 * reconciler needs canonical successor bytes, while generic streams consume
 * the projected v1.1 bytes exposed by that boundary. This conversion keeps a
 * second physical v1.2 SQL layout from surviving the compact typed migration.
 */
async function readV12EffectiveUsageSources(
  db: D1Database,
  scope: OwnerScope,
  occurrenceIds: readonly string[],
): Promise<readonly V12SourceRow[]> {
  if (scope.v12_state !== "active" || scope.v12_generation_id === null || occurrenceIds.length < 1) return [];
  const result = await readTelemetryV12EffectiveOccurrences(db, {
    participantId: scope.participant_id, stream: "usage", occurrenceIds,
  });
  if (!result.available) return [];
  return Object.freeze(result.records.map((row) => {
    if (!/^v12:record:[1-9][0-9]*$/u.test(row.sourceRecordKey)) {
      fail("EFFECTIVE_USAGE_SOURCE_CONFLICT");
    }
    return { source_record_key: row.sourceRecordKey, occurrence_id: row.occurrenceId,
      observed_at: row.observedAt, record_json: row.sourceRecordJson, canonical_digest: "" };
  }));
}

interface GenericSourceEntry {
  format: "v1" | "v11" | "v12";
  sourceRowId: number | null;
  sourceKey: string;
  observedAt: string;
  recordJson: string;
}

/** Canonicalize retained v1 records into the v1.1 analytical shape used by
 * the generic stream reader. This is a projection for overlap comparison and
 * folding only; source format and source keys remain in the result. */
function genericRecordJson(row: TypedTelemetryCompatibilityRecord): string {
  if (row.format === "v11") return row.record_json;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.record_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("EFFECTIVE_USAGE_SOURCE_CONFLICT");
    value = { ...(parsed as Record<string, unknown>) };
  } catch { fail("EFFECTIVE_USAGE_SOURCE_CONFLICT"); }
  const schema = value.schemaVersion;
  if (typeof schema !== "string" || !schema.endsWith("-v1.0")) fail("EFFECTIVE_USAGE_SOURCE_CONFLICT");
  if (row.stream !== "session") {
    const planType = row.stream === "quota" && typeof value.planType === "string" ? value.planType : "unknown";
    value.accountPlanAttribution = {
      accountBasis: "unavailable", accountTrackId: null,
      planBasis: planType === "unknown" ? "unavailable" : "same_source_occurrence",
      planType, planEraId: null,
    };
  }
  value.schemaVersion = `${schema.slice(0, -"v1.0".length)}v1.1`;
  return canonicalTelemetryV11Json(value);
}

function genericOccurrence(
  ownerDigest: string,
  participantId: string,
  streamName: EffectiveTelemetryStream,
  candidate: CandidateRow,
  direct: readonly TypedTelemetryCompatibilityRecord[],
  v12: readonly TelemetryV12EffectiveRecord[],
): EffectiveTelemetryOccurrence {
  const entries: GenericSourceEntry[] = [
    ...direct.filter((row) => row.occurrence_id === candidate.occurrence_id).map((row) => ({
      format: row.format, sourceRowId: row.source_row_id, sourceKey: `${row.format}:${row.source_row_id}`,
      observedAt: row.observed_at, recordJson: genericRecordJson(row),
    })),
    ...v12.filter((row) => row.occurrenceId === candidate.occurrence_id).map((row) => ({
      format: "v12" as const, sourceRowId: null, sourceKey: row.sourceRecordKey,
      observedAt: row.observedAt, recordJson: row.recordJson,
    })),
  ];
  if (!entries.length) fail("EFFECTIVE_USAGE_SOURCE_CONFLICT");
  const times = [...new Set(entries.map((entry) => entry.observedAt))].sort();
  const parsed = entries.map(entry => JSON.parse(entry.recordJson) as Record<string, unknown>);
  const records = [...new Set(parsed.map(record => {
    if (streamName === "session") return canonicalTelemetryV11Json(record);
    const { accountPlanAttribution: _attribution, ...base } = record;
    return canonicalTelemetryV11Json(base);
  }))].sort();
  const eventTimeConflict = times.length > 1;
  let conflict = eventTimeConflict || records.length > 1;
  let effective: string | null = null;
  if (!conflict) {
    try {
      effective = canonicalTelemetryV11Json(parseTelemetryV11Record(streamName, streamName === "session"
        ? parsed[0] : { ...parsed[0], accountPlanAttribution: reconciledAttribution(parsed, true) }));
    } catch { conflict = true; }
  }
  return Object.freeze({ methodVersion: EFFECTIVE_TELEMETRY_METHOD, stream: streamName,
    participantId, ownerDigest, occurrenceId: candidate.occurrence_id,
    eventTime: eventTimeConflict ? null : times[0]!, eventTimeConflict,
    status: conflict ? "conflict" : "compatible", sourceCount: entries.length,
    sourceFormats: Object.freeze([...new Set(entries.map((entry) => entry.format))].sort() as ("v1" | "v11" | "v12")[]),
    sourceRowIds: Object.freeze([...new Set(entries.flatMap((entry) => entry.sourceRowId === null ? [] : [entry.sourceRowId]))].sort((a, b) => a - b)),
    sourceRecordKeys: Object.freeze([...new Set(entries.map((entry) => entry.sourceKey))].sort()),
    recordJson: conflict ? null : effective,
  });
}

/** Read a group-safe page for any telemetry stream. The usage branch delegates
 * to the correction-aware reader above; quota/session share its authority and
 * cursor but deliberately have no usage correction semantics. */
export async function readEffectiveTelemetryOwnerDayPage(
  db: D1Database,
  input: EffectiveTelemetryReaderOptions,
): Promise<EffectiveTelemetryOwnerDayPage> {
  const options = normalizeOptions(input);
  if (options.stream === "usage") {
    const page = await readEffectiveUsageOwnerDayPage(db, input);
    return Object.freeze({ methodVersion: EFFECTIVE_TELEMETRY_METHOD, stream: "usage", participantId: page.participantId,
      ownerDigest: page.ownerDigest, day: page.day,
      rows: Object.freeze(page.rows.map((row) => Object.freeze({ methodVersion: EFFECTIVE_TELEMETRY_METHOD,
        stream: "usage" as const, participantId: row.participantId, ownerDigest: row.ownerDigest,
        occurrenceId: row.occurrenceId, eventTime: row.eventTime, eventTimeConflict: row.eventTimeConflict,
        status: row.status === "compatible" ? "compatible" as const : "conflict" as const,
        sourceCount: row.sourceCount, sourceFormats: row.sourceFormats, sourceRowIds: row.sourceRowIds,
        sourceRecordKeys: row.sourceRecordKeys, recordJson: row.analyticalRecordJson }))), next: page.next });
  }
  const scope = await readOwnerScope(db, options, await readV12Availability(db));
  const directCandidates = await readGenericDirectCandidates(db, scope, options);
  const v12Candidates = await readAllV12GenericCandidates(db, scope, options);
  const byOccurrence = new Map<string, CandidateRow>();
  for (const row of [...directCandidates, ...v12Candidates]) {
    const old = byOccurrence.get(row.occurrence_id);
    if (!old || compareCandidates(row, old) < 0) byOccurrence.set(row.occurrence_id, row);
  }
  const candidates = [...byOccurrence.values()].filter((row) => cursorAfter(row, options.after)).sort(compareCandidates);
  const hasMore = candidates.length > options.limit;
  const selected = candidates.slice(0, options.limit);
  if (!selected.length) {
    await assertOwnerScopeCurrent(db, options, scope.participant_id, scope, scope.v12_state !== null);
    return Object.freeze({ methodVersion: EFFECTIVE_TELEMETRY_METHOD, stream: options.stream,
      participantId: scope.participant_id, ownerDigest: options.ownerDigest, day: options.day,
      rows: Object.freeze([]), next: null });
  }
  const selectedIds = selected.map((row) => row.occurrence_id);
  const sourceRows = await readGenericSourceRows(db, scope, options, selectedIds);
  const decoded = await decodeGenericRows(db, sourceRows, scope, options);
  const v12 = scope.v12_state === "active" ? await readTelemetryV12EffectiveOccurrences(db, {
    participantId: scope.participant_id, stream: options.stream, occurrenceIds: selectedIds,
  }) : { available: false, records: [] as readonly TelemetryV12EffectiveRecord[] };
  const rows = selected.map((candidate) => genericOccurrence(options.ownerDigest, scope.participant_id,
    options.stream, candidate, decoded, v12.records));
  await assertOwnerScopeCurrent(db, options, scope.participant_id, scope, scope.v12_state !== null);
  const last = selected.at(-1)!;
  return Object.freeze({ methodVersion: EFFECTIVE_TELEMETRY_METHOD, stream: options.stream,
    participantId: scope.participant_id, ownerDigest: options.ownerDigest, day: options.day,
    rows: Object.freeze(rows), next: hasMore ? Object.freeze({ observedAtMs: last.observed_at_ms,
      occurrenceId: last.occurrence_id }) : null });
}

/** Closed, bounded inventory of nonempty evidence days. This uses the same
 * admitted source joins as occurrence reads, without decoding usage payloads.
 * The inventory is pinned by the caller's owner revision across checkpoints. */
export async function readEffectiveTelemetryOwnerDays(db:D1Database,input:Omit<EffectiveTelemetryReaderOptions,'day'|'after'|'limit'> & {
  fromDay:string;throughDay:string;
}):Promise<readonly string[]> {
  const fromDay=validDay(input.fromDay),throughDay=validDay(input.throughDay);
  if(throughDay<fromDay||Date.parse(throughDay)-Date.parse(fromDay)>100*86400000)fail();
  const {fromDay:_,throughDay:__,...base}=input;
  const options=normalizeOptions({...base,day:fromDay});
  const v12Available=await readV12Availability(db),scope=await readOwnerScope(db,options,v12Available);
  const prefix=GENERIC_CANDIDATE_SQL.split('  ), grouped AS (')[0]!
    .replaceAll('SELECT r.occurrence_id,r.observed_at_ms','SELECT r.observed_day')
    .replaceAll('r.observed_day=?','r.observed_day>=? AND r.observed_day<=?');
  const rows=(await db.prepare(`${prefix}) SELECT DISTINCT observed_day FROM direct ORDER BY observed_day LIMIT 102`)
    .bind(options.sourceNamespace,options.stream,options.ownerDigest,scope.participant_id,options.stream,fromDay,throughDay,
      options.stream,options.ownerDigest,scope.participant_id,options.sourceNamespace,scope.participant_id,
      options.stream,fromDay,throughDay).all<{observed_day:string}>()).results;
  const days=new Set(rows.map(row=>validDay(row.observed_day)));
  if(options.stream==='usage'&&scope.correction_state==='active'){
    const archive=(await db.prepare(`SELECT DISTINCT CAST(h.event_time_ms / 86400000 AS INTEGER) AS day_number
      FROM telemetry_usage_correction_history h JOIN telemetry_usage_correction_facts f ON f.history_id=h.id
      JOIN storage_owner_revisions o ON o.owner_digest=lower(hex(h.owner_digest)) AND o.state='active'
      WHERE o.owner_digest=? AND h.event_time_ms>=? AND h.event_time_ms<? ORDER BY day_number LIMIT 102`)
      .bind(options.ownerDigest,Date.parse(fromDay),Date.parse(throughDay)+86400000).all<{day_number:number}>()).results;
    for(const row of archive)days.add(validDay(new Date(row.day_number*86400000).toISOString().slice(0,10)));
  }
  if(v12Available&&scope.v12_state==='active')for(const day of await readTelemetryV12EffectiveDays(db,{
    participantId:scope.participant_id,fromDay,throughDay,stream:options.stream,
  }))days.add(day);
  if(days.size>101||[...days].some(day=>day<fromDay||day>throughDay))fail('EFFECTIVE_USAGE_LIMIT');
  await assertOwnerScopeCurrent(db,options,scope.participant_id,scope,v12Available);
  return Object.freeze([...days].sort());
}
