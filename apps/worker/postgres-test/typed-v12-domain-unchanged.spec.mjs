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

/** A zero-chunk day registered through the real admission path, which makes
 * it ready at registration (the empty-day contract from fe58fd7a). */
async function registerEmptyDay(context, principal, day, parserVersion = "synthetic-empty-day") {
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
    pool, principal, manifest, Date.now(), context.options,
  );
  assert.deepEqual({ state: candidate.state, expectedChunks: candidate.expectedChunks },
    { state: "ready", expectedChunks: 0 });
  return { day, manifestId: candidate.manifestId, manifestDigest: candidate.manifestDigest };
}

/** One synthetic quota observation admitted through register, stage and ready. */
async function admitQuotaDay(context, principal, day) {
  const { table } = context;
  const nowEpoch = Date.now();
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
  const now = new Date(nowEpoch).toISOString();
  const expires = new Date(nowEpoch + 10 * 60_000).toISOString();
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
  }, nowEpoch, context.options);
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
    const quiet = await snapshot(context);
    const borrowed = await context.domain.createPredecessor(deviceB);
    assert.equal(borrowed.previousGenerationId, a2.generationId);
    await assert.rejects(context.domain.activate(deviceB, domainManifest(borrowed, vectorA)),
      { status: 409, code: "TELEMETRY_MANIFEST_CONFLICT" });
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
