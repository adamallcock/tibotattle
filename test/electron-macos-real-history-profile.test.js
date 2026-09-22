import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openLocalCollectorStateSession } from "../src/local-collector-state.js";
import { openLocalUnifiedIndex } from "../src/local-unified-index.js";
import {
  REAL_HISTORY_PROFILE_SCHEMA_VERSION,
  parseRealHistoryProfileArguments,
  prepareRealHistoryProfile,
  prepareInteractivePacingIdentity,
  interactiveEnvironment,
  validateRealHistoryProfile,
} from "../scripts/electron-macos-real-history-profile.mjs";

async function makeSyntheticState(t, { legacyIndex = false, wal = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-electron-profile-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceStateRoot = join(root, "source-state");
  const codexHomePath = join(root, "codex-home");
  const profilePath = join(root, "profile");
  await Promise.all([
    mkdir(sourceStateRoot, { recursive: true, mode: 0o700 }),
    mkdir(codexHomePath, { recursive: true, mode: 0o700 }),
  ]);
  const indexFile = join(sourceStateRoot, "local-unified-index-v1.sqlite");
  const collectorFile = join(sourceStateRoot, "local-collector-state-v1.sqlite");
  const saltFile = join(sourceStateRoot, "local-unified-index-device-salt-v1");
  const index = openLocalUnifiedIndex(indexFile, { create: true });
  index.close();
  if (wal) {
    const writer = new DatabaseSync(indexFile);
    writer.exec("PRAGMA journal_mode=WAL;");
    writer.exec("CREATE TABLE qa_wal_marker(value TEXT NOT NULL);");
    writer.prepare("INSERT INTO qa_wal_marker(value) VALUES (?)").run("synthetic");
    // Keep the writer open while the handoff runs. This leaves the marker in
    // the WAL and exercises backup()'s sidecar-aware snapshot behavior.
    t.after(() => writer.close());
  }
  if (legacyIndex) {
    const legacy = new DatabaseSync(indexFile);
    legacy.exec("PRAGMA user_version=8;");
    legacy.prepare(
      "DELETE FROM meta WHERE key IN (?, ?, ?)",
    ).run(
      "compatibility_format_user_version",
      "compatibility_minimum_reader_user_version",
      "compatibility_minimum_writer_user_version",
    );
    legacy.close();
  }
  const collector = await openLocalCollectorStateSession({ stateFile: collectorFile });
  await collector.close({ verifyIntegrity: false });
  const salt = randomBytes(32);
  await writeFile(saltFile, salt, { mode: 0o600 });
  await chmod(saltFile, 0o600);
  return {
    root,
    sourceStateRoot,
    codexHomePath,
    profilePath,
    indexFile,
    collectorFile,
    saltFile,
    salt,
  };
}

function logicalDatabaseDigest(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const hash = createHash("sha256");
    const tables = database.prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    ).all();
    for (const table of tables) {
      const tableName = String(table.name);
      const quotedName = `"${tableName.replaceAll('"', '""')}"`;
      const rows = database.prepare(`SELECT * FROM ${quotedName}`).all()
        .map((row) => JSON.stringify(row))
        .sort();
      hash.update(JSON.stringify({ name: tableName, sql: table.sql, rows }));
    }
    return hash.digest("hex");
  } finally {
    database.close();
  }
}

test("interactive pacing creates a separate stable identity without changing copied or source history", async (t) => {
  const fixture = await makeSyntheticState(t);
  await prepareRealHistoryProfile(fixture);
  const profile = await validateRealHistoryProfile(fixture.profilePath);
  const exportBefore = await readFile(profile.identityPath);
  const sourceBefore = logicalDatabaseDigest(fixture.collectorFile);
  const copyBefore = logicalDatabaseDigest(profile.collectorPath);
  const path = await prepareInteractivePacingIdentity(fixture.profilePath);
  const first = await readFile(path);
  assert.equal(first.length, 32);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.notDeepEqual(first, Buffer.from(exportBefore.toString().trim(), "base64url"));
  assert.notDeepEqual(first, fixture.salt);
  assert.equal(await prepareInteractivePacingIdentity(fixture.profilePath), path);
  assert.deepEqual(await readFile(path), first);
  assert.deepEqual(await readFile(profile.identityPath), exportBefore);
  assert.equal(logicalDatabaseDigest(fixture.collectorFile), sourceBefore);
  assert.equal(logicalDatabaseDigest(profile.collectorPath), copyBefore);
  const env = interactiveEnvironment(profile, fixture.codexHomePath, path);
  assert.equal(env.USAGE_MONITOR_DEVELOPMENT_ACCOUNT_SECRET_FILE, path);
  assert.equal(env.USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE, profile.identityPath);
  assert.equal(env.USAGE_MONITOR_TEST_LANE, "macos-electron-local-qa-v1");
  assert.equal(env.USAGE_MONITOR_CENTRAL_ORIGIN, undefined);
  assert.equal(interactiveEnvironment(profile, fixture.codexHomePath)
    .USAGE_MONITOR_DEVELOPMENT_ACCOUNT_SECRET_FILE, undefined);
  first.fill(0);
  exportBefore.fill(0);
});

