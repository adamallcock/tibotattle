import { ApiError } from "./errors";

const IDENTITY_LINK_SECRET_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const IDENTITY_LINK_SECRET_FINGERPRINT_DOMAIN =
  "app-usagemonitor/identity-link-secret-fingerprint/v1\0";

interface PinnedIdentityLinkSecretConfiguration {
  key_version: string;
  secret_fingerprint: string;
}

function configuredIdentityLinkSecret(value: unknown): string {
  if (typeof value !== "string" || value.length < 32) {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  return value;
}

function configuredIdentityLinkSecretVersion(value: unknown): string {
  if (typeof value !== "string"
      || !IDENTITY_LINK_SECRET_VERSION_PATTERN.test(value)) {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  return value;
}

async function identityLinkSecretFingerprint(secret: string): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    new TextEncoder().encode(IDENTITY_LINK_SECRET_FINGERPRINT_DOMAIN),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Pins the non-secret key-version label and a one-way keyed fingerprint in the
 * primary database. A raw IDENTITY_LINK_SECRET change would otherwise create
 * a new HMAC identity namespace: existing accounts could not reattach and a
 * deletion cooldown derived under the old key would no longer match. We fail
 * closed instead of silently treating that as a fresh population.
 *
 * The first successful hosted-identity operation establishes the pin while
 * enrollment is still under operator control. Rotation is intentionally not a
 * hot configuration operation; it needs an explicit, separately reviewed
 * dual-key migration before this record can change.
 */
export async function assertPinnedIdentityLinkSecretConfiguration(
  db: D1Database,
  rawSecret: unknown,
  rawVersion: unknown,
  nowEpoch = Date.now(),
): Promise<void> {
  const secret = configuredIdentityLinkSecret(rawSecret);
  const keyVersion = configuredIdentityLinkSecretVersion(rawVersion);
  const secretFingerprint = await identityLinkSecretFingerprint(secret);
  try {
    await db.prepare(
      `INSERT INTO identity_link_secret_configuration (
        singleton, key_version, secret_fingerprint, recorded_at
      ) VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO NOTHING`,
    ).bind(
      keyVersion,
      secretFingerprint,
      new Date(nowEpoch).toISOString(),
    ).run();
    const pinned = await db.prepare(
      `SELECT key_version, secret_fingerprint
         FROM identity_link_secret_configuration
        WHERE singleton = 1`,
    ).first<PinnedIdentityLinkSecretConfiguration>();
    if (pinned?.key_version !== keyVersion
        || pinned.secret_fingerprint !== secretFingerprint) {
      throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}
