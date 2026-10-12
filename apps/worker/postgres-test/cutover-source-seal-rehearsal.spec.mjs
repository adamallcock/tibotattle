import { randomBytes } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyCutoverFence, verifyCutoverUnchanged } from "../scripts/cutover-source-fence.mjs";
import {
  assertNoSealedParticipantDeletionMatches,
  projectDeletionDigests,
  projectIngestionJournal,
  readDeletionDigestProjection,
} from "../scripts/cutover-source-projections.mjs";
import {
  CUTOVER_ANALYTICS_BOOKMARK_ROLE,
  CutoverSourceError,
  openSealedSourceFromSeal,
  readCutoverInventory,
  readCutoverSeal,
} from "../scripts/cutover-source-seal.mjs";
import {
  createSealedSqliteIngestionJournalSource,
  transferPostgresIngestionJournal,
} from "../scripts/postgres-ingestion-journal-transfer.mjs";
import { runIdentityAuthorityTransfer } from "../scripts/postgres-identity-authority-transfer.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { advanceRun, assertStageComplete, beginRun } from "../scripts/postgres-transfer-target.mjs";
import { SYNTHETIC_BOOKMARKS } from "./fixtures/w2-seal/fence-fixtures.mjs";
import { createW2SealCluster } from "./fixtures/w2-seal/pg-target.mjs";
import {
  SYNTHETIC_UNCHANGED_BOOKMARKS,
  headCommit,
  outputPathsOf,
  prepareSealWorld,
  sealWorld,
} from "./fixtures/w2-seal/seal-harness.mjs";
import {
  SYNTHETIC_IDENTITY_LINK_SECRET,
  SYNTHETIC_IDENTITY_LINK_VERSION,
  SYNTHETIC_SIGNED_URL,
  createFakeCutoverTransport,
  identityLinkFingerprint,
  privateDirectory,
} from "./fixtures/w2-seal/synthetic-sources.mjs";

// The W2-SEAL rehearsal on PostgreSQL 17, end to end over the synthetic Q-1
// corpus: verify-fence, the seal of the ingestion and deletion-ledger D1s,
// the journal projection through the existing ingestion-journal importer,
// the deletion-digest projection and its count-only intersection, the PT-3
// identity-authority stage in PT-1 production target mode, and
// verify-unchanged's flip evidence. Local and synthetic only.

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function filesUnder(directory) {
  const found = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isDirectory()) found.push(...await filesUnder(path));
    else if (info.isFile()) found.push(path);
  }
  return found;
}

