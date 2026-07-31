import { sha256Hex } from "./crypto";
import {
  MAX_TELEMETRY_CONTRIBUTIONS_PER_ADMISSION_WINDOW,
  TELEMETRY_CONTRIBUTION_ADMISSION_WINDOW_MILLISECONDS,
} from "./constants";
import { ApiError } from "./errors";
import {
  priceTelemetryUsageEvent,
  type ServerPricingResult,
} from "./server-pricing";
import { accountScopedQuotaAnalysis } from "./quota-analysis";
import { contributionQuarantineLifecycle } from "./contribution-lifecycle";
import type {
  TelemetryActivityMarker,
  TelemetryContribution,
  TelemetryEnvelope,
  TelemetryQuotaSnapshot,
  TelemetryUsageEvent,
} from "./telemetry-validation";

export interface TelemetryContributionRow {
  id: string;
  participant_id: string;
  plaintext_digest: string;
  envelope_digest: string;
  r2_key: string;
  status: "accepted" | "deleting";
  schema_version: "telemetry-contribution-v0.1";
  transport_schema_version?: "telemetry-contribution-v0.1" | "telemetry-contribution-v0.2";
  dataset_id?: string | null;
  dataset_part_index?: number | null;
  dataset_part_count?: number | null;
  dataset_completeness?: "complete" | "partial" | null;
  dataset_range_start?: string | null;
  dataset_range_end?: string | null;
  range_start: string;
  range_end: string;
  client_platform: string;
  provider_policy_epoch: string;
  estimated_api_cost_usd: string | null;
  priced_event_coverage_percent: number;
  unknown_model_event_count: number;
  unknown_billable_units: number;
  price_basis: string;
  declared_record_count: number;
  accepted_record_count?: number;
  created_at: string;
  quarantine_deleted_at?: string | null;
  server_cost_nanousd?: number;
  server_priced_event_count?: number;
  server_partially_priced_event_count?: number;
  server_unpriced_event_count?: number;
  server_pricing_method_version?: string | null;
  server_price_registry_version?: string | null;
  server_price_registry_sha256?: string | null;
}

export interface TelemetryTransportMetadata {
  transportSchemaVersion: "telemetry-contribution-v0.2";
  datasetId: string;
  partIndex: number;
  partCount: number;
  completeness: "complete" | "partial";
  rangeStart: string;
  rangeEnd: string;
  policyEpoch: string;
  usage: Map<string, { accountTrackId: string; recordJson: string }>;
  quota: Map<string, { accountTrackId: string; recordJson: string }>;
  activity: Map<string, { accountTrackId: string; recordJson: string }>;
}

export interface TelemetryContributionAdmission {
  schemaVersion: "telemetry-contribution-admission-v0.1";
  state: "available" | "exhausted";
  window: {
    kind: "fixed_utc";
    anchor: "monday_00_00_utc";
    startsAt: string;
    endsAt: string;
    durationMilliseconds: number;
  };
  acceptedBatches: number;
  remainingBatches: number;
  maximumBatches: number;
  slotRefundPolicy: "not_refunded_by_contribution_deletion";
}

const MONDAY_WINDOW_OFFSET_MILLISECONDS = 3 * 24 * 60 * 60 * 1000;

export function telemetryContributionAdmissionWindow(
  nowEpoch = Date.now(),
): { startsAt: string; endsAt: string } {
  if (!Number.isFinite(nowEpoch)) throw new ApiError(500, "INTERNAL_ERROR");
  const startsAtEpoch = Math.floor(
    (nowEpoch + MONDAY_WINDOW_OFFSET_MILLISECONDS)
      / TELEMETRY_CONTRIBUTION_ADMISSION_WINDOW_MILLISECONDS,
  ) * TELEMETRY_CONTRIBUTION_ADMISSION_WINDOW_MILLISECONDS
    - MONDAY_WINDOW_OFFSET_MILLISECONDS;
  return {
    startsAt: new Date(startsAtEpoch).toISOString(),
    endsAt: new Date(
      startsAtEpoch + TELEMETRY_CONTRIBUTION_ADMISSION_WINDOW_MILLISECONDS,
    ).toISOString(),
  };
}

export async function telemetryContributionAdmission(
  db: D1Database,
  participantId: string,
  nowEpoch = Date.now(),
): Promise<TelemetryContributionAdmission> {
  const window = telemetryContributionAdmissionWindow(nowEpoch);
  const row = await db.prepare(
    `SELECT accepted_count
       FROM telemetry_contribution_admission_windows
      WHERE participant_id = ? AND window_started_at = ?`,
  ).bind(participantId, window.startsAt).first<{ accepted_count: number }>();
  const acceptedBatches = Math.max(
    0,
    Math.min(
      MAX_TELEMETRY_CONTRIBUTIONS_PER_ADMISSION_WINDOW,
      Number(row?.accepted_count ?? 0),
    ),
  );
  const remainingBatches = Math.max(
    0,
    MAX_TELEMETRY_CONTRIBUTIONS_PER_ADMISSION_WINDOW - acceptedBatches,
  );
  return {
    schemaVersion: "telemetry-contribution-admission-v0.1",
    state: remainingBatches > 0 ? "available" : "exhausted",
    window: {
      kind: "fixed_utc",
      anchor: "monday_00_00_utc",
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      durationMilliseconds:
        TELEMETRY_CONTRIBUTION_ADMISSION_WINDOW_MILLISECONDS,
    },
    acceptedBatches,
    remainingBatches,
    maximumBatches: MAX_TELEMETRY_CONTRIBUTIONS_PER_ADMISSION_WINDOW,
    slotRefundPolicy: "not_refunded_by_contribution_deletion",
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(Reflect.get(value, key))}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function telemetryEnvelopeDigest(envelope: TelemetryEnvelope): Promise<string> {
  return sha256Hex([
    envelope.schemaVersion,
    envelope.keyId,
    envelope.wrappedKey,
    envelope.iv,
    envelope.ciphertext,
  ].join("\0"));
}

export async function telemetryPlaintextDigest(record: unknown): Promise<string> {
  return sha256Hex(stableJson(record));
}

export async function existingTelemetryContribution(
  db: D1Database,
  participantId: string,
  digest: string,
  kind: "plaintext" | "envelope" = "plaintext",
): Promise<TelemetryContributionRow | null> {
  const column = kind === "plaintext" ? "plaintext_digest" : "envelope_digest";
  return db.prepare(
    `SELECT c.*,
        (SELECT COUNT(*) FROM telemetry_records r WHERE r.origin_contribution_id = c.id)
          AS accepted_record_count
      FROM telemetry_contributions c
      WHERE c.participant_id = ? AND c.${column} = ?`,
  ).bind(participantId, digest).first<TelemetryContributionRow>();
}

export async function telemetryContributionCount(
  db: D1Database,
  participantId: string,
): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS total FROM telemetry_contributions WHERE participant_id = ?",
  ).bind(participantId).first<{ total: number }>();
  return row?.total ?? 0;
}

function nullable(value: number | null): number | null {
  return value ?? null;
}

function toolUnits(row: TelemetryUsageEvent): number {
  return Object.values(row.toolClassCounts).reduce((sum, value) => sum + value, 0);
}

