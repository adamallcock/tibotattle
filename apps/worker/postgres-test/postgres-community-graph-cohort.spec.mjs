import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { telemetryV12DomainManifestDigestInput } from "@app-usagemonitor/telemetry-contract";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { createPostgresTypedV12Domain } from "../src/postgres-typed-v12-domain.ts";
import {
  listPostgresCommunityGraphCohortPage,
} from "../src/postgres-community-graph-cohort.ts";
import { isCanonicalCommunityGraphDigestPageAfter } from "../src/postgres-community-graph-readback-query.ts";
import {
  publishPostgresCommunityModelDay,
  publishPostgresCommunityModelDayFromCohort,
  readPostgresCommunityModelDay,
} from "../src/postgres-community-graph.ts";
import { V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "../src/quota-analysis-v11.ts";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "5432");
const SOURCE_ID = "synthetic-community-source";
const SOURCE_NAMESPACE = "synthetic-community-namespace";
const DAY = "2026-09-23";
const MODEL_FINGERPRINT = "f".repeat(64);

it("rejects locale-sorted member pages that diverge from canonical lowercase-hex order", () => {
  const e = "e".repeat(64);
  const f = "f".repeat(64);
  expect(isCanonicalCommunityGraphDigestPageAfter([e, f], "")).toBe(true);
  expect(isCanonicalCommunityGraphDigestPageAfter([e], f)).toBe(false);
  expect(isCanonicalCommunityGraphDigestPageAfter([f, e], "")).toBe(false);
  expect(isCanonicalCommunityGraphDigestPageAfter([e, e], "")).toBe(false);
  expect(isCanonicalCommunityGraphDigestPageAfter(["F".repeat(64)], "")).toBe(false);
});

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

function readyComposition(fingerprint) {
  return {
    status: "ready",
    planType: "pro",
    fit: {
      status: "fitted",
      observationCount: 30,
      totalCostUsd: 120,
      modelCostShares: { "gpt-6-astra": 1 },
      capacityUsdByModel: { "gpt-6-astra": 1000 },
      singleConstantUsd: 1000,
      r2: 0.99,
      singleConstantR2: 0.5,
      solverConverged: true,
      identification: {
        adjustedR2: 0.98,
        singleConstantAdjustedR2: 0.4,
        splitHalfIdentified: true,
        splitHalfMaxCapacityDriftFraction: 0,
      },
    },
    voidedBinCount: 0,
    poolCount: 1,
    quotaRowCount: 31,
    usageEventCount: 30,
    unpricedUsageEventCount: 0,
    poisonedBinCount: 0,
    latestQuotaObservedAt: "2026-09-22T12:00:00.000Z",
    attributionStatus: "legacy_conditional",
    attributionMethod: V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
    inputFingerprint: fingerprint,
  };
}

