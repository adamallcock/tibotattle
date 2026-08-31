import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, sep } from "node:path";

const require = createRequire(import.meta.url);
const BINDING_SPECIFIER = "@github/keytar/prebuilds/linux-x64/keytar.node";

export const LINUX_KEYTAR_BINDING_MANIFEST = Object.freeze({
  package: "@github/keytar",
  version: "7.10.6",
  target: "linux-x64",
  relativePath: "prebuilds/linux-x64/keytar.node",
  bytes: 109_664,
  sha256: "e7894a1e1001764de29ff08d3dae418ccbaaf78889c5673d367e05df1682fc7c",
});

const ERROR_CODES = new Set([
  "unsupported_platform",
  "unsupported_architecture",
  "invalid_configuration",
  "binding_unavailable",
  "binding_path_invalid",
  "binding_integrity",
  "binding_mutated",
  "binding_invalid",
]);

const trustedErrors = new WeakSet();
const verifiedBindingMetadata = new WeakMap();

export class LinuxSecretServiceBindingError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Linux Secret Service binding error code");
    }
    super("Linux Secret Service binding failed");
    this.name = "LinuxSecretServiceBindingError";
    this.code = `linux_secret_service_binding_${code}`;
    trustedErrors.add(this);
  }
}

export function isLinuxSecretServiceBindingError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === LinuxSecretServiceBindingError.prototype);
}

function fail(code) {
  throw new LinuxSecretServiceBindingError(code);
}

function defaultDigestBinding(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function defaultResolveBinding(specifier) {
  return require.resolve(specifier);
}

function defaultReadBinding(path) {
  return readFileSync(path);
}

/**
 * Qualification-grade provenance requires more than matching path bytes on
 * both sides of the native load: the complete path must also be outside the
 * unprivileged qualification user's mutation authority. The native AMD64
 * container stages `/workspace` as root-owned and non-writable before it
 * drops to the `node` user. Ordinary user-owned development installs can
 * still load for injected/unit use, but do not receive provenance credit.
 */
function defaultVerifyImmutableBindingPath(bindingPath) {
  try {
    if (process.platform !== "linux"
        || typeof process.getuid !== "function"
        || realpathSync(bindingPath) !== bindingPath) {
      return false;
    }
    let current = bindingPath;
    let bindingFile = true;
    while (true) {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()
          || metadata.uid !== 0
          || (metadata.mode & 0o022) !== 0
          || (bindingFile
            ? !metadata.isFile() || metadata.nlink !== 1
            : !metadata.isDirectory())) {
        return false;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      bindingFile = false;
    }
    return true;
  } catch {
    return false;
  }
}

function validBytes(bytes) {
  return Buffer.isBuffer(bytes) || bytes instanceof Uint8Array;
}

/**
 * Snapshot the three keytar methods into a frozen facade. Native module
 * exports remain mutable JavaScript objects, so retaining the original object
 * would let later property replacement change the credential boundary after
 * construction.
 */
export function snapshotLinuxSecretServiceBinding(binding) {
  let getPassword;
  let setPassword;
  let deletePassword;
  try {
    getPassword = binding?.getPassword;
    setPassword = binding?.setPassword;
    deletePassword = binding?.deletePassword;
  } catch {
    fail("binding_invalid");
  }
  if (typeof getPassword !== "function"
      || typeof setPassword !== "function"
      || typeof deletePassword !== "function") {
    fail("binding_invalid");
  }
  try {
    return Object.freeze({
      getPassword: getPassword.bind(binding),
      setPassword: setPassword.bind(binding),
      deletePassword: deletePassword.bind(binding),
    });
  } catch {
    fail("binding_invalid");
  }
}

function readSnapshot(readBinding, bindingPath, failureCode) {
  let bytes;
  try {
    bytes = readBinding(bindingPath);
  } catch {
    fail("binding_unavailable");
  }
  if (!validBytes(bytes)) fail("invalid_configuration");
  // Copy before hashing so a caller-controlled Uint8Array cannot mutate the
  // bytes while the digest implementation consumes them.
  let snapshot;
  try {
    snapshot = Buffer.from(bytes);
  } catch {
    fail("invalid_configuration");
  }
  if (snapshot.byteLength !== LINUX_KEYTAR_BINDING_MANIFEST.bytes) {
    snapshot.fill(0);
    fail(failureCode);
  }
  return snapshot;
}

function digestSnapshot(digestBinding, snapshot) {
  let digest;
  try {
    digest = digestBinding(snapshot);
  } catch {
    fail("invalid_configuration");
  }
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
    fail("invalid_configuration");
  }
  return digest;
}

