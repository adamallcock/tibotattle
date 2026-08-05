import Ajv from "ajv";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { safeValidationErrors } from "../safe-validation-errors.js";
import { MAXIMUM_EXPORT_SET_CHUNKS } from "./set-schema.js";

export const EXPORT_DELETION_PLAN_VERSION = "local-export-deletion-plan-v0.1";
export const EXPORT_DELETION_PREFLIGHT_VERSION = "usage-export-deletion-preflight-v0.1";
export const EXPORT_DELETION_JOURNAL_VERSION = "usage-export-deletion-journal-v0.1";
export const EXPORT_DELETION_COMMIT_MARKER_VERSION = "usage-export-deletion-commit-marker-v0.1";
export const EXPORT_DELETION_RECEIPT_VERSION = "usage-export-deletion-receipt-v0.1";
export const EXPORT_DELETION_ORDER_VERSION = "manifest-bundles-workspace-receipts-v1";
export const EXPORT_DELETION_CONFIRMATION_TOKEN_PATTERN = "^[A-Z2-7]{12,24}$";
export const MAXIMUM_EXPORT_DELETION_INVENTORY_ROWS = (2 * MAXIMUM_EXPORT_SET_CHUNKS) + 6;

export const EXPORT_DELETION_INVENTORY_ROLES = Object.freeze({
  setManifest: "set_manifest",
  chunkArtifact: "chunk_artifact",
  workspaceSqliteJournal: "workspace_sqlite_journal",
  workspaceSqliteWal: "workspace_sqlite_wal",
  workspaceSqliteShm: "workspace_sqlite_shm",
  workspaceDatabase: "workspace_database",
  chunkReceipt: "chunk_receipt",
  setManifestReceipt: "set_manifest_receipt",
});

const schemaUrls = Object.freeze({
  preflight: new URL("../../schemas/export-deletion-v0.1/preflight-summary.schema.json", import.meta.url),
  journal: new URL("../../schemas/export-deletion-v0.1/journal.schema.json", import.meta.url),
  commitMarker: new URL("../../schemas/export-deletion-v0.1/commit-marker.schema.json", import.meta.url),
  receipt: new URL("../../schemas/export-deletion-v0.1/receipt.schema.json", import.meta.url),
});

function schemaDigest(url) {
  return createHash("sha256").update(readFileSync(url)).digest("hex");
}

export const EXPORT_DELETION_PREFLIGHT_SCHEMA_SHA256 = schemaDigest(schemaUrls.preflight);
export const EXPORT_DELETION_JOURNAL_SCHEMA_SHA256 = schemaDigest(schemaUrls.journal);
export const EXPORT_DELETION_COMMIT_MARKER_SCHEMA_SHA256 = schemaDigest(schemaUrls.commitMarker);
export const EXPORT_DELETION_RECEIPT_SCHEMA_SHA256 = schemaDigest(schemaUrls.receipt);

const require = createRequire(import.meta.url);
const preflightSchema = require("../../schemas/export-deletion-v0.1/preflight-summary.schema.json");
const journalSchema = require("../../schemas/export-deletion-v0.1/journal.schema.json");
const commitMarkerSchema = require("../../schemas/export-deletion-v0.1/commit-marker.schema.json");
const receiptSchema = require("../../schemas/export-deletion-v0.1/receipt.schema.json");

const ajv = new Ajv({ allErrors: true, strict: true });
const validatePreflightSchema = ajv.compile(preflightSchema);
const validateJournalSchema = ajv.compile(journalSchema);
const validateCommitMarkerSchema = ajv.compile(commitMarkerSchema);
const validateReceiptSchema = ajv.compile(receiptSchema);

function invariant(path, name) {
  return { path, keyword: "invariant", schemaPath: `#/x-invariant/${name}` };
}

function validationResult(validateSchema, value, semanticErrors = () => []) {
  if (!validateSchema(value)) {
    return { valid: false, errors: safeValidationErrors(validateSchema.errors) };
  }
  const errors = semanticErrors(value).slice(0, 20);
  return { valid: errors.length === 0, errors };
}

