// PostgreSQL v1.2 'unchanged' activation receipt and D1 newest-7 predecessor
// pruning. Every fixture is synthetic and content-free; each test owns one
// disposable schema on the local PG17 socket and drops only that schema.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createServer } from "vite";
import {
  canonicalTelemetryV12Json,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ID = "synthetic-v12-unchanged-source";
const DAY_ONE = "2026-09-21";
const DAY_TWO = "2026-09-22";
const DAY_THREE = "2026-09-23";
const HOUR_MS = 3_600_000;
const PREDECESSOR_TTL_MS = 24 * HOUR_MS;
const CLIENT_PASS_INTERVAL_MS = 4 * HOUR_MS;
const OUTSTANDING_CAP = 8;
const NEWEST_KEPT = 7;
const SNAPSHOT_TABLES = Object.freeze([
  "telemetry_v12_domains",
  "telemetry_v12_domain_days",
  "telemetry_v12_domain_heads",
  "telemetry_v12_domain_predecessors",
  "storage_ingestion_changes",
  "input_versions",
  "input_source_digests",
  "community_analytical_input_versions",
  "storage_v11_owner_links",
  "analytics_owner_state",
]);

let vite;
let modules;
let pool;

after(async () => {
  await pool?.end();
  await vite?.close();
});

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  const link = await lstat(PG_TEST_SOCKET);
  const host = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(host);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host, port: PG_TEST_PORT };
}

async function setup() {
  if (!pool) {
    pool = new pg.Pool({
      ...await localSocket(),
      user: process.env.PG_TEST_USER || "postgres",
      password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
      database: process.env.PG_TEST_DATABASE || "postgres",
      application_name: "pg-v12-domain-unchanged-test",
      ssl: false,
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const server = await pool.query(
      "SELECT inet_server_addr() AS address, current_setting('server_version_num')::integer AS version",
    );
    assert.equal(server.rows[0]?.address, null, "qualification requires the local Unix socket");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the disposable socket must be PostgreSQL 17");
  }
  if (!modules) {
    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: "custom",
      logLevel: "silent",
    });
    modules = {
      ...await vite.ssrLoadModule("/src/postgres-typed-v12-domain.ts"),
      ...await vite.ssrLoadModule("/src/postgres-typed-v12-admission.ts"),
      ...await vite.ssrLoadModule("/src/postgres-v12-owner-recovery.ts"),
      ...await vite.ssrLoadModule("/src/errors.ts"),
      ...await vite.ssrLoadModule("/src/telemetry-activation-observation.ts"),
    };
  }
}

/** One disposable, fully migrated primary schema with an active v1.2 runtime
 * and a source journal, so a head change emits exactly one source event. */
async function withSchema(prefix, run) {
  await setup();
  const schema = `${prefix}_${randomBytes(6).toString("hex")}`;
  let created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const table = (name) => `"${schema}"."${name}"`;
    const now = new Date().toISOString();
    await pool.query(`UPDATE ${table("telemetry_v12_runtime")} SET state='active', changed_at=$1 WHERE id=1`, [now]);
    await pool.query(`UPDATE ${table("telemetry_v12_typed_runtime")} SET state='active', changed_at=$1 WHERE id=1`, [now]);
    await pool.query(`INSERT INTO ${table("storage_source_state")}(singleton, source_id, authority_epoch)
      VALUES (1, $1, 0)`, [SOURCE_ID]);
    const options = { schema: { primarySchema: schema } };
    const context = {
      schema,
      table,
      options,
      domain: modules.createPostgresTypedV12Domain(pool, options),
    };
    await run(context);
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

async function seedParticipant(context, label) {
  const { table } = context;
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 30 * 24 * HOUR_MS).toISOString();
  const participantId = `synthetic-unchanged-${label}-${randomUUID()}`;
  const sessionId = `${participantId}-session`;
  const ownerDigest = randomBytes(32).toString("hex");
  await pool.query(`INSERT INTO ${table("participants")}(id, owner_kind, state, consent_version, created_at)
    VALUES ($1,'social','active','privacy-safe-telemetry-v0.1',$2)`, [participantId, now]);
  await pool.query(`INSERT INTO ${table("web_sessions")}(
    id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [sessionId, participantId, randomBytes(32), randomBytes(32), now, expires]);
  await pool.query(`INSERT INTO ${table("storage_v11_owner_links")}(participant_id, owner_digest, state)
    VALUES ($1,$2,'active')`, [participantId, ownerDigest]);
  await pool.query(`INSERT INTO ${table("analytics_owner_state")}(
    source_id, owner_digest, revision, authority_epoch, state
  ) VALUES ($1,$2,1,0,'active')`, [SOURCE_ID, ownerDigest]);
  return { participantId, sessionId, ownerDigest, now, expires };
}

async function seedDevice(context, participant, label) {
  const { table } = context;
  const deviceId = `synthetic-unchanged-device-${label}-${randomUUID()}`;
  const pairingId = `synthetic-unchanged-pairing-${randomUUID()}`;
  const { participantId, sessionId, now, expires } = participant;
  await pool.query(`INSERT INTO ${table("device_pairings")}(
    id, participant_id, issued_by_session_id, secret_hash, consent_version,
    transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
  ) VALUES ($1,$2,$3,$4,'synthetic-consent-v1','synthetic-transport-v1','consumed',$5,$6,$5,$7)`, [
    pairingId, participantId, sessionId, randomBytes(32), now, expires, deviceId,
  ]);
  await pool.query(`INSERT INTO ${table("device_credentials")}(
    id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
    state, issued_at, expires_at, last_used_at, social_verified_at
  ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`, [
    deviceId, participantId, pairingId, randomBytes(32), now, expires,
  ]);
  await pool.query(`INSERT INTO ${table("telemetry_v12_device_capabilities")}(
    participant_id, device_id, telemetry_schema_version, field_dictionary_version,
    privacy_contract_version, state, consented_at
  ) VALUES ($1,$2,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
    'ongoing-privacy-safe-telemetry-v1.2','accepted',$3)`, [participantId, deviceId, now]);
  return { participantId, deviceId };
}

async function seedAccountlessDevice(context, label, { publicEligible = true } = {}) {
  const { table } = context;
  const nowEpoch = Date.now();
  const now = new Date(nowEpoch).toISOString();
  const expires = new Date(nowEpoch + 30 * 24 * HOUR_MS).toISOString();
  const participantId = `synthetic-unchanged-accountless-${label}-${randomUUID()}`;
  const deviceId = `synthetic-unchanged-accountless-device-${label}-${randomUUID()}`;
  const principalId = `synthetic-install-${randomUUID()}`;
  const deviceSecret = randomBytes(32);
  const enrollmentSecretHash = publicEligible ? deviceSecret : randomBytes(32);
  await pool.query(`INSERT INTO ${table("participants")}(id, owner_kind, state, consent_version, created_at)
    VALUES ($1,'accountless','active',NULL,$2)`, [participantId, now]);
  await pool.query(`INSERT INTO ${table("accountless_enrollment_ledger")}(
    device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,
    authorization_basis,state,issued_at,expires_at
  ) VALUES ($1,$2,$3,'accountless-enrollment-v0.1','accountless-opt-out-v1',
    'accountless-policy-v1','active',$4,$5)`,
  [deviceId, enrollmentSecretHash, principalId, now, expires]);
  await pool.query(`INSERT INTO ${table("device_credentials")}(
    id,participant_id,authority_kind,accountless_enrollment_device_id,secret_hash,
    state,issued_at,expires_at,last_used_at
  ) VALUES ($1,$2,'accountless',$1,$3,'active',$4,$5,$4)`,
  [deviceId, participantId, deviceSecret, now, expires]);
  await pool.query(`INSERT INTO ${table("accountless_upload_owners")}(
    enrollment_device_id,participant_id,device_credential_id,policy_version,
    authorization_basis,authorized_at,expires_at,state
  ) VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',$3,$4,'active')`,
  [deviceId, participantId, now, expires]);
  await pool.query(`INSERT INTO ${table("accountless_v12_device_authorizations")}(
    enrollment_device_id,participant_id,device_credential_id,schema_version,policy_version,
    authorization_basis,telemetry_schema_version,field_dictionary_version,privacy_contract_version,
    authorized_at,expires_at,state
  ) VALUES ($1,$2,$1,'accountless-upload-owner-v1.2','accountless-telemetry-v1.2-policy-v1',
    'accountless-policy-v1.2',$3,$4,$5,$6,$7,'active')`,
  [deviceId, participantId, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
    TELEMETRY_V12_FIELD_DICTIONARY_VERSION, TELEMETRY_V12_PRIVACY_CONTRACT_VERSION, now, expires]);
  return { participantId, deviceId };
}

/** A zero-chunk day registered through the real admission path, which makes
 * it ready at registration (the empty-day contract from fe58fd7a). */
async function registerEmptyDay(context, principal, day, parserVersion = "synthetic-empty-day", nowEpoch = Date.now()) {
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.2",
    day,
    parserVersion,
    consent: telemetryV12RequiredConsent(),
    chunks: [],
    excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  const candidate = await modules.registerPostgresTypedV12DayManifest(
    pool, principal, manifest, nowEpoch, context.options,
  );
  assert.deepEqual({ state: candidate.state, expectedChunks: candidate.expectedChunks },
    { state: "ready", expectedChunks: 0 });
  return { day, manifestId: candidate.manifestId, manifestDigest: candidate.manifestDigest };
}

/** One synthetic quota observation admitted through register, stage and ready. */
async function admitQuotaDay(context, principal, day, {
  registrationEpoch = Date.now(),
  readyEpoch = registrationEpoch,
} = {}) {
  const { table } = context;
  const nowEpoch = registrationEpoch;
  const quotaRecord = {
    schemaVersion: "quota-observation-v1.2",
    observationId: `quota:v12:${randomUUID()}`,
    observedTime: `${day}T12:05:00.000Z`,
    provider: "openai_codex",
    planType: "pro",
    planVariant: "unknown",
    limitId: "codex",
    slot: "primary",
    usedPercent: 20,
    windowDurationMinutes: 10080,
    resetsAt: `${day}T13:05:00.000Z`,
    accountPlanAttribution: {
      accountBasis: "unavailable",
      accountTrackId: null,
      planBasis: "same_source_occurrence",
      planType: "pro",
      planEraId: null,
    },
  };
  const consent = telemetryV12RequiredConsent();
  const parserVersion = "synthetic-unchanged-pg17";
  const chunk = {
    schemaVersion: "telemetry-contribution-v1.2",
    manifestDigest: "0".repeat(64),
    chunkId: `quota:${day}:0`,
    chunkRevision: 1,
    parserVersion,
    consent,
    records: [quotaRecord],
    chunkDigest: sha256Hex(canonicalTelemetryV12Json([quotaRecord])),
  };
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.2",
    day,
    parserVersion,
    consent,
    chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: 1 }],
    excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  chunk.manifestDigest = manifest.manifestDigest;
  const candidate = await modules.registerPostgresTypedV12DayManifest(
    pool, principal, manifest, nowEpoch, context.options,
  );
  assert.equal(candidate.state, "staged");
  const envelopeDigest = randomBytes(32).toString("hex");
  const authorizationId = `synthetic-unchanged-auth-${randomUUID()}`;
  const chunkRowId = `chunk:${randomUUID()}`;
  const r2Key = `synthetic/unchanged/${randomUUID()}`;
  const now = new Date(readyEpoch).toISOString();
  const expires = new Date(readyEpoch + 10 * 60_000).toISOString();
  await pool.query(`INSERT INTO ${table("device_upload_authorizations")}(
    id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
    body_bytes, content_type, state, issued_at, expires_at, consume_lease_expires_at
  ) VALUES ($1,$2,$3,$4,$5,4096,'application/json','consuming',$6,$7,$7)`, [
    authorizationId, principal.participantId, principal.deviceId, randomBytes(32), envelopeDigest, now, expires,
  ]);
  await pool.query(`INSERT INTO ${table("pending_objects")}(contribution_id, object_key, object_kind)
    VALUES ($1,$2,'telemetry_v12')`, [chunkRowId, r2Key]);
  await modules.persistPostgresTypedV12StagedChunk(pool, principal, chunk, {
    chunkRowId, r2Key, envelopeDigest, deviceUploadAuthorizationId: authorizationId,
  }, readyEpoch, context.options);
  const ready = await pool.query(`SELECT state, expected_chunk_count FROM ${table("telemetry_v12_day_manifests")}
    WHERE id=$1`, [candidate.manifestId]);
  assert.deepEqual(ready.rows[0], { state: "ready", expected_chunk_count: 1 });
  return { day, manifestId: candidate.manifestId, manifestDigest: candidate.manifestDigest };
}

