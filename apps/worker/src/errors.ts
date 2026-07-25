import { JSON_HEADERS } from "./constants";

export type ErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "BODY_INVALID"
  | "BODY_TOO_LARGE"
  | "CONTENT_TYPE_INVALID"
  | "CONTRIBUTION_LIMIT_REACHED"
  | "DECRYPTION_FAILED"
  | "ENVELOPE_INVALID"
  | "INTERNAL_ERROR"
  | "KEY_CONFIGURATION_INVALID"
  | "KEY_ID_INVALID"
  | "METHOD_NOT_ALLOWED"
  | "NOT_FOUND"
  | "PARTICIPANT_DELETING"
  | "SYNTHETIC_RECORD_INVALID"
  | "SYNTHETIC_REQUIRED";

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
