import assert from "node:assert/strict";
import test from "node:test";

import {
  WORK_USAGE_SCHEMA,
  createWorkUsageAccumulator,
  projectRecordedTokenComponents,
  queryWorkUsageSnapshot,
} from "../src/reporting/index.js";
import {
  createWorkUsageService,
  validateWorkUsageQuery,
} from "../src/application/index.js";

const COMPONENT_NAMES = [
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
  "output_combined_tokens",
];

function components(values = {}) {
  return Object.fromEntries(COMPONENT_NAMES.map((name) => [name, values[name] ?? null]));
}

function event({
  thread = "thread-a",
  project = "repo-a",
  worktree = "worktree-a",
  model = "model-a",
  at = 1_000,
  tokens = {},
  price,
  partial,
} = {}) {
  return {
    thread,
    project,
    worktree,
    model,
    at,
    components: components(tokens),
    ...(price === undefined ? {} : { price }),
    ...(partial === undefined ? {} : { partial }),
  };
}

function reportFrom(events, options = {}) {
  const accumulator = createWorkUsageAccumulator(options);
  for (const item of events) accumulator.add(item);
  return { cells: accumulator.finish() };
}

function query(report, options = {}) {
  return queryWorkUsageSnapshot(report, {
    grouping: "project",
    sort: "tokens",
    offset: 0,
    pageSize: 100,
    ...options,
  });
}

function availableResult(events, overrides = {}) {
  return {
    status: "available",
    generation: 1,
    scope: "device",
    scopes: ["device"],
    metadata: {},
    models: [],
    threadLookup: {},
    ...reportFrom(events),
    ...overrides,
  };
}

async function waitForAvailable(service, request) {
  const preparing = await service.query(request);
  assert.equal(preparing.status, "preparing");
  const pinnedRequest = { ...request, snapshotId: preparing.snapshotId };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await service.query(pinnedRequest);
    if (result.status === "available") return result;
  }
  assert.fail("work-usage build did not become available");
}

function assertQueryError(request, code = "work_usage_query_invalid") {
  assert.throws(() => validateWorkUsageQuery(request), (error) => error.code === code);
}

test("token projection keeps unknown-only, known-zero, mixed output, and partial combined distinct", () => {
  const unknown = projectRecordedTokenComponents();
  assert.equal(unknown.totalTokens, null);
  assert.equal(unknown.totalComplete, false);
  assert.equal(unknown.breakdownComplete, false);

  const zero = projectRecordedTokenComponents(components({
    input_uncached_tokens: 0,
    input_cache_read_tokens: 0,
    input_cache_write_tokens: 0,
    output_text_tokens: 0,
    output_reasoning_tokens: 0,
  }));
  assert.equal(zero.totalTokens, 0);
  assert.equal(zero.totalComplete, true);
  assert.equal(zero.breakdownComplete, true);

  const mixed = projectRecordedTokenComponents(components({
    input_uncached_tokens: 10,
    input_cache_read_tokens: 0,
    input_cache_write_tokens: 0,
    output_combined_tokens: 100,
  }));
  assert.equal(mixed.totalTokens, 110);
  assert.equal(mixed.totalComplete, true);
  assert.equal(mixed.components.output_combined_tokens, 100);
  assert.equal(mixed.components.output_text_tokens, null);

  const partialCombined = projectRecordedTokenComponents(components({
    input_uncached_tokens: 10,
    input_cache_read_tokens: 0,
    input_cache_write_tokens: 0,
    output_combined_tokens: 100,
    output_text_tokens: 20,
  }));
  assert.equal(partialCombined.totalTokens, 110);
  assert.equal(partialCombined.totalComplete, true);
  assert.equal(partialCombined.breakdownComplete, false);
  assert.equal(partialCombined.components.output_combined_tokens, 100);
  assert.equal(partialCombined.components.output_text_tokens, null);
  assert.equal(partialCombined.components.output_reasoning_tokens, null);
});

