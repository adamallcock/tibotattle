import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { defaultExportStateDirectory } from "./export-identity.js";
import { renewContributionDeviceCredential } from "./contribution-device-client.js";

// Companion half of the sign-in-once auto-renewal (section 2 of
// docs/design/2026-08-11-sign-in-once-durability.md). The device credential is
// rotated in place before it would lapse, authenticated by the existing
// credential, so a normal sync cadence keeps it alive with no user sign-in.
// This orchestration only DECIDES and RECORDS; the actual rotation is the
// injected client call, and every failure is non-fatal — the old credential
// stays valid on the service until its real expiry, so a skipped or failed
// renewal never blocks an upload.
//
// The renewal point is a FRACTION of the credential's own observed lifetime,
// not a fixed lead before expiry. The constraint is the inactive tail: whatever
// the lead is, a Mac whose open-to-open gap exceeds it misses every renewal
// window and lapses, and a fixed lead makes that tail as narrow as the lead
// itself. Renewing at the halfway point makes the tolerated gap half the TTL
// rather than a handful of days, which is the widest margin available without
// rotating so often that the rotation history becomes the cost.
//
// The lifetime is read from the credential rather than from a mirrored copy of
// the service TTL, because the two versions ship independently: a companion
// whose mirror ran ahead of the deployed service would compute a lead longer
// than the credential it is handed and re-trigger on every pass. Anchoring on
// the recorded issuance instant makes a freshly issued credential provably not
// due, whatever TTL the service is currently minting.

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
// Mirror of the service's DEVICE_CREDENTIAL_TTL_MILLISECONDS (constants.ts).
// Only a fallback: it dates a v1 record that predates issuance tracking, and is
// never used once a record carries its own issuance instant. Drift against the
// deployed service costs at most one extra rotation, which then writes the real
// instant and self-corrects.
export const DEVICE_CREDENTIAL_TTL_MILLISECONDS = 90 * DAY_MILLISECONDS;
// Renew once half of the credential's own lifetime has elapsed.
export const DEFAULT_RENEWAL_ELAPSED_FRACTION = 0.5;
// A credential is never renewed twice inside this span. The elapsed-fraction
// rule alone converges when the service caps an expiry below a full TTL (it
// does so approaching the social-recheck deadline, which no rotation may
// cross): each rotation then returns a shorter lifetime, and half of a
// shrinking lifetime is a shrinking wait. The floor turns that geometric decay
// into at most one rotation a day until the credential simply runs out, which
// is the honest outcome — a deadline rotation cannot move.
export const MINIMUM_RENEWAL_SPACING_MILLISECONDS = 1 * DAY_MILLISECONDS;
const RENEWAL_STATE_SCHEMA_VERSION = "contribution-device-renewal-v2";
const LEGACY_RENEWAL_STATE_SCHEMA_VERSION = "contribution-device-renewal-v1";
const MAXIMUM_STATE_BYTES = 512;
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const OUTCOME_STATUSES = new Set([
  "unseeded",
  "not_due",
  "renewed",
  "renewal_failed",
]);

const ERROR_CODES = new Set([
  "invalid_configuration",
  "state_unavailable",
]);

export class ContributionDeviceRenewalError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown contribution device renewal error code");
    }
    super("Contribution device renewal failed");
    this.name = "ContributionDeviceRenewalError";
    this.code = `contribution_device_renewal_${code}`;
  }
}

function fail(code) {
  throw new ContributionDeviceRenewalError(code);
}

export function defaultContributionDeviceRenewalStateFile(options) {
  return join(
    defaultExportStateDirectory(options),
    "contribution-device-renewal-v1.json",
  );
}

