import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import {
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
} from "../src/local-unified-index.js";
import { readLocalWorkUsageSnapshot } from "../src/local-work-usage-source.js";
import { extractRolloutWorkContexts } from "../src/local-unified-index-extract.js";
import { queryWorkUsageSnapshot } from "../src/reporting/index.js";

const execFileAsync = promisify(execFile);
const CONTRACT = "usage-event-v0.2";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";

function usage(input, output = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

function sessionMeta(cwd) {
  return {
    timestamp: "2026-08-24T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: THREAD_ID,
      session_id: THREAD_ID,
      thread_source: "user",
      originator: "codex_cli_rs",
      cwd,
    },
  };
}

function turnContext(timestamp, cwd, index) {
  return {
    timestamp,
    type: "turn_context",
    payload: {
      turn_id: `turn-${index}`,
      cwd,
      model: "gpt-5.6-sol",
      effort: "high",
    },
  };
}

function tokenCount(timestamp, total, last) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage(total),
        last_token_usage: usage(last),
      },
    },
  };
}

function quotaRateLimits(usedPercent = 12) {
  return {
    limit_id: "codex",
    plan_type: "pro",
    primary: {
      used_percent: usedPercent,
      window_minutes: 300,
      resets_at: 1_785_433_600,
    },
    secondary: {
      used_percent: usedPercent,
      window_minutes: 10_080,
      resets_at: 1_785_433_600,
    },
  };
}

function quotaTokenCount(timestamp, infoMode = "null") {
  const payload = {
    type: "token_count",
    rate_limits: quotaRateLimits(),
  };
  if (infoMode === "null") payload.info = null;
  if (infoMode === "object") {
    payload.info = {
      total_token_usage: null,
      last_token_usage: null,
    };
  }
  return { timestamp, type: "event_msg", payload };
}

function quotaTokenCountWithInfo(timestamp, total, last) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
      },
      rate_limits: quotaRateLimits(),
    },
  };
}

function contradictoryUsage() {
  return {
    input_tokens: 110,
    cached_input_tokens: 60,
    cache_write_input_tokens: 60,
    output_tokens: 5,
    reasoning_output_tokens: 6,
    total_tokens: 115,
  };
}

async function git(args, cwd) {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer: 64 * 1024,
  });
}


async function modifySourceSameSize(path) {
  const bytes = await readFile(path);
  const marker = Buffer.from("gpt-5.6-sol");
  const offset = bytes.indexOf(marker);
  assert.ok(offset >= 0, "synthetic model marker must be present");
  const last = offset + marker.length - 1;
  bytes[last] = bytes[last] === 0x6c ? 0x6d : 0x6c;
  await writeFile(path, bytes, { mode: 0o600 });
}

