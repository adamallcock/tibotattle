import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { COMMUNITY_ALLOWANCE_FIT_METHOD } from "../src/community-allowance.ts";
import {
  persistPostgresCommunityAllowanceFitResult,
  readPostgresCommunityAllowanceFitResult,
} from "../src/postgres-community-allowance-fits.ts";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "5432");
const SOURCE_ID = "synthetic-fit-source";
const SOURCE_NAMESPACE = "synthetic-fit-namespace";
const DAY = "2026-09-23";

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  const link = await lstat(PG_TEST_SOCKET);
  const resolved = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

describe.skipIf(!PG_TEST_SOCKET)("PostgreSQL persisted allowance-fit boundary", () => {
  let pool;
  let schema;
  let sqlSchema;
  let pinnedInput;
  let ownerDigest;
  let participantId;
  let generationId;

  const schemaOptions = () => ({ primarySchema: schema, ledgerSchema: `${schema}_ledger` });

  beforeAll(async () => {
    const socket = await localSocket();
    pool = new pg.Pool({
      ...socket,
      user: process.env.PG_TEST_USER || "postgres",
      password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
      database: process.env.PG_TEST_DATABASE || "postgres",
      application_name: "pg-community-allowance-fits-test",
      ssl: false,
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const locality = await pool.query("SELECT inet_server_addr() AS address, version() AS version");
    assert.equal(locality.rows[0]?.address, null, "qualification requires a local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^PostgreSQL 17\./u);
  }, 120_000);

  beforeEach(async () => {
    schema = `pcaf_${randomBytes(6).toString("hex")}`;
    sqlSchema = `"${schema}"`;
    await pool.query(`CREATE SCHEMA ${sqlSchema}`);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    await seedGlobalAuthority();
    await seedOwner();
  }, 120_000);

  afterEach(async () => {
    if (schema) await pool.query(`DROP SCHEMA IF EXISTS ${sqlSchema} CASCADE`);
    schema = undefined;
    sqlSchema = undefined;
    pinnedInput = undefined;
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function seedGlobalAuthority() {
    const now = new Date().toISOString();
    const sourceDigestV1 = "a".repeat(64);
    const sourceDigestV11 = "b".repeat(64);
    await pool.query(`INSERT INTO ${sqlSchema}.storage_source_state(singleton, source_id, authority_epoch)
      VALUES (1, $1, 0)`, [SOURCE_ID]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_source_cursors(source_id, sequence, authority_epoch)
      VALUES ($1, 0, 0)`, [SOURCE_ID]);
    await pool.query(`UPDATE ${sqlSchema}.publication_state
      SET publication_state='ready' WHERE singleton=1`);
    await pool.query(`UPDATE ${sqlSchema}.collection_controls SET revision=revision+1,
      control_state='operational', enrollment_enabled=true, upload_registration_enabled=true,
      processing_enabled=true, publication_enabled=true, reason_code=NULL,
      updated_at=clock_timestamp() WHERE singleton=1`);
    await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_runtime SET state='active', changed_at=$1 WHERE id=1`, [now]);
    await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_typed_runtime SET state='active', changed_at=$1 WHERE id=1`, [now]);
    await pool.query(`INSERT INTO ${sqlSchema}.typed_telemetry_source_family_receipts(
      source_namespace, source_format, generation, source_digest, source_row_count,
      membership_row_count, reconciled_at
    ) VALUES ($1,10,1,$2,0,0,$3), ($1,11,1,$4,0,0,$3)`, [
      SOURCE_NAMESPACE, sourceDigestV1, now, sourceDigestV11,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.typed_telemetry_admission_transfer_receipts(
      transfer_id, v1_source_namespace, v1_source_format, v11_source_namespace,
      v11_source_format, v1_base_generation, v11_base_generation,
      source_snapshot_sha256, lineage_manifest_sha256, table_row_counts
    ) VALUES ($1,$2,10,$2,11,1,1,$3,$4,'{}'::jsonb)`, [
      `synthetic-fit-transfer-${randomUUID()}`, SOURCE_NAMESPACE, "c".repeat(64), "d".repeat(64),
    ]);
  }

  async function seedOwner() {
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    participantId = `synthetic-fit-owner-${randomUUID()}`;
    ownerDigest = randomBytes(32).toString("hex");
    const sessionId = randomUUID();
    const pairingId = randomUUID();
    const deviceId = randomUUID();
    generationId = randomUUID();
    const predecessorHash = randomBytes(32).toString("hex");

    await pool.query(`INSERT INTO ${sqlSchema}.participants(
      id, owner_kind, state, consent_version, consented_at, created_at
    ) VALUES ($1,'social','active','synthetic-consent',$2,$2)`, [participantId, now]);
    await pool.query(`INSERT INTO ${sqlSchema}.web_sessions(
      id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [
      sessionId, participantId, randomBytes(32), randomBytes(32), now, expires,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.device_pairings(
      id, participant_id, issued_by_session_id, secret_hash, consent_version,
      transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
    ) VALUES ($1,$2,$3,$4,'synthetic-consent','synthetic-transport','consumed',$5,$6,$5,$7)`, [
      pairingId, participantId, sessionId, randomBytes(32), now, expires, deviceId,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.device_credentials(
      id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
      state, issued_at, expires_at, last_used_at
    ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5)`, [
      deviceId, participantId, pairingId, randomBytes(32), now, expires,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v12_device_capabilities(
      participant_id, device_id, telemetry_schema_version, field_dictionary_version,
      privacy_contract_version, state, consented_at
    ) VALUES ($1,$2,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
      'ongoing-privacy-safe-telemetry-v1.2','accepted',$3)`, [participantId, deviceId, now]);
    await pool.query(`INSERT INTO ${sqlSchema}.storage_v11_owner_links(participant_id, owner_digest, state)
      VALUES ($1,$2,'active')`, [participantId, ownerDigest]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_owner_state(
      source_id, owner_digest, revision, authority_epoch, state
    ) VALUES ($1,$2,1,0,'active')`, [SOURCE_ID, ownerDigest]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v12_domain_predecessors(
      token_hash, participant_id, device_id, previous_generation_id, legacy_fingerprint,
      input_revision, from_day, through_day, winners_json, days_json, created_at, expires_at
    ) VALUES ($1,$2,$3,NULL,$4,0,$5::date,$5::date,NULL,'[]',$6,$7)`, [
      predecessorHash, participantId, deviceId, "f".repeat(64), DAY, now, expires,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v12_domains(
      id, participant_id, device_id, predecessor_token_hash, previous_generation_id,
      manifest_digest, legacy_fingerprint, input_revision, from_day, through_day,
      days_json, created_at
    ) VALUES ($1,$2,$3,$4,NULL,$5,$6,0,$7::date,$7::date,'[]',$8)`, [
      generationId, participantId, deviceId, predecessorHash, "1".repeat(64), "f".repeat(64), DAY, now,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v12_domain_heads(
      participant_id, generation_id, revision, updated_at
    ) VALUES ($1,$2,1,$3)`, [participantId, generationId, now]);

    const ownerRevisions = await pool.query(`SELECT publisher.revision AS publisher_revision,
        analytical.revision AS analytical_revision
      FROM ${sqlSchema}.input_versions publisher
      JOIN ${sqlSchema}.community_analytical_input_versions analytical USING (participant_id)
      WHERE publisher.participant_id=$1`, [participantId]);

    const latest = await pool.query(`SELECT COALESCE(max(sequence),0)::text AS sequence
      FROM ${sqlSchema}.storage_ingestion_changes WHERE source_id=$1`, [SOURCE_ID]);
    const sequence = Number(latest.rows[0].sequence);
    // The v1.2 owner bridge journals the accepted head as owner-active, which
    // advances the source epoch; a caught-up cursor carries it with the sequence.
    const sourceEpoch = Number((await pool.query(`SELECT authority_epoch::text AS epoch
      FROM ${sqlSchema}.storage_source_state WHERE singleton=1`)).rows[0].epoch);
    await pool.query(`UPDATE ${sqlSchema}.analytics_source_cursors SET sequence=$2, authority_epoch=$3 WHERE source_id=$1`,
      [SOURCE_ID, sequence, sourceEpoch]);
    const control = await pool.query(`SELECT policy.policy_revision, controls.revision AS collection_revision,
        v12.revision AS runtime_revision, typed.policy_revision AS typed_policy_revision
      FROM ${sqlSchema}.publication_state policy
      JOIN ${sqlSchema}.collection_controls controls ON controls.singleton=1
      JOIN ${sqlSchema}.telemetry_v12_runtime v12 ON v12.id=1
      JOIN ${sqlSchema}.telemetry_v12_typed_runtime typed ON typed.id=1
      WHERE policy.singleton=1`);
    const numeric = (value) => Number(value);
    const effectiveSourcePin = {
      sourceId: SOURCE_ID,
      sourceNamespace: SOURCE_NAMESPACE,
      storageAuthorityEpoch: sourceEpoch,
      sourceCursorSequence: sequence,
      sourceCursorAuthorityEpoch: sourceEpoch,
      v1ImportGeneration: 1,
      v1ImportDigest: "a".repeat(64),
      v11ImportGeneration: 1,
      v11ImportDigest: "b".repeat(64),
    };
    const ownerPin = {
      ...effectiveSourcePin,
      ownerDigest,
      participantId,
      inputRevision: Number(ownerRevisions.rows[0].analytical_revision),
      ownerRevision: 1,
      authorityEpoch: 0,
      v12State: "active:active",
      v12GenerationId: generationId,
    };
    pinnedInput = {
      sourcePin: {
        sourceId: SOURCE_ID,
        sourceNamespace: SOURCE_NAMESPACE,
        sourceAuthorityEpoch: sourceEpoch,
        analyticsAuthorityEpoch: sourceEpoch,
        sequence,
        telemetryV12RuntimeState: "active",
        telemetryV12RuntimeRevision: numeric(control.rows[0].runtime_revision),
        telemetryV12TypedRuntimeState: "active",
        telemetryV12TypedRuntimePolicyRevision: numeric(control.rows[0].typed_policy_revision),
        accountlessAuthorizationCount: 0,
        nextAccountlessAuthorizationExpiry: null,
        effectiveSourcePin,
        policyRevision: numeric(control.rows[0].policy_revision),
        collectionRevision: numeric(control.rows[0].collection_revision),
      },
      owner: {
        participantId,
        ownerDigest,
        inputRevision: Number(ownerRevisions.rows[0].publisher_revision),
        ownerRevision: 1,
        authorityEpoch: 0,
        sourceKind: "effective",
        hasV1: false,
        hasV11: false,
        hasLegacy: false,
        hasV12: true,
        v12GenerationId: generationId,
        ownerPin,
      },
      observedDay: DAY,
      fitMethodVersion: COMMUNITY_ALLOWANCE_FIT_METHOD,
      schema: schemaOptions(),
    };
  }

  it("stores and reads a private caller-computed v1.2 fit under exact source and owner fences", async () => {
    const input = {
      ...pinnedInput,
      fits: [
        { planType: "pro", capacityNanousd: 1_250_000_000, lastObservedAt: `${DAY}T08:00:00-04:00` },
      ],
    };
    expect(await persistPostgresCommunityAllowanceFitResult(pool, input))
      .toEqual({ state: "stored", ownerDigest, fitCount: 1 });
    expect(await persistPostgresCommunityAllowanceFitResult(pool, input))
      .toEqual({ state: "stored", ownerDigest, fitCount: 1 });
    expect(await persistPostgresCommunityAllowanceFitResult(pool, {
      ...input,
      fits: [{ ...input.fits[0], capacityNanousd: input.fits[0].capacityNanousd + 1 }],
    })).toMatchObject({ state: "deferred", reason: "result_conflict" });
    expect(await readPostgresCommunityAllowanceFitResult(pool, pinnedInput)).toMatchObject({
      schemaVersion: "postgres-community-allowance-fit-result-v1",
      method: "postgres-persisted-fit-input-v1",
      fitMethodVersion: COMMUNITY_ALLOWANCE_FIT_METHOD,
      sourceKind: "effective-v1.2",
      observedDay: DAY,
      ownerDigest,
      fitCount: 1,
      fits: [{ participantId, planType: "pro", capacityNanousd: 1_250_000_000,
        lastObservedAt: `${DAY}T08:00:00-04:00` }],
    });

    const counts = await pool.query(`SELECT
      (SELECT count(*)::int FROM ${sqlSchema}.analytics_owner_results WHERE metric='fits') AS fit_rows,
      (SELECT count(*)::int FROM ${sqlSchema}.community_daily_aggregates) AS daily_rows,
      (SELECT count(*)::int FROM ${sqlSchema}.community_daily_allowance_publication_state) AS readiness_rows`);
    expect(counts.rows[0]).toEqual({ fit_rows: 1, daily_rows: 0, readiness_rows: 0 });

    await pool.query(`UPDATE ${sqlSchema}.analytics_owner_results SET payload_json='{}'
      WHERE source_id=$1 AND metric='fits' AND owner_digest=$2`, [SOURCE_ID, ownerDigest]);
    expect(await readPostgresCommunityAllowanceFitResult(pool, pinnedInput)).toBeNull();
  });

  it("defers a stale source-policy pin and never creates readiness or aggregate state", async () => {
    await pool.query(`UPDATE ${sqlSchema}.collection_controls
      SET revision=revision+1, updated_at=clock_timestamp() WHERE singleton=1`);
    expect(await persistPostgresCommunityAllowanceFitResult(pool, {
      ...pinnedInput,
      fits: [],
    })).toMatchObject({ state: "deferred", reason: "source_changed", fitCount: 0 });
    expect(await readPostgresCommunityAllowanceFitResult(pool, pinnedInput)).toBeNull();
    const result = await pool.query(`SELECT
      (SELECT count(*)::int FROM ${sqlSchema}.analytics_owner_results WHERE metric='fits') AS fit_rows,
      (SELECT count(*)::int FROM ${sqlSchema}.community_daily_aggregates) AS daily_rows,
      (SELECT count(*)::int FROM ${sqlSchema}.community_daily_allowance_publication_state) AS readiness_rows`);
    expect(result.rows[0]).toEqual({ fit_rows: 0, daily_rows: 0, readiness_rows: 0 });
  });

  it("defers an owner revision change before writing", async () => {
    await pool.query(`UPDATE ${sqlSchema}.analytics_owner_state SET revision=revision+1
      WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, ownerDigest]);
    expect(await persistPostgresCommunityAllowanceFitResult(pool, {
      ...pinnedInput,
      fits: [],
    })).toMatchObject({ state: "deferred", reason: "owner_changed", fitCount: 0 });
  });
});
