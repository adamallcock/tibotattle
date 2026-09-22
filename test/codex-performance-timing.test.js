import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexPerformanceTimingParser } from '../src/providers/codex/logs.js';

const BASE = Date.parse('2026-09-01T12:00:00.000Z');
const KEY = Buffer.alloc(32, 7);

const record = (offset, type, payload) => ({
  timestamp: new Date(BASE + offset).toISOString(),
  type,
  payload,
});

const event = (offset, type, payload = {}) => record(offset, 'event_msg', {
  type,
  turn_id: 'synthetic-turn',
  ...payload,
});

const settings = (offset, serviceTier, turnId = 'synthetic-turn') => event(offset,
  'thread_settings_applied', {
    turn_id: turnId,
    thread_settings: { service_tier: serviceTier },
  });

const context = (offset, turnId = 'synthetic-turn', model = 'gpt-6-astra', serviceTier) => {
  const payload = { turn_id: turnId, model, effort: 'high' };
  if (serviceTier !== undefined) payload.service_tier = serviceTier;
  return record(offset, 'turn_context', payload);
};

const item = (offset, turnId, started, completed, type) => event(offset, 'item_completed', {
  turn_id: turnId,
  thread_id: 'synthetic-session',
  item: { type },
  started_at_ms: BASE + started,
  completed_at_ms: BASE + completed,
});

const usage = (offset, turnId, responseId, outputTokens, totalTokens) => record(offset,
  'token_usage_record', {
    thread_id: 'synthetic-session',
    turn_id: turnId,
    response_id: responseId,
    usage: { output_tokens: outputTokens, reasoning_output_tokens: outputTokens / 2 },
    turn_token_usage: { output_tokens: totalTokens, reasoning_output_tokens: totalTokens / 2 },
  });

function performanceFixture({
  turnId = 'synthetic-turn',
  start = 0,
  serviceTier = 'priority',
  includeSetting = true,
  contextServiceTier,
  model = 'gpt-6-astra',
  duration = 202000,
  complete = {},
} = {}) {
  const end = start + 202000;
  const rows = [record(0, 'session_meta', { id: 'synthetic-session' })];
  if (includeSetting) rows.push(settings(start - 1, serviceTier, turnId));
  rows.push(
    context(start, turnId, model, contextServiceTier),
    event(start, 'task_started', { turn_id: turnId }),
    item(start + 1000, turnId, start, start + 1000, 'Reasoning'),
    usage(start + 1000, turnId, `${turnId}-response-one`, 100, 100),
    record(start + 201000, 'response_item', {
      type: 'function_call_output',
      output: 'synthetic tool result',
    }),
    item(start + 202000, turnId, start + 201000, start + 202000, 'AgentMessage'),
    usage(start + 202000, turnId, `${turnId}-response-two`, 100, 200),
    event(end, 'task_complete', {
      turn_id: turnId,
      duration_ms: duration,
      time_to_first_token_ms: 100,
      ...complete,
    }),
  );
  return rows;
}

// Keep the original timing experiment corpus in this provider-owned suite so
// the v1.2 additions cannot silently change the established TPS/TTFT rules.
function baselineUsage(offset, responseId, outputTokens, totalTokens) {
  return record(offset, 'token_usage_record', {
    thread_id: 'synthetic-session',
    turn_id: 'synthetic-turn',
    response_id: responseId,
    usage: { output_tokens: outputTokens, reasoning_output_tokens: outputTokens / 2 },
    turn_token_usage: { output_tokens: totalTokens, reasoning_output_tokens: totalTokens / 2 },
  });
}

function baselineFixture() {
  return [record(0, 'session_meta', { id: 'synthetic-session' }),
    event(0, 'task_started'),
    context(0),
    item(1000, 'synthetic-turn', 0, 1000, 'Reasoning'),
    baselineUsage(1000, 'response-one', 100, 100),
    record(201000, 'response_item', { type: 'function_call_output', output: 'synthetic tool result' }),
    item(202000, 'synthetic-turn', 201000, 202000, 'AgentMessage'),
    baselineUsage(202000, 'response-two', 100, 200),
    event(202000, 'task_complete', { duration_ms: 202000, time_to_first_token_ms: 100 })];
}

