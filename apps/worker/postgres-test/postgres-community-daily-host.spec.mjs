import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { createPostgresTestCommunityDailyDispatch } from "../cloud-run/postgres-test-dispatch.mjs";
import { readPostgresCommunityDailyTestPreflight } from "../cloud-run/postgres-community-daily-publish-test.mjs";
import { readPostgresPublishedCommunityDaily } from "../src/postgres-community-daily.ts";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const SOURCE_ID = "synthetic-community-source";
const SOURCE_NAMESPACE = "synthetic-community-namespace";
const DAY = "2026-09-24";
const RELEASED_AT = "2026-09-24T12:00:00.000Z";

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
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

function payload(revision, usageEvents = 1) {
  const activity = usageEvents > 0;
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
    allowance: {
      basis: "codex-seven-day-fit-v1",
      limitId: "codex",
      referencePlanType: "pro",
      normalization: "pro_x1_prolite_x4_plus_x20",
      windowDurationMinutes: 10_080,
      trailingDays: 30,
      qualification: "synthetic-unqualified",
      spanFloorPp: 25,
      fitCount: 0,
      participantCount: 0,
      centralUsd: null,
      band80Usd: null,
    },
    totals: {
      contributingParticipants: activity ? 1 : 0,
      contributingDevices: activity ? 1 : 0,
      usageEvents,
      quotaObservations: 0, sessionDimensions: 0, inputUncachedTokens: activity ? 1 : 0,
      inputCacheReadTokens: 0, inputCacheWriteTokens: 0, outputTextTokens: 0,
      outputReasoningTokens: 0, outputCombinedTokens: 0,
    },
    cellsTruncated: false,
    cells: activity ? [{ provider: "openai", modelId: "gpt-6-sol", usageEvents,
      inputUncachedTokens: 1, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
      outputTextTokens: 0, outputReasoningTokens: 0, outputCombinedTokens: 0 }] : [],
    capacityByPlanType: { privateDiagnostic: "must-not-cross" },
  };
}

