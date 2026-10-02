import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { participantDeletionDigest } from "../scripts/cutover-source-projections.mjs";
import { CutoverSourceError, readCutoverSeal } from "../scripts/cutover-source-seal.mjs";
import {
  IDENTITY_AUTHORITY_COUNTER_MAPPING,
  IDENTITY_AUTHORITY_EXCLUDED_TABLES,
  IDENTITY_AUTHORITY_FROZEN_ORDER,
  IDENTITY_TRIGGER_POLICY,
  IdentityAuthorityTransferError,
  runIdentityAuthorityTransfer,
} from "../scripts/postgres-identity-authority-transfer.mjs";
import {
  PostgresTransferTargetError,
  abandonRun,
  advanceRun,
  beginRun,
  sealedCollectionControlsSha256,
} from "../scripts/postgres-transfer-target.mjs";
import { authenticatePostgresDeviceBearer } from "../src/postgres-device-bearer-auth.ts";
import { claimPostgresDevicePairing } from "../src/postgres-device-pairing-claim.ts";
import { authenticatePostgresPersonalSessionForRead } from "../src/postgres-personal-session.ts";
import { createW2SealCluster, LEDGER_SCHEMA, PRIMARY_SCHEMA } from "./fixtures/w2-seal/pg-target.mjs";
import { forgeVariantSeal, headCommit, outputPathsOf, prepareSealWorld, sealWorld } from "./fixtures/w2-seal/seal-harness.mjs";
import {
  SYNTHETIC_IDENTITY_LINK_SECRET,
  SYNTHETIC_IDENTITY_LINK_VERSION,
  deviceSecretHash,
  fixtureSecret,
  identityLinkFingerprint,
} from "./fixtures/w2-seal/synthetic-sources.mjs";

// PT-3 acceptance on PostgreSQL 17: the identity and authority importer in
// PT-1 production target mode over a synthetic PT-2-lite seal of the Q-1
// corpus. Everything is local and synthetic; secrets are fixture constants.

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIN = Object.freeze({ keyVersion: SYNTHETIC_IDENTITY_LINK_VERSION,
  secretFingerprint: identityLinkFingerprint(SYNTHETIC_IDENTITY_LINK_SECRET) });
const SCHEMAS = Object.freeze({ schema: { primarySchema: PRIMARY_SCHEMA, ledgerSchema: LEDGER_SCHEMA } });
const table = name => `"${PRIMARY_SCHEMA}"."${name}"`;

const isCode = code => error => (error instanceof IdentityAuthorityTransferError
  || error instanceof PostgresTransferTargetError || error instanceof CutoverSourceError) && error.code === code;

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

