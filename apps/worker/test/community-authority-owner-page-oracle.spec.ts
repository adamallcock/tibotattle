import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { expect, it } from "vitest";
import committedOracle from "../postgres-test/fixtures/community-authority-owner-page-oracle.json";
import { initializeStorageSource } from "../src/analytics-delivery";
import {
  readStorageCommunityOwnerPage,
  V12_RETAINED_AUTHORIZATION_SCOPE,
  type StorageCommunityOwner,
} from "../src/storage-community-authority";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";

/*
 * D1 oracle for the community publication authority's owner reads: the
 * retained v1.2 authorization scope (V12_RETAINED_AUTHORIZATION_SCOPE) and
 * readStorageCommunityOwnerPage, over the full deployed D1 source migration
 * chain. The flow triggers are removed from this disposable database and each
 * synthetic case writes its final authority state directly, as the
 * community_public_source_owners oracle does; table definitions, CHECK
 * constraints and foreign keys stay in force, the v1.2 runtime is active and
 * the usage-correction runtime keeps its staged seed.
 *
 * The committed fixture holds the abstract case inputs and D1's rows. The
 * PostgreSQL spec (postgres-test/postgres-storage-community-authority.spec.mjs)
 * rebuilds the same inputs against staged primary 0053 and must return the
 * same scope rows and owner pages. Every identifier, digest and timestamp is
 * a content-free constant; a lease that must still be current expires in
 * 2099 so the clock never changes a result. A normal run only compares D1's
 * result with the imported fixture; regeneration needs both flags:
 *   VITE_TIBOTATTLE_REGENERATE_COMMUNITY_AUTHORITY_ORACLE=1 \
 *     npx vitest run test/community-authority-owner-page-oracle.spec.ts -u
 */

interface Bindings extends Env {
  STORAGE_ANALYTICS_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
}

type RevocationReason = "user_opt_out" | "security_reset";

interface Lease {
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly state: "active" | "revoked";
  readonly revokedAt: string | null;
  readonly revocationReason: RevocationReason | null;
}

interface OracleAccountless {
  readonly ledger: Lease;
  readonly owner: Lease;
  readonly device: Lease;
  readonly v11Grant: Lease | null;
  readonly v12Grant: Lease | null;
  /** Prospective opt-out retention marker naming this device's v1.2 head. */
  readonly markerRetainedAt: string | null;
}

interface OracleV1Chunk {
  readonly id: string;
  readonly authorizationId: string;
  readonly chunkSeq: number;
  readonly acceptedRecordCount: number;
  readonly superseded: boolean;
}

interface OracleParticipant {
  readonly id: string;
  readonly ownerKind: "social" | "accountless";
  readonly state: "active" | "deleting";
  readonly inputRevision: number;
  readonly deviceId: string;
  readonly secretHash: string;
  /** Active owner link; its digest is a constant. */
  readonly ownerDigest: string | null;
  /**
   * Owner revision head. Active: revision 1 (owner-active) or 2 (then
   * source-updated), epoch 1. Withdrawn: revision 2 and epoch 2 (owner-active
   * then owner-withdrawn), which the owner page reads as no revision.
   */
  readonly ownerRevision: 1 | 2 | null;
  readonly ownerHeadState: "active" | "withdrawn";
  /** One accepted contribution of this transport version, or none. */
  readonly legacyContribution: "v0.1" | "v0.2" | null;
  readonly capability: "accepted" | "revoked" | null;
  readonly accountless: OracleAccountless | null;
  readonly v11GenerationId: string | null;
  readonly v12Domain: {
    readonly generationId: string;
    readonly manifestId: string;
    readonly manifestState: "ready" | "staged";
  } | null;
  readonly v1Chunks: readonly OracleV1Chunk[];
}

interface OracleCase {
  readonly name: string;
  readonly participants: readonly OracleParticipant[];
}

interface ScopeRow {
  readonly participant_id: string;
  readonly device_id: string;
}

const REGENERATE = (import.meta as unknown as { readonly env: Readonly<Record<string, unknown>> }).env
  .VITE_TIBOTATTLE_REGENERATE_COMMUNITY_AUTHORITY_ORACLE === "1";

