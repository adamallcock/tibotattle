// K-DETECT unseen-token probe (cloud-run/unseen-token-probe.mjs) against the
// local PostgreSQL 17 test cluster (PG_TEST_SOCKET, a private
// /private/tmp/tibotattle-pg-* socket directory, or a loopback PG_TEST_HOST,
// with PG_TEST_PORT): a throwaway schema migrated from this checkout and
// seeded with synthetic typed rows only, dropped afterwards. Without a local
// cluster the SQL test is reported as skipped, never as passed.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { localProbeEndpoint, observedDay, runUnseenTokenProbe } from "../cloud-run/unseen-token-probe.mjs";

const DAY = "2026-10-01";
const isCode = (code) => (error) => error?.code === code;

test("the CLI connects only to a private local socket or a loopback host", async () => {
  for (const env of [{}, { PG_TEST_PORT: "55433" }, { PG_TEST_PORT: "55433", PG_TEST_HOST: "db.example.invalid" },
    { PG_TEST_PORT: "55433", PG_TEST_SOCKET: "/tmp/socket" }, { PG_TEST_PORT: "0", PG_TEST_HOST: "127.0.0.1" }]) {
    await assert.rejects(localProbeEndpoint(env), isCode("UNSEEN_TOKEN_PROBE_ENDPOINT_FORBIDDEN"), JSON.stringify(env));
  }
  assert.deepEqual(await localProbeEndpoint({ PG_TEST_PORT: "55433", PG_TEST_HOST: "127.0.0.1" }),
    { host: "127.0.0.1", port: 55433 });
});

// ---------------------------------------------------------------------------
// PostgreSQL: the real migrated schema, synthetic typed rows.

const endpoint = await localProbeEndpoint(process.env).catch(() => null);

