import { randomUUID } from "node:crypto";
import pg from "pg";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CutoverSourceError, readCutoverSeal } from "../scripts/cutover-source-seal.mjs";
import { runIdentityAuthorityTransfer } from "../scripts/postgres-identity-authority-transfer.mjs";
import {
  PRODUCTION_RETAINED_RELATIONS,
  PRODUCTION_STAGING_RELATIONS,
  TELEMETRY_PRODUCTION_DISPOSITIONS,
  TELEMETRY_PRODUCTION_RUNNERS,
  TELEMETRY_PRODUCTION_STAGES,
  TELEMETRY_PRODUCTION_TRIGGER_POLICY,
  readChunkRegistrationReceipts,
} from "../scripts/postgres-production-telemetry-modes.mjs";
import { TelemetryProductionError } from "../scripts/postgres-production-telemetry-engine.mjs";
import {
  PostgresTransferTargetError,
  TRANSFER_STAGES,
  abandonRun,
  advanceRun,
  beginRun,
  stageReceipt,
  withTransferTransaction,
} from "../scripts/postgres-transfer-target.mjs";
import {
  createSealedSqliteTypedLegacyRehearsalSource,
  runPostgresTypedLegacyTransfer,
} from "../scripts/postgres-typed-legacy-transfer.mjs";
import {
  openSealedFastpathIdentitySource,
  runPostgresFastpathIdentityCopy,
  runPostgresFastpathTransportCopy,
} from "../scripts/postgres-fastpath-identity-copy.mjs";
import { createSealedSqliteUsageCorrectionSource, runPostgresUsageCorrectionTransfer } from "../scripts/postgres-usage-correction-transfer.mjs";
import { createSealedSqliteV12RehearsalSource, runPostgresV12Transfer } from "../scripts/postgres-v12-transfer.mjs";
import { createSealedSqliteIngestionJournalSource, transferPostgresIngestionJournal } from "../scripts/postgres-ingestion-journal-transfer.mjs";
import { projectIngestionJournal } from "../scripts/cutover-source-projections.mjs";
import { openSealedSourceFromSeal } from "../scripts/cutover-source-seal.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { createW2SealCluster, PRIMARY_SCHEMA } from "./fixtures/w2-seal/pg-target.mjs";
import { forgeVariantSeal, headCommit, outputPathsOf, prepareSealWorld, sealWorld } from "./fixtures/w2-seal/seal-harness.mjs";
import {
  SYNTHETIC_IDENTITY_LINK_SECRET,
  SYNTHETIC_IDENTITY_LINK_VERSION,
  identityLinkFingerprint,
} from "./fixtures/w2-seal/synthetic-sources.mjs";

// D-PT5A acceptance on PostgreSQL 17: the eight telemetry stages in PT-1
// production target mode over a synthetic PT-2-lite seal of the Q-1 corpus,
// after PT-3. Everything is local and synthetic; secrets are fixture constants.

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIN = Object.freeze({ keyVersion: SYNTHETIC_IDENTITY_LINK_VERSION,
  secretFingerprint: identityLinkFingerprint(SYNTHETIC_IDENTITY_LINK_SECRET) });
const table = name => `"${PRIMARY_SCHEMA}"."${name}"`;
const OWNED_TARGETS = Object.freeze(Object.keys(TELEMETRY_PRODUCTION_TRIGGER_POLICY).sort());

const isCode = code => error => (error instanceof TelemetryProductionError || error instanceof PostgresTransferTargetError
  || error instanceof CutoverSourceError) && error.code === code;

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

async function versions(pool, names) {
  const result = {};
  for (const name of names) {
    result[name] = (await pool.query(`SELECT count(*)::int AS n,
        md5(coalesce(string_agg(xmin::text || ':' || ctid::text, ',' ORDER BY ctid), '')) AS xmins FROM ${table(name)}`)).rows[0];
  }
  for (const relation of ["transfer_runs", "transfer_stage_receipts", "transfer_table_receipts", "transfer_checkpoints"]) {
    result[`tibotattle_transfer.${relation}`] = (await pool.query(`SELECT count(*)::int AS n,
        md5(coalesce(string_agg(xmin::text || ':' || ctid::text, ',' ORDER BY ctid), '')) AS xmins
        FROM tibotattle_transfer.${relation}`)).rows[0];
  }
  return result;
}