function baselineCount(offset, total, last) {
  return event(offset, 'token_count', { info: {
    total_token_usage: { output_tokens: total, reasoning_output_tokens: total / 2 },
    last_token_usage: { output_tokens: last, reasoning_output_tokens: last / 2 },
  }});
}

function baselineOutput(offset, type = 'function_call') {
  return record(offset, 'response_item', {
    type,
    internal_chat_message_metadata_passthrough: {
      turn_id: 'synthetic-turn',
      create_time: (BASE - 10000) / 1000,
    },
  });
}

function baselineLegacyFixture() {
  const rows = baselineFixture();
  return [rows[0], baselineCount(0, 1000, 10), rows[1], rows[2], rows[3],
    baselineOutput(1000), rows[5], baselineCount(201000, 1100, 100), rows[6],
    baselineOutput(202000), baselineCount(202000, 1200, 100), rows[8]];
}

function parse(rows, saved = null) {
  const result = [];
  const parser = createCodexPerformanceTimingParser(KEY, saved, row => result.push(row));
  rows.forEach((row, index) => {
    parser.line(Buffer.from(JSON.stringify(row)), index + 1, false);
  });
  return { result, parser };
}

function rowFor(rows) {
  const result = parse(rows).result;
  assert.equal(result.length, 1);
  return result[0];
}

test('full turn duration includes tool waits while TPS duration stays response-only', () => {
  const row = rowFor(performanceFixture());
  assert.equal(row.turn_duration, 202000);
  assert.equal(row.duration, 2000);
  assert.equal(row.sample_duration, 2000);
  assert.equal(row.ttft, 100);
  assert.equal(row.speed_mode, 'fast');
  assert.equal(row.speed_mode_source, 'rollout_thread_settings');
  assert.equal(row.api_service_tier, 'unknown');
  assert.equal(row.quality, 'complete');
});

test('full turn duration remains qualified when response timing windows are absent', () => {
  const rows = performanceFixture();
  rows.splice(4, 5);
  const row = rowFor(rows);
  assert.equal(row.turn_duration, 202000);
  assert.equal(row.duration, null);
  assert.equal(row.sample_duration, null);
  assert.equal(row.quality, 'usage_mismatch');

  const mismatchedUsage = performanceFixture();
  mismatchedUsage[8].payload.turn_token_usage.output_tokens = 999;
  const mismatchRow = rowFor(mismatchedUsage);
  assert.equal(mismatchRow.turn_duration, 202000);
  assert.equal(mismatchRow.duration, null);
});

test('full turn duration refuses an error, invalid boundary, unstable model, or duplicate start', () => {
  const cases = [
    ['error', rows => { rows.at(-1).payload.error = true; }],
    ['endpoint skew beyond 2000ms', rows => { rows.at(-1).payload.duration_ms = 204001; }],
    ['completion before start', rows => {
      rows.splice(4, 5);
      rows.at(-1).timestamp = new Date(BASE - 1000).toISOString();
      rows.at(-1).payload.duration_ms = 1000;
    }],
    ['unstable model', rows => rows.splice(5, 0, context(1000, 'synthetic-turn', 'gpt-5.6-luna'))],
    ['duplicate start', rows => rows.splice(4, 0, event(10, 'task_started', { turn_id: 'synthetic-turn' }))],
  ];
  for (const [label, mutate] of cases) {
    const rows = performanceFixture();
    mutate(rows);
    assert.equal(rowFor(rows).turn_duration, null, label);
  }
});

test('mode is taken at task start and a post-completion toggle affects only later turns', () => {
  const first = performanceFixture({ turnId: 'first-turn', start: 0, serviceTier: 'priority' });
  first.push(settings(300000, 'standard', 'first-turn'));
  const second = performanceFixture({ turnId: 'second-turn', start: 400000, serviceTier: 'standard' });
  const parsed = parse([
    ...first,
    ...second.slice(1),
  ]).result;
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].speed_mode, 'fast');
  assert.equal(parsed[0].speed_mode_source, 'rollout_thread_settings');
  assert.equal(parsed[1].speed_mode, 'standard');
});

