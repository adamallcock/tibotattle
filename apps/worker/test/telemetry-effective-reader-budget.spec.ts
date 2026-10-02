import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {createD1InvocationBudget,D1InvocationBudgetExceededError} from '../src/d1-invocation-budget';
import {readTelemetryUsageCorrectionHistory} from '../src/telemetry-usage-correction-repository';
import {readTelemetryV12EffectiveDays} from '../src/telemetry-v12-effective-reader';
import {initializeSharedAnalyticsCorpusDatabases,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-reader-budget';
async function setup(){await reset();await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);}
it('preserves actual invocation exhaustion at the correction runtime instead of a storage availability failure',async()=>{
 await setup();const meter=createD1InvocationBudget(1),database=meter.wrap(source);
 await database.prepare('SELECT 1').first();
 await expect(readTelemetryUsageCorrectionHistory(database)).rejects.toBeInstanceOf(D1InvocationBudgetExceededError);
 expect(meter.queriesUsed).toBe(1);
 // Genuine missing storage still has its content-free repository error.
 await source.prepare('DROP TABLE telemetry_usage_correction_runtime').run();
 await expect(readTelemetryUsageCorrectionHistory(source)).rejects.toMatchObject({code:'TELEMETRY_USAGE_CORRECTION_UNAVAILABLE'});
});
it.each([0,1])('preserves actual invocation exhaustion in the v1.2 capability/page reader at boundary %i',async spent=>{
 await setup();const meter=createD1InvocationBudget(1),database=meter.wrap(source);
 if(spent)await database.prepare('SELECT 1').first();
 await expect(readTelemetryV12EffectiveDays(database,{participantId:'synthetic-budget-owner',stream:'usage',fromDay:'2026-09-20',throughDay:'2026-09-20'}))
 .rejects.toBeInstanceOf(D1InvocationBudgetExceededError);
 expect(meter.queriesUsed).toBe(1);
});
