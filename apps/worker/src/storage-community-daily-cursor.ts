/** Scheduling only. These positions never prove an owner fold or publication. */
export const DAILY_OWNER_CURSOR_TABLE_SQL = `CREATE TABLE analytics_community_daily_owner_cursor (
 cursor_id INTEGER PRIMARY KEY AUTOINCREMENT,
 source_id TEXT NOT NULL REFERENCES analytics_runtime_sources(source_id),
 day TEXT NOT NULL CHECK(length(day)=10),
 next_owner_offset INTEGER NOT NULL CHECK(next_owner_offset BETWEEN 0 AND 9007199254740991),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 UNIQUE(source_id,day),
 CHECK(cursor_id BETWEEN 1 AND 9007199254740991)
) STRICT`;
export const DAILY_OWNER_CURSOR_GUARD_SQL = `CREATE TRIGGER analytics_community_daily_owner_cursor_update
BEFORE UPDATE ON analytics_community_daily_owner_cursor
WHEN NEW.cursor_id!=OLD.cursor_id OR NEW.source_id!=OLD.source_id OR NEW.day!=OLD.day
 OR NEW.revision!=OLD.revision+1
BEGIN SELECT RAISE(ABORT,'analytics_daily_owner_cursor_conflict'); END`;
const TABLE='analytics_community_daily_owner_cursor',GUARD=TABLE+'_update';
const sqlLiteral=(value:string)=>"'"+value.replaceAll("'","''")+"'";
/** Fresh inside each write. No caller-provided SQL or cached availability. */
export const DAILY_OWNER_CURSOR_CAPABILITY_SQL=`(SELECT count(*) FROM sqlite_schema s WHERE
 (s.type='table' AND s.name='${TABLE}' AND s.tbl_name='${TABLE}' AND s.sql=${sqlLiteral(DAILY_OWNER_CURSOR_TABLE_SQL)})
 OR (s.type='trigger' AND s.name='${GUARD}' AND s.tbl_name='${TABLE}' AND s.sql=${sqlLiteral(DAILY_OWNER_CURSOR_GUARD_SQL)})
)=2 AND NOT EXISTS(SELECT 1 FROM sqlite_schema s WHERE s.tbl_name='${TABLE}' AND s.sql IS NOT NULL
 AND s.name NOT IN('${TABLE}','${GUARD}'))
 AND EXISTS(SELECT 1 FROM pragma_index_list('${TABLE}') i WHERE i.\"unique\"=1 AND i.origin='u' AND i.partial=0
  AND (SELECT group_concat(name,',') FROM(SELECT name FROM pragma_index_info(i.name) ORDER BY seqno))='source_id,day')`;
const FAMILY_NAMES=['analytics_shared_preparation_cursor','analytics_shared_preparation_ranges',
 'analytics_shared_preparation_pending','analytics_shared_preparation_range_insert','analytics_shared_preparation_range_update',
 'analytics_shared_preparation_owner_terminal','analytics_shared_preparation_erasure','analytics_shared_feature_release_v1'];
