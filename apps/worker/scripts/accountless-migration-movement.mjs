/** Pure migration plans and local SQLite wrappers. No remote transport or maintenance authority. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { usesRangeRecordBatch } from './accountless-migration-range.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const prefix = '_accountless_move_';
// Keep these source-pinned journals and their FK ancestors visible to older
// upload cleanup reads. Canonical 0058 rebuilds them in one atomic transaction.
const retainedObjectTables = ['contributions','device_credentials','device_pairings','device_upload_authorizations','participants','telemetry_contributions','telemetry_v11_chunks','telemetry_v11_day_manifests','telemetry_v1_chunks','upload_authorizations','web_sessions'];
const fail = code => { throw new Error(`ACCOUNTLESS_MOVEMENT_${code}`); };
const check = (condition, code) => { if (!condition) fail(code); };
const get = (db, sql, ...args) => db.prepare(sql).get(...args);
const atomic = (db, action) => { db.exec('BEGIN IMMEDIATE'); try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } };
const empty = (db, table) => !get(db, `SELECT 1 AS present FROM ${quote(table)} LIMIT 1`);
const state = db => JSON.parse(get(db, `SELECT metadata FROM ${prefix}journal WHERE id=1`).metadata);
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_accountless_move_%' ORDER BY type,name").all();
function verifySource(sources) {
  check(Array.isArray(sources) && sources.length === 59, 'SOURCE_INVALID');
  check(sources[57].name === '0058_accountless_upload_ownership.sql' && hash(sources[57].sql) === 'b435fd92d41e7ce8067cc183d7ac153359a9c130a971cba2e1b8b8c1c9cab61b', 'SOURCE_INVALID');
  check(sources[58].name === '0059_accountless_upload_renewal.sql' && hash(sources[58].sql) === '98afb99dd91e56a96960e6d99096e44c41eec0cd52d5a1e2969dea4ddee3d312', 'SOURCE_INVALID');
  return hash(JSON.stringify(sources.map(({ name, sql }) => [name, hash(sql)])));
}
function ledger(db, sources, count) { check(isDeepStrictEqual(db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map(r => r.name), sources.slice(0, count).map(r => r.name)), 'PREFIX_DRIFT'); }
function readKeyRows(db, sql) { const stmt = db.prepare(sql); stmt.setReadBigInts(true); return stmt.all(); }

function replayDrops(sources) { return [...new Map([...sources[57].sql.matchAll(/^DROP (TRIGGER|VIEW) IF EXISTS (\w+);$/gm)].map(m => [m[2],{sql:m[0],type:m[1].toLowerCase(),name:m[2]}])).values()]; }
function planWriter(permission) {
  const statements=[];
  if(permission) { check(permission.begin?.sql && Array.isArray(permission.begin.params) && Array.isArray(permission.end) && permission.end.length===2 && permission.end.every(s=>typeof s.sql==='string'&&Array.isArray(s.params)), 'PERMISSION_INVALID'); statements.push(permission.begin); }
  return { statements, add:(sql,...params)=>statements.push({sql,params}),
    assertion:(condition,...params)=>statements.push({sql:`INSERT OR REPLACE INTO ${prefix}assertion(id,ok) VALUES(1,(${condition}))`,params}),
    finish:()=>{if(permission)statements.push(...permission.end);} };
}
function ledgerAssertion(writer,sources,count) {
  writer.assertion(`(SELECT COUNT(*) FROM d1_migrations)=? AND NOT EXISTS(SELECT 1 FROM (SELECT name,ROW_NUMBER() OVER(ORDER BY id) AS position FROM d1_migrations) actual JOIN json_each(?) expected ON actual.position=CAST(expected.key AS INTEGER)+1 WHERE actual.name<>expected.value)`,count,JSON.stringify(sources.slice(0,count).map(s=>s.name)));
}
const readback = () => ({sql:`SELECT metadata FROM ${prefix}journal WHERE id=1`,params:[]});
function executePlan(db,plan) { for(const statement of plan.statements) { if(statement.compound) {check(statement.params.length===0,'PARAM_INVALID');db.exec(statement.sql);} else db.prepare(statement.sql).run(...statement.params); } }

/** Metadata must already be admitted against the exact source/schema/operation. */
export function planAccountlessMovementSetup({sources,schemaObjects,foreignKeys,tableInfo,sequences,permission=null,retainObjectReferences=false,rangeRecordBatches=false}) {
  const digest=verifySource(sources), all=schemaObjects;
  check(!all.some(o=>o.name.startsWith(prefix)), 'OWNED_OBJECT_COLLISION');
  check(typeof retainObjectReferences==='boolean','RETAIN_MODE_INVALID');
  check(typeof rangeRecordBatches==='boolean'&&(!rangeRecordBatches||retainObjectReferences),'RANGE_MODE_INVALID');
  const canonicalTables=[...sources[57].sql.matchAll(/CREATE TABLE (\w+)_0058_save AS/g)].map(m=>m[1]);
  check(canonicalTables.length===52&&new Set(canonicalTables).size===52,'TABLE_SET_INVALID');
  const tables=canonicalTables.filter(t=>!retainObjectReferences||!retainedObjectTables.includes(t));
  check(!retainObjectReferences || (tables.length===41&&retainedObjectTables.every(t=>canonicalTables.includes(t)&&! /AUTOINCREMENT/i.test(all.find(o=>o.type==='table'&&o.name===t)?.sql??'AUTOINCREMENT'))),'RETAIN_SCHEMA_INVALID');
  const refs=Object.fromEntries(all.filter(o=>o.type==='table').map(o=>[o.name,foreignKeys[o.name].map(r=>r.table)]));
  check(!Object.entries(refs).some(([name,parents])=>!tables.includes(name)&&parents.some(p=>tables.includes(p))),'DEPENDENCY_DRIFT');
  const order=[],visiting=new Set();
  function visit(table) {if(order.includes(table))return;check(!visiting.has(table),'DEPENDENCY_CYCLE');visiting.add(table);for(const parent of refs[table])if(tables.includes(parent))visit(parent);visiting.delete(table);order.push(table);}
  tables.forEach(visit);
  const descriptors=Object.fromEntries(tables.map(table=>{
    const info=tableInfo[table],columns=info.map(r=>r.name);
    check(!columns.some(c=>['_move_key','_original_rowid','rowid','_rowid_','oid'].includes(c)),'COLUMN_COLLISION');
    const hasRowid=!/WITHOUT\s+ROWID/i.test(all.find(o=>o.type==='table'&&o.name===table).sql);
    return [table,{columns,hasRowid,keys:hasRowid?['rowid']:info.filter(r=>r.pk).sort((a,b)=>a.pk-b.pk).map(r=>r.name),integerKeys:hasRowid?['rowid']:info.filter(r=>r.pk&&r.type==='INTEGER').map(r=>r.name)}];
  }));
  const savedSequences=sequences.filter(r=>tables.includes(r.name)).map(({name,seq})=>{check(typeof seq==='string'&&/^(0|[1-9][0-9]*)$/.test(seq)&&BigInt(seq)<=9223372036854775807n,'SEQUENCE_INVALID');return {name,seq};});
  check(new Set(savedSequences.map(r=>r.name)).size===savedSequences.length,'SEQUENCE_INVALID');
  const current={digest,phase:'evacuate',revision:0,tableIndex:0,cursor:0,order,descriptors,sequences:savedSequences,canonicalObjects:null,...(rangeRecordBatches?{rangeRecordBatches:true}:{}),...(retainObjectReferences?{retainedObjectTables:[...retainedObjectTables]}:{})};
  const w=planWriter(permission);
  w.add(`CREATE TABLE ${prefix}journal(id INTEGER PRIMARY KEY CHECK(id=1), metadata TEXT NOT NULL)`);
  w.add(`CREATE TABLE ${prefix}assertion(id INTEGER PRIMARY KEY CHECK(id=1), ok INTEGER NOT NULL CHECK(ok=1))`);
  ledgerAssertion(w,sources,57);w.assertion('NOT EXISTS(SELECT 1 FROM accountless_enrollment_ledger LIMIT 1)');
  for(const table of tables)w.add(`CREATE TABLE ${quote(prefix+table)} (_move_key INTEGER PRIMARY KEY, _original_rowid INTEGER, ${descriptors[table].columns.map(quote).join(',')})`);
  w.add(`INSERT INTO ${prefix}journal VALUES(1,?)`,JSON.stringify(current));
  for(const drop of replayDrops(sources))w.add(drop.sql);
  w.add(`DELETE FROM ${prefix}assertion WHERE id=1`);w.finish();
  return {statements:w.statements,current,readback:readback()};
}

