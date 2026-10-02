#!/usr/bin/env node
// GCP fast-path rehearsal (T-1): minimal identity and authority copy from a
// sealed SQLite rebuild of the d43c8f92 USAGE_MONITOR_DB into a disposable
// PostgreSQL rehearsal schema.
//
// Rehearsal-only. It runs locally with Node 22.13 or later (node:sqlite) and
// is never bundled into the Cloud Run image. It is not a cutover tool: the
// production identity import (PT-3) and its seal (PT-2) are separate work.
//
// Contract:
//   * The target is a schema named typed_legacy_transfer_rehearsal_target_*
//     (the typed-legacy importer's prefix) whose migration history equals the
//     full promoted primary chain. Any other schema is refused.
//   * Every copied table must be empty, except the seeded singletons that
//     SEEDED_SINGLETONS (postgres-transfer-target.mjs) counts as empty; those
//     seed rows are replaced by the source rows.
//   * Columns are copied by an exact allowlist: the D1/PostgreSQL column
//     intersection, minus credential and identity-link material the rehearsal
//     does not need. A source column outside the allowlist and the reviewed
//     omission list that is NOT NULL, or a target NOT NULL column without a
//     default that the allowlist does not map, refuses the copy.
//   * Everything runs in ONE transaction: emptiness re-check under table
//     locks, inserts in foreign-key order with the copied tables' user
//     triggers suppressed (ALTER TABLE ... DISABLE TRIGGER USER; foreign keys
//     stay enforced), the triggers restored and proven enabled, an explicit
//     foreign-key re-check, per-table count and canonical-row digest parity,
//     and (by default) parity of community_public_source_owners with the
//     source view. Any failure rolls back everything, trigger DDL included.
//   * Errors are closed codes; details name only a table, a column or a
//     SQLSTATE, never a value. The receipt holds counts, digests and names.
//
// Row triggers are suppressed because the copied rows are already the
// source's accepted state; firing PostgreSQL's live-path triggers would mint
// rows the source never had (analytical-input versions, transport floors,
// attribution enrollments) or refuse rows the live path cannot produce
// (owner revisions without journal rows, retention markers without an import
// run). Those derived tables are therefore NOT created by this copy; the
// analytics path does not read them, but live intake for a copied device
// would need its transport floors. Suppression is table-owner DDL, not the
// superuser-only session_replication_role, so the copy runs as the schema's
// owner: a local superuser or a Cloud SQL migrator (cloudsqlsuperuser member,
// not a superuser) alike. Every user trigger must be enabled in origin mode,
// exactly the triggers replica mode would have suppressed.
//
// Selection: participants, devices, owner links, input versions, grants,
// consents and singletons are copied whole. web_sessions and device_pairings
// are copied only as the closure the social device credentials require
// (PostgreSQL's CHECK plus foreign keys). The v1.1 domain chain is copied only
// for current heads (heads, their domains, those domains' predecessor tokens):
// eligibility (community_public_source_owners) and owner routing (hasV11)
// read it; days, manifests and chunks belong to a v1.1 transport importer.
//
// No other importer in the rehearsal chain (typed-legacy, T-2,
// usage-correction, ingestion-journal) writes the v1/v1.1 transport and
// admission tables (telemetry_v1_chunks, telemetry_v11_chunks, _domain_days,
// _day_manifests, typed_v1_/typed_v11_ admission state, proofs, allocations,
// memberships, typed_v1_event_sources, storage_v11_event_sources) or the
// v1.2 event sources. runPostgresFastpathTransportCopy (TRANSPORT_PARTS,
// rehearsal-only, added by the integration lead) copies exactly those with
// this module's engine: "legacy-transport" after typed-legacy and before
// T-2, "v12-event-sources" after T-2. A production v1.1 transport importer
// is separate work; it must own the whole v1.1 chain: run this copy with
// --omit-family v11-domain-heads and --defer-public-owner-parity before it,
// then --verify-only after it.
//
// Not copied here, by design:
//   * storage_owner_revisions and storage_source_state: PostgreSQL 0046
//     derives owner heads from exact journal rows and refuses an unproven
//     head, so the ingestion-journal importer owns them. After that import,
//     compareFastpathOwnerRevisions proves the derived heads equal D1's.
//   * telemetry_v12_runtime and the v1.2 domain/manifest/record tables (T-2).
//   * telemetry_usage_correction_history/facts (usage-correction importer);
//     the runtime row is copied here exactly as that importer stages it
//     (state 'staged', source_state = D1 state), so its ON CONFLICT DO
//     NOTHING insert and row verification accept it afterwards.

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { readPostgresMigrations } from "./postgres-migrations.mjs";
import { SEEDED_SINGLETONS } from "./postgres-transfer-target.mjs";
import { POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX } from "./postgres-typed-legacy-transfer.mjs";

export const POSTGRES_FASTPATH_IDENTITY_COPY_SCHEMA = "postgres-fastpath-identity-copy-v1";
export const POSTGRES_FASTPATH_IDENTITY_SOURCE_COMMIT = "d43c8f92a059d9c577776f7eca8a331eb305b8a6";
export const POSTGRES_FASTPATH_IDENTITY_TARGET_SCHEMA_PREFIX = POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX;
export const POSTGRES_FASTPATH_IDENTITY_MAX_TABLE_ROWS = 1_000_000;

const HISTORY_TABLE = "_tibotattle_migration_history";
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const TARGET_SUFFIX = /^[a-z0-9_]{8,}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;
const SOURCE_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MAX_SEALED_SQLITE_BYTES = 100 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const MAX_INSERT_PARAMETERS = 30_000;
const MAX_INSERT_ROWS = 500;
const STATEMENT_TIMEOUT_MILLISECONDS = 300_000;
const LOCK_TIMEOUT_MILLISECONDS = 10_000;
const TRUSTED_SOURCES = new WeakSet();

const TARGET_TYPES = Object.freeze({
  text: Object.freeze(["text"]),
  int: Object.freeze(["bigint", "integer", "smallint"]),
  bool01: Object.freeze(["boolean"]),
  bytes: Object.freeze(["bytea"]),
  instant: Object.freeze(["timestamp with time zone"]),
  day: Object.freeze(["date"]),
});

// ---------------------------------------------------------------------------
// The reviewed allowlist. Order is foreign-key insertion order.

const PARTICIPANT_CREDENTIAL_OMISSIONS = Object.freeze({
  access_token_id: "participant-bearer-credential",
  access_token_hash: "participant-bearer-credential",
  recovery_token_id: "participant-recovery-credential",
  recovery_token_hash: "participant-recovery-credential",
  deletion_session_id: "retired-self-service-deletion-session",
  identity_link_key: "identity-link-material",
  identity_cooldown_digest: "identity-link-material",
});

function c(source, type, target = source) {
  if (!IDENTIFIER.test(source) || !IDENTIFIER.test(target) || !Object.hasOwn(TARGET_TYPES, type)) {
    throw new TypeError("fastpath identity column definition invalid");
  }
  return Object.freeze({ source, target, type });
}

function t(name, family, key, columns, options = {}) {
  const selection = options.selection ?? Object.freeze({ id: "all", where: null });
  const omitted = Object.freeze({ ...(options.omitted ?? {}) });
  const verifiedConstants = Object.freeze({ ...(options.verifiedConstants ?? {}) });
  const sourceRowRule = options.sourceRowRule ?? null;
  const targets = columns.map(column => column.target);
  const sources = columns.map(column => column.source);
  if (!IDENTIFIER.test(name) || new Set(targets).size !== targets.length || new Set(sources).size !== sources.length
      || key.some(column => !targets.includes(column))
      || Object.keys(omitted).some(column => sources.includes(column))
      || Object.keys(verifiedConstants).some(column => !Object.hasOwn(omitted, column))
      || (sourceRowRule !== null && (typeof sourceRowRule.id !== "string" || typeof sourceRowRule.apply !== "function"
        || sourceRowRule.columns.some(column => !sources.includes(column))))) {
    throw new TypeError("fastpath identity table definition invalid");
  }
  return Object.freeze({
    name,
    family,
    key: Object.freeze([...key]),
    columns: Object.freeze([...columns]),
    selection,
    omitted,
    verifiedConstants,
    sourceRowRule,
    seeded: options.seeded === true,
  });
}

// D1's JSON-mode bootstrap walk completes without resetting its cursors
// (d43c8f92 community-daily-aggregates.ts sets completed = 1 under a fence
// that matches the last page's cursors), so a finished D1 row keeps the last
// participant id and source day. PostgreSQL ports no walk and stores only
// empty cursors (primary 0053 community_public_source_bootstrap_cursors_empty),
// and 0053 directs an importer to write '' for both cursors of a completed D1
// row. A row whose walk has started but not finished (completed = 0 with a
// cursor) has no PostgreSQL representation and is refused before any write;
// completed = 0 with empty cursors (a walk not yet started) copies as is and
// PostgreSQL's community_public_source_bootstrap_advance() completes it.
const COMPLETED_WALK_CURSORS_CLEARED = Object.freeze({
  id: "d1-completed-walk-cursors-cleared",
  columns: Object.freeze(["completed", "participant_cursor", "source_day_cursor"]),
  apply(row, table) {
    const completed = typeof row.completed === "bigint" ? row.completed : null;
    const cursorsEmpty = row.participant_cursor === "" && row.source_day_cursor === "";
    if (completed === 1n) {
      return cursorsEmpty ? [row, false] : [{ ...row, participant_cursor: "", source_day_cursor: "" }, true];
    }
    if (completed === 0n && !cursorsEmpty) fail("FASTPATH_IDENTITY_SOURCE_BOOTSTRAP_IN_PROGRESS", { table });
    return [row, false];
  },
});

function referenced(id, where) {
  return Object.freeze({ id, where });
}

const SOCIAL_DEVICE_PAIRINGS = "id IN (SELECT device.paired_via_pairing_id FROM device_credentials device WHERE device.paired_via_pairing_id IS NOT NULL)";
const HEAD_DOMAINS = "id IN (SELECT head.generation_id FROM telemetry_v11_domain_heads head)";

