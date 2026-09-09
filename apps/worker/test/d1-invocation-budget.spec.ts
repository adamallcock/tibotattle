import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1InvocationBudget, D1InvocationBudgetExceededError } from "../src/d1-invocation-budget";

beforeEach(async () => { await reset(); });

describe("whole-invocation D1 statement budget", () => {
  it("charges execution, bound statements and every batch member exactly once", async () => {
    const meter = createD1InvocationBudget(4), db = meter.wrap(env.USAGE_MONITOR_DB);
    const statement = db.prepare("SELECT ? AS value").bind(7);
    expect(meter.queriesUsed).toBe(0);
    expect(await statement.first("value")).toBe(7);
    const batch = await db.batch([statement, statement.bind(8)]);
    expect(batch.map(item => item.results)).toEqual([[{value:7}],[{value:8}]]);
    expect(meter.queriesUsed).toBe(3);
    expect(await statement.raw()).toEqual([[7]]);
    expect(meter.remainingQueries).toBe(0);
    expect(() => statement.all()).toThrow(D1InvocationBudgetExceededError);
    expect(meter.queriesUsed).toBe(4);
  });

  it("shares the limit across bindings and preserves reserved final-operation headroom", async () => {
    const meter = createD1InvocationBudget(3);
    const main = meter.wrap(env.USAGE_MONITOR_DB), ledger = meter.wrap(env.DELETION_LEDGER);
    expect(meter.wrap(main)).toBe(main);
    expect(meter.wrap(env.USAGE_MONITOR_DB)).toBe(main);
    meter.reserveQueries = 1;
    await main.prepare("SELECT 1").run();
    await ledger.prepare("SELECT 2").all();
    expect(meter.remainingQueries).toBe(0);
    expect(() => main.prepare("SELECT 3").first()).toThrow(D1InvocationBudgetExceededError);
    meter.reserveQueries = 0;
    await ledger.prepare("SELECT 3").first();
    expect(meter.queriesUsed).toBe(3);
  });

  it("meters session methods without losing their native receiver or bookmark", async () => {
    const meter = createD1InvocationBudget(3), db = meter.wrap(env.USAGE_MONITOR_DB);
    const session = db.withSession("first-primary");
    expect(session.getBookmark()).toBeNull();
    await session.prepare("SELECT 1").all();
    await session.batch([session.prepare("SELECT 2"),session.prepare("SELECT 3")]);
    expect(meter.queriesUsed).toBe(3);
    expect(() => session.prepare("SELECT 4").run()).toThrow(D1InvocationBudgetExceededError);
  });

  it("refuses unmetered/foreign batches and unbounded SQL entrypoints", async () => {
    const meter = createD1InvocationBudget(3), db = meter.wrap(env.USAGE_MONITOR_DB);
    const foreign = meter.wrap(env.DELETION_LEDGER).prepare("SELECT 1");
    expect(() => db.batch([foreign])).toThrow("foreign database statement");
    expect(() => db.batch([env.USAGE_MONITOR_DB.prepare("SELECT 1")])).toThrow("foreign database statement");
    expect(() => db.exec("SELECT 1; SELECT 2")).toThrow("unbounded database operation");
    expect(() => db.dump()).toThrow("unbounded database operation");
    expect(meter.queriesUsed).toBe(0);
  });

  it("charges failed database attempts and refuses an entire over-budget batch before SQL", async () => {
    await env.USAGE_MONITOR_DB.prepare("CREATE TABLE evidence(value INTEGER)").run();
    const meter = createD1InvocationBudget(2), db = meter.wrap(env.USAGE_MONITOR_DB);
    await expect(db.prepare("SELECT * FROM missing_budget_fixture").all()).rejects.toThrow();
    expect(meter.queriesUsed).toBe(1);
    expect(() => db.batch([db.prepare("INSERT INTO evidence VALUES(1)"),db.prepare("INSERT INTO evidence VALUES(2)")]))
      .toThrow(D1InvocationBudgetExceededError);
    expect(await env.USAGE_MONITOR_DB.prepare("SELECT COUNT(*) FROM evidence").first("COUNT(*)")).toBe(0);
    expect(meter.queriesUsed).toBe(1);
  });

  it("validates hard limits and reserves", () => {
    for (const value of [0,-1,1.5,1_001,NaN,Infinity]) expect(() => createD1InvocationBudget(value)).toThrow(TypeError);
    const meter = createD1InvocationBudget(3);
    for (const value of [-1,4,NaN,Infinity,1.5]) expect(() => { meter.reserveQueries=value; }).toThrow(TypeError);
  });
});
