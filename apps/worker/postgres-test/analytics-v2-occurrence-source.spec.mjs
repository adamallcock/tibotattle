import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations, readPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { loadExpansionReaders, compareExpansionRead } from "../scripts/gcp-read-expansion-ab.mjs";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";
import {
  CORRECTED_TOTALS,
  D1,
  D2,
  D3,
  NOW_MS,
  OCCURRENCES,
  SOURCE_ID,
  seedAnalyticsV2Fixture,
} from "./fixtures/analytics-v2/direct-seed.mjs";

/*
 * PostgreSQL 17 qualification of the analytics-v2 input side (A-1):
 * src/analytics-v2/{owners,occurrence-source,devices,queued-days}.ts over the
 * existing typed source tables. Each correction-runtime state gets its own
 * random schema with the repository's whole primary chain applied by the
 * production migration runner, then the content-free direct-seed fixture.
 * The TypeScript modules load through Vite with the analytics-v2 resolution
 * (vendored d43c8f92 packages for the vendored kernels), as the job bundles
 * them. Nothing outside the two schemas this spec creates is written or
 * dropped.
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

async function endpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "analytics-v2 source tests require loopback or a private Unix socket");
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
const schemas = [];
const fixtures = {};
let modules;

async function load(path) {
  return vite.ssrLoadModule(path);
}

before(async () => {
  if (SKIP) return;
  pool = new pg.Pool({ ...(await endpoint()), user: PG_TEST_USER, password: PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE, ssl: false, max: 6, connectionTimeoutMillis: 5_000,
    application_name: "pg-analytics-v2-occurrence-source-test" });
  const version = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.floor(version.rows[0].version / 10_000), 17, "the adapter is qualified on PostgreSQL 17");
  vite = await createServer({ root: WORKER_ROOT, configFile: false, logLevel: "error",
    plugins: analyticsV2Config.plugins, resolve: analyticsV2Config.resolve,
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  modules = {
    owners: await load("/src/analytics-v2/owners.ts"),
    occurrences: await load("/src/analytics-v2/occurrence-source.ts"),
    devices: await load("/src/analytics-v2/devices.ts"),
    queued: await load("/src/analytics-v2/queued-days.ts"),
    pin: await load("/src/analytics-v2/pin.ts"),
    authority: await load("/src/postgres-storage-community-authority.ts"),
    seed: {
      codec: await load("/src/typed-telemetry-codec.ts"),
      v12codec: await load("/src/telemetry-v12-typed-codec.ts"),
      reconciliation: await load("/src/telemetry-usage-reconciliation.ts"),
      sha256Hex: (await load("/src/crypto.ts")).sha256Hex,
    },
  };
  const expected = (await readPostgresMigrations({ role: "primary" })).length;
  for (const correctionRuntime of ["active", "staged"]) {
    const schema = `analytics_v2_a1_${randomBytes(6).toString("hex")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
    assert.equal(applied.migrations.length, expected, "the production runner applies the whole primary chain");
    fixtures[correctionRuntime] = { schema, ...(await seedAnalyticsV2Fixture({ pool, schema,
      modules: modules.seed, correctionRuntime })) };
  }
});

after(async () => {
  if (pool) {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
  if (vite) await vite.close();
});

const context = (runtime) => ({ pool, schema: fixtures[runtime].schema, nowMs: NOW_MS });

function only(rows, occurrenceId) {
  const matches = rows.filter((row) => row.occurrenceId === occurrenceId);
  assert.equal(matches.length, 1, "exactly one effective occurrence per id and day");
  return matches[0];
}

async function occurrences(runtime, ownerDigest, stream, fromDay = D1, throughDay = D3) {
  return modules.occurrences.readOwnerOccurrences(context(runtime),
    { ownerDigest, stream, fromDay, throughDay });
}

test("(d)(e) the roster follows production eligibility and source routing at both runtime states",
  { skip: SKIP, timeout: 120_000 }, async () => {
    const expectations = {
      active: { alpha: "effective", bravo: "effective", charlie: "v0.2", echo: "effective" },
      staged: { alpha: "effective", bravo: "mixed", charlie: "v0.2", echo: "v1.1" },
    };
    for (const runtime of ["active", "staged"]) {
      const fixture = fixtures[runtime];
      const listing = await modules.owners.listAnalyticsV2Owners(context(runtime));
      assert.equal(listing.correctionRuntimeActive, runtime === "active");
      const byDigest = new Map(listing.owners.map((owner) => [owner.ownerDigest, owner]));
      assert.deepEqual([...byDigest.keys()].sort(), ["alpha", "bravo", "charlie", "echo"]
        .map((name) => fixture.owners[name].ownerDigest).sort(),
      "delta (a disconnected accountless owner) is excluded; echo (opted out, retained marker) is included");
      assert.equal(byDigest.has(fixture.owners.delta.ownerDigest), false);
      for (const [name, source] of Object.entries(expectations[runtime])) {
        const owner = byDigest.get(fixture.owners[name].ownerDigest);
        assert.equal(owner.participantId, fixture.owners[name].participantId);
        assert.equal(owner.source, source, `${name} routes ${source} with the runtime ${runtime}`);
      }
      const alpha = byDigest.get(fixture.owners.alpha.ownerDigest);
      assert.deepEqual({ hasV1: alpha.hasV1, hasV11: alpha.hasV11, hasV12: alpha.hasV12, hasLegacy: alpha.hasLegacy,
        hasEffective: alpha.hasEffective }, { hasV1: true, hasV11: true, hasV12: true, hasLegacy: false,
        hasEffective: true }, "a v1.2 owner is effective whatever the correction runtime");
      const bravo = byDigest.get(fixture.owners.bravo.ownerDigest);
      assert.deepEqual({ hasV1: bravo.hasV1, hasV11: bravo.hasV11, hasV12: bravo.hasV12, hasLegacy: bravo.hasLegacy,
        hasEffective: bravo.hasEffective }, { hasV1: true, hasV11: false, hasV12: false, hasLegacy: true,
        hasEffective: runtime === "active" }, "a v1 owner is effective only while the correction runtime is active");
      const charlie = byDigest.get(fixture.owners.charlie.ownerDigest);
      assert.deepEqual([charlie.hasV1, charlie.hasV11, charlie.hasV12, charlie.hasLegacy, charlie.hasEffective],
        [false, false, false, true, false]);
      assert.deepEqual(listing.unlinked.map((owner) => [owner.participantId, owner.source]),
        [[fixture.owners.golf.participantId, "v0.2"]], "an eligible owner without a link stays explicit");
      const ordered = listing.owners.map((owner) => owner.participantId);
      assert.deepEqual(ordered, [...ordered].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        "owners are in participant-id byte order");

      // Cross-check the flags against the reviewed wave-1 port of the same
      // D1 owner page. That port reads the operational runtime state, which
      // PostgreSQL pins to staged, so it equals this roster only there.
      const client = await pool.connect();
      try {
        const page = await modules.authority.readPostgresCommunityOwnerPage(client, fixture.schema,
          { sourceId: SOURCE_ID }, { limit: 64 });
        const reference = page.map((owner) => [owner.participantId, owner.ownerDigest, owner.hasV1, owner.hasV11,
          owner.hasV12, owner.hasLegacy, owner.hasEffective]);
        const ours = [...listing.owners, ...listing.unlinked].map((owner) => [owner.participantId,
          owner.ownerDigest ?? null, owner.hasV1, owner.hasV11, owner.hasV12, owner.hasLegacy, owner.hasEffective])
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        if (runtime === "staged") {
          assert.deepEqual(ours, reference, "staged roster equals the wave-1 owner page");
        } else {
          assert.deepEqual(ours.map((row) => row.slice(0, 6)), reference.map((row) => row.slice(0, 6)),
            "the active roster differs from the staged-pinned page only in hasEffective");
        }
      } finally {
        client.release();
      }
    }
  });

test("(a) an occurrence present in v1, v1.1 and v1.2 yields exactly one effective occurrence",
  { skip: SKIP, timeout: 120_000 }, async () => {
    for (const runtime of ["active", "staged"]) {
      const byDay = await occurrences(runtime, fixtures[runtime].owners.alpha.ownerDigest, "usage");
      assert.deepEqual([...byDay.keys()], [D1, D2], "days without candidates are absent, never zero");
      const day1 = byDay.get(D1);
      const shared = only(day1, OCCURRENCES.shared);
      assert.equal(shared.status, "compatible");
      assert.deepEqual(shared.sourceFormats, ["v1", "v11", "v12"]);
      assert.equal(shared.sourceCount, 3);
      assert.equal(shared.eventTime, `${D1}T10:00:00.000Z`);
      const record = JSON.parse(shared.recordJson);
      assert.equal(record.schemaVersion, "usage-event-v1.1");
      assert.equal(record.totalInputContextTokens, 1_000);
      assert.equal(record.components.outputCombinedTokens, 75);
      assert.equal(record.accountPlanAttribution.planType, "pro");
      const v12Only = only(day1, OCCURRENCES.v12Only);
      assert.deepEqual(v12Only.sourceFormats, ["v12"]);
      assert.equal(v12Only.status, "compatible");
      assert.deepEqual(day1.map((row) => row.occurrenceId),
        [OCCURRENCES.shared, OCCURRENCES.v12Only, OCCURRENCES.crossed],
        "rows are ordered by (candidate observedAtMs, occurrenceId)");
      const quota = only((await occurrences(runtime, fixtures[runtime].owners.alpha.ownerDigest, "quota")).get(D1),
        OCCURRENCES.quota);
      assert.equal(quota.status, "compatible");
      assert.deepEqual(quota.sourceFormats, ["v1", "v11"]);
      assert.equal(JSON.parse(quota.recordJson).usedPercent, 35);
    }
  });

test("(c) an event-time disagreement across midnight is a conflict on both candidate days",
  { skip: SKIP, timeout: 120_000 }, async () => {
    const byDay = await occurrences("active", fixtures.active.owners.alpha.ownerDigest, "usage");
    for (const day of [D1, D2]) {
      const crossed = only(byDay.get(day), OCCURRENCES.crossed);
      assert.equal(crossed.status, "conflict", `the crossed occurrence blocks ${day}`);
      assert.equal(crossed.eventTime, null);
      assert.equal(crossed.eventTimeConflict, true);
      assert.equal(crossed.recordJson, null);
      assert.deepEqual(crossed.sourceFormats, ["v1", "v11"]);
    }
    assert.deepEqual(byDay.get(D2).map((row) => row.occurrenceId), [OCCURRENCES.crossed, OCCURRENCES.v11Only],
      "the conflict keeps its own candidate coordinate on each day; no event moves between days");
    await assert.rejects(modules.occurrences.readOwnerOccurrences(context("active"), {
      ownerDigest: fixtures.active.owners.alpha.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3,
      maxCandidates: 4,
    }), (error) => error?.code === "ANALYTICS_V2_SOURCE_LIMIT",
    "five (day, occurrence) candidates exceed a four-candidate bound: a dense owner fails closed before expansion");
    const narrow = await occurrences("active", fixtures.active.owners.alpha.ownerDigest, "usage", D2, D2);
    assert.equal(only(narrow.get(D2), OCCURRENCES.crossed).status, "conflict",
      "a one-day read still expands the other day's variant");
  });

test("(b) a correction fact changes the usage total only while the correction runtime is active",
  { skip: SKIP, timeout: 120_000 }, async () => {
    const active = only((await occurrences("active", fixtures.active.owners.bravo.ownerDigest, "usage")).get(D1),
      OCCURRENCES.corrected);
    assert.equal(active.status, "compatible");
    const corrected = JSON.parse(active.recordJson);
    assert.equal(corrected.totalInputContextTokens, CORRECTED_TOTALS.totalInputContextTokens);
    assert.equal(corrected.components.outputCombinedTokens, CORRECTED_TOTALS.outputCombinedTokens);
    assert.equal(active.sourceCount, 2);
    assert.equal(active.sourceRecordKeys.filter((key) => key.startsWith("v1:history:")).length, 1);

    const staged = only((await occurrences("staged", fixtures.staged.owners.bravo.ownerDigest, "usage")).get(D1),
      OCCURRENCES.corrected);
    assert.equal(staged.status, "compatible");
    const uncorrected = JSON.parse(staged.recordJson);
    assert.equal(uncorrected.totalInputContextTokens, null, "no correction without the active runtime");
    assert.equal(uncorrected.components.outputCombinedTokens, null);
    assert.equal(staged.sourceCount, 1);
    assert.equal(staged.sourceRecordKeys.some((key) => key.includes(":history:")), false);
  });

test("(f) contributing devices follow the three-branch rule with a minimum of one per owner",
  { skip: SKIP, timeout: 120_000 }, async () => {
    const fixture = fixtures.active;
    const member = (name) => ({ participantId: fixture.owners[name].participantId,
      ownerDigest: fixture.owners[name].ownerDigest, source: "effective" });
    const counts = await modules.devices.countContributingDevices(context("active"), { days: new Map([
      [D1, [member("alpha"), member("bravo"), member("echo")]],
      [D2, [member("alpha")]],
      [D3, [member("alpha")]],
    ]) });
    const plain = Object.fromEntries([...counts].map(([day, byOwner]) => [day, Object.fromEntries(
      [...byOwner].map(([ownerDigest, count]) => [Object.keys(fixture.owners)
        .find((name) => fixture.owners[name].ownerDigest === ownerDigest), count]))]));
    assert.deepEqual(plain, {
      // v1 chunk, v1.1 generation and v1.2 generation devices; the fourth
      // device's ready v1.2 manifest has no nonempty chunk and is not counted.
      [D1]: { alpha: 3, bravo: 1, echo: 1 },
      [D2]: { alpha: 1 },
      // A contributing owner with no device evidence that day still counts one.
      [D3]: { alpha: 1 },
    });
    await assert.rejects(modules.devices.countContributingDevices(context("active"), { days: new Map([
      [D1, [{ ...member("bravo"), source: "mixed" }]],
    ]) }), (error) => error?.code === "ANALYTICS_V2_SOURCE_INVALID",
    "a non-effective member is refused rather than counted by the effective rule");
  });

test("queued days are the days named by journal events after the cursor",
  { skip: SKIP, timeout: 120_000 }, async () => {
    const fixture = fixtures.active;
    const all = await modules.queued.readQueuedDays(context("active"), { afterSequence: 0 });
    assert.deepEqual(all.days, [D1, D2, D3]);
    assert.equal(all.lastSequence, fixture.sequences.last);
    assert.equal(all.complete, true);
    assert.deepEqual(all.terminalOwners, []);
    const none = await modules.queued.readQueuedDays(context("active"), { afterSequence: fixture.sequences.last });
    assert.deepEqual({ days: none.days, lastSequence: none.lastSequence, events: none.events },
      { days: [], lastSequence: fixture.sequences.last, events: 0 });
    const one = await modules.queued.readQueuedDays(context("active"),
      { afterSequence: fixture.sequences.alphaV11 - 1, limit: 1 });
    assert.deepEqual({ days: one.days, lastSequence: one.lastSequence, complete: one.complete },
      { days: [D1, D2], lastSequence: fixture.sequences.alphaV11, complete: false },
      "a v1.1 head event names every domain day of its generation");
    const quota = await modules.queued.readQueuedDays(context("active"),
      { afterSequence: fixture.sequences.alphaV1Quota - 1, limit: 1 });
    assert.deepEqual(quota.days, [D1], "a v1 chunk event names its chunk day");
  });

test("(g) reads are deterministic and run in a read-only snapshot", { skip: SKIP, timeout: 120_000 }, async () => {
  const fixture = fixtures.active;
  const read = () => modules.owners.withAnalyticsV2ReadSnapshot(context("active"), async (snapshot) => ({
    owners: await modules.owners.listAnalyticsV2Owners(snapshot),
    usage: [...await modules.occurrences.readOwnerOccurrences(snapshot,
      { ownerDigest: fixture.owners.alpha.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 })],
    corrected: [...await modules.occurrences.readOwnerOccurrences(snapshot,
      { ownerDigest: fixture.owners.bravo.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 })],
    queued: await modules.queued.readQueuedDays(snapshot, { afterSequence: 0 }),
  }));
  const first = JSON.stringify(await read());
  const second = JSON.stringify(await read());
  assert.equal(first, second, "two snapshots of the same source produce byte-identical output");

  let refusedState = null;
  await assert.rejects(modules.owners.withAnalyticsV2ReadSnapshot(context("active"), async (snapshot) => {
    try {
      await snapshot.client.query(`INSERT INTO "${fixture.schema}".typed_telemetry_dictionary(id,value)
        VALUES (999999,'analytics-v2-write-probe')`);
    } catch (error) {
      refusedState = error?.code ?? null;
      throw error;
    }
  }), (error) => error?.name === "PostgresStorageError" && !String(error.message).includes("probe"),
  "the refused write surfaces as the sanitized storage error");
  assert.equal(refusedState, "25006", "PostgreSQL refuses a write inside the read-only snapshot");
  const probe = await pool.query(`SELECT count(*)::integer AS count FROM "${fixture.schema}".typed_telemetry_dictionary
    WHERE value='analytics-v2-write-probe'`);
  assert.equal(probe.rows[0].count, 0);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(modules.owners.listAnalyticsV2Owners({ ...context("active"), client }),
      (error) => error?.code === "ANALYTICS_V2_SOURCE_UNAVAILABLE",
      "a reader refuses a caller transaction that is not read-only");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("the first evidence day is the earliest candidate day over every stream, with no lower bound",
  { skip: SKIP, timeout: 120_000 }, async () => {
    const addDays = (day, delta) => new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000)
      .toISOString().slice(0, 10);
    for (const runtime of ["active", "staged"]) {
      const listing = await modules.owners.listAnalyticsV2Owners(context(runtime));
      const effective = listing.owners.filter((owner) => owner.source === "effective");
      assert.ok(effective.length > 0);
      for (const owner of effective) {
        // The reference: readOwnerOccurrences over 399 days back from D3, every stream.
        const days = [];
        for (const stream of ["usage", "quota", "session"]) {
          days.push(...(await occurrences(runtime, owner.ownerDigest, stream, addDays(D3, -399), D3)).keys());
        }
        const expected = days.sort()[0] ?? null;
        assert.ok(expected !== null, "every fixture effective owner has evidence");
        assert.equal(await modules.occurrences.readOwnerFirstEvidenceDay(context(runtime),
          { ownerDigest: owner.ownerDigest, throughDay: D3 }), expected, `${runtime} ${owner.participantId}`);
        assert.equal(await modules.occurrences.readOwnerFirstEvidenceDay(context(runtime),
          { ownerDigest: owner.ownerDigest, throughDay: addDays(expected, -1) }), null,
        "nothing before the first evidence day");
      }
    }
    await assert.rejects(modules.occurrences.readOwnerFirstEvidenceDay(context("active"),
      { ownerDigest: "not-a-digest", throughDay: D3 }), (error) => error?.code === "ANALYTICS_V2_SOURCE_INVALID");
  });

test("counts equal the reader's per-day occurrences for every owner, stream and runtime (the Job's memory guard input)",
  { skip: SKIP, timeout: 180_000 }, async () => {
    const addDays = (day, delta) => new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000)
      .toISOString().slice(0, 10);
    let compared = 0;
    for (const runtime of ["active", "staged"]) {
      const listing = await modules.owners.listAnalyticsV2Owners(context(runtime));
      for (const owner of listing.owners) {
        for (const stream of ["usage", "quota", "session"]) {
          const options = { ownerDigest: owner.ownerDigest, stream, fromDay: addDays(D3, -399), throughDay: D3 };
          const read = await modules.occurrences.readOwnerOccurrences(context(runtime), options);
          const counts = await modules.occurrences.countOwnerOccurrences(context(runtime), options);
          assert.deepEqual([...counts], [...read].map(([day, rows]) => [day, rows.length]),
            `${runtime} ${owner.participantId} ${stream}`);
          compared += counts.size;
        }
      }
    }
    // The fixture's union cases are all counted once: the v1/v1.1/v1.2 shared
    // occurrence, the crossed-midnight conflict on both days and the corrected one.
    const alpha = fixtures.active.owners.alpha.ownerDigest;
    assert.deepEqual([...await modules.occurrences.countOwnerOccurrences(context("active"),
      { ownerDigest: alpha, stream: "usage", fromDay: D1, throughDay: D3 })], [[D1, 3], [D2, 2]]);
    assert.ok(compared >= 8, "the comparison covered every evidence day of the fixture");
    await assert.rejects(modules.occurrences.countOwnerOccurrences(context("active"),
      { ownerDigest: alpha, stream: "usage", fromDay: D1, throughDay: addDays(D1, 400) }),
    (error) => error?.code === "ANALYTICS_V2_SOURCE_INVALID", "a count spans at most 400 days, as a read");
    assert.equal(modules.occurrences.MAX_ANALYTICS_V2_CANDIDATES, 2_000_000);
    assert.equal(modules.occurrences.MAX_ANALYTICS_V2_BATCH_SOURCE_ROWS, 40_000);
    assert.equal(modules.occurrences.MAX_ANALYTICS_V2_BATCH_V12_ROWS, 40_000);
  });

// Review of c0600bc2 (the v1.2 expansion rewrite): the expansion probes the
// participant's ready manifests for a batch's occurrence ids, so it must keep
// excluding every variant of a requested id that is not in a complete chunk of
// a ready manifest of this participant's generation. Each excluded variant has
// its own event time, so any leak changes the occurrence (sourceCount, status
// and event time), not just a count.
test("the v1.2 expansion excludes a requested occurrence's staged, incomplete and foreign variants",
  { skip: SKIP, timeout: 300_000 }, async () => {
    const schema = `analytics_v2_a1_${randomBytes(6).toString("hex")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const fixture = await seedAnalyticsV2Fixture({ pool, schema, modules: modules.seed, correctionRuntime: "active",
      v12Scope: true });
    const scoped = { pool, schema, nowMs: NOW_MS };
    const read = (name) => modules.occurrences.readOwnerOccurrences(scoped,
      { ownerDigest: fixture.owners[name].ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 });
    // Stored: india's eligible record and its staged and incomplete variants
    // (one id, three event times), and juliet's record of the same id.
    const stored = await pool.query(`SELECT manifest.participant_id, manifest.state, chunk.record_count,
        count(DISTINCT record.occurrence_id)::integer AS ids, count(*)::integer AS records
      FROM "${schema}".telemetry_v12_typed_records record
      JOIN "${schema}".telemetry_v12_day_manifests manifest ON manifest.id=record.manifest_id
      JOIN "${schema}".telemetry_v12_chunks chunk ON chunk.id=record.chunk_id
     WHERE manifest.participant_id = ANY($1)
     GROUP BY 1,2,3 ORDER BY 1,2,3`, [[fixture.owners.india.participantId, fixture.owners.juliet.participantId]]);
    const india0 = fixture.owners.india.participantId, juliet0 = fixture.owners.juliet.participantId;
    assert.deepEqual(stored.rows.map((row) => [row.participant_id === india0 ? "india" : row.participant_id === juliet0
      ? "juliet" : "?", row.state, row.record_count, row.ids, row.records]).sort(),
    [["india", "ready", 1, 1, 1], ["india", "ready", 2, 1, 1], ["india", "staged", 1, 1, 1],
      ["juliet", "ready", 1, 1, 1]].sort(), "one eligible record and three ineligible variants are stored");
    const ids = await pool.query(`SELECT count(DISTINCT record.occurrence_id)::integer AS n
      FROM "${schema}".telemetry_v12_typed_records record
      JOIN "${schema}".telemetry_v12_day_manifests manifest ON manifest.id=record.manifest_id
     WHERE manifest.participant_id = ANY($1)`, [[india0, juliet0]]);
    assert.equal(ids.rows[0].n, 1, "all four share one occurrence id");
    const india = await read("india");
    assert.deepEqual([...india.keys()], [D1]);
    const occurrence = only(india.get(D1), OCCURRENCES.scoped);
    assert.deepEqual({ status: occurrence.status, sourceFormats: occurrence.sourceFormats,
      sourceCount: occurrence.sourceCount, eventTime: occurrence.eventTime },
    { status: "compatible", sourceFormats: ["v12"], sourceCount: 1, eventTime: `${D1}T11:00:00.000Z` });
    assert.equal(india.get(D1).length, 1);
    // Another participant's record of the same id is that participant's own occurrence only.
    const juliet = only((await read("juliet")).get(D1), OCCURRENCES.scoped);
    assert.deepEqual({ status: juliet.status, sourceCount: juliet.sourceCount, eventTime: juliet.eventTime },
      { status: "compatible", sourceCount: 1, eventTime: `${D1}T12:30:00.000Z` });
    // The count the memory guard reads agrees with the expansion.
    assert.deepEqual([...await modules.occurrences.countOwnerOccurrences(scoped,
      { ownerDigest: fixture.owners.india.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 })], [[D1, 1]]);
  });

test("the legacy expansion and candidates exclude superseded, incomplete and foreign variants and keep the day edges",
  { skip: SKIP, timeout: 300_000 }, async () => {
    // C-REFRESH rewrote both legacy statements to fence the owner's devices,
    // manifests and day range first; the full admission joins still decide.
    const schema = `analytics_v2_a1_${randomBytes(6).toString("hex")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const fixture = await seedAnalyticsV2Fixture({ pool, schema, modules: modules.seed, correctionRuntime: "active",
      legacyScope: true });
    const scoped = { pool, schema, nowMs: NOW_MS };
    const read = (name, fromDay = D1, throughDay = D3) => modules.occurrences.readOwnerOccurrences(scoped,
      { ownerDigest: fixture.owners[name].ownerDigest, stream: "usage", fromDay, throughDay });
    const count = (name, fromDay = D1, throughDay = D3) => modules.occurrences.countOwnerOccurrences(scoped,
      { ownerDigest: fixture.owners[name].ownerDigest, stream: "usage", fromDay, throughDay });
    // Stored: four records of one id (three of lima's v1 devices, one of mike's v1.1).
    const stored = await pool.query(`SELECT count(*)::integer AS records, count(DISTINCT owner_id)::integer AS owners
      FROM "${schema}".typed_telemetry_records WHERE occurrence_id=$1`,
    [Buffer.from(modules.seed.codec.encodeTypedTelemetryId(OCCURRENCES.legacyScoped))]);
    assert.deepEqual(stored.rows[0], { records: 4, owners: 2 }, "one eligible record and three ineligible variants");
    const lima = await read("lima");
    assert.deepEqual([...lima.keys()], [D1, D3]);
    const occurrence = only(lima.get(D1), OCCURRENCES.legacyScoped);
    assert.deepEqual({ status: occurrence.status, sourceFormats: occurrence.sourceFormats,
      sourceCount: occurrence.sourceCount, eventTime: occurrence.eventTime },
    { status: "compatible", sourceFormats: ["v1"], sourceCount: 1, eventTime: `${D1}T10:00:00.000Z` });
    // The incomplete chunk's peer is excluded with it; the day edges are kept.
    assert.deepEqual(lima.get(D1).map((row) => row.occurrenceId).sort(),
      [OCCURRENCES.legacyFirst, OCCURRENCES.legacyScoped].sort());
    assert.deepEqual(lima.get(D3).map((row) => row.occurrenceId), [OCCURRENCES.legacyLast]);
    assert.deepEqual([...await count("lima")], [[D1, 2], [D3, 1]]);
    // A range starting after D1 or ending before D3 drops exactly that edge.
    assert.deepEqual([...(await read("lima", D2, D3))].map(([day, rows]) => [day, rows.map((row) => row.occurrenceId)]),
      [[D3, [OCCURRENCES.legacyLast]]]);
    assert.deepEqual([...(await read("lima", D1, D2))].map(([day, rows]) => [day, rows.map((row) => row.occurrenceId).sort()]),
      [[D1, [OCCURRENCES.legacyFirst, OCCURRENCES.legacyScoped].sort()]]);
    assert.deepEqual([...await count("lima", D2, D3)], [[D3, 1]]);
    assert.deepEqual([...await count("lima", D1, D2)], [[D1, 2]]);
    assert.equal(await modules.occurrences.readOwnerFirstEvidenceDay(scoped,
      { ownerDigest: fixture.owners.lima.ownerDigest, throughDay: D3 }), D1);
    // Another participant's record of the same id is that participant's own occurrence only.
    const mike = only((await read("mike")).get(D1), OCCURRENCES.legacyScoped);
    assert.deepEqual({ status: mike.status, sourceFormats: mike.sourceFormats, sourceCount: mike.sourceCount,
      eventTime: mike.eventTime }, { status: "compatible", sourceFormats: ["v11"], sourceCount: 1,
      eventTime: `${D1}T11:00:00.000Z` });
  });

test("a v1.1 chunk whose proofs do not cover its record count is excluded from candidates, counts, first evidence and expansion",
  { skip: SKIP, timeout: 300_000 }, async () => {
    // REFRESH-OPT d3 moved the v1.1 completeness count out of the per-record
    // LATERAL into one count per chunk; the predicate on each row is unchanged.
    const schema = `analytics_v2_a1_${randomBytes(6).toString("hex")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const fixture = await seedAnalyticsV2Fixture({ pool, schema, modules: modules.seed, correctionRuntime: "active",
      legacyScope: true });
    const scoped = { pool, schema, nowMs: NOW_MS };
    const observe = async (name) => {
      const ownerDigest = fixture.owners[name].ownerDigest;
      const rows = await modules.occurrences.readOwnerOccurrences(scoped,
        { ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 });
      return {
        read: [...rows].map(([day, values]) => [day,
          values.map((row) => [row.occurrenceId, row.sourceFormats.join()]).sort()]),
        counts: [...await modules.occurrences.countOwnerOccurrences(scoped,
          { ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 })],
        first: await modules.occurrences.readOwnerFirstEvidenceDay(scoped, { ownerDigest, throughDay: D3 }),
      };
    };
    // The v1.1 chunks holding the participant's D1 records.
    const d1Chunks = async (name) => (await pool.query(`SELECT DISTINCT chunk.id
        FROM "${schema}".telemetry_v11_chunks chunk
        JOIN "${schema}".typed_v11_chunk_allocations allocation ON allocation.chunk_id=chunk.id
        JOIN "${schema}".typed_telemetry_chunks physical ON physical.namespace_id=allocation.namespace_id
         AND physical.format=11 AND physical.original_id=allocation.chunk_original
        JOIN "${schema}".typed_v11_record_proofs proof ON proof.chunk_key=physical.id
        JOIN "${schema}".typed_telemetry_records record ON record.id=proof.typed_record_id
       WHERE chunk.participant_id=$1 AND record.observed_day=$2::integer ORDER BY chunk.id`,
    [fixture.owners[name].participantId, Date.parse(`${D1}T00:00:00.000Z`) / 86_400_000])).rows.map((row) => row.id);
    // A chunk admitted with fewer proofs than its record count. Published
    // chunks are immutable (telemetry_source_immutable), so the synthetic
    // fixture's count is shifted with triggers off for this one statement.
    const shiftRecordCount = async (ids, delta) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(`UPDATE "${schema}".telemetry_v11_chunks SET record_count=record_count+$2
          WHERE id=ANY($1::text[])`, [ids, delta]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    const before = { lima: await observe("lima"), mike: await observe("mike") };
    assert.deepEqual(before.mike.read, [[D1, [[OCCURRENCES.legacyScoped, "v11"]]]]);
    assert.ok(before.lima.read.find(([day]) => day === D1)[1].some(([id]) => id === OCCURRENCES.legacyFirst));
    const incomplete = [...await d1Chunks("mike"), ...await d1Chunks("lima")];
    assert.equal(incomplete.length, 2);
    await shiftRecordCount(incomplete, 1);
    // mike's only record and lima's D1 v1.1 record leave every reader; lima's
    // v1 records and her D3 v1.1 record (another chunk) stay.
    assert.deepEqual(await observe("mike"), { read: [], counts: [], first: null });
    const lima = await observe("lima");
    assert.deepEqual(lima.read, before.lima.read.map(([day, values]) => [day,
      values.filter(([id]) => id !== OCCURRENCES.legacyFirst)]));
    assert.deepEqual(lima.counts, before.lima.counts.map(([day, count]) => [day, day === D1 ? count - 1 : count]));
    assert.equal(lima.first, D1);
    await shiftRecordCount(incomplete, -1);
    assert.deepEqual({ lima: await observe("lima"), mike: await observe("mike") }, before);
  });

// ---------------------------------------------------------------------------
// K-READ: prepared statements, generic plans, F(o,d) and W(o); N-EXCL
// ---------------------------------------------------------------------------

const STREAMS = ["usage", "quota", "session"];
const shift = (day, delta) => new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000).toISOString().slice(0, 10);

/** Per-day evidence digests of the reader's output (the pin's day digests), every stream. */
async function dayDigests(scoped, ownerDigest, fromDay, throughDay) {
  const byDay = new Map();
  for (const stream of STREAMS) {
    for (const [day, rows] of await modules.occurrences.readOwnerOccurrences(scoped,
      { ownerDigest, stream, fromDay, throughDay })) {
      const entry = byDay.get(day) ?? { usage: [], quota: [], session: [] };
      entry[stream] = rows;
      byDay.set(day, entry);
    }
  }
  const digests = new Map();
  for (const [day, value] of byDay) digests.set(day, await modules.pin.analyticsV2DayDigest(day, value));
  return digests;
}