function domainManifest(predecessor, days) {
  const manifest = {
    schemaVersion: "telemetry-domain-manifest-v1.2",
    fromDay: days[0].day,
    throughDay: days.at(-1).day,
    predecessor: {
      token: predecessor.token,
      previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint,
    },
    days: days.map(({ day, manifestId, manifestDigest }) => ({ day, manifestId, manifestDigest })),
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = sha256Hex(telemetryV12DomainManifestDigestInput(manifest));
  return manifest;
}

/** The shipped client's pass: a 'before' predecessor, then a 'renewed' one
 * whose fingerprint must match, then activation with the renewed token. */
async function clientPass(context, principal, days, nowEpoch = Date.now()) {
  const before = await context.domain.createPredecessor(principal, nowEpoch);
  const renewed = await context.domain.createPredecessor(principal, nowEpoch);
  assert.equal(renewed.legacyFingerprint, before.legacyFingerprint);
  assert.equal(renewed.previousGenerationId, before.previousGenerationId);
  const manifest = domainManifest(renewed, days);
  return { before, renewed, manifest, result: await context.domain.activate(principal, manifest) };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function rendezvous(signal, outcome, label, timeoutMs = 15_000) {
  let timer;
  try {
    const result = await Promise.race([
      signal.then((value) => ({ kind: "signal", value })),
      outcome.then((value) => ({ kind: "outcome", value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    assert.equal(result.kind, "signal", `${label} must arrive before operation completion`);
    return result.value;
  } finally {
    clearTimeout(timer);
  }
}

async function boundedDrain(promises, label, timeoutMs = 15_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.all(promises),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not drain`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isStateLockQuery(text) {
  return /community_analytical_input_versions/u.test(text) && /FOR UPDATE OF v\b/u.test(text);
}

/** Wrap real pg clients only to pause at a completed state-lock query and to
 * signal when the competing query has been sent. Every query still runs on
 * PostgreSQL; the wrapper creates no substitute transaction behavior. */
function interleavingPool(basePool, { afterStateLock, beforeStateLock, onConnect } = {}) {
  let paused = false;
  const activeClients = new Set();
  return {
    async connect() {
      const client = await basePool.connect();
      let released = false;
      const release = (discard) => {
        if (released) return;
        released = true;
        activeClients.delete(discardClient);
        return client.release(discard);
      };
      const discardClient = () => release(new Error("bounded CAS test cleanup"));
      activeClients.add(discardClient);
      let backendPid;
      try {
        backendPid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
        onConnect?.(backendPid);
      } catch (error) {
        discardClient();
        throw error;
      }
      return {
        async query(text, values) {
          if (!isStateLockQuery(text)) return client.query(text, values);
          if (afterStateLock && !paused) {
            paused = true;
            const result = await client.query(text, values);
            afterStateLock.resolve(backendPid);
            await afterStateLock.resume;
            return result;
          }
          const pending = client.query(text, values);
          beforeStateLock?.resolve(backendPid);
          return pending;
        },
        release,
      };
    },
    discardActive() {
      for (const discardClient of [...activeClients]) discardClient();
    },
  };
}

async function waitForStateLockWait(pid, expectedBlockerPid) {
  // Observe PostgreSQL's actual lock wait, rather than relying on elapsed time
  // to assume the competing stateRow statement reached the server.
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await pool.query(`SELECT state, wait_event_type, query,
        pg_blocking_pids(pid) AS blocking_pids
      FROM pg_stat_activity WHERE pid=$1`, [pid]);
    const activity = result.rows[0];
    if (activity?.wait_event_type === "Lock"
        && activity.blocking_pids.map(Number).includes(expectedBlockerPid)) {
      assert.equal(activity.state, "active");
      assert.match(activity.query, /community_analytical_input_versions/u);
      assert.match(activity.query, /FOR UPDATE OF v\b/u);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("competing stateRow query did not wait on the first activation's state lock");
}

async function assertSerializedActivationRace(context, {
  principal, firstManifest, secondManifest, previousGenerationId,
}) {
  const firstRead = deferred();
  const releaseFirst = deferred();
  firstRead.resume = releaseFirst.promise;
  const secondSent = deferred();
  const firstBackend = deferred();
  let firstPool;
  let secondPool;
  const firstDomain = modules.createPostgresTypedV12Domain(firstPool = interleavingPool(pool, {
    afterStateLock: firstRead,
    onConnect: firstBackend.resolve,
  }), context.options);
  const secondDomain = modules.createPostgresTypedV12Domain(secondPool = interleavingPool(pool, {
    beforeStateLock: secondSent,
  }), context.options);
  let firstOutcome;
  let secondOutcome;
  try {
    const before = await snapshot(context);
    const sequenceBefore = await maxSequence(context);
    const inputRevisionBefore = await inputRevision(context, principal.participantId);
    const observations = [];
    const observe = modules.createTelemetryActivationObserver((item) => observations.push(item));
    firstOutcome = observe("v1.2", () => firstDomain.activate(principal, firstManifest))
      .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

    const firstPid = await rendezvous(firstRead.promise, firstOutcome, "first activation state read");
    assert.equal(firstPid, await rendezvous(firstBackend.promise, firstOutcome, "first backend connection"));
    secondOutcome = observe("v1.2", () => secondDomain.activate(principal, secondManifest))
      .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
    const secondPid = await rendezvous(secondSent.promise, secondOutcome, "competing state-lock query");
    assert.ok(Number.isInteger(secondPid));
    await rendezvous(waitForStateLockWait(secondPid, firstPid), secondOutcome,
      "competing query lock wait", 10_000);
    releaseFirst.resolve();

    const [winner, loser] = await boundedDrain([firstOutcome, secondOutcome], "activation race");
    assert.equal(winner.ok, true);
    assert.equal(winner.value.replay, false);
    assert.equal(loser.ok, false);
    assert.equal(loser.error.status, 409);
    assert.equal(loser.error.code, "TELEMETRY_MANIFEST_CONFLICT");

    const refusal = observations.find((item) => item.outcome === "refused");
    assert.deepEqual(refusal && {
      status: refusal.status,
      code: refusal.code,
      refusalPhase: refusal.refusalPhase,
    }, {
      status: 409,
      code: "TELEMETRY_MANIFEST_CONFLICT",
      refusalPhase: "state",
    });
    assert.deepEqual(observations.filter((item) => item.outcome === "activated")
      .map((item) => item.refusalPhase), [null]);

    const winnerHead = await head(context, principal.participantId);
    assert.deepEqual(winnerHead, {
      generation_id: winner.value.generationId,
      revision: previousGenerationId === null ? 1 : 2,
    });
    assert.equal(await maxSequence(context), sequenceBefore + 1,
      "only the winner appends the v1.2 head journal event");
    assert.equal(await inputRevision(context, principal.participantId), inputRevisionBefore,
      "publishing the v1.2 head does not advance the participant input revision");

    const after = await snapshot(context);
    assert.equal(after.telemetry_v12_domains.n, before.telemetry_v12_domains.n + 1);
    assert.equal(after.telemetry_v12_domain_days.n, before.telemetry_v12_domain_days.n + 1);
    assert.equal(after.telemetry_v12_domain_heads.n,
      Math.max(1, before.telemetry_v12_domain_heads.n));
    assert.equal(after.telemetry_v12_domain_predecessors.n,
      before.telemetry_v12_domain_predecessors.n,
      "the losing transaction neither inserts nor deletes a predecessor");

    const [firstToken, secondToken] = await Promise.all([
      predecessorRow(context, firstManifest.predecessor.token),
      predecessorRow(context, secondManifest.predecessor.token),
    ]);
    assert.notEqual(firstToken.consumed_at, null, "the winner's predecessor is consumed");
    assert.equal(secondToken.consumed_at, null, "the stale loser's predecessor remains retryable");
    const winnerDomain = await pool.query(`SELECT id, predecessor_token_hash
      FROM ${context.table("telemetry_v12_domains")}
      WHERE predecessor_token_hash = ANY($1::text[])`, [
      [sha256Hex(firstManifest.predecessor.token), sha256Hex(secondManifest.predecessor.token)],
    ]);
    assert.deepEqual(winnerDomain.rows, [{
      id: winner.value.generationId,
      predecessor_token_hash: sha256Hex(firstManifest.predecessor.token),
    }], "the loser leaves no committed domain row");

    const receipts = await pool.query(`SELECT receipt.generation_id, receipt.previous_generation_id,
        receipt.manifest_digest, receipt.head_revision::integer AS head_revision,
        change.event_digest, change.kind, change.object_digest, change.content_digest
      FROM ${context.table("storage_v12_event_sources")} receipt
      JOIN ${context.table("storage_ingestion_changes")} change
        ON change.source_id=$3 AND change.event_digest=receipt.event_digest
      WHERE receipt.participant_id=$1 AND receipt.device_id=$2
        AND receipt.manifest_digest = ANY($4::text[])
      ORDER BY receipt.manifest_digest`, [principal.participantId, principal.deviceId, SOURCE_ID,
      [firstManifest.manifestDigest, secondManifest.manifestDigest]]);
    assert.equal(receipts.rows.length, 1,
      "only the winning candidate has a receipt joined to its journal event");
    const [receipt] = receipts.rows;
    assert.deepEqual({
      generation_id: receipt.generation_id,
      previous_generation_id: receipt.previous_generation_id,
      manifest_digest: receipt.manifest_digest,
      head_revision: receipt.head_revision,
      kind: receipt.kind,
      content_digest: receipt.content_digest,
    }, {
      generation_id: winner.value.generationId,
      previous_generation_id: previousGenerationId,
      manifest_digest: firstManifest.manifestDigest,
      head_revision: previousGenerationId === null ? 1 : 2,
      kind: "owner-active",
      content_digest: firstManifest.manifestDigest,
    });
    assert.match(receipt.event_digest, /^[0-9a-f]{64}$/u);
    assert.equal(receipt.object_digest, receipt.event_digest);
  } finally {
    releaseFirst.resolve();
    const outcomes = [firstOutcome, secondOutcome].filter(Boolean);
    try {
      await boundedDrain(outcomes, "activation race cleanup");
    } catch {
      firstPool?.discardActive();
      secondPool?.discardActive();
      await boundedDrain(outcomes, "discarded activation race cleanup", 5_000);
    }
  }
}

async function raceFixture(context, label, installInitialHead) {
  const participant = await seedParticipant(context, label);
  const principal = await seedDevice(context, participant, label);
  const originalDay = await registerEmptyDay(context, principal, DAY_ONE, `${label}-base`);
  let previousGenerationId = null;
  if (installInitialHead) {
    const initial = await clientPass(context, principal, [originalDay]);
    previousGenerationId = newGeneration(initial.result, null).generationId;
  }

  const firstDay = await registerEmptyDay(context, principal, DAY_ONE, `${label}-candidate-a`);
  const secondDay = await registerEmptyDay(context, principal, DAY_ONE, `${label}-candidate-b`);
  const firstPredecessor = await context.domain.createPredecessor(principal);
  const secondPredecessor = await context.domain.createPredecessor(principal);
  assert.equal(firstPredecessor.previousGenerationId, previousGenerationId);
  assert.equal(secondPredecessor.previousGenerationId, previousGenerationId);

  return {
    principal,
    previousGenerationId,
    firstManifest: domainManifest(firstPredecessor, [firstDay]),
    secondManifest: domainManifest(secondPredecessor, [secondDay]),
  };
}

async function snapshot(context) {
  const rows = {};
  for (const name of SNAPSHOT_TABLES) {
    const result = await pool.query(`SELECT count(*)::integer AS n,
        md5(COALESCE(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS digest
      FROM ${context.table(name)} t`);
    rows[name] = result.rows[0];
  }
  return rows;
}

async function head(context, participantId) {
  const result = await pool.query(`SELECT generation_id, revision::integer AS revision
    FROM ${context.table("telemetry_v12_domain_heads")} WHERE participant_id=$1`, [participantId]);
  return result.rows[0] ?? null;
}

async function maxSequence(context) {
  const result = await pool.query(`SELECT COALESCE(max(sequence), 0)::integer AS sequence
    FROM ${context.table("storage_ingestion_changes")} WHERE source_id=$1`, [SOURCE_ID]);
  return result.rows[0].sequence;
}

async function inputRevision(context, participantId) {
  const result = await pool.query(`SELECT revision::integer AS revision
    FROM ${context.table("community_analytical_input_versions")} WHERE participant_id=$1`, [participantId]);
  return result.rows[0].revision;
}

async function predecessorRow(context, token) {
  const result = await pool.query(`SELECT consumed_at
    FROM ${context.table("telemetry_v12_domain_predecessors")} WHERE token_hash=$1`, [sha256Hex(token)]);
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function unconsumedFor(context, principal) {
  const result = await pool.query(`SELECT token_hash
    FROM ${context.table("telemetry_v12_domain_predecessors")}
    WHERE participant_id=$1 AND device_id=$2 AND consumed_at IS NULL
    ORDER BY token_hash`, [principal.participantId, principal.deviceId]);
  return result.rows.map((row) => row.token_hash);
}

function failOneSuccessAuditUpdate(basePool, schema) {
  let failed = false;
  const quotedAudit = `UPDATE "${schema}"."admin_action_audit"`;
  const interceptedPool = {
    async connect() {
      const client = await basePool.connect();
      return {
        query(text, values) {
          if (!failed && text.startsWith(quotedAudit) && values?.[0] === "success") {
            failed = true;
            throw new Error("synthetic terminal audit write failure");
          }
          return client.query(text, values);
        },
        release(discard) {
          return client.release(discard);
        },
      };
    },
  };
  return { pool: interceptedPool, wasInjected: () => failed };
}

/** Run one independent fixture change immediately after a selected query has
 * returned but before the caller receives its rows. This models a concurrent
 * owner/client transition between the recovery page and its fresh proof. */
function interposeAfterQuery(basePool, matches, after) {
  let injected = false;
  const interceptedPool = {
    async connect() {
      const client = await basePool.connect();
      return {
        query(text, values) {
          return client.query(text, values).then(async (result) => {
            if (!injected && matches(text)) {
              injected = true;
              await after();
            }
            return result;
          });
        },
        release(discard) {
          return client.release(discard);
        },
      };
    },
  };
  return { pool: interceptedPool, wasInjected: () => injected };
}

async function enableOwnerProcessing(context) {
  await pool.query(`UPDATE ${context.table("collection_controls")}
    SET revision=revision+1, control_state='degraded', processing_enabled=true,
        reason_code='maintenance', updated_at=clock_timestamp() WHERE singleton=1`);
}

async function containOwnerProcessing(context) {
  await pool.query(`UPDATE ${context.table("collection_controls")}
    SET revision=revision+1, control_state='contained', enrollment_enabled=false,
        upload_registration_enabled=false, processing_enabled=false, publication_enabled=false,
        reason_code='maintenance', updated_at=clock_timestamp() WHERE singleton=1`);
}

async function devicePredecessors(context, principal) {
  const result = await pool.query(`SELECT token_hash, created_at, expires_at, consumed_at, days_json
    FROM ${context.table("telemetry_v12_domain_predecessors")}
    WHERE participant_id=$1 AND device_id=$2 ORDER BY token_hash`,
  [principal.participantId, principal.deviceId]);
  return result.rows;
}

function newGeneration(result, previousGenerationId) {
  assert.equal(result.replay, false);
  assert.equal("unchanged" in result, false);
  assert.equal("requestedManifestDigest" in result, false);
  assert.notEqual(result.generationId, previousGenerationId);
  return result;
}

test("an identical second pass returns the unchanged receipt and writes nothing", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12unch", async (context) => {
    const participant = await seedParticipant(context, "single");
    const principal = await seedDevice(context, participant, "single");
    const days = [
      await admitQuotaDay(context, principal, DAY_ONE),
      await registerEmptyDay(context, principal, DAY_TWO),
    ];
    const revisionBefore = await inputRevision(context, principal.participantId);
    const sequenceBefore = await maxSequence(context);

    const first = await clientPass(context, principal, days);
    assert.equal(first.renewed.previousGenerationId, null);
    newGeneration(first.result, null);
    assert.deepEqual(first.result, {
      schemaVersion: "telemetry-domain-activation-v1.2",
      generationId: first.result.generationId,
      manifestDigest: first.manifest.manifestDigest,
      fromDay: DAY_ONE,
      throughDay: DAY_TWO,
      replay: false,
    });
    assert.deepEqual(await head(context, principal.participantId),
      { generation_id: first.result.generationId, revision: 1 });
    assert.notEqual((await predecessorRow(context, first.renewed.token)).consumed_at, null);
    assert.equal(await maxSequence(context), sequenceBefore + 1,
      "a real head change journals exactly one source event, so the sequence probe is live");
    assert.equal(await inputRevision(context, principal.participantId), revisionBefore,
      "a v1.2 head change does not advance community_analytical_input_versions on PostgreSQL");

    // The next client pass: new tokens, same day vector. The requested digest
    // differs only because it names the first generation as its predecessor.
    const before = await context.domain.createPredecessor(principal);
    const renewed = await context.domain.createPredecessor(principal);
    assert.equal(renewed.previousGenerationId, first.result.generationId);
    const second = domainManifest(renewed, days);
    assert.notEqual(second.manifestDigest, first.manifest.manifestDigest);
    const quiet = await snapshot(context);
    const sequence = await maxSequence(context);
    const receipt = await context.domain.activate(principal, second);
    assert.deepEqual(receipt, {
      schemaVersion: "telemetry-domain-activation-v1.2",
      generationId: first.result.generationId,
      manifestDigest: first.manifest.manifestDigest,
      fromDay: DAY_ONE,
      throughDay: DAY_TWO,
      replay: true,
      unchanged: true,
      requestedManifestDigest: second.manifestDigest,
    });
    assert.deepEqual(await snapshot(context), quiet,
      "an unchanged receipt writes no domain, day, head, predecessor, journal or revision row");
    assert.equal(await maxSequence(context), sequence);
    assert.deepEqual(await head(context, principal.participantId),
      { generation_id: first.result.generationId, revision: 1 });
    assert.equal((await predecessorRow(context, renewed.token)).consumed_at, null,
      "the renewed predecessor stays unconsumed");
    assert.equal((await predecessorRow(context, before.token)).consumed_at, null);
    const counts = await pool.query(`SELECT
        (SELECT count(*)::integer FROM ${context.table("telemetry_v12_domains")}) AS domains,
        (SELECT count(*)::integer FROM ${context.table("telemetry_v12_domain_days")}) AS days,
        (SELECT count(*)::integer FROM ${context.table("telemetry_v12_domain_heads")}) AS heads`);
    assert.deepEqual(counts.rows[0], { domains: 1, days: 2, heads: 1 });

    // A retried request is the same acknowledgement, and the original
    // activation still replays by digest without the unchanged marker.
    assert.deepEqual(await context.domain.activate(principal, second), receipt);
    assert.deepEqual(await context.domain.activate(principal, first.manifest), { ...first.result, replay: true });
    assert.deepEqual(await snapshot(context), quiet);

    // The digest excludes the token, so every later unchanged pass requests
    // the same digest and receives the same receipt.
    const third = await clientPass(context, principal, days);
    assert.equal(third.manifest.manifestDigest, second.manifestDigest);
    assert.deepEqual(third.result, receipt);
    assert.equal((await predecessorRow(context, third.renewed.token)).consumed_at, null);
    assert.equal(await maxSequence(context), sequence);
    assert.deepEqual(await head(context, principal.participantId),
      { generation_id: first.result.generationId, revision: 1 });
  });
});

test("a changed day vector or input takes the normal path, and a stale predecessor is refused", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12chg", async (context) => {
    const participant = await seedParticipant(context, "changes");
    const principal = await seedDevice(context, participant, "changes");
    const dayOne = await registerEmptyDay(context, principal, DAY_ONE);
    const first = newGeneration((await clientPass(context, principal, [dayOne])).result, null);

    // An added ready day.
    const dayTwo = await registerEmptyDay(context, principal, DAY_TWO);
    let sequence = await maxSequence(context);
    const added = newGeneration((await clientPass(context, principal, [dayOne, dayTwo])).result,
      first.generationId);
    assert.deepEqual(await head(context, principal.participantId),
      { generation_id: added.generationId, revision: 2 });
    assert.equal(await maxSequence(context), sequence + 1);
    const addedAgain = (await clientPass(context, principal, [dayOne, dayTwo])).result;
    assert.equal(addedAgain.unchanged, true);
    assert.equal(addedAgain.generationId, added.generationId);

    // A replaced same-day manifest (an additive, empty successor).
    const replacement = await registerEmptyDay(context, principal, DAY_TWO, "synthetic-empty-day-2");
    assert.notEqual(replacement.manifestId, dayTwo.manifestId);
    sequence = await maxSequence(context);
    const replaced = newGeneration((await clientPass(context, principal, [dayOne, replacement])).result,
      added.generationId);
    assert.equal(await maxSequence(context), sequence + 1);
    const replacedDays = await pool.query(`SELECT manifest_id FROM ${context.table("telemetry_v12_domain_days")}
      WHERE generation_id=$1 AND observed_day=$2::date`, [replaced.generationId, DAY_TWO]);
    assert.deepEqual(replacedDays.rows, [{ manifest_id: replacement.manifestId }]);

    // An input revision that changed since the head's generation.
    const vector = [dayOne, replacement];
    await pool.query(`UPDATE ${context.table("community_analytical_input_versions")}
      SET revision = revision + 1 WHERE participant_id=$1`, [principal.participantId]);
    const revisedPass = await clientPass(context, principal, vector);
    const revised = newGeneration(revisedPass.result, replaced.generationId);
    const revisedRow = await pool.query(`SELECT input_revision FROM ${context.table("telemetry_v12_domains")}
      WHERE id=$1`, [revised.generationId]);
    assert.equal(revisedRow.rows[0].input_revision, await inputRevision(context, principal.participantId));

    // An expired predecessor is refused before any receipt, although a fresh
    // one with the same vector is unchanged.
    const quiet = await snapshot(context);
    const expired = await context.domain.createPredecessor(principal, Date.now() - PREDECESSOR_TTL_MS - 60_000);
    assert.ok(Date.parse(expired.expiresAt) < Date.now());
    await assert.rejects(context.domain.activate(principal, domainManifest(expired, vector)),
      { status: 409, code: "TELEMETRY_MANIFEST_CONFLICT" });
    const fresh = (await clientPass(context, principal, vector)).result;
    assert.equal(fresh.unchanged, true);
    assert.equal(fresh.generationId, revised.generationId);
    const afterFresh = await snapshot(context);
    for (const name of SNAPSHOT_TABLES) {
      if (name === "telemetry_v12_domain_predecessors") continue;
      assert.deepEqual(afterFresh[name], quiet[name], `${name} is unchanged by the refusal and receipt`);
    }

    // The predecessor that the revised generation consumed is refused for any
    // other vector; its own vector still replays by digest.
    assert.notEqual((await predecessorRow(context, revisedPass.renewed.token)).consumed_at, null);
    await assert.rejects(context.domain.activate(principal, domainManifest(revisedPass.renewed, [dayOne, dayTwo])),
      { status: 409, code: "TELEMETRY_MANIFEST_CONFLICT" });
    assert.deepEqual(await context.domain.activate(principal, revisedPass.manifest), { ...revised, replay: true });

    // An input change after the predecessor was issued is refused, not
    // acknowledged: the receipt cannot skip a raced mutation.
    const raced = await context.domain.createPredecessor(principal);
    await pool.query(`UPDATE ${context.table("community_analytical_input_versions")}
      SET revision = revision + 1 WHERE participant_id=$1`, [principal.participantId]);
    await assert.rejects(context.domain.activate(principal, domainManifest(raced, vector)),
      { status: 409, code: "TELEMETRY_MANIFEST_CONFLICT" });
    assert.deepEqual(await head(context, principal.participantId),
      { generation_id: revised.generationId, revision: 4 });
    const generations = await pool.query(`SELECT count(*)::integer AS n FROM ${context.table("telemetry_v12_domains")}`);
    assert.equal(generations.rows[0].n, 4);
  });
});

test("concurrent v1.2 activations serialize before comparing a missing head", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12cas0", async (context) => {
    const race = await raceFixture(context, "cas-no-head", false);
    await assertSerializedActivationRace(context, race);
  });
});

test("concurrent v1.2 activations serialize before comparing an existing head", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12cas1", async (context) => {
    const race = await raceFixture(context, "cas-existing-head", true);
    assert.ok(race.previousGenerationId);
    await assertSerializedActivationRace(context, race);
  });
});

test("two devices of one social participant never cross-match an unchanged receipt", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12dev", async (context) => {
    const participant = await seedParticipant(context, "two-devices");
    const deviceA = await seedDevice(context, participant, "a");
    const deviceB = await seedDevice(context, participant, "b");
    const vectorA = [await registerEmptyDay(context, deviceA, DAY_ONE)];
    const vectorB = [await registerEmptyDay(context, deviceB, DAY_ONE)];

    const a1 = newGeneration((await clientPass(context, deviceA, vectorA)).result, null);
    const b1 = newGeneration((await clientPass(context, deviceB, vectorB)).result, a1.generationId);
    // The participant head now names B's generation: A's identical vector is
    // a new generation, never a receipt for B's.
    const a2 = newGeneration((await clientPass(context, deviceA, vectorA)).result, b1.generationId);
    assert.notEqual(a2.generationId, a1.generationId);

    // B presents A's exact current vector against A's head. Only the device
    // scope separates this from an unchanged receipt for A's generation.
    // A's manifest is absent from B's READY set: the ordinary completeness
    // gate returns the same INCOMPLETE refusal as the D1 activation path.
    const quiet = await snapshot(context);
    const borrowed = await context.domain.createPredecessor(deviceB);
    assert.equal(borrowed.previousGenerationId, a2.generationId);
    await assert.rejects(context.domain.activate(deviceB, domainManifest(borrowed, vectorA)),
      { status: 409, code: "TELEMETRY_MANIFEST_INCOMPLETE" });
    const afterBorrowed = await snapshot(context);
    for (const name of SNAPSHOT_TABLES) {
      if (name === "telemetry_v12_domain_predecessors") continue;
      assert.deepEqual(afterBorrowed[name], quiet[name], `${name} is unchanged by the refusal`);
    }

    const b2 = newGeneration((await clientPass(context, deviceB, vectorB)).result, a2.generationId);
    assert.notEqual(b2.generationId, b1.generationId);
    const b3 = (await clientPass(context, deviceB, vectorB)).result;
    assert.equal(b3.unchanged, true, "the device that owns the head still receives the receipt");
    assert.equal(b3.generationId, b2.generationId);
    const a3 = newGeneration((await clientPass(context, deviceA, vectorA)).result, b2.generationId);
    assert.deepEqual(await head(context, participant.participantId),
      { generation_id: a3.generationId, revision: 5 });
  });
});

test("an empty-day-only domain is unchanged on the second pass", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12empty", async (context) => {
    const participant = await seedParticipant(context, "empty");
    const principal = await seedDevice(context, participant, "empty");
    const vector = [
      await registerEmptyDay(context, principal, DAY_ONE),
      await registerEmptyDay(context, principal, DAY_TWO),
    ];
    const chunks = await pool.query(`SELECT count(*)::integer AS n FROM ${context.table("telemetry_v12_chunks")}`);
    assert.equal(chunks.rows[0].n, 0);
    const first = newGeneration((await clientPass(context, principal, vector)).result, null);
    const quiet = await snapshot(context);
    const second = await clientPass(context, principal, vector);
    assert.deepEqual(second.result, {
      ...first,
      replay: true,
      unchanged: true,
      requestedManifestDigest: second.manifest.manifestDigest,
    });
    const afterSecond = await snapshot(context);
    for (const name of SNAPSHOT_TABLES) {
      if (name === "telemetry_v12_domain_predecessors") continue;
      assert.deepEqual(afterSecond[name], quiet[name], `${name} is unchanged by the receipt`);
    }
  });
});

test("the unchanged receipt stays behind the v1.2 write gate and the active-participant check", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12gate", async (context) => {
    const participant = await seedParticipant(context, "gated");
    const principal = await seedDevice(context, participant, "gated");
    const vector = [await registerEmptyDay(context, principal, DAY_ONE)];
    const first = newGeneration((await clientPass(context, principal, vector)).result, null);

    // A fresh predecessor with the head's exact vector, issued while the
    // device is still admitted: only the admission state below differs from
    // an unchanged receipt.
    const fresh = await context.domain.createPredecessor(principal);
    const manifest = domainManifest(fresh, vector);
    const expectedReceipt = {
      ...first,
      replay: true,
      unchanged: true,
      requestedManifestDigest: manifest.manifestDigest,
    };
    const quiet = await snapshot(context);
    const refusedWithoutWrites = async (expected, message) => {
      await assert.rejects(context.domain.activate(principal, manifest), expected, message);
      assert.deepEqual(await snapshot(context), quiet, `${message}: nothing is written`);
      assert.equal((await predecessorRow(context, fresh.token)).consumed_at, null);
    };

    // A revoked v1.2 capability (opt-out or security reset) blocks transport.
    await pool.query(`UPDATE ${context.table("telemetry_v12_device_capabilities")}
      SET state='revoked', revoked_at=$3 WHERE participant_id=$1 AND device_id=$2`,
    [principal.participantId, principal.deviceId, new Date().toISOString()]);
    await refusedWithoutWrites({ status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED" },
      "a revoked device is blocked, not acknowledged as current");
    await pool.query(`UPDATE ${context.table("telemetry_v12_device_capabilities")}
      SET state='accepted', revoked_at=NULL WHERE participant_id=$1 AND device_id=$2`,
    [principal.participantId, principal.deviceId]);

    // A blocked v1.2 runtime blocks transport for every device.
    await pool.query(`UPDATE ${context.table("telemetry_v12_runtime")} SET state='blocked' WHERE id=1`);
    await refusedWithoutWrites({ status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED" },
      "a blocked runtime is not acknowledged");
    await pool.query(`UPDATE ${context.table("telemetry_v12_runtime")} SET state='active' WHERE id=1`);

    // Control: once admitted again, the same predecessor and manifest reach
    // the receipt, so both refusals above came from admission alone.
    assert.deepEqual(await context.domain.activate(principal, manifest), expectedReceipt);
    assert.deepEqual(await snapshot(context), quiet);

    // A participant that has left 'active' fails the write gate's identity
    // check (401) before the state check. The state change itself advances
    // the input revisions, so the no-write baseline is taken after it; the
    // head and the predecessor's revision still match, so only the ordering
    // keeps this from becoming a receipt.
    await pool.query(`UPDATE ${context.table("participants")} SET state='deleting' WHERE id=$1`,
      [principal.participantId]);
    const deletingQuiet = await snapshot(context);
    await assert.rejects(context.domain.activate(principal, manifest),
      { status: 401, code: "DEVICE_AUTH_INVALID" });
    assert.deepEqual(await snapshot(context), deletingQuiet,
      "a non-active participant receives no receipt and nothing is written");
    assert.equal((await predecessorRow(context, fresh.token)).consumed_at, null);
    assert.deepEqual(await head(context, principal.participantId),
      { generation_id: first.generationId, revision: 1 });
  });
});

/** An exact model of the D1 pruning rule, used as the oracle: this device's
 * unconsumed rows that are expired or ranked beyond the newest seven by
 * (created_at DESC, token_hash) are deleted. No unconsumed row in these
 * scenarios is referenced by a domain; a separate test covers that guard.
 * `rankable` is the set the newest-seven rank is taken over. The rule ranks
 * only this device's unconsumed rows; the tests pass wider sets only to prove
 * that a scenario would expose a mis-scoped rank. */
function expectedAfterIssue(model, nowEpoch, rankable = model.filter((row) => !row.consumed)) {
  const ranked = [...rankable].sort((a, b) => b.createdAt - a.createdAt
    || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const beyondNewest = new Set(ranked.slice(NEWEST_KEPT).map((row) => row.hash));
  return model.filter((row) => row.consumed
    || !(row.expiresAt <= nowEpoch || beyondNewest.has(row.hash)));
}

function survivingHashes(model) {
  return model.filter((row) => !row.consumed).map((row) => row.hash).sort();
}

/** Issue one predecessor for `principal` at `nowEpoch` against a per-device
 * oracle ledger, then assert every tracked device's unconsumed set exactly.
 * `mutants` maps a name to a function that returns the wider `rankable` set
 * a mis-scoped rank would use; the result records whether that mutant would
 * have left a different set for the issuing device on this issue. */
async function issueChecked(context, ledger, principal, nowEpoch, mutants = {}) {
  const entry = ledger.get(principal.deviceId);
  const expected = expectedAfterIssue(entry.rows, nowEpoch);
  const diverged = {};
  for (const [name, rankable] of Object.entries(mutants)) {
    diverged[name] = JSON.stringify(survivingHashes(expectedAfterIssue(entry.rows, nowEpoch, rankable(ledger))))
      !== JSON.stringify(survivingHashes(expected));
  }
  entry.rows = expected;
  const predecessor = await context.domain.createPredecessor(principal, nowEpoch);
  entry.rows.push({
    hash: sha256Hex(predecessor.token),
    createdAt: nowEpoch,
    expiresAt: nowEpoch + PREDECESSOR_TTL_MS,
    consumed: false,
  });
  for (const tracked of ledger.values()) {
    assert.deepEqual(await unconsumedFor(context, tracked.principal), survivingHashes(tracked.rows),
      `device ${tracked.label}: exactly the oracle's unconsumed predecessors survive`);
    assert.ok(survivingHashes(tracked.rows).length <= OUTSTANDING_CAP);
  }
  return { predecessor, diverged };
}

test("predecessor pruning keeps the newest seven across twelve unchanged passes", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12prune", async (context) => {
    const participant = await seedParticipant(context, "prune");
    const principal = await seedDevice(context, participant, "prune");
    const other = await seedDevice(context, participant, "other");
    const vector = [await registerEmptyDay(context, principal, DAY_ONE)];
    const startEpoch = Date.now();
    // Another device of the same participant holds outstanding predecessors.
    for (let index = 0; index < 3; index += 1) {
      await context.domain.createPredecessor(other, startEpoch - (index + 1) * 60_000);
    }
    const otherRows = await devicePredecessors(context, other);
    assert.equal(otherRows.length, 3);

    let model = [];
    let generationId = null;
    let firstUnprunedRefusal = null;
    let sequence = null;
    const unchangedPasses = 12;
    for (let pass = 1; pass <= unchangedPasses + 1; pass += 1) {
      // The shipped client runs every four hours; both requests share the
      // pass timestamp, so same-instant rows are ordered by token hash.
      const nowEpoch = startEpoch + (pass - 1) * CLIENT_PASS_INTERVAL_MS;
      const issued = [];
      for (const label of ["before", "renewed"]) {
        // The pre-change rule deleted only expired rows, so every issued,
        // unconsumed and unexpired predecessor would still count here.
        const unprunedOutstanding = model.filter((row) => !row.consumed && row.expiresAt > nowEpoch).length;
        if (firstUnprunedRefusal === null && unprunedOutstanding >= OUTSTANDING_CAP) {
          firstUnprunedRefusal = pass;
        }
        const survivors = new Set(expectedAfterIssue(model.filter((row) => !row.pruned), nowEpoch)
          .map((row) => row.hash));
        for (const row of model) if (!row.pruned && !survivors.has(row.hash)) row.pruned = true;
        let predecessor;
        try {
          predecessor = await context.domain.createPredecessor(principal, nowEpoch);
        } catch (error) {
          assert.fail(`pass ${pass}: the '${label}' predecessor was refused with ${error?.code ?? error}`);
        }
        model.push({
          hash: sha256Hex(predecessor.token),
          createdAt: nowEpoch,
          expiresAt: nowEpoch + PREDECESSOR_TTL_MS,
          consumed: false,
          pruned: false,
        });
        issued.push(predecessor);
        const live = model.filter((row) => !row.pruned && !row.consumed).map((row) => row.hash).sort();
        assert.deepEqual(await unconsumedFor(context, principal), live,
          `pass ${pass} '${label}': exactly the newest seven unconsumed predecessors survive, plus the new one`);
        assert.ok(live.length <= OUTSTANDING_CAP, `pass ${pass}: at most eight unconsumed predecessors remain`);
      }
      const [before, renewed] = issued;
      assert.equal(renewed.legacyFingerprint, before.legacyFingerprint);
      const manifest = domainManifest(renewed, vector);
      const result = await context.domain.activate(principal, manifest);
      if (pass === 1) {
        newGeneration(result, null);
        generationId = result.generationId;
        model.find((row) => row.hash === sha256Hex(renewed.token)).consumed = true;
        sequence = await maxSequence(context);
      } else {
        assert.equal(result.unchanged, true, `pass ${pass} is an unchanged receipt`);
        assert.equal(result.generationId, generationId);
        assert.equal(result.requestedManifestDigest, manifest.manifestDigest);
      }
    }

    assert.equal(firstUnprunedRefusal, 5,
      "without pruning, the fifth pass would reach the eight-outstanding refusal");
    const counts = await pool.query(`SELECT
        (SELECT count(*)::integer FROM ${context.table("telemetry_v12_domains")}) AS domains,
        (SELECT count(*)::integer FROM ${context.table("telemetry_v12_domain_predecessors")}
          WHERE participant_id=$1 AND device_id=$2 AND consumed_at IS NOT NULL) AS consumed`,
    [principal.participantId, principal.deviceId]);
    assert.deepEqual(counts.rows[0], { domains: 1, consumed: 1 });
    assert.equal(await maxSequence(context), sequence, "unchanged passes journal nothing");
    assert.deepEqual(await head(context, principal.participantId), { generation_id: generationId, revision: 1 });
    // The survivors are exactly the eight newest issued predecessors.
    const newest = model.filter((row) => !row.consumed)
      .sort((a, b) => b.createdAt - a.createdAt || (a.hash < b.hash ? -1 : 1))
      .slice(0, OUTSTANDING_CAP).map((row) => row.hash).sort();
    assert.deepEqual(await unconsumedFor(context, principal), newest);
    assert.deepEqual(await devicePredecessors(context, other), otherRows,
      "another device's predecessors are untouched");
  });
});

test("pruning removes expired predecessors but never one a domain references", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12ref", async (context) => {
    const participant = await seedParticipant(context, "referenced");
    const principal = await seedDevice(context, participant, "referenced");
    const vector = [await registerEmptyDay(context, principal, DAY_ONE)];
    const first = newGeneration((await clientPass(context, principal, vector)).result, null);

    const nowEpoch = Date.now();
    const expired = await context.domain.createPredecessor(principal, nowEpoch - PREDECESSOR_TTL_MS - HOUR_MS);
    const referenced = await context.domain.createPredecessor(principal, nowEpoch - PREDECESSOR_TTL_MS - 2 * HOUR_MS);
    const referencedHash = sha256Hex(referenced.token);
    // A synthetic historical generation that still references an unconsumed
    // predecessor (for example an imported row). It is not the head.
    await pool.query(`INSERT INTO ${context.table("telemetry_v12_domains")}(
      id, participant_id, device_id, predecessor_token_hash, previous_generation_id,
      manifest_digest, legacy_fingerprint, input_revision, from_day, through_day,
      days_json, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$9::date,'[]',$10)`, [
      randomUUID(), principal.participantId, principal.deviceId, referencedHash,
      first.generationId, randomBytes(32).toString("hex"), referenced.legacyFingerprint,
      await inputRevision(context, principal.participantId), DAY_ONE,
      new Date(nowEpoch - PREDECESSOR_TTL_MS).toISOString(),
    ]);
    const unconsumedBefore = await unconsumedFor(context, principal);
    assert.ok(unconsumedBefore.includes(sha256Hex(expired.token)));
    assert.ok(unconsumedBefore.includes(referencedHash));

    // Ten fresh issues push the referenced row past the newest seven as well.
    const fresh = [];
    for (let index = 0; index < 10; index += 1) {
      fresh.push(await context.domain.createPredecessor(principal, nowEpoch + index * 1_000));
      const live = await unconsumedFor(context, principal);
      assert.equal(live.includes(sha256Hex(expired.token)), false, "an expired unreferenced predecessor is pruned");
      assert.equal(live.includes(referencedHash), true, "a referenced predecessor is never deleted");
    }
    // The newest seven before the last issue, the last issue, and the
    // referenced row: nothing else of this device's is unconsumed.
    const survivors = fresh.slice(-NEWEST_KEPT - 1).map((item) => sha256Hex(item.token));
    assert.deepEqual(await unconsumedFor(context, principal), [...survivors, referencedHash].sort());
    const remaining = await pool.query(`SELECT count(*)::integer AS n
      FROM ${context.table("telemetry_v12_domain_predecessors")} WHERE token_hash=$1`, [referencedHash]);
    assert.equal(remaining.rows[0].n, 1);
    // The last fresh predecessor still activates to an unchanged receipt.
    const receipt = await context.domain.activate(principal, domainManifest(fresh.at(-1), vector));
    assert.equal(receipt.unchanged, true);
    assert.equal(receipt.generationId, first.generationId);
  });
});

test("pruning ranks each device's own predecessors when another device's are newer", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12devrank", async (context) => {
    const participant = await seedParticipant(context, "device-rank");
    const deviceA = await seedDevice(context, participant, "rank-a");
    const deviceB = await seedDevice(context, participant, "rank-b");
    const ledger = new Map([
      [deviceA.deviceId, { label: "A", principal: deviceA, rows: [] }],
      [deviceB.deviceId, { label: "B", principal: deviceB, rows: [] }],
    ]);
    // A participant-wide rank would take the newest seven across both devices.
    const mutants = {
      participantWide: (all) => [...all.values()].flatMap((entry) => entry.rows.filter((row) => !row.consumed)),
    };
    const startEpoch = Date.now();
    let tick = 0;
    let participantWideDivergences = 0;
    const issue = async (principal) => {
      tick += 1;
      const { diverged } = await issueChecked(context, ledger, principal, startEpoch + tick * 1_000, mutants);
      if (diverged.participantWide) participantWideDivergences += 1;
    };
    // A's rows are older than all of B's, which then fill a participant-wide
    // newest seven on their own, before A and B keep issuing in turn.
    for (let index = 0; index < 3; index += 1) await issue(deviceA);
    for (let index = 0; index < 7; index += 1) await issue(deviceB);
    await issue(deviceA);
    assert.equal(ledger.get(deviceA.deviceId).rows.length, 4,
      "A keeps all four of its own predecessors although B holds seven newer ones");
    for (let index = 0; index < 2; index += 1) await issue(deviceB);
    for (let index = 0; index < 6; index += 1) await issue(deviceA);
    assert.ok(participantWideDivergences > 0,
      "the scenario is discriminating: a participant-wide rank would have deleted A's rows");
    assert.equal(survivingHashes(ledger.get(deviceA.deviceId).rows).length, OUTSTANDING_CAP);
    assert.equal(survivingHashes(ledger.get(deviceB.deviceId).rows).length, OUTSTANDING_CAP);
  });
});

