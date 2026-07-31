import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runLocalReview } from "../local-review/cli.js";

const START_AT = "2026-07-24T11:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";
const SECRET = Buffer.alloc(32, 83);

function usage(input, output, cached, reasoning) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

async function localExportFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "usage-monitor-local-review-resource-")),
  );
  const codexHome = join(root, "codex-home");
  const activityFile = join(root, "activity-markers.jsonl");
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
  const total = usage(100, 20, 40, 8);
  const lines = [
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "PRIVATE_LOCAL_REVIEW_SESSION",
        prompt: "PRIVATE_LOCAL_REVIEW_PROMPT",
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.001Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:02:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: total,
          last_token_usage: total,
          prompt: "PRIVATE_LOCAL_REVIEW_PROMPT",
        },
        rate_limits: {
          limit_id: "codex",
          plan_type: "pro",
          primary: {
            used_percent: 12,
            window_minutes: 300,
            resets_at: 1_784_912_400,
          },
          secondary: {
            used_percent: 6,
            window_minutes: 10_080,
            resets_at: 1_785_430_800,
          },
        },
      },
    }),
  ];
  await writeFile(
    join(
      codexHome,
      "sessions",
      "rollout-2026-07-24T12-00-00-local-review.jsonl",
    ),
    `${lines.join("\n")}\n`,
    { mode: 0o600 },
  );
  await writeFile(activityFile, "", { mode: 0o600 });
  return { activityFile, codexHome, root };
}

function injectedIdentity() {
  const identityOptions = Object.freeze({ source: "characterization-test" });
  let leases = 0;
  let selections = 0;
  return {
    dependencies: {
      selectParticipantIdentity({ explicitSecretFile }) {
        assert.equal(explicitSecretFile, null);
        selections += 1;
        return {
          mode: "owner_file_override",
          identityOptions,
        };
      },
      async withIdentityLease(options, callback) {
        assert.equal(options, identityOptions);
        assert.equal(typeof callback, "function");
        leases += 1;
        const secret = Buffer.from(SECRET);
        try {
          return await callback({ secret });
        } finally {
          secret.fill(0);
        }
      },
    },
    counts() {
      return { leases, selections };
    },
  };
}

