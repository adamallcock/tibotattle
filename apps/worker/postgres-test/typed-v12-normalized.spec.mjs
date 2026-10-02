import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  canonicalTelemetryV12Json,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { createServer } from "vite";
import pg from "pg";
import {
  applyPostgresMigrations,
  POSTGRES_MIGRATION_ROOT,
  readPostgresMigrations,
} from "../scripts/postgres-migrations.mjs";
const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const BASELINE_PRIMARY_VERSION = 24;
const schema = `typed_v12_test_${randomBytes(8).toString("hex")}`;
const options = Object.freeze({
  schema: Object.freeze({ primarySchema: schema }),
});
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DAY = "2026-09-20";
const USAGE_SCAN_FIXTURE_RECORDS = 2_049;

async function admitSyntheticUsageDay({ pool, schema, options, nowEpoch, modules }) {
  const table = (name) => `"${schema}"."${name}"`;
  const now = new Date(nowEpoch).toISOString();
  const expires = new Date(nowEpoch + 10 * 60_000).toISOString();
  const participantId = `synthetic-participant-${randomBytes(5).toString("hex")}`;
  const deviceId = `synthetic-device-${randomBytes(5).toString("hex")}`;
  const sessionId = `synthetic-session-${randomBytes(5).toString("hex")}`;
  const pairingId = randomUUID();
  const principal = { participantId, deviceId };
  const pairSecret = randomBytes(32);

  await pool.query(`UPDATE ${table("telemetry_v12_runtime")} SET state='active', changed_at=$1 WHERE id=1`, [now]);
  await pool.query(`UPDATE ${table("telemetry_v12_typed_runtime")} SET state='active', changed_at=$1 WHERE id=1`, [now]);
  // A social owner must carry the current participant consent before the typed
  // v1.2 admission accepts a write (TELEMETRY_REQUIRED otherwise), matching the
  // live enrollment path and the sibling PostgreSQL transport specs.
  await pool.query(
    `INSERT INTO ${table("participants")} (id, owner_kind, state, consent_version, created_at)
     VALUES ($1, 'social', 'active', $2, $3)`,
    [participantId, modules.TELEMETRY_CONSENT_VERSION, now],
  );
  await pool.query(
    `INSERT INTO ${table("web_sessions")} (
       id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$5)`,
    [sessionId, participantId, pairSecret, randomBytes(32), now, expires],
  );
  await pool.query(
    `INSERT INTO ${table("device_pairings")} (
       id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
     ) VALUES ($1,$2,$3,$4,'synthetic-consent-v1','synthetic-transport-v1','consumed',$5,$6,$5,$7)`,
    [pairingId, participantId, sessionId, pairSecret, now, expires, deviceId],
  );
  await pool.query(
    `INSERT INTO ${table("device_credentials")} (
       id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
       state, issued_at, expires_at, last_used_at, social_verified_at
     ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`,
    [deviceId, participantId, pairingId, randomBytes(32), now, expires],
  );
  await pool.query(
    `INSERT INTO ${table("telemetry_v12_device_capabilities")} (
       participant_id, device_id, telemetry_schema_version, field_dictionary_version,
       privacy_contract_version, state, consented_at
     ) VALUES ($1,$2,$3,$4,$5,'accepted',$6)`,
    [participantId, deviceId, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      TELEMETRY_V12_FIELD_DICTIONARY_VERSION, TELEMETRY_V12_PRIVACY_CONTRACT_VERSION, now],
  );
  await pool.query(
    `INSERT INTO ${table("storage_v11_owner_links")} (participant_id, owner_digest, state)
     VALUES ($1,$2,'active')`,
    [participantId, randomBytes(32).toString("hex")],
  );

  const consent = telemetryV12RequiredConsent();
  const firstDayMs = Date.parse(`${FIXTURE_DAY}T00:00:00.000Z`);
  const records = Array.from({ length: USAGE_SCAN_FIXTURE_RECORDS }, (_, index) => ({
    schemaVersion: "usage-event-v1.2",
    eventId: `event:v2:${(index + 1).toString(16).padStart(64, "0")}`,
    eventTime: new Date(firstDayMs + (Math.floor(index / 5) + 1) * 1_000).toISOString(),
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 1000,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: 75,
    },
    accountPlanAttribution: {
      accountBasis: "unavailable",
      accountTrackId: null,
      planBasis: "same_source_occurrence",
      planType: "pro",
      planEraId: null,
    },
    boundaryFlags: null,
    tieOrder: null,
    cacheWriteTtl: null,
  }));
  const parserVersion = "synthetic-pg-v12";
  const quotaRecord = {
    schemaVersion: "quota-observation-v1.2",
    observationId: "quota:v12:typed-reader-1",
    observedTime: `${FIXTURE_DAY}T12:05:00.000Z`,
    provider: "openai_codex",
    planType: "pro",
    planVariant: "unknown",
    limitId: "codex",
    slot: "primary",
    usedPercent: 20,
    windowDurationMinutes: 10_080,
    resetsAt: `${FIXTURE_DAY}T13:05:00.000Z`,
    accountPlanAttribution: {
      accountBasis: "unavailable",
      accountTrackId: null,
      planBasis: "same_source_occurrence",
      planType: "pro",
      planEraId: null,
    },
  };
  const sessionRecord = {
    schemaVersion: "session-dimension-v1.2",
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    firstEventTime: `${FIXTURE_DAY}T12:06:00.000Z`,
    provider: "openai_codex",
    toolClassCounts: { localShell: 3, web: 1 },
  };
  const makeChunk = async (stream, sequence, chunkRecords) => {
    const chunkId = `${stream}:${FIXTURE_DAY}:${sequence}`;
    return {
      schemaVersion: "telemetry-contribution-v1.2",
      manifestDigest: "0".repeat(64),
      chunkId,
      chunkRevision: 1,
      parserVersion,
      consent,
      records: chunkRecords,
      chunkDigest: await modules.sha256Hex(canonicalTelemetryV12Json(chunkRecords)),
    };
  };
  const usageChunks = [];
  for (let start = 0; start < records.length; start += 200) {
    usageChunks.push(await makeChunk("usage", usageChunks.length, records.slice(start, start + 200)));
  }
  const chunks = [
    await makeChunk("quota", 0, [quotaRecord]),
    await makeChunk("session", 0, [sessionRecord]),
    ...usageChunks,
  ];
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.2",
    day: FIXTURE_DAY,
    parserVersion,
    consent,
    chunks: chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      chunkDigest: chunk.chunkDigest,
      recordCount: chunk.records.length,
    })),
    excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await modules.sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  for (const chunk of chunks) chunk.manifestDigest = manifest.manifestDigest;
  const candidate = await modules.registerPostgresTypedV12DayManifest(
    pool, principal, manifest, nowEpoch, options,
  );
  const usageOrderPages = [];
  const scanObservedPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          const result = await client.query(text, values);
          if (text.includes("SELECT chunk.stream AS chunk_stream")) usageOrderPages.push(result.rows.length);
          return result;
        },
        release(discard) { return client.release(discard); },
      };
    },
  };
  const firstChunkRowByStream = new Map();
  let replayFixture;
  for (const chunk of chunks) {
    const envelopeDigest = await modules.sha256Hex(`synthetic-pg-v12-envelope:${chunk.chunkId}`);
    const authorizationId = `synthetic-auth-${randomBytes(5).toString("hex")}`;
    const chunkRowId = `chunk:${randomUUID()}`;
    const r2Key = `synthetic/pg-v12-${randomBytes(12).toString("hex")}`;
    const metadata = {
      chunkRowId,
      r2Key,
      envelopeDigest,
      deviceUploadAuthorizationId: authorizationId,
    };
    await pool.query(
      `INSERT INTO ${table("device_upload_authorizations")} (
         id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
         body_bytes, content_type, state, issued_at, expires_at, consume_lease_expires_at
       ) VALUES ($1,$2,$3,$4,$5,4096,'application/json','consuming',$6,$7,$7)`,
      [authorizationId, participantId, deviceId, randomBytes(32), envelopeDigest, now, expires],
    );
    await pool.query(
      `INSERT INTO ${table("pending_objects")} (contribution_id, object_key, object_kind)
       VALUES ($1,$2,'telemetry_v12')`,
      [chunkRowId, r2Key],
    );
    await modules.persistPostgresTypedV12StagedChunk(
      scanObservedPool, principal, chunk, metadata, nowEpoch, options,
    );
    if (!firstChunkRowByStream.has(chunk.chunkId.split(":", 1)[0])) {
      firstChunkRowByStream.set(chunk.chunkId.split(":", 1)[0], chunkRowId);
    }
    if (chunk.chunkId.startsWith("quota:")) replayFixture = { chunk, metadata };
  }
  return {
    principal,
    records,
    quotaRecord,
    sessionRecord,
    candidate,
    usageChunkRowId: firstChunkRowByStream.get("usage"),
    quotaChunkRowId: firstChunkRowByStream.get("quota"),
    sessionChunkRowId: firstChunkRowByStream.get("session"),
    replayFixture,
    usageOrderPages,
    nowEpoch,
  };
}

