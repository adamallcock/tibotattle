import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SOCIAL_V02_SOURCE_ID = "synthetic-social-v02-source";
export const SOCIAL_V02_JOURNAL_COLUMNS = Object.freeze([
  "source_id", "sequence", "event_digest", "owner_digest", "revision", "kind",
  "object_digest", "content_digest", "authority_epoch", "public_authority_epoch", "recorded_ms",
]);
export const SOCIAL_V02_PROOF_COLUMNS = Object.freeze([
  "event_digest", "owner_digest", "participant_id", "input_revision", "change_kind",
  "sequence", "journal_revision", "journal_kind", "object_digest", "content_digest",
  "authority_epoch", "public_authority_epoch", "recorded_ms", "owner_link_digest",
  "owner_link_state", "current_input_revision", "owner_head_revision",
  "owner_head_authority_epoch", "owner_head_state", "owner_head_last_sequence",
  "owner_head_object_digest", "owner_head_content_digest",
]);
export const digest = value => createHash("sha256").update(String(value)).digest("hex");

function normalizeJournal(row) {
  const copy = Object.fromEntries(SOCIAL_V02_JOURNAL_COLUMNS.map(column => [column, row[column]]));
  for (const column of ["sequence", "revision", "authority_epoch", "public_authority_epoch", "recorded_ms"]) {
    copy[column] = BigInt(copy[column]).toString();
  }
  return copy;
}

export async function makeSocialV02ReceiptProjection({
  sourceId = SOCIAL_V02_SOURCE_ID,
  sourceAuthorityEpoch = "1",
  journalRows = [],
  proofRows = [],
  extraTable = false,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-social-v02-receipts-"));
  const path = join(await realpath(directory), "receipts.sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE social_v02_source_manifest(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version TEXT NOT NULL,
        source_id TEXT NOT NULL, source_authority_epoch INTEGER NOT NULL CHECK(source_authority_epoch>=0),
        journal_event_count INTEGER NOT NULL CHECK(journal_event_count>=0),
        journal_event_rows_sha256 TEXT NOT NULL, journal_last_sequence INTEGER NOT NULL CHECK(journal_last_sequence>=0)
      ) STRICT;
      CREATE TABLE social_v02_receipt_proofs(
        event_digest TEXT PRIMARY KEY, owner_digest TEXT NOT NULL, participant_id TEXT NOT NULL,
        input_revision INTEGER NOT NULL, change_kind TEXT NOT NULL, sequence INTEGER NOT NULL,
        journal_revision INTEGER NOT NULL, journal_kind TEXT NOT NULL, object_digest TEXT NOT NULL,
        content_digest TEXT NOT NULL, authority_epoch INTEGER NOT NULL, public_authority_epoch INTEGER NOT NULL,
        recorded_ms INTEGER NOT NULL, owner_link_digest TEXT NOT NULL, owner_link_state TEXT NOT NULL,
        current_input_revision INTEGER, owner_head_revision INTEGER NOT NULL,
        owner_head_authority_epoch INTEGER NOT NULL, owner_head_state TEXT NOT NULL,
        owner_head_last_sequence INTEGER NOT NULL, owner_head_object_digest TEXT NOT NULL,
        owner_head_content_digest TEXT NOT NULL, UNIQUE(participant_id,input_revision)
      ) STRICT;
    `);
    if (extraTable) database.exec("CREATE TABLE unexpected_source_data(value TEXT) STRICT");

    const journal = journalRows.map(normalizeJournal);
    const journalHash = createHash("sha256");
    for (const row of journal) journalHash.update(`${JSON.stringify(SOCIAL_V02_JOURNAL_COLUMNS.map(column => row[column]))}\n`);
    const lastSequence = journal.length === 0 ? "0" : journal.at(-1).sequence;
    database.prepare(`INSERT INTO social_v02_source_manifest(
      singleton,schema_version,source_id,source_authority_epoch,journal_event_count,
      journal_event_rows_sha256,journal_last_sequence) VALUES(1,?,?,?,?,?,?)`).run(
      "sealed-sqlite-social-v02-receipt-projection-v1", sourceId, BigInt(sourceAuthorityEpoch),
      BigInt(journal.length), journalHash.digest("hex"), BigInt(lastSequence));

    const insert = database.prepare(`INSERT INTO social_v02_receipt_proofs(
      ${SOCIAL_V02_PROOF_COLUMNS.map(column => `"${column}"`).join(",")})
      VALUES(${SOCIAL_V02_PROOF_COLUMNS.map(() => "?").join(",")})`);
    for (const row of proofRows) {
      insert.run(...SOCIAL_V02_PROOF_COLUMNS.map(column => {
        const value = row[column];
        return ["input_revision", "sequence", "journal_revision", "authority_epoch", "public_authority_epoch",
          "recorded_ms", "current_input_revision", "owner_head_revision", "owner_head_authority_epoch",
          "owner_head_last_sequence"].includes(column) && value !== null ? BigInt(value) : value;
      }));
    }
  } finally {
    database.close();
  }
  await chmod(path, 0o400);
  return Object.freeze({
    directory,
    path: await realpath(path),
    expectedSha256: createHash("sha256").update(await readFile(path)).digest("hex"),
  });
}
