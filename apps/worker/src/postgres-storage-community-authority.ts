import { ApiError } from "./errors";
import { quotePostgresIdentifier, type PostgresClient } from "./postgres-client";
import {
  sameStorageCommunityAuthority,
  sameStorageCommunityCalculationAuthority,
  sameStorageCommunityHardAuthority,
  storageCommunityPublicationVisible,
  type StorageCommunityAuthority,
  type StorageCommunityOwner,
} from "./storage-community-authority";
import { COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION } from "./telemetry-v1-source-selection";

/**
 * PostgreSQL port of the typed Worker's community publication authority
 * (src/storage-community-authority.ts) over staged primary migration 0053.
 *
 * Every function runs on the caller's client, inside the caller's
 * transaction, and returns the Worker's own types so the publisher, reader,
 * graph and erasure ports compare pins with the Worker's pure predicates,
 * which are re-exported here rather than reimplemented. Failures keep the
 * Worker's contract: an unavailable or fenced authority is the plain
 * `STORAGE_COMMUNITY_AUTHORITY_UNAVAILABLE` error, an invalid collection
 * control row is `COLLECTION_CONTROL_UNAVAILABLE`, and a legacy terminal
 * without its explicit epoch floor is `BACKEND_STORAGE_UNAVAILABLE`. No
 * participant, digest or source identifier appears in an error.
 */

export {
  sameStorageCommunityAuthority,
  sameStorageCommunityCalculationAuthority,
  sameStorageCommunityHardAuthority,
  storageCommunityPublicationVisible,
};
export type { StorageCommunityAuthority, StorageCommunityOwner };

export interface CapturePostgresCommunityAuthorityOptions {
  /**
   * Retirement capture: cleanup must not depend on publication being enabled
   * or the public-source bootstrap being complete. Build and read callers
   * never pass it.
   */
  readonly retirement?: boolean;
  readonly sourceId?: string;
  readonly sourceNamespace?: string;
}

export interface ReadPostgresCommunityOwnerPageOptions {
  readonly afterParticipantId?: string;
  readonly limit?: number;
}

