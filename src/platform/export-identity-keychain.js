import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, sep } from "node:path";

const require = createRequire(import.meta.url);
const SECRET_BYTES = 32;
const STORED_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NATIVE_BINDING_SPECIFIER = "@github/keytar/prebuilds/darwin-arm64/keytar.node";

// The audited artifact exactly as published: this is the hash of the npm
// prebuild BEFORE any code signing. The Developer ID release pipeline
// re-signs keytar.node in place (hardened-runtime library validation demands
// a same-team signature), which rewrites the Mach-O, so a production install
// can never match these bytes. Signed derivatives are accepted through the
// designated-requirement verification below instead.
export const KEYTAR_DARWIN_ARM64_SHA256 = "855c21e1e702967230bd87f600d04c311b77f29150f3372d547e72882c58de6a";
// The two facts a signed derivative must prove, and nothing build-specific:
// the Apple Developer ID team that signs this product's releases, and the
// code identifier codesign derives for the keytar prebuild. Together they are
// the binding's designated requirement — stable across every properly signed
// build, unlike a CDHash or a byte digest of a signed binary.
export const KEYTAR_SIGNING_TEAM_IDENTIFIER = "43RTH622SB";
export const KEYTAR_SIGNING_CODE_IDENTIFIER = "keytar";

// The reader of the contribution-device credential is the packaged Node
// runtime — the companion process that calls keytar. A credential item minted
// with keytar's default `SecItemAdd` access control is trusted to exactly the
// creating code's snapshot (its partition / code-directory hash), NOT to a
// stable designated requirement, so the next Developer ID build — a Sparkle
// update re-signs `runtime/bin/node` — presents a different code object and the
// default ACL denies it; a headless read then fails errSecInteractionNotAllowed
// / errSecAuthFailed and the credential reads as unavailable. keytar exposes no
// way to pass a `SecAccessRef` / `kSecAttrAccess` / `kSecAttrAccessGroup`, so it
// cannot express a designated-requirement ACL. These two facts are the team and
// the codesign-derived identifier of that reader; together they are the
// designated requirement the durable ACL binds to — stable across every
// same-team, same-identifier signed build.
export const CONTRIBUTION_DEVICE_READER_TEAM_IDENTIFIER = "43RTH622SB";
export const CONTRIBUTION_DEVICE_READER_CODE_IDENTIFIER = "node";
const CODESIGN_PATH = "/usr/bin/codesign";
const SECURITY_PATH = "/usr/bin/security";
// errSecItemNotFound surfaces from the security CLI as exit status 44.
const SECURITY_ITEM_NOT_FOUND_STATUS = 44;

export const EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES = Object.freeze({
  exportIdentity: Object.freeze({
    service: "app-usagemonitor.export-identity.v1",
    account: "installation",
  }),
  accountObservation: Object.freeze({
    service: "app-usagemonitor.account-observation.v1",
    account: "installation",
  }),
  claudeSessionPseudonym: Object.freeze({
    service: "app-usagemonitor.claude-session-pseudonym.v1",
    account: "installation",
  }),
  contributionDevice: Object.freeze({
    service: "app-usagemonitor.contribution-device.v1",
    account: "installation",
  }),
  // The app-managed storage generation of the contribution-device credential:
  // minted by the signed TiboTattle.app via SecItemAdd (an app-created item
  // never raises the partition/ACL dialog for its creator) and served to the
  // companion over the app's Keychain broker channel. A different service
  // string, not a marker attribute, separates the generations so app-side
  // code can never accidentally decrypt a `security`-CLI-minted `.v1` item —
  // that read is exactly the partition prompt the broker exists to eliminate.
  contributionDeviceApp: Object.freeze({
    service: "app-usagemonitor.contribution-device.app.v1",
    account: "installation",
  }),
});

const ERROR_CODES = new Set([
  "unsupported_platform",
  "unsupported_architecture",
  "invalid_configuration",
  "binding_unavailable",
  "binding_integrity",
  "invalid_capability",
  "invalid_secret",
  "stored_value_invalid",
  "operation_failed",
  "locked",
  "denied",
  "readback_mismatch",
]);

