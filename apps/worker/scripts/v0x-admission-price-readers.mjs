#!/usr/bin/env node
/*
 * K-V0X guard: only the v0.x admission path may touch the admission price
 * columns.
 *
 * A v0.x contribution (telemetry-envelope-v0.1 and the v0.2 rows it left
 * behind) is priced once, at upload, and the result is stored beside the
 * record: fifteen columns on telemetry_records and eleven on
 * telemetry_contributions (twenty distinct names, listed in PRICE_COLUMNS;
 * D1 migrations 0006_server_pricing and 0022_historical_price_provenance, and
 * PostgreSQL primary 0011_retained_telemetry). Those values are admission
 * receipts. They carry the registry and the method that happened to be live at
 * upload, so a consumer that reads them prices an old registry into new
 * analysis, and that price never moves when the registry does. Everything else
 * must price from the stored quantities (the token columns and record_json)
 * through the current registry, as the v1 readers already do.
 *
 * What this module proves, all without a database:
 *   1. Source scan. Every JavaScript or TypeScript module under the Worker's
 *      src, cloud-run, scripts, vendor and ops directories (tests excluded by
 *      file name, as in postgres-retired-analytics-readers.check.mjs) that
 *      names one of the columns is listed in ALLOWED with its role, the mention
 *      kinds it may hold and a ceiling. An unlisted file, a kind the role does
 *      not allow, or more mentions than the ceiling fails. The list only
 *      shrinks: fewer mentions pass and are reported as slack to trim. The GCP
 *      admission module may only WRITE the columns (an INSERT column list or an
 *      UPDATE assignment); it may not read them back.
 *   2. Wildcard reads, in code and in SQL. A statement whose select list holds a
 *      bare *, an alias.* or a whole row (to_jsonb(r), row_to_json(r), a bare
 *      alias) over a FROM clause that names telemetry_records or
 *      telemetry_contributions, alone or joined to other tables, and a
 *      RETURNING list of that shape on a write to them, returns every receipt
 *      column without naming one. It is a "wildcard" mention and is held to the
 *      same allowlist. A CTE or subquery body is a statement of its own. Not
 *      detected: a table reached through a view or a run-time table name, a
 *      retained table inside a parenthesised join group, and a column name built
 *      at run time; the named scan, the bundle proof and the reach proof are the
 *      guarantee there.
 *   3. PostgreSQL SQL scan. No migration, staged migration or proposal under
 *      postgres/ names a column except the CREATE TABLE definitions of
 *      0011_retained_telemetry.sql, so no view, trigger, function or index can
 *      read a receipt either.
 *   4. DDL cross-check. PRICE_COLUMNS equals the columns the D1 migrations and
 *      PostgreSQL 0011 declare, and no SQL file anywhere under the Worker names
 *      another server_ identifier, so a new receipt column cannot appear
 *      unclassified.
 *   5. Bundle proof. build.mjs's entry points are bundled in memory with its own
 *      options, and the modules whose shipped text names a column are listed
 *      per entry (SHIPPED_ALLOWANCE). The analytics-refresh job and every other
 *      entry ship none, so the vendored d43c8f92 reader, which cannot be edited,
 *      is proven absent from the GCP compute path rather than only listed.
 *   6. Reach proof. The origin ships the Worker's D1 readers, so a new route
 *      bundled into it could import and call one without naming a column. The
 *      import graph of every entry in SHIPPED_ALLOWANCE is read from the esbuild
 *      metafile, and the modules that can reach a D1 reader, with the imports
 *      that lead there, must equal D1_REACH. A new importer, a new import into
 *      an existing member, or an entry that ships a reader and has no reviewed
 *      reach, fails. This proves the import graph, not which export is called:
 *      a reviewed importer that starts calling another export of a reader it
 *      already imports is not seen.
 *
 * It does not reach the vendored copy's runtime behavior, a database, which
 * export of a reviewed import a module calls, or a module that builds the
 * column names at run time from pieces.
 *
 * A new consumer of v0.x rows is not a reason to widen ALLOWED. It prices from
 * the stored quantities through the current registry (the K-REPRICE function,
 * as the v1 readers do). A tool that must copy receipts verbatim, such as the
 * v0.x importer, needs its own reviewed role here with copy-only semantics.
 *
 * Usage (from apps/worker):
 *   node scripts/v0x-admission-price-readers.mjs          check, exit 1 on a violation
 *   node scripts/v0x-admission-price-readers.mjs --list   print every reader found
 */

import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The admission price columns: every distinct name the D1 and PostgreSQL DDL declare. */
export const PRICE_COLUMNS = Object.freeze([
  "server_api_service_tier",
  "server_cost_nanousd",
  "server_cost_usd",
  "server_partially_priced_event_count",
  "server_price_basis",
  "server_price_card_ids",
  "server_price_epoch_basis",
  "server_price_event_time",
  "server_price_event_time_end",
  "server_price_event_time_start",
  "server_price_registry_sha256",
  "server_price_registry_version",
  "server_priced_event_count",
  "server_pricing_coverage_percent",
  "server_pricing_method_version",
  "server_pricing_status",
  "server_tier_basis",
  "server_unknown_billable_units",
  "server_unpriced_event_count",
  "server_unpriced_reason_codes",
]);