describe.skipIf(!PG_TEST_SOCKET)("PostgreSQL private community daily HTTP route", () => {
  let pool;
  let schema;
  let quotedSchema;

  beforeAll(async () => {
    const socket = await localSocket();
    pool = new pg.Pool({
      ...socket,
      user: process.env.PG_TEST_USER || "postgres",
      password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
      database: process.env.PG_TEST_DATABASE || "postgres",
      application_name: "pg-community-daily-host-test",
      ssl: false,
      max: 2,
      connectionTimeoutMillis: 5_000,
    });
    const locality = await pool.query("SELECT inet_server_addr() AS address, version() AS version");
    assert.equal(locality.rows[0]?.address, null, "qualification requires a local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^PostgreSQL 17\./u);
  }, 120_000);

  beforeEach(async () => {
    schema = `pcdh_${randomBytes(6).toString("hex")}`;
    quotedSchema = `"${schema}"`;
    await pool.query(`CREATE SCHEMA ${quotedSchema}`);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    await pool.query(`INSERT INTO ${quotedSchema}.typed_telemetry_namespaces(id,original_id)
      VALUES (1,decode('0102','hex'))`);
    await pool.query(`INSERT INTO ${quotedSchema}.typed_v1_admission_state(
      id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      VALUES (1,$1,1,1,1)`, [SOURCE_NAMESPACE]);
    await pool.query(`INSERT INTO ${quotedSchema}.typed_v11_admission_state(
      id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      VALUES (1,$1,1,1,1)`, [SOURCE_NAMESPACE]);
    await pool.query(`INSERT INTO ${quotedSchema}.storage_source_state(singleton,source_id,authority_epoch)
      VALUES (1,$1,0)`, [SOURCE_ID]);
    await pool.query(`INSERT INTO ${quotedSchema}.analytics_source_cursors(source_id,sequence,authority_epoch)
      VALUES ($1,0,0)`, [SOURCE_ID]);
    await pool.query(`UPDATE ${quotedSchema}.publication_state SET publication_state='ready',policy_revision=1
      WHERE singleton=1`);
    // Primary 0050: 'operational' means all four flags on, and reason_code is
    // NOT NULL in the D1 vocabulary.
    await pool.query(`UPDATE ${quotedSchema}.collection_controls SET revision=revision+1,
      control_state='operational', enrollment_enabled=true, upload_registration_enabled=true,
      processing_enabled=true, publication_enabled=true, reason_code='maintenance',
      updated_at=clock_timestamp() WHERE singleton=1`);
  }, 120_000);

  afterEach(async () => {
    if (schema) await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    schema = undefined;
    quotedSchema = undefined;
  }, 120_000);

  afterAll(async () => { if (pool) await pool.end(); });

  async function insertRevision(revision, releaseState = "published", usageEvents = 1) {
    const json = JSON.stringify(payload(revision, usageEvents));
    await pool.query(`INSERT INTO ${quotedSchema}.community_daily_aggregates(
      source_id,source_namespace,day,revision,payload_json,payload_sha256,
      source_authority_epoch,source_cursor_sequence,policy_revision,collection_revision,
      release_state,released_at,withdrawn_at)
      SELECT $1,$2,$3::date,$4,$5,$6,0,0,1,controls.revision,$7,$8::timestamptz,
        CASE WHEN $7='withdrawn' THEN clock_timestamp() ELSE NULL END
        FROM ${quotedSchema}.collection_controls controls WHERE singleton=1`,
    [SOURCE_ID, SOURCE_NAMESPACE, DAY, revision, json, digest(json), releaseState, RELEASED_AT]);
  }

  function dispatch() {
    const healthDispatch = async () => new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    return createPostgresTestCommunityDailyDispatch({
      primaryPool: pool,
      schemaOptions: { primarySchema: schema, ledgerSchema: "daily_ledger_test" },
      sourceIdentity: { sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE },
      readPostgresPublishedCommunityDaily,
      healthDispatch,
      privateOrigin: "http://127.0.0.1:8080",
    });
  }

  it("read-only publisher preflight blocks disabled controls and an undelivered journal tail", async () => {
    const config = { schema, sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY };
    const ready = await readPostgresCommunityDailyTestPreflight(pool, config);
    expect(ready).toMatchObject({ status: "ready", blockers: [] });

    // Primary 0050: 'contained' means all four flags off.
    await pool.query(`UPDATE ${quotedSchema}.collection_controls SET control_state='contained',
      enrollment_enabled=false, upload_registration_enabled=false, processing_enabled=false,
      publication_enabled=false WHERE singleton=1`);
    const blockedControls = await readPostgresCommunityDailyTestPreflight(pool, config);
    expect(blockedControls).toMatchObject({
      status: "blocked",
      blockers: ["PUBLICATION_CONTROLS_DISABLED"],
    });
    await pool.query(`INSERT INTO ${quotedSchema}.storage_ingestion_changes(
      source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms)
      VALUES ($1,1,repeat('a',64),repeat('b',64),0,0,'source-updated',0)`, [SOURCE_ID]);
    const blockedCursor = await readPostgresCommunityDailyTestPreflight(pool, config);
    expect(blockedCursor).toMatchObject({
      status: "blocked",
      blockers: ["PUBLICATION_CONTROLS_DISABLED", "ANALYTICS_CURSOR_BEHIND_JOURNAL"],
    });
    const persisted = await pool.query(`SELECT control_state,publication_enabled
      FROM ${quotedSchema}.collection_controls WHERE singleton=1`);
    expect(persisted.rows[0]).toEqual({ control_state: "contained", publication_enabled: false });
  });

  it("serves an honest empty activity day and omits unavailable allowance diagnostics", async () => {
    await insertRevision(1, "published", 0);
    const response = await dispatch()(new Request(
      `http://127.0.0.1:8080/api/v1/community/daily?from=${DAY}&to=${DAY}`,
    ));
    assert.equal(response.status, 200);
    const result = await response.json();
    expect(result).toMatchObject({
      schemaVersion: "community-daily-read-v1.0",
      from: DAY,
      to: DAY,
      allowanceState: "updating",
      days: [{ day: DAY, revision: 1, payload: {
        totals: { usageEvents: 0, contributingParticipants: 0, contributingDevices: 0 },
        cells: [],
      } }],
    });
    expect(result.days[0].payload).not.toHaveProperty("allowance");
    expect(result.days[0].payload).not.toHaveProperty("capacityByPlanType");
    expect(JSON.stringify(result)).not.toContain("must-not-cross");
    expect(JSON.stringify(result)).not.toContain(SOURCE_ID);
  });

  it("does not reveal an older day after the newest revision is withdrawn", async () => {
    await insertRevision(1);
    await insertRevision(2, "withdrawn");
    const response = await dispatch()(new Request(
      `http://127.0.0.1:8080/api/v1/community/daily?from=${DAY}&to=${DAY}`,
    ));
    assert.equal(response.status, 200);
    expect(await response.json()).toMatchObject({ days: [] });
  });
});
