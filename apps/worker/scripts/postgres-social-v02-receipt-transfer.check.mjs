import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import {
  createSealedSqliteSocialV02ReceiptSource,
  scanSealedSqliteSocialV02Receipts,
} from "./postgres-social-v02-receipt-transfer.mjs";
import {
  digest,
  makeSocialV02ReceiptProjection,
  SOCIAL_V02_SOURCE_ID,
} from "../postgres-test/social-v02-receipt-transfer-fixture.mjs";

function eventFixture(index, { currentInputRevision = index, sequence = index, publicAuthorityEpoch = sequence } = {}) {
  const eventDigest = digest(`event-${index}`);
  const ownerDigest = digest(`owner-${index}`);
  sequence = String(sequence);
  publicAuthorityEpoch = String(publicAuthorityEpoch);
  const journal = {
    source_id: SOCIAL_V02_SOURCE_ID,
    sequence,
    event_digest: eventDigest,
    owner_digest: ownerDigest,
    revision: "1",
    kind: "owner-active",
    object_digest: eventDigest,
    content_digest: eventDigest,
    authority_epoch: "1",
    public_authority_epoch: publicAuthorityEpoch,
    recorded_ms: String(1_790_000_000_000 + index),
  };
  const proof = {
    event_digest: eventDigest,
    owner_digest: ownerDigest,
    participant_id: `synthetic-participant-${index}`,
    input_revision: sequence,
    change_kind: "owner-active",
    sequence,
    journal_revision: "1",
    journal_kind: "owner-active",
    object_digest: eventDigest,
    content_digest: eventDigest,
    authority_epoch: "1",
    public_authority_epoch: publicAuthorityEpoch,
    recorded_ms: journal.recorded_ms,
    owner_link_digest: ownerDigest,
    owner_link_state: "active",
    current_input_revision: String(currentInputRevision),
    owner_head_revision: "1",
    owner_head_authority_epoch: "1",
    owner_head_state: "active",
    owner_head_last_sequence: sequence,
    owner_head_object_digest: eventDigest,
    owner_head_content_digest: eventDigest,
  };
  return { journal, proof };
}

async function openFixture(options) {
  const file = await makeSocialV02ReceiptProjection(options);
  try {
    const source = await createSealedSqliteSocialV02ReceiptSource({
      path: file.path,
      expectedSha256: file.expectedSha256,
      expectedSourceId: SOCIAL_V02_SOURCE_ID,
    });
    return { file, source };
  } catch (error) {
    await rm(file.directory, { recursive: true, force: true });
    throw error;
  }
}

test("sealed social v0.2 receipt projection scans bounded pages without exposing receipt identities", async () => {
  const first = eventFixture(1);
  const second = eventFixture(2);
  const { file, source } = await openFixture({
    sourceAuthorityEpoch: "2",
    journalRows: [first.journal, second.journal],
    proofRows: [first.proof, second.proof],
  });
  try {
    const receipt = await scanSealedSqliteSocialV02Receipts({ source, pageSize: 1 });
    assert.equal(receipt.schema, "sealed-sqlite-social-v02-receipt-projection-v1");
    assert.equal(receipt.receiptRows, "2");
    assert.equal(receipt.journalEventCount, "2");
    assert.equal(receipt.journalLastSequence, "2");
    assert.equal(receipt.pagesRead, 3);
    assert.equal(receipt.postgresWrites, 0);
    assert.equal(receipt.journalRowsWritten, false);
    assert.equal(receipt.ownerHeadsWritten, false);
    assert.equal(JSON.stringify(receipt).includes("synthetic-participant"), false);
    assert.equal(JSON.stringify(receipt).includes(first.proof.owner_digest), false);
  } finally {
    source.close();
    await rm(file.directory, { recursive: true, force: true });
  }
});