test('per-turn context service tier overrides the thread setting at the task boundary', () => {
  const standard = rowFor(performanceFixture({
    serviceTier: 'standard', contextServiceTier: 'standard',
  }));
  assert.equal(standard.speed_mode, 'standard');
  assert.equal(standard.speed_mode_source, 'turn_context_service_tier');

  for (const serviceTier of ['priority', 'fast']) {
    const fast = rowFor(performanceFixture({
      serviceTier: 'standard', contextServiceTier: serviceTier,
    }));
    assert.equal(fast.speed_mode, 'fast', serviceTier);
    assert.equal(fast.speed_mode_source, 'turn_context_service_tier', serviceTier);
  }
});

test('contradictory or malformed per-turn service tier evidence fails closed', () => {
  const contradictory = rowFor(performanceFixture({
    serviceTier: 'priority', contextServiceTier: 'standard',
  }));
  assert.equal(contradictory.speed_mode, 'standard');

  const midTurn = performanceFixture({ serviceTier: 'standard' });
  midTurn.splice(4, 0, context(1000, 'synthetic-turn', 'gpt-6-astra', 'priority'));
  const mixed = rowFor(midTurn);
  assert.equal(mixed.speed_mode, 'mixed');
  assert.equal(mixed.speed_mode_source, 'mixed');

  const malformed = performanceFixture({ serviceTier: 'standard' });
  malformed[2].payload.service_tier = { private: 'untrusted' };
  const unknown = rowFor(malformed);
  assert.equal(unknown.speed_mode, 'unknown');
  assert.equal(unknown.speed_mode_source, 'unobserved');
  assert.equal(unknown.duration, 2000);
});

test('mid-turn changes are mixed, while bounded unknown values do not retain raw provider text', () => {
  const rows = performanceFixture({ serviceTier: 'priority' });
  rows.splice(4, 0, settings(1000, 'mystery-tier'));
  const row = rowFor(rows);
  assert.equal(row.speed_mode, 'mixed');
  assert.equal(row.speed_mode_source, 'mixed');
  assert.doesNotMatch(JSON.stringify(row), /mystery-tier/);

  const unknown = rowFor(performanceFixture({ serviceTier: 'mystery-tier' }));
  assert.equal(unknown.speed_mode, 'other');
  assert.equal(unknown.speed_mode_source, 'rollout_thread_settings');
  assert.doesNotMatch(JSON.stringify(unknown), /mystery-tier/);
});

test('missing and explicitly null speed settings remain unknown and unobserved', () => {
  const missing = rowFor(performanceFixture({ includeSetting: false }));
  assert.equal(missing.speed_mode, 'unknown');
  assert.equal(missing.speed_mode_source, 'unobserved');

  const rows = performanceFixture({ serviceTier: null });
  const explicitNull = rowFor(rows);
  assert.equal(explicitNull.speed_mode, 'unknown');
  assert.equal(explicitNull.speed_mode_source, 'unobserved');
});

test('bounded tier history compacts valid declarations without poisoning future mode lookup', () => {
  const rows = performanceFixture({ start: 1000, includeSetting: false });
  rows.splice(1, 0, ...Array.from({ length: 513 }, (_, index) => (
    settings(index, index % 2 === 0 ? 'priority' : 'standard')
  )));
  const parsed = parse(rows);
  assert.equal(parsed.result.length, 1);
  assert.equal(parsed.result[0].speed_mode, 'fast');
  assert.equal(parsed.result[0].speed_mode_source, 'rollout_thread_settings');
  assert.equal(parsed.parser.state().tier.invalid, false);
  assert.ok(parsed.parser.state().tier.timeline.length <= 2);
});

test('completed turn context history is retired so long valid logs do not poison later turns', () => {
  const rows = [record(0, 'session_meta', { id: 'synthetic-session' })];
  for (let index = 0; index < 513; index += 1) {
    const turnId = `turn-${index}`;
    const offset = index * 3 + 1;
    rows.push(
      context(offset, turnId),
      event(offset, 'task_started', { turn_id: turnId }),
      event(offset + 1, 'task_complete', {
        turn_id: turnId,
        duration_ms: 1,
      }),
    );
  }
  const parsed = parse(rows);
  assert.equal(parsed.result.length, 513);
  assert.equal(parsed.result.at(-1).model, 'gpt-6-astra');
  assert.equal(parsed.result.at(-1).turn_duration, 1);
  assert.deepEqual(parsed.parser.state().contextHistory, {});
  assert.equal(parsed.parser.state().contextHistoryInvalid, false);
});

