import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_COMPANION_SCHEMA_VERSION,
  LocalCompanionDataStore,
  buildLocalCompanionSnapshot,
} from "../src/local-companion-data.js";

const ARTIFACT_FILES = {
  gradient: "2026-07-24-simple-quota-gradient-artifact.json",
  weekly: "2026-07-24-weekly-7-day-calibration-artifact.json",
  quality: "2026-07-24-monitoring-quality-artifact.json",
};

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "local-companion-data-"));
  await mkdir(join(root, ".usage-monitor"));
  for (const [kind, file] of Object.entries(ARTIFACT_FILES)) {
    await writeFile(join(root, file), JSON.stringify({
      privateTopLevel: "/Users/private/source",
      snapshot: {
        status: "complete",
        generatedAt: "2026-07-24T12:00:00.000Z",
        datasets: kind === "gradient" ? {
          summary: [{
            capacity_usd: 100,
            lower_80_usd: 80,
            upper_80_usd: 130,
            private_field: "person@example.com",
          }],
          reset_calendar: [{
            announced_at_utc: "2026-07-23T00:00:00.000Z",
            event_type: "global_reset",
            source_url: "https://private.example/",
          }],
        } : kind === "weekly" ? {
          summary: [{ median_weekly_value_usd: 112, qualifying_resets: 8 }],
        } : {
          summary: [{ known_speed_fraction: 0.8 }],
          opportunities: [{
            id: "collector_continuity",
            priority: "P0",
            title: "Keep collection fresh",
            evidence: "No arbitrary content.",
            action: "Collect again.",
          }],
        },
      },
    }));
  }
  for (const file of [
    "2026-07-24-simple-quota-gradient-report.html",
    "2026-07-24-weekly-7-day-calibration-report.html",
    "2026-07-24-monitoring-quality-report.html",
    "2026-07-24-codex-work-account-usage-report.html",
  ]) {
    await writeFile(join(root, file), "<!doctype html><title>report</title>");
  }
  return root;
}

