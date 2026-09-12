import { env, reset, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalTelemetryV11Json } from '@app-usagemonitor/telemetry-contract';
import { createV11DeviceFixture, v11UsageRecord } from './helpers/telemetry-v11';
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from '../src/device-auth';
import { insertTelemetryV1Chunk } from '../src/telemetry-v1-repository';
import { telemetryV11LegacyProjection } from '../src/telemetry-v11-repository';
import { parseTelemetryV1Chunk, type TelemetryV1Record } from '../src/telemetry-v1';
import { sha256Hex } from '../src/crypto';
import { readLegacyTelemetryCopyPage } from '../src/typed-telemetry-copy';
import { prepareTypedV1PreservationProofs, persistTypedV1PreservationProofs } from '../src/typed-v1-preservation-proof';
const bindings = env as Env & { TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[] };
const source = () => bindings.USAGE_MONITOR_DB;
const day = () => new Date().toISOString().slice(0, 10);
const read = (afterSourceRowId = 0) => readLegacyTelemetryCopyPage(source(), {
  sourceNamespace: 'synthetic-proof', format: 'v1', afterSourceRowId, limit: 32,
});
beforeEach(async () => {
  await reset(); await applyD1Migrations(source(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(source(), bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS.filter(item => item.name.startsWith('0002_')));
});
async function seed(stream: 'usage' | 'quota' | 'session' = 'usage', count = 1) {
  const fixture = await createV11DeviceFixture(source());
  const records = Array.from({ length: count }, (_, i) => stream === 'usage'
    ? JSON.parse(telemetryV11LegacyProjection('usage', v11UsageRecord(day(), 'a', { eventId: `event:v2:${i.toString(16).padStart(64, '0')}` }))!.canonicalRecord)
    : stream === 'quota' ? { schemaVersion: 'quota-observation-v1.0', observationId: `quota-occurrence:v1:${i.toString(16).padStart(64, '0')}`,
      observedTime: `${day()}T12:00:00.000Z`, provider: 'openai_codex', planType: 'pro', planVariant: 'unknown',
      limitId: 'codex', slot: 'secondary', usedPercent: 0.30000000000000004, windowDurationMinutes: 10080,
      resetsAt: `${day()}T13:00:00.000Z` }
    : { schemaVersion: 'session-dimension-v1.0', sessionUuid: '0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b',
      firstEventTime: `${day()}T12:00:00.000Z`, provider: 'openai_codex', toolClassCounts: { shell: 0, other: 3 } }) as TelemetryV1Record[];
  const envelopeDigest = await sha256Hex(`synthetic-proof-${crypto.randomUUID()}`);
  const auth = await authenticateDevice(source(), fixture.authorization);
  const uploaded = await createDeviceUploadAuthorization(source(), auth, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${uploaded.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 200, contentType: 'application/json' });
  const chunk = parseTelemetryV1Chunk({ schemaVersion: 'telemetry-contribution-v1.0', chunkId: `${stream}:${day()}:0`,
    chunkRevision: 1, chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)), parserVersion: 'synthetic-proof-v1',
    consent: { telemetrySchemaVersion: 'telemetry-contribution-v1.0', fieldDictionaryVersion: 'telemetry-v1.0-registry-2026-08-07.1',
      privacyContractVersion: 'ongoing-privacy-safe-telemetry-v1.0' }, records });
  await insertTelemetryV1Chunk(source(), { chunkRowId: `chunk:${crypto.randomUUID()}`, participantId: fixture.participantId,
    deviceId: fixture.deviceId, chunk, envelopeDigest, r2Key: `synthetic/proof-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes: null });
}

describe('exact retained v1 preservation proofs', () => {
  it('preserves canonical precision, nullable usage and session maps without duplicating JSON', async () => {
    await seed('usage'); await seed('quota'); await seed('session');
    const rows = await read();
    expect(await persistTypedV1PreservationProofs(source(), rows)).toBe(3);
    expect(await persistTypedV1PreservationProofs(source(), rows)).toBe(3);
    const proofs = (await source().prepare('SELECT source_row_id,lower(hex(canonical_digest)) digest FROM typed_v1_preservation_proofs ORDER BY source_row_id').all<{source_row_id:number;digest:string}>()).results;
    for (let i = 0; i < rows.length; i++) expect(proofs[i]!.digest).toBe(await sha256Hex(canonicalTelemetryV11Json(rows[i]!.record)));
    const quota = rows.find(row => Reflect.get(row.record as object, 'schemaVersion') === 'quota-observation-v1.0')!;
    expect(Reflect.get(quota.record as object, 'usedPercent')).toBe(0.30000000000000004);
    const columns = (await source().prepare('PRAGMA table_info(typed_v1_preservation_proofs)').all<{name:string}>()).results;
    expect(columns.map(row => row.name)).toEqual(['source_row_id', 'canonical_digest']);
  });
  it.each(['record_json', 'observed_day', 'used_percent'] as const)('refuses a raced original %s before a proof can be inserted', async column => {
    await seed('quota'); const rows = await read();
    const prepared = await prepareTypedV1PreservationProofs(source(), rows);
    const value = column === 'record_json' ? '{}' : column === 'observed_day' ? '2026-01-01' : 50;
    await source().prepare(`UPDATE telemetry_v1_records SET ${column}=? WHERE id=?`).bind(value, rows[0]!.sourceRowId).run();
    const result = await source().batch(prepared.statements);
    expect(result[0]!.results).toEqual([]);
    expect(await source().prepare('SELECT count(*) n FROM typed_v1_preservation_proofs').first('n')).toBe(0);
  });
  it('qualifies a full 200-row boundary without changing raw evidence', async () => {
    await seed('usage', 200);
    const rows = []; let after = 0;
    for (;;) {
      const page = await read(after); if (!page.length) break;
      rows.push(...page); after = page.at(-1)!.sourceRowId;
    }
    expect(rows).toHaveLength(200);
    expect(await persistTypedV1PreservationProofs(source(), rows)).toBe(200);
    expect(await source().prepare('SELECT count(*) n FROM telemetry_v1_records').first('n')).toBe(200);
    expect(await source().prepare('SELECT count(*) n FROM typed_v1_preservation_proofs').first('n')).toBe(200);
    await expect(source().prepare('UPDATE typed_v1_preservation_proofs SET canonical_digest=zeroblob(32) WHERE source_row_id=?')
      .bind(rows[0]!.sourceRowId).run()).rejects.toThrow('typed_v1_preservation_proof_immutable');
  });
  it('refuses a chunk day changed after the original snapshot', async () => {
    await seed(); const rows = await read();
    const prepared = await prepareTypedV1PreservationProofs(source(), rows);
    await source().prepare("UPDATE telemetry_v1_chunks SET chunk_day='2026-01-01' WHERE id=?").bind(rows[0]!.chunkRowId).run();
    expect((await source().batch(prepared.statements))[0]!.results).toEqual([]);
    expect(await source().prepare('SELECT count(*) n FROM typed_v1_preservation_proofs').first('n')).toBe(0);
  });
  it('invalidates existing proofs on original row and parent membership updates, and cascades deletion', async () => {
    await seed(); const rows = await read();
    await persistTypedV1PreservationProofs(source(), rows);
    await source().prepare('UPDATE telemetry_v1_records SET observed_at=observed_at WHERE id=?').bind(rows[0]!.sourceRowId).run();
    expect(await source().prepare('SELECT count(*) n FROM typed_v1_preservation_proofs').first('n')).toBe(0);
    await persistTypedV1PreservationProofs(source(), rows);
    await source().prepare('UPDATE telemetry_v1_chunks SET created_at=created_at WHERE id=?').bind(rows[0]!.chunkRowId).run();
    expect(await source().prepare('SELECT count(*) n FROM typed_v1_preservation_proofs').first('n')).toBe(0);
    await persistTypedV1PreservationProofs(source(), rows);
    await source().prepare('DELETE FROM telemetry_v1_records WHERE id=?').bind(rows[0]!.sourceRowId).run();
    expect(await source().prepare('SELECT count(*) n FROM typed_v1_preservation_proofs').first('n')).toBe(0);
  });
  it('snapshots caller values, refuses forged identity, and enforces finite batch bounds', async () => {
    await seed(); const rows = await read();
    const promise = prepareTypedV1PreservationProofs(source(), rows);
    Reflect.set(rows[0]!.record as object, 'modelId', 'mutated-after-preparation');
    await source().batch((await promise).statements);
    expect(await source().prepare('SELECT count(*) n FROM typed_v1_preservation_proofs').first('n')).toBe(1);
    const current = await read();
    await expect(persistTypedV1PreservationProofs(source(), [{ ...current[0]!, deviceId: 'wrong-device' }])).rejects.toThrow('TYPED_TELEMETRY_CONFLICT');
    await expect(prepareTypedV1PreservationProofs(source(), Array(201).fill(current[0]))).rejects.toThrow('TYPED_TELEMETRY_LIMIT');
    await expect(prepareTypedV1PreservationProofs(source(), [current[0]!, current[0]!])).rejects.toThrow('TYPED_TELEMETRY_INVALID');
  });
});
