import { env, applyD1Migrations, reset, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from '@app-usagemonitor/telemetry-contract';
import { initializeStorageSource, readIngestionChanges } from '../src/analytics-delivery';
import { bootstrapV11StorageHead, lookupV11StorageSource } from '../src/v11-storage-journal';
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from '../src/telemetry-v11-domain';
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from './helpers/telemetry-v11';
import { encodeBase64Url, sha256Hex } from '../src/crypto';
import { handleRequest } from '../src/index';
import { revokeAccountlessEnrollment } from '../src/accountless-enrollment';
import { eraseParticipantAsOwner } from '../src/participant-erasure';
import { authenticateDevice } from '../src/device-auth';

interface Bindings extends Env { TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[]; }
const bindings = env as Bindings, db = () => bindings.USAGE_MONITOR_DB;
const sourceId = 'synthetic-v11-source';
const changes = () => readIngestionChanges(db(), sourceId, 0);
const today = () => new Date().toISOString().slice(0, 10);
const runtime = () => ({ ...bindings, ENVIRONMENT: 'synthetic-development', ACCOUNT_SCOPED_INGEST_MODE: 'disabled',
  ACCOUNTLESS_ENROLLMENT_MODE: 'enabled', ACCOUNTLESS_OWNERSHIP_MODE: 'enabled' } as Env);
function withBatch(database: D1Database, batch: D1Database['batch']): D1Database {
  return new Proxy(database, { get(value, property) {
    if (property === 'batch') return batch;
    const member: unknown = Reflect.get(value, property);
    return typeof member === 'function' ? member.bind(value) : member;
  } });
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_INGESTION_MIGRATIONS.filter((item) => item.name.startsWith('0002_')));
  await applyD1Migrations(db(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_INGESTION_ISOLATION_MIGRATIONS.filter((item) => item.name.startsWith('0005_')));
  await applyD1Migrations(bindings.DELETION_LEDGER, bindings.TEST_DELETION_LEDGER_MIGRATIONS);
  await initializeStorageSource(db(), sourceId);
  await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
});

async function activate(fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>, fills = ['a']) {
  const staged = await stageV11Day(db(), fixture, await makeV11Day(today(), { usage: fills.map((fill) => v11UsageRecord(today(), fill)) }));
  const prior = await createTelemetryV11DomainPredecessor(db(), fixture);
  const manifest: TelemetryV11DomainManifest = { schemaVersion: 'telemetry-domain-manifest-v1.1', fromDay: staged.day, throughDay: staged.day,
    predecessor: { token: prior.token, previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint },
    days: [{ day: staged.day, manifestId: staged.manifestId, manifestDigest: staged.manifestDigest }], manifestDigest: '0'.repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  return { manifest, result: await activateTelemetryV11Domain(db(), fixture, manifest) };
}

async function accountlessFixture(): Promise<Awaited<ReturnType<typeof createV11DeviceFixture>>> {
  const deviceId = crypto.randomUUID(), secret = crypto.getRandomValues(new Uint8Array(32));
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`), input = new Uint8Array(prefix.length + secret.length);
  input.set(prefix); input.set(secret, prefix.length);
  const deviceSecretHash = await sha256Hex(input), authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  input.fill(0); secret.fill(0);
  const request = (path: string, body: object, auth = '') => handleRequest(new Request(`https://bridge.example.test${path}`, {
    method: 'POST', headers: { origin: 'https://bridge.example.test', 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body),
  }), runtime());
  expect((await request('/api/v1/accountless/enrollment', { schemaVersion: 'accountless-enrollment-v0.1', deviceId, deviceSecretHash,
    policyVersion: 'accountless-opt-out-v1', authorizationBasis: 'accountless-policy-v1' })).status).toBe(201);
  expect((await request('/api/v1/accountless/ownership', { schemaVersion: 'accountless-upload-owner-v0.1',
    policyVersion: 'accountless-opt-out-v1', authorizationBasis: 'accountless-policy-v1', telemetrySchemaVersion: 'telemetry-contribution-v1.1' }, authorization)).status).toBe(201);
  const owner = await db().prepare('SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?').bind(deviceId).first<{ participant_id: string }>();
  if (!owner) throw new Error('missing synthetic owner');
  return { participantId: owner.participant_id, deviceId, authorization, nowEpoch: Date.now(), sessionId: '', cookie: '', csrfToken: '' };
}

