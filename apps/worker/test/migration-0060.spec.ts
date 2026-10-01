import { env, applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
const db = () => env.USAGE_MONITOR_DB;
const migrations = () => (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const run = (sql: string, ...args: (string | number | null)[]) => db().prepare(sql).bind(...args).run();
const rows = async (sql: string) => (await db().prepare(sql).all()).results;
const at = "2025-01-01T00:00:00.000Z", expiry = "2025-01-31T00:00:00.000Z", hash = "a".repeat(64);
const device = "00000000-0000-4000-8000-000000000001", generation = "00000000-0000-4000-8000-000000000002", manifest = "00000000-0000-4000-8000-000000000003", chunk = "chunk:00000000-0000-4000-8000-000000000004";
beforeEach(async () => { await reset(); await applyD1Migrations(db(), migrations().filter(m => m.name < "0060")); });
const migrate = () => applyD1Migrations(db(), migrations().filter(m => m.name < "0061"));

// Reconstruct accepted historical rows whose upload lease has since expired.
// Only fixture construction suspends current-time admission triggers. Restore
// every historical trigger before applying 0060 and exercising new behavior.
async function seed(head = true, foreignDomain = false) {
  const triggers = await db().prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all<{ name: string; sql: string }>();
  for (const t of triggers.results) await run(`DROP TRIGGER "${t.name}"`);
  try {
    await run("INSERT INTO participants(id,owner_kind,created_at) VALUES ('installation','accountless',?)", at);
    await run("INSERT INTO participants(id,owner_kind,access_token_id,access_token_hash,recovery_token_id,recovery_token_hash,consent_version,consented_at,created_at) VALUES ('social','social','access',zeroblob(32),'recovery',zeroblob(32),'v1',?,?)", at, at);
    await run(`INSERT INTO accountless_enrollment_ledger(device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,authorization_basis,issued_at,expires_at)
      VALUES (?,zeroblob(32),'synthetic-installation','accountless-enrollment-v0.1','accountless-opt-out-v1','accountless-policy-v1',?,?)`, device, at, expiry);
    await run(`INSERT INTO device_credentials(id,participant_id,authority_kind,accountless_enrollment_device_id,secret_hash,issued_at,expires_at,last_used_at)
      VALUES (?,'installation','accountless',?,zeroblob(32),?,?,?)`, device, device, at, expiry, at);
    await run(`INSERT INTO accountless_upload_owners(enrollment_device_id,participant_id,device_credential_id,policy_version,authorization_basis,authorized_at,expires_at)
      VALUES (?,'installation',?,'accountless-opt-out-v1','accountless-policy-v1',?,?)`, device, device, at, expiry);
    await run(`INSERT INTO accountless_v11_device_authorizations(enrollment_device_id,participant_id,device_credential_id,telemetry_schema_version,field_dictionary_version,privacy_contract_version,authorized_at,expires_at)
      VALUES (?,'installation',?,'telemetry-contribution-v1.1','telemetry-v1.1-registry-2026-08-31.1','ongoing-privacy-safe-telemetry-v1.1',?,?)`, device, device, at, expiry);
    await run("INSERT INTO community_analytical_input_versions(participant_id,revision) VALUES ('installation',1)");
    await run(`INSERT INTO telemetry_v11_domain_predecessors(token_hash,participant_id,device_id,legacy_fingerprint,input_revision,from_day,through_day,winners_json,created_at,expires_at)
      VALUES (?,'installation',?,?,1,'2024-06-01','2024-06-01','[]',?,?)`, hash, device, hash, at, expiry);
    await run(`INSERT INTO telemetry_v11_domains(id,participant_id,device_id,predecessor_token_hash,manifest_digest,legacy_fingerprint,input_revision,from_day,through_day,days_json,created_at)
      VALUES (?,?,?,?,?,?,1,'2024-06-01','2024-06-01','[]',?)`, generation, foreignDomain ? 'social' : 'installation', device, hash, hash, hash, at);
    await run(`INSERT INTO telemetry_v11_day_manifests(id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,expected_chunk_count,state,created_at,ready_at)
      VALUES (?,'installation',?,'2024-06-01',?,'synthetic-v1','{}',1,'ready',?,?)`, manifest, device, hash, at, at);
    await run("INSERT INTO telemetry_v11_domain_days VALUES (?,'2024-06-01',?)", generation, manifest);
    await run(`INSERT INTO device_upload_authorizations(id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,content_type,state,issued_at,expires_at)
      VALUES ('upload','installation',?,zeroblob(32),?,1,'application/json','consumed',?,?)`, device, hash, at, expiry);
    await run(`INSERT INTO telemetry_v11_chunks(id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,envelope_digest,parser_version,record_count,r2_key,device_upload_authorization_id,created_at)
      VALUES (?,?,'installation',?,'usage','2024-06-01',0,'synthetic-chunk',?,?,'synthetic-v1',1,'synthetic/path','upload',?)`, chunk, manifest, device, hash, hash, at);
    await run(`INSERT INTO telemetry_v11_records(chunk_id,manifest_id,stream,occurrence_id,observed_at,record_json)
      VALUES (?,?,'usage','synthetic-occurrence',?,'{"synthetic":true,"count":7}')`, chunk, manifest, at);
    if (head) await run("INSERT INTO telemetry_v11_domain_heads VALUES ('installation',?,1,?)", generation, at);
    for (const [index, phase] of ["quota", "usage", "complete", "discarding"].entries()) {
      await run(`INSERT INTO community_prepared_source_days VALUES
        ('installation',?,?,?,?,?,?,?, '',0,2,3,0,0,0,'{}',?)`,
        `2024-06-0${index+1}`, hash, hash, "synthetic-v1", device, phase, index+4, hash);
    }
    await run(`INSERT INTO community_prepared_source_days VALUES
      ('social','2024-06-01',?,?,'synthetic-v1','social-device','complete',11,'',0,13,17,0,0,0,'{}',?)`, hash, hash, hash);
  } finally { for (const t of triggers.results) await run(t.sql); }
}
const tables = ["participants", "device_credentials", "accountless_enrollment_ledger", "accountless_upload_owners", "accountless_v11_device_authorizations", "telemetry_v11_domains", "telemetry_v11_domain_heads", "telemetry_v11_domain_days", "telemetry_v11_day_manifests", "telemetry_v11_chunks", "telemetry_v11_records", "device_upload_authorizations"];
const snapshot = async () => Object.fromEntries(await Promise.all([...tables, "community_prepared_source_days"].map(async name =>
  [name, await rows(`SELECT * FROM ${name} ORDER BY ${name === "community_prepared_source_days" ? "participant_id,source_day" : "rowid"}`)])));
const counters = () => rows("SELECT is_exact,tracked_days,complete_days,building_days,retiring_days,checkpoint_steps,quota_observations,usage_events FROM community_preparation_progress_counters");
const allCounters = { is_exact: 1, tracked_days: 5, complete_days: 2, building_days: 2, retiring_days: 1, checkpoint_steps: 33, quota_observations: 21, usage_events: 29 };
const socialCounters = { is_exact: 1, tracked_days: 1, complete_days: 1, building_days: 0, retiring_days: 0, checkpoint_steps: 11, quota_observations: 13, usage_events: 17 };
async function published() {
  const c = await db().prepare("SELECT mutation_epoch,graph_invalidation_epoch FROM community_snapshot_mutation_control").first<{ mutation_epoch: number; graph_invalidation_epoch: number }>();
  await run(`INSERT OR REPLACE INTO community_publication_generation VALUES (1,'00000000-0000-4000-8000-000000000009','2025-01-01','2024-06-01','synthetic-v1',?,?,0,1,1,1,'ready',1,1,1,1,0,?)`, c!.mutation_epoch, c!.graph_invalidation_epoch, at);
  await run("INSERT INTO community_daily_aggregates VALUES ('daily','2024-06-01',1,?,'synthetic-v1','{}',?,'published',?,NULL)", c!.mutation_epoch, hash, at);
  await run("DELETE FROM community_daily_aggregate_rebuilds");
  return c!.graph_invalidation_epoch;
}

describe("migration 0060 durable public contribution sources", () => {
  it("preserves retained rows and admits expired nonrevoked exact accountless input", async () => {
    await seed(); const before = await snapshot(); await migrate();
    expect(await snapshot()).toEqual(before);
    expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
    expect(await rows("SELECT * FROM community_public_source_owners ORDER BY participant_id")).toEqual([
      { participant_id: "installation", owner_kind: "accountless", device_id: device },
      { participant_id: "social", owner_kind: "social", device_id: null },
    ]);
    expect(await rows("SELECT * FROM participant_community_eligibility")).toEqual([]);
    expect(await rows("SELECT * FROM telemetry_v11_device_consents")).toEqual([]);
    expect(await rows("SELECT completed,participant_cursor,source_day_cursor FROM community_public_source_bootstrap")).toEqual([{ completed: 0, participant_cursor: "", source_day_cursor: "" }]);
    expect(await counters()).toEqual([allCounters]);
  });
  it("does not admit enrollment without a current device-bound head", async () => {
    await seed(false); await migrate();
    expect(await rows("SELECT participant_id FROM community_public_source_owners")).toEqual([{ participant_id: "social" }]);
    expect(await rows("SELECT completed FROM community_public_source_bootstrap")).toEqual([{ completed: 1 }]);
  });
  it("excludes a head whose domain belongs to another owner", async () => {
    await seed(true, true); await migrate();
    expect(await rows("SELECT participant_id FROM community_public_source_owners WHERE owner_kind='accountless'")).toEqual([]);
    expect(await rows("SELECT completed FROM community_public_source_bootstrap")).toEqual([{ completed: 1 }]);
  });
  it("does not let an empty enrollment withdraw published community data", async () => {
    await seed(false); await migrate();
    const before = await published();
    await run("UPDATE accountless_enrollment_ledger SET state='revoked',revoked_at=?,revocation_reason='user_opt_out'", at);
    expect(await rows("SELECT graph_invalidation_epoch FROM community_snapshot_mutation_control")).toEqual([{ graph_invalidation_epoch: before }]);
    expect(await rows("SELECT published,phase FROM community_publication_generation")).toEqual([{ published: 1, phase: "ready" }]);
    expect(await rows("SELECT release_state FROM community_daily_aggregates")).toEqual([{ release_state: "published" }]);
    expect(await rows("SELECT * FROM community_daily_aggregate_rebuilds")).toEqual([]);
  });
  it("excludes unreviewed policy and revoked device authority", async () => {
    await seed(); await run("UPDATE accountless_enrollment_ledger SET policy_version='unreviewed-policy'"); await migrate();
    expect(await rows("SELECT participant_id FROM community_public_source_owners WHERE owner_kind='accountless'")).toEqual([]);
    await run("UPDATE accountless_enrollment_ledger SET policy_version='accountless-opt-out-v1'");
    expect(await rows("SELECT participant_id FROM community_public_source_owners WHERE owner_kind='accountless'")).toHaveLength(1);
    await run("UPDATE device_credentials SET state='revoked',revoked_at=? WHERE id=?", at, device);
    expect(await rows("SELECT participant_id FROM community_public_source_owners WHERE owner_kind='accountless'")).toEqual([]);
  });
  it.each(["ledger", "owner", "grant", "device"])("withdraws daily and captured figures atomically on %s withdrawal", async authority => {
    await seed(); await migrate(); const epoch = await published();
    await run("INSERT INTO community_current_analysis_queue(participant_id,dirty_generation,window_generation,pending,last_served_sequence) VALUES ('installation',1,0,1,0)");
    const before = await rows("SELECT * FROM telemetry_v11_records");
    expect(await counters()).toEqual([allCounters]);
    if (authority === "ledger") await run("UPDATE accountless_enrollment_ledger SET state='revoked',revoked_at=?,revocation_reason='user_opt_out'", at);
    if (authority === "owner") await run("DELETE FROM accountless_upload_owners");
    if (authority === "grant") await run("DELETE FROM accountless_v11_device_authorizations");
    if (authority === "device") await run("UPDATE device_credentials SET state='revoked',revoked_at=?", at);
    expect(await rows("SELECT participant_id FROM community_public_source_owners WHERE owner_kind='accountless'")).toEqual([]);
    expect(await rows("SELECT * FROM community_current_analysis_queue")).toEqual([]);
    expect(await rows("SELECT state FROM participants WHERE id='installation'")).toEqual([{ state: "active" }]);
    expect(await rows("SELECT published,phase FROM community_publication_generation")).toEqual([{ published: 0, phase: "retiring" }]);
    expect(await rows("SELECT release_state FROM community_daily_aggregates")).toEqual([{ release_state: "withdrawn" }]);
    expect(await rows("SELECT day FROM community_daily_aggregate_rebuilds")).toEqual([{ day: "2024-06-01" }]);
    const control = await db().prepare("SELECT graph_invalidation_epoch FROM community_snapshot_mutation_control").first<{ graph_invalidation_epoch: number }>();
    expect(control!.graph_invalidation_epoch).toBeGreaterThan(epoch);
    expect(await rows("SELECT * FROM telemetry_v11_records")).toEqual(before);
    expect(await counters()).toEqual([socialCounters]);
  });
  it("subtracts OLD prepared metadata once across ledger, owner, grant and device revocations", async () => {
    await seed(); await migrate();
    const before = await rows("SELECT * FROM community_prepared_source_days ORDER BY participant_id,source_day");
    await run("UPDATE accountless_enrollment_ledger SET state='revoked',revoked_at=?,revocation_reason='user_opt_out'", at);
    expect(await counters()).toEqual([socialCounters]);
    for (const table of ["accountless_upload_owners", "accountless_v11_device_authorizations"]) {
      await run(`UPDATE ${table} SET state='revoked',revoked_at=?,revocation_reason='user_opt_out'`, at);
      expect(await counters()).toEqual([socialCounters]);
    }
    await run("UPDATE device_credentials SET state='revoked',revoked_at=?", at);
    expect(await counters()).toEqual([socialCounters]);
    expect(await rows("SELECT * FROM community_prepared_source_days ORDER BY participant_id,source_day")).toEqual(before);
    // Later retirement is not a second subtraction of the withdrawn source.
    await run("DELETE FROM community_prepared_source_days WHERE participant_id='installation'");
    expect(await counters()).toEqual([socialCounters]);
    await run("UPDATE community_prepared_source_days SET progress_revision=12 WHERE participant_id='social'");
    expect(await counters()).toEqual([{ ...socialCounters, checkpoint_steps: 12 }]);
  });
  it("rolls back withdrawal and counter subtraction with the enclosing D1 batch", async () => {
    await seed(); await migrate(); await published();
    await expect(db().batch([
      db().prepare("UPDATE accountless_enrollment_ledger SET state='revoked',revoked_at=?,revocation_reason='user_opt_out'").bind(at),
      db().prepare("UPDATE community_preparation_progress_counters SET tracked_days=-1"),
    ])).rejects.toThrow();
    expect(await counters()).toEqual([allCounters]);
    expect(await rows("SELECT state FROM accountless_enrollment_ledger")).toEqual([{ state: "active" }]);
    expect(await rows("SELECT published,phase FROM community_publication_generation")).toEqual([{ published: 1, phase: "ready" }]);
    expect(await rows("SELECT release_state FROM community_daily_aggregates")).toEqual([{ release_state: "published" }]);
  });
  it("marks unsafe metadata totals unknown without rewriting retained rows", async () => {
    await seed();
    await run("UPDATE community_prepared_source_days SET quota_count=4503599627370496 WHERE participant_id='installation'");
    const before = await snapshot(); await migrate();
    expect(await snapshot()).toEqual(before);
    expect(await rows("SELECT is_exact FROM community_preparation_progress_counters")).toEqual([{ is_exact: 0 }]);
  });
  it("uses only metadata for recount/subtraction and keeps the owner read indexed", async () => {
    const migration = migrations().find(m => m.name.startsWith("0060"))!;
    const sql = migration.queries.join("\n");
    expect(sql).not.toMatch(/\b(?:DROP TABLE|ALTER TABLE|json_each|json_extract)\b/i);
    expect(sql).not.toMatch(/(?:FROM|JOIN)\s+(?:telemetry_v11_records|telemetry_v11_chunks|telemetry_records)\b/i);
    const plan = await db().prepare("EXPLAIN QUERY PLAN SELECT COUNT(*),TOTAL(progress_revision),TOTAL(quota_count),TOTAL(usage_count) FROM community_prepared_source_days WHERE participant_id=?").bind("installation").all<{ detail: string }>();
    expect(plan.results.some(row => /SEARCH community_prepared_source_days USING PRIMARY KEY/.test(row.detail))).toBe(true);
  });
  it("queues retained-source cache changes without weakening legacy admission", async () => {
    await seed(); await migrate();
    await run("INSERT INTO community_allowance_fit_cache(participant_id,cache_key,fits_json,computed_at) VALUES ('installation','synthetic','[]',?)", at);
    expect(await rows("SELECT participant_id,pending FROM community_current_analysis_queue")).toEqual([{ participant_id: "installation", pending: 1 }]);
    await expect(run("INSERT INTO participant_community_eligibility(id,participant_id,grant_id,created_at) VALUES ('synthetic-eligibility','installation','synthetic-grant',?)", at)).rejects.toThrow("grant unavailable");
    const guard = await db().prepare("SELECT sql FROM sqlite_master WHERE name='telemetry_v1_chunks_require_social_owner'").first<{ sql: string }>();
    expect(guard!.sql).toContain("owner_kind = 'social'");
  });
});
