// Offline checks for scripts/edge-live-check.mjs: no gcloud, no network, no
// Miniflare. plan runs nothing; run refuses before any process or request
// unless the exact authorization, the pinned origin and invoker and every
// input are given; a missing gcloud refuses; the identity token never reaches
// stdout, stderr, the receipt or an error; outbound traffic is limited to the
// token endpoint and the pinned origin host.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EDGE_LIVE_CHECK_AUTHORIZATIONS,
  EDGE_LIVE_CHECK_INVOKER,
  EDGE_LIVE_CHECK_ORIGIN,
  EdgeLiveCheckError,
  createLiveOutboundGuard,
  liveCheckPlan,
  main,
  mintLiveIdentityToken,
} from "./edge-live-check.mjs";
import { createGoogleFrontEnd, createSyntheticServiceAccountKey } from "./edge-e2e/google-front-end.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = resolve(WORKER_ROOT, "analytics-v2-test", "golden");

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A JWT-shaped synthetic token with a unique, greppable signature segment. */
function syntheticToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1_000);
  return `${base64UrlJson({ alg: "RS256", kid: "synthetic", typ: "JWT" })}.${base64UrlJson({
    aud: EDGE_LIVE_CHECK_ORIGIN, email: EDGE_LIVE_CHECK_INVOKER, email_verified: true, exp: now + 3_600, iat: now,
    iss: "https://accounts.google.com", sub: "100000000000000000000", ...overrides,
  })}.SYNTHETICLIVECHECKTOKENSIGNATUREDONOTLEAK`;
}

/** A spawn stub: records argv; `--version` exits 0; the token command prints `output`. */
function spawnStub({ output = syntheticToken(), missing = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, shell: options?.shell });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (missing) {
        child.emit("error", Object.assign(new Error("spawn gcloud ENOENT"), { code: "ENOENT" }));
        return;
      }
      if (args[0] === "auth") child.stdout.emit("data", Buffer.from(`${output}\n`));
      child.emit("close", 0);
    });
    return child;
  };
  return { spawn, calls };
}

const forbidden = () => { throw new Error("must not be called"); };

function sink() {
  const chunks = [];
  return { write: (chunk) => { chunks.push(String(chunk)); return true; }, text: () => chunks.join("") };
}

function runArgs(overrides = {}) {
  const values = {
    authorize: EDGE_LIVE_CHECK_AUTHORIZATIONS.readOnly, "origin-url": EDGE_LIVE_CHECK_ORIGIN,
    invoker: EDGE_LIVE_CHECK_INVOKER, "expected-body-sha": "a".repeat(64), out: "/nonexistent/receipts",
    golden: GOLDEN, ...overrides,
  };
  return ["run", ...Object.entries(values).filter(([, value]) => value !== undefined)
    .map(([name, value]) => `--${name}=${value}`)];
}

test("plan prints the steps and commands and runs nothing", async () => {
  const stdout = sink();
  const result = await main(["plan"], { stdout, spawn: forbidden, fetch: forbidden, startEdge: forbidden });
  assert.equal(result, null);
  assert.match(stdout.text(), /plan only/u);
  assert.match(stdout.text(), /gcloud auth print-identity-token --impersonate-service-account=/u);
  assert.match(stdout.text(), /--authorize=EDGE_LIVE_CHECK_READ_ONLY/u);
  assert.match(stdout.text(), /--origin-variant=direct/u);
  assert.equal(await main([], { stdout: sink(), spawn: forbidden, fetch: forbidden, startEdge: forbidden }), null,
    "plan is the default");
  assert.equal(liveCheckPlan().includes("EDGE_LIVE_CHECK_WRITES"), true);
});