test('missing or corrupt saved tier state invalidates a current turn mode', () => {
  for (const corrupt of [
    state => { delete state.tier; },
    state => { state.tier = null; },
    state => { state.tier = {}; },
    state => { state.tier = { timeline: [], invalid: false }; },
    state => { state.tier = { timeline: [], lastAt: null, invalid: false }; },
    state => { state.tier = { timeline: [], lastAt: 'not-a-timestamp', invalid: false }; },
    state => { state.tier = {
      timeline: [{ at: BASE, mode: 'fast', source: 'unobserved' }],
      lastAt: BASE,
      invalid: false,
    }; },
  ]) {
    const rows = performanceFixture({ serviceTier: 'priority' });
    const prefix = parse(rows.slice(0, 4));
    const saved = structuredClone(prefix.parser.state());
    corrupt(saved);
    const result = [];
    const resumed = createCodexPerformanceTimingParser(KEY, saved, row => result.push(row));
    rows.slice(4).forEach((row, index) => {
      resumed.line(Buffer.from(JSON.stringify(row)), index + 5, false);
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].speed_mode, 'unknown');
    assert.equal(result[0].speed_mode_source, 'unobserved');
  }

  // A turn that began unobserved and then changed mode also loses its mixed
  // label when the saved declaration history is absent; timing stays valid.
  const mixedRows = performanceFixture({ includeSetting: false });
  const mixedPrefix = parse([...mixedRows.slice(0, 3), settings(1, 'priority')]);
  const mixedSaved = structuredClone(mixedPrefix.parser.state());
  mixedSaved.tier = { timeline: [], lastAt: null, invalid: false };
  const mixedResumed = parse(mixedRows.slice(3), mixedSaved).result[0];
  assert.equal(mixedResumed.speed_mode, 'unknown');
  assert.equal(mixedResumed.speed_mode_source, 'unobserved');
  assert.equal(mixedResumed.duration, 2000);
  assert.equal(mixedResumed.turn_duration, 202000);
  assert.equal(mixedResumed.ttft, 100);

  const fresh = parse([record(0, 'session_meta', { id: 'synthetic-session' })]);
  assert.equal(fresh.parser.state().tier.invalid, false);
  assert.deepEqual(fresh.parser.state().tier.timeline, []);
});

test('regressing, malformed, and equal-time conflicting model context cannot relabel a row', () => {
  const cases = [
    rows => rows.splice(4, 0, context(-1, 'synthetic-turn', 'gpt-6-astra')),
    rows => rows.splice(4, 0, context(0, 'synthetic-turn', 'gpt-5.6-luna')),
    rows => rows.splice(4, 0, record(0, 'turn_context', {
      turn_id: 'synthetic-turn', model: { private: 'unknown' }, effort: 'high',
    })),
  ];
  for (const mutate of cases) {
    const rows = performanceFixture();
    mutate(rows);
    const row = rowFor(rows);
    assert.equal(row.model, null);
    assert.equal(row.turn_duration, null);
    assert.equal(row.duration, null);
  }

  const unaffected = [
    record(0, 'session_meta', { id: 'synthetic-session' }),
    context(0, 'bad-turn'),
    event(0, 'task_started', { turn_id: 'bad-turn' }),
    context(-1, 'bad-turn'),
    event(1, 'task_complete', { turn_id: 'bad-turn', duration_ms: 1 }),
    context(10, 'good-turn'),
    event(10, 'task_started', { turn_id: 'good-turn' }),
    event(11, 'task_complete', { turn_id: 'good-turn', duration_ms: 1 }),
  ];
  const unaffectedRows = parse(unaffected).result;
  assert.equal(unaffectedRows.length, 2);
  assert.equal(unaffectedRows[1].model, 'gpt-6-astra');
  assert.equal(unaffectedRows[1].turn_duration, 1);
});

