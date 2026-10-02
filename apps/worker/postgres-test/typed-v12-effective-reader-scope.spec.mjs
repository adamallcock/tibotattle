import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations, readPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
  D0,
  D1,
  D2,
  D3,
  D4,
  D5,
  IDS,
  TIMES,
  seedTypedV12EffectiveScope,
} from "./fixtures/typed-v12-effective-scope.mjs";

/*
 * PostgreSQL 17 qualification of the v1.2 effective reader's selection
 * (src/postgres-typed-v12-effective-reader.ts): its four reads (nonempty
 * days, occurrence candidate pages, occurrence expansion and the runtime
 * record page) select exactly the records of the requested stream in a
 * complete chunk of a ready manifest of the participant's current-head
 * generation on a retained authorization. The fixture holds each of those
 * five filters to a record only that filter excludes, so removing any one of
 * them from any read fails a case below. Each expectation is derived from the
 * fixture's own definitions, never from a read.
 *
 * One random schema with the whole primary chain applied by the production
 * migration runner; nothing outside it is written or dropped.
 *
 * Connection: the private Unix socket (PG_TEST_SOCKET) or loopback TCP
 * (PG_TEST_HOST). Without either, every test skips; a skip is not a pass.
 */

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55433");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SKIP = !PG_TEST_HOST && !PG_TEST_SOCKET;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STREAMS = Object.freeze(["usage", "quota", "session"]);

async function endpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "the v1.2 reader tests require loopback or a private Unix socket");
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
  return { host: PG_TEST_HOST, port: PG_TEST_PORT };
}

let pool;
let vite;
let schema = null;
let reader;
let fixture;
let options;