async function makeFixture({ events, useCustomSecret = false }) {
  const root = await mkdtemp(join(tmpdir(), "work-usage-source-"));
  const codexHome = join(root, "codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "24");
  const archived = join(codexHome, "archived_sessions");
  const repository = join(root, "main");
  const worktree = join(root, "feature-worktree");
  const secretFile = useCustomSecret ? join(root, "custom-device-salt") : null;
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  await mkdir(archived, { recursive: true, mode: 0o700 });
  await mkdir(repository, { recursive: true });
  await git(["init", "-q"], repository);
  await git(["config", "user.email", "fixture@example.invalid"], repository);
  await git(["config", "user.name", "Synthetic Fixture"], repository);
  await writeFile(join(repository, "README.md"), "synthetic fixture\n");
  await git(["add", "README.md"], repository);
  await git(["commit", "-qm", "fixture"], repository);
  await git(["branch", "-M", "main"], repository);
  await git(
    ["worktree", "add", "-q", "-b", "feature", worktree, "HEAD"],
    repository,
  );

  const lines = [sessionMeta(repository)];
  for (const [index, item] of events.entries()) {
    const cwd = item.cwd === "WORKTREE" ? worktree : (item.cwd ?? repository);
    if (item.context === "settings") {
      lines.push({ timestamp: item.timestamp, type: "event_msg", payload: {
        type: "thread_settings_applied", thread_settings: { cwd, model: "gpt-5.6-sol" },
      } });
    } else if (item.context !== "none") {
      lines.push(turnContext(item.timestamp, cwd, index + 1));
    }
    if (item.kind === "quota-only") {
      lines.push(quotaTokenCount(item.timestamp, item.infoMode ?? "null"));
    } else if (item.kind === "all-null-info-quota") {
      lines.push(quotaTokenCount(item.timestamp, "object"));
    } else if (item.kind === "quota-repeat") {
      lines.push(
        quotaTokenCountWithInfo(
          item.timestamp,
          usage(item.total),
          usage(item.last),
        ),
      );
    } else if (item.kind === "quota-first-baseline") {
      lines.push(
        quotaTokenCountWithInfo(item.timestamp, usage(item.total), null),
      );
    } else if (item.kind === "quota-contradictory") {
      const value = contradictoryUsage();
      lines.push(quotaTokenCountWithInfo(item.timestamp, value, value));
    } else {
      lines.push(tokenCount(item.timestamp, item.total, item.last));
    }
  }
  const rolloutPath = join(
    sessions,
    "rollout-2026-08-24T00-00-00-thread.jsonl",
  );
  await writeFile(
    rolloutPath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    { mode: 0o600 },
  );
  const indexFile = join(root, "index.sqlite");
  if (secretFile !== null) {
    await writeFile(secretFile, Buffer.alloc(32, 0x5a), { mode: 0o600 });
  }
  const buildOptions = {
    codexHome,
    indexFile,
    contractVersion: CONTRACT,
    workerCount: 1,
  };
  if (secretFile !== null) buildOptions.secretFile = secretFile;
  await rebuildLocalUnifiedIndex(buildOptions);
  return {
    root,
    codexHome,
    sessions,
    repository,
    worktree,
    rolloutPath,
    indexFile,
    secretFile,
  };
}

function interval(start, end) {
  return { fromMs: Date.parse(start), toMs: Date.parse(end) };
}

function query(result, grouping) {
  return queryWorkUsageSnapshot(result, {
    grouping,
    sort: "tokens",
    offset: 0,
    pageSize: 100,
  });
}

function markToolingOnlyPartial(indexFile) {
  const database = openLocalUnifiedIndex(indexFile, { readOnly: false });
  try {
    database
      .prepare(
        `
      UPDATE index_generation
      SET status = 'partial', block_reason = 'tool_provenance_incomplete',
          tool_provenance_complete = 0, usage_provenance_complete = 1
      WHERE id = (SELECT CAST(value AS INTEGER) FROM meta
                  WHERE key = 'current_generation_id')
    `,
      )
      .run();
    database
      .prepare("UPDATE meta SET value = 'partial' WHERE key = 'status'")
      .run();
    return readUnifiedIndexGenerationDescriptor(database);
  } finally {
    database.close();
  }
}

test("canonical source resolves main and linked worktree to one project and conserves 100/300", async () => {
  const fixture = await makeFixture({
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        cwd: null,
        total: 100,
        last: 100,
      },
      {
        timestamp: "2026-08-24T00:00:03.000Z",
        cwd: "WORKTREE",
        total: 400,
        last: 300,
      },
    ],
  });

  try {
    const beforeRollout = await readFile(fixture.rolloutPath);
    const beforeIndex = await readFile(fixture.indexFile);
    const result = await readLocalWorkUsageSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:05.000Z"),
    });
    assert.equal(result.status, "available");
    assert.deepEqual(await readFile(fixture.rolloutPath), beforeRollout);
    assert.deepEqual(await readFile(fixture.indexFile), beforeIndex);

    const projectEntries = Object.entries(result.display.projects);
    const worktreeEntries = Object.entries(result.display.worktrees);
    assert.equal(projectEntries.length, 1);
    assert.equal(projectEntries[0][1].name, "main");
    assert.equal(projectEntries[0][1].method, "git_observation");
    assert.deepEqual(worktreeEntries.map(([, value]) => value.name).sort(), [
      "feature-worktree",
      "main",
    ]);

    const projects = query(result, "project");
    const worktrees = query(result, "worktree");
    const threads = query(result, "thread");
    assert.equal(projects.totals.tokens, 400);
    assert.equal(projects.rows.length, 1);
    assert.equal(projects.rows[0].tokens, 400);
    assert.deepEqual(
      worktrees.rows.map((row) => row.tokens).sort((a, b) => a - b),
      [100, 300],
    );
    assert.equal(
      worktrees.rows.reduce((sum, row) => sum + row.tokens, 0),
      400,
    );
    assert.equal(threads.rows.length, 1);
    assert.equal(threads.rows[0].tokens, 400);
    assert.equal(threads.rows[0].projects.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});


