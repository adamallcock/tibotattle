import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { deviceHash } from "../src/device-auth.ts";
import { encodeBase64Url } from "../src/crypto.ts";
import { disconnectPostgresAuthenticatedDevice } from "../src/postgres-device-disconnect.ts";
import {
  publishPostgresCommunityDailyDay,
  readPostgresCommunityDailyDaySourceEligibility,
} from "../src/postgres-community-daily-publisher.ts";
import { readPostgresPublishedCommunityDaily } from "../src/postgres-community-daily.ts";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const SOURCE_ID = "synthetic-community-source";
const SOURCE_NAMESPACE = "synthetic-community-namespace";
const OWNER_ID = "synthetic-social-owner";
const DEVICE_ID = "synthetic-social-device";
const DAY = "2026-09-24";
const NOW_MS = Date.parse("2026-09-25T12:00:00.000Z");

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  const link = await lstat(PG_TEST_SOCKET);
  const resolved = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

async function localPostgresConnection() {
  if (PG_TEST_HOST !== undefined) {
    assert.ok(["127.0.0.1", "::1"].includes(PG_TEST_HOST),
      "qualification allows only an explicit loopback TCP host");
    assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
    return { host: PG_TEST_HOST, port: PG_TEST_PORT };
  }
  return localSocket();
}

function usageRecord() {
  const eventTime = `${DAY}T12:05:00.000Z`;
  return {
    schemaVersion: "usage-event-v1.0",
    eventId: `event:v2:${"a".repeat(64)}`,
    eventTime,
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "fast",
    apiServiceTier: "priority",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "xhigh",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: null,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: null,
    },
  };
}

