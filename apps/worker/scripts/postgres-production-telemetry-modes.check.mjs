import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CutoverSourceError, readCutoverSeal } from "./cutover-source-seal.mjs";
import { POSTGRES_FASTPATH_TRANSPORT_TABLE_SPECS } from "./postgres-fastpath-identity-copy.mjs";
import { POSTGRES_INGESTION_JOURNAL_SOURCE_COLUMNS } from "./postgres-ingestion-journal-transfer.mjs";
import { POSTGRES_LEGACY_ADMISSION_TRANSFER_LAYOUT } from "./postgres-legacy-admission-transfer.mjs";
import {
  PRODUCTION_RETAINED_RELATIONS,
  PRODUCTION_STAGING_RELATIONS,
  TELEMETRY_PRODUCTION_DEFINITIONS,
  TELEMETRY_PRODUCTION_DISPOSITIONS,
  TELEMETRY_PRODUCTION_RUNNERS,
  TELEMETRY_PRODUCTION_STAGES,
  TELEMETRY_PRODUCTION_TRIGGER_POLICY,
  TYPED_LEGACY_SCHEMA_MARKERS,
  telemetryProductionPolicySha256,
} from "./postgres-production-telemetry-modes.mjs";
import {
  TELEMETRY_PRODUCTION_ERROR_CODES,
  TELEMETRY_PRODUCTION_MAX_PAGE_BYTES,
  TELEMETRY_PRODUCTION_MAX_PAGE_ROWS,
  TelemetryProductionError,
  assertSealedClosure,
  canonicalSourceValue,
  col,
  defineTable,
  specTriggerPolicy,
} from "./postgres-production-telemetry-engine.mjs";
import { POSTGRES_TYPED_LEGACY_TRANSFER_LAYOUT } from "./postgres-typed-legacy-transfer.mjs";
import { POSTGRES_V12_TRANSFER_LAYOUT } from "./postgres-v12-transfer.mjs";
import { IDENTITY_AUTHORITY_FROZEN_ORDER } from "./postgres-identity-authority-transfer.mjs";
import { PostgresTransferTargetError, TRANSFER_STAGES } from "./postgres-transfer-target.mjs";
import { forgeVariantSeal, headCommit, outputPathsOf, prepareSealWorld, sealWorld } from "../postgres-test/fixtures/w2-seal/seal-harness.mjs";
import { Q1_INGESTION_DUMP } from "../postgres-test/fixtures/w2-seal/synthetic-sources.mjs";

// D-PT5A contract checks without a database: the frozen stage plan, the
// dispositions the PT-8-lite coverage module consumes, the specs' closure over
// the d43c8f92 schema and their equality with the reviewed rehearsal layouts,
// the value codec, and every sealed-source refusal (each must fire before the
// importer touches its target: a handle that is not a registered PT-1 handle
// is only reached once every sealed-source check has passed). The PostgreSQL
// acceptance is postgres-test/postgres-production-telemetry-modes.spec.mjs.
// Run: node --test ./scripts/postgres-production-telemetry-modes.check.mjs

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A reviewed change to any stage's tables, columns, closure, trigger policy or
// dispositions must update this pin.
const POLICY_SHA256 = "82998111387fa2df72b8615f1285590a9d4d8ae0056b054469d0ce025417632f";
const EXPECTED_STAGE_TABLES = Object.freeze({
  "telemetry-v1-v11": ["telemetry_v1_chunks", "telemetry_v1_records", "telemetry_v11_day_manifests", "telemetry_v11_chunks",
    "telemetry_v11_records", "telemetry_v11_domain_predecessors", "telemetry_v11_domains", "telemetry_v11_domain_days",
    "telemetry_v11_domain_heads", "storage_v11_append_transitions"],
  "typed-legacy": ["typed_telemetry_dictionary", "typed_telemetry_namespaces", "typed_telemetry_owners", "typed_v1_owner_memberships",
    "typed_v11_owner_memberships", "typed_telemetry_devices", "typed_telemetry_manifests", "typed_telemetry_identifiers",
    "typed_telemetry_attributions", "typed_telemetry_quota_dimensions", "typed_telemetry_chunks", "typed_telemetry_records",
    "typed_telemetry_usage", "typed_telemetry_quota", "typed_telemetry_session_tools", "typed_telemetry_schema",
    "typed_v1_analytical_schema"],
  "legacy-admission": ["typed_v1_admission_state", "typed_v11_admission_state", "typed_v1_chunk_allocations",
    "typed_v11_chunk_allocations", "typed_v1_record_admissions", "typed_v1_preservation_proofs", "typed_v11_manifest_memberships",
    "typed_v11_record_proofs", "typed_v1_event_sources", "storage_v11_event_sources", "typed_v1_authority_requests"],
  "header-promotion": [],
  "telemetry-v12": ["telemetry_v12_runtime", "telemetry_v12_day_manifests", "telemetry_v12_chunks", "telemetry_v12_attributions",
    "telemetry_v12_records", "telemetry_v12_usage", "telemetry_v12_quota", "telemetry_v12_session_tools",
    "telemetry_v12_domain_predecessors", "telemetry_v12_domains", "telemetry_v12_domain_days", "telemetry_v12_domain_heads"],
  "v12-event-sources": ["storage_v12_event_sources"],
  "usage-correction": ["telemetry_usage_correction_runtime", "telemetry_usage_correction_history",
    "telemetry_usage_correction_facts", "telemetry_usage_correction_cas_guard"],
  "ingestion-journal": ["storage_source_state", "storage_ingestion_changes"],
});
const DISPOSITION = /^(?:(?:imported|mapped|claimed-by):[a-z][a-z0-9]*(?:-[a-z0-9]+)*|verified-equal|must-be-empty|schema-marker|source-machinery|runtime-reset|edge-retained|not-transferred-expiring|target-missing)$/u;

