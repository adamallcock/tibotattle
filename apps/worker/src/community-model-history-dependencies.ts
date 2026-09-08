import { createCommunityAnalysisWorkStore, type CommunityAnalysisWorkBudget,
  type CommunityAnalysisWorkIdentity } from "./community-analysis-work";
import { loadV1SourcePin, type V1SourcePin } from "./telemetry-v1-source-selection";
import { modelHistoryWindow } from "./model-history-window";

const historyWork = createCommunityAnalysisWorkStore("model-history");
const HASH = /^[a-f0-9]{64}$/u;
export interface CommunityHistoryDependency {
  day: string;
  fromDay: string;
  revision: number;
  fingerprint: string;
}
export interface PreviousHistoryResult {
  input_revision: number;
  input_fingerprint: string;
  dependency_revision: number | null;
  method_version: string;
  result_json: string;
}

function spend(budget: CommunityAnalysisWorkBudget, queries: number): boolean {
  if (budget.remainingQueries - (budget.reserveQueries ?? 0) < queries || (budget.now ?? Date.now)() >= budget.deadlineMs) return false;
  budget.remainingQueries -= queries; return true;
}

/** Metadata only. Old checkpoints/results can be adopted without reading their
 * source records when their exact old vector digest matches this current pin. */
export async function loadCommunityHistorySource(db: D1Database, participantId: string, day: string,
  budget: CommunityAnalysisWorkBudget): Promise<{
    pin: V1SourcePin; previousWorkFingerprint: string | null; previousResult: PreviousHistoryResult | null;
  } | null> {
  if (!spend(budget, 3)) return null;
  const window = modelHistoryWindow(day);
  const row = await db.prepare(`SELECT w.input_revision AS work_revision,w.input_fingerprint AS work_fingerprint,
      r.input_revision AS result_revision,r.input_fingerprint AS result_fingerprint,r.dependency_revision,
      r.method_version,CASE WHEN length(CAST(r.result_json AS BLOB))<=16384 THEN r.result_json END AS result_json,
      d.input_fingerprint AS dependency_fingerprint
    FROM participants p
    LEFT JOIN community_model_history_work w ON w.participant_id=p.id
      AND w.fixed_now=?2 AND w.observed_at_cutoff=?3
    LEFT JOIN community_model_history_results r ON r.participant_id=p.id AND r.day=?4
    LEFT JOIN community_model_history_dependencies d ON d.participant_id=p.id AND d.day=?4
    WHERE p.id=?1 AND p.state='active'`)
    .bind(participantId, window.fixedNow, window.observedAtCutoff, day).first<{
      work_revision: number | null; work_fingerprint: string | null;
      result_revision: number | null; result_fingerprint: string | null; dependency_revision: number | null;
      method_version: string | null; result_json: string | null; dependency_fingerprint: string | null;
    }>();
  const legacyInputRevisions: number[] = [];
  if (row) for (const [revision, fingerprint] of [[row.work_revision, row.work_fingerprint],
    [row.result_revision, row.result_fingerprint]] as const) {
    if (revision !== null && Number.isSafeInteger(revision) && revision >= 0 && fingerprint
      && fingerprint !== row.dependency_fingerprint) legacyInputRevisions.push(revision);
  }
  const pin = await loadV1SourcePin(db, { participantId, fromDay: window.fromDay, throughDay: day },
    { legacyInputRevisions: [...new Set(legacyInputRevisions)], includeDayDependencies: true });
  const previousResult = row && row.result_revision !== null && row.result_fingerprint !== null
    && row.method_version !== null && row.result_json !== null
    ? { input_revision: row.result_revision, input_fingerprint: row.result_fingerprint,
      dependency_revision: row.dependency_revision, method_version: row.method_version, result_json: row.result_json } : null;
  return { pin, previousWorkFingerprint: row?.work_fingerprint ?? null, previousResult };
}

/** Register/refresh one exact window proof under the same account and lease
 * fence as the final calculation. An unchanged proof is a read, not an UPDATE. */
