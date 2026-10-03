// Checks for scripts/v0x-admission-price-readers.mjs, the K-V0X guard. Run from
// apps/worker:
//   node --test scripts/v0x-admission-price-readers.check.mjs
// It needs apps/worker/cloud-run's dependencies (esbuild) for the bundle proof and
// fails with V0X_ESBUILD_UNAVAILABLE without them. No database, no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALLOWED, bundleReaders, classifyCodeMention, classifySqlMention, collectAllSql, collectSources,
  D1_DDL_FILES, D1_READER_FILES, D1_REACH, declaredPriceColumns, findPriceMentions, importGraph, loadEsbuild, parseBuildEntries,
  POSTGRES_DDL_FILE, PRICE_COLUMNS, reachEdges, reachSlack, reachViolations, readerInventory, readerSlack, readerViolations,
  serverIdentifiers, SHIPPED_ALLOWANCE, shippedReaders, shippedSlack, shippedViolations, UNATTRIBUTED, WORKER_ROOT, wildcardLines,
} from "./v0x-admission-price-readers.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "v0x-admission-price-readers.mjs");
const ADMISSION = "src/postgres-legacy-contribution-admission.ts";
const sorted = (values) => [...values].sort();

const sources = await collectSources();
const realReaders = readerInventory(sources);

test("the readers found in the real tree are exactly the allowlisted ones, and no unlisted module names a receipt column", () => {
  assert.ok(sources.size > 300, "the scan covers the Worker's source, scripts, vendor tree and PostgreSQL SQL");
  for (const directory of ["src/", "cloud-run/", "scripts/", "vendor/", "postgres/migrations/primary/", "postgres/staged-migrations/primary/"]) {
    assert.ok([...sources.keys()].some((file) => file.startsWith(directory)), `the scan walks ${directory}`);
  }
  assert.ok([...sources.keys()].some((file) => file.startsWith("src/analytics-v2/")), "the scan walks the GCP analytics modules");
  assert.ok([...sources.keys()].some((file) => file.startsWith("cloud-run/routes/")), "the scan walks the Cloud Run routes");
  assert.deepEqual(readerViolations(sources), []);
  // Every entry is a real file, so a typo cannot hide behind a ceiling.
  for (const { file } of ALLOWED) assert.ok(existsSync(join(WORKER_ROOT, file)), `${file} exists`);
  // The list only shrinks: a reader may disappear, but the admission writer, the DDL and the guard's own list are fixed points.
  const known = new Set(["admission", "d1-legacy", "vendored-d1-legacy", "d1-trigger-mirror", "ddl", "guard"]);
  for (const { role, file } of realReaders) assert.ok(known.has(role), `${file} has the unlisted role ${role}`);
  for (const role of ["admission", "ddl", "guard"]) assert.ok(realReaders.some((reader) => reader.role === role), `${role} is found`);
});

test("slack is reported without failing: a file that stops naming a column or drops below its ceiling is room to trim", (t) => {
  for (const slack of readerSlack(sources)) t.diagnostic(slack);
  const shrunk = new Map(sources);
  shrunk.set("src/quota-analysis.ts", "const unrelated = 1;\n");
  assert.deepEqual(readerViolations(shrunk), []);
  assert.ok(readerSlack(shrunk).includes("src/quota-analysis.ts (d1-legacy) no longer names an admission price column; remove its entry"));
  const vendored = "vendor/analytics-d43c8f92/apps/worker/src/quota-analysis.ts";
  shrunk.delete(vendored);
  assert.deepEqual(readerViolations(shrunk), []);
  assert.ok(readerSlack(shrunk).includes(`${vendored} (vendored-d1-legacy) no longer names an admission price column; remove its entry`));
  // A ceiling above the current use is slack too, never a failure.
  const lower = new Map(sources).set("src/quota-analysis.ts", "const unrelated = 1;\n// SELECT server_cost_nanousd FROM t\n");
  assert.deepEqual(readerViolations(lower), []);
  assert.ok(readerSlack(lower).some((line) => line.startsWith("src/quota-analysis.ts (d1-legacy) now has 1 of ")));
});