async function seed(client, schema) {
  const s = `"${schema}"`;
  const ids = new Map();
  const dictionary = async (value) => {
    if (!ids.has(value)) {
      const { rows } = await client.query(`INSERT INTO ${s}.typed_telemetry_dictionary (value) VALUES ($1) RETURNING id`,
        [value]);
      ids.set(value, Number(rows[0].id));
    }
    return ids.get(value);
  };
  const digest = () => randomBytes(32);
  const day = observedDay(DAY);
  const at = day * 86_400_000 + 3_600_000;
  await client.query("SET session_replication_role = replica");
  // Retained v1/v1.1 family: usage with an attribution, and a quota row.
  const legacyAttribution = 1;
  await client.query(`INSERT INTO ${s}.typed_telemetry_attributions
      (id, namespace_id, owner_id, account_basis, account_track, plan_basis, plan_type_id, plan_era)
    VALUES ($1, 1, 1, 0, ''::bytea, 0, $2, ''::bytea)`, [legacyAttribution, await dictionary("pro")]);
  await client.query(`INSERT INTO ${s}.typed_telemetry_quota_dimensions (id, namespace_id, owner_id, plan_type_id, plan_variant_id)
    VALUES (1, 1, 1, $1, $2)`, [await dictionary("promax"), await dictionary("unknown")]);
  const legacyRecord = async (id, stream, observedAt) => client.query(`INSERT INTO ${s}.typed_telemetry_records
      (id, namespace_id, format, source_row_id, owner_id, device_id, chunk_id, manifest_id, stream, occurrence_id,
       observed_at_ms, observed_day, provider_id, canonical_digest)
    VALUES ($1, 1, 10, $1, 1, 1, 1, NULL, $2, $3, $4, $5, $6, $7)`,
  [id, stream, Buffer.from(`synthetic-occurrence-${id}`), observedAt, Math.floor(observedAt / 86_400_000),
    await dictionary("openai_codex"), digest()]);
  const legacyUsage = async (id, model, speed, tier, observedAt = at) => {
    await legacyRecord(id, 1, observedAt);
    await client.query(`INSERT INTO ${s}.typed_telemetry_usage (record_id, stream, session_id, model_id, speed_mode_id,
        api_service_tier_id, surface_id, billing_surface_id, reasoning_effort_id, agent_scope_id, outcome_id, attribution_id)
      VALUES ($1, 1, 1, $2, $3, $4, $5, $5, $5, $5, $5, $6)`,
    [id, await dictionary(model), await dictionary(speed), await dictionary(tier), await dictionary("unknown"),
      legacyAttribution]);
  };
  await legacyUsage(1, "gpt-5.5", "standard", "standard");
  await legacyUsage(2, "gpt-6.1-sol", "other", "priority");
  // Another day's unseen model never counts.
  await legacyUsage(3, "synthetic-other-day-model", "fast", "flex", at + 86_400_000);
  await legacyRecord(4, 2, at);
  await client.query(`INSERT INTO ${s}.typed_telemetry_quota (record_id, stream, dimensions_id, limit_id, slot_id)
    VALUES (4, 2, 1, $1, $1)`, [await dictionary("unknown")]);
  // v1.2 family.
  const { rows: [v12Attribution] } = await client.query(`INSERT INTO ${s}.telemetry_v12_typed_attributions
      (account_basis, account_track, plan_basis, plan_type_id, plan_era) VALUES (0, ''::bytea, 0, $1, ''::bytea) RETURNING id`,
  [await dictionary("plus")]);
  const v12Record = async (index, stream) => {
    const { rows } = await client.query(`INSERT INTO ${s}.telemetry_v12_typed_records
        (chunk_id, manifest_id, stream, record_index, occurrence_id, observed_at_ms, observed_day, provider_id, canonical_digest)
      VALUES ('synthetic-chunk', 'synthetic-manifest', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [stream, index, Buffer.from(`synthetic-v12-occurrence-${index}`), at, day, await dictionary("openai_codex"), digest()]);
    return rows[0].id;
  };
  const usageId = await v12Record(0, "usage");
  await client.query(`INSERT INTO ${s}.telemetry_v12_typed_usage (record_id, session_id, model_id, speed_mode_id,
      api_service_tier_id, surface_id, billing_surface_id, reasoning_effort_id, agent_scope_id, outcome_id, attribution_id)
    VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $6, $6, $7)`,
  [usageId, Buffer.from("synthetic-session"), await dictionary("gpt-6.1-sol"), await dictionary("ultrafast"),
    await dictionary("standard"), await dictionary("unknown"), v12Attribution.id]);
  const quotaId = await v12Record(1, "quota");
  await client.query(`INSERT INTO ${s}.telemetry_v12_typed_quota (record_id, plan_type_id, plan_variant_id, limit_id, slot_id,
      attribution_id) VALUES ($1, $2, $3, $3, $3, $4)`,
  [quotaId, await dictionary("plus"), await dictionary("unknown"), v12Attribution.id]);
  await client.query("RESET session_replication_role");
}

test("the probe's one read counts both typed families' tokens for exactly that day", { skip: endpoint === null
  ? "no local PostgreSQL test cluster (PG_TEST_SOCKET or loopback PG_TEST_HOST with PG_TEST_PORT)" : false }, async (t) => {
  const schema = `o_ops_kdetect_${randomBytes(4).toString("hex")}`;
  const pool = new pg.Pool({ host: endpoint.host, port: endpoint.port, user: process.env.PG_TEST_USER ?? "postgres",
    password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only", database: process.env.PG_TEST_DATABASE ?? "postgres",
    ssl: false, max: 2, connectionTimeoutMillis: 5_000 });
  t.after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await applyPostgresMigrations({ role: "primary", schema, pool });
  const client = await pool.connect();
  try {
    await seed(client, schema);
    // A held report carries counts only.
    const report = await runUnseenTokenProbe(client, { schema, day: DAY, listing: "held" });
    assert.deepEqual([report.verdict, report.listing], ["unseen", "held"]);
    assert.deepEqual([report.dimensions.model.records, report.dimensions.model.distinct,
      report.dimensions.model.unseenDistinct, report.dimensions.model.unseenRecords], [3, 2, 1, 2]);
    assert.deepEqual([report.dimensions.speed.unseenDistinct, report.dimensions.speed.sentinels.other], [1, 1]);
    assert.equal(report.dimensions.tier.unseenDistinct, 0);
    // Plans: the two legacy usage records' attribution (pro), the legacy
    // quota's promax, and the v1.2 usage attribution and quota (plus).
    assert.deepEqual([report.dimensions.plan.records, report.dimensions.plan.unseenDistinct], [5, 1]);
    assert.doesNotMatch(JSON.stringify(report), /gpt-6\.1-sol|ultrafast|promax|synthetic/u);
    // The default (owner, round 11) lists exactly that day's in-grammar unseen tokens.
    const listed = await runUnseenTokenProbe(client, { schema, day: DAY });
    assert.equal(listed.listing, "plain");
    assert.deepEqual(listed.dimensions.model.unseen, [{ token: "gpt-6.1-sol", records: 2 }]);
    assert.deepEqual(listed.dimensions.speed.unseen, [{ token: "ultrafast", records: 1 }]);
    assert.deepEqual(listed.dimensions.tier.unseen, []);
    assert.deepEqual(listed.dimensions.plan.unseen, [{ token: "promax", records: 1 }]);
    assert.doesNotMatch(JSON.stringify(listed), /synthetic-other-day-model|synthetic-session|synthetic-occurrence/u);
    const empty = await runUnseenTokenProbe(client, { schema, day: "2026-09-01" });
    assert.deepEqual([empty.verdict, empty.dimensions.model.records], ["clear", 0]);
  } finally {
    client.release();
  }
});
