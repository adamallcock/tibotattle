/** Durable scheduling only. These rows never replace source pins, calculated
 * evidence, participant authority or the shared invocation budget. */
export interface CurrentAnalysisQueuePass {
  day: string;
  method: string;
  windowGeneration: number;
  maximumServedSequence: number;
}

export interface CurrentAnalysisQueueClaim extends CurrentAnalysisQueuePass {
  id: number;
  participantId: string;
  dirtyGeneration: number;
  servedSequence: number;
  inputRevision: number;
  hasV1: boolean;
  hasV11: boolean;
  hasLegacy: boolean;
}

const MAX_ROLLOVER_ROWS = 1_000;
const LIVE_LEASE = `EXISTS (SELECT 1 FROM retention_state WHERE singleton=1
  AND maintenance_lease_token=?4 AND maintenance_lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const validWindow = (day: string, method: string): boolean => /^\d{4}-\d{2}-\d{2}$/u.test(day)
  && Number.isFinite(Date.parse(`${day}T00:00:00.000Z`))
  && new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day && method.length > 0 && method.length <= 1_024;

/** Once per UTC-day/method, move at most 1,000 registered jobs to the new
 * window. An indexed old-generation suffix survives for the next invocation;
 * no physical-participant scan or all-accounts response is needed. */
export async function prepareCurrentAnalysisQueue(db: D1Database, day: string, method: string,
  maintenanceLease: string): Promise<CurrentAnalysisQueuePass | null> {
  if (!validWindow(day, method) || !maintenanceLease) return null;
  const results = await db.batch<{ window_generation: number; last_sequence: number }>([
    db.prepare(`UPDATE community_current_analysis_queue_state
      SET utc_day=?1,method_version=?2,window_generation=window_generation+1
      WHERE singleton_id=1 AND (utc_day IS NOT ?1 OR method_version IS NOT ?2) AND ${LIVE_LEASE}`)
      .bind(day, method, null, maintenanceLease),
    db.prepare(`UPDATE community_current_analysis_queue
      SET window_generation=(SELECT window_generation FROM community_current_analysis_queue_state WHERE singleton_id=1),
        pending=1,dirty_generation=dirty_generation+1
      WHERE id IN (SELECT id FROM community_current_analysis_queue INDEXED BY community_current_analysis_queue_window
        WHERE window_generation<(SELECT window_generation FROM community_current_analysis_queue_state WHERE singleton_id=1)
        ORDER BY window_generation,id LIMIT ?3)
        AND EXISTS (SELECT 1 FROM community_current_analysis_queue_state WHERE singleton_id=1 AND utc_day=?1 AND method_version=?2)
        AND ${LIVE_LEASE}`).bind(day, method, MAX_ROLLOVER_ROWS, maintenanceLease),
    db.prepare(`SELECT window_generation,last_sequence FROM community_current_analysis_queue_state
      WHERE singleton_id=1 AND utc_day=?1 AND method_version=?2 AND ${LIVE_LEASE}`)
      .bind(day, method, null, maintenanceLease),
  ]);
  const row = results[2]?.results[0];
  if (results[2]?.results.length !== 1 || !integer(row?.window_generation) || !integer(row?.last_sequence)) return null;
  return { day, method, windowGeneration: row.window_generation, maximumServedSequence: row.last_sequence };
}

/** Move a job to the back BEFORE its work starts. A timeout, exception, retry
 * or hot account cannot keep it at the front. The invocation's initial sequence
 * excludes already-served jobs, so low-budget deferrals cannot spin in place. */
export async function claimCurrentAnalysisJob(db: D1Database, pass: CurrentAnalysisQueuePass,
  maintenanceLease: string): Promise<CurrentAnalysisQueueClaim | null> {
  if (!validWindow(pass.day, pass.method) || !integer(pass.windowGeneration)
    || !integer(pass.maximumServedSequence) || !maintenanceLease) return null;
  const stateGuard = `EXISTS (SELECT 1 FROM community_current_analysis_queue_state
    WHERE singleton_id=1 AND utc_day=?1 AND method_version=?2 AND window_generation=?3)`;
  const nextJob = `SELECT q.id FROM community_current_analysis_queue q INDEXED BY community_current_analysis_queue_ready
    JOIN participants p ON p.id=q.participant_id AND p.state='active' AND p.owner_kind='social'
    WHERE q.pending=1 AND q.window_generation=?3 AND q.last_served_sequence<=?5
    ORDER BY q.last_served_sequence,q.id LIMIT 1`;
  const result = await db.batch<{
    id: number; participant_id: string; dirty_generation: number; window_generation: number;
    last_served_sequence: number; input_revision: number; has_v1: number; has_v11: number; has_legacy: number;
  }>([
    db.prepare(`UPDATE community_current_analysis_queue_state SET last_sequence=last_sequence+1
      WHERE singleton_id=1 AND ${stateGuard} AND ${LIVE_LEASE} AND EXISTS (${nextJob})`)
      .bind(pass.day, pass.method, pass.windowGeneration, maintenanceLease, pass.maximumServedSequence),
    db.prepare(`UPDATE community_current_analysis_queue
      SET last_served_sequence=(SELECT last_sequence FROM community_current_analysis_queue_state WHERE singleton_id=1)
      WHERE id=(${nextJob}) AND ${stateGuard} AND ${LIVE_LEASE}
      RETURNING id,participant_id,dirty_generation,window_generation,last_served_sequence,
        (SELECT revision FROM community_analytical_input_versions v
          WHERE v.participant_id=community_current_analysis_queue.participant_id) AS input_revision,
        EXISTS(SELECT 1 FROM telemetry_v1_chunks c WHERE c.participant_id=community_current_analysis_queue.participant_id
          AND c.superseded_at IS NULL) AS has_v1,
        EXISTS(SELECT 1 FROM telemetry_v11_domain_heads h
          WHERE h.participant_id=community_current_analysis_queue.participant_id) AS has_v11,
        EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=community_current_analysis_queue.participant_id
          AND c.status='accepted' AND c.transport_schema_version='telemetry-contribution-v0.2') AS has_legacy`)
      .bind(pass.day, pass.method, pass.windowGeneration, maintenanceLease, pass.maximumServedSequence),
  ]);
  const row = result[1]?.results[0];
  if (!row) return null;
  if (result[1]?.results.length !== 1 || !integer(row.id) || row.id === 0
    || typeof row.participant_id !== "string" || !row.participant_id || row.participant_id.length > 128
    || !integer(row.dirty_generation) || row.dirty_generation === 0 || row.window_generation !== pass.windowGeneration
    || !integer(row.last_served_sequence) || row.last_served_sequence <= pass.maximumServedSequence
    || !integer(row.input_revision) || ![row.has_v1, row.has_v11, row.has_legacy].every(value => value === 0 || value === 1)) {
    throw new TypeError("current analysis queue claim unavailable");
  }
  return { ...pass, id: row.id, participantId: row.participant_id, dirtyGeneration: row.dirty_generation,
    servedSequence: row.last_served_sequence, inputRevision: row.input_revision,
    hasV1: row.has_v1 === 1, hasV11: row.has_v11 === 1, hasLegacy: row.has_legacy === 1 };
}

const ACK_GUARD = `window_generation=?3 AND last_served_sequence=?5
  AND EXISTS (SELECT 1 FROM community_current_analysis_queue_state s
    WHERE s.singleton_id=1 AND s.window_generation=?3 AND s.utc_day=?1 AND s.method_version=?2)
  AND EXISTS (SELECT 1 FROM participants p JOIN community_analytical_input_versions v ON v.participant_id=p.id
    WHERE p.id=community_current_analysis_queue.participant_id AND p.state='active' AND p.owner_kind='social' AND v.revision=?8)
  AND ${LIVE_LEASE}`;

function claimBinds(claim: CurrentAnalysisQueueClaim, maintenanceLease: string): (string | number)[] {
  if (!validWindow(claim.day, claim.method) || !integer(claim.windowGeneration)
    || !integer(claim.id) || claim.id === 0 || !integer(claim.dirtyGeneration) || claim.dirtyGeneration === 0
    || !integer(claim.servedSequence) || !integer(claim.inputRevision) || !maintenanceLease) {
    throw new TypeError("current analysis queue acknowledgement invalid");
  }
  return [claim.day, claim.method, claim.windowGeneration, maintenanceLease, claim.servedSequence,
    claim.id, claim.dirtyGeneration, claim.inputRevision];
}

/** For a validated existing cache only: an intervening cache mutation changes
 * dirty_generation, while an input/authority change also fails the source CAS. */
export async function acknowledgeCurrentAnalysisJob(db: D1Database, claim: CurrentAnalysisQueueClaim,
  maintenanceLease: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE community_current_analysis_queue
    SET pending=0,completed_day=?1,completed_method=?2
    WHERE id=?6 AND dirty_generation=?7 AND ${ACK_GUARD} RETURNING participant_id`)
    .bind(...claimBinds(claim, maintenanceLease)).all<{ participant_id: string }>();
  return result.results.length === 1 && result.results[0]?.participant_id === claim.participantId;
}

