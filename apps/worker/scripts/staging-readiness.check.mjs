import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  assessStagingConfiguration,
  ATTRIBUTION_SCHEMA_COLUMNS,
  ATTRIBUTION_SCHEMA_OBJECTS,
  ATTRIBUTION_SCHEMA_PROBE_SQL,
  COMMUNITY_ANALYSIS_WORK_SCHEMA_PROBE_SQL,
  COMMUNITY_GRAPH_PRESERVATION_SCHEMA_PROBE_SQL,
  COMMUNITY_MODEL_HISTORY_SCHEMA_PROBE_SQL,
  PRE_INCREMENTAL_ANALYSIS_WORK_SCHEMA_PROBE_SQL,
  PRE_INCREMENTAL_MODEL_HISTORY_SCHEMA_PROBE_SQL,
  PRE_INCREMENTAL_GRAPH_PRESERVATION_SCHEMA_PROBE_SQL,
  PREPARED_SOURCE_DAY_SCHEMA_PROBE_SQL,
  REFRESH_LANE_SCHEMA_PROBE_SQL,
  attributionSchemaComplete,
  EXPECTED_STAGING_MIGRATIONS,
  GENERATED_WORKER_ASSET_DIRECTORY,
  PRODUCTION_PUBLIC_ASSET_DIRECTORY,
  probeStagingLive,
  STAGING_PROOF_TYPES,
  stagingOperationReceipt,
  validateStagingMigrationInventory,
  V1_QUOTA_FIT_CURSOR_INDEX_PROBE_SQL,
  V1_QUOTA_FIT_PROJECTION_SCHEMA_PROBE_SQL,
  V1_USAGE_CURSOR_INDEX_PROBE_SQL,
} from "./staging-readiness-lib.mjs";
import {
  checkedInConfig,
  provisionedConfig,
  successSpawn,
  workerDirectory,
} from "./staging-test-fixtures.mjs";

test("checked-in staging configuration is closed and intentionally unprovisioned", () => {
  const result = assessStagingConfiguration(checkedInConfig);
  assert.equal(result.state, "safe_unprovisioned");
  assert.equal(result.collectionAuthorized, false);
  assert.equal(result.evidenceType, STAGING_PROOF_TYPES.STATIC_CONFIGURATION);
  assert.equal(result.liveProof, false);
  assert.equal(result.checks.enrollmentDisabled, true);
  assert.equal(result.checks.accountScopedIngestDisabled, true);
  assert.equal(result.checks.assetsClosed, true);
  assert.equal(result.checks.migrationInventorySafe, true);
  assert.deepEqual(
    result.migrationInventory.USAGE_MONITOR_DB.slice(-11),
    EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(-11),
  );
  assert.deepEqual(
    result.migrationInventory.DELETION_LEDGER,
    EXPECTED_STAGING_MIGRATIONS.DELETION_LEDGER,
  );
  assert.equal(result.checks.resourceIdentifiersConfigured, false);
  assert.deepEqual(result.blockers, [
    "STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED",
  ]);
  assert.equal(JSON.stringify(result).includes("app-usagemonitor-staging"), false);
});

test("migration inventory is exact and rejects missing or unreviewed files", () => {
  assert.deepEqual(EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(-11), [
    "0043_analytical_input_fencing.sql",
    "0044_attribution_transport_staging.sql",
    "0045_attribution_domain_activation.sql",
    "0046_v1_quota_fit_projection.sql",
    "0047_community_analysis_work.sql",
    "0048_community_model_history.sql",
    "0049_preserve_published_graph.sql",
    "0050_preserve_authorized_graph_updates.sql",
    "0051_historical_window_dependencies.sql",
    "0052_prepared_source_days.sql",
    "0053_refresh_lane_watermarks.sql",
  ]);
  const inventory = structuredClone(EXPECTED_STAGING_MIGRATIONS);
  assert.deepEqual(validateStagingMigrationInventory(inventory), {
    ok: true,
    code: null,
  });

  inventory.USAGE_MONITOR_DB.pop();
  assert.deepEqual(validateStagingMigrationInventory(inventory), {
    ok: false,
    code: "LOCAL_MIGRATION_INVENTORY_DRIFT",
  });

  const alteredHistory = structuredClone(EXPECTED_STAGING_MIGRATIONS);
  alteredHistory.USAGE_MONITOR_DB[47] = "0048_unreviewed_model_history.sql";
  assert.deepEqual(validateStagingMigrationInventory(alteredHistory), {
    ok: false,
    code: "LOCAL_MIGRATION_INVENTORY_DRIFT",
  });

  const alteredPreservation = structuredClone(EXPECTED_STAGING_MIGRATIONS);
  alteredPreservation.USAGE_MONITOR_DB[48] = "0049_unreviewed_graph_preservation.sql";
  assert.deepEqual(validateStagingMigrationInventory(alteredPreservation), {
    ok: false,
    code: "LOCAL_MIGRATION_INVENTORY_DRIFT",
  });

  const extra = structuredClone(EXPECTED_STAGING_MIGRATIONS);
  extra.USAGE_MONITOR_DB.push("0029_unreviewed.sql");
  extra.USAGE_MONITOR_DB.sort();
  assert.deepEqual(validateStagingMigrationInventory(extra), {
    ok: false,
    code: "LOCAL_MIGRATION_INVENTORY_DRIFT",
  });

  const missing = assessStagingConfiguration(checkedInConfig, {
    workerDirectory: "/definitely-missing-staging-worker-directory",
  });
  assert.equal(missing.state, "unsafe_configuration");
  assert.equal(missing.checks.migrationInventorySafe, false);
  assert.equal(
    missing.blockers.includes("LOCAL_MIGRATION_INVENTORY_DRIFT"),
    true,
  );
});