test("K-READ: reader statements are tagged and prepared, generic plans stay inside the reader, outputs unchanged",
  { skip: SKIP, timeout: 180_000 }, async () => {
    const fixture = fixtures.active;
    const ownerDigest = fixture.owners.alpha.ownerDigest;
    // In a caller's snapshot: the reader leaves the caller's plan_cache_mode as it found it.
    const observed = await modules.owners.withAnalyticsV2ReadSnapshot(context("active"), async (snapshot) => {
      const before = (await snapshot.client.query("SELECT current_setting('plan_cache_mode') AS mode")).rows[0].mode;
      const first = await modules.occurrences.readOwnerOccurrences(snapshot,
        { ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 });
      const after = (await snapshot.client.query("SELECT current_setting('plan_cache_mode') AS mode")).rows[0].mode;
      // The same connection now holds the prepared statements; a second call reuses them.
      const prepared = (await snapshot.client.query(`SELECT count(*)::integer AS n FROM pg_prepared_statements
        WHERE name LIKE 'a2\\_%'`)).rows[0].n;
      const second = await modules.occurrences.readOwnerOccurrences(snapshot,
        { ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 });
      return { before, after, prepared, first: JSON.stringify([...first]), second: JSON.stringify([...second]) };
    });
    assert.equal(observed.before, "auto");
    assert.equal(observed.after, "auto", "the generic-plan setting is transaction-local to the expansion");
    assert.ok(observed.prepared >= 2, "the scope and expansion statements are server-side prepared");
    assert.equal(observed.first, observed.second);
    // Every statement family is a closed code constant; a tag never carries a value.
    assert.ok(modules.owners.ANALYTICS_V2_STATEMENT_FAMILIES.includes("occurrences.v12_sources"));
    assert.match(modules.owners.analyticsV2Statement("occurrences.scope", "SELECT 1"),
      /^\/\* analytics_v2:occurrences\.scope \*\/ SELECT 1$/u);
    assert.throws(() => modules.owners.analyticsV2Statement("occurrences.unknown", "SELECT 1"),
      (error) => error?.code === "ANALYTICS_V2_SOURCE_INVALID");
    const statement = await modules.owners.analyticsV2PreparedStatement("occurrences.scope", "SELECT 1");
    assert.match(statement.name, /^a2_occurrences_scope_[0-9a-f]{16}$/u);
  });