/**
 * Load only the reviewed keytar 7.10.6 Linux x64 prebuild. The package's
 * JavaScript entrypoint is deliberately bypassed, and the bytes are checked
 * both immediately before and immediately after native loading.
 *
 * `digestBinding` exists solely so unit tests can exercise the success and
 * post-load mutation branches without checking a 109 KiB native binary into
 * the test tree. A result obtained with that override is explicitly marked as
 * unverified and cannot produce provenance evidence.
 */
export function loadLinuxSecretServiceBinding(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  let platform;
  let architecture;
  let resolveBinding;
  let readBinding;
  let requireBinding;
  let digestBinding;
  let verifyImmutableBindingPath;
  let usesDefaultRequireBinding;
  let usesDefaultImmutablePathVerifier;
  try {
    usesDefaultRequireBinding = !Object.hasOwn(options, "requireBinding");
    usesDefaultImmutablePathVerifier = !Object.hasOwn(
      options,
      "verifyImmutableBindingPath",
    );
    ({
      platform = process.platform,
      architecture = process.arch,
      resolveBinding = defaultResolveBinding,
      readBinding = defaultReadBinding,
      requireBinding = (path) => require(path),
      digestBinding = defaultDigestBinding,
      verifyImmutableBindingPath = defaultVerifyImmutableBindingPath,
    } = options);
  } catch {
    fail("invalid_configuration");
  }
  if (platform !== "linux") fail("unsupported_platform");
  if (architecture !== "x64") fail("unsupported_architecture");
  if (typeof resolveBinding !== "function"
      || typeof readBinding !== "function"
      || typeof requireBinding !== "function"
      || typeof digestBinding !== "function"
      || typeof verifyImmutableBindingPath !== "function") {
    fail("invalid_configuration");
  }

  let bindingPath;
  try {
    bindingPath = resolveBinding(BINDING_SPECIFIER);
  } catch {
    fail("binding_unavailable");
  }
  const requiredSuffix = ["prebuilds", "linux-x64", "keytar.node"].join(sep);
  if (typeof bindingPath !== "string"
      || !isAbsolute(bindingPath)
      || !bindingPath.endsWith(`${sep}${requiredSuffix}`)) {
    fail("binding_path_invalid");
  }

  let immutableBefore = false;
  try {
    immutableBefore = verifyImmutableBindingPath(bindingPath) === true;
  } catch {
    immutableBefore = false;
  }

  const before = readSnapshot(readBinding, bindingPath, "binding_integrity");
  let beforeDigest;
  try {
    beforeDigest = digestSnapshot(digestBinding, before);
  } finally {
    before.fill(0);
  }
  if (beforeDigest !== LINUX_KEYTAR_BINDING_MANIFEST.sha256) {
    fail("binding_integrity");
  }

  let loaded;
  try {
    loaded = requireBinding(bindingPath);
  } catch {
    fail("binding_unavailable");
  }
  const binding = snapshotLinuxSecretServiceBinding(loaded);

  const after = readSnapshot(readBinding, bindingPath, "binding_mutated");
  let afterDigest;
  try {
    afterDigest = digestSnapshot(digestBinding, after);
  } finally {
    after.fill(0);
  }
  if (afterDigest !== beforeDigest
      || afterDigest !== LINUX_KEYTAR_BINDING_MANIFEST.sha256) {
    fail("binding_mutated");
  }

  let immutableAfter = false;
  try {
    immutableAfter = verifyImmutableBindingPath(bindingPath) === true;
  } catch {
    immutableAfter = false;
  }
  const immutablePathVerified = immutableBefore && immutableAfter;

  verifiedBindingMetadata.set(binding, Object.freeze({
    manifest: LINUX_KEYTAR_BINDING_MANIFEST,
    pathDigestVerifiedBeforeAndAfter: true,
    immutablePathVerified,
    // Provenance is true only for a native Linux/x64 load through every
    // closed-over filesystem, module-loader, SHA-256, and root-owned immutable
    // path check. Any injected seam is useful for tests but never evidence.
    provenanceVerified: platform === process.platform
      && architecture === process.arch
      && resolveBinding === defaultResolveBinding
      && readBinding === defaultReadBinding
      && usesDefaultRequireBinding
      && digestBinding === defaultDigestBinding
      && usesDefaultImmutablePathVerifier
      && immutablePathVerified,
  }));
  return binding;
}

export function linuxSecretServiceBindingEvidence(binding) {
  let metadata;
  try {
    metadata = verifiedBindingMetadata.get(binding);
  } catch {
    return null;
  }
  if (!metadata) return null;
  return Object.freeze({
    target: metadata.manifest.target,
    bytes: metadata.manifest.bytes,
    sha256: metadata.manifest.sha256,
    pathDigestVerifiedBeforeAndAfter:
      metadata.pathDigestVerifiedBeforeAndAfter,
    immutablePathVerified: metadata.immutablePathVerified,
    provenanceVerified: metadata.provenanceVerified,
  });
}
