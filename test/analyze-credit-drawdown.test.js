import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { priceCodexUsageEvent } from "@app-usagemonitor/accounting";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ANALYZER = join(
  REPOSITORY_ROOT,
  "scripts",
  "analyze-credit-drawdown.js",
);

const USAGE = {
  input_tokens: 10_000,
  cached_input_tokens: 2_000,
  output_tokens: 600,
  reasoning_output_tokens: 100,
};

function tokenCountLine(timestamp, balance, {
  hasCredits = true,
  usedPercent = 10,
  usage = USAGE,
} = {}) {
  return {
    timestamp,
    payload: {
      type: "token_count",
      info: { last_token_usage: usage },
      rate_limits: {
        limit_id: "codex-credits",
        limit_name: "credits",
        plan_type: "pro",
        primary: { used_percent: usedPercent, window_minutes: 10_080 },
        credits: { has_credits: hasCredits, unlimited: false, balance },
      },
    },
  };
}

function modelContextLine(timestamp) {
  return {
    timestamp,
    payload: {
      type: "turn_context",
      model: "gpt-5.5",
      service_tier: "default",
      reasoning_effort: "medium",
    },
  };
}

function serializeLines(lines) {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

// Synthetic, content-free rollout: one model context line, then eleven
// token_count records whose balance steps 500 -> 400 in five settlements of
// twenty credits, two requests of work inside each settlement window.
function syntheticRolloutLines() {
  const lines = [modelContextLine("2026-06-10T10:00:00.000Z")];
  const balances = [500, 500, 480, 480, 460, 460, 440, 440, 420, 420, 400];
  for (const [index, balance] of balances.entries()) {
    lines.push(tokenCountLine(
      `2026-06-10T10:${String(index + 1).padStart(2, "0")}:00.000Z`,
      balance,
      { usedPercent: 10 + index },
    ));
  }
  return serializeLines(lines);
}

function runAnalyzer(cliArguments) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [ANALYZER, ...cliArguments],
      {
        cwd: REPOSITORY_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (status) => {
      resolveRun({ status, stderr, stdout });
    });
  });
}

// Rollouts and written artifacts live in SEPARATE temp directories so a
// leak of the session directory is distinguishable from the analyzer
// echoing its own --json/--csv output paths.
async function withFixture(run) {
  const sessionRoot = await mkdtemp(
    join(tmpdir(), "usage-monitor-credit-sessions-"),
  );
  const artifactRoot = await mkdtemp(
    join(tmpdir(), "usage-monitor-credit-artifacts-"),
  );
  try {
    const rolloutPath = join(sessionRoot, "rollout-synthetic.jsonl");
    await writeFile(rolloutPath, syntheticRolloutLines(), "utf8");
    return await run({ sessionRoot, artifactRoot, rolloutPath });
  } finally {
    await Promise.all([
      rm(sessionRoot, { force: true, recursive: true }),
      rm(artifactRoot, { force: true, recursive: true }),
    ]);
  }
}

