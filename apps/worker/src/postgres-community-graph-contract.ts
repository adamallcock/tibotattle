import type { PostgresSchemaOptions } from "./postgres-client";

export type PostgresCommunityGraphSourceKind =
  | "effective"
  | "v1.1"
  | "v1"
  | "mixed"
  | "v0.2";

/** Public member evidence consumed by the source-pinned graph publisher. */
export interface PostgresCommunityGraphMember {
  readonly participantId: string;
  readonly ownerDigest: string;
  readonly inputRevision: number;
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  readonly sourceKind: PostgresCommunityGraphSourceKind;
  /** Exact effective-history dependency fingerprint used by the model result.
   * It is present only for source families the reviewed reader can calculate. */
  readonly inputFingerprint?: string;
}

/** Global source watermarks captured with the effective-owner inventory. A
 * changed watermark defers publication so a page assembled across concurrent
 * source revisions can never be mistaken for a complete cohort. */
export interface PostgresCommunityGraphSourcePin {
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly sourceAuthorityEpoch: number;
  readonly analyticsAuthorityEpoch: number;
  readonly sequence: number;
  readonly policyRevision: number;
  readonly collectionRevision: number;
  readonly telemetryV12RuntimeState: string;
  readonly telemetryV12RuntimeRevision: number;
  readonly telemetryV12TypedRuntimeState: string;
  readonly telemetryV12TypedRuntimePolicyRevision: number;
  readonly accountlessAuthorizationCount: number;
  readonly nextAccountlessAuthorizationExpiry: string | null;
}

export interface PostgresCommunityGraphPublicationOptions {
  readonly sourcePin: PostgresCommunityGraphSourcePin;
  readonly members: readonly PostgresCommunityGraphMember[];
  readonly day: string;
  readonly nowMs?: number;
  readonly schema?: PostgresSchemaOptions;
}

export interface PostgresCommunityGraphStreamPublicationOptions {
  readonly sourcePin: PostgresCommunityGraphSourcePin;
  readonly members: AsyncIterable<PostgresCommunityGraphMember>;
  readonly day: string;
  readonly nowMs?: number;
  readonly schema?: PostgresSchemaOptions;
  /** Derive the fingerprint from each validated cached result. The
   * authoritative cohort publisher enables this; direct callers supply it. */
  readonly fingerprintFromResult?: boolean;
}

export type PostgresCommunityGraphPublicationProgress =
  | { readonly state: "published" | "unchanged"; readonly memberCount: number; readonly generation: string }
  | { readonly state: "deferred"; readonly reason: "source_changed" | "cache_pending" | "capacity"; readonly memberCount: number };
