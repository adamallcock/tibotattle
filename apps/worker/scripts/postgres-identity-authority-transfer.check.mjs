import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { participantDeletionDigest } from "./cutover-source-projections.mjs";
import { CutoverSourceError, readCutoverSeal } from "./cutover-source-seal.mjs";
import {
  POSTGRES_FASTPATH_IDENTITY_ALLOWLIST,
  POSTGRES_FASTPATH_IDENTITY_CREDENTIAL_OMISSIONS,
  fastpathIdentityAllowlistSha256,
} from "./postgres-fastpath-identity-copy.mjs";
import {
  IDENTITY_AUTHORITY_COLUMN_MAP,
  IDENTITY_AUTHORITY_COUNTER_MAPPING,
  IDENTITY_AUTHORITY_EXCLUDED_TABLES,
  IDENTITY_AUTHORITY_FROZEN_ORDER,
  IDENTITY_AUTHORITY_MAX_PAGE_BYTES,
  IDENTITY_AUTHORITY_MAX_PAGE_ROWS,
  IDENTITY_AUTHORITY_TARGET_MISSING,
  IDENTITY_TRIGGER_POLICY,
  IdentityAuthorityTransferError,
  identityAuthorityPolicySha256,
  runIdentityAuthorityTransfer,
} from "./postgres-identity-authority-transfer.mjs";
import { PostgresTransferTargetError, TRANSFER_STAGES } from "./postgres-transfer-target.mjs";
import { forgeVariantSeal, headCommit, outputPathsOf, prepareSealWorld, sealWorld } from "../postgres-test/fixtures/w2-seal/seal-harness.mjs";
import {
  Q1_INGESTION_DUMP,
  SYNTHETIC_IDENTITY_LINK_SECRET,
  SYNTHETIC_IDENTITY_LINK_VERSION,
  identityLinkFingerprint,
} from "../postgres-test/fixtures/w2-seal/synthetic-sources.mjs";

// PT-3 contract checks without a database: the frozen COLUMN_MAP, order,
// counter mapping and trigger policy, and every source-side refusal (each
// must fire before the importer touches its target: a handle that is not a
// registered PT-1 handle is only reached once every sealed-source check has
// passed). The PostgreSQL acceptance lives in
// postgres-test/postgres-identity-authority-transfer.spec.mjs.
// Run: node --test ./scripts/postgres-identity-authority-transfer.check.mjs

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIN = Object.freeze({ keyVersion: SYNTHETIC_IDENTITY_LINK_VERSION,
  secretFingerprint: identityLinkFingerprint(SYNTHETIC_IDENTITY_LINK_SECRET) });
// A reviewed change to the order, COLUMN_MAP, counters, policy, exclusions
// or target-missing list must update this pin.
// Re-pinned at the wave-2 integration: only the erased-redeemer trigger's reason
// changed, from "Staged 0063" to "Primary 0063", when 0063 was promoted.
const POLICY_SHA256 = "779895ebc03df1a93a148bd4c46a4d9747a84ef29ee1605e9e22fc0e493a031e";
let world;
let seal;
let manifestPath;

const isCode = code => error => (error instanceof IdentityAuthorityTransferError
  || error instanceof PostgresTransferTargetError) && error.code === code;

before(async () => {
  world = await prepareSealWorld({ commit: headCommit(WORKER_ROOT) });
  const run = await sealWorld(world);
  const result = await run.run();
  manifestPath = outputPathsOf(run.out).manifest;
  seal = await readCutoverSeal({ manifestPath, expectedSealId: result.sealId });
});

after(async () => {
  await world?.dispose();
});