test("sealed social v0.2 journal manifest keeps row count distinct from the last gapped sequence", async () => {
  const first = eventFixture(1, { sequence: 1, publicAuthorityEpoch: 1 });
  const third = eventFixture(3, { sequence: 3, publicAuthorityEpoch: 1 });
  const { file, source } = await openFixture({
    sourceAuthorityEpoch: "1",
    journalRows: [first.journal, third.journal],
    proofRows: [first.proof, third.proof],
  });
  try {
    const receipt = await scanSealedSqliteSocialV02Receipts({ source, pageSize: 1 });
    assert.equal(receipt.journalEventCount, "2");
    assert.equal(receipt.journalLastSequence, "3");
    assert.equal(receipt.receiptRows, "2");
  } finally {
    source.close();
    await rm(file.directory, { recursive: true, force: true });
  }
});

test("sealed social v0.2 journal manifest still rejects impossible count and last-sequence bounds", async () => {
  const row = eventFixture(1, { sequence: 1, publicAuthorityEpoch: 1 });
  const file = await makeSocialV02ReceiptProjection({
    sourceAuthorityEpoch: "1",
    journalRows: [row.journal],
    manifestJournalEventCount: 2,
    manifestJournalLastSequence: 1,
    proofRows: [row.proof],
  });
  try {
    await assert.rejects(createSealedSqliteSocialV02ReceiptSource({
      path: file.path,
      expectedSha256: file.expectedSha256,
      expectedSourceId: SOCIAL_V02_SOURCE_ID,
    }), { code: "SOCIAL_V02_RECEIPT_SOURCE_MANIFEST_INVALID" });
  } finally {
    await rm(file.directory, { recursive: true, force: true });
  }
});

test("sealed social v0.2 receipts reject identity drift, a widened source, and an invalid current revision", async () => {
  const row = eventFixture(1);
  const file = await makeSocialV02ReceiptProjection({ journalRows: [row.journal], proofRows: [row.proof] });
  try {
    await assert.rejects(createSealedSqliteSocialV02ReceiptSource({
      path: file.path,
      expectedSha256: file.expectedSha256,
      expectedSourceId: "different-synthetic-source",
    }), { code: "SOCIAL_V02_RECEIPT_SOURCE_IDENTITY_MISMATCH" });
    await assert.rejects(createSealedSqliteSocialV02ReceiptSource({
      path: file.path,
      expectedSha256: digest("wrong-file"),
      expectedSourceId: SOCIAL_V02_SOURCE_ID,
    }), { code: "SOCIAL_V02_RECEIPT_SQLITE_SHA256_MISMATCH" });
  } finally {
    await rm(file.directory, { recursive: true, force: true });
  }

  const widened = await makeSocialV02ReceiptProjection({
    journalRows: [row.journal], proofRows: [row.proof], extraTable: true,
  });
  try {
    await assert.rejects(createSealedSqliteSocialV02ReceiptSource({
      path: widened.path,
      expectedSha256: widened.expectedSha256,
      expectedSourceId: SOCIAL_V02_SOURCE_ID,
    }), { code: "SOCIAL_V02_RECEIPT_SOURCE_LAYOUT_INVALID" });
  } finally {
    await rm(widened.directory, { recursive: true, force: true });
  }

  const behind = eventFixture(1, { currentInputRevision: 0 });
  const stale = await openFixture({ journalRows: [behind.journal], proofRows: [behind.proof] });
  try {
    await assert.rejects(scanSealedSqliteSocialV02Receipts({ source: stale.source }),
      { code: "SOCIAL_V02_RECEIPT_SOURCE_ROW_INVALID" });
  } finally {
    stale.source.close();
    await rm(stale.file.directory, { recursive: true, force: true });
  }
});

test("social v0.2 transfer scanner accepts only source handles made by the sealed SQLite reader", async () => {
  await assert.rejects(scanSealedSqliteSocialV02Receipts({
    source: { snapshot: { kind: "sealed-sqlite-social-v02-receipt-projection", immutable: true } },
  }), { code: "SOCIAL_V02_RECEIPT_SEALED_SOURCE_REQUIRED" });
});