function preflightSemanticErrors(preflight) {
  const errors = [];
  const counts = preflight.fileCounts;
  const bytes = preflight.byteCounts;
  const summedFiles = counts.chunkArtifacts + counts.chunkReceipts
    + counts.controlFiles + counts.workspaceFiles;
  if (counts.totalFiles !== summedFiles) {
    errors.push(invariant("/fileCounts/totalFiles", "aggregate-file-count"));
  }
  if (bytes.totalBytes !== bytes.exportSetBytes + bytes.workspaceBytes) {
    errors.push(invariant("/byteCounts/totalBytes", "aggregate-byte-count"));
  }

  if (preflight.readiness === "ready") {
    if (typeof preflight.confirmationToken !== "string") {
      errors.push(invariant("/confirmationToken", "ready-confirmation-token"));
    }
    if (counts.chunkArtifacts < 1 || counts.chunkArtifacts !== counts.chunkReceipts) {
      errors.push(invariant("/fileCounts", "complete-chunk-pairs"));
    }
    if (counts.controlFiles !== 2 || counts.workspaceFiles < 1) {
      errors.push(invariant("/fileCounts", "complete-control-and-workspace-files"));
    }
    if (bytes.exportSetBytes < 1 || bytes.workspaceBytes < 1) {
      errors.push(invariant("/byteCounts", "nonempty-ready-target"));
    }
  } else if (preflight.confirmationToken !== null) {
    errors.push(invariant("/confirmationToken", "not-ready-has-no-token"));
  }
  return errors;
}

const singletonRoles = new Set([
  EXPORT_DELETION_INVENTORY_ROLES.setManifest,
  EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteJournal,
  EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteWal,
  EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteShm,
  EXPORT_DELETION_INVENTORY_ROLES.workspaceDatabase,
  EXPORT_DELETION_INVENTORY_ROLES.setManifestReceipt,
]);

const sidecarRoles = Object.freeze([
  EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteJournal,
  EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteWal,
  EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteShm,
]);

function expectedInventoryRoles(inventory) {
  const chunkCount = inventory.filter((row) => row.role === EXPORT_DELETION_INVENTORY_ROLES.chunkArtifact).length;
  const receiptCount = inventory.filter((row) => row.role === EXPORT_DELETION_INVENTORY_ROLES.chunkReceipt).length;
  const presentRoles = new Set(inventory.map((row) => row.role));
  return [
    EXPORT_DELETION_INVENTORY_ROLES.setManifest,
    ...Array(chunkCount).fill(EXPORT_DELETION_INVENTORY_ROLES.chunkArtifact),
    ...sidecarRoles.filter((role) => presentRoles.has(role)),
    EXPORT_DELETION_INVENTORY_ROLES.workspaceDatabase,
    ...Array(receiptCount).fill(EXPORT_DELETION_INVENTORY_ROLES.chunkReceipt),
    EXPORT_DELETION_INVENTORY_ROLES.setManifestReceipt,
  ];
}

function contiguousChunkIndexes(rows) {
  return rows.every((row, position) => row.chunkIndex === position);
}

