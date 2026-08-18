import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_SURFACES, createActivityMarker } from "../src/activity-markers.js";
import { AGENTIC_POOL_POLICY, agenticPoolCouplingForSurface } from "../src/agentic-pool-policy.js";
import { parseArgs } from "../src/cli.js";

test("activity marker retains only low-cardinality privacy-safe fields", () => {
  const marker = createActivityMarker({
    surface: "chatgpt_web",
    state: "start",
    observedAt: "2026-07-24T12:00:00.000Z",
    accountScope: { status: "available", version: "v1", scopeId: "scope-pseudonym" },
    planType: "pro",
  });
  assert.equal(marker.surface, "chatgpt_web");
  assert.equal(marker.agenticPoolCoupling, "excluded_ordinary_chat");
  assert.equal(marker.accountScope.scopeId, "scope-pseudonym");
  assert.equal(marker.privacy.contentStored, false);
  assert.ok(!Object.hasOwn(marker, "content"));
  assert.ok(!Object.hasOwn(marker, "url"));
});

test("agentic-pool policy separates ordinary Chat from shared agentic surfaces", () => {
  assert.equal(AGENTIC_POOL_POLICY.ordinaryChatIncluded, false);
  assert.equal(agenticPoolCouplingForSurface("chatgpt_chat"), "excluded_ordinary_chat");
  assert.equal(agenticPoolCouplingForSurface("ordinary_chat_voice"), "excluded_ordinary_chat");
  assert.equal(agenticPoolCouplingForSurface("chatgpt_work"), "shared_agentic_pool");
  assert.equal(agenticPoolCouplingForSurface("workspace_agent"), "shared_agentic_pool");
  assert.equal(agenticPoolCouplingForSurface("chatgpt_excel"), "shared_agentic_pool");
  assert.equal(agenticPoolCouplingForSurface("chatgpt_work_voice"), "mixed_task_shared_voice_time_separate");
  assert.equal(agenticPoolCouplingForSurface("image_generation"), "shared_agentic_pool_feature_multiplier");
  assert.equal(agenticPoolCouplingForSurface("codex_spark"), "separate_demand_adjusted_model_limit");
});

test("activity marker rejects arbitrary surfaces and free-form experiment identifiers", () => {
  assert.ok(ACTIVITY_SURFACES.includes("voice_dictation"));
  assert.throws(() => createActivityMarker({ surface: "https://private.example", state: "pulse" }), /surface must be one of/);
  assert.throws(() => createActivityMarker({ surface: "quiet_period", state: "start", experimentId: "Private words" }), /experimentId/);
});

test("activity marker CLI accepts only explicit low-cardinality fields", () => {
  const args = parseArgs(["mark-activity", "--surface", "quiet_period", "--state", "start", "--experiment-id", "fast-sol-a"]);
  assert.equal(args.activitySurface, "quiet_period");
  assert.equal(args.activityState, "start");
  assert.equal(args.experimentId, "fast-sol-a");
});

test("local export CLI requires explicit bounded paths and keeps upload absent", () => {
  const args = parseArgs([
    "export-local",
    "--since", "2026-07-24T12:00:00.000Z",
    "--until", "2026-07-24T13:00:00.000Z",
    "--output", "exports/review.umx.json",
    "--receipt", "exports/review.receipt.json",
    "--secret-file", ".usage-monitor/export-secret",
  ]);
  assert.equal(args.command, "export-local");
  assert.equal(args.startAt, "2026-07-24T12:00:00.000Z");
  assert.equal(args.endAt, "2026-07-24T13:00:00.000Z");
  assert.match(args.outputFile, /exports[\\/]review\.umx\.json$/);
  assert.match(args.receiptFile, /exports[\\/]review\.receipt\.json$/);
  assert.throws(() => parseArgs(["upload", "--server", "https://example.invalid"]), /Unknown argument/);
});
