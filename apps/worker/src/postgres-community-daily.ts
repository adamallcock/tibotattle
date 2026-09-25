import {
  COMMUNITY_ALLOWANCE_BASIS,
  COMMUNITY_ATTRIBUTION_METHOD_VERSION,
  COMMUNITY_ALLOWANCE_QUALIFICATION,
  COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP,
  COMMUNITY_ALLOWANCE_TRAILING_DAYS,
} from "./community-allowance";
import { SEVEN_DAY_WINDOW_MINUTES } from "@app-usagemonitor/quota-analysis";
import {
  isCurrentCommunityAllowancePublication,
  type CommunityAllowancePublicationStateRow,
  type PublishedCommunityDailyRead,
} from "./community-daily-aggregates";
import { isCurrentCommunityDailySpend } from "./community-daily-spend";
import {
  createPostgresSchemaConfig,
  createPostgresSourceIdentityConfig,
  PostgresStorageError,
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import { sha256Hex } from "./crypto";

const MAX_DAILY_RANGE_DAYS = 366;
const MAX_DAILY_PAYLOAD_BYTES = 262_144;
const MINIMUM_FITS_FOR_BAND = 3;
const DAILY_PAYLOAD_SCHEMA = "community-daily-aggregate-v1.0";
const DAILY_POLICY_VERSION = "community-daily-v1.0";
const DAILY_SUPPRESSION_POLICY = "none_daily_grain_by_owner_decision";
const DAILY_TOTAL_KEYS = Object.freeze([
  "contributingParticipants", "contributingDevices", "usageEvents",
  "quotaObservations", "sessionDimensions", "inputUncachedTokens",
  "inputCacheReadTokens", "inputCacheWriteTokens", "outputTextTokens",
  "outputReasoningTokens", "outputCombinedTokens",
]);
const DAILY_CELL_KEYS = Object.freeze([
  "provider", "modelId", "usageEvents", "inputUncachedTokens",
  "inputCacheReadTokens", "inputCacheWriteTokens", "outputTextTokens",
  "outputReasoningTokens", "outputCombinedTokens",
]);
const DAILY_ALLOWANCE_KEYS = Object.freeze([
  "basis", "limitId", "referencePlanType", "normalization", "windowDurationMinutes",
  "trailingDays", "qualification", "spanFloorPp", "fitCount", "participantCount",
  "centralUsd", "band80Usd",
]);

type RecordValue = Record<string, unknown>;

interface CommunityDailyQueryRow {
  readonly day: string;
  readonly revision: string | number;
  readonly payload_json: string;
  readonly payload_sha256: string;
  readonly released_at: string;
}

interface AllowanceStateQueryRow extends CommunityAllowancePublicationStateRow {
  readonly source_authority_epoch: string | number;
  readonly source_cursor_sequence: string | number;
  readonly current_authority_epoch: string | number;
  readonly current_cursor_sequence: string | number;
  readonly latest_sequence: string | number;
  readonly hard_invalidation_sequence: string | number;
  readonly policy_revision: string | number;
  readonly current_policy_revision: string | number;
  readonly collection_revision: string | number;
  readonly current_collection_revision: string | number;
  readonly control_state: string;
  readonly publication_enabled: boolean;
}

interface AllowancePreviewQueryRow {
  readonly generated_at: string;
  readonly payload_json: string;
  readonly payload_sha256: string;
}

function fail(): never {
  throw new PostgresStorageError("invalid", "community_daily.payload", { retryable: false });
}

function integer(value: unknown, minimum = 0): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum) fail();
  return parsed;
}

function validDay(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
      || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new TypeError("invalid community daily date");
  }
  return value;
}

