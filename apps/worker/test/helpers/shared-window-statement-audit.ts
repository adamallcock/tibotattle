import { sha256Hex } from '../../src/crypto';
import { createD1InvocationBudget } from '../../src/d1-invocation-budget';
import type { AnalyticsStatementObservation } from './analytics-profile';

// Test instrumentation only. SQL, binds, native handles and Error stacks stay
// inside this collector; returned evidence contains closed labels and digests.
type Physical = 'source' | 'candidate' | 'reference' | 'ledger';
type Operation = 'native_work' | 'graph_scope' | 'graph_compute' | 'plan_acquire' |
  'plan_quota' | 'plan_model' | 'plan_scalar_page' | 'plan_full_seal';
type Category = 'setup' | 'native' | 'default' | 'proof';
type Shape = 'native_inventory' | 'batched_dependency_links' | 'singleton_dependency_links' |
  'feature_parts' | 'feature_heads' | 'checkpoint' | 'graph_result' | 'other';
type Callsite = { module: string; line: number | null; column: number | null };
type Charge = { statements: number; rowsRead: number; rowsWritten: number; databaseMs: number;
  failedStatements: number; invalidMetadata: number };
type Exemplar = { database: D1Database; sql: string; bound: unknown[]; boundBytes: number; rowsRead: number };
type Group = Charge & { phase: string; category: Category; operation: Operation; physical: Physical;
  shape: Shape; callsite: Callsite; normalizedSql: string; exemplar?: Exemplar };
type Prepared = { original: D1PreparedStatement; sql: string; bound: unknown[]; callsite: Callsite };
const sourceModules = new Set([
  'analytics-delivery.ts', 'storage-analytics-shared-features.ts', 'storage-community-graph.ts',
  'storage-effective-history.ts', 'storage-effective-dependency-days.ts',
  'storage-effective-dependency-summaries.ts', 'storage-effective-selective-dependencies.ts',
  'effective-history-dependency.ts', 'telemetry-v12-effective-reader.ts',
  'telemetry-usage-effective-reader.ts', 'quota-analysis-v11-reader.ts',
  'storage-history-checkpoint.ts', 'storage-community-authority.ts',
  'storage-community-daily-devices.ts', 'storage-analytics-runtime.ts',
  'storage-community-graph-work.ts', 'd1-schema-object-hints.ts',
]);
const charge = (): Charge => ({ statements: 0, rowsRead: 0, rowsWritten: 0, databaseMs: 0,
  failedStatements: 0, invalidMetadata: 0 });
