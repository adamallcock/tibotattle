import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
export const MUTATION_PROJECTION_SOURCE_PATH='apps/worker/src/v11-daily-projection.ts';
export const MUTATION_PROJECTION_SOURCE_SHA256='c6d1d7ece2ea5ab1bc4c6533c8996ba0185ba9d7c0495d6a07cebbefec6f4084';
const anchors=[
`canonicalJson({ eventDigest: change.eventDigest, revision,
      day: virtual.next_day, afterStream: last.stream, afterOccurrence: last.occurrence_id,
      recordCount, completeDay: false, valueKey: options.identity.value_key, pageDigest, values })`,
`canonicalJson({ eventDigest: change.eventDigest, revision: work.revision + 1,
    day: work.next_day, afterStream, afterOccurrence, recordCount, completeDay, valueKey: identity.value_key, pageDigest, values })`,
];
/** Observe the actual serialized SHA input; return its bytes unchanged. */
export function createAnalyticsMutationCaptureTransform({lane}) {
 if(!['reference','candidate'].includes(lane))throw Error('MUTATION_CAPTURE_LANE');
 const moduleSpecifier='analytics-workload:mutation-step/'+lane;
 const moduleSource=`let rows=[],bytes=0,calls=0,captureWallMs=0;const encoder=new TextEncoder();
export function captureMutationStep(text){const started=performance.now();calls++;try{if(typeof text!=='string')throw Error('MUTATION_CAPTURE_SHAPE');
 const size=encoder.encode(text).length;if(rows.length>=100000||bytes+size>16777216)throw Error('MUTATION_CAPTURE_LIMIT');
 const preimage=JSON.parse(text);if(Object.keys(preimage).sort().join(',')!=='afterOccurrence,afterStream,completeDay,day,eventDigest,pageDigest,recordCount,revision,valueKey,values')throw Error('MUTATION_CAPTURE_SHAPE');
 rows.push({eventDigest:preimage.eventDigest,revision:preimage.revision,preimage});bytes+=size;return text;}finally{captureWallMs+=performance.now()-started;}}
export function drainMutationCaptureMeasurement(){const result={calls,logicalSerializedBytes:bytes,captureWallMs,exactCpuMs:null};calls=0;captureWallMs=0;return result;}
export function drainMutationStepPreimages(){const result=rows;rows=[];bytes=0;return result;}`;
 let manifest=null;
 return {moduleSpecifier,moduleSource,entryExports:`export {drainMutationStepPreimages,drainMutationCaptureMeasurement} from ${JSON.stringify(moduleSpecifier)};`,
 transformSource({path,contents}){
  if(path!==MUTATION_PROJECTION_SOURCE_PATH)return null;
  if(sha(contents)!==MUTATION_PROJECTION_SOURCE_SHA256)throw Error('MUTATION_CAPTURE_SOURCE_HASH');
  let transformed=contents;
  for(const anchor of anchors){if(transformed.split(anchor).length!==2)throw Error('MUTATION_CAPTURE_ANCHOR');
   transformed=transformed.replace(anchor,`captureMutationStep(${anchor})`);}
  transformed=`import {captureMutationStep} from ${JSON.stringify(moduleSpecifier)};\n`+transformed;
  const next={lane,sourceSha256:sha(contents),transformedSha256:sha(transformed),virtualSha256:sha(moduleSource),anchors:2,
   sourceBytes:Buffer.byteLength(contents),transformedBytes:Buffer.byteLength(transformed)};
  if(manifest&&JSON.stringify(next)!==JSON.stringify(manifest))throw Error('MUTATION_CAPTURE_RELOAD');manifest=next;
  return {contents:transformed,loader:'ts'};
 },completeManifest(){if(!manifest)throw Error('MUTATION_CAPTURE_MISSING_SOURCE');return Object.freeze({...manifest});}};
}
