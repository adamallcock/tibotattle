import Ajv from "ajv";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const EXPORT_WORKSPACE_DISCARD_PLAN_VERSION = "local-export-workspace-discard-plan-v0.1";
export const EXPORT_WORKSPACE_DISCARD_PREFLIGHT_VERSION = "usage-export-workspace-discard-preflight-v0.1";
export const EXPORT_WORKSPACE_DISCARD_JOURNAL_VERSION = "usage-export-workspace-discard-journal-v0.1";
export const EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_VERSION = "usage-export-workspace-discard-commit-marker-v0.1";
export const EXPORT_WORKSPACE_DISCARD_RECEIPT_VERSION = "usage-export-workspace-discard-receipt-v0.1";
export const EXPORT_WORKSPACE_DISCARD_ORDER_VERSION = "sqlite-sidecars-then-database-v1";
export const EXPORT_WORKSPACE_DISCARD_CONFIRMATION_TOKEN_PATTERN = "^[A-Z2-7]{16}$";

export const EXPORT_WORKSPACE_DISCARD_ROLES = Object.freeze({
  sqliteJournal: "workspace_sqlite_journal",
  sqliteWal: "workspace_sqlite_wal",
  sqliteShm: "workspace_sqlite_shm",
  database: "workspace_database",
});

const urls = Object.freeze({
  preflight: new URL("../../schemas/export-workspace-discard-v0.1/preflight-summary.schema.json", import.meta.url),
  journal: new URL("../../schemas/export-workspace-discard-v0.1/journal.schema.json", import.meta.url),
  commitMarker: new URL("../../schemas/export-workspace-discard-v0.1/commit-marker.schema.json", import.meta.url),
  receipt: new URL("../../schemas/export-workspace-discard-v0.1/receipt.schema.json", import.meta.url),
});

function digest(url) {
  return createHash("sha256").update(readFileSync(url)).digest("hex");
}

export const EXPORT_WORKSPACE_DISCARD_PREFLIGHT_SCHEMA_SHA256 = digest(urls.preflight);
export const EXPORT_WORKSPACE_DISCARD_JOURNAL_SCHEMA_SHA256 = digest(urls.journal);
export const EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_SCHEMA_SHA256 = digest(urls.commitMarker);
export const EXPORT_WORKSPACE_DISCARD_RECEIPT_SCHEMA_SHA256 = digest(urls.receipt);

const require = createRequire(import.meta.url);
export const exportWorkspaceDiscardPreflightSchema = require("../../schemas/export-workspace-discard-v0.1/preflight-summary.schema.json");
export const exportWorkspaceDiscardJournalSchema = require("../../schemas/export-workspace-discard-v0.1/journal.schema.json");
export const exportWorkspaceDiscardCommitMarkerSchema = require("../../schemas/export-workspace-discard-v0.1/commit-marker.schema.json");
export const exportWorkspaceDiscardReceiptSchema = require("../../schemas/export-workspace-discard-v0.1/receipt.schema.json");

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = {
  preflight: ajv.compile(exportWorkspaceDiscardPreflightSchema),
  journal: ajv.compile(exportWorkspaceDiscardJournalSchema),
  commitMarker: ajv.compile(exportWorkspaceDiscardCommitMarkerSchema),
  receipt: ajv.compile(exportWorkspaceDiscardReceiptSchema),
};

function safeErrors(errors = []) {
  return errors.slice(0, 20).map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    schemaPath: error.schemaPath,
  }));
}

function invariant(path, name) {
  return { path, keyword: "invariant", schemaPath: `#/x-invariant/${name}` };
}

function validate(name, value, semantic = () => []) {
  if (!validators[name](value)) return { valid: false, errors: safeErrors(validators[name].errors) };
  const errors = semantic(value).slice(0, 20);
  return { valid: errors.length === 0, errors };
}

function inventoryErrors(value) {
  const errors = [];
  const expectedOrder = [
    EXPORT_WORKSPACE_DISCARD_ROLES.sqliteJournal,
    EXPORT_WORKSPACE_DISCARD_ROLES.sqliteWal,
    EXPORT_WORKSPACE_DISCARD_ROLES.sqliteShm,
  ].filter((role) => value.inventory.some((row) => row.role === role));
  expectedOrder.push(EXPORT_WORKSPACE_DISCARD_ROLES.database);
  const seen = new Set();
  const seenEvidenceTokens = new Set();
  for (const [index, row] of value.inventory.entries()) {
    if (row.ordinal !== index) errors.push(invariant(`/inventory/${index}/ordinal`, "ordinal-order"));
    if (seen.has(row.role)) errors.push(invariant(`/inventory/${index}/role`, "unique-role"));
    seen.add(row.role);
    if (seenEvidenceTokens.has(row.evidenceToken)) {
      errors.push(invariant(`/inventory/${index}/evidenceToken`, "unique-evidence-token"));
    }
    seenEvidenceTokens.add(row.evidenceToken);
    if (row.role !== expectedOrder[index]) errors.push(invariant(`/inventory/${index}/role`, "fixed-order"));
  }
  const sidecars = value.inventory.length - 1;
  const bytes = value.inventory.reduce((sum, row) => sum + row.byteSize, 0);
  if (value.inventoryCounts.sqliteSidecars !== sidecars) errors.push(invariant("/inventoryCounts/sqliteSidecars", "sidecar-count"));
  if (value.inventoryCounts.totalFiles !== value.inventory.length) errors.push(invariant("/inventoryCounts/totalFiles", "file-count"));
  if (value.inventoryCounts.totalBytes !== bytes) errors.push(invariant("/inventoryCounts/totalBytes", "byte-count"));
  return errors;
}

function preflightErrors(value) {
  const errors = [];
  if (value.fileCounts.totalFiles !== value.fileCounts.sqliteSidecars + 1) {
    errors.push(invariant("/fileCounts/totalFiles", "file-count"));
  }
  if (value.byteCounts.totalBytes !== value.byteCounts.workspaceBytes) {
    errors.push(invariant("/byteCounts/totalBytes", "byte-count"));
  }
  return errors;
}

export function validateExportWorkspaceDiscardPreflight(value) { return validate("preflight", value, preflightErrors); }
export function validateExportWorkspaceDiscardJournal(value) { return validate("journal", value, inventoryErrors); }
export function validateExportWorkspaceDiscardCommitMarker(value) { return validate("commitMarker", value); }
export function validateExportWorkspaceDiscardReceipt(value) { return validate("receipt", value); }

function assertValid(result, value, label) {
  if (!result.valid) {
    const error = new TypeError(`Invalid ${label}`);
    error.validationErrors = result.errors;
    throw error;
  }
  return value;
}

export function assertValidExportWorkspaceDiscardPreflight(value) {
  return assertValid(validateExportWorkspaceDiscardPreflight(value), value, "workspace discard preflight");
}
export function assertValidExportWorkspaceDiscardJournal(value) {
  return assertValid(validateExportWorkspaceDiscardJournal(value), value, "workspace discard journal");
}
export function assertValidExportWorkspaceDiscardCommitMarker(value) {
  return assertValid(validateExportWorkspaceDiscardCommitMarker(value), value, "workspace discard commit marker");
}
export function assertValidExportWorkspaceDiscardReceipt(value) {
  return assertValid(validateExportWorkspaceDiscardReceipt(value), value, "workspace discard receipt");
}
