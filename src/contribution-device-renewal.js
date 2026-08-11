import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { defaultExportStateDirectory } from "./export-identity.js";
import { renewContributionDeviceCredential } from "./contribution-device-client.js";

// Companion half of the sign-in-once auto-renewal (section 2 of
// docs/design/2026-08-11-sign-in-once-durability.md). The 30-day device
// credential is rotated in place ~5 days before it would lapse, authenticated
// by the existing credential, so a normal sync cadence keeps it alive forever
// with no user sign-in. This orchestration only DECIDES and RECORDS; the actual
// rotation is the injected client call, and every failure is non-fatal — the
// old credential stays valid on the service until its real expiry, so a
// skipped or failed renewal never blocks an upload.

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
// Mirror of the service's DEVICE_CREDENTIAL_TTL_MILLISECONDS (constants.ts:26);
// used only to bound a persisted expiry, never as identity.
export const DEVICE_CREDENTIAL_TTL_MILLISECONDS = 30 * DAY_MILLISECONDS;
// Renew once inside the last 5 days of the TTL — i.e. at ~25 days — so a device
// synced at least weekly always rotates well before lapse.
export const DEFAULT_RENEWAL_LEAD_MILLISECONDS = 5 * DAY_MILLISECONDS;
const RENEWAL_STATE_SCHEMA_VERSION = "contribution-device-renewal-v1";
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

function canonicalRenewalState({ deviceId, expiresAt }) {
  return `${JSON.stringify({
    schemaVersion: RENEWAL_STATE_SCHEMA_VERSION,
    deviceId,
    expiresAt,
  })}\n`;
}

/**
 * The renewal-state file records only public-ish binding metadata — the device
 * id and the last-known expiry — never any secret; the durable secret lives in
 * the Keychain. It is therefore read tolerantly: any absence, malformed
 * content, or unexpected shape yields `null` (the caller then treats the
 * credential as unseeded and waits for the next pairing to seed it) rather than
 * an error that could stall a sync pass.
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
      || Object.keys(parsed).sort().join("\0") !== "deviceId\0expiresAt\0schemaVersion"
      || parsed.schemaVersion !== RENEWAL_STATE_SCHEMA_VERSION
      || typeof parsed.deviceId !== "string" || !DEVICE_ID_PATTERN.test(parsed.deviceId)
      || !validExpiry(parsed.expiresAt)) {
    return null;
  }
  return Object.freeze({ deviceId: parsed.deviceId, expiresAt: parsed.expiresAt });
}

export async function writeContributionDeviceRenewalState(stateFile, { deviceId, expiresAt } = {}) {
  if (typeof stateFile !== "string" || stateFile.length < 1
      || typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)
      || !validExpiry(expiresAt)) {
    fail("invalid_configuration");
  }
  const content = canonicalRenewalState({ deviceId, expiresAt });
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
 * Is the credential inside its renewal window? A credential whose last-known
 * expiry is at or within `leadMilliseconds` of `now` is due; an unknown or
 * unparseable expiry is deliberately NOT treated as due (the credential is
 * seeded with a real expiry at pairing, so "unknown" means "not yet seeded",
 * which must wait rather than churn a fresh credential).
 */
export function contributionDeviceCredentialRenewalDue({
  expiresAt,
  now,
  leadMilliseconds = DEFAULT_RENEWAL_LEAD_MILLISECONDS,
} = {}) {
  if (!validExpiry(expiresAt)
      || !Number.isFinite(now)
      || !Number.isSafeInteger(leadMilliseconds) || leadMilliseconds < 0) {
    return false;
  }
  return now >= Date.parse(expiresAt) - leadMilliseconds;
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
  leadMilliseconds = DEFAULT_RENEWAL_LEAD_MILLISECONDS,
  capabilityOptions = {},
  renew = renewContributionDeviceCredential,
  readState = readContributionDeviceRenewalState,
  writeState = writeContributionDeviceRenewalState,
} = {}) {
  if (typeof renewalStateFile !== "string" || renewalStateFile.length < 1
      || !Number.isFinite(now)
      || !Number.isSafeInteger(leadMilliseconds) || leadMilliseconds < 0
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
    expiresAt: state.expiresAt,
    now,
    leadMilliseconds,
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
