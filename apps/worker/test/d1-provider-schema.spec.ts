import {env,reset} from 'cloudflare:test';
import {beforeEach,expect,it} from 'vitest';
import providers from '../src/d1-provider-schema.json';
const provider=providers[0]!;
import {authoritySchemaInventory} from '../src/authority-restore';

// D1 reserves _cf_ names and forbids creating them through its user API. Exercise
// the unchanged inventory SQL on D1 with injected metadata rows, not a bypass of
// provider permissions. The exact provider DDL is separately pinned from read-only
// source and ledger metadata; application restore tests use actual sqlite_schema.
const db=()=>env.USAGE_MONITOR_DB;
const inventoryDb=()=>new Proxy(db(),{get(target,key){
 if(key==='prepare')return (sql:string)=>target.prepare(sql.replaceAll('sqlite_master','synthetic_schema'));
 const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}});
async function add(row:typeof provider){await db().prepare('INSERT INTO synthetic_schema VALUES(?,?,?,?)')
 .bind(row.type,row.name,row.tbl_name,row.sql).run();}
beforeEach(async()=>{await reset();await db().prepare('CREATE TABLE synthetic_schema(type TEXT,name TEXT,tbl_name TEXT,sql TEXT)').run();});
it('excludes only exact provider metadata while retaining application schema',async()=>{
 await add({type:'table',name:'application_evidence',tbl_name:'application_evidence',sql:'CREATE TABLE application_evidence(id INTEGER PRIMARY KEY)'});
 expect((await db().prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB '_cf_*'").all()).results).toEqual([providers[1]]);
 expect((await authoritySchemaInventory(db())).map(row=>row.name)).toEqual(['synthetic_schema']);
 const baseline=await authoritySchemaInventory(inventoryDb());
 await add(provider);expect(await authoritySchemaInventory(inventoryDb())).toEqual(baseline);
 await add({type:'table',name:'_cf_application_evidence',tbl_name:'_cf_application_evidence',sql:'CREATE TABLE _cf_application_evidence(id INTEGER PRIMARY KEY)'});
 expect((await authoritySchemaInventory(inventoryDb())).map(row=>row.name)).toEqual(['_cf_application_evidence','application_evidence']);
});
it('retains altered provider DDL and attached SQL as drift evidence',async()=>{
 await add({...provider,sql:provider.sql.replace('value BLOB','value TEXT')});
 expect((await authoritySchemaInventory(inventoryDb())).map(row=>row.name)).toEqual(['_cf_KV']);
 await db().prepare('DELETE FROM synthetic_schema').run();await add(provider);
 await add({type:'trigger',name:'_authority_unreviewed_provider',tbl_name:'_cf_KV',sql:'CREATE TRIGGER _authority_unreviewed_provider AFTER INSERT ON _cf_KV BEGIN SELECT 1; END'});
 // Even a trigger in the operator namespace prevents excluding its parent;
 // the existing exact application-schema fence then refuses the changed set.
 expect((await authoritySchemaInventory(inventoryDb())).map(row=>row.name)).toEqual(['_cf_KV']);
});