function journalSemanticErrors(journal) {
  const errors = [];
  const rows = journal.inventory;
  const counts = journal.inventoryCounts;
  const seenRoles = new Set();
  const seenIdentities = new Set();

  for (const [position, row] of rows.entries()) {
    const path = `/inventory/${position}`;
    if (row.ordinal !== position) {
      errors.push(invariant(`${path}/ordinal`, "inventory-ordinal-order"));
    }
    const isChunk = row.role === EXPORT_DELETION_INVENTORY_ROLES.chunkArtifact
      || row.role === EXPORT_DELETION_INVENTORY_ROLES.chunkReceipt;
    if ((isChunk && row.chunkIndex === null) || (!isChunk && row.chunkIndex !== null)) {
      errors.push(invariant(`${path}/chunkIndex`, "role-chunk-index"));
    }
    if (singletonRoles.has(row.role)) {
      if (seenRoles.has(row.role)) {
        errors.push(invariant(`${path}/role`, "unique-singleton-role"));
      }
      seenRoles.add(row.role);
    }
    const identity = `${row.device}:${row.inode}`;
    if (seenIdentities.has(identity)) {
      errors.push(invariant(path, "unique-device-inode"));
    }
    seenIdentities.add(identity);
  }

  const expectedRoles = expectedInventoryRoles(rows);
  if (expectedRoles.length !== rows.length
      || expectedRoles.some((role, position) => rows[position]?.role !== role)) {
    errors.push(invariant("/inventory", "canonical-deletion-order"));
  }

  const chunkRows = rows.filter((row) => row.role === EXPORT_DELETION_INVENTORY_ROLES.chunkArtifact);
  const receiptRows = rows.filter((row) => row.role === EXPORT_DELETION_INVENTORY_ROLES.chunkReceipt);
  if (!contiguousChunkIndexes(chunkRows)) {
    errors.push(invariant("/inventory", "contiguous-chunk-artifact-indexes"));
  }
  if (!contiguousChunkIndexes(receiptRows)) {
    errors.push(invariant("/inventory", "contiguous-chunk-receipt-indexes"));
  }
  if (chunkRows.length !== receiptRows.length) {
    errors.push(invariant("/inventory", "paired-chunk-inventory"));
  }

  const controlFiles = rows.filter((row) => row.role === EXPORT_DELETION_INVENTORY_ROLES.setManifest
    || row.role === EXPORT_DELETION_INVENTORY_ROLES.setManifestReceipt).length;
  const workspaceFiles = rows.filter((row) => row.role === EXPORT_DELETION_INVENTORY_ROLES.workspaceDatabase
    || sidecarRoles.includes(row.role)).length;
  const totalBytes = rows.reduce((sum, row) => sum + row.byteSize, 0);
  const exactCounts = {
    chunkArtifacts: chunkRows.length,
    chunkReceipts: receiptRows.length,
    controlFiles,
    workspaceFiles,
    totalFiles: rows.length,
    totalBytes,
  };
  for (const [name, actual] of Object.entries(exactCounts)) {
    if (counts[name] !== actual) {
      errors.push(invariant(`/inventoryCounts/${name}`, `exact-${name}`));
    }
  }
  return errors;
}

export function validateExportDeletionPreflight(value) {
  return validationResult(validatePreflightSchema, value, preflightSemanticErrors);
}

export function validateExportDeletionJournal(value) {
  return validationResult(validateJournalSchema, value, journalSemanticErrors);
}

export function validateExportDeletionCommitMarker(value) {
  return validationResult(validateCommitMarkerSchema, value);
}

export function validateExportDeletionReceipt(value) {
  return validationResult(validateReceiptSchema, value);
}

function assertValid(label, validate, value) {
  const result = validate(value);
  if (!result.valid) {
    const summary = result.errors.map((error) => `${error.path}:${error.keyword}`).join(", ");
    throw new Error(`${label} failed validation (${summary})`);
  }
  return value;
}

export function assertValidExportDeletionPreflight(value) {
  return assertValid("Export deletion preflight", validateExportDeletionPreflight, value);
}

export function assertValidExportDeletionJournal(value) {
  return assertValid("Export deletion journal", validateExportDeletionJournal, value);
}

export function assertValidExportDeletionCommitMarker(value) {
  return assertValid("Export deletion commit marker", validateExportDeletionCommitMarker, value);
}

export function assertValidExportDeletionReceipt(value) {
  return assertValid("Export deletion receipt", validateExportDeletionReceipt, value);
}

export {
  preflightSchema as exportDeletionPreflightSchema,
  journalSchema as exportDeletionJournalSchema,
  commitMarkerSchema as exportDeletionCommitMarkerSchema,
  receiptSchema as exportDeletionReceiptSchema,
};
