import { applyD1Migrations, env, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { configureStorageShardAllocation, recordStorageCapacityObservation } from "../src/storage-capacity";
import {
  createCatalogStorageRouter,
  finalizeAccountlessIssuanceBaseline,
  historicalAccountlessIssuanceRosterDigest,
  importHistoricalAccountlessIssuanceReservation,
  type HistoricalAccountlessIssuanceBaseline,
  type HistoricalAccountlessIssuanceReservation,
} from "../src/storage-routing";

interface Bindings extends Env {
  STORAGE_ROUTING_DB: D1Database;
  STORAGE_INGESTION_A: D1Database;
  TEST_ROUTING_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ROUTING_MIGRATIONS: D1Migration[];
}

const bindings = () => env as Bindings;
const catalog = () => bindings().STORAGE_ROUTING_DB;
const shard = () => bindings().STORAGE_INGESTION_A;
const router = (database: D1Database = catalog(), clock = () => 2_000) =>
  createCatalogStorageRouter({
    catalog: database,
    bindings: { STORAGE_INGESTION_A: shard() },
    clock,
  });

const first: HistoricalAccountlessIssuanceReservation = Object.freeze({
  reservationKey: "1".repeat(64),
  ownerId: "accountless:historical-one",
  deviceDigest: "a".repeat(64),
  budgetDay: "2026-09-12",
  reservedAt: 1_000,
});
const second: HistoricalAccountlessIssuanceReservation = Object.freeze({
  reservationKey: "2".repeat(64),
  ownerId: "accountless:historical-two",
  deviceDigest: "b".repeat(64),
  budgetDay: "2026-09-13",
  reservedAt: 1_100,
});

async function prepareCatalog(migrations = bindings().TEST_ROUTING_MIGRATIONS): Promise<void> {
  await applyD1Migrations(catalog(), migrations);
  await applyD1Migrations(shard(), bindings().TEST_INGESTION_ROUTING_MIGRATIONS);
  await catalog().prepare(`INSERT INTO storage_shards (shard_id,binding_name,state)
    VALUES ('a','STORAGE_INGESTION_A','active')`).run();
  await recordStorageCapacityObservation(catalog(), {
    shardId: "a", observedBytes: 1_000, observedAt: 1_000,
    validUntil: Date.UTC(2030, 0, 1), pressureState: "normal",
  });
  await configureStorageShardAllocation(catalog(), {
    shardId: "a", allocationTier: "active", allocationEnabled: true, updatedAt: 1_000,
  });
}

async function prepareOwner(input: HistoricalAccountlessIssuanceReservation): Promise<void> {
  await router().ensureOwner(input.ownerId, "a", 4_096);
}

async function baseline(
  roster: readonly HistoricalAccountlessIssuanceReservation[],
  overrides: Partial<HistoricalAccountlessIssuanceBaseline> = {},
): Promise<HistoricalAccountlessIssuanceBaseline> {
  return {
    budgetDay: "1970-01-01",
    dailyReserved: 7,
    lifetimeReserved: 23,
    baselineDigest: "f".repeat(64),
    initializedAt: 1_500,
    historicalRosterCount: roster.length,
    historicalRosterDigest: await historicalAccountlessIssuanceRosterDigest(roster),
    ...overrides,
  };
}

function failAfterMatchingBatch(database: D1Database, pattern: RegExp): D1Database {
  const marked = new WeakSet<object>();
  let failed = false;
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!pattern.test(sql)) return statement;
        marked.add(statement as object);
        return new Proxy(statement, {
          get(statementTarget, member) {
            if (member === "bind") return (...values: unknown[]) => {
              const bound = statementTarget.bind(...values);
              marked.add(bound as object);
              return bound;
            };
            const value = Reflect.get(statementTarget, member);
            return typeof value === "function" ? value.bind(statementTarget) : value;
          },
        });
      };
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await target.batch(statements);
        if (!failed && statements.some((statement) => marked.has(statement as object))) {
          failed = true;
          throw new Error("synthetic response loss after commit");
        }
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function runBeforeFinalizerUpdate(database: D1Database, action: () => Promise<void>): D1Database {
  let intercepted = false;
  return new Proxy(database, {
    get(target, key) {
      if (key !== "prepare") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("UPDATE storage_accountless_historical_issuance_state")) return statement;
        return new Proxy(statement, {
          get(statementTarget, member) {
            if (member !== "bind") {
              const value = Reflect.get(statementTarget, member);
              return typeof value === "function" ? value.bind(statementTarget) : value;
            }
            return (...values: unknown[]) => {
              const bound = statementTarget.bind(...values);
              return new Proxy(bound, {
                get(boundTarget, boundMember) {
                  if (boundMember === "first") return async (...args: unknown[]) => {
                    if (!intercepted) { intercepted = true; await action(); }
                    return Reflect.apply(boundTarget.first, boundTarget, args);
                  };
                  const value = Reflect.get(boundTarget, boundMember);
                  return typeof value === "function" ? value.bind(boundTarget) : value;
                },
              });
            };
          },
        });
      };
    },
  });
}