test("reconciled migration lineage pins historical SQL and reviewed unapplied repairs", () => {
  // Historical 0041 is the deployed 4519b349 migration. The other digests pin
  // the unchanged SQL from the pre-reconciliation release source a9220795,
  // except the owner-approved 0043 repair and expression-parentheses-only
  // remote-parser compatibility repair of unapplied 0044/0045. Never change
  // already-applied SQL or silently update these historical pins.
  const expectedDigests = {
    "0041_community_model_composition_cache.sql": "52ff5ff182023bd504c5d584e4c96494c04db7f29a70661dd5713c4a8770d12d",
    "0042_community_model_composition.sql": "c61629ef87facfc8f8d8e16fc5cdc1d4adaf788df7bcc9ee760b60f86e577330",
    "0043_analytical_input_fencing.sql": "acc7c319478487eec408c5bbcebd90e60f029fb02a608c901b7c6f71706c2f49",
    "0044_attribution_transport_staging.sql": "9b2661a5052ca8a08e18098e960891a49e7f1c7516b2c1b8cacf32c6f294f5e4",
    "0045_attribution_domain_activation.sql": "89f0df9e95eb98fa7ae8cb00dc82fe19f8933689a8002e647e638fdc870990fe",
  };
  const names = EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB;
  assert.equal(names.length, 53);
  assert.deepEqual(names.slice(40, 45), Object.keys(expectedDigests));
  assert.deepEqual(names.map((name) => name.slice(0, 4)),
    Array.from({ length: 53 }, (_, index) => String(index + 1).padStart(4, "0")));
  // Unique numeric prefixes make staging, production and Wrangler ordering
  // agree; never admit two differently authored migrations numbered 0041.
  assert.deepEqual([...names].sort(), [...names].sort((a, b) => a.localeCompare(b, "en")));
  for (const [name, expected] of Object.entries(expectedDigests)) {
    const bytes = readFileSync(join(workerDirectory, "migrations", name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, name);
  }
});

test("remote trigger parser repair changes only complete CASE expression parentheses", () => {
  // D1's remote query parser misidentifies an unparenthesized CASE END inside
  // a trigger as its terminator (workers-sdk#4727, reproduced read-only with
  // EXPLAIN on 2026-09-05). Local SQLite/Miniflare alone does not expose this.
  // Undo exactly the new wrappers and require the original reviewed bytes;
  // no guard, literal, NULL branch or data operation may change incidentally.
  for (const [name, selectCount, originalDigest] of [
    ["0044_attribution_transport_staging.sql", 11, "6d79465243432097aebc20f50718f891e01de234a3b264a984816c54b338e713"],
    ["0045_attribution_domain_activation.sql", 7, "0e4bd66cc391f64b8b1a3d1533751cec461882282160cc283330bfba22ff9690"],
  ]) {
    const sql = readFileSync(join(workerDirectory, "migrations", name), "utf8");
    assert.equal((sql.match(/SELECT \(CASE\b/gu) ?? []).length, selectCount);
    assert.equal((sql.match(/\bCASE\b/gu) ?? []).length, name.startsWith("0044") ? 12 : 7);
    assert.equal(/SELECT CASE\b/u.test(sql), false);
    const original = sql.replaceAll("SELECT (CASE", "SELECT CASE")
      .replaceAll(" END);", " END;")
      .replaceAll(">= (CASE WHEN (", ">= CASE WHEN (")
      .replaceAll("THEN 20000 ELSE 2000 END)", "THEN 20000 ELSE 2000 END");
    assert.equal(createHash("sha256").update(original).digest("hex"), originalDigest, name);
  }
});

test("the local-only staged checkpoint migration is pinned to its reviewed immutable schema", () => {
  const bytes = readFileSync(join(workerDirectory, "migrations", "0047_community_analysis_work.sql"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "33dee59044b36e87839b6fb33447f81bfb75cb2cdd208b4624c0a8ec91a1ef5d");
  assert.equal(ATTRIBUTION_SCHEMA_OBJECTS.some(([type, name]) =>
    type === "table" && name === "community_analysis_work_stage"), true);
  assert.equal(ATTRIBUTION_SCHEMA_OBJECTS.some(([type, name]) =>
    type === "trigger" && name === "community_analysis_work_parts_immutable"), true);
  assert.equal(ATTRIBUTION_SCHEMA_COLUMNS.community_analysis_work_parts.includes("part_key"), false);
});

test("the historical-model migration is pinned independently of its derived schema proof", () => {
  // A metadata-equivalent file could still add unreviewed data operations.
  // Keep this local-only migration byte-pinned as well as shape-rehearsed;
  // changing its expectation requires an explicit review before deployment.
  const bytes = readFileSync(join(workerDirectory, "migrations", "0048_community_model_history.sql"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "5b772c33723e2dd2d9f992738c731efea12831ba774806859ce6d16d481ceb29");
  assert.equal(ATTRIBUTION_SCHEMA_OBJECTS.filter(([type, name]) =>
    type === "table" && name.startsWith("community_model_history_")).length, 5);
  assert.equal(ATTRIBUTION_SCHEMA_COLUMNS.community_model_composition_days.includes("history_method_version"), true);
});

test("graph preservation migration is independently byte-pinned with the D1 CASE parser guard", () => {
  // The schema probe cannot prove a one-time data statement was not changed.
  // Pin this reviewed forward migration separately, including its fence seed.
  const bytes = readFileSync(join(workerDirectory, "migrations", "0049_preserve_published_graph.sql"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "2de001ced4ee2a9f8fe4f8d0789ac0362699ca8c7e4942bc06f3d78645164ec8");
  const sql = bytes.toString("utf8");
  assert.equal((sql.match(/\bCASE\b/gu) ?? []).length, 1);
  assert.equal(sql.includes("graph_append_epoch = (CASE WHEN"), true);
  assert.equal(sql.includes("THEN mutation_epoch + 1 ELSE -1 END)"), true);
  // Wrangler strips inline SQL comments when splitting migration statements.
  // Keep explanatory comments outside the exact stored trigger contracts so
  // direct SQLite and Wrangler produce identical, independently pinned SQL.
  const triggers = [...sql.matchAll(/CREATE TRIGGER\b[\s\S]*?END;/gu)].map(match => match[0]);
  assert.equal(triggers.length, 2);
  assert.equal(triggers.some(trigger => /--|\/\*/u.test(trigger)), false);
});

test("reviewed incremental migrations are byte-pinned and retain literal-safe remote parser contracts", () => {
  const reviewed = {
    "0050_preserve_authorized_graph_updates.sql": "373d86b5bbec0bd099d157cb9cb0e2fd48a0787f246b6cbd851a49037fcfdbbc",
    "0051_historical_window_dependencies.sql": "38bdad2ec70b1554bf99265da15531534d1c0d08f16fa82ac57bfd5268be86be",
    "0052_prepared_source_days.sql": "87297097e424dbd36d0608cd1b2f835ed1d9e9fc7ce5f365a83d5b223ab7906a",
    "0053_refresh_lane_watermarks.sql": "ee000c3265c9119f509936260f117f8a4c1aaa2dcc053de609c6d51a89f3d36f",
  };
  for (const [name, digest] of Object.entries(reviewed)) {
    const bytes = readFileSync(join(workerDirectory, "migrations", name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, name);
    const sql = bytes.toString("utf8");
    const triggers = [...sql.matchAll(/CREATE TRIGGER\b[\s\S]*?END;/gu)].map(match => match[0]);
    assert.equal(triggers.some(trigger => /--|\/\*/u.test(trigger)), false, name);
    assert.equal(triggers.some(trigger => /(?<!\()\bCASE\b/u.test(trigger)), false, name);
  }
  assert.ok(Buffer.byteLength(ATTRIBUTION_SCHEMA_PROBE_SQL) < 100_000, "one bounded metadata query remains below 100 KB");
});

test("historical production prefix upgrades forward without losing source rows or legacy schema", () => {
  const database = new DatabaseSync(":memory:");
  const apply = (name) => database.exec(readFileSync(join(workerDirectory, "migrations", name), "utf8"));
  const rows = (sql) => database.prepare(sql).all().map((row) => ({ ...row }));
  try {
    const names = EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB;
    for (const name of names.slice(0, 41)) apply(name);
    assert.equal(names[40], "0041_community_model_composition_cache.sql");
    assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'community_model_composition_cache'").get().count, 0);
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false);
    database.exec(`
      INSERT INTO participants (id, access_token_id, access_token_hash,
        recovery_token_id, recovery_token_hash, consent_version, consented_at, created_at)
      VALUES ('fixture-participant', 'fixture-access', X'01', 'fixture-recovery', X'02',
        'fixture-consent', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z');
      INSERT INTO web_sessions (id, participant_id, secret_hash, csrf_hash,
        issued_at, expires_at, last_used_at)
      VALUES ('fixture-session', 'fixture-participant', zeroblob(32), zeroblob(32),
        '2026-08-29T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day'),
        '2026-08-29T00:00:00.000Z');
      INSERT INTO upload_authorizations (id, participant_id, issued_by_session_id,
        secret_hash, envelope_digest, body_bytes, content_type, state,
        issued_at, expires_at, consume_lease_expires_at)
      VALUES ('fixture-upload', 'fixture-participant', 'fixture-session', zeroblob(32),
        lower(hex(zeroblob(32))), 1, 'application/json', 'consuming',
        '2026-08-29T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day'));
      INSERT INTO telemetry_contributions (id, participant_id, plaintext_digest,
        envelope_digest, r2_key, schema_version, range_start, range_end,
        client_platform, provider_policy_epoch, priced_event_coverage_percent,
        unknown_model_event_count, unknown_billable_units, price_basis,
        declared_record_count, created_at, upload_authorization_id)
      VALUES ('fixture-contribution', 'fixture-participant', 'fixture-plaintext',
        'fixture-envelope', 'fixture-quarantine-key', 'telemetry-contribution-v0.1',
        '2026-08-29T00:00:00.000Z', '2026-08-29T01:00:00.000Z', 'macos',
        'fixture-policy', 100, 0, 0, 'fixture-basis', 1, '2026-08-29T01:00:00.000Z', 'fixture-upload');
      UPDATE admin_community_allowance_preview_refresh_state
        SET last_attempted_at = '2026-08-29T02:00:00.000Z' WHERE singleton = 1;
      INSERT INTO community_allowance_fit_cache
        (participant_id, cache_key, fits_json, computed_at, model_observations_json)
      VALUES ('fixture-participant', 'fixture-old-fit', '[]', '2026-08-29T02:00:00.000Z', '[]');
    `);
    const participantBefore = rows("SELECT * FROM participants");
    const contributionBefore = rows("SELECT * FROM telemetry_contributions");
    const refreshBefore = rows("SELECT * FROM admin_community_allowance_preview_refresh_state");
    const legacyColumnBefore = rows("SELECT * FROM pragma_table_info('community_allowance_fit_cache') WHERE name = 'model_observations_json'");
    apply(names[41]);
    database.exec(`
      INSERT INTO community_model_composition_cache
        (participant_id, cache_key, composition_json, computed_at)
      VALUES ('fixture-participant', 'fixture-old-composition', '{}', '2026-08-29T02:00:00.000Z');
      INSERT INTO community_model_composition_days (day, payload_json, computed_at)
      VALUES ('2026-08-29', '{}', '2026-08-29T02:00:00.000Z');
    `);
    for (const name of names.slice(42)) apply(name);
    assert.deepEqual(rows("SELECT * FROM participants"), participantBefore);
    assert.deepEqual(rows("SELECT * FROM telemetry_contributions"), contributionBefore);
    assert.deepEqual(rows("SELECT * FROM admin_community_allowance_preview_refresh_state"), refreshBefore);
    assert.deepEqual(rows("SELECT * FROM pragma_table_info('community_allowance_fit_cache') WHERE name = 'model_observations_json'"), legacyColumnBefore);
    // The existing fencing SQL deliberately invalidates old-method derived
    // fits, not accepted source history or the historical refresh singleton.
    assert.equal(database.prepare("SELECT count(*) AS count FROM community_allowance_fit_cache").get().count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM community_model_composition_cache").get().count, 0);
    assert.deepEqual(rows("SELECT day, payload_json, attribution_method_version, source_mutation_epoch, history_method_version FROM community_model_composition_days"), [{
      day: "2026-08-29", payload_json: "{}", attribution_method_version: null, source_mutation_epoch: null, history_method_version: null,
    }]);
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), true);
    assert.deepEqual(rows("SELECT minimum_rank, revision FROM telemetry_transport_participant_floors"), [{ minimum_rank: 1, revision: 0 }]);
    assert.equal(database.prepare("SELECT lifecycle FROM telemetry_transport_formats WHERE format_rank = 11").get().lifecycle, "staged");
    assert.equal(database.prepare("SELECT count(*) AS count FROM telemetry_v11_device_consents").get().count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM telemetry_v11_domain_heads").get().count, 0);
    // The composition withdrawal trigger predates the attribution probe's
    // object inventory and must remain independently effective after upgrade.
    assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'community_model_composition_day_withdrawal'").get().count, 1);
    database.exec("UPDATE participants SET state = 'deleting' WHERE id = 'fixture-participant'");
    assert.equal(database.prepare("SELECT count(*) AS count FROM community_model_composition_days").get().count, 0);
    assert.equal(database.prepare("SELECT revision FROM community_analytical_input_versions WHERE participant_id = 'fixture-participant'").get().revision, 2);
    database.exec(`INSERT INTO community_model_composition_cache
      (participant_id, cache_key, composition_json, computed_at)
      VALUES ('fixture-participant', 'fixture-current-composition', '{}', '2026-08-29T03:00:00.000Z');
      DELETE FROM participants WHERE id = 'fixture-participant';`);
    assert.equal(database.prepare("SELECT count(*) AS count FROM community_model_composition_cache").get().count, 0);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("fresh reconciled schema and attribution metadata probe cover every new guard, view, index and persisted column", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const objectNames = () => database.prepare(
      "SELECT type, name FROM sqlite_master WHERE sql IS NOT NULL",
    ).all().map(({ type, name }) => `${type}:${name}`);
    let oldObjects;
    for (const name of EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB) {
      if (name === "0043_analytical_input_fencing.sql") oldObjects = new Set(objectNames());
      database.exec(readFileSync(join(workerDirectory, "migrations", name), "utf8"));
    }
    assert.deepEqual(objectNames().filter((name) => !oldObjects.has(name)).sort(),
      ATTRIBUTION_SCHEMA_OBJECTS.map(([type, name]) => `${type}:${name}`).sort());
    assert.deepEqual({ ...database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get() }, {
      attribution_objects: 1,
      attribution_columns: 1,
    });
    assert.deepEqual(database.prepare("SELECT last_attempted_at FROM admin_community_allowance_preview_refresh_state").get().last_attempted_at, "1970-01-01T00:00:00.000Z");
    assert.equal(database.prepare("SELECT count(*) AS count FROM pragma_table_info('community_allowance_fit_cache') WHERE name = 'model_observations_json'").get().count, 1);
    // A migration label cannot substitute for a lost integrity guard. Every
    // reviewed non-table object must independently make the probe fail closed.
    for (const [type, name] of ATTRIBUTION_SCHEMA_OBJECTS) {
      if (type === "table") continue;
      database.exec(`SAVEPOINT missing_schema; DROP ${type} ${name};`);
      const row = database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get();
      assert.equal(row.attribution_objects, 0, name);
      assert.equal(attributionSchemaComplete(row), false, name);
      database.exec("ROLLBACK TO missing_schema; RELEASE missing_schema;");
    }
    // An object with the prerequisite's name but a different seek contract is
    // insufficient. Exercise absent, reordered, partial and descending keys.
    const cursorIndex = "telemetry_v1_records_participant_stream_observed";
    for (const replacement of [
      "",
      `CREATE INDEX ${cursorIndex} ON telemetry_v1_records(participant_id, observed_at, stream)`,
      `CREATE INDEX ${cursorIndex} ON telemetry_v1_records(participant_id, stream, observed_at) WHERE stream = 'usage'`,
      `CREATE INDEX ${cursorIndex} ON telemetry_v1_records(participant_id, stream, observed_at DESC)`,
      `CREATE INDEX ${cursorIndex} ON telemetry_v1_records(participant_id, stream, observed_at COLLATE NOCASE)`,
      `CREATE INDEX ${cursorIndex} ON telemetry_v1_records(participant_id, stream, substr(observed_at, 1))`,
      `CREATE INDEX ${cursorIndex} ON telemetry_v1_records(participant_id, stream, observed_at, occurrence_id)`,
    ]) {
      database.exec(`SAVEPOINT wrong_cursor; DROP INDEX ${cursorIndex}; ${replacement};`);
      const row = database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get();
      assert.equal(row.attribution_objects, 0, replacement || "missing 0036 cursor index");
      assert.equal(attributionSchemaComplete(row), false);
      database.exec("ROLLBACK TO wrong_cursor; RELEASE wrong_cursor;");
    }
    // The physical suffix is rowid; the SQL cursor specifically uses r.id.
    // A renamed column keeps index metadata intact but breaks that contract.
    database.exec("SAVEPOINT wrong_cursor_id; ALTER TABLE telemetry_v1_records RENAME COLUMN id TO non_cursor_id;");
    assert.equal(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get().attribution_objects, 0);
    database.exec("ROLLBACK TO wrong_cursor_id; RELEASE wrong_cursor_id;");
    for (const [table, column] of [
      ["device_credential_rotations", "recovery_proof_hash"],
      ["community_allowance_fit_cache", "input_fingerprint"],
      ["attribution_enrollments", "namespace"],
      ["telemetry_v11_records", "legacy_record_json"],
      ["telemetry_v11_domains", "input_revision"],
      ["community_model_history_work", "fixed_now"],
      ["community_model_history_work_parts", "payload_json"],
      ["community_model_history_work_stage", "replay_json"],
      ["community_model_history_results", "input_fingerprint"],
      ["community_model_composition_days", "history_method_version"],
      ["community_snapshot_mutation_control", "graph_append_epoch"],
      ["community_snapshot_mutation_control", "graph_invalidation_epoch"],
    ]) {
      assert.equal(ATTRIBUTION_SCHEMA_COLUMNS[table].includes(column), true);
      database.exec(`SAVEPOINT missing_column; ALTER TABLE ${table} RENAME COLUMN ${column} TO omitted_column;`);
      const row = database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get();
      assert.equal(row.attribution_columns, 0, `${table}.${column}`);
      assert.equal(attributionSchemaComplete(row), false);
      database.exec("ROLLBACK TO missing_column; RELEASE missing_column;");
    }
    assert.deepEqual(database.prepare(
      "SELECT schema_version, lifecycle FROM telemetry_transport_formats ORDER BY format_rank",
    ).all().map((row) => ({ ...row })), [
      { schema_version: "telemetry-contribution-v0.1", lifecycle: "accepted" },
      { schema_version: "telemetry-contribution-v0.2", lifecycle: "blocked" },
      { schema_version: "telemetry-contribution-v1.0", lifecycle: "accepted" },
      { schema_version: "telemetry-contribution-v1.1", lifecycle: "staged" },
    ]);
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(attributionSchemaComplete(undefined), false);
    assert.equal(attributionSchemaComplete({ attribution_objects: true, attribution_columns: true }), false);
  } finally {
    database.close();
  }
});

test("v1 cursor prerequisite requires id to be the rowid alias, not merely an indexed column", () => {
  for (const [idDefinition, suffix, expected] of [
    ["id INTEGER PRIMARY KEY", "", 1],
    ["id INTEGER PRIMARY KEY AUTOINCREMENT", "", 1],
    ["id INTEGER PRIMARY KEY DESC", "", 0],
    ["id INT PRIMARY KEY", "", 0],
    ["id INTEGER", "", 0],
    ["id INTEGER", ", PRIMARY KEY (id, participant_id)", 0],
  ]) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE telemetry_v1_records (${idDefinition}, participant_id TEXT,
        stream TEXT, observed_at TEXT ${suffix});
        CREATE INDEX telemetry_v1_records_participant_stream_observed
          ON telemetry_v1_records(participant_id, stream, observed_at);`);
      assert.equal(database.prepare(V1_USAGE_CURSOR_INDEX_PROBE_SQL).get().v1_usage_cursor_index,
        expected, `${idDefinition}${suffix}`);
    } finally {
      database.close();
    }
  }
});

test("quota projection readiness retains predecessor gates and requires the complete 0050–0053 schema", () => {
  const database = new DatabaseSync(":memory:");
  const indexName = "telemetry_v1_quota_fit_rows_cursor";
  const apply = (name) => database.exec(readFileSync(join(workerDirectory, "migrations", name), "utf8"));
  const probe = () => database.prepare(V1_QUOTA_FIT_CURSOR_INDEX_PROBE_SQL).get().v1_quota_fit_cursor_index;
  try {
    const names = EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB;
    for (const name of names.slice(0, 45)) apply(name);
    assert.equal(names[44], "0045_attribution_domain_activation.sql");
    assert.equal(names[45], "0046_v1_quota_fit_projection.sql");
    assert.equal(names[46], "0047_community_analysis_work.sql");
    assert.equal(names[47], "0048_community_model_history.sql");
    assert.equal(names[48], "0049_preserve_published_graph.sql");
    assert.equal(probe(), 0);
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false);
    apply(names[45]);
    assert.equal(probe(), 1);
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false);
    apply(names[46]);
    assert.equal(database.prepare(PRE_INCREMENTAL_ANALYSIS_WORK_SCHEMA_PROBE_SQL).get().community_analysis_work_schema, 1);
    assert.equal(database.prepare(COMMUNITY_MODEL_HISTORY_SCHEMA_PROBE_SQL).get().community_model_history_schema, 0);
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false);
    apply(names[47]);
    assert.equal(database.prepare(PRE_INCREMENTAL_MODEL_HISTORY_SCHEMA_PROBE_SQL).get().community_model_history_schema, 1);
    assert.equal(database.prepare(COMMUNITY_GRAPH_PRESERVATION_SCHEMA_PROBE_SQL).get().community_graph_preservation_schema, 0);
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false);
    apply(names[48]);
    assert.equal(database.prepare(PRE_INCREMENTAL_GRAPH_PRESERVATION_SCHEMA_PROBE_SQL).get().community_graph_preservation_schema, 1);
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false);
    for (const name of names.slice(49)) {
      apply(name);
      assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), name === names[52], name);
    }
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), true);
    const original = database.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(indexName).sql;
    const variants = [
      ["missing index", ""],
      ["reordered keys", original.replace("participant_id, resets_at", "resets_at, participant_id")],
      ["descending key", original.replace("resets_at, observed_at", "resets_at, observed_at DESC")],
      ["nonbinary collation", original.replace("resets_at, observed_at", "resets_at, observed_at COLLATE NOCASE")],
      ["expression key", original.replace("resets_at, observed_at", "resets_at, substr(observed_at, 1)")],
      ["extra key", original.replace("resets_at, observed_at", "resets_at, observed_at, resets_at")],
      ["explicit rowid key", original.replace("resets_at, observed_at", "resets_at, observed_at, record_id")],
      ["unique index", original.replace("CREATE INDEX", "CREATE UNIQUE INDEX")],
      ["partial index", `${original} WHERE resets_at > ''`],
    ];
    for (const [label, replacement] of variants) {
      assert.notEqual(replacement, original, label);
      database.exec(`SAVEPOINT wrong_quota_cursor; DROP INDEX ${indexName}; ${replacement};`);
      assert.equal(probe(), 0, label);
      const row = database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get();
      assert.equal(row.attribution_objects, 0, label);
      assert.equal(attributionSchemaComplete(row), false, label);
      database.exec("ROLLBACK TO wrong_quota_cursor; RELEASE wrong_quota_cursor;");
    }
    assert.equal(probe(), 1);
  } finally {
    database.close();
  }
});

function assertMigrationSchemaVariants(migrationName, probeSql, field, variants, through = 53) {
  const original = readFileSync(join(workerDirectory, "migrations", migrationName), "utf8");
  for (const [label, replace] of variants) {
    const replacement = replace(original);
    assert.notEqual(replacement, original, label);
    const database = new DatabaseSync(":memory:");
    try {
      for (const name of EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(0, through)) {
        database.exec(name === migrationName ? replacement
          : readFileSync(join(workerDirectory, "migrations", name), "utf8"));
      }
      assert.equal(database.prepare(probeSql).get()[field], 0, label);
      assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false, label);
    } finally {
      database.close();
    }
  }
}

function inSchemaObject(name, change) {
  return sql => {
    const match = sql.match(new RegExp(`CREATE (TABLE|INDEX|TRIGGER) ${name}\\b`, "u"));
    assert.notEqual(match, null, name);
    const terminator = match[1] === "TRIGGER" ? "END;" : ";";
    const end = sql.indexOf(terminator, match.index) + terminator.length;
    assert.ok(end > match.index, name);
    return sql.slice(0, match.index) + change(sql.slice(match.index, end)) + sql.slice(end);
  };
}

test("authorized graph schema rejects altered capability, identity, epoch, cleanup and hard-floor guards", () => {
  const trigger = name => inSchemaObject(name, sql => sql.replace(/BEGIN[\s\S]*END;/u, "BEGIN SELECT 1; END;"));
  assertMigrationSchemaVariants("0050_preserve_authorized_graph_updates.sql",
    COMMUNITY_GRAPH_PRESERVATION_SCHEMA_PROBE_SQL, "community_graph_preservation_schema", [
      ["scope owner cascade weakened", sql => sql.replace("ON DELETE CASCADE", "ON DELETE RESTRICT")],
      ["scope participant index altered", sql => sql.replace("ON community_graph_update_scope(participant_id)", "ON community_graph_update_scope(participant_id COLLATE NOCASE)")],
      ["scope phase unreviewed", sql => sql.replace("('supersede', 'insert')", "('supersede', 'insert', 'other')")],
      ["scope expected epoch weakened", sql => sql.replaceAll("u.expected_epoch = mutation_epoch", "u.expected_epoch <= mutation_epoch")],
      ["supersession old owner omitted", sql => sql.replace("WHERE id = OLD.participant_id OR id = NEW.participant_id", "WHERE id = NEW.participant_id")],
      ["supersession target mutated", sql => sql.replace("AND NEW.id = OLD.id", "AND NEW.id <> OLD.id")],
      ["replacement digest unchecked", sql => sql.replace(" AND u.chunk_digest = NEW.chunk_digest", "")],
      ["replacement envelope unchecked", sql => sql.replace(" AND u.envelope_digest = NEW.envelope_digest", "")],
      ["replacement count unchecked", sql => sql.replace("u.record_count = NEW.accepted_record_count", "u.record_count >= NEW.accepted_record_count")],
      ["scope not consumed", sql => sql.replace("DELETE FROM community_graph_update_scope WHERE new_chunk_id = NEW.id;", "SELECT 1;")],
      ["stale marker allowed", sql => sql.replaceAll("AND NEW.graph_append_epoch IS NOT OLD.graph_append_epoch", "")],
      ["hard floor not advanced", sql => sql.replace("graph_invalidation_epoch = NEW.mutation_epoch", "graph_invalidation_epoch = OLD.mutation_epoch")],
      ...["community_allowance_input_mutated", "community_analytical_input_v1_update", "community_analytical_input_v1_insert"]
        .map(name => [`no-op ${name}`, trigger(name)]),
    ]);
});

test("window dependency schema rejects widened scope, missing authority invalidation and invented legacy revisions", () => {
  assertMigrationSchemaVariants("0051_historical_window_dependencies.sql",
    COMMUNITY_MODEL_HISTORY_SCHEMA_PROBE_SQL, "community_model_history_schema", [
      ["dependency owner cascade weakened", sql => sql.replace("ON DELETE CASCADE", "ON DELETE RESTRICT")],
      ["wrong dependency window", sql => sql.replace("date(day, '-100 days')", "date(day, '-99 days')")],
      ["dependency index reordered", sql => sql.replace("ON community_model_history_dependencies(day, participant_id)", "ON community_model_history_dependencies(participant_id, day)")],
      ["old result revision invented", sql => sql.replace("ADD COLUMN dependency_revision INTEGER", "ADD COLUMN dependency_revision INTEGER DEFAULT 0")],
      ["revision bound widened", sql => sql.replaceAll("dependency_revision < 9007199254740991", "dependency_revision <= 9007199254740991")],
      ["correction prior owner ignored", sql => sql.replaceAll("participant_id = OLD.participant_id OR participant_id = NEW.participant_id", "participant_id = NEW.participant_id")],
      ["source authority field ignored", sql => sql.replaceAll("  OR OLD.device_upload_authorization_id IS NOT NEW.device_upload_authorization_id\n", "")],
      ...["community_model_history_dependency_legacy_insert", "community_model_history_dependency_legacy_update",
        "community_model_history_dependency_legacy_delete", "community_model_history_dependency_successor_insert",
        "community_model_history_dependency_successor_update", "community_model_history_dependency_successor_delete",
        "community_model_history_dependency_participant_state"].map(name => [
        `missing ${name}`, inSchemaObject(name, () => ""),
      ]),
    ]);
});

test("prepared-day schema pins raw-reader compatibility, bounded storage, exact cursors and erasure revocation", () => {
  for (const [probe, field] of [
    [COMMUNITY_ANALYSIS_WORK_SCHEMA_PROBE_SQL, "community_analysis_work_schema"],
    [COMMUNITY_MODEL_HISTORY_SCHEMA_PROBE_SQL, "community_model_history_schema"],
  ]) assertMigrationSchemaVariants("0052_prepared_source_days.sql", probe, field, [
    ["old work silently switches reader", sql => sql.replaceAll("DEFAULT 'raw-source-pages-1'", "DEFAULT 'prepared-source-days-1'")],
    ["unknown reader policy", sql => sql.replaceAll("('raw-source-pages-1', 'prepared-source-days-1')", "('raw-source-pages-1', 'prepared-source-days-1', 'other')")],
  ]);
  assertMigrationSchemaVariants("0052_prepared_source_days.sql",
    PREPARED_SOURCE_DAY_SCHEMA_PROBE_SQL, "prepared_source_day_schema", [
      ["owner cascade weakened", sql => sql.replace("ON DELETE CASCADE", "ON DELETE RESTRICT")],
      ["head phase widened", sql => sql.replace("('quota', 'usage', 'complete', 'discarding')", "('quota', 'usage', 'complete', 'discarding', 'other')")],
      ["generation uniqueness weakened", sql => sql.replace("UNIQUE (participant_id, source_day, generation)", "UNIQUE (participant_id, generation)")],
      ["control byte bound widened", sql => sql.replace("<= 16384", "<= 16385")],
      ["usage bins byte bound widened", sql => sql.replace("BETWEEN 1 AND 131072", "BETWEEN 1 AND 131073")],
      ["cost affinity changed", sql => sql.replace("cost_nanousd INTEGER", "cost_nanousd REAL")],
      ["unknown cost becomes priced", sql => sql.replace("CHECK ((cost_nanousd IS NULL) = (pricing_status IS NULL))", "CHECK (1)")],
      ["record deletion no longer revokes", inSchemaObject("community_prepared_source_record_delete", sql => sql.replace(/BEGIN[\s\S]*END;/u, "BEGIN SELECT 1; END;"))],
      ["record update no longer revokes", inSchemaObject("community_prepared_source_record_update", sql => sql.replace(/BEGIN[\s\S]*END;/u, "BEGIN SELECT 1; END;"))],
      ...["community_prepared_retirement_cursor", "community_prepared_plan_cursor", "community_prepared_fit_cursor",
        "community_prepared_usage_cursor", "community_prepared_bins_cursor"].map(name => [
        `cursor ${name} reordered`, inSchemaObject(name, sql => sql.replace("participant_id, source_day", "source_day, participant_id")),
      ]),
    ]);
});

test("refresh receipt schema refuses no-op invalidators and weakened completion vocabulary", () => {
  assertMigrationSchemaVariants("0053_refresh_lane_watermarks.sql", REFRESH_LANE_SCHEMA_PROBE_SQL, "refresh_lane_schema", [
    ["lane vocabulary widened", sql => sql.replace("('current', 'daily')", "('current', 'daily', 'other')")],
    ["completion vocabulary widened", sql => sql.replace("('queued', 'complete')", "('queued', 'complete', 'other')")],
    ["epoch nullable", sql => sql.replace("source_epoch INTEGER NOT NULL", "source_epoch INTEGER")],
    ["timestamp-only writes restart work", sql => sql.replace("OR OLD.fits_json IS NOT NEW.fits_json", "OR OLD.computed_at IS NOT NEW.computed_at OR OLD.fits_json IS NOT NEW.fits_json")],
    ...["community_refresh_fit_insert", "community_refresh_fit_update", "community_refresh_fit_delete",
      "community_refresh_model_insert", "community_refresh_model_update", "community_refresh_model_delete"].map(name => [
      `no-op ${name}`, inSchemaObject(name, sql => sql.replace(/BEGIN[\s\S]*END;/u, "BEGIN SELECT 1; END;")),
    ]),
  ]);
});

test("0050–0053 upgrade and rollback preserve publications, source authority and legacy unfinished readers", () => {
  const database = new DatabaseSync(":memory:");
  const apply = name => database.exec(readFileSync(join(workerDirectory, "migrations", name), "utf8"));
  const rows = sql => database.prepare(sql).all().map(row => ({ ...row }));
  const timestamp = "2026-09-07T12:00:00.000Z";
  const fingerprint = "a".repeat(64);
  try {
    const names = EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB;
    for (const name of names.slice(0, 49)) apply(name);
    database.prepare(`INSERT INTO participants (id,access_token_id,access_token_hash,recovery_token_id,
      recovery_token_hash,consent_version,consented_at,created_at)
      VALUES ('fixture-upgrade','fixture-access',X'01','fixture-recovery',X'02','fixture-consent',?,?)`)
      .run(timestamp, timestamp);
    for (const table of ["community_analysis_work", "community_model_history_work"]) {
      database.prepare(`INSERT INTO ${table} (participant_id,run_id,input_revision,input_fingerprint,
        source_kind,source_method_version,fixed_now,observed_at_cutoff,resets_at_cutoff,window_minutes,
        max_quota_rows,phase,progress_revision,control_json,manifest_json,state_sha256)
        VALUES ('fixture-upgrade','fixture-run',1,?,'v1','fixture-method',?,?,?,10080,60000,'plan',3,'{}','[]',?)`)
        .run(fingerprint, timestamp, timestamp, timestamp, fingerprint);
    }
    database.prepare(`INSERT INTO community_model_history_results
      (participant_id,day,input_revision,input_fingerprint,method_version,result_json,computed_at)
      VALUES ('fixture-upgrade','2026-09-06',1,?,'fixture-history','{}',?)`).run(fingerprint, timestamp);
    database.prepare(`INSERT INTO admin_community_allowance_preview_cache
      (singleton,generated_at,payload_json,attribution_method_version,source_mutation_epoch)
      SELECT 1,?,'{"fixture":"published"}','fixture-method',mutation_epoch FROM community_snapshot_mutation_control`)
      .run(timestamp);
    const preserved = ["participants", "collection_controls", "telemetry_transport_formats",
      "telemetry_transport_participant_floors", "telemetry_v1_device_consents", "telemetry_v11_device_consents",
      "telemetry_v11_domain_heads", "admin_community_allowance_preview_cache", "community_allowance_publication_state"];
    const before = Object.fromEntries(preserved.map(table => [table, rows(`SELECT * FROM ${table}`)]));
    const schemaBefore = rows("SELECT type,name,sql FROM sqlite_master ORDER BY type,name");
    const controlBefore = rows("SELECT * FROM community_snapshot_mutation_control");
    const workBefore = Object.fromEntries(["community_analysis_work", "community_model_history_work"]
      .map(table => [table, rows(`SELECT * FROM ${table}`)]));
    const resultBefore = rows("SELECT * FROM community_model_history_results");
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false,
      "the deployed 0049 predecessor is not a complete schema for this release");
    for (const rollback of [true, false]) {
      if (rollback) database.exec("SAVEPOINT incremental_upgrade;");
      for (const name of names.slice(49)) apply(name);
      assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), true);
      for (const table of preserved) assert.deepEqual(rows(`SELECT * FROM ${table}`), before[table], table);
      for (const [table, original] of Object.entries(workBefore)) assert.deepEqual(rows(`SELECT * FROM ${table}`),
        original.map(row => ({ ...row, reader_policy: "raw-source-pages-1" })), table);
      assert.deepEqual(rows("SELECT * FROM community_model_history_results"), resultBefore.map(row => ({ ...row, dependency_revision: null })));
      assert.deepEqual(rows("SELECT singleton_id,mutation_epoch,graph_append_epoch,graph_invalidation_epoch FROM community_snapshot_mutation_control"), controlBefore);
      for (const table of ["community_graph_update_scope", "community_model_history_dependencies", "community_prepared_source_days", "community_refresh_lanes"]) {
        assert.equal(database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} is lazy, not backfilled by migration`);
      }
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
      if (rollback) {
        assert.throws(() => database.exec("SELECT * FROM fixture_deliberate_upgrade_failure"), /no such table/u);
        database.exec("ROLLBACK TO incremental_upgrade; RELEASE incremental_upgrade;");
        assert.deepEqual(rows("SELECT type,name,sql FROM sqlite_master ORDER BY type,name"), schemaBefore);
        assert.deepEqual(rows("SELECT * FROM community_snapshot_mutation_control"), controlBefore);
        for (const [table, original] of Object.entries(workBefore)) assert.deepEqual(rows(`SELECT * FROM ${table}`), original, table);
        assert.deepEqual(rows("SELECT * FROM community_model_history_results"), resultBefore);
        assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false);
      }
    }
  } finally {
    database.close();
  }
});

test("graph preservation schema rejects missing fences and altered append or hard-invalidation contracts", () => {
  const inTrigger = (name, change) => sql => {
    const pattern = new RegExp(`CREATE TRIGGER ${name}\\b[\\s\\S]*?END;`, "u");
    assert.equal(pattern.test(sql), true, name);
    return sql.replace(pattern, change);
  };
  const inMutation = change => inTrigger("community_allowance_input_mutated", change);
  const inAppend = change => inTrigger("community_analytical_input_v1_insert", change);
  assertMigrationSchemaVariants("0049_preserve_published_graph.sql",
    PRE_INCREMENTAL_GRAPH_PRESERVATION_SCHEMA_PROBE_SQL, "community_graph_preservation_schema", [
      ["missing append fence", sql => sql.replace("ALTER TABLE community_snapshot_mutation_control ADD COLUMN graph_append_epoch INTEGER NOT NULL DEFAULT -1;", "")],
      ["missing invalidation fence", sql => sql.replace("ALTER TABLE community_snapshot_mutation_control ADD COLUMN graph_invalidation_epoch INTEGER NOT NULL DEFAULT 0;", "")
        .replace("UPDATE community_snapshot_mutation_control SET graph_invalidation_epoch = mutation_epoch WHERE singleton_id = 1;", "")],
      ...["graph_append_epoch", "graph_invalidation_epoch"].flatMap(column => [
        [`${column} nullable`, sql => sql.replace(`ADD COLUMN ${column} INTEGER NOT NULL`, `ADD COLUMN ${column} INTEGER`)],
        [`${column} wrong affinity`, sql => sql.replace(`ADD COLUMN ${column} INTEGER`, `ADD COLUMN ${column} TEXT`)],
        [`${column} wrong default`, sql => sql.replace(`ADD COLUMN ${column} INTEGER NOT NULL DEFAULT ${column === "graph_append_epoch" ? -1 : 0}`, `ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 1`)],
      ]),
      ["missing invalidation trigger", inMutation(() => "")],
      ["missing append classifier", inAppend(() => "")],
      ["invalidation no-op", inMutation(sql => sql.replace(/BEGIN[\s\S]*END;/u, "BEGIN SELECT 1; END;"))],
      ["append classifier no-op", inAppend(sql => sql.replace(/BEGIN[\s\S]*END;/u, "BEGIN SELECT 1; END;"))],
      ["wrong mutation event", inMutation(sql => sql.replace("UPDATE OF mutation_epoch", "UPDATE OF graph_append_epoch"))],
      ["unchanged epoch treated as mutation", inMutation(sql => sql.replace("OLD.mutation_epoch IS NOT NEW.mutation_epoch", "OLD.mutation_epoch IS NEW.mutation_epoch"))],
      ["publication falsely ready", inMutation(sql => sql.replace("publication_state = 'updating'", "publication_state = 'ready'"))],
      ["hard fence not advanced", inMutation(sql => sql.replace("graph_invalidation_epoch = NEW.mutation_epoch", "graph_invalidation_epoch = OLD.mutation_epoch"))],
      ["hard fence scope omitted", inMutation(sql => sql.replace("singleton_id = 1 AND NOT", "NOT"))],
      ["nonconsecutive append admitted", inMutation(sql => sql.replaceAll("NEW.mutation_epoch = OLD.mutation_epoch + 1", "NEW.mutation_epoch > OLD.mutation_epoch"))],
      ["append epoch mismatch admitted", inMutation(sql => sql.replaceAll("AND NEW.graph_append_epoch = NEW.mutation_epoch", ""))],
      ["reused append marker admitted", inMutation(sql => sql.replaceAll("AND NEW.graph_append_epoch IS NOT OLD.graph_append_epoch", ""))],
      ["hard mutation retains preview", inMutation(sql => sql.replace("DELETE FROM admin_community_allowance_preview_cache WHERE NOT", "DELETE FROM admin_community_allowance_preview_cache WHERE"))],
      ["superseded chunks classified", inAppend(sql => sql.replace("NEW.superseded_at IS NULL", "NEW.superseded_at IS NOT NULL"))],
      ["participant revision unchanged", inAppend(sql => sql.replace("DO UPDATE SET revision = revision + 1", "DO UPDATE SET revision = revision"))],
      ["global epoch unchanged", inAppend(sql => sql.replace("mutation_epoch = mutation_epoch + 1", "mutation_epoch = mutation_epoch"))],
      ["unwrapped D1 CASE expression", inAppend(sql => sql.replace("= (CASE WHEN", "= CASE WHEN").replace("ELSE -1 END)", "ELSE -1 END"))],
      ["replacement revision classified append", inAppend(sql => sql.replace("NEW.revision = 1", "NEW.revision >= 1"))],
      ["inactive owner classified append", inAppend(sql => sql.replace("state = 'active'", "state = 'deleting'"))],
      ["successor evidence ignored", inAppend(sql => sql.replace("      AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id = NEW.participant_id)\n", ""))],
      ["accepted legacy evidence ignored", inAppend(sql => sql.replace("status = 'accepted'", "status = 'withdrawn'"))],
      ["previous chunk identity ignored", inAppend(sql => sql.replace("AND c.id <> NEW.id", "AND c.id = NEW.id"))],
      ["other participant competitor used", inAppend(sql => sql.replace("d.participant_id = NEW.participant_id", "d.participant_id <> NEW.participant_id"))],
      ["other device competitor ignored", inAppend(sql => sql.replace("d.id <> NEW.device_id", "d.id = NEW.device_id"))],
      ["competitor day ignored", inAppend(sql => sql.replace("AND c.chunk_day = NEW.chunk_day AND c.superseded_at IS NULL", "AND c.superseded_at IS NULL"))],
      ["competitor active rows ignored", inAppend(sql => sql.replace("c.accepted_record_count > 0", "c.accepted_record_count > 1"))],
      ["bounded competitor seek removed", inAppend(sql => sql.replace(" INDEXED BY telemetry_v1_chunks_device_day", ""))],
      ["failed classification marked append", inAppend(sql => sql.replace("ELSE -1 END)", "ELSE mutation_epoch + 1 END)"))],
    ], 49);
});

test("graph preservation requires its historical bounded seek indexes, not only their names", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const name of EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB) {
      database.exec(readFileSync(join(workerDirectory, "migrations", name), "utf8"));
    }
    for (const name of ["device_credentials_participant_state", "telemetry_v1_chunks_device_day"]) {
      const original = database.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name).sql;
      for (const replacement of ["", original.replace("participant_id,", "participant_id COLLATE NOCASE,")]) {
        database.exec(`SAVEPOINT graph_index; DROP INDEX ${name}; ${replacement};`);
        assert.equal(database.prepare(COMMUNITY_GRAPH_PRESERVATION_SCHEMA_PROBE_SQL).get().community_graph_preservation_schema, 0, name);
        assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false, name);
        database.exec("ROLLBACK TO graph_index; RELEASE graph_index;");
      }
    }
  } finally {
    database.close();
  }
});

