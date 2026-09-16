import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { projectionTables, resetProjectionState } from './projection-fixtures.mjs';
import { ApiError } from '../src/errors.ts';
import { eraseParticipantWithStore } from '../src/participant-erasure-store.ts';
import { createExperimentalPostgresParticipantErasureStores } from '../src/postgres-participant-erasure-store.ts';

const DEFAULT_SCHEMA = 'tibotattle_v1_test';
const DEFAULT_LEDGER_SCHEMA = 'tibotattle_erasure_ledger_test';
const SOURCES = ['contributions', 'telemetry_contributions', 'chunks', 'telemetry_v11_chunks'];
const ALL_TABLES = [...projectionTables,
  'device_upload_authorizations', 'device_credentials',
  'device_pairings', 'web_sessions', 'accountless_upload_owners',
  'telemetry_v11_chunks', 'telemetry_contributions', 'contributions',
  'pending_objects', 'input_versions', 'admission_windows', 'records', 'chunks',
  'authorizations', 'consents', 'devices', 'admin_action_audit', 'participants',
  'legacy_sources', 'v11_domain_heads', 'mutation_control', 'graph_scope',
  'publication_state', 'preview_cache', 'daily_rebuilds', 'current_queue_state',
  'current_queue', 'refresh_lanes', 'prepared_source_days', 'preparation_counters',
  'community_model_history_dependencies', 'community_model_composition_days',
];

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

async function seedParticipant(pool, schema, participantId) {
  await pool.query(`INSERT INTO ${schema}.participants(id,state,owner_kind,identity_link_key)
    VALUES($1,'active','social',NULL)`, [participantId]);
  await pool.query(`INSERT INTO ${schema}.devices(id,participant_id,state,issued_at,expires_at)
    VALUES($1,$2,'active',$3,$4)`, [
    `${participantId}-device`, participantId,
    new Date(fixedNow() - 86_400_000), new Date(fixedNow() + 86_400_000),
  ]);
  await pool.query(`INSERT INTO ${schema}.consents(participant_id,device_id,schema_version,dictionary_version,privacy_version)
    VALUES($1,$2,'telemetry-contribution-v1.0','synthetic','synthetic')`, [participantId, `${participantId}-device`]);
}

async function seedObject(pool, schema, source, participantId, index, version = null) {
  const id = `${source}-${index}-${randomUUID()}`;
  const createdAt = new Date(fixedNow() + index).toISOString();
  if (source === 'chunks') {
    const deviceId = `${participantId}-device`;
    const authorizationId = `${id}-authorization`;
    const digest = `${String(index + 1).padStart(64, '0')}`;
    await pool.query(`INSERT INTO ${schema}.authorizations
      (id,participant_id,device_id,envelope_digest,state,lease_expires_at,expires_at)
      VALUES($1,$2,$3,$4,'consumed',NULL,$5)`, [
      authorizationId, participantId, deviceId, digest, new Date(fixedNow() + 86_400_000),
    ]);
    await pool.query(`INSERT INTO ${schema}.chunks
      (id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,envelope_digest,
       parser_version,record_count,accepted_record_count,object_key,authorization_id,created_at,object_version)
      VALUES($1,$2,$3,'session',$4,$5,1,$6,$7,'erasure-fixture',1,1,$8,$9,$10,$11)`, [
      id, participantId, deviceId, `2026-09-${String((index % 9) + 1).padStart(2, '0')}`,
      index, digest, digest, `quarantine/${participantId}/${id}`, authorizationId, createdAt, version,
    ]);
    await pool.query(`INSERT INTO ${schema}.records
      (chunk_id,participant_id,device_id,stream,occurrence_id,observed_at,payload,observed_day)
      VALUES($1,$2,$3,'session',$4,$5,'{}'::jsonb,$6)`, [
      id, participantId, deviceId, `${id}-occurrence`, createdAt,
      `2026-09-${String((index % 9) + 1).padStart(2, '0')}`,
    ]);
    return { id, key: `quarantine/${participantId}/${id}`, createdAt, source, version };
  }
  await pool.query(`INSERT INTO ${schema}.${source}
    (id,participant_id,r2_key,object_version,created_at)
    VALUES($1,$2,$3,$4,$5)`, [id, participantId, `quarantine/${participantId}/${id}`, version, createdAt]);
  return { id, key: `quarantine/${participantId}/${id}`, createdAt, source, version };
}

async function countRows(pool, schema, table, participantId) {
  const result = await pool.query(`SELECT COUNT(*)::int AS count FROM ${schema}.${table} WHERE participant_id=$1`, [participantId]);
  return Number(result.rows[0].count);
}

async function tombstoneRows(pool, schema) {
  return (await pool.query(`SELECT * FROM ${schema}.deletion_tombstones`)).rows;
}

