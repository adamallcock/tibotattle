import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/*
 * The upload-path analytics retirement (ISO-1) stops every PostgreSQL write
 * into the JSON-era queues and caches of primary migration 0010. This check
 * proves no PostgreSQL module reads them either, so no read path can recreate
 * the treadmill. The tables themselves are kept: the erasure fences and
 * cleanup bounds still name them, and the legacy owner-retirement residue
 * sweep still clears two caches. Each remaining mention is listed below
 * exactly; an unlisted mention, a SQL reference where only an inventory entry
 * is allowed, or a stale entry fails.
 */

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED_DIRECTORIES = Object.freeze(["src", "scripts", "cloud-run"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);
const SOURCE_FILE = /\.(?:[cm]?js|ts)$/u;
const TEST_FILE = /\.(?:check|spec|test)\.[cm]?[jt]s$/u;
const MIGRATION_SUFFIX = "_upload_path_analytics_retirement.sql";

/** Retired queues: no module may reference them except as an inventory entry. */
export const RETIRED_QUEUES = Object.freeze(["current_queue", "current_queue_state", "refresh_lanes", "daily_rebuilds"]);
/** Retired caches and preparation projections with PostgreSQL-only names. */
export const RETIRED_PROJECTIONS = Object.freeze(["preview_cache", "prepared_source_days", "preparation_counters"]);
/**
 * Retired projections whose names D1 also uses; only PostgreSQL modules are
 * held to them.
 */
export const RETIRED_SHARED_NAMES = Object.freeze(["community_model_composition_days", "community_model_history_dependencies"]);
const RETIRED_SEEDED_SINGLETONS = new Set(["current_queue_state", "preparation_counters"]);

/**
 * Every remaining mention. An "inventory" entry names a table in an erasure
 * fence, a cleanup count bound or a transfer emptiness list. The only allowed
 * "reference" is the legacy owner-retirement residue sweep, which deletes and
 * counts the two shared caches; no queue may ever be referenced.
 */
export const ALLOWED_MENTIONS = Object.freeze([
  ["src/postgres-accountless-owner-erasure.ts", "current_queue", "inventory", 1],
  ["src/postgres-accountless-owner-erasure.ts", "prepared_source_days", "inventory", 1],
  ["src/postgres-accountless-owner-erasure.ts", "community_model_history_dependencies", "inventory", 1],
  ["src/postgres-social-owner-erasure-preflight.ts", "current_queue", "inventory", 1],
  ["src/postgres-social-owner-erasure-preflight.ts", "prepared_source_days", "inventory", 1],
  ["src/postgres-social-owner-erasure-preflight.ts", "community_model_history_dependencies", "inventory", 1],
  ["src/postgres-owner-erasure.ts", "current_queue", "inventory", 1],
  ["cloud-run/synthetic-v12-discovery.mjs", "current_queue", "inventory", 1],
  ["scripts/postgres-analytics-applied-transfer.mjs", "community_model_history_dependencies", "inventory", 1],
  ["scripts/postgres-analytics-applied-transfer.mjs", "community_model_composition_days", "inventory", 1],
  ["scripts/postgres-analytics-applied-main-transfer.mjs", "community_model_history_dependencies", "inventory", 1],
  ["scripts/postgres-analytics-applied-main-transfer.mjs", "community_model_composition_days", "inventory", 1],
  ["src/postgres-analytics-owner-retirement.ts", "preview_cache", "reference", 2],
  ["src/postgres-analytics-owner-retirement.ts", "community_model_composition_days", "reference", 2],
].map(([file, table, kind, count]) => Object.freeze({ file, table, kind, count })));

const IDENTIFIER_LIST_LINE = /^\s*[a-z0-9_]+(?:\s+[a-z0-9_]+)*\s*$/u;
const COUNT_BOUND_LINE = (table) => new RegExp(`^\\s*${table}:\\s*\\[\\d+,\\s*\\d+\\],?\\s*$`, "u");
const STRING_ELEMENT_LINE = (table) => new RegExp(`^\\s*["']${table}["'],?\\s*$`, "u");
const POSTGRES_CONTENT = /\bfrom\s+["']pg["']|\bquotePostgresIdentifier\b|\brenderPostgresSearchPath\b|\bPostgresClient\b/u;

function mentionPattern(table) {
  return new RegExp(`(?<![A-Za-z0-9_])${table}(?![A-Za-z0-9_])`, "gu");
}

/** A PostgreSQL module: a postgres-* source or script, any Cloud Run module, or pg-aware code. */
export function isPostgresModule(file, source) {
  return /^(?:src|scripts)\/postgres-/u.test(file) || file.startsWith("cloud-run/") || POSTGRES_CONTENT.test(source);
}

/**
 * Classify one line's mention. Only three whole-line shapes are inventory: a
 * line of bare table names (the erasers' Set literals), a `name: [min, max]`
 * count bound, and a lone quoted array element. Anything else — SQL text, a
 * table helper call, a template — is a reference.
 */
export function classifyMention(line, table) {
  if (IDENTIFIER_LIST_LINE.test(line) || COUNT_BOUND_LINE(table).test(line) || STRING_ELEMENT_LINE(table).test(line)) {
    return "inventory";
  }
  return "reference";
}

/** Every mention of a retired table in one source, as { table, kind, line }. */
export function findRetiredMentions(file, source) {
  const tables = [...RETIRED_QUEUES, ...RETIRED_PROJECTIONS,
    ...(isPostgresModule(file, source) ? RETIRED_SHARED_NAMES : [])];
  const mentions = [];
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const table of tables) {
      for (const _ of line.matchAll(mentionPattern(table))) {
        mentions.push({ table, kind: classifyMention(line, table), line: index + 1 });
      }
    }
  }
  return mentions;
}

