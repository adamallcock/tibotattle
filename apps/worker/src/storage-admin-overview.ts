import type { StorageAnalyticsBindings } from "./analytics-delivery";
import { ApiError } from "./errors";
import { hasTelemetryV12ChunkTable } from "./telemetry-v12-table";

const MAX_ADMIN_AGGREGATE_ROWS = 10_000;

interface CountRow {
  total: number;
  current?: number;
  accepted_last_24h?: number;
  accepted_last_7d?: number;
  accepted_last_30d?: number;
  latest_accepted_at?: string | null;
}

interface HistoricalPublicationRow {
  published_days: number;
  latest_evidence_day: string | null;
  latest_computed_ms: number | null;
}

interface PreviewRow {
  generated_at: string;
  inputs_current: number;
}

function unavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function count(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw unavailable();
  return result;
}

function addCounts(...values: unknown[]): number {
  return count(values.reduce<number>((sum, value) => sum + count(value), 0));
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw unavailable();
  }
  return value;
}

function nullableEpochTimestamp(value: unknown): string | null {
  if (value === null) return null;
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw unavailable();
  const date = new Date(epoch);
  if (!Number.isFinite(date.getTime())) throw unavailable();
  return date.toISOString();
}

function nullableDay(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
      || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw unavailable();
  }
  return value;
}

/**
 * Current typed-storage owner summary. The source reads only compact upload
 * headers and participant metadata. In particular, this path never counts or
 * scans typed_telemetry_records, whose production corpus can contain millions
 * of rows. Derived publication state comes from the registered analytics DB.
 */
