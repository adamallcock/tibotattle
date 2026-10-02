// D-PT5A (PT-5a): production target modes for the telemetry importers, the
// stages that follow PT-3's 'identity-authority' stage on PT-1's production
// transfer target (postgres-transfer-target.mjs):
//
//   telemetry-v1-v11    v1 and v1.1 transport, the v1.1 domain chain
//   typed-legacy        the typed v1/v1.1 normalized family
//   legacy-admission    typed v1/v1.1 admission, proof and event-source lineage
//   header-promotion    proof that the live v1/v1.1 headers equal the seal
//   telemetry-v12       T-2: the v1.2 telemetry family
//   v12-event-sources   storage_v12_event_sources
//   usage-correction    the usage-correction evidence family
//   ingestion-journal   the storage ingestion journal and its source state
//
// Every stage is a frozen list of reviewed table specs run by the shared
// engine (postgres-production-telemetry-engine.mjs); the module exports the
// runners (run<Stage>Production), the reviewed trigger policy, the table
// dispositions the PT-8-lite coverage module consumes, and the closed staging
// and retained relation inventories (both empty: no stage creates a staging
// relation in tibotattle_transfer).
//
// The rehearsal importers (T-1, typed-legacy, legacy-admission, T-2,
// usage-correction, ingestion-journal and their synthetic modes) are not
// touched: their reviewed layouts are the oracle the check compares these
// specs against.

import { createHash } from "node:crypto";
import {
  TelemetryProductionError,
  assertParentReceipts,
  col,
  defineTable,
  genericSealedDigest,
  quote,
  raiseIdentityHighWater,
  readStageTableReceipts,
  runTelemetryStage,
  sealedCounters,
  sourceAll,
  sourceCount,
  sourceTableFacts,
  specTriggerPolicy,
  targetQuery,
  targetTableFacts,
  telemetryFail as fail,
} from "./postgres-production-telemetry-engine.mjs";
import { canonicalSourceValue } from "./postgres-production-telemetry-engine.mjs";
import {
  TRANSFER_STAGES,
  assertStageComplete,
  EMPTY_PREFIX_CHAIN,
  advancePrefixChain,
  readCheckpoint,
  recordCheckpoint,
  requireImportingRun,
  tableReceipt,
  withTransferTransaction,
} from "./postgres-transfer-target.mjs";

export const TELEMETRY_PRODUCTION_STAGES = Object.freeze([
  "telemetry-v1-v11",
  "typed-legacy",
  "legacy-admission",
  "header-promotion",
  "telemetry-v12",
  "v12-event-sources",
  "usage-correction",
  "ingestion-journal",
]);
for (const stage of TELEMETRY_PRODUCTION_STAGES) {
  if (!TRANSFER_STAGES.includes(stage)) throw new TypeError("telemetry production stage unknown to PT-1");
}

const HASH = value => createHash("sha256").update(value).digest("hex");
const UPDATE_ONLY = "Fires only on UPDATE or DELETE; the import inserts.";
const SCHEMA_TAG = stage => `tibotattle-production-${stage}-v1`;

// Shorthand for the column vocabulary.
const text = (name, options) => col(name, "text", options);
const i16 = (name, options) => col(name, "i16", options);
const i32 = (name, options) => col(name, "i32", options);
const i64 = (name, options) => col(name, "i64", options);
const instant = (name, options) => col(name, "instant", options);
const day = (name, options) => col(name, "day", options);
const bytes = (name, options) => col(name, "bytes", options);
const real = (name, options) => col(name, "real", options);
const json = (name, options) => col(name, "json", options);

// ---------------------------------------------------------------------------
// Chunk-owned pending registrations ("chunk-registrations").
//
// In D1 a chunk's object stays registered in pending_quarantine_objects until
// the reconciler clears it, so a seal taken inside that window holds a
// registration whose contribution id is the chunk id. PostgreSQL's
// pending_objects keys the same registration by contribution_id = chunk id.
// Each chunk stage imports exactly that subset verbatim (kind rewritten to the
// family's PostgreSQL kind, the reviewed T-0 mapping) in the page transaction
// of the chunk it belongs to, and records its count and digest as the stage's
// 'chunk-registrations' checkpoint for the 'pending-registrations' stage.

export const CHUNK_REGISTRATIONS_CHECKPOINT = "chunk-registrations";
const REGISTRATION_KINDS = Object.freeze({ telemetry_v1: "telemetry_v1", telemetry_v11: "telemetry_v11", telemetry_v12: "telemetry_v12" });

function registrationRow(row, chunk, kind) {
  if (row.contribution_id !== chunk.id || row.r2_key !== chunk.r2_key || row.object_kind !== "telemetry"
      || !(row.reconciliation_state === "registered" ? row.reconciliation_lease_id === null
        : row.reconciliation_state === "deleting" && typeof row.reconciliation_lease_id === "string")) {
    fail("CUTOVER_PENDING_OBJECT_INVALID", { table: "pending_quarantine_objects" });
  }
  const [registeredAt] = canonicalSourceValue("instant", row.registered_at, "pending_quarantine_objects", "registered_at");
  const [leaseId] = canonicalSourceValue("text", row.reconciliation_lease_id, "pending_quarantine_objects", "reconciliation_lease_id");
  return Object.freeze({
    values: [row.contribution_id, row.r2_key, kind, registeredAt, row.reconciliation_state, leaseId],
  });
}

function sealedRegistrations(database, chunkTable, kind, ids = null) {
  const marks = ids === null ? "" : ` AND chunk.id IN (${ids.map(() => "?").join(",")})`;
  const rows = sourceAll(database, `SELECT registration.r2_key, registration.contribution_id, registration.object_kind,
      registration.registered_at, registration.reconciliation_state, registration.reconciliation_lease_id,
      chunk.id AS chunk_id, chunk.r2_key AS chunk_r2_key
    FROM pending_quarantine_objects registration
    JOIN ${quote(chunkTable)} chunk ON chunk.id = registration.contribution_id
   WHERE 1 = 1${marks} ORDER BY registration.contribution_id`, ids ?? [], "pending_quarantine_objects");
  return rows.map(row => registrationRow(row, { id: row.chunk_id, r2_key: row.chunk_r2_key }, kind));
}

function registrationFacts(database, chunkTables) {
  const digestInput = [];
  let count = 0;
  const hash = createHash("sha256");
  for (const [chunkTable, kind] of chunkTables) {
    for (const row of sealedRegistrations(database, chunkTable, kind)) {
      hash.update(`${JSON.stringify(row.values)}\n`);
      digestInput.push(row.values[0]);
      count += 1;
    }
  }
  if (new Set(digestInput).size !== digestInput.length) fail("CUTOVER_PENDING_OBJECT_INVALID", { table: "pending_quarantine_objects" });
  return Object.freeze({ count, sha256: hash.digest("hex") });
}

/** The page hook: register the chunk-owned objects of this page, verbatim, before the chunk rows. */
function chunkRegistrationHook(chunkTable, kind) {
  return async ({ client, schema, database, rows }) => {
    const ids = rows.map(row => row.raw.id);
    const registrations = sealedRegistrations(database, chunkTable, kind, ids);
    if (registrations.length === 0) return;
    const width = 6;
    const placeholders = registrations.map((_, index) => `(${Array.from({ length: width }, (__, column) =>
      `$${index * width + column + 1}`).join(", ")})`).join(", ");
    const result = await targetQuery(client, `INSERT INTO ${quote(schema)}."pending_objects"
        (contribution_id, object_key, object_kind, registered_at, reconciliation_state, reconciliation_lease_id)
      VALUES ${placeholders}`, registrations.flatMap(row => row.values), "pending_objects");
    if (result.rowCount !== registrations.length) fail("CUTOVER_PENDING_OBJECT_INVALID", { table: "pending_objects" });
  };
}

async function targetRegistrationFacts(client, schema, chunkTables) {
  const hash = createHash("sha256");
  let count = 0;
  for (const [chunkTable, kind] of chunkTables) {
    const { rows } = await targetQuery(client, `SELECT registration.contribution_id, registration.object_key,
        registration.object_kind, to_char(registration.registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at,
        registration.reconciliation_state, registration.reconciliation_lease_id
      FROM ${quote(schema)}."pending_objects" registration
      JOIN ${quote(schema)}.${quote(chunkTable)} chunk ON chunk.id = registration.contribution_id
     ORDER BY registration.contribution_id COLLATE "C"`, [], "pending_objects");
    for (const row of rows) {
      hash.update(`${JSON.stringify([row.contribution_id, row.object_key, row.object_kind, row.registered_at,
        row.reconciliation_state, row.reconciliation_lease_id])}\n`);
      count += 1;
    }
    if (rows.some(row => row.object_kind !== kind)) fail("CUTOVER_CHUNK_REGISTRATION_MISMATCH", { table: "pending_objects" });
  }
  return Object.freeze({ count, sha256: hash.digest("hex") });
}

/**
 * The step that proves the chunk-owned subset and records the stage's
 * 'chunk-registrations' checkpoint (row count = registrations, prefix chain =
 * their digest). A replay of a finished stage re-proves it without writing.
 */
function chunkRegistrationStep(stage, chunkTables) {
  return Object.freeze({
    kind: "step",
    name: CHUNK_REGISTRATIONS_CHECKPOINT,
    async run({ handle, schema, database }) {
      const expected = registrationFacts(database, chunkTables);
      return withTransferTransaction(handle, "primary", async client => {
        const actual = await targetRegistrationFacts(client, schema, chunkTables);
        if (actual.count !== expected.count || actual.sha256 !== expected.sha256) {
          fail("CUTOVER_CHUNK_REGISTRATION_MISMATCH", { table: "pending_objects", stage });
        }
        await recordCheckpoint(client, handle, { stage, name: CHUNK_REGISTRATIONS_CHECKPOINT, state: "complete",
          rowCount: expected.count, prefixChainSha256: expected.sha256 });
        return Object.freeze({ registrations: expected.count, sha256: expected.sha256 });
      });
    },
  });
}

/** The chunk-owned registration receipts of this run, for the 'pending-registrations' stage (read-only). */
export async function readChunkRegistrationReceipts(handle) {
  return withTransferTransaction(handle, "primary", async client => {
    const run = await targetQuery(client, `SELECT run_id FROM tibotattle_transfer.transfer_runs
      WHERE seal_manifest_sha256 = $1 AND contract_id = $2 AND state <> 'abandoned'`, [handle.sealManifestSha256, handle.contractId]);
    if (run.rows.length !== 1) fail("CUTOVER_PARENT_RECEIPT_MISMATCH");
    const { rows } = await targetQuery(client, `SELECT stage, state, row_count::text AS row_count, prefix_chain_sha256
      FROM tibotattle_transfer.transfer_checkpoints WHERE run_id = $1 AND checkpoint_name = $2 AND state = 'complete'
     ORDER BY stage`, [run.rows[0].run_id, CHUNK_REGISTRATIONS_CHECKPOINT]);
    return Object.freeze(rows.map(row => Object.freeze({ stage: row.stage, registrations: Number(row.row_count),
      sha256: row.prefix_chain_sha256 })));
  }, { readOnly: true });
}

// ---------------------------------------------------------------------------
// Stage: telemetry-v1-v11.

