import {
  canonicalTelemetryV11Json,
  MAX_TELEMETRY_V11_DOMAIN_DAYS,
  parseTelemetryV11DomainManifest,
  telemetryV11DomainManifestDigestInput,
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  assertTelemetryTransportWriteAllowed,
  type TelemetryTransportPrincipal,
} from "./telemetry-transport-policy";
import { MAX_V1_SOURCE_CHUNKS, selectV1WinningDevices, type V1SourceChunk } from "./telemetry-v1-source-selection";

export const V11_DOMAIN_METHOD_VERSION = "v11-complete-domain-1";
const DAY_MS = 86_400_000;
const PREDECESSOR_TTL_MS = 24 * 60 * 60 * 1_000;

interface SourceState {
  mutation_epoch: number; input_revision: number;
  generation_id: string | null; manifest_digest: string | null;
  from_day: string | null; through_day: string | null;
}

interface LegacyRange { from_day: string | null; through_day: string | null; }

export interface V11SourcePin {
  readonly source: "v1.1";
  readonly participantId: string;
  readonly generationId: string;
  readonly fromDay: string;
  readonly throughDay: string;
  readonly inputRevision: number;
  readonly mutationEpoch: number;
  readonly fingerprint: string;
}

function stateStatement(db: D1Database, participantId: string): D1PreparedStatement {
  return db.prepare(`SELECT control.mutation_epoch, v.revision AS input_revision,
    h.generation_id, d.manifest_digest, d.from_day, d.through_day
    FROM participants p
    JOIN community_analytical_input_versions v ON v.participant_id = p.id
    JOIN community_snapshot_mutation_control control ON control.singleton_id = 1
    LEFT JOIN telemetry_v11_domain_heads h ON h.participant_id = p.id
    LEFT JOIN telemetry_v11_domains d ON d.id = h.generation_id
    WHERE p.id = ? AND p.state = 'active'`).bind(participantId);
}

function validState(value: SourceState | null | undefined): value is SourceState {
  return !!value && Number.isSafeInteger(value.input_revision) && value.input_revision >= 0
    && Number.isSafeInteger(value.mutation_epoch) && value.mutation_epoch >= 0;
}

function utcDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

/** The pin always describes the whole active generation, not a wire/day join. */
export async function loadV11SourcePin(
  db: D1Database, participantId: string, options: {fromDay?: string; throughDay?: string} = {},
): Promise<V11SourcePin | null> {
  if (!participantId || (options.fromDay !== undefined && !utcDay(options.fromDay))
      || (options.throughDay !== undefined && !utcDay(options.throughDay))
      || (options.fromDay && options.throughDay && options.fromDay > options.throughDay)) {
    throw new TypeError("v11 source scope invalid");
  }
  const row = await stateStatement(db, participantId).first<SourceState>();
  if (!row) return null;
  if (!validState(row)) throw new Error("v11 source revision unavailable");
  if (row.generation_id === null) return null;
  if (!row.from_day || !row.through_day || !row.manifest_digest) throw new Error("v11 domain unavailable");
  const fingerprint = await sha256Hex(canonicalJson({ method: V11_DOMAIN_METHOD_VERSION,
    participantId, generationId: row.generation_id, manifestDigest: row.manifest_digest,
    fromDay: row.from_day, throughDay: row.through_day, inputRevision: row.input_revision }));
  return Object.freeze({source: "v1.1", participantId, generationId: row.generation_id,
    fromDay: row.from_day, throughDay: row.through_day, inputRevision: row.input_revision,
    mutationEpoch: row.mutation_epoch, fingerprint});
}

export async function assertV11SourcePinCurrent(db: D1Database, pin: V11SourcePin): Promise<void> {
  const current = await loadV11SourcePin(db, pin.participantId);
  if (!current || current.fingerprint !== pin.fingerprint) throw new Error("v11 source changed during analysis");
}

export interface TelemetryV11DomainPredecessor {
  schemaVersion: "telemetry-domain-predecessor-v1.1";
  token: string; previousGenerationId: string | null; legacyFingerprint: string;
  fromDay: string; throughDay: string; expiresAt: string;
}