test("local companion builds a closed real-data projection without identifiers or paths", async () => {
  const root = await fixtureRoot();
  try {
    const ledger = [
      {
        schemaVersion: "0.3",
        kind: "codex_rollout_usage_snapshot",
        observedAt: "2026-07-25T11:00:00.000Z",
        model: "gpt-5.6-sol",
        components: {
          input_uncached_tokens: 100,
          input_cache_read_tokens: 50,
          input_cache_write_tokens: 0,
          output_text_tokens: 20,
          output_reasoning_tokens: 30,
        },
        tierSemantics: { codexSpeedMode: "fast" },
        surfaceClassification: {
          surface: "subagent",
          agentScope: "subagent",
          lineageDisposition: "forked",
        },
        eventKey: "private-event-key",
        accountScope: { scopeId: "private-account-id" },
      },
      {
        schemaVersion: "0.3",
        kind: "codex_rollout_usage_snapshot",
        observedAt: "2026-07-25T11:30:00.000Z",
        model: "private-model-name",
        components: {
          input_uncached_tokens: 10,
          input_cache_read_tokens: 0,
          input_cache_write_tokens: 0,
          output_text_tokens: 0,
          output_reasoning_tokens: 0,
        },
        tierSemantics: { codexSpeedMode: "not-a-real-mode" },
      },
      {
        kind: "codex_quota_snapshot",
        observedAt: "2026-07-25T11:45:00.000Z",
        eventKey: "quota-event-key",
        accountScope: { scopeId: "private-account-id" },
        windows: [{
          limitId: "codex",
          slot: "primary",
          planType: "pro",
          usedPercent: 39,
          windowDurationMins: 10080,
          resetsAt: 1784980800,
        }],
      },
      {
        kind: "codex_tool_class_event",
        observedAt: "2026-07-25T11:46:00.000Z",
        toolClass: "subagent",
        eventKey: "tool-event-key",
      },
      {
        kind: "codex_tool_class_event",
        observedAt: "2026-07-25T11:47:00.000Z",
        toolClass: "private-tool-name",
      },
    ];
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      `${ledger.map((row) => JSON.stringify(row)).join("\n")}\nmalformed\n`,
    );
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(snapshot.schemaVersion, LOCAL_COMPANION_SCHEMA_VERSION);
    assert.equal(snapshot.mode, "real_local_evidence");
    assert.equal(snapshot.overview.quota.windows[0].remainingPercent, 61);
    assert.equal(snapshot.overview.usage[0].events, 2);
    assert.deepEqual(snapshot.overview.usage[0].byModel.map((row) => row.model), ["gpt-5.6-sol", "unknown"]);
    assert.equal(snapshot.overview.tools.counts.subagent, 1);
    assert.equal(snapshot.overview.tools.counts.other, 1);
    assert.equal(snapshot.overview.collector.malformedLines, 1);
    assert.deepEqual(snapshot.overview.collector.coveredAt, {
      startAt: "2026-07-25T11:00:00.000Z",
      endAt: "2026-07-25T11:47:00.000Z",
    });
    assert.deepEqual(snapshot.overview.collector.recordCounts, {
      usage: 2,
      quota: 1,
      tools: 2,
      other: 0,
    });
    assert.equal(snapshot.overview.timeline.bucketMinutes, 15);
    assert.equal(snapshot.overview.timeline.usage.length, 2);
    assert.equal(snapshot.overview.timeline.usage[0].usageEvents, 1);
    assert.equal(snapshot.overview.timeline.quota.length, 1);
    assert.equal(snapshot.overview.timeline.quota[0].accountAttribution, "unattributed");
    assert.equal(snapshot.overview.accounting.bySpeed.fast.events, 1);
    assert.equal(snapshot.overview.accounting.bySurface.subagent.events, 1);
    assert.equal(snapshot.overview.accounting.byAgentScope.subagent.events, 1);
    assert.equal(snapshot.overview.accounting.byLineage.forked.events, 1);
    assert.equal(snapshot.overview.accounting.reasoningEffortAvailable, false);
    assert.equal(snapshot.overview.accounting.apiPriceCounterfactualTier, "standard");
    assert.equal(
      snapshot.overview.monitoringGaps.find((row) => row.id === "ordinary_chat")?.status,
      "excluded",
    );
    assert.equal(snapshot.gradient.datasets.summary[0].private_field, undefined);
    assert.equal(snapshot.gradient.datasets.reset_calendar[0].source_url, undefined);
    const serialized = JSON.stringify(snapshot);
    for (const privateValue of [
      "private-event-key",
      "private-account-id",
      "private-model-name",
      "private-tool-name",
      "person@example.com",
      "/Users/private/source",
      "https://private.example/",
      "eventKey",
      "accountScope",
    ]) {
      assert.equal(serialized.includes(privateValue), false, `response leaked ${privateValue}`);
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("missing and malformed artifacts fail closed while collector evidence remains available", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-companion-missing-"));
  try {
    await mkdir(join(root, ".usage-monitor"));
    await writeFile(join(root, ".usage-monitor", "collector-events.jsonl"), "");
    await writeFile(join(root, ARTIFACT_FILES.gradient), "{malformed");
    const snapshot = await buildLocalCompanionSnapshot({ root });
    assert.equal(snapshot.gradient.status, "unavailable");
    assert.equal(snapshot.gradient.errorCode, "artifact_malformed");
    assert.equal(snapshot.weekly.status, "unavailable");
    assert.equal(snapshot.weekly.errorCode, "artifact_missing");
    assert.equal(snapshot.reports.every((report) => report.status === "unavailable"), true);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("data store retains its last good snapshot when a reload fails", async () => {
  let calls = 0;
  const store = new LocalCompanionDataStore({
    builder: async () => {
      calls += 1;
      if (calls > 1) throw new Error("private internal failure");
      return {
        schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
        mode: "real_local_evidence",
        generatedAt: "2026-07-25T12:00:00.000Z",
        overview: { marker: "last-good" },
        gradient: {},
        weekly: {},
        quality: {},
        reports: [],
      };
    },
  });
  await store.initialize();
  await assert.rejects(() => store.reload(), /private internal failure/);
  assert.equal(store.getOverview().marker, "last-good");
});
