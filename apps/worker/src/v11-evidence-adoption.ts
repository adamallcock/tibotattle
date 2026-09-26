import {
  MAX_TELEMETRY_V11_DOMAIN_DAYS,
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  telemetryV11DomainManifestDigestInput,
} from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import { beginAdminOperation, finishAdminOperation } from "./admin-operations";
import { assertTelemetryTransportWriteAllowed, type TelemetryTransportPrincipal } from "./telemetry-transport-policy";
import { activateTelemetryV11Domain, V11_DOMAIN_METHOD_VERSION } from "./telemetry-v11-domain";

/**
 * Owner-run adoption of accepted but never-activated v1.1 uploads.
 *
 * A device's uploaded day becomes public only when the device itself activates
 * a domain generation covering it. Clients that stop before a first sync
 * finishes, or whose newer build re-emits an already accepted day with fewer
 * records, leave complete uploads that no generation ever covers. This builds
 * the largest contiguous generation from the device's complete (ready) days,
 * keeps an already accepted day's manifest wherever a newer one would drop an
 * accepted record, and activates it through the ordinary predecessor and
 * activation path: every database proof still applies and refuses anything a
 * client could not activate itself. Only a device whose own v1.1 upload
 * authority is currently valid is considered; a device that may be mid-pass or
 * has moved to v1.2 is left to its client. The audit holds counts only; the
 * owner's result adds just the pseudonymous participant paging cursor.
 */
export const V11_EVIDENCE_ADOPTION_METHOD = "v11-uploaded-evidence-adoption-1";
export const V11_EVIDENCE_ADOPTION_MAX_DEVICES = 25;
const DAY_MS = 86_400_000;
const PREDECESSOR_TTL_MS = 10 * 60 * 1_000;
/** A client pass is bounded at five minutes; an unconsumed predecessor younger
 * than this may belong to a pass that is still uploading or activating. */
const CLIENT_PASS_QUIET_MS = 10 * 60 * 1_000;
const PARTICIPANT = /^[A-Za-z0-9._:-]{1,256}$/u;

export interface V11EvidenceAdoptionRequest {
  readonly dryRun: boolean;
  readonly maxDevices: number;
  readonly afterParticipantId: string | null;
}

export type V11EvidenceAdoptionOutcome =
  | "adopted" | "adoptable" | "unchanged" | "authority_unavailable" | "client_syncing"
  | "successor_active" | "unsupported_history" | "no_contiguous_days" | "refused";

export interface V11EvidenceAdoptionResult {
  readonly task: "v11_evidence_adoption";
  readonly method: typeof V11_EVIDENCE_ADOPTION_METHOD;
  readonly dryRun: boolean;
  readonly examined: number;
  readonly outcomes: Readonly<Record<V11EvidenceAdoptionOutcome, number>>;
  readonly refusals: Readonly<Record<string, number>>;
  readonly daysCovered: number;
  readonly newDays: number;
  readonly keptAcceptedDays: number;
  readonly nextAfterParticipantId: string | null;
  readonly operationId?: string;
}

export function parseV11EvidenceAdoptionRequest(value: unknown): V11EvidenceAdoptionRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== "action\0v11EvidenceAdoption"
      || Reflect.get(value, "action") !== "run_maintenance") throw new ApiError(400, "BODY_INVALID");
  const target: unknown = Reflect.get(value, "v11EvidenceAdoption");
  if (target === null || typeof target !== "object" || Array.isArray(target)
      || Object.keys(target).some((key) => !["dryRun", "maxDevices", "afterParticipantId"].includes(key))) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const dryRun = Reflect.get(target, "dryRun");
  const maxDevices = Reflect.get(target, "maxDevices") ?? 10;
  const after = Reflect.get(target, "afterParticipantId") ?? null;
  if (typeof dryRun !== "boolean" || !Number.isSafeInteger(maxDevices) || maxDevices < 1
      || maxDevices > V11_EVIDENCE_ADOPTION_MAX_DEVICES
      || (after !== null && (typeof after !== "string" || !PARTICIPANT.test(after)))) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return Object.freeze({ dryRun, maxDevices, afterParticipantId: after });
}