test("pruning ranks only unconsumed predecessors when changed and unchanged passes interleave", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12consumed", async (context) => {
    const participant = await seedParticipant(context, "consumed-rank");
    const principal = await seedDevice(context, participant, "consumed-rank");
    const ledger = new Map([[principal.deviceId, { label: "principal", principal, rows: [] }]]);
    // A rank that also counted consumed rows would let them take slots.
    const mutants = { withConsumed: (all) => all.get(principal.deviceId).rows };
    let current = await registerEmptyDay(context, principal, DAY_ONE);
    const startEpoch = Date.now();
    let generationId = null;
    let consumedDivergences = 0;
    const passes = 9;
    for (let pass = 1; pass <= passes; pass += 1) {
      // Odd passes carry a replaced same-day manifest and consume their
      // renewed predecessor; even passes are unchanged and consume nothing,
      // so consumed and unconsumed rows interleave in creation order. The
      // passes are a minute apart, so no row expires and only rank prunes.
      const changed = pass % 2 === 1;
      if (changed && pass > 1) {
        current = await registerEmptyDay(context, principal, DAY_ONE, `synthetic-empty-day-pass-${pass}`);
      }
      const nowEpoch = startEpoch + (pass - 1) * 60_000;
      const issued = [];
      for (let index = 0; index < 2; index += 1) {
        const { predecessor, diverged } = await issueChecked(context, ledger, principal, nowEpoch, mutants);
        if (diverged.withConsumed) consumedDivergences += 1;
        issued.push(predecessor);
      }
      const [before, renewed] = issued;
      assert.equal(renewed.legacyFingerprint, before.legacyFingerprint);
      const result = await context.domain.activate(principal, domainManifest(renewed, [current]));
      if (changed) {
        newGeneration(result, generationId);
        generationId = result.generationId;
        ledger.get(principal.deviceId).rows.find((row) => row.hash === sha256Hex(renewed.token)).consumed = true;
        assert.notEqual((await predecessorRow(context, renewed.token)).consumed_at, null);
      } else {
        assert.equal(result.unchanged, true, `pass ${pass} is an unchanged receipt`);
        assert.equal(result.generationId, generationId);
        assert.equal((await predecessorRow(context, renewed.token)).consumed_at, null);
      }
      assert.deepEqual(await unconsumedFor(context, principal), survivingHashes(ledger.get(principal.deviceId).rows),
        `pass ${pass}: activation changes only the consumed marker of its own predecessor`);
    }
    const consumed = ledger.get(principal.deviceId).rows.filter((row) => row.consumed);
    assert.equal(consumed.length, Math.ceil(passes / 2));
    assert.ok(consumedDivergences > 0,
      "the scenario is discriminating: counting consumed rows in the rank would have deleted unconsumed ones");
    // Consumed rows are never pruned, whatever their age.
    const consumedRows = await pool.query(`SELECT token_hash
      FROM ${context.table("telemetry_v12_domain_predecessors")}
      WHERE participant_id=$1 AND device_id=$2 AND consumed_at IS NOT NULL ORDER BY token_hash`,
    [principal.participantId, principal.deviceId]);
    assert.deepEqual(consumedRows.rows.map((row) => row.token_hash), consumed.map((row) => row.hash).sort());
  });
});

