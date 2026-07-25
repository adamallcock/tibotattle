import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  assertValidProviderAccountingSnapshot,
  MAXIMUM_PROVIDER_ACCOUNTING_DIAGNOSTICS,
  MAXIMUM_PROVIDER_ACCOUNTING_MEASUREMENTS,
  MAXIMUM_PROVIDER_ACCOUNTING_PERIODS,
  PROVIDER_ACCOUNTING_EXTRACTION_VERSION,
  PROVIDER_ACCOUNTING_PAYLOAD_VERSIONS,
  PROVIDER_ACCOUNTING_SNAPSHOT_SCHEMA_SHA256,
  PROVIDER_ACCOUNTING_SNAPSHOT_VERSION,
  providerAccountingSnapshotSchema,
  validateProviderAccountingSnapshot,
  validateProviderAccountingSnapshotSequence,
} from "../src/provider-accounting-snapshot.js";

const ACCOUNT_A = `account:v1:${"a".repeat(64)}`;
const ACCOUNT_B = `account:v1:${"b".repeat(64)}`;
const WINDOW_A = `provider-window:v1:${"c".repeat(64)}`;

function measurement(metric, unit, value, {
  availability = value === null ? "not_exposed" : "provider_reported",
  precision = value === null ? "unknown" : "provider_rounded_decimal_1",
} = {}) {
  return { metric, unit, value, availability, precision };
}

function codexSnapshot({
  accountScopeId = ACCOUNT_A,
  accountStatus = "attributed",
  accountReason = "stable_observation",
  diagnostics = [],
} = {}) {
  return {
    schemaVersion: PROVIDER_ACCOUNTING_SNAPSHOT_VERSION,
    artifactScope: "local_only",
    transportReady: false,
    provider: "openai_codex",
    observedAt: "2026-07-25T12:00:00.000Z",
    capturedAt: "2026-07-25T12:00:00.250Z",
    captureStatus: "accepted",
    account: { status: accountStatus, accountScopeId, reason: accountReason },
    plan: { availability: "provider_reported", type: "pro", variant: "pro_20x" },
    authority: {
      valueAuthority: "provider_issued",
      source: "provider_account_endpoint",
      sourceSurface: "codex_app_server",
      providerPayloadVersion: PROVIDER_ACCOUNTING_PAYLOAD_VERSIONS.openai_codex,
      extractionVersion: PROVIDER_ACCOUNTING_EXTRACTION_VERSION,
      contentRetained: false,
      rawPayloadRetained: false,
    },
    periods: [{
      windowKind: "five_hour",
      limitId: "codex",
      providerWindowRef: WINDOW_A,
      durationMinutes: 300,
      startedAt: "2026-07-25T10:00:00.000Z",
      endsAt: "2026-07-25T15:00:00.000Z",
      resetsAt: "2026-07-25T15:00:00.000Z",
      measurements: [
        measurement("usage_percent", "percent", 21.4),
        measurement("remaining_percent", "percent", 78.6),
      ],
    }],
    diagnostics,
  };
}

function claudeSnapshot() {
  return {
    schemaVersion: PROVIDER_ACCOUNTING_SNAPSHOT_VERSION,
    artifactScope: "local_only",
    transportReady: false,
    provider: "anthropic_claude_code",
    observedAt: "2026-07-25T12:01:00.000Z",
    capturedAt: "2026-07-25T12:01:00.100Z",
    captureStatus: "accepted_partial",
    account: { status: "attributed", accountScopeId: ACCOUNT_B, reason: "stable_observation" },
    plan: { availability: "not_exposed", type: "unknown", variant: "unknown" },
    authority: {
      valueAuthority: "provider_issued",
      source: "provider_status_line",
      sourceSurface: "claude_status_line",
      providerPayloadVersion: PROVIDER_ACCOUNTING_PAYLOAD_VERSIONS.anthropic_claude_code,
      extractionVersion: PROVIDER_ACCOUNTING_EXTRACTION_VERSION,
      contentRetained: false,
      rawPayloadRetained: false,
    },
    periods: [{
      windowKind: "seven_day",
      limitId: "claude_general",
      providerWindowRef: null,
      durationMinutes: 10080,
      startedAt: null,
      endsAt: null,
      resetsAt: "2026-07-30T00:00:00.000Z",
      measurements: [
        measurement("usage_percent", "percent", 34, { precision: "provider_rounded_integer" }),
        measurement("remaining_percent", "percent", null),
      ],
    }],
    diagnostics: [
      "partial_provider_snapshot",
      "provider_value_unavailable",
      "provider_window_identifier_unavailable",
    ],
  };
}

