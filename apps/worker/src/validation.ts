import {
  CONTRIBUTION_SCHEMA_VERSION,
  ENVELOPE_SCHEMA_VERSION,
  FIXTURE_ID,
} from "./constants";
import { ApiError } from "./errors";
import { SEVEN_DAY_WINDOW_MINUTES } from "@app-usagemonitor/quota-analysis";

type JsonRecord = Record<string, unknown>;

export interface SyntheticContribution {
  schemaVersion: typeof CONTRIBUTION_SCHEMA_VERSION;
  synthetic: true;
  fixtureId: typeof FIXTURE_ID;
  timeRange: {
    start: string;
    end: string;
  };
  quota: {
    windowMinutes: number;
    usedPercentBefore: number;
    usedPercentAfter: number;
    displayPrecision: number;
  };
  usage: {
    modelId: string;
    subscriptionSpeed: "standard" | "fast";
    apiTierAssumption: "standard" | "priority" | "flex";
    inputUncachedTokens: number;
    inputCachedTokens: number;
    outputTextTokens: number;
    outputReasoningTokens: number;
    providerToolUnits: {
      webSearchCalls: number;
      unknownUnits: number;
    };
  };
  accounting: {
    estimatedApiCostUsd: string;
    pricedEventCoveragePercent: number;
    unknownBillableUnits: number;
    priceBasis: "current-api-price-sensitivity";
  };
}

export interface SyntheticEnvelope {
  schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  synthetic: true;
  keyId: string;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
}

export function syntheticFixture(): SyntheticContribution {
  return {
    schemaVersion: CONTRIBUTION_SCHEMA_VERSION,
    synthetic: true,
    fixtureId: FIXTURE_ID,
    timeRange: {
      start: "2026-07-14T00:00:00.000Z",
      end: "2026-07-21T00:00:00.000Z",
    },
    quota: {
      windowMinutes: SEVEN_DAY_WINDOW_MINUTES,
      usedPercentBefore: 26,
      usedPercentAfter: 31,
      displayPrecision: 0,
    },
    usage: {
      modelId: "gpt-5.6-sol",
      subscriptionSpeed: "standard",
      apiTierAssumption: "standard",
      inputUncachedTokens: 150_000,
      inputCachedTokens: 900_000,
      outputTextTokens: 28_000,
      outputReasoningTokens: 16_000,
      providerToolUnits: {
        webSearchCalls: 2,
        unknownUnits: 1,
      },
    },
    accounting: {
      estimatedApiCostUsd: "12.840000",
      pricedEventCoveragePercent: 100,
      unknownBillableUnits: 1,
      priceBasis: "current-api-price-sensitivity",
    },
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isExactValue(value: unknown, expected: unknown): boolean {
  if (Object.is(value, expected)) return true;
  if (!isRecord(value) || !isRecord(expected)) return false;
  const keys = Object.keys(expected);
  return hasExactKeys(value, keys)
    && keys.every((key) => isExactValue(value[key], expected[key]));
}

function isSafeInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function isBoundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function isBase64Url(value: unknown, minimumCharacters: number, maximumCharacters: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  return value.length >= minimumCharacters && value.length <= maximumCharacters;
}

export function validateEnvelope(value: unknown): SyntheticEnvelope {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "synthetic",
      "keyId",
      "wrappedKey",
      "iv",
      "ciphertext",
    ])) {
    throw new ApiError(400, "ENVELOPE_INVALID");
  }
  if (value.synthetic !== true) throw new ApiError(400, "SYNTHETIC_REQUIRED");
  if (value.schemaVersion !== ENVELOPE_SCHEMA_VERSION
    || typeof value.keyId !== "string"
    || !/^key:[A-Za-z0-9._-]{1,64}$/.test(value.keyId)
    || !isBase64Url(value.wrappedKey, 342, 342)
    || !isBase64Url(value.iv, 16, 16)
    || !isBase64Url(value.ciphertext, 16, 32_768)) {
    throw new ApiError(400, "ENVELOPE_INVALID");
  }
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    synthetic: true,
    keyId: value.keyId,
    wrappedKey: value.wrappedKey,
    iv: value.iv,
    ciphertext: value.ciphertext,
  };
}

