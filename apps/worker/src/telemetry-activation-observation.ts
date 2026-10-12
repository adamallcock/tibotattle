import { ApiError } from "./errors";

/** Closed aggregate-only observations. Never copy a principal, manifest,
 * generation, token, request identifier, error message or provider field. */
export interface TelemetryActivationObservation {
  readonly event: "telemetry_domain_activation";
  readonly protocol: "v1.1" | "v1.2";
  readonly outcome: "activated" | "replayed" | "unchanged" | "refused" | "failed";
  readonly status: number;
  readonly code: string | null;
  readonly elapsedMs: number;
  readonly at: string;
}
const REFUSALS = new Set([
  "BODY_INVALID", "CHUNK_DIGEST_MISMATCH", "DEVICE_AUTH_INVALID", "DEVICE_CONSENT_REQUIRED",
  "TELEMETRY_MANIFEST_INVALID", "TELEMETRY_MANIFEST_CONFLICT", "TELEMETRY_MANIFEST_INCOMPLETE",
  "TELEMETRY_OCCURRENCE_CONFLICT", "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE",
  "SYNC_RANGE_TOO_LARGE", "TELEMETRY_TRANSPORT_BLOCKED", "TELEMETRY_TRANSPORT_DOWNGRADE_BLOCKED",
  "BACKEND_STORAGE_UNAVAILABLE", "PROCESSING_DISABLED", "COLLECTION_CONTROL_UNAVAILABLE",
]);

export function createTelemetryActivationObserver(
  log: (observation: TelemetryActivationObservation) => unknown,
  clock: () => number = Date.now,
) {
  return async <T>(protocol: "v1.1" | "v1.2", invoke: () => Promise<T>): Promise<T> => {
    if (protocol !== "v1.1" && protocol !== "v1.2") return invoke();
    let start = 0;
    try { start = clock(); } catch { /* observation is best effort */ }
    const emit = async (outcome: TelemetryActivationObservation["outcome"], status: number, code: string | null) => {
      try {
        const end = clock();
        const elapsedMs = Number.isFinite(end - start) ? Math.min(600_000, Math.max(0, Math.floor(end - start))) : 0;
        void Promise.resolve(log(Object.freeze({ event: "telemetry_domain_activation", protocol, outcome, status, code,
          elapsedMs, at: new Date(end).toISOString() }))).catch(() => {});
      } catch { /* logging cannot change an activation or its refusal */ }
    };
    try {
      const result = await invoke();
      let outcome: TelemetryActivationObservation["outcome"] = "activated";
      try {
        const row = typeof result === "object" && result !== null ? result : {};
        outcome = Reflect.get(row, "unchanged") === true ? "unchanged"
          : Reflect.get(row, "replay") === true ? "replayed" : "activated";
      } catch { /* a result accessor cannot change a successful activation */ }
      await emit(outcome, 201, null);
      return result;
    } catch (error) {
      const status = error instanceof ApiError && Number.isSafeInteger(error.status)
        && error.status >= 400 && error.status <= 599 ? error.status : 500;
      const code = error instanceof ApiError && REFUSALS.has(error.code) ? error.code
        : status >= 500 ? "ACTIVATION_UNAVAILABLE" : "ACTIVATION_REFUSED";
      await emit(status >= 500 ? "failed" : "refused", status, code);
      throw error;
    }
  };
}

const TELEMETRY_REQUEST_OPERATIONS = new Set([
  "device_sync_state", "device_sync_capabilities", "device_sync_capabilities_v12", "device_sync_manifest",
  "device_upload_authorization", "contributions", "telemetry_v11_consent", "telemetry_v12_consent",
  "telemetry_v11_day_manifests", "telemetry_v12_day_manifests", "telemetry_v11_domain_predecessor",
  "telemetry_v12_domain_predecessor", "telemetry_v11_domain_activate", "telemetry_v12_domain_activate",
]);

/** Count both successful and refused upload stages without reading bodies.
 * This runs after the edge's authority/admission boundary. Existing closed
 * failure logs retain codes; this line adds successful attempts and duration. */
export function createTelemetryRequestObserver(log: (event: Readonly<{
  event: "telemetry_request_completed"; operation: string; status: number; elapsedMs: number; at: string;
}>) => unknown, clock: () => number = Date.now) {
  return async (operation: string, invoke: () => Promise<Response>): Promise<Response> => {
    if (!TELEMETRY_REQUEST_OPERATIONS.has(operation)) return invoke();
    let start = 0;
    try { start = clock(); } catch { /* best effort */ }
    const response = await invoke();
    try {
      const end = clock();
      const elapsedMs = Number.isFinite(end - start) ? Math.min(600_000, Math.max(0, Math.floor(end - start))) : 0;
      void Promise.resolve(log(Object.freeze({ event: "telemetry_request_completed", operation,
        status: response.status, elapsedMs,
        at: new Date(end).toISOString() }))).catch(() => {});
    } catch { /* logging cannot change the response */ }
    return response;
  };
}