test("the stage, order and policy are frozen and pinned", () => {
  assert.ok(TRANSFER_STAGES.includes("identity-authority"));
  assert.equal(identityAuthorityPolicySha256(), POLICY_SHA256);
  const order = IDENTITY_AUTHORITY_FROZEN_ORDER;
  assert.equal(new Set(order).size, order.length);
  const groups = order.map(name => IDENTITY_AUTHORITY_COLUMN_MAP[name].group);
  assert.deepEqual(groups, [...groups].sort((left, right) => left - right), "groups 1 to 4 in order");
  const before = (parent, child) => assert.ok(order.indexOf(parent) < order.indexOf(child), `${parent} before ${child}`);
  before("admin_action_audit", "telemetry_transport_floor_rollbacks");
  for (const child of ["web_sessions", "device_credentials", "attribution_enrollments", "storage_v11_owner_links",
    "accountless_upload_owners", "telemetry_transport_participant_floors", "enrollment_grants"]) before("participants", child);
  before("web_sessions", "device_pairings");
  before("device_pairings", "device_credentials");
  before("accountless_enrollment_ledger", "device_credentials");
  before("device_credentials", "device_credential_rotations");
  before("device_credentials", "device_upload_authorizations");
  before("enrollment_grants", "participant_community_eligibility");
  before("accountless_upload_owners", "accountless_v11_device_authorizations");
  before("telemetry_transport_participant_floors", "telemetry_transport_floor_rollbacks");
  before("github_distribution_snapshots", "github_release_snapshots");
  before("github_release_snapshots", "github_release_asset_snapshots");
  for (const [tableName, triggers] of Object.entries(IDENTITY_TRIGGER_POLICY)) {
    for (const [trigger, entry] of Object.entries(triggers)) {
      assert.ok(["fire", "suppress"].includes(entry.policy), `${tableName}.${trigger}`);
      assert.ok(entry.reason.length > 0 && entry.reason.length <= 240);
    }
  }
  // The brief's suppressions: TA-1 auto-creation, V11-A consent admission,
  // participant_input_created and the 0029 link terminal and receipt triggers.
  const suppressed = Object.entries(IDENTITY_TRIGGER_POLICY).flatMap(([tableName, triggers]) =>
    Object.entries(triggers).filter(([, entry]) => entry.policy === "suppress").map(([trigger]) => `${tableName}.${trigger}`));
  for (const name of ["participants.attribution_enrollment_created", "participants.telemetry_transport_floor_created",
    "participants.participant_input_created", "device_credentials.telemetry_transport_device_floor_created",
    "telemetry_v11_device_consents.telemetry_v11_consent_admission",
    "storage_v11_owner_links.storage_v11_owner_link_terminal_guard",
    "storage_v11_owner_links.storage_v11_owner_erasure_receipt_create"]) {
    assert.ok(suppressed.includes(name), name);
  }
  // Controls guards fire; the controls row is degraded by an ordinary UPDATE.
  assert.ok(Object.values(IDENTITY_TRIGGER_POLICY.collection_controls).every(entry => entry.policy === "fire"));
});

test("the COLUMN_MAP imports credential and rotation hashes and reuses T-1's reviewed columns", () => {
  const participants = IDENTITY_AUTHORITY_COLUMN_MAP.participants.columns.map(([source]) => source);
  for (const column of Object.keys(POSTGRES_FASTPATH_IDENTITY_CREDENTIAL_OMISSIONS)) {
    assert.ok(participants.includes(column), `participants.${column} is imported (no credential omission)`);
  }
  const rotations = IDENTITY_AUTHORITY_COLUMN_MAP.device_credential_rotations.columns.map(([source]) => source);
  assert.ok(rotations.includes("prior_secret_hash") && rotations.includes("replacement_secret_hash"));
  for (const spec of POSTGRES_FASTPATH_IDENTITY_ALLOWLIST) {
    const mapped = IDENTITY_AUTHORITY_COLUMN_MAP[spec.table];
    // Controls are recorded and degraded, never copied; other T-1 tables
    // (v1.1 domain heads, retention markers, the correction runtime) belong
    // to other importers.
    if (mapped === undefined || mapped.mode === "record-and-degrade") continue;
    for (const column of spec.columns) assert.ok(mapped.columns.some(entry => entry.join() === column.join()),
      `${spec.table}: T-1 column ${column[0]} kept`);
  }
  assert.equal(fastpathIdentityAllowlistSha256().length, 64, "the T-1 allowlist pin is untouched");
  for (const name of Object.keys(IDENTITY_AUTHORITY_EXCLUDED_TABLES)) {
    assert.equal(Object.hasOwn(IDENTITY_AUTHORITY_COLUMN_MAP, name), false, `${name} is never imported`);
  }
  for (const ledgerTable of ["deletion_tombstones", "storage_erasure_jobs", "identity_reenrollment_cooldowns"]) {
    assert.equal(IDENTITY_AUTHORITY_FROZEN_ORDER.includes(ledgerTable), false);
  }
  assert.equal(IDENTITY_AUTHORITY_FROZEN_ORDER.some(name => name.startsWith("accountless_public_history_")), false);
  assert.equal(IDENTITY_AUTHORITY_COLUMN_MAP.collection_controls.mode, "record-and-degrade");
  assert.equal(IDENTITY_AUTHORITY_COLUMN_MAP.community_public_source_bootstrap.mode, "replace-bootstrap");
});

