import {expect} from 'vitest';
import {createWholeWorkloadMeter,summarizeWholeWorkload} from './analytics-whole-workload';
import {assertNativePreviewCounterPair,type NativePreviewCounterProof} from './analytics-preview-counter';
import {canonicalJson} from '../../src/canonical-json';
import {sha256Hex} from '../../src/crypto';
import {captureAcceptedSourceTransfer,importAcceptedSourceTransfer,type AcceptedSourceTransfer} from './analytics-source-snapshot';

export const FUNCTIONAL_BASE_SCHEMA='analytics-completed-six-store-base-v1';
export const FUNCTIONAL_FAMILIES=['daily','publishedDaily','ownerModels','currentScalar','modelPublications','preview','cacheDays','cacheSeries'] as const;
export type FunctionalLane='reference'|'candidate';
export type FunctionalStore='source'|'target'|'ledger';
export type FunctionalStores=Record<FunctionalLane,Record<FunctionalStore,D1Database>>;
export interface FunctionalScenarioContext extends FunctionalStores {analyticalNowMs:number;now:()=>number;}
export interface CompletedFunctionalLane {
 output:Record<typeof FUNCTIONAL_FAMILIES[number],unknown>;
 actualStoredPopulation:Record<string,unknown>|null;
 publicationRows?:unknown;
 previewCounterProof?:NativePreviewCounterProof|null;
}
export type CompletedFunctionalPair=Record<FunctionalLane,CompletedFunctionalLane>;
export type FunctionalScenarioOutcome={outcome:'complete';completed:CompletedFunctionalPair}
 |{outcome:'refused'|'terminal';reference:unknown;candidate:unknown};
