import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_MODEL_CONFIG, ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION,
  projectAdminModelHistoryDay, expandAdminModelHistoryDay,
} from "@app-usagemonitor/telemetry-contract";
import * as browser from "../apps/web/public/telemetry-shared.generated.js";

function counts() {
  return { fittedParticipantCount: 2, unstableParticipantCount: 1,
    staleParticipantCount: 1, refusedParticipantCount: 1,
    v1ParticipantCount: 5, unsupportedSourceParticipantCount: 3 };
}
function current() {
  return { day: "2026-09-03", catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION,
    values: [["gpt-6-astra", 2_000, 2]], ...counts() };
}

test("admin compact history preserves legacy coverage, new models and separate Spark", () => {
  const legacy = { day: "2026-09-02", byModel: Object.fromEntries([
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
  ].map((id) => [id, { capacityUsd: null, participantCount: 0 }])), ...counts() };
  legacy.byModel["gpt-5.6-sol"] = { capacityUsd: 900, participantCount: 2 };
  const wire = projectAdminModelHistoryDay(legacy);
  assert.equal(wire.catalogVersion, LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION);
  assert.deepEqual(wire.values, [["gpt-5.6-sol", 900, 2]]);
  assert.equal("byModel" in wire, false);
  const old = expandAdminModelHistoryDay(wire);
  assert.deepEqual(old.byModel["gpt-6-astra"], { capacityUsd: null, participantCount: null });
  assert.deepEqual(old.byModel["gpt-5.6-luna"], { capacityUsd: null, participantCount: 0 });
  const fresh = expandAdminModelHistoryDay(current());
  assert.deepEqual(fresh.byModel["gpt-6-astra"], { capacityUsd: 2_000, participantCount: 2 });
  assert.deepEqual(fresh.byModel["gpt-5.4"], { capacityUsd: null, participantCount: 0 });
  assert.deepEqual(fresh.byModel["gpt-5.3-codex-spark"], { capacityUsd: null, participantCount: null });
  assert.deepEqual(browser.expandAdminModelHistoryDay(wire), old);
  assert.deepEqual(browser.expandAdminModelHistoryDay(current()), fresh);
  assert.ok(ADMIN_MODEL_CONFIG.some((model) => model.modelId === "o1"));
  assert.ok(ADMIN_MODEL_CONFIG.some((model) => model.modelId === "gpt-5.5-codex"));
});

test("admin model history fails closed on extra fields, raw IDs, invalid tuples and counters", () => {
  const bad = [
    { ...current(), privatePath: "/private/canary" },
    { ...current(), catalogVersion: "unreviewed" },
    { ...current(), day: "2026-02-30" },
    { ...current(), fittedParticipantCount: 0 },
    { ...current(), values: [["private-model-canary", 1, 1]] },
    { ...current(), values: [["gpt-5.3-codex-spark", 1, 1]] },
    { ...current(), values: [["gpt-6-astra", 1, 1], ["gpt-6-astra", 1, 1]] },
    { ...current(), values: [["gpt-6-astra", 1, 1, "private-canary"]] },
    { ...current(), values: [["gpt-6-astra", null, 0]] },
    ...[0, -1, NaN, Infinity, "1"].map((value) => ({ ...current(), values: [["gpt-6-astra", value, 1]] })),
    ...[0, -1, 3, 0.5, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ ...current(), values: [["gpt-6-astra", 1, value]] })),
  ];
  for (const value of bad) {
    assert.equal(projectAdminModelHistoryDay(value), null);
    assert.equal(browser.projectAdminModelHistoryDay(value), null);
  }
});

test("70 complete catalog days remain bounded even at maximum count/number serialization", () => {
  const day = { ...current(), ...Object.fromEntries(Object.keys(counts()).map((key) => [key, 0])),
    fittedParticipantCount: Number.MAX_SAFE_INTEGER,
    v1ParticipantCount: Number.MAX_SAFE_INTEGER,
    values: ADMIN_MODEL_CONFIG.filter((model) => model.allowanceTrack === "primary")
      .map((model) => [model.modelId, 1.7976931348623157e308, Number.MAX_SAFE_INTEGER]),
  };
  assert.notEqual(projectAdminModelHistoryDay(day), null);
  const days = Array.from({ length: 70 }, () => projectAdminModelHistoryDay(day));
  // Leave a separately tested 64 KiB allowance for the outer blended preview.
  assert.ok(Buffer.byteLength(JSON.stringify({ modelConfig: ADMIN_MODEL_CONFIG, days })) < 192 * 1024);
});
