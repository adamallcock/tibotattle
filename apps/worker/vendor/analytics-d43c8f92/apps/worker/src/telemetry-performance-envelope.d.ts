export declare const TELEMETRY_PERFORMANCE_ENVELOPE_SCHEMA_VERSION: "telemetry-performance-envelope-v1";
export declare const TELEMETRY_PERFORMANCE_MAX_CIPHERTEXT_CHARS = 2000000;
export interface TelemetryPerformanceEnvelope {
    readonly schemaVersion: typeof TELEMETRY_PERFORMANCE_ENVELOPE_SCHEMA_VERSION;
    readonly synthetic: false;
    readonly keyId: string;
    readonly wrappedKey: string;
    readonly iv: string;
    readonly ciphertext: string;
}
/**
 * Validate the independent performance envelope at the Worker boundary.
 * Ciphertext remains opaque: privacy canaries are checked only after
 * decryption by the report parser.
 */
export declare function validateTelemetryPerformanceEnvelope(value: unknown): TelemetryPerformanceEnvelope;