function usageStatement(
  db: D1Database,
  participantId: string,
  contributionId: string,
  row: TelemetryUsageEvent,
  serverPricing: ServerPricingResult,
  transport?: {
    datasetId: string;
    accountTrackId: string;
    policyEpoch: string;
    recordJson: string;
  },
): [D1PreparedStatement, D1PreparedStatement] {
  return [db.prepare(
    `INSERT OR IGNORE INTO telemetry_records (
      origin_contribution_id, participant_id, record_kind, occurrence_id, observed_at,
      provider, model_id, model_fingerprint, speed_mode, api_service_tier, surface,
      billing_surface, total_input_context_tokens, reasoning_effort, agent_scope,
      input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens,
      output_text_tokens, output_reasoning_tokens, output_combined_tokens, tool_units,
      estimated_api_cost_usd, pricing_coverage_percent, unknown_billable_units,
      server_cost_usd, server_cost_nanousd, server_pricing_coverage_percent,
      server_unknown_billable_units, server_pricing_status, server_pricing_method_version,
      server_price_registry_version, server_price_registry_sha256, server_price_card_ids,
      server_unpriced_reason_codes, server_price_epoch_basis, server_tier_basis,
      server_api_service_tier, dataset_id, account_track_id, policy_epoch, record_json
    ) VALUES (
      ?1, ?2, 'usage', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
      ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28,
      ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41
    )`,
  ).bind(
    contributionId,
    participantId,
    row.eventId,
    row.eventTime,
    row.provider,
    row.modelId,
    row.modelFingerprint,
    row.speedMode,
    row.apiServiceTier,
    row.surface,
    row.billingSurface,
    nullable(row.totalInputContextTokens),
    row.reasoningEffort,
    row.agentScope,
    nullable(row.components.inputUncachedTokens),
    nullable(row.components.inputCacheReadTokens),
    nullable(row.components.inputCacheWriteTokens),
    nullable(row.components.outputTextTokens),
    nullable(row.components.outputReasoningTokens),
    nullable(row.components.outputCombinedTokens),
    toolUnits(row),
    row.accounting.estimatedApiCostUsd,
    row.accounting.pricingCoveragePercent,
    row.accounting.unknownBillableUnits,
    serverPricing.exactCostUsd,
    serverPricing.costNanousd,
    serverPricing.coveragePercent,
    serverPricing.unknownBillableUnits,
    serverPricing.coverageStatus,
    serverPricing.methodVersion,
    serverPricing.registryVersion,
    serverPricing.registrySha256,
    stableJson(serverPricing.selectedPriceCardIds),
    stableJson(serverPricing.unpricedReasonCodes),
    serverPricing.priceEpochBasis,
    serverPricing.tierBasis,
    serverPricing.apiServiceTier,
    transport?.datasetId ?? null,
    transport?.accountTrackId ?? "unattributed",
    transport?.policyEpoch ?? null,
    transport?.recordJson ?? stableJson(row),
  ), occurrenceLink(
    db,
    participantId,
    contributionId,
    "usage",
    row.eventId,
    transport,
  )];
}

function quotaStatement(
  db: D1Database,
  participantId: string,
  contributionId: string,
  row: TelemetryQuotaSnapshot,
  transport?: {
    datasetId: string;
    accountTrackId: string;
    policyEpoch: string;
    recordJson: string;
  },
): [D1PreparedStatement, D1PreparedStatement] {
  return [db.prepare(
    `INSERT OR IGNORE INTO telemetry_records (
      origin_contribution_id, participant_id, record_kind, occurrence_id, observed_at,
      provider, plan_type, plan_variant, limit_id, slot, used_percent,
      window_duration_minutes, resets_at, dataset_id, account_track_id, policy_epoch,
      record_json
    ) VALUES (?, ?, 'quota', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    contributionId,
    participantId,
    row.snapshotId,
    row.observedTime,
    row.provider,
    row.planType,
    row.planVariant,
    row.limitId,
    row.slot,
    row.usedPercent,
    row.windowDurationMinutes,
    row.resetsAt,
    transport?.datasetId ?? null,
    transport?.accountTrackId ?? "unattributed",
    transport?.policyEpoch ?? null,
    transport?.recordJson ?? stableJson(row),
  ), occurrenceLink(
    db,
    participantId,
    contributionId,
    "quota",
    row.snapshotId,
    transport,
  )];
}

function markerStatement(
  db: D1Database,
  participantId: string,
  contributionId: string,
  row: TelemetryActivityMarker,
  transport?: {
    datasetId: string;
    accountTrackId: string;
    policyEpoch: string;
    recordJson: string;
  },
): [D1PreparedStatement, D1PreparedStatement] {
  return [db.prepare(
    `INSERT OR IGNORE INTO telemetry_records (
      origin_contribution_id, participant_id, record_kind, occurrence_id, observed_at,
      surface, plan_type, plan_variant, dataset_id, account_track_id, policy_epoch,
      record_json
    ) VALUES (?, ?, 'activity', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    contributionId,
    participantId,
    row.markerId,
    row.observedTime,
    row.surface,
    row.planType,
    row.planVariant,
    transport?.datasetId ?? null,
    transport?.accountTrackId ?? "unattributed",
    transport?.policyEpoch ?? null,
    transport?.recordJson ?? stableJson(row),
  ), occurrenceLink(
    db,
    participantId,
    contributionId,
    "activity",
    row.markerId,
    transport,
  )];
}

function occurrenceLink(
  db: D1Database,
  participantId: string,
  contributionId: string,
  kind: "usage" | "quota" | "activity",
  occurrenceId: string,
  transport?: {
    datasetId: string;
    accountTrackId: string;
    policyEpoch: string;
  },
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO telemetry_contribution_occurrences (
      contribution_id, participant_id, record_kind, occurrence_id,
      dataset_id, account_track_id, policy_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    contributionId,
    participantId,
    kind,
    occurrenceId,
    transport?.datasetId ?? null,
    transport?.accountTrackId ?? "unattributed",
    transport?.policyEpoch ?? null,
  );
}

export async function insertTelemetryContribution(
  db: D1Database,
  participantId: string,
  uploadAuthorization: {
    authorizationId: string;
    authorizationKind: "session" | "device";
  },
  contributionId: string,
  r2Key: string,
  envelopeDigest: string,
  plaintextDigest: string,
  record: TelemetryContribution,
  createdAt: string,
  transport?: TelemetryTransportMetadata,
): Promise<{ acceptedRecords: number; deduplicatedRecords: number }> {
  const serverPricing = record.usageEvents.map(priceTelemetryUsageEvent);
  const recordPairs = [
    ...record.usageEvents.map((row, index) => usageStatement(
      db,
      participantId,
      contributionId,
      row,
      serverPricing[index]!,
      transport ? {
        datasetId: transport.datasetId,
        policyEpoch: transport.policyEpoch,
        ...(transport.usage.get(row.eventId)
          ?? { accountTrackId: "unattributed", recordJson: stableJson(row) }),
      } : undefined,
    )),
    ...record.quotaSnapshots.map((row) => quotaStatement(
      db,
      participantId,
      contributionId,
      row,
      transport ? {
        datasetId: transport.datasetId,
        policyEpoch: transport.policyEpoch,
        ...(transport.quota.get(row.snapshotId)
          ?? { accountTrackId: "unattributed", recordJson: stableJson(row) }),
      } : undefined,
    )),
    ...record.activityMarkers.map((row) => markerStatement(
      db,
      participantId,
      contributionId,
      row,
      transport ? {
        datasetId: transport.datasetId,
        policyEpoch: transport.policyEpoch,
        ...(transport.activity.get(row.markerId)
          ?? { accountTrackId: "unattributed", recordJson: stableJson(row) }),
      } : undefined,
    )),
  ];
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO telemetry_contributions (
        id, participant_id, plaintext_digest, envelope_digest, r2_key, status,
        schema_version, range_start, range_end, client_platform, provider_policy_epoch,
        estimated_api_cost_usd, priced_event_coverage_percent, unknown_model_event_count,
        unknown_billable_units, price_basis, declared_record_count, created_at,
        upload_authorization_id, device_upload_authorization_id,
        transport_schema_version, dataset_id,
        dataset_part_index, dataset_part_count, dataset_completeness,
        dataset_range_start, dataset_range_end
      ) VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      contributionId,
      participantId,
      plaintextDigest,
      envelopeDigest,
      r2Key,
      record.schemaVersion,
      record.coveredAt.startAt,
      record.coveredAt.endAt,
      record.clientPlatform,
      record.providerPolicyEpoch,
      record.accounting.estimatedApiCostUsd,
      record.accounting.pricedEventCoveragePercent,
      record.accounting.unknownModelEventCount,
      record.accounting.unknownBillableUnits,
      record.accounting.priceBasis,
      record.usageEvents.length + record.quotaSnapshots.length + record.activityMarkers.length,
      createdAt,
      uploadAuthorization.authorizationKind === "session"
        ? uploadAuthorization.authorizationId
        : null,
      uploadAuthorization.authorizationKind === "device"
        ? uploadAuthorization.authorizationId
        : null,
      transport?.transportSchemaVersion ?? "telemetry-contribution-v0.1",
      transport?.datasetId ?? null,
      transport?.partIndex ?? null,
      transport?.partCount ?? null,
      transport?.completeness ?? null,
      transport?.rangeStart ?? null,
      transport?.rangeEnd ?? null,
    ),
    ...recordPairs.flat(),
    db.prepare(
      `UPDATE telemetry_contributions
          SET server_cost_nanousd = COALESCE((
                SELECT SUM(server_cost_nanousd) FROM telemetry_records
                 WHERE origin_contribution_id = telemetry_contributions.id
                   AND record_kind = 'usage'
              ), 0),
              server_priced_event_count = (
                SELECT COUNT(*) FROM telemetry_records
                 WHERE origin_contribution_id = telemetry_contributions.id
                   AND record_kind = 'usage' AND server_pricing_status = 'fully_priced'
              ),
              server_partially_priced_event_count = (
                SELECT COUNT(*) FROM telemetry_records
                 WHERE origin_contribution_id = telemetry_contributions.id
                   AND record_kind = 'usage' AND server_pricing_status = 'partially_priced'
              ),
              server_unpriced_event_count = (
                SELECT COUNT(*) FROM telemetry_records
                 WHERE origin_contribution_id = telemetry_contributions.id
                   AND record_kind = 'usage' AND server_pricing_status = 'unpriced'
              ),
              server_pricing_method_version = ?,
              server_price_registry_version = ?,
              server_price_registry_sha256 = ?
        WHERE id = ? AND participant_id = ?`,
    ).bind(
      serverPricing[0]?.methodVersion ?? null,
      serverPricing[0]?.registryVersion ?? null,
      serverPricing[0]?.registrySha256 ?? null,
      contributionId,
      participantId,
    ),
  ];
  const results = await db.batch(statements);
  if ((results[0]?.meta.changes ?? 0) < 1) {
    throw new ApiError(409, "PARTICIPANT_DELETING");
  }
  const totalRecords = recordPairs.length;
  const acceptedRecords = recordPairs.reduce(
    (sum, _pair, index) => sum + Number(results[1 + (index * 2)]?.meta.changes ?? 0),
    0,
  );
  return { acceptedRecords, deduplicatedRecords: totalRecords - acceptedRecords };
}

