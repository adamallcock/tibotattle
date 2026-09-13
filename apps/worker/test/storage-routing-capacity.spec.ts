import { applyD1Migrations, env, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { configureStorageShardAllocation, recordStorageCapacityObservation } from "../src/storage-capacity";
import {
  assertStorageCatalogEpoch,
  captureActiveOwnerRouteSnapshot,
  createCatalogStorageRouter,
  createOwnerMoveCoordinator,
  STORAGE_NEW_OWNER_CUTOFF_BYTES,
} from "../src/storage-routing";

interface Bindings extends Env {
  STORAGE_ROUTING_DB: D1Database;
  STORAGE_INGESTION_A: D1Database;
  STORAGE_INGESTION_B: D1Database;
  STORAGE_INGESTION_C: D1Database;
  TEST_ROUTING_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ROUTING_MIGRATIONS: D1Migration[];
}

const bindings = () => env as Bindings;
const catalog = () => bindings().STORAGE_ROUTING_DB;
const shards = () => ({
  STORAGE_INGESTION_A: bindings().STORAGE_INGESTION_A,
  STORAGE_INGESTION_B: bindings().STORAGE_INGESTION_B,
  STORAGE_INGESTION_C: bindings().STORAGE_INGESTION_C,
});
const router = () => createCatalogStorageRouter({
  catalog: catalog(),
  bindings: shards(),
  clock: () => 10_000,
});

async function observe(
  shardId: string,
  observedBytes: number,
  allocationTier: "active" | "spare" = "active",
  validUntil = 20_000,
): Promise<void> {
  await recordStorageCapacityObservation(catalog(), {
    shardId,
    observedBytes,
    observedAt: 9_000,
    validUntil,
    pressureState: "normal",
  });
  await configureStorageShardAllocation(catalog(), {
    shardId, allocationTier, allocationEnabled: true, updatedAt: 9_000,
  });
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(catalog(), bindings().TEST_ROUTING_MIGRATIONS);
  for (const database of Object.values(shards())) {
    await applyD1Migrations(database,
      bindings().TEST_INGESTION_ROUTING_MIGRATIONS);
  }
  await catalog().batch([
    catalog().prepare("INSERT INTO storage_shards (shard_id,binding_name,state) VALUES ('a','STORAGE_INGESTION_A','active')"),
    catalog().prepare("INSERT INTO storage_shards (shard_id,binding_name,state) VALUES ('b','STORAGE_INGESTION_B','active')"),
    catalog().prepare("INSERT INTO storage_shards (shard_id,binding_name,state) VALUES ('c','STORAGE_INGESTION_C','active')"),
  ]);
});