test("the COLUMN_MAP is closed over the d43c8f92 schema and every AUTOINCREMENT counter is mapped", async () => {
  const dump = JSON.parse(await readFile(Q1_INGESTION_DUMP, "utf8"));
  const database = new DatabaseSync(":memory:");
  try {
    for (const entry of dump.schema.filter(item => item.type === "table")) database.exec(entry.sql);
    for (const [name, mapped] of Object.entries(IDENTITY_AUTHORITY_COLUMN_MAP)) {
      const columns = database.prepare(`PRAGMA table_xinfo("${name}")`).all().filter(column => column.hidden === 0)
        .map(column => column.name).sort();
      assert.deepEqual([...mapped.columns.map(([source]) => source)].sort(), columns, name);
    }
    for (const name of IDENTITY_AUTHORITY_TARGET_MISSING) {
      assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name), name);
    }
  } finally {
    database.close();
  }
  const autoincrement = dump.schema.filter(item => item.type === "table" && /AUTOINCREMENT/iu.test(item.sql ?? ""))
    .map(item => item.name).sort();
  assert.deepEqual(Object.keys(IDENTITY_AUTHORITY_COUNTER_MAPPING).sort(), autoincrement);
  for (const { name } of dump.sqliteSequence) assert.ok(Object.hasOwn(IDENTITY_AUTHORITY_COUNTER_MAPPING, name), name);
});

test("arguments are closed: pages at most 256 rows and 4 MiB, a handle and a hook function", async () => {
  const handle = { sealManifestSha256: seal.manifest.sealId };
  for (const options of [{ pageRows: IDENTITY_AUTHORITY_MAX_PAGE_ROWS + 1 }, { pageRows: 0 },
    { pageBytes: IDENTITY_AUTHORITY_MAX_PAGE_BYTES + 1 }, { pageBytes: 10 }, { onPage: "kill" }, { handle: null }]) {
    await assert.rejects(runIdentityAuthorityTransfer({ handle, sealManifestPath: manifestPath, identityLinkPin: PIN,
      ...options }), isCode("CUTOVER_IDENTITY_ARGUMENT_INVALID"), JSON.stringify(Object.keys(options)));
  }
  await assert.rejects(runIdentityAuthorityTransfer({ handle, sealManifestPath: manifestPath,
    identityLinkPin: { keyVersion: "bad version", secretFingerprint: PIN.secretFingerprint } }),
  isCode("CUTOVER_IDENTITY_ARGUMENT_INVALID"));
  await assert.rejects(runIdentityAuthorityTransfer({ handle: { sealManifestSha256: "0".repeat(64) },
    sealManifestPath: manifestPath, identityLinkPin: PIN }), error => error?.code === "CUTOVER_SEAL_MANIFEST_INVALID");
});

