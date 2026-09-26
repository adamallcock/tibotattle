import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { after, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createServer } from "vite";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(ROOT, "..");
const CONTRACT_PATH = resolve(ROOT, "postgres-family-contract.mjs");
const REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a2b";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MIB = 1024 * 1024;
const EXPECTED_EXPORTS = Object.freeze([
  "CONTROL_BODY_READ_POLICY",
  "DISPATCH_CONTRACT",
  "JSON_SECURITY_HEADERS",
  "POST_CLAIM_HANDLER_CONTRACT",
  "adminIdentityFor",
  "apiErrorToResponse",
  "assertDispatcher",
  "assertFrozenPathnames",
  "createPostClaimHandlerRegistry",
  "readBoundedJsonRequest",
  "requestIdFor",
  "validatePostClaimHandler",
  "workerError",
  "workerJson",
]);
const JSON_HEADER_NAMES = Object.freeze([
  "cache-control",
  "content-type",
  "referrer-policy",
  "x-content-type-options",
]);

let vite;
let contract;
let errors;
let constants;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  [contract, errors, constants] = await Promise.all([
    vite.ssrLoadModule("/cloud-run/postgres-family-contract.mjs"),
    vite.ssrLoadModule("/src/errors.ts"),
    vite.ssrLoadModule("/src/constants.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

function headerNames(response) {
  return [...response.headers.keys()].sort();
}

function jsonRequest(body, headers = {}, init = {}) {
  return new Request("https://family.test/api/v1/example", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    ...init,
  });
}

function streamOf(chunks, onPull = () => {}) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      onPull();
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
}

async function rejectsWith(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof errors.ApiError, "refusals are Worker ApiError instances");
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

async function flushMicrotasks(rounds = 5) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  }
}

test("the contract exports exactly the reviewed surface and no upload-authorization format contract", () => {
  assert.deepEqual(Object.keys(contract).sort(), EXPECTED_EXPORTS);
  assert.equal(Object.keys(contract).some((name) => /format/iu.test(name)), false);
  for (const name of ["DISPATCH_CONTRACT", "POST_CLAIM_HANDLER_CONTRACT", "CONTROL_BODY_READ_POLICY"]) {
    const value = contract[name];
    assert.ok(Object.isFrozen(value), `${name} is frozen`);
    for (const nested of Object.values(value)) {
      if (nested !== null && typeof nested === "object") assert.ok(Object.isFrozen(nested));
    }
  }
  assert.equal(contract.DISPATCH_CONTRACT.dispatcherArity, 1);
  assert.deepEqual(contract.DISPATCH_CONTRACT.dependencyKeys,
    ["pools", "schemaOptions", "env", "origins", "storageGate", "requestContext", "clock"]);
  assert.deepEqual(contract.POST_CLAIM_HANDLER_CONTRACT.inputKeys,
    ["body", "participant", "deviceId", "authorizationId", "authorizationKind", "heartbeat", "requestId"]);
  assert.deepEqual(contract.CONTROL_BODY_READ_POLICY,
    { maximumTotalMilliseconds: 15_000, maximumIdleMilliseconds: 5_000 });
});

test("the header block states every family convention later briefs cite as FC", async () => {
  const source = await readFile(CONTRACT_PATH, "utf8");
  const header = source.slice(0, source.indexOf("\nimport "));
  assert.match(header, /FAMILY CONVENTIONS \(FC\)/u);
  for (let index = 1; index <= 12; index += 1) assert.match(header, new RegExp(`FC-${index} `, "u"));
  for (const phrase of [
    /New files only/u,
    /frozen <FAMILY>_PATHNAMES/u,
    /pools, schemaOptions, a frozen\s+\*\s+Worker-shaped env/u,
    /origins, storageGate,\s+\*\s+requestContext/u,
    /never emit request_failed/u,
    /Never log bodies,\s+\*\s+ids, tokens, cookies, IP addresses, SQL or driver error text/u,
    /src\/admission\.ts helper/u,
    /edge-admission replay bindings/u,
    /answers 503/u,
    /origin-tier PostgreSQL limiters/u,
    /No host checks and no retries/u,
    /staged-migrations\/<role>\/<NNNN>_<name>\.sql/u,
    /skip\s+\*\s+cleanly when PG_TEST_SOCKET and PG_TEST_HOST/u,
    /owner_digest/u,
    /participant_id column or a participants\s+\*\s+foreign key/u,
    /no\s+\*\s+upload-authorization format contract/u,
  ]) {
    assert.match(header, phrase);
  }
});