let world;
let seal;
let manifestPath;
let q1;

const isCode = code => error => (error instanceof TelemetryProductionError || error instanceof PostgresTransferTargetError
  || error instanceof CutoverSourceError) && error.code === code;

before(async () => {
  world = await prepareSealWorld({ commit: headCommit(WORKER_ROOT) });
  const run = await sealWorld(world);
  const result = await run.run();
  manifestPath = outputPathsOf(run.out).manifest;
  seal = await readCutoverSeal({ manifestPath, expectedSealId: result.sealId });
  const dump = JSON.parse(await readFile(Q1_INGESTION_DUMP, "utf8"));
  q1 = new DatabaseSync(":memory:");
  for (const entry of dump.schema.filter(item => item.type === "table")) q1.exec(entry.sql);
  q1.dump = dump;
});

after(async () => {
  q1?.close();
  await world?.dispose();
});

/** DROP TRIGGER statements for every trigger of the named sealed tables (the D1 guards would refuse the forgery). */
function dropTriggers(...tables) {
  const database = new DatabaseSync(seal.sources.ingestion.path, { readOnly: true });
  try {
    return database.prepare(`SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN (${tables.map(() => "?").join(",")})`)
      .all(...tables).map(row => `DROP TRIGGER IF EXISTS "${row.name}";`).join("\n");
  } finally {
    database.close();
  }
}

function sealed(sql) {
  const database = new DatabaseSync(seal.sources.ingestion.path, { readOnly: true });
  try {
    return database.prepare(sql).get();
  } finally {
    database.close();
  }
}

const PREFIX = "PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;";

test("the eight stages, their order, runners and policy are frozen and pinned", () => {
  assert.deepEqual([...TELEMETRY_PRODUCTION_STAGES], ["telemetry-v1-v11", "typed-legacy", "legacy-admission",
    "header-promotion", "telemetry-v12", "v12-event-sources", "usage-correction", "ingestion-journal"]);
  const positions = TELEMETRY_PRODUCTION_STAGES.map(stage => TRANSFER_STAGES.indexOf(stage));
  assert.ok(positions.every(position => position >= 0), "every stage is a PT-1 stage");
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), "PT-1's stage order is kept");
  for (const stage of TELEMETRY_PRODUCTION_STAGES) {
    const definition = TELEMETRY_PRODUCTION_DEFINITIONS[stage];
    assert.equal(typeof TELEMETRY_PRODUCTION_RUNNERS[stage], "function", stage);
    assert.equal(definition.stage, stage);
    assert.ok(definition.prerequisites.includes("identity-authority"), `${stage} refuses before PT-3 completes`);
    for (const prerequisite of definition.prerequisites) {
      assert.ok(TRANSFER_STAGES.indexOf(prerequisite) < TRANSFER_STAGES.indexOf(stage), `${stage} after ${prerequisite}`);
    }
    assert.match(definition.policySha256, /^[0-9a-f]{64}$/u);
    assert.ok(Object.isFrozen(definition) && Object.isFrozen(definition.items));
  }
  assert.equal(telemetryProductionPolicySha256(), POLICY_SHA256);
  // No stage creates, mirrors, drops or retains a relation in tibotattle_transfer.
  assert.deepEqual(PRODUCTION_STAGING_RELATIONS, []);
  assert.deepEqual(PRODUCTION_RETAINED_RELATIONS, []);
  assert.throws(() => PRODUCTION_STAGING_RELATIONS.push("x"), TypeError);
});