test("0049 rehearses forward and rollback while preserving publication bytes and seeding the hard fence", () => {
  const COMMUNITY_GRAPH_PRESERVATION_SCHEMA_PROBE_SQL = PRE_INCREMENTAL_GRAPH_PRESERVATION_SCHEMA_PROBE_SQL;
  const database = new DatabaseSync(":memory:");
  const apply = name => database.exec(readFileSync(join(workerDirectory, "migrations", name), "utf8"));
  const rows = sql => database.prepare(sql).all().map(row => ({ ...row }));
  try {
    const names = EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB;
    for (const name of names.slice(0, 48)) apply(name);
    database.exec(`UPDATE community_snapshot_mutation_control SET mutation_epoch = 137 WHERE singleton_id = 1;
      INSERT INTO admin_community_allowance_preview_cache
        (singleton, generated_at, payload_json, attribution_method_version, source_mutation_epoch)
        VALUES (1, '2026-09-07T12:00:00.000Z', '{"fixture":"published"}', 'fixture-method', 137);
      UPDATE community_allowance_publication_state SET publication_state = 'ready' WHERE singleton = 1;`);
    const preservedTables = ["admin_community_allowance_preview_cache", "community_allowance_publication_state",
      "participants", "community_analytical_input_versions", "collection_controls", "telemetry_transport_formats",
      "telemetry_transport_participant_floors", "telemetry_v11_device_consents", "telemetry_v11_domain_heads"];
    const before = Object.fromEntries(preservedTables.map(table => [table, rows(`SELECT * FROM ${table}`)]));
    const schemaBefore = rows("SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
    const mutationBefore = rows("SELECT * FROM community_snapshot_mutation_control");
    assert.equal(database.prepare(COMMUNITY_GRAPH_PRESERVATION_SCHEMA_PROBE_SQL).get().community_graph_preservation_schema, 0);
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false);
    database.exec("SAVEPOINT preserve_publication;");
    apply(names[48]);
    assert.equal(database.prepare(COMMUNITY_GRAPH_PRESERVATION_SCHEMA_PROBE_SQL).get().community_graph_preservation_schema, 1);
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false);
    assert.throws(() => database.exec("SELECT * FROM fixture_deliberate_migration_failure;"), /no such table/u);
    database.exec("ROLLBACK TO preserve_publication; RELEASE preserve_publication;");
    assert.deepEqual(rows("SELECT type, name, sql FROM sqlite_master ORDER BY type, name"), schemaBefore);
    assert.deepEqual(rows("SELECT * FROM community_snapshot_mutation_control"), mutationBefore);
    for (const table of preservedTables) assert.deepEqual(rows(`SELECT * FROM ${table}`), before[table], table);
    apply(names[48]);
    assert.deepEqual(rows("SELECT * FROM community_snapshot_mutation_control"), [{
      singleton_id: 1, mutation_epoch: 137, graph_append_epoch: -1, graph_invalidation_epoch: 137,
    }]);
    for (const table of preservedTables) assert.deepEqual(rows(`SELECT * FROM ${table}`), before[table], table);
    const changesBeforeProbe = database.prepare("SELECT total_changes() AS n").get().n;
    assert.equal(database.prepare(COMMUNITY_GRAPH_PRESERVATION_SCHEMA_PROBE_SQL).get().community_graph_preservation_schema, 1);
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false);
    assert.equal(database.prepare("SELECT total_changes() AS n").get().n, changesBeforeProbe);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("0049 only preserves a preview for a fresh single-step append marker and invalidates unknown mutations", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const name of EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(0, 49)) {
      database.exec(readFileSync(join(workerDirectory, "migrations", name), "utf8"));
    }
    const control = () => ({ ...database.prepare("SELECT * FROM community_snapshot_mutation_control").get() });
    const seedPreview = () => database.exec(`INSERT INTO admin_community_allowance_preview_cache
      (singleton, generated_at, payload_json, attribution_method_version, source_mutation_epoch)
      SELECT 1, '2026-09-07T12:00:00.000Z', '{"fixture":"published"}', 'fixture-method', mutation_epoch
        FROM community_snapshot_mutation_control;
      UPDATE community_allowance_publication_state SET publication_state = 'ready' WHERE singleton = 1;`);
    const before = control();
    seedPreview();
    const preview = { ...database.prepare("SELECT * FROM admin_community_allowance_preview_cache").get() };
    database.exec(`UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1,
      graph_append_epoch = mutation_epoch + 1 WHERE singleton_id = 1;`);
    assert.deepEqual({ ...database.prepare("SELECT * FROM admin_community_allowance_preview_cache").get() }, preview);
    assert.deepEqual(control(), {
      singleton_id: 1, mutation_epoch: before.mutation_epoch + 1,
      graph_append_epoch: before.mutation_epoch + 1, graph_invalidation_epoch: before.graph_invalidation_epoch,
    });
    assert.equal(database.prepare("SELECT publication_state FROM community_allowance_publication_state").get().publication_state, "updating");
    database.exec("UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;");
    assert.equal(database.prepare("SELECT count(*) AS n FROM admin_community_allowance_preview_cache").get().n, 0);
    assert.equal(control().graph_invalidation_epoch, control().mutation_epoch);
    for (const sql of [
      // A separately pre-set marker must not authorize the following mutation.
      `UPDATE community_snapshot_mutation_control SET graph_append_epoch = mutation_epoch + 1 WHERE singleton_id = 1;
       UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1 WHERE singleton_id = 1;`,
      `UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 2,
        graph_append_epoch = mutation_epoch + 2 WHERE singleton_id = 1;`,
    ]) {
      seedPreview();
      database.exec(sql);
      assert.equal(database.prepare("SELECT count(*) AS n FROM admin_community_allowance_preview_cache").get().n, 0);
      assert.equal(control().graph_invalidation_epoch, control().mutation_epoch);
      assert.equal(database.prepare("SELECT publication_state FROM community_allowance_publication_state").get().publication_state, "updating");
    }
  } finally {
    database.close();
  }
});