export class ExportIdentityKeychainError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) throw new TypeError("Unknown export identity Keychain error code");
    super("macOS Keychain backend failed");
    this.name = "ExportIdentityKeychainError";
    this.code = `export_identity_keychain_${code}`;
  }
}

function fail(code) {
  throw new ExportIdentityKeychainError(code);
}

function validateBinding(binding) {
  let valid = false;
  try {
    valid = binding !== null && typeof binding === "object"
      && typeof binding.getPassword === "function"
      && typeof binding.setPassword === "function"
      && typeof binding.deletePassword === "function";
  } catch {
    // Treat hostile or broken binding property access as configuration failure.
  }
  if (!valid) fail("invalid_configuration");
  return binding;
}

/**
 * The exact requirement string a signed keytar binding must satisfy: Apple's
 * generic anchor, this product's Developer ID team, and the binding's own
 * code identifier. Deliberately nothing else — no version, no CDHash, no
 * certificate serial — so a Sparkle update signed by the same team keeps
 * passing while any other origin fails.
 */
export function keytarSignedBindingRequirement() {
  return "anchor apple generic"
    + ` and certificate leaf[subject.OU] = "${KEYTAR_SIGNING_TEAM_IDENTIFIER}"`
    + ` and identifier "${KEYTAR_SIGNING_CODE_IDENTIFIER}"`;
}

/**
 * The constructed codesign invocation, exported so a test can pin the exact
 * arguments without a signed binary: --verify validates the embedded
 * signature's page hashes, --strict keeps the validation modern, and
 * -R= makes codesign additionally test the designated requirement above.
 */
export function keytarSignedBindingVerificationArguments(bindingPath) {
  return Object.freeze([
    "--verify",
    "--strict",
    `-R=${keytarSignedBindingRequirement()}`,
    "--",
    bindingPath,
  ]);
}

