import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CUTOVER_PARTICIPANT_STATES,
  PARTICIPANT_DELETION_DIGEST_DOMAIN,
  assertNoSealedParticipantDeletionMatches,
  countSealedParticipantDeletionMatches,
  participantDeletionDigest,
  projectDeletionDigests,
  projectIngestionJournal,
  readDeletionDigestProjection,
  readWorkerDeletionDigestDomain,
} from "./cutover-source-projections.mjs";
import {
  CutoverSourceError,
  openCutoverSealedSqlite,
  openSealedSourceFromSeal,
  readCutoverSeal,
  sha256File,
} from "./cutover-source-seal.mjs";
import { createSealedSqliteIngestionJournalSource } from "./postgres-ingestion-journal-transfer.mjs";
import {
  forgeVariantSeal,
  headCommit,
  outputPathsOf,
  prepareSealWorld,
  sealWorld,
} from "../postgres-test/fixtures/w2-seal/seal-harness.mjs";
import {
  buildSyntheticDeletionLedgerD1,
  privateDirectory,
  syntheticTombstoneDigests,
} from "../postgres-test/fixtures/w2-seal/synthetic-sources.mjs";

// PT-2-lite projections over a synthetic seal: the exact-layout journal for
// the existing ingestion-journal importer, the content-free deletion-digest
// projection (the do-not-restore seed) and the count-only intersection.
// Run: node --test ./scripts/cutover-source-projections.check.mjs

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = headCommit(WORKER_ROOT);
let world;
let seal;
let out;

const isCode = code => error => error instanceof CutoverSourceError && error.code === code;

before(async () => {
  world = await prepareSealWorld({ commit: COMMIT });
  const run = await sealWorld(world);
  const result = await run.run();
  out = run.out;
  seal = await readCutoverSeal({ manifestPath: outputPathsOf(out).manifest, expectedSealId: result.sealId });
});

after(async () => {
  await world?.dispose();
});

/** A sealed (0400) copy of a deletion-ledger D1 for the planted case. */
async function sealedCopy(path, directory) {
  const target = join(directory, "planted-ledger.sealed.sqlite");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec(`VACUUM INTO '${target}'`);
  } finally {
    database.close();
  }
  await chmod(target, 0o400);
  return openCutoverSealedSqlite({ path: target, expectedSha256: await sha256File(target) });
}

test("the deletion digest domain is the Worker's literal", async () => {
  assert.equal(await readWorkerDeletionDigestDomain(), PARTICIPANT_DELETION_DIGEST_DOMAIN);
  assert.equal(participantDeletionDigest("participant:synthetic"),
    createHash("sha256").update(`app-usagemonitor/deletion-tombstone/v1\0participant:synthetic`).digest("hex"));
});

test("the journal projection has the importer's exact layout, 0400, and the sealed rows", async () => {
  const ingestion = await openSealedSourceFromSeal(seal, "ingestion");
  const directory = await privateDirectory("w2-seal-journal-");
  try {
    const projected = await projectIngestionJournal({ sealedIngestion: ingestion,
      outputPath: join(directory, "journal.sqlite") });
    assert.equal((await lstat(projected.path)).mode & 0o777, 0o400);
    assert.equal(projected.sha256, await sha256File(projected.path));
    const sealed = ingestion.database();
    const sourceId = sealed.prepare("SELECT source_id FROM storage_source_state WHERE singleton = 1").get().source_id;
    const changes = sealed.prepare("SELECT count(*) AS n FROM storage_ingestion_changes").get().n;
    assert.equal(projected.rows, changes + 1);
    const importer = await createSealedSqliteIngestionJournalSource({ path: projected.path,
      expectedSha256: projected.sha256, expectedSourceId: sourceId });
    try {
      let rows = 0;
      let afterKey = null;
      for (;;) {
        const page = await importer.listPage({ after: afterKey, limit: 100 });
        rows += page.rows.length;
        if (page.rows.length < 100) break;
        afterKey = page.rows.at(-1).sequence;
      }
      assert.equal(rows, changes);
    } finally {
      importer.close();
    }
    await assert.rejects(projectIngestionJournal({ sealedIngestion: ingestion, outputPath: projected.path }),
      isCode("CUTOVER_OUTPUT_EXISTS"));
    await assert.rejects(projectIngestionJournal({ sealedIngestion: { database() {}, verify() {} },
      outputPath: join(directory, "x.sqlite") }), isCode("CUTOVER_ARGUMENT_INVALID"));
  } finally {
    ingestion.close();
  }
});

