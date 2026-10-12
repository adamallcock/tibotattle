import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_ORIGIN = "https://google-handoff-test.example";
const CLIENT_ID = "synthetic-google-client.apps.exampleusercontent.com";
const CLIENT_SECRET = "synthetic-google-client-secret-never-real";
const ID_TOKEN = "synthetic-id-token-never-real";

const vite = await createServer({
  root: WORKER_ROOT,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const googleHandoff = await vite.ssrLoadModule("/src/postgres-google-handoff.ts");

after(async () => vite.close());

function qschema(schema) {
  return `"${schema}"`;
}

function q(schema, name) {
  return `${qschema(schema)}."${name}"`;
}

function verifier() {
  return randomBytes(48).toString("base64url");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pkce(value) {
  return createHash("sha256").update(value).digest("base64url");
}

async function localPostgresEndpoint() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  const link = await lstat(PG_TEST_SOCKET);
  const host = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(host);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host, port: PG_TEST_PORT };
}

function jsonRequest(path, body, origin = PRIVATE_ORIGIN) {
  return new Request(`${PRIVATE_ORIGIN}${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callbackRequest(query, overrides = {}) {
  return new Request(
    `${PRIVATE_ORIGIN}/api/v1/identity/google/callback?${query}`,
    {
      method: "GET",
      headers: {
        origin: "https://accounts.google.com",
        "sec-fetch-site": "cross-site",
        ...overrides,
      },
    },
  );
}

function makeDispatch(pool, schema, overrides = {}) {
  const exchangeCalls = [];
  const limiterCalls = [];
  const env = {
    ENVIRONMENT: "synthetic-development",
    ENROLLMENT_MODE: "open",
    SIGN_IN_START_MAX_PER_MINUTE: "20",
    GOOGLE_OIDC_CLIENT_ID: CLIENT_ID,
    GOOGLE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    ENROLLMENT_RATE_LIMIT: { name: "enrollment" },
    CLIENT_ATTEMPT_RATE_LIMIT: { name: "client" },
    ...overrides.env,
  };
  const dispatch = googleHandoff.createPostgresGoogleHandoffDispatch({
    primaryPool: pool,
    schemaOptions: { primarySchema: schema },
    privateOrigin: PRIVATE_ORIGIN,
    env,
    assertAdmissionBindings() {},
    async assertAttemptAllowed(coarse, client, request, runtimeEnv, purpose) {
      limiterCalls.push({ coarse, client, request, runtimeEnv, purpose });
      if (overrides.assertAttemptAllowed) {
        await overrides.assertAttemptAllowed(coarse, client, request, runtimeEnv, purpose);
      }
    },
    async healthDispatch() { return new Response(null, { status: 200 }); },
    async exchangeCode(runtimeEnv, code, codeVerifier, redirectUri) {
      exchangeCalls.push({ runtimeEnv, code, codeVerifier, redirectUri });
      if (overrides.exchangeCode) return overrides.exchangeCode(code, codeVerifier, redirectUri);
      return ID_TOKEN;
    },
    async verifyIdentity(runtimeEnv, idToken) {
      assert.equal(idToken, ID_TOKEN);
      if (overrides.verifyIdentity) return overrides.verifyIdentity(idToken);
      return { provider: "google", linkKeyHex: sha256(`synthetic-link:${idToken}`) };
    },
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  return { dispatch, env, exchangeCalls, limiterCalls };
}

test("PostgreSQL Google handoff preserves bound PKCE, callback claim, proof delivery, and isolated owner authority", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localPostgresEndpoint();
  const pool = new pg.Pool({
    ...endpoint,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: process.env.PG_TEST_DATABASE || "postgres",
    application_name: "pg-google-handoff-test",
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 5_000,
  });
  const schema = `google_handoff_${randomBytes(5).toString("hex")}`;
  let created = false;
  try {
    const locality = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr() AS address",
    );
    assert.equal(Math.floor(locality.rows[0].version / 10_000), 17,
      "handoff qualification requires PostgreSQL 17");
    assert.equal(locality.rows[0].address, null, "handoff qualification requires a local Unix socket");
    await pool.query(`CREATE SCHEMA ${qschema(schema)}`);
    created = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    await pool.query(
      `UPDATE ${q(schema, "collection_controls")}
          SET control_state = 'operational', enrollment_enabled = true,
              upload_registration_enabled = true, processing_enabled = true,
              publication_enabled = true, revision = 1, updated_at = clock_timestamp()
        WHERE singleton = 1`,
    );

    const exchangeCalls = [];
    const limiterCalls = [];
    const allowed = makeDispatch(pool, schema, {
      exchangeCode: async (code, codeVerifier, redirectUri) => {
        exchangeCalls.push({ code, codeVerifier, redirectUri });
        return ID_TOKEN;
      },
      assertAttemptAllowed: async (_coarse, _client, _request, _env, purpose) => {
        limiterCalls.push(purpose);
      },
    });
    const clientVerifier = verifier();
    const binding = sha256(clientVerifier);
    const startedResponse = await allowed.dispatch(jsonRequest(
      "/api/v1/identity/google/start", { binding },
    ));
    assert.equal(startedResponse.status, 200);
    const started = await startedResponse.json();
    assert.deepEqual(Object.keys(started).sort(), ["authorizeUrl", "schemaVersion", "state"]);
    assert.equal(started.schemaVersion, "identity-google-start-v0.1");
    assert.match(started.state, /^[A-Za-z0-9_-]{64}$/u);
    assert.equal(started.authorizeUrl.includes(clientVerifier), false);
    assert.equal(started.authorizeUrl.includes(binding), false);
    assert.equal(started.authorizeUrl.includes(CLIENT_SECRET), false);

    const authorization = new URL(started.authorizeUrl);
    assert.equal(`${authorization.origin}${authorization.pathname}`,
      "https://accounts.google.com/o/oauth2/v2/auth");
    const handoff = await pool.query(
      `SELECT code_verifier, binding_hash, identity_link_key, proof, claim_id, delivered_at
         FROM ${q(schema, "google_signin_handoffs")} WHERE state = $1`,
      [started.state],
    );
    assert.equal(handoff.rowCount, 1);
    assert.match(handoff.rows[0].code_verifier, /^[A-Za-z0-9._~-]{43,128}$/u);
    assert.equal(handoff.rows[0].binding_hash, binding);
    assert.equal(handoff.rows[0].identity_link_key, null);
    assert.equal(handoff.rows[0].proof, null);
    assert.deepEqual(Object.fromEntries(authorization.searchParams), {
      client_id: CLIENT_ID,
      redirect_uri: `${PRIVATE_ORIGIN}/api/v1/identity/google/callback`,
      response_type: "code",
      scope: "openid",
      code_challenge: pkce(handoff.rows[0].code_verifier),
      code_challenge_method: "S256",
      state: started.state,
    });
    assert.deepEqual(limiterCalls, ["sign_in_start"]);

    const pending = await allowed.dispatch(jsonRequest(
      "/api/v1/identity/google/result", { state: started.state, verifier: clientVerifier },
    ));
    assert.equal(pending.status, 404);
    const pendingPayload = await pending.json();
    assert.equal(pendingPayload.error.code, "IDENTITY_RESULT_PENDING");
    assert.match(pendingPayload.error.requestId, /^[0-9a-f-]{36}$/u);
    const wrongVerifier = await allowed.dispatch(jsonRequest(
      "/api/v1/identity/google/result", { state: started.state, verifier: verifier() },
    ));
    assert.equal(wrongVerifier.status, 401);
    assert.equal((await wrongVerifier.json()).error.code, "IDENTITY_TOKEN_INVALID");

    const landed = await allowed.dispatch(callbackRequest(new URLSearchParams({
      code: "synthetic-one-time-code",
      state: started.state,
      scope: "openid",
      authuser: "0",
    })));
    assert.equal(landed.status, 200);
    const page = await landed.text();
    assert.match(landed.headers.get("content-security-policy"), /default-src 'none'/u);
    assert.match(page, /Signed in — return to TiboTattle\./u);
    for (const sensitive of ["synthetic-one-time-code", ID_TOKEN, started.state,
      handoff.rows[0].code_verifier, CLIENT_SECRET]) {
      assert.equal(page.includes(sensitive), false);
    }
    assert.deepEqual(exchangeCalls, [{
      code: "synthetic-one-time-code",
      codeVerifier: handoff.rows[0].code_verifier,
      redirectUri: `${PRIVATE_ORIGIN}/api/v1/identity/google/callback`,
    }]);

    const afterCallback = await pool.query(
      `SELECT code_verifier, identity_link_key, proof, claim_id, claimed_at, delivered_at
         FROM ${q(schema, "google_signin_handoffs")} WHERE state = $1`,
      [started.state],
    );
    assert.equal(afterCallback.rows[0].code_verifier, null);
    assert.equal(afterCallback.rows[0].identity_link_key, sha256(`synthetic-link:${ID_TOKEN}`));
    assert.match(afterCallback.rows[0].proof, /^[A-Za-z0-9_-]{64}$/u);
    assert.match(afterCallback.rows[0].claim_id, /^[A-Za-z0-9_-]{64}$/u);
    assert.ok(afterCallback.rows[0].claimed_at);
    assert.equal(afterCallback.rows[0].delivered_at, null);

    const resultRequest = () => jsonRequest(
      "/api/v1/identity/google/result", { state: started.state, verifier: clientVerifier },
    );
    const result = await allowed.dispatch(resultRequest());
    assert.equal(result.status, 200);
    const payload = await result.json();
    assert.deepEqual(Object.keys(payload).sort(), ["proof", "schemaVersion"]);
    assert.equal(payload.schemaVersion, "identity-google-result-v0.1");
    assert.equal(payload.proof, afterCallback.rows[0].proof);
    assert.equal(JSON.stringify(payload).includes(CLIENT_SECRET), false);
    assert.equal(JSON.stringify(payload).includes(ID_TOKEN), false);
    const replay = await allowed.dispatch(resultRequest());
    assert.deepEqual(await replay.json(), payload,
      "the bound initiator can recover the same proof until enrollment consumes it");
    const delivered = await pool.query(
      `SELECT delivered_at FROM ${q(schema, "google_signin_handoffs")} WHERE state = $1`,
      [started.state],
    );
    assert.ok(delivered.rows[0].delivered_at);

    // Handoff only exposes the opaque enrollment proof. It does not create a
    // participant, session, cookie, or enrollment authority on its own.
    assert.equal(result.headers.has("set-cookie"), false);
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${q(schema, "participants")}`)).rows[0].count, 0);
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${q(schema, "web_sessions")}`)).rows[0].count, 0);

    // Google cancellation deletes only its still-unclaimed live handoff.
    const cancelledStart = await allowed.dispatch(jsonRequest(
      "/api/v1/identity/google/start", { binding: sha256(verifier()) },
    ));
    const cancelled = await cancelledStart.json();
    const cancellationPage = await allowed.dispatch(callbackRequest(new URLSearchParams({
      state: cancelled.state,
      error: "access_denied",
    })));
    assert.equal(cancellationPage.status, 200);
    assert.match(await cancellationPage.text(), /Sign-in was not completed/u);
    assert.equal((await pool.query(
      `SELECT count(*)::integer AS count FROM ${q(schema, "google_signin_handoffs")} WHERE state = $1`,
      [cancelled.state],
    )).rows[0].count, 0);
    assert.equal(exchangeCalls.length, 1, "cancellation never calls the injected provider transport");

    // An exchange failure discards only its current claimant's pending row.
    const failedDispatch = makeDispatch(pool, schema, {
      exchangeCode: async () => { throw new Error("synthetic provider failure"); },
    });
    const failedStartResponse = await failedDispatch.dispatch(jsonRequest(
      "/api/v1/identity/google/start", { binding: sha256(verifier()) },
    ));
    const failedStart = await failedStartResponse.json();
    const failedPage = await failedDispatch.dispatch(callbackRequest(new URLSearchParams({
      state: failedStart.state,
      code: "synthetic-failing-code",
    })));
    assert.match(await failedPage.text(), /Sign-in was not completed/u);
    assert.equal((await pool.query(
      `SELECT count(*)::integer AS count FROM ${q(schema, "google_signin_handoffs")} WHERE state = $1`,
      [failedStart.state],
    )).rows[0].count, 0);

    // An authorization state expires after ten minutes and is never exchanged
    // when its callback arrives late. The result read purges the expired row.
    let clockEpoch = Date.now();
    const expiringDispatch = makeDispatch(pool, schema, { now: () => clockEpoch });
    const expiringStartResponse = await expiringDispatch.dispatch(jsonRequest(
      "/api/v1/identity/google/start", { binding: sha256(verifier()) },
    ));
    const expiringStart = await expiringStartResponse.json();
    clockEpoch += 10 * 60_000 + 1;
    const lateCallback = await expiringDispatch.dispatch(callbackRequest(new URLSearchParams({
      state: expiringStart.state,
      code: "synthetic-late-code",
    })));
    assert.match(await lateCallback.text(), /Sign-in was not completed/u);
    assert.equal(expiringDispatch.exchangeCalls.length, 0);
    const expiredRead = await expiringDispatch.dispatch(jsonRequest(
      "/api/v1/identity/google/result",
      { state: expiringStart.state, verifier: "A".repeat(64) },
    ));
    assert.equal(expiredRead.status, 401);
    assert.equal((await pool.query(
      `SELECT count(*)::integer AS count FROM ${q(schema, "google_signin_handoffs")} WHERE state = $1`,
      [expiringStart.state],
    )).rows[0].count, 0);

    // Concurrent callbacks race on PostgreSQL's conditional UPDATE. Exactly
    // one claimant is allowed to enter provider exchange.
    let unblockExchange;
    let enteredExchange;
    const exchangeEntered = new Promise((resolve) => { enteredExchange = resolve; });
    const exchangeGate = new Promise((resolve) => { unblockExchange = resolve; });
    const concurrentDispatch = makeDispatch(pool, schema, {
      exchangeCode: async () => {
        enteredExchange();
        await exchangeGate;
        return ID_TOKEN;
      },
    });
    const concurrentStartResponse = await concurrentDispatch.dispatch(jsonRequest(
      "/api/v1/identity/google/start", { binding: sha256(verifier()) },
    ));
    const concurrentStart = await concurrentStartResponse.json();
    const concurrentQuery = new URLSearchParams({
      state: concurrentStart.state,
      code: "synthetic-concurrent-code",
    });
    const winnerPromise = concurrentDispatch.dispatch(callbackRequest(concurrentQuery));
    await exchangeEntered;
    const loser = await concurrentDispatch.dispatch(callbackRequest(concurrentQuery));
    assert.match(await loser.text(), /Sign-in was not completed/u);
    assert.equal(concurrentDispatch.exchangeCalls.length, 1);
    unblockExchange();
    const winner = await winnerPromise;
    assert.match(await winner.text(), /Signed in — return to TiboTattle\./u);
    assert.equal(concurrentDispatch.exchangeCalls.length, 1);

    // Request-boundary method, origin, and closed-body checks remain intact.
    const wrongMethod = await allowed.dispatch(new Request(
      `${PRIVATE_ORIGIN}/api/v1/identity/google/start`, { method: "GET" },
    ));
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    const wrongOrigin = await allowed.dispatch(jsonRequest(
      "/api/v1/identity/google/result", { state: started.state, verifier: clientVerifier },
      "https://attacker.example",
    ));
    assert.equal(wrongOrigin.status, 403);
    const nonemptyStart = await allowed.dispatch(jsonRequest(
      "/api/v1/identity/google/start", { binding, redirectUri: "https://attacker.example" },
    ));
    assert.equal(nonemptyStart.status, 400);
    const noAuth = await allowed.dispatch(new Request(
      `${PRIVATE_ORIGIN}/api/v1/identity/google/result`, { method: "GET" },
    ));
    assert.equal(noAuth.status, 405);
    assert.equal(noAuth.headers.get("allow"), "POST");

    // A paused primary control blocks the flow before the rate limiter,
    // admission bucket, OAuth configuration, or handoff insert is reached.
    await pool.query(
      `UPDATE ${q(schema, "collection_controls")}
          SET control_state = 'contained', enrollment_enabled = false,
              upload_registration_enabled = false, processing_enabled = false,
              publication_enabled = false, revision = revision + 1,
              updated_at = clock_timestamp()
        WHERE singleton = 1`,
    );
    const blockedBefore = limiterCalls.length;
    const blocked = await allowed.dispatch(jsonRequest(
      "/api/v1/identity/google/start", { binding: sha256(verifier()) },
    ));
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).error.code, "COLLECTION_ENROLLMENT_DISABLED");
    assert.equal(limiterCalls.length, blockedBefore);
  } finally {
    if (created) await pool.query(`DROP SCHEMA ${qschema(schema)} CASCADE`);
    await pool.end();
  }
});
