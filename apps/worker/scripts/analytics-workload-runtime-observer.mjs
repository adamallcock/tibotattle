/** Local CDP observation only. This module neither starts a runtime nor reads
 * application data. CPU sample weights are not billed CPU, and observed heap
 * maxima are not true peaks. The caller owns lane/isolate comparison proof. */
const HEAP_FIELDS=Object.freeze(['usedSize','totalSize','embedderHeapUsedSize','backingStorageSize']);
const LABEL=/^[a-z][a-z0-9_-]{0,63}$/u;
const TARGET=/^core:user:vitest-pool-workers-runner-[A-Za-z0-9_-]*$/u;
const FRAME_LIMIT=32*1024*1024;
// workerd may acknowledge these void commands with only their matching ID.
// Data-bearing commands must still return an object, and explicit null is invalid.
const VOID_ACK_METHODS=new Set(['Runtime.enable','Profiler.enable','Profiler.setSamplingInterval','Profiler.start']);
const error=code=>Object.assign(new Error(code),{code});
const round=n=>Math.round(n*1000)/1000;
function boundedInteger(value,min,max,code){if(!Number.isSafeInteger(value)||value<min||value>max)throw error(code);return value;}
function label(value){if(typeof value!=='string'||!LABEL.test(value))throw error('OBSERVER_LABEL_INVALID');return value;}
function loopback(value){
 let url;try{url=new URL(value);}catch{throw error('OBSERVER_URL_INVALID');}
 if(!['http:','ws:'].includes(url.protocol)||!['127.0.0.1','[::1]'].includes(url.hostname)
  ||!url.port||url.username||url.password||url.search||url.hash)throw error('OBSERVER_LOOPBACK_REQUIRED');
 return url;
}
export function validateRuntimeObserverTarget(inspectorUrl,expectedTargetId,targets){
 const base=loopback(inspectorUrl);
 if(typeof expectedTargetId!=='string'||!TARGET.test(expectedTargetId))throw error('OBSERVER_VITEST_TARGET_REQUIRED');
 if(!['/','/'+expectedTargetId].includes(base.pathname))throw error('OBSERVER_TARGET_PATH_MISMATCH');
 if(!Array.isArray(targets)||targets.length>128)throw error('OBSERVER_TARGET_LIST_INVALID');
 const matching=targets.filter(target=>target?.id===expectedTargetId);
 if(matching.length!==1||matching[0].type!=='node')throw error('OBSERVER_TARGET_NOT_UNIQUE');
 const selected=loopback(matching[0].webSocketDebuggerUrl);
 if(selected.protocol!=='ws:'||selected.hostname!==base.hostname||selected.port!==base.port
  ||selected.pathname!=='/'+expectedTargetId)throw error('OBSERVER_TARGET_ORIGIN_MISMATCH');
 return {targetId:expectedTargetId,webSocketUrl:selected.href};
}
async function readTargets(fetchImpl,url,timeoutMs){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await fetchImpl(url,{redirect:'error',credentials:'omit',signal:controller.signal});
  if(!response.ok||!response.body?.getReader)throw error('OBSERVER_DISCOVERY_FAILED');
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{for(;;){const row=await reader.read();if(row.done)break;size+=row.value.byteLength;
   if(size>65536){await reader.cancel();throw error('OBSERVER_DISCOVERY_OVERSIZED');}chunks.push(row.value);}}
  finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw error('OBSERVER_DISCOVERY_INVALID_JSON');}
 }catch(cause){if(cause?.code?.startsWith('OBSERVER_'))throw cause;throw error(controller.signal.aborted?'OBSERVER_DISCOVERY_TIMEOUT':'OBSERVER_DISCOVERY_FAILED');}
 finally{clearTimeout(timer);}
}
async function defaultSocketFactory(url){const {default:WebSocket}=await import('ws');return new WebSocket(url,{origin:'http://127.0.0.1',maxPayload:FRAME_LIMIT});}
class CdpChannel{
 constructor(socket,timeoutMs){
  this.socket=socket;this.timeoutMs=timeoutMs;this.pending=new Map();this.sequence=0;this.closed=false;this.failure=null;
  socket.on('message',data=>{
   if(Buffer.byteLength(data)>FRAME_LIMIT)return this.fail('OBSERVER_FRAME_OVERSIZED');
   let message;try{message=JSON.parse(String(data));}catch{return this.fail('OBSERVER_FRAME_INVALID');}
   if(!message||typeof message!=='object'||Array.isArray(message))return this.fail('OBSERVER_FRAME_INVALID');
   if(message.id===undefined)return; // Never retain log, script or application events.
   const pending=this.pending.get(message.id);if(!pending)return;
   this.pending.delete(message.id);clearTimeout(pending.timer);
   if(message.error)pending.reject(error(message.error.code===-32601?'OBSERVER_METHOD_UNSUPPORTED':'OBSERVER_COMMAND_REFUSED'));
   else if(!Object.hasOwn(message,'result')&&VOID_ACK_METHODS.has(pending.method))pending.resolve({});
   else if(!message.result||typeof message.result!=='object'||Array.isArray(message.result))pending.reject(error('OBSERVER_RESULT_INVALID'));
   else pending.resolve(message.result);
  });
  socket.on('error',()=>this.fail('OBSERVER_SOCKET_ERROR'));
  socket.on('close',()=>{this.closed=true;this.fail('OBSERVER_SOCKET_CLOSED');});
 }
 fail(code){this.failure??=code;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error(code));}this.pending.clear();}
 async opened(){
  if(this.socket.readyState===1)return;
  await new Promise((resolve,reject)=>{
   const finish=cause=>{clearTimeout(timer);this.socket.off('open',opened);this.socket.off('error',failed);this.socket.off('close',failed);cause?reject(cause):resolve();};
   const opened=()=>finish(),failed=()=>finish(error('OBSERVER_CONNECT_FAILED'));
   const timer=setTimeout(()=>{this.socket.terminate();finish(error('OBSERVER_CONNECT_TIMEOUT'));},this.timeoutMs);
   this.socket.once('open',opened);this.socket.once('error',failed);this.socket.once('close',failed);
  });
 }
 request(method,params={}){
  if(this.closed||this.failure)return Promise.reject(error(this.failure??'OBSERVER_SOCKET_CLOSED'));
  const id=++this.sequence;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(error('OBSERVER_COMMAND_TIMEOUT'));},this.timeoutMs);
   this.pending.set(id,{method,resolve,reject,timer});
   try{this.socket.send(JSON.stringify({id,method,params}),cause=>{if(cause){clearTimeout(timer);this.pending.delete(id);reject(error('OBSERVER_SEND_FAILED'));}});}
   catch{clearTimeout(timer);this.pending.delete(id);reject(error('OBSERVER_SEND_FAILED'));}
  });
 }
 async close(){
  if(this.closed)return;
  this.fail('OBSERVER_SOCKET_CLOSED');
  await new Promise(resolve=>{
   const done=()=>{clearTimeout(timer);this.socket.off('close',done);resolve();};
   const timer=setTimeout(()=>{this.socket.terminate();done();},Math.min(this.timeoutMs,1000));
   this.socket.once('close',done);try{this.socket.close();}catch{this.socket.terminate();done();}
  });this.closed=true;
 }
}

