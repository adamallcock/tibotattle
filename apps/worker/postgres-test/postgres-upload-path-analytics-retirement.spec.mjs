import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { telemetryV12DomainManifestDigestInput } from "@app-usagemonitor/telemetry-contract";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
  renderPostgresSearchPath,
} from "../scripts/postgres-migrations.mjs";

/*
 * PostgreSQL 17 qualification for the upload-path analytics retirement
 * (ISO-1, the PostgreSQL mirror of D1 ingestion-isolation 0001).
 *
 * Seeds run on the chain before the retirement, as pre-existing state. The
 * write and lifecycle scenarios also run on that chain alone (the control,
 * which proves the fixtures really drive every retired 0010 side effect the
 * retired run asserts absent: the flag flip, each queue, the composition-day,
 * dependency and preview-cache invalidations). Until the
 * staged-migration harness lands, the retirement SQL is applied after the
 * stock primary chain in one transaction under the runner's search path; once
 * the integrator promotes it under its assigned number the runner applies it
 * ("head"). Twin comparisons apply the retirement SQL alone on the
 * pre-retirement chain ("isolated"), so they differ by exactly this migration.
 * Every row is synthetic and content-free.
 */

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SKIP = !PG_TEST_HOST && !PG_TEST_SOCKET;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_SUFFIX = "_upload_path_analytics_retirement.sql";
const STAGED_DIRECTORY = join(WORKER_ROOT, "postgres", "staged-migrations", "primary");
const PROMOTED_DIRECTORY = join(WORKER_ROOT, "postgres", "migrations", "primary");
const DAY = "2026-09-24";
const V1_CONSENT = Object.freeze({
  telemetrySchemaVersion: "telemetry-contribution-v1.0",
  fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
  privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
});
const REFUSED_TABLES = Object.freeze(["current_queue", "refresh_lanes", "daily_rebuilds", "prepared_source_days"]);
const RETIRED_TRIGGERS = Object.freeze([
  ["input_versions", "analysis_queued_insert"],
  ["input_versions", "analysis_queued_update"],
  ["participants", "participant_queue_removed"],
  ["telemetry_v1_chunks", "zz_daily_rebuild_queued"],
  ["telemetry_v1_chunks", "community_model_history_v1_insert"],
  ["telemetry_v1_chunks", "community_model_history_v1_update"],
  ["telemetry_v1_chunks", "community_model_history_v1_delete"],
  ["telemetry_v1_records", "prepared_source_discard"],
  ["prepared_source_days", "preparation_progress_changed"],
]);
const RETIRED_FUNCTIONS = Object.freeze([
  "analysis_queued", "participant_queue_removed", "daily_rebuild_queued",
  "invalidate_model_history_v1_insert", "invalidate_model_history_v1_update",
  "invalidate_model_history_v1_delete", "prepared_source_discard", "preparation_progress_changed",
]);
/** Everything the retirement adds to the catalog, and the only functions it replaces. */
const ADDED_TRIGGERS = Object.freeze([
  ...REFUSED_TABLES.map((table) => [table, "retired_analytics_refusal"]),
  ["publication_state", "publication_policy_row_guard"],
  ["publication_state", "publication_policy_row_no_truncate"],
]);
const ADDED_FUNCTIONS = Object.freeze(["refuse_retired_analytics_write", "publication_policy_row_guard"]);
const REPLACED_FUNCTIONS = Object.freeze(["publication_mutated", "participant_input_state", "participant_projection_delete"]);
const KEPT_TRIGGERS = Object.freeze([
  ["mutation_control", "publication_mutated"],
  ["telemetry_v1_chunks", "aa_analytical_insert"],
  ["telemetry_v1_chunks", "aa_analytical_update"],
  ["telemetry_v1_chunks", "aa_analytical_delete"],
  ["telemetry_v1_chunks", "telemetry_v1_source_digest"],
  ["telemetry_v1_chunks", "telemetry_v1_transport_floor_guard"],
  ["telemetry_v1_chunks", "telemetry_v1_chunks_reconciliation_guard"],
  ["telemetry_v1_records", "telemetry_v1_quota_fit_rows_insert"],
  ["telemetry_v1_records", "telemetry_v1_quota_fit_rows_update"],
  ["telemetry_v1_records", "telemetry_v1_quota_fit_rows_delete"],
  ["participants", "participant_input_created"],
  ["participants", "participant_withdrawal"],
  ["participants", "participant_input_state"],
  ["participants", "participant_projection_delete"],
  ["telemetry_contributions", "telemetry_retained_source_revision"],
  ["telemetry_records", "telemetry_retained_record_source_revision"],
  ["telemetry_v11_domain_heads", "telemetry_v11_domain_head_source_revision"],
  ["telemetry_v12_domain_heads", "telemetry_v12_domain_head_source_revision"],
]);

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

let located;
/** The retirement migration, staged or promoted: exactly one copy. */
async function locateMigration() {
  if (located === undefined) {
    const found = [];
    for (const [directory, staged] of [[STAGED_DIRECTORY, true], [PROMOTED_DIRECTORY, false]]) {
      let names = [];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      for (const name of names.filter((entry) => entry.endsWith(MIGRATION_SUFFIX))) {
        assert.match(name, /^\d{4}_[a-z0-9_]+\.sql$/u);
        found.push({ name, staged, version: Number(name.slice(0, 4)), sql: await readFile(join(directory, name), "utf8") });
      }
    }
    assert.equal(found.length, 1, "the retirement migration is either staged or promoted, never both or neither");
    located = found[0];
  }
  return located;
}

async function endpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "upload-path retirement tests require loopback or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  if (PG_TEST_SOCKET) {
    assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
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
  return { host: PG_TEST_HOST, port: PG_TEST_PORT };
}

/** A migration root holding exactly the stock primary chain before the retirement. */
async function preRetirementRoot(migration) {
  const stock = await readPostgresMigrations({ role: "primary" });
  assert.equal(stock.some((entry) => entry.name === migration.name), !migration.staged,
    "the runner applies the retirement migration exactly when it is promoted");
  const before = stock.filter((entry) => migration.staged || entry.version < migration.version);
  assert.ok(before.length > 0 && before.every((entry, index) => entry.version === index + 1));
  const root = await mkdtemp(join(tmpdir(), `iso1-pre-retirement-${randomBytes(4).toString("hex")}-`));
  await mkdir(join(root, "primary"), { mode: 0o700 });
  for (const entry of before) {
    await writeFile(join(root, "primary", entry.name), entry.sql, { flag: "wx", mode: 0o600 });
  }
  return root;
}

/**
 * "head": the current chain (stock plus the staged retirement, or the runner's
 * full chain once promoted). "isolated": the retirement SQL alone on top of
 * the pre-retirement chain, so a twin comparison differs by exactly this
 * migration even after later waves land.
 */
