import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { after, before, mock, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Drives the REAL src/admission.ts helpers through the origin's edge-admission
// replay bindings, with an origin IDENTITY_LINK_SECRET and no
// cf-connecting-ip, exactly as the Cloud Run origin runs them.

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(ROOT, "..");
const EDGE_POLICY_PATH = resolve(WORKER_ROOT, "src", "edge-admission-policy.ts");
const ORIGIN_IDENTITY_LINK_SECRET = "synthetic-origin-identity-link-secret-0000000000";
const ORIGIN_ENV = Object.freeze({
  ENVIRONMENT: "production",
  IDENTITY_LINK_SECRET: ORIGIN_IDENTITY_LINK_SECRET,
});
const REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a2b";
const HEX64 = "0123456789abcdef".repeat(4);
const BINDING_NAMES = Object.freeze([
  "ENROLLMENT_RATE_LIMIT",
  "RECOVERY_RATE_LIMIT",
  "CLIENT_ATTEMPT_RATE_LIMIT",
  "PUBLIC_READ_RATE_LIMIT",
  "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
  "UPLOAD_INGRESS_CLIENT_RATE_LIMIT",
]);
const ATTEMPT_PURPOSES = Object.freeze([
  "enrollment",
  "sign_in_start",
  "recovery",
  "device_disconnect",
  "device_credential_renew",
  "device_sync",
  "accountless_ownership",
  "accountless_renewal",
]);
const CONSOLE_METHODS = Object.freeze(["log", "info", "warn", "error", "debug", "trace"]);

let vite;
let limiters;
let admissionHelpers;
let errors;
let contract;
const consoleSpies = [];

before(async () => {
  for (const method of CONSOLE_METHODS) consoleSpies.push(mock.method(console, method));
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true, ws: false },
    appType: "custom",
    logLevel: "silent",
  });
  [limiters, admissionHelpers, errors, contract] = await Promise.all([
    vite.ssrLoadModule("/cloud-run/postgres-edge-admission-limiters.mjs"),
    vite.ssrLoadModule("/src/admission.ts"),
    vite.ssrLoadModule("/src/errors.ts"),
    vite.ssrLoadModule("/src/edge-origin-contract.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

/** The client key the helper derives at the origin: the 'unavailable' subject. */
function originClientKey(purpose) {
  const digest = createHmac("sha256", ORIGIN_IDENTITY_LINK_SECRET)
    .update(`app-usagemonitor/rate-limit/v1\0${purpose}\0unavailable`)
    .digest("hex");
  return `usage-monitor:${purpose}:client:${digest}`;
}

function originRequest(headers = {}) {
  // No cf-connecting-ip unless a test adds one: the origin never receives it.
  return new Request("https://tibotattle.com/api/v1/example", { method: "POST", headers });
}

/** Pass-through spies that record which binding received which key. */
function spyBindings(bindings, calls) {
  return Object.fromEntries(BINDING_NAMES.map((name) => [name, {
    async limit(options) {
      calls.push({ name, key: options?.key });
      return bindings[name].limit(options);
    },
  }]));
}

function attemptCase(purpose, coarse) {
  return {
    label: `attempt ${purpose} via ${coarse}`,
    purpose,
    limitedCode: "ATTEMPT_LIMIT_REACHED",
    unavailableCode: "ADMISSION_RATE_LIMIT_UNAVAILABLE",
    expectedCalls: [
      { name: coarse, key: `usage-monitor:${purpose}:global` },
      { name: "CLIENT_ATTEMPT_RATE_LIMIT", key: originClientKey(purpose) },
    ],
    call: (bindings, request) => admissionHelpers.assertAttemptAllowed(
      bindings[coarse],
      bindings.CLIENT_ATTEMPT_RATE_LIMIT,
      request,
      ORIGIN_ENV,
      purpose,
    ),
  };
}

function uploadIngressCase() {
  return {
    label: "upload_ingress",
    purpose: "upload_ingress",
    limitedCode: "UPLOAD_INGRESS_LIMIT_REACHED",
    unavailableCode: "UPLOAD_INGRESS_UNAVAILABLE",
    expectedCalls: [
      { name: "UPLOAD_INGRESS_REQUEST_RATE_LIMIT", key: "usage-monitor:upload_ingress:global" },
      { name: "UPLOAD_INGRESS_CLIENT_RATE_LIMIT", key: originClientKey("upload_ingress") },
    ],
    call: (bindings, request) => admissionHelpers.assertUploadIngressRequestAllowed(
      bindings.UPLOAD_INGRESS_REQUEST_RATE_LIMIT,
      bindings.UPLOAD_INGRESS_CLIENT_RATE_LIMIT,
      request,
      ORIGIN_ENV,
    ),
  };
}

function publicReadCase() {
  return {
    label: "public_aggregate_read",
    purpose: "public_aggregate_read",
    limitedCode: "ATTEMPT_LIMIT_REACHED",
    unavailableCode: "ADMISSION_RATE_LIMIT_UNAVAILABLE",
    expectedCalls: [
      { name: "PUBLIC_READ_RATE_LIMIT", key: originClientKey("public_aggregate_read") },
    ],
    call: (bindings, request) => admissionHelpers.assertPublicAggregateReadAllowed(
      bindings.PUBLIC_READ_RATE_LIMIT,
      request,
      ORIGIN_ENV,
    ),
  };
}

function helperCases() {
  return [
    ...ATTEMPT_PURPOSES.map((purpose) => attemptCase(purpose, "ENROLLMENT_RATE_LIMIT")),
    ...ATTEMPT_PURPOSES.map((purpose) => attemptCase(purpose, "RECOVERY_RATE_LIMIT")),
    uploadIngressCase(),
    publicReadCase(),
  ];
}

async function settle(promise) {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    return { value: undefined, error };
  }
}

/** The Worker envelope for a helper failure, as index.ts's catch renders it. */
async function assertWorkerError(error, status, code) {
  assert.ok(error instanceof errors.ApiError, `expected ApiError ${code}, got ${error?.name}`);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  const response = errors.errorResponse(error, REQUEST_ID);
  assert.equal(response.status, status);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), { error: { code, requestId: REQUEST_ID } });
}

