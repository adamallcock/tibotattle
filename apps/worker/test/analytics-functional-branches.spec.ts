import {expect,it} from 'vitest';
import {captureCompletedFunctionalBase,captureFunctionalTerminalLedgerBase,startFunctionalBranch,assertFunctionalExpectedOwners,planFunctionalBranchPopulation,type FunctionalStores,type FunctionalSnapshotIO,type CompletedFunctionalPair,FUNCTIONAL_FAMILIES} from './helpers/analytics-functional-branches';
const laneNames=['reference','candidate'] as const,sides=['source','target','ledger'] as const;
function fixture(){
 const stores=Object.fromEntries(laneNames.map(lane=>[lane,Object.fromEntries(sides.map(side=>[side,{label:lane+'.'+side,prepare:()=>({bind(){return this;},async all(){return {success:true,results:[{n:0}],meta:{rows_read:1,rows_written:0,duration:0}};}})}]))])) as unknown as FunctionalStores;
 const tableState=new Map(Object.values(stores).flatMap(value=>Object.values(value)).map(db=>[db,1]));
 const labels:string[]=[];let resets=0,captures=0;
 const profile={statements:1,metadataSamples:1,failedStatements:0,measurementFailures:0};
 const io:FunctionalSnapshotIO={
  async capture(database,side='source'){
   captures++;labels.push('capture:'+side);
   const n=tableState.get(database)!;
   const transfer={schemaVersion:'analytics-accepted-source-transfer-v1' as const,statements:['synthetic-private-transfer-'+n],proof:{sqlSha256:String(n).repeat(64),schemaSha256:'b'.repeat(64),rowidInventorySha256:'c'.repeat(64),exportStatements:1,exportedLogicalSqlBytes:100,rowidRows:1,typedRowsCompared:1}};
   return {transfer,profile,wallMs:1,exportWallMs:1,exportResourceMetadata:null,physicalSnapshotBytes:null} as unknown as Awaited<ReturnType<FunctionalSnapshotIO['capture']>>;
  },
  async import(transfer,database,side='source'){
   labels.push('import:'+side);if(tableState.get(database)!==0)throw Error('NONEMPTY');tableState.set(database,Number(transfer.proof.sqlSha256[0]));
   return {exactSchemaAndData:true,exactRowids:true,proof:transfer.proof,importProfile:profile,proofProfile:profile,wallMs:1,verificationExportWallMs:1,exportResourceMetadata:null,physicalSnapshotBytes:null} as Awaited<ReturnType<FunctionalSnapshotIO['import']>>;
  },
 };
 const output=Object.fromEntries(FUNCTIONAL_FAMILIES.map(family=>[family,family==='preview'||family==='cacheSeries'?{complete:true}:[{day:'2026-10-01',value:0}]])) as CompletedFunctionalPair['reference']['output'];
 const inventory={checkedAfterCleanup:true,graphResults:2,modelOwnerResults:1,modelDates:1,calculatedModelDates:1,calculatedModelOwnerResults:1,retiredCalculationDates:0,currentFitOwners:1,modelPublicationDates:1,requestedDailyDates:1,cacheOwnerDaysCompared:1,graphInventorySha256:'d'.repeat(64),dailyPublicationInventory:[{day:'2026-10-01'}]};
 const completed:CompletedFunctionalPair={reference:{output,actualStoredPopulation:inventory},candidate:{output:structuredClone(output),actualStoredPopulation:structuredClone(inventory)}};
 const capture=()=>captureCompletedFunctionalBase({stores,analyticalNowMs:Date.parse('2026-10-01T12:00:00Z'),completed,inputSha256:{reference:'a'.repeat(64),candidate:'b'.repeat(64)}},io);
 return {stores,tableState,labels,io,completed,capture,get captures(){return captures;},get resets(){return resets;},reset:async()=>{resets++;for(const db of tableState.keys())tableState.set(db,0);}};
}
it('branches all six exact stores before a retained scenario and preserves the private base for a separate branch',async()=>{
 const f=fixture(),base=await f.capture();expect(f.captures).toBe(12);
 expect(JSON.stringify(base)).not.toContain('synthetic-private-transfer');
 const clock=Date.parse('2026-10-02T12:00:00Z');
 const first=await startFunctionalBranch(base,{scenario:'append',stores:f.stores,resetLaboratory:f.reset,analyticalNowMs:clock},async ctx=>{
  expect(ctx.analyticalNowMs).toBe(clock);expect(ctx.now).toBe(Date.now);expect(f.resets).toBe(1);
  expect(f.labels.filter(v=>v.startsWith('import:'))).toEqual(['import:source','import:target','import:ledger','import:source','import:target','import:ledger']);
  for(const db of f.tableState.keys()){expect(f.tableState.get(db)).toBe(1);f.tableState.set(db,2);}
  await Promise.resolve();for(const db of f.tableState.keys())expect(f.tableState.get(db)).toBe(2);
  return {outcome:'complete',completed:f.completed};
 });
 expect(first.receipt).toMatchObject({outcome:'complete',physicalStores:6,postStartImports:0,postStartResets:0,resetCountBeforeScenario:1});
 await startFunctionalBranch(base,{scenario:'correction',stores:f.stores,resetLaboratory:f.reset},async()=>{
  expect(f.resets).toBe(2);for(const db of f.tableState.keys())expect(f.tableState.get(db)).toBe(1);
  return {outcome:'complete',completed:f.completed};
 });
});
it('refuses missing families, exact DTO differences, aliased stores, malformed pins and capture drift',async()=>{
 const f=fixture();delete (f.completed.candidate.output as Partial<typeof f.completed.candidate.output>).daily;await expect(f.capture()).rejects.toThrow('INCOMPLETE_OUTPUT');
 const g=fixture();g.completed.candidate.output.daily=[{day:'2026-10-01',value:-0}];await expect(g.capture()).rejects.toThrow();
 const h=fixture();h.stores.candidate.source=h.stores.reference.source;await expect(h.capture()).rejects.toThrow('SIX_INDEPENDENT_STORES');
 const j=fixture(),original=j.io.capture;j.io.capture=async(...args)=>{if(j.captures===6)j.tableState.set(j.stores.reference.source,2);return original(...args);};await expect(j.capture()).rejects.toThrow('BASE_CHANGED_DURING_CAPTURE');
 const k=fixture();await expect(captureCompletedFunctionalBase({stores:k.stores,analyticalNowMs:NaN,completed:k.completed,inputSha256:{reference:'x',candidate:'b'.repeat(64)}},k.io)).rejects.toThrow('CLOCK_OR_INPUT_PIN');
});
it('blocks overlapping or midsequence import, and reports failed startup without starting the action',async()=>{
 const f=fixture(),base=await f.capture();let entered=false;const failures:Record<string,unknown>[]=[];
 await expect(startFunctionalBranch(base,{scenario:'nonempty',stores:f.stores,resetLaboratory:async()=>{},recordIncomplete:r=>failures.push(r)},async()=>{entered=true;return {outcome:'complete',completed:f.completed};})).rejects.toThrow('NONEMPTY');
 expect(entered).toBe(false);expect(failures[0]).toMatchObject({complete:false,boundary:'startup_import_reference_source',incompleteBoundaryResourceMetadata:null});
 await startFunctionalBranch(base,{scenario:'one',stores:f.stores,resetLaboratory:f.reset},async()=>{
  await expect(startFunctionalBranch(base,{scenario:'nested',stores:f.stores,resetLaboratory:f.reset},async()=>({outcome:'complete',completed:f.completed}))).rejects.toThrow('ACTIVE_BRANCH');
  await expect(f.capture()).rejects.toThrow('ACTIVE_BRANCH');expect(f.resets).toBe(1);
  return {outcome:'complete',completed:f.completed};
 });
});
it('does not label refusal or terminal reader equality as a completed publication',async()=>{
 const f=fixture(),base=await f.capture();
 for(const outcome of ['refused','terminal'] as const){
  const result=await startFunctionalBranch(base,{scenario:outcome,stores:f.stores,resetLaboratory:f.reset},async()=>({outcome,reference:{visible:null},candidate:{visible:null}}));
  expect(result.receipt.completion).toBeNull();expect(result.receipt.outcome).toBe(outcome);expect(result.receipt.nonCompleteOutcomeQualification).toContain('owning exact');
 }
 await expect(startFunctionalBranch(base,{scenario:'mismatch',stores:f.stores,resetLaboratory:f.reset},async()=>({outcome:'terminal',reference:{visible:null},candidate:{visible:true}}))).rejects.toThrow();
});

