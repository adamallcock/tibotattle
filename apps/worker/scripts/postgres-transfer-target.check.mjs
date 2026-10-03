import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  advancePrefixChain,
  assertProductionTransferId,
  assertTriggerPolicyCoverage,
  canonicalValue,
  CONTROL_SCHEMA_RELATIONS,
  createRowsDigest,
  digestRows,
  EMPTY_PREFIX_CHAIN,
  instantFromPostgres,
  markLive,
  openProductionTransferTarget,
  POSTGRES_TRANSFER_TARGET_ERROR_CODES,
  PostgresTransferTargetError,
  productionTransferId,
  recordSealedCollectionControls,
  registerProductionTransferTarget,
  RETAINED_CONTROL_FUNCTIONS,
  RETAINED_CONTROL_RELATIONS,
  SEEDED_SINGLETONS,
  sealedCollectionControlsSha256,
  stageReceipt,
  toPostgresInstant,
  TRANSFER_CONTROL_SCHEMA,
  TRANSFER_STAGES,
  withTransferTransaction,
  withTriggerPolicy,
} from "./postgres-transfer-target.mjs";

const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRIMARY_SQL = join(WORKER_ROOT, "postgres/migrations/primary/0056_production_transfer_control.sql");
// The frozen ledger 0007 (owner action OA-4): read only to prove that the
// relation and guard it adds are outside the primary-only allowlists.
const FROZEN_LEDGER_SQL = join(WORKER_ROOT, "postgres/migrations/ledger/0007_production_transfer_control.sql");
const SEAL = "0123456789abcdef".repeat(4);

function rejectsWith(code, fn) {
  return assert.rejects(fn, error => error instanceof PostgresTransferTargetError && error.code === code);
}

function throwsWith(code, fn) {
  assert.throws(fn, error => error instanceof PostgresTransferTargetError && error.code === code);
}

test("TRANSFER_STAGES is the frozen, ordered production stage list", () => {
  assert.equal(Object.isFrozen(TRANSFER_STAGES), true);
  assert.deepEqual([...TRANSFER_STAGES], [
    "analytics-expectation", "identity-authority", "identity-link-rotation", "legacy-contributions", "telemetry-v1-v11",
    "typed-legacy", "legacy-admission", "header-promotion", "telemetry-v12", "v12-event-sources",
    "usage-correction", "performance", "pending-registrations", "accountless-retention",
    "ingestion-journal", "analytics-history", "analytics-community-history",
    "owner-lifecycle-verify", "objects", "post-import",
  ]);
  assert.equal(new Set(TRANSFER_STAGES).size, TRANSFER_STAGES.length);
  // No deletion-ledger stage (LEAD-SIMP); 'accountless-retention' is kept by
  // owner decision OD-3 (2026-10-02).
  assert.equal(TRANSFER_STAGES.some((stage) => /ledger/u.test(stage)), false);
  assert.ok(TRANSFER_STAGES.includes("accountless-retention"));
  for (const stage of TRANSFER_STAGES) assert.match(stage, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u);
});

test("productionTransferId binds the stage and the first 16 hex of the seal id", () => {
  assert.equal(productionTransferId("identity-authority", SEAL), "production-identity-authority-0123456789abcdef");
  assert.equal(assertProductionTransferId("production-objects-0123456789abcdef", "objects", SEAL),
    "production-objects-0123456789abcdef");
  throwsWith("CUTOVER_STAGE_UNKNOWN", () => productionTransferId("identity", SEAL));
  throwsWith("CUTOVER_TRANSFER_ID_INVALID", () => productionTransferId("objects", SEAL.toUpperCase()));
  throwsWith("CUTOVER_TRANSFER_ID_INVALID", () => productionTransferId("objects", SEAL.slice(1)));
  throwsWith("CUTOVER_TRANSFER_ID_INVALID",
    () => assertProductionTransferId("production-objects-0123456789abcdee", "objects", SEAL));
  throwsWith("CUTOVER_TRANSFER_ID_INVALID",
    () => assertProductionTransferId("production-post-import-0123456789abcdef", "objects", SEAL));
});

