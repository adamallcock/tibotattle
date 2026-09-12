import { applyAnalyticsChange, readIngestionChanges, type StorageChange } from './analytics-delivery';
import { lookupV11StorageSource, type V11StorageDiscard } from './v11-storage-journal';
import { lookupTypedV1Source, validateTypedTelemetryV1Receipt } from './typed-v1-admission';
import { readTypedTelemetryRowsByStorageIds } from './typed-telemetry-compatibility';
import { encodeTypedTelemetryId } from './typed-telemetry-codec';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { MAX_V1_SOURCE_CHUNKS, selectV1WinningDevices, type V1SourceChunk } from './telemetry-v1-source-selection';
import { createV11DailyProjectionValues, foldV1DailyProjectionValues, validateV11DailyProjectionValues,
 type V11DailyProjectionValues } from './v11-daily-projection-values';

const fail=()=>new Error('V1_PROJECTION_SOURCE_UNAVAILABLE');
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const scoped=(kind:string,value:unknown)=>sha256Hex(canonicalJson({method:'typed-v1-projection-v1',kind,value}));
function integer(n:number,min=0){if(!Number.isSafeInteger(n)||n<min)throw fail();}
function day(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)!==value)throw fail();}
type Input=Awaited<ReturnType<typeof lookupTypedV1Source>>;
async function references(owner:string,input:Pick<Input,'sourceNamespace'|'deviceId'|'day'|'stream'|'chunkSeq'|'chunkId'>){
 const [namespaceDigest,deviceDigest,slotDigest,chunkDigest]=await Promise.all([
  scoped('namespace',input.sourceNamespace),scoped('device',[input.sourceNamespace,owner,input.deviceId]),
  scoped('slot',[input.sourceNamespace,owner,input.deviceId,input.day,input.stream,input.chunkSeq]),
  scoped('chunk',[input.sourceNamespace,owner,input.chunkId]),
 ]);return {namespaceDigest,deviceDigest,slotDigest,chunkDigest};
}

/** Caller must obtain terminal from the protected source resolver. Safe to
 * commit before acknowledgement: a failed later delivery remains fenced.
 * Reversible withdrawal retains summaries; only erasure schedules deletion. */
export function prepareV1ProjectionOwnerFence(target:D1Database,change:StorageChange,terminal:V11StorageDiscard):D1PreparedStatement[]{
 if(terminal.disposition!=='discard'||terminal.sourceId!==change.sourceId||terminal.ownerDigest!==change.ownerDigest
  ||terminal.terminalRevision<change.revision||terminal.terminalSequence<change.sequence
  ||!['owner-withdrawn','owner-erased'].includes(terminal.reason)||!digest(change.ownerDigest))throw fail();
 integer(terminal.terminalRevision,1);integer(terminal.terminalSequence,1);
 return [target.prepare(`INSERT INTO analytics_v1_owner_fences(source_id,owner_digest,terminal_revision,terminal_sequence,state)
  VALUES(?,?,?,?,?) ON CONFLICT(source_id,owner_digest) DO UPDATE SET terminal_revision=excluded.terminal_revision,
   terminal_sequence=excluded.terminal_sequence,state=excluded.state
  WHERE excluded.terminal_revision>analytics_v1_owner_fences.terminal_revision`)
  .bind(change.sourceId,change.ownerDigest,terminal.terminalRevision,terminal.terminalSequence,terminal.reason)];
}

export async function retireV1DailyProjectionPage(target:D1Database,sourceId:string,limit=200):Promise<{state:'idle'|'retiring';deleted:number}>{
 integer(limit,1);if(limit>200)throw fail();
 const result=await target.prepare(`DELETE FROM analytics_v1_chunk_values WHERE (source_id,owner_digest,slot_digest) IN (
  SELECT c.source_id,c.owner_digest,c.slot_digest FROM analytics_v1_owner_fences f
  JOIN analytics_v1_chunk_values c ON c.source_id=f.source_id AND c.owner_digest=f.owner_digest
  WHERE f.source_id=? AND f.state='owner-erased' ORDER BY c.owner_digest,c.slot_digest LIMIT ?) RETURNING slot_digest`)
  .bind(sourceId,limit).all();
 return {state:result.results.length?'retiring':'idle',deleted:result.results.length};
}

/** Exactly one shared-cursor event, at most200 immutable source records. Ingest
 * does not call this function or synchronously write the analytics database. */
