import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  createPostgresLifecycleStore,
  createPostgresAnalyticalWorkStore,
  createPostgresPreparedSourceStore,
  createPostgresReleaseNonceStore,
} from "../src/postgres-storage-provider.ts";
import {
  advanceCommunityAnalysisProviderRun,
  communityAnalysisProviderIdentity,
} from "../src/community-analysis-runner.ts";
import { createProviderV1QuotaReader } from "../src/prepared-v1-evidence.ts";

const { Pool } = pg;
const primarySchema = "tibotattle";
const ledgerSchema = "tibotattle_ledger";
const primaryDatabaseName = `tibotattle_lifecycle_primary_${randomBytes(10).toString("hex")}`;
const ledgerDatabaseName = `tibotattle_lifecycle_ledger_${randomBytes(10).toString("hex")}`;
let admin;
let rawPool;
let ledgerPool;
let pool;
let adapterPool;
let created = false;
const scrubbedAmbientPg = new Map();

const pin = Object.freeze({
  sourceId: "synthetic-source",
  sourceNamespace: "telemetry-v1",
  ownerDigest: "a".repeat(64),
  day: "2026-09-21",
  inputRevision: 1,
  ownerRevision: 1,
  dependencyDigest: "b".repeat(64),
  method: "prepared-v1-evidence-1",
  authorityEpoch: 1,
  sourceEpoch: 1,
  sequence: 1,
});

const baseOptions = () => ({
  host: process.env.PG_TEST_SOCKET,
  port: Number(process.env.PG_TEST_PORT ?? "55432"),
  user: "postgres",
  password: "localtrust",
  ssl: false,
  options: "",
  application_name: "tibotattle-analytics-lifecycle-test",
  connectionTimeoutMillis: 3000,
  statement_timeout: 12000,
  idleTimeoutMillis: 1000,
  max: 3,
});

