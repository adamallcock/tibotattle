import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyQuotaResetTimeline,
  createResetEventClassifier,
  mergeQuotaResetEvents,
  normalizeResetEventContinuity,
  normalizeQuotaResetEvent,
  QUOTA_RESET_CLASSIFICATION_POLICY,
  RESET_EVENT_CONTINUITY_SCHEMA_VERSION,
} from "../index.js";

const ACCOUNT = "openai-account:v1:synthetic-reset-classifier";
const RESET_AT = "2026-09-20T00:00:00.000Z";

function window(usedPercent, resetAt = RESET_AT, durationMinutes = 10_080) {
  return {
    provider: "openai_codex",
    planType: "pro",
    limitId: "codex",
    usedPercent,
    resetAt,
    durationMinutes,
  };
}

function observation(observedAt, usedPercent, {
  resetAt = RESET_AT,
  accountScopeId = ACCOUNT,
  resetCredits = undefined,
} = {}) {
  return {
    observedAt,
    accountScopeId,
    windows: [window(usedPercent, resetAt)],
    ...(resetCredits === undefined ? {} : { resetCredits }),
  };
}

function inventory(availableCount, credits, detailsStatus = "complete") {
  return { availableCount, detailsStatus, credits };
}

test("public reset classifiers fail closed on empty and malformed inputs", () => {
  assert.deepEqual(classifyQuotaResetTimeline(null), []);
  assert.deepEqual(classifyQuotaResetTimeline([]), []);
  assert.deepEqual(mergeQuotaResetEvents(null, undefined), []);
  const classifier = createResetEventClassifier();
  assert.deepEqual(classifier.observe(null), []);
  assert.deepEqual(classifier.observe({}), []);
});

test("scheduled reset reconstruction brackets the provider schedule", () => {
  const before = observation("2026-09-10T00:00:00.000Z", 88, {
      resetAt: "2026-09-10T05:00:00.000Z",
    });
  const after = observation("2026-09-10T06:00:00.000Z", 2, {
      resetAt: "2026-09-17T05:00:00.000Z",
    });
  const events = classifyQuotaResetTimeline([before, after]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    schemaVersion: "quota-reset-event-v0.1",
    kind: "scheduled_reset",
    occurredAt: "2026-09-10T05:00:00.000Z",
    observedAt: "2026-09-10T06:00:00.000Z",
    intervalStartedAt: "2026-09-10T00:00:00.000Z",
    precision: "provider_schedule",
    reason: "scheduled_boundary",
    provider: "openai_codex",
    planType: "pro",
    limitId: "codex",
    windowDurationMins: 10_080,
  });
  const prospective = createResetEventClassifier();
  assert.deepEqual(prospective.observe(before), []);
  assert.deepEqual(
    prospective.observe(after).map((event) => event.kind),
    ["scheduled_reset"],
    "the prospective collector can durably store natural reset boundaries",
  );
});

test("an unscheduled same-window drop needs a second low observation", () => {
  const firstDrop = [
    observation("2026-09-10T00:00:00.000Z", 88),
    observation("2026-09-10T01:00:00.000Z", 4),
  ];
  assert.deepEqual(classifyQuotaResetTimeline(firstDrop), []);
  const events = classifyQuotaResetTimeline([
    ...firstDrop,
    observation("2026-09-10T01:05:00.000Z", 5),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "unknown_reset");
  assert.equal(events[0].occurredAt, "2026-09-10T01:00:00.000Z");
  assert.equal(events[0].reason, "confirmed_unscheduled_quota_drop");
});

test("stale dips and account changes do not manufacture reset continuity", () => {
  assert.deepEqual(classifyQuotaResetTimeline([
    observation("2026-09-10T00:00:00.000Z", 88),
    observation("2026-09-10T01:00:00.000Z", 4),
    observation("2026-09-10T01:05:00.000Z", 90),
  ]), []);
  assert.deepEqual(classifyQuotaResetTimeline([
    observation("2026-09-10T00:00:00.000Z", 88),
    observation("2026-09-10T01:00:00.000Z", 4, {
      accountScopeId: "openai-account:v1:another-synthetic-account",
    }),
    observation("2026-09-10T01:05:00.000Z", 5, {
      accountScopeId: "openai-account:v1:another-synthetic-account",
    }),
  ]), []);
  assert.deepEqual(classifyQuotaResetTimeline([
    observation("2026-09-10T00:00:00.000Z", 88),
    observation("2026-09-10T00:00:00.000Z", 4),
  ]), [], "duplicate observation instants fail closed");
  assert.deepEqual(classifyQuotaResetTimeline([{
    ...observation("2026-09-10T00:00:00.000Z", 88),
    windows: Array.from({ length: 257 }, (_, index) => ({
      ...window(88),
      limitId: `codex_${index}`,
    })),
  }]), [], "window collections are bounded before track allocation");
});

test("a pre-expiry count fall plus quota reset classifies a banked reset use", () => {
  const classifier = createResetEventClassifier();
  const credit = {
    id: "RateLimitResetCredit_synthetic",
    grantedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
  };
  assert.deepEqual(classifier.observe(observation(
    "2026-09-10T00:00:00.000Z",
    88,
    { resetCredits: inventory(1, [credit]) },
  )), []);
  const events = classifier.observe(observation(
    "2026-09-10T01:00:00.000Z",
    4,
    { resetCredits: inventory(0, [], "unavailable") },
  ));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "banked_reset_used");
  assert.equal(events[0].precision, "observation_interval");
  assert.equal(events[0].reason, "credit_count_decreased_before_expiry");
});