test("JSON_SECURITY_HEADERS equals the Worker JSON headers including no-store", () => {
  assert.ok(Object.isFrozen(contract.JSON_SECURITY_HEADERS));
  assert.deepEqual(contract.JSON_SECURITY_HEADERS, { ...constants.JSON_HEADERS });
  assert.deepEqual(contract.JSON_SECURITY_HEADERS, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
});

test("workerJson matches the Worker jsonResponse and lets a route set its own cache policy", async () => {
  const response = contract.workerJson(201, { ok: true, nested: { value: 1 } });
  const reference = errors.jsonResponse({ ok: true, nested: { value: 1 } }, 201);
  assert.equal(response.status, 201);
  assert.deepEqual(headerNames(response), JSON_HEADER_NAMES);
  assert.deepEqual([...response.headers], [...reference.headers]);
  assert.equal(await response.text(), await reference.text());
  const cached = contract.workerJson(200, { days: [] }, { "cache-control": "public, max-age=300", vary: "Cookie" });
  assert.equal(cached.headers.get("cache-control"), "public, max-age=300");
  assert.equal(cached.headers.get("vary"), "Cookie");
  assert.throws(() => contract.workerJson(99, {}), { code: "FAMILY_RESPONSE_STATUS_INVALID" });
  assert.throws(() => contract.workerJson(200.5, {}), { code: "FAMILY_RESPONSE_STATUS_INVALID" });
});

test("workerError produces exact key sets, Worker headers, and Allow or retry-after only when passed", async () => {
  const plain = contract.workerError({ code: "NOT_FOUND", status: 404, requestId: REQUEST_ID });
  assert.equal(plain.status, 404);
  assert.deepEqual(headerNames(plain), JSON_HEADER_NAMES);
  for (const [name, value] of Object.entries(contract.JSON_SECURITY_HEADERS)) {
    assert.equal(plain.headers.get(name), value);
  }
  assert.equal(await plain.text(), `{"error":{"code":"NOT_FOUND","requestId":"${REQUEST_ID}"}}`);

  const detailed = contract.workerError({
    code: "CONTRIBUTION_LIMIT_REACHED",
    status: 429,
    requestId: REQUEST_ID,
    retryAfter: 60,
    details: { retryAt: "2026-09-26T00:00:00.000Z" },
  });
  assert.equal(detailed.status, 429);
  assert.deepEqual(headerNames(detailed), [...JSON_HEADER_NAMES, "retry-after"].sort());
  assert.equal(detailed.headers.get("retry-after"), "60");
  const detailedBody = await detailed.json();
  assert.deepEqual(Object.keys(detailedBody), ["error"]);
  assert.deepEqual(Object.keys(detailedBody.error), ["code", "requestId", "details"]);
  assert.deepEqual(detailedBody.error.details, { retryAt: "2026-09-26T00:00:00.000Z" });

  const methodRefusal = contract.workerError({
    code: "METHOD_NOT_ALLOWED",
    status: 405,
    requestId: REQUEST_ID,
    allow: ["GET", "POST"],
  });
  assert.deepEqual(headerNames(methodRefusal), [...JSON_HEADER_NAMES, "allow"].sort());
  assert.equal(methodRefusal.headers.get("allow"), "GET, POST");
  assert.deepEqual(Object.keys((await methodRefusal.json()).error), ["code", "requestId"]);

  for (const [input, code] of [
    [{ code: "not_upper", status: 400, requestId: REQUEST_ID }, "FAMILY_ERROR_CODE_INVALID"],
    [{ code: "NOT_FOUND", status: 200, requestId: REQUEST_ID }, "FAMILY_RESPONSE_STATUS_INVALID"],
    [{ code: "NOT_FOUND", status: 404 }, "FAMILY_REQUEST_ID_INVALID"],
    [{ code: "NOT_FOUND", status: 404, requestId: "has space" }, "FAMILY_REQUEST_ID_INVALID"],
    [{ code: "NOT_FOUND", status: 404, requestId: REQUEST_ID, retryAfter: 0 }, "FAMILY_RETRY_AFTER_INVALID"],
    [{ code: "NOT_FOUND", status: 404, requestId: REQUEST_ID, retryAfter: "60" }, "FAMILY_RETRY_AFTER_INVALID"],
    [{ code: "NOT_FOUND", status: 404, requestId: REQUEST_ID, details: [] }, "FAMILY_ERROR_DETAILS_INVALID"],
    [{ code: "NOT_FOUND", status: 404, requestId: REQUEST_ID, details: null }, "FAMILY_ERROR_DETAILS_INVALID"],
    [{ code: "METHOD_NOT_ALLOWED", status: 405, requestId: REQUEST_ID, allow: [] }, "FAMILY_ALLOW_INVALID"],
    [{ code: "METHOD_NOT_ALLOWED", status: 405, requestId: REQUEST_ID, allow: ["GET", "GET"] }, "FAMILY_ALLOW_INVALID"],
    [{ code: "METHOD_NOT_ALLOWED", status: 405, requestId: REQUEST_ID, allow: "GET" }, "FAMILY_ALLOW_INVALID"],
  ]) {
    assert.throws(() => contract.workerError(input), { name: "TypeError", code });
  }
});

test("apiErrorToResponse keeps ApiError semantics and maps anything else to 500 with no message", async () => {
  const leaks = "SELECT * FROM participants /private/session um_session_abc 203.0.113.9";
  for (const thrown of [new Error(leaks), new TypeError(leaks), leaks, null, undefined,
    { status: 400, code: "BODY_INVALID", message: leaks }]) {
    const response = contract.apiErrorToResponse(thrown, REQUEST_ID);
    assert.equal(response.status, 500);
    assert.deepEqual(headerNames(response), JSON_HEADER_NAMES);
    const text = await response.text();
    assert.equal(text, `{"error":{"code":"INTERNAL_ERROR","requestId":"${REQUEST_ID}"}}`);
  }

  const limited = new errors.ApiError(429, "UPLOAD_ADMISSION_LIMIT_REACHED", {
    publicDetails: { retryAt: "2026-09-26T00:01:00.000Z" },
    responseHeaders: { "retry-after": "60", "cache-control": "public, max-age=60" },
  });
  const limitedResponse = contract.apiErrorToResponse(limited, REQUEST_ID);
  assert.equal(limitedResponse.status, 429);
  assert.equal(limitedResponse.headers.get("retry-after"), "60");
  assert.equal(limitedResponse.headers.get("cache-control"), "no-store",
    "the Worker catch path always applies no-store to an error");
  assert.deepEqual(await limitedResponse.json(), {
    error: {
      code: "UPLOAD_ADMISSION_LIMIT_REACHED",
      requestId: REQUEST_ID,
      details: { retryAt: "2026-09-26T00:01:00.000Z" },
    },
  });

  const methodNotAllowed = new errors.ApiError(405, "METHOD_NOT_ALLOWED");
  Object.defineProperty(methodNotAllowed, "allowed", { value: Object.freeze(["POST"]) });
  const methodResponse = contract.apiErrorToResponse(methodNotAllowed, REQUEST_ID);
  assert.equal(methodResponse.headers.get("allow"), "POST");
  assert.equal(contract.apiErrorToResponse(new errors.ApiError(404, "NOT_FOUND"), REQUEST_ID)
    .headers.has("allow"), false);
  assert.throws(() => contract.apiErrorToResponse(new Error("x"), ""), { code: "FAMILY_REQUEST_ID_INVALID" });
});

test("requestIdFor and adminIdentityFor read only the injected accessor", () => {
  const request = jsonRequest("{}");
  const minted = contract.requestIdFor({}, request);
  assert.match(minted, UUID_V4);
  assert.notEqual(contract.requestIdFor({}, request), minted);
  assert.match(contract.requestIdFor(undefined, request), UUID_V4);
  assert.match(contract.requestIdFor({ requestContext: () => undefined }, request), UUID_V4);
  assert.match(contract.requestIdFor({ requestContext: "not a function" }, request), UUID_V4);
  const deps = {
    requestContext: (candidate) => candidate === request
      ? Object.freeze({ requestId: REQUEST_ID, routeId: "admin_overview", adminIdentityKey: "owner@example.test" })
      : undefined,
  };
  assert.equal(contract.requestIdFor(deps, request), REQUEST_ID);
  assert.equal(contract.adminIdentityFor(deps, request), "owner@example.test");
  const clone = request.clone();
  assert.match(contract.requestIdFor(deps, clone), UUID_V4);
  assert.notEqual(contract.requestIdFor(deps, clone), REQUEST_ID);
  assert.equal(contract.adminIdentityFor(deps, clone), null);
  assert.equal(contract.adminIdentityFor({}, request), null);
  assert.equal(contract.adminIdentityFor({ requestContext: () => ({ requestId: REQUEST_ID, adminIdentityKey: "" }) }, request), null);
});

test("readBoundedJsonRequest enforces the Worker media type rule", async () => {
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest("{}", { "content-type": "text/plain" })),
    415, "CONTENT_TYPE_INVALID");
  await rejectsWith(contract.readBoundedJsonRequest(new Request("https://family.test/x", { method: "POST", body: "{}" })),
    415, "CONTENT_TYPE_INVALID");
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest("{}", { "content-type": "APPLICATION/JSON" })),
    415, "CONTENT_TYPE_INVALID");
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest("{}", { "content-type": "application/jsonx" })),
    415, "CONTENT_TYPE_INVALID");
  for (const contentType of ["application/json", "application/json;charset=utf-8", " application/json ; charset=utf-8"]) {
    const body = await contract.readBoundedJsonRequest(jsonRequest('{"a":1}', { "content-type": contentType }));
    assert.deepEqual(body.value, { a: 1 });
  }
});