interface Candidate { participant_id: string; device_id: string }
interface HeadState {
  input_revision: number; generation_id: string | null; manifest_digest: string | null;
  from_day: string | null; through_day: string | null; device_id: string | null;
}
interface DayManifest { day: string; manifestId: string; manifestDigest: string }

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Accountless devices whose latest complete upload of some day is not the
 * manifest their head carries for it. Bounded and cursor-paged by participant. */
async function candidates(db: D1Database, after: string | null, limit: number): Promise<Candidate[]> {
  return (await db.prepare(`SELECT DISTINCT m.participant_id, m.device_id
      FROM telemetry_v11_day_manifests m
      JOIN participants p ON p.id = m.participant_id AND p.state = 'active' AND p.owner_kind = 'accountless'
      JOIN device_credentials d ON d.id = m.device_id AND d.participant_id = m.participant_id
       AND d.state = 'active' AND d.authority_kind = 'accountless'
     WHERE m.state = 'ready' AND m.participant_id > ?
       AND NOT EXISTS (SELECT 1 FROM telemetry_v11_day_manifests newer
        WHERE newer.participant_id = m.participant_id AND newer.device_id = m.device_id
          AND newer.chunk_day = m.chunk_day AND newer.state = 'ready'
          AND (newer.created_at > m.created_at OR (newer.created_at = m.created_at AND newer.id > m.id)))
       AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h
         JOIN telemetry_v11_domain_days dd ON dd.generation_id = h.generation_id
        WHERE h.participant_id = m.participant_id AND dd.observed_day = m.chunk_day AND dd.manifest_id = m.id)
     ORDER BY m.participant_id, m.device_id LIMIT ?`).bind(after ?? "", limit).all<Candidate>()).results;
}

async function headState(db: D1Database, participantId: string): Promise<HeadState | null> {
  return db.prepare(`SELECT v.revision AS input_revision, h.generation_id, d.manifest_digest,
      d.from_day, d.through_day, d.device_id
      FROM participants p
      JOIN community_analytical_input_versions v ON v.participant_id = p.id
      LEFT JOIN telemetry_v11_domain_heads h ON h.participant_id = p.id
      LEFT JOIN telemetry_v11_domains d ON d.id = h.generation_id
     WHERE p.id = ? AND p.state = 'active'`).bind(participantId).first<HeadState>();
}

/** The latest ready manifest per day for this device, and the head's days. */
async function dayManifests(db: D1Database, principal: TelemetryTransportPrincipal, generationId: string | null) {
  const [ready, head] = await db.batch<{ day: string; manifest_id: string; manifest_digest: string }>([
    db.prepare(`SELECT m.chunk_day AS day, m.id AS manifest_id, m.manifest_digest
        FROM telemetry_v11_day_manifests m
       WHERE m.participant_id = ? AND m.device_id = ? AND m.state = 'ready'
         AND m.id = (SELECT latest.id FROM telemetry_v11_day_manifests latest
          WHERE latest.participant_id = m.participant_id AND latest.device_id = m.device_id
            AND latest.chunk_day = m.chunk_day AND latest.state = 'ready'
          ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
       ORDER BY m.chunk_day LIMIT ?`).bind(principal.participantId, principal.deviceId, MAX_TELEMETRY_V11_DOMAIN_DAYS + 1),
    db.prepare(`SELECT dd.observed_day AS day, dd.manifest_id, m.manifest_digest
        FROM telemetry_v11_domain_days dd JOIN telemetry_v11_day_manifests m ON m.id = dd.manifest_id
       WHERE dd.generation_id = ? ORDER BY dd.observed_day`).bind(generationId),
  ]);
  const toMap = (rows: { day: string; manifest_id: string; manifest_digest: string }[] | undefined) =>
    new Map((rows ?? []).map((row) => [row.day, { day: row.day, manifestId: row.manifest_id, manifestDigest: row.manifest_digest }]));
  const readyRows = ready?.results ?? [];
  if (readyRows.length > MAX_TELEMETRY_V11_DOMAIN_DAYS) throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  return { ready: toMap(readyRows), head: toMap(head?.results) };
}

/** Days whose newer upload omits an accepted record of the head's manifest
 * (any stream, by occurrence and base digest). One bounded query per device.
 * Stricter than the activation proof, which also admits qualified usage-total
 * corrections, so a doubtful day keeps its accepted manifest. */