test("the eight-outstanding refusal still holds when referenced predecessors survive pruning", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12cap", async (context) => {
    const participant = await seedParticipant(context, "cap");
    const principal = await seedDevice(context, participant, "cap");
    const vector = [await registerEmptyDay(context, principal, DAY_ONE)];
    const first = newGeneration((await clientPass(context, principal, vector)).result, null);

    // An unexpired, unconsumed predecessor that a (synthetic, non-head)
    // domain references: pruning must keep it and it counts toward the cap.
    const nowEpoch = Date.now();
    const referenced = await context.domain.createPredecessor(principal, nowEpoch);
    const referencedHash = sha256Hex(referenced.token);
    await pool.query(`INSERT INTO ${context.table("telemetry_v12_domains")}(
      id, participant_id, device_id, predecessor_token_hash, previous_generation_id,
      manifest_digest, legacy_fingerprint, input_revision, from_day, through_day,
      days_json, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$9::date,'[]',$10)`, [
      randomUUID(), principal.participantId, principal.deviceId, referencedHash,
      first.generationId, randomBytes(32).toString("hex"), referenced.legacyFingerprint,
      await inputRevision(context, principal.participantId), DAY_ONE,
      new Date(nowEpoch).toISOString(),
    ]);

    // Seven newer predecessors: the referenced row falls beyond the newest
    // seven but stays, and the first pass's 'before' row is pruned.
    const fresh = [];
    for (let index = 1; index <= NEWEST_KEPT; index += 1) {
      fresh.push(await context.domain.createPredecessor(principal, nowEpoch + index * 1_000));
    }
    const outstanding = [...fresh.map((item) => sha256Hex(item.token)), referencedHash].sort();
    assert.equal(outstanding.length, OUTSTANDING_CAP);
    assert.deepEqual(await unconsumedFor(context, principal), outstanding);
    const quiet = await snapshot(context);
    await assert.rejects(context.domain.createPredecessor(principal, nowEpoch + (NEWEST_KEPT + 1) * 1_000),
      { status: 409, code: "TELEMETRY_MANIFEST_CONFLICT" });
    assert.deepEqual(await snapshot(context), quiet, "the refused issue writes and deletes nothing");
    assert.deepEqual(await unconsumedFor(context, principal), outstanding);

    // The newest outstanding predecessor still activates to the receipt.
    const receipt = await context.domain.activate(principal, domainManifest(fresh.at(-1), vector));
    assert.equal(receipt.unchanged, true);
    assert.equal(receipt.generationId, first.generationId);
  });
});

