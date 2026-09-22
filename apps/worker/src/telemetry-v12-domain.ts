import {
  canonicalTelemetryV12Json,
  MAX_TELEMETRY_V12_DOMAIN_DAYS,
  parseTelemetryV12DomainManifest,
  telemetryV12DomainManifestDigestInput,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  assertTelemetryV12WriteAllowed,
  type TelemetryTransportPrincipal,
} from "./telemetry-transport-policy";

export const V12_DOMAIN_METHOD_VERSION = "v12-complete-domain-1";
const DAY_MS = 86_400_000;
const PREDECESSOR_TTL_MS = 24 * 60 * 60 * 1_000;

interface SourceState {
  input_revision: number;
  generation_id: string | null;
  manifest_digest: string | null;
}

interface ReadyManifest {
  id: string;
  chunk_day: string;
  manifest_digest: string;
}

export interface TelemetryV12DomainPredecessor {
  schemaVersion: "telemetry-domain-predecessor-v1.2";
  token: string;
  previousGenerationId: string | null;
  legacyFingerprint: string;
  fromDay: string;
  throughDay: string;
  expiresAt: string;
}

export interface TelemetryV12DomainActivation {
  schemaVersion: "telemetry-domain-activation-v1.2";
  generationId: string;
  manifestDigest: string;
  fromDay: string;
  throughDay: string;
  replay: boolean;
}

function utcDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function stateStatement(db: D1Database, participantId: string): D1PreparedStatement {
  return db.prepare(
    `SELECT v.revision AS input_revision,
            h.generation_id, d.manifest_digest
       FROM participants p
       JOIN community_analytical_input_versions v ON v.participant_id = p.id
       LEFT JOIN telemetry_v12_domain_heads h ON h.participant_id = p.id
       LEFT JOIN telemetry_v12_domains d ON d.id = h.generation_id
      WHERE p.id = ? AND p.state = 'active'`,
  ).bind(participantId);
}

function validState(row: SourceState | null | undefined): row is SourceState {
  return !!row && Number.isSafeInteger(row.input_revision) && row.input_revision >= 0;
}

function domainError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = String(error);
  if (message.includes("telemetry_v12_transport_blocked")) return new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  if (message.includes("telemetry_v12_manifest_incomplete")) return new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  if (message.includes("telemetry_v12_domain_revision_conflict")) return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  if (message.includes("UNIQUE constraint failed: telemetry_v12_domains")) return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

