import {expect} from 'vitest';
import {sha256Hex} from '../../src/crypto';
import {validateWholeWorkloadPublicationTimes} from './analytics-whole-workload';
export const RETAINED_FUNCTIONAL_CLOCK_CONTRACT='retained-functional-publication-clock-v1';
export interface FunctionalPublicationRows {modelRows:Record<string,unknown>[];previewRow:Record<string,unknown>;}
const fail=():never=>{throw Error('RETAINED_FUNCTIONAL_CLOCK_PROOF');};
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))return fail();return value as Record<string,unknown>;};
const key=(kind:string,day:unknown,revision:unknown)=>{if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(day)||!Number.isSafeInteger(revision)||Number(revision)<1)return fail();return kind+'/'+day+'/'+revision;};
/** Separate retained-state contract: unchanged old clocks require exact complete
 * prior rows. A matching timestamp alone never authorizes retained evidence. */
export async function validateRetainedFunctionalPublicationTimes<T>(input:{output:T;priorOutput:T;rows:FunctionalPublicationRows;
 priorRows:FunctionalPublicationRows;nowMs:number;priorNowMs:number}) {
 if(!Number.isSafeInteger(input.nowMs)||input.nowMs<input.priorNowMs||!Number.isFinite(new Date(input.nowMs).getTime()))fail();
 validateWholeWorkloadPublicationTimes(input.priorOutput,input.priorNowMs);
 const now=new Date(input.nowMs).toISOString(),prior=new Date(input.priorNowMs).toISOString(),pinned=new Map<string,Record<string,unknown>>();
 let timestampsChecked=0,retainedExactRows=0,newClockRows=0;
 async function row(id:string,value:unknown,field:'released_at'|'generated_at'|'computed_ms',payloadField:'releasedAt'|'generatedAt'|null,capture:boolean){
  const item=object(value);if(typeof item.payload_json!=='string')fail();
  const payload=object(JSON.parse(item.payload_json as string));
  if(payloadField&&payload[payloadField]!==item[field])fail();
  if('payload_sha256' in item&&(typeof item.payload_sha256!=='string'||item.payload_sha256!==await sha256Hex(item.payload_json as string)))fail();
  const stamp=field==='computed_ms'?input.nowMs:now,oldStamp=field==='computed_ms'?input.priorNowMs:prior;
  if(capture){if(item[field]!==oldStamp)fail();const old=pinned.get(id);if(old)expect(item).toEqual(old);else pinned.set(id,item);return;}
  timestampsChecked++;
  if(item[field]===stamp){newClockRows++;return;}
  if(item[field]!==oldStamp||!pinned.has(id))fail();
  expect(item).toEqual(pinned.get(id));retainedExactRows++;
 }
 async function collect(outputValue:unknown,rows:FunctionalPublicationRows,capture:boolean){
  const output=object(outputValue),published=output.publishedDaily,daily=output.daily;
  if(!Array.isArray(published)||!Array.isArray(daily)||!Array.isArray(rows.modelRows)||rows.modelRows.length!==70)fail();
  const visible=async(day:unknown,value:unknown)=>{const publicValue=object(value);if(!Array.isArray(publicValue.rows))fail();
   for(const raw of publicValue.rows as unknown[]){const item=object(raw);await row(key('daily-visible',day,item.revision),item,'released_at','releasedAt',capture);}
   if(publicValue.allowanceBreakdownsCache)await row('daily-preview/'+String(day),publicValue.allowanceBreakdownsCache,'generated_at','generatedAt',capture);
  };
  for(const raw of daily as unknown[]){const item=object(raw);await visible(item.day,item.value);}
  for(const raw of published as unknown[]){const item=object(raw);if(!Array.isArray(item.stored))fail();
   for(const stored of item.stored as unknown[]){const publication=object(stored);await row(key('daily-stored',item.day,publication.revision),publication,'released_at','releasedAt',capture);}await visible(item.day,item.visible);
  }
  const modelKeys=new Set<unknown>();
  for(const model of rows.modelRows){const id=key('model',model.day,model.revision);if(modelKeys.has(model.day))fail();modelKeys.add(model.day);await row(id,model,'computed_ms',null,capture);}
  await row('preview',rows.previewRow,'generated_at','generatedAt',capture);
  const preview=object(output.preview);expect(preview).toEqual(JSON.parse(rows.previewRow.payload_json as string));
 }
 await collect(input.priorOutput,input.priorRows,true);await collect(input.output,input.rows,false);
 return {output:input.output,timestampsChecked,contract:RETAINED_FUNCTIONAL_CLOCK_CONTRACT,retainedExactRows,newClockRows};
}
