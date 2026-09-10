/** Bounded indexed range transfers for the dominant v1 record table only. */
const quote = s => '"'+s.replaceAll('"','""')+'"';
const check = (ok,code) => {if(!ok)throw Error('ACCOUNTLESS_RANGE_'+code);};
const prefix='_accountless_move_';
export function usesRangeRecordBatch(current) {
  const order=current.phase==='evacuate'?[...current.order].reverse():current.order;
  return current.rangeRecordBatches===true && order[current.tableIndex]==='telemetry_v1_records';
}
function context(current) {
  check(usesRangeRecordBatch(current)&&['evacuate','restore'].includes(current.phase),'MODE');
  const table='telemetry_v1_records',d=current.descriptors[table],evacuating=current.phase==='evacuate';
  check(d.hasRowid&&d.keys.length===1&&d.keys[0]==='rowid','SCHEMA');
  check(Number.isSafeInteger(current.revision)&&current.revision>=0&&Number.isSafeInteger(current.cursor)&&current.cursor>=0,'COUNTER');
  return {table,d,evacuating,from:evacuating?table:prefix+table,to:evacuating?prefix+table:table,key:evacuating?'rowid':'_move_key'};
}
const bytes=d=>d.columns.map(c=>`COALESCE(length(CAST(${quote(c)} AS BLOB)),0)`).join('+');
const limitRows=n=>check(Number.isSafeInteger(n)&&n>0&&n<=8192,'ROWS');
export function accountlessRangeSelection(current,{maxRows=1024}={}) {
  limitRows(maxRows);const {from,key,d}=context(current);
  return {sql:`SELECT COUNT(*) AS selected_rows,CAST(MIN(k) AS TEXT) AS first_key,CAST(MAX(k) AS TEXT) AS last_key,COALESCE(SUM(n),0) AS selected_bytes,COALESCE(MAX(n),0) AS max_row_bytes FROM (SELECT ${quote(key)} AS k,(${bytes(d)}) AS n FROM ${quote(from)} ORDER BY ${quote(key)} LIMIT ${maxRows})`,params:[]};
}
function integerKey(k) {check(typeof k==='string'&&/^-?(0|[1-9][0-9]*)$/.test(k)&&BigInt(k)>=-9223372036854775808n&&BigInt(k)<=9223372036854775807n,'KEY');}
export function planAccountlessRangeBatch({current,selection,expectedRevision,maxRows=1024,maxBytes=16*1024*1024,permission=null}) {
  limitRows(maxRows);const {table,d,evacuating,from,to,key}=context(current);
  check(current.revision===expectedRevision,'REVISION');
  check(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=16*1024*1024,'BYTES');
  check(selection&&Object.keys(selection).sort().join(',')==='first_key,last_key,max_row_bytes,selected_bytes,selected_rows','SELECTION');
  const count=selection.selected_rows,total=selection.selected_bytes,largest=selection.max_row_bytes;
  check(Number.isSafeInteger(count)&&count>=0&&count<=maxRows&&Number.isSafeInteger(total)&&total>=0&&Number.isSafeInteger(largest)&&largest>=0,'SELECTION');
  check(total<=maxBytes&&largest<=1024*1024,'BYTES');
  check((count===0&&total===0&&largest===0&&selection.first_key===null&&selection.last_key===null)||(count>0&&largest<=total),'SELECTION');
  const statements=[],add=(sql,...params)=>statements.push({sql,params});
  const assert=(condition,...params)=>add(`INSERT OR REPLACE INTO ${prefix}assertion(id,ok) VALUES(1,(${condition}))`,...params);
  if(permission){check(permission.begin?.sql&&Array.isArray(permission.begin.params)&&permission.end?.length===2&&permission.end.every(s=>typeof s.sql==='string'&&Array.isArray(s.params)),'PERMISSION');statements.push(permission.begin);}
  assert(`SELECT metadata=? FROM ${prefix}journal WHERE id=1`,JSON.stringify(current));
  if(count) {
    integerKey(selection.first_key);integerKey(selection.last_key);check(BigInt(selection.first_key)<=BigInt(selection.last_key),'KEY');
    const bounds=[selection.first_key,selection.last_key],where=`${quote(key)} BETWEEN CAST(? AS INTEGER) AND CAST(? AS INTEGER)`,cols=d.columns.map(quote).join(',');
    // The limit bounds the admission check even if a stale range gained rows.
    assert(`SELECT COUNT(*)=? AND COALESCE(SUM(n),0)=? AND COALESCE(MAX(n),0)=? FROM (SELECT (${bytes(d)}) AS n FROM ${quote(from)} WHERE ${where} LIMIT ${maxRows+1})`,count,total,largest,...bounds);
    if(evacuating)add(`INSERT INTO ${quote(to)} (_move_key,_original_rowid,${cols}) SELECT rowid,rowid,${cols} FROM ${quote(from)} WHERE ${where}`,...bounds);
    else add(`INSERT INTO ${quote(to)} (rowid,${cols}) SELECT _original_rowid,${cols} FROM ${quote(from)} WHERE ${where}`,...bounds);
    assert('changes()=?',count);
    const equal=d.columns.map(c=>`a.${quote(c)} IS b.${quote(c)}`).join(' AND ');
    assert(`SELECT COUNT(*)=? FROM ${quote(prefix+table)} b JOIN ${quote(table)} a ON a.rowid=b._original_rowid WHERE b._move_key BETWEEN CAST(? AS INTEGER) AND CAST(? AS INTEGER) AND ${equal}`,count,...bounds);
    add(`DELETE FROM ${quote(from)} WHERE ${where}`,...bounds);assert('changes()=?',count);
  } else assert(`NOT EXISTS(SELECT 1 FROM ${quote(from)} LIMIT 1)`);
  const revision=current.revision+1,cursor=current.cursor+count;check(Number.isSafeInteger(revision)&&Number.isSafeInteger(cursor),'COUNTER');
  add(`UPDATE ${prefix}journal SET metadata=json_set(metadata,'$.revision',CAST(? AS INTEGER),'$.tableIndex',CASE WHEN EXISTS(SELECT 1 FROM ${quote(from)} LIMIT 1) THEN CAST(? AS INTEGER) ELSE CAST(? AS INTEGER) END,'$.cursor',CASE WHEN EXISTS(SELECT 1 FROM ${quote(from)} LIMIT 1) THEN CAST(? AS INTEGER) ELSE 0 END) WHERE id=1 AND metadata=?`,revision,current.tableIndex,current.tableIndex+1,cursor,JSON.stringify(current));
  assert('changes()=1');add(`DELETE FROM ${prefix}assertion WHERE id=1`);if(permission)statements.push(...permission.end);
  return {statements,result:{phase:current.phase,revision,rows:count,bytes:total},readback:{sql:`SELECT metadata FROM ${prefix}journal WHERE id=1`,params:[]}};
}
