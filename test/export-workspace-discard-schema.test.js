import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  assertValidExportWorkspaceDiscardCommitMarker,
  assertValidExportWorkspaceDiscardJournal,
  assertValidExportWorkspaceDiscardPreflight,
  assertValidExportWorkspaceDiscardReceipt,
  EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_SCHEMA_SHA256,
  EXPORT_WORKSPACE_DISCARD_JOURNAL_SCHEMA_SHA256,
  EXPORT_WORKSPACE_DISCARD_PREFLIGHT_SCHEMA_SHA256,
  EXPORT_WORKSPACE_DISCARD_RECEIPT_SCHEMA_SHA256,
  exportWorkspaceDiscardCommitMarkerSchema,
  exportWorkspaceDiscardJournalSchema,
  exportWorkspaceDiscardPreflightSchema,
  exportWorkspaceDiscardReceiptSchema,
  validateExportWorkspaceDiscardCommitMarker,
  validateExportWorkspaceDiscardJournal,
  validateExportWorkspaceDiscardPreflight,
  validateExportWorkspaceDiscardReceipt,
} from "../src/export-workspace-discard-schema.js";

function journal() {
  const firstEvidence = "B".repeat(52);
  const secondEvidence = "C".repeat(52);
  return {
    schemaVersion: "usage-export-workspace-discard-journal-v0.1",
    planVersion: "local-export-workspace-discard-plan-v0.1",
    discardOrderVersion: "sqlite-sidecars-then-database-v1",
    artifactClass: "incomplete_or_poisoned_export_workspace",
    state: "prepared",
    planToken: "A2BCDEFGHJKMNPQRSTUV",
    directoryIdentityToken: "A".repeat(52),
    eligibility: "scan_incomplete",
    inventoryCounts: { sqliteSidecars: 1, workspaceDatabase: 1, totalFiles: 2, totalBytes: 30 },
    inventory: [
      { ordinal: 0, role: "workspace_sqlite_journal", byteSize: 10, evidenceToken: firstEvidence },
      { ordinal: 1, role: "workspace_database", byteSize: 20, evidenceToken: secondEvidence },
    ],
    transportReady: false,
  };
}

function preflight() {
  return {
    schemaVersion: "usage-export-workspace-discard-preflight-v0.1",
    planVersion: "local-export-workspace-discard-plan-v0.1",
    artifactClass: "incomplete_or_poisoned_export_workspace",
    readiness: "ready",
    eligibility: "scan_incomplete",
    fileCounts: { sqliteSidecars: 1, workspaceDatabase: 1, totalFiles: 2 },
    byteCounts: { workspaceBytes: 30, totalBytes: 30 },
    confirmationRequired: true,
    confirmationToken: "A2BCDEFGHJKMNPQR",
    sourceLogsPreserved: true,
    independentOutputPreserved: true,
    networkActivity: "absent",
    secureErasureClaimed: false,
    transportReady: false,
  };
}

function marker() {
  return {
    schemaVersion: "usage-export-workspace-discard-commit-marker-v0.1",
    planVersion: "local-export-workspace-discard-plan-v0.1",
    discardOrderVersion: "sqlite-sidecars-then-database-v1",
    state: "committed",
    planToken: "A2BCDEFGHJKMNPQRSTUV",
    directoryIdentityToken: "A".repeat(52),
    journalToken: "D".repeat(52),
    transportReady: false,
  };
}

function receipt() {
  return {
    schemaVersion: "usage-export-workspace-discard-receipt-v0.1",
    planVersion: "local-export-workspace-discard-plan-v0.1",
    artifactClass: "incomplete_or_poisoned_export_workspace",
    state: "complete",
    logicalRemovalConfirmed: true,
    deletedFileCount: 2,
    deletedBytes: 30,
    sourceLogsPreserved: true,
    identityStatePreserved: true,
    independentOutputPreserved: true,
    workspaceDirectoryRetained: true,
    networkActivity: "absent",
    secureErasureClaimed: false,
    transportReady: false,
  };
}

test("workspace discard schemas are immutable closed contracts", async () => {
  const rows = [
    ["preflight-summary.schema.json", exportWorkspaceDiscardPreflightSchema, EXPORT_WORKSPACE_DISCARD_PREFLIGHT_SCHEMA_SHA256],
    ["journal.schema.json", exportWorkspaceDiscardJournalSchema, EXPORT_WORKSPACE_DISCARD_JOURNAL_SCHEMA_SHA256],
    ["commit-marker.schema.json", exportWorkspaceDiscardCommitMarkerSchema, EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_SCHEMA_SHA256],
    ["receipt.schema.json", exportWorkspaceDiscardReceiptSchema, EXPORT_WORKSPACE_DISCARD_RECEIPT_SCHEMA_SHA256],
  ];
  for (const [name, schema, digest] of rows) {
    const bytes = await readFile(new URL(`../schemas/export-workspace-discard-v0.1/${name}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
    assert.equal(schema.additionalProperties, false);
  }
});

test("valid content-free discard contracts pass schema and semantic checks", () => {
  for (const [value, validate, assertValid] of [
    [preflight(), validateExportWorkspaceDiscardPreflight, assertValidExportWorkspaceDiscardPreflight],
    [journal(), validateExportWorkspaceDiscardJournal, assertValidExportWorkspaceDiscardJournal],
    [marker(), validateExportWorkspaceDiscardCommitMarker, assertValidExportWorkspaceDiscardCommitMarker],
    [receipt(), validateExportWorkspaceDiscardReceipt, assertValidExportWorkspaceDiscardReceipt],
  ]) {
    assert.deepEqual(validate(value), { valid: true, errors: [] });
    assert.equal(assertValid(value), value);
  }
});

test("schemas reject paths, identifiers, hashes, unknown fields, and noncanonical inventory without echoing values", () => {
  const canary = "/Users/private/participant:v1:secret/PRIVATE_PROMPT";
  const cases = [
    [preflight(), validateExportWorkspaceDiscardPreflight, (value) => { value.workspacePath = canary; }],
    [journal(), validateExportWorkspaceDiscardJournal, (value) => { value.inventory[0].sha256 = "a".repeat(64); }],
    [marker(), validateExportWorkspaceDiscardCommitMarker, (value) => { value.participantId = canary; }],
    [receipt(), validateExportWorkspaceDiscardReceipt, (value) => { value.sourceDetails = canary; }],
    [journal(), validateExportWorkspaceDiscardJournal, (value) => { value.inventory.reverse(); }],
    [journal(), validateExportWorkspaceDiscardJournal, (value) => { value.inventoryCounts.totalBytes += 1; }],
    [preflight(), validateExportWorkspaceDiscardPreflight, (value) => { value.fileCounts.totalFiles += 1; }],
  ];
  for (const [value, validate, mutate] of cases) {
    mutate(value);
    const result = validate(value);
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result.errors).includes(canary), false);
    assert.equal(JSON.stringify(result.errors).includes("PRIVATE_PROMPT"), false);
  }
});