test("readBoundedJsonRequest rejects malformed and oversized declared lengths before reading", async () => {
  for (const declared of ["-1", "1.5", "abc", "9007199254740993"]) {
    await rejectsWith(contract.readBoundedJsonRequest(jsonRequest("{}", { "content-length": declared })),
      400, "BODY_INVALID");
  }
  let pulls = 0;
  const unread = jsonRequest(streamOf([new TextEncoder().encode("{}")], () => { pulls += 1; }),
    { "content-length": String(2 * MIB + 1) });
  await rejectsWith(contract.readBoundedJsonRequest(unread), 413, "BODY_TOO_LARGE");
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest("{}", { "content-length": "513" }), { maxBytes: 512 }),
    413, "BODY_TOO_LARGE");
  assert.ok(pulls <= 1, "a declared oversize body is refused without consuming it");
});

test("readBoundedJsonRequest bounds streamed bytes at 2 MiB and at a 512-byte route cap", async () => {
  const chunk = new Uint8Array(MIB).fill(0x20);
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest(streamOf([chunk, chunk, chunk]))),
    413, "BODY_TOO_LARGE");
  const exact = `"${"a".repeat(2 * MIB - 2)}"`;
  const accepted = await contract.readBoundedJsonRequest(jsonRequest(exact));
  assert.equal(accepted.bytes.byteLength, 2 * MIB);
  assert.equal(accepted.value.length, 2 * MIB - 2);

  const fits = `"${"b".repeat(510)}"`;
  const small = await contract.readBoundedJsonRequest(jsonRequest(fits), { maxBytes: 512, strict: true });
  assert.equal(small.bytes.byteLength, 512);
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest(`"${"b".repeat(511)}"`), { maxBytes: 512 }),
    413, "BODY_TOO_LARGE");
  await rejectsWith(contract.readBoundedJsonRequest(
    jsonRequest(streamOf([new TextEncoder().encode(`"${"c".repeat(300)}`), new TextEncoder().encode(`${"c".repeat(300)}"`)])),
    { maxBytes: 512 },
  ), 413, "BODY_TOO_LARGE");
});

