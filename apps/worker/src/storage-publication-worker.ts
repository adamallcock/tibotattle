import { createD1InvocationBudget } from './d1-invocation-budget';
import { publicAnalyticsEnabled } from './public-analytics-gate';
import { runStorageAnalyticsPass } from './storage-analytics-runtime';
import { storageGraphFailureFields } from './storage-analytics-failure';

/**
 * The community publication lane, on its own schedule.
 *
 * It was a phase of the analytics worker, sharing one 55-second window and one
 * statement meter with ordered delivery and the graph lane. Measured on
 * 2026-09-18, that pass published one to four days at roughly a hundred
 * statements each and reached its wall-clock deadline having computed zero
 * graph results, on every pass observed. The meter was not the binding
 * constraint — the passes ended on `deadline`, not `query_budget`, with around
 * three hundred of nine hundred statements spent. What the publisher consumed
 * was TIME.
 *
 * A reserved statement floor therefore could not have fixed it, and one already
 * existed: the daily lane only ever took what was left above the graph's
 * 560-statement admission floor. Separating the workers is what divides the
 * wall clock, which is the resource actually in contention.
 *
 * This worker runs publication and nothing else. The analytics worker keeps
 * delivery, the graph lane and the retirement sweeps — the sweeps stay because
 * the state they reclaim is mostly the graph's own checkpoints, and they were
 * measured at seven to twenty-one statements a pass.
 */
export interface StoragePublicationWorkerEnv {
  STORAGE_INGESTION_DB?: D1Database;
  STORAGE_ANALYTICS_DB?: D1Database;
  DELETION_LEDGER?: D1Database;
  STORAGE_SOURCE_ID?: string;
  TELEMETRY_STORAGE_NAMESPACE?: string;
  STORAGE_ANALYTICS_MODE?: 'enabled' | 'disabled';
  PUBLIC_ANALYTICS_MODE?: 'enabled' | 'disabled';
  /** Unset means off, so deploying this worker publishes nothing until the
   * switch is thrown — and the analytics worker keeps publishing until its own
   * `PUBLICATION_LANE_EXTERNAL` switch is thrown in the same change. */
  PUBLICATION_LANE?: 'enabled' | 'disabled';
}

/** One minute, matching the analytics worker's ordinary pass. Publication has no
 * long pass: a published day is bounded work, and a window longer than the
 * cadence would let two invocations overlap on the same durable cursor. */
const PUBLICATION_WINDOW_MS = 55_000;

export function storagePublicationLaneEnabled(env: unknown): boolean {
  if (!env || typeof env !== 'object') return false;
  return Reflect.get(env, 'PUBLICATION_LANE') === 'enabled';
}

export async function runStoragePublicationSchedule(
  env: StoragePublicationWorkerEnv,
  options?: { nowMs?: number },
): Promise<void> {
  if (!storagePublicationLaneEnabled(env)) return;
  if (env.STORAGE_ANALYTICS_MODE !== 'enabled' || !publicAnalyticsEnabled(env)
    || !env.STORAGE_INGESTION_DB || !env.STORAGE_ANALYTICS_DB || !env.DELETION_LEDGER
    || !env.STORAGE_SOURCE_ID || !env.TELEMETRY_STORAGE_NAMESPACE
    || (options?.nowMs !== undefined
      && (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0))) {
    throw new Error('STORAGE_PUBLICATION_CONFIGURATION_INVALID');
  }
  const event = 'storage_publication_schedule';
  try {
    const meter = createD1InvocationBudget(900);
    const started = Date.now();
    const result = await runStorageAnalyticsPass({
      source: meter.wrap(env.STORAGE_INGESTION_DB),
      target: meter.wrap(env.STORAGE_ANALYTICS_DB),
      ledger: meter.wrap(env.DELETION_LEDGER),
      sourceId: env.STORAGE_SOURCE_ID,
      sourceNamespace: env.TELEMETRY_STORAGE_NAMESPACE,
      publishCommunity: true, publicOnly: true, publicationOnly: true,
      maxSteps: 32, maxQueries: meter.remainingQueries,
      deadlineMs: started + PUBLICATION_WINDOW_MS,
    });
    console.log(JSON.stringify({ event, ...result,
      elapsedMs: Date.now() - started, queriesUsed: meter.queriesUsed }));
  } catch (error) {
    console.error(JSON.stringify({ event, state: 'unavailable',
      ...storageGraphFailureFields(error) }));
    throw new Error('STORAGE_PUBLICATION_UNAVAILABLE');
  }
}

export default {
  fetch(): Response {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  },
  async scheduled(controller: ScheduledController, env: StoragePublicationWorkerEnv): Promise<void> {
    await runStoragePublicationSchedule(env, { nowMs: controller.scheduledTime });
  },
};
