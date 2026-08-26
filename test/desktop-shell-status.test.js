import test from "node:test";
import assert from "node:assert/strict";
import {
  DESKTOP_SHELL_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
  DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
  projectDesktopShellNotificationEvidence,
  projectDesktopShellStatus,
  validateDesktopShellStatus,
} from "../src/desktop-shell-status.js";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");
const QUARANTINE_CODES = [
  "codex_rollout_compression_unsupported",
  "codex_rollout_filename_identity_mismatch",
  "codex_rollout_generation_ambiguous",
  "codex_rollout_lineage_invalid",
  "codex_rollout_content_invalid",
  "codex_rollout_tail_incomplete",
];

function evidence({
  observedAt = "2026-08-22T11:59:00.000Z",
  windows = [{
    lane: "primary",
    usedPercent: 27.5,
    durationMinutes: 300,
    resetAt: "2026-08-22T15:00:00.000Z",
    resetProofKind: "provider_reported_schedule_only",
  }],
} = {}) {
  return {
    schemaVersion: DESKTOP_SHELL_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt,
    continuityKey: "a".repeat(43),
    windows,
  };
}

function refresh({ status = "succeeded", notificationEvidence } = {}) {
  return {
    status,
    result: notificationEvidence === undefined
      ? null
      : { notificationEvidence },
  };
}

function degradedQuarantineRefresh({ notificationEvidence = evidence(), ...overrides } = {}) {
  return {
    status: "degraded",
    errorCode: "refresh_degraded",
    failedStep: "unified_index",
    failureCode: "codex_rollout_generation_ambiguous",
    result: {
      notificationEvidence,
      unifiedIndex: {
        status: "ingested",
        generation: {
          status: "partial",
          blockReason: "codex_rollout_sources_quarantined",
          skippedSourceCount: 2,
          skippedThreadCount: 1,
          reasonCounts: {
            codex_rollout_generation_ambiguous: 1,
          },
          discoveryComplete: true,
          diagnosticsComplete: true,
          usageProvenanceComplete: true,
          sourceOrderComplete: true,
          quotaProvenanceComplete: true,
        },
      },
      accounting: {
        status: "replay_safe",
        sourceMode: "unified",
        coverageStatus: "partial",
        generationMatched: true,
        fallbackCount: 0,
        diagnosticsAvailable: true,
      },
    },
    ...overrides,
  };
}

test("desktop shell status has fixed lifecycle states and content-free output", () => {
  assert.deepEqual(
    projectDesktopShellStatus({
      snapshotStatus: "building",
      refresh: refresh({ status: "idle" }),
      now: NOW,
    }),
    {
      schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
      state: "starting",
      allowance: null,
      notificationEvidence: null,
    },
  );
  assert.equal(
    projectDesktopShellStatus({
      snapshotStatus: "ready",
      refresh: refresh({ status: "running" }),
      now: NOW,
    }).state,
    "analyzing",
  );
  assert.equal(
    projectDesktopShellStatus({
      snapshotStatus: "failed",
      refresh: refresh({ status: "succeeded", notificationEvidence: evidence() }),
      now: NOW,
    }).state,
    "unavailable",
  );
});

test("fresh direct evidence projects the primary five-hour allowance", () => {
  const result = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: refresh({ notificationEvidence: evidence() }),
    now: NOW,
  });
  assert.equal(result.state, "fresh");
  assert.deepEqual(result.allowance, {
    source: "direct",
    window: "five_hour",
    remainingPercent: 72.5,
  });
  assert.deepEqual(result.notificationEvidence, evidence());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.allowance), true);
});

test("the longest direct primary window deterministically maps to seven days", () => {
  const result = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: refresh({
      notificationEvidence: evidence({
        windows: [
          {
            lane: "primary",
            usedPercent: 40,
            durationMinutes: 10_080,
            resetAt: "2026-08-29T12:00:00.000Z",
            resetProofKind: "provider_reported_schedule_only",
          },
          {
            lane: "secondary",
            usedPercent: 90,
            durationMinutes: 300,
            resetAt: "2026-08-22T15:00:00.000Z",
            resetProofKind: "provider_reported_schedule_only",
          },
        ],
      }),
    }),
    now: NOW,
  });
  assert.equal(result.state, "fresh");
  assert.deepEqual(result.allowance, {
    source: "direct",
    window: "seven_day",
    remainingPercent: 60,
  });
});