test("owner recovery activates social and accountless domains at the ordinary predecessor cap", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12owner_positive", async (context) => {
    await enableOwnerProcessing(context);
    const socialParticipant = await seedParticipant(context, "owner-social-positive");
    const social = await seedDevice(context, socialParticipant, "owner-social-positive");
    const accountless = await seedAccountlessDevice(context, "owner-positive");
    const manifestTime = Date.now() - HOUR_MS;
    const socialDayOneBaseline = await registerEmptyDay(context, social, DAY_ONE,
      "synthetic-owner-social-day-one-baseline", manifestTime);
    const socialDayOneLatest = await registerEmptyDay(context, social, DAY_ONE,
      "synthetic-owner-social-day-one-latest", manifestTime + 30 * 60_000);
    const socialDays = [
      socialDayOneBaseline,
      await registerEmptyDay(context, social, DAY_TWO, "synthetic-owner-social-day-two"),
    ];
    const accountlessDays = [
      await registerEmptyDay(context, accountless, DAY_ONE, "synthetic-owner-accountless-day-one"),
    ];
    const clientTokens = [];
    for (let index = 0; index < NEWEST_KEPT; index += 1) {
      clientTokens.push(await context.domain.createPredecessor(social, Date.now() + index));
    }
    const sequenceBefore = await maxSequence(context);
    const recover = modules.createPostgresV12OwnerRecovery({
      pool,
      schema: context.options.schema,
      cursorSecret: randomBytes(32).toString("hex"),
    });
    const result = await recover({
      body: { action: "run_maintenance", v12DomainRecovery: { dryRun: false, maxDevices: 2 } },
      identityKey: "synthetic-owner-recovery-operator",
    });
    assert.deepEqual(result.outcomes, {
      activated: 2, eligible: 0, already_active: 0, authority_unavailable: 0, refused: 0,
    });
    assert.equal(result.examined, 2);
    assert.equal(result.daysCovered, 3);
    assert.equal(result.nextAfterParticipantId, null);
    assert.ok(await head(context, socialParticipant.participantId));
    assert.ok(await head(context, accountless.participantId));
    for (const clientToken of clientTokens) {
      assert.equal((await predecessorRow(context, clientToken.token)).consumed_at, null,
        "ordinary unconsumed client predecessors remain untouched by owner recovery");
    }
    const socialTokens = await pool.query(`SELECT count(*) FILTER (WHERE consumed_at IS NULL)::integer AS unconsumed,
      count(*) FILTER (WHERE consumed_at IS NOT NULL)::integer AS consumed
      FROM ${context.table("telemetry_v12_domain_predecessors")}
      WHERE participant_id=$1 AND device_id=$2`, [social.participantId, social.deviceId]);
    assert.deepEqual(socialTokens.rows[0], { unconsumed: NEWEST_KEPT, consumed: 1 },
      "the owner issue uses the ordinary cap: seven client tokens remain outstanding while its token is consumed");
    assert.equal(await maxSequence(context), sequenceBefore + 2,
      "both successful owner activations produce their normal source journal event");
    const publicOwners = await pool.query(`SELECT participant_id,owner_kind,device_id
      FROM ${context.table("community_public_source_owners")}
      WHERE participant_id = ANY($1::text[]) ORDER BY owner_kind,participant_id`,
    [[socialParticipant.participantId, accountless.participantId]]);
    assert.deepEqual(publicOwners.rows, [
      { participant_id: accountless.participantId, owner_kind: "accountless", device_id: accountless.deviceId },
      { participant_id: socialParticipant.participantId, owner_kind: "social", device_id: null },
    ], "both activated owners satisfy the maintained public-source eligibility contract");
    const ownerJournalEvents = await pool.query(`SELECT receipt.participant_id,
        count(change.sequence)::integer AS journal_events,
        count(*) FILTER (WHERE change.kind='owner-active')::integer AS owner_active_events
      FROM ${context.table("storage_v12_event_sources")} receipt
      JOIN ${context.table("storage_ingestion_changes")} change
        ON change.source_id=$2 AND change.event_digest=receipt.event_digest
      WHERE receipt.participant_id = ANY($1::text[])
      GROUP BY receipt.participant_id ORDER BY receipt.participant_id`,
    [[socialParticipant.participantId, accountless.participantId], SOURCE_ID]);
    assert.deepEqual(ownerJournalEvents.rows.map((row) => [
      row.participant_id, row.journal_events, row.owner_active_events,
    ]), [socialParticipant.participantId, accountless.participantId].sort().map((participantId) => [
      participantId, 1, 1,
    ]), "each sharing mode emits one joined owner-active source journal event");
    const audits = await pool.query(`SELECT outcome, details_json
      FROM ${context.table("admin_action_audit")} WHERE action='run_maintenance' ORDER BY id`);
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0].outcome, "success");
    const auditDetails = JSON.parse(audits.rows[0].details_json);
    assert.equal(auditDetails.task, "v12_domain_recovery");
    assert.equal(auditDetails.outcomes.activated, 2);
    assert.equal(auditDetails.daysCovered, 3);
    assert.equal("participantId" in auditDetails, false);
    assert.equal("deviceId" in auditDetails, false);
    const consumedOwnerPredecessor = await pool.query(`SELECT days_json
      FROM ${context.table("telemetry_v12_domain_predecessors")}
      WHERE participant_id=$1 AND device_id=$2 AND consumed_at IS NOT NULL`,
    [social.participantId, social.deviceId]);
    assert.equal(consumedOwnerPredecessor.rows.length, 1);
    const baselineDays = typeof consumedOwnerPredecessor.rows[0].days_json === "string"
      ? JSON.parse(consumedOwnerPredecessor.rows[0].days_json)
      : consumedOwnerPredecessor.rows[0].days_json;
    assert.equal(baselineDays.find((item) => item.day === DAY_ONE)?.manifestId,
      socialDayOneBaseline.manifestId,
      "the issued predecessor retains the earliest READY manifest for the day");
    const activatedDays = await pool.query(`SELECT to_char(observed_day, 'YYYY-MM-DD') AS day, manifest_id
      FROM ${context.table("telemetry_v12_domain_days")} WHERE generation_id=$1 ORDER BY observed_day`,
    [(await head(context, socialParticipant.participantId)).generation_id]);
    assert.equal(activatedDays.rows.find((item) => item.day === DAY_ONE)?.manifest_id,
      socialDayOneLatest.manifestId,
      "activation consumes the exact latest READY manifest captured with the predecessor");
    assert.notEqual(socialDayOneBaseline.manifestId, socialDayOneLatest.manifestId);
    assert.deepEqual([socialDays.length, accountlessDays.length], [2, 1]);
  });
});