test("projection schema rejects altered table/FK/cursor guards and literal-sensitive maintenance triggers", () => {
  assertMigrationSchemaVariants("0046_v1_quota_fit_projection.sql",
    V1_QUOTA_FIT_PROJECTION_SCHEMA_PROBE_SQL, "v1_quota_fit_projection_schema", [
      ["projection non-rowid key", sql => sql.replace("record_id INTEGER PRIMARY KEY", "record_id INT PRIMARY KEY")],
      ["projection nullable participant", sql => sql.replace("participant_id TEXT NOT NULL", "participant_id TEXT")],
      ["projection nullable reset", sql => sql.replace("resets_at TEXT NOT NULL", "resets_at TEXT")],
      ["projection nullable observation", sql => sql.replace("observed_at TEXT NOT NULL", "observed_at TEXT")],
      ["projection non-strict", sql => sql.replace(") STRICT;", ");")],
      ["projection wrong FK action", sql => sql.replace("ON DELETE CASCADE", "ON DELETE RESTRICT")],
      ["projection wrong FK target", sql => sql.replace("REFERENCES telemetry_v1_records(id)", "REFERENCES participants(id)")],
      ["missing singleton constraint", sql => sql.replace("CHECK (singleton_id = 1)", "")],
      ["wrong completion default", sql => sql.replace("is_complete INTEGER NOT NULL DEFAULT 0", "is_complete INTEGER NOT NULL DEFAULT 1")],
      ["missing completion constraint", sql => sql.replace("CHECK (is_complete IN (0, 1))", "")],
      ["negative highwater accepted", sql => sql.replace("CHECK (through_record_id >= 0)", "")],
      ["negative cursor accepted", sql => sql.replace("CHECK (last_record_id >= 0)", "")],
      ["cursor beyond highwater", sql => sql.replace("CHECK (last_record_id <= through_record_id)", "CHECK (last_record_id >= 0)")],
      ...["WHEN NEW.stream", "WHERE NEW.stream"].flatMap(prefix => [
        [`${prefix} wrong stream`, sql => sql.replace(`${prefix} = 'quota'`, `${prefix} = 'usage'`)],
        [`${prefix} case changed literal`, sql => sql.replace(`${prefix} = 'quota'`, `${prefix} = 'QUOTA'`)],
        [`${prefix} whitespace literal`, sql => sql.replace(`${prefix} = 'quota' AND NEW.limit_id = 'codex'`, `${prefix} = 'quota' AND NEW.limit_id = 'codex '`)],
      ]),
      ["wrong window", sql => sql.replaceAll("10080", "300")],
      ...["provider", "plan_type", "plan_variant", "resets_at", "slot", "used_percent"].map(column =>
        [`missing ${column} null guard`, sql => sql.replaceAll(`AND NEW.${column} IS NOT NULL`, "")]),
      ["extra eligibility restriction", sql => sql.replace("WHEN NEW.stream = 'quota'", "WHEN NEW.used_percent > 0 AND NEW.stream = 'quota'")],
      ["broadened eligibility", sql => sql.replace("WHEN NEW.stream = 'quota'", "WHEN NEW.stream = 'usage' OR NEW.stream = 'quota'")],
      ["missing update provider event", sql => sql.replace("  provider, plan_type, plan_variant, resets_at, slot, used_percent, observed_at", "  plan_type, plan_variant, resets_at, slot, used_percent, observed_at")],
      ["missing correction removal", sql => sql.replace("  DELETE FROM telemetry_v1_quota_fit_rows WHERE record_id = OLD.id;", "  SELECT 1;")],
      ["missing deletion maintenance", sql => sql.replace("AFTER DELETE ON telemetry_v1_records\nBEGIN\n  DELETE FROM telemetry_v1_quota_fit_rows WHERE record_id = OLD.id;", "AFTER DELETE ON telemetry_v1_records\nBEGIN\n  SELECT 1;")],
      ["wrong projected timestamp", sql => sql.replace("NEW.resets_at, NEW.observed_at);", "NEW.resets_at, NEW.resets_at);")],
    ]);
});

