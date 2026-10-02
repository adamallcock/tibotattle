#!/usr/bin/env node
// PT-2-lite: secret-safe export and seal of the two Cloudflare D1 sources the
// GCP cutover imports from (fast-path decisions D1, D2 and D4).
//
// Sealed sources: the ingestion D1 (USAGE_MONITOR_DB) and the deletion-ledger
// D1 (DELETION_LEDGER), named by an owner 0600 inventory. The analytics D1 is
// never sealed for import (analytics history is recomputed), and any other D1
// id is CUTOVER_SOURCE_NOT_ALLOWED. The deletion ledger contributes only its
// content-free digest projection (cutover-source-projections.mjs); no ledger
// table, cooldown, 0053 fence, watermark or floor history is imported.
//
// Subcommands:
//   expected-ledger  the bare-name migration ledgers a source must carry,
//                    read from git objects at inventory.expectedSourceCommit
//                    (never the working tree): d1_migrations rows as Wrangler
//                    writes them and d1_storage_migrations rows (name, sha256)
//                    as d1-storage-wrangler.mjs:19-25 and :207-218 write them.
//   seal             verify the EP-8 fence and the barrier proof
//                    (cutover-source-fence.mjs), read bookmark B0 (must equal
//                    the fence receipt bookmark), the remote schema, ledgers,
//                    sqlite_sequence and per-table aggregates through the
//                    read-only transport, export through the injected spawn,
//                    read bookmark B1 (must equal B0), scan the dump for signed
//                    URLs, rebuild it with node:sqlite, VACUUM INTO one 0400
//                    file, delete the dump, and accept only when integrity,
//                    schema, ledgers, sequences and aggregates all hold.
//                    The manifest is 'tibotattle-cutover-seal-v1'; its sealId
//                    is the sha256 of the canonical manifest body, createdAt
//                    included.
//
// Secrecy: every remote call needs --remote plus --owner-read-only (the
// default is a dry run that spawns nothing). Child stdio is piped and
// discarded in memory; WRANGLER_LOG_PATH points into the owner directory and
// is deleted after the export. umask is 077 for the whole seal, outputs are
// created 0600 in a 0700 owner directory outside the repository and the
// scratchpad, and the dump is scanned with a closed set of signed-URL
// patterns (CUTOVER_SECRET_IN_OUTPUT). No row value, id or URL is ever placed
// in an error, receipt or log: only counts, digests, table names and codes.

import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, closeSync, openSync, readSync } from "node:fs";
import { chmod, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import providerSchemas from "../src/d1-provider-schema.json" with { type: "json" };
import { createWranglerQueryInvocation } from "./wrangler-query-launcher.mjs";

export const CUTOVER_SEAL_MANIFEST_SCHEMA = "tibotattle-cutover-seal-v1";
export const CUTOVER_INVENTORY_SCHEMA = "tibotattle-cutover-inventory-v1";
export const CUTOVER_EXPECTED_LEDGER_SCHEMA = "tibotattle-cutover-expected-ledger-v1";
export const CUTOVER_AGGREGATES_SCHEMA = "tibotattle-cutover-aggregates-v1";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const WORKER_ROOT = resolve(dirname(SCRIPT_FILE), "..");
export const REPOSITORY_ROOT = resolve(WORKER_ROOT, "..", "..");
const DEFAULT_CLI_PATH = join(WORKER_ROOT, "node_modules", "wrangler", "wrangler-dist", "cli.js");

/** The only sealable sources, in seal order, with the binding each must name. */
export const CUTOVER_SEALABLE_SOURCES = Object.freeze({
  ingestion: Object.freeze({
    binding: "USAGE_MONITOR_DB",
    fenceLabel: "ingestion",
    directories: Object.freeze([
      "migrations", "typed-ingestion-migrations", "ingestion-bridge-migrations",
      "typed-v11-admission-migrations", "typed-v1-admission-migrations", "ingestion-isolation-migrations",
    ]),
  }),
  "deletion-ledger": Object.freeze({
    binding: "DELETION_LEDGER",
    fenceLabel: "deletion-ledger",
    directories: Object.freeze(["deletion-ledger-migrations"]),
  }),
});
export const CUTOVER_SOURCE_ROLES = Object.freeze(Object.keys(CUTOVER_SEALABLE_SOURCES));
export const CUTOVER_LEDGER_TABLES = Object.freeze(["d1_migrations", "d1_storage_migrations"]);
const STORAGE_LEDGER_SQL = "CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT";

export const CUTOVER_ERROR_CODES = Object.freeze([
  "CUTOVER_AGGREGATE_MISMATCH",
  "CUTOVER_ARGUMENT_INVALID",
  "CUTOVER_BARRIER_PROOF_INVALID",
  "CUTOVER_ERASED_PARTICIPANT_PRESENT",
  "CUTOVER_EXPECTED_LEDGER_INVALID",
  "CUTOVER_EXPORT_FAILED",
  "CUTOVER_EXPORT_FILE_UNSAFE",
  "CUTOVER_EXPORT_PROVIDER_TABLE",
  "CUTOVER_EXPORT_STATEMENT_REFUSED",
  "CUTOVER_FENCE_RECEIPT_INVALID",
  "CUTOVER_FENCE_SOURCE_MISMATCH",
  "CUTOVER_INTEGRITY_FAILED",
  "CUTOVER_INVENTORY_INVALID",
  "CUTOVER_INVENTORY_UNSAFE",
  "CUTOVER_LEDGER_MISMATCH",
  "CUTOVER_LEDGER_NAME_NOT_BARE",
  "CUTOVER_OUTPUT_EXISTS",
  "CUTOVER_OWNER_DIRECTORY_UNSAFE",
  "CUTOVER_PROJECTION_INVALID",
  "CUTOVER_REBUILD_FAILED",
  "CUTOVER_REMOTE_NOT_AUTHORIZED",
  "CUTOVER_REMOTE_RESPONSE_INVALID",
  "CUTOVER_REMOTE_SQL_NOT_SELECT",
  "CUTOVER_SCHEMA_MISMATCH",
  "CUTOVER_SCHEMA_PROVIDER_TABLE_UNKNOWN",
  "CUTOVER_SEAL_ARTIFACT_LEFT",
  "CUTOVER_SEAL_MANIFEST_INVALID",
  "CUTOVER_SEALED_SOURCE_CHANGED",
  "CUTOVER_SEALED_SOURCE_UNSAFE",
  "CUTOVER_SECRET_IN_OUTPUT",
  "CUTOVER_SEQUENCE_MISMATCH",
  "CUTOVER_SOURCE_BOOKMARK_DRIFT",
  "CUTOVER_SOURCE_CHANGED_AFTER_SEAL",
  "CUTOVER_SOURCE_NOT_ALLOWED",
]);
const ERROR_CODES = new Set(CUTOVER_ERROR_CODES);

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEX32 = /^[0-9a-f]{32}$/u;
const DATABASE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const OPAQUE = /^[A-Za-z0-9-]{8,128}$/u;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const BARE_MIGRATION = /^\d{4}_[a-z0-9_-]+\.sql$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_INVENTORY_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SEALED_BYTES = 100 * 1024 * 1024 * 1024;
const MAX_SCHEMA_ROWS = 4096;
const MAX_LEDGER_ROWS = 512;
const AGGREGATE_BATCH_TABLES = 16;
const AGGREGATE_BATCH_SQL_BYTES = 60 * 1024;
const EXPORT_TIMEOUT_MILLISECONDS = 3_600_000;
const QUERY_TIMEOUT_MILLISECONDS = 120_000;
const READ_CHUNK_BYTES = 1024 * 1024;
const REBUILD_BATCH_BYTES = 1024 * 1024;
const SCAN_OVERLAP_BYTES = 512;
const FORBIDDEN_ENVIRONMENT = Object.freeze(["CLOUDFLARE_API_BASE_URL", "CF_API_BASE_URL", "WRANGLER_API_ENVIRONMENT", "CLOUDFLARE_ENV"]);

// The closed signed-URL scan. A match anywhere in an export (or in any
// artifact this tool would keep) is CUTOVER_SECRET_IN_OUTPUT.
export const SIGNED_URL_PATTERNS = Object.freeze([
  /X-Amz-(?:Signature|Credential|Security-Token|Algorithm)=/iu,
  /X-Goog-(?:Signature|Credential|Algorithm)=/iu,
  /[a-z0-9-]+\.r2\.cloudflarestorage\.com/iu,
  /[?&](?:Signature|sig|token|Policy|Key-Pair-Id)=[A-Za-z0-9%._~+/=-]{16,}/u,
  /https?:\/\/[^\s'"]+[?&]Expires=\d{6,}/u,
]);

export class CutoverSourceError extends Error {
  constructor(code, details = undefined) {
    const safe = {};
    if (details && typeof details === "object") {
      if (typeof details.role === "string" && CUTOVER_SOURCE_ROLES.includes(details.role)) safe.role = details.role;
      if (typeof details.table === "string" && IDENTIFIER.test(details.table)) safe.table = details.table;
      if (typeof details.check === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(details.check)) safe.check = details.check;
    }
    const suffix = Object.entries(safe).map(([key, value]) => `${key}=${value}`).join(" ");
    super(suffix ? `${code} [${suffix}]` : code);
    this.name = "CutoverSourceError";
    this.code = ERROR_CODES.has(code) ? code : "CUTOVER_ARGUMENT_INVALID";
    Object.assign(this, safe);
  }
}

export function cutoverFail(code, details = undefined) {
  throw new CutoverSourceError(ERROR_CODES.has(code) ? code : "CUTOVER_ARGUMENT_INVALID", details);
}
const fail = cutoverFail;

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Sorted-key JSON; bigint renders as its decimal string, bytes as hex. */
export function canonicalJson(value) {
  const canonical = (item) => {
    if (typeof item === "bigint") return item.toString();
    if (item instanceof Uint8Array) return Buffer.from(item).toString("hex");
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]));
    }
    if (typeof item === "number" && !Number.isFinite(item)) return String(item);
    return item;
  };
  return JSON.stringify(canonical(value));
}