function failAfterFinalizerUpdate(database: D1Database): D1Database {
  let failed = false;
  return new Proxy(database, {
    get(target, key) {
      if (key !== "prepare") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("UPDATE storage_accountless_historical_issuance_state")) return statement;
        return new Proxy(statement, {
          get(statementTarget, member) {
            if (member !== "bind") {
              const value = Reflect.get(statementTarget, member);
              return typeof value === "function" ? value.bind(statementTarget) : value;
            }
            return (...values: unknown[]) => {
              const bound = statementTarget.bind(...values);
              return new Proxy(bound, {
                get(boundTarget, boundMember) {
                  if (boundMember === "first") return async (...args: unknown[]) => {
                    const result = await Reflect.apply(boundTarget.first, boundTarget, args);
                    if (!failed) { failed = true; throw new Error("synthetic finalizer response loss"); }
                    return result;
                  };
                  const value = Reflect.get(boundTarget, boundMember);
                  return typeof value === "function" ? value.bind(boundTarget) : value;
                },
              });
            };
          },
        });
      };
    },
  });
}

beforeEach(async () => {
  await reset();
});

describe("historical accountless issuance activation", () => {
  it("imports exact immutable reservations but refuses enrollment before finalization", async () => {
    await prepareCatalog();
    await prepareOwner(first);
    await expect(importHistoricalAccountlessIssuanceReservation(catalog(), first))
      .resolves.toEqual(first);
    await expect(importHistoricalAccountlessIssuanceReservation(catalog(), first))
      .resolves.toEqual(first);
    await expect(router().ensureCapabilityOwner(
      first.reservationKey, first.deviceDigest, "accountless:unused-proposal", 4_096,
    )).rejects.toMatchObject({ code: "ISSUANCE_UNINITIALIZED" });
    expect(await catalog().prepare(`SELECT imported_count FROM
      storage_accountless_historical_issuance_state WHERE singleton_id=1`)
      .first("imported_count")).toBe(1);
    expect(await catalog().prepare(`SELECT daily_reserved,lifetime_reserved FROM
      storage_accountless_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ daily_reserved: 0, lifetime_reserved: 0 });
  });

  it("finalizes only the exact stable roster while preserving independent authoritative totals", async () => {
    await prepareCatalog();
    for (const item of [first, second]) {
      await prepareOwner(item);
      await importHistoricalAccountlessIssuanceReservation(catalog(), item);
    }
    await expect(finalizeAccountlessIssuanceBaseline(catalog(), await baseline([first], {
      historicalRosterCount: 1,
    }))).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await expect(finalizeAccountlessIssuanceBaseline(catalog(), await baseline([first, second], {
      historicalRosterDigest: "e".repeat(64),
    }))).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await expect(finalizeAccountlessIssuanceBaseline(catalog(), await baseline([first, second], {
      dailyReserved: 0, lifetimeReserved: 1,
    }))).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await expect(finalizeAccountlessIssuanceBaseline(catalog(), await baseline([first, second], {
      budgetDay: second.budgetDay, dailyReserved: 0,
    }))).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(await catalog().prepare(`SELECT import_state FROM
      storage_accountless_historical_issuance_state WHERE singleton_id=1`)
      .first("import_state")).toBe("importing");
    expect(await catalog().prepare(`SELECT initialization_state,daily_reserved,lifetime_reserved FROM
      storage_accountless_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ initialization_state: "uninitialized", daily_reserved: 0, lifetime_reserved: 0 });

    const exact = await baseline([second, first]);
    await expect(finalizeAccountlessIssuanceBaseline(catalog(), exact)).resolves.toBeUndefined();
    expect(await catalog().prepare(`SELECT daily_reserved,lifetime_reserved FROM
      storage_accountless_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ daily_reserved: 7, lifetime_reserved: 23 });
    expect(await catalog().prepare(`SELECT imported_count,roster_digest FROM
      storage_accountless_historical_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ imported_count: 2, roster_digest: exact.historicalRosterDigest });
  });

  it("reuses a historical owner after midnight without consuming a current issuance", async () => {
    await prepareCatalog();
    await prepareOwner(first);
    await importHistoricalAccountlessIssuanceReservation(catalog(), first);
    const exact = await baseline([first]);
    await finalizeAccountlessIssuanceBaseline(catalog(), exact);

    const replay = await router(catalog(), () => Date.UTC(2026, 8, 14))
      .ensureCapabilityOwner(first.reservationKey, first.deviceDigest,
        "accountless:different-proposal", 4_096);
    expect(replay.route.ownerId).toBe(first.ownerId);
    expect(replay.issuanceReservation).toEqual(first);
    await expect(router().ensureCapabilityOwner(
      "8".repeat(64), first.deviceDigest, "accountless:changed-secret", 4_096,
    )).rejects.toMatchObject({ code: "ENROLLMENT_CONFLICT" });
    await expect(router().ensureCapabilityOwner(
      first.reservationKey, "8".repeat(64), "accountless:changed-device", 4_096,
    )).rejects.toMatchObject({ code: "ENROLLMENT_CONFLICT" });
    expect(await catalog().prepare(`SELECT count(*) AS n FROM
      storage_accountless_issuance_reservations`).first("n")).toBe(0);
    expect(await catalog().prepare(`SELECT budget_day,daily_reserved,lifetime_reserved FROM
      storage_accountless_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ budget_day: exact.budgetDay, daily_reserved: 7, lifetime_reserved: 23 });
  });

  it("fails closed on historical and current identity collisions", async () => {
    await prepareCatalog();
    await prepareOwner(first);
    await prepareOwner(second);
    await importHistoricalAccountlessIssuanceReservation(catalog(), first);
    await expect(importHistoricalAccountlessIssuanceReservation(catalog(), {
      ...second, reservationKey: first.reservationKey,
    })).rejects.toMatchObject({ code: "ENROLLMENT_CONFLICT" });
    await expect(importHistoricalAccountlessIssuanceReservation(catalog(), {
      ...second, deviceDigest: first.deviceDigest,
    })).rejects.toMatchObject({ code: "ENROLLMENT_CONFLICT" });
    await expect(importHistoricalAccountlessIssuanceReservation(catalog(), {
      ...first, reservationKey: second.reservationKey, deviceDigest: second.deviceDigest,
    })).rejects.toMatchObject({ code: "ENROLLMENT_CONFLICT" });

    await finalizeAccountlessIssuanceBaseline(catalog(), await baseline([first]));
    const current = await router().ensureCapabilityOwner(
      "3".repeat(64), "c".repeat(64), "accountless:current", 4_096,
    );
    await expect(importHistoricalAccountlessIssuanceReservation(catalog(), {
      reservationKey: current.issuanceReservation.reservationKey,
      ownerId: second.ownerId,
      deviceDigest: second.deviceDigest,
      budgetDay: "2026-09-13", reservedAt: 2_000,
    })).rejects.toMatchObject({ code: "ENROLLMENT_CONFLICT" });
  });

  it("converges after an ambiguous historical import acknowledgment", async () => {
    await prepareCatalog();
    await prepareOwner(first);
    const lossy = failAfterMatchingBatch(catalog(),
      /INSERT INTO storage_accountless_historical_issuance_reservations/u);
    await expect(importHistoricalAccountlessIssuanceReservation(lossy, first))
      .rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await expect(importHistoricalAccountlessIssuanceReservation(catalog(), first))
      .resolves.toEqual(first);
    expect(await catalog().prepare(`SELECT imported_count FROM
      storage_accountless_historical_issuance_state WHERE singleton_id=1`)
      .first("imported_count")).toBe(1);
  });

  it("refuses a finalization raced by another import at its CAS boundary", async () => {
    await prepareCatalog();
    await prepareOwner(first); await prepareOwner(second);
    await importHistoricalAccountlessIssuanceReservation(catalog(), first);
    const raced = runBeforeFinalizerUpdate(catalog(), async () => {
      await importHistoricalAccountlessIssuanceReservation(catalog(), second);
    });
    await expect(finalizeAccountlessIssuanceBaseline(raced, await baseline([first])))
      .rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(await catalog().prepare(`SELECT import_state,imported_count FROM
      storage_accountless_historical_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ import_state: "importing", imported_count: 2 });
  });

  it("converges after an ambiguous finalization acknowledgment", async () => {
    await prepareCatalog();
    await prepareOwner(first);
    await importHistoricalAccountlessIssuanceReservation(catalog(), first);
    const exact = await baseline([first]);
    await expect(finalizeAccountlessIssuanceBaseline(
      failAfterFinalizerUpdate(catalog()), exact,
    )).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await expect(finalizeAccountlessIssuanceBaseline(catalog(), exact)).resolves.toBeUndefined();
    expect(await catalog().prepare(`SELECT initialization_state,daily_reserved,lifetime_reserved
      FROM storage_accountless_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ initialization_state: "ready", daily_reserved: 7, lifetime_reserved: 23 });
  });

  it("keeps finalization one-way and rolls back a late import locator", async () => {
    await prepareCatalog();
    await prepareOwner(first); await prepareOwner(second);
    await importHistoricalAccountlessIssuanceReservation(catalog(), first);
    await finalizeAccountlessIssuanceBaseline(catalog(), await baseline([first]));
    await expect(importHistoricalAccountlessIssuanceReservation(catalog(), second))
      .rejects.toMatchObject({ code: "ISSUANCE_UNINITIALIZED" });
    expect(await catalog().prepare(`SELECT count(*) AS n FROM storage_capability_locators
      WHERE capability_hash=?`).bind(second.reservationKey).first("n")).toBe(0);
    await expect(catalog().prepare(`UPDATE storage_accountless_historical_issuance_reservations
      SET budget_day='2026-09-14' WHERE reservation_key=?`).bind(first.reservationKey).run())
      .rejects.toThrow();
    await expect(catalog().prepare(`DELETE FROM storage_accountless_historical_issuance_state
      WHERE singleton_id=1`).run()).rejects.toThrow();
  });

  it("recognizes an exact finalization retry after counters advance", async () => {
    await prepareCatalog();
    await prepareOwner(first);
    await importHistoricalAccountlessIssuanceReservation(catalog(), first);
    const exact = await baseline([first]);
    await finalizeAccountlessIssuanceBaseline(catalog(), exact);
    await router(catalog(), () => Date.UTC(2026, 8, 14)).ensureCapabilityOwner(
      "4".repeat(64), "d".repeat(64), "accountless:new-after-baseline", 4_096,
    );
    expect(await catalog().prepare(`SELECT daily_reserved,lifetime_reserved FROM
      storage_accountless_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ daily_reserved: 1, lifetime_reserved: 24 });
    await expect(finalizeAccountlessIssuanceBaseline(catalog(), exact)).resolves.toBeUndefined();
    await expect(finalizeAccountlessIssuanceBaseline(catalog(), {
      ...exact, lifetimeReserved: 24,
    })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });

  it("allows an imported retry at the daily ceiling while refusing a new issuance", async () => {
    await prepareCatalog();
    await prepareOwner(first);
    await importHistoricalAccountlessIssuanceReservation(catalog(), first);
    const exact = await baseline([first], { dailyReserved: 1_000, lifetimeReserved: 1_000 });
    await finalizeAccountlessIssuanceBaseline(catalog(), exact);
    await expect(router().ensureCapabilityOwner(
      first.reservationKey, first.deviceDigest, "accountless:unused", 4_096,
    )).resolves.toMatchObject({ issuanceReservation: first });
    await expect(router().ensureCapabilityOwner(
      "7".repeat(64), "7".repeat(64), "accountless:over-daily-limit", 4_096,
    )).rejects.toMatchObject({ code: "ISSUANCE_LIMIT_REACHED" });
    expect(await catalog().prepare(`SELECT daily_reserved,lifetime_reserved FROM
      storage_accountless_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ daily_reserved: 1_000, lifetime_reserved: 1_000 });
  });

  it("preserves a populated migration-0004 catalog and blocks it until compatible finalization", async () => {
    const oldMigrations = bindings().TEST_ROUTING_MIGRATIONS
      .filter((migration) => migration.name <= "0004_global_accountless_issuance.sql");
    await prepareCatalog(oldMigrations);
    await catalog().prepare(`UPDATE storage_accountless_issuance_state SET
      budget_day='2026-09-13',initialization_state='ready',daily_reserved=7,
      lifetime_reserved=42,baseline_digest=?,initialized_at=900,updated_at=900
      WHERE singleton_id=1`).bind("9".repeat(64)).run();
    const currentKey = "5".repeat(64);
    const currentDevice = "e".repeat(64);
    await router().ensureOwner("accountless:existing-current", "a", 4_096);
    await catalog().batch([
      catalog().prepare(`INSERT INTO storage_capability_locators
        (capability_hash,owner_id,state) VALUES (?,?,'active')`)
        .bind(currentKey, "accountless:existing-current"),
      catalog().prepare(`INSERT INTO storage_accountless_issuance_reservations
        (reservation_key,owner_id,device_digest,budget_day,reserved_at)
        VALUES (?,?,?,'2026-09-13',1000)`)
        .bind(currentKey, "accountless:existing-current", currentDevice),
    ]);
    expect(await catalog().prepare(`SELECT daily_reserved,lifetime_reserved FROM
      storage_accountless_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ daily_reserved: 8, lifetime_reserved: 43 });

    await applyD1Migrations(catalog(), bindings().TEST_ROUTING_MIGRATIONS
      .filter((migration) => migration.name > "0004_global_accountless_issuance.sql"));
    await expect(router().ensureCapabilityOwner(
      currentKey, currentDevice, "accountless:unused", 4_096,
    )).rejects.toMatchObject({ code: "ISSUANCE_UNINITIALIZED" });
    const upgradeBaseline = await baseline([], {
      budgetDay: "2026-09-13",
      dailyReserved: 8,
      lifetimeReserved: 43,
      baselineDigest: "9".repeat(64),
      initializedAt: 900,
    });
    await expect(finalizeAccountlessIssuanceBaseline(catalog(), {
      ...upgradeBaseline, lifetimeReserved: 42,
    })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(await catalog().prepare(`SELECT import_state FROM
      storage_accountless_historical_issuance_state WHERE singleton_id=1`)
      .first("import_state")).toBe("importing");
    expect(await catalog().prepare(`SELECT daily_reserved,lifetime_reserved FROM
      storage_accountless_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ daily_reserved: 8, lifetime_reserved: 43 });
    await finalizeAccountlessIssuanceBaseline(catalog(), upgradeBaseline);
    await expect(router().ensureCapabilityOwner(
      currentKey, currentDevice, "accountless:unused", 4_096,
    )).resolves.toMatchObject({ route: { ownerId: "accountless:existing-current" } });
    expect(await catalog().prepare(`SELECT daily_reserved,lifetime_reserved FROM
      storage_accountless_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ daily_reserved: 8, lifetime_reserved: 43 });
  });

  it("refuses runtime use when migration 0006 is absent", async () => {
    await prepareCatalog(bindings().TEST_ROUTING_MIGRATIONS
      .filter((migration) => migration.name < "0006_historical_accountless_issuance.sql"));
    await expect(router().ensureCapabilityOwner(
      "6".repeat(64), "f".repeat(64), "accountless:missing-schema", 4_096,
    )).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
});
