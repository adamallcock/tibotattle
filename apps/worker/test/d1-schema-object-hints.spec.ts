import {applyD1Migrations,env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {createD1InvocationBudget,D1InvocationBudgetExceededError,d1SchemaObjectHintsFor,
 readD1SchemaObjectsAvailable} from '../src/d1-invocation-budget';
import {createD1SchemaObjectHints,type D1SchemaObject} from '../src/d1-schema-object-hints';
import {EFFECTIVE_SELECTIVE_METHOD,effectiveSelectiveSchemaAvailable,readEffectiveDependencySourceFence} from '../src/storage-effective-selective-dependencies';
import {initializeSharedAnalyticsCorpusDatabases,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';

const bindings=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=()=>bindings.USAGE_MONITOR_DB,target=()=>bindings.STORAGE_ANALYTICS_DB;
const required:readonly D1SchemaObject[]=[['table','hint_table'],['index','hint_index'],['trigger','hint_trigger']];
const make=async(db:D1Database)=>{
 await db.prepare('CREATE TABLE hint_table(id INTEGER PRIMARY KEY)').run();
 await db.prepare('CREATE INDEX hint_index ON hint_table(id)').run();
 await db.prepare('CREATE TRIGGER hint_trigger AFTER INSERT ON hint_table BEGIN SELECT 1; END').run();
};
const guard=async(db:D1Database,holder:ReturnType<typeof createD1SchemaObjectHints>,method='active')=>{
 const descriptor=holder.atomicGuard(db,required,2,3);
 const row=await db.prepare(`SELECT sequence FROM hint_runtime WHERE method=?1 AND ${descriptor.predicateSql}`)
  .bind(method,descriptor.json,descriptor.expectedCount).first<{sequence:number}>();
 return {mode:descriptor.mode,sequence:row?.sequence};
};

it('checks the full local source schema, then fresh exact rowids with one metered statement each',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,'synthetic-hint-source');
 let requiredPairs:readonly D1SchemaObject[]|undefined;
 const captured=new Proxy(source(),{get(db,key){
  if(key==='prepare')return(sql:string)=>{
   const prepared=db.prepare(sql);
   return new Proxy(prepared,{get(statement,method){
    if(method==='bind')return(...bound:unknown[])=>{
     if(sql.includes('FROM sqlite_schema s')&&typeof bound[1]==='string')
      requiredPairs=JSON.parse(bound[1]) as D1SchemaObject[];
     return Reflect.apply(statement.bind,statement,bound) as D1PreparedStatement;
    };
    const value:unknown=Reflect.get(statement,method);
    return typeof value==='function'?value.bind(statement):value;
   }});
  };
  const value:unknown=Reflect.get(db,key);
  return typeof value==='function'?value.bind(db):value;
 }});
 expect(await readEffectiveDependencySourceFence(captured)).toBeDefined();
 expect(requiredPairs?.length).toBeGreaterThan(200);
 const pairs=requiredPairs!;
 const meter=createD1InvocationBudget(10),db=meter.wrap(source());
 const holder=createD1SchemaObjectHints(db,pairs);
 expect(holder.atomicGuard(db,pairs,2,3).mode).toBe('full_pairs');
 expect(await holder.check(db,pairs)).toBe(true);
 expect(meter.queriesUsed).toBe(1);
 expect(holder.atomicGuard(db,pairs,2,3).mode).toBe('rowid_triples');
 expect(await holder.check(db,pairs)).toBe(true);
 expect(meter.queriesUsed).toBe(2);
 const descriptor=holder.atomicGuard(db,pairs,2,3);
 const fullLookup=`(SELECT count(*) FROM sqlite_schema s WHERE (s.type,s.name) IN(
  SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]')
  FROM json_each(json_extract(?2,'$.required'))))`;
 const tupleLookup=`(SELECT count(*) FROM sqlite_schema s WHERE (s.rowid,s.type,s.name) IN(
  SELECT CAST(json_extract(value,'$[0]') AS INTEGER),json_extract(value,'$[1]'),
    json_extract(value,'$[2]') FROM json_each(json_extract(?2,'$.hints'))))`;
 const predecessor=`(CASE WHEN ${tupleLookup}=?3 THEN 1 WHEN ${fullLookup}=?3 THEN 1 ELSE 0 END)=1`;
 expect(descriptor.predicateSql).toContain('CROSS JOIN sqlite_schema schema_object');
 const query=(predicate:string)=>`SELECT sequence AS generation,method AS capabilityVersion
  FROM storage_effective_selective_runtime WHERE id=1 AND method=?1 AND ${predicate}`;
 const measure=async(predicate:string)=>source().prepare(query(predicate))
  .bind(EFFECTIVE_SELECTIVE_METHOD,descriptor.json,descriptor.expectedCount)
  .all<{generation:number;capabilityVersion:string}>();
 const plan=async(predicate:string)=>(await source().prepare('EXPLAIN QUERY PLAN '+query(predicate))
  .bind(EFFECTIVE_SELECTIVE_METHOD,descriptor.json,descriptor.expectedCount)
  .all<{detail:string}>()).results.map(row=>row.detail);
 const setup=await source().prepare(`SELECT rowid,type,name FROM sqlite_schema s WHERE (s.type,s.name) IN(
  SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`)
  .bind(JSON.stringify(pairs)).all();
 const oldPlan=await plan(predecessor),newPlan=await plan(descriptor.predicateSql);
 const positiveOld=await measure(predecessor),positiveNew=await measure(descriptor.predicateSql);
 expect(positiveOld.results).toEqual(positiveNew.results);
 expect(positiveOld.results).toHaveLength(1);
 const indexSql=await source().prepare("SELECT sql FROM sqlite_schema WHERE name='storage_effective_selective_work_owner'")
  .first<string>('sql');
 expect(typeof indexSql).toBe('string');
 await source().prepare('DROP INDEX storage_effective_selective_work_owner').run();
 const absentOld=await measure(predecessor),absentNew=await measure(descriptor.predicateSql);
 expect(absentOld.results).toEqual(absentNew.results);
 expect(absentOld.results).toEqual([]);
 await source().prepare(indexSql!).run();
 const restoredOld=await measure(predecessor),restoredNew=await measure(descriptor.predicateSql);
 expect(restoredOld.results).toEqual(restoredNew.results);
 expect(restoredOld.results).toHaveLength(1);
 console.log('atomic source fence alternatives',JSON.stringify({required:pairs.length,setupRowsRead:setup.meta.rows_read,
  oldPlan:oldPlan.filter(detail=>/sqlite_schema|json_each|INTEGER PRIMARY KEY|SCAN s/u.test(detail)),
  newPlan:newPlan.filter(detail=>/sqlite_schema|json_each|INTEGER PRIMARY KEY|SCAN s/u.test(detail)),
  positive:{tupleRowsRead:positiveOld.meta.rows_read,rowidJoinRowsRead:positiveNew.meta.rows_read},
  absent:{tupleRowsRead:absentOld.meta.rows_read,rowidJoinRowsRead:absentNew.meta.rows_read},
  restored:{tupleRowsRead:restoredOld.meta.rows_read,rowidJoinRowsRead:restoredNew.meta.rows_read}}));
 await expect(holder.check(meter.wrap(target()),pairs)).rejects.toThrow('D1_SCHEMA_OBJECT_HINT_SCOPE_MISMATCH');
 await expect(holder.check(db,[...pairs.slice(0,-1)])).rejects.toThrow('D1_SCHEMA_OBJECT_HINT_SCOPE_MISMATCH');
 expect(()=>holder.atomicGuard(db,[...pairs.slice(0,-1)],2,3)).toThrow('D1_SCHEMA_OBJECT_HINT_SCOPE_MISMATCH');
 expect(()=>holder.atomicGuard(db,pairs,2,2)).toThrow('D1_SCHEMA_OBJECT_HINT_INPUT');
 expect(meter.queriesUsed).toBe(2);
},120_000);

