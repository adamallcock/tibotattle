import { createHash } from 'node:crypto';
import providerSchemas from '../src/d1-provider-schema.json' with { type: 'json' };

// Operational experiment only. No application, scheduled handler or public
// reader imports this module. The laboratory accepts synthetic records only.
export const LAB_METHOD = 'analytics-shard-synthetic-lab-v1';
export const LAB_MAX_ROWS = 10_000_000;
export const LAB_PAGE_ROWS = 10_000;
export const LAB_DDL = Object.freeze([
  'CREATE TABLE shard_lab_records(id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL,occurrence_id BLOB NOT NULL,format INTEGER NOT NULL CHECK(format IN(10,11)),stream INTEGER NOT NULL CHECK(stream BETWEEN 1 AND 3),observed_day INTEGER NOT NULL) STRICT',
  'CREATE INDEX shard_lab_owner_occurrence ON shard_lab_records(owner_id,occurrence_id,format,stream,observed_day)',
  'CREATE TABLE shard_lab_progress(id INTEGER PRIMARY KEY CHECK(id=1),run_sha TEXT NOT NULL CHECK(length(run_sha)=64),target INTEGER NOT NULL,segment INTEGER NOT NULL,after_id INTEGER NOT NULL,records INTEGER NOT NULL,step INTEGER NOT NULL,last_page TEXT,state TEXT NOT NULL CHECK(state IN(\'loading\',\'ready\'))) STRICT',
  'CREATE TABLE shard_lab_guard(value INTEGER NOT NULL CHECK(value=1)) STRICT',
]);
const fail = code => { throw Object.assign(new Error(`SHARD_LAB_${code}`), { code: `SHARD_LAB_${code}` }); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const hash = text => createHash('sha256').update(text).digest('hex');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join() === [...keys].sort().join();
export const labDigest = value => hash(JSON.stringify(value));

/** Placement metadata only: formats, devices, dates and correction revisions
 * cannot change the bucket of an already identified continuity group. */
export function continuityBucket(namespace, scopeDigest) {
  if (typeof namespace !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(namespace)
    || typeof scopeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(scopeDigest)) fail('SCOPE_INVALID');
  return Number.parseInt(hash(JSON.stringify([LAB_METHOD, namespace, scopeDigest])).slice(0, 2), 16);
}

/** Deterministic weighted virtual buckets. This is a planning experiment;
 * moving a bucket in production would require a new fenced routing epoch. */
export function planLabPlacement(groups, shardCount) {
  if (![1, 3, 4].includes(shardCount) || !Array.isArray(groups) || !groups.length
    || groups.length > 4_096) fail('PLACEMENT_INVALID');
  const weights = Array(256).fill(0), ids = new Set();
  for (const g of groups) {
    if (!exact(g, ['bucket', 'records', 'group']) || !integer(g.bucket) || g.bucket > 255
      || !integer(g.records) || g.records < 1 || !integer(g.group) || g.group < 1
      || ids.has(g.group)) fail('GROUP_INVALID');
    ids.add(g.group); weights[g.bucket] += g.records;
    if (!integer(weights[g.bucket])) fail('ROW_LIMIT');
  }
  const total = weights.reduce((a, b) => a + b, 0);
  if (!integer(total) || total > LAB_MAX_ROWS) fail('ROW_LIMIT');
  const loads = Array(shardCount).fill(0), placement = Array.from({ length: 256 }, (_, i) => i % shardCount);
  for (const bucket of Array.from({ length: 256 }, (_, i) => i)
    .filter(i => weights[i]).sort((a, b) => weights[b] - weights[a] || a - b)) {
    const target = loads.indexOf(Math.min(...loads));
    placement[bucket] = target; loads[target] += weights[bucket];
  }
  let next = 1;
  const segments = [...groups].sort((a, b) => a.group - b.group).map(g => {
    const segment = { group: g.group, from: next, through: next + g.records - 1,
      bucket: g.bucket, target: placement[g.bucket] };
    next = segment.through + 1; return segment;
  });
  return { method: LAB_METHOD, dataKind: 'synthetic', shardCount, placement, loads, segments, totalRows: total };
}

export function validateLabPlan(plan) {
  if (!exact(plan, ['method', 'dataKind', 'shardCount', 'placement', 'loads', 'segments', 'totalRows'])
    || plan.method !== LAB_METHOD || plan.dataKind !== 'synthetic' || ![1, 3, 4].includes(plan.shardCount)
    || !Array.isArray(plan.placement) || plan.placement.length !== 256
    || plan.placement.some(i => !integer(i) || i >= plan.shardCount)
    || !Array.isArray(plan.loads) || plan.loads.length !== plan.shardCount
    || !Array.isArray(plan.segments) || !plan.segments.length || plan.segments.length > 4_096
    || !integer(plan.totalRows) || !plan.totalRows || plan.totalRows > LAB_MAX_ROWS) fail('PLAN_INVALID');
  const ids = new Set(), loads = Array(plan.shardCount).fill(0); let next = 1;
  for (const s of plan.segments) {
    if (!exact(s, ['group', 'from', 'through', 'bucket', 'target']) || !integer(s.group) || !s.group
      || ids.has(s.group) || s.from !== next || !integer(s.through) || s.through < s.from
      || !integer(s.bucket) || s.bucket > 255 || s.target !== plan.placement[s.bucket]) fail('PLAN_INVALID');
    ids.add(s.group); next = s.through + 1; loads[s.target] += s.through - s.from + 1;
  }
  if (next - 1 !== plan.totalRows || JSON.stringify(loads) !== JSON.stringify(plan.loads)) fail('PLAN_INVALID');
  return plan;
}
export function targetSegments(plan, target) {
  validateLabPlan(plan);
  if (!Number.isInteger(target) || target < -1 || target >= plan.shardCount) fail('TARGET_INVALID');
  return target === -1 ? plan.segments : plan.segments.filter(s => s.target === target);
}
function validMeta(result) {
  if (result?.success !== true || !result.meta
    || ['rows_read', 'rows_written', 'duration'].some(k => !Number.isFinite(result.meta[k]) || result.meta[k] < 0))
    fail('MEASUREMENT_INVALID');
  return { rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written, databaseMs: result.meta.duration };
}
export async function inspectLabDatabase(db, plan, target) {
  targetSegments(plan, target);
  const expected = labDigest([plan, target]);
  const schema = (await db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all()).results;
  // Reuse the reviewed exact provider schemas. A prefix exemption would let a
  // foreign table or a trigger attached to an internal table escape the gate.
  const rows = schema.filter(row => !providerSchemas.some(provider =>
    row.name === provider.name && row.type === provider.type && row.sql === provider.sql));
  if (!rows.length) return { state: 'empty' };
  const expectedRows = LAB_DDL.map(sql => ({ name: sql.split(' ')[2].split('(')[0],
    type: sql.startsWith('CREATE INDEX') ? 'index' : 'table', sql })).sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(rows) !== JSON.stringify(expectedRows)) fail('SCHEMA_DRIFT');
  const p = await db.prepare('SELECT * FROM shard_lab_progress WHERE id=1').first();
  const segments = targetSegments(plan, target);
  if (!p || p.run_sha !== expected || p.target !== target || !integer(p.segment)
    || p.segment > segments.length || !integer(p.after_id) || !integer(p.records) || !integer(p.step)
    || !['loading', 'ready'].includes(p.state) || p.last_page !== null && !/^[a-f0-9]{64}$/.test(p.last_page)) fail('CHECKPOINT_DRIFT');
  const prior = segments.slice(0, p.segment).reduce((n, s) => n + s.through - s.from + 1, 0);
  const current = segments[p.segment];
  const within = current && p.after_id >= current.from ? p.after_id - current.from + 1 : 0;
  if (p.records !== prior + within || current && p.after_id > current.through
    || within === 0 && p.after_id !== (p.segment ? segments[p.segment - 1].through : 0)
    || p.state === 'ready' && p.segment !== segments.length) fail('CHECKPOINT_DRIFT');
  return p;
}
export async function initializeLabDatabase(db, plan, target) {
  targetSegments(plan, target);
  const observed = await inspectLabDatabase(db, plan, target);
  if (observed.state !== 'empty') return observed;
  const statements = [...LAB_DDL.map(sql => db.prepare(sql)),
    db.prepare("INSERT INTO shard_lab_progress VALUES(1,?,?,0,0,0,0,NULL,'loading')").bind(labDigest([plan, target]), target)];
  try { await db.batch(statements); } catch {
    // Initial DDL and progress are one native transaction. Resolve a lost
    // response from the complete schema/checkpoint; never replay DDL blindly.
    const after = await inspectLabDatabase(db, plan, target);
    if (after.state === 'empty') fail('INITIALIZATION_NOT_APPLIED');
    return after;
  }
  return inspectLabDatabase(db, plan, target);
}
export async function advanceLabSeed(db, plan, target, pageRows = LAB_PAGE_ROWS) {
  if (!integer(pageRows) || !pageRows || pageRows > LAB_PAGE_ROWS) fail('PAGE_LIMIT');
  const p = await inspectLabDatabase(db, plan, target), segments = targetSegments(plan, target);
  if (p.state === 'empty') fail('NOT_INITIALIZED');
  if (p.state === 'ready') return { state: 'ready', records: p.records, writes: false };
  if (p.segment === segments.length) {
    const observed = await db.prepare('SELECT count(*) AS records,coalesce(sum(id),0) AS checksum FROM shard_lab_records').first();
    const expectedCount = segments.reduce((n, s) => n + s.through - s.from + 1, 0);
    const expectedSum = segments.reduce((n, s) => n + (s.from + s.through) * (s.through - s.from + 1) / 2, 0);
    if (observed.records !== expectedCount || observed.checksum !== expectedSum) fail('SEED_PARITY_FAILED');
    const result = await db.prepare("UPDATE shard_lab_progress SET state='ready' WHERE id=1 AND run_sha=? AND target=? AND step=? AND state='loading' RETURNING id")
      .bind(p.run_sha, target, p.step).all();
    if (result.results.length !== 1) fail('CHECKPOINT_DRIFT');
    return { state: 'ready', records: p.records, writes: true, cost: validMeta(result) };
  }
  const s = segments[p.segment], first = Math.max(s.from, p.after_id + 1), last = Math.min(s.through, first + pageRows - 1);
  const nextSegment = p.segment + (last === s.through ? 1 : 0), rows = last - first + 1;
  const page = labDigest([p.run_sha, p.step, s.group, first, last]);
  const statements = [
    db.prepare("INSERT INTO shard_lab_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM shard_lab_progress WHERE id=1 AND run_sha=? AND target=? AND step=? AND segment=? AND after_id=? AND state='loading') THEN 1 ELSE 0 END")
      .bind(p.run_sha, target, p.step, p.segment, p.after_id),
    db.prepare('WITH RECURSIVE seq(n) AS(SELECT ? UNION ALL SELECT n+1 FROM seq WHERE n<?) INSERT INTO shard_lab_records SELECT n,?,CAST(printf(\'%042d\',n) AS BLOB),10+n%2,1+n%3,20000-n%466 FROM seq').bind(first, last, s.group),
    db.prepare('UPDATE shard_lab_progress SET segment=?,after_id=?,records=records+?,step=step+1,last_page=? WHERE id=1 AND run_sha=? AND step=?')
      .bind(nextSegment, last, rows, page, p.run_sha, p.step),
    db.prepare('DELETE FROM shard_lab_guard'),
  ];
  let costs;
  try { costs = (await db.batch(statements)).map(validMeta); }
  catch {
    const after = await inspectLabDatabase(db, plan, target);
    if (after.step === p.step + 1 && after.last_page === page && after.after_id === last
      && after.segment === nextSegment && after.records === p.records + rows)
      return { state: 'loading', records: after.records, reconciled: true, measurementComplete: false };
    if (JSON.stringify(after) === JSON.stringify(p)) fail('WRITE_NOT_APPLIED');
    fail('WRITE_UNCERTAIN');
  }
  if (costs.length !== statements.length) fail('MEASUREMENT_INVALID');
  return { state: 'loading', records: p.records + rows, measurementComplete: true, cost:
    costs.reduce((a, b) => ({ rowsRead: a.rowsRead + b.rowsRead, rowsWritten: a.rowsWritten + b.rowsWritten,
      databaseMs: a.databaseMs + b.databaseMs }), { rowsRead: 0, rowsWritten: 0, databaseMs: 0 }) };
}

