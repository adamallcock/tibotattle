import type { ModelBlockOutput } from './analytics-model-block-contract';
import { modelHistoryWindow } from './model-history-window';

const DAY_MS=86_400_000,MAX_OUTPUTS=32,MAX_BATCH_OUTPUTS=16,MAX_SCOPES=132;
/** Preserve the native selected-first/sibling order while bounding both range
 * scopes and their exact session-inclusive singleton union. This is only a
 * work partition: the graph facade acquires and validates every scope itself. */
export function modelBlockAdoptionBatches(outputs:readonly ModelBlockOutput[],selectedDay:string):
 readonly (readonly ModelBlockOutput[])[] {
  if(!Array.isArray(outputs)||outputs.length<1||outputs.length>MAX_OUTPUTS
    ||new Set(outputs.map(output=>output.day)).size!==outputs.length
    ||!outputs.some(output=>output.day===selectedDay))throw new TypeError('MODEL_BLOCK_ADOPTION_BATCH_INVALID');
  const ordered=[...outputs].sort((a,b)=>a.day===selectedDay?-1:b.day===selectedDay?1:a.day.localeCompare(b.day));
  const batches:ModelBlockOutput[][]=[];
  let batch:ModelBlockOutput[]=[],scopes=new Set<string>();
  for(const output of ordered){
    const window=modelHistoryWindow(output.day),next=new Set<string>();
    next.add(`range:${window.fromDay}:${window.day}`);
    for(let at=Date.parse(`${window.fromDay}T00:00:00.000Z`),end=Date.parse(`${window.day}T00:00:00.000Z`);
      at<=end;at+=DAY_MS)next.add(`day:${new Date(at).toISOString().slice(0,10)}`);
    const union=new Set([...scopes,...next]);
    if(batch.length&&(batch.length===MAX_BATCH_OUTPUTS||union.size>MAX_SCOPES)){
      batches.push(batch);batch=[];scopes=new Set();
    }
    for(const scope of next)scopes.add(scope);
    if(scopes.size>MAX_SCOPES)throw new TypeError('MODEL_BLOCK_ADOPTION_BATCH_INVALID');
    batch.push(output);
  }
  if(batch.length)batches.push(batch);
  return batches;
}