const TABLES = Object.freeze([
  t("participants", "identity", ["id"], [
    c("id", "text"), c("owner_kind", "text"), c("state", "text"), c("consent_version", "text"),
    c("consented_at", "instant"), c("created_at", "instant"),
  ], { omitted: PARTICIPANT_CREDENTIAL_OMISSIONS }),
  // Social device credentials require their pairing (CHECK + FK), and each
  // pairing requires the web session that issued it. Only that closure is
  // copied: unclaimed pairings and unrelated sessions are not.
  t("web_sessions", "identity", ["id"], [
    c("id", "text"), c("participant_id", "text"), c("secret_hash", "bytes"), c("csrf_hash", "bytes"),
    c("scope", "text"), c("state", "text"), c("issued_at", "instant"), c("expires_at", "instant"),
    c("last_used_at", "instant"), c("revoked_at", "instant"),
  ], { selection: referenced("issued-by-copied-device-pairings",
    `id IN (SELECT pairing.issued_by_session_id FROM device_pairings pairing WHERE pairing.${SOCIAL_DEVICE_PAIRINGS})`) }),
  t("device_pairings", "identity", ["id"], [
    c("id", "text"), c("participant_id", "text"), c("issued_by_session_id", "text"), c("secret_hash", "bytes"),
    c("consent_version", "text"), c("transport_consent_version", "text"), c("state", "text"),
    c("issued_at", "instant"), c("expires_at", "instant"), c("consumed_at", "instant"),
    c("revoked_at", "instant"), c("claimed_device_id", "text"),
  ], { selection: referenced("referenced-by-device-credentials", SOCIAL_DEVICE_PAIRINGS) }),
  t("accountless_enrollment_ledger", "identity", ["device_id"], [
    c("device_id", "text"), c("device_secret_hash", "bytes"), c("installation_principal_id", "text"),
    c("schema_version", "text"), c("policy_version", "text"), c("authorization_basis", "text"),
    c("state", "text"), c("issued_at", "instant"), c("expires_at", "instant"), c("revoked_at", "instant"),
    c("revocation_reason", "text"), c("renewal_generation", "int"), c("renewed_at", "instant"),
  ]),
  t("device_credentials", "identity", ["id"], [
    c("id", "text"), c("participant_id", "text"), c("authority_kind", "text"),
    c("paired_via_pairing_id", "text"), c("accountless_enrollment_device_id", "text"),
    c("secret_hash", "bytes"), c("state", "text"), c("issued_at", "instant"), c("expires_at", "instant"),
    c("last_used_at", "instant"), c("revoked_at", "instant"), c("social_verified_at", "instant"),
    c("credential_generation", "int"),
  ]),
  t("storage_v11_owner_links", "identity", ["participant_id"], [
    c("participant_id", "text"), c("owner_digest", "text"), c("state", "text"), c("generation_id", "text"),
    c("head_revision", "int"), c("object_digest", "text"), c("manifest_digest", "text"),
  ]),
  t("community_analytical_input_versions", "identity", ["participant_id"], [
    c("participant_id", "text"), c("revision", "int"),
  ]),
  t("accountless_upload_owners", "accountless", ["enrollment_device_id"], [
    c("enrollment_device_id", "text"), c("participant_id", "text"), c("device_credential_id", "text"),
    c("policy_version", "text"), c("authorization_basis", "text"), c("authorized_at", "instant"),
    c("expires_at", "instant"), c("state", "text"), c("revoked_at", "instant"), c("revocation_reason", "text"),
  ]),
  t("accountless_v11_device_authorizations", "accountless", ["enrollment_device_id"], [
    c("enrollment_device_id", "text"), c("participant_id", "text"), c("device_credential_id", "text"),
    c("telemetry_schema_version", "text"), c("field_dictionary_version", "text"),
    c("privacy_contract_version", "text"), c("authorized_at", "instant"), c("expires_at", "instant"),
    c("state", "text"), c("revoked_at", "instant"), c("revocation_reason", "text"),
  ]),
  t("accountless_v12_device_authorizations", "v12-grants", ["enrollment_device_id"], [
    c("enrollment_device_id", "text"), c("participant_id", "text"), c("device_credential_id", "text"),
    c("schema_version", "text"), c("policy_version", "text"), c("authorization_basis", "text"),
    c("telemetry_schema_version", "text"), c("field_dictionary_version", "text"),
    c("privacy_contract_version", "text"), c("authorized_at", "instant"), c("expires_at", "instant"),
    c("state", "text"), c("revoked_at", "instant"), c("revocation_reason", "text"),
  ]),
  t("telemetry_v12_device_capabilities", "v12-grants", ["participant_id", "device_id"], [
    c("participant_id", "text"), c("device_id", "text"), c("telemetry_schema_version", "text"),
    c("field_dictionary_version", "text"), c("privacy_contract_version", "text"), c("state", "text"),
    c("consented_at", "instant"), c("revoked_at", "instant"),
  ]),
  t("telemetry_v1_device_consents", "consents", ["participant_id", "device_id"], [
    c("participant_id", "text"), c("device_id", "text"), c("telemetry_schema_version", "text"),
    c("field_dictionary_version", "text"), c("privacy_contract_version", "text"), c("consented_at", "instant"),
  ]),
  t("telemetry_v11_device_consents", "consents", ["participant_id", "device_id"], [
    c("participant_id", "text"), c("device_id", "text"), c("telemetry_schema_version", "text"),
    c("field_dictionary_version", "text"), c("privacy_contract_version", "text"), c("consented_at", "instant"),
  ]),
  // Eligibility evidence for accountless v1.1 owners: community_public_source_owners
  // requires an accepted v1.1 head whose domain names the device. Only the
  // head chain is copied (heads, their domains, those domains' predecessor
  // tokens); domain days, manifests and chunks stay with a v1.1 transport
  // importer, which does not exist yet (IN-2 is live PostgreSQL intake, not
  // a D1 import). See the header for the run order once it does.
  t("telemetry_v11_domain_predecessors", "v11-domain-heads", ["token_hash"], [
    c("token_hash", "text"), c("participant_id", "text"), c("device_id", "text"),
    c("previous_generation_id", "text"), c("legacy_fingerprint", "text"), c("input_revision", "int"),
    c("from_day", "day"), c("through_day", "day"), c("winners_json", "text"), c("created_at", "instant"),
    c("expires_at", "instant"), c("consumed_at", "instant"),
  ], { selection: referenced("referenced-by-head-domains",
    `token_hash IN (SELECT domain.predecessor_token_hash FROM telemetry_v11_domains domain WHERE domain.${HEAD_DOMAINS})`) }),
  t("telemetry_v11_domains", "v11-domain-heads", ["id"], [
    c("id", "text"), c("participant_id", "text"), c("device_id", "text"), c("predecessor_token_hash", "text"),
    c("previous_generation_id", "text"), c("manifest_digest", "text"), c("legacy_fingerprint", "text"),
    c("input_revision", "int"), c("from_day", "day"), c("through_day", "day"), c("days_json", "text"),
    c("created_at", "instant"),
  ], { selection: referenced("referenced-by-domain-heads", HEAD_DOMAINS) }),
  t("telemetry_v11_domain_heads", "v11-domain-heads", ["participant_id"], [
    c("participant_id", "text"), c("generation_id", "text"), c("revision", "int"), c("updated_at", "instant"),
  ]),
  t("accountless_public_history_retention", "accountless", ["participant_id"], [
    c("participant_id", "text"), c("enrollment_device_id", "text"), c("device_credential_id", "text"),
    c("generation_id", "text"), c("head_revision", "int"), c("retained_at", "instant"),
  ]),
  t("collection_controls", "controls", ["singleton"], [
    c("singleton", "int"), c("revision", "int"), c("control_state", "text"),
    c("enrollment_enabled", "bool01"), c("upload_registration_enabled", "bool01"),
    c("processing_enabled", "bool01"), c("publication_enabled", "bool01"), c("reason_code", "text"),
    c("updated_at", "instant"),
  ], {
    seeded: true,
    omitted: { schema_version: "d1-schema-marker-verified-constant" },
    verifiedConstants: { schema_version: "collection-controls-v0.1" },
  }),
  // PostgreSQL ports no bootstrap walk: a completed D1 row is written with
  // empty cursors and a started, unfinished walk is refused (see
  // COMPLETED_WALK_CURSORS_CLEARED).
  t("community_public_source_bootstrap", "controls", ["singleton"], [
    c("singleton", "int"), c("policy_version", "text"), c("participant_cursor", "text"),
    c("source_day_cursor", "text"), c("completed", "int"),
  ], { seeded: true, sourceRowRule: COMPLETED_WALK_CURSORS_CLEARED }),
  // Staged exactly as postgres-usage-correction-transfer.mjs stages it:
  // PostgreSQL keeps state 'staged' (its default) and records D1's state.
  t("telemetry_usage_correction_runtime", "usage-correction-runtime", ["id"], [
    c("id", "int"), c("schema_version", "text"), c("method_version", "text"), c("state", "text", "source_state"),
    c("max_capture_rows", "int"), c("max_history_page", "int"),
  ]),
]);

const TABLE_BY_NAME = new Map(TABLES.map(spec => [spec.name, spec]));

/** Families another importer may own; omitting one keeps FK closure intact. */
export const POSTGRES_FASTPATH_IDENTITY_OMITTABLE_FAMILIES = Object.freeze([
  "v12-grants", "v11-domain-heads", "usage-correction-runtime",
]);

/** Tables deliberately not copied, with the owner that supplies them. */
export const POSTGRES_FASTPATH_IDENTITY_EXCLUDED_TABLES = Object.freeze({
  storage_owner_revisions: "derived-by:ingestion-journal-importer (primary 0046 refuses heads without exact journal rows)",
  storage_source_state: "claimed-by:ingestion-journal-importer",
  telemetry_v12_runtime: "claimed-by:T-2 v1.2 importer",
  telemetry_usage_correction_history: "claimed-by:usage-correction-importer",
  telemetry_usage_correction_facts: "claimed-by:usage-correction-importer",
  telemetry_transport_participant_floors: "trigger-derived-not-created",
  telemetry_transport_device_floors: "trigger-derived-not-created",
  attribution_enrollments: "trigger-derived-not-created",
  telemetry_performance_device_capabilities: "no-postgresql-table-at-promoted-level (PF-1 unpromoted)",
  accountless_telemetry_performance_authorizations: "no-postgresql-table-at-promoted-level (PF-1 unpromoted)",
});

