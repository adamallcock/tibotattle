import { expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { projectionTables, resetProjectionState } from './projection-fixtures.mjs';
import { ApiError } from '../src/errors.ts';
import { eraseParticipantWithStore } from '../src/participant-erasure-store.ts';
import { createPostgresParticipantErasureStores } from '../src/postgres-participant-erasure-canonical.ts';

const DEFAULT_SCHEMA = 'tibotattle_v1_test';
const DEFAULT_LEDGER_SCHEMA = 'tibotattle_erasure_ledger_test';
// The operational migrations only contain the canonical transport journals.
// v1 is seeded twice so this fixture retains the four-object paging contract
// without resurrecting the retired contributions/chunks tables.
const SOURCES = ['telemetry_v1', 'telemetry_v1', 'telemetry_v11', 'telemetry_v12'];
const ALL_TABLES = [...projectionTables,
  'accountless_upload_owners', 'admin_action_audit', 'web_sessions',
  'device_upload_authorizations', 'device_credentials', 'device_pairings',
  'telemetry_v1_chunks', 'telemetry_v1_records', 'telemetry_v1_device_consents',
  'telemetry_v1_chunk_admission_windows', 'telemetry_v11_chunks',
  'telemetry_v11_records', 'telemetry_v11_day_manifests', 'telemetry_v11_device_consents',
  'telemetry_v11_domain_heads', 'telemetry_v11_domain_days', 'telemetry_v11_domains',
  'telemetry_v11_domain_predecessors', 'telemetry_v12_chunks', 'telemetry_v12_records',
  'telemetry_v12_day_manifests', 'telemetry_v12_device_capabilities',
  'telemetry_v12_domain_heads', 'telemetry_v12_domain_days', 'telemetry_v12_domains',
  'telemetry_v12_domain_predecessors', 'accountless_v11_device_authorizations',
  'accountless_v12_device_authorizations', 'telemetry_transport_participant_floors',
  'telemetry_transport_device_floors', 'telemetry_transport_floor_rollbacks',
  'pending_objects', 'storage_v11_owner_links', 'analytics_owner_state',
  'analytics_prepared_source_heads', 'analytics_prepared_source_rows',
  'analytics_analysis_work_heads', 'analytics_analysis_work_parts',
  'analytics_publication_owner_members', 'analytics_publication_invalidations',
  'analytics_publication_captures', 'analytics_publications', 'storage_ingestion_changes',
  'analytics_applied_events', 'analytics_source_cursors', 'participants'];
const PRESERVE_SINGLETONS = new Set([
  'mutation_control', 'publication_state', 'current_queue_state', 'preparation_counters',
]);

function resolve(value) {
  return typeof value === 'function' ? value() : value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new TypeError(`${label} must be a simple SQL identifier`);
  }
  return value;
}

