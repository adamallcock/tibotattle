import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storageSchemaDigest } from './d1-storage-plan.mjs';
import {
  TYPED_PRODUCTION_QUERIES,
  TYPED_PRODUCTION_ROLE_BINDINGS,
  runTypedProductionPreflight,
  validateTypedProductionConfiguration,
} from './production-typed-preflight.mjs';
import {
  TYPED_SCHEMA_INPUT_DIRECTORIES,
  buildTypedProductionExpectedSchemas,
  WRANGLER_MIGRATION_LEDGER_SCHEMA,
} from './production-typed-schema.mjs';

const roles = Object.freeze([
  { role: 'primary', binding: TYPED_PRODUCTION_ROLE_BINDINGS.primary },
  { role: 'analytics', binding: TYPED_PRODUCTION_ROLE_BINDINGS.analytics },
  { role: 'ledger', binding: TYPED_PRODUCTION_ROLE_BINDINGS.ledger },
]);
const config = Object.freeze({ mode: 'typed', sourceId: 'source-main', sourceNamespace: 'namespace-main' });
const rowsFor = role => {
  const common = [
    { type: 'table', name: `${role}_schema`, tbl_name: `${role}_schema`, sql: `CREATE TABLE ${role}_schema(id INTEGER PRIMARY KEY)` },
  ];
  if (role === 'primary') common.push(
    { type: 'table', name: 'storage_source_state', tbl_name: 'storage_source_state', sql: 'CREATE TABLE storage_source_state(singleton INTEGER PRIMARY KEY, source_id TEXT, authority_epoch INTEGER)' },
    { type: 'table', name: 'typed_v1_admission_state', tbl_name: 'typed_v1_admission_state', sql: 'CREATE TABLE typed_v1_admission_state(id INTEGER PRIMARY KEY, source_namespace TEXT, namespace_id INTEGER, runtime_contract_version INTEGER)' },
    { type: 'table', name: 'typed_v11_admission_state', tbl_name: 'typed_v11_admission_state', sql: 'CREATE TABLE typed_v11_admission_state(id INTEGER PRIMARY KEY, source_namespace TEXT, namespace_id INTEGER, runtime_contract_version INTEGER)' },
  );
  if (role === 'analytics') common.push(
    { type: 'table', name: 'analytics_runtime_sources', tbl_name: 'analytics_runtime_sources', sql: 'CREATE TABLE analytics_runtime_sources(source_id TEXT, source_namespace TEXT, contract_version INTEGER)' },
  );
  return common;
};
const expectedSchemas = Object.fromEntries(roles.map(({ role }) => {
  const rows = rowsFor(role);
  return [role, {
    schemaSha256: storageSchemaDigest(rows),
    requiredObjects: rows.map(({ type, name, tbl_name }) => ({ type, name, tbl_name })),
  }];
}));
const response = results => ({ success: true, results });

function queryFixture({ sourceId = config.sourceId, namespace = config.sourceNamespace, mutate = () => {} } = {}) {
  const calls = [];
  return {
    calls,
    async runQuery(binding, sql) {
      calls.push({ binding, sql });
      const role = Object.entries(TYPED_PRODUCTION_ROLE_BINDINGS).find(([, name]) => name === binding)?.[0];
      assert.ok(role, `unexpected binding ${binding}`);
      mutate({ binding, sql, role });
      if (sql === TYPED_PRODUCTION_QUERIES.schema) return response(rowsFor(role));
      if (sql === TYPED_PRODUCTION_QUERIES.probe) return response([{ typed_preflight_probe: 1 }]);
      if (sql === TYPED_PRODUCTION_QUERIES.sourceState) return response([{ singleton: 1, source_id: sourceId, authority_epoch: 0 }]);
      if (sql === TYPED_PRODUCTION_QUERIES.v1Admission || sql === TYPED_PRODUCTION_QUERIES.v11Admission) {
        return response([{ id: 1, source_namespace: namespace, namespace_id: 7, runtime_contract_version: 1 }]);
      }
      if (sql === TYPED_PRODUCTION_QUERIES.analyticsRuntime) return response([{ source_id: sourceId, source_namespace: namespace, contract_version: 1 }]);
      throw new Error('unadmitted fixture query');
    },
  };
}