for (const spec of TABLES) {
  if (spec.seeded && !SEEDED_SINGLETONS.some(entry => entry.role === "primary" && entry.table === spec.name)) {
    throw new TypeError("fastpath identity seeded table is not a registered seeded singleton");
  }
}

/** The frozen allowlist: table, family, key, selection, [source, target, type] columns, omissions. */
export const POSTGRES_FASTPATH_IDENTITY_ALLOWLIST = Object.freeze(TABLES.map(spec => Object.freeze({
  table: spec.name,
  family: spec.family,
  key: spec.key,
  selection: spec.selection.id,
  seeded: spec.seeded,
  columns: Object.freeze(spec.columns.map(column => Object.freeze([column.source, column.target, column.type]))),
  omittedSourceColumns: Object.freeze(Object.keys(spec.omitted).sort()),
  sourceRowRule: spec.sourceRowRule?.id ?? null,
})));

/** sha256 of the canonical allowlist; a reviewed change must update its pin. */
export function fastpathIdentityAllowlistSha256() {
  return sha256Hex(JSON.stringify([POSTGRES_FASTPATH_IDENTITY_COPY_SCHEMA, POSTGRES_FASTPATH_IDENTITY_ALLOWLIST]));
}

// ---------------------------------------------------------------------------
// Rehearsal transport copy (Q-2). No importer in the rehearsal chain writes
// the v1/v1.1 transport and admission tables the analytics-v2 occurrence
// adapter joins (see the header), nor the journal's event-source tables
// readQueuedDays resolves. These two parts copy exactly those relations from
// the same sealed source, with the same engine and guarantees as the identity
// copy (one transaction, emptiness, triggers suppressed, foreign keys and
// digests re-checked). They are rehearsal-only; production transport import
// is separate work.
//
//   "legacy-transport"   after the typed-legacy transfer (its typed records,
//                        chunks and manifests are foreign-key parents) and
//                        BEFORE T-2, which then inserts the v1.2 upload
//                        authorizations next to these;
//   "v12-event-sources"  after T-2 (telemetry_v12_domains is the parent).

const LEGACY_CHUNK_AUTHORIZATIONS = "id IN (SELECT chunk.device_upload_authorization_id FROM telemetry_v1_chunks chunk UNION SELECT chunk.device_upload_authorization_id FROM telemetry_v11_chunks chunk)";

function allocationColumns() {
  return [
    c("chunk_id", "text"), c("namespace_id", "int"), c("chunk_original", "bytes"),
    c("first_source_row_id", "int"), c("record_count", "int"),
  ];
}

function admissionStateColumns() {
  return [
    c("id", "int"), c("source_namespace", "text"), c("namespace_id", "int"),
    c("runtime_contract_version", "int"), c("next_source_row_id", "int"),
  ];
}

const TRANSPORT_PARTS = Object.freeze({
  "legacy-transport": Object.freeze([
    t("typed_v1_admission_state", "legacy-transport", ["id"], admissionStateColumns()),
    t("typed_v11_admission_state", "legacy-transport", ["id"], admissionStateColumns()),
    t("device_upload_authorizations", "legacy-transport", ["id"], [
      c("id", "text"), c("participant_id", "text"), c("issued_by_device_id", "text"), c("secret_hash", "bytes"),
      c("envelope_digest", "text"), c("body_bytes", "int"), c("content_type", "text"), c("state", "text"),
      c("issued_at", "instant"), c("expires_at", "instant"), c("consumed_at", "instant"), c("revoked_at", "instant"),
      c("consume_lease_expires_at", "instant"), c("consumed_contribution_id", "text"),
    ], { selection: referenced("referenced-by-v1-and-v1.1-chunks", LEGACY_CHUNK_AUTHORIZATIONS) }),
    t("telemetry_v1_chunks", "legacy-transport", ["id"], [
      c("id", "text"), c("participant_id", "text"), c("device_id", "text"), c("stream", "text"), c("chunk_day", "day"),
      c("chunk_seq", "int"), c("revision", "int"), c("chunk_digest", "text"), c("envelope_digest", "text"),
      c("parser_version", "text"), c("record_count", "int"), c("accepted_record_count", "int"), c("r2_key", "text"),
      c("device_upload_authorization_id", "text"), c("superseded_at", "instant"),
      c("quarantine_deleted_at", "instant"), c("created_at", "instant"),
    ]),
    t("typed_v1_chunk_allocations", "legacy-transport", ["chunk_id"], allocationColumns()),
    t("typed_v1_record_admissions", "legacy-transport", ["typed_record_id"], [
      c("typed_record_id", "int"), c("chunk_id", "text"),
    ]),
    t("typed_v1_event_sources", "legacy-transport", ["event_digest"], [
      c("event_digest", "text"), c("owner_digest", "text"), c("participant_id", "text"), c("chunk_id", "text"),
      c("source_namespace", "text"),
    ]),
    t("telemetry_v11_day_manifests", "legacy-transport", ["id"], [
      c("id", "text"), c("participant_id", "text"), c("device_id", "text"), c("chunk_day", "day"),
      c("manifest_digest", "text"), c("parser_version", "text"), c("manifest_json", "text"),
      c("expected_chunk_count", "int"), c("state", "text"), c("created_at", "instant"), c("ready_at", "instant"),
    ]),
    t("telemetry_v11_chunks", "legacy-transport", ["id"], [
      c("id", "text"), c("manifest_id", "text"), c("participant_id", "text"), c("device_id", "text"),
      c("stream", "text"), c("chunk_day", "day"), c("chunk_seq", "int"), c("chunk_id", "text"),
      c("chunk_digest", "text"), c("envelope_digest", "text"), c("parser_version", "text"), c("record_count", "int"),
      c("r2_key", "text"), c("device_upload_authorization_id", "text"), c("quarantine_deleted_at", "instant"),
      c("created_at", "instant"),
    ]),
    t("telemetry_v11_domain_days", "legacy-transport", ["generation_id", "observed_day"], [
      c("generation_id", "text"), c("observed_day", "day"), c("manifest_id", "text"),
    ]),
    t("typed_v11_chunk_allocations", "legacy-transport", ["chunk_id"], allocationColumns()),
    t("typed_v11_manifest_memberships", "legacy-transport", ["manifest_id"], [
      c("manifest_id", "text"), c("typed_manifest_id", "int"),
    ]),
    t("typed_v11_record_proofs", "legacy-transport", ["typed_record_id"], [
      c("typed_record_id", "int"), c("chunk_key", "int"), c("manifest_key", "int"), c("stream_code", "int"),
      c("occurrence_blob", "bytes"), c("base_digest", "bytes"), c("legacy_occurrence_blob", "bytes"),
      c("legacy_digest", "bytes"), c("observed_at_ms", "int"),
    ], {
      // D1 derives these VIRTUAL columns from stream_code and the blobs;
      // PostgreSQL stores only the inputs.
      omitted: {
        stream: "d1-generated-from-stream-code",
        occurrence_id: "d1-generated-from-occurrence-blob",
        legacy_occurrence_id: "d1-generated-from-legacy-occurrence-blob",
      },
    }),
    t("storage_v11_event_sources", "legacy-transport", ["event_digest"], [
      c("event_digest", "text"), c("owner_digest", "text"), c("participant_id", "text"), c("device_id", "text"),
      c("generation_id", "text"), c("manifest_digest", "text"), c("from_day", "day"), c("through_day", "day"),
      c("head_revision", "int"), c("input_revision", "int"), c("recorded_ms", "int"),
    ]),
  ]),
  "v12-event-sources": Object.freeze([
    t("storage_v12_event_sources", "v12-event-sources", ["event_digest"], [
      c("event_digest", "text"), c("owner_digest", "text"), c("participant_id", "text"), c("device_id", "text"),
      c("generation_id", "text"), c("previous_generation_id", "text"), c("manifest_digest", "text"),
      c("head_revision", "int"), c("recorded_ms", "int"),
    ]),
  ]),
});

export const POSTGRES_FASTPATH_TRANSPORT_COPY_SCHEMA = "postgres-fastpath-transport-copy-v1";
export const POSTGRES_FASTPATH_TRANSPORT_PARTS = Object.freeze(Object.keys(TRANSPORT_PARTS));

/** The frozen transport allowlist, in the identity allowlist's shape. */
export const POSTGRES_FASTPATH_TRANSPORT_ALLOWLIST = Object.freeze(Object.fromEntries(
  Object.entries(TRANSPORT_PARTS).map(([part, tables]) => [part, Object.freeze(tables.map(spec => Object.freeze({
    table: spec.name,
    key: spec.key,
    selection: spec.selection.id,
    columns: Object.freeze(spec.columns.map(column => Object.freeze([column.source, column.target, column.type]))),
    omittedSourceColumns: Object.freeze(Object.keys(spec.omitted).sort()),
  })))]),
));

/** sha256 of the canonical transport allowlist; a reviewed change must update its pin. */
export function fastpathTransportAllowlistSha256() {
  return sha256Hex(JSON.stringify([POSTGRES_FASTPATH_TRANSPORT_COPY_SCHEMA, POSTGRES_FASTPATH_TRANSPORT_ALLOWLIST]));
}

// ---------------------------------------------------------------------------
// Errors.

export class PostgresFastpathIdentityCopyError extends Error {
  constructor(code, details = undefined) {
    const safe = {};
    if (details && typeof details === "object") {
      for (const key of ["table", "column"]) {
        if (typeof details[key] === "string" && IDENTIFIER.test(details[key])) safe[key] = details[key];
      }
      if (typeof details.sqlState === "string" && SQLSTATE.test(details.sqlState)) safe.sqlState = details.sqlState;
    }
    const suffix = Object.entries(safe).map(([key, value]) => `${key}=${value}`).join(" ");
    super(suffix ? `${code} [${suffix}]` : code);
    this.name = "PostgresFastpathIdentityCopyError";
    this.code = code;
    Object.assign(this, safe);
  }
}

function fail(code, details = undefined) {
  throw new PostgresFastpathIdentityCopyError(code, details);
}