export function idDigest(kind, value) {
  return sha256Hex(`${kind}:${value}`);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code) {
  if (!record(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail(code);
}

export function quoteSqliteIdentifier(name) {
  if (typeof name !== "string" || !IDENTIFIER.test(name)) fail("CUTOVER_ARGUMENT_INVALID");
  return `"${name}"`;
}

// ---------------------------------------------------------------------------
// Private files and the owner directory.

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

/** Read a regular, owner-owned, single-link file with no group or other bits. */
export async function readPrivateFile(path, maxBytes, code, { allowEmpty = false } = {}) {
  let handle;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || await realpath(path) !== path) fail(code);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o077) !== 0
        || before.uid !== currentUid() || (before.size === 0 && !allowEmpty) || before.size > maxBytes) fail(code);
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) fail(code);
    const bytes = await handle.readFile();
    if (bytes.length !== before.size) fail(code);
    return bytes;
  } catch (error) {
    if (error instanceof CutoverSourceError) throw error;
    return fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function pathWithin(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Prefixes a seal output may never live under: the repository and any agent scratchpad. */
export function forbiddenOutputRoots() {
  return Object.freeze([REPOSITORY_ROOT, "/private/tmp/claude-", "/tmp/claude-"]);
}

/**
 * The owner directory: absolute, canonical, a real directory owned by the
 * caller with mode 0700 (no group or other bits), and outside the repository
 * and the agent scratchpad.
 */
export async function assertOwnerDirectory(path, { forbiddenRoots = forbiddenOutputRoots() } = {}) {
  let info;
  let canonical;
  try {
    if (typeof path !== "string" || !isAbsolute(path)) fail("CUTOVER_OWNER_DIRECTORY_UNSAFE");
    info = await lstat(path);
    canonical = await realpath(path);
  } catch (error) {
    if (error instanceof CutoverSourceError) throw error;
    fail("CUTOVER_OWNER_DIRECTORY_UNSAFE");
  }
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolve(path)
      || (info.mode & 0o777) !== 0o700 || info.uid !== currentUid()) {
    fail("CUTOVER_OWNER_DIRECTORY_UNSAFE");
  }
  let repository = REPOSITORY_ROOT;
  try { repository = await realpath(REPOSITORY_ROOT); } catch { /* keep the lexical root */ }
  for (const root of forbiddenRoots) {
    if (root === REPOSITORY_ROOT ? pathWithin(canonical, repository) || pathWithin(canonical, REPOSITORY_ROOT)
      : canonical.startsWith(root)) {
      fail("CUTOVER_OWNER_DIRECTORY_UNSAFE");
    }
  }
  return canonical;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return fail("CUTOVER_OWNER_DIRECTORY_UNSAFE");
  }
}

async function createPrivateEmptyFile(path) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600);
  } catch (error) {
    if (error?.code === "EEXIST") fail("CUTOVER_OUTPUT_EXISTS");
    fail("CUTOVER_OWNER_DIRECTORY_UNSAFE");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** Write bytes to a fresh file 0600, fsync, then chmod to the final mode. */
export async function writePrivateFileOnce(path, bytes, finalMode = 0o400) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") fail("CUTOVER_OUTPUT_EXISTS");
    fail("CUTOVER_OWNER_DIRECTORY_UNSAFE");
  } finally {
    await handle?.close().catch(() => {});
  }
  await chmod(path, finalMode);
  return sha256Hex(bytes);
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Inventory.

function validateLedgerLayout(role, ledgers) {
  if (!record(ledgers) || Object.keys(ledgers).some(key => !CUTOVER_LEDGER_TABLES.includes(key))) {
    fail("CUTOVER_INVENTORY_INVALID");
  }
  const allowed = CUTOVER_SEALABLE_SOURCES[role].directories;
  const seen = new Set();
  const layout = {};
  for (const table of CUTOVER_LEDGER_TABLES) {
    const directories = ledgers[table] ?? [];
    if (!Array.isArray(directories)) fail("CUTOVER_INVENTORY_INVALID");
    for (const directory of directories) {
      if (typeof directory !== "string" || !allowed.includes(directory) || seen.has(directory)) {
        fail("CUTOVER_INVENTORY_INVALID");
      }
      seen.add(directory);
    }
    if (directories.length > 0) layout[table] = Object.freeze([...directories]);
  }
  // Every migration directory of the role is recorded in exactly one ledger.
  if (seen.size !== allowed.length) fail("CUTOVER_INVENTORY_INVALID");
  return Object.freeze(layout);
}

/**
 * The owner inventory names exactly the ingestion and deletion-ledger D1s.
 * Any other role or a second entry for a role is CUTOVER_SOURCE_NOT_ALLOWED;
 * the analytics D1 is never sealed for import.
 */
export function validateCutoverInventory(value) {
  exactKeys(value, ["schema", "accountId", "expectedSourceCommit", "sources"], "CUTOVER_INVENTORY_INVALID");
  if (value.schema !== CUTOVER_INVENTORY_SCHEMA || typeof value.accountId !== "string" || !HEX32.test(value.accountId)
      || typeof value.expectedSourceCommit !== "string" || !COMMIT.test(value.expectedSourceCommit)
      || !Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > 8) {
    fail("CUTOVER_INVENTORY_INVALID");
  }
  const sources = {};
  const ids = new Set();
  for (const source of value.sources) {
    if (!record(source)) fail("CUTOVER_INVENTORY_INVALID");
    if (typeof source.role !== "string" || !Object.hasOwn(CUTOVER_SEALABLE_SOURCES, source.role)
        || Object.hasOwn(sources, source.role)) {
      fail("CUTOVER_SOURCE_NOT_ALLOWED");
    }
    exactKeys(source, ["role", "binding", "databaseName", "databaseId", "ledgers"], "CUTOVER_INVENTORY_INVALID");
    if (source.binding !== CUTOVER_SEALABLE_SOURCES[source.role].binding
        || typeof source.databaseName !== "string" || !DATABASE_NAME.test(source.databaseName)
        || typeof source.databaseId !== "string" || !UUID.test(source.databaseId) || ids.has(source.databaseId)) {
      fail("CUTOVER_INVENTORY_INVALID");
    }
    ids.add(source.databaseId);
    sources[source.role] = Object.freeze({
      role: source.role,
      binding: source.binding,
      databaseName: source.databaseName,
      databaseId: source.databaseId,
      databaseIdSha256: idDigest("d1", source.databaseId),
      ledgers: validateLedgerLayout(source.role, source.ledgers),
    });
  }
  if (CUTOVER_SOURCE_ROLES.some(role => !Object.hasOwn(sources, role))) fail("CUTOVER_INVENTORY_INVALID");
  const inventory = Object.freeze({
    schema: value.schema,
    accountId: value.accountId,
    expectedSourceCommit: value.expectedSourceCommit,
    sources: Object.freeze(sources),
  });
  return Object.freeze({ ...inventory, inventorySha256: sha256Hex(canonicalJson(value)) });
}

export async function readCutoverInventory(path) {
  const bytes = await readPrivateFile(path, MAX_INVENTORY_BYTES, "CUTOVER_INVENTORY_UNSAFE");
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("CUTOVER_INVENTORY_INVALID");
  }
  return validateCutoverInventory(parsed);
}

