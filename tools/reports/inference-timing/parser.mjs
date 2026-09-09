// Local experiment only. No accounting or hosted-contribution consumers.
import { createHmac } from 'node:crypto';

export const METHOD = 2;
export const MAX_STATE_BYTES = 128 * 1024;
const MODELS = new Set(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex',
  'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.2', 'auto-review']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
// Response items dominate source bytes; avoid scanning each payload for every
// other event name before finding its top-level type.
const NEEDLES = ['response_item', 'token_count', 'session_meta', 'turn_context', 'item_completed',
  'token_usage_record', 'task_started', 'task_complete', 'turn_aborted', 'compacted'].map(x => Buffer.from(x));
export const digest = (key, domain, value) => createHmac('sha256', key)
  .update(`tibotattle-timing-experiment/${METHOD}/${domain}\0`).update(value).digest('hex');
const integer = x => Number.isSafeInteger(x) && x >= 0;
const stamp = x => typeof x === 'string' ? Date.parse(x) : NaN;
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 256;

export function createParser(key, saved, onTurn) {
  const s = saved ?? { own: null, blocked: false, model: null, effort: null, turns: {},
    legacyTotal: null,
    diagnostics: { malformed: 0, oversized: 0, orphan: 0, capacity: 0, completed: 0 } };
  const hash = (domain, value) => digest(key, domain, value);
  const bad = (t, reason) => {
    t.bad = true; t.problem ??= reason; t.windowBad = true;
    if (!['unreadable_evidence', 'item_interval', 'window_endpoint'].includes(reason)) t.fatal = true;
  };
  const invalidate = () => {
    for (const t of Object.values(s.turns)) { bad(t, 'unreadable_evidence'); t.legacy.windowBad = true; }
    s.legacyTotal = null;
  };
  const resetLegacy = (t, at) => {
    Object.assign(t.legacy, { first: null, lastItem: null, end: null, windowBad: false, toolSeen: false, previous: at });
  };
  function legacyCount(p, at) {
    const total = p.info?.total_token_usage, last = p.info?.last_token_usage;
    const before = s.legacyTotal;
    s.legacyTotal = integer(total?.output_tokens) && integer(total?.reasoning_output_tokens)
      && total.reasoning_output_tokens <= total.output_tokens
      ? { output: total.output_tokens, reasoning: total.reasoning_output_tokens } : null;
    const active = Object.values(s.turns);
    if (!s.legacyTotal || !before) {
      for (const t of active) {
        if (integer(last?.output_tokens) && last.output_tokens > 0) t.legacy.observed++;
        resetLegacy(t, at); t.legacy.windowBad = !integer(at);
      }
      return;
    }
    const n = s.legacyTotal.output - before.output, reasoning = s.legacyTotal.reasoning - before.reasoning;
    if (n === 0 && reasoning === 0) return; // Repeated snapshots are not responses.
    if (active.length !== 1) {
      for (const t of active) { resetLegacy(t, at); t.legacy.windowBad = true; }
      return;
    }
    const t = active[0], l = t.legacy;
    if (++l.observed > 512) { bad(t, 'response_limit'); return; }
    const matched = integer(n) && n > 0 && integer(reasoning) && reasoning <= n
      && n === last?.output_tokens && reasoning === last?.reasoning_output_tokens;
    if (matched && !l.windowBad && integer(at) && l.first !== null && l.end > l.first
      && l.lastItem <= l.end && l.end <= at && l.first >= l.previous) {
      l.tokens += n; l.reasoning += reasoning; l.duration += l.end - l.first; l.covered++;
    }
    resetLegacy(t, at);
  }
  function line(bytes, offset, partial) {
    if (s.blocked) return;
    if (partial) {
      s.diagnostics.oversized++;
      // Only a verified top-level header can establish irrelevance. In
      // particular, a tool result mentioning a timing event is not that event.
      const header = bytes.subarray(0, 512).toString('utf8');
      if (/^\s*\{\s*"timestamp"\s*:\s*"[^"\\]*"\s*,\s*"type"\s*:\s*"response_item"\s*,/.test(header)) {
        // Receipt timing does not consume response-item content. Legacy endpoints
        // do; an unreadable model/tool record makes that legacy window uncertain.
        for (const t of Object.values(s.turns)) t.legacy.windowBad = true;
        return;
      }
      invalidate(); return;
    }
    if (!NEEDLES.some(n => bytes.includes(n))) return;
    let r;
    try { r = JSON.parse(bytes.toString('utf8')); } catch { s.diagnostics.malformed++; invalidate(); return; }
    if (!r || typeof r !== 'object') return;
    const p = r.payload;
    if (!p || typeof p !== 'object') return;
    const at = stamp(r.timestamp);
    if (r.type === 'session_meta') {
      if (s.own || !id(p.id) || p.forked_from_id) { s.blocked = true; s.turns = {}; return; }
      s.own = hash('session', p.id); return;
    }
    if (!s.own) return;
    if (r.type === 'compacted') { invalidate(); return; }
    const tid = id(p.turn_id) ? hash('turn', `${s.own}/${p.turn_id}`) : null;
    if (r.type === 'response_item') {
      if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        for (const t of Object.values(s.turns)) t.legacy.toolSeen = true;
        return;
      }
      if (p.type === 'compaction') { invalidate(); return; }
      if (!['reasoning', 'function_call', 'custom_tool_call'].includes(p.type)
        && !(p.type === 'message' && p.role === 'assistant')) {
        if (p.type !== 'agent_message' && !(p.type === 'message' && ['user', 'system', 'developer'].includes(p.role)))
          for (const t of Object.values(s.turns)) t.legacy.windowBad = true;
        return;
      }
      const meta = p.internal_chat_message_metadata_passthrough;
      const target = id(meta?.turn_id) ? hash('turn', `${s.own}/${meta.turn_id}`) : null;
      const t = s.turns[target];
      if (!t) { for (const a of Object.values(s.turns)) a.legacy.windowBad = true; return; }
      const l = t.legacy;
      if (!integer(at) || at < l.previous || l.toolSeen || (l.end !== null && at < l.end)) l.windowBad = true;
      else l.end = at;
      return;
    }
    if (r.type === 'event_msg' && p.type === 'token_count') { legacyCount(p, at); return; }
    if (r.type === 'turn_context') {
      s.model = MODELS.has(p.model) ? p.model : null;
      s.effort = EFFORTS.has(p.effort) ? p.effort : null;
      const t = s.turns[tid];
      if (t) {
        if ((t.responses || t.first !== null || t.legacy.observed || t.legacy.first !== null || t.legacy.end !== null)
          && (t.model !== s.model || t.effort !== s.effort)) t.mixed = true;
        t.model = s.model; t.effort = s.effort;
      } else {
        // An unattributable settings change cannot silently leave a pending
        // window labelled with the previous model.
        for (const a of Object.values(s.turns))
          if (a.model !== s.model || a.effort !== s.effort) a.mixed = true;
      }
      return;
    }
    if (!tid) {
      if (r.type === 'token_usage_record') for (const t of Object.values(s.turns)) t.modernSeen = true;
      if (r.type === 'event_msg' && p.type === 'item_completed')
        for (const t of Object.values(s.turns)) {
          t.legacy.windowBad = true;
          if (['Reasoning', 'AgentMessage'].includes(p.item?.type)) bad(t, 'unreadable_evidence');
        }
      return;
    }
    if (r.type === 'event_msg' && p.type === 'task_started') {
      if (s.turns[tid]) { bad(s.turns[tid], 'duplicate_start'); return; }
      if (Object.keys(s.turns).length >= 8) { s.diagnostics.capacity++; invalidate(); return; }
      if (!integer(at)) return;
      const concurrent = Object.keys(s.turns).length > 0;
      if (concurrent) for (const t of Object.values(s.turns)) t.legacy.windowBad = true;
      s.turns[tid] = { start: at, model: s.model, effort: s.effort, mixed: false,
        bad: false, fatal: false, windowBad: false, first: null, lastItem: null, previous: at, tokens: 0, reasoning: 0,
        finalTokens: null, finalReasoning: null, duration: 0, responses: 0,
        covered: 0, coveredTokens: 0, coveredReasoning: 0, seen: {}, modernSeen: false,
        legacy: { first: null, lastItem: null, end: null, windowBad: concurrent, toolSeen: false,
          previous: at, tokens: 0, reasoning: 0, duration: 0, covered: 0, observed: 0 } };
      return;
    }
    const t = s.turns[tid];
    if (!t) {
      if (r.type === 'token_usage_record') {
        s.diagnostics.orphan++;
        for (const a of Object.values(s.turns)) a.modernSeen = true;
      }
      if (r.type === 'event_msg' && p.type === 'item_completed')
        for (const a of Object.values(s.turns)) {
          a.legacy.windowBad = true;
          if (['Reasoning', 'AgentMessage'].includes(p.item?.type)) bad(a, 'unreadable_evidence');
        }
      return;
    }
    if (r.type === 'event_msg' && p.type === 'turn_aborted') { delete s.turns[tid]; return; }
    if (r.type === 'event_msg' && p.type === 'item_completed') {
      if (!id(p.thread_id) || hash('session', p.thread_id) !== s.own) { bad(t, 'identity'); return; }
      if (!['Reasoning', 'AgentMessage'].includes(p.item?.type)) return;
      const a = p.started_at_ms, b = p.completed_at_ms;
      const l = t.legacy;
      if (!integer(a) || !integer(b) || b < a || a < l.previous || l.toolSeen) l.windowBad = true;
      else {
        l.first = l.first === null ? a : Math.min(l.first, a);
        l.lastItem = l.lastItem === null ? b : Math.max(l.lastItem, b);
      }
      if (!integer(a) || !integer(b) || b < a || a < t.start - 2000 || a < t.previous) {
        bad(t, 'item_interval'); return;
      }
      t.first = t.first === null ? a : Math.min(t.first, a);
      t.lastItem = t.lastItem === null ? b : Math.max(t.lastItem, b);
      return;
    }
    if (r.type === 'token_usage_record') {
      t.modernSeen = true;
      if (!id(p.thread_id) || hash('session', p.thread_id) !== s.own || !id(p.response_id)) { bad(t, 'identity'); return; }
      const response = hash('response', p.response_id);
      if (t.seen[response]) { bad(t, 'duplicate_response'); t.first = null; t.lastItem = null; return; }
      if (t.responses >= 512) { bad(t, 'response_limit'); s.diagnostics.capacity++; return; }
      t.seen[response] = 1;
      const n = p.usage?.output_tokens, reasoning = p.usage?.reasoning_output_tokens;
      t.responses++;
      if (!integer(n) || !integer(reasoning) || reasoning > n || !integer(at) || at < t.previous) {
        bad(t, 'usage_interval'); return;
      }
      t.tokens += n; t.reasoning += reasoning;
      t.finalTokens = p.turn_token_usage?.output_tokens ?? null;
      t.finalReasoning = p.turn_token_usage?.reasoning_output_tokens ?? null;
      if (!t.windowBad && t.first !== null && at > t.first && t.lastItem <= at) {
        t.duration += at - t.first; t.covered++;
        t.coveredTokens += n; t.coveredReasoning += reasoning;
      } else bad(t, 'window_endpoint');
      t.previous = at; t.first = null; t.lastItem = null; t.windowBad = false;
      return;
    }
    if (r.type === 'event_msg' && p.type === 'task_complete') {
      const elapsed = p.duration_ms;
      const boundary = integer(at) && integer(elapsed) && elapsed > 0
        && Math.abs(at - t.start - elapsed) <= 2000 && t.previous <= at + 1000;
      const reconciled = integer(t.finalTokens) && t.tokens === t.finalTokens
        && t.reasoning === t.finalReasoning && Number.isSafeInteger(t.tokens);
      const valid = boundary && reconciled && !t.bad && !t.mixed && !p.error
        && t.responses > 0 && t.covered === t.responses && t.duration > 0
        && t.first === null && t.duration <= elapsed + 2000;
      const ttft = boundary && !p.error && !t.mixed && integer(p.time_to_first_token_ms)
        && p.time_to_first_token_ms <= elapsed ? p.time_to_first_token_ms : null;
      const sampled = boundary && reconciled && !t.fatal && !t.mixed && !p.error
        && t.covered > 0 && t.duration > 0 && t.duration <= elapsed + 2000;
      const legacy = boundary && !t.modernSeen && !t.fatal && !t.mixed && !p.error
        && t.legacy.covered > 0 && t.legacy.duration > 0 && t.legacy.duration <= elapsed + 2000
        && Number.isSafeInteger(t.legacy.tokens) && Number.isSafeInteger(t.legacy.reasoning);
      // A fresh allowlist; never spread provider records into retained data.
      if (integer(at)) onTurn({ key: tid, offset, at, model: t.mixed ? null : t.model,
        effort: t.mixed ? null : t.effort, tokens: reconciled ? t.tokens : null,
        reasoning: reconciled ? t.reasoning : null, duration: valid ? t.duration : null,
        ttft, responses: t.responses, covered: t.covered,
        sample_tokens: sampled ? t.coveredTokens : legacy ? t.legacy.tokens : null,
        sample_reasoning: sampled ? t.coveredReasoning : legacy ? t.legacy.reasoning : null,
        sample_duration: sampled ? t.duration : legacy ? t.legacy.duration : null,
        sample_responses: sampled ? t.covered : legacy ? t.legacy.covered : 0,
        sample_total_responses: t.modernSeen ? t.responses : t.legacy.observed,
        sample_method: sampled ? 'receipt' : legacy ? 'legacy' : null,
        quality: valid ? 'complete' : !boundary ? 'invalid_boundary' : !reconciled ? 'usage_mismatch'
          : t.mixed ? 'mixed_model' : t.bad ? t.problem ?? 'invalid_evidence' : 'missing_window' });
      delete s.turns[tid]; s.diagnostics.completed++;
    }
  }
  return { line, state: () => {
    if (Buffer.byteLength(JSON.stringify(s)) > MAX_STATE_BYTES) {
      s.diagnostics.capacity++; s.turns = {};
    }
    return s;
  } };
}