const b = env as Bindings;
const db = () => b.USAGE_MONITOR_DB;
const SOURCE_ID = "synthetic-community-authority-oracle";
const SOURCE_NAMESPACE = "synthetic-community-authority-oracle-namespace";
const PREFIX = "authority-";
const DAY = "2026-09-20";
const T = Object.freeze({
  issued: "2026-09-01T00:00:00.000Z",
  // Enrollment leases are exactly 30 days (D1 0059 lease shape).
  currentIssued: "2098-12-02T00:00:00.000Z",
  current: "2099-01-01T00:00:00.000Z",
  revokedLease: "2026-10-01T00:00:00.000Z",
  lapsedIssued: "2026-06-01T00:00:00.000Z",
  lapsed: "2026-07-01T00:00:00.000Z",
  retained: "2026-09-20T12:00:00.000Z",
  superseded: "2026-09-21T00:00:00.000Z",
});

function hex64(seed: string): string {
  let value = "";
  for (const character of seed) value += character.charCodeAt(0).toString(16).padStart(2, "0");
  return value.padStart(64, "0").slice(-64);
}
function uuid(prefix: string, caseNumber: number, member: string): string {
  const tail = `${caseNumber.toString(16).padStart(2, "0")}${member.charCodeAt(0).toString(16)}`;
  return `${prefix}-0000-4000-8000-${tail.padStart(12, "0")}`;
}
function lease(state: "current" | "lapsed" | RevocationReason): Lease {
  if (state === "current") {
    return { issuedAt: T.currentIssued, expiresAt: T.current, state: "active", revokedAt: null, revocationReason: null };
  }
  if (state === "lapsed") {
    return { issuedAt: T.lapsedIssued, expiresAt: T.lapsed, state: "active", revokedAt: null, revocationReason: null };
  }
  return { issuedAt: T.issued, expiresAt: T.revokedLease, state: "revoked", revokedAt: T.retained,
    revocationReason: state };
}

function participant(caseNumber: number, member: string, shape: {
  readonly ownerKind?: "social" | "accountless";
  readonly state?: "active" | "deleting";
  readonly linked?: boolean;
  readonly ownerRevision?: 1 | 2 | null;
  readonly ownerHeadState?: "active" | "withdrawn";
  readonly legacyContribution?: "v0.1" | "v0.2" | null;
  readonly capability?: "accepted" | "revoked" | null;
  readonly accountless?: "current" | "lapsed" | RevocationReason;
  readonly v11Grant?: boolean;
  readonly marker?: boolean;
  readonly v11Domain?: boolean;
  readonly v12Domain?: "ready" | "staged" | null;
  readonly v1Chunks?: readonly Pick<OracleV1Chunk, "acceptedRecordCount" | "superseded">[];
}): OracleParticipant {
  const id = `${PREFIX}${caseNumber.toString().padStart(2, "0")}${member}`;
  const ownerKind = shape.ownerKind ?? "social";
  const linked = shape.linked ?? true;
  const accountlessLease = shape.accountless === undefined ? null : lease(shape.accountless);
  const v12Grant = accountlessLease !== null && shape.v11Grant !== true;
  return {
    id,
    ownerKind,
    state: shape.state ?? "active",
    inputRevision: caseNumber,
    deviceId: uuid("0d000000", caseNumber, member),
    secretHash: hex64(`authority-secret-${caseNumber}-${member}`),
    ownerDigest: linked ? hex64(`authority-owner-${caseNumber}-${member}`) : null,
    ownerRevision: linked ? (shape.ownerRevision === undefined ? 1 : shape.ownerRevision) : null,
    ownerHeadState: shape.ownerHeadState ?? "active",
    legacyContribution: shape.legacyContribution ?? null,
    capability: shape.capability ?? null,
    accountless: accountlessLease === null ? null : {
      ledger: accountlessLease,
      owner: accountlessLease,
      device: accountlessLease,
      v11Grant: shape.v11Grant === true ? accountlessLease : null,
      v12Grant: v12Grant ? accountlessLease : null,
      markerRetainedAt: shape.marker === true ? T.retained : null,
    },
    v11GenerationId: shape.v11Domain === true ? uuid("0a110000", caseNumber, member) : null,
    v12Domain: shape.v12Domain === undefined || shape.v12Domain === null ? null : {
      generationId: uuid("0a120000", caseNumber, member),
      manifestId: uuid("0e120000", caseNumber, member),
      manifestState: shape.v12Domain,
    },
    v1Chunks: (shape.v1Chunks ?? []).map((chunk, index) => ({
      id: `authority-chunk-${caseNumber}-${member}-${index}`,
      authorizationId: uuid("0b100000", caseNumber * 16 + index, member),
      chunkSeq: index,
      ...chunk,
    })),
  };
}

