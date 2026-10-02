// Static single-producer ratchet for the PostgreSQL analytics source journal.
//
// Exact (version-1) storage_ingestion_changes rows are D1-exact only when they
// come from storage_journal_append (primary migration 0046), whose revision,
// epochs and sequence are derived under the source and owner locks. This
// check refuses any other production INSERT, COPY or MERGE into the journal.
//
// A write counts as a journal write when its target names the journal in any
// letter case, or names an identifier bound to a string holding the name. A
// write whose target is computed (an interpolation without a literal table
// name, string concatenation, a format() placeholder) is refused whenever the
// same file (or, in SQL, the same function body or statement) mentions the
// journal or imports a module-level alias of it, unless the file is a reviewed
// dynamic writer below with its exact write-site count.
//
// The only exemptions are:
//   * the storage_journal_append definition itself;
//   * the 0046 telemetry_emit_source_event replacement, which keeps the
//     pre-0046 version-0 body verbatim for owners without a head and may not
//     name the exact tuple columns, and the later replacements named in
//     REVIEWED_EMITTER_REPLACEMENTS under the same rule, whose emitter
//     journal writes must equal 0046's, statement for statement;
//   * primary migrations numbered before 0046 (legacy history);
//   * scripts/postgres-ingestion-journal-transfer.mjs, the sealed D1 import;
//   * D1 prepared statements in src/analytics-delivery.ts, the D1 Worker
//     producer whose journal triggers (typed-ingestion 0002) enforce
//     exactness; a PostgreSQL write in that file is not exempt.
// Tests, checks and fixtures are not production producers and are skipped.
// Findings name files only; no source text is printed. This is a static
// guard: it cannot see a table name assembled from fragments, so review still
// applies.

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JOURNAL_NAME = /storage_ingestion_changes/iu;
const AUTHORITY_VERSION = 46;
const SCAN_ROOTS = Object.freeze(["src", "cloud-run", "scripts", "gcp-test", "postgres/migrations", "postgres/staged-migrations"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".wrangler", "fixtures"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|sql)$/u;
const TEST_FILE = /\.(?:check|test|spec|bench)\.[cm]?[jt]s$|\.d\.ts$/u;
const PRIMARY_MIGRATION = /^postgres\/(?:staged-)?migrations\/primary\/(\d{4})_([a-z0-9_-]+)\.sql$/u;
const JOURNAL_TRANSFER = "scripts/postgres-ingestion-journal-transfer.mjs";
const D1_PRODUCERS = new Set(["src/analytics-delivery.ts"]);
const APPEND_FUNCTION = "storage_journal_append";
const LEGACY_EMITTER = "telemetry_emit_source_event";
/**
 * Primary migrations after 0046 that may replace the legacy emitter, keyed by
 * name because the integrator renumbers staged files at promotion. Each keeps
 * the 0046 emitter body, including its version-0 INSERT, verbatim. This check
 * holds the journal part itself: a replacement's emitter journal writes must
 * equal, statement for statement, those of the 0046 emitter in the same tree,
 * and without that 0046 file the exemption does not apply.
 *   owner_journal_emitter_head_precheck (ISO-2): a lock-free head pre-check
 *   ahead of the unchanged 0046 body. The rest of the body is compared with
 *   0046 text by postgres-test/postgres-owner-journal-emitter-precheck.spec.mjs
 *   (postgres:domain:check).
 */
const REVIEWED_EMITTER_REPLACEMENTS = new Set(["owner_journal_emitter_head_precheck"]);
const EXACT_TUPLE_COLUMNS = /\b(?:event_tuple_version|object_digest|content_digest|public_authority_epoch)\b/iu;
const WRITE = /\b(?:INSERT\s+INTO|MERGE\s+INTO)\s+|\bCOPY\s+(?=[^\s;]+\s*(?:\(|FROM\b|TO\b))/giu;
const STATIC_TARGET = /^(?:(?:\$\{[A-Za-z_$][\w$]*\}|"?[A-Za-z_][A-Za-z0-9_$]*"?)\.)?"?[A-Za-z_][A-Za-z0-9_]*"?$/u;
// One interpolation whose last argument is a literal table name, such as
// ${table(schema, "name")} or ${relation(schema, 'name')}.
const LITERAL_RELATION = /^\$\{[^`{}]*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)\s*\}$/u;
// One interpolation that is, or ends with, a single identifier argument, such
// as ${RUNS} or ${relation(schema, RUNS)}.
const IDENTIFIER_RELATION = /^\$\{(?:[^`{}]*[(,]\s*)?([A-Za-z_$][\w$]*)\s*\)?\s*\}$/u;

/**
 * Reviewed files that mention the journal and write through computed targets
 * that never reach the PostgreSQL journal. The count pins their computed write
 * sites, so a new one needs a fresh review; a literal journal write in these
 * files is still refused.
 *   scripts/postgres-analytics-history-transfer.mjs: insertSql writes only the
 *   three SPECS/ANALYTICS_EVENT_SPEC tables (analytics_owner_state,
 *   analytics_source_cursors, analytics_applied_events); the journal is only
 *   read and required empty.
 *   scripts/gcp-fastpath-rehearsal.mjs: buildJournalSqlite's one prepared
 *   node:sqlite INSERT copies the oracle dump's storage_source_state and
 *   storage_ingestion_changes rows into a new journal-only SQLite file in the
 *   rehearsal's (or the fast-path seed's) mkdtemp work directory, then seals
 *   it 0444. That file is the source JOURNAL_TRANSFER, the sealed D1 import,
 *   reads; it never writes PostgreSQL, and the rehearsal's PostgreSQL journal
 *   rows come only from that transfer.
 *   scripts/cutover-source-projections.mjs (PT-2-lite, W2-SEAL):
 *   projectIngestionJournal's one prepared node:sqlite INSERT copies the
 *   sealed D1 storage_source_state and storage_ingestion_changes rows into a
 *   new journal-only SQLite file in the owner directory, in
 *   buildJournalSqlite's layout, written 0400. JOURNAL_TRANSFER reads that
 *   file; this module never opens PostgreSQL.
 */
const REVIEWED_DYNAMIC_WRITERS = new Map([
  ["scripts/postgres-analytics-history-transfer.mjs", 1],
  ["scripts/gcp-fastpath-rehearsal.mjs", 1],
  ["scripts/cutover-source-projections.mjs", 1],
]);

/** Blank comments and regex-literal bodies (keeping offsets); strings and templates stay. */
function stripScriptComments(text) {
  let output = "";
  const stack = ["code"];
  const braces = [];
  // A slash starts a regex literal after an operator, an opening bracket or
  // a keyword such as return, and is division after a value.
  const regexAllowed = () => {
    let end = output.length;
    while (end > 0 && /\s/u.test(output[end - 1])) end -= 1;
    if (end === 0 || /[(,=:[!&|?{};+\-*%<>~^]/u.test(output[end - 1])) return true;
    let start = end;
    while (start > 0 && /[\w$]/u.test(output[start - 1])) start -= 1;
    return /^(?:return|typeof|case|do|else|in|of|new|delete|void|throw|instanceof|yield|await)$/u.test(output.slice(start, end));
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    const state = stack.at(-1);
    if (state === "code") {
      if (character === "/" && next === "/") {
        const end = text.indexOf("\n", index);
        const stop = end < 0 ? text.length : end;
        output += " ".repeat(stop - index);
        index = stop - 1;
      } else if (character === "/" && next === "*") {
        const end = text.indexOf("*/", index + 2);
        const stop = end < 0 ? text.length : end + 2;
        output += text.slice(index, stop).replace(/[^\n]/gu, " ");
        index = stop - 1;
      } else if (character === "/" && regexAllowed()) {
        let cursor = index + 1;
        let inClass = false;
        for (; cursor < text.length && text[cursor] !== "\n"; cursor += 1) {
          if (text[cursor] === "\\") { cursor += 1; continue; }
          if (text[cursor] === "[") inClass = true;
          else if (text[cursor] === "]") inClass = false;
          else if (text[cursor] === "/" && !inClass) break;
        }
        // A regex literal is never SQL; keep its delimiters only.
        output += `/${" ".repeat(Math.max(0, cursor - index - 1))}${cursor < text.length ? text[cursor] : ""}`;
        index = cursor;
      } else if (character === "'" || character === "\"" || character === "`") {
        stack.push(character);
        output += character;
      } else if (character === "{" && braces.length > 0) {
        braces[braces.length - 1] += 1;
        output += character;
      } else if (character === "}" && braces.length > 0) {
        if (braces.at(-1) === 0) { braces.pop(); stack.pop(); } else braces[braces.length - 1] -= 1;
        output += character;
      } else {
        output += character;
      }
    } else {
      if (character === "\\") { output += character + (next ?? ""); index += 1; continue; }
      if (state === "`" && character === "$" && next === "{") {
        stack.push("code");
        braces.push(0);
        output += "${";
        index += 1;
        continue;
      }
      if (character === state) stack.pop();
      output += character;
    }
  }
  return output;
}

function stripSqlComments(text) {
  let output = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (!quoted && character === "-" && next === "-") {
      const end = text.indexOf("\n", index);
      const stop = end < 0 ? text.length : end;
      output += " ".repeat(stop - index);
      index = stop - 1;
      continue;
    }
    if (!quoted && character === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      output += text.slice(index, stop).replace(/[^\n]/gu, " ");
      index = stop - 1;
      continue;
    }
    if (character === "'") quoted = !quoted;
    output += character;
  }
  return output;
}

/** Read one write target: identifiers, dots, quoted names, %-placeholders and ${...}. */
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
    } else if (/[A-Za-z0-9_.$"%]/u.test(text[index])) {
      index += 1;
    } else {
      break;
    }
  }
  return text.slice(begin, index);
}

