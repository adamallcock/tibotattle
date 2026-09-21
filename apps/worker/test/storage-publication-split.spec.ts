import { describe, expect, it } from "vitest";
import {
  runStoragePublicationSchedule,
  storagePublicationLaneEnabled,
} from "../src/storage-publication-worker";
import { runStorageAnalyticsPass } from "../src/storage-analytics-runtime";

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