test("run refuses without the exact authorization or pinned inputs, before any process or request", async () => {
  for (const [label, overrides, code] of [
    ["no authorization", { authorize: undefined }, "EDGE_LIVE_CHECK_AUTHORIZATION_REQUIRED"],
    ["wrong case", { authorize: "edge_live_check_read_only" }, "EDGE_LIVE_CHECK_AUTHORIZATION_REQUIRED"],
    ["other token", { authorize: "YES" }, "EDGE_LIVE_CHECK_AUTHORIZATION_REQUIRED"],
    ["other origin", { "origin-url": "https://tibotattle-other-origin-000000000000.us-east1.run.app" },
      "EDGE_LIVE_CHECK_ORIGIN_NOT_PINNED"],
    ["other invoker", { invoker: "someone-else@tibotattle.iam.gserviceaccount.com" }, "EDGE_LIVE_CHECK_INVOKER_NOT_PINNED"],
    ["other audience", { audience: "https://other.example" }, "EDGE_LIVE_CHECK_AUDIENCE_NOT_PINNED"],
    ["no expected sha", { "expected-body-sha": undefined }, "EDGE_LIVE_CHECK_EXPECTED_SHA_REQUIRED"],
    ["no receipt directory", { out: undefined }, "EDGE_LIVE_CHECK_OUT_REQUIRED"],
    ["no golden", { golden: undefined }, "EDGE_LIVE_CHECK_GOLDEN_REQUIRED"],
  ]) {
    await assert.rejects(main(runArgs(overrides), { stdout: sink(), spawn: forbidden, fetch: forbidden,
      startEdge: forbidden }), (error) => error instanceof EdgeLiveCheckError && error.code === code, label);
  }
  await assert.rejects(main(["run", "--unknown=1"], { stdout: sink() }),
    (error) => error.code === "EDGE_LIVE_CHECK_ARGUMENT_INVALID");
});

test("run refuses when gcloud is absent, and checks the token's shape, email and audience", async () => {
  const absent = spawnStub({ missing: true });
  await assert.rejects(main(runArgs(), { stdout: sink(), spawn: absent.spawn, fetch: forbidden, startEdge: forbidden }),
    (error) => error.code === "EDGE_LIVE_CHECK_GCLOUD_UNAVAILABLE");
  for (const [label, output] of [
    ["not a JWT", "not-a-token"],
    ["another email", syntheticToken({ email: "someone-else@tibotattle.iam.gserviceaccount.com" })],
    ["another audience", syntheticToken({ aud: "https://other.example" })],
    ["unverified", syntheticToken({ email_verified: false })],
  ]) {
    const stub = spawnStub({ output });
    const error = await mintLiveIdentityToken({ invoker: EDGE_LIVE_CHECK_INVOKER, audience: EDGE_LIVE_CHECK_ORIGIN,
      spawn: stub.spawn }).catch((caught) => caught);
    assert.equal(error.code, "EDGE_LIVE_CHECK_TOKEN_INVALID", label);
    assert.ok(!String(error.stack).includes("SYNTHETICLIVECHECKTOKEN"), `${label}: no token in the error`);
  }
  const stub = spawnStub();
  await mintLiveIdentityToken({ invoker: EDGE_LIVE_CHECK_INVOKER, audience: EDGE_LIVE_CHECK_ORIGIN, spawn: stub.spawn });
  assert.deepEqual(stub.calls.map((call) => call.shell), [false, false], "gcloud runs without a shell");
  assert.deepEqual(stub.calls[1].args, ["auth", "print-identity-token",
    `--impersonate-service-account=${EDGE_LIVE_CHECK_INVOKER}`, `--audiences=${EDGE_LIVE_CHECK_ORIGIN}`, "--include-email"]);
});

/** A stand-in edge: canned answers, and exchanges that name only allowed hosts. */
function stubEdge(golden, { leakyHost = null } = {}) {
  const daily = Buffer.from("{\"synthetic\":\"daily\"}");
  const exchanges = [];
  return {
    expected: createHash("sha256").update(daily).digest("hex"),
    start: async ({ token }) => {
      assert.match(token, /SYNTHETICLIVECHECKTOKEN/u, "the edge receives the token in memory");
      return {
        frontEnd: { mark: () => exchanges.length, since: (mark) => exchanges.slice(mark) },
        async fetch(url) {
          const target = new URL(url);
          const local = target.hostname !== "tibotattle.test" || target.pathname === "/privacy.html"
            || target.pathname === "/api/v1/nope";
          if (!local) {
            exchanges.push({ framing: { contentLength: null, chunked: false },
              forwardedHeaders: { host: leakyHost ?? new URL(EDGE_LIVE_CHECK_ORIGIN).host } });
          }
          const body = target.pathname === "/api/v1/community/daily" ? daily : Buffer.from("{}");
          return { status: 200, headers: [["content-type", "application/json"]], body };
        },
        async close() {},
      };
    },
    golden,
  };
}

