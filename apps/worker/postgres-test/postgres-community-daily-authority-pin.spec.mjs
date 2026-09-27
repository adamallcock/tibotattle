import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
  applyStockAndStagedMigrations,
  postgresTestEndpoint,
} from "./staged-migrations-harness.mjs";

const ENDPOINT = await postgresTestEndpoint();
const STAGED_FILE = "0093_community_daily_v12_authority_pin.sql";
const PIN_COLUMNS = Object.freeze([
  "telemetry_v12_runtime_state",
  "telemetry_v12_runtime_revision",
  "telemetry_v12_typed_runtime_state",
  "telemetry_v12_typed_runtime_policy_revision",
  "telemetry_v12_accountless_authorization_count",
  "telemetry_v12_next_accountless_authorization_expiry",
]);

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

test("0093 adds a nullable legacy pin and fences v1.2 runtime policy revisions on local PG17", async () => {
  assert.ok(ENDPOINT, "set PG_TEST_SOCKET for this zero-skip PostgreSQL qualification");
  assert.match(process.env.PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.match(ENDPOINT.host, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);

  const schema = "community_daily_pin_" + randomBytes(6).toString("hex");
  const quotedSchema = '"' + schema + '"';
  const q = (name) => '"' + schema + '"."' + name + '"';
  const pool = new pg.Pool({
    ...ENDPOINT,
    password: ENDPOINT.password ?? process.env.PG_TEST_PASSWORD ?? "synthetic-local-only",
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 5_000,
    application_name: "community-daily-v12-authority-pin-pg17-test",
    options: "-c search_path=" + schema + ",pg_catalog",
  });

  try {
    const server = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr() IS NULL AS unix_socket",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17);
    assert.equal(server.rows[0].unix_socket, true);

    await pool.query("CREATE SCHEMA " + quotedSchema);
    await applyPostgresMigrations({ role: "primary", schema, pool });

    const payload = '{"schemaVersion":"community-daily-aggregate-v1.0","day":"2026-09-24"}';
    const digest = createHash("sha256").update(payload).digest("hex");
    const legacyReleasedAt = "2026-09-25T12:00:00.000Z";
    await pool.query(`INSERT INTO ${q("community_daily_aggregates")}(
      source_id,source_namespace,day,revision,payload_json,payload_sha256,
      source_authority_epoch,source_cursor_sequence,policy_revision,collection_revision,
      release_state,released_at)
      VALUES ('synthetic-pin-source','synthetic-pin-namespace','2026-09-24',1,$1,$2,
        0,0,1,1,'published',$3::timestamptz)`, [payload, digest, legacyReleasedAt]);

    const applied = await applyStockAndStagedMigrations({
      role: "primary", schema, pool, stagedFiles: [STAGED_FILE],
    });
    assert.deepEqual(applied.staged.map(({ name }) => name), [STAGED_FILE]);
    assert.deepEqual(applied.promoted, []);

    const legacy = await pool.query(`SELECT ${PIN_COLUMNS.join(",")}
      FROM ${q("community_daily_aggregates")} WHERE revision=1`);
    assert.equal(legacy.rows.length, 1);
    assert.deepEqual(PIN_COLUMNS.map((column) => legacy.rows[0][column]), Array(6).fill(null),
      "0093 leaves publication-time authority unknown for historical rows");

    const insertRevision = async (revision, pin) => pool.query(`INSERT INTO ${q("community_daily_aggregates")}(
      source_id,source_namespace,day,revision,payload_json,payload_sha256,
      source_authority_epoch,source_cursor_sequence,policy_revision,collection_revision,
      telemetry_v12_runtime_state,telemetry_v12_runtime_revision,
      telemetry_v12_typed_runtime_state,telemetry_v12_typed_runtime_policy_revision,
      telemetry_v12_accountless_authorization_count,
      telemetry_v12_next_accountless_authorization_expiry,
      release_state,released_at)
      VALUES ('synthetic-pin-source','synthetic-pin-namespace','2026-09-24',$1,$2,$3,
        0,0,1,1,$4,$5,$6,$7,$8,$9::timestamptz,'published',$10::timestamptz)`,
    [revision, payload, digest,
      pin.runtimeState ?? null, pin.runtimeRevision ?? null,
      pin.typedRuntimeState ?? null, pin.typedRuntimeRevision ?? null,
      pin.authorizationCount ?? null, pin.nextExpiry ?? null, legacyReleasedAt]);

    const completeEmptyPin = {
      runtimeState: "staged", runtimeRevision: 0,
      typedRuntimeState: "staged", typedRuntimeRevision: 1,
      authorizationCount: 0, nextExpiry: null,
    };
    await insertRevision(2, completeEmptyPin);
    await expectCode(insertRevision(3, { ...completeEmptyPin, runtimeRevision: null }), "23514");
    await expectCode(insertRevision(3, { ...completeEmptyPin, nextExpiry: legacyReleasedAt }), "23514");
    await expectCode(insertRevision(3, { ...completeEmptyPin, authorizationCount: 1 }), "23514");
    await insertRevision(3, { ...completeEmptyPin, authorizationCount: 1, nextExpiry: legacyReleasedAt });

    const runtime = q("telemetry_v12_runtime");
    await expectCode(pool.query(`UPDATE ${runtime} SET state='active' WHERE id=1`), "P1005");
    await expectCode(pool.query(`DELETE FROM ${runtime} WHERE id=1`), "P1005");
    await expectCode(pool.query(`TRUNCATE ${runtime}`), "P1005");
    await pool.query(`UPDATE ${runtime} SET state='active',revision=revision+1 WHERE id=1`);
    await expectCode(pool.query(`UPDATE ${runtime} SET state='blocked' WHERE id=1`), "P1005");
    await pool.query(`UPDATE ${runtime} SET state='blocked',revision=revision+1 WHERE id=1`);
    await pool.query(`UPDATE ${runtime} SET state='active',revision=revision+1 WHERE id=1`);
    await expectCode(pool.query(`UPDATE ${runtime} SET revision=revision-1 WHERE id=1`), "P1005");

    const typedRuntime = q("telemetry_v12_typed_runtime");
    await expectCode(pool.query(`UPDATE ${typedRuntime} SET state='active' WHERE id=1`), "P1005");
    await expectCode(pool.query(`DELETE FROM ${typedRuntime} WHERE id=1`), "P1005");
    await expectCode(pool.query(`TRUNCATE ${typedRuntime}`), "P1005");
    await pool.query(`UPDATE ${typedRuntime}
      SET state='active',policy_revision=policy_revision+1 WHERE id=1`);
    await expectCode(pool.query(`UPDATE ${typedRuntime} SET max_day_chunks=max_day_chunks-1 WHERE id=1`), "P1005");
    await pool.query(`UPDATE ${typedRuntime}
      SET max_day_chunks=max_day_chunks-1,policy_revision=policy_revision+1 WHERE id=1`);

    const runtimeRow = await pool.query(`SELECT state,revision FROM ${runtime} WHERE id=1`);
    const typedRuntimeRow = await pool.query(`SELECT state,policy_revision,max_day_chunks
      FROM ${typedRuntime} WHERE id=1`);
    assert.deepEqual(runtimeRow.rows, [{ state: "active", revision: 3 }]);
    assert.deepEqual(typedRuntimeRow.rows, [{ state: "active", policy_revision: 3, max_day_chunks: 4095 }]);
  } finally {
    await pool.query("DROP SCHEMA IF EXISTS " + quotedSchema + " CASCADE");
    await pool.end();
  }
});