export async function createTelemetryV12DomainPredecessor(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  nowEpoch = Date.now(),
): Promise<TelemetryV12DomainPredecessor> {
  await assertTelemetryV12WriteAllowed(db, principal);
  const result = await db.batch<SourceState | ReadyManifest>([
    stateStatement(db, principal.participantId),
    db.prepare(
      `SELECT id, chunk_day, manifest_digest
         FROM telemetry_v12_day_manifests
        WHERE participant_id = ? AND device_id = ? AND state = 'ready'
        ORDER BY chunk_day, created_at, id LIMIT ?`,
    ).bind(principal.participantId, principal.deviceId, MAX_TELEMETRY_V12_DOMAIN_DAYS + 1),
  ]);
  const state = result[0]?.results[0] as SourceState | undefined;
  const manifests = result[1]?.results as ReadyManifest[] | undefined;
  if (!validState(state) || !Array.isArray(manifests)) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  if (manifests.length > MAX_TELEMETRY_V12_DOMAIN_DAYS) throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  const byDay = new Map<string, ReadyManifest>();
  for (const manifest of manifests) {
    if (!utcDay(manifest.chunk_day)) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    if (!byDay.has(manifest.chunk_day)) byDay.set(manifest.chunk_day, manifest);
  }
  const days = [...byDay.values()].sort((left, right) => left.chunk_day.localeCompare(right.chunk_day));
  if (days.length < 1) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  const fromDay = days[0]!.chunk_day;
  const throughDay = days.at(-1)!.chunk_day;
  if ((Date.parse(throughDay) - Date.parse(fromDay)) / DAY_MS + 1 > MAX_TELEMETRY_V12_DOMAIN_DAYS) {
    throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  }
  const legacyFingerprint = await sha256Hex(canonicalJson({
    method: V12_DOMAIN_METHOD_VERSION,
    participantId: principal.participantId,
    inputRevision: state.input_revision,
    previousGenerationId: state.generation_id,
    previousManifestDigest: state.manifest_digest,
    manifests: days,
  }));
  const token = crypto.randomUUID();
  const tokenHash = await sha256Hex(token);
  const now = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + PREDECESSOR_TTL_MS).toISOString();
  const daysJson = canonicalTelemetryV12Json(days.map((manifest) => ({
    day: manifest.chunk_day,
    manifestId: manifest.id,
    manifestDigest: manifest.manifest_digest,
  })));
  try {
    const rows = await db.batch([
      db.prepare(
        `DELETE FROM telemetry_v12_domain_predecessors
          WHERE participant_id = ? AND device_id = ? AND consumed_at IS NULL
            AND (expires_at <= ? OR token_hash IN (
              SELECT x.token_hash FROM telemetry_v12_domain_predecessors x
               WHERE x.participant_id = ? AND x.device_id = ? AND x.consumed_at IS NULL
               ORDER BY x.created_at DESC, x.token_hash LIMIT -1 OFFSET 7
            ))
            AND NOT EXISTS (SELECT 1 FROM telemetry_v12_domains d WHERE d.predecessor_token_hash = token_hash)`,
      ).bind(principal.participantId, principal.deviceId, now,
        principal.participantId, principal.deviceId),
      db.prepare(
        `INSERT INTO telemetry_v12_domain_predecessors (
          token_hash, participant_id, device_id, previous_generation_id,
          legacy_fingerprint, input_revision, from_day, through_day, days_json,
          created_at, expires_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM community_analytical_input_versions v
            JOIN participants p ON p.id = v.participant_id AND p.state = 'active'
           WHERE v.participant_id = ? AND v.revision = ?)
            AND (SELECT generation_id FROM telemetry_v12_domain_heads
                  WHERE participant_id = ?) IS ?
            AND (SELECT count(*) FROM telemetry_v12_domain_predecessors x
                  WHERE x.participant_id = ? AND x.device_id = ?
                    AND x.consumed_at IS NULL AND x.expires_at > ?) < 8
          RETURNING token_hash`,
      ).bind(tokenHash, principal.participantId, principal.deviceId, state.generation_id,
        legacyFingerprint, state.input_revision, fromDay, throughDay, daysJson,
        now, expiresAt, principal.participantId, state.input_revision,
        principal.participantId, state.generation_id,
        principal.participantId, principal.deviceId, now),
    ]);
    if (rows[1]?.results.length !== 1) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  } catch (error) {
    throw domainError(error);
  }
  return {
    schemaVersion: "telemetry-domain-predecessor-v1.2",
    token,
    previousGenerationId: state.generation_id,
    legacyFingerprint,
    fromDay,
    throughDay,
    expiresAt,
  };
}

interface ActiveDomainRow {
  id: string;
  manifest_digest: string;
  from_day: string;
  through_day: string;
}

function activationResult(row: ActiveDomainRow, replay: boolean): TelemetryV12DomainActivation {
  return {
    schemaVersion: "telemetry-domain-activation-v1.2",
    generationId: row.id,
    manifestDigest: row.manifest_digest,
    fromDay: row.from_day,
    throughDay: row.through_day,
    replay,
  };
}

async function activeDomainByDigest(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  digest: string,
): Promise<ActiveDomainRow | null> {
  return db.prepare(
    `SELECT d.id, d.manifest_digest, d.from_day, d.through_day
       FROM telemetry_v12_domain_heads h
       JOIN telemetry_v12_domains d ON d.id = h.generation_id
      WHERE h.participant_id = ? AND d.device_id = ? AND d.manifest_digest = ?`,
  ).bind(principal.participantId, principal.deviceId, digest).first<ActiveDomainRow>();
}

