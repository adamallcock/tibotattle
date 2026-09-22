import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { createPostgresStorageSource } from "../src/postgres-storage-source.ts";
import {
  createPostgresAnalyticalWorkStore,
  createPostgresPreparedSourceStore,
} from "../src/postgres-storage-provider.ts";
import {
  advanceCommunityAnalysisRunWithProvider,
  communityAnalysisProviderIdentity,
} from "../src/community-analysis-runner.ts";
import {
  createProviderV1QuotaReader,
  createProviderV1PreparedEvidence,
  ensurePreparedV1WindowFromProviderDays,
  ensurePreparedV1WindowFromProvider,
  V1_PREPARED_READER_POLICY,
} from "../src/prepared-v1-evidence.ts";

const { Pool } = pg;
const primarySchema = "tibotattle";
const databaseName = `tibotattle_prepared_pipeline_${randomBytes(10).toString("hex")}`;
const participantId = "pipeline-participant";
const deviceId = "pipeline-device";
const sourceId = "pipeline-source";
const ownerDigest = "a".repeat(64);
const day = "2026-09-21";
const method = "legacy-day-or-complete-domain-3";
const namespace = "telemetry-v1";
let admin;
let pool;
let created = false;

const baseOptions = () => ({
  host: process.env.PG_TEST_SOCKET,
  port: Number(process.env.PG_TEST_PORT ?? "55432"),
  user: "postgres",
  password: "localtrust",
  ssl: false,
  options: "",
  application_name: "tibotattle-prepared-provider-pipeline-test",
  connectionTimeoutMillis: 3000,
  statement_timeout: 12000,
  idleTimeoutMillis: 1000,
  max: 3,
});