function invalidProfile(category,profile){
 const deltas=Array.isArray(profile?.timeDeltas)?profile.timeDeltas:null;
 let valid=0,invalid=0,minimum=null,maximum=null,sum=0;
 const scanned=Math.min(deltas?.length??0,1000000);
 for(let index=0;index<scanned;index++){
  const value=deltas[index];
  if(!Number.isSafeInteger(value)||value<0){invalid++;continue;}
  valid++;minimum=minimum===null?value:Math.min(minimum,value);maximum=maximum===null?value:Math.max(maximum,value);sum+=value;
 }
 const duration=Number.isFinite(profile?.startTime)&&Number.isFinite(profile?.endTime)?(profile.endTime-profile.startTime)/1000:null;
 const failure={category,
  counts:{nodes:Array.isArray(profile?.nodes)?profile.nodes.length:null,samples:Array.isArray(profile?.samples)?profile.samples.length:null,timeDeltas:deltas?.length??null},
  profileWindowMs:duration!==null&&Number.isFinite(duration)&&duration>=0?round(duration):null,
  deltaScan:{scanned,complete:deltas!==null&&scanned===deltas.length,valid,invalid,
   minimumValidUs:minimum,maximumValidUs:maximum,sumValidUs:Number.isSafeInteger(sum)?sum:null}};
 return Object.assign(error('OBSERVER_PROFILE_INVALID'),{profileValidationFailure:failure});
}

/** Closed, content-free profile summary. Raw frames/source URLs never escape.
 * Invalid profiles expose only a closed reason and bounded numeric metadata. */