const NATIVE_LEDGER_SQL="CREATE TABLE \"d1_migrations\" (\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n\t)";
const WRANGLER_LEDGER_SQL=NATIVE_LEDGER_SQL.replace('"d1_migrations" (','"d1_migrations"(').replace('\n\t)','\n)');
const OPERATOR_LEDGER_SQL='CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT';
const fail=()=>new Error('STORAGE_COMMUNITY_DAILY_CURSOR_UNAVAILABLE');
const integer=(value:unknown,min=0):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;
export type DailyOwnerCursorMode='installed'|'predecessor'|'unavailable';
export interface DailyOwnerCursor {cursor_id:number;next_owner_offset:number;revision:number}
function cursor(value:DailyOwnerCursor|null):value is DailyOwnerCursor {
 return value!==null&&integer(value.cursor_id,1)&&integer(value.next_owner_offset)&&integer(value.revision,1);
}
/** Only this closed native frontier may use the pre-migration algorithm. */
const PREDECESSOR_TABLES:readonly (readonly [string,string])[]=[
 [
  "analytics_owner_state",
  "CREATE TABLE analytics_owner_state (\n  source_id TEXT NOT NULL,\n  owner_digest TEXT NOT NULL,\n  revision INTEGER NOT NULL CHECK(revision>0),\n  authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),\n  state TEXT NOT NULL CHECK(state IN ('active','withdrawn','erased')),\n  PRIMARY KEY(source_id,owner_digest)\n) STRICT, WITHOUT ROWID"
 ],
 [
  "analytics_runtime_sources",
  "CREATE TABLE analytics_runtime_sources (\n source_id TEXT PRIMARY KEY,\n source_namespace TEXT NOT NULL,\n contract_version INTEGER NOT NULL CHECK(contract_version=1)\n) STRICT, WITHOUT ROWID"
 ],
 [
  "analytics_community_daily_queue",
  "CREATE TABLE analytics_community_daily_queue (\n source_id TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),\n PRIMARY KEY(source_id,day)\n) STRICT, WITHOUT ROWID"
 ],
 [
  "analytics_community_daily_publications",
  "CREATE TABLE analytics_community_daily_publications (\n source_id TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),\n cohort_digest TEXT NOT NULL,authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),\n payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),payload_sha256 TEXT NOT NULL,\n released_at TEXT NOT NULL,\n PRIMARY KEY(source_id,day,revision)\n) STRICT, WITHOUT ROWID"
 ],
 [
  "analytics_community_daily_heads",
  "CREATE TABLE analytics_community_daily_heads (\n source_id TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),\n cohort_digest TEXT NOT NULL,PRIMARY KEY(source_id,day)\n) STRICT, WITHOUT ROWID"
 ],
 [
  "analytics_community_daily_owners",
  "CREATE TABLE analytics_community_daily_owners (\n source_id TEXT NOT NULL,day TEXT NOT NULL,owner_digest TEXT NOT NULL,\n input_revision INTEGER NOT NULL,owner_revision INTEGER NOT NULL,\n source_format TEXT NOT NULL CHECK(source_format IN ('v1','v11','effective')),\n method TEXT NOT NULL,progress_revision INTEGER NOT NULL CHECK(progress_revision>0),\n next_index INTEGER NOT NULL CHECK(next_index>=0),fingerprint TEXT,\n complete INTEGER NOT NULL CHECK(complete IN (0,1)),\n values_json TEXT NOT NULL CHECK(json_valid(values_json)),\n PRIMARY KEY(source_id,day,owner_digest)\n) STRICT, WITHOUT ROWID"
 ],
 [
  "analytics_cache_retention_owner_cursor",
  "CREATE TABLE analytics_cache_retention_owner_cursor (\n  source_id TEXT NOT NULL,\n  shard_count INTEGER NOT NULL CHECK(shard_count BETWEEN 1 AND 256),\n  shard_index INTEGER NOT NULL CHECK(shard_index>=0 AND shard_index<shard_count),\n  method_version TEXT NOT NULL CHECK(length(method_version)>0 AND length(method_version)<=128),\n  next_owner_offset INTEGER NOT NULL CHECK(next_owner_offset>=0),\n  revision INTEGER NOT NULL CHECK(revision>0),\n  PRIMARY KEY(source_id,shard_count,shard_index),\n  FOREIGN KEY(source_id) REFERENCES analytics_runtime_sources(source_id)\n) STRICT, WITHOUT ROWID"
 ]
];
const PREDECESSOR_GUARDS=['analytics_runtime_source_immutable','analytics_runtime_source_retained',
 'analytics_community_daily_revision_order','analytics_community_daily_head_advance','analytics_community_daily_revision_immutable',
 'analytics_daily_owner_erased_insert','analytics_daily_owner_erased_update','analytics_community_daily_owner_terminal',
 'analytics_daily_containment_delivered','analytics_daily_containment_inserted','analytics_daily_containment_fenced'];