test("the dispositions are one per owned table, exactly the PT-8-lite design's 57 and valid PT-1 tokens", () => {
  assert.equal(TELEMETRY_PRODUCTION_DISPOSITIONS.length, 57);
  const byStage = {};
  for (const item of TELEMETRY_PRODUCTION_DISPOSITIONS) {
    assert.equal(item.role, "ingestion");
    assert.match(item.token, DISPOSITION, `${item.table} token`);
    (byStage[item.stage] ??= []).push(item.table);
  }
  for (const [stage, tables] of Object.entries(EXPECTED_STAGE_TABLES)) {
    assert.deepEqual([...(byStage[stage] ?? [])].sort(), [...tables].sort(), stage);
  }
  const tables = TELEMETRY_PRODUCTION_DISPOSITIONS.map(item => item.table);
  assert.equal(new Set(tables).size, tables.length, "one disposition per sealed table");
  // PT-3 owns these; D-PT5A never does (telemetry_v12_device_capabilities is imported by PT-3).
  for (const table of IDENTITY_AUTHORITY_FROZEN_ORDER) assert.equal(tables.includes(table), false, table);
  for (const table of ["telemetry_v12_device_capabilities", "accountless_v12_device_authorizations", "device_upload_authorizations",
    "pending_quarantine_objects", "storage_owner_revisions", "storage_legacy_event_sources"]) {
    assert.equal(tables.includes(table), false, table);
  }
  const tokens = Object.fromEntries(TELEMETRY_PRODUCTION_DISPOSITIONS.map(item => [item.table, item.token]));
  assert.equal(tokens.typed_v1_owner_memberships, "mapped:typed-legacy");
  assert.equal(tokens.typed_telemetry_schema, "schema-marker");
  assert.equal(tokens.typed_v1_authority_requests, "must-be-empty");
  assert.equal(tokens.telemetry_usage_correction_cas_guard, "must-be-empty");
  assert.equal(tokens.telemetry_v12_runtime, "mapped:telemetry-v12");
  assert.equal(tokens.storage_ingestion_changes, "imported:ingestion-journal");
  // Mapped: a different PostgreSQL table (or column) than the sealed one; everything else is imported.
  assert.deepEqual(TELEMETRY_PRODUCTION_DISPOSITIONS.filter(item => item.token.startsWith("mapped:")).map(item => item.table).sort(), [
    "telemetry_usage_correction_runtime", "telemetry_v12_attributions", "telemetry_v12_quota", "telemetry_v12_records",
    "telemetry_v12_runtime", "telemetry_v12_session_tools", "telemetry_v12_usage", "typed_v11_owner_memberships",
    "typed_v1_owner_memberships"]);
  for (const item of TELEMETRY_PRODUCTION_DISPOSITIONS.filter(entry => entry.token.startsWith("imported:"))) {
    assert.equal(item.target, item.table, `${item.table} keeps its name`);
  }
});

test("every spec is closed over the d43c8f92 schema and every sealed column is mapped or a reviewed omission", () => {
  const tables = new Set(q1.dump.schema.filter(item => item.type === "table").map(item => item.name));
  for (const stage of TELEMETRY_PRODUCTION_STAGES) {
    for (const item of TELEMETRY_PRODUCTION_DEFINITIONS[stage].items) {
      if (item.kind !== "table") continue;
      const spec = item.spec;
      assert.ok(tables.has(spec.sealedTable), `${spec.sealedTable} is a sealed table`);
      for (const entry of spec.closure) assertSealedClosure(q1, entry);
      assert.ok(spec.columns.length > 0 && spec.key.length > 0);
      assert.equal(spec.columns.filter(column => column.sealed === null && column.sql === null).length, 0);
      for (const key of spec.key) assert.ok(spec.columns.some(column => column.name === key), `${spec.name} key ${key}`);
    }
  }
  for (const table of Object.keys(TYPED_LEGACY_SCHEMA_MARKERS)) assert.ok(tables.has(table), table);
  // The reviewed omissions and what the sealed tables hold: D1's generated columns are not columns.
  const generated = q1.prepare("PRAGMA table_xinfo(typed_v11_record_proofs)").all().filter(column => Number(column.hidden) !== 0)
    .map(column => column.name).sort();
  assert.deepEqual(generated, ["legacy_occurrence_id", "occurrence_id", "stream"]);
});

const TYPE_ALIASES = Object.freeze({ f64: "real", ts: "instant", date: "day", int: "i64", longtext: "text" });
const canonicalType = type => TYPE_ALIASES[type] ?? type;
// The admission rehearsal reads D1's day and instant strings as text; the production specs validate them.
const textLike = ([name, type]) => [name, type === "day" || type === "instant" ? "text" : type];

function layoutOf(spec) {
  return spec.columns.map(column => [column.name, canonicalType(column.type)]);
}

function specByName(name) {
  for (const stage of TELEMETRY_PRODUCTION_STAGES) {
    for (const item of TELEMETRY_PRODUCTION_DEFINITIONS[stage].items) if (item.kind === "table" && item.spec.name === name) return item.spec;
  }
  return assert.fail(`no spec ${name}`);
}