/**
 * Authenticated bootstrap/successor token. Snapshot only chunk journals, not a
 * million-row corpus. A single D1 batch pins both the old-format vector and the
 * participant revision. Final activation repeats semantic proof transactionally.
 */
export async function createTelemetryV11DomainPredecessor(
  db: D1Database, principal: TelemetryTransportPrincipal, nowEpoch = Date.now(),
): Promise<TelemetryV11DomainPredecessor> {
  await assertTelemetryTransportWriteAllowed(db, principal, TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION);
  const result = await db.batch<SourceState | V1SourceChunk | LegacyRange>([
    stateStatement(db, principal.participantId),
    db.prepare(`SELECT c.id, c.participant_id, c.device_id, c.chunk_day, c.stream,
      c.revision, c.chunk_digest, c.parser_version, c.accepted_record_count, c.created_at
      FROM telemetry_v1_chunks c WHERE c.participant_id = ? AND c.superseded_at IS NULL
        AND c.accepted_record_count > 0 ORDER BY c.chunk_day, c.device_id, c.stream, c.id LIMIT ?`)
      .bind(principal.participantId, MAX_V1_SOURCE_CHUNKS + 1),
    db.prepare(`SELECT MIN(substr(range_start, 1, 10)) AS from_day,
      MAX(substr(range_end, 1, 10)) AS through_day FROM telemetry_contributions
      WHERE participant_id = ? AND status = 'accepted'
        AND transport_schema_version = 'telemetry-contribution-v0.2'`)
      .bind(principal.participantId),
  ]);
  const state = result[0]?.results[0] as SourceState | undefined;
  const chunks = result[1]?.results as V1SourceChunk[] | undefined;
  const legacyRange = result[2]?.results[0] as LegacyRange | undefined;
  if (!validState(state) || !Array.isArray(chunks)) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  if (!legacyRange || [legacyRange.from_day, legacyRange.through_day]
    .some((day) => day !== null && !utcDay(day))) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  if (chunks.length > MAX_V1_SOURCE_CHUNKS) throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  const winners = selectV1WinningDevices(chunks);
  const today = new Date(nowEpoch).toISOString().slice(0, 10);
  const knownDays = [today, ...winners.map((winner) => winner.observed_day),
    ...[state.from_day, state.through_day, legacyRange.from_day, legacyRange.through_day]
      .filter((day): day is string => day !== null)].sort();
  const fromDay = knownDays[0]!;
  const throughDay = knownDays.at(-1)!;
  if ((Date.parse(throughDay) - Date.parse(fromDay)) / DAY_MS + 1 > MAX_TELEMETRY_V11_DOMAIN_DAYS) {
    throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  }
  const legacyFingerprint = await sha256Hex(canonicalJson({method: V11_DOMAIN_METHOD_VERSION,
    participantId: principal.participantId, inputRevision: state.input_revision,
    previousGenerationId: state.generation_id, previousManifestDigest: state.manifest_digest,
    chunks, winners, legacyRange}));
  const token = crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const now = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + PREDECESSOR_TTL_MS).toISOString();
  const winnersJson = JSON.stringify(winners.map((winner) => [winner.participant_id, winner.observed_day, winner.device_id]));
  const rows = await db.batch([
    db.prepare(`DELETE FROM telemetry_v11_domain_predecessors
      WHERE participant_id = ? AND device_id = ? AND consumed_at IS NULL
        AND (expires_at <= ? OR token_hash IN (SELECT x.token_hash FROM telemetry_v11_domain_predecessors x
          WHERE x.participant_id = ? AND x.device_id = ? AND x.consumed_at IS NULL
          ORDER BY x.created_at DESC, x.token_hash LIMIT -1 OFFSET 7))
        AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domains d WHERE d.predecessor_token_hash = token_hash)`)
      .bind(principal.participantId, principal.deviceId, now, principal.participantId, principal.deviceId),
    db.prepare(`INSERT INTO telemetry_v11_domain_predecessors (
      token_hash, participant_id, device_id, previous_generation_id, legacy_fingerprint,
      input_revision, from_day, through_day, winners_json, created_at, expires_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM community_analytical_input_versions v
        JOIN participants p ON p.id = v.participant_id AND p.state = 'active'
        WHERE v.participant_id = ? AND v.revision = ?)
        AND (SELECT generation_id FROM telemetry_v11_domain_heads WHERE participant_id = ?) IS ?
        AND (SELECT count(*) FROM telemetry_v11_domain_predecessors x
          WHERE x.participant_id = ? AND x.device_id = ? AND x.consumed_at IS NULL AND x.expires_at > ?) < 8
      RETURNING token_hash`).bind(tokenHash, principal.participantId, principal.deviceId,
      state.generation_id, legacyFingerprint, state.input_revision, fromDay, throughDay,
      winnersJson, now, expiresAt, principal.participantId, state.input_revision,
      principal.participantId, state.generation_id, principal.participantId, principal.deviceId, now),
  ]);
  if (rows[1]?.results.length !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  return {schemaVersion: "telemetry-domain-predecessor-v1.1", token,
    previousGenerationId: state.generation_id, legacyFingerprint, fromDay, throughDay, expiresAt};
}

