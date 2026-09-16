import { expect, it } from 'vitest';

const HEX64 = 'a'.repeat(64);
const OTHER_PARTICIPANT = 'model-history-other-participant';
const ACCOUNTLESS_PARTICIPANT = 'model-history-accountless-participant';
const ACCOUNTLESS_DEVICE = 'model-history-accountless-device';
const ACCOUNTLESS_AUTHORIZATION = 'model-history-accountless-authorization';

function resolve(value) {
  return typeof value === 'function' ? value() : value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]*$/u.test(value)) {
    throw new TypeError(`${label} must be a simple SQL identifier`);
  }
  return value;
}

function addDays(day, offset) {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function dayInput(input, day, options = {}) {
  return Promise.resolve(input({ ...options, chunkDay: day })).then((value) => {
    if (value === null || typeof value !== 'object'
        || value.chunk === null || typeof value.chunk !== 'object') {
      throw new TypeError('input() must return a contribution with a chunk');
    }
    if (value.chunk.chunkDay !== day) {
      throw new Error('input() must honor its day option for model-history fixtures');
    }
    return value;
  });
}

async function seedDependencies(pool, schema, participantId, firstDay, revision = 7) {
  const values = [-1, 0, 100, 101].map((offset) => {
    const day = addDays(firstDay, offset);
    return [participantId, day, addDays(day, -100), revision, HEX64, 4];
  });
  for (const value of values) {
    await pool.query(`INSERT INTO ${schema}.community_model_history_dependencies
      (participant_id,day,from_day,dependency_revision,input_fingerprint,verified_input_revision)
      VALUES($1,$2,$3,$4,$5,$6)`, value);
  }
}

async function seedCompositionDays(pool, schema, firstDay) {
  const values = [
    [addDays(firstDay, -1), 'history-v1'],
    [addDays(firstDay, 0), 'history-v1'],
    [addDays(firstDay, 100), 'history-v1'],
    [addDays(firstDay, 101), 'history-v1'],
    [addDays(firstDay, 50), null],
  ];
  for (const [day, method] of values) {
    await pool.query(`INSERT INTO ${schema}.community_model_composition_days
      (day,payload_json,computed_at,history_method_version)
      VALUES($1,$2,clock_timestamp(),$3)`, [day, '{}', method]);
  }
}

async function historyRows(rows, table) {
  return (await rows(table)).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

/**
 * Register PostgreSQL projection tests without importing the contribution
 * suite. The suite owns connection setup and truncation; this helper only
 * seeds the two projection tables and exercises the injected contribution
 * store in the same transaction as its chunk journal.
 */
export function registerModelHistoryTests({
  pool: poolGetter,
  store: storeGetter,
  input,
  grant,
  rows,
  snapshot,
  schema: schemaValue,
  pid,
  did,
}) {
  const schema = identifier(schemaValue, 'schema');
  const table = (name) => `${schema}.${identifier(name, 'table')}`;
  const pool = () => resolve(poolGetter);
  const store = () => resolve(storeGetter);
  const day = '2026-09-01';

  it('invalidates participant dependencies through inclusive day +100 and evicts social composition days globally', async () => {
    await pool().query(`INSERT INTO ${table('participants')}(id,state,owner_kind)
      VALUES($1,'active','social')`, [OTHER_PARTICIPANT]);
    await seedDependencies(pool(), schema, pid, day);
    await seedDependencies(pool(), schema, OTHER_PARTICIPANT, day);
    await seedCompositionDays(pool(), schema, day);

    const value = await grant(await dayInput(input, day));
    await expect(store().insert(value)).resolves.toEqual({ acceptedRecords: value.chunk.records.length });

    const dependencies = await historyRows(rows, 'community_model_history_dependencies');
    const ours = dependencies.filter((row) => row.participant_id === pid);
    const other = dependencies.filter((row) => row.participant_id === OTHER_PARTICIPANT);
    for (const offset of [0, 100]) {
      expect(ours.find((row) => row.day === addDays(day, offset)))
        .toMatchObject({ dependency_revision: '8', input_fingerprint: null, verified_input_revision: null });
    }
    expect(ours.find((row) => row.day === addDays(day, -1)))
      .toMatchObject({ dependency_revision: '7', input_fingerprint: HEX64, verified_input_revision: '4' });
    expect(ours.find((row) => row.day === addDays(day, 101)))
      .toMatchObject({ dependency_revision: '7', input_fingerprint: HEX64, verified_input_revision: '4' });
    expect(other.every((row) => row.dependency_revision === '7'
      && row.input_fingerprint === HEX64 && row.verified_input_revision === '4')).toBe(true);

    const composition = await historyRows(rows, 'community_model_composition_days');
    expect(composition).toEqual([
      expect.objectContaining({ day: addDays(day, -1), history_method_version: 'history-v1' }),
      expect.objectContaining({ day: addDays(day, 50), history_method_version: null }),
      expect.objectContaining({ day: addDays(day, 101), history_method_version: 'history-v1' }),
    ]);
  });

  it('invalidates both predecessor and replacement ranges on correction (+2 dependency revision)', async () => {
    const first = await grant(await dayInput(input, day, { occurrence: 'model-history-correction' }));
    await seedDependencies(pool(), schema, pid, day, 10);
    await seedCompositionDays(pool(), schema, day);
    await store().insert(first);

    // The first append removed only the in-range materialized rows. Recreate
    // the rows and reset dependency metadata so the correction delta is clear.
    await pool().query(`TRUNCATE ${table('community_model_composition_days')}`);
    await seedCompositionDays(pool(), schema, day);
    await pool().query(`UPDATE ${table('community_model_history_dependencies')}
      SET dependency_revision=10,input_fingerprint=$1,verified_input_revision=4
      WHERE participant_id=$2`, [HEX64, pid]);

    const replacement = await grant(await dayInput(input, day, {
      occurrence: 'model-history-correction',
      revision: 2,
      supersedes: { id: first.chunkId },
    }));
    await expect(store().insert(replacement)).resolves.toEqual({ acceptedRecords: replacement.chunk.records.length });

    const dependencies = (await historyRows(rows, 'community_model_history_dependencies'))
      .filter((row) => row.participant_id === pid);
    for (const offset of [0, 100]) {
      expect(dependencies.find((row) => row.day === addDays(day, offset)))
        .toMatchObject({ dependency_revision: '12', input_fingerprint: null, verified_input_revision: null });
    }
    expect(dependencies.find((row) => row.day === addDays(day, -1)))
      .toMatchObject({ dependency_revision: '10', input_fingerprint: HEX64, verified_input_revision: '4' });
    expect(dependencies.find((row) => row.day === addDays(day, 101)))
      .toMatchObject({ dependency_revision: '10', input_fingerprint: HEX64, verified_input_revision: '4' });

    const composition = await historyRows(rows, 'community_model_composition_days');
    expect(composition).toEqual([
      expect.objectContaining({ day: addDays(day, -1), history_method_version: 'history-v1' }),
      expect.objectContaining({ day: addDays(day, 50), history_method_version: null }),
      expect.objectContaining({ day: addDays(day, 101), history_method_version: 'history-v1' }),
    ]);
  });

  it('does not invalidate model history for object-envelope metadata-only updates', async () => {
    const value = await grant(await dayInput(input, day, { occurrence: 'model-history-metadata' }));
    await store().insert(value);
    await seedDependencies(pool(), schema, pid, day);
    await seedCompositionDays(pool(), schema, day);

    await pool().query(`UPDATE ${table('chunks')}
      SET object_key=$1,envelope_digest=$2 WHERE id=$3`, [
      `${value.objectKey}-metadata-reconciled`, 'c'.repeat(64), value.chunkId,
    ]);

    const dependencies = (await historyRows(rows, 'community_model_history_dependencies'))
      .filter((row) => row.participant_id === pid);
    for (const offset of [-1, 0, 100, 101]) {
      expect(dependencies.find((row) => row.day === addDays(day, offset)))
        .toMatchObject({ dependency_revision: '7', input_fingerprint: HEX64, verified_input_revision: '4' });
    }
    expect(await rows('community_model_composition_days')).toHaveLength(5);
  });

  it('invalidates the source range when an active chunk is deleted', async () => {
    const value = await grant(await dayInput(input, day, { occurrence: 'model-history-delete' }));
    await store().insert(value);
    await seedDependencies(pool(), schema, pid, day);
    await seedCompositionDays(pool(), schema, day);

    // The qualification schema intentionally keeps records restrictive, so
    // remove child records before exercising the source-chunk delete trigger.
    await pool().query(`DELETE FROM ${table('records')} WHERE chunk_id=$1`, [value.chunkId]);
    await pool().query(`DELETE FROM ${table('chunks')} WHERE id=$1`, [value.chunkId]);

    const dependencies = (await historyRows(rows, 'community_model_history_dependencies'))
      .filter((row) => row.participant_id === pid);
    for (const offset of [0, 100]) {
      expect(dependencies.find((row) => row.day === addDays(day, offset)))
        .toMatchObject({ dependency_revision: '8', input_fingerprint: null, verified_input_revision: null });
    }
    expect(dependencies.find((row) => row.day === addDays(day, -1)))
      .toMatchObject({ dependency_revision: '7', input_fingerprint: HEX64, verified_input_revision: '4' });
    expect(await historyRows(rows, 'community_model_composition_days')).toEqual([
      expect.objectContaining({ day: addDays(day, -1), history_method_version: 'history-v1' }),
      expect.objectContaining({ day: addDays(day, 50), history_method_version: null }),
      expect.objectContaining({ day: addDays(day, 101), history_method_version: 'history-v1' }),
    ]);
  });

  it('does not invalidate model history when a superseded predecessor is deleted', async () => {
    const first = await grant(await dayInput(input, day, { occurrence: 'model-history-delete-superseded' }));
    await store().insert(first);
    const replacement = await grant(await dayInput(input, day, {
      occurrence: 'model-history-delete-superseded',
      revision: 2,
      supersedes: { id: first.chunkId },
    }));
    await store().insert(replacement);
    await seedDependencies(pool(), schema, pid, day);
    await seedCompositionDays(pool(), schema, day);

    await pool().query(`DELETE FROM ${table('records')} WHERE chunk_id=$1`, [first.chunkId]);
    await pool().query(`DELETE FROM ${table('chunks')} WHERE id=$1`, [first.chunkId]);

    const dependencies = (await historyRows(rows, 'community_model_history_dependencies'))
      .filter((row) => row.participant_id === pid);
    for (const offset of [-1, 0, 100, 101]) {
      expect(dependencies.find((row) => row.day === addDays(day, offset)))
        .toMatchObject({ dependency_revision: '7', input_fingerprint: HEX64, verified_input_revision: '4' });
    }
    expect(await rows('community_model_composition_days')).toHaveLength(5);
  });

  it('invalidates accountless dependencies without evicting social composition history', async () => {
    const accountlessObject = 'model-history-accountless-object';
    await pool().query(`INSERT INTO ${table('participants')}(id,state,owner_kind)
      VALUES($1,'active','accountless')`, [ACCOUNTLESS_PARTICIPANT]);
    await pool().query(`INSERT INTO ${table('devices')}(id,participant_id,state,issued_at,expires_at)
      VALUES($1,$2,'active',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day')`,
    [ACCOUNTLESS_DEVICE, ACCOUNTLESS_PARTICIPANT]);
    await pool().query(`INSERT INTO ${table('authorizations')}
      (id,participant_id,device_id,envelope_digest,state,lease_expires_at,expires_at)
      VALUES($1,$2,$3,$4,'consuming',clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '10 minutes')`,
    [ACCOUNTLESS_AUTHORIZATION, ACCOUNTLESS_PARTICIPANT, ACCOUNTLESS_DEVICE, HEX64]);
    await seedDependencies(pool(), schema, ACCOUNTLESS_PARTICIPANT, day);
    await seedCompositionDays(pool(), schema, day);
    await pool().query(`INSERT INTO ${table('chunks')}
      (id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,envelope_digest,
       parser_version,record_count,accepted_record_count,object_key,authorization_id,created_at)
      VALUES($1,$2,$3,'session',$4,0,1,$5,$6,'synthetic',1,1,$7,$8,clock_timestamp())`, [
      'model-history-accountless-chunk', ACCOUNTLESS_PARTICIPANT, ACCOUNTLESS_DEVICE, day,
      HEX64, 'b'.repeat(64), accountlessObject, ACCOUNTLESS_AUTHORIZATION,
    ]);

    const dependencies = (await historyRows(rows, 'community_model_history_dependencies'))
      .filter((row) => row.participant_id === ACCOUNTLESS_PARTICIPANT);
    expect(dependencies.find((row) => row.day === day))
      .toMatchObject({ dependency_revision: '8', input_fingerprint: null, verified_input_revision: null });
    expect(await rows('community_model_composition_days')).toHaveLength(5);
  });

  it('rolls back projection invalidation when the transaction fails after the trigger', async () => {
    await seedDependencies(pool(), schema, pid, day);
    await seedCompositionDays(pool(), schema, day);
    const value = await grant(await dayInput(input, day, { occurrence: 'model-history-rollback' }));
    const before = {
      all: await snapshot(),
      dependencies: await historyRows(rows, 'community_model_history_dependencies'),
      composition: await historyRows(rows, 'community_model_composition_days'),
    };

    const functionName = `${schema}.model_history_test_rollback`;
    const triggerName = 'zzz_model_history_test_rollback';
    await pool().query(`CREATE FUNCTION ${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$BEGIN
        RAISE EXCEPTION USING ERRCODE='P9900', MESSAGE='synthetic projection failure';
      END;$$`);
    await pool().query(`CREATE TRIGGER ${triggerName}
      AFTER INSERT ON ${table('chunks')} FOR EACH ROW
      EXECUTE FUNCTION ${functionName}()`);
    try {
      await expect(store().insert(value)).rejects.toMatchObject({ code: 'BACKEND_STORAGE_UNAVAILABLE' });
    } finally {
      await pool().query(`DROP TRIGGER ${triggerName} ON ${table('chunks')}`);
      await pool().query(`DROP FUNCTION ${functionName}()`);
    }

    expect(await snapshot()).toEqual(before.all);
    expect(await historyRows(rows, 'community_model_history_dependencies')).toEqual(before.dependencies);
    expect(await historyRows(rows, 'community_model_composition_days')).toEqual(before.composition);
  });
}
