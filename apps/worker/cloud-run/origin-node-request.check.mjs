import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// CR-7 Node adapter (W3-CRA phase A): origin-node-request.mjs against the
// edge-test adapter it generalizes (origin-edge-test-mode.mjs) on one request
// table, the revision-tag Host rule, and the raw Node path over real HTTP on
// 127.0.0.1 through the real EP-6 boundary, wired as phase B's production
// serve() will be (see the W3-CRA receipt). Every token, account and host is
// synthetic; nothing listens beyond 127.0.0.1 and nothing reaches Google.

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INVOKER = "edge-invoker@synthetic-edge-0.iam.gserviceaccount.com";
const AUDIENCE = "https://origin.synthetic.example";
const PUBLIC_ORIGIN = "https://tibotattle.test";
const REQUEST_ID = "4f2c8a7e-1b3d-4e5f-9a6b-7c8d9e0f1a2b";
const RUN_APP_HOST = "tibotattle-origin-synthetic-000000000000.us-east1.run.app";
const RUN_APP_ORIGIN = `https://${RUN_APP_HOST}`;

let vite;
let node;
let edgeTest;
let edgeDispatch;
let limiters;
let contract;

before(async () => {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  const load = (path) => vite.ssrLoadModule(path);
  [node, edgeTest, edgeDispatch, limiters, contract] = await Promise.all([
    load("/cloud-run/origin-node-request.mjs"),
    load("/cloud-run/origin-edge-test-mode.mjs"),
    load("/cloud-run/postgres-edge-origin-dispatch.mjs"),
    load("/cloud-run/postgres-edge-admission-limiters.mjs"),
    load("/src/edge-origin-contract.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: AUDIENCE, email: INVOKER, email_verified: true, exp: now + 3_000, iat: now - 60,
    iss: "https://accounts.google.com", sub: "100000000000000000000", ...overrides,
  };
  const header = base64UrlJson({ alg: "RS256", kid: "0".repeat(40), typ: "JWT" });
  return `Bearer ${header}.${base64UrlJson(payload)}.SIGNATURE_REMOVED_BY_GOOGLE`;
}

/** A fake IncomingMessage for the pure adapter paths. */
function fake(url, host, { method = "GET", rawHeaders } = {}) {
  return {
    headers: host === null ? {} : { host },
    rawHeaders: rawHeaders ?? (host === null ? [] : ["Host", host]),
    url,
    method,
    once() {},
  };
}

const RES = Object.freeze({ once() {}, writableEnded: false });

/** The outcome of one adapter on one request: the built URL, or the refusal reason. */
function outcome(build) {
  try {
    const request = build();
    return { url: request.url, method: request.method, body: request.body === null ? null : "stream",
      headers: [...request.headers] };
  } catch (error) {
    return { reason: error.reason, code: error.code };
  }
}

// ---------------------------------------------------------------------------
// One table, both adapters

test("constants: the same refusal vocabulary as the edge-test adapter, disjoint from EP-6's", () => {
  assert.deepEqual([...node.ORIGIN_REQUEST_REFUSAL_REASONS], [...edgeTest.EDGE_TEST_REQUEST_REFUSAL_REASONS]);
  assert.equal(node.ORIGIN_BOUNDARY_REFUSAL_EVENT, edgeTest.EDGE_ORIGIN_BOUNDARY_REFUSAL_EVENT);
  assert.equal(node.ORIGIN_LINGER_MAX_MILLISECONDS, edgeTest.EDGE_TEST_LINGER_MAX_MILLISECONDS);
  for (const reason of node.ORIGIN_REQUEST_REFUSAL_REASONS) {
    assert.equal(edgeDispatch.EDGE_ORIGIN_BOUNDARY_REFUSAL_REASONS.includes(reason), false, reason);
  }
  // Phase A keeps one definition of the marker read (the header ratchet reviews it per file).
  assert.equal(node.isEdgeOriginBoundaryRefusal, edgeTest.isEdgeOriginBoundaryRefusal);
});

test("both adapters build the same Request or refuse with the same reason on one table", () => {
  const hostOrigin = "http://127.0.0.1:43020";
  const longest = `/${"q".repeat(16_384 - hostOrigin.length - 1)}`;
  const table = [
    ["plain GET", fake("/api/health", "127.0.0.1:43020"), { hostOrigin }],
    ["query kept", fake("/api/v1/device/sync/state?x=1&y=%20", "127.0.0.1:43020"), { hostOrigin }],
    ["'//host' stays a path", fake("//evil.example/x", "127.0.0.1:43020"), { hostOrigin }],
    ["longest target", fake(longest, "127.0.0.1:43020"), { hostOrigin }],
    ["Host case-insensitive", fake("/api/health", "LocalHost:43020"), { hostOrigin: "http://localhost:43020" }],
    ["POST without a body", fake("/api/v1/contributions", "127.0.0.1:43020", { method: "POST" }), { hostOrigin }],
    ["raw headers joined", fake("/api/health", "127.0.0.1:43020", { rawHeaders: ["Host", "127.0.0.1:43020",
      "x-tibotattle-edge-host", "apex", "x-tibotattle-edge-host", "admin", "cf-connecting-ip", "203.0.113.9"] }),
    { hostOrigin }],
    ["too long", fake(`${longest}q`, "127.0.0.1:43020"), { hostOrigin }],
    ["asterisk", fake("*", "127.0.0.1:43020"), { hostOrigin }],
    ["absolute", fake("http://evil.example/x", "127.0.0.1:43020"), { hostOrigin }],
    ["missing Host", fake("/api/health", null), { hostOrigin }],
    ["other port", fake("/api/health", "127.0.0.1:43021"), { hostOrigin }],
    ["other host", fake("/api/health", "tibotattle.test"), { hostOrigin }],
    ["origin with a path", fake("/api/health", "127.0.0.1:43020"), { hostOrigin: `${hostOrigin}/` }],
    ["no origin", fake("/api/health", "127.0.0.1:43020"), {}],
    ["bad raw header", fake("/api/health", "127.0.0.1:43020", { rawHeaders: ["Host", "127.0.0.1:43020", "bad name", "x"] }),
      { hostOrigin }],
    ["TRACE", fake("/api/health", "127.0.0.1:43020", { method: "TRACE" }), { hostOrigin }],
    ["run.app GET", fake("/api/ready", RUN_APP_HOST), { hostOrigin: RUN_APP_ORIGIN }],
    ["run.app tag without opt-in", fake("/api/ready", `blue---${RUN_APP_HOST}`), { hostOrigin: RUN_APP_ORIGIN }],
  ];
  const reasons = new Set();
  for (const [label, req, options] of table) {
    const original = outcome(() => edgeTest.edgeTestRequestFromNode(req, RES, options));
    const generalized = outcome(() => node.originRequestFromNode(req, RES, options));
    if (original.reason !== undefined) {
      assert.equal(original.code, "EDGE_TEST_ORIGIN_BOUNDARY_REFUSED", label);
      assert.equal(generalized.code, "ORIGIN_REQUEST_BOUNDARY_REFUSED", label);
      assert.equal(generalized.reason, original.reason, label);
      reasons.add(generalized.reason);
    } else {
      assert.deepEqual(generalized, original, label);
    }
  }
  assert.deepEqual([...reasons].sort(), node.ORIGIN_REQUEST_REFUSAL_REASONS
    .filter((reason) => !["request_target_unparseable", "request_target_origin"].includes(reason)).sort());
});

test("originRequestFromNode refuses a non-http(s) HOST_ORIGIN the edge-test adapter never sees", () => {
  for (const hostOrigin of ["ftp://127.0.0.1:43020", "file:///tmp", "data:,x"]) {
    assert.throws(() => node.originRequestFromNode(fake("/api/health", "127.0.0.1:43020"), RES, { hostOrigin }),
      (error) => error instanceof node.OriginBoundaryRefusal && error.reason === "host_origin_invalid", hostOrigin);
  }
});

test("revision tags: '<tag>---<host>' only with acceptRevisionTags on an https origin", () => {
  const options = { hostOrigin: RUN_APP_ORIGIN, acceptRevisionTags: true };
  for (const tag of ["a", "blue", "candidate-2", "r1", `a${"b".repeat(44)}c`, "Green"]) {
    const request = node.originRequestFromNode(fake("/api/health?probe=1", `${tag}---${RUN_APP_HOST}`), RES, options);
    assert.equal(request.url, `${RUN_APP_ORIGIN}/api/health?probe=1`, tag);
  }
  assert.equal(node.originRequestFromNode(fake("/api/health", RUN_APP_HOST), RES, options).url,
    `${RUN_APP_ORIGIN}/api/health`);
  for (const host of [
    `---${RUN_APP_HOST}`,
    `1blue---${RUN_APP_HOST}`,
    `blue----${RUN_APP_HOST}`.replace("----", "-----"),
    `blue----${RUN_APP_HOST}`,
    `blue_1---${RUN_APP_HOST}`,
    `blue.x---${RUN_APP_HOST}`,
    `a${"b".repeat(45)}c---${RUN_APP_HOST}`,
    `blue--${RUN_APP_HOST}`,
    `blue---${RUN_APP_HOST}.evil.example`,
    `blue---evil.example`,
    `blue---${RUN_APP_HOST}:443`,
    `blue.${RUN_APP_HOST}`,
  ]) {
    assert.throws(() => node.originRequestFromNode(fake("/api/health", host), RES, options),
      (error) => error instanceof node.OriginBoundaryRefusal && error.reason === "host_mismatch", host);
  }
  // Without the opt-in, or on a loopback http origin, a tag is a mismatch.
  assert.throws(() => node.originRequestFromNode(fake("/api/health", `blue---${RUN_APP_HOST}`), RES,
    { hostOrigin: RUN_APP_ORIGIN }), { reason: "host_mismatch" });
  assert.throws(() => node.originRequestFromNode(fake("/api/health", "blue---127.0.0.1:43020"), RES,
    { hostOrigin: "http://127.0.0.1:43020", acceptRevisionTags: true }), { reason: "host_mismatch" });
});

test("the refusal log line and the written 421 are byte-identical to the edge-test ones", () => {
  const diagnostics = [
    { reason: "host_mismatch" },
    new node.OriginBoundaryRefusal("request_target_invalid"),
    { reason: "invoker_segments", invokerShape: { bearerPrefix: true, scheme: "Bearer", separatorSpaces: 1,
      segments: 2, segmentEmpty: [false, true], segmentBase64url: [true, false], signatureRemovedByGoogle: false,
      token: "must-not-appear" } },
    { reason: "email_mismatch", invokerShape: { scheme: "weird", separatorSpaces: 99, segments: -1 } },
    { reason: "host_mismatch", invokerShape: { bearerPrefix: true } },
    { reason: "not-a-reason", host: "evil.example" },
    null,
    "host_mismatch",
  ];
  for (const diagnostic of diagnostics) {
    assert.equal(node.originBoundaryRefusalLogLine(diagnostic), edgeTest.edgeTestBoundaryRefusalLogLine(diagnostic));
    assert.doesNotMatch(node.originBoundaryRefusalLogLine(diagnostic), /must-not-appear|evil\.example/u);
  }
  const lines = [];
  node.logOriginBoundaryRefusal({ reason: "host_mismatch" }, (line) => lines.push(line));
  node.logOriginBoundaryRefusal({ reason: "host_mismatch" }, () => { throw new Error("sink down"); });
  assert.deepEqual(lines, ["{\"event\":\"edge_origin_boundary_refusal\",\"reason\":\"host_mismatch\"}"]);
  const written = [];
  const capture = () => ({
    writeHead(status, headers) { written.push({ status, headers: { ...headers } }); },
    end(body) { written.at(-1).body = body; },
  });
  node.writeOriginBoundaryRefusal(capture());
  edgeTest.writeEdgeTestBoundaryRefusal(capture());
  assert.deepEqual(written[0], written[1]);
  assert.equal(written[0].status, 421);
  assert.equal(written[0].headers.connection, "close");
  assert.equal(written[0].body, contract.ORIGIN_BOUNDARY_ERROR_BODY);
});

// ---------------------------------------------------------------------------
// Real HTTP on 127.0.0.1, wired as phase B's production serve()

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/** A chunked body's payload, or null while the last chunk has not arrived. */
function dechunk(raw) {
  let rest = raw;
  let payload = Buffer.alloc(0);
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd < 0) return null;
    const size = Number.parseInt(rest.subarray(0, lineEnd).toString("latin1"), 16);
    if (!Number.isSafeInteger(size)) throw new Error("invalid chunk size");
    if (size === 0) return rest.length >= lineEnd + 4 ? payload : null;
    if (rest.length < lineEnd + 2 + size + 2) return null;
    payload = Buffer.concat([payload, rest.subarray(lineEnd + 2, lineEnd + 2 + size)]);
    rest = rest.subarray(lineEnd + 2 + size + 2);
  }
}

/** One HTTP/1.1 exchange over a raw socket; resolves with the parsed response. */
function exchange(port, { method = "GET", target = "/api/health", headers = [], body = null, holdOpen = false }) {
  return new Promise((resolveExchange, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let data = Buffer.alloc(0);
    let settled = false;
    const finish = () => {
      if (settled) return;
      const text = data.toString("latin1");
      const split = text.indexOf("\r\n\r\n");
      if (split < 0) return;
      const head = text.slice(0, split).split("\r\n");
      const status = Number(head[0].split(" ")[1]);
      const responseHeaders = new Map();
      for (const line of head.slice(1)) {
        const index = line.indexOf(":");
        responseHeaders.set(line.slice(0, index).toLowerCase(), line.slice(index + 1).trim());
      }
      const length = Number(responseHeaders.get("content-length") ?? Number.NaN);
      const raw = data.subarray(Buffer.byteLength(text.slice(0, split + 4), "latin1"));
      let bodyText = raw.toString("utf8");
      if (responseHeaders.get("transfer-encoding") === "chunked") {
        const payload = dechunk(raw);
        if (payload === null) return;
        bodyText = payload.toString("utf8");
      } else if (Number.isFinite(length) && raw.length < length) {
        return;
      }
      settled = true;
      resolveExchange({ status, headers: responseHeaders, text: bodyText, socket });
    };
    socket.on("data", (chunk) => { data = Buffer.concat([data, chunk]); finish(); });
    socket.on("end", finish);
    socket.on("close", () => {
      finish();
      if (!settled) reject(new Error("socket closed before a full response"));
    });
    socket.on("error", (error) => {
      finish();
      if (!settled) reject(error);
    });
    const lines = [`${method} ${target} HTTP/1.1`, ...headers.map(([name, value]) => `${name}: ${value}`)];
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (body !== null) socket.write(body);
    if (!holdOpen) socket.end();
  });
}

/**
 * The production serve() loop phase B adds to server.mjs, reduced to the
 * adapter calls: build the Request (refusal: log + 421), run EP-6 (its
 * unmarked 421: cancel + 421), else linger and write the response.
 */
async function withProductionServe(inner, work, { hostOrigin } = {}) {
  const port = await freePort();
  const lines = [];
  const log = (line) => lines.push(line);
  const origin = hostOrigin ?? `http://127.0.0.1:${port}`;
  const boundary = edgeDispatch.createEdgeOriginDispatch({
    invokerServiceAccount: INVOKER,
    verifierServiceAccounts: [],
    audience: AUDIENCE,
    publicOrigin: PUBLIC_ORIGIN,
    admission: limiters.createEdgeAdmissionLimiters(),
    inner,
    onRefusal: (diagnostic) => node.logOriginBoundaryRefusal(diagnostic, log),
  });
  const server = http.createServer(async (req, res) => {
    let request;
    try {
      request = node.originRequestFromNode(req, res, { hostOrigin: origin, acceptRevisionTags: true });
    } catch (error) {
      if (!(error instanceof node.OriginBoundaryRefusal)) throw error;
      node.logOriginBoundaryRefusal(error, log);
      node.writeOriginBoundaryRefusal(res);
      return;
    }
    const response = await boundary(request);
    if (node.isEdgeOriginBoundaryRefusal(response)) {
      await response.body?.cancel().catch(() => undefined);
      node.writeOriginBoundaryRefusal(res);
      return;
    }
    node.lingerAfterEarlyAnswer(req);
    const headers = {};
    for (const [name, value] of response.headers) headers[name] = value;
    res.writeHead(response.status, headers);
    if (response.body === null) res.end();
    else await pipeline(Readable.fromWeb(response.body), res);
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  try {
    return await work({ port, lines, host: hostOrigin === undefined ? `127.0.0.1:${port}` : new URL(hostOrigin).host });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

function invokerHeaders() {
  return [["x-serverless-authorization", token()], ["x-tibotattle-edge-host", "apex"],
    ["x-tibotattle-edge-request-id", REQUEST_ID]];
}

function assertBoundaryRefusal(response, label) {
  assert.equal(response.status, 421, label);
  assert.equal(response.text, contract.ORIGIN_BOUNDARY_ERROR_BODY, label);
  assert.equal(response.headers.get("connection"), "close", label);
  assert.equal(response.headers.get("cache-control"), "no-store", label);
  assert.equal(response.headers.has("x-tibotattle-origin"), false, label);
}

test("real HTTP: wrong Host, absolute target and EP-6 refusals are the unmarked 421 with the body unread", async () => {
  const seen = [];
  await withProductionServe(async (request) => {
    seen.push(new URL(request.url).pathname);
    return Response.json({ ok: true });
  }, async ({ port, host, lines }) => {
    const chunked = [["content-type", "application/json"], ["transfer-encoding", "chunked"]];
    for (const [label, options] of [
      ["wrong Host", { headers: [["host", "tibotattle.test"], ...invokerHeaders()] }],
      ["absolute target", { target: `http://${host}/api/health`, headers: [["host", host], ...invokerHeaders()] }],
      ["no token", { method: "POST", target: "/api/v1/contributions", holdOpen: true,
        body: "10\r\n{\"synthetic\":tru\r\n",
        headers: [["host", host], ...chunked, ["x-tibotattle-edge-host", "apex"],
          ["x-tibotattle-edge-request-id", REQUEST_ID]] }],
      ["stranger", { method: "POST", target: "/api/v1/contributions", holdOpen: true,
        body: "10\r\n{\"synthetic\":tru\r\n",
        headers: [["host", host], ...chunked, ["x-serverless-authorization", token({ email: "stranger@synthetic-edge-0.iam.gserviceaccount.com" })],
          ["x-tibotattle-edge-host", "apex"], ["x-tibotattle-edge-request-id", REQUEST_ID]] }],
    ]) {
      const response = await exchange(port, options);
      assertBoundaryRefusal(response, label);
      if (options.holdOpen) {
        // The refusal arrived while the body was still incomplete; the origin closes.
        await new Promise((done) => {
          if (response.socket.destroyed || response.socket.readableEnded) done();
          else response.socket.once("close", done);
        });
      }
    }
    // The same request with the right Host and token reaches inner, marked.
    const admitted = await exchange(port, { headers: [["host", host], ...invokerHeaders()] });
    assert.equal(admitted.status, 200);
    assert.equal(admitted.headers.get("x-tibotattle-origin"), "1");
    assert.deepEqual(lines.map((line) => JSON.parse(line).reason),
      ["host_mismatch", "request_target_invalid", "invoker_header_missing", "email_mismatch"]);
    for (const line of lines) assert.doesNotMatch(line, /tibotattle\.test|stranger|synthetic-edge/u);
  });
  assert.deepEqual(seen, ["/api/health"]);
});

test("real HTTP: a Cloud Run revision-tag Host reaches inner on the canonical origin", async () => {
  const seen = [];
  await withProductionServe(async (request) => {
    seen.push(request.url);
    return Response.json({ ok: true });
  }, async ({ port }) => {
    const tagged = await exchange(port, { target: "/api/ready", headers: [["host", `candidate---${RUN_APP_HOST}`],
      ...invokerHeaders()] });
    assert.equal(tagged.status, 200);
    assert.equal(tagged.headers.get("x-tibotattle-origin"), "1");
    const plain = await exchange(port, { target: "/api/ready", headers: [["host", RUN_APP_HOST], ...invokerHeaders()] });
    assert.equal(plain.status, 200);
    assertBoundaryRefusal(await exchange(port, { target: "/api/ready",
      headers: [["host", `cand_idate---${RUN_APP_HOST}`], ...invokerHeaders()] }), "bad tag");
  }, { hostOrigin: RUN_APP_ORIGIN });
  // EP-6 rebuilds every admitted request on the public origin.
  assert.deepEqual(seen, [`${PUBLIC_ORIGIN}/api/ready`, `${PUBLIC_ORIGIN}/api/ready`]);
});

test("real HTTP: an early answer to a chunked body inner stops reading reaches the caller", async () => {
  const limit = 2 * 1024 * 1024;
  let readBytes = 0;
  await withProductionServe(async (request) => {
    const reader = request.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      readBytes += value.byteLength;
      if (readBytes > limit) {
        await reader.cancel();
        return Response.json({ error: { code: "BODY_TOO_LARGE" } }, { status: 413 });
      }
    }
    return Response.json({ read: readBytes });
  }, async ({ port, host }) => {
    const send = (total) => new Promise((resolveSend, reject) => {
      const outgoing = http.request({
        host: "127.0.0.1", port, method: "POST", path: "/api/v1/contributions", agent: false,
        headers: { host, "content-type": "application/json", "transfer-encoding": "chunked",
          "x-serverless-authorization": token(), "x-tibotattle-edge-host": "apex",
          "x-tibotattle-edge-request-id": REQUEST_ID, "x-tibotattle-edge-admission": "v1;upload_ingress;allowed" },
      });
      let answer = null;
      outgoing.on("response", (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          answer = { status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") };
          resolveSend(answer);
        });
      });
      outgoing.on("error", (error) => { if (answer === null) reject(error); });
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      let sent = 0;
      const pump = () => {
        while (sent < total) {
          sent += chunk.length;
          if (!outgoing.write(chunk)) { outgoing.once("drain", pump); return; }
        }
        outgoing.end();
      };
      pump();
    });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      readBytes = 0;
      const refused = await send(3 * 1024 * 1024);
      assert.equal(refused.status, 413, `attempt ${attempt}`);
      assert.equal(JSON.parse(refused.text).error.code, "BODY_TOO_LARGE");
    }
    readBytes = 0;
    const accepted = await send(1024 * 1024);
    assert.equal(accepted.status, 200);
    assert.equal(JSON.parse(accepted.text).read, 1024 * 1024);
  });
});