test("a stubbed run writes a content-free receipt; the token appears in no output, receipt or error", async () => {
  const edge = stubEdge(GOLDEN);
  const stdout = sink();
  let receipt = null;
  const result = await main(runArgs({ "expected-body-sha": edge.expected }), {
    stdout, spawn: spawnStub().spawn, startEdge: edge.start,
    fetch: async () => new Response("<html>401</html>", { status: 401 }),
    writeReceipt: async (_out, value) => { receipt = JSON.stringify(value); return "/receipt.json"; },
  });
  assert.equal(result.tier, "read_only");
  assert.ok(result.rows.some((row) => row.id === "origin-without-token" && row.status === 401));
  for (const text of [stdout.text(), receipt]) {
    assert.ok(!text.includes("SYNTHETICLIVECHECKTOKEN"), "no token");
    assert.ok(!text.includes(EDGE_LIVE_CHECK_INVOKER), "no account email");
    assert.ok(!/\b203\.0\.113\.\d+\b/u.test(text), "no client address");
  }
  // A failure after the token was minted still carries only a code.
  const mismatch = await main(runArgs({ "expected-body-sha": "b".repeat(64) }), {
    stdout: sink(), spawn: spawnStub().spawn, startEdge: edge.start,
    fetch: async () => new Response(null, { status: 403 }), writeReceipt: forbidden,
  }).catch((error) => error);
  assert.equal(mismatch.code, "EDGE_LIVE_CHECK_BODY_SHA_MISMATCH");
  assert.ok(!String(mismatch.stack).includes("SYNTHETICLIVECHECKTOKEN"));
  // A forward to any host but the pinned origin stops the run.
  const leaky = stubEdge(GOLDEN, { leakyHost: "api.cloudflare.com" });
  const refused = await main(runArgs({ "expected-body-sha": leaky.expected }), {
    stdout: sink(), spawn: spawnStub().spawn, startEdge: leaky.start, fetch: forbidden, writeReceipt: forbidden,
  }).catch((error) => error);
  assert.equal(refused.code, "EDGE_LIVE_CHECK_OUTBOUND_REFUSED");
});

test("outbound traffic is the token endpoint and the pinned origin host only", async () => {
  const guard = createLiveOutboundGuard({ originUrl: EDGE_LIVE_CHECK_ORIGIN });
  assert.equal(guard.allows("oauth2.googleapis.com"), true);
  assert.equal(guard.allows(new URL(EDGE_LIVE_CHECK_ORIGIN).host), true);
  for (const host of ["api.cloudflare.com", "accounts.google.com", "tibotattle.com", "127.0.0.1",
    `${new URL(EDGE_LIVE_CHECK_ORIGIN).host}:8443`, "", null]) {
    assert.equal(guard.allows(host), false, String(host));
  }
  // The live front end refuses any other host before a byte leaves the process.
  const frontEnd = createGoogleFrontEnd({ invoker: createSyntheticServiceAccountKey(EDGE_LIVE_CHECK_INVOKER),
    audience: EDGE_LIVE_CHECK_ORIGIN, upstreamOrigin: EDGE_LIVE_CHECK_ORIGIN,
    live: { idToken: async () => syntheticToken(), target: new URL(EDGE_LIVE_CHECK_ORIGIN) } });
  const req = new EventEmitter();
  req.headers = { host: "api.cloudflare.com" };
  req.method = "POST";
  req.url = "/client/v4/graphql";
  req.resume = () => {};
  let destroyed = false;
  frontEnd.node(req, { destroy: () => { destroyed = true; } });
  assert.equal(destroyed, true);
  assert.deepEqual(frontEnd.refusals.map((refusal) => refusal.host), ["api.cloudflare.com"]);
});
