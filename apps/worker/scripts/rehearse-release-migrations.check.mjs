import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { inspectMigrationPrefix, main, observeMigrationPrefix, rehearseRemoteSyntax, runMigrationRehearsal, runMigrationRehearsalProcess } from "./rehearse-release-migrations.mjs";

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = value => createHash("sha256").update(value).digest("hex");
async function prefix(primary = 42, ledger = 1, root = workerRoot) {
  const migrations = {};
  for (const [binding, dir, count] of [["USAGE_MONITOR_DB", "migrations", primary], ["DELETION_LEDGER", "deletion-ledger-migrations", ledger]]) {
    const names = (await readdir(join(root, dir))).sort().slice(0, count);
    migrations[binding] = await Promise.all(names.map(async name => ({ name, sha256: sha(await readFile(join(root, dir, name))) })));
  }
  return { schemaVersion: "release-migration-prefix-v1", observedAt: "2026-09-08T12:00:00.000Z", environment: "reviewed-snapshot", migrations };
}
const target = { schemaVersion: 1, purpose: "release-migration-rehearsal", databases: {
  USAGE_MONITOR_DB: { database_name: "tibotattle-rehearsal-primary", database_id: "12345678-1111-1111-1111-123456789abc" },
  DELETION_LEDGER: { database_name: "tibotattle-rehearsal-ledger", database_id: "12345678-2222-2222-2222-123456789abc" },
} };
const confirm = "APPLY_SYNTHETIC_MIGRATIONS_TO_DISPOSABLE_D1";
const response = results => ({ status: 0, stdout: JSON.stringify([{ success: true, results }]) });

test("exact supplied prefix admits pending hashes but never claims live lineage or production readiness", async () => {
  const result = await inspectMigrationPrefix({ prefix: await prefix() });
  assert.equal(result.freshness, "supplied-snapshot-not-live");
  assert.equal(result.migrations.USAGE_MONITOR_DB.pending[0].name, "0043_analytical_input_fencing.sql");
  assert.match(result.migrationDigest, /^[0-9a-f]{64}$/);
});

test("prefix admission rejects gaps, reorders, old schema, unknown fields, and changed migration bytes", async () => {
  for (const mutate of [p => p.migrations.USAGE_MONITOR_DB.splice(3, 1), p => p.migrations.USAGE_MONITOR_DB.reverse(),
    p => { p.migrations.USAGE_MONITOR_DB[0].sha256 = "f".repeat(64); }, p => { p.secret = "never-echo"; },
    p => { p.migrations.USAGE_MONITOR_DB = p.migrations.USAGE_MONITOR_DB.slice(0, 30); }]) {
    const p = await prefix(); mutate(p);
    await assert.rejects(inspectMigrationPrefix({ prefix: p }), /MIGRATION_PREFIX_/);
  }
});

test("read-only observation uses fixed ledger SELECT for both exact environments and excludes payloads", async () => {
  const p = await prefix(), calls = [];
  const observed = await observeMigrationPrefix({ environment: "production", spawn: (_command, args) => {
    calls.push(args);
    assert.deepEqual(args.slice(0, 2), ["d1", "execute"]);
    assert.equal(args[args.indexOf("--command") + 1], "SELECT name FROM d1_migrations ORDER BY id;");
    assert.equal(args[args.indexOf("--env") + 1], "production");
    return response(p.migrations[args[2]].map(({ name }) => ({ name })));
  } });
  assert.equal(calls.length, 2);
  assert.equal(observed.environment, "production");
  assert.deepEqual(observed.migrations, p.migrations);
});

test("observation refuses unknown environment, ledger drift, bad responses and redacts raw errors", async () => {
  await assert.rejects(observeMigrationPrefix({ environment: "preview", spawn: () => assert.fail("must not run") }), /ENVIRONMENT_INVALID/);
  for (const spawn of [() => response([{ name: "unknown.sql" }]), () => ({ status: 0, stdout: "private-output" }),
    () => ({ status: 1, stderr: "private-secret" }), () => { throw new Error("private-path"); }]) {
    await assert.rejects(observeMigrationPrefix({ environment: "staging", spawn }), error => !error.message.includes("private-") && /(?:MIGRATION|REHEARSAL)_/.test(error.message));
  }
});

