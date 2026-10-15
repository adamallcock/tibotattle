import { ApiError } from "./errors";

export type TelemetryActivationRefusalPhase = "rekey" | "classification" | "state" | "session_closure" | "closure";
/** Private, closed activation-query boundaries. This is aggregate diagnostic
 * metadata only; it never changes an API response or exposes query details. */
export const TELEMETRY_ACTIVATION_FAILURE_STAGES = Object.freeze([
  "transaction_setup", "transaction_finalization", "transaction_rollback", "transaction_release",
  "activation_preflight", "activation_publish",
  "manifest_integrity_11", "manifest_integrity_12", "activation_ownership", "work_mem_read", "work_mem_apply",
  "candidate_ctas", "candidate_analyze",
  "source_10_ctas", "source_10_analyze", "source_11_ctas", "source_11_analyze",
  "source_12_ctas", "source_12_analyze",
  "rekey_scope", "rekey_planner_read", "rekey_planner_disable", "rekey_pairs_ctas",
  "rekey_pairs_analyze", "rekey_streams", "rekey_session_links", "rekey_quota_filter",
  "rekey_v11_acceptance", "rekey_v12_acceptance_ctas", "rekey_v12_acceptance_index",
  "rekey_v12_acceptance_analyze", "rekey_v12_acceptance_count", "rekey_nestloop_restore",
  "same_day_manifest", "same_day_summary", "same_day_occurrence",
  "pair_foreign_10_ctas", "pair_foreign_10_index", "pair_exact_10_ctas", "pair_exact_10_index",
  "pair_foreign_11_ctas", "pair_foreign_11_index", "pair_exact_11_ctas", "pair_exact_11_index",
  "pair_foreign_12_ctas", "pair_foreign_12_index", "pair_exact_12_ctas", "pair_exact_12_index",
  "pair_foreign_page", "pair_exact_page", "pair_record_evidence", "pair_link_evidence",
  "pair_header_evidence", "pair_link_insert", "pair_link_reconcile",
  "session_closure_link_page", "session_closure_records", "session_closure_usage_page",
  "session_closure_usage_records", "session_closure_usage_index", "session_closure_links", "session_closure_runtime",
  "session_closure_archive_page", "session_closure_archive_records", "session_closure_archive_links",
  "session_closure_archive_headers", "work_cleanup", "work_mem_restore",
] as const);
export type TelemetryActivationFailureStage = typeof TELEMETRY_ACTIVATION_FAILURE_STAGES[number];

/** Closed aggregate-only observations. Never copy a principal, manifest,
 * generation, token, request identifier, error message or provider field. */
export interface TelemetryActivationObservation {
  readonly event: "telemetry_domain_activation";
  readonly protocol: "v1.1" | "v1.2";
  readonly outcome: "activated" | "replayed" | "unchanged" | "refused" | "failed";
  readonly status: number;
  readonly code: string | null;
  readonly refusalPhase: TelemetryActivationRefusalPhase | null;
  readonly failureStage: TelemetryActivationFailureStage | null;
  readonly elapsedMs: number;
  readonly at: string;
}
const REFUSAL_PHASES = new Set<TelemetryActivationRefusalPhase>([
  "rekey", "classification", "state", "session_closure", "closure",
]);
const REFUSAL_PHASE_BY_ERROR = new WeakMap<ApiError, TelemetryActivationRefusalPhase>();
const FAILURE_STAGE_BY_ERROR = new WeakMap<ApiError, TelemetryActivationFailureStage>();
const FAILURE_STAGES = new Set<TelemetryActivationFailureStage>(TELEMETRY_ACTIVATION_FAILURE_STAGES);
const FAILURE_STAGE_CODES = new Set(["BACKEND_STORAGE_UNAVAILABLE", "TELEMETRY_STORAGE_CONSTRAINT"]);
const REFUSALS = new Set([
  "BODY_INVALID", "CHUNK_DIGEST_MISMATCH", "DEVICE_AUTH_INVALID", "DEVICE_CONSENT_REQUIRED",
  "TELEMETRY_MANIFEST_INVALID", "TELEMETRY_MANIFEST_CONFLICT", "TELEMETRY_MANIFEST_INCOMPLETE",
  "TELEMETRY_OCCURRENCE_CONFLICT", "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE",
  "SYNC_RANGE_TOO_LARGE", "TELEMETRY_TRANSPORT_BLOCKED", "TELEMETRY_TRANSPORT_DOWNGRADE_BLOCKED",
  "BACKEND_STORAGE_UNAVAILABLE", "PROCESSING_DISABLED", "COLLECTION_CONTROL_UNAVAILABLE",
]);

