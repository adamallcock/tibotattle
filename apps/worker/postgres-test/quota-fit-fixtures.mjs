import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  backfillPostgresV1QuotaFitProjection,
  buildPostgresV1QuotaProjectionBackfillInsertSql,
  createPostgresV1QuotaPageReader,
} from '../src/postgres-quota-fit-projection.ts';

const HEX = 'a'.repeat(64);
const OTHER_PARTICIPANT = 'quota-fit-other-participant';
const OTHER_DEVICE = 'quota-fit-other-device';
const DAY = '2026-08-01';
const OBSERVED = `${DAY}T00:00:00.000Z`;
const RESET = '2026-08-08T00:00:00.000Z';

function resolve(value) {
  return typeof value === 'function' ? value() : value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]*$/u.test(value)) {
    throw new TypeError(`${label} must be a simple SQL identifier`);
  }
  return value;
}

async function ensureParticipant(pool, schema, participantId, deviceId) {
  await pool.query(`INSERT INTO ${schema}.participants(id,state,owner_kind,created_at)
    VALUES($1,'active','social',clock_timestamp()) ON CONFLICT(id) DO NOTHING`, [participantId]);
  await pool.query(`INSERT INTO ${schema}.web_sessions
    (id,participant_id,secret_hash,csrf_hash,scope,state,issued_at,expires_at,last_used_at)
    VALUES($1,$2,decode(repeat('61',32),'hex'),decode(repeat('62',32),'hex'),
      'personal','active',clock_timestamp(),clock_timestamp()+interval '1 day',clock_timestamp())
    ON CONFLICT(id) DO NOTHING`, [`quota-fit-session-${participantId}`, participantId]);
  await pool.query(`INSERT INTO ${schema}.device_pairings
    (id,participant_id,issued_by_session_id,secret_hash,consent_version,
     transport_consent_version,state,issued_at,expires_at,claimed_device_id)
    VALUES($1,$2,$3,decode(repeat('63',32),'hex'),
      'ongoing-privacy-safe-telemetry-v1.0','telemetry-contribution-v1.0',
      'consumed',clock_timestamp(),clock_timestamp()+interval '1 day',$4)
    ON CONFLICT(id) DO NOTHING`, [
    `quota-fit-pairing-${deviceId}`, participantId, `quota-fit-session-${participantId}`, deviceId,
  ]);
  await pool.query(`INSERT INTO ${schema}.device_credentials
    (id,participant_id,authority_kind,paired_via_pairing_id,secret_hash,state,
     issued_at,expires_at,last_used_at)
    VALUES($1,$2,'social',$3,decode(repeat('64',32),'hex'),'active',
      clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',clock_timestamp())
    ON CONFLICT(id) DO NOTHING`, [deviceId, participantId, `quota-fit-pairing-${deviceId}`]);
  await pool.query(`INSERT INTO ${schema}.telemetry_v1_device_consents
    (participant_id,device_id,telemetry_schema_version,field_dictionary_version,
     privacy_contract_version,consented_at)
    VALUES($1,$2,'telemetry-contribution-v1.0','telemetry-v1.0-registry-2026-08-07.1',
      'ongoing-privacy-safe-telemetry-v1.0',clock_timestamp())
    ON CONFLICT(participant_id,device_id) DO NOTHING`, [participantId, deviceId]);
}

