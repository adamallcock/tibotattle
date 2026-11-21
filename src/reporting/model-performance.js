// Pure, bounded projections of diagnostic timing. No accounting totals.
const DAY = 86_400_000;
const SPEED_MODES = ['standard', 'fast', 'ultrafast'];
const LABELS = new Map([
  ['gpt-6.2-astra', 'GPT-6.2 Astra'], ['gpt-6.2-sol', 'GPT-6.2 Sol'],
  ['gpt-6.2-astra-law', 'GPT-6.2 Astra for Law'],
  ['gpt-6.1-sol', 'GPT-6.1 Sol'],
  ['gpt-6.1-terra', 'GPT-6.1 Terra'],
  ['gpt-6-luna', 'GPT-6 Luna'], ['gpt-6-sol', 'GPT-6 Sol'],
  ['gpt-5.6-luna', 'Luna'], ['gpt-5.6-terra', 'Terra'],
  ['gpt-6-astra', 'Astra'], ['gpt-5.6-sol', 'Sol'],
  ['gpt-5.5', 'GPT-5.5'], ['gpt-5.4', 'GPT-5.4'],
  ['gpt-5.4-mini', 'GPT-5.4 mini'], ['gpt-5.3-codex', 'GPT-5.3 Codex'],
  ['gpt-5.3-codex-spark', 'Spark'], ['gpt-5.2-codex', 'GPT-5.2 Codex'], ['gpt-5.2', 'GPT-5.2'],
]);
const count = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => count(n) && n > 0;
const progress = value => value === null || value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === 2
  && Object.hasOwn(value, 'checked') && Object.hasOwn(value, 'total')
  && count(value.checked) && count(value.total) && value.checked <= value.total;
function quantile(sorted, p) {
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function points(bins) {
  return [...bins].sort(([a], [b]) => a - b).map(([at, values]) => {
    values.sort((a, b) => a - b);
    const supported = values.length >= 5;
    return { at, n: values.length,
      p10: supported ? quantile(values, .1) : null,
      p25: supported ? quantile(values, .25) : null,
      median: quantile(values, .5),
      p75: supported ? quantile(values, .75) : null,
      p90: supported ? quantile(values, .9) : null };
  });
}
function add(bins, at, value) {
  if (!bins.has(at)) bins.set(at, []);
  bins.get(at).push(value);
}
// The local display calendar is independent of UTC telemetry publication.
export function validModelPerformanceTimeZone(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+/-]{0,99}$/u.test(value)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

function calendar(timeZone) {
  if (timeZone === 'UTC') return {
    dayStart(at, offset = 0) { return Math.floor(at / DAY) * DAY + offset * DAY; },
    binStart(at, interval) {
      const size = interval === 'week' ? 7 * DAY : DAY;
      const anchor = interval === 'week' ? 4 * DAY : 0;
      return Math.floor((at - anchor) / size) * size + anchor;
    },
  };
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
  });
  const civil = at => {
    const parts = Object.fromEntries(formatter.formatToParts(at)
      .filter(part => ['year', 'month', 'day'].includes(part.type))
      .map(part => [part.type, Number(part.value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day);
  };
  const starts = new Map();
  const midnight = day => {
    if (starts.has(day)) return starts.get(day);
    // Locate the first instant of this civil date. Unlike a fixed UTC offset,
    // this handles 23/25-hour dates and zones whose clocks jump at midnight.
    let low = day - 2 * DAY, high = day + 2 * DAY;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (civil(middle) < day) low = middle;
      else high = middle;
    }
    starts.set(day, high);
    return high;
  };
  return {
    dayStart(at, offset = 0) { return midnight(civil(at) + offset * DAY); },
    binStart(at, interval) {
      const day = civil(at);
      return midnight(interval === 'week'
        ? day - ((new Date(day).getUTCDay() + 6) % 7) * DAY : day);
    },
  };
}

export function modelPerformanceProjection(rows, { period = 'all', speedMode = 'standard', timeZone = 'UTC', now = Date.now(), historyProgress = null, rolling = false } = {}) {
  if (!['1', '7', '30', 'all'].includes(period) || !SPEED_MODES.includes(speedMode) || !count(now) || !Array.isArray(rows) || rows.length > 100000
      || !progress(historyProgress) || typeof rolling !== 'boolean' || !validModelPerformanceTimeZone(timeZone))
    throw new Error('invalid_timing_projection');
  const dates = calendar(timeZone);
  const known = rows.filter(r => r && LABELS.has(r.model) && count(r.at) && r.at <= now);
  const selected = known.filter(r => r.speed_mode === speedMode);
  const windowStart = period === 'all' ? 0
    : rolling || period === '1' ? Math.max(0, now - Number(period) * DAY)
    : Math.max(0, dates.dayStart(now, 1 - Number(period)));
  const excludedUnknownTurns = known.filter(r => !SPEED_MODES.includes(r.speed_mode)
    && r.at >= windowStart).length;
  const end = now;
  const start = period === 'all' ? (selected.length ? selected.reduce((min, r) => Math.min(min, r.at), now) : null)
    : rolling || period === '1' ? Math.max(0, now - Number(period) * DAY)
    : Math.max(0, dates.dayStart(now, 1 - Number(period)));
  const interval = period === 'all' && start !== null && end - start > 366 * DAY ? 'week' : 'day';
  // Align bins to the requested civil calendar; UTC remains the API default.
  const groups = new Map();
  for (const r of selected) {
    if (r.at < start) continue;
    if (!groups.has(r.model)) groups.set(r.model, { id: r.model, label: LABELS.get(r.model),
      turns: 0, speedTurns: 0, ttftTurns: 0, timedResponses: 0, toolFreeTurns: 0,
      speed: new Map(), latency: new Map(), toolFree: new Map() });
    const m = groups.get(r.model), at = dates.binStart(r.at, interval);
    m.turns++;
    if (['receipt', 'legacy'].includes(r.sample_method) && positive(r.sample_tokens)
      && positive(r.sample_duration) && positive(r.sample_responses)
      && count(r.sample_total_responses) && r.sample_responses <= r.sample_total_responses) {
      m.speedTurns++; m.timedResponses += r.sample_responses;
      add(m.speed, at, r.sample_tokens * 1000 / r.sample_duration);
    } else if (positive(r.tool_free_tokens) && positive(r.tool_free_duration)) {
      // Prefer response timing; use full-turn throughput only as a fallback.
      // Each turn contributes once, before computing the combined percentiles.
      const value = r.tool_free_tokens * 1000 / r.tool_free_duration;
      m.speedTurns++; m.toolFreeTurns++;
      add(m.speed, at, value); add(m.toolFree, at, value);
    }
    if (count(r.ttft)) { m.ttftTurns++; add(m.latency, at, r.ttft / 1000); }
  }
  return { schemaVersion: 6, method: 5, status: 'ready', collecting: false, stale: false,
    updatedAt: new Date(now).toISOString(), period, speedMode, timeZone, excludedUnknownTurns, interval, start, end, historyProgress,
    models: [...LABELS.keys()].filter(id => groups.has(id)).map(id => {
      const { speed, latency, toolFree, ...m } = groups.get(id);
      return { ...m, speed: [{ method: 'speed', points: points(speed) }],
        ttft: points(latency), toolFree: points(toolFree) };
    }) };
}
