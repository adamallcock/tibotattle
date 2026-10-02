import {sha256Hex} from '../../src/crypto';
import type {AnalyticsProfile,AnalyticsProfileCost,AnalyticsProfileMethod,AnalyticsProfileSide,
  AnalyticsStatementObservation,AnalyticsStatementObserver} from './analytics-profile';
import {WHOLE_WORKLOAD_CASES,WHOLE_WORKLOAD_PHASES} from './analytics-whole-workload';

const METHODS=['first','all','run','raw','batch'] as const;
const SIDES=['source','target','ledger'] as const;
const FAMILIES=['canonical','dependency_summary','mutation_metadata','preparation','shared_feature','model_block',
  'checkpoint','prepared_graph_day','graph_result','daily_result','cache_retention','dependency_links','correction',
  'v12_usage','v12_quota','v12_session','v12_other','typed_usage','typed_quota','typed_session','typed_other','owner_fence','other'] as const;
const COST_FIELDS=['statements','failedStatements','rowsRead','rowsWritten','databaseMs','statementCallWallMs',
  'allocatedBatchWallMs','metadataSamples','serializedBoundBytesSubmitted','serializedResultBytesRead'] as const;
type CostField=typeof COST_FIELDS[number];
type Cost=Pick<AnalyticsProfileCost,CostField>;
const emptyCost=():Cost=>Object.fromEntries(COST_FIELDS.map(field=>[field,0])) as Cost;
const validNumber=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;
const sideCosts=()=>Object.fromEntries(SIDES.map(side=>[side,emptyCost()])) as Record<AnalyticsProfileSide,Cost>;
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
function costOf(row:AnalyticsStatementObservation):Cost {
 return {statements:1,failedStatements:row.outcome==='failed'?1:0,rowsRead:row.rowsRead??0,rowsWritten:row.rowsWritten??0,
  databaseMs:row.databaseMs??0,statementCallWallMs:row.batchWallAllocation?0:row.callWallMs,
  allocatedBatchWallMs:row.batchWallAllocation?row.callWallMs:0,metadataSamples:row.outcome==='success'?1:0,
  serializedBoundBytesSubmitted:row.boundLogicalBytes,serializedResultBytesRead:row.resultLogicalBytes??0};
}
function addCost(target:Cost,delta:Cost,onOverflow:()=>void) {
 for(const field of COST_FIELDS){const next=target[field]+delta[field];if(!validNumber(next))onOverflow();else target[field]=next;}
}
function sameCost(left:Cost,right:Cost):boolean {
 return COST_FIELDS.every(field=>['databaseMs','statementCallWallMs','allocatedBatchWallMs'].includes(field)
  ?Math.abs(left[field]-right[field])<=0.001:left[field]===right[field]);
}
const normalizedSql=(sql:string)=>sql.replace(/\s+/gu,' ').trim().replace(/\b\d{10,}\b/gu,'<epoch>');

/** Full performance shape costs, not source-table lineage. No result, binding,
 * error or per-call records are retained. Hashing happens only at report time. */