test("PostgreSQL normalized telemetry v1.2 migrates forward from primary version 24", {
  skip: !PG_TEST_HOST,
}, async () => {
  let pool;
  let tempRoot;
  let schemaCreated = false;
  let vite;
  try {
    pool = new pg.Pool({
      host: PG_TEST_HOST,
      port: PG_TEST_PORT,
      user: PG_TEST_USER,
      ...(PG_TEST_PASSWORD === undefined ? {} : { password: PG_TEST_PASSWORD }),
      database: PG_TEST_DATABASE,
      ssl: false,
      max: 2,
      connectionTimeoutMillis: 3_000,
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;

    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
    });
    const admission =
      await vite.ssrLoadModule("/src/postgres-typed-v12-admission.ts");
    const reader =
      await vite.ssrLoadModule("/src/postgres-typed-v12-effective-reader.ts");
    const { createPostgresTypedV12Domain } =
      await vite.ssrLoadModule("/src/postgres-typed-v12-domain.ts");
    const { sha256Hex } = await vite.ssrLoadModule("/src/crypto.ts");
    const { TELEMETRY_CONSENT_VERSION } = await vite.ssrLoadModule("/src/constants.ts");
    const modules = { ...admission, ...reader, sha256Hex, TELEMETRY_CONSENT_VERSION };

    tempRoot = await mkdtemp(join(tmpdir(), "tibotattle-postgres-v12-prior-"));
    const priorPrimaryDirectory = join(tempRoot, "primary");
    await mkdir(priorPrimaryDirectory, { recursive: true });
    const migrationFiles = await readdir(join(POSTGRES_MIGRATION_ROOT, "primary"));
    const priorFiles = migrationFiles.filter((name) => {
      const match = /^(\d{4})_[a-z][a-z0-9_-]*\.sql$/u.exec(name);
      return match !== null && Number(match[1]) <= BASELINE_PRIMARY_VERSION;
    }).sort();
    assert.equal(priorFiles.length, BASELINE_PRIMARY_VERSION);
    for (const name of priorFiles) {
      await copyFile(join(POSTGRES_MIGRATION_ROOT, "primary", name), join(priorPrimaryDirectory, name));
    }

    const prior = await applyPostgresMigrations({
      role: "primary", schema, pool, rootDirectory: tempRoot,
    });
    assert.equal(prior.applied, BASELINE_PRIMARY_VERSION);
    const before = await reader.readPostgresTelemetryV12EffectivePage(pool, {
      participantId: "synthetic-participant",
      day: "2026-09-20",
      stream: "usage",
      limit: 20,
    }, options);
    assert.deepEqual(before, { available: false, records: [], next: null });

    const currentMigrations = await readPostgresMigrations({ role: "primary" });
    assert.equal(currentMigrations.some((migration) => migration.name === "0025_typed_v12_normalized.sql"), true);
    const current = await applyPostgresMigrations({
      role: "primary", schema, pool, rootDirectory: POSTGRES_MIGRATION_ROOT,
    });
    assert.equal(current.applied, currentMigrations.length);
    assert.ok(current.applied > BASELINE_PRIMARY_VERSION);

    await admission.initializePostgresTypedV12Admission(pool, options);
    const extensionObjects = await pool.query(
      `SELECT relation.relname AS name
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1
          AND relation.relname = ANY($2::text[])
          AND relation.relkind IN ('r', 'v')`,
      [schema, [
        "telemetry_v12_typed_runtime", "typed_telemetry_dictionary", "telemetry_v12_typed_attributions",
        "telemetry_v12_typed_records", "telemetry_v12_typed_usage", "telemetry_v12_typed_quota",
        "telemetry_v12_typed_session_tools", "telemetry_v12_typed_active_authorizations",
        "telemetry_v12_typed_retained_authorizations",
      ]],
    );
    assert.equal(extensionObjects.rows.length, 9);

    const nowEpoch = Date.now();
    const admitted = await admitSyntheticUsageDay({ pool, schema, options, nowEpoch, modules });
    assert.deepEqual(admitted.candidate.state, "staged");
    assert.equal(admitted.records.length, USAGE_SCAN_FIXTURE_RECORDS);
    assert.deepEqual(admitted.usageOrderPages, [2_048, 3, 0],
      "whole-day usage validation must fetch past 2,048 records and then terminate on an empty page");
    const readyManifest = await pool.query(
      `SELECT state, ready_at FROM "${schema}"."telemetry_v12_day_manifests" WHERE id=$1`,
      [admitted.candidate.manifestId],
    );
    assert.deepEqual(readyManifest.rows[0]?.state, "ready");
    assert.ok(readyManifest.rows[0]?.ready_at);

    assert.ok(admitted.replayFixture, "fixture includes the accepted quota chunk for replay checks");
    const replay = await admission.persistPostgresTypedV12StagedChunk(
      pool,
      admitted.principal,
      admitted.replayFixture.chunk,
      admitted.replayFixture.metadata,
      nowEpoch,
      options,
    );
    assert.deepEqual(replay, {
      contributionId: admitted.replayFixture.metadata.chunkRowId,
      manifestId: admitted.candidate.manifestId,
      chunkId: admitted.replayFixture.chunk.chunkId,
      replay: true,
    }, "an exact retry remains idempotent after the manifest becomes ready");

    const changedQuotaRecords = admitted.replayFixture.chunk.records.map((record) => ({
      ...record,
      usedPercent: record.usedPercent + 1,
    }));
    const changedQuotaChunk = {
      ...admitted.replayFixture.chunk,
      records: changedQuotaRecords,
      chunkDigest: await modules.sha256Hex(canonicalTelemetryV12Json(changedQuotaRecords)),
    };
    await assert.rejects(
      admission.persistPostgresTypedV12StagedChunk(
        pool, admitted.principal, changedQuotaChunk, admitted.replayFixture.metadata, nowEpoch, options,
      ),
      (error) => error?.code === "TELEMETRY_MANIFEST_CONFLICT",
      "a ready manifest rejects changed content for an already accepted chunk ID",
    );

    const extraQuotaChunk = {
      ...admitted.replayFixture.chunk,
      chunkId: `quota:${FIXTURE_DAY}:1`,
    };
    await assert.rejects(
      admission.persistPostgresTypedV12StagedChunk(
        pool, admitted.principal, extraQuotaChunk, admitted.replayFixture.metadata, nowEpoch, options,
      ),
      (error) => error?.code === "TELEMETRY_MANIFEST_CONFLICT",
      "a ready manifest rejects a new chunk that was not declared in its manifest",
    );

    const emptyManifest = {
      schemaVersion: "telemetry-day-manifest-v1.2",
      day: FIXTURE_DAY,
      parserVersion: "synthetic-empty-pg-v12",
      consent: telemetryV12RequiredConsent(),
      chunks: [],
      excluded: { quota: 0, session: 0, usage: 0 },
      manifestDigest: "0".repeat(64),
    };
    emptyManifest.manifestDigest = await modules.sha256Hex(telemetryV12DayManifestDigestInput(emptyManifest));
    // A complete domain includes days with no admitted records; the shipped
    // client registers one for every day in its range. Register it after the
    // admitted day so the earliest ready manifest for this day is unchanged.
    const emptyCandidate = await admission.registerPostgresTypedV12DayManifest(
      pool, admitted.principal, emptyManifest, nowEpoch + 1_000, options,
    );
    assert.deepEqual({ state: emptyCandidate.state, expectedChunks: emptyCandidate.expectedChunks },
      { state: "ready", expectedChunks: 0 }, "an empty day is complete, and ready, at registration");
    assert.equal((await admission.registerPostgresTypedV12DayManifest(
      pool, admitted.principal, emptyManifest, nowEpoch + 2_000, options,
    )).manifestId, emptyCandidate.manifestId, "an empty day replays its exact registration");
    const emptyChunks = await pool.query(
      `SELECT count(*)::integer AS count FROM "${schema}"."telemetry_v12_chunks" WHERE manifest_id=$1`,
      [emptyCandidate.manifestId],
    );
    assert.equal(emptyChunks.rows[0]?.count, 0);

    const domainStore = createPostgresTypedV12Domain(pool, options);
    const predecessor = await domainStore.createPredecessor(admitted.principal, nowEpoch);
    const domainManifest = {
      schemaVersion: "telemetry-domain-manifest-v1.2",
      fromDay: FIXTURE_DAY,
      throughDay: FIXTURE_DAY,
      predecessor: {
        token: predecessor.token,
        previousGenerationId: predecessor.previousGenerationId,
        legacyFingerprint: predecessor.legacyFingerprint,
      },
      days: [{
        day: FIXTURE_DAY,
        manifestId: admitted.candidate.manifestId,
        manifestDigest: admitted.candidate.manifestDigest,
      }],
      manifestDigest: "0".repeat(64),
    };
    domainManifest.manifestDigest = await sha256Hex(telemetryV12DomainManifestDigestInput(domainManifest));
    const activated = await domainStore.activate(admitted.principal, domainManifest, nowEpoch);
    assert.equal(activated.replay, false);

    const cloneReadyTypedDay = async ({ missingRecordId = null } = {}) => {
      const sourceChunks = await pool.query(
        `SELECT id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,record_count,parser_version
           FROM "${schema}"."telemetry_v12_chunks" WHERE manifest_id=$1
          ORDER BY stream,chunk_seq,id`,
        [admitted.candidate.manifestId],
      );
      const manifestId = randomUUID();
      const manifestDigest = await sha256Hex(`successor-manifest:${manifestId}`);
      const manifestChunks = sourceChunks.rows.map((chunk) => {
        const removesRecord = missingRecordId !== null && chunk.stream === "usage"
          && chunk.id === missingSourceChunkRowId;
        return {
          chunkId: chunk.chunk_id,
          chunkDigest: removesRecord ? `${chunk.chunk_digest.slice(0, 63)}${chunk.chunk_digest.endsWith("0") ? "1" : "0"}` : chunk.chunk_digest,
          recordCount: removesRecord ? chunk.record_count - 1 : chunk.record_count,
        };
      });
      const createdAt = new Date(Date.now() + 1_000).toISOString();
      await pool.query(
        `INSERT INTO "${schema}"."telemetry_v12_day_manifests" (
           id,participant_id,device_id,chunk_day,manifest_digest,parser_version,
           manifest_json,expected_chunk_count,state,created_at
         ) VALUES ($1,$2,$3,$4::date,$5,'synthetic-v12-successor',$6,$7,'staged',$8)`,
        [manifestId, admitted.principal.participantId, admitted.principal.deviceId,
          FIXTURE_DAY, manifestDigest, JSON.stringify({
            schemaVersion: "telemetry-day-manifest-v1.2", day: FIXTURE_DAY,
            chunks: manifestChunks,
          }), sourceChunks.rows.length, createdAt],
      );
      const newChunkRows = [];
      for (let index = 0; index < sourceChunks.rows.length; index += 1) {
        const source = sourceChunks.rows[index];
        const chunkRowId = `successor-chunk:${randomUUID()}`;
        const item = manifestChunks[index];
        const envelopeDigest = await sha256Hex(`successor-envelope:${manifestId}:${index}`);
        const authorizationId = `synthetic-successor-auth-${randomBytes(6).toString("hex")}`;
        const r2Key = `synthetic/successor-${randomBytes(12).toString("hex")}`;
        const expires = new Date(Date.now() + 10 * 60_000).toISOString();
        await pool.query(
          `INSERT INTO "${schema}"."device_upload_authorizations" (
             id,participant_id,issued_by_device_id,secret_hash,envelope_digest,
             body_bytes,content_type,state,issued_at,expires_at,consume_lease_expires_at
           ) VALUES ($1,$2,$3,$4,$5,4096,'application/json','consuming',$6,$7,$7)`,
          [authorizationId, admitted.principal.participantId, admitted.principal.deviceId,
            randomBytes(32), envelopeDigest, createdAt, expires],
        );
        await pool.query(
          `INSERT INTO "${schema}"."pending_objects" (contribution_id,object_key,object_kind)
           VALUES ($1,$2,'telemetry_v12')`,
          [chunkRowId, r2Key],
        );
        await pool.query(
          `INSERT INTO "${schema}"."telemetry_v12_chunks" (
             id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,
             chunk_id,chunk_digest,envelope_digest,parser_version,record_count,
             r2_key,device_upload_authorization_id,created_at
           ) VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [chunkRowId, manifestId, admitted.principal.participantId, admitted.principal.deviceId,
            source.stream, source.chunk_day, source.chunk_seq, source.chunk_id, item.chunkDigest,
            envelopeDigest, source.parser_version, item.recordCount, r2Key, authorizationId, createdAt],
        );
        newChunkRows.push({ sourceId: source.id, chunkRowId });
        const skip = missingRecordId === null ? "" : " AND id <> $4";
        const values = missingRecordId === null
          ? [chunkRowId, manifestId, source.id]
          : [chunkRowId, manifestId, source.id, missingRecordId];
        await pool.query(
          `INSERT INTO "${schema}"."telemetry_v12_typed_records" (
             chunk_id,manifest_id,stream,record_index,occurrence_id,observed_at_ms,
             observed_day,provider_id,canonical_digest
           ) SELECT $1,$2,stream,record_index,occurrence_id,observed_at_ms,
                    observed_day,provider_id,canonical_digest
               FROM "${schema}"."telemetry_v12_typed_records"
              WHERE chunk_id=$3${skip}`,
          values,
        );
      }
      await pool.query(
        `INSERT INTO "${schema}"."telemetry_v12_typed_usage" (
           record_id,session_id,model_id,speed_mode_id,api_service_tier_id,surface_id,
           billing_surface_id,reasoning_effort_id,agent_scope_id,outcome_id,attribution_id,
           total_input_context_tokens,input_uncached_tokens,input_cache_read_tokens,
           input_cache_write_tokens,output_text_tokens,output_reasoning_tokens,
           output_combined_tokens,boundary_flags,tie_order,
           cache_write_ttl_five_minute_tokens,cache_write_ttl_one_hour_tokens
         ) SELECT successor.id,source.session_id,source.model_id,source.speed_mode_id,
                  source.api_service_tier_id,source.surface_id,source.billing_surface_id,
                  source.reasoning_effort_id,source.agent_scope_id,source.outcome_id,
                  source.attribution_id,source.total_input_context_tokens,
                  source.input_uncached_tokens,source.input_cache_read_tokens,
                  source.input_cache_write_tokens,source.output_text_tokens,
                  source.output_reasoning_tokens,source.output_combined_tokens,
                  source.boundary_flags,source.tie_order,
                  source.cache_write_ttl_five_minute_tokens,source.cache_write_ttl_one_hour_tokens
             FROM "${schema}"."telemetry_v12_typed_records" successor
             JOIN "${schema}"."telemetry_v12_typed_records" prior
               ON prior.manifest_id=$2 AND prior.stream=successor.stream
              AND prior.occurrence_id=successor.occurrence_id
             JOIN "${schema}"."telemetry_v12_typed_usage" source ON source.record_id=prior.id
            WHERE successor.manifest_id=$1 AND successor.stream='usage'`,
        [manifestId, admitted.candidate.manifestId],
      );
      await pool.query(
        `INSERT INTO "${schema}"."telemetry_v12_typed_quota" (
           record_id,plan_type_id,plan_variant_id,limit_id,slot_id,used_percent,
           window_duration_minutes,resets_at_ms,attribution_id
         ) SELECT successor.id,source.plan_type_id,source.plan_variant_id,source.limit_id,
                  source.slot_id,source.used_percent,source.window_duration_minutes,
                  source.resets_at_ms,source.attribution_id
             FROM "${schema}"."telemetry_v12_typed_records" successor
             JOIN "${schema}"."telemetry_v12_typed_records" prior
               ON prior.manifest_id=$2 AND prior.stream=successor.stream
              AND prior.occurrence_id=successor.occurrence_id
             JOIN "${schema}"."telemetry_v12_typed_quota" source ON source.record_id=prior.id
            WHERE successor.manifest_id=$1 AND successor.stream='quota'`,
        [manifestId, admitted.candidate.manifestId],
      );
      await pool.query(
        `INSERT INTO "${schema}"."telemetry_v12_typed_session_tools" (record_id,tool_class_id,count)
         SELECT successor.id,source.tool_class_id,source.count
           FROM "${schema}"."telemetry_v12_typed_records" successor
           JOIN "${schema}"."telemetry_v12_typed_records" prior
             ON prior.manifest_id=$2 AND prior.stream=successor.stream
            AND prior.occurrence_id=successor.occurrence_id
           JOIN "${schema}"."telemetry_v12_typed_session_tools" source ON source.record_id=prior.id
          WHERE successor.manifest_id=$1 AND successor.stream='session'`,
        [manifestId, admitted.candidate.manifestId],
      );
      const ready = await pool.query(
        `UPDATE "${schema}"."telemetry_v12_day_manifests" SET state='ready',ready_at=$2
          WHERE id=$1 RETURNING state`,
        [manifestId, createdAt],
      );
      assert.equal(ready.rows[0]?.state, "ready");
      return { manifestId, manifestDigest };
    };

    const lastUsageChunk = await pool.query(
      `SELECT chunk.id AS chunk_id, record.id::text AS record_id
         FROM "${schema}"."telemetry_v12_chunks" chunk
         JOIN "${schema}"."telemetry_v12_typed_records" record ON record.chunk_id=chunk.id
        WHERE chunk.manifest_id=$1 AND chunk.stream='usage'
        ORDER BY chunk.chunk_seq DESC, record.record_index DESC LIMIT 1`,
      [admitted.candidate.manifestId],
    );
    const missingSourceChunkRowId = lastUsageChunk.rows[0]?.chunk_id;
    const missingSourceRecordId = lastUsageChunk.rows[0]?.record_id;
    assert.ok(missingSourceChunkRowId && missingSourceRecordId);

    const successorPredecessor = await domainStore.createPredecessor(admitted.principal, Date.now());
    const completeSuccessor = await cloneReadyTypedDay();
    const makeDomainSuccessor = async (predecessor, dayReference) => {
      const value = {
        schemaVersion: "telemetry-domain-manifest-v1.2",
        fromDay: FIXTURE_DAY,
        throughDay: FIXTURE_DAY,
        predecessor: {
          token: predecessor.token,
          previousGenerationId: predecessor.previousGenerationId,
          legacyFingerprint: predecessor.legacyFingerprint,
        },
        days: [{ day: FIXTURE_DAY, manifestId: dayReference.manifestId, manifestDigest: dayReference.manifestDigest }],
        manifestDigest: "0".repeat(64),
      };
      value.manifestDigest = await sha256Hex(telemetryV12DomainManifestDigestInput(value));
      return value;
    };
    const completeSuccessorManifest = await makeDomainSuccessor(successorPredecessor, completeSuccessor);
    const completeSuccessorActivation = await domainStore.activate(
      admitted.principal, completeSuccessorManifest, Date.now(),
    );
    assert.equal(completeSuccessorActivation.replay, false);
    assert.notEqual(completeSuccessorActivation.generationId, activated.generationId);
    const completeSuccessorReplay = await domainStore.activate(
      admitted.principal, completeSuccessorManifest, Date.now(),
    );
    assert.equal(completeSuccessorReplay.replay, true);
    assert.equal(completeSuccessorReplay.generationId, completeSuccessorActivation.generationId);

    const changedPredecessor = await domainStore.createPredecessor(admitted.principal, Date.now());
    const missingSuccessor = await cloneReadyTypedDay({ missingRecordId: missingSourceRecordId });
    await assert.rejects(
      domainStore.activate(
        admitted.principal,
        await makeDomainSuccessor(changedPredecessor, missingSuccessor),
        Date.now(),
      ),
      (error) => error?.code === "TELEMETRY_MANIFEST_CONFLICT",
      "same-day typed successor must retain every prior stream/occurrence/digest tuple",
    );
    const generationHistory = await pool.query(
      `SELECT count(*)::integer AS count FROM "${schema}"."telemetry_v12_domains" WHERE participant_id=$1`,
      [admitted.principal.participantId],
    );
    assert.equal(generationHistory.rows[0]?.count, 2, "prior domain generation remains retained");
    const activeDomainDay = await pool.query(
      `SELECT head.generation_id,day.manifest_id
         FROM "${schema}"."telemetry_v12_domain_heads" head
         JOIN "${schema}"."telemetry_v12_domain_days" day ON day.generation_id=head.generation_id
        WHERE head.participant_id=$1 AND day.observed_day=$2::date`,
      [admitted.principal.participantId, FIXTURE_DAY],
    );
    assert.deepEqual(activeDomainDay.rows[0], {
      generation_id: completeSuccessorActivation.generationId,
      manifest_id: completeSuccessor.manifestId,
    });

    const firstPage = await reader.readPostgresTelemetryV12EffectivePage(pool, {
      participantId: admitted.principal.participantId,
      day: FIXTURE_DAY,
      stream: "usage",
      limit: 2,
    }, options);
    assert.equal(firstPage.available, true);
    assert.equal(firstPage.records.length, 2);
    assert.ok(firstPage.next);
    assert.deepEqual(firstPage.records.map((record) => record.occurrenceId), admitted.records.slice(0, 2).map((record) => record.eventId));
    assert.equal(JSON.parse(firstPage.records[0].sourceRecordJson).schemaVersion, "usage-event-v1.2");
    assert.equal(JSON.parse(firstPage.records[0].recordJson).schemaVersion, "usage-event-v1.1");

    const allUsageRecords = [...firstPage.records];
    let cursor = firstPage.next;
    while (cursor) {
      const page = await reader.readPostgresTelemetryV12EffectivePage(pool, {
        participantId: admitted.principal.participantId,
        day: FIXTURE_DAY,
        stream: "usage",
        after: cursor,
        limit: 200,
      }, options);
      assert.equal(page.available, true);
      allUsageRecords.push(...page.records);
      cursor = page.next;
    }
    assert.equal(allUsageRecords.length, USAGE_SCAN_FIXTURE_RECORDS);
    assert.deepEqual(allUsageRecords.map((record) => record.occurrenceId), admitted.records.map((record) => record.eventId));

    const candidateTiePage = await reader.readPostgresTelemetryV12EffectiveCandidatePage(pool, {
      participantId: admitted.principal.participantId,
      day: FIXTURE_DAY,
      stream: "usage",
      limit: 2,
    }, options);
    assert.equal(candidateTiePage.available, true);
    assert.deepEqual(candidateTiePage.records.map((record) => record.occurrenceId),
      admitted.records.slice(0, 2).map((record) => record.eventId));
    assert.ok(candidateTiePage.next);
    const candidateTieReplay = await reader.readPostgresTelemetryV12EffectiveCandidatePage(pool, {
      participantId: admitted.principal.participantId,
      day: FIXTURE_DAY,
      stream: "usage",
      limit: 2,
    }, options);
    assert.deepEqual(candidateTieReplay, candidateTiePage, "candidate page replay is stable");
    const candidateAcrossTie = await reader.readPostgresTelemetryV12EffectiveCandidatePage(pool, {
      participantId: admitted.principal.participantId,
      day: FIXTURE_DAY,
      stream: "usage",
      after: candidateTiePage.next,
      limit: 2,
    }, options);
    assert.equal(candidateAcrossTie.records[0]?.occurrenceId, admitted.records[2]?.eventId);
    assert.equal(candidateAcrossTie.records[0]?.observedAtMs, candidateTiePage.records[0]?.observedAtMs,
      "the keyset crosses tied timestamps by occurrence ID without skipping a candidate");

    const allCandidates = [];
    let candidateCursor;
    do {
      const page = await reader.readPostgresTelemetryV12EffectiveCandidatePage(pool, {
        participantId: admitted.principal.participantId,
        day: FIXTURE_DAY,
        stream: "usage",
        ...(candidateCursor === undefined ? {} : { after: candidateCursor }),
        limit: 200,
      }, options);
      assert.equal(page.available, true);
      allCandidates.push(...page.records);
      candidateCursor = page.next;
    } while (candidateCursor);
    assert.equal(allCandidates.length, USAGE_SCAN_FIXTURE_RECORDS);
    assert.equal(new Set(allCandidates.map((record) => record.occurrenceId)).size, USAGE_SCAN_FIXTURE_RECORDS,
      "retained prior and successor generations produce one candidate per active occurrence");
    assert.deepEqual(allCandidates.map((record) => record.occurrenceId),
      admitted.records.map((record) => record.eventId));

    const firstCandidateIds = allCandidates.slice(0, 200).map((record) => record.occurrenceId);
    const expanded = await reader.readPostgresTelemetryV12EffectiveOccurrences(pool, {
      participantId: admitted.principal.participantId,
      stream: "usage",
      occurrenceIds: firstCandidateIds,
    }, options);
    assert.equal(expanded.available, true);
    assert.equal(expanded.records.length, 200);
    assert.deepEqual(expanded.records.map((record) => record.occurrenceId), firstCandidateIds);
    assert.equal(new Set(expanded.records.map((record) => record.sourceRecordKey)).size, expanded.records.length);
    const expandedRecordIds = expanded.records.map((record) => Number(record.sourceRecordKey.slice("v12:record:".length)));
    const expandedManifestRows = await pool.query(
      `SELECT DISTINCT manifest_id FROM "${schema}"."telemetry_v12_typed_records" WHERE id=ANY($1::bigint[])`,
      [expandedRecordIds],
    );
    assert.deepEqual(expandedManifestRows.rows.map((row) => row.manifest_id), [completeSuccessor.manifestId],
      "occurrence expansion reads the active successor head and excludes retained prior rows");
    const repeatedOccurrenceExpansion = await reader.readPostgresTelemetryV12EffectiveOccurrences(pool, {
      participantId: admitted.principal.participantId,
      stream: "usage",
      occurrenceIds: [firstCandidateIds[0], firstCandidateIds[1], firstCandidateIds[0]],
    }, options);
    assert.deepEqual(repeatedOccurrenceExpansion.records.map((record) => record.occurrenceId), firstCandidateIds.slice(0, 2),
      "repeated requested IDs do not duplicate expanded records");
    await assert.rejects(
      reader.readPostgresTelemetryV12EffectiveOccurrences(pool, {
        participantId: admitted.principal.participantId,
        stream: "usage",
        occurrenceIds: Array.from({ length: 201 }, (_, index) => `event:v2:${(index + 1).toString(16).padStart(64, "0")}`),
      }, options),
      (error) => error?.message === "TELEMETRY_V12_EFFECTIVE_UNAVAILABLE",
      "occurrence expansion rejects an unbounded ID list",
    );

    for (const stream of ["usage", "quota", "session"]) {
      const days = await reader.readPostgresTelemetryV12EffectiveDays(pool, {
        participantId: admitted.principal.participantId,
        fromDay: FIXTURE_DAY,
        throughDay: FIXTURE_DAY,
        stream,
      }, options);
      assert.deepEqual(days, [FIXTURE_DAY]);
    }
    await assert.rejects(
      reader.readPostgresTelemetryV12EffectiveDays(pool, {
        participantId: admitted.principal.participantId,
        fromDay: FIXTURE_DAY,
        throughDay: "2026-12-30",
        stream: "usage",
      }, options),
      (error) => error?.message === "TELEMETRY_V12_EFFECTIVE_UNAVAILABLE",
      "day enumeration rejects ranges beyond the 101-day bound",
    );

    const finalPage = await reader.readPostgresTelemetryV12EffectivePage(pool, {
      participantId: admitted.principal.participantId,
      day: FIXTURE_DAY,
      stream: "usage",
      after: {
        observedAtMs: allUsageRecords.at(-1).observedAtMs,
        occurrenceId: allUsageRecords.at(-1).occurrenceId,
      },
      limit: 200,
    }, options);
    assert.equal(finalPage.records.length, 0);
    assert.equal(finalPage.next, null);

    const quotaPage = await reader.readPostgresTelemetryV12EffectivePage(pool, {
      participantId: admitted.principal.participantId,
      day: FIXTURE_DAY,
      stream: "quota",
      limit: 10,
    }, options);
    assert.equal(quotaPage.available, true);
    assert.equal(quotaPage.records.length, 1);
    assert.deepEqual(JSON.parse(quotaPage.records[0].sourceRecordJson), admitted.quotaRecord);
    assert.equal(JSON.parse(quotaPage.records[0].recordJson).schemaVersion, "quota-observation-v1.1");
    assert.deepEqual(JSON.parse(quotaPage.records[0].recordJson), {
      ...admitted.quotaRecord,
      schemaVersion: "quota-observation-v1.1",
    });

    const sessionPage = await reader.readPostgresTelemetryV12EffectivePage(pool, {
      participantId: admitted.principal.participantId,
      day: FIXTURE_DAY,
      stream: "session",
      limit: 10,
    }, options);
    assert.equal(sessionPage.available, true);
    assert.equal(sessionPage.records.length, 1);
    assert.deepEqual(JSON.parse(sessionPage.records[0].sourceRecordJson), admitted.sessionRecord);
    assert.deepEqual(JSON.parse(sessionPage.records[0].recordJson), {
      ...admitted.sessionRecord,
      schemaVersion: "session-dimension-v1.1",
    });

    const typedRows = await pool.query(
      `SELECT id FROM "${schema}"."telemetry_v12_typed_records" WHERE chunk_id=$1 ORDER BY record_index`,
      [admitted.usageChunkRowId],
    );
    assert.equal(typedRows.rows.length, 200);
    const sessionSourceRow = await pool.query(
      `SELECT id::text AS id FROM "${schema}"."telemetry_v12_typed_records" WHERE chunk_id=$1`,
      [admitted.sessionChunkRowId],
    );
    assert.equal(sessionSourceRow.rows.length, 1);

    const rejectedReadyId = randomUUID();
    const rejectedReadyDigest = "d".repeat(64);
    const rejectedReadyChunkId = `usage:${FIXTURE_DAY}:998`;
    await assert.rejects(
      pool.query(
        `INSERT INTO "${schema}"."telemetry_v12_day_manifests" (
           id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
           manifest_json, expected_chunk_count, state, created_at, ready_at
         ) VALUES ($1,$2,$3,$4::date,$5,'synthetic-integrity-probe',$6,1,'ready',$7,$7)`,
        [rejectedReadyId, admitted.principal.participantId, admitted.principal.deviceId,
          FIXTURE_DAY, rejectedReadyDigest, JSON.stringify({
            schemaVersion: "telemetry-day-manifest-v1.2", day: FIXTURE_DAY,
            chunks: [{ chunkId: rejectedReadyChunkId, chunkDigest: "e".repeat(64), recordCount: 1 }],
          }), new Date(nowEpoch).toISOString()],
      ),
      (error) => error?.code === "23514" && error.message.includes("telemetry_manifest_ready_incomplete"),
    );

    const stageProbe = async ({ stream, sourceRecordId = null, copyTyped = false,
      copyChild = false, rawRecord = null }) => {
      const day = FIXTURE_DAY;
      const seq = 900 + Math.floor(Math.random() * 90);
      const manifestId = randomUUID();
      const manifestDigest = await modules.sha256Hex(`manifest:${manifestId}`);
      const chunkId = `${stream}:${day}:${seq}`;
      const chunkDigest = await modules.sha256Hex(`chunk:${manifestId}`);
      const r2Key = `synthetic/integrity-${randomBytes(12).toString("hex")}`;
      const authorizationId = `synthetic-integrity-auth-${randomBytes(6).toString("hex")}`;
      const chunkRowId = `integrity-chunk:${randomUUID()}`;
      const now = new Date(nowEpoch).toISOString();
      const expires = new Date(nowEpoch + 10 * 60_000).toISOString();
      const manifestJson = JSON.stringify({
        schemaVersion: "telemetry-day-manifest-v1.2", day,
        chunks: [{ chunkId, chunkDigest, recordCount: 1 }],
      });
      await pool.query(
        `INSERT INTO "${schema}"."telemetry_v12_day_manifests" (
           id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
           manifest_json, expected_chunk_count, state, created_at
         ) VALUES ($1,$2,$3,$4::date,$5,'synthetic-integrity-probe',$6,1,'staged',$7)`,
        [manifestId, admitted.principal.participantId, admitted.principal.deviceId,
          day, manifestDigest, manifestJson, now],
      );
      await pool.query(
        `INSERT INTO "${schema}"."device_upload_authorizations" (
           id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
           body_bytes, content_type, state, issued_at, expires_at, consume_lease_expires_at
         ) VALUES ($1,$2,$3,$4,$5,4096,'application/json','consuming',$6,$7,$7)`,
        [authorizationId, admitted.principal.participantId, admitted.principal.deviceId,
          randomBytes(32), await modules.sha256Hex(`envelope:${manifestId}`), now, expires],
      );
      await pool.query(
        `INSERT INTO "${schema}"."pending_objects" (contribution_id,object_key,object_kind)
         VALUES ($1,$2,'telemetry_v12')`,
        [chunkRowId, r2Key],
      );
      await pool.query(
        `INSERT INTO "${schema}"."telemetry_v12_chunks" (
           id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq,
           chunk_id, chunk_digest, envelope_digest, parser_version, record_count,
           r2_key, device_upload_authorization_id, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'synthetic-integrity-probe',1,$11,$12,$13)`,
        [chunkRowId, manifestId, admitted.principal.participantId, admitted.principal.deviceId,
          stream, day, seq, chunkId, chunkDigest, await modules.sha256Hex(`envelope-digest:${manifestId}`),
          r2Key, authorizationId, now],
      );
      let typedRecordId = null;
      if (copyTyped) {
        const typedCopy = await pool.query(
          `INSERT INTO "${schema}"."telemetry_v12_typed_records" (
             chunk_id, manifest_id, stream, record_index, occurrence_id, observed_at_ms,
             observed_day, provider_id, canonical_digest
           ) SELECT $1,$2,stream,0,occurrence_id,observed_at_ms,observed_day,provider_id,canonical_digest
               FROM "${schema}"."telemetry_v12_typed_records" WHERE id=$3
           RETURNING id::text AS id`,
          [chunkRowId, manifestId, sourceRecordId],
        );
        assert.equal(typedCopy.rows.length, 1);
        typedRecordId = typedCopy.rows[0].id;
        if (copyChild && stream === "usage") {
          await pool.query(
            `INSERT INTO "${schema}"."telemetry_v12_typed_usage" (
               record_id, session_id, model_id, speed_mode_id, api_service_tier_id,
               surface_id, billing_surface_id, reasoning_effort_id, agent_scope_id,
               outcome_id, attribution_id, total_input_context_tokens,
               input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens,
               output_text_tokens, output_reasoning_tokens, output_combined_tokens,
               boundary_flags, tie_order, cache_write_ttl_five_minute_tokens,
               cache_write_ttl_one_hour_tokens
             ) SELECT $1,session_id,model_id,speed_mode_id,api_service_tier_id,
                      surface_id,billing_surface_id,reasoning_effort_id,agent_scope_id,
                      outcome_id,attribution_id,total_input_context_tokens,
                      input_uncached_tokens,input_cache_read_tokens,input_cache_write_tokens,
                      output_text_tokens,output_reasoning_tokens,output_combined_tokens,
                      boundary_flags,tie_order,cache_write_ttl_five_minute_tokens,
                      cache_write_ttl_one_hour_tokens
                 FROM "${schema}"."telemetry_v12_typed_usage" WHERE record_id=$2`,
            [typedRecordId, sourceRecordId],
          );
        } else if (copyChild && stream === "quota") {
          await pool.query(
            `INSERT INTO "${schema}"."telemetry_v12_typed_quota" (
               record_id, plan_type_id, plan_variant_id, limit_id, slot_id,
               used_percent, window_duration_minutes, resets_at_ms, attribution_id
             ) SELECT $1,plan_type_id,plan_variant_id,limit_id,slot_id,
                      used_percent,window_duration_minutes,resets_at_ms,attribution_id
                 FROM "${schema}"."telemetry_v12_typed_quota" WHERE record_id=$2`,
            [typedRecordId, sourceRecordId],
          );
        } else if (copyChild && stream === "session") {
          await pool.query(
            `INSERT INTO "${schema}"."telemetry_v12_typed_session_tools" (record_id,tool_class_id,count)
             SELECT $1,tool_class_id,count FROM "${schema}"."telemetry_v12_typed_session_tools"
              WHERE record_id=$2`,
            [typedRecordId, sourceRecordId],
          );
        }
      }
      if (rawRecord) {
        await pool.query(
          `INSERT INTO "${schema}"."telemetry_v12_records" (
             chunk_id, manifest_id, stream, occurrence_id, observed_at, record_json
           ) VALUES ($1,$2,$3,$4,$5::timestamptz,$6)`,
          [chunkRowId, manifestId, stream,
            stream === "usage" ? rawRecord.eventId : stream === "quota" ? rawRecord.observationId : rawRecord.sessionUuid,
            stream === "usage" ? rawRecord.eventTime : stream === "quota" ? rawRecord.observedTime : rawRecord.firstEventTime,
            canonicalTelemetryV12Json(rawRecord)],
        );
      }
      return { manifestId, manifestDigest, typedRecordId };
    };

    const legacyOnly = await stageProbe({ stream: "usage", rawRecord: admitted.records[0] });
    const legacyReady = await pool.query(
      `UPDATE "${schema}"."telemetry_v12_day_manifests" SET state='ready',ready_at=$2 WHERE id=$1 RETURNING state`,
      [legacyOnly.manifestId, new Date(nowEpoch).toISOString()],
    );
    assert.equal(legacyReady.rows[0]?.state, "ready", "legacy raw-only v1.2 remains ready-compatible");

    const sessionProbe = await stageProbe({
      stream: "session", sourceRecordId: sessionSourceRow.rows[0].id, copyTyped: true,
    });
    await assert.rejects(
      pool.query(
        `UPDATE "${schema}"."telemetry_v12_day_manifests" SET state='ready',ready_at=$2 WHERE id=$1`,
        [sessionProbe.manifestId, new Date(nowEpoch).toISOString()],
      ),
      (error) => error?.code === "23514" && error.message.includes("telemetry_manifest_ready_incomplete"),
    );

    const mixedProbe = await stageProbe({
      stream: "usage", sourceRecordId: typedRows.rows[0].id,
      copyTyped: true, copyChild: true, rawRecord: admitted.records[0],
    });
    await assert.rejects(
      pool.query(
        `UPDATE "${schema}"."telemetry_v12_day_manifests" SET state='ready',ready_at=$2 WHERE id=$1`,
        [mixedProbe.manifestId, new Date(nowEpoch).toISOString()],
      ),
      (error) => error?.code === "23514" && error.message.includes("telemetry_manifest_ready_mixed_storage"),
    );

    await assert.rejects(
      pool.query(
        `DELETE FROM "${schema}"."telemetry_v12_typed_records" WHERE chunk_id=$1`,
        [admitted.usageChunkRowId],
      ),
      (error) => error?.code === "P1005",
    );
    await assert.rejects(
      pool.query(
        `DELETE FROM "${schema}"."telemetry_v12_typed_usage" WHERE record_id=$1`,
        [typedRows.rows[0].id],
      ),
      (error) => error?.code === "P1005",
    );
    const quotaRow = await pool.query(
      `SELECT id::text AS id FROM "${schema}"."telemetry_v12_typed_records" WHERE chunk_id=$1`,
      [admitted.quotaChunkRowId],
    );
    assert.equal(quotaRow.rows.length, 1);
    await assert.rejects(
      pool.query(
        `DELETE FROM "${schema}"."telemetry_v12_typed_quota" WHERE record_id=$1`,
        [quotaRow.rows[0].id],
      ),
      (error) => error?.code === "P1005",
    );
    const sessionRow = await pool.query(
      `SELECT id::text AS id FROM "${schema}"."telemetry_v12_typed_records" WHERE chunk_id=$1`,
      [admitted.sessionChunkRowId],
    );
    assert.equal(sessionRow.rows.length, 1);
    const sessionTools = await pool.query(
      `SELECT tool_class_id FROM "${schema}"."telemetry_v12_typed_session_tools" WHERE record_id=$1`,
      [sessionRow.rows[0].id],
    );
    assert.equal(sessionTools.rows.length, 2);
    await assert.rejects(
      pool.query(
        `DELETE FROM "${schema}"."telemetry_v12_typed_session_tools" WHERE record_id=$1`,
        [sessionRow.rows[0].id],
      ),
      (error) => error?.code === "P1005",
    );
    const deleteGuards = await pool.query(
      `SELECT count(*)::integer AS count FROM pg_trigger trigger_row
        JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
        JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       WHERE namespace.nspname=$1 AND NOT trigger_row.tgisinternal
         AND trigger_row.tgname=ANY($2::text[])`,
      [schema, [
        "telemetry_v12_typed_record_delete_guard", "telemetry_v12_typed_usage_delete_guard",
        "telemetry_v12_typed_quota_delete_guard", "telemetry_v12_typed_session_tool_delete_guard",
      ]],
    );
    assert.equal(deleteGuards.rows[0]?.count, 4);

    await pool.query(
      `UPDATE "${schema}"."participants" SET state='deleting', deletion_session_id='synthetic-typed-v12-fence'
        WHERE id=$1`,
      [admitted.principal.participantId],
    );
    const eraseCountsBefore = await pool.query(
      `SELECT (SELECT count(*)::integer FROM "${schema}"."telemetry_v12_typed_records") AS records,
              (SELECT count(*)::integer FROM "${schema}"."telemetry_v12_typed_usage") AS usage,
              (SELECT count(*)::integer FROM "${schema}"."telemetry_v12_typed_quota") AS quota,
              (SELECT count(*)::integer FROM "${schema}"."telemetry_v12_typed_session_tools") AS session_tools`,
    );
    assert.ok(eraseCountsBefore.rows[0]?.records > 0 && eraseCountsBefore.rows[0]?.usage > 0
      && eraseCountsBefore.rows[0]?.quota > 0 && eraseCountsBefore.rows[0]?.session_tools > 0,
    "erasure is proven against populated typed source, not empty tables");
    // Ready source is retained (migration 0035): neither the deleting state nor a
    // direct typed-record delete authorizes removing it. Only the terminal owner
    // erasure cascade, with its same-transaction receipt, does.
    await assert.rejects(
      pool.query(
        `DELETE FROM "${schema}"."telemetry_v12_typed_records"
          WHERE manifest_id IN (
            SELECT id FROM "${schema}"."telemetry_v12_day_manifests" WHERE participant_id=$1
          )`,
        [admitted.principal.participantId],
      ),
      (error) => error?.code === "P1005",
      "a deleting participant's ready typed source cannot be deleted directly",
    );
    const retainedAfterRefusal = await pool.query(
      `SELECT count(*)::integer AS records FROM "${schema}"."telemetry_v12_typed_records"`,
    );
    assert.equal(retainedAfterRefusal.rows[0]?.records, eraseCountsBefore.rows[0]?.records,
      "the refused direct delete leaves every typed record in place");
    const erasure = await pool.query(
      `DELETE FROM "${schema}"."participants"
        WHERE id=$1 AND state='deleting' AND deletion_session_id='synthetic-typed-v12-fence'`,
      [admitted.principal.participantId],
    );
    assert.equal(erasure.rowCount, 1, "the terminal participant erasure cascade succeeds");
    const remainingChildren = await pool.query(
      `SELECT (SELECT count(*)::integer FROM "${schema}"."telemetry_v12_typed_records") AS records,
              (SELECT count(*)::integer FROM "${schema}"."telemetry_v12_typed_usage") AS usage,
              (SELECT count(*)::integer FROM "${schema}"."telemetry_v12_typed_quota") AS quota,
              (SELECT count(*)::integer FROM "${schema}"."telemetry_v12_typed_session_tools") AS session_tools`,
    );
    assert.deepEqual(remainingChildren.rows[0], { records: 0, usage: 0, quota: 0, session_tools: 0 });
    const erasureReceipts = await pool.query(
      `SELECT count(*)::integer AS receipts FROM "${schema}"."storage_owner_erasure_receipts"`,
    );
    assert.equal(erasureReceipts.rows[0]?.receipts, 1, "the cascade carries its own terminal erasure receipt");

    const typedRecordColumns = await pool.query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'telemetry_v12_typed_records'`,
      [schema],
    );
    assert.equal(typedRecordColumns.rows.some((row) => row.column_name === "record_json"), false);
  } finally {
    if (pool && schemaCreated) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    if (pool) await pool.end();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    if (vite) await vite.close();
  }
});
