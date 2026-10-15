import assert from "node:assert/strict";
import test from "node:test";
import { createLocalRequestClient, mountLocalAuthorization } from "../public/local-request.js";
import { CommunityClient, LocalCompanionClient } from "../public/data-client.js";
import { translate } from "../public/localization.js";

const ORIGIN = "http://127.0.0.1:48763";
const NOW = 1_800_000_000_000;
const CAPABILITY = "a".repeat(43);
const OPERATION = "b".repeat(43);
const CONTINUATION = "c".repeat(43);
const CAPABILITY_HEADER = "X-TiboTattle-Local-Capability";
const OPERATION_HEADER = "X-TiboTattle-Operation-Authorization";
const CONTINUATION_HEADER = "X-TiboTattle-Enrollment-Continuation";
const json = (value, init) => Response.json(value, init);
function file(overrides = {}) {
  const text = JSON.stringify({ version: 1, origin: ORIGIN, capability: CAPABILITY, expiresAt: NOW + 60_000, ...overrides });
  return { size: text.length, text: async () => text };
}
function client(fetchImpl, extra = {}) {
  return createLocalRequestClient({ fetchImpl, origin: ORIGIN, nativeAuthorization: () => false, now: () => NOW, ...extra });
}

test("private requests stay locked until an exact fresh owner-selected file is verified", async () => {
  const calls = [];
  const boundary = client(async (url, options) => { calls.push({ url, options }); return json({}); });
  assert.equal(boundary.needsAuthorization(), true);
  await assert.rejects(boundary.request("/api/local/overview"), { code: "local_caller_not_authorized" });
  assert.equal(calls.length, 0);
  for (const bad of [file({ version: 2 }), file({ origin: "http://127.0.0.1:48764" }),
    file({ extra: true }), file({ capability: "short" }), file({ expiresAt: NOW }),
    file({ expiresAt: NOW + 1_000_000 }), { size: 2048, text: async () => assert.fail("oversized file read") },
    { size: 1, text: async () => "x".repeat(2048) }, { size: 5, text: async () => "[bad" }]) {
    await assert.rejects(boundary.authorizeFile(bad), { code: "local_caller_not_authorized" });
  }
  assert.equal(calls.length, 0);
  await boundary.authorizeFile(file());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/local/health");
  assert.equal(calls[0].options.headers.get(CAPABILITY_HEADER), CAPABILITY);
  assert.equal(boundary.needsAuthorization(), false);
  assert.doesNotMatch(JSON.stringify(boundary), /aaaaa/u);
});

test("a fresh one-use authorization precedes each mutation and keeps existing request contracts", async () => {
  const calls = [];
  let sequence = 0;
  const boundary = client(async (url, options) => {
    calls.push({ url, options });
    return json(url === "/api/local/authorization" ? { authorization: `${++sequence}`.padEnd(43, "b") } : {});
  });
  await boundary.authorizeFile(file());
  const service = new LocalCompanionClient({ fetchImpl: boundary.request });
  await service.refresh();
  await service.refresh();
  assert.deepEqual(calls.map(({ url }) => url), ["/api/local/health", "/api/local/authorization", "/api/local/refresh/quick", "/api/local/authorization", "/api/local/refresh/quick"]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { method: "POST", path: "/api/local/refresh/quick" });
  assert.equal(calls[2].options.headers.get("X-Usage-Monitor-Local"), "1");
  assert.equal(calls[2].options.headers.get("Content-Type"), "application/json");
  assert.notEqual(calls[2].options.headers.get(OPERATION_HEADER), calls[4].options.headers.get(OPERATION_HEADER));
  for (const { options } of calls) {
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.headers.get(CAPABILITY_HEADER), CAPABILITY);
  }
});

test("denied or malformed operation authorization never sends or retries a mutation", async () => {
  for (const response of [json({ error: { code: "local_operation_not_authorized" } }, { status: 403 }),
    json({ authorization: OPERATION, extra: true }), json({ authorization: 1 })]) {
    const paths = [];
    const boundary = client(async (url) => { paths.push(url); return url.endsWith("authorization") ? response : json({}); });
    await boundary.authorizeFile(file());
    await boundary.request("/api/local/refresh", { method: "POST" }).catch(() => {});
    assert.deepEqual(paths, ["/api/local/health", "/api/local/authorization"]);
  }
});

