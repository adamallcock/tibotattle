// Synthetic, bounded microbenchmark only; no data, network, or database inputs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { buildSync, transformSync } from 'esbuild';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
function load(contents) {
  const code = buildSync({ stdin: {contents, loader:'ts',resolveDir:resolve(root,'src')}, bundle:true,write:false,platform:'node',format:'cjs',mainFields:['module','main'] }).outputFiles[0].text;
  const module = {exports:{}}; new Function('module','exports','require',code)(module,module.exports,require); return module.exports;
}
const original = readFileSync(resolve(root,'src/strict-json.ts'),'utf8');
if(createHash('sha256').update(original).digest('hex')!=='137866597bebc2239e34a24aa2dc1b97069e4b2bd3b4203ce24df21570a2137b')throw Error('STRICT_ORACLE_CHANGED');
const nativeSource=readFileSync(resolve(root,'src/telemetry-usage-reconciliation.ts'),'utf8');
const native=load(nativeSource+'\nexport {parseInternalAnalyticsJson};');
const methods={ast:load(original).parseStrictJson,native:native.parseInternalAnalyticsJson};
const oldReplaySource=readFileSync(resolve(root,'analytics-v2-test/fixtures/usage-reconciliation-strict-oracle.ts.txt'),'utf8');
if(createHash('sha256').update(oldReplaySource).digest('hex')!=='35458510a2f2c69710bf7cf78e701cdd0e504cbbe903ba3a0ecc1ace6271d15c')throw Error('REPLAY_ORACLE_CHANGED');
const oldReplay=load(oldReplaySource);
// Use the maintained content-free production-shaped fixture builder exactly.
const helper=readFileSync(resolve(root,'analytics-v2-test/kernel-parity/helpers/telemetry-v11.ts'),'utf8');
const contents=helper.slice(helper.indexOf('export function v11UsageRecord('),helper.indexOf('\nexport async function makeV11Day('));
const module={exports:{}};new Function('module','exports',transformSync(contents,{loader:'ts',format:'cjs'}).code)(module,module.exports);
const record=module.exports.v11UsageRecord('2026-10-03');
const inputs={record:JSON.stringify(record),array20:JSON.stringify(Array.from({length:20},()=>record)),array400:JSON.stringify(Array.from({length:400},()=>record))};
const session=new Session(); session.connect();const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(err,result)=>err?reject(err):resolve(result)));
function allocation(node){return node.selfSize+node.children.reduce((sum,child)=>sum+allocation(child),0)}
for(const [name,raw] of Object.entries(inputs))for(const [method,parse]of Object.entries(methods)){
 for(let i=0;i<100;i++)parse(raw);const iterations=name==='record'?3000:name==='array20'?300:30;const samples=[];
 for(let round=0;round<7;round++){global.gc?.();const start=performance.now();for(let i=0;i<iterations;i++)parse(raw);samples.push((performance.now()-start)/iterations)}samples.sort((a,b)=>a-b);
 global.gc?.();await post('HeapProfiler.startSampling',{samplingInterval:4096,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
 for(let i=0;i<iterations;i++)parse(raw);const {profile}=await post('HeapProfiler.stopSampling');
 console.log(JSON.stringify({name,method,node:process.version,platform:process.platform,arch:process.arch,bytes:Buffer.byteLength(raw),iterations,medianMs:samples[3],sampledAllocatedBytes:allocation(profile.head),sampledAllocatedBytesPerParse:allocation(profile.head)/iterations,samplingInterval:4096}));
 }
// Same complete correction/replay work: validation, canonicalization, hash and fold remain included.
for(const mode of ['assertion','accumulator'])for(const method of ['ast','native']){
 const module=method==='ast'?oldReplay:native;
 const input={format:'v11',recordJson:inputs.record};
 const iterations=mode==='assertion'?100:50;
 const run=async()=>{if(mode==='assertion')return module[method==='ast'?'prepareUsageCorrectionAssertion':'prepareAnalyticsReplayUsageCorrectionAssertion'](input);
  const a=module.createUsageCorrectionOccurrenceAccumulator({ownerScope:'synthetic-owner',occurrenceId:record.eventId,...(method==='native'?{jsonParsing:'internal_analytics_replay'}:{})});
  await a.append(Array.from({length:20},()=>({...input,ownerScope:'synthetic-owner'})));return a.close();};
 for(let i=0;i<20;i++)await run();const samples=[];
 for(let round=0;round<5;round++){global.gc?.();const start=performance.now();for(let i=0;i<iterations;i++)await run();samples.push((performance.now()-start)/iterations)}samples.sort((a,b)=>a-b);
 global.gc?.();await post('HeapProfiler.startSampling',{samplingInterval:4096,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});for(let i=0;i<iterations;i++)await run();const {profile}=await post('HeapProfiler.stopSampling');
 console.log(JSON.stringify({name:mode,method,node:process.version,platform:process.platform,arch:process.arch,bytes:Buffer.byteLength(inputs.record),recordsPerIteration:mode==='assertion'?1:20,iterations,medianMs:samples[2],sampledAllocatedBytesPerIteration:allocation(profile.head)/iterations,samplingInterval:4096}));
}
session.disconnect();