test("interactive pacing refuses invalid existing identity instead of replacing it", async (t) => {
  const fixture = await makeSyntheticState(t);
  await prepareRealHistoryProfile(fixture);
  const path = join(fixture.profilePath, "identity", "account-observation-development");
  const malformed = Buffer.from("synthetic-invalid");
  await writeFile(path, malformed, { mode: 0o600 });
  await assert.rejects(() => prepareInteractivePacingIdentity(fixture.profilePath), {
    code: "ELECTRON_REAL_HISTORY_PROFILE_PACING_IDENTITY_INVALID",
  });
  assert.deepEqual(await readFile(path), malformed);
});

test("interactive pacing recovers interrupted publication without rotating the key", async (t) => {
  const fixture = await makeSyntheticState(t);
  await prepareRealHistoryProfile(fixture);
  const directory = join(fixture.profilePath, "identity");
  const abandoned = join(directory, ".account-observation-development.pending-00000000-0000-0000-0000-000000000001");
  await writeFile(abandoned, "partial", { mode: 0o600 });
  const path = await prepareInteractivePacingIdentity(fixture.profilePath);
  const first = await readFile(path);
  const published = join(directory, ".account-observation-development.pending-00000000-0000-0000-0000-000000000002");
  await link(path, published);
  assert.equal((await lstat(path)).nlink, 2);
  assert.equal(await prepareInteractivePacingIdentity(fixture.profilePath), path);
  assert.equal((await lstat(path)).nlink, 1);
  assert.deepEqual(await readFile(path), first);
  assert.equal(await readFile(abandoned, "utf8"), "partial");
  await assert.rejects(() => lstat(published), { code: "ENOENT" });
  first.fill(0);
});

test("interactive pacing rejects a linked identity and leaves its target intact", async (t) => {
  const fixture = await makeSyntheticState(t);
  await prepareRealHistoryProfile(fixture);
  const profile = await validateRealHistoryProfile(fixture.profilePath);
  const before = await readFile(profile.identityPath);
  await symlink(profile.identityPath,
    join(fixture.profilePath, "identity", "account-observation-development"));
  await assert.rejects(() => prepareInteractivePacingIdentity(fixture.profilePath), {
    code: "ELECTRON_REAL_HISTORY_PROFILE_PACING_IDENTITY_INVALID",
  });
  assert.deepEqual(await readFile(profile.identityPath), before);
  before.fill(0);
});

test("profile argument parser keeps prepare and launch contracts explicit", () => {
  const prepared = parseRealHistoryProfileArguments([
    "prepare",
    "--source-state-root", "/tmp/native-state",
    "--profile", "/tmp/profile",
    "--codex-home", "/tmp/codex",
  ]);
  assert.deepEqual(prepared, {
    help: false,
    command: "prepare",
    sourceStateRoot: "/tmp/native-state",
    profilePath: "/tmp/profile",
    codexHomePath: "/tmp/codex",
  });
  const launch = parseRealHistoryProfileArguments([
    "launch",
    "--app", "/tmp/TiboTattle Dev.app",
    "--profile", "/tmp/profile",
    "--codex-home", "/tmp/codex",
    "--artifact-sha256", "a".repeat(64),
    "--source-revision", "1".repeat(40),
    "--mode", "snapshot",
  ]);
  assert.equal(launch.command, "launch");
  assert.equal(launch.mode, "snapshot");
  const interactive = parseRealHistoryProfileArguments([
    "interactive",
    "--app", "/tmp/TiboTattle Dev.app",
    "--profile", "/tmp/profile",
    "--codex-home", "/tmp/codex",
    "--artifact-sha256", "a".repeat(64),
    "--source-revision", "1".repeat(40),
  ]);
  assert.equal(interactive.command, "interactive");
  assert.equal(interactive.mode, "full");
  for (const args of [
    [],
    ["prepare", "--source-state-root", "relative", "--profile", "/tmp/p", "--codex-home", "/tmp/c"],
    ["prepare", "--source-state-root", "/tmp/s", "--profile", "/tmp/p", "--codex-home", "/tmp/c", "--profile", "/tmp/other"],
    ["launch", "--app", "/tmp/a", "--profile", "/tmp/p", "--codex-home", "/tmp/c", "--artifact-sha256", "b".repeat(64), "--source-revision", "A".repeat(40)],
    ["launch", "--app", "/tmp/a", "--profile", "/tmp/p", "--codex-home", "/tmp/c", "--artifact-sha256", "b".repeat(64), "--source-revision", "1".repeat(40), "--unknown", "x"],
  ]) {
    assert.throws(
      () => parseRealHistoryProfileArguments(args),
      (error) => error.code === "ELECTRON_REAL_HISTORY_PROFILE_INPUT_INVALID"
        || error.code === "ELECTRON_REAL_HISTORY_PROFILE_PATH_INVALID",
    );
  }
  assert.deepEqual(parseRealHistoryProfileArguments(["--help"]), { help: true });
});