export const SCANNED_DIRECTORIES = Object.freeze(["src", "cloud-run", "scripts", "vendor", "ops"]);
export const SQL_DIRECTORY = "postgres";
export const D1_DDL_FILES = Object.freeze(["migrations/0006_server_pricing.sql", "migrations/0022_historical_price_provenance.sql"]);
export const POSTGRES_DDL_FILE = "postgres/migrations/primary/0011_retained_telemetry.sql";
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".wrangler"]);
const SOURCE_FILE = /\.(?:[cm]?js|[cm]?ts)$/u;
const TEST_FILE = /\.(?:check|spec|test)\.[cm]?[jt]s$/u;

/**
 * Every file allowed to name a column, with its role, the mention kinds that
 * role may hold and the most mentions allowed.
 *
 *   admission          the GCP v0.1 admission module; write only, never a read.
 *   d1-legacy          Cloudflare D1 Worker code, frozen at the d43c8f92
 *                      parity basis. It is bundled into the origin through the
 *                      Worker's index.ts but cannot run there: the origin binds
 *                      both D1 handles to a proxy that throws on any access.
 *                      Retire with the D1 modules after cutover.
 *   vendored-d1-legacy the byte copy of a d1-legacy module in the d43c8f92
 *                      kernel vendor tree. Generator-owned, never edited. The
 *                      bundle proof shows no GCP job ships its reader.
 *   d1-trigger-mirror  the staging fixture's copy of the D1 change-detection
 *                      trigger field list: names only, no value is read.
 *   guard              this module's own column list.
 *   ddl                the PostgreSQL column definitions.
 */
export const ALLOWED = Object.freeze([
  ["src/postgres-legacy-contribution-admission.ts", "admission", ["write"], 26],
  ["src/telemetry-repository.ts", "d1-legacy", ["read", "write", "wildcard"], 107],
  ["src/quota-analysis.ts", "d1-legacy", ["read"], 10],
  ["vendor/analytics-d43c8f92/apps/worker/src/quota-analysis.ts", "vendored-d1-legacy", ["read"], 10],
  ["scripts/staging-readiness-lib.mjs", "d1-trigger-mirror", ["inventory"], 11],
  ["scripts/v0x-admission-price-readers.mjs", "guard", ["inventory"], 20],
  [POSTGRES_DDL_FILE, "ddl", ["ddl"], 30],
].map(([file, role, kinds, max]) => Object.freeze({ file, role, kinds: Object.freeze(kinds), max })));

/**
 * The modules whose bundled text may name a column, per build.mjs entry. An
 * entry not listed ships none. The origin carries the admission module and the
 * Worker's D1 modules; no other entry carries any, so the analytics-refresh job
 * never ships a reader of the receipts.
 */
export const SHIPPED_ALLOWANCE = Object.freeze({
  "server.mjs": Object.freeze([
    "src/postgres-legacy-contribution-admission.ts",
    "src/quota-analysis.ts",
    "src/telemetry-repository.ts",
  ]),
});

/** The Cloudflare D1 modules that read receipts: every ALLOWED entry with the d1-legacy role. */
export const D1_READER_FILES = Object.freeze(ALLOWED.filter(({ role }) => role === "d1-legacy").map(({ file }) => file).sort());

/**
 * Who can reach a D1 receipt reader in an entry that ships one: for every module
 * of that entry's static import graph that leads to a reader, the modules it
 * imports that lead to one too (a reader with no such import is listed with an
 * empty list). The origin carries the Worker's D1 code, so a
 * new GCP route imported into it can import the D1 repository and call a
 * reader without naming a column, which neither the source scan nor the shipped
 * text can see. Any edge not listed here is refused. Reviewed at 1bea3b5f:
 *   cloud-run/server.mjs      the host; it composes the Worker's index.ts and
 *                             three GCP ports. The origin binds both D1 handles
 *                             to a proxy that throws on any access.
 *   src/index.ts              the Worker's fetch handler: the intended path to
 *                             the D1 repository, with its D1-internal helpers.
 *   src/postgres-*.ts         GCP ports; each imports only helper functions.
 * A new edge into this graph is a decision, not a fix: route the new code
 * through stored quantities and the current registry instead.
 */