export function prepareAccountlessMovement(db,sources,{retainObjectReferences=false,rangeRecordBatches=false}={}) {
  check(typeof retainObjectReferences==='boolean','RETAIN_MODE_INVALID');
  check(typeof rangeRecordBatches==='boolean'&&(!rangeRecordBatches||retainObjectReferences),'RANGE_MODE_INVALID');
  const digest=verifySource(sources);check(get(db,'PRAGMA foreign_keys').foreign_keys===1,'FOREIGN_KEYS_REQUIRED');
  if(get(db,'SELECT 1 FROM sqlite_master WHERE name=?',`${prefix}journal`)){const current=state(db);check(current.digest===digest,'SOURCE_DRIFT');check(isDeepStrictEqual(current.retainedObjectTables??[],retainObjectReferences?retainedObjectTables:[]),'RETAIN_MODE_DRIFT');check((current.rangeRecordBatches===true)===rangeRecordBatches,'RANGE_MODE_DRIFT');return current;}
  ledger(db,sources,57);check(empty(db,'accountless_enrollment_ledger'),'ACCOUNTLESS_LEDGER_NOT_EMPTY');
  const schemaObjects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables=schemaObjects.filter(o=>o.type==='table');
  const plan=planAccountlessMovementSetup({sources,schemaObjects,retainObjectReferences,rangeRecordBatches,foreignKeys:Object.fromEntries(tables.map(o=>[o.name,db.prepare(`PRAGMA foreign_key_list(${quote(o.name)})`).all()])),tableInfo:Object.fromEntries(tables.map(o=>[o.name,db.prepare(`PRAGMA table_info(${quote(o.name)})`).all()])),sequences:readKeyRows(db,'SELECT name,seq FROM sqlite_sequence').map(r=>({name:r.name,seq:String(r.seq)}))});
  return atomic(db,()=>{executePlan(db,plan);return state(db);});
}