export function createAnalyticsPerformanceHistogram(input:{lane:'candidate'|'reference';workloadPhase:string}) {
 if(!['candidate','reference'].includes(input.lane)||!WHOLE_WORKLOAD_CASES.includes(input.workloadPhase))
  throw new Error('invalid performance histogram scope');
 type Entry={operation:string;side:AnalyticsProfileSide;family:string;sql:string;cost:Cost;
  methods:Record<AnalyticsProfileMethod,number>;invalidMetadataStatements:number};
 const entries=new Map<string,Entry>();
 const gaps={overflowStatements:0,unknownObservations:0,observerFailures:0,invalidMetadataStatements:0,
  failedResourceUnknownStatements:0,numericOverflows:0};
 let observedStatements=0;
 const overflow=()=>{gaps.numericOverflows++;};
 const observe:AnalyticsStatementObserver=row=>{
  observedStatements++;
  if(!WHOLE_WORKLOAD_PHASES.includes(row.phase)||!SIDES.includes(row.side)||!FAMILIES.includes(row.family as typeof FAMILIES[number])
   ||!METHODS.includes(row.method)||!['success','failed','invalid_metadata'].includes(row.outcome)||typeof row.sql!=='string'
   ||![row.callWallMs,row.boundLogicalBytes].every(validNumber)
   ||![row.rowsRead,row.rowsWritten,row.databaseMs,row.resultLogicalBytes].every(value=>value===null||validNumber(value))
   ||row.outcome==='success'&&[row.rowsRead,row.rowsWritten,row.databaseMs,row.resultLogicalBytes].some(value=>value===null)
   ||row.outcome!=='success'&&[row.rowsRead,row.rowsWritten,row.databaseMs].some(value=>value!==null)){
   gaps.unknownObservations++;return;
  }
  if(row.outcome==='failed')gaps.failedResourceUnknownStatements++;
  if(row.outcome==='invalid_metadata')gaps.invalidMetadataStatements++;
  const sql=normalizedSql(row.sql),key=JSON.stringify([row.phase,row.side,row.family,sql]);
  let entry=entries.get(key);
  if(!entry){
   if(entries.size>=4096){gaps.overflowStatements++;return;}
   entry={operation:row.phase,side:row.side,family:row.family,sql,cost:emptyCost(),
    methods:{first:0,all:0,run:0,raw:0,batch:0},invalidMetadataStatements:0};entries.set(key,entry);
  }
  entry.methods[row.method]++;if(row.outcome==='invalid_metadata')entry.invalidMetadataStatements++;
  addCost(entry.cost,costOf(row),overflow);
 };
 return {observe,async report(profile:AnalyticsProfile){
  let reconciliationNumericOverflows=0;const aggregateOverflow=()=>{reconciliationNumericOverflows++;};
  const actual=new Map<string,Cost>(),total=emptyCost(),expected=emptyCost();
  for(const entry of entries.values()){
   const key=entry.operation+'.'+entry.side+'.'+entry.family;
   let cost=actual.get(key);if(!cost){cost=emptyCost();actual.set(key,cost);}
   addCost(cost,entry.cost,aggregateOverflow);addCost(total,entry.cost,aggregateOverflow);
  }
  for(const cost of Object.values(profile.costs))addCost(expected,cost,aggregateOverflow);
  const keys=new Set([...actual.keys(),...Object.keys(profile.costs)]);
  let mismatchedCostBuckets=0;
  for(const key of keys)if(!sameCost(actual.get(key)??emptyCost(),profile.costs[key]??emptyCost()))mismatchedCostBuckets++;
  const observerFailures=profile.statementObserverFailures??0;
  const matches=mismatchedCostBuckets===0&&sameCost(total,expected)&&observedStatements===expected.statements;
  const complete=matches&&observerFailures===0&&profile.measurementFailures===0
   &&gaps.overflowStatements===0&&gaps.unknownObservations===0&&gaps.invalidMetadataStatements===0&&gaps.numericOverflows===0&&reconciliationNumericOverflows===0;
  const rows=await Promise.all([...entries.values()].map(async entry=>({operation:entry.operation,side:entry.side,
   family:entry.family,fingerprint:await sha256Hex(entry.sql),methods:{...entry.methods},...entry.cost,
   successfulStatements:entry.cost.statements-entry.cost.failedStatements-entry.invalidMetadataStatements,
   invalidMetadataStatements:entry.invalidMetadataStatements,
   resourceDimensionsKnown:entry.cost.failedStatements===0&&entry.invalidMetadataStatements===0})));
  rows.sort((a,b)=>a.operation.localeCompare(b.operation)||a.side.localeCompare(b.side)||a.family.localeCompare(b.family)||a.fingerprint.localeCompare(b.fingerprint));
  return {contract:'analytics-sql-performance-histogram-v1',lane:input.lane,workloadPhase:input.workloadPhase,maximumEntries:4096,entryCount:entries.size,
   completeForMeteredStatements:complete,resourceDimensionsComplete:complete&&gaps.failedResourceUnknownStatements===0,
   observedStatements,expectedMeteredStatements:expected.statements,retainedStatementTotals:total,
   gaps:{...gaps,observerFailures,reconciliationNumericOverflows},reconciliation:{matches,mismatchedCostBuckets,timingToleranceMs:0.001},entries:rows,
   noRescanQualified:false,
   coverageContract:'Costs from the existing reconciled main profile only; no general D1 API, session, alias, view, trigger or physical-lineage qualification. Failed batch members are submitted attempts; executed members and failed resources are unknown. Null resource dimensions contribute no known amount and remain explicit gaps.',
   retentionContract:'At most4096 operation/side/family/normalized-SQL entries; method counters within each entry. No binds, rows, errors or per-call history. Independent of the existing4096-entry direct-history diagnostic. Whitespace/long-epoch normalization is a performance grouping, not exact SQL provenance.'};
 }};
}

