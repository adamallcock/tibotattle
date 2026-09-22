import type { ReleaseNonceStore } from "./release-nonce-store";

/**
 * Provider-neutral persistence contracts for the hosted analytical and
 * lifecycle paths.
 *
 * These interfaces deliberately describe operations rather than SQL.  D1
 * callers may keep their existing implementation while PostgreSQL uses a
 * separate adapter.  A caller must be able to prove the same source pin,
 * lease, CAS revision, privacy fence, and bounded page outcome on either
 * provider.
 */

export type StorageJsonPrimitive = string | number | boolean | null;
export type StorageJsonValue =
  | StorageJsonPrimitive
  | readonly StorageJsonValue[]
  | { readonly [key: string]: StorageJsonValue };

export interface StoragePageCursor {
  readonly observedAtMs: number;
  readonly occurrenceId: string;
}

/** The source identity that authorizes one analytical read. */
export interface StorageSourcePin {
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly ownerDigest: string;
  readonly day: string;
  readonly inputRevision: number;
  readonly ownerRevision: number;
  readonly dependencyDigest: string;
  readonly method: string;
  readonly authorityEpoch: number;
  readonly sourceEpoch: number;
  readonly sequence: number;
}

export interface StorageSourceRecord {
  readonly occurrenceId: string;
  readonly observedAtMs: number;
  readonly observedDay: string;
  readonly ownerDigest: string;
  readonly inputRevision: number;
  /** Digest of the canonical payload persisted with this occurrence. */
  readonly payloadSha256: string;
  readonly payload: StorageJsonValue;
}

export type StorageSourcePageStatus =
  | "available"
  | "stale"
  | "withdrawn"
  | "correction_unavailable"
  | "source_unavailable";

export interface StorageSourcePage {
  readonly status: StorageSourcePageStatus;
  readonly pin: StorageSourcePin;
  readonly rows: readonly StorageSourceRecord[];
  readonly nextCursor: StoragePageCursor | null;
  readonly complete: boolean;
}

