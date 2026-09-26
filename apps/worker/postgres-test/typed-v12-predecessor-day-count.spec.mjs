// PostgreSQL v1.2 predecessor bound counts ready days, not ready manifest rows
// (D1 parity: createTelemetryV12DomainPredecessor pins each day's earliest
// ready manifest). A device keeps every earlier ready manifest of a day, so
// its ready rows grow without its days growing; a row bound would refuse a
// small domain with a 400 the client treats as final. Every fixture is
// synthetic and content-free. Each test owns one disposable schema on the
// local PG17 socket, and the collation test one disposable ICU database; a
// test drops only what it created.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createServer } from "vite";
import {
  canonicalTelemetryV12Json,
  MAX_TELEMETRY_V12_DOMAIN_DAYS,
  telemetryV12DayManifestDigestInput,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ID = "synthetic-v12-day-count-source";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_DAYS = 4_096;
const REGISTRATION_CONCURRENCY = 4;

let vite;
let modules;
let socket;
let pool;

after(async () => {
  await pool?.end();
  await vite?.close();
});

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function addDays(day, count) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  const link = await lstat(PG_TEST_SOCKET);
  const host = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(host);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host, port: PG_TEST_PORT };
}

function openPool(database) {
  return new pg.Pool({
    ...socket,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database,
    application_name: "pg-v12-predecessor-day-count-test",
    ssl: false,
    max: REGISTRATION_CONCURRENCY,
    connectionTimeoutMillis: 5_000,
  });
}

async function setup() {
  if (!pool) {
    socket = await localSocket();
    pool = openPool(PG_TEST_DATABASE);
    const server = await pool.query(
      "SELECT inet_server_addr() AS address, current_setting('server_version_num')::integer AS version",
    );
    assert.equal(server.rows[0]?.address, null, "qualification requires the local Unix socket");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the disposable socket must be PostgreSQL 17");
  }
  if (!modules) {
    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: "custom",
      logLevel: "silent",
    });
    modules = {
      ...await vite.ssrLoadModule("/src/postgres-typed-v12-domain.ts"),
      ...await vite.ssrLoadModule("/src/postgres-typed-v12-admission.ts"),
    };
  }
}

/** One disposable, fully migrated primary schema with an active v1.2 runtime,
 * in the given pool's database. */