/** The inventory entry for a D1 id or role; anything else is not allowed. */
export function allowedCutoverSource(inventory, { role, databaseId } = {}) {
  const candidates = Object.values(inventory?.sources ?? {});
  const found = candidates.find(source => (role === undefined || source.role === role)
    && (databaseId === undefined || source.databaseId === databaseId));
  if (found === undefined || (role === undefined && databaseId === undefined)) fail("CUTOVER_SOURCE_NOT_ALLOWED");
  return found;
}

// ---------------------------------------------------------------------------
// Expected ledgers from the clean tree at a commit.

function defaultGit(args, { repositoryRoot }) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Build a source's expected ledgers from git objects at the commit, with BARE
 * migration names in each ledger's directory order: d1_migrations as names,
 * d1_storage_migrations as (name, sha256 of the exact file bytes).
 */
export function buildExpectedLedger({ source, commit, repositoryRoot = REPOSITORY_ROOT, git = defaultGit } = {}) {
  if (!record(source) || !Object.hasOwn(CUTOVER_SEALABLE_SOURCES, source.role)
      || typeof commit !== "string" || !COMMIT.test(commit)) {
    fail("CUTOVER_EXPECTED_LEDGER_INVALID");
  }
  const run = (args) => {
    try {
      return git(args, { repositoryRoot });
    } catch {
      return fail("CUTOVER_EXPECTED_LEDGER_INVALID", { role: source.role });
    }
  };
  const type = run(["cat-file", "-t", commit]).toString("utf8").trim();
  if (type !== "commit") fail("CUTOVER_EXPECTED_LEDGER_INVALID", { role: source.role });
  const ledgers = {};
  for (const table of CUTOVER_LEDGER_TABLES) {
    const directories = source.ledgers[table];
    if (directories === undefined) continue;
    const rows = [];
    for (const directory of directories) {
      const listing = run(["ls-tree", "--full-tree", "-z", "--name-only", `${commit}:apps/worker/${directory}`]).toString("utf8")
        .split("\0").filter(Boolean);
      const sqlFiles = listing.filter(name => name.endsWith(".sql"));
      if (sqlFiles.length === 0 || sqlFiles.some(name => !BARE_MIGRATION.test(name))) {
        fail("CUTOVER_EXPECTED_LEDGER_INVALID", { role: source.role });
      }
      for (const name of [...sqlFiles].sort()) {
        if (table === "d1_storage_migrations") {
          const bytes = run(["cat-file", "blob", `${commit}:apps/worker/${directory}/${name}`]);
          rows.push(Object.freeze({ name, sha256: sha256Hex(bytes) }));
        } else {
          rows.push(Object.freeze({ name }));
        }
      }
    }
    const names = rows.map(row => row.name);
    if (new Set(names).size !== names.length) fail("CUTOVER_EXPECTED_LEDGER_INVALID", { role: source.role });
    ledgers[table] = Object.freeze(rows);
  }
  const body = { schema: CUTOVER_EXPECTED_LEDGER_SCHEMA, role: source.role, commit, ledgers };
  return Object.freeze({ ...body, ledgers: Object.freeze(ledgers), sha256: sha256Hex(canonicalJson(body)) });
}

// ---------------------------------------------------------------------------
// Schema predicate, ledgers, sequences and aggregates (remote and local
// alike: the same SQL runs on both sides).

export const CUTOVER_SCHEMA_SQL = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT 4097";
export const CUTOVER_SEQUENCE_SQL = "SELECT name,seq FROM sqlite_sequence ORDER BY name LIMIT 4097";
export const CUTOVER_LEDGER_SQL = Object.freeze({
  d1_migrations: "SELECT id,name FROM d1_migrations ORDER BY id LIMIT 513",
  d1_storage_migrations: "SELECT name,sha256 FROM d1_storage_migrations ORDER BY name LIMIT 513",
});

function providerSchemaRow(row) {
  return providerSchemas.some(provider => ["type", "name", "tbl_name", "sql"].every(key => row[key] === provider[key]));
}

/** Normalize sqlite_schema rows under the shared predicate: drop sqlite_* and exact provider rows. */
export function normalizeSchemaRows(rows, role) {
  if (!Array.isArray(rows) || rows.length > MAX_SCHEMA_ROWS) fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role });
  const kept = [];
  for (const row of rows) {
    if (!record(row) || Object.keys(row).sort().join(",") !== "name,sql,tbl_name,type"
        || !["table", "index", "trigger", "view"].includes(row.type) || typeof row.name !== "string"
        || typeof row.tbl_name !== "string" || !(typeof row.sql === "string" || row.sql === null)) {
      fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role });
    }
    if (row.name.startsWith("sqlite_")) continue;
    if (providerSchemaRow(row)) continue;
    if (row.name.startsWith("_cf_") || row.tbl_name.startsWith("_cf_")) {
      fail("CUTOVER_SCHEMA_PROVIDER_TABLE_UNKNOWN", { role });
    }
    kept.push(Object.freeze({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql }));
  }
  kept.sort((left, right) => (left.type < right.type ? -1 : left.type > right.type ? 1
    : left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return Object.freeze(kept);
}

export function schemaDigest(rows) {
  return sha256Hex(canonicalJson(rows));
}

/** Columns and the first key column of every table, derived from the schema DDL alone. */
export function tableLayouts(schemaRows) {
  const database = new DatabaseSync(":memory:");
  try {
    const tables = schemaRows.filter(row => row.type === "table");
    for (const table of tables) {
      if (typeof table.sql !== "string" || !IDENTIFIER.test(table.name)) fail("CUTOVER_SCHEMA_MISMATCH");
      database.exec(table.sql);
    }
    return Object.freeze(tables.map(table => {
      const columns = database.prepare(`PRAGMA table_xinfo(${quoteSqliteIdentifier(table.name)})`).all()
        .filter(column => Number(column.hidden) === 0);
      if (columns.length === 0 || columns.some(column => !IDENTIFIER.test(column.name))) {
        fail("CUTOVER_SCHEMA_MISMATCH", { table: table.name });
      }
      const key = columns.filter(column => Number(column.pk) > 0).sort((left, right) => Number(left.pk) - Number(right.pk))[0];
      return Object.freeze({
        table: table.name,
        columns: Object.freeze(columns.map(column => column.name)),
        key: key?.name ?? null,
      });
    }).sort((left, right) => (left.table < right.table ? -1 : left.table > right.table ? 1 : 0)));
  } catch (error) {
    if (error instanceof CutoverSourceError) throw error;
    return fail("CUTOVER_SCHEMA_MISMATCH");
  } finally {
    database.close();
  }
}

function aggregateSelect(layout) {
  const table = quoteSqliteIdentifier(layout.table);
  const lengths = layout.columns.map(column => {
    const name = quoteSqliteIdentifier(column);
    return `coalesce(sum(CASE typeof(${name}) WHEN 'text' THEN length(CAST(${name} AS BLOB)) WHEN 'blob' THEN length(${name}) ELSE 0 END),0)`;
  }).join("+");
  const reals = layout.columns.map(column => {
    const name = quoteSqliteIdentifier(column);
    return `total(CASE WHEN typeof(${name}) IN ('integer','real') THEN ${name} END)`;
  }).join("+");
  const key = layout.key === null ? "NULL" : quoteSqliteIdentifier(layout.key);
  return `SELECT '${layout.table}' AS t,count(*) AS n,(${lengths}) AS len,min(${key}) AS kmin,max(${key}) AS kmax,(${reals}) AS rsum FROM ${table}`;
}

/** SELECT-only aggregate queries, batched by table count and SQL size. */
export function aggregateQueries(layouts) {
  const queries = [];
  let batch = [];
  let bytes = 0;
  for (const layout of layouts) {
    const select = aggregateSelect(layout);
    const size = Buffer.byteLength(select) + 11;
    if (batch.length > 0 && (batch.length >= AGGREGATE_BATCH_TABLES || bytes + size > AGGREGATE_BATCH_SQL_BYTES)) {
      queries.push(batch.join(" UNION ALL "));
      batch = [];
      bytes = 0;
    }
    batch.push(select);
    bytes += size;
  }
  if (batch.length > 0) queries.push(batch.join(" UNION ALL "));
  return Object.freeze(queries);
}

function aggregateNumber(value) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return value.toString();
    return Number(value);
  }
  return value;
}