test('closed configuration requires all typed roles and candidate-owned schema pins', () => {
  assert.deepEqual(validateTypedProductionConfiguration({ roles, expectedSchemas, config }), { ok: true, code: null });
  assert.equal(validateTypedProductionConfiguration({ roles: roles.slice(0, 2), expectedSchemas, config }).code, 'TYPED_PREFLIGHT_ROLES_INVALID');
  assert.equal(validateTypedProductionConfiguration({ roles, expectedSchemas: { ...expectedSchemas, extra: expectedSchemas.primary }, config }).code, 'TYPED_PREFLIGHT_EXPECTED_SCHEMAS_INVALID');
  assert.equal(validateTypedProductionConfiguration({ roles, expectedSchemas, config: { ...config, mode: 'json' } }).code, 'TYPED_PREFLIGHT_CONFIG_INVALID');
  assert.equal(validateTypedProductionConfiguration({ roles, expectedSchemas, config: { mode: 'typed', sourceNamespace: config.sourceNamespace } }).ok, true);
});

test('typed preflight reads fixed schema/runtime probes and returns sanitized success', async () => {
  const fixture = queryFixture();
  const result = await runTypedProductionPreflight({ roles: [...roles].reverse(), runQuery: fixture.runQuery, expectedSchemas, config });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'TYPED_PRODUCTION_PREFLIGHT_PASSED');
  assert.equal(result.queries, 10);
  assert.deepEqual(result.roles.map(row => row.role), ['primary', 'analytics', 'ledger']);
  assert.ok(result.roles.every(row => row.status === 'qualified' && row.objectCount > 0));
  assert.deepEqual(Object.keys(result.blockers), []);
  assert.ok(fixture.calls.every(call => Object.values(TYPED_PRODUCTION_QUERIES).includes(call.sql)));
});

test('primary singleton pins source identity when sourceId is not available in config', async () => {
  const fixture = queryFixture({ sourceId: 'source-from-singleton' });
  const result = await runTypedProductionPreflight({ roles, runQuery: fixture.runQuery, expectedSchemas, config: { mode: 'typed', sourceNamespace: config.sourceNamespace } });
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes('source-from-singleton'));
});

test('schema drift reports bounded object names while query failures remain sanitized', async () => {
  const unknown = queryFixture();
  const malformed = await runTypedProductionPreflight({ roles, runQuery: async (binding, sql) => {
    if (sql === TYPED_PRODUCTION_QUERIES.schema && binding === TYPED_PRODUCTION_ROLE_BINDINGS.primary) {
      return response([...rowsFor('primary'), { type: 'table', name: 'unexpected', tbl_name: 'unexpected', sql: 'CREATE TABLE unexpected(id INTEGER)' }]);
    }
    return unknown.runQuery(binding, sql);
  }, expectedSchemas, config });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'TYPED_PREFLIGHT_SCHEMA_MISMATCH');
  assert.deepEqual(malformed.blockers[0].details.additional, ['table:unexpected']);
  assert.equal(JSON.stringify(malformed).includes('CREATE TABLE unexpected'), false);

  const failed = await runTypedProductionPreflight({ roles, runQuery: async () => { throw new Error('secret provider response'); }, expectedSchemas, config });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'TYPED_PREFLIGHT_QUERY_FAILED');
  assert.equal(JSON.stringify(failed).includes('secret provider response'), false);

  const invalid = await runTypedProductionPreflight({ roles, runQuery: async () => response([{ typed_preflight_probe: 2 }]), expectedSchemas, config });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'TYPED_PREFLIGHT_SCHEMA_INVALID');
});

test('schema phase inventories every role before runtime probes and ignores only exact provider tables', async () => {
  const calls = [];
  const provider = { type: 'table', name: '_cf_KV', tbl_name: '_cf_KV', sql: 'CREATE TABLE _cf_KV (\n        key TEXT PRIMARY KEY,\n        value BLOB\n      ) WITHOUT ROWID' };
  const drifted = await runTypedProductionPreflight({ roles, expectedSchemas, config, runQuery: async (binding, sql) => {
    calls.push({ binding, sql });
    const role = Object.entries(TYPED_PRODUCTION_ROLE_BINDINGS).find(([, value]) => value === binding)?.[0];
    if (sql === TYPED_PRODUCTION_QUERIES.schema) {
      const rows = rowsFor(role);
      if (role === 'primary') rows.splice(rows.findIndex(row => row.name === 'primary_schema'), 1);
      if (role === 'analytics') rows.push(provider);
      if (role === 'ledger') rows.push({ ...provider, sql: 'CREATE TABLE _cf_KV(changed INTEGER)' });
      return response(rows);
    }
    return queryFixture().runQuery(binding, sql);
  }});
  assert.equal(drifted.ok, false);
  assert.equal(drifted.queries, 3);
  assert.equal(drifted.blockers.length, 2);
  assert.deepEqual(drifted.blockers[0].details.missing, ['table:primary_schema']);
  assert.equal(drifted.blockers[1].details.additional[0], 'table:_cf_KV');
  assert.equal(calls.filter(call => call.sql === TYPED_PRODUCTION_QUERIES.schema).length, 3);
  assert.equal(calls.some(call => call.sql === TYPED_PRODUCTION_QUERIES.probe), false);
});

