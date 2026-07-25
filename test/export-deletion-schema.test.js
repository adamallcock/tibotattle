import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MAXIMUM_EXPORT_SET_CHUNKS } from "../src/export-set-schema.js";
import {
  assertValidExportDeletionCommitMarker,
  assertValidExportDeletionJournal,
  assertValidExportDeletionPreflight,
  assertValidExportDeletionReceipt,
  EXPORT_DELETION_COMMIT_MARKER_SCHEMA_SHA256,
  EXPORT_DELETION_COMMIT_MARKER_VERSION,
  EXPORT_DELETION_CONFIRMATION_TOKEN_PATTERN,
  EXPORT_DELETION_INVENTORY_ROLES,
  EXPORT_DELETION_JOURNAL_SCHEMA_SHA256,
  EXPORT_DELETION_JOURNAL_VERSION,
  EXPORT_DELETION_ORDER_VERSION,
  EXPORT_DELETION_PLAN_VERSION,
  EXPORT_DELETION_PREFLIGHT_SCHEMA_SHA256,
  EXPORT_DELETION_PREFLIGHT_VERSION,
  EXPORT_DELETION_RECEIPT_SCHEMA_SHA256,
  EXPORT_DELETION_RECEIPT_VERSION,
  exportDeletionCommitMarkerSchema,
  exportDeletionJournalSchema,
  exportDeletionPreflightSchema,
  exportDeletionReceiptSchema,
  MAXIMUM_EXPORT_DELETION_INVENTORY_ROWS,
  validateExportDeletionCommitMarker,
  validateExportDeletionJournal,
  validateExportDeletionPreflight,
  validateExportDeletionReceipt,
} from "../src/export-deletion-schema.js";

const { setManifest, chunkArtifact, workspaceSqliteJournal, workspaceSqliteWal,
  workspaceSqliteShm, workspaceDatabase, chunkReceipt, setManifestReceipt } = EXPORT_DELETION_INVENTORY_ROLES;

function preflight() {
  return {
    schemaVersion: EXPORT_DELETION_PREFLIGHT_VERSION,
    planVersion: EXPORT_DELETION_PLAN_VERSION,
    artifactClass: "complete_local_export_set",
    readiness: "ready",
    fileCounts: {
      chunkArtifacts: 2,
      chunkReceipts: 2,
      controlFiles: 2,
      workspaceFiles: 1,
      totalFiles: 7,
    },
    byteCounts: { exportSetBytes: 600, workspaceBytes: 400, totalBytes: 1000 },
    confirmationRequired: true,
    confirmationToken: "A2BCDEFGHJKM",
    networkActivity: "absent",
    secureErasureClaimed: false,
    transportReady: false,
  };
}

function inventoryRow(role, ordinal, chunkIndex = null) {
  return {
    ordinal,
    role,
    chunkIndex,
    device: 44,
    inode: 1000 + ordinal,
    fileType: "regular_file",
    linkCount: 1,
    byteSize: 10 + ordinal,
    sha256: ((ordinal % 10).toString(16)).repeat(64),
  };
}

function journal(chunkCount = 2, sidecars = []) {
  const definitions = [
    [setManifest, null],
    ...Array.from({ length: chunkCount }, (_, index) => [chunkArtifact, index]),
    ...sidecars.map((role) => [role, null]),
    [workspaceDatabase, null],
    ...Array.from({ length: chunkCount }, (_, index) => [chunkReceipt, index]),
    [setManifestReceipt, null],
  ];
  const inventory = definitions.map(([role, chunkIndex], ordinal) => inventoryRow(role, ordinal, chunkIndex));
  return {
    schemaVersion: EXPORT_DELETION_JOURNAL_VERSION,
    planVersion: EXPORT_DELETION_PLAN_VERSION,
    deletionOrderVersion: EXPORT_DELETION_ORDER_VERSION,
    exportSetManifestVersion: "usage-export-set-manifest-v0.2",
    directoryIdentities: {
      workspace: { device: 44, inode: 900 },
      output: { device: 44, inode: 901 },
    },
    state: "prepared",
    planSha256: "a".repeat(64),
    inventoryCounts: {
      chunkArtifacts: chunkCount,
      chunkReceipts: chunkCount,
      controlFiles: 2,
      workspaceFiles: sidecars.length + 1,
      totalFiles: inventory.length,
      totalBytes: inventory.reduce((sum, row) => sum + row.byteSize, 0),
    },
    inventory,
    transportReady: false,
  };
}

function commitMarker() {
  return {
    schemaVersion: EXPORT_DELETION_COMMIT_MARKER_VERSION,
    planVersion: EXPORT_DELETION_PLAN_VERSION,
    deletionOrderVersion: EXPORT_DELETION_ORDER_VERSION,
    state: "committed",
    directoryIdentities: {
      workspace: { device: 44, inode: 900 },
      output: { device: 44, inode: 901 },
    },
    planSha256: "a".repeat(64),
    journalSha256: "b".repeat(64),
    transportReady: false,
  };
}

