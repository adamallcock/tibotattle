import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 24 * 60 * 60 * 1000;

const vite = await createServer({
  root: WORKER_ROOT,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const syncReads = await vite.ssrLoadModule("/src/postgres-device-sync-reads.ts");

after(async () => vite.close());

function q(schema, name) {
  return `"${schema}"."${name}"`;
}

function qschema(schema) {
  return `"${schema}"`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function postgresDay(value) {
  return value.startsWith("0000-") ? `0001-${value.slice(5)} BC` : value;
}

function mockPoolFor(rows, queries = []) {
  let connects = 0;
  return {
    get connects() { return connects; },
    async connect() {
      connects += 1;
      return {
        async query(text, values) {
          queries.push({ text, values });
          if (text.includes("FROM \"sync_reads_test\".\"telemetry_v1_chunks\"")) {
            return { rows, rowCount: rows.length };
          }
          if (text.includes("FROM \"sync_reads_test\".\"device_credentials\"")) {
            return { rows: [{ device_issued_at: "2026-09-20T12:00:00.000Z", accepted_count: 1 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
}

test("manifest range accepts 31 inclusive days and rejects invalid or wider ranges before connecting", async () => {
  const queries = [];
  const pool = mockPoolFor([], queries);
  const schema = { primarySchema: "sync_reads_test", ledgerSchema: "sync_reads_ledger" };
  const manifest = await syncReads.readPostgresDeviceSyncManifest(
    pool, "synthetic-owner", "synthetic-device", "2026-01-01", "2026-01-31", { schema },
  );
  assert.deepEqual(manifest, {
    schemaVersion: "device-sync-manifest-v1.0",
    contractVersion: "telemetry-contribution-v1.0",
    fromDay: "2026-01-01",
    toDay: "2026-01-31",
    days: [],
  });
  assert.equal(pool.connects, 1);
  assert.equal(queries.find((query) => query.text.includes("telemetry_v1_chunks"))?.values?.[4], 10_001);
  const normalizedQueries = [];
  const normalizedPool = mockPoolFor([], normalizedQueries);
  const normalizedFrom = await syncReads.readPostgresDeviceSyncManifest(
    normalizedPool, "synthetic-owner", "synthetic-device", "2026-02-30", "2026-03-03", { schema },
  );
  assert.equal(normalizedFrom.fromDay, "2026-02-30");
  assert.deepEqual(normalizedQueries.find((query) => query.text.includes("telemetry_v1_chunks"))?.values?.slice(2, 4), [
    "2026-03-01", "2026-03-03",
  ], "the lower SQL boundary matches D1's raw text comparison for Date.parse-normalized days");
  await syncReads.readPostgresDeviceSyncManifest(
    normalizedPool, "synthetic-owner", "synthetic-device", "2026-02-01", "2026-02-30", { schema },
  );
  assert.deepEqual(normalizedQueries.filter((query) => query.text.includes("telemetry_v1_chunks"))[1]?.values?.slice(2, 4), [
    "2026-02-01", "2026-02-28",
  ], "the upper SQL boundary matches D1's raw text comparison for Date.parse-normalized days");
  for (const [fromDay, toDay, code] of [
    ["2026-01-01", "2026-02-01", "SYNC_RANGE_TOO_LARGE"],
    ["2026-02-32", "2026-03-01", "BODY_INVALID"],
    ["2026-02-02", "2026-02-01", "BODY_INVALID"],
  ]) {
    await assert.rejects(
      syncReads.readPostgresDeviceSyncManifest(
        pool, "synthetic-owner", "synthetic-device", fromDay, toDay, { schema },
      ),
      (error) => error?.code === code,
    );
  }
  assert.equal(pool.connects, 1, "invalid ranges do not consume a PostgreSQL connection");
  assert.equal(normalizedPool.connects, 2);
});

test("state and manifest fail closed when their bounded chunk result exceeds the D1 caps", async () => {
  const schema = { primarySchema: "sync_reads_test", ledgerSchema: "sync_reads_ledger" };
  const manifestRows = Array.from({ length: 10_001 }, () => ({
    chunk_day: "2026-01-01",
    stream: "usage",
    chunk_seq: 0,
    revision: 1,
    chunk_digest: "a".repeat(64),
    record_count: 1,
  }));
  const manifestQueries = [];
  const manifestPool = mockPoolFor(manifestRows, manifestQueries);
  await assert.rejects(
    syncReads.readPostgresDeviceSyncManifest(
      manifestPool, "synthetic-owner", "synthetic-device", "2026-01-01", "2026-01-31", { schema },
    ),
    (error) => error?.status === 503 && error?.code === "LIFECYCLE_BOUNDS_EXCEEDED",
  );
  assert.equal(manifestQueries.find((query) => query.text.includes("telemetry_v1_chunks"))?.values?.[4], 10_001);

  const stateRows = Array.from({ length: 100_001 }, () => ({
    chunk_day: "2026-01-01",
    stream: "usage",
    chunk_seq: 0,
    chunk_digest: "b".repeat(64),
  }));
  const stateQueries = [];
  const statePool = mockPoolFor(stateRows, stateQueries);
  await assert.rejects(
    syncReads.readPostgresDeviceSyncState(
      statePool, "synthetic-owner", "synthetic-device", {
        schema: { primarySchema: schema.primarySchema, ledgerSchema: schema.ledgerSchema },
      },
    ),
    (error) => error?.status === 503 && error?.code === "LIFECYCLE_BOUNDS_EXCEEDED",
  );
  assert.equal(stateQueries.find((query) => query.text.includes("telemetry_v1_chunks"))?.values?.[2], 100_001);
});

async function localPostgresEndpoint() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  const link = await lstat(PG_TEST_SOCKET);
  const host = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(host);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host, port: PG_TEST_PORT };
}

async function seedDevice(pool, schema, { participantId, deviceId, suffix, now }) {
  const sessionId = `session-${suffix}`;
  const pairingId = `pairing-${suffix}`;
  const secretHash = randomBytes(32);
  const expiresAt = "2027-01-01T00:00:00.000Z";
  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (id, owner_kind, state, created_at)
     VALUES ($1, 'social', 'active', $2::timestamptz)
     ON CONFLICT (id) DO NOTHING`,
    [participantId, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "web_sessions")} (
       id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
     ) VALUES ($1, $2, $3, $3, $4::timestamptz, $5::timestamptz, $4::timestamptz)`,
    [sessionId, participantId, secretHash, now, expiresAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_pairings")} (
       id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
     ) VALUES ($1, $2, $3, $4, 'synthetic-consent', 'synthetic-transport',
       'consumed', $5::timestamptz, $6::timestamptz, $5::timestamptz, $7)`,
    [pairingId, participantId, sessionId, secretHash, now, expiresAt, deviceId],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_credentials")} (
       id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
       state, issued_at, expires_at, last_used_at, social_verified_at
     ) VALUES ($1, $2, 'social', $3, $4, 'active', $5::timestamptz,
       $6::timestamptz, $5::timestamptz, $5::timestamptz)`,
    [deviceId, participantId, pairingId, secretHash, now, expiresAt],
  );
}

async function insertCurrentChunk(pool, schema, {
  id, participantId, deviceId, stream, day, seq, revision, chunkDigest, supersededAt = null,
  now,
}) {
  const uploadId = `upload-${id}`;
  const envelopeDigest = digest(`envelope:${id}`);
  const objectKey = `synthetic/device-sync/${id}`;
  await pool.query(
    `INSERT INTO ${q(schema, "device_upload_authorizations")} (
       id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
       body_bytes, content_type, state, issued_at, expires_at, consumed_at
     ) VALUES ($1, $2, $3, $4, $5, 64, 'application/json', 'consumed',
       $6::timestamptz, '2027-01-01T00:00:00Z'::timestamptz, $6::timestamptz)`,
    [uploadId, participantId, deviceId, randomBytes(32), envelopeDigest, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "pending_objects")} (contribution_id, object_key, object_kind)
     VALUES ($1, $2, 'telemetry_v1')`,
    [id, objectKey],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v1_chunks")} (
       id, participant_id, device_id, stream, chunk_day, chunk_seq, revision,
       chunk_digest, envelope_digest, parser_version, record_count,
       accepted_record_count, r2_key, device_upload_authorization_id,
       superseded_at, created_at
       ) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9,
       'synthetic-sync-v1', 1, 1, $10, $11, $12::timestamptz, $13::timestamptz)`,
    [id, participantId, deviceId, stream, postgresDay(day), seq, revision, chunkDigest,
      envelopeDigest, objectKey, uploadId, supersededAt, now],
  );
}

test("PostgreSQL 17 state and manifest match the D1 cursor contract and isolate participant/device history", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localPostgresEndpoint();
  const pool = new pg.Pool({
    ...endpoint,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: process.env.PG_TEST_DATABASE || "postgres",
    application_name: "pg-device-sync-reads-test",
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 5_000,
  });
  const schema = `sync_read_${randomBytes(5).toString("hex")}`;
  const options = { schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` } };
  const nowEpoch = Date.parse("2026-09-25T12:00:00.000Z");
  const now = new Date(nowEpoch).toISOString();
  const owner = "synthetic-sync-owner";
  const peerOwner = "synthetic-sync-peer-owner";
  const device = "synthetic-sync-device";
  const peerDevice = "synthetic-sync-peer-device";
  const otherDevice = "synthetic-sync-other-device";
  let created = false;
  try {
    const locality = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr() AS address",
    );
    assert.equal(Math.floor(locality.rows[0].version / 10_000), 17,
      "cursor qualification requires PostgreSQL 17");
    assert.equal(locality.rows[0].address, null, "qualification requires a local Unix socket");
    await pool.query(`CREATE SCHEMA ${qschema(schema)}`);
    created = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });

    await seedDevice(pool, schema, {
      participantId: owner, deviceId: device, suffix: "owner-main", now,
    });
    await seedDevice(pool, schema, {
      participantId: owner, deviceId: otherDevice, suffix: "owner-other", now,
    });
    await seedDevice(pool, schema, {
      participantId: peerOwner, deviceId: peerDevice, suffix: "peer", now,
    });

    const old = "0".repeat(64);
    const quota = "1".repeat(64);
    const session = "2".repeat(64);
    const usage = "3".repeat(64);
    const nextDay = "4".repeat(64);
    const otherDeviceDigest = "5".repeat(64);
    const peerDigest = "6".repeat(64);
    await insertCurrentChunk(pool, schema, {
      id: "sync-old-usage", participantId: owner, deviceId: device, stream: "usage",
      day: "2026-09-24", seq: 0, revision: 1, chunkDigest: old,
      supersededAt: "2026-09-25T10:00:00.000Z", now,
    });
    await insertCurrentChunk(pool, schema, {
      id: "sync-current-usage", participantId: owner, deviceId: device, stream: "usage",
      day: "2026-09-24", seq: 0, revision: 2, chunkDigest: usage, now,
    });
    await insertCurrentChunk(pool, schema, {
      id: "sync-current-quota", participantId: owner, deviceId: device, stream: "quota",
      day: "2026-09-24", seq: 0, revision: 1, chunkDigest: quota, now,
    });
    await insertCurrentChunk(pool, schema, {
      id: "sync-current-session", participantId: owner, deviceId: device, stream: "session",
      day: "2026-09-24", seq: 0, revision: 1, chunkDigest: session, now,
    });
    await insertCurrentChunk(pool, schema, {
      id: "sync-next-day", participantId: owner, deviceId: device, stream: "usage",
      day: "2026-09-25", seq: 1, revision: 1, chunkDigest: nextDay, now,
    });
    await insertCurrentChunk(pool, schema, {
      id: "sync-other-device", participantId: owner, deviceId: otherDevice, stream: "usage",
      day: "2026-09-24", seq: 0, revision: 1, chunkDigest: otherDeviceDigest, now,
    });
    await insertCurrentChunk(pool, schema, {
      id: "sync-peer-owner", participantId: peerOwner, deviceId: peerDevice, stream: "usage",
      day: "2026-09-24", seq: 0, revision: 1, chunkDigest: peerDigest, now,
    });
    await insertCurrentChunk(pool, schema, {
      id: "sync-iso-year-zero", participantId: peerOwner, deviceId: peerDevice, stream: "quota",
      day: "0000-01-01", seq: 0, revision: 1, chunkDigest: "7".repeat(64), now,
    });
    await pool.query(
      `INSERT INTO ${q(schema, "telemetry_v1_chunk_admission_windows")} (
         participant_id, device_id, window_day, accepted_count, last_accepted_at
       ) VALUES ($1, $2, '2026-09-25'::date, 4, $3::timestamptz)`,
      [owner, device, now],
    );

    const state = await syncReads.readPostgresDeviceSyncState(
      pool, owner, device, { ...options, nowEpoch },
    );
    const dayOneDigest = digest(quota + session + usage);
    const dayTwoDigest = digest(nextDay);
    assert.deepEqual(state, {
      schemaVersion: "device-sync-state-v1.0",
      contractVersion: "telemetry-contribution-v1.0",
      acknowledgedThroughDay: "2026-09-25",
      historyDigest: digest(dayOneDigest + dayTwoDigest),
      dayCount: 2,
      chunkCount: 4,
      admission: {
        schemaVersion: "telemetry-chunk-admission-v1.0",
        state: "available",
        windowDay: "2026-09-25",
        budget: "launch_week",
        acceptedChunks: 4,
        remainingChunks: 19_996,
        maximumChunks: 20_000,
        retryAt: "2026-09-26T00:00:00.000Z",
      },
    });

    const manifest = await syncReads.readPostgresDeviceSyncManifest(
      pool, owner, device, "2026-09-24", "2026-09-25", options,
    );
    assert.deepEqual(manifest, {
      schemaVersion: "device-sync-manifest-v1.0",
      contractVersion: "telemetry-contribution-v1.0",
      fromDay: "2026-09-24",
      toDay: "2026-09-25",
      days: [
        {
          day: "2026-09-24",
          dayDigest: dayOneDigest,
          chunks: [
            { chunkId: "quota:2026-09-24:0", revision: 1, chunkDigest: quota, recordCount: 1 },
            { chunkId: "session:2026-09-24:0", revision: 1, chunkDigest: session, recordCount: 1 },
            { chunkId: "usage:2026-09-24:0", revision: 2, chunkDigest: usage, recordCount: 1 },
          ],
        },
        {
          day: "2026-09-25",
          dayDigest: dayTwoDigest,
          chunks: [
            { chunkId: "usage:2026-09-25:1", revision: 1, chunkDigest: nextDay, recordCount: 1 },
          ],
        },
      ],
    });
    const firstDayManifest = await syncReads.readPostgresDeviceSyncManifest(
      pool, owner, device, "2026-09-24", "2026-09-24", options,
    );
    assert.deepEqual(firstDayManifest.days.map((entry) => ({
      day: entry.day,
      dayDigest: entry.dayDigest,
      chunkIds: entry.chunks.map((chunk) => chunk.chunkId),
    })), [{
      day: "2026-09-24",
      dayDigest: dayOneDigest,
      chunkIds: ["quota:2026-09-24:0", "session:2026-09-24:0", "usage:2026-09-24:0"],
    }]);
    const otherDeviceManifest = await syncReads.readPostgresDeviceSyncManifest(
      pool, owner, otherDevice, "2026-09-24", "2026-09-24", options,
    );
    assert.deepEqual(otherDeviceManifest.days.map((entry) => entry.dayDigest), [digest(otherDeviceDigest)]);
    const peerManifest = await syncReads.readPostgresDeviceSyncManifest(
      pool, peerOwner, peerDevice, "2026-09-24", "2026-09-24", options,
    );
    assert.deepEqual(peerManifest.days.map((entry) => entry.dayDigest), [digest(peerDigest)]);
    const isoYearZeroManifest = await syncReads.readPostgresDeviceSyncManifest(
      pool, peerOwner, peerDevice, "0000-01-01", "0000-01-01", options,
    );
    assert.equal(isoYearZeroManifest.days[0]?.day, "0000-01-01");
    assert.deepEqual(isoYearZeroManifest.days[0]?.chunks.map((chunk) => chunk.chunkId), [
      "quota:0000-01-01:0",
    ]);

    const notReadySchema = `${schema}_notready`;
    await pool.query(`CREATE SCHEMA ${qschema(notReadySchema)}`);
    try {
      await assert.rejects(
        syncReads.readPostgresDeviceSyncManifest(
          pool, owner, device, "2026-09-24", "2026-09-24", {
            schema: { primarySchema: notReadySchema, ledgerSchema: `${notReadySchema}_ledger` },
          },
        ),
        (error) => error?.code === "unavailable"
          && error?.operation === "device_sync.manifest"
          && !error.message.includes("telemetry_v1_chunks"),
      );
    } finally {
      await pool.query(`DROP SCHEMA ${qschema(notReadySchema)} CASCADE`);
    }
  } finally {
    if (created) await pool.query(`DROP SCHEMA ${qschema(schema)} CASCADE`);
    await pool.end();
  }
});