describe.skipIf(!PG_TEST_SOCKET && !PG_TEST_HOST)("PostgreSQL explicit-day community daily producer", () => {
  let pool;
  let schema;
  let sqlSchema;

  beforeAll(async () => {
    const socket = await localPostgresConnection();
    pool = new pg.Pool({
      ...socket,
      user: process.env.PG_TEST_USER || "postgres",
      password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
      database: process.env.PG_TEST_DATABASE || "postgres",
      application_name: "pg-community-daily-publisher-test",
      ssl: false,
      max: 2,
      connectionTimeoutMillis: 5_000,
    });
    const locality = await pool.query("SELECT inet_server_addr() AS address, version() AS version");
    if (PG_TEST_HOST !== undefined) {
      assert.notEqual(locality.rows[0]?.address, null,
        "TCP qualification must reach the explicit loopback host");
    } else {
      assert.equal(locality.rows[0]?.address, null, "qualification requires a local Unix socket");
    }
    assert.match(locality.rows[0]?.version ?? "", /^PostgreSQL 17\./u);
  }, 120_000);

  beforeEach(async () => {
    schema = `pcdp_${randomBytes(6).toString("hex")}`;
    sqlSchema = `"${schema}"`;
    await pool.query(`CREATE SCHEMA ${sqlSchema}`);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    await pool.query(`INSERT INTO ${sqlSchema}.typed_telemetry_namespaces(id,original_id)
      VALUES (1,decode('0102','hex'))`);
    await pool.query(`INSERT INTO ${sqlSchema}.typed_v1_admission_state(
      id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      VALUES (1,$1,1,1,1)`, [SOURCE_NAMESPACE]);
    // The typed v1.1 runtime is qualified (0 -> 1) by publish(), after a
    // case's JSON-era v1.1 fixtures: as on D1 and in the transfer, imported
    // telemetry_v11_records predate qualification, and primary 0060 (D1
    // typed-v11 0001 typed_v11_legacy_record_refusal) refuses a JSON v1.1
    // record once the typed runtime is qualified.
    await pool.query(`INSERT INTO ${sqlSchema}.typed_v11_admission_state(
      id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      VALUES (1,$1,1,0,1)`, [SOURCE_NAMESPACE]);
    await pool.query(`INSERT INTO ${sqlSchema}.storage_source_state(singleton,source_id,authority_epoch)
      VALUES (1,$1,0)`, [SOURCE_ID]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_source_cursors(source_id,sequence,authority_epoch)
      VALUES ($1,0,0)`, [SOURCE_ID]);
    await pool.query(`UPDATE ${sqlSchema}.publication_state SET publication_state='ready',policy_revision=1
      WHERE singleton=1`);
    // Primary 0050: 'operational' means all four flags on, and reason_code is
    // NOT NULL in the D1 vocabulary.
    await pool.query(`UPDATE ${sqlSchema}.collection_controls SET revision=revision+1,
      control_state='operational', enrollment_enabled=true, upload_registration_enabled=true,
      processing_enabled=true, publication_enabled=true, reason_code='maintenance',
      updated_at=clock_timestamp() WHERE singleton=1`);
  }, 120_000);

  afterEach(async () => {
    if (schema) await pool.query(`DROP SCHEMA IF EXISTS ${sqlSchema} CASCADE`);
    schema = undefined;
    sqlSchema = undefined;
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function addUsageEvents(eventCount) {
    if (eventCount === 0) return;
    const now = "2026-09-24T12:00:00.000Z";
    const expires = "2027-09-24T12:00:00.000Z";
    const secretHash = Buffer.alloc(32, 7);
    const pairingId = "synthetic-social-pairing";
    const sessionId = "synthetic-social-session";

    await pool.query(`INSERT INTO ${sqlSchema}.participants(id,owner_kind,state,created_at)
      VALUES ($1,'social','active',$2::timestamptz)`, [OWNER_ID, now]);
    await pool.query(`INSERT INTO ${sqlSchema}.web_sessions(
      id,participant_id,secret_hash,csrf_hash,issued_at,expires_at,last_used_at)
      VALUES ($1,$2,$3,$3,$4::timestamptz,$5::timestamptz,$4::timestamptz)`,
    [sessionId, OWNER_ID, secretHash, now, expires]);
    await pool.query(`INSERT INTO ${sqlSchema}.device_pairings(
      id,participant_id,issued_by_session_id,secret_hash,consent_version,
      transport_consent_version,state,issued_at,expires_at,consumed_at,claimed_device_id)
      VALUES ($1,$2,$3,$4,'synthetic-consent','synthetic-transport','consumed',
        $5::timestamptz,$6::timestamptz,$5::timestamptz,$7)`,
    [pairingId, OWNER_ID, sessionId, secretHash, now, expires, DEVICE_ID]);
    await pool.query(`INSERT INTO ${sqlSchema}.device_credentials(
      id,participant_id,paired_via_pairing_id,secret_hash,issued_at,expires_at,last_used_at)
      VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$5::timestamptz)`,
    [DEVICE_ID, OWNER_ID, pairingId, secretHash, now, expires]);
    const chunkCount = Math.ceil(eventCount / 200);
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const start = chunkIndex * 200 + 1;
      const count = Math.min(200, eventCount - chunkIndex * 200);
      const chunkId = `synthetic-social-usage-chunk-${chunkIndex}`;
      const authorizationId = `synthetic-social-upload-authorization-${chunkIndex}`;
      const envelopeDigest = (chunkIndex + 0x100000).toString(16).padStart(64, "0");
      const chunkDigest = (chunkIndex + 0x200000).toString(16).padStart(64, "0");
      const objectKey = `synthetic/${chunkId}`;
      await pool.query(`INSERT INTO ${sqlSchema}.device_upload_authorizations(
        id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,
        content_type,state,issued_at,expires_at,consumed_at)
        VALUES ($1,$2,$3,$4,$5,64,'application/json','consumed',$6::timestamptz,
          $7::timestamptz,$6::timestamptz)`,
      [authorizationId, OWNER_ID, DEVICE_ID, secretHash, envelopeDigest, now, expires]);
      await pool.query(`INSERT INTO ${sqlSchema}.pending_objects(contribution_id,object_key,object_kind)
        VALUES ($1,$2,'telemetry_v1')`, [chunkId, objectKey]);
      await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v1_chunks(
        id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,
        envelope_digest,parser_version,record_count,accepted_record_count,r2_key,
        device_upload_authorization_id,created_at)
        VALUES ($1,$2,$3,'usage',$4::date,$5,1,$6,$7,'synthetic-publisher-v1',
          $8,$8,$9,$10,$11::timestamptz)`,
      [chunkId, OWNER_ID, DEVICE_ID, DAY, chunkIndex, chunkDigest, envelopeDigest,
        count, objectKey, authorizationId, now]);
      await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v1_records(
        chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,observed_day,
        provider,model_id,input_uncached_tokens,input_cache_read_tokens,input_cache_write_tokens,
        output_text_tokens,output_reasoning_tokens,output_combined_tokens,record_json)
        SELECT $1,$2,$3,'usage','event:v2:' || lpad(g::text,64,'a'),
          '2026-09-24T12:05:00.000Z'::timestamptz,$4::date,
          'openai_codex','gpt-5.6-sol',100,900,0,50,25,NULL,
          jsonb_build_object(
            'schemaVersion','usage-event-v1.0',
            'eventId','event:v2:' || lpad(g::text,64,'a'),
            'eventTime','2026-09-24T12:05:00.000Z',
            'sessionUuid','0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b',
            'provider','openai_codex','modelId','gpt-5.6-sol','speedMode','fast',
            'apiServiceTier','priority','surface','local_interactive_unclassified',
            'billingSurface','chatgpt_subscription','reasoningEffort','xhigh',
            'agentScope','root','outcome','completed','totalInputContextTokens',NULL,
            'components',jsonb_build_object('inputUncachedTokens',100,
              'inputCacheReadTokens',900,'inputCacheWriteTokens',0,
              'outputTextTokens',50,'outputReasoningTokens',25,'outputCombinedTokens',NULL))
        FROM generate_series($5::int,$6::int) g`,
      [chunkId, OWNER_ID, DEVICE_ID, DAY, start, start + count - 1]);
    }
    await pool.query(`ANALYZE ${sqlSchema}.telemetry_v1_chunks`);
    await pool.query(`ANALYZE ${sqlSchema}.telemetry_v1_records`);
  }

  async function addOneUsageEvent() { await addUsageEvents(1); }

  async function addActiveV11UsageOwner(eventCount) {
    const now = "2026-09-24T12:00:00.000Z";
    const expires = "2027-09-24T12:00:00.000Z";
    const secretHash = Buffer.alloc(32, 8);
    const owner = "synthetic-v11-social-owner";
    const device = "synthetic-v11-social-device";
    const session = "synthetic-v11-social-session";
    const pairing = "synthetic-v11-social-pairing";
    const manifest = "10000000-0000-4000-8000-000000000011";
    const generation = "10000000-0000-4000-8000-000000000012";
    const predecessor = "1".repeat(64);
    const manifestDigest = "2".repeat(64);
    const fingerprint = "3".repeat(64);
    await pool.query(`INSERT INTO ${sqlSchema}.participants(id,owner_kind,state,created_at)
      VALUES ($1,'social','active',$2::timestamptz)`, [owner, now]);
    await pool.query(`INSERT INTO ${sqlSchema}.web_sessions(
      id,participant_id,secret_hash,csrf_hash,issued_at,expires_at,last_used_at)
      VALUES ($1,$2,$3,$3,$4::timestamptz,$5::timestamptz,$4::timestamptz)`,
    [session, owner, secretHash, now, expires]);
    await pool.query(`INSERT INTO ${sqlSchema}.device_pairings(
      id,participant_id,issued_by_session_id,secret_hash,consent_version,
      transport_consent_version,state,issued_at,expires_at,consumed_at,claimed_device_id)
      VALUES ($1,$2,$3,$4,'synthetic-consent','synthetic-transport','consumed',
        $5::timestamptz,$6::timestamptz,$5::timestamptz,$7)`,
    [pairing, owner, session, secretHash, now, expires, device]);
    await pool.query(`INSERT INTO ${sqlSchema}.device_credentials(
      id,participant_id,paired_via_pairing_id,secret_hash,issued_at,expires_at,last_used_at)
      VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$5::timestamptz)`,
    [device, owner, pairing, secretHash, now, expires]);
    const chunkCount = Math.ceil(eventCount / 200);
    const manifestJson = JSON.stringify({ schemaVersion: "telemetry-day-manifest-v1.1", day: DAY });
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_day_manifests(
      id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,
      expected_chunk_count,state,created_at,ready_at)
      VALUES ($1,$2,$3,$4::date,$5,'synthetic-v11',$6,$7,'ready',$8::timestamptz,$8::timestamptz)`,
    [manifest, owner, device, DAY, manifestDigest, manifestJson, chunkCount, now]);

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const start = chunkIndex * 200 + 1;
      const count = Math.min(200, eventCount - chunkIndex * 200);
      const chunkId = `synthetic-v11-usage-chunk-${chunkIndex}`;
      const authorizationId = `synthetic-v11-upload-authorization-${chunkIndex}`;
      const envelopeDigest = (chunkIndex + 0x300000).toString(16).padStart(64, "0");
      const chunkDigest = (chunkIndex + 0x400000).toString(16).padStart(64, "0");
      const objectKey = `synthetic-v11/${chunkId}`;
      await pool.query(`INSERT INTO ${sqlSchema}.device_upload_authorizations(
        id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,
        content_type,state,issued_at,expires_at,consumed_at)
        VALUES ($1,$2,$3,$4,$5,64,'application/json','consumed',
          $6::timestamptz,$7::timestamptz,$6::timestamptz)`,
      [authorizationId, owner, device, secretHash, envelopeDigest, now, expires]);
      await pool.query(`INSERT INTO ${sqlSchema}.pending_objects(contribution_id,object_key,object_kind)
        VALUES ($1,$2,'telemetry_v11')`, [chunkId, objectKey]);
      await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_chunks(
        id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,
        envelope_digest,parser_version,record_count,r2_key,device_upload_authorization_id,created_at)
        VALUES ($1,$2,$3,$4,'usage',$5::date,$6,$7,$8,$9,'synthetic-v11',$10,$11,$12,$13::timestamptz)`,
      [chunkId, manifest, owner, device, DAY, chunkIndex, `usage:${DAY}:${chunkIndex}`,
        chunkDigest, envelopeDigest, count, objectKey, authorizationId, now]);
      await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_records(
        chunk_id,manifest_id,stream,occurrence_id,observed_at,record_json)
        SELECT $1,$2,'usage','event:v2:' || lpad(g::text,64,'b'),$3::timestamptz,
          jsonb_build_object(
            'schemaVersion','usage-event-v1.1',
            'eventId','event:v2:' || lpad(g::text,64,'b'),
            'eventTime','2026-09-24T12:05:00.000Z',
            'sessionUuid','0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b',
            'provider','openai_codex','modelId','gpt-5.6-sol','speedMode','standard',
            'apiServiceTier','default','surface','local_interactive_unclassified',
            'billingSurface','chatgpt_subscription','reasoningEffort','high',
            'agentScope','root','outcome','completed','totalInputContextTokens',1000,
            'components',jsonb_build_object('inputUncachedTokens',100,
              'inputCacheReadTokens',900,'inputCacheWriteTokens',0,
              'outputTextTokens',50,'outputReasoningTokens',25,'outputCombinedTokens',NULL),
            'accountPlanAttribution',jsonb_build_object('accountBasis','unavailable',
              'accountTrackId',NULL,'planBasis','same_source_occurrence','planType','pro','planEraId',NULL))::text
        FROM generate_series($4::int,$5::int) g`,
      [chunkId, manifest, "2026-09-24T12:05:00.000Z", start, start + count - 1]);
    }
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domain_predecessors(
      token_hash,participant_id,device_id,legacy_fingerprint,input_revision,from_day,through_day,
      winners_json,created_at,expires_at)
      VALUES ($1,$2,$3,$4,0,$5::date,$5::date,'[]',$6::timestamptz,$7::timestamptz)`,
    [predecessor, owner, device, fingerprint, DAY, now, expires]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domains(
      id,participant_id,device_id,predecessor_token_hash,manifest_digest,legacy_fingerprint,
      input_revision,from_day,through_day,days_json,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,0,$7::date,$7::date,$8,$9::timestamptz)`,
    [generation, owner, device, predecessor, manifestDigest, fingerprint, DAY,
      JSON.stringify([{ day: DAY, manifestId: manifest, manifestDigest }]), now]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domain_days(generation_id,observed_day,manifest_id)
      VALUES ($1,$2::date,$3)`, [generation, DAY, manifest]);
    // Imported D1 state: the owner link already names the accepted head, so
    // primary 0060's v1.1 bridge records nothing new for it.
    await pool.query(`INSERT INTO ${sqlSchema}.storage_v11_owner_links(
      participant_id,owner_digest,state,generation_id,head_revision)
      VALUES ($1,$2,'active',$3,1)`, [owner, "4".repeat(64), generation]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domain_heads(participant_id,generation_id,revision,updated_at)
      VALUES ($1,$2,1,$3::timestamptz)`, [owner, generation, now]);
    await pool.query(`ANALYZE ${sqlSchema}.telemetry_v11_chunks`);
    await pool.query(`ANALYZE ${sqlSchema}.telemetry_v11_records`);
  }

  function observedPool(fetchMutation) {
    const stats = { checkouts: 0, releases: 0, active: 0, maxActive: 0,
      fetches: 0, rollbacks: 0, cursorCountAfterRollback: null };
    return {
      stats,
      pool: {
        async connect() {
          stats.checkouts += 1;
          const client = await pool.connect();
          stats.active += 1;
          stats.maxActive = Math.max(stats.maxActive, stats.active);
          return {
            async query(text, values) {
              const sql = String(text).trim();
              const result = await client.query(text, values);
              if (/^FETCH\b/iu.test(sql)) {
                stats.fetches += 1;
                return fetchMutation ? fetchMutation(result, stats.fetches) : result;
              }
              if (/^ROLLBACK\b/iu.test(sql)) {
                stats.rollbacks += 1;
                const cursorCheck = await client.query(
                  "SELECT count(*)::int AS count FROM pg_cursors WHERE name=$1",
                  ["community_daily_spend_cursor"],
                );
                stats.cursorCountAfterRollback = cursorCheck.rows[0]?.count;
              }
              return result;
            },
            release(discard) {
              stats.releases += 1;
              stats.active -= 1;
              return client.release(discard);
            },
          };
        },
      },
    };
  }

  async function sourceSnapshot() {
    const result = await pool.query(`SELECT
      (SELECT count(*)::int FROM ${sqlSchema}.telemetry_v1_chunks) AS v1_chunks,
      (SELECT count(*)::int FROM ${sqlSchema}.telemetry_v1_records) AS v1_records,
      (SELECT count(*)::int FROM ${sqlSchema}.telemetry_v11_chunks) AS v11_chunks,
      (SELECT count(*)::int FROM ${sqlSchema}.telemetry_v11_records) AS v11_records,
      (SELECT count(*)::int FROM ${sqlSchema}.pending_objects) AS pending_objects,
      (SELECT md5(COALESCE(string_agg(id || ':' || chunk_digest || ':' || accepted_record_count::text,
        E'\\n' ORDER BY id), '')) FROM ${sqlSchema}.telemetry_v1_chunks) AS v1_chunk_digest,
      (SELECT md5(COALESCE(string_agg(chunk_row_id || ':' || occurrence_id || ':' || record_json::text,
        E'\\n' ORDER BY chunk_row_id, occurrence_id), '')) FROM ${sqlSchema}.telemetry_v1_records) AS v1_record_digest,
      (SELECT md5(COALESCE(string_agg(id || ':' || chunk_digest || ':' || record_count::text,
        E'\\n' ORDER BY id), '')) FROM ${sqlSchema}.telemetry_v11_chunks) AS v11_chunk_digest,
      (SELECT md5(COALESCE(string_agg(chunk_id || ':' || occurrence_id || ':' || record_json,
        E'\\n' ORDER BY chunk_id, occurrence_id), '')) FROM ${sqlSchema}.telemetry_v11_records) AS v11_record_digest`);
    return result.rows[0];
  }

  async function addAccountlessRetainedV11Day({ mismatchedLedgerHash = false } = {}) {
    const deviceId = randomUUID();
    const participantId = `synthetic-accountless-${randomUUID()}`;
    const secret = randomBytes(32).toString("base64url");
    const authorization = `Device um_device_${deviceId}.${secret}`;
    const secretHash = Buffer.from(await deviceHash(deviceId, secret));
    const storedLedgerHash = mismatchedLedgerHash ? Buffer.alloc(32, 0x3d) : secretHash;
    const now = "2026-09-24T00:00:00.000Z";
    const expires = "2027-09-24T00:00:00.000Z";
    const generationId = randomUUID();
    const predecessorHash = "2".repeat(64);
    const manifestId = randomUUID();
    const chunkId = `synthetic-v11-${randomUUID()}`;
    const chunkDigest = "3".repeat(64);
    const envelopeDigest = "4".repeat(64);
    const chunkObjectKey = `synthetic/${chunkId}`;
    const consumedAuthorizationId = `synthetic-consumed-${randomUUID()}`;
    const pendingAuthorizationIds = [
      `synthetic-unused-${randomUUID()}`,
      `synthetic-consuming-${randomUUID()}`,
    ];
    const ownerDigest = "5".repeat(64);
    const record = usageRecord();
    const manifestJson = JSON.stringify({
      schemaVersion: "telemetry-v11-day-manifest-v1.0",
      chunks: [{ chunkId, chunkDigest, recordCount: 1, stream: "usage" }],
    });

    await pool.query(`INSERT INTO ${sqlSchema}.participants(id,owner_kind,state,created_at)
      VALUES ($1,'accountless','active',$2::timestamptz)`, [participantId, now]);
    await pool.query(`INSERT INTO ${sqlSchema}.accountless_enrollment_ledger(
      device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,
      authorization_basis,state,issued_at,expires_at)
      VALUES ($1,$2,$3,'accountless-enrollment-v0.1','accountless-opt-out-v1',
        'accountless-policy-v1','active',$4::timestamptz,$5::timestamptz)`,
    [deviceId, storedLedgerHash, `accountless:${deviceId}`, now, expires]);
    await pool.query(`INSERT INTO ${sqlSchema}.device_credentials(
      id,participant_id,authority_kind,accountless_enrollment_device_id,secret_hash,
      state,issued_at,expires_at,last_used_at)
      VALUES ($1,$2,'accountless',$1,$3,'active',$4::timestamptz,$5::timestamptz,$4::timestamptz)`,
    [deviceId, participantId, secretHash, now, expires]);
    await pool.query(`INSERT INTO ${sqlSchema}.accountless_upload_owners(
      enrollment_device_id,participant_id,device_credential_id,policy_version,
      authorization_basis,authorized_at,expires_at,state)
      VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',
        $3::timestamptz,$4::timestamptz,'active')`, [deviceId, participantId, now, expires]);
    await pool.query(`INSERT INTO ${sqlSchema}.accountless_v11_device_authorizations(
      enrollment_device_id,participant_id,device_credential_id,telemetry_schema_version,
      field_dictionary_version,privacy_contract_version,authorized_at,expires_at,state)
      VALUES ($1,$2,$1,'telemetry-contribution-v1.1',
        'telemetry-v1.1-registry-2026-08-31.1','ongoing-privacy-safe-telemetry-v1.1',
        $3::timestamptz,$4::timestamptz,'active')`,
    [deviceId, participantId, now, expires]);

    for (const [authorizationId, state] of [
      [consumedAuthorizationId, "consumed"],
      [pendingAuthorizationIds[0], "unused"],
      [pendingAuthorizationIds[1], "consuming"],
    ]) {
      await pool.query(`INSERT INTO ${sqlSchema}.device_upload_authorizations(
        id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,
        content_type,state,issued_at,expires_at,consumed_at,consume_lease_expires_at,
        consumed_contribution_id)
        VALUES ($1,$2,$3,$4,$5,1,'application/json',$6,$7::timestamptz,
          $8::timestamptz,CASE WHEN $6='consumed' THEN $7::timestamptz ELSE NULL END,
          CASE WHEN $6='consuming' THEN $8::timestamptz ELSE NULL END,
          CASE WHEN $6='consumed' THEN $9 ELSE NULL END)`,
      [authorizationId, participantId, deviceId, Buffer.alloc(32, 0x2a),
        (authorizationId === consumedAuthorizationId ? envelopeDigest : "6".repeat(64)),
        state, now, expires, chunkId]);
    }
    await pool.query(`INSERT INTO ${sqlSchema}.pending_objects(contribution_id,object_key)
      VALUES ($1,$2)`, [chunkId, chunkObjectKey]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_day_manifests(
      id,participant_id,device_id,chunk_day,manifest_digest,parser_version,
      manifest_json,expected_chunk_count,state,created_at,ready_at)
      VALUES ($1,$2,$3,$4::date,$5,'synthetic-v11-day', $6,1,'ready',
        $7::timestamptz,$7::timestamptz)`,
    [manifestId, participantId, deviceId, DAY, "7".repeat(64), manifestJson, now]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_chunks(
      id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,
      chunk_digest,envelope_digest,parser_version,record_count,r2_key,
      device_upload_authorization_id,created_at)
      VALUES ($1,$2,$3,$4,'usage',$5::date,0,$6,$7,$8,'synthetic-v11-day',1,$9,$10,$11::timestamptz)`,
    [chunkId, manifestId, participantId, deviceId, DAY, chunkId, chunkDigest,
      envelopeDigest, chunkObjectKey, consumedAuthorizationId, now]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_records(
      chunk_id,manifest_id,stream,occurrence_id,observed_at,record_json)
      VALUES ($1,$2,'usage',$3,$4::timestamptz,$5)`,
    [chunkId, manifestId, record.eventId, record.eventTime, JSON.stringify(record)]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domain_predecessors(
      token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,
      input_revision,from_day,through_day,winners_json,created_at,expires_at,consumed_at)
      VALUES ($1,$2,$3,NULL,$4,0,$5::date,$5::date,'{}',$6::timestamptz,
        $7::timestamptz,$6::timestamptz)`,
    [predecessorHash, participantId, deviceId, "8".repeat(64), DAY, now, expires]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domains(
      id,participant_id,device_id,predecessor_token_hash,previous_generation_id,
      manifest_digest,legacy_fingerprint,input_revision,from_day,through_day,days_json,created_at)
      VALUES ($1,$2,$3,$4,NULL,$5,$6,0,$7::date,$7::date,$8,$9::timestamptz)`,
    [generationId, participantId, deviceId, predecessorHash, "9".repeat(64),
      "8".repeat(64), DAY, JSON.stringify([{ day: DAY, manifestId }]), now]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domain_days(generation_id,observed_day,manifest_id)
      VALUES ($1,$2::date,$3)`, [generationId, DAY, manifestId]);
    // Imported D1 state: the owner link already names the accepted head, so
    // primary 0060's v1.1 bridge records nothing new for it.
    await pool.query(`INSERT INTO ${sqlSchema}.storage_v11_owner_links(
      participant_id,owner_digest,state,generation_id,head_revision)
      VALUES ($1,$2,'active',$3,1)`, [participantId, ownerDigest, generationId]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domain_heads(
      participant_id,generation_id,revision,updated_at)
      VALUES ($1,$2,1,$3::timestamptz)`, [participantId, generationId, now]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_owner_state(
      source_id,owner_digest,revision,authority_epoch,state)
      VALUES ($1,$2,1,0,'active')`, [SOURCE_ID, ownerDigest]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_publication_owner_members(
      source_id,day,metric,generation,owner_digest)
      VALUES ($1,$2::date,'daily','synthetic-daily-generation',$3)`, [SOURCE_ID, DAY, ownerDigest]);
    const payloadJson = JSON.stringify({ schemaVersion: "community-daily-aggregate-v1.0", day: DAY });
    const payloadDigest = createHash("sha256").update(payloadJson).digest("hex");
    await pool.query(`INSERT INTO ${sqlSchema}.community_daily_aggregates(
      source_id,source_namespace,day,revision,payload_json,payload_sha256,
      source_authority_epoch,source_cursor_sequence,policy_revision,
      collection_revision,release_state,released_at)
      VALUES ($1,$2,$3::date,1,$4,$5,0,0,1,1,'published',$6::timestamptz)`,
    [SOURCE_ID, SOURCE_NAMESPACE, DAY, payloadJson, payloadDigest, now]);

    return {
      authorization,
      deviceId,
      participantId,
      ownerDigest,
      consumedAuthorizationId,
      pendingAuthorizationIds,
      generationId,
      secretHash,
      nowEpoch: Date.parse("2026-09-25T12:00:00.000Z"),
    };
  }

  async function qualifyTypedV11Runtime() {
    await pool.query(`UPDATE ${sqlSchema}.typed_v11_admission_state SET runtime_contract_version=1
      WHERE id=1 AND runtime_contract_version=0`);
  }

  async function publish(options = {}, publicationPool = pool) {
    await qualifyTypedV11Runtime();
    return publishPostgresCommunityDailyDay(publicationPool, {
      sourceId: SOURCE_ID,
      sourceNamespace: SOURCE_NAMESPACE,
      day: DAY,
      nowMs: NOW_MS,
      schema: { primarySchema: schema },
      ...options,
    });
  }

  it("reports only exact selected-day v1 and v1.1 record-presence booleans", async () => {
    const readEligibility = () => readPostgresCommunityDailyDaySourceEligibility(pool, {
      day: DAY,
      schema: { primarySchema: schema },
    });

    expect(await readEligibility()).toEqual({
      v1SelectedRecordsPresent: false,
      v11SelectedRecordsPresent: false,
    });
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionOpen = true;
      expect(await readPostgresCommunityDailyDaySourceEligibility(client, {
        day: DAY,
        schema: { primarySchema: schema },
      })).toEqual({ v1SelectedRecordsPresent: false, v11SelectedRecordsPresent: false });
      await client.query("COMMIT");
      transactionOpen = false;
    } finally {
      if (transactionOpen) await client.query("ROLLBACK");
      client.release();
    }
    await addOneUsageEvent();
    expect(await readEligibility()).toEqual({
      v1SelectedRecordsPresent: true,
      v11SelectedRecordsPresent: false,
    });
  });

  it("retains the exact accepted v1.1 day across accountless opt-out without withdrawing publication", async () => {
    const fixture = await addAccountlessRetainedV11Day();
    const readEligibility = () => readPostgresCommunityDailyDaySourceEligibility(pool, {
      day: DAY,
      schema: { primarySchema: schema },
    });
    expect(await readEligibility()).toEqual({
      v1SelectedRecordsPresent: false,
      v11SelectedRecordsPresent: true,
    });
    const changesBefore = await pool.query(`SELECT sequence,event_digest,owner_digest,owner_revision,
      authority_epoch,kind,recorded_ms FROM ${sqlSchema}.storage_ingestion_changes
      WHERE source_id=$1 ORDER BY sequence`, [SOURCE_ID]);
    const publicationBefore = await pool.query(`SELECT revision,release_state,payload_sha256
      FROM ${sqlSchema}.community_daily_aggregates WHERE source_id=$1 AND day=$2::date`,
    [SOURCE_ID, DAY]);
    const membersBefore = await pool.query(`SELECT source_id,day,metric,generation,owner_digest
      FROM ${sqlSchema}.analytics_publication_owner_members
      WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, fixture.ownerDigest]);

    await expect(disconnectPostgresAuthenticatedDevice(pool, fixture.authorization, {
      nowEpoch: fixture.nowEpoch,
      schema: { primarySchema: schema },
    })).resolves.toEqual({ deviceId: fixture.deviceId, revoked: true });

    expect(await readEligibility()).toEqual({
      v1SelectedRecordsPresent: false,
      v11SelectedRecordsPresent: true,
    });
    const authority = await pool.query(`SELECT ledger.state AS ledger_state,
      ledger.revoked_at,ledger.revocation_reason,owner.state AS owner_state,
      owner.revoked_at AS owner_revoked_at,owner.revocation_reason AS owner_reason,
      grant_row.state AS grant_state,grant_row.revoked_at AS grant_revoked_at,
      grant_row.revocation_reason AS grant_reason,device.state AS device_state,
      device.revoked_at AS device_revoked_at
      FROM ${sqlSchema}.accountless_enrollment_ledger ledger
      JOIN ${sqlSchema}.accountless_upload_owners owner
        ON owner.enrollment_device_id=ledger.device_id
      JOIN ${sqlSchema}.accountless_v11_device_authorizations grant_row
        ON grant_row.enrollment_device_id=ledger.device_id
      JOIN ${sqlSchema}.device_credentials device ON device.id=ledger.device_id
      WHERE ledger.device_id=$1`, [fixture.deviceId]);
    expect(authority.rows).toHaveLength(1);
    const row = authority.rows[0];
    expect(row).toMatchObject({
      ledger_state: "revoked",
      revocation_reason: "user_opt_out",
      owner_state: "revoked",
      owner_reason: "user_opt_out",
      grant_state: "revoked",
      grant_reason: "user_opt_out",
      device_state: "revoked",
    });
    expect(row.owner_revoked_at).toEqual(row.revoked_at);
    expect(row.grant_revoked_at).toEqual(row.revoked_at);
    expect(row.device_revoked_at).toEqual(row.revoked_at);

    const marker = await pool.query(`SELECT participant_id,enrollment_device_id,
      device_credential_id,generation_id,head_revision,retained_at
      FROM ${sqlSchema}.accountless_public_history_retention
      WHERE enrollment_device_id=$1`, [fixture.deviceId]);
    expect(marker.rows).toEqual([{
      participant_id: fixture.participantId,
      enrollment_device_id: fixture.deviceId,
      device_credential_id: fixture.deviceId,
      generation_id: fixture.generationId,
      head_revision: 1,
      retained_at: new Date(fixture.nowEpoch),
    }]);
    const uploads = await pool.query(`SELECT id,state,revoked_at,consume_lease_expires_at,consumed_at
      FROM ${sqlSchema}.device_upload_authorizations WHERE issued_by_device_id=$1 ORDER BY id`,
    [fixture.deviceId]);
    expect(uploads.rows).toHaveLength(3);
    for (const upload of uploads.rows) {
      if (upload.id === fixture.consumedAuthorizationId) {
        expect(upload).toMatchObject({ state: "consumed", revoked_at: null, consumed_at: expect.any(Date) });
      } else {
        expect(upload).toMatchObject({ state: "revoked", consume_lease_expires_at: null });
        expect(upload.revoked_at).toEqual(row.revoked_at);
      }
    }

    expect((await pool.query(`SELECT state FROM ${sqlSchema}.storage_v11_owner_links
      WHERE participant_id=$1`, [fixture.participantId])).rows).toEqual([{ state: "active" }]);
    expect((await pool.query(`SELECT state FROM ${sqlSchema}.analytics_owner_state
      WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, fixture.ownerDigest])).rows)
      .toEqual([{ state: "active" }]);
    expect((await pool.query(`SELECT source_id,day,metric,generation,owner_digest
      FROM ${sqlSchema}.analytics_publication_owner_members
      WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, fixture.ownerDigest])).rows)
      .toEqual(membersBefore.rows);
    expect((await pool.query(`SELECT revision,release_state,payload_sha256
      FROM ${sqlSchema}.community_daily_aggregates WHERE source_id=$1 AND day=$2::date`,
    [SOURCE_ID, DAY])).rows).toEqual(publicationBefore.rows);
    expect((await pool.query(`SELECT sequence,event_digest,owner_digest,owner_revision,
      authority_epoch,kind,recorded_ms FROM ${sqlSchema}.storage_ingestion_changes
      WHERE source_id=$1 ORDER BY sequence`, [SOURCE_ID])).rows).toEqual(changesBefore.rows);

    await expect(disconnectPostgresAuthenticatedDevice(pool, fixture.authorization, {
      nowEpoch: fixture.nowEpoch + 60_000,
      schema: { primarySchema: schema },
    })).resolves.toEqual({ deviceId: fixture.deviceId, revoked: true });
    expect((await pool.query(`SELECT retained_at FROM ${sqlSchema}.accountless_public_history_retention
      WHERE enrollment_device_id=$1`, [fixture.deviceId])).rows)
      .toEqual([{ retained_at: new Date(fixture.nowEpoch) }]);
    expect(await readEligibility()).toEqual({
      v1SelectedRecordsPresent: false,
      v11SelectedRecordsPresent: true,
    });

    // The retained marker needs the exact enrollment secret: a ledger hash
    // that no longer matches the device excludes the day, and restoring it
    // includes the day again.
    await pool.query(`UPDATE ${sqlSchema}.accountless_enrollment_ledger
      SET device_secret_hash=$2 WHERE device_id=$1`,
    [fixture.deviceId, Buffer.alloc(32, 0x5e)]);
    expect(await readEligibility()).toEqual({
      v1SelectedRecordsPresent: false,
      v11SelectedRecordsPresent: false,
    });
    await pool.query(`UPDATE ${sqlSchema}.accountless_enrollment_ledger
      SET device_secret_hash=$2 WHERE device_id=$1`, [fixture.deviceId, fixture.secretHash]);
    expect(await readEligibility()).toEqual({
      v1SelectedRecordsPresent: false,
      v11SelectedRecordsPresent: true,
    });

    // The marker pins the exact head too, each column on its own. A revision
    // bump on the retained generation changes only the revision and excludes
    // the day. A head never moves back (primary 0060, as D1's head
    // classification, refuses a revision-down update), so these steps run
    // last and are not reverted.
    await pool.query(`UPDATE ${sqlSchema}.telemetry_v11_domain_heads
      SET revision=revision+1 WHERE participant_id=$1 AND generation_id=$2`,
    [fixture.participantId, fixture.generationId]);
    expect((await pool.query(`SELECT generation_id,revision::int AS revision
      FROM ${sqlSchema}.telemetry_v11_domain_heads WHERE participant_id=$1`, [fixture.participantId])).rows)
      .toEqual([{ generation_id: fixture.generationId, revision: 2 }]);
    expect(await readEligibility()).toEqual({
      v1SelectedRecordsPresent: false,
      v11SelectedRecordsPresent: false,
    });
    // A successor generation excludes it as well.
    const successorToken = "a".repeat(64);
    const successorGeneration = randomUUID();
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domain_predecessors(
      token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,
      input_revision,from_day,through_day,winners_json,created_at,expires_at,consumed_at)
      VALUES ($1,$2,$3,$4,$5,0,$6::date,$6::date,'{}',$7::timestamptz,$8::timestamptz,$7::timestamptz)`,
    [successorToken, fixture.participantId, fixture.deviceId, fixture.generationId, "8".repeat(64), DAY,
      "2026-09-24T01:00:00.000Z", "2027-09-24T00:00:00.000Z"]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domains(
      id,participant_id,device_id,predecessor_token_hash,previous_generation_id,
      manifest_digest,legacy_fingerprint,input_revision,from_day,through_day,days_json,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8::date,$8::date,'[]',$9::timestamptz)`,
    [successorGeneration, fixture.participantId, fixture.deviceId, successorToken, fixture.generationId,
      "b".repeat(64), "8".repeat(64), DAY, "2026-09-24T01:00:00.000Z"]);
    await pool.query(`UPDATE ${sqlSchema}.telemetry_v11_domain_heads
      SET generation_id=$2, revision=3 WHERE participant_id=$1`, [fixture.participantId, successorGeneration]);
    expect(await readEligibility()).toEqual({
      v1SelectedRecordsPresent: false,
      v11SelectedRecordsPresent: false,
    });
  });

  it("does not infer retained history for a pre-cutover opt-out without its exact marker", async () => {
    const fixture = await addAccountlessRetainedV11Day();
    // Model a transfer that copied the revoked authority rows and active
    // owner link but omitted D1's exact retention marker. The current head is
    // present, but inferring a marker from it would invent retained authority.
    const revokedAt = new Date(fixture.nowEpoch);
    await pool.query(`UPDATE ${sqlSchema}.accountless_enrollment_ledger
      SET state='revoked',revoked_at=$2::timestamptz,revocation_reason='user_opt_out'
      WHERE device_id=$1`, [fixture.deviceId, revokedAt]);
    await pool.query(`UPDATE ${sqlSchema}.accountless_upload_owners
      SET state='revoked',revoked_at=$2::timestamptz,revocation_reason='user_opt_out'
      WHERE enrollment_device_id=$1`, [fixture.deviceId, revokedAt]);
    await pool.query(`UPDATE ${sqlSchema}.accountless_v11_device_authorizations
      SET state='revoked',revoked_at=$2::timestamptz,revocation_reason='user_opt_out'
      WHERE enrollment_device_id=$1`, [fixture.deviceId, revokedAt]);
    await pool.query(`UPDATE ${sqlSchema}.device_credentials
      SET state='revoked',revoked_at=$2::timestamptz
      WHERE id=$1`, [fixture.deviceId, revokedAt]);

    expect((await pool.query(`SELECT state FROM ${sqlSchema}.storage_v11_owner_links
      WHERE participant_id=$1`, [fixture.participantId])).rows).toEqual([{ state: "active" }]);
    expect((await pool.query(`SELECT count(*)::integer AS count
      FROM ${sqlSchema}.accountless_public_history_retention WHERE participant_id=$1`,
    [fixture.participantId])).rows).toEqual([{ count: 0 }]);
    expect(await readPostgresCommunityDailyDaySourceEligibility(pool, {
      day: DAY,
      schema: { primarySchema: schema },
    })).toEqual({
      v1SelectedRecordsPresent: false,
      v11SelectedRecordsPresent: false,
    });
  });

  it("fails closed and rolls back accountless opt-out if the exact v1.1 source authority is invalid", async () => {
    const fixture = await addAccountlessRetainedV11Day({ mismatchedLedgerHash: true });
    const statesBefore = await pool.query(`SELECT ledger.state AS ledger_state,
      owner.state AS owner_state,grant_row.state AS grant_state,device.state AS device_state
      FROM ${sqlSchema}.accountless_enrollment_ledger ledger
      JOIN ${sqlSchema}.accountless_upload_owners owner
        ON owner.enrollment_device_id=ledger.device_id
      JOIN ${sqlSchema}.accountless_v11_device_authorizations grant_row
        ON grant_row.enrollment_device_id=ledger.device_id
      JOIN ${sqlSchema}.device_credentials device ON device.id=ledger.device_id
      WHERE ledger.device_id=$1`, [fixture.deviceId]);
    const journalBefore = await pool.query(`SELECT count(*)::integer AS count
      FROM ${sqlSchema}.storage_ingestion_changes WHERE source_id=$1`, [SOURCE_ID]);
    await expect(disconnectPostgresAuthenticatedDevice(pool, fixture.authorization, {
      nowEpoch: fixture.nowEpoch,
      schema: { primarySchema: schema },
    })).rejects.toMatchObject({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    expect((await pool.query(`SELECT ledger.state AS ledger_state,
      owner.state AS owner_state,grant_row.state AS grant_state,device.state AS device_state
      FROM ${sqlSchema}.accountless_enrollment_ledger ledger
      JOIN ${sqlSchema}.accountless_upload_owners owner
        ON owner.enrollment_device_id=ledger.device_id
      JOIN ${sqlSchema}.accountless_v11_device_authorizations grant_row
        ON grant_row.enrollment_device_id=ledger.device_id
      JOIN ${sqlSchema}.device_credentials device ON device.id=ledger.device_id
      WHERE ledger.device_id=$1`, [fixture.deviceId])).rows).toEqual(statesBefore.rows);
    expect((await pool.query(`SELECT count(*)::integer AS count
      FROM ${sqlSchema}.accountless_public_history_retention WHERE enrollment_device_id=$1`,
    [fixture.deviceId])).rows).toEqual([{ count: 0 }]);
    expect((await pool.query(`SELECT count(*)::integer AS count
      FROM ${sqlSchema}.storage_ingestion_changes WHERE source_id=$1`, [SOURCE_ID])).rows)
      .toEqual(journalBefore.rows);
  });

  it("publishes content-free activity and API spend once, then makes a new immutable revision after the cursor advances", async () => {
    await addOneUsageEvent();
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 1 });

    const row = (await pool.query(`SELECT payload_json,payload_sha256,release_state
      FROM ${sqlSchema}.community_daily_aggregates WHERE source_id=$1 AND day=$2::date`, [SOURCE_ID, DAY])).rows[0];
    assert.equal(row?.release_state, "published");
    const payload = JSON.parse(row.payload_json);
    expect(payload).toMatchObject({
      schemaVersion: "community-daily-aggregate-v1.0",
      aggregateId: `community-daily:${DAY}:r1`,
      day: DAY,
      revision: 1,
      totals: { contributingParticipants: 1, contributingDevices: 1, usageEvents: 1,
        inputUncachedTokens: 100, inputCacheReadTokens: 900, outputTextTokens: 50,
        outputReasoningTokens: 25 },
      cells: [{ provider: "openai_codex", modelId: "gpt-5.6-sol", usageEvents: 1,
        inputUncachedTokens: 100, inputCacheReadTokens: 900, outputTextTokens: 50,
        outputReasoningTokens: 25 }],
      apiEquivalentSpend: { usageEvents: 1, fullyPricedUsageEvents: 1,
        partiallyPricedUsageEvents: 0, unpricedUsageEvents: 0 },
    });
    expect(payload.apiEquivalentSpend.knownCostUsd).toBeGreaterThan(0);
    expect(payload).not.toHaveProperty("allowance");
    expect(row.payload_json).not.toContain(OWNER_ID);
    expect(row.payload_json).not.toContain(DEVICE_ID);
    expect(row.payload_sha256).toMatch(/^[0-9a-f]{64}$/u);
    const publicRead = await readPostgresPublishedCommunityDaily(pool, {
      sourceId: SOURCE_ID,
      sourceNamespace: SOURCE_NAMESPACE,
      fromDay: DAY,
      throughDay: DAY,
      nowMs: NOW_MS,
      schema: { primarySchema: schema },
    });
    expect(publicRead.rows).toHaveLength(1);
    const projected = JSON.parse(publicRead.rows[0].payload_json);
    expect(projected.totals).toMatchObject({ usageEvents: 1, inputUncachedTokens: 100 });
    expect(projected.apiEquivalentSpend.fullyPricedUsageEvents).toBe(1);
    expect(projected).not.toHaveProperty("allowance");
    expect(await publish()).toEqual({ state: "unchanged", day: DAY, revision: 1 });

    await pool.query(`INSERT INTO ${sqlSchema}.storage_ingestion_changes(
      source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms)
      VALUES ($1,1,$2,$3,1,0,'source-updated',${NOW_MS})`,
    [SOURCE_ID, "d".repeat(64), "e".repeat(64)]);
    await pool.query(`UPDATE ${sqlSchema}.analytics_source_cursors SET sequence=1 WHERE source_id=$1`, [SOURCE_ID]);
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 2 });
    const revisions = await pool.query(`SELECT revision,release_state FROM ${sqlSchema}.community_daily_aggregates
      WHERE source_id=$1 AND day=$2::date ORDER BY revision`, [SOURCE_ID, DAY]);
    expect(revisions.rows).toEqual([
      { revision: "1", release_state: "published" },
      { revision: "2", release_state: "published" },
    ]);
    expect((await pool.query(`SELECT count(*) AS count FROM ${sqlSchema}.community_daily_allowance_preview_cache`))
      .rows[0].count).toBe("0");
    expect((await pool.query(`SELECT count(*) AS count FROM ${sqlSchema}.community_daily_allowance_publication_state`))
      .rows[0].count).toBe("0");
  });

  it.each([
    { events: 0, pages: 0, sha256: "a24f88d998fa610f0609e827e82375d970fc98a0ba9fe4907b588ae3fda83f8b" },
    { events: 1, pages: 2, sha256: "d85c2439373a479cf694a27f6149d03ad86e07eeb835af95c3c70322ea168778" },
    { events: 999, pages: 2, sha256: "fa0dbaa1678a2fa4c8bf218ccb223dd23bbc98d912dd9be10328aad8892cd7ac" },
    { events: 1_000, pages: 2, sha256: "a6a7f139f86b024ac44330f1fe6473b33d74bd21d2c784a3d65da6717906e871" },
    { events: 1_001, pages: 3, sha256: "ac32732a4b8892558097e7f4f829bdab1bdccd1ef00bb0257e8fbc7c0136de53" },
  ])("streams $events v1 records with exact pre-cursor publication output", async ({ events, pages, sha256 }) => {
    await addUsageEvents(events);
    const before = await sourceSnapshot();
    const expectedEligibility = {
      v1SelectedRecordsPresent: events > 0,
      v11SelectedRecordsPresent: false,
    };
    expect(await readPostgresCommunityDailyDaySourceEligibility(pool, {
      day: DAY, schema: { primarySchema: schema },
    })).toEqual(expectedEligibility);

    const observed = observedPool();
    expect(await publish({}, observed.pool)).toEqual({ state: "published", day: DAY, revision: 1 });
    const aggregate = await pool.query(`SELECT payload_json,payload_sha256 FROM ${sqlSchema}.community_daily_aggregates
      WHERE source_id=$1 AND day=$2::date AND revision=1`, [SOURCE_ID, DAY]);
    expect(aggregate.rows).toHaveLength(1);
    expect(aggregate.rows[0].payload_sha256).toBe(sha256);
    const payload = JSON.parse(aggregate.rows[0].payload_json);
    expect(payload.totals.usageEvents).toBe(events);
    expect(aggregate.rows[0].payload_json).not.toContain(OWNER_ID);
    expect(aggregate.rows[0].payload_json).not.toContain(DEVICE_ID);
    expect(await sourceSnapshot()).toEqual(before);
    expect(await readPostgresCommunityDailyDaySourceEligibility(pool, {
      day: DAY, schema: { primarySchema: schema },
    })).toEqual(expectedEligibility);
    expect(observed.stats).toMatchObject({ checkouts: 1, releases: 1, active: 0, maxActive: 1, fetches: pages });
  });

  it("preserves exact mixed v1.0/v1.1 publication output", async () => {
    await addUsageEvents(500);
    await addActiveV11UsageOwner(500);
    const before = await sourceSnapshot();
    const observed = observedPool();
    expect(await publish({}, observed.pool)).toEqual({ state: "published", day: DAY, revision: 1 });
    const aggregate = await pool.query(`SELECT payload_json,payload_sha256 FROM ${sqlSchema}.community_daily_aggregates
      WHERE source_id=$1 AND day=$2::date AND revision=1`, [SOURCE_ID, DAY]);
    expect(aggregate.rows).toHaveLength(1);
    expect(aggregate.rows[0].payload_sha256)
      .toBe("bd9e41356a03443b7e4addcefc32448c96a44bdbb8e865ae5b82d69c2f3fcdf2");
    const payload = JSON.parse(aggregate.rows[0].payload_json);
    expect(payload.totals).toMatchObject({ usageEvents: 1_000,
      contributingParticipants: 2, contributingDevices: 2 });
    expect(aggregate.rows[0].payload_json).not.toContain("synthetic-v11-social-owner");
    expect(aggregate.rows[0].payload_json).not.toContain("synthetic-v11-social-device");
    expect(await sourceSnapshot()).toEqual(before);
    expect(await readPostgresCommunityDailyDaySourceEligibility(pool, {
      day: DAY, schema: { primarySchema: schema },
    })).toEqual({ v1SelectedRecordsPresent: true, v11SelectedRecordsPresent: true });
    expect(observed.stats).toMatchObject({ checkouts: 1, releases: 1, active: 0, maxActive: 1, fetches: 2 });
  });

  it.each([
    {
      name: "missing fetched row",
      mutate: (result, call) => call === 1 ? { ...result, rows: [], rowCount: 0 } : result,
      operation: "community_daily.spend_rows",
    },
    {
      name: "extra fetched row",
      mutate: (result, call) => call === 1
        ? { ...result, rows: [...result.rows, ...result.rows], rowCount: result.rows.length * 2 }
        : result,
      operation: "community_daily.spend_event_count",
    },
  ])("rolls back and releases the cursor when the fetch stream has an $name", async ({ mutate, operation }) => {
    await addOneUsageEvent();
    const before = await sourceSnapshot();
    const observed = observedPool(mutate);
    await expect(publish({}, observed.pool)).rejects.toMatchObject({ code: "unavailable", operation });
    expect(observed.stats).toMatchObject({ checkouts: 1, releases: 1, active: 0,
      maxActive: 1, fetches: 1, rollbacks: 1, cursorCountAfterRollback: 0 });
    expect((await pool.query(`SELECT count(*)::int AS count FROM ${sqlSchema}.community_daily_aggregates
      WHERE source_id=$1 AND day=$2::date`, [SOURCE_ID, DAY])).rows[0].count).toBe(0);
    expect(await sourceSnapshot()).toEqual(before);
  });

  it("withdraws prior revisions, waits for the terminal cursor, then publishes a fresh owner-free revision", async () => {
    await addOneUsageEvent();
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 1 });
    await pool.query(`UPDATE ${sqlSchema}.participants SET state='deleting' WHERE id=$1`, [OWNER_ID]);
    await pool.query(`INSERT INTO ${sqlSchema}.storage_ingestion_changes(
      source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms)
      VALUES ($1,1,$2,$3,2,0,'owner-withdrawn',${NOW_MS})`,
    [SOURCE_ID, "f".repeat(64), "1".repeat(64)]);

    await expect(publish()).rejects.toMatchObject({ code: "unavailable", operation: "community_daily.source_not_current" });
    const revisions = await pool.query(`SELECT release_state,withdrawn_at FROM ${sqlSchema}.community_daily_aggregates
      WHERE source_id=$1 AND day=$2::date`, [SOURCE_ID, DAY]);
    expect(revisions.rows).toEqual([{ release_state: "withdrawn", withdrawn_at: expect.any(Date) }]);
    expect((await pool.query(`SELECT count(*) AS count FROM ${sqlSchema}.community_daily_aggregates
      WHERE source_id=$1 AND release_state='published'`, [SOURCE_ID])).rows[0].count).toBe("0");

    await pool.query(`UPDATE ${sqlSchema}.analytics_source_cursors SET sequence=1 WHERE source_id=$1`, [SOURCE_ID]);
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 2 });
    const successor = await pool.query(`SELECT payload_json FROM ${sqlSchema}.community_daily_aggregates
      WHERE source_id=$1 AND day=$2::date AND revision=2`, [SOURCE_ID, DAY]);
    expect(JSON.parse(successor.rows[0].payload_json).totals).toMatchObject({
      contributingParticipants: 0,
      contributingDevices: 0,
      usageEvents: 0,
      inputUncachedTokens: 0,
    });
    expect(JSON.parse(successor.rows[0].payload_json)).not.toHaveProperty("allowance");
  });
});