/** Content-free per-table aggregate digests: the raw key min/max never leave memory. */
export function normalizeAggregates(rows, layouts, role) {
  const byTable = new Map();
  for (const row of rows) {
    if (!record(row) || typeof row.t !== "string" || byTable.has(row.t)) fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role });
    const n = aggregateNumber(row.n);
    const len = aggregateNumber(row.len);
    const real = aggregateNumber(row.rsum);
    if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(len) || len < 0 || typeof real !== "number") {
      fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role, table: IDENTIFIER.test(row.t) ? row.t : undefined });
    }
    const keyValue = (value) => {
      const normalized = aggregateNumber(value);
      if (normalized === null || typeof normalized === "string" || typeof normalized === "number") return normalized;
      if (normalized instanceof Uint8Array) return { blob: Buffer.from(normalized).toString("hex") };
      return fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role });
    };
    byTable.set(row.t, { n, len, kmin: keyValue(row.kmin), kmax: keyValue(row.kmax), real });
  }
  const tables = {};
  for (const layout of layouts) {
    const values = byTable.get(layout.table);
    if (values === undefined) fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role, table: layout.table });
    byTable.delete(layout.table);
    tables[layout.table] = Object.freeze({
      rows: values.n,
      aggregateSha256: sha256Hex(canonicalJson({ schema: CUTOVER_AGGREGATES_SCHEMA, table: layout.table, ...values })),
    });
  }
  if (byTable.size !== 0) fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role });
  return Object.freeze({ tables: Object.freeze(tables), sha256: sha256Hex(canonicalJson(tables)) });
}

function normalizeLedgerRows(table, rows, role) {
  if (!Array.isArray(rows) || rows.length > MAX_LEDGER_ROWS) fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role });
  const normalized = rows.map(row => {
    if (!record(row) || typeof row.name !== "string") fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role });
    if (!BARE_MIGRATION.test(row.name)) {
      if (row.name.includes("/") || /\.sql$/u.test(row.name)) fail("CUTOVER_LEDGER_NAME_NOT_BARE", { role, table });
      fail("CUTOVER_LEDGER_MISMATCH", { role, table });
    }
    if (table === "d1_storage_migrations") {
      if (typeof row.sha256 !== "string" || !SHA256.test(row.sha256)) fail("CUTOVER_LEDGER_MISMATCH", { role, table });
      return Object.freeze({ name: row.name, sha256: row.sha256 });
    }
    return Object.freeze({ name: row.name });
  });
  return Object.freeze(normalized);
}

function compareLedgerToExpected(table, rows, expected, role) {
  const want = table === "d1_storage_migrations"
    ? [...expected].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    : expected;
  if (canonicalJson(rows) !== canonicalJson(want)) fail("CUTOVER_LEDGER_MISMATCH", { role, table });
}

function normalizeSequenceRows(rows, role) {
  if (!Array.isArray(rows) || rows.length > MAX_SCHEMA_ROWS) fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role });
  return Object.freeze(rows.map(row => {
    const seq = aggregateNumber(row?.seq);
    if (!record(row) || typeof row.name !== "string" || !IDENTIFIER.test(row.name) || !Number.isSafeInteger(seq)) {
      fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role });
    }
    return Object.freeze({ name: row.name, seq });
  }));
}

// ---------------------------------------------------------------------------
// The read-only remote transport.

const MUTATION_KEYWORDS = /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|TRUNCATE|GRANT|REVOKE|load_extension|writefile|readfile)\b/iu;

/**
 * One SELECT statement and nothing else: no statement separator, no comment,
 * no mutation or session keyword outside a quoted identifier or literal.
 */
export function assertSelectOnly(sql) {
  if (typeof sql !== "string" || sql.length === 0 || Buffer.byteLength(sql) > 96 * 1024 || sql.includes("\0")) {
    fail("CUTOVER_REMOTE_SQL_NOT_SELECT");
  }
  if (!/^SELECT\s/u.test(sql) || sql.includes(";") || sql.includes("--") || sql.includes("/*")) {
    fail("CUTOVER_REMOTE_SQL_NOT_SELECT");
  }
  const stripped = sql.replace(/"[^"]*"/gu, "\"\"").replace(/'[^']*'/gu, "''");
  if (MUTATION_KEYWORDS.test(stripped)) fail("CUTOVER_REMOTE_SQL_NOT_SELECT");
  return sql;
}

/**
 * Wrap an injected transport: every call names an inventory source (anything
 * else is CUTOVER_SOURCE_NOT_ALLOWED), every query is SELECT-only, and every
 * response is checked before use.
 */
export function guardCutoverTransport(transport, inventory) {
  if (!record(transport) || typeof transport.bookmark !== "function" || typeof transport.query !== "function") {
    fail("CUTOVER_ARGUMENT_INVALID");
  }
  const target = (source) => allowedCutoverSource(inventory, { role: source?.role, databaseId: source?.databaseId });
  return Object.freeze({
    async bookmark(source) {
      const allowed = target(source);
      let value;
      try {
        value = await transport.bookmark(allowed);
      } catch (error) {
        if (error instanceof CutoverSourceError) throw error;
        fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role: allowed.role });
      }
      if (typeof value !== "string" || !OPAQUE.test(value)) fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role: allowed.role });
      return value;
    },
    async query(source, sql) {
      const allowed = target(source);
      assertSelectOnly(sql);
      let rows;
      try {
        rows = await transport.query(allowed, sql);
      } catch (error) {
        if (error instanceof CutoverSourceError) throw error;
        fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role: allowed.role });
      }
      if (!Array.isArray(rows)) fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role: allowed.role });
      return rows;
    },
  });
}

function wranglerEnvironment(environment, accountId, logPath) {
  if (FORBIDDEN_ENVIRONMENT.some(key => Object.hasOwn(environment, key))) fail("CUTOVER_REMOTE_NOT_AUTHORIZED");
  return {
    ...environment,
    CI: "true",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_LOG_PATH: logPath,
  };
}

/** The pinned one-database Wrangler config of a role (account id, D1 name and id; 0600). */
function pinnedConfigPath(directory, role) {
  return join(directory, `${role}.wrangler.json`);
}

async function writePinnedConfig(directory, source, accountId) {
  const body = `${JSON.stringify({
    name: "tibotattle-cutover-seal",
    account_id: accountId,
    compatibility_date: "2026-09-11",
    d1_databases: [{ binding: source.binding, database_name: source.databaseName, database_id: source.databaseId }],
  })}\n`;
  const path = pinnedConfigPath(directory, source.role);
  if (!await exists(path)) await writePrivateFileOnce(path, body, 0o600);
  const stored = await readPrivateFile(path, 64 * 1024, "CUTOVER_OWNER_DIRECTORY_UNSAFE");
  if (!stored.equals(Buffer.from(body))) fail("CUTOVER_OWNER_DIRECTORY_UNSAFE");
  return path;
}

/**
 * The real read-only Wrangler transport (pinned private one-database config,
 * the reviewed query launcher, child stdio piped and dropped). It needs
 * remote plus ownerReadOnly; tests drive it only through an injected spawn,
 * never the provider. Each role's pinned config is written once into
 * transportDirectory (a config this transport did not write is
 * CUTOVER_OUTPUT_EXISTS) and dispose() removes every config it wrote; the
 * caller disposes on success and on failure.
 */
export function createWranglerCutoverTransport({
  inventory, transportDirectory, cliPath = DEFAULT_CLI_PATH, spawn = spawnSync, environment = process.env,
  remote = false, ownerReadOnly = false,
} = {}) {
  if (remote !== true || ownerReadOnly !== true) fail("CUTOVER_REMOTE_NOT_AUTHORIZED");
  let sequence = 0;
  const configs = new Set();
  // Track the path before the first write so a failed write is still removed.
  const pinnedConfig = async (source) => {
    const path = pinnedConfigPath(transportDirectory, source.role);
    if (!configs.has(path) && await exists(path)) fail("CUTOVER_OUTPUT_EXISTS", { role: source.role });
    configs.add(path);
    return writePinnedConfig(transportDirectory, source, inventory.accountId);
  };
  const run = (command, args, logPath) => {
    let result;
    try {
      result = spawn(command, args, {
        cwd: transportDirectory, encoding: "utf8", timeout: QUERY_TIMEOUT_MILLISECONDS, maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"], env: wranglerEnvironment(environment, inventory.accountId, logPath),
      });
    } catch {
      result = { status: null };
    }
    const stdout = result?.status === 0 && !result.error ? String(result.stdout ?? "") : null;
    return stdout;
  };
  return Object.freeze({
    async bookmark(source) {
      const config = await pinnedConfig(source);
      const logPath = join(transportDirectory, `${source.role}.bookmark-${sequence++}.log`);
      try {
        const stdout = run(process.execPath, [cliPath, "d1", "time-travel", "info", source.databaseName, "--json",
          "--config", config], logPath);
        if (stdout === null) fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role: source.role });
        let parsed;
        try { parsed = JSON.parse(stdout); } catch { fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role: source.role }); }
        return parsed?.bookmark;
      } finally {
        await removeIfPresent(logPath).catch(() => {});
      }
    },
    async query(source, sql) {
      assertSelectOnly(sql);
      const config = await pinnedConfig(source);
      const sqlPath = join(transportDirectory, `${source.role}.query-${sequence++}.sql`);
      const logPath = `${sqlPath}.log`;
      await writePrivateFileOnce(sqlPath, sql, 0o600);
      try {
        const invocation = createWranglerQueryInvocation({ cliPath, configPath: config, binding: source.binding,
          databaseId: source.databaseId, mode: "remote", sqlPath, expectedSqlSha256: sha256Hex(sql) });
        const stdout = run(invocation.command, invocation.args, logPath);
        if (stdout === null) fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role: source.role });
        let parsed;
        try { parsed = JSON.parse(stdout); } catch { fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role: source.role }); }
        if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0]?.success !== true || !Array.isArray(parsed[0].results)) {
          fail("CUTOVER_REMOTE_RESPONSE_INVALID", { role: source.role });
        }
        return parsed[0].results;
      } finally {
        await removeIfPresent(sqlPath).catch(() => {});
        await removeIfPresent(logPath).catch(() => {});
      }
    },
    /** Remove every pinned config this transport wrote (idempotent). */
    async dispose() {
      for (const path of [...configs]) {
        await removeIfPresent(path);
        configs.delete(path);
      }
    },
  });
}

