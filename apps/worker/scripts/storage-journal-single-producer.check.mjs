// Static single-producer ratchet for the PostgreSQL analytics source journal.
//
// Exact (version-1) storage_ingestion_changes rows are D1-exact only when they
// come from storage_journal_append (staged primary migration 0046), whose
// revision, epochs and sequence are derived under the source and owner locks.
// This check refuses any other production INSERT, COPY or MERGE into the
// journal. The only exemptions are:
//   * the storage_journal_append definition itself;
//   * the 0046 telemetry_emit_source_event replacement, which keeps the
//     pre-0046 version-0 body verbatim for owners without a head and may not
//     name the exact tuple columns;
//   * primary migrations numbered before 0046 (legacy history);
//   * scripts/postgres-ingestion-journal-transfer.mjs, the sealed D1 import;
//   * the D1 Worker producer in src/analytics-delivery.ts, which writes the D1
//     journal whose own triggers (typed-ingestion 0002) enforce exactness.
// Tests, checks and fixtures are not production producers and are skipped.
// Findings name files only; no source text is printed.

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JOURNAL = "storage_ingestion_changes";
const AUTHORITY_VERSION = 46;
const SCAN_ROOTS = Object.freeze(["src", "cloud-run", "scripts", "gcp-test", "postgres/migrations", "postgres/staged-migrations"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".wrangler", "fixtures"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|sql)$/u;
const TEST_FILE = /\.(?:check|test|spec|bench)\.[cm]?[jt]s$|\.d\.ts$/u;
const PRIMARY_MIGRATION = /^postgres\/(?:staged-)?migrations\/primary\/(\d{4})_[a-z0-9_-]+\.sql$/u;
const JOURNAL_TRANSFER = "scripts/postgres-ingestion-journal-transfer.mjs";
const D1_PRODUCERS = new Set(["src/analytics-delivery.ts"]);
const APPEND_FUNCTION = "storage_journal_append";
const LEGACY_EMITTER = "telemetry_emit_source_event";
const EXACT_TUPLE_COLUMNS = /\b(?:event_tuple_version|object_digest|content_digest|public_authority_epoch)\b/u;

/** Blank comments while keeping offsets, so matches map back to the source. */
function stripScriptComments(text) {
  let output = "";
  let state = "code";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (state === "code") {
      if (character === "/" && next === "/") { state = "line"; output += "  "; index += 1; continue; }
      if (character === "/" && next === "*") { state = "block"; output += "  "; index += 1; continue; }
      if (character === "'" || character === "\"" || character === "`") state = character;
      output += character;
    } else if (state === "line") {
      if (character === "\n") { state = "code"; output += character; } else output += " ";
    } else if (state === "block") {
      if (character === "*" && next === "/") { state = "code"; output += "  "; index += 1; } else output += character === "\n" ? "\n" : " ";
    } else {
      if (character === "\\") { output += character + (next ?? ""); index += 1; continue; }
      if (character === state) state = "code";
      output += character;
    }
  }
  return output;
}

function stripSqlComments(text) {
  let output = "";
  let quoted = false;
  let comment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (comment) {
      if (character === "\n") { comment = false; output += character; } else output += " ";
      continue;
    }
    if (!quoted && character === "-" && text[index + 1] === "-") { comment = true; output += "  "; index += 1; continue; }
    if (character === "'") quoted = !quoted;
    output += character;
  }
  return output;
}

/** Read one write target after INSERT INTO / COPY / MERGE INTO. */
function targetAt(text, start) {
  let index = start;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  const begin = index;
  while (index < text.length) {
    if (text.startsWith("${", index)) {
      let depth = 0;
      for (; index < text.length; index += 1) {
        if (text[index] === "{") depth += 1;
        if (text[index] === "}") { depth -= 1; if (depth === 0) { index += 1; break; } }
      }
    } else if (/[A-Za-z0-9_."]/u.test(text[index])) {
      index += 1;
    } else {
      break;
    }
  }
  return text.slice(begin, index);
}

/** Identifiers bound to the journal table name, e.g. const JOURNAL = "...". */
function journalAliases(text) {
  const aliases = new Set();
  for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]storage_ingestion_changes["'`]/gu)) {
    aliases.add(match[1]);
  }
  return aliases;
}