const digest = (value) => createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  const socket = process.env.PG_TEST_SOCKET;
  if (typeof socket !== "string" || !isAbsolute(socket)
      || !socket.startsWith("/private/tmp/tibotattle-pg-")) {
    throw new Error("PG_TEST_SOCKET must identify the provisioned local PostgreSQL socket");
  }
  const stat = await lstat(socket);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(socket) !== socket
      || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()) {
    throw new Error("PG_TEST_SOCKET must be a canonical owner-only directory");
  }
  const port = Number(process.env.PG_TEST_PORT ?? "55432");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid PG_TEST_PORT");
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PG") && !key.startsWith("PG_TEST_")) delete process.env[key];
  }
  admin = new Pool({ ...baseOptions(), database: "postgres", max: 1 });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  pool = new Pool({ ...baseOptions(), database: databaseName });
  await pool.query(`CREATE SCHEMA "${primarySchema}"`);
  await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool });
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ${primarySchema}.analytics_analysis_work_parts,
    ${primarySchema}.analytics_analysis_work_heads,
    ${primarySchema}.analytics_prepared_source_outputs,
    ${primarySchema}.analytics_prepared_source_controls,
    ${primarySchema}.analytics_prepared_source_streams,
    ${primarySchema}.analytics_prepared_source_rows,
    ${primarySchema}.analytics_prepared_source_heads,
    ${primarySchema}.analytics_owner_state`);
  await pool.query(`DELETE FROM ${primarySchema}.telemetry_v1_records`);
  await pool.query(`DELETE FROM ${primarySchema}.telemetry_v1_chunks`);
  await pool.query(`DELETE FROM ${primarySchema}.pending_objects`);
  await pool.query(`DELETE FROM ${primarySchema}.storage_ingestion_changes`);
  await pool.query(`DELETE FROM ${primarySchema}.storage_v11_owner_links`);
  await pool.query(`DELETE FROM ${primarySchema}.storage_source_state`);
  await pool.query(`DELETE FROM ${primarySchema}.device_upload_authorizations`);
  await pool.query(`DELETE FROM ${primarySchema}.device_credentials`);
  await pool.query(`DELETE FROM ${primarySchema}.device_pairings`);
  await pool.query(`DELETE FROM ${primarySchema}.web_sessions`);
  await pool.query(`DELETE FROM ${primarySchema}.participants`);
});

afterAll(async () => {
  await pool?.end();
  if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin?.end();
});

async function seedCanonicalV1({ includeNumericTieRows = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${primarySchema}, pg_catalog`);
    const now = "2026-09-21T00:00:00.000Z";
    const secret = Buffer.alloc(32, 7);
    await client.query(`
      INSERT INTO participants(id,owner_kind,state,created_at)
      VALUES($1,'social','active',$2)`, [participantId, now]);
    await client.query(`
      INSERT INTO web_sessions(id,participant_id,secret_hash,csrf_hash,issued_at,expires_at,last_used_at)
      VALUES('pipeline-session',$1,$2,$3,$4,$5,$4)`, [participantId, secret, secret, now, "2027-01-01T00:00:00.000Z"]);
    await client.query(`
      INSERT INTO device_pairings(id,participant_id,issued_by_session_id,secret_hash,consent_version,
        transport_consent_version,issued_at,expires_at)
      VALUES('pipeline-pairing',$1,'pipeline-session',$2,'consent-v1','transport-v1',$3,$4)`,
    [participantId, secret, now, "2027-01-01T00:00:00.000Z"]);
    await client.query(`
      INSERT INTO device_credentials(id,participant_id,authority_kind,paired_via_pairing_id,secret_hash,
        issued_at,expires_at,last_used_at)
      VALUES($1,$2,'social','pipeline-pairing',$3,$4,$5,$4)`,
    [deviceId, participantId, secret, now, "2027-01-01T00:00:00.000Z"]);
    await client.query(`
      INSERT INTO device_upload_authorizations(id,participant_id,issued_by_device_id,secret_hash,
        envelope_digest,body_bytes,content_type,issued_at,expires_at)
      VALUES('pipeline-auth',$1,$2,$3,$4,1,'application/json',$5,$6)`,
    [participantId, deviceId, secret, digest("envelope"), now, "2027-01-01T00:00:00.000Z"]);
    await client.query(`
      INSERT INTO telemetry_v1_device_consents(participant_id,device_id,telemetry_schema_version,
        field_dictionary_version,privacy_contract_version,consented_at)
      VALUES($1,$2,'telemetry-contribution-v1.0','telemetry-v1.0-registry-2026-08-07.1',
        'ongoing-privacy-safe-telemetry-v1.0',$3)`, [participantId, deviceId, now]);
    const chunkDigest = digest("pipeline-chunk");
    const chunkId = "pipeline-chunk";
    await client.query(`
      INSERT INTO pending_objects(contribution_id,object_key)
      VALUES($1,$2)`, [chunkId, "pipeline-object"]);
    await client.query(`
      INSERT INTO telemetry_v1_chunks(id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
        chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,
        device_upload_authorization_id,created_at)
      VALUES($1,$2,$3,'quota',$4,0,1,$5,$6,'pipeline-parser',8,8,'pipeline-object','pipeline-auth',$7)`,
    [chunkId, participantId, deviceId, day, chunkDigest, digest("pipeline-envelope"), now]);
    const records = [
      ["quota-occurrence-1", "2026-09-21T00:00:01.000Z", "codex", "plus", "standard", 12.5],
      ["quota-occurrence-2", "2026-09-21T00:00:02.000Z", "codex", "plus", "standard", 13.5],
      ["quota-occurrence-3", "2026-09-21T00:00:03.000Z", "codex", "plus", "standard", 14.5],
      ["quota-occurrence-4", "2026-09-21T00:00:04.000Z", "codex", "plus", "standard", 15.5],
      ["quota-occurrence-5", "2026-09-21T00:00:05.000Z", "codex", "plus", "standard", 16.5],
      ["quota-occurrence-6", "2026-09-21T00:00:06.000Z", "codex", "plus", "standard", 17.5],
      ["quota-occurrence-7", "2026-09-21T00:00:07.000Z", "codex", "plus", "standard", 18.5],
      ["quota-occurrence-8", "2026-09-21T00:00:08.000Z", "codex", "plus", "standard", 19.5],
      ...(includeNumericTieRows ? Array.from({ length: 12 }, (_, index) => [
        `quota-tie-occurrence-${index + 1}`, "2026-09-21T00:00:10.000Z", "codex", "plus", "standard", 20.5 + index,
      ]) : []),
    ];
    for (const [occurrence, observedAt, limitId, planType, planVariant, usedPercent] of records) {
      await client.query(`
        INSERT INTO telemetry_v1_records(chunk_row_id,participant_id,device_id,stream,occurrence_id,
          observed_at,observed_day,provider,model_id,plan_type,plan_variant,limit_id,slot,
          used_percent,window_duration_minutes,resets_at,record_json)
        VALUES($1,$2,$3,'quota',$4,$5,$6,'openai_codex',NULL,$7,$8,$9,'weekly',$10,10080,$11,$12::jsonb)`,
      [chunkId, participantId, deviceId, occurrence, observedAt, day, planType, planVariant,
        limitId, usedPercent, "2026-09-22T00:00:00.000Z", JSON.stringify({ occurrence_id: occurrence })]);
    }
    await client.query(`
      INSERT INTO device_upload_authorizations(id,participant_id,issued_by_device_id,secret_hash,
        envelope_digest,body_bytes,content_type,issued_at,expires_at)
      VALUES('pipeline-usage-auth',$1,$2,$3,$4,1,'application/json',$5,$6)`,
    [participantId, deviceId, secret, digest("usage-envelope"), now, "2027-01-01T00:00:00.000Z"]);
    const usageChunkId = "pipeline-usage-chunk";
    await client.query(`
      INSERT INTO pending_objects(contribution_id,object_key)
      VALUES($1,$2)`, [usageChunkId, "pipeline-usage-object"]);
    await client.query(`
      INSERT INTO telemetry_v1_chunks(id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
        chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,
        device_upload_authorization_id,created_at)
      VALUES($1,$2,$3,'usage',$4,1,1,$5,$6,'pipeline-parser',1,1,'pipeline-usage-object','pipeline-usage-auth',$7)`,
    [usageChunkId, participantId, deviceId, day, digest("pipeline-usage-chunk"), digest("usage-envelope"), now]);
    const usageRecord = {
      schemaVersion: "usage-event-v1.0", eventId: "pipeline-usage-1", eventTime: "2026-09-21T00:00:09.000Z",
      sessionUuid: "pipeline-session-usage", provider: "openai_codex", modelId: "gpt-6-astra",
      speedMode: "standard", apiServiceTier: "unknown", surface: "local_interactive_unclassified",
      billingSurface: "chatgpt_subscription", reasoningEffort: "medium", agentScope: "root", outcome: "completed",
      totalInputContextTokens: null,
      components: { inputUncachedTokens: 1000, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
        outputTextTokens: 1000, outputReasoningTokens: 0, outputCombinedTokens: 1000 },
    };
    await client.query(`
      INSERT INTO telemetry_v1_records(chunk_row_id,participant_id,device_id,stream,occurrence_id,
        observed_at,observed_day,provider,model_id,session_uuid,record_json)
        VALUES($1,$2,$3,'usage','pipeline-usage-1',$4,$5,'openai_codex','gpt-6-astra',
        'pipeline-session-usage',$6::jsonb)`,
    [usageChunkId, participantId, deviceId, "2026-09-21T00:00:09.000Z", day, JSON.stringify(usageRecord)]);
    const revision = (await client.query(`SELECT revision FROM input_versions WHERE participant_id=$1`, [participantId])).rows[0].revision;
    await client.query(`
      INSERT INTO storage_source_state(singleton,source_id,authority_epoch) VALUES(1,$1,1)`, [sourceId]);
    await client.query(`
      INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state)
      VALUES($1,$2,'active')`, [participantId, ownerDigest]);
    await client.query(`
      INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
      VALUES($1,$2,$3,1,'active')`, [sourceId, ownerDigest, revision]);
    return { revision };
  } finally {
    client.release();
  }
}

