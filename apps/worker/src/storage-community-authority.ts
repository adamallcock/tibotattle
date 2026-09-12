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
  hasV1: boolean; hasV11: boolean; hasLegacy: boolean;
}
/** Protected metadata only. Legacy-only owners stay explicit rather than
 * disappearing because they do not yet have a typed ingestion journal link. */
export async function readStorageCommunityOwnerPage(source: D1Database, options: {
  afterParticipantId?: string; limit?: number;
} = {}): Promise<StorageCommunityOwner[]> {
  const limit = options.limit ?? 64, after = options.afterParticipantId ?? '';
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 || typeof after !== 'string' || after.length > 256) throw unavailable();
  const rows = (await source.prepare(`SELECT p.id AS participantId,l.owner_digest AS ownerDigest,
    COALESCE(v.revision,0) AS inputRevision,COALESCE(o.revision,0) AS ownerRevision,
    EXISTS(SELECT 1 FROM telemetry_v1_chunks c WHERE c.participant_id=p.id AND c.superseded_at IS NULL
      AND c.accepted_record_count>0) AS hasV1,
    EXISTS(SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id=p.id) AS hasV11,
    EXISTS(SELECT 1 FROM telemetry_contributions c WHERE c.participant_id=p.id AND c.status='accepted'
      AND c.transport_schema_version='telemetry-contribution-v0.2') AS hasLegacy
    FROM participants p
    LEFT JOIN storage_v11_owner_links l ON l.participant_id=p.id AND l.state='active'
    LEFT JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest AND o.state='active'
    LEFT JOIN community_analytical_input_versions v ON v.participant_id=p.id
    WHERE p.state='active' AND p.id>? AND EXISTS(
      SELECT 1 FROM community_public_source_owners eligible WHERE eligible.participant_id=p.id)
    ORDER BY p.id LIMIT ?`).bind(after,limit).all<Omit<StorageCommunityOwner,'hasV1'|'hasV11'|'hasLegacy'> & {
      hasV1:number;hasV11:number;hasLegacy:number;
    }>()).results;
  return rows.map(row => {
    if (typeof row.participantId !== 'string' || !count(row.inputRevision) || !count(row.ownerRevision)
        || (row.ownerDigest !== null && !/^[0-9a-f]{64}$/.test(row.ownerDigest))
        || ![row.hasV1,row.hasV11,row.hasLegacy].every(n=>n===0||n===1)) throw unavailable();
    return {...row,hasV1:row.hasV1===1,hasV11:row.hasV11===1,hasLegacy:row.hasLegacy===1};
  });
}