test("prepare copies current unified state with the matching salt and preserves WAL", async (t) => {
  const fixture = await makeSyntheticState(t, { wal: true });
  const sourceIndexDigest = logicalDatabaseDigest(fixture.indexFile);
  const sourceCollectorDigest = logicalDatabaseDigest(fixture.collectorFile);
  const sourceSalt = await readFile(fixture.saltFile);
  const result = await prepareRealHistoryProfile(fixture);
  assert.deepEqual(result, {
    status: "prepared",
    schemaVersion: REAL_HISTORY_PROFILE_SCHEMA_VERSION,
    deviceSaltCopied: true,
    hostedOrigin: "none",
    contributionEnabled: false,
  });
  const profile = await validateRealHistoryProfile(fixture.profilePath);
  assert.equal(profile.receipt.status, "prepared");
  // SQLite backup may canonicalize page layout or materialize a live WAL, so
  // compare every table schema and row value rather than raw page bytes.
  assert.equal(logicalDatabaseDigest(profile.indexPath), sourceIndexDigest);
  assert.equal(logicalDatabaseDigest(profile.collectorPath), sourceCollectorDigest);
  assert.deepEqual(await readFile(profile.saltPath), sourceSalt);
  const receiptText = await readFile(join(fixture.profilePath, "profile-handoff-v1.json"), "utf8");
  assert.equal(receiptText.includes(fixture.sourceStateRoot), false);
  assert.equal(receiptText.includes(fixture.codexHomePath), false);
});

test("prepare fails closed before or during copy when the source identity is missing or changed", async (t) => {
  const missing = await makeSyntheticState(t);
  await rm(missing.saltFile);
  await assert.rejects(
    () => prepareRealHistoryProfile(missing),
    (error) => error.code === "ELECTRON_REAL_HISTORY_PROFILE_SALT_INVALID"
      || error.code === "ELECTRON_REAL_HISTORY_PROFILE_SOURCE_MISSING",
  );

  const existing = await makeSyntheticState(t);
  await mkdir(existing.profilePath, { mode: 0o700 });
  await assert.rejects(
    () => prepareRealHistoryProfile(existing),
    (error) => error.code === "ELECTRON_REAL_HISTORY_PROFILE_TARGET_EXISTS",
  );
});

test("a later durable profile write remains launch-valid without touching source state", async (t) => {
  const fixture = await makeSyntheticState(t);
  await prepareRealHistoryProfile(fixture);
  const profile = await validateRealHistoryProfile(fixture.profilePath);
  const database = new DatabaseSync(profile.indexPath);
  database.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?)",
  ).run("qa_profile_mutation", "synthetic");
  database.close();
  await assert.doesNotReject(() => validateRealHistoryProfile(fixture.profilePath));
  assert.deepEqual(await readFile(fixture.saltFile), await readFile(profile.saltPath));
});

test("a supported runtime schema migration can refresh a stale receipt without widening the gate", async (t) => {
  const fixture = await makeSyntheticState(t);
  await prepareRealHistoryProfile(fixture);
  const receiptPath = join(fixture.profilePath, "profile-handoff-v1.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  // Model a profile prepared by the prior writer, then opened by the current
  // packaged writer. The exact receipt digest remains copy provenance, while
  // the current database is checked against the current writer schema.
  receipt.nativeState.unifiedIndex.structureDigest = "a".repeat(64);
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  await assert.doesNotReject(() => validateRealHistoryProfile(fixture.profilePath));

  const database = new DatabaseSync(join(
    fixture.profilePath,
    "state/local-unified-index-v1.sqlite",
  ));
  database.exec("ALTER TABLE meta ADD COLUMN qa_unrecognized TEXT");
  database.close();
  await assert.rejects(
    () => validateRealHistoryProfile(fixture.profilePath),
    (error) => error.code === "ELECTRON_REAL_HISTORY_PROFILE_HANDOFF_INVALID",
  );
});

test("a recognized pre-current index migrates only inside the private profile", async (t) => {
  const fixture = await makeSyntheticState(t, { legacyIndex: true });
  const source = new DatabaseSync(fixture.indexFile, { readOnly: true });
  assert.equal(source.prepare("PRAGMA user_version").get()?.user_version, 8);
  source.close();
  await prepareRealHistoryProfile(fixture);
  const profile = await validateRealHistoryProfile(fixture.profilePath);
  assert.equal(profile.receipt.nativeState.unifiedIndex.userVersion, 11);
  const sourceAfter = new DatabaseSync(fixture.indexFile, { readOnly: true });
  assert.equal(sourceAfter.prepare("PRAGMA user_version").get()?.user_version, 8);
  sourceAfter.close();
});