async function withSchema(prefix, run, databasePool = null) {
  await setup();
  const schemaPool = databasePool ?? pool;
  const schema = `${prefix}_${randomBytes(6).toString("hex")}`;
  let created = false;
  try {
    await schemaPool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await applyPostgresMigrations({ role: "primary", schema, pool: schemaPool });
    const table = (name) => `"${schema}"."${name}"`;
    const now = new Date().toISOString();
    await schemaPool.query(`UPDATE ${table("telemetry_v12_runtime")} SET state='active', changed_at=$1 WHERE id=1`, [now]);
    await schemaPool.query(`UPDATE ${table("telemetry_v12_typed_runtime")} SET state='active', changed_at=$1 WHERE id=1`, [now]);
    await schemaPool.query(`INSERT INTO ${table("storage_source_state")}(singleton, source_id, authority_epoch)
      VALUES (1, $1, 0)`, [SOURCE_ID]);
    const options = { schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` } };
    await run({
      pool: schemaPool,
      schema,
      table,
      options,
      domain: modules.createPostgresTypedV12Domain(schemaPool, options),
    });
  } finally {
    if (created) await schemaPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

/** A disposable database whose default collation is ICU en-US, so C and the
 * database default order some ids differently (as on a production cluster
 * created with an en_US locale). The shared test cluster itself is C. */
async function withIcuDatabase(run) {
  await setup();
  const database = `v12p2_icu_${randomBytes(6).toString("hex")}`;
  let created = false;
  let icuPool;
  // An idle client's error during the test fails it below; after pool.end()
  // a closing backend can still see the forced drop's termination.
  const idleErrors = [];
  try {
    await pool.query(`CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8'
      LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C'`);
    created = true;
    icuPool = openPool(database);
    icuPool.on("error", (error) => idleErrors.push(error));
    const provider = await icuPool.query(
      "SELECT datlocprovider, datlocale FROM pg_database WHERE datname = current_database()",
    );
    assert.deepEqual(provider.rows, [{ datlocprovider: "i", datlocale: "en-US" }]);
    await run(icuPool);
    assert.deepEqual(idleErrors, []);
  } finally {
    await icuPool?.end();
    if (created) await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  }
}

async function seedDevice(context, label) {
  const { table } = context;
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 30 * 24 * HOUR_MS).toISOString();
  const participantId = `synthetic-day-count-${label}-${randomUUID()}`;
  const sessionId = `${participantId}-session`;
  const ownerDigest = randomBytes(32).toString("hex");
  const deviceId = `synthetic-day-count-device-${label}-${randomUUID()}`;
  const pairingId = `synthetic-day-count-pairing-${randomUUID()}`;
  await context.pool.query(`INSERT INTO ${table("participants")}(id, owner_kind, state, consent_version, created_at)
    VALUES ($1,'social','active','privacy-safe-telemetry-v0.1',$2)`, [participantId, now]);
  await context.pool.query(`INSERT INTO ${table("web_sessions")}(
    id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [sessionId, participantId, randomBytes(32), randomBytes(32), now, expires]);
  await context.pool.query(`INSERT INTO ${table("storage_v11_owner_links")}(participant_id, owner_digest, state)
    VALUES ($1,$2,'active')`, [participantId, ownerDigest]);
  await context.pool.query(`INSERT INTO ${table("analytics_owner_state")}(
    source_id, owner_digest, revision, authority_epoch, state
  ) VALUES ($1,$2,1,0,'active')`, [SOURCE_ID, ownerDigest]);
  await context.pool.query(`INSERT INTO ${table("device_pairings")}(
    id, participant_id, issued_by_session_id, secret_hash, consent_version,
    transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
  ) VALUES ($1,$2,$3,$4,'synthetic-consent-v1','synthetic-transport-v1','consumed',$5,$6,$5,$7)`, [
    pairingId, participantId, sessionId, randomBytes(32), now, expires, deviceId,
  ]);
  await context.pool.query(`INSERT INTO ${table("device_credentials")}(
    id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
    state, issued_at, expires_at, last_used_at, social_verified_at
  ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`, [
    deviceId, participantId, pairingId, randomBytes(32), now, expires,
  ]);
  await context.pool.query(`INSERT INTO ${table("telemetry_v12_device_capabilities")}(
    participant_id, device_id, telemetry_schema_version, field_dictionary_version,
    privacy_contract_version, state, consented_at
  ) VALUES ($1,$2,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
    'ongoing-privacy-safe-telemetry-v1.2','accepted',$3)`, [participantId, deviceId, now]);
  return { participantId, deviceId };
}

function emptyDayManifest(day, parserVersion) {
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.2",
    day,
    parserVersion,
    consent: telemetryV12RequiredConsent(),
    chunks: [],
    excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  return manifest;
}

/** Register zero-chunk manifests through the real admission path (ready at
 * registration). Each plan item's createdEpoch becomes its created_at, so the
 * earliest manifest of a day is fixed by the plan, not by registration order. */
async function registerEmptyDays(context, principal, plan) {
  const registered = new Array(plan.length);
  let next = 0;
  await Promise.all(Array.from({ length: REGISTRATION_CONCURRENCY }, async () => {
    while (next < plan.length) {
      const index = next;
      next += 1;
      const { day, parserVersion, createdEpoch } = plan[index];
      const candidate = await modules.registerPostgresTypedV12DayManifest(
        context.pool, principal, emptyDayManifest(day, parserVersion), createdEpoch, context.options,
      );
      assert.equal(candidate.state, "ready");
      assert.equal(candidate.expectedChunks, 0);
      assert.equal(candidate.day, day);
      registered[index] = {
        day,
        createdEpoch,
        manifestId: candidate.manifestId,
        manifestDigest: candidate.manifestDigest,
      };
    }
  }));
  return registered;
}

/** Independent oracle: the earliest (created_at, id) manifest of each day, as
 * the canonical days vector the predecessor must record. Ids tie-break in
 * UTF-16 order, which equals C byte order for these ASCII ids. */
function earliestPerDay(registered) {
  const byDay = new Map();
  for (const item of registered) {
    const current = byDay.get(item.day);
    if (!current || item.createdEpoch < current.createdEpoch
        || (item.createdEpoch === current.createdEpoch && item.manifestId < current.manifestId)) {
      byDay.set(item.day, item);
    }
  }
  return [...byDay.values()]
    .sort((left, right) => (left.day < right.day ? -1 : left.day > right.day ? 1 : 0))
    .map(({ day, manifestId, manifestDigest }) => ({ day, manifestId, manifestDigest }));
}

async function readyShape(context, principal) {
  const result = await context.pool.query(`SELECT count(*)::integer AS rows,
      count(DISTINCT chunk_day)::integer AS days
    FROM ${context.table("telemetry_v12_day_manifests")}
    WHERE participant_id=$1 AND device_id=$2 AND state='ready'`, [principal.participantId, principal.deviceId]);
  return result.rows[0];
}

async function storedPredecessor(context, token) {
  const result = await context.pool.query(`SELECT to_char(from_day, 'YYYY-MM-DD') AS from_day,
      to_char(through_day, 'YYYY-MM-DD') AS through_day, days_json
    FROM ${context.table("telemetry_v12_domain_predecessors")} WHERE token_hash=$1`, [sha256Hex(token)]);
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function predecessorCount(context, principal) {
  const result = await context.pool.query(`SELECT count(*)::integer AS count
    FROM ${context.table("telemetry_v12_domain_predecessors")}
    WHERE participant_id=$1 AND device_id=$2`, [principal.participantId, principal.deviceId]);
  return result.rows[0].count;
}

/** The predecessor's range and its pinned days vector, read back from storage. */
async function assertPinnedDays(context, predecessor, expected) {
  assert.equal(predecessor.fromDay, expected[0].day);
  assert.equal(predecessor.throughDay, expected.at(-1).day);
  const stored = await storedPredecessor(context, predecessor.token);
  assert.equal(stored.from_day, expected[0].day);
  assert.equal(stored.through_day, expected.at(-1).day);
  assert.equal(stored.days_json, canonicalTelemetryV12Json(expected));
}

test("the day bound is the contract's 4,096 days", () => {
  assert.equal(MAX_TELEMETRY_V12_DOMAIN_DAYS, MAX_DAYS);
});

test("3 days x 1,366 re-digested ready manifests give a 3-day predecessor naming each day's earliest", {
  skip: !PG_TEST_SOCKET,
  timeout: 600_000,
}, async () => {
  await withSchema("v12p2_rows", async (context) => {
    const principal = await seedDevice(context, "rows");
    const days = ["2026-09-19", "2026-09-20", "2026-09-21"];
    const versionsPerDay = 1_366;
    const base = Date.now() - 3 * HOUR_MS;
    // Chronological index i: day days[i % 3], created one second apart. The
    // earliest manifest of each day carries that day's highest parser label
    // and is registered last, so neither parser order nor insertion order
    // can stand in for (created_at, id).
    const chronological = Array.from({ length: days.length * versionsPerDay }, (_, index) => ({
      day: days[index % days.length],
      parserVersion: `synthetic-parser-${String(versionsPerDay - 1 - Math.floor(index / days.length)).padStart(4, "0")}`,
      createdEpoch: base + index * 1_000,
    }));
    const registered = await registerEmptyDays(context, principal, [...chronological].reverse());
    // The fixture exceeds the old row bound (4,097 read rows) with 3 days.
    assert.deepEqual(await readyShape(context, principal), { rows: 4_098, days: 3 });
    const expected = earliestPerDay(registered);
    assert.equal(expected.length, 3);
    for (const [index, item] of expected.entries()) {
      const earliest = registered.find((candidate) => candidate.manifestId === item.manifestId);
      assert.equal(earliest.createdEpoch, base + index * 1_000);
    }

    const predecessor = await context.domain.createPredecessor(principal);
    assert.equal(predecessor.schemaVersion, "telemetry-domain-predecessor-v1.2");
    assert.equal(predecessor.previousGenerationId, null);
    await assertPinnedDays(context, predecessor, expected);
  });
});

test("4,096 distinct ready days succeed and a 4,097th day gives 400 SYNC_RANGE_TOO_LARGE", {
  skip: !PG_TEST_SOCKET,
  timeout: 600_000,
}, async () => {
  await withSchema("v12p2_days", async (context) => {
    const principal = await seedDevice(context, "days");
    const firstDay = "2015-01-01";
    const base = Date.now() - 3 * HOUR_MS;
    const plan = Array.from({ length: MAX_DAYS }, (_, index) => ({
      day: addDays(firstDay, index),
      parserVersion: "synthetic-parser-original",
      createdEpoch: base + index * 1_000,
    }));
    // Re-digest the first and last day later: 4,098 ready rows, 4,096 days.
    for (const [offset, day] of [firstDay, addDays(firstDay, MAX_DAYS - 1)].entries()) {
      plan.push({ day, parserVersion: "synthetic-parser-redigest", createdEpoch: base + (MAX_DAYS + offset) * 1_000 });
    }
    const registered = await registerEmptyDays(context, principal, plan);
    assert.deepEqual(await readyShape(context, principal), { rows: MAX_DAYS + 2, days: MAX_DAYS });
    const expected = earliestPerDay(registered);
    assert.equal(expected.length, MAX_DAYS);
    assert.deepEqual(expected, registered.slice(0, MAX_DAYS)
      .map(({ day, manifestId, manifestDigest }) => ({ day, manifestId, manifestDigest })));

    const predecessor = await context.domain.createPredecessor(principal);
    assert.equal(predecessor.fromDay, firstDay);
    assert.equal(predecessor.throughDay, addDays(firstDay, MAX_DAYS - 1));
    await assertPinnedDays(context, predecessor, expected);
    assert.equal(await predecessorCount(context, principal), 1);

    await registerEmptyDays(context, principal, [{
      day: addDays(firstDay, MAX_DAYS),
      parserVersion: "synthetic-parser-original",
      createdEpoch: base + (MAX_DAYS + 2) * 1_000,
    }]);
    assert.deepEqual(await readyShape(context, principal), { rows: MAX_DAYS + 3, days: MAX_DAYS + 1 });
    await assert.rejects(context.domain.createPredecessor(principal),
      { status: 400, code: "SYNC_RANGE_TOO_LARGE" });
    assert.equal(await predecessorCount(context, principal), 1);
  });
});

test("equal created_at pins the lower id in C collation where the database default disagrees", {
  skip: !PG_TEST_SOCKET,
  timeout: 120_000,
}, async () => {
  await withIcuDatabase(async (icuPool) => {
    await withSchema("v12p2_collation", async (context) => {
      const principal = await seedDevice(context, "collation");
      const day = "2026-09-20";
      // A registered id is a lowercase UUID, which C and en-US order alike, so
      // this pair is written with the registration's own statements. 'B' sorts
      // before 'a' in C only; the later manifest's id sorts first in both.
      const cFirst = "B0000000-0000-4000-8000-000000000000";
      const defaultFirst = "a0000000-0000-4000-8000-000000000000";
      const laterLowest = "00000000-0000-4000-8000-000000000000";
      const order = await context.pool.query(`SELECT $1::text < $2::text AS default_order,
          $1::text < $2::text COLLATE "C" AS c_order`, [cFirst, defaultFirst]);
      assert.deepEqual(order.rows, [{ default_order: false, c_order: true }]);

      const tied = new Date(Date.now() - HOUR_MS);
      const later = new Date(tied.getTime() + 1_000);
      const rows = [
        { id: defaultFirst, parserVersion: "synthetic-parser-a", createdAt: tied },
        { id: cFirst, parserVersion: "synthetic-parser-b", createdAt: tied },
        { id: laterLowest, parserVersion: "synthetic-parser-c", createdAt: later },
      ];
      const digests = new Map();
      for (const row of rows) {
        const manifest = emptyDayManifest(day, row.parserVersion);
        digests.set(row.id, manifest.manifestDigest);
        await context.pool.query(`INSERT INTO ${context.table("telemetry_v12_day_manifests")} (
            id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
            manifest_json, expected_chunk_count, state, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'staged', $8)`, [
          row.id, principal.participantId, principal.deviceId, day, manifest.manifestDigest,
          row.parserVersion, canonicalTelemetryV12Json(manifest), row.createdAt,
        ]);
        await context.pool.query(`UPDATE ${context.table("telemetry_v12_day_manifests")}
            SET state = 'ready', ready_at = $2
          WHERE id = $1 AND state = 'staged' AND expected_chunk_count = 0`, [row.id, row.createdAt]);
      }
      assert.deepEqual(await readyShape(context, principal), { rows: 3, days: 1 });
      // Ordering by the column's default collation would pin the other row.
      const defaultOrder = await context.pool.query(`SELECT id
        FROM ${context.table("telemetry_v12_day_manifests")}
        WHERE participant_id=$1 AND device_id=$2 AND state='ready'
        ORDER BY chunk_day, created_at, id LIMIT 1`, [principal.participantId, principal.deviceId]);
      assert.equal(defaultOrder.rows[0].id, defaultFirst);

      const predecessor = await context.domain.createPredecessor(principal);
      await assertPinnedDays(context, predecessor, [
        { day, manifestId: cFirst, manifestDigest: digests.get(cFirst) },
      ]);
    }, icuPool);
  });
});
