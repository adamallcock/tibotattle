/**
 * Content-free fixture for the analytics-v2 occurrence adapter spec (A-1).
 *
 * It writes the existing typed PostgreSQL source tables directly, through the
 * live guards of the whole primary migration chain, for one schema. Every
 * identifier is opaque and derived from a fixed seed (no paths, prompts,
 * session content, account identifiers or credentials); every secret hash is
 * a digest of a constant label. The fixture is shaped by production's
 * per-OBSERVED-day candidate rule: a correction never moves an event across
 * days, so the crossed-midnight occurrence is a conflict on both of its
 * candidate days, never a moved event.
 *
 * Owners (participant -> source routing at each correction-runtime state):
 *   alpha   social, v1 + v1.1 + v1.2 (4 devices)   effective / effective
 *   bravo   social, v1 + accepted v0.2               effective / mixed
 *   charlie social, accepted v0.2 only               v0.2 / v0.2
 *   golf    social, no evidence and no owner link    unlinked (v0.2)
 *   echo    accountless, opted out with a retained public-history marker
 *           (production view semantics: included)
 *   delta   accountless, disconnected (security reset): excluded
 *   hotel   social, v1.2 only, seeded only with `dense`  effective / effective
 *   india   social, v1.2 only, seeded only with `v12Scope`  effective / effective
 *   juliet  social, v1.2 only, seeded only with `v12Scope`  effective / effective
 *   kilo    social, v1 + v1.1, seeded only with `denseLegacy`  effective / mixed
 *   lima    social, v1 + v1.1, seeded only with `legacyScope`  effective / mixed
 *   mike    social, v1.1 only, seeded only with `legacyScope`  effective / v1.1
 *
 * The usage-correction runtime row is immutable once written, so each runtime
 * state gets its own schema: seedAnalyticsV2Fixture({ correctionRuntime }).
 *
 * `dense: { day, usage }` (GCP cap raise) adds hotel with one v1.2 day of
 * `usage` usage records in 200-record chunks, beyond the d43c8f92 shared
 * reducers' 20,000-occurrence day bound. Nothing else changes.
 *
 * `v12Scope: true` (review of the v1.2 expansion rewrite) adds india and
 * juliet. One occurrence id, OCCURRENCES.scoped, has exactly one eligible v1.2
 * record (india's first device, D1 11:00) and three ineligible variants with
 * other event times on D1, each of which the v1.2 reader must exclude:
 * india's second device in a STAGED (never ready) manifest; india's third
 * device in a ready manifest whose chunk declares one record more than it
 * holds (the schema's ready guard forbids this, so the fixture bypasses that
 * trigger for this one row); and juliet's record, another participant's.
 * Nothing else changes.
 *
 * `denseLegacy: { days, usagePerDay, v1PerDay = 0, throughDay = D3 }`
 * (C-REFRESH, the legacy expansion at volume) adds kilo: `days` consecutive
 * days through `throughDay`, each with `usagePerDay` v1.1 usage records (one
 * retained generation, one ready manifest a day, 200-record chunks) and
 * `v1PerDay` v1 usage records (accepted 200-record chunks). Every 10th v1
 * record repeats a v1.1 occurrence of its day with identical content, so
 * both legacy formats meet in one group. Occurrence ids, sessions and times
 * are derived from fixed labels. Nothing else changes.
 *
 * `legacyScope: true` (C-REFRESH, the review of the legacy expansion and
 * candidate rewrite) adds lima and mike. One usage occurrence id,
 * OCCURRENCES.legacyScoped, has exactly one eligible typed legacy record
 * (lima's first v1 device, D1 10:00) and three ineligible variants with other
 * event times on D1, each of which the legacy readers must exclude: a record
 * of lima's second v1 device in a superseded chunk, a record of lima's third
 * v1 device in a chunk that accepted one record fewer than it declares, and
 * mike's v1.1 record (another participant's). lima's v1.1 device also holds
 * OCCURRENCES.legacyFirst at D1 00:00:00.000 and OCCURRENCES.legacyLast at
 * D3 23:59:59.999, the first and last instants of the fixture's days.
 */

import { createHash } from "node:crypto";

export const SOURCE_ID = "synthetic-analytics-v2-source";
export const SOURCE_NAMESPACE = "synthetic-analytics-v2-namespace";
export const NOW = "2026-10-01T12:00:00.000Z";
export const NOW_MS = Date.parse(NOW);
export const D1 = "2026-09-28";
export const D2 = "2026-09-29";
export const D3 = "2026-09-30";
const ISSUED = "2026-09-01T00:00:00.000Z";
const EXPIRES = "2099-01-01T00:00:00.000Z";
const PROVIDER = "openai_codex";
const DAY_MS = 86_400_000;