test('malformed, out-of-order, and unreadable settings fail closed without changing TPS qualification', () => {
  const malformed = performanceFixture({ serviceTier: 'priority' });
  malformed.splice(4, 0, event(1000, 'thread_settings_applied', {
    thread_settings: { service_tier: { private: 'value' } },
  }));
  const malformedRow = rowFor(malformed);
  assert.equal(malformedRow.speed_mode, 'unknown');
  assert.equal(malformedRow.speed_mode_source, 'unobserved');
  assert.equal(malformedRow.duration, 2000);

  const outOfOrder = performanceFixture({ includeSetting: false });
  outOfOrder.splice(1, 0, settings(-1, 'priority'));
  outOfOrder.splice(2, 0, settings(-2, 'standard'));
  const outOfOrderRow = rowFor(outOfOrder);
  assert.equal(outOfOrderRow.speed_mode, 'unknown');
  assert.equal(outOfOrderRow.speed_mode_source, 'unobserved');
  assert.equal(outOfOrderRow.duration, 2000);

  const unreadable = performanceFixture({ serviceTier: 'priority' });
  unreadable.splice(4, 0, Buffer.from('{"timestamp":"2026-09-01T12:00:01.000Z",'
    + '"type":"event_msg","payload":{"type":"thread_settings_applied",'));
  // The parser receives source lines as bytes. The malformed line is detected
  // by the timing-event needle and invalidates only the mode proof.
  const result = [];
  const parser = createCodexPerformanceTimingParser(KEY, null, row => result.push(row));
  unreadable.forEach((entry, index) => {
    const bytes = Buffer.isBuffer(entry) ? entry : Buffer.from(JSON.stringify(entry));
    parser.line(bytes, index + 1, false);
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].speed_mode, 'unknown');
  assert.equal(result[0].speed_mode_source, 'unobserved');
  assert.equal(result[0].duration, null);

  const oversized = performanceFixture({ serviceTier: 'priority' });
  oversized.splice(4, 0, Buffer.from('{"timestamp":"2026-09-01T12:00:01.000Z",'
    + '"type":"event_msg","payload":{"type":"thread_settings_applied",'
    + '"thread_settings":{"service_tier":"priority","padding":"'
    + 'x'.repeat(1024 * 1024) + '"}}'));
  const oversizedResult = [];
  const oversizedParser = createCodexPerformanceTimingParser(KEY, null,
    row => oversizedResult.push(row));
  oversized.forEach((entry, index) => {
    const bytes = Buffer.isBuffer(entry) ? entry : Buffer.from(JSON.stringify(entry));
    oversizedParser.line(bytes, index + 1, Buffer.isBuffer(entry));
  });
  assert.equal(oversizedResult.length, 1);
  assert.equal(oversizedResult[0].speed_mode, 'unknown');
  assert.equal(oversizedResult[0].speed_mode_source, 'unobserved');
  assert.equal(oversizedResult[0].duration, null);
});

test('mode evidence survives parser restart without backfilling a later setting', () => {
  const rows = performanceFixture({ serviceTier: 'priority' });
  const split = 4;
  const first = parse(rows.slice(0, split));
  const resumedResult = [];
  const resumed = createCodexPerformanceTimingParser(KEY, first.parser.state(), row => resumedResult.push(row));
  rows.slice(split).forEach((row, index) => {
    resumed.line(Buffer.from(JSON.stringify(row)), split + index + 1, false);
  });
  assert.equal(resumedResult.length, 1);
  assert.equal(resumedResult[0].speed_mode, 'fast');
  assert.equal(resumedResult[0].speed_mode_source, 'rollout_thread_settings');

  const late = performanceFixture({ includeSetting: false });
  late.splice(1, 0, settings(203000, 'priority'));
  const lateRow = rowFor(late);
  assert.equal(lateRow.speed_mode, 'unknown');
  assert.equal(lateRow.speed_mode_source, 'unobserved');
});