export interface StorageSourcePageRequest {
  readonly pin: StorageSourcePin;
  readonly cursor: StoragePageCursor | null;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export type StorageSourceStream = "quota" | "usage" | "session";

/** Prepared streams are explicit storage identity, never inferred from a
 * generation naming convention. */
export type PreparedSourceStream = "quota" | "usage";

export interface PreparedSourceControl {
  /** Canonical, bounded JSON for the resumable preparation state. */
  readonly json: string;
  readonly sha256: string;
}

export type PreparedSourceOutputKind = "plan" | "fit" | "usage_price" | "usage_fragment";

export interface PreparedSourceOutput {
  readonly stream: PreparedSourceStream;
  readonly kind: PreparedSourceOutputKind;
  /** Stable source occurrence or fragment identity, not a page-local index. */
  readonly key: string;
  readonly index: number;
  readonly payload: StorageJsonValue;
  readonly payloadSha256: string;
}

export interface PreparedSourceOutputRequest {
  readonly pin: StorageSourcePin;
  readonly generation: string;
  readonly stream: PreparedSourceStream;
  readonly kind: PreparedSourceOutputKind;
  readonly afterIndex: number;
  readonly afterKey: string;
  readonly limit: number;
}

/** One day/generation in a bounded multi-day prepared window.  The source pin
 * remains day-specific so each page can prove its own canonical authority;
 * window readers merge these independently sealed generations by cursor. */
export interface PreparedSourceWindow {
  readonly pin: StorageSourcePin;
  readonly generation: string;
}

export interface PreparedSourceOutputWindowRequest {
  readonly sources: readonly PreparedSourceWindow[];
  readonly stream: PreparedSourceStream;
  readonly kind: PreparedSourceOutputKind;
  readonly afterIndex: number;
  readonly afterKey: string;
  readonly limit: number;
}

export interface StorageSourcePinRequest {
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly ownerDigest: string;
  readonly day: string;
  readonly method: string;
}

/**
 * Bounded canonical-source reads.  The source adapter resolves an
 * owner-scoped pin and repeats that resolution in the page transaction; a
 * caller cannot turn a participant id or an input fingerprint into authority
 * by itself.  `deviceId` is the already elected device for the pinned day.
 */
export interface StorageSourceStore {
  readPin(input: StorageSourcePinRequest): Promise<StorageSourcePin | null>;
  readPage(input: StorageSourcePageRequest & {
    readonly stream: StorageSourceStream;
    readonly deviceId: string;
    readonly beforeObservedAtMs?: number;
  }): Promise<StorageSourcePage>;
}

export interface PreparedSourcePageRequest extends StorageSourcePageRequest {
  readonly generation: string;
  readonly readerPolicy: string;
  readonly stream?: PreparedSourceStream;
  /** Internal preparation replay may inspect an incomplete generation; normal
   * readers only receive `available` pages from ready generations. */
  readonly allowBuilding?: boolean;
}

export interface PreparedSourceHead {
  readonly generation: string;
  readonly stream: PreparedSourceStream;
  readonly state: "building" | "ready" | "discarding" | "retired";
  readonly progressRevision: number;
  readonly nextCursor: StoragePageCursor | null;
  readonly rowsWritten: number;
  readonly sourcePin: StorageSourcePin;
  readonly control?: PreparedSourceControl;
}

export interface PreparedSourceCommit {
  /** The source/owner pin is part of the write precondition, not caller metadata. */
  readonly pin: StorageSourcePin;
  readonly generation: string;
  readonly stream?: PreparedSourceStream;
  readonly expectedProgressRevision: number;
  readonly nextCursor: StoragePageCursor | null;
  readonly complete: boolean;
  readonly rows: readonly StorageSourceRecord[];
  readonly rowDigest: string;
  /** Persisted in the same CAS as rows/cursor/head. Required for provider
   * preparation; optional keeps the legacy direct port source-compatible. */
  readonly control?: PreparedSourceControl;
  /** Derived plans/fits/prices/fragments are independent durable records. */
  readonly outputs?: readonly PreparedSourceOutput[];
}

export interface PreparedSourceStore {
  begin(input: {
    readonly pin: StorageSourcePin;
    readonly generation: string;
    readonly stream?: PreparedSourceStream;
  }): Promise<PreparedSourceHead>;
  readPage(request: PreparedSourcePageRequest): Promise<StorageSourcePage>;
  readOutputs(request: PreparedSourceOutputRequest): Promise<readonly PreparedSourceOutput[]>;
  /** Optional batched read used by bounded multi-day readers.  Implementations
   * that cannot batch must leave this absent so callers can apply an explicit
   * bounded fallback, never an unbounded scan. */
  readOutputsWindow?(request: PreparedSourceOutputWindowRequest): Promise<readonly PreparedSourceOutput[]>;
  countOutputs(input: {
    readonly pin: StorageSourcePin;
    readonly generation: string;
    readonly stream: PreparedSourceStream;
    readonly kind: PreparedSourceOutputKind;
  }): Promise<number>;
  countOutputsWindow?(input: {
    readonly sources: readonly PreparedSourceWindow[];
    readonly stream: PreparedSourceStream;
    readonly kind: PreparedSourceOutputKind;
  }): Promise<number>;
  readHead(input: {
    readonly sourceId: string;
    readonly ownerDigest: string;
    readonly day: string;
    readonly generation: string;
  }): Promise<PreparedSourceHead | null>;
  commitPage(input: PreparedSourceCommit): Promise<PreparedSourceHead>;
  retire(input: {
    readonly sourceId: string;
    readonly ownerDigest: string;
    readonly day: string;
    readonly generation: string;
    readonly expectedProgressRevision: number;
    readonly limit: number;
  }): Promise<{ readonly deleted: number; readonly complete: boolean }>;
}

export interface AnalyticalWorkIdentity {
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly ownerDigest: string;
  readonly day: string;
  readonly metric: "fits" | "model";
  readonly inputRevision: number;
  readonly ownerRevision: number;
  readonly dependencyDigest: string;
  readonly method: string;
  readonly authorityEpoch: number;
  /** Canonical source authority pin carried into every resumable work CAS. */
  readonly sourceEpoch: number;
  readonly sequence: number;
}

export interface AnalyticalWorkClaim {
  readonly claimToken: string;
  readonly leaseExpiresAtMs: number;
  readonly revision: number;
  readonly identity: AnalyticalWorkIdentity;
}

export interface AnalyticalCheckpoint {
  readonly generation: string;
  readonly expectedHead: string | null;
  readonly controlJson: string;
  readonly manifestJson: string;
  readonly parts: readonly {
    readonly index: number;
    readonly sha256: string;
    readonly payloadJson: string;
  }[];
  readonly complete: boolean;
}

export type AnalyticalWorkState =
  | "pending"
  | "claimed"
  | "checkpointing"
  | "complete"
  | "discarding"
  | "retired";

export interface AnalyticalWorkHead {
  readonly identity: AnalyticalWorkIdentity;
  readonly state: AnalyticalWorkState;
  readonly revision: number;
  readonly headDigest: string | null;
  readonly claim: AnalyticalWorkClaim | null;
  readonly checkpoint: AnalyticalCheckpoint | null;
}

export interface AnalyticalWorkStore {
  claim(input: {
    readonly identity: AnalyticalWorkIdentity;
    readonly nowMs: number;
    readonly leaseMs: number;
  }): Promise<AnalyticalWorkClaim | null>;
  renew(input: {
    readonly identity: AnalyticalWorkIdentity;
    readonly claimToken: string;
    readonly expectedRevision: number;
    readonly nowMs: number;
    readonly leaseMs: number;
  }): Promise<AnalyticalWorkClaim>;
  read(input: AnalyticalWorkIdentity): Promise<AnalyticalWorkHead | null>;
  saveCheckpoint(input: {
    readonly identity: AnalyticalWorkIdentity;
    readonly claimToken: string;
    readonly expectedRevision: number;
    readonly nowMs: number;
    readonly checkpoint: AnalyticalCheckpoint;
  }): Promise<AnalyticalWorkHead>;
  complete(input: {
    readonly identity: AnalyticalWorkIdentity;
    readonly claimToken: string;
    readonly expectedRevision: number;
    readonly nowMs: number;
    readonly resultDigest: string;
  }): Promise<AnalyticalWorkHead>;
  discard(input: {
    readonly identity: AnalyticalWorkIdentity;
    readonly expectedRevision: number;
    readonly reason: "source_changed" | "withdrawn" | "erased" | "superseded";
  }): Promise<AnalyticalWorkHead>;
  retire(input: {
    readonly identity: AnalyticalWorkIdentity;
    readonly expectedRevision: number;
    readonly limit: number;
  }): Promise<{ readonly deleted: number; readonly complete: boolean }>;
}

export interface StoragePublicationAuthority {
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly policyRevision: number;
  readonly collectionRevision: number;
  readonly publicAuthorityEpoch: number;
  readonly sourceEpoch: number;
  readonly sequence: number;
}

export interface StoragePublicationCapture {
  readonly generation: string;
  readonly day: string;
  readonly metric: "daily" | "model" | "graph";
  readonly cohortDigest: string;
  readonly authority: StoragePublicationAuthority;
  readonly expectedMembers: number;
  readonly payloadJson: string;
}

export interface StoragePublicationStore {
  capture(input: {
    readonly sourceId: string;
    readonly day: string;
    readonly metric: "daily" | "model" | "graph";
    readonly authority: StoragePublicationAuthority;
    readonly generation: string;
    readonly limit: number;
  }): Promise<StoragePublicationCapture | null>;
  publish(input: {
    readonly capture: StoragePublicationCapture;
    readonly payloadSha256: string;
    readonly computedAtMs: number;
  }): Promise<"published" | "unchanged" | "stale" | "incomplete">;
  readPublished(input: {
    readonly sourceId: string;
    readonly day: string;
    readonly metric: "daily" | "model" | "graph";
    readonly authority: StoragePublicationAuthority;
  }): Promise<StoragePublicationCapture | null>;
  retire(input: {
    readonly sourceId: string;
    readonly beforeDay: string;
    readonly limit: number;
  }): Promise<{ readonly deleted: number; readonly complete: boolean }>;
}

export interface StorageCollectionControls {
  readonly revision: number;
  readonly state: "operational" | "degraded" | "contained";
  readonly enrollment: boolean;
  readonly uploadRegistration: boolean;
  readonly processing: boolean;
  readonly publication: boolean;
}

export interface StorageAdminStore {
  authorize(input: {
    readonly participantId: string;
    readonly identityLinkKey: string;
  }): Promise<boolean>;
  beginAudit(input: {
    readonly operationId: string;
    readonly actorIdentityDigest: string;
    readonly action: "set_collection_controls" | "run_maintenance" | "sync_distribution";
    readonly detailsJson: string;
    readonly createdAt: string;
  }): Promise<void>;
  finishAudit(input: {
    readonly operationId: string;
    readonly outcome: "success" | "failure";
    readonly detailsJson: string;
  }): Promise<void>;
  readControls(): Promise<StorageCollectionControls>;
  setControls(input: {
    readonly expectedRevision: number;
    readonly flags: Pick<StorageCollectionControls, "enrollment" | "uploadRegistration" | "processing" | "publication">;
    readonly reasonCode: string;
    readonly updatedAt: string;
    readonly audit: {
      readonly operationId: string;
      readonly actorIdentityDigest: string;
      readonly detailsJson: string;
    };
  }): Promise<StorageCollectionControls>;
}

export interface StorageDeletionTombstone {
  readonly participantDigest: string;
  readonly retainUntil: string;
}

export interface StorageQuarantineRegistration {
  readonly objectKind: "synthetic" | "telemetry" | "telemetry_v1" | "telemetry_v11" | "telemetry_v12";
  readonly contributionId: string;
  /** Provider-neutral object identity; R2/GCS naming stays in the object adapter. */
  readonly objectKey: string;
  readonly registeredAt: string;
}

export interface StorageLifecycleStore {
  recordDeletionTombstone(input: StorageDeletionTombstone): Promise<void>;
  hasDeletionTombstone(input: { readonly participantDigest: string; readonly now: string }): Promise<boolean>;
  recordIdentityCooldown(input: {
    readonly digest: string;
    readonly deletedAt: string;
    readonly retainUntil: string;
  }): Promise<void>;
  registerQuarantine(input: StorageQuarantineRegistration): Promise<void>;
  claimQuarantine(input: {
    readonly objectKey: string;
    readonly registeredAt: string;
    readonly leaseId: string;
  }): Promise<"claimed" | "referenced" | "gone">;
  clearQuarantine(input: { readonly objectKey: string; readonly leaseId?: string }): Promise<void>;
  beginMaintenance(input: {
    readonly now: string;
    readonly leaseId: string;
    readonly leaseExpiresAt: string;
  }): Promise<boolean>;
  finishMaintenance(input: {
    readonly leaseId: string;
    readonly now: string;
    readonly restoredParticipantsSuppressed: number;
    readonly restoreReplayComplete: boolean;
    readonly quarantineObjectsDeleted: number;
    readonly quarantineRetentionComplete: boolean;
  }): Promise<void>;
}

export interface StorageAnalyticsChange {
  readonly sourceId: string;
  readonly sequence: number;
  readonly eventDigest: string;
  readonly ownerDigest: string;
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  readonly kind: "source-updated" | "owner-active" | "owner-withdrawn" | "owner-erased";
  readonly recordedMs: number;
}

export interface StorageAnalyticsDeliveryStore {
  append(input: StorageAnalyticsChange): Promise<void>;
  read(input: { readonly sourceId: string; readonly afterSequence: number; readonly limit: number }): Promise<readonly StorageAnalyticsChange[]>;
  apply(input: {
    readonly change: StorageAnalyticsChange;
    readonly projection: StorageJsonValue;
  }): Promise<"applied" | "already_applied">;
  readCursor(input: { readonly sourceId: string }): Promise<{ readonly sequence: number; readonly authorityEpoch: number }>;
  authorityIsCurrent(input: {
    readonly sourceId: string;
    readonly authorityEpoch: number;
  }): Promise<boolean>;
}

export interface StorageOwnerRoute {
  readonly ownerId: string;
  readonly shardId: string;
  readonly generation: number;
  readonly state: "active" | "moving";
}

export interface StorageOwnerRouteOperation {
  readonly route: StorageOwnerRoute;
  readonly operation: "source_read" | "source_write" | "analytics_write" | "erase";
}

export interface StorageOwnerRouter {
  resolve(ownerId: string): Promise<StorageOwnerRoute>;
  /**
   * Read-only route validation. Mutation adapters must repeat this route and
   * fence precondition inside their own transaction; this method is not a
   * mutation wrapper and cannot be used as one.
   */
  assertCurrent(input: StorageOwnerRouteOperation): Promise<void>;
}

export interface StorageQuarantineObjectStore {
  put(objectKey: string, value: string, options?: unknown): Promise<void>;
  head(objectKey: string): Promise<{ readonly etag: string } | null>;
  delete(objectKey: string): Promise<void>;
}

/** The release guard's existing provider-neutral replay nonce contract. */
export type StorageReleaseGuardNonceStore = ReleaseNonceStore;

export interface StorageProviderPorts {
  readonly source: StorageSourceStore;
  readonly preparedSource: PreparedSourceStore;
  readonly analyticalWork: AnalyticalWorkStore;
  readonly publication: StoragePublicationStore;
  readonly admin: StorageAdminStore;
  readonly lifecycle: StorageLifecycleStore;
  readonly analyticsDelivery: StorageAnalyticsDeliveryStore;
  readonly ownerRouter: StorageOwnerRouter;
}