test("analysis work schema rejects altered bounds, source/phase/component literals and cascade contracts", () => {
  assertMigrationSchemaVariants("0047_community_analysis_work.sql",
    COMMUNITY_ANALYSIS_WORK_SCHEMA_PROBE_SQL, "community_analysis_work_schema", [
      ["wrong source case", sql => sql.replace("source_kind = 'v1'", "source_kind = 'V1'")],
      ["wrong source whitespace", sql => sql.replace("source_kind = 'v1'", "source_kind = 'v1 '")],
      ["wrong phase spelling", sql => sql.replace("'fitability'", "'fitAbility'")],
      ["wrong component spelling", sql => sql.replace("'plan-anchors'", "'plan-anchors '")],
      ["wrong fingerprint vocabulary", sql => sql.replace("input_fingerprint NOT GLOB '*[^0-9a-f]*'", "input_fingerprint NOT GLOB '*[^0-9A-F]*'")],
      ["wrong state digest vocabulary", sql => sql.replace("state_sha256 NOT GLOB '*[^0-9a-f]*'", "state_sha256 NOT GLOB '*[^0-9A-F]*'")],
      ["wrong part digest vocabulary", sql => sql.replace("payload_sha256 NOT GLOB '*[^0-9a-f]*'", "payload_sha256 NOT GLOB '*[^0-9A-F]*'")],
      ["missing input revision bound", sql => sql.replace("input_revision < 9007199254740991", "input_revision <= 9007199254740991")],
      ["missing progress revision bound", sql => sql.replace("progress_revision < 9007199254740991", "progress_revision <= 9007199254740991")],
      ["wrong quota row cap", sql => sql.replace("BETWEEN 1 AND 60000", "BETWEEN 1 AND 60001")],
      ["wrong control bytes cap", sql => sql.replace("<= 16384", "<= 16385")],
      ["wrong manifest bytes cap", sql => sql.replace("<= 131072", "<= 131073")],
      ["unbounded part count", sql => sql.replace("json_array_length(target_manifest_json) <= 1024", "json_array_length(target_manifest_json) <= 1025")],
      ["wrong payload bytes cap", sql => sql.replace("BETWEEN 1 AND 131072", "BETWEEN 1 AND 131073")],
      ["character count instead of byte count", sql => sql.replace("length(CAST(payload_json AS BLOB))", "length(payload_json)")],
      ["missing control JSON validation", sql => sql.replace("json_valid(control_json)", "length(control_json) > 0")],
      ["missing manifest JSON validation", sql => sql.replace("json_valid(manifest_json)", "length(manifest_json) > 0")],
      ["missing part JSON validation", sql => sql.replace("json_valid(payload_json)", "length(payload_json) > 0")],
      ["wrong owner deletion action", sql => sql.replace("REFERENCES participants(id) ON DELETE CASCADE", "REFERENCES participants(id) ON DELETE RESTRICT")],
      ["wrong part deletion action", sql => sql.replace("REFERENCES community_analysis_work(participant_id, run_id) ON DELETE CASCADE", "REFERENCES community_analysis_work(participant_id, run_id) ON DELETE RESTRICT")],
      ["missing run uniqueness", sql => sql.replace(",\n  UNIQUE (participant_id, run_id)", "")],
      ["wrong part primary key order", sql => sql.replace("PRIMARY KEY (participant_id, run_id, component, payload_sha256)", "PRIMARY KEY (participant_id, run_id, payload_sha256, component)")],
      ["non-strict work table", sql => sql.replace(") STRICT;", ");")],
      ["rowid work parts", sql => sql.replace(") STRICT, WITHOUT ROWID;", ") STRICT;")],
    ]);
});

test("staged checkpoint schema rejects mutable parts and altered replay, progress, cleanup, or erasure contracts", () => {
  const stageStart = "CREATE TABLE community_analysis_work_stage (";
  const inStage = (sql, change) => {
    const offset = sql.indexOf(stageStart);
    assert.notEqual(offset, -1);
    return sql.slice(0, offset) + change(sql.slice(offset));
  };
  assertMigrationSchemaVariants("0047_community_analysis_work.sql",
    COMMUNITY_ANALYSIS_WORK_SCHEMA_PROBE_SQL, "community_analysis_work_schema", [
      ["missing staged table", sql => sql.slice(0, sql.indexOf(stageStart))],
      ["old ordinal-keyed parts", sql => sql.replace("component TEXT NOT NULL CHECK", "part_key INTEGER NOT NULL,\n  component TEXT NOT NULL CHECK")
        .replace("PRIMARY KEY (participant_id, run_id, component, payload_sha256)", "PRIMARY KEY (participant_id, run_id, component, part_key)")],
      ["missing immutable trigger", sql => sql.replace(/CREATE TRIGGER community_analysis_work_parts_immutable[\s\S]*?END;/u, "")],
      ["immutable trigger no-op", sql => sql.replace("SELECT RAISE(ABORT, 'community analysis part immutable');", "SELECT 1;")],
      ["immutable trigger wrong action", sql => sql.replace("SELECT RAISE(ABORT, 'community analysis part immutable');", "SELECT RAISE(IGNORE);")],
      ["immutable trigger late timing", sql => sql.replace("BEFORE UPDATE ON community_analysis_work_parts", "AFTER UPDATE ON community_analysis_work_parts")],
      ["immutable trigger changed literal case", sql => sql.replace("'community analysis part immutable'", "'Community analysis part immutable'")],
      ["immutable trigger changed literal whitespace", sql => sql.replace("'community analysis part immutable'", "'community  analysis part immutable'")],
      ...[
        ["more than one staged target", sql => sql.replace("participant_id TEXT PRIMARY KEY", "participant_id TEXT NOT NULL")],
        ["nullable stage identity", sql => sql.replace("stage_id TEXT NOT NULL", "stage_id TEXT")],
        ["wrong base progress bound", sql => sql.replace("base_progress_revision < 9007199254740990", "base_progress_revision <= 9007199254740990")],
        ["wrong stage revision bound", sql => sql.replace("stage_revision < 9007199254740991", "stage_revision <= 9007199254740991")],
        ["wrong discard revision bound", sql => sql.replace("discard_input_revision < 9007199254740991", "discard_input_revision <= 9007199254740991")],
        ["negative discard revision allowed", sql => sql.replace("discard_input_revision >= 0", "discard_input_revision >= -1")],
        ["wrong stage mode case", sql => sql.replace("'writing'", "'Writing'")],
        ["wrong stage mode whitespace", sql => sql.replace("'discarding'", "'discarding '")],
        ["wrong target phase literal", sql => sql.replace("'complete'", "'Complete'")],
        ["unbounded write cursor", sql => sql.replace("write_offset BETWEEN 0 AND 1024", "write_offset BETWEEN 0 AND 1025")],
        ["unbounded verification cursor", sql => sql.replace("verified_offset BETWEEN 0 AND 1024", "verified_offset BETWEEN 0 AND 1025")],
        ["nullable cleanup component", sql => sql.replace("gc_component TEXT NOT NULL", "gc_component TEXT")],
        ["nullable cleanup digest", sql => sql.replace("gc_sha256 TEXT NOT NULL", "gc_sha256 TEXT")],
        ["wrong staged erasure action", sql => sql.replace("ON DELETE CASCADE", "ON DELETE RESTRICT")],
        ["wrong staged run fence", sql => sql.replace("FOREIGN KEY (participant_id, run_id)", "FOREIGN KEY (run_id, participant_id)")],
        ["non-strict staged table", sql => sql.replace(") STRICT;", ");")],
        ...["target_control_json", "target_manifest_json", "write_manifest_json", "replay_json"].flatMap(column => [
          [`missing ${column} JSON check`, sql => sql.replace(`json_valid(${column})`, `length(${column}) > 0`)],
          [`character count for ${column}`, sql => sql.replace(`length(CAST(${column} AS BLOB))`, `length(${column})`)],
          [`wrong ${column} byte cap`, sql => sql.replace(`length(CAST(${column} AS BLOB)) <= ${column.includes("manifest") ? 131072 : 16384}`,
            `length(CAST(${column} AS BLOB)) <= ${column.includes("manifest") ? 131073 : 16385}`)],
        ]),
        ...["target_manifest_json", "write_manifest_json"].flatMap(column => [
          [`wrong ${column} array type`, sql => sql.replace(`json_type(${column}) = 'array'`, `json_type(${column}) = 'object'`)],
          [`wrong ${column} part cap`, sql => sql.replace(`json_array_length(${column}) <= 1024`, `json_array_length(${column}) <= 1025`)],
        ]),
        ...["target_state_sha256", "state_sha256"].map(column =>
          [`wrong ${column} digest alphabet`, sql => sql.replace(`AND ${column} NOT GLOB '*[^0-9a-f]*'`, `AND ${column} NOT GLOB '*[^0-9A-F]*'`)]),
      ].map(([label, change]) => [label, sql => inStage(sql, change)]),
    ]);
});