test("cross-project events for one thread conserve totals in project and thread views", () => {
  const report = reportFrom([
    event({
      project: "repo-a",
      worktree: "worktree-a",
      tokens: {
        input_uncached_tokens: 10,
        output_text_tokens: 5,
      },
      price: { amount: "0.10", status: "fully_priced" },
    }),
    event({
      project: "repo-b",
      worktree: "worktree-b",
      tokens: {
        input_cache_read_tokens: 7,
        output_reasoning_tokens: 3,
      },
      price: { amount: "0.005", status: "fully_priced" },
    }),
  ]);

  const projects = query(report, { grouping: "project" });
  assert.equal(projects.totals.tokens, 25);
  assert.equal(projects.totals.costUsdExact, "0.105");
  assert.equal(projects.totals.activeThreads, 1);
  assert.equal(projects.totals.activeProjects, 2);
  assert.deepEqual(projects.rows.map((row) => [row.id, row.tokens, row.share]), [
    ["repo-a", 15, 0.6],
    ["repo-b", 10, 0.4],
  ]);
  assert.deepEqual(projects.rows.map((row) => row.threadCount), [1, 1]);

  const threads = query(report, { grouping: "thread" });
  assert.equal(threads.rowCount, 1);
  assert.equal(threads.rows[0].id, "thread-a");
  assert.equal(threads.rows[0].tokens, 25);
  assert.equal(threads.rows[0].costUsdExact, "0.105");
  assert.deepEqual(threads.rows[0].projects, ["repo-a", "repo-b"]);
  assert.deepEqual(threads.rows[0].worktrees, ["worktree-a", "worktree-b"]);
});

test("mixed combined and split output sums to 125 without double counting", () => {
  const report = reportFrom([
    event({
      tokens: {
        input_uncached_tokens: 0,
        input_cache_read_tokens: 0,
        input_cache_write_tokens: 0,
        output_combined_tokens: 100,
      },
    }),
    event({
      tokens: {
        input_uncached_tokens: 0,
        input_cache_read_tokens: 0,
        input_cache_write_tokens: 0,
        output_text_tokens: 20,
        output_reasoning_tokens: 5,
      },
    }),
  ]);
  const result = query(report);
  assert.equal(result.totals.tokens, 125);
  assert.equal(result.rows[0].tokens, 125);
  assert.equal(result.rows[0].components.output_combined_tokens, 100);
  assert.equal(result.rows[0].components.output_text_tokens, 20);
  assert.equal(result.rows[0].components.output_reasoning_tokens, 5);
});

test("unknown-only and known-zero events remain visible with separate coverage", () => {
  const report = reportFrom([
    event({
      thread: "thread-unknown",
      project: "repo-unknown",
      tokens: {},
    }),
    event({
      thread: "thread-zero",
      project: "repo-zero",
      tokens: {
        input_uncached_tokens: 0,
        input_cache_read_tokens: 0,
        input_cache_write_tokens: 0,
        output_text_tokens: 0,
        output_reasoning_tokens: 0,
      },
      price: { amount: "0", status: "fully_priced" },
    }),
  ]);
  const result = query(report);
  const unknown = result.rows.find((row) => row.id === "repo-unknown");
  const zero = result.rows.find((row) => row.id === "repo-zero");
  assert.equal(result.totals.tokens, 0);
  assert.equal(result.totals.unknownEvents, 1);
  assert.equal(result.totals.incompleteEvents, 1);
  assert.equal(result.totals.activeThreads, 0);
  assert.equal(unknown.tokens, null);
  assert.equal(unknown.unknownEvents, 1);
  assert.equal(unknown.share, null);
  assert.equal(zero.tokens, 0);
  assert.equal(zero.unknownEvents, 0);
  assert.equal(zero.incompleteEvents, 0);
  assert.equal(zero.costUsdExact, "0");
  assert.equal(zero.priceStatus, "complete");
  assert.equal(zero.share, null);
});

test("accumulator sums exact decimal costs and rejects new cells beyond capacity", () => {
  const report = reportFrom([
    event({ price: { amount: "1.2", status: "fully_priced" } }),
    event({
      at: 2_000,
      tokens: { output_text_tokens: 1 },
      price: { amount: "0.005", status: "fully_priced" },
    }),
  ]);
  const result = query(report);
  assert.equal(result.totals.costUsdExact, "1.205");

  const accumulator = createWorkUsageAccumulator({ maximumCells: 1 });
  accumulator.add(event({ thread: "thread-a" }));
  assert.throws(
    () => accumulator.add(event({ thread: "thread-b" })),
    (error) => error.code === "work_usage_capacity_exceeded",
  );
});

