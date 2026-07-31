const HEX = Object.freeze({
  event: "a".repeat(64),
  eventTwo: "b".repeat(64),
  snapshot: "c".repeat(64),
  marker: "d".repeat(64),
  dataset: "e".repeat(64),
  accountTrack: "f".repeat(64),
});

function toolClassCounts() {
  return {
    webSearch: 0,
    fileSearch: 0,
    codeInterpreter: 0,
    hostedShell: 0,
    computerUse: 0,
    mcp: 0,
    applyPatch: 0,
    localShell: 0,
    subagent: 0,
    toolGateway: 0,
    other: 0,
    unknown: 0,
  };
}

function usageEvent({
  eventId = `event:v2:${HEX.event}`,
  eventTime = "2026-07-29T11:10:00.000Z",
} = {}) {
  return {
    schemaVersion: "usage-event-v0.1",
    eventTime,
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    modelRecognition: "recognized",
    modelFingerprint: null,
    billingSurface: "chatgpt_subscription",
    speedMode: "standard",
    apiServiceTier: "unknown",
    reasoningEffort: "unknown",
    components: {
      inputUncachedTokens: 1000,
      inputCacheReadTokens: 9000,
      inputCacheWriteTokens: 0,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
      outputTextTokens: 800,
      outputReasoningTokens: 300,
      outputCombinedTokens: null,
    },
    totalInputContextTokens: 10_000,
    surface: "local_interactive_unclassified",
    agentScope: "root",
    lineageDisposition: "standalone",
    toolClassCounts: toolClassCounts(),
    outcome: "completed",
    eventId,
    accounting: {
      estimatedApiCostUsd: "0.420000",
      pricingCoveragePercent: 100,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  };
}

export function telemetryV01Golden() {
  return {
    schemaVersion: "telemetry-contribution-v0.1",
    synthetic: false,
    createdAt: "2026-07-29T12:00:00.000Z",
    coveredAt: {
      startAt: "2026-07-29T11:00:00.000Z",
      endAt: "2026-07-29T12:00:00.000Z",
    },
    clientPlatform: "macos",
    providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
    usageEvents: [usageEvent()],
    quotaSnapshots: [{
      schemaVersion: "quota-snapshot-v0.1",
      observedTime: "2026-07-29T11:20:00.000Z",
      receivedTime: "2026-07-29T11:20:01.000Z",
      provider: "openai_codex",
      planType: "pro",
      planVariant: "pro-20x",
      limitId: "codex",
      slot: "seven_day",
      usedPercent: 42,
      displayPrecision: 0,
      windowDurationMinutes: 10_080,
      resetsAt: "2026-07-30T18:00:00.000Z",
      snapshotSource: "rollout",
      providerSurface: "account_shared_unallocated",
      snapshotId: `snapshot:v2:${HEX.snapshot}`,
    }],
    activityMarkers: [{
      schemaVersion: "export-activity-marker-v0.1",
      observedTime: "2026-07-29T11:30:00.000Z",
      surface: "controlled_experiment",
      state: "pulse",
      agenticPoolCoupling: "depends_on_experiment_surface",
      planType: "pro",
      planVariant: "pro-20x",
      markerId: `marker:v2:${HEX.marker}`,
    }],
    accounting: {
      estimatedApiCostUsd: "0.420000",
      pricedEventCoveragePercent: 100,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  };
}

export function telemetryV02Golden() {
  const source = telemetryV01Golden();
  return {
    schemaVersion: "telemetry-contribution-v0.2",
    consentVersion: "privacy-safe-telemetry-v0.2",
    status: "implementation_disabled",
    synthetic: false,
    datasetId: `dataset:v1:${HEX.dataset}`,
    partIndex: 1,
    partCount: 1,
    completeness: "complete",
    createdAt: source.createdAt,
    coveredAt: source.coveredAt,
    clientPlatform: source.clientPlatform,
    providerPolicyEpoch: source.providerPolicyEpoch,
    usageEvents: source.usageEvents.map((row) => {
      const {
        accounting,
        ...safe
      } = row;
      return {
        ...safe,
        schemaVersion: "usage-event-v0.2",
        accountTrackId: `account-track:v1:${HEX.accountTrack}`,
        accountingDiagnostic: {
          status: "untrusted_diagnostic",
          sourceSchemaVersion: "telemetry-contribution-v0.1",
          ...accounting,
        },
      };
    }),
    quotaSnapshots: source.quotaSnapshots.map((row) => ({
      ...row,
      schemaVersion: "quota-snapshot-v0.2",
      accountTrackId: `account-track:v1:${HEX.accountTrack}`,
    })),
    activityMarkers: source.activityMarkers.map((row) => ({
      ...row,
      schemaVersion: "activity-marker-v0.2",
      provider: "openai_codex",
      accountTrackId: `account-track:v1:${HEX.accountTrack}`,
    })),
    accountingDiagnostic: {
      status: "untrusted_diagnostic",
      sourceSchemaVersion: "telemetry-contribution-v0.1",
      ...source.accounting,
    },
  };
}

export function telemetryV02LegacyIdGolden() {
  const value = telemetryV02Golden();
  value.usageEvents[0].eventId = `event:v2:${"A".repeat(43)}`;
  value.usageEvents[0].modelId = "unknown";
  value.usageEvents[0].modelRecognition = "unrecognized";
  value.usageEvents[0].modelFingerprint =
    `model:v1:${"B".repeat(43)}`;
  value.quotaSnapshots[0].snapshotId =
    `snapshot:v2:${"C".repeat(43)}`;
  value.activityMarkers[0].markerId =
    `marker:v2:${"D".repeat(43)}`;
  value.accountingDiagnostic.unknownModelEventCount = 1;
  return value;
}

export function telemetryEnvelopeGolden() {
  return {
    schemaVersion: "telemetry-envelope-v0.1",
    synthetic: false,
    keyId: "key:telemetry-contract-test",
    wrappedKey: "A".repeat(342),
    iv: "B".repeat(16),
    ciphertext: "C".repeat(32),
  };
}

function duplicateUsageContribution() {
  const value = telemetryV01Golden();
  value.usageEvents.push(usageEvent({
    eventId: `event:v2:${HEX.event}`,
    eventTime: "2026-07-29T11:11:00.000Z",
  }));
  value.accounting.estimatedApiCostUsd = "0.840000";
  return value;
}

export function telemetryContractAdversarialVectors() {
  const openShape = telemetryV01Golden();
  openShape.unexpected = true;
  const content = telemetryV01Golden();
  content.usageEvents[0].prompt = "private-content-canary";
  const providerMismatch = telemetryV01Golden();
  providerMismatch.usageEvents[0].modelId = "claude-sonnet-5";
  const timeOutside = telemetryV01Golden();
  timeOutside.usageEvents[0].eventTime =
    "2026-07-29T10:59:59.999Z";
  const accountingMismatch = telemetryV01Golden();
  accountingMismatch.accounting.estimatedApiCostUsd = "9.999999";
  const directAccount = telemetryV02Golden();
  directAccount.usageEvents[0].accountTrackId =
    `account:v1:${"1".repeat(64)}`;
  const v02Unknown = telemetryV02Golden();
  v02Unknown.activityMarkers[0].extra = "safe-looking";
  return Object.freeze([
    Object.freeze({
      label: "open_v01_shape",
      value: openShape,
      code: "TELEMETRY_RECORD_INVALID",
      detailCode: "closed_shape_invalid",
    }),
    Object.freeze({
      label: "content_field",
      value: content,
      code: "PRIVACY_CANARY_DETECTED",
      detailCode: "privacy_canary_detected",
    }),
    Object.freeze({
      label: "duplicate_event_id",
      value: duplicateUsageContribution(),
      code: "TELEMETRY_RECORD_INVALID",
      detailCode: "duplicate_record_id",
    }),
    Object.freeze({
      label: "provider_model_mismatch",
      value: providerMismatch,
      code: "TELEMETRY_RECORD_INVALID",
      detailCode: "usage_events_invalid",
    }),
    Object.freeze({
      label: "time_outside_coverage",
      value: timeOutside,
      code: "TELEMETRY_RECORD_INVALID",
      detailCode: "record_time_invalid",
    }),
    Object.freeze({
      label: "accounting_mismatch",
      value: accountingMismatch,
      code: "TELEMETRY_RECORD_INVALID",
      detailCode: "accounting_reconciliation_invalid",
    }),
    Object.freeze({
      label: "direct_account_scope",
      value: directAccount,
      code: "PRIVACY_CANARY_DETECTED",
      detailCode: "private_projection_invalid",
    }),
    Object.freeze({
      label: "open_v02_shape",
      value: v02Unknown,
      code: "TELEMETRY_RECORD_INVALID",
      detailCode: "activity_markers_invalid",
    }),
  ]);
}

export function telemetryEnvelopeAdversarialVectors() {
  const openShape = telemetryEnvelopeGolden();
  openShape.extra = true;
  const synthetic = telemetryEnvelopeGolden();
  synthetic.synthetic = true;
  const badKeyId = telemetryEnvelopeGolden();
  badKeyId.keyId = "private-key";
  const shortWrappedKey = telemetryEnvelopeGolden();
  shortWrappedKey.wrappedKey = "A".repeat(341);
  return Object.freeze([
    Object.freeze({ label: "open_shape", value: openShape }),
    Object.freeze({ label: "synthetic", value: synthetic }),
    Object.freeze({ label: "bad_key_id", value: badKeyId }),
    Object.freeze({
      label: "short_wrapped_key",
      value: shortWrappedKey,
    }),
  ]);
}
