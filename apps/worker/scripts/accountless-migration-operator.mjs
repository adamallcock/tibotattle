/** Injected transport only. No CLI, credentials, resource operations, or implicit retry. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildMutationBarrierPermissionStatements } from '../src/mutation-barrier.ts';
import { accountlessMovementSelection, planAccountlessMovementBatch } from './accountless-migration-movement.mjs';
import { usesRangeRecordBatch, accountlessRangeSelection, planAccountlessRangeBatch } from './accountless-migration-range.mjs';
const journal = 'SELECT metadata FROM _accountless_move_journal WHERE id=1';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const reject = code => { throw new Error(code); };
const requireThat = (value, code) => { if (!value) reject(code); };
const bounded = (value, maximum) => Number.isSafeInteger(value) && value > 0 && value <= maximum;

/** Render reviewed prepared SQL without parsing/reformatting compound canonical SQL.
 * Question marks in literals/comments are preserved. Compound entries cannot bind.
 */
export function renderMovementSql(statements) {
  requireThat(Array.isArray(statements) && statements.length > 0, 'STATEMENTS_INVALID');
  return statements.map(({ sql, params, compound }) => {
    requireThat(typeof sql === 'string' && Array.isArray(params), 'STATEMENTS_INVALID');
    if (compound) requireThat(params.length === 0, 'COMPOUND_BINDINGS_REFUSED');
    let index = 0, result = '', mode = null, lastToken = null;
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i], n = sql[i+1];
      if (mode === 'line') { result += c; if (c === '\n') mode = null; continue; }
      if (mode === 'block') { result += c; if (c === '*' && n === '/') { result += n; i++; mode = null; } continue; }
      if (mode) { result += c; if (c === mode) { if (n === mode) { result += n; i++; } else mode = null; } continue; }
      if (c === '-' && n === '-') { result += c+n; i++; mode = 'line'; }
      else if (c === '/' && n === '*') { result += c+n; i++; mode = 'block'; }
      else if (c === "'" || c === '"' || c === '`') { result += c; mode = c; lastToken = c; }
      else if (c === '?' && !compound) {
        lastToken = c;
        requireThat(!/[0-9]/.test(n ?? ''), 'NUMBERED_BINDING_REFUSED');
        requireThat(index < params.length, 'BINDING_COUNT'); const value = params[index++];
        if (value === null) result += 'NULL';
        else if (typeof value === 'number' && Number.isSafeInteger(value)) result += String(value);
        else if (typeof value === 'string' && !value.includes('\0')) result += "'" + value.replaceAll("'", "''") + "'";
        else reject('BINDING_INVALID');
      } else { result += c; if (!/\s/.test(c)) lastToken = c; }
    }
    requireThat(index === params.length && (!mode || mode === 'line'), 'BINDING_COUNT');
    requireThat(lastToken !== null, 'STATEMENT_EMPTY');
    // D1 rejects empty statements between delimiters, even though SQLite accepts
    // them. Keep canonical bytes intact and add only a missing final delimiter.
    return lastToken === ';' ? result : result + '\n;';
  }).join('\n');
}

/** A stopped run is never automatically resumed. Only the caller can admit a new run.
 * read(statement) -> row array. batch({statements,sql}) -> {outcome:'committed'|'rolled_back'}.
 * Any transport exception, timeout or invalid batch response is an unknown outcome.
 */