function defaultRunVerificationCommand(command, commandArguments) {
  const outcome = spawnSync(command, commandArguments, {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { status: outcome.status };
}

/**
 * The designated requirement the contribution-device credential's ACL binds
 * to: Apple's generic anchor, this product's Developer ID team, and the code
 * identifier codesign derives for the packaged Node runtime. Deliberately
 * nothing build-specific — no version, no CDHash — so any properly signed
 * same-team, same-identifier build (a Sparkle update) keeps read access while
 * any other origin fails. This is the reader-side analogue of
 * keytarSignedBindingRequirement().
 */
export function contributionDeviceReaderRequirement() {
  return "anchor apple generic"
    + ` and certificate leaf[subject.OU] = "${CONTRIBUTION_DEVICE_READER_TEAM_IDENTIFIER}"`
    + ` and identifier "${CONTRIBUTION_DEVICE_READER_CODE_IDENTIFIER}"`;
}

/**
 * The codesign invocation that proves a reader binary satisfies the designated
 * requirement the durable ACL binds to. A signed update cycle is the only
 * definitive proof that the ACL survives; this pins the exact `-R=` semantics
 * a release check (or the owner, by hand) runs against the installed
 * `runtime/bin/node` to confirm the next build still matches the requirement.
 */
export function contributionDeviceReaderRequirementVerificationArguments(readerPath) {
  return Object.freeze([
    "--verify",
    "--strict",
    `-R=${contributionDeviceReaderRequirement()}`,
    "--",
    readerPath,
  ]);
}

/**
 * The exact `security add-generic-password` invocation that mints the
 * contribution-device credential with a designated-requirement ACL.
 *
 * `-T <readerPath>` records the reader's SecTrustedApplication, whose match is
 * performed against its designated requirement (the reader's team + identifier)
 * rather than a build-specific snapshot, so a re-signed update is still trusted
 * without a prompt. `-U` makes the create idempotent. `-w <secret>` supplies
 * the base64url secret exactly as keytar would store it, so a later keytar
 * getPassword reads the identical stored string back.
 *
 * TRADE-OFF (documented, owner-directed): the secret is passed as a process
 * argument, briefly visible to same-user/root process inspection. The
 * 2026-07-24 Keychain decision record rejects the `security` write path for the
 * *installation identity* for exactly this reason. This credential is a
 * different, lower-value bearer — a revocable, rate-limited, auto-renewing
 * device-upload token — and the sign-in-once design doc
 * (docs/design/2026-08-11-sign-in-once-durability.md) explicitly re-weighs the
 * trade-off for it, sanctioning "the `security`-CLI equivalent the codebase can
 * invoke" so a signed update never invalidates read access. The mint falls back
 * to keytar's default ACL if this invocation fails, so availability never
 * regresses below today's behaviour.
 */
export function contributionDeviceDurableAddArguments({
  service,
  account,
  secret,
  readerPath,
} = {}) {
  if (typeof service !== "string" || service.length < 1
      || typeof account !== "string" || account.length < 1
      || typeof secret !== "string" || !STORED_SECRET_PATTERN.test(secret)
      || typeof readerPath !== "string" || !isAbsolute(readerPath)) {
    fail("invalid_configuration");
  }
  return Object.freeze([
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    account,
    "-T",
    readerPath,
    "-w",
    secret,
  ]);
}

function defaultRunDurableAddCommand(command, commandArguments) {
  // The secret is on the argv; keep every stdio stream discarded so it can
  // never enter a log, an error, or a caller.
  const outcome = spawnSync(command, commandArguments, {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { status: outcome.status };
}

/**
 * Load only trusted bytes at the audited prebuild path: either the exact
 * audited npm artifact (development installs, byte-pinned), or a signed
 * derivative of it that macOS proves was signed by this product's Developer
 * ID team with the binding's own identifier. The Developer ID release
 * pipeline verifies the audited bytes immediately before signing, so the
 * signed acceptance chains back to the same audit. The package JavaScript
 * loader is deliberately bypassed so it cannot select a build artifact at
 * runtime.
 */
export function loadExportIdentityKeychainBinding(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid_configuration");
  const {
    platform = process.platform,
    architecture = process.arch,
    resolveBinding = (specifier) => require.resolve(specifier),
    readBinding = (path) => readFileSync(path),
    requireBinding = (path) => require(path),
    runVerificationCommand = defaultRunVerificationCommand,
  } = options;
  if (platform !== "darwin") fail("unsupported_platform");
  if (architecture !== "arm64") fail("unsupported_architecture");
  if (typeof resolveBinding !== "function" || typeof readBinding !== "function"
      || typeof requireBinding !== "function"
      || typeof runVerificationCommand !== "function") fail("invalid_configuration");

  let bindingPath;
  let bindingBytes;
  try {
    bindingPath = resolveBinding(NATIVE_BINDING_SPECIFIER);
    const requiredSuffix = ["prebuilds", "darwin-arm64", "keytar.node"].join(sep);
    if (typeof bindingPath !== "string" || !isAbsolute(bindingPath)
        || !bindingPath.endsWith(`${sep}${requiredSuffix}`)) fail("invalid_configuration");
    bindingBytes = readBinding(bindingPath);
  } catch (error) {
    if (error instanceof ExportIdentityKeychainError) throw error;
    fail("binding_unavailable");
  }

  if (!Buffer.isBuffer(bindingBytes) && !(bindingBytes instanceof Uint8Array)) {
    fail("invalid_configuration");
  }
  const digest = createHash("sha256").update(bindingBytes).digest("hex");
  if (digest !== KEYTAR_DARWIN_ARM64_SHA256) {
    // Not the audited bytes. Signing rewrites the Mach-O, so this is the
    // expected state of every Developer ID build (observed live 2026-08-10:
    // the byte pin alone turned the first signed Sparkle update into a total
    // Keychain outage). Accept the file only if macOS proves it carries a
    // valid signature satisfying the designated requirement; anything else
    // stays failed closed.
    let verified = false;
    try {
      const outcome = runVerificationCommand(
        CODESIGN_PATH,
        keytarSignedBindingVerificationArguments(bindingPath),
      );
      verified = outcome !== null && typeof outcome === "object"
        && outcome.status === 0;
    } catch {
      // Verification failures are content-free: fall through to fail closed.
    }
    if (!verified) fail("binding_integrity");
  }

  try {
    return validateBinding(requireBinding(bindingPath));
  } catch (error) {
    if (error instanceof ExportIdentityKeychainError) throw error;
    fail("binding_unavailable");
  }
}

function capabilityPair(capability) {
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity) {
    return EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity;
  }
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation) {
    return EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;
  }
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym) {
    return EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym;
  }
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice) {
    return EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice;
  }
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp) {
    return EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp;
  }
  fail("invalid_capability");
}

function copySecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.byteLength !== SECRET_BYTES) fail("invalid_secret");
  return Buffer.from(secret);
}

function decodeStoredSecret(value, errorCode = "stored_value_invalid") {
  if (typeof value !== "string" || !STORED_SECRET_PATTERN.test(value)) fail(errorCode);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== SECRET_BYTES || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    fail(errorCode);
  }
  return decoded;
}

function sameSecret(left, right) {
  return timingSafeEqual(left, right);
}

const LOCKED_ERROR_CODES = new Set([
  "ERR_KEYCHAIN_LOCKED",
  "KEYCHAIN_LOCKED",
  "errSecInteractionNotAllowed",
  -25308,
]);
const DENIED_ERROR_CODES = new Set([
  "ERR_KEYCHAIN_DENIED",
  "KEYCHAIN_DENIED",
  "errSecAuthFailed",
  "errSecUserCanceled",
  -25293,
  -128,
]);
const LOCKED_ERROR_MESSAGES = new Set([
  "User interaction is not allowed.",
]);
const DENIED_ERROR_MESSAGES = new Set([
  "The user name or passphrase you entered is not correct.",
  "User canceled the operation.",
]);

function nativeFailureCode(error) {
  let code;
  let message;
  try {
    code = error?.code;
    message = error?.message;
  } catch {
    return "operation_failed";
  }
  if (LOCKED_ERROR_CODES.has(code)) return "locked";
  if (DENIED_ERROR_CODES.has(code)) return "denied";
  // The audited keytar native binding exposes Security.framework failures as
  // message-only Napi errors. Match only exact platform strings; never include
  // an upstream message in the public error.
  if (LOCKED_ERROR_MESSAGES.has(message)) return "locked";
  if (DENIED_ERROR_MESSAGES.has(message)) return "denied";
  return "operation_failed";
}

function normalizeDurableAccess(durableAccess) {
  if (durableAccess === null || durableAccess === undefined) return null;
  if (typeof durableAccess !== "object" || Array.isArray(durableAccess)) {
    fail("invalid_configuration");
  }
  const {
    platform = process.platform,
    readerPath,
    runCommand = defaultRunDurableAddCommand,
  } = durableAccess;
  // A designated-requirement ACL is a macOS-only construct; on any other
  // platform durable access is silently inert and keytar's default path is
  // used, exactly as before.
  if (platform !== "darwin") return null;
  if (typeof readerPath !== "string" || readerPath.length < 1
      || !isAbsolute(readerPath)
      || typeof runCommand !== "function") {
    fail("invalid_configuration");
  }
  return Object.freeze({ readerPath, runCommand });
}

/**
 * This adapter intentionally does not claim compare-and-swap semantics.
 * Callers must hold the app's installation/export-identity lease around every
 * create, replace, or delete transaction.
 */
