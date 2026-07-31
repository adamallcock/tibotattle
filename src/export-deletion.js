import {
  EXPORT_DELETION_COMMIT_MARKER_BASENAME,
  EXPORT_DELETION_JOURNAL_BASENAME,
  EXPORT_DELETION_RECEIPT_BASENAME,
} from "./export/index.js";
import { LEGACY_EXPORT_DELETION_INTERNAL } from "./export-deletion-compatibility-internal.js";

export {
  EXPORT_DELETION_COMMIT_MARKER_BASENAME,
  EXPORT_DELETION_JOURNAL_BASENAME,
  EXPORT_DELETION_RECEIPT_BASENAME,
};
export const ExportDeletionError = LEGACY_EXPORT_DELETION_INTERNAL.ExportDeletionError;
export const buildLocalExportDeletionPlan = LEGACY_EXPORT_DELETION_INTERNAL.buildLocalExportDeletionPlan;
export const planLocalExportDeletion = LEGACY_EXPORT_DELETION_INTERNAL.planLocalExportDeletion;
