import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { expect, it } from "vitest";
import committedOracle from "../postgres-test/fixtures/community-public-source-owners-oracle.json";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";

/*
 * D1 oracle for the public contribution-source eligibility view.
 *
 * The migrated D1 source database is the authority: its full migration chain,
 * including every ingestion-isolation migration, is applied in the deployed
 * order (as storage-v12-eligibility-migration.spec.ts does) and the effective
 * `community_public_source_owners` definition is the one those migrations
 * leave behind. The view is a pure function of the authority rows below, so
 * the flow triggers (enrollment, upload, domain activation and the v1.2
 * delivery bridge) are removed from this disposable database and each
 * synthetic case writes its final authority state directly. Table
 * definitions, CHECK constraints and foreign keys stay in force. Every
 * identifier, digest and timestamp is a content-free constant, and every
 * timestamp uses one canonical millisecond form, so D1's text comparison and
 * PostgreSQL's timestamptz comparison agree.
 *
 * The committed fixture holds both the case inputs and D1's rows. The
 * PostgreSQL spec (postgres-test/postgres-owner-journal-authority.spec.mjs)
 * rebuilds the same inputs against the staged 0046 view and must return the
 * same rows. A normal or CI run never writes the fixture: it is imported
 * below, so a missing file fails the run, and a changed result fails the
 * file comparison. The Workers test pool cannot read host environment
 * variables, so regeneration uses Vitest's explicit update flag instead:
 *   npx vitest run test/community-public-source-owners-oracle.spec.ts -u
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

type RevocationReason = "user_opt_out" | "security_reset" | "operator_containment";

interface Lease {
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly state: "active" | "revoked";
  readonly revokedAt: string | null;
  readonly revocationReason: RevocationReason | null;
}

interface OracleAccountless {
  readonly deviceId: string;
  readonly secretHash: string;
  readonly ledger: Lease & {
    readonly schemaVersion: string;
    readonly policyVersion: string;
    readonly authorizationBasis: string;
    readonly renewalGeneration: number;
    readonly renewedAt: string | null;
  };
  readonly owner: Lease;
  readonly device: Omit<Lease, "revocationReason"> & { readonly socialVerifiedAt: string | null };
  readonly v11Grant: Lease | null;
  readonly v12Grant: Lease | null;
  readonly v11Domain: { readonly generationId: string; readonly head: boolean } | null;
  readonly v12Domain: { readonly generationId: string; readonly head: boolean } | null;
  readonly marker: { readonly lineage: "v1.1" | "v1.2"; readonly retainedAt: string } | null;
}

interface OracleParticipant {
  readonly id: string;
  readonly ownerKind: "social" | "accountless";
  readonly state: "active" | "deleting";
  readonly accountless: OracleAccountless | null;
}

interface OracleRow {
  readonly participant_id: string;
  readonly owner_kind: string;
  readonly device_id: string | null;
}

interface OracleCase {
  readonly name: string;
  readonly participants: readonly OracleParticipant[];
  readonly rows: readonly OracleRow[];
}

const b = env as Bindings;
const db = () => b.USAGE_MONITOR_DB;
const SOURCE_ID = "synthetic-public-source-oracle";
const SOURCE_NAMESPACE = "synthetic-public-source-oracle-namespace";
const DAY = "2026-09-20";
const T = Object.freeze({
  // D1 leases are exactly 30 days from issue or from the latest renewal.
  issued: "2026-09-01T00:00:00.000Z",
  expires: "2026-10-01T00:00:00.000Z",
  renewedAt: "2026-09-25T00:00:00.000Z",
  renewedExpires: "2026-10-25T00:00:00.000Z",
  lapsedIssued: "2026-06-01T00:00:00.000Z",
  lapsedExpires: "2026-07-01T00:00:00.000Z",
  retained: "2026-09-20T12:00:00.000Z",
  laterRevocation: "2026-09-20T12:00:01.000Z",
  socialVerified: "2026-09-02T00:00:00.000Z",
});
const ENROLLMENT = Object.freeze({
  schemaVersion: "accountless-enrollment-v0.1",
  policyVersion: "accountless-opt-out-v1",
  authorizationBasis: "accountless-policy-v1",
  renewalGeneration: 0,
  renewedAt: null,
});

function uuid(prefix: string, caseNumber: number, member: string): string {
  const tail = `${caseNumber.toString(16).padStart(2, "0")}${member.charCodeAt(0).toString(16)}`;
  return `${prefix}-0000-4000-8000-${tail.padStart(12, "0")}`;
}
function hex64(seed: string): string {
  let value = "";
  for (const character of seed) value += character.charCodeAt(0).toString(16).padStart(2, "0");
  return value.padStart(64, "0").slice(-64);
}
function active(issuedAt: string = T.issued, expiresAt: string = T.expires): Lease {
  return { issuedAt, expiresAt, state: "active", revokedAt: null, revocationReason: null };
}
function optedOut(revokedAt: string = T.retained, issuedAt: string = T.issued, expiresAt: string = T.expires): Lease {
  return { issuedAt, expiresAt, state: "revoked", revokedAt, revocationReason: "user_opt_out" };
}

/** One accountless participant. Defaults describe an eligible v1.1 device. */
function accountless(
  caseNumber: number,
  member: string,
  shape: {
    readonly lease?: (role: "ledger" | "owner" | "device" | "v11" | "v12") => Lease;
    readonly ledger?: Partial<OracleAccountless["ledger"]>;
    readonly socialVerifiedAt?: string | null;
    readonly v11Grant?: boolean;
    readonly v12Grant?: boolean;
    readonly v11Domain?: "head" | "stale" | null;
    readonly v12Domain?: "head" | null;
    readonly marker?: OracleAccountless["marker"];
  } = {},
): OracleParticipant {
  const lease = shape.lease ?? (() => active());
  const device = lease("device");
  return {
    id: `oracle-${caseNumber.toString().padStart(2, "0")}${member}`,
    ownerKind: "accountless",
    state: "active",
    accountless: {
      deviceId: uuid("0d000000", caseNumber, member),
      secretHash: hex64(`secret-${caseNumber}-${member}`),
      ledger: { ...lease("ledger"), ...ENROLLMENT, ...shape.ledger },
      owner: lease("owner"),
      device: { issuedAt: device.issuedAt, expiresAt: device.expiresAt, state: device.state,
        revokedAt: device.revokedAt, socialVerifiedAt: shape.socialVerifiedAt ?? null },
      v11Grant: shape.v11Grant === false ? null : lease("v11"),
      v12Grant: shape.v12Grant === true ? lease("v12") : null,
      v11Domain: shape.v11Domain === null ? null
        : { generationId: uuid("0a110000", caseNumber, member), head: shape.v11Domain !== "stale" },
      v12Domain: shape.v12Domain === "head" ? { generationId: uuid("0a120000", caseNumber, member), head: true } : null,
      marker: shape.marker ?? null,
    },
  };
}
function social(caseNumber: number, member: string, state: "active" | "deleting"): OracleParticipant {
  return { id: `oracle-${caseNumber.toString().padStart(2, "0")}${member}`, ownerKind: "social", state, accountless: null };
}
const v12Only = { v11Grant: false, v12Grant: true, v11Domain: null, v12Domain: "head" } as const;
const renewed = { renewalGeneration: 1, renewedAt: T.renewedAt } as const;