export interface FunctionalSnapshotIO {
 capture:typeof captureAcceptedSourceTransfer;
 import:typeof importAcceptedSourceTransfer;
}
const lanes=['reference','candidate'] as const,stores=['source','target','ledger'] as const;
const defaultIO:FunctionalSnapshotIO={capture:captureAcceptedSourceTransfer,import:importAcceptedSourceTransfer};
const hex=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{64}$/u.test(value);
const validClock=(value:number)=>Number.isSafeInteger(value)&&value>=0&&Number.isFinite(new Date(value).getTime());
const fail=(code:string):never=>{throw Error('FUNCTIONAL_BASE_'+code);};
const snapshotHandles=(value:FunctionalStores):FunctionalStores=>Object.freeze({reference:Object.freeze({...value.reference}),candidate:Object.freeze({...value.candidate})});
const handles=(value:FunctionalStores)=>lanes.flatMap(lane=>stores.map(side=>value[lane][side]));
function assertIndependent(value:FunctionalStores){if(new Set(handles(value)).size!==6)fail('SIX_INDEPENDENT_STORES_REQUIRED');}
const populationCounts=['graphResults','modelOwnerResults','modelDates','calculatedModelDates','calculatedModelOwnerResults','retiredCalculationDates','currentFitOwners','modelPublicationDates','requestedDailyDates','cacheOwnerDaysCompared'] as const;
export function assertFunctionalPublicationPair(reference:CompletedFunctionalLane,candidate:CompletedFunctionalLane){
 if(reference.previewCounterProof||candidate.previewCounterProof){
  if(!reference.previewCounterProof||!candidate.previewCounterProof)fail('PREVIEW_COUNTER_PROOF_REQUIRED');
  const rows=(value:unknown)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='modelRows,previewRow')fail('PUBLICATION_ROW_SCHEMA');
   const result=value as {modelRows:unknown;previewRow:Record<string,unknown>};if(!Array.isArray(result.modelRows)||!result.previewRow||typeof result.previewRow!=='object')fail('PUBLICATION_ROW_SCHEMA');return result;};
  const referenceProof=reference.previewCounterProof!,candidateProof=candidate.previewCounterProof!;
  const left=rows(reference.publicationRows),right=rows(candidate.publicationRows);expect(right.modelRows).toEqual(left.modelRows);
  assertNativePreviewCounterPair({row:left.previewRow,proof:referenceProof},{row:right.previewRow,proof:candidateProof});
 }else expect(candidate.publicationRows).toEqual(reference.publicationRows);
}
async function completedProof(completed:CompletedFunctionalPair){
 const proof:Record<string,unknown>={};
 for(const lane of lanes){
  const {output,actualStoredPopulation}=completed[lane];
  if(!actualStoredPopulation)throw Error('FUNCTIONAL_BASE_INCOMPLETE_OUTPUT');
  if(!output||Object.keys(output).sort().join(',')!==[...FUNCTIONAL_FAMILIES].sort().join(',')
    ||actualStoredPopulation.checkedAfterCleanup!==true)fail('INCOMPLETE_OUTPUT');
  for(const family of ['daily','publishedDaily','ownerModels','currentScalar','modelPublications','cacheDays'] as const)
   if(!Array.isArray(output[family])||(output[family] as unknown[]).length===0)fail('INCOMPLETE_OUTPUT');
  if(output.preview===null||output.preview===undefined||output.cacheSeries===null||output.cacheSeries===undefined)fail('INCOMPLETE_OUTPUT');
  if(populationCounts.some(key=>!Number.isSafeInteger(actualStoredPopulation[key])||Number(actualStoredPopulation[key])<0)
    ||!hex(actualStoredPopulation.graphInventorySha256)||actualStoredPopulation.calculatedModelOwnerResults!==(output.ownerModels as unknown[]).length
    ||actualStoredPopulation.cacheOwnerDaysCompared!==(output.cacheDays as unknown[]).length||actualStoredPopulation.requestedDailyDates!==(output.daily as unknown[]).length
    ||!Array.isArray(actualStoredPopulation.dailyPublicationInventory)||actualStoredPopulation.dailyPublicationInventory.length!==(output.publishedDaily as unknown[]).length)fail('INCOMPLETE_INVENTORY');
  proof[lane]={outputSha256:await sha256Hex(canonicalJson(output)),
   familySha256:Object.fromEntries(await Promise.all(FUNCTIONAL_FAMILIES.map(async family=>[family,await sha256Hex(canonicalJson(output[family]))]))),
   ...(completed[lane].publicationRows?{publicationRowsSha256:await sha256Hex(canonicalJson(completed[lane].publicationRows)),
    ...(completed[lane].previewCounterProof?{modelRowsSha256:await sha256Hex(canonicalJson((completed[lane].publicationRows as {modelRows:unknown}).modelRows)),
     previewRowSha256:await sha256Hex(canonicalJson((completed[lane].publicationRows as {previewRow:unknown}).previewRow)),previewCounterProof:completed[lane].previewCounterProof!.receipt}: {})}:{}),
   inventorySha256:await sha256Hex(canonicalJson(actualStoredPopulation)),inventory:{checkedAfterCleanup:true,graphInventorySha256:actualStoredPopulation.graphInventorySha256,
    ...Object.fromEntries(populationCounts.map(key=>[key,actualStoredPopulation[key]])),
    dailyPublicationInventorySha256:await sha256Hex(canonicalJson(actualStoredPopulation.dailyPublicationInventory))}};
 }
 // Keep the same exact DTO comparator as the all-family workload; hashes alone
 // do not erase undefined properties, negative zero, or a changed native value.
 expect(completed.candidate.output).toEqual(completed.reference.output);
 expect(completed.candidate.actualStoredPopulation).toEqual(completed.reference.actualStoredPopulation);
 assertFunctionalPublicationPair(completed.reference,completed.candidate);
 return proof;
}
export interface CompletedFunctionalBase {readonly receipt:Readonly<Record<string,unknown>>;}
interface PrivateBase {transfers:Record<FunctionalLane,Record<FunctionalStore,AcceptedSourceTransfer>>;analyticalNowMs:number;io:FunctionalSnapshotIO;active:boolean;}
const privateBases=new WeakMap<CompletedFunctionalBase,PrivateBase>();
const activeHandles=new WeakSet<D1Database>();
/** Captures synthetic laboratory data in private memory. No raw transfer is
 * exposed by the handle or its receipt; this is not a production restore. */