test("capabilities stay at their origin and private reports use the same boundary", async () => {
  const calls = [];
  const boundary = client(async (url, options) => { calls.push({ url, options }); return json({}); });
  await boundary.authorizeFile(file());
  for (const target of ["https://example.test/api/local/overview", "http://127.0.0.1:48764/api/local/overview", "http://user@127.0.0.1:48763/api/local/overview", "/api/local/overview#fragment"]) {
    await assert.rejects(boundary.request(target));
  }
  assert.equal(calls.length, 1);
  await boundary.request("/reports/weekly");
  assert.equal(calls[1].options.headers.get(CAPABILITY_HEADER), CAPABILITY);
  assert.equal(calls[1].options.headers.has(OPERATION_HEADER), false);
});

test("restart rejection clears only the launch capability and requires an explicit fresh file", async () => {
  let denied = false;
  let required = 0;
  const boundary = client(async () => denied
    ? json({ error: { code: "local_caller_not_authorized" } }, { status: 403 }) : json({}),
  { onAuthorizationRequired: () => required++ });
  await boundary.authorizeFile(file());
  denied = true;
  assert.equal((await boundary.request("/api/local/overview")).status, 403);
  assert.equal(boundary.needsAuthorization(), true);
  assert.equal(required, 1);
  await assert.rejects(boundary.request("/api/local/overview"), { code: "local_caller_not_authorized" });
  await assert.rejects(boundary.authorizeFile(file()), { code: "local_caller_not_authorized" });
});

test("Electron uses native header injection while hosted clients keep their existing contract", async () => {
  const calls = [];
  const boundary = client(async (url, options) => {
    calls.push({ url, options });
    return json({ authorization: OPERATION });
  }, { nativeAuthorization: () => true });
  assert.equal(boundary.needsAuthorization(), false);
  await boundary.request("/api/local/work-usage/query", { method: "POST", body: "{}" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.has(CAPABILITY_HEADER), false);
  assert.equal(calls[1].options.headers.has(CAPABILITY_HEADER), false);
  assert.equal(calls[1].options.headers.get(OPERATION_HEADER), OPERATION);
  const hosted = createLocalRequestClient({ origin: "https://example.test", fetchImpl: async (_url, options) => options });
  assert.equal(hosted.needsAuthorization(), false);
  assert.deepEqual(await hosted.request("/api/v1/session", { credentials: "same-origin" }), { credentials: "same-origin" });
});

test("an older denied response cannot clear a newly selected launch capability", async () => {
  let finishOldRequest;
  const boundary = client(async (url) => url === "/api/local/overview"
    ? new Promise((resolve) => { finishOldRequest = resolve; }) : json({}));
  await boundary.authorizeFile(file());
  const previous = boundary.request("/api/local/overview");
  await boundary.authorizeFile(file({ capability: "d".repeat(43) }));
  finishOldRequest(json({ error: { code: "local_caller_not_authorized" } }, { status: 403 }));
  await previous;
  assert.equal(boundary.needsAuthorization(), false);
});

test("a delayed earlier file selection cannot overwrite or clear a later successful selection", async () => {
  const headers = [];
  let finishEarlierRead;
  const boundary = client(async (_url, options) => { headers.push(options.headers.get(CAPABILITY_HEADER)); return json({}); });
  const earlier = boundary.authorizeFile({ size: 200, text: () => new Promise((resolve) => { finishEarlierRead = resolve; }) });
  await boundary.authorizeFile(file({ capability: "d".repeat(43) }));
  finishEarlierRead(await file().text());
  await assert.rejects(earlier, { code: "local_caller_not_authorized" });
  await boundary.request("/api/local/overview");
  assert.equal(boundary.needsAuthorization(), false);
  assert.deepEqual(headers, ["d".repeat(43), "d".repeat(43)]);
});

test("native authorization denial never triggers the standalone browser reload event", async () => {
  let required = 0;
  let calls = 0;
  const boundary = client(async () => {
    calls += 1;
    return json({ error: { code: "local_caller_not_authorized" } }, { status: 403 });
  }, { nativeAuthorization: () => true, onAuthorizationRequired: () => required++ });
  assert.equal((await boundary.request("/api/local/overview")).status, 403);
  assert.equal(required, 0);
  assert.equal(calls, 1);
});

test("aborted authorization and a failed mutation have no automatic replay", async () => {
  const calls = [];
  const abort = new AbortController();
  const boundary = client(async (url, options) => {
    calls.push(url);
    if (url === "/api/local/authorization") {
      assert.equal(options.signal, abort.signal);
      return json({ authorization: OPERATION });
    }
    if (url === "/api/local/refresh") throw new Error("synthetic connection closed");
    return json({});
  });
  await boundary.authorizeFile(file());
  await assert.rejects(boundary.request("/api/local/refresh", { method: "POST", signal: abort.signal }));
  assert.deepEqual(calls, ["/api/local/health", "/api/local/authorization", "/api/local/refresh"]);
  const aborted = client(async (url, options) => {
    if (url === "/api/local/authorization") { assert.equal(options.signal.aborted, true); throw new Error("aborted"); }
    assert.equal(url, "/api/local/health");
    return json({});
  });
  await aborted.authorizeFile(file());
  abort.abort();
  await assert.rejects(aborted.request("/api/local/refresh", { method: "POST", signal: abort.signal }));
});

test("enrollment continuation is consumed by one immediate pairing attempt and never other routes", async () => {
  const calls = [];
  const community = new CommunityClient({ getCsrfToken: () => "synthetic-csrf", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return json({}, url === "/api/v1/enroll" ? { headers: { [CONTINUATION_HEADER]: CONTINUATION } } : undefined);
  } });
  await community.enroll();
  assert.doesNotMatch(JSON.stringify(community), /ccccc/u);
  await community.createDevicePairing();
  await community.createDevicePairing();
  assert.equal(calls[1].options.headers[CONTINUATION_HEADER], CONTINUATION);
  assert.equal(calls[2].options.headers[CONTINUATION_HEADER], undefined);
  await community.enroll();
  await community.session();
  await community.createDevicePairing();
  assert.equal(calls[4].options.headers[CONTINUATION_HEADER], undefined);
  assert.equal(calls[5].options.headers[CONTINUATION_HEADER], undefined);
});