test("accountless v1.2 authority without the public enrollment-secret binding stays outside the source journal", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12owner_authority_only", async (context) => {
    await enableOwnerProcessing(context);
    const accountless = await seedAccountlessDevice(context, "owner-authority-only", { publicEligible: false });
    await registerEmptyDay(context, accountless, DAY_ONE, "synthetic-owner-authority-only-day");
    const activeAuthorization = await pool.query(`SELECT 1
      FROM ${context.table("telemetry_v12_typed_active_authorizations")}
      WHERE participant_id=$1 AND device_id=$2`, [accountless.participantId, accountless.deviceId]);
    assert.equal(activeAuthorization.rows.length, 1,
      "the exact v1.2 grant still supplies activation authority");
    const sequenceBefore = await maxSequence(context);
    const recover = modules.createPostgresV12OwnerRecovery({
      pool,
      schema: context.options.schema,
      cursorSecret: randomBytes(32).toString("hex"),
    });
    const result = await recover({
      body: { action: "run_maintenance", v12DomainRecovery: { dryRun: false, maxDevices: 1 } },
      identityKey: "synthetic-owner-recovery-operator",
    });
    assert.deepEqual(result.outcomes, {
      activated: 1, eligible: 0, already_active: 0, authority_unavailable: 0, refused: 0,
    });
    assert.ok(await head(context, accountless.participantId), "the authority-valid domain activates");
    const publicOwner = await pool.query(`SELECT 1 FROM ${context.table("community_public_source_owners")}
      WHERE participant_id=$1 AND device_id=$2`, [accountless.participantId, accountless.deviceId]);
    assert.equal(publicOwner.rows.length, 0,
      "the mismatched enrollment secret keeps this accountless graph outside publication eligibility");
    const receipts = await pool.query(`SELECT count(*)::integer AS n
      FROM ${context.table("storage_v12_event_sources")} WHERE participant_id=$1`, [accountless.participantId]);
    assert.equal(receipts.rows[0].n, 0);
    assert.equal(await maxSequence(context), sequenceBefore,
      "authority without the exact public-source lease does not append a journal event");
  });
});

