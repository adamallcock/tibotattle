// PostgreSQL 17, fully migrated isolated schema, synthetic aggregate evidence.
// Active execution is deliberately not inferred from an uncommitted run.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { defaultAnalyticsV2FixtureStamps, postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import { VENDORED_PACKAGE_ENTRIES, usesVendoredPackages } from "../vitest.analytics-v2.config.mjs";
import { projectAdminReconstructionProgress } from "../../web/public/admin-client.js";

const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "set PG_TEST_SOCKET to a disposable local PostgreSQL 17" : false;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-10-11T07:30:00.000Z");
const SOURCE = "synthetic-admin-progress";
const NAMESPACE = "00000000-0000-4000-8000-0000000000ad";
const RUN = "00000000-0000-4000-8000-000000000001";
const OWNER = "b".repeat(64);
const PARTICIPANT = "participant:00000000-0000-4000-8000-000000000001";
const DEVICE = "device:00000000-0000-4000-8000-000000000001";
const ENV = Object.freeze({ ENVIRONMENT: "production", ENROLLMENT_MODE: "open",
  ACCOUNT_SCOPED_INGEST_MODE: "disabled", TELEMETRY_STORAGE_MODE: "typed", TELEMETRY_STORAGE_NAMESPACE: NAMESPACE });
const schema = `admin_progress_${randomBytes(5).toString("hex")}`;
const q = table => `"${schema}"."${table}"`;
let pool, vite, reader, overview, adminConsole;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ ...endpoint, max: 4 });
  assert.match((await pool.query("SHOW server_version")).rows[0].server_version, /^17\./u);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await applyPostgresMigrations({ role: "primary", schema, pool });
  await defaultAnalyticsV2FixtureStamps(pool, schema);
  vite = await createServer({ root: ROOT, configFile: false, server: { middlewareMode: true },
    appType: "custom", logLevel: "silent", resolve: { mainFields: ["module", "main"] },
    ssr: { noExternal: ["jsonc-parser"] }, plugins: [{ name: "progress-vendor", enforce: "pre",
      resolveId(source, importer) { return usesVendoredPackages(importer) ? VENDORED_PACKAGE_ENTRIES[source] : null; } }] });
  reader = (await vite.ssrLoadModule("/src/postgres-admin-reconstruction-progress.ts")).readPostgresAdminReconstructionProgress;
  overview = (await vite.ssrLoadModule("/src/postgres-admin-overview.ts")).readPostgresAdminOverview;
  adminConsole = await vite.ssrLoadModule("/cloud-run/routes/admin-console.mjs");
});

