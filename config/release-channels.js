import { DEPLOYMENT_ENDPOINTS } from "./deployment-endpoints.js";

export const RELEASE_CHANNELS_SCHEMA_VERSION =
  "tibotattle-release-channels-v0.1";
export const STABLE_RELEASE_CHANNEL = "stable";
export const INTERNAL_DOGFOOD_RELEASE_CHANNEL = "internal-dogfood";
export const STABLE_SERVICE_ORIGIN_MODE = "production_https";
export const INTERNAL_DOGFOOD_SERVICE_ORIGIN_MODE =
  "internal_dogfood_https";
export const STABLE_SPARKLE_KEY_CONTINUITY_MODE =
  "previous_stable_manifest_required";
export const STABLE_SPARKLE_BOOTSTRAP_MODE = "explicit_owner_only";
export const APPCAST_ATOMIC_GUARD_ROUTE =
  "/api/v1/internal/release/appcast";

const CHANNEL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const R2_BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function fail(message, code = "RELEASE_CHANNEL_POLICY_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalHttpsOrigin(value, label) {
  if (typeof value !== "string" || value.length === 0
      || value.includes("\0")) {
    fail(`${label} must be a non-empty HTTPS origin`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be a canonical HTTPS origin`);
  }
  if (parsed.protocol !== "https:"
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || parsed.origin !== value) {
    fail(`${label} must be a canonical HTTPS origin`);
  }
  return parsed.origin;
}

function canonicalAppcastURL(value, origin) {
  if (typeof value !== "string" || value.length === 0
      || value.includes("\0")) {
    fail("channel appcast URL must be a canonical HTTPS URL");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("channel appcast URL must be a canonical HTTPS URL");
  }
  if (parsed.protocol !== "https:"
      || parsed.origin !== origin
      || parsed.username
      || parsed.password
      || parsed.pathname === "/"
      || parsed.search
      || parsed.hash
      || parsed.href !== value) {
    fail("channel appcast URL must be a canonical HTTPS URL on its update origin");
  }
  const key = parsed.pathname.slice(1);
  if (!isSafeRelativePath(key)) {
    fail("channel appcast URL has an unsafe object key");
  }
  return Object.freeze({ href: parsed.href, key });
}

function canonicalGuardURL(value) {
  if (typeof value !== "string" || value.length === 0
      || value.includes("\0")) {
    fail("channel atomic appcast guard URL must be a canonical HTTPS URL");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("channel atomic appcast guard URL must be a canonical HTTPS URL");
  }
  if (parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.pathname !== APPCAST_ATOMIC_GUARD_ROUTE
      || parsed.search
      || parsed.hash
      || parsed.href !== value) {
    fail("channel atomic appcast guard URL must be the exact reviewed guard route");
  }
  return parsed.href;
}

function isSafeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.includes("\\")
    && value.split("/").every((segment) =>
      SAFE_PATH_SEGMENT_PATTERN.test(segment)
      && segment !== "."
      && segment !== "..");
}

function normalizeObjectPrefix(value) {
  if (!isSafeRelativePath(value)) {
    fail("channel immutable object prefix is unsafe");
  }
  return value;
}

function normalizePublicKeyFingerprint(value, { required }) {
  if (value === null && !required) return null;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(
      "configured dogfood channel requires a reviewed public Ed25519 key fingerprint",
      "RELEASE_CHANNEL_PUBLIC_KEY_REQUIRED",
    );
  }
  return value;
}

export function normalizeReleaseArchitecture(architecture = "arm64") {
  if (architecture !== "arm64" && architecture !== "x64") {
    fail("Release architecture must be arm64 or x64", "RELEASE_ARCHITECTURE_INVALID");
  }
  return architecture;
}

function stableChannelDefinition(architecture = "arm64") {
  const appcast = canonicalAppcastURL(
    architecture === "x64"
      ? DEPLOYMENT_ENDPOINTS.sparkle.intelAppcastURL
      : DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
    DEPLOYMENT_ENDPOINTS.sparkle.origin,
  );
  return {
    schemaVersion: RELEASE_CHANNELS_SCHEMA_VERSION,
    architecture,
    name: STABLE_RELEASE_CHANNEL,
    configured: true,
    buildManifestChannel: "production",
    serviceOriginMode: STABLE_SERVICE_ORIGIN_MODE,
    serviceOrigin: DEPLOYMENT_ENDPOINTS.public.origin,
    publicWebsiteOrigin: DEPLOYMENT_ENDPOINTS.public.origin,
    sparkle: {
      origin: DEPLOYMENT_ENDPOINTS.sparkle.origin,
      appcastURL: appcast.href,
      appcastObjectKey: appcast.key,
      r2Bucket: DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket,
      objectPrefix: architecture === "x64" ? "intel/releases" : "releases",
      atomicGuardURL:
        `${DEPLOYMENT_ENDPOINTS.public.origin}${APPCAST_ATOMIC_GUARD_ROUTE}`,
      // Stable's public key remains an explicit operator input for backwards
      // compatibility. It is not an endpoint and therefore is not invented
      // or duplicated in this manifest.
      publicEdKeySha256: null,
      keyContinuity: {
        mode: STABLE_SPARKLE_KEY_CONTINUITY_MODE,
        bootstrap: STABLE_SPARKLE_BOOTSTRAP_MODE,
      },
    },
  };
}

function internalDogfoodChannelDefinition(architecture = "arm64") {
  const updateOrigin = "https://dogfood-updates.tibotattle.com";
  const appcast = canonicalAppcastURL(
    `${updateOrigin}/internal-dogfood/${architecture === "x64" ? "intel/" : ""}appcast.xml`,
    updateOrigin,
  );
  return {
    schemaVersion: RELEASE_CHANNELS_SCHEMA_VERSION,
    architecture,
    name: INTERNAL_DOGFOOD_RELEASE_CHANNEL,
    configured: true,
    buildManifestChannel: "internal-dogfood",
    // Dogfood intentionally exercises the real hosted service and public
    // website. Distribution remains isolated by update origin, bucket,
    // namespace, and signing key, so a dogfood app can never consume a stable
    // update accidentally.
    serviceOriginMode: INTERNAL_DOGFOOD_SERVICE_ORIGIN_MODE,
    serviceOrigin: DEPLOYMENT_ENDPOINTS.public.origin,
    publicWebsiteOrigin: DEPLOYMENT_ENDPOINTS.public.origin,
    sparkle: {
      origin: updateOrigin,
      appcastURL: appcast.href,
      appcastObjectKey: appcast.key,
      r2Bucket: "tibotattle-dogfood-updates",
      objectPrefix: architecture === "x64"
        ? "internal-dogfood/intel/releases" : "internal-dogfood/releases",
      atomicGuardURL:
        `https://dogfood-release.tibotattle.com${APPCAST_ATOMIC_GUARD_ROUTE}`,
      publicEdKeySha256:
        "77d5717947da768e7e96a1b1e6225d2cae4748a556f109f2a30444a5f41ff3d2",
      keyContinuity: null,
    },
  };
}