function receipt() {
  return {
    schemaVersion: EXPORT_DELETION_RECEIPT_VERSION,
    planVersion: EXPORT_DELETION_PLAN_VERSION,
    artifactClass: "complete_local_export_set",
    state: "complete",
    logicalRemovalConfirmed: true,
    deletedFileCount: 7,
    deletedBytes: 1000,
    sourceLogsPreserved: true,
    identityStatePreserved: true,
    directoriesRetained: true,
    networkActivity: "absent",
    secureErasureClaimed: false,
    transportReady: false,
  };
}

test("deletion v0.1 schemas are immutable and inventory bounds track the export-set ceiling", async () => {
  const contracts = [
    ["preflight-summary.schema.json", exportDeletionPreflightSchema, EXPORT_DELETION_PREFLIGHT_SCHEMA_SHA256],
    ["journal.schema.json", exportDeletionJournalSchema, EXPORT_DELETION_JOURNAL_SCHEMA_SHA256],
    ["commit-marker.schema.json", exportDeletionCommitMarkerSchema, EXPORT_DELETION_COMMIT_MARKER_SCHEMA_SHA256],
    ["receipt.schema.json", exportDeletionReceiptSchema, EXPORT_DELETION_RECEIPT_SCHEMA_SHA256],
  ];
  for (const [basename, schema, expectedDigest] of contracts) {
    const bytes = await readFile(new URL(`../schemas/export-deletion-v0.1/${basename}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedDigest);
    assert.equal(schema.additionalProperties, false);
  }
  assert.equal(MAXIMUM_EXPORT_DELETION_INVENTORY_ROWS, (2 * MAXIMUM_EXPORT_SET_CHUNKS) + 6);
  assert.equal(exportDeletionJournalSchema.properties.inventory.maxItems, MAXIMUM_EXPORT_DELETION_INVENTORY_ROWS);
  assert.equal(EXPORT_DELETION_CONFIRMATION_TOKEN_PATTERN, "^[A-Z2-7]{12,24}$");
});

test("exact content-free preflight, journal, commit marker, and receipt shapes validate", () => {
  const values = [
    [preflight(), validateExportDeletionPreflight, assertValidExportDeletionPreflight],
    [journal(), validateExportDeletionJournal, assertValidExportDeletionJournal],
    [commitMarker(), validateExportDeletionCommitMarker, assertValidExportDeletionCommitMarker],
    [receipt(), validateExportDeletionReceipt, assertValidExportDeletionReceipt],
  ];
  for (const [value, validate, assertValid] of values) {
    assert.deepEqual(validate(value), { valid: true, errors: [] });
    assert.equal(assertValid(value), value);
  }
});

test("closed shapes reject missing fields and unknown path or identity fields without echoing values", () => {
  const canary = "/Users/private/participant-secret/export-set-123";
  const cases = [
    [preflight(), validateExportDeletionPreflight, (value) => { value.workspacePath = canary; }],
    [journal(), validateExportDeletionJournal, (value) => { value.inventory[0].filename = canary; }],
    [commitMarker(), validateExportDeletionCommitMarker, (value) => { value.participantId = canary; }],
    [receipt(), validateExportDeletionReceipt, (value) => { value.sourceDetails = canary; }],
    [preflight(), validateExportDeletionPreflight, (value) => { delete value.byteCounts; }],
    [journal(), validateExportDeletionJournal, (value) => { delete value.inventory[0].inode; }],
    [commitMarker(), validateExportDeletionCommitMarker, (value) => { delete value.journalSha256; }],
    [receipt(), validateExportDeletionReceipt, (value) => { delete value.networkActivity; }],
  ];
  for (const [value, validate, mutate] of cases) {
    mutate(value);
    const result = validate(value);
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result.errors).includes(canary), false);
    assert.equal(JSON.stringify(result.errors).includes("participant-secret"), false);
  }
});

test("confirmation token is a short uppercase base32 derivative, never a raw digest or path", () => {
  for (const token of [
    "A".repeat(11),
    "A".repeat(25),
    "a2BCDEFGHJKM",
    "A0BCDEFGHJKM",
    "A1BCDEFGHJKM",
    "a".repeat(64),
    "/PRIVATE/TOKEN",
  ]) {
    const value = preflight();
    value.confirmationToken = token;
    const result = validateExportDeletionPreflight(value);
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result.errors).includes(token), false);
  }

  const notReady = preflight();
  notReady.readiness = "not_ready";
  notReady.confirmationToken = null;
  assert.equal(validateExportDeletionPreflight(notReady).valid, true);
  notReady.confirmationToken = "A2BCDEFGHJKM";
  assert.ok(validateExportDeletionPreflight(notReady).errors.some(
    (error) => error.schemaPath === "#/x-invariant/not-ready-has-no-token",
  ));
});

test("preflight counts are exact and ready state requires a complete paired export set", () => {
  for (const mutate of [
    (value) => { value.fileCounts.totalFiles += 1; },
    (value) => { value.byteCounts.totalBytes += 1; },
    (value) => { value.fileCounts.chunkReceipts -= 1; value.fileCounts.totalFiles -= 1; },
    (value) => { value.fileCounts.controlFiles = 1; value.fileCounts.totalFiles -= 1; },
    (value) => { value.byteCounts.workspaceBytes = 0; value.byteCounts.totalBytes = value.byteCounts.exportSetBytes; },
  ]) {
    const value = preflight();
    mutate(value);
    assert.equal(validateExportDeletionPreflight(value).valid, false);
  }
});

test("journal enforces manifest-first monotonic order and contiguous paired chunks", () => {
  const valid = journal(2, [workspaceSqliteJournal, workspaceSqliteWal, workspaceSqliteShm]);
  assert.equal(validateExportDeletionJournal(valid).valid, true);

  const reordered = structuredClone(valid);
  [reordered.inventory[0], reordered.inventory[1]] = [reordered.inventory[1], reordered.inventory[0]];
  reordered.inventory.forEach((row, ordinal) => { row.ordinal = ordinal; });
  assert.ok(validateExportDeletionJournal(reordered).errors.some(
    (error) => error.schemaPath === "#/x-invariant/canonical-deletion-order",
  ));

  const noncontiguous = journal();
  noncontiguous.inventory[2].chunkIndex = 7;
  assert.ok(validateExportDeletionJournal(noncontiguous).errors.some(
    (error) => error.schemaPath === "#/x-invariant/contiguous-chunk-artifact-indexes",
  ));

  const reversedSidecars = journal(2, [workspaceSqliteWal, workspaceSqliteJournal]);
  assert.ok(validateExportDeletionJournal(reversedSidecars).errors.some(
    (error) => error.schemaPath === "#/x-invariant/canonical-deletion-order",
  ));
});

test("journal rejects duplicate identities, duplicate singleton roles, and inaccurate counts", () => {
  const duplicateIdentity = journal();
  duplicateIdentity.inventory[1].device = duplicateIdentity.inventory[0].device;
  duplicateIdentity.inventory[1].inode = duplicateIdentity.inventory[0].inode;
  assert.ok(validateExportDeletionJournal(duplicateIdentity).errors.some(
    (error) => error.schemaPath === "#/x-invariant/unique-device-inode",
  ));

  const duplicateSingleton = journal(1, [workspaceSqliteJournal, workspaceSqliteJournal]);
  assert.ok(validateExportDeletionJournal(duplicateSingleton).errors.some(
    (error) => error.schemaPath === "#/x-invariant/unique-singleton-role",
  ));

  for (const field of ["chunkArtifacts", "chunkReceipts", "workspaceFiles", "totalFiles", "totalBytes"]) {
    const value = journal();
    value.inventoryCounts[field] += 1;
    assert.ok(validateExportDeletionJournal(value).errors.some(
      (error) => error.path === `/inventoryCounts/${field}`,
    ));
  }
});

test("journal accepts the exact ceiling and rejects inventory beyond the current chunk bound", () => {
  const maximum = journal(MAXIMUM_EXPORT_SET_CHUNKS, [
    workspaceSqliteJournal,
    workspaceSqliteWal,
    workspaceSqliteShm,
  ]);
  assert.equal(maximum.inventory.length, MAXIMUM_EXPORT_DELETION_INVENTORY_ROWS);
  assert.equal(validateExportDeletionJournal(maximum).valid, true);

  const overflow = structuredClone(maximum);
  overflow.inventory.push(inventoryRow(chunkReceipt, overflow.inventory.length, MAXIMUM_EXPORT_SET_CHUNKS - 1));
  overflow.inventoryCounts.totalFiles += 1;
  overflow.inventoryCounts.chunkReceipts += 1;
  overflow.inventoryCounts.totalBytes += overflow.inventory.at(-1).byteSize;
  assert.equal(validateExportDeletionJournal(overflow).valid, false);
});

test("commit marker and final receipt cannot claim transport, network use, or secure erasure", () => {
  const cases = [
    [commitMarker(), validateExportDeletionCommitMarker, (value) => { value.transportReady = true; }],
    [receipt(), validateExportDeletionReceipt, (value) => { value.transportReady = true; }],
    [receipt(), validateExportDeletionReceipt, (value) => { value.networkActivity = "present"; }],
    [receipt(), validateExportDeletionReceipt, (value) => { value.secureErasureClaimed = true; }],
    [receipt(), validateExportDeletionReceipt, (value) => { value.sourceLogsPreserved = false; }],
    [receipt(), validateExportDeletionReceipt, (value) => { value.identityStatePreserved = false; }],
  ];
  for (const [value, validate, mutate] of cases) {
    mutate(value);
    assert.equal(validate(value).valid, false);
  }
});
