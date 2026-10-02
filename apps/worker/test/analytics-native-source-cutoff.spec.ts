import {expect,it} from 'vitest';
import {native,candidate,setupLegacyFunctional,source,sourceNamespace} from './helpers/analytics-functional-qualification';
const golden=it.skipIf(!native.publicationClockAdapted||!candidate.publicationClockAdapted);
golden('applies the native exclusive cutoff to genuinely accepted typed usage and quota at -1ms, equality, and +1ms',async()=>{
 const fixture=await setupLegacyFunctional(),from=new Date(fixture.cutoff-101*86400000).toISOString();
 const outputs=[];
 for(const kernel of [native,candidate]){
  const pin=await kernel.loadV11SourcePin(source,fixture.participantId);if(!pin)throw Error('FUNCTIONAL_V11_PIN_MISSING');expect(pin.source).toBe('v1.1');
  const samples=[];
  for(const toMs of [fixture.cutoff,fixture.cutoff+1,fixture.cutoff+2]){
   const usage=[];
   for(const day of fixture.days){
    const rows=await kernel.readTypedV11UsageAnalysisPage(source,{sourceNamespace,pin,day,from,to:new Date(toMs).toISOString(),
     afterTime:new Date(Date.parse(from)-1).toISOString(),afterOccurrence:'',pageSize:64});usage.push(...rows);
   }
   expect(usage.map(row=>Date.parse(row.observed_at))).toEqual(fixture.expectedUsageTimes.filter(ms=>ms<toMs));
   const quota=await kernel.createTypedV11QuotaPageReader(source,{sourceNamespace,pin,fromObservedAtMs:Date.parse(from),beforeObservedAtMs:toMs});
   const rows=await quota.readPage({observedAtMs:Date.parse(from)-1,sourceRowId:0},64);
   expect(rows.map(row=>row.observedAtMs)).toEqual(fixture.expectedQuotaTimes.filter(ms=>ms<toMs));
   samples.push({usage,quota:rows});
  }
  outputs.push(samples);
 }
 expect(outputs[1]).toEqual(outputs[0]);
 expect(outputs[0]!.map(value=>value.usage.length)).toEqual([3,4,5]);
 expect(outputs[0]!.map(value=>value.quota.length)).toEqual([2,3,4]);
 console.log('accepted-source-cutoff-proof',JSON.stringify({source:'accepted-typed-v1.1',selection:'legacy-selected-v1',
  offsetsMs:[0,1,2],usageCounts:[3,4,5],quotaCounts:[2,3,4],exactNativeParity:true,publicationClockNormalization:false}));
},60000);
