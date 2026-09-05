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
  attributionSchemaComplete,
  EXPECTED_STAGING_MIGRATIONS,
  GENERATED_WORKER_ASSET_DIRECTORY,
  PRODUCTION_PUBLIC_ASSET_DIRECTORY,
  probeStagingLive,
  STAGING_PROOF_TYPES,
  stagingOperationReceipt,
  validateStagingMigrationInventory,
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
    result.migrationInventory.USAGE_MONITOR_DB.slice(-6),
    EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(-6),
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
  assert.deepEqual(EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(-3), [
    "0043_analytical_input_fencing.sql",
    "0044_attribution_transport_staging.sql",
    "0045_attribution_domain_activation.sql",
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
  assert.equal(names.length, 45);
  assert.deepEqual(names.slice(-5), Object.keys(expectedDigests));
  assert.deepEqual(names.map((name) => name.slice(0, 4)),
    Array.from({ length: 45 }, (_, index) => String(index + 1).padStart(4, "0")));
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
    assert.deepEqual(rows("SELECT day, payload_json, attribution_method_version, source_mutation_epoch FROM community_model_composition_days"), [{
      day: "2026-08-29", payload_json: "{}", attribution_method_version: null, source_mutation_epoch: null,
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
          EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(0, -3).map((name) => ({ name })),
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