test("a bounded continuity checkpoint preserves banked classification across restart", () => {
  const credit = {
    id: "reset-credit:v1:synthetic_fingerprint",
    grantedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
  };
  const beforeRestart = createResetEventClassifier();
  beforeRestart.observe(observation("2026-09-10T00:00:00.000Z", 88, {
    resetCredits: inventory(1, [credit]),
  }));
  const checkpoint = beforeRestart.snapshot();
  assert.equal(checkpoint.schemaVersion, RESET_EVENT_CONTINUITY_SCHEMA_VERSION);
  assert.equal(checkpoint.timeline.length, 1);
  assert.equal(checkpoint.creditBaseline.resetCredits.credits[0].id, credit.id);

  const afterRestart = createResetEventClassifier();
  assert.equal(afterRestart.restore(checkpoint), true);
  const events = afterRestart.observe(observation(
    "2026-09-10T01:00:00.000Z",
    4,
    { resetCredits: inventory(0, []) },
  ));
  assert.deepEqual(events.map((event) => event.kind), ["banked_reset_used"]);
});

test("continuity checkpoints fail closed when malformed or too stale", () => {
  const credit = {
    id: "reset-credit:v1:stale_fingerprint",
    grantedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
  };
  const original = createResetEventClassifier();
  original.observe(observation("2026-09-10T00:00:00.000Z", 88, {
    resetCredits: inventory(1, [credit]),
  }));
  const checkpoint = original.snapshot();
  assert.equal(normalizeResetEventContinuity({
    ...checkpoint,
    privateProviderId: "must-not-survive",
  }), null);

  const restored = createResetEventClassifier();
  assert.equal(restored.restore({}), false);
  assert.equal(restored.restore(checkpoint), true);
  const staleAt = new Date(
    Date.parse("2026-09-10T00:00:00.000Z")
      + QUOTA_RESET_CLASSIFICATION_POLICY.maximumCreditContinuityGapMs
      + 1,
  ).toISOString();
  assert.deepEqual(restored.observe(observation(staleAt, 4, {
    resetCredits: inventory(0, []),
  })), [], "an old credit baseline cannot prove a banked reset");
});

test("the material-drop boundary does not turn a five-point change into a reset", () => {
  const classifier = createResetEventClassifier();
  const credit = {
    id: "RateLimitResetCredit_noise_boundary",
    grantedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
  };
  classifier.observe(observation("2026-09-10T00:00:00.000Z", 50, {
    resetCredits: inventory(1, [credit]),
  }));
  assert.deepEqual(classifier.observe(observation(
    "2026-09-10T01:00:00.000Z",
    45,
    { resetCredits: inventory(0, []) },
  )), []);
});

