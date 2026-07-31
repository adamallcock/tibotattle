import { isProxy } from "node:util/types";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_VERSION,
  EXPORT_WORKSPACE_DISCARD_CONFIRMATION_TOKEN_PATTERN,
  EXPORT_WORKSPACE_DISCARD_JOURNAL_VERSION,
  EXPORT_WORKSPACE_DISCARD_ORDER_VERSION,
  EXPORT_WORKSPACE_DISCARD_PLAN_VERSION,
  EXPORT_WORKSPACE_DISCARD_PREFLIGHT_VERSION,
  EXPORT_WORKSPACE_DISCARD_RECEIPT_VERSION,
  EXPORT_WORKSPACE_DISCARD_ROLES,
  EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME,
  EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME,
  EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME,
  EXPORT_WORKSPACE_DISCARD_QUARANTINE_PREFIX,
  EXPORT_WORKSPACE_DISCARD_WORKSPACE_LOCK_BASENAME,
  EXPORT_WORKSPACE_DISCARD_TRANSACTION_BASENAME,
  assertValidExportWorkspaceDiscardCommitMarker,
  assertValidExportWorkspaceDiscardJournal,
  assertValidExportWorkspaceDiscardPreflight,
  assertValidExportWorkspaceDiscardReceipt,
  ExportResourceLimitError,
  stableJson,
} from "../export/index.js";

function invalid() { throw new TypeError("Local workspace discard configuration is invalid"); }
function own(object, key) {
  if (!object || typeof object !== "object" || Array.isArray(object) || isProxy(object)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
  return descriptor.value;
}
function callable(value) { if (typeof value !== "function" || isProxy(value)) invalid(); return value; }
function port(value, keys, classKeys = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) invalid();
  const methods = {};
  for (const key of keys) methods[key] = callable(own(value, key));
  const classes = {};
  for (const key of classKeys) classes[key] = callable(own(value, key));
  return Object.freeze({ methods: Object.freeze(methods), classes: Object.freeze(classes) });
}

function boundedDirectoryOptions(options) {
  if (options === undefined) return Object.freeze({ maximumEntries: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries, sort: false });
  if (!options || typeof options !== "object" || Array.isArray(options) || isProxy(options)) invalid();
  const allowed = new Set(["maximumEntries", "sort"]);
  for (const key of Object.getOwnPropertyNames(options)) if (!allowed.has(key)) invalid();
  const maximumEntries = Object.hasOwn(options, "maximumEntries") ? own(options, "maximumEntries")
    : DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries;
  const sort = Object.hasOwn(options, "sort") ? own(options, "sort") : false;
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1
      || maximumEntries > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries || typeof sort !== "boolean") invalid();
  return Object.freeze({ maximumEntries, sort });
}

function trustedResourceDirectoryLimit(error) {
  if (!ExportResourceLimitError.isTrustedExact(error)) return null;
  const code = Object.getOwnPropertyDescriptor(error, "code");
  if (!code || !Object.hasOwn(code, "value") || code.value !== "export_resource_directory_entries") return null;
  return new ExportResourceLimitError("directory_entries");
}

/**
 * Reviewed discard orchestration: schema semantics stay in export, concrete
 * filesystem work stays in platform, and callers receive a stable operation
 * context without importing either implementation owner.
 */