it('refuses missing, replaced and wrong objects, rechecks absence, and restores exact atomic guard',async()=>{
 await reset();await applyD1Migrations(target(),bindings.TEST_ANALYTICS_MIGRATIONS);
 const db=target();await make(db);
 await db.prepare("CREATE TABLE hint_runtime(method TEXT NOT NULL,sequence INTEGER NOT NULL)").run();
 await db.prepare("INSERT INTO hint_runtime VALUES('active',7)").run();
 const meter=createD1InvocationBudget(100),scoped=meter.wrap(db),holder=createD1SchemaObjectHints(scoped,required);
 expect(await guard(scoped,holder)).toEqual({mode:'full_pairs',sequence:7});
 expect(await holder.check(scoped,required)).toBe(true);
 expect(await guard(scoped,holder)).toEqual({mode:'rowid_triples',sequence:7});
 expect((await guard(scoped,holder,'wrong')).sequence).toBeUndefined();

 await db.prepare('DROP TRIGGER hint_trigger').run();
 expect((await guard(scoped,holder)).sequence).toBeUndefined();
 const before=meter.queriesUsed;
 expect(await holder.check(scoped,required)).toBe(false);
 expect(meter.queriesUsed-before).toBe(2); // stale hint read plus full inventory
 const missing=meter.queriesUsed;
 expect(await holder.check(scoped,required)).toBe(false);
 expect(meter.queriesUsed-missing).toBe(1); // no cached absence
 await db.prepare('CREATE VIEW hint_trigger AS SELECT 1 id').run();
 expect(await holder.check(scoped,required)).toBe(false); // wrong type
 await db.prepare('DROP VIEW hint_trigger').run();
 await db.prepare('CREATE TRIGGER hint_trigger AFTER INSERT ON hint_table BEGIN SELECT 1; END').run();
 expect(await holder.check(scoped,required)).toBe(true);
 expect(await guard(scoped,holder)).toEqual({mode:'rowid_triples',sequence:7});

 await db.prepare('DROP INDEX hint_index').run();
 await db.prepare('CREATE INDEX hint_other ON hint_table(id)').run();
 expect(await holder.check(scoped,required)).toBe(false); // wrong name / foreign rowid
 await db.prepare('DROP INDEX hint_other').run();
 await db.prepare('CREATE INDEX hint_index ON hint_table(id)').run();
 expect(await holder.check(scoped,required)).toBe(true);
 const previousTrigger=await db.prepare("SELECT rowid FROM sqlite_schema WHERE name='hint_trigger'").first<number>('rowid');
 await db.prepare('DROP TRIGGER hint_trigger').run();
 await db.prepare('CREATE VIEW hint_foreign_view AS SELECT 1 id').run();
 await db.prepare('CREATE TRIGGER hint_trigger AFTER INSERT ON hint_table BEGIN SELECT 1; END').run();
 const restoredTrigger=await db.prepare("SELECT rowid FROM sqlite_schema WHERE name='hint_trigger'").first<number>('rowid');
 expect(restoredTrigger).not.toBe(previousTrigger);
 expect(await guard(scoped,holder)).toEqual({mode:'rowid_triples',sequence:7});
 expect(await holder.check(scoped,required)).toBe(true); // refresh stale rowid hints
 await db.prepare('DROP TABLE hint_table').run(); // cascades index and trigger
 await db.prepare('CREATE TABLE hint_foreign(id INTEGER PRIMARY KEY)').run();
 expect(await holder.check(scoped,required)).toBe(false); // stale or reused rowid
 await make(db);
 expect(await holder.check(scoped,required)).toBe(true);
 await db.prepare('CREATE TABLE hint_unrelated(id INTEGER PRIMARY KEY)').run();
 const unchanged=meter.queriesUsed;
 expect(await holder.check(scoped,required)).toBe(true);
 expect(meter.queriesUsed-unchanged).toBe(1);
},120_000);