const V1_V11 = "telemetry-v1-v11";
const V1_V11_TOKEN = `imported:${V1_V11}`;
const SOURCE_UPDATE_REASON = "Derived input version, source digest and journal rows: PT-3 imported the sealed input versions and the journal importer owns the history.";

const TELEMETRY_V1_CHUNKS = defineTable({
  name: "telemetry_v1_chunks", key: ["id"], token: V1_V11_TOKEN,
  columns: [
    text("id"), text("participant_id"), text("device_id"), text("stream"), day("chunk_day"), i32("chunk_seq"),
    i32("revision"), text("chunk_digest"), text("envelope_digest"), text("parser_version"), i32("record_count"),
    i32("accepted_record_count"), text("r2_key"), text("device_upload_authorization_id"), instant("superseded_at"),
    instant("quarantine_deleted_at"), instant("created_at"),
  ],
  suppress: {
    aa_analytical_insert: "Bumps input_versions and mutation_control for a live insert; the sealed input versions were imported by PT-3 and analytics recompute.",
    telemetry_v1_chunks_reconciliation_guard: "Live admission needs a registered object; chunk-owned registrations are imported verbatim from the seal.",
    telemetry_v1_source_digest: SOURCE_UPDATE_REASON,
    telemetry_v1_transport_floor_guard: "Admits live uploads only; the sealed chunks were admitted by D1 under the floors of their day.",
  },
  fire: { aa_analytical_delete: UPDATE_ONLY, aa_analytical_update: UPDATE_ONLY },
  beforeInsert: chunkRegistrationHook("telemetry_v1_chunks", REGISTRATION_KINDS.telemetry_v1),
});

const TELEMETRY_V1_RECORDS = defineTable({
  name: "telemetry_v1_records", large: true, key: ["id"], token: V1_V11_TOKEN,
  columns: [
    i64("id"), text("chunk_row_id"), text("participant_id"), text("device_id"), text("stream"), text("occurrence_id"),
    instant("observed_at"), day("observed_day"), text("provider"), text("model_id"), text("session_uuid"),
    text("plan_type"), text("plan_variant"), text("limit_id"), text("slot"), real("used_percent"),
    i32("window_duration_minutes"), instant("resets_at"), i64("input_uncached_tokens"), i64("input_cache_read_tokens"),
    i64("input_cache_write_tokens"), i64("output_text_tokens"), i64("output_reasoning_tokens"),
    i64("output_combined_tokens"), json("record_json"),
  ],
  suppress: {
    telemetry_v1_quota_fit_rows_insert: "Derives telemetry_v1_quota_fit_rows, a recomputed table that must stay at its seed after the import.",
  },
  fire: { telemetry_v1_quota_fit_rows_delete: UPDATE_ONLY, telemetry_v1_quota_fit_rows_update: UPDATE_ONLY },
});

const TELEMETRY_V11_DAY_MANIFESTS = defineTable({
  name: "telemetry_v11_day_manifests", large: true, key: ["id"], token: V1_V11_TOKEN,
  columns: [
    text("id"), text("participant_id"), text("device_id"), day("chunk_day"), text("manifest_digest"), text("parser_version"),
    text("manifest_json"), i32("expected_chunk_count"), text("state"), instant("created_at"), instant("ready_at"),
  ],
  fire: {
    telemetry_v11_manifest_immutable_guard: "Refuses a manifest a published day already covers; the domain days are imported after the manifests.",
    telemetry_v11_manifest_ready_guard: UPDATE_ONLY,
  },
});

const TELEMETRY_V11_CHUNKS = defineTable({
  name: "telemetry_v11_chunks", key: ["id"], token: V1_V11_TOKEN,
  columns: [
    text("id"), text("manifest_id"), text("participant_id"), text("device_id"), text("stream"), day("chunk_day"),
    i32("chunk_seq"), text("chunk_id"), text("chunk_digest"), text("envelope_digest"), text("parser_version"),
    i32("record_count"), text("r2_key"), text("device_upload_authorization_id"), instant("quarantine_deleted_at"),
    instant("created_at"),
  ],
  suppress: {
    telemetry_v11_chunks_reconciliation_guard: "Live admission needs a registered object; chunk-owned registrations are imported verbatim from the seal.",
  },
  fire: { telemetry_v11_chunk_immutable_guard: "Refuses a chunk of an already published manifest; the domain days are imported last." },
  beforeInsert: chunkRegistrationHook("telemetry_v11_chunks", REGISTRATION_KINDS.telemetry_v11),
});

const TELEMETRY_V11_RECORDS = defineTable({
  name: "telemetry_v11_records", large: true, key: ["chunk_id", "occurrence_id"], token: V1_V11_TOKEN,
  columns: [
    text("chunk_id"), text("manifest_id"), text("stream"), text("occurrence_id"), instant("observed_at"),
    text("record_json"), text("legacy_occurrence_id"), text("legacy_record_json"),
  ],
  fire: {
    telemetry_v11_record_immutable_guard: "Refuses a record of an already published manifest; the domain days are imported last.",
    telemetry_v11_typed_json_refusal: "Refuses JSON records once typed v1.1 admission is active; legacy-admission imports that state after this stage.",
  },
});

const TELEMETRY_V11_DOMAIN_PREDECESSORS = defineTable({
  name: "telemetry_v11_domain_predecessors", large: true, key: ["token_hash"], token: V1_V11_TOKEN,
  columns: [
    text("token_hash"), text("participant_id"), text("device_id"), text("previous_generation_id"),
    text("legacy_fingerprint"), i32("input_revision"), day("from_day"), day("through_day"), text("winners_json"),
    instant("created_at"), instant("expires_at"), instant("consumed_at"),
  ],
});

const TELEMETRY_V11_DOMAINS = defineTable({
  name: "telemetry_v11_domains", large: true, key: ["id"], token: V1_V11_TOKEN,
  columns: [
    text("id"), text("participant_id"), text("device_id"), text("predecessor_token_hash"), text("previous_generation_id"),
    text("manifest_digest"), text("legacy_fingerprint"), i32("input_revision"), day("from_day"), day("through_day"),
    text("days_json"), instant("created_at"),
  ],
  fire: { telemetry_v11_domain_immutable_guard: UPDATE_ONLY },
});

const TELEMETRY_V11_DOMAIN_DAYS = defineTable({
  name: "telemetry_v11_domain_days", key: ["generation_id", "observed_day"], token: V1_V11_TOKEN,
  columns: [text("generation_id"), day("observed_day"), text("manifest_id")],
  suppress: {
    telemetry_v11_domain_day_immutable_guard: "Admits an activation insert before its head only; sealed generations are inserted whole, an older one already has its successor.",
  },
});

const TELEMETRY_V11_DOMAIN_HEADS = defineTable({
  name: "telemetry_v11_domain_heads", key: ["participant_id"], token: V1_V11_TOKEN,
  columns: [text("participant_id"), text("generation_id"), i32("revision"), instant("updated_at")],
  suppress: {
    storage_v11_head_publication: "Bridges a live head into the owner journal; the sealed journal is imported by its own stage and a copied head must not mint a second event.",
    telemetry_v11_domain_head_source_revision: SOURCE_UPDATE_REASON,
  },
  fire: { storage_v11_classify_head: UPDATE_ONLY },
});

const STORAGE_V11_APPEND_TRANSITIONS = defineTable({
  name: "storage_v11_append_transitions", key: ["generation_id"], token: V1_V11_TOKEN,
  columns: [text("generation_id"), text("previous_generation_id"), text("participant_id"), i64("head_revision"),
    i16("is_append"), i32("compared_records")],
  fire: { storage_v11_append_transition_guard: UPDATE_ONLY },
});

const V1_V11_CHUNK_TABLES = Object.freeze([
  ["telemetry_v1_chunks", REGISTRATION_KINDS.telemetry_v1],
  ["telemetry_v11_chunks", REGISTRATION_KINDS.telemetry_v11],
]);

const V1_V11_ITEMS = Object.freeze([
  Object.freeze({ kind: "table", spec: TELEMETRY_V1_CHUNKS }),
  Object.freeze({ kind: "table", spec: TELEMETRY_V1_RECORDS }),
  Object.freeze({ kind: "table", spec: TELEMETRY_V11_DAY_MANIFESTS }),
  Object.freeze({ kind: "table", spec: TELEMETRY_V11_CHUNKS }),
  Object.freeze({ kind: "table", spec: TELEMETRY_V11_RECORDS }),
  Object.freeze({ kind: "table", spec: TELEMETRY_V11_DOMAIN_PREDECESSORS }),
  Object.freeze({ kind: "table", spec: TELEMETRY_V11_DOMAINS }),
  Object.freeze({ kind: "table", spec: TELEMETRY_V11_DOMAIN_DAYS }),
  Object.freeze({ kind: "table", spec: TELEMETRY_V11_DOMAIN_HEADS }),
  Object.freeze({ kind: "table", spec: STORAGE_V11_APPEND_TRANSITIONS }),
  chunkRegistrationStep(V1_V11, V1_V11_CHUNK_TABLES),
]);

function specPolicyDescriptor(spec) {
  return [spec.name, spec.sealedTable, spec.target, spec.key, spec.columns.map(column => [column.name, column.type, column.sealed, column.sql]),
    spec.closure.map(entry => [entry.table, entry.columns, entry.omitted]), spec.mode, spec.token, spec.suppress, spec.fire];
}