export function summarizeRuntimeCpuProfile(profile){
 if(!profile||!Array.isArray(profile.nodes)||!Array.isArray(profile.samples)||!Array.isArray(profile.timeDeltas)
  )throw invalidProfile('profile_shape',profile);
 if(profile.samples.length!==profile.timeDeltas.length)throw invalidProfile('sample_delta_length',profile);
 if(profile.samples.length>1000000)throw invalidProfile('sample_limit',profile);
 if(profile.nodes.length>100000)throw invalidProfile('node_limit',profile);
 if(!Number.isFinite(profile.startTime)||!Number.isFinite(profile.endTime)||profile.endTime<profile.startTime
  ||!Number.isFinite(profile.endTime-profile.startTime))throw invalidProfile('profile_window',profile);
 const nodes=new Map(),parents=new Map();
 for(const node of profile.nodes){
  if(!Number.isSafeInteger(node?.id))throw invalidProfile('node_identity',profile);
  if(nodes.has(node.id))throw invalidProfile('duplicate_node',profile);
  if(!node.callFrame||typeof node.callFrame.functionName!=='string'||typeof node.callFrame.url!=='string')throw invalidProfile('call_frame_shape',profile);
  nodes.set(node.id,node);
 }
 for(const node of profile.nodes){
  if(node.children!==undefined&&node.children!==null&&!Array.isArray(node.children))throw invalidProfile('children_shape',profile);
  for(const child of node.children??[]){
   if(!nodes.has(child))throw invalidProfile('child_reference',profile);
   if(parents.has(child))throw invalidProfile('duplicate_parent',profile);
   parents.set(child,node.id);
  }
 }
 const categories={javascriptFrames:{samples:0,weightUs:0},idle:{samples:0,weightUs:0},gc:{samples:0,weightUs:0},otherFrames:{samples:0,weightUs:0}};
 for(let index=0;index<profile.samples.length;index++){
  let id=profile.samples[index],kind='otherFrames';const seen=new Set();
  if(!nodes.has(id))throw invalidProfile('sample_reference',profile);
  while(id!==undefined){if(seen.has(id))throw invalidProfile('ancestry_cycle',profile);seen.add(id);const frame=nodes.get(id).callFrame;
   if(frame.functionName==='(idle)'){kind='idle';break;}if(frame.functionName==='(garbage collector)'){kind='gc';break;}
   if(frame.url){kind='javascriptFrames';break;}id=parents.get(id);}
  const delta=profile.timeDeltas[index];if(!Number.isSafeInteger(delta)||delta<0)throw invalidProfile('delta_value',profile);
  categories[kind].samples++;categories[kind].weightUs+=delta;
 }
 const weights=Object.values(categories).reduce((sum,row)=>sum+row.weightUs,0),duration=(profile.endTime-profile.startTime)/1000;
 if(!Number.isSafeInteger(weights))throw invalidProfile('sample_weight_integer',profile);
 if(weights>profile.endTime-profile.startTime+1000)throw invalidProfile('sample_weight_window',profile);
 const sorted=[...profile.timeDeltas].sort((a,b)=>a-b);
 return {kind:'inspector-frame-sample-weights',profileWindowMs:round(duration),sampleCount:profile.samples.length,
  sampleWeightMs:round(weights/1000),nonIdleSampleWeightMs:round((weights-categories.idle.weightUs)/1000),
  unrepresentedWindowMs:round(Math.max(0,duration-weights/1000)),
  frameMass:Object.fromEntries(Object.entries(categories).map(([key,row])=>[key,{samples:row.samples,sampleWeightMs:round(row.weightUs/1000)}])),
  observedDeltaUs:sorted.length?{minimum:sorted[0],median:sorted[Math.floor(sorted.length/2)],maximum:sorted.at(-1)}:null,
  exactWorkerCpuMs:null,billedWorkerCpuMs:null};
}