test("readBoundedJsonRequest decodes fatally and keeps the Worker byte-order-mark behaviour", async () => {
  await rejectsWith(contract.readBoundedJsonRequest(new Request("https://family.test/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
  })), 400, "BODY_INVALID");
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest(new Uint8Array([0x7b, 0xff, 0x7d]))),
    400, "BODY_INVALID");
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest(new Uint8Array([0x22, 0xc3, 0x22]))),
    400, "BODY_INVALID");
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest("")), 400, "BODY_INVALID");
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest("{\"a\":")), 400, "BODY_INVALID");

  // The Worker decodes with TextDecoder(fatal, ignoreBOM: false), which
  // consumes exactly one leading BOM: the body parses, raw omits the mark,
  // and bytes (the upload scope digest input) keep it.
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]);
  const leading = await contract.readBoundedJsonRequest(jsonRequest(bom));
  assert.deepEqual(leading.value, { a: 1 });
  assert.equal(leading.raw, '{"a":1}');
  assert.deepEqual([...leading.bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  for (const strict of [false, true]) {
    await rejectsWith(contract.readBoundedJsonRequest(
      jsonRequest(new Uint8Array([0xef, 0xbb, 0xbf, ...bom])), { strict }), 400, "BODY_INVALID");
    await rejectsWith(contract.readBoundedJsonRequest(jsonRequest(` ﻿{"a":1}`), { strict }),
      400, "BODY_INVALID");
    await rejectsWith(contract.readBoundedJsonRequest(jsonRequest(`{"a":1}﻿`), { strict }),
      400, "BODY_INVALID");
  }
});

