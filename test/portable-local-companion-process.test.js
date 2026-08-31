import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_CANARY = "synthetic-private-content-must-not-escape";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "Tibo Tattle portable 路径 "));
  const profile = join(root, "Profile With Spaces");
  const localAppData = join(profile, "AppData", "Local");
  const codexHome = join(root, "Custom Codex Home", ".codex");
  const stateRoot = join(localAppData, "app-usagemonitor");
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true, mode: 0o700 });
  const usage = {
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 8,
    total_tokens: 120,
  };
  const rows = [
    {
      timestamp: "2026-07-27T01:00:00.000Z",
      type: "session_meta",
      payload: { id: PRIVATE_CANARY, source: "user" },
    },
    {
      timestamp: "2026-07-27T01:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    },
    {
      timestamp: "2026-07-27T01:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: usage, last_token_usage: usage },
        rate_limits: {
          limit_id: "codex",
          plan_type: "pro",
          primary: {
            used_percent: 20,
            window_minutes: 10_080,
            resets_at: 1_785_697_200,
          },
        },
      },
    },
  ];
  await writeFile(
    join(sessions, "rollout-synthetic.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { mode: 0o600 },
  );
  return { root, profile, localAppData, codexHome, stateRoot };
}

function waitForReady(child, output, timeoutMs = 30_000) {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error("portable companion did not become ready"));
    }, timeoutMs);
    timeout.unref?.();
    const inspect = () => {
      const match = output.stdout.match(/USAGE_MONITOR_READY (http:\/\/127\.0\.0\.1:\d+\/)\s/u);
      if (!match) return;
      clearTimeout(timeout);
      resolveReady(match[1].replace(/\/$/u, ""));
    };
    child.stdout.on("data", inspect);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      const details = `${output.stderr}\n${output.stdout}`.trim().slice(-4_000);
      rejectReady(new Error(
        `portable companion exited before ready (${code ?? signal})${
          details.length > 0 ? `\n${details}` : ""
        }`,
      ));
    });
    inspect();
  });
}

async function waitForOverview(origin, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/local/overview`);
    if (response.status === 200) return response.json();
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("portable companion overview did not become ready");
}

async function stopPortableCompanion(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((_, rejectTimeout) => {
      const timeout = setTimeout(
        () => rejectTimeout(new Error("portable companion did not exit")),
        10_000,
      );
      timeout.unref?.();
    }),
  ]).catch(async (error) => {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => {});
    throw error;
  });
}

async function runPortableRefresh(origin, timeoutMs = 120_000) {
  const started = await fetch(`${origin}/api/local/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "X-Usage-Monitor-Local": "1",
    },
    // Match the native launch-refresh request byte for byte so this process
    // regression covers the same authorized mutation contract as the app.
    body: '{"reason":"user_request"}',
  });
  assert.equal(started.status, 202);
  let payload = await started.json();
  const deadline = Date.now() + timeoutMs;
  while (["running", "cancelling"].includes(payload.refresh?.status)
      && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    payload = await fetch(`${origin}/api/local/refresh`)
      .then((response) => response.json());
  }
  assert.equal(
    ["running", "cancelling"].includes(payload.refresh?.status),
    false,
    "portable companion refresh did not become terminal",
  );
  return payload.refresh;
}

function portableEnvironment(files) {
  const environment = {
    ...process.env,
    HOME: files.profile,
    USERPROFILE: files.profile,
    LOCALAPPDATA: files.localAppData,
    USAGE_MONITOR_RESOURCE_ROOT: REPOSITORY_ROOT,
    USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    USAGE_MONITOR_PORT: "0",
  };
  delete environment.CODEX_HOME;
  delete environment.USAGE_MONITOR_CENTRAL_ORIGIN;
  return environment;
}

function startPortableCompanion(files, codexHomes, primaryCodexHome) {
  const output = { stdout: "", stderr: "" };
  const args = ["apps/local/server.js"];
  for (const codexHome of codexHomes) {
    args.push("--codex-home", codexHome);
  }
  args.push("--primary-codex-home", primaryCodexHome);
  const child = spawn(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    env: portableEnvironment(files),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output.stdout += chunk; });
  child.stderr.on("data", (chunk) => { output.stderr += chunk; });
  return { child, output };
}

