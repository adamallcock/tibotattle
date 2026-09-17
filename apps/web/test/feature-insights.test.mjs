import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleCacheImpact, exampleModelSpeeds } from '../public/feature-insights.js';
import { cacheReuseMatrixBuckets } from '../public/cache-reuse-matrix.js';
import { normalizeModelPerformance } from '../public/model-performance.js';
test('synthetic cohorts satisfy the real cache matrix contract and preserve volumes',()=>{
 const impact=exampleCacheImpact(); const rows=cacheReuseMatrixBuckets(impact);
 assert.equal(rows.length,9); assert.equal(rows.at(-1).endSeconds,null);
 assert.equal(impact.byModel.reduce((n,m)=>n+m.comparableReturns,0),impact.comparableReturns);
 for(const model of impact.byModel)assert.equal(cacheReuseMatrixBuckets(model).length,9);
});
test('all example speed periods satisfy the actual closed app contract',()=>{
 for(const period of ['7','30','all']) {const payload=exampleModelSpeeds(period);assert.equal(normalizeModelPerformance(payload),payload);}
});
test('changing period preserves the same daily observations and varying sample sizes',()=>{
 const week=exampleModelSpeeds('7'),month=exampleModelSpeeds('30');
 for(let i=0;i<week.models.length;i++) {
  assert.deepEqual(week.models[i].speed[0].points,month.models[i].speed[0].points.slice(-7));
  assert.deepEqual(week.models[i].ttft,month.models[i].ttft.slice(-7));
  assert.ok(new Set(month.models[i].speed[0].points.map(p=>p.n)).size>10);
 }
});
