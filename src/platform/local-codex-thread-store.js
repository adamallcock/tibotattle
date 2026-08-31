import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readBoundedUtf8LineEntries } from "./bounded-jsonl-reader.js";

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

const MAX_LOCAL_THREAD_LOOKUPS = 160;
const MAX_SESSION_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_INDEX_LINE_BYTES = 64 * 1024;
const MAX_SESSION_INDEX_LINES = 200_000;
const MAX_THREAD_DISPLAY_NAME_LENGTH = 512;
const MAX_AGENT_NICKNAME_LENGTH = 80;
const MAX_THREAD_SOURCE_LENGTH = 4_096;
const LOCAL_NAVIGATION_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function threadId(value) {
  return typeof value === "string" && LOCAL_NAVIGATION_THREAD_ID.test(value)
    ? value.toLowerCase()
    : null;
}

function displayName(value, maximumLength = MAX_THREAD_DISPLAY_NAME_LENGTH) {
  if (typeof value !== "string" || value.length > maximumLength
      || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sameOwnerControlledFile(before, after) {
  return ownerControlledRegularFile(after)
    && before.dev === after.dev && before.ino === after.ino;
}

async function ownerControlledCodexHome(codexHome) {
  if (typeof codexHome !== "string" || codexHome.length < 1) return false;
  try {
    const stats = await lstat(codexHome);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    return stats.isDirectory() && !stats.isSymbolicLink()
      && (uid === null || stats.uid === uid) && (stats.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function workerMetadata(source, id) {
  if (typeof source !== "string" || source.length > MAX_THREAD_SOURCE_LENGTH) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  // This is Codex's explicit collaboration ancestry, not rollout-fork lineage
  // or an inferred relationship from timestamps, names, or working directory.
  const spawn = parsed?.subagent?.thread_spawn;
  if (spawn === null || typeof spawn !== "object" || Array.isArray(spawn)) {
    return null;
  }
  const parentId = threadId(spawn.parent_thread_id);
  return parentId === null || parentId === id ? null : {
    parentId,
    nickname: displayName(spawn.agent_nickname, MAX_AGENT_NICKNAME_LENGTH),
  };
}

function boundedTextColumn(columns, name, maximumLength) {
  // Column names are a fixed internal allowlist, never caller-controlled SQL.
  // SQLite length(TEXT) stops at NUL, so independently cap encoded bytes before
  // a value crosses into JavaScript. Four bytes per character preserves UTF-8
  // names; the existing character and control checks still apply afterward.
  return columns.has(name)
    ? `CASE WHEN typeof(${name}) = 'text'
         AND length(CAST(${name} AS BLOB)) <= ${maximumLength * 4}
         AND length(${name}) <= ${maximumLength}
       THEN ${name} ELSE NULL END AS ${name}`
    : `NULL AS ${name}`;
}

async function safeSqliteSidecars(databaseFile) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      if (!ownerControlledRegularFile(await lstat(`${databaseFile}${suffix}`))) {
        return false;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
  }
  return true;
}

async function readSelectedThreadMetadata(codexHome, ids) {
  const databaseFile = join(codexHome, "state_5.sqlite");
  let database;
  try {
    const before = await lstat(databaseFile);
    if (!ownerControlledRegularFile(before)
        || !await safeSqliteSidecars(databaseFile)) return new Map();
    database = new DatabaseSync(databaseFile, { readOnly: true, timeout: 500 });
    if (!sameOwnerControlledFile(before, await lstat(databaseFile))) return new Map();
    database.exec("BEGIN");
    if (database.prepare(
      "SELECT type FROM sqlite_master WHERE name = 'threads'",
    ).get()?.type !== "table") return new Map();
    const info = database.prepare("PRAGMA table_info(threads)").all();
    if (!info.some((column) => column.name === "id" && column.pk > 0)) {
      return new Map();
    }
    const columns = new Set(info.map((column) => column.name));
    // `title` is deliberately never selected: older Codex databases store the
    // initial prompt there. Only an explicit `name`, the bounded agent nickname,
    // and structured source ancestry belong in this transient UI lookup.
    const selected = [
      "id",
      boundedTextColumn(columns, "name", MAX_THREAD_DISPLAY_NAME_LENGTH),
      boundedTextColumn(columns, "agent_nickname", MAX_AGENT_NICKNAME_LENGTH),
      boundedTextColumn(columns, "source", MAX_THREAD_SOURCE_LENGTH),
    ].join(", ");
    const statement = database.prepare(`SELECT ${selected} FROM threads WHERE id = ?`);
    const result = new Map();
    const parentIds = new Set();
    for (const id of ids) {
      const row = statement.get(id);
      if (row === undefined || threadId(row.id) !== id) continue;
      const worker = workerMetadata(row.source, id);
      const parentId = worker?.parentId ?? null;
      if (parentId !== null) parentIds.add(parentId);
      result.set(id, {
        name: displayName(row.name),
        nickname: displayName(row.agent_nickname, MAX_AGENT_NICKNAME_LENGTH)
          ?? worker?.nickname ?? null,
        parentId,
      });
    }
    for (const id of parentIds) {
      if (result.has(id)) continue;
      const row = statement.get(id);
      if (row !== undefined && threadId(row.id) === id) {
        result.set(id, {
          name: displayName(row.name),
          nickname: null,
          parentId: null,
        });
      }
    }
    return sameOwnerControlledFile(before, await lstat(databaseFile))
        && await safeSqliteSidecars(databaseFile)
      ? result
      : new Map();
  } catch {
    // Local display metadata is optional. Never expose paths or SQLite errors.
    return new Map();
  } finally {
    if (database?.isOpen) database.close();
  }
}

async function readSelectedSessionIndexNames(codexHome, selectedIds) {
  const file = join(codexHome, "session_index.jsonl");
  let handle;
  try {
    const before = await lstat(file);
    if (!ownerControlledRegularFile(before)
        || before.size > MAX_SESSION_INDEX_BYTES) return new Map();
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!sameOwnerControlledFile(before, await handle.stat())) return new Map();
    const last = Buffer.alloc(1);
    if (before.size > 0) await handle.read(last, 0, 1, before.size - 1);
    const names = new Map();
    let lines = 0;
    for await (const entry of readBoundedUtf8LineEntries(handle, {
      maximumLineBytes: MAX_SESSION_INDEX_LINE_BYTES,
      maximumTotalBytes: before.size,
      highWaterMark: 64 * 1024,
    })) {
      lines += 1;
      if (lines > MAX_SESSION_INDEX_LINES) return new Map();
      // An appended but unterminated record is not a published display name.
      if (entry.endByteExclusive === before.size && last[0] !== 0x0a) continue;
      if (entry.line.includes("\ufffd")) continue;
      let row;
      try {
        row = JSON.parse(entry.line);
      } catch {
        continue;
      }
      const id = threadId(row?.id);
      if (id === null || !selectedIds.has(id)) continue;
      const name = displayName(row.thread_name);
      const updated = typeof row.updated_at === "string"
          && row.updated_at.length <= 40
          && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(row.updated_at)
        ? Date.parse(row.updated_at)
        : NaN;
      if (name === null || !Number.isSafeInteger(updated)) continue;
      const prior = names.get(id);
      if (prior === undefined || updated > prior.updated) {
        names.set(id, { updated, name });
      } else if (updated === prior.updated && name !== prior.name) {
        // Conflicting equally current names do not justify choosing one.
        names.set(id, { updated, name: null });
      }
    }
    const after = await handle.stat();
    if (!sameOwnerControlledFile(before, after)
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || !sameOwnerControlledFile(before, await lstat(file))) return new Map();
    return new Map([...names].map(([id, value]) => [id, value.name]));
  } catch {
    return new Map();
  } finally {
    await handle?.close();
  }
}

/**
 * Resolve only selected usage-row UUIDs to ephemeral, local-only display
 * metadata. No prompt/transcript/body or `threads.title` is read; names and
 * ancestry must never enter accounting caches, derived indexes, or exports.
 */
export async function readCodexLocalThreadMetadata(codexHome, threadIds) {
  if (!Array.isArray(threadIds) || threadIds.length === 0
      || threadIds.length > MAX_LOCAL_THREAD_LOOKUPS
      || !await ownerControlledCodexHome(codexHome)) return new Map();
  const ids = [...new Set(threadIds.map(threadId))];
  if (ids.includes(null)) return new Map();
  const selected = await readSelectedThreadMetadata(codexHome, ids);
  const nameIds = new Set(ids);
  for (const id of ids) {
    const parentId = selected.get(id)?.parentId;
    if (parentId) nameIds.add(parentId);
  }
  const names = await readSelectedSessionIndexNames(codexHome, nameIds);
  return new Map(ids.map((id) => {
    const metadata = selected.get(id);
    const parentId = metadata?.parentId ?? null;
    return [id, {
      id,
      name: names.has(id) ? names.get(id) : metadata?.name ?? null,
      nickname: metadata?.nickname ?? null,
      parent: parentId === null ? null : {
        id: parentId,
        name: names.has(parentId)
          ? names.get(parentId)
          : selected.get(parentId)?.name ?? null,
      },
    }];
  }));
}
