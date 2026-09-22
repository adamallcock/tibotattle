import { ApiError } from "./errors";

/**
 * Provider-neutral authority records.  These records intentionally contain
 * hashes and lifecycle metadata only; callers never hand a provider adapter a
 * raw bearer token, cookie, prompt, or contribution payload.
 */
export type AuthorityOwnerKind = "social" | "accountless";
export type AuthorityParticipantState = "active" | "deleting";
export type AuthoritySessionScope = "personal" | "deletion_only";

export interface AuthoritySessionMaterial {
  id: string;
  participantId: string;
  secretHash: Uint8Array;
  csrfHash: Uint8Array;
  scope: AuthoritySessionScope;
  issuedAt: string;
  expiresAt: string;
}

export interface AuthoritySessionRecord extends AuthoritySessionMaterial {
  state: "active" | "revoked";
  participantCreatedAt: string;
  participantState: AuthorityParticipantState;
  consentVersion: string;
  lastUsedAt: string;
}

export interface AuthoritySessionUploadMaterial {
  id: string;
  participantId: string;
  issuedBySessionId: string;
  secretHash: Uint8Array;
  envelopeDigest: string;
  bodyBytes: number;
  contentType: "application/json";
  issuedAt: string;
  expiresAt: string;
}

export interface AuthoritySessionUploadRecord extends AuthoritySessionUploadMaterial {
  state: "unused" | "consuming" | "consumed" | "revoked";
  consumeLeaseExpiresAt: string | null;
  consumedAt: string | null;
  consumedContributionId: string | null;
  participantState: AuthorityParticipantState;
  issuingSessionState: "active" | "revoked";
  issuingSessionExpiresAt: string;
}

export interface AuthorityUploadClaim {
  authorizationId: string;
  participantId: string;
  authorizationKind: "session" | "device";
}

export interface AuthorityDevicePairingMaterial {
  id: string;
  participantId: string;
  issuedBySessionId: string;
  secretHash: Uint8Array;
  consentVersion: string;
  transportConsentVersion: string;
  issuedAt: string;
  expiresAt: string;
}

export interface AuthorityDeviceCredentialMaterial {
  id: string;
  participantId: string;
  pairingId: string;
  secretHash: Uint8Array;
  issuedAt: string;
  expiresAt: string;
  lastUsedAt: string;
  socialVerifiedAt: string | null;
  credentialGeneration: number;
}

export interface AuthorityDeviceRecord extends AuthorityDeviceCredentialMaterial {
  state: "active" | "revoked";
  revokedAt: string | null;
  participantState: AuthorityParticipantState;
  participantConsentVersion: string | null;
  ownerKind: AuthorityOwnerKind;
  authorityKind: AuthorityOwnerKind;
  accountlessEnrollmentDeviceId: string | null;
  accountlessLedgerState: "active" | "revoked" | null;
  accountlessLedgerExpiresAt: string | null;
  accountlessOwnerState: "active" | "revoked" | null;
  accountlessOwnerExpiresAt: string | null;
  accountlessAuthorizationState: "active" | "revoked" | null;
  accountlessAuthorizationExpiresAt: string | null;
}

export interface AuthorityDeviceUploadMaterial {
  id: string;
  participantId: string;
  issuedByDeviceId: string;
  secretHash: Uint8Array;
  envelopeDigest: string;
  bodyBytes: number;
  contentType: "application/json";
  issuedAt: string;
  expiresAt: string;
}

export interface AuthorityDeviceUploadRecord extends AuthorityDeviceUploadMaterial {
  state: "unused" | "consuming" | "consumed" | "revoked";
  consumeLeaseExpiresAt: string | null;
  consumedAt: string | null;
  consumedContributionId: string | null;
  deviceState: "active" | "revoked";
  deviceExpiresAt: string;
  participantState: AuthorityParticipantState;
}

export interface AccountlessEnrollmentMaterial {
  deviceId: string;
  deviceSecretHash: Uint8Array;
  installationPrincipalId: string;
  schemaVersion: string;
  policyVersion: string;
  authorizationBasis: string;
  issuedAt: string;
  expiresAt: string;
}

export interface AccountlessEnrollmentRecord extends AccountlessEnrollmentMaterial {
  state: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
}

export type TelemetryTransportSchemaVersion =
  | "telemetry-contribution-v0.1"
  | "telemetry-contribution-v0.2"
  | "telemetry-contribution-v1.0"
  | "telemetry-contribution-v1.1"
  | "telemetry-contribution-v1.2";