function usage(inputTokens, outputTokens) {
  return {
    input_tokens: inputTokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: 0,
    total_tokens: inputTokens + outputTokens,
  };
}

async function pluralFixture() {
  const root = await mkdtemp(join(tmpdir(), "Tibo Tattle plural recovery "));
  const profile = join(root, "Profile");
  const localAppData = join(profile, "AppData", "Local");
  const stateRoot = join(localAppData, "app-usagemonitor");
  const codexHomes = [
    join(root, "primary", ".codex"),
    join(root, "secondary", ".codex"),
  ];
  await mkdir(profile, { recursive: true, mode: 0o700 });
  for (const [index, codexHome] of codexHomes.entries()) {
    const sessions = join(codexHome, "sessions");
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    await mkdir(join(codexHome, "archived_sessions"), {
      recursive: true,
      mode: 0o700,
    });
    const total = index === 0 ? usage(100, 20) : usage(200, 30);
    const timestamp = index === 0
      ? "2026-08-23T01:00:00.000Z"
      : "2026-08-23T02:00:00.000Z";
    const rows = [
      {
        timestamp,
        type: "session_meta",
        payload: {
          id: index === 0
            ? "11111111-1111-4111-8111-111111111111"
            : "22222222-2222-4222-8222-222222222222",
          source: "user",
        },
      },
      {
        timestamp,
        type: "turn_context",
        payload: {
          model: "gpt-5.6-sol",
          unindexedPrivateCanary: PRIVATE_CANARY,
        },
      },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: total,
            last_token_usage: total,
          },
          rate_limits: null,
        },
      },
    ];
    await writeFile(
      join(sessions, `rollout-plural-${index}.jsonl`),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      { mode: 0o600 },
    );
  }
  return { root, profile, localAppData, stateRoot, codexHomes };
}