export async function ensureCommunityHistoryDependency(db: D1Database, pin: V1SourcePin,
  lease: string, budget: CommunityAnalysisWorkBudget): Promise<CommunityHistoryDependency | null> {
  if (!("participantId" in pin.scope) || !pin.scope.fromDay || !pin.scope.throughDay
    || pin.inputRevision === null || !HASH.test(pin.fingerprint) || !lease) throw new TypeError("history dependency pin invalid");
  const { participantId, fromDay, throughDay: day } = pin.scope;
  if (modelHistoryWindow(day).fromDay !== fromDay) throw new TypeError("history dependency window invalid");
  if (!spend(budget, 1)) return null;
  const guard = `EXISTS (SELECT 1 FROM participants p JOIN community_analytical_input_versions v ON v.participant_id=p.id
    WHERE p.id=?1 AND p.state='active' AND v.revision=?4
      AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id=p.id))
    AND EXISTS (SELECT 1 FROM retention_state WHERE singleton=1 AND maintenance_lease_token=?6
      AND maintenance_lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  const bindings = [participantId, day, fromDay, pin.inputRevision, pin.fingerprint, lease];
  const existing = await db.prepare(`SELECT d.dependency_revision,d.input_fingerprint,d.verified_input_revision
    FROM community_model_history_dependencies d WHERE d.participant_id=?1 AND d.day=?2 AND d.from_day=?3 AND ${guard}`)
    .bind(...bindings).first<{ dependency_revision: number; input_fingerprint: string | null; verified_input_revision: number | null }>();
  if (existing && existing.input_fingerprint === pin.fingerprint && existing.verified_input_revision === pin.inputRevision) {
    return { day, fromDay, revision: existing.dependency_revision, fingerprint: pin.fingerprint };
  }
  if (!spend(budget, 1)) return null;
  const row = await db.prepare(`INSERT INTO community_model_history_dependencies
    (participant_id,day,from_day,input_fingerprint,verified_input_revision)
    SELECT ?1,?2,?3,?5,?4 WHERE ${guard}
    ON CONFLICT(participant_id,day) DO UPDATE SET input_fingerprint=excluded.input_fingerprint,
      verified_input_revision=excluded.verified_input_revision
    WHERE community_model_history_dependencies.from_day=excluded.from_day
    RETURNING dependency_revision`).bind(...bindings).first<{ dependency_revision: number }>();
  return row && Number.isSafeInteger(row.dependency_revision) && row.dependency_revision >= 0
    ? { day, fromDay, revision: row.dependency_revision, fingerprint: pin.fingerprint } : null;
}

export async function rebindCommunityHistoryWork(db: D1Database, identity: CommunityAnalysisWorkIdentity,
  pin: V1SourcePin, previousFingerprint: string | null, dependency: CommunityHistoryDependency,
  lease: string, budget: CommunityAnalysisWorkBudget): Promise<"ready" | "absent" | "stale" | "corrupt" | "deferred"> {
  const legacy = previousFingerprint && Object.values(pin.legacyFingerprints ?? {}).includes(previousFingerprint);
  const proof = previousFingerprint === pin.fingerprint || legacy ? previousFingerprint : pin.fingerprint;
  return (await historyWork.rebaseCommunityAnalysisWork(db, identity, { day: dependency.day, fromDay: dependency.fromDay,
    dependencyRevision: dependency.revision, previousFingerprint: proof, maintenanceLease: lease }, budget)).status;
}

export function historicalResultDependencyMatches(result: PreviousHistoryResult, pin: V1SourcePin,
  dependency: CommunityHistoryDependency): boolean {
  if (!Number.isSafeInteger(result.input_revision) || result.input_revision < 0
    || pin.inputRevision === null || result.input_revision > pin.inputRevision) return false;
  // A watch revision is a cheap dirty signal, not the analytical identity.
  // After re-pinning under current source/lease CAS, identical exact evidence
  // can adopt the newer watch revision without rerunning the calculation.
  if (result.dependency_revision !== null) return Number.isSafeInteger(result.dependency_revision)
    && result.dependency_revision >= 0 && result.dependency_revision <= dependency.revision
    && result.input_fingerprint === dependency.fingerprint;
  // Old deployments included the input revision in the fingerprint. Equality
  // against a digest recomputed from current exact metadata is the migration
  // proof; a made-up/stale revision does not become a blind cache hit.
  return result.input_fingerprint === pin.legacyFingerprints?.[String(result.input_revision)]
    || result.input_revision === pin.inputRevision && result.input_fingerprint === pin.fingerprint;
}
