import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_DESKTOP_ACCOUNTING_CONTRACT_VERSION,
  CLAUDE_DESKTOP_DEFAULT_SOURCE_RETENTION_DAYS,
  CLAUDE_DESKTOP_CONFIGURED_SOURCE_RETENTION_DAYS,
  createClaudeDesktopAccountingContract,
  projectClaudeDesktopDisplayOutput,
} from "../src/claude-desktop-accounting-contract.js";

const CAPTURE_START = "2026-08-17T00:00:00.000Z";
const ACCOUNT_SCOPE = `account-scope:v1:${"a".repeat(64)}`;

function baseContract(overrides = {}) {
  return {
    capture: {
      status: "enabled",
      startedAt: CAPTURE_START,
      startBasis: "first_enabled_refresh",
    },
    source: {
      lifecycle: "present",
      cleanupState: "not_observed",
      cleanupEvidence: "none",
      purgeState: "not_purged",
    },
    attribution: {
      status: "attributed",
      accountScope: ACCOUNT_SCOPE,
    },
    retention: {
      sourceHorizonDays: CLAUDE_DESKTOP_DEFAULT_SOURCE_RETENTION_DAYS,
      sourceHorizonBasis: "provider_default",
      ledgerHorizon: "prospective_after_capture_start",
      restoresDeletedHistory: false,
    },
    pricing: {
      status: "fully_priced",
      modelRecognition: "recognized",
      pricedComponents: 4,
      unpricedComponents: 0,
      unavailableComponents: 0,
      reasonCodes: [],
      basis: "api_price_equivalent",
    },
    output: {
      outputKind: "provider_reported_combined",
      outputCombinedTokens: 47,
    },
    gaps: [],
    ...overrides,
  };
}

test("the closed contract records capture start and never backfills pre-capture history", () => {
  const value = baseContract({
    gaps: [{
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: CAPTURE_START,
      reason: "before_capture",
    }],
  });
  const contract = createClaudeDesktopAccountingContract(value);
  assert.equal(contract.schemaVersion, CLAUDE_DESKTOP_ACCOUNTING_CONTRACT_VERSION);
  assert.equal(contract.provider, "anthropic_claude_code");
  assert.equal(contract.localOnly, true);
  assert.deepEqual(contract.capture, {
    status: "enabled",
    startedAt: CAPTURE_START,
    startBasis: "first_enabled_refresh",
    historyBeforeStart: "unavailable",
  });
  assert.equal(contract.gaps[0].availability, "unavailable");

  assert.throws(
    () => createClaudeDesktopAccountingContract(baseContract({
      gaps: [{ startAt: "2026-08-01T00:00:00.000Z", endAt: null, reason: "before_capture" }],
    })),
    (error) => error.code === "claude_desktop_accounting_contract_gap_interval",
  );
  assert.throws(
    () => createClaudeDesktopAccountingContract(baseContract({
      gaps: [{
        startAt: "2026-08-01T00:00:00.000Z",
        endAt: "2026-08-17T00:00:00.001Z",
        reason: "before_capture",
      }],
    })),
    (error) => error.code === "claude_desktop_accounting_contract_capture_gap",
  );
});

test("disabled capture is explicit and app-off gaps are unavailable rather than zero", () => {
  const disabled = createClaudeDesktopAccountingContract(baseContract({
    capture: {
      status: "disabled",
      startedAt: null,
      startBasis: "not_started",
    },
    attribution: { status: "unattributed", accountScope: null },
    gaps: [{
      startAt: "2026-08-17T00:00:00.000Z",
      endAt: null,
      reason: "app_off",
    }],
  }));
  assert.deepEqual(disabled.capture, {
    status: "disabled",
    startedAt: null,
    startBasis: "not_started",
    historyBeforeStart: "unavailable",
  });
  assert.deepEqual(disabled.attribution, { status: "unattributed", accountScope: null });
  assert.deepEqual(disabled.gaps[0], {
    startAt: "2026-08-17T00:00:00.000Z",
    endAt: null,
    reason: "app_off",
    availability: "unavailable",
  });

  assert.throws(
    () => createClaudeDesktopAccountingContract(baseContract({
      capture: { status: "disabled", startedAt: CAPTURE_START, startBasis: "first_enabled_refresh" },
    })),
    (error) => error.code === "claude_desktop_accounting_contract_capture_disabled_state",
  );
});