export async function captureCompletedFunctionalBase(input:{stores:FunctionalStores;analyticalNowMs:number;
 completed:CompletedFunctionalPair;inputSha256:Record<FunctionalLane,string>},io:FunctionalSnapshotIO=defaultIO):Promise<CompletedFunctionalBase>{
 const physical=snapshotHandles(input.stores);assertIndependent(physical);
 if(!validClock(input.analyticalNowMs)||lanes.some(lane=>!hex(input.inputSha256[lane])))fail('CLOCK_OR_INPUT_PIN');
 if(handles(physical).some(db=>activeHandles.has(db)))fail('ACTIVE_BRANCH');
 const completed=await completedProof(input.completed),transfers={} as PrivateBase['transfers'];
 const captures:Record<string,unknown>={};let totalLogicalBytes=0;
 for(const lane of lanes){transfers[lane]={} as PrivateBase['transfers'][FunctionalLane];
  for(const side of stores){
   const value=await io.capture(physical[lane][side],side),transfer=value.transfer;
   if(![transfer.proof.sqlSha256,transfer.proof.schemaSha256,transfer.proof.rowidInventorySha256].every(hex))fail('TRANSFER_PIN');
   totalLogicalBytes+=transfer.proof.exportedLogicalSqlBytes;
   if(!Number.isSafeInteger(totalLogicalBytes)||totalLogicalBytes<0||totalLogicalBytes>256*1024*1024)fail('TOTAL_TRANSFER_BOUND');
   transfers[lane][side]=structuredClone(transfer);
   captures[lane+'.'+side]={proof:structuredClone(transfer.proof),profile:value.profile,wallMs:value.wallMs,
    exportWallMs:value.exportWallMs,exportResourceMetadata:value.exportResourceMetadata,physicalSnapshotBytes:value.physicalSnapshotBytes};
  }
 }
 const finalCapture:Record<string,unknown>={};
 for(const lane of lanes)for(const side of stores){
  const current=await io.capture(physical[lane][side],side);
  if(canonicalJson(current.transfer.proof)!==canonicalJson(transfers[lane][side].proof))fail('BASE_CHANGED_DURING_CAPTURE');
  finalCapture[lane+'.'+side]={proof:current.transfer.proof,profile:current.profile,wallMs:current.wallMs,
   exportWallMs:current.exportWallMs,exportResourceMetadata:current.exportResourceMetadata,physicalSnapshotBytes:current.physicalSnapshotBytes};
 }
 const base:CompletedFunctionalBase={receipt:Object.freeze({schemaVersion:FUNCTIONAL_BASE_SCHEMA,analyticalNowMs:input.analyticalNowMs,
  inputSha256:{...input.inputSha256},completed,captures,finalCapture,totalLogicalBytes,physicalStores:6,
  contract:'Exact separate source/target/ledger startup snapshots with typed rows and rowids. Export CPU/read/physical-copy metadata remains unavailable. No midscenario restore, production restore, or performance qualification.'})};
 privateBases.set(base,{transfers,analyticalNowMs:input.analyticalNowMs,io,active:false});return base;
}
/** The callback owns one retained scenario. All six imports happen before it;
 * recursion/overlap is refused and no import/reset capability reaches it. */