async function downgradeUnifiedIndexToFeatureV9(indexFile) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(indexFile);
  try {
    const owners = database.prepare(`
      SELECT hex(owner_local) AS owner FROM source_cursor
      ORDER BY owner`).all().map((row) => row.owner);
    const usageEvents = Number(database.prepare(
      "SELECT COUNT(*) AS count FROM usage_event",
    ).get().count);
    assert.equal(owners.length, 2);
    assert.ok(owners.every((owner) => owner.length === 64));
    assert.equal(usageEvents, 2);

    database.exec(`
      BEGIN IMMEDIATE;
      DROP TABLE generation_issue_group;
      DROP TABLE generation_issue;
      ALTER TABLE index_generation DROP COLUMN skipped_source_count;
      ALTER TABLE index_generation DROP COLUMN skipped_source_bytes;
      ALTER TABLE index_generation DROP COLUMN skipped_thread_count;
      ALTER TABLE source_cursor DROP COLUMN source_dev;
      ALTER TABLE source_cursor DROP COLUMN source_ino;
      ALTER TABLE source_cursor DROP COLUMN source_birthtime_ms;
      ALTER TABLE source_cursor DROP COLUMN source_ctime_ms;
      ALTER TABLE source_cursor DROP COLUMN source_identity_token;
      ALTER TABLE source_cursor DROP COLUMN source_state_token;
      ALTER TABLE source_cursor DROP COLUMN quarantine_code;

      ALTER TABLE source_diagnostic RENAME TO source_diagnostic_current;
      CREATE TABLE source_diagnostic(
        generation_id INTEGER NOT NULL REFERENCES index_generation ON DELETE CASCADE,
        source_local BLOB NOT NULL CHECK(length(source_local) = 32),
        code TEXT NOT NULL CHECK(code IN (
          'relevantLines', 'malformedLines', 'malformedTimestamps',
          'partialLines', 'salvagedRecords', 'turnContexts', 'tokenCounts',
          'forkReplayEventsSkipped', 'unattributedForkReplayEventsSkipped',
          'cumulativeCounterRegressions', 'tierEvents', 'modelSeededFromLineage',
          'tierSeededFromLineage', 'modelMissing', 'oversizedLines',
          'contradictedLeadingSnapshotsSkipped', 'toolRecords', 'toolEvents',
          'toolRecordsSkipped', 'toolSourceHistoryUnavailable')),
        count INTEGER NOT NULL CHECK(count >= 0),
        PRIMARY KEY(generation_id, source_local, code)) STRICT, WITHOUT ROWID;
      INSERT INTO source_diagnostic(generation_id, source_local, code, count)
        SELECT generation_id, source_local, code, count
        FROM source_diagnostic_current
        WHERE code NOT IN (
          'malformedAccountingRecords', 'malformedUsageRecords',
          'malformedRateLimitRecords');
      DROP TABLE source_diagnostic_current;

      DELETE FROM meta WHERE key IN (
        'source_identity_version', 'rollout_quarantine_fingerprint');
      UPDATE parser_version
      SET parser_version = CASE
        WHEN parser_version LIKE '%-partial' THEN 'unified-rollout-typed-v8-partial'
        ELSE 'unified-rollout-typed-v8'
      END;
      PRAGMA user_version=9;
      COMMIT;
    `);

    assert.equal(
      Number(database.prepare("PRAGMA user_version").get().user_version),
      9,
    );
    assert.equal(database.prepare(
      "SELECT value FROM meta WHERE key = 'source_identity_version'",
    ).get(), undefined);
    assert.equal(database.prepare(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    ).get().value, "local-unified-index-v2");
    assert.equal(database.prepare(
      "SELECT DISTINCT parser_version FROM parser_version",
    ).get().parser_version, "unified-rollout-typed-v8");
    const columns = new Set(database.prepare(
      "PRAGMA table_info(source_cursor)",
    ).all().map((column) => column.name));
    assert.equal(columns.has("owner_local"), true);
    for (const column of [
      "source_dev",
      "source_ino",
      "source_birthtime_ms",
      "source_ctime_ms",
      "source_identity_token",
      "source_state_token",
      "quarantine_code",
    ]) assert.equal(columns.has(column), false, column);
    const generationColumns = new Set(database.prepare(
      "PRAGMA table_info(index_generation)",
    ).all().map((column) => column.name));
    for (const column of [
      "skipped_source_count",
      "skipped_source_bytes",
      "skipped_thread_count",
    ]) assert.equal(generationColumns.has(column), false, column);
    for (const table of ["generation_issue", "generation_issue_group"]) {
      assert.equal(database.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table), undefined, table);
    }
    const diagnosticSql = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'source_diagnostic'
    `).get().sql;
    assert.match(diagnosticSql, /toolSourceHistoryUnavailable/u);
    assert.doesNotMatch(diagnosticSql, /malformedAccountingRecords/u);
    assert.doesNotMatch(diagnosticSql, /malformedUsageRecords/u);
    assert.doesNotMatch(diagnosticSql, /malformedRateLimitRecords/u);
    assert.deepEqual(database.prepare(`
      SELECT hex(owner_local) AS owner FROM source_cursor
      ORDER BY owner`).all().map((row) => row.owner), owners);
    assert.equal(Number(database.prepare(
      "SELECT COUNT(*) AS count FROM usage_event",
    ).get().count), usageEvents);
    return { owners, usageEvents };
  } finally {
    database.close();
  }
}

test("local companion runs as a private synthetic child process and shuts down", async () => {
  const files = await fixture();
  const output = { stdout: "", stderr: "" };
  const environment = {
    ...process.env,
    HOME: files.profile,
    USERPROFILE: files.profile,
    LOCALAPPDATA: files.localAppData,
    CODEX_HOME: files.codexHome,
    USAGE_MONITOR_RESOURCE_ROOT: REPOSITORY_ROOT,
    USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    USAGE_MONITOR_PORT: "0",
  };
  delete environment.USAGE_MONITOR_CENTRAL_ORIGIN;
  const child = spawn(process.execPath, ["apps/local/server.js"], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output.stdout += chunk; });
  child.stderr.on("data", (chunk) => { output.stderr += chunk; });
  try {
    const origin = await waitForReady(child, output);
    const health = await fetch(`${origin}/api/local/health`).then((response) => response.json());
    const onboarding = await fetch(`${origin}/api/local/onboarding`).then((response) => response.json());
    const overview = await waitForOverview(origin);
    const paceResponse = await fetch(
      `${origin}/api/local/weekly-pace-outlook`,
    );
    const pace = await paceResponse.json();
    const refresh = await fetch(`${origin}/api/local/refresh`).then((response) => response.json());
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.equal(health.capabilities.localDashboard, true);
    assert.equal(health.capabilities.centralServiceProxy, false);
    assert.equal(health.capabilities.centralParticipantRelay, false);
    assert.equal(onboarding.status, "ready");
    assert.equal(onboarding.capabilities.customCodexHomeConfigured, true);
    assert.equal(overview.mode, "real_local_evidence");
    assert.equal(paceResponse.status, 200);
    assert.deepEqual(Object.keys(pace).sort(), ["schemaVersion", "weekly"]);
    assert.deepEqual(Object.keys(pace.weekly), ["paceOutlook"]);
    assert.ok(JSON.stringify(pace).length < 64 * 1_024);
    assert.equal(typeof refresh.refresh?.status, "string");
    const publicEvidence = JSON.stringify({
      health,
      onboarding,
      overview,
      pace,
      refresh,
    });
    assert.equal(publicEvidence.includes(PRIVATE_CANARY), false);
    assert.equal(publicEvidence.includes(files.root), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        new Promise((_, rejectTimeout) => {
          const timeout = setTimeout(
            () => rejectTimeout(new Error("portable companion did not exit")),
            10_000,
          );
          timeout.unref?.();
        }),
      ]).catch(async (error) => {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => {});
        throw error;
      });
    }
    assert.equal(`${output.stdout}\n${output.stderr}`.includes(PRIVATE_CANARY), false);
    await rm(files.root, { recursive: true, force: true });
  }
});

test("portable refresh recovers a populated feature-v9 index after restart", async () => {
  const files = await pluralFixture();
  const [primaryCodexHome] = files.codexHomes;
  const indexFile = join(files.stateRoot, "local-unified-index-v1.sqlite");
  let active = null;
  try {
    active = startPortableCompanion(
      files,
      files.codexHomes,
      primaryCodexHome,
    );
    const initialOrigin = await waitForReady(active.child, active.output);
    const initialRefresh = await runPortableRefresh(initialOrigin);
    assert.equal(initialRefresh.status, "succeeded");
    const initialOverview = await waitForOverview(initialOrigin, 120_000);
    const initialAll = initialOverview.usage.find(({ id }) => id === "all");
    assert.equal(initialOverview.accounting.sourceMode, "unified");
    assert.equal(initialOverview.accounting.generationMatched, true);
    assert.equal(initialAll.events, 2);
    assert.equal(initialAll.totalTokens, 350);
    await stopPortableCompanion(active.child);
    active = null;

    const legacy = await downgradeUnifiedIndexToFeatureV9(indexFile);
    active = startPortableCompanion(
      files,
      files.codexHomes,
      primaryCodexHome,
    );
    const recoveredOrigin = await waitForReady(active.child, active.output);

    // Starting the process is read-only with respect to this migration. The
    // authorized refresh below owns the staged rebuild and publication.
    {
      const { DatabaseSync } = await import("node:sqlite");
      const beforeRefresh = new DatabaseSync(indexFile, { readOnly: true });
      try {
        assert.equal(
          Number(beforeRefresh.prepare("PRAGMA user_version").get().user_version),
          9,
        );
        assert.equal(Number(beforeRefresh.prepare(
          "SELECT COUNT(*) AS count FROM usage_event",
        ).get().count), legacy.usageEvents);
      } finally {
        beforeRefresh.close();
      }
    }

    const recoveredRefresh = await runPortableRefresh(recoveredOrigin);
    assert.equal(recoveredRefresh.status, "succeeded");
    assert.equal(recoveredRefresh.result.unifiedIndex.unchanged, false);
    assert.equal(
      recoveredRefresh.result.unifiedIndex.sourcesRescanned,
      legacy.owners.length,
    );
    assert.equal(
      recoveredRefresh.result.unifiedIndex.insertedUsageEvents,
      legacy.usageEvents,
    );
    assert.equal(
      recoveredRefresh.result.unifiedIndex.totalUsageEvents,
      legacy.usageEvents,
    );
    assert.equal(
      recoveredRefresh.result.unifiedIndex.generation.status,
      "complete",
    );

    const recoveredOverview = await waitForOverview(recoveredOrigin, 120_000);
    const recoveredAll = recoveredOverview.usage.find(({ id }) => id === "all");
    assert.equal(recoveredOverview.accounting.sourceMode, "unified");
    assert.equal(recoveredOverview.accounting.generationMatched, true);
    assert.equal(recoveredOverview.accounting.historyCoverage.status, "complete");
    assert.equal(
      recoveredOverview.accounting.historyCoverage.sourceMode,
      "unified",
    );
    assert.equal(recoveredAll.events, 2);
    assert.equal(recoveredAll.totalTokens, 350);

    {
      const { DatabaseSync } = await import("node:sqlite");
      const current = new DatabaseSync(indexFile, { readOnly: true });
      try {
        assert.equal(
          Number(current.prepare("PRAGMA user_version").get().user_version),
          11,
        );
        assert.equal(current.prepare(
          "SELECT value FROM meta WHERE key = 'source_identity_version'",
        ).get().value, "codex-immutable-rollout-v1");
        const columns = new Set(current.prepare(
          "PRAGMA table_info(source_cursor)",
        ).all().map((column) => column.name));
        for (const column of [
          "owner_local",
          "source_dev",
          "source_ino",
          "source_birthtime_ms",
          "source_ctime_ms",
          "source_identity_token",
          "source_state_token",
          "quarantine_code",
        ]) assert.ok(columns.has(column), column);
        const generationColumns = new Set(current.prepare(
          "PRAGMA table_info(index_generation)",
        ).all().map((column) => column.name));
        for (const column of [
          "skipped_source_count",
          "skipped_source_bytes",
          "skipped_thread_count",
        ]) assert.ok(generationColumns.has(column), column);
        current.prepare(
          "SELECT COUNT(*) AS count FROM generation_issue",
        ).get();
        current.prepare(
          "SELECT COUNT(*) AS count FROM generation_issue_group",
        ).get();
        const diagnosticSql = current.prepare(`
          SELECT sql FROM sqlite_master
          WHERE type = 'table' AND name = 'source_diagnostic'
        `).get().sql;
        assert.match(diagnosticSql, /malformedAccountingRecords/u);
        assert.match(diagnosticSql, /malformedUsageRecords/u);
        assert.match(diagnosticSql, /malformedRateLimitRecords/u);
        assert.equal(current.prepare(
          "SELECT DISTINCT parser_version FROM parser_version",
        ).get().parser_version, "unified-rollout-typed-v10");
        assert.deepEqual(current.prepare(`
          SELECT hex(owner_local) AS owner FROM source_cursor
          ORDER BY owner`).all().map((row) => row.owner), legacy.owners);
        assert.equal(Number(current.prepare(
          "SELECT COUNT(*) AS count FROM usage_event",
        ).get().count), legacy.usageEvents);
      } finally {
        current.close();
      }
    }

    const publicEvidence = JSON.stringify({
      refresh: recoveredRefresh,
      overview: recoveredOverview,
    });
    assert.equal(publicEvidence.includes(PRIVATE_CANARY), false);
    for (const path of [files.root, files.stateRoot, ...files.codexHomes]) {
      assert.equal(publicEvidence.includes(path), false);
    }
    assert.equal(
      `${active.output.stdout}\n${active.output.stderr}`.includes(PRIVATE_CANARY),
      false,
    );
  } finally {
    if (active) await stopPortableCompanion(active.child).catch(() => {});
    await rm(files.root, { recursive: true, force: true });
  }
});

test("plural companion retains combined history when the selected primary is unavailable", async () => {
  const files = await pluralFixture();
  const [primaryCodexHome] = files.codexHomes;
  const parkedPrimary = `${primaryCodexHome}-temporarily-unavailable`;
  let active = null;
  try {
    active = startPortableCompanion(
      files,
      files.codexHomes,
      primaryCodexHome,
    );
    const initialOrigin = await waitForReady(active.child, active.output);
    const initialRefresh = await runPortableRefresh(initialOrigin);
    assert.equal(initialRefresh.status, "succeeded");
    assert.deepEqual(
      initialRefresh.result.unifiedIndex.rootCoverage,
      {
        status: "ready",
        configuredRoots: 2,
        availableRoots: 2,
        emptyRoots: 0,
        unavailableRoots: 0,
        retainedHistory: false,
        unavailableOwnerSources: 0,
        ambiguousSources: 0,
      },
    );
    const initialOverview = await waitForOverview(initialOrigin, 120_000);
    const initialAll = initialOverview.usage.find(({ id }) => id === "all");
    assert.equal(initialAll.events, 2);
    assert.equal(initialAll.totalTokens, 350);
    await stopPortableCompanion(active.child);
    active = null;

    await rename(primaryCodexHome, parkedPrimary);
    active = startPortableCompanion(
      files,
      files.codexHomes,
      primaryCodexHome,
    );
    const degradedOrigin = await waitForReady(active.child, active.output);
    const [onboarding, retainedOverview] = await Promise.all([
      fetch(`${degradedOrigin}/api/local/onboarding`)
        .then((response) => response.json()),
      waitForOverview(degradedOrigin, 120_000),
    ]);
    assert.equal(onboarding.status, "ready");
    assert.equal(onboarding.source.availability, "partial");
    assert.equal(onboarding.source.availableRoots, 1);
    assert.equal(onboarding.source.unavailableRoots, 1);
    assert.deepEqual(retainedOverview.quota, {
      status: "unavailable",
      observedAt: null,
      windows: [],
    });
    const retainedAll = retainedOverview.usage.find(({ id }) => id === "all");
    assert.equal(retainedAll.events, 2);
    assert.equal(retainedAll.totalTokens, 350);

    const degradedRefresh = await runPortableRefresh(degradedOrigin);
    assert.equal(degradedRefresh.status, "succeeded");
    assert.equal(degradedRefresh.result.quotaRefresh.recordWritten, false);
    assert.equal(
      degradedRefresh.result.quotaRefresh.errorCode,
      "collection_failed",
    );
    assert.deepEqual(
      degradedRefresh.result.unifiedIndex.rootCoverage,
      {
        status: "partial",
        configuredRoots: 2,
        availableRoots: 1,
        emptyRoots: 0,
        unavailableRoots: 1,
        retainedHistory: true,
        unavailableOwnerSources: 1,
        ambiguousSources: 0,
      },
    );
    assert.equal(
      degradedRefresh.result.unifiedIndex.totalUsageEvents,
      2,
    );
    const finalOverview = await waitForOverview(degradedOrigin, 120_000);
    const finalAll = finalOverview.usage.find(({ id }) => id === "all");
    assert.equal(finalAll.events, 2);
    assert.equal(finalAll.totalTokens, 350);
    const publicEvidence = JSON.stringify({
      onboarding,
      refresh: degradedRefresh,
      overview: {
        quota: finalOverview.quota,
        events: finalAll.events,
        totalTokens: finalAll.totalTokens,
      },
    });
    for (const path of files.codexHomes) {
      assert.equal(publicEvidence.includes(path), false);
    }
  } finally {
    if (active) await stopPortableCompanion(active.child).catch(() => {});
    await rename(parkedPrimary, primaryCodexHome).catch(() => {});
    await rm(files.root, { recursive: true, force: true });
  }
});
