import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  createDeferredAccountingRebuildRecorder,
  createLocalCollectorRefreshRunner,
  createTerminalRefreshFailureRecorder,
  LocalCompanionRefreshController,
} from "../src/local-companion-refresh.js";
import {
  localCompanionStatePaths,
} from "../src/local-installation-diagnostics.js";
import {
  REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
} from "../src/replay-safe-accounting-cache.js";

const COMPLETE_INDEX = Object.freeze({
  mode: "recent_7d",
  status: "recent_7d_complete",
  phase: "complete",
  boundedBy: "modified_at_and_collection_start",
  filesDiscovered: 9,
  filesSelected: 4,
  filesProcessed: 4,
  recordsWritten: 12,
  coveredAt: {
    startAt: "2026-07-16T12:00:00.000Z",
    endAt: "2026-07-23T12:00:00.000Z",
  },
});

const PARTIAL_INDEX = Object.freeze({
  ...COMPLETE_INDEX,
  status: "recent_7d_partial",
  filesProcessed: 3,
  coveredAt: {
    startAt: null,
    endAt: "2026-07-23T12:00:00.000Z",
  },
});

const PAUSED_INDEX = Object.freeze({
  ...COMPLETE_INDEX,
  status: "bounded_pause",
  phase: "paused",
  filesProcessed: 2,
  coveredAt: {
    startAt: "2026-07-16T12:00:00.000Z",
    endAt: null,
  },
});

const REUSABLE_ACCOUNTING_CACHE = Object.freeze({
  schemaVersion: REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
  generatedAt: "2026-07-23T10:00:00.000Z",
  coveredAt: Object.freeze({
    startAt: "2026-06-22T10:00:00.000Z",
    endAt: "2026-07-23T10:00:00.000Z",
  }),
  periods: Object.freeze([
    Object.freeze({ id: "7d", events: 17 }),
  ]),
  diagnostics: Object.freeze({
    forkReplayEventsExcluded: 29,
  }),
});

const FRESH_NOTIFICATION_EVIDENCE = Object.freeze({
  schemaVersion: "tibotattle-notification-evidence-v2",
  status: "fresh_provider_observation",
  provider: "openai_codex",
  source: "app_server_read",
  freshness: "fresh",
  observedAt: "2026-07-23T12:00:00.000Z",
  continuityKey: "a".repeat(43),
  windows: Object.freeze([Object.freeze({
    lane: "primary",
    usedPercent: 84,
    durationMinutes: 10080,
    resetAt: "2026-07-30T12:00:00.000Z",
    resetProofKind: "provider_reported_schedule_only",
  })]),
});

test("local refresh exposes only the closed fresh direct-provider notification receipt", async (t) => {
  const validRunner = createLocalCollectorRefreshRunner({
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
        notificationEvidence: FRESH_NOTIFICATION_EVIDENCE,
      },
    }),
  });
  const valid = await validRunner();
  assert.deepEqual(valid.notificationEvidence, FRESH_NOTIFICATION_EVIDENCE);
  assert.equal(JSON.stringify(valid).includes("account"), false);
  assert.equal(JSON.stringify(valid).includes("/private/"), false);

  const genericRunner = createLocalCollectorRefreshRunner({
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
        notificationEvidence: {
          ...FRESH_NOTIFICATION_EVIDENCE,
          windows: [{
            ...FRESH_NOTIFICATION_EVIDENCE.windows[0],
            durationMinutes: 43_200,
          }],
        },
      },
    }),
  });
  assert.equal(
    (await genericRunner()).notificationEvidence.windows[0].durationMinutes,
    43_200,
  );

  const expiredRunner = createLocalCollectorRefreshRunner({
    clock: () => Date.parse("2026-07-23T12:05:00.001Z"),
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
        notificationEvidence: FRESH_NOTIFICATION_EVIDENCE,
      },
    }),
  });
  assert.equal(
    Object.hasOwn(await expiredRunner(), "notificationEvidence"),
    false,
  );

  for (const [name, notificationEvidence] of [
    ["stale", { ...FRESH_NOTIFICATION_EVIDENCE, freshness: "stale" }],
    ["mixed source", { ...FRESH_NOTIFICATION_EVIDENCE, source: "ledger" }],
    ["inferred", { ...FRESH_NOTIFICATION_EVIDENCE, status: "inferred" }],
    ["zero duration", {
      ...FRESH_NOTIFICATION_EVIDENCE,
      windows: [{
        ...FRESH_NOTIFICATION_EVIDENCE.windows[0],
        durationMinutes: 0,
      }],
    }],
    ["overlong duration", {
      ...FRESH_NOTIFICATION_EVIDENCE,
      windows: [{
        ...FRESH_NOTIFICATION_EVIDENCE.windows[0],
        durationMinutes: 525_601,
      }],
    }],
    ["fractional duration", {
      ...FRESH_NOTIFICATION_EVIDENCE,
      windows: [{
        ...FRESH_NOTIFICATION_EVIDENCE.windows[0],
        durationMinutes: 1.5,
      }],
    }],
  ]) {
    await t.test(name, async () => {
      const runner = createLocalCollectorRefreshRunner({
        selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
        runCollector: async () => ({
          rolloutRecordsWritten: 0,
          filesDiscovered: 0,
          refresh: {
            attempted: true,
            recordWritten: true,
            errorCode: null,
            notificationEvidence,
          },
        }),
      });
      const result = await runner();
      assert.equal(Object.hasOwn(result, "notificationEvidence"), false);
    });
  }
});

test("refresh controller binds every terminal receipt to one opaque refresh run", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const refreshIds = [
    "10000000-0000-4000-8000-000000000000",
    "20000000-0000-4000-8000-000000000000",
  ];
  const controller = new LocalCompanionRefreshController({
    runner: async () => {
      await gate;
      return {
        rolloutRecordsWritten: 0,
        filesDiscovered: 0,
        quotaRefresh: { attempted: true, recordWritten: true, errorCode: null },
        indexing: COMPLETE_INDEX,
      };
    },
    dataStore: { async reload() {} },
    createRefreshId: () => refreshIds.shift(),
  });

  assert.equal(controller.start(), true);
  const firstId = controller.getStatus().refreshId;
  assert.equal(firstId, "10000000-0000-4000-8000-000000000000");
  assert.equal(controller.start(), false);
  assert.equal(controller.getStatus().refreshId, firstId);

  release();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.getStatus().status, "succeeded");
  assert.equal(controller.getStatus().refreshId, firstId);

  assert.equal(controller.start(), true);
  assert.equal(
    controller.getStatus().refreshId,
    "20000000-0000-4000-8000-000000000000",
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.getStatus().status, "succeeded");
});

const PARTIAL_ARCHIVE_INDEX = Object.freeze({
  status: "partial",
  phase: "awaiting_resume",
  generatedAt: "2026-07-23T12:00:00.000Z",
  coveredAt: Object.freeze({
    startAt: "1970-01-01T00:00:00.000Z",
    endAt: "2026-07-23T12:00:00.000Z",
  }),
  sourceCount: 10,
  indexedSourceCount: 3,
  pendingSourceCount: 7,
  sourceBytes: 1000,
  indexedBytes: 300,
  readBudgetBytes: 128 * 1024 * 1024,
  scanBytes: 128 * 1024 * 1024,
});

