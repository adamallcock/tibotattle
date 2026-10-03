import { createHash } from "node:crypto";
import { chmod, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FIXTURE_CAPTURED_AT,
  FIXTURE_EVIDENCE_DATE,
  exportBytes,
  goldenExportBody,
  sha256Hex as exportSha256,
} from "../analytics-v2-test/fixtures/interim-public-read-export.mjs";
import {
  PRODUCTION_IDENTITY_LINK_SECRET_VERSION,
  PRODUCTION_RETIRED_IDENTITY_LINK_VERSIONS,
} from "../cloud-run/postgres-production-configuration.mjs";
import { verifyCutoverUnchanged } from "../scripts/cutover-source-fence.mjs";
import { participantDeletionDigest, projectDeletionDigests } from "../scripts/cutover-source-projections.mjs";
import { openSealedSourceFromSeal, readCutoverSeal, writePrivateFileOnce } from "../scripts/cutover-source-seal.mjs";
import {
  ORCHESTRATOR_LOCK_KEY,
  MIGRATION_FENCE_LOCK_PREFIX,
  OWNER_FILES,
  PRODUCTION_DESIRED_STATE_FILE,
  PRODUCTION_TRANSFER_INPUTS_SCHEMA,
  SCHEDULER_PROBE_SCHEMA,
  TYPED_IDENTITY_TABLES,
  abandon,
  createTransferContext,
  flipGate,
  markLiveStep,
  postLiveCheck,
  releaseControls,
  runImport,
  runPreflight,
  targetCheck,
  writeIdentityPin,
  writeIdentityRotation,
  writeReport,
} from "../scripts/postgres-production-transfer.mjs";
import { DISPOSITIONS, OWNER_FLAG_PERFORMANCE_ROUTES_RETIRED, STAGE_PLAN } from "../scripts/postgres-transfer-coverage.mjs";
import {
  OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING,
  PENDING_OBJECT_TRANSFER_HOLD_GUARD,
  PENDING_OBJECT_TRANSFER_HOLD_TABLE,
} from "../scripts/postgres-legacy-contribution-transfer.mjs";
import { dropTransferStagingRelations, withTransferTransaction } from "../scripts/postgres-transfer-target.mjs";
import {
  buildSyntheticAnalyticsD1,
  exportSyntheticAdminHistory,
  writeAnalyticsSourceFixture,
} from "./fixtures/w2-seal/admin-history-fixtures.mjs";
import { createW2SealCluster, PRIMARY_SCHEMA, TRANSFER_ROLE, localSocket } from "./fixtures/w2-seal/pg-target.mjs";
import { forgeVariantSeal, headCommit, outputPathsOf, prepareSealWorld, sealWorld } from "./fixtures/w2-seal/seal-harness.mjs";
import { SYNTHETIC_BOOKMARKS, writeBarrierProofFixture, writeFenceReceiptFixture } from "./fixtures/w2-seal/fence-fixtures.mjs";
import {
  SYNTHETIC_IDENTITY_LINK_SECRET,
  createFakeCutoverTransport,
  identityLinkFingerprint,
  privateDirectory,
} from "./fixtures/w2-seal/synthetic-sources.mjs";

// E-PT8 acceptance on PostgreSQL 17: the PT-8-lite orchestrator over a
// synthetic PT-2-lite seal of the Q-1 corpus, from preflight to mark-live.
// Everything is local and synthetic; secrets are fixture constants.

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const WORKER_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const FENCE_APPLIED_MS = Date.parse("2026-10-02T00:00:00.000Z");
const SEAL_NOW = new Date("2026-10-02T01:00:00.000Z");
const CONTEXT_NOW = () => new Date("2026-10-02T02:00:00.000Z");
const table = name => `"${PRIMARY_SCHEMA}"."${name}"`;
/** The synthetic production plane: its project, and the identity-link mount the pin must name. */
const DESIRED_PROJECT = "tibotattle-synthetic";
const IDENTITY_MOUNT = Object.freeze({ secretName: "IDENTITY_LINK_SECRET", version: "3" });
/**
 * Round 16: the world seals production's retired label (with the synthetic
 * secret), so the rotation runs between the origin's real labels; the
 * rotated label and a NEW synthetic secret (the production value is lost).
 */
const SEALED_IDENTITY_LINK_VERSION = PRODUCTION_RETIRED_IDENTITY_LINK_VERSIONS[0];
const ROTATED_VERSION = PRODUCTION_IDENTITY_LINK_SECRET_VERSION;
const ROTATED_SECRET = "ept8-synthetic-rotated-identity-link-secret-000000";

async function codeOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error?.code ?? String(error?.message);
  }
  return "RESOLVED";
}