async function daysDroppingAccepted(db: D1Database, pairs: Array<[string, string, string]>): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const rows = await db.prepare(`SELECT json_extract(pair.value, '$[0]') AS day FROM json_each(?) pair
     WHERE EXISTS (SELECT 1 FROM typed_v11_record_admissions accepted
       WHERE accepted.manifest_id = json_extract(pair.value, '$[1]')
         AND NOT EXISTS (SELECT 1 FROM typed_v11_record_admissions candidate
          WHERE candidate.manifest_id = json_extract(pair.value, '$[2]') AND candidate.stream = accepted.stream
            AND candidate.occurrence_id = accepted.occurrence_id AND candidate.base_digest = accepted.base_digest))`)
    .bind(JSON.stringify(pairs)).all<{ day: string }>();
  return new Set(rows.results.map((row) => row.day));
}

interface Plan { days: DayManifest[]; newDays: number; keptAcceptedDays: number }

async function plan(db: D1Database, state: HeadState, ready: Map<string, DayManifest>,
  head: Map<string, DayManifest>): Promise<Plan | null> {
  const chosen = new Map<string, DayManifest>();
  let keptAcceptedDays = 0, newDays = 0, fromDay: string, throughDay: string;
  if (state.generation_id !== null && state.from_day && state.through_day) {
    // The new generation must keep every day the head covers.
    const replaced: Array<[string, string, string]> = [];
    for (let day = state.from_day; day <= state.through_day; day = addDays(day, 1)) {
      const accepted = head.get(day);
      if (!accepted) return null;
      const newer = ready.get(day);
      if (newer && newer.manifestId !== accepted.manifestId) replaced.push([day, accepted.manifestId, newer.manifestId]);
    }
    const dropping = await daysDroppingAccepted(db, replaced);
    for (let day = state.from_day; day <= state.through_day; day = addDays(day, 1)) {
      const newer = ready.get(day);
      const keep = !newer || newer.manifestId === head.get(day)!.manifestId || dropping.has(day);
      if (dropping.has(day)) keptAcceptedDays += 1;
      chosen.set(day, keep ? head.get(day)! : newer);
    }
    fromDay = state.from_day;
    throughDay = state.through_day;
    // Extend forward over the device's contiguous complete days.
    for (let day = addDays(throughDay, 1); ready.has(day); day = addDays(day, 1)) {
      chosen.set(day, ready.get(day)!);
      throughDay = day;
      newDays += 1;
    }
  } else {
    // No head: the longest contiguous run of complete days, preferring the latest.
    const days = [...ready.keys()].sort();
    let bestFrom: string | null = null, bestLength = 0;
    for (let index = 0; index < days.length;) {
      let end = index;
      while (end + 1 < days.length && days[end + 1] === addDays(days[end]!, 1)) end += 1;
      const length = end - index + 1;
      if (length >= bestLength) { bestLength = length; bestFrom = days[index]!; }
      index = end + 1;
    }
    if (bestFrom === null) return null;
    fromDay = bestFrom;
    throughDay = addDays(bestFrom, bestLength - 1);
    for (let day = fromDay; day <= throughDay; day = addDays(day, 1)) chosen.set(day, ready.get(day)!);
    newDays = bestLength;
  }
  if ((Date.parse(throughDay) - Date.parse(fromDay)) / DAY_MS + 1 > MAX_TELEMETRY_V11_DOMAIN_DAYS) return null;
  return { days: [...chosen.values()].sort((a, b) => a.day.localeCompare(b.day)), newDays, keptAcceptedDays };
}

function unchanged(state: HeadState, head: Map<string, DayManifest>, proposal: Plan): boolean {
  return state.generation_id !== null && proposal.days.length === head.size
    && proposal.days.every((day) => head.get(day.day)?.manifestId === day.manifestId);
}

/** Issue a predecessor for exactly the adopted range, with the same fingerprint
 * construction as the device's own predecessor for a source without v1 or
 * legacy history, under the same current-revision and head guards. */
