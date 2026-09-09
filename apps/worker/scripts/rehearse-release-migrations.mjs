import { createHash } from "node:crypto";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import { validateMigrationInventory, validateMigrationSource } from "./release-preflight.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STREAMS = Object.freeze({ USAGE_MONITOR_DB: "migrations", DELETION_LEDGER: "deletion-ledger-migrations" });
const SCHEMA = "release-migration-rehearsal-v1";
const PREFIX_SCHEMA = "release-migration-prefix-v1";
const LEDGER_SQL = "SELECT name FROM d1_migrations ORDER BY id;";
const sha = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const quote = name => `"${name.replaceAll('"', '""')}"`;
const literal = value => value === null ? "NULL" : Buffer.isBuffer(value) ? `X'${value.toString("hex")}'`
  : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;

async function bundles(workerRoot) {
  const result = {}, inventory = {};
  for (const [binding, directory] of Object.entries(STREAMS)) {
    const entries = await readdir(join(workerRoot, directory), { withFileTypes: true });
    if (entries.some(entry => entry.name.endsWith(".sql") && !entry.isFile())) fail("MIGRATION_PATH_UNSAFE");
    inventory[binding] = entries.filter(entry => entry.name.endsWith(".sql")).map(entry => entry.name).sort();
    result[binding] = [];
    for (const name of inventory[binding]) {
      const path = join(workerRoot, directory, name), stat = await lstat(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576) fail("MIGRATION_PATH_UNSAFE");
      const sql = await readFile(path, "utf8"), validation = validateMigrationSource(name, sql);
      if (!validation.ok) fail(validation.code);
      result[binding].push({ name, sql, sha256: sha(sql) });
    }
  }
  const validation = validateMigrationInventory(inventory);
  if (!validation.ok) fail(validation.code);
  return result;
}

function validatePrefix(prefix, sources) {
  if (!exact(prefix, ["schemaVersion", "observedAt", "environment", "migrations"])
      || prefix.schemaVersion !== PREFIX_SCHEMA || !["production", "staging", "reviewed-snapshot"].includes(prefix.environment)
      || typeof prefix.observedAt !== "string" || !Number.isFinite(Date.parse(prefix.observedAt))
      || !exact(prefix.migrations, Object.keys(STREAMS))) fail("MIGRATION_PREFIX_INVALID");
  for (const binding of Object.keys(STREAMS)) {
    const list = prefix.migrations[binding];
    if (!Array.isArray(list) || list.length > sources[binding].length
        || list.some((entry, i) => !exact(entry, ["name", "sha256"])
          || entry.name !== sources[binding][i].name || entry.sha256 !== sources[binding][i].sha256)) fail("MIGRATION_PREFIX_DRIFT");
  }
  // Earlier schemas need their own fixtures; never report an empty database as populated proof.
  if (prefix.migrations.USAGE_MONITOR_DB.length < 31 || prefix.migrations.DELETION_LEDGER.length < 1) fail("MIGRATION_PREFIX_FIXTURE_UNSUPPORTED");
}

function admissionForSources(sources, prefix) {
  validatePrefix(prefix, sources);
  return { schemaVersion: SCHEMA, prefixDigest: sha(JSON.stringify(prefix)),
    migrationDigest: sha(JSON.stringify(Object.fromEntries(Object.entries(sources).map(([key, rows]) => [key, rows.map(({ name, sha256 }) => ({ name, sha256 }))])))),
    freshness: "supplied-snapshot-not-live", migrations: Object.fromEntries(Object.entries(sources).map(([key, rows]) => [key,
      { applied: prefix.migrations[key].length, pending: rows.slice(prefix.migrations[key].length).map(({ name, sha256 }) => ({ name, sha256 })) }])) };
}

export async function inspectMigrationPrefix({ workerRoot = WORKER_ROOT, prefix }) {
  return admissionForSources(await bundles(workerRoot), prefix);
}

