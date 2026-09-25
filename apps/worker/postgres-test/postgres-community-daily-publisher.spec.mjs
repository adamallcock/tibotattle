import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
  publishPostgresCommunityDailyDay,
  readPostgresCommunityDailyDaySourceEligibility,
} from "../src/postgres-community-daily-publisher.ts";
import { readPostgresPublishedCommunityDaily } from "../src/postgres-community-daily.ts";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
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

describe.skipIf(!PG_TEST_SOCKET)("PostgreSQL explicit-day community daily producer", () => {
  let pool;
  let schema;
  let sqlSchema;

  beforeAll(async () => {
    const socket = await localSocket();
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
    assert.equal(locality.rows[0]?.address, null, "qualification requires a local Unix socket");
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

  async function addOneUsageEvent() {
    const now = "2026-09-24T12:00:00.000Z";
    const expires = "2027-09-24T12:00:00.000Z";
    const secretHash = Buffer.alloc(32, 7);
    const pairingId = "synthetic-social-pairing";
    const sessionId = "synthetic-social-session";
    const authorizationId = "synthetic-social-upload-authorization";
    const chunkId = "synthetic-social-usage-chunk";
    const objectKey = `synthetic/${chunkId}`;
    const record = usageRecord();
    const envelopeDigest = "b".repeat(64);

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
      VALUES ($1,$2,$3,'usage',$4::date,0,1,$5,$6,'synthetic-publisher-v1',
        1,1,$7,$8,$9::timestamptz)`,
    [chunkId, OWNER_ID, DEVICE_ID, DAY, "c".repeat(64), envelopeDigest, objectKey, authorizationId, now]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v1_records(
      chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,observed_day,
      provider,model_id,input_uncached_tokens,input_cache_read_tokens,input_cache_write_tokens,
      output_text_tokens,output_reasoning_tokens,output_combined_tokens,record_json)
      VALUES ($1,$2,$3,'usage',$4,$5::timestamptz,$6::date,$7,$8,100,900,0,50,25,NULL,$9::jsonb)`,
    [chunkId, OWNER_ID, DEVICE_ID, record.eventId, record.eventTime, DAY,
      record.provider, record.modelId, JSON.stringify(record)]);
  }

  async function publish(options = {}) {
    return publishPostgresCommunityDailyDay(pool, {
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
