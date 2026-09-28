import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { applyStockAndStagedMigrations } from "./staged-migrations-harness.mjs";
import { deviceHash } from "../src/device-auth.ts";
import { encodeBase64Url } from "../src/crypto.ts";
import { disconnectPostgresAuthenticatedDevice } from "../src/postgres-device-disconnect.ts";
import {
  publishPostgresCommunityDailyDay,
  pricePostgresTypedV12DailyUsageRecord,
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
    await applyStockAndStagedMigrations({
      role: "primary", schema, pool,
      stagedFiles: [
        "0093_community_daily_v12_authority_pin.sql",
        "0095_community_daily_v12_authority_generation.sql",
      ],
    });
    await pool.query(`INSERT INTO ${sqlSchema}.typed_telemetry_namespaces(id,original_id)
      VALUES (1,decode('0102','hex'))`);
    await pool.query(`INSERT INTO ${sqlSchema}.typed_v1_admission_state(
      id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      VALUES (1,$1,1,1,1)`, [SOURCE_NAMESPACE]);
    await pool.query(`INSERT INTO ${sqlSchema}.typed_v11_admission_state(
      id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      VALUES (1,$1,1,1,1)`, [SOURCE_NAMESPACE]);
    await pool.query(`INSERT INTO ${sqlSchema}.storage_source_state(singleton,source_id,authority_epoch)
      VALUES (1,$1,0)`, [SOURCE_ID]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_source_cursors(source_id,sequence,authority_epoch)
      VALUES ($1,0,0)`, [SOURCE_ID]);
    await pool.query(`UPDATE ${sqlSchema}.publication_state SET publication_state='ready',policy_revision=1
      WHERE singleton=1`);
    await pool.query(`UPDATE ${sqlSchema}.collection_controls SET revision=revision+1,
      control_state='operational', publication_enabled=true, reason_code=NULL,
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

  async function addAccountlessRetainedV11Day({
    mismatchedLedgerHash = false,
    includeHistoricalDailyRevision = true,
  } = {}) {
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
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domain_heads(
      participant_id,generation_id,revision,updated_at)
      VALUES ($1,$2,1,$3::timestamptz)`, [participantId, generationId, now]);
    await pool.query(`INSERT INTO ${sqlSchema}.storage_v11_owner_links(
      participant_id,owner_digest,state,generation_id,head_revision)
      VALUES ($1,$2,'active',$3,1)`, [participantId, ownerDigest, generationId]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_owner_state(
      source_id,owner_digest,revision,authority_epoch,state)
      VALUES ($1,$2,1,0,'active')`, [SOURCE_ID, ownerDigest]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_publication_owner_members(
      source_id,day,metric,generation,owner_digest)
      VALUES ($1,$2::date,'daily','synthetic-daily-generation',$3)`, [SOURCE_ID, DAY, ownerDigest]);
    if (includeHistoricalDailyRevision) {
      const payloadJson = JSON.stringify({ schemaVersion: "community-daily-aggregate-v1.0", day: DAY });
      const payloadDigest = createHash("sha256").update(payloadJson).digest("hex");
      await pool.query(`INSERT INTO ${sqlSchema}.community_daily_aggregates(
        source_id,source_namespace,day,revision,payload_json,payload_sha256,
        source_authority_epoch,source_cursor_sequence,policy_revision,
        collection_revision,release_state,released_at)
        VALUES ($1,$2,$3::date,1,$4,$5,0,0,1,1,'published',$6::timestamptz)`,
      [SOURCE_ID, SOURCE_NAMESPACE, DAY, payloadJson, payloadDigest, now]);
    }

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

  async function publish(options = {}, publicationPool = pool) {
    return publishPostgresCommunityDailyDay(publicationPool, {
      sourceId: SOURCE_ID,
      sourceNamespace: SOURCE_NAMESPACE,
      day: DAY,
      nowMs: NOW_MS,
      schema: { primarySchema: schema },
      ...options,
    });
  }

  async function readAuthorityShards() {
    return (await pool.query(`SELECT shard_id, revision
      FROM ${sqlSchema}.community_daily_v12_authority_state ORDER BY shard_id`)).rows;
  }

  function pausePublisherAfterQuery(match) {
    let reached;
    let resume;
    const reachedPromise = new Promise((resolve) => { reached = resolve; });
    const resumed = new Promise((resolve) => { resume = resolve; });
    let paused = false;
    return {
      reached: reachedPromise,
      resume() { resume(); },
      pool: {
        async connect() {
          const client = await pool.connect();
          return {
            async query(text, values) {
              const result = await client.query(text, values);
              if (!paused && match(String(text))) {
                paused = true;
                reached();
                await resumed;
              }
              return result;
            },
            release(discard) { return client.release(discard); },
          };
        },
      },
    };
  }

  async function addIsolatedSocialParticipant(id) {
    await pool.query(`INSERT INTO ${sqlSchema}.participants(id,owner_kind,state,created_at)
      VALUES ($1,'social','active',clock_timestamp())`, [id]);
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

    await pool.query(`UPDATE ${sqlSchema}.telemetry_v11_domain_heads
      SET revision=revision+1 WHERE participant_id=$1`, [fixture.participantId]);
    expect(await readEligibility()).toEqual({
      v1SelectedRecordsPresent: false,
      v11SelectedRecordsPresent: false,
    });
    await pool.query(`UPDATE ${sqlSchema}.telemetry_v11_domain_heads
      SET revision=revision-1 WHERE participant_id=$1`, [fixture.participantId]);

    await pool.query(`UPDATE ${sqlSchema}.accountless_enrollment_ledger
      SET device_secret_hash=$2 WHERE device_id=$1`,
    [fixture.deviceId, Buffer.alloc(32, 0x5e)]);
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

  it("pins v1.2 runtime and accountless expiry inputs into immutable daily revisions", async () => {
    const fixture = await addAccountlessRetainedV11Day();
    expect((await pool.query(`SELECT public_source_generation
      FROM ${sqlSchema}.community_daily_aggregates
      WHERE source_id=$1 AND day=$2::date ORDER BY revision DESC LIMIT 1`,
    [SOURCE_ID, DAY])).rows[0].public_source_generation).toBe(null);
    const first = await publish();
    expect(first).toEqual({ state: "published", day: DAY, revision: 2 });

    const readPin = async () => (await pool.query(`SELECT
      public_source_generation,
      telemetry_v12_runtime_state,telemetry_v12_runtime_revision,
      telemetry_v12_typed_runtime_state,telemetry_v12_typed_runtime_policy_revision,
      telemetry_v12_accountless_authorization_count,
      telemetry_v12_next_accountless_authorization_expiry
      FROM ${sqlSchema}.community_daily_aggregates
      WHERE source_id=$1 AND day=$2::date ORDER BY revision DESC LIMIT 1`, [SOURCE_ID, DAY])).rows[0];
    const initialPin = await readPin();
    expect(initialPin).toMatchObject({
      telemetry_v12_runtime_state: "staged",
      telemetry_v12_runtime_revision: "0",
      telemetry_v12_typed_runtime_state: "staged",
      telemetry_v12_typed_runtime_policy_revision: "1",
      telemetry_v12_accountless_authorization_count: "0",
      telemetry_v12_next_accountless_authorization_expiry: null,
    });
    expect(Number(initialPin.public_source_generation)).toBeGreaterThan(0);
    expect(await publish()).toEqual({ state: "unchanged", day: DAY, revision: 2 });

    await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_runtime
      SET state='blocked',revision=revision+1 WHERE id=1`);
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 3 });

    const expiry = "2027-09-23T00:00:00.000Z";
    await pool.query(`INSERT INTO ${sqlSchema}.accountless_v12_device_authorizations(
      enrollment_device_id,participant_id,device_credential_id,
      telemetry_schema_version,field_dictionary_version,privacy_contract_version,
      authorized_at,expires_at,state)
      VALUES ($1,$2,$1,'telemetry-contribution-v1.2',
        'telemetry-v1.2-registry-2026-09-20.1','ongoing-privacy-safe-telemetry-v1.2',
        $3::timestamptz,$4::timestamptz,'active')`,
    [fixture.deviceId, fixture.participantId, "2026-09-24T00:00:00.000Z", expiry]);
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 4 });
    expect(await readPin()).toMatchObject({
      telemetry_v12_runtime_state: "blocked",
      telemetry_v12_runtime_revision: "1",
      telemetry_v12_accountless_authorization_count: "1",
      telemetry_v12_next_accountless_authorization_expiry: new Date(expiry),
    });

    // Moving the earliest unexpired boundary must invalidate `unchanged` even
    // when the stored source cursor and authorization count are constant.
    const earlierExpiry = "2027-09-22T00:00:00.000Z";
    await pool.query(`UPDATE ${sqlSchema}.accountless_v12_device_authorizations
      SET expires_at=$2::timestamptz WHERE enrollment_device_id=$1`,
    [fixture.deviceId, earlierExpiry]);
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 5 });
    expect(await readPin()).toMatchObject({
      telemetry_v12_accountless_authorization_count: "1",
      telemetry_v12_next_accountless_authorization_expiry: new Date(earlierExpiry),
    });
    expect((await pool.query(`SELECT sequence FROM ${sqlSchema}.analytics_source_cursors
      WHERE source_id=$1`, [SOURCE_ID])).rows).toEqual([{ sequence: "0" }]);
  });

  it("requires strict runtime revisions and fences same-value authority updates", async () => {
    await addAccountlessRetainedV11Day();
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 2 });
    const readAuthority = async () => (await pool.query(`SELECT
        (SELECT sum(authority.revision)::text FROM ${sqlSchema}.community_daily_v12_authority_state authority)
          AS public_source_generation,
        runtime.state AS runtime_state,runtime.revision AS runtime_revision,
        typed_runtime.state AS typed_runtime_state,
        typed_runtime.policy_revision AS typed_runtime_policy_revision
      FROM ${sqlSchema}.telemetry_v12_runtime runtime
      JOIN ${sqlSchema}.telemetry_v12_typed_runtime typed_runtime ON typed_runtime.id=1
      WHERE runtime.id=1`)).rows[0];
    const before = await readAuthority();

    await expect(pool.query(`UPDATE ${sqlSchema}.telemetry_v12_runtime
      SET state='active' WHERE id=1`)).rejects.toMatchObject({
      code: "P1005",
      message: expect.stringContaining("community_daily_v12_runtime_revision_required"),
    });
    await expect(pool.query(`UPDATE ${sqlSchema}.telemetry_v12_typed_runtime
      SET state='active' WHERE id=1`)).rejects.toMatchObject({
      code: "P1005",
      message: expect.stringContaining("community_daily_v12_typed_runtime_revision_required"),
    });
    expect(await readAuthority()).toEqual(before);

    await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_runtime
      SET state='active',revision=revision+1 WHERE id=1`);
    await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_typed_runtime
      SET state='active',policy_revision=policy_revision+1 WHERE id=1`);
    const advanced = await readAuthority();
    expect(advanced).toMatchObject({
      runtime_state: "active",
      runtime_revision: before.runtime_revision + 1,
      typed_runtime_state: "active",
      typed_runtime_policy_revision: before.typed_runtime_policy_revision + 1,
    });
    expect(BigInt(advanced.public_source_generation)).toBeGreaterThan(BigInt(before.public_source_generation));
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 3 });

    const published = await readAuthority();
    await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_runtime SET revision=revision WHERE id=1`);
    await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_typed_runtime
      SET policy_revision=policy_revision WHERE id=1`);
    const sameValues = await readAuthority();
    expect(sameValues).toMatchObject({
      runtime_state: published.runtime_state,
      runtime_revision: published.runtime_revision,
      typed_runtime_state: published.typed_runtime_state,
      typed_runtime_policy_revision: published.typed_runtime_policy_revision,
    });
    expect(BigInt(sameValues.public_source_generation)).toBeGreaterThan(BigInt(published.public_source_generation));
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 4 });
    expect(await publish()).toEqual({ state: "unchanged", day: DAY, revision: 4 });
  });

  it("fails closed when the staged public generation schema is absent", async () => {
    await pool.query(`ALTER TABLE ${sqlSchema}.community_daily_v12_authority_state
      RENAME TO community_daily_v12_authority_state_missing`);
    try {
      await expect(publish()).rejects.toMatchObject({
        code: "unavailable",
        operation: "community_daily.publish",
      });
      expect((await pool.query(`SELECT count(*)::int AS count
        FROM ${sqlSchema}.community_daily_aggregates WHERE source_id=$1 AND day=$2::date`,
      [SOURCE_ID, DAY])).rows[0].count).toBe(0);
    } finally {
      await pool.query(`ALTER TABLE ${sqlSchema}.community_daily_v12_authority_state_missing
        RENAME TO community_daily_v12_authority_state`);
    }
  });

  it("installs generation triggers on all mutable daily-source and eligibility inputs", async () => {
    const expected = [
      "accountless_enrollment_ledger", "accountless_public_history_retention",
      "accountless_upload_owners", "accountless_v11_device_authorizations",
      "accountless_v12_device_authorizations", "analytics_source_cursors",
      "collection_controls", "device_credentials", "participants", "publication_state",
      "storage_ingestion_changes", "storage_source_state", "storage_v11_owner_links",
      "telemetry_v1_chunks", "telemetry_v1_records", "telemetry_v11_chunks",
      "telemetry_v11_domain_days", "telemetry_v11_domain_heads", "telemetry_v11_domains",
      "telemetry_v11_records", "telemetry_v12_chunks", "telemetry_v12_day_manifests",
      "telemetry_v12_device_capabilities", "telemetry_v12_domain_days",
      "telemetry_v12_domain_heads", "telemetry_v12_domains", "telemetry_v12_runtime",
      "telemetry_v12_typed_attributions", "telemetry_v12_typed_quota",
      "telemetry_v12_typed_records", "telemetry_v12_typed_runtime",
      "telemetry_v12_typed_session_tools", "telemetry_v12_typed_usage",
      "typed_telemetry_dictionary", "typed_v1_admission_state", "typed_v11_admission_state",
    ].sort();
    const result = await pool.query(`SELECT relation.relname AS relation_name, trigger_row.tgname AS trigger_name
      FROM pg_trigger trigger_row
      JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname=$1 AND (
          trigger_row.tgname LIKE 'a_community_daily_authority_%'
          OR trigger_row.tgname LIKE 'b_community_daily_authority_no_truncate_%'
        )
        AND NOT trigger_row.tgisinternal
      ORDER BY trigger_row.tgname`, [schema]);
    expect(result.rows.filter((row) => row.trigger_name.startsWith("a_"))
      .map((row) => row.relation_name).sort()).toEqual(expected);
    expect(result.rows.filter((row) => row.trigger_name.startsWith("b_"))
      .map((row) => row.relation_name).sort()).toEqual(expected);
    const shards = await readAuthorityShards();
    expect(shards).toHaveLength(128);
    expect(shards.map((row) => Number(row.shard_id))).toEqual(Array.from({ length: 128 }, (_, index) => index));

    const beforeStatementDml = await pool.query(`SELECT relation.relname AS relation_name,
        trigger_row.tgname AS trigger_name
      FROM pg_trigger trigger_row
      JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname=$1 AND NOT trigger_row.tgisinternal
        AND (trigger_row.tgtype & 2)=2 AND (trigger_row.tgtype & 1)=0
        AND (trigger_row.tgtype & 28)<>0
      ORDER BY relation.relname, trigger_row.tgname`, [schema]);
    for (const relationName of expected) {
      const firstDmlTrigger = beforeStatementDml.rows.find((row) => row.relation_name === relationName);
      expect(firstDmlTrigger?.trigger_name).toMatch(/^a_community_daily_authority_/u);
    }
  });

  it("keeps the authority shard inventory closed", async () => {
    await expect(pool.query(`INSERT INTO ${sqlSchema}.community_daily_v12_authority_state(shard_id,revision)
      VALUES (128,1)`)).rejects.toMatchObject({
      code: "P1005",
      message: expect.stringContaining("community_daily_v12_authority_state_retained"),
    });
    await expect(pool.query(`DELETE FROM ${sqlSchema}.community_daily_v12_authority_state
      WHERE shard_id=0`)).rejects.toMatchObject({
      code: "P1005",
      message: expect.stringContaining("community_daily_v12_authority_state_retained"),
    });
    expect(await readAuthorityShards()).toHaveLength(128);
  });

  it("routes a multi-statement upload transaction to one authority shard", async () => {
    const before = await readAuthorityShards();
    await pool.query("BEGIN");
    try {
      // Exercises a superset of covered v1.2 upload relations. A real chunk
      // writes one stream child (usage, quota, or session); only a completing
      // chunk changes the manifest to ready. Empty predicates avoid creating
      // source records while proving that all statements in one transaction
      // select the same shard.
      await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_chunks
        SET chunk_digest=chunk_digest WHERE false`);
      await pool.query(`UPDATE ${sqlSchema}.typed_telemetry_dictionary
        SET value=value WHERE false`);
      await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_typed_attributions
        SET plan_type_id=plan_type_id WHERE false`);
      await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_typed_records
        SET provider_id=provider_id WHERE false`);
      await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_typed_usage
        SET boundary_flags=boundary_flags WHERE false`);
      await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_typed_quota
        SET used_percent=used_percent WHERE false`);
      await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_typed_session_tools
        SET count=count WHERE false`);
      await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_day_manifests
        SET state=state WHERE false`);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK").catch(() => {});
      throw error;
    }
    const after = await readAuthorityShards();
    const changed = after.map((row, index) => ({
      shardId: Number(row.shard_id),
      delta: BigInt(row.revision) - BigInt(before[index].revision),
    })).filter((row) => row.delta !== 0n);
    expect(changed).toHaveLength(1);
    expect(changed[0].delta).toBe(8n);
    expect(after.reduce((sum, row, index) => sum + BigInt(row.revision) - BigInt(before[index].revision), 0n))
      .toBe(8n);
  });

  it("does not advance public-source generations for its own immutable aggregate insert", async () => {
    const before = await readAuthorityShards();
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 1 });
    expect(await readAuthorityShards()).toEqual(before);
  });

  it("refuses TRUNCATE after the in-flight publisher releases its source relation locks", async () => {
    const gate = pausePublisherAfterQuery((sql) => sql.includes("community_daily_v12_authority_state")
      && sql.includes("FOR SHARE"));
    const publication = publish({}, gate.pool);
    const writer = await pool.connect();
    let transaction = false;
    let truncatePromise;
    try {
      await gate.reached;
      await writer.query("BEGIN");
      transaction = true;
      truncatePromise = writer.query(`TRUNCATE ${sqlSchema}.telemetry_v12_runtime`);
      const truncateState = await Promise.race([
        truncatePromise.then(() => "completed", () => "failed"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 100)),
      ]);
      expect(truncateState).toBe("waiting");
      gate.resume();
      expect(await publication).toEqual({ state: "published", day: DAY, revision: 1 });
      await expect(truncatePromise).rejects.toMatchObject({
        code: "P1005",
        message: expect.stringContaining("community_daily_public_source_truncate_refused"),
      });
      await writer.query("ROLLBACK");
      transaction = false;
    } finally {
      gate.resume();
      if (transaction) await writer.query("ROLLBACK").catch(() => {});
      if (truncatePromise) await truncatePromise.catch(() => {});
      writer.release();
      await publication.catch(() => {});
    }
    expect((await pool.query(`SELECT count(*)::int AS count
      FROM ${sqlSchema}.telemetry_v12_runtime WHERE id=1`)).rows[0].count).toBe(1);
  });

  it("fails closed when an active v1.2 lease enters the commit safety window", async () => {
    const fixture = await addAccountlessRetainedV11Day({ includeHistoricalDailyRevision: false });
    await pool.query(`INSERT INTO ${sqlSchema}.accountless_v12_device_authorizations(
      enrollment_device_id,participant_id,device_credential_id,
      telemetry_schema_version,field_dictionary_version,privacy_contract_version,
      authorized_at,expires_at,state)
      VALUES ($1,$2,$1,'telemetry-contribution-v1.2',
        'telemetry-v1.2-registry-2026-09-20.1','ongoing-privacy-safe-telemetry-v1.2',
        clock_timestamp(),clock_timestamp()+interval '30 seconds','active')`,
    [fixture.deviceId, fixture.participantId]);
    expect((await pool.query(`SELECT bool_or(expires_at > transaction_timestamp()
      AND expires_at <= transaction_timestamp()+interval '45 seconds') AS near
      FROM ${sqlSchema}.accountless_v12_device_authorizations WHERE enrollment_device_id=$1`,
    [fixture.deviceId])).rows[0].near).toBe(true);

    await expect(publish()).rejects.toMatchObject({
      code: "unavailable",
      operation: "community_daily.authority_fence",
    });
    expect((await pool.query(`SELECT count(*)::int AS count
      FROM ${sqlSchema}.community_daily_aggregates WHERE source_id=$1 AND day=$2::date`,
    [SOURCE_ID, DAY])).rows[0].count).toBe(0);

    await pool.query(`UPDATE ${sqlSchema}.accountless_v12_device_authorizations
      SET expires_at=clock_timestamp()+interval '10 minutes' WHERE enrollment_device_id=$1`,
    [fixture.deviceId]);
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 1 });
    expect(await publish()).toEqual({ state: "unchanged", day: DAY, revision: 1 });
  });

  it("serializes a runtime commit that lands after the repeatable-read snapshot", async () => {
    const gate = pausePublisherAfterQuery((sql) => sql.startsWith("SELECT pg_advisory_xact_lock"));
    const publication = publish({}, gate.pool);
    await gate.reached;

    await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_runtime
      SET state='blocked',revision=revision+1 WHERE id=1`);
    gate.resume();

    await expect(publication).rejects.toMatchObject({ code: "conflict", operation: "community_daily.publish" });
    expect((await pool.query(`SELECT count(*)::int AS count
      FROM ${sqlSchema}.community_daily_aggregates WHERE source_id=$1 AND day=$2::date`,
    [SOURCE_ID, DAY])).rows[0].count).toBe(0);
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 1 });
  });

  it("fails promptly when an uncommitted source writer holds a shard at final validation", async () => {
    const gate = pausePublisherAfterQuery((sql) => sql.startsWith("SELECT pg_advisory_xact_lock"));
    const publication = publish({}, gate.pool);
    const writer = await pool.connect();
    let writerTransaction = false;
    try {
      await gate.reached; // the RR snapshot is established before the source transaction starts
      await writer.query("BEGIN");
      writerTransaction = true;
      await writer.query(`UPDATE ${sqlSchema}.telemetry_v12_runtime
        SET revision=revision WHERE id=1`);
      const startedAt = Date.now();
      gate.resume();
      await expect(publication).rejects.toMatchObject({
        code: "timeout",
        operation: "community_daily.publish",
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await writer.query("ROLLBACK");
      writerTransaction = false;
    } finally {
      gate.resume();
      if (writerTransaction) await writer.query("ROLLBACK").catch(() => {});
      writer.release();
      await publication.catch(() => {});
    }
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 1 });
  });

  it("serializes a v1.2 accountless authorization update after the snapshot", async () => {
    const fixture = await addAccountlessRetainedV11Day({ includeHistoricalDailyRevision: false });
    await pool.query(`INSERT INTO ${sqlSchema}.accountless_v12_device_authorizations(
      enrollment_device_id,participant_id,device_credential_id,
      telemetry_schema_version,field_dictionary_version,privacy_contract_version,
      authorized_at,expires_at,state)
      VALUES ($1,$2,$1,'telemetry-contribution-v1.2',
        'telemetry-v1.2-registry-2026-09-20.1','ongoing-privacy-safe-telemetry-v1.2',
        $3::timestamptz,$4::timestamptz,'active')`,
    [fixture.deviceId, fixture.participantId, "2026-09-24T00:00:00.000Z", "2027-09-24T00:00:00.000Z"]);

    const gate = pausePublisherAfterQuery((sql) => sql.startsWith("SELECT pg_advisory_xact_lock"));
    const publication = publish({}, gate.pool);
    await gate.reached;
    await pool.query(`UPDATE ${sqlSchema}.accountless_v12_device_authorizations
      SET expires_at='2028-09-24T00:00:00.000Z'::timestamptz WHERE enrollment_device_id=$1`,
    [fixture.deviceId]);
    gate.resume();

    await expect(publication).rejects.toMatchObject({ code: "conflict", operation: "community_daily.publish" });
    expect((await pool.query(`SELECT count(*)::int AS count
      FROM ${sqlSchema}.community_daily_aggregates WHERE source_id=$1 AND day=$2::date`,
    [SOURCE_ID, DAY])).rows[0].count).toBe(0);
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 1 });
  });

  it("holds the public generation through publication before owner erasure can proceed", async () => {
    const participantId = "synthetic-authority-race-owner";
    await addIsolatedSocialParticipant(participantId);
    const gate = pausePublisherAfterQuery((sql) => sql.includes("community_daily_v12_authority_state")
      && sql.includes("FOR SHARE NOWAIT"));
    const publication = publish({}, gate.pool);
    const writer = await pool.connect();
    let writerTransaction = false;
    let updatePromise;
    try {
      await gate.reached;
      await writer.query("BEGIN");
      writerTransaction = true;
      updatePromise = writer.query(`UPDATE ${sqlSchema}.participants SET state='deleting' WHERE id=$1`,
        [participantId]);
      const updateState = await Promise.race([
        updatePromise.then(() => "completed", () => "failed"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 100)),
      ]);
      expect(updateState).toBe("waiting");

      gate.resume();
      expect(await publication).toEqual({ state: "published", day: DAY, revision: 1 });
      await updatePromise;
      await writer.query("COMMIT");
      writerTransaction = false;
    } finally {
      gate.resume();
      if (writerTransaction) await writer.query("ROLLBACK").catch(() => {});
      if (updatePromise) await updatePromise.catch(() => {});
      writer.release();
      await publication.catch(() => {});
    }

    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 2 });
    expect(await publish()).toEqual({ state: "unchanged", day: DAY, revision: 2 });
  });

  it("takes source shards after the aggregate insert and holds them only through commit", async () => {
    const before = await readAuthorityShards();
    const gate = pausePublisherAfterQuery((sql) => sql.includes("community_daily_v12_authority_state")
      && sql.includes("FOR SHARE NOWAIT"));
    const publication = publish({}, gate.pool);
    const writer = await pool.connect();
    let writerTransaction = false;
    let updatePromise;
    try {
      await gate.reached;
      // The aggregate row is inserted but remains invisible until commit.
      expect((await writer.query(`SELECT count(*)::int AS count
        FROM ${sqlSchema}.community_daily_aggregates WHERE source_id=$1 AND day=$2::date`,
      [SOURCE_ID, DAY])).rows[0].count).toBe(0);
      await writer.query("BEGIN");
      writerTransaction = true;
      updatePromise = writer.query(`UPDATE ${sqlSchema}.telemetry_v12_runtime
        SET revision=revision WHERE id=1`);
      const updateState = await Promise.race([
        updatePromise.then(() => "completed", () => "failed"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 100)),
      ]);
      expect(updateState).toBe("waiting");

      gate.resume();
      expect(await publication).toEqual({ state: "published", day: DAY, revision: 1 });
      await updatePromise;
      await writer.query("COMMIT");
      writerTransaction = false;
    } finally {
      gate.resume();
      if (writerTransaction) await writer.query("ROLLBACK").catch(() => {});
      if (updatePromise) await updatePromise.catch(() => {});
      writer.release();
      await publication.catch(() => {});
    }
    const after = await readAuthorityShards();
    expect(after.reduce((sum, row) => sum + BigInt(row.revision), 0n))
      .toBeGreaterThan(before.reduce((sum, row) => sum + BigInt(row.revision), 0n));
    expect(await publish()).toEqual({ state: "published", day: DAY, revision: 2 });
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

function typedAnthropicV12Usage(overrides = {}) {
  return {
    schemaVersion: "usage-event-v1.2",
    eventId: `event:v2:${"a".repeat(64)}`,
    eventTime: "2026-08-01T13:47:00.000Z",
    sessionUuid: `session:v2:${"b".repeat(64)}`,
    provider: "anthropic_claude_code",
    modelId: "claude-sonnet-4-6",
    speedMode: "standard",
    apiServiceTier: "standard",
    surface: "local_interactive_unclassified",
    billingSurface: "claude_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 1000,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 30,
      outputTextTokens: null,
      outputReasoningTokens: null,
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
    cacheWriteTtl: { fiveMinuteTokens: 10, oneHourTokens: 20 },
    ...overrides,
  };
}

describe("PostgreSQL community daily typed v1.2 pricing adapter", () => {
  it("uses the explicit stored Anthropic TTL split without JSON conversion", () => {
    expect(pricePostgresTypedV12DailyUsageRecord(typedAnthropicV12Usage())).toMatchObject({
      costNanousd: 1_852_500,
      pricingStatus: "fully_priced",
      modelId: "claude-sonnet-4-6",
      unpricedReasonCodes: [],
    });
  });

  it("does not infer a TTL split when positive aggregate cache writes lack the buckets", () => {
    const priced = pricePostgresTypedV12DailyUsageRecord(typedAnthropicV12Usage({
      cacheWriteTtl: null,
    }));
    expect(priced).toMatchObject({ costNanousd: 1_695_000, pricingStatus: "partially_priced" });
    expect(priced?.unpricedReasonCodes).toContain("anthropic_cache_write_ttl_split_missing");
  });

  it("rejects mismatched or TTL-only cache-write evidence before pricing/drop", () => {
    expect(() => pricePostgresTypedV12DailyUsageRecord(typedAnthropicV12Usage({
      cacheWriteTtl: { fiveMinuteTokens: 10, oneHourTokens: 19 },
    }))).toThrow();
    expect(() => pricePostgresTypedV12DailyUsageRecord(typedAnthropicV12Usage({
      components: {
        inputUncachedTokens: null,
        inputCacheReadTokens: null,
        inputCacheWriteTokens: null,
        outputTextTokens: null,
        outputReasoningTokens: null,
        outputCombinedTokens: null,
      },
      cacheWriteTtl: { fiveMinuteTokens: 10, oneHourTokens: 20 },
    }))).toThrow();
  });

  it.each([
    ["provider", "synthetic_provider"],
    ["modelId", "gpt-5.6-sol"],
    ["billingSurface", "synthetic_billing"],
    ["speedMode", "synthetic_speed"],
    ["apiServiceTier", "synthetic_tier"],
    ["reasoningEffort", "synthetic_effort"],
  ])("rejects unreviewed v1.2 pricing dictionary field %s", (field, value) => {
    expect(() => pricePostgresTypedV12DailyUsageRecord(typedAnthropicV12Usage({ [field]: value })))
      .toThrow();
  });

  it("drops a typed usage record with no token observations", () => {
    expect(pricePostgresTypedV12DailyUsageRecord(typedAnthropicV12Usage({
      totalInputContextTokens: 1000,
      components: {
        inputUncachedTokens: null,
        inputCacheReadTokens: null,
        inputCacheWriteTokens: null,
        outputTextTokens: null,
        outputReasoningTokens: null,
        outputCombinedTokens: null,
      },
      cacheWriteTtl: null,
    }))).toBeNull();
  });
});
