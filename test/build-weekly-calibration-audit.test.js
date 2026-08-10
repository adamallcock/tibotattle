import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../src/build-weekly-calibration-audit.js", import.meta.url),
);
// The historical price ledger now intentionally fails closed before an
// official effective-price window exists. Keep this fixture inside the
// reviewed GPT-5.6 price window because this test exercises successful local
// audit pricing rather than the separate unknown-history path.
const START_AT = "2026-07-31T11:00:00.000Z";
const END_AT = "2026-07-31T13:00:00.000Z";
const MODEL = "gpt-5.6-sol";
const EXPECTED_TOTAL_TOKENS = 1_100;
const EXPECTED_API_PRICE_EQUIVALENT_USD = 0.008;
const CONTENT_CANARY = "PRIVATE_WEEKLY_AUDIT_CONTENT_CANARY";
const PATH_CANARY = "/Users/private-owner/Secret Weekly Audit";
const SESSION_CANARY = "private-weekly-audit-session-canary";
const MAX_STDOUT_BYTES = 1_024;

function usage() {
  return {
    input_tokens: 1_000,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 100,
    reasoning_output_tokens: 0,
    total_tokens: EXPECTED_TOTAL_TOKENS,
  };
}

async function createFixture() {
  const root = await mkdtemp(
    join(tmpdir(), "app-usagemonitor-weekly-audit-"),
  );
  const stateDirectory = join(root, ".usage-monitor");
  const codexHome = join(root, "codex-home");
  const isolatedHome = join(root, "home");
  const archivedSessions = join(codexHome, "archived_sessions");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(archivedSessions, { recursive: true, mode: 0o700 });
  await mkdir(isolatedHome, { recursive: true, mode: 0o700 });

  const resetValues = [
    {
      resetIdentity: "reset-second-by-ledger-order",
      firstObservedAt: START_AT,
      lastObservedAt: END_AT,
    },
    {
      resetIdentity: "reset-first-by-ledger-order",
      firstObservedAt: START_AT,
      lastObservedAt: END_AT,
    },
  ];
  const errorConcentration = {
    resets: [
      {
        resetIdentity: "reset-first-by-ledger-order",
        weekLabel: "2020-01-01 first",
        absoluteErrorPp: 8,
        shareOfTotal: 0.6,
      },
      {
        resetIdentity: "reset-second-by-ledger-order",
        weekLabel: "2020-01-01 second",
        absoluteErrorPp: 5,
        shareOfTotal: 0.4,
      },
    ],
  };
  await writeFile(
    join(stateDirectory, "weekly-calibration-v0.2.json"),
    `${JSON.stringify({ resetValues, errorConcentration }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const rolloutPath = join(
    archivedSessions,
    "rollout-2026-07-31T12-00-00-weekly-audit.jsonl",
  );
  const tokenUsage = usage();
  const records = [
    {
      timestamp: "2026-07-31T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: SESSION_CANARY,
        source: "cli",
        cwd: PATH_CANARY,
        title: CONTENT_CANARY,
      },
    },
    {
      timestamp: "2026-07-31T12:00:00.001Z",
      type: "turn_context",
      payload: {
        model: MODEL,
        cwd: PATH_CANARY,
        user_instructions: CONTENT_CANARY,
      },
    },
    {
      timestamp: "2026-07-31T12:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: tokenUsage,
          last_token_usage: tokenUsage,
        },
      },
    },
  ];
  await writeFile(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { mode: 0o600 },
  );

  return {
    root,
    codexHome,
    isolatedHome,
    rolloutPath,
    outputPath: join(
      stateDirectory,
      "weekly-calibration-high-error-audit-v0.1.json",
    ),
  };
}

test("weekly calibration audit CLI prices selected resets without retaining private rollout data", async () => {
  const fixture = await createFixture();
  try {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        CODEX_HOME: fixture.codexHome,
        HOME: fixture.isolatedHome,
        PATH: process.env.PATH ?? "",
        TZ: "UTC",
      },
      maxBuffer: 64 * 1_024,
      timeout: 30_000,
    });
    assert.equal(
      result.status,
      0,
      result.stderr || result.error?.stack || "weekly audit exited nonzero",
    );
    assert.equal(result.stderr, "");

    const outputText = await readFile(fixture.outputPath, "utf8");
    const output = JSON.parse(outputText);
    assert.equal((await stat(fixture.outputPath)).mode & 0o777, 0o600);
    assert.equal(
      output.schemaVersion,
      "weekly-calibration-high-error-audit-v0.1",
    );
    assert.deepEqual(
      output.resets.map((row) => row.resetIdentity),
      [
        "reset-first-by-ledger-order",
        "reset-second-by-ledger-order",
      ],
    );

    for (const row of output.resets) {
      assert.equal(row.localSurfaceEvidence.eventCount, 1);
      assert.equal(
        row.localSurfaceEvidence.totalTokens,
        EXPECTED_TOTAL_TOKENS,
      );
      assert.equal(
        row.localSurfaceEvidence.standardApiPricedUsd,
        EXPECTED_API_PRICE_EQUIVALENT_USD,
      );
      assert.ok(row.localSurfaceEvidence.totalTokens > 0);
      assert.ok(row.localSurfaceEvidence.standardApiPricedUsd > 0);
      assert.deepEqual(row.localSurfaceEvidence.components, {
        input_uncached_tokens: 1_000,
        input_cache_read_tokens: 0,
        input_cache_write_tokens: 0,
        output_text_tokens: 100,
        output_reasoning_tokens: 0,
      });
      assert.equal(
        row.localSurfaceEvidence.byModel[MODEL].costUsd,
        EXPECTED_API_PRICE_EQUIVALENT_USD,
      );

      const serialized = JSON.stringify(row);
      for (const privateValue of [
        CONTENT_CANARY,
        PATH_CANARY,
        SESSION_CANARY,
        fixture.codexHome,
        fixture.rolloutPath,
      ]) {
        assert.equal(
          serialized.includes(privateValue),
          false,
          `audit reset retained private fixture data: ${privateValue}`,
        );
      }
    }

    assert.ok(
      Buffer.byteLength(result.stdout, "utf8") <= MAX_STDOUT_BYTES,
      "weekly audit stdout exceeded its content-free byte bound",
    );
    assert.match(result.stdout, /"resetCount": 2/u);
    for (const privateValue of [
      CONTENT_CANARY,
      PATH_CANARY,
      SESSION_CANARY,
      fixture.codexHome,
      fixture.rolloutPath,
      MODEL,
      '"localSurfaceEvidence"',
      '"standardApiPricedUsd"',
      '"totalTokens"',
    ]) {
      assert.equal(
        result.stdout.includes(privateValue),
        false,
        `weekly audit stdout retained private or report content: ${privateValue}`,
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