describe.skipIf(!PG_TEST_SOCKET)("W2-SEAL cutover source rehearsal on PostgreSQL 17", () => {
  let world;
  let cluster;
  let target;
  const outputs = [];

  beforeAll(async () => {
    world = await prepareSealWorld({ commit: headCommit(WORKER_ROOT) });
    cluster = await createW2SealCluster({ socket: PG_TEST_SOCKET, port: PG_TEST_PORT, user: PG_TEST_USER,
      password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE, count: 1, label: "seal" });
    [target] = cluster.targets;
  }, 600_000);

  afterAll(async () => {
    await cluster?.dispose();
    await world?.dispose();
  });

  it("fences, seals, projects, imports and proves the sources unchanged without any id leaving memory", async () => {
    const inventory = await readCutoverInventory(world.inventory.path);
    const fence = await verifyCutoverFence({ inventory, fenceReceiptPath: world.fence.path,
      fenceReceiptSha256: world.fence.sha256, barrierProofPath: world.proof.path });
    expect(fence.sources.ingestion.bookmark).toBe(SYNTHETIC_BOOKMARKS.ingestion);

    const sealing = await sealWorld(world);
    outputs.push(sealing.out);
    const sealed = await sealing.run();
    const manifestPath = outputPathsOf(sealing.out).manifest;
    const seal = await readCutoverSeal({ manifestPath, expectedSealId: sealed.sealId });
    expect(seal.manifest.fence.fenceReceiptSha256).toBe(world.fence.sha256);

    // The journal projection through the existing importer.
    const projections = await privateDirectory("w2-seal-projections-");
    outputs.push(projections);
    const ingestion = await openSealedSourceFromSeal(seal, "ingestion");
    const ledger = await openSealedSourceFromSeal(seal, "deletion-ledger");
    let journal;
    let digests;
    let intersection;
    let projectedDigestsSha256;
    let sourceId;
    try {
      journal = await projectIngestionJournal({ sealedIngestion: ingestion,
        outputPath: join(projections, "ingestion-journal.projection.sqlite") });
      sourceId = ingestion.database().prepare("SELECT source_id FROM storage_source_state WHERE singleton = 1").get().source_id;
      const projectedDigests = await projectDeletionDigests({ sealedLedger: ledger,
        outputPath: join(projections, "deletion-digests.projection.txt") });
      projectedDigestsSha256 = projectedDigests.sha256;
      digests = await readDeletionDigestProjection({ path: projectedDigests.path, expectedSha256: projectedDigests.sha256 });
      intersection = await assertNoSealedParticipantDeletionMatches({ sealedIngestion: ingestion, digests });
    } finally {
      ingestion.close();
      ledger.close();
    }
    expect(intersection.matches).toBe(0);
    expect(intersection.participantsByState.deleting).toBe(0);
    expect(intersection.deletionDigests).toBe(world.digests.length);

    const journalSchema = `storage_journal_transfer_target_${randomBytes(6).toString("hex")}`;
    await target.ownerPrimary.query(`CREATE SCHEMA "${journalSchema}"`);
    await applyPostgresMigrations({ role: "primary", schema: journalSchema, pool: target.ownerPrimary });
    const journalSource = await createSealedSqliteIngestionJournalSource({ path: journal.path,
      expectedSha256: journal.sha256, expectedSourceId: sourceId });
    try {
      const transferred = await transferPostgresIngestionJournal({ source: journalSource,
        destinationPool: target.ownerPrimary, targetSchema: journalSchema,
        transferId: "synthetic-ingestion-journal-w2-seal-rehearsal", pageSize: 2 });
      const sealedRows = new DatabaseSync(seal.sources.ingestion.path, { readOnly: true });
      try {
        expect(Number(transferred.eventRows)).toBe(Number(sealedRows.prepare(
          "SELECT count(*) AS n FROM storage_ingestion_changes").get().n));
      } finally {
        sealedRows.close();
      }
      expect(transferred.eventRowsSha256).toBe(transferred.targetRowsSha256);
    } finally {
      journalSource.close();
    }

    // The identity-authority stage on the registered production target.
    const handle = await target.open(seal.manifest.sealId);
    await beginRun(handle, { sealedAt: seal.manifest.createdAt });
    await advanceRun(handle, "importing");
    const receipt = await runIdentityAuthorityTransfer({ handle, sealManifestPath: manifestPath,
      identityLinkPin: { keyVersion: SYNTHETIC_IDENTITY_LINK_VERSION,
        secretFingerprint: identityLinkFingerprint(SYNTHETIC_IDENTITY_LINK_SECRET) } });
    await assertStageComplete(handle, "identity-authority");
    expect(receipt.transferId).toBe(`production-identity-authority-${seal.manifest.sealId.slice(0, 16)}`);
    expect(receipt.sourceSha256).toBe(seal.sources.ingestion.sealedSha256);
    // PT-3 enforced the do-not-restore rule over the same digests PT-2-lite
    // projected: the same count, the projection file's sha256, no match.
    expect(receipt.doNotRestore).toEqual({ deletionDigests: intersection.deletionDigests,
      deletionDigestsSha256: projectedDigestsSha256, participants: intersection.participants, matches: 0 });

    // Unchanged sources: flip evidence; a moved bookmark refuses.
    const flipDirectory = await privateDirectory("w2-seal-flip-");
    outputs.push(flipDirectory);
    const transport = createFakeCutoverTransport({ sources: world.remotePaths, bookmarks: SYNTHETIC_UNCHANGED_BOOKMARKS });
    const analyticsInputs = { analyticsSourcePath: world.analyticsSource, fenceReceiptPath: world.fence.path };
    const flip = await verifyCutoverUnchanged({ inventoryPath: world.inventory.path, manifestPath,
      sealId: seal.manifest.sealId, ...analyticsInputs, ownerDirectory: flipDirectory, execute: true, remote: true,
      ownerReadOnly: true, transport });
    expect(flip.flipEvidenceSha256).toMatch(/^[0-9a-f]{64}$/u);
    const drifted = createFakeCutoverTransport({ sources: world.remotePaths,
      bookmarks: { ...SYNTHETIC_UNCHANGED_BOOKMARKS, ingestion: "00000001-11111111-00000099" } });
    await expect(verifyCutoverUnchanged({ inventoryPath: world.inventory.path, manifestPath, sealId: seal.manifest.sealId,
      ...analyticsInputs, ownerDirectory: await privateDirectory("w2-seal-flip-drift-"), execute: true, remote: true,
      ownerReadOnly: true, transport: drifted })).rejects.toSatisfy(error => error instanceof CutoverSourceError
      && error.code === "CUTOVER_SOURCE_CHANGED_AFTER_SEAL");
    // R19 (c): a Cloudflare publication after the fence moves the analytics bookmark.
    const published = createFakeCutoverTransport({ sources: world.remotePaths,
      bookmarks: { ...SYNTHETIC_UNCHANGED_BOOKMARKS, [CUTOVER_ANALYTICS_BOOKMARK_ROLE]: "00000001-22222222-00000099" } });
    await expect(verifyCutoverUnchanged({ inventoryPath: world.inventory.path, manifestPath, sealId: seal.manifest.sealId,
      ...analyticsInputs, ownerDirectory: await privateDirectory("w2-seal-flip-analytics-"), execute: true, remote: true,
      ownerReadOnly: true, transport: published })).rejects.toSatisfy(error => error instanceof CutoverSourceError
      && error.code === "CUTOVER_ANALYTICS_CHANGED_AFTER_FENCE");

    // Content-free outputs: no participant id, no signed URL, in any kept file
    // or the receipt (sealed SQLite files hold the data by design).
    const ids = [world.fixture.ids.participant, world.fixture.ids.device, world.fixture.ids.session,
      world.fixture.ids.revokedParticipant];
    for (const directory of outputs) {
      for (const path of await filesUnder(directory)) {
        if (path.endsWith(".sqlite")) continue;
        const text = await readFile(path, "utf8");
        for (const id of ids) expect(text.includes(id), path).toBe(false);
        expect(text.includes(SYNTHETIC_SIGNED_URL), path).toBe(false);
      }
    }
    const receiptText = JSON.stringify(receipt);
    for (const id of ids) expect(receiptText.includes(id)).toBe(false);
  }, 600_000);
});
