import { expect, it } from 'vitest';
import type { ModelBlockOutput } from '../src/analytics-model-block-contract';
import { modelHistoryWindow } from '../src/model-history-window';
import { modelBlockAdoptionBatches } from '../src/storage-model-block-adoption-batches';
const dayMs=86_400_000;
const outputs=Array.from({length:32},(_,index)=>({day:new Date(Date.UTC(2026,8,1)+index*dayMs)
  .toISOString().slice(0,10),fingerprint:'a'.repeat(64),value:{status:'not_testable',reason:'synthetic'}})) as ModelBlockOutput[];
function scopeCount(batch:readonly ModelBlockOutput[]):number {
  const singletonDays=new Set<string>();
  for(const output of batch){
    const window=modelHistoryWindow(output.day);
    for(let at=Date.parse(window.fromDay),end=Date.parse(window.day);at<=end;at+=dayMs)
      singletonDays.add(new Date(at).toISOString().slice(0,10));
  }
  return singletonDays.size+batch.length;
}
it('bounds every selected date in a32-output block without changing native adoption order',()=>{
  for(const selected of outputs){
    const batches=modelBlockAdoptionBatches(outputs,selected.day);
    expect(batches.flat()).toEqual([selected,...outputs.filter(output=>output!==selected)]);
    expect(batches.every(batch=>batch.length<=16&&scopeCount(batch)<=132)).toBe(true);
    expect(batches.flat().every(output=>outputs.includes(output))).toBe(true);
  }
  expect(modelBlockAdoptionBatches(outputs,outputs[0]!.day).map(batch=>batch.length)).toEqual([16,16]);
  // The newest selected date plus the oldest15 would exceed the scope cap.
  expect(modelBlockAdoptionBatches(outputs,outputs[31]!.day).map(batch=>batch.length)).toEqual([1,16,15]);
});
it('splits distant exact ranges rather than treating output count as scope coverage',()=>{
  const distant=[outputs[0]!,{...outputs[1]!,day:'2027-09-01'}];
  expect(modelBlockAdoptionBatches(distant,distant[0]!.day).map(batch=>batch.length)).toEqual([1,1]);
});
it('rejects empty, oversized, duplicate, missing-selected and invalid calendar input',()=>{
  for(const input of [[],[...outputs,{...outputs[0]!,day:'2026-11-01'}],[outputs[0]!,outputs[0]!],
    [{...outputs[0]!,day:'2026-02-30'}]])
    expect(()=>modelBlockAdoptionBatches(input,input[0]?.day??'2026-09-01')).toThrow();
  expect(()=>modelBlockAdoptionBatches(outputs,'2025-01-01')).toThrow();
});
