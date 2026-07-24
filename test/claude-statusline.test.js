import test from "node:test";
import assert from "node:assert/strict";
import { formatClaudeStatusline, sanitizeClaudeStatusline } from "../src/claude-statusline.js";

test("Claude status-line sanitizer retains limits and drops private routing fields", () => {
  const snapshot = sanitizeClaudeStatusline({
    cwd: "/private/project",
    session_id: "private-session",
    transcript_path: "/private/transcript.jsonl",
    version: "2.1.176",
    model: { id: "claude-opus", display_name: "Private display" },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 100 },
      seven_day: { used_percentage: 41.2, resets_at: 200 },
    },
  }, "2026-07-23T00:00:00.000Z");
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.limits.fiveHour.usedPercent, 23.5);
  assert.equal(snapshot.limits.sevenDay.resetsAt, 200);
  assert.equal(serialized.includes("private"), false);
  assert.equal(formatClaudeStatusline(snapshot), "Claude 5h 23.5% · 7d 41.2%");
});

test("missing Claude plan limits remain unavailable, not zero", () => {
  const snapshot = sanitizeClaudeStatusline({ version: "2.1.176" });
  assert.equal(snapshot.limits.fiveHour, null);
  assert.equal(snapshot.limits.sevenDay, null);
  assert.equal(formatClaudeStatusline(snapshot), "Claude limits unavailable");
});