it('meters nested wrappers, reserves final work, and propagates read failures',async()=>{
 await reset();await applyD1Migrations(target(),bindings.TEST_ANALYTICS_MIGRATIONS);
 await make(target());
 const outer=createD1InvocationBudget(8),inner=createD1InvocationBudget(6),
  outerDb=outer.wrap(target()),holder=createD1SchemaObjectHints(outerDb,required),
  nested=holder.withBudget(db=>inner.wrap(db)),db=inner.wrap(outerDb);
 expect(await holder.check(outerDb,required)).toBe(true);
 await expect(holder.check(db,required)).rejects.toThrow('D1_SCHEMA_OBJECT_HINT_SCOPE_MISMATCH');
 await expect(nested.check(outerDb,required)).rejects.toThrow('D1_SCHEMA_OBJECT_HINT_SCOPE_MISMATCH');
 expect([outer.queriesUsed,inner.queriesUsed]).toEqual([1,0]);
 expect(await nested.check(db,required)).toBe(true);
 expect([outer.queriesUsed,inner.queriesUsed]).toEqual([2,1]);
 await target().prepare('DROP INDEX hint_index').run();
 expect(await nested.check(db,required)).toBe(false);
 expect([outer.queriesUsed,inner.queriesUsed]).toEqual([4,3]);
 inner.reserveQueries=3;
 await expect(nested.check(db,required)).rejects.toBeInstanceOf(D1InvocationBudgetExceededError);
 expect([outer.queriesUsed,inner.queriesUsed]).toEqual([4,3]);

 const failure=new Error('synthetic D1 read failure');
 const throwing=new Proxy(target(),{get(database,key){
  if(key==='prepare')return()=>{throw failure;};
  const value:unknown=Reflect.get(database,key);
  return typeof value==='function'?value.bind(database):value;
 }});
 const failed=createD1SchemaObjectHints(throwing,required);
 await expect(failed.check(throwing,required)).rejects.toBe(failure);
},120_000);

