import assert from "node:assert/strict";
import test from "node:test";
import {
  parseLocalReviewArgs,
  runLocalReview,
} from "../local-review/cli.js";

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