it('keeps source-owner expectations exact and shifts the complete branch calendar explicitly',()=>{
 const owners=['a'.repeat(64),'b'.repeat(64)];assertFunctionalExpectedOwners(owners,undefined);
 assertFunctionalExpectedOwners([owners[0]!],[owners[0]!]);
 expect(()=>assertFunctionalExpectedOwners(owners,[owners[0]!])).toThrow();
 expect(()=>assertFunctionalExpectedOwners([owners[0]!],undefined)).toThrow();
 expect(()=>assertFunctionalExpectedOwners(owners,[owners[0]!,owners[0]!])).toThrow('EXPECTED_OWNERS');
 const base=Date.parse('2026-10-01T12:00:00Z'),input={baseAnalyticalNowMs:base,requestedDates:['2026-09-30'],cacheDates:['2026-09-29','2026-09-30','2026-10-01']};
 expect(planFunctionalBranchPopulation({...input,analyticalNowMs:base+1000})).toEqual({calendarShiftDays:0,requestedDates:input.requestedDates,cacheDates:input.cacheDates});
 expect(planFunctionalBranchPopulation({...input,analyticalNowMs:base+86_400_000})).toEqual({calendarShiftDays:1,requestedDates:['2026-10-01'],cacheDates:['2026-09-30','2026-10-01','2026-10-02']});
 for(const invalid of [{analyticalNowMs:base-86_400_000},{analyticalNowMs:base+367*86_400_000},{analyticalNowMs:base,cacheDates:['2026-02-30']},{analyticalNowMs:base,requestedDates:['2026-10-01','2026-09-30']}])
  expect(()=>planFunctionalBranchPopulation({...input,...invalid})).toThrow();
});

