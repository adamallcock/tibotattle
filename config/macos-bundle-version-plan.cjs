"use strict";

// Signed releases keep the production bundle identifier, so their build
// numbers must advance from the last installed shared-identity dogfood build.
// Freeze the owner-reviewed allocations per marketing version and channel;
// adding a future release is an explicit policy change, never an implicit
// timestamp or environment-controlled counter.
// The 0.1.17 RC2 used 1023, RC3 used 1023.1, installed startup-recovery RC4
// used 1023.2, installed integrated RC5 used 1023.3, and installed accounting-
// deadline RC6 used 1023.4, and the retired-checkpoint RC7 used 1023.5. The
// fitted-transition correction used RC8 allocation 1023.6. RC9 reserves 1023.7
// for refresh-policy, selected-plan Trends, and last-good snapshot corrections,
// preserving allocated stable 1024. Allocation is not built/installed evidence.
const SIGNED_MACOS_BUNDLE_VERSION_PLAN = Object.freeze({
  "0.1.17": Object.freeze({
    "internal-dogfood": "1023.7",
    stable: "1024",
  }),
  // Separate ARM and Intel installers share the same source and build ordering.
  // Preserve signed Intel RC1 1025 and combined Astra/Intel RC2 1025.1.
  // RC3 reserves 1025.2 for parser-upgrade deadlines and paginated seed isolation.
  // Allocation does not establish signing, installation, or publication.
  "0.1.18": Object.freeze({
    "internal-dogfood": "1025.2",
    stable: "1026",
  }),
  // First native-Sparkle-to-Electron stable allocation. Timestamp buildNumber
  // remains independent artifact provenance, never an Apple bundle version.
  "0.1.21": Object.freeze({ stable: "1028" }),
});

module.exports = { SIGNED_MACOS_BUNDLE_VERSION_PLAN };