export async function startFunctionalBranch<T extends FunctionalScenarioOutcome>(base:CompletedFunctionalBase,input:{scenario:string;
 stores:FunctionalStores;resetLaboratory:()=>Promise<void>;analyticalNowMs?:number;
 recordIncomplete?:(receipt:Record<string,unknown>)=>void},run:(context:FunctionalScenarioContext)=>Promise<T>){
 const state=privateBases.get(base);if(!state)throw Error('FUNCTIONAL_BASE_UNVERIFIED_BASE');
 if(!/^[a-z][a-z0-9_]{0,63}$/u.test(input.scenario))fail('SCENARIO_NAME');
 const physical=snapshotHandles(input.stores);assertIndependent(physical);const dbs=handles(physical),analyticalNowMs=input.analyticalNowMs??state.analyticalNowMs;
 if(!validClock(analyticalNowMs))fail('CLOCK');
 if(state.active||dbs.some(db=>activeHandles.has(db)))fail('ACTIVE_BRANCH');
 state.active=true;for(const db of dbs)activeHandles.add(db);
 const imports:Record<string,unknown>={};let boundary='startup_reset',resetWallMs:number|null=null;
 try{
  const resetStarted=performance.now();await input.resetLaboratory();resetWallMs=performance.now()-resetStarted;
  for(const lane of lanes)for(const side of stores){
   boundary='startup_import_'+lane+'_'+side;
   // importAcceptedSourceTransfer refuses nonempty stores and verifies exact
   // SQL/schema/typed-row/rowid hashes before any scenario code can execute.
   const result=await state.io.import(state.transfers[lane][side],physical[lane][side],side);
   if(result.exactSchemaAndData!==true||result.exactRowids!==true
    ||canonicalJson(result.proof)!==canonicalJson(state.transfers[lane][side].proof))fail('IMPORT_PROOF');
   imports[lane+'.'+side]=result;
  }
  boundary='scenario';
  const result=await run(Object.freeze({...physical,analyticalNowMs,now:Date.now}));
  let completion:Record<string,unknown>|null=null;
  if(result.outcome==='complete')completion=await completedProof(result.completed);
  else if(result.outcome==='refused'||result.outcome==='terminal')expect(result.candidate).toEqual(result.reference);
  else fail('OUTCOME');
  return {result,receipt:{schemaVersion:'analytics-retained-functional-branch-v1',scenario:input.scenario,
   analyticalNowMs,baseAnalyticalNowMs:state.analyticalNowMs,baseInputSha256:base.receipt.inputSha256,
   physicalStores:6,imports,resetWallMs,resetResourceMetadata:null,resetCountBeforeScenario:1,importsBeforeScenario:6,postStartImports:0,postStartResets:0,
   outcome:result.outcome,completion,nonCompleteOutcomeQualification:result.outcome==='complete'?null:'Requires the owning exact refusal or terminal proof; never counted as completed publication.',
   comparativeHeapQualification:false,freshIsolateMutationQualification:false}};
 }catch(error){input.recordIncomplete?.({schemaVersion:'analytics-retained-functional-branch-incomplete-v1',scenario:input.scenario,
   complete:false,boundary,imports,incompleteBoundaryResourceMetadata:null,postStartImports:0,postStartResets:0});throw error;
 }finally{state.active=false;for(const db of dbs)activeHandles.delete(db);}
}

/** Exact expected source population; this does not filter or synthesize owners. */
export function assertFunctionalExpectedOwners(actual:readonly string[],expected:readonly string[]|undefined):void {
 if(expected===undefined){expect(actual).toHaveLength(2);return;}
 if(expected.length<1||expected.length>64||expected.some(value=>!hex(value))||new Set(expected).size!==expected.length)fail('EXPECTED_OWNERS');
 expect([...actual].sort()).toEqual([...expected].sort());
}
/** A changed logical calendar shifts the complete request/cache window, while
 * stored older publications remain visible to the collector's inventory. */
