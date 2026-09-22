import { storageSchemaDigest } from './d1-storage-plan.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const SOURCE_NAMESPACE = /^[A-Za-z0-9_.:-]{1,256}$/u;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const ROLE_NAMES = Object.freeze(['primary', 'analytics', 'ledger']);

/**
 * The production layout observed by the typed runtime. The caller still has
 * to supply this exact set; accepting a caller-selected subset would make a
 * missing analytics or deletion-ledger binding look like a successful check.
 */
export const TYPED_PRODUCTION_ROLE_BINDINGS = Object.freeze({
  primary: 'USAGE_MONITOR_DB',
  analytics: 'ANALYTICS_DB',
  ledger: 'DELETION_LEDGER',
});

/** Fixed SQL only. runTypedProductionPreflight never accepts SQL from its
 * caller and never performs a write. The result rows are deliberately small;
 * the schema query is the only bounded inventory read. */
export const TYPED_PRODUCTION_PREFLIGHT_SQL = Object.freeze({
  probe: 'SELECT 1 AS typed_preflight_probe',
  schema: "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND tbl_name <> 'd1_storage_migrations' ORDER BY type,name LIMIT 4097",
  sourceState: 'SELECT singleton,source_id,authority_epoch FROM storage_source_state WHERE singleton=1',
  v1Admission: 'SELECT id,source_namespace,namespace_id,runtime_contract_version FROM typed_v1_admission_state WHERE id=1',
  v11Admission: 'SELECT id,source_namespace,namespace_id,runtime_contract_version FROM typed_v11_admission_state WHERE id=1',
  analyticsRuntime: 'SELECT source_id,source_namespace,contract_version FROM analytics_runtime_sources ORDER BY source_id LIMIT 2',
});
export const TYPED_PRODUCTION_QUERIES = TYPED_PRODUCTION_PREFLIGHT_SQL;

const ROLE_SQL = Object.freeze({
  primary: Object.freeze(['probe', 'schema', 'sourceState', 'v1Admission', 'v11Admission']),
  analytics: Object.freeze(['probe', 'schema', 'analyticsRuntime']),
  ledger: Object.freeze(['probe', 'schema']),
});

const result = (ok, code, roles = [], blockers = [], queries = 0) => ({
  schema: 'production-typed-preflight-v1',
  ok,
  code,
  mode: 'typed',
  roles,
  blockers,
  queries,
});

const blocker = (role, binding, code, stage, details) => ({
  role,
  binding,
  code,
  ...(stage ? { stage } : {}),
  ...(details ? { details } : {}),
});

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validateRoles(roles) {
  if (!Array.isArray(roles) || roles.length !== ROLE_NAMES.length) return 'ROLES_INVALID';
  const seen = new Set();
  for (const entry of roles) {
    if (!exactKeys(entry, ['role', 'binding'])
        || !ROLE_NAMES.includes(entry.role)
        || entry.binding !== TYPED_PRODUCTION_ROLE_BINDINGS[entry.role]
        || seen.has(entry.role)) return 'ROLES_INVALID';
    seen.add(entry.role);
  }
  return ROLE_NAMES.every(role => seen.has(role)) ? null : 'ROLES_INVALID';
}

