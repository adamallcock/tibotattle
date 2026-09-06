import { SEVEN_DAY_WINDOW_MINUTES } from "@app-usagemonitor/quota-analysis";
import { buildCommunityModelCompositionDay, ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS } from "./admin-community-allowance";
import { advanceCommunityAnalysisRun } from "./community-analysis-runner";
import type { CommunityAnalysisWorkIdentity } from "./community-analysis-work";
import {
  COMMUNITY_ATTRIBUTION_METHOD_VERSION, COMMUNITY_PARTICIPANT_PAGE_CTE,
  COMPOSITION_CACHE_KEY_SUFFIX, validCompleteCachedComposition,
  type CommunityModelComposition,
} from "./community-allowance";
import { modelHistoryWindow } from "./model-history-window";
import {
  MODEL_HISTORY_METHOD_VERSION, MAX_DOWNSAMPLED_QUOTA_ROWS,
  finishHistoricalModelCompositionV1, v1QuotaFinishQueryReserve, type V1ModelCompositionResult,
} from "./quota-analysis-v1";
import { assertV1SourcePinCurrent, loadV1SourcePin, type V1SourcePin } from "./telemetry-v1-source-selection";
import type { D1InvocationBudget } from "./d1-invocation-budget";

export const COMMUNITY_MODEL_HISTORY_METHOD = `${COMPOSITION_CACHE_KEY_SUFFIX}:${MODEL_HISTORY_METHOD_VERSION}`;
const PAGE_SIZE = 64, MAX_PAGES = 16, MAX_RESULT_BYTES = 16 * 1024;
const FINAL_RESERVE = 12, MAX_ATTEMPTS = 2;
const encoder = new TextEncoder();

export interface CommunityModelHistoryProgress {
  status: "complete" | "deferred" | "unavailable";
  day: string | null;
  resolvedAccounts: number;
  requiredAccounts: number;
  publishedDays: number;
}
interface Candidate {
  participant_id: string;
  state: string;
  has_v1: number;
  has_v11: number;
  has_legacy: number;
  legacy_overlap: number;
  input_revision: number | null;
  input_fingerprint: string | null;
  result_json: string | null;
}

// Physical census first, including a lookahead row. Only compact terminal
// results are joined; this never runs a history fit in an interactive request.
export const MODEL_HISTORY_CENSUS_SQL = `${COMMUNITY_PARTICIPANT_PAGE_CTE}
SELECT s.id AS participant_id, s.state, s.has_v1, s.has_v11, s.has_legacy,
  CASE WHEN s.has_v11=0 AND s.has_v1=1 AND s.has_legacy=1 THEN EXISTS (
    SELECT 1 FROM telemetry_records r INDEXED BY telemetry_records_participant_time
    WHERE r.participant_id=s.id AND r.observed_at>=?3 AND r.observed_at<?4
      AND r.record_kind='quota' AND r.provider='openai_codex' AND r.limit_id='codex'
      AND EXISTS (SELECT 1 FROM telemetry_contribution_occurrences o INDEXED BY telemetry_contribution_occurrences_record
        JOIN telemetry_contributions c ON c.id=o.contribution_id
        WHERE o.participant_id=r.participant_id AND o.record_kind=r.record_kind AND o.occurrence_id=r.occurrence_id
          AND c.status='accepted' AND c.transport_schema_version='telemetry-contribution-v0.2')
  ) ELSE 0 END AS legacy_overlap,
  v.revision AS input_revision, result.input_fingerprint,
  CASE WHEN length(CAST(result.result_json AS BLOB))<=?7 THEN result.result_json ELSE NULL END AS result_json
FROM sources s
LEFT JOIN community_analytical_input_versions v ON v.participant_id=s.id
LEFT JOIN community_model_history_results result ON result.participant_id=s.id
  AND result.day=?5 AND result.input_revision=v.revision AND result.method_version=?6
ORDER BY s.id`;

function admitted(options: { meter: D1InvocationBudget; deadlineMs: number }, queries: number): boolean {
  return options.meter.remainingQueries >= queries + FINAL_RESERVE && Date.now() < options.deadlineMs;
}