test("source cleanup and explicit user purge stay separate coverage states", () => {
  const value = baseContract({
    source: {
      lifecycle: "missing_suspected",
      cleanupState: "provider_cleanup",
      cleanupEvidence: "cleanup_marker_advanced",
      purgeState: "user_purged",
    },
    gaps: [
      {
        startAt: "2026-08-20T00:00:00.000Z",
        endAt: null,
        reason: "source_cleanup",
      },
      {
        startAt: "2026-08-21T00:00:00.000Z",
        endAt: "2026-08-21T00:30:00.000Z",
        reason: "user_purge",
      },
    ],
  });
  const contract = createClaudeDesktopAccountingContract(value);
  assert.deepEqual(contract.source, {
    lifecycle: "missing_suspected",
    cleanupState: "provider_cleanup",
    cleanupEvidence: "cleanup_marker_advanced",
    purgeState: "user_purged",
  });
  assert.deepEqual(contract.gaps.map((gap) => [gap.reason, gap.availability]), [
    ["source_cleanup", "unavailable"],
    ["user_purge", "purged"],
  ]);

  assert.throws(
    () => createClaudeDesktopAccountingContract(baseContract({
      source: {
        lifecycle: "missing_suspected",
        cleanupState: "provider_cleanup",
        cleanupEvidence: "cleanup_marker_advanced",
        purgeState: "not_purged",
      },
      gaps: [],
    })),
    (error) => error.code === "claude_desktop_accounting_contract_source_cleanup_gap",
  );
  assert.throws(
    () => createClaudeDesktopAccountingContract(baseContract({
      source: {
        lifecycle: "present",
        cleanupState: "not_observed",
        cleanupEvidence: "none",
        purgeState: "user_purged",
      },
      gaps: [],
    })),
    (error) => error.code === "claude_desktop_accounting_contract_purge_gap",
  );

  assert.throws(
    () => createClaudeDesktopAccountingContract(baseContract({
      source: {
        lifecycle: "missing_suspected",
        cleanupState: "provider_cleanup",
        cleanupEvidence: "none",
        purgeState: "not_purged",
      },
      gaps: [{
        startAt: "2026-08-20T00:00:00.000Z",
        endAt: null,
        reason: "source_cleanup",
      }],
    })),
    (error) => error.code === "claude_desktop_accounting_contract_source_cleanup_evidence",
  );
});

test("attribution accepts only opaque account scope and preserves an unattributed state", () => {
  const attributed = createClaudeDesktopAccountingContract(baseContract());
  assert.equal(attributed.attribution.status, "attributed");
  assert.match(attributed.attribution.accountScope, /^account-scope:v1:[a-f0-9]{64}$/u);

  const unattributed = createClaudeDesktopAccountingContract(baseContract({
    attribution: { status: "unattributed", accountScope: null },
  }));
  assert.deepEqual(unattributed.attribution, { status: "unattributed", accountScope: null });

  for (const attribution of [
    { status: "attributed", accountScope: "organization-secret" },
    { status: "unattributed", accountScope: ACCOUNT_SCOPE },
    { status: "attributed", accountScope: `account-scope:v1:${"A".repeat(64)}` },
  ]) {
    assert.throws(
      () => createClaudeDesktopAccountingContract(baseContract({ attribution })),
      (error) => /claude_desktop_accounting_contract_(attribution_scope|unattributed_scope)/u.test(error.code),
    );
  }
});

test("retention reports the source horizon without claiming to restore deleted history", () => {
  const defaultRetention = createClaudeDesktopAccountingContract(baseContract());
  assert.equal(
    defaultRetention.retention.sourceHorizonDays,
    CLAUDE_DESKTOP_DEFAULT_SOURCE_RETENTION_DAYS,
  );
  assert.equal(defaultRetention.retention.restoresDeletedHistory, false);

  const configured = createClaudeDesktopAccountingContract(baseContract({
    retention: {
      sourceHorizonDays: CLAUDE_DESKTOP_CONFIGURED_SOURCE_RETENTION_DAYS,
      sourceHorizonBasis: "provider_configured",
      ledgerHorizon: "prospective_after_capture_start",
      restoresDeletedHistory: false,
    },
  }));
  assert.equal(configured.retention.sourceHorizonDays, 90);

  const unknown = createClaudeDesktopAccountingContract(baseContract({
    retention: {
      sourceHorizonDays: null,
      sourceHorizonBasis: "unknown",
      ledgerHorizon: "prospective_after_capture_start",
      restoresDeletedHistory: false,
    },
  }));
  assert.equal(unknown.retention.sourceHorizonDays, null);
  assert.throws(
    () => createClaudeDesktopAccountingContract(baseContract({
      retention: {
        sourceHorizonDays: 30,
        sourceHorizonBasis: "provider_default",
        ledgerHorizon: "prospective_after_capture_start",
        restoresDeletedHistory: true,
      },
    })),
    (error) => error.code === "claude_desktop_accounting_contract_retention_policy",
  );
});