/** Read only bounded key/length metadata; integer keys remain exact through D1 JSON. */
export function accountlessMovementSelection(current, { maxRows = 32 } = {}) {
  check(Number.isSafeInteger(maxRows) && maxRows > 0 && maxRows <= 64, 'LIMIT_INVALID');
  check(!usesRangeRecordBatch(current),'RANGE_BATCH_REQUIRED');
  const { from, keys, integerKeys, d } = batchContext(current);
  return { sql: `SELECT ${keys.map((k,i) => `${integerKeys.includes(k) ? `CAST(${quote(k)} AS TEXT)` : quote(k)} AS _key${i}`).join(',')},(${rowBytes(d)}) AS _bytes FROM ${quote(from)} ORDER BY ${keys.map(quote).join(',')} LIMIT ${maxRows}`, params: [] };
}
function rowBytes(d) { return d.columns.map(c => `COALESCE(length(CAST(${quote(c)} AS BLOB)),0)`).join('+'); }
function batchContext(current) {
  check(['evacuate','restore'].includes(current.phase), 'PHASE_INVALID');
  const order = current.phase === 'evacuate' ? [...current.order].reverse() : current.order;
  check(current.tableIndex < order.length, 'PHASE_COMPLETE');
  const table = order[current.tableIndex], d = current.descriptors[table], evacuating = current.phase === 'evacuate';
  return { table, d, evacuating, from: evacuating ? table : prefix+table, to: evacuating ? prefix+table : table,
    keys: evacuating ? d.keys : ['_move_key'], integerKeys: evacuating ? d.integerKeys : ['_move_key'] };
}