test("racing and failed enrollment cannot revive an unrelated continuation", async () => {
  let finishEnrollment;
  const calls = [];
  const community = new CommunityClient({ getCsrfToken: () => "synthetic-csrf", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/v1/enroll") return new Promise((resolve) => { finishEnrollment = resolve; });
    return json({});
  } });
  const enrollment = community.enroll();
  await community.session();
  finishEnrollment(json({}, { headers: { [CONTINUATION_HEADER]: CONTINUATION } }));
  await enrollment;
  await community.createDevicePairing();
  assert.equal(calls.at(-1).options.headers[CONTINUATION_HEADER], undefined);
  const malformed = new CommunityClient({ getCsrfToken: () => "synthetic-csrf", fetchImpl: async (url, options) => {
    if (url === "/api/v1/enroll") return new Response("invalid", { headers: { [CONTINUATION_HEADER]: CONTINUATION } });
    assert.equal(options.headers[CONTINUATION_HEADER], undefined);
    return json({});
  } });
  await assert.rejects(malformed.enroll());
  await malformed.createDevicePairing();
});

test("standalone unlock dialog renders fixed localized text and never exposes selected file contents", async () => {
  const nodes = [];
  const makeNode = (tag) => {
    const listeners = {};
    const node = { tag, children: [], attributes: {}, textContent: "", listeners,
      append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { listeners[name] = callback; },
      click() {}, focus() {}, showModal() { this.open = true; }, close() { this.open = false; }, remove() { this.removed = true; },
    };
    nodes.push(node);
    return node;
  };
  let unlocked = false;
  const ui = mountLocalAuthorization({
    documentRef: { createElement: makeNode, body: makeNode("body") },
    windowRef: { addEventListener() {}, removeEventListener() {} },
    client: { needsAuthorization: () => !unlocked, authorizeFile: async () => { unlocked = true; } },
    t: (key) => translate(key, {}, "es"),
  });
  const pending = ui.authorize();
  assert.equal(ui.authorize(), pending);
  const input = nodes.find(({ tag }) => tag === "input");
  const dialog = nodes.find(({ tag }) => tag === "dialog");
  assert.equal(input.hidden, true);
  assert.equal(dialog.open, true);
  input.files = [file()];
  await input.listeners.change();
  await pending;
  assert.equal(input.value, "");
  assert.equal(dialog.removed, true);
  assert.match(nodes.find(({ tag }) => tag === "h2").textContent, /Desbloquea/u);
  assert.doesNotMatch(nodes.map(({ textContent }) => textContent).join(" "), /aaaaa|48763/u);
});