export function planFunctionalBranchPopulation(input:{baseAnalyticalNowMs:number;analyticalNowMs:number;requestedDates:readonly string[];cacheDates:readonly string[]}) {
 if(!validClock(input.baseAnalyticalNowMs)||!validClock(input.analyticalNowMs))fail('CLOCK');
 const dayMs=86_400_000,utc=(ms:number)=>new Date(ms).toISOString().slice(0,10);
 const shift=Math.floor(input.analyticalNowMs/dayMs)-Math.floor(input.baseAnalyticalNowMs/dayMs);
 if(shift<0||shift>366)fail('CALENDAR_SHIFT');
 const move=(values:readonly string[])=>{
  if(values.length<1||values.length>466||new Set(values).size!==values.length||values.some((day,i)=>
   !/^\d{4}-\d{2}-\d{2}$/u.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00.000Z'))||utc(Date.parse(day+'T00:00:00.000Z'))!==day||i>0&&values[i-1]!>=day))fail('CALENDAR_POPULATION');
  return values.map(day=>utc(Date.parse(day+'T00:00:00.000Z')+shift*dayMs));
 };
 return {calendarShiftDays:shift,requestedDates:move(input.requestedDates),cacheDates:move(input.cacheDates)};
}

/** A separate restore STARTUP combines the proved preterminal four stores with
 * independently captured authentic post-erasure ledgers. It never imports a
 * replacement source/target inside an active scenario. */
export async function captureFunctionalTerminalLedgerBase(base:CompletedFunctionalBase,input:{stores:FunctionalStores;
 sourceId:string;sourceNamespace:string;participantId:string;kernels:Record<FunctionalLane,Pick<typeof import('./analytics-workload-kernels'),
 'hasDeletionTombstone'|'requireStorageParticipantErasureComplete'>>;preparationEvidence:unknown}):Promise<CompletedFunctionalBase>{
 const state=privateBases.get(base);if(!state)fail('UNVERIFIED_BASE');const verified=state!;
 const physical=snapshotHandles(input.stores);assertIndependent(physical);
 if(verified.active||handles(physical).some(db=>activeHandles.has(db)))fail('ACTIVE_BRANCH');
 if(!/^synthetic-p11-[A-Za-z0-9:_-]{1,110}$/u.test(input.sourceId)||input.sourceId!==input.sourceNamespace
  ||!/^participant:[0-9a-f-]{36}$/u.test(input.participantId))fail('TERMINAL_SCOPE');
 verified.active=true;for(const db of handles(physical))activeHandles.add(db);
 try{
 const transfers=structuredClone(verified.transfers),captures={...(base.receipt.captures as Record<string,unknown>)},
  finalCapture={...(base.receipt.finalCapture as Record<string,unknown>)},terminalProof:Record<string,unknown>={};
 for(const lane of lanes){
  const measured=createWholeWorkloadMeter(physical[lane].source,physical[lane].target,undefined,undefined,physical[lane].ledger);
  await measured.invocation('restore_terminal_ledger_witness',async(db,_meter,ledger)=>{
   if(!ledger)fail('TERMINAL_LEDGER');
   expect(await input.kernels[lane].hasDeletionTombstone(ledger!,input.participantId)).toBe(true);
   await input.kernels[lane].requireStorageParticipantErasureComplete(ledger!,input.participantId,{...db,ledger:ledger!,sourceId:input.sourceId,sourceNamespace:input.sourceNamespace});
   expect(await db.source.prepare('SELECT count(*) n FROM participants WHERE id=?').bind(input.participantId).first<number>('n')).toBe(0);
  });
  terminalProof[lane]={nativeCompletion:true,tombstone:true,participantRows:0,cost:summarizeWholeWorkload(measured.profile)};
  const first=await verified.io.capture(physical[lane].ledger,'ledger'),last=await verified.io.capture(physical[lane].ledger,'ledger');
  if(canonicalJson(first.transfer.proof)!==canonicalJson(last.transfer.proof))fail('TERMINAL_LEDGER_CAPTURE_DRIFT');
  if(canonicalJson(first.transfer.proof)===canonicalJson(verified.transfers[lane].ledger.proof))fail('TERMINAL_LEDGER_UNCHANGED');
  transfers[lane].ledger=structuredClone(first.transfer);
  const capture=(value:typeof first)=>({proof:value.transfer.proof,profile:value.profile,wallMs:value.wallMs,
   exportWallMs:value.exportWallMs,exportResourceMetadata:value.exportResourceMetadata,physicalSnapshotBytes:value.physicalSnapshotBytes});
  captures[lane+'.ledger']=capture(first);finalCapture[lane+'.ledger']=capture(last);
 }
 const totalLogicalBytes=lanes.flatMap(lane=>stores.map(side=>transfers[lane][side].proof.exportedLogicalSqlBytes)).reduce((sum,n)=>sum+n,0);
 if(!Number.isSafeInteger(totalLogicalBytes)||totalLogicalBytes>256*1024*1024)fail('TOTAL_TRANSFER_BOUND');
 const result:CompletedFunctionalBase={receipt:Object.freeze({...base.receipt,schemaVersion:'analytics-terminal-ledger-six-store-base-v1',
  captures,finalCapture,totalLogicalBytes,terminalParticipantSha256:await sha256Hex(input.participantId),terminalProof,
  preparationEvidence:input.preparationEvidence,preterminalBaseSha256:await sha256Hex(canonicalJson(base.receipt)),
  contract:'Separate local restore startup: exact preterminal source+target transfers and authentic post-erasure ledger transfers, all six imported before replay. Never a midscenario reset or production restore claim.'})};
 privateBases.set(result,{transfers,analyticalNowMs:verified.analyticalNowMs,io:verified.io,active:false});return result;
 }finally{verified.active=false;for(const db of handles(physical))activeHandles.delete(db);}
}
