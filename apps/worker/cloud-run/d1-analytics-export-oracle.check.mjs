import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildD1AnalyticsExportOracle } from "./d1-analytics-export-oracle.build.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PINNED_NOW_MS = Date.parse("2026-09-26T06:00:00.000Z");
const SYNTHETIC_SOURCE = "synthetic-oracle-cli-source";
const SYNTHETIC_NAMESPACE = "synthetic-oracle-cli-namespace";
const SHA = (seed) => createHash("sha256").update(seed).digest("hex");

// The CLI imports the Worker's TypeScript modules, so it runs as a bundle,
// built by the operator-only build script (never by build.mjs, which is the
// image build). The bundle goes to a private directory under the ignored
// dist/, so its externals resolve from this package's node_modules exactly as
// dist/ does.
let bundleDirectory;
let cli;
let bundlePath;
let createdDist = false;
test.before(async () => {
  createdDist = await mkdir(join(ROOT, "dist"), { recursive: true }) !== undefined;
  bundleDirectory = await realpath(await mkdtemp(join(ROOT, "dist", ".d1-analytics-export-oracle-check-")));
  bundlePath = await buildD1AnalyticsExportOracle({ outdir: bundleDirectory });
  assert.equal(bundlePath, join(bundleDirectory, "d1-analytics-export-oracle.mjs"));
  cli = await import(pathToFileURL(bundlePath).href);
});
test.after(async () => {
  await rm(bundleDirectory, { recursive: true, force: true });
  // Leave dist/ as found: remove it only when this check created it.
  if (createdDist) await rmdir(join(ROOT, "dist")).catch(() => {});
});

function windowDays() {
  const today = Date.parse(new Date(PINNED_NOW_MS).toISOString().slice(0, 10));
  return Array.from({ length: 70 }, (_, index) => new Date(today - (69 - index) * 86_400_000).toISOString().slice(0, 10));
}

function syntheticOracle(moduleDigest) {
  const days = windowDays();
  return {
    schema: "analytics-history-oracle-v2", pinnedNowMs: PINNED_NOW_MS,
    fenceAuthority: { sourceId: SYNTHETIC_SOURCE, sourceNamespace: SYNTHETIC_NAMESPACE, publicAuthorityEpoch: 4,
      policyRevision: 1, collectionRevision: 3, graphInvalidationEpoch: 2, sourceEpoch: 9, sequence: 9 },
    fenceCounters: { sourceId: SYNTHETIC_SOURCE, v1Namespace: SYNTHETIC_NAMESPACE, v11Namespace: SYNTHETIC_NAMESPACE,
      v12Runtime: { state: "active", policyRevision: 1 }, sourceAuthorityEpoch: 4, policyRevision: 1,
      collectionControls: { revision: 3, enrollment: true, uploadRegistration: true, processing: true,
        publication: true, controlState: "operational" },
      mutationEpoch: 9, graphInvalidationEpoch: 2, bootstrap: { completed: true, policyVersion: "community-public-sources-v1" },
      journal: { maxSequence: 9, rows: 9, sha256: SHA("journal") }, sourceTerminalEpoch: 0, deliveredTerminalEpoch: 0,
      ownerRevisions: { rows: 2, sha256: SHA("owners") }, inputVersions: { rows: 2, sha256: SHA("inputs") },
      ownerLinks: { rows: 2, sha256: SHA("links") } },
    quiescence: { queueRows: 0, staleHeadIdle: true, cursorSequence: 9, journalMax: 9, deliveredTerminal: 0,
      sourceTerminal: 0, pendingErasureJobs: 0, cacheRetentionIncompleteDays: 0 },
    liveCohort: { members: 2, sha256: SHA("cohort") },
    importSelection: { daily: [{ day: days[69], revision: 1, sha256: SHA("daily") }],
      modelDays: [{ day: days[68], sha256: SHA("model") }], preview: { sha256: SHA("preview") } },
    dailyForced: [{ day: days[69], cohortDigest: SHA("cohort-digest"), recomputedSha256: SHA("daily"),
      importedSha256: SHA("daily"), d1Drift: false }],
    graphForced: { modelDays: days.map((day) => ({ day, recomputedSha256: day === days[68] ? SHA("model") : null })),
      previewSha256: SHA("preview") },
    cacheRetention: { fromDay: null, resumeSeriesSha256: SHA("series"), rebuildSeriesSha256: SHA("series"),
      rebuildTableSha256: Object.fromEntries(["analytics_cache_retention_day_marks", "analytics_cache_retention_day_progress",
        "analytics_cache_retention_day_values", "analytics_cache_retention_day_bands", "analytics_cache_retention_day_carry"]
        .map((table) => [table, SHA(table)])) },
    foldHistory: [{ value: "disabled", fromMs: 1, untilMs: null }],
    moduleDigest,
  };
}

