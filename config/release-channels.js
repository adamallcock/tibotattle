import { DEPLOYMENT_ENDPOINTS } from "./deployment-endpoints.js";

export const RELEASE_CHANNELS_SCHEMA_VERSION =
  "tibotattle-release-channels-v0.1";
export const STABLE_RELEASE_CHANNEL = "stable";
export const INTERNAL_DOGFOOD_RELEASE_CHANNEL = "internal-dogfood";
export const STABLE_SERVICE_ORIGIN_MODE = "production_https";
export const INTERNAL_DOGFOOD_SERVICE_ORIGIN_MODE =
  "internal_dogfood_https";

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

function stableChannelDefinition() {
  const appcast = canonicalAppcastURL(
    DEPLOYMENT_ENDPOINTS.sparkle.appcastURL,
    DEPLOYMENT_ENDPOINTS.sparkle.origin,
  );
  return {
    schemaVersion: RELEASE_CHANNELS_SCHEMA_VERSION,
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
      objectPrefix: "releases",
      // Stable's public key remains an explicit operator input for backwards
      // compatibility. It is not an endpoint and therefore is not invented
      // or duplicated in this manifest.
      publicEdKeySha256: null,
    },
  };
}

function unconfiguredDogfoodChannelDefinition() {
  return {
    schemaVersion: RELEASE_CHANNELS_SCHEMA_VERSION,
    name: INTERNAL_DOGFOOD_RELEASE_CHANNEL,
    configured: false,
    buildManifestChannel: "internal-dogfood",
    serviceOriginMode: null,
    serviceOrigin: null,
    publicWebsiteOrigin: null,
    sparkle: {
      origin: null,
      appcastURL: null,
      appcastObjectKey: null,
      r2Bucket: null,
      objectPrefix: null,
      publicEdKeySha256: null,
    },
  };
}

const stableChannel = deepFreeze(stableChannelDefinition());
const internalDogfoodChannel = deepFreeze(
  unconfiguredDogfoodChannelDefinition(),
);

/**
 * Named release policy. The internal-dogfood entry is deliberately a fully
 * null, non-operational descriptor until an owner edits this reviewed file
 * with dedicated service, feed, bucket, object-prefix, and public-key data.
 * No endpoint is read from the environment.
 */