async function connectWithSearchPath() {
  const client = await rawPool.connect();
  try {
    await client.query(`SET search_path TO ${primarySchema}, pg_catalog`);
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

const payloadDigest = (payload) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
const pageDigest = (rows) => payloadDigest(rows);
const sourceRow = (occurrenceId, observedAtMs, payloadSha256, payload = { value: occurrenceId }) => ({
  occurrenceId,
  observedAtMs,
  observedDay: pin.day,
  ownerDigest: pin.ownerDigest,
  inputRevision: pin.inputRevision,
  payloadSha256: payloadSha256 ?? payloadDigest(payload),
  payload,
});

async function seedHead({ state = "ready", generation = "generation-1", progressRevision = 0 } = {}) {
  await pool.query(`
    INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
    VALUES($1,$2,$3,$4,'active')
    ON CONFLICT(source_id,owner_digest) DO UPDATE SET revision=EXCLUDED.revision,
      authority_epoch=EXCLUDED.authority_epoch,state=EXCLUDED.state`,
  [pin.sourceId, pin.ownerDigest, pin.ownerRevision, pin.authorityEpoch]);
  await pool.query(`
    INSERT INTO analytics_prepared_source_heads
      (generation,state,progress_revision,next_cursor_time,next_cursor_id,rows_written,
       source_id,source_namespace,owner_digest,day,input_revision,owner_revision,
       dependency_digest,method,authority_epoch,source_epoch,sequence)
    VALUES($1,$2,$3,NULL,NULL,0,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [generation, state, progressRevision, pin.sourceId, pin.sourceNamespace, pin.ownerDigest,
    pin.day, pin.inputRevision, pin.ownerRevision, pin.dependencyDigest, pin.method,
    pin.authorityEpoch, pin.sourceEpoch, pin.sequence]);
  return generation;
}

async function insertSourceRow(generation, row) {
  await pool.query(`
    INSERT INTO analytics_prepared_source_rows
      (source_id,owner_digest,observed_day,generation,occurrence_id,observed_at_ms,
       input_revision,payload_json,payload_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [pin.sourceId, pin.ownerDigest, pin.day, generation, row.occurrenceId, row.observedAtMs,
    row.inputRevision, JSON.stringify(row.payload), row.payloadSha256]);
}

beforeAll(async () => {
  const socket = process.env.PG_TEST_SOCKET;
  if (typeof socket !== "string" || !isAbsolute(socket)
      || !socket.startsWith("/private/tmp/tibotattle-pg-")) {
    throw new Error("PG_TEST_SOCKET must identify the provisioned local PostgreSQL socket");
  }
  const socketStat = await lstat(socket);
  if (!socketStat.isDirectory() || socketStat.isSymbolicLink()
      || await realpath(socket) !== socket || (socketStat.mode & 0o777) !== 0o700
      || socketStat.uid !== process.getuid()) {
    throw new Error("PG_TEST_SOCKET must be a canonical owner-only directory");
  }
  const port = Number(process.env.PG_TEST_PORT ?? "55432");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid PG_TEST_PORT");
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PG") && !key.startsWith("PG_TEST_")) {
      scrubbedAmbientPg.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  admin = new Pool({ ...baseOptions(), database: "postgres", max: 2 });
  await admin.query(`CREATE DATABASE "${primaryDatabaseName}"`);
  await admin.query(`CREATE DATABASE "${ledgerDatabaseName}"`);
  created = true;
  rawPool = new Pool({ ...baseOptions(), database: primaryDatabaseName });
  ledgerPool = new Pool({ ...baseOptions(), database: ledgerDatabaseName });
  // This pool intentionally carries no ambient search_path. Adapters must
  // bind the validated schema inside each transaction; `pool` below is only
  // a convenient primary-schema fixture/query helper.
  adapterPool = { connect: () => rawPool.connect() };
  pool = {
    connect: connectWithSearchPath,
    async query(text, values) {
      const client = await connectWithSearchPath();
      try {
        return await client.query(text, values);
      } finally {
        client.release();
      }
    },
  };
  await rawPool.query(`CREATE SCHEMA ${primarySchema}`);
  await ledgerPool.query(`CREATE SCHEMA ${ledgerSchema}`);
  const primaryMigration = await readFile(new URL("../postgres/migrations/primary/0007_analytics_lifecycle.sql", import.meta.url), "utf8");
  const ledgerMigration = await readFile(new URL("../postgres/migrations/ledger/0002_tombstones_cooldowns.sql", import.meta.url), "utf8");
  const ledgerRestoreMigration = await readFile(new URL("../postgres/migrations/ledger/0003_erasure_restore_receipts.sql", import.meta.url), "utf8");
  await rawPool.query(`SET search_path TO ${primarySchema}, pg_catalog;\n${primaryMigration}`);
  await ledgerPool.query(`SET search_path TO ${ledgerSchema}, pg_catalog;\n${ledgerMigration}\n${ledgerRestoreMigration}`);
  expect((await rawPool.query("SELECT DATE '2026-09-21' AS day")).rows[0].day)
    .toBeInstanceOf(Date);
});

beforeEach(async () => {
  await pool.query("TRUNCATE analytics_analysis_work_parts, analytics_analysis_work_heads, analytics_prepared_source_rows, analytics_prepared_source_heads, analytics_owner_state, sparkle_appcast_guard_nonces");
  await ledgerPool.query(`TRUNCATE ${ledgerSchema}.deletion_tombstones, ${ledgerSchema}.identity_reenrollment_cooldowns, ${ledgerSchema}.participant_erasure_receipts, ${ledgerSchema}.restore_suppression_receipts`);
});

afterAll(async () => {
  try {
    await rawPool?.end();
    await ledgerPool?.end();
    if (created) {
      await admin.query(`DROP DATABASE "${primaryDatabaseName}"`);
      await admin.query(`DROP DATABASE "${ledgerDatabaseName}"`);
    }
  } finally {
    await admin?.end();
    for (const [key, value] of scrubbedAmbientPg) process.env[key] = value;
  }
});

it("reads a bounded page only after the authoritative ready head and owner pin agree", async () => {
  const generation = await seedHead();
  await insertSourceRow(generation, sourceRow("one", 1));
  await insertSourceRow(generation, sourceRow("two", 2));
  const store = createPostgresPreparedSourceStore(adapterPool, { primarySchema, ledgerSchema });

  const first = await store.readPage({ pin, generation, readerPolicy: "prepared-source", cursor: null, limit: 1 });
  expect(first).toMatchObject({ status: "available", complete: false, rows: [{ occurrenceId: "one" }] });
  expect(first.nextCursor).toEqual({ observedAtMs: 1, occurrenceId: "one" });
  const stalePin = { ...pin, dependencyDigest: "c".repeat(64) };
  const stale = await store.readPage({ pin: stalePin, generation, readerPolicy: "prepared-source", cursor: null, limit: 1 });
  expect(stale).toMatchObject({ status: "stale", rows: [], complete: true });
  const second = await store.readPage({ pin, generation, readerPolicy: "prepared-source", cursor: first.nextCursor, limit: 1 });
  expect(second).toMatchObject({ status: "available", complete: true, rows: [{ occurrenceId: "two" }] });

  await pool.query("UPDATE analytics_prepared_source_heads SET state='building'");
  const unavailable = await store.readPage({ pin, generation, readerPolicy: "prepared-source", cursor: null, limit: 10 });
  expect(unavailable).toMatchObject({ status: "correction_unavailable", rows: [], complete: true });
  await pool.query("UPDATE analytics_owner_state SET state='withdrawn'");
  const withdrawn = await store.readPage({ pin, generation, readerPolicy: "prepared-source", cursor: null, limit: 10 });
  expect(withdrawn).toMatchObject({ status: "withdrawn", rows: [], complete: true });
});

it("maps the operational prepared-source page to the existing v1 quota reader", async () => {
  const generation = await seedHead();
  const payload = {
    stream: "quota", id: 1, device_id: "device-1", provider: "openai_codex", limit_id: "codex",
    plan_type: "plus", plan_variant: "standard", occurrence_id: "quota-occurrence-1", slot: "weekly",
    used_percent: 12.5, window_duration_minutes: 10080, resets_at: "2026-09-22T00:00:00.000Z",
  };
  await insertSourceRow(generation, sourceRow("1", Date.parse("2026-09-21T00:00:01.000Z"), payloadDigest(payload), payload));
  const reader = createProviderV1QuotaReader({
    store: createPostgresPreparedSourceStore(adapterPool, { primarySchema, ledgerSchema }),
    pin, generation, readerPolicy: "prepared-v1-quota-1",
  });
  await expect(reader.readPlanPage({ observedAt: "2026-09-21T00:00:00.000Z", id: 0 }, 128))
    .resolves.toMatchObject([{ id: 1, device_id: "device-1", observed_day: pin.day }]);
  await expect(reader.readFitPage({ observedAt: "2026-09-21T00:00:00.000Z", resetsAt: "2026-09-21T00:00:00.000Z", id: 0 }, 128))
    .resolves.toMatchObject([{ occurrence_id: "quota-occurrence-1", used_percent: 12.5 }]);
});

it("commits exact-once occurrences, rejects digest replacement, and fences stale progress", async () => {
  const generation = await seedHead({ state: "building" });
  const store = createPostgresPreparedSourceStore(adapterPool, { primarySchema, ledgerSchema });
  const row = sourceRow("one", 1);
  const commit = { pin, generation, expectedProgressRevision: 0, nextCursor: null, complete: true, rows: [row], rowDigest: pageDigest([row]) };
  const first = await store.commitPage(commit);
  expect(first).toMatchObject({ state: "ready", progressRevision: 1, rowsWritten: 1 });
  const replay = await store.commitPage({ ...commit, expectedProgressRevision: 1 });
  expect(replay).toMatchObject({ state: "ready", progressRevision: 1, rowsWritten: 1 });
  await expect(store.commitPage({
    ...commit,
    expectedProgressRevision: 1,
    rows: [sourceRow("new-ready-row", 2)],
  })).rejects.toMatchObject({ storageCode: "conflict" });
  await expect(store.commitPage({
    ...commit,
    expectedProgressRevision: 1,
    rows: [sourceRow("one", 99, row.payloadSha256, row.payload)],
  })).rejects.toMatchObject({ storageCode: "conflict" });
  await expect(store.commitPage({
    ...commit,
    expectedProgressRevision: 1,
    rows: [sourceRow("one", 1, payloadDigest({ changed: true }), { changed: true })],
    rowDigest: pageDigest([sourceRow("one", 1, payloadDigest({ changed: true }), { changed: true })]),
  })).rejects.toMatchObject({ storageCode: "conflict" });
  await expect(store.commitPage({
    ...commit,
    expectedProgressRevision: 1,
    rows: [sourceRow("different", 2, "f".repeat(64), { different: true })],
  })).rejects.toMatchObject({ storageCode: "incomplete" });
  await expect(store.commitPage({ ...commit, expectedProgressRevision: 2 })).rejects.toMatchObject({ storageCode: "conflict" });
  expect((await pool.query("SELECT rows_written,progress_revision FROM analytics_prepared_source_heads")).rows[0])
    .toMatchObject({ rows_written: "1", progress_revision: "1" });
});

it("allows one concurrent progress-CAS winner and rejects wrong owner/generation", async () => {
  const generation = await seedHead({ state: "building" });
  const store = createPostgresPreparedSourceStore(adapterPool, { primarySchema, ledgerSchema });
  const a = {
    pin, generation, expectedProgressRevision: 0, nextCursor: null, complete: true,
    rows: [sourceRow("race-a", 1)], rowDigest: pageDigest([sourceRow("race-a", 1)]),
  };
  const b = {
    pin, generation, expectedProgressRevision: 0, nextCursor: null, complete: true,
    rows: [sourceRow("race-b", 2)], rowDigest: pageDigest([sourceRow("race-b", 2)]),
  };
  const outcomes = await Promise.allSettled([store.commitPage(a), store.commitPage(b)]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")[0].reason)
    .toMatchObject({ storageCode: "conflict" });
  const wrongOwner = { ...pin, ownerDigest: "d".repeat(64) };
  await expect(store.commitPage({ ...a, pin: wrongOwner })).rejects.toMatchObject({ storageCode: "source_stale" });
  await expect(store.commitPage({ ...a, generation: "missing-generation" })).rejects.toMatchObject({ storageCode: "conflict" });
});

it("does not retry a commit whose acknowledgement is lost and discards that client", async () => {
  const generation = await seedHead({ state: "building" });
  const discarded = [];
  let commits = 0;
  const uncertainPool = {
    async connect() {
      const client = await rawPool.connect();
      return {
        async query(text, values) {
          const result = await client.query(text, values);
          if (text === "COMMIT") {
            commits += 1;
            throw new Error("synthetic commit acknowledgement loss");
          }
          return result;
        },
        release(discard) {
          discarded.push(discard);
          client.release(discard);
        },
      };
    },
  };
  const store = createPostgresPreparedSourceStore(uncertainPool, { primarySchema, ledgerSchema });
  await expect(store.commitPage({
    pin, generation, expectedProgressRevision: 0, nextCursor: null, complete: true,
    rows: [sourceRow("lost-ack", 1)], rowDigest: pageDigest([sourceRow("lost-ack", 1)]),
  })).rejects.toMatchObject({ storageCode: "unavailable" });
  expect(commits).toBe(1);
  expect(discarded).toEqual([true]);
  expect((await pool.query("SELECT occurrence_id,rows_written FROM analytics_prepared_source_rows JOIN analytics_prepared_source_heads ON analytics_prepared_source_heads.source_id=analytics_prepared_source_rows.source_id AND analytics_prepared_source_heads.owner_digest=analytics_prepared_source_rows.owner_digest AND analytics_prepared_source_heads.day=analytics_prepared_source_rows.observed_day AND analytics_prepared_source_heads.generation=analytics_prepared_source_rows.generation WHERE occurrence_id='lost-ack'")).rows)
    .toHaveLength(1);
});

it("retires rows with an independent progress CAS and marks the head retired", async () => {
  const generation = await seedHead({ state: "discarding", progressRevision: 0 });
  await insertSourceRow(generation, sourceRow("one", 1));
  await insertSourceRow(generation, sourceRow("two", 2));
  const store = createPostgresPreparedSourceStore(adapterPool, { primarySchema, ledgerSchema });
  await expect(store.retire({ sourceId: pin.sourceId, ownerDigest: pin.ownerDigest, day: pin.day, generation, expectedProgressRevision: 0, limit: 1 }))
    .resolves.toEqual({ deleted: 1, complete: false });
  await expect(store.retire({ sourceId: pin.sourceId, ownerDigest: pin.ownerDigest, day: pin.day, generation, expectedProgressRevision: 1, limit: 10 }))
    .resolves.toEqual({ deleted: 1, complete: true });
  expect((await pool.query("SELECT state,progress_revision FROM analytics_prepared_source_heads")).rows[0])
    .toMatchObject({ state: "retired", progress_revision: "2" });
  await expect(store.retire({ sourceId: pin.sourceId, ownerDigest: pin.ownerDigest, day: pin.day, generation, expectedProgressRevision: 2, limit: 1 }))
    .rejects.toMatchObject({ storageCode: "conflict" });
});

it("runs the existing quota acquisition codec through provider claims and checkpoints", async () => {
  const identity = {
    participantId: "participant-provider-run",
    inputRevision: 1,
    inputFingerprint: "e".repeat(64),
    sourceKind: "v1",
    sourceMethodVersion: "provider-prepared-v1",
    fixedNow: "2026-09-21T23:59:59.999Z",
    observedAtCutoff: "2026-09-15T00:00:00.000Z",
    resetsAtCutoff: "2026-09-22T00:00:00.000Z",
    windowMinutes: 10080,
    maxQuotaRows: 120,
  };
  const workStore = createPostgresAnalyticalWorkStore(adapterPool, { primarySchema, ledgerSchema });
  const sourcePin = {
    sourceId: identity.participantId, sourceNamespace: "telemetry-v1", ownerDigest: identity.inputFingerprint,
    day: "2026-09-15", inputRevision: identity.inputRevision, ownerRevision: identity.inputRevision,
    dependencyDigest: identity.inputFingerprint, method: identity.sourceMethodVersion,
    authorityEpoch: 0, sourceEpoch: 1, sequence: 1,
  };
  const generation = "provider-source-generation";
  await pool.query(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
    VALUES($1,$2,$3,$4,'active')`, [sourcePin.sourceId, sourcePin.ownerDigest, sourcePin.ownerRevision, sourcePin.authorityEpoch]);
  await pool.query(`INSERT INTO analytics_prepared_source_heads
    (generation,state,progress_revision,next_cursor_time,next_cursor_id,rows_written,
     source_id,source_namespace,owner_digest,day,input_revision,owner_revision,
     dependency_digest,method,authority_epoch,source_epoch,sequence)
    VALUES($1,'ready',0,NULL,NULL,0,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [generation, sourcePin.sourceId, sourcePin.sourceNamespace, sourcePin.ownerDigest, sourcePin.day,
    sourcePin.inputRevision, sourcePin.ownerRevision, sourcePin.dependencyDigest, sourcePin.method,
    sourcePin.authorityEpoch, sourcePin.sourceEpoch, sourcePin.sequence]);
  const preparedStore = createPostgresPreparedSourceStore(adapterPool, { primarySchema, ledgerSchema });
  expect(await preparedStore.readHead({ sourceId: sourcePin.sourceId, ownerDigest: sourcePin.ownerDigest,
    day: sourcePin.day, generation })).toMatchObject({ state: "ready", sourcePin });
  const makeOptions = () => ({
    identity,
    workStore,
    workIdentity: communityAnalysisProviderIdentity(identity),
    preparedSource: {
      store: preparedStore,
      pin: sourcePin, generation, readerPolicy: "prepared-v1-quota-1",
    },
    winningDayDevices: new Map(),
    leaseMs: 60_000,
    budget: { remainingQueries: 100, reserveQueries: 0, deadlineMs: Date.now() + 60_000 },
  });
  const first = await advanceCommunityAnalysisProviderRun(makeOptions());
  expect(first.status).toBe("ready");
  if (first.status !== "ready") return;
  expect(first.evidence.acquisition).toMatchObject({ planAnchors: [], quotaRows: [] });
  const second = await advanceCommunityAnalysisProviderRun(makeOptions());
  expect(second.status).toBe("ready");
  expect((await pool.query(`SELECT state,checkpoint_generation FROM analytics_analysis_work_heads`)).rows)
    .toMatchObject([{ state: "complete", checkpoint_generation: expect.any(String) }]);
  expect((await pool.query(`SELECT count(*)::int AS count FROM analytics_analysis_work_parts`)).rows[0].count)
    .toBeGreaterThan(0);
});

it("reclaims an expired checkpointing lease and rejects stale completion", async () => {
  const identity = {
    sourceId: "checkpoint-restart",
    sourceNamespace: "community-analysis-v1",
    ownerDigest: "f".repeat(64),
    day: "2026-09-21",
    metric: "fits",
    inputRevision: 2,
    ownerRevision: 2,
    dependencyDigest: "f".repeat(64),
    method: "provider-prepared-v1",
    authorityEpoch: 1,
  };
  const store = createPostgresAnalyticalWorkStore(adapterPool, { primarySchema, ledgerSchema });
  // The adapter must ignore this synthetic caller clock for lease decisions;
  // PostgreSQL supplies the mutation-time clock instead.
  const claim = await store.claim({ identity, nowMs: 0, leaseMs: 60_000 });
  expect(claim).not.toBeNull();
  const payloadJson = "[]";
  const sha256 = createHash("sha256").update(payloadJson).digest("hex");
  const checkpoint = {
    generation: "checkpoint-1", expectedHead: null, controlJson: "{}", manifestJson: "[]",
    parts: [{ index: 0, sha256, payloadJson }], complete: false,
  };
  const checkpointed = await store.saveCheckpoint({
    identity, claimToken: claim.claimToken, expectedRevision: claim.revision, nowMs: 0, checkpoint,
  });
  expect(checkpointed.state).toBe("checkpointing");
  // A checkpoint row existing is insufficient: completion requires the
  // selected generation's complete marker and manifest/part digests.
  await expect(store.complete({ identity, claimToken: claim.claimToken, expectedRevision: checkpointed.revision,
    nowMs: 0, resultDigest: "1".repeat(64) })).rejects.toMatchObject({ storageCode: "conflict" });
  await pool.query(`UPDATE analytics_analysis_work_heads
    SET lease_expires_ms = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 1
    WHERE source_id=$1 AND owner_digest=$2 AND day=$3 AND metric=$4`,
  [identity.sourceId, identity.ownerDigest, identity.day, identity.metric]);
  await expect(store.complete({ identity, claimToken: claim.claimToken, expectedRevision: checkpointed.revision,
    nowMs: 0, resultDigest: "1".repeat(64) })).rejects.toMatchObject({ storageCode: "conflict" });
  const resumedClaim = await store.claim({ identity, nowMs: 0, leaseMs: 100 });
  expect(resumedClaim).not.toBeNull();
  const resumed = await store.read(identity);
  expect(resumed).toMatchObject({ state: "claimed", checkpoint: { generation: "checkpoint-1", complete: false } });
});

it("reclaims after a blocked row lock using the database clock", async () => {
  const identity = {
    sourceId: "blocked-lease-restart",
    sourceNamespace: "community-analysis-v1",
    ownerDigest: "e".repeat(64),
    day: "2026-09-21",
    metric: "fits",
    inputRevision: 1,
    ownerRevision: 1,
    dependencyDigest: "e".repeat(64),
    method: "provider-prepared-v1",
    authorityEpoch: 1,
  };
  const store = createPostgresAnalyticalWorkStore(adapterPool, { primarySchema, ledgerSchema });
  const claim = await store.claim({ identity, nowMs: 0, leaseMs: 500 });
  expect(claim).not.toBeNull();
  const blocker = await rawPool.connect();
  let reclaimPromise;
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT source_id FROM ${primarySchema}.analytics_analysis_work_heads
      WHERE source_id=$1 AND owner_digest=$2 AND day=$3 AND metric=$4 FOR UPDATE`,
    [identity.sourceId, identity.ownerDigest, identity.day, identity.metric]);
    reclaimPromise = store.claim({ identity, nowMs: 0, leaseMs: 5_000 });
    let observedLockWait = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const waitRows = (await admin.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=$1 AND pid <> pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE '%analytics_analysis_work_heads%'`, [primaryDatabaseName])).rows;
      if (waitRows.length !== 0) {
        observedLockWait = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(observedLockWait).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 650));
    await blocker.query("COMMIT");
    const resumed = await reclaimPromise;
    expect(resumed).toMatchObject({ revision: claim.revision + 1, identity });
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    blocker.release();
  }
});

it("rejects a renew whose lease expires while waiting for the head lock", async () => {
  const identity = {
    sourceId: "blocked-renew-expiry",
    sourceNamespace: "community-analysis-v1",
    ownerDigest: "1".repeat(64),
    day: "2026-09-21",
    metric: "fits",
    inputRevision: 1,
    ownerRevision: 1,
    dependencyDigest: "1".repeat(64),
    method: "provider-prepared-v1",
    authorityEpoch: 1,
  };
  const store = createPostgresAnalyticalWorkStore(adapterPool, { primarySchema, ledgerSchema });
  const claim = await store.claim({ identity, nowMs: 0, leaseMs: 500 });
  expect(claim).not.toBeNull();
  const blocker = await rawPool.connect();
  let renewPromise;
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT source_id FROM ${primarySchema}.analytics_analysis_work_heads
      WHERE source_id=$1 AND owner_digest=$2 AND day=$3 AND metric=$4 FOR UPDATE`,
    [identity.sourceId, identity.ownerDigest, identity.day, identity.metric]);
    renewPromise = store.renew({ identity, claimToken: claim.claimToken, expectedRevision: claim.revision,
      nowMs: 0, leaseMs: 5_000 });
    let observedLockWait = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const waitRows = (await admin.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=$1 AND pid <> pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE '%analytics_analysis_work_heads%'`, [primaryDatabaseName])).rows;
      if (waitRows.length !== 0) {
        observedLockWait = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(observedLockWait).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 650));
    await blocker.query("COMMIT");
    await expect(renewPromise).rejects.toMatchObject({ storageCode: "conflict" });
    expect((await pool.query(`SELECT revision,lease_expires_ms FROM ${primarySchema}.analytics_analysis_work_heads
      WHERE source_id=$1 AND owner_digest=$2`, [identity.sourceId, identity.ownerDigest])).rows[0])
      .toMatchObject({ revision: "1" });
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    await renewPromise?.catch(() => {});
    blocker.release();
  }
});