test("real populated SQLite upgrades 0042 onward preserve every retained row through interruptions and no-op replay", async () => {
  const result = await runMigrationRehearsal({ prefix: await prefix(), accounts: 7, events: 201 });
  assert.equal(result.ok, true);
  assert.equal(result.productionReadiness, false);
  assert.equal(result.receipts.USAGE_MONITOR_DB.preserved.participants.count, 7);
  assert.equal(result.receipts.USAGE_MONITOR_DB.preserved.telemetry_v1_records.count, 201);
  assert.equal(result.receipts.USAGE_MONITOR_DB.preserved.telemetry_records.count, 201);
  assert.equal(result.receipts.USAGE_MONITOR_DB.preserved.telemetry_v1_device_consents.count, 7);
  assert.equal(result.receipts.USAGE_MONITOR_DB.preserved.identity_reenrollment_cooldowns.count, 7);
  assert.equal(result.receipts.DELETION_LEDGER.preserved.deletion_tombstones.count, 7);
  assert.equal(result.receipts.USAGE_MONITOR_DB.replayWrites, 0);
  assert.equal(result.receipts.DELETION_LEDGER.replayWrites, 0);
  assert.equal(result.remoteSyntax, "not-exercised");
});

test("modern minimum prefix 0031 is covered without relaxing native SQLite triggers", async () => {
  const result = await runMigrationRehearsal({ prefix: await prefix(31, 1), accounts: 2, events: 4 });
  assert.equal(result.ok, true);
  assert.equal(result.receipts.USAGE_MONITOR_DB.preserved.device_credentials.count, 2);
});

test("1000 synthetic accounts with heavy-account skew qualify latest forward migrations within stated ceilings", async () => {
  const result = await runMigrationRehearsal({ prefix: await prefix(53, 2), accounts: 1000, events: 10_000 });
  assert.equal(result.receipts.USAGE_MONITOR_DB.preserved.participants.count, 1000);
  assert.equal(result.receipts.USAGE_MONITOR_DB.preserved.telemetry_v1_records.count, 10_000);
  assert.equal(result.receipts.DELETION_LEDGER.preserved.identity_reenrollment_cooldowns.count, 1000);
  assert.ok(result.peakRssBytes < result.limits.maxRssBytes);
});

test("invalid and exceeded resource ceilings never produce a completed receipt", async () => {
  const p = await prefix();
  for (const options of [{ accounts: 1 }, { events: 1_000_001 }, { maxDurationMs: 600_001 }, { maxRssBytes: 2 ** 32 }]) {
    await assert.rejects(runMigrationRehearsal({ prefix: p, ...options }), /REHEARSAL_LIMITS_INVALID/);
  }
  await assert.rejects(runMigrationRehearsal({ prefix: p, accounts: 2, events: 2, maxDatabaseBytes: 1 }), /RESOURCE_CEILING_EXCEEDED/);
});

test("destructive pending SQL is detected by populated preservation assertions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rehearsal-negative-"));
  try {
    await cp(join(workerRoot, "migrations"), join(dir, "migrations"), { recursive: true });
    await cp(join(workerRoot, "deletion-ledger-migrations"), join(dir, "deletion-ledger-migrations"), { recursive: true });
    const names = (await readdir(join(dir, "migrations"))).sort(), last = join(dir, "migrations", names.at(-1));
    await writeFile(last, `${await readFile(last, "utf8")}\nDELETE FROM telemetry_v1_records;\n`);
    await assert.rejects(runMigrationRehearsal({ workerRoot: dir, prefix: await prefix(53, 2, dir), accounts: 2, events: 4 }), /PRESERVATION_FAILED/);
  } finally { await rm(dir, { recursive: true }); }
});

