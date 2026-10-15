import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, chmod, lstat, mkdtemp, open, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  CLAUDE_DESKTOP_INCREMENTAL_CANONICALIZER_VERSION,
  openClaudeDesktopIncrementalCanonicalizer,
} from "../src/claude-desktop-incremental-canonicalizer.js";
import {
  createClaudeTranscriptExportSourcePlan,
  scanClaudeTranscriptExportSource,
} from "../src/claude-transcript-export-source.js";
import { createExportResourceGuard } from "../src/export-resource-policy.js";

const SECRET = Buffer.alloc(32, 53);
const PRIVATE = "PRIVATE_INCREMENTAL_CLAUDE_CANARY";
const START_AT = "2026-07-24T12:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";
const MAXIMUM_LINE_BYTES = 16 * 1024 * 1024;
const CANONICAL_TABLES = [
  "canonical_meta", "canonical_source", "canonical_group", "canonical_tool", "dirty_group",
];

function assistant(timestamp, { output = 3, toolId = "tool-a", toolName = "Read", input = 11 } = {}) {
  return {
    type: "assistant",
    timestamp,
    sessionId: `session-${PRIVATE}`,
    message: {
      id: `message-${PRIVATE}`,
      model: "claude-opus-4-8",
      content: [
        { type: "thinking", thinking: PRIVATE.repeat(128) },
        { type: "text", text: PRIVATE.repeat(128) },
        { type: "tool_use", id: `${toolId}-${PRIVATE}`, name: toolName, input: { private: PRIVATE } },
      ],
      usage: {
        input_tokens: input,
        cache_read_input_tokens: 17,
        cache_creation_input_tokens: 13,
        output_tokens: output,
        cache_creation: { ephemeral_5m_input_tokens: 13, ephemeral_1h_input_tokens: 0 },
        speed: "standard",
      },
    },
  };
}

async function databaseContains(root, needle) {
  for (const name of await readdir(root)) {
    if (!name.startsWith("canonical.sqlite")) continue;
    if ((await readFile(join(root, name))).includes(Buffer.from(needle))) return true;
  }
  return false;
}

function canonicalRows(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(CANONICAL_TABLES.map((table) => [
      table, database.prepare(`SELECT * FROM ${table}`).all().map((row) => ({ ...row })),
    ]));
  } finally {
    database.close();
  }
}

function createLegacyCanonicalDatabase(path, rows, { withoutSourceGeneration = false } = {}) {
  const database = new DatabaseSync(path);
  try {
    // The two supported v0.2 layouts, created directly rather than downgrading a store.
    database.exec(`
      CREATE TABLE canonical_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
      CREATE TABLE canonical_source (
        source_key TEXT PRIMARY KEY, device INTEGER NOT NULL, inode INTEGER NOT NULL,
        birthtime_ms INTEGER NOT NULL, prefix_bytes INTEGER NOT NULL CHECK(prefix_bytes >= 0),
        prefix_sha256 TEXT NOT NULL, prefix_lines INTEGER NOT NULL CHECK(prefix_lines >= 0),
        mtime_ms INTEGER NOT NULL CHECK(mtime_ms >= 0), generation INTEGER NOT NULL CHECK(generation >= 1),
        status TEXT NOT NULL CHECK(status IN ('present', 'missing_suspected')),
        updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE canonical_group (
        message_key TEXT PRIMARY KEY, invariant_sha256 TEXT NOT NULL, top_level_invariant_sha256 TEXT,
        iteration_invariant_sha256 TEXT, selected_timestamp TEXT NOT NULL,
        selected_output_tokens INTEGER NOT NULL CHECK(selected_output_tokens >= 0),
        selected_cost_output_tokens INTEGER NOT NULL CHECK(selected_cost_output_tokens >= 0),
        selected_has_iteration INTEGER NOT NULL CHECK(selected_has_iteration IN (0, 1)),
        selected_source_key TEXT NOT NULL,
        ${withoutSourceGeneration ? "" : "selected_source_generation INTEGER NOT NULL CHECK(selected_source_generation >= 1),"}
        selected_line_ordinal INTEGER NOT NULL CHECK(selected_line_ordinal >= 1),
        selected_cost_event_count INTEGER NOT NULL CHECK(selected_cost_event_count >= 1),
        selected_cost_structure_sha256 TEXT NOT NULL, selected_candidates_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE canonical_tool (
        message_key TEXT NOT NULL, tool_key TEXT NOT NULL, category TEXT NOT NULL,
        PRIMARY KEY(message_key, tool_key), FOREIGN KEY(message_key) REFERENCES canonical_group(message_key)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE dirty_group (
        message_key TEXT PRIMARY KEY, FOREIGN KEY(message_key) REFERENCES canonical_group(message_key)
      ) STRICT, WITHOUT ROWID;
    `);
    for (const table of CANONICAL_TABLES) {
      for (const original of rows[table]) {
        const row = { ...original };
        if (table === "canonical_meta" && row.key === "schema_version") {
          row.value = "claude-desktop-incremental-canonicalizer-v0.2";
        }
        if (table === "canonical_source") delete row.mtime_ms_precise;
        if (table === "canonical_group" && withoutSourceGeneration) delete row.selected_source_generation;
        const columns = Object.keys(row);
        database.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
          .run(...Object.values(row));
      }
    }
  } finally {
    database.close();
  }
}

