import {expect,it} from 'vitest';
import {sha256Hex} from '../src/crypto';
import {validateRetainedFunctionalPublicationTimes,type FunctionalPublicationRows} from './helpers/analytics-retained-functional-clock';
async function fixture(){
 const old=Date.parse('2026-10-01T12:00:00.000Z'),now=old+1000,time=new Date(old).toISOString(),preview={generatedAt:time,value:1};
 const payload=JSON.stringify({releasedAt:time,value:1}),daily={day:'2026-09-30',revision:1,payload_json:payload,payload_sha256:await sha256Hex(payload),released_at:time};
 const output={daily:[{day:daily.day,value:{rows:[daily],allowanceBreakdownsCache:null}}],publishedDaily:[{day:daily.day,stored:[daily],visible:{rows:[daily],allowanceBreakdownsCache:null}}],preview};
 const modelPayload=JSON.stringify({value:1}),previewPayload=JSON.stringify(preview);
 const rows:FunctionalPublicationRows={modelRows:Array.from({length:70},(_,i)=>({day:new Date(old-i*86_400_000).toISOString().slice(0,10),revision:1,payload_json:modelPayload,payload_sha256:'',computed_ms:old})),
  previewRow:{payload_json:previewPayload,payload_sha256:await sha256Hex(previewPayload),generated_at:time,revision:1}};
 for(const row of rows.modelRows)row.payload_sha256=await sha256Hex(modelPayload);
 return {nowMs:now,priorNowMs:old,output:structuredClone(output),priorOutput:output,rows:structuredClone(rows),priorRows:rows};
}
it('retains old time only for exact complete same-key rows and verifies their hashes',async()=>{
 const input=await fixture(),r=await validateRetainedFunctionalPublicationTimes(input);
 expect(r.retainedExactRows).toBe(74);expect(r.newClockRows).toBe(0);expect(r.output).toBe(input.output);
 const model=input.rows.modelRows[0]!;model.computed_ms=input.nowMs;model.revision=2;model.payload_json=JSON.stringify({value:2});model.payload_sha256=await sha256Hex(model.payload_json as string);
 expect((await validateRetainedFunctionalPublicationTimes(input)).newClockRows).toBe(1);
});
it('rejects consistent peer tampering of a prior payload, hash, revision, or full metadata while keeping old time',async()=>{
 const mutations=[
  async(v:Awaited<ReturnType<typeof fixture>>)=>{const row=v.rows.modelRows[0]!;row.payload_json=JSON.stringify({value:2});row.payload_sha256=await sha256Hex(row.payload_json as string);},
  async(v:Awaited<ReturnType<typeof fixture>>)=>{v.rows.modelRows[0]!.payload_sha256='f'.repeat(64);},
  async(v:Awaited<ReturnType<typeof fixture>>)=>{v.rows.modelRows[0]!.revision=2;},
  async(v:Awaited<ReturnType<typeof fixture>>)=>{v.rows.modelRows[0]!.method='changed';},
  async(v:Awaited<ReturnType<typeof fixture>>)=>{v.rows.previewRow.revision=2;},
  async(v:Awaited<ReturnType<typeof fixture>>)=>{const row=v.output.publishedDaily[0]!.stored[0]!;row.payload_json=JSON.stringify({releasedAt:row.released_at,value:2});row.payload_sha256=await sha256Hex(row.payload_json);},
 ];
 for(const mutate of mutations){const reference=await fixture(),candidate=await fixture();await mutate(reference);await mutate(candidate);
  expect(reference.output).toEqual(candidate.output);expect(reference.rows).toEqual(candidate.rows);
  await expect(validateRetainedFunctionalPublicationTimes(reference)).rejects.toThrow();await expect(validateRetainedFunctionalPublicationTimes(candidate)).rejects.toThrow();
 }
});
it('refuses unknown intermediate/future clocks, missing model dates and invalid prior evidence',async()=>{
 for(const mode of ['intermediate','future','missing','prior'] as const){const input=await fixture();
  if(mode==='missing')input.rows.modelRows.pop();else if(mode==='prior')input.priorRows.modelRows[0]!.computed_ms=Number(input.priorRows.modelRows[0]!.computed_ms)+1;
  else input.rows.modelRows[0]!.computed_ms=mode==='future'?input.nowMs+1:input.priorNowMs+1;
  await expect(validateRetainedFunctionalPublicationTimes(input)).rejects.toThrow();
 }
});