test("local refresh requests a bounded recent index and returns only safe progress", async () => {
  let options;
  const controller = new AbortController();
  const progress = [];
  const runner = createLocalCollectorRefreshRunner({
    codexHome: "/private/codex-home",
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: async () => Buffer.alloc(32, 7),
    }),
    runCollector: async (value) => {
      options = value;
      await value.onProgress(COMPLETE_INDEX);
      return {
        rolloutRecordsWritten: 12,
        filesDiscovered: 9,
        refresh: {
          attempted: true,
          recordWritten: true,
          errorCode: null,
        },
        indexing: {
          ...COMPLETE_INDEX,
          privatePath: "/private/must-not-escape",
        },
      };
    },
  });

  const result = await runner({
    signal: controller.signal,
    onProgress: (value) => progress.push(value),
  });

  assert.equal(options.backfill, true);
  assert.equal(options.backfillSinceAt, "2026-07-16T12:00:00.000Z");
  assert.equal(options.signal, controller.signal);
  assert.equal(options.maximumRecentRunBytes, 128 * 1024 * 1024);
  assert.equal(options.maximumRecentTailBytes, 4 * 1024 * 1024);
  assert.equal(options.maximumRecentPreludeBytes, 512 * 1024);
  assert.equal(options.maximumBufferedLineBytes, 1024 * 1024);
  assert.equal(progress.length, 2);
  assert.deepEqual(progress[0], COMPLETE_INDEX);
  assert.deepEqual(progress[1], {
    ...COMPLETE_INDEX,
    phase: "quick_result",
  });
  assert.equal(result.rolloutRecordsWritten, 12);
  assert.deepEqual(result.indexing, COMPLETE_INDEX);
  assert.equal(JSON.stringify(result).includes("/private/"), false);
});

test("local refresh routes collector, credential lock, and accounting writes beneath explicit state", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "local-refresh-state-"));
  const paths = localCompanionStatePaths(stateRoot);
  assert.equal(paths.claudeDesktopShadowCanonicalFile.startsWith(stateRoot), true);
  assert.equal(paths.claudeDesktopShadowLedgerFile.startsWith(stateRoot), true);
  assert.equal(paths.claudeDesktopShadowStateFile.startsWith(stateRoot), true);
  assert.equal(paths.claudeDesktopShadowSecretFile.startsWith(stateRoot), true);
  assert.equal(paths.claudeDesktopPricingCacheFile.startsWith(stateRoot), true);
  assert.equal(new Set([
    paths.claudeDesktopQuotaStateFile,
    paths.claudeDesktopShadowCanonicalFile,
    paths.claudeDesktopShadowLedgerFile,
    paths.claudeDesktopShadowStateFile,
    paths.claudeDesktopPricingCacheFile,
  ]).size, 5);
  let collectorOptions;
  let selectionOptions;
  try {
    const runner = createLocalCollectorRefreshRunner({
      codexHome: join(stateRoot, "read-only-codex-source"),
      stateFile: paths.collectorStateFile,
      accountObservationOperationLockFile:
        paths.accountObservationLockFile,
      selectAccountObservationSecret: (options) => {
        selectionOptions = options;
        return { loadAccountObservationSecret: null };
      },
      runCollector: async (options) => {
        collectorOptions = options;
        return {
          rolloutRecordsWritten: 0,
          filesDiscovered: 0,
          refresh: {
            attempted: false,
            recordWritten: false,
            errorCode: null,
          },
        };
      },
      refreshAccounting: async ({ stateFile }) => {
        assert.equal(stateFile, paths.collectorStateFile);
        return {
          generatedAt: "2026-07-23T12:00:00.000Z",
          periods: [],
          diagnostics: {},
        };
      },
    });

    await runner();

    assert.equal(
      selectionOptions.operationLockFile,
      paths.accountObservationLockFile,
    );
    assert.deepEqual(
      [
        collectorOptions.stateFile,
      ],
      [
        paths.collectorStateFile,
      ],
    );
    for (const path of Object.values(paths)) {
      assert.equal(relative(stateRoot, path).startsWith(".."), false);
    }
  } finally {
    await rm(stateRoot, { recursive: true });
  }
});

test("local refresh starts a bounded archive index only after the foreground result is safe", async () => {
  const controller = new AbortController();
  const clock = () => Date.parse("2026-07-23T12:00:00.000Z");
  let archiveOptions;
  const progress = [];
  const runner = createLocalCollectorRefreshRunner({
    codexHome: "/private/codex-home",
    archiveIndexFile: "/private/archive-index.sqlite",
    archiveIndexSecretFile: "/private/archive-index-secret",
    clock,
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 3,
      refresh: {
        attempted: true,
        recordWritten: false,
        errorCode: null,
      },
      indexing: COMPLETE_INDEX,
    }),
    refreshArchiveIndex: async (options) => {
      archiveOptions = options;
      return {
        ...PARTIAL_ARCHIVE_INDEX,
        privatePath: "/private/must-not-escape",
      };
    },
  });

  const result = await runner({
    signal: controller.signal,
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(archiveOptions, {
    codexHome: "/private/codex-home",
    indexFile: "/private/archive-index.sqlite",
    secretFile: "/private/archive-index-secret",
    declaredSpeedBaselines: [],
    now: clock,
    signal: controller.signal,
  });
  assert.deepEqual(result.archiveIndex, PARTIAL_ARCHIVE_INDEX);
  assert.deepEqual(progress.at(-1), {
    kind: "archive_index",
    status: "scanning",
  });
  assert.equal(JSON.stringify(result).includes("/private/"), false);
});

test("archive coverage advances while a recent foreground pass remains bounded", async () => {
  let accountingCalls = 0;
  let archiveCalls = 0;
  const progress = [];
  const runner = createLocalCollectorRefreshRunner({
    codexHome: "/private/codex-home",
    archiveIndexFile: "/private/archive-index.sqlite",
    archiveIndexSecretFile: "/private/archive-index-secret",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 3,
      refresh: {
        attempted: false,
        recordWritten: false,
        errorCode: null,
      },
      indexing: PAUSED_INDEX,
    }),
    refreshAccounting: async () => {
      accountingCalls += 1;
      throw new Error("bounded recent coverage must not start accounting");
    },
    refreshArchiveIndex: async () => {
      archiveCalls += 1;
      return PARTIAL_ARCHIVE_INDEX;
    },
  });

  const result = await runner({
    onProgress: (value) => progress.push(value),
  });

  assert.equal(accountingCalls, 0);
  assert.equal(archiveCalls, 1);
  assert.deepEqual(progress, [
    { ...PAUSED_INDEX, phase: "quick_result" },
    { kind: "archive_index", status: "scanning" },
  ]);
  assert.deepEqual(result.archiveIndex, PARTIAL_ARCHIVE_INDEX);
});

test("archive coverage advances before a foreground resource limit is surfaced", async () => {
  let archiveCalls = 0;
  const progress = [];
  const runner = createLocalCollectorRefreshRunner({
    codexHome: "/private/codex-home",
    archiveIndexFile: "/private/archive-index.sqlite",
    archiveIndexSecretFile: "/private/archive-index-secret",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 20_001,
      resourceLimit: {
        code: "collector_resource_directory_entries_limit_exceeded",
        dimension: "directory_entries",
        limit: 20_000,
        observed: 20_001,
      },
      refresh: {
        attempted: false,
        recordWritten: false,
        errorCode: null,
      },
      indexing: PAUSED_INDEX,
    }),
    refreshArchiveIndex: async () => {
      archiveCalls += 1;
      return PARTIAL_ARCHIVE_INDEX;
    },
  });

  await assert.rejects(
    runner({ onProgress: (value) => progress.push(value) }),
    (error) => error?.code === "collector_resource_limit_exceeded",
  );
  assert.equal(archiveCalls, 1);
  assert.deepEqual(progress, [
    { ...PAUSED_INDEX, phase: "quick_result" },
    { kind: "archive_index", status: "scanning" },
  ]);
});

test("zero-write local refresh reuses a current valid accounting cache without altering it", async () => {
  const controller = new AbortController();
  const clock = () => Date.parse("2026-07-23T12:00:00.000Z");
  const before = structuredClone(REUSABLE_ACCOUNTING_CACHE);
  let readOptions;
  let rebuilds = 0;
  const runner = createLocalCollectorRefreshRunner({
    stateFile: "/private/local-collector-state.sqlite",
    clock,
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 3,
      refresh: {
        attempted: true,
        recordWritten: false,
        errorCode: null,
      },
    }),
    readAccountingCache: async (options) => {
      readOptions = options;
      return {
        status: "available",
        errorCode: null,
        cache: REUSABLE_ACCOUNTING_CACHE,
      };
    },
    refreshAccounting: async () => {
      rebuilds += 1;
      throw new Error("accounting cache must not be rebuilt");
    },
  });

  const result = await runner({ signal: controller.signal });

  assert.deepEqual(readOptions, {
    stateFile: "/private/local-collector-state.sqlite",
    now: clock,
    maximumAgeMs: 30 * 60 * 1_000,
  });
  assert.equal(rebuilds, 0);
  assert.deepEqual(REUSABLE_ACCOUNTING_CACHE, before);
  assert.deepEqual(result.accounting, {
    status: "replay_safe",
    refreshStatus: "reused",
    generatedAt: "2026-07-23T10:00:00.000Z",
    events: 17,
    forkReplayEventsExcluded: 29,
  });
});

