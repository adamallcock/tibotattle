import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import pg from "pg";
import {
  POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX,
  POSTGRES_TYPED_LEGACY_STAGING_FAMILY_EVIDENCE_TABLE,
  POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX,
  POSTGRES_TYPED_LEGACY_TRANSFER_TABLES,
  PostgresTypedLegacyTransferError,
  createD1TypedLegacyPageSource,
  createSealedSqliteTypedLegacyRehearsalSource,
  createSyntheticD1TypedLegacyFixtureSource,
  runPostgresTypedLegacyTransfer,
  typedLegacyStagingFamilyEvidenceSha256,
} from "./postgres-typed-legacy-transfer.mjs";
import { applyPostgresMigrations } from "./postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";

function quoted(value) {
  assert.match(value, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${value}"`;
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  const link = await lstat(PG_TEST_SOCKET);
  const resolved = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

function d1WorkerBindingValue(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Array.from(value);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (Array.isArray(value)) return value.map(d1WorkerBindingValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, d1WorkerBindingValue(item)]));
  }
  return value;
}

function syntheticD1Source({ mutableRows = null, d1BlobArrays = false } = {}) {
  const value = syntheticRows();
  const rows = mutableRows ?? value.rows;
  return createSyntheticD1TypedLegacyFixtureSource({
    rows: d1BlobArrays ? d1WorkerBindingValue(rows) : rows,
    snapshotId: "synthetic-d1-typed-legacy-v1",
  });
}

function syntheticRows() {
  const linkedParticipant = "synthetic-transfer-linked-owner";
  const linklessParticipant = "synthetic-transfer-linkless-owner";
  const ownerDigest = "a".repeat(64);
  const day = 20_720;
  const timestamp = Date.UTC(2026, 8, 24, 12);
  const byte = (value, size = 24) => Buffer.alloc(size, value);
  const dictionary = [
    "openai_codex", "model-x", "standard", "default-tier", "cli", "codex-billing",
    "medium", "core", "success", "plus", "standard-variant", "five-hour",
    "primary", "shell",
  ].map((text, index) => ({ id: index + 1, value: text }));
  const memberships = [
    {
      namespace_id: 100, source_format: 10, owner_id: 200,
      participant_id: linkedParticipant, source_namespace: "synthetic-v1-source",
      authority: { participantState: "active", ownerLink: { ownerDigest, state: "active" } },
    },
    {
      namespace_id: 100, source_format: 11, owner_id: 200,
      participant_id: linkedParticipant, source_namespace: "synthetic-v11-shared-source",
      authority: { participantState: "active", ownerLink: { ownerDigest, state: "active" } },
    },
    {
      namespace_id: 100, source_format: 11, owner_id: 201,
      participant_id: linklessParticipant, source_namespace: "synthetic-v11-source",
      authority: { participantState: "active", ownerLink: null },
    },
  ];
  const records = [];
  const chunks = [];
  const usage = [];
  const quota = [];
  const sessionTools = [];
  const addChunk = ({ id, format, stream, manifestId }) => {
    chunks.push({
      id, namespace_id: 100, format, owner_id: 200,
      device_id: format === 10 ? 300 : 301,
      manifest_id: manifestId,
      original_id: byte(id), stream, chunk_day: day,
    });
    return id;
  };
  const addRecord = ({ id, sourceRowId, format, stream, chunkId, manifestId = null }) => {
    records.push({
      id, namespace_id: 100, format, source_row_id: sourceRowId,
      owner_id: 200, device_id: format === 10 ? 300 : 301,
      chunk_id: chunkId, manifest_id: manifestId, stream,
      occurrence_id: Buffer.from(`synthetic-occurrence-${id}`),
      observed_at_ms: timestamp, observed_day: day, provider_id: 1,
      canonical_digest: byte(id % 255, 32),
    });
  };

  for (const id of [101, 102, 103]) addChunk({ id, format: 10, stream: id - 100, manifestId: null });
  addChunk({ id: 111, format: 11, stream: 2, manifestId: 401 });
  addChunk({ id: 112, format: 11, stream: 3, manifestId: 401 });
  for (let id = 1001; id <= 1004; id += 1) addRecord({ id, sourceRowId: id, format: 10, stream: 1, chunkId: 101 });
  addRecord({ id: 1101, sourceRowId: 1101, format: 10, stream: 2, chunkId: 102 });
  addRecord({ id: 1201, sourceRowId: 1201, format: 10, stream: 3, chunkId: 103 });
  addRecord({ id: 2001, sourceRowId: 2001, format: 11, stream: 2, chunkId: 111, manifestId: 401 });
  addRecord({ id: 2002, sourceRowId: 2002, format: 11, stream: 3, chunkId: 112, manifestId: 401 });
  for (let id = 1001; id <= 1004; id += 1) {
    usage.push({
      record_id: id, stream: 1, session_id: 600, model_id: 2, speed_mode_id: 3,
      api_service_tier_id: 4, surface_id: 5, billing_surface_id: 6,
      reasoning_effort_id: 7, agent_scope_id: 8, outcome_id: 9,
      attribution_id: null, total_input_context_tokens: 1000,
      input_uncached_tokens: 100, input_cache_read_tokens: 900,
      input_cache_write_tokens: 0, output_text_tokens: 50,
      output_reasoning_tokens: 25, output_combined_tokens: 75,
    });
  }
  for (const recordId of [1101, 2001]) {
    quota.push({
      record_id: recordId, stream: 2,
      dimensions_id: recordId === 1101 ? 602 : 603,
      limit_id: 12, slot_id: 13, used_percent: 75,
      window_duration_minutes: 300, resets_at_ms: timestamp + 86_400_000,
    });
  }
  for (const recordId of [1201, 2002]) {
    sessionTools.push({ record_id: recordId, stream: 3, tool_class_id: 14, count: 2 });
  }

  const rows = {
    typed_telemetry_dictionary: dictionary,
    typed_telemetry_namespaces: [{ id: 100, original_id: byte(1) }],
    typed_telemetry_owners: [
      { id: 200, namespace_id: 100, original_id: byte(2) },
      { id: 201, namespace_id: 100, original_id: byte(8) },
    ],
    typed_telemetry_owner_memberships: memberships,
    typed_telemetry_devices: [
      { id: 300, namespace_id: 100, owner_id: 200, original_id: byte(3) },
      { id: 301, namespace_id: 100, owner_id: 200, original_id: byte(4) },
    ],
    typed_telemetry_manifests: [{
      id: 401, namespace_id: 100, owner_id: 200, device_id: 301,
      original_id: byte(5), chunk_day: day,
    }],
    typed_telemetry_identifiers: [
      { id: 600, namespace_id: 100, owner_id: 200, value: byte(6) },
      { id: 601, namespace_id: 100, owner_id: 200, value: byte(7) },
    ],
    typed_telemetry_attributions: [{
      id: 611, namespace_id: 100, owner_id: 200,
      account_basis: 0, account_track: Buffer.alloc(0), plan_basis: 0,
      plan_type_id: 10, plan_era: Buffer.alloc(0),
    }],
    typed_telemetry_quota_dimensions: [
      { id: 602, namespace_id: 100, owner_id: 200, plan_type_id: 10, plan_variant_id: 11, attribution_id: null },
      { id: 603, namespace_id: 100, owner_id: 200, plan_type_id: 10, plan_variant_id: 11, attribution_id: 611 },
    ],
    typed_telemetry_chunks: chunks,
    typed_telemetry_records: records,
    typed_telemetry_usage: usage,
    typed_telemetry_quota: quota,
    typed_telemetry_session_tools: sessionTools,
  };
  return { rows, linkedParticipant, linklessParticipant, ownerDigest };
}