function parsedResult(row: Candidate): V1ModelCompositionResult | null {
  if (typeof row.result_json !== "string" || encoder.encode(row.result_json).byteLength > MAX_RESULT_BYTES
    || typeof row.input_fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.input_fingerprint)) return null;
  try {
    const result: unknown = JSON.parse(row.result_json);
    return validCompleteCachedComposition(result, row.input_fingerprint, MODEL_HISTORY_METHOD_VERSION) ? result : null;
  } catch { return null; }
}

async function publishResult(db: D1Database, day: string, sourcePin: V1SourcePin,
  result: V1ModelCompositionResult, lease: string): Promise<boolean> {
  if (!("participantId" in sourcePin.scope) || sourcePin.scope.throughDay !== day
    || sourcePin.inputRevision === null || !validCompleteCachedComposition(result, sourcePin.fingerprint, MODEL_HISTORY_METHOD_VERSION)) {
    throw new TypeError("model history result identity invalid");
  }
  const json = JSON.stringify(result);
  if (encoder.encode(json).byteLength > MAX_RESULT_BYTES) return false;
  await assertV1SourcePinCurrent(db, sourcePin);
  return (await db.prepare(`INSERT INTO community_model_history_results
      (participant_id,day,input_revision,input_fingerprint,method_version,result_json,computed_at)
    SELECT ?1,?2,?3,?4,?5,?6,strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE EXISTS (SELECT 1 FROM participants p JOIN community_analytical_input_versions v ON v.participant_id=p.id
      WHERE p.id=?1 AND p.state='active' AND v.revision=?3
        AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id=p.id))
      AND EXISTS (SELECT 1 FROM retention_state WHERE singleton=1 AND maintenance_lease_token=?7
        AND maintenance_lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(participant_id,day) DO UPDATE SET input_revision=excluded.input_revision,
      input_fingerprint=excluded.input_fingerprint,method_version=excluded.method_version,
      result_json=excluded.result_json,computed_at=excluded.computed_at`)
    .bind(sourcePin.scope.participantId, day, sourcePin.inputRevision, sourcePin.fingerprint,
      COMMUNITY_MODEL_HISTORY_METHOD, json, lease).run()).meta.changes === 1;
}

/** Low-priority, restartable backfill of missing closed UTC days. One date per
 * invocation and at most two account attempts; pages and all follow-on work
 * share the scheduler's actual query meter. Completed historical days are
 * separate from forward-recorded snapshots, and affected corrections enqueue
 * them again through 0048's bounded day invalidation triggers.
 */
