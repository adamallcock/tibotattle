import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  isAuthoritativeDashboardSnapshot,
  readAuthoritativeDashboardSnapshot,
  writeAuthoritativeDashboardSnapshot,
} from "../src/local-authoritative-dashboard-snapshot.js";
import {
  LOCAL_COMPANION_SCHEMA_VERSION,
  LocalCompanionDataStore,
  RETAINED_EVIDENCE_REFRESH_WARNING,
  RETAINED_EVIDENCE_RELABELED_WARNINGS,
} from "../src/local-companion-data.js";

const TOOL_WARNING =
  "Usage accounting is complete, but typed tool history is partial. Tool totals are withheld rather than reported as zero.";
const TOOL_KEYS = [
  "apply_patch",
  "local_shell",
  "other",
  "subagent",
  "tool_gateway",
];

function authoritativeSnapshot({ toolHistoryPartial = false } = {}) {
  const tools = toolHistoryPartial
    ? {
      status: "unavailable",
      reason: "typed_tool_history_partial",
      total: null,
      counts: Object.fromEntries(TOOL_KEYS.map((key) => [key, null])),
    }
    : {
      total: 4,
      counts: {
        apply_patch: 1,
        local_shell: 1,
        other: 0,
        subagent: 1,
        tool_gateway: 1,
      },
    };
  return {
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: "2026-08-27T12:00:00.000Z",
    overview: {
      warnings: toolHistoryPartial ? [TOOL_WARNING] : [],
      activity: {
        usageEvents: 12,
        totalTokens: 1_234,
        toolEvents: toolHistoryPartial ? null : 4,
      },
      tools,
      usage: [{
        id: "7d",
        label: "Last 7 days",
        events: 12,
        totalTokens: 1_234,
        apiPriceEquivalentUsd: 1.25,
      }],
      timeline: {
        usage: [{ at: "2026-08-27T11:00:00.000Z", events: 12 }],
        history: toolHistoryPartial
          ? { status: "partial", reason: "typed_tool_history_partial" }
          : { status: "complete" },
      },
      accounting: {
        projection: {
          status: "available",
          reason: null,
          terminal: false,
          retainedAt: null,
          coveredAt: null,
        },
        sourceMode: "unified",
        generation: 17,
        generationFingerprint: "generation-fingerprint-17",
        generationMatched: true,
        sourceCoverageStatus: "complete",
        accountingCacheStatus: "available",
        historyCoverage: {
          status: "complete",
          phase: "complete",
        },
        toolClasses: structuredClone(tools),
        periodId: "7d",
        periodLabel: "Last 7 days",
        events: 12,
        totalTokens: 1_234,
        apiPriceEquivalentUsd: 1.25,
        byModel: [{ model: "gpt-5.4", events: 12 }],
        periods: [{
          periodId: "7d",
          periodLabel: "Last 7 days",
          events: 12,
          totalTokens: 1_234,
          apiPriceEquivalentUsd: 1.25,
        }],
      },
    },
    gradient: { datasets: { rolling: [{ at: 1 }] } },
    weekly: { datasets: { weekly_values: [{ sequence: 1 }] } },
    quality: {},
  };
}

test("authoritative snapshot keys match the production companion projection", () => {
  const snapshot = authoritativeSnapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "generatedAt",
    "gradient",
    "mode",
    "overview",
    "quality",
    "schemaVersion",
    "weekly",
  ]);
  assert.equal(isAuthoritativeDashboardSnapshot(snapshot), true);
});