test('known Wrangler ledger DDL is exact and attached objects remain drift', async () => {
  const ledgerRows = [...rowsFor('ledger'), WRANGLER_MIGRATION_LEDGER_SCHEMA];
  const ledgerExpected = {
    schemaSha256: storageSchemaDigest(ledgerRows),
    requiredObjects: ledgerRows.map(({ type, name, tbl_name }) => ({ type, name, tbl_name })),
  };
  const expectedWithLedger = { ...expectedSchemas, ledger: ledgerExpected };
  const run = mutation => runTypedProductionPreflight({ roles, expectedSchemas: expectedWithLedger, config,
    runQuery: async (binding, sql) => {
      const role = Object.entries(TYPED_PRODUCTION_ROLE_BINDINGS).find(([, value]) => value === binding)?.[0];
      if (sql === TYPED_PRODUCTION_QUERIES.schema) {
        const rows = role === 'ledger' ? mutation(ledgerRows) : rowsFor(role);
        return response(rows);
      }
      return queryFixture().runQuery(binding, sql);
    } });
  const altered = await run(rows => rows.map(row => row.name === 'd1_migrations'
    ? { ...row, sql: 'CREATE TABLE "d1_migrations"(changed INTEGER)' } : row));
  assert.equal(altered.ok, false);
  assert.equal(altered.code, 'TYPED_PREFLIGHT_SCHEMA_MISMATCH');
  assert.equal(altered.blockers[0].details.additionalCount, 0);
  const attached = await run(rows => [...rows, {
    type: 'trigger', name: 'unexpected_d1_trigger', tbl_name: 'd1_migrations', sql: 'CREATE TRIGGER unexpected_d1_trigger AFTER INSERT ON d1_migrations BEGIN SELECT 1; END',
  }]);
  assert.equal(attached.ok, false);
  assert.equal(attached.code, 'TYPED_PREFLIGHT_SCHEMA_MISMATCH');
  assert.deepEqual(attached.blockers[0].details.additional, ['trigger:unexpected_d1_trigger']);
});

