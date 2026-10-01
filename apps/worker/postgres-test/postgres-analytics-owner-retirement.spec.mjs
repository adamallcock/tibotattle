import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { test } from "node:test";
import { createServer } from "vite";
import { applyPostgresMigrations, readPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const PG_TEST_MIGRATIONS_ROOT = process.env.PG_TEST_MIGRATIONS_ROOT;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ID = "canonical-v1-primary";
const OWNER = "a".repeat(64);
const OTHER_OWNER = "b".repeat(64);
const OTHER_DIGEST = "c".repeat(64);
const EVENT_DIGEST = "d".repeat(64);
const OBJECT_DIGEST = "e".repeat(64);
const CONTENT_DIGEST = "f".repeat(64);

function q(schema, name) {
  assert.match(schema, /^[a-z_][a-z0-9_]{0,62}$/u);
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${schema}"."${name}"`;
}

async function endpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "analytics retirement tests require loopback or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  if (PG_TEST_SOCKET) {
    assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
    const link = await lstat(PG_TEST_SOCKET);
    const host = await realpath(PG_TEST_SOCKET);
    const metadata = await stat(host);
    assert.equal(link.isSymbolicLink(), false);
    assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
    assert.equal(metadata.mode & 0o077, 0);
    assert.equal(metadata.uid, process.getuid());
    return { host, port: PG_TEST_PORT };
  }
  if (PG_TEST_HOST) return { host: PG_TEST_HOST, port: PG_TEST_PORT };
  return null;
}

async function withHarness(run) {
  const local = await endpoint();
  assert.ok(local);
  const pool = new pg.Pool({
    ...local,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5_000,
  });
  const schema = `analytics_retirement_${randomBytes(5).toString("hex")}`;
  let vite;
  let schemaCreated = false;
  try {
    const version = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(version.rows[0].version / 10_000), 17,
      "analytics retirement is qualified against PostgreSQL 17");
    await pool.query(`CREATE SCHEMA ${q(schema, "unused").split(".")[0]}`);
    schemaCreated = true;
    const migrationOptions = PG_TEST_MIGRATIONS_ROOT === undefined
      ? {} : { rootDirectory: PG_TEST_MIGRATIONS_ROOT };
    const expected = await readPostgresMigrations({ role: "primary", ...migrationOptions });
    const applied = await applyPostgresMigrations({ role: "primary", schema, pool, ...migrationOptions });
    assert.equal(applied.applied, expected.length, "the fixture schema reaches the current primary migration head");
    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
    });
    const module = await vite.ssrLoadModule("/src/postgres-analytics-owner-retirement.ts");
    await run({ pool, schema, ...module });
  } finally {
    if (vite) await vite.close();
    if (schemaCreated) {
      try { await pool.query(`DROP SCHEMA IF EXISTS ${q(schema, "unused").split(".")[0]} CASCADE`); } catch {}
    }
    await pool.end();
  }
}

async function createErasureReceipt(pool, schema, ownerDigest = OWNER) {
  const participantId = `synthetic-analytics-owner:${randomUUID()}`;
  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (id,owner_kind,state,created_at)
     VALUES ($1,'accountless','active',clock_timestamp())`, [participantId],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "storage_v11_owner_links")} (participant_id,owner_digest,state)
     VALUES ($1,$2,'active')`, [participantId, ownerDigest],
  );
  await pool.query(`DELETE FROM ${q(schema, "participants")} WHERE id=$1`, [participantId]);
  const receipt = await pool.query(
    `SELECT owner_digest FROM ${q(schema, "storage_owner_erasure_receipts")} WHERE owner_digest=$1`, [ownerDigest],
  );
  assert.equal(receipt.rowCount, 1, "participant erasure must create the immutable proof receipt");
}

async function count(pool, schema, tableName, where, values = []) {
  const result = await pool.query(
    `SELECT count(*)::integer AS count FROM ${q(schema, tableName)} WHERE ${where}`,
    values,
  );
  return result.rows[0].count;
}