function assertReplayRefusal(error, code) {
  assert.ok(error instanceof Error, "a refusal is an Error");
  assert.equal(Object.getPrototypeOf(error), Error.prototype, "a refusal is a plain Error");
  assert.ok(!(error instanceof errors.ApiError), "a refusal is never an ApiError");
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.deepEqual(Object.keys(error), ["code"]);
}

async function directRefusal(binding, options) {
  const outcome = await settle(binding.limit(options));
  assert.equal(outcome.value, undefined, "a refused call never resolves");
  return outcome.error;
}

test("exports exactly the replay factory and the six edge-tier binding names", () => {
  assert.deepEqual(Object.keys(limiters).sort(), [
    "EDGE_ADMISSION_REPLAY_BINDINGS",
    "createEdgeAdmissionLimiters",
  ]);
  assert.deepEqual(limiters.EDGE_ADMISSION_REPLAY_BINDINGS, BINDING_NAMES);
  assert.ok(Object.isFrozen(limiters.EDGE_ADMISSION_REPLAY_BINDINGS));
  const instance = limiters.createEdgeAdmissionLimiters();
  assert.ok(Object.isFrozen(instance));
  assert.deepEqual(Object.keys(instance), ["bindings", "run"]);
  assert.ok(Object.isFrozen(instance.bindings));
  assert.deepEqual(Object.keys(instance.bindings), BINDING_NAMES);
  for (const name of BINDING_NAMES) {
    const binding = instance.bindings[name];
    assert.ok(Object.isFrozen(binding), name);
    assert.deepEqual(Object.keys(binding), ["limit"], name);
    assert.equal(typeof binding.limit, "function", name);
  }
  // Every contract purpose is replayable by exactly the bindings above.
  assert.deepEqual(
    [...ATTEMPT_PURPOSES, "public_aggregate_read", "upload_ingress"].sort(),
    [...contract.EDGE_ADMISSION_PURPOSES].sort(),
  );
});