export async function warmCommunityModelHistory(db: D1Database, nowMs: number, options: {
  meter: D1InvocationBudget; deadlineMs: number; maintenanceLease: string;
}): Promise<CommunityModelHistoryProgress> {
  const progress: CommunityModelHistoryProgress = { status: "deferred", day: null,
    resolvedAccounts: 0, requiredAccounts: 0, publishedDays: 0 };
  if (!Number.isFinite(nowMs) || !Number.isFinite(options.deadlineMs) || !options.maintenanceLease || !admitted(options, 4)) return progress;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  // Schema gate is independent: a missing 0048 defers only history, not the
  // deployed current calculator or cached graph. No exception means "empty".
  const schema = await db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'
    AND name IN ('community_model_history_work','community_model_history_work_parts',
      'community_model_history_work_stage','community_model_history_results')`).first<{ count: number }>();
  if (schema?.count !== 4) return { ...progress, status: "unavailable" };
  // Bound derived result retention to the displayed history horizon. This is
  // a small indexed page, never a source-record deletion or an unbounded purge.
  if (admitted(options, 1)) await db.prepare(`DELETE FROM community_model_history_results
    WHERE (day,participant_id) IN (SELECT day,participant_id FROM community_model_history_results
      WHERE day<date(?1,?2) ORDER BY day,participant_id LIMIT 64)
      AND EXISTS (SELECT 1 FROM retention_state WHERE singleton=1 AND maintenance_lease_token=?3
        AND maintenance_lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
    .bind(today, `-${ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS - 1} days`, options.maintenanceLease).run();
  const source = await db.prepare("SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1")
    .first<{ mutation_epoch: number }>();
  if (!Number.isSafeInteger(source?.mutation_epoch) || source!.mutation_epoch < 0) return { ...progress, status: "unavailable" };
  const missing = await db.prepare(`WITH RECURSIVE dates(day,n) AS (
      SELECT date(?1,'-1 day'),1 UNION ALL SELECT date(day,'-1 day'),n+1 FROM dates WHERE n<?2
    ) SELECT dates.day FROM dates LEFT JOIN community_model_composition_days d ON d.day=dates.day
      AND d.attribution_method_version=?3 AND (d.history_method_version IS NULL OR d.history_method_version=?4)
    WHERE d.day IS NULL ORDER BY dates.day DESC LIMIT 1`)
    .bind(today, ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS - 1, COMMUNITY_ATTRIBUTION_METHOD_VERSION,
      COMMUNITY_MODEL_HISTORY_METHOD).first<{ day: string }>();
  if (!missing) return { ...progress, status: "complete" };
  progress.day = missing.day;
  const window = modelHistoryWindow(missing.day);
  const pending: Pick<Candidate, "participant_id" | "input_revision">[] = [];
  const compositions: CommunityModelComposition[] = [];
  let cursor = "", complete = false, v1ParticipantCount = 0, unsupportedSourceParticipantCount = 0, refusedParticipantCount = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (!admitted(options, 1)) return progress;
    const rows = (await db.prepare(MODEL_HISTORY_CENSUS_SQL).bind(cursor, PAGE_SIZE + 1,
      window.observedAtCutoff, window.observedAtBefore, window.day, COMMUNITY_MODEL_HISTORY_METHOD,
      MAX_RESULT_BYTES).all<Candidate>()).results;
    let previous = cursor;
    for (const row of rows) {
      if (typeof row.participant_id !== "string" || row.participant_id <= previous || row.participant_id.length > 128
        || ![row.has_legacy, row.has_v1, row.has_v11, row.legacy_overlap].every(value => value === 0 || value === 1)) {
        return { ...progress, status: "unavailable" };
      }
      previous = row.participant_id;
    }
    if (rows.length > PAGE_SIZE + 1) return { ...progress, status: "unavailable" };
    for (const row of rows.slice(0, PAGE_SIZE)) {
      cursor = row.participant_id;
      if (row.state !== "active" || !(row.has_v1 || row.has_v11 || row.has_legacy)) continue;
      if (!row.has_v1 || row.has_v11 || row.legacy_overlap) { unsupportedSourceParticipantCount++; continue; }
      v1ParticipantCount++;
      if (!Number.isSafeInteger(row.input_revision) || row.input_revision === null || row.input_revision < 0) return { ...progress, status: "unavailable" };
      const result = parsedResult(row);
      if (!result) pending.push({ participant_id: row.participant_id, input_revision: row.input_revision });
      else if (result.status === "ready") {
        if (result.latestQuotaObservedAt >= window.observedAtBefore) return { ...progress, status: "unavailable" };
        compositions.push({ participantId: row.participant_id, composition: result });
      } else refusedParticipantCount++;
    }
    if (rows.length <= PAGE_SIZE) { complete = true; break; }
  }
  progress.requiredAccounts = v1ParticipantCount;
  progress.resolvedAccounts = v1ParticipantCount - pending.length;
  if (!complete) return progress; // A page prefix is never a whole cohort.
  if (!pending.length) {
    if (!admitted(options, 1)) return progress;
    const payload = buildCommunityModelCompositionDay({ compositions, v1ParticipantCount,
      unsupportedSourceParticipantCount, refusedParticipantCount }, window.day);
    const json = JSON.stringify(payload);
    if (encoder.encode(json).byteLength > MAX_RESULT_BYTES) return { ...progress, status: "unavailable" };
    const result = await db.prepare(`INSERT INTO community_model_composition_days
          (day,payload_json,computed_at,attribution_method_version,source_mutation_epoch,history_method_version)
        SELECT ?1,?2,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?3,?4,?5
        WHERE EXISTS (SELECT 1 FROM community_snapshot_mutation_control WHERE singleton_id=1 AND mutation_epoch=?4)
          AND EXISTS (SELECT 1 FROM retention_state WHERE singleton=1 AND maintenance_lease_token=?6
            AND maintenance_lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(day) DO UPDATE SET payload_json=excluded.payload_json,computed_at=excluded.computed_at,
          attribution_method_version=excluded.attribution_method_version,source_mutation_epoch=excluded.source_mutation_epoch,
          history_method_version=excluded.history_method_version
        WHERE community_model_composition_days.history_method_version IS NOT NULL
          OR community_model_composition_days.attribution_method_version IS NOT excluded.attribution_method_version`)
        .bind(window.day, json, COMMUNITY_ATTRIBUTION_METHOD_VERSION, source!.mutation_epoch,
          COMMUNITY_MODEL_HISTORY_METHOD, options.maintenanceLease).run();
    // Keep the healthy preview available until its normal atomic refresh. A
    // newly backfilled day is not a reason to create a temporary graph outage.
    return { ...progress, publishedDays: result.meta.changes === 1 ? 1 : 0 };
  }
  // Do not retain a whole cohort of finished vectors across another account's
  // acquisition/solver allocations. The next pass revalidates the cohort.
  compositions.length = 0;
  // A troublesome account cannot monopolize every pass for this day. Current
  // caches/work are neither read nor changed, and v1.1 is never downgraded.
  const start = Math.floor(nowMs / 60_000) % pending.length;
  for (let attempt = 0; attempt < Math.min(MAX_ATTEMPTS, pending.length); attempt++) {
    if (!admitted(options, 40)) break;
    const row = pending[(start + attempt) % pending.length]!;
    const pin = await loadV1SourcePin(db, { participantId: row.participant_id, fromDay: window.fromDay, throughDay: window.day });
    if (pin.inputRevision === null || pin.inputRevision !== row.input_revision) continue;
    const identity: CommunityAnalysisWorkIdentity = { participantId: row.participant_id,
      inputRevision: pin.inputRevision, inputFingerprint: pin.fingerprint, sourceKind: "v1",
      sourceMethodVersion: MODEL_HISTORY_METHOD_VERSION, fixedNow: window.fixedNow,
      observedAtCutoff: window.observedAtCutoff,
      resetsAtCutoff: new Date(Date.parse(window.observedAtCutoff) + SEVEN_DAY_WINDOW_MINUTES * 60_000).toISOString(),
      windowMinutes: SEVEN_DAY_WINDOW_MINUTES, maxQuotaRows: MAX_DOWNSAMPLED_QUOTA_ROWS };
    const allocation = { remainingQueries: Math.max(0, options.meter.remainingQueries - FINAL_RESERVE), deadlineMs: options.deadlineMs };
    const acquired = await advanceCommunityAnalysisRun(db, { identity, sourcePin: pin, budget: allocation,
      storage: "model-history", completedEvidenceReserveQueries: v1QuotaFinishQueryReserve() + 3 });
    let result: V1ModelCompositionResult;
    if (acquired.status === "not_testable") result = { status: "not_testable", reason: acquired.reason };
    else if (acquired.status === "ready") {
      if (!admitted(options, v1QuotaFinishQueryReserve() + 3)) break;
      allocation.remainingQueries = options.meter.remainingQueries - FINAL_RESERVE - 3;
      const finished = await finishHistoricalModelCompositionV1(db, row.participant_id, window.day,
        acquired.evidence, allocation, { sourcePin: pin });
      if (finished.status !== "complete") continue;
      result = finished.analysis;
    } else continue;
    if (admitted(options, 3) && await publishResult(db, window.day, pin, result, options.maintenanceLease)) progress.resolvedAccounts++;
  }
  return progress; // Reread the complete cohort on a subsequent invocation.
}