export async function boundedLabPool(items, concurrency, run) {
  if (![1, 2, 4].includes(concurrency) || !Array.isArray(items) || typeof run !== 'function') fail('CONCURRENCY_INVALID');
  let next = 0, failure; const values = Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { values[index] = await run(items[index], index); } catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
  return values;
}

export async function lookupLabSegment(db, segment, maximum = 256) {
  if (!integer(maximum) || !maximum || maximum > 256) fail('QUERY_LIMIT');
  const ids = Array.from({ length: Math.min(maximum, segment.through - segment.from + 1) }, (_, i) => segment.from + i);
  const result = await db.prepare("WITH wanted AS(SELECT value AS id,CAST(printf('%042d',value) AS BLOB) AS occurrence_id FROM json_each(?)) SELECT count(*) AS records,coalesce(sum(r.id),0) AS checksum FROM wanted w CROSS JOIN shard_lab_records r INDEXED BY shard_lab_owner_occurrence ON r.owner_id=? AND r.occurrence_id=w.occurrence_id")
    .bind(JSON.stringify(ids), segment.group).all();
  const row = result.results[0];
  if (result.results.length !== 1 || row.records !== ids.length
    || row.checksum !== ids.reduce((n, id) => n + id, 0)) fail('LOOKUP_PARITY_FAILED');
  return { records: row.records, checksum: row.checksum, ...validMeta(result) };
}

/** Indexed range count/checksum scan. Only aggregates leave the database;
 * header transfer, application reducers and publication are not measured. */
export async function scanLabSegment(db, segment, maximum = LAB_PAGE_ROWS) {
  if (!integer(maximum) || !maximum || maximum > LAB_PAGE_ROWS) fail('QUERY_LIMIT');
  const last = Math.min(segment.through, segment.from + maximum - 1);
  const result = await db.prepare("SELECT count(*) AS records,coalesce(sum(id),0) AS checksum FROM shard_lab_records INDEXED BY shard_lab_owner_occurrence WHERE owner_id=? AND occurrence_id BETWEEN CAST(printf('%042d',?) AS BLOB) AND CAST(printf('%042d',?) AS BLOB)")
    .bind(segment.group, segment.from, last).all();
  const row = result.results[0], records = last - segment.from + 1;
  if (result.results.length !== 1 || row.records !== records
    || row.checksum !== (segment.from + last) * records / 2) fail('LOOKUP_PARITY_FAILED');
  return { records: row.records, checksum: row.checksum, ...validMeta(result) };
}
