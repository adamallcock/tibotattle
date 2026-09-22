import {
  canonicalTelemetryV12Json,
  parseTelemetryV12Chunk,
  parseTelemetryV12ChunkId,
  parseTelemetryV12DayManifest,
  parseTelemetryV12Record,
  telemetryV12DayManifestDigestInput,
  telemetryV12RecordAnchor,
  validateTelemetryV12DayUsageOrder,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  type TelemetryV12Chunk,
  type TelemetryV12DayManifest,
  type TelemetryV12Record,
  type TelemetryV12Stream,
  type TelemetryV12UsageEvent,
  MAX_TELEMETRY_V12_DAY_CHUNKS,
  MAX_TELEMETRY_V12_CHUNK_RECORDS,
} from "@app-usagemonitor/telemetry-contract";
import { sha256, sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  decodeTelemetryV12Record,
  encodeTelemetryV12Record,
  typedTelemetryV12DictionaryLookup,
  typedTelemetryV12Id,
  type TelemetryV12TypedAttribution,
  type TelemetryV12TypedRecordFields,
  type TelemetryV12TypedRecordRow,
} from "./telemetry-v12-typed-codec";
import {
  assertTelemetryV12WriteAllowed,
  type TelemetryTransportPrincipal,
} from "./telemetry-transport-policy";

export interface TelemetryV12DayCandidate {
  manifestId: string;
  day: string;
  manifestDigest: string;
  state: "staged" | "ready";
  expectedChunks: number;
}

interface ManifestRow {
  id: string;
  chunk_day: string;
  manifest_digest: string;
  expected_chunk_count: number;
  state: "staged" | "ready";
  manifest_json: string;
}

export interface TelemetryV12StagedChunkRow {
  id: string;
  manifest_id: string;
  participant_id: string;
  device_id: string;
  chunk_id: string;
  chunk_digest: string;
  record_count: number;
  r2_key: string;
  created_at: string;
}

function summary(row: ManifestRow): TelemetryV12DayCandidate {
  return {
    manifestId: row.id,
    day: row.chunk_day,
    manifestDigest: row.manifest_digest,
    state: row.state,
    expectedChunks: row.expected_chunk_count,
  };
}

function manifestSnapshot(value: unknown): TelemetryV12DayManifest {
  try {
    return JSON.parse(canonicalTelemetryV12Json(parseTelemetryV12DayManifest(value))) as TelemetryV12DayManifest;
  } catch {
    throw new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
  }
}