it("rejects completion whose lease expires while waiting for the head lock", async () => {
  const identity = {
    sourceId: "blocked-complete-expiry",
    sourceNamespace: "community-analysis-v1",
    ownerDigest: "2".repeat(64),
    day: "2026-09-21",
    metric: "fits",
    inputRevision: 1,
    ownerRevision: 1,
    dependencyDigest: "2".repeat(64),
    method: "provider-prepared-v1",
    authorityEpoch: 1,
  };
  const store = createPostgresAnalyticalWorkStore(adapterPool, { primarySchema, ledgerSchema });
  const claim = await store.claim({ identity, nowMs: 0, leaseMs: 500 });
  expect(claim).not.toBeNull();
  const payloadJson = "[]";
  const sha256 = createHash("sha256").update(payloadJson).digest("hex");
  const checkpointed = await store.saveCheckpoint({
    identity, claimToken: claim.claimToken, expectedRevision: claim.revision, nowMs: 0,
    checkpoint: {
      generation: "blocked-complete-checkpoint", expectedHead: null, controlJson: "{}", manifestJson: "[]",
      parts: [{ index: 0, sha256, payloadJson }], complete: false,
    },
  });
  const blocker = await rawPool.connect();
  let completePromise;
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT source_id FROM ${primarySchema}.analytics_analysis_work_heads
      WHERE source_id=$1 AND owner_digest=$2 AND day=$3 AND metric=$4 FOR UPDATE`,
    [identity.sourceId, identity.ownerDigest, identity.day, identity.metric]);
    completePromise = store.complete({ identity, claimToken: claim.claimToken,
      expectedRevision: checkpointed.revision, nowMs: 0, resultDigest: "3".repeat(64) });
    let observedLockWait = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const waitRows = (await admin.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=$1 AND pid <> pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE '%analytics_analysis_work_heads%'`, [primaryDatabaseName])).rows;
      if (waitRows.length !== 0) {
        observedLockWait = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(observedLockWait).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 650));
    await blocker.query("COMMIT");
    await expect(completePromise).rejects.toMatchObject({ storageCode: "conflict" });
    expect((await pool.query(`SELECT state,revision FROM ${primarySchema}.analytics_analysis_work_heads
      WHERE source_id=$1 AND owner_digest=$2`, [identity.sourceId, identity.ownerDigest])).rows[0])
      .toMatchObject({ state: "checkpointing", revision: "2" });
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    await completePromise?.catch(() => {});
    blocker.release();
  }
});

