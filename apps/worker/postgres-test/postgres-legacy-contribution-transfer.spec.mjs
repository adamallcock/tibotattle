import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CutoverSourceError, readCutoverSeal } from "../scripts/cutover-source-seal.mjs";
import { readPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { runIdentityAuthorityTransfer } from "../scripts/postgres-identity-authority-transfer.mjs";
import {
  LEGACY_CONTRIBUTIONS_ORDER,
  LEGACY_TRIGGER_POLICY,
  LegacyContributionTransferError,
  OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING,
  checkPendingObjectTransferGuard,
  runLegacyContributionsProduction,
  runOperationalHistoryProduction,
  runPendingRegistrationsProduction,
} from "../scripts/postgres-legacy-contribution-transfer.mjs";
import {
  PostgresTransferTargetError,
  advanceRun,
  beginRun,
  stageReceipt,
  withTransferTransaction,
} from "../scripts/postgres-transfer-target.mjs";
import {
  reconcilePostgresPendingObjects,
  releasePostgresPendingObjectTransferHolds,
} from "../src/postgres-quarantine-reconciliation.ts";
import { createW2SealCluster, PRIMARY_SCHEMA } from "./fixtures/w2-seal/pg-target.mjs";
import { forgeVariantSeal, headCommit, outputPathsOf, prepareSealWorld, sealWorld } from "./fixtures/w2-seal/seal-harness.mjs";
import {
  SYNTHETIC_IDENTITY_LINK_SECRET,
  SYNTHETIC_IDENTITY_LINK_VERSION,
  identityLinkFingerprint,
} from "./fixtures/w2-seal/synthetic-sources.mjs";
import { applyStockAndStagedMigrations, STAGED_MIGRATIONS_ROOT } from "./staged-migrations-harness.mjs";

// D-PT4X acceptance on PostgreSQL 17 over a synthetic PT-2-lite seal of the
// Q-1 corpus plus synthetic v0.x history, pending registrations, admin metric
// snapshots and aggregate exclusions: N-V0X ('legacy-contributions'), the
// pending_quarantine_objects -> pending_objects mapping with the E-PT4
// transfer holds ('pending-registrations'), N-ADMINHIST and N-EXCL (receipts
// under 'post-import'), PT-8 preflight P13, and the reconciler honouring the
// holds. Everything is local and synthetic.

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIN = Object.freeze({ keyVersion: SYNTHETIC_IDENTITY_LINK_VERSION,
  secretFingerprint: identityLinkFingerprint(SYNTHETIC_IDENTITY_LINK_SECRET) });
const SCHEMAS = Object.freeze({ primarySchema: PRIMARY_SCHEMA });
const table = name => `"${PRIMARY_SCHEMA}"."${name}"`;
const sha = value => createHash("sha256").update(value).digest("hex");
const RECORDS = 600;
const RECORD_SEQUENCE = 2000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EXCLUSIONS_SUFFIX = "_community_aggregate_exclusions.sql";
const HOLDS_SUFFIX = "_pending_object_transfer_holds.sql";

const isCode = code => error => (error instanceof LegacyContributionTransferError
  || error instanceof PostgresTransferTargetError || error instanceof CutoverSourceError) && error.code === code;

/** A staged migration by name suffix: staged (applied by the harness) or already promoted. */
async function migrationBySuffix(suffix) {
  let staged = [];
  try {
    staged = (await readdir(join(STAGED_MIGRATIONS_ROOT, "primary"))).filter(name => name.endsWith(suffix));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const promoted = (await readPostgresMigrations({ role: "primary" })).map(migration => migration.name)
    .filter(name => name.endsWith(suffix));
  expect(staged.length + promoted.length, suffix).toBe(1);
  return staged[0] ?? promoted[0];
}

function literal(value) {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function insert(name, row) {
  const columns = Object.keys(row);
  return `INSERT INTO "${name}" (${columns.map(column => `"${column}"`).join(", ")})
    VALUES (${columns.map(column => literal(row[column])).join(", ")});`;
}

/**
 * Synthetic v0.x history and operational rows written into a copy of the
 * sealed ingestion D1. The D1 triggers of the touched tables (journal, upload
 * consumption, owner checks, weekly-snapshot withdrawal) are dropped for the
 * inserts and recreated verbatim, so the sealed schema is unchanged.
 */
function syntheticHistorySql(sealedPath, fixture) {
  const database = new DatabaseSync(sealedPath, { readOnly: true });
  let triggers;
  try {
    triggers = database.prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'
      AND tbl_name IN ('telemetry_contributions', 'telemetry_records', 'telemetry_contribution_occurrences',
        'telemetry_contribution_admission_windows', 'pending_quarantine_objects', 'admin_metric_snapshots',
        'admin_metrics_history_cache', 'community_aggregate_exclusions') ORDER BY name`).all();
  } finally {
    database.close();
  }
  const { ids, nowMs } = fixture;
  const iso = epoch => new Date(epoch).toISOString();
  const participant = ids.participant;
  const day = 1_785_000_000_000;
  const contributions = [
    { id: `contribution:${randomUUID()}`, status: "accepted", upload: ids.upload, transport: "telemetry-contribution-v0.2",
      cost: "0.0123", deleted: null },
    { id: `contribution:${randomUUID()}`, status: "accepted", upload: null, transport: "telemetry-contribution-v0.1",
      cost: null, deleted: null },
    { id: `contribution:${randomUUID()}`, status: "deleting", upload: null, transport: "telemetry-contribution-v0.2",
      cost: "12.50", deleted: iso(nowMs - DAY) },
  ];
  const statements = triggers.map(trigger => `DROP TRIGGER "${trigger.name}";`);
  contributions.forEach((contribution, index) => statements.push(insert("telemetry_contributions", {
    id: contribution.id, participant_id: participant, plaintext_digest: sha(`plain-${index}`),
    envelope_digest: sha(`envelope-${index}`), r2_key: `telemetry/${randomUUID()}`, status: contribution.status,
    schema_version: "telemetry-contribution-v0.1", range_start: iso(day + index * DAY),
    // A non-key instant without milliseconds is canonicalized, not refused.
    range_end: `${iso(day + index * DAY + HOUR).slice(0, 19)}Z`, client_platform: "macos",
    provider_policy_epoch: "synthetic-epoch", estimated_api_cost_usd: contribution.cost,
    priced_event_coverage_percent: index === 0 ? 87.5 : 0.1, unknown_model_event_count: index,
    unknown_billable_units: 0, price_basis: "synthetic-basis", declared_record_count: index === 0 ? RECORDS : 1,
    created_at: iso(day + index * DAY + 2 * HOUR), upload_authorization_id: contribution.upload,
    server_cost_nanousd: 1234 * index, server_pricing_method_version: index === 0 ? "synthetic-method" : null,
    transport_schema_version: contribution.transport, quarantine_deleted_at: contribution.deleted,
    accepted_record_count: index === 0 ? RECORDS : null,
  })));
  for (let index = 0; index < RECORDS; index += 1) {
    const id = 1001 + index;
    const origin = index % 50 === 7 ? null : contributions[0].id;
    statements.push(insert("telemetry_records", {
      id, origin_contribution_id: origin, participant_id: participant, record_kind: index % 3 === 0 ? "quota" : "usage",
      occurrence_id: `occurrence-${index}`,
      observed_at: index % 2 === 0 ? iso(day + index * 60_000) : `${iso(day + index * 60_000).slice(0, 19)}Z`,
      provider: "synthetic", model_id: index % 4 === 0 ? null : "synthetic-model", plan_type: "plus",
      used_percent: index % 5 === 0 ? 1e-7 : index / 8, window_duration_minutes: 300,
      resets_at: index % 3 === 0 ? iso(day + 5 * HOUR) : null, input_uncached_tokens: 10 * index,
      output_text_tokens: 2 ** 40 + index, estimated_api_cost_usd: index % 2 === 0 ? "0.0001" : "1.50",
      pricing_coverage_percent: 100, unknown_billable_units: 0,
      // Unsorted keys and whitespace: jsonb normalizes, the canonical digest does not care.
      record_json: index % 2 === 0 ? `{ "z": ${index}, "a": { "y": [1, 2.5, "x"], "b": null } }` : `{"k":"v${index}","n":1.0}`,
      server_cost_usd: index % 7 === 0 ? "0.000123" : null, server_cost_nanousd: index,
      server_price_card_ids: index % 2 === 0 ? `["card-b","card-a"]` : null, server_unpriced_reason_codes: "[]",
      account_track_id: "unattributed", policy_epoch: "synthetic.epoch:1",
      server_price_event_time: index % 9 === 0 ? iso(day + index * 60_000) : null,
    }));
    if (origin !== null) {
      statements.push(insert("telemetry_contribution_occurrences", {
        contribution_id: origin, participant_id: participant, record_kind: index % 3 === 0 ? "quota" : "usage",
        occurrence_id: `occurrence-${index}`, account_track_id: "unattributed", policy_epoch: "synthetic.epoch:1",
      }));
    }
  }
  statements.push(insert("telemetry_contribution_occurrences", {
    contribution_id: contributions[1].id, participant_id: participant, record_kind: "usage", occurrence_id: "occurrence-1",
  }));
  statements.push(`UPDATE sqlite_sequence SET seq = ${RECORD_SEQUENCE} WHERE name = 'telemetry_records';`);
  statements.push(insert("telemetry_contribution_admission_windows", {
    participant_id: participant, window_started_at: "2026-07-27T00:00:00.000Z", accepted_count: 100,
    last_accepted_at: iso(day),
  }));
  statements.push(insert("telemetry_contribution_admission_windows", {
    participant_id: participant, window_started_at: "2026-08-03T00:00:00.000Z", accepted_count: 3,
    last_accepted_at: iso(day + 3 * DAY),
  }));
  // Pending registrations: aged registered orphans, one deleting under a
  // legacy UUID lease, one synthetic object.
  const registered = iso(nowMs - 2 * DAY);
  const pending = [
    { r2_key: `telemetry/${randomUUID()}`, contribution_id: `contribution:${randomUUID()}`, object_kind: "telemetry",
      registered_at: registered, reconciliation_state: "registered", reconciliation_lease_id: null },
    { r2_key: `telemetry/${randomUUID()}`, contribution_id: `chunk:${randomUUID()}`, object_kind: "telemetry",
      registered_at: registered, reconciliation_state: "registered", reconciliation_lease_id: null },
    { r2_key: `telemetry/${randomUUID()}`, contribution_id: `contribution:${randomUUID()}`, object_kind: "telemetry",
      registered_at: `${registered.slice(0, 19)}Z`, reconciliation_state: "deleting", reconciliation_lease_id: randomUUID() },
    { r2_key: `telemetry/${randomUUID()}`, contribution_id: `chunk:${randomUUID()}`, object_kind: "telemetry",
      registered_at: iso(nowMs - 3 * DAY), reconciliation_state: "registered", reconciliation_lease_id: null },
    { r2_key: `synthetic/${randomUUID()}`, contribution_id: `synthetic:${randomUUID()}`, object_kind: "synthetic",
      registered_at: registered, reconciliation_state: "registered", reconciliation_lease_id: null },
  ];
  for (const row of pending) statements.push(insert("pending_quarantine_objects", row));
  const snapshots = [0, 1, 2].map(index => ({ captured_at: iso(nowMs - (3 - index) * HOUR),
    metrics_json: JSON.stringify({ participantsTotal: 10 + index, quarantinePendingObjects: 5,
      cohortParticipants_plus: 3 }) }));
  for (const row of snapshots) statements.push(insert("admin_metric_snapshots", row));
  const cacheOnly = { capturedAt: iso(nowMs - 30 * HOUR), metrics: { participantsTotal: 7, bandFitCount: 2 } };
  statements.push(insert("admin_metrics_history_cache", {
    singleton: 1, generated_at: iso(nowMs - HOUR),
    payload_json: JSON.stringify({ schemaVersion: "admin-metrics-history-v0.3", generatedAt: iso(nowMs - HOUR),
      events: {}, downloads: { available: false, byDayStartsAt: "2026-09-01", byDay: [] },
      gauges: { snapshots: [cacheOnly, { capturedAt: snapshots[0].captured_at, metrics: { participantsTotal: 10 } }] } }),
  }));
  const exclusions = [
    { exclusion_id: "exclusion-active", participant_id: participant, scope: "community_weekly", reason_code: "data_quality",
      state: "active", effective_at: iso(day), expires_at: null, created_at: iso(day), created_by_digest: sha("operator"),
      revoked_at: null, revoked_by_digest: null },
    { exclusion_id: "exclusion-orphan", participant_id: `participant:${randomUUID()}`, scope: "community_weekly",
      reason_code: "abuse_signal", state: "revoked", effective_at: iso(day), expires_at: iso(day + 30 * DAY),
      created_at: iso(day), created_by_digest: sha("operator"), revoked_at: iso(day + DAY),
      revoked_by_digest: sha("operator-2") },
  ];
  for (const row of exclusions) statements.push(insert("community_aggregate_exclusions", row));
  statements.push(...triggers.map(trigger => `${trigger.sql};`));
  return { sql: statements.join("\n"), contributions, pending, snapshots, cacheOnly, exclusions };
}

async function count(pool, name, where = "") {
  return Number((await pool.query(`SELECT count(*)::int AS n FROM ${table(name)} ${where}`)).rows[0].n);
}

async function tableTextDigests(pool, names) {
  const digests = {};
  for (const name of names) {
    const result = await pool.query(`SELECT count(*)::int AS n,
        md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text COLLATE "C"), '')) AS digest FROM ${table(name)} t`);
    digests[name] = result.rows[0];
  }
  return digests;
}

async function xmins(pool, relations) {
  const result = {};
  for (const relation of relations) {
    result[relation] = (await pool.query(`SELECT count(*)::int AS n,
        md5(coalesce(string_agg(xmin::text, ',' ORDER BY xmin::text), '')) AS xmins FROM ${relation}`)).rows[0];
  }
  return result;
}

function syntheticObjectStore() {
  const calls = { head: [], delete: [] };
  return {
    calls,
    async head(key) {
      calls.head.push(key);
      return null;
    },
    async delete(key) {
      calls.delete.push(key);
    },
  };
}

describe.skipIf(!PG_TEST_SOCKET)("D-PT4X legacy contributions, pending registrations and operational history on PostgreSQL 17", () => {
  let world;
  let history;
  let forged;
  let cluster;
  let main;
  let clean;
  let bare;
  let sealedDb;
  const receipts = {};
  const handles = {};

  beforeAll(async () => {
    world = await prepareSealWorld({ commit: headCommit(WORKER_ROOT) });
    const run = await sealWorld(world);
    const result = await run.run();
    const seal = await readCutoverSeal({ manifestPath: outputPathsOf(run.out).manifest, expectedSealId: result.sealId });
    history = syntheticHistorySql(seal.sources.ingestion.path, world.fixture);
    forged = await forgeVariantSeal(seal, history.sql);
    const forgedSeal = await readCutoverSeal({ manifestPath: forged.manifestPath, expectedSealId: forged.sealId });
    sealedDb = new DatabaseSync(forgedSeal.sources.ingestion.path, { readOnly: true });
    cluster = await createW2SealCluster({ socket: PG_TEST_SOCKET, port: PG_TEST_PORT, user: PG_TEST_USER,
      password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE, count: 3, label: "dpt4x" });
    [main, clean, bare] = cluster.targets;
    const exclusions = await migrationBySuffix(EXCLUSIONS_SUFFIX);
    const holds = await migrationBySuffix(HOLDS_SUFFIX);
    // main and clean carry both staged migrations; bare has no transfer-hold table.
    for (const [target, files] of [[main, [exclusions, holds]], [clean, [exclusions, holds]], [bare, [exclusions]]]) {
      await applyStockAndStagedMigrations({ role: "primary", schema: PRIMARY_SCHEMA, pool: target.ownerPrimary,
        stagedFiles: files });
    }
  }, 900_000);

  afterAll(async () => {
    sealedDb?.close();
    await cluster?.dispose();
    await world?.dispose();
  });

  async function beginImporting(target) {
    const handle = await target.open(forged.sealId);
    await beginRun(handle, { sealedAt: forged.sealedAt });
    await advanceRun(handle, "importing");
    return handle;
  }

  async function stubTelemetryStages(handle) {
    // Synthetic stand-ins for D-PT5A's production stages (not built on this line).
    await withTransferTransaction(handle, "primary", async client => {
      for (const stage of ["telemetry-v1-v11", "telemetry-v12"]) {
        await stageReceipt(client, handle, { stage, state: "complete", rowCount: 0, byteCount: 0,
          receiptSha256: sha(`d-pt4x-synthetic-stub:${stage}`) });
      }
    });
  }

  it("refuses every runner before any write until identity-authority is complete", async () => {
    const handle = await beginImporting(bare);
    handles.bare = handle;
    for (const run of [runLegacyContributionsProduction, runOperationalHistoryProduction, runPendingRegistrationsProduction]) {
      await expect(run({ handle, sealManifestPath: forged.manifestPath }), run.name)
        .rejects.toSatisfy(isCode("CUTOVER_STAGE_INCOMPLETE"));
    }
    for (const name of [...LEGACY_CONTRIBUTIONS_ORDER, "pending_objects", "analytics_admin_metric_snapshots",
      "community_aggregate_exclusions"]) {
      expect(await count(bare.ownerPrimary, name), name).toBe(0);
    }
    const stages = await bare.ownerPrimary.query("SELECT count(*)::int AS n FROM tibotattle_transfer.transfer_stage_receipts");
    expect(stages.rows[0].n).toBe(0);
  }, 600_000);

  it("imports the sealed v0.x history verbatim, resumes a killed run byte-identically and replays without writing", async () => {
    let handle = await beginImporting(main);
    await runIdentityAuthorityTransfer({ handle, sealManifestPath: forged.manifestPath, identityLinkPin: PIN });
    let killed = null;
    try {
      await runLegacyContributionsProduction({ handle, sealManifestPath: forged.manifestPath, pageRows: 97,
        onPage: ({ table: name, page }) => {
          if (name === "telemetry_records" && page === 3) throw new Error("synthetic kill at a page boundary");
        } });
    } catch (error) {
      killed = error;
    }
    expect(killed?.code).toBe("CUTOVER_LEGACY_TRANSFER_FAILED");
    const pending = await main.ownerPrimary.query(`SELECT state, row_count::int AS rows, last_key
      FROM tibotattle_transfer.transfer_checkpoints WHERE checkpoint_name = 'table:telemetry_records'`);
    expect(pending.rows).toEqual([{ state: "pending", rows: 291, last_key: null }]);
    expect(await count(main.ownerPrimary, "telemetry_records")).toBe(291);

    handle = await main.open(forged.sealId);
    expect(handle.resumed).toBe(true);
    handles.main = handle;
    receipts.legacy = await runLegacyContributionsProduction({ handle, sealManifestPath: forged.manifestPath, pageRows: 97 });

    const cleanHandle = await beginImporting(clean);
    handles.clean = cleanHandle;
    await runIdentityAuthorityTransfer({ handle: cleanHandle, sealManifestPath: forged.manifestPath, identityLinkPin: PIN });
    const cleanReceipt = await runLegacyContributionsProduction({ handle: cleanHandle, sealManifestPath: forged.manifestPath,
      pageRows: 53, pageBytes: 16 * 1024 });
    expect(receipts.legacy.receiptSha256).toBe(cleanReceipt.receiptSha256);
    expect(receipts.legacy.tables).toEqual(cleanReceipt.tables);
    expect(cleanReceipt.pages.telemetry_records).toBeGreaterThan(Math.ceil(RECORDS / 53) - 1);
    expect(await tableTextDigests(main.ownerPrimary, LEGACY_CONTRIBUTIONS_ORDER))
      .toEqual(await tableTextDigests(clean.ownerPrimary, LEGACY_CONTRIBUTIONS_ORDER));

    for (const name of LEGACY_CONTRIBUTIONS_ORDER) {
      const sealedRows = Number(sealedDb.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n);
      expect(receipts.legacy.tables[name].sourceRows, name).toBe(sealedRows);
      expect(receipts.legacy.tables[name].targetRows, name).toBe(sealedRows);
      expect(await count(main.ownerPrimary, name), name).toBe(sealedRows);
    }
    expect(receipts.legacy.tables.telemetry_records.sourceRows).toBe(RECORDS);
    expect(receipts.legacy.mustBeEmpty).toEqual({ contributions: { rows: 0, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) } });

    // Verbatim: the 'deleting' contribution and its quarantine time, decimals,
    // reals, canonicalized instants and JSON.
    const deleting = await main.ownerPrimary.query(`SELECT status, quarantine_deleted_at IS NOT NULL AS deleted,
        estimated_api_cost_usd::text AS cost FROM ${table("telemetry_contributions")} WHERE id = $1`,
    [history.contributions[2].id]);
    expect(deleting.rows).toEqual([{ status: "deleting", deleted: true, cost: "12.50" }]);
    const record = await main.ownerPrimary.query(`SELECT record_json, server_price_card_ids, used_percent,
        output_text_tokens::text AS tokens, to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed
      FROM ${table("telemetry_records")} WHERE id = 1001`);
    expect(record.rows).toEqual([{ record_json: { z: 0, a: { y: [1, 2.5, "x"], b: null } },
      server_price_card_ids: ["card-b", "card-a"], used_percent: 1e-7, tokens: String(2 ** 40),
      observed: new Date(1_785_000_000_000).toISOString() }]);
    // Windows are not double counted: the sealed rows, verbatim.
    const windows = await main.ownerPrimary.query(`SELECT accepted_count FROM ${table("telemetry_contribution_admission_windows")}
      ORDER BY window_started_at`);
    expect(windows.rows).toEqual([{ accepted_count: 100 }, { accepted_count: 3 }]);
    // The source-revision triggers were suppressed: no revision bump, digest or journal row.
    expect(await count(main.ownerPrimary, "input_versions", "WHERE revision <> 0")).toBe(0);
    expect(await count(main.ownerPrimary, "input_source_digests")).toBe(0);
    expect(await count(main.ownerPrimary, "storage_ingestion_changes")).toBe(0);
    const disabled = await main.ownerPrimary.query(`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal AND t.tgenabled <> 'O'`,
    [PRIMARY_SCHEMA]);
    expect(disabled.rows[0].n).toBe(0);
    expect(receipts.legacy.triggerPolicy.suppressed).toBe(Object.values(LEGACY_TRIGGER_POLICY.telemetry_contributions)
      .filter(entry => entry.policy === "suppress").length + 1);
    // The identity sequence passes the sealed AUTOINCREMENT counter.
    const next = await main.ownerPrimary.query(`SELECT nextval(pg_get_serial_sequence($1, 'id'))::bigint AS id`,
      [`${PRIMARY_SCHEMA}.telemetry_records`]);
    expect(Number(next.rows[0].id)).toBeGreaterThan(RECORD_SEQUENCE);

    const tableReceipts = await main.ownerPrimary.query(`SELECT source_table, disposition, state,
        source_sha256 = target_sha256 AS equal FROM tibotattle_transfer.transfer_table_receipts
      WHERE stage = 'legacy-contributions' ORDER BY source_table`);
    expect(tableReceipts.rows.map(row => row.source_table)).toEqual([...LEGACY_CONTRIBUTIONS_ORDER, "contributions"].sort());
    for (const row of tableReceipts.rows) {
      expect(row.state).toBe("complete");
      expect(row.disposition).toBe(row.source_table === "contributions" ? "must-be-empty" : "imported:legacy-contributions");
      if (row.source_table !== "contributions") expect(row.equal, row.source_table).toBe(true);
    }

    const relations = [...LEGACY_CONTRIBUTIONS_ORDER.map(table), "tibotattle_transfer.transfer_stage_receipts",
      "tibotattle_transfer.transfer_table_receipts", "tibotattle_transfer.transfer_checkpoints"];
    const before = await xmins(main.ownerPrimary, relations);
    const replay = await runLegacyContributionsProduction({ handle, sealManifestPath: forged.manifestPath });
    expect(replay.receiptSha256).toBe(receipts.legacy.receiptSha256);
    expect(Object.values(replay.pages).every(pages => pages === 0)).toBe(true);
    expect(await xmins(main.ownerPrimary, relations)).toEqual(before);
    const text = JSON.stringify(receipts.legacy);
    for (const id of [world.fixture.ids.participant, history.contributions[0].id, "telemetry/", "occurrence-"]) {
      expect(text.includes(id), "no id or key in the receipt").toBe(false);
    }
  }, 900_000);

  it("maps every pending registration once with its transfer hold, verifying rows a telemetry stage already mapped", async () => {
    const handle = handles.main;
    await expect(runPendingRegistrationsProduction({ handle, sealManifestPath: forged.manifestPath }))
      .rejects.toSatisfy(isCode("CUTOVER_STAGE_INCOMPLETE"));
    await stubTelemetryStages(handle);
    expect(await checkPendingObjectTransferGuard(handle))
      .toEqual({ check: "P13", guard: "transfer-holds-v1", holdTable: "present" });
    // A chunk-owned registration D-PT5A would map: equal, so verified, not duplicated.
    const chunkOwned = history.pending[1];
    await main.ownerPrimary.query(`INSERT INTO ${table("pending_objects")}
        (contribution_id, object_key, object_kind, registered_at, reconciliation_state, reconciliation_lease_id)
      VALUES ($1, $2, $3, $4, $5, $6)`, [chunkOwned.contribution_id, chunkOwned.r2_key, chunkOwned.object_kind,
      chunkOwned.registered_at, chunkOwned.reconciliation_state, chunkOwned.reconciliation_lease_id]);
    let killed = null;
    try {
      await runPendingRegistrationsProduction({ handle, sealManifestPath: forged.manifestPath, pageRows: 2,
        onPage: ({ page }) => {
          if (page === 1) throw new Error("synthetic kill after the first page");
        } });
    } catch (error) {
      killed = error;
    }
    expect(killed?.code).toBe("CUTOVER_LEGACY_TRANSFER_FAILED");
    expect(await count(main.ownerPrimary, "pending_object_transfer_holds")).toBe(2);
    receipts.pending = await runPendingRegistrationsProduction({ handle, sealManifestPath: forged.manifestPath, pageRows: 2 });
    expect(receipts.pending.registrations.rows).toBe(history.pending.length);
    expect(receipts.pending.guard).toBe("transfer-holds-v1");
    expect(receipts.pending.holds.rows).toBe(history.pending.length);

    const mapped = await main.ownerPrimary.query(`SELECT object_key, contribution_id, object_kind,
        to_char(registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at,
        reconciliation_state, reconciliation_lease_id, registration_token ~ '^[0-9a-f]{32}$' AS token
      FROM ${table("pending_objects")} ORDER BY object_key COLLATE "C"`);
    const expected = [...history.pending].sort((left, right) => (left.r2_key < right.r2_key ? -1 : 1)).map(row => ({
      object_key: row.r2_key, contribution_id: row.contribution_id, object_kind: row.object_kind,
      registered_at: new Date(row.registered_at).toISOString(), reconciliation_state: row.reconciliation_state,
      reconciliation_lease_id: row.reconciliation_lease_id, token: true }));
    expect(mapped.rows).toEqual(expected);
    expect(await count(main.ownerPrimary, "pending_quarantine_objects")).toBe(0);
    const holds = await main.ownerPrimary.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE released_at IS NULL)::int AS held,
        count(DISTINCT seal_sha256)::int AS seals, min(seal_sha256) AS seal FROM ${table("pending_object_transfer_holds")}`);
    expect(holds.rows).toEqual([{ n: 5, held: 5, seals: 1, seal: forged.sealId }]);

    const cleanHandle = handles.clean;
    await stubTelemetryStages(cleanHandle);
    const cleanReceipt = await runPendingRegistrationsProduction({ handle: cleanHandle, sealManifestPath: forged.manifestPath,
      pageRows: 3 });
    expect(cleanReceipt.receiptSha256).toBe(receipts.pending.receiptSha256);
    expect([cleanReceipt.premapped, cleanReceipt.inserted]).toEqual([0, history.pending.length]);

    const relations = [table("pending_objects"), table("pending_object_transfer_holds"),
      "tibotattle_transfer.transfer_stage_receipts", "tibotattle_transfer.transfer_table_receipts",
      "tibotattle_transfer.transfer_checkpoints"];
    const before = await xmins(main.ownerPrimary, relations);
    const replay = await runPendingRegistrationsProduction({ handle, sealManifestPath: forged.manifestPath });
    expect(replay.receiptSha256).toBe(receipts.pending.receiptSha256);
    expect([replay.pages, replay.premapped, replay.inserted]).toEqual([0, 0, 0]);
    expect(await xmins(main.ownerPrimary, relations)).toEqual(before);
    expect(JSON.stringify(receipts.pending).includes("telemetry/")).toBe(false);
  }, 600_000);

  it("maps admin metric snapshots and imports aggregate exclusions under post-import", async () => {
    const handle = handles.main;
    receipts.operational = await runOperationalHistoryProduction({ handle, sealManifestPath: forged.manifestPath, pageRows: 2 });
    const cleanReceipt = await runOperationalHistoryProduction({ handle: handles.clean, sealManifestPath: forged.manifestPath });
    expect(cleanReceipt.receiptSha256).toBe(receipts.operational.receiptSha256);
    const { adminMetricHistory, exclusions } = receipts.operational;
    expect(adminMetricHistory.sealedSnapshots.rows).toBe(3);
    expect(adminMetricHistory.cache).toMatchObject({ state: "valid", rows: 1, snapshotsAdded: 1 });
    expect(adminMetricHistory.mapped.rows).toBe(4);
    expect(exclusions).toMatchObject({ sealed: { rows: 2 }, imported: { rows: 1 }, participantAbsent: 1 });

    const sourceId = sealedDb.prepare("SELECT source_id FROM storage_source_state").get().source_id;
    const snapshots = await main.ownerPrimary.query(`SELECT source_id,
        to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at, metrics_json
      FROM ${table("analytics_admin_metric_snapshots")} ORDER BY captured_at`);
    expect(snapshots.rows).toEqual([
      { source_id: sourceId, captured_at: history.cacheOnly.capturedAt, metrics_json: JSON.stringify(history.cacheOnly.metrics) },
      ...history.snapshots.map(row => ({ source_id: sourceId, captured_at: row.captured_at, metrics_json: row.metrics_json })),
    ]);
    const excluded = await main.ownerPrimary.query(`SELECT exclusion_id, participant_id, state FROM ${table("community_aggregate_exclusions")}`);
    expect(excluded.rows).toEqual([{ exclusion_id: "exclusion-active", participant_id: world.fixture.ids.participant,
      state: "active" }]);
    await expect(main.ownerPrimary.query(`DELETE FROM ${table("community_aggregate_exclusions")}`))
      .rejects.toMatchObject({ code: "P1005", message: "community_aggregate_exclusion_append_only" });
    const operationalReceipts = await main.ownerPrimary.query(`SELECT source_table, disposition, target_table, state,
        source_row_count::int AS source_rows, target_row_count::int AS target_rows
      FROM tibotattle_transfer.transfer_table_receipts WHERE stage = 'post-import' ORDER BY source_table`);
    expect(operationalReceipts.rows).toEqual([
      { source_table: "admin_metric_snapshots", disposition: "mapped:admin-metrics-history",
        target_table: "analytics_admin_metric_snapshots", state: "complete", source_rows: 3, target_rows: 4 },
      { source_table: "admin_metrics_history_cache", disposition: "mapped:admin-metrics-history",
        target_table: "analytics_admin_metric_snapshots", state: "complete", source_rows: 1, target_rows: 1 },
      { source_table: "community_aggregate_exclusions", disposition: "imported:community-aggregate-exclusions",
        target_table: "community_aggregate_exclusions", state: "complete", source_rows: 2, target_rows: 1 },
    ]);
    // PT-8-lite owns the post-import stage receipt; this runner writes none.
    const stage = await main.ownerPrimary.query(`SELECT count(*)::int AS n FROM tibotattle_transfer.transfer_stage_receipts
      WHERE stage = 'post-import'`);
    expect(stage.rows[0].n).toBe(0);

    const relations = [table("analytics_admin_metric_snapshots"), table("community_aggregate_exclusions"),
      "tibotattle_transfer.transfer_table_receipts", "tibotattle_transfer.transfer_checkpoints"];
    const before = await xmins(main.ownerPrimary, relations);
    const replay = await runOperationalHistoryProduction({ handle, sealManifestPath: forged.manifestPath });
    expect(replay.receiptSha256).toBe(receipts.operational.receiptSha256);
    expect(await xmins(main.ownerPrimary, relations)).toEqual(before);
    const text = JSON.stringify(receipts.operational);
    for (const value of [world.fixture.ids.participant, sourceId, "exclusion-active"]) {
      expect(text.includes(value), "no id in the receipt").toBe(false);
    }
  }, 600_000);

  it("the reconciler never touches a held registration; a PT-7 release lets it reconcile; holds are one-way", async () => {
    const pool = main.ownerPrimary;
    const nowEpoch = Date.now() + 5 * DAY;
    const store = syntheticObjectStore();
    const options = { schema: SCHEMAS, nowEpoch, safetyWindowMilliseconds: HOUR, maximumRegistrations: 50 };
    // A fresh, unheld aged orphan registration reconciles as before.
    const fresh = { key: `telemetry/${randomUUID()}`, id: `contribution:${randomUUID()}` };
    await pool.query(`INSERT INTO ${table("pending_objects")} (contribution_id, object_key, object_kind, registered_at)
      VALUES ($1, $2, 'telemetry', $3)`, [fresh.id, fresh.key, new Date(nowEpoch - 3 * HOUR).toISOString()]);
    const state = async () => (await pool.query(`SELECT object_key, reconciliation_state, reconciliation_lease_id
      FROM ${table("pending_objects")} ORDER BY object_key COLLATE "C"`)).rows;
    const heldBefore = (await state()).filter(row => row.object_key !== fresh.key);

    const first = await reconcilePostgresPendingObjects(pool, store, options);
    expect(first).toMatchObject({ registrationsExamined: 1, deletionGraceStarted: 1, candidatesDeferred: 0, hasMore: false });
    const second = await reconcilePostgresPendingObjects(pool, store, { ...options, nowEpoch: nowEpoch + 2 * HOUR });
    expect(second).toMatchObject({ registrationsExamined: 1, orphanObjectsAlreadyAbsent: 1, candidatesDeferred: 0, hasMore: false });
    expect(store.calls.head).toEqual([fresh.key]);
    expect((await state()).filter(row => row.object_key !== fresh.key)).toEqual(heldBefore);
    expect((await state()).some(row => row.object_key === fresh.key)).toBe(false);

    // PT-7 releases two holds with its receipt digest: one-way and idempotent.
    const released = history.pending.slice(0, 2).map(row => row.r2_key);
    const receipt = sha("synthetic-pt7-receipt");
    expect(await releasePostgresPendingObjectTransferHolds(pool, { schema: SCHEMAS, objectKeys: released,
      releaseReceiptSha256: receipt })).toEqual({ released: 2, alreadyReleased: 0, unknown: 0 });
    expect(await releasePostgresPendingObjectTransferHolds(pool, { schema: SCHEMAS,
      objectKeys: [...released, `telemetry/${randomUUID()}`], releaseReceiptSha256: sha("other") }))
      .toEqual({ released: 0, alreadyReleased: 2, unknown: 1 });
    const kept = await pool.query(`SELECT count(*)::int AS n FROM ${table("pending_object_transfer_holds")}
      WHERE release_receipt_sha256 = $1`, [receipt]);
    expect(kept.rows[0].n).toBe(2);
    const third = await reconcilePostgresPendingObjects(pool, store, { ...options, nowEpoch: nowEpoch + 3 * HOUR });
    expect(third).toMatchObject({ registrationsExamined: 2, deletionGraceStarted: 2, candidatesDeferred: 0 });
    const fourth = await reconcilePostgresPendingObjects(pool, store, { ...options, nowEpoch: nowEpoch + 5 * HOUR });
    expect(fourth).toMatchObject({ registrationsExamined: 2, orphanObjectsAlreadyAbsent: 2, candidatesDeferred: 0 });
    expect(new Set(store.calls.head)).toEqual(new Set([fresh.key, ...released]));
    expect(await count(pool, "pending_objects")).toBe(history.pending.length - 2);

    for (const sql of [`DELETE FROM ${table("pending_object_transfer_holds")}`,
      `UPDATE ${table("pending_object_transfer_holds")} SET released_at = NULL, release_receipt_sha256 = NULL
        WHERE released_at IS NOT NULL`,
      `UPDATE ${table("pending_object_transfer_holds")} SET seal_sha256 = '${"0".repeat(64)}'`]) {
      await expect(pool.query(sql)).rejects.toMatchObject({ code: "P1005", message: "pending_object_transfer_hold_immutable" });
    }
  }, 600_000);

  it("without the hold table P13 and the stage refuse unless the owner accepts orphan-registration clearing; a differing mapped row conflicts", async () => {
    const handle = handles.bare;
    await runIdentityAuthorityTransfer({ handle, sealManifestPath: forged.manifestPath, identityLinkPin: PIN });
    await runLegacyContributionsProduction({ handle, sealManifestPath: forged.manifestPath });
    await stubTelemetryStages(handle);
    await expect(checkPendingObjectTransferGuard(handle)).rejects.toSatisfy(isCode("CUTOVER_PENDING_OBJECT_GUARD_MISSING"));
    await expect(runPendingRegistrationsProduction({ handle, sealManifestPath: forged.manifestPath }))
      .rejects.toSatisfy(isCode("CUTOVER_PENDING_OBJECT_GUARD_MISSING"));
    const flags = [OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING];
    expect(await checkPendingObjectTransferGuard(handle, { ownerFlags: flags }))
      .toEqual({ check: "P13", guard: "owner-accepted-clearing", holdTable: "absent" });
    await expect(checkPendingObjectTransferGuard(handle, { ownerFlags: ["some-other-flag"] }))
      .rejects.toSatisfy(isCode("CUTOVER_LEGACY_ARGUMENT_INVALID"));

    const differing = history.pending[3];
    await bare.ownerPrimary.query(`INSERT INTO ${table("pending_objects")} (contribution_id, object_key, object_kind, registered_at)
      VALUES ($1, $2, 'telemetry', $3)`, [differing.contribution_id, differing.r2_key, new Date().toISOString()]);
    // A differing row for a sealed key refuses inside the page transaction: nothing commits.
    await expect(runPendingRegistrationsProduction({ handle, sealManifestPath: forged.manifestPath, ownerFlags: flags }))
      .rejects.toSatisfy(isCode("CUTOVER_PENDING_OBJECT_CONFLICT"));
    expect(await count(bare.ownerPrimary, "pending_objects")).toBe(1);
    await bare.ownerPrimary.query(`DELETE FROM ${table("pending_objects")}`);
    // An extra row outside the sealed set fails the completion mapping proof
    // after the pages committed; removing it lets the resumed stage complete.
    const extra = `telemetry/${randomUUID()}`;
    await bare.ownerPrimary.query(`INSERT INTO ${table("pending_objects")} (contribution_id, object_key, object_kind, registered_at)
      VALUES ($1, $2, 'telemetry', $3)`, [`contribution:${randomUUID()}`, extra, new Date().toISOString()]);
    await expect(runPendingRegistrationsProduction({ handle, sealManifestPath: forged.manifestPath, ownerFlags: flags }))
      .rejects.toSatisfy(isCode("CUTOVER_PENDING_OBJECT_CONFLICT"));
    expect(await count(bare.ownerPrimary, "pending_objects")).toBe(history.pending.length + 1);
    await bare.ownerPrimary.query(`DELETE FROM ${table("pending_objects")} WHERE object_key = $1`, [extra]);
    const accepted = await runPendingRegistrationsProduction({ handle, sealManifestPath: forged.manifestPath, ownerFlags: flags });
    expect(accepted).toMatchObject({ guard: "owner-accepted-clearing", holds: null });
    expect(accepted.receiptSha256).not.toBe(receipts.pending.receiptSha256);
    expect(await count(bare.ownerPrimary, "pending_objects")).toBe(history.pending.length);
  }, 900_000);
});