export const digest = (seed) => createHash("sha256").update(`analytics-v2-fixture:${seed}`).digest("hex");
const blob = (seed) => Buffer.from(digest(seed), "hex");
const uuid = (seed) => {
  const hex = digest(`uuid:${seed}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const dayNumber = (day) => Date.parse(`${day}T00:00:00.000Z`) / DAY_MS;

/** Opaque occurrence ids of the fixture, by role. */
export const OCCURRENCES = Object.freeze({
  /** alpha usage present in v1, v1.1 and v1.2 with identical content (D1). */
  shared: `event:v2:${digest("occurrence:shared")}`,
  /** alpha usage whose v1 copy is D1 23:59:59 and v1.1 copy D2 00:00:01. */
  crossed: `event:v2:${digest("occurrence:crossed")}`,
  /** alpha usage present in v1.2 only (D1). */
  v12Only: `event:v2:${digest("occurrence:v12-only")}`,
  /** india usage with one eligible v1.2 record and three ineligible variants (D1, `v12Scope` only). */
  scoped: `event:v2:${digest("occurrence:v12-scoped")}`,
  /** alpha usage present in v1.1 only (D2). */
  v11Only: `event:v2:${digest("occurrence:v11-only")}`,
  /** alpha quota present in v1 and v1.1 (D1). */
  quota: `quota-occurrence:v1:${digest("occurrence:quota")}`,
  /** bravo usage whose current row has unknown totals; its correction fact reports them (D1). */
  corrected: `event:v2:${digest("occurrence:corrected")}`,
  /** echo usage in v1.1 (D1). */
  echo: `event:v2:${digest("occurrence:echo")}`,
  /** lima usage with one eligible v1 record and three ineligible variants (D1, `legacyScope` only). */
  legacyScoped: `event:v2:${digest("occurrence:legacy-scoped")}`,
  /** lima v1.1 usage at the first instant of D1 (`legacyScope` only). */
  legacyFirst: `event:v2:${digest("occurrence:legacy-first")}`,
  /** lima v1.1 usage at the last instant of D3 (`legacyScope` only). */
  legacyLast: `event:v2:${digest("occurrence:legacy-last")}`,
});
/** The totals the correction fact reports for OCCURRENCES.corrected. */
export const CORRECTED_TOTALS = Object.freeze({ totalInputContextTokens: 1_000, outputCombinedTokens: 75 });

function at(day, time) {
  return `${day}T${time}.000Z`;
}

function usageRecord(format, eventId, eventTime, overrides = {}) {
  const record = {
    schemaVersion: format === "v1" ? "usage-event-v1.0" : format === "v11" ? "usage-event-v1.1" : "usage-event-v1.2",
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
    ...overrides,
  };
  if (format !== "v1") {
    record.accountPlanAttribution = {
      accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null,
    };
  }
  if (format === "v12") {
    record.boundaryFlags = null;
    record.tieOrder = null;
    record.cacheWriteTtl = null;
  }
  return record;
}

function quotaRecord(format, observationId, observedTime) {
  const record = {
    schemaVersion: format === "v1" ? "quota-observation-v1.0" : "quota-observation-v1.1",
    observationId,
    observedTime,
    provider: PROVIDER,
    planType: "pro",
    planVariant: "unknown",
    limitId: "codex",
    slot: "primary",
    usedPercent: 35,
    windowDurationMinutes: 10_080,
    resetsAt: "2026-10-03T00:00:00.000Z",
  };
  if (format !== "v1") {
    record.accountPlanAttribution = {
      accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null,
    };
  }
  return record;
}

const STREAM_CODE = Object.freeze({ usage: 1, quota: 2, session: 3 });
const ACCOUNT_BASES = ["unavailable", "same_source", "provisional_marker"];
const PLAN_BASES = ["unavailable", "same_source_occurrence", "provisional_marker", "conflicted"];

/**
 * Seed one schema. `modules` are the Worker's own TypeScript modules loaded by
 * the spec (typed codecs, the correction assertion and sha256Hex), so stored
 * digests are the bytes the production readers verify.
 */
export async function seedAnalyticsV2Fixture({ pool, schema, modules, correctionRuntime, dense = null,
  v12Scope = false, denseLegacy = null, legacyScope = false, expansionCorrections = false, expansionBoundary = null }) {
  if (correctionRuntime !== "active" && correctionRuntime !== "staged") throw new Error("fixture_runtime_invalid");
  const { codec, v12codec, reconciliation, sha256Hex } = modules;
  const quoted = `"${schema}"`;
  const table = (name) => {
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(name)) throw new Error("fixture_table_invalid");
    return `${quoted}."${name}"`;
  };
  const q = (text, values = []) => pool.query(text, values);
  let nextId = 1_000;
  const id = () => ++nextId;

  // ---- global source state -------------------------------------------------
  await q(`INSERT INTO ${table("typed_telemetry_namespaces")}(id,original_id) VALUES (1,$1)`,
    [Buffer.from(codec.encodeTypedTelemetryId(SOURCE_NAMESPACE))]);
  for (const name of ["typed_v1_admission_state", "typed_v11_admission_state"]) {
    await q(`INSERT INTO ${table(name)}(id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      VALUES (1,$1,1,1,100000)`, [SOURCE_NAMESPACE]);
  }
  await q(`INSERT INTO ${table("storage_source_state")}(singleton,source_id,authority_epoch) VALUES (1,$1,0)`, [SOURCE_ID]);
  await q(`UPDATE ${table("telemetry_v12_runtime")} SET state='active',changed_at=$1 WHERE id=1`, [ISSUED]);
  await q(`UPDATE ${table("telemetry_v12_typed_runtime")} SET state='active',changed_at=$1 WHERE id=1`, [ISSUED]);
  await q(`INSERT INTO ${table("telemetry_usage_correction_runtime")}(
      id,schema_version,method_version,source_state,max_capture_rows,max_history_page)
    VALUES (1,'telemetry-usage-correction-v1','usage-total-correction-v1',$1,200,200)`, [correctionRuntime]);

  const dictionary = new Map();
  async function dict(value) {
    if (!dictionary.has(value)) {
      const key = dictionary.size + 1;
      await q(`INSERT INTO ${table("typed_telemetry_dictionary")}(id,value) VALUES ($1,$2)`, [key, value]);
      dictionary.set(value, key);
    }
    return dictionary.get(value);
  }

  let journalSeed = 0;
  async function journal(kind, ownerDigest, eventDigest = digest(`event:${++journalSeed}`)) {
    const result = await q(`SELECT ${quoted}.storage_journal_append($1,$2,$3,$4,$5)::text AS sequence`,
      [kind, ownerDigest, eventDigest, digest(`object:${eventDigest}`), digest(`content:${eventDigest}`)]);
    return Number(result.rows[0].sequence);
  }

  // ---- participants and devices ---------------------------------------------
  async function participant(name, ownerKind) {
    const participantId = `participant:${uuid(`participant:${name}`)}`;
    await q(`INSERT INTO ${table("participants")}(id,owner_kind,state,created_at) VALUES ($1,$2,'active',$3)`,
      [participantId, ownerKind, ISSUED]);
    return participantId;
  }

  async function socialDevice(participantId, name, { v12 = false } = {}) {
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
    if (v12) {
      await q(`INSERT INTO ${table("telemetry_v12_device_capabilities")}(
          participant_id,device_id,telemetry_schema_version,field_dictionary_version,privacy_contract_version,
          state,consented_at)
        VALUES ($1,$2,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
          'ongoing-privacy-safe-telemetry-v1.2','accepted',$3)`, [participantId, deviceId, ISSUED]);
    }
    return deviceId;
  }

  /** An active accountless lease graph with a v1.1 grant (the v1.1 eligibility branch). */
  async function accountlessDevice(participantId, name) {
    const deviceId = `device:${uuid(`device:${name}`)}`;
    const secret = blob(`device-secret:${name}`);
    await q(`INSERT INTO ${table("accountless_enrollment_ledger")}(
        device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,authorization_basis,
        state,issued_at,expires_at,revoked_at,revocation_reason,renewal_generation,renewed_at)
      VALUES ($1,$2,$3,'accountless-enrollment-v0.1','accountless-opt-out-v1','accountless-policy-v1',
        'active',$4,$5,NULL,NULL,0,NULL)`, [deviceId, secret, `installation-${digest(name).slice(0, 16)}`, ISSUED, EXPIRES]);
    await q(`INSERT INTO ${table("device_credentials")}(
        id,participant_id,authority_kind,accountless_enrollment_device_id,secret_hash,state,
        issued_at,expires_at,last_used_at,revoked_at,social_verified_at)
      VALUES ($1,$2,'accountless',$1,$3,'active',$4,$5,$4,NULL,NULL)`, [deviceId, participantId, secret, ISSUED, EXPIRES]);
    await q(`INSERT INTO ${table("accountless_upload_owners")}(
        enrollment_device_id,participant_id,device_credential_id,policy_version,authorization_basis,
        authorized_at,expires_at,state,revoked_at,revocation_reason)
      VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',$3,$4,'active',NULL,NULL)`,
    [deviceId, participantId, ISSUED, EXPIRES]);
    await q(`INSERT INTO ${table("accountless_v11_device_authorizations")}(
        enrollment_device_id,participant_id,device_credential_id,telemetry_schema_version,field_dictionary_version,
        privacy_contract_version,authorized_at,expires_at,state,revoked_at,revocation_reason)
      VALUES ($1,$2,$1,'telemetry-contribution-v1.1','telemetry-v1.1-registry-2026-08-31.1',
        'ongoing-privacy-safe-telemetry-v1.1',$3,$4,'active',NULL,NULL)`, [deviceId, participantId, ISSUED, EXPIRES]);
    return deviceId;
  }

  async function revokeAccountless(deviceId, reason, revokedAt) {
    for (const [name, key, hasReason] of [
      ["accountless_enrollment_ledger", "device_id", true],
      ["accountless_upload_owners", "enrollment_device_id", true],
      ["device_credentials", "id", false],
      ["accountless_v11_device_authorizations", "enrollment_device_id", true],
    ]) {
      await q(`UPDATE ${table(name)} SET state='revoked',revoked_at=$2${hasReason ? ",revocation_reason=$3" : ""}
        WHERE ${key}=$1`, hasReason ? [deviceId, revokedAt, reason] : [deviceId, revokedAt]);
    }
  }

  /** The owner link and the owner's first exact journal row (owner-active). */
  async function linkOwner(participantId, name) {
    const ownerDigest = digest(`owner:${name}`);
    await q(`INSERT INTO ${table("storage_v11_owner_links")}(participant_id,owner_digest,state) VALUES ($1,$2,'active')`,
      [participantId, ownerDigest]);
    await journal("owner-active", ownerDigest);
    return ownerDigest;
  }

  // ---- typed legacy identities ----------------------------------------------
  const typedOwners = new Map();
  async function typedOwner(participantId) {
    if (!typedOwners.has(participantId)) {
      const ownerId = id();
      await q(`INSERT INTO ${table("typed_telemetry_owners")}(id,namespace_id,original_id) VALUES ($1,1,$2)`,
        [ownerId, Buffer.from(codec.encodeTypedTelemetryId(`participant:${uuid(`typed-owner:${participantId}`)}`))]);
      for (const format of [10, 11]) {
        await q(`INSERT INTO ${table("typed_telemetry_owner_memberships")}(
            namespace_id,source_format,owner_id,participant_id,source_namespace) VALUES (1,$1,$2,$3,$4)`,
        [format, ownerId, participantId, SOURCE_NAMESPACE]);
      }
      typedOwners.set(participantId, { ownerId, devices: new Map(), identifiers: new Map(),
        attributions: new Map(), dimensions: new Map() });
    }
    return typedOwners.get(participantId);
  }
  async function typedDevice(owner, deviceId) {
    if (!owner.devices.has(deviceId)) {
      const key = id();
      await q(`INSERT INTO ${table("typed_telemetry_devices")}(id,namespace_id,owner_id,original_id) VALUES ($1,1,$2,$3)`,
        [key, owner.ownerId, Buffer.from(codec.encodeTypedTelemetryId(deviceId))]);
      owner.devices.set(deviceId, key);
    }
    return owner.devices.get(deviceId);
  }
  async function identifier(owner, bytes) {
    const hex = Buffer.from(bytes).toString("hex");
    if (!owner.identifiers.has(hex)) {
      const key = id();
      await q(`INSERT INTO ${table("typed_telemetry_identifiers")}(id,namespace_id,owner_id,value) VALUES ($1,1,$2,$3)`,
        [key, owner.ownerId, Buffer.from(bytes)]);
      owner.identifiers.set(hex, key);
    }
    return owner.identifiers.get(hex);
  }
  async function legacyAttribution(owner, attribution) {
    if (attribution === null) return null;
    const accountBasis = ACCOUNT_BASES.indexOf(attribution.accountBasis);
    const planBasis = PLAN_BASES.indexOf(attribution.planBasis);
    const track = attribution.accountTrackId === null ? Buffer.alloc(0)
      : Buffer.from(codec.encodeTypedTelemetryId(attribution.accountTrackId));
    const era = attribution.planEraId === null ? Buffer.alloc(0) : Buffer.from(codec.encodeTypedTelemetryId(attribution.planEraId));
    const planType = await dict(attribution.planType);
    const keyText = [accountBasis, track.toString("hex"), planBasis, planType, era.toString("hex")].join(":");
    if (!owner.attributions.has(keyText)) {
      const key = id();
      await q(`INSERT INTO ${table("typed_telemetry_attributions")}(
          id,namespace_id,owner_id,account_basis,account_track,plan_basis,plan_type_id,plan_era)
        VALUES ($1,1,$2,$3,$4,$5,$6,$7)`, [key, owner.ownerId, accountBasis, track, planBasis, planType, era]);
      owner.attributions.set(keyText, key);
    }
    return owner.attributions.get(keyText);
  }
  async function quotaDimensions(owner, quota, attributionId) {
    const planType = await dict(quota.planType);
    const planVariant = await dict(quota.planVariant);
    const keyText = [planType, planVariant, attributionId ?? 0].join(":");
    if (!owner.dimensions.has(keyText)) {
      const key = id();
      await q(`INSERT INTO ${table("typed_telemetry_quota_dimensions")}(
          id,namespace_id,owner_id,plan_type_id,plan_variant_id,attribution_id) VALUES ($1,1,$2,$3,$4,$5)`,
      [key, owner.ownerId, planType, planVariant, attributionId]);
      owner.dimensions.set(keyText, key);
    }
    return owner.dimensions.get(keyText);
  }

  let nextSourceRow = 1;
  /** One typed legacy record and its stream child; returns the typed record id and digest. */
  async function typedRecord(owner, typedDeviceId, format, chunkKey, manifestKey, record) {
    const fields = codec.encodeTypedTelemetryRecord(format, record);
    const canonical = codec.typedTelemetryCanonicalRecords(fields).canonicalRecord;
    const canonicalDigest = Buffer.from(await sha256Hex(canonical), "hex");
    const recordId = id();
    const sourceRowId = nextSourceRow++;
    await q(`INSERT INTO ${table("typed_telemetry_records")}(
        id,namespace_id,format,source_row_id,owner_id,device_id,chunk_id,manifest_id,stream,
        occurrence_id,observed_at_ms,observed_day,provider_id,canonical_digest)
      VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [recordId, format === "v1" ? 10 : 11, sourceRowId, owner.ownerId, typedDeviceId, chunkKey, manifestKey,
      STREAM_CODE[fields.stream], Buffer.from(fields.occurrenceId), fields.observedAtMs,
      Math.floor(fields.observedAtMs / DAY_MS), await dict(fields.provider), canonicalDigest]);
    const attributionId = await legacyAttribution(owner, fields.attribution);
    if (fields.stream === "usage") {
      const usage = fields.usage;
      await q(`INSERT INTO ${table("typed_telemetry_usage")}(
          record_id,session_id,model_id,speed_mode_id,api_service_tier_id,surface_id,billing_surface_id,
          reasoning_effort_id,agent_scope_id,outcome_id,attribution_id,total_input_context_tokens,
          input_uncached_tokens,input_cache_read_tokens,input_cache_write_tokens,output_text_tokens,
          output_reasoning_tokens,output_combined_tokens)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [recordId, await identifier(owner, usage.sessionId), await dict(usage.modelId), await dict(usage.speedMode),
        await dict(usage.apiServiceTier), await dict(usage.surface), await dict(usage.billingSurface),
        await dict(usage.reasoningEffort), await dict(usage.agentScope), await dict(usage.outcome), attributionId,
        usage.totalInputContextTokens, usage.components.inputUncachedTokens, usage.components.inputCacheReadTokens,
        usage.components.inputCacheWriteTokens, usage.components.outputTextTokens,
        usage.components.outputReasoningTokens, usage.components.outputCombinedTokens]);
    } else if (fields.stream === "quota") {
      const quota = fields.quota;
      await q(`INSERT INTO ${table("typed_telemetry_quota")}(
          record_id,dimensions_id,limit_id,slot_id,used_percent,window_duration_minutes,resets_at_ms)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [recordId, await quotaDimensions(owner, quota, attributionId), await dict(quota.limitId), await dict(quota.slot),
        quota.usedPercent, quota.windowDurationMinutes, quota.resetsAtMs]);
    } else {
      for (const [tool, count] of Object.entries(fields.tools)) {
        await q(`INSERT INTO ${table("typed_telemetry_session_tools")}(record_id,tool_class_id,count) VALUES ($1,$2,$3)`,
          [recordId, await dict(tool), count]);
      }
    }
    return { recordId, sourceRowId, fields, canonicalDigest };
  }

  async function uploadAuthorization(participantId, deviceId, contributionId, kind) {
    const authorizationId = `authorization-${digest(`authorization:${contributionId}`).slice(0, 32)}`;
    const envelope = digest(`envelope:${contributionId}`);
    const objectKey = `synthetic/analytics-v2/${digest(`object-key:${contributionId}`).slice(0, 32)}`;
    await q(`INSERT INTO ${table("device_upload_authorizations")}(
        id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,content_type,state,
        issued_at,expires_at,consumed_at,consumed_contribution_id)
      VALUES ($1,$2,$3,$4,$5,1,'application/json','consumed',$6,$7,$6,$8)`,
    [authorizationId, participantId, deviceId, blob(`authorization-secret:${contributionId}`), envelope,
      ISSUED, EXPIRES, contributionId]);
    await q(`INSERT INTO ${table("pending_objects")}(contribution_id,object_key,object_kind) VALUES ($1,$2,$3)`,
      [contributionId, objectKey, kind]);
    return { authorizationId, envelope, objectKey };
  }

  // ---- v1 chunks ------------------------------------------------------------
  let chunkSeq = 0;
  /** One fully accepted v1 chunk, admitted to typed storage and journaled for its owner. */
  async function v1Chunk({ participantId, deviceId, ownerDigest, stream, day, records }) {
    const chunkId = `chunk:${uuid(`v1-chunk:${participantId}:${deviceId}:${stream}:${day}:${chunkSeq}`)}`;
    const upload = await uploadAuthorization(participantId, deviceId, chunkId, "telemetry_v1");
    await q(`INSERT INTO ${table("telemetry_v1_chunks")}(
        id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,envelope_digest,parser_version,
        record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at)
      VALUES ($1,$2,$3,$4,$5::date,$6,1,$7,$8,'synthetic-analytics-v2',$9,$9,$10,$11,$12)`,
    [chunkId, participantId, deviceId, stream, day, chunkSeq++, digest(`chunk-digest:${chunkId}`), upload.envelope,
      records.length, upload.objectKey, upload.authorizationId, ISSUED]);
    const owner = await typedOwner(participantId);
    const typedDeviceId = await typedDevice(owner, deviceId);
    const chunkKey = id();
    const chunkOriginal = Buffer.from(codec.encodeTypedTelemetryId(chunkId));
    await q(`INSERT INTO ${table("typed_telemetry_chunks")}(
        id,namespace_id,format,owner_id,device_id,manifest_id,original_id,stream,chunk_day)
      VALUES ($1,1,10,$2,$3,NULL,$4,$5,$6)`, [chunkKey, owner.ownerId, typedDeviceId, chunkOriginal,
      STREAM_CODE[stream], dayNumber(day)]);
    const firstSourceRow = nextSourceRow;
    await q(`INSERT INTO ${table("typed_v1_chunk_allocations")}(
        chunk_id,namespace_id,chunk_original,first_source_row_id,record_count) VALUES ($1,1,$2,$3,$4)`,
    [chunkId, chunkOriginal, firstSourceRow, records.length]);
    const typed = [];
    for (const record of records) {
      const row = await typedRecord(owner, typedDeviceId, "v1", chunkKey, null, record);
      await q(`INSERT INTO ${table("typed_v1_record_admissions")}(typed_record_id,chunk_id) VALUES ($1,$2)`,
        [row.recordId, chunkId]);
      typed.push(row);
    }
    let sequence = null;
    if (ownerDigest !== null) {
      const eventDigest = digest(`v1-event:${chunkId}`);
      await q(`INSERT INTO ${table("typed_v1_event_sources")}(
          event_digest,owner_digest,participant_id,chunk_id,source_namespace) VALUES ($1,$2,$3,$4,$5)`,
      [eventDigest, ownerDigest, participantId, chunkId, SOURCE_NAMESPACE]);
      sequence = await journal("source-updated", ownerDigest, eventDigest);
    }
    return { chunkId, chunkKey, typedDeviceId, owner, typed, sequence };
  }

  // ---- v1.1 generations ------------------------------------------------------
  /**
   * One retained v1.1 generation of `days` ({ day, chunks: [{ stream, records }] }),
   * typed-admitted, made the participant's head, and (when linked) journaled.
   */
  async function v11Generation({ participantId, deviceId, ownerDigest, name, days }) {
    const owner = await typedOwner(participantId);
    const typedDeviceId = await typedDevice(owner, deviceId);
    const generationId = uuid(`v11-generation:${name}`);
    const generationDigest = digest(`v11-generation-digest:${name}`);
    const fingerprint = digest(`v11-fingerprint:${name}`);
    const token = digest(`v11-token:${name}`);
    const fromDay = days[0].day;
    const throughDay = days.at(-1).day;
    const daysJson = [];
    const manifests = [];
    for (const entry of days) {
      const manifestId = uuid(`v11-manifest:${name}:${entry.day}`);
      const manifestDigest = digest(`v11-manifest-digest:${name}:${entry.day}`);
      daysJson.push({ day: entry.day, manifestId, manifestDigest });
      await q(`INSERT INTO ${table("telemetry_v11_day_manifests")}(
          id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,
          expected_chunk_count,state,created_at,ready_at)
        VALUES ($1,$2,$3,$4::date,$5,'synthetic-analytics-v2',$6,$7,'ready',$8,$8)`,
      [manifestId, participantId, deviceId, entry.day, manifestDigest,
        JSON.stringify({ schemaVersion: "telemetry-day-manifest-v1.1", day: entry.day, chunks: [] }),
        entry.chunks.length, ISSUED]);
      const manifestKey = id();
      await q(`INSERT INTO ${table("typed_telemetry_manifests")}(id,namespace_id,owner_id,device_id,original_id,chunk_day)
        VALUES ($1,1,$2,$3,$4,$5)`, [manifestKey, owner.ownerId, typedDeviceId,
        Buffer.from(codec.encodeTypedTelemetryId(manifestId)), dayNumber(entry.day)]);
      const admitted = [];
      for (const [index, chunk] of entry.chunks.entries()) {
        const chunkId = `chunk:${uuid(`v11-chunk:${name}:${entry.day}:${index}`)}`;
        const upload = await uploadAuthorization(participantId, deviceId, chunkId, "telemetry_v11");
        await q(`INSERT INTO ${table("telemetry_v11_chunks")}(
            id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,
            envelope_digest,parser_version,record_count,r2_key,device_upload_authorization_id,created_at)
          VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'synthetic-analytics-v2',$11,$12,$13,$14)`,
        [chunkId, manifestId, participantId, deviceId, chunk.stream, entry.day, index,
          `${chunk.stream}:${entry.day}:${index}`, digest(`chunk-digest:${chunkId}`), upload.envelope,
          chunk.records.length, upload.objectKey, upload.authorizationId, ISSUED]);
        const chunkKey = id();
        const chunkOriginal = Buffer.from(codec.encodeTypedTelemetryId(chunkId));
        await q(`INSERT INTO ${table("typed_telemetry_chunks")}(
            id,namespace_id,format,owner_id,device_id,manifest_id,original_id,stream,chunk_day)
          VALUES ($1,1,11,$2,$3,$4,$5,$6,$7)`, [chunkKey, owner.ownerId, typedDeviceId, manifestKey, chunkOriginal,
          STREAM_CODE[chunk.stream], dayNumber(entry.day)]);
        await q(`INSERT INTO ${table("typed_v11_chunk_allocations")}(
            chunk_id,namespace_id,chunk_original,first_source_row_id,record_count) VALUES ($1,1,$2,$3,$4)`,
        [chunkId, chunkOriginal, nextSourceRow, chunk.records.length]);
        for (const record of chunk.records) {
          admitted.push({ chunkKey, stream: chunk.stream,
            row: await typedRecord(owner, typedDeviceId, "v11", chunkKey, manifestKey, record) });
        }
      }
      // 0033: the manifest membership needs its typed records, and each record
      // proof needs the membership and every declared chunk of the day.
      await q(`INSERT INTO ${table("typed_v11_manifest_memberships")}(manifest_id,typed_manifest_id) VALUES ($1,$2)`,
        [manifestId, manifestKey]);
      for (const { chunkKey, stream, row } of admitted) {
        await q(`INSERT INTO ${table("typed_v11_record_proofs")}(
            typed_record_id,chunk_key,manifest_key,stream_code,occurrence_blob,base_digest,
            legacy_occurrence_blob,legacy_digest,observed_at_ms)
          VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,$7)`,
        [row.recordId, chunkKey, manifestKey, STREAM_CODE[stream], Buffer.from(row.fields.occurrenceId),
          row.canonicalDigest, row.fields.observedAtMs]);
      }
      manifests.push({ manifestId, day: entry.day });
    }
    await q(`INSERT INTO ${table("telemetry_v11_domain_predecessors")}(
        token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,
        from_day,through_day,winners_json,created_at,expires_at)
      VALUES ($1,$2,$3,NULL,$4,0,$5::date,$6::date,'[]',$7,$8)`,
    [token, participantId, deviceId, fingerprint, fromDay, throughDay, ISSUED, EXPIRES]);
    await q(`INSERT INTO ${table("telemetry_v11_domains")}(
        id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,legacy_fingerprint,
        input_revision,from_day,through_day,days_json,created_at)
      VALUES ($1,$2,$3,$4,NULL,$5,$6,0,$7::date,$8::date,$9,$10)`,
    [generationId, participantId, deviceId, token, generationDigest, fingerprint, fromDay, throughDay,
      JSON.stringify(daysJson), ISSUED]);
    for (const manifest of manifests) {
      await q(`INSERT INTO ${table("telemetry_v11_domain_days")}(generation_id,observed_day,manifest_id)
        VALUES ($1,$2::date,$3)`, [generationId, manifest.day, manifest.manifestId]);
    }
    await q(`INSERT INTO ${table("telemetry_v11_domain_heads")}(participant_id,generation_id,revision,updated_at)
      VALUES ($1,$2,1,$3)`, [participantId, generationId, ISSUED]);
    let sequence = null;
    if (ownerDigest !== null) {
      const eventDigest = digest(`v11-event:${generationId}`);
      await q(`INSERT INTO ${table("storage_v11_event_sources")}(
          event_digest,owner_digest,participant_id,device_id,generation_id,manifest_digest,
          from_day,through_day,head_revision,input_revision,recorded_ms)
        VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,1,0,$9)`,
      [eventDigest, ownerDigest, participantId, deviceId, generationId, generationDigest, fromDay, throughDay,
        Date.parse(ISSUED)]);
      sequence = await journal("source-updated", ownerDigest, eventDigest);
    }
    return { generationId, sequence };
  }

  // ---- v1.2 generations ------------------------------------------------------
  const v12Attributions = new Map();
  async function v12Attribution(value) {
    const track = Buffer.from(value.accountTrack);
    const era = Buffer.from(value.planEra);
    const planType = await dict(value.planType);
    const keyText = [value.accountBasis, track.toString("hex"), value.planBasis, planType, era.toString("hex")].join(":");
    if (!v12Attributions.has(keyText)) {
      const key = id();
      await q(`INSERT INTO ${table("telemetry_v12_typed_attributions")}(
          id,account_basis,account_track,plan_basis,plan_type_id,plan_era) VALUES ($1,$2,$3,$4,$5,$6)`,
      [key, value.accountBasis, track, value.planBasis, planType, era]);
      v12Attributions.set(keyText, key);
    }
    return v12Attributions.get(keyText);
  }

  /**
   * One v1.2 generation of `days` ({ day, chunks }) for a device whose
   * capability is accepted: typed records are admitted while each manifest is
   * staged, then the manifest is made ready. `head` makes it the participant's
   * head, which fires the 0055 owner bridge (owner link, receipt, journal row).
   */
  async function v12Generation({ participantId, deviceId, name, days, head }) {
    const generationId = uuid(`v12-generation:${name}`);
    const fingerprint = digest(`v12-fingerprint:${name}`);
    const token = digest(`v12-token:${name}`);
    const fromDay = days[0].day;
    const throughDay = days.at(-1).day;
    const domainDays = [];
    for (const entry of days) {
      const manifestId = uuid(`v12-manifest:${name}:${entry.day}`);
      const manifestDigest = digest(`v12-manifest-digest:${name}:${entry.day}`);
      const chunks = [];
      for (const [index, chunk] of entry.chunks.entries()) {
        const records = [];
        for (const record of chunk.records) {
          records.push(await v12codec.encodeTelemetryV12Record(chunk.stream, record,
            async (canonical) => Buffer.from(await sha256Hex(canonical), "hex")));
        }
        // `declaredExtra` (v12Scope only) declares records the chunk never receives.
        chunks.push({ stream: chunk.stream, chunkId: `${chunk.stream}:${entry.day}:${index}`,
          rowId: `chunk:${uuid(`v12-chunk:${name}:${entry.day}:${index}`)}`,
          chunkDigest: digest(`v12-chunk-digest:${name}:${entry.day}:${index}`), records,
          declaredCount: records.length + (chunk.declaredExtra ?? 0) });
      }
      const manifestJson = JSON.stringify({ schemaVersion: "telemetry-day-manifest-v1.2", day: entry.day,
        chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest,
          recordCount: chunk.declaredCount })) });
      await q(`INSERT INTO ${table("telemetry_v12_day_manifests")}(
          id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,expected_chunk_count,
          state,created_at,ready_at)
        VALUES ($1,$2,$3,$4::date,$5,'synthetic-analytics-v2',$6,$7,'staged',$8,NULL)`,
      [manifestId, participantId, deviceId, entry.day, manifestDigest, manifestJson, chunks.length, ISSUED]);
      for (const [index, chunk] of chunks.entries()) {
        const upload = await uploadAuthorization(participantId, deviceId, chunk.rowId, "telemetry_v12");
        await q(`INSERT INTO ${table("telemetry_v12_chunks")}(
            id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,
            envelope_digest,parser_version,record_count,r2_key,device_upload_authorization_id,created_at)
          VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'synthetic-analytics-v2',$11,$12,$13,$14)`,
        [chunk.rowId, manifestId, participantId, deviceId, chunk.stream, entry.day, index, chunk.chunkId,
          chunk.chunkDigest, upload.envelope, chunk.declaredCount, upload.objectKey, upload.authorizationId, ISSUED]);
        for (const [recordIndex, fields] of chunk.records.entries()) {
          const recordId = id();
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
              await v12Attribution(usage.attribution), usage.totalInputContextTokens, usage.inputUncachedTokens,
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
              await v12Attribution(quota.attribution)]);
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
        // v12Scope only: the manifest stays staged; nothing may read its records.
      } else if (incomplete) {
        // v12Scope only: a ready manifest with an incomplete chunk is a state
        // the ready-integrity guard (0028) forbids. It is built here with that
        // one statement's triggers bypassed, so the reader's own chunk
        // completeness check can be tested.
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
    }
    await q(`INSERT INTO ${table("telemetry_v12_domain_predecessors")}(
        token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,
        from_day,through_day,winners_json,created_at,expires_at)
      VALUES ($1,$2,$3,NULL,$4,0,$5::date,$6::date,'[]',$7,$8)`,
    [token, participantId, deviceId, fingerprint, fromDay, throughDay, ISSUED, EXPIRES]);
    await q(`INSERT INTO ${table("telemetry_v12_domains")}(
        id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,legacy_fingerprint,
        input_revision,from_day,through_day,days_json,created_at)
      VALUES ($1,$2,$3,$4,NULL,$5,$6,0,$7::date,$8::date,$9,$10)`,
    [generationId, participantId, deviceId, token, digest(`v12-generation-digest:${name}`), fingerprint, fromDay,
      throughDay, JSON.stringify(domainDays), ISSUED]);
    for (const entry of domainDays) {
      await q(`INSERT INTO ${table("telemetry_v12_domain_days")}(generation_id,observed_day,manifest_id,manifest_digest)
        VALUES ($1,$2::date,$3,$4)`, [generationId, entry.day, entry.manifestId, entry.manifestDigest]);
    }
    if (head) {
      await q(`INSERT INTO ${table("telemetry_v12_domain_heads")}(participant_id,generation_id,revision,updated_at)
        VALUES ($1,$2,1,$3)`, [participantId, generationId, ISSUED]);
    }
    return { generationId };
  }

  // ---- v0.2 legacy contributions ----------------------------------------------
  async function legacyContribution(participantId, name) {
    const contributionId = `contribution-${digest(`v02:${name}`).slice(0, 32)}`;
    const client = await pool.connect();
    try {
      // Legacy telemetry triggers resolve their relations through the runtime
      // search path, as the Cloud Run host sets it.
      await client.query(`SET search_path TO ${quoted}, pg_catalog`);
      await client.query(`INSERT INTO ${table("telemetry_contributions")}(
          id,participant_id,plaintext_digest,envelope_digest,r2_key,schema_version,transport_schema_version,
          range_start,range_end,client_platform,provider_policy_epoch,priced_event_coverage_percent,
          unknown_model_event_count,unknown_billable_units,price_basis,declared_record_count,created_at)
        VALUES ($1,$2,$3,$4,$5,'telemetry-contribution-v0.1','telemetry-contribution-v0.2',$6,$6,'synthetic',
          'synthetic',100,0,0,'synthetic',0,$6)`,
      [contributionId, participantId, digest(`plain:${contributionId}`), digest(`envelope:${contributionId}`),
        `synthetic/analytics-v2/${digest(`v02-key:${name}`).slice(0, 32)}`, ISSUED]);
    } finally {
      await client.query("RESET search_path").catch(() => {});
      client.release();
    }
  }

  // ---- usage-correction history ----------------------------------------------
  /** One archived v1 usage variant and its method-1 fact (0034), for a v1 source chunk. */
  async function correctionFact({ participantId, ownerDigest, chunk, record }) {
    const recordJson = JSON.stringify(record);
    const assertion = await reconciliation.prepareUsageCorrectionAssertion({ format: "v1", recordJson });
    const fields = codec.encodeTypedTelemetryRecord("v1", record);
    const owner = chunk.owner;
    const revision = await q(`SELECT revision::text AS revision,authority_epoch::text AS epoch
      FROM ${table("storage_owner_revisions")} WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, ownerDigest]);
    const historyId = id();
    const usage = fields.usage;
    await q(`INSERT INTO ${table("telemetry_usage_correction_history")}(
        id,participant_id,owner_digest,owner_revision,authority_epoch,source_format,namespace_id,owner_id,device_id,
        chunk_id,manifest_id,source_storage_row_id,source_row_id,occurrence_id,event_time_ms,provider_id,session_id,
        model_id,speed_mode_id,api_service_tier_id,surface_id,billing_surface_id,reasoning_effort_id,agent_scope_id,
        outcome_id,attribution_id,total_input_context_tokens,input_uncached_tokens,input_cache_read_tokens,
        input_cache_write_tokens,output_text_tokens,output_reasoning_tokens,output_combined_tokens,
        source_chunk_digest,source_event_digest,record_digest,base_digest,captured_at_ms)
      VALUES ($1,$2,$3,$4,$5,10,1,$6,$7,$8,NULL,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NULL,
        $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)`,
    [historyId, participantId, Buffer.from(ownerDigest, "hex"), Number(revision.rows[0].revision),
      Number(revision.rows[0].epoch), owner.ownerId, chunk.typedDeviceId, chunk.chunkKey,
      chunk.typed[0].recordId, chunk.typed[0].sourceRowId, Buffer.from(fields.occurrenceId), fields.observedAtMs,
      await dict(fields.provider), await identifier(owner, usage.sessionId), await dict(usage.modelId),
      await dict(usage.speedMode), await dict(usage.apiServiceTier), await dict(usage.surface),
      await dict(usage.billingSurface), await dict(usage.reasoningEffort), await dict(usage.agentScope),
      await dict(usage.outcome), usage.totalInputContextTokens, usage.components.inputUncachedTokens,
      usage.components.inputCacheReadTokens, usage.components.inputCacheWriteTokens,
      usage.components.outputTextTokens, usage.components.outputReasoningTokens,
      usage.components.outputCombinedTokens, blob(`correction-chunk:${historyId}`),
      blob(`correction-event:${historyId}`), Buffer.from(assertion.recordDigest, "hex"),
      Buffer.from(assertion.baseDigest, "hex"), Date.parse(ISSUED)]);
    await q(`INSERT INTO ${table("telemetry_usage_correction_facts")}(id,history_id,method_version,captured_at_ms)
      VALUES ($1,$2,1,$3)`, [id(), historyId, Date.parse(ISSUED)]);
  }

  // =========================================================================
  // alpha: social, v1 + v1.1 + v1.2, four devices.
  const alphaId = await participant("alpha", "social");
  const alphaV1 = await socialDevice(alphaId, "alpha-v1");
  const alphaV11 = await socialDevice(alphaId, "alpha-v11");
  const alphaV12 = await socialDevice(alphaId, "alpha-v12", { v12: true });
  const alphaV12Empty = await socialDevice(alphaId, "alpha-v12-empty", { v12: true });
  const alphaDigest = await linkOwner(alphaId, "alpha");
  const alphaV1Usage = await v1Chunk({ participantId: alphaId, deviceId: alphaV1, ownerDigest: alphaDigest,
    stream: "usage", day: D1, records: [
      usageRecord("v1", OCCURRENCES.shared, at(D1, "10:00:00")),
      usageRecord("v1", OCCURRENCES.crossed, at(D1, "23:59:59")),
    ] });
  const alphaV1Quota = await v1Chunk({ participantId: alphaId, deviceId: alphaV1, ownerDigest: alphaDigest,
    stream: "quota", day: D1, records: [quotaRecord("v1", OCCURRENCES.quota, at(D1, "11:00:00"))] });
  const alphaV11Generation = await v11Generation({ participantId: alphaId, deviceId: alphaV11, ownerDigest: alphaDigest,
    name: "alpha-v11", days: [
      { day: D1, chunks: [
        { stream: "usage", records: [usageRecord("v11", OCCURRENCES.shared, at(D1, "10:00:00"))] },
        { stream: "quota", records: [quotaRecord("v11", OCCURRENCES.quota, at(D1, "11:00:00"))] },
      ] },
      { day: D2, chunks: [
        { stream: "usage", records: [
          usageRecord("v11", OCCURRENCES.crossed, at(D2, "00:00:01")),
          usageRecord("v11", OCCURRENCES.v11Only, at(D2, "09:30:00")),
        ] },
      ] },
    ] });
  // The empty-day generation of the fourth device is not the head: its ready
  // manifest has no chunk, so the device-count rule never counts it.
  await v12Generation({ participantId: alphaId, deviceId: alphaV12Empty, name: "alpha-v12-empty",
    days: [{ day: D1, chunks: [] }], head: false });
  const alphaV12Generation = await v12Generation({ participantId: alphaId, deviceId: alphaV12, name: "alpha-v12",
    days: [{ day: D1, chunks: [{ stream: "usage", records: [
      usageRecord("v12", OCCURRENCES.shared, at(D1, "10:00:00")),
      usageRecord("v12", OCCURRENCES.v12Only, at(D1, "15:00:00")),
    ] }] }], head: true });

  // bravo: social, v1 + accepted v0.2; a correction fact reports the totals
  // its current row leaves unknown.
  const bravoId = await participant("bravo", "social");
  const bravoDevice = await socialDevice(bravoId, "bravo-v1");
  const bravoDigest = await linkOwner(bravoId, "bravo");
  const unknownTotals = { totalInputContextTokens: null, components: {
    inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
    outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null } };
  const bravoChunk = await v1Chunk({ participantId: bravoId, deviceId: bravoDevice, ownerDigest: bravoDigest,
    stream: "usage", day: D1, records: [usageRecord("v1", OCCURRENCES.corrected, at(D1, "12:00:00"), unknownTotals)] });
  await correctionFact({ participantId: bravoId, ownerDigest: bravoDigest, chunk: bravoChunk,
    record: usageRecord("v1", OCCURRENCES.corrected, at(D1, "12:00:00"), {
      totalInputContextTokens: CORRECTED_TOTALS.totalInputContextTokens,
      components: { ...unknownTotals.components, outputCombinedTokens: CORRECTED_TOTALS.outputCombinedTokens },
    }) });
  if (expansionCorrections) {
    for (let offset = 0; offset < 420; offset += 200) {
      const records = Array.from({ length: Math.min(200, 420 - offset) }, (_, index) =>
        usageRecord("v1", `event:readexp:${String(offset + index).padStart(5, "0")}`, at(D1, "12:00:00"), unknownTotals));
      const chunk = await v1Chunk({ participantId: bravoId, deviceId: bravoDevice, ownerDigest: bravoDigest,
        stream: "usage", day: D1, records });
      for (let index = 0; index < records.length; index += 1) {
        for (let variant = 0; variant < 3; variant += 1) {
          await correctionFact({ participantId: bravoId, ownerDigest: bravoDigest,
            chunk: { ...chunk, typed: [chunk.typed[index]] },
            record: { ...records[index], totalInputContextTokens: 1000 + variant,
              components: { ...unknownTotals.components, outputCombinedTokens: CORRECTED_TOTALS.outputCombinedTokens } } });
        }
      }
    }
  }
  await legacyContribution(bravoId, "bravo");

  // charlie: social, accepted v0.2 only.
  const charlieId = await participant("charlie", "social");
  const charlieDigest = await linkOwner(charlieId, "charlie");
  await legacyContribution(charlieId, "charlie");

  // golf: social, no evidence and no owner link (listed explicitly as unlinked).
  const golfId = await participant("golf", "social");

  // echo: accountless, opted out after acceptance with a retained marker.
  const echoId = await participant("echo", "accountless");
  const echoDevice = await accountlessDevice(echoId, "echo-v11");
  const echoDigest = await linkOwner(echoId, "echo");
  const echoGeneration = await v11Generation({ participantId: echoId, deviceId: echoDevice, ownerDigest: echoDigest,
    name: "echo-v11", days: [{ day: D1, chunks: [
      { stream: "usage", records: [usageRecord("v11", OCCURRENCES.echo, at(D1, "08:00:00"))] },
    ] }] });
  const retainedAt = "2026-09-30T06:00:00.000Z";
  await q(`INSERT INTO ${table("accountless_public_history_retention")}(
      participant_id,enrollment_device_id,device_credential_id,generation_id,head_revision,retained_at)
    VALUES ($1,$2,$2,$3,1,$4)`, [echoId, echoDevice, echoGeneration.generationId, retainedAt]);
  await revokeAccountless(echoDevice, "user_opt_out", retainedAt);

  // delta: accountless, disconnected by a security reset (no retained marker).
  const deltaId = await participant("delta", "accountless");
  const deltaDevice = await accountlessDevice(deltaId, "delta-v11");
  const deltaDigest = await linkOwner(deltaId, "delta");
  await v11Generation({ participantId: deltaId, deviceId: deltaDevice, ownerDigest: deltaDigest, name: "delta-v11",
    days: [{ day: D3, chunks: [
      { stream: "usage", records: [usageRecord("v11", `event:v2:${digest("occurrence:delta")}`, at(D3, "08:00:00"))] },
    ] }] });
  await revokeAccountless(deltaDevice, "security_reset", "2026-09-30T07:00:00.000Z");

  // hotel (opt-in): a v1.2-only social owner with one dense usage day.
  let hotel = null;
  if (dense !== null) {
    if (!Number.isSafeInteger(dense.usage) || dense.usage < 1 || !/^\d{4}-\d{2}-\d{2}$/u.test(dense.day)) {
      throw new Error("fixture_dense_invalid");
    }
    const hotelId = await participant("hotel", "social");
    const hotelDevice = await socialDevice(hotelId, "hotel-v12", { v12: true });
    const hotelDigest = await linkOwner(hotelId, "hotel");
    const start = Date.parse(`${dense.day}T00:00:00.000Z`);
    const spacing = Math.floor(86_000_000 / dense.usage);
    const records = Array.from({ length: dense.usage }, (_, index) =>
      usageRecord("v12", `event:v2:${digest(`occurrence:hotel:${index}`)}`,
        new Date(start + 1_000 + index * spacing).toISOString()));
    const chunks = [];
    for (let offset = 0; offset < records.length; offset += 200) {
      chunks.push({ stream: "usage", records: records.slice(offset, offset + 200) });
    }
    await v12Generation({ participantId: hotelId, deviceId: hotelDevice, name: "hotel-v12",
      days: [{ day: dense.day, chunks }], head: true });
    hotel = Object.freeze({ participantId: hotelId, ownerDigest: hotelDigest, devices: Object.freeze([hotelDevice]) });
  }

  // india and juliet (opt-in): one occurrence with one eligible v1.2 record
  // and three variants the v1.2 reader must exclude (see the module comment).
  let india = null;
  let juliet = null;
  if (v12Scope) {
    const scoped = (time) => usageRecord("v12", OCCURRENCES.scoped, at(D1, time));
    const indiaId = await participant("india", "social");
    const indiaEligible = await socialDevice(indiaId, "india-v12", { v12: true });
    const indiaStaged = await socialDevice(indiaId, "india-v12-staged", { v12: true });
    const indiaIncomplete = await socialDevice(indiaId, "india-v12-incomplete", { v12: true });
    const indiaDigest = await linkOwner(indiaId, "india");
    await v12Generation({ participantId: indiaId, deviceId: indiaEligible, name: "india-v12",
      days: [{ day: D1, chunks: [{ stream: "usage", records: [scoped("11:00:00")] }] }], head: true });
    await v12Generation({ participantId: indiaId, deviceId: indiaStaged, name: "india-v12-staged",
      days: [{ day: D1, ready: false, chunks: [{ stream: "usage", records: [scoped("11:30:00")] }] }], head: false });
    await v12Generation({ participantId: indiaId, deviceId: indiaIncomplete, name: "india-v12-incomplete",
      days: [{ day: D1, chunks: [{ stream: "usage", records: [scoped("11:45:00")], declaredExtra: 1 }] }],
      head: false });
    india = Object.freeze({ participantId: indiaId, ownerDigest: indiaDigest,
      devices: Object.freeze([indiaEligible, indiaStaged, indiaIncomplete]) });
    const julietId = await participant("juliet", "social");
    const julietDevice = await socialDevice(julietId, "juliet-v12", { v12: true });
    const julietDigest = await linkOwner(julietId, "juliet");
    await v12Generation({ participantId: julietId, deviceId: julietDevice, name: "juliet-v12",
      days: [{ day: D1, chunks: [{ stream: "usage", records: [scoped("12:30:00")] }] }], head: true });
    juliet = Object.freeze({ participantId: julietId, ownerDigest: julietDigest, devices: Object.freeze([julietDevice]) });
  }

  // kilo (opt-in): a dense v1 + v1.1 legacy owner (see the module comment).
  let kilo = null;
  if (denseLegacy !== null) {
    const { days, usagePerDay, v1PerDay = 0, throughDay = D3 } = denseLegacy;
    if (!Number.isSafeInteger(days) || days < 1 || days > 400 || !Number.isSafeInteger(usagePerDay)
        || usagePerDay < 1 || !Number.isSafeInteger(v1PerDay) || v1PerDay < 0 || !/^\d{4}-\d{2}-\d{2}$/u.test(throughDay)) {
      throw new Error("fixture_dense_legacy_invalid");
    }
    const kiloId = await participant("kilo", "social");
    const kiloV11 = await socialDevice(kiloId, "kilo-v11");
    const kiloV1 = await socialDevice(kiloId, "kilo-v1");
    const kiloDigest = await linkOwner(kiloId, "kilo");
    const spacing = Math.floor(86_000_000 / Math.max(usagePerDay, v1PerDay));
    const occurrence = (day, index) => `event:v2:${digest(`occurrence:kilo:${day}:${index}`)}`;
    const timeOf = (day, index) => new Date(Date.parse(`${day}T00:00:00.000Z`) + 1_000 + index * spacing).toISOString();
    const chunked = (records) => {
      const result = [];
      for (let offset = 0; offset < records.length; offset += 200) result.push(records.slice(offset, offset + 200));
      return result;
    };
    const dayList = Array.from({ length: days }, (_, index) =>
      new Date((dayNumber(throughDay) - (days - 1) + index) * DAY_MS).toISOString().slice(0, 10));
    await v11Generation({ participantId: kiloId, deviceId: kiloV11, ownerDigest: kiloDigest, name: "kilo-v11",
      days: dayList.map((day) => ({ day, chunks: chunked(Array.from({ length: usagePerDay }, (_, index) =>
        usageRecord("v11", occurrence(day, index), timeOf(day, index)))).map((records) => ({ stream: "usage", records })) })) });
    for (const day of dayList) {
      const records = Array.from({ length: v1PerDay }, (_, index) => {
        const shared = index % 10 === 0 && index < usagePerDay;
        return usageRecord("v1", shared ? occurrence(day, index) : occurrence(day, `v1:${index}`), timeOf(day, index),
          shared ? { sessionUuid: uuid(`session:${occurrence(day, index)}`) } : {});
      });
      for (const chunk of chunked(records)) {
        await v1Chunk({ participantId: kiloId, deviceId: kiloV1, ownerDigest: kiloDigest, stream: "usage", day,
          records: chunk });
      }
    }
    kilo = Object.freeze({ participantId: kiloId, ownerDigest: kiloDigest, devices: Object.freeze([kiloV11, kiloV1]),
      days: Object.freeze(dayList) });
  }

  // lima and mike (opt-in): one legacy occurrence with one eligible record and
  // three variants the legacy readers must exclude, plus first- and
  // last-instant records (see the module comment).
  let lima = null;
  let mike = null;
  if (legacyScope) {
    const scoped = (format, time) => usageRecord(format, OCCURRENCES.legacyScoped, at(D1, time));
    const limaId = await participant("lima", "social");
    const limaEligible = await socialDevice(limaId, "lima-v1");
    const limaSuperseded = await socialDevice(limaId, "lima-v1-superseded");
    const limaIncomplete = await socialDevice(limaId, "lima-v1-incomplete");
    const limaV11 = await socialDevice(limaId, "lima-v11");
    const limaDigest = await linkOwner(limaId, "lima");
    await v1Chunk({ participantId: limaId, deviceId: limaEligible, ownerDigest: limaDigest, stream: "usage", day: D1,
      records: [scoped("v1", "10:00:00")] });
    const superseded = await v1Chunk({ participantId: limaId, deviceId: limaSuperseded, ownerDigest: limaDigest,
      stream: "usage", day: D1, records: [scoped("v1", "10:30:00")] });
    await q(`UPDATE ${table("telemetry_v1_chunks")} SET superseded_at=$2 WHERE id=$1`, [superseded.chunkId, ISSUED]);
    const incomplete = await v1Chunk({ participantId: limaId, deviceId: limaIncomplete, ownerDigest: limaDigest,
      stream: "usage", day: D1, records: [scoped("v1", "10:45:00"), usageRecord("v1",
        `event:v2:${digest("occurrence:legacy-incomplete-peer")}`, at(D1, "10:46:00"))] });
    await q(`UPDATE ${table("telemetry_v1_chunks")} SET accepted_record_count=record_count-1 WHERE id=$1`,
      [incomplete.chunkId]);
    await v11Generation({ participantId: limaId, deviceId: limaV11, ownerDigest: limaDigest, name: "lima-v11", days: [
      { day: D1, chunks: [{ stream: "usage", records: [usageRecord("v11", OCCURRENCES.legacyFirst,
        `${D1}T00:00:00.000Z`)] }] },
      { day: D3, chunks: [{ stream: "usage", records: [usageRecord("v11", OCCURRENCES.legacyLast,
        `${D3}T23:59:59.999Z`)] }] },
    ] });
    lima = Object.freeze({ participantId: limaId, ownerDigest: limaDigest,
      devices: Object.freeze([limaEligible, limaSuperseded, limaIncomplete, limaV11]) });
    const mikeId = await participant("mike", "social");
    const mikeV11 = await socialDevice(mikeId, "mike-v11");
    const mikeDigest = await linkOwner(mikeId, "mike");
    await v11Generation({ participantId: mikeId, deviceId: mikeV11, ownerDigest: mikeDigest, name: "mike-v11",
      days: [{ day: D1, chunks: [{ stream: "usage", records: [scoped("v11", "11:00:00")] }] }] });
    mike = Object.freeze({ participantId: mikeId, ownerDigest: mikeDigest, devices: Object.freeze([mikeV11]) });
  }

  // Opt-in real SQL expansion boundary: 200 occurrences on 200 eligible
  // independent source devices (40000 variants), plus one final variant.
  // Every row passes the existing transport, codec and admission builders.
  let boundary = null;
  if (expansionBoundary !== null) {
    if (!["legacy", "v12"].includes(expansionBoundary)) throw new Error("fixture_boundary_invalid");
    const name = `boundary-${expansionBoundary}`;
    const participantId = await participant(name, "social");
    const ownerDigest = await linkOwner(participantId, name);
    const format = expansionBoundary === "legacy" ? "v1" : "v12";
    const records = Array.from({ length: 200 }, (_, index) => usageRecord(format,
      `event:v2:${digest(`occurrence:${name}:${index}`)}`,
      new Date(Date.parse(`${D1}T00:00:00.000Z`) + 1000 + index).toISOString()));
    async function addSource(index) {
      const deviceName = `${name}-${index}`;
      const deviceId = await socialDevice(participantId, deviceName, { v12: format === "v12" });
      const batch = index === 200 ? records.slice(0, 1) : records;
      if (format === "v1") {
        await v1Chunk({ participantId, deviceId, ownerDigest, stream: "usage", day: D1, records: batch });
      } else {
        await v12Generation({ participantId, deviceId, name: deviceName,
          days: [{ day: D1, chunks: [{ stream: "usage", records: batch }] }], head: index === 0 });
      }
      return deviceId;
    }
    for (let index = 0; index < 200; index += 1) await addSource(index);
    let enabled = false;
    const enableExtraSource = async () => {
      if (enabled) throw new Error("fixture_boundary_extra_already_enabled");
      await addSource(200);
      enabled = true;
    };
    boundary = Object.freeze({ participantId, ownerDigest, enableExtraSource,
      occurrenceIds: Object.freeze(records.map((record) => record.eventId)) });
  }

  const lastSequence = Number((await q(`SELECT COALESCE(max(sequence),0)::text AS sequence
    FROM ${table("storage_ingestion_changes")}`)).rows[0].sequence);
  return Object.freeze({
    owners: Object.freeze({
      alpha: Object.freeze({ participantId: alphaId, ownerDigest: alphaDigest,
        devices: Object.freeze([alphaV1, alphaV11, alphaV12, alphaV12Empty]) }),
      bravo: Object.freeze({ participantId: bravoId, ownerDigest: bravoDigest, devices: Object.freeze([bravoDevice]) }),
      charlie: Object.freeze({ participantId: charlieId, ownerDigest: charlieDigest, devices: Object.freeze([]) }),
      golf: Object.freeze({ participantId: golfId, ownerDigest: null, devices: Object.freeze([]) }),
      echo: Object.freeze({ participantId: echoId, ownerDigest: echoDigest, devices: Object.freeze([echoDevice]) }),
      delta: Object.freeze({ participantId: deltaId, ownerDigest: deltaDigest, devices: Object.freeze([deltaDevice]) }),
      ...(hotel === null ? {} : { hotel }),
      ...(india === null ? {} : { india, juliet }),
      ...(kilo === null ? {} : { kilo }),
      ...(lima === null ? {} : { lima, mike }),
    }),
    sequences: Object.freeze({
      alphaV1Usage: alphaV1Usage.sequence, alphaV1Quota: alphaV1Quota.sequence,
      alphaV11: alphaV11Generation.sequence, bravo: bravoChunk.sequence, last: lastSequence,
    }),
    alphaV12GenerationId: alphaV12Generation.generationId,
    ...(boundary === null ? {} : { boundary }),
  });
}