describe('optional baseline v1.1 storage journal bridge', () => {
  it('refuses opt-out atomically before the retention schema is installed', async () => {
    await reset();
    await applyD1Migrations(db(), bindings.TEST_MIGRATIONS.filter((item) => !item.name.startsWith('0061_')));
    await applyD1Migrations(db(), bindings.TEST_TYPED_INGESTION_MIGRATIONS.filter((item) => item.name.startsWith('0002_')));
    await applyD1Migrations(db(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
    await initializeStorageSource(db(), sourceId);
    await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
    const fixture = await accountlessFixture();
    await activate(fixture);
    await expect(revokeAccountlessEnrollment(db(), fixture.deviceId, 'user_opt_out', Date.now()))
      .rejects.toMatchObject({ code: 'BACKEND_STORAGE_UNAVAILABLE' });
    expect(await db().prepare('SELECT state FROM accountless_enrollment_ledger WHERE device_id=?')
      .bind(fixture.deviceId).first('state')).toBe('active');
    expect((await changes()).map((item) => item.kind)).toEqual(['owner-active']);
  });
  it('batches active terminal and metadata reads and refuses a truncated response', async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true }); await activate(fixture);
    const event = (await changes())[0]!;
    let calls = 0;
    const observed = withBatch(db(), (async statements => {
      calls += 1;
      return db().batch(statements);
    }) as D1Database['batch']);
    await expect(lookupV11StorageSource(observed, event)).resolves.toMatchObject({ disposition: 'generation' });
    expect(calls).toBe(2);
    calls = 0;
    const truncated = withBatch(db(), (async statements => {
      calls += 1;
      const results = await db().batch(statements);
      return calls === 2 ? results.slice(0, 1) : results;
    }) as D1Database['batch']);
    await expect(lookupV11StorageSource(truncated, event)).rejects.toThrow('V11_STORAGE_SOURCE_UNAVAILABLE');
  });

  it('does not publish enrollment, binds real accepted generations, and converges activation/bootstrap replay', async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    expect(await bootstrapV11StorageHead(db(), fixture.participantId)).toBe('ineligible'); expect(await changes()).toEqual([]);
    const first = await activate(fixture);
    const event = (await changes())[0]!;
    expect(event.kind).toBe('owner-active'); expect(event.ownerDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await lookupV11StorageSource(db(), event)).toMatchObject({ disposition: 'generation', generationId: first.result.generationId,
      manifestDigest: first.manifest.manifestDigest, participantId: fixture.participantId, deviceId: fixture.deviceId, headRevision: 1 });
    expect((await activateTelemetryV11Domain(db(), fixture, first.manifest)).replay).toBe(true);
    expect(await bootstrapV11StorageHead(db(), fixture.participantId)).toBe('eligible-head'); expect(await changes()).toHaveLength(1);
    const next = await activate(fixture, ['a', 'b']);
    const events = await changes(); expect(events.map((item) => item.kind)).toEqual(['owner-active', 'owner-active']);
    expect(events[1]!.authorityEpoch).toBe(events[0]!.authorityEpoch + 1);
    expect(await lookupV11StorageSource(db(), events[0]!)).toMatchObject({ generationId: first.result.generationId });
    expect(await lookupV11StorageSource(db(), events[1]!)).toMatchObject({ generationId: next.result.generationId });
  });
  it('retains every referenced source layer after head replacement until owner erasure', async () => {
    const fixture = await accountlessFixture();
    const first = await activate(fixture); const event = (await changes())[0]!;
    await activate(fixture, ['a', 'b']);
    const manifestId = first.manifest.days[0]!.manifestId;
    const deletes = [
      ['DELETE FROM telemetry_v11_domains WHERE id=?', first.result.generationId],
      ['DELETE FROM telemetry_v11_domain_days WHERE generation_id=?', first.result.generationId],
      ['DELETE FROM telemetry_v11_day_manifests WHERE id=?', manifestId],
      ['DELETE FROM telemetry_v11_chunks WHERE manifest_id=?', manifestId],
      ['DELETE FROM telemetry_v11_records WHERE manifest_id=?', manifestId],
    ] as const;
    for (const [sql, id] of deletes) {
      await expect(db().prepare(sql).bind(id).run()).rejects.toThrow(/storage_v11_(source_retained|terminal_required)/);
      expect(await lookupV11StorageSource(db(), event)).toMatchObject({ disposition: 'generation', generationId: first.result.generationId });
    }
    expect(await db().prepare('SELECT count(*) n FROM telemetry_v11_records WHERE manifest_id=?').bind(manifestId).first('n')).toBe(1);
    await expect(eraseParticipantAsOwner(runtime(), 'e'.repeat(64), fixture.participantId)).resolves.toMatchObject({ deleted: true });
    expect(await lookupV11StorageSource(db(), event)).toMatchObject({ disposition: 'discard', reason: 'owner-erased' });
    for (const table of ['telemetry_v11_domains', 'telemetry_v11_domain_days', 'telemetry_v11_day_manifests', 'telemetry_v11_chunks', 'telemetry_v11_records']) {
      expect(await db().prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(0);
    }
  });
  it('rolls the actual domain/head/predecessor transaction back when its journal fails', async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    await db().prepare("CREATE TRIGGER synthetic_journal_failure BEFORE INSERT ON storage_ingestion_changes BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END").run();
    await expect(activate(fixture)).rejects.toThrow();
    expect(await db().prepare('SELECT count(*) n FROM telemetry_v11_domain_heads').first('n')).toBe(0);
    expect(await db().prepare('SELECT count(*) n FROM telemetry_v11_domains').first('n')).toBe(0);
    expect(await db().prepare('SELECT count(*) n FROM storage_v11_owner_links').first('n')).toBe(0);
    expect(await changes()).toEqual([]);
  });
  it('captures social withdrawal and head deletion once, refusing missing or forged metadata', async () => {
    const fixture = await createV11DeviceFixture(db(), { grant: true }); await activate(fixture);
    const event = (await changes())[0]!;
    await expect(lookupV11StorageSource(db(), { ...event, contentDigest: 'd'.repeat(64) })).rejects.toThrow('V11_STORAGE_SOURCE_UNAVAILABLE');
    await expect(db().prepare('DELETE FROM storage_v11_event_sources').run()).rejects.toThrow('storage_v11_terminal_required');
    await db().prepare("UPDATE participants SET state='deleting', deletion_session_id='synthetic-fence' WHERE id=?").bind(fixture.participantId).run();
    expect((await changes()).map((item) => item.kind)).toEqual(['owner-active', 'owner-withdrawn']);
    await db().prepare('DELETE FROM telemetry_v11_domain_heads WHERE participant_id=?').bind(fixture.participantId).run();
    expect(await changes()).toHaveLength(2);
    expect(await lookupV11StorageSource(db(), event)).toMatchObject({ disposition: 'discard', reason: 'owner-withdrawn', terminalRevision: 2 });
  });
  it('keeps accepted accountless history active across ordinary opt-out and refuses future authority', async () => {
    const fixture = await accountlessFixture(); expect(await changes()).toEqual([]);
    const activated = await activate(fixture); const event = (await changes())[0]!;
    expect(await revokeAccountlessEnrollment(db(), fixture.deviceId, 'user_opt_out', Date.now())).toBe(true);
    expect((await changes()).map((item) => item.kind)).toEqual(['owner-active']);
    expect(await lookupV11StorageSource(db(), event)).toMatchObject({ disposition: 'generation' });
    expect(await db().prepare('SELECT participant_id FROM community_public_source_owners WHERE participant_id=?')
      .bind(fixture.participantId).first('participant_id')).toBe(fixture.participantId);
    expect(await db().prepare('SELECT generation_id,head_revision FROM accountless_public_history_retention WHERE participant_id=?')
      .bind(fixture.participantId).first()).toMatchObject({ generation_id: activated.result.generationId, head_revision: 1 });
    expect(await db().prepare('SELECT count(*) n FROM telemetry_v11_records').first('n')).toBeGreaterThan(0);
    expect((await db().prepare('PRAGMA table_info(accountless_public_history_retention)').all<{ name: string }>()).results
      .map((column) => column.name)).toEqual(['participant_id','enrollment_device_id','device_credential_id','generation_id','head_revision','retained_at']);
    expect(await db().prepare('SELECT state FROM storage_v11_owner_links WHERE participant_id=?')
      .bind(fixture.participantId).first('state')).toBe('active');
    await expect(authenticateDevice(db(),fixture.authorization)).rejects.toMatchObject({code:'DEVICE_AUTH_INVALID'});
    await revokeAccountlessEnrollment(db(), fixture.deviceId, 'user_opt_out', Date.now()); expect(await changes()).toHaveLength(1);
  });
  it('keeps containment a hard terminal withdrawal with no history marker', async () => {
    const fixture = await accountlessFixture(); await activate(fixture);const event=(await changes())[0]!;
    expect(await revokeAccountlessEnrollment(db(),fixture.deviceId,'security_reset',Date.now())).toBe(true);
    expect((await changes()).map(item=>item.kind)).toEqual(['owner-active','owner-withdrawn']);
    expect(await lookupV11StorageSource(db(),event)).toMatchObject({disposition:'discard',reason:'owner-withdrawn'});
    expect(await db().prepare('SELECT count(*) n FROM accountless_public_history_retention').first('n')).toBe(0);
  });
  it('withdraws retained history when containment follows an ordinary opt-out', async () => {
    const fixture = await accountlessFixture(); await activate(fixture); const event = (await changes())[0]!;
    expect(await revokeAccountlessEnrollment(db(), fixture.deviceId, 'user_opt_out', Date.now())).toBe(true);
    expect(await revokeAccountlessEnrollment(db(), fixture.deviceId, 'operator_containment', Date.now() + 1)).toBe(false);
    expect(await db().prepare('SELECT count(*) n FROM accountless_public_history_retention').first('n')).toBe(0);
    expect((await changes()).map((item) => item.kind)).toEqual(['owner-active', 'owner-withdrawn']);
    expect(await lookupV11StorageSource(db(), event)).toMatchObject({ disposition: 'discard', reason: 'owner-withdrawn' });
  });
  it.each(['ledger', 'owner', 'device', 'grant'] as const)('independently journals accountless %s authority withdrawal', async (kind) => {
    const fixture = await accountlessFixture(); await activate(fixture);
    const event = (await changes())[0]!, now = new Date().toISOString();
    if (kind === 'ledger') {
      await db().prepare("UPDATE accountless_enrollment_ledger SET state='revoked',revoked_at=?,revocation_reason='user_opt_out' WHERE device_id=?")
        .bind(now, fixture.deviceId).run();
    } else if (kind === 'device') {
      await db().prepare("UPDATE device_credentials SET state='revoked',revoked_at=? WHERE participant_id=?").bind(now, fixture.participantId).run();
    } else {
      const table = kind === 'owner' ? 'accountless_upload_owners' : 'accountless_v11_device_authorizations';
      // The baseline requires ledger revocation before these state transitions.
      // Any bridge event from a BEFORE trigger must roll back with that refusal.
      await expect(db().prepare(`UPDATE ${table} SET state='revoked',revoked_at=?,revocation_reason='user_opt_out' WHERE participant_id=?`)
        .bind(now, fixture.participantId).run()).rejects.toThrow('immutable');
      expect(await changes()).toHaveLength(1);
      await db().prepare(`DELETE FROM ${table} WHERE participant_id=?`).bind(fixture.participantId).run();
    }
    expect((await changes()).map((item) => item.kind)).toEqual(['owner-active', 'owner-withdrawn']);
    expect(await lookupV11StorageSource(db(), event)).toMatchObject({ disposition: 'discard', reason: 'owner-withdrawn' });
  });
  it('keeps source-proven terminal erasure after metadata and owner mapping are physically deleted', async () => {
    const fixture = await accountlessFixture(); await activate(fixture); await activate(fixture, ['a', 'b']);
    const old = (await changes())[1]!;
    await expect(eraseParticipantAsOwner(runtime(), 'e'.repeat(64), fixture.participantId)).resolves.toMatchObject({ deleted: true });
    expect(await db().prepare('SELECT count(*) n FROM storage_v11_owner_links').first('n')).toBe(0);
    expect(await db().prepare('SELECT count(*) n FROM storage_v11_event_sources').first('n')).toBe(0);
    const events = await changes(); expect(events.at(-1)!.kind).toBe('owner-erased');
    expect(events.filter((item) => item.kind === 'owner-withdrawn')).toHaveLength(1);
    expect(await lookupV11StorageSource(db(), old)).toMatchObject({ disposition: 'discard', reason: 'owner-erased', terminalRevision: events.at(-1)!.revision });
    expect(await lookupV11StorageSource(db(), events.at(-1)!)).toMatchObject({ disposition: 'discard', reason: 'owner-erased' });
  });
});