after(async () => {
  await vite?.close();
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

async function fixture(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await work(client);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

const insert = (client, table, fields) => {
  const keys = Object.keys(fields);
  assert.ok(keys.every(key => /^[a-z_][a-z0-9_]{0,62}$/u.test(key)));
  return client.query(`INSERT INTO ${q(table)} (${keys.map(key => `"${key}"`).join(",")})
    VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")})`, Object.values(fields));
};

beforeEach(async () => {
  if (skip) return;
  await fixture(async client => {
    await client.query(`TRUNCATE ${["analytics_v2_runs", "analytics_v2_preview", "analytics_v2_published_daily",
      "analytics_v2_journal_cursor", "storage_ingestion_changes", "telemetry_v12_domain_predecessors",
      "telemetry_v12_domain_heads", "telemetry_v12_domain_days", "telemetry_v1_chunks", "telemetry_v11_domains",
      "storage_v12_event_sources"].map(q).join(",")} CASCADE`);
    await client.query(`DELETE FROM ${q("storage_source_state")}`);
    await insert(client, "storage_source_state", { singleton: 1, source_id: SOURCE, authority_epoch: 0 });
    for (const table of ["typed_v1_admission_state", "typed_v11_admission_state"]) {
      await client.query(`DELETE FROM ${q(table)}`);
      await insert(client, table, { id: 1, source_namespace: NAMESPACE, namespace_id: 1,
        runtime_contract_version: 1, next_source_row_id: 1 });
    }
  });
});

const read = (options = {}) => reader({ pool, schema, nowEpoch: NOW, ...options });
const event = (client, sequence, kind = "source-updated", source = SOURCE) => insert(client, "storage_ingestion_changes", {
  source_id: source, sequence, event_digest: sequence.toString(16).padStart(64, "0"), owner_digest: OWNER,
  owner_revision: sequence, authority_epoch: 1, kind, recorded_ms: NOW - 600_000,
});
const cursor = (client, sequence) => insert(client, "analytics_v2_journal_cursor", { id: 1, last_sequence: sequence, run_id: RUN });
const run = (client, state = "complete", runId = RUN, finish = "2026-10-11T07:00:00.000Z") => insert(client, "analytics_v2_runs", {
  run_id: runId, started_at: "2026-10-11T03:00:00.000Z", finished_at: finish, mode: "full", state,
  owners: 2, owner_days: 4, refusals: "[]", publication: '{"published":[],"unchanged":[],"blocked":[]}', timings: "{}",
});
const published = (client, day = "2026-10-10") => insert(client, "analytics_v2_published_daily", {
  day, revision: 1, released_at: "2026-10-11T07:00:00.000Z", run_id: RUN, payload_sha256: "7".repeat(64),
  payload: JSON.stringify({ day, revision: 1, aggregateId: `community-daily:${day}:r1`, synthetic: true }),
});

test("empty or absent cursor stays unknown while empty publication counts are observed", { skip }, async () => {
  const body = await read();
  assert.deepEqual(projectAdminReconstructionProgress(body), body);
  assert.equal(body.pipeline.ingestion.journalHead, null);
  assert.equal(body.pipeline.delivery.appliedSequence, null);
  assert.equal(body.pipeline.delivery.pendingChanges, null);
  assert.equal(body.pipeline.daily.queuedDays, null);
  assert.equal(body.work.lastRun, null);
  assert.equal(body.work.currentState, "unavailable");
  assert.equal(body.work.scheduleState, "unavailable");
  assert.deepEqual(body.graph, { status: "unavailable" });
  assert.deepEqual(body.history, { status: "unavailable" });
  assert.equal(body.publication.publishedDays, 0);
  assert.equal(body.publication.preview.state, "not_recorded");
});

test("normal refresh returns only recorded counts, timestamps and kernel attribution", { skip }, async () => {
  await fixture(async client => {
    await event(client, 1); await cursor(client, 1); await run(client); await published(client);
    await insert(client, "analytics_v2_preview", { id: 1, preview: "{}", computed_at: "2026-10-11T07:00:00.000Z", run_id: RUN });
  });
  const body = await read();
  assert.deepEqual(projectAdminReconstructionProgress(body), body);
  assert.deepEqual(body.work.lastRun, { state: "complete", startedAt: "2026-10-11T03:00:00.000Z",
    finishedAt: "2026-10-11T07:00:00.000Z", kernelId: 1, owners: 2, ownerDays: 4 });
  assert.equal(body.pipeline.delivery.pendingChanges, 0);
  assert.equal(body.pipeline.daily.queuedDays, 0);
  assert.equal(body.pipeline.daily.releasedLastHour, 1);
  assert.equal(body.publication.publishedDays, 1);
  assert.equal(body.publication.preview.state, "recorded");
  assert.equal(body.work.nextScheduledAt, "2026-10-12T03:00:00.000Z");
  for (const [nowEpoch, next] of [["2026-10-11T02:59:59.000Z", "2026-10-11T03:00:00.000Z"],
    ["2026-10-11T03:00:00.000Z", "2026-10-12T03:00:00.000Z"]]) {
    assert.equal((await read({ nowEpoch: Date.parse(nowEpoch) })).work.nextScheduledAt, next);
  }
  assert.doesNotMatch(JSON.stringify(body), /synthetic-admin-progress|participant:|device:|run_id|owner_digest|publication.*synthetic/u);
});

test("journal head uses numeric sequence ordering across digit boundaries and preserves queue parity", { skip }, async () => {
  await fixture(async client => {
    for (const sequence of [9, 10, 99, 100, 9_999, 10_000, 10_001]) await event(client, sequence);
    await cursor(client, 10_000);
    await client.query(`UPDATE ${q("storage_ingestion_changes")} SET recorded_ms=$1 WHERE sequence=10001`, [NOW - 60_000]);
    const id = "chunk:00000000-0000-4000-8000-000000010001";
    await insert(client, "telemetry_v1_chunks", { id, participant_id: PARTICIPANT, device_id: DEVICE,
      stream: "usage", chunk_day: "2026-10-10", chunk_seq: 1, revision: 1,
      chunk_digest: "a".repeat(64), envelope_digest: "c".repeat(64), parser_version: "synthetic",
      record_count: 1, accepted_record_count: 1, r2_key: "synthetic/digit-boundary",
      device_upload_authorization_id: "synthetic-digit-boundary", created_at: "2026-10-11T07:00:00.000Z" });
    await insert(client, "typed_v1_event_sources", { event_digest: (10_001).toString(16).padStart(64, "0"),
      owner_digest: OWNER, participant_id: PARTICIPANT, chunk_id: id, source_namespace: NAMESPACE });
  });
  const body = await read();
  assert.deepEqual(projectAdminReconstructionProgress(body), body);
  assert.equal(body.pipeline.ingestion.journalHead, 10_001);
  assert.equal(body.pipeline.ingestion.latestRecordedAt, new Date(NOW - 60_000).toISOString());
  assert.equal(body.pipeline.delivery.appliedSequence, 10_000);
  assert.equal(body.pipeline.delivery.pendingChanges, 1);
  assert.equal(body.pipeline.daily.queuedDays, 1);
  assert.equal(body.pipeline.daily.oldestQueuedDay, "2026-10-10");
  assert.equal(body.pipeline.daily.newestQueuedDay, "2026-10-10");
  const summary = await overview({ pool, schema, env: ENV, nowEpoch: NOW });
  assert.equal(body.pipeline.daily.queuedDays, summary.dailyPublication.pendingRebuilds);
});

test("an in-progress uncommitted refresh cannot become a guessed running or idle state", { skip }, async () => {
  await fixture(async client => { await run(client); await event(client, 1); await cursor(client, 1); });
  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    await run(writer, "complete", "00000000-0000-4000-8000-000000000002", "2026-10-11T07:20:00.000Z");
    const during = await read();
    assert.equal(during.work.lastRun.finishedAt, "2026-10-11T07:00:00.000Z");
    assert.equal(during.work.currentState, "unavailable");
    await writer.query("COMMIT");
    const after = await read();
    assert.equal(after.work.lastRun.finishedAt, "2026-10-11T07:20:00.000Z");
    assert.equal(after.work.currentState, "unavailable");
  } finally { await writer.query("ROLLBACK"); writer.release(); }
});

test("a recorded failed last run is distinct from an available published graph", { skip }, async () => {
  await fixture(async client => { await run(client, "failed"); await published(client);
    await insert(client, "analytics_v2_preview", { id: 1, preview: null, computed_at: "2026-10-11T07:00:00.000Z", run_id: RUN }); });
  const body = await read();
  assert.equal(body.work.lastRun.state, "failed");
  assert.equal(body.publication.publishedDays, 1);
  assert.equal(body.publication.preview.state, "unavailable");
  assert.deepEqual(projectAdminReconstructionProgress(body), body);
});

test("queued v1/v1.1/v1.2 days, replacements, terminals and source scoping match overview", { skip }, async () => {
  await fixture(async client => {
    await cursor(client, 1);
    for (let sequence = 1; sequence <= 5; sequence += 1) await event(client, sequence,
      sequence === 4 ? "owner-active" : sequence === 5 ? "owner-erased" : "source-updated");
    await event(client, 99, "source-updated", "synthetic-other-source");
    for (const sequence of [1, 2, 5]) {
      const id = `chunk:00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
      await insert(client, "telemetry_v1_chunks", { id, participant_id: PARTICIPANT, device_id: DEVICE,
        stream: "usage", chunk_day: `2026-10-${sequence === 1 ? "08" : sequence === 2 ? "09" : "11"}`, chunk_seq: sequence,
        revision: 1, chunk_digest: "a".repeat(64), envelope_digest: String(sequence).repeat(64), parser_version: "synthetic",
        record_count: 1, accepted_record_count: 1, r2_key: `synthetic/${sequence}`, device_upload_authorization_id: `synthetic-${sequence}`,
        created_at: "2026-10-11T07:00:00.000Z" });
      await insert(client, "typed_v1_event_sources", { event_digest: sequence.toString(16).padStart(64, "0"),
        owner_digest: OWNER, participant_id: PARTICIPANT, chunk_id: id, source_namespace: NAMESPACE });
    }
    const old = "00000000-0000-4000-8000-000000001101", current = "00000000-0000-4000-8000-000000001102";
    await insert(client, "telemetry_v11_domains", { id: current, participant_id: PARTICIPANT, device_id: DEVICE,
      predecessor_token_hash: "e".repeat(64), previous_generation_id: old, manifest_digest: "f".repeat(64),
      legacy_fingerprint: "a".repeat(64), input_revision: 1, from_day: "2026-10-07", through_day: "2026-10-07",
      days_json: '["2026-10-07"]', created_at: "2026-10-11T07:00:00.000Z" });
    for (const [generation_id, observed_day] of [[old, "2026-10-06"], [current, "2026-10-07"]]) {
      await insert(client, "telemetry_v11_domain_days", { generation_id, observed_day, manifest_id: `synthetic-${observed_day}` });
    }
    await insert(client, "storage_v11_event_sources", { event_digest: "3".padStart(64, "0"), owner_digest: OWNER,
      participant_id: PARTICIPANT, device_id: DEVICE, generation_id: current, manifest_digest: "f".repeat(64),
      from_day: "2026-10-07", through_day: "2026-10-07", head_revision: 2, input_revision: 1, recorded_ms: NOW - 600_000 });
    for (const [generation_id, observed_day, digest] of [["v12-old", "2026-10-05", "a"], ["v12-new", "2026-10-05", "a"],
      ["v12-old", "2026-10-08", "b"], ["v12-new", "2026-10-10", "c"]]) {
      await insert(client, "telemetry_v12_domain_days", { generation_id, observed_day,
        manifest_id: `synthetic-${generation_id}-${observed_day}`, manifest_digest: digest.repeat(64) });
    }
    await insert(client, "telemetry_v12_domain_heads", { participant_id: PARTICIPANT,
      generation_id: "v12-new", revision: 2, updated_at: "2026-10-11T07:00:00.000Z" });
    await insert(client, "storage_v12_event_sources", { event_digest: "4".padStart(64, "0"), owner_digest: OWNER,
      participant_id: PARTICIPANT, device_id: DEVICE, generation_id: "v12-new", previous_generation_id: "v12-old",
      manifest_digest: "c".repeat(64), head_revision: 2, recorded_ms: NOW - 600_000 });
    for (const [token, consumed, expires] of [["a", null, "2026-10-12T00:00:00.000Z"],
      ["b", "2026-10-11T07:00:00.000Z", "2026-10-12T00:00:00.000Z"], ["c", null, "2026-10-10T00:00:00.000Z"]]) {
      await insert(client, "telemetry_v12_domain_predecessors", { token_hash: token.repeat(64), participant_id: PARTICIPANT,
        device_id: DEVICE, legacy_fingerprint: "a".repeat(64), input_revision: 1, from_day: "2026-10-07", through_day: "2026-10-10",
        winners_json: "[]", created_at: "2026-10-09T00:00:00.000Z", expires_at: expires, consumed_at: consumed });
    }
  });
  const body = await read();
  assert.deepEqual(projectAdminReconstructionProgress(body), body);
  assert.equal(body.pipeline.ingestion.journalHead, 5);
  assert.equal(body.pipeline.ingestion.v12Heads, 1);
  assert.equal(body.pipeline.ingestion.v12Days, 4);
  assert.equal(body.pipeline.ingestion.pendingActivations, 1);
  assert.equal(body.pipeline.delivery.pendingChanges, 4);
  assert.equal(body.pipeline.delivery.pendingOwnerActivations, 1);
  assert.equal(body.pipeline.daily.queuedDays, 5);
  assert.equal(body.pipeline.daily.oldestQueuedDay, "2026-10-06");
  assert.equal(body.pipeline.daily.newestQueuedDay, "2026-10-10");
  const summary = await overview({ pool, schema, env: ENV, nowEpoch: NOW });
  assert.equal(body.pipeline.daily.queuedDays, summary.dailyPublication.pendingRebuilds);
});

test("a cursor ahead of the journal stays explicitly unknown", { skip }, async () => {
  await fixture(async client => { await event(client, 1); await cursor(client, 99); });
  const body = await read();
  assert.equal(body.pipeline.ingestion.journalHead, 1);
  assert.equal(body.pipeline.delivery.appliedSequence, null);
  assert.equal(body.pipeline.delivery.pendingChanges, null);
  assert.equal(body.pipeline.daily.queuedDays, null);
  assert.deepEqual(projectAdminReconstructionProgress(body), body);
});

test("an unsafe bigint cursor stays unknown", { skip }, async () => {
  await fixture(async client => { await event(client, 1); await cursor(client, "9007199254740992"); });
  const body = await read();
  assert.equal(body.pipeline.delivery.appliedSequence, null);
  assert.equal(body.pipeline.daily.queuedDays, null);
});

test("a concurrent atomic publication cannot mix cursor, journal and published heads", { skip }, async () => {
  await fixture(async client => { await event(client, 1); await cursor(client, 1); await published(client); });
  let advanced = false;
  const interleaved = { async connect() {
    const client = await pool.connect();
    return { release: discard => client.release(discard), async query(sql, values) {
      const result = await client.query(sql, values);
      if (!advanced && sql.includes("AS sources")) {
        advanced = true;
        await fixture(async writer => {
          await event(writer, 2);
          await writer.query(`UPDATE ${q("analytics_v2_journal_cursor")} SET last_sequence=2`);
          await published(writer, "2026-10-09");
        });
      }
      return result;
    } };
  } };
  const snapshot = await read({ pool: interleaved });
  assert.equal(snapshot.pipeline.ingestion.journalHead, 1);
  assert.equal(snapshot.pipeline.delivery.appliedSequence, 1);
  assert.equal(snapshot.publication.publishedDays, 1);
  const next = await read();
  assert.equal(next.pipeline.ingestion.journalHead, 2);
  assert.equal(next.pipeline.delivery.appliedSequence, 2);
  assert.equal(next.publication.publishedDays, 2);
});

test("a queued-day cap makes the count and range unavailable", { skip }, async () => {
  await fixture(async client => {
    await cursor(client, 0); await event(client, 1);
    await insert(client, "storage_v12_event_sources", { event_digest: "1".padStart(64, "0"), owner_digest: OWNER,
      participant_id: PARTICIPANT, device_id: DEVICE, generation_id: "synthetic-wide-window", previous_generation_id: null,
      manifest_digest: "c".repeat(64), head_revision: 1, recorded_ms: NOW });
    await client.query(`INSERT INTO ${q("telemetry_v12_domain_days")} (generation_id, observed_day, manifest_id, manifest_digest)
      SELECT 'synthetic-wide-window', DATE '1990-01-01'+n, 'synthetic-'||n, repeat('a',64) FROM generate_series(1,10001) n`);
  });
  const body = await read();
  assert.equal(body.pipeline.delivery.pendingChanges, 1);
  assert.equal(body.pipeline.daily.queuedDays, null);
  assert.equal(body.pipeline.daily.oldestQueuedDay, null);
  assert.equal(body.pipeline.daily.newestQueuedDay, null);
  assert.deepEqual(projectAdminReconstructionProgress(body), body);
});

test("bounded backlog totals are unavailable rather than capped counts", { skip }, async () => {
  await fixture(async client => {
    await cursor(client, 0);
    await client.query(`INSERT INTO ${q("storage_ingestion_changes")}
      (source_id, sequence, event_digest, owner_digest, owner_revision, authority_epoch, kind, recorded_ms)
      SELECT $1, n, lpad(to_hex(n),64,'0'), $2, n, 1, 'source-updated', $3 FROM generate_series(1,100001) n`, [SOURCE, OWNER, NOW]);
  });
  const body = await read();
  assert.equal(body.pipeline.delivery.appliedSequence, 0);
  assert.equal(body.pipeline.delivery.pendingChanges, null);
  assert.equal(body.pipeline.daily.queuedDays, null);
});

test("origin defaults serve v4 with no-store for both valid query shapes", { skip }, async () => {
  const context = { requestId: "00000000-0000-4000-8000-000000000011", routeId: "admin_reconstruction_progress",
    adminIdentityKey: "synthetic-owner@example.invalid" };
  const handlers = adminConsole.createAdminConsoleHandlers({ requestContext: () => context, env: ENV,
    clock: () => NOW, pools: { primary: pool }, schemaOptions: { primarySchema: schema } });
  for (const suffix of ["", "?detail=preparation"]) {
    const response = await handlers.get("admin_reconstruction_progress")(new Request(`https://admin.example.invalid/api/v1/admin/reconstruction-progress${suffix}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), await read());
  }
});

test("one read-only repeatable snapshot, bounded statements and sanitized lock failures", { skip }, async () => {
  const statements = [];
  const recording = { async connect() {
    const client = await pool.connect();
    return { release: discard => client.release(discard), async query(sql, values) {
      statements.push(sql);
      return client.query(sql, values);
    } };
  } };
  await read({ pool: recording });
  assert.equal(statements[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.ok(statements.includes("SET LOCAL statement_timeout='2000ms'"));
  assert.ok(statements.includes("SET LOCAL lock_timeout='500ms'"));
  assert.equal(statements.filter(sql => sql.startsWith("BEGIN")).length, 1);
  assert.equal(statements.at(-1), "COMMIT");
  assert.ok(statements.length <= 10);
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(`LOCK TABLE ${q("storage_ingestion_changes")} IN ACCESS EXCLUSIVE MODE`);
    await assert.rejects(read({ pool: recording }), error => error.status === 503 && error.code === "BACKEND_STORAGE_UNAVAILABLE"
      && !error.message.includes("storage_ingestion_changes"));
    assert.equal(statements.at(-1), "ROLLBACK");
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
});