/** The export command line for one source; the CLI resolves the name from the pinned config. */
export function wranglerExportArguments({ cliPath = DEFAULT_CLI_PATH, source, configPath, outputPath }) {
  return Object.freeze([cliPath, "d1", "export", source.databaseName, "--remote", "--output", outputPath,
    "--config", configPath]);
}

// ---------------------------------------------------------------------------
// The export and its scan.

async function assertPrivateExportFile(path, role) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    fail("CUTOVER_EXPORT_FAILED", { role });
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600
      || info.uid !== currentUid() || await realpath(path) !== path) {
    fail("CUTOVER_EXPORT_FILE_UNSAFE", { role });
  }
  return info;
}

/** True when the bytes match any closed signed-URL pattern. */
export function containsSignedUrl(text) {
  return SIGNED_URL_PATTERNS.some(pattern => pattern.test(text));
}

async function scanFileForSecrets(path) {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let carry = "";
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      const text = carry + buffer.subarray(0, read).toString("latin1");
      if (containsSignedUrl(text)) return true;
      carry = text.slice(-SCAN_OVERLAP_BYTES);
    }
    return false;
  } finally {
    closeSync(descriptor);
  }
}

// ---------------------------------------------------------------------------
// The rebuild: a streaming statement splitter over the export and a closed
// statement grammar. Tables and rows run first with foreign keys off;
// indexes, triggers and views run last so no trigger fires on restored rows.

const CODE = 0;
const SINGLE = 1;
const SINGLE_END = 2;
const DOUBLE = 3;
const BRACKET = 4;
const BACKTICK = 5;
const LINE = 6;
const BLOCK = 7;

function wordCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/**
 * Split SQL text into statements. Quotes, identifiers and comments are
 * honoured; inside CREATE TRIGGER, BEGIN/CASE ... END nesting keeps body
 * semicolons inside the statement. Only the first words of a statement are
 * tokenized unless it is a trigger, and quoted runs are skipped with
 * indexOf, so a large export splits in linear time.
 */
export function* splitSqlStatements(chunks) {
  let pending = "";
  let state = CODE;
  let previous = 0;
  let depth = 0;
  let word = "";
  let words = [];
  let trigger = false;
  const resetStatement = () => {
    depth = 0;
    word = "";
    words = [];
    trigger = false;
  };
  const flushWord = () => {
    if (word.length === 0) return;
    const upper = word.toUpperCase();
    if (words.length < 4) {
      words.push(upper);
      trigger = words[0] === "CREATE" && (words[1] === "TRIGGER"
        || ((words[1] === "TEMP" || words[1] === "TEMPORARY") && words[2] === "TRIGGER"));
    } else if (trigger) {
      if (upper === "BEGIN" || upper === "CASE") depth += 1;
      else if (upper === "END") depth -= 1;
    }
    word = "";
  };
  for (const chunk of chunks) {
    let segmentStart = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      const code = chunk.charCodeAt(index);
      if (state === SINGLE) {
        const close = chunk.indexOf("'", index);
        if (close < 0) {
          index = chunk.length;
          break;
        }
        index = close;
        state = SINGLE_END;
        previous = 39;
        continue;
      }
      if (state === SINGLE_END) {
        if (code === 39) {
          state = SINGLE;
          previous = code;
          continue;
        }
        state = CODE;
      }
      if (state === DOUBLE || state === BRACKET || state === BACKTICK) {
        const terminator = state === DOUBLE ? 34 : state === BRACKET ? 93 : 96;
        if (code === terminator) state = CODE;
        previous = code;
        continue;
      }
      if (state === LINE) {
        if (code === 10) state = CODE;
        previous = code;
        continue;
      }
      if (state === BLOCK) {
        if (code === 47 && previous === 42) {
          state = CODE;
          previous = 0;
          continue;
        }
        previous = code;
        continue;
      }
      if (wordCode(code)) {
        if (words.length < 4 || trigger) word += chunk[index];
        previous = code;
        continue;
      }
      flushWord();
      if (code === 39) state = SINGLE;
      else if (code === 34) state = DOUBLE;
      else if (code === 91) state = BRACKET;
      else if (code === 96) state = BACKTICK;
      else if (code === 45 && previous === 45) state = LINE;
      else if (code === 42 && previous === 47) {
        state = BLOCK;
        previous = 0;
        continue;
      } else if (code === 59 && depth <= 0) {
        const statement = (pending + chunk.slice(segmentStart, index + 1)).trim();
        pending = "";
        segmentStart = index + 1;
        resetStatement();
        previous = 0;
        if (statement.length > 1) yield statement;
        continue;
      }
      previous = code;
    }
    pending += chunk.slice(segmentStart);
  }
  flushWord();
  const trailing = pending.replace(/--[^\n]*(?:\n|$)/gu, "").replace(/\/\*[\s\S]*?\*\//gu, "").trim();
  if (trailing.length > 0 || state === SINGLE || state === DOUBLE || state === BRACKET || state === BACKTICK
      || state === BLOCK) {
    throw new CutoverSourceError("CUTOVER_EXPORT_STATEMENT_REFUSED");
  }
}

