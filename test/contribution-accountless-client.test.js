import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
  ContributionAccountlessClientError,
  enrollAccountlessContribution,
} from "../src/contribution-accountless-client.js";

const ORIGIN = "https://usage.example";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_SECRET_HASH = "a".repeat(64);
const EXPIRES_AT = "2026-09-10T00:00:00.000Z";
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
