import {expect,it} from 'vitest';
export const projectionTables=['legacy_sources','v11_domain_heads','mutation_control','graph_scope','publication_state',
  'preview_cache','daily_rebuilds','current_queue_state','current_queue','refresh_lanes','prepared_source_days','preparation_counters'];
export async function resetProjectionState(pool,schema) {
  await pool.query(`INSERT INTO ${schema}.mutation_control(singleton_id) VALUES(1);
    INSERT INTO ${schema}.publication_state VALUES(1,'ready',clock_timestamp());
    INSERT INTO ${schema}.current_queue_state VALUES(1,1);
    INSERT INTO ${schema}.preparation_counters VALUES(1,true,0,0,0,0,0,0,0)`);
}
export function registerProjectionTests({pool:getPool,store:getStore,input,grant,rows,snapshot,schema,pid,did}) {
  const pool=()=>getPool(),store=()=>getStore(),day='2026-09-01';
  async function preview() {await pool().query(`INSERT INTO ${schema}.preview_cache VALUES('synthetic-preview','{}')`);}
  it('preserves graph evidence across accepted append and correction while queueing actual work',async()=>{
    await preview();await pool().query(`INSERT INTO ${schema}.refresh_lanes VALUES('current','complete',clock_timestamp(),NULL)`);
    const first=await grant(await input());await store().insert(first);
    expect((await rows('mutation_control'))[0]).toMatchObject({mutation_epoch:'1',graph_append_epoch:'1',graph_invalidation_epoch:'0',graph_last_change_reason:'accepted-append'});
    expect(await rows('preview_cache')).toHaveLength(1);expect(await rows('graph_scope')).toHaveLength(0);
    expect((await rows('refresh_lanes'))[0]).toMatchObject({state:'queued',completed_at:null,restart_reason:'input_changed'});
    const correction=await grant(await input({revision:2,supersedes:{id:first.chunkId}}));await store().insert(correction);
    expect((await rows('mutation_control'))[0]).toMatchObject({mutation_epoch:'3',graph_append_epoch:'3',graph_invalidation_epoch:'0',graph_last_change_reason:'accepted-correction'});
    expect((await rows('current_queue'))[0]).toMatchObject({dirty_generation:'3',pending:true});
    expect((await rows('daily_rebuilds'))[0]).toMatchObject({requested_epoch:'3'});
    expect((await rows('publication_state'))[0].publication_state).toBe('updating');
    expect(await rows('preview_cache')).toHaveLength(1);expect(await rows('graph_scope')).toHaveLength(0);
  });
  it.each(['legacy_sources','v11_domain_heads'])('hard invalidates when %s prevents graph preservation',async table=>{
    await preview();await pool().query(`INSERT INTO ${schema}.${table} VALUES($1)`,[pid]);
    const value=await grant(await input());await store().insert(value);
    expect((await rows('mutation_control'))[0]).toMatchObject({mutation_epoch:'1',graph_invalidation_epoch:'1',graph_last_change_reason:'authority-or-unrecognized-change'});
    expect(await rows('preview_cache')).toHaveLength(0);
  });
  it('hard invalidates an unrecognized mutation and removes inactive owners from the analysis queue',async()=>{
    const value=await grant(await input());await store().insert(value);await preview();
    await pool().query(`UPDATE ${schema}.chunks SET parser_version='changed' WHERE id=$1`,[value.chunkId]);
    expect((await rows('mutation_control'))[0].graph_invalidation_epoch).toBe('2');
    expect(await rows('preview_cache')).toHaveLength(0);
    await pool().query(`UPDATE ${schema}.participants SET state='deleting' WHERE id=$1`,[pid]);
    expect(await rows('current_queue')).toHaveLength(0);
  });
  it('discards a prepared day only once and keeps progress counters exact',async()=>{
    const value=await grant(await input({count:2}));await store().insert(value);
    await pool().query(`INSERT INTO ${schema}.prepared_source_days VALUES($1,$2,'complete',4,2,3)`,[pid,day]);
    const correction=await grant(await input({revision:2,supersedes:{id:value.chunkId}}));await store().insert(correction);
    expect((await rows('prepared_source_days'))[0]).toMatchObject({phase:'discarding',progress_revision:'5'});
    expect((await rows('preparation_counters'))[0]).toMatchObject({is_exact:true,tracked_days:'1',complete_days:'0',retiring_days:'1',checkpoint_steps:'5',quota_observations:'2',usage_events:'3'});
    await pool().query(`DELETE FROM ${schema}.prepared_source_days WHERE participant_id=$1`,[pid]);
    expect((await rows('preparation_counters'))[0]).toMatchObject({is_exact:true,tracked_days:'0',retiring_days:'0',checkpoint_steps:'0'});
  });
  it('marks impossible preparation counters unknown instead of clamping them',async()=>{
    await pool().query(`INSERT INTO ${schema}.prepared_source_days VALUES($1,$2,'complete',4,2,3)`,[pid,day]);
    await pool().query(`UPDATE ${schema}.preparation_counters SET checkpoint_steps=0`);
    await pool().query(`UPDATE ${schema}.prepared_source_days SET phase='discarding',progress_revision=5`);
    expect((await rows('preparation_counters'))[0].is_exact).toBe(false);
  });
  it('rolls back all projection effects and the graph marker on record ownership conflict',async()=>{
    const first=await grant(await input({occurrence:'occupied'}));await store().insert(first);
    await preview();await pool().query(`INSERT INTO ${schema}.prepared_source_days VALUES($1,$2,'complete',4,2,3)`,[pid,day]);
    const conflict=await grant(await input({sequence:1,occurrence:'occupied'}));const before=await snapshot();
    await expect(store().insert(conflict)).rejects.toMatchObject({code:'RECORD_OWNED_BY_OTHER_CHUNK'});
    expect(await snapshot()).toEqual(before);
  });
  it('serializes concurrent owners at the shared graph epoch without losing either append',async()=>{
    const otherPid='synthetic-projection-owner',otherDid='synthetic-projection-device';
    await pool().query(`INSERT INTO ${schema}.participants VALUES($1,'active','social',10)`,[otherPid]);
    await pool().query(`INSERT INTO ${schema}.devices VALUES($1,$2,'active',clock_timestamp()-interval '30 days',clock_timestamp()+interval '1 day')`,[otherDid,otherPid]);
    await pool().query(`INSERT INTO ${schema}.consents SELECT $1,$2,schema_version,dictionary_version,privacy_version FROM ${schema}.consents WHERE participant_id=$3`,[otherPid,otherDid,pid]);
    const a=await grant(await input()),b=await grant({...await input(),participantId:otherPid,deviceId:otherDid});
    const blocker=await pool().connect();let outcome;
    try {
      await blocker.query('BEGIN');await blocker.query(`SELECT singleton_id FROM ${schema}.mutation_control FOR UPDATE`);
      outcome=Promise.allSettled([store().insert(a),store().insert(b)]);
      let waiting=0;
      for(let n=0;n<80;n++) {
        waiting=(await pool().query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT accepted_records%' AND wait_event_type='Lock'`)).rowCount;
        if(waiting===2) break;await pool().query('SELECT pg_sleep(0.025)');
      }
      expect(waiting).toBe(2);await blocker.query('ROLLBACK');
      expect((await outcome).map(r=>r.status)).toEqual(['fulfilled','fulfilled']);
    } finally {await blocker.query('ROLLBACK');blocker.release();await outcome;}
    expect((await rows('mutation_control'))[0]).toMatchObject({mutation_epoch:'2',graph_append_epoch:'2',graph_invalidation_epoch:'0'});
    expect(await rows('current_queue')).toHaveLength(2);expect(await rows('graph_scope')).toHaveLength(0);
  });
  it('marks preparation overflow unknown while preserving the previous counters',async()=>{
    await pool().query(`INSERT INTO ${schema}.prepared_source_days VALUES($1,$2,'complete',1,1,1)`,[pid,day]);
    await pool().query(`UPDATE ${schema}.preparation_counters SET checkpoint_steps=9007199254740991`);
    await pool().query(`UPDATE ${schema}.prepared_source_days SET progress_revision=2`);
    expect((await rows('preparation_counters'))[0]).toMatchObject({is_exact:false,checkpoint_steps:'9007199254740991'});
  });

  it('invalidates retained dependencies and publication authority at the deletion claim',async()=>{
    await preview();
    expect((await rows('input_versions'))[0].revision).toBe('0');
    await pool().query(`INSERT INTO ${schema}.community_model_history_dependencies
      (participant_id,day,from_day,input_fingerprint,verified_input_revision)
      VALUES($1,'2026-09-01','2026-05-24',$2,0)`,[pid,'a'.repeat(64)]);
    await pool().query(`INSERT INTO ${schema}.community_model_composition_days VALUES('2026-09-01','{}',clock_timestamp(),'synthetic')`);
    await pool().query(`UPDATE ${schema}.participants SET state='deleting' WHERE id=$1`,[pid]);
    expect((await rows('input_versions'))[0].revision).toBe('1');
    expect((await rows('mutation_control'))[0]).toMatchObject({mutation_epoch:'1',graph_invalidation_epoch:'1'});
    expect(await rows('preview_cache')).toEqual([]);
    expect((await rows('publication_state'))[0].publication_state).toBe('updating');
    expect(await rows('community_model_history_dependencies')).toEqual([]);
    expect(await rows('community_model_composition_days')).toEqual([]);
  });
  it('invalidates social deletion even without chunks and removes counters before owner loss',async()=>{
    const owner='synthetic-empty-owner';
    await pool().query(`INSERT INTO ${schema}.participants(id,state,owner_kind) VALUES($1,'active','social')`,[owner]);
    await pool().query(`INSERT INTO ${schema}.prepared_source_days VALUES($1,'2026-09-01','complete',2,3,4)`,[owner]);
    await preview();
    await pool().query(`INSERT INTO ${schema}.community_model_composition_days VALUES('2026-09-01','{}',clock_timestamp(),'synthetic')`);
    await pool().query(`DELETE FROM ${schema}.participants WHERE id=$1`,[owner]);
    expect((await rows('preparation_counters'))[0]).toMatchObject({is_exact:true,tracked_days:'0',checkpoint_steps:'0',quota_observations:'0',usage_events:'0'});
    expect((await rows('mutation_control'))[0]).toMatchObject({mutation_epoch:'1',graph_invalidation_epoch:'1'});
    expect(await rows('preview_cache')).toEqual([]);
    expect(await rows('community_model_composition_days')).toEqual([]);
  });
  it('invalidates the persisted prepared-source day when observed timestamps differ',async()=>{
    const value=await grant(await input());await store().insert(value);
    await pool().query(`UPDATE ${schema}.records SET observed_day='2026-08-31' WHERE participant_id=$1`,[pid]);
    await pool().query(`INSERT INTO ${schema}.prepared_source_days VALUES($1,'2026-08-31','complete',1,0,0)`,[pid]);
    await pool().query(`DELETE FROM ${schema}.records WHERE participant_id=$1`,[pid]);
    expect((await rows('prepared_source_days'))[0]).toMatchObject({source_day:'2026-08-31',phase:'discarding',progress_revision:'2'});
  });

}