test("PG17 analytics owner retirement is receipt-gated and replay-safe for an owner with no analytics sources", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => withHarness(async ({ pool, schema, retirePostgresAnalyticsOwner }) => {
  await createErasureReceipt(pool, schema);
  await pool.query(`INSERT INTO ${q(schema, "preview_cache")} (id,payload) VALUES ('synthetic-owner-cache','{}'::jsonb)`);
  await pool.query(`INSERT INTO ${q(schema, "community_model_composition_days")} (day,payload_json,computed_at)
    VALUES (DATE '2026-01-01','{}',clock_timestamp())`);

  const options = { primaryPool: pool, ownerDigest: OWNER, schema: { primarySchema: schema } };
  const result = await retirePostgresAnalyticsOwner(options);
  assert.equal(result.status, "complete");
  assert.equal(result.sourceCount, 0);
  assert.equal(result.retained.erasureReceipts, 1);
  assert.equal(result.retained.ownerStateTombstones, 0);
  assert.equal(result.deleted.previewCacheRowsCleared, 1);
  assert.equal(result.deleted.modelCompositionDaysCleared, 1);
  assert.equal(await count(pool, schema, "preview_cache", "true"), 0);
  assert.equal(await count(pool, schema, "community_model_composition_days", "true"), 0);

  const replay = await retirePostgresAnalyticsOwner(options);
  assert.equal(replay.status, "complete");
  assert.equal(replay.sourceCount, 0);
  assert.equal(replay.retained.erasureReceipts, 1);
  assert.equal(replay.deleted.previewCacheRowsCleared, 0, "replay has no duplicate work");
}));

test("PG17 analytics owner retirement deletes the owner's analytics_v2 outputs and keeps published community heads", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => withHarness(async ({ pool, schema, retirePostgresAnalyticsOwner, hasPostgresAnalyticsOwnerResidue }) => {
  const runId = randomUUID();
  const day = "2026-09-20";
  const options = { primaryPool: pool, ownerDigest: OWNER, schema: { primarySchema: schema } };
  for (const owner of [OWNER, OTHER_OWNER]) {
    await pool.query(`INSERT INTO ${q(schema, "analytics_v2_owner_day")} (owner_digest,day,daily,refusal,run_id)
      VALUES ($1,$2,'{}'::jsonb,NULL,$3), ($1,DATE '2026-09-21',NULL,'source_conflict_or_order',$3)`,
    [owner, day, runId]);
    await pool.query(`INSERT INTO ${q(schema, "analytics_v2_cache_bands")}
      (owner_digest,day,model,effort,band,adjacencies,reused_more_than_half,matched_or_exceeded,
       unordered_ties,excluded_insufficient_evidence,excluded_context_contracted,sessions,run_id)
      VALUES ($1,$2,'synthetic-model','medium','under_one_minute',4,2,1,0,1,0,1,$3)`, [owner, day, runId]);
    await pool.query(`INSERT INTO ${q(schema, "analytics_v2_owner_fits")} (owner_digest,as_of_day,fits,run_id)
      VALUES ($1,$2,'[]'::jsonb,$3)`, [owner, day, runId]);
    await pool.query(`INSERT INTO ${q(schema, "analytics_v2_owner_model_dates")} (owner_digest,day,result,run_id)
      VALUES ($1,$2,'{}'::jsonb,$3)`, [owner, day, runId]);
  }
  const payload = JSON.stringify({ aggregateId: `community-daily:${day}:r1`, day, revision: 1,
    releasedAt: "2026-09-21T00:00:00.000Z" });
  await pool.query(`INSERT INTO ${q(schema, "analytics_v2_published_daily")}
    (day,revision,released_at,payload,payload_sha256,run_id) VALUES ($1,1,'2026-09-21T00:00:00Z',$2::jsonb,$3,$4)`,
  [day, payload, "1".repeat(64), runId]);
  await pool.query(`INSERT INTO ${q(schema, "analytics_v2_preview")} (id,preview,computed_at,run_id)
    VALUES (1,'{}'::jsonb,clock_timestamp(),$1)`, [runId]);
  const published = async () => (await pool.query(
    `SELECT day::text,revision,payload::text,payload_sha256 FROM ${q(schema, "analytics_v2_published_daily")}
      UNION ALL SELECT 'preview',id,preview::text,run_id::text FROM ${q(schema, "analytics_v2_preview")}
      ORDER BY 1`)).rows;
  const before = await published();
  assert.equal(before.length, 2);

  await createErasureReceipt(pool, schema);
  assert.equal(await hasPostgresAnalyticsOwnerResidue(options), true,
    "analytics_v2 owner rows are residue a re-erasure must retire");
  const result = await retirePostgresAnalyticsOwner(options);
  assert.equal(result.status, "complete");
  assert.equal(result.sourceCount, 0);
  assert.equal(result.deleted.analyticsV2OwnerDays, 2);
  assert.equal(result.deleted.analyticsV2CacheBands, 1);
  assert.equal(result.deleted.analyticsV2OwnerFits, 1);
  assert.equal(result.deleted.analyticsV2OwnerModelDates, 1);
  for (const name of ["analytics_v2_owner_day", "analytics_v2_cache_bands", "analytics_v2_owner_fits",
    "analytics_v2_owner_model_dates"]) {
    assert.equal(await count(pool, schema, name, "owner_digest=$1", [OWNER]), 0, `${name} keeps no retired-owner row`);
    assert.ok(await count(pool, schema, name, "owner_digest=$1", [OTHER_OWNER]) > 0, `${name} keeps other owners`);
  }
  assert.deepEqual(await published(), before, "published community heads and the preview are never retracted");
  assert.equal(await hasPostgresAnalyticsOwnerResidue(options), false);

  const replay = await retirePostgresAnalyticsOwner(options);
  assert.equal(replay.deleted.analyticsV2OwnerDays, 0, "replay has no duplicate work");
  assert.equal(replay.deleted.analyticsV2CacheBands, 0);
  assert.equal(replay.deleted.analyticsV2OwnerFits, 0);
  assert.equal(replay.deleted.analyticsV2OwnerModelDates, 0);
}));