test("a pre-activation observer failure audits the confirmed predecessor issuance without claiming activation", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12owner_issued_only", async (context) => {
    await enableOwnerProcessing(context);
    const participant = await seedParticipant(context, "owner-issued-only");
    const principal = await seedDevice(context, participant, "owner-issued-only");
    await registerEmptyDay(context, principal, DAY_ONE, "synthetic-owner-issued-only");
    let calls = 0;
    const recover = modules.createPostgresV12OwnerRecovery({
      pool,
      schema: context.options.schema,
      cursorSecret: randomBytes(32).toString("hex"),
      observeActivation: async () => {
        calls += 1;
        throw new modules.ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      },
    });
    await assert.rejects(recover({
      body: { action: "run_maintenance", v12DomainRecovery: { dryRun: false, maxDevices: 1 } },
      identityKey: "synthetic-owner-recovery-operator",
    }), { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    assert.equal(calls, 1);
    assert.equal(await head(context, participant.participantId), null);
    const issued = await devicePredecessors(context, principal);
    assert.equal(issued.length, 1);
    assert.equal(issued[0].consumed_at, null);
    const audit = await pool.query(`SELECT outcome, details_json
      FROM ${context.table("admin_action_audit")} WHERE action='run_maintenance'`);
    assert.equal(audit.rows[0]?.outcome, "failure");
    const details = JSON.parse(audit.rows[0].details_json);
    assert.equal(details.failureStage, "activation");
    assert.equal(details.predecessorIssued, true);
    assert.equal(details.currentAttemptMayHaveCommitted, false);
    assert.equal(details.completed.examined, 0);
    assert.deepEqual(Object.keys(details).sort(), [
      "completed", "currentAttemptMayHaveCommitted", "dryRun", "failureStage",
      "maxDevices", "method", "predecessorIssued", "task",
    ]);
  });
});

test("applied daysCovered follows the exact vector captured at predecessor issuance", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12owner_fresh_vector", async (context) => {
    await enableOwnerProcessing(context);
    const participant = await seedParticipant(context, "owner-fresh-vector");
    const principal = await seedDevice(context, participant, "owner-fresh-vector");
    await registerEmptyDay(context, principal, DAY_ONE, "synthetic-owner-fresh-vector-day-one");
    const injected = interposeAfterQuery(pool,
      (text) => text.includes("SELECT DISTINCT ON (chunk_day)"),
      async () => registerEmptyDay(context, principal, DAY_TWO, "synthetic-owner-fresh-vector-day-two"));
    const recover = modules.createPostgresV12OwnerRecovery({
      pool: injected.pool,
      schema: context.options.schema,
      cursorSecret: randomBytes(32).toString("hex"),
    });
    const result = await recover({
      body: { action: "run_maintenance", v12DomainRecovery: { dryRun: false, maxDevices: 1 } },
      identityKey: "synthetic-owner-recovery-operator",
    });
    assert.equal(injected.wasInjected(), true);
    assert.equal(result.outcomes.activated, 1);
    assert.equal(result.daysCovered, 2,
      "the returned aggregate counts the latest vector captured after preflight, including the new ready day");
    const activeHead = await head(context, participant.participantId);
    const activatedDays = await pool.query(`SELECT count(*)::integer AS count
      FROM ${context.table("telemetry_v12_domain_days")} WHERE generation_id=$1`, [activeHead.generation_id]);
    assert.equal(activatedDays.rows[0].count, 2);
  });
});

test("owner activation rechecks authority changed after candidate selection without issuing a token", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12owner_authority_race", async (context) => {
    await enableOwnerProcessing(context);
    const participant = await seedParticipant(context, "owner-authority-race");
    const principal = await seedDevice(context, participant, "owner-authority-race");
    await registerEmptyDay(context, principal, DAY_ONE, "synthetic-owner-authority-race");
    const injected = interposeAfterQuery(pool,
      (text) => text.includes("WITH eligible_devices AS"),
      async () => {
        const revoked = await pool.query(`UPDATE ${context.table("telemetry_v12_device_capabilities")}
          SET state='revoked', revoked_at=clock_timestamp()
          WHERE participant_id=$1 AND device_id=$2 AND state='accepted'`,
        [principal.participantId, principal.deviceId]);
        assert.equal(revoked.rowCount, 1);
      });
    const sequenceBefore = await maxSequence(context);
    const recover = modules.createPostgresV12OwnerRecovery({
      pool: injected.pool,
      schema: context.options.schema,
      cursorSecret: randomBytes(32).toString("hex"),
    });
    const result = await recover({
      body: { action: "run_maintenance", v12DomainRecovery: { dryRun: false, maxDevices: 1 } },
      identityKey: "synthetic-owner-recovery-operator",
    });
    assert.equal(injected.wasInjected(), true);
    assert.equal(result.outcomes.authority_unavailable, 1);
    assert.equal(result.outcomes.activated, 0);
    assert.equal(await head(context, participant.participantId), null);
    assert.equal((await devicePredecessors(context, principal)).length, 0,
      "fresh authority proof runs before a predecessor is issued");
    assert.equal(await maxSequence(context), sequenceBefore);
  });
});

test("a processing-control change after selection stops preflight with no activation writes", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12owner_processing_race", async (context) => {
    await enableOwnerProcessing(context);
    const participant = await seedParticipant(context, "owner-processing-race");
    const principal = await seedDevice(context, participant, "owner-processing-race");
    await registerEmptyDay(context, principal, DAY_ONE, "synthetic-owner-processing-race");
    const injected = interposeAfterQuery(pool,
      (text) => text.includes("WITH eligible_devices AS"),
      async () => containOwnerProcessing(context));
    const sequenceBefore = await maxSequence(context);
    const recover = modules.createPostgresV12OwnerRecovery({
      pool: injected.pool,
      schema: context.options.schema,
      cursorSecret: randomBytes(32).toString("hex"),
    });
    await assert.rejects(recover({
      body: { action: "run_maintenance", v12DomainRecovery: { dryRun: false, maxDevices: 1 } },
      identityKey: "synthetic-owner-recovery-operator",
    }), { status: 503, code: "PROCESSING_DISABLED" });
    assert.equal(injected.wasInjected(), true);
    assert.equal(await head(context, participant.participantId), null);
    assert.equal((await devicePredecessors(context, principal)).length, 0);
    assert.equal(await maxSequence(context), sequenceBefore);
    const audit = await pool.query(`SELECT outcome, details_json
      FROM ${context.table("admin_action_audit")} WHERE action='run_maintenance'`);
    assert.equal(audit.rows[0]?.outcome, "failure");
    const details = JSON.parse(audit.rows[0].details_json);
    assert.equal(details.failureStage, "preflight");
    assert.equal(details.predecessorIssued, false);
    assert.equal(details.currentAttemptMayHaveCommitted, false);
    assert.equal(details.completed.examined, 0);
  });
});

test("activation rechecks revoked authority after issuance and leaves its predecessor unconsumed", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12owner_authority_activation", async (context) => {
    await enableOwnerProcessing(context);
    const participant = await seedParticipant(context, "owner-authority-activation");
    const principal = await seedDevice(context, participant, "owner-authority-activation");
    await registerEmptyDay(context, principal, DAY_ONE, "synthetic-owner-authority-activation");
    const recover = modules.createPostgresV12OwnerRecovery({
      pool,
      schema: context.options.schema,
      cursorSecret: randomBytes(32).toString("hex"),
      observeActivation: async (invoke) => {
        const revoked = await pool.query(`UPDATE ${context.table("telemetry_v12_device_capabilities")}
          SET state='revoked', revoked_at=clock_timestamp()
          WHERE participant_id=$1 AND device_id=$2 AND state='accepted'`,
        [principal.participantId, principal.deviceId]);
        assert.equal(revoked.rowCount, 1);
        return invoke();
      },
    });
    const result = await recover({
      body: { action: "run_maintenance", v12DomainRecovery: { dryRun: false, maxDevices: 1 } },
      identityKey: "synthetic-owner-recovery-operator",
    });
    assert.equal(result.outcomes.authority_unavailable, 1);
    assert.equal(result.outcomes.activated, 0);
    assert.equal(result.refusals.TELEMETRY_REQUIRED, undefined);
    assert.equal(await head(context, participant.participantId), null);
    const issued = await devicePredecessors(context, principal);
    assert.equal(issued.length, 1);
    assert.equal(issued[0].consumed_at, null,
      "revocation is rechecked before activation and cannot consume the newly issued token");
    const domains = await pool.query(`SELECT count(*)::integer AS count
      FROM ${context.table("telemetry_v12_domains")} WHERE participant_id=$1`, [principal.participantId]);
    assert.equal(domains.rows[0].count, 0);
  });
});

test("a head committed after candidate selection is reported as already active, without a second receipt", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12owner_head_race", async (context) => {
    await enableOwnerProcessing(context);
    const participant = await seedParticipant(context, "owner-head-race");
    const principal = await seedDevice(context, participant, "owner-head-race");
    const day = await registerEmptyDay(context, principal, DAY_ONE, "synthetic-owner-head-race");
    const sequenceBefore = await maxSequence(context);
    const injected = interposeAfterQuery(pool,
      (text) => text.includes("WITH eligible_devices AS"),
      async () => {
        const predecessor = await context.domain.createPredecessor(principal);
        await context.domain.activate(principal, domainManifest(predecessor, [day]));
      });
    const recover = modules.createPostgresV12OwnerRecovery({
      pool: injected.pool,
      schema: context.options.schema,
      cursorSecret: randomBytes(32).toString("hex"),
    });
    const result = await recover({
      body: { action: "run_maintenance", v12DomainRecovery: { dryRun: false, maxDevices: 1 } },
      identityKey: "synthetic-owner-recovery-operator",
    });
    assert.equal(injected.wasInjected(), true);
    assert.equal(result.outcomes.already_active, 1);
    assert.equal(result.outcomes.activated, 0);
    assert.equal(result.daysCovered, 0);
    assert.ok(await head(context, participant.participantId));
    assert.equal((await devicePredecessors(context, principal)).length, 1,
      "the ordinary client's token is the only token; recovery did not issue another");
    assert.equal(await maxSequence(context), sequenceBefore + 1);
  });
});