test("toPostgresInstant accepts only canonical millisecond UTC 'Z' strings; errors name only table and column", () => {
  const where = { table: "telemetry_v1_chunks", column: "created_at" };
  assert.equal(toPostgresInstant("2026-09-26T01:02:03.456Z", where), "2026-09-26T01:02:03.456Z");
  assert.equal(toPostgresInstant(null, { ...where, nullable: true }), null);
  const rejected = [
    "2026-09-26T01:02:03Z",
    "2026-09-26T01:02:03.4567Z",
    "2026-09-26T01:02:03.456+00:00",
    "2026-09-26T01:02:03.456z",
    "2026-09-26 01:02:03.456Z",
    "2026-02-30T01:02:03.456Z",
    "2026-09-26T24:00:00.000Z",
    "0000-01-01T00:00:00.000Z",
    " 2026-09-26T01:02:03.456Z",
    "+002026-09-26T01:02:03.456Z",
    null,
    undefined,
    1_790_000_000_000,
    new Date("2026-09-26T01:02:03.456Z"),
  ];
  for (const value of rejected) {
    assert.throws(() => toPostgresInstant(value, where), (error) => {
      assert.ok(error instanceof PostgresTransferTargetError);
      assert.equal(error.code, "CUTOVER_INSTANT_FORMAT_INVALID");
      assert.equal(error.table, "telemetry_v1_chunks");
      assert.equal(error.column, "created_at");
      assert.equal(error.message, "CUTOVER_INSTANT_FORMAT_INVALID [table=telemetry_v1_chunks column=created_at]");
      if (typeof value === "string") assert.equal(error.message.includes(value.trim()), false);
      return true;
    });
  }
  assert.throws(() => toPostgresInstant("not-an-instant", { table: "bad name; drop", column: "x\ny" }), (error) => {
    assert.equal(error.message, "CUTOVER_INSTANT_FORMAT_INVALID");
    assert.equal(Object.hasOwn(error, "table"), false);
    return true;
  });
  assert.equal(instantFromPostgres(new Date("2026-09-26T01:02:03.456Z"), where), "2026-09-26T01:02:03.456Z");
  throwsWith("CUTOVER_INSTANT_FORMAT_INVALID", () => instantFromPostgres(new Date(Number.NaN), where));
  throwsWith("CUTOVER_INSTANT_FORMAT_INVALID", () => instantFromPostgres("2026-09-26T01:02:03.456Z", where));
});