/** Compare every mention with the allowlist; return human-readable violations. */
export function retiredMentionViolations(sources, allowed = ALLOWED_MENTIONS) {
  const violations = [];
  const actual = new Map();
  for (const [file, source] of sources) {
    for (const mention of findRetiredMentions(file, source)) {
      const key = `${file}|${mention.table}|${mention.kind}`;
      actual.set(key, [...(actual.get(key) ?? []), mention.line]);
    }
  }
  const expected = new Map(allowed.map(({ file, table, kind, count }) => [`${file}|${table}|${kind}`, count]));
  for (const [key, lines] of actual) {
    const [file, table, kind] = key.split("|");
    const count = expected.get(key);
    if (count === undefined) {
      violations.push(`${file}:${lines.join(",")} ${kind} of retired ${table} is not allowed`);
    } else if (count !== lines.length) {
      violations.push(`${file}:${lines.join(",")} has ${lines.length} ${kind} mention(s) of ${table}, expected ${count}`);
    }
  }
  for (const [key, count] of expected) {
    if (!actual.has(key)) {
      const [file, table, kind] = key.split("|");
      violations.push(`stale allowlist entry: ${file} no longer has ${count} ${kind} mention(s) of ${table}`);
    }
  }
  return violations;
}

async function collectSources() {
  const sources = new Map();
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        sources.set(relative(WORKER_ROOT, path).split(sep).join("/"), await readFile(path, "utf8"));
      }
    }
  };
  for (const directory of SCANNED_DIRECTORIES) await walk(join(WORKER_ROOT, directory));
  return sources;
}

async function readRetirementMigration() {
  const found = [];
  for (const directory of ["staged-migrations", "migrations"]) {
    const root = join(WORKER_ROOT, "postgres", directory, "primary");
    let names = [];
    try {
      names = await readdir(root);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const name of names.filter((entry) => entry.endsWith(MIGRATION_SUFFIX))) {
      found.push(await readFile(join(root, name), "utf8"));
    }
  }
  assert.equal(found.length, 1, "the retirement migration is either staged or promoted, never both or neither");
  return found[0];
}

test("no PostgreSQL module reads the retired analytics queues, and only the residue sweep references the retired caches", async () => {
  const sources = await collectSources();
  assert.ok(sources.size > 100, "the scan covers the Worker's source, script and Cloud Run modules");
  for (const { file } of ALLOWED_MENTIONS) assert.ok(sources.has(file), `${file} is scanned`);
  assert.deepEqual(retiredMentionViolations(sources), []);
  for (const table of RETIRED_QUEUES) {
    assert.equal(ALLOWED_MENTIONS.some((entry) => entry.table === table && entry.kind !== "inventory"), false,
      `${table} may only be named by an inventory`);
  }
});

