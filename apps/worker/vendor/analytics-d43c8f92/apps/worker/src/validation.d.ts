import { CONTRIBUTION_SCHEMA_VERSION, ENVELOPE_SCHEMA_VERSION, FIXTURE_ID } from "./constants";
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
export declare function syntheticFixture(): SyntheticContribution;
export declare function validateEnvelope(value: unknown): SyntheticEnvelope;
export declare function validateSyntheticContribution(value: unknown): SyntheticContribution;
