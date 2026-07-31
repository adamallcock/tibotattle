import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as contribution from "../src/contribution/index.js";
import * as policy from "../src/contribution/recurrence-policy.js";
import {
  AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
  AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS,
  AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS,
  AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION,
  AutomaticContributionError,
  automaticContributionRequiredConsent,
  claimAutomaticContributionRun,
  completeAutomaticContributionRun,
  createInitialAutomaticContributionState,
  disableAutomaticContribution,
  enableAutomaticContribution,
  parseAutomaticContributionState,
  projectAutomaticContributionStatus,
  recordPreparedAutomaticContribution,
  recordReviewedManualAcceptance,
} from "../src/contribution/recurrence-policy.js";

const ORIGIN = "https://usage.example.test";
const OTHER_ORIGIN = "https://other.example.test";
const FIRST_SET_ID = "a".repeat(64);
const NEXT_SET_ID = "b".repeat(64);
const PREPARATION_ID = "00000000-0000-4000-8000-000000000001";
const REVIEWED_AT = "2026-07-29T12:00:00.000Z";
const ATTEMPTED_AT = "2026-07-29T18:00:00.000Z";
const COVERAGE = Object.freeze({
  startAt: "2026-07-29T11:00:00.000Z",
  endAt: "2026-07-29T12:00:00.000Z",
});
const NEXT_COVERAGE = Object.freeze({
  startAt: "2026-07-29T11:00:00.000Z",
  endAt: "2026-07-29T18:00:00.000Z",
});

function preparedSet({
  preparedSetId = FIRST_SET_ID,
  coveredAt = COVERAGE,
  acceptedJobs = 1,
  pendingJobs = 0,
  retryableJobs = 0,
  inFlightJobs = 0,
  rejectedJobs = 0,
} = {}) {
  const totalJobs = acceptedJobs + pendingJobs + retryableJobs
    + inFlightJobs + rejectedJobs;
  return {
    preparedSetId,
    coveredAt: { ...coveredAt },
    totalJobs,
    acceptedJobs,
    pendingJobs,
    retryableJobs,
    inFlightJobs,
    rejectedJobs,
    completeAccepted: acceptedJobs === totalJobs,
  };
}

function reviewedState() {
  return recordReviewedManualAcceptance(createInitialAutomaticContributionState(), {
    destinationOrigin: ORIGIN,
    status: "completed",
    accepted: 1,
    preparedSet: preparedSet(),
    acceptedAt: REVIEWED_AT,
  });
}

function enabledState() {
  return enableAutomaticContribution(reviewedState(), {
    destinationOrigin: ORIGIN,
    intervalHours: AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS,
    consent: automaticContributionRequiredConsent({ destinationOrigin: ORIGIN }),
    consentedAt: REVIEWED_AT,
  });
}

function preparedAutomaticState() {
  const claimed = claimAutomaticContributionRun(enabledState(), {
    destinationOrigin: ORIGIN,
    attemptedAt: ATTEMPTED_AT,
    preparationId: PREPARATION_ID,
  });
  return recordPreparedAutomaticContribution(claimed.state, {
    destinationOrigin: ORIGIN,
    preparedAt: ATTEMPTED_AT,
    preparationId: PREPARATION_ID,
    preparedSetId: NEXT_SET_ID,
    coveredAt: NEXT_COVERAGE,
  });
}

function fixedError(code) {
  return (error) => error instanceof AutomaticContributionError
    && error.code === `automatic_contribution_${code}`;
}

test("the contribution facade adds only the recurrence policy identities", () => {
  const recurrenceExports = [
    "AUTOMATIC_CONTRIBUTION_INTERVAL_HOURS",
    "AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS",
    "AUTOMATIC_CONTRIBUTION_PRIVACY_CONTRACT_VERSION",
    "AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS",
    "AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION",
    "AUTOMATIC_CONTRIBUTION_STATUS_SCHEMA_VERSION",
    "AutomaticContributionError",
    "automaticContributionRequiredConsent",
    "claimAutomaticContributionRun",
    "completeAutomaticContributionRun",
    "createInitialAutomaticContributionState",
    "disableAutomaticContribution",
    "enableAutomaticContribution",
    "parseAutomaticContributionState",
    "projectAutomaticContributionStatus",
    "recordPreparedAutomaticContribution",
    "recordReviewedManualAcceptance",
  ];
  assert.deepEqual(Object.keys(policy).sort(), [...recurrenceExports].sort());
  assert.deepEqual(
    Object.keys(contribution).filter((name) => recurrenceExports.includes(name)).sort(),
    [...recurrenceExports].sort(),
  );
  assert.strictEqual(
    contribution.createInitialAutomaticContributionState,
    createInitialAutomaticContributionState,
  );
});