const CASES: readonly OracleCase[] = [
  { name: "social-v12-accepted-linked", participants: [participant(1, "a", { capability: "accepted", v12Domain: "ready" })] },
  { name: "social-v12-revoked-linked", participants: [participant(2, "a", { capability: "revoked", v12Domain: "ready" })] },
  {
    // Only the active-authorization branch, which has no owner-link join,
    // admits this device.
    name: "social-v12-accepted-unlinked",
    participants: [participant(3, "a", { linked: false, capability: "accepted", v12Domain: "ready" })],
  },
  {
    name: "social-v12-revoked-unlinked",
    participants: [participant(4, "a", { linked: false, capability: "revoked", v12Domain: "ready" })],
  },
  { name: "social-v12-staged-manifest", participants: [participant(5, "a", { capability: "accepted", v12Domain: "staged" })] },
  {
    name: "social-v1-and-v11",
    participants: [participant(6, "a", { ownerRevision: 2, v11Domain: true,
      v1Chunks: [{ acceptedRecordCount: 1, superseded: false }, { acceptedRecordCount: 1, superseded: true }] })],
  },
  {
    name: "social-v1-unaccepted-and-superseded",
    participants: [participant(7, "a", { linked: false,
      v1Chunks: [{ acceptedRecordCount: 0, superseded: false }, { acceptedRecordCount: 1, superseded: true }] })],
  },
  {
    name: "social-deleting",
    participants: [participant(8, "a", { state: "deleting", capability: "accepted", v12Domain: "ready" })],
  },
  {
    name: "accountless-v12-exact",
    participants: [participant(9, "a", { ownerKind: "accountless", accountless: "current", v12Domain: "ready" })],
  },
  {
    name: "accountless-v12-expired",
    participants: [participant(10, "a", { ownerKind: "accountless", accountless: "lapsed", v12Domain: "ready" })],
  },
  {
    name: "accountless-v12-expired-unlinked",
    participants: [participant(11, "a", { ownerKind: "accountless", accountless: "lapsed", linked: false,
      v12Domain: "ready" })],
  },
  {
    name: "accountless-v12-opt-out-retained",
    participants: [participant(12, "a", { ownerKind: "accountless", accountless: "user_opt_out", marker: true,
      v12Domain: "ready" })],
  },
  {
    name: "accountless-v12-security-reset",
    participants: [participant(13, "a", { ownerKind: "accountless", accountless: "security_reset", v12Domain: "ready" })],
  },
  {
    name: "accountless-v11-exact",
    participants: [participant(14, "a", { ownerKind: "accountless", accountless: "current", v11Grant: true,
      v11Domain: true })],
  },
  {
    // A withdrawn owner revision head is not an active owner revision.
    name: "social-owner-head-withdrawn",
    participants: [participant(15, "a", { ownerRevision: 2, ownerHeadState: "withdrawn" })],
  },
  {
    // Only an accepted v0.2 contribution is legacy evidence.
    name: "social-legacy-contributions",
    participants: [participant(16, "a", { legacyContribution: "v0.2" }), participant(16, "b", { legacyContribution: "v0.1" })],
  },
];