async function seedSource(pool, schema, participantId, deviceId, {
  count = 1,
  eligible = () => true,
  observedAt = OBSERVED,
  resetsAt = RESET,
  chunkSeqBase = 0,
} = {}) {
  const ids = [];
  for (let offset = 0; offset < count; offset += 200) {
    const size = Math.min(200, count - offset);
    const suffix = randomUUID();
    const authorizationId = `quota-fit-auth-${suffix}`;
    const chunkId = `quota-fit-chunk-${suffix}`;
    const envelopeDigest = `${suffix.replaceAll('-', '')}${'0'.repeat(32)}`;
    const objectKey = `synthetic/quota-fit/${suffix}`;
    await pool.query(`INSERT INTO ${schema}.device_upload_authorizations
      (id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,
       content_type,state,issued_at,consume_lease_expires_at,expires_at)
      VALUES($1,$2,$3,decode(repeat('55',32),'hex'),$4,1024,'application/json',
        'consumed',clock_timestamp(),NULL,clock_timestamp()+interval '1 day')`,
    [authorizationId, participantId, deviceId, envelopeDigest]);
    await pool.query(`INSERT INTO ${schema}.pending_objects
      (contribution_id,object_key) VALUES($1,$2)`, [chunkId, objectKey]);
    await pool.query(`INSERT INTO ${schema}.telemetry_v1_chunks
      (id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,envelope_digest,
       parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at)
      VALUES($1,$2,$3,'quota',$4,$5,1,$6,$7,'quota-fit-fixture',$8,$8,$9,$10,clock_timestamp())`, [
      chunkId, participantId, deviceId, DAY, chunkSeqBase + offset / 200, HEX, envelopeDigest, size, objectKey, authorizationId,
    ]);
    const records = await pool.query(`INSERT INTO ${schema}.telemetry_v1_records
      (chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,observed_day,record_json,
       provider,plan_type,plan_variant,limit_id,slot,used_percent,window_duration_minutes,resets_at)
      SELECT $1,$2,$3,'quota',$4 || n,$5,$6,'{}'::jsonb,
        CASE WHEN $7 THEN 'openai_codex' ELSE NULL END,
        CASE WHEN $7 THEN 'pro' ELSE NULL END,
        CASE WHEN $7 THEN 'pro-20x' ELSE NULL END,
        CASE WHEN $7 THEN 'codex' ELSE 'other' END,
        CASE WHEN $7 THEN 'seven_day' ELSE NULL END,
        CASE WHEN $7 THEN 20 ELSE NULL END,10080,
        CASE WHEN $7 THEN $8::timestamptz ELSE NULL END
      FROM generate_series(0,$9 - 1) AS n
      RETURNING id`, [
      chunkId, participantId, deviceId, `quota-fit-${suffix}-`, observedAt, DAY,
      true, resetsAt, size,
    ]);
    // Rewrite eligibility per row after the bulk insert; this keeps one
    // bounded insert while allowing ineligible canonical prefixes.
    for (let index = 0; index < records.rows.length; index += 1) {
      const recordId = records.rows[index]?.id;
      if (recordId === undefined) throw new Error('fixture record id missing');
      ids.push(Number(recordId));
      if (!eligible(offset + index)) {
        await pool.query(`UPDATE ${schema}.telemetry_v1_records SET provider=NULL,plan_type=NULL,plan_variant=NULL,
          limit_id='other',slot=NULL,used_percent=NULL,resets_at=NULL WHERE id=$1`, [recordId]);
      }
    }
  }
  return ids;
}

async function resetBackfill(pool, schema, complete = false) {
  await pool.query(`DELETE FROM ${schema}.telemetry_v1_quota_fit_rows`);
  await pool.query(`DELETE FROM ${schema}.telemetry_v1_quota_fit_backfill`);
  await pool.query(`INSERT INTO ${schema}.telemetry_v1_quota_fit_backfill
    (singleton_id,through_record_id,last_record_id,is_complete)
    SELECT 1,COALESCE(MAX(id),0),CASE WHEN $1::integer = 1 THEN COALESCE(MAX(id),0) ELSE 0 END,$1::integer FROM ${schema}.telemetry_v1_records`, [complete ? 1 : 0]);
}

async function projectionIds(rows) {
  return (await rows('telemetry_v1_quota_fit_rows')).map(row => Number(row.record_id)).sort((a, b) => a - b);
}

async function finishBackfill(pool, pageSize = 128, schemaOptions = {}) {
  let outcome;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    outcome = await backfillPostgresV1QuotaFitProjection(pool, { maxPages: 16, pageSize }, schemaOptions);
    if (outcome.status === 'complete') return outcome;
  }
  throw new Error('quota-fit fixture backfill did not complete within its bound');
}

/**
 * Register the PostgreSQL quota-fit qualification without importing the
 * contribution suite. The caller owns the database lifecycle and truncates
 * source/projection tables between tests.
 */