test("zero-write local refresh rebuilds when the cache cannot be safely reused", async (t) => {
  const cases = [
    {
      name: "missing cache",
      read: async () => ({
        status: "unavailable",
        errorCode: "cache_missing",
        cache: null,
      }),
    },
    {
      name: "invalid cache",
      read: async () => ({
        status: "unavailable",
        errorCode: "cache_invalid",
        cache: null,
      }),
    },
    {
      name: "stale cache",
      read: async () => ({
        status: "stale",
        errorCode: "cache_stale",
        cache: REUSABLE_ACCOUNTING_CACHE,
      }),
    },
    {
      name: "stale schema",
      read: async () => ({
        status: "available",
        errorCode: null,
        cache: {
          ...REUSABLE_ACCOUNTING_CACHE,
          schemaVersion: "local-replay-safe-accounting-v0.0",
        },
      }),
    },
    {
      name: "read failure",
      read: async () => {
        throw new Error("cache temporarily unreadable");
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let rebuilds = 0;
      const runner = createLocalCollectorRefreshRunner({
        selectAccountObservationSecret: () => ({
          loadAccountObservationSecret: null,
        }),
        runCollector: async () => ({
          rolloutRecordsWritten: 0,
          filesDiscovered: 0,
          refresh: {
            attempted: false,
            recordWritten: false,
            errorCode: null,
          },
        }),
        readAccountingCache: fixture.read,
        refreshAccounting: async () => {
          rebuilds += 1;
          return {
            generatedAt: "2026-07-23T12:00:00.000Z",
            periods: [{ id: "7d", events: 23 }],
            diagnostics: { forkReplayEventsExcluded: 31 },
          };
        },
      });

      const result = await runner();

      assert.equal(rebuilds, 1);
      assert.deepEqual(result.accounting, {
        status: "replay_safe",
        refreshStatus: "rebuilt",
        generatedAt: "2026-07-23T12:00:00.000Z",
        events: 23,
        forkReplayEventsExcluded: 31,
      });
    });
  }
});

test("a quota-only refresh reuses current accounting while retaining fresh quota evidence", async () => {
  let cacheReads = 0;
  let rebuilds = 0;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      refresh: { attempted: true, recordWritten: true, errorCode: null },
    }),
    readAccountingCache: async () => {
      cacheReads += 1;
      return {
        status: "available",
        errorCode: null,
        cache: REUSABLE_ACCOUNTING_CACHE,
      };
    },
    refreshAccounting: async () => {
      rebuilds += 1;
      throw new Error("quota-only collection must not rebuild token accounting");
    },
  });

  const result = await runner();

  assert.equal(cacheReads, 1);
  assert.equal(rebuilds, 0);
  assert.equal(result.accounting.refreshStatus, "reused");
  assert.deepEqual(result.quotaRefresh, {
    attempted: true,
    recordWritten: true,
    errorCode: null,
  });
});

test("a memory-budget rebuild miss serves the retained cache, reports deferred, and backs off", async () => {
  let nowMs = Date.parse("2026-07-23T12:00:00.000Z");
  const clock = () => nowMs;
  let rebuildAttempts = 0;
  let deferForNextRebuild = true;
  const runner = createLocalCollectorRefreshRunner({
    stateFile: "/private/state.sqlite",
    clock,
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      // New rollout usage: token accounting genuinely warrants a rebuild.
      rolloutRecordsWritten: 5,
      filesDiscovered: 3,
      refresh: { attempted: true, recordWritten: false, errorCode: null },
    }),
    readAccountingCache: async () => ({
      status: "available",
      errorCode: null,
      cache: REUSABLE_ACCOUNTING_CACHE,
    }),
    refreshAccounting: async () => {
      rebuildAttempts += 1;
      if (deferForNextRebuild) {
        return {
          status: "accounting_rebuild_deferred",
          reason: "accounting_transition_rss_limit_exceeded",
          retained: true,
          generatedAt: REUSABLE_ACCOUNTING_CACHE.generatedAt,
          coveredAt: REUSABLE_ACCOUNTING_CACHE.coveredAt,
        };
      }
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [{ id: "7d", events: 41 }],
        diagnostics: { forkReplayEventsExcluded: 3 },
      };
    },
  });

  // First pass: the rebuild is attempted, misses budget, and the retained
  // cache is served as a labelled "deferred" estimate — the refresh does NOT
  // fail.
  const first = await runner();
  assert.equal(rebuildAttempts, 1);
  assert.deepEqual(first.accounting, {
    status: "replay_safe",
    refreshStatus: "deferred",
    generatedAt: "2026-07-23T10:00:00.000Z",
    events: 17,
    forkReplayEventsExcluded: 29,
  });
  assert.deepEqual(first.accountingRebuildDeferred, {
    reason: "accounting_transition_rss_limit_exceeded",
    retained: true,
  });

  // Second pass a minute later, still within the backoff window: the doomed
  // full rebuild is skipped entirely and the retained cache is served again.
  nowMs += 60_000;
  const second = await runner();
  assert.equal(rebuildAttempts, 1);
  assert.equal(second.accounting.refreshStatus, "deferred");

  // Once the backoff elapses the full rebuild is re-attempted; now it fits and
  // succeeds, and the backoff is cleared so later passes rebuild immediately.
  nowMs += 31 * 60_000;
  deferForNextRebuild = false;
  const third = await runner();
  assert.equal(rebuildAttempts, 2);
  assert.equal(third.accounting.refreshStatus, "rebuilt");
  assert.equal(third.accounting.events, 41);
  assert.equal(third.accountingRebuildDeferred, undefined);

  const fourth = await runner();
  assert.equal(rebuildAttempts, 3);
  assert.equal(fourth.accounting.refreshStatus, "rebuilt");
});

test("a budget miss with no retained cache defers without fabricating an accounting block", async () => {
  const runner = createLocalCollectorRefreshRunner({
    stateFile: "/private/state.sqlite",
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      rolloutRecordsWritten: 5,
      filesDiscovered: 3,
      refresh: { attempted: true, recordWritten: false, errorCode: null },
    }),
    readAccountingCache: async () => ({
      status: "unavailable",
      errorCode: "cache_missing",
      cache: null,
    }),
    refreshAccounting: async () => ({
      status: "accounting_rebuild_deferred",
      reason: "accounting_transition_rss_limit_exceeded",
      retained: false,
      generatedAt: null,
      coveredAt: null,
    }),
  });

  const result = await runner();
  // No cache to serve -> no accounting block is invented, but the run still
  // succeeds and reports the deferred outcome honestly.
  assert.equal(result.accounting, undefined);
  assert.deepEqual(result.accountingRebuildDeferred, {
    reason: "accounting_transition_rss_limit_exceeded",
    retained: false,
  });
});