function assertLegacySchemaWritesRefused(path) {
  const beforeRows = canonicalRows(path);
  const database = new DatabaseSync(path);
  try {
    const beforeSchema = database.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all();
    // Exact unconditional statement used by the historical v0.2 opener.
    assert.throws(() => database.prepare(
      "INSERT OR REPLACE INTO canonical_meta(key, value) VALUES ('schema_version', ?)",
    ).run("claude-desktop-incremental-canonicalizer-v0.2"), /claude_desktop_incremental_schema_version/u);
    assert.throws(() => database.prepare(
      "UPDATE canonical_meta SET value = ? WHERE key = 'schema_version'",
    ).run("claude-desktop-incremental-canonicalizer-v0.2"), /claude_desktop_incremental_schema_version/u);
    assert.throws(() => database.exec(
      "UPDATE canonical_meta SET key = 'legacy_version' WHERE key = 'schema_version'",
    ), /claude_desktop_incremental_schema_version/u);
    assert.deepEqual(database.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all(), beforeSchema);
    assert.deepEqual(canonicalRows(path), beforeRows);
  } finally {
    database.close();
  }
}

test("incremental canonical state enforces the unfinished line limit before recording a source", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-incremental-tail-limit-"));
  await chmod(root, 0o700);
  const transcript = join(root, "session.jsonl");
  const canonicalizer = openClaudeDesktopIncrementalCanonicalizer(
    join(root, "canonical.sqlite"), { secret: SECRET },
  );
  try {
    const emptySnapshot = canonicalizer.snapshot();
    assert.deepEqual(emptySnapshot, { sources: 0, groups: 0, tools: 0, dirtyGroups: 0 });
    await writeFile(transcript, Buffer.alloc(MAXIMUM_LINE_BYTES + 1, 0x7b), { mode: 0o600 });
    await assert.rejects(canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 1,
    }), (error) => error.code === "claude_desktop_incremental_line_bytes");
    assert.deepEqual(canonicalizer.snapshot(), emptySnapshot);

    await writeFile(transcript, Buffer.alloc(MAXIMUM_LINE_BYTES, 0x7b), { mode: 0o600 });
    const exactLimit = await canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 2,
    });
    assert.equal(exactLimit.parsedBytes, 0);
    assert.equal(exactLimit.parsedLines, 0);
    assert.equal(exactLimit.assistantOccurrences, 0);
    assert.deepEqual(exactLimit.candidates, []);
    assert.equal(exactLimit.presentSources.length, 1);
    assert.deepEqual(canonicalizer.snapshot(), { sources: 1, groups: 0, tools: 0, dirtyGroups: 0 });
  } finally {
    canonicalizer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("incremental canonical state preserves its complete prefix at the unfinished line limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-incremental-prefix-limit-"));
  await chmod(root, 0o700);
  const transcript = join(root, "session.jsonl");
  const prefix = `${JSON.stringify(assistant("2026-07-24T12:10:00.000Z"))}\n`;
  await writeFile(transcript, prefix, { mode: 0o600 });
  const canonicalizer = openClaudeDesktopIncrementalCanonicalizer(
    join(root, "canonical.sqlite"), { secret: SECRET },
  );
  try {
    const initial = await canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 1,
    });
    assert.equal(initial.parsedLines, 1);
    assert.equal(initial.candidates.length, 1);
    const initialSnapshot = canonicalizer.snapshot();
    assert.deepEqual(initialSnapshot, { sources: 1, groups: 1, tools: 1, dirtyGroups: 1 });

    await appendFile(transcript, Buffer.alloc(MAXIMUM_LINE_BYTES, 0x7b));
    const exactLimit = await canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 2,
    });
    assert.equal(exactLimit.parsedBytes, 0);
    assert.equal(exactLimit.parsedLines, 0);
    assert.equal(exactLimit.assistantOccurrences, 0);
    assert.deepEqual(exactLimit.candidates, initial.candidates);
    assert.deepEqual(exactLimit.presentSources, initial.presentSources);
    assert.deepEqual(canonicalizer.snapshot(), initialSnapshot);

    await appendFile(transcript, "{");
    await assert.rejects(canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 3,
    }), (error) => error.code === "claude_desktop_incremental_line_bytes");
    assert.deepEqual(canonicalizer.snapshot(), initialSnapshot);

    await writeFile(transcript, prefix, { mode: 0o600 });
    const recovered = await canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 4,
    });
    assert.equal(recovered.parsedLines, 0);
    assert.deepEqual(recovered.candidates, initial.candidates);
    assert.deepEqual(recovered.presentSources, initial.presentSources);
    assert.deepEqual(canonicalizer.snapshot(), initialSnapshot);
  } finally {
    canonicalizer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("incremental canonical state handles unchanged, append, restart, mutation, and disappearance", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-incremental-test-"));
  await chmod(root, 0o700);
  const transcript = join(root, "session.jsonl");
  const database = join(root, "canonical.sqlite");
  const first = assistant("2026-07-24T12:10:00.000Z");
  const final = assistant("2026-07-24T12:10:01.000Z", {
    output: 9, toolId: "tool-b", toolName: "Bash",
  });
  await writeFile(transcript, `${JSON.stringify(first)}\n`, { mode: 0o600 });
  let canonicalizer = openClaudeDesktopIncrementalCanonicalizer(database, { secret: SECRET });
  try {
    const initial = await canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 1,
    });
    assert.equal(initial.rebuiltSources, 1);
    assert.equal(initial.parsedLines, 1);
    assert.equal(initial.dirtyGroupCount, 1);
    assert.equal(initial.candidates.length, 1);
    assert.equal(initial.candidates[0].candidate.components.outputCombinedTokens, 3);
    canonicalizer.acknowledgeDirty(initial.dirtyKeys);
    canonicalizer.close();
    canonicalizer = openClaudeDesktopIncrementalCanonicalizer(database, { secret: SECRET });

    const unchanged = await canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 2,
    });
    assert.equal(unchanged.unchangedSources, 1);
    assert.equal(unchanged.parsedBytes, 0);
    assert.equal(unchanged.parsedLines, 0);
    assert.equal(unchanged.candidates.length, 0);

    await appendFile(transcript, `${JSON.stringify(final)}\n`);
    const appended = await canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 3,
    });
    assert.equal(appended.appendedSources, 1);
    assert.equal(appended.rebuiltSources, 0);
    assert.equal(appended.parsedLines, 1);
    assert.equal(appended.candidates.length, 1);
    assert.equal(appended.candidates[0].candidate.components.outputCombinedTokens, 9);
    assert.equal(appended.candidates[0].candidate.toolClassCounts.file_search, 1);
    assert.equal(appended.candidates[0].candidate.toolClassCounts.local_shell, 1);
    canonicalizer.acknowledgeDirty(appended.dirtyKeys);

    const mutated = [structuredClone(first), final];
    mutated[0].message.usage.input_tokens = 12;
    await writeFile(transcript, `${mutated.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
    await assert.rejects(canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 4,
    }), (error) => error.code === "claude_desktop_incremental_invariant_conflict");
    assert.equal(canonicalizer.snapshot().groups, 1);

    const replacement = assistant("2026-07-24T12:20:00.000Z", { output: 4 });
    replacement.message.id = `replacement-message-${PRIVATE}`;
    await writeFile(transcript, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    const rebuilt = await canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 5,
    });
    assert.equal(rebuilt.rebuiltSources, 1);
    assert.equal(rebuilt.candidates.length, 1);
    assert.equal(rebuilt.candidates[0].sourceGeneration, 2);
    canonicalizer.acknowledgeDirty(rebuilt.dirtyKeys);

    const missing = await canonicalizer.refresh({
      sourcePaths: [], startAt: START_AT, endAt: END_AT, observedAtMs: 6,
    });
    assert.equal(missing.missingSources, 1);
    assert.equal(canonicalizer.snapshot().groups, 2);
    assert.equal(await databaseContains(root, PRIVATE), false);
    assert.equal(await databaseContains(root, transcript), false);
  } finally {
    canonicalizer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("incremental canonical state detects same-size mutations within one millisecond across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-incremental-submillisecond-"));
  await chmod(root, 0o700);
  const transcript = join(root, "session.jsonl");
  const database = join(root, "canonical.sqlite");
  const first = assistant("2026-07-24T12:10:00.000Z");
  const timestampSeconds = Date.parse(START_AT) / 1000;
  await writeFile(transcript, `${JSON.stringify(first)}\n`, { mode: 0o600 });
  await utimes(transcript, timestampSeconds, timestampSeconds + 0.000125);
  const before = await lstat(transcript);
  let canonicalizer = openClaudeDesktopIncrementalCanonicalizer(database, { secret: SECRET });
  try {
    const initial = await canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 1,
    });
    assert.equal(initial.candidates.length, 1);
    const snapshot = canonicalizer.snapshot();
    canonicalizer.close();
    canonicalizer = openClaudeDesktopIncrementalCanonicalizer(database, { secret: SECRET });
    const unchanged = await canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 2,
    });
    assert.equal(unchanged.unchangedSources, 1);
    assert.equal(unchanged.parsedBytes, 0);
    assert.equal(unchanged.parsedLines, 0);

    const mutated = structuredClone(first);
    mutated.message.usage.input_tokens = 12;
    await writeFile(transcript, `${JSON.stringify(mutated)}\n`, { mode: 0o600 });
    await utimes(transcript, timestampSeconds, timestampSeconds + 0.000875);
    const after = await lstat(transcript);
    assert.equal(after.size, before.size);
    assert.notEqual(after.mtimeMs, before.mtimeMs);
    assert.equal(Math.trunc(after.mtimeMs), Math.trunc(before.mtimeMs));
    await assert.rejects(canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 3,
    }), (error) => error.code === "claude_desktop_incremental_invariant_conflict");
    assert.deepEqual(canonicalizer.snapshot(), snapshot);
  } finally {
    canonicalizer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("incremental canonical schema migrates both v0.2 layouts and verifies legacy prefixes once", async (t) => {
  for (const withoutSourceGeneration of [false, true]) {
    await t.test(withoutSourceGeneration ? "legacy generation column absent" : "legacy generation column present", async (t) => {
      const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-incremental-migration-"));
      await chmod(root, 0o700);
      const transcript = join(root, "session.jsonl");
      const seedPath = join(root, "seed.sqlite");
      const databasePath = join(root, "canonical.sqlite");
      await writeFile(transcript, `${JSON.stringify(assistant("2026-07-24T12:10:00.000Z"))}\n`, { mode: 0o600 });
      const timestampSeconds = Date.parse(START_AT) / 1000;
      await utimes(transcript, timestampSeconds, timestampSeconds + 0.000125);
      let canonicalizer = openClaudeDesktopIncrementalCanonicalizer(seedPath, { secret: SECRET });
      try {
        const initial = await canonicalizer.refresh({
          sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 1,
        });
        const snapshot = canonicalizer.snapshot();
        canonicalizer.close();
        canonicalizer = null;
        const seededRows = canonicalRows(seedPath);
        createLegacyCanonicalDatabase(databasePath, seededRows, { withoutSourceGeneration });
        const legacyBytes = await readFile(databasePath);
        assert.throws(() => openClaudeDesktopIncrementalCanonicalizer(databasePath, {
          secret: Buffer.alloc(32, 54),
        }), (error) => error.code === "claude_desktop_incremental_secret_mismatch");
        assert.deepEqual(await readFile(databasePath), legacyBytes);

        canonicalizer = openClaudeDesktopIncrementalCanonicalizer(databasePath, { secret: SECRET });
        assert.deepEqual(canonicalizer.snapshot(), snapshot);
        const migratedRows = canonicalRows(databasePath);
        assert.equal(migratedRows.canonical_meta.find((row) => row.key === "schema_version").value,
          CLAUDE_DESKTOP_INCREMENTAL_CANONICALIZER_VERSION);
        assert.equal(migratedRows.canonical_source[0].mtime_ms_precise, null);
        assert.deepEqual(migratedRows.canonical_group, seededRows.canonical_group);
        assert.deepEqual(migratedRows.canonical_tool, seededRows.canonical_tool);
        assert.deepEqual(migratedRows.dirty_group, seededRows.dirty_group);
        assertLegacySchemaWritesRefused(databasePath);

        const handle = await open(transcript, "r");
        const prototype = Object.getPrototypeOf(handle);
        await handle.close();
        const originalRead = prototype.read;
        let readCalls = 0;
        const readMock = t.mock.method(prototype, "read", async function (...args) {
          readCalls += 1;
          return originalRead.apply(this, args);
        });
        const verified = await canonicalizer.refresh({
          sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 2,
        });
        assert.ok(readCalls > 1, "legacy metadata must not bypass prefix verification");
        assert.equal(verified.unchangedSources, 0);
        assert.equal(verified.appendedSources, 1);
        assert.equal(verified.parsedBytes, 0);
        assert.equal(verified.parsedLines, 0);
        assert.deepEqual(verified.candidates, initial.candidates);
        const verifiedRows = canonicalRows(databasePath);
        assert.equal(verifiedRows.canonical_source[0].mtime_ms_precise, (await lstat(transcript)).mtimeMs);
        assert.equal(verifiedRows.canonical_source[0].prefix_sha256, seededRows.canonical_source[0].prefix_sha256);
        canonicalizer.close();
        canonicalizer = openClaudeDesktopIncrementalCanonicalizer(databasePath, { secret: SECRET });
        readCalls = 0;
        const unchanged = await canonicalizer.refresh({
          sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 3,
        });
        assert.equal(readCalls, 1, "unchanged refresh reads only the bounded tail, not a full-prefix hash");
        readMock.mock.restore();
        assert.equal(unchanged.unchangedSources, 1);
        assert.equal(unchanged.parsedBytes, 0);
        assert.equal(unchanged.parsedLines, 0);
        assert.deepEqual(canonicalizer.snapshot(), snapshot);
      } finally {
        canonicalizer?.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("incremental canonical schema fences historical writers on a fresh store", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-incremental-writer-fence-"));
  await chmod(root, 0o700);
  const databasePath = join(root, "canonical.sqlite");
  try {
    const canonicalizer = openClaudeDesktopIncrementalCanonicalizer(databasePath, { secret: SECRET });
    canonicalizer.close();
    assertLegacySchemaWritesRefused(databasePath);
    const reopened = openClaudeDesktopIncrementalCanonicalizer(databasePath, { secret: SECRET });
    try {
      assert.deepEqual(reopened.snapshot(), { sources: 0, groups: 0, tools: 0, dirtyGroups: 0 });
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incremental canonical schema cannot bless a changed legacy prefix with precise metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-incremental-legacy-mutation-"));
  await chmod(root, 0o700);
  const transcript = join(root, "session.jsonl");
  const seedPath = join(root, "seed.sqlite");
  const databasePath = join(root, "canonical.sqlite");
  const row = assistant("2026-07-24T12:10:00.000Z");
  await writeFile(transcript, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  let canonicalizer = openClaudeDesktopIncrementalCanonicalizer(seedPath, { secret: SECRET });
  try {
    await canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 1,
    });
    const snapshot = canonicalizer.snapshot();
    canonicalizer.close();
    canonicalizer = null;
    const seededRows = canonicalRows(seedPath);
    createLegacyCanonicalDatabase(databasePath, seededRows);
    row.message.usage.input_tokens = 12;
    await writeFile(transcript, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    canonicalizer = openClaudeDesktopIncrementalCanonicalizer(databasePath, { secret: SECRET });
    await assert.rejects(canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 2,
    }), (error) => error.code === "claude_desktop_incremental_invariant_conflict");
    assert.deepEqual(canonicalizer.snapshot(), snapshot);
    const rejectedRows = canonicalRows(databasePath);
    assert.equal(rejectedRows.canonical_source[0].mtime_ms_precise, null);
    assert.equal(rejectedRows.canonical_source[0].prefix_sha256, seededRows.canonical_source[0].prefix_sha256);
    assert.deepEqual(rejectedRows.canonical_group, seededRows.canonical_group);
  } finally {
    canonicalizer?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("incremental canonical schema refuses incompatible stores before writes or permission changes", async (t) => {
  const cases = [
    { name: "unknown version", sql: "UPDATE canonical_meta SET value = 'unknown' WHERE key = 'schema_version'" },
    { name: "newer version", sql: "UPDATE canonical_meta SET value = 'claude-desktop-incremental-canonicalizer-v0.4' WHERE key = 'schema_version'" },
    { name: "unknown version in closed WAL store", wal: true, sql: "UPDATE canonical_meta SET value = 'unknown' WHERE key = 'schema_version'" },
    { name: "newer version in closed WAL store", wal: true, sql: "UPDATE canonical_meta SET value = 'claude-desktop-incremental-canonicalizer-v0.4' WHERE key = 'schema_version'" },
    { name: "unsupported older version", sql: "UPDATE canonical_meta SET value = 'claude-desktop-incremental-canonicalizer-v0.1' WHERE key = 'schema_version'" },
    { name: "missing version", sql: "DELETE FROM canonical_meta WHERE key = 'schema_version'" },
    { name: "current version missing precision column", sql: "ALTER TABLE canonical_source DROP COLUMN mtime_ms_precise" },
    { name: "current version missing generation column", sql: "ALTER TABLE canonical_group DROP COLUMN selected_source_generation" },
    { name: "current version missing insert guard", sql: "DROP TRIGGER canonical_schema_version_insert_guard" },
    { name: "current version missing update guard", sql: "DROP TRIGGER canonical_schema_version_update_guard" },
    { name: "current version with tampered guard", sql: "DROP TRIGGER canonical_schema_version_insert_guard; CREATE TRIGGER canonical_schema_version_insert_guard BEFORE INSERT ON canonical_meta BEGIN SELECT 1; END" },
    { name: "unversioned foreign view", fresh: true, sql: "CREATE VIEW foreign_view AS SELECT 1" },
    { name: "unversioned foreign marker", fresh: true, sql: "PRAGMA user_version = 7" },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-incremental-schema-refusal-"));
      await chmod(root, 0o700);
      const databasePath = join(root, "canonical.sqlite");
      try {
        if (!fixture.fresh) {
          const canonicalizer = openClaudeDesktopIncrementalCanonicalizer(databasePath, { secret: SECRET });
          canonicalizer.close();
        }
        const database = new DatabaseSync(databasePath);
        try {
          database.exec(`PRAGMA journal_mode = ${fixture.wal ? "WAL" : "DELETE"}`);
          if (fixture.sql.startsWith("UPDATE canonical_meta SET value")) {
            // Model a future/incompatible writer replacing the guard with its schema.
            database.exec("DROP TRIGGER canonical_schema_version_update_guard");
          }
          database.exec(fixture.sql);
        } finally {
          database.close();
        }
        await chmod(databasePath, 0o640);
        const beforeBytes = await readFile(databasePath);
        const beforeMetadata = await lstat(databasePath);
        const beforeEntries = await readdir(root);
        assert.deepEqual(beforeEntries, ["canonical.sqlite"]);
        assert.throws(() => openClaudeDesktopIncrementalCanonicalizer(databasePath, { secret: SECRET }),
          (error) => error.code === "claude_desktop_incremental_schema_version");
        assert.deepEqual(await readFile(databasePath), beforeBytes);
        const afterMetadata = await lstat(databasePath);
        assert.equal(afterMetadata.mode, beforeMetadata.mode);
        assert.equal(afterMetadata.mtimeMs, beforeMetadata.mtimeMs);
        assert.deepEqual(await readdir(root), beforeEntries);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("incremental canonical schema admission reads committed live WAL state", async (t) => {
  const versions = [
    { name: "unknown version committed only in WAL", value: "unknown" },
    { name: "newer version committed only in WAL", value: "claude-desktop-incremental-canonicalizer-v0.4" },
    { name: "compatible live WAL", value: CLAUDE_DESKTOP_INCREMENTAL_CANONICALIZER_VERSION },
  ];
  for (const version of versions) {
    await t.test(version.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-incremental-live-wal-"));
      await chmod(root, 0o700);
      const transcript = join(root, "session.jsonl");
      const databasePath = join(root, "canonical.sqlite");
      await writeFile(transcript, `${JSON.stringify(assistant("2026-07-24T12:10:00.000Z"))}\n`, { mode: 0o600 });
      let canonicalizer = openClaudeDesktopIncrementalCanonicalizer(databasePath, { secret: SECRET });
      let writer;
      try {
        await canonicalizer.refresh({
          sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 1,
        });
        const snapshot = canonicalizer.snapshot();
        canonicalizer.close();
        canonicalizer = null;
        writer = new DatabaseSync(databasePath);
        writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
        if (version.value !== CLAUDE_DESKTOP_INCREMENTAL_CANONICALIZER_VERSION) {
          writer.exec("DROP TRIGGER canonical_schema_version_update_guard");
        }
        writer.prepare("UPDATE canonical_meta SET value = ? WHERE key = 'schema_version'")
          .run(version.value);
        writer.prepare("INSERT INTO canonical_meta(key, value) VALUES ('live_fixture', 'committed-only-in-wal')")
          .run();
        assert.ok((await lstat(`${databasePath}-wal`)).size > 0);

        const mainReader = new DatabaseSync(`${pathToFileURL(databasePath).href}?mode=ro&immutable=1`, {
          readOnly: true,
        });
        try {
          assert.equal(mainReader.prepare("SELECT value FROM canonical_meta WHERE key = 'schema_version'").get().value,
            CLAUDE_DESKTOP_INCREMENTAL_CANONICALIZER_VERSION);
          assert.equal(mainReader.prepare("SELECT value FROM canonical_meta WHERE key = 'live_fixture'").get(), undefined);
        } finally {
          mainReader.close();
        }
        const beforeRows = canonicalRows(databasePath);
        const beforeSchema = writer.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all();
        assert.equal(beforeRows.canonical_meta.find((row) => row.key === "schema_version").value, version.value);
        if (version.value === CLAUDE_DESKTOP_INCREMENTAL_CANONICALIZER_VERSION) {
          canonicalizer = openClaudeDesktopIncrementalCanonicalizer(databasePath, { secret: SECRET });
          assert.deepEqual(canonicalizer.snapshot(), snapshot);
          canonicalizer.close();
          canonicalizer = null;
        } else {
          assert.throws(() => openClaudeDesktopIncrementalCanonicalizer(databasePath, { secret: SECRET }),
            (error) => error.code === "claude_desktop_incremental_schema_version");
        }
        // Live WAL readers may update SHM coordination; admission must preserve logical state.
        assert.deepEqual(canonicalRows(databasePath), beforeRows);
        assert.deepEqual(writer.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all(), beforeSchema);
      } finally {
        canonicalizer?.close();
        writer?.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("incremental canonical candidates exactly match the frozen exporter semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-incremental-parity-"));
  await chmod(root, 0o700);
  const transcript = join(root, "session.jsonl");
  const rows = [
    assistant("2026-07-24T12:10:00.000Z"),
    assistant("2026-07-24T12:10:01.000Z", { output: 9, toolId: "tool-b", toolName: "Bash" }),
  ];
  await writeFile(transcript, `${rows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  const canonicalizer = openClaudeDesktopIncrementalCanonicalizer(
    join(root, "canonical.sqlite"), { secret: SECRET },
  );
  try {
    const incremental = await canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 1,
    });
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: root,
      selectedSourcePaths: [transcript],
      startAt: START_AT,
      endAt: END_AT,
      secret: SECRET,
      resourceGuard: createExportResourceGuard({ scope: "export_set" }),
    });
    const scanned = await scanClaudeTranscriptExportSource(plan, plan.sources[0].sourceKey, {
      secret: SECRET,
      maximumCandidateRecords: 10,
      resourceGuard: createExportResourceGuard({ scope: "export_set" }),
    });
    assert.deepEqual(
      incremental.candidates.map((value) => value.candidate),
      scanned.candidates,
    );
  } finally {
    canonicalizer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("incremental canonical storage binds its secret and monotonic interval with owner-only sidecars", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-incremental-storage-"));
  await chmod(root, 0o700);
  const transcript = join(root, "session.jsonl");
  const database = join(root, "canonical.sqlite");
  const inside = assistant("2026-07-24T12:10:00.000Z");
  const later = assistant("2026-07-24T13:30:00.000Z");
  later.message.id = `later-message-${PRIVATE}`;
  await writeFile(transcript, `${[inside, later].map(JSON.stringify).join("\n")}\n`, {
    mode: 0o600,
  });
  let canonicalizer = openClaudeDesktopIncrementalCanonicalizer(database, { secret: SECRET });
  try {
    const initial = await canonicalizer.refresh({
      sourcePaths: [transcript], startAt: START_AT, endAt: END_AT, observedAtMs: 1,
    });
    assert.equal(initial.candidates.length, 1);
    canonicalizer.acknowledgeDirty(initial.dirtyKeys);
    for (const name of await readdir(root)) {
      if (!name.startsWith("canonical.sqlite")) continue;
      assert.equal((await lstat(join(root, name))).mode & 0o077, 0);
    }
    canonicalizer.close();
    canonicalizer = null;
    assert.throws(
      () => openClaudeDesktopIncrementalCanonicalizer(database, { secret: Buffer.alloc(32, 54) }),
      (error) => error.code === "claude_desktop_incremental_secret_mismatch",
    );
    canonicalizer = openClaudeDesktopIncrementalCanonicalizer(database, { secret: SECRET });
    const expanded = await canonicalizer.refresh({
      sourcePaths: [transcript],
      startAt: START_AT,
      endAt: "2026-07-24T14:00:00.000Z",
      observedAtMs: 2,
    });
    assert.equal(expanded.candidates.length, 1);
    assert.equal(expanded.candidates[0].candidate.eventTime, "2026-07-24T13:30:00.000Z");
    await assert.rejects(canonicalizer.refresh({
      sourcePaths: [transcript],
      startAt: START_AT,
      endAt: END_AT,
      observedAtMs: 3,
    }), (error) => error.code === "claude_desktop_incremental_bounds_regression");
  } finally {
    canonicalizer?.close();
    await rm(root, { recursive: true, force: true });
  }
});
