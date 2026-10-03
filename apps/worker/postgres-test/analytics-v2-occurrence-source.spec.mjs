import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations, readPostgresMigrations } from "../scripts/postgres-migrations.mjs";
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

test("N-EXCL: exclusion scopes are counted, never applied, and an undefined scope is refused",
  { skip: SKIP, timeout: 120_000 }, async () => {
    const schema = `analytics_v2_a1_${randomBytes(6).toString("hex")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const scoped = { pool, schema, nowMs: NOW_MS };
    const absent = await modules.owners.readAnalyticsV2ExclusionScopes(scoped);
    assert.deepEqual({ ...absent, scopes: { ...absent.scopes } }, { table: "absent", scopes: {} });
    // The D-PT4X table's declared contract (D1 0023's columns); created here
    // only when this line does not have it yet.
    await pool.query(`CREATE TABLE IF NOT EXISTS "${schema}".community_aggregate_exclusions (
      exclusion_id text PRIMARY KEY, participant_id text NOT NULL, scope text NOT NULL, reason_code text NOT NULL,
      state text NOT NULL, effective_at text NOT NULL, expires_at text, created_at text NOT NULL,
      created_by_digest text NOT NULL, revoked_at text, revoked_by_digest text)`);
    const row = (id, scope, state) => pool.query(`INSERT INTO "${schema}".community_aggregate_exclusions
      (exclusion_id, participant_id, scope, reason_code, state, effective_at, created_at, created_by_digest,
       revoked_at, revoked_by_digest)
      VALUES ($1, 'participant:synthetic-excluded', $2, 'manual_review', $3, '2026-09-01T00:00:00.000Z',
       '2026-09-01T00:00:00.000Z', $4, $5, $6)`, [id, scope, state, "c".repeat(64),
      state === "revoked" ? "2026-09-02T00:00:00.000Z" : null, state === "revoked" ? "d".repeat(64) : null]);
    await row("x1", "community_weekly", "active");
    await row("x2", "community_weekly", "revoked");
    const present = await modules.owners.readAnalyticsV2ExclusionScopes(scoped);
    assert.deepEqual(JSON.parse(JSON.stringify(present)),
      { table: "present", scopes: { community_weekly: { rows: 2, active: 1 } } });
    await row("x3", "community_daily", "active");
    await assert.rejects(modules.owners.readAnalyticsV2ExclusionScopes(scoped),
      (error) => error?.code === "ANALYTICS_V2_SOURCE_CONFLICT", "a scope production does not define");
  });