export async function listTelemetryContributions(
  db: D1Database,
  participantId: string,
): Promise<TelemetryContributionRow[]> {
  const result = await db.prepare(
    `SELECT c.*,
        (SELECT COUNT(*) FROM telemetry_records r WHERE r.origin_contribution_id = c.id)
          AS accepted_record_count
      FROM telemetry_contributions c
      WHERE c.participant_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 101`,
  ).bind(participantId).all<TelemetryContributionRow>();
  return result.results;
}

export async function listRecentTelemetryContributions(
  db: D1Database,
  participantId: string,
  limit: number,
): Promise<TelemetryContributionRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  const result = await db.prepare(
    `SELECT c.*,
        (SELECT COUNT(*) FROM telemetry_records r WHERE r.origin_contribution_id = c.id)
          AS accepted_record_count
      FROM telemetry_contributions c
      WHERE c.participant_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  ).bind(participantId, limit).all<TelemetryContributionRow>();
  return result.results.reverse();
}

export interface TelemetryContributionPage {
  rows: Array<{
    contribution: TelemetryContributionRow;
    records: Array<{ record_kind: string; record_json: string }>;
  }>;
  nextCursor: { createdAt: string; contributionId: string } | null;
}

const MAX_TELEMETRY_EXPORT_PAGE_SIZE = 4;
const MAX_TELEMETRY_RECORDS_PER_CONTRIBUTION = 200;

export async function telemetryContributionPage(
  db: D1Database,
  participantId: string,
  cursor: { createdAt: string; contributionId: string } | null = null,
  limit = MAX_TELEMETRY_EXPORT_PAGE_SIZE,
): Promise<TelemetryContributionPage> {
  if (!Number.isSafeInteger(limit)
      || limit < 1
      || limit > MAX_TELEMETRY_EXPORT_PAGE_SIZE) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  const cursorPredicate = cursor
    ? "AND (c.created_at > ? OR (c.created_at = ? AND c.id > ?))"
    : "";
  const pageBindings = cursor
    ? [
      participantId,
      cursor.createdAt,
      cursor.createdAt,
      cursor.contributionId,
      limit + 1,
      limit,
      participantId,
      limit * MAX_TELEMETRY_RECORDS_PER_CONTRIBUTION + 1,
    ]
    : [
      participantId,
      limit + 1,
      limit,
      participantId,
      limit * MAX_TELEMETRY_RECORDS_PER_CONTRIBUTION + 1,
    ];
  type ExportPageRow = TelemetryContributionRow & {
    export_page_contribution_count: number;
    export_record_kind: string | null;
    export_record_json: string | null;
  };
  const result = await db.prepare(
    `WITH contribution_page AS (
      SELECT c.*,
        (SELECT COUNT(*) FROM telemetry_records accepted
          WHERE accepted.participant_id = c.participant_id
            AND accepted.origin_contribution_id = c.id) AS accepted_record_count
      FROM telemetry_contributions c
      WHERE c.participant_id = ?
        ${cursorPredicate}
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT ?
    ),
    selected_page AS (
      SELECT * FROM contribution_page
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    )
    SELECT selected_page.*,
      (SELECT COUNT(*) FROM contribution_page) AS export_page_contribution_count,
      records.record_kind AS export_record_kind,
      records.record_json AS export_record_json
    FROM selected_page
    LEFT JOIN telemetry_contribution_occurrences occurrences
      ON occurrences.participant_id = selected_page.participant_id
     AND occurrences.contribution_id = selected_page.id
    LEFT JOIN telemetry_records records
      ON records.participant_id = occurrences.participant_id
     AND records.record_kind = occurrences.record_kind
     AND records.occurrence_id = occurrences.occurrence_id
    WHERE selected_page.participant_id = ?
    ORDER BY selected_page.created_at ASC, selected_page.id ASC,
      records.observed_at ASC, records.id ASC
    LIMIT ?`,
  ).bind(...pageBindings).all<ExportPageRow>();
  const maximumResultRows =
    limit * MAX_TELEMETRY_RECORDS_PER_CONTRIBUTION;
  if (result.results.length > maximumResultRows) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  const page = new Map<string, TelemetryContributionPage["rows"][number]>();
  for (const row of result.results) {
    let item = page.get(row.id);
    if (!item) {
      item = { contribution: row, records: [] };
      page.set(row.id, item);
    }
    if (row.export_record_kind !== null && row.export_record_json !== null) {
      item.records.push({
        record_kind: row.export_record_kind,
        record_json: row.export_record_json,
      });
    }
  }
  const rows = [...page.values()];
  const last = rows.at(-1)?.contribution;
  const hasMore = Number(
    result.results[0]?.export_page_contribution_count ?? 0,
  ) > limit;
  return {
    rows,
    nextCursor: last && hasMore
      ? { createdAt: last.created_at, contributionId: last.id }
      : null,
  };
}

export async function telemetryContributionR2KeyPage(
  db: D1Database,
  participantId: string,
  cursor: { createdAt: string; contributionId: string } | null = null,
  limit = 100,
): Promise<{
  rows: Array<{ id: string; r2Key: string; createdAt: string }>;
  nextCursor: { createdAt: string; contributionId: string } | null;
}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  const result = cursor
    ? await db.prepare(
      `SELECT id, r2_key, created_at
         FROM telemetry_contributions
        WHERE participant_id = ?
          AND (created_at > ? OR (created_at = ? AND id > ?))
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    ).bind(
      participantId,
      cursor.createdAt,
      cursor.createdAt,
      cursor.contributionId,
      limit,
    ).all<{ id: string; r2_key: string; created_at: string }>()
    : await db.prepare(
      `SELECT id, r2_key, created_at
         FROM telemetry_contributions
        WHERE participant_id = ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    ).bind(participantId, limit).all<{
      id: string;
      r2_key: string;
      created_at: string;
    }>();
  const rows = result.results.map((row) => ({
    id: row.id,
    r2Key: row.r2_key,
    createdAt: row.created_at,
  }));
  const last = rows.at(-1);
  return {
    rows,
    nextCursor: last && rows.length === limit
      ? { createdAt: last.createdAt, contributionId: last.id }
      : null,
  };
}

export async function telemetryContributionById(
  db: D1Database,
  participantId: string,
  contributionId: string,
): Promise<TelemetryContributionRow | null> {
  return db.prepare(
    `SELECT c.*,
        (SELECT COUNT(*) FROM telemetry_records r WHERE r.origin_contribution_id = c.id)
          AS accepted_record_count
      FROM telemetry_contributions c WHERE c.participant_id = ? AND c.id = ?`,
  ).bind(participantId, contributionId).first<TelemetryContributionRow>();
}

export async function telemetryRecordsForContribution(
  db: D1Database,
  participantId: string,
  contributionId: string,
): Promise<Array<{ record_kind: string; record_json: string }>> {
  const result = await db.prepare(
    `SELECT r.record_kind, r.record_json FROM telemetry_records r
      JOIN telemetry_contribution_occurrences o
        ON o.participant_id = r.participant_id
       AND o.record_kind = r.record_kind
       AND o.occurrence_id = r.occurrence_id
      WHERE o.participant_id = ? AND o.contribution_id = ?
      ORDER BY r.observed_at ASC, r.id ASC LIMIT 501`,
  ).bind(participantId, contributionId).all<{ record_kind: string; record_json: string }>();
  return result.results;
}

export async function deleteTelemetryContribution(
  db: D1Database,
  participantId: string,
  contributionId: string,
): Promise<void> {
  await db.batch([
    db.prepare(
      "DELETE FROM telemetry_contributions WHERE participant_id = ? AND id = ?",
    ).bind(participantId, contributionId),
    db.prepare(
      `DELETE FROM telemetry_records
        WHERE participant_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM telemetry_contribution_occurrences o
             WHERE o.participant_id = telemetry_records.participant_id
               AND o.record_kind = telemetry_records.record_kind
               AND o.occurrence_id = telemetry_records.occurrence_id
          )`,
    ).bind(participantId),
  ]);
}

export async function markTelemetryContributionDeleting(
  db: D1Database,
  participantId: string,
  contributionId: string,
): Promise<boolean> {
  await db.prepare(
    `UPDATE telemetry_contributions
        SET status = 'deleting'
      WHERE participant_id = ? AND id = ? AND status = 'accepted'`,
  ).bind(participantId, contributionId).run();
  const row = await db.prepare(
    `SELECT 1 AS present FROM telemetry_contributions
      WHERE participant_id = ? AND id = ? AND status = 'deleting'`,
  ).bind(participantId, contributionId).first<{ present: number }>();
  return row?.present === 1;
}

export function telemetryContributionMetadata(row: TelemetryContributionRow): object {
  const serverVerified = Boolean(
    row.server_pricing_method_version
      && row.server_price_registry_version
      && row.server_price_registry_sha256,
  );
  return {
    contributionId: row.id,
    status: row.status,
    schemaVersion: row.schema_version,
    transportSchemaVersion: row.transport_schema_version ?? row.schema_version,
    dataset: row.dataset_id ? {
      datasetId: row.dataset_id,
      partIndex: row.dataset_part_index,
      partCount: row.dataset_part_count,
      completeness: row.dataset_completeness,
      coveredAt: {
        startAt: row.dataset_range_start,
        endAt: row.dataset_range_end,
      },
    } : null,
    coveredAt: { startAt: row.range_start, endAt: row.range_end },
    clientPlatform: row.client_platform,
    providerPolicyEpoch: row.provider_policy_epoch,
    accounting: {
      estimatedApiCostUsd: row.estimated_api_cost_usd,
      pricedEventCoveragePercent: row.priced_event_coverage_percent,
      unknownModelEventCount: row.unknown_model_event_count,
      unknownBillableUnits: row.unknown_billable_units,
      priceBasis: row.price_basis,
      verification: "client_declared_unverified",
    },
    serverAccounting: {
      apiPriceEquivalentUsd: serverVerified
        ? formatNanousd(row.server_cost_nanousd ?? 0)
        : null,
      fullyPricedEvents: row.server_priced_event_count ?? 0,
      partiallyPricedEvents: row.server_partially_priced_event_count ?? 0,
      unpricedEvents: row.server_unpriced_event_count ?? 0,
      methodVersion: row.server_pricing_method_version ?? null,
      registryVersion: row.server_price_registry_version ?? null,
      registrySha256: row.server_price_registry_sha256 ?? null,
      verification: serverVerified ? "server_repriced" : "server_repricing_unavailable",
    },
    recordCounts: {
      declared: row.declared_record_count,
      accepted: row.accepted_record_count ?? 0,
      deduplicated: row.declared_record_count - (row.accepted_record_count ?? 0),
    },
    quarantine: contributionQuarantineLifecycle(
      row.created_at,
      row.quarantine_deleted_at,
    ),
    createdAt: row.created_at,
  };
}

export function telemetryContributionHistoryMetadata(
  row: TelemetryContributionRow,
): object {
  const serverVerified = Boolean(
    row.server_pricing_method_version
      && row.server_price_registry_version
      && row.server_price_registry_sha256,
  );
  return {
    contributionId: row.id,
    status: row.status,
    synthetic: false,
    schemaVersion: row.schema_version,
    transportSchemaVersion: row.transport_schema_version ?? row.schema_version,
    coveredAt: { startAt: row.range_start, endAt: row.range_end },
    clientPlatform: row.client_platform,
    providerPolicyEpoch: row.provider_policy_epoch,
    serverAccounting: {
      apiPriceEquivalentUsd: serverVerified
        ? formatNanousd(row.server_cost_nanousd ?? 0)
        : null,
      verification: serverVerified ? "server_repriced" : "server_repricing_unavailable",
    },
    recordCounts: {
      declared: row.declared_record_count,
      accepted: row.accepted_record_count ?? 0,
      deduplicated: row.declared_record_count - (row.accepted_record_count ?? 0),
    },
    quarantine: contributionQuarantineLifecycle(
      row.created_at,
      row.quarantine_deleted_at,
    ),
    createdAt: row.created_at,
  };
}

function formatNanousd(value: number): string {
  const safe = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const whole = Math.floor(safe / 1_000_000_000);
  const fraction = String(safe % 1_000_000_000).padStart(9, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export interface CalibrationGroupRow extends Record<string, unknown> {
  provider?: string;
  plan_type?: string;
  plan_variant?: string;
  limit_id?: string;
  slot?: string;
  resets_at?: string;
  window_duration_minutes?: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  minimumUsedPercent?: number;
  maximumUsedPercent?: number;
  serverCostNanousd?: number;
}

export interface RollingQuotaObservationRow {
  observed_at: string;
  used_percent: number;
  record_json: string;
}

export interface RollingUsageObservationRow {
  observed_at: string;
  server_cost_nanousd: number | null;
  server_pricing_status: string | null;
}

const HOUR_MILLISECONDS = 3_600_000;
const MAX_ROLLING_QUOTA_ANALYSIS_HOURS = 365 * 24 + 1;

export function buildRollingQuotaMovement(
  group: CalibrationGroupRow | undefined,
  accountContinuity: "transmitted" | "not_transmitted",
  quotaRows: readonly RollingQuotaObservationRow[],
  usageRows: readonly RollingUsageObservationRow[],
): object {
  if (!group?.provider || !group.plan_type || !group.plan_variant
      || !group.limit_id || !group.slot || !group.resets_at
      || !group.firstObservedAt || !group.lastObservedAt) {
    return {
      schemaVersion: "participant-quota-movement-v0.1",
      status: "not_testable",
      reason: "insufficient_quota_observations",
      rows: [],
      accountContinuity,
    };
  }
  if (accountContinuity !== "transmitted") {
    return {
      schemaVersion: "participant-quota-movement-v0.1",
      status: "not_testable",
      reason: "account_continuity_not_transmitted",
      rows: [],
      accountContinuity,
    };
  }
  if (quotaRows.length > 2000 || usageRows.length > 5000) {
    return {
      schemaVersion: "participant-quota-movement-v0.1",
      status: "not_testable",
      reason: "analysis_record_limit_exceeded",
      rows: [],
      accountContinuity,
    };
  }
  const quota = quotaRows.map((row) => {
    let receivedAt = Number.NaN;
    try {
      const record = JSON.parse(row.record_json) as { receivedTime?: unknown };
      receivedAt = typeof record.receivedTime === "string"
        ? Date.parse(record.receivedTime)
        : Number.NaN;
    } catch {
      receivedAt = Number.NaN;
    }
    return {
      at: Date.parse(row.observed_at),
      receivedAt,
      used: Number(row.used_percent),
    };
  }).filter((row) => (
    Number.isFinite(row.at) && Number.isFinite(row.receivedAt) && Number.isFinite(row.used)
  ));
  if (quota.length < 2) {
    return {
      schemaVersion: "participant-quota-movement-v0.1",
      status: "not_testable",
      reason: "insufficient_quota_observations",
      rows: [],
      accountContinuity,
    };
  }
  const staleQuota = quota.some((row) => (
    row.receivedAt < row.at || row.receivedAt - row.at > 5 * 60_000
  ));
  if (staleQuota) {
    return {
      schemaVersion: "participant-quota-movement-v0.1",
      status: "not_testable",
      reason: "stale_quota_observation",
      rows: [],
      accountContinuity,
    };
  }
  const backwardsQuota = quota.some((row, index) => (
    index > 0 && row.used < quota[index - 1]!.used
  ));
  if (backwardsQuota) {
    return {
      schemaVersion: "participant-quota-movement-v0.1",
      status: "not_testable",
      reason: "backward_quota_observation",
      rows: [],
      accountContinuity,
    };
  }
  if (usageRows.some((row) => row.server_pricing_status !== "fully_priced")) {
    return {
      schemaVersion: "participant-quota-movement-v0.1",
      status: "not_testable",
      reason: "incomplete_server_pricing_in_interval",
      rows: [],
      accountContinuity,
    };
  }
  const observedSpan = Math.max(...quota.map((row) => row.used))
    - Math.min(...quota.map((row) => row.used));
  const totalCostNanousd = usageRows.reduce(
    (sum, row) => sum + Number(row.server_cost_nanousd ?? 0),
    0,
  );
  if (!(observedSpan > 0) || !(totalCostNanousd > 0)) {
    return {
      schemaVersion: "participant-quota-movement-v0.1",
      status: "not_testable",
      reason: observedSpan <= 0 ? "no_observed_quota_movement" : "no_server_priced_usage_in_interval",
      rows: [],
      accountContinuity: "not_transmitted",
    };
  }

  const firstHour = Math.floor(quota[0]!.at / HOUR_MILLISECONDS)
    * HOUR_MILLISECONDS;
  const lastHour = Math.floor(quota.at(-1)!.at / HOUR_MILLISECONDS)
    * HOUR_MILLISECONDS;
  const analyzedHourCount =
    Math.floor((lastHour - firstHour) / HOUR_MILLISECONDS) + 1;
  const declaredDurationMinutes = Number(group.window_duration_minutes);
  const declaredMaximumHours = Number.isSafeInteger(declaredDurationMinutes)
      && declaredDurationMinutes > 0
    ? Math.ceil(declaredDurationMinutes / 60) + 1
    : MAX_ROLLING_QUOTA_ANALYSIS_HOURS;
  if (!Number.isSafeInteger(analyzedHourCount)
      || analyzedHourCount < 1
      || analyzedHourCount > Math.min(
        declaredMaximumHours,
        MAX_ROLLING_QUOTA_ANALYSIS_HOURS,
      )) {
    return {
      schemaVersion: "participant-quota-movement-v0.1",
      status: "not_testable",
      reason: "analysis_time_range_exceeded",
      rows: [],
      accountContinuity,
    };
  }
  const usageByHour = Array.from(
    { length: analyzedHourCount },
    () => ({ costNanousd: 0, events: 0 }),
  );
  const analysisEnd = firstHour
    + analyzedHourCount * HOUR_MILLISECONDS;
  for (const row of usageRows) {
    const at = Date.parse(row.observed_at);
    if (!Number.isFinite(at) || at < firstHour || at >= analysisEnd) continue;
    const hourIndex = Math.floor(
      (at - firstHour) / HOUR_MILLISECONDS,
    );
    const bin = usageByHour[hourIndex];
    if (!bin) continue;
    bin.costNanousd += Number(row.server_cost_nanousd ?? 0);
    bin.events += 1;
  }
  const hours: Array<{
    start: number;
    end: number;
    costNanousd: number;
    events: number;
    startUsed: number;
    endUsed: number;
  }> = [];
  let quotaIndex = 0;
  let currentUsed = quota[0]!.used;
  const quotaAt = (timestamp: number): number => {
    while (quotaIndex + 1 < quota.length && quota[quotaIndex + 1]!.at <= timestamp) {
      quotaIndex += 1;
      currentUsed = quota[quotaIndex]!.used;
    }
    return currentUsed;
  };
  for (let hourIndex = 0; hourIndex < analyzedHourCount; hourIndex += 1) {
    const start = firstHour + hourIndex * HOUR_MILLISECONDS;
    const end = start + HOUR_MILLISECONDS;
    const startUsed = quotaAt(start);
    const endUsed = quotaAt(end);
    const usage = usageByHour[hourIndex]!;
    hours.push({
      start,
      end,
      costNanousd: usage.costNanousd,
      events: usage.events,
      startUsed,
      endUsed,
    });
  }
  const capacityUsd = (totalCostNanousd / 1_000_000_000) * 100 / observedSpan;
  const costPrefix = [0];
  const eventPrefix = [0];
  for (const hour of hours) {
    costPrefix.push(costPrefix.at(-1)! + hour.costNanousd);
    eventPrefix.push(eventPrefix.at(-1)! + hour.events);
  }
  const rows = [1, 2, 3].flatMap((smoothingHours) => (
    hours.slice(smoothingHours - 1).map((hour, offset) => {
      const endIndex = offset + smoothingHours;
      const startIndex = offset;
      const costNanousd = costPrefix[endIndex]! - costPrefix[startIndex]!;
      const observed = hour.endUsed - hours[startIndex]!.startUsed;
      const expected = capacityUsd > 0
        ? (costNanousd / 1_000_000_000) * 100 / capacityUsd
        : 0;
      return {
        timestamp: new Date(hour.end).toISOString(),
        windowStartUtc: new Date(hours[startIndex]!.start).toISOString(),
        windowEndUtc: new Date(hour.end).toISOString(),
        smoothingHours,
        observedQuotaChangePp: Number(observed.toFixed(6)),
        expectedQuotaChangePp: Number(expected.toFixed(6)),
        apiPriceEquivalentUsd: formatNanousd(costNanousd),
        usageEvents: eventPrefix[endIndex]! - eventPrefix[startIndex]!,
      };
    })
  ));
  return {
    schemaVersion: "participant-quota-movement-v0.1",
    status: "conditional_estimate",
    interpretation: "participant_wide_unscoped_api_price_equivalent",
    accountContinuity,
    provider: group.provider,
    planType: group.plan_type,
    planVariant: group.plan_variant,
    limitId: group.limit_id,
    slot: group.slot,
    resetsAt: group.resets_at,
    apiPriceEquivalentCapacityUsd: Number(capacityUsd.toFixed(6)),
    observedUsedPercentSpan: observedSpan,
    pricedUsageUsd: formatNanousd(totalCostNanousd),
    rows,
  };
}

async function rollingQuotaMovement(
  db: D1Database,
  participantId: string,
  group: CalibrationGroupRow | undefined,
  accountContinuity: "transmitted" | "not_transmitted",
): Promise<object> {
  if (!group?.provider || !group.plan_type || !group.plan_variant
      || !group.limit_id || !group.slot || !group.resets_at
      || !group.firstObservedAt || !group.lastObservedAt
      || accountContinuity !== "transmitted") {
    return buildRollingQuotaMovement(group, accountContinuity, [], []);
  }
  const [quotaResult, usageResult] = await Promise.all([
    db.prepare(
      `SELECT observed_at, used_percent, record_json FROM telemetry_records
        WHERE participant_id = ? AND record_kind = 'quota'
          AND provider = ? AND plan_type = ? AND plan_variant = ?
          AND limit_id = ? AND slot = ? AND resets_at = ?
        ORDER BY observed_at, id LIMIT 2001`,
    ).bind(
      participantId,
      group.provider,
      group.plan_type,
      group.plan_variant,
      group.limit_id,
      group.slot,
      group.resets_at,
    ).all<RollingQuotaObservationRow>(),
    db.prepare(
      `SELECT observed_at, server_cost_nanousd, server_pricing_status
        FROM telemetry_records
        WHERE participant_id = ? AND record_kind = 'usage' AND provider = ?
          AND observed_at BETWEEN ? AND ?
        ORDER BY observed_at, id LIMIT 5001`,
    ).bind(
      participantId,
      group.provider,
      group.firstObservedAt,
      group.lastObservedAt,
    ).all<RollingUsageObservationRow>(),
  ]);
  return buildRollingQuotaMovement(
    group,
    accountContinuity,
    quotaResult.results,
    usageResult.results,
  );
}

interface CountsRow {
  usage_events: number;
  quota_snapshots: number;
  activity_markers: number;
  input_uncached_tokens: number;
  input_cache_read_tokens: number;
  input_cache_write_tokens: number;
  output_text_tokens: number;
  output_reasoning_tokens: number;
  output_combined_tokens: number;
  tool_units: number;
}

function zeroCounts(): CountsRow {
  return {
    usage_events: 0,
    quota_snapshots: 0,
    activity_markers: 0,
    input_uncached_tokens: 0,
    input_cache_read_tokens: 0,
    input_cache_write_tokens: 0,
    output_text_tokens: 0,
    output_reasoning_tokens: 0,
    output_combined_tokens: 0,
    tool_units: 0,
  };
}

const TOTALS_SQL = `SELECT
  SUM(CASE WHEN record_kind = 'usage' THEN 1 ELSE 0 END) AS usage_events,
  SUM(CASE WHEN record_kind = 'quota' THEN 1 ELSE 0 END) AS quota_snapshots,
  SUM(CASE WHEN record_kind = 'activity' THEN 1 ELSE 0 END) AS activity_markers,
  COALESCE(SUM(input_uncached_tokens), 0) AS input_uncached_tokens,
  COALESCE(SUM(input_cache_read_tokens), 0) AS input_cache_read_tokens,
  COALESCE(SUM(input_cache_write_tokens), 0) AS input_cache_write_tokens,
  COALESCE(SUM(output_text_tokens), 0) AS output_text_tokens,
  COALESCE(SUM(output_reasoning_tokens), 0) AS output_reasoning_tokens,
  COALESCE(SUM(output_combined_tokens), 0) AS output_combined_tokens,
  COALESCE(SUM(tool_units), 0) AS tool_units
  FROM telemetry_records`;

function insights(totals: CountsRow, fastEvents: number, serverPricedEvents: number): object[] {
  const input = totals.input_uncached_tokens + totals.input_cache_read_tokens
    + totals.input_cache_write_tokens;
  const output = totals.output_text_tokens + totals.output_reasoning_tokens
    + totals.output_combined_tokens;
  return [
    {
      code: "cache_share",
      value: input > 0 ? totals.input_cache_read_tokens / input : null,
      label: "Share of input served from cache",
    },
    {
      code: "reasoning_share",
      value: output > 0 ? totals.output_reasoning_tokens / output : null,
      label: "Share of output reported as reasoning",
    },
    {
      code: "fast_event_share",
      value: totals.usage_events > 0 ? fastEvents / totals.usage_events : null,
      label: "Share of usage events marked fast",
    },
    {
      code: "server_price_coverage",
      value: totals.usage_events > 0 ? serverPricedEvents / totals.usage_events : null,
      label: "Share priced or partially priced by the server",
      verification: "server_repriced",
    },
  ];
}

export async function personalStats(db: D1Database, participantId: string): Promise<object> {
  const [totalRow, breakdown, daily, latestQuota, gradientRows, speedRow, contributionRow] = await Promise.all([
    db.prepare(`${TOTALS_SQL} WHERE participant_id = ?`).bind(participantId).first<CountsRow>(),
    db.prepare(
      `SELECT provider, model_id AS modelId, COUNT(*) AS events,
        COALESCE(SUM(input_uncached_tokens), 0) AS inputUncachedTokens,
        COALESCE(SUM(input_cache_read_tokens), 0) AS inputCacheReadTokens,
        COALESCE(SUM(output_text_tokens), 0) AS outputTextTokens,
        COALESCE(SUM(output_reasoning_tokens), 0) AS outputReasoningTokens,
        COALESCE(SUM(server_cost_nanousd), 0) AS serverCostNanousd,
        SUM(CASE WHEN server_pricing_status IN
          ('fully_priced', 'partially_priced', 'unpriced') THEN 1 ELSE 0 END)
          AS serverClassifiedEvents
       FROM telemetry_records
       WHERE participant_id = ? AND record_kind = 'usage'
       GROUP BY provider, model_id ORDER BY events DESC, provider, model_id LIMIT 50`,
    ).bind(participantId).all(),
    db.prepare(
      `SELECT substr(observed_at, 1, 10) AS day, COUNT(*) AS events,
        COALESCE(SUM(COALESCE(input_uncached_tokens, 0)
          + COALESCE(input_cache_read_tokens, 0) + COALESCE(input_cache_write_tokens, 0)
          + COALESCE(output_text_tokens, 0) + COALESCE(output_reasoning_tokens, 0)
          + COALESCE(output_combined_tokens, 0)), 0) AS tokens,
        COALESCE(SUM(server_cost_nanousd), 0) AS serverCostNanousd,
        SUM(CASE WHEN server_pricing_status IN
          ('fully_priced', 'partially_priced', 'unpriced') THEN 1 ELSE 0 END)
          AS serverClassifiedEvents
       FROM telemetry_records WHERE participant_id = ? AND record_kind = 'usage'
       GROUP BY day ORDER BY day DESC LIMIT 180`,
    ).bind(participantId).all(),
    db.prepare(
      `SELECT record_json FROM telemetry_records
       WHERE participant_id = ? AND record_kind = 'quota'
       ORDER BY observed_at DESC, id DESC LIMIT 20`,
    ).bind(participantId).all<{ record_json: string }>(),
    db.prepare(
      `WITH quota_groups AS (
        SELECT provider, plan_type, plan_variant, limit_id, slot,
          window_duration_minutes, resets_at,
          COUNT(*) AS snapshots, MIN(observed_at) AS firstObservedAt,
          MAX(observed_at) AS lastObservedAt, MIN(used_percent) AS minimumUsedPercent,
          MAX(used_percent) AS maximumUsedPercent
        FROM telemetry_records
        WHERE participant_id = ? AND record_kind = 'quota'
        GROUP BY provider, plan_type, plan_variant, limit_id, slot,
          window_duration_minutes, resets_at
      )
      SELECT q.*,
        (SELECT COUNT(*) FROM telemetry_records u
          WHERE u.participant_id = ? AND u.record_kind = 'usage'
            AND u.provider = q.provider
            AND u.observed_at BETWEEN q.firstObservedAt AND q.lastObservedAt) AS usageEvents,
        (SELECT COALESCE(SUM(u.server_cost_nanousd), 0)
          FROM telemetry_records u
          WHERE u.participant_id = ? AND u.record_kind = 'usage'
            AND u.provider = q.provider
            AND u.server_pricing_status IN ('fully_priced', 'partially_priced')
            AND u.observed_at BETWEEN q.firstObservedAt AND q.lastObservedAt) AS serverCostNanousd
      FROM quota_groups q ORDER BY q.lastObservedAt DESC LIMIT 20`,
    ).bind(participantId, participantId, participantId).all(),
    db.prepare(
      `SELECT
        SUM(CASE WHEN speed_mode = 'fast' THEN 1 ELSE 0 END) AS fast,
        SUM(CASE WHEN server_pricing_status IN ('fully_priced', 'partially_priced')
          THEN 1 ELSE 0 END) AS priced,
        SUM(CASE WHEN server_pricing_status = 'fully_priced' THEN 1 ELSE 0 END) AS fullyPriced,
        SUM(CASE WHEN server_pricing_status = 'partially_priced' THEN 1 ELSE 0 END) AS partiallyPriced,
        SUM(CASE WHEN server_pricing_status = 'unpriced' THEN 1 ELSE 0 END) AS unpriced,
        COALESCE(SUM(server_cost_nanousd), 0) AS serverCostNanousd,
        COALESCE(SUM(server_unknown_billable_units), 0) AS serverUnknownBillableUnits,
        SUM(CASE WHEN estimated_api_cost_usd IS NOT NULL THEN 1 ELSE 0 END)
          AS clientDeclaredPricedEvents,
        COALESCE(SUM(unknown_billable_units), 0) AS unknownBillableUnits
       FROM telemetry_records WHERE participant_id = ? AND record_kind = 'usage'`,
    ).bind(participantId).first<{
      fast: number;
      priced: number;
      fullyPriced: number;
      partiallyPriced: number;
      unpriced: number;
      serverCostNanousd: number;
      serverUnknownBillableUnits: number;
      clientDeclaredPricedEvents: number;
      unknownBillableUnits: number;
    }>(),
    db.prepare(
      `SELECT COUNT(*) AS contributions
       FROM telemetry_contributions WHERE participant_id = ?`,
    ).bind(participantId).first(),
  ]);
  const totals = totalRow ?? zeroCounts();
  const movementGroup = gradientRows.results.find((row) => (
    Number(Reflect.get(row, "snapshots") ?? 0) >= 2
      && Number(Reflect.get(row, "maximumUsedPercent") ?? 0)
        > Number(Reflect.get(row, "minimumUsedPercent") ?? 0)
      && Number(Reflect.get(row, "serverCostNanousd") ?? 0) > 0
  )) ?? gradientRows.results[0];
  const quotaMovement = await rollingQuotaMovement(
    db,
    participantId,
    movementGroup as CalibrationGroupRow | undefined,
    "not_transmitted",
  );
  const quotaAnalysis = await accountScopedQuotaAnalysis(db, participantId);
  const classifiedServerEvents = (speedRow?.fullyPriced ?? 0)
    + (speedRow?.partiallyPriced ?? 0)
    + (speedRow?.unpriced ?? 0);
  const serverDatasetVerified = classifiedServerEvents === totals.usage_events;
  return {
    schemaVersion: "participant-stats-v0.2",
    participantId,
    totals: {
      contributions: Reflect.get(contributionRow ?? {}, "contributions") ?? 0,
      usageEvents: totals.usage_events,
      quotaSnapshots: totals.quota_snapshots,
      activityMarkers: totals.activity_markers,
      inputUncachedTokens: totals.input_uncached_tokens,
      inputCacheReadTokens: totals.input_cache_read_tokens,
      inputCacheWriteTokens: totals.input_cache_write_tokens,
      outputTextTokens: totals.output_text_tokens,
      outputReasoningTokens: totals.output_reasoning_tokens,
      outputCombinedTokens: totals.output_combined_tokens,
      toolUnits: totals.tool_units,
      apiPriceEquivalentUsd: serverDatasetVerified
        ? formatNanousd(speedRow?.serverCostNanousd ?? 0)
        : null,
      serverUnknownBillableUnits: speedRow?.serverUnknownBillableUnits ?? 0,
      fullyPricedEvents: speedRow?.fullyPriced ?? 0,
      partiallyPricedEvents: speedRow?.partiallyPriced ?? 0,
      unpricedEvents: speedRow?.unpriced ?? 0,
      priceVerification: serverDatasetVerified
        ? "server_repriced"
        : "server_repricing_unavailable_for_legacy_records",
      clientAccountingDiagnostic: {
        declaredPricedEvents: speedRow?.clientDeclaredPricedEvents ?? 0,
        unknownBillableUnits: speedRow?.unknownBillableUnits ?? 0,
        verification: "client_declared_unverified",
      },
    },
    byModel: breakdown.results.map((row) => ({
      ...row,
      apiPriceEquivalentUsd: Number(Reflect.get(row, "serverClassifiedEvents") ?? 0)
        === Number(Reflect.get(row, "events") ?? 0)
        ? formatNanousd(Number(Reflect.get(row, "serverCostNanousd") ?? 0))
        : null,
      priceVerification: Number(Reflect.get(row, "serverClassifiedEvents") ?? 0)
        === Number(Reflect.get(row, "events") ?? 0)
        ? "server_repriced"
        : "server_repricing_unavailable_for_legacy_records",
    })),
    daily: [...daily.results].reverse().map((row) => ({
      ...row,
      apiPriceEquivalentUsd: Number(Reflect.get(row, "serverClassifiedEvents") ?? 0)
        === Number(Reflect.get(row, "events") ?? 0)
        ? formatNanousd(Number(Reflect.get(row, "serverCostNanousd") ?? 0))
        : null,
      priceVerification: Number(Reflect.get(row, "serverClassifiedEvents") ?? 0)
        === Number(Reflect.get(row, "events") ?? 0)
        ? "server_repriced"
        : "server_repricing_unavailable_for_legacy_records",
    })),
    latestQuota: latestQuota.results.map((row) => JSON.parse(row.record_json) as unknown),
    rollingQuotaMovement: quotaMovement,
    accountScopedQuotaAnalysis: quotaAnalysis,
    quotaGradients: gradientRows.results.map((row) => {
      const snapshots = Number(Reflect.get(row, "snapshots") ?? 0);
      const minimum = Number(Reflect.get(row, "minimumUsedPercent") ?? 0);
      const maximum = Number(Reflect.get(row, "maximumUsedPercent") ?? 0);
      const span = maximum - minimum;
      const usageEvents = Number(Reflect.get(row, "usageEvents") ?? 0);
      const costNanousd = Number(Reflect.get(row, "serverCostNanousd") ?? 0);
      return {
        provider: Reflect.get(row, "provider"),
        planType: Reflect.get(row, "plan_type"),
        planVariant: Reflect.get(row, "plan_variant"),
        limitId: Reflect.get(row, "limit_id"),
        slot: Reflect.get(row, "slot"),
        windowDurationMinutes: Reflect.get(row, "window_duration_minutes"),
        resetsAt: Reflect.get(row, "resets_at"),
        firstObservedAt: Reflect.get(row, "firstObservedAt"),
        lastObservedAt: Reflect.get(row, "lastObservedAt"),
        snapshots,
        observedUsedPercentSpan: span,
        usageEvents,
        apiPriceEquivalentUsd: formatNanousd(costNanousd),
        status: "not_testable",
        reason: "account_continuity_not_transmitted",
        apiPriceEquivalentCostPerPercentagePoint: null,
        verification: "server_repriced",
        interpretation: "conditional_api_price_equivalent_not_provider_allowance",
        accountContinuity: "not_transmitted",
      };
    }),
    insights: insights(totals, speedRow?.fast ?? 0, speedRow?.priced ?? 0),
    generatedAt: new Date().toISOString(),
  };
}

export async function communityStats(
  db: D1Database,
  minimumParticipants: number,
  { eligibleOnly = false }: { eligibleOnly?: boolean } = {},
): Promise<object> {
  const eligibilityPredicate = eligibleOnly
    ? "participant_id IN (SELECT participant_id FROM participant_community_eligibility)"
    : "1 = 1";
  const participantRow = await db.prepare(
    `SELECT COUNT(DISTINCT participant_id) AS total FROM telemetry_records
      WHERE ${eligibilityPredicate}`,
  ).first<{ total: number }>();
  const participantCount = participantRow?.total ?? 0;
  if (participantCount < minimumParticipants) {
    return {
      schemaVersion: "community-stats-v0.1",
      publicationStatus: "development_diagnostic_not_publication_safe",
      suppressed: true,
      participantCount,
      minimumParticipants,
      cohortEligibility: eligibleOnly ? "grant_backed" : "all_enrolled",
      reason: "minimum_cohort_not_met",
    };
  }
  const [totalRow, breakdown, daily, speedRow] = await Promise.all([
    db.prepare(`${TOTALS_SQL} WHERE ${eligibilityPredicate}`).first<CountsRow>(),
    db.prepare(
      `SELECT provider, model_id AS modelId, COUNT(*) AS events,
        COUNT(DISTINCT participant_id) AS participants,
        COALESCE(SUM(input_uncached_tokens), 0) AS inputUncachedTokens,
        COALESCE(SUM(input_cache_read_tokens), 0) AS inputCacheReadTokens,
        COALESCE(SUM(output_text_tokens), 0) AS outputTextTokens,
        COALESCE(SUM(output_reasoning_tokens), 0) AS outputReasoningTokens
       FROM telemetry_records WHERE record_kind = 'usage' AND ${eligibilityPredicate}
       GROUP BY provider, model_id HAVING COUNT(DISTINCT participant_id) >= ?
       ORDER BY events DESC, provider, model_id LIMIT 50`,
    ).bind(minimumParticipants).all(),
    db.prepare(
      `SELECT substr(observed_at, 1, 10) AS day, COUNT(*) AS events,
        COUNT(DISTINCT participant_id) AS participants,
        COALESCE(SUM(COALESCE(input_uncached_tokens, 0)
          + COALESCE(input_cache_read_tokens, 0) + COALESCE(input_cache_write_tokens, 0)
          + COALESCE(output_text_tokens, 0) + COALESCE(output_reasoning_tokens, 0)
          + COALESCE(output_combined_tokens, 0)), 0) AS tokens
       FROM telemetry_records WHERE record_kind = 'usage' AND ${eligibilityPredicate}
       GROUP BY day HAVING COUNT(DISTINCT participant_id) >= ?
       ORDER BY day DESC LIMIT 180`,
    ).bind(minimumParticipants).all(),
    db.prepare(
      `SELECT
        SUM(CASE WHEN speed_mode = 'fast' THEN 1 ELSE 0 END) AS fast,
        SUM(CASE WHEN estimated_api_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS priced
       FROM telemetry_records WHERE record_kind = 'usage' AND ${eligibilityPredicate}`,
    ).first<{ fast: number; priced: number }>(),
  ]);
  const totals = totalRow ?? zeroCounts();
  return {
    schemaVersion: "community-stats-v0.1",
    publicationStatus: "development_diagnostic_not_publication_safe",
    suppressed: false,
    participantCount,
    minimumParticipants,
    cohortEligibility: eligibleOnly ? "grant_backed" : "all_enrolled",
    totals: {
      usageEvents: totals.usage_events,
      quotaSnapshots: totals.quota_snapshots,
      activityMarkers: totals.activity_markers,
      inputUncachedTokens: totals.input_uncached_tokens,
      inputCacheReadTokens: totals.input_cache_read_tokens,
      inputCacheWriteTokens: totals.input_cache_write_tokens,
      outputTextTokens: totals.output_text_tokens,
      outputReasoningTokens: totals.output_reasoning_tokens,
      outputCombinedTokens: totals.output_combined_tokens,
      toolUnits: totals.tool_units,
    },
    byModel: breakdown.results,
    daily: [...daily.results].reverse(),
    insights: insights(totals, speedRow?.fast ?? 0, speedRow?.priced ?? 0),
    generatedAt: new Date().toISOString(),
  };
}
