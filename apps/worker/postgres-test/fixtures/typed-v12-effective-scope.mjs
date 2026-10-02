/**
 * Content-free fixture for the PostgreSQL v1.2 effective reader's selection
 * (src/postgres-typed-v12-effective-reader.ts).
 *
 * It writes the typed v1.2 source tables of one migrated schema directly,
 * through the live guards of the primary migration chain, and holds every
 * filter of the reader's selection to a record that only that filter
 * excludes. Every identifier is opaque and derived from a fixed seed (no
 * paths, prompts, session content, account identifiers or credentials);
 * every secret hash is a digest of a constant label.
 *
 * papa (social, retained): the current head generation on device papa-head
 *   D1 ready: usage chunk 0 (complete), usage chunk 1 (declares one record
 *      more than it holds: INCOMPLETE), usage chunk 2 (complete; its record
 *      indexes repeat chunk 0's), quota (complete, two id encodings at one
 *      instant) and session (complete);
 *   D2 staged (never ready): STAGED;
 *   D3 ready: MULTI's second variant and LATE (usage, complete) and a quota
 *      chunk that is incomplete (QUOTA_INCOMPLETE, the day's only quota).
 * papa's earlier generation on device papa-old is not the head:
 *   D1 ready: OLD_ONLY and an earlier variant of SHARED; D4 ready: OLD_D4.
 * quebec (social, retained, head): D0 ready, QUEBEC_D0; D1 ready, an earlier
 *   variant of A and QUEBEC_ONLY.
 * romeo (social, head, owner link withdrawn, so no retained authorization):
 *   D1 ready, ROMEO_ONLY.
 *
 * tango (social, retained) holds one record for each remaining predicate of
 * the selection, each on its own ready day of the head generation (device
 * tango-head) and excluded by that predicate alone. Only CONTROL (E[0]) is
 * selected:
 *   E[1] DIGEST: the domain day's manifest digest differs from the manifest's;
 *   E[2] DAY_SHIFT: the domain day is moved to E[14], its manifest stays on E[2];
 *   E[3] MANIFEST_DEVICE: the manifest, and its chunk, are device tango-other's;
 *   E[4] MANIFEST_PARTICIPANT: the manifest, and its chunk, are uniform's;
 *   E[5] CHUNK_PARTICIPANT: the chunk alone is uniform's;
 *   E[6] CHUNK_DEVICE: the chunk alone is tango-other's;
 *   E[7] CHUNK_DAY: the chunk alone is dated E[15];
 *   E[8] USAGE_IN_QUOTA_CHUNK: a usage record in a chunk marked quota;
 *   E[9] QUOTA_IN_USAGE_CHUNK: a quota record in a chunk marked usage;
 *   E[10] FOREIGN_CHUNK: the record's chunk names tango's loose staged manifest;
 *   E[11] FOREIGN_RECORD: the record names that manifest, its chunk does not;
 *   E[12] HEADED_ELSEWHERE: tango's earlier generation on the same device,
 *     which participant uniform's head row names.
 * sierra (social, retained): the head generation is on device sierra-head,
 *   which has no retained authorization while sierra-other has one:
 *   E[13] SIERRA_ONLY.
 * uniform (social, active owner link) has no device or generation of its own.
 *
 * victor (social, retained, head) holds stored ids the codec never writes,
 * one kind per day, each beside canonical records:
 *   V[0] the raw spelling (tag 0) of NC_ID, later than NC_ID;
 *   V[1] the raw spelling of TIE_ID at TIE_ID's instant, after it in record
 *     order (TIE_FIRST precedes both);
 *   V[2] an id with an unknown tag (no codec text) at NO_TEXT_ID's instant;
 *   V[3] an id that is not UTF-8 under the raw tag, after UTF8_ID.
 *
 * The ready-integrity guard (0028) forbids a ready manifest with an
 * incomplete chunk, so that one manifest is made ready with the statement's
 * triggers bypassed; the reader's own completeness check is what is tested.
 * Every tango, sierra and victor anomaly is likewise written after its
 * generation is built through the live guards, by direct writes with the
 * triggers (foreign keys included) bypassed.
 */
import { createHash } from "node:crypto";

export const D0 = "2026-09-27";
export const D1 = "2026-09-28";
export const D2 = "2026-09-29";
export const D3 = "2026-09-30";
export const D4 = "2026-10-01";
export const D5 = "2026-10-02";
/** tango's and sierra's days: E[0] to E[13] hold records; E[14] and E[15] are anomaly targets. */
export const E = Object.freeze(Array.from({ length: 16 }, (_, index) =>
  new Date(Date.parse("2026-10-05T00:00:00.000Z") + index * 86_400_000).toISOString().slice(0, 10)));
