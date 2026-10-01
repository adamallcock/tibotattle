/**
 * Id-free shape of the rows one v1.1 day admission writes (GCP fast path,
 * IN-2), computed the same way from a d43c8f92 D1 dump (the Q-1 oracle) and
 * from a PostgreSQL schema, so the two can be compared exactly.
 *
 * Every database-assigned id (typed ids, dictionary ids, chunk row ids,
 * manifest ids, device ids) and every clock value is replaced by what it
 * means: dictionary values, the owner's encoded original id, offsets inside
 * the chunk's source-row allocation, and the exact content bytes (hex). The
 * D1-only quota analysis_* columns are reported separately so a non-null
 * value cannot hide.
 *
 * Input: `tables` maps a table name to an array of row objects whose blobs
 * are lowercase hex strings. Test-only; never imported by product code.
 */

function rowsOf(tables, name) {
  const rows = tables[name];
  if (!Array.isArray(rows)) throw new Error("telemetry-v11-row-shape: missing table " + name);
  return rows;
}

function one(rows, label) {
  if (rows.length !== 1) throw new Error("telemetry-v11-row-shape: expected one " + label + ", found " + rows.length);
  return rows[0];
}

function byId(rows) {
  return new Map(rows.map((row) => [String(row.id), row]));
}

function num(value) {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error("telemetry-v11-row-shape: non-numeric value");
  return parsed;
}

const STREAM_NAMES = Object.freeze({ 1: "usage", 2: "quota", 3: "session" });

/**
 * Shape of one participant's admitted manifest for one day.
 * @param {Record<string, Record<string, unknown>[]>} tables
 * @param {{ participantId: string, day: string, ownerOriginalHex: string }} scope
 */