class RuntimeObserver{
 constructor(channel,identity,options){this.channel=channel;this.identity=Object.freeze(identity);this.options=options;this.active=null;this.last=null;this.closed=false;this.sequence=0;}
 getIdentity(){return structuredClone(this.identity);}
 async startPhase({lane,phase,deadlineMs}){
  if(this.closed)throw error('OBSERVER_CLOSED');if(this.active)throw error('OBSERVER_PHASE_ACTIVE');
  if(!['candidate','reference'].includes(lane))throw error('OBSERVER_LANE_INVALID');label(phase);
  const now=this.options.now();if(!Number.isFinite(deadlineMs)||deadlineMs<=now||deadlineMs-now>86400000)throw error('OBSERVER_DEADLINE_INVALID');
  const token=Object.freeze({sequence:++this.sequence,lane,phase});
  const state={token,deadlineMs,startSentMs:now,startAcknowledgedMs:null,heap:[],dropped:0,gaps:[],periodic:null,inFlight:null,expiry:null,stopPromise:null};
  this.active=state;
  try{await this.channel.request('Profiler.start');state.startAcknowledgedMs=this.options.now();}
  catch(cause){this.active=null;await this.close();throw cause;}
  if(state.startAcknowledgedMs>=deadlineMs){state.gaps.push('phase_deadline_elapsed');await this.stopPhase(token);throw error('OBSERVER_DEADLINE_ELAPSED');}
  state.expiry=setTimeout(()=>{state.gaps.push('phase_deadline_elapsed');this.stopPhase(token).catch(()=>{});},deadlineMs-this.options.now());
  await this.sampleHeap({label:'phase-start'});
  if(this.active!==state||state.stopPromise||this.options.now()>=deadlineMs){
   if(!state.gaps.includes('phase_deadline_elapsed'))state.gaps.push('phase_deadline_elapsed');
   await this.stopPhase(token);throw error('OBSERVER_DEADLINE_ELAPSED');
  }
  this.schedule(state);
  return Object.freeze({...token,startAcknowledgedMs:state.startAcknowledgedMs,identity:this.getIdentity(),token});
 }
 schedule(state){
  if(!this.options.heapSampleIntervalMs||state.stopPromise||this.active!==state)return;
  state.periodic=setTimeout(()=>{
   state.inFlight=this.sampleHeap({label:'periodic'}).finally(()=>{state.inFlight=null;this.schedule(state);});
  },this.options.heapSampleIntervalMs);
 }
 async sampleHeap({label:sampleLabel}){
  label(sampleLabel);const state=this.active;if(!state||state.startAcknowledgedMs===null)throw error('OBSERVER_NO_PHASE');
  if(state.heap.length>=this.options.maxHeapObservations){state.dropped++;return {state:'dropped',reason:'observation_limit'};}
  // A short placeholder reserves its bounded slot before concurrent requests.
  const row={label:sampleLabel,requestSentMs:this.options.now(),observedMs:null,state:'pending',fieldsBytes:null};state.heap.push(row);
  try{
   const result=await this.channel.request('Runtime.getHeapUsage'),fields={};
   for(const field of HEAP_FIELDS)if(result[field]!==undefined){if(!Number.isSafeInteger(result[field])||result[field]<0)throw error('OBSERVER_HEAP_INVALID');fields[field]=result[field];}
   if(!Object.hasOwn(fields,'usedSize')||!Object.hasOwn(fields,'totalSize'))throw error('OBSERVER_HEAP_INVALID');
   row.state='observed';row.fieldsBytes=fields;
  }catch(cause){row.state='unavailable';row.reason=cause.code??'OBSERVER_HEAP_FAILED';state.gaps.push(row.reason);}
  row.observedMs=this.options.now();return structuredClone(row);
 }
 stopPhase(handle){
  const token=handle?.token??handle,state=this.active;
  if(!state){if(this.last?.token===token)return Promise.resolve(structuredClone(this.last.receipt));throw error('OBSERVER_NO_PHASE');}
  if(token!==state.token)throw error('OBSERVER_PHASE_TOKEN_MISMATCH');
  if(state.stopPromise)return state.stopPromise;
  clearTimeout(state.periodic);clearTimeout(state.expiry);
  state.stopPromise=this.finish(state);return state.stopPromise;
 }
 async finish(state){
  if(state.inFlight)await state.inFlight;
  await this.sampleHeap({label:'phase-stop'});
  const stopSentMs=this.options.now();let cpu=null,stopAcknowledgedMs=null,profileValidationFailure=null;
  try{const {profile}=await this.channel.request('Profiler.stop');stopAcknowledgedMs=this.options.now();cpu=summarizeRuntimeCpuProfile(profile);}
  catch(cause){state.gaps.push(cause.code??'OBSERVER_PROFILE_FAILED');profileValidationFailure=cause.profileValidationFailure??null;}
  const maxima={};for(const row of state.heap)if(row.state==='observed')for(const [field,value]of Object.entries(row.fieldsBytes))maxima[field]=Math.max(maxima[field]??0,value);
  const receipt={schema:'analytics-workload-runtime-observation-v1',identity:this.getIdentity(),lane:state.token.lane,phase:state.token.phase,
   complete:cpu!==null&&state.gaps.length===0&&state.dropped===0,
   barriers:{startSentMs:state.startSentMs,startAcknowledgedMs:state.startAcknowledgedMs,stopSentMs,stopAcknowledgedMs,
    controllerWindowWallMs:round(stopSentMs-state.startAcknowledgedMs)},
   sampledIsolateCpu:cpu,profileValidationFailure,sampledHeapHighWater:{kind:'maximum-of-runtime-observations',
    fieldsBytes:Object.keys(maxima).length?Object.fromEntries(HEAP_FIELDS.map(field=>[field,maxima[field]??null])):null,
    observationCount:state.heap.length,observedCount:state.heap.filter(row=>row.state==='observed').length,droppedCount:state.dropped,
    missingFields:HEAP_FIELDS.filter(field=>!state.heap.some(row=>row.state==='observed')
     ||state.heap.some(row=>row.state==='observed'&&!Object.hasOwn(row.fieldsBytes,field))),truePeakIsolateHeapBytes:null},
   heapObservations:state.heap.map(row=>({...row,commandWallMs:row.observedMs===null?null:round(row.observedMs-row.requestSentMs)})),
   gaps:[...new Set(state.gaps)],cpuSamplingIntervalUs:this.options.cpuSamplingIntervalUs,
   periodicHeapIntervalMs:this.options.heapSampleIntervalMs,profilingOverheadEstimate:null,
   exactWorkerCpuMs:null,billedWorkerCpuMs:null,truePeakIsolateHeapBytes:null,physicalWireBytes:null,
   boundary:'Selected local isolate; profiler window includes observer heap command overhead. Missing sample time remains unattributed; no forced GC or allocation profiler runs.'};
  this.last={token:state.token,receipt};if(this.active===state)this.active=null;
  if(cpu===null)await this.channel.close();return structuredClone(receipt);
 }
 async close(){
  if(this.closed)return {closed:true};this.closed=true;let phase=null;
  try{if(this.active){this.active.gaps.push('observer_closed_during_phase');phase=await this.stopPhase(this.active.token);}}
  finally{await this.channel.close();}
  return {closed:true,phase};
 }
}

