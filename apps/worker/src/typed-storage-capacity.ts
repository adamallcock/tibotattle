import { STORAGE_OPERATING_BUDGET_BYTES } from './analytics-delivery';
import { MAX_TYPED_TELEMETRY_BATCH_BYTES } from './typed-telemetry-repository';
import { ApiError } from './errors';
import type { OwnerStorageRoute } from './storage-routing';

// Keep headroom for the bounded payload plus indexes, journal and authority
// effects. Physical expansion is not equal to serialized statement bytes.
export const TYPED_STORAGE_ADMISSION_HEADROOM_BYTES = 4 * MAX_TYPED_TELEMETRY_BATCH_BYTES;
export const TYPED_STORAGE_CAPACITY_SAMPLE_TTL_SECONDS = 30;
const CAPACITY_PROBE_SQL = 'SELECT 1 AS typed_admission_capacity_probe';
const RESERVATION_ROUNDING_BYTES = 64 * 1024;
const RESERVATION_FIXED_BYTES = 256 * 1024;
const RESERVATION_PER_RECORD_BYTES = 4 * 1024;
const MAX_TYPED_STORAGE_RESERVATION_BYTES = 64 * 1024 * 1024;

interface SampleClockRow { revision: number; sampled_at_epoch: number; reserved_total_bytes: number }
interface ReservationSequenceRow { sequence: number }
export interface TypedStorageAdmissionReservation {
 readonly reservationId: string;
 readonly reservedBytes: number;
 readonly statement: D1PreparedStatement;
}

function unavailable(): ApiError { return new ApiError(503, 'BACKEND_STORAGE_UNAVAILABLE'); }
function safeSize(result: D1Result): number {
 const size=result.meta.size_after;
 if(!result.success || !Number.isSafeInteger(size) || size<0 || size>STORAGE_OPERATING_BUDGET_BYTES) throw unavailable();
 return size;
}

/** Conservative operational estimate, not a claim about SQLite's exact page
 * growth. The multiplier covers duplicated typed layouts and indexes; fixed and
 * per-record allowances cover authority, journal, page splits and reservation
 * bookkeeping. */
export function estimateTypedStorageWriteBytes(transactionBytes:number,recordCount:number):number {
 if(!Number.isSafeInteger(transactionBytes)||transactionBytes<0||transactionBytes>MAX_TYPED_TELEMETRY_BATCH_BYTES
  ||!Number.isSafeInteger(recordCount)||recordCount<1||recordCount>200) throw unavailable();
 const raw=Math.max(RESERVATION_FIXED_BYTES,transactionBytes)*4
  +recordCount*RESERVATION_PER_RECORD_BYTES+RESERVATION_FIXED_BYTES;
 const rounded=Math.ceil(raw/RESERVATION_ROUNDING_BYTES)*RESERVATION_ROUNDING_BYTES;
 if(!Number.isSafeInteger(rounded)||rounded<1||rounded>MAX_TYPED_STORAGE_RESERVATION_BYTES) throw unavailable();
 return rounded;
}

function observationStatements(db:D1Database,input:{observedBytes:number;throughSequence:number;sampleRevision:number;
 sampledReservedTotalBytes:number;sampledAt:number;expiresAt:number}) {
 return [
  db.prepare(`INSERT INTO storage_write_capacity_observations
   (singleton_id,observed_bytes,sampled_through_sequence,sampled_reserved_total_bytes,sample_revision,sampled_at_epoch,expires_at_epoch)
   VALUES(1,?,?,?,?,?,?) ON CONFLICT(singleton_id) DO UPDATE SET
    observed_bytes=excluded.observed_bytes,
    sampled_through_sequence=excluded.sampled_through_sequence,
    sampled_reserved_total_bytes=excluded.sampled_reserved_total_bytes,
    sample_revision=excluded.sample_revision,
    sampled_at_epoch=excluded.sampled_at_epoch,
    expires_at_epoch=excluded.expires_at_epoch
   WHERE excluded.sample_revision>storage_write_capacity_observations.sample_revision`)
   .bind(input.observedBytes,input.throughSequence,input.sampledReservedTotalBytes,input.sampleRevision,input.sampledAt,input.expiresAt),
  db.prepare(`DELETE FROM storage_write_capacity_reservations WHERE sequence IN
   (SELECT sequence FROM storage_write_capacity_reservations WHERE sequence<=? ORDER BY sequence LIMIT 100)`)
   .bind(input.throughSequence),
 ];
}

/** Prepare one catalog-mode reservation for inclusion in the caller's existing
 * route-fenced final mutation batch. The size sample and reservation high-water
 * are read in one D1 batch; only reservations visible to that sample are then
 * reclaimed. */
