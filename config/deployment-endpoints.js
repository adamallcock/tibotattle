/**
 * Reviewed production endpoint manifest.
 *
 * This is intentionally the sole source for public deployment identifiers.
 * Consumers which cannot import JavaScript (for example Wrangler JSONC and
 * native Swift) are checked by `apps/worker/scripts/check-deployment-endpoints.mjs`.
 */
export const DEPLOYMENT_ENDPOINTS_SCHEMA_VERSION =
  "tibotattle-deployment-endpoints-v0.1";

function canonicalHttpsOrigin(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty HTTPS origin`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be a valid HTTPS origin`);
  }
  if (parsed.protocol !== "https:"
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || parsed.origin !== value) {
    throw new TypeError(`${label} must be a canonical HTTPS origin`);
  }
  return parsed;
}

function exactStringList(value, expected, label) {
  if (!Array.isArray(value)
      || value.length !== expected.length
      || value.some((entry, index) => entry !== expected[index])) {
    throw new TypeError(`${label} must match the reviewed endpoint manifest`);
  }
}

const publicOrigin = "https://tibotattle.com";
const sparkleUpdateOrigin = "https://updates.tibotattle.com";
const publicOriginURL = canonicalHttpsOrigin(publicOrigin, "public origin");
const sparkleUpdateOriginURL = canonicalHttpsOrigin(
  sparkleUpdateOrigin,
  "Sparkle update origin",
);

export const DEPLOYMENT_ENDPOINTS = Object.freeze({
  public: Object.freeze({
    origin: publicOriginURL.origin,
    routeHosts: Object.freeze([
      publicOriginURL.host,
      `www.${publicOriginURL.host}`,
    ]),
  }),
  schemaVersion: DEPLOYMENT_ENDPOINTS_SCHEMA_VERSION,
  sparkle: Object.freeze({
    appcastURL: new URL("/appcast.xml", sparkleUpdateOriginURL).href,
    origin: sparkleUpdateOriginURL.origin,
    r2Bucket: "tibotattle-updates",
  }),
});

export function assertDeploymentEndpoints(
  endpoints = DEPLOYMENT_ENDPOINTS,
) {
  if (!endpoints || typeof endpoints !== "object"
      || endpoints.schemaVersion !== DEPLOYMENT_ENDPOINTS_SCHEMA_VERSION) {
    throw new TypeError("deployment endpoint manifest has an unexpected schema");
  }
  const reviewedPublicOrigin = canonicalHttpsOrigin(
    endpoints.public?.origin,
    "public origin",
  );
  const reviewedSparkleOrigin = canonicalHttpsOrigin(
    endpoints.sparkle?.origin,
    "Sparkle update origin",
  );
  exactStringList(
    endpoints.public?.routeHosts,
    [reviewedPublicOrigin.host, `www.${reviewedPublicOrigin.host}`],
    "public route hosts",
  );
  if (endpoints.sparkle?.appcastURL
      !== new URL("/appcast.xml", reviewedSparkleOrigin).href) {
    throw new TypeError("Sparkle appcast URL must be derived from its origin");
  }
  if (typeof endpoints.sparkle?.r2Bucket !== "string"
      || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(
        endpoints.sparkle.r2Bucket,
      )) {
    throw new TypeError("Sparkle R2 bucket must be a valid reviewed bucket name");
  }
  return endpoints;
}

assertDeploymentEndpoints();