function validateExpectedSchemas(expectedSchemas) {
  if (!exactKeys(expectedSchemas, ROLE_NAMES)) return 'EXPECTED_SCHEMAS_INVALID';
  for (const role of ROLE_NAMES) {
    const expected = expectedSchemas[role];
    const expectedKeys = Object.keys(expected ?? {}).sort();
    if (!object(expected) || !expectedKeys.every(key => ['schemaSha256', 'requiredObjects', 'optionalObjects', 'restoredSchemaSha256'].includes(key))
        || !expectedKeys.includes('schemaSha256') || !expectedKeys.includes('requiredObjects')
        || !SHA256.test(expected.schemaSha256)
        || !Array.isArray(expected.requiredObjects)
        || expected.requiredObjects.length < 1
        || expected.requiredObjects.length > 4096) return 'EXPECTED_SCHEMAS_INVALID';
    const seen = new Set();
    for (const objectDescriptor of expected.requiredObjects) {
      if (!exactKeys(objectDescriptor, ['type', 'name', 'tbl_name'])
          || !['table', 'index', 'trigger', 'view'].includes(objectDescriptor.type)
          || !IDENTIFIER.test(objectDescriptor.name)
          || !IDENTIFIER.test(objectDescriptor.tbl_name)) return 'EXPECTED_SCHEMAS_INVALID';
      const key = `${objectDescriptor.type}\u0000${objectDescriptor.name}\u0000${objectDescriptor.tbl_name}`;
      if (seen.has(key)) return 'EXPECTED_SCHEMAS_INVALID';
      seen.add(key);
    }
    const optionalObjects = expected.optionalObjects ?? [];
    if (!Array.isArray(optionalObjects) || optionalObjects.length > 4096) return 'EXPECTED_SCHEMAS_INVALID';
    if (expected.restoredSchemaSha256 !== undefined
        && (role !== 'primary' || !optionalObjects.length || !Array.isArray(expected.restoredSchemaSha256)
          || expected.restoredSchemaSha256.length < 1 || expected.restoredSchemaSha256.length > 2
          || !expected.restoredSchemaSha256.every(value => typeof value === 'string' && SHA256.test(value)))) return 'EXPECTED_SCHEMAS_INVALID';
    for (const objectDescriptor of optionalObjects) {
      if (!exactKeys(objectDescriptor, ['type', 'name', 'tbl_name', 'sql'])
          || !['table', 'index', 'trigger', 'view'].includes(objectDescriptor.type)
          || !IDENTIFIER.test(objectDescriptor.name)
          || !IDENTIFIER.test(objectDescriptor.tbl_name)
          || typeof objectDescriptor.sql !== 'string' || objectDescriptor.sql.length < 1 || objectDescriptor.sql.length > 262144) {
        return 'EXPECTED_SCHEMAS_INVALID';
      }
      const key = `${objectDescriptor.type}\u0000${objectDescriptor.name}\u0000${objectDescriptor.tbl_name}`;
      if (seen.has(key)) return 'EXPECTED_SCHEMAS_INVALID';
      seen.add(key);
    }
  }
  return null;
}

function validateConfig(config) {
  const hasSourceId = exactKeys(config, ['mode', 'sourceId', 'sourceNamespace'])
    || exactKeys(config, ['mode', 'sourceNamespace']);
  if (!hasSourceId
      || config.mode !== 'typed'
      || (config.sourceId !== undefined && config.sourceId !== null && !SOURCE_ID.test(config.sourceId))
      || !SOURCE_NAMESPACE.test(config.sourceNamespace ?? '')) return 'CONFIG_INVALID';
  return null;
}

/** Validate only the closed local inputs. This does not inspect a database. */
export function validateTypedProductionConfiguration({ roles, expectedSchemas, config } = {}) {
  const roleError = validateRoles(roles);
  if (roleError) return { ok: false, code: `TYPED_PREFLIGHT_${roleError}` };
  const schemaError = validateExpectedSchemas(expectedSchemas);
  if (schemaError) return { ok: false, code: `TYPED_PREFLIGHT_${schemaError}` };
  const configError = validateConfig(config);
  if (configError) return { ok: false, code: `TYPED_PREFLIGHT_${configError}` };
  return { ok: true, code: null };
}

function queryRows(value) {
  // The Cloudflare API returns a one-element result array. Allow the already
  // unwrapped result object as well so the parent can inject a transport
  // adapter without exposing the provider response shape to this module.
  const entry = Array.isArray(value)
    ? value.length === 1 ? value[0] : null
    : value;
  if (!object(entry) || entry.success !== true || !Array.isArray(entry.results)
      || entry.results.length > 4096) return null;
  return entry.results;
}

function validSchemaRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 4096) return false;
  const seen = new Set();
  for (const row of rows) {
    if (!exactKeys(row, ['type', 'name', 'tbl_name', 'sql'])
        || !['table', 'index', 'trigger', 'view'].includes(row.type)
        || !IDENTIFIER.test(row.name)
        || !IDENTIFIER.test(row.tbl_name)
        || !(typeof row.sql === 'string' || row.sql === null)) return false;
    const key = `${row.type}\u0000${row.name}\u0000${row.tbl_name}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function expectedObjectSet(expected) {
  return new Set(expected.requiredObjects.map(row => `${row.type}\u0000${row.name}\u0000${row.tbl_name}`));
}

function optionalObjectMap(expected) {
  return new Map((expected.optionalObjects ?? []).map(row => [
    `${row.type}\u0000${row.name}\u0000${row.tbl_name}`,
    row,
  ]));
}

// Keep this in lockstep with storageSchemaDigest: only the exact provider DDL
// is ignored, and any attached user-visible object makes the provider table
// part of the observed schema again so an unexpected trigger cannot hide.
const KNOWN_PROVIDER_OBJECTS = Object.freeze([
  Object.freeze({ type: 'table', name: '_cf_KV', tbl_name: '_cf_KV', sql: 'CREATE TABLE _cf_KV (\n        key TEXT PRIMARY KEY,\n        value BLOB\n      ) WITHOUT ROWID' }),
  Object.freeze({ type: 'table', name: '_cf_METADATA', tbl_name: '_cf_METADATA', sql: 'CREATE TABLE _cf_METADATA (\n        key INTEGER PRIMARY KEY,\n        value BLOB\n      )' }),
]);

function schemaKey(row) {
  return `${row.type}:${row.name}`;
}

function schemaKeyValue(key) {
  const [type, name] = key.split('\u0000');
  return `${type}:${name}`;
}

function normalizedSchemaRows(rows) {
  return rows.filter(row => !KNOWN_PROVIDER_OBJECTS.some(provider =>
    Object.keys(provider).every(key => row[key] === provider[key])
    && !rows.some(attached => attached.tbl_name === provider.tbl_name
      && attached.name !== provider.name && attached.sql !== null)));
}

function schemaObservation(rows, expected) {
  if (!validSchemaRows(rows)) return { ok: false, code: 'SCHEMA_INVALID' };
  const normalized = normalizedSchemaRows(rows);
  const observed = new Set(normalized.map(row => `${row.type}\u0000${row.name}\u0000${row.tbl_name}`));
  const expectedObjects = expectedObjectSet(expected);
  const optionalObjects = optionalObjectMap(expected);
  const missingRows = expected.requiredObjects.filter(row => !observed.has(`${row.type}\u0000${row.name}\u0000${row.tbl_name}`));
  const optionalPresent = normalized.some(row => optionalObjects.has(`${row.type}\u0000${row.name}\u0000${row.tbl_name}`));
  const missingOptional = optionalPresent
    ? [...optionalObjects.keys()].filter(key => !observed.has(key)).sort()
    : [];
  const recognizedOptional = [];
  const additionalRows = normalized.filter(row => {
    const key = `${row.type}\u0000${row.name}\u0000${row.tbl_name}`;
    if (expectedObjects.has(key)) return false;
    const optional = optionalObjects.get(key);
    if (optional && optional.sql === row.sql) {
      recognizedOptional.push(row);
      return false;
    }
    return true;
  });
  const recognizedOptionalKeys = new Set(recognizedOptional.map(row => `${row.type}\u0000${row.name}\u0000${row.tbl_name}`));
  const digestRows = normalized.filter(row => !recognizedOptionalKeys.has(`${row.type}\u0000${row.name}\u0000${row.tbl_name}`));
  let schemaSha256;
  try {
    schemaSha256 = storageSchemaDigest(digestRows);
  } catch {
    return { ok: false, code: 'SCHEMA_INVALID' };
  }
  const digestMatches = schemaSha256 === expected.schemaSha256
    || (optionalPresent && !missingOptional.length && recognizedOptional.length === optionalObjects.size
      && (expected.restoredSchemaSha256 ?? []).includes(schemaSha256));
  if (missingRows.length || missingOptional.length || additionalRows.length || !digestMatches) {
    const missing = missingRows.map(schemaKey).sort();
    const additional = additionalRows.map(schemaKey).sort();
    return {
      ok: false,
      code: missing.length ? 'SCHEMA_OBJECT_MISSING' : missingOptional.length ? 'SCHEMA_OPTIONAL_GROUP_INCOMPLETE' : 'SCHEMA_MISMATCH',
      details: {
        expectedSchemaSha256: expected.schemaSha256,
        observedSchemaSha256: schemaSha256,
        missing: missing.slice(0, 16),
        missingCount: missing.length,
        additional: additional.slice(0, 16),
        additionalCount: additional.length,
        missingOptional: missingOptional.slice(0, 16).map(schemaKeyValue),
        missingOptionalCount: missingOptional.length,
      },
    };
  }
  return { ok: true, schemaSha256, objectCount: normalized.length, optionalObjectCount: recognizedOptional.length };
}

function oneRow(rows, keys) {
  return rows.length === 1 && exactKeys(rows[0], keys) ? rows[0] : null;
}

function probeRow(rows) {
  const row = oneRow(rows, ['typed_preflight_probe']);
  return row?.typed_preflight_probe === 1 ? row : null;
}

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function roleSummary(role, binding, expected, schema) {
  return {
    role,
    binding,
    status: 'qualified',
    schemaSha256: schema.schemaSha256,
    objectCount: schema.objectCount,
    optionalObjectCount: schema.optionalObjectCount,
    probes: ROLE_SQL[role].length,
    expectedSchemaSha256: expected.schemaSha256,
  };
}

/**
 * Run the bounded typed-layout qualification. `runQuery` is intentionally the
 * only injected side effect: it must execute the supplied fixed SQL read and
 * return a Cloudflare D1 `{ success, results }` result (or the one-element API
 * array). No arbitrary query, migration, write, config change, or ID is
 * admitted here.
 */
export async function runTypedProductionPreflight({ roles, runQuery, expectedSchemas, config } = {}) {
  const input = validateTypedProductionConfiguration({ roles, expectedSchemas, config });
  if (!input.ok) return result(false, input.code);
  if (typeof runQuery !== 'function') return result(false, 'TYPED_PREFLIGHT_QUERY_ADAPTER_INVALID');

  const summaries = [];
  let queries = 0;
  let observedSourceId = config.sourceId ?? null;
  const read = async (role, binding, key, stage) => {
    const sql = TYPED_PRODUCTION_PREFLIGHT_SQL[key];
    if (!sql || !ROLE_SQL[role].includes(key)) {
      return { ok: false, code: 'QUERY_NOT_ADMITTED' };
    }
    queries += 1;
    let value;
    try {
      value = await runQuery(binding, sql);
    } catch {
      return { ok: false, code: 'QUERY_FAILED', stage };
    }
    const rows = queryRows(value);
    return rows ? { ok: true, rows } : { ok: false, code: 'QUERY_RESULT_INVALID', stage };
  };

  const orderedRoles = [...roles].sort((left, right) => ROLE_NAMES.indexOf(left.role) - ROLE_NAMES.indexOf(right.role));
  const schemaReads = [];
  const schemaBlockers = [];
  for (const { role, binding } of orderedRoles) {
    const expected = expectedSchemas[role];
    const schemaRead = await read(role, binding, 'schema', 'schema');
    if (!schemaRead.ok) {
      schemaBlockers.push(blocker(role, binding, schemaRead.code, schemaRead.stage));
      continue;
    }
    const schema = schemaObservation(schemaRead.rows, expected);
    if (!schema.ok) {
      schemaBlockers.push(blocker(role, binding, schema.code, 'schema', schema.details));
      continue;
    }
    schemaReads.push({ role, binding, expected, schema });
  }
  if (schemaBlockers.length) {
    const first = schemaBlockers[0];
    return result(false, `TYPED_PREFLIGHT_${first.code}`, summaries, schemaBlockers, queries);
  }

  for (const { role, binding, expected, schema } of schemaReads) {
    const probeRead = await read(role, binding, 'probe', 'probe');
    if (!probeRead.ok) return result(false, `TYPED_PREFLIGHT_${probeRead.code}`, summaries, [blocker(role, binding, probeRead.code, probeRead.stage)], queries);
    if (!probeRow(probeRead.rows)) return result(false, 'TYPED_PREFLIGHT_PROBE_INVALID', summaries, [blocker(role, binding, 'PROBE_INVALID', 'probe')], queries);

    if (role === 'primary') {
      const stateRead = await read(role, binding, 'sourceState', 'source-state');
      if (!stateRead.ok) return result(false, `TYPED_PREFLIGHT_${stateRead.code}`, summaries, [blocker(role, binding, stateRead.code, stateRead.stage)], queries);
      const state = oneRow(stateRead.rows, ['authority_epoch', 'singleton', 'source_id']);
      if (!state || state.singleton !== 1 || !SOURCE_ID.test(state.source_id ?? '')
          || (observedSourceId !== null && state.source_id !== observedSourceId)
          || !safeInteger(state.authority_epoch)) {
        return result(false, 'TYPED_PREFLIGHT_SOURCE_STATE_INVALID', summaries, [blocker(role, binding, 'SOURCE_STATE_INVALID', 'source-state')], queries);
      }
      observedSourceId = state.source_id;
      const namespaces = [];
      for (const [key, stage] of [['v1Admission', 'v1-admission'], ['v11Admission', 'v11-admission']]) {
        const admissionRead = await read(role, binding, key, stage);
        if (!admissionRead.ok) return result(false, `TYPED_PREFLIGHT_${admissionRead.code}`, summaries, [blocker(role, binding, admissionRead.code, admissionRead.stage)], queries);
        const admission = oneRow(admissionRead.rows, ['id', 'namespace_id', 'runtime_contract_version', 'source_namespace']);
        if (!admission || admission.id !== 1 || admission.source_namespace !== config.sourceNamespace
            || !safeInteger(admission.namespace_id, 1) || admission.runtime_contract_version !== 1) {
          return result(false, 'TYPED_PREFLIGHT_NAMESPACE_INVALID', summaries, [blocker(role, binding, 'NAMESPACE_INVALID', stage)], queries);
        }
        namespaces.push(admission.namespace_id);
      }
      if (namespaces[0] !== namespaces[1]) {
        return result(false, 'TYPED_PREFLIGHT_NAMESPACE_MISMATCH', summaries, [blocker(role, binding, 'NAMESPACE_MISMATCH', 'admission')], queries);
      }
    } else if (role === 'analytics') {
      const runtimeRead = await read(role, binding, 'analyticsRuntime', 'analytics-runtime');
      if (!runtimeRead.ok) return result(false, `TYPED_PREFLIGHT_${runtimeRead.code}`, summaries, [blocker(role, binding, runtimeRead.code, runtimeRead.stage)], queries);
      const runtime = oneRow(runtimeRead.rows, ['contract_version', 'source_id', 'source_namespace']);
      if (!runtime || !SOURCE_ID.test(runtime.source_id ?? '') || runtime.source_id !== observedSourceId
          || runtime.source_namespace !== config.sourceNamespace
          || runtime.contract_version !== 1) {
        return result(false, 'TYPED_PREFLIGHT_ANALYTICS_RUNTIME_INVALID', summaries, [blocker(role, binding, 'ANALYTICS_RUNTIME_INVALID', 'analytics-runtime')], queries);
      }
    }
    summaries.push(roleSummary(role, binding, expected, schema));
  }
  return result(true, 'TYPED_PRODUCTION_PREFLIGHT_PASSED', summaries, [], queries);
}
