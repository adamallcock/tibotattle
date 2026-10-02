import { readFile, readdir, writeFile, chmod, mkdir } from "node:fs/promises";
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
import { verifyCutoverUnchanged } from "../scripts/cutover-source-fence.mjs";
import { participantDeletionDigest, projectDeletionDigests } from "../scripts/cutover-source-projections.mjs";
import { openSealedSourceFromSeal, readCutoverSeal, writePrivateFileOnce } from "../scripts/cutover-source-seal.mjs";
import {
  ORCHESTRATOR_LOCK_KEY,
  MIGRATION_FENCE_LOCK_PREFIX,
  OWNER_FILES,
  PRODUCTION_TRANSFER_INPUTS_SCHEMA,
  SCHEDULER_PROBE_SCHEMA,
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
  writeReport,
} from "../scripts/postgres-production-transfer.mjs";
import { DISPOSITIONS, OWNER_FLAG_PERFORMANCE_ROUTES_RETIRED, STAGE_PLAN } from "../scripts/postgres-transfer-coverage.mjs";
import { dropTransferStagingRelations, withTransferTransaction } from "../scripts/postgres-transfer-target.mjs";
import { createW2SealCluster, PRIMARY_SCHEMA, TRANSFER_ROLE, localSocket } from "./fixtures/w2-seal/pg-target.mjs";
import { forgeVariantSeal, headCommit, outputPathsOf, prepareSealWorld, sealWorld } from "./fixtures/w2-seal/seal-harness.mjs";
import { SYNTHETIC_BOOKMARKS, writeBarrierProofFixture, writeFenceReceiptFixture } from "./fixtures/w2-seal/fence-fixtures.mjs";
import {
  SYNTHETIC_IDENTITY_LINK_SECRET,
  SYNTHETIC_IDENTITY_LINK_VERSION,
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

  /** A fresh owner directory with pin, projection, OWN-4 export, scheduler evidence and inputs. */
  async function ownerDirectory(target, { manifest = manifestPath, sealId = seal.manifest.sealId, inputs = {},
    pinSecret = SYNTHETIC_IDENTITY_LINK_SECRET, ledgerSeal = null, scheduler = {} } = {}) {
    const directory = await privateDirectory("ept8-owner-");
    await writeIdentityPin({ ownerDirectory: directory, stream: Readable.from([`${pinSecret}\n`]),
      keyVersion: SYNTHETIC_IDENTITY_LINK_VERSION, secretName: "tibotattle-identity-link", secretVersion: "3",
      now: CONTEXT_NOW });
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
    await writePrivateFileOnce(join(directory, "scheduler-probe.json"), `${JSON.stringify({
      schema: SCHEDULER_PROBE_SCHEMA, environment: "production", project: "tibotattle-synthetic",
      checkedAt: "2026-10-02T00:30:00.000Z", thresholdHours: 25,
      triggers: [{ job: "maintenance", liveState: "PAUSED", verdict: "paused_as_desired" },
        { job: "analytics-refresh", liveState: "PAUSED", verdict: "paused_as_desired" }],
      alert: false, signal: null, ...scheduler })}\n`, 0o400);
    const value = {
      schema: PRODUCTION_TRANSFER_INPUTS_SCHEMA,
      contractId: target.contract.contractId,
      sealId,
      sealManifestPath: manifest,
      expectedSourceCommit: world.commit,
      fenceReceiptSha256: world.fence.sha256,
      expectedIdentityKeyVersion: SYNTHETIC_IDENTITY_LINK_VERSION,
      deletionDigestProjection: { path: projection.path, sha256: projection.sha256 },
      interimPublicRead: { exportPath: join(directory, "own4-export.json"), sha256: exportSha256(bytes),
        capturedAt: FIXTURE_CAPTURED_AT, sourceCommit: world.commit, evidenceDate: FIXTURE_EVIDENCE_DATE },
      schedulerEvidencePath: join(directory, "scheduler-probe.json"),
      ownerFlags: [OWNER_FLAG_PERFORMANCE_ROUTES_RETIRED],
      allowedRoleMembers: [],
      ...inputs,
    };
    await writePrivateFileOnce(join(directory, OWNER_FILES.inputs), `${JSON.stringify(value)}\n`, 0o400);
    return directory;
  }

  function context(target, directory, options = {}) {
    return createTransferContext({ ownerDirectory: directory, pool: target.transferPrimary, now: CONTEXT_NOW, ...options });
  }

  async function flipEvidence(directoryName) {
    const out = await privateDirectory(`ept8-${directoryName}-`);
    const result = await verifyCutoverUnchanged({ inventoryPath: world.inventory.path, manifestPath, sealId: seal.manifest.sealId,
      ownerDirectory: out, execute: true, remote: true, ownerReadOnly: true,
      transport: createFakeCutoverTransport({ sources: world.remotePaths, bookmarks: SYNTHETIC_BOOKMARKS }) });
    return { path: result.path, sha256: result.flipEvidenceSha256 };
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
    world = await prepareSealWorld({ commit });
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
    const run = await sealWorld(world, { overrides: { now: () => SEAL_NOW } });
    const sealed = await run.run();
    manifestPath = outputPathsOf(run.out).manifest;
    seal = await readCutoverSeal({ manifestPath, expectedSealId: sealed.sealId });
    cluster = await createW2SealCluster({ socket: PG_TEST_SOCKET, port: PG_TEST_PORT, user: PG_TEST_USER,
      password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE, count: 4, label: "ept8" });
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

  it("target-check passes on an empty registered target and reports content-free facts", async () => {
    const target = cluster.targets[3];
    const report = await targetCheck({ pool: target.transferPrimary, contractId: target.contract.contractId });
    expect(report.verdict).toBe("GO");
    expect(report.target.triggerTables).toBeGreaterThan(50);
  }, 120_000);

  it("drives a seal from preflight to live, resuming identically after a kill at every committed step", async () => {
    // tibotattle_source_transfer is cluster-global: a member left behind by
    // another suite makes PT-1's flip gate refuse, correctly. Fail loudly.
    const { rows: members } = await admin.query(`SELECT count(*)::int AS n FROM pg_auth_members am
      JOIN pg_roles role ON role.oid = am.roleid JOIN pg_roles member ON member.oid = am.member
     WHERE role.rolname = $1 AND member.rolname <> $2`, [TRANSFER_ROLE, cluster.roles.transfer]);
    if (members[0].n !== 0) {
      throw new Error(`ENVIRONMENT: ${members[0].n} foreign member(s) of ${TRANSFER_ROLE} on this cluster; use a clean cluster`);
    }
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
      "post-import:cleanup", "post-import", "verifying", "verified"]));
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
    await target.adminPrimary.query(`UPDATE ${table("retention_state")} SET state = 'completed',
      last_started_at = date_trunc('milliseconds', now()), last_completed_at = date_trunc('milliseconds', now()),
      maintenance_run_at = date_trunc('milliseconds', now()), restore_replay_complete = true, quarantine_retention_complete = true`);
    await target.adminPrimary.query(`UPDATE ${table("quarantine_reconciliation_state")} SET state = 'completed',
      last_started_at = date_trunc('milliseconds', now()), last_completed_at = date_trunc('milliseconds', now()),
      maintenance_run_at = (SELECT maintenance_run_at FROM ${table("retention_state")})`);
    expect((await postLiveCheck(await context(target, directory, { now: () => new Date() }))).ready).toBe(true);
    const report = await writeReport(await context(target, directory));
    expect(report.reportSha256).toMatch(/^[0-9a-f]{64}$/u);

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
    const refuse = async (options, expected, label) => {
      const directory = await ownerDirectory(target, options);
      expect(await codeOf(runPreflight(await context(target, directory))), label).toBe(expected);
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
    // P5: an owner link marked erased (an erasure still in flight).
    await refuse(await variant(`UPDATE storage_v11_owner_links SET state = 'erased'
      WHERE participant_id = (SELECT min(participant_id) FROM storage_v11_owner_links)`), "CUTOVER_OWNER_LINK_ERASED", "P5");
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
    // P11 scheduler, P12 the OWN-4 facts.
    await refuse({ scheduler: { triggers: [{ job: "maintenance", liveState: "ENABLED", verdict: "running" }] } },
      "CUTOVER_SCHEDULER_NOT_PAUSED", "P11 running");
    await refuse({ scheduler: { checkedAt: "2026-10-01T23:00:00.000Z" } }, "CUTOVER_SCHEDULER_NOT_PAUSED", "P11 before fence");
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
    // Nothing above wrote to the target.
    expect(await targetRows(target)).toBe(0);

    // A GO preflight; the dry run and a wrong token write nothing; the locks refuse a second orchestrator.
    const directory = await ownerDirectory(target);
    const preflight = await runPreflight(await context(target, directory));
    const dry = await runImport(await context(target, directory));
    expect(dry).toMatchObject({ mode: "dry-run", authorizationToken: preflight.runAuthorizationToken, resumed: false });
    expect(await codeOf(runImport(await context(target, directory), { execute: true, confirm: "e".repeat(64) })))
      .toBe("CUTOVER_AUTHORIZATION_MISMATCH");
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

    // Ordering inside a run: killed after PT-3, nothing past 'run' is admitted.
    expect(await codeOf(runImport(await context(target, directory, { onStep: (name) => {
      if (name === "stage:identity-authority") throw new Error("synthetic kill");
    } }), { execute: true, confirm: preflight.runAuthorizationToken }))).toBe("synthetic kill");
    const early = await flipEvidence("before-verified");
    expect(await codeOf(releaseControls(await context(target, directory), { flipEvidencePath: early.path })))
      .toBe("CUTOVER_STEP_ORDER_VIOLATION");
    expect(await codeOf(flipGate(await context(target, directory), { flipEvidencePath: early.path })))
      .toBe("CUTOVER_STEP_ORDER_VIOLATION");
    expect(await codeOf(markLiveStep(await context(target, directory), { flipEvidenceSha256: early.sha256 })))
      .toBe("CUTOVER_STEP_ORDER_VIOLATION");
    // A pending object that is not a sealed registration refuses post-import.
    expect(await codeOf(runImport(await context(target, directory, { onStep: (name) => {
      if (name === "stage:pending-registrations") throw new Error("synthetic kill");
    } }), { execute: true, confirm: preflight.runAuthorizationToken }))).toBe("synthetic kill");
    await target.adminPrimary.query(`INSERT INTO ${table("pending_objects")}(contribution_id, object_key)
      VALUES ('ept8-tamper', 'telemetry/ept8-tamper')`);
    expect(await codeOf(runImport(await context(target, directory), { execute: true, confirm: preflight.runAuthorizationToken })))
      .toBe("CUTOVER_PENDING_OBJECT_CONFLICT");
    await target.adminPrimary.query(`DELETE FROM ${table("pending_objects")} WHERE contribution_id = 'ept8-tamper'`);
    const finished = await runImport(await context(target, directory), { execute: true, confirm: preflight.runAuthorizationToken });
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
});