function fixedNow() {
  return Date.parse('2026-09-15T12:00:00.000Z');
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function canonicalDevice(participantId) {
  return `${participantId}-device`;
}

async function existingTables(pool, schema) {
  const result = await pool.query(
    `SELECT tablename FROM pg_catalog.pg_tables
      WHERE schemaname=$1 AND tablename=ANY($2::text[])`,
    [schema, ALL_TABLES],
  );
  const names = new Set(result.rows.map((row) => row.tablename));
  return ALL_TABLES.filter((table) => names.has(table) && !PRESERVE_SINGLETONS.has(table));
}

async function seedParticipant(pool, schema, participantId) {
  const issued = new Date(fixedNow() - 86_400_000);
  const expires = new Date(fixedNow() + 86_400_000);
  const deviceId = canonicalDevice(participantId);
  const secret = Buffer.alloc(32, 1);
  await pool.query(`INSERT INTO ${schema}.participants
    (id,state,owner_kind,consent_version,consented_at,created_at)
    VALUES($1,'active','social','ongoing-privacy-safe-telemetry-v1.0',$2,$2)`, [participantId, issued]);
  await pool.query(`INSERT INTO ${schema}.web_sessions
    (id,participant_id,secret_hash,csrf_hash,scope,state,issued_at,expires_at,last_used_at)
    VALUES($1,$2,$3,$4,'personal','active',$5,$6,$5)`,
  [`session-${participantId}`, participantId, secret, Buffer.alloc(32, 2), issued, expires]);
  await pool.query(`INSERT INTO ${schema}.device_pairings
    (id,participant_id,issued_by_session_id,secret_hash,consent_version,
     transport_consent_version,state,issued_at,expires_at,claimed_device_id)
    VALUES($1,$2,$3,$4,'ongoing-privacy-safe-telemetry-v1.0',
      'telemetry-contribution-v1.0','consumed',$5,$6,$7)`,
  [`pairing-${participantId}`, participantId, `session-${participantId}`, Buffer.alloc(32, 3), issued, expires, deviceId]);
  await pool.query(`INSERT INTO ${schema}.device_credentials
    (id,participant_id,authority_kind,paired_via_pairing_id,secret_hash,state,
     issued_at,expires_at,last_used_at,social_verified_at)
    VALUES($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`,
  [deviceId, participantId, `pairing-${participantId}`, secret, issued, expires]);
  await pool.query(`INSERT INTO ${schema}.telemetry_transport_participant_floors
    (participant_id,minimum_rank,revision,changed_at) VALUES($1,1,0,$2)`, [participantId, issued]);
  await pool.query(`INSERT INTO ${schema}.telemetry_v1_device_consents
    (participant_id,device_id,telemetry_schema_version,field_dictionary_version,
     privacy_contract_version,consented_at)
    VALUES($1,$2,'telemetry-contribution-v1.0',
      'telemetry-v1.0-registry-2026-08-07.1',
      'ongoing-privacy-safe-telemetry-v1.0',$3)`, [participantId, deviceId, issued]);
  const ownerDigest = digest(`owner:${participantId}`);
  await pool.query(`INSERT INTO ${schema}.storage_v11_owner_links
    (participant_id,owner_digest,state,generation_id,head_revision,object_digest,manifest_digest)
    VALUES($1,$2,'active','owner-generation-1',1,$2,$2)`, [participantId, ownerDigest]);
  await pool.query(`INSERT INTO ${schema}.storage_source_state(singleton,source_id,authority_epoch)
    VALUES(1,'canonical-erasure-test-source',1)
    ON CONFLICT(singleton) DO NOTHING`);
  await pool.query(`INSERT INTO ${schema}.analytics_owner_state
    (source_id,owner_digest,revision,authority_epoch,state)
    SELECT source_id,$1,1,authority_epoch,'active'
      FROM ${schema}.storage_source_state WHERE singleton=1
    ON CONFLICT(source_id,owner_digest) DO NOTHING`, [ownerDigest]);
}

async function seedUploadAuthorization(pool, schema, participantId, index, source) {
  const deviceId = canonicalDevice(participantId);
  const issued = new Date(fixedNow() - 86_400_000);
  const expires = new Date(fixedNow() + 86_400_000);
  const id = `erasure-auth-${source}-${index}-${randomUUID()}`;
  await pool.query(`INSERT INTO ${schema}.device_upload_authorizations
    (id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,
     content_type,state,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5,1,'application/json','consumed',$6,$7)`,
  [id, participantId, deviceId, Buffer.alloc(32, 4), digest(id), issued, expires]);
  return id;
}

async function seedObject(pool, schema, source, participantId, index) {
  const id = `${source}-${index}-${randomUUID()}`;
  const createdAt = new Date(fixedNow() + index).toISOString();
  const deviceId = canonicalDevice(participantId);
  const objectKey = `quarantine/${participantId}/${id}`;
  const authorizationId = await seedUploadAuthorization(pool, schema, participantId, index, source);
  const chunkDigest = digest(`chunk:${id}`);
  const envelopeDigest = digest(`envelope:${id}`);
  await pool.query(`INSERT INTO ${schema}.pending_objects
    (contribution_id,object_key,object_kind,registered_at,reconciliation_state)
    VALUES($1,$2,$3,$4,'registered')`, [id, objectKey, source, createdAt]);
  if (source === 'telemetry_v1') {
    await pool.query(`INSERT INTO ${schema}.telemetry_v1_chunks
      (id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,
       envelope_digest,parser_version,record_count,accepted_record_count,r2_key,
       device_upload_authorization_id,created_at)
      VALUES($1,$2,$3,'session',$4,$5,1,$6,$7,'erasure-fixture',1,1,$8,$9,$10)`,
    [id, participantId, deviceId, '2026-09-15', index, chunkDigest, envelopeDigest,
      objectKey, authorizationId, createdAt]);
  } else if (source === 'telemetry_v11') {
    const manifestId = randomUUID();
    await pool.query(`INSERT INTO ${schema}.telemetry_v11_day_manifests
      (id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,
       expected_chunk_count,state,created_at,ready_at)
      VALUES($1,$2,$3,'2026-09-15',$4,'erasure-fixture','{}',1,'ready',$5,$5)`,
    [manifestId, participantId, deviceId, digest(`manifest:${id}`), createdAt]);
    await pool.query(`INSERT INTO ${schema}.telemetry_v11_chunks
      (id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,
       chunk_digest,envelope_digest,parser_version,record_count,r2_key,
       device_upload_authorization_id,created_at)
      VALUES($1,$2,$3,$4,'session','2026-09-15',$5,$1,$6,$7,'erasure-fixture',1,$8,$9,$10)`,
    [id, manifestId, participantId, deviceId, index, chunkDigest, envelopeDigest,
      objectKey, authorizationId, createdAt]);
  } else {
    const manifestId = randomUUID();
    await pool.query(`INSERT INTO ${schema}.telemetry_v12_day_manifests
      (id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,
       expected_chunk_count,state,created_at,ready_at)
      VALUES($1,$2,$3,'2026-09-15',$4,'erasure-fixture','{}',1,'ready',$5,$5)`,
    [manifestId, participantId, deviceId, digest(`manifest:${id}`), createdAt]);
    await pool.query(`INSERT INTO ${schema}.telemetry_v12_chunks
      (id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,
       chunk_digest,envelope_digest,parser_version,record_count,r2_key,
       device_upload_authorization_id,created_at)
      VALUES($1,$2,$3,$4,'session','2026-09-15',$5,$1,$6,$7,'erasure-fixture',1,$8,$9,$10)`,
    [id, manifestId, participantId, deviceId, index, chunkDigest, envelopeDigest,
      objectKey, authorizationId, createdAt]);
  }
  return { id, key: objectKey, createdAt, source, version: null };
}

async function countRows(pool, schema, table, participantId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM ${schema}.${table} WHERE participant_id=$1`,
    [participantId],
  );
  return Number(result.rows[0].count);
}

async function tombstoneRows(pool, schema) {
  return (await pool.query(`SELECT * FROM ${schema}.deletion_tombstones`)).rows;
}

async function resetFixture(primary, ledger, schema, ledgerSchema, participantId) {
  const names = await existingTables(primary, schema);
  if (names.length !== 0) {
    await primary.query(`TRUNCATE ${names.map((table) => `${schema}.${table}`).join(', ')} CASCADE`);
  }
  await resetProjectionState(primary, schema);
  await ledger.query(`TRUNCATE ${ledgerSchema}.deletion_tombstones`);
  await seedParticipant(primary, schema, participantId);
}

/** Reset the canonical v1 lifecycle slice for a caller-owned test. */
export async function resetParticipantErasureFixture({
  primaryPool: primaryPoolValue,
  ledgerPool: ledgerPoolValue,
  schema: schemaValue = DEFAULT_SCHEMA,
  ledgerSchema: ledgerSchemaValue = DEFAULT_LEDGER_SCHEMA,
  participantId = 'synthetic-erasure-participant',
}) {
  const schema = identifier(schemaValue, 'schema');
  const ledgerSchema = identifier(ledgerSchemaValue, 'ledgerSchema');
  await resetFixture(resolve(primaryPoolValue), resolve(ledgerPoolValue), schema, ledgerSchema, participantId);
}

/** Register real PostgreSQL erasure qualification tests against canonical tables. */
export function registerParticipantErasureTests({
  primaryPool: primaryPoolValue,
  ledgerPool: ledgerPoolValue,
  schema: schemaValue = DEFAULT_SCHEMA,
  ledgerSchema: ledgerSchemaValue = DEFAULT_LEDGER_SCHEMA,
  participantId = 'synthetic-erasure-participant',
}) {
  const schema = identifier(schemaValue, 'schema');
  const ledgerSchema = identifier(ledgerSchemaValue, 'ledgerSchema');
  const primaryPool = () => resolve(primaryPoolValue);
  const ledgerPool = () => resolve(ledgerPoolValue);
  const stores = () => createPostgresParticipantErasureStores(
    primaryPool(),
    ledgerPool(),
    { schemaOptions: { primarySchema: schema, ledgerSchema } },
  );

  it('writes the independent tombstone before bounded object deletion and finalizes fenced rows', async () => {
    const primary = primaryPool();
    await resetFixture(primary, ledgerPool(), schema, ledgerSchema, participantId);
    const seeded = [];
    for (const [index, source] of SOURCES.entries()) {
      seeded.push(await seedObject(primary, schema, source, participantId, index));
    }
    await primary.query(`INSERT INTO ${schema}.web_sessions(id,participant_id,secret_hash,csrf_hash,state,issued_at,expires_at,last_used_at)
      VALUES($1,$2,$3,$4,'active',$5,$6,$5)`,
    ['session-extra', participantId, Buffer.alloc(32, 5), Buffer.alloc(32, 6), new Date(fixedNow()), new Date(fixedNow() + 86_400_000)]);

    const order = [];
    const objectStore = {
      async deleteBatch(objects) {
        order.push(objects.map((object) => ({ key: object.key, version: object.version })));
        expect(await tombstoneRows(ledgerPool(), ledgerSchema)).toHaveLength(1);
        const state = await primary.query(`SELECT state,deletion_session_id FROM ${schema}.participants WHERE id=$1`, [participantId]);
        expect(state.rows[0]).toMatchObject({ state: 'deleting' });
      },
    };
    const result = await eraseParticipantWithStore({
      ...stores(), objects: objectStore,
      hooks: {
        async revokeAccountlessEnrollment() {},
        async assertIdentityConfiguration() {},
        async recordIdentityCooldown() {},
      },
    }, participantId, randomUUID(), fixedNow());
    expect(result).toMatchObject({ deleted: true, alreadyDeleted: false, contributionsDeleted: 4 });
    expect(order.flat()).toHaveLength(4);
    expect(order.flat()).toEqual(seeded.map((row) => ({ key: row.key, version: null })));
    expect(await primary.query(`SELECT 1 FROM ${schema}.participants WHERE id=$1`, [participantId])).toMatchObject({ rowCount: 0 });
    expect(await tombstoneRows(ledgerPool(), ledgerSchema)).toHaveLength(1);
  });

  it('keeps primary rows and never invokes object deletion when the independent ledger is unavailable', async () => {
    const primary = primaryPool();
    await resetFixture(primary, ledgerPool(), schema, ledgerSchema, participantId);
    await seedObject(primary, schema, 'telemetry_v1', participantId, 0);
    let deletes = 0;
    await expect(eraseParticipantWithStore({
      ...stores(),
      ledger: {
        async hasTombstone() { return false; },
        async recordTombstone() { throw new ApiError(503, 'DELETION_LEDGER_UNAVAILABLE'); },
      },
      objects: { async deleteBatch() { deletes += 1; } },
      hooks: {
        async revokeAccountlessEnrollment() {},
        async assertIdentityConfiguration() {},
        async recordIdentityCooldown() {},
      },
    }, participantId, randomUUID(), fixedNow())).rejects.toMatchObject({ status: 503 });
    expect(deletes).toBe(0);
    expect(await primary.query(`SELECT state FROM ${schema}.participants WHERE id=$1`, [participantId])).toMatchObject({ rows: [{ state: 'deleting' }] });
    expect(await countRows(primary, schema, 'telemetry_v1_chunks', participantId)).toBe(1);
  });

  it('bounds pages at one hundred and carries canonical null provider versions through the neutral contract', async () => {
    const primary = primaryPool();
    await resetFixture(primary, ledgerPool(), schema, ledgerSchema, participantId);
    for (let index = 0; index < 101; index += 1) {
      await seedObject(primary, schema, 'telemetry_v1', participantId, index);
    }
    const batches = [];
    const result = await eraseParticipantWithStore({
      ...stores(),
      objects: { async deleteBatch(objects) { batches.push(objects); } },
      hooks: {
        async revokeAccountlessEnrollment() {},
        async assertIdentityConfiguration() {},
        async recordIdentityCooldown() {},
      },
    }, participantId, randomUUID(), fixedNow());
    expect(result.contributionsDeleted).toBe(101);
    expect(batches.map((batch) => batch.length)).toEqual([100, 1]);
    expect(batches[0][0]).toMatchObject({ version: null });
  });

  it('detects a concurrent canonical source-row arrival after object deletion and keeps the deletion fence', async () => {
    const primary = primaryPool();
    await resetFixture(primary, ledgerPool(), schema, ledgerSchema, participantId);
    await seedObject(primary, schema, 'telemetry_v1', participantId, 0);
    let injected = false;
    await expect(eraseParticipantWithStore({
      ...stores(),
      objects: {
        async deleteBatch() {
          if (!injected) {
            injected = true;
            await seedObject(primary, schema, 'telemetry_v1', participantId, 99);
          }
        },
      },
      hooks: {
        async revokeAccountlessEnrollment() {},
        async assertIdentityConfiguration() {},
        async recordIdentityCooldown() {},
      },
    }, participantId, randomUUID(), fixedNow())).rejects.toMatchObject({ code: 'UPLOAD_IN_PROGRESS' });
    expect(await primary.query(`SELECT state FROM ${schema}.participants WHERE id=$1`, [participantId])).toMatchObject({ rows: [{ state: 'deleting' }] });
  });
}
