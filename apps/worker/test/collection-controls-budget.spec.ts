import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { readCollectionControls } from '../src/collection-controls';
import { createD1InvocationBudget, D1InvocationBudgetExceededError } from '../src/d1-invocation-budget';
import { caughtStorageGraphFailureFields, withStorageGraphFailureStage } from '../src/storage-analytics-failure';
import type { SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';
const b=env as Env&SharedAnalyticsCorpusMigrations;

it('preserves an exhausted actual statement meter as resumable collection-control deferral',async()=>{
 await reset();const source=b.USAGE_MONITOR_DB;
 await applyD1Migrations(source,b.TEST_MIGRATIONS);
 expect((await readCollectionControls(source)).schemaVersion).toBe('collection-controls-v0.1');
 const meter=createD1InvocationBudget(1),database=meter.wrap(source);
 await database.prepare('SELECT 1').first();
 let failure:unknown;
 try {await withStorageGraphFailureStage('daily_publish',()=>readCollectionControls(database));} catch(error) {failure=error;}
 expect(failure).toBeInstanceOf(D1InvocationBudgetExceededError);
 expect(caughtStorageGraphFailureFields('daily_publish',failure)).toBeUndefined();
 expect(meter.queriesUsed).toBe(1);
 expect((await readCollectionControls(source)).schemaVersion).toBe('collection-controls-v0.1');
});

it('retains unavailable control refusal for an actual missing control table',async()=>{
 await reset();const source=b.USAGE_MONITOR_DB;
 await applyD1Migrations(source,b.TEST_MIGRATIONS);
 await source.prepare('DROP TABLE collection_controls').run();
 await expect(readCollectionControls(source)).rejects.toMatchObject({status:503,code:'COLLECTION_CONTROL_UNAVAILABLE'});
});