test("fresh evidence without a primary lane remains fresh but has no allowance", () => {
  const result = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: refresh({
      notificationEvidence: evidence({
        windows: [{
          lane: "secondary",
          usedPercent: 40,
          durationMinutes: 10_080,
          resetAt: "2026-08-29T12:00:00.000Z",
          resetProofKind: "provider_reported_schedule_only",
        }],
      }),
    }),
    now: NOW,
  });
  assert.equal(result.state, "fresh");
  assert.equal(result.allowance, null);
});

test("a coherent quarantined generation preserves fresh direct allowance evidence", () => {
  const result = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: degradedQuarantineRefresh(),
    now: NOW,
  });
  assert.equal(result.state, "fresh");
  assert.deepEqual(result.allowance, {
    source: "direct",
    window: "five_hour",
    remainingPercent: 72.5,
  });
  assert.deepEqual(result.notificationEvidence, evidence());
});

test("every public quarantine reason is accepted only with matching positive evidence", () => {
  for (const failureCode of QUARANTINE_CODES) {
    const candidate = degradedQuarantineRefresh({ failureCode });
    candidate.result.unifiedIndex.generation.reasonCounts = { [failureCode]: 1 };
    assert.equal(projectDesktopShellStatus({
      snapshotStatus: "ready",
      refresh: candidate,
      now: NOW,
    }).state, "fresh", failureCode);
  }
});

test("degraded shell projection fails closed for incoherent or nonfresh evidence", () => {
  const invalid = [
    { errorCode: "refresh_failed" },
    { failureCode: "private_failure" },
    { failureCode: "codex_rollout_content_invalid" },
    { result: {
      ...degradedQuarantineRefresh().result,
      unifiedIndex: {
        ...degradedQuarantineRefresh().result.unifiedIndex,
        generation: {
          ...degradedQuarantineRefresh().result.unifiedIndex.generation,
          skippedThreadCount: 0,
        },
      },
    } },
    { result: {
      ...degradedQuarantineRefresh().result,
      accounting: {
        ...degradedQuarantineRefresh().result.accounting,
        generationMatched: false,
      },
    } },
    { notificationEvidence: evidence({ observedAt: "2026-08-22T11:54:59.999Z" }) },
  ];
  for (const overrides of invalid) {
    const result = projectDesktopShellStatus({
      snapshotStatus: "ready",
      refresh: degradedQuarantineRefresh(overrides),
      now: NOW,
    });
    assert.notEqual(result.state, "fresh");
    assert.equal(result.allowance, null);
    assert.equal(result.notificationEvidence, null);
  }
});

test("stale, inferred, mixed, malformed, and failed evidence never reaches the shell", () => {
  const cases = [
    evidence({ observedAt: "2026-08-22T11:54:59.999Z" }),
    { ...evidence(), freshness: "stale" },
    { ...evidence(), status: "inferred" },
    { ...evidence(), source: "mixed" },
    { ...evidence(), continuityKey: "private-account-identity" },
    { ...evidence(), windows: [{ ...evidence().windows[0], usedPercent: 101 }] },
  ];
  for (const value of cases) {
    const result = projectDesktopShellStatus({
      snapshotStatus: "ready",
      refresh: refresh({ notificationEvidence: value }),
      now: NOW,
    });
    assert.equal(result.state, "stale");
    assert.equal(result.allowance, null);
    assert.equal(result.notificationEvidence, null);
  }
  assert.equal(
    projectDesktopShellStatus({
      snapshotStatus: "ready",
      refresh: refresh({ status: "failed", notificationEvidence: evidence() }),
      now: NOW,
    }).state,
    "unavailable",
  );
});

test("polling the same receipt is deterministic and does not expose refresh metadata", () => {
  const input = {
    snapshotStatus: "ready",
    refresh: {
      status: "succeeded",
      refreshId: "private-refresh-id",
      errorCode: "private-error",
      result: { notificationEvidence: evidence() },
    },
    now: NOW,
  };
  const first = projectDesktopShellStatus(input);
  const second = projectDesktopShellStatus(input);
  assert.deepEqual(first, second);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("private-refresh-id"), false);
  assert.equal(serialized.includes("private-error"), false);
  assert.equal(serialized.includes("private-account"), false);
});

test("closed evidence and status validators reject extra fields", () => {
  assert.equal(projectDesktopShellNotificationEvidence({ ...evidence(), path: "/private" }, { now: NOW }), null);
  assert.throws(
    () => validateDesktopShellStatus({
      schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
      state: "fresh",
      allowance: null,
      notificationEvidence: null,
      rawError: "secret",
    }),
    /desktop shell status is invalid/u,
  );
});