export interface TransportPrincipal {
  participantId: string;
  deviceId: string;
}

export interface TransportAuthorizationState {
  participantId: string;
  deviceId: string;
  ownerKind: AuthorityOwnerKind;
  authorityKind: AuthorityOwnerKind;
  participantState: AuthorityParticipantState;
  deviceState: "active" | "revoked";
  deviceExpiresAt: string;
  minimumWriteRank: number;
  policyRevision: number;
  formatRank: number;
  formatLifecycle: "accepted" | "staged" | "blocked";
  consentCurrent: boolean;
  accountlessAuthorizationCurrent: boolean;
  incompatibleLegacyHistory: boolean;
}

export interface TransportCapabilityFormat {
  schemaVersion: TelemetryTransportSchemaVersion;
  rank: number;
  lifecycle: "accepted" | "staged" | "blocked";
}

export interface TransportCapabilities {
  schemaVersion: "device-sync-capabilities-v1.1" | "device-sync-capabilities-v1.2";
  destinationOrigin: string;
  enrollmentNamespace: string;
  identityVersion: "account-track-v2";
  minimumWriteRank: number;
  policyRevision: number;
  formats: readonly TransportCapabilityFormat[];
  consentCurrent: boolean;
  requiredConsent: Readonly<{
    telemetrySchemaVersion: TelemetryTransportSchemaVersion;
    fieldDictionaryVersion: string;
    privacyContractVersion: string;
  }>;
  /** Accountless responses identify policy authority; social responses omit it. */
  authorityKind?: AuthorityOwnerKind;
  authorizationCurrent?: boolean;
}

export interface TelemetryAuthorityBackend {
  readonly sessions: SessionAuthorityStore;
  readonly sessionUploads: SessionUploadAuthorityStore;
  readonly devices: DeviceAuthorityStore;
  readonly accountless: AccountlessAuthorityStore;
  readonly transport: TransportAuthorityStore;
  readonly identity: IdentityAuthorityStore;
  readonly enrollment?: AuthorityEnrollmentStore;
}

/** Hosted identity mapping stores only the pairwise HMAC and lifecycle state. */
export interface IdentityParticipantMaterial {
  id: string;
  accessTokenId: string;
  accessTokenHash: Uint8Array;
  recoveryTokenId: string;
  recoveryTokenHash: Uint8Array;
  consentVersion: string;
  createdAt: string;
  identityLinkKey: string | null;
  identityCooldownDigest: string | null;
}

export interface IdentityParticipantRecord {
  id: string;
  createdAt: string;
  state: AuthorityParticipantState;
  consentVersion: string;
}

export interface IdentityAuthorityStore {
  insertParticipant(material: IdentityParticipantMaterial): Promise<IdentityParticipantRecord>;
  readByLinkKey(identityLinkKey: string): Promise<{ id: string; state: AuthorityParticipantState } | null>;
  readDeletingLinkKey(participantId: string, sessionId: string): Promise<string | null>;
  updateRecovery(input: {
    participantId: string;
    recoveryTokenId: string;
    recoveryTokenHash: Uint8Array;
    now: string;
  }): Promise<boolean>;
}

/**
 * Canonical PostgreSQL owner rows created with the authority identity.  The
 * values are opaque, provider-neutral digests; a PG adapter uses this optional
 * payload to keep application bootstrap in the same transaction as enrollment
 * or reattachment.
 */
export interface AuthorityEnrollmentBootstrap {
  sourceId: string;
  ownerDigest: string;
  attributionNamespace: string;
  now: string;
}

/**
 * Composite authority writes used by host adapters whose database can keep
 * enrollment, session, and optional pairing in one transaction. The legacy
 * per-table methods remain available for existing callers; a provider that
 * exposes this port must use it for the enrollment route so a credential is
 * never rotated without its session/pairing companion.
 */
export interface AuthorityEnrollmentStore {
  enroll(input: {
    participant: IdentityParticipantMaterial;
    session: AuthoritySessionMaterial;
    pairing: AuthorityDevicePairingMaterial | null;
    bootstrap?: AuthorityEnrollmentBootstrap;
  }): Promise<IdentityParticipantRecord>;
  reattach(input: {
    participantId: string;
    identityLinkKey: string;
    recoveryTokenId: string;
    recoveryTokenHash: Uint8Array;
    now: string;
    session: AuthoritySessionMaterial;
    pairing: AuthorityDevicePairingMaterial | null;
    bootstrap?: AuthorityEnrollmentBootstrap;
  }): Promise<boolean>;
}

