import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PRIMARY_COUNTS_SQL = `
SELECT
  (SELECT COUNT(*) FROM participants WHERE state = 'active') AS active_participants,
  (SELECT COUNT(*) FROM participants WHERE state = 'deleting') AS deleting_participants,
  (SELECT COUNT(*) FROM telemetry_contributions WHERE status = 'accepted')
    AS accepted_contributions,
  (SELECT COUNT(*) FROM telemetry_records) AS canonical_records,
  (SELECT COUNT(*) FROM telemetry_contribution_occurrences)
    AS contribution_occurrences,
  (SELECT COUNT(*) FROM telemetry_contributions
    WHERE quarantine_deleted_at IS NULL) AS retained_quarantine_references,
  (SELECT COUNT(*) FROM community_weekly_snapshots
    WHERE release_state = 'published') AS published_snapshots,
  (SELECT COUNT(*) FROM community_weekly_snapshots
    WHERE release_state = 'suppressed') AS suppressed_snapshots,
  (SELECT COUNT(*) FROM community_weekly_snapshots
    WHERE release_state = 'withdrawn') AS withdrawn_snapshots,
  (SELECT COUNT(*) FROM community_weekly_snapshots
    WHERE release_state = 'withdrawn'
      AND json_extract(payload_json, '$.releaseStatus') = 'suppressed'
      AND json_extract(payload_json, '$.reason') = 'privacy_release_policy_not_met'
      AND json_type(payload_json, '$.cells') = 'array'
      AND json_array_length(payload_json, '$.cells') = 0)
    AS withdrawn_suppressed_snapshots,
  (SELECT COUNT(*) FROM web_sessions WHERE state = 'active') AS active_sessions,
  (SELECT COUNT(*) FROM device_credentials WHERE state = 'active') AS active_devices;
`.trim();

const DELETION_COUNTS_SQL = `
SELECT COUNT(*) AS deletion_tombstones FROM deletion_tombstones;
`.trim();

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The backend returned an invalid ${label} count.`);
  }
  return value;
}

export function parseD1Result(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("Wrangler returned an invalid bounded D1 result.");
  }
  const first = Array.isArray(payload) ? payload[0] : null;
  const row = first && Array.isArray(first.results) ? first.results[0] : null;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Wrangler returned no bounded D1 result row.");
  }
  return row;
}

export function inspectLocalBackendState({
  persistTo,
  workerDirectory = resolve(fileURLToPath(new URL("..", import.meta.url))),
  spawn = spawnSync,
}) {
  const resolvedState = realpathSync(resolve(persistTo));
  const metadata = lstatSync(resolvedState);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The local backend state must be a real directory.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("The local backend state directory must be owner-only.");
  }
  const wrangler = resolve(
    workerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );

  const query = (binding, sql) => {
    const result = spawn(wrangler, [
      "d1",
      "execute",
      binding,
      "--local",
      "--persist-to",
      resolvedState,
      "--command",
      sql,
      "--json",
    ], {
      cwd: workerDirectory,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`The bounded ${binding} inspection failed.`);
    }
    return parseD1Result(result.stdout);
  };

  const primary = query("USAGE_MONITOR_DB", PRIMARY_COUNTS_SQL);
  const deletion = query("DELETION_LEDGER", DELETION_COUNTS_SQL);
  return {
    schemaVersion: "local-backend-state-summary-v0.1",
    stateDirectory: resolvedState,
    database: {
      activeParticipants: integer(primary.active_participants, "active participant"),
      deletingParticipants: integer(primary.deleting_participants, "deleting participant"),
      acceptedContributions: integer(
        primary.accepted_contributions,
        "accepted contribution",
      ),
      canonicalRecords: integer(primary.canonical_records, "canonical record"),
      contributionOccurrences: integer(
        primary.contribution_occurrences,
        "contribution occurrence",
      ),
      retainedQuarantineReferences: integer(
        primary.retained_quarantine_references,
        "retained quarantine reference",
      ),
      publishedSnapshots: integer(primary.published_snapshots, "published snapshot"),
      suppressedSnapshots: integer(primary.suppressed_snapshots, "suppressed snapshot"),
      withdrawnSnapshots: integer(primary.withdrawn_snapshots, "withdrawn snapshot"),
      withdrawnSuppressedSnapshots: integer(
        primary.withdrawn_suppressed_snapshots,
        "withdrawn empty suppressed snapshot",
      ),
      activeSessions: integer(primary.active_sessions, "active session"),
      activeDevices: integer(primary.active_devices, "active device"),
    },
    deletionLedger: {
      tombstones: integer(deletion.deletion_tombstones, "deletion tombstone"),
    },
    privacy: {
      includesIdentifiers: false,
      includesAuthorities: false,
      includesRecordContents: false,
      r2CountIsDirectlyInspected: false,
      quarantineReferenceMeaning:
        "Canonical accepted rows whose encrypted quarantine object is expected to remain.",
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const persistTo = optionValue(args, "--persist-to");
  if (!persistTo || args.length !== 2) {
    process.stderr.write(
      "Usage: inspect-local-backend-state.mjs --persist-to /absolute/owner-only/state\n",
    );
    process.exit(2);
  }
  const summary = inspectLocalBackendState({ persistTo });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
