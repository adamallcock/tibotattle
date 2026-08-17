import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_DESKTOP_PLAN_HISTORY_BASENAME,
  claudeDesktopPlanHistoryPath,
  claudeDesktopQuotaSourceKey,
  readClaudeDesktopQuotaSource,
  readOrCreateClaudeDesktopQuotaSecret,
  refreshClaudeDesktopQuota,
} from "../src/claude-desktop-quota-refresh.js";
import {
  openClaudeDesktopQuotaState,
} from "../src/claude-desktop-quota-state.js";

const SECRET = Buffer.alloc(32, 41);
const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/claude-desktop-phase0/", import.meta.url));
const FIRST_REFRESH_AT = 1784895000000;

async function fixture() {
  return readFile(join(FIXTURE_ROOT, "quota-history-v2.json"));
}

async function materialize() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-quota-state-"));
  await chmod(root, 0o700);
  const support = join(root, "Library", "Application Support", "Claude");
  await mkdir(support, { recursive: true, mode: 0o700 });
  await chmod(support, 0o700);
  const historyPath = join(support, CLAUDE_DESKTOP_PLAN_HISTORY_BASENAME);
  await writeFile(historyPath, await fixture(), { mode: 0o600 });
  const transcriptDirectory = join(root, "projects");
  await mkdir(transcriptDirectory, { mode: 0o700 });
  await writeFile(join(transcriptDirectory, "must-not-be-read.jsonl"), "PRIVATE TRANSCRIPT", {
    mode: 0o600,
  });
  return {
    root,
    support,
    historyPath,
    transcriptDirectory,
    statePath: join(root, "state", "claude-quota.sqlite"),
  };
}

async function readQuotaRows(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      rows: database.prepare(`
        SELECT account_scope, observed_at_ms, meter_id, revision,
               utilization_percent, resets_at_ms, source_generation
        FROM quota_revision
        ORDER BY account_scope, observed_at_ms, meter_id, revision
      `).all(),
      source: database.prepare(`
        SELECT source_generation, status, last_error_code
        FROM source_state
      `).all(),
    };
  } finally {
    database.close();
  }
}