function stagePolicySha256(stage, items, extras = []) {
  return HASH(JSON.stringify([SCHEMA_TAG(stage), stage,
    items.map(item => (item.kind === "table" ? specPolicyDescriptor(item.spec) : ["step", item.name])), extras],
  (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
}

const V1_V11_DEFINITION = Object.freeze({
  stage: V1_V11,
  schemaTag: SCHEMA_TAG(V1_V11),
  prerequisites: Object.freeze(["identity-authority"]),
  items: V1_V11_ITEMS,
  extraSealed: Object.freeze(["pending_quarantine_objects", "participants", "device_credentials", "device_upload_authorizations"]),
  policySha256: stagePolicySha256(V1_V11, V1_V11_ITEMS),
  sourcePreflight({ database }) {
    const registrations = registrationFacts(database, V1_V11_CHUNK_TABLES);
    return Object.freeze({ chunkRegistrations: registrations });
  },
  async targetPreflight({ client, handle, database }) {
    await assertParentReceipts(client, handle, database, "identity-authority",
      ["participants", "device_credentials", "device_upload_authorizations"]);
    return Object.freeze({ parentReceipts: true });
  },
  async finish({ client, handle, database }) {
    const highWater = await raiseIdentityHighWater(client, handle, sealedCounters(database));
    return Object.freeze({ highWaterTables: highWater.length });
  },
});

// ---------------------------------------------------------------------------
// Stage: typed-legacy.

const TYPED = "typed-legacy";
const TYPED_IMPORTED = `imported:${TYPED}`;
const TYPED_MAPPED = `mapped:${TYPED}`;
const TYPED_DELETE_GUARD = "DELETE only: erasure retention guard; the import inserts.";

const typedSpec = (name, key, columns, triggers = {}, extra = {}) => defineTable({
  name, key, columns, token: TYPED_IMPORTED, ...triggers, ...extra,
});

const TYPED_DICTIONARY = typedSpec("typed_telemetry_dictionary", ["id"], [i64("id"), text("value")], {
  fire: { typed_telemetry_dictionary_immutable: UPDATE_ONLY },
});
const TYPED_NAMESPACES = typedSpec("typed_telemetry_namespaces", ["id"], [i64("id"), bytes("original_id")], {
  fire: { typed_telemetry_namespace_immutable: UPDATE_ONLY },
});
const TYPED_OWNERS = typedSpec("typed_telemetry_owners", ["id"], [i64("id"), i64("namespace_id"), bytes("original_id")], {
  fire: { typed_telemetry_namespace_owner_delete_guard: TYPED_DELETE_GUARD, typed_telemetry_owner_immutable: UPDATE_ONLY },
});

function membershipSpec(name, format, memberTable, stateTable) {
  return defineTable({
    name, sealedTable: memberTable, target: "typed_telemetry_owner_memberships",
    key: ["namespace_id", "source_format", "owner_id"], token: TYPED_MAPPED,
    from: `(SELECT owner.namespace_id AS namespace_id, ${format} AS source_format, owner.id AS owner_id,
      membership.participant_id AS participant_id, admission.source_namespace AS source_namespace
      FROM ${memberTable} membership
      JOIN typed_telemetry_owners owner ON owner.id = membership.typed_owner_id
      JOIN ${stateTable} admission ON admission.id = 1 AND admission.namespace_id = owner.namespace_id)`,
    columns: [i64("namespace_id"), i16("source_format"), i64("owner_id"), text("participant_id"), text("source_namespace")],
    closure: [{ table: memberTable, columns: ["participant_id", "typed_owner_id"] }],
    targetRestrict: { sql: `"source_format" = ${format}`, values: [] },
    suppress: {
      typed_telemetry_owner_membership_insert_guard: "Refuses a mapping for a withdrawn owner link; sealed memberships are history admitted by D1 before any withdrawal (the preflight proves every participant active and no link erased).",
    },
    fire: {
      typed_telemetry_owner_membership_delete_guard: TYPED_DELETE_GUARD,
      typed_telemetry_owner_membership_immutable: UPDATE_ONLY,
    },
  });
}
const TYPED_V1_MEMBERSHIPS = membershipSpec("typed_v1_owner_memberships", 10, "typed_v1_owner_memberships", "typed_v1_admission_state");
const TYPED_V11_MEMBERSHIPS = membershipSpec("typed_v11_owner_memberships", 11, "typed_v11_owner_memberships", "typed_v11_admission_state");

const TYPED_DEVICES = typedSpec("typed_telemetry_devices", ["id"], [i64("id"), i64("namespace_id"), i64("owner_id"), bytes("original_id")], {
  fire: { typed_telemetry_device_delete_guard: TYPED_DELETE_GUARD, typed_telemetry_device_immutable: UPDATE_ONLY },
});
const TYPED_MANIFESTS = typedSpec("typed_telemetry_manifests", ["id"], [
  i64("id"), i64("namespace_id"), i64("owner_id"), i64("device_id"), bytes("original_id"), i32("chunk_day"),
], { fire: { typed_telemetry_manifest_delete_guard: TYPED_DELETE_GUARD, typed_telemetry_manifest_immutable: UPDATE_ONLY } });
const TYPED_IDENTIFIERS = typedSpec("typed_telemetry_identifiers", ["id"], [
  i64("id"), i64("namespace_id"), i64("owner_id"), bytes("value"),
], { fire: { typed_telemetry_identifier_delete_guard: TYPED_DELETE_GUARD, typed_telemetry_identifier_immutable: UPDATE_ONLY } });
const TYPED_ATTRIBUTIONS = typedSpec("typed_telemetry_attributions", ["id"], [
  i64("id"), i64("namespace_id"), i64("owner_id"), i16("account_basis"), bytes("account_track"), i16("plan_basis"),
  i64("plan_type_id"), bytes("plan_era"),
], { fire: { typed_telemetry_attribution_delete_guard: TYPED_DELETE_GUARD, typed_telemetry_attribution_immutable: UPDATE_ONLY } });
const TYPED_QUOTA_DIMENSIONS = typedSpec("typed_telemetry_quota_dimensions", ["id"], [
  i64("id"), i64("namespace_id"), i64("owner_id"), i64("plan_type_id"), i64("plan_variant_id"), i64("attribution_id"),
], { fire: { typed_telemetry_quota_dimensions_delete_guard: TYPED_DELETE_GUARD, typed_telemetry_quota_dimensions_immutable: UPDATE_ONLY } });
const TYPED_CHUNKS = typedSpec("typed_telemetry_chunks", ["id"], [
  i64("id"), i64("namespace_id"), i16("format"), i64("owner_id"), i64("device_id"), i64("manifest_id"), bytes("original_id"),
  i16("stream"), i32("chunk_day"),
], {
  fire: {
    typed_telemetry_chunk_delete_guard: TYPED_DELETE_GUARD,
    typed_telemetry_chunk_immutable: UPDATE_ONLY,
    typed_telemetry_chunk_manifest_membership_guard: "Insert guard: a v1.1 chunk must match its typed manifest's owner, device and day; it holds for the sealed rows.",
  },
});
const TYPED_RECORDS = typedSpec("typed_telemetry_records", ["id"], [
  i64("id"), i64("namespace_id"), i16("format"), i64("source_row_id"), i64("owner_id"), i64("device_id"), i64("chunk_id"),
  i64("manifest_id"), i16("stream"), bytes("occurrence_id"), i64("observed_at_ms"), i32("observed_day"), i64("provider_id"),
  bytes("canonical_digest"),
], {
  fire: {
    typed_telemetry_record_day_membership_guard: "Insert guard: a record must match its chunk's owner, device, stream and day; it holds for the sealed rows.",
    typed_telemetry_record_delete_guard: TYPED_DELETE_GUARD,
    typed_telemetry_record_immutable: UPDATE_ONLY,
  },
});
const TYPED_USAGE = typedSpec("typed_telemetry_usage", ["record_id"], [
  i64("record_id"), i16("stream"), i64("session_id"), i64("model_id"), i64("speed_mode_id"), i64("api_service_tier_id"),
  i64("surface_id"), i64("billing_surface_id"), i64("reasoning_effort_id"), i64("agent_scope_id"), i64("outcome_id"),
  i64("attribution_id"), i64("total_input_context_tokens"), i64("input_uncached_tokens"), i64("input_cache_read_tokens"),
  i64("input_cache_write_tokens"), i64("output_text_tokens"), i64("output_reasoning_tokens"), i64("output_combined_tokens"),
], {
  fire: {
    typed_telemetry_usage_delete_guard: TYPED_DELETE_GUARD,
    typed_telemetry_usage_immutable: UPDATE_ONLY,
    typed_telemetry_usage_membership_guard: "Insert guard: the session identifier and attribution must belong to the record's owner; it holds for the sealed rows.",
  },
});
const TYPED_QUOTA = typedSpec("typed_telemetry_quota", ["record_id"], [
  i64("record_id"), i16("stream"), i64("dimensions_id"), i64("limit_id"), i64("slot_id"), real("used_percent"),
  i32("window_duration_minutes"), i64("resets_at_ms"),
], {
  fire: {
    typed_telemetry_quota_delete_guard: TYPED_DELETE_GUARD,
    typed_telemetry_quota_immutable: UPDATE_ONLY,
    typed_telemetry_quota_membership_guard: "Insert guard: the quota dimensions must belong to the record's owner; it holds for the sealed rows.",
  },
}, {
  omitted: {
    analysis_owner_id: "d1-analytical-denormalization: equals the record's owner (the preflight proves it)",
    analysis_observed_at_ms: "d1-analytical-denormalization: equals the record's observed_at_ms (the preflight proves it)",
    analysis_source_row_id: "d1-analytical-denormalization: equals the record's source_row_id (the preflight proves it)",
  },
});
const TYPED_SESSION_TOOLS = typedSpec("typed_telemetry_session_tools", ["record_id", "tool_class_id"], [
  i64("record_id"), i16("stream"), i64("tool_class_id"), i64("count"),
], {
  fire: {
    typed_telemetry_session_delete_guard: TYPED_DELETE_GUARD,
    typed_telemetry_session_immutable: UPDATE_ONLY,
    typed_telemetry_session_membership_guard: "Insert guard: a tool count must hang off a session record; it holds for the sealed rows.",
  },
});

/** Sealed marker tables with no PostgreSQL target: one row, the pinned constant. */
export const TYPED_LEGACY_SCHEMA_MARKERS = Object.freeze({
  typed_telemetry_schema: Object.freeze({ id: 1n, version: 1n }),
  typed_v1_analytical_schema: Object.freeze({ id: 1n, version: 1n }),
});

const TYPED_ITEMS = Object.freeze([
  TYPED_DICTIONARY, TYPED_NAMESPACES, TYPED_OWNERS, TYPED_V1_MEMBERSHIPS, TYPED_V11_MEMBERSHIPS, TYPED_DEVICES,
  TYPED_MANIFESTS, TYPED_IDENTIFIERS, TYPED_ATTRIBUTIONS, TYPED_QUOTA_DIMENSIONS, TYPED_CHUNKS, TYPED_RECORDS, TYPED_USAGE,
  TYPED_QUOTA, TYPED_SESSION_TOOLS,
].map(spec => Object.freeze({ kind: "table", spec })));

function assertSchemaMarkers(database) {
  for (const [table, expected] of Object.entries(TYPED_LEGACY_SCHEMA_MARKERS)) {
    const rows = sourceAll(database, `SELECT id, version FROM ${quote(table)}`, [], table);
    if (rows.length !== 1 || rows[0].id !== expected.id || rows[0].version !== expected.version) {
      fail("CUTOVER_SCHEMA_MARKER_MISMATCH", { table });
    }
  }
}

const TYPED_DEFINITION = Object.freeze({
  stage: TYPED,
  schemaTag: SCHEMA_TAG(TYPED),
  prerequisites: Object.freeze(["identity-authority", "telemetry-v1-v11"]),
  items: TYPED_ITEMS,
  extraSealed: Object.freeze(["participants", "storage_v11_owner_links", "typed_v1_admission_state", "typed_v11_admission_state",
    ...Object.keys(TYPED_LEGACY_SCHEMA_MARKERS)]),
  policySha256: stagePolicySha256(TYPED, TYPED_ITEMS, [TYPED_LEGACY_SCHEMA_MARKERS]),
  sourcePreflight({ database, facts }) {
    assertSchemaMarkers(database);
    for (const state of ["typed_v1_admission_state", "typed_v11_admission_state"]) {
      if (sourceCount(database, `SELECT count(*) AS n FROM ${state} WHERE id = 1`, [], state) !== 1
          || sourceCount(database, `SELECT count(*) AS n FROM ${state}`, [], state) !== 1) {
        fail("CUTOVER_SOURCE_LINEAGE_INVALID", { table: state });
      }
    }
    // The joins that build the mapped memberships must drop nothing.
    for (const spec of [TYPED_V1_MEMBERSHIPS, TYPED_V11_MEMBERSHIPS]) {
      const sealedRows = sourceCount(database, `SELECT count(*) AS n FROM ${quote(spec.sealedTable)}`, [], spec.sealedTable);
      if (facts.get(spec.name).rows !== sealedRows) fail("CUTOVER_SOURCE_LINEAGE_INVALID", { table: spec.sealedTable });
      // Owner authority: every participant is active (PT-3 refuses anything else) and no link is erased.
      const notActive = sourceCount(database, `SELECT count(*) AS n FROM ${quote(spec.sealedTable)} membership
        LEFT JOIN participants participant ON participant.id = membership.participant_id
        WHERE participant.id IS NULL OR participant.state IS NOT 'active'`, [], spec.sealedTable);
      if (notActive !== 0) fail("CUTOVER_TYPED_OWNER_AUTHORITY_INVALID", { table: spec.sealedTable });
      const erased = sourceCount(database, `SELECT count(*) AS n FROM ${quote(spec.sealedTable)} membership
        JOIN storage_v11_owner_links owner_link ON owner_link.participant_id = membership.participant_id
        WHERE owner_link.state = 'erased'`, [], spec.sealedTable);
      if (erased !== 0) fail("CUTOVER_ERASED_OWNER_EVIDENCE_PRESENT", { table: spec.sealedTable });
    }
    // The omitted quota denormalization is exactly what the record provides.
    const drift = sourceCount(database, `SELECT count(*) AS n FROM typed_telemetry_quota quota
      JOIN typed_telemetry_records record ON record.id = quota.record_id
      WHERE (quota.analysis_owner_id IS NOT NULL OR quota.analysis_observed_at_ms IS NOT NULL
             OR quota.analysis_source_row_id IS NOT NULL)
        AND (quota.analysis_owner_id IS NOT record.owner_id OR quota.analysis_observed_at_ms IS NOT record.observed_at_ms
             OR quota.analysis_source_row_id IS NOT record.source_row_id)`, [], "typed_telemetry_quota");
    if (drift !== 0) fail("CUTOVER_SOURCE_LINEAGE_INVALID", { table: "typed_telemetry_quota" });
    return Object.freeze({ schemaMarkers: Object.keys(TYPED_LEGACY_SCHEMA_MARKERS).length,
      memberships: Object.freeze({ v1: facts.get("typed_v1_owner_memberships").rows, v11: facts.get("typed_v11_owner_memberships").rows }) });
  },
  async targetPreflight({ client, handle, database }) {
    await assertParentReceipts(client, handle, database, "identity-authority", ["participants", "storage_v11_owner_links"]);
    return Object.freeze({ parentReceipts: true });
  },
  async extraReceipts({ handle, database }) {
    const facts = {};
    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      for (const table of Object.keys(TYPED_LEGACY_SCHEMA_MARKERS)) {
        const digest = genericSealedDigest(database, table);
        await tableReceipt(client, handle, { stage: TYPED, sourceRole: "ingestion", sourceTable: table,
          disposition: "schema-marker", state: "complete", sourceRowCount: digest.rows, sourceSha256: digest.sha256 });
        facts[table] = Object.freeze({ rows: digest.rows, sha256: digest.sha256 });
      }
    });
    return Object.freeze(facts);
  },
  async finish({ client, handle, database }) {
    const highWater = await raiseIdentityHighWater(client, handle, sealedCounters(database));
    return Object.freeze({ highWaterTables: highWater.length });
  },
});

export function runTypedLegacyProduction(options) {
  return runTelemetryStage(TYPED_DEFINITION, options);
}

// ---------------------------------------------------------------------------
// Stage: legacy-admission.

const ADMISSION = "legacy-admission";
const ADMISSION_TOKEN = `imported:${ADMISSION}`;
const ADMISSION_STATE_COLUMNS = () => [i16("id"), text("source_namespace"), i64("namespace_id"),
  i16("runtime_contract_version"), i64("next_source_row_id")];
const ALLOCATION_COLUMNS = () => [text("chunk_id"), i64("namespace_id"), bytes("chunk_original"), i64("first_source_row_id"),
  i32("record_count")];
const MEMBERSHIP_GUARD = "Insert guard that re-proves the admission lineage from the imported rows; it holds for a consistent seal.";

const ADMISSION_TABLES = Object.freeze({
  typed_v1_admission_state: defineTable({ name: "typed_v1_admission_state", key: ["id"], token: ADMISSION_TOKEN,
    columns: ADMISSION_STATE_COLUMNS() }),
  typed_v11_admission_state: defineTable({ name: "typed_v11_admission_state", key: ["id"], token: ADMISSION_TOKEN,
    columns: ADMISSION_STATE_COLUMNS(), fire: { typed_v11_admission_state_guard: UPDATE_ONLY } }),
  typed_v1_chunk_allocations: defineTable({ name: "typed_v1_chunk_allocations", key: ["chunk_id"], token: ADMISSION_TOKEN,
    columns: ALLOCATION_COLUMNS(), fire: { typed_legacy_v1_chunk_allocation_guard: MEMBERSHIP_GUARD } }),
  typed_v11_chunk_allocations: defineTable({ name: "typed_v11_chunk_allocations", key: ["chunk_id"], token: ADMISSION_TOKEN,
    columns: ALLOCATION_COLUMNS(), fire: { typed_legacy_v11_chunk_allocation_guard: MEMBERSHIP_GUARD } }),
  typed_v1_record_admissions: defineTable({ name: "typed_v1_record_admissions", key: ["typed_record_id"], token: ADMISSION_TOKEN,
    columns: [i64("typed_record_id"), text("chunk_id")], fire: { typed_legacy_v1_record_admission_guard: MEMBERSHIP_GUARD } }),
  typed_v1_preservation_proofs: defineTable({ name: "typed_v1_preservation_proofs", key: ["source_row_id"], token: ADMISSION_TOKEN,
    columns: [i64("source_row_id"), bytes("canonical_digest")], fire: { typed_legacy_v1_preservation_proof_guard: MEMBERSHIP_GUARD } }),
  typed_v11_manifest_memberships: defineTable({ name: "typed_v11_manifest_memberships", key: ["manifest_id"], token: ADMISSION_TOKEN,
    columns: [text("manifest_id"), i64("typed_manifest_id")], fire: { typed_legacy_v11_manifest_membership_guard: MEMBERSHIP_GUARD } }),
  typed_v11_record_proofs: defineTable({ name: "typed_v11_record_proofs", key: ["typed_record_id"], token: ADMISSION_TOKEN,
    columns: [i64("typed_record_id"), i64("chunk_key"), i64("manifest_key"), i16("stream_code"), bytes("occurrence_blob"),
      bytes("base_digest"), bytes("legacy_occurrence_blob"), bytes("legacy_digest"), i64("observed_at_ms")],
    fire: { typed_legacy_v11_record_proof_guard: MEMBERSHIP_GUARD } }),
  typed_v1_event_sources: defineTable({ name: "typed_v1_event_sources", key: ["event_digest"], token: ADMISSION_TOKEN,
    columns: [text("event_digest"), text("owner_digest"), text("participant_id"), text("chunk_id"), text("source_namespace")],
    fire: {
      typed_v1_event_source_membership_guard: "Insert guard: the owner link, chunk and typed lineage of the event source; it holds for a consistent seal.",
      typed_v1_event_source_retention_guard: UPDATE_ONLY,
    } }),
  storage_v11_event_sources: defineTable({ name: "storage_v11_event_sources", key: ["event_digest"], token: ADMISSION_TOKEN,
    columns: [text("event_digest"), text("owner_digest"), text("participant_id"), text("device_id"), text("generation_id"),
      text("manifest_digest"), day("from_day"), day("through_day"), i64("head_revision"), i64("input_revision"), i64("recorded_ms")],
    fire: {
      storage_v11_event_source_membership_guard: "Insert guard: the owner link and the published v1.1 chain of the event source; it holds for a consistent seal.",
      storage_v11_event_source_retention_guard: UPDATE_ONLY,
    } }),
});

const ADMISSION_ITEMS = Object.freeze(Object.values(ADMISSION_TABLES).map(spec => Object.freeze({ kind: "table", spec })));
const ADMISSION_MUST_BE_EMPTY = Object.freeze(["typed_v1_authority_requests"]);

/** The sealed lineage the admission guards re-prove, ported from the rehearsal source's assertSourceReady. */
function assertAdmissionSource(database) {
  const count = (sql, table, code = "CUTOVER_SOURCE_LINEAGE_INVALID") => {
    if (sourceCount(database, sql, [], table) !== 0) fail(code, { table });
  };
  count("SELECT count(*) AS n FROM typed_v1_authority_requests", "typed_v1_authority_requests", "CUTOVER_ADMISSION_PENDING_REQUESTS");
  for (const [state, name] of [["typed_v1_admission_state", "v1"], ["typed_v11_admission_state", "v11"]]) {
    const [row] = sourceAll(database, `SELECT count(*) AS n, min(runtime_contract_version) AS version FROM ${state} WHERE id = 1`, [], state);
    if (row?.n !== 1n || row?.version !== 1n || sourceCount(database, `SELECT count(*) AS n FROM ${state}`, [], state) !== 1) {
      fail("CUTOVER_SOURCE_LINEAGE_INVALID", { table: state });
    }
    if (name.length === 0) fail("CUTOVER_SOURCE_LINEAGE_INVALID");
  }
  count(`SELECT count(*) AS n FROM typed_v1_chunk_allocations allocation
    LEFT JOIN telemetry_v1_chunks chunk ON chunk.id = allocation.chunk_id
    WHERE chunk.id IS NULL OR chunk.record_count != allocation.record_count`, "typed_v1_chunk_allocations");
  count(`SELECT count(*) AS n FROM typed_v11_chunk_allocations allocation
    LEFT JOIN telemetry_v11_chunks chunk ON chunk.id = allocation.chunk_id
    WHERE chunk.id IS NULL OR chunk.record_count != allocation.record_count`, "typed_v11_chunk_allocations");
  count(`SELECT count(*) AS n FROM typed_telemetry_records record WHERE record.format = 10 AND NOT EXISTS (
    SELECT 1 FROM typed_v1_record_admissions admission WHERE admission.typed_record_id = record.id)`,
  "typed_v1_record_admissions", "CUTOVER_ADMISSION_PROOF_INCOMPLETE");
  count(`SELECT count(*) AS n FROM typed_v1_record_admissions admission
    JOIN typed_telemetry_records record ON record.id = admission.typed_record_id WHERE record.format != 10`,
  "typed_v1_record_admissions", "CUTOVER_ADMISSION_PROOF_INCOMPLETE");
  count(`SELECT count(*) AS n FROM typed_v11_record_proofs proof
    LEFT JOIN typed_v11_manifest_memberships membership ON membership.typed_manifest_id = proof.manifest_key
    WHERE membership.typed_manifest_id IS NULL`, "typed_v11_record_proofs");
  count(`SELECT count(*) AS n FROM typed_telemetry_records record WHERE record.format = 11 AND NOT EXISTS (
    SELECT 1 FROM typed_v11_manifest_memberships membership WHERE membership.typed_manifest_id = record.manifest_id)`,
  "typed_v11_manifest_memberships");
  count(`SELECT count(*) AS n FROM telemetry_v11_day_manifests manifest
    WHERE (EXISTS (SELECT 1 FROM typed_v11_manifest_memberships membership WHERE membership.manifest_id = manifest.id)
        OR EXISTS (SELECT 1 FROM typed_v11_manifest_memberships membership
          JOIN typed_v11_record_proofs proof ON proof.manifest_key = membership.typed_manifest_id
         WHERE membership.manifest_id = manifest.id))
      AND (manifest.state != 'ready' OR manifest.expected_chunk_count != (
        SELECT count(*) FROM telemetry_v11_chunks chunk WHERE chunk.manifest_id = manifest.id))`,
  "telemetry_v11_day_manifests", "CUTOVER_ADMISSION_SOURCE_UNQUALIFIED");
  count(`SELECT count(*) AS n FROM typed_telemetry_records record
    JOIN typed_v11_manifest_memberships membership ON membership.typed_manifest_id = record.manifest_id
    JOIN telemetry_v11_day_manifests manifest ON manifest.id = membership.manifest_id AND manifest.state = 'ready'
    WHERE record.format = 11 AND NOT EXISTS (SELECT 1 FROM typed_v11_record_proofs proof WHERE proof.typed_record_id = record.id)`,
  "typed_v11_record_proofs", "CUTOVER_ADMISSION_PROOF_INCOMPLETE");
}

const ADMISSION_DEFINITION = Object.freeze({
  stage: ADMISSION,
  schemaTag: SCHEMA_TAG(ADMISSION),
  prerequisites: Object.freeze(["identity-authority", "telemetry-v1-v11", "typed-legacy"]),
  items: ADMISSION_ITEMS,
  extraSealed: Object.freeze([...ADMISSION_MUST_BE_EMPTY, "typed_telemetry_records", "telemetry_v1_chunks",
    "telemetry_v11_chunks", "telemetry_v11_day_manifests"]),
  policySha256: stagePolicySha256(ADMISSION, ADMISSION_ITEMS, [ADMISSION_MUST_BE_EMPTY]),
  sourcePreflight({ database }) {
    assertAdmissionSource(database);
    return Object.freeze({ pendingAuthorityRequests: 0 });
  },
  async targetPreflight({ client, handle, database }) {
    await assertParentReceipts(client, handle, database, "telemetry-v1-v11",
      ["telemetry_v1_chunks", "telemetry_v11_day_manifests", "telemetry_v11_chunks", "telemetry_v11_domain_heads"]);
    await assertParentReceipts(client, handle, database, "typed-legacy",
      ["typed_telemetry_records", "typed_telemetry_chunks", "typed_telemetry_manifests", "typed_telemetry_devices"]);
    await assertParentReceipts(client, handle, database, "identity-authority", ["participants", "storage_v11_owner_links"]);
    return Object.freeze({ parentReceipts: true });
  },
  async extraReceipts({ handle, database }) {
    const facts = {};
    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      for (const table of ADMISSION_MUST_BE_EMPTY) {
        const digest = genericSealedDigest(database, table);
        if (digest.rows !== 0) fail("CUTOVER_ADMISSION_PENDING_REQUESTS", { table });
        await tableReceipt(client, handle, { stage: ADMISSION, sourceRole: "ingestion", sourceTable: table,
          disposition: "must-be-empty", state: "complete", sourceRowCount: 0, sourceSha256: digest.sha256 });
        facts[table] = Object.freeze({ rows: 0, sha256: digest.sha256 });
      }
    });
    return Object.freeze(facts);
  },
});

