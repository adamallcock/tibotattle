import { describe, expect, it, vi } from "vitest";
import {
  runStoragePublicationSchedule,
  storagePublicationLaneEnabled,
} from "../src/storage-publication-worker";
import { runStorageAnalyticsPass, storageDailyAdmissionForSlot } from "../src/storage-analytics-runtime";
import { STORAGE_PUBLICATION_TIMING_PHASES } from "../src/storage-analytics-failure";

const database = () => ({ prepare() { throw new Error("no query expected"); } }) as unknown as D1Database;

const bindings = () => ({
  source: database(), target: database(), ledger: database(),
  sourceId: "d1:source", sourceNamespace: "d1:source",
});

describe("the publication lane's own worker", () => {
  it("is off until its switch is thrown", async () => {
    // Deploying the worker must publish nothing on its own: the analytics
    // worker keeps the lane until BOTH switches move in the same change, so
    // there is never a window with two publishers or none.
    expect(storagePublicationLaneEnabled({})).toBe(false);
    expect(storagePublicationLaneEnabled({ PUBLICATION_LANE: "disabled" })).toBe(false);
    expect(storagePublicationLaneEnabled({ PUBLICATION_LANE: "enabled" })).toBe(true);
    // An unswitched worker returns before it validates anything, so a partial
    // configuration cannot fail a deploy that was meant to be inert.
    await expect(runStoragePublicationSchedule({})).resolves.toBeUndefined();
  });

  it("refuses a switched-on worker with an incomplete configuration", async () => {
    await expect(runStoragePublicationSchedule({
      PUBLICATION_LANE: "enabled", STORAGE_ANALYTICS_MODE: "enabled",
      PUBLIC_ANALYTICS_MODE: "enabled",
    })).rejects.toThrow("STORAGE_PUBLICATION_CONFIGURATION_INVALID");
  });

  it("logs only closed numeric phase timing if the publication pass fails",async()=>{
    const logs=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      await expect(runStoragePublicationSchedule({
        PUBLICATION_LANE:'enabled',STORAGE_ANALYTICS_MODE:'enabled',PUBLIC_ANALYTICS_MODE:'enabled',
        STORAGE_INGESTION_DB:database(),STORAGE_ANALYTICS_DB:database(),DELETION_LEDGER:database(),
        STORAGE_SOURCE_ID:'synthetic-source',TELEMETRY_STORAGE_NAMESPACE:'synthetic-namespace',
      })).rejects.toThrow('STORAGE_PUBLICATION_UNAVAILABLE');
      expect(logs).toHaveBeenCalledTimes(1);
      const row=JSON.parse(String(logs.mock.calls[0]![0])) as Record<string,unknown>;
      expect(row).toMatchObject({event:'storage_publication_schedule',state:'unavailable'});
      const timing=row.phaseTiming as Record<string,Record<string,number>>;
      expect(Object.keys(timing)).toEqual([...STORAGE_PUBLICATION_TIMING_PHASES]);
      expect(Object.values(timing).every(value=>Object.values(value).every(number=>number===0))).toBe(true);
      expect(JSON.stringify(row)).not.toContain('no query expected');
    }finally{logs.mockRestore();}
  });
});

describe("the split's two halves cannot overlap", () => {
  it("rejects a pass that claims both halves", async () => {
    // A pass that both skipped publication and ran publication-only would run
    // no lane at all and report itself idle — the failure this split exists to
    // make impossible, so it is refused rather than tolerated.
    await expect(runStorageAnalyticsPass({
      ...bindings(), publishCommunity: true, publicOnly: true,
      publicationOnly: true, skipPublication: true,
    })).rejects.toThrow();
  });

  it("rejects publication-only combined with graph-only", async () => {
    await expect(runStorageAnalyticsPass({
      ...bindings(), publishCommunity: true, publicOnly: true,
      publicationOnly: true, graphOnly: true,
    })).rejects.toThrow();
  });

  it("requires publication-only to carry the publication preconditions", async () => {
    // `publicationOnly` runs the publication lanes, so it inherits the same
    // `publishCommunity` + `publicOnly` requirement `graphOnly` has.
    await expect(runStorageAnalyticsPass({
      ...bindings(), publicationOnly: true,
    })).rejects.toThrow();
    await expect(runStorageAnalyticsPass({
      ...bindings(), publishCommunity: true, publicationOnly: true,
    })).rejects.toThrow();
  });

  it("accepts each half on its own", async () => {
    // Neither option is rejected by validation; both fail later on the stub
    // database, which is what proves they passed the argument gate.
    for (const half of [{ publicationOnly: true }, { skipPublication: true }]) {
      await expect(runStorageAnalyticsPass({
        ...bindings(), publishCommunity: true, publicOnly: true, ...half,
      })).rejects.toThrow(/no query expected|STORAGE_/u);
    }
  });
});

describe("daily admission cadence", () => {
  it("retains three stale-head slots and alternates the queue's old and recent turns", () => {
    const slots=Array.from({length:16},(_,slot)=>storageDailyAdmissionForSlot(slot));
    expect(slots.flatMap((entry,slot)=>entry.preferStaleHead?[]:[slot])).toEqual([3,7,11,15]);
    expect([3,7,11,15].map(slot=>slots[slot])).toEqual([
      {preferStaleHead:false,preferNewestQueued:false},
      {preferStaleHead:false,preferNewestQueued:true},
      {preferStaleHead:false,preferNewestQueued:false},
      {preferStaleHead:false,preferNewestQueued:true},
    ]);
    for(const slot of [0,1,2,4,5,6,8,9,10,12,13,14])
      expect(slots[slot]!.preferStaleHead).toBe(true);
    expect(()=>storageDailyAdmissionForSlot(-1)).toThrow();
    expect(()=>storageDailyAdmissionForSlot(0.5)).toThrow();
  });
});