function isApiError(error: unknown): error is ApiError {
  try { return error instanceof ApiError; } catch { return false; }
}

/** Attach only an allowlisted internal phase without changing the API error. */
export function markTelemetryActivationRefusalPhase<T extends ApiError>(
  error: T,
  phase: unknown,
): T {
  if (isApiError(error) && REFUSAL_PHASES.has(phase as TelemetryActivationRefusalPhase)
      && !REFUSAL_PHASE_BY_ERROR.has(error)) {
    REFUSAL_PHASE_BY_ERROR.set(error, phase as TelemetryActivationRefusalPhase);
  }
  return error;
}

/** Attach only a closed internal stage. The observer exposes it only for a
 * failed v1.2 activation after it has verified the safe error metadata. */
export function markTelemetryActivationFailureStage<T extends ApiError>(
  error: T,
  stage: unknown,
): T {
  if (isApiError(error) && FAILURE_STAGES.has(stage as TelemetryActivationFailureStage)
      && !FAILURE_STAGE_BY_ERROR.has(error)) {
    FAILURE_STAGE_BY_ERROR.set(error, stage as TelemetryActivationFailureStage);
  }
  return error;
}

export function createTelemetryActivationObserver(
  log: (observation: TelemetryActivationObservation) => unknown,
  clock: () => number = Date.now,
) {
  return async <T>(protocol: "v1.1" | "v1.2", invoke: () => Promise<T>): Promise<T> => {
    if (protocol !== "v1.1" && protocol !== "v1.2") return invoke();
    let start = 0;
    try { start = clock(); } catch { /* observation is best effort */ }
    const emit = async (outcome: TelemetryActivationObservation["outcome"], status: number, code: string | null,
      refusalPhase: TelemetryActivationRefusalPhase | null,
      failureStage: TelemetryActivationFailureStage | null) => {
      try {
        const end = clock();
        const elapsedMs = Number.isFinite(end - start) ? Math.min(600_000, Math.max(0, Math.floor(end - start))) : 0;
        void Promise.resolve(log(Object.freeze({ event: "telemetry_domain_activation", protocol, outcome, status, code,
          refusalPhase, failureStage, elapsedMs, at: new Date(end).toISOString() }))).catch(() => {});
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
      await emit(outcome, 201, null, null, null);
      return result;
    } catch (error) {
      const apiError = isApiError(error) ? error : null;
      let status = 500;
      let code: string | null = null;
      let refusalPhase: TelemetryActivationRefusalPhase | null = null;
      let failureStage: TelemetryActivationFailureStage | null = null;
      let metadataReadable = true;
      let failureCodeAllowed = false;
      if (apiError) {
        try {
          const candidate = apiError.status;
          if (Number.isSafeInteger(candidate) && candidate >= 400 && candidate <= 599) status = candidate;
          else metadataReadable = false;
        } catch { metadataReadable = false; /* hostile accessors fail closed */ }
        try {
          const candidate = apiError.code;
          failureCodeAllowed = typeof candidate === "string" && FAILURE_STAGE_CODES.has(candidate);
          if (REFUSALS.has(candidate)) code = candidate;
          else if (!failureCodeAllowed) metadataReadable = false;
        } catch { metadataReadable = false; /* hostile accessors fail closed */ }
        refusalPhase = protocol === "v1.2" && status < 500
          ? REFUSAL_PHASE_BY_ERROR.get(apiError) ?? null : null;
        if (protocol === "v1.2" && metadataReadable && failureCodeAllowed && status >= 500) {
          failureStage = FAILURE_STAGE_BY_ERROR.get(apiError) ?? null;
        }
      }
      code ??= status >= 500 ? "ACTIVATION_UNAVAILABLE" : "ACTIVATION_REFUSED";
      await emit(status >= 500 ? "failed" : "refused", status, code, refusalPhase, failureStage);
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