export const RELEASE_CHANNELS = deepFreeze({
  [STABLE_RELEASE_CHANNEL]: stableChannel,
  [INTERNAL_DOGFOOD_RELEASE_CHANNEL]: internalDogfoodChannel,
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
  return channel;
}

function assertUnconfiguredDogfood(channel) {
  if (channel.configured !== false
      || channel.buildManifestChannel !== "internal-dogfood"
      || channel.serviceOriginMode !== null
      || channel.serviceOrigin !== null
      || channel.publicWebsiteOrigin !== null
      || channel.sparkle.origin !== null
      || channel.sparkle.appcastURL !== null
      || channel.sparkle.appcastObjectKey !== null
      || channel.sparkle.r2Bucket !== null
      || channel.sparkle.objectPrefix !== null
      || channel.sparkle.publicEdKeySha256 !== null) {
    fail(
      "internal-dogfood must remain fully unconfigured until dedicated endpoints are reviewed",
      "RELEASE_CHANNEL_DOGFOOD_NOT_CONFIGURED",
    );
  }
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
  normalizePublicKeyFingerprint(channel.sparkle.publicEdKeySha256, {
    required: channel.name !== STABLE_RELEASE_CHANNEL,
  });
}

function assertDistinctFromStable(channel, stable) {
  const comparisons = [
    ["service origin", channel.serviceOrigin, stable.serviceOrigin],
    ["service origin mode", channel.serviceOriginMode, stable.serviceOriginMode],
    ["public website origin", channel.publicWebsiteOrigin, stable.publicWebsiteOrigin],
    ["Sparkle origin", channel.sparkle.origin, stable.sparkle.origin],
    ["appcast URL", channel.sparkle.appcastURL, stable.sparkle.appcastURL],
    ["appcast object key", channel.sparkle.appcastObjectKey, stable.sparkle.appcastObjectKey],
    ["R2 bucket", channel.sparkle.r2Bucket, stable.sparkle.r2Bucket],
    ["immutable object prefix", channel.sparkle.objectPrefix, stable.sparkle.objectPrefix],
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
 * Validate a channel descriptor without consulting process.env. This accepts
 * the unconfigured dogfood descriptor so read-only observers can report that
 * it is unavailable rather than falling back to stable.
 */
export function assertReleaseChannelConfiguration(channel) {
  const selected = assertChannelShape(channel);
  const stable = RELEASE_CHANNELS[STABLE_RELEASE_CHANNEL];
  if (selected.name === STABLE_RELEASE_CHANNEL) {
    if (selected.configured !== true
        || selected.serviceOriginMode !== STABLE_SERVICE_ORIGIN_MODE
        || selected.buildManifestChannel !== "production"
        || selected.serviceOrigin !== DEPLOYMENT_ENDPOINTS.public.origin
        || selected.publicWebsiteOrigin !== DEPLOYMENT_ENDPOINTS.public.origin
        || selected.sparkle.origin !== DEPLOYMENT_ENDPOINTS.sparkle.origin
        || selected.sparkle.appcastURL !== DEPLOYMENT_ENDPOINTS.sparkle.appcastURL
        || selected.sparkle.r2Bucket !== DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket
        || selected.sparkle.appcastObjectKey
          !== new URL(DEPLOYMENT_ENDPOINTS.sparkle.appcastURL).pathname.slice(1)
        || selected.sparkle.objectPrefix !== "releases"
        || selected.sparkle.publicEdKeySha256 !== null) {
      fail(
        "stable release endpoints must come only from config/deployment-endpoints.js",
        "RELEASE_CHANNEL_STABLE_SOURCE_INVALID",
      );
    }
    assertConfiguredChannelEndpoints(selected);
    return selected;
  }
  if (selected.name === INTERNAL_DOGFOOD_RELEASE_CHANNEL
      && selected.configured === false) {
    assertUnconfiguredDogfood(selected);
    return selected;
  }
  if (selected.configured !== true) {
    fail("named release channel is not configured", "RELEASE_CHANNEL_NOT_CONFIGURED");
  }
  assertConfiguredChannelEndpoints(selected);
  assertDistinctFromStable(selected, stable);
  return selected;
}

/** Return a named policy descriptor, including an unconfigured dogfood entry. */
export function getReleaseChannel(name) {
  if (typeof name !== "string" || !Object.hasOwn(RELEASE_CHANNELS, name)) {
    fail(`Unknown release channel: ${String(name)}`, "RELEASE_CHANNEL_UNKNOWN");
  }
  return assertReleaseChannelConfiguration(RELEASE_CHANNELS[name]);
}

/** Resolve an operational channel; unconfigured dogfood cannot pass this gate. */
export function resolveReleaseChannel(name) {
  const selected = getReleaseChannel(name);
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
    ? resolveReleaseChannel(channelOrName)
    : assertReleaseChannelConfiguration(channelOrName);
  if (!selected.configured) {
    fail(
      `Release channel ${selected.name} has no reviewed dedicated endpoints yet`,
      "RELEASE_CHANNEL_NOT_CONFIGURED",
    );
  }
  if (!publication || typeof publication !== "object"
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
  { publicEdKeySha256 } = {},
) {
  const selected = typeof channelOrName === "string"
    ? resolveReleaseChannel(channelOrName)
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
    serviceOriginMode: selected.serviceOriginMode,
    serviceOrigin: selected.serviceOrigin,
    publicWebsiteOrigin: selected.publicWebsiteOrigin,
    sparkle: {
      origin: selected.sparkle.origin,
      appcastURL: selected.sparkle.appcastURL,
      appcastObjectKey: selected.sparkle.appcastObjectKey,
      r2Bucket: selected.sparkle.r2Bucket,
      objectPrefix: selected.sparkle.objectPrefix,
      publicEdKeySha256,
    },
  });
  assertReleaseChannelPublication(selected, publication);
  return publication;
}

assertReleaseChannelConfiguration(stableChannel);
assertReleaseChannelConfiguration(internalDogfoodChannel);
