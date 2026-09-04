import { JSON_HEADERS } from "./constants";

export type ErrorCode =
  | "ACCESS_REQUIRED"
  | "ACCOUNT_SCOPED_CONFIGURATION_INVALID"
  | "ACCOUNT_SCOPED_INGEST_DISABLED"
  | "ACCOUNT_SCOPED_LOCAL_ONLY"
  | "ACCOUNTLESS_ENROLLMENT_CONFLICT"
  | "ACCOUNTLESS_ENROLLMENT_DISABLED"
  | "ACCOUNTLESS_ENROLLMENT_EXPIRED"
  | "ACCOUNTLESS_ENROLLMENT_LIMIT_REACHED"
  | "ACCOUNTLESS_ENROLLMENT_REVOKED"
  | "ADMIN_ACTION_CONFLICT"
  | "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE"
  | "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE"
  | "ADMIN_NOT_CONFIGURED"
  | "ADMIN_REQUIRED"
  | "ADMISSION_RATE_LIMIT_UNAVAILABLE"
  | "ADMISSION_CONFIGURATION_INVALID"
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "ATTEMPT_LIMIT_REACHED"
  | "SIGN_IN_START_LIMIT_REACHED"
  | "BACKEND_STORAGE_UNAVAILABLE"
  | "BODY_INVALID"
  | "BODY_TIMEOUT"
  | "BODY_TOO_LARGE"
  | "CHUNK_ADMISSION_LIMIT_REACHED"
  | "CHUNK_DIGEST_MISMATCH"
  | "CHUNK_INVALID"
  | "CHUNK_REVISION_CONFLICT"
  | "CONTENT_TYPE_INVALID"
  | "CONTRIBUTION_LIMIT_REACHED"
  | "CONTRIBUTION_DELETE_CONFLICT"
  | "COLLECTION_CONTROL_UNAVAILABLE"
  | "COLLECTION_ENROLLMENT_DISABLED"
  | "DEPLOYMENT_SOURCE_COMMIT_INVALID"
  | "CSRF_INVALID"
  | "DELETION_LEDGER_UNAVAILABLE"
  | "DECRYPTION_FAILED"
  | "DEVICE_AUTH_INVALID"
  | "DEVICE_CONTINUITY_REQUIRED"
  | "DEVICE_NOT_FOUND"
  | "DISTRIBUTION_SYNC_UNAVAILABLE"
  | "ENVELOPE_INVALID"
  | "IDENTITY_CONFIGURATION_INVALID"
  | "IDENTITY_PROVIDER_UNAVAILABLE"
  | "IDENTITY_REQUIRED"
  | "IDENTITY_RESULT_PENDING"
  | "IDENTITY_REENROLLMENT_COOLDOWN"
  | "IDENTITY_TOKEN_INVALID"
  | "INTERNAL_ERROR"
  | "INVITE_GRANT_INVALID"
  | "ENROLLMENT_DISABLED"
  | "KEY_CONFIGURATION_INVALID"
  | "KEY_ID_INVALID"
  | "LIFECYCLE_BOUNDS_EXCEEDED"
  | "LIFECYCLE_STATE_CONFLICT"
  | "METHOD_NOT_ALLOWED"
  | "NOT_FOUND"
  | "PARTICIPANT_DELETING"
  | "PAIRING_AUTH_INVALID"
  | "PROCESSING_DISABLED"
  | "PRIVACY_CANARY_DETECTED"
  | "PUBLICATION_DISABLED"
  | "RECORD_OWNED_BY_OTHER_CHUNK"
  | "SPARKLE_APPCAST_GUARD_AUTH_INVALID"
  | "SPARKLE_APPCAST_GUARD_BODY_TOO_LARGE"
  | "SPARKLE_APPCAST_GUARD_CANDIDATE_INVALID"
  | "SPARKLE_APPCAST_GUARD_CONFIGURATION_INVALID"
  | "SPARKLE_APPCAST_GUARD_REQUEST_INVALID"
  | "SPARKLE_APPCAST_GUARD_REPLAY_INVALID"
  | "SPARKLE_APPCAST_GUARD_TARGET_INVALID"
  | "SPARKLE_APPCAST_GUARD_STORAGE_UNAVAILABLE"
  | "SYNC_RANGE_TOO_LARGE"
  | "SYNTHETIC_RECORD_INVALID"
  | "SYNTHETIC_REQUIRED"
  | "TELEMETRY_CONSENT_INVALID"
  | "TELEMETRY_TRANSPORT_BLOCKED"
  | "TELEMETRY_MANIFEST_INVALID"
  | "TELEMETRY_MANIFEST_CONFLICT"
  | "TELEMETRY_MANIFEST_INCOMPLETE"
  | "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE"
  | "TELEMETRY_RECORD_INVALID"
  | "TELEMETRY_OCCURRENCE_CONFLICT"
  | "TELEMETRY_REQUIRED"
  | "UPLOAD_AUTH_INVALID"
  | "UPLOAD_ADMISSION_LIMIT_REACHED"
  | "UPLOAD_INGRESS_LIMIT_REACHED"
  | "UPLOAD_INGRESS_UNAVAILABLE"
  | "UPLOAD_REGISTRATION_DISABLED"
  | "UPLOAD_IN_PROGRESS";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly publicDetails: Readonly<Record<string, unknown>> | null;
  readonly responseHeaders: HeadersInit | null;

  constructor(
    status: number,
    code: ErrorCode,
    options: {
      publicDetails?: Readonly<Record<string, unknown>>;
      responseHeaders?: HeadersInit;
    } = {},
  ) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.publicDetails = options.publicDetails ?? null;
    this.responseHeaders = options.responseHeaders ?? null;
  }
}

export function jsonResponse(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(JSON_HEADERS);
  if (extraHeaders) {
    for (const [name, headerValue] of new Headers(extraHeaders)) {
      headers.set(name, headerValue);
    }
  }
  return Response.json(value, { status, headers });
}

export function errorResponse(error: ApiError, requestId: string): Response {
  return jsonResponse(
    {
      error: {
        code: error.code,
        requestId,
        ...(error.publicDetails === null
          ? {}
          : { details: error.publicDetails }),
      },
    },
    error.status,
    error.responseHeaders ?? undefined,
  );
}