const fail = () => new Error('SHARED_WINDOW_STATEMENT_AUDIT_INVALID');
function category(phase: string): Category {
  return phase.startsWith('graph_native_') ? 'native' : phase.startsWith('graph_shared_plan_') ? 'default'
    : ['unchanged_bulk_resource_witness', 'bounded_plan401_scope'].includes(phase) ? 'proof' : 'setup';
}
function shape(sql: string): Shape {
  return (sql.includes('SELECT DISTINCT observed_day FROM direct')
    || (sql.includes('inventory_days(day) AS MATERIALIZED') && sql.includes('WITH direct AS ('))) ? 'native_inventory'
    : sql.includes('/* batched occurrence links */') ? 'batched_dependency_links'
    : sql.includes('outside_headers AS') ? 'singleton_dependency_links'
    : sql.includes('FROM analytics_shared_feature_parts p') ? 'feature_parts'
    : sql.includes('analytics_shared_feature_days') ? 'feature_heads'
    : sql.includes('analytics_history_checkpoint_') ? 'checkpoint'
    : sql.includes('analytics_community_graph_results') ? 'graph_result' : 'other';
}
function callsite(): Callsite {
  // The stack is inspected once and immediately discarded. Never return it.
  for (const frame of (new Error().stack ?? '').split('\n')) {
    const match = frame.match(/\/src\/([^/():]+\.ts):(\d+):(\d+)/u);
    if (!match || match[1] === 'd1-invocation-budget.ts') continue;
    return sourceModules.has(match[1]!) ? { module: match[1]!, line: Number(match[2]), column: Number(match[3]) }
      : { module: 'unclassified_source', line: null, column: null };
  }
  return { module: 'unclassified', line: null, column: null };
}
function metadata(result: unknown) {
  const meta = (result as { meta?: { rows_read?: number; rows_written?: number; duration?: number } } | null)?.meta;
  if (!meta || [meta.rows_read, meta.rows_written, meta.duration].some(value =>
    typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return;
  return { rowsRead: meta.rows_read!, rowsWritten: meta.rows_written!, databaseMs: meta.duration! };
}
function add(into: Charge, value: Charge) {
  for (const key of ['statements', 'rowsRead', 'rowsWritten', 'databaseMs', 'failedStatements', 'invalidMetadata'] as const) into[key] += value[key];
}
function cloneBound(bound: readonly unknown[]): { values: unknown[]; bytes: number } | undefined {
  // Only SELECT exemplars, at most 16KiB of binds each. Never keep result rows.
  let length = 0;
  const values: unknown[] = [];
  for (const value of bound) {
    if (value === null || typeof value === 'number') { values.push(value); length += 8; }
    else if (typeof value === 'string') { length += new TextEncoder().encode(value).byteLength; values.push(value); }
    else return;
    if (length > 16_384) return;
  }
  return { values, bytes: length };
}
function planCategory(detail: string) {
  return /USE TEMP B-TREE/iu.test(detail) ? 'temporary_btree'
    : /CORRELATED.*SUBQUERY/iu.test(detail) ? 'correlated_subquery'
    : /SCALAR SUBQUERY/iu.test(detail) ? 'scalar_subquery'
    : /MATERIALIZE/iu.test(detail) ? 'materialize'
    : /CO-ROUTINE/iu.test(detail) ? 'coroutine'
    : /(?:SEARCH|SCAN).*USING COVERING INDEX/iu.test(detail) ? 'covering_index'
    : /SEARCH.*USING.*INDEX/iu.test(detail) ? 'index_search'
    : /SEARCH.*USING.*PRIMARY KEY/iu.test(detail) ? 'primary_key_search'
    : /SCAN.*USING.*INDEX/iu.test(detail) ? 'index_scan'
    : /^SCAN/iu.test(detail) ? 'scan'
    : /^SEARCH/iu.test(detail) ? 'other_search'
    : /UNION|COMPOUND QUERY/iu.test(detail) ? 'compound'
    : /LIST SUBQUERY/iu.test(detail) ? 'list_subquery' : 'other';
}

export function createSharedWindowStatementAudit() {
  const groups = new Map<string, Group>(), sqlIds = new Map<string, number>();
  let retainedSqlBytes = 0, retainedBoundBytes = 0, exemplarRetentionRefusals = 0;
  let operation: Operation = 'native_work', closed = false, observerFailures = 0;
  let activeInvocations = 0, observerStatements = 0, capturedStatements = 0;
  const limits = { maximumGroups: 4096, maximumExemplars: 512, maximumExplainPlans: 24,
    maximumPlansPerPhase: 6, maximumBindBytes: 16_384, maximumRetainedSqlBytes: 4 * 1024 * 1024,
    maximumRetainedBoundBytes: 2 * 1024 * 1024 } as const;
  let exemplars = 0;
  const observed = charge(), captured = charge();
  async function within<T>(next: Operation, run: () => Promise<T>): Promise<T> {
    if (closed || operation.startsWith('plan_')) { observerFailures++; throw fail(); }
    const prior = operation; operation = next;
    try { return await run(); } finally {
      if (operation !== next) { observerFailures++; operation = prior; throw fail(); }
      operation = prior;
    }
  }
  function begin(phase: string) {
    if (closed || activeInvocations !== 0) throw fail();
    activeInvocations++;
    const invocationObserved = charge(), invocationCaptured = charge();
    let ended = false;
    const observer = (sample: AnalyticsStatementObservation) => {
      const value = charge(); value.statements = 1;
      if (sample.outcome === 'failed') value.failedStatements = 1;
      else if (sample.outcome === 'invalid_metadata' || sample.rowsRead === null || sample.rowsWritten === null
        || sample.databaseMs === null) value.invalidMetadata = 1;
      else { value.rowsRead = sample.rowsRead; value.rowsWritten = sample.rowsWritten; value.databaseMs = sample.databaseMs; }
      add(invocationObserved, value); add(observed, value); observerStatements++;
    };
    function wrap(database: D1Database, physical: Physical): D1Database {
      const originals = new WeakMap<D1PreparedStatement, Prepared>();
      function record(prepared: Prepared, result: unknown, failed: boolean, dispatched: Operation) {
        const value = charge(); value.statements = 1;
        const meta = failed ? undefined : metadata(result);
        if (failed) value.failedStatements = 1;
        else if (!meta) value.invalidMetadata = 1;
        else Object.assign(value, meta);
        add(invocationCaptured, value); add(captured, value); capturedStatements++;
        const normalizedSql = prepared.sql; // Exact SQL, including literal whitespace.
        let sqlId = sqlIds.get(normalizedSql);
        if (sqlId === undefined) {
          retainedSqlBytes += new TextEncoder().encode(normalizedSql).byteLength;
          if (retainedSqlBytes > limits.maximumRetainedSqlBytes) { observerFailures++; throw fail(); }
          sqlId = sqlIds.size; sqlIds.set(normalizedSql, sqlId);
        }
        const site = prepared.callsite;
        const key = JSON.stringify([phase, dispatched, physical, sqlId, site.module, site.line, site.column]);
        let group = groups.get(key);
        if (!group) {
          if (groups.size >= limits.maximumGroups) { observerFailures++; throw fail(); }
          group = { ...charge(), phase, category: category(phase), operation: dispatched, physical,
            shape: shape(prepared.sql), callsite: site, normalizedSql };
          groups.set(key, group);
        }
        add(group, value);
        if ((group.category === 'native' || group.category === 'default') && meta && meta.rowsWritten === 0
          && /^(?:SELECT|WITH)\b/iu.test(normalizedSql.trimStart()) && (!group.exemplar || meta.rowsRead > group.exemplar.rowsRead)) {
          const bound = cloneBound(prepared.bound);
          const nextBoundBytes = retainedBoundBytes - (group.exemplar?.boundBytes ?? 0) + (bound?.bytes ?? 0);
          if (bound && (group.exemplar || exemplars < limits.maximumExemplars)
            && nextBoundBytes <= limits.maximumRetainedBoundBytes) {
            if (!group.exemplar) exemplars++;
            retainedBoundBytes = nextBoundBytes;
            group.exemplar = { database, sql: prepared.sql, bound: bound.values, boundBytes: bound.bytes, rowsRead: meta.rowsRead };
          } else exemplarRetentionRefusals++;
        }
      }
      function statement(prepared: Prepared): D1PreparedStatement {
        const proxy = new Proxy(prepared.original, { get(inner, key) {
          if (key === 'bind') return (...bound: unknown[]) => statement({ ...prepared,
            original: inner.bind(...bound), bound });
          if (key === 'first' || key === 'raw') return () => { observerFailures++; throw fail(); };
          if (key === 'all' || key === 'run') return async (...args: unknown[]) => {
            const dispatched = operation;
            let result: unknown;
            try { result = await Reflect.apply(Reflect.get(inner, key), inner, args); }
            catch (error) { record(prepared, undefined, true, dispatched); throw error; }
            record(prepared, result, false, dispatched); return result;
          };
          const value: unknown = Reflect.get(inner, key);
          return typeof value === 'function' ? value.bind(inner) : value;
        } });
        originals.set(proxy, prepared); return proxy;
      }
      return new Proxy(database, { get(inner, key) {
        if (key === 'constructor') return inner.constructor;
        if (key === 'prepare') return (sql: string) => statement({ original: inner.prepare(sql), sql, bound: [], callsite: callsite() });
        if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
          const prepared = statements.map(value => originals.get(value));
          if (prepared.some(value => !value)) { observerFailures++; throw fail(); }
          const dispatched = operation;
          let results: D1Result[];
          try { results = await inner.batch(prepared.map(value => value!.original)); }
          catch (error) { for (const value of prepared) record(value!, undefined, true, dispatched); throw error; }
          if (results.length !== prepared.length) { observerFailures++; throw fail(); }
          for (const [index, value] of prepared.entries()) record(value!, results[index], false, dispatched);
          return results;
        };
        if (key === 'exec' || key === 'withSession') return () => { observerFailures++; throw fail(); };
        const value: unknown = Reflect.get(inner, key);
        return typeof value === 'function' ? value.bind(inner) : value;
      } });
    }
    return { wrap, observer, finish(expected: { statements: number; rowsRead: number; rowsWritten: number;
      failedStatements: number; statementObserverFailures?: number }) {
      if (ended) throw fail(); ended = true; activeInvocations--;
      if (expected.statementObserverFailures !== 0 || invocationCaptured.invalidMetadata !== 0
        || invocationObserved.invalidMetadata !== 0) { observerFailures++; throw fail(); }
      for (const key of ['statements', 'rowsRead', 'rowsWritten', 'failedStatements'] as const) {
        if (invocationCaptured[key] !== expected[key] || invocationObserved[key] !== expected[key]) {
          observerFailures++; throw fail();
        }
      }
    } };
  }
  function instrumentPlan<T extends { loadQuota: (...args: never[]) => Promise<unknown>;
    loadModelUsage: (...args: never[]) => Promise<unknown>; seal: () => Promise<unknown>;
    usageReader: { readPage: (...args: never[]) => Promise<unknown> } }>(plan: T): T {
    const quota = plan.loadQuota, model = plan.loadModelUsage, seal = plan.seal, page = plan.usageReader.readPage;
    plan.loadQuota = (...args) => within('plan_quota', () => Reflect.apply(quota, plan, args));
    plan.loadModelUsage = (...args) => within('plan_model', () => Reflect.apply(model, plan, args));
    plan.seal = () => within('plan_full_seal', () => Reflect.apply(seal, plan, []));
    plan.usageReader.readPage = (...args) => within('plan_scalar_page', () => Reflect.apply(page, plan.usageReader, args));
    return plan;
  }
  async function evidence() {
    if (activeInvocations !== 0 || closed || observerFailures !== 0) throw fail();
    const rows = await Promise.all([...groups.values()].map(async group => ({ phase: group.phase,
      category: group.category, operation: group.operation, physical: group.physical, shape: group.shape,
      callsite: group.callsite, sqlShapeSha256: await sha256Hex(group.normalizedSql),
      statements: group.statements, rowsRead: group.rowsRead, rowsWritten: group.rowsWritten,
      databaseMs: group.databaseMs, failedStatements: group.failedStatements, invalidMetadata: group.invalidMetadata,
      explainEligible: group.exemplar !== undefined })));
    return { schema: 'shared-window-statement-charges-v1', limits, observerStatements, capturedStatements,
      observerFailures, observed, captured, retainedSqlBytes, retainedBoundBytes, exemplarRetentionRefusals, groups: rows,
      contract: 'Actual physical D1 statement metadata reconciled per invocation with the existing profiler and real950 meter; SQL, binds and stack data remain ephemeral. Module/line is preparation callsite, not per-node cost; unclassified remains explicit.' };
  }
  async function explain() {
    if (activeInvocations !== 0 || closed || observerFailures !== 0) throw fail();
    const phases = ['graph_native_fits', 'graph_shared_plan_fits', 'graph_native_model', 'graph_shared_plan_model'];
    const selected: { group: Group; phaseRowsRead: number }[] = [];
    for (const phase of phases) {
      const byShape = new Map<string, { group: Group; phaseRowsRead: number }>();
      for (const group of groups.values()) {
        if (group.phase !== phase || !group.exemplar) continue;
        const key = group.physical + ':' + group.normalizedSql;
        const current = byShape.get(key);
        if (current) { current.phaseRowsRead += group.rowsRead;
          if (group.exemplar.rowsRead > current.group.exemplar!.rowsRead) current.group = group; }
        else byShape.set(key, { group, phaseRowsRead: group.rowsRead });
      }
      selected.push(...[...byShape.values()].sort((a, b) => b.phaseRowsRead - a.phaseRowsRead).slice(0, limits.maximumPlansPerPhase));
    }
    if (selected.length > limits.maximumExplainPlans) throw fail();
    const proof = charge(), proofMeter = createD1InvocationBudget(950), started = performance.now(), plans = [];
    for (const { group, phaseRowsRead } of selected) {
      const example = group.exemplar!;
      // EXPLAIN executes after all measured work using the original same native
      // D1 handle and actual captured binds. It never runs the SELECT again.
      const result = await proofMeter.wrap(example.database).prepare('EXPLAIN QUERY PLAN ' + example.sql)
        .bind(...example.bound).all<{ id: number; parent: number; detail: string }>();
      const meta = metadata(result);
      if (!meta) { observerFailures++; throw fail(); }
      add(proof, { ...charge(), ...meta, statements: 1 });
      const categories: Record<string, number> = {}, nodes = [];
      for (const row of result.results) {
        if (typeof row.detail !== 'string' || !Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.parent)) throw fail();
        const category = planCategory(row.detail); categories[category] = (categories[category] ?? 0) + 1;
        nodes.push({ id: row.id, parent: row.parent, category, detailSha256: await sha256Hex(row.detail) });
      }
      plans.push({ phase: group.phase, physical: group.physical, sqlShapeSha256: await sha256Hex(group.normalizedSql),
        representativeCallsite: group.callsite, representativeRowsRead: example.rowsRead, phaseRowsRead,
        planCategories: categories, nodes, proofCharge: meta });
    }
    if (proofMeter.queriesUsed !== proof.statements) throw fail();
    const coverage = phases.map(phase => {
      const all = [...groups.values()].filter(group => group.phase === phase);
      return { phase, totalRowsRead: all.reduce((n, group) => n + group.rowsRead, 0),
        eligibleRowsRead: all.filter(group => group.exemplar).reduce((n, group) => n + group.rowsRead, 0),
        selectedRowsRead: selected.filter(value => value.group.phase === phase).reduce((n, value) => n + value.phaseRowsRead, 0) };
    });
    return { plans, coverage, proofCost: { ...proof, elapsedMs: performance.now() - started, queryCap: 950 },
      contract: 'At most6 dominant read SQL shapes per graph phase, at most24 post-measurement EXPLAIN QUERY PLAN statements against the same native DB. Plan details are digest/category only. D1 metadata charges whole statements; it does not attribute reads to individual plan nodes.' };
  }
  function close() { closed = true; groups.clear(); sqlIds.clear(); retainedSqlBytes = 0; retainedBoundBytes = 0; }
  return { begin, within, instrumentPlan, evidence, explain, close };
}