async function scratchSet({ mode = 0o600, inventory = {}, sources = 1 } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-oracle-cli-")));
  const paths = {};
  const d1 = {};
  for (const name of ["ingestion", "analytics", "ledger"]) {
    paths[name] = join(directory, `${name}.sqlite`);
    const database = new DatabaseSync(paths[name]);
    if (name === "analytics") {
      database.exec("CREATE TABLE analytics_runtime_sources(source_id TEXT PRIMARY KEY,source_namespace TEXT NOT NULL,contract_version INTEGER NOT NULL)");
      for (let index = 0; index < sources; index += 1) {
        database.prepare("INSERT INTO analytics_runtime_sources VALUES(?,?,1)")
          .run(index === 0 ? SYNTHETIC_SOURCE : `${SYNTHETIC_SOURCE}-${index}`, SYNTHETIC_NAMESPACE);
      }
    }
    database.close();
    await chmod(paths[name], mode);
    // The inventory seals each export; the copies start byte-identical.
    d1[name] = { timeTravelBookmark: `synthetic-bookmark-${name}`, sealedSha256: SHA(await readFile(paths[name])) };
  }
  paths.inventory = join(directory, "inventory.json");
  await writeFile(paths.inventory, JSON.stringify({ schema: "analytics-cutover-inventory-v2",
    drain: { fencedAtMs: PINNED_NOW_MS - 60_000, quiescentAtMs: PINNED_NOW_MS },
    cacheRetention: { fromDay: "2026-09-01" }, foldHistory: [{ value: "disabled", fromMs: 1, untilMs: null }], d1,
    ...inventory }));
  paths.out = join(directory, "oracle.json");
  return { directory, paths };
}

function argv(paths, overrides = {}) {
  const values = { ...paths, pinnedNowMs: String(PINNED_NOW_MS), ...overrides };
  return ["--ingestion", values.ingestion, "--analytics", values.analytics, "--ledger", values.ledger,
    "--pinned-now-ms", values.pinnedNowMs, "--inventory", values.inventory, "--out", values.out];
}

function assertContentFreeLogs(logs, directory) {
  for (const entry of logs) {
    for (const [key, value] of Object.entries(entry)) {
      assert.match(key, /^[a-zA-Z][a-zA-Z0-9]*$/u);
      if (typeof value === "string") assert.match(value, /^[a-z][a-z0-9_]*$/iu, "log strings are closed codes");
      else if (Array.isArray(value)) for (const item of value) assert.match(item, /^[a-z_]+$/u);
      else assert.ok(Number.isSafeInteger(value), "log values are counts");
    }
    const text = JSON.stringify(entry);
    assert.doesNotMatch(text, new RegExp(directory.replaceAll("/", "\\/"), "u"));
    assert.ok(!text.includes(SYNTHETIC_SOURCE) && !text.includes(SYNTHETIC_NAMESPACE));
  }
}

