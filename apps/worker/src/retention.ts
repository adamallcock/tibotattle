import {prepareStorageParticipantErasure,requireStorageParticipantErasureComplete,advanceStorageErasureJobs,type StorageErasureBindings} from './storage-erasure';
import {advanceMultiSourceStorageErasureJobs,prepareMultiSourceParticipantErasure,
  storageErasureTargetForRouteTarget,type StorageErasureTarget} from './storage-multi-source-erasure';
import {storageForParticipantDeletionDigest,storageTargetsForOwnerRoute} from './storage-routing-runtime';
import { participantDeletionDigest } from "./participant-deletion-digest";
export { participantDeletionDigest } from "./participant-deletion-digest";
import { revokeAccountlessEnrollment } from "./accountless-enrollment";
import { ApiError } from "./errors";
import { finishParticipantDeletion } from "./repository";
import { telemetryV1ChunkR2KeyPage } from "./telemetry-v1-repository";
import { telemetryV11ChunkR2KeyPage } from "./telemetry-v11-repository";
import { QUARANTINE_RETENTION_MILLISECONDS } from "./constants";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
export const DELETION_TOMBSTONE_RETENTION_MILLISECONDS = 400 * DAY_MILLISECONDS;
/**
 * A deleted hosted identity may not immediately mint a fresh participant.
 * This is intentionally a short, fixed anti-reissue window rather than a
 * durable identity record; the ledger retains only a purpose-separated HMAC
 * digest and scheduled maintenance removes it after thirty days.
 */
export const IDENTITY_REENROLLMENT_COOLDOWN_MILLISECONDS = 30 * DAY_MILLISECONDS;

const SCAN_PAGE_SIZE = 1_000;
const QUARANTINE_DELETE_BATCH_SIZE = 100;
const DELETION_TOMBSTONE_DELETE_BATCH_SIZE = 100;
const IDENTITY_REENROLLMENT_COOLDOWN_DELETE_BATCH_SIZE = 100;
const MAX_RESTORE_SUPPRESSIONS_PER_PASS = 100;
const MAX_LIFECYCLE_ROWS = 100_000;
export const CATALOG_DELETION_REPLAY_PAGE_SIZE = 8;
const IDENTITY_REENROLLMENT_COOLDOWN_DOMAIN =
  "app-usagemonitor/identity-reenrollment-cooldown/v1\0";

interface TombstoneRow {
  participant_digest: string;
  retain_until?: string;
}

interface ParticipantRow {
  id: string;
}

interface QuarantineObjectRow {
  source: "synthetic" | "telemetry" | "telemetry_v1" | "telemetry_v11";
  id: string;
  r2_key: string;
}

const QUARANTINE_SOURCE_TABLES: Record<
  QuarantineObjectRow["source"],
  string
> = {
  synthetic: "contributions",
  telemetry: "telemetry_contributions",
  telemetry_v1: "telemetry_v1_chunks",
  telemetry_v11: "telemetry_v11_chunks",
};

export interface LifecyclePassResult {
  /** `null` while quarantine retention is disabled: no pass has a cutoff. */
  quarantineCutoffAt: string | null;
  quarantineObjectsDeleted: number;
  quarantineRetentionComplete: boolean;
  restoredParticipantsSuppressed: number;
  restoreReplayComplete: boolean;
}

export interface ExpiredLedgerPurgeResult {
  purged: number;
  complete: boolean;
}

type LifecyclePhaseGuard = () => Promise<boolean>;
type CatalogReplayGuard = () => Promise<boolean | void>;

function canonicalInstant(epoch: number): string {
  return new Date(epoch).toISOString();
}