async function adoptionPredecessor(db: D1Database, principal: TelemetryTransportPrincipal, state: HeadState,
  fromDay: string, throughDay: string, nowEpoch: number) {
  const legacyFingerprint = await sha256Hex(canonicalJson({ method: V11_DOMAIN_METHOD_VERSION,
    participantId: principal.participantId, inputRevision: state.input_revision,
    previousGenerationId: state.generation_id, previousManifestDigest: state.manifest_digest,
    chunks: [], winners: [], legacyRange: { from_day: null, through_day: null } }));
  const token = crypto.randomUUID();
  const now = new Date(nowEpoch).toISOString();
  const rows = await db.prepare(`INSERT INTO telemetry_v11_domain_predecessors (
      token_hash, participant_id, device_id, previous_generation_id, legacy_fingerprint,
      input_revision, from_day, through_day, winners_json, created_at, expires_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?
      WHERE EXISTS (SELECT 1 FROM community_analytical_input_versions v
        JOIN participants p ON p.id = v.participant_id AND p.state = 'active'
        WHERE v.participant_id = ? AND v.revision = ?)
        AND (SELECT generation_id FROM telemetry_v11_domain_heads WHERE participant_id = ?) IS ?
        AND (SELECT count(*) FROM telemetry_v11_domain_predecessors x
          WHERE x.participant_id = ? AND x.device_id = ? AND x.consumed_at IS NULL AND x.expires_at > ?) < 8
    RETURNING token_hash`).bind(await sha256Hex(token), principal.participantId, principal.deviceId,
      state.generation_id, legacyFingerprint, state.input_revision, fromDay, throughDay, now,
      new Date(nowEpoch + PREDECESSOR_TTL_MS).toISOString(), principal.participantId, state.input_revision,
      principal.participantId, state.generation_id, principal.participantId, principal.deviceId, now).all();
  if (rows.results.length !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  return { token, legacyFingerprint };
}

async function adoptDevice(db: D1Database, principal: TelemetryTransportPrincipal, dryRun: boolean,
  nowEpoch: number, successorSchema: boolean)
  : Promise<{ outcome: V11EvidenceAdoptionOutcome; code?: string; plan?: Plan }> {
  // A device on the successor protocol re-uploads through v1.2 itself.
  if (successorSchema && await db.prepare(`SELECT 1 AS present FROM telemetry_v12_active_authorizations
      WHERE participant_id = ? AND device_id = ? LIMIT 1`)
    .bind(principal.participantId, principal.deviceId).first()) return { outcome: "successor_active" };
  try {
    await assertTelemetryTransportWriteAllowed(db, principal, TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION);
  } catch {
    return { outcome: "authority_unavailable" };
  }
  if (await db.prepare(`SELECT 1 AS present FROM telemetry_v11_domain_predecessors
      WHERE participant_id = ? AND device_id = ? AND consumed_at IS NULL AND created_at > ? LIMIT 1`)
    .bind(principal.participantId, principal.deviceId, new Date(nowEpoch - CLIENT_PASS_QUIET_MS).toISOString())
    .first()) return { outcome: "client_syncing" };
  // v1 and legacy histories need their own closure proof; they stay with the client.
  const history = await db.prepare(`SELECT
      EXISTS (SELECT 1 FROM telemetry_v1_chunks c WHERE c.participant_id = ? AND c.superseded_at IS NULL
        AND c.accepted_record_count > 0) AS v1,
      EXISTS (SELECT 1 FROM telemetry_contributions c WHERE c.participant_id = ? AND c.status = 'accepted'
        AND c.transport_schema_version = 'telemetry-contribution-v0.2') AS legacy`)
    .bind(principal.participantId, principal.participantId).first<{ v1: number; legacy: number }>();
  if (!history || history.v1 !== 0 || history.legacy !== 0) return { outcome: "unsupported_history" };
  const state = await headState(db, principal.participantId);
  if (!state || !Number.isSafeInteger(state.input_revision)) return { outcome: "authority_unavailable" };
  if (state.generation_id !== null && state.device_id !== principal.deviceId) return { outcome: "unsupported_history" };
  const { ready, head } = await dayManifests(db, principal, state.generation_id);
  const proposal = await plan(db, state, ready, head);
  if (!proposal || proposal.days.length === 0) return { outcome: "no_contiguous_days" };
  if (unchanged(state, head, proposal)) return { outcome: "unchanged" };
  if (dryRun) return { outcome: "adoptable", plan: proposal };
  const fromDay = proposal.days[0]!.day, throughDay = proposal.days.at(-1)!.day;
  try {
    const predecessor = await adoptionPredecessor(db, principal, state, fromDay, throughDay, nowEpoch);
    const manifest = {
      schemaVersion: "telemetry-domain-manifest-v1.1" as const, fromDay, throughDay,
      predecessor: { token: predecessor.token, previousGenerationId: state.generation_id,
        legacyFingerprint: predecessor.legacyFingerprint },
      days: proposal.days, manifestDigest: "0".repeat(64),
    };
    manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
    await activateTelemetryV11Domain(db, principal, manifest, nowEpoch);
    return { outcome: "adopted", plan: proposal };
  } catch (error) {
    return { outcome: "refused", code: error instanceof ApiError ? error.code : "ADOPTION_FAILED" };
  }
}

/** One bounded page. The owner repeats it with the returned cursor. */
export async function adoptV11UploadedEvidence(db: D1Database, request: V11EvidenceAdoptionRequest,
  nowEpoch = Date.now()): Promise<V11EvidenceAdoptionResult> {
  const page = await candidates(db, request.afterParticipantId, request.maxDevices + 1);
  const selected = page.slice(0, request.maxDevices);
  const successorSchema = await db.prepare(`SELECT 1 AS present FROM sqlite_schema
    WHERE type = 'view' AND name = 'telemetry_v12_active_authorizations'`).first() !== null;
  const outcomes: Record<V11EvidenceAdoptionOutcome, number> = { adopted: 0, adoptable: 0, unchanged: 0,
    authority_unavailable: 0, client_syncing: 0, successor_active: 0, unsupported_history: 0,
    no_contiguous_days: 0, refused: 0 };
  const refusals: Record<string, number> = {};
  let daysCovered = 0, newDays = 0, keptAcceptedDays = 0;
  for (const candidate of selected) {
    const result = await adoptDevice(db, { participantId: candidate.participant_id, deviceId: candidate.device_id },
      request.dryRun, nowEpoch, successorSchema);
    outcomes[result.outcome] += 1;
    if (result.code) refusals[result.code] = (refusals[result.code] ?? 0) + 1;
    if (result.plan && (result.outcome === "adopted" || result.outcome === "adoptable")) {
      daysCovered += result.plan.days.length;
      newDays += result.plan.newDays;
      keptAcceptedDays += result.plan.keptAcceptedDays;
    }
  }
  return Object.freeze({ task: "v11_evidence_adoption" as const, method: V11_EVIDENCE_ADOPTION_METHOD,
    dryRun: request.dryRun, examined: selected.length, outcomes: Object.freeze(outcomes),
    refusals: Object.freeze(refusals), daysCovered, newDays, keptAcceptedDays,
    nextAfterParticipantId: page.length > request.maxDevices ? selected.at(-1)!.participant_id : null });
}

/** Owner entrypoint: audited like the other owner maintenance operations. */
export async function adoptV11UploadedEvidenceAsOwner(db: D1Database, actorIdentityKey: string,
  request: V11EvidenceAdoptionRequest, nowEpoch = Date.now()): Promise<V11EvidenceAdoptionResult> {
  const details = { task: "v11_evidence_adoption", method: V11_EVIDENCE_ADOPTION_METHOD,
    dryRun: request.dryRun, maxDevices: request.maxDevices };
  const operationId = await beginAdminOperation(db, actorIdentityKey, "run_maintenance", details);
  try {
    const result = await adoptV11UploadedEvidence(db, request, nowEpoch);
    await finishAdminOperation(db, operationId, "success", { ...details, examined: result.examined,
      outcomes: result.outcomes, refusals: result.refusals, daysCovered: result.daysCovered,
      newDays: result.newDays, keptAcceptedDays: result.keptAcceptedDays });
    return { ...result, operationId };
  } catch (error) {
    const safeError = error instanceof ApiError ? error : new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    try { await finishAdminOperation(db, operationId, "failure", { ...details, code: safeError.code }); }
    catch { /* a missing terminal audit is never reported as success */ }
    throw safeError;
  }
}