async function seedCanonicalSecondDay() {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${primarySchema}, pg_catalog`);
    const secondDay = "2026-09-20";
    const now = "2026-09-20T00:00:00.000Z";
    const secret = Buffer.alloc(32, 7);
    await client.query(`
      INSERT INTO device_upload_authorizations(id,participant_id,issued_by_device_id,secret_hash,
        envelope_digest,body_bytes,content_type,issued_at,expires_at)
      VALUES('pipeline-day20-auth',$1,$2,$3,$4,1,'application/json',$5,$6)`,
    [participantId, deviceId, secret, digest("day20-quota-envelope"), now, "2027-01-01T00:00:00.000Z"]);
    await client.query(`INSERT INTO pending_objects(contribution_id,object_key)
      VALUES($1,$2)`, ["pipeline-day20-quota-chunk", "pipeline-day20-quota-object"]);
    await client.query(`
      INSERT INTO telemetry_v1_chunks(id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
        chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,
        device_upload_authorization_id,created_at)
      VALUES($1,$2,$3,'quota',$4,0,1,$5,$6,'pipeline-parser',3,3,$7,$8,$9)`,
    ["pipeline-day20-quota-chunk", participantId, deviceId, secondDay,
      digest("pipeline-day20-quota-chunk"), digest("day20-quota-envelope"),
      "pipeline-day20-quota-object", "pipeline-day20-auth", now]);
    for (let index = 1; index <= 3; index += 1) {
      const observedAt = `2026-09-20T00:00:0${index}.000Z`;
      await client.query(`
        INSERT INTO telemetry_v1_records(chunk_row_id,participant_id,device_id,stream,occurrence_id,
          observed_at,observed_day,provider,model_id,plan_type,plan_variant,limit_id,slot,
          used_percent,window_duration_minutes,resets_at,record_json)
        VALUES($1,$2,$3,'quota',$4,$5,$6,'openai_codex',NULL,'plus','standard','codex','weekly',$7,10080,$8,$9::jsonb)`,
      ["pipeline-day20-quota-chunk", participantId, deviceId, `day20-quota-${index}`,
        observedAt, secondDay, 10 + index, "2026-09-21T00:00:00.000Z",
        JSON.stringify({ occurrence_id: `day20-quota-${index}` })]);
    }
    await client.query(`
      INSERT INTO device_upload_authorizations(id,participant_id,issued_by_device_id,secret_hash,
        envelope_digest,body_bytes,content_type,issued_at,expires_at)
      VALUES('pipeline-day20-usage-auth',$1,$2,$3,$4,1,'application/json',$5,$6)`,
    [participantId, deviceId, secret, digest("day20-usage-envelope"), now, "2027-01-01T00:00:00.000Z"]);
    await client.query(`INSERT INTO pending_objects(contribution_id,object_key)
      VALUES($1,$2)`, ["pipeline-day20-usage-chunk", "pipeline-day20-usage-object"]);
    await client.query(`
      INSERT INTO telemetry_v1_chunks(id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
        chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,
        device_upload_authorization_id,created_at)
      VALUES($1,$2,$3,'usage',$4,1,1,$5,$6,'pipeline-parser',$7,$7,$8,$9,$10)`,
    ["pipeline-day20-usage-chunk", participantId, deviceId, secondDay, digest("pipeline-day20-usage-chunk"),
      digest("day20-usage-envelope"), 200, "pipeline-day20-usage-object", "pipeline-day20-usage-auth", now]);
    await client.query(`
      INSERT INTO device_upload_authorizations(id,participant_id,issued_by_device_id,secret_hash,
        envelope_digest,body_bytes,content_type,issued_at,expires_at)
      VALUES('pipeline-day20-usage-auth-2',$1,$2,$3,$4,1,'application/json',$5,$6)`,
    [participantId, deviceId, secret, digest("day20-usage-envelope-2"), now, "2027-01-01T00:00:00.000Z"]);
    await client.query(`INSERT INTO pending_objects(contribution_id,object_key)
      VALUES($1,$2)`, ["pipeline-day20-usage-chunk-2", "pipeline-day20-usage-object-2"]);
    await client.query(`
      INSERT INTO telemetry_v1_chunks(id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
        chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,
        device_upload_authorization_id,created_at)
      VALUES($1,$2,$3,'usage',$4,2,1,$5,$6,'pipeline-parser',57,57,$7,$8,$9)`,
    ["pipeline-day20-usage-chunk-2", participantId, deviceId, secondDay, digest("pipeline-day20-usage-chunk-2"),
      digest("day20-usage-envelope-2"), "pipeline-day20-usage-object-2", "pipeline-day20-usage-auth-2", now]);
    const baseUsage = {
      schemaVersion: "usage-event-v1.0", sessionUuid: "pipeline-day20-session", provider: "openai_codex",
      modelId: "gpt-6-astra", speedMode: "standard", apiServiceTier: "unknown", surface: "local_interactive_unclassified",
      billingSurface: "chatgpt_subscription", reasoningEffort: "medium", agentScope: "root", outcome: "completed",
      totalInputContextTokens: null,
      components: { inputUncachedTokens: 1000, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
        outputTextTokens: 1000, outputReasoningTokens: 0, outputCombinedTokens: 1000 },
    };
    for (let index = 1; index <= 257; index += 1) {
      const minute = Math.floor((index - 1) / 60);
      const second = (index - 1) % 60 + 1;
      const observedAt = `2026-09-20T00:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
      const usage = { ...baseUsage, eventId: `pipeline-day20-usage-${index}`, eventTime: observedAt };
      await client.query(`
        INSERT INTO telemetry_v1_records(chunk_row_id,participant_id,device_id,stream,occurrence_id,
          observed_at,observed_day,provider,model_id,session_uuid,record_json)
        VALUES($1,$2,$3,'usage',$4,$5,$6,'openai_codex','gpt-6-astra',$7,$8::jsonb)`,
      [index <= 200 ? "pipeline-day20-usage-chunk" : "pipeline-day20-usage-chunk-2", participantId, deviceId, `day20-usage-${index}`,
        observedAt, secondDay, "pipeline-day20-session", JSON.stringify(usage)]);
    }
  } finally {
    client.release();
  }
}

