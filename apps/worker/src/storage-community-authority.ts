import { readCollectionControls } from './collection-controls';
import { COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION } from './telemetry-v1-source-selection';

export interface StorageCommunityAuthority {
  sourceId: string; sourceNamespace: string; publicAuthorityEpoch: number;
  policyRevision: number; collectionRevision: number; graphInvalidationEpoch: number;
  sourceEpoch: number; sequence: number;
}
const unavailable = () => new Error('STORAGE_COMMUNITY_AUTHORITY_UNAVAILABLE');
const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** A source-owned privacy/policy stamp, not an analytics freshness assertion.
 * No participant identities, credentials or derived payloads are copied here. */
export async function captureStorageCommunityAuthority(source: D1Database,
  expected: { sourceId?: string; sourceNamespace?: string } = {}): Promise<StorageCommunityAuthority> {
  return captureAuthority(source,expected,false);
}

/** Cleanup cannot depend on publication being enabled or cohort bootstrap
 * finishing. This stamp authorizes retirement only; all build/read callers
 * retain the strict public authority capture above. */
export async function captureStorageCommunityRetirementAuthority(source: D1Database,
  expected: { sourceId?: string; sourceNamespace?: string } = {}): Promise<StorageCommunityAuthority> {
  return captureAuthority(source,expected,true);
}

async function captureAuthority(source: D1Database,
  expected:{sourceId?:string;sourceNamespace?:string},retirement:boolean):Promise<StorageCommunityAuthority> {
  const controls = await readCollectionControls(source);
  if (!retirement && !controls.publication) throw unavailable();
  const row = await source.prepare(`SELECT s.source_id AS sourceId,a.source_namespace AS sourceNamespace,
    s.authority_epoch AS publicAuthorityEpoch,i.policy_revision AS policyRevision,c.revision AS collectionRevision,
    m.graph_invalidation_epoch AS graphInvalidationEpoch,m.mutation_epoch AS sourceEpoch,
    COALESCE((SELECT MAX(sequence) FROM storage_ingestion_changes),0) AS sequence
    FROM storage_source_state s
    JOIN typed_v1_admission_state a ON a.id=1 AND a.runtime_contract_version=1
    JOIN typed_v11_admission_state b ON b.id=1 AND b.runtime_contract_version=1 AND b.source_namespace=a.source_namespace
    JOIN ingestion_analytics_separation i ON i.id=1
    JOIN collection_controls c ON c.singleton=1 AND (?=1 OR c.publication_enabled=1)
    JOIN community_snapshot_mutation_control m ON m.singleton_id=1
    JOIN community_public_source_bootstrap p ON p.singleton=1 AND (?=1 OR p.completed=1) AND p.policy_version=?
    WHERE s.singleton=1`).bind(retirement?1:0,retirement?1:0,COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION).first<StorageCommunityAuthority>();
  if (!row || row.collectionRevision !== controls.revision
      || typeof row.sourceId !== 'string' || typeof row.sourceNamespace !== 'string'
      || ![row.publicAuthorityEpoch,row.policyRevision,row.collectionRevision,row.graphInvalidationEpoch,
        row.sourceEpoch,row.sequence].every(count)
      || row.policyRevision < 1 || row.collectionRevision < 1
      || (expected.sourceId !== undefined && expected.sourceId !== row.sourceId)
      || (expected.sourceNamespace !== undefined && expected.sourceNamespace !== row.sourceNamespace)) throw unavailable();
  return Object.freeze(row);
}

export function sameStorageCommunityAuthority(a: StorageCommunityAuthority, b: StorageCommunityAuthority,
  exactInputs = false): boolean {
  return a.sourceId === b.sourceId && a.sourceNamespace === b.sourceNamespace
    && a.publicAuthorityEpoch === b.publicAuthorityEpoch && a.policyRevision === b.policyRevision
    && a.collectionRevision === b.collectionRevision && a.graphInvalidationEpoch === b.graphInvalidationEpoch
    && (!exactInputs || (a.sequence === b.sequence && a.sourceEpoch === b.sourceEpoch));
}

/** Per-owner calculations are identified by their exact source pin and input
 * revision. Unrelated owners may therefore advance the global publication
 * epochs without invalidating completed private work. Policy and collection
 * changes remain calculation-wide fences; publication retains the full global
 * authority comparison below. */
export function sameStorageCommunityCalculationAuthority(a: StorageCommunityAuthority,
  b: StorageCommunityAuthority): boolean {
  return a.sourceId === b.sourceId && a.sourceNamespace === b.sourceNamespace
    && a.policyRevision === b.policyRevision && a.collectionRevision === b.collectionRevision;
}

