const CLOSURE_TABLE = 'storage_existing_accountless_bootstrap_source_closure';
export const FROZEN_ACCOUNTLESS_SOURCE_TABLES = Object.freeze([
  'accountless_enrollment_issuance',
  'accountless_enrollment_ledger',
  'accountless_upload_owners',
  'accountless_v11_device_authorizations',
  'contributions',
  'device_credentials',
  'participants',
  'storage_source_state',
  'storage_v11_owner_links',
  'telemetry_contributions',
  'telemetry_v1_chunks',
  'telemetry_v11_chunks',
]);

export const ACCOUNTLESS_BOOTSTRAP_CLOSURE_DDL = `CREATE TABLE ${CLOSURE_TABLE}(
 singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
 operation_digest TEXT NOT NULL CHECK(length(operation_digest)=64),
 source_id TEXT NOT NULL,
 source_database_id TEXT NOT NULL,
 catalog_database_id TEXT NOT NULL,
 shard_id TEXT NOT NULL,
 binding_name TEXT NOT NULL,
 route_reservation_bytes INTEGER NOT NULL CHECK(route_reservation_bytes BETWEEN 1 AND 9000000000),
 closure_digest TEXT NOT NULL CHECK(length(closure_digest)=64),
 trigger_digest TEXT NOT NULL CHECK(length(trigger_digest)=64),
 state TEXT NOT NULL CHECK(state IN ('frozen','ready','released')),
 manifest_digest TEXT CHECK(manifest_digest IS NULL OR length(manifest_digest)=64),
 owner_roster_digest TEXT CHECK(owner_roster_digest IS NULL OR length(owner_roster_digest)=64),
 revision INTEGER NOT NULL CHECK(revision>=1),
 frozen_at INTEGER NOT NULL,
 released_at INTEGER
) STRICT`;

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const BINDING = /^[A-Z][A-Z0-9_]{0,63}$/;
const fail = code => { throw new Error(`D1_STORAGE_EXISTING_BOOTSTRAP_${code}`); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();
const q = value => `"${value.replaceAll('"', '""')}"`;
const triggerName = (table, operationDigest, verb) => `storage_bootstrap_${operationDigest.slice(0, 12)}_${table}_${verb}`;

function triggerSql(table, operationDigest, verb) {
  const event = verb === 'i' ? 'INSERT' : verb === 'u' ? 'UPDATE' : 'DELETE';
  const name = triggerName(table, operationDigest, verb);
  return `CREATE TRIGGER ${q(name)} BEFORE ${event} ON ${q(table)}
 WHEN EXISTS(SELECT 1 FROM ${CLOSURE_TABLE} WHERE singleton_id=1 AND operation_digest='${operationDigest}' AND state IN ('frozen','ready'))
 BEGIN SELECT RAISE(ABORT,'STORAGE_BOOTSTRAP_SOURCE_CLOSED'); END`;
}

export function existingAccountlessBootstrapTriggerSql(operationDigest) {
  if (!SHA.test(operationDigest)) fail('PLAN_INVALID');
  return FROZEN_ACCOUNTLESS_SOURCE_TABLES.flatMap(table => ['i', 'u', 'd'].map(verb => triggerSql(table, operationDigest, verb)));
}

function validatePlan(plan) {
  if (!exact(plan, ['schema', 'operationDigest', 'sourceId', 'sourceDatabase', 'catalogDatabase', 'shardId',
    'bindingName', 'routeReservationBytes', 'triggerDigest', 'sourceClosureDigest', 'expiresAt'])
    || plan.schema !== 'storage-existing-accountless-bootstrap-operation-v1'
    || !SHA.test(plan.operationDigest) || !SHA.test(plan.triggerDigest) || !SHA.test(plan.sourceClosureDigest)
    || !ID.test(plan.sourceId) || !ID.test(plan.shardId) || !BINDING.test(plan.bindingName)
    || !exact(plan.sourceDatabase, ['id', 'name']) || !exact(plan.catalogDatabase, ['id', 'name'])
    || !UUID.test(plan.sourceDatabase.id) || !UUID.test(plan.catalogDatabase.id)
    || plan.sourceDatabase.id === plan.catalogDatabase.id || plan.sourceDatabase.name === plan.catalogDatabase.name
    || !/^[a-z][a-z0-9-]{2,95}$/.test(plan.sourceDatabase.name)
    || !/^[a-z][a-z0-9-]{2,95}$/.test(plan.catalogDatabase.name)
    || !Number.isSafeInteger(plan.routeReservationBytes) || plan.routeReservationBytes < 1
    || plan.routeReservationBytes > 9_000_000_000 || !Number.isSafeInteger(plan.expiresAt)) fail('PLAN_INVALID');
  return plan;
}

async function objects(source, operationDigest) {
  const names = FROZEN_ACCOUNTLESS_SOURCE_TABLES.flatMap(table => ['i', 'u', 'd']
    .map(verb => triggerName(table, operationDigest, verb)));
  const rows = (await source.prepare(`SELECT type,name,sql FROM sqlite_schema
   WHERE name=? OR name IN (${names.map(() => '?').join(',')}) ORDER BY type,name LIMIT ?`)
    .bind(CLOSURE_TABLE, ...names, names.length + 2).all()).results;
  return { names, rows };
}

async function marker(source) {
  return source.prepare(`SELECT * FROM ${CLOSURE_TABLE} WHERE singleton_id=1`).first();
}

function assertMarker(row, plan, states) {
  if (!row || !states.includes(row.state) || row.operation_digest !== plan.operationDigest
    || row.source_id !== plan.sourceId || row.source_database_id !== plan.sourceDatabase.id
    || row.catalog_database_id !== plan.catalogDatabase.id || row.shard_id !== plan.shardId
    || row.binding_name !== plan.bindingName || row.route_reservation_bytes !== plan.routeReservationBytes
    || row.closure_digest !== plan.sourceClosureDigest || row.trigger_digest !== plan.triggerDigest
    || !Number.isSafeInteger(row.revision) || row.revision < 1) fail('SOURCE_CLOSURE_INVALID');
  return row;
}

async function ensureClosureTable(source) {
  const rows = (await source.prepare(`SELECT type,name,sql FROM sqlite_schema WHERE name=? LIMIT 2`)
    .bind(CLOSURE_TABLE).all()).results;
  if (rows.length === 0) {
    try { await source.prepare(ACCOUNTLESS_BOOTSTRAP_CLOSURE_DDL).run(); } catch { /* exact readback below */ }
  }
  const stable = (await source.prepare(`SELECT type,name,sql FROM sqlite_schema WHERE name=? LIMIT 2`)
    .bind(CLOSURE_TABLE).all()).results;
  if (stable.length !== 1 || stable[0].type !== 'table' || stable[0].name !== CLOSURE_TABLE
    || stable[0].sql !== ACCOUNTLESS_BOOTSTRAP_CLOSURE_DDL) fail('SOURCE_CLOSURE_INVALID');
}

async function assertClosed(source, plan) {
  const row = assertMarker(await marker(source), plan, ['frozen', 'ready']);
  const expected = existingAccountlessBootstrapTriggerSql(plan.operationDigest).sort();
  const { rows } = await objects(source, plan.operationDigest);
  const table = rows.filter(item => item.name === CLOSURE_TABLE);
  const triggers = rows.filter(item => item.type === 'trigger').map(item => item.sql).sort();
  if (table.length !== 1 || table[0].sql !== ACCOUNTLESS_BOOTSTRAP_CLOSURE_DDL
    || triggers.length !== expected.length || JSON.stringify(triggers) !== JSON.stringify(expected)) fail('SOURCE_NOT_CLOSED');
  return row.closure_digest;
}

async function freeze(source, plan, now) {
  await ensureClosureTable(source);
  const sql = existingAccountlessBootstrapTriggerSql(plan.operationDigest);
  try {
    await source.batch([
      source.prepare(`INSERT INTO ${CLOSURE_TABLE}(singleton_id,operation_digest,source_id,source_database_id,
       catalog_database_id,shard_id,binding_name,route_reservation_bytes,closure_digest,trigger_digest,state,
       manifest_digest,owner_roster_digest,revision,frozen_at,released_at)
       VALUES(1,?,?,?,?,?,?,?,?,?,'frozen',NULL,NULL,1,?,NULL) ON CONFLICT(singleton_id) DO NOTHING`)
        .bind(plan.operationDigest, plan.sourceId, plan.sourceDatabase.id, plan.catalogDatabase.id, plan.shardId,
          plan.bindingName, plan.routeReservationBytes, plan.sourceClosureDigest, plan.triggerDigest, now),
      ...sql.map(statement => source.prepare(statement)),
    ]);
  } catch { /* exact readback resolves a lost acknowledgement; conflicts fail below */ }
  await assertClosed(source, plan);
  return { state: (await marker(source)).state };
}

async function markReady(source, plan, manifest, now) {
  const current = assertMarker(await marker(source), plan, ['frozen', 'ready']);
  if (current.state === 'ready') {
    if (current.manifest_digest !== manifest.manifestDigest || current.owner_roster_digest !== manifest.ownerRosterDigest) fail('MANIFEST_CHANGED');
    return;
  }
  try {
    await source.prepare(`UPDATE ${CLOSURE_TABLE} SET state='ready',manifest_digest=?,owner_roster_digest=?,
     revision=revision+1 WHERE singleton_id=1 AND operation_digest=? AND state='frozen' AND revision=?`)
      .bind(manifest.manifestDigest, manifest.ownerRosterDigest, plan.operationDigest, current.revision).run();
  } catch { /* exact readback below */ }
  const ready = assertMarker(await marker(source), plan, ['ready']);
  if (ready.manifest_digest !== manifest.manifestDigest || ready.owner_roster_digest !== manifest.ownerRosterDigest) fail('MANIFEST_CHANGED');
}

async function advance(api, env, plan, now) {
  const policy = { sourceId: plan.sourceId, sourceClosureDigest: plan.sourceClosureDigest, shardId: plan.shardId,
    bindingName: plan.bindingName, routeReservationBytes: plan.routeReservationBytes,
    assertSourceClosed: () => assertClosed(env.SOURCE, plan) };
  const manifest = await api.extractExistingAccountlessBootstrapManifest(env.SOURCE, policy, 100);
  const result = await api.importExistingAccountlessBootstrapPage({ catalog: env.STORAGE_ROUTING_DB, source: env.SOURCE,
    manifest, policy, pageSize: 32, nowEpoch: now });
  if (result.complete) await markReady(env.SOURCE, plan, manifest, now);
  return { complete: result.complete, imported: result.imported, manifestDigest: manifest.manifestDigest,
    ownerRosterDigest: manifest.ownerRosterDigest, ownerCount: manifest.owners.length };
}

export async function existingAccountlessBootstrapReleaseAuthorization(api, plan, row) {
  return api.sha256Hex(`app-usagemonitor/storage-existing-accountless-bootstrap-release/v1\0${plan.operationDigest}\0${row.manifest_digest}\0${row.owner_roster_digest}\0${row.revision}`);
}

async function release(api, source, catalog, plan, authorization, now) {
  await assertClosed(source, plan);
  const current = assertMarker(await marker(source), plan, ['ready']);
  const progress = await catalog.prepare(`SELECT p.manifest_digest,p.state,m.owner_roster_digest,m.source_closure_digest,
   m.source_id,m.shard_id,m.binding_name,m.route_reservation_bytes
   FROM storage_existing_accountless_bootstrap_progress p
   JOIN storage_existing_accountless_bootstrap_manifests m ON m.singleton_id=p.singleton_id AND m.manifest_digest=p.manifest_digest
   WHERE p.singleton_id=1 LIMIT 2`).first();
  if (!progress || progress.state !== 'ready' || progress.manifest_digest !== current.manifest_digest
    || progress.owner_roster_digest !== current.owner_roster_digest || progress.source_closure_digest !== plan.sourceClosureDigest
    || progress.source_id !== plan.sourceId || progress.shard_id !== plan.shardId || progress.binding_name !== plan.bindingName
    || progress.route_reservation_bytes !== plan.routeReservationBytes) fail('CATALOG_NOT_READY');
  if (authorization !== await existingAccountlessBootstrapReleaseAuthorization(api, plan, current)) fail('RELEASE_NOT_AUTHORIZED');
  const triggerStatements = FROZEN_ACCOUNTLESS_SOURCE_TABLES.flatMap(table => ['i', 'u', 'd']
    .map(verb => source.prepare(`DROP TRIGGER ${q(triggerName(table, plan.operationDigest, verb))}`)));
  try {
    await source.batch([...triggerStatements, source.prepare(`UPDATE ${CLOSURE_TABLE} SET state='released',released_at=?,revision=revision+1
      WHERE singleton_id=1 AND operation_digest=? AND state='ready' AND revision=?`)
      .bind(now, plan.operationDigest, current.revision)]);
  } catch { /* exact readback below */ }
  const released = assertMarker(await marker(source), plan, ['released']);
  const { rows } = await objects(source, plan.operationDigest);
  if (rows.some(item => item.type === 'trigger')) fail('RELEASE_UNCERTAIN');
  return { state: released.state, revision: released.revision };
}

export function createExistingAccountlessBootstrapWorker({ api, plan, clock = () => Date.now() }) {
  plan = structuredClone(validatePlan(plan));
  const enabled = env => {
    if (env.STORAGE_EXISTING_BOOTSTRAP_MODE !== 'enabled' || !env.SOURCE || !env.STORAGE_ROUTING_DB
      || env.SOURCE === env.STORAGE_ROUTING_DB || clock() >= plan.expiresAt) fail('CONFIGURATION_INVALID');
  };
  return {
    fetch() { return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } }); },
    async queue(batch, env) {
      enabled(env);
      if (!Array.isArray(batch?.messages) || batch.messages.length !== 1) fail('MESSAGE_INVALID');
      const message = batch.messages[0], body = message.body;
      if (!body || !exact(body, body.action === 'release'
        ? ['schema', 'operationDigest', 'action', 'releaseAuthorization']
        : ['schema', 'operationDigest', 'action'])
        || body.schema !== 'storage-existing-accountless-bootstrap-wakeup-v1'
        || body.operationDigest !== plan.operationDigest || !['freeze', 'advance', 'release'].includes(body.action)
        || typeof message.ack !== 'function') fail('MESSAGE_INVALID');
      const now = clock();
      if (body.action === 'freeze') await freeze(env.SOURCE, plan, now);
      else if (body.action === 'advance') await advance(api, env, plan, now);
      else await release(api, env.SOURCE, env.STORAGE_ROUTING_DB, plan, body.releaseAuthorization, now);
      message.ack();
    },
  };
}