function sqlStateOf(error) {
  return typeof error?.code === "string" && SQLSTATE.test(error.code) ? error.code : undefined;
}

async function q(client, text, values, code, details = undefined) {
  try {
    return await client.query(text, values);
  } catch (error) {
    if (error instanceof PostgresFastpathIdentityCopyError) throw error;
    fail(code, { ...details, sqlState: sqlStateOf(error) });
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function quote(name) {
  if (typeof name !== "string" || !IDENTIFIER.test(name)) fail("FASTPATH_IDENTITY_IDENTIFIER_INVALID");
  return `"${name}"`;
}

function relation(schema, table) {
  return `${quote(schema)}.${quote(table)}`;
}

// ---------------------------------------------------------------------------
// Canonical values. Source and target rows are both reduced to arrays of
// canonical values in target-column order, so their digests compare directly.

function canonicalInstant(value, table, column) {
  const match = typeof value === "string" ? SOURCE_INSTANT.exec(value) : null;
  if (!match) fail("FASTPATH_IDENTITY_INSTANT_INVALID", { table, column });
  const millis = (match[7] ?? "").padEnd(3, "0");
  const rendered = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${millis}Z`;
  const epoch = Date.parse(rendered);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== rendered) {
    fail("FASTPATH_IDENTITY_INSTANT_INVALID", { table, column });
  }
  return rendered;
}

function canonicalDay(value, table, column) {
  const match = typeof value === "string" ? DAY.exec(value) : null;
  if (!match) fail("FASTPATH_IDENTITY_DAY_INVALID", { table, column });
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) {
    fail("FASTPATH_IDENTITY_DAY_INVALID", { table, column });
  }
  return value;
}

function sourceInteger(value, table, column) {
  let parsed;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else fail("FASTPATH_IDENTITY_VALUE_INVALID", { table, column });
  if (parsed < -(2n ** 63n) || parsed >= 2n ** 63n) fail("FASTPATH_IDENTITY_VALUE_INVALID", { table, column });
  return parsed.toString();
}

/** Returns [canonical, parameter] for one source cell. */
function fromSource(type, value, table, column) {
  if (value === null || value === undefined) return [null, null];
  switch (type) {
    case "text":
      if (typeof value !== "string" || value.includes("\0")) fail("FASTPATH_IDENTITY_VALUE_INVALID", { table, column });
      return [value, value];
    case "int": {
      const text = sourceInteger(value, table, column);
      return [text, text];
    }
    case "bool01": {
      const text = sourceInteger(value, table, column);
      if (text !== "0" && text !== "1") fail("FASTPATH_IDENTITY_VALUE_INVALID", { table, column });
      return [text === "1", text === "1"];
    }
    case "bytes": {
      if (!(value instanceof Uint8Array)) fail("FASTPATH_IDENTITY_VALUE_INVALID", { table, column });
      const buffer = Buffer.from(value);
      return [buffer.toString("hex"), buffer];
    }
    case "instant": {
      const instant = canonicalInstant(value, table, column);
      return [instant, instant];
    }
    case "day": {
      const day = canonicalDay(value, table, column);
      return [day, day];
    }
    default:
      return fail("FASTPATH_IDENTITY_DEFINITION_INVALID", { table, column });
  }
}

function targetExpression(column) {
  const name = quote(column.target);
  switch (column.type) {
    case "int": return `${name}::text`;
    case "bytes": return `encode(${name}, 'hex')`;
    case "instant": return `to_char(${name} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    case "day": return `to_char(${name}, 'YYYY-MM-DD')`;
    default: return name;
  }
}

function fromTarget(type, value, table, column) {
  if (value === null || value === undefined) return null;
  if (type === "bool01") {
    if (typeof value !== "boolean") fail("FASTPATH_IDENTITY_TARGET_VALUE_INVALID", { table, column });
    return value;
  }
  if (typeof value !== "string") fail("FASTPATH_IDENTITY_TARGET_VALUE_INVALID", { table, column });
  return value;
}

function compareKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedDigest(spec, rows) {
  const keyIndexes = spec.key.map(key => spec.columns.findIndex(column => column.target === key));
  const keyed = rows.map(row => [JSON.stringify(keyIndexes.map(index => row[index])), row]);
  keyed.sort((left, right) => compareKeys(left[0], right[0]));
  for (let index = 1; index < keyed.length; index += 1) {
    if (keyed[index][0] === keyed[index - 1][0]) fail("FASTPATH_IDENTITY_KEY_DUPLICATE", { table: spec.name });
  }
  const hash = createHash("sha256");
  hash.update(`${POSTGRES_FASTPATH_IDENTITY_COPY_SCHEMA}\n${spec.name}\n`);
  for (const [, row] of keyed) hash.update(`${JSON.stringify(row)}\n`);
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Sealed SQLite source.

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function assertNoSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(path + suffix);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      fail("FASTPATH_IDENTITY_SOURCE_UNAVAILABLE");
    }
    fail("FASTPATH_IDENTITY_SOURCE_SIDECAR_PRESENT");
  }
}