it("consumes release nonces once, replaces an expired nonce, and serializes races", async () => {
  const store = createPostgresReleaseNonceStore(adapterPool, { primarySchema, ledgerSchema });
  await expect(store.consume("nonce-a", { nowSeconds: 100, expiresAtSeconds: 200 })).resolves.toBe("consumed");
  await expect(store.consume("nonce-a", { nowSeconds: 150, expiresAtSeconds: 250 })).resolves.toBe("replay");
  await expect(store.consume("nonce-a", { nowSeconds: 200, expiresAtSeconds: 300 })).resolves.toBe("consumed");
  const outcomes = await Promise.all([
    store.consume("nonce-race", { nowSeconds: 400, expiresAtSeconds: 500 }),
    store.consume("nonce-race", { nowSeconds: 400, expiresAtSeconds: 500 }),
  ]);
  expect(outcomes.sort()).toEqual(["consumed", "replay"]);
  await expect(store.purgeExpired(350, 10)).resolves.toMatchObject({ deleted: 1, complete: true });
  await expect(store.purgeExpired(500, 10)).resolves.toMatchObject({ deleted: 1, complete: true });
});

it("writes deletion tombstones and cooldowns only through the independent ledger pool/schema", async () => {
  const lifecycle = createPostgresLifecycleStore({
    primaryPool: adapterPool,
    ledgerPool,
    schemaOptions: { primarySchema, ledgerSchema },
  });
  const digest = "c".repeat(64);
  const deletedAt = "2026-09-21T00:00:00.000Z";
  const retainUntil = "2026-10-21T00:00:00.000Z";

  await lifecycle.recordDeletionTombstone({ participantDigest: digest, retainUntil });
  await lifecycle.recordIdentityCooldown({ digest, deletedAt, retainUntil });
  await expect(lifecycle.hasDeletionTombstone({ participantDigest: digest, now: deletedAt }))
    .resolves.toBe(true);
  expect((await ledgerPool.query(`SELECT participant_digest FROM ${ledgerSchema}.deletion_tombstones`)).rows)
    .toEqual([{ participant_digest: digest }]);
  expect((await ledgerPool.query(`SELECT identity_cooldown_digest FROM ${ledgerSchema}.identity_reenrollment_cooldowns`)).rows)
    .toEqual([{ identity_cooldown_digest: digest }]);
  await expect(pool.query("SELECT 1 FROM deletion_tombstones")).rejects.toBeDefined();
});