async function captureConsoleLog(callback) {
  const lines = [];
  const original = console.log;
  console.log = (...values) => {
    lines.push(values.map(String).join(" "));
  };
  try {
    await callback();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

test("inspect-export completes through the local-review resource context", async (t) => {
  const fixture = await localExportFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const identity = injectedIdentity();

  const output = await captureConsoleLog(() => runLocalReview([
    "inspect-export",
    "--since", START_AT,
    "--until", END_AT,
    "--codex-home", fixture.codexHome,
    "--activity-file", fixture.activityFile,
  ], identity.dependencies));

  assert.match(output, /^Local metadata export preview$/m);
  assert.match(output, new RegExp(`^Coverage: ${START_AT} to ${END_AT}$`, "m"));
  assert.match(output, /^Usage events: 1$/m);
  assert.match(output, /^Quota snapshots: 2$/m);
  assert.match(output, /^Activity markers: 0$/m);
  assert.match(output, /^Source files scanned: 1$/m);
  assert.match(output, /^Privacy verdict: passed$/m);
  assert.match(output, /^Resource records: 3$/m);
  assert.match(output, /^Upload: disabled \(transportReady=false\)$/m);
  assert.equal(output.includes("PRIVATE_LOCAL_REVIEW"), false);
  assert.deepEqual(identity.counts(), { leases: 1, selections: 1 });
});

test("export-local writes and reports an owner-only bundle pair", async (t) => {
  const fixture = await localExportFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const destination = join(fixture.root, "single-export");
  const outputFile = join(destination, "review.json");
  const receiptFile = `${outputFile}.privacy-receipt.json`;
  await mkdir(destination);
  const identity = injectedIdentity();

  const output = await captureConsoleLog(() => runLocalReview([
    "export-local",
    "--since", START_AT,
    "--until", END_AT,
    "--codex-home", fixture.codexHome,
    "--activity-file", fixture.activityFile,
    "--output", outputFile,
  ], identity.dependencies));

  const bundle = JSON.parse(await readFile(outputFile, "utf8"));
  const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  assert.deepEqual(bundle.recordCounts, {
    activityMarkers: 0,
    quotaSnapshots: 2,
    usageEvents: 1,
  });
  assert.equal(bundle.transportReady, false);
  assert.equal(receipt.verdict, "passed");
  assert.equal(receipt.transportReady, false);
  assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
  assert.equal((await stat(receiptFile)).mode & 0o777, 0o600);
  assert.match(output, /^Local metadata export preview$/m);
  assert.match(output, new RegExp(`^Bundle: ${outputFile}$`, "m"));
  assert.match(output, new RegExp(`^Privacy receipt: ${receiptFile}$`, "m"));
  assert.equal(output.includes("PRIVATE_LOCAL_REVIEW"), false);
  assert.deepEqual(identity.counts(), { leases: 1, selections: 1 });

  const verificationOutput = await captureConsoleLog(() => runLocalReview([
    "verify-bundle",
    "--input", outputFile,
    "--receipt", receiptFile,
  ]));
  assert.match(
    verificationOutput,
    /^Local metadata bundle verification: passed$/m,
  );
  assert.match(
    verificationOutput,
    /^Contract: telemetry-v0\.1 \(draft_local_only_unfrozen\); exporter /m,
  );
  assert.match(
    verificationOutput,
    /^Records: 1 usage, 2 quota, 0 markers$/m,
  );
  assert.equal(verificationOutput.includes(fixture.root), false);
  assert.equal(verificationOutput.includes(bundle.participantId), false);
});

test("export-set creates a complete workspace and materialized set", async (t) => {
  const fixture = await localExportFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const workspace = join(fixture.root, "workspace");
  const destination = join(fixture.root, "export-set");
  const identity = injectedIdentity();

  const output = await captureConsoleLog(() => runLocalReview([
    "export-set",
    "--workspace", workspace,
    "--directory", destination,
    "--since", START_AT,
    "--until", END_AT,
    "--codex-home", fixture.codexHome,
    "--activity-file", fixture.activityFile,
    "--max-records-per-chunk", "2",
  ], identity.dependencies));

  const manifest = JSON.parse(
    await readFile(join(destination, "export-set-manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.totals.recordCounts, {
    activityMarkers: 0,
    quotaSnapshots: 2,
    usageEvents: 1,
  });
  assert.equal(manifest.chunks.length, 2);
  assert.equal(manifest.transportReady, false);
  assert.equal((await stat(join(workspace, "workspace.sqlite3"))).isFile(), true);
  assert.match(output, /^Local metadata export set: complete$/m);
  assert.match(output, /^Workspace status: scan_complete$/m);
  assert.match(output, /^Chunks: 2$/m);
  assert.match(output, /^Records: 1 usage, 2 quota, 0 markers$/m);
  assert.match(output, /^Upload: disabled \(transportReady=false\)$/m);
  assert.equal(output.includes("PRIVATE_LOCAL_REVIEW"), false);
  assert.deepEqual(identity.counts(), { leases: 1, selections: 1 });
});

test("inspect-export reports the exact covered-duration resource error", async () => {
  await assert.rejects(
    runLocalReview([
      "inspect-export",
      "--since", "2026-07-01T00:00:00.000Z",
      "--until", "2026-08-02T00:00:00.000Z",
    ], {
      selectParticipantIdentity() {
        assert.fail("identity selection must follow resource validation");
      },
    }),
    (error) => {
      assert.equal(error.code, "export_resource_covered_duration");
      assert.equal(
        error.message,
        "Local export stopped at the covered_duration resource limit",
      );
      return true;
    },
  );
});

test("inspect-export reports the exact oversized activity-file resource error", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "usage-monitor-local-review-oversized-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const activityFile = join(root, "oversized-activity.jsonl");
  await writeFile(activityFile, "", { mode: 0o600 });
  await truncate(activityFile, (32 * 1024 * 1024) + 1);

  await assert.rejects(
    runLocalReview([
      "inspect-export",
      "--since", START_AT,
      "--until", END_AT,
      "--activity-file", activityFile,
    ], {
      selectParticipantIdentity() {
        assert.fail("identity selection must follow activity-file validation");
      },
    }),
    (error) => {
      assert.equal(error.code, "export_resource_source_bytes");
      assert.equal(
        error.message,
        "Local export stopped at the source_bytes resource limit",
      );
      assert.equal(error.message.includes(activityFile), false);
      return true;
    },
  );
});