async function sealedFingerprint(path) {
  let handle;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || await realpath(path) !== path) {
      fail("FASTPATH_IDENTITY_SOURCE_PATH_INVALID");
    }
    await assertNoSidecars(path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || typeof process.getuid !== "function" || before.uid !== process.getuid()
        || (before.mode & 0o222) !== 0 || before.size <= 0 || before.size > MAX_SEALED_SQLITE_BYTES) {
      fail("FASTPATH_IDENTITY_SOURCE_UNSAFE");
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened)) fail("FASTPATH_IDENTITY_SOURCE_CHANGED");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, opened.size - offset), offset);
      if (bytesRead <= 0) fail("FASTPATH_IDENTITY_SOURCE_CHANGED");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after)) fail("FASTPATH_IDENTITY_SOURCE_CHANGED");
    await assertNoSidecars(path);
    return Object.freeze({ sha256: hash.digest("hex"), stat: opened });
  } catch (error) {
    if (error instanceof PostgresFastpathIdentityCopyError) throw error;
    return fail("FASTPATH_IDENTITY_SOURCE_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Open a sealed SQLite rebuild of the d43c8f92 USAGE_MONITOR_DB (for example
 * the output of Q-1's gcp-fastpath-oracle-sqlite.mjs). The file must be
 * absolute, owner-owned, single-link, without write bits or sidecars, and its
 * bytes must hash to expectedSha256 before and after every read.
 */
export async function openSealedFastpathIdentitySource({ path, expectedSha256 } = {}) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) fail("FASTPATH_IDENTITY_NODE_UNSUPPORTED");
  if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) fail("FASTPATH_IDENTITY_SOURCE_SHA256_REQUIRED");
  const initial = await sealedFingerprint(path);
  if (initial.sha256 !== expectedSha256) fail("FASTPATH_IDENTITY_SOURCE_SHA256_MISMATCH");
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA query_only=ON");
    if (database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal") fail("FASTPATH_IDENTITY_SOURCE_SIDECAR_PRESENT");
    if (database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") fail("FASTPATH_IDENTITY_SOURCE_INTEGRITY_FAILED");
  } catch (error) {
    database?.close();
    if (error instanceof PostgresFastpathIdentityCopyError) throw error;
    fail("FASTPATH_IDENTITY_SOURCE_INVALID");
  }
  let closed = false;
  const source = Object.freeze({
    snapshot: Object.freeze({ kind: "sealed-sqlite-rehearsal", artifactSha256: expectedSha256 }),
    database() {
      if (closed) fail("FASTPATH_IDENTITY_SOURCE_CLOSED");
      return database;
    },
    async verifySnapshot() {
      if (closed) fail("FASTPATH_IDENTITY_SOURCE_CLOSED");
      const actual = await sealedFingerprint(path);
      if (actual.sha256 !== expectedSha256 || !sameFileIdentity(initial.stat, actual.stat)) {
        fail("FASTPATH_IDENTITY_SOURCE_CHANGED");
      }
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  });
  TRUSTED_SOURCES.add(source);
  return source;
}

function trustedSource(source) {
  if (!source || !TRUSTED_SOURCES.has(source)) fail("FASTPATH_IDENTITY_SOURCE_REQUIRED");
  return source;
}

function sourceAll(database, sql, table, parameters = []) {
  try {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all(...parameters);
  } catch {
    return fail("FASTPATH_IDENTITY_SOURCE_READ_FAILED", { table });
  }
}

function sourceColumns(database, table) {
  const present = sourceAll(database, "SELECT type FROM sqlite_master WHERE name = ?", table, [table]);
  if (present.length !== 1 || present[0].type !== "table") fail("FASTPATH_IDENTITY_SOURCE_TABLE_MISSING", { table });
  return sourceAll(database, `PRAGMA table_xinfo(${quote(table)})`, table);
}

/** Check the source layout of one table against the allowlist. */
function assertSourceLayout(database, spec) {
  const columns = sourceColumns(database, spec.name);
  const names = new Set(columns.map(column => column.name));
  for (const column of spec.columns) {
    if (!names.has(column.source)) fail("FASTPATH_IDENTITY_SOURCE_COLUMN_MISSING", { table: spec.name, column: column.source });
  }
  const allowlisted = new Set(spec.columns.map(column => column.source));
  const unknownNullable = [];
  for (const column of columns) {
    if (allowlisted.has(column.name) || Object.hasOwn(spec.omitted, column.name)) continue;
    if (Number(column.notnull) === 1 || Number(column.pk) > 0) {
      fail("FASTPATH_IDENTITY_SOURCE_COLUMN_UNKNOWN", { table: spec.name, column: IDENTIFIER.test(column.name) ? column.name : undefined });
    }
    unknownNullable.push(String(column.name));
  }
  return unknownNullable.sort();
}

function readSourceTable(database, spec) {
  const where = spec.selection.where === null ? "" : ` WHERE ${spec.selection.where}`;
  const [{ total }] = sourceAll(database, `SELECT count(*) AS total FROM ${quote(spec.name)}`, spec.name);
  const [{ selected }] = sourceAll(database, `SELECT count(*) AS selected FROM ${quote(spec.name)}${where}`, spec.name);
  if (BigInt(selected) > BigInt(POSTGRES_FASTPATH_IDENTITY_MAX_TABLE_ROWS)) fail("FASTPATH_IDENTITY_SOURCE_TOO_LARGE", { table: spec.name });
  for (const [column, expected] of Object.entries(spec.verifiedConstants)) {
    const rows = sourceAll(database, `SELECT count(*) AS n FROM ${quote(spec.name)} WHERE ${quote(column)} IS NOT ?`,
      spec.name, [expected]);
    if (BigInt(rows[0].n) !== 0n) fail("FASTPATH_IDENTITY_SOURCE_CONSTANT_MISMATCH", { table: spec.name, column });
  }
  const list = spec.columns.map(column => quote(column.source)).join(", ");
  const raw = sourceAll(database, `SELECT ${list} FROM ${quote(spec.name)}${where}`, spec.name);
  if (BigInt(raw.length) !== BigInt(selected)) fail("FASTPATH_IDENTITY_SOURCE_READ_FAILED", { table: spec.name });
  const canonical = [];
  const parameters = [];
  let rowsRewritten = 0;
  for (const sourceRow of raw) {
    let row = sourceRow;
    if (spec.sourceRowRule !== null) {
      const [ruled, rewritten] = spec.sourceRowRule.apply(sourceRow, spec.name);
      row = ruled;
      if (rewritten) rowsRewritten += 1;
    }
    const values = [];
    const params = [];
    for (const column of spec.columns) {
      const [value, parameter] = fromSource(column.type, row[column.source], spec.name, column.source);
      values.push(value);
      params.push(parameter);
    }
    canonical.push(values);
    parameters.push(params);
  }
  return Object.freeze({
    totalRows: Number(total),
    rows: canonical,
    parameters,
    rowsRewritten,
    // The digest of the rows as written: after the table's source row rule.
    sha256: sortedDigest(spec, canonical),
  });
}

function publicSourceOwnerDigest(rows) {
  const canonical = rows.map(row => [row.participant_id, row.owner_kind, row.device_id ?? null]);
  for (const row of canonical) {
    if (row.some((value, index) => !(typeof value === "string" || (index === 2 && value === null)))) {
      fail("FASTPATH_IDENTITY_PUBLIC_SOURCE_OWNERS_INVALID");
    }
  }
  const lines = canonical.map(row => JSON.stringify(row)).sort(compareKeys);
  return Object.freeze({
    rows: lines.length,
    participants: new Set(canonical.map(row => row[0])).size,
    sha256: sha256Hex(`community_public_source_owners\n${lines.join("\n")}`),
    lines,
  });
}

function readSourcePublicOwners(database) {
  const present = sourceAll(database, "SELECT type FROM sqlite_master WHERE name = 'community_public_source_owners'",
    "community_public_source_owners");
  if (present.length !== 1 || present[0].type !== "view") fail("FASTPATH_IDENTITY_SOURCE_VIEW_MISSING");
  return publicSourceOwnerDigest(sourceAll(database,
    "SELECT participant_id, owner_kind, device_id FROM community_public_source_owners", "community_public_source_owners"));
}

// ---------------------------------------------------------------------------
// Target checks.

function validateTargetSchema(schema) {
  if (typeof schema !== "string" || !IDENTIFIER.test(schema)
      || !schema.startsWith(POSTGRES_FASTPATH_IDENTITY_TARGET_SCHEMA_PREFIX)
      || !TARGET_SUFFIX.test(schema.slice(POSTGRES_FASTPATH_IDENTITY_TARGET_SCHEMA_PREFIX.length))) {
    fail("FASTPATH_IDENTITY_TARGET_SCHEMA_REFUSED");
  }
  return schema;
}

async function assertPostgres17(client) {
  const result = await q(client, "SELECT current_setting('server_version_num') AS version", [],
    "FASTPATH_IDENTITY_TARGET_QUERY_FAILED");
  const version = Number(result.rows?.[0]?.version);
  if (!Number.isSafeInteger(version) || Math.floor(version / 10_000) !== 17) fail("FASTPATH_IDENTITY_POSTGRES_17_REQUIRED");
  return version;
}

async function assertPromotedMigrations(client, schema, migrationsRoot) {
  let expected;
  try {
    expected = await readPostgresMigrations(migrationsRoot === undefined
      ? { role: "primary" } : { role: "primary", rootDirectory: migrationsRoot });
  } catch {
    fail("FASTPATH_IDENTITY_MIGRATIONS_UNAVAILABLE");
  }
  const present = await q(client, "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${quote(schema)}.${quote(HISTORY_TABLE)}`], "FASTPATH_IDENTITY_TARGET_QUERY_FAILED");
  if (present.rows?.[0]?.present !== true) fail("FASTPATH_IDENTITY_TARGET_MIGRATION_LEVEL_INVALID");
  // Order by the numeric column itself: an aliased ::text cast would sort
  // "10" before "2".
  const history = await q(client, `SELECT history.version::text AS version, history.name, history.checksum_sha256
    FROM ${relation(schema, HISTORY_TABLE)} history ORDER BY history.version`, [], "FASTPATH_IDENTITY_TARGET_QUERY_FAILED");
  if (history.rows.length !== expected.length) fail("FASTPATH_IDENTITY_TARGET_MIGRATION_LEVEL_INVALID");
  history.rows.forEach((row, index) => {
    const migration = expected[index];
    if (Number(row.version) !== migration.version || row.name !== migration.name
        || row.checksum_sha256 !== migration.sha256) {
      fail("FASTPATH_IDENTITY_TARGET_MIGRATION_LEVEL_INVALID");
    }
  });
  return expected.at(-1)?.name ?? null;
}

async function assertTargetLayout(client, schema, spec) {
  const result = await q(client, `SELECT column_name, data_type, is_nullable, column_default, is_generated, is_identity
      FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
  [schema, spec.name], "FASTPATH_IDENTITY_TARGET_QUERY_FAILED", { table: spec.name });
  if (result.rows.length === 0) fail("FASTPATH_IDENTITY_TARGET_TABLE_MISSING", { table: spec.name });
  const byName = new Map(result.rows.map(row => [row.column_name, row]));
  for (const column of spec.columns) {
    const row = byName.get(column.target);
    if (!row || !TARGET_TYPES[column.type].includes(row.data_type) || row.is_generated === "ALWAYS") {
      fail("FASTPATH_IDENTITY_TARGET_COLUMN_MISMATCH", { table: spec.name, column: column.target });
    }
  }
  const mapped = new Set(spec.columns.map(column => column.target));
  for (const row of result.rows) {
    if (mapped.has(row.column_name)) continue;
    if (row.is_nullable === "NO" && row.column_default === null && row.is_identity !== "YES") {
      fail("FASTPATH_IDENTITY_TARGET_COLUMN_UNMAPPED", { table: spec.name, column: IDENTIFIER.test(row.column_name) ? row.column_name : undefined });
    }
  }
}

function seedLimit(spec) {
  if (!spec.seeded) return 0;
  return SEEDED_SINGLETONS.find(entry => entry.role === "primary" && entry.table === spec.name)?.seedRows ?? 0;
}

async function assertTargetEmpty(client, schema, spec) {
  const limit = seedLimit(spec);
  const result = await q(client, `SELECT count(*)::text AS n FROM (
      SELECT 1 FROM ${relation(schema, spec.name)} LIMIT ${limit + 1}) sample`, [],
  "FASTPATH_IDENTITY_TARGET_QUERY_FAILED", { table: spec.name });
  if (Number(result.rows?.[0]?.n) > limit) fail("FASTPATH_IDENTITY_TARGET_NOT_EMPTY", { table: spec.name });
}

/**
 * Foreign keys stay enforced while rows are inserted (only user triggers are
 * suppressed), so a child row whose parent is missing fails its own write or
 * the deferred-constraint flush. Either reports the closed code of the
 * post-insert re-check, FASTPATH_IDENTITY_FOREIGN_KEY_UNSATISFIED, naming
 * the child table; any other refusal is a write failure with its SQLSTATE.
 */
async function checkedWrite(client, text, values, table = undefined) {
  try {
    return await client.query(text, values);
  } catch (error) {
    // Without a statement table (the flush), PostgreSQL's own error names it.
    const named = table ?? (typeof error?.table === "string" ? error.table : undefined);
    if (sqlStateOf(error) === "23503") fail("FASTPATH_IDENTITY_FOREIGN_KEY_UNSATISFIED", { table: named });
    return fail("FASTPATH_IDENTITY_TARGET_WRITE_FAILED", { table: named, sqlState: sqlStateOf(error) });
  }
}

async function insertRows(client, schema, spec, parameterRows) {
  const width = spec.columns.length;
  const batch = Math.max(1, Math.min(MAX_INSERT_ROWS, Math.floor(MAX_INSERT_PARAMETERS / width)));
  const list = spec.columns.map(column => quote(column.target)).join(", ");
  for (let start = 0; start < parameterRows.length; start += batch) {
    const page = parameterRows.slice(start, start + batch);
    const values = page.map((_, rowIndex) => `(${spec.columns.map((__, columnIndex) =>
      `$${rowIndex * width + columnIndex + 1}`).join(", ")})`).join(", ");
    await checkedWrite(client, `INSERT INTO ${relation(schema, spec.name)} (${list}) VALUES ${values}`, page.flat(),
      spec.name);
  }
}

async function readTargetTable(client, schema, spec) {
  const list = spec.columns.map(column => `${targetExpression(column)} AS ${quote(column.target)}`).join(", ");
  const result = await q(client, `SELECT ${list} FROM ${relation(schema, spec.name)}`, [],
    "FASTPATH_IDENTITY_TARGET_READ_FAILED", { table: spec.name });
  const rows = result.rows.map(row => spec.columns.map(column =>
    fromTarget(column.type, row[column.target], spec.name, column.target)));
  return Object.freeze({ rows: rows.length, sha256: sortedDigest(spec, rows) });
}

/** Every user (non-internal) trigger on the copied tables, with its tgenabled state. */
async function userTriggers(client, schema, tableNames) {
  const result = await q(client, `SELECT rel.relname::text AS table_name, trigger.tgname::text AS name,
        trigger.tgenabled::text AS enabled
      FROM pg_catalog.pg_trigger trigger
      JOIN pg_catalog.pg_class rel ON rel.oid = trigger.tgrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = rel.relnamespace
     WHERE namespace.nspname = $1 AND rel.relname = ANY($2::text[]) AND NOT trigger.tgisinternal
     ORDER BY rel.relname, trigger.tgname`, [schema, tableNames],
  "FASTPATH_IDENTITY_TARGET_QUERY_FAILED");
  return result.rows;
}

/**
 * Suppress every user row and statement trigger of the copied tables for
 * the inserts with ALTER TABLE ... DISABLE TRIGGER USER, which needs only
 * table ownership. (session_replication_role needs a superuser, and a
 * Cloud SQL migrator owns the tables without being one.) Every user trigger
 * must be enabled in origin mode ('O'), the state ENABLE TRIGGER USER
 * restores exactly and the only one session_replication_role = replica
 * would have suppressed; any other state is refused before a write.
 * Internally generated constraint triggers (foreign keys, deferrable unique
 * constraints) are never disabled, so the allowlist's foreign-key order is
 * enforced as rows are inserted, and assertForeignKeys still re-checks it.
 * The DDL is transactional: restoreRowTriggers re-enables the triggers
 * before COMMIT, and ROLLBACK (or a lost session) restores them.
 */
async function suppressRowTriggers(client, schema, tables) {
  const triggers = await userTriggers(client, schema, tables.map(spec => spec.name));
  const unexpected = triggers.find(trigger => trigger.enabled !== "O");
  if (unexpected !== undefined) fail("FASTPATH_IDENTITY_TRIGGER_STATE_UNEXPECTED", { table: unexpected.table_name });
  const names = [...new Set(triggers.map(trigger => trigger.table_name))];
  for (const name of names) {
    await q(client, `ALTER TABLE ${relation(schema, name)} DISABLE TRIGGER USER`, [],
      "FASTPATH_IDENTITY_TRIGGER_SUPPRESSION_REFUSED", { table: name });
  }
  return Object.freeze({
    tables: Object.freeze(names),
    triggers: Object.freeze(triggers.map(trigger => `${trigger.table_name}.${trigger.name}`)),
  });
}

/**
 * Fire every deferred constraint check the inserts queued (ALTER TABLE
 * refuses a table with pending trigger events), re-enable the suppressed
 * triggers and prove each one is back in origin mode.
 */
async function restoreRowTriggers(client, schema, suppressed) {
  await checkedWrite(client, "SET CONSTRAINTS ALL IMMEDIATE", []);
  for (const name of suppressed.tables) {
    await q(client, `ALTER TABLE ${relation(schema, name)} ENABLE TRIGGER USER`, [],
      "FASTPATH_IDENTITY_TRIGGER_RESTORE_FAILED", { table: name });
  }
  const restored = await userTriggers(client, schema, suppressed.tables);
  if (restored.length !== suppressed.triggers.length
      || restored.some((trigger, index) => trigger.enabled !== "O"
        || `${trigger.table_name}.${trigger.name}` !== suppressed.triggers[index])) {
    fail("FASTPATH_IDENTITY_TRIGGER_RESTORE_FAILED");
  }
}

/** Re-check every foreign key whose child is a copied table (MATCH SIMPLE). */
async function assertForeignKeys(client, schema, tables) {
  const constraints = await q(client, `SELECT con.conname::text AS name, child.relname::text AS child,
        parent_ns.nspname::text AS parent_schema, parent.relname::text AS parent,
        ARRAY(SELECT attribute.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord)
          JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = con.conrelid AND attribute.attnum = key.attnum
          ORDER BY key.ord) AS child_columns,
        ARRAY(SELECT attribute.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, ord)
          JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = con.confrelid AND attribute.attnum = key.attnum
          ORDER BY key.ord) AS parent_columns
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class child ON child.oid = con.conrelid
      JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_catalog.pg_class parent ON parent.oid = con.confrelid
      JOIN pg_catalog.pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
     WHERE con.contype = 'f' AND child_ns.nspname = $1 AND child.relname = ANY($2::text[])
     ORDER BY child.relname, con.conname`, [schema, tables.map(spec => spec.name)],
  "FASTPATH_IDENTITY_TARGET_QUERY_FAILED");
  let checked = 0;
  for (const row of constraints.rows) {
    if (row.parent_schema !== schema || row.child_columns.length === 0
        || row.child_columns.length !== row.parent_columns.length) {
      fail("FASTPATH_IDENTITY_FOREIGN_KEY_UNSUPPORTED", { table: row.child });
    }
    const notNull = row.child_columns.map(column => `child.${quote(column)} IS NOT NULL`).join(" AND ");
    const join = row.child_columns.map((column, index) =>
      `parent.${quote(row.parent_columns[index])} = child.${quote(column)}`).join(" AND ");
    const orphans = await q(client, `SELECT count(*)::text AS n FROM ${relation(schema, row.child)} child
       WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${relation(schema, row.parent)} parent WHERE ${join})`, [],
    "FASTPATH_IDENTITY_TARGET_QUERY_FAILED", { table: row.child });
    if (orphans.rows?.[0]?.n !== "0") fail("FASTPATH_IDENTITY_FOREIGN_KEY_UNSATISFIED", { table: row.child });
    checked += 1;
  }
  return checked;
}

async function readTargetPublicOwners(client, schema) {
  const result = await q(client, `SELECT participant_id, owner_kind, device_id
      FROM ${relation(schema, "community_public_source_owners")}`, [], "FASTPATH_IDENTITY_TARGET_READ_FAILED",
  { table: "community_public_source_owners" });
  return publicSourceOwnerDigest(result.rows);
}

function compareOwnerSets(source, target) {
  const sourceLines = new Set(source.lines);
  const targetLines = new Set(target.lines);
  return Object.freeze({
    sourceRows: source.rows,
    targetRows: target.rows,
    sourceParticipants: source.participants,
    targetParticipants: target.participants,
    sourceSha256: source.sha256,
    targetSha256: target.sha256,
    missingInTarget: source.lines.filter(line => !targetLines.has(line)).length,
    extraInTarget: target.lines.filter(line => !sourceLines.has(line)).length,
    equal: source.sha256 === target.sha256,
  });
}

function selectedTables(omitFamilies) {
  if (!Array.isArray(omitFamilies) || omitFamilies.some(family =>
    !POSTGRES_FASTPATH_IDENTITY_OMITTABLE_FAMILIES.includes(family))
      || new Set(omitFamilies).size !== omitFamilies.length) {
    fail("FASTPATH_IDENTITY_OMIT_FAMILY_INVALID");
  }
  return TABLES.filter(spec => !omitFamilies.includes(spec.family));
}

// ---------------------------------------------------------------------------
// The copy.

/**
 * Copy the identity/authority allowlist from a sealed source into a
 * migrated rehearsal schema in one transaction. Returns a content-free
 * receipt. `publicSourceOwnerParity` is "require" (default: the PostgreSQL
 * view must equal the source view before COMMIT) or "defer" (record both
 * digests; run compareFastpathPublicSourceOwners after T-2 supplies v1.2
 * heads for accountless v1.2 owners).
 */
export async function runPostgresFastpathIdentityCopy({
  source,
  pool,
  targetSchema,
  omitFamilies = [],
  publicSourceOwnerParity = "require",
  migrationsRoot = undefined,
} = {}) {
  const schema = validateTargetSchema(targetSchema);
  const trusted = trustedSource(source);
  if (!pool || typeof pool.connect !== "function") fail("FASTPATH_IDENTITY_TARGET_POOL_REQUIRED");
  if (publicSourceOwnerParity !== "require" && publicSourceOwnerParity !== "defer") {
    fail("FASTPATH_IDENTITY_PARITY_MODE_INVALID");
  }
  const tables = selectedTables(omitFamilies);
  await trusted.verifySnapshot();
  const database = trusted.database();
  const unknownNullableColumns = {};
  for (const spec of TABLES) {
    const unknown = assertSourceLayout(database, spec);
    if (unknown.length > 0) unknownNullableColumns[spec.name] = unknown;
  }
  const sourceTables = new Map(tables.map(spec => [spec.name, readSourceTable(database, spec)]));
  const sourcePublicOwners = readSourcePublicOwners(database);
  await trusted.verifySnapshot();

  const copied = await copyTablesInOneTransaction({
    trusted, pool, schema, tables, layoutTables: TABLES, sourceTables, migrationsRoot,
    async beforeCommit(client) {
      const publicOwners = compareOwnerSets(sourcePublicOwners, await readTargetPublicOwners(client, schema));
      if (publicSourceOwnerParity === "require" && !publicOwners.equal) {
        fail("FASTPATH_IDENTITY_PUBLIC_SOURCE_OWNERS_MISMATCH");
      }
      return publicOwners;
    },
  });
  return Object.freeze({
    schema: POSTGRES_FASTPATH_IDENTITY_COPY_SCHEMA,
    status: "rehearsal_identity_copy_complete",
    sourceCommit: POSTGRES_FASTPATH_IDENTITY_SOURCE_COMMIT,
    source: Object.freeze({ kind: trusted.snapshot.kind, artifactSha256: trusted.snapshot.artifactSha256 }),
    target: Object.freeze({
      schema, postgresMajor: Math.floor(copied.postgresVersion / 10_000), latestMigration: copied.latestMigration,
    }),
    allowlistSha256: fastpathIdentityAllowlistSha256(),
    tables: copied.tables,
    omittedFamilies: Object.freeze([...omitFamilies].sort()),
    excludedTables: POSTGRES_FASTPATH_IDENTITY_EXCLUDED_TABLES,
    unknownNullableColumnsOmitted: Object.freeze(unknownNullableColumns),
    foreignKeysChecked: copied.foreignKeysChecked,
    rowTriggersSuppressed: true,
    publicSourceOwners: Object.freeze({ mode: publicSourceOwnerParity, ...copied.beforeCommit }),
    capabilities: Object.freeze({
      rehearsalOnly: true,
      ownerRevisionsCopied: false,
      credentialsBeyondHashesCopied: false,
      productionCutoverAuthorized: false,
    }),
  });
}

/**
 * The shared copy transaction: emptiness re-check under table locks, inserts
 * with row triggers suppressed, an explicit foreign-key re-check with
 * triggers restored, per-table count and canonical-row digest parity, the
 * caller's beforeCommit check, then COMMIT. Any failure rolls back
 * everything.
 */
async function copyTablesInOneTransaction({
  trusted, pool, schema, tables, layoutTables, sourceTables, migrationsRoot, beforeCommit,
}) {
  let client;
  try {
    client = await pool.connect();
  } catch {
    fail("FASTPATH_IDENTITY_TARGET_CONNECT_FAILED");
  }
  let open = false;
  let discard = false;
  try {
    await q(client, "BEGIN", [], "FASTPATH_IDENTITY_TARGET_QUERY_FAILED");
    open = true;
    await q(client, `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MILLISECONDS}ms'`, [], "FASTPATH_IDENTITY_TARGET_QUERY_FAILED");
    await q(client, `SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MILLISECONDS}ms'`, [], "FASTPATH_IDENTITY_TARGET_QUERY_FAILED");
    const postgresVersion = await assertPostgres17(client);
    const latestMigration = await assertPromotedMigrations(client, schema, migrationsRoot);
    for (const spec of layoutTables) await assertTargetLayout(client, schema, spec);
    await q(client, `LOCK TABLE ${tables.map(spec => relation(schema, spec.name)).join(", ")} IN SHARE ROW EXCLUSIVE MODE`,
      [], "FASTPATH_IDENTITY_TARGET_LOCK_FAILED");
    for (const spec of tables) await assertTargetEmpty(client, schema, spec);

    const suppressed = await suppressRowTriggers(client, schema, tables);
    for (const spec of tables) {
      if (spec.seeded) {
        await q(client, `DELETE FROM ${relation(schema, spec.name)}`, [], "FASTPATH_IDENTITY_TARGET_WRITE_FAILED",
          { table: spec.name });
      }
      await insertRows(client, schema, spec, sourceTables.get(spec.name).parameters);
    }
    await restoreRowTriggers(client, schema, suppressed);

    const foreignKeysChecked = await assertForeignKeys(client, schema, tables);
    const receiptTables = {};
    for (const spec of tables) {
      const sourceTable = sourceTables.get(spec.name);
      const targetTable = await readTargetTable(client, schema, spec);
      if (targetTable.rows !== sourceTable.rows.length || targetTable.sha256 !== sourceTable.sha256) {
        fail("FASTPATH_IDENTITY_PARITY_FAILED", { table: spec.name });
      }
      receiptTables[spec.name] = Object.freeze({
        family: spec.family,
        selection: spec.selection.id,
        sourceTableRows: sourceTable.totalRows,
        sourceRows: sourceTable.rows.length,
        targetRows: targetTable.rows,
        sha256: targetTable.sha256,
        ...(spec.sourceRowRule === null ? {} : {
          sourceRowRule: Object.freeze({ id: spec.sourceRowRule.id, rowsRewritten: sourceTable.rowsRewritten }),
        }),
      });
    }
    const beforeCommitResult = await beforeCommit(client);
    await trusted.verifySnapshot();
    open = false;
    try {
      await client.query("COMMIT");
    } catch (error) {
      discard = true;
      fail("FASTPATH_IDENTITY_TARGET_COMMIT_FAILED", { sqlState: sqlStateOf(error) });
    }
    return Object.freeze({
      postgresVersion,
      latestMigration,
      tables: Object.freeze(receiptTables),
      foreignKeysChecked,
      beforeCommit: beforeCommitResult,
    });
  } catch (error) {
    if (open) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    }
    if (error instanceof PostgresFastpathIdentityCopyError) throw error;
    return fail("FASTPATH_IDENTITY_COPY_FAILED");
  } finally {
    try {
      client.release(discard ? true : undefined);
    } catch {
      // The connection is already unusable; the transaction outcome stands.
    }
  }
}

