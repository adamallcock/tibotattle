import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import {
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
  iterateUnifiedWorkUsageFacts,
} from "../src/local-unified-index.js";
import {
  prepareWorkUsageCollector,
  readLocalWorkUsageSnapshot,
} from "../src/local-work-usage-source.js";
import { readLocalUnifiedCompanionProjection } from "../src/local-unified-companion-source.js";
import { readLocalUnifiedCompanionProjectionOffMain } from "../src/local-unified-companion-off-main.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-24T12:00:00Z");
const UUID = "11111111-1111-4111-8111-111111111111";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "combined-work-accounting-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions", "2026", "08", "24");
  const directory = join(root, "project");
  await mkdir(sessions, { recursive: true });
  await mkdir(directory);
  const rows = [
    {
      type: "session_meta",
      timestamp: new Date(NOW - 40 * DAY).toISOString(),
      payload: {
        id: UUID,
        session_id: UUID,
        thread_source: "user",
        originator: "codex_cli_rs",
        cwd: directory,
      },
    },
    {
      type: "turn_context",
      timestamp: new Date(NOW - 40 * DAY).toISOString(),
      payload: { turn_id: "turn-1", model: "gpt-5.6-sol", cwd: directory },
    },
  ];
  const times = [
    NOW - 35 * DAY,
    NOW - 8 * DAY,
    NOW - 2 * DAY,
    NOW - DAY,
    NOW - 3600_000,
    NOW - 1000,
    NOW,
    NOW + 1000,
  ];
  times.forEach((at, index) => {
    const usage = (input) => ({
      input_tokens: input,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: input,
    });
    rows.push({
      type: "event_msg",
      timestamp: new Date(at).toISOString(),
      payload: {
        type: "token_count",
        info: {
          total_token_usage: usage((index + 1) * 100),
          last_token_usage: usage(100),
        },
      },
    });
  });
  await writeFile(
    join(sessions, `rollout-2026-08-24T00-00-00-${UUID}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const options = {
    indexFile: join(root, "index.sqlite"),
    codexHome: root,
    secretFile: join(root, "salt"),
    nowMs: NOW,
  };
  await rebuildLocalUnifiedIndex({
    ...options,
    contractVersion: "combined-work-test-v1",
    workerCount: 1,
  });
  const database = openLocalUnifiedIndex(options.indexFile);
  try {
    const inserted = database
      .prepare(
        "INSERT INTO account_scope(status,reason,plan_type,scope_local) VALUES ('available',NULL,'pro',?)",
      )
      .run(Buffer.alloc(32, 0x41));
    database
      .prepare(
        "UPDATE usage_event SET account_scope_id=? WHERE observed_at_ms >= ?",
      )
      .run(Number(inserted.lastInsertRowid), NOW - 3600_000);
    const columns = [
      "tokens_in_uncached",
      "tokens_in_cache_read",
      "tokens_in_cache_write",
      "tokens_out_text",
      "tokens_out_reasoning",
      "tokens_out_combined",
    ];
    database
      .prepare(
        `UPDATE usage_event SET ${columns.map((c) => `${c}=NULL`).join(",")} WHERE observed_at_ms=?`,
      )
      .run(NOW - 1000);
    database
      .prepare(
        `UPDATE usage_event SET ${columns.map((c) => `${c}=0`).join(",")} WHERE observed_at_ms=?`,
      )
      .run(NOW - 3600_000);
  } finally {
    database.close();
  }
  return options;
}

function sortedCells(snapshot) {
  return [...snapshot.cells].sort((a, b) => a.id.localeCompare(b.id));
}

test("combined projection preserves the companion and exact standalone results for every period and scope", async (t) => {
  const options = await fixture(t);
  const ordinary = await readLocalUnifiedCompanionProjection(options);
  const combined = await readLocalUnifiedCompanionProjection({
    ...options,
    includeWorkUsage: true,
  });
  assert.equal(combined.companion.status, "available");
  assert.deepEqual(combined.companion.usage, ordinary.usage);
  assert.deepEqual(combined.companion.timeline, ordinary.timeline);
  assert.equal(combined.workUsage.status, "available");
  assert.equal(combined.workUsage.asOfMs, NOW);
  assert.equal(combined.workUsage.periods.all.scopes.length, 2);
  for (const period of Object.values(combined.workUsage.periods)) {
    assert.equal(period.toMs, NOW);
    for (const scope of period.scopes) {
      const snapshot = period.snapshots[scope.id];
      const separate = await readLocalWorkUsageSnapshot({
        ...options,
        ...period,
        scope: scope.id,
      });
      assert.deepEqual(sortedCells(snapshot), sortedCells(separate));
      assert.deepEqual(snapshot.threadFamilies, separate.threadFamilies);
      assert.equal(
        snapshot.generation.fingerprint,
        combined.companion.generation.fingerprint,
      );
    }
  }
  const allCells = Object.values(
    combined.workUsage.periods.all.snapshots,
  ).flatMap((s) => s.cells);
  assert.equal(
    allCells.reduce((n, c) => n + (c.tokens ?? 0), 0),
    400,
  );
  assert.equal(
    allCells.reduce((n, c) => n + c.events, 0),
    6,
  );
  assert.equal(
    allCells.reduce((n, c) => n + c.unknownEvents, 0),
    1,
  );
  // A known zero and an unknown event survive even though neither produces a
  // positive-token companion projection. The event at NOW is outside work.
  const recent = Object.values(
    combined.workUsage.periods["24h"].snapshots,
  ).flatMap((s) => s.cells);
  assert.equal(
    recent.reduce((n, c) => n + c.events, 0),
    3,
  );
  assert.equal(
    recent.reduce((n, c) => n + (c.tokens ?? 0), 0),
    100,
  );
  assert.doesNotThrow(() => structuredClone(combined));
});

test("combined direct and actual worker paths agree without changing the legacy worker shape", async (t) => {
  const options = { ...(await fixture(t)), includeWorkUsage: true };
  const direct = await readLocalUnifiedCompanionProjectionOffMain(options, {
    platform: "linux",
  });
  const worker = await readLocalUnifiedCompanionProjectionOffMain(options, {
    platform: "darwin",
  });
  assert.deepEqual(worker.companion.usage, direct.companion.usage);
  for (const id of Object.keys(direct.workUsage.periods)) {
    assert.deepEqual(
      worker.workUsage.periods[id].scopes,
      direct.workUsage.periods[id].scopes,
    );
    for (const scope of direct.workUsage.periods[id].scopes)
      assert.deepEqual(
        worker.workUsage.periods[id].snapshots[scope.id].cells,
        direct.workUsage.periods[id].snapshots[scope.id].cells,
      );
  }
  const custom = await readLocalUnifiedCompanionProjectionOffMain(
    {
      ...options,
      operation: "work-usage",
      fromMs: NOW - DAY,
      toMs: NOW,
    },
    { platform: "darwin" },
  );
  assert.equal(custom.status, "available");
  assert.deepEqual(
    custom.cells,
    direct.workUsage.periods["24h"].snapshots[custom.scope].cells,
  );
  const legacy = await readLocalUnifiedCompanionProjectionOffMain(
    { ...options, includeWorkUsage: false },
    { platform: "darwin" },
  );
  assert.equal(legacy.status, "available");
  assert.equal(Object.hasOwn(legacy, "workUsage"), false);
});

test("collector consumes the supplied exact price and enforces one global budget across periods", async (t) => {
  const options = await fixture(t);
  const database = openLocalUnifiedIndex(options.indexFile, { readOnly: true });
  try {
    const generation = readUnifiedIndexGenerationDescriptor(database);
    const row = [
      ...iterateUnifiedWorkUsageFacts(database, {
        fromMs: NOW - DAY,
        toMs: NOW,
        accountScopeId: 1,
      }),
    ][0];
    assert.ok(row);
    const collector = await prepareWorkUsageCollector({
      ...options,
      database,
      generation,
    });
    collector.add(row, {
      apiPriceEquivalentUsdExact: "123.456789012345",
      pricingCoverageStatus: "fully_priced",
    });
    const result = await collector.finish();
    for (const period of Object.values(result.periods)) {
      assert.equal(
        Object.values(period.snapshots)[0].cells[0].costUsdExact,
        "123.456789012345",
      );
    }
    const bounded = await prepareWorkUsageCollector({
      ...options,
      database,
      generation,
      maximumCells: 3,
    });
    assert.throws(() => bounded.add(row, null), {
      code: "work_usage_capacity_exceeded",
    });
  } finally {
    database.close();
  }
});

test("combined missing and deferred states remain internal typed wrappers", async () => {
  for (const mode of ["full", "deferred"]) {
    const result = await readLocalUnifiedCompanionProjection({
      indexFile: "/missing/combined-test.sqlite",
      codexHome: "/missing",
      nowMs: NOW,
      includeWorkUsage: true,
      mode,
    });
    assert.equal(
      result.companion.status,
      mode === "full" ? "missing" : "deferred",
    );
    assert.equal(result.workUsage.status, result.companion.status);
    assert.equal(result.workUsage.asOfMs, NOW);
  }
});


test("a cancelled direct combined read uses the same bounded abort code", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readLocalUnifiedCompanionProjectionOffMain({
    indexFile: "/missing/combined-test.sqlite", codexHome: "/missing",
    nowMs: NOW, includeWorkUsage: true,
  }, { platform: "linux", signal: controller.signal }), {
    code: "local_unified_companion_projection_aborted",
  });
});
