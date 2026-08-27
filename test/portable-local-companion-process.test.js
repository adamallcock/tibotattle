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
      rejectReady(new Error(`portable companion exited before ready (${code ?? signal})`));
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
    body: "{}",
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
        payload: { model: "gpt-5.6-sol" },
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
    const refresh = await fetch(`${origin}/api/local/refresh`).then((response) => response.json());
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.equal(health.capabilities.localDashboard, true);
    assert.equal(health.capabilities.centralServiceProxy, false);
    assert.equal(health.capabilities.centralParticipantRelay, false);
    assert.equal(onboarding.status, "ready");
    assert.equal(onboarding.capabilities.customCodexHomeConfigured, true);
    assert.equal(overview.mode, "real_local_evidence");
    assert.equal(typeof refresh.refresh?.status, "string");
    const publicEvidence = JSON.stringify({ health, onboarding, overview, refresh });
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