function wranglerRun(workerRoot, args, spawn = spawnSync) {
  let result;
  try {
    result = spawn(join(workerRoot, "node_modules/.bin/wrangler"), args, { cwd: workerRoot,
      encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 120_000,
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" } });
  } catch { fail("REHEARSAL_WRANGLER_FAILED"); }
  if (result.error || result.status !== 0) fail("REHEARSAL_WRANGLER_FAILED");
  try { return JSON.parse(result.stdout); } catch { fail("REHEARSAL_WRANGLER_RESULT_INVALID"); }
}

function resultRows(value) {
  if (!Array.isArray(value) || value.length !== 1 || value[0]?.success !== true || !Array.isArray(value[0]?.results)) fail("REHEARSAL_WRANGLER_RESULT_INVALID");
  return value[0].results;
}

/** Fixed read-only ledger queries; names are bound to this checkout's reviewed bytes.
 * D1's ledger does not attest historical SQL byte hashes. That boundary is explicit. */
export async function observeMigrationPrefix({ workerRoot = WORKER_ROOT, environment, spawn = spawnSync }) {
  if (!["production", "staging"].includes(environment)) fail("MIGRATION_OBSERVATION_ENVIRONMENT_INVALID");
  const sources = await bundles(workerRoot), migrations = {};
  for (const binding of Object.keys(STREAMS)) {
    const rows = resultRows(wranglerRun(workerRoot, ["d1", "execute", binding, "--remote", "--env", environment,
      "--command", LEDGER_SQL, "--json"], spawn));
    if (rows.length > sources[binding].length || rows.some((row, i) => !exact(row, ["name"]) || row.name !== sources[binding][i].name)) fail("MIGRATION_PREFIX_DRIFT");
    migrations[binding] = sources[binding].slice(0, rows.length).map(({ name, sha256 }) => ({ name, sha256 }));
  }
  const prefix = { schemaVersion: PREFIX_SCHEMA, observedAt: new Date().toISOString(), environment, migrations };
  validatePrefix(prefix, sources);
  return prefix;
}

function* seedStatements(binding, accounts, events, cooldowns = true) {
  const at = "2026-09-01T00:00:00.000Z", expiry = "9999-01-01T00:00:00.000Z", secret = Buffer.alloc(32, 1);
  const insert = (table, fields) => `INSERT INTO ${quote(table)} (${Object.keys(fields).map(quote).join(",")}) VALUES (${Object.values(fields).map(literal).join(",")});`;
  for (let account = 0; account < accounts; account++) {
    const id = `synthetic-rehearsal-${account}`, digest = sha(id);
    if (cooldowns) yield insert("identity_reenrollment_cooldowns", { identity_cooldown_digest: digest,
      schema_version: "identity-reenrollment-cooldown-v0.1", deleted_at: at, retain_until: expiry });
    if (binding === "DELETION_LEDGER") {
      yield insert("deletion_tombstones", { participant_digest: digest, schema_version: "participant-deletion-tombstone-v0.1", deleted_at: at, retain_until: expiry });
      continue;
    }
    yield insert("participants", { id, access_token_id: `${id}-access`, access_token_hash: secret,
      recovery_token_id: `${id}-recovery`, recovery_token_hash: secret, consent_version: "synthetic-rehearsal", consented_at: at, created_at: at });
    yield insert("web_sessions", { id, participant_id: id, secret_hash: secret, csrf_hash: secret, issued_at: at, expires_at: expiry, last_used_at: at });
    yield insert("device_pairings", { id, participant_id: id, issued_by_session_id: id, secret_hash: secret,
      consent_version: "ongoing-privacy-safe-telemetry-v1.0", issued_at: at, expires_at: expiry });
    yield insert("device_credentials", { id, participant_id: id, paired_via_pairing_id: id, secret_hash: secret,
      issued_at: at, expires_at: expiry, last_used_at: at });
    yield insert("telemetry_v1_device_consents", { participant_id: id, device_id: id, telemetry_schema_version: "telemetry-contribution-v1.0",
      field_dictionary_version: "synthetic-rehearsal", privacy_contract_version: "synthetic-rehearsal", consented_at: at });
    const count = account === 0 ? Math.ceil(events / 2) : Math.floor(events / (2 * (accounts - 1))) + (account <= (Math.floor(events / 2) % (accounts - 1)) ? 1 : 0);
    for (let offset = 0; offset < count; offset += 200) {
      const chunk = `${id}-chunk-${offset}`, chunkDigest = sha(chunk), size = Math.min(200, count - offset);
      const dayOffset = Math.floor((offset / 200) * 335 / Math.max(1, Math.ceil(count / 200) - 1));
      const observed = new Date(Date.UTC(2025, 9, 1 + dayOffset)).toISOString(), day = observed.slice(0, 10);
      yield insert("device_upload_authorizations", { id: chunk, participant_id: id, issued_by_device_id: id, secret_hash: secret,
        envelope_digest: chunkDigest, body_bytes: 200, content_type: "application/json", state: "consuming", issued_at: at,
        expires_at: expiry, consume_lease_expires_at: expiry });
      yield insert("telemetry_v1_chunks", { id: chunk, participant_id: id, device_id: id, stream: "usage", chunk_day: day,
        chunk_seq: offset / 200, revision: 1, chunk_digest: chunkDigest, envelope_digest: chunkDigest, parser_version: "synthetic-rehearsal",
        record_count: size, accepted_record_count: size, r2_key: `synthetic/rehearsal/${chunk}`, device_upload_authorization_id: chunk, created_at: at });
      for (let n = offset; n < offset + size; n++) {
        const occurrence = `${id}-${n}`;
        yield insert("telemetry_v1_records", { chunk_row_id: chunk, participant_id: id, device_id: id, stream: "usage", occurrence_id: occurrence,
          observed_at: observed, observed_day: observed.slice(0, 10), provider: "openai_codex", model_id: n % 2 ? "gpt-5.5" : "gpt-5.6-sol",
          input_uncached_tokens: 1000, input_cache_read_tokens: 3000, output_text_tokens: 100, record_json: "{}" });
        yield insert("telemetry_records", { participant_id: id, record_kind: "usage", occurrence_id: occurrence,
          observed_at: observed, provider: "openai_codex", model_id: "gpt-5.5", input_uncached_tokens: 1000, output_text_tokens: 100, record_json: "{}" });
      }
    }
  }
}

const PRESERVED_TABLES = ["participants", "web_sessions", "device_pairings", "device_credentials", "device_upload_authorizations",
  "telemetry_v1_device_consents", "telemetry_v1_chunks", "telemetry_v1_records", "telemetry_records", "collection_controls",
  "deletion_tombstones", "identity_reenrollment_cooldowns", "retention_state"];

function snapshot(database, shape = null) {
  const result = {};
  for (const table of PRESERVED_TABLES) {
    if (shape && !shape[table]) continue;
    const info = database.prepare(`PRAGMA table_info(${quote(table)})`).all();
    const columns = shape?.[table]?.columns ?? info.map(row => row.name);
    if (!columns.length) continue;
    const order = shape?.[table]?.order ?? info.filter(row => row.pk > 0).sort((a, b) => a.pk - b.pk).map(row => row.name);
    const hash = createHash("sha256"); let count = 0;
    for (const row of database.prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)} ORDER BY ${(order.length ? order : columns).map(quote).join(",")}`).iterate()) {
      hash.update(JSON.stringify(row)); hash.update("\n"); count++;
    }
    result[table] = { columns, order, count, sha256: hash.digest("hex") };
  }
  return result;
}

function preserve(database, before) {
  if (JSON.stringify(snapshot(database, before)) !== JSON.stringify(before)) fail("MIGRATION_PRESERVATION_FAILED");
  if (database.prepare("PRAGMA foreign_key_check").all().length) fail("MIGRATION_FOREIGN_KEY_FAILED");
  if (database.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") fail("MIGRATION_INTEGRITY_FAILED");
}

export async function runMigrationRehearsal({ workerRoot = WORKER_ROOT, prefix, accounts = 1000, events = 100_000,
  maxDurationMs = 120_000, maxDatabaseBytes = 512 * 1024 * 1024, maxRssBytes = 1024 * 1024 * 1024,
  temporaryDirectory = null } = {}) {
  const sources = await bundles(workerRoot), admission = admissionForSources(sources, prefix);
  if (!Number.isInteger(accounts) || accounts < 2 || accounts > 1000 || !Number.isInteger(events) || events < accounts || events > 1_000_000
      || ![maxDurationMs, maxDatabaseBytes, maxRssBytes].every(n => Number.isSafeInteger(n) && n > 0)
      || maxDurationMs > 600_000 || maxDatabaseBytes > 2 ** 30 || maxRssBytes > 2 ** 31) fail("REHEARSAL_LIMITS_INVALID");
  const directory = temporaryDirectory ?? await mkdtemp(join(tmpdir(), "tibotattle-migration-rehearsal-"));
  if (temporaryDirectory !== null) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await realpath(directory) !== resolve(directory)
        || (process.getuid && stat.uid !== process.getuid()) || (await readdir(directory)).length) fail("REHEARSAL_TEMPORARY_DIRECTORY_UNSAFE");
  }
  await chmod(directory, 0o700);
  const started = performance.now(), receipts = {}; let peakRssBytes = 0;
  const check = database => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    const databaseBytes = database.prepare("PRAGMA page_count").get().page_count * database.prepare("PRAGMA page_size").get().page_size;
    if (performance.now() - started > maxDurationMs || databaseBytes > maxDatabaseBytes || peakRssBytes > maxRssBytes) fail("REHEARSAL_RESOURCE_CEILING_EXCEEDED");
    return databaseBytes;
  };
  try {
    for (const binding of Object.keys(STREAMS)) {
      const path = join(directory, `${binding}.sqlite`); let database = new DatabaseSync(path);
      try {
        const configureConnection = () => {
          database.exec("PRAGMA foreign_keys=ON");
          check(database);
          const pageSize = database.prepare("PRAGMA page_size").get().page_size;
          database.exec(`PRAGMA max_page_count=${Math.max(1, Math.floor(maxDatabaseBytes / pageSize))};`);
        };
        configureConnection();
        database.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);");
        const apply = migration => { database.exec("BEGIN IMMEDIATE"); try { database.exec(migration.sql);
          database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(migration.name); database.exec("COMMIT");
        } catch (error) { try { database.exec("ROLLBACK"); } catch { /* SQLite can roll back itself on SQLITE_FULL. */ } throw error; } };
        const start = prefix.migrations[binding].length;
        for (const migration of sources[binding].slice(0, start)) { apply(migration); check(database); }
        database.exec("BEGIN IMMEDIATE");
        try { let index = 0; for (const sql of seedStatements(binding, accounts, events, binding === "USAGE_MONITOR_DB" || start >= 2)) { database.exec(sql); if (index++ % 1000 === 0) check(database); }
          database.exec("COMMIT"); } catch (error) { try { database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ } throw error; }
        const before = snapshot(database), steps = [];
        preserve(database, before);
        for (const migration of sources[binding].slice(start)) {
          const stepStarted = performance.now(), ledger = database.prepare("SELECT name FROM d1_migrations ORDER BY id").all();
          // Closing an uncommitted real SQLite connection models process interruption.
          database.exec("BEGIN IMMEDIATE"); database.exec(migration.sql);
          database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(migration.name);
          database.close(); database = new DatabaseSync(path); configureConnection();
          if (JSON.stringify(database.prepare("SELECT name FROM d1_migrations ORDER BY id").all()) !== JSON.stringify(ledger)) fail("MIGRATION_INTERRUPTION_ROLLBACK_FAILED");
          preserve(database, before);
          apply(migration); preserve(database, before);
          steps.push({ name: migration.name, sha256: migration.sha256, durationMs: Math.ceil(performance.now() - stepStarted), databaseBytes: check(database) });
        }
        const names = database.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map(row => row.name);
        if (JSON.stringify(names) !== JSON.stringify(sources[binding].map(row => row.name))) fail("MIGRATION_FINAL_LEDGER_DRIFT");
        // A second invocation sees a complete exact prefix and schedules no writes.
        const replayPending = sources[binding].filter(row => !names.includes(row.name));
        if (replayPending.length) fail("MIGRATION_REPLAY_NOT_NOOP");
        receipts[binding] = { predecessorCount: start, finalCount: names.length, preserved: Object.fromEntries(Object.entries(before).map(([key, { count, sha256 }]) => [key, { count, sha256 }])),
          steps, replayWrites: 0, databaseBytes: check(database) };
      } finally { database.close(); }
    }
    return { ...admission, ok: true, runtime: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch },
      fixture: { version: 1, accounts, eventsPerTelemetryTable: events, heavyAccountShare: 0.5, observedSpanDays: Math.ceil(events / 2) > 200 ? 336 : 1 },
      limits: { maxDurationMs, maxDatabaseBytes, maxRssBytes }, durationMs: Math.ceil(performance.now() - started), peakRssBytes,
      receipts, remoteSyntax: "not-exercised", productionReadiness: false };
  } catch (error) { if (error?.code?.startsWith("MIGRATION_") || error?.code?.startsWith("REHEARSAL_")) throw error;
    if (error?.errcode === 13 || error?.errcode === 7) fail("REHEARSAL_RESOURCE_CEILING_EXCEEDED");
    fail("REHEARSAL_LOCAL_SQL_FAILED");
  } finally { if (temporaryDirectory === null) await rm(directory, { recursive: true }); }
}

function sampledChildMemory(pid) {
  const result = spawnSync("/bin/ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", timeout: 500, maxBuffer: 1024 });
  if (result.error || result.status !== 0 || !/^\s*\d+\s*$/.test(result.stdout)) return null;
  return Number(result.stdout.trim()) * 1024;
}

/** CLI containment is outside SQLite, so a blocking statement cannot suppress it.
 * No source/SQL/credential argument is placed on the command line. */
export async function runMigrationRehearsalProcess({ prefix, accounts = 1000, events = 100_000, timeoutMs = 120_000,
  maxRssBytes = 1024 * 1024 * 1024, maxDatabaseBytes = 512 * 1024 * 1024,
  spawn = spawnChild, memory = sampledChildMemory, signal = (pid, name) => process.kill(-pid, name), terminationGraceMs = 5000 } = {}) {
  if (!["darwin", "linux"].includes(process.platform)) fail("REHEARSAL_PROCESS_CONTAINMENT_UNSUPPORTED");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000
      || !Number.isSafeInteger(maxRssBytes) || maxRssBytes < 1 || maxRssBytes > 2 ** 31
      || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1 || terminationGraceMs > 5000) fail("REHEARSAL_LIMITS_INVALID");
  // Validate lineage before starting a subprocess; no malformed source observation is reused.
  const admission = await inspectMigrationPrefix({ prefix });
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-migration-rehearsal-")));
  await chmod(directory, 0o700);
  let terminationConfirmed = false;
  try {
    return await new Promise((resolveResult, reject) => {
      let child, timer, memoryTimer, killTimer, confirmationTimer, stopped = false, reason = null, output = "", errorOutput = "", peakRssBytes = 0, missingMemorySamples = 0;
      const cleanup = () => { clearTimeout(timer); clearInterval(memoryTimer); clearTimeout(killTimer); clearTimeout(confirmationTimer); };
      const finish = (code, value) => { if (stopped) return; stopped = true; cleanup();
        if (code) reject(Object.assign(new Error(code), { code })); else resolveResult(value); };
      const sendSignal = name => { try { if (Number.isSafeInteger(child?.pid) && child.pid > 1) signal(child.pid, name); } catch { /* close is the authority */ } };
      const stop = code => {
        if (reason || stopped) return; reason = code; sendSignal("SIGTERM");
        killTimer = setTimeout(() => sendSignal("SIGKILL"), Math.min(250, terminationGraceMs));
        confirmationTimer = setTimeout(() => finish("REHEARSAL_TERMINATION_UNCONFIRMED"), terminationGraceMs);
      };
      try {
        child = spawn(process.execPath, [`--max-old-space-size=${Math.max(16, Math.floor(maxRssBytes / 1024 / 1024))}`,
          fileURLToPath(import.meta.url), "--rehearsal-worker"], { cwd: WORKER_ROOT, detached: true, stdio: ["pipe", "pipe", "pipe"],
          env: { PATH: process.env.PATH, TMPDIR: tmpdir(), NODE_NO_WARNINGS: "1" } });
      } catch { terminationConfirmed = true; finish("REHEARSAL_PROCESS_START_FAILED"); return; }
      timer = setTimeout(() => stop("REHEARSAL_PROCESS_TIMEOUT"), timeoutMs);
      memoryTimer = setInterval(() => { let bytes;
        try { bytes = memory(child.pid); } catch { bytes = null; }
        if (bytes === null) { if (++missingMemorySamples >= 4) stop("REHEARSAL_PROCESS_MEMORY_UNAVAILABLE"); return; }
        missingMemorySamples = 0;
        peakRssBytes = Math.max(peakRssBytes, bytes);
        if (bytes > maxRssBytes) stop("REHEARSAL_PROCESS_MEMORY_EXCEEDED");
      }, 250);
      child.stdout.on("data", data => { if (Buffer.byteLength(output) + data.length > 2 * 1024 * 1024) { stop("REHEARSAL_PROCESS_OUTPUT_EXCEEDED"); return; } output += data.toString(); });
      child.stderr.on("data", data => { if (Buffer.byteLength(errorOutput) + data.length > 64 * 1024) { stop("REHEARSAL_PROCESS_OUTPUT_EXCEEDED"); return; } errorOutput += data.toString(); });
      child.on("error", () => { terminationConfirmed = true; finish("REHEARSAL_PROCESS_START_FAILED"); });
      child.on("close", code => {
        terminationConfirmed = true;
        if (reason) { finish(reason); return; }
        if (code !== 0) { finish("REHEARSAL_PROCESS_FAILED"); return; }
        let receipt;
        try { receipt = JSON.parse(output); } catch { finish("REHEARSAL_PROCESS_RESULT_INVALID"); return; }
        if (!exact(receipt, ["schemaVersion", "prefixDigest", "migrationDigest", "freshness", "migrations", "ok", "runtime", "fixture", "limits", "durationMs", "peakRssBytes", "receipts", "remoteSyntax", "productionReadiness"])
            || receipt.schemaVersion !== SCHEMA || receipt.ok !== true || receipt.productionReadiness !== false
            || receipt.remoteSyntax !== "not-exercised" || !object(receipt.receipts)
            || !exact(receipt.receipts, Object.keys(STREAMS)) || receipt.migrationDigest !== admission.migrationDigest
            || receipt.prefixDigest !== admission.prefixDigest || receipt.freshness !== admission.freshness
            || !Number.isSafeInteger(receipt.durationMs) || receipt.durationMs < 0 || receipt.durationMs > timeoutMs
            || !Number.isSafeInteger(receipt.peakRssBytes) || receipt.peakRssBytes < 0 || receipt.peakRssBytes > maxRssBytes
            || JSON.stringify(receipt.migrations) !== JSON.stringify(admission.migrations)
            || JSON.stringify(receipt.runtime) !== JSON.stringify({ node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch })
            || JSON.stringify(receipt.fixture) !== JSON.stringify({ version: 1, accounts, eventsPerTelemetryTable: events,
              heavyAccountShare: 0.5, observedSpanDays: Math.ceil(events / 2) > 200 ? 336 : 1 })
            || JSON.stringify(receipt.limits) !== JSON.stringify({ maxDurationMs: timeoutMs, maxDatabaseBytes, maxRssBytes })) {
          finish("REHEARSAL_PROCESS_RESULT_INVALID"); return;
        }
        for (const binding of Object.keys(STREAMS)) {
          const actual = receipt.receipts[binding], expected = admission.migrations[binding];
          if (!exact(actual, ["predecessorCount", "finalCount", "preserved", "steps", "replayWrites", "databaseBytes"])
              || actual.predecessorCount !== expected.applied || actual.finalCount !== expected.applied + expected.pending.length
              || actual.replayWrites !== 0 || !Number.isSafeInteger(actual.databaseBytes) || actual.databaseBytes < 0 || actual.databaseBytes > maxDatabaseBytes
              || !Array.isArray(actual.steps) || actual.steps.length !== expected.pending.length
              || actual.steps.some((step, index) => !exact(step, ["name", "sha256", "durationMs", "databaseBytes"])
                || step.name !== expected.pending[index].name || step.sha256 !== expected.pending[index].sha256
                || !Number.isSafeInteger(step.durationMs) || step.durationMs < 0 || step.durationMs > timeoutMs
                || !Number.isSafeInteger(step.databaseBytes) || step.databaseBytes < 0 || step.databaseBytes > maxDatabaseBytes)
              || !object(actual.preserved) || Object.entries(actual.preserved).some(([table, value]) => !PRESERVED_TABLES.includes(table)
                || !exact(value, ["count", "sha256"]) || !Number.isSafeInteger(value.count) || value.count < 0 || !/^[0-9a-f]{64}$/.test(value.sha256))) {
            finish("REHEARSAL_PROCESS_RESULT_INVALID"); return;
          }
        }
        if (receipt.receipts.USAGE_MONITOR_DB.preserved.participants?.count !== accounts
            || receipt.receipts.USAGE_MONITOR_DB.preserved.telemetry_v1_records?.count !== events
            || receipt.receipts.USAGE_MONITOR_DB.preserved.telemetry_records?.count !== events
            || receipt.receipts.DELETION_LEDGER.preserved.deletion_tombstones?.count !== accounts) {
          finish("REHEARSAL_PROCESS_RESULT_INVALID"); return;
        }
        finish(null, { ...receipt, containment: { processGroup: true, timeoutMs, maxRssBytes, sampledPeakRssBytes: peakRssBytes, terminationConfirmed: true } });
      });
      child.stdin.on("error", () => stop("REHEARSAL_PROCESS_INPUT_FAILED"));
      child.stdin.end(JSON.stringify({ prefix, accounts, events, maxDurationMs: timeoutMs, maxRssBytes, maxDatabaseBytes, temporaryDirectory: directory }));
    });
  } finally {
    // Never delete a live or unconfirmed process's working database.
    if (terminationConfirmed) await rm(directory, { recursive: true });
  }
}

async function workerMain() {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk.toString(); if (Buffer.byteLength(input) > 1_048_576) fail("REHEARSAL_INPUT_INVALID"); }
  let options; try { options = JSON.parse(input); } catch { fail("REHEARSAL_INPUT_INVALID"); }
  if (!exact(options, ["prefix", "accounts", "events", "maxDurationMs", "maxRssBytes", "maxDatabaseBytes", "temporaryDirectory"])) fail("REHEARSAL_INPUT_INVALID");
  return runMigrationRehearsal(options);
}

async function privateJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid()) || await realpath(path) !== resolve(path)) fail("REHEARSAL_INPUT_UNSAFE");
  try { return JSON.parse(await readFile(path, "utf8")); } catch { fail("REHEARSAL_INPUT_INVALID"); }
}

/** Remote writes are possible only through this explicit separately approved mode.
 * A fresh, existing disposable pair is required. No resource creation or deletion. */
export async function rehearseRemoteSyntax({ workerRoot = WORKER_ROOT, prefix, target, confirmation, spawn = spawnSync }) {
  if (confirmation !== "APPLY_SYNTHETIC_MIGRATIONS_TO_DISPOSABLE_D1") fail("REMOTE_REHEARSAL_CONFIRMATION_REQUIRED");
  const sources = await bundles(workerRoot), admission = admissionForSources(sources, prefix);
  const errors = [], config = parse(await readFile(join(workerRoot, "wrangler.jsonc"), "utf8"), errors);
  if (errors.length || !object(config)) fail("REMOTE_REHEARSAL_CONFIG_INVALID");
  const forbidden = [];
  for (const name of (await readdir(workerRoot)).filter(name => /^wrangler(?:\.[a-z0-9-]+)?\.jsonc$/.test(name))) {
    const parseErrors = [], known = parse(await readFile(join(workerRoot, name), "utf8"), parseErrors);
    if (parseErrors.length || !object(known)) fail("REMOTE_REHEARSAL_CONFIG_INVALID");
    forbidden.push(...[known, ...Object.values(known.env ?? {})].flatMap(env => env.d1_databases ?? [])
      .flatMap(db => [db.database_id, db.preview_database_id, db.database_name]).filter(Boolean));
  }
  if (!exact(target, ["schemaVersion", "purpose", "databases"]) || target.schemaVersion !== 1 || target.purpose !== "release-migration-rehearsal"
      || !exact(target.databases, Object.keys(STREAMS))) fail("REMOTE_REHEARSAL_TARGET_INVALID");
  const ids = new Set();
  for (const db of Object.values(target.databases)) {
    if (!exact(db, ["database_name", "database_id"]) || !/^tibotattle-rehearsal-[a-z0-9-]{1,48}$/.test(db.database_name)
        || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(db.database_id)
        || forbidden.includes(db.database_id) || forbidden.includes(db.database_name) || ids.has(db.database_id)) fail("REMOTE_REHEARSAL_TARGET_FORBIDDEN");
    ids.add(db.database_id);
  }
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-remote-syntax-")); await chmod(directory, 0o700);
  let attempted = false;
  try {
    const configPath = join(directory, "wrangler.json");
    await writeFile(configPath, JSON.stringify({ name: "tibotattle-rehearsal", compatibility_date: config.compatibility_date,
      d1_databases: Object.entries(target.databases).map(([binding, db]) => ({ binding, ...db, migrations_dir: join(directory, binding) })) }), { mode: 0o600 });
    const args = ["--config", configPath];
    // Query both before any mutation; an occupied or unknown target never receives SQL.
    for (const binding of Object.keys(STREAMS)) {
      const rows = resultRows(wranglerRun(workerRoot, ["d1", "execute", binding, ...args, "--remote", "--command",
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';", "--json"], spawn));
      if (rows.length !== 1 || rows[0].n !== 0) fail("REMOTE_REHEARSAL_TARGET_NOT_EMPTY");
    }
    for (const binding of Object.keys(STREAMS)) {
      await mkdir(join(directory, binding), { mode: 0o700 });
      const start = prefix.migrations[binding].length;
      for (const migration of sources[binding].slice(0, start)) await writeFile(join(directory, binding, migration.name), migration.sql, { mode: 0o600 });
      const apply = () => {
        attempted = true;
        // migrations apply has human output; avoid logging it and do not parse it as JSON.
        const result = spawn(join(workerRoot, "node_modules/.bin/wrangler"), ["d1", "migrations", "apply", binding, ...args, "--remote"],
          { cwd: workerRoot, encoding: "utf8", input: "y\n", timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" } });
        if (result.error || result.status !== 0) fail("REMOTE_REHEARSAL_OUTCOME_UNCERTAIN");
      };
      apply();
      const seed = join(directory, `${binding}-seed.sql`);
      await writeFile(seed, [...seedStatements(binding, 2, 20, binding === "USAGE_MONITOR_DB" || start >= 2)].join("\n"), { mode: 0o600 });
      wranglerRun(workerRoot, ["d1", "execute", binding, ...args, "--remote", "--file", seed, "--yes", "--json"], spawn);
      for (const migration of sources[binding].slice(start)) await writeFile(join(directory, binding, migration.name), migration.sql, { mode: 0o600 });
      apply();
      const names = resultRows(wranglerRun(workerRoot, ["d1", "execute", binding, ...args, "--remote", "--command", LEDGER_SQL, "--json"], spawn)).map(row => row.name);
      if (JSON.stringify(names) !== JSON.stringify(sources[binding].map(row => row.name))) fail("REMOTE_REHEARSAL_LEDGER_DRIFT");
      const expected = binding === "USAGE_MONITOR_DB" ? { participants: 2, device_credentials: 2,
        telemetry_v1_device_consents: 2, telemetry_v1_records: 20, telemetry_records: 20, identity_reenrollment_cooldowns: 2 }
        : { deletion_tombstones: 2, identity_reenrollment_cooldowns: start >= 2 ? 2 : 0 };
      const sql = `SELECT ${Object.keys(expected).map(table => `(SELECT COUNT(*) FROM ${table}) AS ${table}`).join(",")};`;
      const rows = resultRows(wranglerRun(workerRoot, ["d1", "execute", binding, ...args, "--remote", "--command", sql, "--json"], spawn));
      if (rows.length !== 1 || !exact(rows[0], Object.keys(expected))
          || Object.entries(expected).some(([key, count]) => rows[0][key] !== count)) fail("REMOTE_REHEARSAL_PRESERVATION_FAILED");
    }
    return { schemaVersion: SCHEMA, ok: true, mode: "remote-syntax", targetDigest: sha(JSON.stringify(target)),
      ...admission, fixture: { accounts: 2, events: 20 }, productionReadiness: false };
  } catch (error) { if (attempted) fail("REMOTE_REHEARSAL_OUTCOME_UNCERTAIN"); throw error;
  } finally { await rm(directory, { recursive: true }); }
}

export async function main(args = process.argv.slice(2)) {
  const [mode, ...flags] = args, options = {};
  if (!["observe-prefix", "local", "remote-syntax"].includes(mode)) fail("REHEARSAL_USAGE_INVALID");
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i], value = flags[i + 1];
    if (!["--prefix", "--environment", "--accounts", "--events", "--target", "--confirm"].includes(key)
        || key in options || !value || value.startsWith("--")) fail("REHEARSAL_USAGE_INVALID");
    options[key] = value;
  }
  const allowed = { "observe-prefix": ["--environment"], local: ["--prefix", "--accounts", "--events"], "remote-syntax": ["--prefix", "--target", "--confirm"] }[mode];
  if (Object.keys(options).some(key => !allowed.includes(key))) fail("REHEARSAL_USAGE_INVALID");
  if (mode === "observe-prefix") return observeMigrationPrefix({ environment: options["--environment"] });
  if (!options["--prefix"]) fail("REHEARSAL_USAGE_INVALID");
  const prefix = await privateJson(options["--prefix"]);
  if (mode === "local") return runMigrationRehearsalProcess({ prefix, accounts: options["--accounts"] ? Number(options["--accounts"]) : undefined,
    events: options["--events"] ? Number(options["--events"]) : undefined });
  if (!options["--target"]) fail("REHEARSAL_USAGE_INVALID");
  return rehearseRemoteSyntax({ prefix, target: await privateJson(options["--target"]), confirmation: options["--confirm"] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (process.argv.length === 3 && process.argv[2] === "--rehearsal-worker" ? workerMain() : main()).then(result => process.stdout.write(`${JSON.stringify(result)}\n`), error => {
    const code = typeof error?.code === "string" && /^(?:MIGRATION|REHEARSAL|REMOTE_REHEARSAL|LOCAL_MIGRATION)_[A-Z_]+$/.test(error.code) ? error.code : "REHEARSAL_FAILED";
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`); process.exitCode = 1;
  });
}