const stableChannel = deepFreeze(stableChannelDefinition());
const internalDogfoodChannel = deepFreeze(
  internalDogfoodChannelDefinition(),
);

/**
 * Named release policy. The reviewed internal-dogfood descriptor deliberately
 * shares the production service so internal builds exercise real sign-in and
 * contribution behavior. Its update origin, bucket, object namespace, and
 * signing key remain separate. No endpoint is read from the environment.
 */
export const RELEASE_CHANNELS = deepFreeze({
  [STABLE_RELEASE_CHANNEL]: stableChannel,
  [INTERNAL_DOGFOOD_RELEASE_CHANNEL]: internalDogfoodChannel,
});

const INTEL_RELEASE_CHANNELS = deepFreeze({
  [STABLE_RELEASE_CHANNEL]: stableChannelDefinition("x64"),
  [INTERNAL_DOGFOOD_RELEASE_CHANNEL]: internalDogfoodChannelDefinition("x64"),
});

function assertChannelShape(channel) {
  if (!channel || typeof channel !== "object" || Array.isArray(channel)) {
    fail("release channel must be an object");
  }
  if (channel.schemaVersion !== RELEASE_CHANNELS_SCHEMA_VERSION
      || typeof channel.name !== "string"
      || !CHANNEL_NAME_PATTERN.test(channel.name)) {
    fail("release channel has an unexpected identity");
  }
  if (typeof channel.configured !== "boolean"
      || typeof channel.buildManifestChannel !== "string"
      || !CHANNEL_NAME_PATTERN.test(channel.buildManifestChannel)) {
    fail("release channel has an invalid configuration marker");
  }
  if (!channel.sparkle || typeof channel.sparkle !== "object"
      || Array.isArray(channel.sparkle)) {
    fail("release channel is missing its Sparkle policy");
  }
  normalizeReleaseArchitecture(channel.architecture);
  return channel;
}