interface ActivatedDomainRow {
  id: string; manifest_digest: string; from_day: string; through_day: string;
}

export interface TelemetryV11DomainActivation {
  schemaVersion: "telemetry-domain-activation-v1.1";
  generationId: string; manifestDigest: string; fromDay: string; throughDay: string;
  replay: boolean;
  unchanged?: true;
  requestedManifestDigest?: string;
}

function activationResult(row: ActivatedDomainRow, replay: boolean): TelemetryV11DomainActivation {
  return {schemaVersion: "telemetry-domain-activation-v1.1", generationId: row.id,
    manifestDigest: row.manifest_digest, fromDay: row.from_day, throughDay: row.through_day, replay};
}

function domainError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = String(error);
  if (message.includes("telemetry_domain_range_too_large")) return new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  if (message.includes("telemetry_domain_incomplete")) return new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  if (message.includes("telemetry_domain_occurrence_conflict")) return new ApiError(409, "TELEMETRY_OCCURRENCE_CONFLICT");
  if (message.includes("telemetry_domain_compatibility_unproven")) {
    return new ApiError(409, "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE");
  }
  if (message.includes("telemetry_domain_predecessor_changed")
      || message.includes("UNIQUE constraint failed: telemetry_v11_domains")) {
    return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

async function activeDomainByDigest(
  db: D1Database, principal: TelemetryTransportPrincipal, digest: string,
): Promise<ActivatedDomainRow | null> {
  return db.prepare(`SELECT d.id, d.manifest_digest, d.from_day, d.through_day
    FROM telemetry_v11_domain_heads h JOIN telemetry_v11_domains d ON d.id = h.generation_id
    JOIN participants p ON p.id = d.participant_id AND p.state = 'active'
    WHERE d.participant_id = ? AND d.device_id = ? AND d.manifest_digest = ?`)
    .bind(principal.participantId, principal.deviceId, digest).first<ActivatedDomainRow>();
}

/**
 * One D1 transaction closes the vector, proves every predecessor occurrence,
 * compare-and-swaps the active head, and invalidates existing public caches.
 * A failed/partial transfer leaves the previous source selected, without joins.
 */
export async function activateTelemetryV11Domain(
  db: D1Database, principal: TelemetryTransportPrincipal, value: unknown, nowEpoch = Date.now(),
): Promise<TelemetryV11DomainActivation> {
  let manifest: ReturnType<typeof parseTelemetryV11DomainManifest>;
  try {
    // Detach from an in-process caller too: validation cannot be raced by a
    // mutation of their object while asynchronous admission checks are running.
    manifest = JSON.parse(canonicalTelemetryV11Json(parseTelemetryV11DomainManifest(value)));
  } catch { throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID"); }
  if (await sha256Hex(telemetryV11DomainManifestDigestInput(manifest)) !== manifest.manifestDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  await assertTelemetryTransportWriteAllowed(db, principal, TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION);
  const existing = await activeDomainByDigest(db, principal, manifest.manifestDigest);
  if (existing) return activationResult(existing, true);
  const tokenHash = await sha256Hex(manifest.predecessor.token);
  const predecessor = await db.prepare(`SELECT input_revision, from_day, through_day
    FROM telemetry_v11_current_predecessors WHERE token_hash = ? AND participant_id = ?
      AND device_id = ? AND previous_generation_id IS ? AND legacy_fingerprint = ?`)
    .bind(tokenHash, principal.participantId, principal.deviceId,
      manifest.predecessor.previousGenerationId, manifest.predecessor.legacyFingerprint)
    .first<{input_revision: number; from_day: string; through_day: string}>();
  if (!predecessor || manifest.fromDay > predecessor.from_day || manifest.throughDay < predecessor.through_day) {
    throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  const daysJson = canonicalTelemetryV11Json(manifest.days);
  // A new predecessor token does not make an unchanged day vector new data.
  // Require the exact revision immediately after the original activation:
  // later legacy input, deletion or correction must still run the closure proof.
  // This read repeats current predecessor admission and head/revision checks in
  // one statement, so the early acknowledgement cannot skip a raced mutation.
  const unchanged = await db.prepare(`SELECT d.id, d.manifest_digest, d.from_day, d.through_day
    FROM telemetry_v11_domain_heads h
    JOIN telemetry_v11_domains d ON d.id = h.generation_id
    JOIN telemetry_v11_current_predecessors x ON x.token_hash = ?
      AND x.participant_id = h.participant_id AND x.previous_generation_id = h.generation_id
      AND x.input_revision = d.input_revision + 1
    WHERE h.participant_id = ? AND d.device_id = ? AND x.device_id = d.device_id
      AND x.legacy_fingerprint = ? AND d.from_day = ? AND d.through_day = ? AND d.days_json = ?`)
    .bind(tokenHash, principal.participantId, principal.deviceId, manifest.predecessor.legacyFingerprint,
      manifest.fromDay, manifest.throughDay, daysJson).first<ActivatedDomainRow>();
  if (unchanged) return {...activationResult(unchanged, true), unchanged: true,
    requestedManifestDigest: manifest.manifestDigest};
  const generationId = crypto.randomUUID();
  const now = new Date(nowEpoch).toISOString();
  try {
    const result = await db.batch<{generation_id?: string}>([
      db.prepare(`INSERT INTO telemetry_v11_domains (
        id, participant_id, device_id, predecessor_token_hash, previous_generation_id,
        manifest_digest, legacy_fingerprint, input_revision, from_day, through_day, days_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(generationId, principal.participantId, principal.deviceId, tokenHash,
          manifest.predecessor.previousGenerationId, manifest.manifestDigest,
          manifest.predecessor.legacyFingerprint, predecessor.input_revision,
          manifest.fromDay, manifest.throughDay, daysJson, now),
      db.prepare(`INSERT INTO telemetry_v11_domain_days (generation_id, observed_day, manifest_id)
        SELECT ?, json_extract(e.value, '$.day'), json_extract(e.value, '$.manifestId') FROM json_each(?) e`)
        .bind(generationId, daysJson),
      db.prepare(`INSERT INTO telemetry_v11_domain_heads (participant_id, generation_id, revision, updated_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(participant_id) DO UPDATE SET generation_id = excluded.generation_id,
          revision = telemetry_v11_domain_heads.revision + 1, updated_at = excluded.updated_at
        RETURNING generation_id`).bind(principal.participantId, generationId, now),
    ]);
    // Trigger writes inflate meta.changes. Prove this exact target instead.
    if (result[2]?.results.length !== 1
        || result[2].results[0]?.generation_id !== generationId) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  } catch (error) {
    // An uncertain network response or concurrent identical retry is safe.
    const replay = await activeDomainByDigest(db, principal, manifest.manifestDigest);
    if (replay) return activationResult(replay, true);
    throw domainError(error);
  }
  return activationResult({id: generationId, manifest_digest: manifest.manifestDigest,
    from_day: manifest.fromDay, through_day: manifest.throughDay}, false);
}