test("the deferred accounting rebuild recorder files one bounded, rate-limited note", async () => {
  const notes = [];
  let nowMs = 1_000;
  const record = createDeferredAccountingRebuildRecorder({
    recordNote: async (note) => { notes.push(note); },
    clock: () => nowMs,
    randomIndex: () => 0,
  });

  assert.equal(
    await record({
      reason: "accounting_transition_rss_limit_exceeded",
      retained: true,
    }),
    true,
  );
  assert.deepEqual(notes, [{
    reference: "TT-000000",
    surface: "local_refresh",
    code: "accounting_rebuild_deferred",
    requestId: "",
    step: "accounting",
    detail: "accounting_transition_rss_limit_exceeded",
  }]);

  // The same signature within the hour is suppressed so a backed-off scheduler
  // loop cannot become a write storm.
  assert.equal(
    await record({
      reason: "accounting_transition_rss_limit_exceeded",
      retained: true,
    }),
    false,
  );
  assert.equal(notes.length, 1);

  // An hour later the same signature lands again.
  nowMs += 60 * 60 * 1_000;
  assert.equal(
    await record({
      reason: "accounting_transition_rss_limit_exceeded",
      retained: true,
    }),
    true,
  );
  assert.equal(notes.length, 2);

  // A free-text reason is dropped rather than written; the note stays bounded.
  nowMs += 60 * 60 * 1_000;
  await record({ reason: "free text / with spaces", retained: true });
  assert.equal(notes.at(-1).detail, undefined);
});

test("the controller files a degraded note, not a terminal one, for a soft budget miss", async () => {
  let reloads = 0;
  let terminalCalls = 0;
  const degraded = [];
  const controller = new LocalCompanionRefreshController({
    runner: async () => ({
      rolloutRecordsWritten: 0,
      accountingRebuildDeferred: {
        reason: "accounting_transition_rss_limit_exceeded",
        retained: true,
      },
    }),
    dataStore: { async reload() { reloads += 1; } },
    onTerminalFailure: () => { terminalCalls += 1; },
    onDegradedOutcome: (outcome) => { degraded.push(outcome); },
  });

  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  // A budget miss is a SOFT success: the dashboard was reloaded (retained cache
  // served), no terminal failure was filed, and the degraded note fired once.
  assert.equal(status.status, "succeeded");
  assert.equal(status.errorCode, null);
  assert.equal(reloads, 1);
  assert.equal(terminalCalls, 0);
  assert.deepEqual(degraded, [{
    reason: "accounting_transition_rss_limit_exceeded",
    retained: true,
  }]);
  assert.deepEqual(status.result.accountingRebuildDeferred, {
    status: "deferred",
    reason: "accounting_transition_rss_limit_exceeded",
    retained: true,
  });
});

test("local refresh rebuilds when rollout usage changes or no definitive count is reported", async (t) => {
  const cases = [
    {
      name: "rollout record written",
      collector: {
        rolloutRecordsWritten: 1,
        refresh: { attempted: false, recordWritten: false, errorCode: null },
      },
    },
    {
      name: "rollout write count missing",
      collector: {
        refresh: { attempted: false, recordWritten: false, errorCode: null },
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let cacheReads = 0;
      let rebuilds = 0;
      const runner = createLocalCollectorRefreshRunner({
        selectAccountObservationSecret: () => ({
          loadAccountObservationSecret: null,
        }),
        runCollector: async () => fixture.collector,
        readAccountingCache: async () => {
          cacheReads += 1;
          return {
            status: "available",
            errorCode: null,
            cache: REUSABLE_ACCOUNTING_CACHE,
          };
        },
        refreshAccounting: async () => {
          rebuilds += 1;
          return {
            generatedAt: "2026-07-23T12:00:00.000Z",
            periods: [],
            diagnostics: {},
          };
        },
      });

      const result = await runner();

      assert.equal(cacheReads, 0);
      assert.equal(rebuilds, 1);
      assert.equal(result.accounting.refreshStatus, "rebuilt");
    });
  }
});

test("local refresh forwards its AbortSignal into replay-safe accounting", async () => {
  const controller = new AbortController();
  const clock = () => Date.parse("2026-07-23T12:00:00.000Z");
  let accountingOptions;
  const runner = createLocalCollectorRefreshRunner({
    codexHome: "/private/codex-home",
    stateFile: "/private/local-collector-state.sqlite",
    unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
    clock,
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: async () => Buffer.alloc(32, 8),
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 2,
      filesDiscovered: 3,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
      },
      indexing: COMPLETE_INDEX,
    }),
    refreshAccounting: async (options) => {
      accountingOptions = options;
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [{ id: "7d", events: 17 }],
        diagnostics: { forkReplayEventsExcluded: 29 },
      };
    },
  });

  const result = await runner({ signal: controller.signal });

  assert.equal(accountingOptions.codexHome, "/private/codex-home");
  assert.equal(accountingOptions.stateFile, "/private/local-collector-state.sqlite");
  assert.equal(accountingOptions.now, clock);
  // Re-pinned 93 -> 365 (2026-08-08): the standing owner rule forbids
  // convenience-sized history windows (31 and 93 were both wrong). The
  // calibration corpus no longer follows this window at all when the unified
  // index is present, so the rebuild also receives the index path.
  assert.equal(accountingOptions.windowDays, 365);
  assert.equal(
    accountingOptions.unifiedIndexFile,
    "/private/local-unified-index-v1.sqlite",
  );
  assert.equal(accountingOptions.signal, controller.signal);
  assert.deepEqual(result.accounting, {
    status: "replay_safe",
    refreshStatus: "rebuilt",
    generatedAt: "2026-07-23T12:00:00.000Z",
    events: 17,
    forkReplayEventsExcluded: 29,
  });
});

// The unified-index increment must land BEFORE the accounting rebuild: the
// rebuild sources its full-history calibration corpus from that index, so the
// old order left the calibration one refresh behind the collection it
// belonged to.
test("the unified index advances before accounting reads it for calibration", async () => {
  const order = [];
  const runner = createLocalCollectorRefreshRunner({
    unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
    unifiedIndexSecretFile: "/private/local-unified-index-device-salt-v1",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 1,
      filesDiscovered: 1,
      refresh: { attempted: true, recordWritten: true, errorCode: null },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: async (options) => {
      order.push(["unified_index", options.indexFile, options.secretFile]);
      return {
        status: "ingested",
        sources: 1,
        sourcesTouched: 1,
        insertedUsageEvents: 1,
        totalUsageEvents: 1,
        bytesScanned: 10,
        wallMs: 1,
      };
    },
    refreshAccounting: async () => {
      order.push(["accounting"]);
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [],
        diagnostics: {},
      };
    },
  });

  const result = await runner();

  assert.deepEqual(order.map(([step]) => step), ["unified_index", "accounting"]);
  assert.deepEqual(order[0].slice(1), [
    "/private/local-unified-index-v1.sqlite",
    "/private/local-unified-index-device-salt-v1",
  ]);
  assert.equal(result.unifiedIndex.status, "ingested");
  assert.equal(result.accounting.refreshStatus, "rebuilt");
});

test("an aborted zero-write refresh does not bypass accounting cancellation through reuse", async () => {
  const controller = new AbortController();
  controller.abort();
  let cacheReads = 0;
  let accountingSignal;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 3,
      refresh: {
        attempted: false,
        recordWritten: false,
        errorCode: null,
      },
    }),
    readAccountingCache: async () => {
      cacheReads += 1;
      return {
        status: "available",
        errorCode: null,
        cache: REUSABLE_ACCOUNTING_CACHE,
      };
    },
    refreshAccounting: async ({ signal }) => {
      accountingSignal = signal;
      const error = new Error("accounting_refresh_aborted");
      error.name = "AbortError";
      throw error;
    },
  });

  await assert.rejects(
    runner({ signal: controller.signal }),
    { name: "AbortError", message: "accounting_refresh_aborted" },
  );
  assert.equal(cacheReads, 0);
  assert.equal(accountingSignal, controller.signal);
});

test("local refresh publishes a quick-result boundary before deep accounting", async () => {
  const progress = [];
  let accountingStartedAfterQuickResult = false;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 2,
      filesDiscovered: 9,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
      },
      indexing: COMPLETE_INDEX,
    }),
    refreshAccounting: async () => {
      accountingStartedAfterQuickResult =
        progress.at(-1)?.phase === "quick_result";
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [{ id: "7d", events: 17 }],
        diagnostics: { forkReplayEventsExcluded: 29 },
      };
    },
  });

  const result = await runner({
    onProgress: async (value) => {
      progress.push(value);
    },
  });

  assert.equal(accountingStartedAfterQuickResult, true);
  assert.equal(progress.length, 1);
  assert.deepEqual(progress[0], {
    ...COMPLETE_INDEX,
    phase: "quick_result",
  });
  assert.equal(result.accounting.refreshStatus, "rebuilt");
});

