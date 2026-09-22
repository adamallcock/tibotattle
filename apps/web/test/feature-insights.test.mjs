import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheImpactFromHostedCurve, cacheImpactFromHostedWindow, exampleCacheImpact, exampleModelSpeeds, hostedCacheWindow } from '../public/feature-insights.js';
import { cacheReuseMatrixBuckets } from '../public/cache-reuse-matrix.js';
import { normalizeModelPerformance } from '../public/model-performance.js';
test('synthetic cohorts satisfy the real cache matrix contract and preserve volumes',()=>{
 const impact=exampleCacheImpact(); const rows=cacheReuseMatrixBuckets(impact);
 // Ten buckets, each rendered as measured. The previous vocabulary ended in
 // two day-scale buckets merged back together for display; this one ends in
 // the single bucket the hosted evidence is actually cut into.
 assert.equal(rows.length,10);
 // The last bucket is CLOSED at the seven-day lookback. A null end would claim
 // gaps the lane cannot measure at all.
 assert.equal(rows.at(-1).endSeconds,604_800);
 assert.deepEqual(rows.map(row=>row.id),['under_one_minute','one_to_two_minutes','two_to_five_minutes',
  'five_to_ten_minutes','ten_to_thirty_minutes','thirty_minutes_to_one_hour','one_to_two_hours',
  'two_to_six_hours','six_to_twenty_four_hours','over_twenty_four_hours']);
 // Contiguous and disjoint: each bucket starts where the previous one ends, so
 // no gap is counted twice and none falls between two buckets.
 for(let i=1;i<rows.length;i++)assert.equal(rows[i].startSeconds,rows[i-1].endSeconds);
 assert.equal(rows[0].startSeconds,0);
 assert.equal(impact.byModel.reduce((n,m)=>n+m.comparableReturns,0),impact.comparableReturns);
 for(const model of impact.byModel)assert.equal(cacheReuseMatrixBuckets(model).length,10);
});
test('all example speed periods satisfy the actual closed app contract',()=>{
 for(const period of ['7','30','all']) for(const speedMode of ['standard','fast']) {const payload=exampleModelSpeeds(period,speedMode);assert.equal(normalizeModelPerformance(payload),payload);assert.equal(payload.speedMode,speedMode);if(speedMode==='fast')assert.deepEqual(payload.models,[]);}
});
test('changing period preserves the same daily observations and varying sample sizes',()=>{
 const week=exampleModelSpeeds('7'),month=exampleModelSpeeds('30');
 for(let i=0;i<week.models.length;i++) {
  assert.deepEqual(week.models[i].speed[0].points,month.models[i].speed[0].points.slice(-7));
  assert.deepEqual(week.models[i].ttft,month.models[i].ttft.slice(-7));
  assert.ok(new Set(month.models[i].speed[0].points.map(p=>p.n)).size>10);
 }
});

const hostedBand=(band,startMs,endMs,adjacencies,reused,matched)=>({band,startMs,endMs,adjacencies,
 reusedMoreThanHalf:reused,matchedOrExceeded:matched,sessions:1,contributors:1,
 reusedMoreThanHalfRate:adjacencies?reused/adjacencies:null,
 matchedOrExceededRate:adjacencies?matched/adjacencies:null,
 topContributorShare:adjacencies?1:null,excludedInsufficientEvidence:0,
 excludedContextContracted:0,unorderedTies:0});
const hostedCurve=(overrides={})=>({schemaVersion:'community-cache-retention-v1.0',
 metric:'cache_retention_by_pause',methodVersion:'cache-retention-v2',
 measures:'consecutive_requests',gapBasis:'response_end_to_response_end',
 bands:[[0,60_000,100,99,70],[60_000,120_000,50,49,30],[120_000,300_000,40,38,20],
  [300_000,600_000,30,28,14],[600_000,1_800_000,20,13,6],[1_800_000,3_600_000,10,7,3],
  [3_600_000,7_200_000,8,4,2],[7_200_000,21_600_000,6,2,1],
  [21_600_000,86_400_000,4,1,0],[86_400_000,604_800_000,0,0,0]]
  .map(([startMs,endMs,n,more,matched],index)=>hostedBand(
   ['under_one_minute','one_to_two_minutes','two_to_five_minutes','five_to_ten_minutes',
    'ten_to_thirty_minutes','thirty_minutes_to_one_hour','one_to_two_hours','two_to_six_hours',
    'six_to_twenty_four_hours','over_twenty_four_hours'][index],startMs,endMs,n,more,matched)),
 ...overrides});

