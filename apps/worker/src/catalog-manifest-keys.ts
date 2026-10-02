/**
 * Pinned catalog-manifest public keys (KM-2).
 *
 * Trust in a manifest comes only from these code-pinned public keys, never
 * from configuration or the database: a database writer must not be able to
 * add a trusted key. Each channel has two slots, `current` and `next`, so a
 * key can rotate without a flag day; a staging key can never verify on the
 * production channel. Each pin carries the key id, the standard base64 of the
 * raw 32-byte Ed25519 public key and the SHA-256 fingerprint of those 32
 * bytes (design §2.5); scripts/catalog-manifest.check.mjs proves every
 * fingerprint, and that no key or key id is shared between channels.
 *
 * The four pairs were generated on 2026-10-02 (owner decision, round 11).
 * Pinning a key does NOT make anything load: the read APIs serve the
 * compiled baseline until a manifest is deliberately loaded into the store,
 * which is the round-7 cutover state (compiled registry at cutover).
 *
 * CUSTODY. The private halves are in the owner's macOS login Keychain only,
 * as Keychain services `codex-secret-tibotattle-<keyId>`, used through the
 * `secret` helper for one process:
 *
 *   secret run tibotattle-<keyId> --env TIBOTATTLE_CATALOG_SIGNING_KEY -- \
 *     node apps/worker/scripts/catalog-manifest.mjs sign ...
 *
 * They are never in CI, never in GCP Secret Manager and never in the
 * repository; the signing tool refuses to run under CI. Rotation and
 * compromise steps: docs/runbooks/gcp-catalog-manifest-signing.md.
 *
 * No imports: the build-and-sign tool loads this under plain Node.
 */

export interface PinnedCatalogKey {
  /** The envelope key id, for example `catalog-prod-2026a`. */
  keyId: string;
  /** Standard base64 of the raw 32-byte Ed25519 public key. */
  publicKey: string;
  /** Lowercase hex SHA-256 of the raw 32-byte public key. */
  sha256: string;
}

export type CatalogKeyChannel = "production" | "staging";
export type CatalogKeySlot = "current" | "next";

export const CATALOG_KEY_CHANNELS: readonly CatalogKeyChannel[] = Object.freeze(["production", "staging"]);
export const CATALOG_KEY_SLOTS: readonly CatalogKeySlot[] = Object.freeze(["current", "next"]);

export const CATALOG_PINNED_KEYS: Readonly<Record<CatalogKeyChannel, Readonly<Record<CatalogKeySlot,
  Readonly<PinnedCatalogKey> | null>>>> = Object.freeze({
  production: Object.freeze({
    current: Object.freeze({
      keyId: "catalog-prod-2026a",
      publicKey: "7nzLOQZ02fOV27RWXFba3VTHOxiynf52KzSeuivRd3w=",
      sha256: "a50e9d9390b077f1602c2441b803ab4eac697153a3aba5128cdd41218d2d2e47",
    }),
    next: Object.freeze({
      keyId: "catalog-prod-2026b",
      publicKey: "K1qDGceqvUpvqcK/EV0DbOznewe0Ry7o05KN/2B0tkc=",
      sha256: "c6c5a025258402d726507f7c71ef4cc1df13995e3dcebeedacefb07e548cb906",
    }),
  }),
  staging: Object.freeze({
    current: Object.freeze({
      keyId: "catalog-staging-2026a",
      publicKey: "AZEgwHLwS6dF8HTW/+xiS8KUN+x7iWftqCTYZzhoDr0=",
      sha256: "c248132989967ed694518200ac7eb40ae67e30fd354c8d56d6f20a5a8d8af8fa",
    }),
    next: Object.freeze({
      keyId: "catalog-staging-2026b",
      publicKey: "IsaCR0soqJOP/tSPdVpZ+sIySy8BhtfzHXCRUYgM9mM=",
      sha256: "14d243042dff76dbbb5ede044409e2c075dfbf88424557de5cfff9180f94fa3d",
    }),
  }),
});

/** The trusted keys for one channel, in slot order (current, then next). */
export function catalogTrustedKeys(channel: CatalogKeyChannel): PinnedCatalogKey[] {
  if (!CATALOG_KEY_CHANNELS.includes(channel)) throw new TypeError("CATALOG_KEY_CHANNEL_INVALID");
  const slots = CATALOG_PINNED_KEYS[channel];
  return CATALOG_KEY_SLOTS.map((slot) => slots[slot])
    .filter((entry): entry is Readonly<PinnedCatalogKey> => entry !== null)
    .map((entry) => ({ ...entry }));
}

/**
 * How the signing tool reaches a private key: by NAME only. The owner runs
 * the tool under `secret run <secretHelperName> --env <environmentVariable>`,
 * which reads the Keychain item and sets that variable for that one process.
 * The key never enters the repository, an image, a log, CI, Secret Manager or
 * this process's arguments.
 */
export const CATALOG_SIGNING_ENVIRONMENT_VARIABLE = "TIBOTATTLE_CATALOG_SIGNING_KEY";
export const CATALOG_SIGNING_SECRET_HELPER_PREFIX = "tibotattle-";

export interface CatalogSigningKeyReference {
  channel: CatalogKeyChannel;
  slot: CatalogKeySlot;
  keyId: string;
  /** The `secret` helper name: `tibotattle-<keyId>` (Keychain service `codex-secret-tibotattle-<keyId>`). */
  secretHelperName: string;
  environmentVariable: string;
}

/** The signing reference for one channel and slot; null when that slot is empty. */
export function catalogSigningKeyReference(channel: CatalogKeyChannel,
  slot: CatalogKeySlot = "current"): CatalogSigningKeyReference | null {
  if (!CATALOG_KEY_CHANNELS.includes(channel)) throw new TypeError("CATALOG_KEY_CHANNEL_INVALID");
  if (!CATALOG_KEY_SLOTS.includes(slot)) throw new TypeError("CATALOG_KEY_SLOT_INVALID");
  const pinned = CATALOG_PINNED_KEYS[channel][slot];
  if (pinned === null) return null;
  return Object.freeze({
    channel,
    slot,
    keyId: pinned.keyId,
    secretHelperName: `${CATALOG_SIGNING_SECRET_HELPER_PREFIX}${pinned.keyId}`,
    environmentVariable: CATALOG_SIGNING_ENVIRONMENT_VARIABLE,
  });
}