function validExpiry(value) {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function canonicalRenewalState({ deviceId, issuedAt, expiresAt }) {
  return `${JSON.stringify({
    schemaVersion: RENEWAL_STATE_SCHEMA_VERSION,
    deviceId,
    issuedAt,
    expiresAt,
  })}\n`;
}

const V2_KEYS = "deviceId\0expiresAt\0issuedAt\0schemaVersion";
const V1_KEYS = "deviceId\0expiresAt\0schemaVersion";

/**
 * The renewal-state file records only public-ish binding metadata — the device
 * id, when this Mac obtained the credential, and its last-known expiry — never
 * any secret; the durable secret lives in the Keychain. It is therefore read
 * tolerantly: any absence, malformed content, or unexpected shape yields `null`
 * (the caller then treats the credential as unseeded and waits for the next
 * pairing to seed it) rather than an error that could stall a sync pass.
 *
 * A v1 record predates issuance tracking and is read rather than discarded,
 * because discarding it would report a paired Mac as unseeded and stop renewing
 * it altogether. Its `issuedAt` is `null`; the due rule dates it from the
 * mirrored TTL and the first renewal rewrites the record as v2.
 */
export async function readContributionDeviceRenewalState(stateFile) {
  if (typeof stateFile !== "string" || stateFile.length < 1) fail("invalid_configuration");
  let handle;
  let text;
  try {
    handle = await open(stateFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size < 1 || stats.size > MAXIMUM_STATE_BYTES) {
      return null;
    }
    text = (await handle.readFile()).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || typeof parsed.deviceId !== "string" || !DEVICE_ID_PATTERN.test(parsed.deviceId)
      || !validExpiry(parsed.expiresAt)) {
    return null;
  }
  const keys = Object.keys(parsed).sort().join("\0");
  if (keys === V2_KEYS
      && parsed.schemaVersion === RENEWAL_STATE_SCHEMA_VERSION
      && validExpiry(parsed.issuedAt)) {
    return Object.freeze({
      deviceId: parsed.deviceId,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
    });
  }
  if (keys === V1_KEYS
      && parsed.schemaVersion === LEGACY_RENEWAL_STATE_SCHEMA_VERSION) {
    return Object.freeze({
      deviceId: parsed.deviceId,
      issuedAt: null,
      expiresAt: parsed.expiresAt,
    });
  }
  return null;
}

export async function writeContributionDeviceRenewalState(
  stateFile,
  { deviceId, issuedAt, expiresAt } = {},
) {
  if (typeof stateFile !== "string" || stateFile.length < 1
      || typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)
      || !validExpiry(issuedAt)
      || !validExpiry(expiresAt)) {
    fail("invalid_configuration");
  }
  const content = canonicalRenewalState({ deviceId, issuedAt, expiresAt });
  const directory = dirname(stateFile);
  const temporary = join(directory, `.${basename(stateFile)}.${process.pid}.tmp`);
  let handle;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, stateFile);
    return Object.freeze({ deviceId, expiresAt });
  } catch {
    fail("state_unavailable");
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

/**
 * When this Mac obtained the credential, as an epoch. A v2 record states it; a
 * v1 record (or one whose stated issuance is not before its expiry, which no
 * service response can produce) is dated backwards from the mirrored TTL. A
 * mirror longer than the credential the service actually issued dates the
 * record too early and so reports it due at once — one rotation, after which
 * the record carries a real instant and the mirror stops mattering.
 */
function credentialIssuedEpoch({ issuedAt, expiresAt }) {
  const expiryEpoch = Date.parse(expiresAt);
  if (validExpiry(issuedAt)) {
    const issuedEpoch = Date.parse(issuedAt);
    if (issuedEpoch < expiryEpoch) return issuedEpoch;
  }
  return expiryEpoch - DEVICE_CREDENTIAL_TTL_MILLISECONDS;
}

/**
 * Is the credential inside its renewal window? Due once `elapsedFraction` of
 * its own lifetime has passed AND it has been held for at least
 * `minimumSpacingMilliseconds`. An unknown or unparseable expiry is
 * deliberately NOT treated as due (the credential is seeded with a real expiry
 * at pairing, so "unknown" means "not yet seeded", which must wait rather than
 * churn a fresh credential).
 *
 * Both conditions are anchored on issuance, so a credential handed over a
 * moment ago cannot be due whatever the service's TTL: renewing one is
 * therefore always a step forward, never a loop.
 */
export function contributionDeviceCredentialRenewalDue({
  issuedAt = null,
  expiresAt,
  now,
  elapsedFraction = DEFAULT_RENEWAL_ELAPSED_FRACTION,
  minimumSpacingMilliseconds = MINIMUM_RENEWAL_SPACING_MILLISECONDS,
} = {}) {
  if (!validExpiry(expiresAt)
      || !Number.isFinite(now)
      || !Number.isFinite(elapsedFraction)
      || elapsedFraction <= 0 || elapsedFraction >= 1
      || !Number.isSafeInteger(minimumSpacingMilliseconds)
      || minimumSpacingMilliseconds < 0) {
    return false;
  }
  const issuedEpoch = credentialIssuedEpoch({ issuedAt, expiresAt });
  const lifetime = Date.parse(expiresAt) - issuedEpoch;
  if (now < issuedEpoch + minimumSpacingMilliseconds) return false;
  return now >= issuedEpoch + lifetime * elapsedFraction;
}

/**
 * On a normal sync pass, renew the device credential if it is inside its
 * renewal window, and record the new expiry. Best-effort by contract: it never
 * throws for a network/rotation failure — the old credential remains valid
 * until its real expiry and the next pass retries. The only thrown error is a
 * misconfiguration of the injected collaborators.
 *
 * The renewal always targets the CURRENT binding (the injected `renew` reads
 * the live device id and secret and rotates them), and re-records the tracker
 * from the id the service returns, so a tracker left stale by a re-pair simply
 * corrects itself on the next successful renewal.
 *
 * @returns a bounded outcome: `unseeded` (no expiry recorded yet — pairing will
 *   seed it), `not_due`, `renewed`, or `renewal_failed`.
 */
export async function renewContributionDeviceCredentialIfDue({
  origin,
  renewalStateFile = defaultContributionDeviceRenewalStateFile(),
  now = Date.now(),
  elapsedFraction = DEFAULT_RENEWAL_ELAPSED_FRACTION,
  minimumSpacingMilliseconds = MINIMUM_RENEWAL_SPACING_MILLISECONDS,
  capabilityOptions = {},
  renew = renewContributionDeviceCredential,
  readState = readContributionDeviceRenewalState,
  writeState = writeContributionDeviceRenewalState,
} = {}) {
  if (typeof renewalStateFile !== "string" || renewalStateFile.length < 1
      || !Number.isFinite(now)
      || !Number.isFinite(elapsedFraction)
      || elapsedFraction <= 0 || elapsedFraction >= 1
      || !Number.isSafeInteger(minimumSpacingMilliseconds)
      || minimumSpacingMilliseconds < 0
      || typeof renew !== "function"
      || typeof readState !== "function"
      || typeof writeState !== "function"
      || !capabilityOptions || typeof capabilityOptions !== "object"
      || Array.isArray(capabilityOptions)) {
    fail("invalid_configuration");
  }
  const state = await readState(renewalStateFile);
  if (state === null) return Object.freeze({ status: "unseeded" });
  if (!contributionDeviceCredentialRenewalDue({
    issuedAt: state.issuedAt ?? null,
    expiresAt: state.expiresAt,
    now,
    elapsedFraction,
    minimumSpacingMilliseconds,
  })) {
    return Object.freeze({ status: "not_due", expiresAt: state.expiresAt });
  }
  let renewed;
  try {
    renewed = await renew({ origin, capabilityOptions });
  } catch {
    // Non-fatal: the service still holds the current secret, so the credential
    // stays valid until its real expiry and the next pass tries again.
    return Object.freeze({ status: "renewal_failed" });
  }
  if (!renewed || typeof renewed !== "object"
      || typeof renewed.deviceId !== "string"
      || !DEVICE_ID_PATTERN.test(renewed.deviceId)
      || !validExpiry(renewed.expiresAt)) {
    return Object.freeze({ status: "renewal_failed" });
  }
  try {
    await writeState(renewalStateFile, {
      deviceId: renewed.deviceId,
      // The service states an expiry, not an issuance; this pass observed the
      // handover, so `now` is the issuance instant and the interval between
      // them is the lifetime the service actually granted.
      issuedAt: new Date(now).toISOString(),
      expiresAt: renewed.expiresAt,
    });
  } catch {
    // The rotation succeeded on both the service and the Keychain; only the
    // due-tracking record failed to update. Harmless: the next pass re-reads
    // the old (still valid) recorded expiry and simply renews again.
    return Object.freeze({ status: "renewed", expiresAt: renewed.expiresAt });
  }
  return Object.freeze({ status: "renewed", expiresAt: renewed.expiresAt });
}

export { OUTCOME_STATUSES as CONTRIBUTION_DEVICE_RENEWAL_OUTCOME_STATUSES };