/**
 * Copy one rehearsal transport part (see TRANSPORT_PARTS) from the sealed
 * source into the rehearsal schema, in one transaction with the identity
 * copy's guarantees. Returns a content-free receipt.
 */
export async function runPostgresFastpathTransportCopy({
  source,
  pool,
  targetSchema,
  part,
  migrationsRoot = undefined,
} = {}) {
  const schema = validateTargetSchema(targetSchema);
  const trusted = trustedSource(source);
  if (!pool || typeof pool.connect !== "function") fail("FASTPATH_IDENTITY_TARGET_POOL_REQUIRED");
  if (typeof part !== "string" || !Object.hasOwn(TRANSPORT_PARTS, part)) fail("FASTPATH_TRANSPORT_PART_INVALID");
  const tables = TRANSPORT_PARTS[part];
  await trusted.verifySnapshot();
  const database = trusted.database();
  const unknownNullableColumns = {};
  for (const spec of tables) {
    const unknown = assertSourceLayout(database, spec);
    if (unknown.length > 0) unknownNullableColumns[spec.name] = unknown;
  }
  const sourceTables = new Map(tables.map(spec => [spec.name, readSourceTable(database, spec)]));
  await trusted.verifySnapshot();
  const copied = await copyTablesInOneTransaction({
    trusted, pool, schema, tables, layoutTables: tables, sourceTables, migrationsRoot,
    async beforeCommit() { return null; },
  });
  return Object.freeze({
    schema: POSTGRES_FASTPATH_TRANSPORT_COPY_SCHEMA,
    status: "rehearsal_transport_copy_complete",
    part,
    sourceCommit: POSTGRES_FASTPATH_IDENTITY_SOURCE_COMMIT,
    source: Object.freeze({ kind: trusted.snapshot.kind, artifactSha256: trusted.snapshot.artifactSha256 }),
    target: Object.freeze({
      schema, postgresMajor: Math.floor(copied.postgresVersion / 10_000), latestMigration: copied.latestMigration,
    }),
    allowlistSha256: fastpathTransportAllowlistSha256(),
    tables: copied.tables,
    unknownNullableColumnsOmitted: Object.freeze(unknownNullableColumns),
    foreignKeysChecked: copied.foreignKeysChecked,
    rowTriggersSuppressed: true,
    capabilities: Object.freeze({ rehearsalOnly: true, productionCutoverAuthorized: false }),
  });
}