function unavailableSnapshot() {
  const snapshot = authoritativeSnapshot();
  snapshot.generatedAt = "2026-08-27T12:05:00.000Z";
  snapshot.overview.warnings = [
    "This local history was created by a newer TiboTattle build. This build cannot refresh its usage totals or timelines; install a compatible newer build. The retained local history has not been deleted.",
  ];
  snapshot.overview.usage = [{
    id: "7d",
    label: "Last 7 days",
    events: 0,
    totalTokens: 0,
    apiPriceEquivalentUsd: 0,
  }];
  snapshot.overview.timeline.usage = [];
  snapshot.overview.timeline.history = {
    status: "unavailable",
    reason: "local_unified_index_schema_newer",
  };
  snapshot.overview.accounting = {
    ...snapshot.overview.accounting,
    projection: {
      status: "unavailable",
      reason: "local_unified_index_schema_newer",
      terminal: true,
      retainedAt: null,
      coveredAt: null,
    },
    generationMatched: false,
    accountingCacheStatus: "unavailable",
    events: 0,
    totalTokens: 0,
    apiPriceEquivalentUsd: 0,
    byModel: [],
    periods: [{
      periodId: "7d",
      periodLabel: "Last 7 days",
      events: 0,
      totalTokens: 0,
      apiPriceEquivalentUsd: 0,
    }],
  };
  snapshot.gradient = { datasets: { rolling: [] } };
  snapshot.weekly = { datasets: { weekly_values: [] } };
  return snapshot;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "authoritative-dashboard-"));
  return {
    root,
    snapshotFile: join(root, "private", "dashboard-v1.json"),
  };
}

