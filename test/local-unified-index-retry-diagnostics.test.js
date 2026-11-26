import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildLocalCompanionSnapshot } from "../src/local-companion-data.js";
import { createLocalUnifiedAccountingSource } from "../src/local-unified-accounting-source.js";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import {
  beginUnifiedIndexGeneration,
  createUnifiedIndexWriter,
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
} from "../src/local-unified-index.js";

const CONTRACT = "usage-event-v0.2";
const DAY = "2026-11-17";
const END_AT = `${DAY}T07:00:00.000Z`;

function sessionId(hour) {
  return `00000000-0000-4000-8000-0000000000${hour}`;
}

function record(hour, second, type, payload) {
  return `${JSON.stringify({ timestamp: `${DAY}T${hour}:00:${second}.000Z`, type, payload })}\n`;
}

function tool(hour, second, extra = {}) {
  return record(hour, second, "response_item", {
    type: "function_call", name: "thread_spawn", call_id: `synthetic-${hour}-${second}`, ...extra,
  });
}

function rollout(hour) {
  const usage = {
    input_tokens: 50 + Number(hour), cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 55 + Number(hour),
  };
  return record(hour, "00", "session_meta", {
    id: sessionId(hour), thread_source: "user", originator: "codex_cli_rs",
  }) + record(hour, "01", "turn_context", {
    turn_id: "synthetic-turn", model: "gpt-6.2-sol", effort: "high",
  }) + record(hour, "02", "event_msg", {
    type: "token_count", info: { total_token_usage: usage, last_token_usage: usage },
  }) + tool(hour, "03");
}

async function buildCorpus(t, files) {
  const root = await mkdtemp(join(tmpdir(), "unified-index-retry-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions", "2026", "11", "17");
  const indexFile = join(root, "index.sqlite");
  const source = (hour) => join(sessions, `rollout-${DAY}T${hour}-00-00-${sessionId(hour)}.jsonl`);
  await mkdir(sessions, { recursive: true });
  const put = (hour) => writeFile(source(hour), rollout(hour));
  await Promise.all(files.map(put));
  return {
    root, indexFile, source, put,
    ingest: (options) => ingestLocalUnifiedIndexIncrement({
      codexHome: root, indexFile, secretFile: join(root, "salt"), contractVersion: CONTRACT,
      ...options,
    }),
  };
}

async function cancelAfterScan(ingest, options = {}) {
  const controller = new AbortController();
  let sourcesScanned = 0;
  await assert.rejects(ingest({
    ...options,
    signal: controller.signal,
    onProgress(progress) {
      sourcesScanned = progress.sourcesScanned;
      controller.abort();
    },
  }), { code: "local_unified_index_aborted" });
  assert.equal(sourcesScanned, 1);
}

function sourceDiagnostic(indexFile, generationId, code) {
  const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
  try {
    return database.prepare(`SELECT COALESCE(SUM(count), 0) AS count
      FROM source_diagnostic WHERE generation_id = ? AND code = ?`).get(generationId, code).count;
  } finally {
    database.close();
  }
}

function companion({ root, indexFile }) {
  return buildLocalCompanionSnapshot({
    root, codexHome: root, unifiedIndexFile: indexFile,
    collectorStateFile: join(root, "collector.sqlite"),
    archiveIndexFile: join(root, "archive.sqlite"),
    accountingSourceMode: "unified", now: () => Date.parse(END_AT),
  });
}

for (const returned of [true, false]) {
  test(`retry ${returned ? "clears an obsolete" : "preserves a genuine"} tool-history gap`, async (t) => {
    const corpus = await buildCorpus(t, ["00", "01"]);
    const { root, indexFile, ingest, source } = corpus;
    const first = await ingest();
    const predecessor = openLocalUnifiedIndex(indexFile, { readOnly: false });
    try {
      predecessor.prepare(`UPDATE parser_version SET parser_version = replace(parser_version, ?, ?)`)
        .run(LOCAL_UNIFIED_INDEX_PARSER_VERSION, "unified-rollout-typed-v20");
    } finally {
      predecessor.close();
    }
    const held = join(root, "held-rollout.jsonl");
    await rename(source("01"), held);
    await cancelAfterScan(ingest);
    assert.equal((await companion(corpus)).overview.accounting.generation, first.generation.id);
    if (returned) await rename(held, source("01"));

    const { generation, sourcesScanned, totalUsageEvents } = await ingest();
    assert.equal(sourcesScanned, returned ? 1 : 0);
    assert.equal(totalUsageEvents, 2);
    assert.equal(generation.toolFacts, 2);
    assert.equal(generation.status, returned ? "complete" : "partial");
    assert.equal(generation.toolProvenanceComplete, returned);
    assert.equal(generation.blockReason, returned ? null : "tool_provenance_incomplete");
    assert.equal(sourceDiagnostic(indexFile, generation.id, "toolSourceHistoryUnavailable"), returned ? 0 : 1);

    const { overview } = await companion(corpus);
    assert.equal(overview.tools.total, returned ? 2 : null);
    assert.equal(overview.tools.reason, returned ? undefined : "typed_tool_history_partial");
    assert.equal(overview.accounting.projection.status, "available");
    assert.equal(overview.accounting.totalTokens, 111);
    const scan = createLocalUnifiedAccountingSource({
      indexFile, expectedGeneration: generation, requireComplete: returned,
    });
    const accounting = await scan({ startAt: `${DAY}T00:00:00.000Z`, endAt: END_AT });
    // The restored source also replaces its old usage-parser stamp. A true
    // retained source still has mixed-version facts under the strict reader.
    assert.equal(accounting.coverage.status, returned ? "complete" : "partial");
    assert.equal(accounting.coverage.blockReason, returned ? null : "mixed_parser_versions");
    assert.equal(accounting.coverage.generationProof, returned);
    assert.equal(accounting.coverage.toolFactsComplete, returned);
    const unchanged = await ingest();
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.generation.id, generation.id);
  });
}