test("local-only accounting schema is closed, bounded, and digest-bound", async () => {
  const bytes = await readFile(new URL(
    "../schemas/provider-accounting-snapshot-v0.1.schema.json",
    import.meta.url,
  ));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), PROVIDER_ACCOUNTING_SNAPSHOT_SCHEMA_SHA256);
  assert.equal(providerAccountingSnapshotSchema.additionalProperties, false);
  assert.equal(providerAccountingSnapshotSchema.properties.artifactScope.const, "local_only");
  assert.equal(providerAccountingSnapshotSchema.properties.transportReady.const, false);
  assert.equal(providerAccountingSnapshotSchema.properties.periods.maxItems, MAXIMUM_PROVIDER_ACCOUNTING_PERIODS);
  assert.equal(
    providerAccountingSnapshotSchema.properties.periods.items.properties.measurements.maxItems,
    MAXIMUM_PROVIDER_ACCOUNTING_MEASUREMENTS,
  );
  assert.equal(providerAccountingSnapshotSchema.properties.diagnostics.maxItems, MAXIMUM_PROVIDER_ACCOUNTING_DIAGNOSTICS);
});

test("synthetic Codex and Claude provider-authoritative snapshots validate", () => {
  for (const snapshot of [codexSnapshot(), claudeSnapshot()]) {
    assert.deepEqual(validateProviderAccountingSnapshot(snapshot), { valid: true, errors: [] });
    assert.equal(assertValidProviderAccountingSnapshot(snapshot), snapshot);
    assert.equal(JSON.stringify(snapshot).includes("prompt"), false);
    assert.equal(JSON.stringify(snapshot).includes("response"), false);
  }
});

test("unknown fields, raw subjects, arbitrary diagnostics, and schema drift fail closed without echoing values", () => {
  const canary = "private.owner@example.test asked about a secret project";
  const cases = [
    (value) => { value.rawAccount = canary; },
    (value) => { value.account.email = canary; },
    (value) => { value.periods[0].measurements[0].rawLabel = canary; },
    (value) => { value.diagnostics.push(canary); },
    (value) => { value.schemaVersion = "provider-accounting-snapshot-v0.2"; },
    (value) => { value.transportReady = true; },
  ];
  for (const mutate of cases) {
    const snapshot = codexSnapshot();
    mutate(snapshot);
    const result = validateProviderAccountingSnapshot(snapshot);
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result.errors).includes(canary), false);
    assert.equal(JSON.stringify(result.errors).includes("secret project"), false);
  }
});

test("rapid account switches preserve an explicit unattributed gap instead of guessing ownership", () => {
  const before = codexSnapshot({ accountScopeId: ACCOUNT_A });
  const gap = codexSnapshot({
    accountScopeId: "unattributed",
    accountStatus: "unattributed",
    accountReason: "account_switch_boundary",
    diagnostics: ["account_switch_boundary", "unattributed_gap"],
  });
  const after = codexSnapshot({ accountScopeId: ACCOUNT_B });

  assert.equal(validateProviderAccountingSnapshot(before).valid, true);
  assert.equal(validateProviderAccountingSnapshot(gap).valid, true);
  assert.equal(validateProviderAccountingSnapshot(after).valid, true);
  assert.notEqual(before.account.accountScopeId, after.account.accountScopeId);
  assert.equal(gap.account.accountScopeId, "unattributed");

  const guessed = structuredClone(gap);
  guessed.account.accountScopeId = ACCOUNT_A;
  assert.ok(validateProviderAccountingSnapshot(guessed).errors.some(
    (error) => error.schemaPath === "#/x-invariant/unattributed-account-boundary",
  ));

  before.observedAt = "2026-07-25T12:00:00.000Z";
  gap.observedAt = "2026-07-25T12:00:01.000Z";
  gap.capturedAt = "2026-07-25T12:00:01.250Z";
  after.observedAt = "2026-07-25T12:00:02.000Z";
  after.capturedAt = "2026-07-25T12:00:02.250Z";
  assert.deepEqual(
    validateProviderAccountingSnapshotSequence([before, gap, after]),
    { valid: true, errors: [] },
  );

  const directSwitch = validateProviderAccountingSnapshotSequence([before, after]);
  assert.equal(directSwitch.valid, false);
  assert.ok(directSwitch.errors.some(
    (error) => error.schemaPath === "#/x-invariant/account-switch-missing-unattributed-gap",
  ));
});

test("snapshot sequences reject reordering and cross-account attribution after a non-switch gap", () => {
  const before = codexSnapshot({ accountScopeId: ACCOUNT_A });
  const missing = codexSnapshot({
    accountScopeId: "unattributed",
    accountStatus: "unattributed",
    accountReason: "missing_account_observation",
    diagnostics: ["unattributed_gap"],
  });
  const sameAccountAfter = codexSnapshot({ accountScopeId: ACCOUNT_A });
  const otherAccountAfter = codexSnapshot({ accountScopeId: ACCOUNT_B });
  before.observedAt = "2026-07-25T12:00:00.000Z";
  missing.observedAt = "2026-07-25T12:00:01.000Z";
  missing.capturedAt = "2026-07-25T12:00:01.250Z";
  sameAccountAfter.observedAt = "2026-07-25T12:00:02.000Z";
  sameAccountAfter.capturedAt = "2026-07-25T12:00:02.250Z";
  otherAccountAfter.observedAt = sameAccountAfter.observedAt;
  otherAccountAfter.capturedAt = sameAccountAfter.capturedAt;

  assert.deepEqual(
    validateProviderAccountingSnapshotSequence([before, missing, sameAccountAfter]),
    { valid: true, errors: [] },
  );

  const nonSwitch = validateProviderAccountingSnapshotSequence([before, missing, otherAccountAfter]);
  assert.equal(nonSwitch.valid, false);
  assert.ok(nonSwitch.errors.some(
    (error) => error.schemaPath === "#/x-invariant/account-switch-missing-unattributed-gap",
  ));

  const reordered = validateProviderAccountingSnapshotSequence([sameAccountAfter, before]);
  assert.equal(reordered.valid, false);
  assert.ok(reordered.errors.some(
    (error) => error.schemaPath === "#/x-invariant/snapshot-sequence-order",
  ));
});