/** Hard publication authority. A completed public aggregate becomes
 * incompatible, rather than merely older, only across a source identity,
 * policy or collection revision change. Ordinary accepted uploads and
 * corrections advance the public epoch; queued work replaces the aggregate
 * atomically instead of withdrawing it. */
export function sameStorageCommunityHardAuthority(a: StorageCommunityAuthority,
  b: StorageCommunityAuthority): boolean {
  return sameStorageCommunityCalculationAuthority(a, b);
}

/** Source-ahead containment: a terminal (owner-withdrawn/erased) already
 * journaled by the source withholds every aggregate pinned below it even
 * before ordered delivery. One bounded aggregate read; no owner identity. */
export async function readStorageCommunitySourceTerminalEpoch(source: D1Database): Promise<number> {
  const row = await source.prepare(`SELECT COALESCE(MAX(public_authority_epoch),0) AS epoch
    FROM storage_ingestion_changes WHERE kind IN('owner-withdrawn','owner-erased')`).first<{ epoch: number }>();
  if (!row || !count(row.epoch)) throw unavailable();
  return row.epoch;
}

/** Highest containment epoch the analytics target has delivered or fenced.
 * Migration 0018 maintains it transactionally with the terminal itself. */
export async function readStorageCommunityDeliveredTerminalEpoch(target: D1Database, sourceId: string): Promise<number> {
  const row = await target.prepare(`SELECT terminal_public_authority_epoch AS epoch
    FROM analytics_community_terminal_watermarks WHERE source_id=?`).bind(sourceId).first<{ epoch: number }>();
  if (row === null) return 0;
  if (!row || !count(row.epoch)) throw unavailable();
  return row.epoch;
}

/** A completed publication remains servable while its hard authority matches,
 * it was pinned at or after every applicable containment epoch, and it does
 * not claim inputs newer than the source. Older epochs alone never hide it. */
export function storageCommunityPublicationVisible(pin: StorageCommunityAuthority, current: StorageCommunityAuthority,
  terminalPublicAuthorityEpoch: number): boolean {
  return sameStorageCommunityHardAuthority(pin, current)
    && count(pin.publicAuthorityEpoch) && count(pin.sourceEpoch) && count(pin.sequence) && count(terminalPublicAuthorityEpoch)
    && pin.publicAuthorityEpoch >= terminalPublicAuthorityEpoch && pin.publicAuthorityEpoch <= current.publicAuthorityEpoch
    && pin.sourceEpoch <= current.sourceEpoch && pin.sequence <= current.sequence;
}

/** Lightweight final fence for private per-owner work. This deliberately does
 * not scan the ingestion journal or compare global owner mutation epochs. The
 * caller must also assert its exact owner source pin. */
export async function storageCommunityCalculationAuthorityIsCurrent(source:D1Database,
  snapshot:StorageCommunityAuthority):Promise<boolean> {
  const controls=await readCollectionControls(source);
  if(!controls.publication)throw unavailable();
  const row=await source.prepare(`SELECT s.source_id AS sourceId,a.source_namespace AS sourceNamespace,
    i.policy_revision AS policyRevision,c.revision AS collectionRevision
    FROM storage_source_state s
    JOIN typed_v1_admission_state a ON a.id=1 AND a.runtime_contract_version=1
    JOIN typed_v11_admission_state b ON b.id=1 AND b.runtime_contract_version=1 AND b.source_namespace=a.source_namespace
    JOIN ingestion_analytics_separation i ON i.id=1
    JOIN collection_controls c ON c.singleton=1 AND c.publication_enabled=1
    JOIN community_public_source_bootstrap p ON p.singleton=1 AND p.completed=1 AND p.policy_version=?
    WHERE s.singleton=1`).bind(COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION).first<Pick<StorageCommunityAuthority,
      'sourceId'|'sourceNamespace'|'policyRevision'|'collectionRevision'>>();
  return !!row&&row.collectionRevision===controls.revision
    &&typeof row.sourceId==='string'&&typeof row.sourceNamespace==='string'
    &&count(row.policyRevision)&&row.policyRevision>=1&&count(row.collectionRevision)&&row.collectionRevision>=1
    &&sameStorageCommunityCalculationAuthority(snapshot,{...snapshot,...row});
}

/** The final source read is the operation's authority linearization point.
 * Append-only data may leave an older published revision visible. Revocation,
 * deletion, exclusions, policy or collection changes may not. */
export async function storageCommunityAuthorityIsCurrent(source: D1Database, snapshot: StorageCommunityAuthority,
  exactInputs = false): Promise<boolean> {
  return sameStorageCommunityAuthority(snapshot,
    await captureStorageCommunityAuthority(source, snapshot), exactInputs);
}

