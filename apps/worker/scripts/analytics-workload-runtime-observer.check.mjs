import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {createAnalyticsWorkloadRuntimeObserver,summarizeRuntimeCpuProfile,validateRuntimeObserverTarget} from './analytics-workload-runtime-observer.mjs';
const id='core:user:vitest-pool-workers-runner-local';
const inspectorUrl='ws://127.0.0.1:9229/';
const target={id,type:'node',webSocketDebuggerUrl:inspectorUrl+id};
const profile={nodes:[{id:1,callFrame:{functionName:'(root)',url:''},children:[2,3]},
 {id:2,callFrame:{functionName:'(idle)',url:''}},
 {id:3,callFrame:{functionName:'private-function',url:'/private/source/path'}}],samples:[2,3],timeDeltas:[100,800],startTime:1000,endTime:11000};
class Socket extends EventEmitter{
 constructor(overrides={}){super();this.readyState=1;this.calls=[];this.overrides=overrides;this.closes=0;this.terminates=0;}
 send(data,callback){const request=JSON.parse(data);this.calls.push(request.method);callback?.();
  if(this.overrides[request.method]==='timeout')return;
  if(this.overrides[request.method]==='malformed'){queueMicrotask(()=>this.emit('message','{bad'));return;}
  if(this.overrides[request.method]==='void-ack'){queueMicrotask(()=>this.emit('message',JSON.stringify({id:request.id})));return;}
  if(this.overrides[request.method]==='null-result'){queueMicrotask(()=>this.emit('message',JSON.stringify({id:request.id,result:null})));return;}
  const result=this.overrides[request.method]??({
   'Schema.getDomains':{domains:[{name:'Runtime',version:'1.3'},{name:'Profiler',version:'1.3'}]},
   'Runtime.getIsolateId':{id:'a'.repeat(16)},'Runtime.getHeapUsage':{usedSize:100,totalSize:200,backingStorageSize:300,embedderHeapUsedSize:400},
   'Profiler.stop':{profile}}[request.method]??{});
  queueMicrotask(()=>this.emit('message',JSON.stringify({id:request.id,...(result.error?result:{result})})));
 }
 close(){this.closes++;this.readyState=3;queueMicrotask(()=>this.emit('close'));}
 terminate(){this.terminates++;this.readyState=3;queueMicrotask(()=>this.emit('close'));}
}
function options(socket=new Socket(),extra={}){return {inspectorUrl,expectedTargetId:id,commandTimeoutMs:25,
 fetchImpl:async()=>Response.json([target]),socketFactory:async()=>socket,...extra};}