async function migrate(): Promise<void> {
  await reset();
  await applyD1Migrations(db(), b.TEST_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(b.STORAGE_ANALYTICS_DB, b.TEST_ANALYTICS_MIGRATIONS);
  await applyD1Migrations(b.DELETION_LEDGER, b.TEST_DELETION_LEDGER_MIGRATIONS);
  await initializeStorageSource(db(), SOURCE_ID);
  await applyD1Migrations(db(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await initializeTypedV11Admission(db(), SOURCE_NAMESPACE);
  await initializeTypedV1Admission(db(), SOURCE_NAMESPACE);
  await applyD1Migrations(db(), b.TEST_INGESTION_ISOLATION_MIGRATIONS);
}

async function removeFlowTriggers(): Promise<void> {
  const triggers = await db().prepare("SELECT name FROM sqlite_schema WHERE type='trigger' ORDER BY name")
    .all<{ name: string }>();
  for (const { name } of triggers.results) {
    expect(name).toMatch(/^[a-z0-9_]+$/u);
    await db().prepare(`DROP TRIGGER "${name}"`).run();
  }
}

function blob(hex: string): Uint8Array {
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

async function insertParticipant(owner: OracleParticipant): Promise<void> {
  const run = (sql: string, ...values: unknown[]) => db().prepare(sql).bind(...values).run();
  await run("INSERT INTO participants(id,owner_kind,state,created_at) VALUES(?,?,?,?)",
    owner.id, owner.ownerKind, owner.state, T.issued);
  await run("INSERT OR REPLACE INTO community_analytical_input_versions(participant_id,revision) VALUES(?,?)",
    owner.id, owner.inputRevision);
  const graph = owner.accountless;
  if (graph === null) {
    await run(`INSERT INTO device_credentials(id,participant_id,authority_kind,secret_hash,state,issued_at,expires_at,
        last_used_at,social_verified_at) VALUES(?,?,'social',?,'active',?,?,?,?)`,
    owner.deviceId, owner.id, blob(owner.secretHash), T.issued, T.current, T.issued, T.issued);
  } else {
    const { ledger, device } = graph;
    await run(`INSERT INTO accountless_enrollment_ledger(device_id,device_secret_hash,installation_principal_id,
        schema_version,policy_version,authorization_basis,state,issued_at,expires_at,revoked_at,revocation_reason,
        renewal_generation,renewed_at)
      VALUES(?,?,?,'accountless-enrollment-v0.1','accountless-opt-out-v1','accountless-policy-v1',?,?,?,?,?,0,NULL)`,
    owner.deviceId, blob(owner.secretHash), `authority-installation-${owner.deviceId}`, ledger.state, ledger.issuedAt,
    ledger.expiresAt, ledger.revokedAt, ledger.revocationReason);
    await run(`INSERT INTO device_credentials(id,participant_id,authority_kind,accountless_enrollment_device_id,
        secret_hash,state,issued_at,expires_at,last_used_at,revoked_at,social_verified_at)
      VALUES(?,?,'accountless',?,?,?,?,?,?,?,NULL)`,
    owner.deviceId, owner.id, owner.deviceId, blob(owner.secretHash), device.state, device.issuedAt,
    device.expiresAt, device.issuedAt, device.revokedAt);
    await run(`INSERT INTO accountless_upload_owners(enrollment_device_id,participant_id,device_credential_id,
        policy_version,authorization_basis,authorized_at,expires_at,state,revoked_at,revocation_reason)
      VALUES(?,?,?,'accountless-opt-out-v1','accountless-policy-v1',?,?,?,?,?)`,
    owner.deviceId, owner.id, owner.deviceId, graph.owner.issuedAt, graph.owner.expiresAt, graph.owner.state,
    graph.owner.revokedAt, graph.owner.revocationReason);
    if (graph.v11Grant) {
      const grant = graph.v11Grant;
      await run(`INSERT INTO accountless_v11_device_authorizations(enrollment_device_id,participant_id,
          device_credential_id,telemetry_schema_version,field_dictionary_version,privacy_contract_version,
          authorized_at,expires_at,state,revoked_at,revocation_reason)
        VALUES(?,?,?,'telemetry-contribution-v1.1','telemetry-v1.1-registry-2026-08-31.1',
          'ongoing-privacy-safe-telemetry-v1.1',?,?,?,?,?)`,
      owner.deviceId, owner.id, owner.deviceId, grant.issuedAt, grant.expiresAt, grant.state, grant.revokedAt,
      grant.revocationReason);
    }
    if (graph.v12Grant) {
      const grant = graph.v12Grant;
      await run(`INSERT INTO accountless_v12_device_authorizations(enrollment_device_id,participant_id,
          device_credential_id,schema_version,policy_version,authorization_basis,telemetry_schema_version,
          field_dictionary_version,privacy_contract_version,authorized_at,expires_at,state,revoked_at,revocation_reason)
        VALUES(?,?,?,'accountless-upload-owner-v1.2','accountless-telemetry-v1.2-policy-v1','accountless-policy-v1.2',
          'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1','ongoing-privacy-safe-telemetry-v1.2',
          ?,?,?,?,?)`,
      owner.deviceId, owner.id, owner.deviceId, grant.issuedAt, grant.expiresAt, grant.state, grant.revokedAt,
      grant.revocationReason);
    }
  }
  if (owner.capability !== null) {
    await run(`INSERT INTO telemetry_v12_device_capabilities(participant_id,device_id,telemetry_schema_version,
        field_dictionary_version,privacy_contract_version,state,consented_at,revoked_at)
      VALUES(?,?,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
        'ongoing-privacy-safe-telemetry-v1.2',?,?,?)`,
    owner.id, owner.deviceId, owner.capability, T.issued, owner.capability === "revoked" ? T.retained : null);
  }
  if (owner.v11GenerationId !== null) {
    const token = hex64(`token-v11-${owner.v11GenerationId}`);
    const fingerprint = hex64(`legacy-v11-${owner.v11GenerationId}`);
    await run(`INSERT INTO telemetry_v11_domain_predecessors(token_hash,participant_id,device_id,previous_generation_id,
        legacy_fingerprint,input_revision,from_day,through_day,winners_json,created_at,expires_at)
      VALUES(?,?,?,NULL,?,0,?,?,'[]',?,?)`, token, owner.id, owner.deviceId, fingerprint, DAY, DAY, T.issued, T.current);
    await run(`INSERT INTO telemetry_v11_domains(id,participant_id,device_id,predecessor_token_hash,previous_generation_id,
        manifest_digest,legacy_fingerprint,input_revision,from_day,through_day,days_json,created_at)
      VALUES(?,?,?,?,NULL,?,?,0,?,?,'[]',?)`, owner.v11GenerationId, owner.id, owner.deviceId, token,
    hex64(`manifest-v11-${owner.v11GenerationId}`), fingerprint, DAY, DAY, T.issued);
    await run("INSERT INTO telemetry_v11_domain_heads(participant_id,generation_id,revision,updated_at) VALUES(?,?,1,?)",
      owner.id, owner.v11GenerationId, T.issued);
  }
  if (owner.v12Domain !== null) {
    const domain = owner.v12Domain;
    const token = hex64(`token-v12-${domain.generationId}`);
    const fingerprint = hex64(`legacy-v12-${domain.generationId}`);
    const dayDigest = hex64(`day-v12-${domain.manifestId}`);
    await run(`INSERT INTO telemetry_v12_domain_predecessors(token_hash,participant_id,device_id,previous_generation_id,
        legacy_fingerprint,input_revision,from_day,through_day,days_json,created_at,expires_at)
      VALUES(?,?,?,NULL,?,0,?,?,'[]',?,?)`, token, owner.id, owner.deviceId, fingerprint, DAY, DAY, T.issued, T.current);
    await run(`INSERT INTO telemetry_v12_day_manifests(id,participant_id,device_id,chunk_day,manifest_digest,parser_version,
        manifest_json,expected_chunk_count,state,created_at,ready_at)
      VALUES(?,?,?,?,?,'synthetic-v12',?,0,?,?,?)`, domain.manifestId, owner.id, owner.deviceId, DAY, dayDigest,
    JSON.stringify({ day: DAY, chunks: [] }), domain.manifestState, T.issued,
    domain.manifestState === "ready" ? T.issued : null);
    await run(`INSERT INTO telemetry_v12_domains(id,participant_id,device_id,predecessor_token_hash,previous_generation_id,
        manifest_digest,legacy_fingerprint,input_revision,from_day,through_day,days_json,created_at)
      VALUES(?,?,?,?,NULL,?,?,0,?,?,'[]',?)`, domain.generationId, owner.id, owner.deviceId, token,
    hex64(`manifest-v12-${domain.generationId}`), fingerprint, DAY, DAY, T.issued);
    await run("INSERT INTO telemetry_v12_domain_days(generation_id,observed_day,manifest_id,manifest_digest) VALUES(?,?,?,?)",
      domain.generationId, DAY, domain.manifestId, dayDigest);
    await run("INSERT INTO telemetry_v12_domain_heads(participant_id,generation_id,revision,updated_at) VALUES(?,?,1,?)",
      owner.id, domain.generationId, T.issued);
    if (graph?.markerRetainedAt) {
      await run(`INSERT INTO accountless_public_history_retention(participant_id,enrollment_device_id,
          device_credential_id,generation_id,head_revision,retained_at) VALUES(?,?,?,?,1,?)`,
      owner.id, owner.deviceId, owner.deviceId, domain.generationId, graph.markerRetainedAt);
    }
  }
  for (const chunk of owner.v1Chunks) {
    const envelope = hex64(`envelope-${chunk.id}`);
    await run(`INSERT INTO device_upload_authorizations(id,participant_id,issued_by_device_id,secret_hash,envelope_digest,
        body_bytes,content_type,state,issued_at,expires_at,consumed_at,consumed_contribution_id)
      VALUES(?,?,?,?,?,1,'application/json','consumed',?,?,?,?)`, chunk.authorizationId, owner.id, owner.deviceId,
    blob(hex64(`authorization-${chunk.id}`)), envelope, T.issued, T.current, T.issued, chunk.id);
    await run(`INSERT INTO telemetry_v1_chunks(id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,
        envelope_digest,parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,
        superseded_at,created_at)
      VALUES(?,?,?,'usage',?,?,1,?,?,'synthetic-v1',1,?,?,?,?,?)`, chunk.id, owner.id, owner.deviceId, DAY,
    chunk.chunkSeq, hex64(`chunk-${chunk.id}`), envelope, chunk.acceptedRecordCount, `synthetic/authority/${chunk.id}`,
    chunk.authorizationId, chunk.superseded ? T.superseded : null, T.issued);
  }
  if (owner.legacyContribution !== null) {
    const contributionId = `authority-contribution-${owner.id}`;
    await run(`INSERT INTO telemetry_contributions(id,participant_id,plaintext_digest,envelope_digest,r2_key,status,
        schema_version,range_start,range_end,client_platform,provider_policy_epoch,estimated_api_cost_usd,
        priced_event_coverage_percent,unknown_model_event_count,unknown_billable_units,price_basis,declared_record_count,
        created_at,transport_schema_version)
      VALUES(?,?,?,?,?,'accepted','telemetry-contribution-v0.1',?,?,'synthetic','synthetic',NULL,100,0,0,'synthetic',0,?,?)`,
    contributionId, owner.id, hex64(`plain-${contributionId}`), hex64(`envelope-${contributionId}`),
    `synthetic/authority/${contributionId}`, T.issued, T.issued, T.issued,
    `telemetry-contribution-${owner.legacyContribution}`);
  }
  if (owner.ownerDigest !== null) {
    await run("INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state) VALUES(?,?,'active')",
      owner.id, owner.ownerDigest);
    if (owner.ownerRevision !== null) {
      const withdrawn = owner.ownerHeadState === "withdrawn";
      await run("INSERT INTO storage_owner_revisions(owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?)",
        owner.ownerDigest, owner.ownerRevision, withdrawn ? 2 : 1, owner.ownerHeadState);
    }
  }
}

function inOracle(id: string): boolean {
  return id.startsWith(PREFIX);
}

it("D1's retained v1.2 scope and community owner page match the committed oracle", async () => {
  await migrate();
  await removeFlowTriggers();
  const runtime = await db().prepare("UPDATE telemetry_v12_runtime SET state='active' WHERE id=1").run();
  expect(runtime.meta.changes).toBe(1);
  const correction = await db().prepare("SELECT state FROM telemetry_usage_correction_runtime WHERE id=1")
    .first<{ state: string }>();
  expect(correction?.state).toBe("staged");

  const participants = CASES.flatMap((oracleCase) => oracleCase.participants);
  expect(new Set(participants.map((owner) => owner.id)).size).toBe(participants.length);
  for (const owner of participants) await insertParticipant(owner);

  const retainedScope = (await db().prepare(`SELECT participant_id,device_id FROM (${V12_RETAINED_AUTHORIZATION_SCOPE})
      ORDER BY participant_id,device_id`).all<ScopeRow>()).results
    .filter((row) => inOracle(row.participant_id))
    .map((row) => ({ participant_id: row.participant_id, device_id: row.device_id }));

  // Small pages exercise the participant cursor.
  const ownerPage: StorageCommunityOwner[] = [];
  let after = "";
  for (;;) {
    const page = await readStorageCommunityOwnerPage(db(), { afterParticipantId: after, limit: 4 });
    ownerPage.push(...page.filter((owner) => inOracle(owner.participantId)).map((owner) => ({
      participantId: owner.participantId,
      ownerDigest: owner.ownerDigest,
      inputRevision: owner.inputRevision,
      ownerRevision: owner.ownerRevision,
      authorityEpoch: owner.authorityEpoch,
      hasV1: owner.hasV1,
      hasV11: owner.hasV11,
      hasV12: owner.hasV12,
      hasEffective: owner.hasEffective === true,
      hasLegacy: owner.hasLegacy,
    })));
    if (page.length < 4) break;
    after = page.at(-1)!.participantId;
  }

  const oracle = {
    schemaVersion: "community-authority-owner-page-oracle-v1",
    authority: "D1 V12_RETAINED_AUTHORIZATION_SCOPE and readStorageCommunityOwnerPage after the full source migration chain",
    day: DAY,
    cases: CASES,
    retainedScope,
    ownerPage,
  };

  // Fixed expectations keep a regeneration from silently accepting a changed
  // D1 predicate; the fixture comparison below then pins the exact rows.
  const id = (caseNumber: number) => `${PREFIX}${caseNumber.toString().padStart(2, "0")}a`;
  expect(retainedScope.map((row) => row.participant_id)).toEqual([1, 2, 3, 5, 9, 10, 12].map(id));
  expect(ownerPage.map((owner) => owner.participantId))
    .toEqual([...[1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 14, 15].map(id), `${PREFIX}16a`, `${PREFIX}16b`]);
  expect(ownerPage.filter((owner) => owner.hasV12).map((owner) => owner.participantId))
    .toEqual([1, 2, 3, 9, 10, 12].map(id));
  expect(ownerPage.every((owner) => owner.hasEffective === owner.hasV12)).toBe(true);
  expect(ownerPage.filter((owner) => owner.hasV1).map((owner) => owner.participantId)).toEqual([id(6)]);
  expect(ownerPage.filter((owner) => owner.hasV11).map((owner) => owner.participantId)).toEqual([id(6), id(14)]);
  expect(ownerPage.filter((owner) => owner.hasLegacy).map((owner) => owner.participantId)).toEqual([`${PREFIX}16a`]);
  const withdrawnHead = ownerPage.find((owner) => owner.participantId === id(15));
  expect(withdrawnHead?.ownerDigest).not.toBeNull();
  expect([withdrawnHead?.ownerRevision, withdrawnHead?.authorityEpoch]).toEqual([0, 0]);
  if (REGENERATE) {
    await expect(`${JSON.stringify(oracle, null, 2)}\n`)
      .toMatchFileSnapshot("../postgres-test/fixtures/community-authority-owner-page-oracle.json");
  } else {
    expect(oracle).toEqual(committedOracle);
  }
}, 120_000);
