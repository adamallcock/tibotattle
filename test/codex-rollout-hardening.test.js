import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { localCodexLogScanner } from "../src/local-node-runtime.js";
import {
  lineageComponents,
  rebuildLocalUnifiedIndex,
} from "../src/local-unified-index-build.js";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import {
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
} from "../src/local-unified-index.js";
import { withStableRolloutSource } from "../src/rollout-source-snapshot.js";
import { createCodexLogSources } from "../src/providers/codex/log-sources.js";
import { createLocalCodexLogPorts } from "../src/platform/local-codex-log-ports.js";

const { scanCodexLogEvents } = localCodexLogScanner;

const CONTRACT = "usage-event-v0.2";
const THREAD = "11111111-1111-4111-8111-111111111111";
const CHILD_THREAD = "22222222-2222-4222-8222-222222222222";
const THIRD_THREAD = "33333333-3333-4333-8333-333333333333";

function sessionMeta(id = THREAD, { parentId = null } = {}) {
  return JSON.stringify({
    timestamp: "2026-07-25T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      session_id: id,
      thread_source: "user",
      originator: "codex_cli_rs",
      ...(parentId === null ? {} : { forked_from_id: parentId }),
    },
  });
}

function turnContext({
  model = "gpt-5.6-sol",
  timestamp = "2026-07-25T00:00:00.100Z",
} = {}) {
  return JSON.stringify({
    timestamp,
    type: "turn_context",
    payload: { model, effort: "high" },
  });
}

function usage(input) {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: input,
  };
}

function tokenCount(input = 100, {
  last = input,
  rateLimits = null,
  timestamp = "2026-07-25T00:00:01.000Z",
} = {}) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage(input),
        ...(last === null ? {} : { last_token_usage: usage(last) }),
      },
      ...(rateLimits === null ? {} : { rate_limits: rateLimits }),
    },
  });
}

function threadSettings(serviceTier = "priority") {
  return JSON.stringify({
    timestamp: "2026-07-25T00:00:00.050Z",
    type: "event_msg",
    payload: {
      type: "thread_settings_applied",
      thread_settings: { service_tier: serviceTier },
    },
  });
}

function paginatedSessionMeta({
  baseRolloutId,
  endOrdinalExclusive,
  endByteOffset,
  sessionId = THREAD,
}) {
  return JSON.stringify({
    ordinal: 0,
    timestamp: "2026-07-25T00:00:02.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      session_id: sessionId,
      history_mode: "paginated",
      history_base: {
        thread_id: baseRolloutId,
        end_ordinal_exclusive: endOrdinalExclusive,
        end_byte_offset: endByteOffset,
      },
      thread_source: "user",
      originator: "codex_cli_rs",
    },
  });
}

async function rolloutHome(contents) {
  const root = await mkdtemp(join(tmpdir(), "rollout-hardening-"));
  const sessions = join(root, "sessions", "2026", "07", "25");
  await mkdir(sessions, { recursive: true });
  const source = join(
    sessions,
    `rollout-2026-07-25T00-00-00-${THREAD}.jsonl`,
  );
  await writeFile(source, contents, { mode: 0o600 });
  return { root, source };
}

function build(root, workerCount = 1) {
  return rebuildLocalUnifiedIndex({
    codexHome: root,
    indexFile: join(root, "index.sqlite"),
    secretFile: join(root, "salt"),
    contractVersion: CONTRACT,
    workerCount,
  });
}

function ingest(root) {
  return ingestLocalUnifiedIndexIncrement({
    codexHome: root,
    indexFile: join(root, "index.sqlite"),
    secretFile: join(root, "salt"),
    contractVersion: CONTRACT,
  });
}