test("the bindings answer the edge outcome directly: allowed, limited, unavailable", async () => {
  const { bindings, run } = limiters.createEdgeAdmissionLimiters();
  const coarse = { key: "usage-monitor:enrollment:global" };
  assert.deepEqual(
    await run({ purpose: "enrollment", outcome: "allowed" }, () => bindings.ENROLLMENT_RATE_LIMIT.limit(coarse)),
    { success: true },
  );
  assert.deepEqual(
    await run({ purpose: "enrollment", outcome: "limited" }, () => bindings.ENROLLMENT_RATE_LIMIT.limit(coarse)),
    { success: false },
  );
  const unavailable = await run(
    { purpose: "enrollment", outcome: "unavailable" },
    () => directRefusal(bindings.ENROLLMENT_RATE_LIMIT, coarse),
  );
  assertReplayRefusal(unavailable, "EDGE_ADMISSION_REPLAY_UNAVAILABLE");
  // A decoded (frozen) header value is accepted as is.
  const decoded = contract.decodeEdgeAdmission("v1;enrollment;allowed");
  assert.deepEqual(
    await run(decoded, () => bindings.ENROLLMENT_RATE_LIMIT.limit(coarse)),
    { success: true },
  );
});

test("real helpers replay allowed, limited and unavailable for every purpose", async () => {
  const { bindings, run } = limiters.createEdgeAdmissionLimiters();
  for (const helperCase of helperCases()) {
    const request = originRequest();

    const allowedCalls = [];
    const allowed = await run(
      { purpose: helperCase.purpose, outcome: "allowed" },
      () => settle(helperCase.call(spyBindings(bindings, allowedCalls), request)),
    );
    assert.equal(allowed.error, null, `${helperCase.label} allowed`);
    assert.deepEqual(allowedCalls, helperCase.expectedCalls, `${helperCase.label} allowed calls`);

    const limitedCalls = [];
    const limited = await run(
      { purpose: helperCase.purpose, outcome: "limited" },
      () => settle(helperCase.call(spyBindings(bindings, limitedCalls), request)),
    );
    await assertWorkerError(limited.error, 429, helperCase.limitedCode);
    assert.deepEqual(limitedCalls, helperCase.expectedCalls.slice(0, 1), `${helperCase.label} limited calls`);

    const unavailableCalls = [];
    const unavailable = await run(
      { purpose: helperCase.purpose, outcome: "unavailable" },
      () => settle(helperCase.call(spyBindings(bindings, unavailableCalls), request)),
    );
    await assertWorkerError(unavailable.error, 503, helperCase.unavailableCode);
    assert.deepEqual(unavailableCalls, helperCase.expectedCalls.slice(0, 1));
  }
});

test("the client segment is shape-checked only: the outcome comes from the edge", async () => {
  // The dispatch never forwards cf-connecting-ip. Even if one were present,
  // the replay would not depend on it: any HMAC subject has the same shape.
  const { bindings, run } = limiters.createEdgeAdmissionLimiters();
  const calls = [];
  const addressed = originRequest({ "cf-connecting-ip": "203.0.113.7" });
  const result = await run(
    { purpose: "device_sync", outcome: "allowed" },
    () => settle(admissionHelpers.assertAttemptAllowed(
      spyBindings(bindings, calls).RECOVERY_RATE_LIMIT,
      spyBindings(bindings, calls).CLIENT_ATTEMPT_RATE_LIMIT,
      addressed,
      ORIGIN_ENV,
      "device_sync",
    )),
  );
  assert.equal(result.error, null);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].key, originClientKey("device_sync"), "an address changes only the key");
  assert.match(calls[1].key, /^usage-monitor:device_sync:client:[0-9a-f]{64}$/u);
});

