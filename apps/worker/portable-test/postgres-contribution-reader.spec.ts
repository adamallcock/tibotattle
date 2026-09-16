import { describe, expect, it } from "vitest";
import { createExperimentalPostgresTelemetryV1ContributionReader } from "../src/postgres-telemetry-v1-contribution-reader";
import type { PostgresTelemetryV1QueryResult } from "../src/postgres-telemetry-v1-contribution-store";

const row = { id: "synthetic-chunk", participant_id: "synthetic-owner", device_id: "synthetic-device",
  stream: "usage", chunk_day: "2026-09-01", chunk_seq: 0, revision: 1, chunk_digest: "a".repeat(64),
  record_count: 2, accepted_records: 2, superseded_at: null };
const identity = {participantId:"synthetic-owner",deviceId:"synthetic-device",stream:"usage" as const,chunkDay:"2026-09-01",chunkSeq:0};
function fixture(result: PostgresTelemetryV1QueryResult = {rows:[row],rowCount:1}, fail?: string, rollbackFails=false) {
  const queries: Array<{sql:string;values?:unknown[]}> = [], releases:boolean[]=[];
  const reader=createExperimentalPostgresTelemetryV1ContributionReader({async connect(){return {
    async query(sql,values){
      queries.push({sql,values});
      if(sql===fail || (sql==='ROLLBACK' && rollbackFails)) throw new Error('synthetic-private-driver-details');
      return sql.startsWith('SELECT') ? result : {rows:[],rowCount:null};
    }, release(discard){releases.push(Boolean(discard));},
  };}});
  return {reader,queries,releases};
}
describe('PostgreSQL contribution read boundary',()=>{
  it('returns only portable fields using a read-only bounded transaction',async()=>{
    const f=fixture();
    expect(await f.reader.current(identity)).toEqual({id:row.id,...identity,revision:1,chunkDigest:row.chunk_digest,
      recordCount:2,acceptedRecords:2,supersededAt:null});
    expect(f.queries.map(q=>q.sql).slice(0,3)).toEqual(['BEGIN READ ONLY',"SET LOCAL statement_timeout='10s'","SET LOCAL lock_timeout='5s'"]);
    expect(f.queries[3]!.values).toEqual(Object.values(identity));
    expect(f.queries.at(-1)!.sql).toBe('COMMIT');expect(f.releases).toEqual([false]);
  });
  it('binds participant envelope scope and retains superseded status',async()=>{
    const f=fixture({rows:[{...row,superseded_at:'2026-09-15 12:00:00+00'}],rowCount:1});
    expect((await f.reader.byEnvelope('synthetic-owner','synthetic-envelope'))?.supersededAt).not.toBeNull();
    expect(f.queries[3]!.values).toEqual(['synthetic-owner','synthetic-envelope']);
  });
  it('returns null only for proven absence',async()=>{
    const f=fixture({rows:[],rowCount:0});expect(await f.reader.current(identity)).toBeNull();
    expect(await f.reader.byEnvelope('synthetic-owner','missing')).toBeNull();
  });
  it.each([null,'2026-09-01'])('reads acknowledged-through %s',async value=>{
    const f=fixture({rows:[{through_day:value}],rowCount:1});
    expect(await f.reader.acknowledgedThroughDay('synthetic-owner','synthetic-device')).toBe(value);
  });
  it.each([
    {rows:[row,row],rowCount:2}, {rows:[row],rowCount:0}, {rows:[null],rowCount:1},
    {rows:[{...row,chunk_day:'2026-02-30'}],rowCount:1},
    {rows:[{...row,accepted_records:3}],rowCount:1},
    {rows:[{...row,record_count:201}],rowCount:1},
    {rows:[{...row,stream:'unknown'}],rowCount:1},
    {rows:[{...row,superseded_at:'invalid'}],rowCount:1},
  ])('rejects malformed or ambiguous storage evidence %#',async result=>{
    const f=fixture(result as PostgresTelemetryV1QueryResult);
    await expect(f.reader.current(identity)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
    expect(f.queries.at(-1)?.sql).toBe('ROLLBACK');expect(f.releases).toEqual([false]);
  });
  it('does not turn a missing aggregate response into unknown acknowledgement',async()=>{
    const f=fixture({rows:[],rowCount:0});
    await expect(f.reader.acknowledgedThroughDay('synthetic-owner','synthetic-device')).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  });
  it.each(['BEGIN READ ONLY','COMMIT'])('sanitizes failures at %s without retry',async sql=>{
    const f=fixture(undefined,sql);
    await expect(f.reader.current(identity)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE',message:'BACKEND_STORAGE_UNAVAILABLE'});
    expect(f.releases).toEqual([sql==='COMMIT']);
    expect(f.queries.filter(q=>q.sql===sql)).toHaveLength(1);
  });
  it('discards a connection when rollback fails',async()=>{
    const f=fixture({rows:[row,row],rowCount:2},undefined,true);
    await expect(f.reader.current(identity)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
    expect(f.releases).toEqual([true]);
  });
  it('captures identity before waiting for a connection',async()=>{
    const mutable={...identity};const f=fixture();const pending=f.reader.current(mutable);mutable.participantId='changed';
    await pending;expect(f.queries[3]!.values?.[0]).toBe('synthetic-owner');
  });
  it('sanitizes synchronous pool acquisition failures',async()=>{
    const reader=createExperimentalPostgresTelemetryV1ContributionReader({connect(){throw new Error('synthetic-secret');}});
    await expect(reader.current(identity)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  });
});
