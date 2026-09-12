import { D1_PROVIDER_SCHEMA_PREDICATE } from './d1-provider-schema';
import { authorityRestoreRetainedTableNames } from './authority-restore';
import { bootstrapRestoredV1Chunk } from './authority-restore-adoption';
import { bootstrapV11StorageHead } from './v11-storage-journal';
import { bootstrapLegacyStorageOwner } from './legacy-storage-journal';
import { COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION } from './telemetry-v1-source-selection';

const fail=()=>new Error('AUTHORITY_RESTORE_BOOTSTRAP_UNQUALIFIED');
const q=(name:string)=>{if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))throw fail();return `"${name}"`;};
interface State {contract_digest:string;phase:'walking'|'complete';participant_cursor:string;chunk_cursor:string}
const stateSQL=`CREATE TABLE _authority_restore_bootstrap(id INTEGER PRIMARY KEY CHECK(id=1),contract_digest TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('walking','complete')),participant_cursor TEXT NOT NULL,chunk_cursor TEXT NOT NULL) STRICT`;
const guardSQL=(table:string,action:string)=>`CREATE TRIGGER ${q(`_authority_bootstrap_${table}_${action}`)} BEFORE ${action} ON ${q(table)} BEGIN SELECT RAISE(ABORT,'authority_restore_bootstrap_frozen'); END`;
async function guards(db:D1Database){
 const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_authority_*' ORDER BY name LIMIT 1025").all<{name:string}>()).results;
 if(tables.length>1024)throw fail();
 const retained=new Set(authorityRestoreRetainedTableNames());
 return tables.filter(x=>retained.has(x.name)||x.name.startsWith('typed_telemetry_')
  ||/^typed_v(1|11)_(admission_state|record_admissions|record_proofs|manifest_memberships|chunk_allocations|owner_memberships)$/.test(x.name)
  ||['telemetry_v1_records','telemetry_v11_records'].includes(x.name)).flatMap(x=>['INSERT','UPDATE','DELETE'].map(a=>({name:`_authority_bootstrap_${x.name}_${a}`,sql:guardSQL(x.name,a)})));
}
async function ready(db:D1Database,pin:string){
 if(!/^[a-f0-9]{64}$/.test(pin))throw fail();
 if(!await db.prepare("SELECT 1 FROM _authority_restore_run WHERE id=1 AND contract_digest=? AND phase='ready'").bind(pin).first())throw fail();
 // The exact final role is still the reviewed inventory. Temporary operator
 // guards have their own exact check below and never replace ordinary guards.
 if(await db.prepare(`SELECT 1 FROM _authority_restore_expected e LEFT JOIN sqlite_master s ON s.name=e.name
  WHERE s.type IS NOT e.type OR s.tbl_name IS NOT e.tbl_name OR s.sql IS NOT e.sql LIMIT 1`).first())throw fail();
 if(await db.prepare(`SELECT 1 FROM sqlite_master s WHERE s.sql IS NOT NULL AND s.name NOT GLOB 'sqlite_*'
  AND NOT (${D1_PROVIDER_SCHEMA_PREDICATE}) AND s.name NOT GLOB '_authority_*'
  AND NOT EXISTS(SELECT 1 FROM _authority_restore_expected e WHERE e.name=s.name) LIMIT 1`).first())throw fail();
}
async function exactGuards(db:D1Database,expected:Awaited<ReturnType<typeof guards>>){
 const actual=(await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB '_authority_bootstrap_*' ORDER BY name LIMIT 769").all<{name:string;sql:string}>()).results;
 if(actual.length!==expected.length||actual.some(x=>expected.find(y=>y.name===x.name)?.sql!==x.sql))throw fail();
}
/** Explicit unbound-target phase after role/data verification. Source mutations
 * are frozen for the entire cursor traversal; analytics may catch up separately.
 * No copied historical completed bit and no old rebuild queue is trusted. */
export async function initializeAuthorityRestoreBootstrap(db:D1Database,contractDigest:string):Promise<void>{
 await ready(db,contractDigest);const expected=await guards(db);if(expected.length>750)throw fail();
 if(await db.prepare("SELECT 1 FROM sqlite_master WHERE name='_authority_restore_bootstrap'").first()){
  const prior=await db.prepare('SELECT * FROM _authority_restore_bootstrap WHERE id=1').first<State>();
  if(!prior||prior.contract_digest!==contractDigest)throw fail();
  await exactGuards(db,prior.phase==='walking'?expected:[]);return;
 }
 await db.batch([db.prepare(stateSQL),
  db.prepare("CREATE TABLE _authority_restore_bootstrap_assert(id INTEGER CHECK(id=0)) STRICT"),
  db.prepare("INSERT INTO _authority_restore_bootstrap VALUES(1,?,'walking','','')").bind(contractDigest),
  ...expected.map(x=>db.prepare(x.sql)),
  db.prepare(`INSERT INTO community_public_source_bootstrap(singleton,policy_version,participant_cursor,source_day_cursor,completed)
   VALUES(1,?,'','',0) ON CONFLICT(singleton) DO UPDATE SET completed=0,participant_cursor='',source_day_cursor=''
   WHERE community_public_source_bootstrap.policy_version=excluded.policy_version`).bind(COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION),
  db.prepare('INSERT INTO _authority_restore_bootstrap_assert SELECT 1 WHERE changes()!=1'),
 ]);
 await exactGuards(db,expected);
}
/** One owner / at most eight current v1 chunks per invocation. Journal writes
 * use the existing exact header/typed-proof guards. Cursor CAS and idempotent
 * bootstrap events allow a lost acknowledgement to resume without duplication.
 * Complete means source discovery is done, NOT analytics or deployment ready. */
export async function bootstrapAuthorityRestorePage(db:D1Database,contractDigest:string):Promise<{completed:boolean;chunks:number;owners:number}>{
 await ready(db,contractDigest);
 const prior=await db.prepare('SELECT * FROM _authority_restore_bootstrap WHERE id=1').first<State>();
 if(!prior||prior.contract_digest!==contractDigest)throw fail();
 if(prior.phase==='complete'){
  await exactGuards(db,[]);
  if(!await db.prepare('SELECT 1 FROM community_public_source_bootstrap WHERE singleton=1 AND completed=1 AND policy_version=?')
    .bind(COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION).first())throw fail();
  return {completed:true,chunks:0,owners:0};
 }
 const expected=await guards(db);await exactGuards(db,expected);
 // participant_cursor is the owner currently being processed only when a
 // chunk cursor is present; otherwise it is the last completely visited owner.
 const owner=await db.prepare(`SELECT p.id,EXISTS(SELECT 1 FROM community_public_source_owners e WHERE e.participant_id=p.id) eligible,
  EXISTS(SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id=p.id) v11,
  EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
   AND c.transport_schema_version='telemetry-contribution-v0.2') legacy
  FROM participants p WHERE p.id ${prior.chunk_cursor?'=':'>'} ? ORDER BY p.id LIMIT 1`)
  .bind(prior.participant_cursor).first<{id:string;eligible:number;v11:number;legacy:number}>();
 const cas=`WHERE id=1 AND contract_digest=? AND phase='walking' AND participant_cursor=? AND chunk_cursor=?`;
 const args=[contractDigest,prior.participant_cursor,prior.chunk_cursor];
 if(!owner){
  if(prior.chunk_cursor)throw fail();
  await db.batch([
   db.prepare(`UPDATE _authority_restore_bootstrap SET phase='complete' ${cas}`).bind(...args),
   db.prepare('INSERT INTO _authority_restore_bootstrap_assert SELECT 1 WHERE changes()!=1'),
   db.prepare('UPDATE community_public_source_bootstrap SET completed=1 WHERE singleton=1 AND policy_version=? AND completed=0')
    .bind(COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION),
   db.prepare('INSERT INTO _authority_restore_bootstrap_assert SELECT 1 WHERE changes()!=1'),
   ...expected.map(x=>db.prepare(`DROP TRIGGER ${q(x.name)}`)),
  ]);return {completed:true,chunks:0,owners:0};
 }
 let chunkCursor='',chunks=0;
 if(owner.eligible){
  if(owner.v11){if(await bootstrapV11StorageHead(db,owner.id)!=='eligible-head')throw fail();}
  else {
   const page=(await db.prepare(`SELECT id FROM telemetry_v1_chunks WHERE participant_id=? AND superseded_at IS NULL
    AND accepted_record_count>0 AND id>? ORDER BY id LIMIT 9`).bind(owner.id,prior.chunk_cursor).all<{id:string}>()).results;
   for(const row of page.slice(0,8)){if(await bootstrapRestoredV1Chunk(db,contractDigest,row.id)!=='eligible-chunk')throw fail();chunks++;}
   if(page.length>8)chunkCursor=page[7]!.id;
  }
  if(!chunkCursor&&owner.legacy&&await bootstrapLegacyStorageOwner(db,owner.id)!=='eligible-legacy')throw fail();
 }
 await db.batch([db.prepare(`UPDATE _authority_restore_bootstrap SET participant_cursor=?,chunk_cursor=? ${cas}`).bind(owner.id,chunkCursor,...args),
  db.prepare('INSERT INTO _authority_restore_bootstrap_assert SELECT 1 WHERE changes()!=1')]);
 return {completed:false,chunks,owners:chunkCursor?0:1};
}
