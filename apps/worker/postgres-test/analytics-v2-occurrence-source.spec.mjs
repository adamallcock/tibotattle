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
