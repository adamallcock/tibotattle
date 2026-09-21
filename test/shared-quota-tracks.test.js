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
  assert.notEqual(
    resetKey(row),
    resetKey({ ...row, windowDurationMinutes: 43_200 }),
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

test("a 43,200-minute provider-reported window is admitted without changing track accounting", () => {
  const result = buildResetEvidence(fixture({ duration: 43_200 })).resets[0];
  assert.equal(result.status, "eligible");
  assert.deepEqual(result.boundaries, buildResetEvidence(fixture()).resets[0].boundaries);
  assert.equal(result.totalCostNanousd, 42_000_000_000);
  assert.equal(result.windowDurationMinutes, 43_200);
});

test("invalid provider-reported durations are rejected at track admission", () => {
  for (const duration of [0, 1.5, Number.MAX_SAFE_INTEGER + 1, 525_601]) {
    assert.throws(
      () => buildResetEvidence(fixture({ duration })),
      /quota_tracks_invalid_input/u,
      String(duration),
    );
  }
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

test("one instant reported more than once collapses to its highest reading", () => {
  // A rollout that inherits history replays its ancestor's records carrying the
  // ancestor's OLD rate-limit reading, and a parallel fan-out emits several at
  // one instant with several stale values. Used percent only climbs within a
  // window, so the reading that is not stale is the highest. Refusing the whole
  // cycle — which `ambiguous_quota_observation` used to do — discarded a real
  // reset over a disagreement usually smaller than the tolerated jitter.
  const replayed = fixture({ idOffset: 400 });
  const original = replayed.quotaSnapshots[5];
  // Replayed copies carry the ancestor's EARLIER reading, so they are lower
  // than the true one. They can only be higher if the ancestor read a different
  // pool — and a different pool carries a different `resets_at`, which lands in
  // a different reset group and never reaches this collapse.
  for (const [index, stale] of [1, 2, 3].entries()) {
    replayed.quotaSnapshots.push({
      ...original,
      snapshotId: opaqueId("snapshot", 8_000 + index),
      usedPercent: stale,
    });
  }
  const collapsed = buildResetEvidence(replayed);
  assert.equal(collapsed.resetCount, 1);
  const [reset] = collapsed.resets;
  assert.ok(!reset.refusalCodes.includes("ambiguous_quota_observation"));
  // The replayed copies neither add observations nor move the climb: the
  // highest reading at that instant wins, and here that is the original.
  assert.equal(reset.snapshotCount, 8);
  const atInstant = reset.quotaSeries.filter(
    (row) => row.observedAt === original.observedAt,
  );
  assert.equal(atInstant.length, 1);
  assert.equal(atInstant[0].usedPercent, 5);
  // And the collapse cannot fabricate a backward step for the splitter to cut.
  assert.ok(!reset.refusalCodes.includes("backward_quota_observation"));
});

test("a second slot in the same group never looks like a cycle restart", () => {
  // `slot` is absent from the group key, so one reset group carries both the
  // primary and the secondary series. Their levels are unrelated, so in
  // observation order a primary->secondary step can look like an enormous fall.
  // Comparing across slots would split a perfectly healthy group and multiply
  // one real cycle into several partial ones.
  const twoSlots = fixture({ idOffset: 500 });
  twoSlots.quotaSnapshots = twoSlots.quotaSnapshots.slice(0, 4)
    .map((row, index) => ({ ...row, usedPercent: 60 + index * 10 }));
  for (let index = 0; index < 4; index += 1) {
    twoSlots.quotaSnapshots.push({
      ...twoSlots.quotaSnapshots[0],
      snapshotId: opaqueId("snapshot", 9_500 + index),
      slot: "secondary",
      // A disjoint later span, so this is a second pool rather than a slot
      // conflict — and it sits far below the primary, making the crossover a
      // large apparent fall.
      observedAt: instant(4 + index),
      receivedAt: instant(4 + index),
      usedPercent: 1 + index,
    });
  }
  const evidence = buildResetEvidence(twoSlots);
  assert.equal(evidence.resetCount, 1);
  assert.deepEqual(evidence.resets[0].slots, ["primary", "secondary"]);
  assert.ok(!evidence.resets[0].refusalCodes.includes("backward_quota_observation"));
  assert.ok(!evidence.resets[0].refusalCodes.includes("simultaneous_slot_conflict"));

  // A genuine restart INSIDE one slot still splits, with the other slot present.
  const restartWithinSlot = fixture({ idOffset: 600 });
  restartWithinSlot.quotaSnapshots = restartWithinSlot.quotaSnapshots.slice(0, 4)
    .map((row, index) => ({ ...row, usedPercent: 60 + index * 10 }));
  restartWithinSlot.quotaSnapshots[3].usedPercent = 2;
  for (let index = 0; index < 4; index += 1) {
    restartWithinSlot.quotaSnapshots.push({
      ...restartWithinSlot.quotaSnapshots[0],
      snapshotId: opaqueId("snapshot", 9_600 + index),
      slot: "secondary",
      observedAt: instant(4 + index),
      receivedAt: instant(4 + index),
      usedPercent: 1 + index,
    });
  }
  assert.equal(buildResetEvidence(restartWithinSlot).resetCount, 2);
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

  // A fall past the jitter tolerance is a CYCLE RESTART, not a refusal. The
  // provider re-reports one `resets_at` across a pool refresh, so a single
  // reset group can hold a climb, a refresh and a fresh climb; refusing the
  // group discarded both cycles. It is split instead, and each side is fitted
  // from its own origin.
  const restart = fixture({ idOffset: 200 });
  restart.quotaSnapshots[7].usedPercent = 0;
  const restarted = buildResetEvidence(restart);
  assert.equal(restarted.resetCount, 2);
  assert.ok(restarted.resets.every(
    (reset) => !reset.refusalCodes.includes("backward_quota_observation"),
  ));
  // The first segment keeps the whole climb; the second starts at the low.
  assert.equal(restarted.resets[0].snapshotCount, 7);
  assert.equal(restarted.resets[0].boundaries.at(-1).usedPercent, 6);
  assert.equal(restarted.resets[1].snapshotCount, 1);
  assert.equal(restarted.resets[1].quotaSeries[0].usedPercent, 0);
  // A one-observation segment still fails closed on its own terms.
  assert.ok(restarted.resets[1].refusalCodes.includes(
    "insufficient_quota_observations",
  ));
  // A fall INSIDE the tolerance is still jitter and must not split.
  const jitter = fixture({ idOffset: 250 });
  jitter.quotaSnapshots[7].usedPercent = 2;
  assert.equal(buildResetEvidence(jitter).resetCount, 1);

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