export async function advanceV1DailyProjection(options:{source:D1Database;target:D1Database;sourceId:string;sourceNamespace:string;signal?:AbortSignal}):Promise<{
 state:'idle'|'applied'|'discarded';sequence:number;recordsRead:number;
}>{
 const {source,target,sourceId,sourceNamespace,signal}=options;encodeTypedTelemetryId(sourceNamespace);signal?.throwIfAborted();
 const cursor=await target.prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(sourceId).first<number>('sequence');
 const sequence=cursor??0;integer(sequence);
 const change=(await readIngestionChanges(source,sourceId,sequence,1))[0];if(!change)return {state:'idle',sequence,recordsRead:0};
 if(change.sequence!==sequence+1)throw fail();
 const state=await source.prepare('SELECT state FROM storage_owner_revisions WHERE owner_digest=?').bind(change.ownerDigest).first<string>('state');
 if(change.kind==='owner-withdrawn'||change.kind==='owner-erased'||state==='withdrawn'||state==='erased'){
  const terminal=await lookupV11StorageSource(source,change);if(terminal.disposition!=='discard')throw fail();
  await applyAnalyticsChange(target,change,async()=>[
   ...prepareV1ProjectionOwnerFence(target,change,terminal),
   target.prepare(`INSERT INTO analytics_v1_projection_receipts(source_id,event_digest,owner_digest,disposition,proof_event_digest)
    VALUES(?,?,?,?,NULL)`).bind(sourceId,change.eventDigest,change.ownerDigest,terminal.reason),
  ]);return {state:'discarded',sequence:change.sequence,recordsRead:0};
 }
 const input=await lookupTypedV1Source(source,change);if(input.sourceNamespace!==sourceNamespace)throw fail();
 if(input.disposition==='superseded'){
  await applyAnalyticsChange(target,change,async()=>[target.prepare(`INSERT INTO analytics_v1_projection_receipts
   (source_id,event_digest,owner_digest,disposition,proof_event_digest) VALUES(?,?,?,'superseded',?)`)
   .bind(sourceId,change.eventDigest,change.ownerDigest,input.supersedingEventDigest)]);
  return {state:'discarded',sequence:change.sequence,recordsRead:0};
 }
 const receipt=await validateTypedTelemetryV1Receipt(source,{sourceNamespace,participantId:input.participantId,
  deviceId:input.deviceId,chunkRowId:input.chunkId});if(!receipt||receipt.superseded_at!==null)throw fail();
 const ids=(await source.prepare('SELECT typed_record_id FROM typed_v1_record_admissions WHERE chunk_id=? ORDER BY typed_record_id LIMIT 201')
  .bind(input.chunkId).all<{typed_record_id:number}>()).results.map(r=>r.typed_record_id);
 if(ids.length!==receipt.record_count||ids.length>200)throw fail();
 const rows=await readTypedTelemetryRowsByStorageIds(source,{sourceNamespace,participantId:input.participantId,storageRowIds:ids});
 if(rows.some(r=>r.format!=='v1'||r.device_id!==input.deviceId||r.chunk_row_id!==input.chunkId))throw fail();
 const records=rows.map(r=>JSON.parse(r.record_json));
 if(await sha256Hex(canonicalJson(records))!==input.chunkDigest)throw fail();
 const values=foldV1DailyProjectionValues(createV11DailyProjectionValues(input.day),records);
 const refs=await references(change.ownerDigest,input);signal?.throwIfAborted();
 // A correction may retire rows while the CPU fold runs. Recheck the exact
 // event, not a latest owner generation. A changed source retries safely.
 if(canonicalJson(await lookupTypedV1Source(source,change))!==canonicalJson(input))throw fail();
 await applyAnalyticsChange(target,change,async()=>[
  target.prepare(`INSERT INTO analytics_v1_chunk_values(source_id,owner_digest,slot_digest,namespace_digest,device_digest,
   chunk_digest,event_digest,content_digest,observed_day,chunk_revision,owner_revision,values_json)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,owner_digest,slot_digest) DO UPDATE SET
    chunk_digest=excluded.chunk_digest,event_digest=excluded.event_digest,content_digest=excluded.content_digest,
    chunk_revision=excluded.chunk_revision,owner_revision=excluded.owner_revision,values_json=excluded.values_json
   `)
   .bind(sourceId,change.ownerDigest,refs.slotDigest,refs.namespaceDigest,refs.deviceDigest,refs.chunkDigest,
    change.eventDigest,change.contentDigest,input.day,input.revision,change.revision,canonicalJson(values)),
  target.prepare(`INSERT INTO analytics_v1_projection_receipts(source_id,event_digest,owner_digest,disposition,proof_event_digest)
   VALUES(?,?,?,'chunk',NULL)`).bind(sourceId,change.eventDigest,change.ownerDigest),
 ]);
 return {state:'applied',sequence:change.sequence,recordsRead:rows.length};
}

interface Header extends V1SourceChunk {chunk_seq:number;record_count:number}
interface Scope {participant_id:string;revision:number;authority_epoch:number;source_id:string;source_namespace:string}
const scopeSql=`SELECT p.id participant_id,v.revision,s.authority_epoch,s.source_id,a.source_namespace
 FROM storage_v11_owner_links l JOIN participants p ON p.id=l.participant_id AND p.state='active'
 JOIN community_public_source_owners eligible ON eligible.participant_id=p.id AND eligible.owner_kind='social'
 JOIN community_analytical_input_versions v ON v.participant_id=p.id
 JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest AND o.state='active'
 CROSS JOIN storage_source_state s CROSS JOIN typed_v1_admission_state a
 WHERE l.owner_digest=? AND l.state='active' AND s.singleton=1 AND a.id=1 AND a.runtime_contract_version=1
 AND NOT EXISTS(SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id=p.id)`;