export function runLegacyAdmissionProduction(options) {
  return runTelemetryStage(ADMISSION_DEFINITION, options);
}

// ---------------------------------------------------------------------------
// Stage: header-promotion.
//
// The historical-header mirror and archive of the rehearsal pipeline (0040)
// exist so that importing D1 headers can never consume upload authorizations
// or fire live-ingest side effects. In production the v1/v1.1 headers are
// imported into their live tables by 'telemetry-v1-v11' under the reviewed
// trigger policy, so there is nothing to mirror, nothing to promote and
// nothing to drop: the stage proves that the live header tables equal the
// seal (digests recomputed from the seal and the target and equal to the
// 'telemetry-v1-v11' receipts) and records that proof as its receipt.

const HEADER = "header-promotion";
const HEADER_SPECS = Object.freeze([TELEMETRY_V1_CHUNKS, TELEMETRY_V11_DAY_MANIFESTS, TELEMETRY_V11_CHUNKS]);

const HEADER_ITEMS = Object.freeze([Object.freeze({
  kind: "step",
  name: "live-headers-equal-seal",
  async run({ handle, schema, database, maxRows }) {
    const sealedFacts = HEADER_SPECS.map(spec => [spec, sourceTableFacts(database, spec, maxRows)]);
    return withTransferTransaction(handle, "primary", async client => {
      const receipts = await readStageTableReceipts(client, handle, V1_V11);
      const tables = {};
      for (const [spec, sealedFact] of sealedFacts) {
        const target = await targetTableFacts(client, schema, spec);
        const receipt = receipts.find(row => row.source_table === spec.sealedTable);
        if (target.rows !== sealedFact.rows || target.sha256 !== sealedFact.sha256 || receipt === undefined
            || receipt.state !== "complete" || receipt.source_sha256 !== sealedFact.sha256
            || receipt.target_sha256 !== target.sha256 || Number(receipt.target_row_count) !== target.rows) {
          fail("CUTOVER_TELEMETRY_TABLE_DIGEST_MISMATCH", { table: spec.target, stage: HEADER });
        }
        tables[spec.name] = Object.freeze({ rows: target.rows, sha256: target.sha256 });
      }
      return Object.freeze({ tables: Object.freeze(tables), headerManifestSha256: HASH(JSON.stringify(tables)) });
    }, { readOnly: true });
  },
})]);