export function registerQuotaFitTests({ pool: poolGetter, rows, schema: schemaValue, pid, did }) {
  const schema = identifier(schemaValue, 'schema');
  const schemaOptions = { primarySchema: schema };
  const pool = () => resolve(poolGetter);

  it('backfills canonical pages before eligibility and refuses incomplete readers', async () => {
    const ids = await seedSource(pool(), schema, pid, did, { count: 10, eligible: index => index >= 6 });
    await resetBackfill(pool(), schema);
    await expect(createPostgresV1QuotaPageReader(pool(), pid, undefined, schemaOptions)).rejects.toMatchObject({
      code: 'V1_QUOTA_FIT_PROJECTION_UNAVAILABLE',
    });
    expect(await backfillPostgresV1QuotaFitProjection(pool(), { maxPages: 1, pageSize: 3 }, schemaOptions))
      .toMatchObject({ status: 'deferred', pagesRun: 1, lastRecordId: ids[2], throughRecordId: ids.at(-1) });
    expect(await projectionIds(rows)).toEqual([]);
    await finishBackfill(pool(), 3, schemaOptions);
    expect(await projectionIds(rows)).toEqual(ids.slice(6));
    await expect(createPostgresV1QuotaPageReader(pool(), pid, undefined, schemaOptions)).resolves.toBeDefined();
  });

  it('uses cursor CAS so concurrent bounded callers do not skip source rows', async () => {
    const ids = await seedSource(pool(), schema, pid, did, { count: 8 });
    await resetBackfill(pool(), schema);
    const outcomes = await Promise.allSettled([
      backfillPostgresV1QuotaFitProjection(pool(), { maxPages: 1, pageSize: 3 }, schemaOptions),
      backfillPostgresV1QuotaFitProjection(pool(), { maxPages: 1, pageSize: 3 }, schemaOptions),
    ]);
    expect(outcomes.every(outcome => outcome.status === 'fulfilled')).toBe(true);
    await finishBackfill(pool(), 3, schemaOptions);
    expect(await projectionIds(rows)).toEqual(ids);
  });

  it('maintains eligibility updates/deletes, high-water inserts, and participant isolation', async () => {
    await ensureParticipant(pool(), schema, OTHER_PARTICIPANT, OTHER_DEVICE);
    const ids = await seedSource(pool(), schema, pid, did, { count: 4 });
    const otherIds = await seedSource(pool(), schema, OTHER_PARTICIPANT, OTHER_DEVICE, { count: 1 });
    const initialHighWater = Math.max(...ids, ...otherIds);
    await resetBackfill(pool(), schema);
    await finishBackfill(pool(), 3, schemaOptions);
    expect(await projectionIds(rows)).toEqual([...ids, ...otherIds].sort((a, b) => a - b));

    await pool().query(`UPDATE ${schema}.telemetry_v1_records SET provider=NULL,plan_type=NULL,plan_variant=NULL,
      limit_id='other',slot=NULL,used_percent=NULL,resets_at=NULL WHERE id=$1`, [ids[0]]);
    expect(await projectionIds(rows)).not.toContain(ids[0]);
    await pool().query(`UPDATE ${schema}.telemetry_v1_records SET provider='openai_codex',plan_type='pro',
      plan_variant='pro-20x',limit_id='codex',slot='seven_day',used_percent=20,resets_at=$1 WHERE id=$2`, [RESET, ids[0]]);
    expect(await projectionIds(rows)).toContain(ids[0]);
    await pool().query(`DELETE FROM ${schema}.telemetry_v1_records WHERE id=$1`, [ids[1]]);
    expect(await projectionIds(rows)).not.toContain(ids[1]);

    const [postHighWater] = await seedSource(pool(), schema, pid, did, { count: 1, chunkSeqBase: 1 });
    expect(await projectionIds(rows)).toContain(postHighWater);
    const highWater = (await pool().query(`SELECT through_record_id,last_record_id,is_complete
      FROM ${schema}.telemetry_v1_quota_fit_backfill WHERE singleton_id=1`)).rows[0];
    expect(Number(highWater.through_record_id)).toBe(initialHighWater);
    const reader = await createPostgresV1QuotaPageReader(pool(), pid, undefined, schemaOptions);
    await expect(reader.readPlanPage({ observedAt: '', id: 0 }, 128)).resolves.toBeDefined();
  });

  it('holds source locks through the page upsert before concurrent correction/deletion', async () => {
    const ids = await seedSource(pool(), schema, pid, did, { count: 2 });
    await resetBackfill(pool(), schema);
    const copier = await pool().connect();
    const writer = await pool().connect();
    let mutation;
    try {
      await copier.query('BEGIN');
      await copier.query(buildPostgresV1QuotaProjectionBackfillInsertSql(schemaOptions), [0, ids.at(-1), 2]);
      expect((await copier.query(`SELECT record_id FROM ${schema}.telemetry_v1_quota_fit_rows
        ORDER BY record_id`)).rows.map(row => Number(row.record_id))).toEqual(ids);

      await writer.query('BEGIN');
      mutation = writer.query(`UPDATE ${schema}.telemetry_v1_records SET provider=NULL WHERE id=$1`, [ids[0]]);
      let waiting = 0;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        waiting = (await pool().query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE 'UPDATE ${schema}.telemetry_v1_records SET provider=NULL%'`)).rowCount;
        if (waiting === 1) break;
        await pool().query('SELECT pg_sleep(0.025)');
      }
      expect(waiting).toBe(1);
      await copier.query('COMMIT');
      await mutation;
      await writer.query(`DELETE FROM ${schema}.telemetry_v1_records WHERE id=$1`, [ids[1]]);
      await writer.query('COMMIT');
      expect(await projectionIds(rows)).toEqual([]);
    } finally {
      try { await mutation; } catch { /* release below */ }
      try { await copier.query('ROLLBACK'); } catch { /* already committed */ }
      try { await writer.query('ROLLBACK'); } catch { /* already committed */ }
      copier.release();
      writer.release();
    }
  });

  it('reads physical plan pages and reset-first fit pages with bounded cursors', async () => {
    const ids = await seedSource(pool(), schema, pid, did, { count: 1_100, eligible: index => index > 0 });
    await resetBackfill(pool(), schema);
    await finishBackfill(pool(), 128, schemaOptions);
    const reader = await createPostgresV1QuotaPageReader(pool(), pid, undefined, schemaOptions);
    const firstPlan = await reader.readPlanPage({ observedAt: OBSERVED, id: 0 }, 1_024);
    expect(firstPlan).toHaveLength(1_024);
    expect(firstPlan[0]).toMatchObject({ id: ids[0], provider: null, limit_id: 'other' });
    const nextPlan = await reader.readPlanPage({ observedAt: firstPlan.at(-1).observed_at, id: firstPlan.at(-1).id }, 1_024);
    expect(nextPlan).toHaveLength(76);

    const fitIds = [];
    let cursor = { resetsAt: '', observedAt: '', id: 0 };
    for (;;) {
      const page = await reader.readFitPage(cursor, 128);
      if (page.length === 0) break;
      fitIds.push(...page.map(row => row.id));
      const last = page.at(-1);
      cursor = { resetsAt: last.resets_at, observedAt: last.observed_at, id: last.id };
    }
    expect(fitIds).toEqual(ids.slice(1));
  });

  it('orders plan pages by observed time even when insertion ids are non-monotonic', async () => {
    const laterId = (await seedSource(pool(), schema, pid, did, {
      observedAt: '2026-08-03T00:00:00.000Z',
      chunkSeqBase: 0,
    }))[0];
    const earlierId = (await seedSource(pool(), schema, pid, did, {
      observedAt: '2026-08-01T00:00:00.000Z',
      chunkSeqBase: 1,
    }))[0];
    await resetBackfill(pool(), schema);
    await finishBackfill(pool(), 128, schemaOptions);
    const reader = await createPostgresV1QuotaPageReader(pool(), pid, undefined, schemaOptions);
    const first = await reader.readPlanPage({ observedAt: '', id: 0 }, 1);
    expect(first.map(row => row.id)).toEqual([earlierId]);
    const next = await reader.readPlanPage({ observedAt: first[0].observed_at, id: first[0].id }, 1);
    expect(next.map(row => row.id)).toEqual([laterId]);
  });

  it('rolls back a page copy when projection insertion fails before cursor advance', async () => {
    await seedSource(pool(), schema, pid, did, { count: 4 });
    await resetBackfill(pool(), schema);
    await pool().query(`CREATE FUNCTION ${schema}.quota_fit_test_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION USING ERRCODE='P9901', MESSAGE='synthetic quota failure'; END;$$`);
    await pool().query(`CREATE TRIGGER zzz_quota_fit_test_failure
      AFTER INSERT ON ${schema}.telemetry_v1_quota_fit_rows FOR EACH ROW
      EXECUTE FUNCTION ${schema}.quota_fit_test_failure()`);
    try {
      await expect(backfillPostgresV1QuotaFitProjection(pool(), { maxPages: 1, pageSize: 3 }, schemaOptions))
        .rejects.toMatchObject({ code: 'V1_QUOTA_FIT_PROJECTION_UNAVAILABLE' });
    } finally {
      await pool().query(`DROP TRIGGER zzz_quota_fit_test_failure ON ${schema}.telemetry_v1_quota_fit_rows`);
      await pool().query(`DROP FUNCTION ${schema}.quota_fit_test_failure()`);
    }
    expect(await projectionIds(rows)).toEqual([]);
    const state = (await pool().query(`SELECT last_record_id,is_complete FROM ${schema}.telemetry_v1_quota_fit_backfill`)).rows[0];
    expect(Number(state.last_record_id)).toBe(0);
    expect(Number(state.is_complete)).toBe(0);
  });
}