test("digest helpers equal the cutover rehearsal's createRowsDigest and advancePrefixChain (pinned vectors)", () => {
  // Pinned from postgres-cutover-rehearsal.mjs (canonical, digestRows,
  // createRowsDigest, advancePrefixChain and EMPTY_PREFIX_CHAIN evaluated
  // verbatim on these rows).
  const rows = [
    { id: "synthetic-row-1", count: 3, ratio: 0.5, flag: true, missing: null },
    { z: [1, "two", { b: 2, a: 1 }], created_at: new Date("2026-09-26T01:02:03.456Z"),
      secret_hash: Buffer.from("00ff10", "hex") },
    { text: "café ☃", nested: { y: [null, false], x: "x" } },
  ];
  assert.equal(EMPTY_PREFIX_CHAIN, "636a76665a8ecad6ed5864d0c3681d85905a639735f8a5f25807cf9a9223d90d");
  const digest = createRowsDigest();
  for (const row of rows) digest.update(row);
  assert.equal(digest.count, 3);
  assert.equal(digest.digest(), "61b3199196e9afdbe1f556906e360d0b940dc1408fc3ac2e80380cac2eef5751");
  assert.equal(digestRows(rows), "61b3199196e9afdbe1f556906e360d0b940dc1408fc3ac2e80380cac2eef5751");
  assert.equal(createRowsDigest().digest(), "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  let chain = EMPTY_PREFIX_CHAIN;
  for (const row of rows) chain = advancePrefixChain(chain, row);
  assert.equal(chain, "852cb832b83b569cb4628f0a24101b3ee355f082877a5c543943ef635e626f59");
  assert.equal(JSON.stringify(canonicalValue(rows[1])),
    "{\"created_at\":\"2026-09-26T01:02:03.456Z\",\"secret_hash\":\"00ff10\",\"z\":[1,\"two\",{\"a\":1,\"b\":2}]}");
});

test("the sealed collection-controls digest is pinned and covers every sealed field", () => {
  const sealed = {
    control_state: "operational", enrollment_enabled: true, upload_registration_enabled: true,
    processing_enabled: true, publication_enabled: true, reason_code: "drill_restore", revision: 7,
    updated_at: "2026-09-20T10:11:12.345Z",
  };
  // sha256("tibotattle-sealed-collection-controls-v1\n" + sorted-key JSON of the row).
  assert.equal(sealedCollectionControlsSha256(sealed),
    "f2ba4ff08c8f35e63a0694a20902f723e5d4eec0d2cbfdaf5889af0ed9b3d7dc");
  const base = sealedCollectionControlsSha256(sealed);
  for (const [key, value] of Object.entries({
    control_state: "degraded", enrollment_enabled: false, upload_registration_enabled: false,
    processing_enabled: false, publication_enabled: false, reason_code: "maintenance", revision: 8,
    updated_at: "2026-09-20T10:11:12.346Z",
  })) {
    assert.notEqual(sealedCollectionControlsSha256({ ...sealed, [key]: value }), base, key);
  }
});

test("errors are closed codes whose details carry only identifiers", () => {
  assert.equal(Object.isFrozen(POSTGRES_TRANSFER_TARGET_ERROR_CODES), true);
  assert.equal(new Set(POSTGRES_TRANSFER_TARGET_ERROR_CODES).size, POSTGRES_TRANSFER_TARGET_ERROR_CODES.length);
  const error = new PostgresTransferTargetError("CUTOVER_TARGET_NOT_EMPTY", {
    relation: "participants", table: "synthetic value with spaces", sqlState: "P1005", stage: "not-a-stage",
    value: "synthetic-content",
  });
  assert.equal(error.message, "CUTOVER_TARGET_NOT_EMPTY [sqlState=P1005 relation=participants]");
  assert.equal(Object.hasOwn(error, "value"), false);
  assert.equal(Object.hasOwn(error, "table"), false);
  assert.equal(Object.hasOwn(error, "stage"), false);
});

test("seeded singletons and retained control relations are frozen allowlists", () => {
  assert.equal(Object.isFrozen(SEEDED_SINGLETONS), true);
  assert.equal(Object.isFrozen(RETAINED_CONTROL_RELATIONS), true);
  for (const entry of SEEDED_SINGLETONS) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(entry.role, "primary", "every seeded singleton lives in the one target database");
    assert.ok(Number.isSafeInteger(entry.seedRows) && entry.seedRows >= 1);
  }
  const names = SEEDED_SINGLETONS.map(entry => `${entry.role}:${entry.table}`);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("primary:community_public_source_bootstrap"));
  assert.ok(names.includes("primary:collection_controls"));
  assert.equal(names.some((name) => /ledger/u.test(name)), false);
  for (const relation of RETAINED_CONTROL_RELATIONS) {
    assert.equal(/participant|device|object_key|r2_key|manifest/u.test(relation), false, relation);
  }
});

async function migrationSql() {
  return { primary: await readFile(PRIMARY_SQL, "utf8") };
}

function createdNames(sql, kind) {
  const pattern = new RegExp(`CREATE ${kind} (?:IF NOT EXISTS )?([a-z_]+)\\.([a-z_]+)`, "gu");
  return [...sql.matchAll(pattern)].map(match => ({ schema: match[1], name: match[2] }));
}