test("reopened forward connection reapplies page ceiling before a growing pending migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rehearsal-page-ceiling-"));
  try {
    await cp(join(workerRoot, "migrations"), join(dir, "migrations"), { recursive: true });
    await cp(join(workerRoot, "deletion-ledger-migrations"), join(dir, "deletion-ledger-migrations"), { recursive: true });
    const names = (await readdir(join(dir, "migrations"))).sort(), last = join(dir, "migrations", names.at(-1));
    await writeFile(last, `${await readFile(last, "utf8")}\nCREATE TABLE rehearsal_page_ceiling (ceiling INTEGER CHECK (ceiling <= 512), payload BLOB);\nINSERT INTO rehearsal_page_ceiling SELECT max_page_count, zeroblob(400000) FROM pragma_max_page_count;\n`);
    const result = await runMigrationRehearsal({ workerRoot: dir, prefix: await prefix(55, 2, dir), accounts: 2, events: 4,
      maxDatabaseBytes: 2 * 1024 * 1024 });
    assert.equal(result.ok, true);
    assert.ok(result.receipts.USAGE_MONITOR_DB.databaseBytes <= 2 * 1024 * 1024);
  } finally { await rm(dir, { recursive: true }); }
});

test("remote mode requires separate confirmation before any subprocess", async () => {
  await assert.rejects(rehearseRemoteSyntax({ prefix: await prefix(), target, spawn: () => assert.fail("must not run") }), /CONFIRMATION_REQUIRED/);
});

test("remote syntax refuses all configured database identities including production and staging", async () => {
  for (const file of ["wrangler.jsonc", "wrangler.dogfood.jsonc"]) {
    const config = parse(await readFile(join(workerRoot, file), "utf8"));
    for (const environment of [config, ...Object.values(config.env ?? {})]) for (const db of environment.d1_databases ?? []) {
    const bad = structuredClone(target); bad.databases.USAGE_MONITOR_DB.database_id = db.database_id;
    await assert.rejects(rehearseRemoteSyntax({ prefix: await prefix(), target: bad, confirmation: confirm,
      spawn: () => assert.fail("must not run") }), /TARGET_FORBIDDEN/);
    }
  }
});

test("occupied disposable target refuses before mutation, malformed response also refuses", async () => {
  for (const value of [response([{ n: 1 }]), { status: 0, stdout: "[]" }]) {
    const calls = [];
    await assert.rejects(rehearseRemoteSyntax({ prefix: await prefix(), target, confirmation: confirm,
      spawn: (_cmd, args) => { calls.push(args); return value; } }), /(?:TARGET_NOT_EMPTY|RESULT_INVALID)/);
    assert.ok(calls.every(args => args[1] === "execute" && args.includes("--command") && !args.includes("--file")));
  }
});

test("remote syntax uses only isolated config and generated synthetic SQL, validates ledgers and counts", async () => {
  const p = await prefix(53, 2), final = await prefix(56, 2), calls = [];
  const result = await rehearseRemoteSyntax({ prefix: p, target, confirmation: confirm, spawn: (_cmd, args) => {
    calls.push(args);
    assert.ok(args.includes("--config")); assert.ok(args.includes("--remote")); assert.ok(!args.includes("--env"));
    if (args[1] === "migrations") return { status: 0, stdout: "applied" };
    const sql = args[args.indexOf("--command") + 1];
    if (sql?.includes("sqlite_master")) return response([{ n: 0 }]);
    if (sql?.includes("d1_migrations")) return response(final.migrations[args[2]].map(({ name }) => ({ name })));
    if (sql?.includes("COUNT(*)")) return response([args[2] === "USAGE_MONITOR_DB"
      ? { participants: 2, device_credentials: 2, telemetry_v1_device_consents: 2, telemetry_v1_records: 20, telemetry_records: 20, identity_reenrollment_cooldowns: 2 }
      : { deletion_tombstones: 2, identity_reenrollment_cooldowns: 2 }]);
    assert.ok(args.includes("--file")); return response([]);
  } });
  assert.equal(result.ok, true); assert.equal(result.productionReadiness, false);
  assert.equal(calls.filter(args => args[1] === "migrations").length, 4);
});

test("ambiguous remote mutation is not blindly retried and raw output is never propagated", async () => {
  let writes = 0;
  await assert.rejects(rehearseRemoteSyntax({ prefix: await prefix(), target, confirmation: confirm, spawn: (_cmd, args) => {
    if (args[1] !== "migrations") return response([{ n: 0 }]);
    writes++; return { status: 1, stderr: "private-value" };
  } }), /REMOTE_REHEARSAL_OUTCOME_UNCERTAIN/);
  assert.equal(writes, 1);
});

