import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
import {createAnalyticsMutationCaptureTransform,MUTATION_PROJECTION_SOURCE_PATH} from './analytics-workload-mutation-capture-transform.mjs';
const original=await readFile(new URL('../src/v11-daily-projection.ts',import.meta.url),'utf8');
test('pins both actual projection hash inputs and changes neither arithmetic nor SHA implementation',async()=>{
 const adapter=createAnalyticsMutationCaptureTransform({lane:'reference'});
 assert.equal(adapter.transformSource({path:'apps/worker/src/crypto.ts',contents:'unrelated'}),null);
 const changed=adapter.transformSource({path:MUTATION_PROJECTION_SOURCE_PATH,contents:original});
 assert.equal((changed.contents.match(/sha256Hex\(captureMutationStep\(canonicalJson\(/gu)??[]).length,2);
 assert.equal(adapter.completeManifest().anchors,2);
 await transform(changed.contents,{loader:'ts',format:'esm'});
 assert.deepEqual(adapter.transformSource({path:MUTATION_PROJECTION_SOURCE_PATH,contents:original}),changed);
});
test('refuses changed source, missing seam and wrong lane without emitting source data',()=>{
 assert.throws(()=>createAnalyticsMutationCaptureTransform({lane:'other'}),/MUTATION_CAPTURE_LANE/);
 const adapter=createAnalyticsMutationCaptureTransform({lane:'candidate'});
 assert.throws(()=>adapter.completeManifest(),/MUTATION_CAPTURE_MISSING_SOURCE/);
 for(const contents of [original+'\n',original.replace('const stepDigest =','const changedDigest =')])
  assert.throws(()=>adapter.transformSource({path:MUTATION_PROJECTION_SOURCE_PATH,contents}),/^Error: MUTATION_CAPTURE_SOURCE_HASH$/);
});
test('capture returns exact serialized hash bytes and drains lane-local bounded observations',async()=>{
 const adapter=createAnalyticsMutationCaptureTransform({lane:'reference'});
 const module=await import('data:text/javascript;base64,'+Buffer.from(adapter.moduleSource).toString('base64'));
 const value=JSON.stringify({eventDigest:'a'.repeat(64),revision:1,day:'2026-09-30',afterStream:'',afterOccurrence:'',
  recordCount:0,completeDay:true,valueKey:'b'.repeat(64),pageDigest:null,values:{schema:'synthetic'}});
 assert.equal(module.captureMutationStep(value),value);
 assert.deepEqual(module.drainMutationStepPreimages(),[{eventDigest:'a'.repeat(64),revision:1,preimage:JSON.parse(value)}]);
 assert.deepEqual(module.drainMutationStepPreimages(),[]);
 assert.throws(()=>module.captureMutationStep('{}'),/MUTATION_CAPTURE_SHAPE/);
});