it("reads canonical v1, prepares immutable pages, and runs the existing quota codec", async () => {
  await seedCanonicalV1({ includeNumericTieRows: true });
  const source = createPostgresStorageSource(pool, { primarySchema, ledgerSchema: "tibotattle_ledger" });
  const sourcePin = await source.readPin({
    sourceId, sourceNamespace: namespace, ownerDigest, day, method,
  });
  expect(sourcePin).not.toBeNull();
  if (!sourcePin) return;
  const sourcePage = await source.readPage({ pin: sourcePin, stream: "quota", deviceId, cursor: null, limit: 1 });
  expect(sourcePage).toMatchObject({ status: "available", complete: false, rows: [{ occurrenceId: "1" }] });
  const prepared = createPostgresPreparedSourceStore(pool, { primarySchema, ledgerSchema: "tibotattle_ledger" });
  let preparedResult;
  let invocations = 0;
  do {
    preparedResult = await ensurePreparedV1WindowFromProvider({
      source,
      prepared,
      pin: sourcePin,
      deviceId,
      generation: "pipeline-generation",
      readerPolicy: V1_PREPARED_READER_POLICY,
      maxPages: 1,
      pageSize: 1,
      deadlineMs: Date.now() + 60_000,
      expectedQuotaRows: 20,
      expectedUsageRows: 1,
    });
    invocations += 1;
  } while (preparedResult.status === "deferred" && invocations < 32);
  expect(preparedResult.status).toBe("complete");
  expect(invocations).toBe(21);
  expect(preparedResult.rowsWritten).toBe(20);
  await expect(prepared.begin({ pin: sourcePin, generation: "pipeline-generation" }))
    .resolves.toMatchObject({ state: "ready", rowsWritten: 20 });
  const quotaPreparedPage = await prepared.readPage({ pin: sourcePin, generation: "pipeline-generation",
    readerPolicy: V1_PREPARED_READER_POLICY, cursor: null, limit: 1 });
  expect(quotaPreparedPage.rows[0]?.payload).not.toHaveProperty("prepared");
  const quotaPlans = await prepared.readOutputs({ pin: sourcePin, generation: "pipeline-generation", stream: "quota",
    kind: "plan", afterIndex: -1, afterKey: "", limit: 128 });
  const quotaFits = await prepared.readOutputs({ pin: sourcePin, generation: "pipeline-generation", stream: "quota",
    kind: "fit", afterIndex: -1, afterKey: "", limit: 128 });
  expect(quotaPlans.length).toBeGreaterThan(0);
  expect(quotaFits.length).toBeGreaterThan(0);
  expect(quotaPlans[0].payload).not.toHaveProperty("prepared");
  const tiePlanIds = quotaPlans
    .filter((output) => output.payload.observed_at === "2026-09-21T00:00:10.000Z")
    .map((output) => output.payload.id);
  expect(tiePlanIds).toEqual([...tiePlanIds].sort((left, right) => left - right));
  const quotaReader = createProviderV1QuotaReader({
    store: prepared, pin: sourcePin, generation: "pipeline-generation", readerPolicy: V1_PREPARED_READER_POLICY,
  });
  const firstPlanPage = await quotaReader.readPlanPage({ observedAt: "2026-09-21T00:00:00.000Z", id: 0 }, 10);
  const firstPlan = firstPlanPage.at(-1);
  expect(firstPlan).toBeDefined();
  const secondPlanPage = await quotaReader.readPlanPage({ observedAt: firstPlan.observed_at, id: firstPlan.id }, 10);
  expect([...firstPlanPage, ...secondPlanPage].map((row) => row.id))
    .toEqual(quotaPlans.map((output) => output.payload.id));
  const usageHead = await prepared.begin({ pin: sourcePin, generation: preparedResult.usageGeneration, stream: "usage" });
  expect(usageHead).toMatchObject({ state: "ready", rowsWritten: 1 });
  const usagePage = await prepared.readPage({ pin: sourcePin, generation: preparedResult.usageGeneration,
    readerPolicy: V1_PREPARED_READER_POLICY, stream: "usage", cursor: null, limit: 2 });
  expect(usagePage.rows[0]?.payload).not.toHaveProperty("prepared");
  const usagePrices = await prepared.readOutputs({ pin: sourcePin, generation: preparedResult.usageGeneration, stream: "usage",
    kind: "usage_price", afterIndex: -1, afterKey: "", limit: 128 });
  const usageFragments = await prepared.readOutputs({ pin: sourcePin, generation: preparedResult.usageGeneration, stream: "usage",
    kind: "usage_fragment", afterIndex: -1, afterKey: "", limit: 128 });
  expect(usagePrices).toHaveLength(1);
  expect(usagePrices[0].payload.preparedPrice.costNanousd).toBeGreaterThan(0);
  expect(usagePrices[0].payload.preparedPrice.modelId).toBe("gpt-6-astra");
  expect(usageFragments.length).toBeGreaterThan(0);
  expect(usageFragments[0].payload.cells[0].costNanousd).toBeGreaterThan(0);
  const preparedEvidence = await createProviderV1PreparedEvidence({
    store: prepared, pin: sourcePin, quotaGeneration: "pipeline-generation",
    usageGeneration: preparedResult.usageGeneration, sourceFingerprint: sourcePin.dependencyDigest,
  });
  await expect(preparedEvidence.usageReader.readPage("2026-09-21T00:00:00.000Z", 0, 128))
    .resolves.toMatchObject([{ preparedPrice: { modelId: "gpt-6-astra", costNanousd: expect.any(Number) } }]);
  expect(preparedEvidence.usageBins.totalRowCount).toBe(1);
  expect(preparedEvidence.usageBins.fragmentCount).toBeGreaterThan(0);
  const identity = {
    participantId,
    inputRevision: sourcePin.inputRevision,
    inputFingerprint: sourcePin.dependencyDigest,
    sourceKind: "v1",
    sourceMethodVersion: sourcePin.method,
    fixedNow: "2026-09-21T23:59:59.999Z",
    observedAtCutoff: `${day}T00:00:00.000Z`,
    resetsAtCutoff: "2026-09-21T00:00:00.000Z",
    windowMinutes: 10080,
    maxQuotaRows: 120,
  };
  const workStore = createPostgresAnalyticalWorkStore(pool, { primarySchema, ledgerSchema: "tibotattle_ledger" });
  const result = await advanceCommunityAnalysisRunWithProvider({
    identity,
    workStore,
    workIdentity: communityAnalysisProviderIdentity(identity, sourcePin),
    preparedSource: {
      store: prepared,
      pin: sourcePin,
      generation: "pipeline-generation",
      readerPolicy: V1_PREPARED_READER_POLICY,
    },
    winningDayDevices: new Map([[day, deviceId]]),
    leaseMs: 60_000,
    budget: { remainingQueries: 256, reserveQueries: 0, deadlineMs: Date.now() + 60_000 },
  });
  expect(result.status).toBe("ready");
  if (result.status === "ready") expect(result.evidence.acquisition.quotaRows).toHaveLength(10);
  await pool.query(`UPDATE ${primarySchema}.analytics_owner_state SET revision=revision+1 WHERE source_id=$1 AND owner_digest=$2`, [sourceId, ownerDigest]);
  await expect(source.readPage({ pin: sourcePin, stream: "quota", deviceId, cursor: null, limit: 1 }))
    .resolves.toMatchObject({ status: "stale", rows: [] });
});

