import { describe, expect, it } from "vitest";

import {
  ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCOPE,
  ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  accountlessOwnershipResponse,
  assertAccountlessOwnershipLaboratory,
  configuredAccountlessOwnershipMode,
  parseAccountlessOwnershipJson,
  parseAccountlessOwnershipRequest,
} from "../src/accountless-ownership";
import { ApiError } from "../src/errors";

const request = Object.freeze({
  schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
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

describe("accountless ownership wire boundary", () => {
  it("accepts only the closed policy authorization and never accepts consent fields", () => {
    expect(parseAccountlessOwnershipRequest(request)).toEqual(request);
    expect(errorCode(() => parseAccountlessOwnershipRequest({
      ...request,
      consentedAt: "2026-09-05T00:00:00.000Z",
    }))).toBe("BODY_INVALID");
    expect(errorCode(() => parseAccountlessOwnershipRequest({
      ...request,
      telemetrySchemaVersion: "telemetry-contribution-v1.0",
    }))).toBe("BODY_INVALID");
    expect(errorCode(() => parseAccountlessOwnershipJson(JSON.stringify(request)
      .replace("{", '{"schemaVersion":"wrong",')))).toBe("BODY_INVALID");
  });

  it("returns a closed receipt with no owner, secret, session, pairing, or consent timestamp", () => {
    const receipt = accountlessOwnershipResponse(
      "0f6bc7c8-1234-4d5e-8f90-123456789abc",
      "2026-10-05T00:00:00.000Z",
      "created",
    );
    expect(Object.keys(receipt).sort()).toEqual([
      "authorizationBasis",
      "deviceId",
      "expiresAt",
      "policyVersion",
      "schemaVersion",
      "scope",
      "state",
      "telemetrySchemaVersion",
    ]);
    expect(receipt).toMatchObject({
      scope: ACCOUNTLESS_UPLOAD_OWNER_SCOPE,
      authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
      telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
    });
    expect(JSON.stringify(receipt)).not.toMatch(/participant|secret|session|pairing|consent/iu);
  });

  it("fails closed unless an explicit synthetic loopback mode is present", () => {
    expect(configuredAccountlessOwnershipMode({} as Env)).toBe("disabled");
    expect(errorCode(() => configuredAccountlessOwnershipMode({
      ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    } as unknown as Env))).toBe("ACCOUNTLESS_OWNERSHIP_CONFIGURATION_INVALID");
    expect(errorCode(() => assertAccountlessOwnershipLaboratory(
      {} as Env,
      new URL("http://127.0.0.1:8787/api/v1/accountless/ownership"),
    ))).toBe("ACCOUNTLESS_OWNERSHIP_DISABLED");
    expect(() => assertAccountlessOwnershipLaboratory({
      ENVIRONMENT: "synthetic-development",
      ACCOUNTLESS_OWNERSHIP_MODE: "synthetic-local",
    } as unknown as Env,
    new URL("http://127.0.0.1:8787/api/v1/accountless/ownership"),
    )).not.toThrow();
    expect(errorCode(() => assertAccountlessOwnershipLaboratory({
      ENVIRONMENT: "synthetic-development",
      ACCOUNTLESS_OWNERSHIP_MODE: "synthetic-local",
    } as unknown as Env,
    new URL("https://tibotattle.com/api/v1/accountless/ownership"),
    ))).toBe("ACCOUNTLESS_OWNERSHIP_DISABLED");
  });
});
