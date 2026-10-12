// Synthetic, content-free scale fixture for domain activation cost evidence.
// Every record is generated here; nothing is read from a real session. Days
// are staged through the reviewed admission entrypoints (no direct writes to
// guarded typed storage), so activations exercise production SQL unchanged.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  canonicalTelemetryV11Json, canonicalTelemetryV12Json, telemetryV11DayManifestDigestInput,
  telemetryV11DomainManifestDigestInput, telemetryV11RequiredConsent, telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput, telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";

export const SCALE_SOURCE_ID = "synthetic-classification-scale-source";
export const SCALE_NAMESPACE = "synthetic-classification-scale-legacy";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
const q = (schema, name) => `"${schema}"."${name}"`;
const hex64 = (seed) => sha256Hex(`classification-scale:${seed}`);
const recordStream = (record) => record.schemaVersion.split("-")[0] === "usage" ? "usage"
  : record.schemaVersion.split("-")[0] === "quota" ? "quota" : "session";

export function scaleDays(count, firstDay = "2026-06-01") {
  return Array.from({ length: count }, (_, index) =>
    new Date(Date.parse(`${firstDay}T00:00:00.000Z`) + index * DAY_MS).toISOString().slice(0, 10));
}

/** One deterministic synthetic usage record; `known` labels the classification. */
export function scaleUsage(format, day, index, { provider = "unknown", modelId = "unknown", session = 0, tokens = 1000 } = {}) {
  const base = {
    eventId: `event:v2:${hex64(`event:${day}:${index}`)}`,
    eventTime: new Date(Date.parse(`${day}T00:00:00.000Z`) + (index % 86_000) * 1000).toISOString(),
    sessionUuid: sessionUuid(session),
    provider, modelId, speedMode: "standard", apiServiceTier: "default",
    surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription",
    reasoningEffort: "high", agentScope: "root", outcome: "completed", totalInputContextTokens: tokens,
    accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "promax", planEraId: null },
  };
  if (format === 11) {
    return { schemaVersion: "usage-event-v1.1", ...base, components: { inputUncachedTokens: 100,
      inputCacheReadTokens: tokens - 100, inputCacheWriteTokens: null, outputTextTokens: 50,
      outputReasoningTokens: 25, outputCombinedTokens: null } };
  }
  return { schemaVersion: "usage-event-v1.2", ...base, components: { inputUncachedTokens: 100,
    inputCacheReadTokens: tokens - 100, inputCacheWriteTokens: 0, outputTextTokens: 50,
    outputReasoningTokens: 25, outputCombinedTokens: null },
  boundaryFlags: 1, tieOrder: 0, cacheWriteTtl: { fiveMinuteTokens: 0, oneHourTokens: 0 } };
}
export function sessionUuid(index) {
  const digits = String(index + 1).padStart(12, "0");
  return `00000000-0000-4000-8000-${digits}`;
}
export function scaleSession(format, day, index, provider = "unknown") {
  return { schemaVersion: format === 11 ? "session-dimension-v1.1" : "session-dimension-v1.2",
    sessionUuid: sessionUuid(index), firstEventTime: `${day}T00:00:00.000Z`, provider,
    toolClassCounts: { shell: 2, browser: 1 } };
}