test("strict mode rejects duplicate keys that lenient mode resolves to the last value", async () => {
  const lenient = await contract.readBoundedJsonRequest(jsonRequest('{"a":1,"a":2}'));
  assert.deepEqual(lenient.value, { a: 2 });
  assert.ok(Object.isFrozen(lenient));
  assert.ok(lenient.bytes instanceof Uint8Array);
  assert.equal(lenient.raw, '{"a":1,"a":2}');
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest('{"a":1,"a":2}'), { strict: true }),
    400, "BODY_INVALID");
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest('{"outer":[{"k":1,"k":1}]}'), { strict: true }),
    400, "BODY_INVALID");
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest('{"a":1,}'), { strict: true }),
    400, "BODY_INVALID");
  await rejectsWith(contract.readBoundedJsonRequest(jsonRequest('{"a":1 /* c */}'), { strict: true }),
    400, "BODY_INVALID");
  const strict = await contract.readBoundedJsonRequest(jsonRequest(' {"a":{"b":[1,2]},"c":null} '), { strict: true });
  assert.deepEqual(strict.value, { a: { b: [1, 2] }, c: null });
});

test("readBoundedJsonRequest refuses invalid options before touching the body", async () => {
  for (const [options, code] of [
    [{ maxBytes: 0 }, "FAMILY_BODY_LIMIT_INVALID"],
    [{ maxBytes: 2 * MIB + 1 }, "FAMILY_BODY_LIMIT_INVALID"],
    [{ maxBytes: 1.5 }, "FAMILY_BODY_LIMIT_INVALID"],
    [{ strict: "yes" }, "FAMILY_BODY_MODE_INVALID"],
    [{ policy: { maximumTotalMilliseconds: 1_000, maximumIdleMilliseconds: 2_000 } }, "FAMILY_BODY_POLICY_INVALID"],
    [{ policy: { maximumTotalMilliseconds: 1_000, maximumIdleMilliseconds: 0 } }, "FAMILY_BODY_POLICY_INVALID"],
    [{ policy: null }, "FAMILY_BODY_POLICY_INVALID"],
  ]) {
    const request = jsonRequest("{}");
    await assert.rejects(contract.readBoundedJsonRequest(request, options), { name: "TypeError", code });
    assert.equal(request.bodyUsed, false);
  }
  const custom = await contract.readBoundedJsonRequest(jsonRequest("[1]"), {
    policy: { maximumTotalMilliseconds: 60_000, maximumIdleMilliseconds: 15_000 },
  });
  assert.deepEqual(custom.value, [1]);
});