test("native quota refresh uses the exact allowlisted path and no transcript input", async () => {
  const paths = await materialize();
  try {
    assert.equal(
      claudeDesktopPlanHistoryPath({ applicationSupportDirectory: paths.support }),
      paths.historyPath,
    );
    assert.equal(
      claudeDesktopPlanHistoryPath({ homeDirectory: paths.root }),
      join(paths.root, "Library", "Application Support", "Claude", CLAUDE_DESKTOP_PLAN_HISTORY_BASENAME),
    );
    assert.throws(
      () => claudeDesktopPlanHistoryPath({ applicationSupportDirectory: join(paths.root, "not-Claude") }),
      (error) => error.code === "claude_desktop_quota_refresh_configuration",
    );
    assert.throws(
      () => claudeDesktopPlanHistoryPath({ homeDirectory: "relative-home" }),
      (error) => error.code === "claude_desktop_quota_refresh_configuration",
    );
    const source = await readClaudeDesktopQuotaSource({
      applicationSupportDirectory: paths.support,
      secret: SECRET,
    });
    assert.equal(source.history.observationCount, 9);
    assert.equal("path" in source, false);

    // The deliberately invalid transcript option proves the quota-only API has
    // no transcript dependency or path traversal surface by construction.
    const result = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT,
      staleAfterMs: 60 * 60 * 1000,
      projectsDirectory: "\0must-not-be-read",
    });
    assert.equal(result.sourceStatus, "present");
    assert.equal(result.sourceGeneration, 1);
    assert.deepEqual(result.imported, { inserted: 8, duplicates: 1, revisions: 1 });
    assert.equal(result.projection.status, "available");
    assert.equal(result.projection.coverage.state, "complete");
    assert.equal(result.projection.counts.observations, 8);
    assert.equal(result.projection.counts.accounts, 2);
    assert.equal(result.projection.counts.unknownMeters, 1);
    assert.ok(result.projection.windows.every((window) => !window.meterId.startsWith("unknown_")));
    assert.ok(result.projection.windows.every((window) => window.resetsAtMs === null));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("fixture-organization"), false);
    assert.equal(serialized.includes("PRIVATE TRANSCRIPT"), false);
    assert.equal(serialized.includes(paths.historyPath), false);

    const stateStats = await lstat(paths.statePath);
    assert.equal(stateStats.isFile(), true);
    assert.equal(stateStats.mode & 0o077, 0);
    const projectionAfterReopen = (() => {
      const state = openClaudeDesktopQuotaState(paths.statePath);
      try {
        return state.readProjection({ nowAtMs: FIRST_REFRESH_AT, staleAfterMs: 60 * 60 * 1000 });
      } finally {
        state.close();
      }
    })();
    assert.equal(projectionAfterReopen.counts.observations, 8);
    assert.equal(projectionAfterReopen.source.status, "present");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("replays deduplicate, corrections retain revisions, and resets stay nullable", async () => {
  const paths = await materialize();
  try {
    const first = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT,
      staleAfterMs: 60 * 60 * 1000,
    });
    const replay = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT + 1_000,
      staleAfterMs: 60 * 60 * 1000,
    });
    assert.equal(first.imported.inserted, 8);
    assert.deepEqual(replay.imported, { inserted: 0, duplicates: 9, revisions: 0 });

    const parsed = JSON.parse((await fixture()).toString("utf8"));
    parsed.samples.push({
      t: 1784894460000,
      org: "fixture-organization-a",
      u: { fh: 44 },
    });
    await writeFile(paths.historyPath, JSON.stringify(parsed), { mode: 0o600 });
    const correction = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT + 2_000,
      staleAfterMs: 60 * 60 * 1000,
    });
    assert.deepEqual(correction.imported, { inserted: 1, duplicates: 9, revisions: 1 });
    assert.equal(correction.sourceGeneration, 2);
    assert.equal(correction.projection.counts.observations, 9);
    const rows = await readQuotaRows(paths.statePath);
    assert.equal(rows.rows.length, 9);
    assert.ok(rows.rows.every((row) => row.resets_at_ms === null));
    assert.deepEqual(rows.rows.map((row) => row.revision).filter((revision) => revision > 1), [2, 3]);
    const correctedRows = rows.rows.filter((row) => (
      row.observed_at_ms === 1784894460000 && row.meter_id === "five_hour"
    ));
    assert.deepEqual(correctedRows.map((row) => row.utilization_percent), [17, 15, 44]);
    assert.equal(correction.projection.windows.find((window) => window.meterId === "five_hour").utilizationPercent, 3);
    assert.deepEqual(rows.rows.map((row) => row.source_generation).filter((generation) => generation > 1), [2]);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("a correction can return to an earlier value without being dropped as a replay", async () => {
  const paths = await materialize();
  try {
    const history = {
      version: 2,
      samples: [
        { t: 1784894400000, org: "fixture-organization-a", u: { fh: 20 } },
        { t: 1784894400000, org: "fixture-organization-a", u: { fh: 40 } },
      ],
    };
    await writeFile(paths.historyPath, JSON.stringify(history), { mode: 0o600 });
    await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT,
    });
    history.samples.push({
      t: 1784894400000,
      org: "fixture-organization-a",
      u: { fh: 20 },
    });
    await writeFile(paths.historyPath, JSON.stringify(history), { mode: 0o600 });
    const reverted = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT + 1_000,
    });
    assert.deepEqual(reverted.imported, { inserted: 1, duplicates: 2, revisions: 1 });
    assert.equal(reverted.projection.windows[0].utilizationPercent, 20);
    const rows = await readQuotaRows(paths.statePath);
    assert.deepEqual(rows.rows.map((row) => row.utilization_percent), [20, 40, 20]);
    assert.deepEqual(rows.rows.map((row) => row.revision), [1, 2, 3]);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("a rolling empty snapshot retains facts but cannot refresh old windows", async () => {
  const paths = await materialize();
  try {
    await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT,
    });
    await writeFile(paths.historyPath, JSON.stringify({ version: 2, samples: [] }), {
      mode: 0o600,
    });
    const empty = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT + 1_000,
    });
    assert.equal(empty.sourceStatus, "partial");
    assert.equal(empty.projection.status, "stale");
    assert.equal(empty.projection.coverage.state, "partial");
    assert.equal(empty.projection.counts.observations, 8);
    assert.deepEqual(empty.projection.windows, []);
    assert.equal(empty.projection.source.lastSuccessAtMs, FIRST_REFRESH_AT);
    const stillEmpty = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT + 2_000,
    });
    assert.equal(stillEmpty.sourceStatus, "partial");
    assert.equal(stillEmpty.projection.status, "stale");
    assert.equal(stillEmpty.projection.freshness, "stale");
    assert.deepEqual(stillEmpty.projection.windows, []);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("unknown-only activity on another account cannot blank the latest reviewed windows", async () => {
  const paths = await materialize();
  try {
    await writeFile(paths.historyPath, JSON.stringify({
      version: 2,
      samples: [
        { t: 1784894400000, org: "fixture-organization-a", u: { fh: 11 } },
        { t: 1784894460000, org: "fixture-organization-b", u: { future_meter: 99 } },
      ],
    }), { mode: 0o600 });
    const result = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT,
    });
    assert.deepEqual(result.projection.windows.map((window) => ({
      meterId: window.meterId,
      utilizationPercent: window.utilizationPercent,
    })), [{ meterId: "five_hour", utilizationPercent: 11 }]);
    assert.equal(result.projection.counts.accounts, 2);
    assert.equal(result.projection.counts.unknownMeters, 1);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("an unknown-only replacement cannot present empty quota as fresh and complete", async () => {
  const paths = await materialize();
  try {
    await writeFile(paths.historyPath, JSON.stringify({
      version: 2,
      samples: [{ t: 1784894400000, org: "fixture-organization-a", u: { fh: 11 } }],
    }), { mode: 0o600 });
    await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT,
    });
    await writeFile(paths.historyPath, JSON.stringify({
      version: 2,
      samples: [{ t: 1784894460000, org: "fixture-organization-b", u: { future_meter: 99 } }],
    }), { mode: 0o600 });
    const replacement = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT + 1_000,
    });
    assert.equal(replacement.sourceStatus, "partial");
    assert.equal(replacement.projection.status, "stale");
    assert.equal(replacement.projection.freshness, "stale");
    assert.equal(replacement.projection.coverage.state, "partial");
    assert.deepEqual(replacement.projection.windows, []);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("a normal rolling-window shift remains current when reviewed meters advance", async () => {
  const paths = await materialize();
  try {
    const history = {
      version: 2,
      samples: [
        { t: 1784894400000, org: "fixture-organization-a", u: { fh: 10 } },
        { t: 1784894460000, org: "fixture-organization-a", u: { fh: 20 } },
      ],
    };
    await writeFile(paths.historyPath, JSON.stringify(history), { mode: 0o600 });
    await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT,
    });
    history.samples = [
      history.samples[1],
      { t: 1784894520000, org: "fixture-organization-a", u: { fh: 30 } },
    ];
    await writeFile(paths.historyPath, JSON.stringify(history), { mode: 0o600 });
    const shifted = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT + 1_000,
    });
    assert.equal(shifted.sourceStatus, "present");
    assert.equal(shifted.projection.status, "available");
    assert.equal(shifted.projection.coverage.state, "complete");
    assert.equal(shifted.projection.windows[0].utilizationPercent, 30);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("a shorter snapshot cannot present a disappeared meter as current", async () => {
  const paths = await materialize();
  try {
    const history = {
      version: 2,
      samples: [{
        t: 1784894400000,
        org: "fixture-organization-a",
        u: { fh: 20, sd: 30 },
      }],
    };
    await writeFile(paths.historyPath, JSON.stringify(history), { mode: 0o600 });
    await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT,
    });
    history.samples[0].u = { fh: 21 };
    await writeFile(paths.historyPath, JSON.stringify(history), { mode: 0o600 });
    const shorter = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT + 1_000,
    });
    assert.equal(shorter.sourceStatus, "partial");
    assert.equal(shorter.projection.coverage.state, "partial");
    assert.deepEqual(shorter.projection.windows.map((window) => window.meterId), ["five_hour"]);
    assert.equal(shorter.projection.counts.observations, 3);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("source disappearance is a non-destructive coverage transition", async () => {
  const paths = await materialize();
  try {
    await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT,
      staleAfterMs: 60 * 60 * 1000,
    });
    await rm(paths.historyPath);
    const missing = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT + 60_000,
      staleAfterMs: 60 * 60 * 1000,
    });
    assert.equal(missing.sourceStatus, "missing_suspected");
    assert.equal(missing.sourceGeneration, 1);
    assert.equal(missing.projection.status, "stale");
    assert.equal(missing.projection.source.status, "missing_suspected");
    assert.equal(missing.projection.coverage.state, "partial");
    assert.equal(missing.projection.counts.observations, 8);
    assert.equal(JSON.stringify(missing.projection).includes(paths.historyPath), false);

    await writeFile(paths.historyPath, await fixture(), { mode: 0o600 });
    const restored = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT + 120_000,
      staleAfterMs: 60 * 60 * 1000,
    });
    assert.equal(restored.sourceStatus, "present");
    assert.equal(restored.sourceGeneration, 2);
    assert.equal(restored.imported.inserted, 0);
    assert.equal(restored.projection.counts.observations, 8);
    assert.equal(restored.projection.coverage.state, "partial");
    const rows = await readQuotaRows(paths.statePath);
    assert.equal(rows.source[0].status, "present");
    assert.equal(rows.source[0].source_generation, 2);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("malformed native history records partial coverage without deleting accepted rows", async () => {
  const paths = await materialize();
  try {
    await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT,
      staleAfterMs: 60 * 60 * 1000,
    });
    await writeFile(paths.historyPath, "{\"version\":2,\"samples\":[", { mode: 0o600 });
    const partial = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT + 60_000,
      staleAfterMs: 60 * 60 * 1000,
    });
    assert.equal(partial.sourceStatus, "partial");
    assert.equal(partial.sourceErrorCode, "malformed");
    assert.equal(partial.projection.source.status, "partial");
    assert.equal(partial.projection.coverage.state, "partial");
    assert.equal(partial.projection.counts.observations, 8);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("state storage rejects a pre-existing non-owner-only database", async () => {
  const paths = await materialize();
  try {
    await mkdir(dirname(paths.statePath), { recursive: true, mode: 0o700 });
    await writeFile(paths.statePath, "not sqlite", { mode: 0o644 });
    await chmod(paths.statePath, 0o644);
    assert.throws(
      () => openClaudeDesktopQuotaState(paths.statePath),
      (error) => error.code === "claude_desktop_quota_state_storage_unsafe",
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("source key is stable and does not encode the home directory", () => {
  assert.equal(claudeDesktopQuotaSourceKey({ secret: SECRET }), claudeDesktopQuotaSourceKey({ secret: SECRET }));
  assert.notEqual(
    claudeDesktopQuotaSourceKey({ secret: SECRET }),
    claudeDesktopQuotaSourceKey({ secret: Buffer.alloc(32, 42) }),
  );
});

test("quota state fails closed if its HMAC source namespace changes", async () => {
  const paths = await materialize();
  try {
    await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT,
    });
    await assert.rejects(
      refreshClaudeDesktopQuota({
        statePath: paths.statePath,
        applicationSupportDirectory: paths.support,
        secret: Buffer.alloc(32, 42),
        observedAtMs: FIRST_REFRESH_AT + 1_000,
      }),
      (error) => error.code === "claude_desktop_quota_state_source_key_mismatch",
    );
    const state = openClaudeDesktopQuotaState(paths.statePath);
    try {
      const projection = state.readProjection({ nowAtMs: FIRST_REFRESH_AT + 1_000 });
      assert.equal(projection.status, "available");
      assert.equal(projection.windows.length, 2);
    } finally {
      state.close();
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("quota HMAC secret is owner-only, stable, and rejects unsafe replacement", async () => {
  const paths = await materialize();
  const secretFile = join(paths.root, "state", "claude-quota-secret");
  try {
    const first = await readOrCreateClaudeDesktopQuotaSecret(secretFile);
    const second = await readOrCreateClaudeDesktopQuotaSecret(secretFile);
    assert.equal(first.byteLength, 32);
    assert.deepEqual(second, first);
    assert.equal((await lstat(secretFile)).mode & 0o077, 0);
    first.fill(0);
    second.fill(0);

    await chmod(secretFile, 0o644);
    await assert.rejects(
      readOrCreateClaudeDesktopQuotaSecret(secretFile),
      (error) => error.code === "claude_desktop_quota_refresh_secret_unsafe",
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("a present source with no observations remains unavailable", async () => {
  const paths = await materialize();
  try {
    await writeFile(paths.historyPath, JSON.stringify({ version: 2, samples: [] }), {
      mode: 0o600,
    });
    const result = await refreshClaudeDesktopQuota({
      statePath: paths.statePath,
      applicationSupportDirectory: paths.support,
      secret: SECRET,
      observedAtMs: FIRST_REFRESH_AT,
      staleAfterMs: 60 * 60 * 1000,
    });
    assert.equal(result.sourceStatus, "present");
    assert.equal(result.projection.status, "unavailable");
    assert.equal(result.projection.coverage.state, "unavailable");
    assert.deepEqual(result.projection.windows, []);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("an already-aborted quota refresh performs no state write", async () => {
  const paths = await materialize();
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      refreshClaudeDesktopQuota({
        statePath: paths.statePath,
        applicationSupportDirectory: paths.support,
        secret: SECRET,
        signal: controller.signal,
      }),
      (error) => error.code === "claude_desktop_quota_refresh_aborted",
    );
    await assert.rejects(lstat(paths.statePath), (error) => error.code === "ENOENT");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("quota bounds remain iterative above the JavaScript argument-spread limit", async () => {
  const paths = await materialize();
  const state = openClaudeDesktopQuotaState(paths.statePath);
  try {
    const observations = Array.from({ length: 150_000 }, (_, revision) => ({
      provider: "anthropic_claude_code",
      accountScope: "a".repeat(64),
      observedAtMs: FIRST_REFRESH_AT,
      meterId: "five_hour",
      utilizationPercent: 20,
      resetsAtMs: null,
      revision: revision + 1,
    }));
    const merged = state.mergeQuotaObservations(observations, {
      sourceKey: "b".repeat(64),
      acceptedAtMs: FIRST_REFRESH_AT,
    });
    assert.deepEqual(merged, {
      inserted: 1,
      duplicates: 149_999,
      revisions: 0,
      sourceGeneration: 1,
      sourceStatus: "present",
    });
    assert.equal(state.readProjection({ nowAtMs: FIRST_REFRESH_AT }).windows[0].utilizationPercent, 20);
  } finally {
    state.close();
    await rm(paths.root, { recursive: true, force: true });
  }
});
