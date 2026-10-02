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
 *   2. Direct wildcard reads. A SELECT * or SELECT alias.* straight over
 *      telemetry_records or telemetry_contributions, or a RETURNING * on a write
 *      to them, returns every receipt column without naming one. It is a
 *      "wildcard" mention and is held to the same allowlist. Wildcards hidden
 *      behind a join, a CTE or row_to_json are not detected statically; the
 *      named scan and the bundle proof below are the guarantee.
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
 *
 * It does not reach the vendored copy's runtime behavior, a database, or a
 * module that builds the column names at run time from pieces.
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

const COLUMN_PATTERN = new RegExp(`(?<![A-Za-z0-9_])(${PRICE_COLUMNS.join("|")})(?![A-Za-z0-9_])`, "gu");
const SQL_CLAUSE = /\b(INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|UPDATE|SET|SELECT|FROM|WHERE|JOIN|ON|VALUES|RETURNING|ORDER\s+BY|GROUP\s+BY|HAVING|CASE|WHEN|THEN|ELSE|USING|WITH)\b/gu;
const INVENTORY_LINE = /^\s*(?:["'`][A-Za-z0-9_]+["'`]\s*,\s*)*["'`][A-Za-z0-9_]+["'`]\s*,?\s*$/u;
const SQL_COLUMN_DEFINITION = /^\s*server_[a-z0-9_]+\s+(?:text|integer|bigint|smallint|numeric|jsonb|boolean|timestamptz|double\s+precision|real)\b/u;
const SQL_ADD_COLUMN = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?server_[a-z0-9_]+/u;

const RETAINED_TABLE = String.raw`(?:telemetry_records|telemetry_contributions)(?![A-Za-z0-9_])`;
const RETAINED_REFERENCE = String.raw`(?:\$\{[^}]*[tT]able\([^)]*?["']${RETAINED_TABLE}["']\s*\)\s*\}|(?:\$\{[^}]*\}\.|"?[A-Za-z0-9_]+"?\.)?"?${RETAINED_TABLE}"?)`;
const WILDCARD_SHAPES = Object.freeze([
  new RegExp(String.raw`\bSELECT\s+(?:DISTINCT\s+)?\*\s+FROM\s+${RETAINED_REFERENCE}`, "giu"),
  new RegExp(String.raw`\bSELECT\s+(?:DISTINCT\s+)?([A-Za-z_][A-Za-z0-9_]*)\.\*\s+FROM\s+${RETAINED_REFERENCE}\s+(?:AS\s+)?\1\b`, "giu"),
  new RegExp(String.raw`\b(?:INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|UPDATE)\s+${RETAINED_REFERENCE}[^;\x60]{0,2000}?\bRETURNING\s+\*`, "giu"),
]);

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
  if (!sql) {
    for (const shape of WILDCARD_SHAPES) {
      for (const match of source.matchAll(shape)) {
        mentions.push({ column: "*", kind: "wildcard", line: lineOf(source, match.index) });
      }
    }
  }
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
 * output (`<entry name>.mjs`) the shipped modules naming a column.
 */
export async function shippedReaders(root = WORKER_ROOT, esbuild = loadEsbuild(root)) {
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
  const byFile = new Map();
  for (const output of result.outputFiles) {
    const name = output.path.split(sep).pop();
    byFile.set(name, bundleReaders(output.text, new Set(Object.keys(metaByName.get(name)?.inputs ?? {})), toWorkerPath));
  }
  return { entries, byFile, esbuildVersion: esbuild.version };
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

async function main(argv) {
  const sources = await collectSources();
  const rows = readerInventory(sources);
  if (argv.includes("--list")) {
    for (const row of rows) console.log(`${row.role.padEnd(18)} ${String(row.total).padStart(4)}  ${row.file}  [${row.kinds}] ${row.columns} column(s)`);
    const shipped = await shippedReaders();
    for (const [entry, readers] of shipped.byFile) console.log(`ships ${entry}: ${[...readers].sort().join(", ") || "none"}`);
    return 0;
  }
  const violations = [...readerViolations(sources), ...shippedViolations((await shippedReaders()).byFile)];
  for (const violation of violations) console.error(violation);
  for (const slack of readerSlack(sources)) console.log(`slack: ${slack}`);
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
