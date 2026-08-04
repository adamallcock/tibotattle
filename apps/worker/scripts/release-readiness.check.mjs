import assert from "node:assert/strict";
import test from "node:test";
import {
  DEPLOYMENT_ENDPOINTS,
} from "../../../config/deployment-endpoints.js";
import {
  RELEASE_READINESS_SCHEMA_VERSION,
  verifyReleaseReadiness,
} from "./release-readiness-lib.mjs";
import {
  parseReleaseReadinessArguments,
  runReleaseReadinessCLI,
} from "./release-readiness.mjs";

const HEALTH = {
  status: "ok",
  enrollmentMode: "disabled",
  collectionControls: {
    state: "contained",
    enrollment: false,
    uploadRegistration: false,
    processing: false,
    publication: false,
  },
  contracts: {
    accountScopedContribution: {
      externalParticipantsAuthorized: false,
    },
  },
};
const READY = {
  status: "ready",
  checks: {
    lifecycleFresh: true,
    quarantineRetentionComplete: true,
    restoreReplayComplete: true,
    aggregateRebuildComplete: true,
    maintenanceCycleMatched: true,
    quarantineReconciliationComplete: true,
  },
  policy: {
    lifecycleStaleAfterMilliseconds: 2 * 60 * 60 * 1000,
  },
};
const NOT_READY = {
  ...READY,
  status: "not_ready",
  checks: {
    ...READY.checks,
    lifecycleFresh: false,
  },
};
const APPCAST_SIGNATURE = Buffer.alloc(64, 7).toString("base64");
const APPCAST = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <item>
      <enclosure url="https://updates.tibotattle.com/releases/1/TiboTattle.dmg"
        length="123" sparkle:version="1"
        sparkle:edSignature="${APPCAST_SIGNATURE}" />
    </item>
  </channel>