function exactKeys(value: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function object(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : null;
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function projectDailyAllowance(value: unknown): RecordValue | null {
  const allowance = object(value);
  if (!allowance || !exactKeys(allowance, DAILY_ALLOWANCE_KEYS)
      || allowance.basis !== COMMUNITY_ALLOWANCE_BASIS
      || allowance.limitId !== "codex" || allowance.referencePlanType !== "pro"
      || allowance.normalization !== "pro_x1_prolite_x4_plus_x20"
      || allowance.qualification !== COMMUNITY_ALLOWANCE_QUALIFICATION
      || allowance.windowDurationMinutes !== SEVEN_DAY_WINDOW_MINUTES
      || allowance.trailingDays !== COMMUNITY_ALLOWANCE_TRAILING_DAYS
      || allowance.spanFloorPp !== COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP
      || !nonnegativeSafeInteger(allowance.fitCount)
      || !nonnegativeSafeInteger(allowance.participantCount)
      || allowance.participantCount > allowance.fitCount) return null;
  if (allowance.fitCount === 0) {
    if (allowance.participantCount !== 0 || allowance.centralUsd !== null || allowance.band80Usd !== null) {
      return null;
    }
  } else if (allowance.participantCount === 0 || typeof allowance.centralUsd !== "number"
      || !Number.isFinite(allowance.centralUsd) || allowance.centralUsd < 0) return null;
  const band = allowance.band80Usd === null ? null : object(allowance.band80Usd);
  if ((allowance.fitCount < MINIMUM_FITS_FOR_BAND && band !== null)
      || (allowance.fitCount >= MINIMUM_FITS_FOR_BAND && band === null)
      || (band !== null && (!exactKeys(band, ["lowerUsd", "upperUsd"])
        || typeof band.lowerUsd !== "number" || !Number.isFinite(band.lowerUsd) || band.lowerUsd < 0
        || typeof band.upperUsd !== "number" || !Number.isFinite(band.upperUsd) || band.upperUsd < band.lowerUsd
        || band.lowerUsd > Number(allowance.centralUsd)
        || Number(allowance.centralUsd) > band.upperUsd))) {
    return null;
  }
  return {
    basis: allowance.basis,
    limitId: allowance.limitId,
    referencePlanType: allowance.referencePlanType,
    normalization: allowance.normalization,
    windowDurationMinutes: allowance.windowDurationMinutes,
    trailingDays: allowance.trailingDays,
    qualification: allowance.qualification,
    spanFloorPp: allowance.spanFloorPp,
    fitCount: allowance.fitCount,
    participantCount: allowance.participantCount,
    centralUsd: allowance.centralUsd,
    band80Usd: band === null ? null : { lowerUsd: band.lowerUsd, upperUsd: band.upperUsd },
  };
}

/**
 * Project a hash-verified immutable daily record onto the Worker-owned closed
 * public shape. Capacity diagnostics and unknown fields never cross the read
 * adapter. Allowance and spend keep the Worker route's currentness gates.
 */
function projectDailyPayload(
  rawJson: string,
  expectedDay: string,
  expectedRevision: number,
  releasedAt: string,
  allowanceReady: boolean,
): string {
  if (new TextEncoder().encode(rawJson).byteLength > MAX_DAILY_PAYLOAD_BYTES) fail();
  let parsed: unknown;
  try { parsed = JSON.parse(rawJson); } catch { return fail(); }
  const raw = object(parsed);
  if (!raw) fail();
  const allowedOuter = [
    "schemaVersion", "aggregateId", "day", "revision", "releasedAt", "immutableRevision",
    "recomputesOnLateData", "policyVersion", "suppression", "allowance", "apiEquivalentSpend",
    "totals", "cellsTruncated", "cells", "capacityByPlanType",
  ];
  if (Object.keys(raw).some((key) => !allowedOuter.includes(key))
      || raw.schemaVersion !== DAILY_PAYLOAD_SCHEMA
      || raw.aggregateId !== `community-daily:${expectedDay}:r${expectedRevision}`
      || raw.day !== expectedDay || integer(raw.revision, 1) !== expectedRevision
      || typeof raw.releasedAt !== "string" || !Number.isFinite(Date.parse(raw.releasedAt))
      || Math.floor(Date.parse(raw.releasedAt)) !== Math.floor(Date.parse(releasedAt))
      || raw.immutableRevision !== true || raw.recomputesOnLateData !== true
      || raw.policyVersion !== DAILY_POLICY_VERSION
      || raw.suppression !== DAILY_SUPPRESSION_POLICY || typeof raw.cellsTruncated !== "boolean"
      || !Array.isArray(raw.cells) || raw.cells.length > 100) fail();

  const totals = object(raw.totals);
  if (!totals || !exactKeys(totals, DAILY_TOTAL_KEYS)
      || !DAILY_TOTAL_KEYS.every((key) => nonnegativeSafeInteger(totals[key]))) fail();
  const cells = raw.cells.map((value) => {
    const cell = object(value);
    if (!cell || !exactKeys(cell, DAILY_CELL_KEYS)
        || typeof cell.provider !== "string" || cell.provider.length < 1 || cell.provider.length > 128
        || typeof cell.modelId !== "string" || cell.modelId.length < 1 || cell.modelId.length > 512
        || !DAILY_CELL_KEYS.slice(2).every((key) => nonnegativeSafeInteger(cell[key]))) fail();
    return Object.fromEntries(DAILY_CELL_KEYS.map((key) => [key, cell[key]]));
  });

  const payload: RecordValue = {
    schemaVersion: DAILY_PAYLOAD_SCHEMA,
    aggregateId: raw.aggregateId,
    day: expectedDay,
    revision: expectedRevision,
    releasedAt: raw.releasedAt,
    immutableRevision: true,
    recomputesOnLateData: true,
    policyVersion: DAILY_POLICY_VERSION,
    suppression: DAILY_SUPPRESSION_POLICY,
    totals: Object.fromEntries(DAILY_TOTAL_KEYS.map((key) => [key, totals[key]])),
    cellsTruncated: raw.cellsTruncated,
    cells,
  };
  if (allowanceReady && raw.allowance !== undefined) {
    const allowance = projectDailyAllowance(raw.allowance);
    if (allowance !== null) payload.allowance = allowance;
  }
  if (isCurrentCommunityDailySpend(raw.apiEquivalentSpend)
      && object(raw.totals)?.usageEvents === raw.apiEquivalentSpend.usageEvents) {
    payload.apiEquivalentSpend = raw.apiEquivalentSpend;
  }
  return JSON.stringify(payload);
}

function validPreviewHash(row: AllowancePreviewQueryRow): Promise<boolean> {
  return sha256Hex(row.payload_json).then((hash) => hash === row.payload_sha256);
}

/**
 * Read the immutable published daily revisions on one repeatable-read
 * snapshot. Latest revisions are selected before withdrawal and authority
 * filters, so an older row cannot reappear behind a withdrawn successor.
 * Optional allowance reads live in a savepoint; a cache/schema failure leaves
 * valid daily activity readable and signals no-store to a future route edge.
 */
export async function readPostgresPublishedCommunityDaily(
  pool: PostgresPool,
  options: {
    readonly sourceId: string;
    readonly sourceNamespace: string;
    readonly fromDay: string;
    readonly throughDay: string;
    readonly nowMs?: number;
    readonly schema?: PostgresSchemaOptions;
  },
): Promise<PublishedCommunityDailyRead> {
  let identity;
  let fromDay: string;
  let throughDay: string;
  const nowMs = options.nowMs ?? Date.now();
  try {
    identity = createPostgresSourceIdentityConfig(options);
    fromDay = validDay(options.fromDay);
    throughDay = validDay(options.throughDay);
    if (!Number.isFinite(nowMs) || throughDay < fromDay
        || (Date.parse(`${throughDay}T00:00:00.000Z`)
          - Date.parse(`${fromDay}T00:00:00.000Z`)) / 86_400_000 >= MAX_DAILY_RANGE_DAYS) {
      throw new TypeError("invalid community daily range");
    }
  } catch {
    throw new PostgresStorageError("invalid", "community_daily.range", { retryable: false });
  }
  const schemas = createPostgresSchemaConfig(options.schema);
  const schema = quotePostgresIdentifier(schemas.primarySchema);

  return withPostgresRead(pool, async (client) => {
    const dailyResult = await client.query<CommunityDailyQueryRow>(
      `WITH ranked AS (
         SELECT aggregate.*,
                row_number() OVER (PARTITION BY aggregate.day ORDER BY aggregate.revision DESC) AS revision_rank
           FROM ${schema}.community_daily_aggregates aggregate
          WHERE aggregate.source_id = $1 AND aggregate.source_namespace = $2
            AND aggregate.day >= $3::date AND aggregate.day <= $4::date
       )
       SELECT aggregate.day::text AS day, aggregate.revision, aggregate.payload_json,
              aggregate.payload_sha256, aggregate.released_at::text AS released_at
         FROM ranked aggregate
         JOIN ${schema}.storage_source_state source
           ON source.singleton = 1 AND source.source_id = aggregate.source_id
         JOIN ${schema}.analytics_source_cursors cursor ON cursor.source_id = source.source_id
         JOIN ${schema}.publication_state policy ON policy.singleton = 1
         JOIN ${schema}.collection_controls controls ON controls.singleton = 1
        WHERE aggregate.revision_rank = 1 AND aggregate.release_state = 'published'
          AND aggregate.source_authority_epoch <= source.authority_epoch
          AND aggregate.source_cursor_sequence <= cursor.sequence
          AND aggregate.policy_revision = policy.policy_revision
          AND aggregate.collection_revision = controls.revision
          AND controls.control_state = 'operational' AND controls.publication_enabled
          AND COALESCE((SELECT max(change.sequence) FROM ${schema}.storage_ingestion_changes change
            WHERE change.source_id = aggregate.source_id
              AND change.kind IN ('owner-withdrawn', 'owner-erased')), 0)
              <= aggregate.source_cursor_sequence
        ORDER BY aggregate.day ASC`,
      [identity.sourceId, identity.sourceNamespace, fromDay, throughDay],
    );
    if (!Array.isArray(dailyResult.rows) || dailyResult.rows.length > MAX_DAILY_RANGE_DAYS) fail();

    let allowancePublicationState: CommunityAllowancePublicationStateRow | null = null;
    let allowanceBreakdownsCache: PublishedCommunityDailyRead["allowanceBreakdownsCache"] = null;
    let allowanceReadState: PublishedCommunityDailyRead["allowanceReadState"] = "confirmed";
    await client.query("SAVEPOINT community_daily_optional_reads");
    try {
      const stateResult = await client.query<AllowanceStateQueryRow>(
        `SELECT state.publication_state, state.expected_basis, state.attribution_method_version,
                state.safe_from_day::text AS safe_from_day, state.safe_to_day::text AS safe_to_day,
                state.source_authority_epoch, state.source_cursor_sequence,
                source.authority_epoch AS current_authority_epoch,
                cursor.sequence AS current_cursor_sequence,
                COALESCE((SELECT max(change.sequence) FROM ${schema}.storage_ingestion_changes change
                  WHERE change.source_id = source.source_id), 0) AS latest_sequence,
                state.hard_invalidation_sequence, state.policy_revision, policy.policy_revision AS current_policy_revision,
                state.collection_revision, controls.revision AS current_collection_revision,
                controls.control_state, controls.publication_enabled
           FROM ${schema}.community_daily_allowance_publication_state state
           JOIN ${schema}.storage_source_state source
             ON source.singleton = 1 AND source.source_id = state.source_id
           JOIN ${schema}.analytics_source_cursors cursor ON cursor.source_id = source.source_id
           JOIN ${schema}.publication_state policy ON policy.singleton = 1
           JOIN ${schema}.collection_controls controls ON controls.singleton = 1
          WHERE state.source_id = $1 AND state.source_namespace = $2`,
        [identity.sourceId, identity.sourceNamespace],
      );
      const state = stateResult.rows[0];
      if (state && integer(state.source_authority_epoch) === integer(state.current_authority_epoch)
          && integer(state.source_cursor_sequence) === integer(state.current_cursor_sequence)
          && integer(state.current_cursor_sequence) === integer(state.latest_sequence)
          && integer(state.source_cursor_sequence) >= integer(state.hard_invalidation_sequence)
          && integer(state.policy_revision, 1) === integer(state.current_policy_revision, 1)
          && integer(state.collection_revision, 1) === integer(state.current_collection_revision, 1)
          && state.control_state === "operational" && state.publication_enabled === true) {
        allowancePublicationState = {
          publication_state: state.publication_state,
          expected_basis: state.expected_basis,
          attribution_method_version: state.attribution_method_version,
          safe_from_day: state.safe_from_day,
          safe_to_day: state.safe_to_day,
        };
      }

      const cacheResult = await client.query<AllowancePreviewQueryRow>(
        `SELECT cache.generated_at::text AS generated_at, cache.payload_json, cache.payload_sha256
           FROM ${schema}.community_daily_allowance_preview_cache cache
           JOIN ${schema}.community_daily_allowance_publication_state state
             ON state.source_id = cache.source_id AND state.source_namespace = cache.source_namespace
           JOIN ${schema}.storage_source_state source
             ON source.singleton = 1 AND source.source_id = cache.source_id
           JOIN ${schema}.analytics_source_cursors cursor ON cursor.source_id = source.source_id
           JOIN ${schema}.publication_state policy ON policy.singleton = 1
           JOIN ${schema}.collection_controls controls ON controls.singleton = 1
          WHERE cache.source_id = $1 AND cache.source_namespace = $2
            AND cache.attribution_method_version = $3
            AND octet_length(convert_to(cache.payload_json, 'UTF8')) <= $4
            AND cache.source_authority_epoch = source.authority_epoch
            AND cache.source_cursor_sequence >= state.hard_invalidation_sequence
            AND cache.source_cursor_sequence <= cursor.sequence
            AND cache.policy_revision = policy.policy_revision
            AND cache.collection_revision = controls.revision
            AND controls.control_state = 'operational' AND controls.publication_enabled
          LIMIT 1`,
        [identity.sourceId, identity.sourceNamespace, COMMUNITY_ATTRIBUTION_METHOD_VERSION,
          MAX_DAILY_PAYLOAD_BYTES],
      );
      const cache = cacheResult.rows[0];
      if (cache && new TextEncoder().encode(cache.payload_json).byteLength <= MAX_DAILY_PAYLOAD_BYTES
          && await validPreviewHash(cache)) {
        allowanceBreakdownsCache = { generated_at: cache.generated_at, payload_json: cache.payload_json };
      }
      await client.query("RELEASE SAVEPOINT community_daily_optional_reads");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT community_daily_optional_reads");
      await client.query("RELEASE SAVEPOINT community_daily_optional_reads");
      allowancePublicationState = null;
      allowanceBreakdownsCache = null;
      allowanceReadState = "temporarily_unavailable";
    }

    const allowanceReady = isCurrentCommunityAllowancePublication(allowancePublicationState, nowMs);
    const rows = [];
    for (const row of dailyResult.rows) {
      const revision = integer(row.revision, 1);
      const day = validDay(row.day);
      if (!/^[0-9a-f]{64}$/u.test(row.payload_sha256)
          || await sha256Hex(row.payload_json) !== row.payload_sha256) fail();
      rows.push({
        day,
        revision,
        payload_json: projectDailyPayload(row.payload_json, day, revision, row.released_at, allowanceReady),
        released_at: row.released_at,
      });
    }
    return {
      rows,
      allowancePublicationState,
      allowanceBreakdownsCache,
      allowanceReadState,
      // No PostgreSQL cache-retention producer/table exists yet. Absence is
      // deliberate and must not be represented as an empty or zero series.
      cacheRetention: null,
    };
  }, {
    operation: "community_daily.read",
    preserveSafeError: (error) => error instanceof PostgresStorageError ? error : null,
  });
}