test("a stalled stream times out at the Worker's 5 s idle limit (fake timers)", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const stalled = contract.readBoundedJsonRequest(jsonRequest(new ReadableStream({ pull() {
      return new Promise(() => {});
    } })));
    let settled = false;
    stalled.then(() => { settled = true; }, () => { settled = true; });
    await flushMicrotasks();
    mock.timers.tick(4_999);
    await flushMicrotasks();
    assert.equal(settled, false, "still waiting one millisecond before the idle limit");
    mock.timers.tick(1);
    await flushMicrotasks();
    assert.equal(settled, true, "the idle deadline fires at exactly 5 s");
    await rejectsWith(stalled, 408, "BODY_TIMEOUT");
  } finally {
    mock.timers.reset();
  }
});

test("a dribbled stream times out at the Worker's 15 s total limit (fake timers)", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 2_000_000 });
  try {
    const dribbled = contract.readBoundedJsonRequest(jsonRequest(new ReadableStream({
      pull(controller) {
        return new Promise((resolvePull) => {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(" "));
            resolvePull();
          }, 4_000);
        });
      },
    })));
    let settled = false;
    dribbled.then(() => { settled = true; }, () => { settled = true; });
    await flushMicrotasks();
    for (let elapsed = 0; elapsed < 14_999; elapsed += 1) {
      mock.timers.tick(1);
      if (elapsed % 1_000 === 999) await flushMicrotasks();
    }
    await flushMicrotasks();
    assert.equal(settled, false, "each chunk arrives inside the idle window");
    mock.timers.tick(1);
    await flushMicrotasks();
    assert.equal(settled, true, "the total deadline fires at exactly 15 s");
    await rejectsWith(dribbled, 408, "BODY_TIMEOUT");
  } finally {
    mock.timers.reset();
  }
});

test("assertFrozenPathnames accepts only frozen, unique, absolute printable pathnames", () => {
  const valid = Object.freeze(["/api/v1/session", "/api/v1/logout"]);
  assert.equal(contract.assertFrozenPathnames(valid), valid);
  for (const [list, code] of [
    [["/api/v1/session"], "FAMILY_PATHNAMES_INVALID"],
    [Object.freeze([]), "FAMILY_PATHNAMES_INVALID"],
    ["/api/v1/session", "FAMILY_PATHNAMES_INVALID"],
    [Object.freeze(["/api/v1/session", "/api/v1/session"]), "FAMILY_PATHNAMES_DUPLICATE"],
    [Object.freeze(["api/v1/session"]), "FAMILY_PATHNAMES_INVALID"],
    [Object.freeze(["/api/v1/has space"]), "FAMILY_PATHNAMES_INVALID"],
    [Object.freeze(["/api/v1/café"]), "FAMILY_PATHNAMES_INVALID"],
    [Object.freeze(["/api/v1/session?x=1"]), "FAMILY_PATHNAMES_INVALID"],
    [Object.freeze(["/api/v1/session#x"]), "FAMILY_PATHNAMES_INVALID"],
    [Object.freeze([`/${"a".repeat(512)}`]), "FAMILY_PATHNAMES_INVALID"],
    [Object.freeze([42]), "FAMILY_PATHNAMES_INVALID"],
  ]) {
    assert.throws(() => contract.assertFrozenPathnames(list), { name: "TypeError", code });
  }
});

test("assertDispatcher requires the one-argument dispatcher shape", () => {
  const dispatcher = async (request) => new Response(String(request.url));
  assert.equal(contract.assertDispatcher(dispatcher), dispatcher);
  for (const candidate of [async () => new Response(""), async (request, context) => new Response(`${request}${context}`), null, {}]) {
    assert.throws(() => contract.assertDispatcher(candidate), { code: "FAMILY_DISPATCHER_INVALID" });
  }
});

