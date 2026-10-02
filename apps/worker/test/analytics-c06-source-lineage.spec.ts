import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {c06SourceLineageObserver} from './helpers/analytics-c06-source-lineage';

it('resolves a view alias to its physical source and refuses unknown source-result projections',async()=>{
  await reset();
  const db=env.USAGE_MONITOR_DB;
  await db.prepare('CREATE TABLE c06_lineage_source(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)').run();
  await db.prepare('CREATE VIEW c06_lineage_view AS SELECT id,payload FROM c06_lineage_source').run();
  await db.prepare("INSERT INTO c06_lineage_source VALUES(1,'synthetic-only')").run();
  let phase='view';
  const observer=c06SourceLineageObserver(db,()=>({consumer:'fixture',phase}),
    {allowedPhases:['view','empty','batch']});
  const selected=await observer.source.prepare('SELECT id AS selected FROM c06_lineage_view WHERE id=?')
    .bind(1).first<{selected:number}>();
  expect(selected).toEqual({selected:1});
  phase='empty';
  expect((await observer.source.prepare('SELECT id AS selected FROM c06_lineage_view WHERE id=?')
    .bind(2).all()).results).toEqual([]);
  phase='batch';
  const batch=await observer.source.batch([
    observer.source.prepare('SELECT id AS selected FROM c06_lineage_view WHERE id=?').bind(1),
    observer.source.prepare('SELECT id AS selected FROM c06_lineage_view WHERE id=?').bind(2),
  ]);
  expect(batch.map(row=>row.results.length)).toEqual([1,0]);
  const report=await observer.report({expectedSourceCalls:4});
  expect(report.allMeasured).toBe(true);
  expect(report.meterReconciled).toBe(true);
  expect(report.noRescanQualified).toBe(false);
  expect(report.perConsumer.fixture?.attempts).toBe(4);
  expect(report.measurements).toHaveLength(3);
  expect(report.measurements.every(row=>row.physical.includes('c06_lineage_source'))).toBe(true);
  expect(report.measurements.every(row=>!('plan' in row)&&!('resultColumns' in row)&&!('sql' in row))).toBe(true);
  expect(report.measurements.find(row=>row.phase==='empty')?.projectionUnknown).toBe(true);
  expect(report.measurements.find(row=>row.phase==='empty')?.projection).toBe('unobserved_empty');
  expect(report.measurements.find(row=>row.phase==='batch')?.emptyResults).toBe(1);
  expect((await observer.report({expectedSourceCalls:5})).meterReconciled).toBe(false);
  expect(()=>observer.source.exec('SELECT 1')).toThrow('C06_UNOBSERVED_ADAPTER');
  const foreign=db.prepare('SELECT 1');
  await expect(observer.source.batch([foreign])).rejects.toThrow('C06_FOREIGN_BATCH_STATEMENT');
});

it('observes a D1 session through the same physical-source proof',async()=>{
  await reset();
  const db=env.USAGE_MONITOR_DB;
  await db.prepare('CREATE TABLE c06_session_source(id INTEGER PRIMARY KEY)').run();
  await db.prepare('INSERT INTO c06_session_source VALUES(1)').run();
  const observer=c06SourceLineageObserver(db,()=>({consumer:'fixture',phase:'session'}),
    {allowedPhases:['session']});
  const session=observer.source.withSession();
  expect(await session.prepare('SELECT id FROM c06_session_source WHERE id=?').bind(1).first<number>('id')).toBe(1);
  const report=await observer.report();
  expect(report.allMeasured).toBe(true);
  expect(report.measurements[0]?.physical).toContain('c06_session_source');
});

it('keeps caught SQL, missing-column and unsupported-adapter failures sticky',async()=>{
  await reset();
  const db=env.USAGE_MONITOR_DB;
  const observer=c06SourceLineageObserver(db,()=>({consumer:'fixture',phase:'negative'}),
    {allowedPhases:['negative']});
  await expect(observer.source.prepare('SELECT value FROM c06_missing_source').first('value')).rejects.toThrow();
  await expect(observer.source.prepare('SELECT 1 AS ready').first('missing')).rejects
    .toThrow('analytics benchmark first() column unavailable');
  expect(()=>observer.source.dump()).toThrow('C06_UNOBSERVED_ADAPTER');
  const report=await observer.report();
  expect(report.allMeasured).toBe(false);
  expect(report.boundaryFailures).toBe(1);
  expect(report.measurements.map(row=>row.failures)).toEqual([1,1]);
  expect(report.measurements.every(row=>row.diagnosticFailure)).toBe(true);
});

it('retains physical trigger-program reads behind a source mutation',async()=>{
  await reset();
  const db=env.USAGE_MONITOR_DB;
  await db.prepare('CREATE TABLE c06_trigger_history(id INTEGER PRIMARY KEY, proof TEXT NOT NULL)').run();
  await db.prepare('CREATE TABLE c06_trigger_sink(id INTEGER PRIMARY KEY)').run();
  await db.prepare("INSERT INTO c06_trigger_history VALUES(1,'synthetic-proof')").run();
  await db.prepare(`CREATE TRIGGER c06_trigger_lookup AFTER INSERT ON c06_trigger_sink
    BEGIN SELECT proof FROM c06_trigger_history WHERE id=NEW.id; END`).run();
  const observer=c06SourceLineageObserver(db,()=>({consumer:'fixture',phase:'trigger'}),
    {allowedPhases:['trigger']});
  await observer.source.prepare('INSERT INTO c06_trigger_sink VALUES(?)').bind(1).run();
  const report=await observer.report();
  expect(report.allMeasured).toBe(true);
  expect(report.measurements[0]?.rowsWritten).toBeGreaterThan(0);
  expect(report.measurements[0]?.physical).toEqual(expect.arrayContaining([
    'c06_trigger_history','c06_trigger_sink',
  ]));
});

it('counts a mixed unclassified operation without blocking its product SQL',async()=>{
  await reset();
  const db=env.USAGE_MONITOR_DB;
  const observer=c06SourceLineageObserver(db,()=>({consumer:'unclassified',phase:'warm'}),
    {allowedPhases:['warm']});
  await observer.establishSchema();
  expect(await observer.source.prepare('SELECT 1 AS ready').first<number>('ready')).toBe(1);
  const report=await observer.report({expectedSourceCalls:1});
  expect(report.perConsumer.unclassified?.attempts).toBe(1);
  expect(report.boundaryFailures).toBe(0);
  expect(report.noRescanQualified).toBe(false);
});
