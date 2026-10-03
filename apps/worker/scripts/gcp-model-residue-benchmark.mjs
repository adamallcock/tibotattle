#!/usr/bin/env node
/** Bounded local synthetic micro-benchmark. No import, database, production
 * instrumentation, registry write or cloud projection is performed here. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance, PerformanceObserver, constants } from 'node:perf_hooks';
import { loadavg } from 'node:os';
import { createHash } from 'node:crypto';
import { loadQuotaHarness, compareQuotaRows } from './gcp-model-residue-quota-check.mjs';
import { loadReductionHarness, payloadOracle } from './gcp-model-residue-check-lib.mjs';
import { residueDay, residueStart, residueAttribution, residueReduce } from '../analytics-v2-test/model-residue-byte-fixture.mjs';
const args=process.argv.slice(2),proofOnly=args.includes('--proof-only'),quotaOnly=args.includes('--quota-only'),firstOnly=args.includes('--first-walk-only'),bytesOnly=args.includes('--bytes-only')||firstOnly;
const calls=Number(args.find(arg=>arg.startsWith('--calls='))?.slice(8) ?? 100000);
assert.ok(Number.isSafeInteger(calls) && calls>=1000 && calls<=1000000);
function quota(index) {
  const record={schemaVersion:'quota-observation-v1.1',observationId:'quota-occurrence:v1:'+index.toString(16).padStart(64,'0'),
    observedTime:new Date(residueStart+index%86400000).toISOString(),provider:'openai_codex',planType:'pro',planVariant:'unknown',limitId:'codex',
    slot:index%2?'seven_day':'five_hour',usedPercent:index%101,windowDurationMinutes:index%2?10080:300,resetsAt:null,accountPlanAttribution:residueAttribution};
  return {methodVersion:'effective-telemetry-owner-day-v1',stream:'quota',participantId:'synthetic',ownerDigest:'a'.repeat(64),occurrenceId:record.observationId,
    eventTime:record.observedTime,eventTimeConflict:false,status:'compatible',sourceCount:1,sourceFormats:['v11'],sourceRowIds:[],sourceRecordKeys:[],recordJson:JSON.stringify(record)};
}
let sink=0;
async function timed(operation) {
  global.gc?.();const heapBefore=process.memoryUsage().heapUsed,loadBefore=loadavg(),gc=[];
  const observer=new PerformanceObserver(list=>gc.push(...list.getEntries()));observer.observe({entryTypes:['gc']});
  const start=performance.now(),result=await operation(),end=performance.now(),wallMs=end-start;
  const heapAfter=process.memoryUsage().heapUsed;
  await new Promise(resolve=>setTimeout(resolve,20));observer.disconnect();
  const observed=gc.filter(entry=>entry.startTime>=start && entry.startTime<=end);
  return {wallMs,netHeapDeltaBytes:heapAfter-heapBefore,minorCollections:observed.filter(entry=>entry.detail.kind===constants.NODE_PERFORMANCE_GC_MINOR).length,
    gcMs:observed.reduce((sum,entry)=>sum+entry.duration,0),loadBefore,loadAfter:loadavg(),result};
}
async function quotaAllocationMeasurements() {
  const child=spawnSync(process.execPath,['--expose-gc','--trace-gc-nvp',fileURLToPath(import.meta.url),
    '--allocation-child','--calls='+calls],{encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(child.status,0,'allocation child failed');
  const measurements={};let active=null;
  for(const line of child.stdout.split('\n')) {
    const start=line.match(/^PMR_ALLOCATION_START (vendored|memo-hit)$/),end=line.match(/^PMR_ALLOCATION_END (vendored|memo-hit)$/);
    if(start) {active=start[1];measurements[active]={allocatedBytes:0,scavenges:0,collections:0};continue;}
    if(end) {assert.equal(active,end[1]);active=null;continue;}
    if(active) {const allocated=line.match(/\ballocated=([0-9]+)/);if(allocated) {
      measurements[active].allocatedBytes+=Number(allocated[1]);measurements[active].collections++;
      if(/\bgc=s\b/.test(line)) measurements[active].scavenges++;
    }}
  }
  assert.ok(measurements.vendored.collections>0 && measurements['memo-hit'].collections>0);
  return measurements;
}
if(args.includes('--allocation-child')) {
  const h=await loadQuotaHarness();
  try {
    const rows=Array.from({length:1000},(_,index)=>quota(index)),escape=new Array(256);
    for(const row of rows) h.module.mapAnalyticsV2QuotaPageRow(row,residueDay,1);
    for(const [label,map] of [['vendored',h.module.mapEffectiveQuotaPageRow],['memo-hit',h.module.mapAnalyticsV2QuotaPageRow]]) {
      global.gc();process.stdout.write('PMR_ALLOCATION_START '+label+'\n');
      for(let index=0;index<calls;index++) escape[index&255]=map(rows[index%rows.length],residueDay,index+1);
      global.gc();process.stdout.write('PMR_ALLOCATION_END '+label+'\n');
    }
    sink^=escape[0].physicalId;
  }finally{await h.close();}
} else if(args.includes('--allocation-only')) {
  const measured=await quotaAllocationMeasurements();
  for(const [label,values] of Object.entries(measured)) console.log(JSON.stringify({part:'quota-allocation',label,calls,...values,
    allocatedBytesPerCall:values.allocatedBytes/calls,scavengesPerMillion:values.scavenges*1000000/calls,
    basis:'GC trace allocated bytes between forced collections; includes marker overhead',load:loadavg()}));
} else {
const quotaHarness=proofOnly?null:await loadQuotaHarness(),bytes=await loadReductionHarness({check:proofOnly}),oracle=proofOnly?null:await loadReductionHarness({oracle:true});
try {
  if(!proofOnly) {
    if(!bytesOnly) {
    const rows=Array.from({length:1000},(_,index)=>quota(index)),m=quotaHarness.module,escape=new Array(256);
    console.log(JSON.stringify({proof:'quota-differential',...compareQuotaRows(m,new Map([[residueDay,rows]]))}));
    const allocations=await quotaAllocationMeasurements();
    for(const [label,map] of [['vendored',m.mapEffectiveQuotaPageRow],['memo-hit',m.mapAnalyticsV2QuotaPageRow]]) {
      const measured=await timed(()=> {for(let index=0;index<calls;index++) escape[index&255]=map(rows[index%rows.length],residueDay,index+1);sink^=escape[calls&255]?.physicalId ?? 0;});
      delete measured.result;console.log(JSON.stringify({part:'quota-call',label,calls,usPerCall:measured.wallMs*1000/calls,
        scavengesPerMillion:measured.minorCollections*1000000/calls,allocatedBytesPerCall:allocations[label].allocatedBytes/calls,allocationBasis:'GC trace; marker overhead included',...measured}));
    }
    assert.equal(typeof global.gc,'function','Use --expose-gc for retained memo measurement');
    const retained=Array.from({length:100000},(_,index)=>quota(index+1000));global.gc();const before=process.memoryUsage().heapUsed;
    for(const row of retained) m.mapAnalyticsV2QuotaPageRow(row,residueDay,1);
    global.gc();const retainedBytes=process.memoryUsage().heapUsed-before;
    console.log(JSON.stringify({part:'quota-retained',rows:retained.length,retainedBytes,bytesPerRow:retainedBytes/retained.length,
      projectedBytesPerMillionRows:retainedBytes*10,load:loadavg()}));
    // Keep the row objects alive through the retained-size measurement.
    sink^=retained.length;
    }
    if(quotaOnly) process.exitCode=0;
    else {
    const mbytes=bytes.module;
    for(const entries of [1000,10000,50000,100000]) {
      const previous=new mbytes.ReductionByteMap(Array.from({length:entries},(_,index)=>['feature:'+index.toString(16).padStart(64,'0'),{time:residueStart+index,scope:residueAttribution.accountTrackId}]));
      const state=[previous,new mbytes.Hazards(),new mbytes.ReductionByteMap([]),new mbytes.ReductionByteMap([]),new mbytes.ReductionByteSet([])];
      const initial=await timed(()=>mbytes.reductionPayloadBytes(...state)),exact=initial.result;
      delete initial.result;console.log(JSON.stringify({part:'bytes-first-walk',entries,bytes:exact,...initial}));
      assert.equal(exact,payloadOracle(...state));
      if(firstOnly) continue;
      for(const [label,measure] of [['stringify-encode',()=>oracle.module.reductionPayloadBytes(...state)],['incremental',()=>mbytes.reductionPayloadBytes(...state)]]) {
        const result=await timed(()=> {for(let pass=0;pass<20;pass++) {
          const key='feature:'+(pass%entries).toString(16).padStart(64,'0');previous.get(key).time++;
          sink^=measure();
        }});delete result.result;console.log(JSON.stringify({part:'bytes',label,entries,evaluations:20,...result}));
      }
      assert.equal(mbytes.reductionPayloadBytes(...state),payloadOracle(...state));
    }
    if(!firstOnly) {
    const outcomes=[];
    for(const [label,module] of [['oracle',oracle.module],['incremental',bytes.module]]) {
      const measured=await timed(()=>residueReduce(module,200000,{maxPages:1024,sessionModulo:20000}));
      outcomes.push(measured.result.checkpoints);const result=measured.result;delete measured.result;
      console.log(JSON.stringify({part:'window',label,rows:200000,calls:result.calls,complete:result.state.complete,refusal:result.state.commonRefusal,
        checkpointSha256:result.checkpoints.at(-1),...measured}));
    }
    assert.deepEqual(outcomes[0],outcomes[1]);
    }
    }
  } else {
    for(const prepared of [false,true]) {
      bytes.module.reductionChecks.length=0;
      const result=await timed(()=>residueReduce(bytes.module,50000,{prepared,maxPages:3}));
      const state=result.result.state,checks=bytes.module.reductionChecks;delete result.result;
      assert.equal(state.commonRefusal,'reduced_usage_limit_exceeded');
      console.log(JSON.stringify({proof:'default-byte-bound',prepared,rows:state.rowsRead,pages:checks.length,
        comparisons:checks.length,mismatches:0,beforeBytes:checks.at(-2).bytes,refusalBytes:checks.at(-1).bytes,
        checkDigest:createHash('sha256').update(JSON.stringify(checks)).digest('hex'),...result}));
    }
  }
} finally {await quotaHarness?.close();await bytes.close();await oracle?.close();}

}