export const D1_REACH = Object.freeze({
  "server.mjs": Object.freeze(Object.fromEntries(Object.entries({
    "cloud-run/server.mjs": ["src/index.ts", "src/postgres-community-daily.ts", "src/postgres-google-enrollment.ts", "src/postgres-legacy-contribution-admission.ts"],
    "src/admin-community-allowance.ts": ["src/community-allowance.ts", "src/community-publication.ts"],
    "src/admin-graph-refresh-progress.ts": ["src/community-allowance.ts", "src/community-model-history.ts", "src/community-refresh-lanes.ts"],
    "src/admin-metrics-history.ts": ["src/community-allowance.ts", "src/community-daily-aggregates.ts", "src/storage-community-graph-publication.ts"],
    "src/admin-reconstruction-progress.ts": ["src/community-daily-aggregates.ts"],
    "src/community-allowance.ts": ["src/quota-analysis.ts"],
    "src/community-analysis-warmer.ts": ["src/community-allowance.ts", "src/community-refresh-lanes.ts", "src/quota-analysis.ts"],
    "src/community-daily-aggregates.ts": ["src/admin-community-allowance.ts", "src/community-allowance.ts", "src/community-publication.ts", "src/community-refresh-lanes.ts"],
    "src/community-model-history.ts": ["src/admin-community-allowance.ts", "src/community-allowance.ts"],
    "src/community-publication.ts": ["src/community-allowance.ts"],
    "src/community-refresh-lanes.ts": ["src/community-allowance.ts"],
    "src/index.ts": [
      "src/admin-community-allowance.ts", "src/admin-graph-refresh-progress.ts", "src/admin-metrics-history.ts", "src/admin-reconstruction-progress.ts",
      "src/community-allowance.ts", "src/community-analysis-warmer.ts", "src/community-daily-aggregates.ts", "src/community-model-history.ts",
      "src/participant-erasure.ts", "src/public-allowance-breakdowns.ts", "src/retention.ts", "src/storage-community-daily.ts",
      "src/storage-community-graph-publication.ts", "src/storage-community-progress.ts", "src/storage-erasure.ts", "src/telemetry-repository.ts",
      "src/telemetry-v0.2-repository.ts",
    ],
    "src/participant-erasure.ts": ["src/retention.ts", "src/storage-erasure.ts", "src/telemetry-repository.ts"],
    "src/postgres-community-daily.ts": ["src/community-allowance.ts", "src/community-daily-aggregates.ts"],
    "src/postgres-google-enrollment.ts": ["src/retention.ts"],
    "src/postgres-legacy-contribution-admission.ts": ["src/telemetry-repository.ts"],
    "src/public-allowance-breakdowns.ts": ["src/admin-community-allowance.ts", "src/community-allowance.ts"],
    "src/quota-analysis.ts": [],
    "src/retention.ts": ["src/storage-erasure.ts"],
    "src/storage-community-daily.ts": ["src/community-daily-aggregates.ts", "src/storage-community-graph-publication.ts"],
    "src/storage-community-graph-publication.ts": ["src/admin-community-allowance.ts", "src/community-allowance.ts", "src/storage-community-graph.ts"],
    "src/storage-community-graph.ts": ["src/community-allowance.ts", "src/quota-analysis.ts"],
    "src/storage-community-progress.ts": ["src/admin-community-allowance.ts", "src/community-allowance.ts", "src/storage-community-graph.ts"],
    "src/storage-erasure.ts": ["src/storage-community-daily.ts", "src/storage-community-graph-publication.ts", "src/storage-graph-retirement.ts"],
    "src/storage-graph-retirement.ts": ["src/admin-community-allowance.ts", "src/storage-community-graph.ts"],
    "src/telemetry-repository.ts": ["src/quota-analysis.ts"],
    "src/telemetry-v0.2-repository.ts": ["src/telemetry-repository.ts"],
  }).map(([importer, imports]) => [importer, Object.freeze(imports)]))),
});

