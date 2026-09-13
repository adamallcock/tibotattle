import { env, reset, applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { analyticsAuthorityIsCurrent, applyAnalyticsChange, deliverAnalyticsPage,
  initializeStorageSource, prepareIngestionChange, readIngestionChanges,
  type StorageChangeInput, type PrepareAnalyticsProjection } from "../src/analytics-delivery";

const bindings = env as Env & {
  STORAGE_INGESTION_A: D1Database; STORAGE_ANALYTICS_DB: D1Database;
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[]; TEST_ANALYTICS_MIGRATIONS: D1Migration[];
};
const source = () => bindings.STORAGE_INGESTION_A;
const target = () => bindings.STORAGE_ANALYTICS_DB;
const id = "synthetic-source-a", owner = "a".repeat(64), object = "b".repeat(64);
function change(revision: number, kind: StorageChangeInput["kind"] = "source-updated", extra: Partial<StorageChangeInput> = {}): StorageChangeInput {
  return { sourceId: id, ownerDigest: owner, eventDigest: revision.toString(16).padStart(64, "0"),
    revision, kind, objectDigest: object, contentDigest: "c".repeat(64), recordedMs: 1000 + revision, ...extra };
}
const projection: PrepareAnalyticsProjection = async (db, event) => event.kind === "source-updated"
  ? [db.prepare("INSERT INTO synthetic_projection(owner_digest,value) VALUES(?,?) ON CONFLICT(owner_digest) DO UPDATE SET value=excluded.value")
    .bind(event.ownerDigest, event.revision)]
  : event.kind === "owner-active" ? [] : [db.prepare("DELETE FROM synthetic_projection WHERE owner_digest=?").bind(event.ownerDigest)];
const deliver = (prepareProjection = projection, limit?: number) => deliverAnalyticsPage({ source: source(), target: target(), sourceId: id, prepareProjection, limit });
const append = (event: StorageChangeInput) => source().batch([prepareIngestionChange(source(), event)]);
const values = async () => (await target().prepare("SELECT * FROM synthetic_projection ORDER BY owner_digest").all()).results;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(source(), bindings.TEST_TYPED_INGESTION_MIGRATIONS.filter(m => m.name.startsWith("0002")));
  await applyD1Migrations(target(), bindings.TEST_ANALYTICS_MIGRATIONS);
  await initializeStorageSource(source(), id);
  await source().prepare("CREATE TABLE synthetic_accepted(id INTEGER PRIMARY KEY)").run();
  await target().prepare("CREATE TABLE synthetic_projection(owner_digest TEXT PRIMARY KEY,value INTEGER NOT NULL)").run();
});