export function createExportIdentityKeychainBackend(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid_configuration");
  const {
    binding = undefined,
    loadBinding = loadExportIdentityKeychainBinding,
    // Optional durable-ACL mint for the contribution-device credential only.
    // When present, a fresh mint of that one capability is written through the
    // `security` CLI with a designated-requirement ACL so a signed update keeps
    // read access; every other capability, and the readback of this one, still
    // go through keytar unchanged.
    durableAccess = null,
  } = options;
  if (typeof loadBinding !== "function") fail("invalid_configuration");
  const durableMint = normalizeDurableAccess(durableAccess);
  let selectedBinding = binding;
  if (selectedBinding === undefined) {
    try {
      selectedBinding = loadBinding();
    } catch (error) {
      if (error instanceof ExportIdentityKeychainError) throw error;
      fail("binding_unavailable");
    }
  }
  const nativeBinding = validateBinding(selectedBinding);

  async function invoke(method, ...args) {
    try {
      return await nativeBinding[method](...args);
    } catch (error) {
      fail(nativeFailureCode(error));
    }
  }

  // Write a fresh secret for a capability. The contribution-device credential
  // is minted with a designated-requirement ACL through the `security` CLI when
  // durable access is configured; if that invocation is unavailable or fails,
  // it falls back to keytar's default ACL so availability never regresses below
  // today's behaviour. Every other capability always uses keytar.
  async function writeSecret(pair, secretString) {
    if (durableMint !== null
        && pair === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice) {
      let status;
      try {
        const outcome = durableMint.runCommand(
          SECURITY_PATH,
          contributionDeviceDurableAddArguments({
            service: pair.service,
            account: pair.account,
            secret: secretString,
            readerPath: durableMint.readerPath,
          }),
        );
        status = outcome !== null && typeof outcome === "object"
          ? outcome.status
          : undefined;
      } catch {
        status = undefined;
      }
      if (status === 0) return;
      // The durable mint did not take. Fall through to keytar so the credential
      // is still created (with the update-fragile default ACL that Part 2's
      // renewal and the attribute-reset repair path both already handle).
    }
    await invoke("setPassword", pair.service, pair.account, secretString);
  }

  async function describe(capability) {
    capabilityPair(capability);
    return Object.freeze({ backend: "macos_keychain", status: "available" });
  }

  async function readInternal(capability, invalidCode = "stored_value_invalid") {
    const pair = capabilityPair(capability);
    const stored = await invoke("getPassword", pair.service, pair.account);
    if (stored === null) return null;
    return decodeStoredSecret(stored, invalidCode);
  }

  async function read(capability) {
    let secret = null;
    try {
      secret = await readInternal(capability);
      return secret === null ? null : Buffer.from(secret);
    } finally {
      secret?.fill(0);
    }
  }

  async function createIfMissing(capability, generatedSecret) {
    const pair = capabilityPair(capability);
    let generated = null;
    let existing = null;
    let readback = null;
    try {
      generated = copySecret(generatedSecret);
      existing = await readInternal(capability);
      if (existing !== null) return "existing";
      await writeSecret(pair, generated.toString("base64url"));
      readback = await readInternal(capability, "readback_mismatch");
      if (readback === null || !sameSecret(readback, generated)) fail("readback_mismatch");
      return "created";
    } finally {
      generated?.fill(0);
      existing?.fill(0);
      readback?.fill(0);
    }
  }

  async function replaceExact(capability, expectedSecret, replacementSecret) {
    const pair = capabilityPair(capability);
    let expected = null;
    let replacement = null;
    let current = null;
    let readback = null;
    try {
      expected = copySecret(expectedSecret);
      replacement = copySecret(replacementSecret);
      current = await readInternal(capability);
      if (current === null) return "missing";
      if (!sameSecret(current, expected)) return "conflict";
      await invoke("setPassword", pair.service, pair.account, replacement.toString("base64url"));
      readback = await readInternal(capability, "readback_mismatch");
      if (readback === null || !sameSecret(readback, replacement)) fail("readback_mismatch");
      return "replaced";
    } finally {
      expected?.fill(0);
      replacement?.fill(0);
      current?.fill(0);
      readback?.fill(0);
    }
  }

  async function deleteExact(capability, expectedSecret) {
    const pair = capabilityPair(capability);
    let expected = null;
    let current = null;
    let readback = null;
    try {
      expected = copySecret(expectedSecret);
      current = await readInternal(capability);
      if (current === null) return "missing";
      if (!sameSecret(current, expected)) return "conflict";
      await invoke("deletePassword", pair.service, pair.account);
      readback = await readInternal(capability, "readback_mismatch");
      if (readback !== null) fail("readback_mismatch");
      return "deleted";
    } finally {
      expected?.fill(0);
      current?.fill(0);
      readback?.fill(0);
    }
  }

  return Object.freeze({ read, createIfMissing, replaceExact, deleteExact, describe });
}