describe.skipIf(!PG_TEST_SOCKET)("E-PT8 PT-8-lite orchestrator on PostgreSQL 17", () => {
  let world;
  let seal;
  let manifestPath;
  let cluster;
  let admin;
  let participantIds;
  let analytics;
  const adminHistoryExports = new Map();

  /**
   * H.3 step 6's analytics D1 admin history export for one seal (D-PT4X),
   * cached per seal: the export is deterministic. A variant seal the export
   * itself refuses gets the main seal's export; such a seal is refused by an
   * earlier preflight check, and P15 would refuse the borrowed export anyway.
   */
  async function adminHistoryExportFor(manifest, sealId) {
    if (!adminHistoryExports.has(sealId)) {
      let exported;
      try {
        exported = await exportSyntheticAdminHistory({ world, seal: { manifestPath: manifest, sealId },
          analyticsPath: analytics.path, analyticsSourcePath: analytics.sourcePath });
      } catch (error) {
        if (sealId === seal.manifest.sealId) throw error;
        return adminHistoryExportFor(manifestPath, seal.manifest.sealId);
      }
      adminHistoryExports.set(sealId, { path: exported.path, sha256: exported.sha256 });
    }
    return adminHistoryExports.get(sealId);
  }

  /**
   * A fresh owner directory with pin, projection, OWN-4 export, scheduler
   * evidence and inputs. With `rotation`, the pin and identity-rotation.json
   * come from identity-rotate-pin (the NEW secret from stdin, the sealed D1
   * pin from a wrangler-shaped file) and the inputs declare the rotation.
   */
  async function ownerDirectory(target, { manifest = manifestPath, sealId = seal.manifest.sealId, inputs = {},
    pinSecret = SYNTHETIC_IDENTITY_LINK_SECRET, ledgerSeal = null, scheduler = {}, rotation = null,
    pinKeyVersion = SEALED_IDENTITY_LINK_VERSION } = {}) {
    const directory = await privateDirectory("ept8-owner-");
    let rotationInputs = {};
    if (rotation === null) {
      await writeIdentityPin({ ownerDirectory: directory, stream: Readable.from([pinSecret]),
        keyVersion: pinKeyVersion, secretName: IDENTITY_MOUNT.secretName,
        secretVersion: IDENTITY_MOUNT.version, now: CONTEXT_NOW });
    } else {
      const sealedPinFile = join(directory, "sealed-pin.json");
      await writePrivateFileOnce(sealedPinFile, `${JSON.stringify([{ results: [{
        key_version: rotation.fromKeyVersion ?? SEALED_IDENTITY_LINK_VERSION,
        secret_fingerprint: rotation.fromFingerprint ?? identityLinkFingerprint(SYNTHETIC_IDENTITY_LINK_SECRET) }],
      success: true, meta: {} }])}\n`, 0o400);
      const written = await writeIdentityRotation({ ownerDirectory: directory, stream: Readable.from([rotation.secret]),
        sealedPinFile, fromKeyVersion: rotation.fromKeyVersion ?? SEALED_IDENTITY_LINK_VERSION,
        toKeyVersion: ROTATED_VERSION, secretName: IDENTITY_MOUNT.secretName, secretVersion: IDENTITY_MOUNT.version,
        now: CONTEXT_NOW });
      rotationInputs = { expectedIdentityKeyVersion: ROTATED_VERSION,
        identityLinkRotation: { rotationSha256: written.rotationSha256 } };
    }
    const projectionSeal = ledgerSeal ?? await readCutoverSeal({ manifestPath: manifest, expectedSealId: sealId });
    const ledger = await openSealedSourceFromSeal(projectionSeal, "deletion-ledger");
    let projection;
    try {
      projection = await projectDeletionDigests({ sealedLedger: ledger, outputPath: join(directory, "deletion-digests.txt") });
    } finally {
      ledger.close();
    }
    const bytes = exportBytes(goldenExportBody());
    await writePrivateFileOnce(join(directory, "own4-export.json"), bytes, 0o400);
    // The C-INFRA probe's own shape (probeScheduler): one entry per managed trigger.
    await writePrivateFileOnce(join(directory, "scheduler-probe.json"), `${JSON.stringify({
      schema: SCHEDULER_PROBE_SCHEMA, environment: "production", project: DESIRED_PROJECT,
      checkedAt: "2026-10-02T00:30:00.000Z", thresholdHours: 6, triggers: pausedTriggers(),
      alert: false, signal: null, ...scheduler })}\n`, 0o400);
    const value = {
      schema: PRODUCTION_TRANSFER_INPUTS_SCHEMA,
      contractId: target.contract.contractId,
      sealId,
      sealManifestPath: manifest,
      expectedSourceCommit: world.commit,
      fenceReceiptSha256: world.fence.sha256,
      expectedIdentityKeyVersion: SEALED_IDENTITY_LINK_VERSION,
      deletionDigestProjection: { path: projection.path, sha256: projection.sha256 },
      interimPublicRead: { exportPath: join(directory, "own4-export.json"), sha256: exportSha256(bytes),
        capturedAt: FIXTURE_CAPTURED_AT, sourceCommit: world.commit, evidenceDate: FIXTURE_EVIDENCE_DATE },
      adminHistoryExport: await adminHistoryExportFor(manifest, sealId),
      schedulerEvidencePath: join(directory, "scheduler-probe.json"),
      ownerFlags: [OWNER_FLAG_PERFORMANCE_ROUTES_RETIRED],
      allowedRoleMembers: [],
      ...rotationInputs,
      ...inputs,
    };
    await writePrivateFileOnce(join(directory, OWNER_FILES.inputs), `${JSON.stringify(value)}\n`, 0o400);
    return directory;
  }

  /** One paused entry per managed trigger: the committed production desired state's scheduler map (P11). */
  function pausedTriggers() {
    return world.managedTriggers.map(job => ({ job, name: `tibotattle-${job}-trigger`, desiredState: "PAUSED",
      liveState: "PAUSED", quietMinutes: null, verdict: "paused_as_desired", alert: false }));
  }

  /** A synthetic production desired state: the committed file with its placeholders filled. */
  async function desiredStateFile(overrides = {}) {
    const committed = JSON.parse(await readFile(join(WORKER_ROOT, PRODUCTION_DESIRED_STATE_FILE), "utf8"));
    const directory = await privateDirectory("ept8-desired-");
    const path = join(directory, "production.desired-state.json");
    await writePrivateFileOnce(path, `${JSON.stringify({ ...committed, project: DESIRED_PROJECT,
      secrets: { ...committed.secrets, IDENTITY_LINK_SECRET: { ...IDENTITY_MOUNT } }, ...overrides })}\n`, 0o400);
    return path;
  }

  function context(target, directory, options = {}) {
    return createTransferContext({ ownerDirectory: directory, pool: target.transferPrimary, now: CONTEXT_NOW,
      desiredStatePath: world.desiredStatePath, ...options });
  }

  async function flipEvidence(directoryName, { manifest = manifestPath, sealId = seal.manifest.sealId } = {}) {
    const out = await privateDirectory(`ept8-${directoryName}-`);
    const result = await verifyCutoverUnchanged({ inventoryPath: world.inventory.path, manifestPath: manifest, sealId,
      ownerDirectory: out, execute: true, remote: true, ownerReadOnly: true,
      transport: createFakeCutoverTransport({ sources: world.remotePaths, bookmarks: SYNTHETIC_BOOKMARKS }) });
    return { path: result.path, sha256: result.flipEvidenceSha256 };
  }

  /** A superuser statement with user triggers off (synthetic tampering only). */
  async function tamper(target, sql, values = []) {
    const client = await target.adminPrimary.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const result = await client.query(sql, values);
      await client.query("COMMIT");
      return result.rows;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Remove the loaded frozen read and return a restorer for the identical row. */
  async function removeFrozenRead(target) {
    const [row] = await tamper(target, `DELETE FROM ${table("community_daily_frozen_export")} WHERE id = 1
      RETURNING payload_text, payload_sha256, captured_at::text AS captured_at, source_commit,
        evidence_date::text AS evidence_date, loaded_at::text AS loaded_at`);
    expect(row).toBeDefined();
    return () => tamper(target, `INSERT INTO ${table("community_daily_frozen_export")}
        (id, payload_text, payload_sha256, captured_at, source_commit, evidence_date, loaded_at)
      VALUES (1, $1, $2, $3::timestamptz, $4, $5::date, $6::timestamptz)`,
    [row.payload_text, row.payload_sha256, row.captured_at, row.source_commit, row.evidence_date, row.loaded_at]);
  }

  /**
   * Replace the loaded frozen read with another valid export (the same body
   * plus one trailing space: other bytes, another digest) and return a
   * restorer for the original row.
   */
  async function swapFrozenRead(target) {
    const [row] = await tamper(target, `SELECT payload_text, payload_sha256 FROM ${table("community_daily_frozen_export")}
      WHERE id = 1`);
    expect(row).toBeDefined();
    const restoreOriginal = await removeFrozenRead(target);
    const [swapped] = await tamper(target, `INSERT INTO ${table("community_daily_frozen_export")}
        (id, payload_text, payload_sha256, captured_at, source_commit, evidence_date)
      SELECT 1, $1 || ' ', encode(sha256(convert_to($1 || ' ', 'UTF8')), 'hex'), $2::timestamptz, $3, $4::date
      RETURNING payload_sha256`, [row.payload_text, FIXTURE_CAPTURED_AT, world.commit, FIXTURE_EVIDENCE_DATE]);
    expect(swapped.payload_sha256).not.toBe(row.payload_sha256);
    return async () => {
      await tamper(target, `DELETE FROM ${table("community_daily_frozen_export")} WHERE id = 1`);
      await restoreOriginal();
    };
  }

  /**
   * tibotattle_source_transfer is cluster-global: a member left behind (or
   * added concurrently) by another suite makes PT-1's flip gate refuse,
   * correctly. Fail loudly instead; run this spec alone on a clean cluster.
   */
  async function assertNoForeignTransferMembers() {
    const { rows: members } = await admin.query(`SELECT count(*)::int AS n FROM pg_auth_members am
      JOIN pg_roles role ON role.oid = am.roleid JOIN pg_roles member ON member.oid = am.member
     WHERE role.rolname = $1 AND member.rolname <> $2`, [TRANSFER_ROLE, cluster.roles.transfer]);
    if (members[0].n !== 0) {
      throw new Error(`ENVIRONMENT: ${members[0].n} foreign member(s) of ${TRANSFER_ROLE} on this cluster; use a clean cluster`);
    }
  }

  /** A run killed right after the named committed step. */
  function killAfter(name) {
    return { onStep: (fired) => {
      if (fired === name) throw new Error("synthetic kill");
    } };
  }

  async function runToVerified(target, directory, contextOptions = {}) {
    const preflight = await runPreflight(await context(target, directory));
    expect(preflight.verdict).toBe("GO");
    const result = await runImport(await context(target, directory, contextOptions),
      { execute: true, confirm: preflight.runAuthorizationToken });
    return { preflight, result };
  }

  async function receipts(target) {
    const stages = await target.ownerPrimary.query(`SELECT stage, state, row_count::text AS row_count, receipt_sha256
      FROM tibotattle_transfer.transfer_stage_receipts ORDER BY stage`);
    const tables = await target.ownerPrimary.query(`SELECT source_role, source_table, stage, disposition, state,
        source_row_count::text, source_sha256, target_row_count::text, target_sha256
      FROM tibotattle_transfer.transfer_table_receipts ORDER BY source_role, source_table`);
    return { stages: stages.rows, tables: tables.rows };
  }

  async function targetRows(target) {
    const { rows } = await target.ownerPrimary.query(`SELECT count(*)::int AS n FROM tibotattle_transfer.transfer_runs`);
    return rows[0].n;
  }

  beforeAll(async () => {
    const commit = headCommit(WORKER_ROOT);
    world = await prepareSealWorld({ commit, ingestion: { identityLinkVersion: SEALED_IDENTITY_LINK_VERSION } });
    // The Q-1 runtime is 'active'; a seal PT-8 accepts carries the staged runtime (P4).
    const writable = new DatabaseSync(world.ingestionPath);
    try {
      // The runtime row is immutable in D1: lift its guard for the synthetic edit and restore the identical trigger.
      const guards = writable.prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'
        AND tbl_name = 'telemetry_usage_correction_runtime'`).all();
      for (const guard of guards) writable.exec(`DROP TRIGGER "${guard.name}"`);
      writable.exec("UPDATE telemetry_usage_correction_runtime SET state = 'staged'");
      for (const guard of guards) writable.exec(guard.sql);
      participantIds = writable.prepare("SELECT id FROM participants ORDER BY id").all().map(row => row.id);
    } finally {
      writable.close();
    }
    // The fence, the barrier proof and the seal on fixed instants that bracket the OWN-4 fixture.
    const fenceDirectory = await privateDirectory("ept8-fence-");
    world.fence = await writeFenceReceiptFixture({ directory: fenceDirectory, appliedAtMs: FENCE_APPLIED_MS });
    world.proof = await writeBarrierProofFixture({ directory: fenceDirectory, observedAtMs: FENCE_APPLIED_MS + 20 * 60_000 });
    world.desiredStatePath = await desiredStateFile();
    world.managedTriggers = Object.keys(JSON.parse(await readFile(join(WORKER_ROOT, PRODUCTION_DESIRED_STATE_FILE), "utf8"))
      .scheduler).sort();
    const run = await sealWorld(world, { overrides: { now: () => SEAL_NOW } });
    const sealed = await run.run();
    manifestPath = outputPathsOf(run.out).manifest;
    seal = await readCutoverSeal({ manifestPath, expectedSealId: sealed.sealId });
    // The analytics D1's admin snapshots under the sealed source id, and one
    // row of another source the export counts but never carries.
    const analyticsDirectory = await privateDirectory("ept8-analytics-");
    const sealedIngestion = new DatabaseSync(seal.sources.ingestion.path, { readOnly: true });
    let sourceId;
    try {
      sourceId = sealedIngestion.prepare("SELECT source_id FROM storage_source_state").get().source_id;
    } finally {
      sealedIngestion.close();
    }
    analytics = {
      path: buildSyntheticAnalyticsD1({ directory: analyticsDirectory, commit: world.commit, sourceId,
        snapshots: [["2026-10-01T22:00:00.000Z", JSON.stringify({ participantsTotal: 7 })],
          ["2026-10-01T23:00:00.000Z", JSON.stringify({ participantsTotal: 8, bandFitCount: 1 })]],
        otherSnapshots: [["2026-10-01T23:00:00.000Z", JSON.stringify({ participantsTotal: 1 })]] }),
      sourcePath: await writeAnalyticsSourceFixture({ directory: analyticsDirectory }),
    };
    cluster = await createW2SealCluster({ socket: PG_TEST_SOCKET, port: PG_TEST_PORT, user: PG_TEST_USER,
      password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE, count: 7, label: "ept8" });
    const endpoint = await localSocket(PG_TEST_SOCKET, PG_TEST_PORT);
    admin = new pg.Client({ ...endpoint, user: PG_TEST_USER, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE, ssl: false });
    await admin.connect();
    // The production membership shape: SET only, never inherited.
    await admin.query(`GRANT "${cluster.roles.owner}" TO "${cluster.roles.transfer}" WITH INHERIT FALSE, SET TRUE`);
    await admin.query(`GRANT ${TRANSFER_ROLE} TO "${cluster.roles.transfer}" WITH INHERIT FALSE, SET TRUE`);
  }, 900_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.dispose();
    await world?.dispose();
  });

  it("target-check passes on an empty registered target and refuses one without the frozen-read table", async () => {
    const target = cluster.targets[3];
    const report = await targetCheck({ pool: target.transferPrimary, contractId: target.contract.contractId });
    expect(report.verdict).toBe("GO");
    expect(report.target.triggerTables).toBeGreaterThan(50);
    // The C-IPR table moved out of the application schema (a superuser session on the target database).
    const moved = new pg.Client({ ...await localSocket(PG_TEST_SOCKET, PG_TEST_PORT), user: PG_TEST_USER,
      password: PG_TEST_PASSWORD, database: target.databases.primary, ssl: false });
    await moved.connect();
    try {
      await moved.query(`ALTER TABLE ${table("community_daily_frozen_export")} SET SCHEMA public`);
      expect(await codeOf(targetCheck({ pool: target.transferPrimary, contractId: target.contract.contractId })))
        .toBe("CUTOVER_TARGET_FROZEN_READ_TABLE_MISSING");
    } finally {
      await moved.query(`ALTER TABLE public.community_daily_frozen_export SET SCHEMA "${PRIMARY_SCHEMA}"`).catch(() => {});
      await moved.end();
    }
    expect((await targetCheck({ pool: target.transferPrimary, contractId: target.contract.contractId })).verdict).toBe("GO");
  }, 120_000);

  it("drives a seal from preflight to live, resuming identically after a kill at every committed step", async () => {
    await assertNoForeignTransferMembers();
    const [target, clean] = cluster.targets;
    // A clean run on its own target: the reference.
    const cleanDirectory = await ownerDirectory(clean);
    await runToVerified(clean, cleanDirectory);
    // The killed run: each invocation dies after its next committed step.
    const directory = await ownerDirectory(target);
    const preflight = await runPreflight(await context(target, directory));
    const killed = [];
    let finished = null;
    for (let attempt = 0; attempt < 60 && finished === null; attempt += 1) {
      let fired = null;
      const onStep = (name) => {
        if (!killed.includes(name)) {
          fired = name;
          throw new Error("synthetic kill after a committed step");
        }
      };
      try {
        finished = await runImport(await context(target, directory, { onStep }),
          { execute: true, confirm: preflight.runAuthorizationToken });
      } catch (error) {
        if (fired === null) throw error;
        killed.push(fired);
      }
    }
    expect(finished?.runState).toBe("verified");
    expect(killed).toEqual(expect.arrayContaining(["begin", "importing", ...STAGE_PLAN.filter(entry => entry.stage !== "post-import")
      .map(entry => `stage:${entry.stage}`), "post-import:started", "post-import:tl1", "post-import:operational-history",
      "post-import:invariants", "post-import:coverage", "post-import:parity", "post-import:interim-read",
      "post-import:cleanup", "post-import:receipt", "post-import", "verifying", "verified"]));
    // Identical to the clean run, receipt by receipt (post-import binds its own preflight).
    const resumed = await receipts(target);
    const reference = await receipts(clean);
    expect(resumed.tables).toEqual(reference.tables);
    expect(resumed.stages.filter(row => row.stage !== "post-import")).toEqual(
      reference.stages.filter(row => row.stage !== "post-import"));
    const postImport = async (directoryPath) => {
      const { preflightSha256: _preflight, receiptSha256: _receipt, contractId: _contract, ...body } =
        JSON.parse(await readFile(join(directoryPath, OWNER_FILES.postImport), "utf8"));
      return body;
    };
    expect(await postImport(directory)).toEqual(await postImport(cleanDirectory));
    // Post-import mapped the analytics D1 export (H.3 step 6): both snapshots
    // of the sealed source, and none of the other source's.
    const { rows: mapped } = await target.ownerPrimary.query(`SELECT count(*)::int AS n
      FROM ${table("analytics_admin_metric_snapshots")}
     WHERE captured_at IN ('2026-10-01T22:00:00.000Z'::timestamptz, '2026-10-01T23:00:00.000Z'::timestamptz)`);
    expect(mapped[0].n).toBe(2);
    // One receipt per sealed table, with exactly the disposition's token and stage.
    const present = new Set(resumed.tables.map(row => `${row.source_role}:${row.source_table}`));
    for (const item of DISPOSITIONS) {
      if (item.optional && !present.has(`${item.role}:${item.table}`)) continue;
      const row = resumed.tables.find(candidate => candidate.source_role === item.role && candidate.source_table === item.table);
      expect(row, `${item.role}:${item.table}`).toMatchObject({ stage: item.stage, disposition: item.token, state: "complete" });
    }
    expect(resumed.tables.length).toBe(DISPOSITIONS.filter(item => present.has(`${item.role}:${item.table}`)).length);
    // A rerun of a verified run is a no-op.
    const rerun = await runImport(await context(target, directory), { execute: true, confirm: preflight.runAuthorizationToken });
    expect(rerun.stagesRun).toEqual([]);

    // The staging drop belongs before 'verified': PT-1 refuses it afterwards.
    const handle = (await import("../scripts/postgres-transfer-target.mjs")).openProductionTransferTarget;
    const verifiedHandle = await handle({ primaryPool: target.transferPrimary, expectedContractId: target.contract.contractId,
      sealManifestSha256: seal.manifest.sealId });
    expect(await codeOf(withTransferTransaction(verifiedHandle, "primary",
      client => dropTransferStagingRelations(client, verifiedHandle, [])))).toBe("CUTOVER_RUN_STATE_INVALID");

    // Ordering: flip-gate and mark-live before the release are refused.
    const early = await flipEvidence("early");
    expect(await codeOf(flipGate(await context(target, directory), { flipEvidencePath: early.path })))
      .toBe("CUTOVER_STEP_ORDER_VIOLATION");
    expect(await codeOf(markLiveStep(await context(target, directory), { flipEvidenceSha256: early.sha256 })))
      .toBe("CUTOVER_STEP_ORDER_VIOLATION");

    // F1 and F2: release the sealed controls (dry run first, then the exact token).
    const flip1 = await flipEvidence("flip1");
    const dry = await releaseControls(await context(target, directory), { flipEvidencePath: flip1.path });
    expect(dry.mode).toBe("dry-run");
    expect(await codeOf(releaseControls(await context(target, directory), { flipEvidencePath: flip1.path, execute: true,
      confirm: "0".repeat(64) }))).toBe("CUTOVER_AUTHORIZATION_MISMATCH");
    const released = await releaseControls(await context(target, directory), { flipEvidencePath: flip1.path, execute: true,
      confirm: dry.authorizationToken });
    expect(released.mode).toBe("executed");
    // Idempotent with the same evidence.
    expect((await releaseControls(await context(target, directory), { flipEvidencePath: flip1.path, execute: true,
      confirm: dry.authorizationToken })).releaseSha256).toBe(released.releaseSha256);
    // F3/F4: the flip gate refuses E1 again, and evidence older than the release.
    expect(await codeOf(flipGate(await context(target, directory), { flipEvidencePath: flip1.path })))
      .toBe("CUTOVER_FLIP_EVIDENCE_STALE");
    expect(await codeOf(flipGate(await context(target, directory), { flipEvidencePath: early.path })))
      .toBe("CUTOVER_FLIP_EVIDENCE_STALE");
    expect(await codeOf(markLiveStep(await context(target, directory), { flipEvidenceSha256: flip1.sha256 })))
      .toBe("CUTOVER_STEP_ORDER_VIOLATION");
    const flip2 = await flipEvidence("flip2");
    // A foreign member of the transfer role (SET or INHERIT) refuses the gate.
    const foreign = `ept8_foreign_${Date.now().toString(36)}`;
    await admin.query(`CREATE ROLE "${foreign}" NOLOGIN`);
    try {
      await admin.query(`GRANT ${TRANSFER_ROLE} TO "${foreign}"`);
      expect(await codeOf(flipGate(await context(target, directory), { flipEvidencePath: flip2.path })))
        .toBe("CUTOVER_FLIP_ROLE_MEMBERS_UNEXPECTED");
    } finally {
      await admin.query(`DROP ROLE IF EXISTS "${foreign}"`);
    }
    const gate = await flipGate(await context(target, directory), { flipEvidencePath: flip2.path });
    expect(gate.ready).toBe(true);
    expect((await flipGate(await context(target, directory), { flipEvidencePath: flip2.path })).flipGateSha256)
      .toBe(gate.flipGateSha256);
    // F5: mark live (dry run, a wrong sha, a wrong token, then the token).
    expect(await codeOf(markLiveStep(await context(target, directory), { flipEvidenceSha256: flip1.sha256 })))
      .toBe("CUTOVER_FLIP_EVIDENCE_INVALID");
    const liveDry = await markLiveStep(await context(target, directory), { flipEvidenceSha256: flip2.sha256 });
    expect(liveDry).toMatchObject({ mode: "dry-run", authorizationToken: gate.markLiveAuthorizationToken });
    expect(await codeOf(markLiveStep(await context(target, directory), { flipEvidenceSha256: flip2.sha256, execute: true,
      confirm: dry.authorizationToken }))).toBe("CUTOVER_AUTHORIZATION_MISMATCH");
    const live = await markLiveStep(await context(target, directory), { flipEvidenceSha256: flip2.sha256, execute: true,
      confirm: gate.markLiveAuthorizationToken });
    expect(live.state).toBe("live");
    const again = await markLiveStep(await context(target, directory), { flipEvidenceSha256: flip2.sha256, execute: true,
      confirm: gate.markLiveAuthorizationToken });
    expect(again.markLiveSha256).toBe(live.markLiveSha256);

    // After live: every transfer insert is refused, and so is every step before it.
    const liveMessage = await target.ownerPrimary.query(`INSERT INTO tibotattle_transfer.transfer_dropped_relations
      (run_id, relation_name, stage, was_present, row_count, rows_sha256)
      SELECT run_id, 'x', 'post-import', false, 0, repeat('0', 64) FROM tibotattle_transfer.transfer_runs LIMIT 1`)
      .then(() => "RESOLVED", error => error.message);
    expect(liveMessage).toBe("TRANSFER_TARGET_LIVE");
    expect(await codeOf(runImport(await context(target, directory), { execute: true, confirm: preflight.runAuthorizationToken })))
      .toBe("CUTOVER_STEP_ORDER_VIOLATION");
    expect(await codeOf(releaseControls(await context(target, directory), { flipEvidencePath: flip2.path })))
      .toBe("CUTOVER_STEP_ORDER_VIOLATION");
    expect(await codeOf(abandon(await context(target, directory)))).toBe("CUTOVER_STEP_ORDER_VIOLATION");

    // L1: the first maintenance pass (simulated) and the post-live check; then the report.
    expect(await codeOf(postLiveCheck(await context(target, directory, { now: () => new Date() }))))
      .toBe("CUTOVER_POST_LIVE_NOT_READY");
    // L2 needs L1's receipt: no report before the post-live check has passed.
    expect(await codeOf(writeReport(await context(target, directory)))).toBe("CUTOVER_POST_LIVE_NOT_READY");
    expect(await readdir(directory)).not.toContain(OWNER_FILES.report);
    await target.adminPrimary.query(`UPDATE ${table("retention_state")} SET state = 'completed',
      last_started_at = date_trunc('milliseconds', now()), last_completed_at = date_trunc('milliseconds', now()),
      maintenance_run_at = date_trunc('milliseconds', now()), restore_replay_complete = true, quarantine_retention_complete = true`);
    await target.adminPrimary.query(`UPDATE ${table("quarantine_reconciliation_state")} SET state = 'completed',
      last_started_at = date_trunc('milliseconds', now()), last_completed_at = date_trunc('milliseconds', now()),
      maintenance_run_at = (SELECT maintenance_run_at FROM ${table("retention_state")})`);
    const postLive = await postLiveCheck(await context(target, directory, { now: () => new Date() }));
    expect(postLive.ready).toBe(true);
    // Clock-free: a later check (after another pass) computes the same receipt.
    expect((await postLiveCheck(await context(target, directory, { now: () => new Date() }))).postLiveCheckSha256)
      .toBe(postLive.postLiveCheckSha256);
    const report = await writeReport(await context(target, directory));
    expect(report.reportSha256).toMatch(/^[0-9a-f]{64}$/u);
    const reportBody = JSON.parse(await readFile(join(directory, OWNER_FILES.report), "utf8"));
    expect(reportBody.receipts.postLiveCheck).toBe(postLive.postLiveCheckSha256);
    expect(reportBody.gates).toEqual({ preflight: "GO", flipGate: "ready", markLive: "live", postLiveCheck: "ready" });

    // Content-free: no participant id, secret or fingerprint in any receipt but the pin.
    const fingerprint = identityLinkFingerprint(SYNTHETIC_IDENTITY_LINK_SECRET);
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json") && !name.endsWith(".ndjson")) continue;
      if (["own4-export.json", OWNER_FILES.inputs, OWNER_FILES.pin, "scheduler-probe.json"].includes(name)) continue;
      const text = await readFile(join(directory, name), "utf8");
      expect(text.includes(SYNTHETIC_IDENTITY_LINK_SECRET), name).toBe(false);
      expect(text.includes(fingerprint), name).toBe(false);
      for (const id of participantIds) expect(text.includes(id), name).toBe(false);
    }
  }, 900_000);

  it("refuses every preflight check, the authorization token and the locks before any target write", async () => {
    const target = cluster.targets[2];
    expect((await targetCheck({ pool: target.transferPrimary, contractId: target.contract.contractId })).verdict).toBe("GO");
    const refuse = async (options, expected, label, contextOptions = {}) => {
      const directory = await ownerDirectory(target, options);
      expect(await codeOf(runPreflight(await context(target, directory, contextOptions))), label).toBe(expected);
      expect(await readdir(directory), label).not.toContain(OWNER_FILES.preflight);
    };
    const variant = async (sql, role = "ingestion") => {
      const forged = await forgeVariantSeal(seal, sql, role);
      return { manifest: forged.manifestPath, sealId: forged.sealId };
    };
    // Without a GO preflight, run refuses.
    const bare = await ownerDirectory(target);
    expect(await codeOf(runImport(await context(target, bare), { execute: true, confirm: "0".repeat(64) })))
      .toBe("CUTOVER_PREFLIGHT_MISSING");
    // P1, P2.
    await refuse({ inputs: { expectedSourceCommit: "a".repeat(40) } }, "CUTOVER_SEAL_SOURCE_COMMIT_MISMATCH", "P1");
    await refuse({ inputs: { fenceReceiptSha256: "b".repeat(64) } }, "CUTOVER_SEAL_FENCE_MISMATCH", "P2");
    // P3: a missing owner decision, an unknown sealed table.
    await refuse({ inputs: { ownerFlags: [] } }, "CUTOVER_COVERAGE_DECISION_MISSING", "P3 flag");
    await refuse(await variant("CREATE TABLE zz_ept8_unknown (x INTEGER)"), "CUTOVER_COVERAGE_TABLE_UNKNOWN", "P3 unknown");
    await refuse(await variant("DROP TABLE storage_raw_copy_pages"), "CUTOVER_COVERAGE_TABLE_MISSING", "P3 missing");
    // P4: the correction runtime as Q-1 carries it ('active').
    const runtimeGuards = new DatabaseSync(seal.sources.ingestion.path, { readOnly: true });
    const guards = runtimeGuards.prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'
      AND tbl_name = 'telemetry_usage_correction_runtime'`).all();
    runtimeGuards.close();
    await refuse(await variant(`${guards.map(guard => `DROP TRIGGER "${guard.name}";`).join("\n")}
      UPDATE telemetry_usage_correction_runtime SET state = 'active';
      ${guards.map(guard => `${guard.sql};`).join("\n")}`), "CUTOVER_CORRECTION_RUNTIME_ACTIVE", "P4");
    // P5: an owner link marked erased, a participant not active, a pending
    // erasure job (P3's ledger rule meets it first, with the same code).
    await refuse(await variant(`UPDATE storage_v11_owner_links SET state = 'erased'
      WHERE participant_id = (SELECT min(participant_id) FROM storage_v11_owner_links)`), "CUTOVER_OWNER_LINK_ERASED", "P5");
    const participantGuards = new DatabaseSync(seal.sources.ingestion.path, { readOnly: true });
    const lifecycle = participantGuards.prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'
      AND tbl_name = 'participants'`).all();
    participantGuards.close();
    await refuse(await variant(`${lifecycle.map(guard => `DROP TRIGGER "${guard.name}";`).join("\n")}
      UPDATE participants SET state = 'deleting' WHERE id = (SELECT min(id) FROM participants);
      ${lifecycle.map(guard => `${guard.sql};`).join("\n")}`), "CUTOVER_PARTICIPANT_ERASURE_PENDING", "P5 deleting");
    await refuse(await variant(`INSERT INTO storage_erasure_jobs(participant_digest, source_id, owner_digest, source_namespace,
        state) SELECT participant_digest, 'ept8-source', '${"e".repeat(64)}', 'ept8-namespace', 'pending'
      FROM deletion_tombstones ORDER BY participant_digest LIMIT 1`, "deletion-ledger"),
    "CUTOVER_PARTICIPANT_ERASURE_PENDING", "P5 pending job");
    // P6: a tombstone of a sealed participant (the projection read from the same variant ledger) ...
    const tombstoned = await variant(`INSERT INTO deletion_tombstones(participant_digest, schema_version, deleted_at, retain_until)
      VALUES ('${participantDeletionDigest(participantIds[0])}', 'participant-deletion-tombstone-v0.1',
      '2026-10-01T00:00:00.000Z', '2027-10-01T00:00:00.000Z')`, "deletion-ledger");
    await refuse(tombstoned, "CUTOVER_ERASED_PARTICIPANT_PRESENT", "P6 match");
    // ... and a projection that is not this seal's.
    await refuse({ ledgerSeal: await readCutoverSeal({ manifestPath: tombstoned.manifest, expectedSealId: tombstoned.sealId }) },
      "CUTOVER_PROJECTION_SEAL_MISMATCH", "P6 projection");
    // P7 bootstrap, P8 pin and key version, P9 controls.
    await refuse(await variant("UPDATE community_public_source_bootstrap SET completed = 0"),
      "CUTOVER_PUBLIC_SOURCE_BOOTSTRAP_INCOMPLETE", "P7");
    await refuse({ pinSecret: "ept8-some-other-identity-link-secret-0000000" }, "CUTOVER_IDENTITY_LINK_SECRET_MISMATCH", "P8 pin");
    await refuse({ inputs: { expectedIdentityKeyVersion: "other-v1" } }, "CUTOVER_IDENTITY_LINK_VERSION_MISMATCH", "P8 version");
    // P8 against the committed production desired state: the mount the service template uses.
    const { secrets } = JSON.parse(await readFile(join(WORKER_ROOT, PRODUCTION_DESIRED_STATE_FILE), "utf8"));
    const mounting = async version => ({ desiredStatePath: await desiredStateFile({
      secrets: { ...secrets, IDENTITY_LINK_SECRET: { ...IDENTITY_MOUNT, version } } }) });
    await refuse({}, "CUTOVER_IDENTITY_LINK_MOUNT_MISMATCH", "P8 another mounted version", await mounting("4"));
    await refuse({}, "CUTOVER_IDENTITY_LINK_MOUNT_UNPINNED", "P8 unpinned mount", await mounting(null));
    await refuse({}, "CUTOVER_DESIRED_STATE_INVALID", "desired-state placeholder",
      { desiredStatePath: await desiredStateFile({ project: null }) });
    await refuse(await variant(`UPDATE collection_controls SET control_state = 'contained', enrollment_enabled = 0,
      upload_registration_enabled = 0, processing_enabled = 0, publication_enabled = 0`),
    "CUTOVER_CONTROLS_DEGRADE_IMPOSSIBLE", "P9");
    // P10: a non-empty target, an inherited membership.
    await target.adminPrimary.query(`INSERT INTO ${table("pending_objects")}(contribution_id, object_key)
      VALUES ('ept8-tamper', 'telemetry/ept8-tamper')`);
    await refuse({}, "CUTOVER_TARGET_NOT_EMPTY", "P10 non-empty");
    await target.adminPrimary.query(`DELETE FROM ${table("pending_objects")} WHERE contribution_id = 'ept8-tamper'`);
    await admin.query(`GRANT "${cluster.roles.owner}" TO "${cluster.roles.transfer}" WITH INHERIT TRUE`);
    try {
      await refuse({}, "CUTOVER_TRANSFER_LOGIN_MEMBERSHIP_INVALID", "P10 inherit");
    } finally {
      await admin.query(`GRANT "${cluster.roles.owner}" TO "${cluster.roles.transfer}" WITH INHERIT FALSE`);
    }
    // P10: a privilege on the transfer control schema or a relation in it, PUBLIC
    // (grantee 0, no pg_roles row) included: PT-1's flip-gate predicate, before the import.
    for (const [grant, revoke] of [
      ["GRANT USAGE ON SCHEMA tibotattle_transfer TO PUBLIC", "REVOKE USAGE ON SCHEMA tibotattle_transfer FROM PUBLIC"],
      ["GRANT SELECT ON tibotattle_transfer.transfer_runs TO PUBLIC", "REVOKE SELECT ON tibotattle_transfer.transfer_runs FROM PUBLIC"],
    ]) {
      await target.adminPrimary.query(grant);
      try {
        await refuse({}, "CUTOVER_TRANSFER_LOGIN_MEMBERSHIP_INVALID", `P10 ${grant}`);
      } finally {
        await target.adminPrimary.query(revoke);
      }
    }
    // P13: a present but disabled transfer-hold guard refuses, and the owner
    // flag (passed through preflight's filter) never excuses it.
    const holds = table(PENDING_OBJECT_TRANSFER_HOLD_TABLE);
    await target.adminPrimary.query(`ALTER TABLE ${holds} DISABLE TRIGGER ${PENDING_OBJECT_TRANSFER_HOLD_GUARD}`);
    try {
      await refuse({}, "CUTOVER_PENDING_OBJECT_GUARD_MISSING", "P13 disabled guard");
      await refuse({ inputs: { ownerFlags: [OWNER_FLAG_PERFORMANCE_ROUTES_RETIRED, OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING] } },
        "CUTOVER_PENDING_OBJECT_GUARD_MISSING", "P13 disabled guard with the owner flag");
    } finally {
      await target.adminPrimary.query(`ALTER TABLE ${holds} ENABLE TRIGGER ${PENDING_OBJECT_TRANSFER_HOLD_GUARD}`);
    }
    // P11 scheduler (the producer's shape; DB-free cases are in the check), P12 the OWN-4 facts.
    await refuse({ scheduler: { triggers: pausedTriggers().map(trigger => ({ ...trigger, liveState: "ENABLED", verdict: "running" })) } },
      "CUTOVER_SCHEDULER_NOT_PAUSED", "P11 running");
    await refuse({ scheduler: { checkedAt: "2026-10-01T23:00:00.000Z" } }, "CUTOVER_SCHEDULER_NOT_PAUSED", "P11 before fence");
    await refuse({ scheduler: { project: "tibotattle-another" } }, "CUTOVER_SCHEDULER_NOT_PAUSED", "P11 another project");
    await refuse({ scheduler: { triggers: [...pausedTriggers(), { ...pausedTriggers()[0], job: "synthetic-unmanaged" }] } },
      "CUTOVER_SCHEDULER_NOT_PAUSED", "P11 an unmanaged trigger");
    // A trigger the desired state manages but the probe does not report.
    const { scheduler: committedScheduler } = JSON.parse(await readFile(join(WORKER_ROOT, PRODUCTION_DESIRED_STATE_FILE), "utf8"));
    await refuse({}, "CUTOVER_SCHEDULER_NOT_PAUSED", "P11 a managed trigger unreported", { desiredStatePath:
      await desiredStateFile({ scheduler: { ...committedScheduler,
        "synthetic-managed": { name: "tibotattle-synthetic-managed-trigger", schedule: null, state: "PAUSED" } } }) });
    const own4 = async (overrides) => {
      const directory = await ownerDirectory(target);
      const inputs = JSON.parse(await readFile(join(directory, OWNER_FILES.inputs), "utf8"));
      const replaced = await privateDirectory("ept8-own4-");
      await writePrivateFileOnce(join(replaced, OWNER_FILES.inputs), `${JSON.stringify({ ...inputs,
        interimPublicRead: { ...inputs.interimPublicRead, ...overrides } })}\n`, 0o400);
      for (const name of [OWNER_FILES.pin]) {
        await writePrivateFileOnce(join(replaced, name), await readFile(join(directory, name)), 0o400);
      }
      return codeOf(runPreflight(await context(target, replaced)));
    };
    expect(await own4({ capturedAt: "2026-10-02T00:30:00.000Z" })).toBe("CUTOVER_INTERIM_READ_FACTS_INVALID");
    expect(await own4({ sourceCommit: "c".repeat(40) })).toBe("CUTOVER_INTERIM_READ_FACTS_INVALID");
    expect(await own4({ sha256: "d".repeat(64) })).toMatch(/^INTERIM_PUBLIC_READ_/u);
    // P15: the admin history export must be this seal's, byte for byte.
    const mainExport = await adminHistoryExportFor(manifestPath, seal.manifest.sealId);
    await refuse({ inputs: { adminHistoryExport: { ...mainExport, sha256: "d".repeat(64) } } },
      "CUTOVER_ADMIN_HISTORY_EXPORT_INVALID", "P15 another digest");
    const otherSeal = await variant("INSERT INTO sparkle_appcast_guard_nonces(nonce, expires_at) VALUES ('ept8-p15-nonce', 1)");
    const otherExport = await adminHistoryExportFor(otherSeal.manifest, otherSeal.sealId);
    expect(otherExport.sha256).not.toBe(mainExport.sha256);
    await refuse({ inputs: { adminHistoryExport: otherExport } }, "CUTOVER_ADMIN_HISTORY_EXPORT_MISMATCH",
      "P15 another seal's export");
    // Nothing above wrote to the target.
    expect(await targetRows(target)).toBe(0);

    // A GO preflight; the dry run and a wrong token write nothing; the locks refuse a second orchestrator.
    const directory = await ownerDirectory(target);
    const preflight = await runPreflight(await context(target, directory));
    const dry = await runImport(await context(target, directory));
    expect(dry).toMatchObject({ mode: "dry-run", authorizationToken: preflight.runAuthorizationToken, resumed: false });
    expect(await codeOf(runImport(await context(target, directory), { execute: true, confirm: "e".repeat(64) })))
      .toBe("CUTOVER_AUTHORIZATION_MISMATCH");
    // Round 16: an unrotated run declares no rotation, so a rotation token is refused too.
    expect(preflight.identityRotationAuthorizationToken).toBeUndefined();
    expect(await codeOf(runImport(await context(target, directory), { execute: true, confirm: preflight.runAuthorizationToken,
      confirmIdentityRotation: "e".repeat(64) }))).toBe("CUTOVER_AUTHORIZATION_MISMATCH");
    const holder = new pg.Client({ ...await localSocket(PG_TEST_SOCKET, PG_TEST_PORT), user: PG_TEST_USER,
      password: PG_TEST_PASSWORD, database: target.databases.primary, ssl: false });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [ORCHESTRATOR_LOCK_KEY]);
      expect(await codeOf(runImport(await context(target, directory), { execute: true, confirm: preflight.runAuthorizationToken })))
        .toBe("CUTOVER_ORCHESTRATOR_BUSY");
      await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [ORCHESTRATOR_LOCK_KEY]);
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`${MIGRATION_FENCE_LOCK_PREFIX}${PRIMARY_SCHEMA}`]);
      expect(await codeOf(runImport(await context(target, directory), { execute: true, confirm: preflight.runAuthorizationToken })))
        .toBe("CUTOVER_MIGRATION_FENCE_HELD");
    } finally {
      await holder.end();
    }
    expect(await targetRows(target)).toBe(0);
    // run --execute proves P11 and P10 again before any write: a GO preflight
    // does not outlive the scheduler evidence or the login's memberships.
    const authorization = { execute: true, confirm: preflight.runAuthorizationToken };
    expect(await codeOf(runImport(await context(target, directory, { now: () => new Date("2026-10-02T06:30:00.001Z") }),
      authorization))).toBe("CUTOVER_SCHEDULER_NOT_PAUSED");
    await admin.query(`GRANT "${cluster.roles.owner}" TO "${cluster.roles.transfer}" WITH INHERIT TRUE`);
    try {
      expect(await codeOf(runImport(await context(target, directory), authorization)))
        .toBe("CUTOVER_TRANSFER_LOGIN_MEMBERSHIP_INVALID");
    } finally {
      await admin.query(`GRANT "${cluster.roles.owner}" TO "${cluster.roles.transfer}" WITH INHERIT FALSE`);
    }
    expect(await targetRows(target)).toBe(0);

    // Ordering inside a run: killed after PT-3, nothing past 'run' is admitted.
    expect(await codeOf(runImport(await context(target, directory, killAfter("stage:identity-authority")), authorization)))
      .toBe("synthetic kill");
    // A published day (only a refresh writes one) ends the frozen read: a resumed preflight refuses.
    // Since the run stamps (primary 0069) a published day names its kernel
    // and manifest version; the replica role skips the kernel foreign key.
    await tamper(target, `INSERT INTO ${table("analytics_v2_published_daily")}(day, revision, released_at, payload,
        payload_sha256, run_id, kernel_id, manifest_version)
      VALUES ('2026-10-01', 1, clock_timestamp(),
        '{"day":"2026-10-01","revision":1,"aggregateId":"community-daily:2026-10-01:r1"}'::jsonb, repeat('0', 64),
        '00000000-0000-4000-8000-000000000001', 1, 1)`);
    await refuse({}, "CUTOVER_TARGET_FROZEN_READ_TABLE_MISSING", "P10 published day");
    await tamper(target, `DELETE FROM ${table("analytics_v2_published_daily")} WHERE day = '2026-10-01'`);
    const early = await flipEvidence("before-verified");
    expect(await codeOf(releaseControls(await context(target, directory), { flipEvidencePath: early.path })))
      .toBe("CUTOVER_STEP_ORDER_VIOLATION");
    expect(await codeOf(flipGate(await context(target, directory), { flipEvidencePath: early.path })))
      .toBe("CUTOVER_STEP_ORDER_VIOLATION");
    expect(await codeOf(markLiveStep(await context(target, directory), { flipEvidenceSha256: early.sha256 })))
      .toBe("CUTOVER_STEP_ORDER_VIOLATION");
    expect(await codeOf(runImport(await context(target, directory, killAfter("stage:pending-registrations")), authorization)))
      .toBe("synthetic kill");
    // owner-lifecycle-verify: a target owner revision that differs from the seal.
    expect(await codeOf(runImport(await context(target, directory, killAfter("stage:ingestion-journal")), authorization)))
      .toBe("synthetic kill");
    const [revision] = await tamper(target, `UPDATE ${table("storage_owner_revisions")} SET authority_epoch = authority_epoch + 1
      WHERE (source_id, owner_digest) = (SELECT source_id, owner_digest FROM ${table("storage_owner_revisions")}
        ORDER BY owner_digest LIMIT 1) RETURNING source_id, owner_digest`);
    expect(await codeOf(runImport(await context(target, directory), authorization))).toBe("CUTOVER_OWNER_REVISIONS_DIVERGED");
    await tamper(target, `UPDATE ${table("storage_owner_revisions")} SET authority_epoch = authority_epoch - 1
      WHERE source_id = $1 AND owner_digest = $2`, [revision.source_id, revision.owner_digest]);
    // Post-import TL-1: a typed identity at or below max(id) once the restart
    // has run (a restart that did not take effect) refuses before anything
    // later in post-import.
    const restartFunction = `${table("typed_telemetry_restart_identities")}()`;
    const [restartDefinition] = (await target.adminPrimary.query(
      `SELECT pg_get_functiondef($1::regprocedure) AS sql`, [restartFunction])).rows;
    let headroomTable;
    for (const name of TYPED_IDENTITY_TABLES) {
      const { rows } = await target.adminPrimary.query(`SELECT COALESCE(max(id), 0)::int AS maximum FROM ${table(name)}`);
      if (rows[0].maximum >= 1) {
        headroomTable = name;
        break;
      }
    }
    expect(headroomTable).toBeDefined();
    await target.adminPrimary.query(`CREATE OR REPLACE FUNCTION ${restartFunction} RETURNS void LANGUAGE plpgsql AS $$
      BEGIN END; $$`);
    try {
      await target.adminPrimary.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), 1, false)`, [table(headroomTable)]);
      expect(await codeOf(runImport(await context(target, directory), authorization))).toBe("CUTOVER_TYPED_IDENTITY_HEADROOM_INVALID");
    } finally {
      await target.adminPrimary.query(restartDefinition.sql);
    }
    // Post-import: a pending object that is not a sealed registration.
    await target.adminPrimary.query(`INSERT INTO ${table("pending_objects")}(contribution_id, object_key)
      VALUES ('ept8-tamper', 'telemetry/ept8-tamper')`);
    expect(await codeOf(runImport(await context(target, directory), authorization))).toBe("CUTOVER_PENDING_OBJECT_CONFLICT");
    await target.adminPrimary.query(`DELETE FROM ${table("pending_objects")} WHERE contribution_id = 'ept8-tamper'`);
    // Post-import, Variant B step 4: a target participant on the do-not-restore list (the fixture's erased participant).
    const plant = id => tamper(target, `INSERT INTO ${table("participants")}(id, owner_kind, state, created_at)
      VALUES ($1, 'social', 'active', clock_timestamp())`, [id]);
    const unplant = id => tamper(target, `DELETE FROM ${table("participants")} WHERE id = $1`, [id]);
    expect(participantIds).not.toContain(world.fixture.ids.erasedParticipant);
    await plant(world.fixture.ids.erasedParticipant);
    expect(await codeOf(runImport(await context(target, directory), authorization))).toBe("CUTOVER_ERASED_PARTICIPANT_PRESENT");
    await unplant(world.fixture.ids.erasedParticipant);
    // Post-import: public-source owners that differ from the sealed view (an extra eligible social participant).
    await plant("participant:ept8-planted-social-owner");
    expect(await codeOf(runImport(await context(target, directory), authorization))).toBe("CUTOVER_PUBLIC_SOURCE_OWNERS_DIVERGED");
    await unplant("participant:ept8-planted-social-owner");
    // Post-import: the parity sample over independent engine SQL (a chunk's record count edited on the target).
    const [chunk] = await tamper(target, `UPDATE ${table("telemetry_v11_chunks")} SET record_count = record_count + 1
      WHERE id = (SELECT id FROM ${table("telemetry_v11_chunks")} WHERE record_count < 200 ORDER BY id LIMIT 1) RETURNING id`);
    expect(await codeOf(runImport(await context(target, directory), authorization))).toBe("CUTOVER_PARITY_SAMPLE_MISMATCH");
    await tamper(target, `UPDATE ${table("telemetry_v11_chunks")} SET record_count = record_count - 1 WHERE id = $1`, [chunk.id]);
    // Post-import: the bootstrap singleton and a runtime-reset table must be at their seed.
    await tamper(target, `UPDATE ${table("community_public_source_bootstrap")} SET completed = 0`);
    expect(await codeOf(runImport(await context(target, directory), authorization))).toBe("CUTOVER_BOOTSTRAP_TARGET_INVALID");
    await tamper(target, `UPDATE ${table("community_public_source_bootstrap")} SET completed = 1`);
    await tamper(target, `INSERT INTO ${table("community_model_composition_days")}(day, payload_json, computed_at)
      VALUES ('2026-10-01', '{}', clock_timestamp())`);
    expect(await codeOf(runImport(await context(target, directory), authorization))).toBe("CUTOVER_RUNTIME_RESET_NOT_AT_SEED");
    await tamper(target, `DELETE FROM ${table("community_model_composition_days")} WHERE day = '2026-10-01'`);
    // Coverage finalize: a table receipt with another token, one naming an unknown table, and one missing.
    const receiptRow = "source_role = 'ingestion' AND source_table = 'participants'";
    const receiptTable = "tibotattle_transfer.transfer_table_receipts";
    await tamper(target, `UPDATE ${receiptTable} SET disposition = 'imported:legacy-contributions' WHERE ${receiptRow}`);
    expect(await codeOf(runImport(await context(target, directory), authorization))).toBe("CUTOVER_COVERAGE_RECEIPT_MISMATCH");
    await tamper(target, `UPDATE ${receiptTable} SET disposition = 'imported:identity-authority' WHERE ${receiptRow}`);
    await tamper(target, `UPDATE ${receiptTable} SET source_table = 'zz_ept8_unknown' WHERE ${receiptRow}`);
    expect(await codeOf(runImport(await context(target, directory), authorization))).toBe("CUTOVER_COVERAGE_RECEIPT_UNEXPECTED");
    await tamper(target, `UPDATE ${receiptTable} SET source_table = 'participants'
      WHERE source_role = 'ingestion' AND source_table = 'zz_ept8_unknown'`);
    const [removed] = await tamper(target, `DELETE FROM ${receiptTable} receipt WHERE ${receiptRow} RETURNING to_jsonb(receipt) AS row`);
    expect(await codeOf(runImport(await context(target, directory), authorization))).toBe("CUTOVER_COVERAGE_RECEIPT_MISSING");
    await tamper(target, `INSERT INTO ${receiptTable} SELECT * FROM jsonb_populate_record(NULL::${receiptTable}, $1::jsonb)`,
      [JSON.stringify(removed.row)]);
    // A complete post-import stage needs its owner receipt: without it a rerun refuses, and with it resumes.
    expect(await codeOf(runImport(await context(target, directory, killAfter("post-import")), authorization)))
      .toBe("synthetic kill");
    const receiptPath = join(directory, OWNER_FILES.postImport);
    await rename(receiptPath, `${receiptPath}.moved`);
    expect(await codeOf(runImport(await context(target, directory), authorization))).toBe("CUTOVER_RECEIPT_CONFLICT");
    await rename(`${receiptPath}.moved`, receiptPath);
    const finished = await runImport(await context(target, directory), authorization);
    expect(finished.runState).toBe("verified");
    // Flip evidence taken before 'verified' is stale; tampered evidence is invalid.
    expect(await codeOf(releaseControls(await context(target, directory), { flipEvidencePath: early.path })))
      .toBe("CUTOVER_FLIP_EVIDENCE_STALE");
    const fresh = await flipEvidence("tamper");
    const tampered = JSON.parse(await readFile(fresh.path, "utf8"));
    tampered.sources[0].bookmark = "tampered-bookmark";
    const tamperDirectory = await privateDirectory("ept8-tamper-");
    const tamperedPath = join(tamperDirectory, "flip-evidence.json");
    await writePrivateFileOnce(tamperedPath, `${JSON.stringify(tampered)}\n`, 0o400);
    expect(await codeOf(releaseControls(await context(target, directory), { flipEvidencePath: tamperedPath })))
      .toBe("CUTOVER_FLIP_EVIDENCE_INVALID");
    // Abandon (pre-live): dry run, token, then the target is spent for any later run.
    const abandonDry = await abandon(await context(target, directory));
    expect(await codeOf(abandon(await context(target, directory), { execute: true, confirm: preflight.runAuthorizationToken })))
      .toBe("CUTOVER_AUTHORIZATION_MISMATCH");
    expect((await abandon(await context(target, directory), { execute: true, confirm: abandonDry.authorizationToken })).runState)
      .toBe("abandoned");
    expect(await codeOf(runImport(await context(target, directory), { execute: true, confirm: preflight.runAuthorizationToken })))
      .toBe("CUTOVER_TARGET_NOT_EMPTY");
  }, 900_000);

  it("refuses each finalize condition: flip-2 before the release, a second flip-1, nonces and the frozen read", async () => {
    const target = cluster.targets[4];
    // A seal whose one Sparkle nonce expires an hour after CONTEXT_NOW.
    const forged = await forgeVariantSeal(seal, `INSERT INTO sparkle_appcast_guard_nonces(nonce, expires_at)
      VALUES ('ept8-synthetic-nonce', ${Date.parse("2026-10-02T03:00:00.000Z") / 1000})`);
    const variantSeal = { manifest: forged.manifestPath, sealId: forged.sealId };
    const directory = await ownerDirectory(target, variantSeal);
    const { preflight } = await runToVerified(target, directory);
    expect(preflight.checks.P14.unexpiredAtSeal).toBe(1);
    const at = now => context(target, directory, { now: () => new Date(now) });
    const later = "2026-10-02T04:00:00.000Z";

    // F1, then a second verify-unchanged BEFORE the release, then F2 with the first.
    const flip1 = await flipEvidence("final-flip1", variantSeal);
    const between = await flipEvidence("final-between", variantSeal);
    const dry = await releaseControls(await context(target, directory), { flipEvidencePath: flip1.path });
    const released = await releaseControls(await context(target, directory), { flipEvidencePath: flip1.path, execute: true,
      confirm: dry.authorizationToken });
    const receipt = JSON.parse(await readFile(join(directory, OWNER_FILES.release), "utf8"));
    expect(receipt.releasedAt).toBe(released.releasedAt);
    expect(Date.parse(receipt.releasedAt)).toBeGreaterThan(Date.parse(JSON.parse(await readFile(between.path, "utf8")).verifiedAt));
    // A rerun keeps the first release instant; another flip-1 for the same release conflicts before any write.
    expect((await releaseControls(await context(target, directory), { flipEvidencePath: flip1.path, execute: true,
      confirm: dry.authorizationToken })).releaseSha256).toBe(released.releaseSha256);
    expect(await codeOf(releaseControls(await context(target, directory), { flipEvidencePath: between.path })))
      .toBe("CUTOVER_RECEIPT_CONFLICT");
    // F4: evidence taken after E1 but before the release is not flip-2.
    expect(await codeOf(flipGate(await at(later), { flipEvidencePath: between.path }))).toBe("CUTOVER_FLIP_EVIDENCE_STALE");
    const flip2 = await flipEvidence("final-flip2", variantSeal);
    await assertNoForeignTransferMembers();
    // F4: a sealed Sparkle nonce still unexpired at the gate.
    expect(await codeOf(flipGate(await context(target, directory), { flipEvidencePath: flip2.path })))
      .toBe("CUTOVER_SPARKLE_NONCES_UNEXPIRED");
    // F4: the frozen read is gone.
    let restore = await removeFrozenRead(target);
    expect(await codeOf(flipGate(await at(later), { flipEvidencePath: flip2.path }))).toBe("CUTOVER_INTERIM_READ_NOT_LOADED");
    await restore();
    // F4: a row with id = 1 is not enough; it must be the export post-import
    // loaded (post-import.json), not another one loaded in its place.
    restore = await swapFrozenRead(target);
    expect(await codeOf(flipGate(await at(later), { flipEvidencePath: flip2.path }))).toBe("CUTOVER_INTERIM_READ_NOT_LOADED");
    await restore();
    const gate = await flipGate(await at(later), { flipEvidencePath: flip2.path });
    const gateBody = JSON.parse(await readFile(join(directory, OWNER_FILES.flipGate), "utf8"));
    const postImportBody = JSON.parse(await readFile(join(directory, OWNER_FILES.postImport), "utf8"));
    expect(gateBody.interimReadPayloadSha256).toBe(postImportBody.interimRead.payloadSha256);
    expect(gate.ready).toBe(true);
    // F5 re-proves the frozen read immediately before live.
    const authorization = { flipEvidenceSha256: flip2.sha256, execute: true, confirm: gate.markLiveAuthorizationToken };
    restore = await removeFrozenRead(target);
    expect(await codeOf(markLiveStep(await context(target, directory), authorization))).toBe("CUTOVER_INTERIM_READ_NOT_LOADED");
    await restore();
    expect((await markLiveStep(await context(target, directory), authorization)).state).toBe("live");
  }, 900_000);

  it("round 16: rotates the lost identity-link secret at cutover only under its own token and receipt", async () => {
    await assertNoForeignTransferMembers();
    const target = cluster.targets[5];
    const refuse = async (options, expected, label, contextOptions = {}) => {
      const directory = await ownerDirectory(target, options);
      expect(await codeOf(runPreflight(await context(target, directory, contextOptions))), label).toBe(expected);
      expect(await readdir(directory), label).not.toContain(OWNER_FILES.preflight);
    };
    const rotation = { secret: ROTATED_SECRET };
    const sealedFingerprint = identityLinkFingerprint(SYNTHETIC_IDENTITY_LINK_SECRET);
    const rotatedFingerprint = identityLinkFingerprint(ROTATED_SECRET);
    const readPin = async () => (await target.ownerPrimary.query(`SELECT key_version, secret_fingerprint
      FROM ${table("identity_link_secret_configuration")}`)).rows;

    // The new secret's pin WITHOUT the rotation receipt never passes P8: under
    // the sealed label (the secret differs) or the rotated one (so does the row).
    await refuse({ pinSecret: ROTATED_SECRET }, "CUTOVER_IDENTITY_LINK_SECRET_MISMATCH", "new secret, old label");
    await refuse({ pinSecret: ROTATED_SECRET, pinKeyVersion: ROTATED_VERSION,
      inputs: { expectedIdentityKeyVersion: ROTATED_VERSION } }, "CUTOVER_IDENTITY_LINK_SECRET_MISMATCH", "new secret, new label");
    // P8-R refusals, before any target write.
    await refuse({ rotation, inputs: { expectedIdentityKeyVersion: "production-v3" } },
      "CUTOVER_IDENTITY_LINK_VERSION_MISMATCH", "a wrong key version");
    await refuse({ rotation: { ...rotation, fromFingerprint: "f".repeat(64) } }, "CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH",
      "from is not the sealed row");
    await refuse({ rotation, inputs: { identityLinkRotation: { rotationSha256: "a".repeat(64) } } },
      "CUTOVER_IDENTITY_ROTATION_INVALID", "the inputs name another rotation document");
    // A self-consistent rotation to a label the origin does not run (the pin,
    // the document and the inputs all agree on it, and the inputs carry its
    // digest) never passes: the labels are the origin's configuration.
    for (const label of ["production-v3", "staging-v1"]) {
      const forged = await ownerDirectory(target, { rotation });
      const rewrite = async (name, text) => {
        const path = join(forged, name);
        await chmod(path, 0o600);
        await writeFile(path, text);
        await chmod(path, 0o400);
      };
      const ownerJson = async name => JSON.parse(await readFile(join(forged, name), "utf8"));
      const document = await ownerJson(OWNER_FILES.rotation);
      const documentText = `${JSON.stringify({ ...document, to: { ...document.to, keyVersion: label } })}\n`;
      await rewrite(OWNER_FILES.pin, `${JSON.stringify({ ...await ownerJson(OWNER_FILES.pin), keyVersion: label })}\n`);
      await rewrite(OWNER_FILES.rotation, documentText);
      await rewrite(OWNER_FILES.inputs, `${JSON.stringify({ ...await ownerJson(OWNER_FILES.inputs),
        expectedIdentityKeyVersion: label,
        identityLinkRotation: { rotationSha256: createHash("sha256").update(documentText).digest("hex") } })}\n`);
      expect(await codeOf(runPreflight(await context(target, forged))), label).toBe("CUTOVER_IDENTITY_LINK_VERSION_MISMATCH");
      expect(await readdir(forged), label).not.toContain(OWNER_FILES.preflight);
    }
    await refuse({ rotation }, "CUTOVER_IDENTITY_ROTATION_CONSUMER_PORTED", "a ported consumer",
      { portedRouteIds: ["health", "enroll"] });
    const { secrets } = JSON.parse(await readFile(join(WORKER_ROOT, PRODUCTION_DESIRED_STATE_FILE), "utf8"));
    const mounting = async version => ({ desiredStatePath: await desiredStateFile({
      secrets: { ...secrets, IDENTITY_LINK_SECRET: { ...IDENTITY_MOUNT, version } } }) });
    await refuse({ rotation }, "CUTOVER_IDENTITY_LINK_MOUNT_UNPINNED", "an unpinned mount", await mounting(null));
    await refuse({ rotation }, "CUTOVER_IDENTITY_LINK_MOUNT_MISMATCH", "another mounted version", await mounting("4"));
    // Tamper-evident: an edited rotation document no longer hashes to the inputs' digest.
    const tampered = await ownerDirectory(target, { rotation });
    const rotationPath = join(tampered, OWNER_FILES.rotation);
    const document = JSON.parse(await readFile(rotationPath, "utf8"));
    await chmod(rotationPath, 0o600);
    // A schema-valid edit (another computedAt): only the digest notices it.
    await writeFile(rotationPath, `${JSON.stringify({ ...document, computedAt: "2026-10-02T02:00:00.001Z" })}\n`);
    await chmod(rotationPath, 0o400);
    expect(await codeOf(runPreflight(await context(target, tampered)))).toBe("CUTOVER_IDENTITY_ROTATION_INVALID");
    expect(await targetRows(target)).toBe(0);

    // GO: P8-R and a second token.
    const directory = await ownerDirectory(target, { rotation });
    const preflight = await runPreflight(await context(target, directory));
    expect(preflight.checks.P8).toMatchObject({ keyVersion: ROTATED_VERSION, secretVersion: IDENTITY_MOUNT.version,
      rotation: { fromKeyVersion: SEALED_IDENTITY_LINK_VERSION, toKeyVersion: ROTATED_VERSION, consumersRetired: 9 } });
    expect(preflight.identityRotationAuthorizationToken).toMatch(/^[0-9a-f]{64}$/u);
    expect(preflight.identityRotationAuthorizationToken).not.toBe(preflight.runAuthorizationToken);
    const dry = await runImport(await context(target, directory));
    expect(dry).toMatchObject({ mode: "dry-run", authorizationToken: preflight.runAuthorizationToken,
      identityRotationAuthorizationToken: preflight.identityRotationAuthorizationToken });
    // No rotation without the token: the run token alone, or a wrong one, writes nothing.
    const runOnly = { execute: true, confirm: preflight.runAuthorizationToken };
    expect(await codeOf(runImport(await context(target, directory), runOnly))).toBe("CUTOVER_AUTHORIZATION_MISMATCH");
    expect(await codeOf(runImport(await context(target, directory), { ...runOnly,
      confirmIdentityRotation: preflight.runAuthorizationToken }))).toBe("CUTOVER_AUTHORIZATION_MISMATCH");
    expect(await targetRows(target)).toBe(0);
    const authorization = { ...runOnly, confirmIdentityRotation: preflight.identityRotationAuthorizationToken };

    // Killed inside the rotation transaction, after the UPDATE and before the
    // receipt: everything rolls back, PT-3's verbatim copy stays the sealed row.
    expect(await codeOf(runImport(await context(target, directory, killAfter("identity-link-rotation:updated")),
      authorization))).toBe("synthetic kill");
    expect(await readPin()).toEqual([{ key_version: SEALED_IDENTITY_LINK_VERSION, secret_fingerprint: sealedFingerprint }]);
    let stages = (await receipts(target)).stages;
    expect(stages.find(row => row.stage === "identity-authority")?.state).toBe("complete");
    expect(stages.some(row => row.stage === "identity-link-rotation")).toBe(false);
    // Resumed and killed right after the rotation commits; then the pin is
    // set back to `from` behind the orchestrator's back: post-import refuses.
    expect(await codeOf(runImport(await context(target, directory, killAfter("stage:identity-link-rotation")),
      authorization))).toBe("synthetic kill");
    expect(await readPin()).toEqual([{ key_version: ROTATED_VERSION, secret_fingerprint: rotatedFingerprint }]);
    await tamper(target, `UPDATE ${table("identity_link_secret_configuration")} SET key_version = $1, secret_fingerprint = $2`,
      [SEALED_IDENTITY_LINK_VERSION, sealedFingerprint]);
    expect(await codeOf(runImport(await context(target, directory), authorization)))
      .toBe("CUTOVER_IDENTITY_ROTATION_STATE_INVALID");
    await tamper(target, `UPDATE ${table("identity_link_secret_configuration")} SET key_version = $1, secret_fingerprint = $2`,
      [ROTATED_VERSION, rotatedFingerprint]);
    const finished = await runImport(await context(target, directory), authorization);
    expect(finished.runState).toBe("verified");

    // The receipts: PT-3's one verbatim table receipt for the pin table, and
    // the rotation's own stage receipt and checkpoint.
    const all = await receipts(target);
    const pinReceipts = all.tables.filter(row => row.source_table === "identity_link_secret_configuration");
    expect(pinReceipts).toHaveLength(1);
    expect(pinReceipts[0]).toMatchObject({ stage: "identity-authority", disposition: "imported:identity-authority",
      state: "complete" });
    expect(pinReceipts[0].target_sha256).toBe(pinReceipts[0].source_sha256);
    expect(all.stages.find(row => row.stage === "identity-link-rotation")).toMatchObject({ state: "complete", row_count: "1" });
    const { rows: checkpoint } = await target.ownerPrimary.query(`SELECT state, row_count::int AS row_count,
        prefix_chain_sha256, last_key
      FROM tibotattle_transfer.transfer_checkpoints WHERE stage = 'identity-link-rotation'`);
    const inputs = JSON.parse(await readFile(join(directory, OWNER_FILES.inputs), "utf8"));
    expect(checkpoint).toEqual([{ state: "complete", row_count: 1,
      prefix_chain_sha256: inputs.identityLinkRotation.rotationSha256, last_key: null }]);
    const postImport = JSON.parse(await readFile(join(directory, OWNER_FILES.postImport), "utf8"));
    expect(postImport.invariants.identityLink).toEqual({ mode: "rotated", keyVersion: ROTATED_VERSION,
      rotationSha256: inputs.identityLinkRotation.rotationSha256 });
    // A rerun of the verified run is a no-op.
    expect((await runImport(await context(target, directory), authorization)).stagesRun).toEqual([]);

    // Finalize: the flip gate re-asserts the rotated pin and the receipt.
    const flip1 = await flipEvidence("rotation-flip1");
    const releaseDry = await releaseControls(await context(target, directory), { flipEvidencePath: flip1.path });
    await releaseControls(await context(target, directory), { flipEvidencePath: flip1.path, execute: true,
      confirm: releaseDry.authorizationToken });
    const flip2 = await flipEvidence("rotation-flip2");
    await tamper(target, `UPDATE ${table("identity_link_secret_configuration")} SET secret_fingerprint = $1`, ["e".repeat(64)]);
    expect(await codeOf(flipGate(await context(target, directory), { flipEvidencePath: flip2.path })))
      .toBe("CUTOVER_IDENTITY_ROTATION_STATE_INVALID");
    await tamper(target, `UPDATE ${table("identity_link_secret_configuration")} SET secret_fingerprint = $1`, [rotatedFingerprint]);
    const gate = await flipGate(await context(target, directory), { flipEvidencePath: flip2.path });
    expect(JSON.parse(await readFile(join(directory, OWNER_FILES.flipGate), "utf8")).identityLink.mode).toBe("rotated");
    const live = await markLiveStep(await context(target, directory), { flipEvidenceSha256: flip2.sha256, execute: true,
      confirm: gate.markLiveAuthorizationToken });
    expect(live.state).toBe("live");
    await target.adminPrimary.query(`UPDATE ${table("retention_state")} SET state = 'completed',
      last_started_at = date_trunc('milliseconds', now()), last_completed_at = date_trunc('milliseconds', now()),
      maintenance_run_at = date_trunc('milliseconds', now()), restore_replay_complete = true, quarantine_retention_complete = true`);
    await target.adminPrimary.query(`UPDATE ${table("quarantine_reconciliation_state")} SET state = 'completed',
      last_started_at = date_trunc('milliseconds', now()), last_completed_at = date_trunc('milliseconds', now()),
      maintenance_run_at = (SELECT maintenance_run_at FROM ${table("retention_state")})`);
    expect((await postLiveCheck(await context(target, directory, { now: () => new Date() }))).ready).toBe(true);
    await writeReport(await context(target, directory));
    const report = JSON.parse(await readFile(join(directory, OWNER_FILES.report), "utf8"));
    expect(report.receipts.rotation).toBe(inputs.identityLinkRotation.rotationSha256);

    // Content-free: neither secret nor either fingerprint leaves the pin,
    // rotation and sealed-pin documents.
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json") && !name.endsWith(".ndjson")) continue;
      if (["own4-export.json", OWNER_FILES.inputs, OWNER_FILES.pin, OWNER_FILES.rotation, "sealed-pin.json",
        "scheduler-probe.json"].includes(name)) continue;
      const text = await readFile(join(directory, name), "utf8");
      for (const value of [ROTATED_SECRET, SYNTHETIC_IDENTITY_LINK_SECRET, rotatedFingerprint, sealedFingerprint]) {
        expect(text.includes(value), name).toBe(false);
      }
    }
  }, 900_000);
});