export function validateSyntheticContribution(value: unknown): SyntheticContribution {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "synthetic",
      "fixtureId",
      "timeRange",
      "quota",
      "usage",
      "accounting",
    ])) {
    throw new ApiError(400, "SYNTHETIC_RECORD_INVALID");
  }
  if (value.synthetic !== true) throw new ApiError(400, "SYNTHETIC_REQUIRED");
  if (value.schemaVersion !== CONTRIBUTION_SCHEMA_VERSION || value.fixtureId !== FIXTURE_ID) {
    throw new ApiError(400, "SYNTHETIC_RECORD_INVALID");
  }

  const timeRange = value.timeRange;
  const quota = value.quota;
  const usage = value.usage;
  const accounting = value.accounting;
  if (!isRecord(timeRange)
    || !hasExactKeys(timeRange, ["start", "end"])
    || !isCanonicalInstant(timeRange.start)
    || !isCanonicalInstant(timeRange.end)
    || Date.parse(timeRange.end) <= Date.parse(timeRange.start)
    || Date.parse(timeRange.end) - Date.parse(timeRange.start) > 31 * 86_400_000
    || !isRecord(quota)
    || !hasExactKeys(quota, [
      "windowMinutes",
      "usedPercentBefore",
      "usedPercentAfter",
      "displayPrecision",
    ])
    || !isSafeInteger(quota.windowMinutes, 43_200)
    || quota.windowMinutes < 1
    || !isBoundedNumber(quota.usedPercentBefore, 0, 100)
    || !isBoundedNumber(quota.usedPercentAfter, 0, 100)
    || !isSafeInteger(quota.displayPrecision, 4)
    || !isRecord(usage)
    || !hasExactKeys(usage, [
      "modelId",
      "subscriptionSpeed",
      "apiTierAssumption",
      "inputUncachedTokens",
      "inputCachedTokens",
      "outputTextTokens",
      "outputReasoningTokens",
      "providerToolUnits",
    ])
    || typeof usage.modelId !== "string"
    || !/^[A-Za-z0-9._:-]{1,80}$/.test(usage.modelId)
    || !["standard", "fast"].includes(String(usage.subscriptionSpeed))
    || !["standard", "priority", "flex"].includes(String(usage.apiTierAssumption))
    || !isSafeInteger(usage.inputUncachedTokens, 1_000_000_000_000)
    || !isSafeInteger(usage.inputCachedTokens, 1_000_000_000_000)
    || !isSafeInteger(usage.outputTextTokens, 1_000_000_000_000)
    || !isSafeInteger(usage.outputReasoningTokens, 1_000_000_000_000)
    || !isRecord(usage.providerToolUnits)
    || !hasExactKeys(usage.providerToolUnits, ["webSearchCalls", "unknownUnits"])
    || !isSafeInteger(usage.providerToolUnits.webSearchCalls, 1_000_000)
    || !isSafeInteger(usage.providerToolUnits.unknownUnits, 1_000_000)
    || !isRecord(accounting)
    || !hasExactKeys(accounting, [
      "estimatedApiCostUsd",
      "pricedEventCoveragePercent",
      "unknownBillableUnits",
      "priceBasis",
    ])
    || typeof accounting.estimatedApiCostUsd !== "string"
    || !/^(?:0|[1-9]\d{0,8})\.\d{6}$/.test(accounting.estimatedApiCostUsd)
    || !isBoundedNumber(accounting.pricedEventCoveragePercent, 0, 100)
    || !isSafeInteger(accounting.unknownBillableUnits, 1_000_000)
    || accounting.unknownBillableUnits !== usage.providerToolUnits.unknownUnits
    || accounting.priceBasis !== "current-api-price-sensitivity") {
    throw new ApiError(400, "SYNTHETIC_RECORD_INVALID");
  }

  const expected = syntheticFixture();
  if (!isExactValue(value, expected)) {
    throw new ApiError(400, "SYNTHETIC_RECORD_INVALID");
  }
  return expected;
}