test("the specs equal the reviewed rehearsal layouts: typed-legacy, admission, v1.2, journal and T-1's transport", () => {
  // typed-legacy: every typed table's columns, order, key and types.
  for (const rehearsal of POSTGRES_TYPED_LEGACY_TRANSFER_LAYOUT) {
    if (rehearsal.name === "typed_telemetry_owner_memberships") continue;
    const spec = specByName(rehearsal.name);
    assert.deepEqual(layoutOf(spec), rehearsal.columns.map((name, index) => [name, canonicalType(rehearsal.types[index])]), rehearsal.name);
    assert.deepEqual([...spec.key], [...rehearsal.primaryKey], `${rehearsal.name} key`);
  }
  const memberships = POSTGRES_TYPED_LEGACY_TRANSFER_LAYOUT.find(entry => entry.name === "typed_telemetry_owner_memberships");
  for (const name of ["typed_v1_owner_memberships", "typed_v11_owner_memberships"]) {
    assert.deepEqual(layoutOf(specByName(name)), memberships.columns.map((column, index) => [column, canonicalType(memberships.types[index])]));
    assert.deepEqual([...specByName(name).key], [...memberships.primaryKey]);
  }
  // legacy admission: the ten lineage tables.
  for (const rehearsal of POSTGRES_LEGACY_ADMISSION_TRANSFER_LAYOUT) {
    const spec = specByName(rehearsal.name);
    assert.deepEqual(layoutOf(spec).map(textLike), rehearsal.columns.map((name, index) => textLike([name, canonicalType(rehearsal.types[index])])),
      rehearsal.name);
    assert.deepEqual([...spec.key], [...rehearsal.primaryKey], `${rehearsal.name} key`);
  }
  // T-2: every owned v1.2 table (the identity-side tables belong to PT-3).
  const owned = new Set(EXPECTED_STAGE_TABLES["telemetry-v12"]);
  for (const rehearsal of POSTGRES_V12_TRANSFER_LAYOUT) {
    if (!owned.has(rehearsal.name)) continue;
    const spec = specByName(rehearsal.name);
    assert.equal(spec.target, rehearsal.target, rehearsal.name);
    assert.deepEqual(layoutOf(spec), rehearsal.columns.map(column => [column.name, canonicalType(column.type)]),
      rehearsal.name);
    assert.deepEqual([...spec.key], [...rehearsal.primaryKey], `${rehearsal.name} key`);
  }
  const transport = specByName("telemetry_v12_runtime_transport");
  assert.deepEqual(layoutOf(transport).map(([name]) => name), ["id", "state", "revision", "changed_at"]);
  assert.equal(transport.receipt, false);
  // T-1's transport allowlist for the v1/v1.1 headers and the event sources.
  const t1 = new Map(Object.values(POSTGRES_FASTPATH_TRANSPORT_TABLE_SPECS).flat().map(spec => [spec.name, spec]));
  for (const name of ["telemetry_v1_chunks", "telemetry_v11_day_manifests", "telemetry_v11_chunks", "telemetry_v11_domain_days",
    "storage_v11_event_sources", "storage_v12_event_sources", "typed_v1_event_sources"]) {
    const spec = specByName(name);
    const reviewed = t1.get(name);
    const integer = type => (/^(?:int|i16|i32|i64)$/u.test(type) ? "integer" : type);
    const mapped = reviewed.columns.map(column => [column.target, integer(column.type)]);
    assert.deepEqual(layoutOf(spec).map(([column, type]) => [column, integer(type)]), mapped, name);
  }
  // The journal's exact source columns.
  const changes = specByName("storage_ingestion_changes");
  assert.deepEqual(changes.columns.filter(column => column.sealed !== null).map(column => column.sealed).sort(),
    [...POSTGRES_INGESTION_JOURNAL_SOURCE_COLUMNS].sort());
  const journalColumns = new Map(changes.columns.map(column => [column.name, column]));
  assert.equal(journalColumns.get("owner_revision").sql, "0");
  assert.equal(journalColumns.get("event_tuple_version").sql, "1");
});

test("the trigger policy is closed, reasoned and suppresses only what the brief names", () => {
  const suppressed = [];
  for (const [table, policy] of Object.entries(TELEMETRY_PRODUCTION_TRIGGER_POLICY)) {
    for (const [trigger, entry] of Object.entries(policy)) {
      assert.ok(["fire", "suppress"].includes(entry.policy), `${table}.${trigger}`);
      assert.ok(entry.reason.length > 0 && entry.reason.length <= 240, `${table}.${trigger} reason`);
      if (entry.policy === "suppress") suppressed.push(`${table}.${trigger}`);
    }
  }
  assert.deepEqual(suppressed.sort(), [
    "storage_v11_head_publication".replace(/^/u, "telemetry_v11_domain_heads."),
    "telemetry_v11_domain_heads.telemetry_v11_domain_head_source_revision",
    "telemetry_v11_chunks.telemetry_v11_chunks_reconciliation_guard",
    "telemetry_v11_domain_days.telemetry_v11_domain_day_immutable_guard",
    "telemetry_v12_chunks.telemetry_v12_chunks_reconciliation_guard",
    "telemetry_v12_domain_days.telemetry_v12_domain_day_immutable_guard",
    "telemetry_v12_domain_heads.storage_v12_head_publication",
    "telemetry_v12_typed_records.telemetry_v12_typed_record_admission",
    "telemetry_v1_chunks.aa_analytical_insert",
    "telemetry_v1_chunks.telemetry_v1_chunks_reconciliation_guard",
    "telemetry_v1_chunks.telemetry_v1_source_digest",
    "telemetry_v1_chunks.telemetry_v1_transport_floor_guard",
    "telemetry_v1_records.telemetry_v1_quota_fit_rows_insert",
    "typed_telemetry_owner_memberships.typed_telemetry_owner_membership_insert_guard",
  ].sort());
  // The owner-journal derivation and every erasure, retention and lineage guard stay live.
  const journal = TELEMETRY_PRODUCTION_TRIGGER_POLICY.storage_ingestion_changes;
  assert.ok(Object.values(journal).every(entry => entry.policy === "fire"));
  assert.ok(journal.storage_owner_revision_advance);
  for (const table of ["storage_v11_event_sources", "storage_v12_event_sources", "typed_v1_event_sources"]) {
    assert.ok(Object.values(TELEMETRY_PRODUCTION_TRIGGER_POLICY[table]).every(entry => entry.policy === "fire"), table);
  }
});