export async function dailyOwnerCursorMode(db:D1Database):Promise<DailyOwnerCursorMode>{
 const state=await db.prepare(`SELECT CASE WHEN ${DAILY_OWNER_CURSOR_CAPABILITY_SQL} THEN 1 ELSE 0 END AS ready,
 (SELECT count(*) FROM sqlite_schema WHERE name IN(SELECT value FROM json_each(?)) OR name GLOB 'analytics_canonical_*'
  OR name GLOB 'analytics_partition_*' OR name GLOB 'analytics_effective_*' OR name='analytics_cleanup_cadence') AS installed`)
  .bind(JSON.stringify([TABLE,GUARD,...FAMILY_NAMES])).first<{ready:number;installed:number}>();
 if(state?.ready===1)return 'installed';
 if(!state||state.installed!==0)return 'unavailable';
 const ledger=(await db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
 WHERE name IN('d1_migrations','d1_storage_migrations') OR (tbl_name IN('d1_migrations','d1_storage_migrations') AND sql IS NOT NULL)
 ORDER BY name`).all<{type:string;name:string;tbl_name:string;sql:string}>()).results;
 if(ledger.length!==1)return 'unavailable';
 const row=ledger[0]!;
 if(row.type!=='table'||row.tbl_name!==row.name)return 'unavailable';
 let names:string[];
 if(row.name==='d1_storage_migrations'){
  if(row.sql!==OPERATOR_LEDGER_SQL)return 'unavailable';
  const rows=(await db.prepare('SELECT name,sha256 FROM d1_storage_migrations ORDER BY name LIMIT 129')
   .all<{name:string;sha256:string}>()).results;
  if(rows.some(value=>!/^[a-f0-9]{64}$/u.test(value.sha256)))return 'unavailable';
  names=rows.map(value=>value.name);
 }else if(row.name==='d1_migrations'){
  if(row.sql!==NATIVE_LEDGER_SQL&&row.sql!==WRANGLER_LEDGER_SQL)return 'unavailable';
  names=(await db.prepare('SELECT name FROM d1_migrations ORDER BY name LIMIT 129').all<{name:string}>()).results.map(value=>value.name);
 }else return 'unavailable';
 if(!names.includes('0033_cache_retention_owner_cursor.sql')||names.length>128
  ||names.some(name=>typeof name!=='string'||!/^\d{4}_[a-z0-9_]+\.sql$/u.test(name)||name>='0034_')
  ||new Set(names).size!==names.length)return 'unavailable';
 const prior=(await db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN(SELECT value FROM json_each(?))`)
  .bind(JSON.stringify([...PREDECESSOR_TABLES.map(([name])=>name),...PREDECESSOR_GUARDS])).all<{type:string;name:string;tbl_name:string;sql:string}>()).results;
 if(prior.length!==PREDECESSOR_TABLES.length+PREDECESSOR_GUARDS.length)return 'unavailable';
 for(const [name,sql] of PREDECESSOR_TABLES)if(!prior.some(row=>row.type==='table'&&row.name===name&&row.tbl_name===name&&row.sql===sql))return 'unavailable';
 for(const name of PREDECESSOR_GUARDS)if(!prior.some(row=>row.type==='trigger'&&row.name===name))return 'unavailable';
 return 'predecessor';
}
export async function readDailyOwnerCursor(db:D1Database,sourceId:string,day:string):Promise<DailyOwnerCursor|null>{
 let value=await db.prepare(`SELECT cursor_id,next_owner_offset,revision FROM ${TABLE} WHERE source_id=? AND day=?`)
  .bind(sourceId,day).first<DailyOwnerCursor>();
 if(value===null){
  await db.prepare(`INSERT INTO ${TABLE}(source_id,day,next_owner_offset,revision)
   SELECT ?,?,0,1 WHERE ${DAILY_OWNER_CURSOR_CAPABILITY_SQL}
   ON CONFLICT(source_id,day) DO NOTHING`).bind(sourceId,day).run();
  value=await db.prepare(`SELECT cursor_id,next_owner_offset,revision FROM ${TABLE} WHERE source_id=? AND day=?`)
   .bind(sourceId,day).first<DailyOwnerCursor>();
 }
 if(value!==null&&!cursor(value))throw fail();
 return value;
}
/** One exact attempted-owner reservation, never a block or a completion. */
export async function advanceDailyOwnerCursor(db:D1Database,sourceId:string,day:string,
 before:DailyOwnerCursor,nextOffset:number):Promise<DailyOwnerCursor|null>{
 if(!cursor(before)||before.revision>=Number.MAX_SAFE_INTEGER||!integer(nextOffset))throw fail();
 const rows=(await db.prepare(`UPDATE ${TABLE} SET next_owner_offset=?,revision=revision+1
  WHERE source_id=? AND day=? AND cursor_id=? AND revision=? AND ${DAILY_OWNER_CURSOR_CAPABILITY_SQL}
  RETURNING cursor_id,next_owner_offset,revision`).bind(nextOffset,sourceId,day,before.cursor_id,before.revision)
  .all<DailyOwnerCursor>()).results;
 if(rows.length===0)return null;
 if(rows.length!==1||!cursor(rows[0]!)||rows[0]!.cursor_id!==before.cursor_id
  ||rows[0]!.revision!==before.revision+1||rows[0]!.next_owner_offset!==nextOffset)throw fail();
 return rows[0]!;
}
/** At most16 dispensable rows. Incarnations make concurrent recreation safe. */
export async function retireDailyOwnerCursorPage(db:D1Database,sourceId:string):Promise<number>{
 const mode=await dailyOwnerCursorMode(db);
 if(mode==='predecessor')return 0;
 if(mode!=='installed')throw fail();
 const rows=(await db.prepare(`DELETE FROM ${TABLE} WHERE cursor_id IN(
  SELECT c.cursor_id FROM ${TABLE} c WHERE c.source_id=?
   AND NOT EXISTS(SELECT 1 FROM analytics_community_daily_queue q WHERE q.source_id=c.source_id AND q.day=c.day)
   AND NOT EXISTS(SELECT 1 FROM analytics_community_daily_owners o WHERE o.source_id=c.source_id AND o.day=c.day AND o.complete=0)
  ORDER BY c.day LIMIT 16) AND ${DAILY_OWNER_CURSOR_CAPABILITY_SQL} RETURNING cursor_id`).bind(sourceId)
  .all<{cursor_id:number}>()).results;
 if(rows.length>16||rows.some(row=>!integer(row.cursor_id,1)))throw fail();
 return rows.length;
}
