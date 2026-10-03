#!/usr/bin/env node
/** Local synthetic reader differential harness. --fixture=<module> must export
 * a read-only context, owners, fromDay and throughDay; no raw rows are emitted.
 * Corpus import/clone and snapshot configuration remain coordinator-owned. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function loadQuotaHarness() {
  const directory=await mkdtemp(join(tmpdir(),'tibo-quota-check-')),outfile=join(directory,'quota.mjs');
  const mapFile=join(root,'vendor/analytics-d43c8f92/apps/worker/src/effective-quota-day.ts');
  try {
    await build({stdin:{contents:`export {mapAnalyticsV2QuotaPageRow} from './src/analytics-v2/native-path';
      export {readOwnerOccurrences} from './src/analytics-v2/occurrence-source';
      export {mapEffectiveQuotaPageRow, quotaHarnessCalls} from './vendor/analytics-d43c8f92/apps/worker/src/effective-quota-day';`,
      resolveDir:root,loader:'ts'},outfile,bundle:true,platform:'node',format:'esm',target:'node22',mainFields:['module','main'],logLevel:'silent',
      plugins:[{name:'quota-map-counter-harness-only',setup(builder){builder.onLoad({filter:/effective-quota-day\.ts$/},async(args)=> {
        if(args.path!==mapFile) return undefined;
        let contents=await readFile(args.path,'utf8');
        const needle='  day: string, ordinal: number): V11QuotaPageRow {';
        assert.equal(contents.split(needle).length-1,1);
        contents=contents.replace(needle,needle+'\n  quotaHarnessCallCounts.set(row,(quotaHarnessCallCounts.get(row) ?? 0)+1);');
        contents+='\nconst quotaHarnessCallCounts = new WeakMap<object, number>();\nexport function quotaHarnessCalls(row:object):number{return quotaHarnessCallCounts.get(row) ?? 0;}\n';
        return {contents,loader:'ts'};
      });}}]});
    return {module:await import(pathToFileURL(outfile).href),close:()=>rm(directory,{recursive:true,force:true})};
  }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
export function compareQuotaRows(module, days) {
  let rows=0,comparisons=0,mapMisses=0,maximumMisses=0;const digest=createHash('sha256');
  for(const [day,occurrences] of days) for(const row of occurrences) {
    let misses=0,prior;
    for(const ordinal of [1,43,200,Number.MAX_SAFE_INTEGER]) {
      const expected=module.mapEffectiveQuotaPageRow(row,day,ordinal),before=module.quotaHarnessCalls(row);
      const value=module.mapAnalyticsV2QuotaPageRow(row,day,ordinal);
      misses+=module.quotaHarnessCalls(row)-before;
      assert.equal(JSON.stringify(value),JSON.stringify(expected));
      assert.notEqual(value,prior);assert.notEqual(value.active,prior?.active);
      assert.equal(Object.isFrozen(value),Object.isFrozen(expected));assert.equal(Object.isFrozen(value.active),Object.isFrozen(expected.active));
      for(const primitive of Object.values(value.active)) assert.ok(primitive===null||['string','number','boolean'].includes(typeof primitive));
      digest.update(JSON.stringify(value));prior=value;comparisons++;
    }
    assert.ok(misses<=1);mapMisses+=misses;maximumMisses=Math.max(maximumMisses,misses);rows++;
  }
  return {rows,comparisons,mismatches:0,mapMisses,maximumMisses,meanMisses:rows?mapMisses/rows:0,sha256:digest.digest('hex')};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const fixtureArg=process.argv.slice(2).find(value=>value.startsWith('--fixture='));
  assert.ok(fixtureArg,'A coordinator-owned synthetic read-only context module is required');
  const fixture=await import(pathToFileURL(resolve(fixtureArg.slice('--fixture='.length))).href),loaded=await loadQuotaHarness();
  try {for(const ownerDigest of fixture.owners) {
    const days=await loaded.module.readOwnerOccurrences(fixture.context,{ownerDigest,stream:'quota',fromDay:fixture.fromDay,throughDay:fixture.throughDay});
    console.log(JSON.stringify(compareQuotaRows(loaded.module,days)));
  }}finally{await loaded.close();await fixture.close?.();}
}