test("policy source is Node-free and has no runtime controller capability", async () => {
  const source = await readFile(
    new URL("../src/contribution/recurrence-policy.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /from "node:|\b(?:process|randomUUID|setTimeout|AbortController)\b/u);
  assert.match(source, /from "\.\/telemetry-v01-projection\.js"/u);
  assert.match(source, /from "\.\.\/export\/index\.js"/u);
});

test("required consent accepts only the reviewed canonical origins", () => {
  for (const origin of [null, ORIGIN, "http://127.0.0.1:8787"]) {
    assert.equal(
      automaticContributionRequiredConsent({ destinationOrigin: origin }).destinationOrigin,
      origin,
    );
  }
  for (const origin of [
    "https://usage.example.test/", "http://usage.example.test", "http://127.0.0.1",
    "https://localhost", "https://usage.example.test/path", "https://u:p@usage.example.test",
  ]) {
    assert.throws(
      () => automaticContributionRequiredConsent({ destinationOrigin: origin }),
      (error) => error instanceof AutomaticContributionError
        && error.code === "automatic_contribution_configuration_invalid",
    );
  }
});

test("parser migrates all supported schemas without mutation and rejects non-data inputs", () => {
  const initial = createInitialAutomaticContributionState();
  const v01 = {
    schemaVersion: "automatic-contribution-settings-v0.1",
    enabled: false,
    paused: false,
    intervalHours: 6,
    consent: null,
    reviewBootstrap: null,
    lastAttemptAt: REVIEWED_AT,
    lastSuccessAt: null,
    lastOutcome: null,
  };
  const v02 = {
    ...initial,
    schemaVersion: "automatic-contribution-settings-v0.2",
  };
  delete v02.preparationClaim;
  for (const source of [initial, v01, v02]) {
    const before = structuredClone(source);
    const parsed = parseAutomaticContributionState(source);
    assert.equal(parsed.schemaVersion, AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION);
    assert.deepEqual(source, before);
  }
  for (const source of [
    { ...initial, unknown: true },
    Object.defineProperty({ ...initial }, "enabled", { get: () => false }),
    new Proxy(initial, {}),
  ]) {
    assert.throws(
      () => parseAutomaticContributionState(source),
      (error) => error?.code === "automatic_contribution_settings_unavailable",
    );
  }
});

test("v0.2 migration preserves its reviewed checkpoint and drops only its absent claim", () => {
  const rich = preparedAutomaticState();
  const v02 = { ...rich, schemaVersion: "automatic-contribution-settings-v0.2" };
  delete v02.preparationClaim;
  const before = structuredClone(v02);
  const migrated = parseAutomaticContributionState(v02);
  assert.deepEqual(v02, before);
  assert.equal(migrated.schemaVersion, AUTOMATIC_CONTRIBUTION_SETTINGS_SCHEMA_VERSION);
  assert.deepEqual(migrated.reviewBootstrap, rich.reviewBootstrap);
  assert.deepEqual(migrated.acceptedThrough, rich.acceptedThrough);
  assert.deepEqual(migrated.pendingContribution, rich.pendingContribution);
  assert.equal(migrated.preparationClaim, null);
  assert.deepEqual(migrated.consent, rich.consent);
  assert.equal(migrated.lastAttemptAt, rich.lastAttemptAt);
});

test("status precedence keeps destination drift readable without exposing state identifiers", () => {
  const initial = createInitialAutomaticContributionState();
  assert.equal(projectAutomaticContributionStatus(initial).status, "not_configured");
  assert.equal(projectAutomaticContributionStatus(initial, {
    destinationOrigin: ORIGIN,
    settingsAvailable: false,
  }).status, "failed");
  assert.equal(projectAutomaticContributionStatus(initial, {
    destinationOrigin: ORIGIN,
  }).status, "first_review_required");
  const scheduled = projectAutomaticContributionStatus(enabledState(), {
    destinationOrigin: ORIGIN,
  });
  assert.equal(scheduled.status, "scheduled");
  assert.equal(scheduled.nextAttemptAt, ATTEMPTED_AT);
  assert.equal("acceptedThrough" in scheduled, false);
  assert.equal("pendingContribution" in scheduled, false);
  assert.equal("preparationClaim" in scheduled, false);
  const drifted = projectAutomaticContributionStatus(enabledState(), {
    destinationOrigin: OTHER_ORIGIN,
  });
  assert.equal(drifted.status, "first_review_required");
  assert.equal(drifted.consentCurrent, false);
});

test("status handles unavailable malformed state and every valid precedence branch", () => {
  const disabled = projectAutomaticContributionStatus(reviewedState(), {
    destinationOrigin: ORIGIN,
  });
  assert.equal(disabled.status, "disabled");
  const consentRequiredState = {
    ...reviewedState(),
    enabled: true,
    consent: {
      ...automaticContributionRequiredConsent({ destinationOrigin: OTHER_ORIGIN }),
      consentedAt: REVIEWED_AT,
    },
  };
  assert.equal(projectAutomaticContributionStatus(consentRequiredState, {
    destinationOrigin: ORIGIN,
  }).status, "consent_required");
  assert.equal(projectAutomaticContributionStatus(enabledState(), {
    destinationOrigin: ORIGIN,
    running: true,
  }).status, "running");
  assert.equal(projectAutomaticContributionStatus({ ...enabledState(), paused: true }, {
    destinationOrigin: ORIGIN,
  }).status, "paused");
  const malformed = { bad: "unavailable" };
  const unavailable = projectAutomaticContributionStatus(malformed, {
    destinationOrigin: ORIGIN,
    settingsAvailable: false,
  });
  assert.equal(unavailable.status, "failed");
  assert.equal(unavailable.lastOutcome, null);
  const validDiagnostics = {
    ...enabledState(),
    lastOutcome: {
      status: "failed",
      code: "retry_scheduled",
      at: ATTEMPTED_AT,
    },
  };
  const failed = projectAutomaticContributionStatus(validDiagnostics, {
    destinationOrigin: ORIGIN,
    settingsAvailable: false,
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.lastOutcome, validDiagnostics.lastOutcome);
});

test("public status is a frozen, privacy-safe projection with frozen nested records", () => {
  const completed = completeAutomaticContributionRun(preparedAutomaticState(), {
    destinationOrigin: ORIGIN,
    completedAt: "2026-07-30T00:00:00.000Z",
    event: {
      code: "accepted",
      pause: false,
      preparedSet: preparedSet({ preparedSetId: NEXT_SET_ID, coveredAt: NEXT_COVERAGE }),
    },
  });
  const status = projectAutomaticContributionStatus(completed, {
    destinationOrigin: ORIGIN,
  });
  assert.deepEqual(Object.keys(status).sort(), [
    "consentCurrent", "consentedAt", "daemonInstalled", "enabled", "firstReviewComplete",
    "firstReviewedAcceptedAt", "foregroundOnly", "includesContent", "includesCredentials",
    "includesIdentifiers", "includesPaths", "intervalHours", "lastAttemptAt", "lastOutcome",
    "lastSuccessAt", "networkActivity", "nextAttemptAt", "requiredConsent", "schemaVersion", "status",
  ].sort());
  assert.equal(Object.isFrozen(status), true);
  assert.equal(Object.isFrozen(status.requiredConsent), true);
  assert.equal(Object.isFrozen(status.lastOutcome), true);
  for (const key of ["acceptedThrough", "pendingContribution", "preparationClaim", "preparedSetId"]) {
    assert.equal(key in status, false);
  }
});

test("review, enable, claim, prepared and completion transitions preserve write-ahead state", () => {
  const source = enabledState();
  const before = structuredClone(source);
  const claimed = claimAutomaticContributionRun(source, {
    destinationOrigin: ORIGIN,
    attemptedAt: ATTEMPTED_AT,
    preparationId: PREPARATION_ID,
  });
  assert.deepEqual(source, before);
  assert.equal(claimed.claim.preparationClaim.preparationId, PREPARATION_ID);
  assert.equal(claimed.claim.preparationClaim.lookbackHours, AUTOMATIC_CONTRIBUTION_LOOKBACK_HOURS);
  assert.equal(claimed.claim.preparationClaim.replayOverlapHours, AUTOMATIC_CONTRIBUTION_REPLAY_OVERLAP_HOURS);
  let prepared = recordPreparedAutomaticContribution(claimed.state, {
    destinationOrigin: ORIGIN,
    preparedAt: ATTEMPTED_AT,
    preparationId: PREPARATION_ID,
    preparedSetId: NEXT_SET_ID,
    coveredAt: NEXT_COVERAGE,
  });
  const idempotent = recordPreparedAutomaticContribution(prepared, {
    destinationOrigin: ORIGIN,
    preparedAt: "2026-07-29T18:01:00.000Z",
    preparationId: PREPARATION_ID,
    preparedSetId: NEXT_SET_ID,
    coveredAt: NEXT_COVERAGE,
  });
  assert.deepEqual(idempotent, prepared);
  prepared = completeAutomaticContributionRun(prepared, {
    destinationOrigin: ORIGIN,
    completedAt: ATTEMPTED_AT,
    event: { code: "retry_scheduled", pause: false, preparedSet: null },
  });
  assert.equal(prepared.paused, false);
  assert.equal(prepared.pendingContribution.preparedSetId, NEXT_SET_ID);
  assert.equal(prepared.preparationClaim.preparationId, PREPARATION_ID);
  const completed = completeAutomaticContributionRun(prepared, {
    destinationOrigin: ORIGIN,
    completedAt: "2026-07-30T00:00:00.000Z",
    event: { code: "accepted", pause: false, preparedSet: preparedSet({
      preparedSetId: NEXT_SET_ID,
      coveredAt: NEXT_COVERAGE,
    }) },
  });
  assert.equal(completed.pendingContribution, null);
  assert.equal(completed.preparationClaim, null);
  assert.equal(completed.acceptedThrough.coveredThroughAt, NEXT_COVERAGE.endAt);
  assert.equal(completed.lastSuccessAt, "2026-07-30T00:00:00.000Z");
});

test("terminal outcomes retain exactly the required retry and recovery state", () => {
  const claimed = claimAutomaticContributionRun(enabledState(), {
    destinationOrigin: ORIGIN,
    attemptedAt: ATTEMPTED_AT,
    preparationId: PREPARATION_ID,
  });
  const prepared = recordPreparedAutomaticContribution(claimed.state, {
    destinationOrigin: ORIGIN,
    preparedAt: ATTEMPTED_AT,
    preparationId: PREPARATION_ID,
    preparedSetId: NEXT_SET_ID,
    coveredAt: NEXT_COVERAGE,
  });
  const publicationIncomplete = completeAutomaticContributionRun(prepared, {
    destinationOrigin: ORIGIN,
    completedAt: ATTEMPTED_AT,
    event: { code: "publication_incomplete", pause: false, preparedSet: null },
  });
  assert.equal(publicationIncomplete.pendingContribution, null);
  assert.equal(publicationIncomplete.preparationClaim.preparationId, PREPARATION_ID);
  const rejected = completeAutomaticContributionRun(prepared, {
    destinationOrigin: ORIGIN,
    completedAt: ATTEMPTED_AT,
    event: { code: "delivery_rejected", pause: true, preparedSet: null },
  });
  assert.equal(rejected.paused, true);
  assert.equal(rejected.pendingContribution.preparedSetId, NEXT_SET_ID);
  const disabled = disableAutomaticContribution(rejected);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.paused, false);
  assert.equal(disabled.consent, null);
  assert.throws(() => completeAutomaticContributionRun(prepared, {
    destinationOrigin: ORIGIN,
    completedAt: ATTEMPTED_AT,
    event: { code: "accepted", pause: false, preparedSet: null },
  }), (error) => error?.code === "automatic_contribution_configuration_invalid");
  assert.throws(() => completeAutomaticContributionRun(prepared, {
    destinationOrigin: ORIGIN,
    completedAt: ATTEMPTED_AT,
    event: { code: "anything_else", pause: false, preparedSet: null },
  }), (error) => error?.code === "automatic_contribution_configuration_invalid");
});

test("terminal event table preserves every exact pause and durable-state disposition", () => {
  const outcomes = [
    { code: "accepted", pause: false, pending: null, claim: null, watermark: NEXT_COVERAGE.endAt, success: true, status: "succeeded" },
    { code: "no_new_evidence", pause: false, pending: NEXT_SET_ID, claim: PREPARATION_ID, watermark: COVERAGE.endAt, success: false, status: "skipped" },
    { code: "retry_scheduled", pause: false, pending: NEXT_SET_ID, claim: PREPARATION_ID, watermark: COVERAGE.endAt, success: false, status: "failed" },
    { code: "delivery_rejected", pause: true, pending: NEXT_SET_ID, claim: PREPARATION_ID, watermark: COVERAGE.endAt, success: false, status: "failed" },
    { code: "preparation_failed", pause: true, pending: NEXT_SET_ID, claim: PREPARATION_ID, watermark: COVERAGE.endAt, success: false, status: "failed" },
    { code: "publication_incomplete", pause: false, pending: null, claim: PREPARATION_ID, watermark: COVERAGE.endAt, success: false, status: "failed" },
    { code: "upload_failed", pause: false, pending: NEXT_SET_ID, claim: PREPARATION_ID, watermark: COVERAGE.endAt, success: false, status: "failed" },
    { code: "upload_failed", pause: true, pending: NEXT_SET_ID, claim: PREPARATION_ID, watermark: COVERAGE.endAt, success: false, status: "failed" },
    { code: "run_timeout", pause: true, pending: NEXT_SET_ID, claim: PREPARATION_ID, watermark: COVERAGE.endAt, success: false, status: "failed" },
    { code: "queue_paused", pause: true, pending: NEXT_SET_ID, claim: PREPARATION_ID, watermark: COVERAGE.endAt, success: false, status: "paused" },
    { code: "privacy_verification_failed", pause: true, pending: NEXT_SET_ID, claim: PREPARATION_ID, watermark: COVERAGE.endAt, success: false, status: "paused" },
    { code: "identity_unavailable", pause: true, pending: NEXT_SET_ID, claim: PREPARATION_ID, watermark: COVERAGE.endAt, success: false, status: "paused" },
  ];
  for (const expected of outcomes) {
    const state = completeAutomaticContributionRun(preparedAutomaticState(), {
      destinationOrigin: ORIGIN,
      completedAt: "2026-07-30T00:00:00.000Z",
      event: {
        code: expected.code,
        pause: expected.pause,
        preparedSet: expected.code === "accepted"
          ? preparedSet({ preparedSetId: NEXT_SET_ID, coveredAt: NEXT_COVERAGE }) : null,
      },
    });
    assert.equal(state.paused, expected.pause, expected.code);
    assert.equal(state.pendingContribution?.preparedSetId ?? null, expected.pending, expected.code);
    assert.equal(state.preparationClaim?.preparationId ?? null, expected.claim, expected.code);
    assert.equal(state.acceptedThrough.coveredThroughAt, expected.watermark, expected.code);
    assert.equal(state.lastSuccessAt !== null, expected.success, expected.code);
    assert.deepEqual(state.lastOutcome, {
      status: expected.status,
      code: expected.code,
      at: "2026-07-30T00:00:00.000Z",
    }, expected.code);
  }
  for (const event of [
    { code: "retry_scheduled", pause: true, preparedSet: null },
    { code: "accepted", pause: true, preparedSet: preparedSet({ preparedSetId: NEXT_SET_ID, coveredAt: NEXT_COVERAGE }) },
    { code: "upload_failed", pause: "false", preparedSet: null },
    { code: "retry_scheduled", pause: false, preparedSet: preparedSet() },
  ]) {
    assert.throws(() => completeAutomaticContributionRun(preparedAutomaticState(), {
      destinationOrigin: ORIGIN,
      completedAt: ATTEMPTED_AT,
      event,
    }), fixedError("configuration_invalid"));
  }
});

test("write-ahead protections deduplicate a partial first-review set", () => {
  const partial = recordReviewedManualAcceptance(createInitialAutomaticContributionState(), {
    destinationOrigin: ORIGIN,
    status: "completed",
    accepted: 1,
    preparedSet: preparedSet({ acceptedJobs: 1, pendingJobs: 1 }),
    acceptedAt: REVIEWED_AT,
  });
  const enabled = enableAutomaticContribution(partial, {
    destinationOrigin: ORIGIN,
    intervalHours: 6,
    consent: automaticContributionRequiredConsent({ destinationOrigin: ORIGIN }),
    consentedAt: REVIEWED_AT,
  });
  const claim = claimAutomaticContributionRun(enabled, {
    destinationOrigin: ORIGIN,
    attemptedAt: ATTEMPTED_AT,
    preparationId: PREPARATION_ID,
  });
  assert.deepEqual(claim.claim.protectedPreparedSetIds, [FIRST_SET_ID]);
});

test("hostile operation inputs fail closed without mutating caller data", () => {
  const required = automaticContributionRequiredConsent({ destinationOrigin: ORIGIN });
  const accessorConsent = Object.defineProperty({ ...required }, "destinationOrigin", {
    get: () => ORIGIN,
  });
  const { proxy: revokedConsent, revoke: revokeConsent } = Proxy.revocable({ ...required }, {});
  revokeConsent();
  for (const consent of [accessorConsent, new Proxy({ ...required }, {}), revokedConsent]) {
    assert.throws(() => enableAutomaticContribution(reviewedState(), {
      destinationOrigin: ORIGIN,
      intervalHours: 6,
      consent,
      consentedAt: REVIEWED_AT,
    }), fixedError("consent_binding_mismatch"));
  }
  const hostilePreparedSet = Object.defineProperty(preparedSet(), "preparedSetId", {
    get: () => FIRST_SET_ID,
  });
  const { proxy: revokedPreparedSet, revoke: revokePreparedSet } = Proxy.revocable(preparedSet(), {});
  revokePreparedSet();
  for (const input of [hostilePreparedSet, new Proxy(preparedSet(), {}), revokedPreparedSet]) {
    assert.throws(() => recordReviewedManualAcceptance(createInitialAutomaticContributionState(), {
      destinationOrigin: ORIGIN,
      status: "completed",
      accepted: 1,
      preparedSet: input,
      acceptedAt: REVIEWED_AT,
    }), fixedError("review_acceptance_invalid"));
  }
  const claimed = claimAutomaticContributionRun(enabledState(), {
    destinationOrigin: ORIGIN,
    attemptedAt: ATTEMPTED_AT,
    preparationId: PREPARATION_ID,
  });
  const coverage = { ...NEXT_COVERAGE };
  const coverageBefore = structuredClone(coverage);
  const accessorCoverage = Object.defineProperty({ ...coverage }, "startAt", {
    get: () => NEXT_COVERAGE.startAt,
  });
  const { proxy: revokedCoverage, revoke: revokeCoverage } = Proxy.revocable({ ...coverage }, {});
  revokeCoverage();
  for (const input of [accessorCoverage, new Proxy({ ...coverage }, {}), revokedCoverage]) {
    assert.throws(() => recordPreparedAutomaticContribution(claimed.state, {
      destinationOrigin: ORIGIN,
      preparedAt: ATTEMPTED_AT,
      preparationId: PREPARATION_ID,
      preparedSetId: NEXT_SET_ID,
      coveredAt: input,
    }), fixedError("configuration_invalid"));
  }
  assert.deepEqual(coverage, coverageBefore);
  const event = { code: "retry_scheduled", pause: false, preparedSet: null };
  const eventBefore = structuredClone(event);
  const { proxy: revokedEvent, revoke: revokeEvent } = Proxy.revocable(event, {});
  revokeEvent();
  const accessorEvent = Object.defineProperty({ ...event }, "code", {
    get: () => "retry_scheduled",
  });
  for (const input of [accessorEvent, new Proxy({ ...event }, {}), revokedEvent]) {
    assert.throws(() => completeAutomaticContributionRun(preparedAutomaticState(), {
      destinationOrigin: ORIGIN,
      completedAt: ATTEMPTED_AT,
      event: input,
    }), fixedError("configuration_invalid"));
  }
  assert.deepEqual(event, eventBefore);
});

test("claim enforces the exact v4 preparation UUID", () => {
  for (const preparationId of [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-5000-8000-000000000001",
    "00000000-0000-4000-7000-000000000001",
    "00000000-0000-4000-8000-00000000001",
  ]) {
    const valid = preparationId === PREPARATION_ID;
    if (valid) {
      assert.equal(claimAutomaticContributionRun(enabledState(), {
        destinationOrigin: ORIGIN,
        attemptedAt: ATTEMPTED_AT,
        preparationId,
      }).claim.preparationClaim.preparationId, preparationId);
    } else {
      assert.throws(() => claimAutomaticContributionRun(enabledState(), {
        destinationOrigin: ORIGIN,
        attemptedAt: ATTEMPTED_AT,
        preparationId,
      }), (error) => error?.code === "automatic_contribution_configuration_invalid");
    }
  }
});