function mapStagingError(error: unknown): ApiError {
  const message = String(error);
  if (message.includes("telemetry_v12_transport_blocked")) {
    return new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  if (message.includes("telemetry_v12_manifest_invalid")) {
    return new ApiError(400, "TELEMETRY_MANIFEST_INVALID");
  }
  if (message.includes("telemetry_v12_manifest_incomplete")) {
    return new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  }
  if (message.includes("telemetry_v12_record_staging_denied")) {
    return new ApiError(409, "TELEMETRY_RECORD_INVALID");
  }
  if (message.includes("telemetry_v12_chunk_staging_denied")) {
    return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  if (message.includes("UNIQUE constraint failed: telemetry_v12_records")) {
    return new ApiError(409, "TELEMETRY_OCCURRENCE_CONFLICT");
  }
  if (message.includes("UNIQUE constraint failed: telemetry_v12")) {
    return new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  return error instanceof ApiError ? error : new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

async function manifestByDigest(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  day: string,
  digest: string,
): Promise<ManifestRow | null> {
  return db.prepare(
    `SELECT id, chunk_day, manifest_digest, expected_chunk_count, state, manifest_json
       FROM telemetry_v12_day_manifests
      WHERE participant_id = ? AND device_id = ? AND chunk_day = ? AND manifest_digest = ?`,
  ).bind(principal.participantId, principal.deviceId, day, digest).first<ManifestRow>();
}

export async function validateTelemetryV12StagedChunk(value: unknown): Promise<TelemetryV12Chunk> {
  let chunk: TelemetryV12Chunk;
  try {
    chunk = JSON.parse(canonicalTelemetryV12Json(parseTelemetryV12Chunk(value))) as TelemetryV12Chunk;
  } catch {
    throw new ApiError(400, "CHUNK_INVALID");
  }
  if (await sha256Hex(canonicalTelemetryV12Json(chunk.records)) !== chunk.chunkDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  return chunk;
}

export async function registerTelemetryV12DayManifest(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  value: unknown,
  nowEpoch = Date.now(),
): Promise<TelemetryV12DayCandidate> {
  const manifest = manifestSnapshot(value);
  const canonical = canonicalTelemetryV12Json(manifest);
  if (await sha256Hex(telemetryV12DayManifestDigestInput(manifest)) !== manifest.manifestDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  await assertTelemetryV12WriteAllowed(db, principal);
  const existing = await manifestByDigest(db, principal, manifest.day, manifest.manifestDigest);
  if (existing) {
    if (existing.manifest_json !== canonical) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
    return summary(existing);
  }
  const id = crypto.randomUUID();
  const now = new Date(nowEpoch).toISOString();
  try {
    await db.prepare(
      `INSERT INTO telemetry_v12_day_manifests (
        id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
        manifest_json, expected_chunk_count, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?)
      ON CONFLICT(participant_id, device_id, chunk_day, manifest_digest) DO NOTHING`,
    ).bind(id, principal.participantId, principal.deviceId, manifest.day, manifest.manifestDigest,
      manifest.parserVersion, canonical, manifest.chunks.length, now).run();
  } catch (error) {
    throw mapStagingError(error);
  }
  const stored = await manifestByDigest(db, principal, manifest.day, manifest.manifestDigest);
  if (!stored || stored.manifest_json !== canonical) throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  return summary(stored);
}

export async function existingTelemetryV12StagedChunk(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  chunk: TelemetryV12Chunk,
): Promise<TelemetryV12StagedChunkRow | null> {
  const { day } = parseTelemetryV12ChunkId(chunk.chunkId);
  return db.prepare(
    `SELECT c.id, c.manifest_id, c.participant_id, c.device_id, c.chunk_id,
            c.chunk_digest, c.record_count, c.r2_key, c.created_at
       FROM telemetry_v12_chunks c
       JOIN telemetry_v12_day_manifests m ON m.id = c.manifest_id
      WHERE m.participant_id = ? AND m.device_id = ? AND m.chunk_day = ?
        AND m.manifest_digest = ? AND c.chunk_id = ?`,
  ).bind(principal.participantId, principal.deviceId, day, chunk.manifestDigest, chunk.chunkId)
    .first<TelemetryV12StagedChunkRow>();
}

function bytes(value: ArrayBuffer): ArrayBuffer { return Uint8Array.from(new Uint8Array(value)).buffer; }

function sqlDictionary(value: string): string {
  return typedTelemetryV12DictionaryLookup(value).sql;
}

function sqlAttribution(attribution: TelemetryV12TypedAttribution): { sql: string; values: (string | number | ArrayBuffer)[] } {
  return {
    sql: `(SELECT id FROM telemetry_v12_attributions WHERE account_basis = ?
      AND account_track IS ? AND plan_basis = ? AND plan_type_id = ${sqlDictionary(attribution.planType)}
      AND plan_era IS ?)`,
    values: [attribution.accountBasis, bytes(attribution.accountTrack), attribution.planBasis,
      ...typedTelemetryV12DictionaryLookup(attribution.planType).values, bytes(attribution.planEra)],
  };
}

function rowId(chunkId: string, recordIndex: number): { sql: string; values: (string | number)[] } {
  return { sql: "(SELECT id FROM telemetry_v12_records WHERE chunk_id = ? AND record_index = ?)", values: [chunkId, recordIndex] };
}

function dictionaries(fields: TelemetryV12TypedRecordFields): string[] {
  const values = new Set<string>([fields.provider]);
  const usage = fields.usage;
  const quota = fields.quota;
  if (usage) {
    values.add(usage.model); values.add(usage.speedMode); values.add(usage.apiServiceTier);
    values.add(usage.surface); values.add(usage.billingSurface); values.add(usage.reasoningEffort);
    values.add(usage.agentScope); values.add(usage.outcome); values.add(usage.attribution.planType);
  }
  if (quota) {
    values.add(quota.planType); values.add(quota.planVariant); values.add(quota.limitId);
    values.add(quota.slot); values.add(quota.attribution.planType);
  }
  for (const key of Object.keys(fields.tools ?? {})) values.add(key);
  return [...values];
}

function typedRecordStatements(
  fields: TelemetryV12TypedRecordFields,
  chunkId: string,
  manifestId: string,
  recordIndex: number,
  prepare: (sql: string) => D1PreparedStatement,
): { statements: D1PreparedStatement[]; dictionaryValues: string[] } {
  const dictionaryValues = dictionaries(fields);
  const provider = sqlDictionary(fields.provider);
  const statements: D1PreparedStatement[] = [prepare(`INSERT INTO telemetry_v12_records (
    chunk_id, manifest_id, stream, record_index, occurrence_id, observed_at_ms, observed_day,
    provider_id, canonical_digest
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ${provider}, ?)`)
    .bind(chunkId, manifestId, fields.stream, recordIndex, bytes(fields.occurrenceId), fields.observedAtMs,
      fields.observedDay, ...typedTelemetryV12DictionaryLookup(fields.provider).values, bytes(fields.canonicalDigest))];
  const target = rowId(chunkId, recordIndex);
  if (fields.usage) {
    const u = fields.usage;
    const attr = sqlAttribution(u.attribution);
    statements.push(prepare(`INSERT INTO telemetry_v12_attributions (
      account_basis, account_track, plan_basis, plan_type_id, plan_era
    ) VALUES (?, ?, ?, ${sqlDictionary(u.attribution.planType)}, ?)
      ON CONFLICT(account_basis, account_track, plan_basis, plan_type_id, plan_era) DO NOTHING`)
      .bind(u.attribution.accountBasis, bytes(u.attribution.accountTrack), u.attribution.planBasis,
        ...typedTelemetryV12DictionaryLookup(u.attribution.planType).values, bytes(u.attribution.planEra)));
    statements.push(prepare(`INSERT INTO telemetry_v12_usage (
      record_id, session_id, model_id, speed_mode_id, api_service_tier_id, surface_id,
      billing_surface_id, reasoning_effort_id, agent_scope_id, outcome_id, attribution_id,
      total_input_context_tokens, input_uncached_tokens, input_cache_read_tokens,
      input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens,
      boundary_flags, tie_order, cache_write_ttl_five_minute_tokens, cache_write_ttl_one_hour_tokens
    ) VALUES (${target.sql}, ?, ${sqlDictionary(u.model)}, ${sqlDictionary(u.speedMode)},
      ${sqlDictionary(u.apiServiceTier)}, ${sqlDictionary(u.surface)}, ${sqlDictionary(u.billingSurface)},
      ${sqlDictionary(u.reasoningEffort)}, ${sqlDictionary(u.agentScope)}, ${sqlDictionary(u.outcome)},
      ${attr.sql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(...target.values, bytes(u.sessionId), ...typedTelemetryV12DictionaryLookup(u.model).values,
        ...typedTelemetryV12DictionaryLookup(u.speedMode).values, ...typedTelemetryV12DictionaryLookup(u.apiServiceTier).values,
        ...typedTelemetryV12DictionaryLookup(u.surface).values, ...typedTelemetryV12DictionaryLookup(u.billingSurface).values,
        ...typedTelemetryV12DictionaryLookup(u.reasoningEffort).values, ...typedTelemetryV12DictionaryLookup(u.agentScope).values,
        ...typedTelemetryV12DictionaryLookup(u.outcome).values, ...attr.values,
        u.totalInputContextTokens, u.inputUncachedTokens, u.inputCacheReadTokens, u.inputCacheWriteTokens,
        u.outputTextTokens, u.outputReasoningTokens, u.outputCombinedTokens, u.boundaryFlags, u.tieOrder,
        u.cacheWriteTtlFiveMinuteTokens, u.cacheWriteTtlOneHourTokens));
  } else if (fields.quota) {
    const q = fields.quota;
    const attr = sqlAttribution(q.attribution);
    statements.push(prepare(`INSERT INTO telemetry_v12_attributions (
      account_basis, account_track, plan_basis, plan_type_id, plan_era
    ) VALUES (?, ?, ?, ${sqlDictionary(q.attribution.planType)}, ?)
      ON CONFLICT(account_basis, account_track, plan_basis, plan_type_id, plan_era) DO NOTHING`)
      .bind(q.attribution.accountBasis, bytes(q.attribution.accountTrack), q.attribution.planBasis,
        ...typedTelemetryV12DictionaryLookup(q.attribution.planType).values, bytes(q.attribution.planEra)));
    statements.push(prepare(`INSERT INTO telemetry_v12_quota (
      record_id, plan_type_id, plan_variant_id, limit_id, slot_id, used_percent,
      window_duration_minutes, resets_at_ms, attribution_id
    ) VALUES (${target.sql}, ${sqlDictionary(q.planType)}, ${sqlDictionary(q.planVariant)},
      ${sqlDictionary(q.limitId)}, ${sqlDictionary(q.slot)}, ?, ?, ?, ${attr.sql})`)
      .bind(...target.values, ...typedTelemetryV12DictionaryLookup(q.planType).values,
        ...typedTelemetryV12DictionaryLookup(q.planVariant).values, ...typedTelemetryV12DictionaryLookup(q.limitId).values,
        ...typedTelemetryV12DictionaryLookup(q.slot).values, q.usedPercent, q.windowDurationMinutes, q.resetsAtMs,
        ...attr.values));
  } else if (fields.tools) {
    const entries = Object.entries(fields.tools);
    if (entries.length < 1) throw new ApiError(400, "CHUNK_INVALID");
    statements.push(prepare(`WITH target_record AS (SELECT ${target.sql} AS id), tools(tool, count) AS
      (VALUES ${entries.map(() => "(?, ?)").join(", ")})
      INSERT INTO telemetry_v12_session_tools(record_id, tool_class_id, count)
      SELECT target_record.id, dictionary.id, tools.count FROM target_record CROSS JOIN tools
      JOIN typed_telemetry_dictionary dictionary ON dictionary.value = tools.tool
      ON CONFLICT DO NOTHING`).bind(...target.values, ...entries.flatMap(([tool, count]) => [tool, count])));
  }
  return { statements, dictionaryValues };
}

async function validateWholeDayUsageOrder(
  db: D1Database,
  manifest: ManifestRow,
): Promise<void> {
  const rows = await db.prepare(
    `SELECT r.stream, r.record_index, r.occurrence_id, r.observed_at_ms, r.observed_day,
            r.provider_id, r.canonical_digest, provider.value AS provider,
            u.session_id, model.value AS model, speed.value AS speed_mode,
            tier.value AS api_service_tier, surface.value AS surface,
            billing.value AS billing_surface, effort.value AS reasoning_effort,
            scope.value AS agent_scope, outcome.value AS outcome,
            u.total_input_context_tokens, u.input_uncached_tokens,
            u.input_cache_read_tokens, u.input_cache_write_tokens,
            u.output_text_tokens, u.output_reasoning_tokens, u.output_combined_tokens,
            u.boundary_flags, u.tie_order,
            u.cache_write_ttl_five_minute_tokens, u.cache_write_ttl_one_hour_tokens,
            a.account_basis, a.account_track, a.plan_basis,
            plan.value AS attribution_plan_type, a.plan_era
       FROM telemetry_v12_records r
       JOIN telemetry_v12_chunks c ON c.id = r.chunk_id
       JOIN typed_telemetry_dictionary provider ON provider.id = r.provider_id
       LEFT JOIN telemetry_v12_usage u ON u.record_id = r.id
       LEFT JOIN typed_telemetry_dictionary model ON model.id = u.model_id
       LEFT JOIN typed_telemetry_dictionary speed ON speed.id = u.speed_mode_id
       LEFT JOIN typed_telemetry_dictionary tier ON tier.id = u.api_service_tier_id
       LEFT JOIN typed_telemetry_dictionary surface ON surface.id = u.surface_id
       LEFT JOIN typed_telemetry_dictionary billing ON billing.id = u.billing_surface_id
       LEFT JOIN typed_telemetry_dictionary effort ON effort.id = u.reasoning_effort_id
       LEFT JOIN typed_telemetry_dictionary scope ON scope.id = u.agent_scope_id
       LEFT JOIN typed_telemetry_dictionary outcome ON outcome.id = u.outcome_id
       LEFT JOIN telemetry_v12_attributions a ON a.id = u.attribution_id
       LEFT JOIN typed_telemetry_dictionary plan ON plan.id = a.plan_type_id
      WHERE r.manifest_id = ?
      ORDER BY c.stream, c.chunk_seq, r.record_index
      LIMIT ?`,
  ).bind(manifest.id, MAX_TELEMETRY_V12_DAY_CHUNKS * MAX_TELEMETRY_V12_CHUNK_RECORDS + 1)
    .all<TelemetryV12TypedRecordRow>();
  if (rows.results.length > MAX_TELEMETRY_V12_DAY_CHUNKS * MAX_TELEMETRY_V12_CHUNK_RECORDS) {
    throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  }
  const usage: TelemetryV12UsageEvent[] = [];
  try {
    for (const row of rows.results) {
      if (row.stream === "usage") {
        const decoded = decodeTelemetryV12Record(row);
        if (await sha256Hex(decoded.canonicalRecord) !== [...new Uint8Array(decoded.canonicalDigest)]
          .map((byte) => byte.toString(16).padStart(2, "0")).join("")) {
          throw new Error("telemetry_v12_digest_mismatch");
        }
        usage.push(JSON.parse(decoded.canonicalRecord) as TelemetryV12UsageEvent);
      }
    }
  } catch {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  try {
    validateTelemetryV12DayUsageOrder(manifest.chunk_day, usage);
  } catch {
    throw new ApiError(409, "TELEMETRY_RECORD_INVALID");
  }
}

async function markTelemetryV12ManifestReady(
  db: D1Database,
  manifest: ManifestRow,
  now: string,
): Promise<ManifestRow | null> {
  const counts = await db.prepare(
    `SELECT m.expected_chunk_count,
            count(DISTINCT c.id) AS chunks,
            COALESCE(sum(c.record_count), 0) AS declared_records,
            (SELECT count(*) FROM telemetry_v12_records r WHERE r.manifest_id = m.id) AS actual_records
       FROM telemetry_v12_day_manifests m
       LEFT JOIN telemetry_v12_chunks c ON c.manifest_id = m.id
      WHERE m.id = ? GROUP BY m.id`,
  ).bind(manifest.id).first<{expected_chunk_count: number; chunks: number; declared_records: number; actual_records: number}>();
  if (!counts || counts.chunks !== counts.expected_chunk_count || counts.declared_records !== counts.actual_records) {
    return manifest;
  }
  await validateWholeDayUsageOrder(db, manifest);
  try {
    await db.prepare(
      `UPDATE telemetry_v12_day_manifests SET state = 'ready', ready_at = ?
        WHERE id = ? AND state = 'staged'`,
    ).bind(now, manifest.id).run();
  } catch (error) {
    throw mapStagingError(error);
  }
  return { ...manifest, state: "ready", ready_at: now } as ManifestRow & { ready_at: string };
}

export async function persistTelemetryV12StagedChunk(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  value: unknown,
  metadata: {
    chunkRowId: string;
    r2Key: string;
    envelopeDigest: string;
    deviceUploadAuthorizationId: string;
  },
  nowEpoch = Date.now(),
): Promise<{ contributionId: string; manifestId: string; chunkId: string; replay: boolean }> {
  const chunk = await validateTelemetryV12StagedChunk(value);
  const { stream, day, seq } = parseTelemetryV12ChunkId(chunk.chunkId);
  await assertTelemetryV12WriteAllowed(db, principal);
  const manifest = await manifestByDigest(db, principal, day, chunk.manifestDigest);
  if (!manifest) throw new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE");
  let parsedManifest: TelemetryV12DayManifest;
  try { parsedManifest = parseTelemetryV12DayManifest(JSON.parse(manifest.manifest_json)); }
  catch { throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"); }
  if (canonicalTelemetryV12Json(parsedManifest.consent) !== canonicalTelemetryV12Json(chunk.consent)) {
    throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  }
  const existing = await existingTelemetryV12StagedChunk(db, principal, chunk);
  const now = new Date(nowEpoch).toISOString();
  if (existing) {
    if (existing.chunk_digest !== chunk.chunkDigest || existing.record_count !== chunk.records.length) {
      throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
    }
    await markTelemetryV12ManifestReady(db, manifest, now);
    return { contributionId: existing.id, manifestId: manifest.id, chunkId: chunk.chunkId, replay: true };
  }
  const typedRecords = await Promise.all(chunk.records.map((record) =>
    encodeTelemetryV12Record(stream, record, sha256)));
  const dictionaryValues = [...new Set(typedRecords.flatMap((fields) => dictionaries(fields)))];
  const statements: D1PreparedStatement[] = [db.prepare(
    `INSERT INTO telemetry_v12_chunks (
      id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq, chunk_id,
      chunk_digest, envelope_digest, parser_version, record_count, r2_key,
      device_upload_authorization_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(metadata.chunkRowId, manifest.id, principal.participantId, principal.deviceId, stream,
    day, seq, chunk.chunkId, chunk.chunkDigest, metadata.envelopeDigest, chunk.parserVersion,
    chunk.records.length, metadata.r2Key, metadata.deviceUploadAuthorizationId, now)];
  for (let offset = 0; offset < dictionaryValues.length; offset += 100) {
    const group = dictionaryValues.slice(offset, offset + 100);
    statements.push(db.prepare(
      `INSERT INTO typed_telemetry_dictionary(value) VALUES ${group.map(() => "(?)").join(", ")}
       ON CONFLICT(value) DO NOTHING`,
    ).bind(...group));
  }
  for (let recordIndex = 0; recordIndex < typedRecords.length; recordIndex += 1) {
    const fields = typedRecords[recordIndex];
    if (!fields) throw new ApiError(400, "CHUNK_INVALID");
    statements.push(...typedRecordStatements(fields, metadata.chunkRowId, manifest.id, recordIndex,
      (sql) => db.prepare(sql)).statements);
  }
  try {
    await db.batch(statements);
  } catch (error) {
    const replay = await existingTelemetryV12StagedChunk(db, principal, chunk);
    if (replay?.chunk_digest === chunk.chunkDigest && replay.record_count === chunk.records.length) {
      await markTelemetryV12ManifestReady(db, manifest, now);
      return { contributionId: replay.id, manifestId: manifest.id, chunkId: chunk.chunkId, replay: true };
    }
    throw mapStagingError(error);
  }
  await markTelemetryV12ManifestReady(db, manifest, now);
  return { contributionId: metadata.chunkRowId, manifestId: manifest.id, chunkId: chunk.chunkId, replay: false };
}

export async function readTelemetryV12DayCandidates(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  options: { fromDay: string; toDay: string; limit?: number },
): Promise<{ candidates: TelemetryV12DayCandidate[]; bounded: boolean }> {
  const limit = options.limit ?? 200;
  const start = Date.parse(`${options.fromDay}T00:00:00.000Z`);
  const end = Date.parse(`${options.toDay}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.fromDay) || !/^\d{4}-\d{2}-\d{2}$/u.test(options.toDay)
      || !Number.isFinite(start) || !Number.isFinite(end) || end < start
      || new Date(start).toISOString().slice(0, 10) !== options.fromDay
      || new Date(end).toISOString().slice(0, 10) !== options.toDay
      || end - start > 30 * 86_400_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  }
  const rows = await db.prepare(
    `SELECT id, chunk_day, manifest_digest, expected_chunk_count, state, manifest_json
       FROM telemetry_v12_day_manifests
      WHERE participant_id = ? AND device_id = ? AND chunk_day >= ? AND chunk_day <= ?
      ORDER BY chunk_day, created_at, id LIMIT ?`,
  ).bind(principal.participantId, principal.deviceId, options.fromDay, options.toDay, limit + 1).all<ManifestRow>();
  return { candidates: rows.results.slice(0, limit).map(summary), bounded: rows.results.length > limit };
}

export async function readTelemetryV12DayChunkVector(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  manifestId: string,
): Promise<{ chunkId: string; chunkDigest: string; recordCount: number }[]> {
  const rows = await db.prepare(
    `SELECT c.chunk_id, c.chunk_digest, c.record_count
       FROM telemetry_v12_chunks c JOIN telemetry_v12_day_manifests m ON m.id = c.manifest_id
      WHERE m.id = ? AND m.participant_id = ? AND m.device_id = ?
      ORDER BY c.stream, c.chunk_seq LIMIT ?`,
  ).bind(manifestId, principal.participantId, principal.deviceId, MAX_TELEMETRY_V12_DAY_CHUNKS + 1)
    .all<{ chunk_id: string; chunk_digest: string; record_count: number }>();
  if (rows.results.length > MAX_TELEMETRY_V12_DAY_CHUNKS) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return rows.results.map((row) => ({ chunkId: row.chunk_id, chunkDigest: row.chunk_digest, recordCount: row.record_count }));
}

export async function telemetryV12ChunkCount(
  db: D1Database,
  participantId: string,
): Promise<number> {
  try {
    const row = await db.prepare(
      "SELECT count(*) AS total FROM telemetry_v12_chunks WHERE participant_id = ?",
    ).bind(participantId).first<{ total: number }>();
    return row?.total ?? 0;
  } catch (error) {
    // Older databases have no successor migration. Their erasure path must
    // remain usable while the staged v1.2 schema is absent.
    if (String(error).includes("no such table: telemetry_v12_chunks")) return 0;
    throw error;
  }
}

export async function telemetryV12ChunkR2KeyPage(
  db: D1Database,
  participantId: string,
  cursor: { createdAt: string; chunkRowId: string } | null = null,
  limit = 100,
): Promise<{
  rows: Array<{ id: string; r2Key: string; createdAt: string }>;
  nextCursor: { createdAt: string; chunkRowId: string } | null;
}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  let result: { results: Array<{ id: string; r2_key: string; created_at: string }> };
  try {
    result = cursor
      ? await db.prepare(
        `SELECT id, r2_key, created_at
           FROM telemetry_v12_chunks
          WHERE participant_id = ?
            AND (created_at > ? OR (created_at = ? AND id > ?))
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      ).bind(participantId, cursor.createdAt, cursor.createdAt, cursor.chunkRowId, limit)
        .all<{ id: string; r2_key: string; created_at: string }>()
      : await db.prepare(
        `SELECT id, r2_key, created_at
           FROM telemetry_v12_chunks
          WHERE participant_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      ).bind(participantId, limit).all<{ id: string; r2_key: string; created_at: string }>();
  } catch (error) {
    if (String(error).includes("no such table: telemetry_v12_chunks")) {
      return { rows: [], nextCursor: null };
    }
    throw error;
  }
  const rows = result.results.map((row) => ({ id: row.id, r2Key: row.r2_key, createdAt: row.created_at }));
  const last = rows.at(-1);
  return {
    rows,
    nextCursor: last && rows.length === limit
      ? { createdAt: last.createdAt, chunkRowId: last.id }
      : null,
  };
}

// Restore and analytical readers consume the typed source rows through this
// facade. The wire JSON remains validation input only; decoding reconstructs
// a fresh validated record in memory and never reintroduces a JSON column.
export { decodeTelemetryV12Record };
export type {
  TelemetryV12TypedAttribution,
  TelemetryV12Blob,
  TelemetryV12TypedQuota,
  TelemetryV12TypedRecordFields,
  TelemetryV12TypedRecordRow,
  TelemetryV12TypedUsage,
} from "./telemetry-v12-typed-codec";