test("grant and expiry lifecycle markers require complete or exact evidence", () => {
  const classifier = createResetEventClassifier();
  classifier.observe(observation("2026-09-10T00:00:00.000Z", 20, {
    resetCredits: inventory(0, []),
  }));
  const granted = classifier.observe(observation("2026-09-10T01:00:00.000Z", 21, {
    resetCredits: inventory(1, [{
      id: "RateLimitResetCredit_granted",
      grantedAt: "2026-09-10T00:30:00.000Z",
      expiresAt: "2026-10-10T00:30:00.000Z",
    }]),
  }));
  assert.deepEqual(granted.map((event) => event.kind), ["reset_credit_granted"]);

  const expired = classifier.observe(observation("2026-10-10T01:00:00.000Z", 22, {
    resetAt: "2026-10-20T00:00:00.000Z",
    resetCredits: inventory(0, []),
  }));
  assert.deepEqual(expired.map((event) => event.kind), [
    "scheduled_reset",
    "reset_credit_expired",
  ]);
  assert.equal(expired[1].occurredAt, "2026-10-10T00:30:00.000Z");
});

test("capped detail rows, malformed observations, reset and account switches fail closed", () => {
  const credit = {
    id: "RateLimitResetCredit_partial",
    grantedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
  };
  const classifier = createResetEventClassifier();
  classifier.observe(observation("2026-09-10T00:00:00.000Z", 88, {
    resetCredits: inventory(2, [credit], "partial"),
  }));
  assert.deepEqual(classifier.observe(observation(
    "2026-09-10T01:00:00.000Z",
    4,
    { resetCredits: inventory(1, [], "unavailable") },
  )), []);

  classifier.reset();
  assert.deepEqual(classifier.observe(observation(
    "2026-09-10T02:00:00.000Z",
    3,
    { resetCredits: inventory(0, []) },
  )), []);
  assert.deepEqual(classifier.observe({
    ...observation("2026-09-10T03:00:00.000Z", 2, {
      resetCredits: inventory(0, []),
    }),
    windows: [window(2), window(3)],
  }), []);

  const switched = createResetEventClassifier();
  switched.observe(observation("2026-09-10T00:00:00.000Z", 88, {
    resetCredits: inventory(1, [credit]),
  }));
  assert.deepEqual(switched.observe(observation(
    "2026-09-10T01:00:00.000Z",
    4,
    {
      accountScopeId: "openai-account:v1:another-synthetic-account",
      resetCredits: inventory(0, []),
    },
  )), []);
});

test("prospective banked evidence replaces the matching reconstructed unknown", () => {
  const unknown = classifyQuotaResetTimeline([
    observation("2026-09-10T00:00:00.000Z", 88),
    observation("2026-09-10T01:00:00.000Z", 4),
    observation("2026-09-10T01:05:00.000Z", 5),
  ])[0];
  const banked = {
    ...unknown,
    kind: "banked_reset_used",
    observedAt: "2026-09-10T01:00:00.000Z",
    reason: "credit_count_decreased_before_expiry",
  };
  const merged = mergeQuotaResetEvents([unknown], [banked, banked]);
  assert.deepEqual(merged.map((event) => event.kind), ["banked_reset_used"]);
  assert.equal(normalizeQuotaResetEvent({ ...banked, privateId: "no" }), null);
  assert.equal(normalizeQuotaResetEvent({
    ...banked,
    reason: "scheduled_boundary",
  }), null, "kind, reason, and precision are one closed contract");
  assert.equal(normalizeQuotaResetEvent(null), null);
});

test("overlapping scheduled and unexpired-credit evidence remains unknown", () => {
  const classifier = createResetEventClassifier();
  const before = observation("2026-09-10T00:00:00.000Z", 88, {
    resetAt: "2026-09-10T01:00:00.000Z",
    resetCredits: inventory(1, [{
      id: "RateLimitResetCredit_conflict",
      grantedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
    }]),
  });
  const after = observation("2026-09-10T01:05:00.000Z", 4, {
    resetAt: "2026-09-17T01:00:00.000Z",
    resetCredits: inventory(0, []),
  });
  classifier.observe(before);
  const prospective = classifier.observe(after);
  assert.deepEqual(prospective.map((event) => [event.kind, event.reason]), [[
    "unknown_reset",
    "overlapping_scheduled_and_credit_evidence",
  ]]);
  const merged = mergeQuotaResetEvents(
    classifyQuotaResetTimeline([before, after]),
    prospective,
  );
  assert.deepEqual(merged.map((event) => event.kind), ["unknown_reset"]);
});