async function sealedSqliteFixture({ duplicateV11AdmissionState = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-sealed-legacy-"));
  const path = join(await realpath(directory), "source.sqlite");
  const fixture = syntheticRows();
  // D1's v1.1 admission singleton supplies one namespace for both owners.
  fixture.rows.typed_telemetry_owner_memberships[2].source_namespace =
    "synthetic-v11-shared-source";
  const db = new DatabaseSync(path);
  try {
    for (const table of POSTGRES_TYPED_LEGACY_TRANSFER_TABLES) {
      if (table === "typed_telemetry_owner_memberships") continue;
      const rows = fixture.rows[table];
      assert.ok(rows.length > 0, table);
      const columns = Object.keys(rows[0]);
      db.exec(`CREATE TABLE ${quoted(table)} (${columns.map(name => {
        const sample = rows.find(row => row[name] !== null)?.[name];
        const type = Buffer.isBuffer(sample) ? "BLOB"
          : typeof sample === "number" ? "INTEGER" : "TEXT";
        return `${quoted(name)} ${type}`;
      }).join(",")})`);
      const insert = db.prepare(`INSERT INTO ${quoted(table)} (${columns.map(quoted).join(",")})
        VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of rows) insert.run(...columns.map(column => row[column]));
    }
    db.exec(`CREATE TABLE typed_v1_owner_memberships(typed_owner_id INTEGER, participant_id TEXT);
      CREATE TABLE typed_v11_owner_memberships(typed_owner_id INTEGER, participant_id TEXT);
      CREATE TABLE typed_v1_admission_state(id INTEGER, namespace_id INTEGER, source_namespace TEXT);
      CREATE TABLE typed_v11_admission_state(id INTEGER, namespace_id INTEGER, source_namespace TEXT);
      CREATE TABLE participants(id TEXT, state TEXT);
      CREATE TABLE storage_v11_owner_links(participant_id TEXT, owner_digest TEXT, state TEXT);`);
    db.prepare("INSERT INTO typed_v1_admission_state VALUES (1,100,?)")
      .run("synthetic-v1-source");
    db.prepare("INSERT INTO typed_v11_admission_state VALUES (1,100,?)")
      .run("synthetic-v11-shared-source");
    if (duplicateV11AdmissionState) {
      // The sealed source contract requires the D1 singleton key to be unique.
      // A duplicate id=1 must not silently multiply joined membership rows.
      db.prepare("INSERT INTO typed_v11_admission_state VALUES (1,100,?)")
        .run("synthetic-v11-ambiguous-source");
    }
    const participant = db.prepare("INSERT INTO participants VALUES (?,'active')");
    participant.run(fixture.linkedParticipant);
    participant.run(fixture.linklessParticipant);
    db.prepare("INSERT INTO storage_v11_owner_links VALUES (?,?,'active')")
      .run(fixture.linkedParticipant, fixture.ownerDigest);
    for (const row of fixture.rows.typed_telemetry_owner_memberships) {
      db.prepare(`INSERT INTO ${row.source_format === 10
        ? "typed_v1_owner_memberships" : "typed_v11_owner_memberships"} VALUES (?,?)`)
        .run(row.owner_id, row.participant_id);
    }
  } finally {
    db.close();
  }
  await chmod(path, 0o400);
  const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  return { directory, path, sha256, fixture };
}

test("D1 page adapter builds source owner membership with separate, non-copied authority", async () => {
  const prepared = [];
  const database = {
    prepare(sql) {
      prepared.push(sql);
      return {
        bind(...parameters) {
          return { all: async () => ({
            success: true,
            results: sql.includes("source_memberships")
              ? [{
                namespace_id: 1, source_format: 11, owner_id: 2,
                participant_id: "synthetic-owner", source_namespace: "synthetic-ns",
                participant_state: "active", owner_digest: "b".repeat(64), owner_link_state: "active",
                boundLimit: parameters.at(-1),
              }]
              : [{ id: 1, original_id: [1, 2] }],
          }) };
        },
      };
    },
  };
  const source = createD1TypedLegacyPageSource({ database });
  assert.equal(Object.hasOwn(source, "snapshot"), false);
  const membership = await source.listPage({ table: "typed_telemetry_owner_memberships", after: null, limit: 4 });
  assert.equal(membership.rows[0].authority.participantState, "active");
  assert.deepEqual(membership.rows[0].authority.ownerLink, { ownerDigest: "b".repeat(64), state: "active" });
  assert.equal(Object.hasOwn(membership.rows[0], "owner_digest"), false);
  const namespaces = await source.listPage({ table: "typed_telemetry_namespaces", after: null, limit: 5 });
  assert.equal(namespaces.rows[0].id, 1);
  assert.deepEqual(namespaces.rows[0].original_id, [1, 2]);
  assert.match(prepared[0], /typed_v1_owner_memberships/u);
  assert.match(prepared[0], /typed_v11_owner_memberships/u);
  assert.match(prepared[1], /ORDER BY "id" LIMIT \?/u);
});

test("sealed SQLite rehearsal source checks exact bytes, ownership and source authority", {
  skip: process.platform === "win32",
}, async () => {
  const { directory, path, sha256 } = await sealedSqliteFixture();
  let source;
  try {
    await assert.rejects(
      createSealedSqliteTypedLegacyRehearsalSource({ path, expectedSha256: "0".repeat(64) }),
      error => error instanceof PostgresTypedLegacyTransferError
        && error.code === "TYPED_LEGACY_SEALED_SQLITE_SHA256_MISMATCH",
    );
    source = await createSealedSqliteTypedLegacyRehearsalSource({ path, expectedSha256: sha256 });
    assert.equal(source.snapshot.kind, "sealed-sqlite-rehearsal");
    assert.equal(source.snapshot.artifactSha256, sha256);
    assert.deepEqual(await source.verifySnapshot(), {
      snapshotId: `sha256:${sha256}`, artifactSha256: sha256,
    });
    const dictionary = await source.listPage({ table: "typed_telemetry_dictionary", limit: 2 });
    assert.equal(dictionary.rows.length, 2);
    assert.equal(dictionary.rows[0].value, "openai_codex");
    const membership = await source.listPage({ table: "typed_telemetry_owner_memberships", limit: 3 });
    assert.deepEqual(membership.rows.map(row => row.source_format), [10n, 11n, 11n]);
    assert.equal(membership.rows[0].authority.ownerLink.ownerDigest, "a".repeat(64));
    assert.equal(membership.rows[2].authority.ownerLink, null);
    await chmod(path, 0o600);
    await assert.rejects(source.verifySnapshot(), error => error instanceof PostgresTypedLegacyTransferError
      && error.code === "TYPED_LEGACY_SEALED_SQLITE_UNSAFE");
    await chmod(path, 0o400);
    source.close();
    await assert.rejects(source.listPage({ table: "typed_telemetry_dictionary", limit: 2 }),
      error => error instanceof PostgresTypedLegacyTransferError
        && error.code === "TYPED_LEGACY_SEALED_SQLITE_CLOSED");
  } finally {
    source?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("synthetic transfer source owns an immutable copy of fixture rows", async () => {
  const inputRows = structuredClone(syntheticRows().rows);
  const source = syntheticD1Source({ mutableRows: inputRows });
  inputRows.typed_telemetry_dictionary[0].value = "changed-after-source-creation";
  const page = await source.listPage({ table: "typed_telemetry_dictionary", after: null, limit: 2 });
  assert.equal(page.rows[0].value, "openai_codex");
  assert.equal(source.snapshot.kind, "synthetic-d1-fixture");
  assert.equal(source.snapshot.immutable, true);
});

test("D1 live sources and unverified exports fail closed before PostgreSQL mutation", async () => {
  const liveSource = {
    snapshot: { kind: "live-d1", snapshotId: "moving-live-d1" },
    listPage: async () => ({ rows: [] }),
    verifySnapshot: async () => ({ snapshotId: "moving-live-d1" }),
  };
  await assert.rejects(
    runPostgresTypedLegacyTransfer({ source: liveSource, destinationPool: {}, targetSchema: `${POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX}live_source_refusal`, controlSchema: "typed_legacy_transfer_rehearsal_live_source_refusal", transferId: "live-d1-refusal" }),
    error => error instanceof PostgresTypedLegacyTransferError && error.code === "TYPED_LEGACY_SNAPSHOT_REQUIRED",
  );
  let d1ReadAttempted = false;
  const genericD1Source = createD1TypedLegacyPageSource({
    database: { prepare() { d1ReadAttempted = true; throw new Error("must not read D1"); } },
  });
  const mislabeledD1Source = {
    ...genericD1Source,
    snapshot: { kind: "synthetic-d1-fixture", snapshotId: "forged-fixture-id", immutable: true },
    verifySnapshot: async () => ({ snapshotId: "forged-fixture-id" }),
  };
  await assert.rejects(
    runPostgresTypedLegacyTransfer({ source: mislabeledD1Source, destinationPool: {}, targetSchema: `${POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX}forged_source_refusal`, controlSchema: "typed_legacy_transfer_rehearsal_forged_source", transferId: "forged-d1-source" }),
    error => error instanceof PostgresTypedLegacyTransferError && error.code === "TYPED_LEGACY_SNAPSHOT_REQUIRED",
  );
  assert.equal(d1ReadAttempted, false);
  const exportSource = {
    snapshot: {
      kind: "immutable-d1-export", snapshotId: "unverified-export-1", immutable: true,
      consistency: "frozen-export", sourceDatabaseId: "synthetic-db", artifactSha256: "a".repeat(64),
    },
    listPage: async () => ({ rows: [] }),
    verifySnapshot: async () => ({ snapshotId: "unverified-export-1", artifactSha256: "a".repeat(64) }),
  };
  await assert.rejects(
    runPostgresTypedLegacyTransfer({ source: exportSource, destinationPool: {}, targetSchema: `${POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX}export_refusal`, controlSchema: "typed_legacy_transfer_rehearsal_unverified", transferId: "export-refusal" }),
    error => error instanceof PostgresTypedLegacyTransferError && error.code === "TYPED_LEGACY_SNAPSHOT_REQUIRED",
  );
});

test("checkpoint tables require an explicit dedicated rehearsal schema", async () => {
  const source = syntheticD1Source();
  const destinationPool = {};
  for (const transfer of [
    { targetSchema: `${POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX}validtarget`, transferId: "missing-control-schema" },
    { targetSchema: `${POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX}validtarget`, controlSchema: `${POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX}validtarget`, transferId: "same-control-schema" },
    { targetSchema: `${POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX}validtarget`, controlSchema: "unscoped_metadata", transferId: "unscoped-control-schema" },
    { targetSchema: `${POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX}validtarget`, controlSchema: POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX, transferId: "unscoped-control-schema-short" },
  ]) {
    await assert.rejects(
      runPostgresTypedLegacyTransfer({ source, destinationPool, ...transfer }),
      error => error instanceof PostgresTypedLegacyTransferError && error.code === "TYPED_LEGACY_CONTROL_SCHEMA_REQUIRED",
    );
  }
});

test("synthetic transfer refuses a non-rehearsal target before destination access", async () => {
  const source = syntheticD1Source();
  let destinationCalls = 0;
  const destinationPool = {
    async query() { destinationCalls += 1; throw new Error("destination must not be queried"); },
    async connect() { destinationCalls += 1; throw new Error("destination must not be connected"); },
  };
  for (const targetSchema of ["public", "application"]) {
    await assert.rejects(
      runPostgresTypedLegacyTransfer({
        source,
        destinationPool,
        targetSchema,
        controlSchema: `${POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX}target_guard_test`,
        transferId: `${targetSchema}-target-refusal`,
      }),
      error => error instanceof PostgresTypedLegacyTransferError
        && error.code === "TYPED_LEGACY_TARGET_SCHEMA_REQUIRED",
    );
  }
  assert.equal(destinationCalls, 0);
});

test("PG17 typed legacy import streams bounded D1 pages, rolls back a failed page, resumes, and verifies receipts", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const endpoint = await localSocket();
  const pool = new pg.Pool({
    ...endpoint,
    user: PG_TEST_USER,
    password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only",
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5_000,
  });
  const suffix = randomBytes(5).toString("hex");
  const targetSchema = `${POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX}${suffix}`;
  const controlSchema = `${POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX}${suffix}`;
  let targetCreated = false;
  let controlCreated = false;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address, current_setting('server_version_num')::int AS version_num");
    assert.equal(locality.rows[0]?.address, null);
    assert.equal(Math.floor(locality.rows[0]?.version_num / 10_000), 17);
    await pool.query(`CREATE SCHEMA ${quoted(targetSchema)}`);
    targetCreated = true;
    await pool.query(`CREATE SCHEMA ${quoted(controlSchema)}`);
    controlCreated = true;
    const migrated = await applyPostgresMigrations({ role: "primary", schema: targetSchema, pool });
    assert.equal(migrated.applied, 42);

    const fixture = syntheticRows();
    const source = syntheticD1Source({ mutableRows: fixture.rows, d1BlobArrays: true });
    const now = new Date().toISOString();
    await pool.query(`INSERT INTO ${quoted(targetSchema)}.typed_telemetry_dictionary(id,value)
      VALUES (100,'synthetic-target-only-v12-value')`);
    await pool.query(`INSERT INTO ${quoted(targetSchema)}.participants(id,created_at) VALUES
      ($1,$3),($2,$3)`, [fixture.linkedParticipant, fixture.linklessParticipant, now]);
    // The source includes one linked participant in both v1 and v1.1, plus a
    // separate deliberately linkless v1.1 membership. The first attempt must
    // stop until the exact destination owner authority has been staged.
    await assert.rejects(
      runPostgresTypedLegacyTransfer({
        source, destinationPool: pool, targetSchema, controlSchema,
        transferId: "synthetic-legacy-transfer-01", pageSize: 2,
      }),
      error => error instanceof PostgresTypedLegacyTransferError
        && error.code === "TYPED_LEGACY_DESTINATION_AUTHORITY_MISSING",
    );
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quoted(targetSchema)}.typed_telemetry_records`)).rows[0]?.n, 0);
    const untouchedControl = await pool.query("SELECT to_regclass($1) AS name", [`${controlSchema}._typed_legacy_transfer_rehearsal_runs_v1`]);
    assert.equal(untouchedControl.rows[0]?.name, null);

    await pool.query(`INSERT INTO ${quoted(targetSchema)}.storage_v11_owner_links(participant_id,owner_digest,state)
      VALUES ($1,$2,'active')`, [fixture.linkedParticipant, fixture.ownerDigest]);
    await pool.query(`CREATE FUNCTION ${quoted(targetSchema)}.fail_transfer_record_1004()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id = 1004 THEN RAISE EXCEPTION 'synthetic_page_failure'; END IF;
        RETURN NEW;
      END $$`);
    await pool.query(`CREATE TRIGGER fail_transfer_record_1004 BEFORE INSERT ON ${quoted(targetSchema)}.typed_telemetry_records
      FOR EACH ROW EXECUTE FUNCTION ${quoted(targetSchema)}.fail_transfer_record_1004()`);
    const transfer = {
      source,
      destinationPool: pool,
      targetSchema,
      controlSchema,
      transferId: "synthetic-legacy-transfer-01",
      pageSize: 2,
    };
    await assert.rejects(runPostgresTypedLegacyTransfer(transfer), /synthetic_page_failure/u);
    const committedBeforeFailure = await pool.query(`SELECT id::text FROM ${quoted(targetSchema)}.typed_telemetry_records ORDER BY id`);
    assert.deepEqual(committedBeforeFailure.rows.map(row => row.id), ["1001", "1002"]);
    const checkpoint = await pool.query(`SELECT last_key,row_count::int,page_count::int,complete
      FROM ${quoted(controlSchema)}._typed_legacy_transfer_rehearsal_checkpoints_v1
      WHERE transfer_id=$1 AND table_name='typed_telemetry_records'`, [transfer.transferId]);
    assert.deepEqual(checkpoint.rows[0], { last_key: ["1002"], row_count: 2, page_count: 1, complete: false });

    await pool.query(`DROP TRIGGER fail_transfer_record_1004 ON ${quoted(targetSchema)}.typed_telemetry_records`);
    await pool.query(`DROP FUNCTION ${quoted(targetSchema)}.fail_transfer_record_1004()`);
    const receipt = await runPostgresTypedLegacyTransfer(transfer);
    assert.equal(receipt.status, "staged_rehearsal_complete");
    assert.equal(receipt.destination.postgresMajor, 17);
    assert.equal(receipt.pagesPreviouslyCommitted, 20);
    assert.ok(receipt.pagesCommittedThisRun > 0);
    assert.ok(source.getStats().maxRowsPerPage <= 2);
    assert.deepEqual(POSTGRES_TYPED_LEGACY_TRANSFER_TABLES, Object.keys(receipt.source.tables));
    assert.equal(receipt.source.manifestSha256, receipt.destination.manifestSha256);
    assert.equal(receipt.destination.comparedRows, receipt.source.rows);
    assert.equal(receipt.source.tables.typed_telemetry_dictionary.comparisonScope, "source-keys");
    assert.equal(receipt.destination.tables.typed_telemetry_dictionary.comparisonScope, "source-keys");
    assert.equal(receipt.destination.tables.typed_telemetry_dictionary.rows, 14);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quoted(targetSchema)}.typed_telemetry_dictionary`)).rows[0]?.n, 15);
    assert.equal(receipt.authority.membershipRowsChecked, 3);
    assert.equal(receipt.authority.matchingActiveOwnerLinks, 2);
    assert.equal(receipt.authority.preservedLinklessMemberships, 1);
    assert.equal(receipt.authority.ownerDigestsTransferred, 0);
    assert.equal(receipt.authority.missingAuthorityAcceptedAsProof, false);
    assert.deepEqual(receipt.capabilities, {
      legacyRowsTransferred: true,
      v1AdmissionsTransferred: false,
      v11AdmissionsTransferred: false,
      preservationProofsTransferred: false,
      effectiveReaderEnabled: false,
      erasureAuthorized: false,
      productionCutoverAuthorized: false,
    });
    for (const table of POSTGRES_TYPED_LEGACY_TRANSFER_TABLES) {
      assert.equal(receipt.source.tables[table].rows, receipt.destination.tables[table].rows, table);
      assert.equal(receipt.source.tables[table].sha256, receipt.destination.tables[table].sha256, table);
    }
    const lineage = await pool.query(`SELECT id::text,format::int,source_row_id::text,chunk_id::text,manifest_id::text
      FROM ${quoted(targetSchema)}.typed_telemetry_records ORDER BY id`);
    assert.equal(lineage.rows.length, 8);
    assert.deepEqual(lineage.rows.find(row => row.id === "2001"), {
      id: "2001", format: 11, source_row_id: "2001", chunk_id: "111", manifest_id: "401",
    });
    const nextDictionary = await pool.query(`INSERT INTO ${quoted(targetSchema)}.typed_telemetry_dictionary(value)
      VALUES ('synthetic-sequence-probe') RETURNING id::text`);
    assert.equal(nextDictionary.rows[0]?.id, "101");

    const repeated = await runPostgresTypedLegacyTransfer(transfer);
    assert.equal(repeated.status, "staged_rehearsal_complete");
    assert.equal(repeated.pagesCommittedThisRun, 0);
    assert.equal(repeated.destination.manifestSha256, receipt.destination.manifestSha256);

    const invalidBlobRows = structuredClone(fixture.rows);
    invalidBlobRows.typed_telemetry_namespaces[0].original_id = [256];
    const invalidBlobSource = syntheticD1Source({ mutableRows: invalidBlobRows, d1BlobArrays: true });
    await assert.rejects(
      runPostgresTypedLegacyTransfer({ ...transfer, source: invalidBlobSource, transferId: "synthetic-invalid-byte-array" }),
      error => error instanceof PostgresTypedLegacyTransferError && error.code === "TYPED_LEGACY_VALUE_INVALID",
    );

    const changedRows = structuredClone(fixture.rows);
    changedRows.typed_telemetry_records.push({ ...fixture.rows.typed_telemetry_records[0], id: 9999, source_row_id: 9999 });
    const mutatedSource = syntheticD1Source({ mutableRows: changedRows });
    await assert.rejects(
      runPostgresTypedLegacyTransfer({ ...transfer, source: mutatedSource }),
      error => error instanceof PostgresTypedLegacyTransferError && error.code === "TYPED_LEGACY_TRANSFER_ID_REUSED",
    );
  } finally {
    if (controlCreated) await pool.query(`DROP SCHEMA ${quoted(controlSchema)} CASCADE`);
    if (targetCreated) await pool.query(`DROP SCHEMA ${quoted(targetSchema)} CASCADE`);
    await pool.end();
  }
});

test("PG17 imports a hash-sealed SQLite export rehearsal and refuses a changed artifact", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const endpoint = await localSocket();
  const pool = new pg.Pool({
    ...endpoint,
    user: PG_TEST_USER,
    password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only",
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5_000,
  });
  const suffix = randomBytes(5).toString("hex");
  const targetSchema = `${POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX}${suffix}`;
  const controlSchema = `${POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX}${suffix}`;
  const sealed = await sealedSqliteFixture();
  let source;
  let targetCreated = false;
  let controlCreated = false;
  try {
    await pool.query(`CREATE SCHEMA ${quoted(targetSchema)}`);
    targetCreated = true;
    await pool.query(`CREATE SCHEMA ${quoted(controlSchema)}`);
    controlCreated = true;
    const migrated = await applyPostgresMigrations({ role: "primary", schema: targetSchema, pool });
    assert.ok(migrated.applied >= 30);
    source = await createSealedSqliteTypedLegacyRehearsalSource({
      path: sealed.path, expectedSha256: sealed.sha256,
    });
    const now = new Date().toISOString();
    await pool.query(`INSERT INTO ${quoted(targetSchema)}.participants(id,created_at) VALUES
      ($1,$3),($2,$3)`, [sealed.fixture.linkedParticipant, sealed.fixture.linklessParticipant, now]);
    await pool.query(`INSERT INTO ${quoted(targetSchema)}.storage_v11_owner_links(participant_id,owner_digest,state)
      VALUES ($1,$2,'active')`, [sealed.fixture.linkedParticipant, sealed.fixture.ownerDigest]);
    const transfer = {
      source, destinationPool: pool, targetSchema, controlSchema,
      transferId: "sealed-sqlite-legacy-rehearsal", pageSize: 2,
    };
    const receipt = await runPostgresTypedLegacyTransfer(transfer);
    assert.equal(receipt.status, "staged_rehearsal_complete");
    assert.equal(receipt.source.kind, "sealed-sqlite-rehearsal");
    assert.equal(receipt.source.artifactSha256, sealed.sha256);
    assert.equal(receipt.source.manifestSha256, receipt.destination.manifestSha256);
    assert.equal(receipt.authority.preservedLinklessMemberships, 1);
    assert.equal(receipt.capabilities.productionCutoverAuthorized, false);
    const evidenceTable = `${quoted(controlSchema)}.${quoted(POSTGRES_TYPED_LEGACY_STAGING_FAMILY_EVIDENCE_TABLE)}`;
    const evidenceRows = await pool.query(`SELECT transfer_id,target_schema,source_snapshot_id,
        source_artifact_sha256,source_manifest_sha256,target_manifest_sha256,source_format::int AS source_format,
        source_namespace,source_row_count::text,membership_row_count::text,membership_table_sha256,
        records_table_sha256,family_evidence_sha256
      FROM ${evidenceTable} WHERE transfer_id=$1 ORDER BY source_format,source_namespace`, [transfer.transferId]);
    assert.equal(receipt.stagingFamilyEvidence.rowCount, 2);
    assert.equal(evidenceRows.rows.length, 2);
    assert.deepEqual(evidenceRows.rows.map(row => [row.source_format,row.source_namespace,
      row.source_row_count,row.membership_row_count]), [
      [10, "synthetic-v1-source", "6", "1"],
      [11, "synthetic-v11-shared-source", "2", "2"],
    ]);
    for (const row of evidenceRows.rows) {
      assert.equal(row.transfer_id, transfer.transferId);
      assert.equal(row.target_schema, targetSchema);
      assert.equal(row.source_snapshot_id, receipt.source.snapshotId);
      assert.equal(row.source_artifact_sha256, sealed.sha256);
      assert.equal(row.source_manifest_sha256, receipt.source.manifestSha256);
      assert.equal(row.target_manifest_sha256, receipt.destination.manifestSha256);
      assert.equal(row.membership_table_sha256, receipt.source.tables.typed_telemetry_owner_memberships.sha256);
      assert.equal(row.records_table_sha256, receipt.source.tables.typed_telemetry_records.sha256);
      assert.equal(row.family_evidence_sha256, typedLegacyStagingFamilyEvidenceSha256({
        sourceSnapshotId: row.source_snapshot_id,
        sourceArtifactSha256: row.source_artifact_sha256,
        sourceManifestSha256: row.source_manifest_sha256,
        targetManifestSha256: row.target_manifest_sha256,
        sourceFormat: row.source_format,
        sourceNamespace: row.source_namespace,
        sourceRowCount: row.source_row_count,
        membershipRowCount: row.membership_row_count,
        membershipTableSha256: row.membership_table_sha256,
        recordsTableSha256: row.records_table_sha256,
      }));
    }
    assert.equal(receipt.stagingFamilyEvidence.sha256,
      createHash("sha256").update(JSON.stringify(evidenceRows.rows.map(row => row.family_evidence_sha256))).digest("hex"));
    await assert.rejects(pool.query(`UPDATE ${evidenceTable} SET source_row_count=source_row_count
      WHERE transfer_id=$1`, [transfer.transferId]), /typed_legacy_staging_family_evidence_immutable/u);
    const repeated = await runPostgresTypedLegacyTransfer(transfer);
    assert.deepEqual(repeated.stagingFamilyEvidence, receipt.stagingFamilyEvidence);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${evidenceTable} WHERE transfer_id=$1`,
      [transfer.transferId])).rows[0]?.count, 2);
    await chmod(sealed.path, 0o600);
    const mutable = new DatabaseSync(sealed.path);
    try {
      mutable.prepare("UPDATE typed_telemetry_dictionary SET value=? WHERE id=1")
        .run("changed-after-transfer");
    } finally {
      mutable.close();
      await chmod(sealed.path, 0o400);
    }
    await assert.rejects(runPostgresTypedLegacyTransfer(transfer),
      error => error instanceof PostgresTypedLegacyTransferError
        && error.code === "TYPED_LEGACY_SNAPSHOT_CHANGED");
  } finally {
    source?.close();
    if (controlCreated) await pool.query(`DROP SCHEMA ${quoted(controlSchema)} CASCADE`);
    if (targetCreated) await pool.query(`DROP SCHEMA ${quoted(targetSchema)} CASCADE`);
    await pool.end();
    await rm(sealed.directory, { recursive: true, force: true });
  }
});