test("the deletion-digest projection holds exactly the sorted synthetic digests, 0400, with its sha", async () => {
  const ledger = await openSealedSourceFromSeal(seal, "deletion-ledger");
  const directory = await privateDirectory("w2-seal-digests-");
  try {
    const projected = await projectDeletionDigests({ sealedLedger: ledger, outputPath: join(directory, "digests.txt") });
    assert.equal((await lstat(projected.path)).mode & 0o777, 0o400);
    const bytes = await readFile(projected.path);
    assert.equal(projected.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(bytes.toString("utf8"), [...world.digests].sort().map(digest => `${digest}\n`).join(""));
    assert.equal(projected.count, world.digests.length);
    const set = await readDeletionDigestProjection({ path: projected.path, expectedSha256: projected.sha256 });
    assert.deepEqual([...set].sort(), [...world.digests].sort());
    // Only tombstone digests: the cooldown and erasure-job rows of the
    // sealed ledger never reach the projection.
    const cooldown = ledger.database().prepare("SELECT identity_cooldown_digest AS d FROM identity_reenrollment_cooldowns").get().d;
    assert.equal(bytes.includes(Buffer.from(cooldown)), false);
    await assert.rejects(readDeletionDigestProjection({ path: projected.path, expectedSha256: "0".repeat(64) }),
      isCode("CUTOVER_PROJECTION_INVALID"));
    const unsorted = join(directory, "unsorted.txt");
    const [first, second] = [...world.digests].sort();
    const text = `${second}\n${first}\n`;
    await writeFile(unsorted, text, { mode: 0o600 });
    await assert.rejects(readDeletionDigestProjection({ path: unsorted,
      expectedSha256: createHash("sha256").update(text).digest("hex") }), isCode("CUTOVER_PROJECTION_INVALID"));
    const empty = join(directory, "empty.txt");
    await writeFile(empty, "", { mode: 0o600 });
    assert.equal((await readDeletionDigestProjection({ path: empty,
      expectedSha256: createHash("sha256").update("").digest("hex") })).size, 0);
  } finally {
    ledger.close();
  }
});

test("the participant intersection is a count only over every state: 0 when clean, 1 with a planted participant", async () => {
  const ingestion = await openSealedSourceFromSeal(seal, "ingestion");
  const ledger = await openSealedSourceFromSeal(seal, "deletion-ledger");
  const directory = await privateDirectory("w2-seal-intersection-");
  let planted;
  try {
    const projected = await projectDeletionDigests({ sealedLedger: ledger, outputPath: join(directory, "digests.txt") });
    const digests = await readDeletionDigestProjection({ path: projected.path, expectedSha256: projected.sha256 });
    const clean = await assertNoSealedParticipantDeletionMatches({ sealedIngestion: ingestion, digests });
    assert.deepEqual(Object.keys(clean).sort(), ["deletionDigests", "matches", "participants", "participantsByState"]);
    assert.deepEqual(Object.keys(clean.participantsByState), [...CUTOVER_PARTICIPANT_STATES]);
    assert.equal(clean.matches, 0);
    assert.ok(clean.participantsByState.active >= 5);
    assert.equal(clean.participantsByState.deleting, 0);
    assert.equal(clean.participants, ingestion.database().prepare("SELECT count(*) AS n FROM participants").get().n);
    assert.equal(clean.deletionDigests, world.digests.length);

    const plantedLedger = await buildSyntheticDeletionLedgerD1({ directory, commit: COMMIT,
      digests: syntheticTombstoneDigests({ erasedParticipantId: world.fixture.ids.erasedParticipant,
        plantActiveParticipantId: world.fixture.ids.participant }) });
    planted = await sealedCopy(plantedLedger.path, directory);
    const plantedProjection = await projectDeletionDigests({ sealedLedger: planted,
      outputPath: join(directory, "planted.txt") });
    const plantedDigests = await readDeletionDigestProjection({ path: plantedProjection.path,
      expectedSha256: plantedProjection.sha256 });
    const result = await countSealedParticipantDeletionMatches({ sealedIngestion: ingestion, digests: plantedDigests });
    assert.equal(result.matches, 1);
    await assert.rejects(assertNoSealedParticipantDeletionMatches({ sealedIngestion: ingestion, digests: plantedDigests }),
      isCode("CUTOVER_ERASED_PARTICIPANT_PRESENT"));
    const text = JSON.stringify(result);
    assert.equal(text.includes("participant:"), false, "no participant id leaves the intersection");
    assert.equal(text.includes(world.fixture.ids.participant), false);
  } finally {
    ingestion.close();
    ledger.close();
    planted?.close();
  }
});

test("a 'deleting' participant (an interrupted erasure) is hashed too: its recorded tombstone refuses the seal", async () => {
  // The Worker marks the participant deleting, then records its tombstone,
  // and can still fail before the rows are gone; a fence can land there too.
  const forged = await forgeVariantSeal(seal, `UPDATE participants SET state = 'deleting',
      deletion_session_id = '${randomUUID()}' WHERE id = '${world.fixture.ids.participant}'`);
  const variant = await readCutoverSeal({ manifestPath: forged.manifestPath, expectedSealId: forged.sealId });
  const ingestion = await openSealedSourceFromSeal(variant, "ingestion");
  try {
    const tombstones = new Set([...world.digests, participantDeletionDigest(world.fixture.ids.participant)]);
    const matched = await countSealedParticipantDeletionMatches({ sealedIngestion: ingestion, digests: tombstones });
    assert.equal(matched.matches, 1);
    assert.equal(matched.participantsByState.deleting, 1);
    await assert.rejects(assertNoSealedParticipantDeletionMatches({ sealedIngestion: ingestion, digests: tombstones }),
      isCode("CUTOVER_ERASED_PARTICIPANT_PRESENT"));
    // Without a recorded tombstone the intersection is 0, but the participant
    // is still counted as deleting; PT-3 refuses it before any write
    // (CUTOVER_PARTICIPANT_ERASURE_PENDING, postgres-identity-authority-transfer).
    const untombstoned = await countSealedParticipantDeletionMatches({ sealedIngestion: ingestion,
      digests: new Set(world.digests) });
    assert.deepEqual([untombstoned.matches, untombstoned.participantsByState.deleting], [0, 1]);
    assert.equal(JSON.stringify(matched).includes(world.fixture.ids.participant), false);
  } finally {
    ingestion.close();
  }
  // A state outside the D1 CHECK is not a participant the projection can
  // account for.
  const unknown = await forgeVariantSeal(seal, `PRAGMA ignore_check_constraints = ON;
    UPDATE participants SET state = 'erased' WHERE id = '${world.fixture.ids.participant}'`);
  const unknownSeal = await readCutoverSeal({ manifestPath: unknown.manifestPath, expectedSealId: unknown.sealId });
  const unknownIngestion = await openSealedSourceFromSeal(unknownSeal, "ingestion");
  try {
    await assert.rejects(countSealedParticipantDeletionMatches({ sealedIngestion: unknownIngestion,
      digests: new Set(world.digests) }), isCode("CUTOVER_PROJECTION_INVALID"));
  } finally {
    unknownIngestion.close();
  }
});

test("projections refuse a sealed file that changed underneath them", async () => {
  const directory = await privateDirectory("w2-seal-changed-");
  const copy = join(directory, "deletion-ledger.sealed.sqlite");
  await copyFile(seal.sources["deletion-ledger"].path, copy);
  await chmod(copy, 0o400);
  const opened = await openCutoverSealedSqlite({ path: copy, expectedSha256: seal.sources["deletion-ledger"].sealedSha256 });
  try {
    await chmod(copy, 0o600);
    await writeFile(copy, Buffer.from("x"), { flag: "a" });
    await chmod(copy, 0o400);
    await assert.rejects(projectDeletionDigests({ sealedLedger: opened, outputPath: join(directory, "d.txt") }),
      isCode("CUTOVER_SEALED_SOURCE_CHANGED"));
  } finally {
    opened.close();
  }
});
