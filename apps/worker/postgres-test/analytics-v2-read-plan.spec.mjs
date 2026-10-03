import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";
import { D1, D2, D3, NOW_MS, seedAnalyticsV2Fixture } from "./fixtures/analytics-v2/direct-seed.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE_PATH = resolve(ROOT, "postgres-test/fixtures/analytics-v2/read-plan-oracle.ts");
const ORACLE_SHA256 = "ce14b9f90c3b57a50b82021902b8e1872126ec7a0433fa85a3c4f4706f01d5d9";
const SOCKET = process.env.PG_TEST_SOCKET;
const HOST = process.env.PG_TEST_HOST;
const SKIP = !SOCKET && !HOST;
const DAY_MS = 86_400_000;
const FLOOR = new Date(-100_000 * DAY_MS).toISOString().slice(0, 10);
const day = (number) => new Date(number * DAY_MS).toISOString().slice(0, 10);
const number = (value) => Date.parse(`${value}T00:00:00Z`) / DAY_MS;
let pool, vite, head, oracle, owners;
const fixtures = {}, schemas = [];

before(async () => {
  assert.equal(createHash("sha256").update(await readFile(ORACLE_PATH)).digest("hex"), ORACLE_SHA256,
    "the committed base public-reader oracle cannot drift");
  if (SKIP) return;
  assert.ok(!HOST || ["localhost", "127.0.0.1", "::1"].includes(HOST));
  if (SOCKET) {
    assert.match(SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
    assert.equal((await lstat(SOCKET)).isSymbolicLink(), false);
    assert.equal(await realpath(SOCKET), SOCKET);
    assert.equal((await stat(SOCKET)).mode & 0o077, 0);
  }
  pool = new pg.Pool({ host: SOCKET ?? HOST, port: Number(process.env.PG_TEST_PORT ?? "55433"),
    user: process.env.PG_TEST_USER ?? "postgres", password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only",
    database: process.env.PG_TEST_DATABASE ?? "postgres", ssl: false, max: 4,
    connectionTimeoutMillis: 5_000, application_name: "analytics-v2-read-plan-test" });
  assert.equal(Math.floor(Number((await pool.query("SHOW server_version_num")).rows[0].server_version_num) / 10_000), 17);
  vite = await createServer({ root: ROOT, configFile: false, logLevel: "error",
    plugins: analyticsV2Config.plugins, resolve: analyticsV2Config.resolve,
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  head = await vite.ssrLoadModule("/src/analytics-v2/occurrence-source.ts");
  oracle = await vite.ssrLoadModule("/postgres-test/fixtures/analytics-v2/read-plan-oracle.ts");
  owners = await vite.ssrLoadModule("/src/analytics-v2/owners.ts");
  const seed = {
    codec: await vite.ssrLoadModule("/src/typed-telemetry-codec.ts"),
    v12codec: await vite.ssrLoadModule("/src/telemetry-v12-typed-codec.ts"),
    reconciliation: await vite.ssrLoadModule("/src/telemetry-usage-reconciliation.ts"),
    sha256Hex: (await vite.ssrLoadModule("/src/crypto.ts")).sha256Hex,
  };
  for (const correctionRuntime of ["active", "staged"]) {
    const schema = `analytics_v2_plan_${randomBytes(6).toString("hex")}`;
    schemas.push(schema);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    fixtures[correctionRuntime] = { schema, ...await seedAnalyticsV2Fixture({ pool, schema, modules: seed,
      correctionRuntime, legacyScope: true, v12Scope: true }) };
  }
});
after(async () => {
  if (pool) {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
  if (vite) await vite.close();
});

async function snapshot(fixture, operation) {
  return owners.withAnalyticsV2ReadSnapshot({ pool, schema: fixture.schema, nowMs: NOW_MS }, operation);
}
const outcome = async (operation) => {
  try { return { value: await operation() }; }
  catch (error) { return { error: error.code ?? error.message }; }
};
const planOptions = (ownerDigest, throughDay = D3) => ({ ownerDigest, streams: ["usage", "quota", "session"],
  fromDay: FLOOR, throughDay, firstEvidenceThroughDay: D3 });

for (const runtime of ["active", "staged"]) {
  test(`base/public reader parity for every direct-seed owner, stream and edge span (${runtime})`,
    { skip: SKIP, timeout: 300_000 }, async () => {
      const fixture = fixtures[runtime];
      await snapshot(fixture, async (context) => {
        for (const owner of Object.values(fixture.owners)) {
          const ownerDigest = owner.ownerDigest;
          for (const stream of ["usage", "quota", "session"]) {
            for (const [fromDay, throughDay] of [[D1, D3], [D1, D1], [D2, D3], [D3, D3],
              [FLOOR, day(-99_999)], [day(number(D3) + 1), day(number(D3) + 1)]]) {
              const options = { ownerDigest, stream, fromDay, throughDay };
              for (const method of ["countOwnerOccurrences", "readOwnerOccurrences"]) {
                assert.deepEqual(await outcome(() => head[method](context, options)),
                  await outcome(() => oracle[method](context, options)), `${method}: ${runtime}/${stream}`);
              }
            }
          }
          assert.deepEqual(await outcome(() => head.readOwnerFirstEvidenceDay(context, { ownerDigest, throughDay: D3 })),
            await outcome(() => oracle.readOwnerFirstEvidenceDay(context, { ownerDigest, throughDay: D3 })));
          assert.deepEqual(await outcome(() => head.readOwnerDayFingerprints(context, { ownerDigest, fromDay: D1, throughDay: D3 })),
            await outcome(() => oracle.readOwnerDayFingerprints(context, { ownerDigest, fromDay: D1, throughDay: D3 })));
          const planned = await outcome(() => head.readOwnerEvidencePlan(context, planOptions(ownerDigest)));
          const first = await outcome(() => oracle.readOwnerFirstEvidenceDay(context, { ownerDigest, throughDay: D3 }));
          if (first.error) { assert.equal(planned.error, first.error); continue; }
          assert.equal(planned.error, undefined);
          const firstDays = [...planned.value.values()].map((part) => part.firstEvidenceDay).filter((value) => value !== null).sort();
          assert.equal(firstDays[0] ?? null, first.value);
          for (const stream of ["usage", "quota", "session"]) {
            for (const [fromDay, throughDay] of [[D1, D3], [D1, D1], [D2, D3], [FLOOR, day(-99_999)]]) {
              const options = { ownerDigest, stream, fromDay, throughDay };
              assert.deepEqual(await outcome(() => head.countOwnerEvidencePlanRange(context, planned.value, options)),
                await outcome(() => oracle.countOwnerOccurrences(context, options)));
            }
          }
        }
      });
    });
}

test("negative corrections retain count partition refusals, lower-bound exclusion, FLOOR and future filtering",
  { skip: SKIP, timeout: 120_000 }, async () => {
    const fixture = fixtures.active;
    const schema = `"${fixture.schema}"`;
    const history = (await pool.query(`SELECT id,owner_digest FROM ${schema}.telemetry_usage_correction_history LIMIT 1`)).rows[0];
    assert.ok(history, "correction-positive fixture is required");
    const ownerDigest = Buffer.from(history.owner_digest).toString("hex");
    const change = async (ms) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role=replica");
        await client.query(`UPDATE ${schema}.telemetry_usage_correction_history SET event_time_ms=$2 WHERE id=$1`, [history.id, ms]);
        await client.query("COMMIT");
      } finally { client.release(); }
    };
    for (const ms of [-DAY_MS + 1, -400 * DAY_MS + 1, -100_000 * DAY_MS,
      -100_001 * DAY_MS + 1, (number(D3) + 1) * DAY_MS + 1]) {
      await change(ms);
      await snapshot(fixture, async (context) => {
        const throughDay = day(number(D3) + 2);
        const plan = await head.readOwnerEvidencePlan(context, planOptions(ownerDigest, throughDay));
        const firsts = [...plan.values()].map((part) => part.firstEvidenceDay).filter((value) => value !== null).sort();
        assert.equal(firsts[0] ?? null,
          await oracle.readOwnerFirstEvidenceDay(context, { ownerDigest, throughDay: D3 }));
        for (const [from, through] of [[-400, -1], [0, 1], [-401, -400], [-399, -1],
          [-100_001, -99_999], [-100_000, -99_999], [number(D3), number(D3) + 2]]) {
          if (through - from + 1 > 400) continue;
          const options = { ownerDigest, stream: "usage", fromDay: day(from), throughDay: day(through) };
          assert.deepEqual(await outcome(() => head.countOwnerEvidencePlanRange(context, plan, options)),
            await outcome(() => oracle.countOwnerOccurrences(context, options)), `correction partition ${from}/${through}`);
        }
      });
    }
    await change(Date.parse(`${D1}T14:00:00Z`));
  });

test("plan validates options, preserves the snapshot and uses one scope plus one counts query per stream",
  { skip: SKIP, timeout: 120_000 }, async () => {
    const fixture = fixtures.active;
    const ownerDigest = fixture.owners.alpha.ownerDigest;
    await snapshot(fixture, async (context) => {
      const calls = [];
      const client = { query: async (...args) => {
        const text = typeof args[0] === "string" ? args[0] : args[0].text;
        if (text.startsWith("/* analytics_v2:occurrences.")) calls.push(text.split(" */")[0]);
        return context.client.query(...args);
      } };
      const plan = await head.readOwnerEvidencePlan({ ...context, client }, planOptions(ownerDigest));
      assert.ok(Object.isFrozen(plan));
      assert.deepEqual(calls, ["/* analytics_v2:occurrences.scope", ...Array(3).fill("/* analytics_v2:occurrences.counts")]);
      for (const part of plan.values()) {
        assert.ok(Object.isFrozen(part) && Object.isFrozen(part.counts));
        assert.deepEqual([...part.counts.keys()], [...part.counts.keys()].sort());
      }
      for (const options of [{ ...planOptions(ownerDigest), streams: [] },
        { ...planOptions(ownerDigest), streams: ["usage", "usage"] },
        { ...planOptions(ownerDigest), fromDay: day(-100_001) },
        { ...planOptions(ownerDigest), firstEvidenceThroughDay: day(number(D3) + 1) }]) {
        await assert.rejects(head.readOwnerEvidencePlan(context, options), { code: "ANALYTICS_V2_SOURCE_INVALID" });
      }
      await assert.rejects(head.countOwnerEvidencePlanRange(context, new Map(),
        { ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 }), { code: "ANALYTICS_V2_SOURCE_INVALID" });
    });
  });

test("every non-redundant pair eligibility conjunct is killed by an adversarial fixture",
  { skip: SKIP, timeout: 300_000 }, async () => {
    const { READ_PLAN_CONJUNCTS } = await import("./fixtures/analytics-v2/read-plan-conjuncts.mjs");
    const fixture = fixtures.active, owner = fixture.owners.lima, foreign = fixture.owners.mike;
    const s = `"${fixture.schema}"`;
    const target = (await pool.query(`SELECT chunk.id AS chunk_id,chunk.manifest_id,chunk.device_id,
      domain.id AS generation_id,event.event_digest FROM ${s}.telemetry_v11_chunks chunk
      JOIN ${s}.telemetry_v11_domain_days dd ON dd.manifest_id=chunk.manifest_id
      JOIN ${s}.telemetry_v11_domains domain ON domain.id=dd.generation_id
      JOIN ${s}.storage_v11_event_sources event ON event.generation_id=domain.id
      WHERE chunk.participant_id=$1 AND chunk.chunk_day=$2::date AND event.owner_digest=$3 LIMIT 1`, [owner.participantId, D1, owner.ownerDigest])).rows[0];
    let selectedSql, selectedValues;
    await snapshot(fixture, async (context) => {
      const client = { query: async (...args) => {
        const text = typeof args[0] === "string" ? args[0] : args[0].text;
        if (text.startsWith("/* analytics_v2:occurrences.counts")) [selectedSql, selectedValues] = args;
        return context.client.query(...args);
      } };
      await head.countOwnerOccurrences({ ...context, client }, { ownerDigest: owner.ownerDigest,
        stream: "usage", fromDay: D1, throughDay: D3 });
    });
    const updates = {
      chunk: ["telemetry_v11_chunks", "record_count", target.chunk_id, 2],
      manifest: ["telemetry_v11_day_manifests", "state", target.manifest_id, "staged"],
      stream: ["telemetry_v11_chunks", "stream", target.chunk_id, "quota"],
      event_owner: ["storage_v11_event_sources", "owner_digest", target.event_digest, foreign.ownerDigest],
      event_participant: ["storage_v11_event_sources", "participant_id", target.event_digest, foreign.participantId],
      chunk_participant: ["telemetry_v11_chunks", "participant_id", target.chunk_id, foreign.participantId],
      chunk_device: ["telemetry_v11_chunks", "device_id", target.chunk_id, foreign.devices[0]],
      event_digest: ["storage_v11_event_sources", "manifest_digest", target.event_digest, "e".repeat(64)],
      event_from: ["storage_v11_event_sources", "from_day", target.event_digest, D2],
      event_through: ["storage_v11_event_sources", "through_day", target.event_digest, day(number(D3) + 1)],
      event_revision: ["storage_v11_event_sources", "input_revision", target.event_digest, 1],
      device_participant: ["device_credentials", "participant_id", target.device_id, foreign.participantId],
    };
    const replaceRow = async ([table, column, id, value, readyAt]) => {
      const key = table === "storage_v11_event_sources" ? "event_digest" : "id";
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role=replica");
        const previous = (await client.query(`SELECT ${column} AS value${column === "state" ? ",ready_at" : ""} FROM ${s}.${table} WHERE ${key}=$1`, [id])).rows[0];
        if (column === "state") await client.query(`UPDATE ${s}.${table} SET state=$2,ready_at=$3 WHERE ${key}=$1`,
          [id, value, value === "ready" ? readyAt : null]);
        else await client.query(`UPDATE ${s}.${table} SET ${column}=$2 WHERE ${key}=$1`, [id, value]);
        await client.query("COMMIT");
        return [table, column, id, previous.value, previous.ready_at];
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    };
    const pairStart = selectedSql.indexOf("selection_pairs_ok AS MATERIALIZED");
    const pairEnd = selectedSql.indexOf(", direct AS (", pairStart);
    const pairSql = selectedSql.slice(pairStart, pairEnd);
    for (const [predicate, update, redundant] of READ_PLAN_CONJUNCTS) {
      assert.equal(pairSql.split(predicate).length - 1, 1, "each mutant targets one pair conjunct");
      if (redundant) { assert.ok(redundant.length > 50); continue; }
      const restoration = [];
      try {
        if (update === "generation_device") {
          restoration.push(await replaceRow(["telemetry_v11_domains", "device_id", target.generation_id, foreign.devices[0]]));
          const chunks = (await pool.query(`SELECT id FROM ${s}.telemetry_v11_chunks WHERE participant_id=$1`, [owner.participantId])).rows;
          for (const chunk of chunks) restoration.push(await replaceRow(["telemetry_v11_chunks", "device_id", chunk.id, foreign.devices[0]]));
        } else if (update.startsWith("event_")) {
          // The production head hook and explicit seed can both contribute
          // event evidence for a generation. Corrupt every qualifying row;
          // a second valid event must not mask the mutant.
          const events = (await pool.query(`SELECT event_digest FROM ${s}.storage_v11_event_sources WHERE generation_id=$1`,
            [target.generation_id])).rows;
          for (const event of events) {
            const spec = [...updates[update]]; spec[2] = event.event_digest;
            restoration.push(await replaceRow(spec));
          }
        } else restoration.push(await replaceRow(updates[update]));
        const failure = await snapshot(fixture, async (context) => {
          try {
          const options = { ownerDigest: owner.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 };
          const expected = await oracle.countOwnerOccurrences(context, options);
          assert.deepEqual(await head.countOwnerOccurrences(context, options), expected, "adversarial parity");
          const mutated = await context.client.query(selectedSql.slice(0, pairStart) + pairSql.replace(predicate, "true") + selectedSql.slice(pairEnd), selectedValues);
          const actual = new Map(mutated.rows.map((row) => [day(Number(row.observed_day)), Number(row.occurrences)]));
          assert.notDeepEqual(actual, expected, `mutant must be killed: ${predicate}`);
          } catch (error) { return error; }
        });
        if (failure) throw failure;
      } finally {
        for (const old of restoration.reverse()) await replaceRow(old);
      }
    }
  });

test("pair keys distinguish manifests sharing a chunk and chunks sharing a manifest", { skip: SKIP, timeout: 120_000 }, async () => {
  const fixture = fixtures.active, ownerDigest = fixture.owners.lima.ownerDigest, s = `"${fixture.schema}"`;
  const rows = (await pool.query(`SELECT proof.typed_record_id,proof.chunk_key,proof.manifest_key,
    chunk.id AS chunk_id,chunk.manifest_id FROM ${s}.typed_v11_record_proofs proof
    JOIN ${s}.typed_telemetry_records record ON record.id=proof.typed_record_id
    JOIN ${s}.typed_telemetry_chunks physical ON physical.id=proof.chunk_key
    JOIN ${s}.typed_v11_chunk_allocations allocation ON allocation.namespace_id=physical.namespace_id
      AND allocation.chunk_original=physical.original_id
    JOIN ${s}.telemetry_v11_chunks chunk ON chunk.id=allocation.chunk_id
    WHERE chunk.participant_id=$1 ORDER BY record.observed_day`, [fixture.owners.lima.participantId])).rows;
  assert.equal(rows.length, 2);
  const write = async (sql, values) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SET LOCAL session_replication_role=replica");
      await client.query(sql, values); await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  };
  const compare = async () => snapshot(fixture, async (context) => {
    const options = { ownerDigest, stream: "usage", fromDay: D1, throughDay: D3 };
    assert.deepEqual(await head.countOwnerOccurrences(context, options), await oracle.countOwnerOccurrences(context, options));
    assert.deepEqual([...await head.countOwnerOccurrences(context, options)], [[D1, 2]]);
  });
  const readyAt = (await pool.query(`SELECT ready_at FROM ${s}.telemetry_v11_day_manifests WHERE id=$1`, [rows[1].manifest_id])).rows[0].ready_at;
  try {
    await write(`UPDATE ${s}.typed_v11_record_proofs SET chunk_key=$2 WHERE typed_record_id=$1`, [rows[1].typed_record_id, rows[0].chunk_key]);
    await write(`UPDATE ${s}.telemetry_v11_chunks SET record_count=2 WHERE id=$1`, [rows[0].chunk_id]);
    await write(`UPDATE ${s}.telemetry_v11_day_manifests SET state='staged',ready_at=NULL WHERE id=$1`, [rows[1].manifest_id]);
    await compare();
  } finally {
    await write(`UPDATE ${s}.typed_v11_record_proofs SET chunk_key=$2 WHERE typed_record_id=$1`, [rows[1].typed_record_id, rows[1].chunk_key]);
    await write(`UPDATE ${s}.telemetry_v11_chunks SET record_count=1 WHERE id=$1`, [rows[0].chunk_id]);
    await write(`UPDATE ${s}.telemetry_v11_day_manifests SET state='ready',ready_at=$2 WHERE id=$1`, [rows[1].manifest_id, readyAt]);
  }
  try {
    await write(`UPDATE ${s}.typed_v11_record_proofs SET manifest_key=$2 WHERE typed_record_id=$1`, [rows[1].typed_record_id, rows[0].manifest_key]);
    await write(`UPDATE ${s}.telemetry_v11_chunks SET record_count=2 WHERE id=$1`, [rows[1].chunk_id]);
    await compare();
  } finally {
    await write(`UPDATE ${s}.typed_v11_record_proofs SET manifest_key=$2 WHERE typed_record_id=$1`, [rows[1].typed_record_id, rows[1].manifest_key]);
    await write(`UPDATE ${s}.telemetry_v11_chunks SET record_count=1 WHERE id=$1`, [rows[1].chunk_id]);
  }
});

test("expansion SQL remains byte-identical and candidate bounds retain their refusal", { skip: SKIP }, async (t) => {
  const fixture = fixtures.active;
  await snapshot(fixture, async (context) => {
    const capture = async (reader) => {
      const texts = [];
      const client = { query: async (...args) => {
        const text = typeof args[0] === "string" ? args[0] : args[0].text;
        if (text.startsWith("/* analytics_v2:occurrences.legacy_sources")) texts.push(text.replaceAll(`"${fixture.schema}"`, '"read_plan_fixed"'));
        return context.client.query(...args);
      } };
      await reader.readOwnerOccurrences({ ...context, client }, { ownerDigest: fixture.owners.lima.ownerDigest,
        stream: "usage", fromDay: D1, throughDay: D3 });
      return texts;
    };
    const before = await capture(oracle), after = await capture(head);
    assert.ok(before.length > 0); assert.deepEqual(after, before);
    t.diagnostic(`legacy_sources fixed-schema SHA256 ${createHash("sha256").update(before[0]).digest("hex")}`);
    const options = { ownerDigest: fixture.owners.lima.ownerDigest, stream: "usage", fromDay: D1, throughDay: D3, maxCandidates: 1 };
    assert.deepEqual(await outcome(() => head.readOwnerOccurrences(context, options)), { error: "ANALYTICS_V2_SOURCE_LIMIT" });
    assert.deepEqual(await outcome(() => oracle.readOwnerOccurrences(context, options)), { error: "ANALYTICS_V2_SOURCE_LIMIT" });
  });
});

test("actual snapshot pipeline inputs equal the old pre-owner pass at concurrency 1–4", { skip: SKIP, timeout: 120_000 }, async () => {
  const { createAnalyticsV2Pipeline, createSnapshotReadPool, createAnalyticsRefreshStatementLedger } = await import("../cloud-run/analytics-refresh-read.mjs");
  const devices = await vite.ssrLoadModule("/src/analytics-v2/devices.ts");
  const fixture = fixtures.active;
  const common = { owners, devices, queuedDays: { readQueuedDays: async () => ({ days: [D1, D2, D3],
    terminalOwners: [], lastSequence: 0, complete: true }) },
    ownerSets: { readAnalyticsV2OwnerSetState: async (_context, { days }) => ({ days: new Map(days.map((value) => [value,
      { members: new Map() }])), frozen: null }), readAnalyticsV2SavedContributionValues: async () => new Map() },
    compute: { ANALYTICS_V2_ANALYSIS_DAYS: 170, computeAnalyticsV2: async () => ({}),
      analyticsV2RequiredOccurrenceRange: ({ cacheFromDay }) => ({ fromDay: cacheFromDay, throughDay: D3 }) } };
  const exporter = await pool.connect();
  let reads;
  try {
    await exporter.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const id = (await exporter.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
    const ledger = createAnalyticsRefreshStatementLedger();
    reads = createSnapshotReadPool(pool, id, { ledger });
    const options = { pool: reads, schema: fixture.schema, nowMs: NOW_MS,
      state: { cursor: null, carriedBlockedDays: [], publishedDays: [], appliedExclusionsSha256: "0".repeat(64), cacheFloorDay: null } };
    const old = createAnalyticsV2Pipeline({ ...common, occurrences: { ...oracle } });
    const planned = createAnalyticsV2Pipeline({ ...common, occurrences: head });
    const before = await old.read(options);
    for (const readConcurrency of [1, 2, 3, 4]) {
      // max4 includes the exporter; up to3 physical read connections suffice
      // to qualify ordering at requested concurrency4 (one waits locally).
      const previous = ledger.summary().families;
      const after = await planned.read({ ...options, readConcurrency });
      const current = ledger.summary().families;
      assert.equal(current["occurrences.first_evidence"].calls, previous["occurrences.first_evidence"].calls,
        "no first-evidence statement after the switch");
      assert.equal(current["occurrences.counts"].calls - previous["occurrences.counts"].calls,
        before.owners.filter((owner) => owner.source === "effective").length * 3,
        "one plan statement per effective owner and stream");
      for (const field of ["ownerEvidence", "streamCounts", "firstEvidenceDay", "occurrenceRange", "cacheFromDay", "owners",
        "occurrencesByOwner", "queuedDays", "devicesByDay"]) assert.deepEqual(after[field], before[field], field);
    }
  } finally {
    if (reads) await reads.close();
    await exporter.query("ROLLBACK"); exporter.release();
  }
});

test("corpus A/B entrypoint runs on the same small synthetic schema with content-free output", {
  skip: SKIP || !process.env.READ_PLAN_AB_BASE_ROOT, timeout: 120_000,
}, async () => {
  const { readPlanAB } = await import("../scripts/analytics-v2-read-plan-ab.mjs");
  const report = await readPlanAB(["--base-root", process.env.READ_PLAN_AB_BASE_ROOT,
    "--schema", fixtures.staged.schema, "--from", D1, "--through", D3, "--bench"]);
  assert.ok(report.owners > 0 && report.comparisons.length > 0);
  assert.equal(report.spans, 1);
  assert.deepEqual(report.concurrencyTimings.map((row) => row.concurrency), [1, 2, 3, 4]);
  assert.ok(report.statements.length > 0);
  for (const statement of report.statements) {
    assert.ok(Number.isFinite(statement.serverMs) && statement.serverMs >= 0);
    assert.ok(Number.isFinite(statement.planCost) && statement.planCost >= 0);
  }
  for (const comparison of report.comparisons) assert.match(comparison.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(report).includes("ownerDigest"), false);
  assert.equal(JSON.stringify(report).includes("occurrence_id"), false);
});
