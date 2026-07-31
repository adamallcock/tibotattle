/**
 * Runtime-neutral names shared by the deletion planner and durable owner.
 * These values deliberately contain no paths supplied by callers.
 */
export const EXPORT_DELETION_JOURNAL_BASENAME = ".app-usagemonitor-deletion-journal.json";
export const EXPORT_DELETION_COMMIT_MARKER_BASENAME = ".app-usagemonitor-deletion-commit.json";
export const EXPORT_DELETION_RECEIPT_BASENAME = "local-export-deletion-receipt.json";

export const EXPORT_DELETION_WORKSPACE_LOCK_BASENAME = ".app-usagemonitor-export-workspace.lock";
export const EXPORT_DELETION_DESTINATION_LOCK_BASENAME = ".app-usagemonitor-export.lock";
export const EXPORT_DELETION_DESTINATION_TRANSACTION_BASENAME = ".app-usagemonitor-export-transactions";
export const EXPORT_DELETION_QUARANTINE_PREFIX = ".app-usagemonitor-deletion-quarantine-";
