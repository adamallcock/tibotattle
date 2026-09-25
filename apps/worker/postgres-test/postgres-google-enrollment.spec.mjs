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
const PRIVATE_ORIGIN = "https://google-enrollment-test.example";
const GOOGLE_CLIENT_ID = "synthetic-google-client.apps.exampleusercontent.com";
const GOOGLE_CLIENT_SECRET = "synthetic-google-client-secret-never-real";
const IDENTITY_LINK_SECRET = "synthetic-identity-link-secret-only-for-tests-0001";
const IDENTITY_LINK_SECRET_VERSION = "synthetic-test-key-v1";
const SESSION_COOKIE_PATTERN = /^__Host-usage_monitor_session=um_session_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=1800; Secure; HttpOnly; SameSite=Strict$/u;

const vite = await createServer({
  root: WORKER_ROOT,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const googleHandoff = await vite.ssrLoadModule("/src/postgres-google-handoff.ts");
const googleEnrollment = await vite.ssrLoadModule("/src/postgres-google-enrollment.ts");
const personalDevices = await vite.ssrLoadModule("/src/postgres-personal-devices.ts");
const retention = await vite.ssrLoadModule("/src/retention.ts");

after(async () => vite.close());

function q(schema, name) {
  return `"${schema}"."${name}"`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function verifier() {
  return randomBytes(48).toString("base64url");
}

function enrollmentRequest(identity, {
  consentVersion = "synthetic-preview-v0.1",
  syntheticOnly = true,
  extra = {},
  origin = PRIVATE_ORIGIN,
} = {}) {
  return new Request(`${PRIVATE_ORIGIN}/api/v1/enroll`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      consentVersion,
      syntheticOnly,
      ...(identity === undefined ? {} : { identity }),
      ...extra,
    }),
  });
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

function jsonPost(path, body, origin = PRIVATE_ORIGIN) {
  return new Request(`${PRIVATE_ORIGIN}${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callbackRequest(query) {
  return new Request(
    `${PRIVATE_ORIGIN}/api/v1/identity/google/callback?${query}`,
    { method: "GET", headers: { origin: "https://accounts.google.com", "sec-fetch-site": "cross-site" } },
  );
}

async function setControls(pool, schema, {
  enrollment = true,
  uploadRegistration = true,
  processing = true,
  publication = true,
} = {}) {
  const enabled = [enrollment, uploadRegistration, processing, publication].filter(Boolean).length;
  const state = enabled === 4 ? "operational" : enabled === 0 ? "contained" : "degraded";
  await pool.query(
    `UPDATE ${q(schema, "collection_controls")}
        SET control_state = $1, enrollment_enabled = $2, upload_registration_enabled = $3,
            processing_enabled = $4, publication_enabled = $5, revision = revision + 1,
            updated_at = clock_timestamp()
      WHERE singleton = 1`,
    [state, enrollment, uploadRegistration, processing, publication],
  );
}

test("PostgreSQL Google proof enrollment issues one bound social owner and Worker-compatible sessions", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localPostgresEndpoint();
  const poolOptions = {
    ...endpoint,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: process.env.PG_TEST_DATABASE || "postgres",
    ssl: false,
    max: 5,
    connectionTimeoutMillis: 5_000,
  };
  const primaryPool = new pg.Pool({ ...poolOptions, application_name: "pg-google-enrollment-primary-test" });
  const ledgerPool = new pg.Pool({ ...poolOptions, application_name: "pg-google-enrollment-ledger-test" });
  const schemaSuffix = randomBytes(5).toString("hex");
  const primarySchema = `google_enroll_p_${schemaSuffix}`;
  const ledgerSchema = `google_enroll_l_${schemaSuffix}`;
  const schemaOptions = { primarySchema, ledgerSchema };
  let primaryCreated = false;
  let ledgerCreated = false;
  try {
    const locality = await primaryPool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr() AS address",
    );
    assert.equal(Math.floor(locality.rows[0].version / 10_000), 17,
      "qualification requires PostgreSQL 17");
    assert.equal(locality.rows[0].address, null, "qualification requires a local Unix socket");
    await primaryPool.query(`CREATE SCHEMA "${primarySchema}"`);
    primaryCreated = true;
    await ledgerPool.query(`CREATE SCHEMA "${ledgerSchema}"`);
    ledgerCreated = true;
    await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primaryPool });
    await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: ledgerPool });
    await setControls(primaryPool, primarySchema);

    const env = {
      ENVIRONMENT: "hosted-test",
      ENROLLMENT_MODE: "open",
      PUBLIC_ORIGIN: PRIVATE_ORIGIN,
      IDENTITY_LINK_SECRET,
      IDENTITY_LINK_SECRET_VERSION,
      GOOGLE_OIDC_CLIENT_ID: GOOGLE_CLIENT_ID,
      GOOGLE_OIDC_CLIENT_SECRET: GOOGLE_CLIENT_SECRET,
      SIGN_IN_START_MAX_PER_MINUTE: "100",
      ENROLLMENT_RATE_LIMIT: { name: "synthetic-enrollment" },
      CLIENT_ATTEMPT_RATE_LIMIT: { name: "synthetic-client" },
    };
    const linkKeysByToken = new Map();
    const externalCalls = [];
    const admissionCalls = [];
    const healthDispatch = async () => new Response(null, { status: 200 });
    const assertAdmissionBindings = () => {};
    const assertAttemptAllowed = async (_coarse, _client, _request, _env, purpose) => {
      admissionCalls.push(purpose);
    };
    const googleDispatch = googleHandoff.createPostgresGoogleHandoffDispatch({
      primaryPool,
      schemaOptions,
      privateOrigin: PRIVATE_ORIGIN,
      env,
      assertAdmissionBindings,
      assertAttemptAllowed,
      healthDispatch,
      async exchangeCode(_runtimeEnv, code) {
        externalCalls.push(code);
        return `synthetic-id-token:${code}`;
      },
      async verifyIdentity(_runtimeEnv, idToken) {
        const linkKeyHex = linkKeysByToken.get(idToken);
        assert.ok(linkKeyHex, "test provider verifier only accepts registered synthetic tokens");
        return { provider: "google", linkKeyHex };
      },
    });
    const enrollmentDispatch = googleEnrollment.createPostgresGoogleEnrollmentDispatch({
      primaryPool,
      ledgerPool,
      schemaOptions,
      privateOrigin: PRIVATE_ORIGIN,
      env,
      assertAdmissionBindings,
      assertAttemptAllowed,
      healthDispatch,
    });

    let handoffSequence = 0;
    async function finishHandoff(subject) {
      handoffSequence += 1;
      const clientVerifier = verifier();
      const code = `synthetic-code-${subject}-${handoffSequence}`;
      const linkKeyHex = sha256(`synthetic-google-subject/v1\0${subject}`);
      linkKeysByToken.set(`synthetic-id-token:${code}`, linkKeyHex);
      const startedResponse = await googleDispatch(jsonPost(
        "/api/v1/identity/google/start",
        { binding: sha256(clientVerifier) },
      ));
      assert.equal(startedResponse.status, 200);
      const started = await startedResponse.json();
      const callback = await googleDispatch(callbackRequest(new URLSearchParams({
        state: started.state,
        code,
        scope: "openid",
      })));
      assert.equal(callback.status, 200);
      const callbackPage = await callback.text();
      assert.ok(!callbackPage.includes(code) && !callbackPage.includes(started.state));
      const result = await googleDispatch(jsonPost(
        "/api/v1/identity/google/result",
        { state: started.state, verifier: clientVerifier },
      ));
      assert.equal(result.status, 200);
      const payload = await result.json();
      assert.equal(payload.schemaVersion, "identity-google-result-v0.1");
      assert.match(payload.proof, /^[A-Za-z0-9_-]{64}$/u);
      return {
        identity: { provider: "google", proof: payload.proof, verifier: clientVerifier },
        linkKeyHex,
        state: started.state,
        code,
      };
    }

    const first = await finishHandoff("alice");
    const wrongVerifierResult = await googleDispatch(jsonPost(
      "/api/v1/identity/google/result",
      { state: first.state, verifier: verifier() },
    ));
    assert.equal(wrongVerifierResult.status, 401);
    assert.equal((await wrongVerifierResult.json()).error.code, "IDENTITY_TOKEN_INVALID");
    const correctVerifierReplay = await googleDispatch(jsonPost(
      "/api/v1/identity/google/result",
      { state: first.state, verifier: first.identity.verifier },
    ));
    assert.equal(correctVerifierReplay.status, 200);
    assert.equal((await correctVerifierReplay.json()).proof, first.identity.proof);

    const failedByConsent = await enrollmentDispatch(enrollmentRequest(first.identity, {
      consentVersion: "unsupported-consent-v9",
    }));
    assert.equal(failedByConsent.status, 400);
    assert.equal((await failedByConsent.json()).error.code, "BODY_INVALID");
    const handoffStillAvailable = await poolRow(
      primaryPool,
      `SELECT proof FROM ${q(primarySchema, "google_signin_handoffs")} WHERE state = $1`,
      [first.state],
    );
    assert.equal(handoffStillAvailable?.proof, first.identity.proof,
      "consent validation happens before proof consumption");

    await setControls(primaryPool, primarySchema, { enrollment: false });
    const paused = await enrollmentDispatch(enrollmentRequest(first.identity));
    assert.equal(paused.status, 503);
    assert.equal((await paused.json()).error.code, "COLLECTION_ENROLLMENT_DISABLED");
    assert.ok(await poolRow(
      primaryPool,
      `SELECT proof FROM ${q(primarySchema, "google_signin_handoffs")} WHERE state = $1`,
      [first.state],
    ), "collection pause must not consume the proof");
    await setControls(primaryPool, primarySchema);

    const enrolledResponse = await enrollmentDispatch(enrollmentRequest(first.identity));
    assert.equal(enrolledResponse.status, 201);
    assert.match(enrolledResponse.headers.get("set-cookie") ?? "", SESSION_COOKIE_PATTERN);
    const enrolled = await enrolledResponse.json();
    assert.equal(enrolled.schemaVersion, "participant-bootstrap-v0.1");
    assert.equal(enrolled.state, "enrolled");
    assert.match(enrolled.participantId, /^participant:[0-9a-f-]{36}$/u);
    assert.match(enrolled.csrfToken, /^um_csrf_[A-Za-z0-9_-]{43}$/u);
    assert.match(enrolled.recoveryCode,
      /^um_recovery_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
    assert.equal(enrolled.consentVersion, "synthetic-preview-v0.1");
    assert.deepEqual(enrolled.invitation,
      { state: "not_required", redeemedAt: null, expiresAt: null });
    assert.deepEqual(enrolled.recovery, {
      state: "issued",
      issuedAt: enrolled.session.issuedAt,
      expiresAt: null,
      requiresAcknowledgement: true,
    });
    assert.equal(enrolled.pairing, null);

    const participant = await poolRow(
      primaryPool,
      `SELECT id, owner_kind, state, consent_version, identity_link_key,
              identity_cooldown_digest, access_token_id, access_token_hash,
              recovery_token_id, recovery_token_hash, created_at, consented_at
         FROM ${q(primarySchema, "participants")} WHERE id = $1`,
      [enrolled.participantId],
    );
    assert.equal(participant?.owner_kind, "social");
    assert.equal(participant?.state, "active");
    assert.equal(participant?.consent_version, "synthetic-preview-v0.1");
    assert.equal(participant?.identity_link_key, first.linkKeyHex);
    assert.equal(participant?.identity_cooldown_digest, null,
      "the anti-reissue digest is insert-only and cleared in the same transaction");
    assert.ok(participant?.access_token_hash instanceof Uint8Array);
    assert.equal(participant.access_token_hash.byteLength, 32);
    assert.ok(participant?.recovery_token_hash instanceof Uint8Array);
    assert.equal(participant.recovery_token_hash.byteLength, 32);
    assert.equal(participant.created_at.toISOString(), participant.consented_at.toISOString());

    const firstCookie = (enrolledResponse.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const firstSession = await personalDevices.authenticatePostgresPersonalSession(
      primaryPool,
      firstCookie,
      { schema: schemaOptions },
    );
    assert.equal(firstSession.participantId, enrolled.participantId);
    assert.equal(firstSession.consentVersion, "synthetic-preview-v0.1");
    assert.equal(firstSession.csrfToken, enrolled.csrfToken);
    assert.equal(Date.parse(firstSession.expiresAt) - Date.parse(firstSession.participantCreatedAt),
      30 * 60_000);

    const proofConsumed = await poolRow(
      primaryPool,
      `SELECT proof FROM ${q(primarySchema, "google_signin_handoffs")} WHERE state = $1`,
      [first.state],
    );
    assert.equal(proofConsumed, null, "enrollment deletes the proof in its own transaction");
    const proofReplay = await enrollmentDispatch(enrollmentRequest(first.identity));
    assert.equal(proofReplay.status, 401);
    assert.equal((await proofReplay.json()).error.code, "IDENTITY_TOKEN_INVALID");
    assert.equal(await countRows(primaryPool, primarySchema, "participants"), 1);

    const secretPin = await poolRow(
      primaryPool,
      `SELECT key_version, secret_fingerprint
         FROM ${q(primarySchema, "identity_link_secret_configuration")} WHERE singleton = 1`,
    );
    assert.equal(secretPin?.key_version, IDENTITY_LINK_SECRET_VERSION);
    assert.match(secretPin?.secret_fingerprint ?? "", /^[0-9a-f]{64}$/u);
    assert.notEqual(secretPin.secret_fingerprint, IDENTITY_LINK_SECRET);

    // A distinct bound handoff for the same identity reattaches the one social
    // participant, keeps its original consent and access capability, rotates
    // recovery, and creates a second Worker-compatible personal session.
    const aliceAgain = await finishHandoff("alice");
    const reattachedResponse = await enrollmentDispatch(enrollmentRequest(aliceAgain.identity, {
      consentVersion: "synthetic-preview-v0.1",
    }));
    assert.equal(reattachedResponse.status, 201);
    assert.match(reattachedResponse.headers.get("set-cookie") ?? "", SESSION_COOKIE_PATTERN);
    const reattached = await reattachedResponse.json();
    assert.equal(reattached.participantId, enrolled.participantId);
    assert.notEqual(reattached.recoveryCode, enrolled.recoveryCode);
    const reattachedParticipant = await poolRow(
      primaryPool,
      `SELECT owner_kind, consent_version, identity_link_key, access_token_id,
              recovery_token_id, identity_cooldown_digest
         FROM ${q(primarySchema, "participants")} WHERE id = $1`,
      [enrolled.participantId],
    );
    assert.equal(reattachedParticipant?.owner_kind, "social");
    assert.equal(reattachedParticipant?.consent_version, "synthetic-preview-v0.1");
    assert.equal(reattachedParticipant?.identity_link_key, first.linkKeyHex);
    assert.equal(reattachedParticipant?.access_token_id, participant.access_token_id);
    assert.notEqual(reattachedParticipant?.recovery_token_id, participant.recovery_token_id);
    assert.equal(reattachedParticipant?.identity_cooldown_digest, null);
    assert.equal(await countRows(primaryPool, primarySchema, "participants"), 1);
    assert.equal(await countRows(primaryPool, primarySchema, "web_sessions"), 2);
    const secondCookie = (reattachedResponse.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const secondSession = await personalDevices.authenticatePostgresPersonalSession(
      primaryPool,
      secondCookie,
      { schema: schemaOptions },
    );
    assert.equal(secondSession.participantId, enrolled.participantId);
    assert.notEqual(secondSession.sessionId, firstSession.sessionId);

    // A deleting identity cannot be silently recreated or reattached. As in
    // the D1 sink, the verified proof is consumed before this lifecycle refusal.
    const deletingFlow = await finishHandoff("alice");
    await primaryPool.query(
      `UPDATE ${q(primarySchema, "participants")} SET state = 'deleting' WHERE id = $1`,
      [enrolled.participantId],
    );
    const deletingRefusal = await enrollmentDispatch(enrollmentRequest(deletingFlow.identity));
    assert.equal(deletingRefusal.status, 409);
    assert.equal((await deletingRefusal.json()).error.code, "PARTICIPANT_DELETING");
    assert.equal(await countRows(primaryPool, primarySchema, "participants"), 1);
    assert.equal(await countRows(primaryPool, primarySchema, "web_sessions"), 2);
    assert.equal(await poolRow(
      primaryPool,
      `SELECT proof FROM ${q(primarySchema, "google_signin_handoffs")} WHERE state = $1`,
      [deletingFlow.state],
    ), null, "a deleting-identity refusal consumes its verified proof");
    await primaryPool.query(
      `UPDATE ${q(primarySchema, "participants")} SET state = 'active' WHERE id = $1`,
      [enrolled.participantId],
    );

    // Two different proofs for the same previously unseen identity serialize
    // on a PostgreSQL transaction advisory lock. Both callers receive sessions,
    // but exactly one participant identity is created.
    const raceFlows = await Promise.all([
      finishHandoff("racing-owner"),
      finishHandoff("racing-owner"),
    ]);
    const raceResponses = await Promise.all(raceFlows.map((flow) =>
      enrollmentDispatch(enrollmentRequest(flow.identity))));
    assert.deepEqual(raceResponses.map((response) => response.status).sort(), [201, 201]);
    const racingKey = raceFlows[0].linkKeyHex;
    assert.equal((await poolRow(
      primaryPool,
      `SELECT count(*)::integer AS count FROM ${q(primarySchema, "participants")}
        WHERE identity_link_key = $1`,
      [racingKey],
    )).count, 1);
    assert.equal((await poolRow(
      primaryPool,
      `SELECT count(*)::integer AS count FROM ${q(primarySchema, "web_sessions")} s
         JOIN ${q(primarySchema, "participants")} p ON p.id = s.participant_id
        WHERE p.identity_link_key = $1`,
      [racingKey],
    )).count, 2);

    // A single consumed proof cannot win twice, even when two independent
    // HTTP requests race to enroll it.
    const singleUse = await finishHandoff("single-use-owner");
    const singleUseResponses = await Promise.all([
      enrollmentDispatch(enrollmentRequest(singleUse.identity)),
      enrollmentDispatch(enrollmentRequest(singleUse.identity)),
    ]);
    assert.deepEqual(singleUseResponses.map((response) => response.status).sort(), [201, 401]);
    const singleUseErrors = await Promise.all(singleUseResponses.map(async (response) =>
      response.status === 401 ? (await response.json()).error.code : null));
    assert.ok(singleUseErrors.includes("IDENTITY_TOKEN_INVALID"));
    assert.equal((await poolRow(
      primaryPool,
      `SELECT count(*)::integer AS count FROM ${q(primarySchema, "participants")}
        WHERE identity_link_key = $1`,
      [singleUse.linkKeyHex],
    )).count, 1);

    // Open consent creates the same grant-backed eligibility record as D1.
    const community = await finishHandoff("community-owner");
    const communityResponse = await enrollmentDispatch(enrollmentRequest(community.identity, {
      consentVersion: "privacy-safe-telemetry-v0.1",
      syntheticOnly: false,
    }));
    assert.equal(communityResponse.status, 201);
    const communityEnrollment = await communityResponse.json();
    assert.equal(communityEnrollment.state, "enrolled");
    assert.deepEqual(communityEnrollment.invitation,
      { state: "not_required", redeemedAt: null, expiresAt: null });
    const grant = await poolRow(
      primaryPool,
      `SELECT grant_row.state, grant_row.redeemed_participant_id, grant_row.secret_hash
         FROM ${q(primarySchema, "participant_community_eligibility")} eligibility
         JOIN ${q(primarySchema, "enrollment_grants")} grant_row ON grant_row.id = eligibility.grant_id
        WHERE eligibility.participant_id = $1`,
      [communityEnrollment.participantId],
    );
    assert.equal(grant?.state, "redeemed");
    assert.equal(grant?.redeemed_participant_id, communityEnrollment.participantId);
    assert.ok(grant?.secret_hash instanceof Uint8Array);
    assert.equal(grant.secret_hash.byteLength, 32);

    // Optional device bootstrap requires ongoing telemetry consent and the
    // independent upload-registration control; it creates a one-use pairing,
    // not a device credential or upload authorization.
    const deviceBootstrap = await finishHandoff("device-bootstrap-owner");
    const deviceResponse = await enrollmentDispatch(enrollmentRequest(deviceBootstrap.identity, {
      consentVersion: "privacy-safe-telemetry-v0.1",
      syntheticOnly: false,
      extra: {
        deviceBootstrap: {
          ongoingUpload: true,
          consentVersion: "ongoing-privacy-safe-telemetry-v0.1",
        },
      },
    }));
    assert.equal(deviceResponse.status, 201);
    const deviceEnrollment = await deviceResponse.json();
    assert.equal(deviceEnrollment.state, "pairing_ready");
    assert.equal(deviceEnrollment.pairing.scope, "upload_registration");
    assert.equal(deviceEnrollment.pairing.oneUse, true);
    assert.match(deviceEnrollment.pairing.pairingCode,
      /^um_pair_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
    const pairing = await poolRow(
      primaryPool,
      `SELECT pairing.state, pairing.consent_version, pairing.transport_consent_version,
              pairing.secret_hash, pairing.issued_by_session_id, session.state AS session_state
         FROM ${q(primarySchema, "device_pairings")} pairing
         JOIN ${q(primarySchema, "web_sessions")} session ON session.id = pairing.issued_by_session_id
        WHERE pairing.participant_id = $1`,
      [deviceEnrollment.participantId],
    );
    assert.equal(pairing?.state, "unused");
    assert.equal(pairing?.consent_version, "ongoing-privacy-safe-telemetry-v0.1");
    assert.equal(pairing?.transport_consent_version, "ongoing-privacy-safe-telemetry-v0.1");
    assert.ok(pairing?.secret_hash instanceof Uint8Array);
    assert.equal(pairing.secret_hash.byteLength, 32);
    assert.equal(pairing?.session_state, "active");
    assert.equal(await countRows(primaryPool, primarySchema, "device_credentials"), 0);
    assert.equal(await countRows(primaryPool, primarySchema, "device_upload_authorizations"), 0);

    // Reattachment remains available in disabled enrollment mode, while a new
    // identity is refused after its proof has been consumed, matching the D1
    // contract's distinction between new admission and identity continuity.
    env.ENROLLMENT_MODE = "disabled";
    const disabledReattach = await finishHandoff("alice");
    const reattachWhileDisabled = await enrollmentDispatch(enrollmentRequest(disabledReattach.identity));
    assert.equal(reattachWhileDisabled.status, 201);
    assert.equal((await reattachWhileDisabled.json()).participantId, enrolled.participantId);
    const disabledNew = await finishHandoff("disabled-new-owner");
    const refusedNew = await enrollmentDispatch(enrollmentRequest(disabledNew.identity));
    assert.equal(refusedNew.status, 503);
    assert.equal((await refusedNew.json()).error.code, "ENROLLMENT_DISABLED");
    assert.equal((await poolRow(
      primaryPool,
      `SELECT 1 FROM ${q(primarySchema, "participants")} WHERE identity_link_key = $1`,
      [disabledNew.linkKeyHex],
    )), null);
    env.ENROLLMENT_MODE = "open";

    // Both independent cooldown stores block a fresh identity. The digest is
    // purpose-separated and never remains on the new participant row.
    const cooldownFlow = await finishHandoff("cooldown-owner");
    const cooldownDigest = await retention.identityReenrollmentCooldownDigest(
      IDENTITY_LINK_SECRET,
      cooldownFlow.linkKeyHex,
    );
    const nowIso = new Date().toISOString();
    const untilIso = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await ledgerPool.query(
      `INSERT INTO ${q(ledgerSchema, "identity_reenrollment_cooldowns")}
       (identity_cooldown_digest, schema_version, deleted_at, retain_until)
       VALUES ($1, 'identity-reenrollment-cooldown-v0.1', $2::timestamptz, $3::timestamptz)`,
      [cooldownDigest, nowIso, untilIso],
    );
    const cooldownRefused = await enrollmentDispatch(enrollmentRequest(cooldownFlow.identity));
    assert.equal(cooldownRefused.status, 409);
    assert.equal((await cooldownRefused.json()).error.code, "IDENTITY_REENROLLMENT_COOLDOWN");
    assert.equal((await poolRow(
      primaryPool,
      `SELECT 1 FROM ${q(primarySchema, "participants")} WHERE identity_link_key = $1`,
      [cooldownFlow.linkKeyHex],
    )), null);
    const cooldownReplay = await enrollmentDispatch(enrollmentRequest(cooldownFlow.identity));
    assert.equal(cooldownReplay.status, 401, "a cooldown refusal still consumes the one-use proof");

    // The secret fingerprint established by OAuth is checked again at the
    // enrollment authority sink; a mismatched key version cannot consume the
    // waiting proof or create a participant.
    const pinnedFailureFlow = await finishHandoff("pinned-failure-owner");
    const mismatchedEnv = { ...env, IDENTITY_LINK_SECRET_VERSION: "rotated-without-migration" };
    const mismatchedDispatch = googleEnrollment.createPostgresGoogleEnrollmentDispatch({
      primaryPool,
      ledgerPool,
      schemaOptions,
      privateOrigin: PRIVATE_ORIGIN,
      env: mismatchedEnv,
      assertAdmissionBindings,
      assertAttemptAllowed,
      healthDispatch,
    });
    const pinRefused = await mismatchedDispatch(enrollmentRequest(pinnedFailureFlow.identity));
    assert.equal(pinRefused.status, 503);
    assert.equal((await pinRefused.json()).error.code, "IDENTITY_CONFIGURATION_INVALID");
    assert.ok(await poolRow(
      primaryPool,
      `SELECT proof FROM ${q(primarySchema, "google_signin_handoffs")} WHERE state = $1`,
      [pinnedFailureFlow.state],
    ), "secret-pin refusal happens before one-time proof consumption");

    // Private route boundary and request contract errors stay closed and safe.
    const wrongMethod = await enrollmentDispatch(new Request(`${PRIVATE_ORIGIN}/api/v1/enroll`, {
      method: "GET",
      headers: { origin: PRIVATE_ORIGIN },
    }));
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    const wrongOrigin = await enrollmentDispatch(enrollmentRequest(undefined, { origin: "https://attacker.example" }));
    assert.equal(wrongOrigin.status, 403);
    assert.equal((await wrongOrigin.json()).error.code, "CSRF_INVALID");
    const unsupported = await enrollmentDispatch(jsonPost("/api/v1/unsupported", {}));
    assert.equal(unsupported.status, 503);
    assert.equal((await unsupported.json()).error, "POSTGRES_WORKER_REQUEST_PATH_UNSUPPORTED");
    const missingIdentity = await enrollmentDispatch(enrollmentRequest(undefined));
    assert.equal(missingIdentity.status, 401);
    assert.equal((await missingIdentity.json()).error.code, "IDENTITY_REQUIRED");

    assert.ok(admissionCalls.length > 0, "valid enrollment attempts are admitted through the rate limiter");
    assert.deepEqual([...new Set(admissionCalls)].sort(), ["enrollment", "sign_in_start"],
      "the PostgreSQL routes use the existing enrollment and sign-in limiter purposes");
    assert.ok(externalCalls.length > 0);
    assert.ok(externalCalls.every((code) => code.startsWith("synthetic-code-")));
    assert.equal(await countRows(primaryPool, primarySchema, "web_sessions"),
      await countRows(primaryPool, primarySchema, "participants")
        + 1 /* Alice reattach */ + 1 /* race reattach */ + 1 /* disabled reattach */);
  } finally {
    if (primaryCreated) await primaryPool.query(`DROP SCHEMA IF EXISTS "${primarySchema}" CASCADE`);
    if (ledgerCreated) await ledgerPool.query(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`);
    await Promise.all([primaryPool.end(), ledgerPool.end()]);
  }
});

async function poolRow(pool, sql, values = []) {
  const result = await pool.query(sql, values);
  return result.rows[0] ?? null;
}

async function countRows(pool, schema, table) {
  const result = await pool.query(`SELECT count(*)::integer AS count FROM ${q(schema, table)}`);
  return result.rows[0].count;
}