export function telemetryV11DayShape(tables, { participantId, day, ownerOriginalHex }) {
  const dictionary = new Map(rowsOf(tables, "typed_telemetry_dictionary").map((row) => [String(row.id), row.value]));
  const word = (id) => {
    if (id === null || id === undefined) return null;
    const value = dictionary.get(String(id));
    if (value === undefined) throw new Error("telemetry-v11-row-shape: dangling dictionary id");
    return value;
  };
  const owners = byId(rowsOf(tables, "typed_telemetry_owners"));
  const identifiers = byId(rowsOf(tables, "typed_telemetry_identifiers"));
  const attributions = byId(rowsOf(tables, "typed_telemetry_attributions"));
  const dimensions = byId(rowsOf(tables, "typed_telemetry_quota_dimensions"));
  const attribution = (id) => {
    if (id === null || id === undefined) return null;
    const row = attributions.get(String(id));
    if (!row) throw new Error("telemetry-v11-row-shape: dangling attribution id");
    return {
      owner: owners.get(String(row.owner_id))?.original_id ?? null,
      accountBasis: num(row.account_basis), accountTrack: row.account_track,
      planBasis: num(row.plan_basis), planType: word(row.plan_type_id), planEra: row.plan_era,
    };
  };

  const manifest = one(rowsOf(tables, "telemetry_v11_day_manifests")
    .filter((row) => row.participant_id === participantId && String(row.chunk_day).slice(0, 10) === day), "manifest");
  const chunks = rowsOf(tables, "telemetry_v11_chunks").filter((row) => row.manifest_id === manifest.id)
    .sort((left, right) => (left.chunk_id < right.chunk_id ? -1 : left.chunk_id > right.chunk_id ? 1 : 0));
  const typedChunks = rowsOf(tables, "typed_telemetry_chunks");
  const typedManifests = byId(rowsOf(tables, "typed_telemetry_manifests"));
  const records = rowsOf(tables, "typed_telemetry_records");
  const usage = new Map(rowsOf(tables, "typed_telemetry_usage").map((row) => [String(row.record_id), row]));
  const quota = new Map(rowsOf(tables, "typed_telemetry_quota").map((row) => [String(row.record_id), row]));
  const tools = rowsOf(tables, "typed_telemetry_session_tools");
  const proofs = new Map(rowsOf(tables, "typed_v11_record_proofs").map((row) => [String(row.typed_record_id), row]));
  const allocations = rowsOf(tables, "typed_v11_chunk_allocations");
  const memberships = rowsOf(tables, "typed_v11_manifest_memberships");

  const typedManifestIds = new Set(memberships.filter((row) => row.manifest_id === manifest.id)
    .map((row) => String(row.typed_manifest_id)));
  const typedManifest = one([...typedManifestIds].map((id) => typedManifests.get(id)).filter(Boolean), "typed manifest");

  return {
    manifest: {
      chunkDay: String(manifest.chunk_day).slice(0, 10),
      manifestDigest: manifest.manifest_digest,
      parserVersion: manifest.parser_version,
      manifestJson: manifest.manifest_json,
      expectedChunkCount: num(manifest.expected_chunk_count),
      state: manifest.state,
      typedManifest: {
        owner: owners.get(String(typedManifest.owner_id))?.original_id ?? null,
        chunkDay: num(typedManifest.chunk_day),
      },
    },
    ownerIsParticipant: [...owners.values()].some((row) => row.original_id === ownerOriginalHex),
    chunks: chunks.map((chunk) => {
      const allocation = one(allocations.filter((row) => row.chunk_id === chunk.id), "allocation");
      const typedChunk = one(typedChunks.filter((row) => row.original_id === allocation.chunk_original
        && String(row.namespace_id) === String(allocation.namespace_id) && num(row.format) === 11), "typed chunk");
      const first = num(allocation.first_source_row_id);
      const chunkRecords = records.filter((row) => String(row.chunk_id) === String(typedChunk.id))
        .sort((left, right) => num(left.source_row_id) - num(right.source_row_id));
      return {
        chunkId: chunk.chunk_id,
        stream: chunk.stream,
        chunkDay: String(chunk.chunk_day).slice(0, 10),
        chunkSeq: num(chunk.chunk_seq),
        chunkDigest: chunk.chunk_digest,
        parserVersion: chunk.parser_version,
        recordCount: num(chunk.record_count),
        allocation: { recordCount: num(allocation.record_count) },
        typedChunk: {
          format: num(typedChunk.format), stream: STREAM_NAMES[num(typedChunk.stream)], chunkDay: num(typedChunk.chunk_day),
          owner: owners.get(String(typedChunk.owner_id))?.original_id ?? null,
          manifestIsMember: typedManifestIds.has(String(typedChunk.manifest_id)),
        },
        records: chunkRecords.map((record) => {
          const id = String(record.id);
          const usageRow = usage.get(id);
          const quotaRow = quota.get(id);
          const dimension = quotaRow ? dimensions.get(String(quotaRow.dimensions_id)) : null;
          const proof = proofs.get(id);
          const recordTools = tools.filter((row) => String(row.record_id) === id)
            .map((row) => [word(row.tool_class_id), num(row.count)])
            .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
          return {
            offset: num(record.source_row_id) - first,
            format: num(record.format),
            stream: STREAM_NAMES[num(record.stream)],
            owner: owners.get(String(record.owner_id))?.original_id ?? null,
            occurrence: record.occurrence_id,
            observedAtMs: num(record.observed_at_ms),
            observedDay: num(record.observed_day),
            provider: word(record.provider_id),
            canonicalDigest: record.canonical_digest,
            usage: usageRow ? {
              session: identifiers.get(String(usageRow.session_id))?.value ?? null,
              model: word(usageRow.model_id), speedMode: word(usageRow.speed_mode_id),
              apiServiceTier: word(usageRow.api_service_tier_id), surface: word(usageRow.surface_id),
              billingSurface: word(usageRow.billing_surface_id), reasoningEffort: word(usageRow.reasoning_effort_id),
              agentScope: word(usageRow.agent_scope_id), outcome: word(usageRow.outcome_id),
              attribution: attribution(usageRow.attribution_id),
              tokens: [usageRow.total_input_context_tokens, usageRow.input_uncached_tokens,
                usageRow.input_cache_read_tokens, usageRow.input_cache_write_tokens, usageRow.output_text_tokens,
                usageRow.output_reasoning_tokens, usageRow.output_combined_tokens].map(num),
            } : null,
            quota: quotaRow ? {
              planType: word(dimension?.plan_type_id), planVariant: word(dimension?.plan_variant_id),
              attribution: attribution(dimension?.attribution_id),
              limit: word(quotaRow.limit_id), slot: word(quotaRow.slot_id),
              usedPercent: num(quotaRow.used_percent), windowDurationMinutes: num(quotaRow.window_duration_minutes),
              resetsAtMs: num(quotaRow.resets_at_ms),
              analysis: [quotaRow.analysis_owner_id ?? null, quotaRow.analysis_observed_at_ms ?? null,
                quotaRow.analysis_source_row_id ?? null],
            } : null,
            tools: recordTools.length ? recordTools : null,
            proof: proof ? {
              stream: STREAM_NAMES[num(proof.stream_code)],
              occurrence: proof.occurrence_blob,
              baseDigest: proof.base_digest,
              legacyOccurrence: proof.legacy_occurrence_blob ?? null,
              legacyDigest: proof.legacy_digest ?? null,
              observedAtMs: num(proof.observed_at_ms),
              keyedToRecordChunk: String(proof.chunk_key) === String(typedChunk.id),
              keyedToTypedManifest: typedManifestIds.has(String(proof.manifest_key)),
            } : null,
          };
        }),
      };
    }),
  };
}

/** Normalize one D1 dump table ({columns, rows}) to row objects with hex blobs. */
export function d1DumpRows(table) {
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
    throw new Error("telemetry-v11-row-shape: invalid dump table");
  }
  return table.rows.map((values) => Object.fromEntries(table.columns.map((column, index) => {
    const value = values[index];
    return [column, value !== null && typeof value === "object" && typeof value.$blob === "string"
      ? value.$blob.toLowerCase() : value];
  })));
}

/** The tables telemetryV11DayShape reads. */
export const TELEMETRY_V11_SHAPE_TABLES = Object.freeze([
  "typed_telemetry_dictionary", "typed_telemetry_owners", "typed_telemetry_identifiers",
  "typed_telemetry_attributions", "typed_telemetry_quota_dimensions", "telemetry_v11_day_manifests",
  "telemetry_v11_chunks", "typed_telemetry_chunks", "typed_telemetry_manifests", "typed_telemetry_records",
  "typed_telemetry_usage", "typed_telemetry_quota", "typed_telemetry_session_tools",
  "typed_v11_record_proofs", "typed_v11_chunk_allocations", "typed_v11_manifest_memberships",
]);