test("the retired tables are the 0010 tables the retirement migration stops feeding", async () => {
  const origin = await readFile(join(WORKER_ROOT, "postgres", "migrations", "primary",
    "0010_v1_analytical_side_effects.sql"), "utf8");
  const created = new Set([...origin.matchAll(/CREATE TABLE ([a-z_][a-z0-9_]*)/gu)].map((match) => match[1]));
  for (const table of [...RETIRED_QUEUES, ...RETIRED_PROJECTIONS, ...RETIRED_SHARED_NAMES]) {
    assert.equal(created.has(table), true, `${table} is a 0010 table`);
  }
  const migration = await readRetirementMigration();
  const refused = [...migration.matchAll(/CREATE TRIGGER retired_analytics_refusal BEFORE INSERT ON ([a-z_][a-z0-9_]*)/gu)]
    .map((match) => match[1]).sort();
  const retired = new Set([...RETIRED_QUEUES, ...RETIRED_PROJECTIONS, ...RETIRED_SHARED_NAMES]);
  for (const table of refused) assert.equal(retired.has(table), true, `${table} is a listed retired table`);
  for (const table of RETIRED_QUEUES) {
    if (!RETIRED_SEEDED_SINGLETONS.has(table)) assert.ok(refused.includes(table), `${table} refuses inserts`);
  }
});

test("the scanner flags doctored sources: a SQL read, an unlisted inventory, a wrong count and a stale entry", () => {
  const clean = new Map([
    ["src/postgres-owner-erasure.ts", "const ALLOWED = {\n  current_queue: [0, 1],\n};\n"],
  ]);
  const allowed = [{ file: "src/postgres-owner-erasure.ts", table: "current_queue", kind: "inventory", count: 1 }];
  assert.deepEqual(retiredMentionViolations(clean, allowed), []);

  const read = new Map([...clean, ["src/postgres-community-reader.ts",
    "await client.query(`SELECT participant_id FROM ${schema}.current_queue WHERE pending`);\n"]]);
  assert.match(retiredMentionViolations(read, allowed).join("\n"),
    /src\/postgres-community-reader\.ts:1 reference of retired current_queue is not allowed/u);

  const helper = new Map([...clean, ["cloud-run/lane-job.mjs",
    "await client.query(`UPDATE ${table(schema, \"refresh_lanes\")} SET state='queued'`);\n"]]);
  assert.match(retiredMentionViolations(helper, allowed).join("\n"), /reference of retired refresh_lanes/u);

  const inventoryInSql = new Map([["src/postgres-owner-erasure.ts",
    "const ALLOWED = {\n  current_queue: [0, 1],\n};\nconst x = `DELETE FROM current_queue`;\n"]]);
  assert.match(retiredMentionViolations(inventoryInSql, allowed).join("\n"), /reference of retired current_queue/u);

  const extraInventory = new Map([["src/postgres-owner-erasure.ts",
    "const ALLOWED = {\n  current_queue: [0, 1],\n  daily_rebuilds: [0, 1],\n};\n"]]);
  assert.match(retiredMentionViolations(extraInventory, allowed).join("\n"),
    /inventory of retired daily_rebuilds is not allowed/u);

  const doubled = new Map([["src/postgres-owner-erasure.ts",
    "const A = {\n  current_queue: [0, 1],\n};\nconst B = {\n  current_queue: [0, 1],\n};\n"]]);
  assert.match(retiredMentionViolations(doubled, allowed).join("\n"), /has 2 inventory mention\(s\) of current_queue, expected 1/u);

  assert.match(retiredMentionViolations(new Map(), allowed).join("\n"), /stale allowlist entry/u);

  // D1 modules share two projection names and are not PostgreSQL modules.
  const d1 = new Map([["src/community-model-history.ts",
    "await db.prepare('DELETE FROM community_model_composition_days WHERE day=?').run();\n"]]);
  assert.deepEqual(retiredMentionViolations(d1, []), []);
  const pgShared = new Map([["src/postgres-graph-reader.ts",
    "await client.query(`SELECT day FROM ${schema}.community_model_composition_days`);\n"]]);
  assert.match(retiredMentionViolations(pgShared, []).join("\n"), /reference of retired community_model_composition_days/u);
  // Prefixed D1 names never match.
  assert.deepEqual(findRetiredMentions("src/postgres-x.ts", "community_refresh_lanes community_prepared_source_days"), []);
});