test("a missing store, a missing outcome and a purpose mismatch answer the helper's 503", async () => {
  const { bindings, run } = limiters.createEdgeAdmissionLimiters();
  const request = originRequest();
  const attempt = attemptCase("device_sync", "RECOVERY_RATE_LIMIT");
  const upload = uploadIngressCase();
  const publicRead = publicReadCase();

  // Outside any run(): no store.
  await assertWorkerError((await settle(attempt.call(bindings, request))).error, 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE");
  await assertWorkerError((await settle(upload.call(bindings, request))).error, 503, "UPLOAD_INGRESS_UNAVAILABLE");
  await assertWorkerError((await settle(publicRead.call(bindings, request))).error, 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE");

  // run(null): the edge sent no admission header.
  for (const helperCase of [attempt, upload, publicRead]) {
    const outcome = await run(null, () => settle(helperCase.call(bindings, request)));
    await assertWorkerError(outcome.error, 503, helperCase.unavailableCode);
  }

  // The divergence guard: a device_sync call under an upload_ingress outcome
  // (the v1.2 upload's former extra limiter) and the reverse.
  const deviceSyncUnderUpload = await run(
    { purpose: "upload_ingress", outcome: "allowed" },
    () => settle(attempt.call(bindings, request)),
  );
  await assertWorkerError(deviceSyncUnderUpload.error, 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE");
  const uploadUnderDeviceSync = await run(
    { purpose: "device_sync", outcome: "allowed" },
    () => settle(upload.call(bindings, request)),
  );
  await assertWorkerError(uploadUnderDeviceSync.error, 503, "UPLOAD_INGRESS_UNAVAILABLE");
  const publicReadUnderEnrollment = await run(
    { purpose: "enrollment", outcome: "allowed" },
    () => settle(publicRead.call(bindings, request)),
  );
  await assertWorkerError(publicReadUnderEnrollment.error, 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE");
  // A different attempt purpose on the right bindings is still a mismatch,
  // and so is a limited outcome for another purpose: never a 429.
  const signInUnderEnrollment = await run(
    { purpose: "enrollment", outcome: "limited" },
    () => settle(attemptCase("sign_in_start", "ENROLLMENT_RATE_LIMIT").call(bindings, request)),
  );
  await assertWorkerError(signInUnderEnrollment.error, 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE");
});

test("refusal causes are distinct, content-free plain Errors", async () => {
  const { bindings, run } = limiters.createEdgeAdmissionLimiters();
  const global = { key: "usage-monitor:enrollment:global" };
  assertReplayRefusal(
    await directRefusal(bindings.ENROLLMENT_RATE_LIMIT, global),
    "EDGE_ADMISSION_REPLAY_NO_CONTEXT",
  );
  assertReplayRefusal(
    await run(null, () => directRefusal(bindings.ENROLLMENT_RATE_LIMIT, global)),
    "EDGE_ADMISSION_REPLAY_NO_OUTCOME",
  );
  assertReplayRefusal(
    await run(
      { purpose: "device_sync", outcome: "allowed" },
      () => directRefusal(bindings.ENROLLMENT_RATE_LIMIT, global),
    ),
    "EDGE_ADMISSION_REPLAY_PURPOSE_MISMATCH",
  );
  const clientKey = `usage-monitor:enrollment:client:${HEX64}`;
  const refusal = await run(
    { purpose: "enrollment", outcome: "allowed" },
    () => directRefusal(bindings.ENROLLMENT_RATE_LIMIT, { key: clientKey }),
  );
  assertReplayRefusal(refusal, "EDGE_ADMISSION_REPLAY_BINDING_MISMATCH");
  assert.ok(!JSON.stringify({ message: refusal.message, stack: refusal.stack }).includes(HEX64));
});

test("each binding accepts only the key shape and purposes the Worker helpers give it", async () => {
  const { bindings, run } = limiters.createEdgeAdmissionLimiters();
  async function refusedFirstCall(purpose, name, options, code) {
    const error = await run({ purpose, outcome: "allowed" }, () => directRefusal(bindings[name], options));
    assertReplayRefusal(error, code);
  }
  const client = (purpose) => ({ key: `usage-monitor:${purpose}:client:${HEX64}` });
  const global = (purpose) => ({ key: `usage-monitor:${purpose}:global` });
  const mismatch = "EDGE_ADMISSION_REPLAY_BINDING_MISMATCH";
  const invalid = "EDGE_ADMISSION_REPLAY_KEY_INVALID";

  // Coarse bindings take only ':global'; client bindings only ':client:'.
  await refusedFirstCall("enrollment", "ENROLLMENT_RATE_LIMIT", client("enrollment"), mismatch);
  await refusedFirstCall("device_sync", "RECOVERY_RATE_LIMIT", client("device_sync"), mismatch);
  await refusedFirstCall("upload_ingress", "UPLOAD_INGRESS_REQUEST_RATE_LIMIT", client("upload_ingress"), mismatch);
  await refusedFirstCall("public_aggregate_read", "PUBLIC_READ_RATE_LIMIT", global("public_aggregate_read"), mismatch);
  // PUBLIC_READ only public_aggregate_read; UPLOAD_INGRESS_* only upload_ingress;
  // the attempt bindings never take either of those.
  await refusedFirstCall("device_sync", "PUBLIC_READ_RATE_LIMIT", client("device_sync"), mismatch);
  await refusedFirstCall("device_sync", "UPLOAD_INGRESS_REQUEST_RATE_LIMIT", global("device_sync"), mismatch);
  await refusedFirstCall("upload_ingress", "ENROLLMENT_RATE_LIMIT", global("upload_ingress"), mismatch);
  await refusedFirstCall("public_aggregate_read", "RECOVERY_RATE_LIMIT", global("public_aggregate_read"), mismatch);
  // The client-stage attempt and upload bindings are pinned to their own
  // purposes too. A public read reaches its first call at the client stage, so
  // only these pins refuse a public read wired to the wrong client binding.
  await refusedFirstCall("public_aggregate_read", "CLIENT_ATTEMPT_RATE_LIMIT", client("public_aggregate_read"), mismatch);
  await refusedFirstCall("public_aggregate_read", "UPLOAD_INGRESS_CLIENT_RATE_LIMIT", client("public_aggregate_read"), mismatch);
  // After an allowed coarse call, the client binding of the other helper
  // family is refused: an attempt key on the upload client binding and an
  // upload key on the attempt client binding.
  async function refusedAfterCoarse(purpose, coarseName, clientName) {
    const error = await run({ purpose, outcome: "allowed" }, async () => {
      assert.deepEqual(await bindings[coarseName].limit(global(purpose)), { success: true });
      return directRefusal(bindings[clientName], client(purpose));
    });
    assertReplayRefusal(error, mismatch);
  }
  await refusedAfterCoarse("device_sync", "RECOVERY_RATE_LIMIT", "UPLOAD_INGRESS_CLIENT_RATE_LIMIT");
  await refusedAfterCoarse("enrollment", "ENROLLMENT_RATE_LIMIT", "UPLOAD_INGRESS_CLIENT_RATE_LIMIT");
  await refusedAfterCoarse("upload_ingress", "UPLOAD_INGRESS_REQUEST_RATE_LIMIT", "CLIENT_ATTEMPT_RATE_LIMIT");
  // Through the real helpers, a mis-wired client binding answers the 503.
  const request = originRequest();
  for (const wrongBinding of ["CLIENT_ATTEMPT_RATE_LIMIT", "UPLOAD_INGRESS_CLIENT_RATE_LIMIT"]) {
    const outcome = await run(
      { purpose: "public_aggregate_read", outcome: "allowed" },
      () => settle(admissionHelpers.assertPublicAggregateReadAllowed(bindings[wrongBinding], request, ORIGIN_ENV)),
    );
    await assertWorkerError(outcome.error, 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE");
  }
  const attemptOnUploadClient = await run(
    { purpose: "device_sync", outcome: "allowed" },
    () => settle(admissionHelpers.assertAttemptAllowed(
      bindings.RECOVERY_RATE_LIMIT,
      bindings.UPLOAD_INGRESS_CLIENT_RATE_LIMIT,
      request,
      ORIGIN_ENV,
      "device_sync",
    )),
  );
  await assertWorkerError(attemptOnUploadClient.error, 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE");
  const uploadOnAttemptClient = await run(
    { purpose: "upload_ingress", outcome: "allowed" },
    () => settle(admissionHelpers.assertUploadIngressRequestAllowed(
      bindings.UPLOAD_INGRESS_REQUEST_RATE_LIMIT,
      bindings.CLIENT_ATTEMPT_RATE_LIMIT,
      request,
      ORIGIN_ENV,
    )),
  );
  await assertWorkerError(uploadOnAttemptClient.error, 503, "UPLOAD_INGRESS_UNAVAILABLE");
  // Purposes outside the contract, including the origin-tier upload
  // authorization, never match any binding.
  await refusedFirstCall("enrollment", "ENROLLMENT_RATE_LIMIT", global("upload_authorization"), mismatch);
  await refusedFirstCall("enrollment", "ENROLLMENT_RATE_LIMIT", global("password_reset"), mismatch);

  for (const options of [
    undefined,
    null,
    "usage-monitor:enrollment:global",
    {},
    { key: 7 },
    { key: "" },
    { key: "usage-monitor:enrollment:global " },
    { key: "usage-monitor:Enrollment:global" },
    { key: "usage-monitor:enrollment:GLOBAL" },
    { key: "usage-monitor:enrollment:global:extra" },
    { key: "usage-monitor:enrollment" },
    { key: "usage-monitor:enrollment:client:" },
    { key: `usage-monitor:enrollment:client:${HEX64.slice(1)}` },
    { key: `usage-monitor:enrollment:client:${HEX64}0` },
    { key: `usage-monitor:enrollment:client:${HEX64.toUpperCase()}` },
    { key: `usage-monitor:upload_authorization:participant:${HEX64}` },
    { key: `app-usagemonitor:enrollment:global` },
    { key: `usage-monitor:enrollment:global\n` },
    { key: `usage-monitor:${"a".repeat(300)}:global` },
  ]) {
    const error = await run(
      { purpose: "enrollment", outcome: "allowed" },
      () => directRefusal(bindings.ENROLLMENT_RATE_LIMIT, options),
    );
    assertReplayRefusal(error, invalid);
  }
});

test("only the Worker helper's own call sequence is replayed", async () => {
  const { bindings, run } = limiters.createEdgeAdmissionLimiters();
  const sequence = "EDGE_ADMISSION_REPLAY_SEQUENCE_INVALID";
  const enrollmentGlobal = { key: "usage-monitor:enrollment:global" };
  const enrollmentClient = { key: `usage-monitor:enrollment:client:${HEX64}` };
  const allowedEnrollment = { purpose: "enrollment", outcome: "allowed" };

  // A client call before its coarse call.
  assertReplayRefusal(
    await run(allowedEnrollment, () => directRefusal(bindings.CLIENT_ATTEMPT_RATE_LIMIT, enrollmentClient)),
    sequence,
  );
  // A repeated coarse call.
  assertReplayRefusal(await run(allowedEnrollment, async () => {
    assert.deepEqual(await bindings.ENROLLMENT_RATE_LIMIT.limit(enrollmentGlobal), { success: true });
    return directRefusal(bindings.RECOVERY_RATE_LIMIT, enrollmentGlobal);
  }), sequence);
  // A third call after coarse and client.
  assertReplayRefusal(await run(allowedEnrollment, async () => {
    await bindings.ENROLLMENT_RATE_LIMIT.limit(enrollmentGlobal);
    assert.deepEqual(await bindings.CLIENT_ATTEMPT_RATE_LIMIT.limit(enrollmentClient), { success: true });
    return directRefusal(bindings.CLIENT_ATTEMPT_RATE_LIMIT, enrollmentClient);
  }), sequence);
  // Any call after a limited answer.
  assertReplayRefusal(await run({ purpose: "enrollment", outcome: "limited" }, async () => {
    assert.deepEqual(await bindings.ENROLLMENT_RATE_LIMIT.limit(enrollmentGlobal), { success: false });
    return directRefusal(bindings.CLIENT_ATTEMPT_RATE_LIMIT, enrollmentClient);
  }), sequence);
  // A refusal closes the run: a later well-formed call is refused too.
  assertReplayRefusal(await run(allowedEnrollment, async () => {
    await directRefusal(bindings.ENROLLMENT_RATE_LIMIT, enrollmentClient);
    return directRefusal(bindings.ENROLLMENT_RATE_LIMIT, enrollmentGlobal);
  }), sequence);
  // The public read has one call only.
  const publicKey = { key: `usage-monitor:public_aggregate_read:client:${HEX64}` };
  assertReplayRefusal(await run({ purpose: "public_aggregate_read", outcome: "allowed" }, async () => {
    assert.deepEqual(await bindings.PUBLIC_READ_RATE_LIMIT.limit(publicKey), { success: true });
    return directRefusal(bindings.PUBLIC_READ_RATE_LIMIT, publicKey);
  }), sequence);

  // An extra helper call in one request (FC-7) answers the helper's 503.
  const request = originRequest();
  const attempt = attemptCase("device_sync", "RECOVERY_RATE_LIMIT");
  const doubled = await run({ purpose: "device_sync", outcome: "allowed" }, async () => {
    const first = await settle(attempt.call(bindings, request));
    const second = await settle(attempt.call(bindings, request));
    return { first, second };
  });
  assert.equal(doubled.first.error, null);
  await assertWorkerError(doubled.second.error, 503, "ADMISSION_RATE_LIMIT_UNAVAILABLE");
  const upload = uploadIngressCase();
  const doubledUpload = await run({ purpose: "upload_ingress", outcome: "allowed" }, async () => {
    await upload.call(bindings, request);
    return settle(upload.call(bindings, request));
  });
  await assertWorkerError(doubledUpload.error, 503, "UPLOAD_INGRESS_UNAVAILABLE");
});

test("run() validates its outcome and function and returns fn's own result", async () => {
  const { run } = limiters.createEdgeAdmissionLimiters();
  for (const admission of [
    undefined,
    "v1;enrollment;allowed",
    {},
    { purpose: "enrollment" },
    { purpose: "upload_authorization", outcome: "allowed" },
    { purpose: "enrollment", outcome: "maybe" },
    { purpose: "Enrollment", outcome: "allowed" },
  ]) {
    assert.throws(
      () => run(admission, () => "unreached"),
      (error) => error instanceof TypeError && error.code === "EDGE_ADMISSION_REPLAY_OUTCOME_INVALID",
      JSON.stringify(admission) ?? "undefined",
    );
  }
  assert.throws(
    () => run(null, "not a function"),
    (error) => error instanceof TypeError && error.code === "EDGE_ADMISSION_REPLAY_FUNCTION_INVALID",
  );
  const marker = {};
  assert.equal(run(null, () => marker), marker);
  assert.equal(await run({ purpose: "enrollment", outcome: "allowed" }, async () => marker), marker);
});

test("two instances and nested runs keep separate scopes", async () => {
  const first = limiters.createEdgeAdmissionLimiters();
  const second = limiters.createEdgeAdmissionLimiters();
  const coarse = { key: "usage-monitor:enrollment:global" };
  // A binding of one instance never reads another instance's scope.
  assertReplayRefusal(
    await first.run(
      { purpose: "enrollment", outcome: "allowed" },
      () => directRefusal(second.bindings.ENROLLMENT_RATE_LIMIT, coarse),
    ),
    "EDGE_ADMISSION_REPLAY_NO_CONTEXT",
  );
  const nested = await first.run({ purpose: "enrollment", outcome: "allowed" }, () => first.run(
    { purpose: "enrollment", outcome: "limited" },
    () => first.bindings.ENROLLMENT_RATE_LIMIT.limit(coarse),
  ));
  assert.deepEqual(nested, { success: false });
});

test("50 concurrent runs with interleaved awaits stay isolated", async () => {
  const { bindings, run } = limiters.createEdgeAdmissionLimiters();
  const cases = helperCases();
  const outcomes = ["allowed", "limited", "unavailable"];
  const runs = Array.from({ length: 50 }, (_, index) => {
    const helperCase = cases[(index * 7) % cases.length];
    const outcome = outcomes[index % outcomes.length];
    const request = originRequest();
    return run({ purpose: helperCase.purpose, outcome }, async () => {
      // Hop across timers and microtasks before and between the calls.
      await delay((index * 13) % 17);
      await Promise.resolve();
      const calls = [];
      const spied = spyBindings(bindings, calls);
      const staggered = Object.fromEntries(BINDING_NAMES.map((name) => [name, {
        async limit(options) {
          await delay((index * 5) % 7);
          return spied[name].limit(options);
        },
      }]));
      const result = await settle(helperCase.call(staggered, request));
      return { helperCase, outcome, calls, result };
    });
  });
  const settled = await Promise.all(runs);
  assert.equal(settled.length, 50);
  for (const { helperCase, outcome, calls, result } of settled) {
    if (outcome === "allowed") {
      assert.equal(result.error, null, `${helperCase.label} allowed`);
      assert.deepEqual(calls, helperCase.expectedCalls);
    } else if (outcome === "limited") {
      await assertWorkerError(result.error, 429, helperCase.limitedCode);
      assert.deepEqual(calls, helperCase.expectedCalls.slice(0, 1));
    } else {
      await assertWorkerError(result.error, 503, helperCase.unavailableCode);
    }
  }
});

async function edgePolicyAvailable() {
  try {
    await access(EDGE_POLICY_PATH);
    return true;
  } catch {
    return false;
  }
}

// EP-1's src/edge-admission-policy.ts is required: a missing, renamed or moved
// module FAILS this test rather than switching it off. The only skip is an
// explicit pre-integration opt-out for a tree cut before EP-1 merged, which the
// registered cloud-run `check` script never sets. Setting it in a tree that
// holds the module also fails, so the opt-out cannot outlive the integration.
// Remove the opt-out once EP-1 is integrated.
const EDGE_POLICY_PENDING_FLAG = "TIBOTATTLE_EDGE_ADMISSION_POLICY_PENDING";
const edgePolicyPresent = await edgePolicyAvailable();
const edgePolicyPendingOptOut = process.env[EDGE_POLICY_PENDING_FLAG] === "1";

test("replays every EP-1 edge admission policy entry through its own bindings", {
  skip: !edgePolicyPresent && edgePolicyPendingOptOut
    && `${EDGE_POLICY_PENDING_FLAG}=1: src/edge-admission-policy.ts (EP-1) is not integrated yet`,
}, async () => {
  assert.ok(
    edgePolicyPresent,
    "src/edge-admission-policy.ts (EP-1 EDGE_ADMISSION_BINDINGS and EDGE_ADMISSION_POLICY) is required",
  );
  assert.equal(
    edgePolicyPendingOptOut,
    false,
    `${EDGE_POLICY_PENDING_FLAG} is set but EP-1's policy module is present: remove the opt-out`,
  );
  const policy = await vite.ssrLoadModule("/src/edge-admission-policy.ts");
  assert.deepEqual([...policy.EDGE_ADMISSION_BINDINGS], BINDING_NAMES);
  const { bindings, run } = limiters.createEdgeAdmissionLimiters();
  const entries = Object.entries(policy.EDGE_ADMISSION_POLICY);
  assert.ok(entries.length > 0);
  for (const [routeId, entry] of entries) {
    const request = originRequest();
    const call = () => {
      if (entry.helper === "attempt") {
        return admissionHelpers.assertAttemptAllowed(
          bindings[entry.coarseBinding],
          bindings[entry.clientBinding],
          request,
          ORIGIN_ENV,
          entry.purpose,
        );
      }
      if (entry.helper === "upload_ingress") {
        return admissionHelpers.assertUploadIngressRequestAllowed(
          bindings[entry.coarseBinding],
          bindings[entry.clientBinding],
          request,
          ORIGIN_ENV,
        );
      }
      assert.equal(entry.helper, "public_read", routeId);
      assert.equal(entry.coarseBinding, null, routeId);
      return admissionHelpers.assertPublicAggregateReadAllowed(
        bindings[entry.clientBinding],
        request,
        ORIGIN_ENV,
      );
    };
    const allowed = await run({ purpose: entry.purpose, outcome: "allowed" }, () => settle(call()));
    assert.equal(allowed.error, null, `${routeId} allowed`);
    const limited = await run({ purpose: entry.purpose, outcome: "limited" }, () => settle(call()));
    assert.equal(limited.error?.status, 429, `${routeId} limited`);
    const unavailable = await run({ purpose: entry.purpose, outcome: "unavailable" }, () => settle(call()));
    assert.equal(unavailable.error?.status, 503, `${routeId} unavailable`);
  }
});

test("no console output", () => {
  for (const spy of consoleSpies) assert.equal(spy.mock.callCount(), 0);
});