async function applyRetirement(pool, schema, migration, mode) {
  assert.ok(mode === "head" || mode === "isolated");
  if (!migration.staged && mode === "head") {
    await applyPostgresMigrations({ role: "primary", schema, pool });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='60000ms'");
    await client.query("SET LOCAL lock_timeout='10000ms'");
    await client.query(renderPostgresSearchPath(schema));
    await client.query(migration.sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * One disposable PG17 schema at the chain before the retirement. `seed` runs
 * there, as pre-existing state; `retire` ("head" or "isolated", or false for
 * the control) then applies the retirement. The schema, pool and migration
 * root are always discarded.
 */
async function withSchema({ retire, seed = async () => {}, domain = false }, run) {
  assert.ok(retire === false || retire === "head" || retire === "isolated");
  const local = await endpoint();
  const migration = await locateMigration();
  const schema = `iso1_upload_${randomBytes(6).toString("hex")}`;
  // Older trigger functions (0011) resolve relations through the session
  // search path, as the runtime's does; timestamps render in UTC.
  const pool = new pg.Pool({
    ...local, user: PG_TEST_USER, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE,
    ssl: false, max: 4, connectionTimeoutMillis: 5_000, application_name: "pg-iso1-upload-path-retirement",
    options: `-c search_path=${schema},pg_catalog -c TimeZone=UTC`,
  });
  const t = (name) => {
    assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
    return `"${schema}"."${name}"`;
  };
  let created = false;
  let root;
  let vite;
  try {
    const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the retirement is qualified on PostgreSQL 17");
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    root = await preRetirementRoot(migration);
    await applyPostgresMigrations({ role: "primary", schema, pool, rootDirectory: root });
    await seed({ pool, schema, t });
    if (retire) await applyRetirement(pool, schema, migration, retire);
    let modules = {};
    if (domain) {
      vite = await createServer({ root: WORKER_ROOT, configFile: false, server: { middlewareMode: true }, appType: "custom" });
      modules = await vite.ssrLoadModule("/src/postgres-typed-v12-domain.ts");
    }
    return await run({ pool, schema, t, modules });
  } finally {
    if (vite) await vite.close();
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    if (root) await rm(root, { recursive: true, force: true });
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Fixtures

/** A social participant with one paired device (and optionally a second). */
async function createSocialOwner(pool, t, participantId, devices = 1) {
  const now = iso(-60_000);
  const expires = iso(30 * 86_400_000);
  const sessionId = `${participantId}-session`;
  await pool.query(`INSERT INTO ${t("participants")} (id,created_at) VALUES ($1,$2)`, [participantId, now]);
  await pool.query(`INSERT INTO ${t("web_sessions")} (id,participant_id,secret_hash,csrf_hash,issued_at,expires_at,last_used_at)
    VALUES ($1,$2,$3,$3,$4,$5,$4)`, [sessionId, participantId, randomBytes(32), now, expires]);
  const deviceIds = [];
  for (let index = 0; index < devices; index += 1) {
    const pairingId = `${participantId}-pairing-${index}`;
    const deviceId = `${participantId}-device-${index}`;
    await pool.query(`INSERT INTO ${t("device_pairings")} (
        id,participant_id,issued_by_session_id,secret_hash,consent_version,transport_consent_version,state,
        issued_at,expires_at,consumed_at,claimed_device_id
      ) VALUES ($1,$2,$3,$4,'synthetic-consent','synthetic-transport','consumed',$5,$6,$5,$7)`,
    [pairingId, participantId, sessionId, randomBytes(32), now, expires, deviceId]);
    await pool.query(`INSERT INTO ${t("device_credentials")} (
        id,participant_id,paired_via_pairing_id,secret_hash,issued_at,expires_at,last_used_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [deviceId, participantId, pairingId, randomBytes(32), now, expires]);
    deviceIds.push(deviceId);
  }
  return deviceIds;
}

/** One social v1.0 upload through the PostgreSQL v1 writer: a quota chunk whose record is quota-fit eligible. */
async function socialV1Upload(pool, schema, t, participantId, deviceId) {
  const chunkId = `${participantId}-chunk-${randomUUID()}`;
  const authorizationId = `${participantId}-authorization-${randomUUID()}`;
  const envelopeDigest = digest(`envelope-${chunkId}`);
  const lease = iso(10 * 60_000);
  await pool.query(`INSERT INTO ${t("telemetry_v1_device_consents")} (
      participant_id,device_id,telemetry_schema_version,field_dictionary_version,privacy_contract_version,consented_at
    ) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
  [participantId, deviceId, V1_CONSENT.telemetrySchemaVersion, V1_CONSENT.fieldDictionaryVersion,
    V1_CONSENT.privacyContractVersion, iso(-30_000)]);
  await pool.query(`INSERT INTO ${t("device_upload_authorizations")} (
      id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,content_type,state,
      issued_at,expires_at,consume_lease_expires_at
    ) VALUES ($1,$2,$3,$4,$5,256,'application/json','consuming',$6,$7,$8)`,
  [authorizationId, participantId, deviceId, randomBytes(32), envelopeDigest, iso(-30_000), iso(86_400_000), lease]);
  const input = {
    participantId,
    deviceId,
    chunkId,
    uploadAuthorizationId: authorizationId,
    uploadAuthorizationLeaseExpiresAt: lease,
    envelopeDigest,
    objectKey: `synthetic/iso1/${chunkId}`,
    createdAt: iso(),
    chunk: {
      stream: "quota",
      chunkDay: DAY,
      chunkSeq: 0,
      chunkRevision: 1,
      chunkDigest: digest(`chunk-${chunkId}`),
      parserVersion: "synthetic-iso1",
      consent: V1_CONSENT,
      records: [{
        observationId: `synthetic-observation-${chunkId}`,
        observedTime: `${DAY}T12:00:00.000Z`,
        provider: "openai_codex",
        planType: "pro",
        planVariant: "unknown",
        limitId: "codex",
        slot: "primary",
        usedPercent: 12.5,
        windowDurationMinutes: 10080,
        resetsAt: "2026-09-30T00:00:00.000Z",
      }],
    },
  };
  const result = await pool.query(`SELECT accepted_records FROM "${schema}".insert_telemetry_v1_contribution($1::jsonb)`,
    [JSON.stringify(input)]);
  assert.deepEqual(result.rows, [{ accepted_records: 1 }]);
  return chunkId;
}

async function v11Generation(pool, t, { participantId, deviceId, generationId, previous = null }) {
  const now = iso(-10_000);
  const token = digest(`token-${generationId}`);
  await pool.query(`INSERT INTO ${t("telemetry_v11_domain_predecessors")} (
      token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,from_day,through_day,
      winners_json,created_at,expires_at
    ) VALUES ($1,$2,$3,$4,$5,0,$6,$6,'[]',$7,$8)`,
  [token, participantId, deviceId, previous, digest(`legacy-${generationId}`), DAY, now, iso(86_400_000)]);
  await pool.query(`INSERT INTO ${t("telemetry_v11_domains")} (
      id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,legacy_fingerprint,
      input_revision,from_day,through_day,days_json,created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$8,'[]',$9)`,
  [generationId, participantId, deviceId, token, previous, digest(`manifest-${generationId}`),
    digest(`legacy-${generationId}`), DAY, now]);
}

/** One v1.1 domain head change: a first head, then its successor. */
async function v11HeadChange(pool, t, participantId, deviceId) {
  const first = randomUUID();
  const second = randomUUID();
  await v11Generation(pool, t, { participantId, deviceId, generationId: first });
  await pool.query(`INSERT INTO ${t("telemetry_v11_domain_heads")} (participant_id,generation_id,revision,updated_at)
    VALUES ($1,$2,1,$3)`, [participantId, first, iso()]);
  await v11Generation(pool, t, { participantId, deviceId, generationId: second, previous: first });
  await pool.query(`UPDATE ${t("telemetry_v11_domain_heads")} SET generation_id=$2,revision=2,updated_at=$3
    WHERE participant_id=$1`, [participantId, second, iso()]);
}

/** A v1.2 participant identity (v12-domain-roundtrip.spec.mjs's shape). */
async function createV12Owner(pool, t, participantId, deviceId) {
  const now = iso(-60_000);
  const expires = iso(86_400_000);
  const secretHash = randomBytes(32);
  await pool.query(`INSERT INTO ${t("participants")} (id,consent_version,created_at) VALUES ($1,$2,$3)`,
    [participantId, "privacy-safe-telemetry-v0.1", now]);
  await pool.query(`INSERT INTO ${t("web_sessions")} (id,participant_id,secret_hash,csrf_hash,issued_at,expires_at,last_used_at)
    VALUES ($1,$2,$3,$3,$4,$5,$4)`, [`${participantId}-session`, participantId, secretHash, now, expires]);
  await pool.query(`INSERT INTO ${t("device_pairings")} (
      id,participant_id,issued_by_session_id,secret_hash,consent_version,transport_consent_version,issued_at,expires_at
    ) VALUES ($1,$2,$3,$4,'synthetic-consent','synthetic-transport',$5,$6)`,
  [`${participantId}-pairing`, participantId, `${participantId}-session`, secretHash, now, expires]);
  await pool.query(`INSERT INTO ${t("device_credentials")} (
      id,participant_id,paired_via_pairing_id,secret_hash,issued_at,expires_at,last_used_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [deviceId, participantId, `${participantId}-pairing`, secretHash, now, expires]);
  await pool.query(`INSERT INTO ${t("telemetry_v12_device_capabilities")} (
      participant_id,device_id,telemetry_schema_version,field_dictionary_version,privacy_contract_version,consented_at
    ) VALUES ($1,$2,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
      'ongoing-privacy-safe-telemetry-v1.2',$3)`, [participantId, deviceId, now]);
}

/** One v1.2 activation through the PostgreSQL typed v1.2 domain over one ready, empty day. */
async function v12Activation(pool, schema, t, modules, participantId, deviceId) {
  const now = iso(-5_000);
  await pool.query(`UPDATE ${t("telemetry_v12_runtime")} SET state='active',changed_at=$1 WHERE id=1`, [now]);
  await pool.query(`UPDATE ${t("telemetry_v12_typed_runtime")} SET state='active',changed_at=$1 WHERE id=1`, [now]);
  const manifestId = randomUUID();
  const manifestDigest = digest(`v12-manifest-${manifestId}`);
  await pool.query(`INSERT INTO ${t("telemetry_v12_day_manifests")} (
      id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,expected_chunk_count,state,
      created_at,ready_at
    ) VALUES ($1,$2,$3,$4::date,$5,'synthetic-iso1',$6,0,'ready',$7,$7)`,
  [manifestId, participantId, deviceId, DAY, manifestDigest,
    JSON.stringify({ schemaVersion: "telemetry-day-manifest-v1.2", day: DAY, chunks: [] }), now]);
  const domain = modules.createPostgresTypedV12Domain(pool, {
    schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
  });
  const principal = { participantId, deviceId };
  const predecessor = await domain.createPredecessor(principal);
  const manifest = {
    schemaVersion: "telemetry-domain-manifest-v1.2",
    fromDay: DAY,
    throughDay: DAY,
    predecessor: {
      token: predecessor.token,
      previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint,
    },
    days: [{ day: DAY, manifestId, manifestDigest }],
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = createHash("sha256").update(telemetryV12DomainManifestDigestInput(manifest)).digest("hex");
  const activation = await domain.activate(principal, manifest);
  assert.equal(activation.replay, false);
  const head = await pool.query(`SELECT generation_id FROM ${t("telemetry_v12_domain_heads")} WHERE participant_id=$1`,
    [participantId]);
  assert.deepEqual(head.rows, [{ generation_id: activation.generationId }]);
}

/** One retained v0.2 contribution and its record. */
async function v02Contribution(pool, t, participantId) {
  const contributionId = `${participantId}-contribution-${randomUUID()}`;
  const now = iso(-1_000);
  await pool.query(`INSERT INTO ${t("telemetry_contributions")} (
      id,participant_id,plaintext_digest,envelope_digest,r2_key,schema_version,transport_schema_version,
      dataset_id,dataset_part_index,dataset_part_count,dataset_completeness,dataset_range_start,dataset_range_end,
      range_start,range_end,client_platform,provider_policy_epoch,priced_event_coverage_percent,unknown_model_event_count,
      unknown_billable_units,price_basis,declared_record_count,accepted_record_count,created_at
    ) VALUES ($1,$2,$3,$4,$5,'telemetry-contribution-v0.1','telemetry-contribution-v0.2',
      'synthetic-dataset',1,1,'complete',$6,$6,$6,$6,'synthetic','synthetic',100,0,0,'synthetic',1,1,$6)`,
  [contributionId, participantId, digest(`plain-${contributionId}`), digest(`envelope-${contributionId}`),
    `synthetic/iso1/${contributionId}`, now]);
  await pool.query(`INSERT INTO ${t("telemetry_records")} (
      origin_contribution_id,participant_id,record_kind,occurrence_id,observed_at,dataset_id,record_json
    ) VALUES ($1,$2,'usage',$3,$4,'synthetic-dataset','{}'::jsonb)`,
  [contributionId, participantId, `synthetic-occurrence-${contributionId}`, now]);
}

// ---------------------------------------------------------------------------
// Observations

async function rows(pool, sql, values = []) {
  return (await pool.query(sql, values)).rows;
}

/** Every retired publication, queue, cache and preparation row, in full. */
async function retiredState(pool, t) {
  return {
    publicationState: await rows(pool, `SELECT singleton,publication_state,changed_at::text AS changed_at,
      policy_revision::text AS policy_revision FROM ${t("publication_state")} ORDER BY singleton`),
    previewCache: await rows(pool, `SELECT id,payload::text AS payload FROM ${t("preview_cache")} ORDER BY id`),
    currentQueue: await rows(pool, `SELECT participant_id,dirty_generation::text AS dirty_generation,
      window_generation::text AS window_generation,pending,last_served_sequence::text AS last_served_sequence
      FROM ${t("current_queue")} ORDER BY participant_id`),
    currentQueueState: await rows(pool, `SELECT singleton_id,window_generation::text AS window_generation
      FROM ${t("current_queue_state")}`),
    refreshLanes: await rows(pool, `SELECT lane,state,completed_at::text AS completed_at,restart_reason
      FROM ${t("refresh_lanes")} ORDER BY lane`),
    dailyRebuilds: await rows(pool, `SELECT day::text AS day,requested_epoch::text AS requested_epoch,
      requested_at::text AS requested_at FROM ${t("daily_rebuilds")} ORDER BY day`),
    preparedSourceDays: await rows(pool, `SELECT participant_id,source_day::text AS source_day,phase,
      progress_revision::text AS progress_revision FROM ${t("prepared_source_days")} ORDER BY participant_id,source_day`),
    preparationCounters: await rows(pool, `SELECT to_jsonb(counter)::text AS counter
      FROM ${t("preparation_counters")} counter`),
    compositionDays: await rows(pool, `SELECT day::text AS day,payload_json,computed_at::text AS computed_at,
      history_method_version FROM ${t("community_model_composition_days")} ORDER BY day`),
    historyDependencies: await rows(pool, `SELECT participant_id,day::text AS day,
      dependency_revision::int AS dependency_revision,input_fingerprint,
      verified_input_revision::text AS verified_input_revision
      FROM ${t("community_model_history_dependencies")} ORDER BY participant_id,day`),
  };
}

async function mutationControl(pool, t) {
  const [row] = await rows(pool, `SELECT mutation_epoch::int AS mutation_epoch,graph_append_epoch::int AS graph_append_epoch,
      graph_invalidation_epoch::int AS graph_invalidation_epoch,graph_append_reason,graph_last_change_reason,
      graph_last_change_at IS NOT NULL AS changed
    FROM ${t("mutation_control")} WHERE singleton_id=1`);
  return row;
}

async function inputRevision(pool, t, participantId) {
  const found = await rows(pool, `SELECT revision::int AS revision FROM ${t("input_versions")} WHERE participant_id=$1`,
    [participantId]);
  return found[0]?.revision ?? null;
}

async function sourceDigest(pool, t, participantId) {
  const found = await rows(pool, `SELECT digest FROM ${t("input_source_digests")} WHERE participant_id=$1`, [participantId]);
  return found[0]?.digest ?? null;
}

async function queueRow(pool, t, participantId) {
  const found = await rows(pool, `SELECT dirty_generation::int AS dirty_generation,pending
    FROM ${t("current_queue")} WHERE participant_id=$1`, [participantId]);
  return found[0] ?? null;
}

// ---------------------------------------------------------------------------
// Scenario 1: the four upload-path writes named by the acceptance test, with
// the social v1 upload taken both ways 0010 distinguishes: an accepted append
// (which 0010 treated as preserving) and a second device's upload to a day
// the owner already has accepted records for (which 0010 did not).

const OWNERS = Object.freeze({
  v1: "synthetic-iso1-v1-owner",
  v11: "synthetic-iso1-v11-owner",
  v12: "synthetic-iso1-v12-owner",
  v02: "synthetic-iso1-v02-owner",
});
const V12_DEVICE = "synthetic-iso1-v12-owner-device";
/** Method-bound composition days before, inside and next to the v1 upload's 100-day window. */
const COMPOSITION_DAYS = Object.freeze([
  ["2026-09-23", "synthetic-method"],
  ["2026-09-24", "synthetic-method"],
  ["2026-09-25", null],
]);

/**
 * Pre-existing state, created before the retirement migration: the four
 * owners (the v1 owner with two devices), one idle queue row each, both
 * refresh lanes complete, an unrelated daily rebuild request, one preview
 * cache row, composition days around the upload day and a verified history
 * dependency of the v1 owner on the upload day.
 */
async function seedUploadOwners({ pool, t }) {
  await createSocialOwner(pool, t, OWNERS.v1, 2);
  await createSocialOwner(pool, t, OWNERS.v11);
  await createSocialOwner(pool, t, OWNERS.v02);
  await createV12Owner(pool, t, OWNERS.v12, V12_DEVICE);
  for (const participantId of Object.values(OWNERS)) {
    await pool.query(`INSERT INTO ${t("current_queue")} (participant_id,dirty_generation,window_generation,pending,
      last_served_sequence) VALUES ($1,1,1,false,0)`, [participantId]);
  }
  await pool.query(`INSERT INTO ${t("refresh_lanes")} (lane,state,completed_at,restart_reason)
    VALUES ('current','complete','2026-09-20T00:00:00Z',NULL),('daily','complete','2026-09-20T00:00:00Z',NULL)`);
  await pool.query(`INSERT INTO ${t("daily_rebuilds")} (day,requested_epoch,requested_at)
    VALUES ('2026-09-01',0,'2026-09-20T00:00:00Z')`);
  await pool.query(`INSERT INTO ${t("preview_cache")} (id,payload) VALUES ('synthetic-iso1-preview','{"synthetic":true}'::jsonb)`);
  for (const [day, method] of COMPOSITION_DAYS) {
    await pool.query(`INSERT INTO ${t("community_model_composition_days")} (day,payload_json,computed_at,history_method_version)
      VALUES ($1::date,'{}','2026-09-20T00:00:00Z',$2)`, [day, method]);
  }
  await pool.query(`INSERT INTO ${t("community_model_history_dependencies")} (
      participant_id,day,from_day,dependency_revision,input_fingerprint,verified_input_revision
    ) VALUES ($1,$2::date,$2::date - 100,0,$3,0)`, [OWNERS.v1, DAY, digest("synthetic-iso1-dependency")]);
}

const V1_DEVICE = `${OWNERS.v1}-device-0`;
const V1_SECOND_DEVICE = `${OWNERS.v1}-device-1`;
const V11_DEVICE = `${OWNERS.v11}-device-0`;

/** Run the writes in order, returning each write's state before and after. */
async function runUploadFlows({ pool, schema, t, modules }) {
  const flows = [
    ["social v1 upload", OWNERS.v1, () => socialV1Upload(pool, schema, t, OWNERS.v1, V1_DEVICE)],
    ["second-device social v1 upload", OWNERS.v1, () => socialV1Upload(pool, schema, t, OWNERS.v1, V1_SECOND_DEVICE)],
    ["v1.1 head change", OWNERS.v11, () => v11HeadChange(pool, t, OWNERS.v11, V11_DEVICE)],
    ["v1.2 activation", OWNERS.v12, () => v12Activation(pool, schema, t, modules, OWNERS.v12, V12_DEVICE)],
    ["v0.2 contribution", OWNERS.v02, () => v02Contribution(pool, t, OWNERS.v02)],
  ];
  const observations = [];
  for (const [label, participantId, write] of flows) {
    const before = {
      retired: await retiredState(pool, t),
      control: await mutationControl(pool, t),
      revision: await inputRevision(pool, t, participantId),
      digest: await sourceDigest(pool, t, participantId),
      queue: await queueRow(pool, t, participantId),
    };
    await write();
    const after = {
      retired: await retiredState(pool, t),
      control: await mutationControl(pool, t),
      revision: await inputRevision(pool, t, participantId),
      digest: await sourceDigest(pool, t, participantId),
      queue: await queueRow(pool, t, participantId),
    };
    observations.push({ label, participantId, before, after });
  }
  return observations;
}

test("PG17 control: before the retirement every write feeds current_queue, and the social v1 uploads flip publication_state, queue rebuild work, invalidate history and composition days, and wipe preview_cache", {
  skip: SKIP, timeout: 240_000,
}, async () => withSchema({ retire: false, seed: seedUploadOwners, domain: true }, async (context) => {
  const [v1, v1Second, v11, v12, v02] = await runUploadFlows(context);
  // The accepted append.
  assert.equal(v1.before.retired.publicationState[0].publication_state, "ready");
  assert.equal(v1.after.retired.publicationState[0].publication_state, "updating",
    "0010 flips the shared publication flag on a social v1 upload");
  assert.deepEqual(v1.after.retired.dailyRebuilds.map(({ day }) => day), ["2026-09-01", DAY],
    "0010 queues a daily rebuild for the uploaded day");
  assert.deepEqual(v1.after.retired.refreshLanes.find(({ lane }) => lane === "current"),
    { lane: "current", state: "queued", completed_at: null, restart_reason: "input_changed" });
  assert.deepEqual(v1.before.retired.compositionDays.map(({ day }) => day), COMPOSITION_DAYS.map(([day]) => day));
  assert.deepEqual(v1.after.retired.compositionDays.map(({ day }) => day), ["2026-09-23", "2026-09-25"],
    "0010 deletes the method-bound composition days in the upload's window");
  assert.deepEqual(v1.after.retired.historyDependencies, [{
    participant_id: OWNERS.v1, day: DAY, dependency_revision: 1, input_fingerprint: null, verified_input_revision: null,
  }], "0010 invalidates the owner's history dependency on the uploaded day");
  assert.deepEqual(v1.after.retired.previewCache, v1.before.retired.previewCache,
    "an accepted append kept the preview cache even under 0010");
  assert.equal(v1.after.control.graph_append_epoch, v1.after.control.mutation_epoch);
  // The second device's upload to the same day is not an accepted append.
  assert.equal(v1Second.after.control.graph_append_epoch, -1);
  assert.equal(v1Second.after.control.graph_invalidation_epoch, v1Second.after.control.mutation_epoch);
  assert.equal(v1Second.before.retired.previewCache.length, 1);
  assert.deepEqual(v1Second.after.retired.previewCache, [],
    "0010 wipes the shared preview cache on an upload that is not an accepted append");
  assert.ok(v1Second.after.retired.historyDependencies[0].dependency_revision
    > v1Second.before.retired.historyDependencies[0].dependency_revision);
  // 0010 moved mutation_epoch (and so the flag and the cache) only for v1
  // chunks; the other three writes' retired effect was the queue.
  for (const observation of [v11, v12, v02]) {
    assert.deepEqual(observation.after.control, observation.before.control,
      `0010 left the publication flag and caches alone on a ${observation.label}`);
  }
  for (const observation of [v1, v1Second, v11, v12, v02]) {
    assert.ok(observation.after.queue.dirty_generation > observation.before.queue.dirty_generation,
      `0010 marks the ${observation.label} owner dirty in current_queue`);
    assert.equal(observation.after.queue.pending, true);
    assert.notDeepEqual(observation.after.retired, observation.before.retired);
  }
}));

test("PG17 once retired, social v1 uploads, a v1.1 head change, a v1.2 activation and a v0.2 contribution leave publication_state, preview_cache, current_queue, refresh_lanes and daily_rebuilds untouched", {
  skip: SKIP, timeout: 240_000,
}, async () => withSchema({ retire: "head", seed: seedUploadOwners, domain: true }, async (context) => {
  const { pool, t } = context;
  const observations = await runUploadFlows(context);
  for (const { label, before, after } of observations) {
    assert.deepEqual(after.retired, before.retired, `${label} leaves every retired table byte-identical`);
    assert.ok(after.revision > before.revision, `${label} still advances the owner's input revision`);
    assert.notEqual(after.digest, before.digest, `${label} still extends the owner's source digest chain`);
  }
  const [v1, v1Second] = observations;
  assert.equal(v1.before.retired.publicationState[0].publication_state, "ready");
  assert.deepEqual(v1.before.retired.previewCache, [{ id: "synthetic-iso1-preview", payload: '{"synthetic": true}' }]);
  assert.equal(v1.before.retired.currentQueue.length, 4);
  assert.equal(v1.before.retired.refreshLanes.length, 2);
  assert.equal(v1.before.retired.dailyRebuilds.length, 1);
  assert.equal(v1.before.retired.compositionDays.length, COMPOSITION_DAYS.length);
  assert.equal(v1.before.retired.historyDependencies.length, 1);
  // The kept mutation_control counters: an accepted append advances
  // mutation_epoch and graph_append_epoch and preserves the invalidation
  // epoch; any other upload advances the invalidation epoch as well.
  assert.deepEqual(v1.after.control, {
    mutation_epoch: v1.before.control.mutation_epoch + 1,
    graph_append_epoch: v1.before.control.mutation_epoch + 1,
    graph_invalidation_epoch: v1.before.control.graph_invalidation_epoch,
    graph_append_reason: "accepted-append",
    graph_last_change_reason: "accepted-append",
    changed: true,
  });
  assert.deepEqual(v1Second.after.control, {
    mutation_epoch: v1Second.before.control.mutation_epoch + 1,
    graph_append_epoch: -1,
    graph_invalidation_epoch: v1Second.before.control.mutation_epoch + 1,
    graph_append_reason: "accepted-append",
    graph_last_change_reason: "authority-or-unrecognized-change",
    changed: true,
  });
  const fitRows = await rows(pool, `SELECT participant_id,resets_at::text AS resets_at
    FROM ${t("telemetry_v1_quota_fit_rows")} ORDER BY record_id`);
  assert.deepEqual(fitRows, [
    { participant_id: OWNERS.v1, resets_at: "2026-09-30 00:00:00+00" },
    { participant_id: OWNERS.v1, resets_at: "2026-09-30 00:00:00+00" },
  ], "the quota-fit index still follows both uploads");
}));

test("PG17 the writes move the kept mutation_control counters identically with and without the retirement", {
  skip: SKIP, timeout: 300_000,
}, async () => {
  const deltas = async (retire) => withSchema({ retire, seed: seedUploadOwners, domain: true }, async (context) => {
    const observations = await runUploadFlows(context);
    return observations.map(({ label, before, after }) => ({
      label,
      revision: after.revision - before.revision,
      mutationEpoch: after.control.mutation_epoch - before.control.mutation_epoch,
      appendEpochFollows: after.control.graph_append_epoch === after.control.mutation_epoch,
      invalidationEpoch: after.control.graph_invalidation_epoch - before.control.graph_invalidation_epoch,
      appendReason: after.control.graph_append_reason,
      changeReason: after.control.graph_last_change_reason,
    }));
  });
  const retired = await deltas("isolated");
  assert.deepEqual(retired.map(({ label, appendEpochFollows }) => [label, appendEpochFollows]), [
    ["social v1 upload", true],
    ["second-device social v1 upload", false],
    ["v1.1 head change", false],
    ["v1.2 activation", false],
    ["v0.2 contribution", false],
  ]);
  assert.ok(retired[1].invalidationEpoch > 0, "the second-device upload advances the invalidation epoch");
  assert.deepEqual(retired, await deltas(false));
});

// ---------------------------------------------------------------------------
// Scenario 2: participant withdrawal and deletion.

const LIFECYCLE_OWNER = "synthetic-iso1-lifecycle-owner";
const BYSTANDER = "synthetic-iso1-bystander-owner";

async function seedLifecycle({ pool, t }) {
  await createSocialOwner(pool, t, LIFECYCLE_OWNER);
  await createSocialOwner(pool, t, BYSTANDER);
  for (const participantId of [LIFECYCLE_OWNER, BYSTANDER]) {
    await pool.query(`INSERT INTO ${t("current_queue")} (participant_id,dirty_generation,window_generation,pending,
      last_served_sequence) VALUES ($1,1,1,false,0)`, [participantId]);
    await pool.query(`INSERT INTO ${t("community_model_history_dependencies")} (participant_id,day,from_day)
      VALUES ($1,$2::date,$2::date - 100)`, [participantId, DAY]);
  }
  await pool.query(`INSERT INTO ${t("prepared_source_days")} (participant_id,source_day,phase,progress_revision,
    quota_count,usage_count) VALUES ($1,$2,'complete',1,0,0)`, [LIFECYCLE_OWNER, DAY]);
  await pool.query(`INSERT INTO ${t("community_model_composition_days")} (day,payload_json,computed_at,history_method_version)
    VALUES ('2026-09-01','{}','2026-09-20T00:00:00Z','synthetic-method'),
           ('2026-09-02','{}','2026-09-20T00:00:00Z',NULL)`);
  await pool.query(`INSERT INTO ${t("preview_cache")} (id,payload) VALUES ('synthetic-iso1-preview','{}'::jsonb)`);
}

async function runLifecycle({ pool, t }) {
  const snapshot = async () => ({
    retired: await retiredState(pool, t),
    control: await mutationControl(pool, t),
    revision: await inputRevision(pool, t, LIFECYCLE_OWNER),
    dependencies: await rows(pool, `SELECT participant_id FROM ${t("community_model_history_dependencies")}
      ORDER BY participant_id`),
  });
  const start = await snapshot();
  await pool.query(`UPDATE ${t("participants")} SET state='deleting' WHERE id=$1`, [LIFECYCLE_OWNER]);
  const withdrawn = await snapshot();
  await pool.query(`DELETE FROM ${t("participants")} WHERE id=$1`, [LIFECYCLE_OWNER]);
  const deleted = await snapshot();
  return { start, withdrawn, deleted };
}

test("PG17 control: before the retirement participant withdrawal and deletion wipe shared caches and every owner's composition days", {
  skip: SKIP, timeout: 180_000,
}, async () => withSchema({ retire: false, seed: seedLifecycle }, async (context) => {
  const { start, withdrawn } = await runLifecycle(context);
  assert.equal(start.retired.previewCache.length, 1);
  assert.equal(withdrawn.retired.previewCache.length, 0, "0010 wipes the shared preview cache on withdrawal");
  assert.deepEqual(withdrawn.retired.compositionDays.map(({ day }) => day), ["2026-09-02"],
    "0010 deletes every owner's method-bound composition days on one owner's state change");
  assert.equal(withdrawn.retired.publicationState[0].publication_state, "updating");
  assert.deepEqual(withdrawn.retired.currentQueue.map(({ participant_id: id }) => id), [BYSTANDER]);
}));

test("PG17 once retired, participant withdrawal and deletion keep owner-scoped effects and no longer touch shared caches", {
  skip: SKIP, timeout: 180_000,
}, async () => withSchema({ retire: "head", seed: seedLifecycle }, async (context) => {
  const { start, withdrawn, deleted } = await runLifecycle(context);
  for (const later of [withdrawn, deleted]) {
    assert.deepEqual(later.retired.previewCache, start.retired.previewCache, "the shared preview cache is kept");
    assert.deepEqual(later.retired.compositionDays, start.retired.compositionDays, "composition days are kept");
    assert.deepEqual(later.retired.publicationState, start.retired.publicationState, "the policy row is untouched");
    assert.deepEqual(later.retired.refreshLanes, start.retired.refreshLanes);
    assert.deepEqual(later.retired.dailyRebuilds, start.retired.dailyRebuilds);
    assert.deepEqual(later.retired.preparationCounters, start.retired.preparationCounters,
      "preparation counters are no longer maintained");
  }
  // Owner-scoped effects are kept.
  assert.equal(withdrawn.revision, start.revision + 1, "the state change still bumps the owner's input revision");
  assert.deepEqual(withdrawn.dependencies, [{ participant_id: BYSTANDER }],
    "only the changed owner's history dependencies are removed");
  assert.deepEqual(withdrawn.retired.currentQueue, start.retired.currentQueue,
    "a withdrawal no longer edits the retired queue");
  assert.equal(deleted.revision, null, "deletion removes the owner's input revision");
  assert.deepEqual(deleted.retired.currentQueue.map(({ participant_id: id }) => id), [BYSTANDER],
    "the owner's retired queue row cascades with the participant");
  assert.deepEqual(deleted.retired.preparedSourceDays, [], "the owner's prepared-source rows are removed");
  // The kept mutation_control counters still advance and invalidate. No
  // PostgreSQL module reads them, and with the policy flag retired the claim
  // no longer hides published days: withdrawal reaches readers only through
  // the owner journal's terminal events.
  assert.equal(withdrawn.retired.publicationState[0].publication_state, "ready");
  for (const [previous, next] of [[start, withdrawn], [withdrawn, deleted]]) {
    assert.equal(next.control.mutation_epoch, previous.control.mutation_epoch + 1);
    assert.equal(next.control.graph_invalidation_epoch, next.control.mutation_epoch);
    assert.equal(next.control.graph_last_change_reason, "authority-or-unrecognized-change");
  }
}));

// ---------------------------------------------------------------------------
// Scenario 3: the policy row and the refusals.

test("PG17 the retirement sets the policy row ready once, pins it, and refuses refills of the retired queues", {
  skip: SKIP, timeout: 180_000,
}, async () => {
  const seed = async ({ pool, t }) => {
    await createSocialOwner(pool, t, "synthetic-iso1-refusal-owner");
    await pool.query(`UPDATE ${t("publication_state")} SET publication_state='updating',policy_revision=3,
      changed_at='2026-09-20T00:00:00Z' WHERE singleton=1`);
  };
  await withSchema({ retire: "head", seed }, async ({ pool, t }) => {
    const [policy] = await rows(pool, `SELECT publication_state,policy_revision::int AS policy_revision,
      changed_at > '2026-09-20T00:00:00Z'::timestamptz AS changed FROM ${t("publication_state")}`);
    assert.deepEqual(policy, { publication_state: "ready", policy_revision: 3, changed: true },
      "the migration sets ready once and keeps policy_revision");

    const refused = async (sql, values = []) => assert.rejects(pool.query(sql, values),
      (error) => error?.code === "P1005" && error.message === "publication_policy_row_immutable");
    const refusal = "retired_analytics_write_refused";
    const refusals = [
      ["current_queue", `INSERT INTO ${t("current_queue")} VALUES ($1,1,1,true,0)`, ["synthetic-iso1-refusal-owner"]],
      ["refresh_lanes", `INSERT INTO ${t("refresh_lanes")} (lane,state) VALUES ('current','queued')`, []],
      ["daily_rebuilds", `INSERT INTO ${t("daily_rebuilds")} VALUES ($1::date,0,clock_timestamp())`, [DAY]],
      ["prepared_source_days", `INSERT INTO ${t("prepared_source_days")} VALUES ($1,$2::date,'quota',0,0,0)`,
        ["synthetic-iso1-refusal-owner", DAY]],
    ];
    assert.deepEqual(refusals.map(([table]) => table), [...REFUSED_TABLES]);
    for (const [table, sql, values] of refusals) {
      await assert.rejects(pool.query(sql, values),
        (error) => error?.code === "P1005" && error.message === refusal, `${table} refuses inserts`);
    }

    await refused(`UPDATE ${t("publication_state")} SET publication_state='updating' WHERE singleton=1`);
    await refused(`UPDATE ${t("publication_state")} SET policy_revision=2 WHERE singleton=1`);
    await refused(`DELETE FROM ${t("publication_state")} WHERE singleton=1`);
    await refused(`TRUNCATE ${t("publication_state")}`);
    await refused(`INSERT INTO ${t("publication_state")} (singleton,publication_state,changed_at,policy_revision)
      VALUES (1,'ready',clock_timestamp(),9) ON CONFLICT (singleton) DO NOTHING`);
    assert.deepEqual(await rows(pool, `SELECT singleton FROM ${t("publication_state")}`), [{ singleton: 1 }],
      "the policy singleton survives every refused removal");
    // The policy revision may still advance, and a ready no-op stays valid.
    await pool.query(`UPDATE ${t("publication_state")} SET policy_revision=4,changed_at=clock_timestamp() WHERE singleton=1`);
    await pool.query(`UPDATE ${t("publication_state")} SET publication_state='ready',policy_revision=4 WHERE singleton=1`);
    const [after] = await rows(pool, `SELECT publication_state,policy_revision::int AS policy_revision FROM ${t("publication_state")}`);
    assert.deepEqual(after, { publication_state: "ready", policy_revision: 4 });
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: the kept guards behave identically with and without the retirement.

async function guardOutcomes({ pool, t }) {
  const [deviceId] = await createSocialOwner(pool, t, "synthetic-iso1-guard-owner");
  const floorOwner = "synthetic-iso1-floor-owner";
  const [floorDevice] = await createSocialOwner(pool, t, floorOwner);
  const authorization = async (participantId, device) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO ${t("device_upload_authorizations")} (
        id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,content_type,state,issued_at,expires_at,
        consumed_at
      ) VALUES ($1,$2,$3,$4,$5,64,'application/json','consumed',$6,$7,$6)`,
    [id, participantId, device, randomBytes(32), digest(`envelope-${id}`), iso(-1_000), iso(86_400_000)]);
    return id;
  };
  const chunk = (participantId, device, chunkId, authorizationId, seq) => pool.query(`INSERT INTO ${t("telemetry_v1_chunks")} (
      id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,envelope_digest,parser_version,
      record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at
    ) VALUES ($1,$2,$3,'quota',$4::date,$5,1,$6,$7,'synthetic-iso1',1,1,$8,$9,$10)`,
  [chunkId, participantId, device, DAY, seq, digest(`chunk-${chunkId}`), digest(`envelope-${chunkId}`),
    `synthetic/iso1/${chunkId}`, authorizationId, iso()]);
  const outcome = async (operation) => {
    try {
      await operation();
      return "accepted";
    } catch (error) {
      return error?.code ?? "unknown";
    }
  };
  const results = {};

  // Reconciliation guard: a chunk without its registered pending object is refused.
  const unregisteredAuthorization = await authorization("synthetic-iso1-guard-owner", deviceId);
  results.unregisteredChunk = await outcome(() => chunk("synthetic-iso1-guard-owner", deviceId, "synthetic-iso1-unregistered",
    unregisteredAuthorization, 0));
  // Quota-fit index: an eligible record is indexed, re-indexed on update and removed on delete.
  const authorizationId = await authorization("synthetic-iso1-guard-owner", deviceId);
  await pool.query(`INSERT INTO ${t("pending_objects")} (contribution_id,object_key,object_kind)
    VALUES ('synthetic-iso1-registered','synthetic/iso1/synthetic-iso1-registered','telemetry_v1')`);
  results.registeredChunk = await outcome(() => chunk("synthetic-iso1-guard-owner", deviceId, "synthetic-iso1-registered",
    authorizationId, 1));
  await pool.query(`INSERT INTO ${t("telemetry_v1_records")} (
      chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,observed_day,provider,plan_type,plan_variant,
      limit_id,slot,used_percent,window_duration_minutes,resets_at,record_json
    ) VALUES ('synthetic-iso1-registered','synthetic-iso1-guard-owner',$1,'quota','synthetic-iso1-fit',$2,$3::date,
      'openai_codex','pro','unknown','codex','primary',10,10080,'2026-09-30T00:00:00Z','{}'::jsonb)`,
  [deviceId, `${DAY}T12:00:00Z`, DAY]);
  const fitRows = async () => (await rows(pool, `SELECT resets_at::text AS resets_at FROM ${t("telemetry_v1_quota_fit_rows")}`))
    .map(({ resets_at: value }) => value);
  results.fitAfterInsert = await fitRows();
  await pool.query(`UPDATE ${t("telemetry_v1_records")} SET resets_at='2026-10-07T00:00:00Z' WHERE occurrence_id='synthetic-iso1-fit'`);
  results.fitAfterUpdate = await fitRows();
  await pool.query(`DELETE FROM ${t("telemetry_v1_records")} WHERE occurrence_id='synthetic-iso1-fit'`);
  results.fitAfterDelete = await fitRows();
  // Transport floor: a participant floor above v1.0 refuses a registered v1 chunk.
  await pool.query(`INSERT INTO ${t("telemetry_transport_participant_floors")} (participant_id,minimum_rank,revision,changed_at)
    VALUES ($1,11,1,clock_timestamp())
    ON CONFLICT (participant_id) DO UPDATE SET minimum_rank=11,revision=telemetry_transport_participant_floors.revision+1`,
  [floorOwner]);
  const floorAuthorization = await authorization(floorOwner, floorDevice);
  await pool.query(`INSERT INTO ${t("pending_objects")} (contribution_id,object_key,object_kind)
    VALUES ('synthetic-iso1-floor','synthetic/iso1/synthetic-iso1-floor','telemetry_v1')`);
  results.flooredChunk = await outcome(() => chunk(floorOwner, floorDevice, "synthetic-iso1-floor", floorAuthorization, 0));
  return results;
}

test("PG17 the retirement keeps the quota-fit, transport-floor and reconciliation guards", {
  skip: SKIP, timeout: 180_000,
}, async () => {
  const retired = await withSchema({ retire: "isolated" }, guardOutcomes);
  assert.deepEqual(retired, {
    unregisteredChunk: "P1005",
    registeredChunk: "accepted",
    fitAfterInsert: ["2026-09-30 00:00:00+00"],
    fitAfterUpdate: ["2026-10-07 00:00:00+00"],
    fitAfterDelete: [],
    flooredChunk: "P1007",
  });
  assert.deepEqual(await withSchema({ retire: false }, guardOutcomes), retired,
    "every kept guard answers exactly as before the retirement");
});

// ---------------------------------------------------------------------------
// Scenario 5: the catalog.

/** Every non-internal trigger, function and table in the schema, with definitions. */
async function catalog(pool, schema) {
  const triggers = new Map((await rows(pool, `SELECT relation.relname || '/' || trigger_row.tgname AS name,
      pg_get_triggerdef(trigger_row.oid) AS definition
      FROM pg_trigger trigger_row
      JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
     WHERE namespace.nspname=$1 AND NOT trigger_row.tgisinternal`, [schema]))
    .map(({ name, definition }) => [name, definition]));
  const functions = new Map((await rows(pool, `SELECT proc.proname || '(' || pg_get_function_identity_arguments(proc.oid) || ')' AS name,
      CASE WHEN proc.prokind IN ('f','p') THEN pg_get_functiondef(proc.oid) ELSE proc.prokind::text END AS definition
      FROM pg_proc proc JOIN pg_namespace namespace ON namespace.oid=proc.pronamespace
     WHERE namespace.nspname=$1`, [schema]))
    .map(({ name, definition }) => [name, definition]));
  const tables = (await rows(pool, `SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename`, [schema]))
    .map(({ tablename }) => tablename);
  return { triggers, functions, tables };
}

const sorted = (values) => [...values].sort();
const triggerName = ([table, name]) => `${table}/${name}`;
const functionName = (name) => `${name}()`;

test("PG17 the retirement alone drops exactly the retired triggers and functions, adds only its refusals and policy guard, and rewrites only three functions", {
  skip: SKIP, timeout: 120_000,
}, async () => {
  let before;
  await withSchema({
    retire: "isolated",
    seed: async ({ pool, schema }) => { before = await catalog(pool, schema); },
  }, async ({ pool, schema }) => {
    const after = await catalog(pool, schema);
    const retiredTriggers = new Set(RETIRED_TRIGGERS.map(triggerName));
    for (const name of retiredTriggers) assert.equal(before.triggers.has(name), true, `${name} exists before the retirement`);
    assert.deepEqual(sorted(after.triggers.keys()), sorted([
      ...[...before.triggers.keys()].filter((name) => !retiredTriggers.has(name)),
      ...ADDED_TRIGGERS.map(triggerName),
    ]), "the retirement drops exactly the retired triggers and adds only its own");
    for (const [name, definition] of before.triggers) {
      if (!retiredTriggers.has(name)) assert.equal(after.triggers.get(name), definition, `${name} is kept unchanged`);
    }
    for (const trigger of KEPT_TRIGGERS) assert.equal(after.triggers.has(triggerName(trigger)), true);

    const retiredFunctions = new Set(RETIRED_FUNCTIONS.map(functionName));
    for (const name of retiredFunctions) assert.equal(before.functions.has(name), true, `${name} exists before the retirement`);
    assert.deepEqual(sorted(after.functions.keys()), sorted([
      ...[...before.functions.keys()].filter((name) => !retiredFunctions.has(name)),
      ...ADDED_FUNCTIONS.map(functionName),
    ]), "the retirement drops exactly the retired functions and adds only its own");
    const replaced = new Set(REPLACED_FUNCTIONS.map(functionName));
    for (const [name, definition] of before.functions) {
      if (retiredFunctions.has(name)) continue;
      if (replaced.has(name)) {
        assert.notEqual(after.functions.get(name), definition, `${name} is replaced`);
      } else {
        assert.equal(after.functions.get(name), definition, `${name} is kept unchanged`);
      }
    }
    assert.deepEqual(after.tables, before.tables, "every table is kept: the erasure inventories still list them");
  });
});

test("PG17 at the head of the chain the retired triggers and functions stay dropped, the refusals and policy guard stay, and no kept function writes retired state", {
  skip: SKIP, timeout: 120_000,
}, async () => withSchema({ retire: "head" }, async ({ pool, schema }) => {
  const { triggers, functions } = await catalog(pool, schema);
  for (const trigger of RETIRED_TRIGGERS) {
    assert.equal(triggers.has(triggerName(trigger)), false, `${triggerName(trigger)} stays dropped`);
  }
  for (const name of RETIRED_FUNCTIONS) assert.equal(functions.has(functionName(name)), false, `${name}() stays dropped`);
  for (const trigger of ADDED_TRIGGERS) {
    assert.equal(triggers.has(triggerName(trigger)), true, `${triggerName(trigger)} is in place`);
  }
  for (const name of REPLACED_FUNCTIONS) {
    const body = functions.get(functionName(name));
    if (body === undefined) continue;
    assert.doesNotMatch(body, /\b(?:publication_state|preview_cache|community_model_composition_days|current_queue|refresh_lanes|daily_rebuilds)\b/u,
      `${name}() writes no retired publication, cache or queue state`);
  }
  const publicationMutated = functions.get(functionName("publication_mutated"));
  if (publicationMutated !== undefined) assert.match(publicationMutated, /graph_invalidation_epoch/u);
}));