const HEADER_DEFINITION = Object.freeze({
  stage: HEADER,
  schemaTag: SCHEMA_TAG(HEADER),
  prerequisites: Object.freeze(["identity-authority", "telemetry-v1-v11", "legacy-admission"]),
  items: HEADER_ITEMS,
  extraSealed: Object.freeze(HEADER_SPECS.map(spec => spec.sealedTable)),
  policySha256: stagePolicySha256(HEADER, HEADER_ITEMS, [HEADER_SPECS.map(spec => spec.name)]),
  countedTables: Object.freeze([]),
});

export function runHeaderPromotionProduction(options) {
  return runTelemetryStage(HEADER_DEFINITION, options);
}

// ---------------------------------------------------------------------------
// Stage: telemetry-v12 (T-2).
//
// The v1.2 telemetry family. The identity-side tables T-2's rehearsal also
// copies (telemetry_v12_device_capabilities, accountless_v12_device_
// authorizations, device_upload_authorizations) belong to PT-3 and are not
// imported here. Manifests go in staged, children after them, and the sealed
// ready manifests are promoted after their rows (PostgreSQL's ready-day
// integrity guard re-proves each complete day), before any domain day names
// them. Chunk-owned registrations are imported with their chunks.

const V12 = "telemetry-v12";
const V12_TOKEN = `imported:${V12}`;
const V12_MAPPED = `mapped:${V12}`;
const V12_STAGED = "'staged'";
void V12_STAGED;

const V12_RUNTIME = defineTable({
  name: "telemetry_v12_runtime", target: "telemetry_v12_typed_runtime", key: ["id"], mode: "update-seeded", token: V12_MAPPED,
  columns: [i32("id"), text("schema_version"), text("envelope_schema_version"), text("field_dictionary_version"),
    text("privacy_contract_version"), text("state"), i32("policy_revision"), i32("max_day_chunks"), i32("max_chunk_records"),
    i32("max_day_bytes"), instant("changed_at")],
});

// D1 keeps one runtime row; PostgreSQL also has the transport runtime whose
// revision starts at 0 where D1's policy revision starts at 1 (every
// activation increments both).
const V12_RUNTIME_TRANSPORT = defineTable({
  name: "telemetry_v12_runtime_transport", sealedTable: "telemetry_v12_runtime", target: "telemetry_v12_runtime", key: ["id"],
  mode: "update-seeded", token: V12_MAPPED, receipt: false,
  columns: [i32("id"), text("state"), i32("revision", { sql: "\"policy_revision\" - 1" }), instant("changed_at")],
  closure: [{ table: "telemetry_v12_runtime", columns: ["id", "state", "changed_at", "policy_revision"], omitted: {
    schema_version: "carried by the typed runtime spec", envelope_schema_version: "carried by the typed runtime spec",
    field_dictionary_version: "carried by the typed runtime spec", privacy_contract_version: "carried by the typed runtime spec",
    max_day_chunks: "carried by the typed runtime spec", max_chunk_records: "carried by the typed runtime spec",
    max_day_bytes: "carried by the typed runtime spec",
  } }],
});

const V12_DAY_MANIFESTS = defineTable({
  name: "telemetry_v12_day_manifests", large: true, key: ["id"], token: V12_TOKEN,
  columns: [text("id"), text("participant_id"), text("device_id"), day("chunk_day"), text("manifest_digest"),
    text("parser_version"), text("manifest_json"), i32("expected_chunk_count"),
    col("state", "text", { override: () => "staged" }), instant("created_at"),
    col("ready_at", "instant", { override: () => null })],
  fire: {
    telemetry_v12_day_manifest_retention_guard: "Refuses a ready manifest's change; the manifests are inserted staged and promoted by the reviewed ready transition.",
    telemetry_v12_manifest_immutable_guard: "Refuses a manifest a published day already covers; the domain days are imported after the manifests.",
    telemetry_v12_manifest_ready_integrity_guard: "Re-proves a complete day at the staged-to-ready promotion: chunk declarations, record counts, children.",
  },
});

const V12_CHUNKS = defineTable({
  name: "telemetry_v12_chunks", key: ["id"], token: V12_TOKEN,
  columns: [text("id"), text("manifest_id"), text("participant_id"), text("device_id"), text("stream"), day("chunk_day"),
    i32("chunk_seq"), text("chunk_id"), text("chunk_digest"), text("envelope_digest"), text("parser_version"),
    i32("record_count"), text("r2_key"), text("device_upload_authorization_id"), instant("created_at")],
  suppress: {
    telemetry_v12_chunks_reconciliation_guard: "Live admission needs a registered object; chunk-owned registrations are imported verbatim from the seal.",
  },
  fire: {
    telemetry_v12_chunk_immutable_guard: "Refuses a chunk of an already published manifest; the domain days are imported last.",
    telemetry_v12_chunk_retention_guard: "Admits a chunk only under a staged manifest; the manifests are imported staged.",
  },
  beforeInsert: chunkRegistrationHook("telemetry_v12_chunks", REGISTRATION_KINDS.telemetry_v12),
});

const V12_ATTRIBUTIONS = defineTable({
  name: "telemetry_v12_attributions", target: "telemetry_v12_typed_attributions", key: ["id"], token: V12_MAPPED,
  columns: [i64("id"), i16("account_basis"), bytes("account_track"), i16("plan_basis"), i64("plan_type_id"), bytes("plan_era")],
  fire: { telemetry_v12_typed_attribution_immutable: UPDATE_ONLY },
});

const V12_RECORDS = defineTable({
  name: "telemetry_v12_records", target: "telemetry_v12_typed_records", key: ["id"], token: V12_MAPPED,
  columns: [i64("id"), text("chunk_id"), text("manifest_id"), text("stream"), i32("record_index"), bytes("occurrence_id"),
    i64("observed_at_ms"), i32("observed_day"), i64("provider_id"), bytes("canonical_digest")],
  suppress: {
    telemetry_v12_typed_record_admission: "Requires the writer's v1.2 grant to be active now; retained history may belong to an expired or opted-out grant. The sealed-source preflight proves chunk, manifest, stream, day and count instead.",
  },
  fire: {
    telemetry_v12_typed_record_delete_guard: UPDATE_ONLY,
    telemetry_v12_typed_record_immutable: UPDATE_ONLY,
    telemetry_v12_typed_record_retention_guard: "Admits a record only under a staged manifest; the manifests are imported staged.",
  },
});

