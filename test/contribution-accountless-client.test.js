import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNTLESS_RENEWAL_SCHEMA_VERSION,
  renewAccountlessContributionOwnership,
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
  ContributionAccountlessClientError,
  claimAccountlessContributionOwnership,
  enrollAccountlessContribution,
  runAccountlessContributionSyncOnce,
} from "../src/contribution-accountless-client.js";
import {
  ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCOPE,
  ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
} from "../src/contribution/index.js";
import { DEPLOYMENT_ENDPOINTS } from "../config/deployment-endpoints.js";

const ORIGIN = "https://usage.example";
const LABORATORY_ORIGIN = "http://127.0.0.1:8787";
const REHEARSAL_ORIGIN = DEPLOYMENT_ENDPOINTS.staging.origin;
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_SECRET_HASH = "a".repeat(64);
const EXPIRES_AT = "2026-09-28T00:00:00.000Z";
const NOW = Date.parse("2026-09-04T00:00:00.000Z");

function preference(overrides = {}) {
  return {
    schemaVersion: "local-contribution-preference-v1",
    available: true,
    current: true,
    enabled: true,
    basis: "default_on",
    policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
    destinationOrigin: ORIGIN,
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

function capability({ origin = ORIGIN } = {}) {
  return {
    status: "created",
    origin,
    deviceId: DEVICE_ID,
    deviceSecretHash: DEVICE_SECRET_HASH,
  };
}

function enrollmentReceipt(overrides = {}) {
  return {
    schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
    state: "enrolled",
    deviceId: DEVICE_ID,
    expiresAt: EXPIRES_AT,
    policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    scope: "enrollment_only",
    ...overrides,
  };
}

function ownershipReceipt(overrides = {}) {
  return {
    schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
    state: "created",
    deviceId: DEVICE_ID,
    expiresAt: EXPIRES_AT,
    policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
    scope: ACCOUNTLESS_UPLOAD_OWNER_SCOPE,
    telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
    ...overrides,
  };
}

function laboratoryLease({ onSecret = () => {} } = {}) {
  return async ({ backend, expectedOrigin, operation }) => {
    assert.deepEqual(backend, { laboratory: true });
    assert.equal(expectedOrigin, LABORATORY_ORIGIN);
    const secret = Buffer.alloc(32, 7);
    try {
      onSecret(secret);
      return await operation(secret, {
        origin: LABORATORY_ORIGIN,
        deviceId: DEVICE_ID,
        createdAt: "2026-09-01T00:00:00.000Z",
      });
    } finally {
      secret.fill(0);
    }
  };
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function streamResponse(chunks, onCancel, { closeWhenDone = true } = {}) {
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        if (closeWhenDone) controller.close();
        else return new Promise(() => {});
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel: onCancel,
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

function isClientError(code, { retryable } = {}) {
  return (error) => error instanceof ContributionAccountlessClientError
    && error.code === `contribution_accountless_client_${code}`
    && (retryable === undefined || error.retryable === retryable);
}

test("enrollment sends the frozen five-key request and returns a narrow lease receipt", async () => {
  const calls = [];
  let capabilityCalls = 0;
  let preferenceReads = 0;
  const result = await enrollAccountlessContribution({
    origin: ORIGIN,
    readPreference: async () => {
      preferenceReads += 1;
      return preference();
    },
    now: () => NOW,
    ensureCapability: async (options) => {
      capabilityCalls += 1;
      assert.deepEqual(options, { origin: ORIGIN });
      return capability();
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse(enrollmentReceipt());
    },
  });

  assert.equal(capabilityCalls, 1);
  assert.equal(preferenceReads, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ORIGIN}/api/v1/accountless/enrollment`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(calls[0].options.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
    deviceId: DEVICE_ID,
    deviceSecretHash: DEVICE_SECRET_HASH,
    policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  });
  assert.deepEqual(result, {
    status: "enrolled",
    origin: ORIGIN,
    deviceId: DEVICE_ID,
    scope: "enrollment_only",
    expiresAt: EXPIRES_AT,
  });
  assert.equal(Object.hasOwn(result, "deviceSecretHash"), false);
  assert.equal(Object.hasOwn(result, "token"), false);
  assert.equal(Object.isFrozen(result), true);
});

test("an existing enrollment receipt is accepted without exposing server identity", async () => {
  const result = await enrollAccountlessContribution({
    origin: ORIGIN,
    readPreference: async () => preference(),
    now: () => NOW,
    ensureCapability: async () => capability(),
    fetchImpl: async () => jsonResponse(enrollmentReceipt({ state: "existing" })),
  });

  assert.deepEqual(result, {
    status: "existing",
    origin: ORIGIN,
    deviceId: DEVICE_ID,
    scope: "enrollment_only",
    expiresAt: EXPIRES_AT,
  });
});

test("ineligible or unavailable preference prevents capability creation and network activity", async () => {
  for (const invalidPreference of [
    preference({ enabled: false, basis: "default_off" }),
    preference({ current: false }),
    preference({ available: false }),
    preference({ destinationOrigin: "https://other.example" }),
    preference({ policyVersion: "accountless-opt-out-v0" }),
  ]) {
    let capabilityCalls = 0;
    let networkCalls = 0;
    await assert.rejects(
      enrollAccountlessContribution({
        origin: ORIGIN,
        readPreference: async () => invalidPreference,
        now: () => NOW,
        ensureCapability: async () => {
          capabilityCalls += 1;
          return capability();
        },
        fetchImpl: async () => {
          networkCalls += 1;
          return jsonResponse(enrollmentReceipt());
        },
      }),
      isClientError(
        invalidPreference.available === false ? "preference_unavailable" : "preference_ineligible",
      ),
    );
    assert.equal(capabilityCalls, 0);
    assert.equal(networkCalls, 0);
  }
});

test("a preference opt-out observed while capability loading blocks the request", async () => {
  const snapshots = [
    preference(),
    preference({ enabled: false, basis: "default_off" }),
  ];
  let capabilityCalls = 0;
  let networkCalls = 0;
  await assert.rejects(
    enrollAccountlessContribution({
      origin: ORIGIN,
      readPreference: async () => snapshots.shift() ?? snapshots.at(-1),
      now: () => NOW,
      ensureCapability: async () => {
        capabilityCalls += 1;
        return capability();
      },
      fetchImpl: async () => {
        networkCalls += 1;
        return jsonResponse(enrollmentReceipt());
      },
    }),
    isClientError("preference_ineligible"),
  );
  assert.equal(capabilityCalls, 1);
  assert.equal(networkCalls, 0);
});

test("a preference opt-out observed after the receipt withholds that receipt", async () => {
  const snapshots = [
    preference(),
    preference(),
    preference({ enabled: false, basis: "default_off" }),
  ];
  let networkCalls = 0;
  await assert.rejects(
    enrollAccountlessContribution({
      origin: ORIGIN,
      readPreference: async () => snapshots.shift() ?? snapshots.at(-1),
      now: () => NOW,
      ensureCapability: async () => capability(),
      fetchImpl: async () => {
        networkCalls += 1;
        return jsonResponse(enrollmentReceipt());
      },
    }),
    isClientError("preference_ineligible"),
  );
  assert.equal(networkCalls, 1);
});

test("a pre-aborted signal prevents preference, capability, and network work", async () => {
  const controller = new AbortController();
  controller.abort();
  let preferenceCalls = 0;
  let capabilityCalls = 0;
  let networkCalls = 0;
  await assert.rejects(
    enrollAccountlessContribution({
      origin: ORIGIN,
      readPreference: async () => {
        preferenceCalls += 1;
        return preference();
      },
      signal: controller.signal,
      now: () => NOW,
      ensureCapability: async () => {
        capabilityCalls += 1;
        return capability();
      },
      fetchImpl: async () => {
        networkCalls += 1;
        return jsonResponse(enrollmentReceipt());
      },
    }),
    isClientError("service_unavailable"),
  );
  assert.equal(preferenceCalls, 0);
  assert.equal(capabilityCalls, 0);
  assert.equal(networkCalls, 0);
});

test("a timeout aborts the request and performs no implicit retry or new enrollment", async () => {
  let capabilityCalls = 0;
  let networkCalls = 0;
  let requestAborted = false;
  await assert.rejects(
    enrollAccountlessContribution({
      origin: ORIGIN,
      readPreference: async () => preference(),
      now: () => NOW,
      requestTimeoutMilliseconds: 10,
      ensureCapability: async () => {
        capabilityCalls += 1;
        return capability();
      },
      fetchImpl: async (_url, { signal }) => {
        networkCalls += 1;
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            requestAborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        });
      },
    }),
    isClientError("service_unavailable", { retryable: true }),
  );
  assert.equal(capabilityCalls, 1);
  assert.equal(networkCalls, 1);
  assert.equal(requestAborted, true);
});

test("a deadline cancels a response body that has not produced its next chunk", async () => {
  let bodyCanceled = false;
  await assert.rejects(
    enrollAccountlessContribution({
      origin: ORIGIN,
      readPreference: async () => preference(),
      now: () => NOW,
      requestTimeoutMilliseconds: 10,
      ensureCapability: async () => capability(),
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() {
          bodyCanceled = true;
        },
      }), {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        },
      }),
    }),
    isClientError("service_unavailable", { retryable: true }),
  );
  assert.equal(bodyCanceled, true);
});

test("oversize and malformed receipts fail closed", async () => {
  let canceled = false;
  await assert.rejects(
    enrollAccountlessContribution({
      origin: ORIGIN,
      readPreference: async () => preference(),
      now: () => NOW,
      ensureCapability: async () => capability(),
      fetchImpl: async () => streamResponse([
        new TextEncoder().encode("x".repeat(16_000)),
        new TextEncoder().encode("x".repeat(500)),
      ], () => { canceled = true; }, { closeWhenDone: false }),
    }),
    isClientError("response_invalid"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(canceled, true);

  await assert.rejects(
    enrollAccountlessContribution({
      origin: ORIGIN,
      readPreference: async () => preference(),
      now: () => NOW,
      ensureCapability: async () => capability(),
      fetchImpl: async () => jsonResponse({
        ...enrollmentReceipt(),
        unexpected: "field",
      }),
    }),
    isClientError("response_invalid"),
  );

  await assert.rejects(
    enrollAccountlessContribution({
      origin: ORIGIN,
      readPreference: async () => preference(),
      now: () => NOW,
      ensureCapability: async () => capability(),
      fetchImpl: async () => jsonResponse({
        ...enrollmentReceipt(),
        deviceId: "22222222-2222-4222-8222-222222222222",
      }),
    }),
    isClientError("response_invalid"),
  );
});

test("expired and overlong leases are rejected even when otherwise well formed", async () => {
  for (const expiresAt of [
    "2026-09-03T23:59:59.000Z",
    "2026-10-04T00:06:00.000Z",
  ]) {
    await assert.rejects(
      enrollAccountlessContribution({
        origin: ORIGIN,
        readPreference: async () => preference(),
        now: () => NOW,
        ensureCapability: async () => capability(),
        fetchImpl: async () => jsonResponse(enrollmentReceipt({ expiresAt })),
      }),
      isClientError("response_invalid"),
    );
  }
});

test("a revoked device response is terminal and does not trigger a second enrollment", async () => {
  let networkCalls = 0;
  await assert.rejects(
    enrollAccountlessContribution({
      origin: ORIGIN,
      readPreference: async () => preference(),
      now: () => NOW,
      ensureCapability: async () => capability(),
      fetchImpl: async () => {
        networkCalls += 1;
        return jsonResponse({ error: { code: "DEVICE_REVOKED" } }, 403);
      },
    }),
    isClientError("device_unavailable"),
  );
  assert.equal(networkCalls, 1);
});

test("a server rejection is surfaced once without automatic retry", async () => {
  let networkCalls = 0;
  await assert.rejects(
    enrollAccountlessContribution({
      origin: ORIGIN,
      readPreference: async () => preference(),
      now: () => NOW,
      ensureCapability: async () => capability(),
      fetchImpl: async () => {
        networkCalls += 1;
        return jsonResponse({ error: { code: "TEMPORARY_FAILURE" } }, 503);
      },
    }),
    isClientError("service_unavailable", { retryable: true }),
  );
  assert.equal(networkCalls, 1);
});

test("missing secure capability state fails once without an enrollment attempt", async () => {
  let capabilityCalls = 0;
  let networkCalls = 0;
  await assert.rejects(
    enrollAccountlessContribution({
      origin: ORIGIN,
      readPreference: async () => preference(),
      now: () => NOW,
      ensureCapability: async () => {
        capabilityCalls += 1;
        throw new Error("secure state unavailable");
      },
      fetchImpl: async () => {
        networkCalls += 1;
        return jsonResponse(enrollmentReceipt());
      },
    }),
    isClientError("credential_unavailable"),
  );
  assert.equal(capabilityCalls, 1);
  assert.equal(networkCalls, 0);
});

test("a fixed credential recovery requirement blocks enrollment without transport", async () => {
  let networkCalls = 0;
  await assert.rejects(
    enrollAccountlessContribution({
      origin: ORIGIN,
      readPreference: async () => preference(),
      now: () => NOW,
      ensureCapability: async () => {
        throw Object.assign(new Error("private legacy record"), {
          code: "contribution_device_credential_recovery_required",
          retryable: false,
        });
      },
      fetchImpl: async () => { networkCalls += 1; return jsonResponse(enrollmentReceipt()); },
    }),
    isClientError("credential_recovery_required", { retryable: false }),
  );
  assert.equal(networkCalls, 0);
});

test("the accountless runner retries only explicit temporary credential availability", async () => {
  let networkCalls = 0;
  const transient = Object.assign(new Error("temporary protected credential unavailable"), {
    code: "contribution_device_credential_unavailable",
    retryable: true,
  });
  const result = await runAccountlessContributionSyncOnce({
    laboratory: true,
    origin: LABORATORY_ORIGIN,
    indexFile: "/synthetic/index.sqlite",
    backend: { laboratory: true },
    now: () => NOW,
    readPreference: async () => preference({ destinationOrigin: LABORATORY_ORIGIN }),
    ensureCapability: async () => { throw transient; },
    fetchImpl: async () => { networkCalls += 1; return jsonResponse(enrollmentReceipt()); },
  });
  assert.equal(networkCalls, 0);
  assert.deepEqual(result.failure, {
    code: "credential_unavailable",
    retryable: true,
    deviceUnavailable: false,
    retryAfterMilliseconds: null,
  });

  const malformed = await runAccountlessContributionSyncOnce({
    laboratory: true,
    origin: LABORATORY_ORIGIN,
    indexFile: "/synthetic/index.sqlite",
    backend: { laboratory: true },
    now: () => NOW,
    readPreference: async () => preference({ destinationOrigin: LABORATORY_ORIGIN }),
    ensureCapability: async () => ({ ...capability({ origin: LABORATORY_ORIGIN }), deviceId: "not-a-device-id" }),
    fetchImpl: async () => assert.fail("a malformed capability must not reach transport"),
  });
  assert.deepEqual(malformed.failure, {
    code: "credential_unavailable",
    retryable: false,
    deviceUnavailable: false,
    retryAfterMilliseconds: null,
  });
});

test("the accountless runner retries an explicitly unavailable private credential channel", async () => {
  let networkCalls = 0;
  const result = await runAccountlessContributionSyncOnce({
    laboratory: true,
    origin: LABORATORY_ORIGIN,
    indexFile: "/synthetic/index.sqlite",
    backend: { laboratory: true },
    now: () => NOW,
    readPreference: async () => preference({ destinationOrigin: LABORATORY_ORIGIN }),
    enroll: async () => Object.freeze({ status: "existing" }),
    withDeviceSecret: async () => {
      throw Object.assign(new Error("temporary private channel unavailable"), {
        code: "contribution_device_credential_unavailable",
        retryable: true,
      });
    },
    fetchImpl: async () => { networkCalls += 1; return jsonResponse(ownershipReceipt()); },
    runIncrementalSync: async () => assert.fail("a failed credential lease must not enter incremental upload"),
  });
  assert.equal(networkCalls, 0);
  assert.deepEqual(result.failure, {
    code: "credential_unavailable",
    retryable: true,
    deviceUnavailable: false,
    retryAfterMilliseconds: null,
  });
});

test("laboratory ownership sends the fixed policy record under a leased device credential", async () => {
  const calls = [];
  let secretObserved = null;
  const result = await claimAccountlessContributionOwnership({
    laboratory: true,
    origin: LABORATORY_ORIGIN,
    readPreference: async () => preference({ destinationOrigin: LABORATORY_ORIGIN }),
    backend: { laboratory: true },
    now: () => NOW,
    withDeviceSecret: laboratoryLease({ onSecret: (secret) => { secretObserved = secret; } }),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse(ownershipReceipt());
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${LABORATORY_ORIGIN}/api/v1/accountless/ownership`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(calls[0].options.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Device um_device_${DEVICE_ID}.${Buffer.alloc(32, 7).toString("base64url")}`,
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
    policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
    telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  });
  assert.deepEqual(result, {
    status: "created",
    origin: LABORATORY_ORIGIN,
    deviceId: DEVICE_ID,
    scope: "upload_registration",
    expiresAt: EXPIRES_AT,
  });
  assert.equal(Object.hasOwn(result, "authorization"), false);
  assert.equal(Object.hasOwn(result, "token"), false);
  assert.equal(Object.hasOwn(result, "secret"), false);
  assert.equal(Object.isFrozen(result), true);
  assert.ok(secretObserved?.every((value) => value === 0), "the test lease was zeroized after the request");
});

test("a mismatched ownership device receipt cannot enter the v1.1 runner", async () => {
  let enrollmentCalls = 0;
  let syncCalls = 0;
  const result = await runAccountlessContributionSyncOnce({
    laboratory: true,
    origin: LABORATORY_ORIGIN,
    indexFile: "/synthetic/index.sqlite",
    backend: { laboratory: true },
    now: () => NOW,
    readPreference: async () => preference({ destinationOrigin: LABORATORY_ORIGIN }),
    enroll: async () => {
      enrollmentCalls += 1;
      return Object.freeze({ status: "existing" });
    },
    withDeviceSecret: laboratoryLease(),
    fetchImpl: async () => jsonResponse(ownershipReceipt({
      deviceId: "22222222-2222-4222-8222-222222222222",
    })),
    runIncrementalSync: async () => {
      syncCalls += 1;
      return Object.freeze({ status: "complete", chunksUploaded: 0 });
    },
  });

  assert.equal(enrollmentCalls, 1);
  assert.equal(syncCalls, 0);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.failure, {
    code: "response_invalid",
    retryable: false,
    deviceUnavailable: false,
    retryAfterMilliseconds: null,
  });
  assert.equal(Object.hasOwn(result, "receipt"), false);
});

test("ownership is loopback laboratory-only before preference, credential, or network work", async () => {
  for (const { laboratory, origin } of [
    { laboratory: false, origin: LABORATORY_ORIGIN },
    { laboratory: true, origin: ORIGIN },
    { laboratory: true, origin: "http://localhost:8787" },
  ]) {
    let preferenceCalls = 0;
    let leaseCalls = 0;
    let networkCalls = 0;
    await assert.rejects(claimAccountlessContributionOwnership({
      laboratory,
      origin,
      readPreference: async () => { preferenceCalls += 1; return preference({ destinationOrigin: origin }); },
      backend: { laboratory: true },
      now: () => NOW,
      withDeviceSecret: async () => { leaseCalls += 1; },
      fetchImpl: async () => { networkCalls += 1; return jsonResponse(ownershipReceipt()); },
    }), isClientError("invalid_configuration"));
    assert.equal(preferenceCalls, 0);
    assert.equal(leaseCalls, 0);
    assert.equal(networkCalls, 0);
  }
});

test("ownership retries only through a later pass and terminal policy loss disables the device", async () => {
  for (const { response, code, retryable } of [
    { response: jsonResponse({ error: { code: "TEMPORARY_FAILURE" } }, 503), code: "service_unavailable", retryable: true },
    { response: jsonResponse({ error: { code: "ACCOUNTLESS_OWNERSHIP_REVOKED" } }, 403), code: "device_unavailable", retryable: false },
    { response: jsonResponse({ error: { code: "ACCOUNTLESS_POLICY_MISMATCH" } }, 409), code: "ownership_rejected", retryable: false },
  ]) {
    let networkCalls = 0;
    await assert.rejects(claimAccountlessContributionOwnership({
      laboratory: true,
      origin: LABORATORY_ORIGIN,
      readPreference: async () => preference({ destinationOrigin: LABORATORY_ORIGIN }),
      backend: { laboratory: true },
      now: () => NOW,
      withDeviceSecret: laboratoryLease(),
      fetchImpl: async () => { networkCalls += 1; return response; },
    }), isClientError(code, { retryable }));
    assert.equal(networkCalls, 1);
  }
});

test("ownership rechecks an opt-out before its leased request and withholds its receipt", async () => {
  const snapshots = [
    preference({ destinationOrigin: LABORATORY_ORIGIN }),
    preference({ destinationOrigin: LABORATORY_ORIGIN, enabled: false, basis: "default_off" }),
  ];
  let networkCalls = 0;
  await assert.rejects(claimAccountlessContributionOwnership({
    laboratory: true,
    origin: LABORATORY_ORIGIN,
    readPreference: async () => snapshots.shift() ?? snapshots.at(-1),
    backend: { laboratory: true },
    now: () => NOW,
    withDeviceSecret: laboratoryLease(),
    fetchImpl: async () => { networkCalls += 1; return jsonResponse(ownershipReceipt()); },
  }), isClientError("preference_ineligible"));
  assert.equal(networkCalls, 0);
});

test("the accountless runner carries only versioned policy authorization into v1.1 and fences every request", async () => {
  const calls = [];
  const order = [];
  let preferenceReads = 0;
  const result = await runAccountlessContributionSyncOnce({
    laboratory: true,
    origin: LABORATORY_ORIGIN,
    indexFile: "/synthetic/index.sqlite",
    backend: { laboratory: true },
    now: () => NOW,
    readPreference: async () => {
      preferenceReads += 1;
      return preference({ destinationOrigin: LABORATORY_ORIGIN });
    },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse({ ok: true });
    },
    enroll: async (options) => {
      order.push("enroll");
      await options.fetchImpl(`${LABORATORY_ORIGIN}/api/v1/accountless/enrollment`);
      return Object.freeze({ status: "enrolled" });
    },
    claimOwnership: async (options) => {
      order.push("ownership");
      assert.equal(options.laboratory, true);
      assert.equal(options.rehearsal, false);
      await options.fetchImpl(`${LABORATORY_ORIGIN}/api/v1/accountless/ownership`);
      return Object.freeze({ status: "created" });
    },
    runIncrementalSync: async (options) => {
      order.push("sync");
      assert.equal(options.laboratory, true);
      assert.equal(options.rehearsal, false);
      assert.equal(Object.hasOwn(options, "consent"), false);
      assert.deepEqual(options.authorization, {
        schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
        policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
        authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
        telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
      });
      await options.fetchImpl(`${LABORATORY_ORIGIN}/api/v1/device/sync-capabilities`);
      return Object.freeze({
        schemaVersion: "incremental-contribution-sync-run-v1.0",
        status: "complete",
        daysSynced: 1,
        chunksAccepted: 1,
        networkActivity: true,
        failure: null,
      });
    },
  });

  assert.deepEqual(order, ["enroll", "ownership", "sync"]);
  assert.deepEqual(calls, [
    `${LABORATORY_ORIGIN}/api/v1/accountless/enrollment`,
    `${LABORATORY_ORIGIN}/api/v1/accountless/ownership`,
    `${LABORATORY_ORIGIN}/api/v1/device/sync-capabilities`,
  ]);
  assert.ok(preferenceReads >= 7, "preference is read around phases and each actual request");
  assert.equal(result.status, "complete");
  assert.equal(result.networkActivity, true);
  assert.equal(Object.hasOwn(result, "receipt"), false);
});

test("the accountless runner cancels after enrollment and preserves the durable opt-out", async () => {
  let enabled = true;
  let ownershipCalls = 0;
  let syncCalls = 0;
  const result = await runAccountlessContributionSyncOnce({
    laboratory: true,
    origin: LABORATORY_ORIGIN,
    indexFile: "/synthetic/index.sqlite",
    backend: { laboratory: true },
    now: () => NOW,
    readPreference: async () => preference({
      destinationOrigin: LABORATORY_ORIGIN,
      enabled,
      basis: enabled ? "default_on" : "default_off",
    }),
    enroll: async () => { enabled = false; return Object.freeze({ status: "enrolled" }); },
    claimOwnership: async () => { ownershipCalls += 1; },
    runIncrementalSync: async () => { syncCalls += 1; },
  });
  assert.equal(ownershipCalls, 0);
  assert.equal(syncCalls, 0);
  assert.deepEqual(result.failure, {
    code: "preference_ineligible",
    retryable: false,
    deviceUnavailable: false,
    retryAfterMilliseconds: null,
  });
});

test("production accountless ownership requires the exact reviewed origin and explicit mode", async () => {
  const origin = "https://tibotattle.com";
  let reads = 0;
  let calls = 0;
  const options = {
    origin, production: true, backend: {}, now: () => NOW,
    readPreference: async () => { reads++; return preference({ destinationOrigin: origin }); },
    withDeviceSecret: async ({ expectedOrigin, operation }) => {
      assert.equal(expectedOrigin, origin);
      const secret = Buffer.alloc(32, 7);
      try { return await operation(secret, { origin, deviceId: DEVICE_ID }); }
      finally { secret.fill(0); }
    },
    fetchImpl: async (url, request) => {
      calls++;
      assert.equal(String(url), `${origin}/api/v1/accountless/ownership`);
      assert.equal(request.redirect, "error");
      assert.equal(request.credentials, "omit");
      return jsonResponse(ownershipReceipt());
    },
  };
  for (const override of [
    { production: false }, { laboratory: true }, { rehearsal: true }, { production: "true" },
    { origin: "https://other.example" }, { origin: "http://127.0.0.1:8787" },
  ]) await assert.rejects(claimAccountlessContributionOwnership({ ...options, ...override }),
    isClientError("invalid_configuration"));
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  const receipt = await claimAccountlessContributionOwnership(options);
  assert.equal(receipt.deviceId, DEVICE_ID);
  assert.equal(calls, 1);
  await assert.rejects(claimAccountlessContributionOwnership({ ...options,
    readPreference: async () => preference({ destinationOrigin: origin, enabled: false }),
  }), isClientError("preference_ineligible"));
  assert.equal(calls, 1, "persistent opt-out prevents production network work");
});

test("rehearsal accountless ownership requires the fixed staging origin and explicit mode", async () => {
  const origin = REHEARSAL_ORIGIN;
  let reads = 0;
  let calls = 0;
  const options = {
    origin, rehearsal: true, backend: {}, now: () => NOW,
    readPreference: async () => { reads++; return preference({ destinationOrigin: origin }); },
    withDeviceSecret: async ({ expectedOrigin, operation }) => {
      assert.equal(expectedOrigin, origin);
      const secret = Buffer.alloc(32, 7);
      try { return await operation(secret, { origin, deviceId: DEVICE_ID }); }
      finally { secret.fill(0); }
    },
    fetchImpl: async (url, request) => {
      calls++;
      assert.equal(String(url), `${origin}/api/v1/accountless/ownership`);
      assert.equal(request.redirect, "error");
      assert.equal(request.credentials, "omit");
      return jsonResponse(ownershipReceipt());
    },
  };
  for (const override of [
    { rehearsal: false }, { laboratory: true }, { production: true },
    { rehearsal: "true" }, { origin: "https://tibotattle.com" },
    { origin: "http://127.0.0.1:8787" },
  ]) await assert.rejects(claimAccountlessContributionOwnership({ ...options, ...override }),
    isClientError("invalid_configuration"));
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  const receipt = await claimAccountlessContributionOwnership(options);
  assert.equal(receipt.deviceId, DEVICE_ID);
  assert.equal(calls, 1);
});

test("production selection survives the accountless runner into the existing v1.1 pipeline", async () => {
  const origin = "https://tibotattle.com";
  const order = [];
  const result = await runAccountlessContributionSyncOnce({
    origin, production: true, backend: {}, indexFile: "/synthetic/index.sqlite",
    readPreference: async () => preference({ destinationOrigin: origin }),
    enroll: async () => { order.push("enroll"); },
    claimOwnership: async (options) => {
      order.push("ownership");
      assert.equal(options.production, true);
      assert.equal(options.laboratory, false);
      assert.equal(options.rehearsal, false);
    },
    runIncrementalSync: async (options) => {
      order.push("sync");
      assert.equal(options.production, true);
      assert.equal(options.laboratory, false);
      assert.equal(options.rehearsal, false);
      assert.equal(Object.hasOwn(options, "consent"), false);
      return { status: "complete", chunksUploaded: 1 };
    },
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(order, ["enroll", "ownership", "sync"]);
});

test("rehearsal selection reaches the existing v1.1 pipeline without opening another lane", async () => {
  const origin = REHEARSAL_ORIGIN;
  const order = [];
  const result = await runAccountlessContributionSyncOnce({
    origin, rehearsal: true, backend: {}, indexFile: "/synthetic/index.sqlite",
    readPreference: async () => preference({ destinationOrigin: origin }),
    enroll: async () => { order.push("enroll"); },
    claimOwnership: async (options) => {
      order.push("ownership");
      assert.equal(options.rehearsal, true);
      assert.equal(options.laboratory, false);
      assert.equal(options.production, false);
    },
    runIncrementalSync: async (options) => {
      order.push("sync");
      assert.equal(options.rehearsal, true);
      assert.equal(options.laboratory, false);
      assert.equal(options.production, false);
      assert.equal(Object.hasOwn(options, "consent"), false);
      return { status: "complete", chunksUploaded: 1 };
    },
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(order, ["enroll", "ownership", "sync"]);
});

function renewalReceipt(overrides = {}) {
  return { ...ownershipReceipt(), schemaVersion: ACCOUNTLESS_RENEWAL_SCHEMA_VERSION,
    state: "renewed", renewalGeneration: 1, ...overrides };
}

function renewalRunnerOptions(overrides = {}) {
  return {
    laboratory: true, origin: LABORATORY_ORIGIN,
    indexFile: "/synthetic/index.sqlite", backend: { laboratory: true },
    now: () => NOW,
    readPreference: async () => preference({ destinationOrigin: LABORATORY_ORIGIN }),
    ensureCapability: async () => capability({ origin: LABORATORY_ORIGIN }),
    withDeviceSecret: laboratoryLease(),
    runIncrementalSync: async () => Object.freeze({ status: "complete", chunksUploaded: 0 }),
    ...overrides,
  };
}

test("renewal proves the same held secret with a closed body and zeroizes the lease", async () => {
  let observedSecret;
  let calls = 0;
  const result = await renewAccountlessContributionOwnership(renewalRunnerOptions({
    withDeviceSecret: laboratoryLease({ onSecret: (value) => { observedSecret = value; } }),
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(String(url), `${LABORATORY_ORIGIN}/api/v1/accountless/renewal`);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization,
        `Device um_device_${DEVICE_ID}.${Buffer.alloc(32, 7).toString("base64url")}`);
      assert.deepEqual(JSON.parse(options.body), {
        schemaVersion: ACCOUNTLESS_RENEWAL_SCHEMA_VERSION,
        policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
        authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
        telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
      });
      return jsonResponse(renewalReceipt());
    },
  }));
  assert.equal(calls, 1);
  assert.equal(result.deviceId, DEVICE_ID);
  assert.equal(result.renewalGeneration, 1);
  assert.equal(result.expiresAt, EXPIRES_AT);
  assert.ok(observedSecret.every((value) => value === 0));
});

test("renewal rejects foreign, expired, overlong and malformed generation receipts", async () => {
  for (const changes of [
    { deviceId: "22222222-2222-4222-8222-222222222222" },
    { expiresAt: new Date(NOW - 1).toISOString() },
    { expiresAt: new Date(NOW + 31 * 86_400_000).toISOString() },
    { renewalGeneration: -1 }, { renewalGeneration: 2_147_483_648 },
    { renewalGeneration: 1.5 }, { renewalGeneration: "1" },
    { state: "created" }, { extra: true }, { policyVersion: "obsolete" },
  ]) {
    await assert.rejects(renewAccountlessContributionOwnership(renewalRunnerOptions({
      fetchImpl: async () => jsonResponse(renewalReceipt(changes)),
    })), isClientError("response_invalid"));
  }
});

test("an active installation renews within seven days without re-enrollment or identity rotation", async () => {
  const requests = [];
  let ensured = 0;
  const result = await runAccountlessContributionSyncOnce(renewalRunnerOptions({
    ensureCapability: async () => { ensured += 1; return capability({ origin: LABORATORY_ORIGIN }); },
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      requests.push(pathname);
      if (pathname.endsWith("/enrollment")) return jsonResponse(enrollmentReceipt());
      if (pathname.endsWith("/ownership")) return jsonResponse(ownershipReceipt({
        expiresAt: new Date(NOW + 7 * 86_400_000).toISOString(), state: "existing",
      }));
      assert.ok(pathname.endsWith("/renewal"));
      return jsonResponse(renewalReceipt());
    },
    runIncrementalSync: async () => { requests.push("sync"); return { status: "complete", chunksUploaded: 0 }; },
  }));
  assert.equal(result.status, "complete");
  assert.equal(ensured, 1);
  assert.deepEqual(requests, ["/api/v1/accountless/enrollment", "/api/v1/accountless/ownership",
    "/api/v1/accountless/renewal", "sync"]);
});

test("an expired enrollment renews the held owner once before ownership and upload", async () => {
  const requests = [];
  let ensured = 0;
  const result = await runAccountlessContributionSyncOnce(renewalRunnerOptions({
    ensureCapability: async () => { ensured += 1; return capability({ origin: LABORATORY_ORIGIN }); },
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      requests.push(pathname);
      if (pathname.endsWith("/enrollment")) return jsonResponse({ error: { code: "ACCOUNTLESS_ENROLLMENT_EXPIRED" } }, 410);
      if (pathname.endsWith("/renewal")) return jsonResponse(renewalReceipt());
      assert.ok(pathname.endsWith("/ownership"));
      return jsonResponse(ownershipReceipt({ state: "existing" }));
    },
    runIncrementalSync: async () => { requests.push("sync"); return { status: "complete", chunksUploaded: 0 }; },
  }));
  assert.equal(result.status, "complete");
  assert.equal(ensured, 1);
  assert.deepEqual(requests, ["/api/v1/accountless/enrollment", "/api/v1/accountless/renewal",
    "/api/v1/accountless/ownership", "sync"]);
});

test("revocation and non-expiry failures never invoke renewal or upload", async () => {
  for (const [status, code] of [[401, "ACCOUNTLESS_ENROLLMENT_REVOKED"],
    [410, "ACCOUNTLESS_OWNERSHIP_EXPIRED"], [403, "ACCOUNTLESS_ENROLLMENT_EXPIRED"],
    [409, "BODY_INVALID"], [503, "BACKEND_STORAGE_UNAVAILABLE"]]) {
    let requests = 0;
    const result = await runAccountlessContributionSyncOnce(renewalRunnerOptions({
      fetchImpl: async (url) => {
        requests += 1;
        assert.ok(String(url).endsWith("/enrollment"));
        return jsonResponse({ error: { code } }, status);
      },
      renewOwnership: async () => assert.fail("Only exact enrollment expiry can reach renewal"),
      runIncrementalSync: async () => assert.fail("A failed enrollment cannot upload"),
    }));
    assert.equal(result.status, "failed");
    assert.equal(requests, 1);
  }
});

test("opt-out after renewal fences ownership and upload without another request", async () => {
  let enabled = true;
  let calls = 0;
  const result = await runAccountlessContributionSyncOnce(renewalRunnerOptions({
    readPreference: async () => preference({ destinationOrigin: LABORATORY_ORIGIN, enabled }),
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).endsWith("/enrollment")) return jsonResponse({ error: { code: "ACCOUNTLESS_ENROLLMENT_EXPIRED" } }, 410);
      assert.ok(String(url).endsWith("/renewal"));
      enabled = false;
      return jsonResponse(renewalReceipt());
    },
    runIncrementalSync: async () => assert.fail("Opt-out during renewal cannot upload"),
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "preference_ineligible");
  assert.equal(calls, 2);
});

test("expiry between enrollment and ownership gets one authenticated recovery attempt", async () => {
  for (const recover of [true, false]) {
    const requests = [];
    let ownershipCalls = 0;
    const result = await runAccountlessContributionSyncOnce(renewalRunnerOptions({
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        requests.push(pathname);
        if (pathname.endsWith("/enrollment")) return jsonResponse(enrollmentReceipt());
        if (pathname.endsWith("/renewal")) return jsonResponse(renewalReceipt());
        assert.ok(pathname.endsWith("/ownership"));
        ownershipCalls += 1;
        return recover && ownershipCalls > 1
          ? jsonResponse(ownershipReceipt({ state: "existing" }))
          : jsonResponse({ error: { code: "ACCOUNTLESS_OWNERSHIP_EXPIRED" } }, 410);
      },
      runIncrementalSync: async () => { requests.push("sync"); return { status: "complete", chunksUploaded: 0 }; },
    }));
    assert.equal(result.status, recover ? "complete" : "failed");
    assert.equal(ownershipCalls, 2);
    assert.deepEqual(requests, ["/api/v1/accountless/enrollment", "/api/v1/accountless/ownership",
      "/api/v1/accountless/renewal", "/api/v1/accountless/ownership", ...(recover ? ["sync"] : [])]);
  }
});