test('per-turn mode override survives restart before task start and replay after task start', () => {
  const rows = performanceFixture({ serviceTier: 'standard', contextServiceTier: 'priority' });
  const cold = rowFor(rows);
  const prefix = parse(rows.slice(0, 3));
  const resumedResult = [];
  const resumed = createCodexPerformanceTimingParser(KEY, prefix.parser.state(),
    row => resumedResult.push(row));
  rows.slice(3).forEach((row, index) => {
    resumed.line(Buffer.from(JSON.stringify(row)), index + 4, false);
  });
  assert.equal(resumedResult.length, 1);
  assert.equal(resumedResult[0].speed_mode, 'fast');
  assert.equal(resumedResult[0].speed_mode_source, 'turn_context_service_tier');
  assert.equal(resumedResult[0].turn_duration, cold.turn_duration);

  const reordered = performanceFixture({ serviceTier: 'standard' });
  const turnContext = reordered.splice(2, 1)[0];
  turnContext.payload.service_tier = 'priority';
  reordered.splice(3, 0, turnContext);
  const split = parse(reordered.slice(0, 3));
  const replayed = parse(reordered.slice(3), split.parser.state()).result[0];
  assert.equal(replayed.speed_mode, 'fast');
  assert.equal(replayed.speed_mode_source, 'turn_context_service_tier');
});

test('pre-extension saved turns resume old timing fields but cannot invent full-turn proof', () => {
  const rows = performanceFixture({ serviceTier: 'priority' });
  const prefix = parse(rows.slice(0, 4));
  const saved = structuredClone(prefix.parser.state());
  delete saved.tier;
  for (const turn of Object.values(saved.turns)) {
    delete turn.mode;
    delete turn.modeSource;
    delete turn.modeMixed;
    delete turn.modeInvalid;
    delete turn.modelObserved;
    delete turn.stableModel;
    delete turn.modelStable;
    delete turn.boundaryInvalid;
    delete turn.turnDurationProof;
  }
  const result = [];
  const resumed = createCodexPerformanceTimingParser(KEY, saved, row => result.push(row));
  rows.slice(4).forEach((row, index) => {
    resumed.line(Buffer.from(JSON.stringify(row)), index + 5, false);
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].duration, 2000);
  assert.equal(result[0].turn_duration, null);
});

test('concurrent turns retain separate full-turn rows and both become mixed on a shared mid-turn toggle', () => {
  const rows = [
    record(0, 'session_meta', { id: 'synthetic-session' }),
    settings(-1, 'priority', 'turn-a'),
    context(0, 'turn-a'),
    event(0, 'task_started', { turn_id: 'turn-a' }),
    context(500, 'turn-b'),
    event(500, 'task_started', { turn_id: 'turn-b' }),
    settings(1000, 'standard', 'turn-a'),
    item(2000, 'turn-a', 0, 2000, 'AgentMessage'),
    usage(2000, 'turn-a', 'turn-a-response', 100, 100),
    event(202000, 'task_complete', {
      turn_id: 'turn-a', duration_ms: 202000, time_to_first_token_ms: 100,
    }),
    item(2500, 'turn-b', 500, 2500, 'AgentMessage'),
    usage(2500, 'turn-b', 'turn-b-response', 100, 100),
    event(202500, 'task_complete', {
      turn_id: 'turn-b', duration_ms: 202000, time_to_first_token_ms: 100,
    }),
  ];
  const result = parse(rows).result;
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(row => row.speed_mode), ['mixed', 'mixed']);
  assert.deepEqual(result.map(row => row.turn_duration), [202000, 202000]);
});

test('baseline regression: missing, overlapping, duplicate, conflicting, and mixed evidence fail closed', () => {
  const cases = [
    rows => rows.splice(3, 1),
    rows => { rows[6].payload.started_at_ms = BASE + 500; },
    rows => rows.splice(5, 0, structuredClone(rows[4])),
    rows => { rows[7].payload.turn_token_usage.output_tokens = 999; },
    rows => rows.splice(6, 0, context(201000, 'synthetic-turn', 'gpt-5.6-luna')),
  ];
  for (const mutate of cases) {
    const rows = baselineFixture();
    mutate(rows);
    assert.equal(parse(rows).result[0].duration, null);
  }
});