before(async () => {
  if (SKIP) return;
  pool = new pg.Pool({ ...(await endpoint()), user: PG_TEST_USER, password: PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE, ssl: false, max: 4, connectionTimeoutMillis: 5_000,
    application_name: "pg-typed-v12-effective-reader-scope-test" });
  const version = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.floor(version.rows[0].version / 10_000), 17, "the reader is qualified on PostgreSQL 17");
  vite = await createServer({ root: WORKER_ROOT, configFile: false, logLevel: "error",
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  reader = await vite.ssrLoadModule("/src/postgres-typed-v12-effective-reader.ts");
  const modules = {
    v12codec: await vite.ssrLoadModule("/src/telemetry-v12-typed-codec.ts"),
    sha256Hex: (await vite.ssrLoadModule("/src/crypto.ts")).sha256Hex,
  };
  schema = `typed_v12_scope_${randomBytes(6).toString("hex")}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
  assert.equal(applied.migrations.length, (await readPostgresMigrations({ role: "primary" })).length,
    "the production runner applies the whole primary chain");
  fixture = await seedTypedV12EffectiveScope({ pool, schema, modules });
  options = Object.freeze({ schema: Object.freeze({ primarySchema: schema, ledgerSchema: `${schema}_ledger` }) });
});

after(async () => {
  if (pool) {
    if (schema !== null) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
  if (vite) await vite.close();
});

const ms = (instant) => Date.parse(instant);
/** PostgreSQL's COLLATE "C" order of ASCII occurrence ids. */
const byKey = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
/** Selected records in the reader's (observed_at_ms, occurrence) page order. */
function pageOrder(entries) {
  return [...entries].sort((left, right) => ms(left[2]) - ms(right[2]) || byKey(left[1], right[1]));
}
const record = (role, id, time) => [role, id, time];

/** Every selected papa record per stream and day, by role. */
function papaExpected() {
  return {
    usage: {
      [D1]: pageOrder([record("D", IDS.D, TIMES.D), record("A", IDS.A, TIMES.A), record("B", IDS.B, TIMES.B),
        record("C", IDS.C, TIMES.C), record("SHARED", IDS.SHARED, TIMES.SHARED),
        record("MULTI_D1", IDS.MULTI, TIMES.MULTI_D1), record("E", IDS.E, TIMES.E)]),
      [D3]: pageOrder([record("MULTI_D3", IDS.MULTI, TIMES.MULTI_D3), record("LATE", IDS.LATE, TIMES.LATE)]),
    },
    quota: {
      [D1]: pageOrder([record("QUOTA_TEXT", IDS.QUOTA_TEXT, TIMES.QUOTA),
        record("QUOTA_TYPED", IDS.QUOTA_TYPED, TIMES.QUOTA)]),
    },
    session: { [D1]: [record("SESSION", IDS.SESSION, TIMES.SESSION)] },
  };
}

async function allCandidates(participantId, day, stream, limit) {
  const pages = [];
  let afterCursor;
  for (let index = 0; index < 64; index += 1) {
    const page = await reader.readPostgresTelemetryV12EffectiveCandidatePage(pool,
      { participantId, day, stream, ...(afterCursor ? { after: afterCursor } : {}), limit }, options);
    assert.equal(page.available, true);
    pages.push(page);
    if (page.next === null) return pages;
    afterCursor = page.next;
  }
  throw new Error("candidate paging did not end");
}

async function allRecords(participantId, day, stream, limit) {
  const pages = [];
  let afterCursor;
  for (let index = 0; index < 64; index += 1) {
    const page = await reader.readPostgresTelemetryV12EffectivePage(pool,
      { participantId, day, stream, ...(afterCursor ? { after: afterCursor } : {}), limit }, options);
    assert.equal(page.available, true);
    pages.push(page);
    if (page.next === null) return pages;
    afterCursor = page.next;
  }
  throw new Error("record paging did not end");
}

test("the fixture stores every excluded variant the reads must not select", { skip: SKIP }, async () => {
  const stored = await pool.query(`SELECT manifest.participant_id, manifest.state, record.stream,
      count(*)::integer AS records
    FROM "${schema}".telemetry_v12_typed_records record
    JOIN "${schema}".telemetry_v12_day_manifests manifest ON manifest.id=record.manifest_id
   GROUP BY 1,2,3`);
  const name = Object.fromEntries(Object.entries(fixture.participants).map(([key, value]) => [value, key]));
  assert.deepEqual(stored.rows.map((row) => `${name[row.participant_id]}:${row.state}:${row.stream}:${row.records}`).sort(),
    ["papa:ready:quota:3", "papa:ready:session:1", "papa:ready:usage:13", "papa:staged:usage:1",
      "quebec:ready:usage:3", "romeo:ready:usage:1"].sort());
  const incomplete = await pool.query(`SELECT count(*)::integer AS n FROM "${schema}".telemetry_v12_chunks chunk
    WHERE chunk.record_count <> (SELECT count(*) FROM "${schema}".telemetry_v12_typed_records r WHERE r.chunk_id=chunk.id)`);
  assert.equal(incomplete.rows[0].n, 2, "two stored chunks are incomplete");
  const retained = await pool.query(`SELECT participant_id FROM "${schema}".telemetry_v12_typed_retained_authorizations`);
  assert.deepEqual(retained.rows.map((row) => name[row.participant_id]).sort(), ["papa", "papa", "quebec"]);
  const heads = await pool.query(`SELECT count(*)::integer AS n FROM "${schema}".telemetry_v12_domains generation
    LEFT JOIN "${schema}".telemetry_v12_domain_heads head ON head.generation_id=generation.id
   WHERE head.generation_id IS NULL`);
  assert.equal(heads.rows[0].n, 1, "papa's earlier generation is not a head");
});

test("nonempty days are the head's ready days with a complete chunk of the stream, for a retained owner",
  { skip: SKIP }, async () => {
    const { papa, quebec, romeo } = fixture.participants;
    const days = (participantId, stream, fromDay = D0, throughDay = D5) =>
      reader.readPostgresTelemetryV12EffectiveDays(pool, { participantId, fromDay, throughDay, stream }, options);
    // D2 is staged (ready filter), D4 only in papa's earlier generation (head
    // filter), D0 only quebec's (participant filter) and D3's only quota chunk
    // is incomplete (complete-chunk filter).
    assert.deepEqual(await days(papa, "usage"), [D1, D3]);
    assert.deepEqual(await days(papa, "quota"), [D1]);
    assert.deepEqual(await days(papa, "session"), [D1]);
    assert.deepEqual(await days(papa, "usage", D2, D2), []);
    assert.deepEqual(await days(papa, "usage", D4, D4), []);
    assert.deepEqual(await days(papa, "usage", D3, D5), [D3]);
    assert.deepEqual(await days(quebec, "usage"), [D0, D1]);
    assert.deepEqual(await days(quebec, "quota"), []);
    // romeo has no retained authorization.
    for (const stream of STREAMS) assert.deepEqual(await days(romeo, stream), []);
    await assert.rejects(days(papa, "usage", D0, "2027-01-06"), /TELEMETRY_V12_EFFECTIVE_UNAVAILABLE/u);
  });

test("candidate pages hold each selected occurrence once at its earliest selected time of the day",
  { skip: SKIP }, async () => {
    const { papa, quebec, romeo } = fixture.participants;
    const expected = papaExpected();
    for (const stream of STREAMS) {
      for (const day of [D0, D1, D2, D3, D4, D5]) {
        const want = (expected[stream][day] ?? []).map(([, id, time]) => ({ occurrenceId: id, observedAtMs: ms(time) }));
        const pages = await allCandidates(papa, day, stream, 200);
        assert.equal(pages.length, 1);
        assert.deepEqual(pages[0].records, want, `${stream} ${day}`);
      }
    }
    // Paging two at a time splits the A/B tie and resumes after it.
    const want = expected.usage[D1].map(([, id, time]) => ({ occurrenceId: id, observedAtMs: ms(time) }));
    const pages = await allCandidates(papa, D1, "usage", 2);
    assert.deepEqual(pages.map((page) => page.records), [want.slice(0, 2), want.slice(2, 4), want.slice(4, 6),
      want.slice(6)]);
    assert.deepEqual(pages.map((page) => page.next), [want[1], want[3], want[5], null]);
    // quebec's own record of id A is quebec's candidate only; romeo has none.
    assert.deepEqual((await allCandidates(quebec, D1, "usage", 200))[0].records, pageOrder([
      record("QUEBEC_A", IDS.A, TIMES.QUEBEC_A), record("QUEBEC_ONLY", IDS.QUEBEC_ONLY, TIMES.QUEBEC_ONLY),
    ]).map(([, id, time]) => ({ occurrenceId: id, observedAtMs: ms(time) })));
    assert.deepEqual((await allCandidates(romeo, D1, "usage", 200))[0].records, []);
  });

test("record pages return each selected record once, in page order, with its storage key",
  { skip: SKIP }, async () => {
    const { papa, romeo } = fixture.participants;
    const expected = papaExpected();
    const shape = (page) => page.records.map((item) => [item.sourceRecordKey, item.occurrenceId, item.observedAt]);
    for (const stream of STREAMS) {
      for (const day of [D1, D2, D3, D4]) {
        const want = (expected[stream][day] ?? []).map(([role, id, time]) =>
          [`v12:record:${fixture.rows[role]}`, id, time]);
        const pages = await allRecords(papa, day, stream, 200);
        assert.deepEqual(pages.flatMap(shape), want, `${stream} ${day}`);
      }
    }
    const want = expected.usage[D1].map(([role, id, time]) => [`v12:record:${fixture.rows[role]}`, id, time]);
    const pages = await allRecords(papa, D1, "usage", 3);
    assert.deepEqual(pages.map(shape), [want.slice(0, 3), want.slice(3, 6), want.slice(6)]);
    const session = (await allRecords(papa, D1, "session", 200))[0].records[0];
    assert.deepEqual(JSON.parse(session.recordJson).toolClassCounts, { localShell: 3, web: 1 });
    assert.deepEqual((await allRecords(romeo, D1, "usage", 200)).flatMap(shape), []);
  });

test("the occurrence expansion returns only the selected variants of the requested ids",
  { skip: SKIP }, async () => {
    const { papa, quebec, romeo } = fixture.participants;
    const expand = (participantId, stream, occurrenceIds) => reader.readPostgresTelemetryV12EffectiveOccurrences(
      pool, { participantId, stream, occurrenceIds }, options);
    const requested = [IDS.A, IDS.SHARED, IDS.MULTI, IDS.INCOMPLETE, IDS.STAGED, IDS.OLD_ONLY, IDS.OLD_D4,
      IDS.QUEBEC_ONLY, IDS.ROMEO_ONLY, IDS.ABSENT, IDS.A];
    const shape = (result) => result.records.map((item) => [item.sourceRecordKey, item.occurrenceId, item.observedAt]);
    // Ordered by occurrence id, then time: MULTI's D1 and D3 variants are distinct.
    const want = [["A", IDS.A, TIMES.A], ["SHARED", IDS.SHARED, TIMES.SHARED], ["MULTI_D1", IDS.MULTI, TIMES.MULTI_D1],
      ["MULTI_D3", IDS.MULTI, TIMES.MULTI_D3]]
      .sort((left, right) => byKey(left[1], right[1]) || ms(left[2]) - ms(right[2]))
      .map(([role, id, time]) => [`v12:record:${fixture.rows[role]}`, id, time]);
    const papaRead = await expand(papa, "usage", requested);
    assert.equal(papaRead.available, true);
    assert.deepEqual(shape(papaRead), want);
    assert.deepEqual(shape(await expand(papa, "quota", requested)), []);
    assert.deepEqual(shape(await expand(papa, "quota", [IDS.QUOTA_TEXT, IDS.QUOTA_TYPED, IDS.QUOTA_INCOMPLETE])),
      [["QUOTA_TYPED", IDS.QUOTA_TYPED], ["QUOTA_TEXT", IDS.QUOTA_TEXT]]
        .map(([role, id]) => [`v12:record:${fixture.rows[role]}`, id, TIMES.QUOTA]));
    assert.deepEqual(shape(await expand(quebec, "usage", requested)), [
      ["QUEBEC_A", IDS.A, TIMES.QUEBEC_A], ["QUEBEC_ONLY", IDS.QUEBEC_ONLY, TIMES.QUEBEC_ONLY],
    ].sort((left, right) => byKey(left[1], right[1])).map(([role, id, time]) => [`v12:record:${fixture.rows[role]}`, id, time]));
    assert.deepEqual(shape(await expand(romeo, "usage", requested)), []);
    assert.deepEqual(await expand(papa, "usage", []), { available: false, records: [] });
    await assert.rejects(expand(papa, "usage", Array.from({ length: 201 }, (_, index) =>
      `event:v2:${index.toString(16).padStart(64, "0")}`)), /TELEMETRY_V12_EFFECTIVE_UNAVAILABLE/u);
  });