test("the value codec: closed vocabulary, ranges, canonical JSON and content-free refusals", () => {
  assert.deepEqual(canonicalSourceValue("i32", 5n, "t", "c"), ["5", "5"]);
  assert.throws(() => canonicalSourceValue("i32", 2_147_483_648n, "t", "c"), isCode("CUTOVER_SOURCE_VALUE_INVALID"));
  assert.throws(() => canonicalSourceValue("i16", 40_000n, "t", "c"), isCode("CUTOVER_SOURCE_VALUE_INVALID"));
  assert.deepEqual(canonicalSourceValue("i64", 9_007_199_254_740_993n, "t", "c"), ["9007199254740993", "9007199254740993"]);
  assert.deepEqual(canonicalSourceValue("real", -0, "t", "c"), [0, 0]);
  assert.deepEqual(canonicalSourceValue("real", 3n, "t", "c"), [3, 3]);
  assert.throws(() => canonicalSourceValue("real", Number.NaN, "t", "c"), isCode("CUTOVER_SOURCE_VALUE_INVALID"));
  assert.deepEqual(canonicalSourceValue("json", "{\"b\": 1, \"a\": [2, {\"z\": 1, \"y\": 2}]}", "t", "c"),
    ["{\"a\":[2,{\"y\":2,\"z\":1}],\"b\":1}", "{\"b\": 1, \"a\": [2, {\"z\": 1, \"y\": 2}]}"]);
  assert.throws(() => canonicalSourceValue("json", "{not json", "t", "c"), isCode("CUTOVER_SOURCE_VALUE_INVALID"));
  assert.deepEqual(canonicalSourceValue("instant", "2026-04-17T10:00:00Z", "t", "c"), ["2026-04-17T10:00:00.000Z", "2026-04-17T10:00:00.000Z"]);
  assert.throws(() => canonicalSourceValue("instant", "2026-04-17 10:00:00", "t", "c"), isCode("CUTOVER_SOURCE_VALUE_INVALID"));
  assert.throws(() => canonicalSourceValue("day", "2026-02-30", "t", "c"), isCode("CUTOVER_SOURCE_VALUE_INVALID"));
  assert.throws(() => canonicalSourceValue("text", "a\u0000b", "t", "c"), isCode("CUTOVER_SOURCE_VALUE_INVALID"));
  assert.deepEqual(canonicalSourceValue("bytes", new Uint8Array([1, 255]), "t", "c")[0], "01ff");
  assert.deepEqual(canonicalSourceValue("text", null, "t", "c"), [null, null]);
  // A refusal names the table and column only, never the value.
  try {
    canonicalSourceValue("instant", "SECRET-VALUE-0001", "telemetry_v1_chunks", "created_at");
    assert.fail("must refuse");
  } catch (error) {
    assert.equal(error.code, "CUTOVER_SOURCE_VALUE_INVALID");
    assert.equal(error.message, "CUTOVER_SOURCE_VALUE_INVALID [table=telemetry_v1_chunks column=created_at]");
  }
  assert.throws(() => col("Bad", "text"), TypeError);
  assert.throws(() => col("x", "float"), TypeError);
  assert.throws(() => defineTable({ name: "t", key: ["missing"], columns: [col("a", "text")], token: "imported:x" }), TypeError);
  assert.throws(() => defineTable({ name: "t", key: ["a"], columns: [col("a", "text")], token: "imported:x", mode: "merge" }), TypeError);
  assert.throws(() => defineTable({ name: "t", key: ["a"], columns: [col("a", "text")], token: "imported:x",
    suppress: { x: "r" }, fire: { x: "r" } }), TypeError);
  const spec = defineTable({ name: "t", key: ["a"], columns: [col("a", "text")], token: "imported:x", fire: { guard: "reason" } });
  assert.deepEqual(specTriggerPolicy(spec), { guard: { policy: "fire", reason: "reason" } });
});