test('baseline regression: TTFT stays independent and missing TTFT is not zero', () => {
  const missingWindow = baselineFixture();
  missingWindow.splice(3, 1);
  assert.equal(parse(missingWindow).result[0].ttft, 100);
  const missingTtft = baselineFixture();
  delete missingTtft.at(-1).payload.time_to_first_token_ms;
  assert.equal(parse(missingTtft).result[0].ttft, null);
  assert.equal(parse(missingTtft).result[0].duration, 2000);
});

test('baseline regression: partial receipt coverage retains only the matching response', () => {
  const rows = baselineFixture();
  rows.splice(3, 1);
  const row = parse(rows).result[0];
  assert.equal(row.duration, null);
  assert.equal(row.tokens, 200);
  assert.equal(row.sample_method, 'receipt');
  assert.equal(row.sample_tokens, 100);
  assert.equal(row.sample_duration, 1000);
  assert.equal(row.sample_reasoning, 50);
  assert.equal(row.sample_responses, 1);
  assert.equal(row.sample_total_responses, 2);
});

test('baseline regression: unattributed model items cannot shorten a modern response window', () => {
  for (const turnId of [undefined, 'orphan-turn']) {
    const rows = baselineFixture();
    const orphan = structuredClone(rows[3]);
    orphan.payload.turn_id = turnId;
    rows.splice(3, 0, orphan);
    const row = parse(rows).result[0];
    assert.equal(row.duration, null);
    assert.equal(row.sample_tokens, 100);
    assert.equal(row.sample_duration, 1000);
  }
});

test('baseline regression: partial windows require unique identities and stable attribution', () => {
  for (const mutate of [
    rows => rows.splice(5, 0, structuredClone(rows[4])),
    rows => { rows[7].payload.turn_token_usage.output_tokens = 999; },
    rows => rows.splice(6, 0, context(201000, 'synthetic-turn', 'gpt-5.6-luna')),
  ]) {
    const rows = baselineFixture();
    mutate(rows);
    assert.equal(parse(rows).result[0].sample_duration, null);
  }
});

test('baseline regression: legacy endpoints exclude delayed tool waits', () => {
  const row = parse(baselineLegacyFixture()).result[0];
  assert.equal(row.duration, null);
  assert.equal(row.sample_method, 'legacy');
  assert.equal(row.sample_tokens, 200);
  assert.equal(row.sample_reasoning, 100);
  assert.equal(row.sample_duration, 2000);
  assert.equal(row.sample_responses, 2);
  assert.equal(row.sample_total_responses, 2);
  assert.equal(row.ttft, 100);
});

test('baseline regression: repeated legacy snapshots do not duplicate responses', () => {
  const rows = baselineLegacyFixture();
  rows.splice(8, 0, baselineCount(201000, 1100, 100));
  assert.equal(parse(rows).result[0].sample_tokens, 200);
  for (const mutate of [
    next => { next[7].payload.info.last_token_usage.output_tokens = 98; },
    next => { delete next[4].payload.started_at_ms; },
    next => { next[5].payload.internal_chat_message_metadata_passthrough.turn_id = 'different-turn'; },
    next => next.splice(6, 0, baselineOutput(1500, 'unknown_model_output')),
    next => next.splice(1, 1),
  ]) {
    const next = baselineLegacyFixture();
    mutate(next);
    const row = parse(next).result[0];
    assert.equal(row.sample_tokens, 100);
    assert.equal(row.sample_duration, 1000);
    assert.equal(row.sample_responses, 1);
  }
});

test('baseline regression: legacy counter resets and tool results cannot create false speed', () => {
  const rows = baselineLegacyFixture();
  rows[7] = baselineCount(201000, 900, 100);
  rows[10] = baselineCount(202000, 1000, 100);
  assert.equal(parse(rows).result[0].sample_tokens, 100);
  const withOutput = baselineLegacyFixture();
  withOutput.splice(7, 0, baselineOutput(201000));
  assert.equal(parse(withOutput).result[0].sample_tokens, 100);
});