export async function runAccountlessMovementPhase({ startJournal, operationId, permission, transport,
  maxRows = 32, maxBytes = 256*1024, rangeMaxRows = 1024, rangeMaxBytes = 1024*1024, maxSqlBytes = 96*1024,
  maxBatches = 100, timeoutMs = 60000, now = () => performance.now(), onProgress = () => {} } = {}) {
  const start = now(); let checkpoint = structuredClone(startJournal), uncertain = false;
  const receipt = { schemaVersion: 'accountless-movement-phase-v1', outcome: 'stopped', code: null,
    batches: 0, attemptedBatches: 0, rows: 0, bytes: 0, phase: checkpoint?.phase ?? null, checkpointRevision: checkpoint?.revision ?? null,
    checkpointSha256: checkpoint === undefined ? null : hash(checkpoint), durationMs: 0 };
  const elapsed = () => now() - start;
  async function call(action, mutation = false) {
    const remaining = timeoutMs - elapsed(); requireThat(remaining > 0, 'TIME_BUDGET');
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => action(Math.max(1,Math.min(45000,Math.floor(remaining))))), new Promise((_, fail) => {
        timer = setTimeout(() => fail(new Error('TRANSPORT_TIMEOUT')), remaining);
      })]);
    } catch { uncertain ||= mutation; reject(mutation ? 'BATCH_OUTCOME_UNKNOWN' : 'READ_OUTCOME_UNKNOWN'); }
    finally { clearTimeout(timer); }
  }
  function parseJournal(rows) {
    requireThat(Array.isArray(rows) && rows.length === 1 && typeof rows[0].metadata === 'string', 'JOURNAL_INVALID');
    try { return JSON.parse(rows[0].metadata); } catch { reject('JOURNAL_INVALID'); }
  }
  try {
    requireThat(bounded(maxRows,64) && bounded(maxBytes,1024*1024) && bounded(maxSqlBytes,100*1024)
      && bounded(rangeMaxRows,8192) && bounded(rangeMaxBytes,16*1024*1024) && bounded(maxBatches,10000) && bounded(timeoutMs,600000), 'LIMIT_INVALID');
    requireThat(transport && typeof transport.read === 'function' && typeof transport.batch === 'function', 'TRANSPORT_INVALID');
    requireThat(typeof operationId === 'string' && permission?.begin && Array.isArray(permission.end) && permission.end.length === 2, 'PERMISSION_REQUIRED');
    requireThat(isDeepStrictEqual(permission,buildMutationBarrierPermissionStatements(operationId)), 'PERMISSION_REQUIRED');
    requireThat(checkpoint && ['evacuate','restore'].includes(checkpoint.phase)
      && Array.isArray(checkpoint.order) && Number.isSafeInteger(checkpoint.tableIndex)
      && checkpoint.tableIndex >= 0 && checkpoint.tableIndex <= checkpoint.order.length, 'START_INVALID');
    requireThat(isDeepStrictEqual(parseJournal(await call(remaining => transport.read({sql:journal,params:[]},{timeoutMs:remaining}))),checkpoint), 'START_DRIFT');
    while (checkpoint.tableIndex < checkpoint.order.length) {
      requireThat(receipt.batches < maxBatches, 'BATCH_BUDGET');
      requireThat(elapsed() < timeoutMs, 'TIME_BUDGET');
      let candidate;
      if (usesRangeRecordBatch(checkpoint)) {
        let count=rangeMaxRows, selected;
        // Re-read a smaller bounded selection before dispatch if its payload
        // exceeds admission. This loop never retries a mutation.
        for (;;) {
          const rows=await call(remaining => transport.read(accountlessRangeSelection(checkpoint,{maxRows:count}),{timeoutMs:remaining}));
          requireThat(Array.isArray(rows)&&rows.length===1,'SELECTION_INVALID');
          selected=rows[0];
          requireThat(Number.isSafeInteger(selected.selected_bytes)&&selected.selected_bytes>=0&&Number.isSafeInteger(selected.max_row_bytes)&&selected.max_row_bytes>=0,'SELECTION_INVALID');
          requireThat(selected.max_row_bytes<=1024*1024,'ROW_BUDGET');
          if(selected.selected_bytes<=rangeMaxBytes)break;
          requireThat(count>1,'ROW_BUDGET');count=Math.max(1,Math.floor(count/2));
        }
        const plan=planAccountlessRangeBatch({current:checkpoint,selection:selected,expectedRevision:checkpoint.revision,maxRows:count,maxBytes:rangeMaxBytes,permission});
        const sql=renderMovementSql(plan.statements);
        candidate={plan,sql,sqlBytes:Buffer.byteLength(sql)};
      } else {
      const selection = accountlessMovementSelection(checkpoint,{maxRows});
      const selectedRows = await call(remaining => transport.read(selection,{timeoutMs:remaining}));
      requireThat(Array.isArray(selectedRows) && selectedRows.every(row => Object.keys(row).every(k => k === '_bytes' || /^_key[0-9]+$/.test(k))), 'SELECTION_INVALID');
      const prepare = count => {
        const plan = planAccountlessMovementBatch({ current:checkpoint, selectedRows:selectedRows.slice(0,count),
          expectedRevision:checkpoint.revision, maxRows, maxBytes, permission });
        const sql = renderMovementSql(plan.statements);
        return {plan,sql,sqlBytes:Buffer.byteLength(sql)};
      };
      candidate = prepare(selectedRows.length);
      if (candidate.sqlBytes > maxSqlBytes && selectedRows.length > 1) {
        // Search only local plans for the largest fitting prefix. No transport
        // call or write has occurred, so this is never a remote mutation retry.
        let low=1, high=selectedRows.length-1, fitting=null;
        while (low<=high) {
          const count=Math.floor((low+high)/2), smaller=prepare(count);
          if (smaller.sqlBytes<=maxSqlBytes) { fitting=smaller; low=count+1; }
          else high=count-1;
        }
        if (fitting) candidate=fitting;
      }
      }
      requireThat(candidate.sqlBytes <= maxSqlBytes, 'SQL_BUDGET');
      const {plan,sql}=candidate;
      requireThat(elapsed() < timeoutMs, 'TIME_BUDGET');
      receipt.attemptedBatches++;
      const result = await call(remaining => transport.batch({statements:plan.statements,sql,timeoutMs:remaining}),true);
      if (result?.outcome === 'rolled_back') reject('BATCH_ROLLED_BACK');
      if (result?.outcome !== 'committed') { uncertain = true; reject('BATCH_OUTCOME_UNKNOWN'); }
      // Until exact post-commit readback succeeds, the prior checkpoint remains
      // the last proven one. Never replay it after an uncertain write/readback.
      uncertain = true;
      const order = checkpoint.phase === 'evacuate' ? [...checkpoint.order].reverse() : checkpoint.order;
      const from = (checkpoint.phase === 'restore' ? '_accountless_move_' : '') + order[checkpoint.tableIndex];
      const readback = {sql:`SELECT metadata,EXISTS(SELECT 1 FROM ${quote(from)} LIMIT 1) AS remaining FROM _accountless_move_journal WHERE id=1`,params:[]};
      const rows = await call(remaining => transport.read(readback,{timeoutMs:remaining}));
      const actual = parseJournal(rows); requireThat(rows[0].remaining === 0 || rows[0].remaining === 1, 'JOURNAL_INVALID');
      const expected = {...checkpoint,revision:checkpoint.revision+1,
        tableIndex:checkpoint.tableIndex+(rows[0].remaining ? 0 : 1),cursor:rows[0].remaining ? checkpoint.cursor+plan.result.rows : 0};
      requireThat(isDeepStrictEqual(actual,expected), 'CHECKPOINT_DRIFT');
      checkpoint = actual; uncertain = false;
      receipt.batches++; receipt.rows += plan.result.rows; receipt.bytes += plan.result.bytes;
      receipt.checkpointRevision=checkpoint.revision; receipt.checkpointSha256=hash(checkpoint);
      try { onProgress(Object.freeze({...receipt,durationMs:Math.ceil(elapsed())})); }
      catch { reject('PROGRESS_SINK_FAILED'); }
    }
    receipt.outcome='complete'; receipt.code='PHASE_COMPLETE';
  } catch (error) {
    const allowed = new Set(['LIMIT_INVALID','TRANSPORT_INVALID','PERMISSION_REQUIRED','START_INVALID','START_DRIFT',
      'ROW_BUDGET','PROGRESS_SINK_FAILED','JOURNAL_INVALID','SELECTION_INVALID','BATCH_BUDGET','TIME_BUDGET','SQL_BUDGET','BATCH_ROLLED_BACK',
      'BATCH_OUTCOME_UNKNOWN','READ_OUTCOME_UNKNOWN','CHECKPOINT_DRIFT']);
    receipt.outcome=uncertain?'uncertain':'stopped'; receipt.code=allowed.has(error.message)?error.message:
      error.message === 'ACCOUNTLESS_MOVEMENT_ROW_TOO_LARGE' ? 'ROW_BUDGET' : 'OPERATOR_REFUSED';
  }
  receipt.durationMs=Math.ceil(elapsed());
  return {receipt,checkpoint};
}
