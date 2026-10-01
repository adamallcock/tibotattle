import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { COMMUNITY_ALLOWANCE_BASIS, COMMUNITY_ALLOWANCE_QUALIFICATION,
  COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS } from "../src/community-allowance.ts";
import { COMMUNITY_ATTRIBUTION_METHOD_VERSION } from "../src/community-allowance.ts";
import { finalizeCommunityDailySpend } from "../src/community-daily-spend.ts";
import { readPostgresPublishedCommunityDaily } from "../src/postgres-community-daily.ts";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const SOURCE_ID = "synthetic-community-source";
const SOURCE_NAMESPACE = "synthetic-community-namespace";
const DAY = "2026-09-24";
const RELEASED_AT = "2026-09-24T12:00:00.000Z";
const NOW_MS = Date.parse("2026-09-25T12:00:00.000Z");
const OWNER_DIGEST = "f".repeat(64);

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

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function allowance() {
  return {
    basis: COMMUNITY_ALLOWANCE_BASIS,
    limitId: "codex",
    referencePlanType: "pro",
    normalization: "pro_x1_prolite_x4_plus_x20",
    windowDurationMinutes: 10_080,
    trailingDays: 30,
    qualification: COMMUNITY_ALLOWANCE_QUALIFICATION,
    spanFloorPp: 25,
    fitCount: 1,
    participantCount: 1,
    centralUsd: 12,
    band80Usd: null,
  };
}

function dailyPayload(revision, overrides = {}) {
  return {
    schemaVersion: "community-daily-aggregate-v1.0",
    aggregateId: `community-daily:${DAY}:r${revision}`,
    day: DAY,
    revision,
    releasedAt: RELEASED_AT,
    immutableRevision: true,
    recomputesOnLateData: true,
    policyVersion: "community-daily-v1.0",
    suppression: "none_daily_grain_by_owner_decision",
    allowance: allowance(),
    apiEquivalentSpend: finalizeCommunityDailySpend({
      usageEvents: 1, knownNanousd: 10_000n,
      fullyPricedUsageEvents: 1, partiallyPricedUsageEvents: 0, unpricedUsageEvents: 0,
    }),
    totals: {
      contributingParticipants: 1, contributingDevices: 1, usageEvents: 1,
      quotaObservations: 0, sessionDimensions: 0, inputUncachedTokens: 1,
      inputCacheReadTokens: 0, inputCacheWriteTokens: 0, outputTextTokens: 0,
      outputReasoningTokens: 0, outputCombinedTokens: 0,
    },
    cellsTruncated: false,
    cells: [{ provider: "openai", modelId: "gpt-6-sol", usageEvents: 1,
      inputUncachedTokens: 1, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
      outputTextTokens: 0, outputReasoningTokens: 0, outputCombinedTokens: 0 }],
    capacityByPlanType: { plus: { privateDiagnostic: "synthetic-private-canary" } },
    ...overrides,
  };
}

