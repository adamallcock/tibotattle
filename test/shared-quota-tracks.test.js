import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResetEvidence,
  continuityKey,
  resetKey,
} from "@app-usagemonitor/quota-analysis";

function opaqueId(kind, value) {
  return `${kind}:v1:${BigInt(value).toString(16).padStart(64, "0")}`;
}

function instant(hour, minute = 0) {
  return new Date(Date.UTC(2026, 6, 1, hour, minute)).toISOString();
}

function fixture({
  duration = 300,
  accountNumber = 1,
  idOffset = 0,
  provider = "openai",
} = {}) {
  const datasetId = opaqueId("dataset", 1_000 + idOffset);
  const accountTrackId = opaqueId("account-track", accountNumber);
  const quotaSnapshots = Array.from({ length: 8 }, (_, index) => ({
    snapshotId: opaqueId("snapshot", 2_000 + idOffset + index),
    datasetId,
    accountTrackId,
    provider,
    planType: "subscription",
    planVariant: "pro",
    limitId: "shared-quota",
    slot: "primary",
    windowDurationMinutes: duration,
    resetsAt: instant(12),
    observedAt: instant(index),
    receivedAt: instant(index),
    usedPercent: index,
    displayPrecision: 0,
    policyEpoch: "quota-v1",
  }));
  const usageEvents = Array.from({ length: 7 }, (_, index) => ({
    eventId: opaqueId("event", 3_000 + idOffset + index),
    datasetId,
    accountTrackId,
    provider,
    planType: "subscription",
    planVariant: "pro",
    limitId: "shared-quota",
    observedAt: instant(index, 30),
    costNanousd: 6_000_000_000,
    pricingStatus: "fully_priced",
    policyEpoch: "quota-v1",
  }));
  return {
    datasets: [{ datasetId, complete: true }],
    quotaSnapshots,
    usageEvents,
  };
}

function resetFor(input, accountTrackId) {
  return buildResetEvidence(input).resets.find(
    (row) => row.accountTrackId === accountTrackId,
  );
}

test("continuity and reset identities exclude slot and retain duration", () => {
  const row = fixture().quotaSnapshots[0];
  const moved = { ...row, slot: "secondary" };
  assert.equal(continuityKey(row), continuityKey(moved));
  assert.equal(resetKey(row), resetKey(moved));
  assert.notEqual(
    continuityKey(row),
    continuityKey({ ...row, windowDurationMinutes: 10_080 }),
  );
});

test("five-hour and seven-day tracks use the same evidence semantics", () => {
  const fiveHour = buildResetEvidence(fixture({ duration: 300 })).resets[0];
  const sevenDay = buildResetEvidence(
    fixture({ duration: 10_080, idOffset: 100 }),
  ).resets[0];
  assert.equal(fiveHour.status, "eligible");
  assert.equal(sevenDay.status, "eligible");
  assert.deepEqual(sevenDay.boundaries, fiveHour.boundaries);
  assert.equal(sevenDay.totalCostNanousd, fiveHour.totalCostNanousd);
  assert.equal(sevenDay.windowDurationMinutes, 10_080);
});

test("foreign accounts and track fields are isolated from an existing reset", () => {
  const base = fixture();
  const accountId = base.quotaSnapshots[0].accountTrackId;
  const before = resetFor(base, accountId);
  const foreign = fixture({
    accountNumber: 2,
    idOffset: 100,
    provider: "anthropic",
  });
  const combined = {
    datasets: [...base.datasets, ...foreign.datasets],
    quotaSnapshots: [...base.quotaSnapshots, ...foreign.quotaSnapshots],
    usageEvents: [...base.usageEvents, ...foreign.usageEvents],
  };
  assert.deepEqual(resetFor(combined, accountId), before);
  assert.equal(buildResetEvidence(combined).resetCount, 2);
});

test("sequential slot movement is accepted while overlapping slots are refused", () => {
  const moved = fixture();
  moved.quotaSnapshots = moved.quotaSnapshots.map((row, index) => ({
    ...row,
    slot: index < 4 ? "primary" : "secondary",
  }));
  assert.equal(buildResetEvidence(moved).resets[0].status, "eligible");

  const conflict = fixture({ idOffset: 100 });
  conflict.quotaSnapshots = conflict.quotaSnapshots.map((row, index) => ({
    ...row,
    slot: index % 2 === 0 ? "primary" : "secondary",
  }));
  const refused = buildResetEvidence(conflict).resets[0];
  assert.equal(refused.status, "refused");
  assert.ok(refused.refusalCodes.includes("simultaneous_slot_conflict"));
});

test("partial, stale, backward, and incompletely priced evidence fails closed", () => {
  const partial = fixture();
  partial.datasets[0].complete = false;
  assert.ok(
    buildResetEvidence(partial).resets[0].refusalCodes.includes("incomplete_dataset"),
  );

  const hiddenPartial = fixture({ idOffset: 50 });
  const incompleteDatasetId = opaqueId("dataset", 9_999);
  hiddenPartial.datasets.push({ datasetId: incompleteDatasetId, complete: false });
  hiddenPartial.quotaSnapshots.push({
    ...hiddenPartial.quotaSnapshots[0],
    snapshotId: opaqueId("snapshot", 9_999),
    datasetId: incompleteDatasetId,
  });
  assert.ok(
    buildResetEvidence(hiddenPartial).resets[0].refusalCodes.includes(
      "incomplete_dataset",
    ),
  );

  const stale = fixture({ idOffset: 100 });
  stale.quotaSnapshots[3].receivedAt = instant(3, 6);
  assert.ok(
    buildResetEvidence(stale).resets[0].refusalCodes.includes(
      "stale_quota_observation",
    ),
  );

  const backward = fixture({ idOffset: 200 });
  backward.quotaSnapshots[4].usedPercent = 2;
  assert.ok(
    buildResetEvidence(backward).resets[0].refusalCodes.includes(
      "backward_quota_observation",
    ),
  );

  const unpriced = fixture({ idOffset: 300 });
  unpriced.usageEvents[2].pricingStatus = "partially_priced";
  assert.ok(
    buildResetEvidence(unpriced).resets[0].refusalCodes.includes(
      "incomplete_server_pricing",
    ),
  );
});

test("deduplication and input order are deterministic, and unknown fields are rejected", () => {
  const original = fixture();
  const expected = buildResetEvidence(original);
  const reordered = {
    datasets: [...original.datasets, ...original.datasets].reverse(),
    quotaSnapshots: [
      ...original.quotaSnapshots,
      ...original.quotaSnapshots,
    ].reverse(),
    usageEvents: [...original.usageEvents, ...original.usageEvents].reverse(),
  };
  assert.deepEqual(buildResetEvidence(reordered), expected);
  assert.throws(
    () => buildResetEvidence({
      ...original,
      quotaSnapshots: [
        { ...original.quotaSnapshots[0], unexpected: true },
        ...original.quotaSnapshots.slice(1),
      ],
    }),
    /quota_tracks_invalid_input/u,
  );
});