it("prepares an explicit multi-day window and preserves resumed finisher parity", async () => {
  await seedCanonicalV1();
  await seedCanonicalSecondDay();
  const source = createPostgresStorageSource(pool, { primarySchema, ledgerSchema: "tibotattle_ledger" });
  const firstPin = await source.readPin({ sourceId, sourceNamespace: namespace, ownerDigest, day: "2026-09-20", method });
  const secondPin = await source.readPin({ sourceId, sourceNamespace: namespace, ownerDigest, day, method });
  expect(firstPin).not.toBeNull();
  expect(secondPin).not.toBeNull();
  if (!firstPin || !secondPin) return;
  expect(firstPin.inputRevision).toBe(secondPin.inputRevision);
  const prepared = createPostgresPreparedSourceStore(pool, { primarySchema, ledgerSchema: "tibotattle_ledger" });
  const windowDays = [
    { pin: firstPin, deviceId, generation: "pipeline-day20-quota", usageGeneration: "pipeline-day20-usage",
      expectedQuotaRows: 3, expectedUsageRows: 257 },
    { pin: secondPin, deviceId, generation: "pipeline-day21-quota", usageGeneration: "pipeline-day21-usage",
      expectedQuotaRows: 8, expectedUsageRows: 1 },
  ];
  let preparation;
  let invocations = 0;
  do {
    preparation = await ensurePreparedV1WindowFromProviderDays({
      source, prepared, days: windowDays, maxPages: 2, pageSize: 256,
      deadlineMs: Date.now() + 60_000,
    });
    invocations += 1;
  } while (preparation.status === "deferred" && invocations < 16);
  expect(preparation.status).toBe("complete");
  expect(invocations).toBeGreaterThan(1);
  expect(preparation.days).toHaveLength(2);
  if (preparation.status !== "complete" || !preparation.preparedEvidence) return;
  const evidence = preparation.preparedEvidence;
  const usageRows = await evidence.usageReader.readPage("2026-09-20T00:00:00.000Z", 0, 5000);
  expect(usageRows).toHaveLength(258);
  expect(usageRows.some((row) => row.preparedPrice?.costNanousd > 0)).toBe(true);
  expect(evidence.usageBins.totalRowCount).toBe(258);
  expect(evidence.usageBins.fragmentCount).toBeGreaterThan(0);

  const preparedSource = {
    store: prepared, pin: firstPin, generation: "pipeline-day20-quota",
    readerPolicy: V1_PREPARED_READER_POLICY,
    sources: preparation.days.map((preparedDay) => ({ pin: preparedDay.pin, generation: preparedDay.generation })),
  };
  const quotaReader = createProviderV1QuotaReader(preparedSource);
  const quotaPlans = await quotaReader.readPlanPage({ observedAt: "2026-09-19T23:59:59.000Z", id: 0 }, 128);
  const firstRawPage = await prepared.readPage({ pin: firstPin, generation: "pipeline-day20-quota",
    readerPolicy: V1_PREPARED_READER_POLICY, cursor: null, limit: 128 });
  const secondRawPage = await prepared.readPage({ pin: secondPin, generation: "pipeline-day21-quota",
    readerPolicy: V1_PREPARED_READER_POLICY, cursor: null, limit: 128 });
  expect(firstRawPage.rows).toHaveLength(3);
  expect(secondRawPage.rows).toHaveLength(8);
  // The existing compression algorithm retains first/last rows per plan run;
  // eleven physical rows therefore produce four durable plan anchors here.
  expect(quotaPlans).toHaveLength(4);
  expect(quotaPlans.some((row) => row.observed_day === "2026-09-20")).toBe(true);
  expect(quotaPlans.some((row) => row.observed_day === day)).toBe(true);

  const identity = {
    participantId, inputRevision: firstPin.inputRevision, inputFingerprint: firstPin.dependencyDigest,
    sourceKind: "v1", sourceMethodVersion: firstPin.method, fixedNow: "2026-09-21T23:59:59.999Z",
    observedAtCutoff: "2026-09-21T23:59:59.999Z", resetsAtCutoff: "2026-09-21T00:00:00.000Z",
    windowMinutes: 10080, maxQuotaRows: 120,
  };
  const workStore = createPostgresAnalyticalWorkStore(pool, { primarySchema, ledgerSchema: "tibotattle_ledger" });
  const workIdentity = communityAnalysisProviderIdentity(identity, firstPin);
  const sourceCurrent = async () => {
    for (const [pin, selectedDevice] of [[firstPin, deviceId], [secondPin, deviceId]]) {
      const page = await source.readPage({ pin, stream: "quota", deviceId: selectedDevice, cursor: null, limit: 1 });
      if (page.status !== "available" || JSON.stringify(page.pin) !== JSON.stringify(pin)) return false;
    }
    return true;
  };
  const run = (remainingQueries) => advanceCommunityAnalysisRunWithProvider({
    identity, workStore, workIdentity, preparedSource,
    winningDayDevices: new Map([["2026-09-20", deviceId], [day, deviceId]]),
    leaseMs: 60_000, sourceCurrent,
    budget: { remainingQueries, reserveQueries: 0, deadlineMs: Date.now() + 60_000 },
  });
  const firstAttempt = await run(8);
  expect(["deferred", "ready"]).toContain(firstAttempt.status);
  let resumed = firstAttempt;
  for (let attempt = 0; resumed.status === "deferred" && attempt < 8; attempt += 1) resumed = await run(256);
  expect(resumed.status).toBe("ready");
  if (resumed.status !== "ready") return;
  const resumedEvidence = JSON.stringify(resumed.evidence);
  await pool.query(`TRUNCATE ${primarySchema}.analytics_analysis_work_parts, ${primarySchema}.analytics_analysis_work_heads`);
  const uninterrupted = await run(256);
  expect(uninterrupted.status).toBe("ready");
  if (uninterrupted.status === "ready") expect(JSON.stringify(uninterrupted.evidence)).toBe(resumedEvidence);
});