describe.skipIf(!PG_TEST_SOCKET)("PostgreSQL community graph cohort inventory", () => {
  let pool;
  let schema;
  let sqlSchema;

  beforeAll(async () => {
    const socket = await localSocket();
    pool = new pg.Pool({
      ...socket,
      user: process.env.PG_TEST_USER || "postgres",
      password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
      database: process.env.PG_TEST_DATABASE || "postgres",
      application_name: "pg-community-graph-cohort-test",
      ssl: false,
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const locality = await pool.query("SELECT inet_server_addr() AS address, version() AS version");
    assert.equal(locality.rows[0]?.address, null, "qualification requires a local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^PostgreSQL 17\./u);
  }, 120_000);

  beforeEach(async () => {
    schema = `pcgc_${randomBytes(6).toString("hex")}`;
    sqlSchema = `"${schema}"`;
    await pool.query(`CREATE SCHEMA ${sqlSchema}`);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    await seedGlobalAuthority();
  }, 120_000);

  afterEach(async () => {
    if (schema) await pool.query(`DROP SCHEMA IF EXISTS ${sqlSchema} CASCADE`);
    schema = undefined;
    sqlSchema = undefined;
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
      `synthetic-transfer-${randomUUID()}`, SOURCE_NAMESPACE, "c".repeat(64), "d".repeat(64),
    ]);
  }

  async function seedEffectiveOwner(suffix, { ownerKind = "social" } = {}) {
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    const participantId = `synthetic-graph-owner-${suffix}`;
    const ownerDigest = suffix.repeat(64);
    const sessionId = `${participantId}-session`;
    const pairingId = `${participantId}-pairing`;
    const deviceId = `${participantId}-device`;
    const manifestId = randomUUID();
    const chunkId = `chunk:${randomUUID()}`;
    const uploadAuthorizationId = randomUUID();
    const chunkName = `session:${DAY}:0`;
    const r2Key = `synthetic/community-graph/${chunkId}`;
    const chunkDigest = createHash("sha256").update(`chunk:${suffix}`).digest("hex");
    const manifestDigest = createHash("sha256").update(`manifest:${suffix}`).digest("hex");
    const envelopeDigest = createHash("sha256").update(`envelope:${suffix}`).digest("hex");
    const occurrenceId = Buffer.concat([Buffer.from([0]), Buffer.from(`session:synthetic:${suffix}`)]);
    const observedAtMs = Date.parse(`${DAY}T12:00:00.000Z`);
    await pool.query(`INSERT INTO ${sqlSchema}.typed_telemetry_dictionary(value)
      VALUES ('synthetic_provider') ON CONFLICT(value) DO NOTHING`);
    await pool.query(`INSERT INTO ${sqlSchema}.typed_telemetry_dictionary(value)
      VALUES ('localShell') ON CONFLICT(value) DO NOTHING`);
    const provider = await pool.query(`SELECT id FROM ${sqlSchema}.typed_telemetry_dictionary
      WHERE value='synthetic_provider'`);
    const toolClass = await pool.query(`SELECT id FROM ${sqlSchema}.typed_telemetry_dictionary
      WHERE value='localShell'`);

    if (ownerKind === "social") {
      await pool.query(`INSERT INTO ${sqlSchema}.participants(
        id, owner_kind, state, consent_version, consented_at, created_at
      ) VALUES ($1,'social','active','privacy-safe-telemetry-v0.1',$2,$2)`, [participantId, now]);
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
    } else {
      const deviceSecret = randomBytes(32);
      await pool.query(`INSERT INTO ${sqlSchema}.participants(id, owner_kind, state, created_at)
        VALUES ($1,'accountless','active',$2)`, [participantId, now]);
      await pool.query(`INSERT INTO ${sqlSchema}.accountless_enrollment_ledger(
        device_id, device_secret_hash, installation_principal_id, schema_version, policy_version,
        authorization_basis, state, issued_at, expires_at
      ) VALUES ($1,$2,$3,'accountless-enrollment-v0.1','accountless-opt-out-v1',
        'accountless-policy-v1','active',$4,$5)`, [
        deviceId, deviceSecret, `synthetic-install-${suffix}`, now, expires,
      ]);
      await pool.query(`INSERT INTO ${sqlSchema}.device_credentials(
        id, participant_id, authority_kind, accountless_enrollment_device_id, secret_hash,
        state, issued_at, expires_at, last_used_at
      ) VALUES ($1,$2,'accountless',$1,$3,'active',$4,$5,$4)`, [
        deviceId, participantId, deviceSecret, now, expires,
      ]);
      await pool.query(`INSERT INTO ${sqlSchema}.accountless_upload_owners(
        enrollment_device_id, participant_id, device_credential_id, policy_version,
        authorization_basis, authorized_at, expires_at, state
      ) VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',$3,$4,'active')`, [
        deviceId, participantId, now, expires,
      ]);
      await pool.query(`INSERT INTO ${sqlSchema}.accountless_v12_device_authorizations(
        enrollment_device_id, participant_id, device_credential_id, schema_version, policy_version,
        authorization_basis, telemetry_schema_version, field_dictionary_version, privacy_contract_version,
        authorized_at, expires_at, state
      ) VALUES ($1,$2,$1,'accountless-upload-owner-v1.2','accountless-telemetry-v1.2-policy-v1',
        'accountless-policy-v1.2','telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
        'ongoing-privacy-safe-telemetry-v1.2',$3,$4,'active')`, [
        deviceId, participantId, now, expires,
      ]);
    }
    await pool.query(`INSERT INTO ${sqlSchema}.storage_v11_owner_links(participant_id, owner_digest, state)
      VALUES ($1,$2,'active')`, [participantId, ownerDigest]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_owner_state(
      source_id, owner_digest, revision, authority_epoch, state
    ) VALUES ($1,$2,1,0,'active')`, [SOURCE_ID, ownerDigest]);

    await pool.query(`INSERT INTO ${sqlSchema}.device_upload_authorizations(
      id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes,
      content_type, state, issued_at, expires_at, consumed_at
    ) VALUES ($1,$2,$3,$4,$5,128,'application/json','consumed',$6,$7,$6)`, [
      uploadAuthorizationId, participantId, deviceId, randomBytes(32), envelopeDigest, now, expires,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.pending_objects(contribution_id, object_key, object_kind)
      VALUES ($1,$2,'telemetry_v12')`, [chunkId, r2Key]);
    const manifestJson = JSON.stringify({ schemaVersion: "telemetry-day-manifest-v1.2", day: DAY,
      chunks: [{ chunkId: chunkName, chunkDigest, recordCount: 1 }] });
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v12_day_manifests(
      id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
      manifest_json, expected_chunk_count, state, created_at
    ) VALUES ($1,$2,$3,$4::date,$5,'synthetic-graph-cohort',$6,1,'staged',$7)`, [
      manifestId, participantId, deviceId, DAY, manifestDigest, manifestJson, now,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v12_chunks(
      id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq,
      chunk_id, chunk_digest, envelope_digest, parser_version, record_count,
      r2_key, device_upload_authorization_id, created_at
    ) VALUES ($1,$2,$3,$4,'session',$5::date,0,$6,$7,$8,'synthetic-graph-cohort',1,$9,$10,$11)`, [
      chunkId, manifestId, participantId, deviceId, DAY, chunkName, chunkDigest,
      envelopeDigest, r2Key, uploadAuthorizationId, now,
    ]);
    const typedRecord = await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v12_typed_records(
      chunk_id, manifest_id, stream, record_index, occurrence_id, observed_at_ms,
      observed_day, provider_id, canonical_digest
    ) VALUES ($1,$2,'session',0,$3,$4,$5,$6,$7) RETURNING id`, [
      chunkId, manifestId, occurrenceId, observedAtMs, Math.floor(observedAtMs / 86_400_000),
      provider.rows[0].id, randomBytes(32),
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v12_typed_session_tools(record_id, tool_class_id, count)
      VALUES ($1,$2,1)`, [typedRecord.rows[0].id, toolClass.rows[0].id]);
    await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_day_manifests
      SET state='ready', ready_at=$2 WHERE id=$1`, [manifestId, now]);

    const domain = createPostgresTypedV12Domain(pool, { schema: { primarySchema: schema,
      ledgerSchema: `${schema}_ledger` } });
    const principal = { participantId, deviceId };
    const predecessor = await domain.createPredecessor(principal);
    const domainManifest = {
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
    domainManifest.manifestDigest = createHash("sha256")
      .update(telemetryV12DomainManifestDigestInput(domainManifest)).digest("hex");
    const activated = await domain.activate(principal, domainManifest);
    return { participantId, deviceId, ownerDigest, generationId: activated.generationId, expiresAt: expires };
  }

  async function retainAccountlessV12(owner, { staleHead = false, wrongTimestamp = false } = {}) {
    const head = (await pool.query(`SELECT generation_id, revision FROM ${sqlSchema}.telemetry_v12_domain_heads
      WHERE participant_id=$1`, [owner.participantId])).rows[0];
    const retainedAt = new Date(Date.now() - 60_000).toISOString();
    const revokedAt = wrongTimestamp ? new Date(Date.parse(retainedAt) + 1_000).toISOString() : retainedAt;
    await pool.query(`INSERT INTO ${sqlSchema}.accountless_public_history_retention(
      participant_id, enrollment_device_id, device_credential_id, generation_id, head_revision, retained_at
    ) VALUES ($1,$2,$2,$3,$4,$5)`, [
      owner.participantId, owner.deviceId, head.generation_id, head.revision, retainedAt,
    ]);
    await pool.query(`UPDATE ${sqlSchema}.accountless_enrollment_ledger
      SET state='revoked', revoked_at=$2, revocation_reason='user_opt_out' WHERE device_id=$1`, [owner.deviceId, revokedAt]);
    await pool.query(`UPDATE ${sqlSchema}.accountless_upload_owners
      SET state='revoked', revoked_at=$2, revocation_reason='user_opt_out' WHERE enrollment_device_id=$1`, [owner.deviceId, revokedAt]);
    await pool.query(`UPDATE ${sqlSchema}.accountless_v12_device_authorizations
      SET state='revoked', revoked_at=$2, revocation_reason='user_opt_out' WHERE enrollment_device_id=$1`, [owner.deviceId, revokedAt]);
    await pool.query(`UPDATE ${sqlSchema}.device_credentials
      SET state='revoked', revoked_at=$2 WHERE id=$1`, [owner.deviceId, revokedAt]);
    if (staleHead) {
      await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_domain_heads
        SET revision=revision+1 WHERE participant_id=$1`, [owner.participantId]);
    }
    return retainedAt;
  }

  async function seedSameDeviceV11Domain(owner) {
    const now = new Date().toISOString();
    const expires = owner.expiresAt;
    const tokenHash = randomBytes(32).toString("hex");
    const generationId = randomUUID();
    const legacyFingerprint = createHash("sha256").update(`v11:${owner.participantId}`).digest("hex");
    const manifestDigest = createHash("sha256").update(`v11-manifest:${owner.participantId}`).digest("hex");
    await pool.query(`INSERT INTO ${sqlSchema}.accountless_v11_device_authorizations(
      enrollment_device_id, participant_id, device_credential_id, telemetry_schema_version,
      field_dictionary_version, privacy_contract_version, authorized_at, expires_at, state
    ) VALUES ($1,$2,$1,'telemetry-contribution-v1.1','telemetry-v1.1-registry-2026-08-31.1',
      'ongoing-privacy-safe-telemetry-v1.1',$3,$4,'active')`, [
      owner.deviceId, owner.participantId, now, expires,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domain_predecessors(
      token_hash, participant_id, device_id, previous_generation_id, legacy_fingerprint,
      input_revision, from_day, through_day, winners_json, created_at, expires_at
    ) VALUES ($1,$2,$3,NULL,$4,0,$5::date,$5::date,'[]',$6,$7)`, [
      tokenHash, owner.participantId, owner.deviceId, legacyFingerprint, DAY, now, expires,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domains(
      id, participant_id, device_id, predecessor_token_hash, previous_generation_id,
      manifest_digest, legacy_fingerprint, input_revision, from_day, through_day, days_json, created_at
    ) VALUES ($1,$2,$3,$4,NULL,$5,$6,0,$7::date,$7::date,'[]',$8)`, [
      generationId, owner.participantId, owner.deviceId, tokenHash, manifestDigest, legacyFingerprint, DAY, now,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.telemetry_v11_domain_heads(participant_id, generation_id, revision, updated_at)
      VALUES ($1,$2,1,$3)`, [owner.participantId, generationId, now]);
  }

  async function seedAccountlessAuthorizationExpiryBoundary() {
    const now = new Date().toISOString();
    const authorizedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const participantId = `synthetic-expiring-accountless-${randomUUID()}`;
    const deviceId = randomUUID();
    await pool.query(`INSERT INTO ${sqlSchema}.participants(id, owner_kind, state, created_at)
      VALUES ($1,'accountless','active',$2)`, [participantId, now]);
    await pool.query(`INSERT INTO ${sqlSchema}.accountless_enrollment_ledger(
      device_id, device_secret_hash, installation_principal_id, schema_version, policy_version,
      authorization_basis, state, issued_at, expires_at
    ) VALUES ($1,$2,$3,'accountless-enrollment-v1','accountless-opt-out-v1',
      'accountless-policy-v1','active',$4,$5)`, [
      deviceId, randomBytes(32), `synthetic-install-${deviceId}`, authorizedAt, expiresAt,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.device_credentials(
      id, participant_id, authority_kind, accountless_enrollment_device_id, secret_hash,
      state, issued_at, expires_at, last_used_at
    ) VALUES ($1,$2,'accountless',$1,$3,'active',$4,$5,$4)`, [
      deviceId, participantId, randomBytes(32), authorizedAt, expiresAt,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.accountless_upload_owners(
      enrollment_device_id, participant_id, device_credential_id, policy_version,
      authorization_basis, authorized_at, expires_at, state
    ) VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',$3,$4,'active')`, [
      deviceId, participantId, authorizedAt, expiresAt,
    ]);
    await pool.query(`INSERT INTO ${sqlSchema}.accountless_v12_device_authorizations(
      enrollment_device_id, participant_id, device_credential_id, telemetry_schema_version,
      field_dictionary_version, privacy_contract_version, authorized_at, expires_at, state
    ) VALUES ($1,$2,$1,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
      'ongoing-privacy-safe-telemetry-v1.2',$3,$4,'active')`, [
      deviceId, participantId, authorizedAt, expiresAt,
    ]);
    return { deviceId, expiresAt };
  }

  // The v1.2 owner bridge journals each accepted head as owner-active, which
  // advances the source epoch; a caught-up cursor carries it with the sequence.
  async function catchUpCursor(sequence) {
    await pool.query(`UPDATE ${sqlSchema}.analytics_source_cursors SET sequence=$2,
      authority_epoch=(SELECT authority_epoch FROM ${sqlSchema}.storage_source_state WHERE singleton=1)
      WHERE source_id=$1`, [SOURCE_ID, sequence]);
    return Number((await pool.query(`SELECT authority_epoch::text AS epoch
      FROM ${sqlSchema}.analytics_source_cursors WHERE source_id=$1`, [SOURCE_ID])).rows[0].epoch);
  }

  async function writeModelResult(owner, sequence) {
    const payload = JSON.stringify(readyComposition(MODEL_FINGERPRINT));
    const payloadDigest = createHash("sha256").update(payload).digest("hex");
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_owner_results(
      source_id, source_namespace, observed_day, metric, owner_digest, input_revision,
      owner_revision, authority_epoch, public_authority_epoch, source_epoch, sequence,
      method, status, reason, payload_json, payload_sha256, computed_at_ms
    ) VALUES ($1,$2,$3::date,'model',$4,$5,$6,$7,0,0,$8,$9,'ready',NULL,$10,$11,$12)`, [
      SOURCE_ID, SOURCE_NAMESPACE, DAY, owner.ownerDigest, owner.inputRevision, owner.ownerRevision,
      owner.authorityEpoch, sequence, V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
      payload, payloadDigest, Date.now(),
    ]);
  }

  it("streams only source-pinned effective owners and rejects changed authority on later pages", async () => {
    const seeded = [];
    for (const suffix of ["1", "2", "3"]) seeded.push(await seedEffectiveOwner(suffix));
    await pool.query(`UPDATE ${sqlSchema}.input_versions SET revision=7 WHERE participant_id=$1`, [seeded[0].participantId]);
    const latest = await pool.query(`SELECT COALESCE(max(sequence),0)::text AS sequence
      FROM ${sqlSchema}.storage_ingestion_changes WHERE source_id=$1`, [SOURCE_ID]);
    const sourceEpoch = await catchUpCursor(latest.rows[0].sequence);
    const exactOwnerRows = await pool.query(`SELECT count(*)::int AS count
      FROM ${sqlSchema}.storage_ingestion_changes WHERE source_id=$1 AND event_tuple_version=1 AND kind='owner-active'`,
    [SOURCE_ID]);
    assert.equal(sourceEpoch, exactOwnerRows.rows[0].count,
      "each bridged owner-active advanced the source epoch once and nothing else moved it");

    const first = await listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      limit: 2, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    });
    expect(first).toMatchObject({
      available: true,
      scannedOwnerCount: 2,
      owners: [
        { ownerDigest: "1".repeat(64), sourceKind: "effective", hasV12: true },
        { ownerDigest: "2".repeat(64), sourceKind: "effective", hasV12: true },
      ],
      sourcePin: {
        sourceId: SOURCE_ID,
        sourceNamespace: SOURCE_NAMESPACE,
        sourceAuthorityEpoch: sourceEpoch,
        analyticsAuthorityEpoch: sourceEpoch,
        sequence: Number(latest.rows[0].sequence),
        policyRevision: 1,
        collectionRevision: 2,
      },
    });
    assert.ok(first.next);
    const revisions = await pool.query(`SELECT input.revision AS publisher_revision,
        analytical.revision AS analytical_revision
      FROM ${sqlSchema}.input_versions input
      JOIN ${sqlSchema}.community_analytical_input_versions analytical USING (participant_id)
      WHERE input.participant_id=$1`, [seeded[0].participantId]);
    assert.equal(first.owners[0].inputRevision, Number(revisions.rows[0].publisher_revision));
    assert.equal(first.owners[0].ownerPin.inputRevision, Number(revisions.rows[0].analytical_revision));
    assert.equal(first.owners[0].inputRevision, 7,
      "publisher cache revision is read separately from the effective owner pin");
    assert.equal(first.owners[0].ownerPin.v12GenerationId, seeded[0].generationId);
    assert.equal(first.owners[0].ownerPin.sourceNamespace, SOURCE_NAMESPACE);

    const second = await listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      after: first.next, limit: 2, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    });
    expect(second).toMatchObject({ scannedOwnerCount: 1, owners: [{ ownerDigest: "3".repeat(64) }], next: null });
    assert.equal(first.owners.length + second.owners.length, 3,
      "the page size bounds each query, not the total cohort");

    const initialOwners = [...first.owners, ...second.owners];
    for (const owner of initialOwners) await writeModelResult(owner, first.sourcePin.sequence);
    const publicationMembers = (owners) => owners.map((owner) => ({
      participantId: owner.participantId,
      ownerDigest: owner.ownerDigest,
      inputRevision: owner.inputRevision,
      ownerRevision: owner.ownerRevision,
      authorityEpoch: owner.authorityEpoch,
      sourceKind: owner.sourceKind,
      inputFingerprint: MODEL_FINGERPRINT,
    }));
    await pool.query(`UPDATE ${sqlSchema}.collection_controls
      SET revision=revision+1, updated_at=clock_timestamp() WHERE singleton=1`);
    expect(await publishPostgresCommunityModelDay(pool, {
      sourcePin: first.sourcePin,
      members: publicationMembers(initialOwners), day: DAY,
      schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    })).toMatchObject({ state: "deferred", reason: "source_changed", memberCount: 3 });

    const currentFirst = await listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      limit: 2, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    });
    const currentSecond = await listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      after: currentFirst.next, limit: 2, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    });
    const currentOwners = [...currentFirst.owners, ...currentSecond.owners];
    expect(currentFirst.sourcePin.collectionRevision).toBe(first.sourcePin.collectionRevision + 1);
    const constrainedPool = new pg.Pool({
      ...await localSocket(),
      user: process.env.PG_TEST_USER || "postgres",
      password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
      database: process.env.PG_TEST_DATABASE || "postgres",
      application_name: "pg-community-graph-cohort-single-connection",
      ssl: false,
      max: 1,
      connectionTimeoutMillis: 2_000,
    });
    let concurrentPublications;
    try {
      const publish = () => publishPostgresCommunityModelDayFromCohort(constrainedPool, {
        sourceId: SOURCE_ID,
        sourceNamespace: SOURCE_NAMESPACE,
        limit: 2,
        day: DAY,
        schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
      });
      concurrentPublications = await Promise.all([publish(), publish()]);
    } finally {
      await constrainedPool.end();
    }
    expect(concurrentPublications.map((result) => result.state).sort()).toEqual(["published", "unchanged"]);
    expect(concurrentPublications.map((result) => result.memberCount)).toEqual([3, 3]);

    const readQueries = [];
    const measuredReadPool = {
      async connect() {
        const client = await pool.connect();
        return {
          query(sql, values) {
            readQueries.push(sql);
            return client.query(sql, values);
          },
          release(discard) { return client.release(discard); },
        };
      },
    };
    expect(await readPostgresCommunityModelDay(measuredReadPool, {
      sourceId: SOURCE_ID,
      sourceNamespace: SOURCE_NAMESPACE,
      day: DAY,
      schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    })).toMatchObject({ day: DAY, fittedParticipantCount: 3, values: [["gpt-6-astra", 1000, 3]] });
    const memberReadbackPages = readQueries.filter((sql) =>
      sql.includes("FROM ") && sql.includes(".analytics_publication_owner_members member")
        && sql.includes("member.owner_digest > $4::text"));
    expect(memberReadbackPages).toHaveLength(1);
    expect(memberReadbackPages[0]).toContain("WITH page AS MATERIALIZED");
    expect(memberReadbackPages[0]).toContain("ORDER BY member.owner_digest");
    expect(memberReadbackPages[0]).toContain("LIMIT $5::integer");
    expect(memberReadbackPages[0]).toContain("LEFT JOIN LATERAL");
    expect(memberReadbackPages[0]).not.toContain('COLLATE "C"');

    const restart = await listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      limit: 1, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    });
    assert.ok(restart.next);
    await pool.query(`UPDATE ${sqlSchema}.collection_controls
      SET revision=revision+1, updated_at=clock_timestamp() WHERE singleton=1`);
    await expect(listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      after: restart.next, limit: 1, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    })).rejects.toMatchObject({
      code: "POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED",
    });

    await expect(listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: `${SOURCE_NAMESPACE}-missing-receipts`,
      schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    })).rejects.toMatchObject({ code: "POSTGRES_COMMUNITY_GRAPH_COHORT_UNAVAILABLE" });

    // A journal row that moves only the sequence, not the source authority
    // epoch, must still end a continuation. The v1.2 owner bridge journals
    // the cohort owners, so a raw version-0 row for them is refused
    // (storage_owner_tuple_mixed); the epoch-neutral exact row is a
    // 'source-updated' through the single producer, which needs an active
    // owner head. The bridge gives seeded[0] one once 0055 is applied; before
    // that, append its owner-active here and catch the cursor up to it.
    const ownerHead = await pool.query(`SELECT state FROM ${sqlSchema}.storage_owner_revisions
      WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, seeded[0].ownerDigest]);
    if (ownerHead.rows.length === 0) {
      await pool.query(`SELECT ${sqlSchema}.storage_journal_append('owner-active',$1,$2,$2,$2)`,
        [seeded[0].ownerDigest, createHash("sha256").update("graph-cohort-owner-active").digest("hex")]);
    } else {
      assert.equal(ownerHead.rows[0].state, "active");
    }
    const scanStart = await pool.query(`SELECT COALESCE(max(sequence),0)::text AS sequence
      FROM ${sqlSchema}.storage_ingestion_changes WHERE source_id=$1`, [SOURCE_ID]);
    const scanEpoch = await catchUpCursor(scanStart.rows[0].sequence);
    const newAuthorityScan = await listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      limit: 1, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    });
    assert.ok(newAuthorityScan.next);
    await pool.query(`SELECT ${sqlSchema}.storage_journal_append('source-updated',$1,$2,$2,$2)`,
      [seeded[0].ownerDigest, "e".repeat(64)]);
    const appended = await pool.query(`SELECT max(sequence)::text AS sequence
      FROM ${sqlSchema}.storage_ingestion_changes WHERE source_id=$1`, [SOURCE_ID]);
    assert.equal(Number(appended.rows[0].sequence), Number(scanStart.rows[0].sequence) + 1);
    const epochAfter = await pool.query(`SELECT authority_epoch::text AS epoch
      FROM ${sqlSchema}.storage_source_state WHERE singleton=1`);
    assert.equal(Number(epochAfter.rows[0].epoch), scanEpoch, "the new row moves the sequence only");
    await expect(listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      after: newAuthorityScan.next, limit: 1, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    })).rejects.toMatchObject({ code: "POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED" });
  }, 120_000);

  it("rejects a continuation after either v1.2 runtime state changes", async () => {
    for (const suffix of ["4", "5"]) await seedEffectiveOwner(suffix);
    const latest = await pool.query(`SELECT COALESCE(max(sequence),0)::text AS sequence
      FROM ${sqlSchema}.storage_ingestion_changes WHERE source_id=$1`, [SOURCE_ID]);
    await catchUpCursor(latest.rows[0].sequence);
    const first = await listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      limit: 1, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    });
    assert.ok(first.next);
    await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_runtime SET state='staged' WHERE id=1`);
    await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_typed_runtime SET state='staged' WHERE id=1`);
    await expect(listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      after: first.next, limit: 1, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    })).rejects.toMatchObject({ code: "POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED" });
  }, 120_000);

  it("uses the 0046 v1.2 source gate for active and retained owners", async () => {
    const active = await seedEffectiveOwner("8", { ownerKind: "accountless" });
    const retained = await seedEffectiveOwner("9", { ownerKind: "accountless" });
    await retainAccountlessV12(retained);

    const v11Wins = await seedEffectiveOwner("a", { ownerKind: "accountless" });
    await seedSameDeviceV11Domain(v11Wins);

    const wrongMarker = await seedEffectiveOwner("b", { ownerKind: "accountless" });
    await retainAccountlessV12(wrongMarker, { wrongTimestamp: true });
    const staleMarker = await seedEffectiveOwner("c", { ownerKind: "accountless" });
    await retainAccountlessV12(staleMarker, { staleHead: true });

    const erased = await seedEffectiveOwner("d", { ownerKind: "accountless" });
    await pool.query(`UPDATE ${sqlSchema}.storage_v11_owner_links SET state='erased' WHERE participant_id=$1`,
      [erased.participantId]);

    const publicSourceFor = async (owner) => (await pool.query(`SELECT owner_kind,device_id
      FROM ${sqlSchema}.community_public_source_owners WHERE participant_id=$1`, [owner.participantId])).rows;
    expect(await publicSourceFor(v11Wins)).toEqual([{ owner_kind: "accountless", device_id: v11Wins.deviceId }],
      "the source view assigns a mixed device to its active v1.1 branch");
    expect(await publicSourceFor(wrongMarker)).toEqual([], "a retention marker with a different timestamp is not eligible");
    expect(await publicSourceFor(staleMarker)).toEqual([], "a marker for an older head revision is not eligible");
    expect((await pool.query(`SELECT owner_digest FROM ${sqlSchema}.storage_owner_erasure_receipts
      WHERE owner_digest=$1`, [erased.ownerDigest])).rows).toEqual([{ owner_digest: erased.ownerDigest }]);

    const latest = await pool.query(`SELECT COALESCE(max(sequence),0)::text AS sequence
      FROM ${sqlSchema}.storage_ingestion_changes WHERE source_id=$1`, [SOURCE_ID]);
    await catchUpCursor(latest.rows[0].sequence);
    const page = await listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      limit: 20, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    });
    expect(page.owners.map((owner) => owner.ownerDigest).sort()).toEqual(
      [active.ownerDigest, retained.ownerDigest].sort(),
      "only the active and exactly retained v1.2 heads enter the graph cohort",
    );
    expect(page.owners.every((owner) => owner.hasV12)).toBe(true);
  }, 120_000);

  it("pins accountless authorization expiry across pages and at publication", async () => {
    for (const suffix of ["6", "7"]) await seedEffectiveOwner(suffix);
    const auth = await seedAccountlessAuthorizationExpiryBoundary();
    const latest = await pool.query(`SELECT COALESCE(max(sequence),0)::text AS sequence
      FROM ${sqlSchema}.storage_ingestion_changes WHERE source_id=$1`, [SOURCE_ID]);
    await catchUpCursor(latest.rows[0].sequence);

    const first = await listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      limit: 1, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    });
    expect(first.sourcePin).toMatchObject({ accountlessAuthorizationCount: 1 });
    assert.ok(first.sourcePin.nextAccountlessAuthorizationExpiry);
    assert.ok(first.next);
    const second = await listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      after: first.next, limit: 1, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    });
    const allOwners = [...first.owners, ...second.owners];
    for (const owner of allOwners) await writeModelResult(owner, first.sourcePin.sequence);
    const publisherMembers = allOwners.map((owner) => ({
      participantId: owner.participantId,
      ownerDigest: owner.ownerDigest,
      inputRevision: owner.inputRevision,
      ownerRevision: owner.ownerRevision,
      authorityEpoch: owner.authorityEpoch,
      sourceKind: owner.sourceKind,
      inputFingerprint: MODEL_FINGERPRINT,
    }));

    const expired = new Date(Date.now() - 1_000).toISOString();
    await pool.query(`UPDATE ${sqlSchema}.accountless_v12_device_authorizations
      SET expires_at=$2 WHERE enrollment_device_id=$1`, [auth.deviceId, expired]);
    await expect(listPostgresCommunityGraphCohortPage(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE,
      after: first.next, limit: 1, schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    })).rejects.toMatchObject({ code: "POSTGRES_COMMUNITY_GRAPH_COHORT_SOURCE_CHANGED" });
    expect(await publishPostgresCommunityModelDay(pool, {
      sourcePin: first.sourcePin, members: publisherMembers, day: DAY,
      schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` },
    })).toMatchObject({ state: "deferred", reason: "source_changed", memberCount: 2 });
  }, 120_000);
});