function assertConfiguredChannelEndpoints(channel) {
  canonicalHttpsOrigin(channel.serviceOrigin, "channel service origin");
  if (channel.name === STABLE_RELEASE_CHANNEL
      && channel.serviceOriginMode !== STABLE_SERVICE_ORIGIN_MODE) {
    fail("stable service origin mode must be production_https");
  }
  if (channel.name === INTERNAL_DOGFOOD_RELEASE_CHANNEL
      && channel.serviceOriginMode !== INTERNAL_DOGFOOD_SERVICE_ORIGIN_MODE) {
    fail(
      "configured internal-dogfood must use its reviewed non-production HTTPS origin mode",
      "RELEASE_CHANNEL_SERVICE_MODE_INVALID",
    );
  }
  canonicalHttpsOrigin(channel.publicWebsiteOrigin, "channel public website origin");
  const sparkleOrigin = canonicalHttpsOrigin(
    channel.sparkle.origin,
    "channel Sparkle origin",
  );
  const appcast = canonicalAppcastURL(channel.sparkle.appcastURL, sparkleOrigin);
  if (channel.sparkle.appcastObjectKey !== appcast.key) {
    fail("channel appcast object key must be derived from its appcast URL");
  }
  if (typeof channel.sparkle.r2Bucket !== "string"
      || !R2_BUCKET_PATTERN.test(channel.sparkle.r2Bucket)) {
    fail("channel Sparkle bucket is invalid");
  }
  normalizeObjectPrefix(channel.sparkle.objectPrefix);
  canonicalGuardURL(channel.sparkle.atomicGuardURL);
  normalizePublicKeyFingerprint(channel.sparkle.publicEdKeySha256, {
    required: channel.name !== STABLE_RELEASE_CHANNEL,
  });
}

function assertDistinctFromStable(channel, stable) {
  const comparisons = [
    ["service origin mode", channel.serviceOriginMode, stable.serviceOriginMode],
    ["Sparkle origin", channel.sparkle.origin, stable.sparkle.origin],
    ["appcast URL", channel.sparkle.appcastURL, stable.sparkle.appcastURL],
    ["appcast object key", channel.sparkle.appcastObjectKey, stable.sparkle.appcastObjectKey],
    ["R2 bucket", channel.sparkle.r2Bucket, stable.sparkle.r2Bucket],
    ["immutable object prefix", channel.sparkle.objectPrefix, stable.sparkle.objectPrefix],
    ["atomic appcast guard URL", channel.sparkle.atomicGuardURL, stable.sparkle.atomicGuardURL],
  ];
  for (const [label, selected, reviewed] of comparisons) {
    if (selected === reviewed) {
      fail(
        `internal-dogfood ${label} must be distinct from stable production`,
        "RELEASE_CHANNEL_PRODUCTION_COLLISION",
      );
    }
  }
  if (stable.sparkle.publicEdKeySha256 !== null
      && channel.sparkle.publicEdKeySha256
        === stable.sparkle.publicEdKeySha256) {
    fail(
      "internal-dogfood public Ed25519 key must be distinct from stable production",
      "RELEASE_CHANNEL_PRODUCTION_COLLISION",
    );
  }
}