test("model history readiness rejects changed checkpoint, result, provenance and correction contracts", () => {
  const inObject = (name, change) => (sql) => {
    const match = sql.match(new RegExp(`CREATE (TABLE|INDEX|TRIGGER) ${name}\\b`, "u"));
    assert.notEqual(match, null, name);
    const terminator = match[1] === "TRIGGER" ? "END;" : ";";
    const end = sql.indexOf(terminator, match.index) + terminator.length;
    assert.ok(end > match.index, name);
    return sql.slice(0, match.index) + change(sql.slice(match.index, end)) + sql.slice(end);
  };
  const inResults = (change) => inObject("community_model_history_results", change);
  const inStage = (change) => inObject("community_model_history_work_stage", change);
  const historyTriggers = ATTRIBUTION_SCHEMA_OBJECTS.filter(([type, name]) =>
    type === "trigger" && name.startsWith("community_model_history_") && !name.includes("_dependency_")).map(([, name]) => name);
  assert.equal(historyTriggers.length, 12);
  assertMigrationSchemaVariants("0048_community_model_history.sql",
    PRE_INCREMENTAL_MODEL_HISTORY_SCHEMA_PROBE_SQL, "community_model_history_schema", [
      ["missing history stage", inObject("community_model_history_work_stage", () => "")],
      ["history owner erasure weakened", sql => sql.replace("REFERENCES participants(id) ON DELETE CASCADE", "REFERENCES participants(id) ON DELETE RESTRICT")],
      ["history namespace aliases current work", sql => sql.replace("REFERENCES community_model_history_work(participant_id, run_id)", "REFERENCES community_analysis_work(participant_id, run_id)")],
      ["history quota cap widened", sql => sql.replace("BETWEEN 1 AND 60000", "BETWEEN 1 AND 60001")],
      ["history revision bound widened", sql => sql.replace("input_revision < 9007199254740991", "input_revision <= 9007199254740991")],
      ["history source changed", sql => sql.replace("source_kind = 'v1'", "source_kind = 'v1 '")],
      ["history part digest vocabulary changed", sql => sql.replace("payload_sha256 NOT GLOB '*[^0-9a-f]*'", "payload_sha256 NOT GLOB '*[^0-9A-F]*'")],
      ["history parts made mutable", inObject("community_model_history_work_parts_immutable", sql => sql.replace("SELECT RAISE(ABORT, 'community analysis part immutable');", "SELECT 1;"))],
      ["history parts use character bounds", sql => sql.replace("length(CAST(payload_json AS BLOB))", "length(payload_json)")],
      ["history stage wrong cascade", inStage(sql => sql.replace("ON DELETE CASCADE", "ON DELETE RESTRICT"))],
      ["history stage replay byte cap widened", inStage(sql => sql.replace("length(CAST(replay_json AS BLOB)) <= 16384", "length(CAST(replay_json AS BLOB)) <= 16385"))],
      ["history stage manifest cap widened", inStage(sql => sql.replace("json_array_length(write_manifest_json) <= 1024", "json_array_length(write_manifest_json) <= 1025"))],
      ["history stage cleanup nullable", inStage(sql => sql.replace("gc_component TEXT NOT NULL", "gc_component TEXT"))],
      ["history result owner erasure weakened", inResults(sql => sql.replace("ON DELETE CASCADE", "ON DELETE RESTRICT"))],
      ["history result wrong owner target", inResults(sql => sql.replace("REFERENCES participants(id)", "REFERENCES web_sessions(id)"))],
      ["history result uniqueness weakened", inResults(sql => sql.replace("PRIMARY KEY (participant_id, day)", "PRIMARY KEY (participant_id, day, input_revision)"))],
      ["history result rowid introduced", inResults(sql => sql.replace("STRICT, WITHOUT ROWID", "STRICT"))],
      ["history result strictness removed", inResults(sql => sql.replace("STRICT, WITHOUT ROWID", "WITHOUT ROWID"))],
      ["history result day shape weakened", inResults(sql => sql.replace("CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')", ""))],
      ["history result revision bound widened", inResults(sql => sql.replace("input_revision < 9007199254740991", "input_revision <= 9007199254740991"))],
      ["history result fingerprint validation weakened", inResults(sql => sql.replace("AND input_fingerprint NOT GLOB '*[^0-9a-f]*'", ""))],
      ["history result method cap widened", inResults(sql => sql.replace("BETWEEN 1 AND 4096", "BETWEEN 1 AND 4097"))],
      ["history result JSON validation removed", inResults(sql => sql.replace("json_valid(result_json)", "length(result_json) > 0"))],
      ["history result byte cap widened", inResults(sql => sql.replace("<= 16384", "<= 16385"))],
      ["history result character bound", inResults(sql => sql.replace("length(CAST(result_json AS BLOB))", "length(result_json)"))],
      ...[
        ["reordered keys", "ON community_model_history_results(participant_id, day)"],
        ["descending key", "ON community_model_history_results(day DESC, participant_id)"],
        ["nonbinary key", "ON community_model_history_results(day COLLATE NOCASE, participant_id)"],
        ["expression key", "ON community_model_history_results(substr(day, 1), participant_id)"],
        ["extra key", "ON community_model_history_results(day, participant_id, input_revision)"],
        ["partial index", "ON community_model_history_results(day, participant_id) WHERE day > ''"],
      ].map(([label, replacement]) => [`history result index ${label}`,
        sql => sql.replace("ON community_model_history_results(day, participant_id)", replacement)]),
      ["history result unique index", sql => sql.replace("CREATE INDEX community_model_history_results_day", "CREATE UNIQUE INDEX community_model_history_results_day")],
      ["missing history provenance", sql => sql.replace("ALTER TABLE community_model_composition_days ADD COLUMN history_method_version TEXT;", "")],
      ["history provenance type changed", sql => sql.replace("ADD COLUMN history_method_version TEXT", "ADD COLUMN history_method_version INTEGER")],
      ["history provenance invented default", sql => sql.replace("ADD COLUMN history_method_version TEXT", "ADD COLUMN history_method_version TEXT DEFAULT 'fixture-history'")],
      ["history provenance nonnullable", sql => sql.replace("ADD COLUMN history_method_version TEXT", "ADD COLUMN history_method_version TEXT NOT NULL DEFAULT 'fixture-history'")],
      ["history provenance generated", sql => sql.replace("ADD COLUMN history_method_version TEXT", "ADD COLUMN history_method_version TEXT GENERATED ALWAYS AS ('fixture-history') VIRTUAL")],
      ...historyTriggers.flatMap(name => [
        [`missing ${name}`, inObject(name, () => "")],
        [`no-op ${name}`, inObject(name, sql => sql.replace(/BEGIN[\s\S]*END;/u, "BEGIN SELECT 1; END;"))],
      ]),
      ["history insert ignores active chunks", inObject("community_model_history_v1_insert", sql => sql.replace("NEW.superseded_at IS NULL", "NEW.superseded_at IS NOT NULL"))],
      ["history correction ignores retired chunks", inObject("community_model_history_v1_update", sql => sql.replace("OLD.superseded_at IS NULL OR NEW.superseded_at IS NULL", "OLD.superseded_at IS NULL AND NEW.superseded_at IS NULL"))],
      ["history delete ignores active chunks", inObject("community_model_history_v1_delete", sql => sql.replace("OLD.superseded_at IS NULL", "OLD.superseded_at IS NOT NULL"))],
      ["history invalidation horizon shortened", sql => sql.replaceAll("'+100 days'", "'+99 days'")],
      ["history correction old range lost", inObject("community_model_history_v1_update", sql => sql.replace("day BETWEEN OLD.chunk_day AND date(OLD.chunk_day, '+100 days') OR ", ""))],
      ["history correction new range lost", inObject("community_model_history_v1_update", sql => sql.replace(" OR day BETWEEN NEW.chunk_day AND date(NEW.chunk_day, '+100 days')", ""))],
      ["history insert overwrites snapshot basis", inObject("community_model_history_v1_insert", sql => sql.replace("history_method_version IS NOT NULL AND ", ""))],
      ["history legacy invalidation reversed", inObject("community_model_history_legacy_update", sql => sql.replace("history_method_version IS NOT NULL", "history_method_version IS NULL"))],
      ["history successor invalidation reversed", inObject("community_model_history_successor_update", sql => sql.replace("history_method_version IS NOT NULL", "history_method_version IS NULL"))],
      ["history participant state clears wrong owner", inObject("community_model_history_participant_state", sql => sql.replace("participant_id = NEW.id", "participant_id <> NEW.id"))],
      ["history participant deletion omits cached preview", inObject("community_model_history_participant_delete", sql => sql.replace("DELETE FROM admin_community_allowance_preview_cache;", "SELECT 1;"))],
    ], 48);
});