export function createLocalExportWorkspaceDiscard(configuration = {}) {
  const workspaceDatabaseBasename = own(configuration, "workspaceDatabaseBasename");
  const inspectExportWorkspaceDiscardState = callable(own(configuration, "inspectExportWorkspaceDiscardState"));
  const readBoundedDirectoryEntries = callable(own(configuration, "readBoundedDirectoryEntries"));
  const withExistingExportWorkspaceLease = callable(own(configuration, "withExistingExportWorkspaceLease"));
  const createPreflight = callable(own(configuration, "createPreflight"));
  const createStorage = callable(own(configuration, "createStorage"));
  if (typeof workspaceDatabaseBasename !== "string" || workspaceDatabaseBasename.length < 1) invalid();
  const trustedResourceLimits = new WeakSet();
  const boundedDirectoryEntries = async (directory, options = undefined) => {
    let safeOptions;
    try { safeOptions = boundedDirectoryOptions(options); } catch { invalid(); }
    try {
      return await Reflect.apply(readBoundedDirectoryEntries, undefined, [directory, safeOptions]);
    } catch (error) {
      const fresh = trustedResourceDirectoryLimit(error);
      if (fresh) {
        trustedResourceLimits.add(fresh);
        throw fresh;
      }
      throw error;
    }
  };
  let preflight;
  try {
    preflight = port(Reflect.apply(createPreflight, undefined, [Object.freeze({
      workspaceDatabaseBasename,
      maximumWorkspaceBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumWorkspaceBytes,
      readBoundedDirectoryEntries: boundedDirectoryEntries,
      inspectExportWorkspaceDiscardState,
      stableJson,
      assertValidExportWorkspaceDiscardJournal,
      assertValidExportWorkspaceDiscardPreflight,
      journalVersion: EXPORT_WORKSPACE_DISCARD_JOURNAL_VERSION,
      orderVersion: EXPORT_WORKSPACE_DISCARD_ORDER_VERSION,
      planVersion: EXPORT_WORKSPACE_DISCARD_PLAN_VERSION,
      preflightVersion: EXPORT_WORKSPACE_DISCARD_PREFLIGHT_VERSION,
      roles: EXPORT_WORKSPACE_DISCARD_ROLES,
      journalBasename: EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME,
      markerBasename: EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME,
      receiptBasename: EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME,
      quarantinePrefix: EXPORT_WORKSPACE_DISCARD_QUARANTINE_PREFIX,
      workspaceLockBasename: EXPORT_WORKSPACE_DISCARD_WORKSPACE_LOCK_BASENAME,
      transactionBasename: EXPORT_WORKSPACE_DISCARD_TRANSACTION_BASENAME,
      isTrustedResourceLimitError: (error) => Boolean(error && trustedResourceLimits.has(error)
        && Object.getPrototypeOf(error) === ExportResourceLimitError.prototype),
    })]), [
      "buildLocalExportWorkspaceDiscardPlan", "planLocalExportWorkspaceDiscard",
      "workspaceDiscardEvidenceToken", "workspaceDiscardDirectoryIdentityToken",
      "workspaceDiscardConfirmationToken", "isTrustedDiscardError",
    ], ["ExportWorkspaceDiscardError"]);
  } catch { invalid(); }
  let storage;
  try {
    storage = port(Reflect.apply(createStorage, undefined, [Object.freeze({
      buildLocalExportWorkspaceDiscardPlan: preflight.methods.buildLocalExportWorkspaceDiscardPlan,
      planLocalExportWorkspaceDiscard: preflight.methods.planLocalExportWorkspaceDiscard,
      workspaceDiscardDirectoryIdentityToken: preflight.methods.workspaceDiscardDirectoryIdentityToken,
      workspaceDiscardEvidenceToken: preflight.methods.workspaceDiscardEvidenceToken,
      stableJson,
      readBoundedDirectoryEntries: boundedDirectoryEntries,
      withExistingExportWorkspaceLease,
      assertValidExportWorkspaceDiscardCommitMarker,
      assertValidExportWorkspaceDiscardJournal,
      assertValidExportWorkspaceDiscardPreflight,
      assertValidExportWorkspaceDiscardReceipt,
      commitMarkerVersion: EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_VERSION,
      confirmationTokenPattern: EXPORT_WORKSPACE_DISCARD_CONFIRMATION_TOKEN_PATTERN,
      orderVersion: EXPORT_WORKSPACE_DISCARD_ORDER_VERSION,
      planVersion: EXPORT_WORKSPACE_DISCARD_PLAN_VERSION,
      receiptVersion: EXPORT_WORKSPACE_DISCARD_RECEIPT_VERSION,
      roles: EXPORT_WORKSPACE_DISCARD_ROLES,
      workspaceDatabaseBasename,
      journalBasename: EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME,
      markerBasename: EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME,
      receiptBasename: EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME,
      quarantinePrefix: EXPORT_WORKSPACE_DISCARD_QUARANTINE_PREFIX,
      workspaceLockBasename: EXPORT_WORKSPACE_DISCARD_WORKSPACE_LOCK_BASENAME,
      transactionBasename: EXPORT_WORKSPACE_DISCARD_TRANSACTION_BASENAME,
    })]), ["discardLocalExportWorkspace", "recoverLocalExportWorkspaceDiscard", "isTrustedExecutionError"], ["ExportWorkspaceDiscardExecutionError"]);
  } catch { invalid(); }
  return Object.freeze({
    ExportWorkspaceDiscardError: preflight.classes.ExportWorkspaceDiscardError,
    ExportWorkspaceDiscardExecutionError: storage.classes.ExportWorkspaceDiscardExecutionError,
    buildLocalExportWorkspaceDiscardPlan: preflight.methods.buildLocalExportWorkspaceDiscardPlan,
    planLocalExportWorkspaceDiscard: preflight.methods.planLocalExportWorkspaceDiscard,
    workspaceDiscardEvidenceToken: preflight.methods.workspaceDiscardEvidenceToken,
    workspaceDiscardDirectoryIdentityToken: preflight.methods.workspaceDiscardDirectoryIdentityToken,
    workspaceDiscardConfirmationToken: preflight.methods.workspaceDiscardConfirmationToken,
    discardLocalExportWorkspace: storage.methods.discardLocalExportWorkspace,
    recoverLocalExportWorkspaceDiscard: storage.methods.recoverLocalExportWorkspaceDiscard,
  });
}