// ---------------------------------------------------------------------------
// Post-chain verifications (read-only).

async function readOnly(pool, fn) {
  if (!pool || typeof pool.connect !== "function") fail("FASTPATH_IDENTITY_TARGET_POOL_REQUIRED");
  let client;
  try {
    client = await pool.connect();
  } catch {
    fail("FASTPATH_IDENTITY_TARGET_CONNECT_FAILED");
  }
  try {
    await q(client, "BEGIN READ ONLY", [], "FASTPATH_IDENTITY_TARGET_QUERY_FAILED");
    const result = await fn(client);
    await q(client, "COMMIT", [], "FASTPATH_IDENTITY_TARGET_QUERY_FAILED");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Compare community_public_source_owners in the target with the source view. */
export async function compareFastpathPublicSourceOwners({ source, pool, targetSchema } = {}) {
  const schema = validateTargetSchema(targetSchema);
  const trusted = trustedSource(source);
  await trusted.verifySnapshot();
  const sourceOwners = readSourcePublicOwners(trusted.database());
  return readOnly(pool, async client => compareOwnerSets(sourceOwners, await readTargetPublicOwners(client, schema)));
}

/**
 * Compare the target's eligible owners with an owner roster: an array of
 * entries carrying participantId and/or ownerDigest (Q-1 corpus.json owners
 * or manifest.json owners). Every entry must resolve to exactly one eligible
 * participant and the eligible participant set must be exactly the roster.
 */
export async function compareFastpathOwnerRoster({ pool, targetSchema, roster } = {}) {
  const schema = validateTargetSchema(targetSchema);
  const entries = normalizeOwnerRoster(roster);
  return readOnly(pool, async client => {
    const eligible = await q(client, `SELECT DISTINCT eligible.participant_id, link.owner_digest, link.state AS link_state
        FROM ${relation(schema, "community_public_source_owners")} eligible
        LEFT JOIN ${relation(schema, "storage_v11_owner_links")} link ON link.participant_id = eligible.participant_id`,
    [], "FASTPATH_IDENTITY_TARGET_READ_FAILED", { table: "community_public_source_owners" });
    const byParticipant = new Map(eligible.rows.map(row => [row.participant_id, row]));
    const byDigest = new Map(eligible.rows.filter(row => row.owner_digest !== null && row.link_state === "active")
      .map(row => [row.owner_digest, row.participant_id]));
    const matched = new Set();
    let unresolved = 0;
    let conflicting = 0;
    for (const { participantId, ownerDigest } of entries) {
      const viaParticipant = participantId !== null && byParticipant.has(participantId) ? participantId : null;
      const viaDigest = ownerDigest !== null ? byDigest.get(ownerDigest) ?? null : null;
      const resolved = viaParticipant ?? viaDigest;
      if (resolved === null) {
        unresolved += 1;
        continue;
      }
      if (participantId !== null && ownerDigest !== null && viaParticipant !== viaDigest) conflicting += 1;
      matched.add(resolved);
    }
    const extraInTarget = [...byParticipant.keys()].filter(id => !matched.has(id)).length;
    return Object.freeze({
      rosterOwners: entries.length,
      eligibleParticipants: byParticipant.size,
      matchedParticipants: matched.size,
      unresolved,
      conflicting,
      extraInTarget,
      equal: unresolved === 0 && conflicting === 0 && extraInTarget === 0 && matched.size === entries.length,
    });
  });
}

/** Validate a roster up front: 1 to 10000 entries, each with a participant id or a sha256 owner digest. */
function normalizeOwnerRoster(roster) {
  if (!Array.isArray(roster) || roster.length === 0 || roster.length > 10_000) fail("FASTPATH_IDENTITY_ROSTER_INVALID");
  return Object.freeze(roster.map(entry => {
    if (!entry || typeof entry !== "object") fail("FASTPATH_IDENTITY_ROSTER_INVALID");
    const participantId = typeof entry.participantId === "string" ? entry.participantId : null;
    const ownerDigest = typeof entry.ownerDigest === "string" && SHA256.test(entry.ownerDigest) ? entry.ownerDigest : null;
    if (participantId === null && ownerDigest === null) fail("FASTPATH_IDENTITY_ROSTER_INVALID");
    return Object.freeze({ participantId, ownerDigest });
  }));
}

/**
 * After the ingestion-journal importer runs, prove PostgreSQL's derived owner
 * heads equal D1's storage_owner_revisions for the source's journal source id.
 */
export async function compareFastpathOwnerRevisions({ source, pool, targetSchema } = {}) {
  const schema = validateTargetSchema(targetSchema);
  const trusted = trustedSource(source);
  await trusted.verifySnapshot();
  const database = trusted.database();
  sourceColumns(database, "storage_owner_revisions");
  sourceColumns(database, "storage_source_state");
  const sourceState = sourceAll(database, "SELECT source_id FROM storage_source_state WHERE singleton = 1", "storage_source_state");
  const canonical = rows => rows.map(row => JSON.stringify([row.owner_digest, String(row.revision),
    String(row.authority_epoch), row.state])).sort(compareKeys);
  const sourceLines = canonical(sourceAll(database,
    "SELECT owner_digest, revision, authority_epoch, state FROM storage_owner_revisions", "storage_owner_revisions"));
  return readOnly(pool, async client => {
    const state = await q(client, `SELECT source_id FROM ${relation(schema, "storage_source_state")} WHERE singleton = 1`,
      [], "FASTPATH_IDENTITY_TARGET_READ_FAILED", { table: "storage_source_state" });
    const targetRows = await q(client, `SELECT owner_digest, revision::text AS revision,
        authority_epoch::text AS authority_epoch, state
        FROM ${relation(schema, "storage_owner_revisions")}
       WHERE source_id = (SELECT source_id FROM ${relation(schema, "storage_source_state")} WHERE singleton = 1)`,
    [], "FASTPATH_IDENTITY_TARGET_READ_FAILED", { table: "storage_owner_revisions" });
    const targetLines = canonical(targetRows.rows);
    const sourceSha256 = sha256Hex(sourceLines.join("\n"));
    const targetSha256 = sha256Hex(targetLines.join("\n"));
    return Object.freeze({
      sourceIdMatches: sourceState.length === 1 && state.rows.length === 1
        && sourceState[0].source_id === state.rows[0].source_id,
      sourceRows: sourceLines.length,
      targetRows: targetLines.length,
      sourceSha256,
      targetSha256,
      equal: sourceState.length === 1 && state.rows.length === 1
        && sourceState[0].source_id === state.rows[0].source_id && sourceSha256 === targetSha256,
    });
  });
}

// ---------------------------------------------------------------------------
// Additive exports for the PT-3 production importer
// (postgres-identity-authority-transfer.mjs): the reviewed table specs, the
// column and table definition helpers and the canonical value conversions,
// exactly as this module uses them. Nothing here reads these exports, so the
// rehearsal copy, its allowlist pins and its CLI are unchanged.

export const POSTGRES_FASTPATH_IDENTITY_TABLE_SPECS = TABLES;
export const POSTGRES_FASTPATH_TRANSPORT_TABLE_SPECS = TRANSPORT_PARTS;
export const POSTGRES_FASTPATH_IDENTITY_TARGET_TYPES = TARGET_TYPES;
export const POSTGRES_FASTPATH_IDENTITY_CREDENTIAL_OMISSIONS = PARTICIPANT_CREDENTIAL_OMISSIONS;
export const FASTPATH_IDENTITY_COMPLETED_WALK_RULE = COMPLETED_WALK_CURSORS_CLEARED;
export {
  c as fastpathIdentityColumn,
  fromSource as fastpathIdentitySourceValue,
  fromTarget as fastpathIdentityTargetValue,
  t as fastpathIdentityTable,
  targetExpression as fastpathIdentityTargetExpression,
};

// ---------------------------------------------------------------------------
// CLI: node scripts/postgres-fastpath-identity-copy.mjs --sqlite <abs> --sha256 <hex>
//   --schema <typed_legacy_transfer_rehearsal_target_*> [--omit-family <family>]...
//   [--defer-public-owner-parity] [--expect-owner-roster <json>] [--receipt <abs json>]
//   [--verify-only] [--verify-owner-revisions]
// Connection: libpq environment (PGHOST, PGPORT, PGUSER, PGDATABASE). Only a
// Unix socket or a loopback host is accepted.
//
// Every argument is checked, the roster is read and the --receipt file is
// created exclusively (mode 0600) before the copy starts, so a bad argument
// can never fail after COMMIT. The receipt is written to stdout first, then to
// the --receipt file. Exit codes: 0 when everything completed and every
// requested comparison is equal; 1 when a comparison differs; 2 when the run
// was refused or failed. If a step after a committed copy fails, the receipt
// is still emitted, with copy.status complete and failedAfterCopy naming the
// closed error code: the target is populated, and the verifications can be
// re-run with --verify-only.

function parseArguments(argv) {
  const options = { omitFamilies: [], deferParity: false, verifyOnly: false, verifyOwnerRevisions: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (typeof next !== "string" || next.startsWith("--")) fail("FASTPATH_IDENTITY_CLI_ARGUMENT_INVALID");
      index += 1;
      return next;
    };
    if (flag === "--sqlite") options.sqlite = value();
    else if (flag === "--sha256") options.sha256 = value();
    else if (flag === "--schema") options.schema = value();
    else if (flag === "--omit-family") options.omitFamilies.push(value());
    else if (flag === "--defer-public-owner-parity") options.deferParity = true;
    else if (flag === "--expect-owner-roster") options.roster = value();
    else if (flag === "--receipt") options.receipt = value();
    else if (flag === "--verify-only") options.verifyOnly = true;
    else if (flag === "--verify-owner-revisions") options.verifyOwnerRevisions = true;
    else fail("FASTPATH_IDENTITY_CLI_ARGUMENT_INVALID");
  }
  if (!options.sqlite || !options.sha256 || !options.schema
      || (options.receipt !== undefined && !isAbsolute(options.receipt))) {
    fail("FASTPATH_IDENTITY_CLI_ARGUMENT_INVALID");
  }
  return options;
}

/** Create the receipt file exclusively before any write to the target. */
async function reserveReceipt(path) {
  try {
    return await open(path, "wx", 0o600);
  } catch {
    return fail("FASTPATH_IDENTITY_RECEIPT_UNAVAILABLE");
  }
}

/** Remove a reserved receipt only while it is still the empty file this run created. */
async function releaseUnwrittenReceipt(handle, path) {
  try {
    const opened = await handle.stat();
    await handle.close();
    const current = await lstat(path);
    if (opened.size === 0 && current.isFile() && current.size === 0
        && current.dev === opened.dev && current.ino === opened.ino) {
      await unlink(path);
    }
  } catch {
    // Leave it in place; the run's own error code already explains the failure.
  }
}

function assertLocalConnection() {
  const host = process.env.PGHOST ?? "";
  if (!(host.startsWith("/") || ["localhost", "127.0.0.1", "::1"].includes(host))) {
    fail("FASTPATH_IDENTITY_TARGET_NOT_LOCAL");
  }
}

async function readRoster(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("FASTPATH_IDENTITY_ROSTER_INVALID");
  }
  const owners = Array.isArray(parsed) ? parsed : parsed?.owners;
  if (!Array.isArray(owners)) fail("FASTPATH_IDENTITY_ROSTER_INVALID");
  return normalizeOwnerRoster(owners.map(owner => typeof owner === "string" ? { participantId: owner }
    : { participantId: owner?.participantId, ownerDigest: owner?.ownerDigest ?? owner?.pinnedOwnerDigest }));
}