/** Internal bounded page. Callers merge disjoint pages only with one unchanged
 * fingerprint, then keep the ordinary public suppression/completion gates.
 * An active v1.1 head blocks this lane even while its projection is catching up. */
export async function readV1ProjectedChunkPage(options:{source:D1Database;target:D1Database;sourceId:string;sourceNamespace:string;
 ownerDigest:string;day:string;afterIndex?:number;limit?:number;fingerprint?:string}):Promise<{
 fingerprint:string;values:V11DailyProjectionValues[];nextIndex:number|null;totalChunks:number;authorityEpoch:number;
}|null>{
 const {source,target,sourceId,sourceNamespace,ownerDigest,day:observedDay}=options;
 const requestedFingerprint=options.fingerprint;
 const after=options.afterIndex??0,limit=options.limit??50;integer(after);integer(limit,1);day(observedDay);
 if(!digest(ownerDigest)||limit>50||after>MAX_V1_SOURCE_CHUNKS||(after>0&&!digest(requestedFingerprint)))throw fail();
 const [scopeResult,headerResult]=await source.batch<Scope|Header>([
  source.prepare(scopeSql).bind(ownerDigest),
  source.prepare(`SELECT c.* FROM telemetry_v1_chunks c JOIN storage_v11_owner_links l ON l.participant_id=c.participant_id
   WHERE l.owner_digest=? AND c.chunk_day=? AND c.superseded_at IS NULL AND c.accepted_record_count>0
   ORDER BY c.id LIMIT ?`).bind(ownerDigest,observedDay,MAX_V1_SOURCE_CHUNKS+1),
 ]);
 const scope=scopeResult!.results[0] as Scope|undefined;if(!scope)return null;
 if(scope.source_id!==sourceId||scope.source_namespace!==sourceNamespace)throw fail();
 const headers=headerResult!.results as Header[];if(headers.length>MAX_V1_SOURCE_CHUNKS)throw fail();
 const winner=selectV1WinningDevices(headers)[0];const selected=headers.filter(h=>h.device_id===winner?.device_id);
 if(after>selected.length)throw fail();
 const fingerprint=await scoped('page',[sourceId,sourceNamespace,ownerDigest,observedDay,scope.revision,scope.authority_epoch,selected]);
 if(requestedFingerprint&&requestedFingerprint!==fingerprint)throw fail();
 const page=selected.slice(after,after+limit),refs=await Promise.all(page.map(h=>references(ownerDigest,{sourceNamespace,
  deviceId:h.device_id,day:h.chunk_day,stream:h.stream,chunkSeq:h.chunk_seq,chunkId:h.id})));
 const projected=await target.prepare(`SELECT c.authority_epoch FROM analytics_source_cursors c JOIN analytics_owner_state o
  ON o.source_id=c.source_id AND o.owner_digest=? AND o.state='active'
  WHERE c.source_id=? AND NOT EXISTS(SELECT 1 FROM analytics_v1_owner_fences f WHERE f.source_id=o.source_id
   AND f.owner_digest=o.owner_digest AND (f.state='owner-erased' OR f.terminal_revision>=o.revision))`)
  .bind(ownerDigest,sourceId).first<number>('authority_epoch');
 if(projected!==scope.authority_epoch)return null;
 const summaries=refs.length?(await target.prepare(`SELECT * FROM analytics_v1_chunk_values
  WHERE source_id=? AND owner_digest=? AND slot_digest IN (${refs.map(()=>'?').join(',')})`)
  .bind(sourceId,ownerDigest,...refs.map(r=>r.slotDigest)).all<{slot_digest:string;chunk_digest:string;namespace_digest:string;
   device_digest:string;content_digest:string;chunk_revision:number;values_json:string}>()).results:[];
 const values:V11DailyProjectionValues[]=[];
 for(let i=0;i<page.length;i++){
  const h=page[i]!,ref=refs[i]!,row=summaries.find(r=>r.slot_digest===ref.slotDigest);if(!row)return null;
  if(row.chunk_digest!==ref.chunkDigest||row.namespace_digest!==ref.namespaceDigest||row.device_digest!==ref.deviceDigest
   ||row.content_digest!==h.chunk_digest||row.chunk_revision!==h.revision)throw fail();
  const value:unknown=JSON.parse(row.values_json);validateV11DailyProjectionValues(value);
  if(value.day!==observedDay||value.counts.usage+value.counts.quota+value.counts.session!==h.record_count)throw fail();
  values.push(value);
 }
 // Final authoritative source read is the serving linearization point. The
 // previously observed target epoch and immutable header vector must still fit.
 const final=await source.prepare(scopeSql).bind(ownerDigest).first<Scope>();
 if(!final||canonicalJson(final)!==canonicalJson(scope))return null;
 return {fingerprint,values,nextIndex:after+page.length<selected.length?after+page.length:null,
  totalChunks:selected.length,authorityEpoch:scope.authority_epoch};
}
