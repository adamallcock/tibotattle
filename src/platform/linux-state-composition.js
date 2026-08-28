import { posix } from "node:path";

import { revalidateLinuxXdgRoots } from "./linux-xdg-paths.js";

export const LINUX_STATE_COMPOSITION_CONTRACT_VERSION =
  "linux-state-composition-v1";

const COMPOSITIONS = new WeakSet();

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Closed inventory for state consumers that must eventually be wired through
 * a Linux owner. It is documentation executable as data, not a support flag:
 * every row remains dormant until the shared composition root adopts it.
 */
export const LINUX_STATE_CONSUMER_INVENTORY = deepFreeze([
  {
    id: "participant_identity",
    owner: "state_and_secret_service_migration",
    relativePaths: [
      "export-participant-secret",
      "export-participant-secret.legacy-retired",
      "export-participant-secret.backend-retired",
    ],
  },
  {
    id: "account_observation",
    owner: "state_and_secret_service",
    relativePaths: ["account-observation-operation.lock"],
  },
  {
    id: "claude_callback",
    owner: "state_and_secret_service",
    relativePaths: ["claude-callback-lifecycle-v1"],
  },
  {
    id: "contribution_binding",
    owner: "state_and_secret_service",
    relativePaths: [
      "contribution-device-binding-v1.json",
      "contribution-device-renewal-v1.json",
    ],
  },
  {
    id: "collector_state",
    owner: "sqlite_state_unit",
    relativePaths: ["local-collector-state-v1.sqlite"],
  },
  {
    id: "collector_legacy_migration",
    owner: "bounded_one_time_migration",
    relativePaths: [
      "collector-events.jsonl",
      "collector-events.jsonl.projection-v1.json",
      "collector-checkpoint-v0.3.json",
      "collector-checkpoint-v0.3.json.batch-journal",
      "collector.lock",
      "local-replay-safe-accounting-v0.1.json",
      "local-replay-safe-accounting-v0.2.json",
    ],
  },
  {
    id: "legacy_analysis_index",
    owner: "dormant_rollback_sqlite_state_unit",
    relativePaths: [
      "local-analysis-index-v2.sqlite",
      "local-analysis-index-secret-v2",
    ],
  },
  {
    id: "archive_accounting_index",
    owner: "sqlite_state_unit",
    relativePaths: [
      "local-archive-accounting-index-v1.sqlite",
      "local-archive-accounting-index-v1-secret",
    ],
  },
  {
    id: "unified_index",
    owner: "sqlite_state_unit",
    relativePaths: [
      "local-unified-index-v1.sqlite",
      "local-unified-index-device-salt-v1",
    ],
  },
  {
    id: "claude_desktop_quota",
    owner: "sqlite_state_unit",
    relativePaths: [
      "claude-desktop-quota-state-v1.sqlite",
      "claude-desktop-quota-state-v1-secret",
    ],
  },
  {
    id: "claude_desktop_shadow",
    owner: "opt_in_development_sqlite_state_units",
    relativePaths: [
      "claude-desktop-shadow-canonical-v1.sqlite",
      "claude-desktop-shadow-ledger-v1.sqlite",
      "claude-desktop-shadow-state-v1.sqlite",
      "claude-desktop-shadow-state-v1-secret",
      "claude-desktop-pricing-cache-v1.sqlite",
    ],
  },
  {
    id: "contribution_queue",
    owner: "sqlite_state_unit",
    relativePaths: ["private/contribution-sync-v0.1.sqlite3"],
  },
  {
    id: "prepared_artifacts",
    owner: "prepared_artifact_directory",
    relativePaths: ["local-contribution-prepared-v0.1"],
  },
  {
    id: "review_pairs",
    owner: "review_archive_directory",
    relativePaths: ["local-contribution-reviews-v0.1"],
  },
  {
    id: "local_preferences",
    owner: "owner_only_state",
    relativePaths: [
      "private/automatic-contribution-v0.1.json",
      "private/automatic-contribution-v0.1.lock",
      "private/incremental-contribution-sync-v1.json",
      "private/hosted-signin-handoff-v1.json",
      "private/fast-mode-preference-v0.1.json",
      "private/codex-speed-baseline-v0.1.json",
    ],
  },
  {
    id: "activity_markers",
    owner: "owner_only_state",
    relativePaths: ["activity-markers-v0.1.jsonl"],
  },
  {
    id: "diagnostics_log",
    owner: "bounded_owner_only_log",
    relativePaths: ["diagnostics-v0.1.log"],
  },
]);