describe.skipIf(!PG_TEST_SOCKET)("PT-3 identity and authority importer on PostgreSQL 17", () => {
  let world;
  let seal;
  let manifestPath;
  let cluster;
  let target;
  let clean;
  let receipt;
  let sealedDb;

  beforeAll(async () => {
    const commit = headCommit(WORKER_ROOT);
    world = await prepareSealWorld({ commit });
    const run = await sealWorld(world);
    const result = await run.run();
    manifestPath = outputPathsOf(run.out).manifest;
    seal = await readCutoverSeal({ manifestPath, expectedSealId: result.sealId });
    sealedDb = new DatabaseSync(seal.sources.ingestion.path, { readOnly: true });
    cluster = await createW2SealCluster({ socket: PG_TEST_SOCKET, port: PG_TEST_PORT, user: PG_TEST_USER,
      password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE, count: 2, label: "pt3" });
    [target, clean] = cluster.targets;
  }, 600_000);

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

  async function controlsRow(selectedTarget) {
    return (await selectedTarget.ownerPrimary.query(`SELECT control_state, revision::int AS revision, enrollment_enabled,
        publication_enabled, updated_at FROM ${table("collection_controls")}`)).rows;
  }

  async function assertNothingWritten(selectedTarget, pristineControls) {
    const pool = selectedTarget.ownerPrimary;
    for (const name of ["participants", "web_sessions", "device_credentials", "enrollment_grants", "admin_action_audit",
      "storage_v11_owner_links", "input_versions", "attribution_enrollments"]) {
      expect(await count(pool, name), name).toBe(0);
    }
    expect(await controlsRow(selectedTarget)).toEqual(pristineControls);
    const receipts = await pool.query("SELECT count(*)::int AS n FROM tibotattle_transfer.transfer_stage_receipts");
    const sealed = await pool.query("SELECT count(*)::int AS n FROM tibotattle_transfer.sealed_collection_controls");
    expect([receipts.rows[0].n, sealed.rows[0].n]).toEqual([0, 0]);
  }

  it("refuses before any write: wrong pin, incomplete or foreign bootstrap, broken chain, unmapped counter or column, a participant mid-erasure, a restored erased participant, contained controls", async () => {
    const variants = [
      { label: "wrong identity-link secret", sql: "SELECT 1", pin: { keyVersion: PIN.keyVersion,
        secretFingerprint: identityLinkFingerprint("w2-seal-fixture-not-the-configured-secret-0002") },
      code: "CUTOVER_IDENTITY_LINK_SECRET_MISMATCH" },
      { label: "wrong key version", sql: "SELECT 1", pin: { ...PIN, keyVersion: "w2-seal-other-version" },
        code: "CUTOVER_IDENTITY_LINK_SECRET_MISMATCH" },
      { label: "incomplete bootstrap", sql: "UPDATE community_public_source_bootstrap SET completed = 0",
        code: "CUTOVER_PUBLIC_SOURCE_BOOTSTRAP_INCOMPLETE" },
      { label: "foreign bootstrap policy",
        sql: `PRAGMA ignore_check_constraints = ON;
          UPDATE community_public_source_bootstrap SET policy_version = 'community-public-sources-v0'`,
        code: "CUTOVER_PUBLIC_SOURCE_BOOTSTRAP_INCOMPLETE" },
      { label: "accountless chain", sql: `DROP TRIGGER IF EXISTS accountless_upload_owner_immutable;
          UPDATE accountless_upload_owners SET participant_id = '${world.fixture.ids.participant}'
           WHERE enrollment_device_id = '${world.fixture.ids.revokedDevice}'`,
      code: "CUTOVER_ACCOUNTLESS_AUTHORITY_CHAIN_INVALID" },
      { label: "unmapped counter", sql: "INSERT INTO sqlite_sequence(name, seq) VALUES ('synthetic_counter', 7)",
        code: "CUTOVER_COUNTER_UNMAPPED" },
      { label: "unmapped column", sql: "ALTER TABLE web_sessions ADD COLUMN synthetic_extra TEXT",
        code: "CUTOVER_COLUMN_UNMAPPED" },
      { label: "participant mid-erasure", sql: `UPDATE participants SET state = 'deleting',
          deletion_session_id = '${randomUUID()}' WHERE id = '${world.fixture.ids.participant}'`,
      code: "CUTOVER_PARTICIPANT_ERASURE_PENDING" },
      // Decision D2, enforced by PT-3 itself: the seal's own ledger records
      // the deletion digest of an 'active' sealed participant.
      { label: "restored erased participant", role: "deletion-ledger",
        sql: `INSERT INTO deletion_tombstones(participant_digest, schema_version, deleted_at, retain_until)
          SELECT '${participantDeletionDigest(world.fixture.ids.participant)}', schema_version, deleted_at, retain_until
            FROM deletion_tombstones LIMIT 1`,
        code: "CUTOVER_ERASED_PARTICIPANT_PRESENT" },
      { label: "contained controls", sql: `UPDATE collection_controls SET control_state = 'contained',
          enrollment_enabled = 0, upload_registration_enabled = 0, processing_enabled = 0, publication_enabled = 0`,
      code: "CUTOVER_CONTROLS_DEGRADE_IMPOSSIBLE" },
    ];
    const pristineControls = await controlsRow(target);
    for (const variant of variants) {
      const forged = await forgeVariantSeal(seal, variant.sql, variant.role);
      const handle = await beginImporting(target, forged.sealId, forged.sealedAt);
      try {
        await expect(runIdentityAuthorityTransfer({ handle, sealManifestPath: forged.manifestPath,
          identityLinkPin: variant.pin ?? PIN }), variant.label).rejects.toSatisfy(isCode(variant.code));
        await assertNothingWritten(target, pristineControls);
      } finally {
        await abandonRun(handle);
      }
    }
  }, 600_000);

  it("imports every table to the sealed digest, resumes a killed run at a page boundary byte-identically", async () => {
    const sealedAt = seal.manifest.createdAt;
    let handle = await beginImporting(target, seal.manifest.sealId, sealedAt);
    let killedAfter = null;
    let killed = null;
    try {
      await runIdentityAuthorityTransfer({ handle, sealManifestPath: manifestPath, identityLinkPin: PIN,
        onPage: ({ table: name, page }) => {
          if (name === "device_upload_authorizations" && page === 3) {
            killedAfter = page;
            throw new Error("synthetic kill at a page boundary");
          }
        } });
    } catch (error) {
      killed = error;
    }
    expect(killed?.message).toBe("CUTOVER_IDENTITY_TRANSFER_FAILED");
    expect(killedAfter).toBe(3);
    const pending = await target.ownerPrimary.query(`SELECT state, row_count::int AS rows, last_key
        FROM tibotattle_transfer.transfer_checkpoints WHERE checkpoint_name = 'table:device_upload_authorizations'`);
    expect(pending.rows).toEqual([{ state: "pending", rows: 768, last_key: null }]);
    expect(await count(target.ownerPrimary, "device_upload_authorizations")).toBe(768);
    expect(await count(target.ownerPrimary, "admin_action_audit")).toBe(0);

    handle = await target.open(seal.manifest.sealId);
    expect(handle.resumed).toBe(true);
    receipt = await runIdentityAuthorityTransfer({ handle, sealManifestPath: manifestPath, identityLinkPin: PIN });
    const cleanHandle = await beginImporting(clean, seal.manifest.sealId, sealedAt);
    const cleanReceipt = await runIdentityAuthorityTransfer({ handle: cleanHandle, sealManifestPath: manifestPath,
      identityLinkPin: PIN, pageRows: 97, pageBytes: 64 * 1024 });

    expect(receipt.order).toEqual(IDENTITY_AUTHORITY_FROZEN_ORDER);
    expect(receipt.receiptSha256).toBe(cleanReceipt.receiptSha256);
    // The do-not-restore rule ran over the seal's own ledger: counts and the
    // projection sha256 only.
    expect(receipt.doNotRestore).toEqual({ deletionDigests: world.digests.length,
      deletionDigestsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      participants: Number(sealedDb.prepare("SELECT count(*) AS n FROM participants").get().n), matches: 0 });
    expect(cleanReceipt.doNotRestore).toEqual(receipt.doNotRestore);
    expect(receipt.tables).toEqual(cleanReceipt.tables);
    for (const name of IDENTITY_AUTHORITY_FROZEN_ORDER) {
      const facts = receipt.tables[name];
      expect(facts.targetRows, name).toBe(facts.sourceRows);
      const sealedRows = Number(sealedDb.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n);
      if (facts.mode === "merge-seeded") expect(facts.sourceRows, name).toBe(sealedRows);
      else expect(facts.sourceRows, name).toBe(sealedRows);
    }
    const names = IDENTITY_AUTHORITY_FROZEN_ORDER.filter(name => receipt.tables[name].mode === "insert");
    expect(await tableTextDigests(target.ownerPrimary, names)).toEqual(await tableTextDigests(clean.ownerPrimary, names));
    expect(receipt.pages.device_upload_authorizations).toBeGreaterThan(0);
    expect(cleanReceipt.pages.device_upload_authorizations).toBe(Math.ceil(2042 / 97));

    // The stage receipt is complete, and a replay of the finished stage
    // reproduces it without a conflict or a second write: the controls and
    // bootstrap rows, every receipt and checkpoint and every imported row
    // keep their row versions (xmin) and the controls their updated_at.
    const stage = await target.ownerPrimary.query(`SELECT state, receipt_sha256 FROM tibotattle_transfer.transfer_stage_receipts
      WHERE stage = 'identity-authority'`);
    expect(stage.rows).toEqual([{ state: "complete", receipt_sha256: receipt.receiptSha256 }]);
    const versions = async () => {
      const relations = [table("collection_controls"), table("community_public_source_bootstrap"),
        "tibotattle_transfer.transfer_stage_receipts", "tibotattle_transfer.transfer_table_receipts",
        "tibotattle_transfer.transfer_checkpoints", "tibotattle_transfer.sealed_collection_controls",
        ...IDENTITY_AUTHORITY_FROZEN_ORDER.map(table), table("input_versions")];
      const result = {};
      for (const relation of relations) {
        result[relation] = (await target.ownerPrimary.query(`SELECT count(*)::int AS n,
            md5(coalesce(string_agg(xmin::text, ',' ORDER BY xmin::text), '')) AS xmins FROM ${relation}`)).rows[0];
      }
      result.controls = (await target.ownerPrimary.query(`SELECT xmin::text AS xmin, updated_at
        FROM ${table("collection_controls")}`)).rows;
      return result;
    };
    const beforeReplay = await versions();
    const replay = await runIdentityAuthorityTransfer({ handle, sealManifestPath: manifestPath, identityLinkPin: PIN });
    expect(replay.receiptSha256).toBe(receipt.receiptSha256);
    expect(Object.values(replay.pages).every(pages => pages === 0)).toBe(true);
    expect(await versions()).toEqual(beforeReplay);

    const text = JSON.stringify(receipt);
    for (const id of [world.fixture.ids.participant, world.fixture.ids.device, world.fixture.ids.session,
      world.fixture.ids.revokedDevice, "participant:"]) {
      expect(text.includes(id), "no id in the receipt").toBe(false);
    }
    const tableReceipts = await target.ownerPrimary.query(`SELECT source_table, disposition, state,
        source_sha256 = target_sha256 AS equal FROM tibotattle_transfer.transfer_table_receipts ORDER BY source_table`);
    for (const row of tableReceipts.rows) {
      expect(row.state).toBe("complete");
      if (row.source_table !== "collection_controls") expect(row.equal, row.source_table).toBe(true);
    }
    expect(tableReceipts.rows.map(row => row.source_table)).not.toContain("identity_reenrollment_cooldowns");
  }, 600_000);

  it("degrades controls at the sealed revision, replaces the bootstrap verbatim and creates no automatic rows", async () => {
    const pool = target.ownerPrimary;
    const sealedControls = sealedDb.prepare("SELECT * FROM collection_controls").get();
    const controls = await pool.query(`SELECT control_state, enrollment_enabled, publication_enabled,
        upload_registration_enabled, processing_enabled, revision::int AS revision, reason_code
      FROM ${table("collection_controls")}`);
    expect(controls.rows).toEqual([{ control_state: "degraded", enrollment_enabled: false, publication_enabled: false,
      upload_registration_enabled: sealedControls.upload_registration_enabled === 1,
      processing_enabled: sealedControls.processing_enabled === 1, revision: Number(sealedControls.revision),
      reason_code: sealedControls.reason_code }]);
    const record = await pool.query("SELECT sealed_row_sha256 FROM tibotattle_transfer.sealed_collection_controls");
    expect(record.rows).toEqual([{ sealed_row_sha256: sealedCollectionControlsSha256({
      control_state: sealedControls.control_state, enrollment_enabled: sealedControls.enrollment_enabled === 1,
      processing_enabled: sealedControls.processing_enabled === 1,
      publication_enabled: sealedControls.publication_enabled === 1, reason_code: sealedControls.reason_code,
      revision: Number(sealedControls.revision), updated_at: sealedControls.updated_at,
      upload_registration_enabled: sealedControls.upload_registration_enabled === 1 }) }]);
    expect(receipt.controls.sealedRowSha256).toBe(record.rows[0].sealed_row_sha256);

    const bootstrap = await pool.query(`SELECT singleton, policy_version, participant_cursor, source_day_cursor, completed
      FROM ${table("community_public_source_bootstrap")}`);
    const sealedBootstrap = sealedDb.prepare("SELECT * FROM community_public_source_bootstrap").get();
    expect(bootstrap.rows).toEqual([{ singleton: 1, policy_version: sealedBootstrap.policy_version,
      participant_cursor: "", source_day_cursor: "", completed: 1 }]);

    for (const name of ["attribution_enrollments", "telemetry_transport_participant_floors",
      "telemetry_transport_device_floors", "community_analytical_input_versions", "storage_v11_owner_links"]) {
      const sealedRows = Number(sealedDb.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n);
      expect(await count(pool, name), `${name}: no auto-created rows`).toBe(sealedRows);
    }
    expect(receipt.derived.input_versions.rows).toBe(await count(pool, "participants"));
    expect(await count(pool, "input_versions", "WHERE revision <> 0")).toBe(0);
    // Every suppressed trigger is enabled again.
    const disabled = await pool.query(`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal AND t.tgenabled <> 'O'`,
    [PRIMARY_SCHEMA]);
    expect(disabled.rows[0].n).toBe(0);
    const suppressed = Object.values(IDENTITY_TRIGGER_POLICY).flatMap(entry => Object.values(entry))
      .filter(entry => entry.policy === "suppress").length;
    expect(receipt.triggerPolicy.suppressed).toBe(suppressed);
  });

  it("imports audit rows before rollbacks, carries revoked authority verbatim and excludes cooldowns, ledger and retention markers", async () => {
    const pool = target.ownerPrimary;
    const order = receipt.order;
    expect(order.indexOf("admin_action_audit")).toBeLessThan(order.indexOf("telemetry_transport_floor_rollbacks"));
    const rollback = await pool.query(`SELECT audit.outcome FROM ${table("telemetry_transport_floor_rollbacks")} rollback
      JOIN ${table("admin_action_audit")} audit ON audit.operation_id = rollback.operation_id`);
    expect(rollback.rows).toEqual([{ outcome: "success" }]);
    const revoked = await pool.query(`SELECT
        (SELECT state FROM ${table("accountless_enrollment_ledger")} WHERE device_id = $1) AS ledger,
        (SELECT state FROM ${table("accountless_upload_owners")} WHERE enrollment_device_id = $1) AS owner,
        (SELECT state FROM ${table("accountless_v11_device_authorizations")} WHERE enrollment_device_id = $1) AS v11,
        (SELECT state FROM ${table("accountless_v12_device_authorizations")} WHERE enrollment_device_id = $1) AS v12,
        (SELECT state FROM ${table("device_credentials")} WHERE id = $1) AS device`, [world.fixture.ids.revokedDevice]);
    expect(revoked.rows).toEqual([{ ledger: "revoked", owner: "revoked", v11: "revoked", v12: "revoked", device: "revoked" }]);
    expect(receipt.accountlessChain.revokedOwners).toBe(1);

    expect(await count(pool, "identity_reenrollment_cooldowns")).toBe(0);
    for (const name of ["accountless_public_history_retention", "accountless_public_history_import_runs",
      "accountless_public_history_import_pages", "accountless_public_history_import_claims"]) {
      expect(await count(pool, name), name).toBe(0);
    }
    const ledgerTables = await target.ownerLedger.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname <> '_tibotattle_migration_history'`, [LEDGER_SCHEMA]);
    for (const { relname } of ledgerTables.rows) {
      const rows = await target.ownerLedger.query(`SELECT count(*)::int AS n FROM "${LEDGER_SCHEMA}"."${relname}"`);
      const seeded = relname === "storage_erasure_ledger_generation" ? 1 : 0;
      expect(rows.rows[0].n, `ledger ${relname}`).toBe(seeded);
    }
    expect(Object.keys(receipt.excluded).sort()).toEqual(Object.keys(IDENTITY_AUTHORITY_EXCLUDED_TABLES).sort());
    expect(Object.keys(receipt.targetMissing).sort()).toEqual(["accountless_telemetry_performance_authorizations",
      "telemetry_performance_device_capabilities"]);
  });

  it("raises identity next ids past the sealed sqlite_sequence", async () => {
    const sealedSequence = Object.fromEntries(sealedDb.prepare("SELECT name, seq FROM sqlite_sequence").all()
      .map(row => [row.name, Number(row.seq)]));
    for (const [counter, mapping] of Object.entries(IDENTITY_AUTHORITY_COUNTER_MAPPING)) {
      if (mapping.target === null || !Object.hasOwn(sealedSequence, counter)) continue;
      const next = await target.ownerPrimary.query(`SELECT last_value::bigint AS last, is_called
        FROM ${(await target.ownerPrimary.query("SELECT pg_get_serial_sequence($1, 'id') AS s",
          [`${PRIMARY_SCHEMA}.${mapping.target}`])).rows[0].s}`);
      const nextId = BigInt(next.rows[0].last) + (next.rows[0].is_called ? 1n : 0n);
      expect(nextId > BigInt(sealedSequence[counter]), counter).toBe(true);
    }
    const audit = sealedSequence.admin_action_audit;
    expect(audit).toBeGreaterThan(0);
    const inserted = await target.ownerPrimary.query(`INSERT INTO ${table("admin_action_audit")}(operation_id, action,
        actor_identity_digest, outcome, details_json, created_at)
      VALUES ($1, 'sync_distribution', $2, 'success', '{}', now()) RETURNING id::bigint AS id`,
    [randomUUID(), "a".repeat(64)]);
    expect(BigInt(inserted.rows[0].id) > BigInt(audit)).toBe(true);
  });

  it("the erased-redeemer migration (primary 0063) admits the imported grant and refuses the same shape live", async () => {
    const pool = target.ownerPrimary;
    const imported = await pool.query(`SELECT state, redeemed_participant_id FROM ${table("enrollment_grants")} WHERE id = $1`,
      [world.fixture.ids.erasedRedeemerGrant]);
    expect(imported.rows).toEqual([{ state: "redeemed", redeemed_participant_id: null }]);
    const live = pool.query(`INSERT INTO ${table("enrollment_grants")}(id, secret_hash, state, issued_at, expires_at, redeemed_at,
        redeemed_participant_id) VALUES ($1, $2, 'redeemed', now(), now() + interval '1 day', now(), NULL)`,
    [randomUUID(), Buffer.alloc(32, 7)]);
    await expect(live).rejects.toMatchObject({ code: "23514", message: "enrollment_grant_redeemer_required" });
    const issued = await pool.query(`SELECT id FROM ${table("enrollment_grants")} WHERE state = 'issued' LIMIT 1`);
    await expect(pool.query(`UPDATE ${table("enrollment_grants")} SET state = 'redeemed', redeemed_at = now() WHERE id = $1`,
      [issued.rows[0].id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`UPDATE ${table("enrollment_grants")} SET redeemed_at = now() WHERE id = $1`,
      [world.fixture.ids.erasedRedeemerGrant])).rejects.toMatchObject({ code: "23514" });
    const shape = await pool.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE conrelid = $1::regclass AND conname = 'enrollment_grants_state_shape'`, [`${PRIMARY_SCHEMA}.enrollment_grants`]);
    expect(shape.rows).toHaveLength(1);
    expect(cluster.erased.name.endsWith("_enrollment_grants_erased_redeemer.sql")).toBe(true);
  });

  it("an imported session, device and pairing authenticate with the fixture secrets; a rotated-out secret revokes", async () => {
    const { ids, secrets, nowMs } = world.fixture;
    const nowEpoch = nowMs + 60_000;
    const session = await authenticatePostgresPersonalSessionForRead(target.ownerPrimary,
      `__Host-usage_monitor_session=um_session_${ids.session}.${secrets.session}`, { ...SCHEMAS, nowEpoch });
    expect(session.participantId).toBe(ids.participant);
    expect(session.sessionId).toBe(ids.session);

    const device = await authenticatePostgresDeviceBearer(target.ownerPrimary,
      `Device um_device_${ids.device}.${secrets.device}`, { ...SCHEMAS, nowEpoch });
    expect(device).toMatchObject({ deviceId: ids.device, participantId: ids.participant, authorityKind: "social",
      credentialGeneration: 2 });

    const newDevice = randomUUID();
    const claimed = await claimPostgresDevicePairing(target.ownerPrimary, target.ownerLedger,
      `Pairing um_pair_${ids.openPairing}.${secrets.openPairing}`, newDevice,
      deviceSecretHash(newDevice, fixtureSecret("claimed-device")).toString("hex"), null, { ...SCHEMAS, nowEpoch });
    expect(claimed).toMatchObject({ deviceId: newDevice, state: "active" });

    // The imported rotation row still knows the rotated-out secret: its
    // reuse is credential theft and revokes the device (rotation hashes
    // were imported, not dropped).
    await expect(authenticatePostgresDeviceBearer(target.ownerPrimary,
      `Device um_device_${ids.device}.${secrets.devicePrior}`, { ...SCHEMAS, nowEpoch: nowEpoch + 1000 }))
      .rejects.toMatchObject({ status: 401, code: "DEVICE_AUTH_INVALID" });
    const revoked = await target.ownerPrimary.query(`SELECT state FROM ${table("device_credentials")} WHERE id = $1`, [ids.device]);
    expect(revoked.rows).toEqual([{ state: "revoked" }]);
    await expect(authenticatePostgresDeviceBearer(target.ownerPrimary,
      `Device um_device_${ids.revokedDevice}.${fixtureSecret("revoked-device")}`, { ...SCHEMAS, nowEpoch }))
      .rejects.toMatchObject({ status: 401 });
  });
});