/**
 * Validate a channel descriptor without consulting process.env.
 */
export function assertReleaseChannelConfiguration(channel) {
  const selected = assertChannelShape(channel);
  const architecture = normalizeReleaseArchitecture(selected.architecture);
  const reviewed = architecture === "x64" ? INTEL_RELEASE_CHANNELS : RELEASE_CHANNELS;
  const stable = reviewed[STABLE_RELEASE_CHANNEL];
  if (selected.name === STABLE_RELEASE_CHANNEL) {
    if (selected.configured !== true
        || selected.serviceOriginMode !== STABLE_SERVICE_ORIGIN_MODE
        || selected.buildManifestChannel !== "production"
        || selected.serviceOrigin !== DEPLOYMENT_ENDPOINTS.public.origin
        || selected.publicWebsiteOrigin !== DEPLOYMENT_ENDPOINTS.public.origin
        || selected.sparkle.origin !== DEPLOYMENT_ENDPOINTS.sparkle.origin
        || selected.sparkle.appcastURL !== stable.sparkle.appcastURL
        || selected.sparkle.r2Bucket !== DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket
        || selected.sparkle.appcastObjectKey
          !== stable.sparkle.appcastObjectKey
        || selected.sparkle.objectPrefix !== stable.sparkle.objectPrefix
        || selected.sparkle.atomicGuardURL
          !== `${DEPLOYMENT_ENDPOINTS.public.origin}${APPCAST_ATOMIC_GUARD_ROUTE}`
        || selected.sparkle.publicEdKeySha256 !== null
        || selected.sparkle.keyContinuity?.mode
          !== STABLE_SPARKLE_KEY_CONTINUITY_MODE
        || selected.sparkle.keyContinuity?.bootstrap
          !== STABLE_SPARKLE_BOOTSTRAP_MODE) {
      fail(
        "stable release endpoints must come only from config/deployment-endpoints.js",
        "RELEASE_CHANNEL_STABLE_SOURCE_INVALID",
      );
    }
    assertConfiguredChannelEndpoints(selected);
    return selected;
  }
  if (selected.configured !== true) {
    fail("named release channel is not configured", "RELEASE_CHANNEL_NOT_CONFIGURED");
  }
  assertConfiguredChannelEndpoints(selected);
  assertDistinctFromStable(selected, stable);
  const expected = reviewed[selected.name];
  if (architecture === "x64" && (!expected || selected.sparkle.appcastURL !== expected.sparkle.appcastURL
      || selected.sparkle.appcastObjectKey !== expected.sparkle.appcastObjectKey
      || selected.sparkle.objectPrefix !== expected.sparkle.objectPrefix
      || selected.sparkle.origin !== expected.sparkle.origin
      || selected.sparkle.r2Bucket !== expected.sparkle.r2Bucket
      || selected.sparkle.atomicGuardURL !== expected.sparkle.atomicGuardURL
      || selected.sparkle.publicEdKeySha256 !== expected.sparkle.publicEdKeySha256)) {
    fail("Release channel does not match its reviewed architecture", "RELEASE_CHANNEL_PUBLICATION_MISMATCH");
  }
  return selected;
}

/** Return a named reviewed policy descriptor. */
export function getReleaseChannel(name, { architecture = "arm64" } = {}) {
  normalizeReleaseArchitecture(architecture);
  if (typeof name !== "string" || !Object.hasOwn(RELEASE_CHANNELS, name)) {
    fail(`Unknown release channel: ${String(name)}`, "RELEASE_CHANNEL_UNKNOWN");
  }
  return assertReleaseChannelConfiguration(
    (architecture === "x64" ? INTEL_RELEASE_CHANNELS : RELEASE_CHANNELS)[name],
  );
}

/** Resolve an operational channel. */
export function resolveReleaseChannel(name, options = {}) {
  const selected = getReleaseChannel(name, options);
  if (!selected.configured) {
    fail(
      `Release channel ${selected.name} has no reviewed dedicated endpoints yet`,
      "RELEASE_CHANNEL_NOT_CONFIGURED",
    );
  }
  return selected;
}

