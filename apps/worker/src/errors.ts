import { JSON_HEADERS } from "./constants";

export type ErrorCode =
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
  | "CSRF_INVALID"
  | "DECRYPTION_FAILED"
  | "DEVICE_AUTH_INVALID"
  | "DEVICE_NOT_FOUND"
  | "ENVELOPE_INVALID"
  | "INTERNAL_ERROR"
  | "INVITE_GRANT_INVALID"
  | "ENROLLMENT_DISABLED"
  | "KEY_CONFIGURATION_INVALID"
  | "KEY_ID_INVALID"
  | "METHOD_NOT_ALLOWED"
  | "NOT_FOUND"
  | "PARTICIPANT_DELETING"
  | "PAIRING_AUTH_INVALID"
  | "PRIVACY_CANARY_DETECTED"
  | "SYNTHETIC_RECORD_INVALID"
  | "SYNTHETIC_REQUIRED"
  | "TELEMETRY_RECORD_INVALID"
  | "TELEMETRY_OCCURRENCE_CONFLICT"
  | "TELEMETRY_REQUIRED"
  | "UPLOAD_AUTH_INVALID"
  | "UPLOAD_IN_PROGRESS";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(status: number, code: ErrorCode) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
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
    { error: { code: error.code, requestId } },
    error.status,
  );
}
