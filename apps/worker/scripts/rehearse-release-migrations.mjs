import { createHash } from "node:crypto";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, readdirSync, lstatSync, statfsSync, renameSync } from "node:fs";
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
export const LOCAL_SCALE_PROFILE = Object.freeze({
  name: "production-scale-5gib", throughMigration: "0059_accountless_upload_renewal.sql", targetBytes: 5 * 2 ** 30, maxDatabaseBytes: 10_000_000_000,
  maxScratchBytes: 20 * 2 ** 30, minInitialFreeBytes: 22 * 2 ** 30, minFreeBytes: 2 * 2 ** 30,
  maxRssBytes: 2 ** 31, timeoutMs: 600_000, accounts: 1000, events: 100_000,
  paddingCharacters: 26 * 1024, blockRows: 200, maxOvershootBytes: 64 * 2 ** 20,
});

const SCALE_MIGRATIONS = Object.freeze([
  { name: "0057_accountless_enrollment_ledger.sql", sha256: "5cbf718449688bffc0fc5cf63d1de17351acb915f44459f1b32f3202c7378cd5" },
  { name: "0058_accountless_upload_ownership.sql", sha256: "b435fd92d41e7ce8067cc183d7ac153359a9c130a971cba2e1b8b8c1c9cab61b" },
  { name: "0059_accountless_upload_renewal.sql", sha256: "98afb99dd91e56a96960e6d99096e44c41eec0cd52d5a1e2969dea4ddee3d312" },
]);
function validateScaleAdmission(admission) {
  if (admission.migrations.USAGE_MONITOR_DB.applied !== 56 || admission.migrations.DELETION_LEDGER.applied !== 2
      || JSON.stringify(admission.migrations.USAGE_MONITOR_DB.pending) !== JSON.stringify(SCALE_MIGRATIONS)
      || admission.migrations.DELETION_LEDGER.pending.length !== 0) fail("REHEARSAL_SCALE_PREFIX_INVALID");
}

export function observeRehearsalScratch(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("REHEARSAL_SCRATCH_UNSAFE");
  const entries = readdirSync(directory); if (entries.length > 32) fail("REHEARSAL_SCRATCH_UNSAFE");
  let scratchBytes = 0;
  for (const name of entries) {
    let value;
    try { value = lstatSync(join(directory, name)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) fail("REHEARSAL_SCRATCH_UNSAFE");
    scratchBytes += value.size;
  }
  const disk = statfsSync(directory), freeBytes = disk.bavail * disk.bsize;
  if (![scratchBytes, freeBytes].every(value => Number.isSafeInteger(value) && value >= 0)) fail("REHEARSAL_SCRATCH_UNAVAILABLE");
  return { scratchBytes, freeBytes };
}

// Only the existing synthetic rows are padded; no new parser, schema or authority path.
export function padSyntheticRehearsal(database, { targetBytes, check = () => {}, onProgress = () => {} }) {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 1 || targetBytes > LOCAL_SCALE_PROFILE.targetBytes) fail("REHEARSAL_SCALE_TARGET_INVALID");
  const pageBytes = () => database.prepare("PRAGMA page_count").get().page_count * database.prepare("PRAGMA page_size").get().page_size;
  const counts = ["telemetry_records", "telemetry_v1_records"].map(table => database.prepare(`SELECT count(*) AS n,min(id) AS first,max(id) AS last FROM ${table}`).get());
  if (counts.some(row => row.n < 1 || row.n > LOCAL_SCALE_PROFILE.events || row.first !== 1 || row.last !== row.n) || counts[0].n !== counts[1].n) fail("REHEARSAL_SCALE_FIXTURE_INVALID");
  const value = JSON.stringify({ synthetic_padding: "p".repeat(LOCAL_SCALE_PROFILE.paddingCharacters) });
  const updates = ["telemetry_records", "telemetry_v1_records"].map(table => database.prepare(`UPDATE ${table} SET record_json=? WHERE id>=? AND id<?`));
  const initialBytes = pageBytes(); let databaseBytes = initialBytes, paddedRows = 0, blocks = 0;
  for (let first = 1; databaseBytes < targetBytes && first <= counts[0].n; first += LOCAL_SCALE_PROFILE.blockRows) {
    database.exec("BEGIN IMMEDIATE");
    try { for (const update of updates) update.run(value, first, first + LOCAL_SCALE_PROFILE.blockRows); database.exec("COMMIT"); }
    catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
    paddedRows += Math.min(LOCAL_SCALE_PROFILE.blockRows, counts[0].n - first + 1); blocks++;
    databaseBytes = pageBytes(); check(database);
    onProgress({ databaseBytes, paddedRows, blocks });
  }
  if (databaseBytes < targetBytes || databaseBytes > targetBytes + LOCAL_SCALE_PROFILE.maxOvershootBytes) fail("REHEARSAL_SCALE_TARGET_NOT_MET");
  return { distribution: "synthetic-v1-legacy-heavy", initialBytes, targetBytes, baselineBytes: databaseBytes,
    rowsPerTelemetryTable: counts[0].n, paddedRowsPerTable: paddedRows, paddingJsonBytes: Buffer.byteLength(value),
    unpaddedRowsPerTable: counts[0].n - paddedRows, blocks, blockRows: LOCAL_SCALE_PROFILE.blockRows,
    paddingOrder: "ascending-record-id", productionRepresentative: false };
}