test("service pagination reads one immutable snapshot while later builds can change", async () => {
  const initialEvents = [
    event({ project: "repo-a", tokens: { output_text_tokens: 30 } }),
    event({ project: "repo-b", tokens: { output_text_tokens: 20 } }),
    event({ project: "repo-c", tokens: { output_text_tokens: 10 } }),
  ];
  let builds = 0;
  let sourceEvents = initialEvents;
  let nextId = 0;
  const service = createWorkUsageService({
    build: async () => {
      builds += 1;
      return availableResult(sourceEvents, { generation: builds });
    },
    newId: () => `id-${++nextId}`,
  });
  const request = {
    schemaVersion: WORK_USAGE_SCHEMA,
    period: "7d",
    grouping: "project",
    sort: "tokens",
    pageSize: 1,
  };

  const first = await waitForAvailable(service, request);
  assert.equal(builds, 1);
  assert.equal(first.rows[0].id, "repo-a");
  assert.ok(first.nextCursor);

  sourceEvents = [
    event({ project: "repo-new", tokens: { output_text_tokens: 100 } }),
    ...initialEvents,
  ];
  const second = await service.query({
    ...request,
    snapshotId: first.snapshotId,
    cursor: first.nextCursor,
  });
  assert.equal(second.status, "available");
  assert.equal(builds, 1);
  assert.equal(second.rows[0].id, "repo-b");
  assert.equal(second.totals.tokens, 60);
  assert.equal(second.generation, 1);
});

test("query validation rejects malformed requests and normalizes approved thread links", () => {
  const base = { schemaVersion: WORK_USAGE_SCHEMA };
  for (const request of [
    null,
    {},
    { ...base, schemaVersion: "other" },
    { ...base, unexpected: true },
    { ...base, action: "refresh" },
    { ...base, period: "2d" },
    { ...base, grouping: "model" },
    { ...base, sort: "activity" },
    { ...base, pageSize: 0 },
    { ...base, pageSize: 101 },
    { ...base, pageSize: 1.5 },
    { ...base, project: "repo/with/slash" },
    { ...base, findThread: "not-a-uuid" },
    { ...base, findThread: "codex://threads/not-a-uuid" },
    { ...base, cursor: "cursor-without-snapshot" },
    { ...base, action: "cancel" },
  ]) assertQueryError(request);

  const normalized = validateWorkUsageQuery({
    ...base,
    findThread: "codex://threads/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
  });
  assert.equal(normalized.findThread, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  const customModel = validateWorkUsageQuery({
    ...base,
    model: "gpt-5.6/luna",
  });
  assert.equal(customModel.model, "gpt-5.6/luna");
});

test("cursor is bound to its snapshot filter and cannot cross page-size or grouping changes", async () => {
  let nextId = 0;
  const service = createWorkUsageService({
    build: async () => availableResult([
      event({ project: "repo-a", tokens: { output_text_tokens: 2 } }),
      event({ project: "repo-b", tokens: { output_text_tokens: 1 } }),
    ]),
    newId: () => `cursor-id-${++nextId}`,
  });
  const request = {
    schemaVersion: WORK_USAGE_SCHEMA,
    grouping: "project",
    sort: "tokens",
    pageSize: 1,
  };
  const first = await waitForAvailable(service, request);
  assert.ok(first.nextCursor);
  for (const changed of [
    { pageSize: 2 },
    { grouping: "thread" },
    { project: "repo-a" },
    { sort: "recent" },
  ]) {
    await assert.rejects(
      service.query({
        ...request,
        ...changed,
        snapshotId: first.snapshotId,
        cursor: first.nextCursor,
      }),
      (error) => error.code === "work_usage_snapshot_changed",
    );
  }
  await assert.rejects(
    service.query({
      ...request,
      snapshotId: first.snapshotId,
      cursor: "unknown-cursor",
    }),
    (error) => error.code === "work_usage_snapshot_changed",
  );
});

test("cancel aborts an in-flight build and expires its snapshot", async () => {
  let resolveBuild;
  let aborted = false;
  let nextId = 0;
  const service = createWorkUsageService({
    build: (_range, { signal }) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Promise((resolve) => { resolveBuild = resolve; });
    },
    newId: () => `cancel-id-${++nextId}`,
  });
  const request = { schemaVersion: WORK_USAGE_SCHEMA };
  const preparing = await service.query(request);
  assert.equal(preparing.status, "preparing");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cancelled = await service.query({
    ...request,
    action: "cancel",
    snapshotId: preparing.snapshotId,
  });
  assert.deepEqual(cancelled, { schemaVersion: WORK_USAGE_SCHEMA, status: "cancelled" });
  assert.equal(aborted, true);
  await assert.rejects(
    service.query({ ...request, snapshotId: preparing.snapshotId }),
    (error) => error.code === "work_usage_snapshot_expired",
  );
  resolveBuild(availableResult([]));
});