test("owner pagination cursors are opaque and bound to the actor, schema mode, and authenticated bytes", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12owner_cursor", async (context) => {
    await enableOwnerProcessing(context);
    for (const label of ["cursor-first", "cursor-second"]) {
      const participant = await seedParticipant(context, label);
      const principal = await seedDevice(context, participant, label);
      await registerEmptyDay(context, principal, DAY_ONE, `synthetic-${label}`);
    }
    const cursorSecret = randomBytes(32).toString("hex");
    const recover = modules.createPostgresV12OwnerRecovery({
      pool,
      schema: context.options.schema,
      cursorSecret,
    });
    const body = { action: "run_maintenance", v12DomainRecovery: { dryRun: true, maxDevices: 1 } };
    const identityKey = "synthetic-owner-recovery-operator";
    const firstPage = await recover({ body, identityKey });
    const cursor = firstPage.nextAfterParticipantId;
    assert.equal(firstPage.examined, 1);
    assert.match(cursor, /^v12r1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/u);
    assert.equal(cursor.includes("synthetic-"), false);
    const secondPage = await recover({
      body: { action: "run_maintenance", v12DomainRecovery: { dryRun: true, maxDevices: 1,
        afterParticipantId: cursor } },
      identityKey,
    });
    assert.equal(secondPage.examined, 1);
    assert.equal(secondPage.nextAfterParticipantId, null);
    const changedMode = { action: "run_maintenance", v12DomainRecovery: { dryRun: false, maxDevices: 1,
      afterParticipantId: cursor } };
    await assert.rejects(recover({ body: changedMode, identityKey }),
      { status: 400, code: "BODY_INVALID" });
    await assert.rejects(recover({ body: {
      action: "run_maintenance", v12DomainRecovery: { dryRun: true, maxDevices: 1,
        afterParticipantId: cursor },
    }, identityKey: `${identityKey}-different` }), { status: 400, code: "BODY_INVALID" });
    const otherSchemaHandler = modules.createPostgresV12OwnerRecovery({
      pool,
      schema: { primarySchema: "synthetic_other_owner_schema" },
      cursorSecret,
    });
    await assert.rejects(otherSchemaHandler({ body: {
      action: "run_maintenance", v12DomainRecovery: { dryRun: true, maxDevices: 1,
        afterParticipantId: cursor },
    }, identityKey }), { status: 400, code: "BODY_INVALID" });
    const last = cursor.at(-1);
    const tampered = `${cursor.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    await assert.rejects(recover({ body: {
      action: "run_maintenance", v12DomainRecovery: { dryRun: true, maxDevices: 1,
        afterParticipantId: tampered },
    }, identityKey }), { status: 400, code: "BODY_INVALID" });
  });
});

test("a later candidate failure audits only completed outcomes and marks the current activation uncertain", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12owner_partial", async (context) => {
    await enableOwnerProcessing(context);
    const principals = [];
    for (const label of ["first", "second"]) {
      const participant = await seedParticipant(context, `owner-partial-${label}`);
      const principal = await seedDevice(context, participant, `owner-partial-${label}`);
      await registerEmptyDay(context, principal, DAY_ONE, `synthetic-owner-partial-${label}`);
      principals.push({ ...principal, participantId: participant.participantId });
    }
    const sequenceBefore = await maxSequence(context);
    let activationCalls = 0;
    const recover = modules.createPostgresV12OwnerRecovery({
      pool,
      schema: context.options.schema,
      cursorSecret: randomBytes(32).toString("hex"),
      observeActivation: async (invoke) => {
        activationCalls += 1;
        if (activationCalls === 2) {
          await invoke();
          throw new modules.ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
        }
        return invoke();
      },
    });
    await assert.rejects(recover({
      body: { action: "run_maintenance", v12DomainRecovery: { dryRun: false, maxDevices: 2 } },
      identityKey: "synthetic-owner-recovery-operator",
    }), { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    assert.equal(activationCalls, 2);
    const heads = await pool.query(`SELECT participant_id
      FROM ${context.table("telemetry_v12_domain_heads")}`);
    assert.equal(heads.rows.length, 2, "the first and ambiguous second activation are both durable");
    assert.ok(heads.rows.every((row) => principals.some((candidate) => candidate.participantId === row.participant_id)));
    assert.equal(await maxSequence(context), sequenceBefore + 2,
      "the second activation's journal event committed before its synthetic acknowledgment was lost");
    const audit = await pool.query(`SELECT outcome, details_json
      FROM ${context.table("admin_action_audit")} WHERE action='run_maintenance'`);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].outcome, "failure");
    const details = JSON.parse(audit.rows[0].details_json);
    assert.equal(details.failureStage, "activation");
    assert.equal(details.predecessorIssued, true);
    assert.equal(details.currentAttemptMayHaveCommitted, true);
    assert.deepEqual(details.completed, {
      examined: 1,
      outcomes: { activated: 1, eligible: 0, already_active: 0, authority_unavailable: 0, refused: 0 },
      refusals: {},
      daysCovered: 1,
    });
    assert.equal("participantId" in details, false);
    assert.equal("deviceId" in details, false);
    assert.equal("cursor" in details, false);
    assert.equal("token" in details, false);
    assert.deepEqual(Object.keys(details).sort(), [
      "completed", "currentAttemptMayHaveCommitted", "dryRun", "failureStage",
      "maxDevices", "method", "predecessorIssued", "task",
    ]);
  });
});

test("a terminal success-audit failure preserves completed activation and records no candidate uncertainty", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12owner_audit_fail", async (context) => {
    await enableOwnerProcessing(context);
    const participant = await seedParticipant(context, "owner-audit-failure");
    const principal = await seedDevice(context, participant, "owner-audit-failure");
    await registerEmptyDay(context, principal, DAY_ONE, "synthetic-owner-audit-failure");
    const sequenceBefore = await maxSequence(context);
    const injected = failOneSuccessAuditUpdate(pool, context.schema);
    const recover = modules.createPostgresV12OwnerRecovery({
      pool: injected.pool,
      schema: context.options.schema,
      cursorSecret: randomBytes(32).toString("hex"),
    });
    await assert.rejects(recover({
      body: { action: "run_maintenance", v12DomainRecovery: { dryRun: false, maxDevices: 1 } },
      identityKey: "synthetic-owner-recovery-operator",
    }), { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    assert.equal(injected.wasInjected(), true);
    assert.ok(await head(context, participant.participantId), "the activation committed before terminal audit failed");
    assert.equal(await maxSequence(context), sequenceBefore + 1);
    const audit = await pool.query(`SELECT outcome, details_json
      FROM ${context.table("admin_action_audit")} WHERE action='run_maintenance'`);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].outcome, "failure");
    const details = JSON.parse(audit.rows[0].details_json);
    assert.equal(details.failureStage, "terminal_audit");
    assert.equal(details.predecessorIssued, false);
    assert.equal(details.currentAttemptMayHaveCommitted, false,
      "the already confirmed activation is not relabeled as an uncertain candidate write");
    assert.equal(details.completed.examined, 1);
    assert.equal(details.completed.outcomes.activated, 1);
    assert.equal(details.completed.daysCovered, 1);
  });
});

test("owner recovery ranks recent devices and excludes manifests made READY after the page cutoff", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12owner_rank", async (context) => {
    await enableOwnerProcessing(context);
    const participant = await seedParticipant(context, "owner-device-rank");
    const lexicalFirst = await seedDevice(context, participant, "rank-a-old");
    const recent = await seedDevice(context, participant, "rank-z-current");
    assert.ok(lexicalFirst.deviceId < recent.deviceId,
      "the stale device is also the old lexical-first ranking choice");
    const nowEpoch = Date.now() + 10_000;
    const at = (offset) => nowEpoch + offset;
    await admitQuotaDay(context, lexicalFirst, DAY_ONE, {
      registrationEpoch: at(-90 * 60_000), readyEpoch: at(-60 * 60_000),
    });
    await admitQuotaDay(context, recent, DAY_ONE, {
      registrationEpoch: at(-5 * HOUR_MS), readyEpoch: at(-4 * HOUR_MS),
    });
    await admitQuotaDay(context, recent, DAY_TWO, {
      registrationEpoch: at(-4 * HOUR_MS), readyEpoch: at(-3 * HOUR_MS),
    });
    await admitQuotaDay(context, recent, DAY_THREE, {
      registrationEpoch: at(-2 * HOUR_MS), readyEpoch: at(-30 * 60_000),
    });
    const lateReady = await admitQuotaDay(context, lexicalFirst, DAY_TWO, {
      registrationEpoch: nowEpoch - 20 * 60_000,
      readyEpoch: nowEpoch + 1_000,
    });
    const stagedReadyTiming = await pool.query(`SELECT created_at, ready_at
      FROM ${context.table("telemetry_v12_day_manifests")} WHERE id=$1`, [lateReady.manifestId]);
    assert.ok(new Date(stagedReadyTiming.rows[0].created_at).getTime() <= nowEpoch);
    assert.ok(new Date(stagedReadyTiming.rows[0].ready_at).getTime() > nowEpoch,
      "the manifest was created before the cutoff but only became READY after it");
    const rankedEvidence = await pool.query(`SELECT device_id, max(created_at) AS latest_created,
      max(ready_at) AS latest_ready FROM ${context.table("telemetry_v12_day_manifests")}
      WHERE participant_id=$1 AND state='ready' AND created_at <= $2::timestamptz
        AND ready_at <= $2::timestamptz GROUP BY device_id`,
    [participant.participantId, new Date(nowEpoch).toISOString()]);
    const oldEvidence = rankedEvidence.rows.find((row) => row.device_id === lexicalFirst.deviceId);
    const recentEvidence = rankedEvidence.rows.find((row) => row.device_id === recent.deviceId);
    assert.ok(new Date(oldEvidence.latest_created).getTime() > new Date(recentEvidence.latest_created).getTime(),
      "the stale device has the newer manifest creation timestamp");
    assert.ok(new Date(oldEvidence.latest_ready).getTime() < new Date(recentEvidence.latest_ready).getTime(),
      "the active device has the newer READY transition timestamp");

    const recover = modules.createPostgresV12OwnerRecovery({
      pool,
      schema: context.options.schema,
      cursorSecret: randomBytes(32).toString("hex"),
      clock: () => nowEpoch,
    });
    const result = await recover({
      body: { action: "run_maintenance", v12DomainRecovery: { dryRun: true, maxDevices: 1 } },
      identityKey: "synthetic-owner-recovery-operator",
    });
    assert.deepEqual(result.outcomes, {
      activated: 0, eligible: 1, already_active: 0, authority_unavailable: 0, refused: 0,
    });
    assert.equal(result.daysCovered, 3,
      "rank by READY transition, not manifest creation; also exclude a post-cutoff READY transition");
    assert.equal(result.nextAfterParticipantId, null);
  });
});

test("an unrecognized owner-recovery ApiError fails the page closed instead of becoming a manifest refusal", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withSchema("v12owner_unknown", async (context) => {
    await enableOwnerProcessing(context);
    const participant = await seedParticipant(context, "owner-unknown-error");
    const principal = await seedDevice(context, participant, "owner-unknown-error");
    await registerEmptyDay(context, principal, DAY_ONE, "synthetic-owner-unknown-error");
    const nowEpoch = Date.now();
    const recover = modules.createPostgresV12OwnerRecovery({
      pool,
      schema: context.options.schema,
      cursorSecret: randomBytes(32).toString("hex"),
      clock: () => nowEpoch,
      observeActivation: async () => {
        throw new modules.ApiError(409, "TELEMETRY_UNRECOGNIZED_SYNTHETIC_CODE");
      },
    });
    await assert.rejects(recover({
      body: { action: "run_maintenance", v12DomainRecovery: { dryRun: false, maxDevices: 1 } },
      identityKey: "synthetic-owner-recovery-operator",
    }), { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    assert.equal(await head(context, participant.participantId), null,
      "an unknown code cannot be reported as a manifest refusal or write an active head");
  });
});