/** Identifiers bound to a string holding the journal name: `X = "..."` or `x: "..."`. */
function journalAliases(code) {
  const aliases = new Set();
  for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*(?::|=(?![=>]))\s*(["'`])([^"'`\n]*)\2/gu)) {
    if (JOURNAL_NAME.test(match[3])) aliases.add(match[1]);
  }
  return aliases;
}

/** Module-level exported aliases other files may import. */
function exportedJournalAliases(code) {
  const aliases = new Set();
  for (const match of code.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])([^"'`\n]*)\2/gu)) {
    if (JOURNAL_NAME.test(match[3])) aliases.add(match[1]);
  }
  return aliases;
}

/** File-local `const NAME = "table_name"` bindings, which cannot be reassigned. */
function constantTables(code) {
  const tables = new Map();
  for (const match of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])([A-Za-z_][A-Za-z0-9_]*)\2\s*[;\n]/gu)) {
    tables.set(match[1], match[3]);
  }
  return tables;
}

const word = (name) => new RegExp(`(?:^|[^\\w$])${name.replace(/\$/gu, "\\$")}(?:[^\\w$]|$)`, "u");

/** Every write in `text`: { offset, kind: "journal" | "static" | "dynamic" }. */
function writes(text, aliases, { sql, tables = new Map() }) {
  const found = [];
  for (const match of text.matchAll(WRITE)) {
    const target = targetAt(text, match.index + match[0].length);
    let kind;
    if (JOURNAL_NAME.test(target) || [...aliases].some((alias) => word(alias).test(target))) {
      kind = "journal";
    } else if (STATIC_TARGET.test(target) && (!sql || !target.includes("$"))) {
      kind = "static";
    } else if (!sql) {
      const literal = LITERAL_RELATION.exec(target)?.[1];
      const identifier = IDENTIFIER_RELATION.exec(target)?.[1];
      const resolved = literal ?? (identifier === undefined ? undefined : tables.get(identifier));
      kind = resolved === undefined ? "dynamic" : JOURNAL_NAME.test(resolved) ? "journal" : "static";
    } else {
      kind = "dynamic";
    }
    found.push({ offset: match.index, kind });
  }
  return found;
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

/** The top-level statement around `offset` (outside function bodies). */
function enclosingStatement(sql, offset) {
  const start = sql.lastIndexOf(";", offset - 1) + 1;
  return sql.slice(start, sql.indexOf(";", offset) < 0 ? sql.length : sql.indexOf(";", offset));
}

/** A statement's text, comments already blanked, with whitespace collapsed. */
const normalizedStatement = (sql, offset) => statementAt(sql, offset).replace(/\s+/gu, " ").trim();

function scanSql(path, text) {
  const sql = stripSqlComments(text);
  const migration = PRIMARY_MIGRATION.exec(path);
  const version = migration ? Number(migration[1]) : null;
  if (version !== null && version < AUTHORITY_VERSION) return { violation: false, appendDefinitions: 0, emitterWrites: [] };
  const emitterMigration = version === AUTHORITY_VERSION
    || (version > AUTHORITY_VERSION && REVIEWED_EMITTER_REPLACEMENTS.has(migration[2]));
  const bodies = functionBodies(sql);
  let appendDefinitions = 0;
  let violation = false;
  const emitterWrites = [];
  for (const { offset, kind } of writes(sql, new Set(), { sql: true })) {
    if (kind === "static") continue;
    const body = bodies.find(([, start, end]) => offset >= start && offset < end);
    if (kind === "dynamic") {
      const unit = body ? sql.slice(body[1], body[2]) : enclosingStatement(sql, offset);
      if (JOURNAL_NAME.test(unit)) violation = true;
      continue;
    }
    const enclosing = body?.[0];
    if (enclosing === APPEND_FUNCTION && version === AUTHORITY_VERSION) {
      appendDefinitions += 1;
    } else if (enclosing === LEGACY_EMITTER && emitterMigration
        && !EXACT_TUPLE_COLUMNS.test(statementAt(sql, offset))) {
      // The verbatim version-0 emitter body for owners without a head.
      emitterWrites.push(normalizedStatement(sql, offset));
    } else {
      violation = true;
    }
  }
  return { violation, appendDefinitions, emitterWrites };
}

/**
 * Scan one file. Returns `{ violation, appendDefinitions, dynamicWrites }`;
 * the path must be relative to the Worker root with forward slashes, and
 * `importedAliases` holds journal aliases exported by other scanned files.
 */
export function scanJournalProducers(path, text, { importedAliases = new Set() } = {}) {
  if (path.endsWith(".sql")) return { ...scanSql(path, text), dynamicWrites: 0 };
  if (path === JOURNAL_TRANSFER) return { violation: false, appendDefinitions: 0, dynamicWrites: 0, emitterWrites: [] };
  const code = stripScriptComments(text);
  const aliases = journalAliases(code);
  const imported = [...importedAliases].filter((alias) => word(alias).test(code));
  const mentionsJournal = JOURNAL_NAME.test(code) || imported.length > 0;
  let violation = false;
  let dynamicWrites = 0;
  const tables = constantTables(code);
  for (const { offset, kind } of writes(code, new Set([...aliases, ...imported]), { sql: false, tables })) {
    if (kind === "journal") {
      const d1Prepared = D1_PRODUCERS.has(path) && /\.prepare\(\s*[`'"]\s*$/u.test(code.slice(0, offset));
      if (!d1Prepared) violation = true;
    } else if (kind === "dynamic" && mentionsJournal) {
      dynamicWrites += 1;
    }
  }
  const reviewed = REVIEWED_DYNAMIC_WRITERS.get(path);
  if (dynamicWrites > 0 && dynamicWrites !== reviewed) violation = true;
  return { violation, appendDefinitions: 0, dynamicWrites, emitterWrites: [] };
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
  const sources = [];
  for (const file of await sourceFiles(root)) {
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink()) continue;
    sources.push([relative(root, file).split(sep).join("/"), await readFile(file, "utf8")]);
  }
  const importedAliases = new Set();
  for (const [path, text] of sources) {
    if (!path.endsWith(".sql")) for (const alias of exportedJournalAliases(stripScriptComments(text))) importedAliases.add(alias);
  }
  const violations = [];
  let appendDefinitions = 0;
  const reviewedDynamicWriters = new Map();
  const authorityEmitterWrites = [];
  const replacementEmitterWrites = [];
  for (const [path, text] of sources) {
    const result = scanJournalProducers(path, text, { importedAliases });
    if (result.violation) violations.push(path);
    if (REVIEWED_DYNAMIC_WRITERS.has(path)) reviewedDynamicWriters.set(path, result.dynamicWrites);
    appendDefinitions += result.appendDefinitions;
    const version = Number(PRIMARY_MIGRATION.exec(path)?.[1]);
    if (version === AUTHORITY_VERSION) authorityEmitterWrites.push(result.emitterWrites);
    else if (version > AUTHORITY_VERSION && result.emitterWrites.length > 0) replacementEmitterWrites.push([path, result.emitterWrites]);
  }
  // A reviewed replacement may write only what the one 0046 emitter writes.
  const authority = authorityEmitterWrites.length === 1 ? JSON.stringify(authorityEmitterWrites[0]) : null;
  for (const [path, emitterWrites] of replacementEmitterWrites) {
    if (JSON.stringify(emitterWrites) !== authority && !violations.includes(path)) violations.push(path);
  }
  return { violations: violations.sort(), appendDefinitions, reviewedDynamicWriters };
}

test("PostgreSQL exact journal rows have exactly one live producer", async () => {
  const { violations, appendDefinitions, reviewedDynamicWriters } = await checkJournalSingleProducer();
  assert.deepEqual(violations, [], "every production write to storage_ingestion_changes goes through storage_journal_append");
  assert.equal(appendDefinitions, 1, "the storage_journal_append definition is present exactly once");
  assert.deepEqual(reviewedDynamicWriters, REVIEWED_DYNAMIC_WRITERS, "every reviewed dynamic writer exists with its reviewed write sites");
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
CREATE FUNCTION storage_owner_revision_advance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM 1 FROM storage_ingestion_changes; INSERT INTO storage_owner_revisions (source_id) VALUES ('s'); RETURN NULL; END; $$;
INSERT INTO storage_owner_revisions (source_id) SELECT source_id FROM storage_ingestion_changes;
`;
    await write("postgres/staged-migrations/primary/0046_owner_journal_authority.sql", appendDefinition);
    await write("postgres/migrations/primary/0014_effective_source_revision.sql",
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN INSERT INTO storage_ingestion_changes VALUES (1); END; $$;");
    await write(JOURNAL_TRANSFER, "await client.query(`INSERT INTO ${relation(schema, \"storage_ingestion_changes\")} VALUES ($1)`);");
    await write("src/analytics-delivery.ts",
      "db.prepare(`INSERT INTO storage_ingestion_changes (a) VALUES (?)`);\nconst r = /a\\/\\/b/u; db.prepare(\"SELECT 1\");");
    await write("src/documented.ts", "// A comment may say INSERT INTO storage_ingestion_changes without writing it.\nexport const x = 1;");
    await write("src/reader.ts", "await client.query(`SELECT * FROM ${schema}.storage_ingestion_changes`);\n"
      + "await client.query(`INSERT INTO ${table(schema, \"analytics_owner_state\")} VALUES ($1)`);");
    await write("src/other-insert.ts", "await client.query(`INSERT INTO ${schema}.storage_owner_revisions VALUES ($1)`);\n"
      + "await client.query(`INSERT INTO ${relation(schema, spec.name)} VALUES ($1)`);");
    await write("src/raw.test.ts", "await client.query(`INSERT INTO ${schema}.storage_ingestion_changes VALUES ($1)`);");
    await write("scripts/postgres-analytics-history-transfer.mjs", "const T = [\"storage_ingestion_changes\"];\n"
      + "const sql = (schema, spec) => `INSERT INTO ${relation(schema, spec.name)} VALUES ($1)`;");
    // A reviewed later emitter replacement, at any number, keeps the version-0 body.
    const reviewedEmitter = "postgres/staged-migrations/primary/0091_owner_journal_emitter_head_precheck.sql";
    const emitterReplacement = `CREATE OR REPLACE FUNCTION telemetry_emit_source_event(a text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF EXISTS (SELECT 1 FROM storage_owner_revisions) THEN RETURN; END IF;
INSERT INTO storage_ingestion_changes (source_id,kind) VALUES ('s','source-updated'); END; $$;`;
    await write(reviewedEmitter, emitterReplacement);
    const clean = await checkJournalSingleProducer(root);
    assert.deepEqual(clean.violations, []);
    assert.equal(clean.appendDefinitions, 1);

    // The reviewed exemption covers only the 0046 emitter's own journal writes, text for text.
    const authorityPath = "postgres/staged-migrations/primary/0046_owner_journal_authority.sql";
    const beforeEnd = (text, statement) => text.replace("END; $$;", () => `${statement} END; $$;`);
    for (const doctored of [
      beforeEnd(emitterReplacement,
        "INSERT INTO storage_ingestion_changes (source_id,kind) VALUES ('s','source-updated') ON CONFLICT DO NOTHING;"),
      emitterReplacement.replace("'source-updated'", "'owner-active'"),
    ]) {
      await write(reviewedEmitter, doctored);
      assert.deepEqual((await checkJournalSingleProducer(root)).violations, [reviewedEmitter],
        "a reviewed replacement may not add or change a journal write");
    }
    await write(reviewedEmitter, emitterReplacement);
    await rm(join(root, authorityPath));
    assert.deepEqual((await checkJournalSingleProducer(root)).violations, [reviewedEmitter],
      "without the 0046 emitter to match, the reviewed exemption does not apply");
    await write(authorityPath, appendDefinition);
    assert.deepEqual((await checkJournalSingleProducer(root)).violations, []);

    const producers = {
      "src/raw-producer.ts": "await client.query(`INSERT INTO ${schema}.storage_ingestion_changes (source_id) VALUES ($1)`);",
      "src/relation-producer.ts": "await client.query(`insert into ${table(schema, \"storage_ingestion_changes\")} values ($1)`);",
      "src/upper-case.ts": "await client.query(`INSERT INTO ${schema}.STORAGE_INGESTION_CHANGES VALUES ($1)`);",
      "cloud-run/alias-producer.mjs": "const JOURNAL = \"storage_ingestion_changes\";\nawait c.query(`INSERT INTO ${q(JOURNAL)} VALUES ($1)`);",
      "cloud-run/concatenated.mjs": "await c.query(\"INSERT INTO \" + schema + \".storage_ingestion_changes (a) VALUES ($1)\");",
      "src/property.ts": "const T = { journal: \"storage_ingestion_changes\" };\nawait c.query(`INSERT INTO ${T.journal} VALUES ($1)`);",
      "src/spec-list.ts": "const SPECS = [{ name: \"storage_ingestion_changes\" }];\n"
        + "for (const spec of SPECS) await c.query(`INSERT INTO ${relation(schema, spec.name)} VALUES ($1)`);",
      "src/loop.ts": "for (const name of [\"storage_ingestion_changes\"]) await c.query(`INSERT INTO ${table(schema, name)} VALUES ($1)`);",
      "src/helper-bound.ts": "const target = relation(schema, \"storage_ingestion_changes\");\nawait c.query(`INSERT INTO ${target} VALUES ($1)`);",
      "src/names.ts": "export const SOURCE_JOURNAL_TABLE = \"storage_ingestion_changes\";",
      "src/imported.ts": "import { SOURCE_JOURNAL_TABLE } from \"./names\";\nawait c.query(`INSERT INTO ${q(SOURCE_JOURNAL_TABLE)} VALUES ($1)`);",
      "src/regex-line.ts": "const r = /a\\/\\/b/u; await c.query(`INSERT INTO ${schema}.storage_ingestion_changes VALUES ($1)`);",
      "scripts/copy-producer.mjs": "await c.query(`COPY storage_ingestion_changes FROM STDIN`);",
      "postgres/staged-migrations/primary/0047_later_producer.sql":
        "INSERT INTO storage_ingestion_changes (source_id) SELECT source_id FROM storage_source_state;",
      "postgres/staged-migrations/primary/0048_format_producer.sql":
        "CREATE FUNCTION g(s text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN\n"
        + "EXECUTE format('INSERT INTO %I.storage_ingestion_changes (source_id) VALUES ($1)', s); END; $$;",
      "postgres/staged-migrations/primary/0049_format_argument.sql":
        "CREATE FUNCTION h(s text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN\n"
        + "EXECUTE format('INSERT INTO %I.%I (source_id) VALUES ($1)', s, 'storage_ingestion_changes'); END; $$;",
      "postgres/staged-migrations/primary/0050_dollar_quoted.sql":
        "CREATE FUNCTION k() RETURNS void LANGUAGE plpgsql AS $$ BEGIN\n"
        + "EXECUTE $q$INSERT INTO storage_ingestion_changes (source_id) VALUES ('s')$q$; END; $$;",
      // Only named, reviewed migrations after 0046 may replace the legacy emitter.
      "postgres/staged-migrations/primary/0092_unreviewed_emitter.sql": emitterReplacement,
    };
    for (const [path, text] of Object.entries(producers)) await write(path, text);
    await write("postgres/staged-migrations/primary/0046_owner_journal_authority.sql", `${appendDefinition}
CREATE FUNCTION rogue() RETURNS void AS $$ BEGIN INSERT INTO storage_ingestion_changes VALUES (1); END; $$;`);
    // A PostgreSQL write in the D1 producer file is not exempt.
    await write("src/analytics-delivery.ts", "db.prepare(`INSERT INTO storage_ingestion_changes (a) VALUES (?)`);\n"
      + "await client.query(`INSERT INTO ${schema}.storage_ingestion_changes (a) VALUES ($1)`);");
    // A new computed write site in a reviewed dynamic writer needs review.
    await write("scripts/postgres-analytics-history-transfer.mjs", "const T = [\"storage_ingestion_changes\"];\n"
      + "const sql = (schema, spec) => `INSERT INTO ${relation(schema, spec.name)} VALUES ($1)`;\n"
      + "const more = (schema, name) => `INSERT INTO ${relation(schema, name)} VALUES ($1)`;");
    const dirty = await checkJournalSingleProducer(root);
    const expected = [
      ...Object.keys(producers).filter((path) => path !== "src/names.ts"),
      "postgres/staged-migrations/primary/0046_owner_journal_authority.sql",
      "scripts/postgres-analytics-history-transfer.mjs",
      "src/analytics-delivery.ts",
    ].sort();
    assert.deepEqual(dirty.violations, expected);

    // The legacy emitter exemption holds only for the version-0 body.
    await write("postgres/staged-migrations/primary/0046_owner_journal_authority.sql", appendDefinition.replace(
      "(source_id,kind) VALUES ('s','source-updated')", "(source_id,event_tuple_version) VALUES ('s',1)"));
    assert.ok((await checkJournalSingleProducer(root)).violations
      .includes("postgres/staged-migrations/primary/0046_owner_journal_authority.sql"));
    await write(authorityPath, appendDefinition);
    await write(reviewedEmitter, emitterReplacement.replace(
      "(source_id,kind) VALUES ('s','source-updated')", "(source_id,event_tuple_version) VALUES ('s',1)"));
    assert.ok((await checkJournalSingleProducer(root)).violations.includes(reviewedEmitter),
      "a reviewed emitter replacement is held to the same version-0 rule");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