test("every closed error code is declared, used and the only ones the modules throw", async () => {
  const codes = new Set(TELEMETRY_PRODUCTION_ERROR_CODES);
  assert.equal(codes.size, TELEMETRY_PRODUCTION_ERROR_CODES.length);
  const used = new Set();
  for (const file of ["postgres-production-telemetry-engine.mjs", "postgres-production-telemetry-modes.mjs"]) {
    const source = await readFile(resolve(WORKER_ROOT, "scripts", file), "utf8");
    for (const match of source.matchAll(/(?:fail|telemetryFail)\(\s*"([A-Z0-9_]+)"/gu)) used.add(match[1]);
    for (const match of source.matchAll(/,\s*"(CUTOVER_[A-Z0-9_]+)"/gu)) used.add(match[1]);
  }
  for (const code of used) assert.ok(codes.has(code) || code.startsWith("CUTOVER_"), `${code} is declared`);
  for (const code of [...used].filter(item => item.startsWith("CUTOVER_"))) {
    // Codes PT-1 owns (stage ledger, run state) are not redeclared here.
    if (!codes.has(code)) assert.match(code, /^CUTOVER_[A-Z0-9_]+$/u);
  }
  for (const code of codes) {
    assert.match(code, /^CUTOVER_[A-Z0-9_]+$/u);
    assert.ok(used.has(code), `${code} is thrown`);
  }
  assert.equal(new TelemetryProductionError("NOT_A_CODE").code, "CUTOVER_TELEMETRY_TRANSFER_FAILED");
  assert.equal(new TelemetryProductionError("CUTOVER_SOURCE_VALUE_INVALID", { table: "bad table", column: "ok_col", sqlState: "23505",
    guard: "telemetry_domain_immutable", stage: "typed-legacy" }).message,
  "CUTOVER_SOURCE_VALUE_INVALID [column=ok_col stage=typed-legacy sqlState=23505 guard=telemetry_domain_immutable]");
});

test("arguments are closed for every stage: pages at most 256 rows and 4 MiB, a handle and hook functions", async () => {
  for (const stage of TELEMETRY_PRODUCTION_STAGES) {
    const run = TELEMETRY_PRODUCTION_RUNNERS[stage];
    const handle = { sealManifestSha256: seal.manifest.sealId };
    for (const options of [{ pageRows: TELEMETRY_PRODUCTION_MAX_PAGE_ROWS + 1 }, { pageRows: 0 }, { pageRows: 1.5 },
      { pageBytes: TELEMETRY_PRODUCTION_MAX_PAGE_BYTES + 1 }, { pageBytes: 10 }, { onPage: "kill" }, { onStep: 1 }, { handle: null }]) {
      await assert.rejects(run({ handle, sealManifestPath: manifestPath, ...options }), isCode("CUTOVER_TELEMETRY_ARGUMENT_INVALID"),
        `${stage} ${JSON.stringify(Object.keys(options))}`);
    }
    await assert.rejects(run({ handle: { sealManifestSha256: "0".repeat(64) }, sealManifestPath: manifestPath }),
      error => error?.code === "CUTOVER_SEAL_MANIFEST_INVALID", stage);
    // A clean seal passes every sealed-source check and only then meets the target: PT-1 refuses the unregistered handle.
    await assert.rejects(run({ handle, sealManifestPath: manifestPath }), isCode("CUTOVER_TARGET_HANDLE_INVALID"), stage);
  }
});

test("every sealed-source refusal fires before the target is touched", async () => {
  const cases = [
    // telemetry-v1-v11
    ["telemetry-v1-v11", "ALTER TABLE telemetry_v1_chunks ADD COLUMN synthetic_extra TEXT", "CUTOVER_COLUMN_UNMAPPED"],
    ["telemetry-v1-v11", `${dropTriggers("telemetry_v11_domain_heads")}
      ALTER TABLE telemetry_v11_domain_heads DROP COLUMN updated_at`, "CUTOVER_COLUMN_UNMAPPED"],
    ["telemetry-v1-v11", "UPDATE telemetry_v1_chunks SET created_at = 'not-an-instant'", "CUTOVER_SOURCE_VALUE_INVALID"],
    ["telemetry-v1-v11", `${dropTriggers("telemetry_v11_chunks")}
      UPDATE telemetry_v11_chunks SET manifest_id = '00000000-0000-4000-8000-000000000000'
       WHERE rowid = (SELECT min(rowid) FROM telemetry_v11_chunks)`, "CUTOVER_SOURCE_LINEAGE_INVALID"],
    ["telemetry-v1-v11", `INSERT INTO pending_quarantine_objects(r2_key, contribution_id, object_kind, registered_at)
      SELECT 'telemetry/mismatch', id, 'telemetry', '2026-10-01T00:00:00.000Z' FROM telemetry_v1_chunks LIMIT 1`,
    "CUTOVER_PENDING_OBJECT_INVALID"],
    ["telemetry-v1-v11", `INSERT INTO pending_quarantine_objects(r2_key, contribution_id, object_kind, registered_at,
        reconciliation_state, reconciliation_lease_id)
      SELECT r2_key, id, 'telemetry', '2026-10-01T00:00:00.000Z', 'deleting', NULL FROM telemetry_v11_chunks LIMIT 1`,
    "CUTOVER_PENDING_OBJECT_INVALID"],
    // typed-legacy
    ["typed-legacy", "UPDATE typed_telemetry_schema SET version = 2", "CUTOVER_SCHEMA_MARKER_MISMATCH"],
    ["typed-legacy", "DELETE FROM typed_v1_analytical_schema", "CUTOVER_SCHEMA_MARKER_MISMATCH"],
    ["typed-legacy", "ALTER TABLE typed_telemetry_usage ADD COLUMN synthetic_extra INTEGER", "CUTOVER_COLUMN_UNMAPPED"],
    ["typed-legacy", `${dropTriggers("storage_v11_owner_links")}
      UPDATE storage_v11_owner_links SET state = 'erased' WHERE participant_id = (SELECT participant_id FROM typed_v11_owner_memberships LIMIT 1)`,
    "CUTOVER_ERASED_OWNER_EVIDENCE_PRESENT"],
    ["typed-legacy", `${dropTriggers("participants")}
      UPDATE participants SET state = 'deleting' WHERE id = (SELECT participant_id FROM typed_v1_owner_memberships LIMIT 1)`,
    "CUTOVER_TYPED_OWNER_AUTHORITY_INVALID"],
    ["typed-legacy", `${dropTriggers("typed_telemetry_owners")}
      DELETE FROM typed_telemetry_owners WHERE id = (SELECT typed_owner_id FROM typed_v11_owner_memberships LIMIT 1)`,
    "CUTOVER_SOURCE_LINEAGE_INVALID"],
    ["typed-legacy", `${dropTriggers("typed_telemetry_quota")}
      UPDATE typed_telemetry_quota SET analysis_observed_at_ms = 5 WHERE record_id = (SELECT min(record_id) FROM typed_telemetry_quota)`,
    "CUTOVER_SOURCE_LINEAGE_INVALID"],
    // legacy-admission
    ["legacy-admission", `INSERT INTO typed_v1_authority_requests(chunk_id, participant_id, device_id, authorization_id,
        authorization_digest, envelope_digest) VALUES ('chunk:x', 'p', 'd', 'a', '${"a".repeat(64)}', '${"b".repeat(64)}')`,
    "CUTOVER_ADMISSION_PENDING_REQUESTS"],
    ["legacy-admission", `${dropTriggers("typed_v11_chunk_allocations")}
      UPDATE typed_v11_chunk_allocations SET record_count = record_count + 1 WHERE rowid = (SELECT min(rowid) FROM typed_v11_chunk_allocations)`,
    "CUTOVER_SOURCE_LINEAGE_INVALID"],
    ["legacy-admission", `${dropTriggers("typed_v1_record_admissions")}
      DELETE FROM typed_v1_record_admissions`, "CUTOVER_ADMISSION_PROOF_INCOMPLETE"],
    ["legacy-admission", `${dropTriggers("telemetry_v11_day_manifests")}
      UPDATE telemetry_v11_day_manifests SET state = 'staged', ready_at = NULL
       WHERE id = (SELECT manifest_id FROM typed_v11_manifest_memberships LIMIT 1)`, "CUTOVER_ADMISSION_SOURCE_UNQUALIFIED"],
    ["legacy-admission", `${dropTriggers("typed_v11_record_proofs")}
      DELETE FROM typed_v11_record_proofs WHERE rowid = (SELECT min(rowid) FROM typed_v11_record_proofs)`,
    "CUTOVER_ADMISSION_PROOF_INCOMPLETE"],
    // header-promotion (only the source tables it reads)
    ["header-promotion", "DROP TABLE telemetry_v11_chunks", "CUTOVER_SOURCE_TABLE_MISSING"],
    // telemetry-v12
    ["telemetry-v12", "ALTER TABLE telemetry_v12_quota ADD COLUMN synthetic_extra INTEGER", "CUTOVER_COLUMN_UNMAPPED"],
    ["telemetry-v12", `${dropTriggers("typed_telemetry_dictionary")}
      DELETE FROM typed_telemetry_dictionary WHERE id = (SELECT provider_id FROM telemetry_v12_records LIMIT 1)`,
    "CUTOVER_SOURCE_LINEAGE_INVALID"],
    ["telemetry-v12", `${dropTriggers("telemetry_v12_records")}
      UPDATE telemetry_v12_records SET observed_day = observed_day + 1 WHERE id = (SELECT min(id) FROM telemetry_v12_records)`,
    "CUTOVER_V12_SOURCE_INVALID"],
    ["telemetry-v12", `${dropTriggers("telemetry_v12_chunks")}
      UPDATE telemetry_v12_chunks SET record_count = 1 WHERE id IN (
        SELECT chunk_id FROM telemetry_v12_records GROUP BY chunk_id HAVING count(*) > 1 LIMIT 1)`, "CUTOVER_V12_SOURCE_INVALID"],
    ["telemetry-v12", `${dropTriggers("device_upload_authorizations")}
      UPDATE device_upload_authorizations SET state = 'revoked' WHERE id = (SELECT device_upload_authorization_id FROM telemetry_v12_chunks LIMIT 1)`,
    "CUTOVER_V12_SOURCE_INVALID"],
    ["telemetry-v12", `${dropTriggers("telemetry_v12_day_manifests")}
      UPDATE telemetry_v12_day_manifests SET ready_at = NULL WHERE rowid = (SELECT min(rowid) FROM telemetry_v12_day_manifests WHERE state = 'ready')`,
    "CUTOVER_V12_SOURCE_INVALID"],
    // v12-event-sources
    ["v12-event-sources", `${dropTriggers("storage_v12_event_sources")}
      UPDATE storage_v12_event_sources SET generation_id = '00000000-0000-4000-8000-000000000000'`, "CUTOVER_SOURCE_LINEAGE_INVALID"],
    ["v12-event-sources", "ALTER TABLE storage_v12_event_sources ADD COLUMN synthetic_extra TEXT", "CUTOVER_COLUMN_UNMAPPED"],
    // usage-correction
    ["usage-correction", `${dropTriggers("telemetry_usage_correction_cas_guard")}
      INSERT INTO telemetry_usage_correction_cas_guard(id, participant_id, owner_digest, owner_revision, authority_epoch, runtime_state)
      VALUES (1, 'participant:synthetic', zeroblob(32), 1, 1, 'staged')`, "CUTOVER_CORRECTION_CAS_GUARD_PRESENT"],
    ["usage-correction", `${dropTriggers("telemetry_usage_correction_facts")}
      INSERT INTO telemetry_usage_correction_facts(id, history_id, method_version, captured_at_ms) VALUES (1, 1, 1, 1)`,
    "CUTOVER_SOURCE_LINEAGE_INVALID"],
    // ingestion-journal
    ["ingestion-journal", `${dropTriggers("storage_ingestion_changes")}
      DELETE FROM storage_ingestion_changes WHERE sequence = 3`, "CUTOVER_JOURNAL_SOURCE_INVALID"],
    ["ingestion-journal", `${dropTriggers("storage_source_state")}
      UPDATE storage_source_state SET source_id = 'bad source id'`, "CUTOVER_JOURNAL_SOURCE_INVALID"],
    ["ingestion-journal", "UPDATE storage_source_state SET authority_epoch = 99", "CUTOVER_JOURNAL_SOURCE_INVALID"],
    ["ingestion-journal", "ALTER TABLE storage_ingestion_changes ADD COLUMN synthetic_extra TEXT", "CUTOVER_COLUMN_UNMAPPED"],
  ];
  for (const [stage, sql, code] of cases) {
    const forged = await forgeVariantSeal(seal, `${PREFIX}\n${sql}`);
    await assert.rejects(TELEMETRY_PRODUCTION_RUNNERS[stage]({ handle: { sealManifestSha256: forged.sealId },
      sealManifestPath: forged.manifestPath }), error => {
      assert.ok(error instanceof TelemetryProductionError, `${stage}: ${sql.slice(0, 60)}`);
      assert.equal(error.code, code, `${stage}: ${sql.slice(0, 80)} -> ${error.code}`);
      return true;
    }, `${stage} ${code}`);
  }
});

test("a refusal is content-free: no sealed value reaches the error", async () => {
  const marker = "secret-synthetic-participant-marker-0001";
  const forged = await forgeVariantSeal(seal, `${PREFIX}
    ${dropTriggers("typed_telemetry_owners")}
    UPDATE typed_telemetry_owners SET original_id = CAST('${marker}' AS BLOB) WHERE id = 1;
    UPDATE telemetry_v1_chunks SET created_at = '${marker}'`);
  await assert.rejects(TELEMETRY_PRODUCTION_RUNNERS["telemetry-v1-v11"]({ handle: { sealManifestSha256: forged.sealId },
    sealManifestPath: forged.manifestPath }), error => {
    assert.equal(error.code, "CUTOVER_SOURCE_VALUE_INVALID");
    assert.equal(JSON.stringify(error).includes(marker) || error.message.includes(marker) || String(error.stack).includes(marker), false);
    assert.equal(error.message, "CUTOVER_SOURCE_VALUE_INVALID [table=telemetry_v1_chunks column=created_at]");
    return true;
  });
});

test("the sealed lineage the stages rely on is present in the clean seal (no variant passes by accident)", () => {
  assert.ok(sealed("SELECT count(*) AS n FROM typed_v11_owner_memberships").n > 0n);
  assert.ok(sealed("SELECT count(*) AS n FROM typed_v1_owner_memberships").n > 0n);
  assert.ok(sealed("SELECT count(*) AS n FROM telemetry_v12_records").n > 0n);
  assert.ok(sealed("SELECT count(*) AS n FROM storage_ingestion_changes").n >= 4n);
  const policyHash = createHash("sha256").update(JSON.stringify(Object.keys(TELEMETRY_PRODUCTION_TRIGGER_POLICY).sort())).digest("hex");
  assert.equal(policyHash.length, 64);
});