test("malformed accounting quarantines one rollout, persists a terminal cursor, and heals after repair", async () => {
  const malformed = "{\"timestamp\":\"2026-07-25T00:00:00.500Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"";
  const { root, source } = await rolloutHome([
    sessionMeta(),
    turnContext(),
    malformed,
    tokenCount(),
    "",
  ].join("\n"));
  try {
    const built = await build(root);
    assert.equal(built.generation.status, "partial");
    assert.equal(built.generation.blockReason, "codex_rollout_sources_quarantined");
    assert.equal(built.generation.issueCounts.codex_rollout_content_invalid.sourceCount, 1);
    assert.equal(built.usageEvents, 0);

    let database = openLocalUnifiedIndex(join(root, "index.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(Number(database.prepare(
        "SELECT COUNT(*) AS count FROM usage_event",
      ).get().count), 0);
      const cursor = database.prepare(`
        SELECT quarantine_code, scanned_bytes FROM source_cursor
      `).get();
      assert.equal(cursor.quarantine_code, "codex_rollout_content_invalid");
      assert.equal(Number(cursor.scanned_bytes), 0);
      assert.equal(database.prepare(
        "SELECT status FROM generation_source",
      ).get().status, "failed");
    } finally {
      database.close();
    }

    const unchanged = await ingest(root);
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.generation.status, "partial");

    await writeFile(source, [
      sessionMeta(),
      turnContext(),
      tokenCount(),
      "",
    ].join("\n"), { mode: 0o600 });
    const repaired = await ingest(root);
    assert.equal(repaired.generation.status, "complete");
    assert.equal(repaired.totalUsageEvents, 1);
    database = openLocalUnifiedIndex(join(root, "index.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(database.prepare(
        "SELECT quarantine_code FROM source_cursor",
      ).get().quarantine_code, null);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed quota window withholds only that observation and retains valid source facts", async () => {
  const invalidQuota = {
    limit_id: "codex",
    plan_type: "pro",
    primary: {
      used_percent: 12,
      window_minutes: 0,
      resets_at: 1_785_258_363,
    },
  };
  const validQuota = {
    limit_id: "codex",
    plan_type: "pro",
    primary: {
      used_percent: 13,
      window_minutes: 300,
      resets_at: 1_785_258_363,
    },
  };
  const { root } = await rolloutHome([
    sessionMeta(),
    turnContext(),
    tokenCount(100, { rateLimits: invalidQuota }),
    tokenCount(200, {
      last: 100,
      rateLimits: validQuota,
      timestamp: "2026-07-25T00:00:02.000Z",
    }),
    "",
  ].join("\n"));
  try {
    const built = await build(root);
    assert.equal(built.generation.status, "complete");
    assert.equal(built.generation.blockReason, null);
    assert.equal(built.usageEvents, 2);

    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(Number(database.prepare(
        "SELECT COUNT(*) AS count FROM usage_event",
      ).get().count), 2);
      assert.equal(Number(database.prepare(
        "SELECT COUNT(*) AS count FROM quota_occurrence",
      ).get().count), 1);
      assert.equal(Number(database.prepare(`
        SELECT COALESCE(SUM(count), 0) AS count
        FROM source_diagnostic
        WHERE code = 'malformedRateLimitRecords'
      `).get().count), 1);
      assert.equal(database.prepare(
        "SELECT quarantine_code FROM source_cursor",
      ).get().quarantine_code, null);
      assert.equal(database.prepare(
        "SELECT status FROM generation_source",
      ).get().status, "complete");
    } finally {
      database.close();
    }

    const unchanged = await ingest(root);
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.sourcesScanned, 0);
    assert.equal(unchanged.totalUsageEvents, 2);
    assert.equal(unchanged.generation.status, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fractional token counters become a terminal content quarantine, not a SQLite failure loop", async () => {
  const invalid = JSON.stringify({
    timestamp: "2026-07-25T00:00:01.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage(1.5),
        last_token_usage: usage(1.5),
      },
    },
  });
  const { root } = await rolloutHome([
    sessionMeta(),
    turnContext(),
    invalid,
    "",
  ].join("\n"));
  try {
    const built = await build(root);
    assert.equal(built.generation.status, "partial");
    assert.equal(
      built.generation.issueCounts.codex_rollout_content_invalid.sourceCount,
      1,
    );
    assert.equal(built.usageEvents, 0);
    const unchanged = await ingest(root);
    assert.equal(unchanged.unchanged, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicitly malformed speed setting quarantines the source atomically", async () => {
  const invalidTier = JSON.stringify({
    timestamp: "2026-07-25T00:00:00.500Z",
    type: "event_msg",
    payload: {
      type: "thread_settings_applied",
      thread_settings: { service_tier: 42 },
    },
  });
  const { root } = await rolloutHome([
    sessionMeta(),
    turnContext(),
    invalidTier,
    tokenCount(),
    "",
  ].join("\n"));
  try {
    const built = await build(root);
    assert.equal(built.generation.status, "partial");
    assert.equal(
      built.generation.issueCounts.codex_rollout_content_invalid.sourceCount,
      1,
    );
    assert.equal(built.usageEvents, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an oversized token record without a complete counter prefix quarantines instead of disappearing", async () => {
  const oversized = JSON.stringify({
    timestamp: "2026-07-25T00:00:01.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      padding: "p".repeat(80 * 1024),
      info: {
        total_token_usage: usage(100),
        last_token_usage: usage(100),
      },
    },
  });
  const { root } = await rolloutHome([
    sessionMeta(),
    turnContext(),
    oversized,
    "",
  ].join("\n"));
  try {
    const built = await rebuildLocalUnifiedIndex({
      codexHome: root,
      indexFile: join(root, "index.sqlite"),
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
      workerCount: 1,
      maximumLineBytes: 1_024,
    });
    assert.equal(built.generation.status, "partial");
    assert.equal(
      built.generation.issueCounts.codex_rollout_content_invalid.sourceCount,
      1,
    );
    assert.equal(built.usageEvents, 0);

    const unchanged = await ingest(root);
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.sourcesScanned, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unfinished JSONL tail never publishes facts, skips unchanged, and heals when newline-terminated", async () => {
  const { root, source } = await rolloutHome(
    `${sessionMeta()}\n${turnContext()}\n${tokenCount()}`,
  );
  try {
    const built = await build(root, 2);
    assert.equal(built.generation.status, "partial");
    assert.equal(
      built.generation.issueCounts.codex_rollout_tail_incomplete.sourceCount,
      1,
    );
    assert.equal(built.usageEvents, 0);

    const unchanged = await ingest(root);
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.totalUsageEvents, 0);

    await appendFile(source, "\n");
    const repaired = await ingest(root);
    assert.equal(repaired.generation.status, "complete");
    assert.equal(repaired.totalUsageEvents, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("copied session metadata keeps the rollout's first thread identity canonical", async () => {
  const { root, source } = await rolloutHome([
    sessionMeta(),
    turnContext(),
    tokenCount(),
    "",
  ].join("\n"));
  try {
    assert.equal((await build(root)).usageEvents, 1);
    await appendFile(source, [
      sessionMeta(CHILD_THREAD),
      turnContext(),
      tokenCount(200),
      "",
    ].join("\n"));

    const ingested = await ingest(root);
    assert.equal(ingested.generation.status, "complete");
    assert.equal(ingested.totalUsageEvents, 2);

    const unchanged = await ingest(root);
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.sourcesScanned, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider accounting keeps reverted suffix spend and replacement work with colliding ordinals", async () => {
  const prefix = [
    sessionMeta(),
    turnContext(),
    tokenCount(100),
  ];
  const { root, source } = await rolloutHome([
    ...prefix,
    tokenCount(150, {
      last: 50,
      timestamp: "2026-07-25T00:00:02.000Z",
    }),
    "",
  ].join("\n"));
  try {
    const continuation = join(
      dirname(source),
      `rollout-2026-07-25T00-00-03-${THREAD}_${CHILD_THREAD}.jsonl`,
    );
    await writeFile(continuation, [
      paginatedSessionMeta({
        baseRolloutId: THREAD,
        endOrdinalExclusive: prefix.length,
        endByteOffset: Buffer.byteLength(`${prefix.join("\n")}\n`),
      }),
      turnContext({ timestamp: "2026-07-25T00:00:02.100Z" }),
      // Same cumulative snapshot and physical record ordinal as the parent's
      // removed suffix. It is nevertheless new spend on the replacement
      // branch and must not collide with that older generation.
      tokenCount(150, {
        last: 50,
        timestamp: "2026-07-25T00:00:03.000Z",
      }),
      "",
    ].join("\n"), { mode: 0o600 });

    const events = [];
    const result = await scanCodexLogEvents({
      codexHome: root,
      startAt: "1970-01-01T00:00:00.000Z",
      endAt: "2030-01-01T00:00:00.000Z",
      onUsage: (event) => events.push(event),
    });

    assert.equal(result.parserVersion, "codex-log-scan-v7");
    assert.deepEqual(events.map((event) => event.raw.input_tokens), [
      100,
      50,
      50,
    ]);
    assert.deepEqual(events.map((event) => event.sourceRolloutOrdinal), [
      0,
      0,
      1,
    ]);
    assert.equal(result.diagnostics.forkReplayEventsSkipped, 0);
    assert.equal(result.diagnostics.replayedEventsSkipped, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider replacement seeds exact counters and inherited provenance without last-token usage", async () => {
  const prefix = [
    sessionMeta(),
    threadSettings("priority"),
    turnContext({ model: "gpt-5.6-sol" }),
    tokenCount(100),
  ];
  const { root, source } = await rolloutHome(`${prefix.join("\n")}\n`);
  try {
    await writeFile(join(
      dirname(source),
      `rollout-2026-07-25T00-00-03-${THREAD}_${CHILD_THREAD}.jsonl`,
    ), [
      paginatedSessionMeta({
        baseRolloutId: THREAD,
        endOrdinalExclusive: prefix.length,
        endByteOffset: Buffer.byteLength(`${prefix.join("\n")}\n`),
      }),
      // No local turn_context, tier declaration, or last_token_usage. The
      // exact history boundary is the only defensible source for all three.
      tokenCount(160, {
        last: null,
        timestamp: "2026-07-25T00:00:03.000Z",
      }),
      "",
    ].join("\n"), { mode: 0o600 });

    const events = [];
    await scanCodexLogEvents({
      codexHome: root,
      startAt: "1970-01-01T00:00:00.000Z",
      endAt: "2030-01-01T00:00:00.000Z",
      onUsage: (event) => events.push(event),
    });

    assert.equal(events.length, 2);
    const replacement = events[1];
    assert.equal(replacement.raw.input_tokens, 60);
    assert.equal(replacement.model, "gpt-5.6-sol");
    assert.deepEqual(replacement.tierSemantics, {
      schemaVersion: "0.1",
      billingSurface: "chatgpt_subscription",
      codexSpeedMode: "fast",
      apiServiceTier: "unknown",
      providerTierRaw: "priority",
      tierSource: "lineage_inherited",
      tierObservedAt: "2026-07-25T00:00:00.050Z",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider captures exact paginated snapshots only when a later inline fork consumes them", async () => {
  const retainedPrefix = [
    sessionMeta(),
    turnContext(),
    tokenCount(100),
  ];
  const { root, source } = await rolloutHome([
    ...retainedPrefix,
    tokenCount(300, {
      last: 200,
      timestamp: "2026-07-25T00:00:02.000Z",
    }),
    "",
  ].join("\n"));
  try {
    await writeFile(join(
      dirname(source),
      `rollout-2026-07-25T01-00-00-${THREAD}_${CHILD_THREAD}.jsonl`,
    ), `${paginatedSessionMeta({
      baseRolloutId: THREAD,
      endOrdinalExclusive: retainedPrefix.length,
      endByteOffset: Buffer.byteLength(`${retainedPrefix.join("\n")}\n`),
    })}\n`, { mode: 0o600 });
    await writeFile(join(
      dirname(source),
      `rollout-2026-07-25T02-00-00-${THIRD_THREAD}.jsonl`,
    ), [
      sessionMeta(THIRD_THREAD, { parentId: THREAD }),
      // The retained prefix is replayed before the child's own turn.
      tokenCount(100, { timestamp: "2026-07-25T02:00:00.000Z" }),
      turnContext({ timestamp: "2026-07-25T02:00:01.000Z" }),
      // Deliberately identical to the removed suffix. Only the exact selected
      // prefix may suppress replay, so this is genuine new branch spend.
      tokenCount(300, {
        last: 200,
        timestamp: "2026-07-25T02:00:02.000Z",
      }),
      "",
    ].join("\n"), { mode: 0o600 });

    const events = [];
    const result = await scanCodexLogEvents({
      codexHome: root,
      startAt: "1970-01-01T00:00:00.000Z",
      endAt: "2030-01-01T00:00:00.000Z",
      onUsage: (event) => events.push(event),
      requireCompleteDiscovery: true,
    });

    assert.deepEqual(events.map((event) => event.raw.input_tokens), [
      100,
      200,
      200,
    ]);
    assert.equal(result.diagnostics.forkReplayEventsSkipped, 1);
    assert.equal(result.diagnostics.unattributedForkReplayEventsSkipped, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a runtime quarantine remains a terminal historical gap after the source rotates away", async () => {
  const malformed = "{\"timestamp\":\"2026-07-25T00:00:00.500Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"";
  const { root, source } = await rolloutHome([
    sessionMeta(),
    turnContext(),
    malformed,
    tokenCount(),
    "",
  ].join("\n"));
  try {
    assert.equal((await build(root)).generation.status, "partial");
    await rm(source);

    const rotated = await ingest(root);
    assert.equal(rotated.generation.status, "partial");
    assert.equal(rotated.generation.skippedSourceCount, 1);
    assert.equal(rotated.totalUsageEvents, 0);

    const unchanged = await ingest(root);
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.generation.status, "partial");
    assert.equal(unchanged.generation.skippedSourceCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a descendant of runtime-damaged history also gets a terminal lineage cursor", async () => {
  const malformed = "{\"timestamp\":\"2026-07-25T00:00:00.500Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"";
  const { root, source } = await rolloutHome([
    sessionMeta(),
    turnContext(),
    malformed,
    "",
  ].join("\n"));
  try {
    await writeFile(join(
      dirname(source),
      `rollout-2026-07-25T00-00-01-${CHILD_THREAD}.jsonl`,
    ), [
      JSON.stringify({
        timestamp: "2026-07-25T00:00:01.000Z",
        type: "session_meta",
        payload: { id: CHILD_THREAD, forked_from_id: THREAD },
      }),
      turnContext(),
      tokenCount(200),
      "",
    ].join("\n"), { mode: 0o600 });

    const built = await build(root);
    assert.equal(built.generation.status, "partial");
    assert.equal(built.generation.skippedSourceCount, 2);
    assert.equal(
      built.generation.issueCounts.codex_rollout_content_invalid.sourceCount,
      1,
    );
    assert.equal(
      built.generation.issueCounts.codex_rollout_lineage_invalid.sourceCount,
      1,
    );
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), {
      readOnly: true,
    });
    try {
      assert.deepEqual(database.prepare(`
        SELECT quarantine_code FROM source_cursor ORDER BY quarantine_code
      `).all().map((row) => row.quarantine_code), [
        "codex_rollout_content_invalid",
        "codex_rollout_lineage_invalid",
      ]);
    } finally {
      database.close();
    }

    const unchanged = await ingest(root);
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.generation.skippedSourceCount, 2);
    assert.equal(unchanged.sourcesScanned, 0);

    await appendFile(source, `${malformed}\n`);
    const stillDamaged = await ingest(root);
    assert.equal(stillDamaged.rebuilt, undefined);
    assert.equal(stillDamaged.generation.status, "partial");
    assert.equal(stillDamaged.generation.skippedSourceCount, 2);
    assert.equal(stillDamaged.sourcesScanned, 1);
    assert.equal(stillDamaged.totalUsageEvents, 0);

    const damagedUnchanged = await ingest(root);
    assert.equal(damagedUnchanged.unchanged, true);
    assert.equal(damagedUnchanged.sourcesScanned, 0);

    await writeFile(source, [
      sessionMeta(),
      turnContext(),
      tokenCount(),
      "",
    ].join("\n"), { mode: 0o600 });
    const repaired = await ingest(root);
    assert.equal(repaired.rebuilt, undefined);
    assert.equal(repaired.sourcesRescanned, 2);
    assert.equal(repaired.generation.status, "complete");
    assert.equal(repaired.totalUsageEvents, 2);

    const healed = await ingest(root);
    assert.equal(healed.unchanged, true);
    assert.equal(healed.sourcesScanned, 0);
    assert.equal(healed.generation.status, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a newly discovery-quarantined source cannot retain facts from an earlier generation", async () => {
  const { root, source } = await rolloutHome([
    sessionMeta(),
    turnContext(),
    tokenCount(),
    "",
  ].join("\n"));
  try {
    assert.equal((await build(root)).usageEvents, 1);
    const divergent = join(
      dirname(source),
      `rollout-2026-07-25T00-00-01-${THREAD}.jsonl`,
    );
    await writeFile(divergent, [
      sessionMeta(),
      turnContext(),
      tokenCount(200),
      "",
    ].join("\n"), { mode: 0o600 });

    const quarantined = await ingest(root);
    assert.equal(quarantined.rebuilt, undefined);
    assert.equal(quarantined.sourcesScanned, 0);
    assert.equal(quarantined.generation.status, "partial");
    assert.equal(
      quarantined.generation.issueCounts
        .codex_rollout_generation_ambiguous.sourceCount,
      2,
    );
    assert.equal(quarantined.totalUsageEvents, 0);

    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(Number(database.prepare(
        "SELECT COUNT(*) AS count FROM usage_event",
      ).get().count), 0);
      assert.equal(Number(database.prepare(
        "SELECT COUNT(*) AS count FROM source_cursor",
      ).get().count), 0);
    } finally {
      database.close();
    }

    const unchanged = await ingest(root);
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.generation.status, "partial");

    await rm(divergent);
    const healed = await ingest(root);
    assert.equal(healed.rebuilt, undefined);
    assert.equal(healed.sourcesScanned, 1);
    assert.equal(healed.generation.status, "complete");
    assert.equal(healed.totalUsageEvents, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identity-damaged metadata clears state through the prior attested session", async () => {
  const { root, source } = await rolloutHome([
    sessionMeta(),
    turnContext(),
    tokenCount(),
    "",
  ].join("\n"));
  try {
    const child = join(
      dirname(source),
      `rollout-2026-07-25T00-00-01-${CHILD_THREAD}.jsonl`,
    );
    await writeFile(child, [
      sessionMeta(CHILD_THREAD, { parentId: THREAD }),
      turnContext(),
      tokenCount(200),
      "",
    ].join("\n"), { mode: 0o600 });
    assert.equal((await build(root)).usageEvents, 2);
    let database = openLocalUnifiedIndex(join(root, "index.sqlite"), {
      readOnly: true,
    });
    try {
      assert.ok(Number(database.prepare(
        "SELECT COUNT(*) AS count FROM lineage_snapshot",
      ).get().count) > 0);
    } finally {
      database.close();
    }

    // The canonical filename still attests THREAD, while the rewritten
    // metadata now claims a different logical owner.
    await writeFile(source, [
      sessionMeta(CHILD_THREAD),
      turnContext(),
      tokenCount(200),
      "",
    ].join("\n"), { mode: 0o600 });
    const quarantined = await ingest(root);
    assert.equal(quarantined.generation.status, "partial");
    assert.equal(quarantined.totalUsageEvents, 0);

    database = openLocalUnifiedIndex(join(root, "index.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(Number(database.prepare(
        "SELECT COUNT(*) AS count FROM source_cursor",
      ).get().count), 0);
      assert.equal(Number(database.prepare(
        "SELECT COUNT(*) AS count FROM lineage_snapshot",
      ).get().count), 0);
    } finally {
      database.close();
    }

    await writeFile(source, [
      sessionMeta(),
      turnContext(),
      tokenCount(),
      "",
    ].join("\n"), { mode: 0o600 });
    const repaired = await ingest(root);
    assert.equal(repaired.generation.status, "complete");
    assert.equal(repaired.totalUsageEvents, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distinct filename mismatches sharing one claimed ID terminate unchanged", async () => {
  const { root, source } = await rolloutHome([
    sessionMeta(CHILD_THREAD),
    "",
  ].join("\n"));
  try {
    await writeFile(join(
      dirname(source),
      `rollout-2026-07-25T00-00-01-${THIRD_THREAD}.jsonl`,
    ), [sessionMeta(CHILD_THREAD), ""].join("\n"), { mode: 0o600 });

    const built = await build(root);
    assert.equal(built.generation.status, "partial");
    assert.equal(built.generation.skippedSourceCount, 2);
    assert.equal(built.generation.skippedThreadCount, 2);

    const unchanged = await ingest(root);
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.sourcesScanned, 0);
    assert.equal(unchanged.generation.skippedThreadCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("divergent active/archive representations retain two failed source attestations", async () => {
  const { root, source } = await rolloutHome([
    sessionMeta(),
    turnContext(),
    tokenCount(),
    "",
  ].join("\n"));
  try {
    const archive = join(root, "archived_sessions");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, basename(source)), [
      sessionMeta(),
      turnContext(),
      tokenCount(200),
      "",
    ].join("\n"), { mode: 0o600 });

    const built = await build(root);
    assert.equal(built.generation.status, "partial");
    assert.equal(built.generation.skippedSourceCount, 2);
    assert.equal(
      built.generation.issueCounts
        .codex_rollout_generation_ambiguous.sourceCount,
      2,
    );
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(Number(database.prepare(`
        SELECT COUNT(*) AS count FROM generation_source
        WHERE generation_id = ? AND status = 'failed'
      `).get(built.generation.id).count), 2);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("complete Codex scans reject malformed accounting and unfinished tails with fixed codes", async (t) => {
  await t.test("malformed accounting", async () => {
    const { root } = await rolloutHome([
      sessionMeta(),
      turnContext(),
      "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}",
      tokenCount(),
      "",
    ].join("\n"));
    try {
      await assert.rejects(scanCodexLogEvents({
        codexHome: root,
        startAt: "1970-01-01T00:00:00.000Z",
        endAt: "2030-01-01T00:00:00.000Z",
        requireCompleteDiscovery: true,
      }), { code: "codex_rollout_content_invalid" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("unfinished tail", async () => {
    const { root } = await rolloutHome(`${sessionMeta()}\n${tokenCount()}`);
    try {
      await assert.rejects(scanCodexLogEvents({
        codexHome: root,
        startAt: "1970-01-01T00:00:00.000Z",
        endAt: "2030-01-01T00:00:00.000Z",
        requireCompleteDiscovery: true,
      }), { code: "codex_rollout_tail_incomplete" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("copied session metadata", async () => {
    const { root } = await rolloutHome([
      sessionMeta(),
      sessionMeta(CHILD_THREAD),
      turnContext(),
      tokenCount(),
      "",
    ].join("\n"));
    try {
      const scan = await scanCodexLogEvents({
        codexHome: root,
        startAt: "1970-01-01T00:00:00.000Z",
        endAt: "2030-01-01T00:00:00.000Z",
        requireCompleteDiscovery: true,
      });
      assert.equal(scan.diagnostics.malformedAccountingRecords, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("same-thread session metadata update", async () => {
    const metadataUpdate = JSON.stringify({
      timestamp: "2026-07-25T00:00:00.050Z",
      type: "session_meta",
      payload: {
        id: THREAD,
        session_id: THIRD_THREAD,
        memory_mode: "enabled",
      },
    });
    const { root } = await rolloutHome([
      sessionMeta(),
      metadataUpdate,
      turnContext(),
      tokenCount(),
      "",
    ].join("\n"));
    try {
      const scan = await scanCodexLogEvents({
        codexHome: root,
        startAt: "1970-01-01T00:00:00.000Z",
        endAt: "2030-01-01T00:00:00.000Z",
        requireCompleteDiscovery: true,
      });
      assert.equal(scan.diagnostics.malformedAccountingRecords, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("malformed appended session metadata", async () => {
    const malformedUpdate = JSON.stringify({
      timestamp: "2026-07-25T00:00:00.050Z",
      type: "session_meta",
      payload: { memory_mode: "enabled" },
    });
    const { root } = await rolloutHome([
      sessionMeta(),
      malformedUpdate,
      turnContext(),
      tokenCount(),
      "",
    ].join("\n"));
    try {
      await assert.rejects(scanCodexLogEvents({
        codexHome: root,
        startAt: "1970-01-01T00:00:00.000Z",
        endAt: "2030-01-01T00:00:00.000Z",
        requireCompleteDiscovery: true,
      }), { code: "codex_rollout_content_invalid" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("fractional usage", async () => {
    const invalid = JSON.stringify({
      timestamp: "2026-07-25T00:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: usage(1.5),
          last_token_usage: usage(1.5),
        },
      },
    });
    const { root } = await rolloutHome(
      `${sessionMeta()}\n${turnContext()}\n${invalid}\n`,
    );
    try {
      await assert.rejects(scanCodexLogEvents({
        codexHome: root,
        startAt: "1970-01-01T00:00:00.000Z",
        endAt: "2030-01-01T00:00:00.000Z",
        requireCompleteDiscovery: true,
      }), { code: "codex_rollout_content_invalid" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("malformed speed setting", async () => {
    const invalidTier = JSON.stringify({
      timestamp: "2026-07-25T00:00:00.500Z",
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { service_tier: 42 },
      },
    });
    const { root } = await rolloutHome(
      `${sessionMeta()}\n${invalidTier}\n${tokenCount()}\n`,
    );
    try {
      await assert.rejects(scanCodexLogEvents({
        codexHome: root,
        startAt: "1970-01-01T00:00:00.000Z",
        endAt: "2030-01-01T00:00:00.000Z",
        requireCompleteDiscovery: true,
      }), { code: "codex_rollout_content_invalid" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("a stable rollout handle rejects same-size in-place mutation", async () => {
  const { root, source } = await rolloutHome(`${sessionMeta()}\n${tokenCount()}\n`);
  try {
    const before = await stat(source);
    const info = {
      path: source,
      size: before.size,
      dev: before.dev,
      ino: before.ino,
      birthtimeMs: before.birthtimeMs,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    };
    await assert.rejects(withStableRolloutSource(info, async () => {
      const handle = await open(source, "r+");
      try {
        await handle.write(Buffer.from("X"), 0, 1, 0);
      } finally {
        await handle.close();
      }
      const future = new Date(Date.now() + 2_000);
      await utimes(source, future, future);
    }), { code: "codex_rollout_source_changed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source mutation outranks a simultaneous parser failure", async () => {
  const { root, source } = await rolloutHome(`${sessionMeta()}\n${tokenCount()}\n`);
  try {
    const before = await stat(source);
    const info = {
      path: source,
      size: before.size,
      dev: before.dev,
      ino: before.ino,
      birthtimeMs: before.birthtimeMs,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    };
    await assert.rejects(withStableRolloutSource(info, async () => {
      const handle = await open(source, "r+");
      try {
        await handle.write(Buffer.from("X"), 0, 1, 0);
      } finally {
        await handle.close();
      }
      const future = new Date(Date.now() + 2_000);
      await utimes(source, future, future);
      throw Object.assign(new Error("malformed content"), {
        code: "codex_rollout_content_invalid",
      });
    }), { code: "codex_rollout_source_changed", retryable: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unreadable discovery roots propagate instead of publishing an empty corpus", async () => {
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const sources = createCodexLogSources({
    filesystem: {
      createSha256: () => createHash("sha256"),
      defaultCodexHome: () => "/codex",
      joinPath: (...parts) => parts.join("/"),
      openDirectory: async () => { throw denied; },
      readSelectedRolloutNames: async () => null,
    },
    lineReader: { readBoundedUtf8Lines: async function* lines() {} },
  });
  await assert.rejects(sources.discoverCodexRolloutInfos({
    codexHome: "/codex",
    startAt: "1970-01-01T00:00:00.000Z",
    selectedRolloutNames: new Map(),
  }), (error) => error === denied);
});

test("resource-limit and cancellation control errors escape lineage validation", async (t) => {
  await t.test("duplicate digest resource limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-control-digest-"));
    const sessions = join(root, "sessions", "2026", "07", "25");
    await mkdir(sessions, { recursive: true });
    const contents = `${sessionMeta()}\n`;
    await writeFile(join(
      sessions,
      `rollout-2026-07-25T00-00-00-${THREAD}.jsonl`,
    ), contents);
    await writeFile(join(
      sessions,
      `rollout-2026-07-25T00-00-01-${THREAD}.jsonl`,
    ), contents);
    const ports = createLocalCodexLogPorts({
      environment: { CODEX_HOME: root },
      homeDirectory: root,
    });
    const limit = Object.assign(new Error("limit"), {
      code: "export_resource_source_bytes",
    });
    const sources = createCodexLogSources({
      filesystem: {
        ...ports.filesystem,
        async openReadOnlyNoFollow(path) {
          const handle = await ports.filesystem.openReadOnlyNoFollow(path);
          return {
            fd: handle.fd,
            stat: (...args) => handle.stat(...args),
            close: (...args) => handle.close(...args),
            read: async () => { throw limit; },
          };
        },
      },
      lineReader: ports.lineReader,
    });
    try {
      await assert.rejects(sources.discoverCodexRolloutInfos({
        codexHome: root,
        startAt: "1970-01-01T00:00:00.000Z",
        endAt: "2030-01-01T00:00:00.000Z",
        selectedRolloutNames: new Map(),
      }), (error) => error === limit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("history cutoff cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "rollout-control-abort-"));
    const sessions = join(root, "sessions", "2026", "07", "25");
    await mkdir(sessions, { recursive: true });
    const parent = join(
      sessions,
      `rollout-2026-07-25T00-00-00-${THREAD}.jsonl`,
    );
    const parentBytes = Buffer.from(`${sessionMeta()}\n${JSON.stringify({
      type: "noise",
      payload: "x".repeat(600_000),
    })}\n`);
    await writeFile(parent, parentBytes);
    const childRollout = "22222222-2222-4222-8222-222222222222";
    await writeFile(join(
      sessions,
      `rollout-2026-07-25T00-00-01-${THREAD}_${childRollout}.jsonl`,
    ), `${JSON.stringify({
      ordinal: 0,
      timestamp: "2026-07-25T00:00:01.000Z",
      type: "session_meta",
      payload: {
        id: THREAD,
        history_mode: "paginated",
        history_base: {
          thread_id: THREAD,
          end_ordinal_exclusive: 2,
          end_byte_offset: parentBytes.length,
        },
      },
    })}\n`);
    const controller = new AbortController();
    const ports = createLocalCodexLogPorts({
      environment: { CODEX_HOME: root },
      homeDirectory: root,
    });
    const sources = createCodexLogSources({
      filesystem: {
        ...ports.filesystem,
        async openReadOnlyNoFollow(path) {
          const handle = await ports.filesystem.openReadOnlyNoFollow(path);
          return {
            fd: handle.fd,
            stat: (...args) => handle.stat(...args),
            close: (...args) => handle.close(...args),
            async read(...args) {
              controller.abort();
              return handle.read(...args);
            },
          };
        },
      },
      lineReader: ports.lineReader,
    });
    try {
      await assert.rejects(sources.discoverCodexRolloutInfos({
        codexHome: root,
        startAt: "1970-01-01T00:00:00.000Z",
        endAt: "2030-01-01T00:00:00.000Z",
        selectedRolloutNames: new Map(),
        signal: controller.signal,
      }), { name: "AbortError" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("pathological lineage depth is iterative and does not overflow the call stack", () => {
  const count = 15_000;
  const infos = Array.from({ length: count }, (_, index) => {
    const sessionId = `session-${index}`;
    return {
      rolloutKey: `rollout-${String(index).padStart(5, "0")}`,
      size: 1,
      lineage: {
        sessionId,
        parentId: index === 0 ? null : `session-${index - 1}`,
      },
    };
  });
  const components = lineageComponents(infos);
  assert.equal(components.length, 1);
  assert.equal(components[0].members.length, count);
  assert.equal(components[0].members[0], infos[0]);
  assert.equal(components[0].members.at(-1), infos.at(-1));
});

test("a deep new fork chain rescans required ancestors once and terminates", async () => {
  const depth = 96;
  const { root, source } = await rolloutHome([
    sessionMeta(),
    turnContext(),
    tokenCount(),
    "",
  ].join("\n"));
  try {
    assert.equal((await build(root)).usageEvents, 1);
    let parentId = THREAD;
    for (let index = 1; index <= depth; index += 1) {
      const sessionId = `deep-session-${index}`;
      await writeFile(join(
        dirname(source),
        `deep-fork-${String(index).padStart(3, "0")}.jsonl`,
      ), [
        JSON.stringify({
          timestamp: "2026-07-25T00:00:00.000Z",
          type: "session_meta",
          payload: { id: sessionId, forked_from_id: parentId },
        }),
        turnContext(),
        tokenCount(100 + index),
        "",
      ].join("\n"), { mode: 0o600 });
      parentId = sessionId;
    }

    const advanced = await ingest(root);
    assert.equal(advanced.rebuilt, undefined);
    assert.equal(advanced.sourcesRescanned, depth + 1);
    assert.equal(advanced.totalUsageEvents, depth + 1);
    assert.equal(advanced.generation.status, "complete");

    const unchanged = await ingest(root);
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.sourcesScanned, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a logical parent cycle is quarantined instead of receiving arbitrary accounting order", async () => {
  const root = await mkdtemp(join(tmpdir(), "rollout-logical-cycle-"));
  const sessions = join(root, "sessions", "2026", "07", "25");
  const other = "22222222-2222-4222-8222-222222222222";
  await mkdir(sessions, { recursive: true });
  const metadata = (id, parentId) => JSON.stringify({
    timestamp: "2026-07-25T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      session_id: id,
      parent_thread_id: parentId,
      thread_source: "user",
      originator: "codex_cli_rs",
    },
  });
  try {
    await writeFile(join(
      sessions,
      `rollout-2026-07-25T00-00-00-${THREAD}.jsonl`,
    ), `${metadata(THREAD, other)}\n${turnContext()}\n${tokenCount()}\n`, {
      mode: 0o600,
    });
    await writeFile(join(
      sessions,
      `rollout-2026-07-25T00-00-01-${other}.jsonl`,
    ), `${metadata(other, THREAD)}\n${turnContext()}\n${tokenCount()}\n`, {
      mode: 0o600,
    });

    const result = await build(root);
    assert.equal(result.generation.status, "partial");
    assert.equal(
      result.generation.issueCounts.codex_rollout_lineage_invalid.sourceCount,
      2,
    );
    assert.equal(result.usageEvents, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