/** Pure prepared statements for one atomic D1.batch, never BEGIN/COMMIT SQL.
 * `current` must be the admitted persisted journal, not client-provided state.
 * The caller must establish the separate maintenance barrier and supply its exact
 * transaction permission statements; this planner does not authorize remote work.
 */
export function planAccountlessMovementBatch({ current, selectedRows, expectedRevision, maxRows = 32, maxBytes = 256*1024, permission = null }) {
  accountlessMovementSelection(current,{maxRows});
  check(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 1024*1024, 'LIMIT_INVALID');
  check(current.revision === expectedRevision, 'REVISION_CONFLICT');
  check(Array.isArray(selectedRows) && selectedRows.length <= maxRows, 'SELECTION_INVALID');
  const {table,d,evacuating,from,to,keys,integerKeys} = batchContext(current), statements=[];
  const add = (sql,...params) => statements.push({sql,params});
  const assertion = (condition,...params) => add(`INSERT OR REPLACE INTO ${prefix}assertion(id,ok) VALUES(1,(${condition}))`,...params);
  if(permission) { check(permission.begin?.sql && Array.isArray(permission.begin.params) && Array.isArray(permission.end) && permission.end.length === 2 && permission.end.every(s => typeof s.sql === 'string' && Array.isArray(s.params)), 'PERMISSION_INVALID'); statements.push(permission.begin); }
  assertion(`SELECT metadata=? FROM ${prefix}journal WHERE id=1`,JSON.stringify(current));
  let rows=0,bytes=0;
  for(const row of selectedRows) {
    check(Number.isSafeInteger(row._bytes) && row._bytes >= 0, 'SELECTION_INVALID');
    check(row._bytes <= maxBytes, 'ROW_TOO_LARGE'); if(bytes+row._bytes>maxBytes)break;
    const values=keys.map((k,i)=>{
      const value=row[`_key${i}`];
      if(integerKeys.includes(k)) check(typeof value==='string' && /^-?(0|[1-9][0-9]*)$/.test(value) && BigInt(value)>=-9223372036854775808n && BigInt(value)<=9223372036854775807n,'KEY_INVALID');
      else check(typeof value==='string' && Buffer.byteLength(value)<=4096,'KEY_INVALID');
      return value;
    });
    const where=keys.map(k=>`${quote(k)} IS ${integerKeys.includes(k)?'CAST(? AS INTEGER)':'?'}`).join(' AND '),cols=d.columns.map(quote).join(',');
    const moveKey=evacuating?current.cursor+rows+1:values[0];
    check(!evacuating || Number.isSafeInteger(moveKey),'COUNTER_EXHAUSTED');
    if(evacuating)add(`INSERT INTO ${quote(to)} (_move_key,_original_rowid,${cols}) SELECT CAST(? AS INTEGER),${d.hasRowid?'rowid':'NULL'},${cols} FROM ${quote(from)} WHERE ${where} AND (${rowBytes(d)})=?`,moveKey,...values,row._bytes);
    else add(`INSERT INTO ${quote(to)} (${d.hasRowid?'rowid,':''}${cols}) SELECT ${d.hasRowid?'_original_rowid,':''}${cols} FROM ${quote(from)} WHERE ${where} AND (${rowBytes(d)})=?`,...values,row._bytes);
    assertion('changes()=1');
    const identity=d.hasRowid?'a.rowid IS b._original_rowid':d.keys.map(k=>`a.${quote(k)} IS b.${quote(k)}`).join(' AND ');
    const equal=d.columns.map(c=>`a.${quote(c)} IS b.${quote(c)}`).join(' AND ');
    assertion(`EXISTS(SELECT 1 FROM ${quote(table)} a JOIN ${quote(prefix+table)} b ON ${identity} WHERE b._move_key=CAST(? AS INTEGER) AND ${equal})`,moveKey);
    add(`DELETE FROM ${quote(from)} WHERE ${where}`,...values); assertion('changes()=1');
    rows++;bytes+=row._bytes;
  }
  const next={...current,revision:current.revision+1,cursor:current.cursor+rows};
  check(Number.isSafeInteger(next.revision)&&Number.isSafeInteger(next.cursor),'COUNTER_EXHAUSTED');
  add(`UPDATE ${prefix}journal SET metadata=json_set(?, '$.tableIndex', CASE WHEN EXISTS(SELECT 1 FROM ${quote(from)} LIMIT 1) THEN CAST(? AS INTEGER) ELSE CAST(? AS INTEGER) END, '$.cursor', CASE WHEN EXISTS(SELECT 1 FROM ${quote(from)} LIMIT 1) THEN CAST(? AS INTEGER) ELSE 0 END) WHERE id=1 AND metadata=?`,JSON.stringify(next),current.tableIndex,current.tableIndex+1,next.cursor,JSON.stringify(current));
  assertion('changes()=1');add(`DELETE FROM ${prefix}assertion WHERE id=1`);
  if(permission)statements.push(...permission.end);
  return {statements,result:{revision:next.revision,phase:next.phase,rows,bytes},readback:{sql:`SELECT metadata FROM ${prefix}journal WHERE id=1`,params:[]}};
}