const IMPORT_OWNERSHIP_MIGRATION = "0058_accountless_upload_ownership.sql";
const LEDGER_SQL = "SELECT name FROM d1_migrations ORDER BY id;";
const sha = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const quote = name => `"${name.replaceAll('"', '""')}"`;
const literal = value => value === null ? "NULL" : Buffer.isBuffer(value) ? `X'${value.toString("hex")}'`
  : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;

async function bundles(workerRoot, throughMigration = null) {
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
  // The fixed scale profile remains the historical 0057–0059 qualification.
  // Validate every current source first; the receipt binds only its explicit target.
  if (throughMigration !== null) {
    if (throughMigration !== LOCAL_SCALE_PROFILE.throughMigration) fail("REHEARSAL_TARGET_INVALID");
    const end = result.USAGE_MONITOR_DB.findIndex(row => row.name === throughMigration);
    if (end !== 58) fail("REHEARSAL_TARGET_INVALID");
    result.USAGE_MONITOR_DB = result.USAGE_MONITOR_DB.slice(0, end + 1);
  }
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

export async function inspectMigrationPrefix({ workerRoot = WORKER_ROOT, prefix, throughMigration = null }) {
  return admissionForSources(await bundles(workerRoot, throughMigration), prefix);
}

function decodeImportResult(stdout) {
  // Pinned Wrangler can emit upload progress before its terminal JSON value.
  // Accept only those complete progress lines, never arbitrary or partial output.
  const start = stdout.indexOf("[");
  if (start < 0 || start > 4096) fail("REHEARSAL_WRANGLER_RESULT_INVALID");
  const progress = stdout.slice(0, start).split("\n").filter(line => line.trim());
  if (progress.some(line => !/^(?:├ Checking if file needs uploading|│|├ 🌀 Uploading [a-f0-9-]+\.[a-f0-9]+\.sql|│ 🌀 Uploading complete\.)$/.test(line))) fail("REHEARSAL_WRANGLER_RESULT_INVALID");
  let value;
  try { value = JSON.parse(stdout.slice(start)); } catch { fail("REHEARSAL_WRANGLER_RESULT_INVALID"); }
  const row = value?.[0];
  if (!Array.isArray(value) || value.length !== 1 || !exact(row, ["results", "success", "finalBookmark", "meta"])
      || row.success !== true || !Array.isArray(row.results) || typeof row.finalBookmark !== "string"
      || row.finalBookmark.length === 0 || row.finalBookmark.length > 256 || !object(row.meta)
      || !Number.isFinite(row.meta.duration) || row.meta.duration < 0) fail("REHEARSAL_WRANGLER_RESULT_INVALID");
  return value;
}

function wranglerRun(workerRoot, args, spawn = spawnSync) {
  let result;
  try {
    result = spawn(join(workerRoot, "node_modules/.bin/wrangler"), args, { cwd: workerRoot,
      encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 120_000,
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" } });
  } catch { fail("REHEARSAL_WRANGLER_FAILED"); }
  if (result.error || result.status !== 0) fail("REHEARSAL_WRANGLER_FAILED");
  if (args.includes("--file")) return decodeImportResult(result.stdout);
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

export function* seedStatements(binding, accounts, events, cooldowns = true) {
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
  temporaryDirectory = null, profile = "standard" } = {}) {
  const scale = profile === LOCAL_SCALE_PROFILE.name;
  if (profile !== "standard" && !scale) fail("REHEARSAL_PROFILE_INVALID");
  if (scale) {
    if (accounts !== 1000 || events !== 100_000 || ![120_000, 600_000].includes(maxDurationMs)
        || ![512 * 2 ** 20, LOCAL_SCALE_PROFILE.maxDatabaseBytes].includes(maxDatabaseBytes)
        || ![2 ** 30, 2 ** 31].includes(maxRssBytes)) fail("REHEARSAL_PROFILE_OVERRIDES_FORBIDDEN");
    maxDurationMs = LOCAL_SCALE_PROFILE.timeoutMs; maxDatabaseBytes = LOCAL_SCALE_PROFILE.maxDatabaseBytes; maxRssBytes = LOCAL_SCALE_PROFILE.maxRssBytes;
  }
  const sources = await bundles(workerRoot, scale ? LOCAL_SCALE_PROFILE.throughMigration : null), admission = admissionForSources(sources, prefix);
  if (scale) validateScaleAdmission(admission);
  if (!Number.isInteger(accounts) || accounts < 2 || accounts > 1000 || !Number.isInteger(events) || events < accounts || events > 1_000_000
      || ![maxDurationMs, maxDatabaseBytes, maxRssBytes].every(n => Number.isSafeInteger(n) && n > 0)
      || maxDurationMs > 600_000 || maxDatabaseBytes > (scale ? LOCAL_SCALE_PROFILE.maxDatabaseBytes : 2 ** 30) || maxRssBytes > 2 ** 31) fail("REHEARSAL_LIMITS_INVALID");
  const directory = temporaryDirectory ?? await mkdtemp(join(tmpdir(), "tibotattle-migration-rehearsal-"));
  if (temporaryDirectory !== null) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await realpath(directory) !== resolve(directory)
        || (process.getuid && stat.uid !== process.getuid()) || (await readdir(directory)).length) fail("REHEARSAL_TEMPORARY_DIRECTORY_UNSAFE");
  }
  await chmod(directory, 0o700);
  const started = performance.now(), receipts = {}; let peakRssBytes = 0, scaleFixture = null, progressSequence = 0;
  const progress = (phase, migration = null, pass = null, state = "started") => {
    if (!scale) return;
    const value = { sequence: ++progressSequence, phase, migration, pass, state, elapsedMs: Math.ceil(performance.now() - started) };
    writeFileSync(join(directory, "progress.tmp"), JSON.stringify(value), { mode: 0o600 });
    renameSync(join(directory, "progress.tmp"), join(directory, "progress.json"));
  };
  progress("initializing");
  const check = database => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    const databaseBytes = database.prepare("PRAGMA page_count").get().page_count * database.prepare("PRAGMA page_size").get().page_size;
    if (performance.now() - started > maxDurationMs || databaseBytes > maxDatabaseBytes || peakRssBytes > maxRssBytes) fail("REHEARSAL_RESOURCE_CEILING_EXCEEDED");
    if (scale) { const disk = observeRehearsalScratch(directory); if (disk.scratchBytes > LOCAL_SCALE_PROFILE.maxScratchBytes || disk.freeBytes < LOCAL_SCALE_PROFILE.minFreeBytes) fail("REHEARSAL_RESOURCE_CEILING_EXCEEDED"); }
    return databaseBytes;
  };
  try {
    for (const binding of Object.keys(STREAMS)) {
      const path = join(directory, `${binding}.sqlite`); let database = new DatabaseSync(path);
      try {
        const configureConnection = () => {
          database.exec("PRAGMA foreign_keys=ON");
          if (scale) database.exec("PRAGMA journal_mode=DELETE; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;");
          check(database);
          const pageSize = database.prepare("PRAGMA page_size").get().page_size;
          database.exec(`PRAGMA max_page_count=${Math.max(1, Math.floor((scale && binding === "DELETION_LEDGER" ? 512 * 2 ** 20 : maxDatabaseBytes) / pageSize))};`);
        };
        configureConnection();
        database.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);");
        const apply = migration => {
          const transactionStarted = performance.now(); database.exec("BEGIN IMMEDIATE");
          try { const sqlStarted = performance.now(); database.exec(migration.sql); const sqlMs = Math.ceil(performance.now() - sqlStarted);
            database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(migration.name); database.exec("COMMIT");
            return { sqlMs, transactionMs: Math.ceil(performance.now() - transactionStarted) };
          } catch (error) { try { database.exec("ROLLBACK"); } catch { /* SQLite can roll back itself on SQLITE_FULL. */ } throw error; }
        };
        const start = prefix.migrations[binding].length;
        for (const migration of sources[binding].slice(0, start)) { apply(migration); check(database); }
        database.exec("BEGIN IMMEDIATE");
        try { let index = 0; for (const sql of seedStatements(binding, accounts, events, binding === "USAGE_MONITOR_DB" || start >= 2)) { database.exec(sql); if (index++ % 1000 === 0) check(database); }
          database.exec("COMMIT"); } catch (error) { try { database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ } throw error; }
        if (scale && binding === "USAGE_MONITOR_DB") {
          progress("padding");
          scaleFixture = padSyntheticRehearsal(database, { targetBytes: LOCAL_SCALE_PROFILE.targetBytes, check, onProgress: () => progress("padding") });
        }
        progress("preservation");
        const before = snapshot(database), steps = [];
        preserve(database, before);
        for (const migration of sources[binding].slice(start)) {
          const stepStarted = performance.now(), ledger = database.prepare("SELECT name FROM d1_migrations ORDER BY id").all();
          // Closing an uncommitted real SQLite connection models process interruption.
          progress("migration", migration.name, "interrupted");
          database.exec("BEGIN IMMEDIATE"); const interruptedStarted = performance.now(); database.exec(migration.sql);
          const interruptedSqlMs = Math.ceil(performance.now() - interruptedStarted);
          database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(migration.name);
          const recoveryStarted = performance.now(); database.close(); database = new DatabaseSync(path); configureConnection();
          const rollbackRecoveryMs = Math.ceil(performance.now() - recoveryStarted);
          progress("migration", migration.name, "interrupted", "completed");
          if (JSON.stringify(database.prepare("SELECT name FROM d1_migrations ORDER BY id").all()) !== JSON.stringify(ledger)) fail("MIGRATION_INTERRUPTION_ROLLBACK_FAILED");
          preserve(database, before);
          progress("migration", migration.name, "forward");
          const timing = apply(migration); progress("migration", migration.name, "forward", "completed");
          progress("preservation", migration.name); preserve(database, before);
          steps.push({ name: migration.name, sha256: migration.sha256, durationMs: Math.ceil(performance.now() - stepStarted), databaseBytes: check(database),
            ...(scale ? { transactions: { interruptedSqlMs, rollbackRecoveryMs, forwardSqlMs: timing.sqlMs, forwardTransactionMs: timing.transactionMs } } : {}) });
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
      receipts, ...(scale ? { scale: { profile, fixture: scaleFixture, maxScratchBytes: LOCAL_SCALE_PROFILE.maxScratchBytes,
        minInitialFreeBytes: LOCAL_SCALE_PROFILE.minInitialFreeBytes, minFreeBytes: LOCAL_SCALE_PROFILE.minFreeBytes,
        statementTiming: "not-collected", transactionTiming: "whole-unchanged-migration" } } : {}), remoteSyntax: "not-exercised", productionReadiness: false };
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
  profile = "standard", disk = observeRehearsalScratch,
  spawn = spawnChild, memory = sampledChildMemory, signal = (pid, name) => process.kill(-pid, name), terminationGraceMs = 5000 } = {}) {
  const scale = profile === LOCAL_SCALE_PROFILE.name;
  if (profile !== "standard" && !scale) fail("REHEARSAL_PROFILE_INVALID");
  if (scale) {
    if (accounts !== 1000 || events !== 100_000 || timeoutMs !== 120_000 || maxRssBytes !== 2 ** 30 || maxDatabaseBytes !== 512 * 2 ** 20) fail("REHEARSAL_PROFILE_OVERRIDES_FORBIDDEN");
    timeoutMs = LOCAL_SCALE_PROFILE.timeoutMs; maxRssBytes = LOCAL_SCALE_PROFILE.maxRssBytes; maxDatabaseBytes = LOCAL_SCALE_PROFILE.maxDatabaseBytes;
  }
  if (!Number.isInteger(accounts) || accounts < 2 || accounts > 1000 || !Number.isInteger(events) || events < accounts || events > 1_000_000
      || !Number.isSafeInteger(maxDatabaseBytes) || maxDatabaseBytes < 1 || maxDatabaseBytes > (scale ? LOCAL_SCALE_PROFILE.maxDatabaseBytes : 2 ** 30)) fail("REHEARSAL_LIMITS_INVALID");
  if (!["darwin", "linux"].includes(process.platform)) fail("REHEARSAL_PROCESS_CONTAINMENT_UNSUPPORTED");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000
      || !Number.isSafeInteger(maxRssBytes) || maxRssBytes < 1 || maxRssBytes > 2 ** 31
      || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1 || terminationGraceMs > 5000) fail("REHEARSAL_LIMITS_INVALID");
  // Validate lineage before starting a subprocess; no malformed source observation is reused.
  const admission = await inspectMigrationPrefix({ prefix, throughMigration: scale ? LOCAL_SCALE_PROFILE.throughMigration : null });
  if (scale) validateScaleAdmission(admission);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-migration-rehearsal-")));
  await chmod(directory, 0o700);
  let terminationConfirmed = true, peakScratchBytes = 0, minimumFreeBytes = null, lastProgress = null;
  try {
    if (scale) {
      const initial = disk(directory);
      if (!object(initial) || !Number.isSafeInteger(initial.freeBytes) || initial.freeBytes < LOCAL_SCALE_PROFILE.minInitialFreeBytes
          || initial.scratchBytes !== 0) fail("REHEARSAL_SCALE_DISK_ADMISSION_FAILED");
      minimumFreeBytes = initial.freeBytes;
    }
    return await new Promise((resolveResult, reject) => {
      let child, timer, memoryTimer, killTimer, confirmationTimer, stopped = false, reason = null, output = "", errorOutput = "", peakRssBytes = 0, missingMemorySamples = 0, childFailureCode = null;
      const cleanup = () => { clearTimeout(timer); clearInterval(memoryTimer); clearTimeout(killTimer); clearTimeout(confirmationTimer); };
      const finish = (code, value) => { if (stopped) return; stopped = true; cleanup();
        if (code) reject(Object.assign(new Error(code), { code, ...(scale ? { scaleEvidence: { profile, childFailureCode, sampledPeakRssBytes: peakRssBytes, rssScope: "parent-and-child", peakScratchBytes, minimumFreeBytes, lastProgress, terminationConfirmed } } : {}) })); else resolveResult(value); };
      const sendSignal = name => { try { if (Number.isSafeInteger(child?.pid) && child.pid > 1) signal(child.pid, name); } catch { /* close is the authority */ } };
      const stop = code => {
        if (reason || stopped) return; reason = code; sendSignal("SIGTERM");
        killTimer = setTimeout(() => sendSignal("SIGKILL"), Math.min(250, terminationGraceMs));
        confirmationTimer = setTimeout(() => finish("REHEARSAL_TERMINATION_UNCONFIRMED"), terminationGraceMs);
      };
      const observeDisk = (closing = false) => {
        if (!scale) return;
        const sample = disk(directory);
        if (!object(sample) || ![sample.scratchBytes, sample.freeBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("invalid observation");
        peakScratchBytes = Math.max(peakScratchBytes, sample.scratchBytes);
        minimumFreeBytes = Math.min(minimumFreeBytes, sample.freeBytes);
        if (sample.scratchBytes > LOCAL_SCALE_PROFILE.maxScratchBytes || sample.freeBytes < LOCAL_SCALE_PROFILE.minFreeBytes) {
          if (closing) reason ??= "REHEARSAL_PROCESS_DISK_EXCEEDED"; else stop("REHEARSAL_PROCESS_DISK_EXCEEDED");
        }
        let progress;
        try { const bytes = readFileSync(join(directory, "progress.json")); if (bytes.length > 2048) throw new Error("oversized progress"); progress = JSON.parse(bytes); }
        catch (error) { if (error.code === "ENOENT") return; throw error; }
        if (!exact(progress, ["sequence", "phase", "migration", "pass", "state", "elapsedMs"])
            || !Number.isSafeInteger(progress.sequence) || progress.sequence < 1 || progress.sequence > 4096
            || (lastProgress && progress.sequence < lastProgress.sequence)
            || !["initializing", "padding", "preservation", "migration"].includes(progress.phase)
            || !(progress.migration === null || admission.migrations.USAGE_MONITOR_DB.pending.some(row => row.name === progress.migration))
            || ![null, "interrupted", "forward"].includes(progress.pass) || !["started", "completed"].includes(progress.state)
            || !Number.isSafeInteger(progress.elapsedMs) || progress.elapsedMs < 0 || progress.elapsedMs > timeoutMs) throw new Error("invalid progress");
        lastProgress = progress;
      };
      try {
        terminationConfirmed = false;
        child = spawn(process.execPath, [`--max-old-space-size=${Math.max(16, Math.floor(maxRssBytes / 1024 / 1024))}`,
          fileURLToPath(import.meta.url), "--rehearsal-worker"], { cwd: WORKER_ROOT, detached: true, stdio: ["pipe", "pipe", "pipe"],
          env: { PATH: process.env.PATH, TMPDIR: scale ? directory : tmpdir(), NODE_NO_WARNINGS: "1" } });
      } catch { terminationConfirmed = true; finish("REHEARSAL_PROCESS_START_FAILED"); return; }
      timer = setTimeout(() => stop("REHEARSAL_PROCESS_TIMEOUT"), timeoutMs);
      memoryTimer = setInterval(() => { let bytes;
        try { observeDisk(); } catch { stop("REHEARSAL_PROCESS_DISK_UNAVAILABLE"); }
        try { bytes = memory(child.pid); } catch { bytes = null; }
        if (bytes === null) { if (++missingMemorySamples >= 4) stop("REHEARSAL_PROCESS_MEMORY_UNAVAILABLE"); return; }
        missingMemorySamples = 0;
        if (scale) bytes += process.memoryUsage().rss;
        peakRssBytes = Math.max(peakRssBytes, bytes);
        if (bytes > maxRssBytes) stop("REHEARSAL_PROCESS_MEMORY_EXCEEDED");
      }, 250);
      child.stdout.on("data", data => { if (Buffer.byteLength(output) + data.length > 2 * 1024 * 1024) { stop("REHEARSAL_PROCESS_OUTPUT_EXCEEDED"); return; } output += data.toString(); });
      child.stderr.on("data", data => { if (Buffer.byteLength(errorOutput) + data.length > 64 * 1024) { stop("REHEARSAL_PROCESS_OUTPUT_EXCEEDED"); return; } errorOutput += data.toString(); });
      child.on("error", () => { terminationConfirmed = true; finish("REHEARSAL_PROCESS_START_FAILED"); });
      child.on("close", code => {
        terminationConfirmed = true;
        if (scale) { try { observeDisk(true); } catch { if (!reason) reason = "REHEARSAL_PROCESS_DISK_UNAVAILABLE"; } }
        if (reason) { finish(reason); return; }
        if (code !== 0) {
          if (scale) {
            try {
              const failure = JSON.parse(errorOutput);
              if (exact(failure, ["ok", "code"]) && failure.ok === false && [
                "REHEARSAL_RESOURCE_CEILING_EXCEEDED", "REHEARSAL_LOCAL_SQL_FAILED", "REHEARSAL_FAILED",
                "MIGRATION_PRESERVATION_FAILED", "MIGRATION_FOREIGN_KEY_FAILED", "MIGRATION_INTEGRITY_FAILED",
                "MIGRATION_INTERRUPTION_ROLLBACK_FAILED", "MIGRATION_FINAL_LEDGER_DRIFT", "MIGRATION_REPLAY_NOT_NOOP",
                "REHEARSAL_SCALE_TARGET_NOT_MET", "REHEARSAL_SCALE_FIXTURE_INVALID",
              ].includes(failure.code)) childFailureCode = failure.code;
            } catch { /* Raw or malformed worker output is never retained in a closed receipt. */ }
          }
          finish("REHEARSAL_PROCESS_FAILED"); return;
        }
        let receipt;
        try { receipt = JSON.parse(output); } catch { finish("REHEARSAL_PROCESS_RESULT_INVALID"); return; }
        if (!exact(receipt, ["schemaVersion", "prefixDigest", "migrationDigest", "freshness", "migrations", "ok", "runtime", "fixture", "limits", "durationMs", "peakRssBytes", "receipts", "remoteSyntax", "productionReadiness", ...(scale ? ["scale"] : [])])
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
              || actual.steps.some((step, index) => !exact(step, ["name", "sha256", "durationMs", "databaseBytes", ...(scale ? ["transactions"] : [])])
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
        if (scale) {
          const actual = receipt.scale, fixture = actual?.fixture;
          if (!exact(actual, ["profile", "fixture", "maxScratchBytes", "minInitialFreeBytes", "minFreeBytes", "statementTiming", "transactionTiming"])
              || actual.profile !== profile || actual.maxScratchBytes !== LOCAL_SCALE_PROFILE.maxScratchBytes
              || actual.minInitialFreeBytes !== LOCAL_SCALE_PROFILE.minInitialFreeBytes || actual.minFreeBytes !== LOCAL_SCALE_PROFILE.minFreeBytes
              || actual.statementTiming !== "not-collected" || actual.transactionTiming !== "whole-unchanged-migration"
              || !exact(fixture, ["distribution", "initialBytes", "targetBytes", "baselineBytes", "rowsPerTelemetryTable", "paddedRowsPerTable", "paddingJsonBytes", "unpaddedRowsPerTable", "blocks", "blockRows", "paddingOrder", "productionRepresentative"])
              || fixture.distribution !== "synthetic-v1-legacy-heavy" || fixture.productionRepresentative !== false || fixture.paddingOrder !== "ascending-record-id"
              || fixture.targetBytes !== LOCAL_SCALE_PROFILE.targetBytes || fixture.rowsPerTelemetryTable !== events || fixture.blockRows !== LOCAL_SCALE_PROFILE.blockRows
              || fixture.paddingJsonBytes !== Buffer.byteLength(JSON.stringify({ synthetic_padding: "p".repeat(LOCAL_SCALE_PROFILE.paddingCharacters) }))
              || ![fixture.initialBytes, fixture.baselineBytes, fixture.paddedRowsPerTable, fixture.unpaddedRowsPerTable, fixture.blocks].every(value => Number.isSafeInteger(value) && value >= 0)
              || fixture.initialBytes >= fixture.targetBytes || fixture.baselineBytes < fixture.targetBytes || fixture.baselineBytes > fixture.targetBytes + LOCAL_SCALE_PROFILE.maxOvershootBytes
              || fixture.paddedRowsPerTable + fixture.unpaddedRowsPerTable !== events || fixture.paddedRowsPerTable !== fixture.blocks * fixture.blockRows
              || receipt.receipts.DELETION_LEDGER.databaseBytes > 512 * 2 ** 20
              || Object.values(receipt.receipts).some(value => value.steps.some(step => !exact(step.transactions, ["interruptedSqlMs", "rollbackRecoveryMs", "forwardSqlMs", "forwardTransactionMs"])
                || Object.values(step.transactions).some(value => !Number.isSafeInteger(value) || value < 0 || value > timeoutMs)))
              || lastProgress === null) { finish("REHEARSAL_PROCESS_RESULT_INVALID"); return; }
        }
        finish(null, { ...receipt, containment: { processGroup: true, timeoutMs, maxRssBytes, sampledPeakRssBytes: peakRssBytes, terminationConfirmed: true,
          ...(scale ? { rssScope: "parent-and-child", sampledPeakScratchBytes: peakScratchBytes, minimumObservedFreeBytes: minimumFreeBytes, lastProgress } : {}) } });
      });
      child.stdin.on("error", () => stop("REHEARSAL_PROCESS_INPUT_FAILED"));
      child.stdin.end(JSON.stringify({ prefix, accounts, events, maxDurationMs: timeoutMs, maxRssBytes, maxDatabaseBytes, temporaryDirectory: directory, ...(scale ? { profile } : {}) }));
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
  if (!exact(options, ["prefix", "accounts", "events", "maxDurationMs", "maxRssBytes", "maxDatabaseBytes", "temporaryDirectory", ...(options?.profile === LOCAL_SCALE_PROFILE.name ? ["profile"] : [])])) fail("REHEARSAL_INPUT_INVALID");
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
export async function rehearseRemoteSyntax({ workerRoot = WORKER_ROOT, prefix, target, confirmation, importMigration = null, spawn = spawnSync }) {
  if (confirmation !== "APPLY_SYNTHETIC_MIGRATIONS_TO_DISPOSABLE_D1") fail("REMOTE_REHEARSAL_CONFIRMATION_REQUIRED");
  const sources = await bundles(workerRoot), admission = admissionForSources(sources, prefix);
  if (importMigration !== null && (importMigration !== IMPORT_OWNERSHIP_MIGRATION
      || prefix.migrations.USAGE_MONITOR_DB.length !== 56 || prefix.migrations.DELETION_LEDGER.length !== 2
      || !admission.migrations.USAGE_MONITOR_DB.pending.some(row => row.name === importMigration))) fail("REMOTE_REHEARSAL_IMPORT_INVALID");
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
  let attempted = false, retainDirectory = false;
  // Keep bounded evidence for the exact last call; never capture the environment.
  // This private directory is retained only for the explicit import experiment.
  const trackedSpawn = importMigration === null ? spawn : (command, args, options) => {
    const result = spawn(command, args, options);
    writeFileSync(join(directory, "last-command-private.json"), JSON.stringify({
      phase: args.includes("--file") ? (args[args.indexOf("--file") + 1].endsWith("ownership-migration-import.sql") ? "ownership_import" : "synthetic_seed")
        : args[1] === "migrations" ? "migrations_apply" : "readback",
      args, status: result.status ?? null, signal: result.signal ?? null,
      errorCode: result.error?.code ?? null,
      stdout: String(result.stdout ?? "").slice(0, 2 * 1024 * 1024),
      stderr: String(result.stderr ?? "").slice(0, 2 * 1024 * 1024),
    }), { mode: 0o600 });
    return result;
  };
  try {
    const configPath = join(directory, "wrangler.json");
    await writeFile(configPath, JSON.stringify({ name: "tibotattle-rehearsal", compatibility_date: config.compatibility_date,
      d1_databases: Object.entries(target.databases).map(([binding, db]) => ({ binding, ...db, migrations_dir: join(directory, binding) })) }), { mode: 0o600 });
    const args = ["--config", configPath];
    const importReceipts = [];
    // Only the admitted fresh pair is queried; these are tiny generated fixtures.
    const capture = (binding, previous = null) => {
      const infos = wranglerRun(workerRoot, ["d1", "execute", binding, ...args, "--remote", "--command",
        PRESERVED_TABLES.map(table => `PRAGMA table_info(${quote(table)});`).join("\n"), "--json"], trackedSpawn);
      if (!Array.isArray(infos) || infos.length !== PRESERVED_TABLES.length || infos.some(row => row.success !== true || !Array.isArray(row.results))) fail("REMOTE_REHEARSAL_PRESERVATION_FAILED");
      const shape = previous ?? Object.fromEntries(infos.flatMap((row, i) => row.results.length ? [[PRESERVED_TABLES[i], {
        columns: row.results.map(column => column.name), order: row.results.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name),
      }]] : []));
      const tables = Object.keys(shape);
      const rows = wranglerRun(workerRoot, ["d1", "execute", binding, ...args, "--remote", "--command",
        tables.map(table => `SELECT ${shape[table].columns.map(quote).join(",")} FROM ${quote(table)} ORDER BY ${(shape[table].order.length ? shape[table].order : shape[table].columns).map(quote).join(",")} LIMIT 257;`).join("\n"), "--json"], trackedSpawn);
      if (!Array.isArray(rows) || rows.length !== tables.length || rows.some(row => row.success !== true || !Array.isArray(row.results) || row.results.length > 256)) fail("REMOTE_REHEARSAL_PRESERVATION_FAILED");
      return { shape, digests: Object.fromEntries(tables.map((table, i) => [table, { count: rows[i].results.length, sha256: sha(JSON.stringify(rows[i].results)) }])) };
    };
    // Query both before any mutation; an occupied or unknown target never receives SQL.
    for (const binding of Object.keys(STREAMS)) {
      const rows = resultRows(wranglerRun(workerRoot, ["d1", "execute", binding, ...args, "--remote", "--command",
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';", "--json"], trackedSpawn));
      if (rows.length !== 1 || rows[0].n !== 0) fail("REMOTE_REHEARSAL_TARGET_NOT_EMPTY");
    }
    for (const binding of Object.keys(STREAMS)) {
      await mkdir(join(directory, binding), { mode: 0o700 });
      const start = prefix.migrations[binding].length;
      for (const migration of sources[binding].slice(0, start)) await writeFile(join(directory, binding, migration.name), migration.sql, { mode: 0o600 });
      const apply = () => {
        attempted = true;
        // migrations apply has human output; avoid logging it and do not parse it as JSON.
        const result = trackedSpawn(join(workerRoot, "node_modules/.bin/wrangler"), ["d1", "migrations", "apply", binding, ...args, "--remote"],
          { cwd: workerRoot, encoding: "utf8", input: "y\n", timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" } });
        if (result.error || result.status !== 0) fail("REMOTE_REHEARSAL_OUTCOME_UNCERTAIN");
      };
      apply();
      const seed = join(directory, `${binding}-seed.sql`);
      await writeFile(seed, [...seedStatements(binding, 2, 20, binding === "USAGE_MONITOR_DB" || start >= 2)].join("\n"), { mode: 0o600 });
      wranglerRun(workerRoot, ["d1", "execute", binding, ...args, "--remote", "--file", seed, "--yes", "--json"], trackedSpawn);
      const before = importMigration ? capture(binding) : null;
      if (importMigration && binding === "USAGE_MONITOR_DB") {
        for (const migration of sources[binding].slice(start)) {
          await writeFile(join(directory, binding, migration.name), migration.sql, { mode: 0o600 });
          if (migration.name !== importMigration) { apply(); continue; }
          const sql = `${migration.sql}\nINSERT INTO d1_migrations (name) values ('${migration.name}');`;
          const path = join(directory, "ownership-migration-import.sql");
          await writeFile(path, sql, { mode: 0o600 });
          const [result] = wranglerRun(workerRoot, ["d1", "execute", binding, ...args, "--remote", "--file", path, "--yes", "--json"], trackedSpawn);
          importReceipts.push({ name: migration.name, sha256: migration.sha256, importSha256: sha(sql), durationMs: result.meta.duration, terminalResultVerified: true });
        }
      } else {
        for (const migration of sources[binding].slice(start)) await writeFile(join(directory, binding, migration.name), migration.sql, { mode: 0o600 });
        apply();
      }
      if (before) {
        if (JSON.stringify(capture(binding, before.shape).digests) !== JSON.stringify(before.digests)) fail("REMOTE_REHEARSAL_PRESERVATION_FAILED");
        if (resultRows(wranglerRun(workerRoot, ["d1", "execute", binding, ...args, "--remote", "--command", "PRAGMA foreign_key_check;", "--json"], spawn)).length) fail("REMOTE_REHEARSAL_PRESERVATION_FAILED");
      }
      const names = resultRows(wranglerRun(workerRoot, ["d1", "execute", binding, ...args, "--remote", "--command", LEDGER_SQL, "--json"], spawn)).map(row => row.name);
      if (JSON.stringify(names) !== JSON.stringify(sources[binding].map(row => row.name))) fail("REMOTE_REHEARSAL_LEDGER_DRIFT");
      const expected = binding === "USAGE_MONITOR_DB" ? { participants: 2, device_credentials: 2,
        telemetry_v1_device_consents: 2, telemetry_v1_records: 20, telemetry_records: 20, identity_reenrollment_cooldowns: 2 }
        : { deletion_tombstones: 2, identity_reenrollment_cooldowns: start >= 2 ? 2 : 0 };
      const sql = `SELECT ${Object.keys(expected).map(table => `(SELECT COUNT(*) FROM ${table}) AS ${table}`).join(",")};`;
      const rows = resultRows(wranglerRun(workerRoot, ["d1", "execute", binding, ...args, "--remote", "--command", sql, "--json"], trackedSpawn));
      if (rows.length !== 1 || !exact(rows[0], Object.keys(expected))
          || Object.entries(expected).some(([key, count]) => rows[0][key] !== count)) fail("REMOTE_REHEARSAL_PRESERVATION_FAILED");
    }
    return { schemaVersion: SCHEMA, ok: true, mode: "remote-syntax", targetDigest: sha(JSON.stringify(target)),
      ...admission, fixture: { accounts: 2, events: 20 }, ...(importMigration ? { importReceipts, preservedRowsVerified: true } : {}), productionReadiness: false };
  } catch (error) {
    if (attempted) {
      // Preserve this exact private target/config/SQL after an uncertain import.
      // It is evidence for reconciliation, never permission to rerun occupied targets.
      retainDirectory = importMigration !== null;
      throw Object.assign(new Error("REMOTE_REHEARSAL_OUTCOME_UNCERTAIN"), {
        code: "REMOTE_REHEARSAL_OUTCOME_UNCERTAIN", ...(retainDirectory ? { recoveryDirectory: directory } : {}),
      });
    }
    throw error;
  } finally { if (!retainDirectory) await rm(directory, { recursive: true }); }
}

export async function main(args = process.argv.slice(2)) {
  const [mode, ...flags] = args, options = {};
  if (!["observe-prefix", "local", "remote-syntax"].includes(mode)) fail("REHEARSAL_USAGE_INVALID");
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i], value = flags[i + 1];
    if (!["--prefix", "--environment", "--accounts", "--events", "--target", "--confirm", "--import-migration", "--profile"].includes(key)
        || key in options || !value || value.startsWith("--")) fail("REHEARSAL_USAGE_INVALID");
    options[key] = value;
  }
  const allowed = { "observe-prefix": ["--environment"], local: ["--prefix", "--accounts", "--events", "--profile"], "remote-syntax": ["--prefix", "--target", "--confirm", "--import-migration"] }[mode];
  if (Object.keys(options).some(key => !allowed.includes(key))) fail("REHEARSAL_USAGE_INVALID");
  if (mode === "observe-prefix") return observeMigrationPrefix({ environment: options["--environment"] });
  if (!options["--prefix"]) fail("REHEARSAL_USAGE_INVALID");
  if (options["--profile"] && (options["--profile"] !== LOCAL_SCALE_PROFILE.name || options["--accounts"] || options["--events"])) fail("REHEARSAL_PROFILE_OVERRIDES_FORBIDDEN");
  const prefix = await privateJson(options["--prefix"]);
  if (mode === "local") return runMigrationRehearsalProcess({ prefix, profile: options["--profile"] ?? "standard", accounts: options["--accounts"] ? Number(options["--accounts"]) : undefined,
    events: options["--events"] ? Number(options["--events"]) : undefined });
  if (!options["--target"]) fail("REHEARSAL_USAGE_INVALID");
  return rehearseRemoteSyntax({ prefix, target: await privateJson(options["--target"]), confirmation: options["--confirm"], importMigration: options["--import-migration"] ?? null });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (process.argv.length === 3 && process.argv[2] === "--rehearsal-worker" ? workerMain() : main()).then(result => process.stdout.write(`${JSON.stringify(result)}\n`), error => {
    const code = typeof error?.code === "string" && /^(?:MIGRATION|REHEARSAL|REMOTE_REHEARSAL|LOCAL_MIGRATION)_[A-Z_]+$/.test(error.code) ? error.code : "REHEARSAL_FAILED";
    process.stderr.write(`${JSON.stringify({ ok: false, code, ...(typeof error?.recoveryDirectory === "string" ? { recoveryDirectory: error.recoveryDirectory } : {}), ...(error?.scaleEvidence ? { scaleEvidence: error.scaleEvidence } : {}) })}\n`); process.exitCode = 1;
  });
}