test("0048 rollback preserves the existing schema and checkpoints, and owner cleanup reaches only owned history", () => {
  const COMMUNITY_MODEL_HISTORY_SCHEMA_PROBE_SQL = PRE_INCREMENTAL_MODEL_HISTORY_SCHEMA_PROBE_SQL;
  const database = new DatabaseSync(":memory:");
  const rows = (sql) => database.prepare(sql).all().map(row => ({ ...row }));
  const apply = name => database.exec(readFileSync(join(workerDirectory, "migrations", name), "utf8"));
  const timestamp = "2026-09-06T23:59:59.999Z";
  const fingerprint = "a".repeat(64);
  const checkpoint = (namespace, participantId) => {
    assert.ok(["community_analysis_work", "community_model_history_work"].includes(namespace));
    database.prepare(`INSERT INTO ${namespace}
      (participant_id, run_id, input_revision, input_fingerprint, source_kind,
       source_method_version, fixed_now, observed_at_cutoff, resets_at_cutoff,
       window_minutes, max_quota_rows, phase, progress_revision, control_json,
       manifest_json, state_sha256)
      VALUES (?, 'fixture-run', 1, ?, 'v1', 'fixture-method', ?, ?, ?,
        10080, 60000, 'plan', 0, '{}', '[]', ?)`).run(
      participantId, fingerprint, timestamp, timestamp, timestamp, fingerprint,
    );
    database.prepare(`INSERT INTO ${namespace}_parts
      (participant_id, run_id, component, payload_json, payload_sha256, payload_bytes)
      VALUES (?, 'fixture-run', 'plan-anchors', '[]', ?, 2)`).run(participantId, fingerprint);
    database.prepare(`INSERT INTO ${namespace}_stage
      (participant_id, run_id, stage_id, base_progress_revision, stage_revision,
       mode, target_phase, target_control_json, target_manifest_json,
       write_manifest_json, target_state_sha256, replay_json, write_offset,
       verified_offset, gc_component, gc_sha256, discard_input_revision, state_sha256)
      VALUES (?, 'fixture-run', 'fixture-stage', 0, 0, 'writing', 'plan', '{}', '[]',
        '[]', ?, '{}', 0, 0, '', '', NULL, ?)`).run(participantId, fingerprint, fingerprint);
  };
  try {
    const names = EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB;
    for (const name of names.slice(0, 47)) apply(name);
    for (const participantId of ["fixture-owner-a", "fixture-owner-b"]) {
      database.prepare(`INSERT INTO participants (id, access_token_id, access_token_hash,
        recovery_token_id, recovery_token_hash, consent_version, consented_at, created_at)
        VALUES (?, ?, X'01', ?, X'02', 'fixture-consent', ?, ?)`).run(
        participantId, `${participantId}-access`, `${participantId}-recovery`, timestamp, timestamp,
      );
      checkpoint("community_analysis_work", participantId);
    }
    database.prepare(`INSERT INTO community_model_composition_days
      (day, payload_json, computed_at, attribution_method_version, source_mutation_epoch)
      VALUES ('2026-09-06', '{}', ?, 'fixture-attribution', 1)`).run(timestamp);
    const preservedTables = ["participants", "collection_controls", "telemetry_transport_formats",
      "telemetry_transport_participant_floors", "community_analysis_work",
      "community_analysis_work_parts", "community_analysis_work_stage"];
    const before = Object.fromEntries(preservedTables.map(table => [table, rows(`SELECT * FROM ${table}`)]));
    const schemaBefore = rows("SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
    const oldDays = rows("SELECT * FROM community_model_composition_days");
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false);

    database.exec("SAVEPOINT historical_migration;");
    apply(names[47]);
    assert.equal(database.prepare(COMMUNITY_MODEL_HISTORY_SCHEMA_PROBE_SQL).get().community_model_history_schema, 1);
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false);
    assert.throws(() => database.exec("SELECT * FROM fixture_deliberate_migration_failure;"), /no such table/u);
    database.exec("ROLLBACK TO historical_migration; RELEASE historical_migration;");
    assert.deepEqual(rows("SELECT type, name, sql FROM sqlite_master ORDER BY type, name"), schemaBefore);
    assert.deepEqual(rows("SELECT * FROM community_model_composition_days"), oldDays);
    assert.equal(attributionSchemaComplete(database.prepare(ATTRIBUTION_SCHEMA_PROBE_SQL).get()), false);
    for (const table of preservedTables) assert.deepEqual(rows(`SELECT * FROM ${table}`), before[table], table);

    apply(names[47]);
    for (const table of preservedTables) assert.deepEqual(rows(`SELECT * FROM ${table}`), before[table], table);
    assert.deepEqual(rows("SELECT * FROM community_model_composition_days"), oldDays.map(row => ({ ...row, history_method_version: null })));
    for (const table of ["community_model_history_work", "community_model_history_work_parts",
      "community_model_history_work_stage", "community_model_history_results"]) {
      assert.deepEqual(rows(`SELECT * FROM ${table}`), [], table);
    }
    const changesBeforeProbe = database.prepare("SELECT total_changes() AS n").get().n;
    assert.equal(database.prepare(COMMUNITY_MODEL_HISTORY_SCHEMA_PROBE_SQL).get().community_model_history_schema, 1);
    assert.equal(database.prepare("SELECT total_changes() AS n").get().n, changesBeforeProbe);

    for (const participantId of ["fixture-owner-a", "fixture-owner-b"]) {
      checkpoint("community_model_history_work", participantId);
      database.prepare(`INSERT INTO community_model_history_results
        (participant_id, day, input_revision, input_fingerprint, method_version, result_json, computed_at)
        VALUES (?, '2026-09-05', 1, ?, 'fixture-history', '{}', ?)`).run(participantId, fingerprint, timestamp);
    }
    database.prepare(`INSERT INTO community_model_composition_days
      (day, payload_json, computed_at, history_method_version)
      VALUES ('2026-09-05', '{}', ?, 'fixture-history')`).run(timestamp);
    for (const namespace of ["community_analysis_work", "community_model_history_work"]) {
      assert.throws(() => database.exec(`UPDATE ${namespace}_parts SET payload_json = '{}'`), /community analysis part immutable/u);
    }
    database.exec("UPDATE participants SET state = 'deleting' WHERE id = 'fixture-owner-a'");
    for (const table of ["community_model_history_work", "community_model_history_work_parts",
      "community_model_history_work_stage", "community_model_history_results"]) {
      assert.deepEqual(rows(`SELECT participant_id FROM ${table}`), [{ participant_id: "fixture-owner-b" }], table);
    }
    assert.deepEqual(rows("SELECT * FROM community_model_composition_days"), []);
    // Source withdrawal does not merge or rewrite the independent current
    // namespace; its own existing source fences continue to govern it.
    assert.deepEqual(rows("SELECT * FROM community_analysis_work"), before.community_analysis_work);

    database.prepare(`INSERT INTO community_model_composition_days
      (day, payload_json, computed_at, history_method_version)
      VALUES ('2026-09-05', '{}', ?, 'fixture-history')`).run(timestamp);
    database.prepare(`INSERT INTO admin_community_allowance_preview_cache
      (singleton, generated_at, payload_json) VALUES (1, ?, '{}')`).run(timestamp);
    database.exec("DELETE FROM participants WHERE id = 'fixture-owner-b'");
    for (const table of ["community_model_history_work", "community_model_history_work_parts",
      "community_model_history_work_stage", "community_model_history_results",
      "community_model_composition_days", "admin_community_allowance_preview_cache"]) {
      assert.deepEqual(rows(`SELECT * FROM ${table}`), [], table);
    }
    assert.deepEqual(rows("SELECT participant_id FROM community_analysis_work"), [{ participant_id: "fixture-owner-a" }]);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("0048 correction triggers invalidate the exact historical range without rewriting forward snapshots", () => {
  const COMMUNITY_MODEL_HISTORY_SCHEMA_PROBE_SQL = PRE_INCREMENTAL_MODEL_HISTORY_SCHEMA_PROBE_SQL;
  // Minimal content-free source tables isolate the new invalidation triggers;
  // this is not an ingest/activation fixture. The full migrated schema,
  // source preservation and owner erasure are rehearsed independently above.
  const database = new DatabaseSync(":memory:");
  const timestamp = "2026-09-06T23:59:59.999Z";
  const seedDays = (days) => {
    database.exec("DELETE FROM community_model_composition_days;");
    for (const day of days) database.prepare(`INSERT INTO community_model_composition_days
      (day, payload_json, computed_at, history_method_version)
      VALUES (?, '{}', ?, 'fixture-history')`).run(day, timestamp);
    database.prepare(`INSERT INTO community_model_composition_days
      (day, payload_json, computed_at) VALUES ('2026-09-02', '{}', ?)`).run(timestamp);
  };
  const dayRows = () => database.prepare(`SELECT day, history_method_version
    FROM community_model_composition_days ORDER BY day`).all().map(row => ({ ...row }));
  const retained = (days) => [...days.map(day => ({ day, history_method_version: "fixture-history" })),
    { day: "2026-09-02", history_method_version: null }].sort((a, b) => a.day.localeCompare(b.day, "en"));
  try {
    database.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE participants (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE telemetry_v1_chunks (id TEXT PRIMARY KEY, chunk_day TEXT NOT NULL, superseded_at TEXT);
      CREATE TABLE telemetry_contributions (id TEXT PRIMARY KEY);
      CREATE TABLE telemetry_v11_domain_heads (id TEXT PRIMARY KEY);
      CREATE TABLE admin_community_allowance_preview_cache (singleton INTEGER PRIMARY KEY);
      INSERT INTO participants VALUES ('fixture-owner', 'active');`);
    database.exec(readFileSync(join(workerDirectory, "migrations", "0042_community_model_composition.sql"), "utf8"));
    database.exec(`ALTER TABLE community_model_composition_days ADD COLUMN attribution_method_version TEXT;
      ALTER TABLE community_model_composition_days ADD COLUMN source_mutation_epoch INTEGER;`);
    database.exec(readFileSync(join(workerDirectory, "migrations", "0048_community_model_history.sql"), "utf8"));
    assert.equal(database.prepare(COMMUNITY_MODEL_HISTORY_SCHEMA_PROBE_SQL).get().community_model_history_schema, 1);

    const allDays = ["2026-08-31", "2026-09-01", "2026-09-03", "2026-12-10", "2026-12-11", "2026-12-12", "2026-12-13"];
    seedDays(allDays);
    const before = dayRows();
    database.exec("SAVEPOINT historical_correction;");
    database.exec("INSERT INTO telemetry_v1_chunks VALUES ('fixture-live', '2026-09-01', NULL);");
    assert.deepEqual(dayRows(), retained(["2026-08-31", "2026-12-11", "2026-12-12", "2026-12-13"]));
    database.exec("ROLLBACK TO historical_correction; RELEASE historical_correction;");
    assert.deepEqual(dayRows(), before);
    assert.equal(database.prepare("SELECT count(*) AS n FROM telemetry_v1_chunks").get().n, 0);

    database.exec("INSERT INTO telemetry_v1_chunks VALUES ('fixture-live', '2026-09-01', NULL);");
    seedDays(allDays);
    database.exec("UPDATE telemetry_v1_chunks SET chunk_day = '2026-09-03' WHERE id = 'fixture-live';");
    assert.deepEqual(dayRows(), retained(["2026-08-31", "2026-12-13"]));
    seedDays(allDays);
    database.exec("DELETE FROM telemetry_v1_chunks WHERE id = 'fixture-live';");
    assert.deepEqual(dayRows(), retained(["2026-08-31", "2026-09-01", "2026-12-13"]));

    // A newly superseded live row still invalidates its old input range;
    // already-superseded-only mutations do not erase unaffected history.
    database.exec("INSERT INTO telemetry_v1_chunks VALUES ('fixture-retired', '2026-09-01', NULL);");
    seedDays(allDays);
    database.exec("UPDATE telemetry_v1_chunks SET superseded_at = '2026-09-06T00:00:00.000Z' WHERE id = 'fixture-retired';");
    assert.deepEqual(dayRows(), retained(["2026-08-31", "2026-12-11", "2026-12-12", "2026-12-13"]));
    seedDays(allDays);
    database.exec(`INSERT INTO telemetry_v1_chunks VALUES ('fixture-old', '2026-09-01', '2026-09-06T00:00:00.000Z');
      UPDATE telemetry_v1_chunks SET chunk_day = '2026-09-03' WHERE id = 'fixture-retired';
      DELETE FROM telemetry_v1_chunks WHERE superseded_at IS NOT NULL;`);
    assert.deepEqual(dayRows(), retained(allDays));

    for (const table of ["telemetry_contributions", "telemetry_v11_domain_heads"]) {
      for (const statement of [
        `INSERT INTO ${table} VALUES ('fixture-source');`,
        `UPDATE ${table} SET id = 'fixture-updated' WHERE id = 'fixture-source';`,
        `DELETE FROM ${table} WHERE id = 'fixture-updated';`,
      ]) {
        seedDays(allDays);
        database.exec(statement);
        assert.deepEqual(dayRows(), retained([]), `${table}: ${statement.split(" ", 1)[0]}`);
      }
    }
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
});

test("projection metadata readiness accepts the intentionally incomplete populated-source backfill", () => {
  const database = new DatabaseSync(":memory:");
  try {
    // Minimal synthetic canonical source: the production-shaped full migration
    // chain is exercised separately; this isolates deployment/runtime gates.
    database.exec(`CREATE TABLE telemetry_v1_records (
      id INTEGER PRIMARY KEY, participant_id TEXT, stream TEXT, limit_id TEXT,
      window_duration_minutes INTEGER, provider TEXT, plan_type TEXT,
      plan_variant TEXT, resets_at TEXT, slot TEXT, used_percent REAL, observed_at TEXT);
      INSERT INTO telemetry_v1_records VALUES
        (1, 'synthetic-participant', 'quota', 'codex', 10080, 'openai_codex', 'pro',
         'default', '2026-08-08T00:00:00.000Z', 'primary', 10, '2026-08-01T00:00:00.000Z');`);
    database.exec(readFileSync(join(workerDirectory, "migrations", "0046_v1_quota_fit_projection.sql"), "utf8"));
    const state = () => ({ ...database.prepare("SELECT * FROM telemetry_v1_quota_fit_backfill").get() });
    const before = state();
    assert.deepEqual(before, { singleton_id: 1, through_record_id: 1, last_record_id: 0, is_complete: 0 });
    assert.equal(database.prepare(V1_QUOTA_FIT_PROJECTION_SCHEMA_PROBE_SQL).get().v1_quota_fit_projection_schema, 1);
    assert.deepEqual(state(), before);
    assert.equal(database.prepare("SELECT count(*) AS n FROM telemetry_v1_quota_fit_rows").get().n, 0);
    assert.equal(database.prepare("SELECT count(*) AS n FROM telemetry_v1_records").get().n, 1);
    // Missing or extra runtime rows are not a schema assertion either. This
    // metadata-only proof does not silently claim reader readiness.
    assert.doesNotMatch(V1_QUOTA_FIT_PROJECTION_SCHEMA_PROBE_SQL, /FROM telemetry_v1_quota_fit_backfill\b/u);
  } finally {
    database.close();
  }
});

test("current migration labels do not hide missing attribution metadata in staging readiness", () => {
  const config = provisionedConfig();
  const result = probeStagingLive({
    config, wrangler: "/fake/wrangler", workerDirectory,
    spawn: successSpawn(config, [], { missingAttributionSchema: true }),
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.checks.remoteMigrationInventoryCurrent, true);
  assert.equal(result.checks.attributionSchemaCurrent, false);
  assert.equal(result.blockers.includes("REMOTE_ATTRIBUTION_SCHEMA_INCOMPLETE"), true);
  assert.equal(result.collectionAuthorized, false);
});

test("staging requires pending attribution migrations before its schema probe", () => {
  const config = provisionedConfig();
  const calls = [];
  const baseSpawn = successSpawn(config, calls);
  const result = probeStagingLive({
    config, wrangler: "/fake/wrangler", workerDirectory,
    spawn: (command, args, options) => {
      if (args[2] === "USAGE_MONITOR_DB" && args.some((arg) => arg.includes("FROM d1_migrations"))) {
        calls.push(args);
        return { status: 0, stdout: JSON.stringify([{ results:
          EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(0, 42).map((name) => ({ name })),
        }]), stderr: "" };
      }
      return baseSpawn(command, args, options);
    },
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.checks.migrationsCurrent, false);
  assert.equal(result.checks.attributionSchemaCurrent, false);
  assert.equal(calls.some((args) => args.includes(ATTRIBUTION_SCHEMA_PROBE_SQL)), false);
  assert.equal(calls.some((args) => args.includes("apply")), false);
});

test("staging blocks incomplete 0045–0052 prefixes and unreviewed 0046–0053 before schema probing", () => {
  const config = provisionedConfig();
  const through45 = EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(0, 45);
  assert.equal(through45.at(-1), "0045_attribution_domain_activation.sql");
  for (const [names, expectedBlocker] of [
    [through45, "REMOTE_MIGRATIONS_PENDING"],
    [[...through45, "0046_v1_quota_fit_projection.sql"], "REMOTE_MIGRATIONS_PENDING"],
    [EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(0, 47), "REMOTE_MIGRATIONS_PENDING"],
    [EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(0, 48), "REMOTE_MIGRATIONS_PENDING"],
    ...[49, 50, 51, 52].map(count => [EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(0, count), "REMOTE_MIGRATIONS_PENDING"]),
    [[...through45, "0046_unreviewed_quota_index.sql"], "REMOTE_MIGRATION_INVENTORY_DRIFT"],
    [[...through45, "0046_v1_quota_fit_cursor.sql"], "REMOTE_MIGRATION_INVENTORY_DRIFT"],
    [[...through45, "0046_v1_quota_fit_projection.sql", "0047_unreviewed_work.sql"], "REMOTE_MIGRATION_INVENTORY_DRIFT"],
    [[...EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(0, 47), "0048_unreviewed_model_history.sql"], "REMOTE_MIGRATION_INVENTORY_DRIFT"],
    [[...EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(0, 48), "0049_unreviewed_graph_preservation.sql"], "REMOTE_MIGRATION_INVENTORY_DRIFT"],
    ...[50, 51, 52, 53].map(number => [[...EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(0, number - 1),
      `${String(number).padStart(4, "0")}_unreviewed.sql`], "REMOTE_MIGRATION_INVENTORY_DRIFT"]),
  ]) {
    const calls = [];
    const baseSpawn = successSpawn(config, calls);
    const result = probeStagingLive({
      config, wrangler: "/fake/wrangler", workerDirectory,
      spawn: (command, args, options) => {
        if (args[2] === "USAGE_MONITOR_DB" && args.some((arg) => arg.includes("FROM d1_migrations"))) {
          calls.push(args);
          return { status: 0, stdout: JSON.stringify([{ results: names.map((name) => ({ name })) }]), stderr: "" };
        }
        return baseSpawn(command, args, options);
      },
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.blockers.includes(expectedBlocker), true, expectedBlocker);
    assert.equal(result.checks.remoteMigrationInventoryCurrent, false);
    assert.equal(result.checks.attributionSchemaCurrent, false);
    assert.equal(result.collectionAuthorized, false);
    assert.equal(calls.some((args) => args.includes("apply")), false);
    assert.equal(calls.some((args) => args.includes(ATTRIBUTION_SCHEMA_PROBE_SQL)), false);
  }
});

test("staging treats the historical prefix as pending but rejects an alternate applied 0041", () => {
  const config = provisionedConfig();
  const historical = EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(0, 41);
  for (const [names, expectedBlocker] of [
    [historical, "REMOTE_MIGRATIONS_PENDING"],
    [[...historical.slice(0, 40), "0041_community_model_composition.sql"], "REMOTE_MIGRATION_INVENTORY_DRIFT"],
    [[...historical, "0041_community_model_composition.sql"], "REMOTE_MIGRATION_INVENTORY_DRIFT"],
  ]) {
    const calls = [];
    const baseSpawn = successSpawn(config, calls);
    const result = probeStagingLive({
      config, wrangler: "/fake/wrangler", workerDirectory,
      spawn: (command, args, options) => {
        if (args[2] === "USAGE_MONITOR_DB" && args.some((arg) => arg.includes("FROM d1_migrations"))) {
          calls.push(args);
          return { status: 0, stdout: JSON.stringify([{ results: names.map((name) => ({ name })) }]), stderr: "" };
        }
        return baseSpawn(command, args, options);
      },
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.blockers.includes(expectedBlocker), true, expectedBlocker);
    assert.equal(result.checks.remoteMigrationInventoryCurrent, false);
    assert.equal(result.collectionAuthorized, false);
    assert.equal(calls.some((args) => args.includes("apply")), false);
    assert.equal(calls.some((args) => args.includes(ATTRIBUTION_SCHEMA_PROBE_SQL)), false);
  }
});

test("staging readiness rejects production resources and custom-domain targets", () => {
  const productionResource = structuredClone(checkedInConfig);
  productionResource.env.staging.d1_databases[0].database_name =
    productionResource.env.production.d1_databases[0].database_name;
  const productionResult = assessStagingConfiguration(productionResource);
  assert.equal(productionResult.state, "unsafe_configuration");
  assert.equal(productionResult.checks.d1BindingsSafe, false);
  assert.equal(productionResult.blockers.includes(
    "CONFIG_D1_BINDINGS_SAFE",
  ), true);

  const customDomain = structuredClone(checkedInConfig);
  customDomain.env.staging.routes = [
    { pattern: "tibotattle.com", custom_domain: true },
  ];
  const customDomainResult = assessStagingConfiguration(customDomain);
  assert.equal(customDomainResult.state, "unsafe_configuration");
  assert.equal(customDomainResult.checks.originBoundaryClosed, false);
  assert.equal(customDomainResult.blockers.includes(
    "CONFIG_ORIGIN_BOUNDARY_CLOSED",
  ), true);
});

test("deployable Worker asset environments fail closed around generated public trees", () => {
  for (const environment of [
    checkedInConfig,
    checkedInConfig.env.staging,
  ]) {
    assert.equal(environment.assets.directory, GENERATED_WORKER_ASSET_DIRECTORY);
    assert.equal(environment.assets.not_found_handling, "single-page-application");
  }
  assert.equal(
    checkedInConfig.env.production.assets.directory,
    PRODUCTION_PUBLIC_ASSET_DIRECTORY,
  );
  assert.equal(
    checkedInConfig.env.production.assets.not_found_handling,
    "404-page",
  );
  assert.equal(
    checkedInConfig.env.production.assets.run_worker_first,
    true,
  );
  assert.equal(
    assessStagingConfiguration(checkedInConfig).checks.deployableAssetsClosed,
    true,
  );
});

test("staging readiness rejects dashboard source and local control asset routes", () => {
  for (const directory of [
    "../web/public",
    "../../.release-build/public-release-site",
  ]) {
    const config = structuredClone(checkedInConfig);
    config.env.staging.assets.directory = directory;
    const result = assessStagingConfiguration(config);
    assert.equal(result.checks.assetsClosed, false, directory);
    assert.equal(result.checks.deployableAssetsClosed, false, directory);
  }
  for (const route of [
    "/admin/*",
    "/sign-in/*",
    "/contribution/*",
    "/app-open/*",
  ]) {
    const config = structuredClone(checkedInConfig);
    config.env.staging.assets.run_worker_first = ["/api/*", route];
    const result = assessStagingConfiguration(config);
    assert.equal(result.checks.assetsClosed, false, route);
    assert.equal(result.checks.deployableAssetsClosed, false, route);
  }
});

test("production asset routing fails closed without full Worker-first canonicalization", () => {
  for (const runWorkerFirst of [
    false,
    ["/api/*", "/admin", "/admin/*"],
  ]) {
    const config = structuredClone(checkedInConfig);
    config.env.production.assets.run_worker_first = runWorkerFirst;
    const result = assessStagingConfiguration(config);
    assert.equal(result.checks.deployableAssetsClosed, false);
  }
});

test("unsafe staging admission configuration fails closed", () => {
  const config = structuredClone(checkedInConfig);
  config.env.staging.vars.ENROLLMENT_MODE = "local_open";
  const result = assessStagingConfiguration(config);
  assert.equal(result.state, "unsafe_configuration");
  assert.equal(result.checks.enrollmentDisabled, false);
  assert.equal(result.blockers.includes("CONFIG_ENROLLMENT_DISABLED"), true);
});

test("staging readiness rejects a missing ingress budget binding or migration", () => {
  const withoutBinding = structuredClone(checkedInConfig);
  withoutBinding.env.staging.durable_objects.bindings = [];
  const bindingResult = assessStagingConfiguration(withoutBinding);
  assert.equal(bindingResult.state, "unsafe_configuration");
  assert.equal(bindingResult.blockers.includes(
    "CONFIG_INGRESS_BUDGET_BINDING_SAFE",
  ), true);

  const withoutMigration = structuredClone(checkedInConfig);
  withoutMigration.migrations = [];
  const migrationResult = assessStagingConfiguration(withoutMigration);
  assert.equal(migrationResult.state, "unsafe_configuration");
  assert.equal(migrationResult.blockers.includes(
    "CONFIG_INGRESS_BUDGET_MIGRATION_SAFE",
  ), true);
});

test("live readiness proves resources, secrets, migrations, and containment", () => {
  const config = provisionedConfig();
  const calls = [];
  const result = probeStagingLive({
    config,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: successSpawn(config, calls),
  });
  assert.equal(result.state, "ready_for_disabled_deploy");
  assert.equal(result.collectionAuthorized, false);
  assert.equal(result.evidenceType, STAGING_PROOF_TYPES.LIVE_REMOTE);
  assert.equal(result.liveProof, true);
  assert.equal(result.checks.remoteMigrationInventoryCurrent, true);
  assert.equal(result.checks.attributionSchemaCurrent, true);
  assert.equal(Object.values(result.checks).every(Boolean), true);
  assert.equal(result.checks.primaryReenrollmentSchemaCurrent, true);
  assert.equal(result.checks.deletionLedgerSchemaCurrent, true);
  assert.equal(result.checks.identityProtectionSchemaCurrent, true);
  assert.equal(result.evidence.identityProtectionSchema.status, "verified");
  assert.equal(result.evidence.identityProtectionSchema.verified, true);
  assert.equal(
    result.evidence.identityProtectionSchema.primary.columns.participantCooldownDigest,
    true,
  );
  assert.equal(
    result.evidence.identityProtectionSchema.deletionLedger.columns.participantDigest,
    true,
  );
  assert.deepEqual(result.blockers, []);
  assert.equal(calls.filter((args) => args[0] === "d1").length, 8);
  assert.equal(calls.filter((args) => args.includes(ATTRIBUTION_SCHEMA_PROBE_SQL)).length, 1);
  assert.equal(calls.some((args) => args.includes("migrations")), false);
  assert.equal(
    calls.filter((args) => args.some((value) =>
      typeof value === "string" && value.includes("FROM d1_migrations"))).length,
    2,
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(config.env.staging.d1_databases[0].database_id), false);
  assert.equal(serialized.includes(config.env.staging.r2_buckets[0].bucket_name), false);
});

test("live readiness rejects an unreviewed remote migration inventory", () => {
  const config = provisionedConfig();
  const calls = [];
  const baseSpawn = successSpawn(config, calls);
  const spawn = (command, args, options) => {
    if (args[2] === "USAGE_MONITOR_DB" && args.some((value) =>
      typeof value === "string" && value.includes("FROM d1_migrations"))) {
      calls.push(args);
      return {
        status: 0,
        stdout: JSON.stringify([{
          results: [
            ...EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.map((name) => ({ name })),
            { name: "0029_unreviewed.sql" },
          ],
        }]),
        stderr: "private remote output",
      };
    }
    return baseSpawn(command, args, options);
  };
  const result = probeStagingLive({
    config,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.checks.remoteMigrationInventoryCurrent, false);
  assert.equal(result.blockers.includes(
    "REMOTE_MIGRATION_INVENTORY_DRIFT",
  ), true);
  assert.equal(JSON.stringify(result).includes("0029_unreviewed.sql"), false);
  assert.equal(JSON.stringify(result).includes("private remote output"), false);
});

test("unsafe target configuration stops before any live command", () => {
  const config = structuredClone(checkedInConfig);
  config.env.staging.vars.PUBLIC_ORIGIN = "https://tibotattle.com";
  let called = false;
  const result = probeStagingLive({
    config,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: () => {
      called = true;
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.state, "unsafe_configuration");
  assert.equal(result.liveProof, false);
  assert.equal(called, false);
});

test("operation receipts keep evidence fixed and non-secret", () => {
  const receipt = stagingOperationReceipt("disabled_staging_prepared", {
    resourcesVerified: true,
    lifecycleReadiness: "unexpected",
    secret: "do-not-record",
    commandOutput: "private command output",
  });
  assert.deepEqual(receipt.evidence, { resourcesVerified: true });
  assert.equal(JSON.stringify(receipt).includes("do-not-record"), false);
  assert.equal(JSON.stringify(receipt).includes("private command output"), false);
});

test("live readiness blocks missing or altered identity protection schema", () => {
  for (const scenario of [
    {
      name: "primary re-enrollment protection",
      options: { missingPrimarySchema: true },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
    },
    {
      name: "deletion-ledger cooldown protection",
      options: { missingDeletionLedgerSchema: true },
      check: "deletionLedgerSchemaCurrent",
      blocker: "REMOTE_DELETION_LEDGER_SCHEMA_INCOMPLETE",
      side: "deletionLedger",
    },
    {
      name: "primary identity-link secret configuration table",
      options: { missingIdentityLinkSecretConfiguration: true },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "tables",
      evidenceKey: "identityLinkSecretConfiguration",
    },
    {
      name: "primary identity-link secret configuration column",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_key_version",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "columns",
      evidenceKey: "identityLinkSecretConfigurationKeyVersion",
    },
    {
      name: "primary identity-link secret configuration extra column",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_columns_exact",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationColumnsExact",
    },
    {
      name: "primary identity-link secret configuration singleton check",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_singleton_check",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationSingletonCheck",
    },
    {
      name: "primary identity-link secret configuration key-version check",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_key_version_check",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationKeyVersionCheck",
    },
    {
      name: "primary identity-link secret configuration fingerprint check",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_fingerprint_check",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationFingerprintCheck",
    },
    {
      name: "primary identity-link secret configuration check count",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_check_count",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationCheckCount",
    },
    {
      name: "primary identity-link secret configuration strict flag",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_strict",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationStrict",
    },
    {
      name: "primary identity-link secret configuration extra object",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_no_extra_objects",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationNoExtraObjects",
    },
  ]) {
    const config = provisionedConfig();
    const result = probeStagingLive({
      config,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: successSpawn(config, [], scenario.options),
    });
    assert.equal(result.state, "blocked", scenario.name);
    assert.equal(result.checks[scenario.check], false, scenario.name);
    assert.equal(result.checks.identityProtectionSchemaCurrent, false);
    assert.equal(
      result.evidence.identityProtectionSchema.status,
      "incomplete",
      scenario.name,
    );
    assert.equal(
      result.evidence.identityProtectionSchema[scenario.side].status,
      "incomplete",
      scenario.name,
    );
    if (scenario.evidenceGroup) {
      assert.equal(
        result.evidence.identityProtectionSchema[scenario.side]
          [scenario.evidenceGroup][scenario.evidenceKey],
        false,
        scenario.name,
      );
    }
    assert.equal(result.blockers.includes(scenario.blocker), true, scenario.name);
  }
});

test("semantic identity-link proof matches the checked-in migrated table", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(readFileSync(join(
      workerDirectory,
      "migrations",
      "0028_identity_link_secret_configuration.sql",
    ), "utf8"));
    const config = provisionedConfig();
    const calls = [];
    const baseSpawn = successSpawn(config, calls);
    let identityProbeRow;
    const spawn = (command, args, options) => {
      const commandIndex = args.indexOf("--command");
      const commandText = commandIndex >= 0
        ? String(args[commandIndex + 1])
        : "";
      if (args[0] === "d1"
          && args[1] === "execute"
          && args[2] === "USAGE_MONITOR_DB"
          && commandText.includes(
            "primary_identity_link_secret_configuration_check_count",
          )) {
        identityProbeRow = database.prepare(commandText).get();
        return {
          status: 0,
          stdout: JSON.stringify([{ results: [identityProbeRow] }]),
          stderr: "",
        };
      }
      return baseSpawn(command, args, options);
    };
    probeStagingLive({
      config,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn,
    });
    assert.deepEqual(
      Object.fromEntries([
        "primary_identity_link_secret_configuration_columns_exact",
        "primary_identity_link_secret_configuration_singleton_check",
        "primary_identity_link_secret_configuration_key_version_check",
        "primary_identity_link_secret_configuration_fingerprint_check",
        "primary_identity_link_secret_configuration_check_count",
        "primary_identity_link_secret_configuration_strict",
        "primary_identity_link_secret_configuration_no_extra_objects",
      ].map((key) => [key, identityProbeRow?.[key]])),
      {
        primary_identity_link_secret_configuration_columns_exact: 1,
        primary_identity_link_secret_configuration_singleton_check: 1,
        primary_identity_link_secret_configuration_key_version_check: 1,
        primary_identity_link_secret_configuration_fingerprint_check: 1,
        primary_identity_link_secret_configuration_check_count: 1,
        primary_identity_link_secret_configuration_strict: 1,
        primary_identity_link_secret_configuration_no_extra_objects: 1,
      },
    );
  } finally {
    database.close();
  }
});

test("live readiness marks an unavailable schema probe unknown without leaking output", () => {
  const config = provisionedConfig();
  const result = probeStagingLive({
    config,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: successSpawn(config, [], { primarySchemaError: true }),
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.checks.primaryReenrollmentSchemaCurrent, false);
  assert.equal(result.evidence.identityProtectionSchema.status, "unknown");
  assert.equal(result.evidence.identityProtectionSchema.primary.status, "unknown");
  assert.equal(
    result.blockers.includes("REMOTE_IDENTITY_REENROLLMENT_SCHEMA_UNKNOWN"),
    true,
  );
  assert.equal(JSON.stringify(result).includes("provider-secret"), false);
});

test("live readiness reports R2 account enablement without leaking command output", () => {
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args);
    if (args.join(" ") === "whoami") {
      return { status: 0, stdout: "private account details", stderr: "" };
    }
    if (args.join(" ") === "d1 list --json") {
      return { status: 0, stdout: "[]", stderr: "" };
    }
    if (args.join(" ") === "r2 bucket list") {
      return {
        status: 1,
        stdout: "",
        stderr: "Please enable R2 through the Dashboard. [code: 10042]",
      };
    }
    throw new Error("Unexpected fake Wrangler call");
  };
  const result = probeStagingLive({
    config: checkedInConfig,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.blockers.includes("R2_NOT_ENABLED"), true);
  assert.equal(JSON.stringify(result).includes("private account details"), false);
  assert.equal(JSON.stringify(result).includes("Dashboard"), false);
});