const COLUMN_PATTERN = new RegExp(`(?<![A-Za-z0-9_])(${PRICE_COLUMNS.join("|")})(?![A-Za-z0-9_])`, "gu");
const SQL_CLAUSE = /\b(INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|UPDATE|SET|SELECT|FROM|WHERE|JOIN|ON|VALUES|RETURNING|ORDER\s+BY|GROUP\s+BY|HAVING|CASE|WHEN|THEN|ELSE|USING|WITH)\b/gu;
const INVENTORY_LINE = /^\s*(?:["'`][A-Za-z0-9_]+["'`]\s*,\s*)*["'`][A-Za-z0-9_]+["'`]\s*,?\s*$/u;
const SQL_COLUMN_DEFINITION = /^\s*server_[a-z0-9_]+\s+(?:text|integer|bigint|smallint|numeric|jsonb|boolean|timestamptz|double\s+precision|real)\b/u;
const SQL_ADD_COLUMN = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?server_[a-z0-9_]+/u;

const RETAINED_TABLE = String.raw`(?:telemetry_records|telemetry_contributions)(?![A-Za-z0-9_])`;
const RETAINED_REFERENCE = String.raw`(?:\$\{[^}]*[tT]able\([^)]*?["']${RETAINED_TABLE}["']\s*\)\s*\}|(?:\$\{[^}]*\}\.|"?[A-Za-z0-9_]+"?\.)?"?${RETAINED_TABLE}"?)`;
const RETAINED_REFERENCE_GLOBAL = new RegExp(String.raw`(?<![A-Za-z0-9_])${RETAINED_REFERENCE}`, "giu");

/*
 * Wildcard analysis. A SELECT whose list holds a bare `*`, an `alias.*` or a
 * whole-row reference (`to_jsonb(r)`, `row_to_json(r)`, a bare alias) over a
 * FROM clause that names a retained table returns every receipt column without
 * naming one, and so does a RETURNING list over a write to one. The analysis
 * runs on a normalized copy of the source in which every reference to a
 * retained table (any schema qualifier or interpolated table helper) is one
 * token and every other ${...} interpolation is opaque, so only the statement
 * shape is left to read. Newlines are kept, so line numbers stay exact.
 */
const RETAINED_TOKEN = "__V0X_RETAINED__";
const OPAQUE_TOKEN = "__V0X_OPAQUE__";
const JS_STOP = String.raw`const|let|var|return|await|function|export|import|throw`;
const LIST_STOP = new RegExp(String.raw`(?:(?<!DISTINCT\s+)FROM|SELECT|${JS_STOP})(?![A-Za-z0-9_])`, "iuy");
const FROM_STOP = new RegExp(String.raw`(?:WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|RETURNING|WINDOW|FETCH|FOR\s+(?:UPDATE|SHARE|NO\s+KEY)|ON\s+CONFLICT|SELECT|${JS_STOP})(?![A-Za-z0-9_])`, "iuy");
const RETURNING_STOP = new RegExp(String.raw`(?:SELECT|${JS_STOP})(?![A-Za-z0-9_])`, "iuy");
const NOT_AN_ALIAS = new Set(["AS", "CROSS", "EXCEPT", "FETCH", "FOR", "FULL", "GROUP", "HAVING", "INNER", "INTERSECT", "JOIN", "LATERAL",
  "LEFT", "LIMIT", "NATURAL", "OFFSET", "ON", "ORDER", "OUTER", "RETURNING", "RIGHT", "SET", "TABLESAMPLE", "UNION", "USING", "VALUES", "WHERE", "WINDOW"]);
const FROM_REFERENCE = new RegExp(String.raw`(?:\bFROM\b|\bJOIN\b|,)\s*(?:ONLY\s+|LATERAL\s+)?${RETAINED_TOKEN}(?!\s*\.)(?=(?:\s+(?:AS\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?))?)`, "giu");
const WRITE_TARGET = new RegExp(String.raw`(?:INSERT(?:\s+OR\s+[A-Za-z]+)?\s+INTO|(?<!\bDO\s+)UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?(${RETAINED_TOKEN}(?!\s*\.)|[A-Za-z_"][A-Za-z0-9_".$]*)(?=(?:\s+(?:AS\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)(?=\s))?)`, "giu");

const keepNewlines = (text) => text.replace(/[^\n]/gu, "");
const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function normalizeForSql(source) {
  const referenced = source.replace(RETAINED_REFERENCE_GLOBAL, (match) => RETAINED_TOKEN + keepNewlines(match));
  let normalized = "";
  let from = 0;
  for (let open = referenced.indexOf("${"); open !== -1; open = referenced.indexOf("${", from)) {
    let depth = 0;
    let close = open + 1;
    for (; close < referenced.length; close += 1) {
      if (referenced[close] === "{") depth += 1;
      else if (referenced[close] === "}" && (depth -= 1) === 0) break;
    }
    normalized += referenced.slice(from, open) + OPAQUE_TOKEN + keepNewlines(referenced.slice(open, close + 1));
    from = close + 1;
  }
  return normalized + referenced.slice(from);
}

/**
 * Scan forward from `from` at parenthesis depth zero to the first stop keyword
 * (a sticky pattern) and report where it is. A closing parenthesis that has no
 * opener, a semicolon, a backtick or the length cap ends the scan with no hit.
 */
function scanDepthZero(text, from, stopPattern, limit) {
  let depth = 0;
  const end = Math.min(text.length, from + limit);
  for (let at = from; at < end; at += 1) {
    const char = text[at];
    if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) return { end: at, hit: null };
      depth -= 1;
    } else if (char === ";" || char === "`") return { end: at, hit: null };
    else if (depth === 0 && /[A-Za-z]/u.test(char) && !/[A-Za-z0-9_$."]/u.test(text[at - 1] ?? " ")) {
      stopPattern.lastIndex = at;
      const match = stopPattern.exec(text);
      if (match !== null) return { end: at, hit: match[0].replace(/\s+/gu, " ").toUpperCase() };
    }
  }
  return { end, hit: null };
}

function topLevelItems(list) {
  const items = [];
  let depth = 0;
  let item = "";
  for (const char of list) {
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      items.push(item);
      item = "";
    } else item += char;
  }
  return [...items, item];
}

/** Does this select or RETURNING list return whole rows of a table known by these aliases? */
function listReadsWholeRows(rawList, aliases) {
  const list = rawList.replace(/--[^\n]*|\/\*[\s\S]*?\*\//gu, " ").replace(/"/gu, "");
  const names = [...aliases].map(escapePattern).join("|");
  const items = topLevelItems(list).map((item, index) => (index === 0
    ? item.replace(/^\s*(?:ALL\b|DISTINCT\b(?:\s+ON\s*\([^)]*\))?)/iu, "") : item).trim());
  if (items.includes("*")) return true;
  if (new RegExp(String.raw`(?<![A-Za-z0-9_$.])(?:${names})\s*\.\s*\*|\(\s*(?:${names})\s*\)\s*\.\s*\*`, "iu").test(list)) return true;
  for (const match of list.matchAll(new RegExp(String.raw`(?<![A-Za-z0-9_$.])(?:${names})(?![A-Za-z0-9_$.(])`, "giu"))) {
    const before = list.slice(0, match.index).trimEnd();
    const after = list.slice(match.index + match[0].length).trimStart();
    // A whole-row use stands alone as an item or a call argument; `count(*) c` is an output alias, not the row.
    const standsAlone = before === "" || /[,(]$/u.test(before) || /\b(?:SELECT|DISTINCT|ALL)$/iu.test(before);
    if (standsAlone && (after === "" || /^(?:[,):]|AS\b|ORDER\b|FILTER\b|OVER\b)/iu.test(after))) return true;
  }
  return false;
}

