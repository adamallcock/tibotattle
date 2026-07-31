import {
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  ACCOUNT_SCOPED_TELEMETRY_ENVELOPE_SCHEMA_VERSION,
  ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION,
  canonicalTelemetryContributionV01 as canonicalContractV01,
  isTelemetryContractError,
  parseTelemetryContributionV02,
  type AccountTrackId,
  type TelemetryContribution,
  type TelemetryContributionV02,
  type TelemetryUsageEvent,
} from "@app-usagemonitor/telemetry-contract";

import { ApiError } from "./errors";

export const TELEMETRY_V02_ENABLED = false;
export const TELEMETRY_V02_CONTRIBUTION_SCHEMA_VERSION =
  ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION;
export const TELEMETRY_V02_CONSENT_VERSION =
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION;
export const TELEMETRY_V02_ENVELOPE_SCHEMA_VERSION =
  ACCOUNT_SCOPED_TELEMETRY_ENVELOPE_SCHEMA_VERSION;

export type {
  AccountTrackId,
  TelemetryContributionV02,
};

const ACCOUNT_TRACK_PATTERN = /^account-track:v1:[a-f0-9]{64}$/u;
const PARTICIPANT_ID_PATTERN =
  /^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDERS = new Set(["openai_codex", "anthropic_claude_code"]);

function mapContractError(error: unknown): never {
  if (isTelemetryContractError(error)) {
    throw new ApiError(400, error.code);
  }
  throw error;
}

function validAccountTrack(
  value: unknown,
): value is AccountTrackId {
  return value === "unattributed"
    || (typeof value === "string" && ACCOUNT_TRACK_PATTERN.test(value));
}

/**
 * Validate the frozen, disabled v0.2 plaintext contract.
 *
 * Activation remains a separate policy decision. This adapter only preserves
 * the existing Worker error contract while the runtime-neutral package owns
 * the closed schema and canonical conversion.
 */
export function validateTelemetryContributionV02(
  value: unknown,
): TelemetryContributionV02 {
  try {
    return parseTelemetryContributionV02(value);
  } catch (error) {
    return mapContractError(error);
  }
}

export function canonicalTelemetryContributionV01(
  record: TelemetryContributionV02,
): TelemetryContribution {
  try {
    return canonicalContractV01(record);
  } catch (error) {
    return mapContractError(error);
  }
}

export function telemetryAccountTrackPartitionKey(
  participantId: string,
  accountTrack: AccountTrackId,
  provider: TelemetryUsageEvent["provider"],
): string {
  if (
    !PARTICIPANT_ID_PATTERN.test(participantId)
    || !validAccountTrack(accountTrack)
    || !PROVIDERS.has(provider)
  ) {
    throw new TypeError("Invalid telemetry account-track partition");
  }
  return `${participantId.toLowerCase()}\u0000${accountTrack}\u0000${provider}`;
}