test("authoritative dashboard snapshots round-trip atomically as owner-only state", async () => {
  const files = await fixture();
  try {
    const snapshot = authoritativeSnapshot();
    assert.equal(isAuthoritativeDashboardSnapshot(snapshot), true);
    assert.equal(await writeAuthoritativeDashboardSnapshot({
      snapshotFile: files.snapshotFile,
      snapshot,
      now: () => Date.parse("2026-08-27T12:01:00.000Z"),
    }), true);
    const retained = await readAuthoritativeDashboardSnapshot({
      snapshotFile: files.snapshotFile,
    });
    assert.deepEqual(retained, {
      savedAt: "2026-08-27T12:01:00.000Z",
      snapshot,
    });
    if (process.platform !== "win32") {
      assert.equal((await lstat(files.snapshotFile)).mode & 0o777, 0o600);
      assert.equal((await lstat(join(files.root, "private"))).mode & 0o777, 0o700);
    }
    assert.deepEqual(
      (await readdir(join(files.root, "private"))).filter(
        (name) => name.endsWith(".tmp"),
      ),
      [],
    );
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("the envelope traverses the snapshot once and remains byte-compatible", async () => {
  const files = await fixture();
  try {
    const plain = authoritativeSnapshot();
    const snapshot = structuredClone(plain);
    let serializations = 0;
    Object.defineProperty(snapshot, "toJSON", {
      enumerable: false,
      value: () => {
        serializations += 1;
        return plain;
      },
    });
    const savedAt = "2026-08-27T12:01:00.000Z";
    assert.equal(await writeAuthoritativeDashboardSnapshot({
      snapshotFile: files.snapshotFile,
      snapshot,
      now: () => Date.parse(savedAt),
    }), true);
    assert.equal(
      serializations,
      1,
      "encoding must not synchronously traverse the full snapshot twice",
    );
    const snapshotPayload = JSON.stringify(plain);
    const expected = JSON.stringify({
      schemaVersion: "local-authoritative-dashboard-snapshot-v1",
      savedAt,
      digest: createHash("sha256")
        .update(snapshotPayload, "utf8")
        .digest("hex"),
      snapshot: plain,
    });
    assert.equal(
      await readFile(files.snapshotFile, "utf8"),
      expected,
      "the optimized envelope keeps the existing property order and bytes",
    );
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("a write removes only stale exact-pattern interrupted temporaries", async () => {
  const files = await fixture();
  try {
    const directory = join(files.root, "private");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const staleName = `${files.snapshotFile}.424241.${uuid}.tmp`;
    const youngName = `${files.snapshotFile}.424242.${uuid}.tmp`;
    const openModeName = `${files.snapshotFile}.424243.${uuid}.tmp`;
    const linkedName = `${files.snapshotFile}.424244.${uuid}.tmp`;
    const hardLinkedName = `${files.snapshotFile}.424246.${uuid}.tmp`;
    const hardLinkTarget = join(directory, "unrelated-hard-link-target");
    const ambiguousName = `${files.snapshotFile}.424245.${uuid}.tmp.backup`;
    await writeFile(staleName, "interrupted", { mode: 0o600 });
    await writeFile(youngName, "still potentially active", { mode: 0o600 });
    await writeFile(openModeName, "too open", { mode: 0o600 });
    if (process.platform !== "win32") await chmod(openModeName, 0o644);
    await symlink(staleName, linkedName);
    if (process.platform !== "win32") {
      await writeFile(hardLinkTarget, "unrelated", { mode: 0o600 });
      await link(hardLinkTarget, hardLinkedName);
    }
    await writeFile(ambiguousName, "unrelated", { mode: 0o600 });

    const nowMs = Date.now() + (48 * 60 * 60 * 1_000);
    await utimes(youngName, new Date(nowMs), new Date(nowMs));
    assert.equal(await writeAuthoritativeDashboardSnapshot({
      snapshotFile: files.snapshotFile,
      snapshot: authoritativeSnapshot(),
      now: () => nowMs,
    }), true);

    const names = await readdir(directory);
    assert.equal(names.includes(basename(staleName)), false);
    assert.equal(names.includes(basename(youngName)), true);
    if (process.platform !== "win32") {
      assert.equal(names.includes(basename(openModeName)), true);
    }
    assert.equal(names.includes(basename(linkedName)), true);
    if (process.platform !== "win32") {
      assert.equal(names.includes(basename(hardLinkedName)), true);
      assert.equal(names.includes(basename(hardLinkTarget)), true);
    }
    assert.equal(names.includes(basename(ambiguousName)), true);
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("stale temporary cleanup is bounded per authoritative write", async () => {
  const files = await fixture();
  try {
    const directory = join(files.root, "private");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const staleNames = [424251, 424252, 424253].map(
      (pid) => `${files.snapshotFile}.${pid}.${uuid}.tmp`,
    );
    await Promise.all(staleNames.map(
      (file) => writeFile(file, "interrupted", { mode: 0o600 }),
    ));
    const nowMs = Date.now() + (48 * 60 * 60 * 1_000);
    assert.equal(await writeAuthoritativeDashboardSnapshot({
      snapshotFile: files.snapshotFile,
      snapshot: authoritativeSnapshot(),
      now: () => nowMs,
    }), true);
    const names = await readdir(directory);
    assert.equal(
      staleNames.filter((file) => names.includes(basename(file))).length,
      1,
      "one write removes at most two unambiguous stale temporaries",
    );
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("corrupt, open-mode, linked, and non-authoritative snapshots fail closed", async () => {
  const files = await fixture();
  try {
    const snapshot = authoritativeSnapshot();
    await writeAuthoritativeDashboardSnapshot({
      snapshotFile: files.snapshotFile,
      snapshot,
    });
    const payload = JSON.parse(await readFile(files.snapshotFile, "utf8"));
    payload.digest = "0".repeat(64);
    await writeFile(files.snapshotFile, JSON.stringify(payload), { mode: 0o600 });
    assert.equal(await readAuthoritativeDashboardSnapshot({
      snapshotFile: files.snapshotFile,
    }), null);

    await writeAuthoritativeDashboardSnapshot({
      snapshotFile: files.snapshotFile,
      snapshot,
    });
    if (process.platform !== "win32") {
      await chmod(files.snapshotFile, 0o644);
      assert.equal(await readAuthoritativeDashboardSnapshot({
        snapshotFile: files.snapshotFile,
      }), null);
      await chmod(files.snapshotFile, 0o600);
    }

    const link = join(files.root, "linked-dashboard.json");
    await symlink(files.snapshotFile, link);
    assert.equal(await readAuthoritativeDashboardSnapshot({
      snapshotFile: link,
    }), null);

    const incomplete = authoritativeSnapshot();
    incomplete.overview.accounting.projection.status = "unavailable";
    incomplete.overview.accounting.projection.reason =
      "local_unified_index_schema_newer";
    incomplete.overview.accounting.projection.terminal = true;
    assert.equal(await writeAuthoritativeDashboardSnapshot({
      snapshotFile: files.snapshotFile,
      snapshot: incomplete,
    }), false);
    assert.deepEqual(
      (await readAuthoritativeDashboardSnapshot({
        snapshotFile: files.snapshotFile,
      }))?.snapshot,
      snapshot,
      "a failed candidate must not overwrite the last authoritative receipt",
    );

    const scanning = authoritativeSnapshot();
    scanning.overview.accounting.historyCoverage.phase = "scanning";
    assert.equal(
      isAuthoritativeDashboardSnapshot(scanning),
      false,
      "a complete label without the terminal complete phase is not durable",
    );
    assert.equal(await writeAuthoritativeDashboardSnapshot({
      snapshotFile: files.snapshotFile,
      snapshot,
      now: () => {
        throw new Error("clock unavailable");
      },
    }), false, "an invalid clock cannot fail or replace the receipt");
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("a complete usage projection may persist an explicit typed-tool gap but never zero tool totals", async () => {
  const files = await fixture();
  try {
    const snapshot = authoritativeSnapshot({ toolHistoryPartial: true });
    assert.equal(isAuthoritativeDashboardSnapshot(snapshot), true);
    assert.equal(await writeAuthoritativeDashboardSnapshot({
      snapshotFile: files.snapshotFile,
      snapshot,
    }), true);
    const retained = (await readAuthoritativeDashboardSnapshot({
      snapshotFile: files.snapshotFile,
    })).snapshot;
    assert.equal(retained.overview.activity.toolEvents, null);
    assert.equal(retained.overview.tools.total, null);
    assert.ok(Object.values(retained.overview.tools.counts).every(
      (value) => value === null,
    ));
    assert.equal(retained.overview.accounting.toolClasses.total, null);

    const legacyZero = authoritativeSnapshot({ toolHistoryPartial: true });
    legacyZero.overview.timeline.history = { status: "partial" };
    legacyZero.overview.activity.toolEvents = 0;
    legacyZero.overview.tools = {
      total: 0,
      counts: Object.fromEntries(
        TOOL_KEYS.map((key) => [key, 0]),
      ),
    };
    legacyZero.overview.accounting.toolClasses = structuredClone(
      legacyZero.overview.tools,
    );
    assert.equal(isAuthoritativeDashboardSnapshot(legacyZero), true);
    const legacyFile = join(files.root, "private", "legacy-zero.json");
    assert.equal(await writeAuthoritativeDashboardSnapshot({
      snapshotFile: legacyFile,
      snapshot: legacyZero,
    }), true);
    const canonical = (await readAuthoritativeDashboardSnapshot({
      snapshotFile: legacyFile,
    })).snapshot;
    assert.equal(canonical.overview.activity.toolEvents, null);
    assert.equal(canonical.overview.tools.total, null);
    assert.ok(Object.values(canonical.overview.tools.counts).every(
      (value) => value === null,
    ));

    const undeclaredZero = structuredClone(legacyZero);
    undeclaredZero.overview.warnings = [];
    undeclaredZero.overview.tools.counts = Object.fromEntries(
      TOOL_KEYS.map((key) => [key, 0]),
    );
    assert.equal(isAuthoritativeDashboardSnapshot(undeclaredZero), false);
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("the data store restores only the last authoritative receipt across launches", async () => {
  const files = await fixture();
  try {
    const authoritative = authoritativeSnapshot();
    const first = new LocalCompanionDataStore({
      snapshotFile: files.snapshotFile,
      builder: async () => structuredClone(authoritative),
    });
    await first.reload({ purpose: "full" });

    const second = new LocalCompanionDataStore({
      snapshotFile: files.snapshotFile,
      builder: async () => unavailableSnapshot(),
    });
    await second.initialize({ purpose: "full" });
    const retained = second.getOverview();
    assert.equal(retained.accounting.events, 12);
    assert.equal(retained.accounting.generationMatched, false);
    assert.equal(retained.accounting.projection.status, "retained");
    assert.equal(
      retained.accounting.projection.reason,
      "local_unified_index_schema_newer",
    );
    assert.equal(retained.usage[0].events, 12);
    assert.equal(retained.timeline.usage.length, 1);
    assert.equal(
      (await readAuthoritativeDashboardSnapshot({
        snapshotFile: files.snapshotFile,
      })).snapshot.overview.accounting.projection.status,
      "available",
      "a terminal or retained projection must not replace the receipt",
    );

    const third = new LocalCompanionDataStore({
      snapshotFile: files.snapshotFile,
      builder: async () => {
        throw new Error("private current-read detail");
      },
    });
    await third.initialize({ purpose: "full" });
    const fallback = third.getOverview();
    assert.equal(fallback.accounting.events, 12);
    assert.equal(fallback.accounting.generationMatched, false);
    assert.deepEqual(fallback.accounting.projection, {
      status: "retained",
      reason: "current_projection_unavailable",
      terminal: true,
      retainedAt: "2026-08-27T12:00:00.000Z",
      coveredAt: null,
    });
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("startup retains only valid saved evidence until a full refresh publishes details", async (t) => {
  for (const receiptStatus of ["valid", "missing", "invalid"]) {
    await t.test(receiptStatus, async () => {
      const files = await fixture();
      try {
        const previous = authoritativeSnapshot();
        let receiptBytes = null;
        if (receiptStatus !== "missing") {
          assert.equal(await writeAuthoritativeDashboardSnapshot({
            snapshotFile: files.snapshotFile,
            snapshot: previous,
            now: () => Date.parse("2026-08-27T12:01:00.000Z"),
          }), true);
          receiptBytes = await readFile(files.snapshotFile, "utf8");
          if (receiptStatus === "invalid") {
            const invalid = JSON.parse(receiptBytes);
            invalid.digest = "0".repeat(64);
            receiptBytes = JSON.stringify(invalid);
            await writeFile(files.snapshotFile, receiptBytes, { mode: 0o600 });
            assert.equal(await readAuthoritativeDashboardSnapshot({
              snapshotFile: files.snapshotFile,
            }), null);
          }
        }

        const startup = unavailableSnapshot();
        startup.generatedAt = "2026-08-27T13:05:00.000Z";
        startup.overview.warnings = [RETAINED_EVIDENCE_RELABELED_WARNINGS[0]];
        startup.overview.usage = [];
        startup.overview.activity = {
          usageEvents: null,
          totalTokens: null,
          toolEvents: null,
        };
        startup.overview.tools = {
          status: "unavailable",
          total: null,
          counts: Object.fromEntries(TOOL_KEYS.map((key) => [key, null])),
        };
        startup.overview.timeline.history = {
          status: "loading",
          reason: "unified_index_deferred",
        };
        Object.assign(startup.overview.accounting, {
          generation: 18,
          generationFingerprint: "generation-fingerprint-18",
          sourceCoverageStatus: "unavailable",
          events: null,
          totalTokens: null,
          apiPriceEquivalentUsd: null,
          periods: [],
          toolClasses: structuredClone(startup.overview.tools),
        });
        startup.overview.accounting.projection.reason =
          "local_unified_index_deferred";
        startup.overview.accounting.projection.terminal = false;

        const full = authoritativeSnapshot();
        full.generatedAt = "2026-08-27T13:06:00.000Z";
        full.overview.accounting.generation = 18;
        full.overview.accounting.generationFingerprint =
          "generation-fingerprint-18";
        full.overview.timeline.usage = [
          { at: "2026-08-27T11:00:00.000Z", events: 6 },
          { at: "2026-08-27T12:00:00.000Z", events: 6 },
        ];
        full.gradient.datasets.rolling.push({ at: 2 });
        full.weekly.datasets.weekly_values.push({ sequence: 2 });
        const purposes = [];
        const store = new LocalCompanionDataStore({
          snapshotFile: files.snapshotFile,
          // The receipt is older than the persistence interval: unchanged
          // bytes must reflect the authority gate, not a throttled write.
          snapshotNow: () => Date.parse(full.generatedAt),
          builder: async ({ purpose = "full" } = {}) => {
            purposes.push(purpose);
            return structuredClone(purpose === "startup" ? startup : full);
          },
        });
        await store.initialize({ purpose: "startup" });
        assert.deepEqual(purposes, ["startup"]);
        const overview = store.getOverview();
        assert.equal(overview.generatedAt, startup.generatedAt);
        assert.equal(overview.accounting.generationMatched, false);
        assert.equal(overview.accounting.generation, 18);
        assert.equal(overview.accounting.accountingCacheStatus, "unavailable");
        assert.equal(
          overview.accounting.projection.reason,
          "local_unified_index_deferred",
        );
        assert.equal(overview.accounting.projection.terminal, false);
        if (receiptStatus === "valid") {
          assert.equal(overview.accounting.projection.status, "retained");
          assert.equal(
            overview.accounting.projection.retainedAt,
            previous.generatedAt,
          );
          assert.deepEqual(overview.usage, previous.overview.usage);
          assert.equal(overview.accounting.events, 12);
          assert.deepEqual(overview.timeline.usage, previous.overview.timeline.usage);
          assert.deepEqual(store.getGradient(), previous.gradient);
          assert.deepEqual(store.getWeekly(), previous.weekly);
          assert.deepEqual(overview.warnings, [RETAINED_EVIDENCE_REFRESH_WARNING]);
        } else {
          assert.equal(overview.accounting.projection.status, "unavailable");
          assert.equal(overview.accounting.projection.retainedAt, null);
          assert.equal(overview.accounting.events, null);
          assert.equal(overview.accounting.totalTokens, null);
          assert.deepEqual(overview.usage, []);
          assert.deepEqual(overview.timeline.usage, []);
          assert.deepEqual(store.getGradient().datasets.rolling, []);
          assert.deepEqual(store.getWeekly().datasets.weekly_values, []);
        }
        if (receiptBytes === null) {
          await assert.rejects(lstat(files.snapshotFile), { code: "ENOENT" });
        } else {
          assert.equal(await readFile(files.snapshotFile, "utf8"), receiptBytes,
            "startup must not persist a deferred or retained merge as authority");
        }

        await store.reload({ purpose: "full" });
        assert.deepEqual(purposes, ["startup", "full"]);
        assert.deepEqual(store.getOverview(), {
          schemaVersion: full.schemaVersion,
          mode: full.mode,
          generatedAt: full.generatedAt,
          ...full.overview,
        });
        assert.deepEqual(store.getGradient(), full.gradient);
        assert.deepEqual(store.getWeekly(), full.weekly);
        assert.deepEqual((await readAuthoritativeDashboardSnapshot({
          snapshotFile: files.snapshotFile,
        })).snapshot, full);
      } finally {
        await rm(files.root, { recursive: true });
      }
    });
  }
});

test("the production composition root passes the private snapshot path to the data store", async () => {
  const source = await readFile(
    new URL("../apps/local/server.js", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /new LocalCompanionDataStore\(\{\s*snapshotFile: statePaths\.authoritativeDashboardSnapshotFile,/u,
  );
});

test("authoritative persistence is immediate once, hourly thereafter, and retries failed writes", async () => {
  const snapshot = authoritativeSnapshot();
  let nowMs = Date.parse("2026-08-27T12:00:00.000Z");
  const writes = [];
  const store = new LocalCompanionDataStore({
    snapshotFile: "/private/test-dashboard-receipt.json",
    snapshotNow: () => nowMs,
    snapshotWriteIntervalMs: 60 * 60 * 1_000,
    snapshotWriter: async (request) => {
      writes.push(request.now());
      return true;
    },
    builder: async () => structuredClone(snapshot),
  });
  await store.reload({ purpose: "full" });
  assert.deepEqual(writes, [nowMs], "the first eligible snapshot writes immediately");
  nowMs += 30 * 60 * 1_000;
  await store.reload({ purpose: "full" });
  assert.equal(writes.length, 1, "an ordinary foreground refresh is throttled");
  nowMs += 31 * 60 * 1_000;
  await store.reload({ purpose: "full" });
  assert.deepEqual(writes, [
    Date.parse("2026-08-27T12:00:00.000Z"),
    Date.parse("2026-08-27T13:01:00.000Z"),
  ]);

  let attempts = 0;
  const retrying = new LocalCompanionDataStore({
    snapshotFile: "/private/test-dashboard-retry.json",
    snapshotNow: () => nowMs,
    snapshotWriteIntervalMs: 60 * 60 * 1_000,
    snapshotWriter: async () => {
      attempts += 1;
      return attempts > 1;
    },
    builder: async () => structuredClone(snapshot),
  });
  await retrying.reload({ purpose: "full" });
  await retrying.reload({ purpose: "full" });
  assert.equal(attempts, 2, "a failed atomic write does not consume the cadence");
  await retrying.reload({ purpose: "full" });
  assert.equal(attempts, 2, "a successful retry starts the cadence");
});

test("a restored receipt initializes the hourly persistence cadence", async () => {
  const snapshot = authoritativeSnapshot();
  const savedAt = "2026-08-27T12:00:00.000Z";
  let nowMs = Date.parse(savedAt) + 30 * 60 * 1_000;
  let writes = 0;
  const store = new LocalCompanionDataStore({
    snapshotFile: "/private/test-dashboard-restored.json",
    snapshotNow: () => nowMs,
    snapshotWriteIntervalMs: 60 * 60 * 1_000,
    snapshotReader: async () => ({ savedAt, snapshot }),
    snapshotWriter: async () => {
      writes += 1;
      return true;
    },
    builder: async () => structuredClone(snapshot),
  });
  await store.initialize({ purpose: "full" });
  assert.equal(writes, 0, "relaunch does not rewrite a fresh 8 MB receipt");
  nowMs += 31 * 60 * 1_000;
  await store.reload({ purpose: "full" });
  assert.equal(writes, 1);
});

test("a future restored receipt cannot suppress current snapshot persistence", async () => {
  const snapshot = authoritativeSnapshot();
  const nowMs = Date.parse("2026-08-27T12:00:00.000Z");
  const savedAt = "2026-08-27T14:00:00.000Z";
  const writes = [];
  const store = new LocalCompanionDataStore({
    snapshotFile: "/private/test-dashboard-future-restored.json",
    snapshotNow: () => nowMs,
    snapshotWriteIntervalMs: 60 * 60 * 1_000,
    snapshotReader: async () => ({ savedAt, snapshot }),
    snapshotWriter: async (request) => {
      writes.push(request.now());
      return true;
    },
    builder: async () => structuredClone(snapshot),
  });
  await store.initialize({ purpose: "full" });
  assert.deepEqual(writes, [nowMs]);
});

test("atomic snapshot publication never chmods a closed pathname", async () => {
  const source = await readFile(
    new URL("../src/local-authoritative-dashboard-snapshot.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\bchmod\s*\(/u,
    "owner-only mode comes from the exclusive file descriptor; pathname chmod would reopen a symlink race",
  );
});

test("a persistence clock failure cannot fail an authoritative dashboard reload", async () => {
  let writes = 0;
  const store = new LocalCompanionDataStore({
    snapshotFile: "/private/test-dashboard-clock-failure.json",
    snapshotNow: () => {
      throw new Error("clock unavailable");
    },
    snapshotWriter: async () => {
      writes += 1;
      return true;
    },
    builder: async () => authoritativeSnapshot(),
  });
  const overview = await store.reload({ purpose: "full" });
  assert.equal(overview.accounting.events, 12);
  assert.equal(writes, 0);
});
