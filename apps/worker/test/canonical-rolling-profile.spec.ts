import {expect,it} from 'vitest';
import {canonicalRollingSqlProfile} from './helpers/canonical-rolling-profile';
import {logicalBytes} from './helpers/analytics-logical-bytes';
import {createAnalyticsProfile,profileAnalyticsDatabase} from './helpers/analytics-profile';

function fixtureDatabase(rows:unknown[],reads=1):D1Database {
 const results=()=>({results:rows,success:true,meta:{rows_read:reads,rows_written:0,duration:0}});
 const statement=(explain=false)=>{const value={bind:()=>value,
  all:async()=>explain?{...results(),results:[]}:results(),run:async()=>results()};return value;};
 return {prepare:(sql:string)=>statement(sql.startsWith('EXPLAIN')),
  batch:async(values:D1PreparedStatement[])=>values.map(()=>results())} as unknown as D1Database;
}
it('retains complete direct-history fingerprint/result aggregates beyond the top ten without bodies',async()=>{
 const profile=canonicalRollingSqlProfile(()=> 'warm');
 const metadata=profile.wrap(fixtureDatabase([{ownerRevision:1}]),'source');
 await metadata.prepare('SELECT ownerRevision FROM \"telemetry_v12_records\" WHERE id=?').bind('synthetic-private-bind').all();
 await metadata.prepare('SELECT ownerRevision FROM \"telemetry_v12_records\" WHERE id=?').bind('different-private-bind').first();
 const empty=profile.wrap(fixtureDatabase([]),'source');
 await empty.prepare('SELECT id FROM main.typed_telemetry_records WHERE id=?').bind('missing').all();
 const payload={record_json:'synthetic-body-never-retained'};
 const body=profile.wrap(fixtureDatabase([payload]),'source');
 await body.batch([body.prepare('SELECT record_json FROM telemetry_usage_correction_history WHERE id=?').bind(1)]);
 const other=profile.wrap(fixtureDatabase([{n:1}],100),'target');
 for(let index=0;index<12;index++)await other.prepare('SELECT n FROM analytics_distinct_'+index).all();
 const report=await profile.report();
 expect(report.top).toHaveLength(10);expect(report.top.every(entry=>entry.side==='target')).toBe(true);
 expect(report.rawPhysicalHistory).toHaveLength(3);
 expect(report.rawPhysicalHistory.reduce((sum,entry)=>sum+entry.statements,0)).toBe(4);
 const owner=report.rawPhysicalHistory.find(entry=>entry.statements===2)!;
 expect(owner).toMatchObject({returnedRows:2,emptyResults:0,resultShapeGaps:0,payloadBearingRows:0,resultBytes:2*logicalBytes([{ownerRevision:1}])});
 expect(report.rawPhysicalHistory.find(entry=>entry.emptyResults===1)).toMatchObject({returnedRows:0,resultBytes:logicalBytes([])});
 expect(report.rawPhysicalHistory.find(entry=>entry.payloadBearingRows===1)).toMatchObject({returnedRows:1,payloadBearingBytes:logicalBytes(payload)});
 for(const entry of report.rawPhysicalHistory)expect(entry.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
 const serialized=JSON.stringify(report);
 expect(serialized).not.toContain('synthetic-private-bind');expect(serialized).not.toContain('different-private-bind');
 expect(serialized).not.toContain('synthetic-body-never-retained');
 expect(report.rawPhysicalHistoryContract).toContain('indirect view expansions');
});

it('counts actual typed token, quota and session projections without retaining analytical values',async()=>{
 const profile=canonicalRollingSqlProfile(()=> 'cold');
 const payload={provider:'synthetic-provider-private',model:'synthetic-model-private',total_input_context_tokens:12,
  input_uncached_tokens:0,input_cache_read_tokens:4,input_cache_write_tokens:1,output_text_tokens:7,
  output_reasoning_tokens:2,output_combined_tokens:9,used_percent:42.5,window_duration_minutes:10080,
  resets_at_ms:1790000000000,boundary_flags:1,tie_order:0,cache_write_ttl_five_minute_tokens:1,
  cache_write_ttl_one_hour_tokens:0,session_id:new Uint8Array([1,2,3]),account_track:[4,5],plan_era:'synthetic-plan-private',
  tool_json:'{"synthetic-tool-private":2}',tool_class_counts:{'synthetic-tool-private':2},account_basis:1,plan_basis:2};
 const row={storage_row_id:7,stream:'usage',observed_day:Math.floor(Date.parse('2026-10-01T00:00:00.000Z')/86400000),canonical_digest:[10,11],...payload};
 await profile.wrap(fixtureDatabase([row],9),'source').prepare('SELECT r.* FROM telemetry_v12_records r').all();
 const report=await profile.report(),entry=report.rawPhysicalHistory[0]!;
 expect(entry).toMatchObject({statements:1,rowsRead:9,rowsWritten:0,returnedRows:1,resultBytes:logicalBytes([row]),
  payloadBearingRows:1,payloadBearingBytes:logicalBytes(payload),resultProjection:{contract:'direct-history-projection-v3',
   analyticalProjectionRows:1,metadataOnlyRows:0,unclassifiedRows:0,unclassifiedFields:0,invalidTypeFields:0,
   schemaUnobservedStatements:0,observedSchemaComplete:true,noRescanQualified:false}});
 for(const value of ['synthetic-provider-private','synthetic-model-private','synthetic-plan-private','synthetic-tool-private'])
  expect(JSON.stringify(report)).not.toContain(value);
});

it('counts physical, decoded and mixed day/basis representations under the v3 detector with exact analytical bytes',async()=>{
 const profile=canonicalRollingSqlProfile(()=> 'cold');
 // The typed v1/v1.1 foundation has no v1.2-only +/-100000 day constraint.
 // Typed v1.1 quota projections also mix text domain days and integer codes.
 const rows=[
  {observed_day:0,account_basis:0,plan_basis:0},
  {observed_day:-1,account_basis:1,plan_basis:1},
  {observed_day:120001,account_basis:2,plan_basis:2},
  {observed_day:'2026-10-01',account_basis:0,plan_basis:3},
  {observed_day:'2026-10-01',account_basis:'unavailable',plan_basis:'unavailable'},
  {observed_day:'2026-10-01',account_basis:'same_source',plan_basis:'same_source_occurrence'},
  {observed_day:'2026-10-01',account_basis:'provisional_marker',plan_basis:'provisional_marker'},
  {observed_day:'0000-02-29',account_basis:'same_source',plan_basis:'conflicted'},
 ];
 await profile.wrap(fixtureDatabase(rows,8),'source').prepare('SELECT projected.* FROM typed_telemetry_records projected').all();
 const report=await profile.report(),entry=report.rawPhysicalHistory[0]!;
 expect(entry).toMatchObject({returnedRows:8,resultBytes:logicalBytes(rows),payloadBearingRows:8,
  payloadBearingBytes:rows.reduce((sum,{account_basis,plan_basis})=>sum+logicalBytes({account_basis,plan_basis}),0),
  resultProjection:{contract:'direct-history-projection-v3',analyticalProjectionRows:8,metadataOnlyRows:0,
   unclassifiedRows:0,unclassifiedFields:0,invalidTypeFields:0,schemaUnobservedStatements:0,
   observedSchemaComplete:true,noRescanQualified:false}});
 expect(report.rawPhysicalHistoryContract).toContain('direct-history-projection-v3');
 expect(JSON.stringify(report)).not.toContain('direct-history-projection-v2');
});

it('preserves metadata-only days, nullable analytical fields and zero basis codes without admitting internal aliases',async()=>{
 const profile=canonicalRollingSqlProfile(()=> 'warm');
 const rows=[{observed_day:null},{observed_day:null,account_basis:null,plan_basis:null},
  {observed_day:0,account_basis:0,plan_basis:0},{observed_day_number:0,ownerRevision:1}];
 await profile.wrap(fixtureDatabase(rows,4),'source').prepare('SELECT nullable.* FROM typed_telemetry_records nullable').all();
 const entry=(await profile.report()).rawPhysicalHistory[0]!;
 expect(entry).toMatchObject({returnedRows:4,resultBytes:logicalBytes(rows),payloadBearingRows:1,
  payloadBearingBytes:logicalBytes({account_basis:0,plan_basis:0}),resultProjection:{contract:'direct-history-projection-v3',
   analyticalProjectionRows:2,metadataOnlyRows:1,unclassifiedRows:1,unclassifiedFields:1,invalidTypeFields:0,
   schemaUnobservedStatements:0,observedSchemaComplete:false,noRescanQualified:false}});
});

it('keeps every malformed day or basis representation explicit and retains only valid partial analytical bytes',async()=>{
 const profile=canonicalRollingSqlProfile(()=> 'cold');
 const invalid:[string,unknown][]=[
  ...[0.5,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER,100000000,true,{},[],undefined,'',
   '0','20727','2026-02-30','2026-13-01','2026-10-01T00:00:00.000Z','synthetic-invalid-day-private']
   .map(value=>['observed_day',value] as [string,unknown]),
  ...[-1,3,0.5,NaN,Infinity,true,{},[],undefined,'1','SAME_SOURCE','synthetic-invalid-account-private']
   .map(value=>['account_basis',value] as [string,unknown]),
  ...[-1,4,0.5,NaN,Infinity,true,{},[],undefined,'2','same_source','synthetic-invalid-plan-private']
   .map(value=>['plan_basis',value] as [string,unknown]),
 ];
 const rows:Record<string,unknown>[]=invalid.map(([column,value])=>({ownerRevision:1,[column]:value}));
 rows.push({ownerRevision:1,account_basis:3,input_uncached_tokens:0});
 await profile.wrap(fixtureDatabase(rows,rows.length),'source').prepare('SELECT malformed.* FROM telemetry_v12_records malformed').all();
 const report=await profile.report(),entry=report.rawPhysicalHistory[0]!;
 expect(entry).toMatchObject({returnedRows:rows.length,resultBytes:logicalBytes(rows),payloadBearingRows:1,
  payloadBearingBytes:logicalBytes({input_uncached_tokens:0}),resultProjection:{contract:'direct-history-projection-v3',
   analyticalProjectionRows:1,metadataOnlyRows:0,unclassifiedRows:rows.length,unclassifiedFields:0,
   invalidTypeFields:rows.length,schemaUnobservedStatements:0,observedSchemaComplete:false,noRescanQualified:false}});
 for(const value of ['synthetic-invalid-day-private','synthetic-invalid-account-private','synthetic-invalid-plan-private'])
  expect(JSON.stringify(report)).not.toContain(value);
});

it('keeps complete owner/authority/readiness projections metadata and null analytical projections explicit',async()=>{
 const profile=canonicalRollingSqlProfile(()=> 'warm');
 const owner={participantId:'synthetic-participant-private',ownerDigest:'synthetic-owner-private',inputRevision:2,
  ownerRevision:3,authorityEpoch:4,hasV1:1,hasV11:1,hasV12:1,hasEffective:1,hasLegacy:0};
 await profile.wrap(fixtureDatabase([owner]),'source').prepare('SELECT owner.* FROM telemetry_v1_chunks owner').all();
 await profile.wrap(fixtureDatabase([{member_count:2,identified_count:2}]),'source')
  .prepare('SELECT counts.* FROM telemetry_v1_chunks counts').all();
 await profile.wrap(fixtureDatabase([{input_uncached_tokens:null,used_percent:null,tool_json:null,ownerRevision:3}]),'source')
  .prepare('SELECT nullable.* FROM typed_telemetry_records nullable').all();
 const report=await profile.report();
 expect(report.rawPhysicalHistory.filter(entry=>entry.resultProjection.metadataOnlyRows===1)).toHaveLength(2);
 for(const entry of report.rawPhysicalHistory)expect(entry).toMatchObject({payloadBearingRows:0,payloadBearingBytes:0,
  resultProjection:{unclassifiedRows:0,observedSchemaComplete:true,noRescanQualified:false}});
 expect(report.rawPhysicalHistory.find(entry=>entry.resultProjection.analyticalProjectionRows===1)?.resultProjection.metadataOnlyRows).toBe(0);
 expect(JSON.stringify(report)).not.toContain('synthetic-participant-private');
 expect(JSON.stringify(report)).not.toContain('synthetic-owner-private');
});

it('does not qualify unknown aliases, malformed typed values or empty result schemas',async()=>{
 const profile=canonicalRollingSqlProfile(()=> 'warm');
 await profile.wrap(fixtureDatabase([{unrecognized_private_alias:'synthetic-unknown-private',ownerRevision:1,input_uncached_tokens:0}]),'source')
  .prepare('SELECT mixed.* FROM typed_telemetry_records mixed').all();
 await profile.wrap(fixtureDatabase([{input_cache_read_tokens:'synthetic-malformed-private',ownerRevision:'bad-number',
  tool_class_counts:{bad:-1},session_id:[-1]}]),'source').prepare('SELECT malformed.* FROM telemetry_v12_records malformed').all();
 await profile.wrap(fixtureDatabase([]),'source').prepare('SELECT empty.* FROM telemetry_v1_records empty').all();
 await profile.wrap(fixtureDatabase([{},null,[]]),'source').prepare('SELECT unknown.* FROM telemetry_v1_records unknown').all();
 const report=await profile.report();
 const mixed=report.rawPhysicalHistory.find(entry=>entry.resultProjection.unclassifiedFields===1)!;
 expect(mixed).toMatchObject({payloadBearingRows:1,payloadBearingBytes:logicalBytes({input_uncached_tokens:0}),
  resultProjection:{analyticalProjectionRows:1,metadataOnlyRows:0,unclassifiedRows:1,invalidTypeFields:0,observedSchemaComplete:false}});
 expect(report.rawPhysicalHistory.find(entry=>entry.resultProjection.invalidTypeFields===4)).toMatchObject({payloadBearingRows:0,
  resultProjection:{metadataOnlyRows:0,unclassifiedRows:1,observedSchemaComplete:false}});
 expect(report.rawPhysicalHistory.find(entry=>entry.emptyResults===1)).toMatchObject({returnedRows:0,resultShapeGaps:0,
  resultProjection:{schemaUnobservedStatements:1,observedSchemaComplete:false}});
 expect(report.rawPhysicalHistory.find(entry=>entry.resultShapeGaps===2)).toMatchObject({returnedRows:3,
  resultProjection:{metadataOnlyRows:0,unclassifiedRows:3,observedSchemaComplete:false}});
 for(const entry of report.rawPhysicalHistory)expect(entry.resultProjection.noRescanQualified).toBe(false);
 for(const value of ['unrecognized_private_alias','synthetic-unknown-private','synthetic-malformed-private'])
  expect(JSON.stringify(report)).not.toContain(value);
});

it('keeps indirect-view reads outside direct fingerprints and failed SQL in the owning resource meter',async()=>{
 const diagnostic=canonicalRollingSqlProfile(()=> 'warm');
 await diagnostic.wrap(fixtureDatabase([{input_uncached_tokens:7}]),'source')
  .prepare('SELECT * FROM typed_telemetry_compatibility_records').all();
 const profile=createAnalyticsProfile();
 const failure={prepare:()=>({all:async()=>{throw new Error('synthetic query failure');}})} as unknown as D1Database;
 const measured=profileAnalyticsDatabase(diagnostic.wrap(failure,'source'),'source',profile,()=> 'warm');
 await expect(measured.prepare('SELECT * FROM telemetry_v12_records').all()).rejects.toThrow('synthetic query failure');
 const report=await diagnostic.report();
 expect(report.rawPhysicalHistory).toEqual([]);
 expect(report.classes['warm.source.source_selected_data']).toMatchObject({statements:1,rowsRead:1,rowsWritten:0});
 expect(Object.values(profile.costs)).toMatchObject([{statements:1,failedStatements:1,metadataSamples:0,rawHistoryAccessStatements:1}]);
 expect(report.rawPhysicalHistoryContract).toContain('indirect view expansions');
 expect(report.rawPhysicalHistoryContract).toContain('unknown resource dimensions');
 expect(report.rawPhysicalHistoryContract).toContain('zero detected payload never establishes no-rescan');
});
