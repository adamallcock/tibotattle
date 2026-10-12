// Offline check for scripts/gcp-interim-public-read-load.mjs (C-IPR, OD-10):
// argument parsing, the export file boundary, the check mode, the exit codes
// and closed error output, the local-target rule, and the load transaction's
// statement order and failure handling against a recording fake pool. The
// PostgreSQL behaviour is in postgres-test/analytics-v2-interim-public-read.spec.mjs.
//
// Synthetic, content-free fixtures only: the Q-1 oracle golden widened to a
// full-year window.
//
//   node --test scripts/gcp-interim-public-read-load.check.mjs
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  FIXTURE_CAPTURED_AT,
  FIXTURE_EVIDENCE_DATE,
  FIXTURE_SOURCE_COMMIT,
  denseGoldenExportBody,
  exportBytes,
  goldenExportBody,
  sha256Hex,
} from "../analytics-v2-test/fixtures/interim-public-read-export.mjs";
import {
  GCP_INTERIM_PUBLIC_READ_LOAD_ERROR_CODES,
  GCP_INTERIM_PUBLIC_READ_LOAD_RECEIPT_SCHEMA,
  GcpInterimPublicReadLoadError,
  checkInterimPublicRead,
  loadInterimPublicRead,
  loadInterimPublicReadInTransaction,
  localInterimTarget,
  parseInterimLoadArguments,
  readInterimExportFile,
  runInterimPublicReadLoad,
} from "./gcp-interim-public-read-load.mjs";
import { INTERIM_PUBLIC_READ_ERROR_CODES, INTERIM_PUBLIC_READ_MAX_BYTES } from "../src/analytics-v2/interim-public-read.ts";

// The local-target rule names /private/tmp, which exists on the macOS
// workstation and in the CI container profile but not on every runner.
const SKIP_PRIVATE_TMP = await access("/private/tmp", 2).then(() => false, () => "/private/tmp is not writable here");

const scratch = await mkdtemp(join(tmpdir(), "tibotattle-ipr-check-"));
after(() => rm(scratch, { recursive: true, force: true }));

const BODY = goldenExportBody();
const BYTES = exportBytes(BODY);
const SHA = sha256Hex(BYTES);
const KNOWN_CODES = new Set([...GCP_INTERIM_PUBLIC_READ_LOAD_ERROR_CODES, ...INTERIM_PUBLIC_READ_ERROR_CODES]);

async function exportFile(name = "export.json", bytes = BYTES) {
  const path = join(scratch, name);
  await writeFile(path, bytes);
  return path;
}

function flags(file, overrides = {}) {
  const values = {
    "--export": file, "--sha256": SHA, "--captured-at": FIXTURE_CAPTURED_AT,
    "--source-commit": FIXTURE_SOURCE_COMMIT, "--evidence-date": FIXTURE_EVIDENCE_DATE, ...overrides,
  };
  return Object.entries(values).filter(([, value]) => value !== undefined).flat();
}

async function run(argv, options = {}) {
  let out = "";
  let err = "";
  const code = await runInterimPublicReadLoad(argv, {
    env: {}, stdout: { write: (value) => { out += value; } }, stderr: { write: (value) => { err += value; } },
    ...options,
  });
  return { code, out, err };
}

// ---------------------------------------------------------------------------
// A recording fake pool
// ---------------------------------------------------------------------------