test("same-inode append growth leaves the indexed prefix attributable and excludes new usage", async () => {
  const fixture = await makeFixture({
    events: [{
      timestamp: "2026-08-24T00:00:01.000Z",
      total: 100,
      last: 100,
    }],
  });
  try {
    const beforeIndex = await readFile(fixture.indexFile);
    const database = openLocalUnifiedIndex(fixture.indexFile, { readOnly: true });
    let indexedBytes;
    try {
      indexedBytes = Number(database.prepare(
        "SELECT scanned_bytes FROM source_cursor ORDER BY source_local LIMIT 1",
      ).get().scanned_bytes);
    } finally {
      database.close();
    }
    const beforeRollout = await readFile(fixture.rolloutPath);
    assert.equal(indexedBytes, beforeRollout.length);
    await appendFile(fixture.rolloutPath, `${[
      JSON.stringify(turnContext("2026-08-24T00:00:04.000Z", fixture.repository, 2)),
      JSON.stringify(tokenCount("2026-08-24T00:00:05.000Z", 200, 100)),
    ].join("\n")}\n`);
    assert.ok((await readFile(fixture.rolloutPath)).length > indexedBytes);

    const result = await readLocalWorkUsageSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:06.000Z"),
    });
    assert.equal(result.status, "available");
    assert.equal(result.metadata.status, "available");
    assert.equal(result.metadata.inspectedSources, 1);
    assert.equal(result.metadata.indexedSources, 1);
    const projectEntries = Object.entries(result.display.projects);
    assert.equal(projectEntries.length, 1);
    assert.equal(projectEntries[0][1].name, "main");
    assert.equal(projectEntries[0][1].method, "git_observation");
    const projects = query(result, "project");
    assert.equal(projects.totals.tokens, 100);
    assert.equal(projects.totals.events, 1);
    assert.equal(projects.totals.incompleteEvents, 0);
    assert.equal(projects.rows[0].tokens, 100);
    assert.deepEqual(await readFile(fixture.indexFile), beforeIndex);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});