export const LINUX_EXTERNAL_OWNER_CONSUMER_INVENTORY = deepFreeze([
  {
    id: "metadata_bundles",
    owner: "explicit_export_workspace",
    state: "requires_explicit_owner_root",
  },
  {
    id: "deletion_controls",
    owner: "explicit_export_workspace_and_destination",
    state: "requires_explicit_owner_root",
  },
  {
    id: "discard_controls",
    owner: "explicit_export_workspace",
    state: "requires_explicit_owner_root",
  },
]);

function sqliteUnit(database) {
  return Object.freeze({
    database,
    rollbackJournal: `${database}-journal`,
    wal: `${database}-wal`,
    sharedMemory: `${database}-shm`,
  });
}

function fixedPaths(stateRoot) {
  const paths = {};
  for (const consumer of LINUX_STATE_CONSUMER_INVENTORY) {
    paths[consumer.id] = Object.freeze(
      consumer.relativePaths.map((relativePath) => posix.join(stateRoot, relativePath)),
    );
  }
  return Object.freeze(paths);
}

/**
 * Build the dormant Linux composition contract only from a filesystem-
 * validated XDG authority. Paths are internal wiring material and are never
 * a diagnostics or receipt shape.
 */
export async function createLinuxStateComposition({ validation } = {}) {
  const xdg = await revalidateLinuxXdgRoots(validation);
  const stateRoot = xdg.roots.application.state;
  const paths = fixedPaths(stateRoot);
  const value = deepFreeze({
    contractVersion: LINUX_STATE_COMPOSITION_CONTRACT_VERSION,
    platform: "linux",
    integrationStatus: "dormant",
    roots: {
      config: xdg.roots.application.config,
      state: stateRoot,
      cache: xdg.roots.application.cache,
      runtime: xdg.roots.application.runtime,
    },
    paths,
    sqliteUnits: {
      collectorState: sqliteUnit(paths.collector_state[0]),
      legacyAnalysisIndex: sqliteUnit(paths.legacy_analysis_index[0]),
      archiveAccountingIndex: sqliteUnit(paths.archive_accounting_index[0]),
      unifiedIndex: sqliteUnit(paths.unified_index[0]),
      claudeDesktopQuota: sqliteUnit(paths.claude_desktop_quota[0]),
      claudeDesktopShadowCanonical: sqliteUnit(paths.claude_desktop_shadow[0]),
      claudeDesktopShadowLedger: sqliteUnit(paths.claude_desktop_shadow[1]),
      claudeDesktopShadowState: sqliteUnit(paths.claude_desktop_shadow[2]),
      claudeDesktopPricingCache: sqliteUnit(paths.claude_desktop_shadow[4]),
      contributionQueue: sqliteUnit(paths.contribution_queue[0]),
    },
    externalOwners: LINUX_EXTERNAL_OWNER_CONSUMER_INVENTORY,
  });
  COMPOSITIONS.add(value);
  return value;
}

export function assertLinuxStateComposition(value) {
  if (!COMPOSITIONS.has(value)) {
    const error = new Error("Linux state composition is unavailable");
    error.name = "LinuxStateCompositionError";
    error.code = "linux_state_composition_untrusted";
    throw error;
  }
  return value;
}
