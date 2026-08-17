import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openClaudeDesktopIncrementalCanonicalizer } from "../src/claude-desktop-incremental-canonicalizer.js";
import {
  createClaudeTranscriptExportSourcePlan,
  scanClaudeTranscriptExportSource,
} from "../src/claude-transcript-export-source.js";
import { createExportResourceGuard } from "../src/export-resource-policy.js";

const SECRET = Buffer.alloc(32, 53);
const PRIVATE = "PRIVATE_INCREMENTAL_CLAUDE_CANARY";
const START_AT = "2026-07-24T12:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";

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