test('the hosted curve maps onto the matrix contract without inventing a number',()=>{
 const impact=cacheImpactFromHostedCurve(hostedCurve());
 // The real renderer accepting it IS the assertion: every sum, every boundary
 // and every disjointness rule in `cacheReuseMatrixBuckets` has to hold.
 const rows=cacheReuseMatrixBuckets(impact);
 assert.equal(rows.length,10);
 assert.equal(rows.at(-1).endSeconds,604_800);
 // A rename and a unit change, never a regrouping: the band a gap was measured
 // in is the band it is drawn in.
 assert.equal(rows[0].comparableReturns,100);
 assert.equal(rows[0].reusedMoreThanHalfReturns,99);
 assert.equal(rows[6].startSeconds,3_600);
 assert.equal(rows[6].endSeconds,7_200);
 // An empty band stays empty rather than borrowing from its neighbour.
 assert.equal(rows.at(-1).comparableReturns,0);
 // Nothing the hosted lane cannot see is claimed: no pricing evidence exists
 // behind a hosted gap, so the premium is absent rather than zero.
 assert.equal(impact.estimatedPremiumUsd,null);
 assert.equal(impact.coverageStatus,'incomplete');
});

test('an inconsistent or foreign hosted curve is refused rather than clamped',()=>{
 assert.equal(cacheImpactFromHostedCurve(null),null);
 assert.equal(cacheImpactFromHostedCurve({bands:[]}),null);
 // Turn-scoped evidence would be a different measurement wearing the same
 // shape, and must never be drawn under this caption.
 assert.equal(cacheImpactFromHostedCurve(hostedCurve({measures:'user_turns'})),null);
 // Parts that cannot add up are an upstream fault, not a rounding artefact:
 // clamping them would publish a figure nothing measured.
 const overReused=hostedCurve();
 overReused.bands[0]={...overReused.bands[0],reusedMoreThanHalf:101};
 assert.equal(cacheImpactFromHostedCurve(overReused),null);
 const overMatched=hostedCurve();
 overMatched.bands[0]={...overMatched.bands[0],matchedOrExceeded:100};
 assert.equal(cacheImpactFromHostedCurve(overMatched),null);
});

const hostedSeries=(overrides={})=>({measures:'consecutive_requests',
 windows:[{window:'all',days:null,modelsTruncated:false,bands:hostedCurve().bands,
  byModel:[{model:'gpt-5.6-sol',bands:hostedCurve().bands},
   {model:'gpt-5.6-terra',bands:hostedCurve().bands}]},
  {window:'week',days:7,modelsTruncated:false,
   bands:hostedCurve().bands.map(b=>({...b,adjacencies:0,reusedMoreThanHalf:0,matchedOrExceeded:0})),
   byModel:[]}],
 ...overrides});

test('a window is selected by name and never silently substituted',()=>{
 const series=hostedSeries();
 assert.equal(hostedCacheWindow(series,'all').window,'all');
 // A span the series does not carry returns null rather than another span:
 // a reader who chose 7 days must never be shown all time under that label.
 assert.equal(hostedCacheWindow(series,'month'),null);
 assert.equal(hostedCacheWindow({measures:'user_turns',windows:[]},'all'),null);
 assert.equal(hostedCacheWindow(null,'all'),null);
});

test('per-model cohorts go through the same contract as the pooled figure',()=>{
 const impact=cacheImpactFromHostedWindow(hostedCacheWindow(hostedSeries(),'all'));
 assert.equal(cacheReuseMatrixBuckets(impact).length,10);
 assert.deepEqual(impact.byModel.map(m=>m.model),['gpt-5.6-sol','gpt-5.6-terra']);
 // A cohort has to satisfy the whole contract, not a weaker one.
 for(const cohort of impact.byModel)assert.equal(cacheReuseMatrixBuckets(cohort).length,10);
 // A cohort that cannot be mapped is dropped; the pooled curve is still true
 // and the picker simply will not offer that model.
 const broken=hostedSeries();
 broken.windows[0].byModel[1].bands=broken.windows[0].byModel[1].bands.map(
  (b,i)=>i===0?{...b,reusedMoreThanHalf:b.adjacencies+1}:b);
 const partial=cacheImpactFromHostedWindow(hostedCacheWindow(broken,'all'));
 assert.deepEqual(partial.byModel.map(m=>m.model),['gpt-5.6-sol']);
 assert.ok(partial.comparableReturns>0);
 // An empty window maps to zero rather than to null, so the caller can say
 // "nothing measured in this period" instead of falling back to another.
 const empty=cacheImpactFromHostedWindow(hostedCacheWindow(hostedSeries(),'week'));
 assert.equal(empty.comparableReturns,0);
});
