import {describe,expect,it} from 'vitest';
import {appendEffectiveUsageDay,effectiveUsageWindowRepresentable,validEffectiveUsageDay,
  validEffectiveUsageDayPending,type EffectiveUsageDayPending} from '../src/effective-usage-day';
import {graphDayUsageSessionDigest,reduceGraphDayProjection,type GraphDayUsageInput} from '../src/graph-day-projection';
import {v11PreparedUsageDayRow,type UsageRow} from '../src/quota-analysis-v11';
import {pricedModelHistoryUsage} from './helpers/model-history';
import {MAX_WINDOWED_USAGE_ROWS} from '../src/quota-analysis-v1';

const day='2026-09-04',start=Date.parse(`${day}T00:00:00.000Z`),ownerDigest='a'.repeat(64);
const scope=(other=false)=>`account-track:v2:${(other?'c':'b').repeat(64)}`;
function row(index:number,options:{session?:string|null;other?:boolean;unpriced?:boolean;dropped?:boolean;at?:number}={}):UsageRow {
 const time=new Date(options.at??start+index*1_000).toISOString();
 const record=JSON.parse(pricedModelHistoryUsage('gpt-5.6-sol',0.001,time).record.recordJson!);
 record.accountPlanAttribution={accountBasis:'same_source',accountTrackId:scope(options.other),
  planBasis:'same_source_occurrence',planType:'pro',planEraId:null};
 if(options.unpriced)record.modelId='synthetic-unpriced-model';
 if(options.dropped)record.components=null;
 return {occurrence_id:`synthetic-usage-${index}`,observed_at:time,provider:'openai_codex',
  session_uuid:options.session===undefined?'synthetic-session':options.session,record_json:JSON.stringify(record)};
}
async function oracle(rows:readonly UsageRow[]){
 const events:GraphDayUsageInput[]=[],sessions=new Set<string>();
 for(const value of rows){
  const mapped=await v11PreparedUsageDayRow(value,(provider,sessionUuid)=>
   graphDayUsageSessionDigest({ownerDigest,provider,sessionUuid}),sessions);
  if(mapped.status==='refused')throw new Error('synthetic usage unexpectedly refused');
  if(mapped.status==='row')events.push({...mapped.row,kind:mapped.row.model===null?'unpriced':'priced'});
  else if(mapped.session)events.push({...mapped.session,provider:value.provider,planBasis:null,planType:null,
   planEraId:null,model:null,costNanousd:0,kind:'unmeasurable'});
 }
 return reduceGraphDayProjection(day,[],{events,rowsRead:rows.length});
}
describe('effective usage compact day append',()=>{
 it('matches a complete-day oracle with ties and account changes split across arbitrary page boundaries',async()=>{
  const rows=Array.from({length:420},(_,index)=>row(index,{at:start+Math.floor(index/3)*1_000,
   other:index>=200&&index<300,session:index%5===0?null:`synthetic-session-${index%7}`,
   unpriced:index%47===0,dropped:index%53===0}));
  const expected=await oracle(rows);
  for(const pageSize of [1,7,200,419]){
   let pending:EffectiveUsageDayPending|null=null;
   for(let offset=0;offset<rows.length;offset+=pageSize){
    pending=await appendEffectiveUsageDay(pending,day,rows.slice(offset,offset+pageSize),ownerDigest);
    expect(pending).not.toBeNull();
   }
   expect(pending!.projection).toEqual(expected);
   expect(pending!.lastObservedAtMs).toBe(Date.parse(rows.at(-1)!.observed_at));
   expect(JSON.stringify(pending)).not.toContain('synthetic-session');
  }
 });
 it('keeps an unmeasurable page-tail account change and exact raw row count',async()=>{
  const rows=[row(0),row(1,{other:true,dropped:true}),row(2,{other:true})];
  let pending=await appendEffectiveUsageDay(null,day,rows.slice(0,2),ownerDigest);
  expect(pending!.projection.usage.sessions[0]!.lastAccountScopeId).toBe(scope(true));
  pending=await appendEffectiveUsageDay(pending,day,rows.slice(2),ownerDigest);
  expect(pending!.projection).toEqual(await oracle(rows));
  expect(pending!.projection.usage.rowsRead).toBe(3);
  expect(pending!.projection.usage.cells[0]!.accountBreak).toBe(false);
 });
 it('counts rows skipped before session admission and supports an empty inventoried day',async()=>{
  const skipped={...row(0),provider:'invalid provider'};
  const value=await appendEffectiveUsageDay(null,day,[skipped],ownerDigest);
  expect(value!.projection.usage).toEqual({rowsRead:1,cells:[],openers:[],sessions:[]});
  expect(validEffectiveUsageDayPending(value)).toBe(true);
  const empty=await appendEffectiveUsageDay(null,day,[],ownerDigest);
  expect(empty!.lastObservedAtMs).toBeNull();
  expect(validEffectiveUsageDay({projection:empty!.projection})).toBe(true);
 });
 it('refuses invalid source attribution rather than caching an incomplete model day',async()=>{
  expect(await appendEffectiveUsageDay(null,day,[{...row(0),record_json:'{}'}],ownerDigest)).toBeNull();
 });
 it('validates closed pending shapes and source order',async()=>{
  const value=await appendEffectiveUsageDay(null,day,[row(2)],ownerDigest);
  expect(validEffectiveUsageDayPending({...value,record_json:'private'})).toBe(false);
  expect(validEffectiveUsageDayPending({...value,lastObservedAtMs:start})).toBe(false);
  await expect(appendEffectiveUsageDay(value,day,[row(1)],ownerDigest)).rejects.toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
 });
 it('preserves the streaming byte-refusal boundary with a conservative entry bound',()=>{
  const projection=reduceGraphDayProjection(day,[]);
  const sessions=Array.from({length:4096},(_,index)=>({sessionDigest:index.toString(16).padStart(64,'0'),
   lastObservedAtMs:start,lastAccountScopeId:null}));
  const value={projection:{...projection,usage:{...projection.usage,rowsRead:4096,sessions}}};
  expect(effectiveUsageWindowRepresentable([value,value])).toBe(true);
  const additional={...value,projection:{...value.projection,usage:{...value.projection.usage,
   sessions:[...sessions,{sessionDigest:'f'.repeat(64),lastObservedAtMs:start,lastAccountScopeId:null}]}}};
  expect(effectiveUsageWindowRepresentable([additional])).toBe(false);
 });
 it('stops a compact same-cell or dropped-row day at the existing source row limit',async()=>{
  const projection=reduceGraphDayProjection(day,[]);
  const pending={projection:{...projection,usage:{...projection.usage,rowsRead:MAX_WINDOWED_USAGE_ROWS}},lastObservedAtMs:start};
  expect(validEffectiveUsageDayPending(pending)).toBe(true);
  expect(await appendEffectiveUsageDay(pending,day,[row(1)],ownerDigest)).toBeNull();
 });
});