it("fails closed when an active newer domain supersedes the v1 source", async () => {
  await seedCanonicalV1();
  await pool.query(`
    INSERT INTO ${primarySchema}.telemetry_v11_domain_predecessors
      (token_hash,participant_id,device_id,legacy_fingerprint,input_revision,from_day,through_day,
       winners_json,created_at,expires_at)
    VALUES($1,$2,$3,$4,1,$5,$5,'[]'::text,$6,$7)`,
  [digest("pipeline-token"), participantId, deviceId, digest("pipeline-legacy"), day,
    "2026-09-21T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]);
  await pool.query(`
    INSERT INTO ${primarySchema}.telemetry_v11_domains
      (id,participant_id,device_id,predecessor_token_hash,manifest_digest,legacy_fingerprint,
       input_revision,from_day,through_day,days_json,created_at)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,$7,'[]'::text,$8)`,
  ["00000000-0000-4000-8000-000000000001", participantId, deviceId, digest("pipeline-token"),
    digest("pipeline-manifest"), digest("pipeline-legacy"), day, "2026-09-21T00:01:00.000Z"]);
  await pool.query(`
    INSERT INTO ${primarySchema}.telemetry_v11_domain_heads(participant_id,generation_id,revision,updated_at)
    VALUES($1,$2,1,$3)`, [participantId, "00000000-0000-4000-8000-000000000001", "2026-09-21T00:01:00.000Z"]);
  const source = createPostgresStorageSource(pool, { primarySchema, ledgerSchema: "tibotattle_ledger" });
  const sourcePin = await source.readPin({ sourceId, sourceNamespace: namespace, ownerDigest, day, method });
  expect(sourcePin).not.toBeNull();
  if (!sourcePin) return;
  await expect(source.readPage({ pin: sourcePin, stream: "quota", deviceId, cursor: null, limit: 1 }))
    .resolves.toMatchObject({ status: "correction_unavailable", rows: [] });
});

it("rejects prepared commits after a canonical upload or participant deletion", async () => {
  await seedCanonicalV1();
  const source = createPostgresStorageSource(pool, { primarySchema, ledgerSchema: "tibotattle_ledger" });
  const sourcePin = await source.readPin({ sourceId, sourceNamespace: namespace, ownerDigest, day, method });
  expect(sourcePin).not.toBeNull();
  if (!sourcePin) return;
  const prepared = createPostgresPreparedSourceStore(pool, { primarySchema, ledgerSchema: "tibotattle_ledger" });
  const generation = "authority-fence-generation";
  const head = await prepared.begin({ pin: sourcePin, generation });
  const page = await source.readPage({ pin: sourcePin, stream: "quota", deviceId, cursor: null, limit: 1 });
  expect(page.rows).toHaveLength(1);
  const row = page.rows[0];
  if (!row) return;
  await pool.query(`UPDATE ${primarySchema}.input_versions
    SET revision=revision+1 WHERE participant_id=$1`, [participantId]);
  await expect(prepared.commitPage({ pin: sourcePin, generation,
    expectedProgressRevision: head.progressRevision, nextCursor: page.nextCursor,
    complete: page.complete, rows: [row], rowDigest: digest(JSON.stringify([row])) }))
    .rejects.toMatchObject({ storageCode: "source_stale" });

  await pool.query(`UPDATE ${primarySchema}.input_versions SET revision=$2 WHERE participant_id=$1`,
    [participantId, sourcePin.inputRevision]);
  await pool.query(`UPDATE ${primarySchema}.participants SET state='deleting' WHERE id=$1`, [participantId]);
  await expect(prepared.commitPage({ pin: sourcePin, generation,
    expectedProgressRevision: head.progressRevision, nextCursor: page.nextCursor,
    complete: page.complete, rows: [row], rowDigest: digest(JSON.stringify([row])) }))
    .rejects.toMatchObject({ storageCode: "source_stale" });
});

it("rechecks canonical input between the final runner preflight and complete", async () => {
  await seedCanonicalV1();
  const source = createPostgresStorageSource(pool, { primarySchema, ledgerSchema: "tibotattle_ledger" });
  const sourcePin = await source.readPin({ sourceId, sourceNamespace: namespace, ownerDigest, day, method });
  expect(sourcePin).not.toBeNull();
  if (!sourcePin) return;
  const prepared = createPostgresPreparedSourceStore(pool, { primarySchema, ledgerSchema: "tibotattle_ledger" });
  await ensurePreparedV1WindowFromProvider({
    source, prepared, pin: sourcePin, deviceId, generation: "complete-fence-generation",
    readerPolicy: V1_PREPARED_READER_POLICY, maxPages: 8, pageSize: 8,
    deadlineMs: Date.now() + 60_000, expectedQuotaRows: 8, expectedUsageRows: 1,
  });
  const identity = {
    participantId, inputRevision: sourcePin.inputRevision, inputFingerprint: sourcePin.dependencyDigest,
    sourceKind: "v1", sourceMethodVersion: sourcePin.method, fixedNow: "2026-09-21T23:59:59.999Z",
    observedAtCutoff: `${day}T00:00:00.000Z`, resetsAtCutoff: `${day}T00:00:00.000Z`,
    windowMinutes: 10080, maxQuotaRows: 120,
  };
  const workStore = createPostgresAnalyticalWorkStore(pool, { primarySchema, ledgerSchema: "tibotattle_ledger" });
  let completePreflightSeen = false;
  const fencedWorkStore = {
    ...workStore,
    async read(workIdentity) {
      const head = await workStore.read(workIdentity);
      if (!completePreflightSeen && head?.checkpoint?.complete) {
        completePreflightSeen = true;
        await pool.query(`UPDATE ${primarySchema}.input_versions
          SET revision=revision+1 WHERE participant_id=$1`, [participantId]);
      }
      return head;
    },
  };
  const result = await advanceCommunityAnalysisRunWithProvider({
    identity, workStore: fencedWorkStore,
    workIdentity: communityAnalysisProviderIdentity(identity, sourcePin),
    preparedSource: { store: prepared, pin: sourcePin, generation: "complete-fence-generation",
      readerPolicy: V1_PREPARED_READER_POLICY },
    winningDayDevices: new Map([[day, deviceId]]), leaseMs: 60_000,
    budget: { remainingQueries: 256, reserveQueries: 0, deadlineMs: Date.now() + 60_000 },
  });
  expect(completePreflightSeen).toBe(true);
  expect(result.status).toBe("deferred");
  expect((await pool.query(`SELECT state FROM ${primarySchema}.analytics_analysis_work_heads
    WHERE source_id=$1 AND owner_digest=$2`, [sourcePin.sourceId, sourcePin.ownerDigest])).rows[0])
    .toEqual({ state: "checkpointing" });
});