/** Content-free progress of the public contribution-source bootstrap. */
export interface PostgresPublicSourceBootstrapProgress {
  readonly completed: boolean;
  /** Journal-producing evidence still without its journal source row. */
  readonly pending: number;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const TERMINAL_KINDS = "('owner-withdrawn','owner-erased')";

const unavailable = (): Error => new Error("STORAGE_COMMUNITY_AUTHORITY_UNAVAILABLE");

function schemaName(schema: string): string {
  try {
    return quotePostgresIdentifier(schema);
  } catch {
    throw unavailable();
  }
}

function rows<Row extends object>(value: unknown): readonly Row[] {
  if (value === null || typeof value !== "object") throw unavailable();
  const result = Reflect.get(value, "rows");
  if (!Array.isArray(result)) throw unavailable();
  return result as readonly Row[];
}

/** A non-negative safe integer from a bigint column read as text or number. */
function count(value: unknown): number {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/u.test(value) ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw unavailable();
  return parsed;
}

interface CollectionControlRow {
  readonly revision: unknown;
  readonly control_state: unknown;
  readonly enrollment_enabled: unknown;
  readonly upload_registration_enabled: unknown;
  readonly processing_enabled: unknown;
  readonly publication_enabled: unknown;
}

interface ControlsRead {
  readonly revision: number;
  readonly publication: boolean;
}

/** readCollectionControls (src/collection-controls.ts) over PostgreSQL. */
async function readControls(client: PostgresClient, quoted: string): Promise<ControlsRead> {
  const failControls = (): never => { throw new ApiError(503, "COLLECTION_CONTROL_UNAVAILABLE"); };
  let selected: readonly CollectionControlRow[];
  try {
    selected = rows<CollectionControlRow>(await client.query(
      `SELECT revision::text AS revision,control_state,enrollment_enabled,upload_registration_enabled,
              processing_enabled,publication_enabled
         FROM ${quoted}.collection_controls WHERE singleton=1`,
    ));
  } catch {
    return failControls();
  }
  const row = selected[0];
  const flags = row === undefined ? [] : [row.enrollment_enabled, row.upload_registration_enabled,
    row.processing_enabled, row.publication_enabled];
  const revision = typeof row?.revision === "string" && /^[1-9][0-9]{0,15}$/u.test(row.revision)
    ? Number(row.revision) : Number.NaN;
  if (selected.length !== 1 || row === undefined || !flags.every((flag) => typeof flag === "boolean")
      || !["operational", "degraded", "contained"].includes(row.control_state as string)
      || !Number.isSafeInteger(revision) || revision < 1) {
    return failControls();
  }
  const enabled = flags.filter(Boolean).length;
  if ((row.control_state === "operational" && enabled !== 4)
      || (row.control_state === "contained" && enabled !== 0)
      || (row.control_state === "degraded" && (enabled === 0 || enabled === 4))) {
    return failControls();
  }
  return { revision, publication: row.publication_enabled === true };
}

interface AuthorityRow {
  readonly source_id: unknown;
  readonly source_namespace: unknown;
  readonly public_authority_epoch: unknown;
  readonly policy_revision: unknown;
  readonly collection_revision: unknown;
  readonly graph_invalidation_epoch: unknown;
  readonly source_epoch: unknown;
  readonly sequence: unknown;
}

/**
 * Capture the source-owned privacy and policy stamp (D1
 * captureStorageCommunityAuthority). `sequence` is the journal's MAX
 * sequence for the source, never the analytics delivery cursor. Outside
 * retirement it fails closed while publication is off or the public-source
 * bootstrap is incomplete, and the collection revision must equal the
 * separate controls read.
 */
export async function capturePostgresCommunityAuthority(
  client: PostgresClient,
  schema: string,
  options: CapturePostgresCommunityAuthorityOptions = {},
): Promise<StorageCommunityAuthority> {
  const quoted = schemaName(schema);
  const retirement = options.retirement === true;
  const controls = await readControls(client, quoted);
  if (!retirement && !controls.publication) throw unavailable();
  const selected = rows<AuthorityRow>(await client.query(
    `SELECT s.source_id,a.source_namespace,
            s.authority_epoch::text AS public_authority_epoch,i.policy_revision::text AS policy_revision,
            c.revision::text AS collection_revision,m.graph_invalidation_epoch::text AS graph_invalidation_epoch,
            m.mutation_epoch::text AS source_epoch,
            COALESCE((SELECT max(change.sequence) FROM ${quoted}.storage_ingestion_changes change
                       WHERE change.source_id=s.source_id),0)::text AS sequence
       FROM ${quoted}.storage_source_state s
       JOIN ${quoted}.typed_v1_admission_state a ON a.id=1 AND a.runtime_contract_version=1
       JOIN ${quoted}.typed_v11_admission_state b ON b.id=1 AND b.runtime_contract_version=1
        AND b.source_namespace=a.source_namespace
       JOIN ${quoted}.publication_state i ON i.singleton=1
       JOIN ${quoted}.collection_controls c ON c.singleton=1 AND ($1::boolean OR c.publication_enabled)
       JOIN ${quoted}.mutation_control m ON m.singleton_id=1
       JOIN ${quoted}.community_public_source_bootstrap p ON p.singleton=1
        AND ($1::boolean OR p.completed=1) AND p.policy_version=$2
      WHERE s.singleton=1`,
    [retirement, COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION],
  ));
  const row = selected[0];
  if (selected.length !== 1 || row === undefined
      || typeof row.source_id !== "string" || typeof row.source_namespace !== "string") {
    throw unavailable();
  }
  const authority: StorageCommunityAuthority = {
    sourceId: row.source_id,
    sourceNamespace: row.source_namespace,
    publicAuthorityEpoch: count(row.public_authority_epoch),
    policyRevision: count(row.policy_revision),
    collectionRevision: count(row.collection_revision),
    graphInvalidationEpoch: count(row.graph_invalidation_epoch),
    sourceEpoch: count(row.source_epoch),
    sequence: count(row.sequence),
  };
  if (authority.collectionRevision !== controls.revision
      || authority.policyRevision < 1 || authority.collectionRevision < 1
      || (options.sourceId !== undefined && options.sourceId !== authority.sourceId)
      || (options.sourceNamespace !== undefined && options.sourceNamespace !== authority.sourceNamespace)) {
    throw unavailable();
  }
  return Object.freeze(authority);
}

/**
 * Lightweight final fence for private per-owner work (D1
 * storageCommunityCalculationAuthorityIsCurrent): identity, policy and
 * collection only, with publication on and the bootstrap complete. It does
 * not scan the journal; the caller also asserts its exact owner source pin.
 */
export async function isPostgresCalculationAuthorityCurrent(
  client: PostgresClient,
  schema: string,
  snapshot: StorageCommunityAuthority,
): Promise<boolean> {
  const quoted = schemaName(schema);
  const controls = await readControls(client, quoted);
  if (!controls.publication) throw unavailable();
  const selected = rows<Pick<AuthorityRow, "source_id" | "source_namespace" | "policy_revision" | "collection_revision">>(
    await client.query(
      `SELECT s.source_id,a.source_namespace,i.policy_revision::text AS policy_revision,
              c.revision::text AS collection_revision
         FROM ${quoted}.storage_source_state s
         JOIN ${quoted}.typed_v1_admission_state a ON a.id=1 AND a.runtime_contract_version=1
         JOIN ${quoted}.typed_v11_admission_state b ON b.id=1 AND b.runtime_contract_version=1
          AND b.source_namespace=a.source_namespace
         JOIN ${quoted}.publication_state i ON i.singleton=1
         JOIN ${quoted}.collection_controls c ON c.singleton=1 AND c.publication_enabled
         JOIN ${quoted}.community_public_source_bootstrap p ON p.singleton=1 AND p.completed=1
          AND p.policy_version=$1
        WHERE s.singleton=1`,
      [COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION],
    ),
  );
  const row = selected[0];
  if (selected.length !== 1 || row === undefined
      || typeof row.source_id !== "string" || typeof row.source_namespace !== "string") return false;
  const policyRevision = count(row.policy_revision);
  const collectionRevision = count(row.collection_revision);
  return collectionRevision === controls.revision && policyRevision >= 1 && collectionRevision >= 1
    && sameStorageCommunityCalculationAuthority(snapshot, {
      ...snapshot,
      sourceId: row.source_id,
      sourceNamespace: row.source_namespace,
      policyRevision,
      collectionRevision,
    });
}

function sourceIdentifier(sourceId: string): string {
  if (typeof sourceId !== "string" || sourceId.length < 1 || sourceId.length > 200) throw unavailable();
  return sourceId;
}

/**
 * Source-ahead containment (D1 readStorageCommunitySourceTerminalEpoch): the
 * highest public epoch of an owner-withdrawn or owner-erased journal row for
 * the source. A legacy (version-0) terminal carries no epoch; it is bounded
 * by the source's explicit legacy_terminal_floor_epoch and, without one,
 * fails closed with 503. Missing evidence is never read as epoch 0.
 */
export async function readPostgresSourceTerminalEpoch(
  client: PostgresClient,
  schema: string,
  sourceId: string,
): Promise<number> {
  const quoted = schemaName(schema);
  const selected = rows<{ exact_epoch: unknown; legacy: unknown; floor: unknown }>(await client.query(
    `SELECT COALESCE((SELECT max(change.public_authority_epoch) FROM ${quoted}.storage_ingestion_changes change
                       WHERE change.source_id=$1 AND change.kind IN ${TERMINAL_KINDS}),0)::text AS exact_epoch,
            EXISTS (SELECT 1 FROM ${quoted}.storage_ingestion_changes change
                     WHERE change.source_id=$1 AND change.kind IN ${TERMINAL_KINDS}
                       AND change.public_authority_epoch IS NULL) AS legacy,
            (SELECT watermark.legacy_terminal_floor_epoch FROM ${quoted}.community_terminal_watermarks watermark
              WHERE watermark.source_id=$1)::text AS floor`,
    [sourceIdentifier(sourceId)],
  ));
  const row = selected[0];
  if (selected.length !== 1 || row === undefined || typeof row.legacy !== "boolean") throw unavailable();
  const exact = count(row.exact_epoch);
  if (!row.legacy) return exact;
  if (row.floor === null || row.floor === undefined) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  return Math.max(exact, count(row.floor));
}

/**
 * Highest containment epoch this database has delivered or fenced (D1
 * readStorageCommunityDeliveredTerminalEpoch): the greater of the retained
 * exact terminal receipts in analytics_applied_events and 0053's watermark,
 * which the erasure fence raises in its own transaction and a D1 import
 * carries. Nothing delivered or fenced is 0.
 */
export async function readPostgresDeliveredTerminalEpoch(
  client: PostgresClient,
  schema: string,
  sourceId: string,
): Promise<number> {
  const quoted = schemaName(schema);
  const selected = rows<{ epoch: unknown }>(await client.query(
    `SELECT GREATEST(
       COALESCE((SELECT watermark.terminal_public_authority_epoch FROM ${quoted}.community_terminal_watermarks watermark
                  WHERE watermark.source_id=$1),0),
       COALESCE((SELECT max(applied.public_authority_epoch) FROM ${quoted}.analytics_applied_events applied
                  WHERE applied.source_id=$1 AND applied.kind IN ${TERMINAL_KINDS}),0))::text AS epoch`,
    [sourceIdentifier(sourceId)],
  ));
  if (selected.length !== 1) throw unavailable();
  return count(selected[0]?.epoch);
}

interface OwnerRow {
  readonly participant_id: unknown;
  readonly owner_digest: unknown;
  readonly input_revision: unknown;
  readonly owner_revision: unknown;
  readonly authority_epoch: unknown;
  readonly has_v1: unknown;
  readonly has_v11: unknown;
  readonly has_v12: unknown;
  readonly has_effective: unknown;
  readonly has_legacy: unknown;
}

/**
 * One bounded page of eligible community owners (D1
 * readStorageCommunityOwnerPage, storage-community-authority.ts:233-299),
 * ordered by participant id in byte order. The hasV1, hasV11, hasV12 and
 * hasEffective expressions are D1's; hasV12 reads 0053's
 * community_v12_retained_authorization_scope and eligibility reads 0046's
 * community_public_source_owners. PostgreSQL pins the usage-correction
 * runtime to staged, so hasEffective equals hasV12 exactly as it does on a
 * staged D1 source. Owner revisions are read for the authority's source.
 *
 * Like D1, legacy-only owners and owners without an active owner link stay
 * explicit (ownerDigest null, revisions 0); each consumer applies its own
 * rule to them (the daily lane refuses a typed owner without a digest, the
 * graph publication treats it as pending).
 */
export async function readPostgresCommunityOwnerPage(
  client: PostgresClient,
  schema: string,
  authority: Pick<StorageCommunityAuthority, "sourceId">,
  options: ReadPostgresCommunityOwnerPageOptions = {},
): Promise<StorageCommunityOwner[]> {
  const quoted = schemaName(schema);
  const limit = options.limit ?? 64;
  const after = options.afterParticipantId ?? "";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 || typeof after !== "string" || after.length > 256
      || authority === null || typeof authority !== "object") {
    throw unavailable();
  }
  const sourceId = sourceIdentifier(authority.sourceId);
  const v1Expression = `EXISTS(SELECT 1 FROM ${quoted}.telemetry_v1_chunks c WHERE c.participant_id=p.id
      AND c.superseded_at IS NULL AND c.accepted_record_count>0)`;
  const v11Expression = `EXISTS(SELECT 1 FROM ${quoted}.telemetry_v11_domain_heads h WHERE h.participant_id=p.id)`;
  const correctionRuntimeExpression = `EXISTS(SELECT 1 FROM ${quoted}.telemetry_usage_correction_runtime r
      WHERE r.id=1 AND r.state='active' AND r.schema_version='telemetry-usage-correction-v1'
        AND r.method_version='usage-total-correction-v1')`;
  const v12Expression = `EXISTS(
      SELECT 1 FROM ${quoted}.telemetry_v12_domain_heads h
      JOIN ${quoted}.telemetry_v12_domains d ON d.id=h.generation_id AND d.participant_id=h.participant_id
      JOIN ${quoted}.telemetry_v12_domain_days dd ON dd.generation_id=d.id
      JOIN ${quoted}.telemetry_v12_day_manifests m ON m.id=dd.manifest_id
        AND m.participant_id=d.participant_id AND m.device_id=d.device_id
        AND m.chunk_day=dd.observed_day AND m.manifest_digest=dd.manifest_digest AND m.state='ready'
      JOIN ${quoted}.community_v12_retained_authorization_scope retained
        ON retained.participant_id=d.participant_id AND retained.device_id=d.device_id
      WHERE h.participant_id=p.id
    )`;
  const hasEffective = `(${v12Expression} OR ((${v1Expression} OR ${v11Expression}) AND ${correctionRuntimeExpression}))`;
  const selected = rows<OwnerRow>(await client.query(
    `SELECT p.id AS participant_id,l.owner_digest,
            COALESCE(v.revision,0)::text AS input_revision,COALESCE(o.revision,0)::text AS owner_revision,
            COALESCE(o.authority_epoch,0)::text AS authority_epoch,
            ${v1Expression} AS has_v1,
            ${v11Expression} AS has_v11,
            ${v12Expression} AS has_v12,
            ${hasEffective} AS has_effective,
            EXISTS(SELECT 1 FROM ${quoted}.telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
              AND c.transport_schema_version='telemetry-contribution-v0.2') AS has_legacy
       FROM ${quoted}.participants p
       LEFT JOIN ${quoted}.storage_v11_owner_links l ON l.participant_id=p.id AND l.state='active'
       LEFT JOIN ${quoted}.storage_owner_revisions o ON o.source_id=$3 AND o.owner_digest=l.owner_digest
        AND o.state='active'
       LEFT JOIN ${quoted}.community_analytical_input_versions v ON v.participant_id=p.id
      WHERE p.state='active' AND p.id COLLATE "C" > $1 COLLATE "C" AND EXISTS(
        SELECT 1 FROM ${quoted}.community_public_source_owners eligible WHERE eligible.participant_id=p.id)
      ORDER BY p.id COLLATE "C" LIMIT $2`,
    [after, limit, sourceId],
  ));
  if (selected.length > limit) throw unavailable();
  return selected.map((row) => {
    if (typeof row.participant_id !== "string"
        || (row.owner_digest !== null && (typeof row.owner_digest !== "string" || !HEX64.test(row.owner_digest)))
        || ![row.has_v1, row.has_v11, row.has_v12, row.has_effective, row.has_legacy]
          .every((flag) => typeof flag === "boolean")) {
      throw unavailable();
    }
    return {
      participantId: row.participant_id,
      ownerDigest: row.owner_digest as string | null,
      inputRevision: count(row.input_revision),
      ownerRevision: count(row.owner_revision),
      authorityEpoch: count(row.authority_epoch),
      hasV1: row.has_v1 === true,
      hasV11: row.has_v11 === true,
      hasV12: row.has_v12 === true,
      hasEffective: row.has_effective === true,
      hasLegacy: row.has_legacy === true,
    };
  });
}

