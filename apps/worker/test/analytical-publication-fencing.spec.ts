import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { COMMUNITY_ATTRIBUTION_METHOD_VERSION, COMMUNITY_ALLOWANCE_BASIS,
  COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS, selectCommunityAllowanceAnalysisFits } from "../src/community-allowance";
import { warmAdminCommunityAllowancePreviewCache, buildCommunityModelCompositionDay,
  readCachedAdminCommunityAllowancePreview } from "../src/admin-community-allowance";
import { loadV1SourcePin, assertV1SourcePinCurrent } from "../src/telemetry-v1-source-selection";
import { V1_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "../src/quota-analysis-v1";
import { V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "../src/quota-analysis-v11";
import { V11_DOMAIN_METHOD_VERSION } from "../src/telemetry-v11-domain";
import { captureAdminMetricSnapshot } from "../src/admin-metrics-history";
import { sha256Hex } from "../src/crypto";

interface TestBindings extends Env { TEST_MIGRATIONS: D1Migration[]; }
const database = () => (env as TestBindings).USAGE_MONITOR_DB;
const NOW = "2026-08-30T12:00:00.000Z";
const FUTURE = "2027-01-01T00:00:00.000Z";
const hash = (byte: number) => new Uint8Array(32).fill(byte);

beforeEach(async () => {
  await reset();
  await applyD1Migrations(database(), (env as TestBindings).TEST_MIGRATIONS);
});

async function seedCurrentChunk(): Promise<void> {
  const db = database();
  await db.batch([
    db.prepare(`INSERT INTO participants (id,access_token_id,access_token_hash,recovery_token_id,
      recovery_token_hash,state,consent_version,consented_at,created_at)
      VALUES ('fence-participant','fence-access',?,'fence-recovery',?,'active','privacy-safe-telemetry-v0.1',?,?)`)
      .bind(hash(1),hash(2),NOW,NOW),
    db.prepare(`INSERT INTO web_sessions (id,participant_id,secret_hash,csrf_hash,scope,state,issued_at,expires_at,last_used_at)
      VALUES ('fence-session','fence-participant',?,?,'personal','active',?,?,?)`).bind(hash(3),hash(4),NOW,FUTURE,NOW),
    db.prepare(`INSERT INTO device_pairings (id,participant_id,issued_by_session_id,secret_hash,consent_version,
      transport_consent_version,state,issued_at,expires_at)
      VALUES ('fence-pairing','fence-participant','fence-session',?,'ongoing-privacy-safe-telemetry-v1.0',
      'ongoing-privacy-safe-telemetry-v1.0','unused',?,?)`).bind(hash(5),NOW,FUTURE),
    db.prepare(`INSERT INTO device_credentials (id,participant_id,paired_via_pairing_id,secret_hash,state,
      issued_at,expires_at,last_used_at) VALUES ('fence-device','fence-participant','fence-pairing',?,'active',?,?,?)`)
      .bind(hash(6),NOW,FUTURE,NOW),
    db.prepare(`INSERT INTO device_upload_authorizations (id,participant_id,issued_by_device_id,secret_hash,
      envelope_digest,body_bytes,content_type,state,issued_at,expires_at,consume_lease_expires_at)
      VALUES ('fence-auth','fence-participant','fence-device',?,?,1024,'application/json','consuming',?,?,?)`)
      .bind(hash(7),"a".repeat(64),NOW,FUTURE,FUTURE),
    db.prepare(`INSERT INTO telemetry_v1_chunks (id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
      chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at)
      VALUES ('fence-chunk','fence-participant','fence-device','usage','2026-08-30',0,1,?,?,'synthetic-v1',1,1,
      'synthetic/fence-chunk','fence-auth',?)`).bind("b".repeat(64),"a".repeat(64),NOW),
  ]);
}

describe("analytical input and publication fencing", () => {
  it("method-fences cached scalar and composition output with every active source adapter", () => {
    for (const version of [V1_PLAN_ATTRIBUTION_ADAPTER_VERSION,V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,V11_DOMAIN_METHOD_VERSION])
      expect(COMMUNITY_ATTRIBUTION_METHOD_VERSION).toContain(version);
  });
  it("invalidates a digest-only correction that aliases the old count/max/sum cache key", async () => {
    await seedCurrentChunk();
    const db = database();
    const pin = await loadV1SourcePin(db, { participantId: "fence-participant" });
    const oldCheapKey = await db.prepare(`SELECT COUNT(*) AS n,MAX(created_at) AS newest,SUM(revision) AS revsum
      FROM telemetry_v1_chunks WHERE superseded_at IS NULL`).first();
    await db.prepare("UPDATE telemetry_v1_chunks SET chunk_digest = ? WHERE id = 'fence-chunk'")
      .bind("c".repeat(64)).run();
    expect(await db.prepare(`SELECT COUNT(*) AS n,MAX(created_at) AS newest,SUM(revision) AS revsum
      FROM telemetry_v1_chunks WHERE superseded_at IS NULL`).first()).toEqual(oldCheapKey);
    const changed = await loadV1SourcePin(db, { participantId: "fence-participant" });
    expect(changed.inputRevision).toBe(pin.inputRevision! + 1);
    expect(changed.fingerprint).not.toBe(pin.fingerprint);
    await expect(assertV1SourcePinCurrent(db, pin)).rejects.toThrow("source changed");
  });

  it("input mutations synchronously clear the preview and mark the existing singleton updating", async () => {
    await seedCurrentChunk();
    const db = database();
    await db.prepare(`UPDATE community_allowance_publication_state SET publication_state='ready',
      attribution_method_version=? WHERE singleton=1`).bind(COMMUNITY_ATTRIBUTION_METHOD_VERSION).run();
    await db.prepare(`INSERT INTO admin_community_allowance_preview_cache
      (singleton,generated_at,payload_json,attribution_method_version,source_mutation_epoch) VALUES (1,?,'{}',?,0)`)
      .bind(NOW,COMMUNITY_ATTRIBUTION_METHOD_VERSION).run();
    await db.prepare("UPDATE telemetry_v1_chunks SET superseded_at=? WHERE id='fence-chunk'").bind(NOW).run();
    expect(await db.prepare("SELECT publication_state FROM community_allowance_publication_state WHERE singleton=1").first())
      .toEqual({ publication_state: "updating" });
    expect(await db.prepare("SELECT singleton FROM admin_community_allowance_preview_cache").first()).toBeNull();
  });

  it("another participant's global epoch change does not invalidate an unchanged source fingerprint", async () => {
    await seedCurrentChunk();
    const db = database();
    const pin = await loadV1SourcePin(db, { participantId: "fence-participant" });
    await db.prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
    const current = await loadV1SourcePin(db, { participantId: "fence-participant" });
    expect(current.mutationEpoch).toBe(pin.mutationEpoch + 1);
    expect(current.fingerprint).toBe(pin.fingerprint);
    await expect(assertV1SourcePinCurrent(db, pin)).resolves.toBeUndefined();
  });

  it("a mutation just before preview insertion cannot publish a stale generation", async () => {
    const db = database();
    let interleaved = false;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (property === "run" && sql.includes("INSERT INTO admin_community_allowance_preview_cache")) return async () => {
          interleaved = true;
          await db.prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
          return target.run();
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const interleavingDb = new Proxy(db, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await warmAdminCommunityAllowancePreviewCache(interleavingDb, Date.parse(NOW));
    expect(interleaved).toBe(true);
    expect(result.code).toBe("ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE");
    expect(await db.prepare("SELECT singleton FROM admin_community_allowance_preview_cache").first()).toBeNull();
  });

  it("withdraws historical model-day eligibility before a warm can reimport deleted participant evidence", async () => {
    await seedCurrentChunk(); const db=database();
    const historical=buildCommunityModelCompositionDay({compositions:[],v1ParticipantCount:1,
      unsupportedSourceParticipantCount:0,refusedParticipantCount:1},"2026-08-29");
    await db.prepare(`INSERT INTO community_model_composition_days
      (day,payload_json,computed_at,attribution_method_version,source_mutation_epoch) VALUES (?,?,?,?,0)`)
      .bind(historical.day,JSON.stringify(historical),NOW,COMMUNITY_ATTRIBUTION_METHOD_VERSION).run();
    // An ordinary upload correction preserves the model history.
    await db.prepare("UPDATE telemetry_v1_chunks SET chunk_digest=? WHERE id='fence-chunk'").bind("d".repeat(64)).run();
    expect((await db.prepare("SELECT attribution_method_version FROM community_model_composition_days").first())?.attribution_method_version)
      .toBe(COMMUNITY_ATTRIBUTION_METHOD_VERSION);
    await db.prepare("UPDATE participants SET state='deleting' WHERE id='fence-participant'").run();
    // The retained 0041 withdrawal trigger removes aggregate snapshots whose
    // contributor membership cannot be reconstructed; no new erasure path.
    expect(await db.prepare("SELECT attribution_method_version,payload_json FROM community_model_composition_days").first())
      .toBeNull();
    expect((await warmAdminCommunityAllowancePreviewCache(db,Date.parse(NOW))).code).toBe("ALLOWANCE_PREVIEW_CACHE_REFRESHED");
    const preview=await readCachedAdminCommunityAllowancePreview(db,Date.parse(NOW));
    expect("models" in preview).toBe(true);
    if ("models" in preview) expect(preview.models.days.some(value=>value.day===historical.day)).toBe(false);
  });

  it("operator band gauges share the public method, current-day and updating gates", async () => {
    const db=database(); const day=NOW.slice(0,10);
    const fromDay=new Date(Date.parse(day)-(COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS-1)*86400000).toISOString().slice(0,10);
    const payload=JSON.stringify({allowance:{basis:COMMUNITY_ALLOWANCE_BASIS,fitCount:8,participantCount:3}});
    await db.prepare(`INSERT INTO community_daily_aggregates
      (aggregate_id,day,revision,source_mutation_epoch,policy_version,payload_json,payload_sha256,release_state,released_at)
      VALUES ('synthetic-band',?,1,0,'community-daily-v1.0',?,?,'published',?)`)
      .bind(day,payload,await sha256Hex(payload),NOW).run();
    await db.prepare(`UPDATE community_allowance_publication_state SET publication_state='ready',
      expected_basis=?,attribution_method_version=?,safe_from_day=?,safe_to_day=? WHERE singleton=1`)
      .bind(COMMUNITY_ALLOWANCE_BASIS,COMMUNITY_ATTRIBUTION_METHOD_VERSION,fromDay,day).run();
    const capture=async (hours:number) => {
      const instant=Date.parse(NOW)+hours*3600000;
      expect((await captureAdminMetricSnapshot(db,instant)).code).toBe("SNAPSHOT_CAPTURED");
      const row=await db.prepare("SELECT metrics_json FROM admin_metric_snapshots WHERE captured_at=?")
        .bind(new Date(instant).toISOString()).first<{metrics_json:string}>();
      return JSON.parse(row!.metrics_json) as Record<string,unknown>;
    };
    expect(await capture(0)).toMatchObject({bandFitCount:8,bandParticipantCount:3});
    await db.prepare("UPDATE community_allowance_publication_state SET publication_state='updating' WHERE singleton=1").run();
    expect(await capture(1)).not.toHaveProperty("bandFitCount");
    await db.prepare("UPDATE community_allowance_publication_state SET publication_state='ready',attribution_method_version='old-method' WHERE singleton=1").run();
    expect(await capture(2)).not.toHaveProperty("bandParticipantCount");
    await db.prepare("UPDATE community_allowance_publication_state SET attribution_method_version=? WHERE singleton=1")
      .bind(COMMUNITY_ATTRIBUTION_METHOD_VERSION).run();
    expect(await capture(24)).not.toHaveProperty("bandFitCount");
  });
});

function fragment(overrides: Record<string, unknown> = {}) {
  return { status: "conditional_estimate", limitId: "codex", windowDurationMinutes: 10_080,
    capacityNanousd: 1_000_000_000, displayedSpanPp: 60, boundaryCount: 10,
    firstObservedAt: "2026-08-20T00:00:00.000Z", lastObservedAt: NOW,
    resetsAt: "2026-09-01T00:00:00.000Z", ...overrides };
}
function analysis(era: string, reset: ReturnType<typeof fragment>, plan = "pro") {
  return { status: "ready", tracks: [{ continuity: { provider: "openai_codex", planType: plan,
    planVariant: "unknown", accountTrackId: "synthetic-track", policyEpoch: "synthetic-policy", planEraKey: era },
    calibration: { tracks: [{ resets: [reset] }] } }] };
}

describe("post-fit reset fragment and format arbitration", () => {
  it("a wider invalid fragment cannot suppress a narrower valid return to the same plan", () => {
    const inputs = [
      { source: "v1" as const, analysis: analysis("first",fragment({ displayedSpanPp: 90, status: "not_testable" })) },
      { source: "v1" as const, analysis: analysis("returned",fragment({ displayedSpanPp: 50, capacityNanousd: 2_000 })) },
    ];
    const fits = selectCommunityAllowanceAnalysisFits("synthetic-participant",inputs);
    expect(fits).toHaveLength(1);
    expect(fits[0]?.capacityNanousd).toBe(2_000);
  });
  it("one parent gets one greatest-span qualifying vote, independent of era order", () => {
    const inputs = [
      { source: "v1" as const, analysis: analysis("first",fragment({ displayedSpanPp: 45, capacityNanousd: 1_000 })) },
      { source: "v1" as const, analysis: analysis("returned",fragment({ displayedSpanPp: 65, capacityNanousd: 2_000 })) },
    ];
    expect(selectCommunityAllowanceAnalysisFits("synthetic-participant",inputs))
      .toEqual(selectCommunityAllowanceAnalysisFits("synthetic-participant",inputs.toReversed()));
    expect(selectCommunityAllowanceAnalysisFits("synthetic-participant",inputs).map(row=>row.capacityNanousd)).toEqual([2_000]);
  });
  it("legacy preference is per qualifying reset domain and retains disjoint v1 history", () => {
    const inputs = [
      { source: "v0.2" as const, analysis: analysis("legacy",fragment({ capacityNanousd: 100 })) },
      { source: "v1" as const, analysis: analysis("v1-overlap",fragment({ capacityNanousd: 200 })) },
      { source: "v1" as const, analysis: analysis("v1-disjoint",fragment({ resetsAt: "2026-08-24T00:00:00.000Z",capacityNanousd: 300 })) },
    ];
    expect(selectCommunityAllowanceAnalysisFits("synthetic-participant",inputs).map(row=>row.capacityNanousd).sort()).toEqual([100,300]);
  });
});