/** victor's days, one stored-id defect each. */
export const V = Object.freeze(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"]);
const ISSUED = "2026-09-01T00:00:00.000Z";
const EXPIRES = "2099-01-01T00:00:00.000Z";
const PROVIDER = "openai_codex";

const digest = (seed) => createHash("sha256").update(`typed-v12-effective-scope:${seed}`).digest("hex");
const blob = (seed) => Buffer.from(digest(seed), "hex");
const uuid = (seed) => {
  const hex = digest(`uuid:${seed}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const at = (day, time) => `${day}T${time}Z`;
const event = (name) => `event:v2:${digest(`occurrence:${name}`)}`;

/** Opaque occurrence ids by role. */
export const IDS = Object.freeze({
  A: event("a"),
  B: event("b"),
  C: event("c"),
  D: event("d"),
  E: event("e"),
  SHARED: event("shared"),
  MULTI: event("multi"),
  LATE: event("late"),
  INCOMPLETE: event("incomplete"),
  STAGED: event("staged"),
  OLD_ONLY: event("old-only"),
  OLD_D4: event("old-d4"),
  QUEBEC_ONLY: event("quebec-only"),
  QUEBEC_D0: event("quebec-d0"),
  ROMEO_ONLY: event("romeo-only"),
  ABSENT: event("absent"),
  // Quota ids in two encodings: tag 8 ("quota-occurrence:v1:<hex>") sorts
  // first as text and last as stored bytes against tag 0 (raw text).
  QUOTA_TYPED: `quota-occurrence:v1:${digest("occurrence:quota-typed")}`,
  QUOTA_TEXT: "quota:v12:effective-scope-1",
  QUOTA_INCOMPLETE: `quota-occurrence:v1:${digest("occurrence:quota-incomplete")}`,
  SESSION: uuid("session:papa"),
  CONTROL: event("control"),
  DIGEST: event("digest"),
  DAY_SHIFT: event("day-shift"),
  MANIFEST_DEVICE: event("manifest-device"),
  MANIFEST_PARTICIPANT: event("manifest-participant"),
  CHUNK_PARTICIPANT: event("chunk-participant"),
  CHUNK_DEVICE: event("chunk-device"),
  CHUNK_DAY: event("chunk-day"),
  USAGE_IN_QUOTA_CHUNK: event("usage-in-quota-chunk"),
  QUOTA_IN_USAGE_CHUNK: `quota-occurrence:v1:${digest("occurrence:quota-in-usage-chunk")}`,
  FOREIGN_CHUNK: event("foreign-chunk"),
  FOREIGN_RECORD: event("foreign-record"),
  HEADED_ELSEWHERE: event("headed-elsewhere"),
  SIERRA_ONLY: event("sierra-only"),
  NC_ID: event("nc"),
  TIE_FIRST: event("tie-first"),
  TIE_ID: event("tie"),
  NO_TEXT_ID: event("no-text"),
  UTF8_ID: event("utf8"),
  // Admitted ids of the victor records whose stored ids are then rewritten.
  NC_SOURCE: event("nc-source"),
  TIE_SOURCE: event("tie-source"),
  NO_TEXT_SOURCE: event("no-text-source"),
  UTF8_SOURCE: event("utf8-source"),
});

/** The tango and sierra roles, in day order (E[0] to E[13]). */
export const ANOMALIES = Object.freeze(["CONTROL", "DIGEST", "DAY_SHIFT", "MANIFEST_DEVICE",
  "MANIFEST_PARTICIPANT", "CHUNK_PARTICIPANT", "CHUNK_DEVICE", "CHUNK_DAY", "USAGE_IN_QUOTA_CHUNK",
  "QUOTA_IN_USAGE_CHUNK", "FOREIGN_CHUNK", "FOREIGN_RECORD", "HEADED_ELSEWHERE", "SIERRA_ONLY"]);

/** Event times (UTC) by role; A and B share an instant, as do both quota ids. */
export const TIMES = Object.freeze({
  A: at(D1, "10:00:00.000"),
  B: at(D1, "10:00:00.000"),
  C: at(D1, "10:00:01.000"),
  INCOMPLETE: at(D1, "10:30:00.000"),
  SHARED: at(D1, "11:00:00.000"),
  MULTI_D1: at(D1, "12:00:00.000"),
  D: at(D1, "09:00:00.000"),
  E: at(D1, "13:00:00.000"),
  QUOTA: at(D1, "12:05:00.000"),
  SESSION: at(D1, "12:06:00.000"),
  STAGED: at(D2, "10:00:00.000"),
  MULTI_D3: at(D3, "08:00:00.000"),
  LATE: at(D3, "09:00:00.000"),
  OLD_ONLY: at(D1, "08:30:00.000"),
  OLD_SHARED: at(D1, "09:30:00.000"),
  OLD_D4: at(D4, "10:00:00.000"),
  QUEBEC_A: at(D1, "09:15:00.000"),
  QUEBEC_ONLY: at(D1, "10:15:00.000"),
  QUEBEC_D0: at(D0, "10:00:00.000"),
  QUOTA_INCOMPLETE: at(D3, "07:00:00.000"),
  ROMEO_ONLY: at(D1, "10:45:00.000"),
  ...Object.fromEntries(ANOMALIES.map((role, index) => [role, at(E[index], "10:00:00.000")])),
  NC_ID: at(V[0], "09:00:00.000"),
  NC_SOURCE: at(V[0], "11:00:00.000"),
  TIE_FIRST: at(V[1], "08:00:00.000"),
  TIE_ID: at(V[1], "12:00:00.000"),
  TIE_SOURCE: at(V[1], "12:00:00.000"),
  NO_TEXT_ID: at(V[2], "10:00:00.000"),
  NO_TEXT_SOURCE: at(V[2], "10:00:00.000"),
  UTF8_ID: at(V[3], "09:00:00.000"),
  UTF8_SOURCE: at(V[3], "11:00:00.000"),
});

function usageRecord(eventId, eventTime) {
  return {
    schemaVersion: "usage-event-v1.2",
    eventId,
    eventTime,
    sessionUuid: uuid(`session:${eventId}`),
    provider: PROVIDER,
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 1_000,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: 75,
    },
    accountPlanAttribution: {
      accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null,
    },
    boundaryFlags: null,
    tieOrder: null,
    cacheWriteTtl: null,
  };
}

function quotaRecord(observationId, observedTime, resetsAt = at(D3, "13:05:00.000")) {
  return {
    schemaVersion: "quota-observation-v1.2",
    observationId,
    observedTime,
    provider: PROVIDER,
    planType: "pro",
    planVariant: "unknown",
    limitId: "codex",
    slot: "primary",
    usedPercent: 20,
    windowDurationMinutes: 10_080,
    resetsAt,
    accountPlanAttribution: {
      accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null,
    },
  };
}

function sessionRecord(sessionUuid, firstEventTime) {
  return { schemaVersion: "session-dimension-v1.2", sessionUuid, firstEventTime, provider: PROVIDER,
    toolClassCounts: { localShell: 3, web: 1 } };
}

/**
 * Seed `schema` (every primary migration applied). `modules` are the
 * Worker's own v1.2 codec and sha256Hex, so stored digests are the bytes the
 * reader verifies. Returns participant ids and, per role, the storage row id
 * of each stored record (the reader's sourceRecordKey is v12:record:<id>).
 */
export async function seedTypedV12EffectiveScope({ pool, schema, modules }) {
  const { v12codec, sha256Hex } = modules;
  const quoted = `"${schema}"`;
  const table = (name) => {
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(name)) throw new Error("fixture_table_invalid");
    return `${quoted}."${name}"`;
  };
  const q = (text, values = []) => pool.query(text, values);
  let nextId = 5_000;
  const id = () => ++nextId;
  const rows = {};

  await q(`UPDATE ${table("telemetry_v12_runtime")} SET state='active',changed_at=$1 WHERE id=1`, [ISSUED]);
  await q(`UPDATE ${table("telemetry_v12_typed_runtime")} SET state='active',changed_at=$1 WHERE id=1`, [ISSUED]);

  const dictionary = new Map();
  async function dict(value) {
    if (!dictionary.has(value)) {
      const key = dictionary.size + 1;
      await q(`INSERT INTO ${table("typed_telemetry_dictionary")}(id,value) VALUES ($1,$2)`, [key, value]);
      dictionary.set(value, key);
    }
    return dictionary.get(value);
  }
  const attributions = new Map();
  async function attribution(value) {
    const track = Buffer.from(value.accountTrack);
    const era = Buffer.from(value.planEra);
    const planType = await dict(value.planType);
    const keyText = [value.accountBasis, track.toString("hex"), value.planBasis, planType, era.toString("hex")].join(":");
    if (!attributions.has(keyText)) {
      const key = id();
      await q(`INSERT INTO ${table("telemetry_v12_typed_attributions")}(
          id,account_basis,account_track,plan_basis,plan_type_id,plan_era) VALUES ($1,$2,$3,$4,$5,$6)`,
      [key, value.accountBasis, track, value.planBasis, planType, era]);
      attributions.set(keyText, key);
    }
    return attributions.get(keyText);
  }

  async function participant(name) {
    const participantId = `participant:${uuid(`participant:${name}`)}`;
    await q(`INSERT INTO ${table("participants")}(id,owner_kind,state,created_at) VALUES ($1,'social','active',$2)`,
      [participantId, ISSUED]);
    await q(`INSERT INTO ${table("storage_v11_owner_links")}(participant_id,owner_digest,state) VALUES ($1,$2,'active')`,
      [participantId, digest(`owner:${name}`)]);
    return participantId;
  }

  async function device(participantId, name) {
    const deviceId = `device:${uuid(`device:${name}`)}`;
    const sessionId = `session-${name}`;
    const pairingId = uuid(`pairing:${name}`);
    await q(`INSERT INTO ${table("web_sessions")}(
        id,participant_id,secret_hash,csrf_hash,scope,state,issued_at,expires_at,last_used_at)
      VALUES ($1,$2,$3,$4,'personal','active',$5,$6,$5)`,
    [sessionId, participantId, blob(`session-secret:${name}`), blob(`csrf:${name}`), ISSUED, EXPIRES]);
    await q(`INSERT INTO ${table("device_pairings")}(
        id,participant_id,issued_by_session_id,secret_hash,consent_version,transport_consent_version,state,
        issued_at,expires_at,consumed_at,claimed_device_id)
      VALUES ($1,$2,$3,$4,'ongoing-privacy-safe-telemetry-v0.1','ongoing-privacy-safe-telemetry-v0.1','consumed',
        $5,$6,$5,$7)`,
    [pairingId, participantId, sessionId, blob(`pairing-secret:${name}`), ISSUED, EXPIRES, deviceId]);
    await q(`INSERT INTO ${table("device_credentials")}(
        id,participant_id,authority_kind,paired_via_pairing_id,secret_hash,state,issued_at,expires_at,last_used_at,
        social_verified_at)
      VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`,
    [deviceId, participantId, pairingId, blob(`device-secret:${name}`), ISSUED, EXPIRES]);
    await q(`INSERT INTO ${table("telemetry_v12_device_capabilities")}(
        participant_id,device_id,telemetry_schema_version,field_dictionary_version,privacy_contract_version,
        state,consented_at)
      VALUES ($1,$2,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
        'ongoing-privacy-safe-telemetry-v1.2','accepted',$3)`, [participantId, deviceId, ISSUED]);
    return deviceId;
  }

  async function uploadAuthorization(participantId, deviceId, contributionId) {
    const authorizationId = `authorization-${digest(`authorization:${contributionId}`).slice(0, 32)}`;
    const envelope = digest(`envelope:${contributionId}`);
    const objectKey = `synthetic/typed-v12-effective-scope/${digest(`object-key:${contributionId}`).slice(0, 32)}`;
    await q(`INSERT INTO ${table("device_upload_authorizations")}(
        id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,content_type,state,
        issued_at,expires_at,consumed_at,consumed_contribution_id)
      VALUES ($1,$2,$3,$4,$5,1,'application/json','consumed',$6,$7,$6,$8)`,
    [authorizationId, participantId, deviceId, blob(`authorization-secret:${contributionId}`), envelope,
      ISSUED, EXPIRES, contributionId]);
    await q(`INSERT INTO ${table("pending_objects")}(contribution_id,object_key,object_kind) VALUES ($1,$2,'telemetry_v12')`,
      [contributionId, objectKey]);
    return { authorizationId, envelope, objectKey };
  }

  async function record(stream, value) {
    return v12codec.encodeTelemetryV12Record(stream, value,
      async (canonical) => Buffer.from(await sha256Hex(canonical), "hex"));
  }

  /**
   * One generation of `days` ({ day, ready, chunks: [{ stream, records:
   * [[role, value]], declaredExtra }] }); `head` makes it the participant's
   * head. Records are admitted while each manifest is staged, as the
   * admission path does, then the manifest is made ready. Returns the
   * generation id and, per day, the manifest id and chunk row ids.
   */
  async function generation({ participantId, deviceId, name, days, head }) {
    const generationId = uuid(`generation:${name}`);
    const fingerprint = digest(`fingerprint:${name}`);
    const token = digest(`token:${name}`);
    const domainDays = [];
    const manifests = {};
    for (const entry of days) {
      const manifestId = uuid(`manifest:${name}:${entry.day}`);
      const manifestDigest = digest(`manifest-digest:${name}:${entry.day}`);
      const chunks = entry.chunks.map((chunk, index) => ({
        ...chunk,
        chunkId: `${chunk.stream}:${entry.day}:${index}`,
        rowId: `chunk:${uuid(`chunk:${name}:${entry.day}:${index}`)}`,
        chunkDigest: digest(`chunk-digest:${name}:${entry.day}:${index}`),
        declaredCount: chunk.records.length + (chunk.declaredExtra ?? 0),
      }));
      const manifestJson = JSON.stringify({ schemaVersion: "telemetry-day-manifest-v1.2", day: entry.day,
        chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest,
          recordCount: chunk.declaredCount })) });
      await q(`INSERT INTO ${table("telemetry_v12_day_manifests")}(
          id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,expected_chunk_count,
          state,created_at,ready_at)
        VALUES ($1,$2,$3,$4::date,$5,'synthetic-effective-scope',$6,$7,'staged',$8,NULL)`,
      [manifestId, participantId, deviceId, entry.day, manifestDigest, manifestJson, chunks.length, ISSUED]);
      for (const [index, chunk] of chunks.entries()) {
        const upload = await uploadAuthorization(participantId, deviceId, chunk.rowId);
        await q(`INSERT INTO ${table("telemetry_v12_chunks")}(
            id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,
            envelope_digest,parser_version,record_count,r2_key,device_upload_authorization_id,created_at)
          VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'synthetic-effective-scope',$11,$12,$13,$14)`,
        [chunk.rowId, manifestId, participantId, deviceId, chunk.stream, entry.day, index, chunk.chunkId,
          chunk.chunkDigest, upload.envelope, chunk.declaredCount, upload.objectKey, upload.authorizationId, ISSUED]);
        for (const [recordIndex, [role, value]] of chunk.records.entries()) {
          const fields = await record(chunk.stream, value);
          const recordId = id();
          rows[role] = recordId;
          await q(`INSERT INTO ${table("telemetry_v12_typed_records")}(
              id,chunk_id,manifest_id,stream,record_index,occurrence_id,observed_at_ms,observed_day,provider_id,
              canonical_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [recordId, chunk.rowId, manifestId, chunk.stream, recordIndex, Buffer.from(fields.occurrenceId),
            fields.observedAtMs, fields.observedDay, await dict(fields.provider), Buffer.from(fields.canonicalDigest)]);
          if (chunk.stream === "usage") {
            const usage = fields.usage;
            await q(`INSERT INTO ${table("telemetry_v12_typed_usage")}(
                record_id,session_id,model_id,speed_mode_id,api_service_tier_id,surface_id,billing_surface_id,
                reasoning_effort_id,agent_scope_id,outcome_id,attribution_id,total_input_context_tokens,
                input_uncached_tokens,input_cache_read_tokens,input_cache_write_tokens,output_text_tokens,
                output_reasoning_tokens,output_combined_tokens,boundary_flags,tie_order,
                cache_write_ttl_five_minute_tokens,cache_write_ttl_one_hour_tokens)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
            [recordId, Buffer.from(usage.sessionId), await dict(usage.model), await dict(usage.speedMode),
              await dict(usage.apiServiceTier), await dict(usage.surface), await dict(usage.billingSurface),
              await dict(usage.reasoningEffort), await dict(usage.agentScope), await dict(usage.outcome),
              await attribution(usage.attribution), usage.totalInputContextTokens, usage.inputUncachedTokens,
              usage.inputCacheReadTokens, usage.inputCacheWriteTokens, usage.outputTextTokens,
              usage.outputReasoningTokens, usage.outputCombinedTokens, usage.boundaryFlags, usage.tieOrder,
              usage.cacheWriteTtlFiveMinuteTokens, usage.cacheWriteTtlOneHourTokens]);
          } else if (chunk.stream === "quota") {
            const quota = fields.quota;
            await q(`INSERT INTO ${table("telemetry_v12_typed_quota")}(
                record_id,plan_type_id,plan_variant_id,limit_id,slot_id,used_percent,window_duration_minutes,
                resets_at_ms,attribution_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [recordId, await dict(quota.planType), await dict(quota.planVariant), await dict(quota.limitId),
              await dict(quota.slot), quota.usedPercent, quota.windowDurationMinutes, quota.resetsAtMs,
              await attribution(quota.attribution)]);
          } else {
            for (const [tool, count] of Object.entries(fields.tools)) {
              await q(`INSERT INTO ${table("telemetry_v12_typed_session_tools")}(record_id,tool_class_id,count)
                VALUES ($1,$2,$3)`, [recordId, await dict(tool), count]);
            }
          }
        }
      }
      const incomplete = chunks.some((chunk) => chunk.declaredCount !== chunk.records.length);
      if (entry.ready === false) {
        // The manifest stays staged.
      } else if (incomplete) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL session_replication_role = replica");
          await client.query(`UPDATE ${table("telemetry_v12_day_manifests")} SET state='ready',ready_at=$2 WHERE id=$1`,
            [manifestId, ISSUED]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      } else {
        await q(`UPDATE ${table("telemetry_v12_day_manifests")} SET state='ready',ready_at=$2 WHERE id=$1`,
          [manifestId, ISSUED]);
      }
      domainDays.push({ day: entry.day, manifestId, manifestDigest });
      manifests[entry.day] = Object.freeze({ manifestId, chunks: Object.freeze(chunks.map((chunk) => chunk.rowId)) });
    }
    const fromDay = days[0].day;
    const throughDay = days.at(-1).day;
    await q(`INSERT INTO ${table("telemetry_v12_domain_predecessors")}(
        token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,
        from_day,through_day,winners_json,created_at,expires_at)
      VALUES ($1,$2,$3,NULL,$4,0,$5::date,$6::date,'[]',$7,$8)`,
    [token, participantId, deviceId, fingerprint, fromDay, throughDay, ISSUED, EXPIRES]);
    await q(`INSERT INTO ${table("telemetry_v12_domains")}(
        id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,legacy_fingerprint,
        input_revision,from_day,through_day,days_json,created_at)
      VALUES ($1,$2,$3,$4,NULL,$5,$6,0,$7::date,$8::date,$9,$10)`,
    [generationId, participantId, deviceId, token, digest(`generation-digest:${name}`), fingerprint, fromDay,
      throughDay, JSON.stringify(domainDays), ISSUED]);
    for (const entry of domainDays) {
      await q(`INSERT INTO ${table("telemetry_v12_domain_days")}(generation_id,observed_day,manifest_id,manifest_digest)
        VALUES ($1,$2::date,$3,$4)`, [generationId, entry.day, entry.manifestId, entry.manifestDigest]);
    }
    if (head) {
      await q(`INSERT INTO ${table("telemetry_v12_domain_heads")}(participant_id,generation_id,revision,updated_at)
        VALUES ($1,$2,1,$3)`, [participantId, generationId, ISSUED]);
    }
    return Object.freeze({ generationId, manifests: Object.freeze(manifests) });
  }

  /** Direct writes with every trigger, foreign keys included, bypassed. */
  async function bypassingGuards(write) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await write((text, values = []) => client.query(text, values));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  const usage = (role, id, time) => [role, usageRecord(id, time)];
  const papa = await participant("papa");
  const papaHead = await device(papa, "papa-head");
  const papaOld = await device(papa, "papa-old");
  await generation({ participantId: papa, deviceId: papaOld, name: "papa-old", head: false, days: [
    { day: D1, chunks: [{ stream: "usage", records: [usage("OLD_ONLY", IDS.OLD_ONLY, TIMES.OLD_ONLY),
      usage("OLD_SHARED", IDS.SHARED, TIMES.OLD_SHARED)] }] },
    { day: D4, chunks: [{ stream: "usage", records: [usage("OLD_D4", IDS.OLD_D4, TIMES.OLD_D4)] }] },
  ] });
  await generation({ participantId: papa, deviceId: papaHead, name: "papa-head", head: true, days: [
    { day: D1, chunks: [
      { stream: "usage", records: [usage("A", IDS.A, TIMES.A), usage("B", IDS.B, TIMES.B),
        usage("C", IDS.C, TIMES.C), usage("SHARED", IDS.SHARED, TIMES.SHARED),
        usage("MULTI_D1", IDS.MULTI, TIMES.MULTI_D1)] },
      { stream: "usage", records: [usage("INCOMPLETE", IDS.INCOMPLETE, TIMES.INCOMPLETE)], declaredExtra: 1 },
      { stream: "usage", records: [usage("D", IDS.D, TIMES.D), usage("E", IDS.E, TIMES.E)] },
      { stream: "quota", records: [["QUOTA_TEXT", quotaRecord(IDS.QUOTA_TEXT, TIMES.QUOTA)],
        ["QUOTA_TYPED", quotaRecord(IDS.QUOTA_TYPED, TIMES.QUOTA)]] },
      { stream: "session", records: [["SESSION", sessionRecord(IDS.SESSION, TIMES.SESSION)]] },
    ] },
    { day: D2, ready: false, chunks: [{ stream: "usage", records: [usage("STAGED", IDS.STAGED, TIMES.STAGED)] }] },
    { day: D3, chunks: [{ stream: "usage", records: [usage("MULTI_D3", IDS.MULTI, TIMES.MULTI_D3),
      usage("LATE", IDS.LATE, TIMES.LATE)] },
    { stream: "quota", records: [["QUOTA_INCOMPLETE", quotaRecord(IDS.QUOTA_INCOMPLETE, TIMES.QUOTA_INCOMPLETE)]],
      declaredExtra: 1 }] },
  ] });
  const quebec = await participant("quebec");
  const quebecDevice = await device(quebec, "quebec");
  await generation({ participantId: quebec, deviceId: quebecDevice, name: "quebec", head: true, days: [
    { day: D0, chunks: [{ stream: "usage", records: [usage("QUEBEC_D0", IDS.QUEBEC_D0, TIMES.QUEBEC_D0)] }] },
    { day: D1, chunks: [{ stream: "usage", records: [usage("QUEBEC_A", IDS.A, TIMES.QUEBEC_A),
      usage("QUEBEC_ONLY", IDS.QUEBEC_ONLY, TIMES.QUEBEC_ONLY)] }] },
  ] });
  const romeo = await participant("romeo");
  const romeoDevice = await device(romeo, "romeo");
  await generation({ participantId: romeo, deviceId: romeoDevice, name: "romeo", head: true, days: [
    { day: D1, chunks: [{ stream: "usage", records: [usage("ROMEO_ONLY", IDS.ROMEO_ONLY, TIMES.ROMEO_ONLY)] }] },
  ] });
  // romeo's owner withdrew: no branch of the retained-authorization view holds.
  await q(`UPDATE ${table("storage_v11_owner_links")} SET state='withdrawn' WHERE participant_id=$1`, [romeo]);

  // One record per remaining predicate (see the header), built valid, then
  // broken in exactly one place.
  const uniform = await participant("uniform");
  const tango = await participant("tango");
  const tangoHead = await device(tango, "tango-head");
  const tangoOther = await device(tango, "tango-other");
  const anomalyDay = (role) => {
    const day = E[ANOMALIES.indexOf(role)];
    const value = role === "QUOTA_IN_USAGE_CHUNK"
      ? quotaRecord(IDS[role], TIMES[role], at(E[15], "13:05:00.000"))
      : usageRecord(IDS[role], TIMES[role]);
    return { day, chunks: [{ stream: role === "QUOTA_IN_USAGE_CHUNK" ? "quota" : "usage", records: [[role, value]] }] };
  };
  const tangoCurrent = await generation({ participantId: tango, deviceId: tangoHead, name: "tango-head", head: true,
    days: ANOMALIES.slice(0, 12).map(anomalyDay) });
  const tangoEarlier = await generation({ participantId: tango, deviceId: tangoHead, name: "tango-earlier", head: false,
    days: [anomalyDay("HEADED_ELSEWHERE")] });
  const looseManifest = uuid("manifest:tango-loose");
  await q(`INSERT INTO ${table("telemetry_v12_day_manifests")}(
      id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,expected_chunk_count,
      state,created_at,ready_at)
    VALUES ($1,$2,$3,$4::date,$5,'synthetic-effective-scope','{}',0,'staged',$6,NULL)`,
  [looseManifest, tango, tangoHead, E[10], digest("manifest-digest:tango-loose"), ISSUED]);
  const sierra = await participant("sierra");
  const sierraHead = await device(sierra, "sierra-head");
  const sierraOther = await device(sierra, "sierra-other");
  await generation({ participantId: sierra, deviceId: sierraHead, name: "sierra-head", head: true,
    days: [anomalyDay("SIERRA_ONLY")] });

  // victor: canonical records beside the ones whose stored ids are rewritten.
  const victor = await participant("victor");
  const victorDevice = await device(victor, "victor");
  const victorDay = (day, roles) => ({ day, chunks: [{ stream: "usage",
    records: roles.map((role) => usage(role, IDS[role], TIMES[role])) }] });
  await generation({ participantId: victor, deviceId: victorDevice, name: "victor", head: true, days: [
    victorDay(V[0], ["NC_ID", "NC_SOURCE"]),
    victorDay(V[1], ["TIE_FIRST", "TIE_ID", "TIE_SOURCE"]),
    victorDay(V[2], ["NO_TEXT_ID", "NO_TEXT_SOURCE"]),
    victorDay(V[3], ["UTF8_ID", "UTF8_SOURCE"]),
  ] });

  const chunkOf = (role) => tangoCurrent.manifests[E[ANOMALIES.indexOf(role)]].chunks[0];
  const manifestOf = (role) => tangoCurrent.manifests[E[ANOMALIES.indexOf(role)]].manifestId;
  const raw = (text) => Buffer.concat([Buffer.from([0]), Buffer.from(text, "utf8")]);
  await bypassingGuards(async (write) => {
    const domainDays = table("telemetry_v12_domain_days");
    const manifests = table("telemetry_v12_day_manifests");
    const chunks = table("telemetry_v12_chunks");
    const records = table("telemetry_v12_typed_records");
    await write(`UPDATE ${domainDays} SET manifest_digest=$3 WHERE generation_id=$1 AND observed_day=$2::date`,
      [tangoCurrent.generationId, E[1], digest("manifest-digest:not-the-manifest")]);
    await write(`UPDATE ${domainDays} SET observed_day=$3::date WHERE generation_id=$1 AND observed_day=$2::date`,
      [tangoCurrent.generationId, E[2], E[14]]);
    await write(`UPDATE ${manifests} SET device_id=$2 WHERE id=$1`, [manifestOf("MANIFEST_DEVICE"), tangoOther]);
    await write(`UPDATE ${chunks} SET device_id=$2 WHERE id=$1`, [chunkOf("MANIFEST_DEVICE"), tangoOther]);
    await write(`UPDATE ${manifests} SET participant_id=$2 WHERE id=$1`, [manifestOf("MANIFEST_PARTICIPANT"), uniform]);
    await write(`UPDATE ${chunks} SET participant_id=$2 WHERE id=$1`, [chunkOf("MANIFEST_PARTICIPANT"), uniform]);
    await write(`UPDATE ${chunks} SET participant_id=$2 WHERE id=$1`, [chunkOf("CHUNK_PARTICIPANT"), uniform]);
    await write(`UPDATE ${chunks} SET device_id=$2 WHERE id=$1`, [chunkOf("CHUNK_DEVICE"), tangoOther]);
    await write(`UPDATE ${chunks} SET chunk_day=$2::date WHERE id=$1`, [chunkOf("CHUNK_DAY"), E[15]]);
    await write(`UPDATE ${chunks} SET stream='quota' WHERE id=$1`, [chunkOf("USAGE_IN_QUOTA_CHUNK")]);
    await write(`UPDATE ${chunks} SET stream='usage' WHERE id=$1`, [chunkOf("QUOTA_IN_USAGE_CHUNK")]);
    await write(`UPDATE ${chunks} SET manifest_id=$2 WHERE id=$1`, [chunkOf("FOREIGN_CHUNK"), looseManifest]);
    await write(`UPDATE ${records} SET manifest_id=$2 WHERE id=$1`, [rows.FOREIGN_RECORD, looseManifest]);
    await write(`INSERT INTO ${table("telemetry_v12_domain_heads")}(participant_id,generation_id,revision,updated_at)
      VALUES ($1,$2,1,$3)`, [uniform, tangoEarlier.generationId, ISSUED]);
    await write(`DELETE FROM ${table("telemetry_v12_device_capabilities")} WHERE participant_id=$1 AND device_id=$2`,
      [sierra, sierraHead]);
    await write(`UPDATE ${records} SET occurrence_id=$2 WHERE id=$1`, [rows.NC_SOURCE, raw(IDS.NC_ID)]);
    await write(`UPDATE ${records} SET occurrence_id=$2 WHERE id=$1`, [rows.TIE_SOURCE, raw(IDS.TIE_ID)]);
    await write(`UPDATE ${records} SET occurrence_id=$2 WHERE id=$1`,
      [rows.NO_TEXT_SOURCE, Buffer.concat([Buffer.from([12]), blob("no-text").subarray(0, 16)])]);
    await write(`UPDATE ${records} SET occurrence_id=$2 WHERE id=$1`,
      [rows.UTF8_SOURCE, Buffer.from([0x00, 0xff, 0xfe, 0x41])]);
  });

  return Object.freeze({
    participants: Object.freeze({ papa, quebec, romeo, tango, uniform, sierra, victor }),
    devices: Object.freeze({ papaHead, papaOld, quebec: quebecDevice, romeo: romeoDevice, tangoHead, tangoOther,
      sierraHead, sierraOther, victor: victorDevice }),
    rows: Object.freeze(rows),
  });
}
