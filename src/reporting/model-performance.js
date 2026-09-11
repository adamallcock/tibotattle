// Pure, bounded projections of diagnostic timing. No accounting totals.
const DAY = 86_400_000;
const LABELS = new Map([
  ['gpt-5.6-luna', 'Luna'], ['gpt-5.6-terra', 'Terra'],
  ['gpt-6-astra', 'Astra'], ['gpt-5.6-sol', 'Sol'],
  ['gpt-5.5', 'GPT-5.5'], ['gpt-5.4', 'GPT-5.4'],
  ['gpt-5.4-mini', 'GPT-5.4 mini'], ['gpt-5.3-codex', 'GPT-5.3 Codex'],
  ['gpt-5.3-codex-spark', 'Spark'], ['gpt-5.2-codex', 'GPT-5.2 Codex'], ['gpt-5.2', 'GPT-5.2'],
]);
const count = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => count(n) && n > 0;
function quantile(sorted, p) {
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function points(bins) {
  return [...bins].sort(([a], [b]) => a - b).map(([at, values]) => {
    values.sort((a, b) => a - b);
    return { at, n: values.length, median: quantile(values, .5),
      p25: values.length >= 5 ? quantile(values, .25) : null,
      p75: values.length >= 5 ? quantile(values, .75) : null };
  });
}
function add(bins, at, value) {
  if (!bins.has(at)) bins.set(at, []);
  bins.get(at).push(value);
}
export function modelPerformanceProjection(rows, { period = 'all', now = Date.now() } = {}) {
  if (!['7', '30', 'all'].includes(period) || !count(now) || !Array.isArray(rows) || rows.length > 100000)
    throw new Error('invalid_timing_projection');
  const known = rows.filter(r => LABELS.has(r.model) && count(r.at) && r.at <= now);
  const end = now;
  const start = period === 'all' ? (known.length ? known.reduce((min, r) => Math.min(min, r.at), now) : null)
    : Math.floor(now / DAY) * DAY - (Number(period) - 1) * DAY;
  const interval = period === 'all' && start !== null && end - start > 366 * DAY ? 'week' : 'day';
  const size = interval === 'week' ? 7 * DAY : DAY;
  // Align weeks to Monday UTC; daily bins to midnight UTC.
  const anchor = interval === 'week' ? 4 * DAY : 0;
  const groups = new Map();
  for (const r of known) {
    if (r.at < start) continue;
    if (!groups.has(r.model)) groups.set(r.model, { id: r.model, label: LABELS.get(r.model),
      turns: 0, speedTurns: 0, ttftTurns: 0, timedResponses: 0,
      receipt: new Map(), legacy: new Map(), latency: new Map() });
    const m = groups.get(r.model), at = Math.floor((r.at - anchor) / size) * size + anchor;
    m.turns++;
    if (['receipt', 'legacy'].includes(r.sample_method) && positive(r.sample_tokens)
      && positive(r.sample_duration) && positive(r.sample_responses)
      && count(r.sample_total_responses) && r.sample_responses <= r.sample_total_responses) {
      m.speedTurns++; m.timedResponses += r.sample_responses;
      add(m[r.sample_method], at, r.sample_tokens * 1000 / r.sample_duration);
    }
    if (count(r.ttft)) { m.ttftTurns++; add(m.latency, at, r.ttft / 1000); }
  }
  return { schemaVersion: 1, method: 2, status: 'ready', collecting: false, stale: false,
    updatedAt: new Date(now).toISOString(), period, interval, start, end,
    models: [...LABELS.keys()].filter(id => groups.has(id)).map(id => {
      const { receipt, legacy, latency, ...m } = groups.get(id);
      return { ...m, speed: [{ method: 'receipt', points: points(receipt) },
        { method: 'legacy', points: points(legacy) }], ttft: points(latency) };
    }) };
}