test("partial recent coverage publishes a quick result before deep accounting", async () => {
  const progress = [];
  let rebuilds = 0;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 2,
      filesDiscovered: 9,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
      },
      indexing: PARTIAL_INDEX,
    }),
    refreshAccounting: async () => {
      rebuilds += 1;
      assert.equal(progress.at(-1)?.phase, "quick_result");
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [{ id: "7d", events: 17 }],
        diagnostics: { forkReplayEventsExcluded: 29 },
      };
    },
  });

  const result = await runner({
    onProgress: async (value) => {
      progress.push(value);
    },
  });

  assert.equal(rebuilds, 1);
  assert.deepEqual(progress, [{
    ...PARTIAL_INDEX,
    phase: "quick_result",
  }]);
  assert.deepEqual(result.indexing, PARTIAL_INDEX);
  assert.equal(result.accounting.refreshStatus, "rebuilt");
});

test("an early bounded pass publishes a useful headline before the normal continuation completes", async () => {
  let releaseContinuation;
  const continuationGate = new Promise((resolve) => {
    releaseContinuation = resolve;
  });
  let resolveHeadline;
  const headlineSeen = new Promise((resolve) => {
    resolveHeadline = resolve;
  });
  const collectorOptions = [];
  const progress = [];
  let accountingStarted = false;
  const earlyPausedIndex = {
    ...PAUSED_INDEX,
    filesProcessed: 1,
    recordsWritten: 2,
  };
  const completedIndex = {
    ...COMPLETE_INDEX,
    recordsWritten: 12,
  };
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async (options) => {
      collectorOptions.push(options);
      if (collectorOptions.length === 1) {
        return {
          rolloutRecordsWritten: 2,
          filesDiscovered: 9,
          resourceLimit: {
            code: "collector_resource_source_bytes_limit_exceeded",
            dimension: "source_bytes",
            limit: 128 * 1024 * 1024,
            observed: 128 * 1024 * 1024 + 1,
          },
          refresh: {
            attempted: true,
            recordWritten: true,
            errorCode: null,
          },
          indexing: earlyPausedIndex,
        };
      }
      await continuationGate;
      return {
        rolloutRecordsWritten: 10,
        filesDiscovered: 9,
        refresh: {
          attempted: false,
          recordWritten: false,
          errorCode: null,
        },
        indexing: completedIndex,
      };
    },
    refreshAccounting: async () => {
      accountingStarted = true;
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [{ id: "7d", events: 17 }],
        diagnostics: { forkReplayEventsExcluded: 29 },
      };
    },
  });

  const pending = runner({
    onProgress: async (value) => {
      progress.push(value);
      if (value.phase === "quick_result") resolveHeadline();
    },
  });
  await headlineSeen;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(collectorOptions.length, 2);
  assert.equal(
    collectorOptions[0].maximumRecentRunBytes,
    128 * 1024 * 1024,
  );
  assert.equal(
    collectorOptions[0].maximumRecentTailBytes,
    4 * 1024 * 1024,
  );
  assert.equal(
    collectorOptions[0].maximumRecentPreludeBytes,
    512 * 1024,
  );
  assert.equal(
    collectorOptions[0].maximumBufferedLineBytes,
    1024 * 1024,
  );
  assert.equal(
    Object.hasOwn(collectorOptions[1], "maximumRecentRunBytes"),
    false,
  );
  assert.equal(
    Object.hasOwn(collectorOptions[1], "maximumRecentTailBytes"),
    false,
  );
  assert.equal(
    Object.hasOwn(collectorOptions[1], "maximumRecentPreludeBytes"),
    false,
  );
  assert.equal(
    collectorOptions[1].maximumBufferedLineBytes,
    16 * 1024 * 1024,
  );
  assert.deepEqual(progress, [{
    ...earlyPausedIndex,
    phase: "quick_result",
  }]);
  assert.equal(accountingStarted, false);

  releaseContinuation();
  const result = await pending;

  assert.equal(accountingStarted, true);
  assert.equal(result.rolloutRecordsWritten, 12);
  assert.deepEqual(result.quotaRefresh, {
    attempted: true,
    recordWritten: true,
    errorCode: null,
  });
  assert.deepEqual(result.indexing, completedIndex);
  assert.equal(result.accounting.refreshStatus, "rebuilt");
});

test("a hard collector resource pause stops automatic continuation and preserves its headline", async () => {
  let collectorCalls = 0;
  let accountingCalls = 0;
  const progress = [];
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => {
      collectorCalls += 1;
      return {
        rolloutRecordsWritten: 0,
        filesDiscovered: 20_000,
        resourceLimit: {
          code: "collector_resource_directory_entries_limit_exceeded",
          dimension: "directory_entries",
          limit: 20_000,
          observed: 20_001,
        },
        refresh: {
          attempted: false,
          recordWritten: false,
          errorCode: null,
        },
        indexing: PAUSED_INDEX,
      };
    },
    refreshAccounting: async () => {
      accountingCalls += 1;
      throw new Error("resource-limited collection must not start accounting");
    },
  });

  await assert.rejects(
    runner({
      onProgress: async (value) => {
        progress.push(value);
      },
    }),
    (error) => error?.code === "collector_resource_limit_exceeded",
  );
  assert.equal(collectorCalls, 1);
  assert.equal(accountingCalls, 0);
  assert.deepEqual(progress, [{
    ...PAUSED_INDEX,
    phase: "quick_result",
  }]);
});

test("the reviewed normal-pass byte ceiling stops after one early headline continuation", async () => {
  let collectorCalls = 0;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => {
      collectorCalls += 1;
      const limit = collectorCalls === 1
        ? 128 * 1024 * 1024
        : 1_500 * 1024 * 1024;
      return {
        rolloutRecordsWritten: 0,
        filesDiscovered: 9,
        resourceLimit: {
          code: "collector_resource_source_bytes_limit_exceeded",
          dimension: "source_bytes",
          limit,
          observed: limit + 1,
        },
        refresh: {
          attempted: false,
          recordWritten: false,
          errorCode: null,
        },
        indexing: PAUSED_INDEX,
      };
    },
  });

  await assert.rejects(
    runner(),
    (error) => error?.code === "collector_resource_limit_exceeded",
  );
  assert.equal(collectorCalls, 2);
});