test("idle snapshots expire and maximum snapshot capacity evicts the oldest", async () => {
  let now = 10_000;
  let nextId = 0;
  const service = createWorkUsageService({
    clock: () => now,
    idleMs: 100,
    maximumSnapshots: 1,
    build: async () => availableResult([
      event({ project: "repo-a", tokens: { output_text_tokens: 1 } }),
    ]),
    newId: () => `snapshot-id-${++nextId}`,
  });
  const first = await waitForAvailable(service, { schemaVersion: WORK_USAGE_SCHEMA, period: "7d" });
  now += 101;
  await assert.rejects(
    service.query({ schemaVersion: WORK_USAGE_SCHEMA, period: "7d", snapshotId: first.snapshotId }),
    (error) => error.code === "work_usage_snapshot_expired",
  );

  now += 1;
  const retained = await waitForAvailable(service, { schemaVersion: WORK_USAGE_SCHEMA, period: "7d" });
  const replacement = await waitForAvailable(service, { schemaVersion: WORK_USAGE_SCHEMA, period: "24h" });
  assert.notEqual(replacement.snapshotId, retained.snapshotId);
  await assert.rejects(
    service.query({ schemaVersion: WORK_USAGE_SCHEMA, period: "7d", snapshotId: retained.snapshotId }),
    (error) => error.code === "work_usage_snapshot_expired",
  );
});

test("thread model breakdown conserves filtered totals across worktrees and keeps output representations distinct", () => {
  const base = {input_uncached_tokens:10,input_cache_read_tokens:20,input_cache_write_tokens:0,output_text_tokens:3,output_reasoning_tokens:2};
  const report = reportFrom([
    event({model:'model-a',tokens:base,price:{amount:'0.10'}}),
    event({model:'model-a',worktree:'worktree-b',tokens:base,price:{amount:'0.20'}}),
    event({model:'model-b',tokens:{input_uncached_tokens:5,input_cache_read_tokens:0,input_cache_write_tokens:2,output_combined_tokens:8},price:{amount:'0.05'}}),
    event({model:'model-a',project:'repo-other',tokens:base,price:{amount:'9.00'}}),
  ]);
  const row=query(report,{grouping:'thread',project:'repo-a'}).rows[0];
  assert.equal(row.tokens,85);
  assert.deepEqual(row.modelBreakdown.map(r=>[r.id,r.tokens,r.costUsdExact]),[['model-a',70,'0.3'],['model-b',15,'0.05']]);
  assert.equal(row.modelBreakdown.reduce((n,r)=>n+r.events,0),row.events);
  for (const key of COMPONENT_NAMES) assert.equal(row.modelBreakdown.reduce((n,r)=>n+(r.components[key]??0),0),row.components[key]??0);
  assert.equal(row.modelBreakdown[1].components.output_text_tokens,null);
  assert.equal(row.modelBreakdown[1].components.output_reasoning_tokens,null);
  assert.equal(row.modelBreakdown[1].components.output_combined_tokens,8);
  const filtered=query(report,{grouping:'thread',project:'repo-a',worktree:'worktree-a',model:'model-a'}).rows[0];
  assert.equal(filtered.tokens,35);
  assert.equal(filtered.modelBreakdown.length,1);
  assert.equal(filtered.modelBreakdown[0].costUsdExact,'0.1');
  assert.equal(query(report).rows[0].modelBreakdown,undefined);
});

test("thread families group before ranking and pagination, conserving descendants across models and filters", () => {
  const tokens={input_uncached_tokens:100,input_cache_read_tokens:0,input_cache_write_tokens:0,output_text_tokens:0,output_reasoning_tokens:0};
  const report=reportFrom([
    event({thread:'root',tokens,price:{amount:'1'}}),
    event({thread:'worker',model:'model-b',tokens,price:{amount:'2'}}),
    event({thread:'grandchild',model:'model-b',worktree:'worktree-b',tokens,price:{amount:'3'}}),
    event({thread:'other',tokens:{...tokens,input_uncached_tokens:200},price:{amount:'4'}}),
    event({thread:'worker',project:'repo-other',tokens,price:{amount:'5'}}),
  ]);
  report.threadFamilies={root:'root',worker:'root',grandchild:'root',other:'other'};
  const first=query(report,{grouping:'thread',project:'repo-a',pageSize:1});
  assert.equal(first.rowCount,2); assert.equal(first.totals.activeThreads,2);
  const row=first.rows[0]; assert.equal(row.id,'root');assert.equal(row.tokens,300);assert.equal(row.costUsdExact,'6');
  assert.equal(row.subworkerCount,2);
  assert.deepEqual(row.contributions.map(r=>[r.id,r.tokens,r.costUsdExact]),[['primary',100,'1'],['subworkers',200,'5']]);
  assert.equal(row.modelBreakdown.reduce((n,r)=>n+r.tokens,0),row.tokens);
  assert.equal(query(report,{grouping:'thread',project:'repo-a',offset:first.nextOffset,pageSize:1}).rows[0].id,'other');
  assert.equal(query(report,{grouping:'thread',project:'repo-a',thread:'root'}).totals.tokens,300);
  assert.equal(query(report,{grouping:'thread',project:'repo-a',thread:'worker'}).totals.tokens,100);
  const filtered=query(report,{grouping:'thread',project:'repo-a',model:'model-b',worktree:'worktree-b'}).rows[0];
  assert.equal(filtered.tokens,100);assert.equal(filtered.id,'root');assert.equal(filtered.subworkerCount,1);
  assert.equal(filtered.contributions.length,1);assert.equal(filtered.contributions[0].id,'subworkers');
});