/** Same emitted statements run locally; exhaustive oracles live only in tests. */
export function moveAccountlessBatch(db, {expectedRevision,maxRows=32,maxBytes=256*1024,beforeCommit=()=>{}}={}) {
  check(get(db,'PRAGMA foreign_keys').foreign_keys===1,'FOREIGN_KEYS_REQUIRED');
  return atomic(db,()=>{
    const current=state(db),selection=accountlessMovementSelection(current,{maxRows});
    const plan=planAccountlessMovementBatch({current,selectedRows:db.prepare(selection.sql).all(...selection.params),expectedRevision,maxRows,maxBytes});
    for(const {sql,params} of plan.statements) db.prepare(sql).run(...params);
    beforeCommit(plan.result);const next=state(db);
    return {...plan.result,phaseComplete:next.tableIndex===next.order.length};
  });
}

/** Canonical objects are from an admitted empty schema-58 fixture, never live barrier DDL. */
export function planAccountlessMovementTransition({sources,current,expectedRevision,canonicalObjects=null,permission=null,guardStatements=[]}) {
  const digest=verifySource(sources),old=current;
  check(old.digest===digest&&old.revision===expectedRevision,'REVISION_CONFLICT');
  check(old.tableIndex===old.order.length,'PHASE_INCOMPLETE');
  check(['evacuate','restore'].includes(old.phase),'PHASE_INVALID');
  const next=structuredClone(old),w=planWriter(permission);
  ledgerAssertion(w,sources,old.phase==='evacuate'?57:58);
  const drops=replayDrops(sources);
  check(Array.isArray(canonicalObjects),'CANONICAL_OBJECTS_REQUIRED');
  check(canonicalObjects.every(o=>o && typeof o.type==='string' && typeof o.name==='string' && typeof o.sql==='string'),'CANONICAL_OBJECTS_INVALID');
  const objectKey=o=>o.type+'\0'+o.name;
  check(new Set(canonicalObjects.map(objectKey)).size===canonicalObjects.length,'CANONICAL_OBJECTS_INVALID');
  const replayObjects=drops.map(drop=>canonicalObjects.find(o=>o.name===drop.name&&o.type===drop.type)).filter(Boolean);
  // Derived from the empty canonical 0001–0058 fixture whose migration bytes
  // are pinned above. A partial list must never silently omit replay guards.
  const replayManifest=replayObjects.map(({type,name,sql})=>({type,name,sql})).sort((a,b)=>objectKey(a)<objectKey(b)?-1:objectKey(a)>objectKey(b)?1:0);
  check(replayManifest.length===90&&hash(JSON.stringify(replayManifest))==='659563de82b31bbb8cd5b5488d29c46847dd16ff51904ecf7d159dad00f33d60','CANONICAL_OBJECTS_INVALID');
  next.canonicalObjects=null;
  if(old.phase==='evacuate') {
    w.assertion(old.order.map(table=>`NOT EXISTS(SELECT 1 FROM ${quote(table)} LIMIT 1)`).join(' AND '));
    w.statements.push({sql:sources[57].sql,params:[],compound:true});
    w.add('INSERT INTO d1_migrations(name) VALUES(?)',sources[57].name);
    for(const drop of drops)w.add(drop.sql);
    next.phase='restore';next.tableIndex=0;next.cursor=0;
  } else {
    w.assertion(old.order.map(table=>`NOT EXISTS(SELECT 1 FROM ${quote(prefix+table)} LIMIT 1)`).join(' AND '));
    for(const object of replayObjects)w.add(object.sql);
    for(const {name,seq} of old.sequences) {
      check(typeof seq==='string'&&/^(0|[1-9][0-9]*)$/.test(seq)&&BigInt(seq)<=9223372036854775807n,'SEQUENCE_INVALID');
      w.add('UPDATE sqlite_sequence SET seq=MAX(seq,CAST(? AS INTEGER)) WHERE name=?',seq,name);
      w.add('INSERT INTO sqlite_sequence(name,seq) SELECT ?,CAST(? AS INTEGER) WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name=?)',name,seq,name);
    }
    w.assertion('NOT EXISTS(SELECT 1 FROM accountless_enrollment_ledger LIMIT 1)');
    w.statements.push({sql:sources[58].sql,params:[],compound:true});
    w.add('INSERT INTO d1_migrations(name) VALUES(?)',sources[58].name);
    for(const table of old.order)w.add(`DROP TABLE ${quote(prefix+table)}`);
    next.phase='complete';
  }
  w.statements.push(...guardStatements);
  next.revision++;check(Number.isSafeInteger(next.revision),'COUNTER_EXHAUSTED');
  w.add(`UPDATE ${prefix}journal SET metadata=json_set(metadata,'$.phase',?,'$.revision',CAST(? AS INTEGER),'$.tableIndex',CAST(? AS INTEGER),'$.cursor',CAST(? AS INTEGER),'$.canonicalObjects',NULL) WHERE id=1 AND metadata=?`,next.phase,next.revision,next.tableIndex,next.cursor,JSON.stringify(old));w.assertion('changes()=1');w.add(`DELETE FROM ${prefix}assertion WHERE id=1`);w.finish();
  return {statements:w.statements,current:next,readback:readback()};
}

export function transitionAccountlessMovement(db,sources,expectedRevision) {
  check(get(db,'PRAGMA foreign_keys').foreign_keys===1,'FOREIGN_KEYS_REQUIRED');
  const current=state(db);let canonicalObjects=null;
  if(['evacuate','restore'].includes(current.phase)) {
    const fixture=new db.constructor(':memory:');
    try {fixture.exec('PRAGMA foreign_keys=ON');for(const source of sources.slice(0,58))fixture.exec(source.sql);canonicalObjects=schema(fixture).filter(o=>['trigger','view'].includes(o.type));}finally{fixture.close();}
  }
  const plan=planAccountlessMovementTransition({sources,current,expectedRevision,canonicalObjects});
  return atomic(db,()=>{executePlan(db,plan);return state(db);});
}