test("a bounded continuation keeps the early headline and skips deep accounting", async () => {
  let cacheReads = 0;
  let rebuilds = 0;
  const progress = [];
  const collectorOptions = [];
  const earlyPausedIndex = {
    ...PAUSED_INDEX,
    filesProcessed: 1,
    recordsWritten: 2,
  };
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async (options) => {
      collectorOptions.push(options);
      return collectorOptions.length === 1
        ? {
          rolloutRecordsWritten: 2,
          filesDiscovered: 9,
          refresh: {
            attempted: true,
            recordWritten: true,
            errorCode: null,
          },
          indexing: earlyPausedIndex,
        }
        : {
          rolloutRecordsWritten: 3,
          filesDiscovered: 9,
          refresh: {
            attempted: false,
            recordWritten: false,
            errorCode: null,
          },
          indexing: PAUSED_INDEX,
        };
    },
    readAccountingCache: async () => {
      cacheReads += 1;
      return {
        status: "available",
        errorCode: null,
        cache: REUSABLE_ACCOUNTING_CACHE,
      };
    },
    refreshAccounting: async () => {
      rebuilds += 1;
      throw new Error("bounded pause must not launch deep accounting");
    },
  });

  const result = await runner({
    onProgress: async (value) => {
      progress.push(value);
    },
  });

  assert.equal(cacheReads, 0);
  assert.equal(rebuilds, 0);
  assert.equal(collectorOptions.length, 2);
  assert.equal(
    collectorOptions[0].maximumRecentRunBytes,
    128 * 1024 * 1024,
  );
  assert.equal(
    collectorOptions[0].maximumRecentTailBytes,
    4 * 1024 * 1024,
  );
  assert.equal(
    collectorOptions[0].maximumRecentPreludeBytes,
    512 * 1024,
  );
  assert.equal(
    collectorOptions[0].maximumBufferedLineBytes,
    1024 * 1024,
  );
  assert.equal(
    Object.hasOwn(collectorOptions[1], "maximumRecentRunBytes"),
    false,
  );
  assert.equal(
    Object.hasOwn(collectorOptions[1], "maximumRecentTailBytes"),
    false,
  );
  assert.equal(
    Object.hasOwn(collectorOptions[1], "maximumRecentPreludeBytes"),
    false,
  );
  assert.equal(
    collectorOptions[1].maximumBufferedLineBytes,
    16 * 1024 * 1024,
  );
  assert.deepEqual(progress, [{
    ...earlyPausedIndex,
    phase: "quick_result",
  }]);
  assert.equal(result.rolloutRecordsWritten, 5);
  assert.deepEqual(result.quotaRefresh, {
    attempted: true,
    recordWritten: true,
    errorCode: null,
  });
  assert.deepEqual(result.indexing, PAUSED_INDEX);
  assert.equal("accounting" in result, false);
});

test("two-pass merging never manufactures a definitive zero-write report", async () => {
  let collectorCalls = 0;
  let cacheReads = 0;
  let rebuilds = 0;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => {
      collectorCalls += 1;
      return collectorCalls === 1
        ? {
          rolloutRecordsWritten: 0,
          filesDiscovered: 9,
          refresh: {
            attempted: false,
            recordWritten: false,
            errorCode: null,
          },
          indexing: PAUSED_INDEX,
        }
        : {
          filesDiscovered: 9,
          refresh: {
            attempted: false,
            errorCode: null,
          },
          indexing: COMPLETE_INDEX,
        };
    },
    readAccountingCache: async () => {
      cacheReads += 1;
      return {
        status: "available",
        errorCode: null,
        cache: REUSABLE_ACCOUNTING_CACHE,
      };
    },
    refreshAccounting: async () => {
      rebuilds += 1;
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [],
        diagnostics: {},
      };
    },
  });

  const result = await runner();

  assert.equal(collectorCalls, 2);
  assert.equal(cacheReads, 0);
  assert.equal(rebuilds, 1);
  assert.equal(result.accounting.refreshStatus, "rebuilt");
});

test("cancellation after the early headline does not start the normal continuation", async () => {
  const controller = new AbortController();
  let collectorCalls = 0;
  let accountingCalls = 0;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async ({ signal }) => {
      collectorCalls += 1;
      assert.equal(signal, controller.signal);
      return {
        rolloutRecordsWritten: 2,
        filesDiscovered: 9,
        refresh: {
          attempted: true,
          recordWritten: true,
          errorCode: null,
        },
        indexing: {
          ...PAUSED_INDEX,
          filesProcessed: 1,
          recordsWritten: 2,
        },
      };
    },
    refreshAccounting: async () => {
      accountingCalls += 1;
      throw new Error("cancelled headline must not start deep accounting");
    },
  });

  const result = await runner({
    signal: controller.signal,
    onProgress: async (value) => {
      if (value.phase === "quick_result") controller.abort();
    },
  });

  assert.equal(collectorCalls, 1);
  assert.equal(accountingCalls, 0);
  assert.equal(result.indexing.status, "bounded_pause");
  assert.equal(result.quotaRefresh.recordWritten, true);
});

test("refresh controller reloads a quick result while deep accounting continues", async () => {
  let reloads = 0;
  let releaseAccounting;
  const accountingGate = new Promise((resolve) => {
    releaseAccounting = resolve;
  });
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      await onProgress({
        ...COMPLETE_INDEX,
        phase: "quick_result",
      });
      await accountingGate;
      return {
        rolloutRecordsWritten: 7,
        filesDiscovered: 9,
        quotaRefresh: {
          attempted: true,
          recordWritten: true,
          errorCode: null,
        },
        accounting: {
          status: "replay_safe",
          refreshStatus: "rebuilt",
          generatedAt: "2026-07-23T11:45:00.000Z",
          events: 17,
          forkReplayEventsExcluded: 29,
        },
        indexing: COMPLETE_INDEX,
      };
    },
    dataStore: {
      async reload() {
        reloads += 1;
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().quickResultAt !== null) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const quick = controller.getStatus();
  assert.equal(quick.status, "running");
  assert.equal(quick.progress.phase, "quick_result");
  assert.equal(quick.quickResultAt, "2026-07-23T12:00:00.000Z");
  assert.equal(reloads, 1);

  releaseAccounting();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.getStatus().status, "succeeded");
  assert.equal(reloads, 2);
});

test("refresh controller keeps a bounded-pause headline observable after the pass settles", async () => {
  let reloads = 0;
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      await onProgress({
        ...PAUSED_INDEX,
        phase: "quick_result",
      });
      return {
        rolloutRecordsWritten: 5,
        filesDiscovered: 9,
        quotaRefresh: {
          attempted: true,
          recordWritten: true,
          errorCode: null,
        },
        indexing: PAUSED_INDEX,
      };
    },
    dataStore: {
      async reload() {
        reloads += 1;
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  assert.equal(status.status, "succeeded");
  assert.equal(status.quickResultAt, "2026-07-23T12:00:00.000Z");
  assert.equal(status.progress.status, "bounded_pause");
  assert.equal(status.progress.phase, "quick_result");
  assert.equal(status.result.indexing.phase, "paused");
  assert.equal(reloads, 2);
});

test("refresh controller cancels bounded work and preserves safe progress", async () => {
  let observedAbort = false;
  let reloads = 0;
  const controller = new LocalCompanionRefreshController({
    runner: ({ signal, onProgress }) => new Promise((resolve) => {
      onProgress({
        ...COMPLETE_INDEX,
        status: "recent_7d_indexing",
        phase: "rollout_index",
        filesProcessed: 1,
        recordsWritten: 2,
        coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
      });
      signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve({
          indexing: {
            ...COMPLETE_INDEX,
            status: "bounded_pause",
            phase: "paused",
            filesProcessed: 1,
            recordsWritten: 2,
            coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
          },
        });
      }, { once: true });
    }),
    dataStore: {
      async reload() {
        reloads += 1;
      },
    },
  });

  assert.equal(controller.start(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.cancel(), true);
  assert.equal(controller.cancel(), false);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "cancelled") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  assert.equal(observedAbort, true);
  assert.equal(status.status, "cancelled");
  assert.equal(status.errorCode, "refresh_cancelled");
  assert.equal(status.progress.status, "bounded_pause");
  assert.equal(status.progress.recordsWritten, 2);
  assert.equal(reloads, 1);
  assert.equal(controller.cancel(), false);
});

test("refresh controller publishes bounded progress and reloads after success", async () => {
  let reloads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      onProgress({
        ...COMPLETE_INDEX,
        status: "recent_7d_indexing",
        phase: "rollout_index",
        filesProcessed: 2,
        recordsWritten: 5,
        coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
      });
      await gate;
      return {
        rolloutRecordsWritten: 7,
        filesDiscovered: 9,
        quotaRefresh: {
          attempted: true,
          recordWritten: false,
          errorCode: "temporary_disconnect",
        },
        accounting: {
          status: "replay_safe",
          refreshStatus: "reused",
          generatedAt: "2026-07-23T11:45:00.000Z",
          events: 17,
          forkReplayEventsExcluded: 29,
        },
        indexing: COMPLETE_INDEX,
      };
    },
    dataStore: {
      async reload() {
        reloads += 1;
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getStatus().status, "running");
  assert.equal(controller.getStatus().progress.status, "recent_7d_indexing");
  release();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  assert.equal(status.status, "succeeded");
  assert.equal(status.progress.status, "recent_7d_complete");
  assert.deepEqual(status.result.indexing, COMPLETE_INDEX);
  assert.deepEqual(status.result.accounting, {
    status: "replay_safe",
    refreshStatus: "reused",
    generatedAt: "2026-07-23T11:45:00.000Z",
    events: 17,
    forkReplayEventsExcluded: 29,
  });
  assert.equal(reloads, 1);
});

