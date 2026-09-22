/**
 * Provider-neutral Apple sign-in handoff port.  The handoff is an authority
 * row, not a contribution payload: only nonce/binding digests, pairwise link
 * key, and one-use proof cross this boundary.
 */

export interface AppleSignInHandoffInsert {
  readonly state: string;
  readonly nonceHash: string;
  readonly bindingHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ApplePendingSignInHandoff {
  readonly state: string;
  readonly nonceHash: string;
}

export interface AppleDeliveredSignInHandoff {
  readonly proof: string;
}

export interface AppleSignInHandoffStore {
  insert(input: AppleSignInHandoffInsert): Promise<void>;
  readPending(input: {
    readonly state: string;
    readonly nowIso: string;
    readonly bindingHash?: string;
  }): Promise<ApplePendingSignInHandoff | null>;
  claim(input: {
    readonly state: string;
    readonly claimId: string;
    readonly nowIso: string;
    readonly staleClaimBeforeIso: string;
  }): Promise<ApplePendingSignInHandoff | null>;
  complete(input: {
    readonly state: string;
    readonly claimId: string;
    readonly identityLinkKey: string;
    readonly proof: string;
    readonly nowIso: string;
    readonly deliveryExpiresAtIso: string;
  }): Promise<boolean>;
  deliver(input: {
    readonly state: string;
    readonly nowIso: string;
    readonly bindingHash: string;
  }): Promise<AppleDeliveredSignInHandoff | null>;
  discardPending(input: { readonly state: string; readonly nowIso: string }): Promise<void>;
  discardClaimed(input: {
    readonly state: string;
    readonly claimId: string;
    readonly nowIso: string;
  }): Promise<void>;
  purge(input: { readonly nowIso: string; readonly maximumRows: number }): Promise<number>;
}

export interface IdentityHandoffBackend {
  readonly apple: AppleSignInHandoffStore;
}