test("related reports reject invalid anchors and preserve their source across rapid switches", async () => {
  let now = 10 * 86400000;
  const service = createWorkUsageService({ clock: () => now, idleMs: 1000,
    build: async () => availableResult([]),
  });
  const base = { schemaVersion: WORK_USAGE_SCHEMA, period: "7d" };
  async function related(sourceSnapshotId, period) {
    const preparing = await service.query({ ...base, period, sourceSnapshotId });
    await new Promise(resolve => setImmediate(resolve));
    return service.query({ ...base, period, snapshotId: preparing.snapshotId });
  }
  try {
    const source = await waitForAvailable(service, base);
    await related(source.snapshotId, "30d");
    await related(source.snapshotId, "all");
    assert.equal((await related(source.snapshotId, "24h")).status, "available");
    for (const extra of [{ snapshotId: source.snapshotId }, { action: "cancel" }, { cursor: "cursor" }])
      assertQueryError({ ...base, sourceSnapshotId: source.snapshotId, ...extra });
    assertQueryError({ ...base, sourceSnapshotId: 1 });
    await assert.rejects(service.query({ ...base, sourceSnapshotId: "missing" }), { code: "work_usage_snapshot_expired" });
    now += 1001;
    await assert.rejects(service.query({ ...base, sourceSnapshotId: source.snapshotId }), { code: "work_usage_snapshot_expired" });
  } finally { service.close(); }
});

test("related reports cannot silently combine different canonical generations", async () => {
  let generation = 1;
  const service = createWorkUsageService({ build: async () => availableResult([], { generation }) });
  const base = { schemaVersion: WORK_USAGE_SCHEMA, period: "7d" };
  try {
    const source = await waitForAvailable(service, base);
    generation = 2;
    const pending = await service.query({ ...base, period: "all", sourceSnapshotId: source.snapshotId });
    await new Promise(resolve => setImmediate(resolve));
    const rejected = await service.query({ ...base, period: "all", snapshotId: pending.snapshotId });
    assert.equal(rejected.status, "unavailable");
    assert.equal(rejected.errorCode, "work_usage_snapshot_changed");
  } finally { service.close(); }
});


test("complete zero usage needs no model price while uncertain zero stays unpriced", () => {
  const zero = { input_uncached_tokens: 0, input_cache_read_tokens: 0,
    input_cache_write_tokens: 0, output_combined_tokens: 0 };
  const cases = [
    { project: "complete-zero", tokens: zero },
    { project: "partial-zero", tokens: zero, partial: true },
    { project: "missing-component", tokens: { ...zero, input_cache_read_tokens: null } },
    { project: "unknown", tokens: {} },
    { project: "positive", tokens: { ...zero, input_uncached_tokens: 1 } },
    { project: "conflict", tokens: { ...zero, output_text_tokens: 0, output_reasoning_tokens: 1 } },
  ];
  const result = query(reportFrom(cases.map(item => event({ ...item,
    model: "model-without-a-rate", price: { amount: null, status: "unpriced" } }))));
  const known = result.rows.find(row => row.id === "complete-zero");
  assert.equal(known.costUsdExact, "0");
  assert.equal(known.priceStatus, "complete");
  assert.equal(known.unpricedEvents, 0);
  assert.equal(known.partialPriceEvents, 0);
  for (const row of result.rows.filter(row => row !== known)) {
    assert.equal(row.costUsdExact, null, row.id);
    assert.equal(row.priceStatus, "unpriced", row.id);
    assert.equal(row.unpricedEvents, 1, row.id);
  }
  const mixed = query(reportFrom([
    event({ tokens: zero }),
    event({ tokens: { ...zero, input_uncached_tokens: 10 }, price: { amount: "0.0001", status: "fully_priced" } }),
  ]));
  assert.equal(mixed.totals.costUsdExact, "0.0001");
  assert.equal(mixed.rows[0].priceStatus, "complete");
});