describe("independent analytics delivery", () => {
  it("commits source records and a replayable event even while analytics is broken", async () => {
    await append(change(1, "owner-active"));
    await target().prepare("DROP TABLE synthetic_projection").run();
    await source().batch([source().prepare("INSERT INTO synthetic_accepted VALUES(1)"), prepareIngestionChange(source(), change(2))]);
    expect(await source().prepare("SELECT COUNT(*) n FROM synthetic_accepted").first("n")).toBe(1);
    await expect(deliver()).rejects.toThrow("ANALYTICS_DELIVERY_UNACKNOWLEDGED");
    expect(await target().prepare("SELECT sequence FROM analytics_source_cursors").first("sequence")).toBe(1);
    await target().prepare("CREATE TABLE synthetic_projection(owner_digest TEXT PRIMARY KEY,value INTEGER NOT NULL)").run();
    expect(await deliver()).toMatchObject({ applied: 1, sequence: 2 });
    expect(await values()).toEqual([{ owner_digest: owner, value: 2 }]);
  });

  it("rolls source acceptance back when the journal cannot accept its revision", async () => {
    await append(change(1, "owner-active"));
    await expect(source().batch([source().prepare("INSERT INTO synthetic_accepted VALUES(1)"), prepareIngestionChange(source(), change(3))]))
      .rejects.toThrow("storage_owner_revision_conflict");
    expect(await source().prepare("SELECT COUNT(*) n FROM synthetic_accepted").first("n")).toBe(0);
    expect((await readIngestionChanges(source(), id, 0)).length).toBe(1);
  });

  it("does not silently omit a journal entry for a mismatched source", async () => {
    await expect(source().batch([source().prepare("INSERT INTO synthetic_accepted VALUES(1)"),
      prepareIngestionChange(source(), change(1, "owner-active", { sourceId: "wrong-source" }))])).rejects.toThrow();
    expect(await source().prepare("SELECT COUNT(*) n FROM synthetic_accepted").first("n")).toBe(0);
    await expect(initializeStorageSource(source(), "wrong-source")).rejects.toThrow("STORAGE_SOURCE_MISMATCH");
  });

  it("acknowledges exact duplicate delivery but rejects changed evidence at the same sequence", async () => {
    await append(change(1, "owner-active")); await append(change(2));
    const events = await readIngestionChanges(source(), id, 0);
    await deliver();
    expect(await applyAnalyticsChange(target(), events[1]!, async () => { throw new Error("must not rebuild duplicate"); })).toBe("already-applied");
    await expect(applyAnalyticsChange(target(), { ...events[1]!, contentDigest: "d".repeat(64) }, projection)).rejects.toThrow("ANALYTICS_RECEIPT_CONFLICT");
    expect(await values()).toEqual([{ owner_digest: owner, value: 2 }]);
  });

  it("rejects reordered events and leaves the target cursor untouched", async () => {
    await append(change(1, "owner-active")); await append(change(2));
    const events = await readIngestionChanges(source(), id, 0);
    await expect(applyAnalyticsChange(target(), events[1]!, projection)).rejects.toThrow("ANALYTICS_DELIVERY_UNACKNOWLEDGED");
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_source_cursors").first("n")).toBe(0);
    expect(await values()).toEqual([]);
    expect(await deliver()).toMatchObject({ applied: 2, sequence: 2 });
  });

  it("rolls back projection mutations and receipt together on a late failure", async () => {
    await append(change(1, "owner-active")); await deliver(); await append(change(2));
    await expect(deliver(async (db, event) => [...await projection(db, event), db.prepare("INSERT INTO missing_table VALUES(1)")]))
      .rejects.toThrow("ANALYTICS_DELIVERY_UNACKNOWLEDGED");
    expect(await values()).toEqual([]);
    expect(await target().prepare("SELECT sequence FROM analytics_source_cursors").first("sequence")).toBe(1);
    expect(await deliver()).toMatchObject({ applied: 1, sequence: 2 });
  });

  it("withholds stale eligibility immediately, then applies withdrawal and prevents resurrection after erasure", async () => {
    expect(await analyticsAuthorityIsCurrent(source(), target(), id, 1)).toBe(false);
    await append(change(1, "owner-active")); await append(change(2)); await deliver();
    expect(await analyticsAuthorityIsCurrent(source(), target(), id, 1)).toBe(true);
    await append(change(3, "owner-withdrawn"));
    expect(await analyticsAuthorityIsCurrent(source(), target(), id, 1)).toBe(false);
    await expect(append(change(4))).rejects.toThrow("storage_owner_ineligible");
    await deliver(); expect(await values()).toEqual([]);
    expect(await analyticsAuthorityIsCurrent(source(), target(), id, 1)).toBe(false);
    expect(await analyticsAuthorityIsCurrent(source(), target(), id, 2)).toBe(true);
    await append(change(4, "owner-active")); await append(change(5)); await deliver();
    await append(change(6, "owner-erased")); await deliver();
    expect(await values()).toEqual([]);
    await expect(append(change(7, "owner-active"))).rejects.toThrow("storage_owner_erased");
  });

  it("keeps ordinary data lag separate from a withdrawal epoch", async () => {
    await append(change(1, "owner-active")); await deliver(); await append(change(2));
    expect(await analyticsAuthorityIsCurrent(source(), target(), id, 1)).toBe(true);
    await expect(deliver(async () => [])).rejects.toThrow("ANALYTICS_PROJECTION_MISSING");
    expect(await target().prepare("SELECT sequence FROM analytics_source_cursors").first("sequence")).toBe(1);
  });

  it.each(["owner-withdrawn", "owner-erased"] as const)("does not acknowledge %s without cleanup", async kind => {
    await append(change(1, "owner-active")); await append(change(2)); await deliver();
    await append(change(3, kind));
    await expect(deliver(async () => [])).rejects.toThrow("ANALYTICS_PROJECTION_MISSING");
    expect(await target().prepare("SELECT sequence FROM analytics_source_cursors").first("sequence")).toBe(2);
    expect(await analyticsAuthorityIsCurrent(source(), target(), id, 1)).toBe(false);
    await deliver(); expect(await values()).toEqual([]);
    expect(await analyticsAuthorityIsCurrent(source(), target(), id, 1)).toBe(false);
    expect(await analyticsAuthorityIsCurrent(source(), target(), id, 2)).toBe(true);
  });

  it("checks source authority after the projection cursor, catching an intervening withdrawal", async () => {
    await append(change(1, "owner-active")); await deliver();
    const sourceWithInterveningWithdrawal = {
      prepare(sql: string) { return { async first() {
        await append(change(2, "owner-withdrawn"));
        return source().prepare(sql).first();
      } }; },
    } as unknown as D1Database;
    expect(await analyticsAuthorityIsCurrent(sourceWithInterveningWithdrawal, target(), id, 1)).toBe(false);
  });

  it("bounds pages and resumes at the committed cursor after cancellation", async () => {
    await append(change(1, "owner-active")); await append(change(2)); await append(change(3));
    expect(await deliver(projection, 1)).toEqual({ applied: 1, alreadyApplied: 0, sequence: 1, pageFull: true });
    const controller = new AbortController(); controller.abort();
    await expect(deliverAnalyticsPage({ source: source(), target: target(), sourceId: id, prepareProjection: projection, signal: controller.signal })).rejects.toThrow();
    expect(await deliver()).toMatchObject({ applied: 2, sequence: 3 });
    await expect(readIngestionChanges(source(), id, 0, 101)).rejects.toThrow("STORAGE_PAGE_LIMIT");
    expect(() => prepareIngestionChange(source(), change(4, "source-updated", { ownerDigest: "raw-owner-id" }))).toThrow("STORAGE_DIGEST_INVALID");
  });
});
