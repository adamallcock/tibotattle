import { pathToFileURL } from 'node:url';

// Generates reviewable SELECT statements only. It has no database, network,
// credentials, shell execution or file-write capability.
export const MAX_INPUT_ROWS = 10000;
const DAY_MS = 86400000;
const quote = (value) => `'${value}'`; // All interpolated input is validated below.

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Bounds must be canonical UTC timestamps with milliseconds.');
  }
  return value;
}

function aggregate(name, binding, sample, metrics, guard) {
  const sql = `WITH sample AS MATERIALIZED (${sample} LIMIT ${MAX_INPUT_ROWS + 1}),
gate AS (SELECT CASE WHEN NOT (${guard}) THEN 'unavailable_contract'
 WHEN (SELECT COUNT(*) FROM sample)>${MAX_INPUT_ROWS} THEN 'unavailable_row_limit'
 ELSE 'ok' END AS status)
SELECT gate.status, ${metrics.map(([label, expression]) =>
    `CASE WHEN gate.status='ok' THEN (${expression}) ELSE NULL END AS ${label}`).join(',\n ')}
FROM gate;`;
  return { name, binding, maxResultRows: 1, sql };
}

export function buildCompletionFunnelPlan({ from, until, v12 }) {
  timestamp(from); timestamp(until);
  if (Date.parse(until) <= Date.parse(from) || Date.parse(until) - Date.parse(from) > 31 * DAY_MS) {
    throw new Error('Select a positive interval of at most 31 days.');
  }
  if (!['absent', 'present'].includes(v12)) throw new Error('Explicit v12 absent or present is required.');
  const window = (column) => `${column}>=${quote(from)} AND ${column}<${quote(until)}`;
  // Day-scoped projection/publication counts include every UTC day intersecting
  // the receipt window. They are not a join against the receipt cohort.
  const firstDay = from.slice(0, 10);
  const afterDay = new Date(Math.ceil(Date.parse(until) / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
  const days = (column) => `${column}>=${quote(firstDay)} AND ${column}<${quote(afterDay)}`;
  const legacyGuard = `(SELECT COUNT(*) FROM telemetry_transport_formats WHERE
 (schema_version='telemetry-contribution-v1.0' AND format_rank=10) OR
 (schema_version='telemetry-contribution-v1.1' AND format_rank=11))=2`;
  const v12Guard = v12 === 'absent'
    ? `NOT EXISTS(SELECT 1 FROM sqlite_master WHERE name GLOB 'telemetry_v12_*')`
    : `(SELECT COUNT(*) FROM telemetry_v12_runtime WHERE id=1
 AND schema_version='telemetry-contribution-v1.2'
 AND envelope_schema_version='telemetry-envelope-v1.2'
 AND field_dictionary_version='telemetry-v1.2-registry-2026-09-20.1'
 AND privacy_contract_version='ongoing-privacy-safe-telemetry-v1.2'
 AND state IN ('staged','active'))=1`;
  const sourceGuard = `${legacyGuard} AND ${v12Guard}`;
  const analyticsGuard = `(SELECT COUNT(*) FROM analytics_runtime_sources)>0
 AND NOT EXISTS(SELECT 1 FROM analytics_runtime_sources WHERE contract_version!=1)`;
  const queries = [{
    name: 'source_contract', binding: 'STORAGE_INGESTION_DB', maxResultRows: 1,
    sql: `SELECT CASE WHEN ${sourceGuard} THEN 'ok' ELSE 'unavailable_contract' END AS status,
 ${v12 === 'present' ? `(SELECT CASE WHEN state IN ('staged','active') THEN state ELSE 'unavailable' END FROM telemetry_v12_runtime WHERE id=1)` : "'schema_absent'"} AS v12_state;`,
  }];
  for (const format of ['v1', 'v11', ...(v12 === 'present' ? ['v12'] : [])]) {
    const metrics = [
      ['received_chunks', 'SELECT COUNT(*) FROM sample'],
      ['receiving_owners', 'SELECT COUNT(DISTINCT participant_id) FROM sample'],
      ['latest_receipt_at', 'SELECT MAX(created_at) FROM sample'],
      ['latest_chunk_day', 'SELECT MAX(chunk_day) FROM sample'],
      ['owners_with_public_source_authority', `SELECT COUNT(DISTINCT s.participant_id) FROM sample s
 WHERE EXISTS(SELECT 1 FROM community_public_source_owners a WHERE a.participant_id=s.participant_id)`],
    ];
    if (format !== 'v1') {
      metrics.push(
        ['owners_without_current_domain', `SELECT COUNT(DISTINCT s.participant_id) FROM sample s
 WHERE NOT EXISTS(SELECT 1 FROM telemetry_${format}_domain_heads h WHERE h.participant_id=s.participant_id)`],
        ['chunks_outside_current_domain', `SELECT COUNT(*) FROM sample s WHERE NOT EXISTS(
 SELECT 1 FROM telemetry_${format}_domain_heads h JOIN telemetry_${format}_domain_days d
 ON d.generation_id=h.generation_id WHERE h.participant_id=s.participant_id AND d.manifest_id=s.manifest_id)`],
        ['chunks_with_staged_manifest', `SELECT COUNT(*) FROM sample s JOIN telemetry_${format}_day_manifests m
 ON m.id=s.manifest_id WHERE m.state='staged'`],
      );
    }
    queries.push(aggregate(`${format}_receipts`, 'STORAGE_INGESTION_DB',
      `SELECT participant_id,created_at,chunk_day${format !== 'v1' ? ',manifest_id' : ''}
 FROM telemetry_${format}_chunks WHERE ${window('created_at')}`, metrics, sourceGuard));
    if (format !== 'v1') {
      queries.push(aggregate(`${format}_domains_created`, 'STORAGE_INGESTION_DB',
        `SELECT id,participant_id FROM telemetry_${format}_domains WHERE ${window('created_at')}`, [
          ['domains_created', 'SELECT COUNT(*) FROM sample'],
          ['domains_not_current', `SELECT COUNT(*) FROM sample s WHERE NOT EXISTS(
 SELECT 1 FROM telemetry_${format}_domain_heads h WHERE h.participant_id=s.participant_id AND h.generation_id=s.id)`],
        ], sourceGuard));
    }
  }
  queries.push(aggregate('v11_projection_work', 'STORAGE_ANALYTICS_DB',
    `SELECT w.source_id,w.owner_digest,w.event_digest,w.phase,w.through_day
 FROM analytics_v11_projection_work w WHERE w.through_day>=${quote(firstDay)} AND w.from_day<${quote(afterDay)}`, [
      ['projection_generations', 'SELECT COUNT(*) FROM sample'],
      ['building_generations', "SELECT COUNT(*) FROM sample WHERE phase='building'"],
      ['projected_current_owner_heads', `SELECT COUNT(*) FROM sample s WHERE EXISTS(
 SELECT 1 FROM analytics_v11_owner_heads h WHERE h.source_id=s.source_id AND h.owner_digest=s.owner_digest AND h.event_digest=s.event_digest)`],
      ['latest_domain_through_day', 'SELECT MAX(through_day) FROM sample'],
    ], analyticsGuard));
  queries.push(aggregate('v1_projected_days', 'STORAGE_ANALYTICS_DB',
    `SELECT source_id,owner_digest,observed_day FROM analytics_v1_chunk_values WHERE ${days('observed_day')}`, [
      ['projected_chunk_slots', 'SELECT COUNT(*) FROM sample'],
      ['projected_owners', 'SELECT COUNT(*) FROM (SELECT DISTINCT source_id,owner_digest FROM sample)'],
      ['latest_observed_day', 'SELECT MAX(observed_day) FROM sample'],
    ], analyticsGuard));
  queries.push(aggregate('daily_owner_projection', 'STORAGE_ANALYTICS_DB',
    `SELECT source_id,owner_digest,day,complete,source_format FROM analytics_community_daily_owners WHERE ${days('day')}`, [
      ['owner_days', 'SELECT COUNT(*) FROM sample'],
      ['complete_owner_days', 'SELECT COUNT(*) FROM sample WHERE complete=1'],
      ['incomplete_owner_days', 'SELECT COUNT(*) FROM sample WHERE complete=0'],
      ['effective_owner_days', "SELECT COUNT(*) FROM sample WHERE source_format='effective'"],
      ['latest_observed_day', 'SELECT MAX(day) FROM sample'],
    ], analyticsGuard));
  queries.push(aggregate('daily_publication', 'STORAGE_ANALYTICS_DB',
    `SELECT h.source_id,h.day,h.revision,p.released_at FROM analytics_community_daily_heads h
 LEFT JOIN analytics_community_daily_publications p ON p.source_id=h.source_id AND p.day=h.day AND p.revision=h.revision
 WHERE ${days('h.day')}`, [
      ['published_source_days', 'SELECT COUNT(*) FROM sample WHERE released_at IS NOT NULL'],
      ['missing_publication_rows', 'SELECT COUNT(*) FROM sample WHERE released_at IS NULL'],
      ['latest_published_day', 'SELECT MAX(day) FROM sample WHERE released_at IS NOT NULL'],
      ['latest_release_at', 'SELECT MAX(released_at) FROM sample'],
    ], analyticsGuard));
  queries.push(aggregate('daily_queue', 'STORAGE_ANALYTICS_DB',
    `SELECT day FROM analytics_community_daily_queue WHERE ${days('day')}`, [
      ['queued_source_days', 'SELECT COUNT(*) FROM sample'],
    ], analyticsGuard));
  return { contract: 'contribution-completion-funnel-v1', mode: 'select-plan-only', from, until,
    observedDays: { from: firstDay, until: afterDay }, v12, maxInputRowsPerQuery: MAX_INPUT_ROWS,
    queries };
}

export function parseArguments(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2);
    if (!['from', 'until', 'v12'].includes(key) || argv[i] !== `--${key}` || key in args || !argv[i + 1]) {
      throw new Error('Expected --from UTC --until UTC --v12 absent|present exactly once.');
    }
    args[key] = argv[i + 1];
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(buildCompletionFunnelPlan(parseArguments(process.argv.slice(2))), null, 2)}\n`); }
  catch { process.stderr.write('Completion funnel refused invalid bounds or options.\n'); process.exitCode = 1; }
}