test("every sealed-source refusal fires before the target is touched", async () => {
  // A clean seal passes every source check and only then meets the target:
  // the unregistered handle is refused by PT-1 (no database was reached).
  await assert.rejects(runIdentityAuthorityTransfer({ handle: { sealManifestSha256: seal.manifest.sealId },
    sealManifestPath: manifestPath, identityLinkPin: PIN }), isCode("CUTOVER_TARGET_HANDLE_INVALID"));
  const cases = [
    ["SELECT 1", { ...PIN, secretFingerprint: identityLinkFingerprint("w2-seal-fixture-wrong-secret-000000003") },
      "CUTOVER_IDENTITY_LINK_SECRET_MISMATCH"],
    ["DELETE FROM identity_link_secret_configuration", PIN, "CUTOVER_IDENTITY_LINK_SECRET_MISMATCH"],
    ["UPDATE community_public_source_bootstrap SET completed = 0", PIN, "CUTOVER_PUBLIC_SOURCE_BOOTSTRAP_INCOMPLETE"],
    [`PRAGMA ignore_check_constraints = ON;
      UPDATE community_public_source_bootstrap SET policy_version = 'community-public-sources-v2'`, PIN,
    "CUTOVER_PUBLIC_SOURCE_BOOTSTRAP_INCOMPLETE"],
    ["DELETE FROM community_public_source_bootstrap", PIN, "CUTOVER_PUBLIC_SOURCE_BOOTSTRAP_INCOMPLETE"],
    [`DROP TRIGGER IF EXISTS accountless_v11_authorization_immutable;
      UPDATE accountless_v11_device_authorizations SET participant_id = '${world.fixture.ids.participant}'
       WHERE enrollment_device_id = '${world.fixture.ids.revokedDevice}'`, PIN, "CUTOVER_ACCOUNTLESS_AUTHORITY_CHAIN_INVALID"],
    ["INSERT INTO sqlite_sequence(name, seq) VALUES ('synthetic_counter', 3)", PIN, "CUTOVER_COUNTER_UNMAPPED"],
    ["ALTER TABLE device_credentials ADD COLUMN synthetic_extra TEXT", PIN, "CUTOVER_COLUMN_UNMAPPED"],
    ["ALTER TABLE github_release_asset_snapshots DROP COLUMN asset_digest", PIN, "CUTOVER_COLUMN_UNMAPPED"],
    ["DROP TABLE telemetry_performance_device_capabilities", PIN, "CUTOVER_SOURCE_TABLE_MISSING"],
    [`PRAGMA ignore_check_constraints = ON;
      UPDATE participants SET created_at = 'not-an-instant' WHERE id = '${world.fixture.ids.participant}'`, PIN,
    "CUTOVER_SOURCE_VALUE_INVALID"],
    [`PRAGMA ignore_check_constraints = ON;
      UPDATE accountless_enrollment_issuance SET budget_day = '2026-13-45'`, PIN, "CUTOVER_SOURCE_VALUE_INVALID"],
    // Erasure quiescence: an interrupted Cloudflare erasure (deleting with
    // its fence, a restore-replay NULL fence, or a fence left on an active
    // row) is refused whether or not its tombstone was recorded.
    [`UPDATE participants SET state = 'deleting', deletion_session_id = '${randomUUID()}'
       WHERE id = '${world.fixture.ids.participant}'`, PIN, "CUTOVER_PARTICIPANT_ERASURE_PENDING"],
    [`UPDATE participants SET state = 'deleting' WHERE id = '${world.fixture.ids.participant}'`, PIN,
      "CUTOVER_PARTICIPANT_ERASURE_PENDING"],
    [`UPDATE participants SET deletion_session_id = '${randomUUID()}' WHERE id = '${world.fixture.ids.participant}'`, PIN,
      "CUTOVER_PARTICIPANT_ERASURE_PENDING"],
  ];
  for (const [sql, pin, code] of cases) {
    const forged = await forgeVariantSeal(seal, sql);
    await assert.rejects(runIdentityAuthorityTransfer({ handle: { sealManifestSha256: forged.sealId },
      sealManifestPath: forged.manifestPath, identityLinkPin: pin }), isCode(code), sql);
  }
  // The do-not-restore rule (decision D2) is PT-3's own: an 'active'
  // participant whose deletion digest the same seal's ledger records (an
  // erased participant whose rows came back) is refused before the target,
  // without PT-8-lite.
  assert.ok(world.digests.length > 0, "the clean seal's ledger already records a tombstone");
  const restored = await forgeVariantSeal(seal, `INSERT INTO deletion_tombstones(participant_digest, schema_version,
      deleted_at, retain_until) SELECT '${participantDeletionDigest(world.fixture.ids.participant)}', schema_version,
      deleted_at, retain_until FROM deletion_tombstones LIMIT 1`, "deletion-ledger");
  await assert.rejects(runIdentityAuthorityTransfer({ handle: { sealManifestSha256: restored.sealId },
    sealManifestPath: restored.manifestPath, identityLinkPin: PIN }),
  error => error instanceof CutoverSourceError && error.code === "CUTOVER_ERASED_PARTICIPANT_PRESENT");
});