test("unsupported provider versions yield a content-free rejected diagnostic with no accounting claims", () => {
  const snapshot = codexSnapshot();
  snapshot.captureStatus = "rejected_unsupported_provider_version";
  snapshot.authority.providerPayloadVersion = "unsupported";
  snapshot.plan = { availability: "unavailable", type: "unknown", variant: "unknown" };
  snapshot.periods = [];
  snapshot.diagnostics = ["unsupported_provider_version", "no_provider_authoritative_values"];
  assert.equal(validateProviderAccountingSnapshot(snapshot).valid, true);

  const leakedVersion = structuredClone(snapshot);
  leakedVersion.authority.providerPayloadVersion = "provider-build-private-canary";
  const result = validateProviderAccountingSnapshot(leakedVersion);
  assert.equal(result.valid, false);
  assert.equal(JSON.stringify(result.errors).includes("provider-build-private-canary"), false);

  const claimedValues = structuredClone(snapshot);
  claimedValues.periods = codexSnapshot().periods;
  assert.ok(validateProviderAccountingSnapshot(claimedValues).errors.some(
    (error) => error.schemaPath === "#/x-invariant/rejected-snapshot-has-no-values",
  ));

  const schemaDrift = codexSnapshot();
  schemaDrift.captureStatus = "rejected_provider_schema_drift";
  schemaDrift.plan = { availability: "unavailable", type: "unknown", variant: "unknown" };
  schemaDrift.periods = [];
  schemaDrift.diagnostics = ["provider_schema_drift", "no_provider_authoritative_values"];
  assert.equal(validateProviderAccountingSnapshot(schemaDrift).valid, true);
});

test("provider/version and provider/source pairs cannot cross, and unavailable values cannot masquerade as reported", () => {
  const crossed = claudeSnapshot();
  crossed.authority.providerPayloadVersion = PROVIDER_ACCOUNTING_PAYLOAD_VERSIONS.openai_codex;
  crossed.authority.sourceSurface = "codex_app_server";
  const crossedResult = validateProviderAccountingSnapshot(crossed);
  assert.ok(crossedResult.errors.some(
    (error) => error.schemaPath === "#/x-invariant/provider-source-surface",
  ));
  assert.ok(crossedResult.errors.some(
    (error) => error.schemaPath === "#/x-invariant/supported-provider-version",
  ));

  const guessed = claudeSnapshot();
  guessed.periods[0].measurements[1].value = 66;
  assert.ok(validateProviderAccountingSnapshot(guessed).errors.some(
    (error) => error.schemaPath === "#/x-invariant/reported-value-availability",
  ));

  const wrongUnit = codexSnapshot();
  wrongUnit.periods[0].measurements[0].unit = "tokens";
  assert.ok(validateProviderAccountingSnapshot(wrongUnit).errors.some(
    (error) => error.schemaPath === "#/x-invariant/metric-unit",
  ));
});

test("periods, measurements, and diagnostics are strictly bounded", () => {
  const tooManyPeriods = codexSnapshot();
  tooManyPeriods.periods = Array.from(
    { length: MAXIMUM_PROVIDER_ACCOUNTING_PERIODS + 1 },
    () => structuredClone(codexSnapshot().periods[0]),
  );
  assert.equal(validateProviderAccountingSnapshot(tooManyPeriods).valid, false);

  const tooManyMeasurements = codexSnapshot();
  tooManyMeasurements.periods[0].measurements = Array.from(
    { length: MAXIMUM_PROVIDER_ACCOUNTING_MEASUREMENTS + 1 },
    () => measurement("usage_percent", "percent", 1),
  );
  assert.equal(validateProviderAccountingSnapshot(tooManyMeasurements).valid, false);

  const tooManyDiagnostics = codexSnapshot();
  tooManyDiagnostics.diagnostics = Array(MAXIMUM_PROVIDER_ACCOUNTING_DIAGNOSTICS + 1)
    .fill("provider_value_unavailable");
  assert.equal(validateProviderAccountingSnapshot(tooManyDiagnostics).valid, false);

  const invalidCalendarTime = codexSnapshot();
  invalidCalendarTime.observedAt = "2026-99-99T12:00:00.000Z";
  assert.ok(validateProviderAccountingSnapshot(invalidCalendarTime).errors.some(
    (error) => error.schemaPath === "#/x-invariant/valid-utc-timestamp",
  ));
});
