/**
 * Pinned catalog-manifest public keys (KM-2).
 *
 * Trust in a manifest comes only from these code-pinned public keys, never
 * from configuration or the database: a database writer must not be able to
 * add a trusted key. Each channel has two slots, `current` and `next`, so a
 * key can rotate without a flag day; a staging key can never verify on the
 * production channel.
 *
 * The slots are EMPTY. The owner generates the production and staging Ed25519
 * key pairs in owner custody (or Secret Manager); a reviewed change then pins
 * the public halves here. Until that change lands, every load refuses with
 * CATALOG_KEY_UNTRUSTED and the read APIs serve the compiled baseline, which
 * is the intended cutover state (owner decision round 7: compiled registry at
 * cutover). Tests use synthetic keys generated at test time and pass them
 * explicitly; they never appear here.
 *
 * No imports: the build-and-sign tool loads this under plain Node.
 */

export interface PinnedCatalogKey {
  /** The envelope key id, for example `catalog-prod-2026a`. */
  keyId: string;
  /** Standard base64 of the raw 32-byte Ed25519 public key. */
  publicKey: string;
}

export type CatalogKeyChannel = "production" | "staging";

export const CATALOG_KEY_CHANNELS: readonly CatalogKeyChannel[] = Object.freeze(["production", "staging"]);

export const CATALOG_PINNED_KEYS: Readonly<Record<CatalogKeyChannel, Readonly<{
  current: PinnedCatalogKey | null;
  next: PinnedCatalogKey | null;
}>>> = Object.freeze({
  production: Object.freeze({ current: null, next: null }),
  staging: Object.freeze({ current: null, next: null }),
});

/** The trusted keys for one channel, in slot order. Empty until the owner pins keys. */
export function catalogTrustedKeys(channel: CatalogKeyChannel): PinnedCatalogKey[] {
  if (!CATALOG_KEY_CHANNELS.includes(channel)) throw new TypeError("CATALOG_KEY_CHANNEL_INVALID");
  const slots = CATALOG_PINNED_KEYS[channel];
  return [slots.current, slots.next].filter((entry): entry is PinnedCatalogKey => entry !== null)
    .map((entry) => ({ ...entry }));
}

/**
 * Signing keys are referenced by NAME only. The private key never enters the
 * repository, an image, a log or this process's arguments: the CI step (or
 * the owner, from custody) resolves the named Secret Manager secret and hands
 * its bytes to the signing tool through the named environment variable for
 * that one process.
 */
export const CATALOG_SIGNING_KEY_REFERENCES: Readonly<Record<CatalogKeyChannel, Readonly<{
  keyId: string;
  secretManagerSecret: string;
  environmentVariable: string;
}>>> = Object.freeze({
  production: Object.freeze({
    keyId: "catalog-prod-2026a",
    secretManagerSecret: "catalog-manifest-signing-key-production",
    environmentVariable: "TIBOTATTLE_CATALOG_SIGNING_KEY",
  }),
  staging: Object.freeze({
    keyId: "catalog-staging-2026a",
    secretManagerSecret: "catalog-manifest-signing-key-staging",
    environmentVariable: "TIBOTATTLE_CATALOG_SIGNING_KEY",
  }),
});
