/**
 * Stable appcast contract shared by the local release publisher and its
 * regression fixtures. The owner-only Worker guard enforces the same shape
 * in its own runtime: one RSS channel item containing one signed full DMG.
 *
 * This is intentionally a stable-channel policy. The internal-dogfood
 * channel is not configured and therefore cannot reach the publisher or the
 * stable appcast guard; a future configured channel needs its own reviewed
 * policy before it becomes operational.
 */
export const CANONICAL_STABLE_APPCAST_POLICY = Object.freeze({
  allowDeltaFrom: false,
  channelItemCount: 1,
  enclosureCount: 1,
  fullDmgOnly: true,
  retainHistory: false,
  schemaVersion: "usage-monitor-sparkle-canonical-stable-appcast-v1",
});