const CASES: readonly Omit<OracleCase, "rows">[] = [
  { name: "social-active", participants: [social(1, "a", "active")] },
  { name: "social-deleting", participants: [social(2, "a", "deleting")] },
  { name: "accountless-v11-active", participants: [accountless(3, "a")] },
  {
    // (a) the lease lapsed with every expiry still equal: D1 has no clock
    // predicate, so the device stays a public source; (b) the ledger, owner
    // and device renewed without the grant.
    name: "accountless-v11-expired",
    participants: [
      accountless(4, "a", { lease: () => active(T.lapsedIssued, T.lapsedExpires) }),
      accountless(4, "b", { ledger: renewed,
        lease: (role) => active(T.issued, role === "v11" ? T.expires : T.renewedExpires) }),
    ],
  },
  {
    // (a) exact ordinary opt-out with the prospective marker; (b) the same
    // marker, but the grant was revoked at a different instant.
    name: "accountless-v11-opt-out-retained",
    participants: [
      accountless(5, "a", { lease: () => optedOut(), marker: { lineage: "v1.1", retainedAt: T.retained } }),
      accountless(5, "b", {
        lease: (role) => optedOut(role === "v11" ? T.laterRevocation : T.retained),
        marker: { lineage: "v1.1", retainedAt: T.retained },
      }),
    ],
  },
  { name: "accountless-v12-active", participants: [accountless(6, "a", v12Only)] },
  {
    name: "accountless-v12-expired",
    participants: [
      accountless(7, "a", { ...v12Only, lease: () => active(T.lapsedIssued, T.lapsedExpires) }),
      accountless(7, "b", { ...v12Only, ledger: renewed,
        lease: (role) => active(T.issued, role === "v12" ? T.expires : T.renewedExpires) }),
    ],
  },
  {
    name: "accountless-v12-retained",
    participants: [accountless(8, "a", { ...v12Only, lease: () => optedOut(),
      marker: { lineage: "v1.2", retainedAt: T.retained } })],
  },
  {
    name: "accountless-v12-opt-out-without-marker",
    participants: [accountless(9, "a", { ...v12Only, lease: () => optedOut() })],
  },
  {
    // (a) one device holding both v1.1 and v1.2 domains matches only the
    // v1.1 branch; (b) a leftover v1.1 domain without a v1.1 grant or head
    // keeps the v1.2 successor ineligible.
    name: "accountless-v11-and-v12-domains",
    participants: [
      accountless(10, "a", { v12Grant: true, v12Domain: "head" }),
      accountless(10, "b", { v11Grant: false, v12Grant: true, v11Domain: "stale", v12Domain: "head" }),
    ],
  },
  {
    // Successor-lineage constants that do not match the enrollment ledger.
    name: "accountless-v12-mismatched-constant",
    participants: [
      accountless(11, "a", { ...v12Only, ledger: { schemaVersion: "accountless-enrollment-v0.2" } }),
      accountless(11, "b", { ...v12Only, ledger: { authorizationBasis: "accountless-policy-v1.2" } }),
    ],
  },
  {
    // PostgreSQL forbids an accountless credential with a pairing id, so the
    // pairing is represented by its social verification timestamp, which both
    // engines' views exclude.
    name: "accountless-paired-device",
    participants: [accountless(12, "a", { socialVerifiedAt: T.socialVerified })],
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

async function insertParticipant(participant: OracleParticipant): Promise<void> {
  await db().prepare("INSERT INTO participants(id,owner_kind,state,created_at) VALUES(?,?,?,?)")
    .bind(participant.id, participant.ownerKind, participant.state, T.issued).run();
  const graph = participant.accountless;
  if (!graph) return;
  const { deviceId, ledger, owner, device } = graph;
  await db().prepare(`INSERT INTO accountless_enrollment_ledger(device_id,device_secret_hash,installation_principal_id,
      schema_version,policy_version,authorization_basis,state,issued_at,expires_at,revoked_at,revocation_reason,
      renewal_generation,renewed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(deviceId, blob(graph.secretHash), `oracle-installation-${deviceId}`, ledger.schemaVersion,
      ledger.policyVersion, ledger.authorizationBasis, ledger.state, ledger.issuedAt, ledger.expiresAt,
      ledger.revokedAt, ledger.revocationReason, ledger.renewalGeneration, ledger.renewedAt).run();
  await db().prepare(`INSERT INTO device_credentials(id,participant_id,authority_kind,accountless_enrollment_device_id,
      secret_hash,state,issued_at,expires_at,last_used_at,revoked_at,social_verified_at)
    VALUES(?,?,'accountless',?,?,?,?,?,?,?,?)`)
    .bind(deviceId, participant.id, deviceId, blob(graph.secretHash), device.state, device.issuedAt,
      device.expiresAt, device.issuedAt, device.revokedAt, device.socialVerifiedAt).run();
  await db().prepare(`INSERT INTO accountless_upload_owners(enrollment_device_id,participant_id,device_credential_id,
      policy_version,authorization_basis,authorized_at,expires_at,state,revoked_at,revocation_reason)
    VALUES(?,?,?,'accountless-opt-out-v1','accountless-policy-v1',?,?,?,?,?)`)
    .bind(deviceId, participant.id, deviceId, owner.issuedAt, owner.expiresAt, owner.state, owner.revokedAt,
      owner.revocationReason).run();
  if (graph.v11Grant) {
    const grant = graph.v11Grant;
    await db().prepare(`INSERT INTO accountless_v11_device_authorizations(enrollment_device_id,participant_id,
        device_credential_id,telemetry_schema_version,field_dictionary_version,privacy_contract_version,
        authorized_at,expires_at,state,revoked_at,revocation_reason)
      VALUES(?,?,?,'telemetry-contribution-v1.1','telemetry-v1.1-registry-2026-08-31.1',
        'ongoing-privacy-safe-telemetry-v1.1',?,?,?,?,?)`)
      .bind(deviceId, participant.id, deviceId, grant.issuedAt, grant.expiresAt, grant.state, grant.revokedAt,
        grant.revocationReason).run();
  }
  if (graph.v12Grant) {
    const grant = graph.v12Grant;
    await db().prepare(`INSERT INTO accountless_v12_device_authorizations(enrollment_device_id,participant_id,
        device_credential_id,schema_version,policy_version,authorization_basis,telemetry_schema_version,
        field_dictionary_version,privacy_contract_version,authorized_at,expires_at,state,revoked_at,revocation_reason)
      VALUES(?,?,?,'accountless-upload-owner-v1.2','accountless-telemetry-v1.2-policy-v1','accountless-policy-v1.2',
        'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1','ongoing-privacy-safe-telemetry-v1.2',
        ?,?,?,?,?)`)
      .bind(deviceId, participant.id, deviceId, grant.issuedAt, grant.expiresAt, grant.state, grant.revokedAt,
        grant.revocationReason).run();
  }
  for (const [version, domain] of [["v11", graph.v11Domain], ["v12", graph.v12Domain]] as const) {
    if (!domain) continue;
    const token = hex64(`token-${version}-${domain.generationId}`);
    const fingerprint = hex64(`legacy-${version}-${domain.generationId}`);
    await db().prepare(`INSERT INTO telemetry_${version}_domain_predecessors(token_hash,participant_id,device_id,
        previous_generation_id,legacy_fingerprint,input_revision,from_day,through_day,
        ${version === "v11" ? "winners_json" : "days_json"},created_at,expires_at)
      VALUES(?,?,?,NULL,?,0,?,?,'[]',?,?)`)
      .bind(token, participant.id, deviceId, fingerprint, DAY, DAY, T.issued, T.expires).run();
    await db().prepare(`INSERT INTO telemetry_${version}_domains(id,participant_id,device_id,predecessor_token_hash,
        previous_generation_id,manifest_digest,legacy_fingerprint,input_revision,from_day,through_day,days_json,created_at)
      VALUES(?,?,?,?,NULL,?,?,0,?,?,'[]',?)`)
      .bind(domain.generationId, participant.id, deviceId, token, hex64(`manifest-${version}-${domain.generationId}`),
        fingerprint, DAY, DAY, T.issued).run();
    if (domain.head) {
      await db().prepare(`INSERT INTO telemetry_${version}_domain_heads(participant_id,generation_id,revision,updated_at)
        VALUES(?,?,1,?)`).bind(participant.id, domain.generationId, T.issued).run();
    }
  }
  if (graph.marker) {
    const generation = graph.marker.lineage === "v1.1" ? graph.v11Domain : graph.v12Domain;
    await db().prepare(`INSERT INTO accountless_public_history_retention(participant_id,enrollment_device_id,
        device_credential_id,generation_id,head_revision,retained_at) VALUES(?,?,?,?,1,?)`)
      .bind(participant.id, deviceId, deviceId, generation!.generationId, graph.marker.retainedAt).run();
  }
}

function sortRows(rows: readonly OracleRow[]): OracleRow[] {
  const key = (row: OracleRow) => `${row.participant_id}\u0000${row.owner_kind}\u0000${row.device_id ?? ""}`;
  return [...rows].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);
}

it("D1's community_public_source_owners matches the committed twelve-case oracle", async () => {
  await migrate();
  const view = await db().prepare("SELECT sql FROM sqlite_schema WHERE type='view' AND name='community_public_source_owners'")
    .first<{ sql: string }>();
  // The migrated definition is the five-branch isolation 0011 view.
  expect(view?.sql.match(/\bUNION ALL\b/gu)).toHaveLength(4);
  expect(view?.sql).toContain("accountless_v12_device_authorizations successor");
  await removeFlowTriggers();

  const participants = CASES.flatMap((oracleCase) => oracleCase.participants);
  expect(new Set(participants.map((participant) => participant.id)).size).toBe(participants.length);
  for (const participant of participants) await insertParticipant(participant);

  const all = (await db().prepare("SELECT participant_id,owner_kind,device_id FROM community_public_source_owners")
    .all<OracleRow>()).results.filter((row) => row.participant_id.startsWith("oracle-"));
  const cases: OracleCase[] = CASES.map((oracleCase) => {
    const ids = new Set(oracleCase.participants.map((participant) => participant.id));
    return { ...oracleCase, rows: sortRows(all.filter((row) => ids.has(row.participant_id))
      .map((row) => ({ participant_id: row.participant_id, owner_kind: row.owner_kind, device_id: row.device_id }))) };
  });
  expect(cases.reduce((total, oracleCase) => total + oracleCase.rows.length, 0)).toBe(all.length);
  const oracle = {
    schemaVersion: "community-public-source-owners-oracle-v1",
    authority: "D1 community_public_source_owners after the full source migration chain (ingestion-isolation 0011 definition)",
    cases,
  };

  // Fixed expectations keep a regeneration from silently accepting a changed
  // D1 predicate; the file comparison below then pins the exact rows.
  expect(Object.fromEntries(cases.map((oracleCase) => [oracleCase.name, oracleCase.rows.length]))).toEqual({
    "social-active": 1,
    "social-deleting": 0,
    "accountless-v11-active": 1,
    "accountless-v11-expired": 1,
    "accountless-v11-opt-out-retained": 1,
    "accountless-v12-active": 1,
    "accountless-v12-expired": 1,
    "accountless-v12-retained": 1,
    "accountless-v12-opt-out-without-marker": 0,
    "accountless-v11-and-v12-domains": 1,
    "accountless-v12-mismatched-constant": 0,
    "accountless-paired-device": 0,
  });
  expect(committedOracle.schemaVersion).toBe(oracle.schemaVersion);
  await expect(`${JSON.stringify(oracle, null, 2)}\n`)
    .toMatchFileSnapshot("../postgres-test/fixtures/community-public-source-owners-oracle.json");
}, 120_000);