function assertIdentityLinkKey(identityLinkKey: string): void {
  if (!/^[0-9a-f]{64}$/u.test(identityLinkKey)) {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
}

async function deriveIdentityReenrollmentCooldownDigest(
  identityLinkSecret: string,
  identityLinkKey: string,
): Promise<string> {
  if (identityLinkSecret.length < 32) {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  assertIdentityLinkKey(identityLinkKey);
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(identityLinkSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    new TextEncoder().encode(
      `${IDENTITY_REENROLLMENT_COOLDOWN_DOMAIN}${identityLinkKey}`,
    ),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function identityLinkSecret(value: unknown): string {
  if (typeof value !== "string" || value.length < 32) {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  return value;
}



/**
 * Derives the short-lived anti-reissue marker from the already pseudonymous
 * identity-link key. The provider subject and the link key never leave the
 * Worker process or get written to the deletion ledger.
 */
export async function identityReenrollmentCooldownDigest(
  identityLinkSecret: string,
  identityLinkKey: string,
): Promise<string> {
  return deriveIdentityReenrollmentCooldownDigest(
    identityLinkSecret,
    identityLinkKey,
  );
}

export async function recordDeletionTombstone(
  ledger: D1Database,
  participantId: string,
  nowEpoch = Date.now(),
): Promise<void> {
  const participantDigest = await participantDeletionDigest(participantId);
  const deletedAt = canonicalInstant(nowEpoch);
  const retainUntil = canonicalInstant(
    nowEpoch + DELETION_TOMBSTONE_RETENTION_MILLISECONDS,
  );
  await ledger.prepare(
    `INSERT INTO deletion_tombstones (
      participant_digest, schema_version, deleted_at, retain_until
    ) VALUES (?, 'participant-deletion-tombstone-v0.1', ?, ?)
    ON CONFLICT(participant_digest) DO UPDATE SET
      retain_until = CASE
        WHEN excluded.retain_until > deletion_tombstones.retain_until
          THEN excluded.retain_until
        ELSE deletion_tombstones.retain_until
      END`,
  ).bind(participantDigest, deletedAt, retainUntil).run();
  const row = await ledger.prepare(
    `SELECT participant_digest, retain_until
       FROM deletion_tombstones
      WHERE participant_digest = ?`,
  ).bind(participantDigest).first<TombstoneRow>();
  if (row?.participant_digest !== participantDigest
      || typeof row.retain_until !== "string"
      || row.retain_until < retainUntil) {
    throw new ApiError(503, "DELETION_LEDGER_UNAVAILABLE");
  }
}

export async function hasDeletionTombstone(
  ledger: D1Database,
  participantId: string,
  nowEpoch = Date.now(),
): Promise<boolean> {
  const participantDigest = await participantDeletionDigest(participantId);
  const row = await ledger.prepare(
    `SELECT 1 AS present,retain_until FROM deletion_tombstones WHERE participant_digest=?`,
  ).bind(participantDigest).first<{present:number;retain_until:string}>();
  if(!row)return false;
  if(row.retain_until>canonicalInstant(nowEpoch))return true;
  // Pending cross-store cleanup retains the original deletion authority even
  // after its usual retention date; it cannot permit a restored enrollment.
  if(!await ledger.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='storage_erasure_jobs'").first())return false;
  return !!await ledger.prepare("SELECT 1 FROM storage_erasure_jobs WHERE participant_digest=? AND state='pending' LIMIT 1")
    .bind(participantDigest).first();
}

export async function recordIdentityReenrollmentCooldown(
  ledger: D1Database,
  identityLinkKey: string,
  rawIdentityLinkSecret: unknown,
  nowEpoch = Date.now(),
): Promise<void> {
  const secret = identityLinkSecret(rawIdentityLinkSecret);
  const cooldownDigest = await deriveIdentityReenrollmentCooldownDigest(
    secret,
    identityLinkKey,
  );
  await recordIdentityReenrollmentCooldownFromDigest(
    ledger,
    cooldownDigest,
    nowEpoch,
  );
}

function assertIdentityReenrollmentCooldownDigest(
  identityCooldownDigest: string,
): void {
  if (!/^[0-9a-f]{64}$/u.test(identityCooldownDigest)) {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
}

async function recordIdentityReenrollmentCooldownAt(
  database: D1Database,
  identityCooldownDigest: string,
  unavailableCode: "BACKEND_STORAGE_UNAVAILABLE" | "DELETION_LEDGER_UNAVAILABLE",
  nowEpoch: number,
): Promise<void> {
  assertIdentityReenrollmentCooldownDigest(identityCooldownDigest);
  const deletedAt = canonicalInstant(nowEpoch);
  const retainUntil = canonicalInstant(
    nowEpoch + IDENTITY_REENROLLMENT_COOLDOWN_MILLISECONDS,
  );
  await database.prepare(
    `INSERT INTO identity_reenrollment_cooldowns (
      identity_cooldown_digest, schema_version, deleted_at, retain_until
    ) VALUES (?, 'identity-reenrollment-cooldown-v0.1', ?, ?)
    ON CONFLICT(identity_cooldown_digest) DO UPDATE SET
      retain_until = CASE
        WHEN excluded.retain_until > identity_reenrollment_cooldowns.retain_until
          THEN excluded.retain_until
        ELSE identity_reenrollment_cooldowns.retain_until
      END`,
  ).bind(identityCooldownDigest, deletedAt, retainUntil).run();
  const row = await database.prepare(
    `SELECT identity_cooldown_digest, retain_until
       FROM identity_reenrollment_cooldowns
      WHERE identity_cooldown_digest = ?`,
  ).bind(identityCooldownDigest).first<{
    identity_cooldown_digest: string;
    retain_until: string;
  }>();
  if (row?.identity_cooldown_digest !== identityCooldownDigest
      || typeof row.retain_until !== "string"
      || row.retain_until < retainUntil) {
    throw new ApiError(503, unavailableCode);
  }
}

/** Writes a primary-D1 marker before a hosted identity-link row is removed. */
export function recordPrimaryIdentityReenrollmentCooldown(
  db: D1Database,
  identityCooldownDigest: string,
  nowEpoch = Date.now(),
): Promise<void> {
  return recordIdentityReenrollmentCooldownAt(
    db,
    identityCooldownDigest,
    "BACKEND_STORAGE_UNAVAILABLE",
    nowEpoch,
  );
}

/** Writes the independent-ledger copy from an already derived digest. */
export function recordIdentityReenrollmentCooldownFromDigest(
  ledger: D1Database,
  identityCooldownDigest: string,
  nowEpoch = Date.now(),
): Promise<void> {
  return recordIdentityReenrollmentCooldownAt(
    ledger,
    identityCooldownDigest,
    "DELETION_LEDGER_UNAVAILABLE",
    nowEpoch,
  );
}

/** Reads a cooldown marker from either the primary D1 database or ledger. */
export async function hasIdentityReenrollmentCooldownDigest(
  database: D1Database,
  identityCooldownDigest: string,
  nowEpoch = Date.now(),
): Promise<boolean> {
  assertIdentityReenrollmentCooldownDigest(identityCooldownDigest);
  const row = await database.prepare(
    `SELECT 1 AS present
       FROM identity_reenrollment_cooldowns
      WHERE identity_cooldown_digest = ?
        AND retain_until > ?`,
  ).bind(identityCooldownDigest, canonicalInstant(nowEpoch)).first<{ present: number }>();
  return row?.present === 1;
}

export async function hasIdentityReenrollmentCooldown(
  ledger: D1Database,
  identityLinkKey: string,
  rawIdentityLinkSecret: unknown,
  nowEpoch = Date.now(),
): Promise<boolean> {
  const secret = identityLinkSecret(rawIdentityLinkSecret);
  const cooldownDigest = await deriveIdentityReenrollmentCooldownDigest(
    secret,
    identityLinkKey,
  );
  return hasIdentityReenrollmentCooldownDigest(ledger, cooldownDigest, nowEpoch);
}

async function purgeExpiredLedgerRows(
  ledger: D1Database,
  table: "deletion_tombstones" | "identity_reenrollment_cooldowns",
  digestColumn: "participant_digest" | "identity_cooldown_digest",
  nowEpoch: number,
  batchSize: number,
): Promise<ExpiredLedgerPurgeResult> {
  const now = canonicalInstant(nowEpoch);
  const storageJobs=table==='deletion_tombstones'&&!!await ledger.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='storage_erasure_jobs'").first();
  const storageTargets=storageJobs&&table==='deletion_tombstones'
    &&!!await ledger.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='storage_erasure_targets'").first();
  const pendingGuard=storageJobs?` AND NOT EXISTS(SELECT 1 FROM storage_erasure_jobs j
    WHERE j.participant_digest=deletion_tombstones.participant_digest AND j.state='pending')${storageTargets?`
    AND NOT EXISTS(SELECT 1 FROM storage_erasure_targets t
    WHERE t.participant_digest=deletion_tombstones.participant_digest AND t.state='pending')`:''}`:"";
  const due = await ledger.prepare(
    `SELECT ${digestColumn}
       FROM ${table}
      WHERE retain_until <= ?${pendingGuard}
      ORDER BY retain_until, ${digestColumn}
      LIMIT ?`,
  ).bind(now, batchSize + 1).all<Record<typeof digestColumn, string>>();
  if (due.results.length === 0) return { purged: 0, complete: true };
  const deletion = await ledger.prepare(
    `DELETE FROM ${table}
      WHERE ${digestColumn} IN (
        SELECT ${digestColumn}
          FROM ${table}
         WHERE retain_until <= ?${pendingGuard}
         ORDER BY retain_until, ${digestColumn}
         LIMIT ?
      ) RETURNING ${digestColumn}`,
  ).bind(now, batchSize).all<Record<typeof digestColumn,string>>();
  // Count tombstones, not FK-cascaded completed retry recipes.
  const purged = deletion.results.length;
  if (purged < 0 || purged > batchSize) {
    throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
  }
  return {
    purged,
    complete: due.results.length <= batchSize,
  };
}

/** Removes at most one bounded page of expired deletion tombstones. */
export function purgeExpiredDeletionTombstones(
  ledger: D1Database,
  nowEpoch = Date.now(),
): Promise<ExpiredLedgerPurgeResult> {
  return purgeExpiredLedgerRows(
    ledger,
    "deletion_tombstones",
    "participant_digest",
    nowEpoch,
    DELETION_TOMBSTONE_DELETE_BATCH_SIZE,
  );
}

/** Removes at most one bounded page of expired identity cooldown markers. */
export function purgeExpiredIdentityReenrollmentCooldowns(
  ledger: D1Database,
  nowEpoch = Date.now(),
): Promise<ExpiredLedgerPurgeResult> {
  return purgeExpiredLedgerRows(
    ledger,
    "identity_reenrollment_cooldowns",
    "identity_cooldown_digest",
    nowEpoch,
    IDENTITY_REENROLLMENT_COOLDOWN_DELETE_BATCH_SIZE,
  );
}

/** Removes at most one bounded page of expired primary-D1 cooldown markers. */
export function purgeExpiredPrimaryIdentityReenrollmentCooldowns(
  db: D1Database,
  nowEpoch = Date.now(),
): Promise<ExpiredLedgerPurgeResult> {
  return purgeExpiredLedgerRows(
    db,
    "identity_reenrollment_cooldowns",
    "identity_cooldown_digest",
    nowEpoch,
    IDENTITY_REENROLLMENT_COOLDOWN_DELETE_BATCH_SIZE,
  );
}

async function deletionDigests(
  ledger: D1Database,
  nowEpoch: number,
): Promise<Set<string>> {
  const digests = new Set<string>();
  const jobs=!!await ledger.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='storage_erasure_jobs'").first();
  const targets=jobs&&!!await ledger.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='storage_erasure_targets'").first();
  const pending=jobs?` OR EXISTS(SELECT 1 FROM storage_erasure_jobs j
    WHERE j.participant_digest=deletion_tombstones.participant_digest AND j.state='pending')${targets?`
    OR EXISTS(SELECT 1 FROM storage_erasure_targets t
    WHERE t.participant_digest=deletion_tombstones.participant_digest AND t.state='pending')`:''}`:"";
  let cursor = "";
  while (digests.size <= MAX_LIFECYCLE_ROWS) {
    const page = await ledger.prepare(
      `SELECT participant_digest
         FROM deletion_tombstones
        WHERE participant_digest > ?
          AND (retain_until > ?${pending})
        ORDER BY participant_digest
        LIMIT ?`,
    ).bind(cursor, canonicalInstant(nowEpoch), SCAN_PAGE_SIZE).all<TombstoneRow>();
    if (page.results.length === 0) return digests;
    for (const row of page.results) {
      digests.add(row.participant_digest);
      if (digests.size > MAX_LIFECYCLE_ROWS) {
        throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
      }
      cursor = row.participant_digest;
    }
    if (page.results.length < SCAN_PAGE_SIZE) return digests;
  }
  throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
}

async function participantQuarantineKeys(
  db: D1Database,
  participantId: string,
): Promise<string[]> {
  const result = await db.prepare(
    `SELECT r2_key FROM contributions WHERE participant_id = ?
     UNION ALL
     SELECT r2_key FROM telemetry_contributions WHERE participant_id = ?
     LIMIT 202`,
  ).bind(participantId, participantId).all<{ r2_key: string }>();
  if (result.results.length > 201) {
    throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  return result.results.map((row) => row.r2_key);
}

async function suppressRestoredParticipant(
  db: D1Database,
  ledger: D1Database,
  quarantine: R2Bucket,
  participantId: string,
  rawIdentityLinkSecret?: unknown,
  allowMissingIdentityLinkSecret = false,
  storage?: StorageErasureBindings,
  requireStorageCompletion = true,
): Promise<boolean> {
  // Social restore replay retains its historical NULL fence. Accountless
  // owner shape requires a non-NULL deleting fence; reserve a deterministic,
  // digest-only namespace distinct from every UUID owner-erasure operation.
  // The caller already matched this exact owner against the independent ledger.
  const participantState=await db.prepare('SELECT owner_kind,state,deletion_session_id FROM participants WHERE id=?')
    .bind(participantId).first<{owner_kind:string;state:string;deletion_session_id:string|null}>();
  if(!participantState)return false;
  const restoreFence=participantState.owner_kind==='accountless'
    ? `restore-replay:${await participantDeletionDigest(participantId)}` : null;
  if(participantState.state!=='active'
    && !(participantState.state==='deleting'&&participantState.deletion_session_id===restoreFence))return false;
  // Revocation is idempotent and must precede the accountless state transition.
  // An existing different restore/owner fence was refused before any revocation.
  if(participantState.owner_kind==='accountless'){
    const owner=await db.prepare("SELECT enrollment_device_id FROM accountless_upload_owners WHERE participant_id=? AND state='active'")
      .bind(participantId).first<{enrollment_device_id:string}>();
    if(owner)await revokeAccountlessEnrollment(db,owner.enrollment_device_id,"security_reset");
  }
  const claimed = await db.prepare(
    `UPDATE participants
        SET state = 'deleting', deletion_session_id = ?
      WHERE id = ?
        AND (state = 'active'
          OR (state = 'deleting' AND deletion_session_id IS ?))
      RETURNING id`,
  ).bind(restoreFence,participantId,restoreFence).first<{ id: string }>();
  if (claimed === null) return false;
  if(storage)await prepareStorageParticipantErasure(storage,participantId);
  const keys = await participantQuarantineKeys(db, participantId);
  if (keys.length > 0) await quarantine.delete(keys);
  // v1.0 chunk journals can far exceed the bounded v0.1 key scan above, so
  // their quarantine objects purge through a dedicated page loop.
  let chunkCursor: { createdAt: string; chunkRowId: string } | null = null;
  let chunkPages = 0;
  do {
    const page = await telemetryV1ChunkR2KeyPage(db, participantId, chunkCursor);
    if (page.rows.length > 0) {
      await quarantine.delete(page.rows.map((row) => row.r2Key));
    }
    chunkCursor = page.nextCursor;
    chunkPages += 1;
    if (chunkPages > MAX_LIFECYCLE_ROWS / 100) {
      throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
    }
  } while (chunkCursor);
  let stagedCursor: { createdAt: string; chunkRowId: string } | null = null;
  do {
    const page = await telemetryV11ChunkR2KeyPage(db, participantId, stagedCursor);
    if (page.rows.length > 0) await quarantine.delete(page.rows.map((row) => row.r2Key));
    stagedCursor = page.nextCursor;
    chunkPages += 1;
    if (chunkPages > MAX_LIFECYCLE_ROWS / 100) throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
  } while (stagedCursor);
  const participant = await db.prepare(
    `SELECT identity_link_key
       FROM participants
      WHERE id = ? AND state = 'deleting'`,
  ).bind(participantId).first<{ identity_link_key: string | null }>();
  if (participant?.identity_link_key !== null
      && participant?.identity_link_key !== undefined) {
    if (!(allowMissingIdentityLinkSecret
      && (typeof rawIdentityLinkSecret !== "string"
        || rawIdentityLinkSecret.length < 32))) {
      const cooldownDigest = await identityReenrollmentCooldownDigest(
        identityLinkSecret(rawIdentityLinkSecret),
        participant.identity_link_key,
      );
      // The primary marker commits while the old unique identity-link row is
      // still present. Together with the INSERT trigger this leaves no window
      // in which deletion can remove the row and then admit a replacement.
      await recordPrimaryIdentityReenrollmentCooldown(db, cooldownDigest);
      await recordIdentityReenrollmentCooldownFromDigest(ledger, cooldownDigest);
    }
  }
  await finishParticipantDeletion(db, participantId, restoreFence);
  if(requireStorageCompletion){
    await requireStorageParticipantErasureComplete(ledger,participantId,storage??null);
  }
  return true;
}

async function restoredParticipantForOwner(
  source:D1Database,ownerId:string,
):Promise<string|null>{
  const rows=(await source.prepare(`SELECT owner.participant_id
    FROM accountless_enrollment_ledger ledger
    JOIN accountless_upload_owners owner ON owner.enrollment_device_id=ledger.device_id
    JOIN participants participant ON participant.id=owner.participant_id
    WHERE ledger.installation_principal_id=?
    ORDER BY owner.participant_id LIMIT 2`).bind(ownerId)
    .all<{participant_id:string}>()).results;
  if(rows.length>1)throw new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');
  return rows[0]?.participant_id??null;
}

/** Catalog restore replay follows only the immutable deletion locator and that
 * owner's bounded route history. Each physical source resolves the raw id from
 * its indexed, shard-local owner graph and verifies the tombstone digest before
 * deletion. A failed source/analytics target stays pending for a later pass. */
export async function replayCatalogDeletionTombstones(
  env:Env,
  nowEpoch=Date.now(),
  rawIdentityLinkSecret?:unknown,
  allowMissingIdentityLinkSecret=true,
  beforeReplayUnit?:CatalogReplayGuard,
):Promise<{suppressed:number;complete:boolean}>{
  type CursorState={after_participant_digest:string;cycle_incomplete:number;
    verification_required:number;updated_at:number};
  const ledger=env.DELETION_LEDGER;
  const state=await ledger.prepare(`SELECT after_participant_digest,cycle_incomplete,
    verification_required,updated_at FROM storage_catalog_deletion_replay_state WHERE singleton_id=1`)
    .first<CursorState>();
  if(!state||![state.cycle_incomplete,state.verification_required].every(value=>value===0||value===1)
    ||(state.after_participant_digest!==''&&!/^[a-f0-9]{64}$/.test(state.after_participant_digest))){
    throw new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');
  }
  const assertReplayOwnership=async()=>{
    if(beforeReplayUnit&&(await beforeReplayUnit())===false){
      throw new ApiError(503,'LIFECYCLE_STATE_CONFLICT');
    }
  };
  const active=`(retain_until>? OR EXISTS(SELECT 1 FROM storage_erasure_jobs job
    WHERE job.participant_digest=deletion_tombstones.participant_digest AND job.state='pending')
    OR EXISTS(SELECT 1 FROM storage_erasure_targets target
    WHERE target.participant_digest=deletion_tombstones.participant_digest AND target.state='pending'))`;
  const page=(await ledger.prepare(`SELECT participant_digest FROM deletion_tombstones
    WHERE participant_digest>? AND ${active} ORDER BY participant_digest LIMIT ?`)
    .bind(state.after_participant_digest,canonicalInstant(nowEpoch),CATALOG_DELETION_REPLAY_PAGE_SIZE+1)
    .all<TombstoneRow>()).results;
  const updateCursor=async(expected:CursorState,next:Omit<CursorState,'updated_at'>):Promise<CursorState>=>{
    await assertReplayOwnership();
    const updated=await ledger.prepare(`UPDATE storage_catalog_deletion_replay_state
      SET after_participant_digest=?,cycle_incomplete=?,verification_required=?,updated_at=?
      WHERE singleton_id=1 AND after_participant_digest=? AND cycle_incomplete=?
        AND verification_required=? AND updated_at=?
      RETURNING after_participant_digest,cycle_incomplete,verification_required,updated_at`)
      .bind(next.after_participant_digest,next.cycle_incomplete,next.verification_required,nowEpoch,
        expected.after_participant_digest,expected.cycle_incomplete,expected.verification_required,expected.updated_at)
      .first<CursorState>();
    if(!updated)throw new ApiError(503,'LIFECYCLE_STATE_CONFLICT');
    return updated;
  };
  if(page.length===0){
    if(state.after_participant_digest===''){
      if(state.cycle_incomplete===0&&state.verification_required===0){
        return {suppressed:0,complete:true};
      }
      await updateCursor(state,{after_participant_digest:'',cycle_incomplete:0,verification_required:0});
      return {suppressed:0,complete:true};
    }
    const incomplete=state.cycle_incomplete===1;
    await updateCursor(state,{after_participant_digest:'',cycle_incomplete:0,
      verification_required:incomplete?1:0});
    return {suppressed:0,complete:!incomplete};
  }
  const digests=page.slice(0,CATALOG_DELETION_REPLAY_PAGE_SIZE);
  let suppressed=0,cursor=state,cycleIncomplete=state.cycle_incomplete===1;
  for(let index=0;index<digests.length;index++){
    const participantDigest=digests[index]!.participant_digest;
    await assertReplayOwnership();
    let unitIncomplete=false;
    // Absence is an activation/backfill failure. Never scan shards to recover it.
    const located=await storageForParticipantDeletionDigest(env,participantDigest);
    const routeTargets=await storageTargetsForOwnerRoute(env,located.route);
    if(routeTargets.length>8)throw new ApiError(503,'LIFECYCLE_BOUNDS_EXCEEDED');
    const availableTargets:StorageErasureTarget[]=[];
    let ownerSuppressed=false;
    for(const routeTarget of routeTargets){
      await assertReplayOwnership();
      try{
        const erasureTarget=await storageErasureTargetForRouteTarget(env,routeTarget);
        availableTargets.push(erasureTarget);
        const participantId=await restoredParticipantForOwner(routeTarget.database,located.route.ownerId);
        if(participantId===null)continue;
        if(await participantDeletionDigest(participantId)!==participantDigest){
          throw new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');
        }
        await prepareMultiSourceParticipantErasure([erasureTarget],participantId);
        ownerSuppressed=await suppressRestoredParticipant(routeTarget.database,env.DELETION_LEDGER,
          env.QUARANTINE,participantId,rawIdentityLinkSecret,allowMissingIdentityLinkSecret,
          undefined,false)||ownerSuppressed;
      }catch(error){
        if(error instanceof ApiError&&error.code==='LIFECYCLE_BOUNDS_EXCEEDED')throw error;
        unitIncomplete=true;
      }
    }
    if(ownerSuppressed)suppressed++;
    if(availableTargets.length>0){
      await assertReplayOwnership();
      const advanced=await advanceMultiSourceStorageErasureJobs({targets:availableTargets,
        participantDigest,maxJobsPerTarget:1});
      if(advanced.pendingTargets>0||advanced.unavailableTargets.length>0)unitIncomplete=true;
    }
    if(availableTargets.length!==routeTargets.length)unitIncomplete=true;
    cycleIncomplete ||= unitIncomplete;
    const lastInCycle=page.length<=CATALOG_DELETION_REPLAY_PAGE_SIZE&&index===digests.length-1;
    cursor=await updateCursor(cursor,lastInCycle
      ?{after_participant_digest:'',cycle_incomplete:0,verification_required:cycleIncomplete?1:0}
      :{after_participant_digest:participantDigest,cycle_incomplete:Number(cycleIncomplete),
        verification_required:cursor.verification_required});
    if(lastInCycle)return {suppressed,complete:!cycleIncomplete};
  }
  return {suppressed,complete:false};
}

export async function replayDeletionTombstones(
  db: D1Database,
  ledger: D1Database,
  quarantine: R2Bucket,
  nowEpoch = Date.now(),
  rawIdentityLinkSecret?: unknown,
  // Direct offline lifecycle callers have no Env from which to identify a
  // synthetic-development run. The Worker maintenance integration passes an
  // explicit production fail-closed value below.
  allowMissingIdentityLinkSecret = true,
  storage?: StorageErasureBindings,
): Promise<{
  suppressed: number;
  complete: boolean;
}> {
  const digests = await deletionDigests(ledger, nowEpoch);
  if (digests.size === 0) return { suppressed: 0, complete: true };

  let cursor = "";
  let seen = 0;
  let suppressed = 0;
  while (seen <= MAX_LIFECYCLE_ROWS) {
    const page = await db.prepare(
      `SELECT id FROM participants
        WHERE id > ?
        ORDER BY id
        LIMIT ?`,
    ).bind(cursor, SCAN_PAGE_SIZE).all<ParticipantRow>();
    if (page.results.length === 0) {
      return { suppressed, complete: true };
    }
    for (const participant of page.results) {
      seen += 1;
      if (seen > MAX_LIFECYCLE_ROWS) {
        throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
      }
      cursor = participant.id;
      const digest = await participantDeletionDigest(participant.id);
      if (!digests.has(digest)) continue;
      if (suppressed >= MAX_RESTORE_SUPPRESSIONS_PER_PASS) {
        return { suppressed, complete: false };
      }
      const removed = await suppressRestoredParticipant(
        db,
        ledger,
        quarantine,
        participant.id,
        rawIdentityLinkSecret,
        allowMissingIdentityLinkSecret,
        storage,
      );
      if (removed) suppressed += 1;
    }
    if (page.results.length < SCAN_PAGE_SIZE) {
      return { suppressed, complete: true };
    }
  }
  throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
}

async function dueQuarantineObjects(
  db: D1Database,
  cutoffAt: string,
): Promise<QuarantineObjectRow[]> {
  const result = await db.prepare(
    `SELECT 'synthetic' AS source, id, r2_key
       FROM contributions
      WHERE quarantine_deleted_at IS NULL AND created_at <= ?
     UNION ALL
     SELECT 'telemetry' AS source, id, r2_key
       FROM telemetry_contributions
      WHERE quarantine_deleted_at IS NULL AND created_at <= ?
     UNION ALL
     SELECT 'telemetry_v1' AS source, id, r2_key
       FROM telemetry_v1_chunks
      WHERE quarantine_deleted_at IS NULL AND created_at <= ?
     UNION ALL
     SELECT 'telemetry_v11' AS source, id, r2_key
       FROM telemetry_v11_chunks
      WHERE quarantine_deleted_at IS NULL AND created_at <= ?
     ORDER BY id
     LIMIT ?`,
  ).bind(cutoffAt, cutoffAt, cutoffAt, cutoffAt, QUARANTINE_DELETE_BATCH_SIZE + 1)
    .all<QuarantineObjectRow>();
  return result.results;
}

/**
 * Age-based quarantine removal. Retention is disabled in every shipped
 * configuration, so `runBackendLifecycle` never calls this; it stays exported
 * and directly tested so re-enabling retention is a constant change against
 * machinery that is still known to work.
 */
export async function deleteDueQuarantineObjects(
  db: D1Database,
  quarantine: R2Bucket,
  cutoffAt: string,
): Promise<{
  deleted: number;
  complete: boolean;
}> {
  const due = await dueQuarantineObjects(db, cutoffAt);
  if (due.length === 0) return { deleted: 0, complete: true };
  const batch = due.slice(0, QUARANTINE_DELETE_BATCH_SIZE);
  await quarantine.delete(batch.map((row) => row.r2_key));
  const deletedAt = new Date().toISOString();
  const updates = batch.map((row) => db.prepare(
    `UPDATE ${QUARANTINE_SOURCE_TABLES[row.source]}
      SET quarantine_deleted_at = ?
      WHERE id = ? AND quarantine_deleted_at IS NULL RETURNING id`,
  ).bind(deletedAt, row.id));
  const results = await db.batch(updates);
  if (results.some((result, index) => result.results.length !== 1
      || typeof result.results[0] !== "object" || result.results[0] === null
      || Reflect.get(result.results[0], "id") !== batch[index]?.id)) {
    throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
  }
  return {
    deleted: batch.length,
    complete: due.length <= QUARANTINE_DELETE_BATCH_SIZE,
  };
}

export async function runBackendLifecycle(
  db: D1Database,
  ledger: D1Database,
  quarantine: R2Bucket,
  nowEpoch = Date.now(),
  beforeDestructivePhase?: LifecyclePhaseGuard,
  rawIdentityLinkSecret?: unknown,
  allowMissingIdentityLinkSecret = true,
  storage?: StorageErasureBindings,
  catalogEnv?:Env,
): Promise<LifecyclePassResult> {
  let ownershipLost = false;
  const assertOwnership = async (): Promise<void> => {
    if (beforeDestructivePhase === undefined) return;
    if (await beforeDestructivePhase()) return;
    ownershipLost = true;
    throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
  };
  const startedAt = canonicalInstant(nowEpoch);
  const quarantineCutoffAt = QUARANTINE_RETENTION_MILLISECONDS === null
    ? null
    : canonicalInstant(nowEpoch - QUARANTINE_RETENTION_MILLISECONDS);
  await assertOwnership();
  await db.prepare(
    `UPDATE retention_state
        SET state = 'running',
            last_started_at = ?,
            failure_code = NULL
      WHERE singleton = 1`,
  ).bind(startedAt).run();
  try {
    // Replay can delete whole participant data sets; renew or fence before it.
    await assertOwnership();
    const restoreReplay = catalogEnv
      ?await replayCatalogDeletionTombstones(catalogEnv,nowEpoch,rawIdentityLinkSecret,
        allowMissingIdentityLinkSecret,assertOwnership)
      :await replayDeletionTombstones(db,ledger,quarantine,nowEpoch,rawIdentityLinkSecret,
        allowMissingIdentityLinkSecret,storage);
    if(storage){const pending=await advanceStorageErasureJobs(storage,{maxJobs:1});
      if(pending.pending)restoreReplay.complete=false;}
    // R2 quarantine removal is a distinct destructive phase. An owner that
    // lost its outer maintenance lease must not enter it. With retention
    // disabled the phase is skipped outright: nothing is due, so the pass
    // reports a complete retention phase that deleted nothing.
    await assertOwnership();
    const quarantineRetention = quarantineCutoffAt === null
      ? { deleted: 0, complete: true }
      : await deleteDueQuarantineObjects(db, quarantine, quarantineCutoffAt);
    const completedAt = new Date().toISOString();
    await assertOwnership();
    await db.prepare(
      `UPDATE retention_state
          SET state = 'completed',
              last_completed_at = ?,
              maintenance_run_at = ?,
              quarantine_cutoff_at = ?,
              quarantine_objects_deleted = ?,
              quarantine_retention_complete = ?,
              restored_participants_suppressed = ?,
              restore_replay_complete = ?,
              failure_code = NULL
        WHERE singleton = 1`,
    ).bind(
      completedAt,
      startedAt,
      quarantineCutoffAt,
      quarantineRetention.deleted,
      Number(quarantineRetention.complete),
      restoreReplay.suppressed,
      Number(restoreReplay.complete),
    ).run();
    return {
      quarantineCutoffAt,
      quarantineObjectsDeleted: quarantineRetention.deleted,
      quarantineRetentionComplete: quarantineRetention.complete,
      restoredParticipantsSuppressed: restoreReplay.suppressed,
      restoreReplayComplete: restoreReplay.complete,
    };
  } catch (error) {
    // A successor may be running now. The old pass must not rewrite lifecycle
    // state to failed after its lease guard says it no longer owns the pass.
    if (ownershipLost) throw error;
    await db.prepare(
      `UPDATE retention_state
          SET state = 'failed',
              maintenance_run_at = NULL,
              failure_code = 'LIFECYCLE_PASS_FAILED'
        WHERE singleton = 1`,
    ).run();
    throw error;
  }
}