</rss>`;
const SECRET = "private-jwk-value-must-not-escape";

function jsonResponse(value, status = 200, contentType = "application/json") {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": contentType },
  });
}

function appcastResponse(status = 200, body = APPCAST) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}

function endpointConsumerCheck() {
  return Promise.resolve({ checked: true });
}

function fixedClock() {
  return {
    now: () => 1_000,
    setTimeout: (callback) => {
      const timer = setTimeout(callback, 0);
      timer.unref?.();
      return timer;
    },
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

function allHealthyFetch(calls) {
  return async (url, options) => {
    calls.push({ options, url: String(url) });
    if (String(url).endsWith("/api/health")) return jsonResponse(HEALTH);
    if (String(url).endsWith("/api/ready")) return jsonResponse(READY);
    assert.equal(String(url), DEPLOYMENT_ENDPOINTS.sparkle.appcastURL);
    return appcastResponse();
  };
}

test("manifest-only verification is read-only and does not call fetch", async () => {
  let fetchCalls = 0;
  const result = await verifyReleaseReadiness({
    endpointConsumerCheck,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("network must not be called");
    },
    clock: fixedClock(),
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.schemaVersion, RELEASE_READINESS_SCHEMA_VERSION);
  assert.equal(result.status, "public_unchecked");
  assert.equal(result.ready, false);
  assert.equal(result.public.requested, false);
  assert.equal(result.public.health.status, "not_checked");
  assert.equal(result.deploymentDrift.status, "no_drift");
  assert.equal(result.collectionAuthorized, false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("canonical endpoint drift fails closed without probing or echoing drifted values", async () => {
  const endpoints = structuredClone(DEPLOYMENT_ENDPOINTS);
  endpoints.public.origin = "https://other.example.test";
  endpoints.public.routeHosts = [
    "other.example.test",
    "www.other.example.test",
  ];
  let fetchCalls = 0;
  const result = await verifyReleaseReadiness({
    endpoints,
    endpointConsumerCheck,
    probePublic: true,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("network must not be called");
    },
    clock: fixedClock(),
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.status, "blocked");
  assert.equal(result.endpointManifest.status, "invalid");
  assert.equal(result.endpointManifest.code, "ENDPOINT_MANIFEST_DRIFT");
  assert.deepEqual(result.endpointManifest.routeHosts, []);
  assert.equal(result.blockers.includes("ENDPOINT_MANIFEST_DRIFT"), true);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("explicit public probing checks canonical health, ready, and appcast in order", async () => {
  const calls = [];
  const result = await verifyReleaseReadiness({
    endpointConsumerCheck,
    probePublic: true,
    fetchImpl: allHealthyFetch(calls),
    clock: fixedClock(),
  });
  assert.deepEqual(calls.map((call) => call.url), [
    `${DEPLOYMENT_ENDPOINTS.public.origin}/api/health`,
    `${DEPLOYMENT_ENDPOINTS.public.origin}/api/ready`,
    DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
  ]);
  assert.deepEqual(calls.map((call) => call.options.method), ["GET", "GET", "GET"]);
  assert.deepEqual(calls.map((call) => call.options.credentials), ["omit", "omit", "omit"]);
  assert.deepEqual(calls.map((call) => call.options.redirect), ["manual", "manual", "manual"]);
  assert.equal(Object.hasOwn(calls[0].options.headers, "authorization"), false);
  assert.equal(result.status, "ready");
  assert.equal(result.ready, true);
  assert.equal(result.public.health.status, "pass");
  assert.equal(result.public.ready.status, "pass");
  assert.equal(result.public.appcast.status, "pass");
  assert.equal(typeof result.public.appcast.sha256, "string");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("disabled enrollment is expected, while an open deployment is reported as drift", async () => {
  const openHealth = structuredClone(HEALTH);
  openHealth.enrollmentMode = "open";
  openHealth.collectionControls = {
    state: "operational",
    enrollment: true,
    uploadRegistration: true,
    processing: true,
    publication: true,
  };
  const result = await verifyReleaseReadiness({
    endpointConsumerCheck,
    probePublic: true,
    fetchImpl: async (url, options) => {
      assert.equal(options.credentials, "omit");
      if (String(url).endsWith("/api/health")) return jsonResponse(openHealth);
      if (String(url).endsWith("/api/ready")) return jsonResponse(READY);
      return appcastResponse();
    },
    clock: fixedClock(),
  });
  assert.equal(result.status, "not_ready");
  assert.equal(result.public.health.status, "drift");
  assert.deepEqual(result.public.health.codes, [
    "DEPLOYED_ENROLLMENT_MODE_DRIFT",
    "DEPLOYED_COLLECTION_CONTROLS_DRIFT",
  ]);
  assert.equal(result.blockers.includes("DEPLOYED_ENROLLMENT_MODE_DRIFT"), true);
  assert.equal(result.blockers.includes("DEPLOYED_COLLECTION_CONTROLS_DRIFT"), true);
});

test("a 404 appcast is explicitly not published and never ready", async () => {
  const result = await verifyReleaseReadiness({
    endpointConsumerCheck,
    probePublic: true,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/health")) return jsonResponse(HEALTH);
      if (String(url).endsWith("/api/ready")) return jsonResponse(READY);
      return appcastResponse(404, SECRET);
    },
    clock: fixedClock(),
  });
  assert.equal(result.status, "not_ready");
  assert.equal(result.public.appcast.status, "not_published");
  assert.equal(result.public.appcast.code, "APPCAST_NOT_PUBLISHED");
  assert.equal(result.public.appcast.httpStatus, 404);
  assert.equal(result.blockers.includes("APPCAST_NOT_PUBLISHED"), true);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("a structurally valid 503 ready response is reported as not ready", async () => {
  const result = await verifyReleaseReadiness({
    endpointConsumerCheck,
    probePublic: true,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/health")) return jsonResponse(HEALTH);
      if (String(url).endsWith("/api/ready")) return jsonResponse(NOT_READY, 503);
      return appcastResponse();
    },
    clock: fixedClock(),
  });
  assert.equal(result.status, "not_ready");
  assert.equal(result.public.ready.status, "not_ready");
  assert.equal(result.public.ready.code, "READY_NOT_READY");
  assert.equal(result.blockers.includes("READY_NOT_READY"), true);
});

test("bounded timeouts return fixed codes without leaking fetch errors", async () => {
  const timeoutClock = {
    now: () => 2_000,
    setTimeout: (callback) => {
      callback();
      return Symbol("timer");
    },
    clearTimeout: () => {},
  };
  const result = await verifyReleaseReadiness({
    endpointConsumerCheck,
    probePublic: true,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(new Error(SECRET));
      });
    }),
    clock: timeoutClock,
    timeoutMs: 10,
  });
  assert.equal(result.status, "not_ready");
  assert.equal(result.public.health.code, "HEALTH_TIMEOUT");
  assert.equal(result.public.ready.code, "READY_TIMEOUT");
  assert.equal(result.public.appcast.code, "APPCAST_TIMEOUT");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("CLI is offline by default and only fails the gate after an explicit live probe", async () => {
  assert.deepEqual(parseReleaseReadinessArguments([]), {
    help: false,
    probePublic: false,
    timeoutMs: 5_000,
  });
  assert.deepEqual(parseReleaseReadinessArguments([
    "--probe-public",
    "--timeout-ms",
    "2500",
  ]), {
    help: false,
    probePublic: true,
    timeoutMs: 2_500,
  });
  assert.throws(
    () => parseReleaseReadinessArguments(["--timeout-ms", "30001"]),
    { code: "RELEASE_READINESS_ARGUMENTS_INVALID" },
  );
  const output = [];
  const offline = await runReleaseReadinessCLI([], {
    stdout: { write: (value) => output.push(value) },
    stderr: { write: () => {} },
    verify: async (options) => verifyReleaseReadiness({
      ...options,
      endpointConsumerCheck,
      fetchImpl: async () => {
        throw new Error(SECRET);
      },
      clock: fixedClock(),
    }),
  });
  assert.equal(offline.exitCode, 0);
  assert.equal(output.some((value) => value.includes(SECRET)), false);
  assert.equal(output.some((value) => value.includes("public_unchecked")), true);
});
