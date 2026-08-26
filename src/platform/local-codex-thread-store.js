import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CODEX_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CODEX_SELECTED_ROLLOUT_NAME = new RegExp(
  "^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-"
    + "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    + "(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?"
    + "\\.jsonl(?:\\.zst)?$",
  "iu",
);

function ownerControlledRegularFile(stats) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  return stats.isFile()
    && !stats.isSymbolicLink()
    && stats.nlink === 1
    && (currentUid === null || stats.uid === currentUid)
    && (stats.mode & 0o022) === 0;
}

/**
 * Read Codex's selected rollout heads from an owner-controlled, non-writable-
 * by-others database without retaining its titles, cwd,
 * prompts, previews or other thread-store content. Failure is a normal null
 * fallback: canonical metadata remains sufficient for accounting, while a
 * selected head only disambiguates which physical generation should provide
 * carried state to a later logical fork.
 */
export async function readCodexSelectedRolloutNames(codexHome) {
  if (typeof codexHome !== "string" || codexHome.length < 1) return null;
  // Windows cannot establish the owner-only POSIX proof used below. The
  // SQLite file is only a disambiguating hint, so fail closed and let the
  // canonical rollout metadata remain the source of truth.
  if (process.platform === "win32") return null;
  const databaseFile = join(codexHome, "state_5.sqlite");
  let stats;
  try {
    stats = await lstat(databaseFile);
  } catch {
    return null;
  }
  if (!ownerControlledRegularFile(stats)) return null;
  let database;
  try {
    database = new DatabaseSync(databaseFile, { readOnly: true, timeout: 2_000 });
    const columns = new Set(database.prepare("PRAGMA table_info(threads)")
      .all().map((row) => row.name));
    if (!columns.has("id") || !columns.has("rollout_path")) return null;
    const selected = new Map();
    for (const row of database.prepare(
      "SELECT id, rollout_path FROM threads",
    ).iterate()) {
      if (typeof row.id !== "string"
          || !CODEX_THREAD_ID.test(row.id)
          || typeof row.rollout_path !== "string") {
        continue;
      }
      const selectedName = basename(row.rollout_path);
      if (selectedName.length < 1 || selectedName.length > 255) continue;
      const selectedMatch = CODEX_SELECTED_ROLLOUT_NAME.exec(selectedName);
      if (selectedMatch === null
          || selectedMatch[1].toLowerCase() !== row.id.toLowerCase()) continue;
      selected.set(row.id.toLowerCase(), selectedName);
    }
    return selected;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}