test("writes the validated oracle at 0600 with its sha256, atomically, and logs counts only", async () => {
  const { directory, paths } = await scratchSet();
  try {
    const logs = [];
    let received;
    let bindingProbe;
    const code = await cli.runD1AnalyticsExportOracleCli({ argv: argv(paths), log: (entry) => logs.push(entry),
      runOracle: async (input) => {
        received = input;
        bindingProbe = { clocks: [], ledgerWrite: null, ingestionWrite: false };
        for (const database of [input.ingestion, input.analytics, input.ledger]) {
          bindingProbe.clocks.push(await database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").first("now"));
        }
        await input.ledger.prepare("CREATE TABLE ledger_write_probe(a)").run()
          .catch((error) => { bindingProbe.ledgerWrite = error.code; });
        await input.ingestion.prepare("CREATE TABLE ingestion_write_probe(a)").run();
        bindingProbe.ingestionWrite = true;
        input.onStep("fence", { journalRows: 9, secret: "not-a-count" });
        return syntheticOracle(input.moduleDigest);
      } });
    assert.equal(code, 0);
    assert.equal(received.pinnedNowMs, PINNED_NOW_MS);
    assert.equal(received.sourceId, SYNTHETIC_SOURCE);
    assert.equal(received.sourceNamespace, SYNTHETIC_NAMESPACE);
    assert.equal(received.cacheRetentionFromDay, "2026-09-01");
    assert.deepEqual(received.foldHistory, [{ value: "disabled", fromMs: 1, untilMs: null }]);
    assert.equal(received.moduleDigest, SHA(await readFile(bundlePath)), "moduleDigest covers the bundled inputs");
    // Every binding read SQLite's clock at the drain instant; the ledger was read-only.
    assert.deepEqual(bindingProbe, { clocks: Array(3).fill(new Date(PINNED_NOW_MS).toISOString()),
      ledgerWrite: "ADAPTER_READ_ONLY", ingestionWrite: true });
    const bytes = await readFile(paths.out);
    assert.equal((await lstat(paths.out)).mode & 0o777, 0o600);
    assert.equal((await lstat(`${paths.out}.sha256`)).mode & 0o777, 0o600);
    assert.equal(await readFile(`${paths.out}.sha256`, "utf8"), `${SHA(bytes)}\n`);
    assert.deepEqual(JSON.parse(bytes), syntheticOracle(received.moduleDigest));
    assert.deepEqual((await readdir(directory)).filter((name) => name.includes("partial")), []);
    assert.deepEqual(logs.map((entry) => entry.status ?? entry.step), ["started", "fence", "ok"]);
    assert.equal(logs[1].journalRows, 9);
    assert.equal(Object.hasOwn(logs[1], "secret"), false);
    assertContentFreeLogs(logs, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failure leaves no output, no sha file and no partial file, and logs only a closed code", async () => {
  const { directory, paths } = await scratchSet();
  try {
    const refused = [];
    const quiescence = Object.assign(new Error("ANALYTICS_EXPORT_NOT_QUIESCENT"),
      { code: "ANALYTICS_EXPORT_NOT_QUIESCENT", reasons: ["queue_rows", "not_a_reason"] });
    assert.equal(await cli.runD1AnalyticsExportOracleCli({ argv: argv(paths), log: (entry) => refused.push(entry),
      runOracle: async () => { throw quiescence; } }), 1);
    assert.deepEqual(refused.at(-1), { event: "d1_analytics_export_oracle", status: "refused",
      code: "ANALYTICS_EXPORT_NOT_QUIESCENT", reasons: ["queue_rows"] });
    const failed = [];
    assert.equal(await cli.runD1AnalyticsExportOracleCli({ argv: argv(paths), log: (entry) => failed.push(entry),
      runOracle: async () => { throw new Error(`no such table at ${paths.analytics} for ${SYNTHETIC_SOURCE}`); } }), 1);
    assert.deepEqual(failed.at(-1), { event: "d1_analytics_export_oracle", status: "failed", code: "ORACLE_FAILED" });
    const invalid = [];
    assert.equal(await cli.runD1AnalyticsExportOracleCli({ argv: argv(paths), log: (entry) => invalid.push(entry),
      runOracle: async (input) => ({ ...syntheticOracle(input.moduleDigest), participantId: "synthetic" }) }), 1);
    assert.equal(invalid.at(-1).code, "ANALYTICS_HISTORY_ORACLE_INVALID");
    for (const logs of [refused, failed, invalid]) assertContentFreeLogs(logs, directory);
    assert.equal(await lstat(paths.out).catch(() => null), null);
    assert.equal(await lstat(`${paths.out}.sha256`).catch(() => null), null);
    assert.deepEqual((await readdir(directory)).filter((name) => name.includes("partial")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("never replaces an existing output", async () => {
  const { directory, paths } = await scratchSet();
  try {
    await writeFile(paths.out, "operator-owned");
    const logs = [];
    let ran = false;
    assert.equal(await cli.runD1AnalyticsExportOracleCli({ argv: argv(paths), log: (entry) => logs.push(entry),
      runOracle: async (input) => { ran = true; return syntheticOracle(input.moduleDigest); } }), 1);
    assert.equal(ran, false);
    assert.equal(logs.at(-1).code, "ORACLE_OUTPUT_EXISTS");
    assert.equal(await readFile(paths.out, "utf8"), "operator-owned");
    await rm(paths.out);
    await writeFile(`${paths.out}.sha256`, "operator-owned");
    assert.equal(await cli.runD1AnalyticsExportOracleCli({ argv: argv(paths), log: (entry) => logs.push(entry),
      runOracle: async (input) => syntheticOracle(input.moduleDigest) }), 1);
    assert.equal(logs.at(-1).code, "ORACLE_OUTPUT_EXISTS");
    assert.equal(await lstat(paths.out).catch(() => null), null, "no output without its sha file");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses sealed exports, links and anything but private scratch copies", async () => {
  const sealed = await scratchSet({ mode: 0o400 });
  const shared = await scratchSet({ mode: 0o640 });
  const linked = await scratchSet();
  try {
    for (const { paths } of [sealed, shared]) {
      const logs = [];
      assert.equal(await cli.runD1AnalyticsExportOracleCli({ argv: argv(paths), log: (entry) => logs.push(entry),
        runOracle: async () => assert.fail("must not run") }), 1);
      assert.equal(logs.at(-1).code, "ORACLE_INPUT_NOT_SCRATCH");
    }
    const alias = join(linked.directory, "alias.sqlite");
    await symlink(linked.paths.ledger, alias);
    const logs = [];
    assert.equal(await cli.runD1AnalyticsExportOracleCli({ argv: argv(linked.paths, { ledger: alias }),
      log: (entry) => logs.push(entry), runOracle: async () => assert.fail("must not run") }), 1);
    assert.equal(logs.at(-1).code, "ORACLE_INPUT_NOT_SCRATCH");
  } finally {
    for (const set of [sealed, shared, linked]) await rm(set.directory, { recursive: true, force: true });
  }
});

test("refuses malformed arguments and an inventory for another drain", async () => {
  const { directory, paths } = await scratchSet();
  try {
    const run = async (args) => {
      const logs = [];
      const code = await cli.runD1AnalyticsExportOracleCli({ argv: args, log: (entry) => logs.push(entry),
        runOracle: async () => assert.fail("must not run") });
      assert.equal(code, 1);
      return logs.at(-1).code;
    };
    const valid = argv(paths);
    assert.equal(await run(valid.slice(0, -2)), "ORACLE_ARGUMENT_INVALID");
    assert.equal(await run([...valid.slice(0, -2), "--output", paths.out]), "ORACLE_ARGUMENT_INVALID");
    assert.equal(await run([...valid.slice(0, 2), ...valid.slice(0, 2), ...valid.slice(4)]), "ORACLE_ARGUMENT_INVALID");
    assert.equal(await run(argv(paths, { pinnedNowMs: "1.5" })), "ORACLE_ARGUMENT_INVALID");
    assert.equal(await run(argv(paths, { out: "oracle.json" })), "ORACLE_ARGUMENT_INVALID");
    assert.equal(await run(argv(paths, { ledger: paths.analytics })), "ORACLE_ARGUMENT_INVALID");
    assert.equal(await run(argv(paths, { pinnedNowMs: String(PINNED_NOW_MS + 1) })), "ORACLE_INVENTORY_INVALID");
    for (const inventory of [{ schema: "analytics-cutover-inventory-v1" }, { cacheRetention: { fromDay: "2026-02-30" } },
      { foldHistory: [{ value: "enabled", fromMs: 1, untilMs: null, host: "x" }] }, { foldHistory: undefined },
      { d1: undefined }, { d1: { ingestion: { sealedSha256: SHA("x") }, analytics: { sealedSha256: SHA("y") } } },
      { d1: { ingestion: { sealedSha256: "X".repeat(64) }, analytics: { sealedSha256: SHA("y") },
        ledger: { sealedSha256: SHA("z") } } }]) {
      const set = await scratchSet({ inventory });
      try {
        assert.equal(await run(argv(set.paths)), "ORACLE_INVENTORY_INVALID");
      } finally {
        await rm(set.directory, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a scratch copy that differs from its sealed export, before opening anything", async () => {
  const { directory, paths } = await scratchSet();
  try {
    // A copy an earlier oracle run already wrote to (or any other edit).
    const database = new DatabaseSync(paths.analytics);
    database.exec("CREATE TABLE touched_by_an_earlier_run(a)");
    database.close();
    const logs = [];
    let opened = 0;
    assert.equal(await cli.runD1AnalyticsExportOracleCli({ argv: argv(paths), log: (entry) => logs.push(entry),
      openDatabase: () => { opened += 1; throw new Error("must not open"); },
      runOracle: async () => assert.fail("must not run") }), 1);
    assert.equal(opened, 0);
    assert.deepEqual(logs.at(-1), { event: "d1_analytics_export_oracle", status: "failed", code: "ORACLE_INPUT_SEAL_MISMATCH" });
    assert.equal(await lstat(paths.out).catch(() => null), null);
    assertContentFreeLogs(logs, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses an analytics export that serves more than one source", async () => {
  const { directory, paths } = await scratchSet({ sources: 2 });
  try {
    const logs = [];
    assert.equal(await cli.runD1AnalyticsExportOracleCli({ argv: argv(paths), log: (entry) => logs.push(entry),
      runOracle: async () => assert.fail("must not run") }), 1);
    assert.equal(logs.at(-1).code, "ORACLE_SOURCE_IDENTITY_INVALID");
    assertContentFreeLogs(logs, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failure writing the sha256 file after the output is linked removes the output", async () => {
  const { directory, paths } = await scratchSet();
  try {
    const logs = [];
    assert.equal(await cli.runD1AnalyticsExportOracleCli({ argv: argv(paths), log: (entry) => logs.push(entry),
      runOracle: async (input) => {
        // Appears after the pre-check, so the output is linked and then the
        // sha256 link fails: the CLI must remove the output it created and
        // leave this operator-owned file alone.
        await writeFile(`${paths.out}.sha256`, "operator-owned");
        return syntheticOracle(input.moduleDigest);
      } }), 1);
    assert.equal(logs.at(-1).code, "ORACLE_OUTPUT_EXISTS");
    assert.equal(await lstat(paths.out).catch(() => null), null, "no output without its sha file");
    assert.equal(await readFile(`${paths.out}.sha256`, "utf8"), "operator-owned");
    assert.deepEqual((await readdir(directory)).filter((name) => name.includes("partial")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unsupported node:sqlite fails with the adapter's closed code and writes nothing", async () => {
  const { directory, paths } = await scratchSet();
  const original = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "setAuthorizer");
  try {
    delete DatabaseSync.prototype.setAuthorizer;
    const logs = [];
    assert.equal(await cli.runD1AnalyticsExportOracleCli({ argv: argv(paths), log: (entry) => logs.push(entry),
      runOracle: async () => assert.fail("must not run") }), 1);
    assert.equal(logs.at(-1).code, "ADAPTER_RUNTIME_UNSUPPORTED");
    assert.equal(await lstat(paths.out).catch(() => null), null);
  } finally {
    Object.defineProperty(DatabaseSync.prototype, "setAuthorizer", original);
    await rm(directory, { recursive: true, force: true });
  }
});

test("the operator bundle never enters the Cloud Run image build or its context", async () => {
  const operatorFiles = ["d1-analytics-export-oracle", "sealed-sqlite-d1-adapter"];
  const isOperatorFile = (value) => operatorFiles.some((name) => value.includes(name));
  // The image build runs build.mjs's default entries over the audited context.
  const buildSource = await readFile(join(ROOT, "build.mjs"), "utf8");
  const entryBlock = /entryPoints:\s*\{([^}]*)\}/u.exec(buildSource)?.[1];
  assert.ok(entryBlock?.includes("server"), "build.mjs names its image entry points");
  assert.ok(!isOperatorFile(entryBlock), "build.mjs must not bundle the operator oracle; use d1-analytics-export-oracle.build.mjs");
  for (const [, name, file] of buildSource.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*resolve\(ROOT,\s*"([^"]+)"\)/gu)) {
    if (isOperatorFile(file)) assert.ok(!new RegExp(`\\b${name}\\b`, "u").test(entryBlock), name);
  }
  assert.ok(!isOperatorFile(await readFile(join(ROOT, "Dockerfile"), "utf8")));
  const allowlist = async (script) => [...(await readFile(resolve(ROOT, "../scripts", script), "utf8"))
    .matchAll(/source:\s*"([^"]+)"/gu)].map((match) => match[1]);
  const sources = await allowlist("cloud-run-build-context.mjs");
  assert.ok(sources.includes("cloud-run/server.mjs"), "the build context lists individual cloud-run files");
  assert.ok(!sources.includes("cloud-run"), "cloud-run is never copied whole");
  assert.deepEqual(sources.filter(isOperatorFile), []);
  const testSources = await allowlist("gcp-test-build-context.mjs");
  assert.ok(testSources.length > 0 && !testSources.includes("cloud-run"));
  assert.deepEqual(testSources.filter(isOperatorFile), []);
});
