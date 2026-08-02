import { JSON_HEADERS } from "./constants";

export type ErrorCode =
  | "ACCOUNT_SCOPED_CONFIGURATION_INVALID"
  | "ACCOUNT_SCOPED_INGEST_DISABLED"
  | "ACCOUNT_SCOPED_LOCAL_ONLY"
  | "ADMIN_ACTION_CONFLICT"
  | "ADMIN_NOT_CONFIGURED"
  | "ADMIN_REQUIRED"
  | "ADMISSION_CONFIGURATION_INVALID"
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "ATTEMPT_LIMIT_REACHED"
  | "BACKEND_STORAGE_UNAVAILABLE"
  | "BODY_INVALID"
  | "BODY_TOO_LARGE"
  | "CONTENT_TYPE_INVALID"
  | "CONTRIBUTION_LIMIT_REACHED"
  | "CONTRIBUTION_DELETE_CONFLICT"
  | "COLLECTION_CONTROL_UNAVAILABLE"
  | "COLLECTION_ENROLLMENT_DISABLED"
  | "CSRF_INVALID"
  | "DELETION_LEDGER_UNAVAILABLE"
  | "DECRYPTION_FAILED"
  | "DEVICE_AUTH_INVALID"
  | "DEVICE_NOT_FOUND"
  | "ENVELOPE_INVALID"
  | "IDENTITY_CONFIGURATION_INVALID"
  | "IDENTITY_PROVIDER_UNAVAILABLE"
  | "IDENTITY_REQUIRED"
  | "IDENTITY_RESULT_PENDING"
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
  | "SYNTHETIC_RECORD_INVALID"
  | "SYNTHETIC_REQUIRED"
  | "TELEMETRY_RECORD_INVALID"
  | "TELEMETRY_OCCURRENCE_CONFLICT"
  | "TELEMETRY_REQUIRED"
  | "UPLOAD_AUTH_INVALID"
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