function journalWrites(text, aliases = new Set()) {
  const writes = [];
  for (const match of text.matchAll(/\b(?:INSERT\s+INTO|MERGE\s+INTO|COPY)\s+/giu)) {
    const target = targetAt(text, match.index + match[0].length);
    const named = target.includes(JOURNAL)
      || [...aliases].some((alias) => new RegExp(`(?:^|[^\\w$])${alias.replace(/\$/gu, "\\$")}(?:[^\\w$]|$)`, "u").test(target));
    if (named) writes.push(match.index);
  }
  return writes;
}

/** Dollar-quoted function bodies: [name, bodyStart, bodyEnd]. */
function functionBodies(sql) {
  const bodies = [];
  const pattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/giu;
  for (const match of sql.matchAll(pattern)) {
    const open = /\bAS\s+(\$[A-Za-z_]*\$)/u.exec(sql.slice(match.index));
    if (!open) continue;
    const bodyStart = match.index + open.index + open[0].length;
    const bodyEnd = sql.indexOf(open[1], bodyStart);
    if (bodyEnd < 0) continue;
    bodies.push([match[1].toLowerCase(), bodyStart, bodyEnd]);
  }
  return bodies;
}

function statementAt(sql, offset) {
  const end = sql.indexOf(";", offset);
  return sql.slice(offset, end < 0 ? sql.length : end);
}

/**
 * Scan one file. Returns `{ violation, appendDefinitions }`; the path must be
 * relative to the Worker root with forward slashes.
 */
export function scanJournalProducers(path, text) {
  if (path.endsWith(".sql")) {
    const sql = stripSqlComments(text);
    const migration = PRIMARY_MIGRATION.exec(path);
    const version = migration ? Number(migration[1]) : null;
    const writes = journalWrites(sql);
    if (version !== null && version < AUTHORITY_VERSION) return { violation: false, appendDefinitions: 0 };
    const bodies = functionBodies(sql);
    let appendDefinitions = 0;
    let violation = false;
    for (const offset of writes) {
      const enclosing = bodies.find(([, start, end]) => offset >= start && offset < end)?.[0];
      if (enclosing === APPEND_FUNCTION && version === AUTHORITY_VERSION) {
        appendDefinitions += 1;
      } else if (enclosing === LEGACY_EMITTER && version === AUTHORITY_VERSION
          && !EXACT_TUPLE_COLUMNS.test(statementAt(sql, offset))) {
        // The verbatim version-0 emitter body for owners without a head.
      } else {
        violation = true;
      }
    }
    return { violation, appendDefinitions };
  }
  if (path === JOURNAL_TRANSFER || D1_PRODUCERS.has(path)) return { violation: false, appendDefinitions: 0 };
  const code = stripScriptComments(text);
  return { violation: journalWrites(code, journalAliases(code)).length > 0, appendDefinitions: 0 };
}

async function sourceFiles(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        files.push(path);
      }
    }
  }
  for (const scanRoot of SCAN_ROOTS) await walk(join(root, scanRoot));
  return files.sort();
}

/** Scan a Worker tree; return offending file paths and the append definitions found. */
export async function checkJournalSingleProducer(root = WORKER_ROOT) {
  const violations = [];
  let appendDefinitions = 0;
  for (const file of await sourceFiles(root)) {
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink()) continue;
    const path = relative(root, file).split(sep).join("/");
    const result = scanJournalProducers(path, await readFile(file, "utf8"));
    if (result.violation) violations.push(path);
    appendDefinitions += result.appendDefinitions;
  }
  return { violations, appendDefinitions };
}