/** A pool whose client answers by statement text and records every call. */
function fakePool({ published = false, tables = true, conflict = false, stored = undefined, fail = undefined } = {}) {
  const calls = [];
  const released = [];
  let ended = 0;
  const client = {
    async query(text, values) {
      const sql = String(text).replace(/\s+/gu, " ").trim();
      calls.push({ sql, values });
      if (fail !== undefined && fail.test(sql)) throw Object.assign(new Error("synthetic driver failure with text"), { code: "57014" });
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT to_regclass")) return { rows: [{ frozen: tables, published: tables }], rowCount: 1 };
      if (sql.startsWith("SELECT EXISTS")) return { rows: [{ published }], rowCount: 1 };
      if (sql.startsWith("INSERT INTO")) return { rows: conflict ? [] : [{ id: 1 }], rowCount: conflict ? 0 : 1 };
      if (sql.startsWith("SELECT f.payload_text")) {
        return { rows: [stored ?? {}], rowCount: 1 };
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
    release(discard) { released.push(discard); },
  };
  return {
    calls, released, get ended() { return ended; },
    async connect() { return client; },
    async end() { ended += 1; },
  };
}

/** The row the fake returns for the prepared record. */
function rowFor(record) {
  return {
    payload_text: record.payloadText, payload_sha256: record.payloadSha256, captured_at: record.capturedAt,
    source_commit: record.sourceCommit, evidence_date: record.evidenceDate,
  };
}

async function prepared(body = BODY, facts = {}) {
  const bytes = exportBytes(body);
  const { prepared: result } = await checkInterimPublicRead({
    exportBytes: bytes, sha256: sha256Hex(bytes), capturedAt: FIXTURE_CAPTURED_AT,
    sourceCommit: FIXTURE_SOURCE_COMMIT, evidenceDate: body.to, ...facts,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

test("arguments: both flag forms, the closed flag set, and the per-command requirements", async () => {
  const file = "/tmp/export.json";
  const spaced = parseInterimLoadArguments(["check", ...flags(file)]);
  assert.deepEqual({ ...spaced }, {
    command: "check", exportPath: file, sha256: SHA, capturedAt: FIXTURE_CAPTURED_AT,
    sourceCommit: FIXTURE_SOURCE_COMMIT, evidenceDate: FIXTURE_EVIDENCE_DATE,
  });
  const pairs = flags(file);
  const joined = [];
  for (let index = 0; index < pairs.length; index += 2) joined.push(`${pairs[index]}=${pairs[index + 1]}`);
  const equals = parseInterimLoadArguments(["load", ...joined, "--schema=tibotattle_primary"]);
  assert.equal(equals.command, "load");
  assert.equal(equals.schema, "tibotattle_primary");
  assert.equal(equals.sha256, SHA);
  const refused = (argv) => assert.throws(() => parseInterimLoadArguments(argv),
    (error) => error instanceof GcpInterimPublicReadLoadError && error.code === "INTERIM_PUBLIC_READ_LOAD_USAGE");
  refused([]);
  refused(["dry-run", ...flags(file)]);
  refused(["check"]);
  for (const missing of ["--export", "--sha256", "--captured-at", "--source-commit", "--evidence-date"]) {
    refused(["check", ...flags(file, { [missing]: undefined })]);
  }
  refused(["check", ...flags(file), "--unknown", "1"]);
  refused(["check", ...flags(file), "--sha256", SHA]);
  refused(["check", ...flags(file, { "--sha256": "" })]);
  refused(["check", ...flags(file).slice(0, -1)]);
  refused(["check", "stray", ...flags(file)]);
  refused(["check", ...flags(file), "--schema", "tibotattle_primary"]);
  refused(["load", ...flags(file)]);
  refused(["check", ...flags(file), "-x"]);
  assert.deepEqual(Object.keys(spaced).sort(), ["capturedAt", "command", "evidenceDate", "exportPath", "sha256", "sourceCommit"]);
});

// ---------------------------------------------------------------------------
// The export file
// ---------------------------------------------------------------------------

test("the export file: a regular, non-symlink file within the limit, read as exact bytes", async () => {
  const path = await exportFile("regular.json");
  assert.deepEqual(Buffer.from(await readInterimExportFile(path)), Buffer.from(BYTES));
  const code = (error) => error instanceof GcpInterimPublicReadLoadError
    && error.code === "INTERIM_PUBLIC_READ_LOAD_EXPORT_FILE_INVALID";
  await assert.rejects(readInterimExportFile(join(scratch, "missing.json")), code);
  await assert.rejects(readInterimExportFile(scratch), code);
  const link = join(scratch, "link.json");
  await symlink(path, link);
  await assert.rejects(readInterimExportFile(link), code);
  const big = join(scratch, "big.json");
  await writeFile(big, new Uint8Array(INTERIM_PUBLIC_READ_MAX_BYTES + 1));
  await assert.rejects(readInterimExportFile(big), code);
  const limit = join(scratch, "limit.json");
  await writeFile(limit, new Uint8Array(INTERIM_PUBLIC_READ_MAX_BYTES));
  assert.equal((await readInterimExportFile(limit)).byteLength, INTERIM_PUBLIC_READ_MAX_BYTES);
  for (const bad of ["", "a\0b", undefined, 5, null]) await assert.rejects(readInterimExportFile(bad), code);
});

// ---------------------------------------------------------------------------
// Check mode
// ---------------------------------------------------------------------------

test("check: validates and receipts the export without opening any connection", async () => {
  const file = await exportFile("check.json");
  const never = async () => { throw new Error("check must not open a connection"); };
  const result = await run(["check", ...flags(file)], { createPool: never });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  assert.equal(result.out.split("\n").filter(Boolean).length, 1, "one JSON line");
  const receipt = JSON.parse(result.out);
  assert.deepEqual(Object.keys(receipt), ["schema", "mode", "payloadSha256", "capturedAt", "sourceCommit", "evidenceDate", "export"]);
  assert.equal(receipt.schema, GCP_INTERIM_PUBLIC_READ_LOAD_RECEIPT_SCHEMA);
  assert.equal(receipt.mode, "check");
  assert.equal(receipt.payloadSha256, SHA);
  assert.equal(receipt.capturedAt, FIXTURE_CAPTURED_AT);
  assert.equal(receipt.export.from, "2025-10-01");
  assert.equal(receipt.export.to, FIXTURE_EVIDENCE_DATE);
  assert.equal(receipt.export.dayCount, BODY.days.length);
  assert.equal(receipt.export.bytes, BYTES.byteLength);
  // Deterministic and content-free: counts, days and digests only.
  assert.equal((await run(["check", ...flags(file)])).out, result.out);
  for (const content of ["payloadText", "capacityByPlanType", "gpt-5.6-sol", "cells", "totals"]) {
    assert.equal(result.out.includes(content), false, content);
  }
  // A shortened capture instant is normalized in the receipt.
  const shortened = JSON.parse((await run(["check", ...flags(file, { "--captured-at": "2026-10-01T23:30:00Z" })])).out);
  assert.equal(shortened.capturedAt, FIXTURE_CAPTURED_AT);
  // The dense golden: another valid shape.
  const dense = denseGoldenExportBody();
  const denseFile = await exportFile("dense.json", exportBytes(dense));
  const denseReceipt = JSON.parse((await run(["check", ...flags(denseFile, { "--sha256": sha256Hex(exportBytes(dense)) })])).out);
  assert.equal(denseReceipt.export.allowanceReadState, "temporarily_unavailable");
});

test("check: every refusal is one closed code on stderr, exit 1, and no value is echoed", async () => {
  const marker = "synthetic-secret-marker-9c41";
  const poisoned = structuredClone(BODY);
  poisoned.days[0].payload[marker] = marker;
  const poisonedFile = await exportFile("poisoned.json", exportBytes(poisoned));
  const goodFile = await exportFile("good.json");
  const cases = [
    [flags(goodFile, { "--sha256": "0".repeat(64) }), "INTERIM_PUBLIC_READ_SHA256_MISMATCH"],
    [flags(goodFile, { "--sha256": SHA.toUpperCase() }), "INTERIM_PUBLIC_READ_PIN_INVALID"],
    [flags(goodFile, { "--source-commit": "main" }), "INTERIM_PUBLIC_READ_METADATA_INVALID"],
    [flags(goodFile, { "--captured-at": "yesterday" }), "INTERIM_PUBLIC_READ_METADATA_INVALID"],
    [flags(goodFile, { "--evidence-date": "2026-10-02" }), "INTERIM_PUBLIC_READ_METADATA_INVALID"],
    [flags(poisonedFile, { "--sha256": sha256Hex(exportBytes(poisoned)) }), "INTERIM_PUBLIC_READ_CONTRACT_INVALID"],
    [flags(goodFile, { "--evidence-date": "2026-10-02", "--captured-at": "2026-10-02T01:00:00Z" }), "INTERIM_PUBLIC_READ_EVIDENCE_INCONSISTENT"],
    [flags(join(scratch, "absent.json")), "INTERIM_PUBLIC_READ_LOAD_EXPORT_FILE_INVALID"],
  ];
  for (const [argv, expected] of cases) {
    const result = await run(["check", ...argv]);
    assert.equal(result.code, 1, expected);
    assert.equal(result.out, "");
    const { error } = JSON.parse(result.err);
    assert.equal(error.code, expected);
    assert.ok(KNOWN_CODES.has(error.code), "a closed code");
    assert.equal(result.err.includes(marker), false, "no value from the export is echoed");
  }
  const contract = JSON.parse((await run(["check", ...flags(poisonedFile, { "--sha256": sha256Hex(exportBytes(poisoned)) })])).err);
  assert.equal(contract.error.detail, "days[0].payload.*", "a structural path, never the key");
});

test("usage errors exit 2, and --help exits 0 with the usage text", async () => {
  for (const argv of [[], ["check"], ["frobnicate"], ["check", "--export"], ["load", "--schema", "x"]]) {
    const result = await run(argv);
    assert.equal(result.code, 2, JSON.stringify(argv));
    assert.equal(JSON.parse(result.err).error.code, "INTERIM_PUBLIC_READ_LOAD_USAGE");
  }
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /^usage: gcp-interim-public-read-load\.mjs <check\|load>/u);
});

// ---------------------------------------------------------------------------
// The local target
// ---------------------------------------------------------------------------

test("the local target: a private socket directory or a loopback host, nothing else", { skip: SKIP_PRIVATE_TMP }, async () => {
  const root = await mkdtemp("/private/tmp/tibotattle-pg-ipr-check-");
  try {
    const socket = join(root, "socket");
    await mkdir(socket, { mode: 0o700 });
    await chmod(socket, 0o700);
    const target = await localInterimTarget({ PG_TEST_SOCKET: socket, PG_TEST_PORT: "55433" });
    assert.deepEqual({ ...target }, { host: socket, port: 55433, user: "postgres", database: "postgres" });
    assert.equal((await localInterimTarget({ PG_TEST_HOST: socket })).host, socket);
    assert.equal((await localInterimTarget({ PG_TEST_HOST: "127.0.0.1", PG_TEST_USER: "u", PG_TEST_DATABASE: "d" })).host, "127.0.0.1");
    assert.equal((await localInterimTarget({ PG_TEST_HOST: "localhost" })).port, 55432);
    const code = (expected) => (error) => error instanceof GcpInterimPublicReadLoadError && error.code === expected;
    await assert.rejects(localInterimTarget({}), code("INTERIM_PUBLIC_READ_LOAD_TARGET_UNCONFIGURED"));
    for (const env of [
      { PG_TEST_HOST: "db.example.com" }, { PG_TEST_HOST: "10.0.0.5" }, { PG_TEST_HOST: "::2" },
      { PG_TEST_SOCKET: "/var/run/postgresql" }, { PG_TEST_SOCKET: "/private/tmp/other/socket" },
      { PG_TEST_SOCKET: join(root, "missing", "socket") },
      { PG_TEST_HOST: "127.0.0.1", PG_TEST_PORT: "0" }, { PG_TEST_HOST: "127.0.0.1", PG_TEST_PORT: "70000" },
      { PG_TEST_HOST: "127.0.0.1", PG_TEST_PORT: "abc" },
    ]) {
      await assert.rejects(localInterimTarget(env), code("INTERIM_PUBLIC_READ_LOAD_TARGET_UNSUPPORTED"), JSON.stringify(env));
    }
    // A group-readable directory and a symlinked one are refused.
    await chmod(socket, 0o750);
    await assert.rejects(localInterimTarget({ PG_TEST_SOCKET: socket }), code("INTERIM_PUBLIC_READ_LOAD_TARGET_UNSUPPORTED"));
    await chmod(socket, 0o700);
    const other = join(root, "other");
    await mkdir(other, { mode: 0o700 });
    const alias = await mkdtemp("/private/tmp/tibotattle-pg-ipr-link-");
    try {
      await symlink(other, join(alias, "socket"));
      await assert.rejects(localInterimTarget({ PG_TEST_SOCKET: join(alias, "socket") }), code("INTERIM_PUBLIC_READ_LOAD_TARGET_UNSUPPORTED"));
    } finally {
      await rm(alias, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load through the command line refuses a target that is not local before it connects", async () => {
  const file = await exportFile("target.json");
  const never = async () => { throw new Error("must not connect"); };
  for (const env of [{}, { PG_TEST_HOST: "db.example.com" }, { PG_TEST_SOCKET: "/var/run/postgresql" }]) {
    const result = await run(["load", ...flags(file), "--schema", "tibotattle_primary"], { env, createPool: never });
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.err).error.code, /^INTERIM_PUBLIC_READ_LOAD_TARGET_(UNCONFIGURED|UNSUPPORTED)$/u);
  }
  const badSchema = await run(["load", ...flags(file), "--schema", "Bad-Schema"], { env: { PG_TEST_HOST: "127.0.0.1" }, createPool: never });
  assert.equal(JSON.parse(badSchema.err).error.code, "INTERIM_PUBLIC_READ_LOAD_SCHEMA_INVALID");
  // The export is checked before any target is looked at: a bad pin never reaches the connection.
  const badPin = await run(["load", ...flags(file, { "--sha256": "1".repeat(64) }), "--schema", "tibotattle_primary"],
    { env: { PG_TEST_HOST: "127.0.0.1" }, createPool: never });
  assert.equal(JSON.parse(badPin.err).error.code, "INTERIM_PUBLIC_READ_SHA256_MISMATCH");
});

// ---------------------------------------------------------------------------
// The load transaction
// ---------------------------------------------------------------------------

test("load: one bounded transaction in a fixed order, the insert's values, a verified read-back", async () => {
  const target = await prepared();
  const pool = fakePool({ stored: rowFor(target.record) });
  const receipt = await loadInterimPublicRead({ pool, schema: "tibotattle_primary", prepared: target });
  assert.equal(receipt.state, "loaded");
  assert.equal(receipt.mode, "load");
  assert.equal(receipt.payloadSha256, SHA);
  assert.deepEqual(pool.calls.map(({ sql }) => sql.split(" ").slice(0, 3).join(" ")), [
    "BEGIN", "SET LOCAL statement_timeout", "SET LOCAL lock_timeout", "SELECT to_regclass($1) IS",
    "SELECT EXISTS (SELECT", "INSERT INTO \"tibotattle_primary\".\"community_daily_frozen_export\"", "SELECT f.payload_text::text AS", "COMMIT",
  ]);
  const insert = pool.calls.find(({ sql }) => sql.startsWith("INSERT INTO"));
  assert.deepEqual(insert.values, [target.record.payloadText, SHA, FIXTURE_CAPTURED_AT, FIXTURE_SOURCE_COMMIT, FIXTURE_EVIDENCE_DATE]);
  assert.match(insert.sql, /ON CONFLICT \(id\) DO NOTHING RETURNING id/u);
  assert.deepEqual(pool.calls.find(({ sql }) => sql.startsWith("SELECT to_regclass")).values,
    ['"tibotattle_primary"."community_daily_frozen_export"', '"tibotattle_primary"."analytics_v2_published_daily"']);
  assert.deepEqual(pool.released, [undefined], "the connection is returned, not discarded");
});

test("load: an identical stored row is a no-op, a different one is refused, and every refusal rolls back", async () => {
  const target = await prepared();
  const same = fakePool({ conflict: true, stored: rowFor(target.record) });
  assert.equal((await loadInterimPublicRead({ pool: same, schema: "s", prepared: target })).state, "already-loaded");
  assert.ok(same.calls.some(({ sql }) => sql === "COMMIT"));

  const other = await prepared(denseGoldenExportBody());
  const different = fakePool({ conflict: true, stored: rowFor(other.record) });
  await assert.rejects(loadInterimPublicRead({ pool: different, schema: "s", prepared: target }), (error) => {
    assert.equal(error.code, "INTERIM_PUBLIC_READ_LOAD_ALREADY_LOADED_DIFFERENT");
    assert.equal(error.detail, other.record.payloadSha256);
    return true;
  });
  assert.equal(different.calls.at(-1).sql, "ROLLBACK");
  assert.equal(different.calls.some(({ sql }) => sql === "COMMIT"), false);

  // An existing row that does not verify is as different as one that verifies to another export.
  const corrupt = fakePool({ conflict: true, stored: { ...rowFor(target.record), payload_text: "{}" } });
  await assert.rejects(loadInterimPublicRead({ pool: corrupt, schema: "s", prepared: target }),
    (error) => error.code === "INTERIM_PUBLIC_READ_LOAD_ALREADY_LOADED_DIFFERENT" && error.detail === null);
  // A fresh insert whose read-back disagrees is a read-back failure, not a conflict.
  const mismatch = fakePool({ stored: rowFor(other.record) });
  await assert.rejects(loadInterimPublicRead({ pool: mismatch, schema: "s", prepared: target }),
    (error) => error.code === "INTERIM_PUBLIC_READ_LOAD_READBACK_MISMATCH");
  assert.equal(mismatch.calls.at(-1).sql, "ROLLBACK");

  const published = fakePool({ published: true, stored: rowFor(target.record) });
  await assert.rejects(loadInterimPublicRead({ pool: published, schema: "s", prepared: target }),
    (error) => error.code === "INTERIM_PUBLIC_READ_LOAD_PUBLICATION_EXISTS");
  assert.equal(published.calls.some(({ sql }) => sql.startsWith("INSERT")), false, "nothing is written after a publication");
  assert.equal(published.calls.at(-1).sql, "ROLLBACK");

  const missing = fakePool({ tables: false });
  await assert.rejects(loadInterimPublicRead({ pool: missing, schema: "s", prepared: target }),
    (error) => error.code === "INTERIM_PUBLIC_READ_LOAD_TABLE_MISSING");
  assert.equal(missing.calls.some(({ sql }) => sql.startsWith("SELECT EXISTS")), false);
});

test("load: a driver failure is one closed code with only its SQLSTATE, rolled back, connection discarded on a failed rollback", async () => {
  const target = await prepared();
  const failing = fakePool({ fail: /^INSERT INTO/u, stored: rowFor(target.record) });
  await assert.rejects(loadInterimPublicRead({ pool: failing, schema: "s", prepared: target }), (error) => {
    assert.equal(error.code, "INTERIM_PUBLIC_READ_LOAD_WRITE_FAILED");
    assert.equal(error.detail, "57014");
    assert.equal(error.message.includes("synthetic"), false);
    return true;
  });
  assert.equal(failing.calls.at(-1).sql, "ROLLBACK");
  assert.deepEqual(failing.released, [true], "a connection that failed mid-transaction is discarded");

  const both = fakePool({ fail: /^(INSERT INTO|ROLLBACK)/u, stored: rowFor(target.record) });
  await assert.rejects(loadInterimPublicRead({ pool: both, schema: "s", prepared: target }),
    (error) => error.code === "INTERIM_PUBLIC_READ_LOAD_WRITE_FAILED");
  assert.deepEqual(both.released, [true]);

  const connectFails = { connect: async () => { throw new Error("synthetic connect failure"); } };
  await assert.rejects(loadInterimPublicRead({ pool: connectFails, schema: "s", prepared: target }),
    (error) => error.code === "INTERIM_PUBLIC_READ_LOAD_WRITE_FAILED" && error.detail === "connect");
  await assert.rejects(loadInterimPublicRead({ pool: {}, schema: "s", prepared: target }),
    (error) => error.code === "INTERIM_PUBLIC_READ_LOAD_USAGE");
  await assert.rejects(loadInterimPublicRead({ pool: fakePool(), schema: "s", prepared: null }),
    (error) => error.code === "INTERIM_PUBLIC_READ_LOAD_USAGE");
});

test("load in a caller's transaction issues no transaction control and leaves the rollback to the caller", async () => {
  const target = await prepared();
  const pool = fakePool({ stored: rowFor(target.record) });
  const client = await pool.connect();
  const receipt = await loadInterimPublicReadInTransaction({ client, schema: "tibotattle_primary", prepared: target });
  assert.equal(receipt.state, "loaded");
  assert.deepEqual(pool.calls.map(({ sql }) => sql.split(" ").slice(0, 2).join(" ")), [
    "SELECT to_regclass($1)", "SELECT EXISTS", "INSERT INTO", "SELECT f.payload_text::text",
  ], "no BEGIN, SET LOCAL, COMMIT or ROLLBACK: the caller's transaction is the caller's");
  assert.deepEqual(pool.released, [], "the caller's connection is not released here");
  // A refusal throws and still issues no ROLLBACK.
  const refusing = fakePool({ published: true });
  await assert.rejects(loadInterimPublicReadInTransaction({ client: await refusing.connect(), schema: "s", prepared: target }),
    (error) => error.code === "INTERIM_PUBLIC_READ_LOAD_PUBLICATION_EXISTS");
  assert.equal(refusing.calls.some(({ sql }) => /^(ROLLBACK|COMMIT|BEGIN)/u.test(sql)), false);
  for (const bad of [null, {}, "client"]) {
    await assert.rejects(loadInterimPublicReadInTransaction({ client: bad, schema: "s", prepared: target }),
      (error) => error.code === "INTERIM_PUBLIC_READ_LOAD_USAGE");
  }
  await assert.rejects(loadInterimPublicReadInTransaction({ client, schema: "Bad", prepared: target }),
    (error) => error.code === "INTERIM_PUBLIC_READ_LOAD_SCHEMA_INVALID");
});

test("load through the command line closes the pool it opened, on success and on failure", { skip: SKIP_PRIVATE_TMP }, async () => {
  const file = await exportFile("close.json");
  const target = await prepared();
  const root = await mkdtemp("/private/tmp/tibotattle-pg-ipr-cli-");
  try {
    const socket = join(root, "socket");
    await mkdir(socket, { mode: 0o700 });
    await chmod(socket, 0o700);
    const env = { PG_TEST_SOCKET: socket };
    const ok = fakePool({ stored: rowFor(target.record) });
    const loaded = await run(["load", ...flags(file), "--schema", "tibotattle_primary"], { env, createPool: async () => ok });
    assert.equal(loaded.code, 0, loaded.err);
    assert.equal(JSON.parse(loaded.out).state, "loaded");
    assert.equal(ok.ended, 1);
    const refusing = fakePool({ published: true });
    const refused = await run(["load", ...flags(file), "--schema", "tibotattle_primary"], { env, createPool: async () => refusing });
    assert.equal(refused.code, 1);
    assert.equal(JSON.parse(refused.err).error.code, "INTERIM_PUBLIC_READ_LOAD_PUBLICATION_EXISTS");
    assert.equal(refusing.ended, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every code the loader can throw is in its closed lists", () => {
  assert.equal(new Set(GCP_INTERIM_PUBLIC_READ_LOAD_ERROR_CODES).size, GCP_INTERIM_PUBLIC_READ_LOAD_ERROR_CODES.length);
  assert.ok(Object.isFrozen(GCP_INTERIM_PUBLIC_READ_LOAD_ERROR_CODES));
  assert.equal(new GcpInterimPublicReadLoadError("INTERIM_PUBLIC_READ_LOAD_USAGE").detail, null);
});