test("validatePostClaimHandler rejects malformed plug-ins at construction", () => {
  const handle = async () => new Response("{}");
  const versions = Object.freeze(["telemetry-envelope-v0.1", "telemetry-envelope-v0.2"]);
  const validated = contract.validatePostClaimHandler({ envelopeSchemaVersions: versions, handle });
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.envelopeSchemaVersions));
  assert.deepEqual(validated.envelopeSchemaVersions, versions);
  assert.equal(validated.handle, handle);
  for (const [candidate, code] of [
    [{ envelopeSchemaVersions: versions }, "POST_CLAIM_HANDLER_INVALID"],
    [{ envelopeSchemaVersions: versions, handle: "handle" }, "POST_CLAIM_HANDLER_FUNCTION_MISSING"],
    [{ envelopeSchemaVersions: versions, handle: undefined }, "POST_CLAIM_HANDLER_FUNCTION_MISSING"],
    [{ envelopeSchemaVersions: ["telemetry-envelope-v1.1"], handle }, "POST_CLAIM_HANDLER_VERSIONS_NOT_FROZEN"],
    [{ envelopeSchemaVersions: "telemetry-envelope-v1.1", handle }, "POST_CLAIM_HANDLER_VERSIONS_NOT_FROZEN"],
    [{ envelopeSchemaVersions: Object.freeze([]), handle }, "POST_CLAIM_HANDLER_VERSIONS_INVALID"],
    [{ envelopeSchemaVersions: Object.freeze([""]), handle }, "POST_CLAIM_HANDLER_VERSIONS_INVALID"],
    [{ envelopeSchemaVersions: Object.freeze(["Telemetry Envelope"]), handle }, "POST_CLAIM_HANDLER_VERSIONS_INVALID"],
    [{ envelopeSchemaVersions: Object.freeze([12]), handle }, "POST_CLAIM_HANDLER_VERSIONS_INVALID"],
    [{ envelopeSchemaVersions: Object.freeze(["telemetry-envelope-v1.2", "telemetry-envelope-v1.2"]), handle },
      "POST_CLAIM_HANDLER_VERSION_DUPLICATE"],
    [{ envelopeSchemaVersions: versions, handle, authorize: async () => {} }, "POST_CLAIM_HANDLER_INVALID"],
    [null, "POST_CLAIM_HANDLER_INVALID"],
    [[versions, handle], "POST_CLAIM_HANDLER_INVALID"],
  ]) {
    assert.throws(() => contract.validatePostClaimHandler(candidate), { name: "TypeError", code });
  }
});

test("the post-claim registry refuses a version claimed twice and indexes the rest", () => {
  const legacy = Object.freeze({
    envelopeSchemaVersions: Object.freeze(["telemetry-envelope-v0.1", "telemetry-envelope-v0.2"]),
    handle: async () => new Response("{}"),
  });
  const v12 = Object.freeze({
    envelopeSchemaVersions: Object.freeze(["telemetry-envelope-v1.2"]),
    handle: async () => new Response("{}"),
  });
  const registry = contract.createPostClaimHandlerRegistry([legacy, v12]);
  assert.ok(Object.isFrozen(registry));
  assert.deepEqual(registry.versions,
    ["telemetry-envelope-v0.1", "telemetry-envelope-v0.2", "telemetry-envelope-v1.2"]);
  assert.equal(registry.handlerFor("telemetry-envelope-v1.2").handle, v12.handle);
  assert.equal(registry.handlerFor("telemetry-envelope-v0.2").handle, legacy.handle);
  assert.equal(registry.handlerFor("telemetry-envelope-v1.1"), undefined);
  assert.equal(registry.handlerFor(undefined), undefined);
  assert.throws(() => contract.createPostClaimHandlerRegistry([legacy, Object.freeze({
    envelopeSchemaVersions: Object.freeze(["telemetry-envelope-v0.2"]),
    handle: async () => new Response("{}"),
  })]), { code: "POST_CLAIM_HANDLER_VERSION_DUPLICATE" });
  assert.throws(() => contract.createPostClaimHandlerRegistry(legacy), { code: "POST_CLAIM_HANDLERS_INVALID" });
});

test("the production bundler resolves the contract and request-context modules", async () => {
  for (const entry of ["postgres-family-contract.mjs", "postgres-request-context.mjs"]) {
    const result = await build({
      entryPoints: [resolve(ROOT, entry)],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      write: false,
      external: ["@google-cloud/cloud-sql-connector", "google-auth-library", "jsonc-parser", "pg"],
      logLevel: "silent",
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.outputFiles.length, 1);
  }
});