test('baseline regression: legacy mirror cannot rescue rejected modern usage', () => {
  const rows = baselineLegacyFixture();
  rows.splice(6, 0, baselineUsage(1000, 'response-one', 100, 100));
  const row = parse(rows).result[0];
  assert.equal(row.sample_method, 'receipt');
  assert.equal(row.sample_tokens, 100);
  const invalid = baselineLegacyFixture();
  const missingIdentity = baselineUsage(1000, 'response-one', 100, 100);
  delete missingIdentity.payload.response_id;
  invalid.splice(6, 0, missingIdentity);
  assert.equal(parse(invalid).result[0].sample_duration, null);
});

test('baseline regression: concurrent active turns stay unattributed to legacy counts', () => {
  const rows = baselineLegacyFixture();
  rows.splice(4, 0, event(0, 'task_started', { turn_id: 'parallel-turn' }));
  assert.equal(parse(rows).result[0].sample_duration, null);
});

test('baseline regression: orphan modern usage and transient concurrent windows do not overcount', () => {
  const rows = baselineLegacyFixture();
  const orphan = baselineUsage(1000, 'orphan-response', 100, 100);
  orphan.payload.turn_id = 'orphan-turn';
  rows.splice(6, 0, orphan);
  assert.equal(parse(rows).result[0].sample_duration, null);
  const concurrent = baselineLegacyFixture();
  concurrent.splice(6, 0,
    event(1100, 'task_started', { turn_id: 'parallel-turn' }),
    event(1200, 'turn_aborted', { turn_id: 'parallel-turn' }));
  assert.equal(parse(concurrent).result[0].sample_tokens, 100);
});

test('baseline regression: unattributed model changes invalidate pending attribution', () => {
  const rows = baselineLegacyFixture();
  rows.splice(6, 0, context(1100, 'unknown-turn', 'gpt-5.6-luna'));
  const row = parse(rows).result[0];
  assert.equal(row.sample_duration, null);
  assert.equal(row.model, null);
  const noBaseline = baselineLegacyFixture();
  noBaseline.splice(1, 1);
  const partial = parse(noBaseline).result[0];
  assert.equal(partial.sample_responses, 1);
  assert.equal(partial.sample_total_responses, 2);
});

test('baseline regression: oversized timing and malformed records invalidate timing', () => {
  for (const type of ['timing', 'malformed', 'tool']) {
    const result = [];
    const parser = createCodexPerformanceTimingParser(KEY, null, row => result.push(row));
    baselineFixture().forEach((row, index) => {
      parser.line(Buffer.from(JSON.stringify(row)), index, false);
      if (index === 3) {
        const bytes = type === 'tool' ? Buffer.from(JSON.stringify(record(1000, 'response_item', {})))
          : type === 'malformed' ? Buffer.from('{"type":"token_usage_record",') : Buffer.from('{');
        parser.line(bytes, 33, type !== 'malformed');
      }
    });
    assert.equal(result[0].duration, type === 'tool' ? 2000 : null);
  }
});

test('baseline regression: forks and raw source identities never enter retained fields', () => {
  const fork = baselineFixture();
  fork[0].payload.forked_from_id = 'synthetic-parent';
  assert.equal(parse(fork).result.length, 0);
  const privateSentinel = baselineFixture();
  privateSentinel[3].payload.item.text = 'PRIVATE_SENTINEL';
  const parsed = parse(privateSentinel);
  assert.doesNotMatch(JSON.stringify({ result: parsed.result, state: parsed.parser.state() }),
    /PRIVATE_SENTINEL|synthetic-session|synthetic-turn|response-one/);
});

test('baseline regression: active-turn state remains bounded', () => {
  const parser = createCodexPerformanceTimingParser(KEY, null, () => {});
  parser.line(Buffer.from(JSON.stringify(baselineFixture()[0])), 1, false);
  for (let index = 0; index < 1000; index += 1) {
    parser.line(Buffer.from(JSON.stringify(event(index, 'task_started', {
      turn_id: `synthetic-${index}`,
    }))), index + 2, false);
  }
  assert.ok(Object.keys(parser.state().turns).length <= 8);
  assert.ok(Buffer.byteLength(JSON.stringify(parser.state())) <= 128 * 1024);
  assert.ok(parser.state().diagnostics.capacity > 0);
});