test("pricing coverage is explicit and unknown models cannot become priced zeroes", () => {
  const full = createClaudeDesktopAccountingContract(baseContract());
  assert.equal(full.pricing.status, "fully_priced");

  const partial = createClaudeDesktopAccountingContract(baseContract({
    pricing: {
      status: "partially_priced",
      modelRecognition: "recognized",
      pricedComponents: 2,
      unpricedComponents: 1,
      unavailableComponents: 0,
      reasonCodes: ["component_price_missing"],
      basis: "api_price_equivalent",
    },
  }));
  assert.equal(partial.pricing.status, "partially_priced");
  assert.deepEqual(partial.pricing.reasonCodes, ["component_price_missing"]);

  const unknown = createClaudeDesktopAccountingContract(baseContract({
    pricing: {
      status: "unpriced",
      modelRecognition: "unrecognized",
      pricedComponents: 0,
      unpricedComponents: 4,
      unavailableComponents: 0,
      reasonCodes: ["unknown_model"],
      basis: "api_price_equivalent",
    },
  }));
  assert.equal(unknown.pricing.status, "unpriced");
  assert.equal(unknown.pricing.modelRecognition, "unrecognized");
  assert.deepEqual(unknown.pricing.reasonCodes, ["unknown_model"]);
  assert.equal(JSON.stringify(unknown).includes("claude-secret-model"), false);

  const invalidInput = createClaudeDesktopAccountingContract(baseContract({
    pricing: {
      status: "unpriced",
      modelRecognition: "recognized",
      pricedComponents: 0,
      unpricedComponents: 4,
      unavailableComponents: 0,
      reasonCodes: ["pricing_input_invalid"],
      basis: "api_price_equivalent",
    },
  }));
  assert.deepEqual(invalidInput.pricing.reasonCodes, ["pricing_input_invalid"]);

  assert.throws(
    () => createClaudeDesktopAccountingContract(baseContract({
      pricing: {
        status: "fully_priced",
        modelRecognition: "unrecognized",
        pricedComponents: 4,
        unpricedComponents: 0,
        unavailableComponents: 0,
        reasonCodes: [],
        basis: "api_price_equivalent",
      },
    })),
    (error) => error.code === "claude_desktop_accounting_contract_unknown_model",
  );
});

test("combined output projects text=combined and reasoning=0 with explicit provenance", () => {
  const projected = projectClaudeDesktopDisplayOutput({
    outputKind: "provider_reported_combined",
    outputCombinedTokens: 47,
  });
  assert.deepEqual(projected, {
    outputTextTokens: 47,
    outputReasoningTokens: 0,
    outputCombinedTokens: 47,
    outputKind: "provider_reported_combined",
    projectionKind: "display_only_compatibility",
    reasoningProvenance: "not_reported_by_provider",
  });
  assert.equal(
    createClaudeDesktopAccountingContract(baseContract()).output.reasoningProvenance,
    "not_reported_by_provider",
  );

  assert.throws(
    () => projectClaudeDesktopDisplayOutput({
      outputKind: "provider_reported_combined",
      outputCombinedTokens: 47,
      outputReasoningTokens: 0,
    }),
    (error) => error.code === "claude_desktop_accounting_contract_output_shape",
  );
  assert.throws(
    () => projectClaudeDesktopDisplayOutput({
      outputKind: "separate_text_reasoning",
      outputCombinedTokens: 47,
    }),
    (error) => error.code === "claude_desktop_accounting_contract_output_kind",
  );
});

test("all contract boundaries reject arbitrary or private fields", () => {
  const privateInputs = [
    ["top-level", { ...baseContract(), prompt: "private" }],
    ["capture", baseContract({ capture: { ...baseContract().capture, sourcePath: "/tmp/private" } })],
    ["source", baseContract({ source: { ...baseContract().source, sourcePath: "/tmp/private" } })],
    ["attribution", baseContract({ attribution: { ...baseContract().attribution, accountId: "private" } })],
    ["retention", baseContract({ retention: { ...baseContract().retention, metadata: "private" } })],
    ["pricing", baseContract({ pricing: { ...baseContract().pricing, modelLabel: "private" } })],
    ["output", baseContract({ output: { ...baseContract().output, transcript: "private" } })],
    ["gap", baseContract({ gaps: [{
      startAt: CAPTURE_START,
      endAt: null,
      reason: "app_off",
      transcript: "private",
    }] })],
  ];
  for (const [name, value] of privateInputs) {
    assert.throws(
      () => createClaudeDesktopAccountingContract(value),
      (error) => error.code?.startsWith("claude_desktop_accounting_contract_") === true,
      name,
    );
  }
});
