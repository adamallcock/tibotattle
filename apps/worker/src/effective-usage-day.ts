import {canonicalTelemetryV11Json,parseTelemetryV11Record} from '@app-usagemonitor/telemetry-contract';
import {GraphDayProjectionRefusedError,graphDayUsageSessionDigest,reduceGraphDayProjection,
  type GraphDayUsageInput} from './graph-day-projection';
import {graphDayUsageCellOrder,validGraphDayProjection,GRAPH_DAY_USAGE_CELL_LIMIT,
  GRAPH_DAY_USAGE_COST_CEILING,GRAPH_DAY_USAGE_SESSION_LIMIT,
  type GraphDayProjection,type GraphDayUsageCell} from './graph-day-projection-values';
import {v11PreparedUsageDayRow,type UsageRow} from './quota-analysis-v11';
import {MAX_WINDOWED_USAGE_ROWS} from './quota-analysis-v1';
import type {EffectiveTelemetryOccurrence} from './telemetry-usage-effective-reader';

export const EFFECTIVE_USAGE_DAY_MAX_BYTES=4*1024*1024;
export interface EffectiveUsageDay {projection:GraphDayProjection}
/** Compact day-local state only. Session identifiers are owner-scoped hashes;
 * no source record JSON or raw session identifier enters this checkpoint. */