it('requires genuine private counter proofs before any full-row counter exception can reach a base',async()=>{
 const f=fixture();f.completed.reference.publicationRows={modelRows:[],previewRow:{revision:1}};
 f.completed.candidate.publicationRows={modelRows:[],previewRow:{revision:2}};
 await expect(f.capture()).rejects.toThrow();
 f.completed.reference.previewCounterProof={receipt:{complete:true}};
 await expect(f.capture()).rejects.toThrow('PREVIEW_COUNTER_PROOF_REQUIRED');
 f.completed.candidate.previewCounterProof={receipt:{complete:true}};
 await expect(f.capture()).rejects.toThrow('PREVIEW_COUNTER_UNPROVED_ROW');
});

function terminalInput(f:ReturnType<typeof fixture>){const kernel={hasDeletionTombstone:async()=>true,requireStorageParticipantErasureComplete:async()=>{}};
 return {stores:f.stores,sourceId:'synthetic-p11-restore',sourceNamespace:'synthetic-p11-restore',participantId:'participant:4aa335fb-32cd-452e-91b9-73e818a3cf81',kernels:{reference:kernel,candidate:kernel},preparationEvidence:{native:true}};
}
it('creates a separate six-store restore startup retaining all four preterminal stores and only authentic terminal ledgers',async()=>{
 const f=fixture(),base=await f.capture();for(const lane of laneNames){f.tableState.set(f.stores[lane].source,3);f.tableState.set(f.stores[lane].target,4);f.tableState.set(f.stores[lane].ledger,2);}
 const derived=await captureFunctionalTerminalLedgerBase(base,terminalInput(f));expect(f.captures).toBe(16);
 expect(derived.receipt).toMatchObject({schemaVersion:'analytics-terminal-ledger-six-store-base-v1',physicalStores:6});expect(JSON.stringify(derived)).not.toContain('synthetic-private-transfer');
 for(const key of ['reference.source','reference.target','candidate.source','candidate.target'])expect((derived.receipt.captures as any)[key]).toEqual((base.receipt.captures as any)[key]);
 await startFunctionalBranch(derived,{scenario:'restore',stores:f.stores,resetLaboratory:f.reset},async()=>{
  for(const lane of laneNames){expect(f.tableState.get(f.stores[lane].source)).toBe(1);expect(f.tableState.get(f.stores[lane].target)).toBe(1);expect(f.tableState.get(f.stores[lane].ledger)).toBe(2);}
  await expect(captureFunctionalTerminalLedgerBase(base,terminalInput(f))).rejects.toThrow('ACTIVE_BRANCH');return {outcome:'complete',completed:f.completed};
 });
 await startFunctionalBranch(base,{scenario:'independent',stores:f.stores,resetLaboratory:f.reset},async()=>{for(const db of f.tableState.keys())expect(f.tableState.get(db)).toBe(1);return {outcome:'complete',completed:f.completed};});
});
it('rejects fabricated bases, missing tombstones, incomplete erasure, unchanged ledger or snapshot drift',async()=>{
 const f=fixture();await expect(captureFunctionalTerminalLedgerBase({receipt:{}},terminalInput(f))).rejects.toThrow('UNVERIFIED_BASE');
 for(const invalid of ['tombstone','completion','unchanged','drift']){const g=fixture(),base=await g.capture(),input=terminalInput(g);for(const lane of laneNames)g.tableState.set(g.stores[lane].ledger,2);
  if(invalid==='tombstone')input.kernels.reference.hasDeletionTombstone=async()=>false;
  if(invalid==='completion')input.kernels.reference.requireStorageParticipantErasureComplete=async()=>{throw Error('NATIVE_NOT_COMPLETE');};
  if(invalid==='unchanged')g.tableState.set(g.stores.reference.ledger,1);
  if(invalid==='drift'){const original=g.io.capture;g.io.capture=async(...args)=>{const r=await original(...args);g.tableState.set(g.stores.reference.ledger,3);return r;};}
  await expect(captureFunctionalTerminalLedgerBase(base,input)).rejects.toThrow();
 }
});

it('holds the six-store startup lock for the full asynchronous terminal ledger capture',async()=>{
 const f=fixture(),base=await f.capture();for(const lane of laneNames)f.tableState.set(f.stores[lane].ledger,2);
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;}),original=f.io.capture;
 f.io.capture=async(...args)=>{entered();await gate;return original(...args);};
 const pending=captureFunctionalTerminalLedgerBase(base,terminalInput(f));await ready;
 await expect(startFunctionalBranch(base,{scenario:'overlap',stores:f.stores,resetLaboratory:f.reset},async()=>({outcome:'complete',completed:f.completed}))).rejects.toThrow('ACTIVE_BRANCH');expect(f.resets).toBe(0);
 release();await pending;await startFunctionalBranch(base,{scenario:'after',stores:f.stores,resetLaboratory:f.reset},async()=>({outcome:'complete',completed:f.completed}));expect(f.resets).toBe(1);
});
