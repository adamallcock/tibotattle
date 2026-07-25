import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClaudeTranscriptExportCursor,
  createClaudeTranscriptExportSourcePlan,
  scanClaudeTranscriptExportSource,
  sliceClaudeTranscriptExportSourcePlan,
  verifyClaudeTranscriptExportSource,
} from "../src/claude-transcript-export-source.js";
import { createExportResourceGuard } from "../src/export-resource-policy.js";
import { normalizeClaudeTranscriptUsageCandidate } from "../src/export-safe-records.js";

const SECRET = Buffer.alloc(32, 71);
const START_AT = "2026-07-24T12:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";
const PRIVATE = "PRIVATE_CLAUDE_TRANSCRIPT_CANARY";

function assistant(timestamp, overrides = {}) {
  return {
    parentUuid: PRIVATE,
    isSidechain: false,
    userType: "external",
    cwd: `/private/${PRIVATE}`,
    sessionId: `session-${PRIVATE}`,
    version: "2.1.176",
    gitBranch: PRIVATE,
    type: "assistant",
    requestId: PRIVATE,
    uuid: PRIVATE,
    slug: PRIVATE,
    timestamp,
    message: {
      id: `${PRIVATE}-${timestamp}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [
        { type: "thinking", thinking: PRIVATE, signature: PRIVATE },
        { type: "text", text: PRIVATE },
        { type: "tool_use", id: `${PRIVATE}-read-${timestamp}`, name: "Read", input: { path: PRIVATE } },
        { type: "tool_use", id: `${PRIVATE}-bash-${timestamp}`, name: "Bash", input: { command: PRIVATE } },
        { type: "server_tool_use", id: `${PRIVATE}-server-${timestamp}`, name: "web_search", input: { query: PRIVATE } },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 11,
        cache_creation_input_tokens: 13,
        cache_read_input_tokens: 17,
        output_tokens: 19,
        cache_creation: { ephemeral_5m_input_tokens: 13, ephemeral_1h_input_tokens: 0 },
        service_tier: "standard_only",
        speed: "fast",
        inference_geo: PRIVATE,
      },
    },
    ...overrides,
  };
}

function iteration({
  type = "message", model, input = 11, read = 17, write = 13, output = 19,
  fiveMinute = 13, oneHour = 0,
} = {}) {
  return {
    type,
    ...(model === undefined ? {} : { model }),
    input_tokens: input,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    output_tokens: output,
    cache_creation: {
      ephemeral_5m_input_tokens: fiveMinute,
      ephemeral_1h_input_tokens: oneHour,
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-transcript-source-"));
  const nested = join(root, "nested", "project");
  await mkdir(nested, { recursive: true });
  const first = join(nested, "first.jsonl");
  const second = join(root, "second.jsonl");
  await writeFile(first, `${JSON.stringify(assistant("2026-07-24T12:10:00.000Z"))}\n${JSON.stringify({
    type: "user", timestamp: "2026-07-24T12:11:00.000Z", message: { content: PRIVATE },
  })}\n${JSON.stringify(assistant("2026-07-24T12:12:00.000Z", { isSidechain: true, agentId: PRIVATE }))}\n`);
  await writeFile(second, `${JSON.stringify(assistant("2026-07-24T11:59:00.000Z"))}\n`);
  return { root, first, second };
}

function guard(overrides = {}) {
  return createExportResourceGuard({ scope: "export_set", limits: overrides });
}

test("Claude transcript discovery is recursive and scanner emits only closed structural usage", async () => {
  const value = await fixture();
  try {
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: value.root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
    });
    assert.equal(plan.sourceCount, 2);
    const source = plan.sources.reduce((largest, item) => (
      item.prefixBytes > largest.prefixBytes ? item : largest
    ));
    const scanned = await scanClaudeTranscriptExportSource(plan, source.sourceKey, {
      secret: SECRET,
      cursor: createClaudeTranscriptExportCursor(plan, source.sourceKey, { secret: SECRET }),
      maximumCandidateRecords: 10,
      resourceGuard: guard(),
    });
    assert.equal(scanned.complete, true);
    assert.equal(scanned.candidates.length, 2);
    assert.deepEqual(scanned.candidates[0].components, {
      inputUncachedTokens: 11,
      inputCacheReadTokens: 17,
      inputCacheWriteTokens: 13,
      inputCacheWrite5mTokens: 13,
      inputCacheWrite1hTokens: 0,
      outputCombinedTokens: 19,
    });
    assert.equal(scanned.candidates[0].totalInputContextTokens, 41);
    assert.equal(scanned.candidates[0].speedMode, "fast");
    assert.equal(scanned.candidates[0].toolClassCounts.file_search, 1);
    assert.equal(scanned.candidates[0].toolClassCounts.local_shell, 1);
    assert.equal(scanned.candidates[0].toolClassCounts.web_search, 0);
    assert.equal(scanned.candidates[1].agentScope, "subagent");
    const serialized = JSON.stringify(scanned.candidates);
    assert.equal(serialized.includes(PRIVATE), false);
    assert.equal(serialized.includes(value.root), false);
    assert.equal(serialized.includes("inference_geo"), false);
    assert.equal(serialized.includes("requestId"), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude transcript plan binds every complete blank and CRLF line in prefixLineCount", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-transcript-prefix-lines-"));
  try {
    const user = JSON.stringify({ type: "user", message: { content: PRIVATE } });
    const selected = JSON.stringify(assistant("2026-07-24T12:10:00.000Z"));
    const completePrefix = `\r\n\n${user}\r\n${selected}\n`;
    await writeFile(join(root, "records.jsonl"), `${completePrefix}{"unterminated":"${PRIVATE}"}`, { mode: 0o600 });
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
    });
    assert.equal(plan.sources[0].prefixBytes, Buffer.byteLength(completePrefix));
    assert.equal(plan.sources[0].prefixLineCount, 4);
    assert.equal(plan.sources[0].selectedMessages, 1);

    const tampered = structuredClone(plan);
    tampered.sources[0].prefixLineCount += 1;
    assert.throws(
      () => sliceClaudeTranscriptExportSourcePlan(tampered, tampered.sources[0].sourceKey, { secret: SECRET }),
      (error) => error.code === "claude_transcript_export_plan_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude transcript plan orders selected sources before zero-selection sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-transcript-selected-first-"));
  try {
    await writeFile(join(root, "zero-b.jsonl"), `${JSON.stringify({ type: "user", value: "b" })}\n`, { mode: 0o600 });
    await writeFile(join(root, "selected.jsonl"), `${JSON.stringify(assistant("2026-07-24T12:10:00.000Z"))}\n`, { mode: 0o600 });
    await writeFile(join(root, "zero-a.jsonl"), `${JSON.stringify({ type: "user", value: "a" })}\n`, { mode: 0o600 });
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
    });
    assert.deepEqual(plan.sources.map((source) => source.selectedMessages > 0), [true, false, false]);
    assert.deepEqual(plan.sources.map((source) => source.ordinal), [0, 1, 2]);
    assert.deepEqual(
      plan.sources.slice(1).map((source) => source.sourceKey),
      plan.sources.slice(1).map((source) => source.sourceKey).toSorted(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude transcript terminal verification reuses the bound line count without recounting bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-transcript-terminal-lines-"));
  try {
    const record = JSON.stringify({ type: "user", padding: "x".repeat(600 * 1024) });
    await writeFile(join(root, "records.jsonl"), `${record}\n`, { mode: 0o600 });
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
    });
    let clockReads = 0;
    const verificationGuard = createExportResourceGuard({
      scope: "export_set",
      clock() { clockReads += 1; return 1_000; },
    });
    const terminalCursor = {
      ...createClaudeTranscriptExportCursor(plan, plan.sources[0].sourceKey, { secret: SECRET }),
      nextByte: plan.sources[0].prefixBytes,
      nextLineOrdinal: plan.sources[0].prefixLineCount + 1,
    };
    const verified = await verifyClaudeTranscriptExportSource(plan, plan.sources[0].sourceKey, {
      secret: SECRET, cursor: terminalCursor, resourceGuard: verificationGuard,
    });
    assert.equal(verified.complete, true);
    assert.equal(verified.cursor.nextLineOrdinal, 2);
    // One initial clock read plus one per 256 KiB hash chunk. A second
    // full-prefix newline count would add another three runtime checks.
    assert.equal(clockReads, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude transcript cursor resumes at the exact next line without duplicates", async () => {
  const value = await fixture();
  try {
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: value.root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
    });
    const source = plan.sources.reduce((largest, item) => (
      item.prefixBytes > largest.prefixBytes ? item : largest
    ));
    const first = await scanClaudeTranscriptExportSource(plan, source.sourceKey, {
      secret: SECRET, maximumCandidateRecords: 1, resourceGuard: guard(),
    });
    assert.equal(first.complete, false);
    const second = await scanClaudeTranscriptExportSource(plan, source.sourceKey, {
      secret: SECRET, cursor: first.cursor, maximumCandidateRecords: 10, resourceGuard: guard(),
    });
    assert.equal(second.complete, true);
    assert.equal(first.candidates.length + second.candidates.length, 2);
    assert.notEqual(first.candidates[0].occurrenceMaterial, second.candidates[0].occurrenceMaterial);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude transcript frozen prefixes ignore later complete appends and reject committed mutation", async () => {
  const value = await fixture();
  try {
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: value.root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
    });
    const source = plan.sources.reduce((largest, item) => (
      item.prefixBytes > largest.prefixBytes ? item : largest
    ));
    await appendFile(value.first, `${JSON.stringify(assistant("2026-07-24T12:20:00.000Z"))}\n`);
    const appended = await scanClaudeTranscriptExportSource(plan, source.sourceKey, {
      secret: SECRET, maximumCandidateRecords: 10, resourceGuard: guard(),
    });
    assert.equal(appended.candidates.length, 2);
    const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(value.first));
    bytes[0] = bytes[0] === 0x7b ? 0x20 : 0x7b;
    await writeFile(value.first, bytes);
    await assert.rejects(
      scanClaudeTranscriptExportSource(plan, source.sourceKey, {
        secret: SECRET, maximumCandidateRecords: 10, resourceGuard: guard(),
      }),
      (error) => error.code === "claude_transcript_export_source_changed",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude transcript planning rejects hard links and oversized unterminated structured lines", async () => {
  const linked = await fixture();
  try {
    await link(linked.first, join(linked.root, "linked.jsonl"));
    await assert.rejects(
      createClaudeTranscriptExportSourcePlan({
        projectsDirectory: linked.root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
      }),
      (error) => error.code === "claude_transcript_export_source_unsafe",
    );
  } finally {
    await rm(linked.root, { recursive: true, force: true });
  }

  const root = await mkdtemp(join(tmpdir(), "claude-transcript-oversize-"));
  try {
    await writeFile(join(root, "large.jsonl"), `{${"x".repeat(1024)}`);
    await assert.rejects(
      createClaudeTranscriptExportSourcePlan({
        projectsDirectory: root, startAt: START_AT, endAt: END_AT, secret: SECRET,
        resourceGuard: guard({ maximumLineBytes: 128 }),
      }),
      (error) => error.code === "export_resource_line_bytes",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude transcript planning canonicalizes partial and cross-file copies once", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-transcript-dedupe-"));
  try {
    const first = assistant("2026-07-24T12:10:00.000Z");
    first.message.id = `message-${PRIVATE}`;
    first.message.usage.output_tokens = 3;
    first.message.content = [{ type: "tool_use", id: `tool-a-${PRIVATE}`, name: "Read", input: { path: PRIVATE } }];
    const final = assistant("2026-07-24T12:10:02.000Z");
    final.message.id = first.message.id;
    final.message.usage.output_tokens = 29;
    final.message.content = [{ type: "tool_use", id: `tool-b-${PRIVATE}`, name: "Bash", input: { command: PRIVATE } }];
    const copied = structuredClone(final);
    copied.timestamp = "2026-07-24T12:10:03.000Z";
    await writeFile(join(root, "a.jsonl"), `${JSON.stringify(first)}\n${JSON.stringify(final)}\n`, { mode: 0o600 });
    await writeFile(join(root, "b.jsonl"), `${JSON.stringify(copied)}\n`, { mode: 0o600 });
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
    });
    assert.equal(plan.sources.reduce((sum, source) => sum + source.selectedMessages, 0), 1);
    assert.equal(JSON.stringify(plan).includes(first.message.id), false);
    const candidates = [];
    for (const source of plan.sources) {
      const scanned = await scanClaudeTranscriptExportSource(plan, source.sourceKey, {
        secret: SECRET, maximumCandidateRecords: 10, resourceGuard: guard(),
      });
      candidates.push(...scanned.candidates);
    }
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].components.outputCombinedTokens, 29);
    assert.equal(candidates[0].toolClassCounts.file_search, 1);
    assert.equal(candidates[0].toolClassCounts.local_shell, 1);
    assert.equal(JSON.stringify(candidates).includes(PRIVATE), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude transcript planning fails closed on conflicting duplicate usage identity", async () => {
  for (const mutate of [
    (record) => { record.sessionId = "different-session"; },
    (record) => { record.message.usage.input_tokens += 1; },
    (record) => {
      record.message.usage.cache_creation = {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: record.message.usage.cache_creation_input_tokens,
      };
    },
    (record) => { delete record.message.usage.cache_creation; },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "claude-transcript-conflict-"));
    try {
      const first = assistant("2026-07-24T12:10:00.000Z");
      first.message.id = `same-message-${PRIVATE}`;
      const second = structuredClone(first);
      second.timestamp = "2026-07-24T12:10:01.000Z";
      mutate(second);
      await writeFile(join(root, "records.jsonl"), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, { mode: 0o600 });
      await assert.rejects(createClaudeTranscriptExportSourcePlan({
        projectsDirectory: root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
      }), (error) => error.code === "claude_transcript_export_record_invalid"
        && !error.message.includes(PRIVATE));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Claude transcript interval membership follows the deterministic final/max occurrence", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-transcript-interval-"));
  try {
    const excludedPartial = assistant("2026-07-24T12:10:00.000Z");
    excludedPartial.message.id = "message-final-outside";
    excludedPartial.message.usage.output_tokens = 1;
    const excludedFinal = structuredClone(excludedPartial);
    excludedFinal.timestamp = "2026-07-24T13:00:01.000Z";
    excludedFinal.message.usage.output_tokens = 2;
    const includedPartial = assistant("2026-07-24T11:59:59.000Z");
    includedPartial.message.id = "message-final-inside";
    includedPartial.message.usage.output_tokens = 1;
    const includedFinal = structuredClone(includedPartial);
    includedFinal.timestamp = "2026-07-24T12:20:00.000Z";
    includedFinal.message.usage.output_tokens = 2;
    await writeFile(join(root, "records.jsonl"), `${[
      excludedPartial, excludedFinal, includedPartial, includedFinal,
    ].map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
    });
    const scanned = await scanClaudeTranscriptExportSource(plan, plan.sources[0].sourceKey, {
      secret: SECRET, maximumCandidateRecords: 10, resourceGuard: guard(),
    });
    assert.equal(scanned.candidates.length, 1);
    assert.equal(scanned.candidates[0].eventTime, includedFinal.timestamp);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude one-iteration usage is equivalent and inherits the proven top-level model", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-transcript-one-iteration-"));
  try {
    const record = assistant("2026-07-24T12:10:00.000Z");
    record.message.iterationCanary = PRIVATE;
    record.message.usage.iterations = [iteration()];
    await writeFile(join(root, "records.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
    });
    const scanned = await scanClaudeTranscriptExportSource(plan, plan.sources[0].sourceKey, {
      secret: SECRET, maximumCandidateRecords: 10, resourceGuard: guard(),
    });
    assert.equal(scanned.candidates.length, 1);
    assert.equal(scanned.candidates[0].modelDeclaration.modelId, "claude-opus-4-8");
    assert.deepEqual(scanned.candidates[0].components, {
      inputUncachedTokens: 11,
      inputCacheReadTokens: 17,
      inputCacheWriteTokens: 13,
      inputCacheWrite5mTokens: 13,
      inputCacheWrite1hTokens: 0,
      outputCombinedTokens: 19,
    });
    assert.equal(JSON.stringify(scanned.candidates).includes(PRIVATE), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude null iteration metadata is an explicit unavailable breakdown, not malformed usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-transcript-null-iterations-"));
  try {
    const record = assistant("2026-07-24T12:10:00.000Z");
    record.message.usage.iterations = null;
    await writeFile(join(root, "records.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
    });
    const scanned = await scanClaudeTranscriptExportSource(plan, plan.sources[0].sourceKey, {
      secret: SECRET, maximumCandidateRecords: 10, resourceGuard: guard(),
    });
    assert.equal(scanned.candidates.length, 1);
    assert.equal(scanned.candidates[0].components.outputCombinedTokens, 19);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude unreviewed models remain keyed unknowns through safe-record normalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-transcript-unreviewed-model-"));
  try {
    const record = assistant("2026-07-24T12:10:00.000Z");
    record.message.model = "claude-unreviewed-model-canary";
    await writeFile(join(root, "records.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
    });
    const scanned = await scanClaudeTranscriptExportSource(plan, plan.sources[0].sourceKey, {
      secret: SECRET, maximumCandidateRecords: 10, resourceGuard: guard(),
    });
    const normalized = normalizeClaudeTranscriptUsageCandidate(SECRET, scanned.candidates[0]);
    assert.equal(normalized.modelId, "unknown");
    assert.equal(normalized.modelRecognition, "unrecognized");
    assert.match(normalized.modelFingerprint, /^model:v1:[A-Za-z0-9_-]{43}$/u);
    assert.equal(JSON.stringify(normalized).includes("claude-unreviewed-model-canary"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude mixed-model fallback emits each iteration once without top-level double counting", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-transcript-fallback-"));
  try {
    const record = assistant("2026-07-24T12:10:00.000Z");
    record.message.usage.input_tokens = 13;
    record.message.usage.cache_read_input_tokens = 17;
    record.message.usage.cache_creation_input_tokens = 19;
    record.message.usage.output_tokens = 23;
    record.message.usage.cache_creation = { ephemeral_5m_input_tokens: 11, ephemeral_1h_input_tokens: 8 };
    record.message.usage.iterations = [
      iteration({ type: "fallback_message", model: "claude-fable-5", input: 3, read: 5, write: 7, output: 11, fiveMinute: 2, oneHour: 5 }),
      iteration({ model: "claude-opus-4-8", input: 13, read: 17, write: 19, output: 23, fiveMinute: 11, oneHour: 8 }),
    ];
    await writeFile(join(root, "records.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
    });
    const first = await scanClaudeTranscriptExportSource(plan, plan.sources[0].sourceKey, {
      secret: SECRET, maximumCandidateRecords: 1, resourceGuard: guard(),
    });
    assert.equal(first.complete, false);
    assert.equal(first.cursor.nextCostOrdinal, 1);
    const second = await scanClaudeTranscriptExportSource(plan, plan.sources[0].sourceKey, {
      secret: SECRET, cursor: first.cursor, maximumCandidateRecords: 1, resourceGuard: guard(),
    });
    assert.equal(second.complete, true);
    const candidates = [...first.candidates, ...second.candidates];
    assert.deepEqual(candidates.map((candidate) => candidate.modelDeclaration.modelId), [
      "claude-fable-5", "claude-opus-4-8",
    ]);
    assert.deepEqual(candidates.map((candidate) => candidate.components.outputCombinedTokens), [11, 23]);
    assert.equal(candidates.reduce((sum, candidate) => sum + candidate.components.inputUncachedTokens, 0), 16);
    assert.equal(candidates.reduce((sum, candidate) => sum + candidate.components.inputCacheReadTokens, 0), 22);
    assert.equal(candidates.reduce((sum, candidate) => sum + candidate.components.inputCacheWriteTokens, 0), 26);
    assert.equal(candidates.reduce((sum, candidate) => sum + candidate.components.outputCombinedTokens, 0), 34);
    assert.equal(candidates[0].toolClassCounts.file_search, 0);
    assert.equal(candidates[1].toolClassCounts.file_search, 1);
    assert.notEqual(candidates[0].occurrenceMaterial, candidates[1].occurrenceMaterial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude partial iteration growth and cross-file copies choose one final exploded structure", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-transcript-partial-iterations-"));
  try {
    const partial = assistant("2026-07-24T12:10:00.000Z");
    partial.message.id = "iteration-growth-message";
    partial.message.usage.output_tokens = 2;
    const iterationPartial = structuredClone(partial);
    iterationPartial.timestamp = "2026-07-24T12:10:01.000Z";
    iterationPartial.message.usage.iterations = [iteration({ output: 2 })];
    const final = structuredClone(iterationPartial);
    final.timestamp = "2026-07-24T12:10:02.000Z";
    final.message.usage.output_tokens = 9;
    final.message.usage.iterations[0].output_tokens = 9;
    const copied = structuredClone(final);
    copied.timestamp = "2026-07-24T12:10:03.000Z";
    await writeFile(join(root, "a.jsonl"), `${JSON.stringify(partial)}\n${JSON.stringify(iterationPartial)}\n${JSON.stringify(final)}\n`, { mode: 0o600 });
    await writeFile(join(root, "b.jsonl"), `${JSON.stringify(copied)}\n`, { mode: 0o600 });
    const plan = await createClaudeTranscriptExportSourcePlan({
      projectsDirectory: root, startAt: START_AT, endAt: END_AT, secret: SECRET, resourceGuard: guard(),
    });
    const candidates = [];
    for (const source of plan.sources) {
      const scanned = await scanClaudeTranscriptExportSource(plan, source.sourceKey, {
        secret: SECRET, maximumCandidateRecords: 10, resourceGuard: guard(),
      });
      candidates.push(...scanned.candidates);
    }
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].components.outputCombinedTokens, 9);
    assert.equal(plan.sources.reduce((sum, source) => sum + source.selectedMessages, 0), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