test("control migrations qualify every object, raise constant coded errors and grant nothing", async () => {
  const sql = await migrationSql();
  for (const [role, text] of Object.entries(sql)) {
    assert.match(text, /^SELECT pg_advisory_xact_lock\(hashtextextended\('tibotattle_transfer:control-schema', 0\)\);$/mu);
    assert.equal(/\bGRANT\b/u.test(text), false, `${role} grants a privilege`);
    for (const statement of ["REVOKE ALL ON SCHEMA tibotattle_transfer FROM PUBLIC;",
      "REVOKE ALL ON ALL TABLES IN SCHEMA tibotattle_transfer FROM PUBLIC;",
      "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tibotattle_transfer FROM PUBLIC;"]) {
      assert.ok(text.includes(statement), `${role} lacks ${statement}`);
    }
    for (const kind of ["TABLE", "FUNCTION"]) {
      for (const created of createdNames(text, kind)) assert.equal(created.schema, TRANSFER_CONTROL_SCHEMA);
    }
    assert.equal(/CREATE (?:TABLE|FUNCTION|VIEW|SEQUENCE|TYPE) (?!tibotattle_transfer\.)[a-z]/u.test(text),
      false, `${role} creates an unqualified object`);
    // An index lives in its table's schema; its ON target must be qualified.
    for (const match of text.matchAll(/CREATE (?:UNIQUE )?INDEX [a-z_]+\s+ON ([a-z_]+)\./gu)) {
      assert.equal(match[1], TRANSFER_CONTROL_SCHEMA);
    }
    assert.equal(/CREATE (?:UNIQUE )?INDEX [a-z_]+\s+ON (?!tibotattle_transfer\.)/u.test(text), false);
    for (const match of text.matchAll(/ON tibotattle_transfer\.[a-z_]+|ON ([a-z_]+)(?=\s+FOR EACH)/gu)) {
      assert.equal(match[1], undefined, `${role} attaches a trigger to an unqualified relation`);
    }
    const raises = [...text.matchAll(/RAISE EXCEPTION ([^;]+);/gu)].map(match => match[1]);
    assert.ok(raises.length > 0);
    for (const raise of raises) {
      assert.match(raise, /^'([A-Z_]+)' USING ERRCODE = 'P1005'$/u);
      const code = /^'([A-Z_]+)'/u.exec(raise)[1];
      assert.ok(POSTGRES_TRANSFER_TARGET_ERROR_CODES.includes(code), `${code} is not a closed module code`);
    }
    const functions = [...text.matchAll(/CREATE FUNCTION (tibotattle_transfer\.[a-z_]+\([^)]*\))\s*RETURNS [a-z]+ LANGUAGE (?:plpgsql|sql)(?: STABLE)? SET search_path = pg_catalog, pg_temp AS/gu)];
    assert.equal(functions.length, createdNames(text, "FUNCTION").length, `${role} function without pinned search_path`);
    assert.equal(/SECURITY DEFINER/u.test(text), false);
  }
});

test("the frozen ledger 0007 adds exactly one relation and its guard, both outside the allowlists", async () => {
  const primary = (await migrationSql()).primary;
  const frozen = await readFile(FROZEN_LEDGER_SQL, "utf8");
  const primaryTables = new Set(createdNames(primary, "TABLE").map(created => created.name));
  const frozenOnlyTables = createdNames(frozen, "TABLE").map(created => created.name)
    .filter(name => !primaryTables.has(name));
  assert.equal(frozenOnlyTables.length, 1, "the ledger mirror run table");
  for (const name of frozenOnlyTables) {
    assert.equal(CONTROL_SCHEMA_RELATIONS.includes(name), false, name);
    assert.equal(RETAINED_CONTROL_RELATIONS.includes(name), false, name);
  }
  const primaryFunctions = new Set(createdNames(primary, "FUNCTION").map(created => created.name));
  const frozenOnlyFunctions = createdNames(frozen, "FUNCTION").map(created => created.name)
    .filter(name => !primaryFunctions.has(name));
  assert.equal(frozenOnlyFunctions.length, 1, "the mirror table's guard");
  for (const name of frozenOnlyFunctions) assert.equal(RETAINED_CONTROL_FUNCTIONS.includes(name), false, name);
});