test("PostgreSQL exact journal rows have exactly one live producer", async () => {
  const { violations, appendDefinitions } = await checkJournalSingleProducer();
  assert.deepEqual(violations, [], "every production write to storage_ingestion_changes goes through storage_journal_append");
  assert.equal(appendDefinitions, 1, "the storage_journal_append definition is present exactly once");
});

test("a synthetic raw journal INSERT fails the ratchet, and only the reviewed producers are exempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-journal-producer-"));
  const write = async (path, text) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  try {
    const appendDefinition = `CREATE FUNCTION storage_journal_append(kind_value text) RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN INSERT INTO storage_ingestion_changes (source_id, event_tuple_version) VALUES ('s', 1); RETURN 1; END; $$;
CREATE OR REPLACE FUNCTION telemetry_emit_source_event(a text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN INSERT INTO storage_ingestion_changes (source_id,kind) VALUES ('s','source-updated'); END; $$;
`;
    await write("postgres/staged-migrations/primary/0046_owner_journal_authority.sql", appendDefinition);
    await write("postgres/migrations/primary/0014_effective_source_revision.sql",
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN INSERT INTO storage_ingestion_changes VALUES (1); END; $$;");
    await write(JOURNAL_TRANSFER, "await client.query(`INSERT INTO ${relation(schema, \"storage_ingestion_changes\")} VALUES ($1)`);");
    await write("src/analytics-delivery.ts", "db.prepare(`INSERT INTO storage_ingestion_changes (a) VALUES (?)`);");
    await write("src/documented.ts", "// A comment may say INSERT INTO storage_ingestion_changes without writing it.\nexport const x = 1;");
    await write("src/reader.ts", "await client.query(`SELECT * FROM ${schema}.storage_ingestion_changes`);");
    await write("src/other-insert.ts", "await client.query(`INSERT INTO ${schema}.storage_owner_revisions VALUES ($1)`);");
    await write("src/raw.test.ts", "await client.query(`INSERT INTO ${schema}.storage_ingestion_changes VALUES ($1)`);");
    const clean = await checkJournalSingleProducer(root);
    assert.deepEqual(clean, { violations: [], appendDefinitions: 1 });

    await write("src/raw-producer.ts", "await client.query(`INSERT INTO ${schema}.storage_ingestion_changes (source_id) VALUES ($1)`);");
    await write("src/relation-producer.ts", "await client.query(`insert into ${table(schema, \"storage_ingestion_changes\")} values ($1)`);");
    await write("cloud-run/alias-producer.mjs", "const JOURNAL = \"storage_ingestion_changes\";\nawait c.query(`INSERT INTO ${q(JOURNAL)} VALUES ($1)`);");
    await write("scripts/copy-producer.mjs", "await c.query(`COPY storage_ingestion_changes FROM STDIN`);");
    await write("postgres/staged-migrations/primary/0047_later_producer.sql",
      "INSERT INTO storage_ingestion_changes (source_id) SELECT source_id FROM storage_source_state;");
    await write("postgres/staged-migrations/primary/0046_owner_journal_authority.sql", `${appendDefinition}
CREATE FUNCTION rogue() RETURNS void AS $$ BEGIN INSERT INTO storage_ingestion_changes VALUES (1); END; $$;`);
    const dirty = await checkJournalSingleProducer(root);
    assert.deepEqual(dirty.violations, [
      "cloud-run/alias-producer.mjs",
      "postgres/staged-migrations/primary/0046_owner_journal_authority.sql",
      "postgres/staged-migrations/primary/0047_later_producer.sql",
      "scripts/copy-producer.mjs",
      "src/raw-producer.ts",
      "src/relation-producer.ts",
    ]);

    // The legacy emitter exemption holds only for the version-0 body.
    await write("postgres/staged-migrations/primary/0046_owner_journal_authority.sql", appendDefinition.replace(
      "(source_id,kind) VALUES ('s','source-updated')", "(source_id,event_tuple_version) VALUES ('s',1)"));
    assert.ok((await checkJournalSingleProducer(root)).violations
      .includes("postgres/staged-migrations/primary/0046_owner_journal_authority.sql"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
