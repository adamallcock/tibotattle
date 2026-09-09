// Local experiment only. No accounting or hosted-contribution consumers.
import { createHmac } from 'node:crypto';

export const METHOD = 1;
export const MAX_STATE_BYTES = 128 * 1024;
const MODELS = new Set(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex',
  'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.2', 'auto-review']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const NEEDLES = ['session_meta', 'turn_context', 'item_completed', 'token_usage_record',
  'task_started', 'task_complete', 'turn_aborted', 'compacted'].map(x => Buffer.from(x));
export const digest = (key, domain, value) => createHmac('sha256', key)
  .update(`tibotattle-timing-experiment/${METHOD}/${domain}\0`).update(value).digest('hex');
const integer = x => Number.isSafeInteger(x) && x >= 0;
const stamp = x => typeof x === 'string' ? Date.parse(x) : NaN;
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 256;

export function createParser(key, saved, onTurn) {
  const s = saved ?? { own: null, blocked: false, model: null, effort: null, turns: {},
    diagnostics: { malformed: 0, oversized: 0, orphan: 0, capacity: 0, completed: 0 } };
  const hash = (domain, value) => digest(key, domain, value);
  const bad = (t, reason) => { t.bad = true; t.problem ??= reason; };
  const invalidate = () => { for (const t of Object.values(s.turns)) bad(t, 'unreadable_evidence'); };
  function line(bytes, offset, partial) {
    if (s.blocked) return;
    if (partial) {
      s.diagnostics.oversized++;
      // Only a verified top-level header can establish irrelevance. In
      // particular, a tool result mentioning a timing event is not that event.
      const header = bytes.subarray(0, 512).toString('utf8');
      if (/^\s*\{\s*"timestamp"\s*:\s*"[^"\\]*"\s*,\s*"type"\s*:\s*"response_item"\s*,/.test(header)) return;
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
    if (r.type === 'turn_context') {
      s.model = MODELS.has(p.model) ? p.model : null;
      s.effort = EFFORTS.has(p.effort) ? p.effort : null;
      const t = s.turns[tid];
      if (t) {
        if (t.responses && (t.model !== s.model || t.effort !== s.effort)) t.mixed = true;
        t.model = s.model; t.effort = s.effort;
      }
      return;
    }
    if (!tid) return;
    if (r.type === 'event_msg' && p.type === 'task_started') {
      if (s.turns[tid]) { bad(s.turns[tid], 'duplicate_start'); return; }
      if (Object.keys(s.turns).length >= 8) { s.diagnostics.capacity++; invalidate(); return; }
      if (!integer(at)) return;
      s.turns[tid] = { start: at, model: s.model, effort: s.effort, mixed: false,
        bad: false, first: null, lastItem: null, previous: at, tokens: 0, reasoning: 0,
        finalTokens: null, finalReasoning: null, duration: 0, responses: 0,
        covered: 0, seen: {} };
      return;
    }
    const t = s.turns[tid];
    if (!t) { if (r.type === 'token_usage_record') s.diagnostics.orphan++; return; }
    if (r.type === 'event_msg' && p.type === 'turn_aborted') { delete s.turns[tid]; return; }
    if (r.type === 'event_msg' && p.type === 'item_completed') {
      if (!id(p.thread_id) || hash('session', p.thread_id) !== s.own) { bad(t, 'identity'); return; }
      if (!['Reasoning', 'AgentMessage'].includes(p.item?.type)) return;
      const a = p.started_at_ms, b = p.completed_at_ms;
      if (!integer(a) || !integer(b) || b < a || a < t.start - 2000 || a < t.previous) {
        bad(t, 'item_interval'); return;
      }
      t.first = t.first === null ? a : Math.min(t.first, a);
      t.lastItem = t.lastItem === null ? b : Math.max(t.lastItem, b);
      return;
    }
    if (r.type === 'token_usage_record') {
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
      if (t.first !== null && at > t.first && t.lastItem <= at) {
        t.duration += at - t.first; t.covered++;
      } else bad(t, 'window_endpoint');
      t.previous = at; t.first = null; t.lastItem = null;
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
      // A fresh allowlist; never spread provider records into retained data.
      if (integer(at)) onTurn({ key: tid, offset, at, model: t.mixed ? null : t.model,
        effort: t.mixed ? null : t.effort, tokens: reconciled ? t.tokens : null,
        reasoning: reconciled ? t.reasoning : null, duration: valid ? t.duration : null,
        ttft, responses: t.responses, covered: t.covered,
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
