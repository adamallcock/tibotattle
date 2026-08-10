/**
 * Stable appcast contract shared by the local release publisher and its
 * regression fixtures. The owner-only Worker guard enforces the same shape
 * in its own runtime: one RSS channel item containing one signed full DMG.
 *
 * This shape is shared by stable and internal-dogfood. Endpoint, bucket,
 * namespace, and signing-key separation are enforced by release-channels.js
 * and by each channel's independently deployed atomic guard.
 */
export const CANONICAL_STABLE_APPCAST_POLICY = Object.freeze({
  allowDeltaFrom: false,
  channelItemCount: 1,
  enclosureCount: 1,
  fullDmgOnly: true,
  retainHistory: false,
  schemaVersion: "usage-monitor-sparkle-canonical-stable-appcast-v1",
});