it('propagates operation registry hints through nested budgets without reusing availability',async()=>{
 await reset();await initializeSharedAnalyticsCorpusDatabases(source(),target(),bindings,'synthetic-registry-source');
 await make(target());
 expect(d1SchemaObjectHintsFor(target(),required)).toBeUndefined();
 const directSql:string[]=[],direct=new Proxy(target(),{get(db,key){
  if(key==='prepare')return(sql:string)=>{directSql.push(sql);return db.prepare(sql);};
  const value:unknown=Reflect.get(db,key);
  return typeof value==='function'?value.bind(db):value;
 }});
 expect(await readD1SchemaObjectsAvailable(direct,required)).toBe(true);
 expect(await readD1SchemaObjectsAvailable(direct,required)).toBe(true);
 expect(directSql).toHaveLength(2);
 expect(directSql.every(sql=>sql.includes('(s.type,s.name) IN'))).toBe(true);
 const root=createD1InvocationBudget(30),child=createD1InvocationBudget(15),
  rootDb=root.wrap(target()),childDb=child.wrap(rootDb);
 const rootHints=d1SchemaObjectHintsFor(rootDb,required)!;
 expect(rootHints).toBe(d1SchemaObjectHintsFor(rootDb,required));
 expect(await readD1SchemaObjectsAvailable(rootDb,required)).toBe(true); // full setup
 expect(await readD1SchemaObjectsAvailable(rootDb,required)).toBe(true); // fresh rowid query
 const childHints=d1SchemaObjectHintsFor(childDb,required)!;
 await expect(rootHints.check(childDb,required)).rejects.toThrow('D1_SCHEMA_OBJECT_HINT_SCOPE_MISMATCH');
 await expect(childHints.check(rootDb,required)).rejects.toThrow('D1_SCHEMA_OBJECT_HINT_SCOPE_MISMATCH');
 await expect(childHints.check(childDb,[...required.slice(0,-1)])).rejects.toThrow('D1_SCHEMA_OBJECT_HINT_SCOPE_MISMATCH');
 expect(await readD1SchemaObjectsAvailable(childDb,required)).toBe(true); // shared positive rowid hints
 expect([root.queriesUsed,child.queriesUsed]).toEqual([3,1]);
 const separate=createD1InvocationBudget(10),separateDb=separate.wrap(target());
 expect(d1SchemaObjectHintsFor(separateDb,required)).not.toBe(rootHints);
 expect(await readD1SchemaObjectsAvailable(separateDb,required)).toBe(true);
 expect([root.queriesUsed,child.queriesUsed,separate.queriesUsed]).toEqual([3,1,1]);
 await target().prepare('DROP INDEX hint_index').run();
 expect(await readD1SchemaObjectsAvailable(childDb,required)).toBe(false); // fresh + full
 expect([root.queriesUsed,child.queriesUsed]).toEqual([5,3]);
 expect(await readD1SchemaObjectsAvailable(childDb,required)).toBe(false); // full, no negative cache
 expect([root.queriesUsed,child.queriesUsed]).toEqual([6,4]);
 await target().prepare('CREATE INDEX hint_index ON hint_table(id)').run();
 expect(await readD1SchemaObjectsAvailable(rootDb,required)).toBe(true); // full restoration
 expect(await readD1SchemaObjectsAvailable(childDb,required)).toBe(true); // shared refreshed rowids
 expect([root.queriesUsed,child.queriesUsed]).toEqual([8,5]);
 child.reserveQueries=10;
 await expect(readD1SchemaObjectsAvailable(childDb,required)).rejects.toBeInstanceOf(D1InvocationBudgetExceededError);
 expect([root.queriesUsed,child.queriesUsed]).toEqual([8,5]);

 const sourceMeter=createD1InvocationBudget(20),sourceDb=sourceMeter.wrap(source());
 const before=await readEffectiveDependencySourceFence(sourceDb);
 expect(before).toBeDefined();
 expect(sourceMeter.queriesUsed).toBe(2); // first full setup plus atomic runtime guard
 expect(await readEffectiveDependencySourceFence(sourceDb)).toEqual(before);
 expect(sourceMeter.queriesUsed).toBe(3);
 const ddl=await source().prepare("SELECT sql FROM sqlite_schema WHERE name='storage_effective_selective_work_owner'")
  .first<string>('sql');
 expect(typeof ddl).toBe('string');
 await source().prepare('DROP INDEX storage_effective_selective_work_owner').run();
 expect(await readEffectiveDependencySourceFence(sourceDb)).toBeUndefined();
 expect(sourceMeter.queriesUsed).toBe(4);
 expect(await effectiveSelectiveSchemaAvailable(sourceDb)).toBe(false);
 await source().prepare(ddl!).run();
 expect(await readEffectiveDependencySourceFence(sourceDb)).toEqual(before);
 expect(sourceMeter.queriesUsed).toBe(6); // stale triple uses full pair in the same SELECT
 expect(await effectiveSelectiveSchemaAvailable(sourceDb)).toBe(true);
 expect(sourceMeter.queriesUsed).toBeLessThanOrEqual(20);
},120_000);