export interface StorageCommunityOwner {
  participantId: string; ownerDigest: string | null; inputRevision: number; ownerRevision: number;
  /** The owner revision's CAS epoch is required by the version-neutral
   * occurrence reader. It is source authority, not a freshness hint. */
  authorityEpoch: number;
  hasV1: boolean; hasV11: boolean; hasV12: boolean; hasLegacy: boolean;
  /** True when the correction runtime is active for typed legacy families or
   * when a retained v1.2 successor domain exists for this owner. */
  hasEffective?: boolean;
}
const V12_OWNER_TABLES = Object.freeze([
  'telemetry_v12_runtime', 'telemetry_v12_device_capabilities', 'telemetry_v12_day_manifests',
  'telemetry_v12_chunks', 'telemetry_v12_records', 'telemetry_v12_domain_predecessors', 'telemetry_v12_domain_days',
  'telemetry_v12_domains', 'telemetry_v12_domain_heads',
]);
const V12_AUTHORIZATION_VIEW = 'telemetry_v12_active_authorizations';
// Schema capability is process-local metadata, not source authority. Cache it
// per D1 handle so bounded owner-page scans do not pay the same sqlite_master
// probe once per 64-owner page. A positive result is safe to reuse; a false
// result is deliberately not cached because a forward migration may add the
// successor tables while a Worker process is still warm.
const v12SchemaCache = new WeakMap<object, boolean>();
/** Ingestion uses the active-authorizations view, but analytics must retain
 * accepted rows after an upload lease expires or an ordinary user opt-out.
 * The owner link/participant state remains the erasure fence; only those
 * retained owner scopes may reach this historical union. */
export const V12_RETAINED_AUTHORIZATION_SCOPE = `
      SELECT participant_id,device_id FROM telemetry_v12_active_authorizations
      UNION
      SELECT capability.participant_id,capability.device_id
        FROM telemetry_v12_device_capabilities capability
        JOIN participants participant ON participant.id=capability.participant_id AND participant.state='active'
        JOIN storage_v11_owner_links owner_link
          ON owner_link.participant_id=capability.participant_id AND owner_link.state='active'
       WHERE capability.state IN ('accepted','revoked')
         AND capability.telemetry_schema_version='telemetry-contribution-v1.2'
      UNION
      SELECT authorization.participant_id,authorization.device_credential_id
        FROM accountless_v12_device_authorizations authorization
        JOIN participants participant ON participant.id=authorization.participant_id AND participant.state='active'
        JOIN storage_v11_owner_links owner_link
          ON owner_link.participant_id=authorization.participant_id AND owner_link.state='active'
       WHERE (authorization.state='active'
          AND authorization.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          OR (authorization.state='revoked' AND authorization.revocation_reason='user_opt_out')`;

/** The v1.2 successor is independently staged. Older Worker databases do not
 * have its tables, so owner-page SQL must be selected after an explicit schema
 * probe rather than failing every v1/v1.1 reader during the rollout. A partial
 * successor schema is unsafe and is refused. */
async function v12OwnerSchema(source: D1Database): Promise<boolean> {
  const cached = v12SchemaCache.get(source as unknown as object);
  if (cached === true) return true;
  const rows = (await source.prepare(`SELECT name FROM sqlite_master
    WHERE (type='table' AND name IN (${V12_OWNER_TABLES.map(() => '?').join(',')})
       OR type='view' AND name=?)`)
    .bind(...V12_OWNER_TABLES,V12_AUTHORIZATION_VIEW).all<{name: string}>()).results;
  if (rows.length === 0) return false;
  if (rows.length !== V12_OWNER_TABLES.length + 1) throw unavailable();
  v12SchemaCache.set(source as unknown as object, true);
  return true;
}

/** Return v1 owners with an admitted correction fact. This is an optional
 * capability query used by the daily effective lane; old databases and owners
 * without correction history remain on their established bounded reader. */
export async function storageCommunityOwnersWithCorrectionFacts(
  source: D1Database, ownerDigests: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ownerDigests.length > 64 || ownerDigests.some((digest) => !/^[0-9a-f]{64}$/u.test(digest))) {
    throw unavailable();
  }
  if (ownerDigests.length === 0) return new Set();
  const rows = await source.prepare(`SELECT lower(hex(h.owner_digest)) AS owner_digest
    FROM telemetry_usage_correction_history h
    JOIN telemetry_usage_correction_facts f ON f.history_id=h.id AND f.method_version=1
    WHERE lower(hex(h.owner_digest)) IN (SELECT value FROM json_each(?))
    GROUP BY h.owner_digest`).bind(JSON.stringify(ownerDigests)).all<{owner_digest: string}>();
  const found = new Set<string>();
  for (const row of rows.results) {
    if (!/^[0-9a-f]{64}$/u.test(row.owner_digest)) throw unavailable();
    found.add(row.owner_digest);
  }
  return found;
}

/** Protected metadata only. Legacy-only owners stay explicit rather than
 * disappearing because they do not yet have a typed ingestion journal link. */