const V12_USAGE = defineTable({
  name: "telemetry_v12_usage", target: "telemetry_v12_typed_usage", key: ["record_id"], token: V12_MAPPED,
  columns: [i64("record_id"), bytes("session_id"), i64("model_id"), i64("speed_mode_id"), i64("api_service_tier_id"),
    i64("surface_id"), i64("billing_surface_id"), i64("reasoning_effort_id"), i64("agent_scope_id"), i64("outcome_id"),
    i64("attribution_id"), i64("total_input_context_tokens"), i64("input_uncached_tokens"), i64("input_cache_read_tokens"),
    i64("input_cache_write_tokens"), i64("output_text_tokens"), i64("output_reasoning_tokens"), i64("output_combined_tokens"),
    i32("boundary_flags"), i32("tie_order"), i64("cache_write_ttl_five_minute_tokens"), i64("cache_write_ttl_one_hour_tokens")],
  fire: {
    telemetry_v12_typed_usage_admission: "Insert guard: the child must hang off a usage record; it holds for the sealed rows.",
    telemetry_v12_typed_usage_delete_guard: UPDATE_ONLY,
    telemetry_v12_typed_usage_immutable: UPDATE_ONLY,
    telemetry_v12_typed_usage_retention_guard: "Admits a child only under a staged manifest; the manifests are imported staged.",
  },
});

const V12_QUOTA = defineTable({
  name: "telemetry_v12_quota", target: "telemetry_v12_typed_quota", key: ["record_id"], token: V12_MAPPED,
  columns: [i64("record_id"), i64("plan_type_id"), i64("plan_variant_id"), i64("limit_id"), i64("slot_id"),
    real("used_percent"), i32("window_duration_minutes"), i64("resets_at_ms"), i64("attribution_id")],
  fire: {
    telemetry_v12_typed_quota_admission: "Insert guard: the child must hang off a quota record; it holds for the sealed rows.",
    telemetry_v12_typed_quota_delete_guard: UPDATE_ONLY,
    telemetry_v12_typed_quota_immutable: UPDATE_ONLY,
    telemetry_v12_typed_quota_retention_guard: "Admits a child only under a staged manifest; the manifests are imported staged.",
  },
});

const V12_SESSION_TOOLS = defineTable({
  name: "telemetry_v12_session_tools", target: "telemetry_v12_typed_session_tools", key: ["record_id", "tool_class_id"],
  token: V12_MAPPED,
  columns: [i64("record_id"), i64("tool_class_id"), i64("count")],
  fire: {
    telemetry_v12_typed_session_admission: "Insert guard: the child must hang off a session record; it holds for the sealed rows.",
    telemetry_v12_typed_session_retention_guard: "Admits a child only under a staged manifest; the manifests are imported staged.",
    telemetry_v12_typed_session_tool_delete_guard: UPDATE_ONLY,
    telemetry_v12_typed_session_tool_immutable: UPDATE_ONLY,
  },
});

const V12_DOMAIN_PREDECESSORS = defineTable({
  name: "telemetry_v12_domain_predecessors", large: true, key: ["token_hash"], token: V12_TOKEN,
  columns: [text("token_hash"), text("participant_id"), text("device_id"), text("previous_generation_id"),
    text("legacy_fingerprint"), i32("input_revision"), day("from_day"), day("through_day"), text("days_json"),
    instant("created_at"), instant("expires_at"), instant("consumed_at")],
});

const V12_DOMAINS = defineTable({
  name: "telemetry_v12_domains", large: true, key: ["id"], token: V12_TOKEN,
  columns: [text("id"), text("participant_id"), text("device_id"), text("predecessor_token_hash"), text("previous_generation_id"),
    text("manifest_digest"), text("legacy_fingerprint"), i32("input_revision"), day("from_day"), day("through_day"),
    text("days_json"), instant("created_at")],
  fire: { telemetry_v12_domain_immutable_guard: UPDATE_ONLY },
});

const V12_DOMAIN_DAYS = defineTable({
  name: "telemetry_v12_domain_days", key: ["generation_id", "observed_day"], token: V12_TOKEN,
  columns: [text("generation_id"), day("observed_day"), text("manifest_id"), text("manifest_digest")],
  suppress: {
    telemetry_v12_domain_day_immutable_guard: "Admits an activation insert before its head only; sealed generations are inserted whole, an older one already has its successor.",
  },
});

const V12_DOMAIN_HEADS = defineTable({
  name: "telemetry_v12_domain_heads", key: ["participant_id"], token: V12_TOKEN,
  columns: [text("participant_id"), text("generation_id"), i32("revision"), instant("updated_at")],
  suppress: {
    storage_v12_head_publication: "Appends the live owner journal and input revisions; those are sealed history imported by their own stages, so a copied head must not mint a second event.",
  },
});

const PROMOTE_READY_MANIFESTS = "promote-ready-manifests";
const V12_CHUNK_TABLES = Object.freeze([["telemetry_v12_chunks", REGISTRATION_KINDS.telemetry_v12]]);

/**
 * Every chunk family whose registrations a telemetry stage maps, as
 * [sealed chunk table, PostgreSQL pending_objects kind]. The
 * 'pending-registrations' stage (D-PT4X) applies the same mapping to every
 * sealed registration, so the rows these stages wrote verify field by field.
 */
export const CHUNK_REGISTRATION_FAMILIES = Object.freeze([...V1_V11_CHUNK_TABLES, ...V12_CHUNK_TABLES]);

function promoteReadyManifestsStep(stage) {
  return Object.freeze({
    kind: "step",
    name: PROMOTE_READY_MANIFESTS,
    async run({ handle, schema, database, maxRows, onPage }) {
      const name = `step:${PROMOTE_READY_MANIFESTS}`;
      const readyCount = sourceCount(database, "SELECT count(*) AS n FROM telemetry_v12_day_manifests WHERE state = 'ready'", [],
        "telemetry_v12_day_manifests");
      const done = await withTransferTransaction(handle, "primary", async client => {
        await requireImportingRun(client, handle);
        return readCheckpoint(client, handle, { stage, name });
      }, { readOnly: true });
      const targetReady = client => targetQuery(client, `SELECT count(*)::text AS n FROM ${quote(schema)}."telemetry_v12_day_manifests"
        WHERE state = 'ready'`, [], "telemetry_v12_day_manifests");
      if (done?.state === "complete") {
        const present = await withTransferTransaction(handle, "primary", async client => Number((await targetReady(client)).rows[0].n),
          { readOnly: true });
        if (present !== readyCount || done.rowCount !== readyCount) fail("CUTOVER_TARGET_ROW_COUNT_DIVERGED", { table: "telemetry_v12_day_manifests" });
        return Object.freeze({ promoted: readyCount, sha256: done.prefixChainSha256 });
      }
      let chain = EMPTY_PREFIX_CHAIN;
      let after = null;
      let pages = 0;
      for (;;) {
        const page = sourceAll(database, `SELECT id, ready_at FROM telemetry_v12_day_manifests WHERE state = 'ready'
          ${after === null ? "" : "AND id > ?"} ORDER BY id LIMIT ?`, after === null ? [maxRows] : [after, maxRows],
        "telemetry_v12_day_manifests");
        if (page.length === 0) break;
        const ids = [];
        const readyAt = [];
        for (const row of page) {
          const [id] = canonicalSourceValue("text", row.id, "telemetry_v12_day_manifests", "id");
          const [moment] = canonicalSourceValue("instant", row.ready_at, "telemetry_v12_day_manifests", "ready_at");
          if (moment === null) fail("CUTOVER_V12_SOURCE_INVALID", { table: "telemetry_v12_day_manifests", column: "ready_at" });
          ids.push(id);
          readyAt.push(moment);
          chain = advancePrefixChain(chain, [id, moment]);
        }
        await withTransferTransaction(handle, "primary", async client => {
          await requireImportingRun(client, handle);
          // Idempotent: a manifest promoted before a kill stays as it is.
          await targetQuery(client, `UPDATE ${quote(schema)}."telemetry_v12_day_manifests" manifest
              SET state = 'ready', ready_at = item.ready_at
             FROM unnest($1::text[], $2::timestamptz[]) AS item(id, ready_at)
            WHERE manifest.id = item.id AND manifest.state = 'staged'`, [ids, readyAt], "telemetry_v12_day_manifests");
        });
        pages += 1;
        after = ids.at(-1);
        await onPage?.({ table: PROMOTE_READY_MANIFESTS, page: pages, rows: page.length });
        if (page.length < maxRows) break;
      }
      await withTransferTransaction(handle, "primary", async client => {
        await requireImportingRun(client, handle);
        const present = Number((await targetReady(client)).rows[0].n);
        if (present !== readyCount) fail("CUTOVER_TARGET_ROW_COUNT_DIVERGED", { table: "telemetry_v12_day_manifests" });
        await recordCheckpoint(client, handle, { stage, name, state: "complete", rowCount: readyCount, prefixChainSha256: chain });
      });
      return Object.freeze({ promoted: readyCount, sha256: chain });
    },
  });
}

const DAY_OF_MS = "((record.observed_at_ms - (((record.observed_at_ms % 86400000) + 86400000) % 86400000)) / 86400000)";

/**
 * What the suppressed record-admission trigger proved, minus the live grant:
 * same manifest and stream as the chunk, the UTC day of the instant, the
 * chunk's own day, and never more records than the chunk declares; plus the
 * consumed upload authorization of every chunk and the manifest state shape.
 * (The dictionary and authorization parents are covered by the sealed
 * foreign-key closure.)
 */
function assertV12Source(database) {
  const zero = (sql, table) => {
    if (sourceCount(database, sql, [], table) !== 0) fail("CUTOVER_V12_SOURCE_INVALID", { table });
  };
  zero(`SELECT count(*) AS n FROM telemetry_v12_chunks chunk
    LEFT JOIN device_upload_authorizations authorization ON authorization.id = chunk.device_upload_authorization_id
    WHERE authorization.id IS NULL OR authorization.state != 'consumed' OR authorization.consumed_contribution_id IS NULL`,
  "device_upload_authorizations");
  zero(`SELECT count(*) AS n FROM telemetry_v12_records record
    JOIN telemetry_v12_chunks chunk ON chunk.id = record.chunk_id
    WHERE chunk.manifest_id != record.manifest_id OR chunk.stream != record.stream
       OR record.observed_day != ${DAY_OF_MS}
       OR record.observed_day != CAST(strftime('%s', chunk.chunk_day) AS INTEGER) / 86400`, "telemetry_v12_records");
  zero(`SELECT count(*) AS n FROM telemetry_v12_chunks chunk
    WHERE (SELECT count(*) FROM telemetry_v12_records record WHERE record.chunk_id = chunk.id) > chunk.record_count`,
  "telemetry_v12_chunks");
  zero(`SELECT count(*) AS n FROM telemetry_v12_day_manifests
    WHERE state NOT IN ('staged', 'ready') OR (state = 'ready') != (ready_at IS NOT NULL)`, "telemetry_v12_day_manifests");
}