test("the GCP admission module only writes the receipt columns: every mention is an INSERT column or an UPDATE assignment", () => {
  const mentions = findPriceMentions(ADMISSION, sources.get(ADMISSION));
  assert.ok(mentions.length >= 20, "it writes the receipt columns it is the only path to write");
  assert.deepEqual([...new Set(mentions.map(({ kind }) => kind))], ["write"], "and reads none back");
  assert.ok(mentions.every(({ column }) => PRICE_COLUMNS.includes(column)));
  const source = sources.get(ADMISSION);
  assert.match(source, /INSERT INTO \$\{table\(schema, "telemetry_records"\)\} \(/u);
  assert.match(source, /UPDATE \$\{table\(schema, "telemetry_contributions"\)\}\s+SET server_cost_nanousd = \$1/u);
});

test("the Cloudflare D1 readers are the only other readers, and none is a PostgreSQL or GCP module", () => {
  const d1 = realReaders.filter(({ role }) => role === "d1-legacy" || role === "vendored-d1-legacy").map(({ file }) => file);
  const expected = [
    "src/quota-analysis.ts",
    "src/telemetry-repository.ts",
    "vendor/analytics-d43c8f92/apps/worker/src/quota-analysis.ts",
  ];
  assert.ok(d1.length > 0 && d1.every((file) => expected.includes(file)), "only the three known D1 modules read the receipts");
  for (const file of d1.filter((name) => name.startsWith("src/"))) {
    const source = sources.get(file);
    assert.match(source, /D1Database/u, `${file} reads through a D1 handle`);
    assert.doesNotMatch(source, /from ["']pg["']|PostgresPool|\$1\b/u, `${file} holds no PostgreSQL access`);
  }
  // No GCP analytics or route module names a column.
  const gcp = [...sources.keys()].filter((file) => file.startsWith("src/analytics-v2/") || file.startsWith("cloud-run/"));
  assert.ok(gcp.length > 40);
  for (const file of gcp) assert.deepEqual(findPriceMentions(file, sources.get(file)), [], file);
});

test("PRICE_COLUMNS equals the columns the D1 and PostgreSQL DDL declare, and no SQL anywhere names another server_ identifier", async () => {
  assert.equal(PRICE_COLUMNS.length, 20);
  assert.deepEqual([...PRICE_COLUMNS], sorted(PRICE_COLUMNS));
  const d1 = new Set();
  for (const file of D1_DDL_FILES) for (const name of declaredPriceColumns(await readFile(join(WORKER_ROOT, file), "utf8"))) d1.add(name);
  const postgres = declaredPriceColumns(await readFile(join(WORKER_ROOT, POSTGRES_DDL_FILE), "utf8"));
  assert.deepEqual(sorted(d1), [...PRICE_COLUMNS], "D1 0006 and 0022 declare the 20 columns");
  assert.deepEqual(sorted(postgres), [...PRICE_COLUMNS], "PostgreSQL 0011 declares the same 20");
  const allSql = await collectAllSql();
  assert.ok(allSql.size > 150, "the sweep reads every D1 and PostgreSQL migration");
  const known = new Set(PRICE_COLUMNS);
  for (const [file, source] of allSql) {
    for (const identifier of serverIdentifiers(source)) assert.ok(known.has(identifier), `${file} names ${identifier}, which is not a classified price column`);
  }
  const naming = [...allSql].filter(([, source]) => serverIdentifiers(source).size > 0).map(([file]) => file).sort();
  // PostgreSQL is held to the stricter rule: only column definitions, so no view, trigger or function reads a receipt.
  const postgresNaming = naming.filter((file) => file.startsWith("postgres/"));
  assert.deepEqual(postgresNaming, [POSTGRES_DDL_FILE]);
  const mentions = findPriceMentions(POSTGRES_DDL_FILE, sources.get(POSTGRES_DDL_FILE));
  assert.deepEqual([...new Set(mentions.map(({ kind }) => kind))], ["ddl"]);
});

test("the bundle proof: no entry ships a reader except the origin's admission and Worker D1 modules, and the refresh job ships none", async () => {
  const shipped = await shippedReaders();
  const outputs = shipped.entries.map(({ name }) => `${name}.mjs`);
  assert.ok(outputs.length >= 15 && outputs.includes("server.mjs") && outputs.includes("analytics-refresh.mjs"));
  for (const { file } of shipped.entries) assert.ok(existsSync(join(WORKER_ROOT, "cloud-run", file)), `${file} is an entry file`);
  assert.deepEqual([...shipped.byFile.keys()].sort(), outputs.sort(), "every entry produced one output");
  assert.deepEqual(shippedViolations(shipped.byFile), []);
  assert.deepEqual([...shipped.byFile.get("analytics-refresh.mjs")], [], "the analytics-refresh job ships no reader of the receipts");
  for (const [entry, readers] of shipped.byFile) {
    if (entry !== "server.mjs") assert.deepEqual([...readers], [], `${entry} ships none`);
  }
  // Positive control: the marker parsing sees the admission module, so "none" is not a parser that sees nothing.
  assert.ok(shipped.byFile.get("server.mjs").has(ADMISSION));
  // Shipping fewer readers than the allowance is slack, reported by the command line, never a failure.
  assert.ok(Array.isArray(shippedSlack(shipped.byFile)));
  // The vendored reader is on disk and unedited, yet not in any shipped text.
  const vendored = "vendor/analytics-d43c8f92/apps/worker/src/quota-analysis.ts";
  for (const readers of shipped.byFile.values()) assert.equal(readers.has(vendored), false);
});

test("the reach proof: the origin's import graph into the D1 readers equals the reviewed reach, and no other entry needs one", async () => {
  const shipped = await shippedReaders();
  assert.deepEqual([...D1_READER_FILES], ["src/quota-analysis.ts", "src/telemetry-repository.ts"], "the readers are the d1-legacy allowlist entries");
  assert.deepEqual(Object.keys(D1_REACH), Object.keys(SHIPPED_ALLOWANCE), "every entry that ships a reader has a reviewed reach");
  assert.deepEqual(reachViolations(shipped.reachByFile), []);
  assert.deepEqual(reachSlack(shipped.reachByFile), [], "the reviewed reach is exactly what the origin imports today");
  assert.deepEqual(shipped.reachByFile.get("server.mjs"), D1_REACH["server.mjs"]);
  // Positive controls: the graph sees the real edges, so "no new route" is not a parser that sees nothing.
  const origin = shipped.reachByFile.get("server.mjs");
  assert.ok(origin["src/index.ts"].includes("src/telemetry-repository.ts"));
  assert.deepEqual(origin["src/postgres-legacy-contribution-admission.ts"], ["src/telemetry-repository.ts"]);
  assert.deepEqual(origin["src/telemetry-repository.ts"], ["src/quota-analysis.ts"]);
  assert.ok(origin["cloud-run/server.mjs"].includes("src/index.ts"));
  assert.ok(Object.keys(origin).length > 20, "the Worker's D1 plumbing is in the reach, so a narrower reach would be a parser that stopped seeing it");
  // The entries that ship no reader may import one only where esbuild then drops it; the bundle proof is their guarantee.
  for (const [entry, readers] of shipped.byFile) {
    if (!(entry in D1_REACH)) assert.equal([...readers].some((reader) => D1_READER_FILES.includes(reader)), false, entry);
  }
});

test("negative: a new route that imports a D1 reader, or a member that gains an import, is refused (the real reach, doctored)", async () => {
  const shipped = await shippedReaders();
  const real = shipped.reachByFile.get("server.mjs");
  const doctoredReach = (changes) => new Map(shipped.reachByFile).set("server.mjs", { ...real, ...changes });
  const sortedPlus = (values, ...more) => [...values, ...more].sort();
  // The design item's case: a new route bundled into server.mjs imports personalStats from the D1 repository.
  const route = "cloud-run/routes/v0x-probe-route.mjs";
  const probe = reachViolations(doctoredReach({
    "cloud-run/server.mjs": sortedPlus(real["cloud-run/server.mjs"], route),
    [route]: ["src/telemetry-repository.ts"],
  }));
  assert.deepEqual(probe.map((line) => line.split(";")[0]), [
    `server.mjs: ${route} imports src/telemetry-repository.ts, a D1 receipt reader`,
    `server.mjs: cloud-run/server.mjs imports ${route}, which reaches a D1 receipt reader`,
  ]);
  // The same through the quota module, and through a reader's importer instead of the reader.
  assert.equal(reachViolations(doctoredReach({ "cloud-run/server.mjs": sortedPlus(real["cloud-run/server.mjs"], route), [route]: ["src/quota-analysis.ts"] })).length, 2);
  assert.equal(reachViolations(doctoredReach({ "cloud-run/server.mjs": sortedPlus(real["cloud-run/server.mjs"], route), [route]: ["src/index.ts"] })).length, 2);
  assert.equal(reachViolations(doctoredReach({ "cloud-run/server.mjs": sortedPlus(real["cloud-run/server.mjs"], route), [route]: ["src/telemetry-v0.2-repository.ts"] })).length, 2);
  // An existing member gains a direct import of a reader or of another member (the host, or a GCP port).
  assert.deepEqual(reachViolations(doctoredReach({ "cloud-run/server.mjs": sortedPlus(real["cloud-run/server.mjs"], "src/telemetry-repository.ts") })).map((line) => line.split(";")[0]),
    ["server.mjs: cloud-run/server.mjs imports src/telemetry-repository.ts, a D1 receipt reader"]);
  assert.deepEqual(reachViolations(doctoredReach({ "src/postgres-community-daily.ts": sortedPlus(real["src/postgres-community-daily.ts"], "src/quota-analysis.ts") })).map((line) => line.split(";")[0]),
    ["server.mjs: src/postgres-community-daily.ts imports src/quota-analysis.ts, a D1 receipt reader"]);
  assert.equal(reachViolations(doctoredReach({ "src/postgres-google-enrollment.ts": sortedPlus(real["src/postgres-google-enrollment.ts"], "src/telemetry-v0.2-repository.ts") })).length, 1);
  // An entry that ships a reader and has no reviewed reach has every edge refused, whatever else is pinned.
  assert.equal(reachViolations(shipped.reachByFile, {}).length, edgeCount(real));
  assert.equal(reachViolations(shipped.reachByFile, { "server.mjs": { "cloud-run/server.mjs": ["src/index.ts"] } }).length, edgeCount(real) - 1);
  // An edge that disappears is slack, never a failure.
  const smaller = doctoredReach({ "src/postgres-google-enrollment.ts": [] });
  assert.deepEqual(reachViolations(smaller), []);
  assert.deepEqual(reachSlack(smaller), ["server.mjs no longer has the import src/postgres-google-enrollment.ts -> src/retention.ts; remove it from D1_REACH"]);
  function edgeCount(reach) {
    return Object.values(reach).reduce((count, imports) => count + imports.length, 0);
  }
});

test("negative: the reach is read from real esbuild output, so a new importer of a reader in a built tree is found", async () => {
  const root = await mkdtemp(join(tmpdir(), "v0x-reach-"));
  const build = [
    'const ENTRY = resolve(ROOT, "server.mjs");',
    'const REFRESH_ENTRY = resolve(ROOT, "analytics-refresh.mjs");',
    "const options = {",
    "  entryPoints: {",
    "    server: ENTRY,",
    '    "analytics-refresh": REFRESH_ENTRY,',
    "  },",
    '  external: ["pg"],',
    "};",
    "",
  ].join("\n");
  const base = {
    "cloud-run/build.mjs": build,
    "cloud-run/server.mjs": 'import { handle } from "../src/index.ts";\nconsole.log(handle);\n',
    "cloud-run/analytics-refresh.mjs": 'console.log("refresh");\n',
    "src/index.ts": 'import { stats } from "./repo.ts";\nimport { Client } from "pg";\nexport const handle = [stats, Client];\n',
    "src/repo.ts": 'export const stats = "SELECT id FROM telemetry_records";\nexport const helper = 1;\n',
    "src/other.ts": "export const other = 1;\n",
  };
  const write = async (files) => {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
    }
  };
  const readers = ["src/repo.ts"];
  const reachOf = async (name = "server.mjs") => (await shippedReaders(root, loadEsbuild(), readers)).reachByFile.get(name);
  try {
    await write(base);
    const reviewed = { "server.mjs": await reachOf() };
    assert.deepEqual(reviewed["server.mjs"], { "cloud-run/server.mjs": ["src/index.ts"], "src/index.ts": ["src/repo.ts"], "src/repo.ts": [] },
      "externals and unrelated modules are not in the reach");
    assert.deepEqual(await reachOf("analytics-refresh.mjs"), {}, "an entry that cannot import the reader has no reach");
    const check = async () => reachViolations((await shippedReaders(root, loadEsbuild(), readers)).reachByFile, reviewed, { "server.mjs": [] }, readers);
    assert.deepEqual(await check(), []);
    // A new route imports the reader and the host imports the route.
    await write({
      "cloud-run/routes/probe.mjs": 'import { stats } from "../../src/repo.ts";\nexport const probe = stats;\n',
      "cloud-run/server.mjs": 'import { handle } from "../src/index.ts";\nimport { probe } from "./routes/probe.mjs";\nconsole.log(handle, probe);\n',
    });
    assert.deepEqual((await check()).map((line) => line.split(";")[0]), [
      "server.mjs: cloud-run/routes/probe.mjs imports src/repo.ts, a D1 receipt reader",
      "server.mjs: cloud-run/server.mjs imports cloud-run/routes/probe.mjs, which reaches a D1 receipt reader",
    ]);
    // The host imports the reader directly.
    await write({ "cloud-run/server.mjs": 'import { handle } from "../src/index.ts";\nimport { helper } from "../src/repo.ts";\nconsole.log(handle, helper);\n' });
    assert.deepEqual((await check()).map((line) => line.split(";")[0]), ["server.mjs: cloud-run/server.mjs imports src/repo.ts, a D1 receipt reader"]);
    // A route that imports an existing member (the Worker's index) is refused too, and a dynamic import counts.
    await write({
      "cloud-run/routes/probe.mjs": 'export const load = () => import("../../src/index.ts");\n',
      "cloud-run/server.mjs": 'import { load } from "./routes/probe.mjs";\nconsole.log(load);\n',
    });
    assert.deepEqual((await check()).map((line) => line.split(";")[0]), [
      "server.mjs: cloud-run/routes/probe.mjs imports src/index.ts, which reaches a D1 receipt reader",
      "server.mjs: cloud-run/server.mjs imports cloud-run/routes/probe.mjs, which reaches a D1 receipt reader",
    ]);
    // A route that imports only an unrelated module is not a route to a reader.
    await write({
      "cloud-run/routes/probe.mjs": 'import { other } from "../../src/other.ts";\nexport const probe = other;\n',
      "cloud-run/server.mjs": 'import { handle } from "../src/index.ts";\nimport { probe } from "./routes/probe.mjs";\nconsole.log(handle, probe);\n',
    });
    assert.deepEqual(await check(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the reach is a pure function of the import graph: externals, cycles, an unreachable reader and a missing entry are all handled", () => {
  const graph = new Map([
    ["entry.mjs", new Set(["a.ts", "b.ts"])],
    ["a.ts", new Set(["reader.ts", "a.ts"])],
    ["b.ts", new Set(["c.ts"])],
    ["c.ts", new Set(["b.ts"])],
    ["reader.ts", new Set()],
    ["orphan.ts", new Set(["reader.ts"])],
  ]);
  assert.deepEqual(reachEdges(graph, "entry.mjs", ["reader.ts"]), { "a.ts": ["a.ts", "reader.ts"], "entry.mjs": ["a.ts"], "reader.ts": [] },
    "b.ts and c.ts form a cycle that never reaches the reader, so they are not in the reach");
  assert.deepEqual(reachEdges(graph, "entry.mjs", ["unreachable.ts"]), {});
  assert.deepEqual(reachEdges(graph, "entry.mjs", []), {});
  assert.deepEqual(reachEdges(graph, undefined, ["reader.ts"]), {});
  assert.deepEqual(reachEdges(graph, "orphan.ts", ["reader.ts"]), { "orphan.ts": ["reader.ts"], "reader.ts": [] });
  const metafile = { inputs: { "x.ts": { imports: [{ path: "y.ts" }, { path: "pg", external: true }, { path: "z.ts", kind: "dynamic-import" }] }, "y.ts": { imports: [] } } };
  const graphed = importGraph(metafile, (path) => `w/${path}`);
  assert.deepEqual([...graphed.get("w/x.ts")].sort(), ["w/y.ts", "w/z.ts"]);
  assert.equal(graphed.has("w/y.ts"), true);
});

test("build.mjs entry parsing refuses a layout it cannot read completely instead of scanning fewer entries", async () => {
  const real = parseBuildEntries(await readFile(join(WORKER_ROOT, "cloud-run", "build.mjs"), "utf8"));
  assert.ok(real.entries.length >= 15);
  assert.deepEqual(real.external, ["@google-cloud/cloud-sql-connector", "google-auth-library", "jsonc-parser", "pg"]);
  const source = [
    'const ENTRY = resolve(ROOT, "server.mjs");',
    'const REFRESH_ENTRY = resolve(ROOT, "analytics-refresh.mjs");',
    "const options = {",
    "  entryPoints: {",
    "    server: ENTRY,",
    '    "analytics-refresh": REFRESH_ENTRY,',
    "  },",
    '  external: ["pg"],',
    "};",
  ].join("\n");
  assert.deepEqual(parseBuildEntries(source).entries, [
    { name: "server", file: "server.mjs" }, { name: "analytics-refresh", file: "analytics-refresh.mjs" },
  ]);
  // An entry added in another style, or an entry whose constant is not declared, is refused.
  assert.throws(() => parseBuildEntries(source.replace('"analytics-refresh": REFRESH_ENTRY,', '"analytics-refresh": REFRESH_ENTRY,\n    extra: resolve(ROOT, "extra.mjs"),')),
    { code: "V0X_BUILD_ENTRIES_UNPARSEABLE" });
  assert.throws(() => parseBuildEntries(source.replace('const REFRESH_ENTRY = resolve(ROOT, "analytics-refresh.mjs");\n', "")),
    { code: "V0X_BUILD_ENTRIES_UNPARSEABLE" });
  assert.throws(() => parseBuildEntries(source.replace('  external: ["pg"],\n', "")), { code: "V0X_BUILD_ENTRIES_UNPARSEABLE" });
  assert.throws(() => parseBuildEntries("const x = 1;"), { code: "V0X_BUILD_ENTRIES_UNPARSEABLE" });
});

test("mentions are classified: INSERT lists and UPDATE assignments write, a frozen quoted list is inventory, every other use reads", () => {
  const kind = (source, column) => classifyCodeMention(source, source.indexOf(column), column.length);
  assert.equal(kind("INSERT INTO t (a, server_cost_nanousd, b) VALUES ($1, $2, $3)", "server_cost_nanousd"), "write");
  assert.equal(kind("INSERT INTO t (\n  server_cost_usd,\n  b\n) VALUES (1, 2)", "server_cost_usd"), "write");
  assert.equal(kind("INSERT OR IGNORE INTO t (\n  a,\n  server_cost_nanousd,\n  b\n) VALUES (?1, ?2, ?3)", "server_cost_nanousd"), "write");
  assert.equal(kind("UPDATE t SET a = $1, server_cost_nanousd = $2 WHERE id = $3", "server_cost_nanousd"), "write");
  assert.equal(kind("UPDATE t SET server_cost_nanousd = $1 WHERE id = $2", "server_cost_nanousd"), "write");
  assert.equal(kind("UPDATE t SET a = server_cost_nanousd + 1 WHERE id = $2", "server_cost_nanousd"), "read", "a right-hand side reads");
  assert.equal(kind("UPDATE t SET a = $1 WHERE server_cost_nanousd = 0", "server_cost_nanousd"), "read");
  assert.equal(kind("SELECT server_cost_nanousd FROM t", "server_cost_nanousd"), "read");
  assert.equal(kind("SELECT SUM(server_cost_nanousd) FROM t", "server_cost_nanousd"), "read");
  assert.equal(kind("SELECT a FROM t ORDER BY server_cost_nanousd", "server_cost_nanousd"), "read");
  assert.equal(kind("INSERT INTO t (a) SELECT server_cost_nanousd FROM u", "server_cost_nanousd"), "read", "an INSERT ... SELECT reads");
  assert.equal(kind("const cost = row.server_cost_nanousd;", "server_cost_nanousd"), "read");
  assert.equal(kind("  server_cost_nanousd?: number;", "server_cost_nanousd"), "read", "a row-type field reads");
  assert.equal(kind("  server_cost_nanousd: number | null;", "server_cost_nanousd"), "read");
  assert.equal(kind('const FIELDS = [\n  "id", "server_cost_nanousd", "status",\n];', "server_cost_nanousd"), "inventory");
  assert.equal(kind('const FIELDS = [\n  "server_cost_nanousd",\n];', "server_cost_nanousd"), "inventory");
  assert.equal(kind('const q = "server_cost_nanousd, other";', "server_cost_nanousd"), "read", "a quoted list that is not a whole line of identifiers reads");
  assert.equal(kind("// SELECT server_cost_nanousd would read it", "server_cost_nanousd"), "read", "a comment is held to the same rule");
  const sql = (source, column) => classifySqlMention(source, source.indexOf(column));
  assert.equal(sql("  server_cost_nanousd bigint NOT NULL DEFAULT 0 CHECK (server_cost_nanousd >= 0),", "server_cost_nanousd"), "ddl");
  assert.equal(sql("  server_price_card_ids jsonb,", "server_price_card_ids"), "ddl");
  assert.equal(sql("ALTER TABLE telemetry_records ADD COLUMN server_cost_usd TEXT;", "server_cost_usd"), "ddl");
  assert.equal(sql("CREATE VIEW v AS SELECT server_cost_nanousd FROM telemetry_records;", "server_cost_nanousd"), "read");
  assert.equal(sql("  OR OLD.server_cost_nanousd IS NOT NEW.server_cost_nanousd", "server_cost_nanousd"), "read");
});

test("column names match whole identifiers only: vocabulary codes and near names never count", () => {
  for (const text of [
    'refusals.push("incomplete_server_pricing");',
    'reason: "no_server_priced_usage_in_interval",',
    'code: "server_price_coverage",',
    "const serverPricing = priced(row);",
    "serverCostNanousd",
    "my_server_cost_nanousd",
    "server_cost_nanousd2",
    "server_price_event_time_start_utc",
  ]) assert.deepEqual(findPriceMentions("src/x.ts", text), [], text);
  // The longer name wins over its prefix, so each is counted once under its own name.
  assert.deepEqual(findPriceMentions("src/x.ts", "a server_price_event_time_end b server_price_event_time c").map(({ column }) => column),
    ["server_price_event_time_end", "server_price_event_time"]);
  assert.equal(findPriceMentions("src/x.ts", "server_price_event_time_start").length, 1);
});

const doctored = (extra) => new Map([...sources, ...extra]);
const failures = (extra) => readerViolations(doctored(extra));

test("negative: a GCP analytics module or Cloud Run route that reads a receipt column is refused", () => {
  assert.match(failures([["src/analytics-v2/occurrence-source.ts",
    "const rows = await client.query(`SELECT r.server_cost_nanousd FROM ${s}.telemetry_records r WHERE r.participant_id=$1`);\n"]]).join("\n"),
  /src\/analytics-v2\/occurrence-source\.ts:1 names the admission price columns \(1 read\)/u);
  assert.match(failures([["cloud-run/routes/admin-overview.mjs",
    "export const sql = `SELECT COALESCE(SUM(server_cost_nanousd), 0) FROM telemetry_records`;\n"]]).join("\n"),
  /cloud-run\/routes\/admin-overview\.mjs:1 names the admission price columns/u);
  assert.match(failures([["src/analytics-v2/compute.ts", "const price = row.server_pricing_status;\n"]]).join("\n"),
    /src\/analytics-v2\/compute\.ts:1 names the admission price columns \(1 read\); only the v0\.x admission path may touch them/u);
  // The refresh job and the vendored kernels' neighbours are held to it too.
  assert.match(failures([["cloud-run/analytics-refresh.mjs", 'const COLUMNS = [\n  "server_price_basis",\n];\n']]).join("\n"),
    /cloud-run\/analytics-refresh\.mjs:2 names the admission price columns \(1 inventory\)/u);
  assert.match(failures([["vendor/analytics-d43c8f92/apps/worker/src/new-reader.ts", "SELECT server_cost_usd FROM telemetry_records\n"]]).join("\n"),
    /vendor\/analytics-d43c8f92\/apps\/worker\/src\/new-reader\.ts:1 names the admission price columns/u);
  // A comment is a mention too: reword it ("the admission price columns") or keep it out of this file.
  assert.match(failures([["src/analytics-v2/pin.ts", "// never read server_cost_nanousd here\n"]]).join("\n"), /src\/analytics-v2\/pin\.ts:1/u);
  // A script, such as a future importer, needs its own reviewed role.
  assert.match(failures([["scripts/postgres-v0x-import.mjs", 'const COPY = ["server_cost_nanousd", "server_priced_event_count"];\n']]).join("\n"),
    /scripts\/postgres-v0x-import\.mjs:1 names the admission price columns/u);
});

test("negative: the admission module may not read a receipt back, and its writes stay under the ceiling", () => {
  const admission = sources.get(ADMISSION);
  assert.match(failures([[ADMISSION, `${admission}\nconst check = \`SELECT server_cost_nanousd FROM telemetry_records WHERE id = $1\`;\n`]]).join("\n"),
    /has a read mention of an admission price column; role admission allows only write/u);
  assert.match(failures([[ADMISSION, `${admission}\nconst copy = \`UPDATE x SET a = server_cost_usd + 1 WHERE id = $1\`;\n`]]).join("\n"),
    /has a read mention of an admission price column; role admission allows only write/u);
  assert.match(failures([[ADMISSION, `${admission}\nconst row = result.rows[0].server_pricing_status;\n`]]).join("\n"),
    /role admission allows only write/u);
  assert.match(failures([[ADMISSION, `${admission}\nconst quoted = ["server_cost_usd", "id"];\n`]]).join("\n"), /role admission allows only write/u);
  // One more write than the ceiling allows is refused, whatever the ceiling is today.
  const { max } = ALLOWED.find(({ file }) => file === ADMISSION);
  const writes = (count) => `\nawait client.query(\`UPDATE t SET ${Array.from({ length: count }, (_, index) => `server_tier_basis = $${index + 1}`).join(", ")} WHERE id = $0\`);\n`;
  const used = findPriceMentions(ADMISSION, admission).length;
  assert.deepEqual(failures([[ADMISSION, `${admission}${writes(max - used)}`]]), [], "exactly at the ceiling passes");
  assert.match(failures([[ADMISSION, `${admission}${writes(max - used + 1)}`]]).join("\n"),
    new RegExp(`has ${max + 1} mention\\(s\\) \\(${max + 1} write\\), at most ${max} allowed for role admission`, "u"));
  assert.deepEqual(failures([[ADMISSION, admission]]), []);
});

test("negative: a statement that returns whole rows of a retained table is a wildcard read, whatever else is in its select list or joined", () => {
  const wildcards = (source) => findPriceMentions("src/postgres-x.ts", source).filter(({ kind }) => kind === "wildcard").length;
  // Straight over a retained table, alone or schema-qualified, with an interpolated table helper, and a RETURNING *.
  assert.equal(wildcards("SELECT c.* FROM telemetry_contributions c WHERE c.id = ?"), 1);
  assert.equal(wildcards("SELECT * FROM telemetry_records WHERE participant_id = $1"), 1);
  assert.equal(wildcards("SELECT DISTINCT r.* FROM telemetry_records AS r"), 1);
  assert.equal(wildcards('await client.query(`SELECT c.* FROM ${table(schema, "telemetry_contributions")} c`)'), 1);
  assert.equal(wildcards('await client.query(`SELECT * FROM ${qtable(s, "telemetry_records")}`)'), 1);
  assert.equal(wildcards("SELECT * FROM ${schema}.telemetry_records"), 1);
  assert.equal(wildcards("SELECT * FROM tibotattle.telemetry_records"), 1);
  assert.equal(wildcards('SELECT * FROM "tibotattle"."telemetry_contributions"'), 1);
  assert.equal(wildcards("INSERT INTO telemetry_records (a) VALUES ($1) RETURNING *"), 1);
  assert.equal(wildcards("UPDATE telemetry_contributions SET a = 1 WHERE id = $1 RETURNING *"), 1);
  // The wildcard is one item among others: the form this codebase uses most, which a FROM-adjacent pattern misses.
  assert.equal(wildcards("SELECT *, 1 AS k FROM telemetry_records"), 1);
  assert.equal(wildcards("SELECT r.*, 1 AS k FROM telemetry_records r"), 1);
  assert.equal(wildcards("SELECT id, * FROM telemetry_records"), 1);
  assert.equal(wildcards("SELECT DISTINCT ON (id) * FROM telemetry_records"), 1);
  assert.equal(wildcards("SELECT a IS DISTINCT FROM b, r.* FROM telemetry_records r"), 1);
  assert.equal(wildcards("SELECT c.*, p.state AS participant_state FROM telemetry_contributions c JOIN participants p ON p.id = c.participant_id"), 1);
  assert.equal(wildcards("SELECT \"r\".* FROM telemetry_records AS \"r\""), 1);
  assert.equal(wildcards("SELECT telemetry_records.* FROM telemetry_records"), 1);
  // The retained table is joined: a bare * returns its columns too, however it is joined.
  assert.equal(wildcards("SELECT * FROM participants p JOIN telemetry_contributions c ON c.participant_id = p.id"), 1);
  assert.equal(wildcards("SELECT * FROM participants p LEFT JOIN telemetry_records ON telemetry_records.id = p.id"), 1);
  assert.equal(wildcards("SELECT * FROM participants p, telemetry_records r WHERE r.id = p.id"), 1);
  assert.equal(wildcards("SELECT * FROM telemetry_records_x r JOIN telemetry_contributions c ON c.id = r.id"), 1);
  // A whole row, taken as a value: a row-to-JSON call, a bare alias, a row constructor or the table's own name.
  assert.equal(wildcards("SELECT to_jsonb(r) FROM telemetry_records r"), 1);
  assert.equal(wildcards("SELECT row_to_json(r) FROM telemetry_records r"), 1);
  assert.equal(wildcards("SELECT json_agg(r ORDER BY r.id) FROM telemetry_records AS r"), 1);
  assert.equal(wildcards("SELECT to_jsonb(r.*) FROM telemetry_records r"), 1);
  assert.equal(wildcards("SELECT (r).* FROM telemetry_records r"), 1);
  assert.equal(wildcards("SELECT r FROM telemetry_records r"), 1);
  assert.equal(wildcards("SELECT r AS whole_row, 1 FROM telemetry_records r"), 1);
  assert.equal(wildcards("SELECT row_to_json(telemetry_records) FROM telemetry_records"), 1);
  // A CTE, a subquery and an INSERT ... SELECT body is a statement of its own.
  assert.equal(wildcards("WITH x AS (SELECT * FROM telemetry_records) SELECT x.id FROM x"), 1);
  assert.equal(wildcards("WITH x AS (SELECT r.*, 1 FROM telemetry_records r WHERE r.id = 1) SELECT 1"), 1);
  assert.equal(wildcards("SELECT x.id FROM (SELECT c.*, 1 FROM telemetry_contributions c) x"), 1);
  assert.equal(wildcards("INSERT INTO elsewhere SELECT c.*, 1 FROM telemetry_contributions c"), 1);
  assert.equal(wildcards("SELECT r.id FROM telemetry_records r UNION ALL SELECT * FROM telemetry_contributions"), 1);
  // RETURNING lists with other items, a qualified star, a DELETE, and an upsert.
  assert.equal(wildcards("INSERT INTO telemetry_records (a) VALUES ($1) RETURNING id, *"), 1);
  assert.equal(wildcards("UPDATE telemetry_contributions c SET a = 1 WHERE id = $1 RETURNING c.*"), 1);
  assert.equal(wildcards("DELETE FROM telemetry_records WHERE id = $1 RETURNING *"), 1);
  assert.equal(wildcards("INSERT INTO telemetry_records (a) VALUES ($1) ON CONFLICT (id) DO UPDATE SET a = 2 RETURNING *"), 1);
  // Each statement counts once, and the line is the statement's, through a multi-line template with an opaque ${...} in its list.
  const multiline = ["const a = 1;", "const q = `", "  SELECT ${columns},", "         r.*", '    FROM ${table(schema, "telemetry_records")} r', " WHERE r.id = $1`;"].join("\n");
  assert.deepEqual(wildcardLines(multiline), [3]);
  assert.equal(wildcards("SELECT *, r.* FROM telemetry_records r"), 1);
  assert.equal(wildcards("SELECT * FROM telemetry_records; SELECT c.* FROM telemetry_contributions c"), 2);
  // Not wildcards over a retained table: named columns, counts, output aliases, other tables, and tables only filtered on.
  for (const text of [
    "SELECT c.id, c.status FROM telemetry_contributions c",
    "SELECT 1 FROM telemetry_contributions c WHERE c.participant_id = $1",
    "SELECT count(*) FROM telemetry_records",
    "SELECT count(*) c FROM telemetry_contributions c",
    "SELECT count(*) AS c FROM telemetry_contributions c",
    "SELECT r.id AS r FROM telemetry_records r",
    "SELECT r.id, to_jsonb(r.record_json), jsonb_build_object('id', r.id) FROM telemetry_records r",
    "SELECT a IS DISTINCT FROM b FROM telemetry_records r",
    "SELECT -- all of it *\n id FROM telemetry_records",
    "SELECT /* r.* */ id FROM telemetry_records r",
    "SELECT * FROM typed_telemetry_records",
    "SELECT * FROM telemetry_records_archive",
    "SELECT * FROM telemetry_records_view",
    "SELECT * FROM candidates",
    "SELECT * FROM (SELECT 1) inventory",
    "SELECT q.* FROM quota q",
    "SELECT p.* FROM participants p JOIN telemetry_records r ON r.participant_id = p.id",
    "SELECT p.*, r.id FROM participants p JOIN telemetry_records r ON r.participant_id = p.id",
    "SELECT x.* FROM x LEFT JOIN telemetry_records ON telemetry_records.id = x.id",
    "SELECT t.* FROM telemetry_records_archive t JOIN telemetry_records r ON r.id = t.id",
    "SELECT * FROM participants p WHERE EXISTS (SELECT 1 FROM telemetry_records r WHERE r.participant_id = p.id)",
    "SELECT * FROM participants p WHERE p.id IN (SELECT participant_id FROM telemetry_records)",
    "SELECT * FROM (SELECT id FROM telemetry_records) t",
    "INSERT INTO telemetry_records (a) VALUES ($1) ON CONFLICT DO NOTHING",
    "INSERT INTO telemetry_records (a) VALUES ($1) RETURNING id",
    "INSERT INTO other (a) VALUES ($1) RETURNING *",
    "UPDATE telemetry_contributions SET a = 1 WHERE id = $1 RETURNING id, status",
    "SELECT 1; INSERT INTO other (a) VALUES (1) RETURNING *",
    "WITH ins AS (INSERT INTO telemetry_records (a) VALUES (1) RETURNING id), b AS (INSERT INTO other (a) VALUES (2) RETURNING *) SELECT 1",
    'const a = "SELECT 1"; const b = 2;\nawait run("DELETE FROM telemetry_records WHERE id = 1")',
  ]) assert.equal(wildcards(text), 0, text);
  assert.match(failures([["src/postgres-device-sync.ts", "const row = await db.prepare(`SELECT c.* FROM telemetry_contributions c WHERE c.id = ?`);\n"]]).join("\n"),
    /src\/postgres-device-sync\.ts:1 names the admission price columns \(1 wildcard\)/u);
  // The shapes the real tree uses elsewhere (a wildcard beside joined columns of another table) are not receipts unless the table is retained.
  assert.deepEqual(failures([["src/postgres-other.ts", "`SELECT u.*, p.state AS participant_state FROM upload_authorizations u JOIN participants p ON p.id = u.participant_id`\n"]]), []);
  assert.match(failures([["src/postgres-other.ts", "`SELECT c.*, p.state AS participant_state FROM telemetry_contributions c JOIN participants p ON p.id = c.participant_id`\n"]]).join("\n"),
    /src\/postgres-other\.ts:1 names the admission price columns \(1 wildcard\)/u);
  // A wildcard in an allowlisted file counts against its ceiling and its role: the admission module may only write.
  assert.match(failures([[ADMISSION, `${sources.get(ADMISSION)}\nconst all = \`SELECT *, 1 AS k FROM telemetry_records\`;\n`]]).join("\n"), /has a wildcard mention of an admission price column; role admission allows only write/u);
});

test("negative: PostgreSQL SQL outside the 0011 column definitions may not name a column", () => {
  assert.match(failures([["postgres/staged-migrations/primary/NNNN_v0x_view.sql",
    "CREATE VIEW v0x_priced AS SELECT participant_id, server_cost_nanousd FROM telemetry_records;\n"]]).join("\n"),
  /postgres\/staged-migrations\/primary\/NNNN_v0x_view\.sql:1 names the admission price columns \(1 read\)/u);
  assert.match(failures([["postgres/migrations/primary/0064_trigger.sql",
    "  IF NEW.server_cost_nanousd IS DISTINCT FROM OLD.server_cost_nanousd THEN\n"]]).join("\n"), /0064_trigger\.sql:1 .* \(2 read\)/u);
  assert.match(failures([["postgres/staged-migrations/primary/NNNN_index.sql",
    "CREATE INDEX telemetry_records_price ON telemetry_records (participant_id, server_pricing_status);\n"]]).join("\n"), /NNNN_index\.sql:1/u);
  // A new column definition, even a proper one, is held to the file allowlist: a new receipt column needs a decision.
  assert.match(failures([["postgres/staged-migrations/primary/NNNN_new_table.sql",
    "CREATE TABLE telemetry_v0x_copy (\n  server_cost_nanousd bigint NOT NULL,\n  id bigint\n);\n"]]).join("\n"),
  /NNNN_new_table\.sql:2 names the admission price columns \(1 ddl\)/u);
  assert.match(failures([["postgres/staged-migrations/primary/NNNN_alter.sql",
    "ALTER TABLE telemetry_records ADD COLUMN server_cost_usd numeric;\n"]]).join("\n"), /NNNN_alter\.sql:1 names the admission price columns \(1 ddl\)/u);
  // A view or function that returns whole rows names no column and is a wildcard read too.
  assert.match(failures([["postgres/staged-migrations/primary/NNNN_all_rows.sql",
    "CREATE VIEW v0x_all AS SELECT *, 1 AS k FROM telemetry_records;\n"]]).join("\n"), /NNNN_all_rows\.sql:1 names the admission price columns \(1 wildcard\)/u);
  assert.match(failures([["postgres/staged-migrations/primary/NNNN_json_rows.sql",
    "CREATE FUNCTION f() RETURNS jsonb LANGUAGE sql AS $$\n  SELECT to_jsonb(c) FROM telemetry_contributions c\n$$;\n"]]).join("\n"), /NNNN_json_rows\.sql:2 names the admission price columns \(1 wildcard\)/u);
  assert.deepEqual(failures([["postgres/staged-migrations/primary/NNNN_other.sql", "CREATE VIEW v AS SELECT * FROM participants;\nALTER TABLE telemetry_records ADD COLUMN extra_note text;\n"]]), []);
  // The 0011 definitions stay under their ceiling, and a read in 0011 is refused.
  assert.match(failures([[POSTGRES_DDL_FILE, `${sources.get(POSTGRES_DDL_FILE)}\nCREATE VIEW w AS SELECT server_cost_usd FROM telemetry_records;\n`]]).join("\n"),
    /has a read mention of an admission price column; role ddl allows only ddl/u);
});

test("negative: every other file kind is held to the allowlist, and ceilings only come down", () => {
  const d1 = "src/telemetry-repository.ts";
  const d1Max = ALLOWED.find(({ file }) => file === d1).max;
  const d1Used = findPriceMentions(d1, sources.get(d1)).length;
  const extra = Array.from({ length: d1Max - d1Used + 1 }, (_, index) => `const more${index} = row.server_cost_usd;`).join("\n");
  assert.match(failures([[d1, `${sources.get(d1)}\n${extra}\n`]]).join("\n"), new RegExp(`has ${d1Max + 1} mention\\(s\\) .*, at most ${d1Max} allowed for role d1-legacy`, "u"));
  assert.match(failures([["src/quota-analysis.ts", `${sources.get("src/quota-analysis.ts")}\n  "server_cost_usd",\n`]]).join("\n"),
    /role d1-legacy allows only read/u);
  assert.match(failures([["scripts/staging-readiness-lib.mjs", `${sources.get("scripts/staging-readiness-lib.mjs")}\nconst q = "SELECT server_cost_usd FROM t";\n`]]).join("\n"),
    /role d1-trigger-mirror allows only inventory/u);
  assert.match(failures([["src/new-reader.ts", "const x = 1; // server_unknown_billable_units\n"]]).join("\n"), /src\/new-reader\.ts:1/u);
  assert.deepEqual(readerViolations(new Map([["src/ok.ts", "const unrelated = 1;\n"]]), []), []);
  assert.match(readerViolations(new Map([["src/bad.ts", "server_cost_usd"]]), []).join("\n"), /src\/bad\.ts:1 names the admission price columns/u);
});

test("negative: the real file walk finds a reader added anywhere under the scanned directories and skips tests and dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "v0x-guard-"));
  try {
    const files = {
      "src/analytics-v2/new-reader.ts": "SELECT server_cost_nanousd FROM telemetry_records\n",
      "cloud-run/routes/new-route.mjs": "export const q = 'SELECT server_pricing_status FROM telemetry_records';\n",
      "scripts/new-tool.mjs": "const c = row.server_price_basis;\n",
      "vendor/k/new-copy.ts": "SELECT c.* FROM telemetry_contributions c\n",
      "ops/cloudflare/new.mjs": "const q = 'server_tier_basis';\n",
      "postgres/staged-migrations/primary/NNNN_x.sql": "CREATE VIEW v AS SELECT server_cost_usd FROM telemetry_records;\n",
      "src/ignored.spec.ts": "SELECT server_cost_nanousd FROM t\n",
      "scripts/ignored.check.mjs": "server_cost_usd\n",
      "src/ignored.test.js": "server_cost_usd\n",
      "src/node_modules/dep/index.js": "server_cost_usd\n",
      "cloud-run/dist/server.mjs": "server_cost_usd\n",
      "migrations/0001_d1.sql": "ALTER TABLE t ADD COLUMN server_cost_usd TEXT;\n",
      "test/outside.spec.ts": "server_cost_usd\n",
      "src/clean.ts": "const ok = 1;\n",
    };
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
    }
    const walked = await collectSources(root);
    assert.deepEqual(sorted(walked.keys()), sorted([
      "src/analytics-v2/new-reader.ts", "cloud-run/routes/new-route.mjs", "scripts/new-tool.mjs", "vendor/k/new-copy.ts",
      "ops/cloudflare/new.mjs", "postgres/staged-migrations/primary/NNNN_x.sql", "src/clean.ts",
    ]));
    const found = readerViolations(walked, []);
    assert.equal(found.length, 6);
    for (const file of ["src/analytics-v2/new-reader.ts", "cloud-run/routes/new-route.mjs", "scripts/new-tool.mjs", "vendor/k/new-copy.ts",
      "ops/cloudflare/new.mjs", "postgres/staged-migrations/primary/NNNN_x.sql"]) {
      assert.ok(found.some((line) => line.startsWith(`${file}:`)), file);
    }
    assert.deepEqual(sorted((await collectAllSql(root)).keys()), ["migrations/0001_d1.sql", "postgres/staged-migrations/primary/NNNN_x.sql"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("negative: a module that ships a reader in the refresh job, or any entry but the origin, is refused", () => {
  const clean = new Map([["server.mjs", new Set(SHIPPED_ALLOWANCE["server.mjs"])], ["analytics-refresh.mjs", new Set()]]);
  assert.deepEqual(shippedViolations(clean), []);
  assert.deepEqual(shippedSlack(clean), []);
  const refresh = new Map(clean).set("analytics-refresh.mjs", new Set(["vendor/analytics-d43c8f92/apps/worker/src/quota-analysis.ts"]));
  assert.deepEqual(shippedViolations(refresh),
    ["analytics-refresh.mjs ships vendor/analytics-d43c8f92/apps/worker/src/quota-analysis.ts, which names an admission price column"]);
  const origin = new Map(clean).set("server.mjs", new Set([...SHIPPED_ALLOWANCE["server.mjs"], "src/new-reader.ts"]));
  assert.deepEqual(shippedViolations(origin), ["server.mjs ships src/new-reader.ts, which names an admission price column"]);
  const added = new Map(clean).set("postgres-maintenance-job.mjs", new Set(["src/telemetry-repository.ts"]));
  assert.equal(shippedViolations(added).length, 1);
  // Shipping fewer readers passes and is reported.
  const shrunk = new Map(clean).set("server.mjs", new Set([ADMISSION]));
  assert.deepEqual(shippedViolations(shrunk), []);
  assert.deepEqual(shippedSlack(shrunk), [
    "server.mjs no longer ships src/quota-analysis.ts; remove it from the allowance",
    "server.mjs no longer ships src/telemetry-repository.ts; remove it from the allowance",
  ]);
});

test("negative: the bundle proof sees a reader that real esbuild output ships, and not one it tree-shakes away", async () => {
  const root = await mkdtemp(join(tmpdir(), "v0x-bundle-"));
  try {
    const files = {
      "cloud-run/build.mjs": [
        'const ENTRY = resolve(ROOT, "server.mjs");',
        'const REFRESH_ENTRY = resolve(ROOT, "analytics-refresh.mjs");',
        'const SHAKEN_ENTRY = resolve(ROOT, "shaken.mjs");',
        "const options = {",
        "  entryPoints: {",
        "    server: ENTRY,",
        '    "analytics-refresh": REFRESH_ENTRY,',
        "    shaken: SHAKEN_ENTRY,",
        "  },",
        '  external: ["pg"],',
        "};",
        "",
      ].join("\n"),
      "cloud-run/server.mjs": 'import { sql } from "../src/clean.ts";\nconsole.log(sql);\n',
      "cloud-run/analytics-refresh.mjs": 'import { read } from "../src/reader.ts";\nconsole.log(read);\n',
      "cloud-run/shaken.mjs": 'import { used } from "../src/mixed.ts";\nconsole.log(used);\n',
      "src/clean.ts": 'export const sql = "SELECT id FROM telemetry_records";\n',
      "src/reader.ts": 'export const read = "SELECT server_cost_nanousd FROM telemetry_records";\n',
      "src/mixed.ts": 'export const used = 1;\nexport const unused = "SELECT server_cost_nanousd FROM telemetry_records";\n',
    };
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
    }
    const shipped = await shippedReaders(root, loadEsbuild());
    assert.deepEqual([...shipped.byFile.get("server.mjs")], []);
    assert.deepEqual([...shipped.byFile.get("analytics-refresh.mjs")], ["src/reader.ts"]);
    assert.deepEqual([...shipped.byFile.get("shaken.mjs")], [], "text esbuild tree-shakes away is not shipped");
    assert.deepEqual(shippedViolations(shipped.byFile, {}), ["analytics-refresh.mjs ships src/reader.ts, which names an admission price column"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  // The marker split: only a path the metafile lists for the output starts a chunk.
  const inputs = new Set(["../src/a.ts", "../src/b.ts"]);
  const same = (path) => path;
  assert.deepEqual([...bundleReaders("// ../src/a.ts\nconst a = 'server_cost_usd';\n// ../src/b.ts\nconst b = 1;\n", inputs, same)], ["../src/a.ts"]);
  assert.deepEqual([...bundleReaders("// ../src/a.ts\nconst a = 1;\n// ../src/b.ts\nconst b = 'server_cost_usd';\n", inputs, same)], ["../src/b.ts"]);
  // Text after an unrecognised marker stays with the previous module: the conservative attribution.
  assert.deepEqual([...bundleReaders("// ../src/a.ts\nconst a = 1;\n// unlisted.ts\nserver_cost_usd\n", inputs, same)], ["../src/a.ts"]);
  // Text before the first recognised marker, or a parser that recognises no marker at all, fails closed.
  assert.deepEqual([...bundleReaders("const x = 'server_cost_usd';\n// ../src/a.ts\nconst a = 1;\n", inputs, same)], [UNATTRIBUTED]);
  assert.deepEqual([...bundleReaders("// unlisted.ts\nconst a = 'server_cost_usd';\n", inputs, same)], [UNATTRIBUTED]);
  assert.deepEqual([...bundleReaders("// ../src/a.ts\nconst a = 1;\n", new Set(), same)], []);
  assert.deepEqual([...bundleReaders("", inputs, same)], []);
});

test("a missing esbuild fails closed with a named code, never a silent pass", () => {
  assert.throws(() => loadEsbuild(join(tmpdir(), "v0x-guard-no-such-root")), { code: "V0X_ESBUILD_UNAVAILABLE" });
  assert.equal(typeof loadEsbuild().build, "function");
});

test("the check is wired into the Worker's complete gate, so a green run proves it ran", async () => {
  const pkg = JSON.parse(await readFile(join(WORKER_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["v0x:admission:check"],
    "node --check ./scripts/v0x-admission-price-readers.mjs && node --check ./scripts/v0x-admission-price-readers.check.mjs && node --test ./scripts/v0x-admission-price-readers.check.mjs");
  assert.match(pkg.scripts.check, /(?:^| && )npm run v0x:admission:check(?: && |$)/u);
});

test("the command line lists the readers and exits 0 on the real tree", () => {
  const checked = spawnSync(process.execPath, [SCRIPT], { cwd: WORKER_ROOT, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /^ok: \d+ file\(s\) name the admission price columns, all allowlisted$/mu);
  const listed = spawnSync(process.execPath, [SCRIPT, "--list"], { cwd: WORKER_ROOT, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^admission +\d+ +src\/postgres-legacy-contribution-admission\.ts +\[\d+ write\] \d+ column\(s\)$/mu);
  assert.match(listed.stdout, /^ships analytics-refresh\.mjs: none$/mu);
  assert.match(listed.stdout, /^reach server\.mjs: 27 module\(s\), 69 import\(s\) lead to src\/quota-analysis\.ts, src\/telemetry-repository\.ts$/mu);
  assert.match(listed.stdout, /^ships server\.mjs: .*src\/postgres-legacy-contribution-admission\.ts/mu);
});