const ROLES=['analytics','cache','publication'] as const;
export type AnalyticsObservedRole=typeof ROLES[number];
const STATES=['idle','progress','deferred','unavailable','complete','failed','disabled'] as const;
const REASONS=['complete','source_prefix_pending','work_pending','coverage_pending','source_migration_required',
 'query_budget','deadline','execution_failed','restore_pending','runtime_migration_required','target_migration_required',
 'step_limit','capacity','format_boundary','not_admitted','lane_failure','day_limit','write_limit','source_changed',
 'disabled','paused','caught_up','publication_disabled','nothing_to_do','initializing','not_ready'] as const;
/** One entry per closed outcome, not per pass/day/owner. Costs are the whole
 * role invocation, never attributed to just the canonical prepass. */
export function createAnalyticsRoleOutcomeHistogram() {
 type Active={role:AnalyticsObservedRole;costs:ReturnType<typeof sideCosts>;started:number;observerFailuresBefore:number};
 type Entry={role:AnalyticsObservedRole;state:string;reason:string;canonicalState:string;canonicalReason:string;
  canonicalClaims:'zero'|'positive'|'not_applicable'|'unknown';publishedDays:'zero'|'positive'|'not_applicable'|'unknown';
  threw:boolean;invocations:number;wallMs:number;costs:ReturnType<typeof sideCosts>};
 const entries=new Map<string,Entry>();
 const gaps={overflowInvocations:0,unbalancedScopes:0,unknownFields:0,missingScheduleEvents:0,multipleScheduleEvents:0,
  observerFailures:0,numericOverflows:0,invalidMetadataStatements:0,failedResourceUnknownStatements:0};
 let active:Active|null=null,invocations=0;
 const incOverflow=()=>{gaps.numericOverflows++;};
 const classification=(value:unknown,allowed:readonly string[],missing='unknown')=>{
  if(value===undefined){if(missing==='unknown')gaps.unknownFields++;return missing;}
  if(typeof value==='string'&&allowed.includes(value))return value;gaps.unknownFields++;return 'unknown';
 };
 const zero=(value:unknown,missing:'unknown'|'not_applicable')=>{
  if(value===undefined&&missing==='not_applicable')return missing;
  if(Number.isSafeInteger(value)&&Number(value)>=0)return value===0?'zero' as const:'positive' as const;
  gaps.unknownFields++;return 'unknown' as const;
 };
 return {
  begin(role:AnalyticsObservedRole,profile:AnalyticsProfile){
   if(!ROLES.includes(role)){gaps.unknownFields++;return;}
   if(active){gaps.unbalancedScopes++;return;}
   active={role,costs:sideCosts(),started:performance.now(),observerFailuresBefore:profile.statementObserverFailures??0};
  },
  observe(row:AnalyticsStatementObservation){
   if(!active)return;
   if(row.phase!==active.role+'_role'||!SIDES.includes(row.side)){gaps.unknownFields++;return;}
   if(row.outcome==='invalid_metadata')gaps.invalidMetadataStatements++;
   if(row.outcome==='failed')gaps.failedResourceUnknownStatements++;
   addCost(active.costs[row.side],costOf(row),incOverflow);
  },
  end(input:{role:AnalyticsObservedRole;event:unknown;eventCount:number;threw:boolean;profile:AnalyticsProfile}){
   const scope=active;active=null;
   if(!scope||scope.role!==input.role){gaps.unbalancedScopes++;return;}
   invocations++;
   if(typeof input.threw!=='boolean'||!Number.isSafeInteger(input.eventCount)||input.eventCount<0){gaps.unknownFields++;return;}
   if(input.eventCount===0)gaps.missingScheduleEvents++;
   if(input.eventCount>1)gaps.multipleScheduleEvents++;
   gaps.observerFailures+=Math.max(0,(input.profile.statementObserverFailures??0)-scope.observerFailuresBefore);
   const event=object(input.event),canonical=object(event?.canonicalWork)
    ??(scope.role==='cache'&&event&&Object.hasOwn(event,'claimed')?event:null);
   const keyFields={role:scope.role,state:classification(event?.state,STATES),reason:classification(event?.reason,REASONS,'not_reported'),
    canonicalState:canonical?classification(canonical.state,STATES):'not_applicable',
    canonicalReason:canonical?classification(canonical.reason,REASONS):'not_applicable',
    canonicalClaims:canonical?zero(canonical.claimed,'unknown'):'not_applicable' as const,
    publishedDays:zero(event?.dailyPublications,scope.role==='publication'?'unknown':'not_applicable'),threw:input.threw};
   const key=JSON.stringify(keyFields);let entry=entries.get(key);
   if(!entry){if(entries.size>=256){gaps.overflowInvocations++;return;}entry={...keyFields,invocations:0,wallMs:0,costs:sideCosts()};entries.set(key,entry);}
   entry.invocations++;
   const wallMs=entry.wallMs+Math.max(0,performance.now()-scope.started);
   if(validNumber(wallMs))entry.wallMs=wallMs;else gaps.numericOverflows++;
   for(const side of SIDES)addCost(entry.costs[side],scope.costs[side],incOverflow);
  },
  report(profile:AnalyticsProfile){
   let mismatchedCostBuckets=0,reconciliationNumericOverflows=0;
   const aggregateOverflow=()=>{reconciliationNumericOverflows++;};
   for(const role of ROLES)for(const side of SIDES){
    const actual=emptyCost(),expected=emptyCost();
    for(const entry of entries.values())if(entry.role===role)addCost(actual,entry.costs[side],aggregateOverflow);
    for(const [key,cost] of Object.entries(profile.costs))if(key.startsWith(role+'_role.'+side+'.'))addCost(expected,cost,aggregateOverflow);
    if(!sameCost(actual,expected))mismatchedCostBuckets++;
   }
   const expectedInvocations=ROLES.reduce((sum,role)=>sum+(profile.operationInvocations[role+'_schedule']??0),0);
   const matches=expectedInvocations===invocations&&mismatchedCostBuckets===0;
   return {contract:'analytics-role-outcomes-v1',maximumEntries:256,invocations,expectedInvocations,
    completeForRoleInvocations:matches&&!active&&reconciliationNumericOverflows===0&&Object.values(gaps).every(value=>value===0),
    gaps:{...gaps,openScopes:active?1:0,reconciliationNumericOverflows},reconciliation:{matches,mismatchedCostBuckets,timingToleranceMs:0.001},
    entries:[...entries.values()].map(entry=>({...entry,costs:Object.fromEntries(SIDES.map(side=>[side,{...entry.costs[side]}]))})),
    contractNote:'Every role invocation, including thrown calls, by closed schedule outcome. Costs include setup, canonical prepass, native pass and remainder; they are not substage or all-daily-attempt attribution. Missing/error-only logs and unknown enum values stay gaps. No event bodies, identities or per-invocation records retained.',noRescanQualified:false};
  },
 };
}
