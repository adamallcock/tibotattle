import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseLocalReviewArgs as parseLocalReviewArgsFromCli,
  runLocalReview,
} from "../local-review/cli.js";
import { parseLocalReviewArgs } from "../local-review/arguments.js";
import {
  localExportSetMaterialization,
  localExportSourcePipeline,
} from "../src/local-node-runtime.js";

const { createLocalExportWorkspace } = localExportSourcePipeline.controller;
const { materializeLocalExportSet } = localExportSetMaterialization;

const PRIVATE_CLI_CANARY = "PRIVATE_LOCAL_REVIEW_DELETION_CANARY";

function usage(tokens) {
  return {
    input_tokens: tokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
    total_tokens: tokens + 1,
  };
}

async function deletionFixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-local-review-delete-"));
  const codexHome = join(root, "codex-home");
  const workspace = join(root, "workspace");
  const output = join(root, "output");
  const source = join(codexHome, "sessions", "rollout-private.jsonl");
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
  const tokens = usage(12);
  await writeFile(source, `${[
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "PRIVATE_LOCAL_REVIEW_SESSION", prompt: PRIVATE_CLI_CANARY },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.001Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:02:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: tokens, last_token_usage: tokens } },
    }),
  ].join("\n")}\n`, { mode: 0o600 });
  const secret = Buffer.alloc(32, 73);
  await createLocalExportWorkspace({
    directory: workspace,
    startAt: "2026-07-24T11:00:00.000Z",
    endAt: "2026-07-24T13:00:00.000Z",
    createdAt: "2026-07-24T13:00:00.000Z",
    codexHome,
    secret,
  });
  await materializeLocalExportSet({
    workspaceDirectory: workspace,
    outputDirectory: output,
    secret,
  });
  await writeFile(join(output, "unrelated-sibling.txt"), "preserve", { mode: 0o600 });
  return { root, workspace, output, source };
}

async function captureLocalReview(argv) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => stdout.push(values.join(" "));
  console.error = (...values) => stderr.push(values.join(" "));
  try {
    await runLocalReview(argv);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout: `${stdout.join("\n")}\n`, stderr: stderr.join("\n") };
}

test("local-review CLI re-exports the pure argument parser by identity", () => {
  assert.equal(parseLocalReviewArgsFromCli, parseLocalReviewArgs);
});

test("local-review parser accepts the bounded export command surface", () => {
  const args = parseLocalReviewArgs([
    "export-set",
    "--workspace", "./workspace",
    "--directory", "./output",
    "--since", "2026-07-01T00:00:00.000Z",
    "--until", "2026-07-02T00:00:00.000Z",
    "--claude-status",
    "--claude-usage",
    "--max-records-per-chunk", "100",
  ]);
  assert.equal(args.command, "export-set");
  assert.equal(args.claudeStatus, true);
  assert.equal(args.claudeUsage, true);
  assert.equal(args.maximumRecordsPerChunk, 100);
});

test("local-review parser rejects transport options", () => {
  assert.throws(
    () => parseLocalReviewArgs([
      "export-set",
      "--origin", "https://example.invalid",
    ]),
    /Unknown argument: --origin/,
  );
  assert.throws(
    () => parseLocalReviewArgs(["doctor", "--confirm-uninstall", "TOKEN"]),
    /only for uninstall/,
  );
});

test("local-review runner has no contribution-device command", async () => {
  await assert.rejects(
    runLocalReview(["pair-contribution-device", "--origin", "https://example.invalid"]),
    /Unknown argument: --origin/,
  );
  await assert.rejects(
    runLocalReview(["sync-contributions-once"]),
    /Unknown local-review command/,
  );
});

test("Claude and install confirmations are command scoped", () => {
  assert.throws(
    () => parseLocalReviewArgs(["doctor", "--confirm-removal", "ABC"]),
    /only for remove-claude-callback-identity/,
  );
  assert.throws(
    () => parseLocalReviewArgs(["doctor", "--target", "/tmp/example"]),
    /only for install and uninstall/,
  );
});

test("local-review runs deletion preflight, confirmation, and receipt recovery without path or content leakage", async () => {
  const value = await deletionFixture();
  try {
    const preflight = await captureLocalReview([
      "delete-local-export",
      "--workspace", value.workspace,
      "--directory", value.output,
    ]);
    assert.match(preflight.stdout, /Local export deletion preflight: ready/u);
    assert.match(preflight.stdout, /No files changed; rerun with --confirm-deletion/u);
    const token = preflight.stdout.match(/Confirmation token: ([A-Z2-7]{12,24})/u)?.[1];
    assert.equal(typeof token, "string");

    const confirmed = await captureLocalReview([
      "delete-local-export",
      "--workspace", value.workspace,
      "--directory", value.output,
      "--confirm-deletion", token,
    ]);
    assert.match(confirmed.stdout, /Local export deletion: complete/u);
    assert.deepEqual(await readdir(value.workspace), []);
    assert.deepEqual((await readdir(value.output)).sort(), [
      "local-export-deletion-receipt.json",
      "unrelated-sibling.txt",
    ]);

    const recovered = await captureLocalReview([
      "recover-local-export-deletion",
      "--workspace", value.workspace,
      "--directory", value.output,
    ]);
    assert.match(recovered.stdout, /Local export deletion recovery: complete/u);
    const receipt = await readFile(join(value.output, "local-export-deletion-receipt.json"), "utf8");
    assert.match(receipt, /"logicalRemovalConfirmed": true/u);
    assert.equal(await readFile(value.source, "utf8").then((text) => text.includes(PRIVATE_CLI_CANARY)), true);

    const visible = `${preflight.stdout}${preflight.stderr}${confirmed.stdout}${confirmed.stderr}${recovered.stdout}${recovered.stderr}${receipt}`;
    for (const canary of [value.root, value.workspace, value.output, value.source, PRIVATE_CLI_CANARY, "PRIVATE_LOCAL_REVIEW_SESSION"]) {
      assert.equal(visible.includes(canary), false, canary);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