async function main(argv) {
  const options = parseArguments(argv);
  assertLocalConnection();
  const roster = options.roster === undefined ? undefined : await readRoster(options.roster);
  const { default: pg } = await import("pg");
  const source = await openSealedFastpathIdentitySource({ path: options.sqlite, expectedSha256: options.sha256 });
  let pool;
  let receiptFile;
  let receiptWritten = false;
  try {
    if (options.receipt !== undefined) receiptFile = await reserveReceipt(options.receipt);
    pool = new pg.Pool({ max: 2, connectionTimeoutMillis: 10_000 });
    const receipt = {};
    let failure;
    try {
      if (!options.verifyOnly) {
        receipt.copy = await runPostgresFastpathIdentityCopy({
          source, pool, targetSchema: options.schema, omitFamilies: options.omitFamilies,
          publicSourceOwnerParity: options.deferParity ? "defer" : "require",
        });
      } else {
        receipt.publicSourceOwners = await compareFastpathPublicSourceOwners({ source, pool, targetSchema: options.schema });
      }
      if (roster !== undefined) {
        receipt.ownerRoster = await compareFastpathOwnerRoster({ pool, targetSchema: options.schema, roster });
      }
      if (options.verifyOwnerRevisions) {
        receipt.ownerRevisions = await compareFastpathOwnerRevisions({ source, pool, targetSchema: options.schema });
      }
    } catch (error) {
      // Before the copy committed nothing was written: refuse as is. After
      // it, the populated target must stay visible in the receipt.
      if (receipt.copy === undefined) throw error;
      failure = error;
      receipt.failedAfterCopy = error instanceof PostgresFastpathIdentityCopyError ? error.code : "FASTPATH_IDENTITY_FAILED";
    }
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    process.stdout.write(text);
    if (receiptFile !== undefined) {
      receiptWritten = true;
      try {
        await receiptFile.writeFile(text);
        await receiptFile.close();
      } catch {
        await receiptFile.close().catch(() => {});
        fail("FASTPATH_IDENTITY_RECEIPT_WRITE_FAILED");
      }
    }
    if (failure !== undefined) throw failure;
    const failed = (receipt.publicSourceOwners && !receipt.publicSourceOwners.equal)
      || (receipt.ownerRoster && !receipt.ownerRoster.equal)
      || (receipt.ownerRevisions && !receipt.ownerRevisions.equal);
    return failed ? 1 : 0;
  } catch (error) {
    if (receiptFile !== undefined && !receiptWritten) await releaseUnwrittenReceipt(receiptFile, options.receipt);
    throw error;
  } finally {
    source.close();
    await pool?.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1]).catch(() => process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }, error => {
    process.stderr.write(`${error instanceof PostgresFastpathIdentityCopyError ? error.message : "FASTPATH_IDENTITY_FAILED"}\n`);
    process.exitCode = 2;
  });
}