const V12_ITEMS = Object.freeze([
  ...[V12_RUNTIME, V12_RUNTIME_TRANSPORT, V12_DAY_MANIFESTS, V12_CHUNKS, V12_ATTRIBUTIONS, V12_RECORDS, V12_USAGE, V12_QUOTA,
    V12_SESSION_TOOLS].map(spec => Object.freeze({ kind: "table", spec })),
  promoteReadyManifestsStep(V12),
  ...[V12_DOMAIN_PREDECESSORS, V12_DOMAINS, V12_DOMAIN_DAYS, V12_DOMAIN_HEADS].map(spec => Object.freeze({ kind: "table", spec })),
  chunkRegistrationStep(V12, V12_CHUNK_TABLES),
]);

const V12_DEFINITION = Object.freeze({
  stage: V12,
  schemaTag: SCHEMA_TAG(V12),
  prerequisites: Object.freeze(["identity-authority", "typed-legacy"]),
  items: V12_ITEMS,
  extraSealed: Object.freeze(["pending_quarantine_objects", "device_upload_authorizations"]),
  countedTables: Object.freeze(["telemetry_v12_runtime", "telemetry_v12_day_manifests", "telemetry_v12_chunks",
    "telemetry_v12_attributions", "telemetry_v12_records", "telemetry_v12_usage", "telemetry_v12_quota",
    "telemetry_v12_session_tools", "telemetry_v12_domain_predecessors", "telemetry_v12_domains", "telemetry_v12_domain_days",
    "telemetry_v12_domain_heads"]),
  policySha256: stagePolicySha256(V12, V12_ITEMS),
  sourcePreflight({ database }) {
    assertV12Source(database);
    const registrations = registrationFacts(database, V12_CHUNK_TABLES);
    return Object.freeze({ chunkRegistrations: registrations });
  },
  async targetPreflight({ client, handle, database }) {
    await assertParentReceipts(client, handle, database, "identity-authority",
      ["participants", "device_credentials", "device_upload_authorizations"]);
    await assertParentReceipts(client, handle, database, "typed-legacy", ["typed_telemetry_dictionary"]);
    return Object.freeze({ parentReceipts: true });
  },
  async finish({ client, handle, database }) {
    const highWater = await raiseIdentityHighWater(client, handle, sealedCounters(database));
    return Object.freeze({ highWaterTables: highWater.length });
  },
});

export function runTelemetryV12Production(options) {
  return runTelemetryStage(V12_DEFINITION, options);
}

// ---------------------------------------------------------------------------
// Stage: v12-event-sources.

const V12_EVENTS = "v12-event-sources";
const V12_EVENT_SOURCES = defineTable({
  name: "storage_v12_event_sources", key: ["event_digest"], token: `imported:${V12_EVENTS}`,
  columns: [text("event_digest"), text("owner_digest"), text("participant_id"), text("device_id"), text("generation_id"),
    text("previous_generation_id"), text("manifest_digest"), i64("head_revision"), i64("recorded_ms")],
  fire: {
    storage_v12_event_source_membership_guard: "OJ-1's chain guard: the owner link and the published v1.2 chain of the event source; it holds for a consistent seal.",
    storage_v12_event_source_retention_guard: UPDATE_ONLY,
  },
});
const V12_EVENTS_ITEMS = Object.freeze([Object.freeze({ kind: "table", spec: V12_EVENT_SOURCES })]);

const V12_EVENTS_DEFINITION = Object.freeze({
  stage: V12_EVENTS,
  schemaTag: SCHEMA_TAG(V12_EVENTS),
  prerequisites: Object.freeze(["identity-authority", "telemetry-v12"]),
  items: V12_EVENTS_ITEMS,
  policySha256: stagePolicySha256(V12_EVENTS, V12_EVENTS_ITEMS),
  async targetPreflight({ client, handle, database }) {
    await assertParentReceipts(client, handle, database, "telemetry-v12", ["telemetry_v12_domains", "telemetry_v12_domain_heads"]);
    await assertParentReceipts(client, handle, database, "identity-authority", ["participants", "storage_v11_owner_links"]);
    return Object.freeze({ parentReceipts: true });
  },
});

export function runV12EventSourcesProduction(options) {
  return runTelemetryStage(V12_EVENTS_DEFINITION, options);
}

// ---------------------------------------------------------------------------
// Stage: usage-correction.
//
// PostgreSQL's runtime is operationally staged and records D1's state in
// source_state (primary 0034): importing a sealed 'active' runtime enables
// nothing. The evidence tables are imported verbatim when present (the
// PT-8-lite correction gate decides whether a populated seal may proceed),
// and the transient cas guard must be empty.

const CORRECTION = "usage-correction";
const CORRECTION_IMPORTED = `imported:${CORRECTION}`;
const CORRECTION_RUNTIME = defineTable({
  name: "telemetry_usage_correction_runtime", key: ["id"], token: `mapped:${CORRECTION}`,
  columns: [i16("id"), text("schema_version"), text("method_version"), col("source_state", "text", { sealed: "state" }),
    i32("max_capture_rows"), i32("max_history_page")],
  fire: { telemetry_usage_correction_runtime_immutable: UPDATE_ONLY },
});
const CORRECTION_HISTORY_COLUMNS = Object.freeze([
  ["id", i64], ["participant_id", text], ["owner_digest", bytes], ["owner_revision", i64], ["authority_epoch", i64],
  ["source_format", i16], ["namespace_id", i64], ["owner_id", i64], ["device_id", i64], ["chunk_id", i64], ["manifest_id", i64],
  ["source_storage_row_id", i64], ["source_row_id", i64], ["occurrence_id", bytes], ["event_time_ms", i64],
  ["provider_id", i64], ["session_id", i64], ["model_id", i64], ["speed_mode_id", i64], ["api_service_tier_id", i64],
  ["surface_id", i64], ["billing_surface_id", i64], ["reasoning_effort_id", i64], ["agent_scope_id", i64],
  ["outcome_id", i64], ["attribution_id", i64], ["total_input_context_tokens", i64], ["input_uncached_tokens", i64],
  ["input_cache_read_tokens", i64], ["input_cache_write_tokens", i64], ["output_text_tokens", i64],
  ["output_reasoning_tokens", i64], ["output_combined_tokens", i64], ["source_chunk_digest", bytes],
  ["source_event_digest", bytes], ["record_digest", bytes], ["base_digest", bytes], ["captured_at_ms", i64],
]);
const CORRECTION_HISTORY = defineTable({
  name: "telemetry_usage_correction_history", key: ["id"], token: CORRECTION_IMPORTED,
  columns: CORRECTION_HISTORY_COLUMNS.map(([name, make]) => make(name)),
  fire: { telemetry_usage_correction_history_guard: "Insert guard: the participant must be active and its owner link active; it holds for the sealed rows." },
});
const CORRECTION_FACTS = defineTable({
  name: "telemetry_usage_correction_facts", key: ["id"], token: CORRECTION_IMPORTED,
  columns: [i64("id"), i64("history_id"), i16("method_version"), i64("captured_at_ms")],
  fire: { telemetry_usage_correction_fact_guard: "Insert guard: the fact must name its history row; it holds for the sealed rows." },
});
const CORRECTION_ITEMS = Object.freeze([CORRECTION_RUNTIME, CORRECTION_HISTORY, CORRECTION_FACTS]
  .map(spec => Object.freeze({ kind: "table", spec })));
const CORRECTION_MUST_BE_EMPTY = Object.freeze(["telemetry_usage_correction_cas_guard"]);

const CORRECTION_DEFINITION = Object.freeze({
  stage: CORRECTION,
  schemaTag: SCHEMA_TAG(CORRECTION),
  prerequisites: Object.freeze(["identity-authority", "typed-legacy", "legacy-admission"]),
  items: CORRECTION_ITEMS,
  extraSealed: Object.freeze([...CORRECTION_MUST_BE_EMPTY]),
  policySha256: stagePolicySha256(CORRECTION, CORRECTION_ITEMS, [CORRECTION_MUST_BE_EMPTY]),
  sourcePreflight({ database, facts }) {
    if (facts.get("telemetry_usage_correction_runtime").rows !== 1) {
      fail("CUTOVER_SOURCE_LINEAGE_INVALID", { table: "telemetry_usage_correction_runtime" });
    }
    if (sourceCount(database, "SELECT count(*) AS n FROM telemetry_usage_correction_cas_guard", [],
      "telemetry_usage_correction_cas_guard") !== 0) {
      fail("CUTOVER_CORRECTION_CAS_GUARD_PRESENT", { table: "telemetry_usage_correction_cas_guard" });
    }
    const orphan = sourceCount(database, `SELECT count(*) AS n FROM telemetry_usage_correction_facts fact
      LEFT JOIN telemetry_usage_correction_history history ON history.id = fact.history_id
      WHERE history.id IS NULL OR fact.method_version <> 1 OR fact.captured_at_ms <> history.captured_at_ms`, [],
    "telemetry_usage_correction_facts");
    const missing = sourceCount(database, `SELECT count(*) AS n FROM telemetry_usage_correction_history history
      LEFT JOIN telemetry_usage_correction_facts fact ON fact.history_id = history.id AND fact.method_version = 1
      WHERE fact.id IS NULL`, [], "telemetry_usage_correction_history");
    if (orphan !== 0 || missing !== 0) fail("CUTOVER_SOURCE_LINEAGE_INVALID", { table: "telemetry_usage_correction_facts" });
    const [runtime] = sourceAll(database, "SELECT state FROM telemetry_usage_correction_runtime WHERE id = 1", [],
      "telemetry_usage_correction_runtime");
    return Object.freeze({ runtimeSourceState: runtime.state, history: facts.get("telemetry_usage_correction_history").rows,
      facts: facts.get("telemetry_usage_correction_facts").rows });
  },
  async targetPreflight({ client, handle, database }) {
    await assertParentReceipts(client, handle, database, "identity-authority", ["participants", "storage_v11_owner_links"]);
    return Object.freeze({ parentReceipts: true });
  },
  async extraReceipts({ handle, database }) {
    const facts = {};
    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      for (const table of CORRECTION_MUST_BE_EMPTY) {
        const digest = genericSealedDigest(database, table);
        if (digest.rows !== 0) fail("CUTOVER_CORRECTION_CAS_GUARD_PRESENT", { table });
        await tableReceipt(client, handle, { stage: CORRECTION, sourceRole: "ingestion", sourceTable: table,
          disposition: "must-be-empty", state: "complete", sourceRowCount: 0, sourceSha256: digest.sha256 });
        facts[table] = Object.freeze({ rows: 0, sha256: digest.sha256 });
      }
    });
    return Object.freeze(facts);
  },
});

export function runUsageCorrectionProduction(options) {
  return runTelemetryStage(CORRECTION_DEFINITION, options);
}

// ---------------------------------------------------------------------------
// Stage: ingestion-journal.
//
// storage_source_state first (the derivation trigger needs it and the sealed
// final authority epoch), then the exact journal rows in sequence order with
// every derivation trigger live: storage_owner_revision_advance derives the
// owner heads from the exact rows and refuses an unproven head, so a
// tampered chain cannot import. PostgreSQL's owner_revision stays 0 (the
// non-authoritative compatibility value) and event_tuple_version 1; the D1
// revision lands in the exact-tuple revision column.

