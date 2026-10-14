import { STORAGE_OPERATING_BUDGET_BYTES } from './analytics-delivery';
import { MAX_TYPED_TELEMETRY_BATCH_BYTES } from './typed-telemetry-repository';
import { ApiError } from './errors';

// Keep headroom for the bounded payload plus indexes, journal and authority
// effects. Physical expansion is not equal to serialized statement bytes.
export const TYPED_STORAGE_ADMISSION_HEADROOM_BYTES = 4 * MAX_TYPED_TELEMETRY_BATCH_BYTES;
/** Observed operating guard for NEW chunks only, after exact replay lookup.
 * This is not an atomic cross-request capacity reservation. The operator still
 * owns concurrent-writer headroom. Reads, known replays and erasure bypass it.
 */
export async function assertTypedStorageAdmissionCapacity(db:D1Database):Promise<void> {
 try {
  const result=await db.prepare('SELECT 1 AS typed_admission_capacity_probe').run();
  const size=result.meta.size_after;
  if(!result.success||!Number.isSafeInteger(size)||size<0
   ||size>STORAGE_OPERATING_BUDGET_BYTES-TYPED_STORAGE_ADMISSION_HEADROOM_BYTES)throw new Error('capacity');
 }catch{throw new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');}
}