/** The publisher must put these around its existing guarded writes in ONE
 * batch. The CHECK assertion rolls back cache writes on a stale job. Cache
 * triggers may then advance dirty_generation inside this transaction only;
 * the final acknowledgement consumes those writes without losing an upload. */
export function currentAnalysisPublicationStatements(db: D1Database, claim: CurrentAnalysisQueueClaim,
  maintenanceLease: string): { before: D1PreparedStatement; after: D1PreparedStatement } {
  const binds = claimBinds(claim, maintenanceLease);
  return {
    before: db.prepare(`UPDATE community_current_analysis_queue
      SET dirty_generation=CASE WHEN dirty_generation=?7 AND ${ACK_GUARD} THEN dirty_generation ELSE -1 END
      WHERE id=?6 RETURNING participant_id`).bind(...binds),
    after: db.prepare(`UPDATE community_current_analysis_queue
      SET pending=CASE WHEN dirty_generation>=?7 AND ${ACK_GUARD} THEN 0 ELSE NULL END,
        completed_day=?1,completed_method=?2
      WHERE id=?6 RETURNING participant_id`).bind(...binds),
  };
}

/** Retention can remove an account's last analytical source. Forget its empty
 * scheduling membership only after an exact job/source/authority recheck. */
export async function retireEmptyCurrentAnalysisJob(db: D1Database, claim: CurrentAnalysisQueueClaim,
  maintenanceLease: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM community_current_analysis_queue
    WHERE id=?6 AND dirty_generation=?7 AND ${ACK_GUARD}
      AND NOT EXISTS(SELECT 1 FROM telemetry_v1_chunks c WHERE c.participant_id=community_current_analysis_queue.participant_id AND c.superseded_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id=community_current_analysis_queue.participant_id)
      AND NOT EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=community_current_analysis_queue.participant_id
        AND c.status='accepted' AND c.transport_schema_version='telemetry-contribution-v0.2')
    RETURNING participant_id`).bind(...claimBinds(claim, maintenanceLease)).all<{ participant_id: string }>();
  return result.results.length === 1 && result.results[0]?.participant_id === claim.participantId;
}