async function resetFixture(primary, ledger, schema, ledgerSchema, participantId) {
  await primary.query(`TRUNCATE ${ALL_TABLES.map(table => `${schema}.${table}`).join(', ')} CASCADE`);
  await resetProjectionState(primary,schema);
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
  await resetFixture(
    resolve(primaryPoolValue), resolve(ledgerPoolValue), schema, ledgerSchema, participantId,
  );
}

/**
 * Register real PostgreSQL erasure qualification tests. The caller owns both
 * disposable database lifecycles and loads erasure.sql into each database;
 * this helper never connects to a configured or production endpoint.
 */
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
  const stores = () => createExperimentalPostgresParticipantErasureStores(
    primaryPool(),
    ledgerPool(),
    { primarySchema: schema, ledgerSchema },
  );

  it('writes the independent tombstone before bounded object deletion and finalizes fenced rows', async () => {
    const primary = primaryPool();
    await resetFixture(primary, ledgerPool(), schema, ledgerSchema, participantId);
    const seeded = [];
    for (const source of SOURCES) seeded.push(await seedObject(primary, schema, source, participantId, 0, 'generation-1'));
    await primary.query(`INSERT INTO ${schema}.web_sessions(id,participant_id,state)
      VALUES($1,$2,'active')`, ['session-1', participantId]);

    const order = [];
    const objectStore = {
      async deleteBatch(objects) {
        order.push(objects.map(object => ({ key: object.key, version: object.version })));
        expect((await tombstoneRows(ledgerPool(), ledgerSchema))).toHaveLength(1);
        const state = await primary.query(`SELECT state,deletion_session_id FROM ${schema}.participants WHERE id=$1`, [participantId]);
        expect(state.rows[0]).toMatchObject({ state: 'deleting' });
      },
    };
    const storesValue = stores();
    const result = await eraseParticipantWithStore({
      primary: storesValue.primary,
      ledger: storesValue.ledger,
      objects: objectStore,
      hooks: {
        async revokeAccountlessEnrollment() {},
        async assertIdentityConfiguration() {},
        async recordIdentityCooldown() {},
      },
    }, participantId, randomUUID(), fixedNow());

    expect(result).toMatchObject({ deleted: true, alreadyDeleted: false, contributionsDeleted: 4 });
    expect(order.flat()).toHaveLength(4);
    expect(order.flat()).toEqual(seeded.map(row => ({ key: row.key, version: 'generation-1' })));
    expect(await primary.query(`SELECT 1 FROM ${schema}.participants WHERE id=$1`, [participantId])).toMatchObject({ rowCount: 0 });
    expect(await tombstoneRows(ledgerPool(), ledgerSchema)).toHaveLength(1);
  });

  it('keeps primary rows and never invokes object deletion when the independent ledger is unavailable', async () => {
    const primary = primaryPool();
    await resetFixture(primary, ledgerPool(), schema, ledgerSchema, participantId);
    await seedObject(primary, schema, 'chunks', participantId, 0);
    let deletes = 0;
    const storesValue = stores();
    await expect(eraseParticipantWithStore({
      primary: storesValue.primary,
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
    expect(await countRows(primary, schema, 'chunks', participantId)).toBe(1);
  });

  it('bounds pages at one hundred and carries provider versions through the neutral contract', async () => {
    const primary = primaryPool();
    await resetFixture(primary, ledgerPool(), schema, ledgerSchema, participantId);
    for (let index = 0; index < 101; index += 1) {
      await seedObject(primary, schema, 'chunks', participantId, index, `generation-${index + 1}`);
    }
    const batches = [];
    const storesValue = stores();
    const result = await eraseParticipantWithStore({
      primary: storesValue.primary,
      ledger: storesValue.ledger,
      objects: { async deleteBatch(objects) { batches.push(objects); } },
      hooks: {
        async revokeAccountlessEnrollment() {},
        async assertIdentityConfiguration() {},
        async recordIdentityCooldown() {},
      },
    }, participantId, randomUUID(), fixedNow());
    expect(result.contributionsDeleted).toBe(101);
    expect(batches.map(batch => batch.length)).toEqual([100, 1]);
    expect(batches[0][0]).toMatchObject({ version: 'generation-1' });
  });

  it('detects a concurrent source-row arrival after object deletion and keeps the deletion fence', async () => {
    const primary = primaryPool();
    await resetFixture(primary, ledgerPool(), schema, ledgerSchema, participantId);
    await seedObject(primary, schema, 'telemetry_contributions', participantId, 0);
    let injected = false;
    const storesValue = stores();
    await expect(eraseParticipantWithStore({
      primary: storesValue.primary,
      ledger: storesValue.ledger,
      objects: {
        async deleteBatch() {
          if (!injected) {
            injected = true;
            await seedObject(primary, schema, 'telemetry_contributions', participantId, 99);
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