test("refresh controller projects a fixed safety-limit state while retaining the quick result", async () => {
  let reloads = 0;
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      await onProgress({
        ...COMPLETE_INDEX,
        phase: "quick_result",
      });
      const error = new Error("private resource detail");
      error.code = "accounting_scan_source_bytes_limit_exceeded";
      throw error;
    },
    dataStore: {
      async reload() {
        reloads += 1;
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "failed") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "refresh_resource_limited");
  assert.equal(status.progress.phase, "quick_result");
  assert.equal(status.quickResultAt, "2026-07-23T12:00:00.000Z");
  assert.equal(JSON.stringify(status).includes("private resource detail"), false);
  assert.equal(reloads, 1);
});

test("refresh controller reloads archive progress after the collector limit settles", async () => {
  let reloads = 0;
  const controller = new LocalCompanionRefreshController({
    runner: async () => {
      const error = new Error("collector limit");
      error.code = "collector_resource_limit_exceeded";
      throw error;
    },
    dataStore: {
      async reload() {
        reloads += 1;
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "failed") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(controller.getStatus().status, "failed");
  assert.equal(controller.getStatus().errorCode, "refresh_resource_limited");
  assert.equal(reloads, 1);
});

test("refresh controller classifies transition-derivation limits as fixed safety stops", async () => {
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      await onProgress({
        ...COMPLETE_INDEX,
        phase: "quick_result",
      });
      const error = new Error("private transition detail");
      error.code = "accounting_transition_rss_limit_exceeded";
      throw error;
    },
    dataStore: {
      async reload() {},
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "failed") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "refresh_resource_limited");
  assert.equal(status.progress.phase, "quick_result");
  assert.equal(status.quickResultAt, "2026-07-23T12:00:00.000Z");
  assert.equal(JSON.stringify(status).includes("private transition detail"), false);
});

test("refresh timeout aborts collector work and retains only safe progress", async () => {
  let observedAbort = false;
  let reloads = 0;
  const controller = new LocalCompanionRefreshController({
    runner: ({ signal, onProgress }) => new Promise((resolve) => {
      onProgress({
        ...COMPLETE_INDEX,
        status: "recent_7d_indexing",
        phase: "rollout_index",
        filesProcessed: 1,
        recordsWritten: 2,
        coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
      });
      signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve({
          indexing: {
            ...COMPLETE_INDEX,
            status: "bounded_pause",
            phase: "paused",
            filesProcessed: 1,
            recordsWritten: 2,
            coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
          },
        });
      }, { once: true });
    }),
    dataStore: {
      async reload() {
        reloads += 1;
      },
    },
    timeoutMs: 1_000,
  });

  assert.equal(controller.start(), true);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  const status = controller.getStatus();
  assert.equal(observedAbort, true);
  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "refresh_timed_out");
  assert.equal(status.progress.status, "bounded_pause");
  assert.equal(status.progress.recordsWritten, 2);
  assert.equal(status.result.indexing.status, "bounded_pause");
  assert.equal(reloads, 1);
  assert.equal(JSON.stringify(status).includes("/private/"), false);
});

test("a timed-out refresh cannot be reclassified as user-cancelled while settling", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      await onProgress({
        ...COMPLETE_INDEX,
        status: "recent_7d_indexing",
        phase: "rollout_index",
        filesProcessed: 1,
        recordsWritten: 2,
        coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
      });
      await gate;
      return { indexing: PAUSED_INDEX };
    },
    dataStore: {
      async reload() {},
    },
    timeoutMs: 1_000,
  });

  assert.equal(controller.start(), true);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(controller.getStatus().status, "failed");
  assert.equal(controller.getStatus().errorCode, "refresh_timed_out");
  assert.equal(controller.isRunning(), true);
  assert.equal(controller.cancel(), false);

  release();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!controller.isRunning()) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.getStatus().status, "failed");
  assert.equal(controller.getStatus().errorCode, "refresh_timed_out");
});

test("terminal refresh failures invoke the failure observer with bounded identity only", async () => {
  const observed = [];
  const failing = new LocalCompanionRefreshController({
    runner: async () => {
      const error = new Error("private failure detail /Users/private");
      error.code = "accounting_transition_rss_limit_exceeded";
      error.refreshStep = "accounting";
      throw error;
    },
    dataStore: {
      async reload() {},
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
    onTerminalFailure: (failure) => {
      observed.push(failure);
    },
  });

  assert.equal(failing.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (failing.getStatus().status === "failed") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, [{
    errorCode: "refresh_resource_limited",
    failedStep: "accounting",
    failureCode: "accounting_transition_rss_limit_exceeded",
  }]);
  assert.equal(
    JSON.stringify(observed).includes("private failure detail"),
    false,
  );

  // Success never reaches the observer.
  const succeeded = [];
  const succeeding = new LocalCompanionRefreshController({
    runner: async () => ({}),
    dataStore: {
      async reload() {},
    },
    onTerminalFailure: (failure) => {
      succeeded.push(failure);
    },
  });
  assert.equal(succeeding.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!succeeding.isRunning()) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(succeeding.getStatus().status, "succeeded");
  assert.deepEqual(succeeded, []);

  // Cancellation is a user action, not a failure: no entry.
  const cancelled = [];
  const cancelling = new LocalCompanionRefreshController({
    runner: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
    dataStore: {
      async reload() {},
    },
    onTerminalFailure: (failure) => {
      cancelled.push(failure);
    },
  });
  assert.equal(cancelling.start(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelling.cancel(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!cancelling.isRunning()) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(cancelling.getStatus().status, "cancelled");
  assert.deepEqual(cancelled, []);
});

test("a timed-out refresh files exactly one terminal failure entry, even after settling", async () => {
  const observed = [];
  const controller = new LocalCompanionRefreshController({
    runner: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        resolve({ indexing: PAUSED_INDEX });
      }, { once: true });
    }),
    dataStore: {
      async reload() {},
    },
    timeoutMs: 1_000,
    onTerminalFailure: (failure) => {
      observed.push(failure);
    },
  });

  assert.equal(controller.start(), true);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(controller.getStatus().status, "failed");
  assert.equal(controller.getStatus().errorCode, "refresh_timed_out");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!controller.isRunning()) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  // The timer filed the entry the moment the failure became terminal; the
  // later settlement of the same run must not file a second one.
  assert.deepEqual(observed, [{ errorCode: "refresh_timed_out" }]);
});

