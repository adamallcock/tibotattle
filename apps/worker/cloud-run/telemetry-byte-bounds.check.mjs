import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script, createContext } from 'node:vm';
import { cloudRunBuildPlugins } from './node-host-build.mjs';
import { assertTelemetryByteBoundsBinding, telemetryByteBoundsSource, bindTelemetryByteBoundsSource,
  TELEMETRY_BYTE_BOUNDS_POLICY } from './telemetry-byte-bounds-binding.mjs';
import { computeAnalyticsKernelIdentity } from './analytics-kernel-closure.mjs';
import { deriveAnalyticsV2PreparedDayClass } from '../scripts/analytics-v2-prepared-day-class.mjs';
const workerRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..'),vendorRoot=resolve(workerRoot,'vendor/analytics-d43c8f92');
const source=telemetryByteBoundsSource(workerRoot),host=resolve(workerRoot,'cloud-run/node-host-primitives.mjs');
const options={bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'silent',plugins:cloudRunBuildPlugins(workerRoot),
  external:['@google-cloud/cloud-sql-connector','google-auth-library','jsonc-parser','pg']};
export async function loadComposedBounds({directory,platform='node',format='esm',entry=source}={}) {
  const result=await build({...options,platform,format,plugins:cloudRunBuildPlugins(workerRoot),entryPoints:[entry],write:false,metafile:true,
    ...(format==='iife'?{globalName:'PortableBounds'}:{})});
  if(platform==='node'&&format==='esm'&&entry===source) assertTelemetryByteBoundsBinding(result.metafile,{workerRoot});
  let module;
  if(format==='iife') {const context=createContext({TextEncoder});new Script(result.outputFiles[0].text).runInContext(context);
    module={assertPortable:()=>new Script('PortableBounds.assertTelemetryClientBounds({n:1},{maxSerializedBytes:7})').runInContext(context)};
  } else if(directory) {const outfile=resolve(directory,'composed-bounds.mjs');await (await import('node:fs/promises')).writeFile(outfile,result.outputFiles[0].text);
    module=await import(pathToFileURL(outfile).href);
  } else module=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
  return {module,metafile:result.metafile,text:result.outputFiles[0].text};
}
test('actual Node composition calls native Buffer only after validation/stringify and rejects missing binding',async()=> {
  const bound=await loadComposedBounds();let calls=0;const original=Buffer.byteLength;
  Buffer.byteLength=function(...args){calls++;return original.apply(this,args);};
  try {
    assert.equal(bound.module.assertTelemetryClientBounds({n:1},{maxSerializedBytes:7}),undefined);assert.equal(calls,1);
    assert.throws(()=>bound.module.assertTelemetryClientBounds({n:1},{maxSerializedBytes:6}),error=>error.detailCode==='maximum_bytes_exceeded');assert.equal(calls,2);
    assert.throws(()=>bound.module.assertTelemetryClientBounds({n:NaN}),error=>error.detailCode==='non_json_value');assert.equal(calls,2);
  }finally{Buffer.byteLength=original;}
  const input=structuredClone(bound.metafile);for(const entry of Object.values(input.inputs)) entry.imports=entry.imports.filter(item=>item.original!=='tibotattle:node-telemetry-utf8');
  assert.throws(()=>assertTelemetryByteBoundsBinding(input,{workerRoot}),error=>error.code==='TELEMETRY_BYTE_BOUNDS_BINDING_MISSING');
  const missed=structuredClone(bound.metafile);Object.values(missed.outputs)[0].inputs={};
  assert.throws(()=>assertTelemetryByteBoundsBinding(missed,{workerRoot,requiredEntries:[source]}),error=>error.code==='TELEMETRY_BYTE_BOUNDS_BINDING_MISSING');
});
test('source pin refuses any different source before transformation',async()=> {
  const text=await readFile(source,'utf8');assert.ok(bindTelemetryByteBoundsSource(text).includes('telemetryNodeUtf8Length(serialized)'));
  assert.throws(()=>bindTelemetryByteBoundsSource(text+'\n// changed'),error=>error.code==='TELEMETRY_BYTE_BOUNDS_SOURCE_CHANGED');
});
test('browser, IIFE and non-target defaults keep portable original source',async()=> {
  for(const settings of [{platform:'browser'},{format:'iife'},{entry:resolve(workerRoot,'../../packages/telemetry-contract/src/primitives.js')}]) {
    const result=await loadComposedBounds(settings);
    assert.ok(result.text.includes('new TextEncoder'));
    assert.ok(!result.text.includes('telemetryNodeUtf8Length'));
    assert.ok(!Object.keys(result.metafile.inputs).some(path=>resolve(path)===host));
    if(settings.format==='iife') result.module.assertPortable();else result.module.assertTelemetryClientBounds({n:1},{maxSerializedBytes:7});
  }
});
test('compute closure and applicable pricing identity hash exact host and binding policy bytes',async()=> {
  const identity=read=>computeAnalyticsKernelIdentity({build,options,vendorRoot,...(read?{read}:{})});
  const baseline=await identity();assert.ok(baseline.names.includes('apps/worker/cloud-run/telemetry-byte-bounds-binding.mjs'));
  const isPricerInput=baseline.pricerNames.includes('apps/worker/cloud-run/telemetry-byte-bounds-binding.mjs');
  assert.equal(isPricerInput,baseline.pricerNames.includes('apps/worker/vendor/analytics-d43c8f92/packages/telemetry-contract/src/primitives.js'));
  for(const file of [host,TELEMETRY_BYTE_BOUNDS_POLICY]) {
    const mutated=await identity(async path=>Buffer.concat([await readFile(path),...(path===file?[Buffer.from('\n// class sensitivity')]:[])]));
    assert.notEqual(mutated.computeClosureSha256,baseline.computeClosureSha256);
    if(isPricerInput) assert.notEqual(mutated.pricerSha256,baseline.pricerSha256);
  }
  // Exercise the conditional path even when the current pricing exports do
  // not call bounds: a synthetic pricing export makes the exact bound module
  // contribute code, so its transformation policy must enter that class.
  const reachedBuild=args=>build(args.stdin?.sourcefile==='<analytics-v2-pricer-entry>'
    ?{...args,stdin:{...args.stdin,contents:args.stdin.contents+`\nexport { assertTelemetryClientBounds } from ${JSON.stringify(source)};`}}:args);
  const reached=await computeAnalyticsKernelIdentity({build:reachedBuild,options,vendorRoot});
  assert.ok(reached.pricerNames.includes('apps/worker/cloud-run/telemetry-byte-bounds-binding.mjs'));
  const changed=await computeAnalyticsKernelIdentity({build:reachedBuild,options,vendorRoot,
    read:async path=>Buffer.concat([await readFile(path),...(path===TELEMETRY_BYTE_BOUNDS_POLICY?[Buffer.from('\n// reached pricing policy')]:[])])});
  assert.notEqual(changed.pricerSha256,reached.pricerSha256);
});
// This is a bounded source/policy probe, not an L2 producer class.
async function boundProducerProbe(read=readFile) {
  const result=await build({...options,entryPoints:[source],write:false,metafile:true,
    plugins:cloudRunBuildPlugins(workerRoot,{read})});
  assertTelemetryByteBoundsBinding(result.metafile,{workerRoot});
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const reached=Object.keys(Object.values(result.metafile.outputs)[0].inputs).map(path=>resolve(path));
  reached.push(TELEMETRY_BYTE_BOUNDS_POLICY);
  const sourceHashes=await Promise.all(reached.sort().map(async path=>[path,hash(await read(path))]));
  const bundleSha256=hash(result.outputFiles[0].text);
  return {fixtureSha256:hash(JSON.stringify([sourceHashes,bundleSha256])),bundleSha256};
}
test('producer-policy fixture hashes actual bound source without inventing a missing L2 class',async()=> {
  const baseline=await boundProducerProbe();
  for(const file of [host,TELEMETRY_BYTE_BOUNDS_POLICY]) {
    const mutated=await boundProducerProbe(async path=>Buffer.concat([await readFile(path),...(path===file?[Buffer.from('\n// fixture source sensitivity')]:[])]));
    assert.notEqual(mutated.fixtureSha256,baseline.fixtureSha256);
    assert.equal(mutated.bundleSha256,baseline.bundleSha256,'comment-only mutation retains artifact bytes');
  }
  await assert.rejects(boundProducerProbe(async path=>Buffer.concat([await readFile(path),...(path===source?[Buffer.from('\n// changed pinned source')]:[])])),/TELEMETRY_BYTE_BOUNDS_SOURCE_CHANGED/);
  const producerPath=resolve(workerRoot,'src/analytics-v2/store-prepared-day.ts');
  const producerPresent=await stat(producerPath).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  if(producerPresent) {
    const real=await deriveAnalyticsV2PreparedDayClass();
    assert.ok(real.inputs.some(item=>item.name==='apps/worker/cloud-run/telemetry-byte-bounds-binding.mjs'));
  } else {
    await assert.rejects(deriveAnalyticsV2PreparedDayClass(),/Could not resolve "\.\/src\/analytics-v2\/store-prepared-day"/);
  }
});