export interface SessionAuthorityStore {
  insert(material: AuthoritySessionMaterial): Promise<void>;
  read(sessionId: string): Promise<AuthoritySessionRecord | null>;
  touch(sessionId: string, now: string): Promise<boolean>;
  revoke(sessionId: string, now: string): Promise<boolean>;
}

export interface SessionUploadAuthorityStore {
  insert(material: AuthoritySessionUploadMaterial): Promise<void>;
  read(authorizationId: string): Promise<AuthoritySessionUploadRecord | null>;
  claim(input: {
    authorizationId: string;
    participantId: string;
    envelopeDigest: string;
    bodyBytes: number;
    contentType: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<string | null>;
  recordReceipt(input: {
    authorizationId: string;
    participantId: string;
    contributionId: string;
    /** Exact lease returned to the worker that claimed this authorization. */
    leaseExpiresAt: string;
    now: string;
  }): Promise<boolean>;
  abandon(input: {
    authorizationId: string;
    participantId?: string;
    /** Prevent an expired worker from revoking a later claim. */
    leaseExpiresAt: string;
    now: string;
  }): Promise<boolean>;
}

export interface DeviceAuthorityStore {
  insertPairing(material: AuthorityDevicePairingMaterial): Promise<void>;
  readPairing(pairingId: string): Promise<{
    id: string;
    participantId: string;
    secretHash: Uint8Array;
    consentVersion: string;
    transportConsentVersion: string;
    state: "unused" | "consumed" | "revoked";
    issuedAt: string;
    expiresAt: string;
    claimedDeviceId: string | null;
    participantState: AuthorityParticipantState;
  } | null>;
  claimPairing(input: {
    pairingId: string;
    participantId: string;
    device: AuthorityDeviceCredentialMaterial;
    now: string;
  }): Promise<boolean>;
  readDevice(deviceId: string): Promise<AuthorityDeviceRecord | null>;
  touchDevice(input: { deviceId: string; now: string; expiresAt: string }): Promise<boolean>;
  revokeDevice(input: { deviceId: string; participantId: string; now: string }): Promise<boolean>;
  insertUpload(material: AuthorityDeviceUploadMaterial): Promise<void>;
  readUpload(authorizationId: string): Promise<AuthorityDeviceUploadRecord | null>;
  claimUpload(input: {
    authorizationId: string;
    participantId: string;
    deviceId: string;
    envelopeDigest: string;
    bodyBytes: number;
    contentType: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<string | null>;
  recordUploadReceipt(input: {
    authorizationId: string;
    participantId: string;
    deviceId: string;
    contributionId: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<boolean>;
  abandonUpload(input: {
    authorizationId: string;
    participantId?: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<boolean>;
}

export interface AccountlessAuthorityStore {
  read(deviceId: string): Promise<AccountlessEnrollmentRecord | null>;
  enroll(material: AccountlessEnrollmentMaterial): Promise<{
    created: boolean;
    record: AccountlessEnrollmentRecord;
  }>;
  revoke(input: { deviceId: string; now: string; reason: string }): Promise<boolean>;
}

export interface TransportAuthorityStore {
  readAuthorization(input: {
    principal: TransportPrincipal;
    schemaVersion: TelemetryTransportSchemaVersion;
    now: string;
  }): Promise<TransportAuthorizationState | null>;
  upsertConsent(input: {
    principal: TransportPrincipal;
    sessionId: string;
    schemaVersion: TelemetryTransportSchemaVersion;
    fieldDictionaryVersion: string;
    privacyContractVersion: string;
    now: string;
  }): Promise<void>;
  capabilities(input: {
    principal: TransportPrincipal;
    destinationOrigin: string;
    now: string;
    schemaVersion?: TelemetryTransportSchemaVersion;
  }): Promise<TransportCapabilities>;
}

/**
 * Runtime-neutral result guard used by both providers.  An adapter must never
 * return a partially populated authority row: an incomplete row is a storage
 * failure, not an absent participant.
 */
export function assertAuthorityRecord<T>(value: T | null, condition: boolean): T | null {
  if (value === null || condition) return value;
  throw new Error("authority_record_incomplete");
}

export function isAuthorityApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
