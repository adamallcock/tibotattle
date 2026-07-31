import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const SECRET_BYTES = 32;
const ERROR_CODES = new Set([
  "invalid_configuration",
  "credential_locked",
  "credential_denied",
  "credential_unavailable",
  "credential_missing",
  "credential_conflict",
  "confirmation_required",
  "confirmation_invalid",
]);

export class ClaudeCallbackCapabilityError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Claude callback capability error code");
    }
    super("Claude callback capability operation failed");
    this.name = "ClaudeCallbackCapabilityError";
    this.code = `claude_callback_${code}`;
  }
}

function fail(code) {
  throw new ClaudeCallbackCapabilityError(code);
}

function assertBackend(backend) {
  let valid = false;
  try {
    valid = backend !== null
      && typeof backend === "object"
      && typeof backend.read === "function"
      && typeof backend.createIfMissing === "function"
      && typeof backend.replaceExact === "function"
      && typeof backend.deleteExact === "function";
  } catch {
    // Collapse hostile injected backends to one fixed configuration error.
  }
  if (!valid) fail("invalid_configuration");
  return backend;
}

function translate(error) {
  let code;
  try {
    code = error?.code;
  } catch {
    fail("credential_unavailable");
  }
  if (code === "export_identity_keychain_locked") fail("credential_locked");
  if (code === "export_identity_keychain_denied") fail("credential_denied");
  fail("credential_unavailable");
}

function copySecret(value) {
  if (!Buffer.isBuffer(value) || value.byteLength !== SECRET_BYTES) {
    if (Buffer.isBuffer(value)) value.fill(0);
    fail("credential_unavailable");
  }
  return Buffer.from(value);
}

export function selectProductionClaudeCallbackBackend({
  platform,
  architecture,
  createBackend,
} = {}) {
  if (
    platform !== "darwin"
    || architecture !== "arm64"
    || typeof createBackend !== "function"
  ) {
    fail("invalid_configuration");
  }
  try {
    return assertBackend(createBackend());
  } catch (error) {
    if (error instanceof ClaudeCallbackCapabilityError) throw error;
    translate(error);
  }
}

export function createClaudeCallbackCapabilityContext({
  capability,
} = {}) {
  if (capability === null || capability === undefined) {
    fail("invalid_configuration");
  }

  async function invoke(backend, method, ...args) {
    try {
      return await backend[method](capability, ...args);
    } catch (error) {
      if (error instanceof ClaudeCallbackCapabilityError) throw error;
      translate(error);
    }
  }

  async function readClaudeCallbackCapability({ backend }) {
    const selected = assertBackend(backend);
    const stored = await invoke(selected, "read");
    if (stored === null) return null;
    const result = copySecret(stored);
    stored.fill(0);
    return result;
  }

  async function ensureClaudeCallbackCapability({
    backend,
    generateSecret = () => randomBytes(SECRET_BYTES),
  } = {}) {
    const selected = assertBackend(backend);
    if (typeof generateSecret !== "function") {
      fail("invalid_configuration");
    }
    let generated = null;
    let generatedValue = null;
    let readback = null;
    try {
      const existing = await readClaudeCallbackCapability({
        backend: selected,
      });
      if (existing !== null) {
        return {
          status: "existing",
          secret: existing,
        };
      }
      generatedValue = generateSecret();
      generated = copySecret(generatedValue);
      const outcome = await invoke(
        selected,
        "createIfMissing",
        generated,
      );
      if (!["created", "existing"].includes(outcome)) {
        fail("credential_unavailable");
      }
      readback = await readClaudeCallbackCapability({
        backend: selected,
      });
      if (readback === null) fail("credential_unavailable");
      if (
        outcome === "created"
        && !timingSafeEqual(readback, generated)
      ) {
        fail("credential_unavailable");
      }
      return {
        status: outcome,
        secret: Buffer.from(readback),
      };
    } finally {
      if (Buffer.isBuffer(generatedValue)) generatedValue.fill(0);
      generated?.fill(0);
      readback?.fill(0);
    }
  }

  async function rotateClaudeCallbackCapability({
    backend,
    confirm = false,
    generateSecret = () => randomBytes(SECRET_BYTES),
  } = {}) {
    if (confirm !== true) fail("confirmation_required");
    const selected = assertBackend(backend);
    if (typeof generateSecret !== "function") {
      fail("invalid_configuration");
    }
    let current = null;
    let replacement = null;
    let replacementValue = null;
    try {
      current = await readClaudeCallbackCapability({
        backend: selected,
      });
      if (current === null) fail("credential_missing");
      replacementValue = generateSecret();
      replacement = copySecret(replacementValue);
      const outcome = await invoke(
        selected,
        "replaceExact",
        current,
        replacement,
      );
      if (outcome === "missing") fail("credential_missing");
      if (outcome === "conflict") fail("credential_conflict");
      if (outcome !== "replaced") fail("credential_unavailable");
      return {
        status: "rotated",
      };
    } finally {
      if (Buffer.isBuffer(replacementValue)) replacementValue.fill(0);
      current?.fill(0);
      replacement?.fill(0);
    }
  }

  function confirmationToken(secret, targetBinding) {
    if (
      typeof targetBinding !== "string"
      || !/^[a-f0-9]{64}$/.test(targetBinding)
    ) {
      fail("invalid_configuration");
    }
    const digest = createHmac("sha256", secret)
      .update(
        "app-usagemonitor/claude-callback-capability-removal/v1\0",
      )
      .update(targetBinding)
      .digest();
    return digest.subarray(0, 10).toString("hex").toUpperCase();
  }

  async function planClaudeCallbackCapabilityRemoval({
    backend,
    targetBinding,
  }) {
    let secret = null;
    try {
      secret = await readClaudeCallbackCapability({
        backend,
      });
      if (secret === null) {
        return {
          status: "missing",
          confirmationToken: null,
        };
      }
      return {
        status: "ready",
        confirmationToken: confirmationToken(
          secret,
          targetBinding,
        ),
      };
    } finally {
      secret?.fill(0);
    }
  }

  async function removeClaudeCallbackCapability({
    backend,
    targetBinding,
    providedToken,
  }) {
    if (typeof providedToken !== "string") {
      fail("confirmation_required");
    }
    const selected = assertBackend(backend);
    let secret = null;
    try {
      secret = await readClaudeCallbackCapability({
        backend: selected,
      });
      if (secret === null) fail("credential_missing");
      const expected = Buffer.from(
        confirmationToken(secret, targetBinding),
      );
      const provided = Buffer.from(providedToken);
      const matches = expected.byteLength === provided.byteLength
        && timingSafeEqual(expected, provided);
      expected.fill(0);
      provided.fill(0);
      if (!matches) fail("confirmation_invalid");
      const outcome = await invoke(
        selected,
        "deleteExact",
        secret,
      );
      if (outcome === "missing") fail("credential_missing");
      if (outcome === "conflict") fail("credential_conflict");
      if (outcome !== "deleted") fail("credential_unavailable");
      return {
        status: "removed",
        secureErasure: false,
      };
    } finally {
      secret?.fill(0);
    }
  }

  return Object.freeze({
    ensureClaudeCallbackCapability,
    planClaudeCallbackCapabilityRemoval,
    readClaudeCallbackCapability,
    removeClaudeCallbackCapability,
    rotateClaudeCallbackCapability,
  });
}
