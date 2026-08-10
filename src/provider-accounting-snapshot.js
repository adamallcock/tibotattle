import Ajv from "ajv";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { safeValidationErrors } from "./safe-validation-errors.js";

export const PROVIDER_ACCOUNTING_SNAPSHOT_VERSION = "provider-accounting-snapshot-v0.1";
export const PROVIDER_ACCOUNTING_EXTRACTION_VERSION = "provider-accounting-extractor-v0.1";
export const MAXIMUM_PROVIDER_ACCOUNTING_PERIODS = 8;
export const MAXIMUM_PROVIDER_ACCOUNTING_MEASUREMENTS = 12;
export const MAXIMUM_PROVIDER_ACCOUNTING_DIAGNOSTICS = 16;

export const PROVIDER_ACCOUNTING_PAYLOAD_VERSIONS = Object.freeze({
  openai_codex: "openai_provider_accounting_v1",
  anthropic_claude_code: "anthropic_provider_accounting_v1",
});

const schemaUrl = new URL(
  "../schemas/provider-accounting-snapshot-v0.1.schema.json",
  import.meta.url,
);
const schemaBytes = readFileSync(schemaUrl);
export const PROVIDER_ACCOUNTING_SNAPSHOT_SCHEMA_SHA256 = createHash("sha256")
  .update(schemaBytes)
  .digest("hex");

const require = createRequire(import.meta.url);
export const providerAccountingSnapshotSchema = require(
  "../schemas/provider-accounting-snapshot-v0.1.schema.json",
);

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile(providerAccountingSnapshotSchema);

const SOURCE_SURFACES = Object.freeze({
  openai_codex: new Set(["codex_app_server", "codex_rollout", "codex_usage_page"]),
  anthropic_claude_code: new Set(["claude_status_line", "claude_api", "claude_usage_page"]),
});

const METRIC_UNITS = Object.freeze({
  usage_percent: "percent",
  remaining_percent: "percent",
  tokens_used: "tokens",
  tokens_remaining: "tokens",
  requests_used: "requests",
  requests_remaining: "requests",
  credits_used: "credits",
  credits_remaining: "credits",
  spend_usd: "usd",
  connected_voice_minutes_used: "minutes",
});

function invariant(path, name) {
  return { path, keyword: "invariant", schemaPath: `#/x-invariant/${name}` };
}

function hasAuthoritativeValue(snapshot) {
  return snapshot.periods.some((period) => period.measurements.some(
    (measurement) => measurement.availability === "provider_reported"
      && typeof measurement.value === "number",
  ));
}

function isValidUtcTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function timestampOrderErrors(period, path) {
  const errors = [];
  for (const field of ["startedAt", "endsAt", "resetsAt"]) {
    if (period[field] !== null && !isValidUtcTimestamp(period[field])) {
      errors.push(invariant(`${path}/${field}`, "valid-utc-timestamp"));
    }
  }
  const ordered = [period.startedAt, period.endsAt].filter(Boolean);
  if (ordered.length === 2 && Date.parse(ordered[0]) > Date.parse(ordered[1])) {
    errors.push(invariant(path, "ordered-period-boundaries"));
  }
  if (period.startedAt && period.resetsAt
      && Date.parse(period.startedAt) > Date.parse(period.resetsAt)) {
    errors.push(invariant(path, "reset-after-period-start"));
  }
  return errors;
}