function* fileChunks(path) {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      yield decoder.decode(buffer.subarray(0, read), { stream: true });
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  } finally {
    closeSync(descriptor);
  }
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const OBJECT_NAME = `(?:"(${IDENT})"|\\[(${IDENT})\\]|${"`"}(${IDENT})${"`"}|(${IDENT}))`;
const CREATE_TABLE = new RegExp(String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${OBJECT_NAME}\s*\(`, "iu");
const INSERT_INTO = new RegExp(String.raw`^INSERT\s+INTO\s+${OBJECT_NAME}\s*(?:\(|VALUES\b)`, "iu");
const DEFERRED_DDL = new RegExp(String.raw`^CREATE\s+(?:UNIQUE\s+INDEX|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?${OBJECT_NAME}[\s(]`, "iu");
const IGNORED_STATEMENTS = [
  /^PRAGMA\s+defer_foreign_keys\s*=\s*(?:TRUE|ON|1)\s*;$/iu,
  /^PRAGMA\s+foreign_keys\s*=\s*(?:OFF|FALSE|0)\s*;$/iu,
  /^BEGIN\s+TRANSACTION\s*;$/iu,
  /^COMMIT\s*;$/iu,
];
const DEFERRED_ORDER = Object.freeze({ INDEX: 0, VIEW: 1, TRIGGER: 2 });
const DELETE_SEQUENCE = /^DELETE\s+FROM\s+"?sqlite_sequence"?\s*;$/iu;

function objectName(match) {
  return match[1] ?? match[2] ?? match[3] ?? match[4];
}

/** Classify one export statement under the closed grammar. */
export function classifyExportStatement(text) {
  if (typeof text !== "string") fail("CUTOVER_EXPORT_STATEMENT_REFUSED");
  const statement = text.replace(/^(?:\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*\s*/u, "");
  if (IGNORED_STATEMENTS.some(pattern => pattern.test(statement))) return Object.freeze({ kind: "ignore" });
  if (DELETE_SEQUENCE.test(statement)) return Object.freeze({ kind: "data", name: "sqlite_sequence" });
  let match = CREATE_TABLE.exec(statement);
  if (match) {
    const name = objectName(match);
    if (name.startsWith("_cf_")) fail("CUTOVER_EXPORT_PROVIDER_TABLE");
    if (name.startsWith("sqlite_")) fail("CUTOVER_EXPORT_STATEMENT_REFUSED");
    return Object.freeze({ kind: "table", name });
  }
  match = INSERT_INTO.exec(statement);
  if (match) {
    const name = objectName(match);
    if (name.startsWith("_cf_")) fail("CUTOVER_EXPORT_PROVIDER_TABLE");
    if (name.startsWith("sqlite_") && name !== "sqlite_sequence") fail("CUTOVER_EXPORT_STATEMENT_REFUSED");
    return Object.freeze({ kind: "data", name });
  }
  match = DEFERRED_DDL.exec(statement);
  if (match) {
    const name = objectName(match);
    if (name.startsWith("_cf_") || /\bON\s+"?_cf_/iu.test(statement)) fail("CUTOVER_EXPORT_PROVIDER_TABLE");
    if (name.startsWith("sqlite_")) fail("CUTOVER_EXPORT_STATEMENT_REFUSED");
    const object = /^CREATE\s+(?:UNIQUE\s+)?(INDEX|TRIGGER|VIEW)/iu.exec(statement)[1].toUpperCase();
    return Object.freeze({ kind: "deferred", name, object });
  }
  return fail("CUTOVER_EXPORT_STATEMENT_REFUSED");
}

/** Rebuild an export into a fresh SQLite file; returns statement counts only. */
export function rebuildExportIntoSqlite({ exportPath, databasePath, role }) {
  let database;
  const deferred = [];
  const counts = { tables: 0, dataStatements: 0, deferred: 0, ignored: 0 };
  try {
    database = new DatabaseSync(databasePath, { allowExtension: false, enableForeignKeyConstraints: false });
    database.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA foreign_keys=OFF");
    database.exec("BEGIN");
    let batch = [];
    let batchBytes = 0;
    const flush = () => {
      if (batch.length === 0) return;
      database.exec(batch.join("\n"));
      batch = [];
      batchBytes = 0;
    };
    for (const statement of splitSqlStatements(fileChunks(exportPath))) {
      const classified = classifyExportStatement(statement);
      if (classified.kind === "ignore") {
        counts.ignored += 1;
        continue;
      }
      if (classified.kind === "deferred") {
        deferred.push({ statement, rank: DEFERRED_ORDER[classified.object] });
        counts.deferred += 1;
        continue;
      }
      if (classified.kind === "table") counts.tables += 1;
      else counts.dataStatements += 1;
      batch.push(statement);
      batchBytes += Buffer.byteLength(statement);
      if (batchBytes >= REBUILD_BATCH_BYTES) flush();
    }
    flush();
    // Indexes, then views (in export order, so a view may read an earlier
    // view), then triggers (an INSTEAD OF trigger needs its view).
    deferred.sort((left, right) => left.rank - right.rank);
    for (const { statement } of deferred) database.exec(statement);
    database.exec("COMMIT");
  } catch (error) {
    try { database?.exec("ROLLBACK"); } catch { /* the rebuild file is discarded */ }
    if (error instanceof CutoverSourceError) throw new CutoverSourceError(error.code, { role });
    fail("CUTOVER_REBUILD_FAILED", { role });
  } finally {
    try { database?.close(); } catch { /* already closed */ }
  }
  return Object.freeze(counts);
}

function sqlStringLiteral(value) {
  if (typeof value !== "string" || value.includes("\0") || value.includes("'")) fail("CUTOVER_OWNER_DIRECTORY_UNSAFE");
  return `'${value}'`;
}

// ---------------------------------------------------------------------------
// Sealed sources.

const TRUSTED_SEALED = new WeakSet();

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.mode === right.mode;
}

async function sealedFileFacts(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("CUTOVER_SEALED_SOURCE_UNSAFE");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (await exists(`${path}${suffix}`)) fail("CUTOVER_SEALED_SOURCE_UNSAFE");
  }
  let info;
  try {
    if (await realpath(path) !== path) fail("CUTOVER_SEALED_SOURCE_UNSAFE");
    info = await lstat(path);
  } catch (error) {
    if (error instanceof CutoverSourceError) throw error;
    fail("CUTOVER_SEALED_SOURCE_UNSAFE");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o400
      || info.uid !== currentUid() || info.size <= 0 || info.size > MAX_SEALED_BYTES) {
    fail("CUTOVER_SEALED_SOURCE_UNSAFE");
  }
  return Object.freeze({ info, sha256: await sha256File(path) });
}

/**
 * Open one sealed SQLite read-only. Its bytes must hash to expectedSha256
 * now and at every verify() (call it before and after a consumer's reads).
 */
export async function openCutoverSealedSqlite({ path, expectedSha256 } = {}) {
  if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) fail("CUTOVER_ARGUMENT_INVALID");
  const initial = await sealedFileFacts(path);
  if (initial.sha256 !== expectedSha256) fail("CUTOVER_SEALED_SOURCE_CHANGED");
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA query_only=ON");
    if (database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal") fail("CUTOVER_SEALED_SOURCE_UNSAFE");
  } catch (error) {
    database?.close();
    if (error instanceof CutoverSourceError) throw error;
    fail("CUTOVER_SEALED_SOURCE_UNSAFE");
  }
  let closed = false;
  const source = Object.freeze({
    path,
    sha256: expectedSha256,
    database() {
      if (closed) fail("CUTOVER_SEALED_SOURCE_UNSAFE");
      return database;
    },
    async verify() {
      if (closed) fail("CUTOVER_SEALED_SOURCE_UNSAFE");
      const now = await sealedFileFacts(path);
      if (now.sha256 !== expectedSha256 || !sameFile(initial.info, now.info)) fail("CUTOVER_SEALED_SOURCE_CHANGED");
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  });
  TRUSTED_SEALED.add(source);
  return source;
}

export function isTrustedCutoverSealedSqlite(source) {
  return TRUSTED_SEALED.has(source);
}

function readLocal(database, sql) {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all();
}

function localSchema(database, role) {
  return normalizeSchemaRows(readLocal(database, CUTOVER_SCHEMA_SQL).map(row => ({ ...row })), role);
}

function localLedgers(database, layout, role) {
  const ledgers = {};
  for (const table of CUTOVER_LEDGER_TABLES) {
    const present = readLocal(database, `SELECT 1 FROM sqlite_schema WHERE type='table' AND name='${table}'`).length === 1;
    if (layout[table] === undefined) {
      if (present) fail("CUTOVER_LEDGER_MISMATCH", { role, table });
      continue;
    }
    if (!present) fail("CUTOVER_LEDGER_MISMATCH", { role, table });
    ledgers[table] = normalizeLedgerRows(table, readLocal(database, CUTOVER_LEDGER_SQL[table]), role);
  }
  return ledgers;
}

function localSequences(database, role) {
  const present = readLocal(database, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sqlite_sequence'").length === 1;
  return present ? normalizeSequenceRows(readLocal(database, CUTOVER_SEQUENCE_SQL), role) : Object.freeze([]);
}

function localAggregates(database, layouts, role) {
  const rows = [];
  for (const sql of aggregateQueries(layouts)) rows.push(...readLocal(database, sql));
  return normalizeAggregates(rows, layouts, role);
}

/** Read every remote fact the seal accepts against, through the guarded transport. */
export async function readRemoteSourceFacts(guarded, source) {
  const role = source.role;
  const schema = normalizeSchemaRows(await guarded.query(source, CUTOVER_SCHEMA_SQL), role);
  const ledgers = {};
  for (const table of CUTOVER_LEDGER_TABLES) {
    const present = schema.some(row => row.type === "table" && row.name === table);
    if (source.ledgers[table] === undefined) {
      if (present) fail("CUTOVER_LEDGER_MISMATCH", { role, table });
      continue;
    }
    if (!present) fail("CUTOVER_LEDGER_MISMATCH", { role, table });
    if (table === "d1_storage_migrations"
        && schema.find(row => row.type === "table" && row.name === table)?.sql !== STORAGE_LEDGER_SQL) {
      fail("CUTOVER_LEDGER_MISMATCH", { role, table });
    }
    ledgers[table] = normalizeLedgerRows(table, await guarded.query(source, CUTOVER_LEDGER_SQL[table]), role);
  }
  const sequenced = schema.some(row => row.type === "table" && /\bAUTOINCREMENT\b/iu.test(row.sql ?? ""));
  const sequences = sequenced ? normalizeSequenceRows(await guarded.query(source, CUTOVER_SEQUENCE_SQL), role)
    : Object.freeze([]);
  const layouts = tableLayouts(schema);
  const rows = [];
  for (const sql of aggregateQueries(layouts)) rows.push(...await guarded.query(source, sql));
  const aggregates = normalizeAggregates(rows, layouts, role);
  return Object.freeze({ schema, schemaSha256: schemaDigest(schema), ledgers, sequences, layouts, aggregates });
}

/** Compare a sealed file with the remote facts and the expected ledgers; returns content-free facts. */
export function acceptSealedSource({ database, source, remote, expectedLedger }) {
  const role = source.role;
  const integrity = readLocal(database, "PRAGMA integrity_check").map(row => row.integrity_check);
  if (integrity.length !== 1 || integrity[0] !== "ok") fail("CUTOVER_INTEGRITY_FAILED", { role });
  const schema = localSchema(database, role);
  if (schemaDigest(schema) !== remote.schemaSha256) fail("CUTOVER_SCHEMA_MISMATCH", { role });
  const ledgers = localLedgers(database, source.ledgers, role);
  for (const table of Object.keys(source.ledgers)) {
    if (canonicalJson(ledgers[table]) !== canonicalJson(remote.ledgers[table])) fail("CUTOVER_LEDGER_MISMATCH", { role, table });
    compareLedgerToExpected(table, ledgers[table], expectedLedger.ledgers[table], role);
  }
  const sequences = localSequences(database, role);
  if (canonicalJson(sequences) !== canonicalJson(remote.sequences)) fail("CUTOVER_SEQUENCE_MISMATCH", { role });
  const aggregates = localAggregates(database, remote.layouts, role);
  for (const [table, value] of Object.entries(remote.aggregates.tables)) {
    if (aggregates.tables[table]?.aggregateSha256 !== value.aggregateSha256) fail("CUTOVER_AGGREGATE_MISMATCH", { role, table });
  }
  if (aggregates.sha256 !== remote.aggregates.sha256) fail("CUTOVER_AGGREGATE_MISMATCH", { role });
  return Object.freeze({
    integrity: "ok",
    schemaSha256: remote.schemaSha256,
    ledgerSha256: sha256Hex(canonicalJson(ledgers)),
    expectedLedgerSha256: expectedLedger.sha256,
    sequenceSha256: sha256Hex(canonicalJson(sequences)),
    aggregates: remote.aggregates,
  });
}

// ---------------------------------------------------------------------------
// The seal.

function sealPaths(directory, role) {
  return Object.freeze({
    dump: join(directory, `${role}.export.sql`),
    rebuild: join(directory, `${role}.rebuild.sqlite`),
    sealed: join(directory, `${role}.sealed.sqlite`),
    log: join(directory, `${role}.export.log`),
  });
}

async function cleanupArtifacts(paths) {
  for (const path of paths) {
    for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      try { await removeIfPresent(candidate); } catch { /* reported by the artifact check */ }
    }
  }
}

async function assertNoTransientArtifacts(directory, role) {
  const paths = sealPaths(directory, role);
  for (const candidate of [paths.dump, paths.rebuild, paths.log, `${paths.rebuild}-journal`, `${paths.sealed}-wal`,
    `${paths.sealed}-shm`, `${paths.sealed}-journal`, `${paths.rebuild}-wal`, `${paths.rebuild}-shm`]) {
    if (await exists(candidate)) fail("CUTOVER_SEAL_ARTIFACT_LEFT", { role });
  }
}

function runExport({ spawn, cliPath, source, configPath, outputPath, logPath, accountId, environment, directory }) {
  let result;
  try {
    result = spawn(process.execPath, wranglerExportArguments({ cliPath, source, configPath, outputPath }), {
      cwd: directory, encoding: "buffer", timeout: EXPORT_TIMEOUT_MILLISECONDS, maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"], env: wranglerEnvironment(environment, accountId, logPath),
    });
  } catch {
    result = null;
  }
  // stdout and stderr stay in this frame and are dropped with it; only the
  // exit status is consulted.
  const status = result?.status;
  const ok = result !== null && !result.error && status === 0 && result.signal == null;
  result = null;
  return ok;
}

/**
 * Seal every inventory source. Dry run by default: nothing is spawned and no
 * transport is called. With execute, remote and ownerReadOnly the steps run
 * in order for ingestion then deletion-ledger; any failure deletes every
 * artifact this run created and writes no manifest.
 */
export async function runCutoverSeal({
  inventoryPath,
  fenceReceiptPath,
  fenceReceiptSha256,
  barrierProofPath,
  ownerDirectory,
  execute = false,
  remote = false,
  ownerReadOnly = false,
  transport = undefined,
  spawn = spawnSync,
  cliPath = DEFAULT_CLI_PATH,
  environment = process.env,
  repositoryRoot = REPOSITORY_ROOT,
  git = defaultGit,
  now = () => new Date(),
  forbiddenRoots = undefined,
} = {}) {
  const inventory = await readCutoverInventory(inventoryPath);
  const directory = await assertOwnerDirectory(ownerDirectory, forbiddenRoots === undefined ? {} : { forbiddenRoots });
  const { verifyCutoverFence } = await import("./cutover-source-fence.mjs");
  const fence = await verifyCutoverFence({ inventory, fenceReceiptPath, fenceReceiptSha256, barrierProofPath });
  const expected = Object.fromEntries(CUTOVER_SOURCE_ROLES.map(role => [role,
    buildExpectedLedger({ source: inventory.sources[role], commit: inventory.expectedSourceCommit, repositoryRoot, git })]));
  if (execute !== true) {
    return Object.freeze({
      mode: "dry-run",
      inventorySha256: inventory.inventorySha256,
      fenceReceiptSha256: fence.fenceReceiptSha256,
      sources: Object.freeze(CUTOVER_SOURCE_ROLES.map(role => Object.freeze({
        role,
        databaseIdSha256: inventory.sources[role].databaseIdSha256,
        expectedLedgerSha256: expected[role].sha256,
      }))),
    });
  }
  if (remote !== true || ownerReadOnly !== true) fail("CUTOVER_REMOTE_NOT_AUTHORIZED");
  const manifestPath = join(directory, "seal-manifest.json");
  if (await exists(manifestPath)) fail("CUTOVER_OUTPUT_EXISTS");
  const created = [];
  const previousUmask = process.umask(0o077);
  // The default transport writes its own pinned configs into the owner
  // directory; it is disposed on every path, before the manifest on success.
  let ownedTransport = null;
  try {
    ownedTransport = transport === undefined ? createWranglerCutoverTransport({
      inventory, transportDirectory: directory, cliPath, spawn, environment, remote, ownerReadOnly,
    }) : null;
    const guarded = guardCutoverTransport(transport ?? ownedTransport, inventory);
    const sealedSources = [];
    for (const role of CUTOVER_SOURCE_ROLES) {
      const source = inventory.sources[role];
      const paths = sealPaths(directory, role);
      const configPath = pinnedConfigPath(directory, role);
      for (const path of [paths.dump, paths.rebuild, paths.sealed, paths.log, configPath]) {
        if (await exists(path)) fail("CUTOVER_OUTPUT_EXISTS", { role });
      }
      created.push(configPath);
      const fenced = fence.sources[role];
      const b0 = await guarded.bookmark(source);
      if (b0 !== fenced.bookmark) fail("CUTOVER_SOURCE_BOOKMARK_DRIFT", { role });
      const remoteFacts = await readRemoteSourceFacts(guarded, source);
      created.push(paths.dump, paths.log, paths.rebuild, paths.sealed);
      await writePinnedConfig(directory, source, inventory.accountId);
      await createPrivateEmptyFile(paths.dump);
      await createPrivateEmptyFile(paths.log);
      const exported = runExport({ spawn, cliPath, source, configPath, outputPath: paths.dump, logPath: paths.log,
        accountId: inventory.accountId, environment, directory });
      await removeIfPresent(paths.log);
      if (!exported) fail("CUTOVER_EXPORT_FAILED", { role });
      const b1 = await guarded.bookmark(source);
      if (b1 !== b0) fail("CUTOVER_SOURCE_BOOKMARK_DRIFT", { role });
      await assertPrivateExportFile(paths.dump, role);
      if (await scanFileForSecrets(paths.dump)) fail("CUTOVER_SECRET_IN_OUTPUT", { role });
      const rebuilt = rebuildExportIntoSqlite({ exportPath: paths.dump, databasePath: paths.rebuild, role });
      const vacuum = new DatabaseSync(paths.rebuild, { allowExtension: false });
      try {
        vacuum.exec(`VACUUM INTO ${sqlStringLiteral(paths.sealed)}`);
      } catch {
        fail("CUTOVER_REBUILD_FAILED", { role });
      } finally {
        vacuum.close();
      }
      await removeIfPresent(paths.rebuild);
      await removeIfPresent(paths.dump);
      await chmod(paths.sealed, 0o400);
      await assertNoTransientArtifacts(directory, role);
      const sealedSha256 = await sha256File(paths.sealed);
      const sealed = await openCutoverSealedSqlite({ path: paths.sealed, expectedSha256: sealedSha256 });
      let accepted;
      try {
        accepted = acceptSealedSource({ database: sealed.database(), source, remote: remoteFacts, expectedLedger: expected[role] });
        await sealed.verify();
      } finally {
        sealed.close();
      }
      const info = await lstat(paths.sealed);
      sealedSources.push(Object.freeze({
        role,
        databaseIdSha256: source.databaseIdSha256,
        fenceLabel: CUTOVER_SEALABLE_SOURCES[role].fenceLabel,
        bookmark: b0,
        sealedFile: basename(paths.sealed),
        sealedSha256,
        bytes: info.size,
        tables: remoteFacts.layouts.length,
        rows: Object.values(accepted.aggregates.tables).reduce((total, table) => total + table.rows, 0),
        statements: rebuilt,
        integrity: accepted.integrity,
        schemaSha256: accepted.schemaSha256,
        ledgerSha256: accepted.ledgerSha256,
        expectedLedgerSha256: accepted.expectedLedgerSha256,
        sequenceSha256: accepted.sequenceSha256,
        aggregatesSha256: accepted.aggregates.sha256,
        aggregates: accepted.aggregates.tables,
      }));
      await removeIfPresent(configPath);
    }
    await ownedTransport?.dispose();
    const createdAt = now().toISOString();
    if (!INSTANT.test(createdAt)) fail("CUTOVER_ARGUMENT_INVALID");
    const body = {
      schema: CUTOVER_SEAL_MANIFEST_SCHEMA,
      createdAt,
      inventorySha256: inventory.inventorySha256,
      expectedSourceCommit: inventory.expectedSourceCommit,
      fence: fence.summary,
      sources: sealedSources,
    };
    const sealId = sha256Hex(canonicalJson(body));
    const manifest = { ...body, sealId };
    const text = `${canonicalJson(manifest)}\n`;
    if (containsSignedUrl(text)) fail("CUTOVER_SECRET_IN_OUTPUT");
    created.push(manifestPath);
    const manifestSha256 = await writePrivateFileOnce(manifestPath, text, 0o400);
    return Object.freeze({ mode: "sealed", manifestPath, manifestSha256, sealId, manifest });
  } catch (error) {
    await cleanupArtifacts(created);
    await ownedTransport?.dispose().catch(() => {});
    if (error instanceof CutoverSourceError) throw error;
    return fail("CUTOVER_REBUILD_FAILED");
  } finally {
    process.umask(previousUmask);
  }
}

// ---------------------------------------------------------------------------
// Reading a seal back.

function validateManifest(value) {
  exactKeys(value, ["schema", "createdAt", "inventorySha256", "expectedSourceCommit", "fence", "sources", "sealId"],
    "CUTOVER_SEAL_MANIFEST_INVALID");
  if (value.schema !== CUTOVER_SEAL_MANIFEST_SCHEMA || typeof value.createdAt !== "string" || !INSTANT.test(value.createdAt)
      || !SHA256.test(value.inventorySha256 ?? "") || !COMMIT.test(value.expectedSourceCommit ?? "")
      || !SHA256.test(value.sealId ?? "") || !Array.isArray(value.sources)
      || value.sources.length !== CUTOVER_SOURCE_ROLES.length) {
    fail("CUTOVER_SEAL_MANIFEST_INVALID");
  }
  value.sources.forEach((source, index) => {
    if (!record(source) || source.role !== CUTOVER_SOURCE_ROLES[index] || !SHA256.test(source.sealedSha256 ?? "")
        || typeof source.sealedFile !== "string" || source.sealedFile !== `${source.role}.sealed.sqlite`
        || !OPAQUE.test(source.bookmark ?? "") || !SHA256.test(source.aggregatesSha256 ?? "")
        || !SHA256.test(source.databaseIdSha256 ?? "") || !record(source.aggregates)) {
      fail("CUTOVER_SEAL_MANIFEST_INVALID");
    }
  });
  const { sealId, ...body } = value;
  if (sha256Hex(canonicalJson(body)) !== sealId) fail("CUTOVER_SEAL_MANIFEST_INVALID");
  return value;
}

/**
 * Read a seal manifest (0400 or 0600, owner-owned) beside its sealed files.
 * expectedSealId pins it; sources resolve to absolute sealed paths.
 */
export async function readCutoverSeal({ manifestPath, expectedSealId } = {}) {
  if (typeof expectedSealId !== "string" || !SHA256.test(expectedSealId)) fail("CUTOVER_ARGUMENT_INVALID");
  const bytes = await readPrivateFile(manifestPath, MAX_MANIFEST_BYTES, "CUTOVER_SEAL_MANIFEST_INVALID");
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("CUTOVER_SEAL_MANIFEST_INVALID");
  }
  const manifest = validateManifest(parsed);
  if (manifest.sealId !== expectedSealId) fail("CUTOVER_SEAL_MANIFEST_INVALID");
  const directory = dirname(manifestPath);
  const sources = Object.fromEntries(manifest.sources.map(source => [source.role, Object.freeze({
    ...source,
    path: join(directory, source.sealedFile),
  })]));
  return Object.freeze({ manifest, manifestSha256: sha256Hex(bytes), sources: Object.freeze(sources) });
}

/** Open a sealed source named by a verified seal manifest. */
export async function openSealedSourceFromSeal(seal, role) {
  const source = seal?.sources?.[role];
  if (source === undefined) fail("CUTOVER_SOURCE_NOT_ALLOWED");
  return openCutoverSealedSqlite({ path: source.path, expectedSha256: source.sealedSha256 });
}

/** Recompute the remote aggregates and bookmark of one sealed source (verify-unchanged). */
export async function readRemoteUnchangedFacts(guarded, source, sealedSource) {
  const bookmark = await guarded.bookmark(source);
  const remote = await readRemoteSourceFacts(guarded, source);
  return Object.freeze({
    bookmark,
    schemaSha256: remote.schemaSha256,
    aggregatesSha256: remote.aggregates.sha256,
    aggregates: remote.aggregates.tables,
    matches: bookmark === sealedSource.bookmark && remote.aggregates.sha256 === sealedSource.aggregatesSha256
      && remote.schemaSha256 === sealedSource.schemaSha256,
  });
}

// ---------------------------------------------------------------------------
// CLI.

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!["expected-ledger", "seal"].includes(command)) fail("CUTOVER_ARGUMENT_INVALID");
  const values = { "--inventory": "inventoryPath", "--fence-receipt": "fenceReceiptPath",
    "--fence-sha256": "fenceReceiptSha256", "--barrier-proof": "barrierProofPath", "--out": "ownerDirectory" };
  const switches = { "--remote": "remote", "--owner-read-only": "ownerReadOnly", "--execute": "execute" };
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (Object.hasOwn(switches, flag)) {
      if (options[switches[flag]] !== undefined) fail("CUTOVER_ARGUMENT_INVALID");
      options[switches[flag]] = true;
      continue;
    }
    const key = values[flag];
    const value = rest[index + 1];
    if (key === undefined || options[key] !== undefined || typeof value !== "string" || value.startsWith("--")) {
      fail("CUTOVER_ARGUMENT_INVALID");
    }
    options[key] = value;
    index += 1;
  }
  if (!options.inventoryPath) fail("CUTOVER_ARGUMENT_INVALID");
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.command === "expected-ledger") {
    const inventory = await readCutoverInventory(resolve(options.inventoryPath));
    const ledgers = CUTOVER_SOURCE_ROLES.map(role => {
      const ledger = buildExpectedLedger({ source: inventory.sources[role], commit: inventory.expectedSourceCommit });
      return { role, sha256: ledger.sha256, rows: Object.fromEntries(Object.entries(ledger.ledgers)
        .map(([table, rows]) => [table, rows.length])) };
    });
    process.stdout.write(`${JSON.stringify({ command: "expected-ledger", ledgers })}\n`);
    return;
  }
  const result = await runCutoverSeal({
    inventoryPath: resolve(options.inventoryPath),
    fenceReceiptPath: options.fenceReceiptPath === undefined ? undefined : resolve(options.fenceReceiptPath),
    fenceReceiptSha256: options.fenceReceiptSha256,
    barrierProofPath: options.barrierProofPath === undefined ? undefined : resolve(options.barrierProofPath),
    ownerDirectory: options.ownerDirectory === undefined ? undefined : resolve(options.ownerDirectory),
    execute: options.execute === true,
    remote: options.remote === true,
    ownerReadOnly: options.ownerReadOnly === true,
  });
  const summary = result.mode === "sealed"
    ? { command: "seal", mode: result.mode, sealId: result.sealId, manifestSha256: result.manifestSha256 }
    : { command: "seal", mode: result.mode, sources: result.sources };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof CutoverSourceError ? error.message : "CUTOVER_FAILED"}\n`);
    process.exitCode = 1;
  });
}
