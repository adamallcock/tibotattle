import { expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';

const schema = 'tibotattle_v1_test';

function digest(seed) {
  return createHash('sha256').update(seed).digest('hex');
}

/**
 * Build a content-free current/superseded chunk row for sync qualification.
 * The caller is responsible for registering the participant, device and
 * authorization rows required by the disposable schema.
 */
export function makeSyncFixtureChunk({
  id = `sync-${randomUUID()}`,
  participantId = 'synthetic-participant',
  deviceId = 'synthetic-device',
  stream = 'usage',
  chunkDay = '2026-09-01',
  chunkSeq = 0,
  revision = 1,
  chunkDigest = digest(id),
  envelopeDigest = digest(`envelope:${id}`),
  parserVersion = 'synthetic',
  recordCount = 1,
  objectKey = `synthetic/${id}`,
  authorizationId = `auth-${id}`,
  createdAt = '2026-09-01T12:00:00.000Z',
  supersededAt = null,
} = {}) {
  return {
    id, participantId, deviceId, stream, chunkDay, chunkSeq, revision,
    chunkDigest, envelopeDigest, parserVersion, recordCount, objectKey,
    authorizationId, createdAt, supersededAt,
  };
}

/** Insert one fixture row into the existing qualification schema. */
export async function insertSyncFixtureChunk(pool, options = {}) {
  const row = makeSyncFixtureChunk(options);
  await pool.query(`INSERT INTO ${schema}.chunks(
    id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
    chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,object_key,
    authorization_id,created_at,superseded_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [
    row.id, row.participantId, row.deviceId, row.stream, row.chunkDay,
    row.chunkSeq, row.revision, row.chunkDigest, row.envelopeDigest,
    row.parserVersion, row.recordCount, row.recordCount, row.objectKey,
    row.authorizationId, row.createdAt, row.supersededAt,
  ]);
  return row;
}

/** Insert an ordered set of fixture rows and return their neutral metadata. */
export async function insertSyncFixtureChunks(pool, chunks) {
  const rows = [];
  for (const options of chunks) rows.push(await insertSyncFixtureChunk(pool, options));
  return rows;
}

function resolve(value) {
  return typeof value === 'function' ? value() : value;
}

/**
 * Register PostgreSQL sync-read tests against the shared contribution
 * harness. The sync store is separate from the write store because the
 * candidate adapters deliberately expose different provider-neutral ports.
 * `store` remains accepted as a compatibility alias for `syncStore` when the
 * caller also supplies `contributionStore`.
 */
export function registerSyncTests({
  syncStore: syncStoreGetter,
  contributionStore: contributionStoreGetter,
  store: storeGetter,
  input,
  grant,
  pid = 'synthetic-participant',
  did = 'synthetic-device',
}) {
  const syncGetter = syncStoreGetter ?? storeGetter;
  const writeGetter = contributionStoreGetter
    ?? (syncStoreGetter === undefined ? null : storeGetter);
  const sync = () => resolve(syncGetter);
  const writer = () => resolve(writeGetter);

  async function append(options) {
    const contribution = await grant(await input(options));
    const store = writer();
    if (store === null || typeof store?.insert !== 'function') {
      throw new TypeError('registerSyncTests requires contributionStore');
    }
    await store.insert(contribution);
    return contribution;
  }

  it('preserves current ordering, state digests and manifest bytes', async () => {
    const usage = await append({ stream: 'usage', chunkDay: '2026-09-01' });
    const quota = await append({ stream: 'quota', chunkDay: '2026-09-01', sequence: 1 });
    const session = await append({ stream: 'session', chunkDay: '2026-09-02' });
    // The protocol hashes the concatenated chunk digests for each day, then
    // hashes those day digests in day order for state history.
    const firstDayDigest = digest(quota.chunk.chunkDigest + usage.chunk.chunkDigest);
    const sessionDayDigest = digest(session.chunk.chunkDigest);
    const state = await sync().state(pid, did);
    expect(state).toEqual({
      schemaVersion: 'device-sync-state-v1.0',
      contractVersion: 'telemetry-contribution-v1.0',
      acknowledgedThroughDay: '2026-09-02',
      historyDigest: digest(firstDayDigest + sessionDayDigest),
      dayCount: 2,
      chunkCount: 3,
    });

    const manifest = await sync().manifest(pid, did, '2026-09-01', '2026-09-02');
    expect(manifest).toEqual({
      schemaVersion: 'device-sync-manifest-v1.0',
      contractVersion: 'telemetry-contribution-v1.0',
      fromDay: '2026-09-01',
      toDay: '2026-09-02',
      days: [
        {
          day: '2026-09-01',
          dayDigest: firstDayDigest,
          chunks: [{
            chunkId: 'quota:2026-09-01:1',
            revision: 1,
            chunkDigest: quota.chunk.chunkDigest,
            recordCount: quota.chunk.records.length,
          }, {
            chunkId: 'usage:2026-09-01:0',
            revision: 1,
            chunkDigest: usage.chunk.chunkDigest,
            recordCount: usage.chunk.records.length,
          }],
        },
        {
          day: '2026-09-02',
          dayDigest: sessionDayDigest,
          chunks: [{
            chunkId: 'session:2026-09-02:0',
            revision: 1,
            chunkDigest: session.chunk.chunkDigest,
            recordCount: session.chunk.records.length,
          }],
        },
      ],
    });
  });

  it('returns the bounded daily admission receipt through the sync port', async () => {
    await append({ stream: 'session', chunkDay: '2026-09-01' });
    const nowEpoch = Date.now();
    await expect(sync().admission(pid, did, nowEpoch)).resolves.toMatchObject({
      schemaVersion: 'telemetry-chunk-admission-v1.0',
      state: 'available',
      budget: 'steady_state',
      acceptedChunks: 1,
      remainingChunks: 1_999,
      maximumChunks: 2_000,
    });
  });
}