test('requires an exact unique Vitest user target on the explicit literal loopback origin',async()=>{
 assert.deepEqual(validateRuntimeObserverTarget(inspectorUrl,id,[target]),{targetId:id,webSocketUrl:target.webSocketDebuggerUrl});
 for(const url of ['ws://example.com:9229/','ws://localhost:9229/','ws://127.0.0.1:9229/?token=x','ws://user:secret@127.0.0.1:9229/','ws://127.0.0.1:9229/other'])
  assert.throws(()=>validateRuntimeObserverTarget(url,id,[target]));
 for(const list of [[],[target,target],[{...target,id:'core:entry'}],[{...target,webSocketDebuggerUrl:'ws://127.0.0.1:9333/'+id}],
  [{...target,webSocketDebuggerUrl:'ws://127.0.0.1:9229/core:entry'}]])assert.throws(()=>validateRuntimeObserverTarget(inspectorUrl,id,list));
 let fetches=0;await assert.rejects(createAnalyticsWorkloadRuntimeObserver(options(new Socket(),{expectedTargetId:'core:entry',fetchImpl:async()=>{fetches++;}})));
 assert.equal(fetches,0);
});
test('summarizes sample weights and gaps without exposing private frames or treating wall as CPU',()=>{
 const result=summarizeRuntimeCpuProfile(profile);
 assert.equal(result.nonIdleSampleWeightMs,.8);assert.equal(result.frameMass.idle.sampleWeightMs,.1);
 assert.equal(result.profileWindowMs,10);assert.equal(result.unrepresentedWindowMs,9.1);
 assert.equal(result.billedWorkerCpuMs,null);assert.equal(result.exactWorkerCpuMs,null);
 assert.doesNotMatch(JSON.stringify(result),/private-function|private\/source/);
 for(const change of [{...profile,samples:[9]},{...profile,timeDeltas:[-1,0]},{...profile,endTime:0},
  {...profile,timeDeltas:[1]},{...profile,nodes:[...profile.nodes,profile.nodes[0]]}])assert.throws(()=>summarizeRuntimeCpuProfile(change));
});
test('invalid profiles retain strict limits and expose only closed numeric diagnostics',()=>{
 const emptyFrame={functionName:'(root)',url:''};
 const cases=[
  ['profile_shape',null],
  ['sample_delta_length',{...profile,timeDeltas:[1]}],
  ['sample_limit',{...profile,samples:Array(1000001),timeDeltas:Array(1000001)}],
  ['node_limit',{...profile,nodes:Array(100001)}],
  ['profile_window',{...profile,endTime:0}],
  ['node_identity',{...profile,nodes:[{id:'/private/node',callFrame:emptyFrame}]}],
  ['duplicate_node',{...profile,nodes:[...profile.nodes,profile.nodes[0]]}],
  ['call_frame_shape',{...profile,nodes:[{id:1,callFrame:{functionName:42,url:'/private/source'}}]}],
  ['children_shape',{...profile,nodes:[{id:1,callFrame:emptyFrame,children:{private:'value'}}]}],
  ['child_reference',{...profile,nodes:[{id:1,callFrame:emptyFrame,children:[99]}]}],
  ['duplicate_parent',{...profile,nodes:[profile.nodes[0],profile.nodes[1],{...profile.nodes[2],children:[2]}]}],
  ['sample_reference',{...profile,samples:[999,3]}],
  ['ancestry_cycle',{...profile,nodes:[{id:1,callFrame:emptyFrame,children:[2]},{id:2,callFrame:emptyFrame,children:[1]}],samples:[2,2]}],
  ['delta_value',{...profile,timeDeltas:['private-delta',-1]}],
  ['sample_weight_integer',{...profile,startTime:0,endTime:2e16,timeDeltas:[Number.MAX_SAFE_INTEGER,1]}],
  ['sample_weight_window',{...profile,timeDeltas:[9000,9000]}],
 ];
 for(const [category,value] of cases){
  let failure;
  assert.throws(()=>summarizeRuntimeCpuProfile(value),cause=>{
   assert.equal(cause.code,'OBSERVER_PROFILE_INVALID');failure=cause.profileValidationFailure;
   assert.equal(failure.category,category);return true;
  });
  assert.deepEqual(Object.keys(failure),['category','counts','profileWindowMs','deltaScan']);
  assert.doesNotMatch(JSON.stringify({...failure,category:undefined}),/private|functionName|callFrame|children|url|startTime|endTime/);
  assert.ok(failure.deltaScan.scanned<=1000000);
  if(category==='sample_limit')assert.equal(failure.deltaScan.complete,false);
  if(category==='sample_weight_integer')assert.equal(failure.deltaScan.sumValidUs,null);
  if(category==='sample_weight_window'){
   assert.equal(failure.profileWindowMs,10);assert.equal(failure.deltaScan.sumValidUs,18000);
   assert.deepEqual(failure.counts,{nodes:3,samples:2,timeDeltas:2});
  }
 }
});
test('returns ACK identity, separate heap maxima and nullable stronger claims; stop and close are idempotent',async()=>{
 const socket=new Socket(),observer=await createAnalyticsWorkloadRuntimeObserver(options(socket));
 assert.equal(observer.getIdentity().targetId,id);assert.equal(observer.getIdentity().isolateId,'a'.repeat(16));
 const identity=observer.getIdentity();identity.domains[0].version='changed';assert.equal(observer.getIdentity().domains[0].version,'1.3');
 const token=await observer.startPhase({lane:'candidate',phase:'cold',deadlineMs:Date.now()+1000});
 await assert.rejects(observer.startPhase({lane:'reference',phase:'warm',deadlineMs:Date.now()+1000}));
 await observer.sampleHeap({label:'barrier'});
 const result=await observer.stopPhase(token);assert.equal(result.complete,true);
 assert.equal(result.profileValidationFailure,null);
 assert.deepEqual(result.sampledHeapHighWater.fieldsBytes,{usedSize:100,totalSize:200,embedderHeapUsedSize:400,backingStorageSize:300});
 assert.equal(result.heapObservations.length,3);assert.equal(result.truePeakIsolateHeapBytes,null);assert.equal(result.physicalWireBytes,null);
 assert.deepEqual(await observer.stopPhase(token),result);assert.equal(socket.calls.filter(x=>x==='Profiler.stop').length,1);
 await observer.close();await observer.close();assert.equal(socket.closes,1);
 await assert.rejects(observer.startPhase({lane:'candidate',phase:'warm',deadlineMs:Date.now()+1000}));
});
test('accepts matching ID-only ACKs only for the closed void-command list',async()=>{
 const socket=new Socket(Object.fromEntries(['Runtime.enable','Profiler.enable','Profiler.setSamplingInterval','Profiler.start'].map(method=>[method,'void-ack'])));
 const observer=await createAnalyticsWorkloadRuntimeObserver(options(socket));
 const token=await observer.startPhase({lane:'candidate',phase:'cold',deadlineMs:Date.now()+1000});
 assert.equal((await observer.stopPhase(token)).complete,true);await observer.close();assert.equal(socket.closes,1);
});
test('requires result objects for data commands and rejects explicit null even for void commands',async()=>{
 for(const method of ['Schema.getDomains','Runtime.getIsolateId']){
  const socket=new Socket({[method]:'void-ack'});
  await assert.rejects(createAnalyticsWorkloadRuntimeObserver(options(socket)),{code:'OBSERVER_RESULT_INVALID'});
  assert.equal(socket.closes,1);
 }
 const socket=new Socket({'Profiler.enable':'null-result'});
 await assert.rejects(createAnalyticsWorkloadRuntimeObserver(options(socket)),{code:'OBSERVER_RESULT_INVALID'});
 assert.equal(socket.closes,1);
 for(const method of ['Runtime.getHeapUsage','Profiler.stop']){
  const socket=new Socket({[method]:'void-ack'}),observer=await createAnalyticsWorkloadRuntimeObserver(options(socket));
  const token=await observer.startPhase({lane:'candidate',phase:'cold',deadlineMs:Date.now()+1000});
  const result=await observer.stopPhase(token);assert.equal(result.complete,false);assert.ok(result.gaps.includes('OBSERVER_RESULT_INVALID'));
  if(method==='Runtime.getHeapUsage')assert.equal(result.sampledHeapHighWater.fieldsBytes,null);
  else assert.equal(result.sampledIsolateCpu,null);
  await observer.close();assert.equal(socket.closes,1);
 }
});
test('expired or malformed phase inputs never start profiling',async()=>{
 const socket=new Socket(),observer=await createAnalyticsWorkloadRuntimeObserver(options(socket));
 for(const value of [{lane:'candidate',phase:'cold',deadlineMs:Date.now()-1},{lane:'owner',phase:'cold',deadlineMs:Date.now()+1000},
  {lane:'candidate',phase:'/private/path',deadlineMs:Date.now()+1000}])await assert.rejects(observer.startPhase(value));
 assert.equal(socket.calls.includes('Profiler.start'),false);await observer.close();
});
test('phase deadline stops the owned profiler and marks the measurement incomplete',async()=>{
 const socket=new Socket(),observer=await createAnalyticsWorkloadRuntimeObserver(options(socket));
 const token=await observer.startPhase({lane:'candidate',phase:'cold',deadlineMs:Date.now()+30});
 await new Promise(resolve=>setTimeout(resolve,50));const result=await observer.stopPhase(token);
 assert.equal(result.complete,false);assert.ok(result.gaps.includes('phase_deadline_elapsed'));
 assert.equal(socket.calls.filter(x=>x==='Profiler.stop').length,1);await observer.close();
});
test('deadline expiring during the start heap barrier never authorizes starting the lane',async()=>{
 const socket=new Socket({'Runtime.getHeapUsage':'timeout'}),observer=await createAnalyticsWorkloadRuntimeObserver(options(socket));
 await assert.rejects(observer.startPhase({lane:'candidate',phase:'cold',deadlineMs:Date.now()+10}),{code:'OBSERVER_DEADLINE_ELAPSED'});
 assert.equal(socket.calls.filter(x=>x==='Profiler.stop').length,1);await observer.close();
});
test('missing heap support is a gap, never zero, while CPU may still have a profile',async()=>{
 const observer=await createAnalyticsWorkloadRuntimeObserver(options(new Socket({'Runtime.getHeapUsage':{error:{code:-32601,message:'private text ignored'}}})));
 const token=await observer.startPhase({lane:'reference',phase:'cold',deadlineMs:Date.now()+1000});const result=await observer.stopPhase(token);
 assert.equal(result.complete,false);assert.equal(result.sampledHeapHighWater.fieldsBytes,null);
 assert.ok(result.gaps.includes('OBSERVER_METHOD_UNSUPPORTED'));assert.ok(result.sampledIsolateCpu);
 assert.doesNotMatch(JSON.stringify(result),/private text/);await observer.close();
});
test('bounded periodic observations preserve dropped samples and isolate cleanup',async()=>{
 const socket=new Socket(),observer=await createAnalyticsWorkloadRuntimeObserver(options(socket,{heapSampleIntervalMs:2,maxHeapObservations:2}));
 const token=await observer.startPhase({lane:'candidate',phase:'warm',deadlineMs:Date.now()+1000});
 await new Promise(resolve=>setTimeout(resolve,15));const result=await observer.stopPhase(token);
 assert.equal(result.heapObservations.length,2);assert.ok(result.sampledHeapHighWater.droppedCount>0);assert.equal(result.complete,false);
 await observer.close();const calls=socket.calls.length;await new Promise(resolve=>setTimeout(resolve,10));assert.equal(socket.calls.length,calls);
});
test('closing an active phase reconciles stop once and preserves incomplete evidence',async()=>{
 const socket=new Socket(),observer=await createAnalyticsWorkloadRuntimeObserver(options(socket));
 await observer.startPhase({lane:'reference',phase:'cold',deadlineMs:Date.now()+1000});
 const result=await observer.close();assert.equal(result.closed,true);assert.equal(result.phase.complete,false);
 assert.ok(result.phase.gaps.includes('observer_closed_during_phase'));assert.equal(socket.closes,1);
});
test('timeouts and malformed CDP fail closed and close only the supplied socket',async()=>{
 for(const mode of ['timeout','malformed']){
  const socket=new Socket({'Runtime.getIsolateId':mode});
  await assert.rejects(createAnalyticsWorkloadRuntimeObserver(options(socket)));
  assert.equal(socket.closes,1);
 }
 const socket=new Socket({'Profiler.stop':'timeout'}),observer=await createAnalyticsWorkloadRuntimeObserver(options(socket));
 const token=await observer.startPhase({lane:'candidate',phase:'cold',deadlineMs:Date.now()+1000});
 const result=await observer.stopPhase(token);assert.equal(result.sampledIsolateCpu,null);assert.equal(result.complete,false);
 assert.ok(result.gaps.includes('OBSERVER_COMMAND_TIMEOUT'));assert.equal(socket.closes,1);await observer.close();
});
test('an invalid stopped profile preserves the categorical gap, heap observations and cleanup',async()=>{
 const socket=new Socket({'Profiler.stop':{profile:{...profile,timeDeltas:[9000,9000]}}});
 const observer=await createAnalyticsWorkloadRuntimeObserver(options(socket));
 const token=await observer.startPhase({lane:'candidate',phase:'cold',deadlineMs:Date.now()+1000});
 const result=await observer.stopPhase(token);
 assert.equal(result.complete,false);assert.equal(result.sampledIsolateCpu,null);assert.equal(result.billedWorkerCpuMs,null);
 assert.deepEqual(result.gaps,['OBSERVER_PROFILE_INVALID']);assert.equal(result.profileValidationFailure.category,'sample_weight_window');
 assert.equal(result.sampledHeapHighWater.observedCount,2);
 assert.equal(result.profileValidationFailure.profileWindowMs,10);assert.equal(result.profileValidationFailure.deltaScan.sumValidUs,18000);
 assert.doesNotMatch(JSON.stringify(result),/private-function|private\/source/);
 assert.equal(socket.closes,1);await observer.close();assert.equal(socket.closes,1);
});
test('malformed isolate and domain identity fails closed without retaining response text',async()=>{
 for(const overrides of [{'Runtime.getIsolateId':{id:'/private/path'}},
  {'Schema.getDomains':{domains:[{name:'Runtime',version:'private-path'},{name:'Profiler',version:'1.3'}]}}]){
  const socket=new Socket(overrides);await assert.rejects(createAnalyticsWorkloadRuntimeObserver(options(socket)));assert.equal(socket.closes,1);
 }
});
test('unsupported heap subfields remain explicit nulls rather than zero',async()=>{
 const observer=await createAnalyticsWorkloadRuntimeObserver(options(new Socket({'Runtime.getHeapUsage':{usedSize:10,totalSize:20}})));
 const token=await observer.startPhase({lane:'candidate',phase:'cold',deadlineMs:Date.now()+1000}),result=await observer.stopPhase(token);
 assert.equal(result.sampledHeapHighWater.fieldsBytes.backingStorageSize,null);
 assert.equal(result.sampledHeapHighWater.fieldsBytes.embedderHeapUsedSize,null);
 assert.deepEqual(result.sampledHeapHighWater.missingFields,['embedderHeapUsedSize','backingStorageSize']);await observer.close();
});