describe.skipIf(!PG_TEST_SOCKET)("PostgreSQL community daily publication read contract", () => {
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
      application_name: "pg-community-daily-test",
      ssl: false,
      max: 2,
      connectionTimeoutMillis: 5_000,
    });
    const locality = await pool.query("SELECT inet_server_addr() AS address, version() AS version");
    assert.equal(locality.rows[0]?.address, null, "qualification requires a local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^PostgreSQL 17\./u);
  }, 120_000);

  beforeEach(async () => {
    schema = `pcd_${randomBytes(6).toString("hex")}`;
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

  async function publish(revision, payload = dailyPayload(revision), releaseState = "published") {
    const json = JSON.stringify(payload);
    await pool.query(`INSERT INTO ${sqlSchema}.community_daily_aggregates(
      source_id,source_namespace,day,revision,payload_json,payload_sha256,
      source_authority_epoch,source_cursor_sequence,policy_revision,collection_revision,
      release_state,released_at,withdrawn_at)
      SELECT $1,$2,$3::date,$4,$5,$6,0,0,1,controls.revision,$7,$8::timestamptz,
        CASE WHEN $7='withdrawn' THEN clock_timestamp() ELSE NULL END
        FROM ${sqlSchema}.collection_controls controls WHERE singleton=1`,
    [SOURCE_ID, SOURCE_NAMESPACE, DAY, revision, json, digest(json), releaseState, RELEASED_AT]);
  }

  async function readWithPool(readPool, options = {}) {
    return readPostgresPublishedCommunityDaily(readPool, {
      sourceId: SOURCE_ID,
      sourceNamespace: SOURCE_NAMESPACE,
      fromDay: DAY,
      throughDay: DAY,
      nowMs: NOW_MS,
      schema: { primarySchema: schema },
      ...options,
    });
  }

  async function read(options = {}) { return readWithPool(pool, options); }

  it("reads latest authorized rows, verifies payload hashes, and strips private/unknown fields", async () => {
    const today = new Date(NOW_MS).toISOString().slice(0, 10);
    const safeFromDay = new Date(Date.parse(`${today}T00:00:00.000Z`)
      - (COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    await pool.query(`INSERT INTO ${sqlSchema}.community_daily_allowance_publication_state(
      source_id,source_namespace,publication_state,expected_basis,attribution_method_version,
      safe_from_day,safe_to_day,source_authority_epoch,source_cursor_sequence,policy_revision,
      collection_revision,hard_invalidation_sequence,updated_at)
      SELECT $1,$2,'ready',$3,$4,$5,$6,0,0,1,controls.revision,0,clock_timestamp()
      FROM ${sqlSchema}.collection_controls controls WHERE singleton=1`,
    [SOURCE_ID, SOURCE_NAMESPACE, COMMUNITY_ALLOWANCE_BASIS,
      COMMUNITY_ATTRIBUTION_METHOD_VERSION, safeFromDay, today]);
    await publish(1);

    const result = await read();
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.day, DAY);
    const payload = JSON.parse(result.rows[0].payload_json);
    expect(payload).toHaveProperty("apiEquivalentSpend.usageEvents", 1);
    expect(payload).toHaveProperty("allowance.basis", COMMUNITY_ALLOWANCE_BASIS);
    expect(payload).not.toHaveProperty("capacityByPlanType");
    expect(JSON.stringify(payload)).not.toContain("synthetic-private-canary");
    expect(payload).not.toHaveProperty("unknownPrivateField");
    expect(result.cacheRetention).toBeNull();

    await publish(2, dailyPayload(2, {
      allowance: { ...allowance(), qualification: "unreviewed-qualification" },
    }));
    const unreviewedQualification = JSON.parse((await read()).rows[0].payload_json);
    expect(unreviewedQualification).not.toHaveProperty("allowance");

    await publish(3, dailyPayload(3, { unknownPrivateField: "must-fail-closed" }));
    await expect(read()).rejects.toMatchObject({ code: "invalid", operation: "community_daily.payload" });
  });

  it("does not reveal an older revision after a newer revision is withdrawn", async () => {
    await publish(1);
    await publish(2, dailyPayload(2), "withdrawn");
    const result = await read();
    assert.deepEqual(result.rows, []);
  });

  it("fails closed when a terminal event commits during the snapshot read", async () => {
    await publish(1);
    let signalPaused;
    let resumeRead;
    const paused = new Promise((resolve) => { signalPaused = resolve; });
    const resume = new Promise((resolve) => { resumeRead = resolve; });
    let intercepted = false;
    const interleavedPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(text, values) {
            const result = await client.query(text, values);
            if (!intercepted && text === "RELEASE SAVEPOINT community_daily_optional_reads") {
              intercepted = true;
              signalPaused();
              await resume;
            }
            return result;
          },
          release: client.release.bind(client),
        };
      },
    };
    const pendingRead = readWithPool(interleavedPool);
    await paused;
    await pool.query(`INSERT INTO ${sqlSchema}.storage_ingestion_changes(
      source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms)
      VALUES ($1,1,$2,$3,1,1,'owner-erased',${NOW_MS})`,
    [SOURCE_ID, "c".repeat(64), OWNER_DIGEST]);
    resumeRead();

    await expect(pendingRead).rejects.toMatchObject({
      code: "unavailable", operation: "community_daily.authority",
    });
  });

  it("terminal withdrawal tombstones every revision and invalidates optional allowance cache", async () => {
    await publish(1);
    await publish(2);
    const preview = JSON.stringify({ schemaVersion: "synthetic" });
    await pool.query(`INSERT INTO ${sqlSchema}.community_daily_allowance_publication_state(
      source_id,source_namespace,publication_state,expected_basis,attribution_method_version,
      safe_from_day,safe_to_day,source_authority_epoch,source_cursor_sequence,policy_revision,
      collection_revision,hard_invalidation_sequence,updated_at)
      SELECT $1,$2,'ready',$3,$4,$5,$6,0,0,1,controls.revision,0,clock_timestamp()
      FROM ${sqlSchema}.collection_controls controls WHERE singleton=1`,
    [SOURCE_ID, SOURCE_NAMESPACE, COMMUNITY_ALLOWANCE_BASIS,
      COMMUNITY_ATTRIBUTION_METHOD_VERSION, DAY, DAY]);
    await pool.query(`INSERT INTO ${sqlSchema}.community_daily_allowance_preview_cache(
      source_id,source_namespace,generated_at,payload_json,payload_sha256,
      attribution_method_version,source_authority_epoch,source_cursor_sequence,
      policy_revision,collection_revision)
      SELECT $1,$2,clock_timestamp(),$3,$4,$5,0,0,1,controls.revision
      FROM ${sqlSchema}.collection_controls controls WHERE singleton=1`,
    [SOURCE_ID, SOURCE_NAMESPACE, preview, digest(preview), COMMUNITY_ATTRIBUTION_METHOD_VERSION]);

    await pool.query(`INSERT INTO ${sqlSchema}.storage_ingestion_changes(
      source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms)
      VALUES ($1,1,$2,$3,1,1,'owner-withdrawn',${NOW_MS})`,
    [SOURCE_ID, "a".repeat(64), OWNER_DIGEST]);

    const states = await pool.query(`SELECT release_state,count(*)::int AS count
      FROM ${sqlSchema}.community_daily_aggregates GROUP BY release_state`);
    assert.deepEqual(states.rows.map(({ release_state, count }) => [release_state, count]), [["withdrawn", 2]]);
    const allowanceState = await pool.query(`SELECT publication_state,hard_invalidation_sequence
      FROM ${sqlSchema}.community_daily_allowance_publication_state WHERE source_id=$1`, [SOURCE_ID]);
    assert.equal(allowanceState.rows[0]?.publication_state, "updating");
    assert.equal(Number(allowanceState.rows[0]?.hard_invalidation_sequence), 1);
    const cache = await pool.query(`SELECT count(*)::int AS count
      FROM ${sqlSchema}.community_daily_allowance_preview_cache`);
    assert.equal(cache.rows[0]?.count, 0);
    await expect(pool.query(`UPDATE ${sqlSchema}.community_daily_aggregates
      SET release_state='published', withdrawn_at=NULL
      WHERE source_id=$1 AND day=$2 AND revision=1`, [SOURCE_ID, DAY]))
      .rejects.toMatchObject({ code: "P1005" });
    assert.deepEqual((await read()).rows, []);
  });

  it("commits an owner-erased journal event without daily publication state", async () => {
    const dailyState = await pool.query(`SELECT count(*)::int AS count
      FROM ${sqlSchema}.community_daily_allowance_publication_state WHERE source_id=$1`, [SOURCE_ID]);
    assert.equal(dailyState.rows[0]?.count, 0);

    await pool.query(`INSERT INTO ${sqlSchema}.storage_ingestion_changes(
      source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms)
      VALUES ($1,1,$2,$3,1,1,'owner-erased',${NOW_MS})`,
    [SOURCE_ID, "b".repeat(64), OWNER_DIGEST]);

    const event = await pool.query(`SELECT kind FROM ${sqlSchema}.storage_ingestion_changes
      WHERE source_id=$1 AND sequence=1`, [SOURCE_ID]);
    assert.equal(event.rows[0]?.kind, "owner-erased");
    assert.deepEqual((await read()).rows, []);
  });

  it("rejects payload mutation and oversized date ranges", async () => {
    await publish(1);
    await expect(pool.query(`UPDATE ${sqlSchema}.community_daily_aggregates
      SET payload_json='{}' WHERE source_id=$1`, [SOURCE_ID]))
      .rejects.toMatchObject({ code: "P1005" });
    await expect(read({ fromDay: "2025-09-23", throughDay: DAY }))
      .rejects.toMatchObject({ code: "invalid", operation: "community_daily.range" });
  });
});