export async function activateTelemetryV12Domain(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  value: unknown,
  nowEpoch = Date.now(),
): Promise<TelemetryV12DomainActivation> {
  let manifest: ReturnType<typeof parseTelemetryV12DomainManifest>;
  try {
    manifest = JSON.parse(canonicalTelemetryV12Json(parseTelemetryV12DomainManifest(value)));
  } catch {
    throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
  }
  if (await sha256Hex(telemetryV12DomainManifestDigestInput(manifest)) !== manifest.manifestDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  await assertTelemetryV12WriteAllowed(db, principal);
  const existing = await activeDomainByDigest(db, principal, manifest.manifestDigest);
  if (existing) return activationResult(existing, true);
  const tokenHash = await sha256Hex(manifest.predecessor.token);
  const now = new Date(nowEpoch).toISOString();
  const predecessor = await db.prepare(
    `SELECT input_revision, from_day, through_day, previous_generation_id
       FROM telemetry_v12_domain_predecessors
      WHERE token_hash = ? AND participant_id = ? AND device_id = ?
        AND consumed_at IS NULL AND expires_at > ?
        AND previous_generation_id IS ? AND legacy_fingerprint = ?`,
  ).bind(tokenHash, principal.participantId, principal.deviceId, now,
    manifest.predecessor.previousGenerationId, manifest.predecessor.legacyFingerprint)
    .first<{input_revision: number; from_day: string; through_day: string; previous_generation_id: string | null}>();
  if (!predecessor || manifest.fromDay > predecessor.from_day || manifest.throughDay < predecessor.through_day) {
    throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  const current = await stateStatement(db, principal.participantId).first<SourceState>();
  if (!validState(current) || current.input_revision !== predecessor.input_revision
      || current.generation_id !== predecessor.previous_generation_id) {
    throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  const daysJson = canonicalTelemetryV12Json(manifest.days);
  const days = JSON.stringify(manifest.days);
  const count = await db.prepare(
    `SELECT count(*) AS total
       FROM json_each(?) e
       JOIN telemetry_v12_day_manifests m
         ON m.id = json_extract(e.value, '$.manifestId')
        AND m.chunk_day = json_extract(e.value, '$.day')
        AND m.manifest_digest = json_extract(e.value, '$.manifestDigest')
      WHERE m.participant_id = ? AND m.device_id = ? AND m.state = 'ready'`,
  ).bind(days, principal.participantId, principal.deviceId).first<{total: number}>();
  if (!count || count.total !== manifest.days.length) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  const generationId = crypto.randomUUID();
  try {
    const result = await db.batch<{ generation_id?: string }>([
      db.prepare(
        `INSERT INTO telemetry_v12_domains (
          id, participant_id, device_id, predecessor_token_hash, previous_generation_id,
          manifest_digest, legacy_fingerprint, input_revision, from_day, through_day,
          days_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(generationId, principal.participantId, principal.deviceId, tokenHash,
        manifest.predecessor.previousGenerationId, manifest.manifestDigest,
        manifest.predecessor.legacyFingerprint, predecessor.input_revision,
        manifest.fromDay, manifest.throughDay, daysJson, now),
      db.prepare(
        `INSERT INTO telemetry_v12_domain_days (generation_id, observed_day, manifest_id, manifest_digest)
         SELECT ?, json_extract(e.value, '$.day'), json_extract(e.value, '$.manifestId'),
                json_extract(e.value, '$.manifestDigest') FROM json_each(?) e`,
      ).bind(generationId, days),
      db.prepare(
        `INSERT INTO telemetry_v12_domain_heads (participant_id, generation_id, revision, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(participant_id) DO UPDATE SET generation_id = excluded.generation_id,
           revision = telemetry_v12_domain_heads.revision + 1, updated_at = excluded.updated_at
         RETURNING generation_id`,
      ).bind(principal.participantId, generationId, now),
      db.prepare(
        `UPDATE telemetry_v12_domain_predecessors SET consumed_at = ?
          WHERE token_hash = ? AND participant_id = ? AND device_id = ? AND consumed_at IS NULL`,
      ).bind(now, tokenHash, principal.participantId, principal.deviceId),
    ]);
    if (result[2]?.results.length !== 1 || result[2].results[0]?.generation_id !== generationId) {
      throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
    }
  } catch (error) {
    const replay = await activeDomainByDigest(db, principal, manifest.manifestDigest);
    if (replay) return activationResult(replay, true);
    throw domainError(error);
  }
  return activationResult({
    id: generationId,
    manifest_digest: manifest.manifestDigest,
    from_day: manifest.fromDay,
    through_day: manifest.throughDay,
  }, false);
}