function semanticErrors(snapshot) {
  const errors = [];
  const expectedPayloadVersion = PROVIDER_ACCOUNTING_PAYLOAD_VERSIONS[snapshot.provider];
  const rejectedVersion = snapshot.captureStatus === "rejected_unsupported_provider_version";
  const rejectedDrift = snapshot.captureStatus === "rejected_provider_schema_drift";
  const rejected = rejectedVersion || rejectedDrift;

  if (!isValidUtcTimestamp(snapshot.observedAt)) {
    errors.push(invariant("/observedAt", "valid-utc-timestamp"));
  }
  if (!isValidUtcTimestamp(snapshot.capturedAt)) {
    errors.push(invariant("/capturedAt", "valid-utc-timestamp"));
  }
  if (isValidUtcTimestamp(snapshot.observedAt) && isValidUtcTimestamp(snapshot.capturedAt)
      && Date.parse(snapshot.observedAt) > Date.parse(snapshot.capturedAt)) {
    errors.push(invariant("/capturedAt", "capture-not-before-observation"));
  }

  if (!SOURCE_SURFACES[snapshot.provider]?.has(snapshot.authority.sourceSurface)) {
    errors.push(invariant("/authority/sourceSurface", "provider-source-surface"));
  }

  if (rejectedVersion) {
    if (snapshot.authority.providerPayloadVersion !== "unsupported") {
      errors.push(invariant(
        "/authority/providerPayloadVersion",
        "unsupported-version-is-not-retained",
      ));
    }
    if (!snapshot.diagnostics.includes("unsupported_provider_version")) {
      errors.push(invariant("/diagnostics", "unsupported-version-diagnostic"));
    }
  } else if (snapshot.authority.providerPayloadVersion !== expectedPayloadVersion) {
    errors.push(invariant("/authority/providerPayloadVersion", "supported-provider-version"));
  }

  if (rejectedDrift && !snapshot.diagnostics.includes("provider_schema_drift")) {
    errors.push(invariant("/diagnostics", "provider-schema-drift-diagnostic"));
  }
  if (rejected && snapshot.periods.length !== 0) {
    errors.push(invariant("/periods", "rejected-snapshot-has-no-values"));
  }
  if (rejected && snapshot.plan.availability === "provider_reported") {
    errors.push(invariant("/plan", "rejected-snapshot-has-no-plan-claim"));
  }

  if (snapshot.account.status === "attributed") {
    if (snapshot.account.accountScopeId === "unattributed"
        || snapshot.account.reason !== "stable_observation") {
      errors.push(invariant("/account", "attributed-account-boundary"));
    }
  } else {
    if (snapshot.account.accountScopeId !== "unattributed"
        || snapshot.account.reason === "stable_observation") {
      errors.push(invariant("/account", "unattributed-account-boundary"));
    }
    if (!snapshot.diagnostics.includes("unattributed_gap")) {
      errors.push(invariant("/diagnostics", "unattributed-gap-diagnostic"));
    }
    if (snapshot.account.reason === "account_switch_boundary"
        && !snapshot.diagnostics.includes("account_switch_boundary")) {
      errors.push(invariant("/diagnostics", "account-switch-diagnostic"));
    }
  }

  if (snapshot.plan.availability === "provider_reported") {
    if (snapshot.plan.type === "unknown") {
      errors.push(invariant("/plan/type", "reported-plan-type"));
    }
  } else if (snapshot.plan.type !== "unknown" || snapshot.plan.variant !== "unknown") {
    errors.push(invariant("/plan", "unavailable-plan-is-unknown"));
  }

  for (const [periodIndex, period] of snapshot.periods.entries()) {
    const periodPath = `/periods/${periodIndex}`;
    errors.push(...timestampOrderErrors(period, periodPath));
    const seenMetrics = new Set();
    for (const [measurementIndex, measurement] of period.measurements.entries()) {
      const path = `${periodPath}/measurements/${measurementIndex}`;
      if (seenMetrics.has(measurement.metric)) {
        errors.push(invariant(`${periodPath}/measurements`, "unique-period-metrics"));
      }
      seenMetrics.add(measurement.metric);
      if (measurement.unit !== METRIC_UNITS[measurement.metric]) {
        errors.push(invariant(`${path}/unit`, "metric-unit"));
      }
      const reported = measurement.availability === "provider_reported";
      if (reported !== (typeof measurement.value === "number")) {
        errors.push(invariant(path, "reported-value-availability"));
      }
      if (measurement.value !== null && measurement.unit === "percent"
          && measurement.value > 100) {
        errors.push(invariant(`${path}/value`, "percent-range"));
      }
      if (!reported && measurement.precision !== "unknown") {
        errors.push(invariant(`${path}/precision`, "unavailable-value-precision"));
      }
    }
  }

  const authoritative = hasAuthoritativeValue(snapshot);
  if (!rejected && !authoritative) {
    errors.push(invariant("/periods", "accepted-provider-authoritative-value"));
  }
  if (snapshot.diagnostics.includes("no_provider_authoritative_values") !== !authoritative) {
    errors.push(invariant("/diagnostics", "authoritative-value-diagnostic"));
  }
  if (snapshot.captureStatus === "accepted_partial"
      && !snapshot.diagnostics.includes("partial_provider_snapshot")) {
    errors.push(invariant("/diagnostics", "partial-snapshot-diagnostic"));
  }
  if (snapshot.captureStatus === "accepted"
      && snapshot.diagnostics.includes("partial_provider_snapshot")) {
    errors.push(invariant("/diagnostics", "complete-snapshot-diagnostic"));
  }

  return errors.slice(0, 20);
}

export function validateProviderAccountingSnapshot(value) {
  if (!validateSchema(value)) {
    return { valid: false, errors: safeValidationErrors(validateSchema.errors) };
  }
  const errors = semanticErrors(value);
  return { valid: errors.length === 0, errors };
}

export function assertValidProviderAccountingSnapshot(value) {
  const result = validateProviderAccountingSnapshot(value);
  if (!result.valid) {
    const summary = result.errors.map((error) => `${error.path}:${error.keyword}`).join(", ");
    throw new Error(`Local provider accounting snapshot failed validation (${summary})`);
  }
  return value;
}

/**
 * Validate an observation sequence without ever inferring account ownership.
 * A change between two attributed pseudonyms must pass through an explicit
 * unattributed account-switch boundary.
 */
export function validateProviderAccountingSnapshotSequence(values) {
  if (!Array.isArray(values)) throw new TypeError("provider accounting snapshot sequence must be an array");
  const errors = [];
  let prior = null;
  let lastAttributedScopeId = null;
  let switchBoundarySinceAttribution = false;
  for (let index = 0; index < values.length; index += 1) {
    const snapshot = values[index];
    const result = validateProviderAccountingSnapshot(snapshot);
    if (!result.valid) {
      errors.push(...result.errors.map((error) => ({
        ...error,
        path: `/snapshots/${index}${error.path === "/" ? "" : error.path}`,
      })));
      prior = null;
      lastAttributedScopeId = null;
      switchBoundarySinceAttribution = false;
      continue;
    }
    if (prior && Date.parse(snapshot.observedAt) < Date.parse(prior.observedAt)) {
      errors.push(invariant(`/snapshots/${index}/observedAt`, "snapshot-sequence-order"));
    }
    if (snapshot.account.status === "unattributed") {
      if (snapshot.account.reason === "account_switch_boundary") {
        switchBoundarySinceAttribution = true;
      }
    } else {
      if (lastAttributedScopeId !== null
          && lastAttributedScopeId !== snapshot.account.accountScopeId
          && !switchBoundarySinceAttribution) {
        errors.push(invariant(`/snapshots/${index}/account`, "account-switch-missing-unattributed-gap"));
      }
      lastAttributedScopeId = snapshot.account.accountScopeId;
      switchBoundarySinceAttribution = false;
    }
    prior = snapshot;
  }
  return { valid: errors.length === 0, errors: errors.slice(0, 20) };
}