test("PG17 analytics owner retirement removes mixed v1/v1.1/v1.2-derived state and retains only fenced proof", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => withHarness(async ({ pool, schema, retirePostgresAnalyticsOwner }) => {
  const day = "2026-09-20";
  const payloadDigest = "1".repeat(64);
  const createdAt = "2026-09-25T12:00:00Z";
  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (id,owner_kind,state,created_at)
     VALUES ('synthetic-mixed-owner','accountless','active',$1)`, [createdAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "storage_v11_owner_links")} (participant_id,owner_digest,state)
     VALUES ('synthetic-mixed-owner',$1,'active')`, [OWNER],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "storage_source_state")} (singleton,source_id,authority_epoch)
     VALUES (1,$1,2)`, [SOURCE_ID],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_source_cursors")} (source_id,sequence,authority_epoch)
     VALUES ($1,0,2)`, [SOURCE_ID],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_owner_state")} (source_id,owner_digest,revision,authority_epoch,state)
     VALUES ($1,$2,4,2,'active')`, [SOURCE_ID, OWNER],
  );

  // The shared owner-result contract is intentionally version-neutral. These
  // three namespace rows exercise retired v1, v1.1, and v1.2 inputs through
  // the same owner digest and source fence.
  for (const [index, namespace] of ["telemetry-v1", "telemetry-v1.1", "telemetry-v1.2"].entries()) {
    await pool.query(
      `INSERT INTO ${q(schema, "analytics_owner_results")} (
         source_id,source_namespace,observed_day,metric,owner_digest,input_revision,owner_revision,
         authority_epoch,public_authority_epoch,source_epoch,sequence,method,status,reason,payload_json,
         payload_sha256,computed_at_ms
       ) VALUES ($1,$2,$3,$4,$5,3,4,2,2,7,0,'synthetic','ready',NULL,'{}',$6,0)`,
      [SOURCE_ID, namespace, `2026-09-${String(20 + index).padStart(2, "0")}`,
        index === 1 ? "model" : "daily", OWNER, payloadDigest],
    );
  }

  await pool.query(
    `INSERT INTO ${q(schema, "analytics_prepared_source_heads")} (
       source_id,source_namespace,owner_digest,day,generation,input_revision,owner_revision,dependency_digest,
       method,authority_epoch,source_epoch,sequence,state,progress_revision,rows_written
     ) VALUES ($1,'telemetry-v1.2',$2,$3,'prepared-g1',3,4,$4,'synthetic',2,7,0,'ready',1,1)`,
    [SOURCE_ID, OWNER, day, payloadDigest],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_prepared_source_rows")} (
       source_id,owner_digest,observed_day,generation,occurrence_id,observed_at_ms,input_revision,payload_json,payload_sha256
     ) VALUES ($1,$2,$3,'prepared-g1','synthetic-occurrence',1,3,'{}',$4)`,
    [SOURCE_ID, OWNER, day, payloadDigest],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_prepared_source_streams")} (
       source_id,owner_digest,observed_day,generation,stream
     ) VALUES ($1,$2,$3,'prepared-g1','usage')`, [SOURCE_ID, OWNER, day],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_prepared_source_controls")} (
       source_id,owner_digest,observed_day,generation,stream,control_json,control_sha256
     ) VALUES ($1,$2,$3,'prepared-g1','usage','{}',$4)`, [SOURCE_ID, OWNER, day, payloadDigest],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_prepared_source_outputs")} (
       source_id,owner_digest,observed_day,generation,stream,output_kind,output_key,output_index,payload_json,payload_sha256
     ) VALUES ($1,$2,$3,'prepared-g1','usage','usage_price','synthetic',0,'{}',$4)`,
    [SOURCE_ID, OWNER, day, payloadDigest],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_analysis_work_heads")} (
       source_id,owner_digest,day,metric,identity_json,state,revision
     ) VALUES ($1,$2,$3,'fits','{}','pending',1)`, [SOURCE_ID, OWNER, day],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_analysis_work_parts")} (
       source_id,owner_digest,day,metric,generation,part_index,sha256,payload_json,control_json,manifest_json,complete
     ) VALUES ($1,$2,$3,'fits','work-g1',0,$4,'{}','{}','{}',true)`,
    [SOURCE_ID, OWNER, day, payloadDigest],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_scheduler_delivery_cursors")} (
       source_id,owner_digest,sequence,authority_epoch,last_attempt_at_ms
     ) VALUES ($1,$2,0,2,0)`, [SOURCE_ID, OWNER],
  );

  const affectedGroups = [
    { day: "2026-09-20", metric: "daily", generation: "pub-v1" },
    { day: "2026-09-21", metric: "model", generation: "pub-v11" },
    { day: "2026-09-22", metric: "graph", generation: "pub-v12" },
  ];
  for (const group of affectedGroups) {
    await pool.query(
      `INSERT INTO ${q(schema, "analytics_publication_owner_members")} (source_id,day,metric,generation,owner_digest)
       VALUES ($1,$2,$3,$4,$5)`, [SOURCE_ID, group.day, group.metric, group.generation, OWNER],
    );
    await pool.query(
      `INSERT INTO ${q(schema, "analytics_publications")} (
         source_id,day,metric,generation,cohort_digest,authority_json,payload_json,payload_sha256,
         computed_at_ms,policy_revision,collection_revision
       ) VALUES ($1,$2,$3,$4,$5,'{}','{}',$6,1,1,1)`,
      [SOURCE_ID, group.day, group.metric, group.generation, payloadDigest, payloadDigest],
    );
    await pool.query(
      `INSERT INTO ${q(schema, "analytics_publication_captures")} (
         source_id,day,metric,generation,cohort_digest,expected_members,payload_json,policy_revision,collection_revision
       ) VALUES ($1,$2,$3,$4,$5,1,'{}',1,1)`,
      [SOURCE_ID, group.day, group.metric, group.generation, payloadDigest],
    );
  }
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_publication_owner_members")} (source_id,day,metric,generation,owner_digest)
     VALUES ($1,'2026-09-20','daily','pub-v1',$2),($1,'2026-09-23','model','unaffected',$2)`,
    [SOURCE_ID, OTHER_OWNER],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_publications")} (
       source_id,day,metric,generation,cohort_digest,authority_json,payload_json,payload_sha256,
       computed_at_ms,policy_revision,collection_revision
     ) VALUES ($1,'2026-09-23','model','unaffected',$2,'{}','{}',$2,1,1,1)`,
    [SOURCE_ID, payloadDigest],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_publication_captures")} (
       source_id,day,metric,generation,cohort_digest,expected_members,payload_json,policy_revision,collection_revision
     ) VALUES ($1,'2026-09-23','model','unaffected',$2,1,'{}',1,1)`, [SOURCE_ID, payloadDigest],
  );

  await pool.query(
    `INSERT INTO ${q(schema, "community_daily_aggregates")} (
       source_id,source_namespace,day,revision,payload_json,payload_sha256,source_authority_epoch,
       source_cursor_sequence,policy_revision,collection_revision,release_state,released_at
     ) VALUES ($1,'telemetry-v1.2',$2,1,'{}',$3,2,0,1,1,'published',$4)`,
    [SOURCE_ID, day, payloadDigest, createdAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "community_daily_allowance_publication_state")} (
       source_id,source_namespace,publication_state,expected_basis,attribution_method_version,
       safe_from_day,safe_to_day,source_authority_epoch,source_cursor_sequence,policy_revision,
       collection_revision,updated_at
     ) VALUES ($1,'telemetry-v1.2','ready','synthetic','method-v1',$2,$2,2,0,1,1,$3)`,
    [SOURCE_ID, day, createdAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "community_daily_allowance_preview_cache")} (
       source_id,source_namespace,generated_at,payload_json,payload_sha256,attribution_method_version,
       source_authority_epoch,source_cursor_sequence,policy_revision,collection_revision
     ) VALUES ($1,'telemetry-v1.2',$2,'{}',$3,'method-v1',2,0,1,1)`,
    [SOURCE_ID, createdAt, payloadDigest],
  );
  await pool.query(`INSERT INTO ${q(schema, "analytics_admin_metric_snapshots")} (source_id,captured_at,metrics_json)
    VALUES ($1,$2,'{}')`, [SOURCE_ID, createdAt]);
  await pool.query(`INSERT INTO ${q(schema, "analytics_admin_metrics_history_cache")}
    (source_id,source_epoch,generated_at,payload_json) VALUES ($1,7,$2,'{}')`, [SOURCE_ID, createdAt]);
  await pool.query(`INSERT INTO ${q(schema, "analytics_admin_allowance_preview_cache")}
    (source_id,source_epoch,generated_at,payload_json) VALUES ($1,7,$2,'{}')`, [SOURCE_ID, createdAt]);
  await pool.query(`INSERT INTO ${q(schema, "analytics_admin_progress_cache")}
    (source_id,source_epoch,generated_at,payload_json) VALUES ($1,7,$2,'{}')`, [SOURCE_ID, createdAt]);
  await pool.query(`INSERT INTO ${q(schema, "preview_cache")} (id,payload) VALUES ('synthetic-mixed-cache','{}'::jsonb)`);
  await pool.query(`INSERT INTO ${q(schema, "community_model_composition_days")} (day,payload_json,computed_at)
    VALUES (DATE '2026-09-20','{}',$1)`, [createdAt]);

  await pool.query(
    `INSERT INTO ${q(schema, "storage_ingestion_changes")} (
       source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms,
       event_tuple_version,revision,object_digest,content_digest,public_authority_epoch
     ) VALUES ($1,1,$2,$3,4,2,'owner-erased',100,1,1,$4,$5,2)`,
    [SOURCE_ID, EVENT_DIGEST, OWNER, OBJECT_DIGEST, CONTENT_DIGEST],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_applied_events")} (
       source_id,sequence,event_digest,owner_digest,authority_epoch,projection_json,event_tuple_version,
       revision,kind,object_digest,content_digest,public_authority_epoch,recorded_ms
     ) VALUES ($1,1,$2,$3,2,NULL,1,1,'owner-erased',$4,$5,2,100)`,
    [SOURCE_ID, EVENT_DIGEST, OWNER, OBJECT_DIGEST, CONTENT_DIGEST],
  );
  await pool.query(`UPDATE ${q(schema, "analytics_source_cursors")}
    SET sequence=1 WHERE source_id=$1`, [SOURCE_ID]);
  await pool.query(`DELETE FROM ${q(schema, "participants")} WHERE id='synthetic-mixed-owner'`);

  const options = { primaryPool: pool, ownerDigest: OWNER, schema: { primarySchema: schema } };
  const result = await retirePostgresAnalyticsOwner(options);
  assert.equal(result.status, "complete");
  assert.equal(result.sourceCount, 1);
  assert.equal(result.deleted.analysisWorkParts, 1);
  assert.equal(result.deleted.analysisWorkHeads, 1);
  assert.equal(result.deleted.preparedOutputs, 1);
  assert.equal(result.deleted.preparedControls, 1);
  assert.equal(result.deleted.preparedStreams, 1);
  assert.equal(result.deleted.preparedRows, 1);
  assert.equal(result.deleted.preparedHeads, 1);
  assert.equal(result.deleted.ownerResults, 3, "all three versioned source namespaces retire together");
  assert.equal(result.deleted.deliveryCursors, 1);
  assert.equal(result.deleted.publications, 3);
  assert.equal(result.deleted.publicationCaptures, 3);
  assert.equal(result.deleted.publicationMembers, 4, "target cohort siblings are removed with their invalidated generation");
  assert.equal(result.deleted.dailyRevisionsWithdrawn, 0, "terminal journal insertion had already withdrawn this immutable row");
  assert.equal(result.retained.erasureReceipts, 1);
  assert.equal(result.retained.ownerStateTombstones, 1);
  assert.equal(result.retained.sourceJournalRows, 1);
  assert.equal(result.retained.appliedEventReceipts, 1);
  assert.equal(result.retained.sourceCursors, 1);
  assert.equal(result.retained.publicationInvalidations, 3);
  assert.equal(result.retained.withdrawnDailyRevisions, 1);

  for (const tableName of [
    "analytics_analysis_work_heads", "analytics_analysis_work_parts", "analytics_owner_results",
    "analytics_prepared_source_controls", "analytics_prepared_source_heads", "analytics_prepared_source_outputs",
    "analytics_prepared_source_rows", "analytics_prepared_source_streams", "analytics_scheduler_delivery_cursors",
    "analytics_publication_owner_members", "storage_v11_event_sources", "typed_v1_event_sources",
    "telemetry_usage_correction_history",
  ]) {
    const where = tableName === "telemetry_usage_correction_history"
      ? "encode(owner_digest,'hex')=$1" : "owner_digest=$1";
    assert.equal(await count(pool, schema, tableName, where, [OWNER]), 0, `${tableName} has no owner residue`);
  }
  assert.equal(await count(pool, schema, "analytics_owner_state", "owner_digest=$1 AND state='erased'", [OWNER]), 1);
  assert.equal(await count(pool, schema, "analytics_applied_events", "owner_digest=$1", [OWNER]), 1);
  assert.equal(await count(pool, schema, "storage_ingestion_changes", "owner_digest=$1", [OWNER]), 1);
  assert.equal(await count(pool, schema, "analytics_publication_owner_members", "owner_digest=$1", [OTHER_OWNER]), 1,
    "an unaffected generation remains intact");
  assert.equal(await count(pool, schema, "community_daily_aggregates", "source_id=$1 AND release_state='withdrawn'", [SOURCE_ID]), 1,
    "the immutable aggregate is withdrawn and retained");
  assert.equal(await count(pool, schema, "community_daily_allowance_publication_state",
    "source_id=$1 AND publication_state='updating'", [SOURCE_ID]), 1);
  assert.equal(await count(pool, schema, "analytics_admin_metric_snapshots", "source_id=$1", [SOURCE_ID]), 1,
    "aggregate admin gauge history has no owner digest and is retained");
  assert.equal(await count(pool, schema, "analytics_admin_metrics_history_cache", "source_id=$1", [SOURCE_ID]), 0);
  assert.equal(await count(pool, schema, "analytics_admin_allowance_preview_cache", "source_id=$1", [SOURCE_ID]), 0);
  assert.equal(await count(pool, schema, "analytics_admin_progress_cache", "source_id=$1", [SOURCE_ID]), 0);
  assert.equal(await count(pool, schema, "community_daily_allowance_preview_cache", "source_id=$1", [SOURCE_ID]), 0);
  assert.equal(await count(pool, schema, "preview_cache", "true"), 0);
  assert.equal(await count(pool, schema, "community_model_composition_days", "true"), 0);

  const replay = await retirePostgresAnalyticsOwner(options);
  assert.equal(replay.status, "complete");
  assert.equal(replay.sourceCount, 1, "retained event proof continues to identify the source on replay");
  assert.equal(replay.deleted.ownerResults, 0);
  assert.equal(replay.deleted.publicationMembers, 0);
  assert.equal(replay.retained.ownerStateTombstones, 1);
  assert.equal(replay.retained.withdrawnDailyRevisions, 1);
}));