test("K-READ: F(o,d) names exactly the reader's evidence days, is stable, and is local to the owner",
  { skip: SKIP, timeout: 300_000 }, async () => {
    for (const runtime of ["active", "staged"]) {
      const listing = await modules.owners.listAnalyticsV2Owners(context(runtime));
      for (const owner of listing.owners.filter((candidate) => candidate.source === "effective")) {
        const range = { ownerDigest: owner.ownerDigest, fromDay: shift(D3, -399), throughDay: D3 };
        const fingerprints = await modules.occurrences.readOwnerDayFingerprints(context(runtime), range);
        const digests = await dayDigests(context(runtime), owner.ownerDigest, range.fromDay, range.throughDay);
        assert.deepEqual([...fingerprints.keys()], [...digests.keys()].sort(), `${runtime} ${owner.participantId}`);
        for (const value of fingerprints.values()) assert.match(value, /^[0-9a-f]{64}$/u);
        assert.deepEqual([...await modules.occurrences.readOwnerDayFingerprints(context(runtime), range)],
          [...fingerprints], "deterministic");
      }
    }
    // The same owner's evidence in another schema with more owners has the same fingerprints.
    const schema = `analytics_v2_a1_${randomBytes(6).toString("hex")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const wider = await seedAnalyticsV2Fixture({ pool, schema, modules: modules.seed, correctionRuntime: "active",
      v12Scope: true });
    const alpha = fixtures.active.owners.alpha.ownerDigest;
    assert.equal(wider.owners.alpha.ownerDigest, alpha);
    assert.deepEqual([...await modules.occurrences.readOwnerDayFingerprints({ pool, schema, nowMs: NOW_MS },
      { ownerDigest: alpha, fromDay: D1, throughDay: D3 })],
    [...await modules.occurrences.readOwnerDayFingerprints(context("active"),
      { ownerDigest: alpha, fromDay: D1, throughDay: D3 })], "other owners' evidence moves no fingerprint");
    await assert.rejects(modules.occurrences.readOwnerDayFingerprints(context("active"),
      { ownerDigest: alpha, fromDay: D1, throughDay: shift(D1, 400) }), (error) => error?.code === "ANALYTICS_V2_SOURCE_INVALID");
  });

test("K-READ: every reader-output change moves F(o,d) on that day (mutation proof over a v1.2 chunk and the correction runtime)",
  { skip: SKIP, timeout: 300_000 }, async () => {
    // Soundness, per owner and day: an unchanged fingerprint means an
    // unchanged day digest. Over-invalidation (F moves, output does not) is
    // allowed; the converse is the defect this proves absent.
    const proveSound = (label, before, after) => {
      const days = new Set([...before.digests.keys(), ...after.digests.keys(), ...before.fingerprints.keys(),
        ...after.fingerprints.keys()]);
      let moved = 0;
      for (const day of days) {
        const outputChanged = before.digests.get(day) !== after.digests.get(day);
        const fingerprintChanged = before.fingerprints.get(day) !== after.fingerprints.get(day);
        if (outputChanged) {
          moved += 1;
          assert.ok(fingerprintChanged, `${label}: ${day} changed output under an unchanged fingerprint`);
        }
      }
      return moved;
    };
    const capture = async (scoped, ownerDigest) => ({
      digests: await dayDigests(scoped, ownerDigest, shift(D3, -30), D3),
      fingerprints: await modules.occurrences.readOwnerDayFingerprints(scoped,
        { ownerDigest, fromDay: shift(D3, -30), throughDay: D3 }),
    });
    // The correction runtime: the same evidence read with and without corrections.
    let runtimeMoves = 0;
    // Owners the reader reads at both runtimes (linked, with a source family either way).
    const linked = (await modules.owners.listAnalyticsV2Owners(context("active"))).owners
      .filter((owner) => owner.hasV1 || owner.hasV11 || owner.hasV12);
    assert.ok(linked.length > 1);
    for (const owner of linked) {
      const before = await capture(context("active"), owner.ownerDigest);
      const after = await capture(context("staged"), owner.ownerDigest);
      runtimeMoves += proveSound(`runtime ${owner.participantId}`, before, after);
    }
    assert.ok(runtimeMoves > 0, "the correction runtime changes some owner-day's output");

    // A v1.2 chunk made incomplete: its records leave the reader's selection.
    const schema = `analytics_v2_a1_${randomBytes(6).toString("hex")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const fixture = await seedAnalyticsV2Fixture({ pool, schema, modules: modules.seed, correctionRuntime: "active",
      v12Scope: true });
    const scoped = { pool, schema, nowMs: NOW_MS };
    const india = fixture.owners.india;
    const before = await capture(scoped, india.ownerDigest);
    const client = await pool.connect();
    try {
      // Test-only: the typed tables' guards refuse this mutation, which is the point of
      // seeing what the reader and F do if it ever happened.
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const deleted = await client.query(`DELETE FROM "${schema}".telemetry_v12_typed_records WHERE id = (
          SELECT record.id FROM "${schema}".telemetry_v12_typed_records record
            JOIN "${schema}".telemetry_v12_day_manifests manifest ON manifest.id = record.manifest_id
           WHERE manifest.participant_id = $1 AND manifest.state = 'ready' ORDER BY record.id LIMIT 1)`,
      [india.participantId]);
      assert.equal(deleted.rowCount, 1);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const after = await capture(scoped, india.ownerDigest);
    assert.ok(proveSound("incomplete v1.2 chunk", before, after) > 0, "the deletion changed india's output");
  });

test("K-READ: W(o) is stable, local to the owner, and moves with the owner's journal head and scope",
  { skip: SKIP, timeout: 180_000 }, async () => {
    const fixture = fixtures.active;
    const owners = Object.values(fixture.owners).map((owner) => owner.ownerDigest).filter((digest) => typeof digest === "string");
    const first = await modules.occurrences.readOwnerWatermarks(context("active"), owners);
    assert.deepEqual([...first.keys()].sort(), [...owners].sort());
    assert.deepEqual([...await modules.occurrences.readOwnerWatermarks(context("active"), owners)], [...first]);
    // The correction runtime is part of every owner's scope.
    const staged = await modules.occurrences.readOwnerWatermarks(context("staged"), owners);
    assert.ok(owners.every((digest) => staged.get(digest) !== first.get(digest)));
    // A journal-head move changes that owner's watermark only (in a copy of the fixture).
    const alpha = fixture.owners.alpha.ownerDigest;
    const schema = `analytics_v2_a1_${randomBytes(6).toString("hex")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const copy = await seedAnalyticsV2Fixture({ pool, schema, modules: modules.seed, correctionRuntime: "active" });
    const scoped = { pool, schema, nowMs: NOW_MS };
    const base = await modules.occurrences.readOwnerWatermarks(scoped, owners);
    assert.deepEqual([...base], [...first], "the same evidence and scope in another schema has the same watermarks");
    const heads = await pool.query(`SELECT count(*)::integer AS n FROM "${schema}".storage_owner_revisions
      WHERE owner_digest = $1`, [alpha]);
    assert.equal(heads.rows[0].n, 1, "the fixture holds alpha's journal head");
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SET LOCAL session_replication_role = replica");
      await writer.query(`UPDATE "${schema}".storage_owner_revisions SET last_sequence = last_sequence + 1,
        revision = revision + 1 WHERE owner_digest = $1`, [alpha]);
      await writer.query("COMMIT");
    } finally {
      writer.release();
    }
    const moved = await modules.occurrences.readOwnerWatermarks(scoped, owners);
    for (const digest of owners) {
      assert.equal(moved.get(digest) !== base.get(digest), digest === alpha, digest);
    }
    assert.equal(copy.owners.alpha.ownerDigest, alpha);
    await assert.rejects(modules.occurrences.readOwnerWatermarks(scoped, ["not-a-digest"]),
      (error) => error?.code === "ANALYTICS_V2_SOURCE_INVALID");
    await assert.rejects(modules.occurrences.readOwnerWatermarks(scoped, [alpha, alpha]),
      (error) => error?.code === "ANALYTICS_V2_SOURCE_INVALID");
  });

test("N-EXCL: the exclusions are read whole and fail closed; F(o,d) and W(o) move with an exclusion of the owner",
  { skip: SKIP, timeout: 300_000 }, async () => {
    const schema = `analytics_v2_a1_${randomBytes(6).toString("hex")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const fixture = await seedAnalyticsV2Fixture({ pool, schema, modules: modules.seed, correctionRuntime: "active" });
    const scoped = { pool, schema, nowMs: NOW_MS };
    const table = `"${schema}".community_aggregate_exclusions`;
    const exclusions = await load("/src/analytics-v2/exclusions.ts");
    const read = () => modules.owners.readAnalyticsV2Exclusions(scoped);
    const summary = (value) => ({ rows: value.rows, active: value.active,
      participants: [...value.activeByParticipant.keys()].sort() });
    const insert = (id, participantId, state, effectiveAt, expiresAt) => pool.query(`INSERT INTO ${table}
        (exclusion_id, participant_id, scope, reason_code, state, effective_at, expires_at, created_at, created_by_digest,
         revoked_at, revoked_by_digest)
      VALUES ($1, $2, 'community_weekly', 'manual_review', $3, $4, $5, $4, $6, $7, $8)`, [id, participantId, state,
      effectiveAt, expiresAt, "c".repeat(64), state === "revoked" ? effectiveAt : null, state === "revoked" ? "d".repeat(64) : null]);
    const alpha = fixture.owners.alpha;
    const bravo = fixture.owners.bravo;
    const owners = [alpha.ownerDigest, bravo.ownerDigest];
    const fingerprints = (ownerDigest) => modules.occurrences.readOwnerDayFingerprints(scoped,
      { ownerDigest, fromDay: shift(D3, -30), throughDay: D3 });

    // The primary table (0066) with no rows.
    const empty = await read();
    assert.deepEqual(summary(empty), { rows: 0, active: 0, participants: [] });
    assert.equal(empty.sha256, exclusions.ANALYTICS_V2_NO_EXCLUSIONS_SHA256);
    const alphaBefore = await fingerprints(alpha.ownerDigest);
    const bravoBefore = await fingerprints(bravo.ownerDigest);
    assert.ok(alphaBefore.has(D2), "alpha has evidence on D2");
    const watermarksBefore = await modules.occurrences.readOwnerWatermarks(scoped, owners);

    // An active exclusion of alpha covering D2 exactly, at microsecond resolution.
    await insert("x1", alpha.participantId, "active", `${D2}T00:00:00.000000Z`, `${shift(D2, 1)}T00:00:00.000000Z`);
    const one = await read();
    assert.deepEqual(summary(one), { rows: 1, active: 1, participants: [alpha.participantId] });
    const dayUs = Date.parse(`${D2}T00:00:00.000Z`) * 1_000;
    assert.deepEqual(one.activeByParticipant.get(alpha.participantId),
      [{ effectiveAtUs: dayUs, expiresAtUs: dayUs + 86_400_000_000 }]);
    assert.notEqual(one.sha256, empty.sha256);
    // F(o,d) moves for alpha's covered day only; another owner's does not.
    const alphaAfter = await fingerprints(alpha.ownerDigest);
    assert.deepEqual([...alphaAfter.keys()], [...alphaBefore.keys()]);
    for (const [day, fingerprint] of alphaAfter) {
      assert.equal(fingerprint !== alphaBefore.get(day), day === D2, day);
    }
    assert.deepEqual([...await fingerprints(bravo.ownerDigest)], [...bravoBefore]);
    const watermarksOne = await modules.occurrences.readOwnerWatermarks(scoped, owners);
    assert.notEqual(watermarksOne.get(alpha.ownerDigest), watermarksBefore.get(alpha.ownerDigest));
    assert.equal(watermarksOne.get(bravo.ownerDigest), watermarksBefore.get(bravo.ownerDigest));

    // A revoked row is history: it applies to no day and moves no fingerprint,
    // but it is in the table's digest and the owner's watermark.
    await insert("x2", bravo.participantId, "revoked", `${D1}T00:00:00.000000Z`, null);
    const two = await read();
    assert.deepEqual(summary(two), { rows: 2, active: 1, participants: [alpha.participantId] });
    assert.notEqual(two.sha256, one.sha256);
    assert.deepEqual([...await fingerprints(bravo.ownerDigest)], [...bravoBefore]);
    const watermarksTwo = await modules.occurrences.readOwnerWatermarks(scoped, owners);
    assert.notEqual(watermarksTwo.get(bravo.ownerDigest), watermarksOne.get(bravo.ownerDigest));
    assert.equal(watermarksTwo.get(alpha.ownerDigest), watermarksOne.get(alpha.ownerDigest));
    // Sub-millisecond instants are kept exactly (PostgreSQL's own resolution).
    await insert("x3", alpha.participantId, "active", `${D3}T23:59:59.999999Z`, null);
    assert.deepEqual((await read()).activeByParticipant.get(alpha.participantId)[1],
      { effectiveAtUs: Date.parse(`${D3}T23:59:59.999Z`) * 1_000 + 999, expiresAtUs: null });

    // A scope the contract does not define is refused, not ignored (the
    // table's CHECK is dropped here only to plant one).
    const check = await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass
      AND pg_get_constraintdef(oid) LIKE '%community_weekly%'`, [table]);
    assert.equal(check.rows.length, 1);
    await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT "${check.rows[0].conname}"`);
    await pool.query(`INSERT INTO ${table} (exclusion_id, participant_id, scope, reason_code, state, effective_at,
        created_at, created_by_digest) VALUES ('x4', 'participant:synthetic', 'community_daily', 'other', 'active',
        now(), now(), $1)`, ["c".repeat(64)]);
    await assert.rejects(read(), (error) => error?.code === "ANALYTICS_V2_SOURCE_CONFLICT", "an undefined scope");
    // The table is required: its absence is never "no exclusions".
    await pool.query(`ALTER TABLE ${table} RENAME TO community_aggregate_exclusions_hidden`);
    await assert.rejects(read(), (error) => error?.code === "ANALYTICS_V2_SOURCE_UNAVAILABLE", "an absent table");
  });


test("READ-EXPANSION: empty families skip only with same-snapshot proofs and settings restore", { skip: SKIP }, async () => {
  await modules.owners.withAnalyticsV2ReadSnapshot(context("active"), async (snapshot) => {
    await snapshot.client.query("SELECT set_config('jit','on',true),set_config('work_mem','8MB',true)");
    const seen = [];
    const client = { query: async (...args) => {
      const statement = typeof args[0] === "string" ? args[0] : args[0].text;
      if (/analytics_v2:occurrences\.(legacy_sources|v12_sources|correction_sources)/u.test(statement)) {
        const settings = (await snapshot.client.query("SELECT current_setting('jit') AS jit,current_setting('work_mem') AS mem")).rows[0];
        assert.deepEqual(settings, { jit: "off", mem: "64MB" });
        seen.push(statement.match(/analytics_v2:occurrences\.([a-z_]+)/u)[1]);
      }
      return snapshot.client.query(...args);
    } };
    await modules.occurrences.readOwnerOccurrences({ ...snapshot, client }, {
      ownerDigest: fixtures.active.owners.echo.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3,
    });
    assert.ok(seen.includes("legacy_sources"));
    assert.equal(seen.includes("v12_sources"), false);
    assert.equal(seen.includes("correction_sources"), false);
    seen.length = 0;
    await modules.occurrences.readOwnerOccurrences({ ...snapshot, client }, {
      ownerDigest: fixtures.active.owners.bravo.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3,
    });
    assert.ok(seen.includes("correction_sources"), "method-version-1 correction facts are never skipped");
    const restored = (await snapshot.client.query("SELECT current_setting('jit') AS jit,current_setting('work_mem') AS mem")).rows[0];
    assert.deepEqual(restored, { jit: "on", mem: "8MB" });
    const failure = new Error("synthetic-expansion-cancelled");
    await assert.rejects(modules.owners.withGenericPlans(snapshot.client, async () => { throw failure; }),
      (error) => error === failure);
    const failedRestore = (await snapshot.client.query("SELECT current_setting('jit') AS jit,current_setting('work_mem') AS mem")).rows[0];
    assert.deepEqual(failedRestore, restored, "caller settings restore after an operation refusal");
  });
});


test("READ-EXPANSION: base/candidate Maps and fingerprints match on one snapshot with positive grouped corrections", { skip: SKIP, timeout: 180_000 }, async () => {
  const schema = `analytics_v2_expand_${randomBytes(6).toString("hex")}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  await applyPostgresMigrations({ role: "primary", schema, pool });
  const fixture = await seedAnalyticsV2Fixture({ pool, schema, modules: modules.seed,
    correctionRuntime: "active", expansionCorrections: true, denseLegacy: { days: 1, usagePerDay: 420 } });
  const readers = await loadExpansionReaders();
  const familyFirst = await loadExpansionReaders({ candidateSourceTransform: (source) => {
    const first = source.indexOf("      for (let ordinal = 0; ordinal < complete; ordinal += 1) {");
    const last = source.indexOf("      first += complete;", first);
    assert.ok(first > 0 && last > first);
    return source.slice(0, first) + `      for (let family = 0; family < 3; family += 1) {
        for (let ordinal = 0; ordinal < complete; ordinal += 1) {
          yield { ids: remaining[ordinal]!,
            get legacy() { return family === 0 ? rowsFor(legacy, ordinal) : []; },
            get v12() { return family === 1 ? rowsFor(v12, ordinal) : []; },
            get facts() { return family === 2 ? rowsFor(facts, ordinal) : []; } };
        }
      }
` + source.slice(last);
  } });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshotId = (await client.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
    assert.match(snapshotId, /^[0-9A-F]+-[0-9A-F]+-[0-9]+$/u);
    const observed = [];
    const tracking = { query: async (...args) => {
      const result = await client.query(...args);
      const text = typeof args[0] === "string" ? args[0] : args[0].text;
      if (/analytics_v2:occurrences\.(legacy_sources|v12_sources|correction_sources)/u.test(text)) {
        observed.push({ text, rows: result.rows });
        if (text.includes("WITH ORDINALITY")) {
          assert.ok(result.rows.length <= modules.occurrences.MAX_ANALYTICS_V2_EXPANSION_GROUP_ROWS + 1);
          const counts = new Map();
          for (const row of result.rows) counts.set(row.sub_batch, (counts.get(row.sub_batch) ?? 0) + 1);
          for (const count of counts.values()) assert.ok(count <= 40001);
        }
      }
      return result;
    } };
    const scoped = { pool, client: tracking, schema, nowMs: NOW_MS };
    for (const owner of Object.values(fixture.owners).filter((entry) => entry.ownerDigest && entry.devices.length)) {
      for (const stream of STREAMS) await compareExpansionRead(readers, scoped,
        { ownerDigest: owner.ownerDigest, stream, fromDay: D1, throughDay: D3 });
    }
    const facts = observed.filter((entry) => entry.text.includes("occurrences.correction_sources")
      && entry.text.includes("WITH ORDINALITY") && entry.rows.length > 1000);
    assert.ok(facts.length > 0);
    assert.ok(new Set(facts[0].rows.map((row) => row.sub_batch)).size >= 2);
    for (const ordinal of new Set(facts[0].rows.map((row) => row.sub_batch))) {
      const ids = facts[0].rows.filter((row) => row.sub_batch === ordinal).map((row) => row.fact_id);
      assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "facts keep their physical id order within each batch");
    }
    const factSamples = facts[0].rows;
    const target = (index) => `event:readexp:${String(index).padStart(5, "0")}`;
    const encodedId = (id) => Buffer.from(modules.seed.codec.encodeTypedTelemetryId(id)).toString("hex");
    const sample = (rows, id) => rows.find((row) => Buffer.from(row.occurrence_id).toString("hex") === encodedId(id));
    const refusalCases = [
      { conflict: 0, limit: 200, code: "ANALYTICS_V2_SOURCE_CONFLICT" },
      { conflict: 200, limit: 0, code: "ANALYTICS_V2_SOURCE_LIMIT" },
    ];
    for (const scenario of refusalCases) {
      const defectClient = { query: async (...args) => {
        const result = await client.query(...args);
        const sql = typeof args[0] === "string" ? args[0] : args[0].text;
        const binds = typeof args[0] === "string" ? args[1] : args[0].values;
        if (sql.includes("occurrences.legacy_sources")) {
          const id = target(scenario.conflict);
          return { ...result, rows: result.rows.map((row) => Buffer.from(row.occurrence_id).toString("hex") === encodedId(id)
            ? { ...row, canonical_digest: Buffer.alloc(32, 255) } : row) };
        }
        if (sql.includes("occurrences.correction_sources")) {
          const id = target(scenario.limit);
          const ordinal = binds[1].indexOf(encodedId(id));
          if (ordinal >= 0) {
            const row = sample(factSamples, id);
            assert.ok(row);
            const { sub_batch: _old, ...source } = row;
            return { ...result, rows: Array.from({ length: 40001 }, () => sql.includes("WITH ORDINALITY")
              ? { ...source, sub_batch: Math.floor(ordinal / 200) } : source) };
          }
        }
        return result;
      } };
      const input = { ownerDigest: fixture.owners.bravo.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 };
      for (const reader of [readers.base, readers.candidate]) {
        await assert.rejects(reader.occurrences.readOwnerOccurrences({ ...scoped, client: defectClient }, input),
          (error) => error?.code === scenario.code);
      }
      if (scenario.limit === 0) {
        await assert.rejects(familyFirst.candidate.occurrences.readOwnerOccurrences({ ...scoped, client: defectClient }, input),
          (error) => error?.code === "ANALYTICS_V2_SOURCE_CONFLICT",
          "negative control: processing whole-group legacy before corrections loses the earlier LIMIT");
        assert.notEqual(scenario.code, "ANALYTICS_V2_SOURCE_CONFLICT");
      }
    }
    for (const expected of ["ANALYTICS_V2_SOURCE_CONFLICT", "ANALYTICS_V2_SOURCE_LIMIT"]) {
      const sameBatchClient = { query: async (...args) => {
        const result = await client.query(...args);
        const sql = typeof args[0] === "string" ? args[0] : args[0].text;
        if (sql.includes("occurrences.legacy_sources") && expected.endsWith("CONFLICT")) {
          return { ...result, rows: result.rows.map((row, index) => index === 0
            ? { ...row, canonical_digest: Buffer.alloc(32, 255) } : row) };
        }
        if (sql.includes("occurrences.v12_sources")) {
          assert.ok(result.rows.length);
          return { ...result, rows: Array.from({ length: 40001 }, () => result.rows[0]) };
        }
        if (sql.includes("occurrences.scope")) return { ...result,
          rows: result.rows.map((row) => ({ ...row, correction_facts_present: true })) };
        if (sql.includes("occurrences.correction_sources")) return { ...result,
          rows: [{ ...factSamples[0], sub_batch: 0, record_digest: Buffer.alloc(32, 255) }] };
        return result;
      } };
      for (const reader of [readers.base, readers.candidate]) {
        await assert.rejects(reader.occurrences.readOwnerOccurrences({ ...scoped, client: sameBatchClient },
          { ownerDigest: fixture.owners.alpha.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 }),
          (error) => error?.code === expected);
      }
    }
    // Exercise the unchanged real constants through the production decode
    // seam. These driver-row probes supplement the real SQL correction cap.
    for (const family of ["legacy_sources", "v12_sources", "correction_sources"]) {
      const ownerDigest = family === "correction_sources" ? fixture.owners.bravo.ownerDigest : fixture.owners.alpha.ownerDigest;
      const input = { ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 };
      for (const count of [40000, 40001]) {
        const boundaryClient = { query: async (...args) => {
          const result = await client.query(...args);
          const sql = typeof args[0] === "string" ? args[0] : args[0].text;
          if (sql.includes(`occurrences.${family}`)) {
            assert.ok(result.rows.length > 0);
            const grouped = sql.includes("WITH ORDINALITY");
            if (family === "correction_sources") {
              const binds = typeof args[0] === "string" ? args[1] : args[0].values;
              if (!binds[1].includes(encodedId(target(0)))) return result;
            }
            const leading = result.rows.filter((row) => !grouped || row.sub_batch === 0);
            const firstRow = [...leading].sort((a, b) => Number(a.storage_row_id ?? a.fact_id)
              - Number(b.storage_row_id ?? b.fact_id))[0];
            const rows = [...Array.from({ length: count }, () => firstRow),
              ...result.rows.filter((row) => grouped && row.sub_batch > 0)];
            return { ...result, rows: grouped ? rows.slice(0, 40002) : rows };
          }
          return result;
        } };
        const caller = { ...scoped, client: boundaryClient };
        if (count === 40000) await compareExpansionRead(readers, caller, input);
        else for (const reader of [readers.base, readers.candidate]) {
          await assert.rejects(reader.occurrences.readOwnerOccurrences(caller, input),
            (error) => error?.code === "ANALYTICS_V2_SOURCE_LIMIT");
        }
      }
    }
    // PostgreSQL statement errors abort the group, so the savepoint must
    // restore the snapshot before replaying the original logical batches.
    let recoveredGroups = 0;
    const recoverableSqlClient = { query: async (...args) => {
      const sql = typeof args[0] === "string" ? args[0] : args[0].text;
      if (sql.includes("occurrences.legacy_sources") && sql.includes("WITH ORDINALITY")) {
        const binds = typeof args[0] === "string" ? args[1] : args[0].values;
        if (binds[4].length > 200) { recoveredGroups += 1; return client.query("SELECT 1/0"); }
      }
      return client.query(...args);
    } };
    await compareExpansionRead(readers, { ...scoped, client: recoverableSqlClient },
      { ownerDigest: fixture.owners.bravo.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 });
    assert.ok(recoveredGroups >= 2, "both Maps and fingerprints recover real aborted grouped statements");
    const sqlPrecedenceClient = { query: async (...args) => {
      const sql = typeof args[0] === "string" ? args[0] : args[0].text;
      const binds = typeof args[0] === "string" ? args[1] : args[0].values;
      if (sql.includes("occurrences.legacy_sources") && binds[4].includes(encodedId(target(200)))) {
        return client.query("SELECT 1/0");
      }
      const result = await client.query(...args);
      if (sql.includes("occurrences.legacy_sources")) return { ...result, rows: result.rows.map((row) =>
        Buffer.from(row.occurrence_id).toString("hex") === encodedId(target(0))
          ? { ...row, canonical_digest: Buffer.alloc(32, 255) } : row) };
      return result;
    } };
    for (const reader of [readers.base, readers.candidate]) {
      await assert.rejects(reader.occurrences.readOwnerOccurrences({ ...scoped, client: sqlPrecedenceClient },
        { ownerDigest: fixture.owners.bravo.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 }),
        (error) => error?.code === "ANALYTICS_V2_SOURCE_CONFLICT",
        "an earlier decode refusal wins over a reachable later-batch SQL failure");
    }
    const cancellation = Object.assign(new Error("canceling statement due to user request"), { code: "57014" });
    let cancelledReads = 0;
    const cancelledClient = { query: async (...args) => {
      const sql = typeof args[0] === "string" ? args[0] : args[0].text;
      if (sql.includes("occurrences.legacy_sources")) { cancelledReads += 1; throw cancellation; }
      return client.query(...args);
    } };
    await assert.rejects(readers.candidate.occurrences.readOwnerOccurrences({ ...scoped, client: cancelledClient },
      { ownerDigest: fixture.owners.bravo.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 }),
      (error) => error === cancellation);
    assert.equal(cancelledReads, 1, "explicit cancellation is terminal, without source retries");
    assert.equal((await client.query("SELECT 1 AS alive")).rows[0].alive, 1, "snapshot remains usable after cancellation cleanup");
    // A SQL-tagging defect must be checked against its logical batch, even
    // when the decoded id belongs to another batch of the same group.
    const mistagClient = { query: async (...args) => {
      const result = await client.query(...args);
      const sql = typeof args[0] === "string" ? args[0] : args[0].text;
      if (sql.includes("occurrences.legacy_sources") && sql.includes("WITH ORDINALITY")) {
        return { ...result, rows: result.rows.map((row) =>
          Buffer.from(row.occurrence_id).toString("hex") === encodedId(target(200)) ? { ...row, sub_batch: 0 } : row) };
      }
      return result;
    } };
    await assert.rejects(readers.candidate.occurrences.readOwnerOccurrences({ ...scoped, client: mistagClient },
      { ownerDigest: fixture.owners.bravo.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 }),
      (error) => error?.code === "ANALYTICS_V2_SOURCE_CONFLICT");
    await client.query("ROLLBACK");
    // Real SQL budget pressure: one logical batch has exactly 40,000
    // correction variants; later batches force a complete-prefix reissue.
    const columns = (await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='telemetry_usage_correction_history' ORDER BY ordinal_position`, [schema]))
      .rows.map((row) => row.column_name);
    assert.ok(columns.every((name) => /^[a-z_]+$/u.test(name)));
    const bulkFacts = async (first, last) => {
      const expressions = columns.map((name) => name === "id" || name === "device_id" ? "1000000+n" : `h."${name}"`);
      await pool.query(`INSERT INTO "${schema}".telemetry_usage_correction_history (${columns.map((name) => `"${name}"`).join(",")})
        SELECT ${expressions.join(",")} FROM generate_series($1::integer,$2::integer) n
        CROSS JOIN LATERAL (SELECT * FROM "${schema}".telemetry_usage_correction_history
          WHERE occurrence_id=decode($3,'hex') ORDER BY id LIMIT 1) h`, [first, last, encodedId(target(0))]);
      await pool.query(`INSERT INTO "${schema}".telemetry_usage_correction_facts(id,history_id,method_version,captured_at_ms)
        SELECT id,id,1,captured_at_ms FROM "${schema}".telemetry_usage_correction_history
         WHERE id BETWEEN 1000000+$1::integer AND 1000000+$2::integer`, [first, last]);
    };
    await bulkFacts(1, 39400);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    observed.length = 0;
    await compareExpansionRead(readers, scoped,
      { ownerDigest: fixture.owners.bravo.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 });
    const groupedFactReads = observed.filter((entry) => entry.text.includes("occurrences.correction_sources")
      && entry.text.includes("WITH ORDINALITY"));
    assert.ok(groupedFactReads.some((entry) => entry.rows.length === 40002), "G+1 sentinel bounds SQL buffering");
    assert.ok(groupedFactReads.some((entry) => entry.rows.length < 40001), "the incomplete tail is reissued");
    await client.query("ROLLBACK");
    await bulkFacts(39401, 39401);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const limitInput = { ownerDigest: fixture.owners.bravo.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 };
    for (const reader of [readers.base, readers.candidate]) {
      await assert.rejects(reader.occurrences.readOwnerOccurrences(scoped, limitInput),
        (error) => error?.code === "ANALYTICS_V2_SOURCE_LIMIT");
      await assert.rejects(reader.occurrences.readOwnerDayFingerprints(scoped, limitInput),
        (error) => error?.code === "ANALYTICS_V2_SOURCE_LIMIT");
    }
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await readers.close();
    await familyFirst.close();
  }
});