export async function prepareTypedStorageAdmissionReservation(db:D1Database,route:OwnerStorageRoute,
 input:{transactionBytes:number;recordCount:number}):Promise<TypedStorageAdmissionReservation> {
 if(route.mode!=='catalog') throw unavailable();
 const reservedBytes=estimateTypedStorageWriteBytes(input.transactionBytes,input.recordCount);
 try {
  const sampled=await db.batch<unknown>([
   db.prepare(`UPDATE storage_write_capacity_sample_clock SET revision=revision+1 WHERE singleton_id=1
    RETURNING revision,reserved_total_bytes,CAST(strftime('%s','now') AS INTEGER) AS sampled_at_epoch`),
   db.prepare('SELECT COALESCE(max(sequence),0) AS sequence FROM storage_write_capacity_reservations'),
   db.prepare(CAPACITY_PROBE_SQL),
  ]);
  const clock=sampled[0]?.results[0] as SampleClockRow|undefined;
  const snapshot=sampled[1]?.results[0] as ReservationSequenceRow|undefined;
  const through=snapshot?.sequence,sampledAt=clock?.sampled_at_epoch,sampleRevision=clock?.revision;
  const sampledReservedTotalBytes=clock?.reserved_total_bytes;
  const observedBytes=safeSize(sampled[2] as D1Result);
  if(typeof through!=='number'||!Number.isSafeInteger(through)||through<0
   ||typeof sampledAt!=='number'||!Number.isSafeInteger(sampledAt)||sampledAt<0
   ||typeof sampleRevision!=='number'||!Number.isSafeInteger(sampleRevision)||sampleRevision<1
   ||typeof sampledReservedTotalBytes!=='number'||!Number.isSafeInteger(sampledReservedTotalBytes)||sampledReservedTotalBytes<0) throw unavailable();
  const expiresAt=sampledAt+TYPED_STORAGE_CAPACITY_SAMPLE_TTL_SECONDS;
  const reconciled=await db.batch(observationStatements(db,{observedBytes,throughSequence:through,sampleRevision,
   sampledReservedTotalBytes,sampledAt,expiresAt}));
  if(reconciled.some(result=>!result.success)) throw unavailable();
  if(observedBytes+reservedBytes>STORAGE_OPERATING_BUDGET_BYTES) throw unavailable();
  const reservationId=crypto.randomUUID();
  return Object.freeze({reservationId,reservedBytes,statement:db.prepare(`INSERT INTO storage_write_capacity_reservations
   (reservation_id,owner_id,shard_id,route_generation,reserved_bytes,created_at_epoch)
   VALUES(?,?,?,?,?,?) RETURNING sequence,reservation_id,reserved_bytes,
    CAST(strftime('%s','now') AS INTEGER) AS admitted_at_epoch,
    (SELECT revision FROM storage_write_capacity_sample_clock WHERE singleton_id=1) AS sample_revision,
    (SELECT reserved_total_bytes FROM storage_write_capacity_sample_clock WHERE singleton_id=1) AS reserved_total_bytes`)
   .bind(reservationId,route.ownerId,route.shardId,route.generation,reservedBytes,sampledAt)});
 } catch(error) {
  if(error instanceof ApiError) throw error;
  throw unavailable();
 }
}

/** Reclaim through this confirmed reservation using the final batch's observed
 * physical size. Missing/ambiguous evidence leaves the durable reservation for
 * a later fresh sample. Reconciliation failure never changes an accepted write. */
export async function reconcileTypedStorageAdmissionReservation(db:D1Database,reservation:TypedStorageAdmissionReservation,
 reservationResult:D1Result<unknown>|undefined,finalResult:D1Result|undefined):Promise<boolean> {
 try {
  const receipt=reservationResult?.results[0];
  if(!reservationResult?.success||!receipt||typeof receipt!=='object'
   ||!('reservation_id' in receipt)||receipt.reservation_id!==reservation.reservationId
   ||!('reserved_bytes' in receipt)||receipt.reserved_bytes!==reservation.reservedBytes
   ||!('sequence' in receipt)||typeof receipt.sequence!=='number'||!Number.isSafeInteger(receipt.sequence)||receipt.sequence<1
   ||!('admitted_at_epoch' in receipt)||typeof receipt.admitted_at_epoch!=='number'
   ||!Number.isSafeInteger(receipt.admitted_at_epoch)||receipt.admitted_at_epoch<0
   ||!('sample_revision' in receipt)||typeof receipt.sample_revision!=='number'
   ||!Number.isSafeInteger(receipt.sample_revision)||receipt.sample_revision<1
   ||!('reserved_total_bytes' in receipt)||typeof receipt.reserved_total_bytes!=='number'
   ||!Number.isSafeInteger(receipt.reserved_total_bytes)||receipt.reserved_total_bytes<reservation.reservedBytes) return false;
  const observedBytes=safeSize(finalResult as D1Result),sampledAt=receipt.admitted_at_epoch;
  const results=await db.batch(observationStatements(db,{observedBytes,throughSequence:receipt.sequence,
   sampleRevision:receipt.sample_revision,sampledReservedTotalBytes:receipt.reserved_total_bytes,
   sampledAt,expiresAt:sampledAt+TYPED_STORAGE_CAPACITY_SAMPLE_TTL_SECONDS}));
  return results.every(result=>result.success);
 } catch { return false; }
}

export function isTypedStorageCapacityRefusal(error:unknown):boolean {
 return String(error).includes('STORAGE_WRITE_CAPACITY_UNAVAILABLE');
}
/** Single-database compatibility guard for NEW chunks only, after exact replay
 * lookup. Catalog mode uses the durable reservation above. Reads, known replays
 * and erasure bypass both admission paths.
 */
export async function assertTypedStorageAdmissionCapacity(db:D1Database):Promise<void> {
 try {
  const result=await db.prepare(CAPACITY_PROBE_SQL).run();
  const size=result.meta.size_after;
  if(!result.success||!Number.isSafeInteger(size)||size<0
   ||size>STORAGE_OPERATING_BUDGET_BYTES-TYPED_STORAGE_ADMISSION_HEADROOM_BYTES)throw new Error('capacity');
 }catch{throw new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');}
}
