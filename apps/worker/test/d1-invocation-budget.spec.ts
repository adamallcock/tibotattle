import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1InvocationBudget, reserveD1FinalQuery, D1InvocationBudgetExceededError, D1_BUDGET_ATTACHMENT, type D1BudgetAttachment } from "../src/d1-invocation-budget";

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

  it("charges a carried target binding to every enclosing phase and invocation meter", async () => {
    interface Attachment extends D1BudgetAttachment { readonly target: D1Database; }
    const attach = (target: D1Database): Attachment => ({ target,
      withBudget(wrap) { return attach(wrap(target)); } });
    const carried = attach(env.DELETION_LEDGER);
    const source = new Proxy(env.USAGE_MONITOR_DB, { get(database, property) {
      if (property === D1_BUDGET_ATTACHMENT) return carried;
      const value: unknown = Reflect.get(database, property);
      return typeof value === 'function' ? value.bind(database) : value;
    } });
    const invocation = createD1InvocationBudget(5), phase = createD1InvocationBudget(2);
    const scoped = phase.wrap(invocation.wrap(source));
    const attachment = Reflect.get(scoped, D1_BUDGET_ATTACHMENT) as Attachment;
    expect(attachment.target).not.toBe(env.DELETION_LEDGER);
    await attachment.target.prepare('SELECT 1').first();
    await scoped.prepare('SELECT 2').first();
    expect(invocation.queriesUsed).toBe(2);
    expect(phase.queriesUsed).toBe(2);
    expect(() => attachment.target.prepare('SELECT 3').first()).toThrow(D1InvocationBudgetExceededError);
    expect(invocation.queriesUsed).toBe(2);
    expect(Reflect.get(scoped, D1_BUDGET_ATTACHMENT)).toBe(attachment);
  });

  it("validates hard limits and reserves", () => {
    for (const value of [0,-1,1.5,1_001,NaN,Infinity]) expect(() => createD1InvocationBudget(value)).toThrow(TypeError);
    const meter = createD1InvocationBudget(3);
    for (const value of [-1,4,NaN,Infinity,1.5]) expect(() => { meter.reserveQueries=value; }).toThrow(TypeError);
  });
});

describe('binding-lineage final-query reservations',()=>{
  it('protects one actual final statement through nested meters and captured binding facades',async()=>{
    const invocation=createD1InvocationBudget(5),phase=createD1InvocationBudget(4);
    const source=phase.wrap(invocation.wrap(env.USAGE_MONITOR_DB));
    const target=phase.wrap(invocation.wrap(env.DELETION_LEDGER));
    const observed=new Proxy(target,{get(db,key){const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});
    invocation.reserveQueries=1;phase.reserveQueries=1;
    const reservation=reserveD1FinalQuery([source,observed,source]);
    expect(reservation).toBeDefined();
    expect([invocation.reserveQueries,phase.reserveQueries]).toEqual([1,1]);
    expect([invocation.remainingQueries,phase.remainingQueries]).toEqual([3,2]);
    // A producer may reset its ordinary phase save reserve. The independent
    // branded reservation still protects cleanup on its original captured DB.
    invocation.reserveQueries=0;phase.reserveQueries=0;
    const captured=()=>source.prepare('SELECT 1').first();
    for(let i=0;i<3;i++)await captured();
    expect(()=>captured()).toThrow(D1InvocationBudgetExceededError);
    expect([invocation.queriesUsed,phase.queriesUsed]).toEqual([3,3]);
    expect([invocation.remainingQueries,phase.remainingQueries]).toEqual([1,0]);
    reservation!.unreserve();reservation!.unreserve();
    await observed.prepare('SELECT 1').run();
    expect([invocation.queriesUsed,phase.queriesUsed]).toEqual([4,4]);
    expect([invocation.remainingQueries,phase.remainingQueries]).toEqual([1,0]);
    expect([invocation.reserveQueries,phase.reserveQueries]).toEqual([0,0]);
  });
  it('refuses unknown or forged lineages before holding any verified meter',()=>{
    const meter=createD1InvocationBudget(3),db=meter.wrap(env.USAGE_MONITOR_DB);
    expect(reserveD1FinalQuery([db,env.DELETION_LEDGER])).toBeUndefined();
    const forged=new Proxy(env.DELETION_LEDGER,{get(target,key){
      if(typeof key==='symbol')return [{remaining:3,hold(){throw new Error('unverified holder');}}];
      return Reflect.get(target,key);
    }});
    expect(reserveD1FinalQuery([db,forged])).toBeUndefined();
    expect(meter.remainingQueries).toBe(3);
  });
  it('checks every enclosing cap before acquiring any final-query credit',async()=>{
    const invocation=createD1InvocationBudget(2),phase=createD1InvocationBudget(1);
    const db=phase.wrap(invocation.wrap(env.USAGE_MONITOR_DB));
    await db.prepare('SELECT 1').first();
    expect(()=>reserveD1FinalQuery([db])).toThrow(D1InvocationBudgetExceededError);
    expect([invocation.remainingQueries,phase.remainingQueries]).toEqual([1,0]);
    expect([invocation.queriesUsed,phase.queriesUsed]).toEqual([1,1]);
  });
  it('releases only its own held credit when reservations overlap',async()=>{
    const meter=createD1InvocationBudget(3),db=meter.wrap(env.USAGE_MONITOR_DB);
    const first=reserveD1FinalQuery([db])!,second=reserveD1FinalQuery([db])!;
    expect(meter.remainingQueries).toBe(1);
    first.unreserve();first.unreserve();
    expect(meter.remainingQueries).toBe(2);
    await db.prepare('SELECT 1').first();await db.prepare('SELECT 1').first();
    expect(()=>db.prepare('SELECT 1').first()).toThrow(D1InvocationBudgetExceededError);
    second.unreserve();await db.prepare('SELECT 1').first();
    expect(meter.queriesUsed).toBe(3);
  });
});