test('source-defined restore metadata is optional only when its exact DDL is present', async () => {
  const optional = {
    type: 'table',
    name: '_authority_restore_run',
    tbl_name: '_authority_restore_run',
    sql: 'CREATE TABLE _authority_restore_run(id INTEGER PRIMARY KEY CHECK(id=1)) STRICT',
  };
  const optionalSecond = {
    type: 'table',
    name: '_authority_restore_tables',
    tbl_name: '_authority_restore_tables',
    sql: 'CREATE TABLE _authority_restore_tables(name TEXT PRIMARY KEY) STRICT',
  };
  const expectedWithOptional = {
    ...expectedSchemas,
    primary: { ...expectedSchemas.primary, optionalObjects: [optional, optionalSecond] },
  };
  const fresh = await runTypedProductionPreflight({ roles, expectedSchemas: expectedWithOptional, config,
    runQuery: queryFixture().runQuery });
  assert.equal(fresh.ok, true);
  const withRestore = queryFixture();
  const retained = await runTypedProductionPreflight({ roles, expectedSchemas: expectedWithOptional, config,
    runQuery: async (binding, sql) => {
      if (binding === TYPED_PRODUCTION_ROLE_BINDINGS.primary && sql === TYPED_PRODUCTION_QUERIES.schema) {
        return response([...rowsFor('primary'), optional, optionalSecond]);
      }
      return withRestore.runQuery(binding, sql);
    } });
  assert.equal(retained.ok, true);
  assert.equal(retained.roles.find(row => row.role === 'primary')?.optionalObjectCount, 2);

  const partial = await runTypedProductionPreflight({ roles, expectedSchemas: expectedWithOptional, config,
    runQuery: async (binding, sql) => {
      if (binding === TYPED_PRODUCTION_ROLE_BINDINGS.primary && sql === TYPED_PRODUCTION_QUERIES.schema) {
        return response([...rowsFor('primary'), optional]);
      }
      return withRestore.runQuery(binding, sql);
    } });
  assert.equal(partial.ok, false);
  assert.equal(partial.code, 'TYPED_PREFLIGHT_SCHEMA_OPTIONAL_GROUP_INCOMPLETE');
  assert.deepEqual(partial.blockers[0].details.missingOptional, ['table:_authority_restore_tables']);

  const altered = await runTypedProductionPreflight({ roles, expectedSchemas: expectedWithOptional, config,
    runQuery: async (binding, sql) => {
      if (binding === TYPED_PRODUCTION_ROLE_BINDINGS.primary && sql === TYPED_PRODUCTION_QUERIES.schema) {
        return response([...rowsFor('primary'), { ...optional, sql: `${optional.sql} ` }, optionalSecond]);
      }
      return withRestore.runQuery(binding, sql);
    } });
  assert.equal(altered.ok, false);
  assert.equal(altered.code, 'TYPED_PREFLIGHT_SCHEMA_MISMATCH');
  assert.deepEqual(altered.blockers[0].details.additional, ['table:_authority_restore_run']);

  const attached = await runTypedProductionPreflight({ roles, expectedSchemas: expectedWithOptional, config,
    runQuery: async (binding, sql) => {
      if (binding === TYPED_PRODUCTION_ROLE_BINDINGS.primary && sql === TYPED_PRODUCTION_QUERIES.schema) {
        return response([...rowsFor('primary'), optional, {
          type: 'trigger', name: '_authority_restore_unreviewed', tbl_name: '_authority_restore_run',
          sql: 'CREATE TRIGGER _authority_restore_unreviewed AFTER INSERT ON _authority_restore_run BEGIN SELECT 1; END',
        }]);
      }
      return withRestore.runQuery(binding, sql);
    } });
  assert.equal(attached.ok, false);
  assert.deepEqual(attached.blockers[0].details.additional, ['trigger:_authority_restore_unreviewed']);
});

test('runtime namespace and analytics registration mismatches are refused', async () => {
  const fixture = queryFixture({ namespace: 'wrong-namespace' });
  const result = await runTypedProductionPreflight({ roles, runQuery: fixture.runQuery, expectedSchemas, config });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TYPED_PREFLIGHT_NAMESPACE_INVALID');

  const mismatch = await runTypedProductionPreflight({ roles, runQuery: async (binding, sql) => {
    const value = await queryFixture().runQuery(binding, sql);
    if (sql === TYPED_PRODUCTION_QUERIES.analyticsRuntime) return response([{ source_id: 'other-source', source_namespace: config.sourceNamespace, contract_version: 1 }]);
    return value;
  }, expectedSchemas, config });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'TYPED_PREFLIGHT_ANALYTICS_RUNTIME_INVALID');
});

test('canonical expected schemas are generated from local migration inputs only', async () => {
  const workerDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
  const generated = await buildTypedProductionExpectedSchemas({ workerDirectory });
  assert.equal(generated.schema, 'production-typed-schema-v1');
  assert.deepEqual(Object.keys(generated.expectedSchemas).sort(), ['analytics', 'ledger', 'primary']);
  assert.deepEqual(Object.keys(generated.inputSha256).sort(), ['analytics', 'ledger', 'primary']);
  for (const role of ['primary', 'analytics', 'ledger']) {
    assert.ok(/^[a-f0-9]{64}$/.test(generated.expectedSchemas[role].schemaSha256));
    assert.ok(generated.expectedSchemas[role].requiredObjects.length > 0);
    assert.equal(generated.migrationCounts[role], TYPED_SCHEMA_INPUT_DIRECTORIES[role].reduce((count, directory) => count + (directory === 'migrations' ? 62 : directory === 'typed-ingestion-migrations' ? 4 : directory === 'ingestion-bridge-migrations' ? 2 : directory === 'typed-v11-admission-migrations' ? 6 : directory === 'typed-v1-admission-migrations' ? 3 : directory === 'ingestion-isolation-migrations' ? 12 : directory === 'analytics-migrations' ? 27 : 3), 0));
  }
  assert.equal(generated.expectedSchemas.primary.optionalObjects.length, 17);
  assert.equal(generated.expectedSchemas.primary.restoredSchemaSha256.length, 3);
  assert.deepEqual(validateTypedProductionConfiguration({ roles, expectedSchemas: generated.expectedSchemas, config }), { ok: true, code: null });
  assert.deepEqual(generated.expectedSchemas.analytics.optionalObjects, []);
  assert.match(generated.operatorSchemaSourceSha256, /^[a-f0-9]{64}$/u);
});

