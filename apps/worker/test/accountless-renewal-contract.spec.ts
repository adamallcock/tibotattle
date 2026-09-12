import { describe, expect, it } from "vitest";

import {
  ACCOUNTLESS_RENEWAL_SCHEMA_VERSION,
  parseAccountlessRenewalJson,
  parseAccountlessRenewalRequest,
} from "../src/accountless-renewal";
import {
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
} from "../src/accountless-enrollment";
import {
  ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
} from "../src/accountless-ownership";
import { ApiError } from "../src/errors";

const request = Object.freeze({
  schemaVersion: ACCOUNTLESS_RENEWAL_SCHEMA_VERSION,
  policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
});

function errorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  throw new Error("expected ApiError");
}

describe("accountless renewal wire boundary", () => {
  it("accepts only the closed same-graph contract", () => {
    expect(parseAccountlessRenewalRequest(request)).toEqual(request);
    expect(errorCode(() => parseAccountlessRenewalRequest({
      ...request,
      deviceId: "would-create-an-identity",
    }))).toBe("BODY_INVALID");
    expect(errorCode(() => parseAccountlessRenewalRequest({
      ...request,
      schemaVersion: "accountless-enrollment-v0.1",
    }))).toBe("BODY_INVALID");
    expect(errorCode(() => parseAccountlessRenewalJson(JSON.stringify(request)
      .replace("{", '{"schemaVersion":"wrong",')))).toBe("BODY_INVALID");
  });

});
