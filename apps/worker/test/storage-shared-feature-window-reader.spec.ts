import { beforeEach, expect, it, vi } from 'vitest';
import { appendSharedAnalyticsFeaturePage, createSharedAnalyticsFeaturePending,
  finishSharedAnalyticsFeatureDay } from '../src/analytics-shared-features';
import { canonicalJson } from '../src/canonical-json';
import { sha256Hex } from '../src/crypto';
import { D1InvocationBudgetExceededError } from '../src/d1-invocation-budget';
import { createEffectiveHistoryDayDependencyReader } from '../src/storage-effective-history';
import { readSharedAnalyticsFeatureWindow, type SharedAnalyticsFeatureInput } from '../src/storage-analytics-shared-features';

vi.mock('../src/storage-effective-history',()=>({assertEffectiveHistoryOwner:vi.fn(async()=>{}),
  createEffectiveHistoryDayDependencyReader:vi.fn(),effectiveHistoryDependency:vi.fn()}));
const makeReader=vi.mocked(createEffectiveHistoryDayDependencyReader);
const day='2026-09-30',digest='a'.repeat(64);
beforeEach(()=>vi.clearAllMocks());

async function fixture() {
  const owner:SharedAnalyticsFeatureInput['owner']={participantId:'synthetic',ownerDigest:'b'.repeat(64),
    inputRevision:1,ownerRevision:1,authorityEpoch:1,hasV1:false,hasV11:true,hasV12:false,
    hasLegacy:false,hasEffective:true};
  let pending=createSharedAnalyticsFeaturePending(day,owner.ownerDigest);
  for(const stream of ['usage','quota','session'] as const)
    pending=await appendSharedAnalyticsFeaturePage(pending,stream,[],null);
  const value=await finishSharedAnalyticsFeatureDay(pending);
  const payload=canonicalJson({kind:'complete',value}),payloadDigest=await sha256Hex(payload);
  const job={job_key:'synthetic-job',day,dependency_digest:digest,head_revision:1,state:'complete',
    payload_digest:payloadDigest,payload_bytes:new TextEncoder().encode(payload).byteLength,part_count:1};
  let targetReady=true,headRevision=1;
  const source={prepare:()=>({bind(){return this;},first:async()=>({input_revision:1,owner_revision:1,authority_epoch:1})})} as unknown as D1Database;
  const target={prepare:(sql:string)=>({bind(){return this;},first:async()=>{
    if(sql.includes('sqlite_schema'))return sql.includes('sweep_cursor')?1:3;
    if(sql.includes('analytics_owner_state'))return targetReady?1:null;
    throw new Error('unexpected fake first');
  },all:async()=>({results:sql.includes('SELECT * FROM analytics_shared_feature_days')?[job]
    :sql.includes('SELECT p.job_key')?[{job_key:job.job_key,revision:1,part_index:0,payload,
      payload_bytes:job.payload_bytes,payload_digest:payloadDigest}]
    :sql.includes('SELECT job_key,head_revision')?[{...job,head_revision:headRevision}]
    :(()=>{throw new Error('unexpected fake all');})()})})} as unknown as D1Database;
  return {value,input:{source,target,sourceId:'synthetic',sourceNamespace:'synthetic',owner,days:[day],
    budget:{remainingQueries:()=>950,deadlineMs:Date.now()+60_000,now:Date.now}},
    revoke:()=>{targetReady=false;},replaceHead:()=>{headRevision=2;}};
}

it('reuses the maintained reader but acquires a second full sealed digest batch',async()=>{
  const {value,input}=await fixture();
  const sealed=vi.fn(async()=>[digest]);
  makeReader.mockResolvedValue({readDigest:vi.fn(),readDigests:sealed});
  expect(await readSharedAnalyticsFeatureWindow(input)).toEqual({state:'complete',values:[value],dependencyDigests:[digest]});
  expect(makeReader).toHaveBeenCalledTimes(1);expect(sealed).toHaveBeenCalledTimes(2);
  expect(makeReader).toHaveBeenCalledWith(input.source,input.owner,input.sourceNamespace,input.days,
    {includeSessions:true,occurrenceLinks:'batched',canContinue:expect.any(Function)});
});

it.each(['changed','expired','budget'] as const)('does not return loaded values when the second maintained seal is %s',async boundary=>{
  const {input}=await fixture();
  const sealed=vi.fn<()=>Promise<readonly string[]|undefined>>().mockResolvedValueOnce([digest]);
  if(boundary==='budget')sealed.mockRejectedValueOnce(new D1InvocationBudgetExceededError());
  else sealed.mockResolvedValueOnce(boundary==='changed'?['c'.repeat(64)]:undefined);
  makeReader.mockResolvedValue({readDigest:vi.fn(),readDigests:sealed});
  if(boundary==='budget')await expect(readSharedAnalyticsFeatureWindow(input)).rejects.toBeInstanceOf(D1InvocationBudgetExceededError);
  else expect(await readSharedAnalyticsFeatureWindow(input)).toEqual({state:'deferred',reason:'source_changed'});
  expect(makeReader).toHaveBeenCalledTimes(1);expect(sealed).toHaveBeenCalledTimes(2);
});

it.each([false,true])('constructs a fresh native verification reader, changed=%s',async changed=>{
  const {value,input}=await fixture();
  makeReader.mockResolvedValueOnce({readDigest:vi.fn(async()=>digest)})
    .mockResolvedValueOnce({readDigest:vi.fn(async()=>changed?'c'.repeat(64):digest)});
  expect(await readSharedAnalyticsFeatureWindow(input)).toEqual(changed
    ?{state:'deferred',reason:'source_changed'}:{state:'complete',values:[value],dependencyDigests:[digest]});
  expect(makeReader).toHaveBeenCalledTimes(2);
});

it.each(['erasure','head'] as const)('retains target %s refusal before the final maintained seal',async boundary=>{
  const f=await fixture();
  makeReader.mockResolvedValue({readDigest:vi.fn(),readDigests:async()=>{
    if(boundary==='erasure')f.revoke();else f.replaceHead();return [digest];}});
  expect(await readSharedAnalyticsFeatureWindow(f.input)).toEqual({state:'deferred',reason:'source_changed'});
});
