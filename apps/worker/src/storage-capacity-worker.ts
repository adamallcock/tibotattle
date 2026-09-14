import { runStorageCapacityMonitor } from './storage-capacity-monitor';

type StorageCapacityWorkerEnv = Pick<Env, 'STORAGE_ROUTING_DB' | 'STORAGE_INGESTION_A'
  | 'STORAGE_INGESTION_B' | 'STORAGE_INGESTION_C'> & { STORAGE_CAPACITY_MODE?: unknown };

/** Separate capacity scheduler. No enrollment, credentials or upload handler. */
export async function runStorageCapacitySchedule(env: StorageCapacityWorkerEnv): Promise<void> {
  if (env.STORAGE_CAPACITY_MODE === undefined || env.STORAGE_CAPACITY_MODE === 'disabled') return;
  if (env.STORAGE_CAPACITY_MODE !== 'enabled' || !env.STORAGE_ROUTING_DB) {
    throw new Error('STORAGE_CAPACITY_CONFIGURATION_INVALID');
  }
  try {
    const result = await runStorageCapacityMonitor({ catalog: env.STORAGE_ROUTING_DB, bindings: {
      STORAGE_INGESTION_A: env.STORAGE_INGESTION_A,
      STORAGE_INGESTION_B: env.STORAGE_INGESTION_B,
      STORAGE_INGESTION_C: env.STORAGE_INGESTION_C,
    } });
    console.log(JSON.stringify({ event: 'storage_capacity_schedule', ...result }));
  } catch {
    console.error(JSON.stringify({ event: 'storage_capacity_schedule', state: 'unavailable' }));
    throw new Error('STORAGE_CAPACITY_UNAVAILABLE');
  }
}

export default {
  fetch(): Response { return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } }); },
  async scheduled(_controller: ScheduledController, env: StorageCapacityWorkerEnv): Promise<void> {
    await runStorageCapacitySchedule(env);
  },
} satisfies ExportedHandler<StorageCapacityWorkerEnv>;
