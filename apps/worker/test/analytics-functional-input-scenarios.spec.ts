import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import * as native from './helpers/analytics-mutation-current';
import {applyPairedFunctionalNativeInput} from './helpers/analytics-functional-input-scenarios';
import {copyAcceptedAnalyticsSource} from './helpers/analytics-source-snapshot';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,
 type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';

type Bindings=Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database;
 STORAGE_INGESTION_A:D1Database;STORAGE_INGESTION_B:D1Database;STORAGE_ROUTING_DB:D1Database};
const b=env as Bindings;
const sourceId='synthetic-p11-paired-functional-input';
const day=()=>new Date(Date.now()-86_400_000).toISOString().slice(0,10);

it('runs one native action with identical SQL and binds on exact cloned physical sources',async()=>{
 await reset();
 const context={reference:{source:b.USAGE_MONITOR_DB,target:b.STORAGE_INGESTION_A,ledger:b.DELETION_LEDGER},
  candidate:{source:b.STORAGE_INGESTION_B,target:b.STORAGE_ANALYTICS_DB,ledger:b.STORAGE_ROUTING_DB},
  analyticalNowMs:Date.now(),now:Date.now};
 await initializeSharedAnalyticsCorpusDatabases(context.reference.source,context.reference.target,b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source:context.reference.source,target:context.reference.target,
  sourceId,sourceNamespace:sourceId,calendarDays:10,graphDays:1,anchorDay:day()});
 const clone=await copyAcceptedAnalyticsSource(context.reference.source,context.candidate.source);
 expect(clone).toMatchObject({exactSchemaAndData:true,exactRowids:true});
 const result=await applyPairedFunctionalNativeInput({context,kernels:{reference:native,candidate:native},
  sourceId,sourceNamespace:sourceId,participantId:corpus.participantId,
  action:{kind:'timestamp_move',day:corpus.correctionDay,occurrenceId:corpus.correctionOccurrenceId}});
 expect(result.evidence.writer).toMatchObject({kind:'timestamp_move',outcome:'accepted',changedFields:['eventTime']});
 expect(result.evidence.paired.admission.divergences).toBe(0);
 expect(result.evidence.paired.admission.physicalFailures).toBe(0);
 expect(result.evidence.priorPhysical.reference.allPriorRowsRetained).toBe(true);
 expect(result.evidence.priorPhysical.candidate.allPriorRowsRetained).toBe(true);
 expect(result.evidence.freshEffective.candidate).toEqual(result.evidence.freshEffective.reference);
 expect(result.evidence.allFamilyParity).toBe('pending');
 await expect(applyPairedFunctionalNativeInput({context:{...context,candidate:{...context.candidate,
  source:context.reference.source}},kernels:{reference:native,candidate:native},sourceId,sourceNamespace:sourceId,
  participantId:corpus.participantId,action:{kind:'timestamp_move',day:corpus.correctionDay,
   occurrenceId:corpus.correctionOccurrenceId}})).rejects.toThrow('FUNCTIONAL_PAIRED_NATIVE_ACTION_SCOPE');
 await expect(applyPairedFunctionalNativeInput({context,kernels:{reference:native,candidate:native},sourceId,
  sourceNamespace:sourceId,participantId:corpus.participantId,
  action:{kind:'timestamp_move',day:corpus.correctionDay}})).rejects.toThrow('FUNCTIONAL_PAIRED_NATIVE_ACTION_SCOPE');
});