test('restored schema variants require complete exact metadata and reject other SQL drift', async () => {
  const metadata = { type: 'table', name: '_authority_restore_run', tbl_name: '_authority_restore_run',
    sql: 'CREATE TABLE _authority_restore_run(id INTEGER PRIMARY KEY)' };
  const restoredRows = rowsFor('primary').map(row => row.name === 'primary_schema'
    ? { ...row, sql: 'CREATE TABLE "primary_schema"(id INTEGER PRIMARY KEY)' } : row);
  const expectation = { ...expectedSchemas, primary: { ...expectedSchemas.primary,
    optionalObjects: [metadata], restoredSchemaSha256: [storageSchemaDigest(restoredRows)] } };
  const run = rows => runTypedProductionPreflight({ roles, expectedSchemas: expectation, config,
    runQuery: (binding, sql) => binding === TYPED_PRODUCTION_ROLE_BINDINGS.primary && sql === TYPED_PRODUCTION_QUERIES.schema
      ? response(rows) : queryFixture().runQuery(binding, sql) });
  assert.equal((await run([...restoredRows, metadata])).ok, true);
  assert.equal((await run(restoredRows)).ok, false);
  assert.equal((await run([...restoredRows, { ...metadata, sql: metadata.sql + ' ' }])).ok, false);
  assert.equal((await run([...restoredRows.map(row => ({ ...row, sql: row.sql + ' ' })), metadata])).ok, false);
});

test('accepts a generated typed-evidence digest and refuses a forged variant', async () => {
  const metadata = { type: 'table', name: '_authority_restore_run', tbl_name: '_authority_restore_run',
    sql: 'CREATE TABLE _authority_restore_run(id INTEGER PRIMARY KEY)' };
  const sourceRows = [...rowsFor('primary'), {
    type: 'table', name: 'telemetry_usage_correction_facts', tbl_name: 'telemetry_usage_correction_facts',
    sql: 'CREATE TABLE telemetry_usage_correction_facts(id INTEGER PRIMARY KEY)',
  }];
  const typedEvidenceRows = sourceRows.map(row => row.type === 'table'
    ? { ...row, sql: row.sql.replace(/^(CREATE TABLE )([A-Za-z_][A-Za-z0-9_]*)/u, '$1"$2"') }
    : row);
  const typedEvidenceDigest = storageSchemaDigest(typedEvidenceRows);
  const legacyDigest = storageSchemaDigest(sourceRows);
  const extensionDigest = storageSchemaDigest(sourceRows.map(row => row.name === 'telemetry_usage_correction_facts'
    ? { ...row, sql: `${row.sql} ` } : row));
  const expectation = {
    ...expectedSchemas,
    primary: {
      ...expectedSchemas.primary,
      schemaSha256: legacyDigest,
      requiredObjects: sourceRows.map(({ type, name, tbl_name }) => ({ type, name, tbl_name })),
      optionalObjects: [metadata],
      restoredSchemaSha256: [legacyDigest, extensionDigest, typedEvidenceDigest],
    },
  };
  const fixture = queryFixture();
  const runQuery = async (binding, sql) => {
    if (binding === TYPED_PRODUCTION_ROLE_BINDINGS.primary && sql === TYPED_PRODUCTION_QUERIES.schema) {
      return response([...typedEvidenceRows, metadata]);
    }
    return fixture.runQuery(binding, sql);
  };
  const accepted = await runTypedProductionPreflight({ roles, runQuery, expectedSchemas: expectation, config });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.roles.find(row => row.role === 'primary')?.schemaSha256, typedEvidenceDigest);

  const forged = await runTypedProductionPreflight({
    roles,
    runQuery,
    expectedSchemas: {
      ...expectation,
      primary: { ...expectation.primary, restoredSchemaSha256: [legacyDigest, extensionDigest,
        `${typedEvidenceDigest.slice(0, -1)}${typedEvidenceDigest.endsWith('0') ? '1' : '0'}`] },
    },
    config,
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'TYPED_PREFLIGHT_SCHEMA_MISMATCH');
  assert.equal(forged.blockers[0].details.observedSchemaSha256, typedEvidenceDigest);
});