export async function readStorageCommunityOwnerPage(source: D1Database, options: {
  afterParticipantId?: string; limit?: number;
} = {}): Promise<StorageCommunityOwner[]> {
  const limit = options.limit ?? 64, after = options.afterParticipantId ?? '';
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 || typeof after !== 'string' || after.length > 256) throw unavailable();
  // Keep the common post-v1.2 path to one bounded owner query. A separate
  // sqlite_master probe is observable in publication statement budgets and is
  // repeated when callers wrap the same D1 handle. The query itself is the
  // capability probe; only an explicitly missing successor table/view falls
  // back to the old owner shape.
  const v1Expression = `EXISTS(SELECT 1 FROM telemetry_v1_chunks c WHERE c.participant_id=p.id
      AND c.superseded_at IS NULL AND c.accepted_record_count>0)`;
  const v11Expression = `EXISTS(SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id=p.id)`;
  const correctionRuntimeExpression = `EXISTS(SELECT 1 FROM telemetry_usage_correction_runtime r
      WHERE r.id=1 AND r.state='active' AND r.schema_version='telemetry-usage-correction-v1'
        AND r.method_version='usage-total-correction-v1')`;
  const v12Expression = `EXISTS(
      SELECT 1 FROM telemetry_v12_domain_heads h
      JOIN telemetry_v12_domains d ON d.id=h.generation_id AND d.participant_id=h.participant_id
      JOIN telemetry_v12_domain_days dd ON dd.generation_id=d.id
      JOIN telemetry_v12_day_manifests m ON m.id=dd.manifest_id
        AND m.participant_id=d.participant_id AND m.device_id=d.device_id
        AND m.chunk_day=dd.observed_day AND m.manifest_digest=dd.manifest_digest AND m.state='ready'
      JOIN (${V12_RETAINED_AUTHORIZATION_SCOPE}) authorization
        ON authorization.participant_id=d.participant_id AND authorization.device_id=d.device_id
      WHERE h.participant_id=p.id
    )`;
  const ownerQuery = (hasV12: string, hasEffective: string) => `SELECT p.id AS participantId,l.owner_digest AS ownerDigest,
    COALESCE(v.revision,0) AS inputRevision,COALESCE(o.revision,0) AS ownerRevision,
    COALESCE(o.authority_epoch,0) AS authorityEpoch,
    ${v1Expression} AS hasV1,
    ${v11Expression} AS hasV11,
    ${hasV12} AS hasV12,
    ${hasEffective} AS hasEffective,
    EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
      AND c.transport_schema_version='telemetry-contribution-v0.2') AS hasLegacy
    FROM participants p
    LEFT JOIN storage_v11_owner_links l ON l.participant_id=p.id AND l.state='active'
    LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest AND o.state='active'
    LEFT JOIN community_analytical_input_versions v ON v.participant_id=p.id
    WHERE p.state='active' AND p.id>? AND EXISTS(
      SELECT 1 FROM community_public_source_owners eligible WHERE eligible.participant_id=p.id)
    ORDER BY p.id LIMIT ?`;
  type OwnerDbRow = Omit<StorageCommunityOwner,'hasV1'|'hasV11'|'hasV12'|'hasLegacy'|'hasEffective'> & {
      hasV1:number;hasV11:number;hasV12:number;hasEffective:number;hasLegacy:number;
  };
  let rows: OwnerDbRow[];
  try {
    const hasEffective = `(${v12Expression} OR ((${v1Expression} OR ${v11Expression}) AND ${correctionRuntimeExpression}))`;
    rows = (await source.prepare(ownerQuery(v12Expression,hasEffective)).bind(after,limit).all<OwnerDbRow>()).results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such table|no such view|no such column/iu.test(message)) throw error;
    // A partial successor schema is not a legacy database. Re-check the
    // complete allowlist before taking the compatibility path so a migration
    // failure cannot silently hide v1.2 evidence.
    if (await v12OwnerSchema(source)) throw unavailable();
    rows = (await source.prepare(ownerQuery('0','0')).bind(after,limit).all<OwnerDbRow>()).results;
  }
  return rows.map(row => {
    if (typeof row.participantId !== 'string' || !count(row.inputRevision) || !count(row.ownerRevision)
        || !count(row.authorityEpoch)
        || (row.ownerDigest !== null && !/^[0-9a-f]{64}$/.test(row.ownerDigest))
        || ![row.hasV1,row.hasV11,row.hasV12,row.hasEffective,row.hasLegacy].every(n=>n===0||n===1)) throw unavailable();
    return {...row,hasV1:row.hasV1===1,hasV11:row.hasV11===1,hasV12:row.hasV12===1,
      hasEffective:row.hasEffective===1,hasLegacy:row.hasLegacy===1};
  });
}