export interface EffectiveUsageDayPending extends EffectiveUsageDay {lastObservedAtMs:number|null}
const fail=()=>new Error('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const closed=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>
  !!value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function usageProjection(value:unknown):value is GraphDayProjection {
  return validGraphDayProjection(value)&&value.planAnchors.anchors.length===0
    &&value.fitFragments.fragments.length===0&&value.runEndpoints.endpoints.length===0
    &&value.usage.rowsRead<=MAX_WINDOWED_USAGE_ROWS;
}
export function validEffectiveUsageDay(value:unknown):value is EffectiveUsageDay {
  return closed(value,['projection'])&&usageProjection(value.projection)
    &&bytes(value)<=EFFECTIVE_USAGE_DAY_MAX_BYTES;
}
export function validEffectiveUsageDayPending(value:unknown):value is EffectiveUsageDayPending {
  if(!closed(value,['projection','lastObservedAtMs'])||!usageProjection(value.projection)
    ||bytes(value)>EFFECTIVE_USAGE_DAY_MAX_BYTES)return false;
  const {projection,lastObservedAtMs}=value;
  if(projection.usage.rowsRead===0)return lastObservedAtMs===null;
  const start=Date.parse(`${projection.day}T00:00:00.000Z`);
  return typeof lastObservedAtMs==='number'&&Number.isSafeInteger(lastObservedAtMs)
    &&lastObservedAtMs>=start&&lastObservedAtMs<start+86_400_000
    &&projection.usage.sessions.every(session=>session.lastObservedAtMs<=lastObservedAtMs)
    &&projection.usage.openers.every(opener=>opener.observedAtMs<=lastObservedAtMs)
    &&projection.usage.cells.every(cell=>cell.binStartMs<=lastObservedAtMs);
}

/** Keep the effective pager's existing analytical v1.1 mapping unchanged. */
export function mapEffectiveUsagePageRow(row:EffectiveTelemetryOccurrence):UsageRow {
  if(row.stream!=='usage'||row.status!=='compatible'||row.recordJson===null||row.eventTime===null)throw fail();
  const value=parseTelemetryV11Record('usage',JSON.parse(row.recordJson));
  if(value.schemaVersion!=='usage-event-v1.1')throw fail();
  return {occurrence_id:value.eventId,observed_at:row.eventTime,provider:value.provider,
    session_uuid:value.sessionUuid,record_json:canonicalTelemetryV11Json(value)};
}

/** A page-local opener is an ordinary cell when this day already saw its
 * session. Resolve that one carry-in edge, then union cells and replace tails.
 * Reducing each page independently without this edge would invent an opener
 * on every page and lose account changes at the page boundary. */
export async function appendEffectiveUsageDay(pending:EffectiveUsageDayPending|null,day:string,
  rows:readonly UsageRow[],ownerDigest:string):Promise<EffectiveUsageDayPending|null> {
  if(pending!==null&&(!validEffectiveUsageDayPending(pending)||pending.projection.day!==day))throw fail();
  const prior=pending?.projection??reduceGraphDayProjection(day,[]);
  if(prior.usage.rowsRead+rows.length>MAX_WINDOWED_USAGE_ROWS)return null;
  const sessions=new Set(prior.usage.sessions.map(session=>session.sessionDigest));
  const events:GraphDayUsageInput[]=[];
  let last=pending?.lastObservedAtMs??null;
  for(const row of rows){
    const at=Date.parse(row.observed_at),start=Date.parse(`${day}T00:00:00.000Z`);
    if(!Number.isSafeInteger(at)||at<start||at>=start+86_400_000||last!==null&&at<last)throw fail();
    last=at;
    const mapped=await v11PreparedUsageDayRow(row,(provider,sessionUuid)=>
      graphDayUsageSessionDigest({ownerDigest,provider,sessionUuid}),sessions,GRAPH_DAY_USAGE_SESSION_LIMIT);
    if(mapped.status==='refused')return null;
    if(mapped.status==='row')events.push({...mapped.row,kind:mapped.row.model===null?'unpriced':'priced'});
    else if(mapped.session!==null)events.push({sessionDigest:mapped.session.sessionDigest,
      observedAtMs:mapped.session.observedAtMs,provider:row.provider,accountScopeId:mapped.session.accountScopeId,
      planBasis:null,planType:null,planEraId:null,kind:'unmeasurable',model:null,costNanousd:0});
  }
  let page:GraphDayProjection;
  try{page=reduceGraphDayProjection(day,[],{events,rowsRead:rows.length});}
  catch(error){if(error instanceof GraphDayProjectionRefusedError
    &&['usage_session_limit_exceeded','usage_cell_limit_exceeded','usage_cost_limit_exceeded'].includes(error.reason))return null;
    throw error;}
  const tails=new Map(prior.usage.sessions.map(session=>[session.sessionDigest,session]));
  const cells=new Map(prior.usage.cells.map(cell=>[graphDayUsageCellOrder(cell),{...cell}]));
  const openers=[...prior.usage.openers];
  const add=(cell:GraphDayUsageCell):boolean=>{
    const key=graphDayUsageCellOrder(cell),old=cells.get(key);
    const costNanousd=(old?.costNanousd??0)+cell.costNanousd,eventCount=(old?.eventCount??0)+cell.eventCount;
    if(!Number.isSafeInteger(costNanousd)||costNanousd>GRAPH_DAY_USAGE_COST_CEILING
      ||!Number.isSafeInteger(eventCount))return false;
    cells.set(key,{...cell,costNanousd,eventCount});
    return cells.size<=GRAPH_DAY_USAGE_CELL_LIMIT;
  };
  for(const cell of page.usage.cells)if(!add(cell))return null;
  for(const opener of page.usage.openers){
    const tail=tails.get(opener.sessionDigest);
    if(tail===undefined)openers.push(opener);
    else {const {sessionDigest:_,observedAtMs:__,...cell}=opener;
      if(!add({...cell,accountBreak:tail.lastAccountScopeId!==opener.accountScopeId,eventCount:1}))return null;}
  }
  for(const tail of page.usage.sessions)tails.set(tail.sessionDigest,tail);
  const rowsRead=prior.usage.rowsRead+rows.length;
  if(!Number.isSafeInteger(rowsRead)||tails.size>GRAPH_DAY_USAGE_SESSION_LIMIT)return null;
  const compare=(left:string,right:string)=>left<right?-1:left>right?1:0;
  const result:EffectiveUsageDayPending={lastObservedAtMs:last,projection:{...prior,usage:{rowsRead,
    cells:[...cells.values()].sort((a,b)=>compare(graphDayUsageCellOrder(a),graphDayUsageCellOrder(b))),
    openers:openers.sort((a,b)=>compare(a.sessionDigest,b.sessionDigest)),
    sessions:[...tails.values()].sort((a,b)=>compare(a.sessionDigest,b.sessionDigest))}}};
  if(bytes(result)>EFFECTIVE_USAGE_DAY_MAX_BYTES)return null;
  if(!validEffectiveUsageDayPending(result))throw fail();
  return result;
}

/** The model stream performs its 8MiB payload test only above4096 retained
 * entries. These sets upper-bound its previous/modelCosts/poisoned state at
 * every source page; fits' scalar buckets/hazards are intentionally excluded.
 * Larger windows use the original pager, preserving its refusal boundary. */
export function effectiveUsageWindowRepresentable(days:readonly EffectiveUsageDay[]):boolean {
  const sessions=new Set<string>(),costs=new Set<string>(),poisoned=new Set<number>();
  for(const {projection}of days){
    for(const tail of projection.usage.sessions)sessions.add(tail.sessionDigest);
    for(const row of [...projection.usage.cells,...projection.usage.openers]){
      if(row.model===null)poisoned.add(row.binStartMs);
      else costs.add(JSON.stringify([row.binStartMs,row.model]));
    }
    if(sessions.size+costs.size+poisoned.size>4096)return false;
  }
  return true;
}