test("retry publishes current discovery totals when a new independent rollout arrives", async (t) => {
  const corpus = await buildCorpus(t, ["00"]);
  const { ingest, put, source } = corpus;
  await ingest();
  await put("01");
  await cancelAfterScan(ingest);
  await put("02");
  const metadata = await Promise.all(["00", "01", "02"].map((hour) => stat(source(hour))));
  const bytes = metadata.reduce((sum, item) => sum + item.size, 0);

  const result = await ingest();
  assert.equal(result.sourcesScanned, 1);
  assert.equal(result.totalUsageEvents, 3);
  assert.equal(result.generation.discoveredSourceCount, 3);
  assert.equal(result.generation.discoveredSourceBytes, bytes);
  assert.equal(result.generation.indexedSourceCount, 3);
  assert.equal(result.generation.indexedSourceBytes, bytes);
  const { overview } = await companion(corpus);
  assert.equal(overview.accounting.historyCoverage.sourceCount, 3);
  assert.equal(overview.accounting.historyCoverage.sourceBytes, bytes);
  assert.equal(overview.accounting.historyCoverage.phase, "aggregate_unavailable");
  const unchanged = await ingest();
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.generation.id, result.generation.id);
});

test("append retries retain prefix tool diagnostics once and a full rescan supersedes them", async (t) => {
  const { source, ingest, put, indexFile } = await buildCorpus(t, ["00"]);
  const sourceFile = source("00");
  const options = { maximumLineBytes: 512 };
  const oversized = (second) => tool("00", second, { arguments: "x".repeat(4096) });
  await appendFile(sourceFile, oversized("04"));
  const first = await ingest(options);
  assert.equal(first.generation.toolProvenanceComplete, false);
  assert.equal(sourceDiagnostic(indexFile, first.generation.id, "toolRecordsSkipped"), 1);

  await appendFile(sourceFile, oversized("05") + tool("00", "06"));
  await cancelAfterScan(ingest, options);
  const retry = await ingest(options);
  assert.equal(retry.sourcesScanned, 0);
  assert.equal(retry.generation.toolFacts, 2);
  assert.equal(retry.generation.toolProvenanceComplete, false);
  assert.equal(sourceDiagnostic(indexFile, retry.generation.id, "toolRecordsSkipped"), 2);

  await appendFile(sourceFile, tool("00", "07"));
  const next = await ingest(options);
  assert.equal(next.sourcesResumed, 1);
  assert.equal(next.generation.toolFacts, 3);
  assert.equal(next.generation.toolProvenanceComplete, false);
  assert.equal(sourceDiagnostic(indexFile, next.generation.id, "toolRecordsSkipped"), 2);

  await put("00");
  const replaced = await ingest(options);
  assert.equal(replaced.sourcesRescanned, 1);
  assert.equal(replaced.generation.toolFacts, 1);
  assert.equal(replaced.generation.toolProvenanceComplete, true);
  assert.equal(sourceDiagnostic(indexFile, replaced.generation.id, "toolRecordsSkipped"), 0);
});

test("failing a generation preserves the discovery metadata captured at its start", async (t) => {
  const { indexFile } = await buildCorpus(t, []);
  const database = openLocalUnifiedIndex(indexFile, { create: true });
  try {
    const generation = beginUnifiedIndexGeneration(database, {
      contractVersion: CONTRACT, discoveredSourceCount: 2, discoveredSourceBytes: 100,
    });
    const writer = createUnifiedIndexWriter(database, { ...generation, contractVersion: CONTRACT });
    writer.failGeneration("exception");
    const failed = readUnifiedIndexGenerationDescriptor(database, generation.generationId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.blockReason, "exception");
    assert.equal(failed.discoveredSourceCount, 2);
    assert.equal(failed.discoveredSourceBytes, 100);
    assert.equal(readUnifiedIndexGenerationDescriptor(database), null);
  } finally {
    database.close();
  }
});