test("quota-only token counts stay retained in the index without changing known work usage", async () => {
  const fixture = await makeFixture({
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        total: 100,
        last: 100,
      },
      {
        timestamp: "2026-08-24T00:00:02.000Z",
        kind: "quota-only",
        infoMode: "null",
      },
      {
        timestamp: "2026-08-24T00:00:03.000Z",
        kind: "quota-only",
        infoMode: "absent",
      },
    ],
  });
  try {
    const beforeIndex = await readFile(fixture.indexFile);
    const database = openLocalUnifiedIndex(fixture.indexFile, { readOnly: true });
    let quotaUsageRows;
    let quotaObservations;
    try {
      quotaUsageRows = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM usage_event WHERE quota_observation_id IS NOT NULL",
      ).get().count);
      quotaObservations = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM quota_observation",
      ).get().count);
    } finally {
      database.close();
    }
    assert.equal(quotaUsageRows, 2);
    assert.ok(quotaObservations >= 2);

    const result = await readLocalWorkUsageSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:04.000Z"),
    });
    assert.equal(result.status, "available");
    assert.deepEqual(await readFile(fixture.indexFile), beforeIndex);
    const projects = query(result, "project");
    assert.equal(projects.totals.tokens, 100);
    assert.equal(projects.totals.events, 1);
    assert.equal(projects.totals.incompleteEvents, 0);
    assert.equal(projects.totals.unknownEvents, 0);
    assert.equal(projects.rows.length, 1);
    assert.equal(projects.rows[0].tokens, 100);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("all-null token info with quota remains an unknown work event", async () => {
  const fixture = await makeFixture({
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        total: 100,
        last: 100,
      },
      {
        timestamp: "2026-08-24T00:00:02.000Z",
        kind: "all-null-info-quota",
      },
    ],
  });
  try {
    const result = await readLocalWorkUsageSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:03.000Z"),
    });
    assert.equal(result.status, "available");
    const projects = query(result, "project");
    assert.equal(projects.totals.tokens, 100);
    assert.equal(projects.totals.events, 2);
    assert.equal(projects.totals.incompleteEvents, 1);
    assert.equal(projects.totals.unknownEvents, 1);
    assert.equal(projects.rows.length, 1);
    assert.equal(projects.rows[0].tokens, 100);
    assert.equal(projects.rows[0].incompleteEvents, 1);
    assert.equal(projects.rows[0].unknownEvents, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing or changed quota-only sources fail closed as unknown retained usage", async () => {
  for (const mode of ["removed", "changed"]) {
    const fixture = await makeFixture({
      events: [
        {
          timestamp: "2026-08-24T00:00:01.000Z",
          total: 100,
          last: 100,
        },
        {
          timestamp: "2026-08-24T00:00:02.000Z",
          kind: "quota-only",
        },
      ],
    });
    try {
      if (mode === "removed") await rm(fixture.rolloutPath);
      else await modifySourceSameSize(fixture.rolloutPath);
      const result = await readLocalWorkUsageSnapshot({
        indexFile: fixture.indexFile,
        codexHome: fixture.codexHome,
        ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:03.000Z"),
      });
      assert.equal(result.status, "available", mode);
      assert.equal(result.metadata.status, "partial", mode);
      const projects = query(result, "project");
      assert.equal(projects.totals.tokens, 100, mode);
      assert.equal(projects.totals.events, 2, mode);
      assert.equal(projects.totals.incompleteEvents, 1, mode);
      assert.equal(projects.totals.unknownEvents, 1, mode);
      assert.equal(projects.rows.length, 1, mode);
      assert.equal(projects.rows[0].id, "unassigned", mode);
      assert.equal(projects.rows[0].unknownEvents, 1, mode);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});


test("an exact repeated cumulative snapshot with quota is status-only, while growth remains usage", async () => {
  const fixture = await makeFixture({
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        total: 100,
        last: 100,
      },
      {
        timestamp: "2026-08-24T00:00:02.000Z",
        kind: "quota-repeat",
        total: 100,
        last: 100,
      },
      {
        timestamp: "2026-08-24T00:00:03.000Z",
        kind: "quota-repeat",
        total: 200,
        last: 100,
      },
    ],
  });
  try {
    const beforeIndex = await readFile(fixture.indexFile);
    const database = openLocalUnifiedIndex(fixture.indexFile, { readOnly: true });
    let usageRows;
    let quotaUsageRows;
    try {
      usageRows = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM usage_event",
      ).get().count);
      quotaUsageRows = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM usage_event WHERE quota_observation_id IS NOT NULL",
      ).get().count);
    } finally {
      database.close();
    }
    assert.equal(usageRows, 3);
    assert.equal(quotaUsageRows, 2);

    const result = await readLocalWorkUsageSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:04.000Z"),
    });
    assert.equal(result.status, "available");
    assert.deepEqual(await readFile(fixture.indexFile), beforeIndex);
    const projects = query(result, "project");
    assert.equal(projects.totals.tokens, 200);
    assert.equal(projects.totals.events, 2);
    assert.equal(projects.totals.incompleteEvents, 0);
    assert.equal(projects.totals.unknownEvents, 0);
    assert.equal(projects.rows.length, 1);
    assert.equal(projects.rows[0].tokens, 200);
    assert.equal(projects.rows[0].events, 2);
    assert.equal(projects.rows[0].incompleteEvents, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a quota row used as the first cumulative baseline without last usage stays unknown", async () => {
  const fixture = await makeFixture({
    events: [{
      timestamp: "2026-08-24T00:00:01.000Z",
      kind: "quota-first-baseline",
      total: 100,
    }],
  });
  try {
    const result = await readLocalWorkUsageSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:02.000Z"),
    });
    assert.equal(result.status, "available");
    const projects = query(result, "project");
    assert.equal(projects.totals.tokens, null);
    assert.equal(projects.totals.events, 1);
    assert.equal(projects.totals.incompleteEvents, 1);
    assert.equal(projects.totals.unknownEvents, 1);
    assert.equal(projects.rows.length, 1);
    assert.equal(projects.rows[0].tokens, null);
    assert.equal(projects.rows[0].unknownEvents, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("contradictory complete counters that canonicalize to all-null stay unknown with quota", async () => {
  const fixture = await makeFixture({
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        total: 100,
        last: 100,
      },
      {
        timestamp: "2026-08-24T00:00:02.000Z",
        kind: "quota-contradictory",
      },
    ],
  });
  try {
    const result = await readLocalWorkUsageSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:03.000Z"),
    });
    assert.equal(result.status, "available");
    const projects = query(result, "project");
    assert.equal(projects.totals.tokens, 100);
    assert.equal(projects.totals.events, 2);
    assert.equal(projects.totals.incompleteEvents, 1);
    assert.equal(projects.totals.unknownEvents, 1);
    assert.equal(projects.rows.length, 1);
    assert.equal(projects.rows[0].tokens, 100);
    assert.equal(projects.rows[0].unknownEvents, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("tooling-only partial generation retains complete known usage", async () => {
  const fixture = await makeFixture({
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        total: 120,
        last: 120,
      },
    ],
  });
  try {
    const generation = markToolingOnlyPartial(fixture.indexFile);
    assert.equal(generation.status, "partial");
    assert.equal(generation.blockReason, "tool_provenance_incomplete");
    assert.equal(generation.toolProvenanceComplete, false);
    assert.equal(generation.usageProvenanceComplete, true);

    const result = await readLocalWorkUsageSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:02.000Z"),
    });
    assert.equal(result.status, "available");
    assert.equal(result.generation.status, "partial");
    assert.equal(result.generation.blockReason, "tool_provenance_incomplete");
    assert.equal(result.generation.usageProvenanceComplete, true);
    const projects = query(result, "project");
    assert.equal(projects.totals.tokens, 120);
    assert.equal(projects.totals.events, 1);
    assert.equal(projects.rows[0].incompleteEvents, 0);
    assert.equal(projects.rows[0].unknownEvents, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source honors an existing custom salt and keeps account scope handles stable", async () => {
  const fixture = await makeFixture({
    useCustomSecret: true,
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        total: 120,
        last: 120,
      },
    ],
  });
  try {
    const beforeSecret = await readFile(fixture.secretFile);
    const request = {
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      secretFile: fixture.secretFile,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:02.000Z"),
    };
    const first = await readLocalWorkUsageSnapshot(request);
    const second = await readLocalWorkUsageSnapshot({
      ...request,
      scope: first.scope,
    });
    assert.equal(first.status, "available");
    assert.equal(second.status, "available");
    assert.match(first.scope, /^scope-[0-9a-f]{64}$/u);
    assert.equal(first.scope, second.scope);
    assert.deepEqual(first.scopes, second.scopes);
    assert.equal(first.scopes[0].id, first.scope);
    assert.equal(query(first, "project").totals.tokens, 120);
    assert.equal(query(second, "project").totals.tokens, 120);
    assert.deepEqual(await readFile(fixture.secretFile), beforeSecret);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("workspace observations preserve sparse updates and invalidate explicit malformed changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-context-"));
  try {
    const lines = [
      sessionMeta("/synthetic/initial"),
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { type: "response_item", payload: { type: "turn_context", cwd: "/synthetic/ignored" } },
      { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { cwd: "/synthetic/next" } } },
      { type: "turn_context", payload: { cwd: "/synthetic/bad\u0000path" } },
      { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-5.6-sol" } } },
      { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: [] } },
      { type: "turn_context", payload: { cwd: "/synthetic/restored" } },
    ].map(row => JSON.stringify(row)).concat('{"type":"turn_context","payload":');
    const bytes = Buffer.from(`${lines.join("\n")}\n`);
    const path = join(root, "synthetic.jsonl");
    await writeFile(path, bytes);
    const observations = [];
    await extractRolloutWorkContexts(path, { end: bytes.length, onContext: row => observations.push(row) });
    assert.deepEqual(observations.map(row => row.cwd), [
      "/synthetic/initial", "/synthetic/next", null, null, "/synthetic/restored", null,
    ]);
    assert.ok(observations.every((row, i) => i === 0 || row.offset > observations[i - 1].offset));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initial session and applied settings directories attribute usage without a turn context", async () => {
  const fixture = await makeFixture({ events: [
    { timestamp: "2026-08-24T00:00:01.000Z", total: 120, last: 120, context: "none" },
    { timestamp: "2026-08-24T00:00:02.000Z", total: 150, last: 30, context: "settings", cwd: "WORKTREE" },
  ] });
  try {
    const result = await readLocalWorkUsageSnapshot({
      indexFile: fixture.indexFile, codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:03.000Z"),
    });
    const projects = query(result, "project");
    assert.equal(projects.rows.length, 1);
    assert.notEqual(projects.rows[0].id, "unassigned");
    assert.equal(projects.totals.tokens, 150);
    const worktrees = query(result, "worktree");
    assert.deepEqual(worktrees.rows.map(row => [result.display.worktrees[row.id].name, row.tokens]).sort(),
      [["feature-worktree", 30], ["main", 120]]);
    // A directory observation cannot manufacture a missing historical model
    // or price, nor apply the later model to the first event.
    const unknown = result.cells.find(cell => cell.models.includes("unknown"));
    assert.equal(unknown.tokens, 120);
    assert.equal(unknown.costUsdExact, null);
    assert.ok(result.cells.some(cell => cell.costUsdExact !== null));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unknown, removed, and changed retained sources keep usage under Unassigned", async () => {
  for (const mode of ["unknown", "removed", "changed"]) {
    const fixture = await makeFixture({
      events: [
        {
          timestamp: "2026-08-24T00:00:01.000Z",
          total: 120,
          last: 120,
        },
      ],
    });
    try {
      let readHome = fixture.codexHome;
      if (mode === "unknown") {
        readHome = join(fixture.root, "unrelated-codex-home");
        await mkdir(join(readHome, "sessions"), {
          recursive: true,
          mode: 0o700,
        });
      } else if (mode === "removed") {
        await rm(fixture.rolloutPath);
      } else {
        await modifySourceSameSize(fixture.rolloutPath);
      }
      const result = await readLocalWorkUsageSnapshot({
        indexFile: fixture.indexFile,
        codexHome: readHome,
        ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:02.000Z"),
      });
      assert.equal(result.status, "available", mode);
      assert.equal(result.metadata.status, "partial", mode);
      assert.equal(result.metadata.inspectedSources, 0, mode);
      assert.equal(result.metadata.indexedSources, 1, mode);
      assert.deepEqual(result.display.projects, {}, mode);
      assert.deepEqual(result.display.worktrees, {}, mode);
      const projects = query(result, "project");
      assert.equal(projects.totals.tokens, 120, mode);
      assert.equal(projects.rows.length, 1, mode);
      assert.equal(projects.rows[0].id, "unassigned", mode);
      assert.equal(projects.rows[0].tokens, 120, mode);
      assert.equal(projects.rows[0].unknownEvents, 0, mode);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("source query uses a half-open [fromMs, toMs) boundary", async () => {
  const fixture = await makeFixture({
    events: [
      { timestamp: "2026-08-24T00:00:01.000Z", total: 10, last: 10 },
      { timestamp: "2026-08-24T00:00:02.000Z", total: 30, last: 20 },
      { timestamp: "2026-08-24T00:00:03.000Z", total: 70, last: 40 },
    ],
  });
  try {
    const result = await readLocalWorkUsageSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:01.000Z", "2026-08-24T00:00:03.000Z"),
    });
    assert.equal(result.status, "available");
    assert.equal(query(result, "project").totals.tokens, 30);
    assert.deepEqual(
      query(result, "worktree").rows.map((row) => row.tokens),
      [30],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("row enrichment preserves explicit worker ancestry using the shared local metadata reader", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { chmod } = await import("node:fs/promises");
  const { enrichWorkUsageRows } = await import(
    "../src/local-work-usage-source.js"
  );
  const home = await mkdtemp(join(tmpdir(), "work-usage-names-"));
  const parent = "33333333-3333-4333-8333-333333333333";
  const child = "11111111-1111-4111-8111-111111111111";
  try {
    const file = join(home, "state_5.sqlite");
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, agent_nickname TEXT, source TEXT)",
      );
      const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)");
      insert.run(parent, "Parent task", null, null);
      insert.run(
        child,
        "Child task",
        "Luna",
        JSON.stringify({
          subagent: { thread_spawn: { parent_thread_id: parent } },
        }),
      );
    } finally {
      db.close();
    }
    await chmod(file, 0o600);
    const before = await readFile(file);
    const display = await enrichWorkUsageRows({
      codexHome: home,
      rows: [{ id: "worker", kind: "thread" }],
      result: {
        display: { threads: { worker: { uuid: child, shortId: "11111111" } } },
      },
    });
    assert.deepEqual(display.worker.thread, {
      id: child,
      name: "Child task",
      nickname: "Luna",
      parent: { id: parent, name: "Parent task" },
    });
    assert.equal(display.worker.codexUrl, `codex://threads/${child}`);
    assert.deepEqual(await readFile(file), before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("bounded collaboration ancestry follows nested workers, preserves absent roots and fails closed on cycles", async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const {chmod}=await import('node:fs/promises');
  const {readCodexLocalThreadAncestry}=await import('../src/platform/index.js');
  const home=await mkdtemp(join(tmpdir(),'work-family-'));
  const ids=[1,2,3,4,5,6].map(n=>`${n}0000000-0000-4000-8000-000000000000`);
  try {
    const file=join(home,'state_5.sqlite');const db=new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, title TEXT)');
      const insert=db.prepare('INSERT INTO threads VALUES (?, ?, ?)');
      for(const [child,parent] of [[0,null],[1,0],[2,1],[3,4],[4,3]]) insert.run(ids[child],parent===null?'cli':JSON.stringify({subagent:{thread_spawn:{parent_thread_id:ids[parent]}}}),'SYNTHETIC EXCLUDED TITLE');
    } finally {db.close();}
    await chmod(file,0o600);
    const roots=await readCodexLocalThreadAncestry(home,[ids[2],ids[3],ids[4],ids[5]]);
    assert.equal(roots.get(ids[2]),ids[0]);
    assert.equal(roots.get(ids[3]),ids[3]);assert.equal(roots.get(ids[4]),ids[4]);
    assert.equal(roots.get(ids[5]),ids[5]);
    assert.deepEqual(await readCodexLocalThreadAncestry(home,['invalid']),new Map());
  } finally {await rm(home,{recursive:true,force:true});}
});


test("metadata reuse verifies source identity and observes repository changes afresh", async () => {
  const fixture = await makeFixture({ events: [
    { timestamp: "2026-08-24T00:01:00Z", total: 100, last: 100 },
    { timestamp: "2026-08-24T00:02:00Z", kind: "quota-repeat", total: 100, last: 100 },
  ] });
  const cache = new Map();
  const options = { ...fixture, ...interval("2026-08-24T00:00:00Z", "2026-08-25T00:00:00Z"), workUsageMetadataCache: cache };
  try {
    const cold = await readLocalWorkUsageSnapshot(options);
    assert.equal(cold.status, "available");
    assert.equal(cache.size, 1);
    const saved = [...cache.values()][0];
    assert.ok(saved.contexts.length);
    assert.equal(saved.quotaOnly.length, 1);
    const warm = await readLocalWorkUsageSnapshot(options);
    assert.equal([...cache.values()][0], saved, "unchanged extraction is retained");
    assert.deepEqual(query(warm, "project"), query(cold, "project"));
    await rename(join(fixture.repository, ".git"), join(fixture.repository, ".git-saved"));
    const remapped = await readLocalWorkUsageSnapshot(options);
    assert.equal([...cache.values()][0], saved);
    assert.equal(query(remapped, "project").totals.tokens, 100);
    assert.notEqual(query(remapped, "project").rows[0].id, query(cold, "project").rows[0].id,
      "fresh Git resolution cannot be replaced by a cached repository mapping");
    await modifySourceSameSize(fixture.rolloutPath);
    const changed = await readLocalWorkUsageSnapshot(options);
    assert.equal(cache.size, 0, "failed source verification invalidates cached observations");
    assert.equal(query(changed, "project").rows[0].id, "unassigned");
    assert.ok(query(changed, "project").totals.unknownEvents > 0,
      "stale quota classifications must not hide unknown facts");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});


test("metadata cache forgets sources that disappear from discovery", async () => {
  const fixture = await makeFixture({ events: [
    { timestamp: "2026-08-24T00:01:00Z", total: 100, last: 100 },
  ] });
  const cache = new Map();
  const options = { ...fixture, ...interval("2026-08-24T00:00:00Z", "2026-08-25T00:00:00Z"), workUsageMetadataCache: cache };
  try {
    await readLocalWorkUsageSnapshot(options);
    assert.equal(cache.size, 1);
    await rm(fixture.rolloutPath);
    const absent = await readLocalWorkUsageSnapshot(options);
    assert.equal(cache.size, 0);
    assert.equal(query(absent, "project").rows[0].id, "unassigned");
    assert.equal(query(absent, "project").totals.tokens, 100);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});


test("metadata cache reuses an indexed prefix until a new generation admits appended context", async () => {
  const fixture = await makeFixture({ events: [
    { timestamp: "2026-08-24T00:01:00Z", total: 100, last: 100 },
  ] });
  const cache = new Map();
  const options = { ...fixture, ...interval("2026-08-24T00:00:00Z", "2026-08-25T00:00:00Z"), workUsageMetadataCache: cache };
  try {
    const cold = await readLocalWorkUsageSnapshot(options);
    const saved = [...cache.values()][0];
    await appendFile(fixture.rolloutPath, [
      turnContext("2026-08-24T00:02:00Z", fixture.worktree, 2),
      tokenCount("2026-08-24T00:02:00Z", 300, 200),
    ].map(line => JSON.stringify(line)).join("\n") + "\n");
    const prefix = await readLocalWorkUsageSnapshot(options);
    assert.equal([...cache.values()][0], saved);
    assert.deepEqual(query(prefix, "worktree"), query(cold, "worktree"));
    await ingestLocalUnifiedIndexIncrement({ indexFile: fixture.indexFile,
      codexHome: fixture.codexHome, contractVersion: CONTRACT });
    const advanced = await readLocalWorkUsageSnapshot(options);
    assert.notEqual([...cache.values()][0], saved);
    assert.equal(query(advanced, "project").totals.tokens, 300);
    assert.equal(query(advanced, "project").rows.length, 1);
    assert.equal(query(advanced, "worktree").rows.length, 2);
    const independent = await readLocalWorkUsageSnapshot({ ...options, workUsageMetadataCache: null });
    assert.deepEqual(query(advanced, "worktree"), query(independent, "worktree"));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});


test("oversized cache candidates fall back to streaming without changing accounting", async () => {
  const fixture = await makeFixture({ events: [] });
  const cache = new Map();
  const options = { ...fixture, ...interval("2026-08-24T00:00:00Z", "2026-08-25T00:00:00Z"), workUsageMetadataCache: cache };
  try {
    // Repeated bounded cwd observations exceed the estimated 32 MiB admission
    // budget, while remaining well below the extractor's semantic limits.
    const cwd = "/" + "a".repeat(4095);
    const lines = Array.from({ length: 4100 }, (_, i) =>
      JSON.stringify(turnContext("2026-08-24T00:01:00Z", cwd, i)));
    lines.push(JSON.stringify(tokenCount("2026-08-24T00:02:00Z", 100, 100)));
    await appendFile(fixture.rolloutPath, lines.join("\n") + "\n");
    await ingestLocalUnifiedIndexIncrement({ indexFile: fixture.indexFile,
      codexHome: fixture.codexHome, contractVersion: CONTRACT });
    const bounded = await readLocalWorkUsageSnapshot(options);
    assert.equal(bounded.status, "available");
    assert.equal(cache.size, 0);
    assert.equal(query(bounded, "project").totals.tokens, 100);
    const independent = await readLocalWorkUsageSnapshot({ ...options, workUsageMetadataCache: null });
    assert.deepEqual(query(bounded, "project"), query(independent, "project"));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