export async function readStorageAdminOverview(
  bindings: StorageAnalyticsBindings,
  nowEpoch = Date.now(),
): Promise<{
  contributions: {
    contributingAccounts: {
      total: number;
      bounded: false;
      acceptedLast24Hours: number;
      acceptedLast7Days: number;
      acceptedLast30Days: number;
    };
    incrementalChunks: {
      total: number;
      current: number;
      bounded: false;
      acceptedLast24Hours: number;
      acceptedLast7Days: number;
    };
    acceptedLast24Hours: number;
    acceptedLast7Days: number;
    latestAcceptedAt: string | null;
    storedTelemetryRecords: number;
    storedTelemetryRecordsBounded: false;
  };
  dailyPublication: {
    latestEvidenceDay: string | null;
    latestReleasedAt: string | null;
    pendingRebuilds: number;
    pendingRebuildsBounded: boolean;
  };
  historicalPublication: {
    publishedDays: number;
    publishedDaysBounded: boolean;
    latestEvidenceDay: string | null;
    latestComputedAt: string | null;
    previewState: "current" | "stale" | "not_published";
    previewGeneratedAt: string | null;
  };
}> {
  if (!Number.isFinite(nowEpoch)) throw unavailable();
  const since = new Date(nowEpoch - 24 * 60 * 60 * 1_000).toISOString();
  const sinceWeek = new Date(nowEpoch - 7 * 24 * 60 * 60 * 1_000).toISOString();
  const sinceMonth = new Date(nowEpoch - 30 * 24 * 60 * 60 * 1_000).toISOString();

  const [sourceIdentity, targetIdentity] = await Promise.all([
    bindings.source.prepare(
      `SELECT source.source_id, v1.source_namespace AS v1_namespace,
              v11.source_namespace AS v11_namespace
         FROM storage_source_state source
         JOIN typed_v1_admission_state v1
           ON v1.id=1 AND v1.runtime_contract_version=1
         JOIN typed_v11_admission_state v11
           ON v11.id=1 AND v11.runtime_contract_version=1
        WHERE source.singleton=1`,
    ).first<{ source_id: string; v1_namespace: string; v11_namespace: string }>(),
    bindings.target.prepare(
      `SELECT source_namespace, contract_version
         FROM analytics_runtime_sources WHERE source_id=? LIMIT 1`,
    ).bind(bindings.sourceId).first<{
      source_namespace: string;
      contract_version: number;
    }>(),
  ]);
  if (!sourceIdentity || !targetIdentity
      || sourceIdentity.source_id !== bindings.sourceId
      || sourceIdentity.v1_namespace !== bindings.sourceNamespace
      || sourceIdentity.v11_namespace !== bindings.sourceNamespace
      || targetIdentity.source_namespace !== bindings.sourceNamespace
      || targetIdentity.contract_version !== 1
      || bindings.source === bindings.target) {
    throw unavailable();
  }

  const includeV12 = await hasTelemetryV12ChunkTable(bindings.source);
  const v12ChunkHeaders = includeV12 ? `UNION ALL
         SELECT participant_id, created_at, record_count AS records
           FROM telemetry_v12_chunks` : "";
  const v12AcceptedUploads = includeV12 ? `UNION ALL
         SELECT participant_id, created_at FROM telemetry_v12_chunks` : "";
  const v12StoredRecords = includeV12
    ? " + COALESCE((SELECT SUM(record_count) FROM telemetry_v12_chunks),0)"
    : "";
  const v12SelectedChunks = includeV12 ? ` + (
       SELECT COUNT(*) FROM telemetry_v12_domain_heads head
       JOIN telemetry_v12_domain_days day ON day.generation_id=head.generation_id
       JOIN telemetry_v12_chunks chunk ON chunk.participant_id=head.participant_id
        AND chunk.manifest_id=day.manifest_id
     )` : "";

  const [chunks, accounts, storedRecords, latestDaily, pendingDaily,
    historical, preview] = await Promise.all([
    bindings.source.prepare(
      `WITH chunk_headers AS (
         SELECT participant_id, created_at, accepted_record_count AS records
           FROM telemetry_v1_chunks
         UNION ALL
         SELECT participant_id, created_at, record_count AS records
           FROM telemetry_v11_chunks
         ${v12ChunkHeaders}
       )
       SELECT COUNT(*) AS total,
              ((SELECT COUNT(*) FROM telemetry_analytical_chunks)
                ${v12SelectedChunks}) AS current,
              COALESCE(SUM(CASE WHEN created_at>=?1 THEN 1 ELSE 0 END),0)
                AS accepted_last_24h,
              COALESCE(SUM(CASE WHEN created_at>=?2 THEN 1 ELSE 0 END),0)
                AS accepted_last_7d,
              MAX(created_at) AS latest_accepted_at
         FROM chunk_headers`,
    ).bind(since, sinceWeek).first<CountRow>(),
    bindings.source.prepare(
      `WITH accepted_uploads AS (
         SELECT participant_id, created_at FROM telemetry_contributions
          WHERE status='accepted'
         UNION ALL
         SELECT participant_id, created_at FROM telemetry_v1_chunks
         UNION ALL
         SELECT participant_id, created_at FROM telemetry_v11_chunks
         ${v12AcceptedUploads}
       ), latest_by_account AS (
         SELECT participant_id, MAX(created_at) AS latest_accepted_at
           FROM accepted_uploads GROUP BY participant_id
       )
       SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN latest_accepted_at>=?1 THEN 1 ELSE 0 END),0)
                AS accepted_last_24h,
              COALESCE(SUM(CASE WHEN latest_accepted_at>=?2 THEN 1 ELSE 0 END),0)
                AS accepted_last_7d,
              COALESCE(SUM(CASE WHEN latest_accepted_at>=?3 THEN 1 ELSE 0 END),0)
                AS accepted_last_30d
         FROM latest_by_account`,
    ).bind(since, sinceWeek, sinceMonth).first<CountRow>(),
    bindings.source.prepare(
      `SELECT
         COALESCE((SELECT SUM(accepted_record_count) FROM telemetry_v1_chunks),0)
         + COALESCE((SELECT SUM(record_count) FROM telemetry_v11_chunks),0)
         ${v12StoredRecords}
           AS total`,
    ).first<CountRow>(),
    bindings.target.prepare(
      `SELECT publication.day, publication.released_at
         FROM analytics_community_daily_heads head
         JOIN analytics_community_daily_publications publication
           ON publication.source_id=head.source_id
          AND publication.day=head.day AND publication.revision=head.revision
        WHERE head.source_id=? ORDER BY head.day DESC LIMIT 1`,
    ).bind(bindings.sourceId).first<{ day: string; released_at: string }>(),
    bindings.target.prepare(
      `SELECT COUNT(*) AS total FROM (
         SELECT 1 FROM analytics_community_daily_queue
          WHERE source_id=? ORDER BY day LIMIT ?
       )`,
    ).bind(bindings.sourceId, MAX_ADMIN_AGGREGATE_ROWS + 1).first<CountRow>(),
    bindings.target.prepare(
      `SELECT COUNT(*) AS published_days, MAX(day) AS latest_evidence_day,
              MAX(computed_ms) AS latest_computed_ms
         FROM (
           SELECT day,computed_ms FROM analytics_community_model_publications
            WHERE source_id=? ORDER BY day DESC LIMIT ?
         )`,
    ).bind(bindings.sourceId, MAX_ADMIN_AGGREGATE_ROWS + 1)
      .first<HistoricalPublicationRow>(),
    bindings.target.prepare(
      `SELECT generated_at,inputs_current FROM analytics_community_graph_previews
        WHERE source_id=? LIMIT 1`,
    ).bind(bindings.sourceId).first<PreviewRow>(),
  ]);
  if (!chunks || !accounts || !storedRecords || !pendingDaily || !historical) {
    throw unavailable();
  }

  const chunkTotal = count(chunks.total);
  const currentChunks = count(chunks.current);
  const chunkLast24Hours = count(chunks.accepted_last_24h);
  const chunkLast7Days = count(chunks.accepted_last_7d);
  const accountTotal = count(accounts.total);
  const accountLast24Hours = count(accounts.accepted_last_24h);
  const accountLast7Days = count(accounts.accepted_last_7d);
  const accountLast30Days = count(accounts.accepted_last_30d);
  const storedRecordTotal = count(storedRecords.total);
  const pendingDailyTotal = count(pendingDaily.total);
  const publishedDaysTotal = count(historical.published_days);
  if (currentChunks > chunkTotal
      || accountLast24Hours > accountTotal
      || accountLast7Days > accountTotal
      || accountLast30Days > accountTotal) {
    throw unavailable();
  }
  if (preview && (preview.inputs_current !== 0 && preview.inputs_current !== 1)) {
    throw unavailable();
  }

  const pendingDailyBounded = pendingDailyTotal > MAX_ADMIN_AGGREGATE_ROWS;
  const publishedDaysBounded = publishedDaysTotal > MAX_ADMIN_AGGREGATE_ROWS;
  const latestChunkAt = nullableTimestamp(chunks.latest_accepted_at ?? null);
  const latestLegacyAt = await bindings.source.prepare(
    `SELECT MAX(created_at) AS latest_accepted_at FROM telemetry_contributions
      WHERE status='accepted'`,
  ).first<{ latest_accepted_at: string | null }>();
  if (!latestLegacyAt) throw unavailable();
  const latestAcceptedAt = [
    latestChunkAt,
    nullableTimestamp(latestLegacyAt.latest_accepted_at),
  ].filter((value): value is string => value !== null).sort().at(-1) ?? null;
  const legacyRecent = await bindings.source.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN created_at>=?1 THEN 1 ELSE 0 END),0)
         AS accepted_last_24h,
       COALESCE(SUM(CASE WHEN created_at>=?2 THEN 1 ELSE 0 END),0)
         AS accepted_last_7d
       FROM telemetry_contributions WHERE status='accepted'`,
  ).bind(since, sinceWeek).first<CountRow>();
  if (!legacyRecent) throw unavailable();

  return {
    contributions: {
      contributingAccounts: {
        total: accountTotal,
        bounded: false,
        acceptedLast24Hours: accountLast24Hours,
        acceptedLast7Days: accountLast7Days,
        acceptedLast30Days: accountLast30Days,
      },
      incrementalChunks: {
        total: chunkTotal,
        current: currentChunks,
        bounded: false,
        acceptedLast24Hours: chunkLast24Hours,
        acceptedLast7Days: chunkLast7Days,
      },
      acceptedLast24Hours: addCounts(
        chunkLast24Hours,
        legacyRecent.accepted_last_24h,
      ),
      acceptedLast7Days: addCounts(
        chunkLast7Days,
        legacyRecent.accepted_last_7d,
      ),
      latestAcceptedAt,
      storedTelemetryRecords: storedRecordTotal,
      storedTelemetryRecordsBounded: false,
    },
    dailyPublication: {
      latestEvidenceDay: latestDaily ? nullableDay(latestDaily.day) : null,
      latestReleasedAt: latestDaily
        ? nullableTimestamp(latestDaily.released_at)
        : null,
      pendingRebuilds: Math.min(pendingDailyTotal, MAX_ADMIN_AGGREGATE_ROWS),
      pendingRebuildsBounded: pendingDailyBounded,
    },
    historicalPublication: {
      publishedDays: Math.min(publishedDaysTotal, MAX_ADMIN_AGGREGATE_ROWS),
      publishedDaysBounded,
      latestEvidenceDay: nullableDay(historical.latest_evidence_day),
      latestComputedAt: nullableEpochTimestamp(historical.latest_computed_ms),
      previewState: preview === null
        ? "not_published"
        : preview.inputs_current === 1 ? "current" : "stale",
      previewGeneratedAt: preview
        ? nullableTimestamp(preview.generated_at)
        : null,
    },
  };
}