test("the analyzer reconstructs episodes and disjoint settlement windows", async () => {
  await withFixture(async ({ artifactRoot, rolloutPath }) => {
    const jsonPath = join(artifactRoot, "analysis.json");
    const csvPath = join(artifactRoot, "analysis.csv");
    const result = await runAnalyzer([
      "--file", rolloutPath,
      "--json", jsonPath,
      "--csv", csvPath,
      "--bootstrap", "50",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /episodes: 1/u);
    assert.match(result.stdout, /drawn=100\.0000 cr = \$4\.0000/u);
    assert.match(result.stdout, /models {5}gpt-5\.5/u);

    const payload = JSON.parse(await readFile(jsonPath, "utf8"));
    assert.equal(payload.creditUsd, 0.04);
    assert.equal(payload.episodes.length, 1);
    const [episode] = payload.episodes;
    assert.equal(episode.creditsDrawn, 100);
    assert.equal(episode.usdDrawn, 4);
    assert.equal(episode.requests, 11);
    assert.equal(episode.terminator, "in_progress");
    assert.deepEqual(episode.models, ["gpt-5.5"]);
    assert.deepEqual(episode.usedPercentRange, [10, 20]);

    // Settlement windows partition the records after the opening read: five
    // twenty-credit drops, two requests of work each, never sharing a
    // boundary record.
    assert.equal(episode.settlements, 5);
    assert.equal(episode.steps.length, 5);
    for (const step of episode.steps) {
      assert.equal(step.creditsDrawn, 20);
      assert.equal(step.usdDrawn, 0.8);
      assert.equal(step.requests, 2);
    }
    const stepApiSum = episode.steps
      .reduce((acc, step) => acc + step.apiUsd, 0);
    // All eleven records carry identical usage, so the ten records inside
    // settlement windows must price to exactly 10/11 of the episode total.
    assert.ok(episode.apiEquivalentUsd > 0);
    assert.ok(
      Math.abs(stepApiSum - (episode.apiEquivalentUsd * 10) / 11) < 1e-9,
      `disjoint windows must not double-count boundary records (${stepApiSum})`,
    );

    // The script's component mapping must agree with the accounting facade
    // priced directly over the same synthetic event.
    const reference = priceCodexUsageEvent({
      timestamp: "2026-06-10T10:01:00.000Z",
      model: "gpt-5.5",
      raw: { input_tokens: USAGE.input_tokens },
      components: {
        input_uncached_tokens: USAGE.input_tokens - USAGE.cached_input_tokens,
        input_cache_read_tokens: USAGE.cached_input_tokens,
        input_cache_write_tokens: 0,
        output_text_tokens: USAGE.output_tokens - USAGE.reasoning_output_tokens,
        output_reasoning_tokens: USAGE.reasoning_output_tokens,
      },
      componentAvailability: {
        input_uncached_tokens: true,
        input_cache_read_tokens: true,
        input_cache_write_tokens: true,
        output_text_tokens: true,
        output_reasoning_tokens: true,
      },
    });
    assert.deepEqual(Object.keys(episode.coverage), ["fully_priced"]);
    assert.ok(
      Math.abs(episode.apiEquivalentUsd - Number(reference.totalUsd) * 11) < 1e-9,
      "per-record pricing must match the accounting facade exactly",
    );

    const csv = await readFile(csvPath, "utf8");
    const [header, firstRow] = csv.split("\n");
    assert.match(header, /(^|,)source_file$/u);
    assert.match(firstRow, /,rollout-01$/u);
  });
});

test("top-ups and exhaustion terminate episodes with honest labels", async () => {
  await withFixture(async ({ sessionRoot, artifactRoot }) => {
    const rolloutPath = join(sessionRoot, "rollout-boundaries.jsonl");
    const lines = [modelContextLine("2026-06-11T09:00:00.000Z")];
    // Episode 1: 500 -> 480, closed by a top-up to 1000.
    lines.push(tokenCountLine("2026-06-11T09:01:00.000Z", 500));
    lines.push(tokenCountLine("2026-06-11T09:02:00.000Z", 480));
    // Episode 2: 1000 -> 0, the zero record reports has_credits:false but is
    // the settlement that closes the episode.
    lines.push(tokenCountLine("2026-06-11T09:03:00.000Z", 1000));
    lines.push(tokenCountLine("2026-06-11T09:04:00.000Z", 400));
    lines.push(tokenCountLine("2026-06-11T09:05:00.000Z", 0, { hasCredits: false }));
    await writeFile(rolloutPath, serializeLines(lines), "utf8");

    const jsonPath = join(artifactRoot, "boundaries.json");
    const result = await runAnalyzer([
      "--file", rolloutPath,
      "--json", jsonPath,
      "--bootstrap", "0",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(await readFile(jsonPath, "utf8"));
    assert.equal(payload.episodes.length, 2);
    assert.deepEqual(
      payload.episodes.map((episode) => episode.terminator),
      ["topped_up", "exhausted"],
    );
    assert.equal(payload.episodes[0].creditsDrawn, 20);
    assert.equal(payload.episodes[0].ratioIsFloor, false);
    assert.equal(payload.episodes[1].creditsDrawn, 1000);
    assert.equal(payload.episodes[1].ratioIsFloor, true);
  });
});

test("written artifacts and terminal output redact rollout paths unless --reveal-paths opts in", async () => {
  await withFixture(async ({ sessionRoot, artifactRoot, rolloutPath }) => {
    const jsonPath = join(artifactRoot, "analysis.json");
    const csvPath = join(artifactRoot, "analysis.csv");
    const redacted = await runAnalyzer([
      "--file", rolloutPath,
      "--json", jsonPath,
      "--csv", csvPath,
      "--bootstrap", "50",
    ]);
    assert.equal(redacted.status, 0, redacted.stderr);
    const everyChannel = redacted.stdout + redacted.stderr
      + await readFile(jsonPath, "utf8") + await readFile(csvPath, "utf8");
    assert.equal(everyChannel.includes(sessionRoot), false);
    assert.equal(everyChannel.includes("rollout-synthetic"), false);
    const payload = JSON.parse(await readFile(jsonPath, "utf8"));
    assert.deepEqual(payload.sourceFiles, ["rollout-01"]);
    assert.deepEqual(payload.episodes[0].sourceFiles, ["rollout-01"]);

    const revealed = await runAnalyzer([
      "--file", rolloutPath,
      "--json", jsonPath,
      "--bootstrap", "50",
      "--reveal-paths",
    ]);
    assert.equal(revealed.status, 0, revealed.stderr);
    const revealedPayload = JSON.parse(await readFile(jsonPath, "utf8"));
    assert.deepEqual(revealedPayload.sourceFiles, [rolloutPath]);
  });
});

test("an unreadable file is skipped and counted without naming it", async () => {
  await withFixture(async ({ sessionRoot, artifactRoot, rolloutPath }) => {
    const missingPath = join(sessionRoot, "rollout-vanished.jsonl");
    const jsonPath = join(artifactRoot, "analysis.json");
    const result = await runAnalyzer([
      "--file", rolloutPath,
      "--file", missingPath,
      "--json", jsonPath,
      "--bootstrap", "0",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /unreadable rollout files skipped: 1/u);
    assert.match(result.stdout, /episodes: 1/u);
    const everyChannel = result.stdout + result.stderr
      + await readFile(jsonPath, "utf8");
    assert.equal(everyChannel.includes("rollout-vanished"), false);
    assert.equal(everyChannel.includes(sessionRoot), false);
  });
});

test("duplicate --file arguments do not double-count settlements", async () => {
  await withFixture(async ({ artifactRoot, rolloutPath }) => {
    const jsonPath = join(artifactRoot, "analysis.json");
    const result = await runAnalyzer([
      "--file", rolloutPath,
      "--file", rolloutPath,
      "--json", jsonPath,
      "--bootstrap", "0",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(await readFile(jsonPath, "utf8"));
    assert.equal(payload.episodes.length, 1);
    assert.equal(payload.episodes[0].creditsDrawn, 100);
    assert.equal(payload.episodes[0].requests, 11);
  });
});

test("discovery finds the has_credits:false closing settlement in the next session's file", async () => {
  await withFixture(async ({ sessionRoot }) => {
    // The main fixture ends at balance 400; a later session's first reading
    // settles the exhaustion. A credit-less account file (balance null) must
    // stay outside the scan.
    await writeFile(
      join(sessionRoot, "rollout-terminal.jsonl"),
      serializeLines([
        tokenCountLine("2026-06-10T11:00:00.000Z", 0, { hasCredits: false }),
      ]),
      "utf8",
    );
    await writeFile(
      join(sessionRoot, "rollout-credit-free.jsonl"),
      serializeLines([{
        timestamp: "2026-06-10T09:00:00.000Z",
        payload: {
          type: "token_count",
          rate_limits: {
            credits: { has_credits: false, unlimited: false, balance: null },
          },
        },
      }]),
      "utf8",
    );
    const result = await runAnalyzer(["--sessions", sessionRoot]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /scanning 3 rollout files/u);
    assert.match(result.stderr, /credit-bearing files: 2/u);
    assert.match(result.stdout, /episodes: 1/u);
    assert.match(result.stdout, /\[exhausted\]/u);
    assert.match(result.stdout, /drawn=500\.0000 cr/u);
  });
});