test("PG17 analytics owner retirement refuses live, mid-erasure, and multi-source owners without partial cleanup", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => withHarness(async ({ pool, schema, retirePostgresAnalyticsOwner, PostgresAnalyticsOwnerRetirementError }) => {
  const options = { primaryPool: pool, ownerDigest: OWNER, schema: { primarySchema: schema } };
  const rejectsWith = (code) => assert.rejects(retirePostgresAnalyticsOwner(options), (error) =>
    error instanceof PostgresAnalyticsOwnerRetirementError && error.code === code);
  const insertOwnerState = (sourceId) => pool.query(
    `INSERT INTO ${q(schema, "analytics_owner_state")} (source_id,owner_digest,revision,authority_epoch,state)
     VALUES ($1,$2,1,2,'active')`, [sourceId, OWNER],
  );
  const insertOwnerResult = (sourceId) => pool.query(
    `INSERT INTO ${q(schema, "analytics_owner_results")} (
       source_id,source_namespace,observed_day,metric,owner_digest,input_revision,owner_revision,
       authority_epoch,public_authority_epoch,source_epoch,sequence,method,status,payload_json,
       payload_sha256,computed_at_ms
     ) VALUES ($1,'telemetry-v1.2','2026-09-20','daily',$2,1,1,2,2,1,0,'synthetic','ready','{}',$3,0)`,
    [sourceId, OWNER, OTHER_DIGEST],
  );
  const assertUntouched = async (message) => {
    assert.equal(await count(pool, schema, "preview_cache", "id='gate-cache'"), 1, message);
    assert.equal(await count(pool, schema, "analytics_owner_state",
      "owner_digest=$1 AND source_id=$2 AND state='active'", [OWNER, SOURCE_ID]), 1, message);
    assert.equal(await count(pool, schema, "analytics_owner_results", "owner_digest=$1 AND source_id=$2",
      [OWNER, SOURCE_ID]), 1, message);
  };

  const participantId = `synthetic-gated-owner:${randomUUID()}`;
  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (id,owner_kind,state,created_at)
     VALUES ($1,'accountless','active',clock_timestamp())`, [participantId],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "storage_v11_owner_links")} (participant_id,owner_digest,state)
     VALUES ($1,$2,'active')`, [participantId, OWNER],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "storage_source_state")} (singleton,source_id,authority_epoch) VALUES (1,$1,2)`, [SOURCE_ID],
  );
  await insertOwnerState(SOURCE_ID);
  await insertOwnerResult(SOURCE_ID);
  await pool.query(`INSERT INTO ${q(schema, "preview_cache")} (id,payload) VALUES ('gate-cache','{}'::jsonb)`);

  await rejectsWith("ANALYTICS_OWNER_RETIREMENT_ERASURE_PROOF_MISSING");
  await assertUntouched("a live participant without an erasure receipt is never retired");

  await pool.query(`UPDATE ${q(schema, "storage_v11_owner_links")} SET state='erased' WHERE participant_id=$1`,
    [participantId]);
  assert.equal(await count(pool, schema, "storage_owner_erasure_receipts", "owner_digest=$1", [OWNER]), 1);
  await rejectsWith("ANALYTICS_OWNER_RETIREMENT_PARTICIPANT_REMAINS");
  await assertUntouched("a receipt alone does not authorize retirement while the owner link remains");

  await pool.query(`DELETE FROM ${q(schema, "participants")} WHERE id=$1`, [participantId]);
  await insertOwnerState("retired-source-v0");
  await insertOwnerResult("retired-source-v0");
  await rejectsWith("ANALYTICS_OWNER_RETIREMENT_SOURCE_MISMATCH");
  await assertUntouched("owner rows outside the canonical source block retirement");
  assert.equal(await count(pool, schema, "analytics_owner_results", "owner_digest=$1 AND source_id='retired-source-v0'",
    [OWNER]), 1);

  await pool.query(`DELETE FROM ${q(schema, "analytics_owner_results")} WHERE source_id='retired-source-v0'`);
  await pool.query(`DELETE FROM ${q(schema, "analytics_owner_state")} WHERE source_id='retired-source-v0'`);
  const result = await retirePostgresAnalyticsOwner(options);
  assert.equal(result.status, "complete");
  assert.equal(result.sourceCount, 1);
  assert.equal(result.deleted.ownerResults, 1);
  assert.equal(result.retained.ownerStateTombstones, 1);
  assert.equal(await count(pool, schema, "analytics_owner_results", "owner_digest=$1", [OWNER]), 0);
}));

test("PG17 analytics owner retirement fails closed on unknown owner families and stale journals", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => withHarness(async ({ pool, schema, retirePostgresAnalyticsOwner, PostgresAnalyticsOwnerRetirementError }) => {
  await createErasureReceipt(pool, schema);
  await pool.query(`INSERT INTO ${q(schema, "preview_cache")} (id,payload) VALUES ('preflight-cache','{}'::jsonb)`);
  await pool.query(`CREATE TABLE ${q(schema, "future_owner_family")} (owner_digest text NOT NULL)`);
  await pool.query(`INSERT INTO ${q(schema, "future_owner_family")} (owner_digest) VALUES ($1)`, [OWNER]);
  const options = { primaryPool: pool, ownerDigest: OWNER, schema: { primarySchema: schema } };
  await assert.rejects(retirePostgresAnalyticsOwner(options), (error) =>
    error instanceof PostgresAnalyticsOwnerRetirementError
      && error.code === "ANALYTICS_OWNER_RETIREMENT_FAMILY_UNSUPPORTED");
  assert.equal(await count(pool, schema, "preview_cache", "id='preflight-cache'"), 1,
    "unknown-family refusal makes no partial cleanup");
  await pool.query(`DROP TABLE ${q(schema, "future_owner_family")}`);

  await pool.query(
    `INSERT INTO ${q(schema, "storage_source_state")} (singleton,source_id,authority_epoch) VALUES (1,$1,2)`, [SOURCE_ID],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_owner_state")} (source_id,owner_digest,revision,authority_epoch,state)
     VALUES ($1,$2,1,2,'active')`, [SOURCE_ID, OWNER],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "analytics_owner_results")} (
       source_id,source_namespace,observed_day,metric,owner_digest,input_revision,owner_revision,
       authority_epoch,public_authority_epoch,source_epoch,sequence,method,status,payload_json,
       payload_sha256,computed_at_ms
     ) VALUES ($1,'telemetry-v1.2','2026-09-20','daily',$2,1,1,2,2,1,0,'synthetic','ready','{}',$3,0)`,
    [SOURCE_ID, OWNER, OTHER_DIGEST],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "storage_ingestion_changes")} (
       source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms
     ) VALUES ($1,1,$2,$3,1,2,'source-updated',100)`,
    [SOURCE_ID, EVENT_DIGEST, OWNER],
  );
  await assert.rejects(retirePostgresAnalyticsOwner(options), (error) =>
    error instanceof PostgresAnalyticsOwnerRetirementError
      && error.code === "ANALYTICS_OWNER_RETIREMENT_JOURNAL_NOT_CAUGHT_UP");
  assert.equal(await count(pool, schema, "analytics_owner_state", "owner_digest=$1 AND state='active'", [OWNER]), 1);
  assert.equal(await count(pool, schema, "analytics_owner_results", "owner_digest=$1", [OWNER]), 1,
    "an unapplied journal sequence blocks deletion without changing owner state or results");
  assert.equal(await count(pool, schema, "preview_cache", "id='preflight-cache'"), 1);
}));