const JOURNAL = "ingestion-journal";
const JOURNAL_TOKEN = `imported:${JOURNAL}`;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const JOURNAL_SOURCE_STATE = defineTable({
  name: "storage_source_state", key: ["singleton"], token: JOURNAL_TOKEN,
  columns: [i32("singleton"), text("source_id"), i64("authority_epoch")],
});
const JOURNAL_CHANGES = defineTable({
  name: "storage_ingestion_changes", key: ["source_id", "sequence"], token: JOURNAL_TOKEN,
  columns: [
    text("source_id", { sql: "(SELECT source_id FROM storage_source_state WHERE singleton = 1)" }), i64("sequence"),
    text("event_digest"), text("owner_digest"), i64("owner_revision", { sql: "0" }), i64("authority_epoch"), text("kind"),
    i64("recorded_ms"), i16("event_tuple_version", { sql: "1" }), i64("revision"), text("object_digest"),
    text("content_digest"), i64("public_authority_epoch"),
  ],
  fire: {
    storage_ingestion_exact_event_retained: UPDATE_ONLY,
    storage_ingestion_tuple_mixing_guard: "Insert guard for version-0 rows only; the import writes exact version-1 tuples.",
    storage_owner_revision_advance: "The derivation of owner heads from exact rows; never bypassed, it proves the chain continuity.",
    community_daily_terminal_event_withdrawal: "A terminal event withdraws published daily rows; none exist before the first publication.",
    terminal_event_publication_invalidation: "A terminal event invalidates publications; none exist before the first publication.",
  },
});
const JOURNAL_ITEMS = Object.freeze([JOURNAL_SOURCE_STATE, JOURNAL_CHANGES].map(spec => Object.freeze({ kind: "table", spec })));

/** The sealed journal's own invariants (the rehearsal source's validateSqliteRows). */
function assertJournalSource(database) {
  const [state] = sourceAll(database, "SELECT singleton, source_id, authority_epoch FROM storage_source_state", [], "storage_source_state");
  if (!state || sourceCount(database, "SELECT count(*) AS n FROM storage_source_state", [], "storage_source_state") !== 1
      || state.singleton !== 1n || typeof state.source_id !== "string" || !SOURCE_ID.test(state.source_id)
      || typeof state.authority_epoch !== "bigint" || state.authority_epoch < 0n) {
    fail("CUTOVER_JOURNAL_SOURCE_INVALID", { table: "storage_source_state" });
  }
  const invalidRows = sourceCount(database, `SELECT count(*) AS n FROM storage_ingestion_changes
    WHERE sequence < 1 OR revision < 1 OR authority_epoch < 1 OR public_authority_epoch < 1 OR recorded_ms < 0
       OR kind NOT IN ('source-updated','owner-active','owner-withdrawn','owner-erased')
       OR length(event_digest) <> 64 OR event_digest GLOB '*[^0-9a-f]*'
       OR length(owner_digest) <> 64 OR owner_digest GLOB '*[^0-9a-f]*'
       OR length(object_digest) <> 64 OR object_digest GLOB '*[^0-9a-f]*'
       OR length(content_digest) <> 64 OR content_digest GLOB '*[^0-9a-f]*'`, [], "storage_ingestion_changes");
  const invalidTransitions = sourceCount(database, `WITH ordered AS (
      SELECT sequence, owner_digest, revision, kind, authority_epoch, public_authority_epoch,
        lag(sequence,1,0) OVER(ORDER BY sequence) AS prior_sequence,
        lag(revision,1,0) OVER(PARTITION BY owner_digest ORDER BY sequence) AS prior_revision,
        lag(kind) OVER(PARTITION BY owner_digest ORDER BY sequence) AS prior_kind,
        lag(authority_epoch,1,0) OVER(PARTITION BY owner_digest ORDER BY sequence) AS prior_authority_epoch,
        lag(public_authority_epoch,1,0) OVER(ORDER BY sequence) AS prior_public_authority_epoch
      FROM storage_ingestion_changes
    )
    SELECT count(*) AS n FROM ordered
    WHERE sequence <> prior_sequence + 1
       OR revision <> prior_revision + 1
       OR authority_epoch <> prior_authority_epoch + CASE WHEN kind='source-updated' THEN 0 ELSE 1 END
       OR public_authority_epoch <> prior_public_authority_epoch + CASE WHEN kind='source-updated' THEN 0 ELSE 1 END
       OR (kind='source-updated' AND (prior_kind IS NULL OR prior_kind IN ('owner-withdrawn','owner-erased')))
       OR prior_kind='owner-erased'
       OR (kind IN ('owner-withdrawn','owner-erased') AND prior_kind IS NULL)`, [], "storage_ingestion_changes");
  const rowCount = BigInt(sourceCount(database, "SELECT count(*) AS n FROM storage_ingestion_changes", [], "storage_ingestion_changes"));
  const [bounds] = sourceAll(database, `SELECT coalesce(min(sequence),0) AS first_sequence, coalesce(max(sequence),0) AS last_sequence,
      coalesce((SELECT public_authority_epoch FROM storage_ingestion_changes ORDER BY sequence DESC LIMIT 1),0) AS latest_epoch
    FROM storage_ingestion_changes`, [], "storage_ingestion_changes");
  if (invalidRows !== 0 || invalidTransitions !== 0
      || (rowCount === 0n ? bounds.first_sequence !== 0n || bounds.last_sequence !== 0n || state.authority_epoch !== 0n
        : bounds.first_sequence !== 1n || bounds.last_sequence !== rowCount || bounds.latest_epoch !== state.authority_epoch)) {
    fail("CUTOVER_JOURNAL_SOURCE_INVALID", { table: "storage_ingestion_changes" });
  }
  return Object.freeze({ events: Number(rowCount), sourceAuthorityEpoch: state.authority_epoch.toString() });
}

const JOURNAL_DEFINITION = Object.freeze({
  stage: JOURNAL,
  schemaTag: SCHEMA_TAG(JOURNAL),
  prerequisites: Object.freeze(["identity-authority"]),
  items: JOURNAL_ITEMS,
  policySha256: stagePolicySha256(JOURNAL, JOURNAL_ITEMS),
  sourcePreflight({ database }) {
    return assertJournalSource(database);
  },
  async targetPreflight({ client, handle, database }) {
    await assertParentReceipts(client, handle, database, "identity-authority", ["storage_v11_owner_links"]);
    return Object.freeze({ parentReceipts: true });
  },
});

export function runIngestionJournalProduction(options) {
  return runTelemetryStage(JOURNAL_DEFINITION, options);
}

export function runTelemetryV1V11Production(options) {
  return runTelemetryStage(V1_V11_DEFINITION, options);
}

export const TELEMETRY_PRODUCTION_DEFINITIONS = Object.freeze({
  [V1_V11]: V1_V11_DEFINITION,
  [TYPED]: TYPED_DEFINITION,
  [ADMISSION]: ADMISSION_DEFINITION,
  [HEADER]: HEADER_DEFINITION,
  [V12]: V12_DEFINITION,
  [V12_EVENTS]: V12_EVENTS_DEFINITION,
  [CORRECTION]: CORRECTION_DEFINITION,
  [JOURNAL]: JOURNAL_DEFINITION,
});
for (const stage of TELEMETRY_PRODUCTION_STAGES) {
  if (!Object.hasOwn(TELEMETRY_PRODUCTION_DEFINITIONS, stage)) throw new TypeError("telemetry production stage undefined");
}

/** The runners PT-8-lite composes, by PT-1 stage name. Each takes { handle, sealManifestPath, pageRows?, pageBytes?, onPage?, onStep? }. */
export const TELEMETRY_PRODUCTION_RUNNERS = Object.freeze({
  [V1_V11]: runTelemetryV1V11Production,
  [TYPED]: runTypedLegacyProduction,
  [ADMISSION]: runLegacyAdmissionProduction,
  [HEADER]: runHeaderPromotionProduction,
  [V12]: runTelemetryV12Production,
  [V12_EVENTS]: runV12EventSourcesProduction,
  [CORRECTION]: runUsageCorrectionProduction,
  [JOURNAL]: runIngestionJournalProduction,
});

/**
 * One disposition per sealed ingestion table the eight stages own, for the
 * PT-8-lite coverage module: { role, table, token, stage, target } where the
 * token is exactly what the stage writes into its PT-1 table receipt.
 */
const EXTRA_DISPOSITIONS = Object.freeze([
  ...Object.keys(TYPED_LEGACY_SCHEMA_MARKERS).map(table => ({ table, token: "schema-marker", stage: TYPED, target: null })),
  ...ADMISSION_MUST_BE_EMPTY.map(table => ({ table, token: "must-be-empty", stage: ADMISSION, target: null })),
  ...CORRECTION_MUST_BE_EMPTY.map(table => ({ table, token: "must-be-empty", stage: CORRECTION, target: null })),
]);
export const TELEMETRY_PRODUCTION_DISPOSITIONS = Object.freeze([
  ...TELEMETRY_PRODUCTION_STAGES.flatMap(stage => TELEMETRY_PRODUCTION_DEFINITIONS[stage].items
    .filter(item => item.kind === "table" && item.spec.receipt)
    .map(item => Object.freeze({ role: "ingestion", table: item.spec.sealedTable, token: item.spec.token, stage,
      target: item.spec.target }))),
  ...EXTRA_DISPOSITIONS.map(item => Object.freeze({ role: "ingestion", ...item })),
]);
{
  const seen = new Set();
  for (const item of TELEMETRY_PRODUCTION_DISPOSITIONS) {
    if (seen.has(item.table)) throw new TypeError("telemetry production disposition duplicated");
    seen.add(item.table);
  }
}

/** The reviewed trigger policy of every target table a stage writes (PT-1 shape), merged for COMPLETE_TRIGGER_POLICY. */
export const TELEMETRY_PRODUCTION_TRIGGER_POLICY = Object.freeze(Object.fromEntries(
  TELEMETRY_PRODUCTION_STAGES.flatMap(stage => TELEMETRY_PRODUCTION_DEFINITIONS[stage].items
    .filter(item => item.kind === "table").map(item => [item.spec.target, specTriggerPolicy(item.spec)]))));

/** The name PT-8's runner contract uses for the same merged policy. */
export const TRIGGER_POLICY = TELEMETRY_PRODUCTION_TRIGGER_POLICY;

/**
 * No stage creates a staging or mirror relation in tibotattle_transfer, and no
 * stage retains one: both inventories are closed and empty (PT-1's staging
 * drop and control-schema allowlist therefore need no entry for these stages).
 */
export const PRODUCTION_STAGING_RELATIONS = Object.freeze([]);
export const PRODUCTION_RETAINED_RELATIONS = Object.freeze([]);

/** sha256 of every stage's frozen policy: tables, columns, closure, triggers, dispositions. */
export function telemetryProductionPolicySha256() {
  return HASH(JSON.stringify([TELEMETRY_PRODUCTION_STAGES.map(stage => [stage, TELEMETRY_PRODUCTION_DEFINITIONS[stage].policySha256]),
    TELEMETRY_PRODUCTION_DISPOSITIONS]));
}

export { TelemetryProductionError, specTriggerPolicy, sealedCounters, assertStageComplete };