test("CONTROL_SCHEMA_RELATIONS and RETAINED_CONTROL_FUNCTIONS equal what primary 0056 creates", async () => {
  const sql = await migrationSql();
  const tables = new Set(createdNames(sql.primary, "TABLE").map(created => created.name));
  assert.equal(Object.isFrozen(CONTROL_SCHEMA_RELATIONS), true);
  assert.deepEqual([...tables].sort(), [...CONTROL_SCHEMA_RELATIONS].sort());
  // The retained allowlist always covers the control relations; reviewed
  // tool receipt relations may be appended after them.
  assert.deepEqual(RETAINED_CONTROL_RELATIONS.slice(0, CONTROL_SCHEMA_RELATIONS.length), [...CONTROL_SCHEMA_RELATIONS]);
  const functions = new Set(createdNames(sql.primary, "FUNCTION").map(created => created.name));
  assert.deepEqual([...functions].sort(), [...RETAINED_CONTROL_FUNCTIONS].sort());
  for (const forbidden of ["participant_id", "device_id", "r2_key", "object_key", "manifest_json", "record_json"]) {
    assert.equal(sql.primary.includes(forbidden), false, forbidden);
  }
  assert.match(sql.primary, /CHECK \(state <> 'complete' OR last_key IS NULL\)/u);
  // An abandoned run's checkpoint admits only NULLing its cursor.
  assert.match(sql.primary, /OLD\.last_key IS NOT NULL AND NEW\.last_key IS NULL[\s\S]{0,400}run\.state = 'abandoned'/u);
  // Installing the live lock revokes CREATE on the control schema and verifies it.
  assert.match(sql.primary, /EXECUTE format\('REVOKE CREATE ON SCHEMA tibotattle_transfer FROM %I'/u);
  assert.match(sql.primary, /acl\.privilege_type = 'CREATE'/u);
  assert.match(sql.primary, /CREATE UNIQUE INDEX transfer_runs_one_open\s+ON tibotattle_transfer\.transfer_runs \(\(true\)\) WHERE state <> 'abandoned';/u);
});

function fakeClient(responder) {
  const statements = [];
  return {
    statements,
    async query(text, values) {
      const sql = String(text).replaceAll(/\s+/gu, " ").trim();
      statements.push(sql);
      const result = await responder(sql, values);
      return result ?? { rows: [], rowCount: 0 };
    },
    release() {},
  };
}

function triggerCatalog({ deferrables = [], triggers, enabledAfter = true }) {
  let enabled = true;
  return fakeClient((sql) => {
    if (sql.startsWith("SELECT c.oid::text AS oid")) return { rows: [{ oid: "16384" }] };
    if (sql.startsWith("SELECT tgname::text AS name, tgenabled::text AS enabled")) return { rows: triggers };
    if (sql.startsWith("WITH neighbours AS")) return { rows: deferrables };
    if (sql.includes("DISABLE TRIGGER")) enabled = false;
    if (sql.includes("ENABLE TRIGGER")) enabled = enabledAfter;
    if (sql.startsWith("ROLLBACK TO SAVEPOINT")) enabled = true;
    if (sql.startsWith("SELECT tgname::text AS name FROM pg_catalog.pg_trigger")) {
      return { rows: enabled ? triggers.map(row => ({ name: row.name })) : [] };
    }
    return undefined;
  });
}

const GUARD = Object.freeze({ name: "domain_guard", enabled: "O", internal: false, constraint_trigger: false });

test("withTriggerPolicy disables named triggers only, forces deferrables IMMEDIATE, then re-enables", async () => {
  const client = triggerCatalog({
    triggers: [GUARD],
    deferrables: [{ schema_name: "app", constraint_name: "days_manifest_fkey" },
      { schema_name: "app", constraint_name: "neighbour \"quoted\"" }],
  });
  const result = await withTriggerPolicy(client, { schema: "app", table: "domain_days", suppress: ["domain_guard"] },
    async (page) => {
      await page.query("INSERT INTO app.domain_days VALUES (1)");
      return "page-result";
    });
  assert.equal(result, "page-result");
  const writes = client.statements.filter(sql => !sql.startsWith("SELECT") && !sql.startsWith("WITH"));
  assert.deepEqual(writes, [
    "SAVEPOINT tibotattle_transfer_trigger_policy",
    "ALTER TABLE \"app\".\"domain_days\" DISABLE TRIGGER \"domain_guard\"",
    "INSERT INTO app.domain_days VALUES (1)",
    "SET CONSTRAINTS \"app\".\"days_manifest_fkey\", \"app\".\"neighbour \"\"quoted\"\"\" IMMEDIATE",
    "ALTER TABLE \"app\".\"domain_days\" ENABLE TRIGGER \"domain_guard\"",
    "RELEASE SAVEPOINT tibotattle_transfer_trigger_policy",
  ]);
  for (const sql of client.statements) {
    assert.equal(/TRIGGER (ALL|USER)\b/u.test(sql), false);
    assert.equal(/session_replication_role/u.test(sql), false);
  }
});

test("withTriggerPolicy restores triggers after a failing page and refuses unsafe suppression", async () => {
  const failing = triggerCatalog({ triggers: [GUARD] });
  const pageError = new Error("synthetic page failure");
  await assert.rejects(withTriggerPolicy(failing, { schema: "app", table: "domain_days", suppress: ["domain_guard"] },
    async () => { throw pageError; }), error => error === pageError);
  assert.ok(failing.statements.includes("ROLLBACK TO SAVEPOINT tibotattle_transfer_trigger_policy"));
  assert.equal(failing.statements.some(sql => sql.includes("SET CONSTRAINTS")), false);

  const stuck = triggerCatalog({ triggers: [GUARD], enabledAfter: false });
  await rejectsWith("CUTOVER_TRIGGER_POLICY_REENABLE_FAILED",
    () => withTriggerPolicy(stuck, { schema: "app", table: "domain_days", suppress: ["domain_guard"] }, async () => {}));

  for (const trigger of [
    { ...GUARD, internal: true },
    { ...GUARD, constraint_trigger: true },
    { ...GUARD, enabled: "D" },
  ]) {
    const client = triggerCatalog({ triggers: [trigger] });
    await rejectsWith("CUTOVER_TRIGGER_POLICY_TRIGGER_INVALID",
      () => withTriggerPolicy(client, { schema: "app", table: "domain_days", suppress: ["domain_guard"] }, async () => {}));
    assert.equal(client.statements.some(sql => sql.includes("DISABLE TRIGGER")), false);
  }
  const unknown = triggerCatalog({ triggers: [] });
  await rejectsWith("CUTOVER_TRIGGER_POLICY_TRIGGER_INVALID",
    () => withTriggerPolicy(unknown, { schema: "app", table: "domain_days", suppress: ["domain_guard"] }, async () => {}));
  for (const suppress of [["ALL"], ["USER"], ["guard", "guard"], "guard", [""]]) {
    await rejectsWith("CUTOVER_TRIGGER_POLICY_INVALID",
      () => withTriggerPolicy(triggerCatalog({ triggers: [GUARD] }), { schema: "app", table: "domain_days", suppress },
        async () => {}));
  }
  // The control schema and the reserved schemas are refused before any statement.
  for (const schema of [TRANSFER_CONTROL_SCHEMA, "public", "information_schema"]) {
    const reserved = triggerCatalog({ triggers: [GUARD] });
    await rejectsWith("CUTOVER_TRIGGER_POLICY_INVALID",
      () => withTriggerPolicy(reserved, { schema, table: "domain_days", suppress: ["domain_guard"] }, async () => {}));
    assert.deepEqual(reserved.statements, []);
  }
  const outside = fakeClient((sql) => {
    if (sql.startsWith("SAVEPOINT")) throw Object.assign(new Error("no transaction"), { code: "25P01" });
  });
  await rejectsWith("CUTOVER_TRIGGER_POLICY_TRANSACTION_REQUIRED",
    () => withTriggerPolicy(outside, { schema: "app", table: "domain_days", suppress: ["domain_guard"] }, async () => {}));
});

test("assertTriggerPolicyCoverage fails closed for unclassified, stale and unsafe entries", async () => {
  const catalog = (triggers, tables = ["days"]) => fakeClient((sql) => {
    if (sql.startsWith("SELECT c.relname::text AS name")) return { rows: tables.map(name => ({ name })) };
    if (sql.startsWith("SELECT c.relname::text AS table_name")) return { rows: triggers };
    if (sql.startsWith("SELECT c.oid::text AS oid")) return { rows: [{ oid: "1" }] };
    if (sql.startsWith("WITH neighbours AS")) return { rows: [{ schema_name: "app", constraint_name: "fk" }] };
    return undefined;
  });
  const guard = { table_name: "days", trigger_name: "guard", constraint_trigger: false };
  const policy = { days: { guard: { policy: "suppress", reason: "historical rows already admitted" } } };
  const report = await assertTriggerPolicyCoverage(catalog([guard]), "app", policy);
  assert.deepEqual({ ...report, suppressedTablesWithDeferrables: [...report.suppressedTablesWithDeferrables] },
    { tables: 1, triggers: 1, suppressed: 1, suppressedTablesWithDeferrables: ["days"] });
  await assert.rejects(assertTriggerPolicyCoverage(catalog([guard, { ...guard, trigger_name: "added" }]), "app", policy),
    error => error.code === "CUTOVER_TRIGGER_POLICY_MISSING" && error.trigger === "added");
  await assert.rejects(assertTriggerPolicyCoverage(catalog([]), "app", policy),
    error => error.code === "CUTOVER_TRIGGER_POLICY_STALE" && error.trigger === "guard");
  await assert.rejects(assertTriggerPolicyCoverage(catalog([], []), "app", policy),
    error => error.code === "CUTOVER_TRIGGER_POLICY_STALE" && error.table === "days");
  await rejectsWith("CUTOVER_TRIGGER_POLICY_INVALID",
    () => assertTriggerPolicyCoverage(catalog([{ ...guard, constraint_trigger: true }]), "app", policy));
  for (const invalid of [
    { days: { guard: { policy: "suppress" } } },
    { days: { guard: { policy: "skip", reason: "x" } } },
    { days: { guard: { policy: "fire", reason: " " } } },
    { days: { guard: { policy: "fire", reason: "ok", extra: true } } },
    { "Days;": {} },
  ]) {
    await rejectsWith("CUTOVER_TRIGGER_POLICY_INVALID", () => assertTriggerPolicyCoverage(catalog([guard]), "app", invalid));
  }
});

test("production-mode operations refuse forged handles and clients outside a transfer transaction", async () => {
  const forged = Object.freeze({ primarySchema: "app", sealManifestSha256: SEAL });
  await rejectsWith("CUTOVER_TARGET_HANDLE_INVALID",
    () => withTransferTransaction(forged, "primary", async () => {}));
  await rejectsWith("CUTOVER_TARGET_HANDLE_INVALID", () => stageReceipt(fakeClient(() => undefined), forged, {
    stage: "objects", state: "started",
  }));
  await rejectsWith("CUTOVER_SEALED_CONTROLS_INVALID", () => recordSealedCollectionControls(
    fakeClient(() => undefined), forged, { singleton: 1, schema_version: "collection-controls-v0.1",
      control_state: "degraded", enrollment_enabled: 1, upload_registration_enabled: 1, processing_enabled: 1,
      publication_enabled: 1, revision: 3, reason_code: "maintenance", updated_at: "2026-09-20T10:11:12.345Z" }));
  // Flip options are closed before any connection: evidence digest, a
  // bounded, duplicate-free list of waived role names, and nothing else.
  for (const options of [
    {}, { flipEvidenceSha256: "not-a-digest" },
  ]) {
    await rejectsWith("CUTOVER_FLIP_EVIDENCE_INVALID", () => markLive(forged, options));
  }
  for (const options of [
    { flipEvidenceSha256: SEAL, allowedRoleMembers: ["member", "member"] },
    { flipEvidenceSha256: SEAL, allowedRoleMembers: "member" },
    { flipEvidenceSha256: SEAL, allowedRoleMembers: ["bad role"] },
    { flipEvidenceSha256: SEAL, allowedRoleMembers: Array.from({ length: 9 }, (_, index) => `member${index}`) },
    { flipEvidenceSha256: SEAL, extra: true },
  ]) {
    await rejectsWith("CUTOVER_TARGET_ARGUMENT_INVALID", () => markLive(forged, options));
  }
  await rejectsWith("CUTOVER_TARGET_HANDLE_INVALID", () => markLive(forged, { flipEvidenceSha256: SEAL,
    allowedRoleMembers: ["migration-owner"] }));
});

test("sealed collection-controls input is closed and D1-consistent", async () => {
  const valid = {
    singleton: 1, schema_version: "collection-controls-v0.1", control_state: "operational",
    enrollment_enabled: 1, upload_registration_enabled: 1, processing_enabled: 1, publication_enabled: 1,
    revision: 7, reason_code: "drill_restore", updated_at: "2026-09-20T10:11:12.345Z",
  };
  const forged = Object.freeze({});
  // A valid row passes validation and only then meets the handle check.
  await rejectsWith("CUTOVER_TARGET_HANDLE_INVALID", () => recordSealedCollectionControls(fakeClient(() => undefined),
    forged, valid));
  for (const change of [
    { schema_version: "collection-controls-v0.2" }, { singleton: 2 }, { revision: 0 }, { revision: 1.5 },
    { reason_code: "unknown" }, { control_state: "open" }, { enrollment_enabled: 2 },
    { updated_at: "2026-09-20T10:11:12Z" }, { extra: 1 }, { control_state: "contained" },
    { singleton: undefined }, { schema_version: undefined }, { singleton: "1" },
  ]) {
    await rejectsWith("CUTOVER_SEALED_CONTROLS_INVALID", () => recordSealedCollectionControls(
      fakeClient(() => undefined), forged, { ...valid, ...change }));
  }
  // The schema_version and singleton markers are required, not optional.
  for (const omitted of ["singleton", "schema_version"]) {
    const { [omitted]: removed, ...partial } = valid;
    assert.notEqual(removed, undefined);
    await rejectsWith("CUTOVER_SEALED_CONTROLS_INVALID", () => recordSealedCollectionControls(
      fakeClient(() => undefined), forged, partial));
  }
});

test("contract registration input is closed before any connection is made", async () => {
  const pool = { connect: async () => assert.fail("connected before validation") };
  const contract = {
    contractId: "tibotattle-production-v1", mode: "production", projectId: "tibotattle",
    projectNumber: "806510610397", instanceConnectionName: "tibotattle:us-east1:tibotattle-primary",
    databaseName: "tibotattle", schemaName: "tibotattle_primary",
    iamDatabaseUser: "tibotattle-transfer@tibotattle.iam",
    schemaOwnerRole: "tibotattle-migrator@tibotattle.iam", gcsBucket: "tibotattle-quarantine",
    gcsBucketGeneration: "1790000000000000",
  };
  for (const change of [
    { mode: "gcp_named_test" }, { schemaName: "tibotattle_transfer" }, { schemaName: "public" },
    { schemaName: "pg_catalog" }, { iamDatabaseUser: contract.schemaOwnerRole }, { projectNumber: "0" },
    { gcsBucket: "Bad_Bucket" }, { contractId: "x" }, { databaseName: "bad-name" }, { extra: "value" },
    { instanceConnectionName: "tibotattle:us-east1" },
    // The retired dual-role contract keys are unknown keys now.
    { ledgerInstanceConnectionName: "tibotattle:us-east1:tibotattle-ledger" },
    { ledgerDatabaseName: "tibotattle_ledger" },
    { ledgerSchemaName: "tibotattle_ledger" },
  ]) {
    await rejectsWith("CUTOVER_TARGET_CONTRACT_INVALID", () => registerProductionTransferTarget({
      primaryPool: pool, contract: { ...contract, ...change },
    }));
  }
  // Register and open take the one primary pool: any other argument (a
  // retired second pool included) is refused before any connection.
  for (const extra of [{ secondPool: pool }, { ledgerPool: pool }]) {
    await rejectsWith("CUTOVER_TARGET_ARGUMENT_INVALID", () => registerProductionTransferTarget({
      primaryPool: pool, contract, ...extra,
    }));
    await rejectsWith("CUTOVER_TARGET_ARGUMENT_INVALID", () => openProductionTransferTarget({
      primaryPool: pool, expectedContractId: contract.contractId, sealManifestSha256: SEAL, ...extra,
    }));
  }
});