test("CLI rejects mixed modes, duplicate flags and implicit remote operation", async () => {
  for (const args of [["local", "--remote", "yes"], ["local", "--prefix", "x", "--prefix", "y"],
    ["observe-prefix", "--target", "anything"], ["remote-syntax"]]) await assert.rejects(main(args), /USAGE_INVALID/);
});

test("CLI containment runs actual exact-node worker and returns only bound completed proof", async () => {
  const result = await runMigrationRehearsalProcess({ prefix: await prefix(53, 2), accounts: 2, events: 20 });
  assert.equal(result.ok, true);
  assert.equal(result.containment.processGroup, true);
  assert.equal(result.containment.terminationConfirmed, true);
});

test("outer watchdog terminates an actually stuck subprocess group, even when SIGTERM is ignored", async () => {
  const signals = [];
  await assert.rejects(runMigrationRehearsalProcess({ prefix: await prefix(), accounts: 2, events: 20, timeoutMs: 100,
    signal: (pid, name) => { signals.push(name); process.kill(-pid, name); },
    spawn: (_node, _args, options) => spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"], options),
  }), /REHEARSAL_PROCESS_TIMEOUT/);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("watchdog rejects malformed worker output and never propagates raw stderr", async () => {
  await assert.rejects(runMigrationRehearsalProcess({ prefix: await prefix(),
    spawn: (_node, _args, options) => spawn(process.execPath, ["-e", "process.stdout.write('not-json');process.stderr.write('private-canary');"], options),
  }), error => error.message === "REHEARSAL_PROCESS_RESULT_INVALID");
});

test("parent rejects well-shaped receipts with changed pending bytes, fixture, limits or runtime", async () => {
  const p = await prefix(53, 2), valid = await runMigrationRehearsal({ prefix: p, accounts: 2, events: 20 });
  for (const mutate of [value => { value.migrationDigest = "f".repeat(64); },
    value => { value.limits.maxRssBytes *= 2; }, value => { value.limits.maxDurationMs += 1; },
    value => { value.fixture.eventsPerTelemetryTable += 1; }, value => { value.runtime.sqlite = "unreviewed"; },
    value => { value.migrations.USAGE_MONITOR_DB.pending[0].sha256 = "e".repeat(64); },
    value => { value.receipts.USAGE_MONITOR_DB.preserved.telemetry_records.count = 0; },
    value => { value.receipts.USAGE_MONITOR_DB.steps[0].sha256 = "d".repeat(64); },
    value => { value.receipts.USAGE_MONITOR_DB.preserved.privatePayload = { count: 0, sha256: "a".repeat(64) }; }]) {
    const bad = structuredClone(valid); mutate(bad);
    const encoded = Buffer.from(JSON.stringify(bad)).toString("base64");
    await assert.rejects(runMigrationRehearsalProcess({ prefix: p, accounts: 2, events: 20,
      spawn: (_node, _args, options) => spawn(process.execPath, ["-e", `process.stdout.write(Buffer.from('${encoded}','base64'));`], options),
    }), /REHEARSAL_PROCESS_RESULT_INVALID/);
  }
});

test("outer RSS ceiling stops an executing process and confirms termination", async () => {
  await assert.rejects(runMigrationRehearsalProcess({ prefix: await prefix(), memory: () => 2 ** 31,
    spawn: (_node, _args, options) => spawn(process.execPath, ["-e", "setInterval(()=>{},1000);"], options),
  }), /REHEARSAL_PROCESS_MEMORY_EXCEEDED/);
});

test("unconfirmed termination preserves the owned temporary database instead of claiming cleanup", async () => {
  let directory;
  try {
    await assert.rejects(runMigrationRehearsalProcess({ prefix: await prefix(), timeoutMs: 20, terminationGraceMs: 30, signal: () => {},
      spawn: () => {
        const child = new EventEmitter(); child.pid = 999999999;
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        child.stdin.on("data", input => { directory = JSON.parse(input.toString()).temporaryDirectory; });
        return child;
      },
    }), /REHEARSAL_TERMINATION_UNCONFIRMED/);
    assert.deepEqual(await readdir(directory), []);
  } finally { if (directory) await rm(directory, { recursive: true }); }
});