export async function seedScaleParticipant(pool, schema, label) {
  const table = (name) => q(schema, name);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 30 * 24 * HOUR_MS).toISOString();
  const participantId = `synthetic-scale-${label}-${randomUUID()}`;
  const sessionId = `${participantId}-session`;
  const ownerDigest = randomBytes(32).toString("hex");
  await pool.query(`INSERT INTO ${table("participants")}(id, owner_kind, state, consent_version, created_at)
    VALUES ($1,'social','active','privacy-safe-telemetry-v0.1',$2)`, [participantId, now]);
  await pool.query(`INSERT INTO ${table("web_sessions")}(
    id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [sessionId, participantId, randomBytes(32), randomBytes(32), now, expires]);
  await pool.query(`INSERT INTO ${table("storage_v11_owner_links")}(participant_id, owner_digest, state)
    VALUES ($1,$2,'active')`, [participantId, ownerDigest]);
  await pool.query(`INSERT INTO ${table("analytics_owner_state")}(
    source_id, owner_digest, revision, authority_epoch, state) VALUES ($1,$2,1,1,'active')`,
  [SCALE_SOURCE_ID, ownerDigest]);
  return { participantId, sessionId, ownerDigest, now, expires };
}

export async function seedScaleDevice(pool, schema, participant, label, { v12 = true } = {}) {
  const table = (name) => q(schema, name);
  const deviceId = `synthetic-scale-device-${label}-${randomUUID()}`;
  const pairingId = `synthetic-scale-pairing-${randomUUID()}`;
  const { participantId, sessionId, now, expires } = participant;
  await pool.query(`INSERT INTO ${table("device_pairings")}(
    id, participant_id, issued_by_session_id, secret_hash, consent_version,
    transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
  ) VALUES ($1,$2,$3,$4,'synthetic-consent-v1','synthetic-transport-v1','consumed',$5,$6,$5,$7)`,
  [pairingId, participantId, sessionId, randomBytes(32), now, expires, deviceId]);
  await pool.query(`INSERT INTO ${table("device_credentials")}(
    id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
    state, issued_at, expires_at, last_used_at, social_verified_at
  ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`, [deviceId, participantId, pairingId, randomBytes(32), now, expires]);
  if (v12) await enableScaleV12(pool, schema, { participantId, deviceId });
  return { participantId, deviceId };
}
export async function enableScaleV12(pool, schema, principal) {
  await pool.query(`INSERT INTO ${q(schema, "telemetry_v12_device_capabilities")}(
    participant_id,device_id,telemetry_schema_version,field_dictionary_version,privacy_contract_version,state,consented_at)
    VALUES ($1,$2,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
      'ongoing-privacy-safe-telemetry-v1.2','accepted',clock_timestamp())`, [principal.participantId, principal.deviceId]);
}

/** Apply the runtime rows every activation requires on a fresh schema. */
export async function prepareScaleSchema(pool, schema, correctionSourceState = "staged") {
  const table = (name) => q(schema, name);
  const now = new Date().toISOString();
  for (const name of ["telemetry_v12_runtime", "telemetry_v12_typed_runtime"]) {
    await pool.query(`UPDATE ${table(name)} SET state='active', changed_at=$1 WHERE id=1`, [now]);
  }
  await pool.query(`INSERT INTO ${table("storage_source_state")}(singleton,source_id,authority_epoch) VALUES (1,$1,0)`, [SCALE_SOURCE_ID]);
  await pool.query(`INSERT INTO ${table("telemetry_usage_correction_runtime")}(
    id,schema_version,method_version,source_state,max_capture_rows,max_history_page)
    VALUES (1,'telemetry-usage-correction-v1','usage-total-correction-v1',$1,200,200)`, [correctionSourceState]);
}

// ---- v1.2 -------------------------------------------------------------------
async function v12Authorization(pool, schema, principal, chunkRowId, r2Key, nowEpoch) {
  const envelopeDigest = randomBytes(32).toString("hex");
  const authorizationId = `synthetic-scale-auth-${randomUUID()}`;
  const now = new Date(nowEpoch).toISOString();
  const expires = new Date(nowEpoch + 10 * 60_000).toISOString();
  await pool.query(`INSERT INTO ${q(schema, "device_upload_authorizations")}(
    id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,content_type,
    state,issued_at,expires_at,consume_lease_expires_at
  ) VALUES ($1,$2,$3,$4,$5,4096,'application/json','consuming',$6,$7,$7)`,
  [authorizationId, principal.participantId, principal.deviceId, randomBytes(32), envelopeDigest, now, expires]);
  await pool.query(`INSERT INTO ${q(schema, "pending_objects")}(contribution_id,object_key,object_kind)
    VALUES ($1,$2,'telemetry_v12')`, [chunkRowId, r2Key]);
  return { envelopeDigest, authorizationId };
}

/** Stage one READY v1.2 day of `records` (any streams) in 200-record chunks. */
export async function stageScaleV12Day(modules, pool, schema, options, principal, day, records,
  { parserVersion = "synthetic-scale-pg17" } = {}) {
  const consent = telemetryV12RequiredConsent();
  const byStream = { quota: [], session: [], usage: [] };
  for (const record of records) byStream[recordStream(record)].push(record);
  const chunks = [];
  for (const stream of ["quota", "session", "usage"]) {
    for (let offset = 0; offset < byStream[stream].length; offset += 200) {
      const slice = byStream[stream].slice(offset, offset + 200);
      chunks.push({ schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
        chunkId: `${stream}:${day}:${offset / 200}`, chunkRevision: 1, parserVersion,
        consent, records: slice, chunkDigest: sha256Hex(canonicalTelemetryV12Json(slice)) });
    }
  }
  const manifest = { schemaVersion: "telemetry-day-manifest-v1.2", day, parserVersion, consent,
    chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length })),
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  const nowEpoch = Date.now();
  const candidate = await modules.registerPostgresTypedV12DayManifest(pool, principal, manifest, nowEpoch, options);
  for (const chunk of chunks) {
    chunk.manifestDigest = manifest.manifestDigest;
    const chunkRowId = `chunk:${randomUUID()}`;
    const r2Key = `synthetic/classification-scale/${randomUUID()}`;
    const { envelopeDigest, authorizationId } = await v12Authorization(pool, schema, principal, chunkRowId, r2Key, nowEpoch);
    await modules.persistPostgresTypedV12StagedChunk(pool, principal, chunk,
      { chunkRowId, r2Key, envelopeDigest, deviceUploadAuthorizationId: authorizationId }, nowEpoch, options);
  }
  const ready = (await pool.query(`SELECT state FROM ${q(schema, "telemetry_v12_day_manifests")} WHERE id=$1`,
    [candidate.manifestId])).rows[0];
  if (ready?.state !== "ready") throw new Error("SCALE_V12_DAY_NOT_READY");
  return { day, manifestId: candidate.manifestId, manifestDigest: candidate.manifestDigest };
}

export function scaleV12DomainManifest(predecessor, days) {
  const ordered = [...days].sort((left, right) => left.day.localeCompare(right.day));
  const manifest = { schemaVersion: "telemetry-domain-manifest-v1.2", fromDay: ordered[0].day,
    throughDay: ordered.at(-1).day, predecessor: { token: predecessor.token,
      previousGenerationId: predecessor.previousGenerationId, legacyFingerprint: predecessor.legacyFingerprint },
    days: ordered.map(({ day, manifestId, manifestDigest }) => ({ day, manifestId, manifestDigest })),
    manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = sha256Hex(telemetryV12DomainManifestDigestInput(manifest));
  return manifest;
}

// ---- v1.1 -------------------------------------------------------------------
function uploadSecretHash(id, secret) {
  return createHash("sha256").update(`app-usagemonitor/device-upload/v1\0${id}\0${secret}`).digest();
}

/** Initialize live typed v1.1 admission (and qualified typed v1 state) once per schema. */
export async function initializeScaleV11(modules, pool, schema, options) {
  await pool.query(`UPDATE ${q(schema, "telemetry_transport_formats")} SET lifecycle='accepted'
    WHERE schema_version='telemetry-contribution-v1.1'`);
  await modules.live.initializePostgresTypedV11Admission(pool, options);
  await pool.query(`INSERT INTO ${q(schema, "typed_v1_admission_state")}(
    id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
    SELECT 1,source_namespace,namespace_id,1,1 FROM ${q(schema, "typed_v11_admission_state")} WHERE id=1`);
}
export async function grantScaleV11(modules, pool, participant, principal, options) {
  await modules.live.grantPostgresTelemetryV11Consent(pool, { ...principal, sessionId: participant.sessionId },
    telemetryV11RequiredConsent(), Date.now(), options);
}

export function makeScaleV11Day(day, records, parserVersion = "synthetic-scale-v11") {
  const consent = telemetryV11RequiredConsent();
  const byStream = { quota: [], session: [], usage: [] };
  for (const record of records) byStream[recordStream(record)].push(record);
  const chunks = [];
  for (const stream of ["quota", "session", "usage"]) {
    for (let offset = 0; offset < byStream[stream].length; offset += 200) {
      const slice = byStream[stream].slice(offset, offset + 200);
      chunks.push({ schemaVersion: "telemetry-contribution-v1.1", manifestDigest: "0".repeat(64),
        chunkId: `${stream}:${day}:${offset / 200}`, chunkRevision: 1,
        chunkDigest: sha256Hex(canonicalTelemetryV11Json(slice)), parserVersion, consent, records: slice });
    }
  }
  const manifest = { schemaVersion: "telemetry-day-manifest-v1.1", day, parserVersion, consent,
    chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length })),
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = sha256Hex(telemetryV11DayManifestDigestInput(manifest));
  for (const chunk of chunks) chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunks };
}

async function persistScaleV11Chunk(modules, pool, schema, principal, chunk, options) {
  const authorizationId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const envelopeDigest = randomBytes(32).toString("hex");
  await pool.query(`INSERT INTO ${q(schema, "device_upload_authorizations")} (
       id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
       body_bytes, content_type, state, issued_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, 256, 'application/json', 'unused', $6, $7)`,
  [authorizationId, principal.participantId, principal.deviceId, uploadSecretHash(authorizationId, secret), envelopeDigest,
    new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() + 5 * 60_000).toISOString()]);
  const claimed = await modules.transport.claimPostgresDeviceUploadAuthorization(pool,
    `Upload um_device_upload_${authorizationId}.${secret}`,
    { envelopeDigest, bodyBytes: 256, contentType: "application/json" },
    { schema: options.schema, accountlessAuthorizationVersion: "v1.1" });
  const chunkRowId = `chunk:${randomUUID()}`;
  const objectKey = `telemetry/v11-${randomUUID()}`;
  await modules.live.registerPostgresTelemetryV11PendingObject(pool, chunkRowId, objectKey, Date.now(), options);
  return modules.live.persistPostgresTypedV11StagedChunk(pool, principal, chunk, {
    chunkRowId, r2Key: objectKey, envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId,
  }, Date.now(), options);
}

export async function stageScaleV11Day(modules, pool, schema, options, principal, day, records) {
  const prepared = makeScaleV11Day(day, records);
  await modules.live.registerPostgresTelemetryV11DayManifest(pool, principal, prepared.manifest, Date.now(), options);
  for (const chunk of prepared.chunks) await persistScaleV11Chunk(modules, pool, schema, principal, chunk, options);
  const ready = await modules.live.registerPostgresTelemetryV11DayManifest(pool, principal, prepared.manifest, Date.now(), options);
  if (ready.state !== "ready") throw new Error("SCALE_V11_DAY_NOT_READY");
  return { day: ready.day, manifestId: ready.manifestId, manifestDigest: ready.manifestDigest };
}

export function scaleV11DomainManifest(predecessor, days) {
  const ordered = [...days].sort((left, right) => left.day.localeCompare(right.day));
  const value = { schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: ordered[0].day, throughDay: ordered.at(-1).day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: ordered.map((entry) => ({ day: entry.day, manifestId: entry.manifestId, manifestDigest: entry.manifestDigest })),
    manifestDigest: "0".repeat(64) };
  value.manifestDigest = sha256Hex(telemetryV11DomainManifestDigestInput(value));
  return value;
}

/** Wrap a pool so every statement's family and server-observed duration is recorded (no SQL or values kept). */
export function statementTimer(pool) {
  const entries = [];
  let active = false;
  pool.on("connect", (client) => {
    const query = client.query.bind(client);
    client.query = (...args) => {
      const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
      const started = process.hrtime.bigint();
      const result = query(...args);
      if (!active || !result?.then) return result;
      return result.then((value) => {
        entries.push({ family: statementFamily(text), ms: Number(process.hrtime.bigint() - started) / 1e6, text,
          values: Array.isArray(args[1]) ? args[1] : [] });
        return value;
      }, (error) => {
        entries.push({ family: statementFamily(text), ms: Number(process.hrtime.bigint() - started) / 1e6, text, error: error.code ?? "error" });
        throw error;
      });
    };
  });
  return {
    start() { entries.length = 0; active = true; },
    stop() { active = false; return entries.splice(0); },
  };
}

/** Closed statement families; anything else is "other". */
export function statementFamily(text) {
  const rules = [
    [/^CREATE TEMP TABLE pg_temp\."classification_rekey_twins"/u, () => "proof:rekeyed"],
    [/^CREATE TEMP TABLE\s+(\S+)/u, (m) => `temp:${m[1]}`],
    [/^CREATE INDEX\s+ON\s+(\S+)/u, (m) => `temp_index:${m[1]}`],
    [/^ANALYZE\s+(\S+)/u, (m) => `temp_analyze:${m[1]}`],
    [/FROM pg_temp\."classification_rekey_twins" twin/u, () => "proof:rekeyed_history"],
    [/candidate AS MATERIALIZED[\s\S]*original AS MATERIALIZED/u, () => "proof:session_closure"],
    [/old_source\.source_device_id<>\$3/u, () => "proof:foreign"],
    [/candidate AS MATERIALIZED[\s\S]*old_source AS MATERIALIZED/u, () => "proof:exact"],
    [/FROM \S+\."telemetry_v1_records" old_row/u, () => "closure:legacy_gap"],
    [/FROM \S+\."telemetry_v12_typed_records" old_record/u, () => "closure:v12_same_day"],
    [/SELECT DISTINCT after_record_id AS id/u, () => "proof:session_links"],
    [/FROM \S+\."telemetry_v11_domain_days" previous_day/u, () => "closure:previous_gap"],
    [/typed_v1_record_admissions" p ON p\.chunk_id = c\.id/u, () => "closure:typed_v1_uncovered"],
    [/GROUP BY admission\.stream, admission\.occurrence_id/u, () => "closure:duplicate"],
    [/FOR SHARE OF manifest/u, () => "closure:ready"],
    [/telemetry_classification_correction_links/u, () => "proof:links"],
    [/^INSERT INTO/u, () => "write"],
    [/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u, () => "control"],
  ];
  for (const [pattern, name] of rules) { const match = pattern.exec(text); if (match) return name(match); }
  return "other";
}
export function summarize(entries) {
  const families = new Map();
  for (const entry of entries) {
    const current = families.get(entry.family) ?? { calls: 0, totalMs: 0, maxMs: 0 };
    current.calls += 1; current.totalMs += entry.ms; current.maxMs = Math.max(current.maxMs, entry.ms);
    families.set(entry.family, current);
  }
  return Object.fromEntries([...families].sort((a, b) => b[1].maxMs - a[1].maxMs)
    .map(([family, value]) => [family, { calls: value.calls, totalMs: Math.round(value.totalMs), maxMs: Math.round(value.maxMs) }]));
}
export { DAY_MS, q as scaleTable };
