// Apple's release-build grammar for CFBundleVersion: a positive first
// component of at most four digits, followed by up to two components of at
// most two digits each. Release artifacts do not use development suffixes.
const APPLE_MACOS_BUNDLE_VERSION_PATTERN =
  /^[1-9][0-9]{0,3}(?:\.(?:0|[1-9][0-9]?)){0,2}$/u;
const RELEASE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]?)\.(?:0|[1-9][0-9]?)$/u;
export const LEGACY_STABLE_MACOS_BUNDLE_VERSION = "0.1.16";

// Known shared-identity development/dogfood builds reached 1022. A 2000
// first-component epoch puts every new release line above those builds while
// leaving enough of Apple's four-digit first-component space for ordered
// marketing majors through 7999.
export const MACOS_BUNDLE_VERSION_EPOCH = 2_000;

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
export const SIGNED_MACOS_BUNDLE_VERSION_PLAN = Object.freeze({
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
});

export function resolveSignedMacOSBundleVersion(releaseVersion, channel) {
  if (typeof releaseVersion !== "string"
      || !RELEASE_VERSION_PATTERN.test(releaseVersion)
      || typeof channel !== "string") {
    return null;
  }
  const value = SIGNED_MACOS_BUNDLE_VERSION_PLAN[releaseVersion]?.[channel];
  return isAppleMacOSBundleVersion(value) ? value : null;
}

export function isAppleMacOSBundleVersion(value) {
  return typeof value === "string"
    && APPLE_MACOS_BUNDLE_VERSION_PATTERN.test(value);
}

export function parseAppleMacOSBundleVersion(value) {
  if (!isAppleMacOSBundleVersion(value)) return null;
  return Object.freeze(
    value.split(".").map(Number).concat([0, 0]).slice(0, 3),
  );
}

/**
 * The one observed historical stable `0.1.16` manifest predates the strict
 * Apple release-build grammar above. It may be consumed only by the explicit
 * previous-release migration seams; no other zero-first value may be accepted
 * and this value must never be emitted as a new candidate or feed.
 */
export function isLegacyZeroFirstMacOSBundleVersion(value) {
  return value === LEGACY_STABLE_MACOS_BUNDLE_VERSION;
}

function parseComparablePreviousBundleVersion(value) {
  if (isAppleMacOSBundleVersion(value)) {
    return parseAppleMacOSBundleVersion(value);
  }
  if (!isLegacyZeroFirstMacOSBundleVersion(value)) return null;
  return Object.freeze(value.split(".").map(Number));
}

export function compareAppleMacOSBundleVersions(left, right) {
  const leftParts = parseAppleMacOSBundleVersion(left);
  const rightParts = parseAppleMacOSBundleVersion(right);
  if (leftParts === null || rightParts === null) return null;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Directional migration comparator: `candidate` is always strict/current;
 * only `previous` may use the historical zero-first stable form.
 */
export function compareAppleMacOSBundleVersionToPrevious(candidate, previous) {
  const candidateParts = parseAppleMacOSBundleVersion(candidate);
  const previousParts = parseComparablePreviousBundleVersion(previous);
  if (candidateParts === null || previousParts === null) return null;
  for (let index = 0; index < 3; index += 1) {
    if (candidateParts[index] !== previousParts[index]) {
      return candidateParts[index] < previousParts[index] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Give unsigned development and separately identified Preview builds a
 * deterministic Apple-compatible ordering key. Signed stable-identity builds
 * use the explicit channel plan above instead.
 */
export function deriveEpochMacOSBundleVersion(releaseVersion) {
  if (typeof releaseVersion !== "string"
      || !RELEASE_VERSION_PATTERN.test(releaseVersion)) {
    return null;
  }
  const [major, minor, patch] = releaseVersion.split(".").map(Number);
  if (major > 9_999 - MACOS_BUNDLE_VERSION_EPOCH) {
    return null;
  }
  const derived = `${major + MACOS_BUNDLE_VERSION_EPOCH}.${minor}.${patch}`;
  return isAppleMacOSBundleVersion(derived) ? derived : null;
}