test("terminal refresh failure notes are bounded, step-stamped, and rate-limited per signature", async () => {
  const notes = [];
  let nowMs = Date.parse("2026-08-11T09:00:00.000Z");
  let nextSymbol = 0;
  const record = createTerminalRefreshFailureRecorder({
    recordNote: (note) => {
      notes.push(note);
    },
    clock: () => nowMs,
    randomIndex: (bound) => {
      nextSymbol = (nextSymbol + 7) % bound;
      return nextSymbol;
    },
  });

  const resourceLimited = {
    errorCode: "refresh_resource_limited",
    failedStep: "accounting",
    failureCode: "accounting_transition_rss_limit_exceeded",
  };
  assert.equal(await record(resourceLimited), true);
  assert.equal(notes.length, 1);
  assert.match(notes[0].reference, /^TT-[0-9A-HJKMNP-TV-Z]{6}$/u);
  assert.deepEqual({ ...notes[0], reference: null }, {
    reference: null,
    surface: "local_refresh",
    code: "refresh_resource_limited",
    requestId: "",
    step: "accounting",
    detail: "accounting_transition_rss_limit_exceeded",
  });

  // The incident cadence: the identical signature every five minutes must
  // collapse to the one existing line for a full hour.
  for (let minutes = 5; minutes < 60; minutes += 5) {
    nowMs += 5 * 60_000;
    assert.equal(await record(resourceLimited), false);
  }
  assert.equal(notes.length, 1);

  // A genuinely different signature is never suppressed.
  nowMs += 60_000;
  assert.equal(await record({
    errorCode: "refresh_failed",
    failedStep: "unified_index",
    failureCode: "local_unified_index_refresh_failed",
  }), true);
  assert.equal(notes.length, 2);
  assert.deepEqual({ ...notes[1], reference: null }, {
    reference: null,
    surface: "local_refresh",
    code: "refresh_failed",
    requestId: "",
    step: "unified_index",
    detail: "local_unified_index_refresh_failed",
  });

  // After the hour the original signature files again.
  nowMs += 60 * 60_000;
  assert.equal(await record(resourceLimited), true);
  assert.equal(notes.length, 3);

  // A timeout carries no step or underlying code: nothing invented.
  assert.equal(await record({ errorCode: "refresh_timed_out" }), true);
  assert.deepEqual({ ...notes[3], reference: null }, {
    reference: null,
    surface: "local_refresh",
    code: "refresh_timed_out",
    requestId: "",
  });

  // Malformed identity collapses to bounded fixed codes, never free text.
  assert.equal(await record({
    errorCode: "Failed reading /Users/private/state.json",
    failedStep: "not_a_step",
    failureCode: "free text with spaces",
  }), true);
  assert.deepEqual({ ...notes[4], reference: null }, {
    reference: null,
    surface: "local_refresh",
    code: "refresh_failed",
    requestId: "",
  });
  assert.equal(JSON.stringify(notes).includes("/Users/private"), false);
});

test("a failing diagnostics writer is contained and cannot become a write storm", async () => {
  let attempts = 0;
  let nowMs = Date.parse("2026-08-11T09:00:00.000Z");
  const record = createTerminalRefreshFailureRecorder({
    recordNote: () => {
      attempts += 1;
      throw new Error("disk full");
    },
    clock: () => nowMs,
  });

  const failure = {
    errorCode: "refresh_resource_limited",
    failedStep: "accounting",
    failureCode: "accounting_transition_rss_limit_exceeded",
  };
  assert.equal(await record(failure), false);
  assert.equal(attempts, 1);
  // The rate-limit stamp survives the failed write: a broken log costs this
  // hour's line rather than one write attempt per failure-loop tick.
  nowMs += 5 * 60_000;
  assert.equal(await record(failure), false);
  assert.equal(attempts, 1);
});

test("Claude quota refresh runs independently beside the Codex collector", async () => {
  let releaseCollector;
  const collectorGate = new Promise((resolve) => { releaseCollector = resolve; });
  let markClaudeStarted;
  const claudeStarted = new Promise((resolve) => { markClaudeStarted = resolve; });
  let claudeOptions;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => {
      await collectorGate;
      return {
        rolloutRecordsWritten: 0,
        filesDiscovered: 0,
        refresh: { attempted: false, recordWritten: false, errorCode: null },
      };
    },
    refreshClaudeQuota: async (options) => {
      claudeOptions = options;
      markClaudeStarted();
      return {
        provider: "anthropic_claude_code",
        authority: "claude_desktop_plan_history",
        status: "available",
        source: { status: "present", lastSuccessAtMs: 1784895000000 },
        freshness: "fresh",
        coverage: { state: "complete", gapCount: 0 },
        counts: { observations: 8, points: 7, accounts: 2, meters: 4, unknownMeters: 1 },
        windows: [{
          meterId: "five_hour",
          utilizationPercent: 3,
          remainingPercent: 97,
          observedAtMs: 1784894520000,
          resetsAtMs: null,
          windowDurationMinutes: 300,
        }],
      };
    },
  });

  const running = runner({ signal: null });
  await claudeStarted;
  assert.deepEqual(Object.keys(claudeOptions), ["signal"]);
  releaseCollector();
  const result = await running;
  assert.equal(result.claudeQuota.status, "available");
  assert.equal(result.claudeQuota.counts.unknownMeters, 1);
  assert.equal(result.claudeQuota.includesContent, false);
  assert.equal(result.claudeQuota.includesPaths, false);
  assert.equal(result.claudeQuota.includesIdentifiers, false);
  assert.equal(JSON.stringify(result.claudeQuota).includes("sourceKey"), false);
});

test("Claude quota failure cannot fail or leak into the Codex refresh", async () => {
  const privateCanary = "/Users/private/Claude/plan-usage-history.json";
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      rolloutRecordsWritten: 2,
      filesDiscovered: 1,
      refresh: { attempted: true, recordWritten: true, errorCode: null },
    }),
    refreshClaudeQuota: async () => {
      throw new Error(privateCanary);
    },
  });
  const result = await runner();
  assert.equal(result.rolloutRecordsWritten, 2);
  assert.deepEqual(result.claudeQuota, {
    schemaVersion: "local-claude-quota-v0.1",
    provider: "anthropic_claude_code",
    authority: "claude_desktop_plan_history",
    status: "failed",
    errorCode: "claude_quota_refresh_failed",
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
  });
  assert.equal(JSON.stringify(result).includes(privateCanary), false);
});

test("an aborted refresh does not wait for a non-cooperating Claude quota callback", async () => {
  const controller = new AbortController();
  let markClaudeStarted;
  const claudeStarted = new Promise((resolve) => { markClaudeStarted = resolve; });
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: { attempted: false, recordWritten: false, errorCode: null },
    }),
    refreshClaudeQuota: async () => {
      markClaudeStarted();
      return new Promise(() => {});
    },
  });
  const running = runner({ signal: controller.signal });
  await claudeStarted;
  controller.abort();
  const result = await running;
  assert.equal(result.claudeQuota.status, "failed");
  assert.equal(result.claudeQuota.errorCode, "claude_quota_refresh_failed");
});

test("Claude usage shadow runs independently without becoming a public refresh field", async () => {
  let releaseCollector;
  const collectorGate = new Promise((resolve) => { releaseCollector = resolve; });
  let markShadowStarted;
  const shadowStarted = new Promise((resolve) => { markShadowStarted = resolve; });
  let shadowOptions;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => {
      await collectorGate;
      return {
        rolloutRecordsWritten: 0,
        filesDiscovered: 0,
        refresh: { attempted: false, recordWritten: false, errorCode: null },
      };
    },
    refreshClaudeUsageShadow: async (options) => {
      shadowOptions = options;
      markShadowStarted();
      return {
        status: "completed",
        privateCanary: "/Users/private/.claude/projects/secret.jsonl",
      };
    },
  });

  const running = runner();
  await shadowStarted;
  assert.deepEqual(Object.keys(shadowOptions), ["signal"]);
  releaseCollector();
  const result = await running;
  assert.equal(Object.hasOwn(result, "claudeShadow"), false);
  assert.equal(JSON.stringify(result).includes("privateCanary"), false);
  assert.equal(JSON.stringify(result).includes("secret.jsonl"), false);
});

test("Claude usage shadow failure is contained and abort releases a non-cooperating callback", async () => {
  const baseOptions = {
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      rolloutRecordsWritten: 1,
      filesDiscovered: 1,
      refresh: { attempted: true, recordWritten: true, errorCode: null },
    }),
  };
  const failed = createLocalCollectorRefreshRunner({
    ...baseOptions,
    refreshClaudeUsageShadow: async () => {
      throw new Error("private shadow failure");
    },
  });
  assert.equal((await failed()).rolloutRecordsWritten, 1);

  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const hanging = createLocalCollectorRefreshRunner({
    ...baseOptions,
    refreshClaudeUsageShadow: async () => {
      markStarted();
      return new Promise(() => {});
    },
  });
  const running = hanging({ signal: controller.signal });
  await started;
  controller.abort();
  const result = await running;
  assert.equal(result.rolloutRecordsWritten, 1);
  assert.equal(Object.hasOwn(result, "claudeShadow"), false);
});