/**
 * The constructed security invocation for an attribute-addressed delete,
 * exported so a test can pin the exact arguments. Deleting by service and
 * account never decrypts the item, so it needs neither the native binding
 * nor the item's access control list — it works in exactly the states where
 * a read cannot (verified live 2026-08-10 against a credential the updated
 * app could no longer read).
 */
export function exportIdentityKeychainAttributeDeleteArguments(capability) {
  const pair = capabilityPair(capability);
  return Object.freeze([
    "delete-generic-password",
    "-s",
    pair.service,
    "-a",
    pair.account,
  ]);
}

/**
 * The constructed security invocation for an attribute-addressed presence
 * probe, exported so a test can pin the exact arguments. Without `-w` or `-g`
 * the tool reports the item's attributes and never decrypts it, so — exactly
 * like the attribute delete — it needs neither the native binding nor the
 * item's access control list, and it cannot raise the partition/ACL dialog.
 */
export function exportIdentityKeychainAttributeProbeArguments(capability) {
  const pair = capabilityPair(capability);
  return Object.freeze([
    "find-generic-password",
    "-s",
    pair.service,
    "-a",
    pair.account,
  ]);
}

function defaultRunAttributeDeleteCommand(command, commandArguments) {
  // The security CLI prints the deleted item's attributes on success; they
  // are discarded unread so nothing about the item can enter an error, a
  // log, or a caller.
  const outcome = spawnSync(command, commandArguments, {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { status: outcome.status };
}

/**
 * Delete a capability's Keychain item by its fixed attributes, without ever
 * reading the secret. This is the repair path for a credential the ordinary
 * backend cannot read — a broken access control list, or a native binding
 * that cannot even load — and must therefore depend on neither.
 */
export function deleteExportIdentityKeychainItemByAttributes(
  capability,
  options = {},
) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  const {
    platform = process.platform,
    runCommand = defaultRunAttributeDeleteCommand,
  } = options;
  const commandArguments =
    exportIdentityKeychainAttributeDeleteArguments(capability);
  if (platform !== "darwin") fail("unsupported_platform");
  if (typeof runCommand !== "function") fail("invalid_configuration");
  let outcome;
  try {
    outcome = runCommand(SECURITY_PATH, commandArguments);
  } catch {
    fail("operation_failed");
  }
  const status = outcome !== null && typeof outcome === "object"
    ? outcome.status
    : undefined;
  if (status === 0) return "deleted";
  if (status === SECURITY_ITEM_NOT_FOUND_STATUS) return "missing";
  fail("operation_failed");
}

/**
 * Answer whether a capability's Keychain item exists, without decrypting it
 * and therefore without any possibility of a prompt or of loading the native
 * binding. The third outcome is the load-bearing one: callers use this to
 * decide whether a legacy item is worth reaching for, and "unknown" must keep
 * them on the path they would have taken anyway, so an unreadable probe can
 * never make an existing install look like a fresh one.
 */
export function exportIdentityKeychainItemPresenceByAttributes(
  capability,
  options = {},
) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  const {
    platform = process.platform,
    runCommand = defaultRunAttributeDeleteCommand,
  } = options;
  const commandArguments =
    exportIdentityKeychainAttributeProbeArguments(capability);
  if (platform !== "darwin" || typeof runCommand !== "function") {
    return "unknown";
  }
  let outcome;
  try {
    outcome = runCommand(SECURITY_PATH, commandArguments);
  } catch {
    return "unknown";
  }
  const status = outcome !== null && typeof outcome === "object"
    ? outcome.status
    : undefined;
  if (status === 0) return "present";
  if (status === SECURITY_ITEM_NOT_FOUND_STATUS) return "missing";
  return "unknown";
}