/** The lines of every statement that returns whole rows of a retained table. */
export function wildcardLines(source) {
  const text = normalizeForSql(source);
  const lines = [];
  for (const select of text.matchAll(/\bSELECT\b/giu)) {
    const list = scanDepthZero(text, select.index + select[0].length, LIST_STOP, 1500);
    if (list.hit !== "FROM") continue;
    const clause = scanDepthZero(text, list.end + 4, FROM_STOP, 1500);
    // Only the tables joined at this statement's own depth feed its select list.
    let depth = 0;
    let own = "FROM ";
    for (const char of text.slice(list.end + 4, clause.end)) {
      if (char === "(") depth += 1;
      else if (char === ")") depth = Math.max(0, depth - 1);
      own += depth > 0 && char !== "(" && char !== "\n" ? " " : char;
    }
    const aliases = new Set();
    for (const reference of own.matchAll(FROM_REFERENCE)) {
      aliases.add(RETAINED_TOKEN);
      const alias = reference[1]?.replace(/"/gu, "");
      if (alias !== undefined && !NOT_AN_ALIAS.has(alias.toUpperCase())) aliases.add(alias);
    }
    if (aliases.size > 0 && listReadsWholeRows(text.slice(select.index + select[0].length, list.end), aliases)) {
      lines.push(lineOf(text, select.index));
    }
  }
  for (const returning of text.matchAll(/\bRETURNING\b/giu)) {
    const window = text.slice(Math.max(0, returning.index - 2000), returning.index);
    const statement = window.slice(Math.max(window.lastIndexOf(";"), window.lastIndexOf("`")) + 1);
    let target = null;
    for (const match of statement.matchAll(WRITE_TARGET)) target = match;
    if (target === null || !target[1].startsWith(RETAINED_TOKEN)) continue;
    const start = returning.index + returning[0].length;
    const list = scanDepthZero(text, start, RETURNING_STOP, 600);
    const aliases = new Set([RETAINED_TOKEN]);
    const alias = target[2]?.replace(/"/gu, "");
    if (alias !== undefined && !NOT_AN_ALIAS.has(alias.toUpperCase())) aliases.add(alias);
    if (listReadsWholeRows(text.slice(start, list.end), aliases)) lines.push(lineOf(text, returning.index));
  }
  return lines;
}

function lineOf(source, index) {
  let line = 1;
  for (let at = source.indexOf("\n"); at !== -1 && at < index; at = source.indexOf("\n", at + 1)) line += 1;
  return line;
}

function lineAround(source, index) {
  const start = source.lastIndexOf("\n", index - 1) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end === -1 ? source.length : end);
}

function lastClause(source, index) {
  let last = null;
  for (const match of source.slice(Math.max(0, index - 1500), index).matchAll(SQL_CLAUSE)) {
    last = match[1].startsWith("INSERT") ? "INSERT INTO" : match[1].replace(/\s+/gu, " ");
  }
  return last;
}

/**
 * Classify one mention in code. "inventory" is a whole line of quoted
 * identifiers (a frozen list); "write" is a column in an INSERT column list or
 * on the left of an UPDATE assignment; everything else is a "read": a SELECT
 * or WHERE use, an aggregate, a row-type field or a property access.
 */
export function classifyCodeMention(source, index, length) {
  if (INVENTORY_LINE.test(lineAround(source, index))) return "inventory";
  const before = source.slice(Math.max(0, index - 200), index);
  const after = source.slice(index + length, index + length + 200);
  const previous = /(\S)\s*$/u.exec(before)?.[1];
  const next = /^\s*(\S)/u.exec(after)?.[1];
  const clause = lastClause(source, index);
  if (clause === "INSERT INTO" && (previous === "(" || previous === ",") && (next === "," || next === ")")) return "write";
  if (clause === "SET" && (previous === "," || /\bSET\s*$/u.test(before)) && /^\s*=(?!=)/u.test(after)) return "write";
  return "read";
}

/** Classify one mention in SQL: a column definition is "ddl"; any other use reads the column. */
export function classifySqlMention(source, index) {
  const line = lineAround(source, index);
  return SQL_COLUMN_DEFINITION.test(line) || SQL_ADD_COLUMN.test(line) ? "ddl" : "read";
}

/** Every mention of an admission price column or a direct wildcard read in one file, as { column, kind, line }. */
export function findPriceMentions(file, source) {
  const sql = file.endsWith(".sql");
  const mentions = [];
  for (const match of source.matchAll(COLUMN_PATTERN)) {
    mentions.push({
      column: match[1],
      kind: sql ? classifySqlMention(source, match.index) : classifyCodeMention(source, match.index, match[0].length),
      line: lineOf(source, match.index),
    });
  }
  for (const line of wildcardLines(source)) mentions.push({ column: "*", kind: "wildcard", line });
  return mentions;
}

function groupByFile(sources) {
  const byFile = new Map();
  for (const [file, source] of sources) {
    const mentions = findPriceMentions(file, source);
    if (mentions.length > 0) byFile.set(file, mentions);
  }
  return byFile;
}

const summarize = (mentions) => {
  const counts = {};
  for (const { kind } of mentions) counts[kind] = (counts[kind] ?? 0) + 1;
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${count} ${kind}`).join(", ");
};

/** Compare every mention with the allowlist; return human-readable violations. */
export function readerViolations(sources, allowed = ALLOWED) {
  const entries = new Map(allowed.map((entry) => [entry.file, entry]));
  const violations = [];
  for (const [file, mentions] of groupByFile(sources)) {
    const lines = [...new Set(mentions.map(({ line }) => line))].slice(0, 6).join(",");
    const entry = entries.get(file);
    if (entry === undefined) {
      violations.push(`${file}:${lines} names the admission price columns (${summarize(mentions)}); `
        + "only the v0.x admission path may touch them, so price from the stored token columns instead");
      continue;
    }
    for (const kind of new Set(mentions.map((mention) => mention.kind))) {
      if (!entry.kinds.includes(kind)) {
        const at = mentions.filter((mention) => mention.kind === kind).slice(0, 6).map(({ line }) => line).join(",");
        violations.push(`${file}:${at} has a ${kind} mention of an admission price column; role ${entry.role} allows only ${entry.kinds.join(", ")}`);
      }
    }
    if (mentions.length > entry.max) {
      violations.push(`${file}:${lines} has ${mentions.length} mention(s) (${summarize(mentions)}), at most ${entry.max} allowed for role ${entry.role}`);
    }
  }
  return violations;
}

/** Allowlist entries above their current use: not failures, but room to trim. */
export function readerSlack(sources, allowed = ALLOWED) {
  const byFile = groupByFile(sources);
  return allowed.flatMap(({ file, role, max }) => {
    const used = byFile.get(file)?.length ?? 0;
    if (used === 0) return [`${file} (${role}) no longer names an admission price column; remove its entry`];
    return used < max ? [`${file} (${role}) now has ${used} of ${max} allowed mention(s); lower the ceiling`] : [];
  });
}

/** Every reader found, as one row per file: { file, role, total, kinds, lines }. */
export function readerInventory(sources, allowed = ALLOWED) {
  const roles = new Map(allowed.map(({ file, role }) => [file, role]));
  return [...groupByFile(sources)].map(([file, mentions]) => ({
    file,
    role: roles.get(file) ?? "unlisted",
    total: mentions.length,
    kinds: summarize(mentions),
    columns: new Set(mentions.filter(({ column }) => column !== "*").map(({ column }) => column)).size,
  })).sort((a, b) => a.file.localeCompare(b.file));
}

async function walk(directory, accept, sources, root) {
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
      if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path, accept, sources, root);
    } else if (entry.isFile() && accept(entry.name)) {
      sources.set(relative(root, path).split(sep).join("/"), await readFile(path, "utf8"));
    }
  }
}

/** The scanned code (tests excluded by name) and the PostgreSQL SQL under a Worker root. */
export async function collectSources(root = WORKER_ROOT) {
  const sources = new Map();
  for (const directory of SCANNED_DIRECTORIES) {
    await walk(join(root, directory), (name) => SOURCE_FILE.test(name) && !TEST_FILE.test(name), sources, root);
  }
  await walk(join(root, SQL_DIRECTORY), (name) => name.endsWith(".sql"), sources, root);
  return sources;
}

/** Every SQL file under a Worker root, D1 and PostgreSQL, for the DDL cross-check. */
export async function collectAllSql(root = WORKER_ROOT) {
  const sources = new Map();
  await walk(root, (name) => name.endsWith(".sql"), sources, root);
  return sources;
}

/** The columns a SQL file declares: ADD COLUMN clauses and column-definition lines. */
export function declaredPriceColumns(source) {
  const declared = new Set();
  for (const line of source.split("\n")) {
    const add = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(server_[a-z0-9_]+)/u.exec(line);
    const definition = /^\s*(server_[a-z0-9_]+)\s+(?:text|integer|bigint|smallint|numeric|jsonb|boolean|timestamptz|double\s+precision|real)\b/u.exec(line);
    const name = add?.[1] ?? definition?.[1];
    if (name !== undefined) declared.add(name);
  }
  return declared;
}

/** Every server_ identifier in a SQL source, declared or used. */
export function serverIdentifiers(source) {
  return new Set([...source.matchAll(/(?<![A-Za-z0-9_])server_[a-z0-9_]+/gu)].map((match) => match[0]));
}

/** build.mjs's entry-point files, its external list and its output directory, parsed from its source. */
export function parseBuildEntries(buildSource) {
  const constants = new Map([...buildSource.matchAll(/^const ([A-Z0-9_]*ENTRY) = resolve\(ROOT, "([^"]+)"\);$/gmu)]
    .map((match) => [match[1], match[2]]));
  const block = /entryPoints:\s*\{([^}]*)\}/u.exec(buildSource)?.[1] ?? "";
  const lines = block.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const declared = lines.map((line) => /^(?:"([^"]+)"|([A-Za-z0-9_]+)):\s*([A-Z0-9_]+),?$/u.exec(line))
    .map((match) => match && { name: match[1] ?? match[2], constant: match[3] });
  const external = /external:\s*(\[[^\]]*\])/u.exec(buildSource)?.[1];
  // Every line of the entry block must be a recognised entry: a line in another style is refused, never skipped.
  if (constants.size === 0 || declared.length !== constants.size || declared.some((entry) => entry === null)
      || declared.some(({ constant }) => !constants.has(constant)) || external === undefined) {
    throw Object.assign(new Error("V0X_BUILD_ENTRIES_UNPARSEABLE"), { code: "V0X_BUILD_ENTRIES_UNPARSEABLE" });
  }
  return {
    entries: declared.map(({ name, constant }) => ({ name, file: constants.get(constant) })),
    external: JSON.parse(external),
  };
}

/** A bundle's text before its first recognised module marker; it belongs to no module. */
export const UNATTRIBUTED = "(unattributed bundle text)";

/**
 * Split one bundle into the modules whose shipped text names a column. esbuild
 * writes a `// <path>` marker before each module's code; a marker counts only
 * when the metafile also lists the module as an input of that output. Text
 * after an unrecognised marker stays with the previous module, and a column in
 * the text before the first recognised marker is reported as UNATTRIBUTED, so
 * a parser that stops recognising markers fails closed instead of reporting none.
 */
export function bundleReaders(outputText, inputPaths, toWorkerPath) {
  const readers = new Set();
  const names = (text) => new RegExp(COLUMN_PATTERN.source, "u").test(text);
  const markers = [...outputText.matchAll(/^\/\/ (\S.*)$/gmu)].filter((match) => inputPaths.has(match[1]));
  if (names(outputText.slice(0, markers[0]?.index ?? outputText.length))) readers.add(UNATTRIBUTED);
  for (const [index, marker] of markers.entries()) {
    const end = markers[index + 1]?.index ?? outputText.length;
    if (names(outputText.slice(marker.index, end))) readers.add(toWorkerPath(marker[1]));
  }
  return readers;
}

/** The esbuild that cloud-run/build.mjs uses, resolved from the Cloud Run package. */
export function loadEsbuild(root = WORKER_ROOT) {
  try {
    return createRequire(join(root, "cloud-run", "package.json"))("esbuild");
  } catch (error) {
    throw Object.assign(new Error("V0X_ESBUILD_UNAVAILABLE: install apps/worker/cloud-run dependencies (npm ci)"),
      { code: "V0X_ESBUILD_UNAVAILABLE", cause: error });
  }
}

/**
 * Bundle build.mjs's entry points in memory, with its options, and list per
 * output (`<entry name>.mjs`) the shipped modules naming a column (`byFile`) and
 * the import edges that lead to a D1 reader (`reachByFile`).
 */
export async function shippedReaders(root = WORKER_ROOT, esbuild = loadEsbuild(root), readerFiles = D1_READER_FILES) {
  const cloudRun = join(root, "cloud-run");
  const { entries, external } = parseBuildEntries(await readFile(join(cloudRun, "build.mjs"), "utf8"));
  const result = await esbuild.build({
    absWorkingDir: cloudRun,
    entryPoints: Object.fromEntries(entries.map(({ name, file }) => [name, join(cloudRun, file)])),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outdir: join(cloudRun, "dist"),
    entryNames: "[name]",
    outExtension: { ".js": ".mjs" },
    sourcemap: false,
    external,
    logLevel: "silent",
    metafile: true,
    write: false,
  });
  const toWorkerPath = (path) => relative(root, resolve(cloudRun, path)).split(sep).join("/");
  const metaByName = new Map(Object.entries(result.metafile.outputs).map(([path, meta]) => [path.split("/").pop(), meta]));
  const graph = importGraph(result.metafile, toWorkerPath);
  const byFile = new Map();
  const reachByFile = new Map();
  for (const output of result.outputFiles) {
    const name = output.path.split(sep).pop();
    const meta = metaByName.get(name);
    byFile.set(name, bundleReaders(output.text, new Set(Object.keys(meta?.inputs ?? {})), toWorkerPath));
    reachByFile.set(name, reachEdges(graph, meta?.entryPoint === undefined ? undefined : toWorkerPath(meta.entryPoint), readerFiles));
  }
  return { entries, byFile, reachByFile, esbuildVersion: esbuild.version };
}

/** The bundle's static and dynamic import graph, without externals, as Map(module -> Set(imported modules)) of Worker-relative paths. */
export function importGraph(metafile, toWorkerPath) {
  const graph = new Map();
  for (const [input, meta] of Object.entries(metafile.inputs)) {
    const imports = graph.get(toWorkerPath(input)) ?? new Set();
    for (const imported of meta.imports) if (imported.external !== true) imports.add(toWorkerPath(imported.path));
    graph.set(toWorkerPath(input), imports);
  }
  return graph;
}

/**
 * The import edges that lead to a reader, within what one entry can import: the
 * modules reachable from the entry, then those among them that reach a reader
 * through imports, with the imports of each that reach one too. Returned as
 * { module: [imported, ...] } with sorted keys and values. A reader the entry
 * cannot import contributes nothing.
 */
export function reachEdges(graph, entry, readers) {
  const inEntry = new Set();
  for (const pending = entry === undefined ? [] : [entry]; pending.length > 0;) {
    const module = pending.pop();
    if (inEntry.has(module)) continue;
    inEntry.add(module);
    pending.push(...(graph.get(module) ?? []));
  }
  const importers = new Map();
  for (const module of inEntry) {
    for (const imported of graph.get(module) ?? []) {
      if (inEntry.has(imported)) importers.set(imported, [...(importers.get(imported) ?? []), module]);
    }
  }
  const leading = new Set();
  for (const pending = readers.filter((reader) => inEntry.has(reader)); pending.length > 0;) {
    const module = pending.pop();
    if (leading.has(module)) continue;
    leading.add(module);
    pending.push(...(importers.get(module) ?? []));
  }
  return Object.fromEntries([...leading].sort().map((module) => [
    module,
    [...(graph.get(module) ?? [])].filter((imported) => leading.has(imported)).sort(),
  ]));
}

/** Shipped readers outside the per-entry allowance, and allowance entries that no longer ship. */
export function shippedViolations(byFile, allowance = SHIPPED_ALLOWANCE) {
  const violations = [];
  for (const [entry, readers] of byFile) {
    const allowed = new Set(allowance[entry] ?? []);
    for (const reader of [...readers].sort()) {
      if (!allowed.has(reader)) violations.push(`${entry} ships ${reader}, which names an admission price column`);
    }
  }
  return violations;
}

export function shippedSlack(byFile, allowance = SHIPPED_ALLOWANCE) {
  return Object.entries(allowance).flatMap(([entry, allowed]) => {
    const shipped = byFile.get(entry) ?? new Set();
    return allowed.filter((reader) => !shipped.has(reader))
      .map((reader) => `${entry} no longer ships ${reader}; remove it from the allowance`);
  });
}

const edgesOf = (reach) => new Set(Object.entries(reach).flatMap(([module, imports]) => imports.map((imported) => `${module} -> ${imported}`)));

/**
 * Import edges that lead to a D1 reader and are not in the reviewed reach. An
 * entry in the allowance or the reach with no reviewed edges has all its edges
 * refused, so an entry that ships a reader cannot escape by being unlisted.
 */
export function reachViolations(reachByFile, reach = D1_REACH, allowance = SHIPPED_ALLOWANCE, readers = D1_READER_FILES) {
  const violations = [];
  for (const entry of new Set([...Object.keys(allowance), ...Object.keys(reach)])) {
    const reviewed = edgesOf(reach[entry] ?? {});
    for (const edge of [...edgesOf(reachByFile.get(entry) ?? {})].sort()) {
      if (reviewed.has(edge)) continue;
      const [module, imported] = edge.split(" -> ");
      violations.push(`${entry}: ${module} imports ${imported}, ${readers.includes(imported) ? "a D1 receipt reader" : "which reaches a D1 receipt reader"}; `
        + "a route into the Worker's D1 readers needs review, so price from the stored quantities through the current registry instead");
    }
  }
  return violations;
}

export function reachSlack(reachByFile, reach = D1_REACH) {
  return Object.entries(reach).flatMap(([entry, reviewed]) => {
    const found = edgesOf(reachByFile.get(entry) ?? {});
    return [...edgesOf(reviewed)].filter((edge) => !found.has(edge))
      .map((edge) => `${entry} no longer has the import ${edge}; remove it from D1_REACH`);
  });
}

async function main(argv) {
  const sources = await collectSources();
  const rows = readerInventory(sources);
  if (argv.includes("--list")) {
    for (const row of rows) console.log(`${row.role.padEnd(18)} ${String(row.total).padStart(4)}  ${row.file}  [${row.kinds}] ${row.columns} column(s)`);
    const shipped = await shippedReaders();
    for (const [entry, readers] of shipped.byFile) console.log(`ships ${entry}: ${[...readers].sort().join(", ") || "none"}`);
    for (const entry of Object.keys(D1_REACH)) {
      const reach = shipped.reachByFile.get(entry) ?? {};
      console.log(`reach ${entry}: ${Object.keys(reach).length} module(s), ${edgesOf(reach).size} import(s) lead to ${D1_READER_FILES.join(", ")}`);
    }
    return 0;
  }
  const shipped = await shippedReaders();
  const violations = [...readerViolations(sources), ...shippedViolations(shipped.byFile), ...reachViolations(shipped.reachByFile)];
  for (const violation of violations) console.error(violation);
  for (const slack of [...readerSlack(sources), ...shippedSlack(shipped.byFile), ...reachSlack(shipped.reachByFile)]) console.log(`slack: ${slack}`);
  console.log(violations.length === 0
    ? `ok: ${rows.length} file(s) name the admission price columns, all allowlisted`
    : `${violations.length} violation(s)`);
  return violations.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // Bounded and content-free: a code or the first line of the message, never a stack or a source excerpt.
    const first = error?.errors?.[0]?.text ?? String(error?.message ?? error);
    console.error(`${error?.code ?? "V0X_GUARD_FAILED"}: ${first.split("\n")[0].slice(0, 300)}`);
    process.exitCode = 1;
  }
}