describe.skipIf(!PG_TEST_SOCKET)("D-PT5A telemetry production stages on PostgreSQL 17", () => {
  let world;
  let seal;
  let manifestPath;
  let cluster;
  let targets;
  let sealedDb;
  let chainA;
  let chainB;
  let handleA;

  beforeAll(async () => {
    const commit = headCommit(WORKER_ROOT);
    world = await prepareSealWorld({ commit });
    const run = await sealWorld(world);
    const result = await run.run();
    manifestPath = outputPathsOf(run.out).manifest;
    seal = await readCutoverSeal({ manifestPath, expectedSealId: result.sealId });
    sealedDb = new DatabaseSync(seal.sources.ingestion.path, { readOnly: true });
    cluster = await createW2SealCluster({ socket: PG_TEST_SOCKET, port: PG_TEST_PORT, user: PG_TEST_USER,
      password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE, count: 6, label: "ptfive" });
    targets = cluster.targets;
  }, 900_000);

  afterAll(async () => {
    sealedDb?.close();
    await cluster?.dispose();
    await world?.dispose();
  });

  async function beginImporting(selectedTarget, sealId, sealedAt) {
    const handle = await selectedTarget.open(sealId);
    await beginRun(handle, { sealedAt });
    await advanceRun(handle, "importing");
    return handle;
  }

  async function identityStage(handle, path = manifestPath) {
    return runIdentityAuthorityTransfer({ handle, sealManifestPath: path, identityLinkPin: PIN });
  }

  async function chain(handle, path = manifestPath, options = {}) {
    const results = {};
    for (const stage of TELEMETRY_PRODUCTION_STAGES) {
      results[stage] = await TELEMETRY_PRODUCTION_RUNNERS[stage]({ handle, sealManifestPath: path, ...options });
    }
    return results;
  }

  async function killAt(stage, handle, options, predicate) {
    let killed = null;
    try {
      await TELEMETRY_PRODUCTION_RUNNERS[stage]({ handle, sealManifestPath: manifestPath, ...options,
        ...predicate });
    } catch (error) {
      killed = error;
    }
    expect(killed?.message, `${stage} kill`).toBe("CUTOVER_TELEMETRY_TRANSFER_FAILED");
  }

  it("imports every table to the sealed digest and resumes a run killed at page and step boundaries byte-identically", async () => {
    const sealedAt = seal.manifest.createdAt;
    handleA = await beginImporting(targets[0], seal.manifest.sealId, sealedAt);
    await identityStage(handleA);

    // Kill after a committed page, resume on a fresh handle (and, for one,
    // with a different page size: the prefix chain is per row).
    const kills = [
      ["telemetry-v1-v11", "telemetry_v11_chunks", 3, 768, {}],
      ["typed-legacy", "typed_telemetry_records", 5, 1280, { pageRows: 100 }],
    ];
    let handle = handleA;
    const resumedRuns = {};
    for (const [stage, tableName, page, committed, resumeOptions] of kills) {
      // The earlier stages of the chain complete first.
      for (const earlier of TELEMETRY_PRODUCTION_STAGES.slice(0, TELEMETRY_PRODUCTION_STAGES.indexOf(stage))) {
        await TELEMETRY_PRODUCTION_RUNNERS[earlier]({ handle, sealManifestPath: manifestPath });
      }
      await killAt(stage, handle, {}, { onPage: ({ table: name, page: number }) => {
        if (name === tableName && number === page) throw new Error("synthetic kill at a page boundary");
      } });
      const pending = await targets[0].ownerPrimary.query(`SELECT state, row_count::int AS rows, last_key
        FROM tibotattle_transfer.transfer_checkpoints WHERE checkpoint_name = $1`, [`table:${tableName}`]);
      expect(pending.rows).toEqual([{ state: "pending", rows: committed, last_key: null }]);
      expect(await count(targets[0].ownerPrimary, tableName)).toBe(committed);
      handle = await targets[0].open(seal.manifest.sealId);
      expect(handle.resumed).toBe(true);
      resumedRuns[stage] = await TELEMETRY_PRODUCTION_RUNNERS[stage]({ handle, sealManifestPath: manifestPath, ...resumeOptions });
    }
    handleA = handle;
    // Kills inside the later stages: a seeded-row rewrite, the ready-manifest promotion step, a chunk-registration step.
    for (const earlier of ["legacy-admission", "header-promotion"]) {
      await TELEMETRY_PRODUCTION_RUNNERS[earlier]({ handle: handleA, sealManifestPath: manifestPath });
    }
    await killAt("telemetry-v12", handleA, {}, { onPage: ({ table: name }) => {
      if (name === "telemetry_v12_runtime") throw new Error("synthetic kill after the seeded-row rewrite");
    } });
    handleA = await targets[0].open(seal.manifest.sealId);
    await killAt("telemetry-v12", handleA, {}, { onPage: ({ table: name }) => {
      if (name === "promote-ready-manifests") throw new Error("synthetic kill after the promotion page");
    } });
    handleA = await targets[0].open(seal.manifest.sealId);
    const staged = await targets[0].ownerPrimary.query(`SELECT count(*)::int AS ready FROM ${table("telemetry_v12_day_manifests")}
      WHERE state = 'ready'`);
    expect(staged.rows[0].ready).toBe(170);
    await killAt("telemetry-v12", handleA, {}, { onStep: ({ step }) => {
      if (step === "chunk-registrations") throw new Error("synthetic kill between steps");
    } });
    handleA = await targets[0].open(seal.manifest.sealId);
    chainA = {};
    for (const stage of TELEMETRY_PRODUCTION_STAGES) {
      chainA[stage] = await TELEMETRY_PRODUCTION_RUNNERS[stage]({ handle: handleA, sealManifestPath: manifestPath });
    }

    // A clean run in a second target with other page sizes reproduces every receipt and digest.
    const cleanHandle = await beginImporting(targets[1], seal.manifest.sealId, sealedAt);
    await identityStage(cleanHandle);
    chainB = await chain(cleanHandle, manifestPath, { pageRows: 97, pageBytes: 64 * 1024 });

    for (const stage of TELEMETRY_PRODUCTION_STAGES) {
      expect(chainA[stage].receiptSha256, stage).toBe(chainB[stage].receiptSha256);
      expect(chainA[stage].tables, stage).toEqual(chainB[stage].tables);
      expect(chainA[stage].order).toEqual(chainB[stage].order);
      for (const [name, facts] of Object.entries(chainA[stage].tables)) {
        expect(facts.targetRows, name).toBe(facts.sourceRows);
      }
    }
    // The resumed run wrote only the pages after the kill (100-row pages: 1280 rows were committed); the clean run all of them.
    expect(resumedRuns["typed-legacy"].pages.typed_telemetry_records).toBe(Math.ceil((11183 - 1280) / 100));
    expect(resumedRuns["typed-legacy"].receiptSha256).toBe(chainB["typed-legacy"].receiptSha256);
    expect(resumedRuns["telemetry-v1-v11"].pages.telemetry_v11_chunks).toBe(Math.ceil((1530 - 768) / 256));
    expect(chainB["typed-legacy"].pages.typed_telemetry_records).toBe(Math.ceil(11183 / 97));
    const digestsA = await tableTextDigests(targets[0].ownerPrimary, OWNED_TARGETS);
    const digestsB = await tableTextDigests(targets[1].ownerPrimary, OWNED_TARGETS);
    expect(digestsA).toEqual(digestsB);
    for (const stage of TELEMETRY_PRODUCTION_STAGES) {
      const receipts = await targets[0].ownerPrimary.query(`SELECT state, receipt_sha256 FROM tibotattle_transfer.transfer_stage_receipts
        WHERE stage = $1`, [stage]);
      expect(receipts.rows).toEqual([{ state: "complete", receipt_sha256: chainA[stage].receiptSha256 }]);
    }
  }, 900_000);

  it("writes one table receipt per owned table with exactly the exported disposition and equal digests", async () => {
    const receipts = await targets[0].ownerPrimary.query(`SELECT stage, source_role, source_table, disposition, target_table, state,
        source_row_count::int AS source_rows, source_sha256, target_row_count::int AS target_rows, target_sha256
      FROM tibotattle_transfer.transfer_table_receipts WHERE stage = ANY($1::text[]) ORDER BY source_table`,
    [[...TELEMETRY_PRODUCTION_STAGES]]);
    const byTable = new Map(receipts.rows.map(row => [row.source_table, row]));
    expect(receipts.rows).toHaveLength(TELEMETRY_PRODUCTION_DISPOSITIONS.length);
    for (const item of TELEMETRY_PRODUCTION_DISPOSITIONS) {
      const row = byTable.get(item.table);
      expect(row, item.table).toBeDefined();
      expect(row).toMatchObject({ stage: item.stage, source_role: item.role, disposition: item.token, state: "complete" });
      expect(row.target_table, item.table).toBe(item.target);
      const sealedRows = Number(sealedDb.prepare(`SELECT count(*) AS n FROM "${item.table}"`).get().n);
      expect(row.source_rows, item.table).toBe(sealedRows);
      if (item.target !== null) {
        expect(row.target_rows, item.table).toBe(sealedRows);
        expect(row.source_sha256, item.table).toBe(row.target_sha256);
      } else {
        expect(row.target_rows).toBeNull();
        expect(row.target_sha256).toBeNull();
      }
    }
    expect(TRANSFER_STAGES.length).toBe(19);
    // No staging or mirror relation was created, and the control schema holds only its frozen relations.
    expect(PRODUCTION_STAGING_RELATIONS).toEqual([]);
    expect(PRODUCTION_RETAINED_RELATIONS).toEqual([]);
    const relations = await targets[0].ownerPrimary.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'tibotattle_transfer'::regnamespace
      AND c.relkind IN ('r', 'p') ORDER BY 1`);
    expect(relations.rows.map(row => row.relname)).toEqual(["sealed_collection_controls", "transfer_checkpoints",
      "transfer_control_installations", "transfer_dropped_relations", "transfer_object_erasures", "transfer_object_receipts",
      "transfer_runs", "transfer_stage_receipts", "transfer_table_receipts", "transfer_target_contract"]);
    expect(await count(targets[0].ownerPrimary, "historical_telemetry_v1_chunk_headers")).toBe(0);
    expect(await count(targets[0].ownerPrimary, "historical_transport_header_imports")).toBe(0);
    const cursors = await targets[0].ownerPrimary.query("SELECT count(*)::int AS n FROM tibotattle_transfer.transfer_checkpoints WHERE last_key IS NOT NULL");
    expect(cursors.rows[0].n).toBe(0);
  });

  it("returns content-free evidence: no sealed id, key or digest of a participant leaves the importers", () => {
    const text = JSON.stringify(chainA);
    const sensitive = [
      ...sealedDb.prepare("SELECT id FROM participants").all().map(row => row.id),
      ...sealedDb.prepare("SELECT r2_key AS v FROM telemetry_v11_chunks LIMIT 50").all().map(row => row.v),
      ...sealedDb.prepare("SELECT device_id AS v FROM telemetry_v11_domains").all().map(row => row.v),
      ...sealedDb.prepare("SELECT owner_digest AS v FROM storage_v11_event_sources").all().map(row => row.v),
      ...sealedDb.prepare("SELECT source_id AS v FROM storage_source_state").all().map(row => row.v),
    ];
    expect(sensitive.length).toBeGreaterThan(10);
    for (const value of sensitive) expect(text.includes(String(value)), "no sealed value in a result").toBe(false);
    expect(text).not.toMatch(/participant:/u);
    expect(text).not.toMatch(/synthetic-oracle-/u);
  });

  it("keeps every trigger enabled, leaves derived and runtime-reset state at its seed and derives the sealed owner heads", async () => {
    const pool = targets[0].ownerPrimary;
    const disabled = await pool.query(`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal AND t.tgenabled <> 'O'`, [PRIMARY_SCHEMA]);
    expect(disabled.rows[0].n).toBe(0);
    // The suppressed live-path triggers wrote nothing: PT-3's input versions stay at revision 0, the analytics seed rows and
    // the derived tables are untouched.
    expect(await count(pool, "input_versions", "WHERE revision <> 0")).toBe(0);
    expect(await count(pool, "input_source_digests")).toBe(0);
    expect(await count(pool, "telemetry_v1_quota_fit_rows")).toBe(0);
    const seed = await pool.query(`SELECT mutation_epoch::int AS epoch FROM ${table("mutation_control")}`);
    expect(seed.rows).toEqual([{ epoch: 0 }]);
    // The journal imported exactly, and its derivation triggers produced the sealed owner heads.
    expect(await count(pool, "storage_ingestion_changes")).toBe(Number(sealedDb.prepare("SELECT count(*) AS n FROM storage_ingestion_changes").get().n));
    const sealedHeads = sealedDb.prepare("SELECT owner_digest, revision, authority_epoch, state FROM storage_owner_revisions ORDER BY owner_digest").all()
      .map(row => [row.owner_digest, String(row.revision), String(row.authority_epoch), row.state]);
    const heads = await pool.query(`SELECT owner_digest, revision::text AS revision, authority_epoch::text AS authority_epoch, state
      FROM ${table("storage_owner_revisions")} ORDER BY owner_digest COLLATE "C"`);
    expect(heads.rows.map(row => [row.owner_digest, row.revision, row.authority_epoch, row.state])).toEqual(sealedHeads);
    const sourceState = await pool.query(`SELECT source_id, authority_epoch::text AS epoch FROM ${table("storage_source_state")}`);
    const sealedState = sealedDb.prepare("SELECT source_id, authority_epoch FROM storage_source_state").get();
    expect(sourceState.rows).toEqual([{ source_id: sealedState.source_id, epoch: String(sealedState.authority_epoch) }]);
    // The runtimes carry the sealed state; PostgreSQL's usage-correction runtime stays operationally staged.
    const sealedRuntime = sealedDb.prepare("SELECT * FROM telemetry_v12_runtime").get();
    const typed = await pool.query(`SELECT state, policy_revision::int AS revision, changed_at FROM ${table("telemetry_v12_typed_runtime")}`);
    expect(typed.rows[0]).toMatchObject({ state: sealedRuntime.state, revision: Number(sealedRuntime.policy_revision) });
    const transport = await pool.query(`SELECT state, revision::int AS revision FROM ${table("telemetry_v12_runtime")}`);
    expect(transport.rows).toEqual([{ state: sealedRuntime.state, revision: Number(sealedRuntime.policy_revision) - 1 }]);
    const correction = await pool.query(`SELECT state, source_state FROM ${table("telemetry_usage_correction_runtime")}`);
    expect(correction.rows).toEqual([{ state: "staged", source_state: sealedDb.prepare("SELECT state FROM telemetry_usage_correction_runtime").get().state }]);
    // Every ready manifest was promoted by the reviewed transition; staged ones stayed staged.
    const manifests = await pool.query(`SELECT state, count(*)::int AS n FROM ${table("telemetry_v12_day_manifests")} GROUP BY state ORDER BY state`);
    const sealedManifests = sealedDb.prepare("SELECT state, count(*) AS n FROM telemetry_v12_day_manifests GROUP BY state ORDER BY state").all();
    expect(manifests.rows).toEqual(sealedManifests.map(row => ({ state: row.state, n: Number(row.n) })));
    // Next identity ids exceed every imported id, so a live insert after the cutover cannot collide.
    for (const name of ["typed_telemetry_records", "typed_telemetry_chunks", "typed_telemetry_dictionary", "telemetry_v12_typed_records"]) {
      const sequence = (await pool.query("SELECT pg_get_serial_sequence($1, 'id') AS s", [`${PRIMARY_SCHEMA}.${name}`])).rows[0].s;
      const next = await pool.query(`SELECT last_value::bigint AS last, is_called FROM ${sequence}`);
      const max = (await pool.query(`SELECT COALESCE(max(id), 0)::bigint AS m FROM ${table(name)}`)).rows[0].m;
      expect(BigInt(next.rows[0].last) >= BigInt(max), name).toBe(true);
    }
  });

  it("replays every finished stage without writing: row versions, receipts and checkpoints keep their xmin", async () => {
    const pool = targets[0].ownerPrimary;
    const names = [...OWNED_TARGETS, "pending_objects", "input_versions"];
    const before = await versions(pool, names);
    for (const stage of TELEMETRY_PRODUCTION_STAGES) {
      const replay = await TELEMETRY_PRODUCTION_RUNNERS[stage]({ handle: handleA, sealManifestPath: manifestPath });
      expect(replay.receiptSha256, stage).toBe(chainA[stage].receiptSha256);
      expect(Object.values(replay.pages).every(pages => pages === 0), `${stage} wrote no page`).toBe(true);
    }
    expect(await versions(pool, names)).toEqual(before);
  }, 600_000);

  it("brings the run to 'verified' with the other stages complete: the control schema holds only its frozen relations", async () => {
    const mine = new Set(TELEMETRY_PRODUCTION_STAGES);
    await withTransferTransaction(handleA, "primary", async client => {
      for (const stage of TRANSFER_STAGES) {
        if (mine.has(stage) || stage === "identity-authority") continue;
        await stageReceipt(client, handleA, { stage, state: "complete", rowCount: 0, byteCount: 0, receiptSha256: "0".repeat(64) });
      }
    });
    await advanceRun(handleA, "verifying");
    await advanceRun(handleA, "verified");
    await expect(TELEMETRY_PRODUCTION_RUNNERS["ingestion-journal"]({ handle: handleA, sealManifestPath: manifestPath }))
      .rejects.toSatisfy(isCode("CUTOVER_RUN_STATE_INVALID"));
  }, 600_000);

  it("refuses before any write unless the prerequisite stages are complete in this run", async () => {
    const handle = await beginImporting(targets[2], seal.manifest.sealId, seal.manifest.createdAt);
    const receiptsBefore = async () => (await targets[2].ownerPrimary.query("SELECT count(*)::int AS n FROM tibotattle_transfer.transfer_stage_receipts")).rows[0].n;
    for (const stage of TELEMETRY_PRODUCTION_STAGES) {
      await expect(TELEMETRY_PRODUCTION_RUNNERS[stage]({ handle, sealManifestPath: manifestPath }), stage)
        .rejects.toSatisfy(error => isCode("CUTOVER_STAGE_INCOMPLETE")(error) && error.stage === "identity-authority");
    }
    expect(await receiptsBefore()).toBe(0);
    await identityStage(handle);
    expect(await receiptsBefore()).toBe(1);
    // Out of order: each stage names the first missing prerequisite.
    const expectations = [["typed-legacy", "telemetry-v1-v11"], ["legacy-admission", "telemetry-v1-v11"], ["header-promotion", "telemetry-v1-v11"],
      ["telemetry-v12", "typed-legacy"], ["v12-event-sources", "telemetry-v12"], ["usage-correction", "typed-legacy"]];
    for (const [stage, missing] of expectations) {
      await expect(TELEMETRY_PRODUCTION_RUNNERS[stage]({ handle, sealManifestPath: manifestPath }), stage)
        .rejects.toSatisfy(error => isCode("CUTOVER_STAGE_INCOMPLETE")(error) && error.stage === missing);
    }
    expect(await receiptsBefore()).toBe(1);
    for (const name of ["typed_telemetry_records", "telemetry_v11_chunks", "storage_ingestion_changes", "telemetry_v12_typed_records"]) {
      expect(await count(targets[2].ownerPrimary, name), name).toBe(0);
    }
    // The journal stage needs only PT-3; a non-empty table of a stage that has not started refuses before its first write.
    await targets[2].adminPrimary.query(`INSERT INTO ${table("storage_source_state")}(singleton, source_id, authority_epoch) VALUES (1, 'stray', 1)`);
    await expect(TELEMETRY_PRODUCTION_RUNNERS["ingestion-journal"]({ handle, sealManifestPath: manifestPath }))
      .rejects.toSatisfy(isCode("CUTOVER_TARGET_ROW_COUNT_DIVERGED"));
    expect(await receiptsBefore()).toBe(1);
    expect(await count(targets[2].ownerPrimary, "storage_ingestion_changes")).toBe(0);
    await targets[2].adminPrimary.query(`DELETE FROM ${table("storage_source_state")}`);
    await TELEMETRY_PRODUCTION_RUNNERS["ingestion-journal"]({ handle, sealManifestPath: manifestPath });
    expect(await count(targets[2].ownerPrimary, "storage_ingestion_changes")).toBe(6);
    await abandonRun(handle);
  }, 600_000);

  it("refuses closed on a target whose layout or trigger inventory drifted from the reviewed policy, before any write", async () => {
    const admin = targets[3].adminPrimary;
    const owner = targets[3].ownerPrimary;
    const handle = await beginImporting(targets[3], seal.manifest.sealId, seal.manifest.createdAt);
    await identityStage(handle);
    const stages = async () => (await owner.query("SELECT count(*)::int AS n FROM tibotattle_transfer.transfer_stage_receipts")).rows[0].n;
    const baseline = await stages();
    // An extra NOT NULL column without a default: unmapped.
    await admin.query(`ALTER TABLE ${table("telemetry_v1_chunks")} ADD COLUMN synthetic_extra text NOT NULL`);
    await expect(TELEMETRY_PRODUCTION_RUNNERS["telemetry-v1-v11"]({ handle, sealManifestPath: manifestPath }))
      .rejects.toSatisfy(isCode("CUTOVER_COLUMN_UNMAPPED"));
    await admin.query(`ALTER TABLE ${table("telemetry_v1_chunks")} DROP COLUMN synthetic_extra`);
    // A column of the wrong type.
    await admin.query(`ALTER TABLE ${table("telemetry_v11_day_manifests")} ALTER COLUMN parser_version TYPE varchar(64)`);
    await expect(TELEMETRY_PRODUCTION_RUNNERS["telemetry-v1-v11"]({ handle, sealManifestPath: manifestPath }))
      .rejects.toSatisfy(isCode("CUTOVER_TARGET_COLUMN_MISMATCH"));
    await admin.query(`ALTER TABLE ${table("telemetry_v11_day_manifests")} ALTER COLUMN parser_version TYPE text`);
    // A trigger the policy does not name, and a named trigger that is gone.
    await admin.query(`CREATE FUNCTION ${table("synthetic_noop")}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER synthetic_extra_guard BEFORE INSERT ON ${table("telemetry_v1_chunks")}
      FOR EACH ROW EXECUTE FUNCTION ${table("synthetic_noop")}()`);
    await expect(TELEMETRY_PRODUCTION_RUNNERS["telemetry-v1-v11"]({ handle, sealManifestPath: manifestPath }))
      .rejects.toSatisfy(isCode("CUTOVER_TRIGGER_POLICY_MISSING"));
    await admin.query(`DROP TRIGGER synthetic_extra_guard ON ${table("telemetry_v1_chunks")}`);
    await admin.query(`DROP TRIGGER aa_analytical_insert ON ${table("telemetry_v1_chunks")}`);
    await expect(TELEMETRY_PRODUCTION_RUNNERS["telemetry-v1-v11"]({ handle, sealManifestPath: manifestPath }))
      .rejects.toSatisfy(isCode("CUTOVER_TRIGGER_POLICY_STALE"));
    expect(await stages()).toBe(baseline);
    expect(await count(owner, "telemetry_v11_chunks")).toBe(0);
    await abandonRun(handle);
  }, 600_000);

  it("detects target rows that drifted from the checkpoint or from the seal on resume and at completion", async () => {
    const admin = targets[4].adminPrimary;
    const handle = await beginImporting(targets[4], seal.manifest.sealId, seal.manifest.createdAt);
    await identityStage(handle);
    await TELEMETRY_PRODUCTION_RUNNERS["telemetry-v1-v11"]({ handle, sealManifestPath: manifestPath });
    // Kill in the middle of a table, then lose a committed row: the resume refuses.
    await killAt("typed-legacy", handle, {}, { onPage: ({ table: name, page }) => {
      if (name === "typed_telemetry_identifiers" && page === 2) throw new Error("synthetic kill");
    } });
    const resumed = await targets[4].open(seal.manifest.sealId);
    await admin.query("SET session_replication_role = replica");
    const client = await admin.connect();
    try {
      await client.query("SET session_replication_role = replica");
      await client.query(`DELETE FROM ${table("typed_telemetry_identifiers")} WHERE id = (SELECT min(id) FROM ${table("typed_telemetry_identifiers")})`);
    } finally {
      client.release();
    }
    await expect(TELEMETRY_PRODUCTION_RUNNERS["typed-legacy"]({ handle: resumed, sealManifestPath: manifestPath }))
      .rejects.toSatisfy(isCode("CUTOVER_TARGET_ROW_COUNT_DIVERGED"));
    await abandonRun(resumed);
    expect(await count(targets[4].ownerPrimary, "typed_telemetry_records")).toBe(0);
  }, 600_000);
});

/** SQL that augments the synthetic seal with the rows the Q-1 corpus leaves empty (all synthetic and content-free). */
function augmentationSql(database) {
  const one = sql => database.prepare(sql).get();
  const v1Chunk = one("SELECT id, r2_key, participant_id, device_id, stream, chunk_day, created_at FROM telemetry_v1_chunks ORDER BY id LIMIT 1");
  const v11Chunk = one("SELECT id, r2_key FROM telemetry_v11_chunks ORDER BY id LIMIT 1");
  const v12Chunk = one("SELECT id, r2_key FROM telemetry_v12_chunks ORDER BY id LIMIT 1");
  const domain = one("SELECT id, participant_id FROM telemetry_v11_domains ORDER BY id LIMIT 1");
  const withdrawn = one(`SELECT membership.participant_id AS participant_id FROM typed_v11_owner_memberships membership
    JOIN storage_v11_owner_links link ON link.participant_id = membership.participant_id WHERE link.state = 'active'
    ORDER BY membership.participant_id LIMIT 1`);
  const correction = one(`SELECT membership.participant_id AS participant_id, membership.typed_owner_id AS owner, link.owner_digest AS digest
    FROM typed_v1_owner_memberships membership JOIN storage_v11_owner_links link ON link.participant_id = membership.participant_id
    WHERE link.state = 'active' AND membership.participant_id <> ? ORDER BY membership.participant_id LIMIT 1`.replace("?", `'${withdrawn.participant_id}'`));
  const hex = Buffer.from(correction.digest, "hex");
  const zero = "zeroblob(32)";
  return `PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;
    INSERT INTO pending_quarantine_objects(r2_key, contribution_id, object_kind, registered_at, reconciliation_state, reconciliation_lease_id)
      VALUES ('${v1Chunk.r2_key}', '${v1Chunk.id}', 'telemetry', '2026-10-01T10:00:00.000Z', 'registered', NULL),
             ('${v11Chunk.r2_key}', '${v11Chunk.id}', 'telemetry', '2026-10-01T11:00:00.123Z', 'registered', NULL),
             ('${v12Chunk.r2_key}', '${v12Chunk.id}', 'telemetry', '2026-10-01T12:00:00.000Z', 'deleting', 'lease-synthetic-0001');
    INSERT INTO telemetry_v1_records(chunk_row_id, participant_id, device_id, stream, occurrence_id, observed_at, observed_day,
        provider, model_id, session_uuid, plan_type, plan_variant, limit_id, slot, used_percent, window_duration_minutes, resets_at,
        input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens, output_text_tokens, output_reasoning_tokens,
        output_combined_tokens, record_json)
      VALUES ('${v1Chunk.id}', '${v1Chunk.participant_id}', '${v1Chunk.device_id}', '${v1Chunk.stream}', 'occurrence-synthetic-0001',
        '${v1Chunk.created_at}', '${v1Chunk.chunk_day}', 'openai', 'model-synthetic', 'session-synthetic', 'pro', NULL, 'limit-synthetic',
        'primary', 12.5, 300, '2026-10-02T00:00:00Z', 10, 20, 30, 40, 50, 90, '{"b": 2, "a": [1, {"d": 4, "c": 3}]}');
    INSERT INTO storage_v11_append_transitions(generation_id, previous_generation_id, participant_id, head_revision, is_append, compared_records)
      VALUES ('${domain.id}', 'previous-generation-synthetic', '${domain.participant_id}', 2, 1, 7);
    UPDATE storage_v11_owner_links SET state = 'withdrawn' WHERE participant_id = '${withdrawn.participant_id}';
    INSERT INTO telemetry_usage_correction_history(id, participant_id, owner_digest, owner_revision, authority_epoch, source_format,
        namespace_id, owner_id, device_id, chunk_id, manifest_id, source_storage_row_id, source_row_id, occurrence_id, event_time_ms,
        provider_id, session_id, model_id, speed_mode_id, api_service_tier_id, surface_id, billing_surface_id, reasoning_effort_id,
        agent_scope_id, outcome_id, attribution_id, total_input_context_tokens, input_uncached_tokens, input_cache_read_tokens,
        input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens, source_chunk_digest,
        source_event_digest, record_digest, base_digest, captured_at_ms)
      VALUES (1, '${correction.participant_id}', X'${hex.toString("hex")}', 1, 1, 10, 1, ${correction.owner}, 1, 1, NULL, 1, 1, X'0102',
        1790000000000, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, NULL, 100, 40, 30, 20, 10, 5, 15, ${zero}, ${zero}, ${zero}, ${zero}, 1790000000001);
    INSERT INTO telemetry_usage_correction_facts(id, history_id, method_version, captured_at_ms) VALUES (1, 1, 1, 1790000000001);
    UPDATE telemetry_usage_correction_runtime SET state = 'staged';`;
}

describe.skipIf(!PG_TEST_SOCKET)("D-PT5A telemetry production stages over an augmented seal", () => {
  let world;
  let seal;
  let cluster;
  let forged;
  let forgedDb;
  let target;
  let handle;
  let results;

  function dropAllTriggers(path) {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN ('pending_quarantine_objects', 'telemetry_v1_records', 'storage_v11_append_transitions', 'storage_v11_owner_links', 'telemetry_usage_correction_history', 'telemetry_usage_correction_facts', 'telemetry_usage_correction_runtime')")
        .all().map(row => `DROP TRIGGER IF EXISTS "${row.name}";`).join("\n");
    } finally {
      database.close();
    }
  }

  beforeAll(async () => {
    world = await prepareSealWorld({ commit: headCommit(WORKER_ROOT) });
    const run = await sealWorld(world);
    const result = await run.run();
    const manifestPath = outputPathsOf(run.out).manifest;
    seal = await readCutoverSeal({ manifestPath, expectedSealId: result.sealId });
    const base = new DatabaseSync(seal.sources.ingestion.path, { readOnly: true });
    const sql = `${dropAllTriggers(seal.sources.ingestion.path)}\n${augmentationSql(base)}`;
    base.close();
    forged = await forgeVariantSeal(seal, sql);
    const forgedSeal = await readCutoverSeal({ manifestPath: forged.manifestPath, expectedSealId: forged.sealId });
    forgedDb = new DatabaseSync(forgedSeal.sources.ingestion.path, { readOnly: true });
    cluster = await createW2SealCluster({ socket: PG_TEST_SOCKET, port: PG_TEST_PORT, user: PG_TEST_USER,
      password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE, count: 1, label: "ptfiveaug" });
    target = cluster.targets[0];
    handle = await target.open(forged.sealId);
    await beginRun(handle, { sealedAt: forged.sealedAt });
    await advanceRun(handle, "importing");
    await runIdentityAuthorityTransfer({ handle, sealManifestPath: forged.manifestPath, identityLinkPin: PIN });
    results = {};
    for (const stage of TELEMETRY_PRODUCTION_STAGES) {
      results[stage] = await TELEMETRY_PRODUCTION_RUNNERS[stage]({ handle, sealManifestPath: forged.manifestPath });
    }
  }, 900_000);

  afterAll(async () => {
    forgedDb?.close();
    await cluster?.dispose();
    await world?.dispose();
  });

  it("imports the chunk-owned registrations verbatim with the family kind and records their receipts", async () => {
    const pool = target.ownerPrimary;
    const rows = await pool.query(`SELECT contribution_id, object_key, object_kind, reconciliation_state, reconciliation_lease_id,
        to_char(registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at FROM ${table("pending_objects")}
      ORDER BY object_kind`);
    const sealed = forgedDb.prepare(`SELECT registration.r2_key, registration.contribution_id, registration.registered_at,
        registration.reconciliation_state, registration.reconciliation_lease_id FROM pending_quarantine_objects registration`).all();
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.map(row => row.object_kind)).toEqual(["telemetry_v1", "telemetry_v11", "telemetry_v12"]);
    for (const row of rows.rows) {
      const match = sealed.find(item => item.contribution_id === row.contribution_id);
      expect(match, "a sealed registration").toBeDefined();
      expect([row.object_key, row.registered_at, row.reconciliation_state, row.reconciliation_lease_id])
        .toEqual([match.r2_key, match.registered_at, match.reconciliation_state, match.reconciliation_lease_id]);
    }
    expect(rows.rows.find(row => row.object_kind === "telemetry_v12")).toMatchObject({ reconciliation_state: "deleting",
      reconciliation_lease_id: "lease-synthetic-0001" });
    const receipts = await readChunkRegistrationReceipts(handle);
    expect(receipts.map(item => [item.stage, item.registrations])).toEqual([["telemetry-v1-v11", 2], ["telemetry-v12", 1]]);
    expect(results["telemetry-v1-v11"].steps["chunk-registrations"].registrations).toBe(2);
    expect(results["telemetry-v12"].steps["chunk-registrations"].registrations).toBe(1);
    // The reconciliation guard stayed enabled and the registrations did not leak a pending row elsewhere.
    expect(await count(pool, "pending_quarantine_objects")).toBe(0);
  });

  it("imports raw v1 records exactly, suppresses the quota-fit derivation and carries the append transitions", async () => {
    const pool = target.ownerPrimary;
    const record = await pool.query(`SELECT id::int AS id, used_percent, record_json::text AS record_json, resets_at IS NOT NULL AS resets
      FROM ${table("telemetry_v1_records")}`);
    expect(record.rows).toEqual([{ id: 1, used_percent: 12.5, record_json: "{\"a\": [1, {\"c\": 3, \"d\": 4}], \"b\": 2}", resets: true }]);
    expect(await count(pool, "telemetry_v1_quota_fit_rows")).toBe(0);
    expect(await count(pool, "storage_v11_append_transitions")).toBe(1);
    // The AUTOINCREMENT counter is honoured: the next live v1 record id exceeds the sealed one.
    const next = await pool.query(`SELECT last_value::bigint AS last, is_called FROM ${(await pool.query("SELECT pg_get_serial_sequence($1, 'id') AS s",
      [`${PRIMARY_SCHEMA}.telemetry_v1_records`])).rows[0].s}`);
    expect(BigInt(next.rows[0].last) >= 1n).toBe(true);
    expect(results["telemetry-v1-v11"].tables.telemetry_v1_records.sourceRows).toBe(1);
  });

  it("imports a withdrawn owner's typed memberships and event sources (history), and the correction evidence verbatim", async () => {
    const pool = target.ownerPrimary;
    const withdrawn = await pool.query(`SELECT participant_id FROM ${table("storage_v11_owner_links")} WHERE state = 'withdrawn'`);
    expect(withdrawn.rows).toHaveLength(1);
    const memberships = await pool.query(`SELECT count(*)::int AS n FROM ${table("typed_telemetry_owner_memberships")} WHERE participant_id = $1`,
      [withdrawn.rows[0].participant_id]);
    expect(memberships.rows[0].n).toBeGreaterThan(0);
    expect(await count(pool, "typed_telemetry_owner_memberships")).toBe(5);
    expect(await count(pool, "telemetry_usage_correction_history")).toBe(1);
    expect(await count(pool, "telemetry_usage_correction_facts")).toBe(1);
    const runtime = await pool.query(`SELECT state, source_state FROM ${table("telemetry_usage_correction_runtime")}`);
    expect(runtime.rows).toEqual([{ state: "staged", source_state: "staged" }]);
    expect(results["usage-correction"].checks).toMatchObject({ runtimeSourceState: "staged", history: 1, facts: 1 });
    // Every table still equals its sealed digest (the page-level checks above ran inside the stages).
    for (const stage of TELEMETRY_PRODUCTION_STAGES) {
      for (const facts of Object.values(results[stage].tables)) expect(facts.targetRows).toBe(facts.sourceRows);
    }
  });
});

describe.skipIf(!PG_TEST_SOCKET)("D-PT5A production stages equal the reviewed rehearsal importers over the same sealed corpus", () => {
  let world;
  let seal;
  let manifestPath;
  let cluster;
  let handle;
  let scratch;
  // The rehearsal importers validate the schema names' prefixes, so these two disposable names cannot carry the stream id.
  const rehearsal = `typed_legacy_transfer_rehearsal_target_fastpath_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const control = `typed_legacy_transfer_rehearsal_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

  beforeAll(async () => {
    world = await prepareSealWorld({ commit: headCommit(WORKER_ROOT) });
    const run = await sealWorld(world);
    const result = await run.run();
    manifestPath = outputPathsOf(run.out).manifest;
    seal = await readCutoverSeal({ manifestPath, expectedSealId: result.sealId });
    cluster = await createW2SealCluster({ socket: PG_TEST_SOCKET, port: PG_TEST_PORT, user: PG_TEST_USER,
      password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE, count: 1, label: "ptfiveeq" });
    const production = cluster.targets[0];
    handle = await production.open(seal.manifest.sealId);
    await beginRun(handle, { sealedAt: seal.manifest.createdAt });
    await advanceRun(handle, "importing");
    await runIdentityAuthorityTransfer({ handle, sealManifestPath: manifestPath, identityLinkPin: PIN });
    for (const stage of TELEMETRY_PRODUCTION_STAGES) await TELEMETRY_PRODUCTION_RUNNERS[stage]({ handle, sealManifestPath: manifestPath });

    // The rehearsal chain over the same sealed file, in a disposable schema of the cluster's default database (the
    // production control schema is global to a database, so the rehearsal cannot share the target's).
    scratch = new pg.Pool({ host: cluster.endpoint.host, port: cluster.endpoint.port, user: PG_TEST_USER, password: PG_TEST_PASSWORD,
      database: PG_TEST_DATABASE, max: 3, ssl: false });
    scratch.on("error", () => {});
    const pool = scratch;
    await pool.query(`CREATE SCHEMA ${rehearsal}`);
    await pool.query(`CREATE SCHEMA ${control}`);
    await applyPostgresMigrations({ role: "primary", schema: rehearsal, pool });
    const sealedSource = { path: seal.sources.ingestion.path, expectedSha256: seal.sources.ingestion.sealedSha256 };
    const identity = await openSealedFastpathIdentitySource(sealedSource);
    const sources = [identity];
    try {
      await runPostgresFastpathIdentityCopy({ source: identity, pool, targetSchema: rehearsal, publicSourceOwnerParity: "defer" });
      const typed = await createSealedSqliteTypedLegacyRehearsalSource(sealedSource);
      sources.push(typed);
      await runPostgresTypedLegacyTransfer({ source: typed, destinationPool: pool, targetSchema: rehearsal, controlSchema: control,
        transferId: "synthetic-equivalence-typed" });
      await runPostgresFastpathTransportCopy({ source: identity, pool, targetSchema: rehearsal, part: "legacy-transport" });
      const v12 = await createSealedSqliteV12RehearsalSource(sealedSource);
      sources.push(v12);
      await runPostgresV12Transfer({ source: v12, destinationPool: pool, targetSchema: rehearsal, controlSchema: control,
        transferId: "synthetic-equivalence-v12" });
      await runPostgresFastpathTransportCopy({ source: identity, pool, targetSchema: rehearsal, part: "v12-event-sources" });
      const correction = await createSealedSqliteUsageCorrectionSource(sealedSource);
      sources.push(correction);
      await runPostgresUsageCorrectionTransfer({ source: correction, destinationPool: pool, targetSchema: rehearsal,
        transferId: "synthetic-equivalence-correction" });
      const sealedIngestion = await openSealedSourceFromSeal(seal, "ingestion");
      const journalPath = `${seal.sources.ingestion.path}.journal.sqlite`;
      try {
        await projectIngestionJournal({ sealedIngestion, outputPath: journalPath });
        const { sha256 } = await import("../scripts/cutover-source-seal.mjs").then(module => ({ sha256: module.sha256File }));
        const journalSource = await createSealedSqliteIngestionJournalSource({ path: journalPath, expectedSha256: await sha256(journalPath),
          expectedSourceId: sealedDbSourceId(seal) });
        sources.push(journalSource);
        await transferPostgresIngestionJournal({ source: journalSource, destinationPool: pool, targetSchema: rehearsal,
          transferId: "synthetic-ingestion-journal-equivalence" });
      } finally {
        sealedIngestion.close();
      }
    } finally {
      for (const source of sources) source.close?.();
    }
  }, 900_000);

  function sealedDbSourceId(currentSeal) {
    const database = new DatabaseSync(currentSeal.sources.ingestion.path, { readOnly: true });
    try {
      return database.prepare("SELECT source_id FROM storage_source_state WHERE singleton = 1").get().source_id;
    } finally {
      database.close();
    }
  }

  afterAll(async () => {
    await scratch?.query(`DROP SCHEMA IF EXISTS ${rehearsal} CASCADE`).catch(() => {});
    await scratch?.query(`DROP SCHEMA IF EXISTS ${control} CASCADE`).catch(() => {});
    await scratch?.end().catch(() => {});
    await cluster?.dispose();
    await world?.dispose();
  });

  async function digests(pool, schema, names) {
    const result = {};
    for (const name of names) {
      const row = (await pool.query(`SELECT count(*)::int AS n,
          md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text COLLATE "C"), '')) AS digest FROM "${schema}"."${name}" t`)).rows[0];
      result[name] = row;
    }
    return result;
  }

  it("produces, table for table, the rows the rehearsal importers write", async () => {
    // Tables both pipelines populate with the same semantics (the identity-side tables are PT-3's and differ by design).
    const shared = [
      "typed_telemetry_dictionary", "typed_telemetry_namespaces", "typed_telemetry_owners", "typed_telemetry_owner_memberships",
      "typed_telemetry_devices", "typed_telemetry_manifests", "typed_telemetry_identifiers", "typed_telemetry_attributions",
      "typed_telemetry_quota_dimensions", "typed_telemetry_chunks", "typed_telemetry_records", "typed_telemetry_usage",
      "typed_telemetry_quota", "typed_telemetry_session_tools", "telemetry_v1_chunks", "telemetry_v11_day_manifests",
      "telemetry_v11_chunks", "telemetry_v11_domain_predecessors", "telemetry_v11_domains", "telemetry_v11_domain_days",
      "telemetry_v11_domain_heads", "typed_v1_admission_state", "typed_v11_admission_state", "typed_v1_chunk_allocations",
      "typed_v11_chunk_allocations", "typed_v1_record_admissions", "typed_v11_manifest_memberships", "typed_v11_record_proofs",
      "typed_v1_event_sources", "storage_v11_event_sources", "storage_v12_event_sources", "telemetry_v12_typed_runtime",
      "telemetry_v12_runtime", "telemetry_v12_day_manifests", "telemetry_v12_chunks", "telemetry_v12_typed_attributions",
      "telemetry_v12_typed_records", "telemetry_v12_typed_usage", "telemetry_v12_typed_quota", "telemetry_v12_typed_session_tools",
      "telemetry_v12_domain_predecessors", "telemetry_v12_domains", "telemetry_v12_domain_days", "telemetry_v12_domain_heads",
      "telemetry_usage_correction_runtime", "storage_ingestion_changes", "storage_source_state", "storage_owner_revisions",
    ];
    const production = await digests(cluster.targets[0].ownerPrimary, PRIMARY_SCHEMA, shared);
    const reference = await digests(scratch, rehearsal, shared);
    for (const name of shared) expect(production[name], name).toEqual(reference[name]);
    expect(Object.values(production).reduce((sum, item) => sum + item.n, 0)).toBeGreaterThan(40_000);
  }, 900_000);
});