it('binds fresh hints to an observing facade and meters each query through its child budget',async()=>{
 await reset();await applyD1Migrations(target(),bindings.TEST_ANALYTICS_MIGRATIONS);
 await make(target());
 const root=createD1InvocationBudget(30),child=createD1InvocationBudget(20);
 const rootDb=root.wrap(target()),observedSql:string[]=[];
 const facade=new Proxy(rootDb,{get(db,key){
  if(key==='prepare')return(sql:string)=>{observedSql.push(sql);return db.prepare(sql);};
  const value:unknown=Reflect.get(db,key);
  return typeof value==='function'?value.bind(db):value;
 }});
 const childDb=child.wrap(facade);
 const facadeHints=d1SchemaObjectHintsFor(facade,required)!;
 const childHints=d1SchemaObjectHintsFor(childDb,required)!;
 expect(facadeHints).toBe(d1SchemaObjectHintsFor(facade,required));
 expect(childHints).toBe(d1SchemaObjectHintsFor(childDb,required));
 await expect(facadeHints.check(rootDb,required)).rejects.toThrow('D1_SCHEMA_OBJECT_HINT_SCOPE_MISMATCH');
 await expect(facadeHints.check(childDb,required)).rejects.toThrow('D1_SCHEMA_OBJECT_HINT_SCOPE_MISMATCH');
 await expect(childHints.check(facade,required)).rejects.toThrow('D1_SCHEMA_OBJECT_HINT_SCOPE_MISMATCH');
 expect(()=>childHints.atomicGuard(facade,required,2,3)).toThrow('D1_SCHEMA_OBJECT_HINT_SCOPE_MISMATCH');
 expect([root.queriesUsed,child.queriesUsed,observedSql.length]).toEqual([0,0,0]);
 expect(await readD1SchemaObjectsAvailable(facade,required)).toBe(true);
 expect([root.queriesUsed,child.queriesUsed,observedSql.length]).toEqual([1,0,1]);
 expect(observedSql.at(-1)).toContain('(s.type,s.name) IN');
 expect(await readD1SchemaObjectsAvailable(childDb,required)).toBe(true);
 expect([root.queriesUsed,child.queriesUsed,observedSql.length]).toEqual([2,1,2]);
 expect(observedSql.at(-1)).toContain('WHERE rowid IN');
 expect(await readD1SchemaObjectsAvailable(facade,required)).toBe(true);
 expect([root.queriesUsed,child.queriesUsed,observedSql.length]).toEqual([3,1,3]);

 await target().prepare('DROP INDEX hint_index').run();
 expect(await readD1SchemaObjectsAvailable(childDb,required)).toBe(false);
 expect([root.queriesUsed,child.queriesUsed,observedSql.length]).toEqual([5,3,5]); // stale hint, then full fresh inventory
 expect(await readD1SchemaObjectsAvailable(facade,required)).toBe(false);
 expect([root.queriesUsed,child.queriesUsed,observedSql.length]).toEqual([6,3,6]); // no negative cache
 await target().prepare('CREATE INDEX hint_index ON hint_table(id)').run();
 expect(await readD1SchemaObjectsAvailable(childDb,required)).toBe(true);
 expect([root.queriesUsed,child.queriesUsed,observedSql.length]).toEqual([7,4,7]);
 expect(await readD1SchemaObjectsAvailable(facade,required)).toBe(true);
 expect([root.queriesUsed,child.queriesUsed,observedSql.length]).toEqual([8,4,8]);
 expect(observedSql.at(-1)).toContain('WHERE rowid IN');
},120_000);