describe("owner shard allocation capacity", () => {
  it("prefers measured active capacity and retains the qualified spare", async () => {
    await observe("a", 5_500_000_000);
    await observe("b", 1_000_000_000);
    await observe("c", 0, "spare");
    const route = await router().ensureCapabilityOwner(
      "a".repeat(64),
      "accountless:owner-one",
      16_777_216,
    );
    expect(route).toMatchObject({ shardId: "b", generation: 1, mode: "catalog" });
    expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'").first("reserved_bytes"))
      .toBe(16_777_216);
    expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='c'").first("reserved_bytes"))
      .toBe(0);
  });

  it("stops new allocation at exactly 6 GB and uses a ready spare", async () => {
    await observe("a", STORAGE_NEW_OWNER_CUTOFF_BYTES);
    await observe("b", STORAGE_NEW_OWNER_CUTOFF_BYTES + 1);
    await observe("c", 5_000_000_000, "spare");
    const route = await router().ensureCapabilityOwner(
      "b".repeat(64),
      "accountless:owner-two",
      100,
    );
    expect(route.shardId).toBe("c");
  });

  it("refuses a direct new assignment on stale capacity but preserves an existing owner", async () => {
    await observe("a", 1_000);
    const existing = await router().ensureOwner(
      "accountless:existing-owner", "a", 16_777_216);
    await recordStorageCapacityObservation(catalog(), {
      shardId: "a", observedBytes: 1_000, observedAt: 9_500,
      validUntil: 9_999, pressureState: "normal",
    });
    await expect(router().ensureOwner(
      "accountless:new-owner", "a", 16_777_216,
    )).rejects.toMatchObject({ code: "CAPACITY_UNAVAILABLE" });
    await expect(router().ensureOwner(
      "accountless:existing-owner", "a", 16_777_216,
    )).resolves.toEqual(existing);
    expect(await catalog().prepare(`SELECT count(*) AS n
      FROM storage_owner_routes`).first("n")).toBe(1);
  });

  it("rechecks observation freshness inside a raced allocator reservation", async () => {
    await observe("a", 1_000);
    let tick = 0;
    const racing = createCatalogStorageRouter({ catalog: catalog(), bindings: shards(),
      clock: () => tick++ === 0 ? 10_000 : 20_001 });
    await expect(racing.ensureCapabilityOwner("e".repeat(64),
      "accountless:raced-owner", 16_777_216))
      .rejects.toMatchObject({ code: "CAPACITY_UNAVAILABLE" });
    expect(await catalog().prepare("SELECT count(*) AS n FROM storage_owner_routes").first("n")).toBe(0);
    expect(await catalog().prepare("SELECT sum(reserved_bytes) AS n FROM storage_shards").first("n")).toBe(0);
  });

  it("refuses a direct move when its destination observation is stale", async () => {
    await observe("a", 1_000);
    await observe("b", 1_000, "active", 9_999);
    const route = await router().ensureOwner("accountless:move-owner", "a", 16_777_216);
    const mover = createOwnerMoveCoordinator({ catalog: catalog(), bindings: shards(),
      clock: () => 10_000, verifyDestinationCopy: async () => "f".repeat(64) });
    await expect(mover.begin("move-stale-capacity", route, "b"))
      .rejects.toMatchObject({ code: "CAPACITY_UNAVAILABLE" });
    expect(await catalog().prepare("SELECT count(*) AS n FROM storage_owner_moves").first("n")).toBe(0);
    expect(await catalog().prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='b'")
      .first("reserved_bytes")).toBe(0);
  });

  it("captures a bounded stable routing epoch and rejects a changed cohort", async () => {
    await observe("a", 1_000);
    await router().ensureOwner("accountless:owner-a", "a", 16_777_216);
    const snapshot = await captureActiveOwnerRouteSnapshot({
      catalog: catalog(), bindings: shards(), limit: 1,
    });
    expect(snapshot).toMatchObject({
      catalogEpoch: 2,
      bounded: false,
      nextAfterOwnerId: null,
      routes: [{ ownerId: "accountless:owner-a", shardId: "a", generation: 1 }],
    });
    await expect(assertStorageCatalogEpoch(catalog(), snapshot.catalogEpoch))
      .resolves.toBeUndefined();
    await catalog().prepare("UPDATE storage_shards SET state='draining' WHERE shard_id='a'").run();
    await expect(assertStorageCatalogEpoch(catalog(), snapshot.catalogEpoch))
      .rejects.toMatchObject({ code: "ROUTE_STALE" });
  });

  it("refuses unknown, stale, pressured, and over-cap observations", async () => {
    await observe("a", 1, "active", 9_999);
    await recordStorageCapacityObservation(catalog(), {
      shardId: "b", observedBytes: 1, observedAt: 9_000, validUntil: 20_000,
      pressureState: "pressure",
    });
    await configureStorageShardAllocation(catalog(), {shardId:'b',allocationTier:'active',
      allocationEnabled:true,updatedAt:9000});
    await observe("c", 5_999_999_999, "spare");
    await catalog().prepare("UPDATE storage_shards SET reserved_bytes=3000000001 WHERE shard_id='c'").run();
    await expect(router().ensureCapabilityOwner(
      "c".repeat(64), "accountless:owner-three", 1,
    )).rejects.toMatchObject({ code: "CAPACITY_UNAVAILABLE" });
    expect(await catalog().prepare("SELECT count(*) AS n FROM storage_owner_routes").first("n")).toBe(0);
  });

  it("concurrent identical enrollment converges without double reservation", async () => {
    await observe("a", 1_000);
    await observe("b", 2_000);
    await observe("c", 0, "spare");
    const capability = "d".repeat(64);
    const [first, second] = await Promise.all([
      router().ensureCapabilityOwner(capability, "accountless:proposal-one", 4096),
      router().ensureCapabilityOwner(capability, "accountless:proposal-two", 4096),
    ]);
    expect(first).toEqual(second);
    expect(await catalog().prepare("SELECT count(*) AS n FROM storage_owner_routes").first("n")).toBe(1);
    expect(await catalog().prepare("SELECT sum(reserved_bytes) AS n FROM storage_shards").first("n")).toBe(4096);
    expect(await router().locateCapability(capability)).toEqual(first);
  });

  it("preserves over-cap and equal-time pressure observations conservatively", async () => {
    await observe("a", 1_000);
    await recordStorageCapacityObservation(catalog(), {
      shardId: "a", observedBytes: 9_000_000_001, observedAt: 10_000,
      validUntil: 20_000, pressureState: "pressure",
    });
    expect(await catalog().prepare("SELECT state FROM storage_shards WHERE shard_id='a'").first("state"))
      .toBe("draining");
    expect(await catalog().prepare("SELECT observed_bytes FROM storage_shards WHERE shard_id='a'").first("observed_bytes"))
      .toBe(9_000_000_001);

    await recordStorageCapacityObservation(catalog(), {
      shardId: "a", observedBytes: 1, observedAt: 10_000,
      validUntil: 30_000, pressureState: "normal",
    });
    expect(await catalog().prepare(`SELECT observed_bytes, valid_until, pressure_state
      FROM storage_shard_capacity_observations WHERE shard_id='a'`).first()).toEqual({
      observed_bytes: 9_000_000_001,
      valid_until: 20_000,
      pressure_state: "pressure",
    });
    expect(await catalog().prepare("SELECT state FROM storage_shards WHERE shard_id='a'").first("state"))
      .toBe("draining");
  });
});