/**
 * Validate channel provenance recorded by a release artifact or publication.
 * Every endpoint/path is compared to the named policy; callers cannot replace
 * it with arbitrary environment values.
 */
export function assertReleaseChannelPublication(channelOrName, publication) {
  const selected = typeof channelOrName === "string"
    ? resolveReleaseChannel(channelOrName, { architecture: publication?.architecture })
    : assertReleaseChannelConfiguration(channelOrName);
  if (!selected.configured) {
    fail(
      `Release channel ${selected.name} has no reviewed dedicated endpoints yet`,
      "RELEASE_CHANNEL_NOT_CONFIGURED",
    );
  }
  if (!publication || typeof publication !== "object"
      || normalizeReleaseArchitecture(publication.architecture) !== normalizeReleaseArchitecture(selected.architecture)
      || publication.name !== selected.name
      || publication.serviceOriginMode !== selected.serviceOriginMode
      || publication.serviceOrigin !== selected.serviceOrigin
      || publication.publicWebsiteOrigin !== selected.publicWebsiteOrigin) {
    fail(
      `Release provenance does not match channel ${selected.name}`,
      "RELEASE_CHANNEL_PUBLICATION_MISMATCH",
    );
  }
  const sparkle = publication.sparkle;
  if (!sparkle || typeof sparkle !== "object"
      || sparkle.origin !== selected.sparkle.origin
      || sparkle.appcastURL !== selected.sparkle.appcastURL
      || sparkle.appcastObjectKey !== selected.sparkle.appcastObjectKey
      || sparkle.r2Bucket !== selected.sparkle.r2Bucket
      || sparkle.objectPrefix !== selected.sparkle.objectPrefix
      || sparkle.atomicGuardURL !== selected.sparkle.atomicGuardURL
      || typeof sparkle.publicEdKeySha256 !== "string"
      || !SHA256_PATTERN.test(sparkle.publicEdKeySha256)
      || (selected.sparkle.publicEdKeySha256 !== null
        && sparkle.publicEdKeySha256 !== selected.sparkle.publicEdKeySha256)) {
    fail(
      `Release provenance does not match channel ${selected.name} Sparkle endpoints`,
      "RELEASE_CHANNEL_PUBLICATION_MISMATCH",
    );
  }
  return selected;
}

/** Build the exact endpoint/key record stored in a release manifest. */
export function createReleaseChannelProvenance(
  channelOrName,
  { publicEdKeySha256, architecture = "arm64" } = {},
) {
  const selected = typeof channelOrName === "string"
    ? resolveReleaseChannel(channelOrName, { architecture })
    : assertReleaseChannelConfiguration(channelOrName);
  if (!selected.configured || typeof publicEdKeySha256 !== "string"
      || !SHA256_PATTERN.test(publicEdKeySha256)) {
    fail(
      "A configured release channel and public-key fingerprint are required for provenance",
      "RELEASE_CHANNEL_PUBLICATION_MISMATCH",
    );
  }
  const publication = deepFreeze({
    name: selected.name,
    architecture: selected.architecture,
    serviceOriginMode: selected.serviceOriginMode,
    serviceOrigin: selected.serviceOrigin,
    publicWebsiteOrigin: selected.publicWebsiteOrigin,
    sparkle: {
      origin: selected.sparkle.origin,
      appcastURL: selected.sparkle.appcastURL,
      appcastObjectKey: selected.sparkle.appcastObjectKey,
      r2Bucket: selected.sparkle.r2Bucket,
      objectPrefix: selected.sparkle.objectPrefix,
      atomicGuardURL: selected.sparkle.atomicGuardURL,
      publicEdKeySha256,
    },
  });
  assertReleaseChannelPublication(selected, publication);
  return publication;
}

assertReleaseChannelConfiguration(stableChannel);
assertReleaseChannelConfiguration(internalDogfoodChannel);

for (const channel of Object.values(INTEL_RELEASE_CHANNELS)) {
  assertReleaseChannelConfiguration(channel);
}