/**
 * One public-source bootstrap step for scheduled maintenance. The database
 * function locks the singleton, re-evaluates the migration's discovery
 * predicate while incomplete and sets completed only from 0 to 1; once
 * complete it is a single read and never reverts. Only counts are returned.
 * A transfer session is refused: production imports the sealed D1 row.
 */
export async function advancePostgresPublicSourceBootstrap(
  client: PostgresClient,
  schema: string,
): Promise<PostgresPublicSourceBootstrapProgress> {
  const quoted = schemaName(schema);
  let result;
  try {
    result = await client.query<{ completed: unknown; pending: unknown }>(
      `SELECT completed,pending::text AS pending FROM ${quoted}.community_public_source_bootstrap_advance()`,
    );
  } catch (error) {
    if (error !== null && typeof error === "object" && Reflect.get(error, "code") === "P1005") {
      const message = Reflect.get(error, "message");
      if (message === "community_public_source_bootstrap_transfer_session") {
        throw new Error("COMMUNITY_PUBLIC_SOURCE_BOOTSTRAP_TRANSFER_SESSION");
      }
      if (message === "community_public_source_bootstrap_unavailable") throw unavailable();
    }
    throw error;
  }
  const selected = rows<{ completed: unknown; pending: unknown }>(result);
  const row = selected[0];
  if (selected.length !== 1 || row === undefined || (row.completed !== 0 && row.completed !== 1)) {
    throw unavailable();
  }
  const pending = count(row.pending);
  if ((row.completed === 1) !== (pending === 0)) throw unavailable();
  return Object.freeze({ completed: row.completed === 1, pending });
}