it('bounds retained lists across root and child meters while overflow stays fresh',async()=>{
 await reset();await applyD1Migrations(target(),bindings.TEST_ANALYTICS_MIGRATIONS);
 const lists:D1SchemaObject[][]=[];
 for(let index=0;index<17;index++){
  const name=`hint_capacity_${index}`;
  await target().prepare(`CREATE TABLE ${name}(id INTEGER PRIMARY KEY)`).run();
  lists.push([['table',name]]);
 }
 const root=createD1InvocationBudget(100),child=createD1InvocationBudget(100),
  rootDb=root.wrap(target()),childDb=child.wrap(rootDb);
 for(let index=0;index<16;index++){
  const db=index%2===0?rootDb:childDb,list=lists[index]!;
  expect(d1SchemaObjectHintsFor(db,list)).toBeDefined();
  expect(await readD1SchemaObjectsAvailable(db,list)).toBe(true);
 }
 for(const db of [rootDb,childDb])expect(d1SchemaObjectHintsFor(db,lists[16]!)).toBeUndefined();
 const before=[root.queriesUsed,child.queriesUsed];
 expect(await readD1SchemaObjectsAvailable(childDb,lists[16]!)).toBe(true);
 expect([root.queriesUsed-before[0]!,child.queriesUsed-before[1]!]).toEqual([1,1]);
 await target().prepare('DROP TABLE hint_capacity_16').run();
 expect(await readD1SchemaObjectsAvailable(childDb,lists[16]!)).toBe(false);
 await target().prepare('CREATE TABLE hint_capacity_16(id INTEGER PRIMARY KEY)').run();
 expect(await readD1SchemaObjectsAvailable(rootDb,lists[16]!)).toBe(true);
 expect(d1SchemaObjectHintsFor(rootDb,lists[16]!)).toBeUndefined();
 expect(d1SchemaObjectHintsFor(childDb,lists[16]!)).toBeUndefined();
},120_000);