test("READ-EXPANSION: missing correction dictionaries cannot hide a later logical batch", { skip: SKIP, timeout: 180_000 }, async () => {
  const schema = `analytics_v2_expand_missing_${randomBytes(6).toString("hex")}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  await applyPostgresMigrations({ role: "primary", schema, pool });
  const fixture = await seedAnalyticsV2Fixture({ pool, schema, modules: modules.seed,
    correctionRuntime: "active", expansionCorrections: true });
  const id = Buffer.from(modules.seed.codec.encodeTypedTelemetryId("event:readexp:00000")).toString("hex");
  const columns = (await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema=$1 AND table_name='telemetry_usage_correction_history' ORDER BY ordinal_position`, [schema]))
    .rows.map((row) => row.column_name);
  assert.ok(columns.every((name) => /^[a-z_]+$/u.test(name)));
  // Archived dictionary references intentionally have no FK. These facts
  // reach the narrow cap but disappear at the unchanged mandatory wide join.
  const expressions = columns.map((name) => name === "id" || name === "device_id" ? "2000000+n"
    : name === "provider_id" ? "999999999" : `h."${name}"`);
  await pool.query(`INSERT INTO "${schema}".telemetry_usage_correction_history (${columns.map((name) => `"${name}"`).join(",")})
    SELECT ${expressions.join(",")} FROM generate_series(1,39400) n
    CROSS JOIN LATERAL (SELECT * FROM "${schema}".telemetry_usage_correction_history
      WHERE occurrence_id=decode($1,'hex') ORDER BY id LIMIT 1) h`, [id]);
  await pool.query(`INSERT INTO "${schema}".telemetry_usage_correction_facts(id,history_id,method_version,captured_at_ms)
    SELECT id,id,1,captured_at_ms FROM "${schema}".telemetry_usage_correction_history WHERE id>2000000`);
  const readers = await loadExpansionReaders();
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const seen = [];
    const tracking = { query: async (...args) => {
      const result = await client.query(...args);
      const sql = typeof args[0] === "string" ? args[0] : args[0].text;
      if (sql.includes("occurrences.correction_sources") && sql.includes("WITH ORDINALITY")) seen.push(result.rows);
      return result;
    } };
    const input = { ownerDigest: fixture.owners.bravo.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 };
    await compareExpansionRead(readers, { pool, client: tracking, schema, nowMs: NOW_MS }, input);
    assert.ok(seen.length >= 2);
    assert.ok(seen.every((rows) => rows.length < 40002 && rows.some((row) => row.sub_batch > 0)),
      "wide output below G+1 retains facts from later batches for both Maps and fingerprints");
    assert.equal((await client.query(`SELECT count(*)::integer AS count FROM "${schema}".telemetry_usage_correction_facts`)).rows[0].count, 40661,
      "the narrow grouped input exceeds G+1 while the first logical batch is exactly 40000");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await readers.close();
  }
});