/** Inject fetch/socket factories only for local tests or a reviewed host bridge.
 * Production callers supply the exact inspector URL and expected user-worker ID. */
export async function createAnalyticsWorkloadRuntimeObserver({inspectorUrl,expectedTargetId,
 commandTimeoutMs=5000,cpuSamplingIntervalUs=1000,heapSampleIntervalMs=0,maxHeapObservations=256,
 fetchImpl=globalThis.fetch,socketFactory=defaultSocketFactory,now=Date.now}={}){
 boundedInteger(commandTimeoutMs,1,60000,'OBSERVER_TIMEOUT_INVALID');
 boundedInteger(cpuSamplingIntervalUs,100,1000000,'OBSERVER_SAMPLING_INVALID');
 boundedInteger(heapSampleIntervalMs,0,60000,'OBSERVER_HEAP_INTERVAL_INVALID');
 boundedInteger(maxHeapObservations,2,4096,'OBSERVER_HEAP_LIMIT_INVALID');
 if(typeof fetchImpl!=='function'||typeof socketFactory!=='function'||typeof now!=='function')throw error('OBSERVER_ADAPTER_INVALID');
 const base=loopback(inspectorUrl);if(typeof expectedTargetId!=='string'||!TARGET.test(expectedTargetId))throw error('OBSERVER_VITEST_TARGET_REQUIRED');
 const discovery=new URL('/json/list',base);discovery.protocol='http:';
 const selected=validateRuntimeObserverTarget(base.href,expectedTargetId,await readTargets(fetchImpl,discovery.href,commandTimeoutMs));
 const channel=new CdpChannel(await socketFactory(selected.webSocketUrl),commandTimeoutMs);
 try{
  await channel.opened();const {domains}=await channel.request('Schema.getDomains');
  if(!Array.isArray(domains)||domains.length>32||domains.some(row=>!row||typeof row.name!=='string'
   ||typeof row.version!=='string'||!/^\d{1,3}\.\d{1,3}$/u.test(row.version))
   ||!domains.some(row=>row.name==='Profiler')||!domains.some(row=>row.name==='Runtime'))throw error('OBSERVER_DOMAINS_INVALID');
  await channel.request('Runtime.enable');const {id}=await channel.request('Runtime.getIsolateId');
  if(typeof id!=='string'||!/^[a-f0-9]{1,64}$/u.test(id))throw error('OBSERVER_ISOLATE_INVALID');
  await channel.request('Profiler.enable');await channel.request('Profiler.setSamplingInterval',{interval:cpuSamplingIntervalUs});
  return new RuntimeObserver(channel,{targetId:selected.targetId,isolateId:id,
   domains:domains.filter(row=>['Runtime','Profiler','HeapProfiler','Debugger','Schema'].includes(row.name)).map(row=>({name:row.name,version:row.version}))},
   {commandTimeoutMs,cpuSamplingIntervalUs,heapSampleIntervalMs,maxHeapObservations,now});
 }catch(cause){await channel.close();throw cause;}
}