test("PG17 typed legacy transfer rejects an ambiguous admission singleton before staging", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const endpoint = await localSocket();
  const pool = new pg.Pool({
    ...endpoint,
    user: PG_TEST_USER,
    password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only",
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5_000,
  });
  const suffix = randomBytes(5).toString("hex");
  const targetSchema = `${POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX}${suffix}`;
  const controlSchema = `${POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX}${suffix}`;
  const sealed = await sealedSqliteFixture({ duplicateV11AdmissionState: true });
  let source;
  let targetCreated = false;
  let controlCreated = false;
  try {
    await pool.query(`CREATE SCHEMA ${quoted(targetSchema)}`);
    targetCreated = true;
    await pool.query(`CREATE SCHEMA ${quoted(controlSchema)}`);
    controlCreated = true;
    const migrated = await applyPostgresMigrations({ role: "primary", schema: targetSchema, pool });
    assert.ok(migrated.applied >= 30);
    source = await createSealedSqliteTypedLegacyRehearsalSource({
      path: sealed.path, expectedSha256: sealed.sha256,
    });
    const now = new Date().toISOString();
    await pool.query(`INSERT INTO ${quoted(targetSchema)}.participants(id,created_at) VALUES
      ($1,$3),($2,$3)`, [sealed.fixture.linkedParticipant, sealed.fixture.linklessParticipant, now]);
    await pool.query(`INSERT INTO ${quoted(targetSchema)}.storage_v11_owner_links(participant_id,owner_digest,state)
      VALUES ($1,$2,'active')`, [sealed.fixture.linkedParticipant, sealed.fixture.ownerDigest]);
    const transfer = {
      source, destinationPool: pool, targetSchema, controlSchema,
      transferId: "sealed-sqlite-ambiguous-admission-refusal", pageSize: 2,
    };
    await assert.rejects(runPostgresTypedLegacyTransfer(transfer), error =>
      error instanceof PostgresTypedLegacyTransferError
        && error.code === "TYPED_LEGACY_SOURCE_ORDER_INVALID");
    const controlState = await pool.query("SELECT to_regclass($1) AS name", [
      `${controlSchema}._typed_legacy_transfer_rehearsal_runs_v1`,
    ]);
    assert.equal(controlState.rows[0]?.name, null);
  } finally {
    source?.close();
    if (controlCreated) await pool.query(`DROP SCHEMA ${quoted(controlSchema)} CASCADE`);
    if (targetCreated) await pool.query(`DROP SCHEMA ${quoted(targetSchema)} CASCADE`);
    await pool.end();
    await rm(sealed.directory, { recursive: true, force: true });
  }
});
