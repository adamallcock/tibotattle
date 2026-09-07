import { Socket } from "node:net";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  MACOS_KEYCHAIN_BROKER_CAPABILITY_NAMES,
  macOSKeychainBrokerCapabilityName,
} from "./platform/index.js";

export {
  MACOS_KEYCHAIN_BROKER_CAPABILITY_NAMES,
} from "./platform/index.js";

// The signed macOS app announces its Keychain broker by naming the file
// descriptor it dup2'd onto the spawned companion — the app's end of a
// private socketpair. The variable carries only that descriptor number:
// the channel itself is the authority (only the spawned child holds the
// peer end), so no token, endpoint, or secret ever crosses argv or the
// environment.
export const CONTRIBUTION_DEVICE_KEYCHAIN_BROKER_FD_ENV =
  "USAGE_MONITOR_KEYCHAIN_BROKER_FD";
export const CONTRIBUTION_DEVICE_KEYCHAIN_BROKER_PROTOCOL_VERSION = 2;

// One request or response per newline-terminated JSON frame. The credential
// is 43 base64url characters, so a legitimate frame is under 256 bytes; the
// cap exists to fail the channel closed on anything that is not this
// protocol.
const MAXIMUM_FRAME_BYTES = 4_096;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const STORED_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WIRE_OPERATIONS = new Set(["get", "set", "delete"]);
const WIRE_CAPABILITIES = new Set(
  Object.values(MACOS_KEYCHAIN_BROKER_CAPABILITY_NAMES),
);

// KEYCHAIN_LOCKED, KEYCHAIN_DENIED, and KEYCHAIN_MIGRATION_REQUIRED are the
// exact fixed codes the export-identity backend classifies. Migration remains
// distinct so the product can direct the user to the native Secure upgrade
// review after bounded silent retries. Only deliberate native approval may
// enable a prompt; the companion cannot approve or reset the retry budget.
// Credential reset is not migration recovery.
// Other broker failures collapse to the existing credential-unavailable
// surface.
const ERROR_CODES = new Set([
  "KEYCHAIN_LOCKED",
  "KEYCHAIN_DENIED",
  "KEYCHAIN_MIGRATION_REQUIRED",
  "broker_unavailable",
  "broker_timeout",
  "broker_protocol",
  "broker_rejected",
  "invalid_configuration",
]);

export class ContributionDeviceKeychainBrokerError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown contribution device Keychain broker error code");
    }
    super("Contribution device Keychain broker operation failed");
    this.name = "ContributionDeviceKeychainBrokerError";
    this.code = code;
  }
}

function fail(code) {
  throw new ContributionDeviceKeychainBrokerError(code);
}

/**
 * Read the broker announcement from the spawn environment. Absent means the
 * companion was not started by the app (development, tests, Windows) and the
 * existing companion-side Keychain paths stay authoritative. Present but
 * malformed must NOT silently fall back to the companion-side mint — that
 * would resurrect the first-pairing dialog invisibly — so it yields a
 * configuration whose descriptor is null and whose transport therefore fails
 * every request with a coded, recoverable error.
 */
export function contributionDeviceKeychainBrokerConfiguration(environment = process.env) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    fail("invalid_configuration");
  }
  const raw = environment[CONTRIBUTION_DEVICE_KEYCHAIN_BROKER_FD_ENV];
  if (raw === undefined || raw === null) return null;
  const valid = typeof raw === "string" && /^(?:0|[1-9][0-9]{0,3})$/.test(raw);
  return Object.freeze({ fd: valid ? Number.parseInt(raw, 10) : null });
}

function defaultConnect({ fd }) {
  // The socketpair end is already connected; wrapping it never dials out.
  return new Socket({ fd, readable: true, writable: true });
}

// A dup2'd socketpair descriptor has exactly one byte stream. The local server
// already constructs the contribution-device adapter explicitly, while other
// packaged capabilities discover the broker through their default backend;
// caching here makes those call paths share the one ordered reader instead of
// wrapping the same descriptor in competing Socket instances.
const sharedDefaultTransports = new Map();

/**
 * One shared request/response channel over the app-held socketpair end.
 * Requests are answered strictly in order; any deviation — a timeout, an
 * unexpected identifier, an oversized or unparsable frame, a socket error,
 * end-of-file — poisons the transport permanently and rejects every pending
 * and future request with a coded error. There is no reconnect: the
 * descriptor is a one-shot kernel channel whose lifetime is the app's, and
 * the app restarting the companion is the only honest recovery.
 */
export function createContributionDeviceKeychainBrokerTransport({
  fd = null,
  connect = defaultConnect,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if ((fd !== null && (!Number.isSafeInteger(fd) || fd < 0 || fd > 9_999))
      || typeof connect !== "function"
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    fail("invalid_configuration");
  }
  const shared = connect === defaultConnect
    && timeoutMs === DEFAULT_REQUEST_TIMEOUT_MS
    && fd !== null;
  if (shared && sharedDefaultTransports.has(fd)) {
    return sharedDefaultTransports.get(fd);
  }
  let socket = null;
  let poisonedCode = null;
  let nextRequestId = 1;
  let received = "";
  const pending = [];

  function poison(code) {
    if (poisonedCode === null) poisonedCode = code;
    const rejected = pending.splice(0, pending.length);
    for (const entry of rejected) {
      clearTimeout(entry.timer);
      entry.reject(new ContributionDeviceKeychainBrokerError(code));
    }
    if (socket !== null) {
      const held = socket;
      socket = null;
      try {
        held.destroy();
      } catch {
        // The channel is already unusable; teardown failures carry nothing.
      }
    }
  }

  function settleFrame(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      poison("broker_protocol");
      return;
    }
    const entry = pending[0];
    if (!frame || typeof frame !== "object" || Array.isArray(frame)
        || entry === undefined || frame.id !== entry.id) {
      poison("broker_protocol");
      return;
    }
    pending.shift();
    clearTimeout(entry.timer);
    if (frame.ok === true) {
      entry.resolve(frame);
      return;
    }
    if (frame.ok === false && typeof frame.code === "string") {
      if (frame.code === "locked") {
        entry.reject(new ContributionDeviceKeychainBrokerError("KEYCHAIN_LOCKED"));
        return;
      }
      if (frame.code === "denied") {
        entry.reject(new ContributionDeviceKeychainBrokerError("KEYCHAIN_DENIED"));
        return;
      }
      if (frame.code === "migration_required") {
        entry.reject(new ContributionDeviceKeychainBrokerError(
          "KEYCHAIN_MIGRATION_REQUIRED",
        ));
        return;
      }
      entry.reject(new ContributionDeviceKeychainBrokerError("broker_rejected"));
      return;
    }
    poison("broker_protocol");
  }

  function consume(chunk) {
    received += chunk;
    if (Buffer.byteLength(received, "utf8") > MAXIMUM_FRAME_BYTES) {
      poison("broker_protocol");
      return;
    }
    let newline = received.indexOf("\n");
    while (newline !== -1 && poisonedCode === null) {
      const line = received.slice(0, newline);
      received = received.slice(newline + 1);
      settleFrame(line);
      newline = received.indexOf("\n");
    }
  }

  function ensureSocket() {
    if (socket !== null) return socket;
    if (fd === null) fail("broker_unavailable");
    let created;
    try {
      created = connect({ fd });
    } catch {
      fail("broker_unavailable");
    }
    if (!created || typeof created.on !== "function"
        || typeof created.write !== "function") {
      fail("broker_unavailable");
    }
    created.setEncoding?.("utf8");
    created.on("data", (chunk) => consume(String(chunk)));
    created.on("error", () => poison("broker_unavailable"));
    created.on("close", () => poison("broker_unavailable"));
    created.on("end", () => poison("broker_unavailable"));
    // The channel must never hold the companion's event loop open on its
    // own; in-flight requests stay referenced through their timeout timers.
    created.unref?.();
    socket = created;
    return created;
  }

  async function request(operation) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)
        || !WIRE_OPERATIONS.has(operation.op)
        || !WIRE_CAPABILITIES.has(operation.capability)
        || (operation.op === "set"
          && (typeof operation.secret !== "string"
            || !STORED_SECRET_PATTERN.test(operation.secret)))
        || (operation.op !== "set" && operation.secret !== undefined)) {
      fail("invalid_configuration");
    }
    if (poisonedCode !== null) fail(poisonedCode);
    const channel = ensureSocket();
    const id = nextRequestId;
    nextRequestId += 1;
    const frame = `${JSON.stringify({
      v: CONTRIBUTION_DEVICE_KEYCHAIN_BROKER_PROTOCOL_VERSION,
      id,
      op: operation.op,
      capability: operation.capability,
      ...(operation.op === "set" ? { secret: operation.secret } : {}),
    })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => poison("broker_timeout"), timeoutMs);
      pending.push({ id, resolve, reject, timer });
      try {
        channel.write(frame);
      } catch {
        poison("broker_unavailable");
      }
    });
  }

  const transport = Object.freeze({ request });
  if (shared) sharedDefaultTransports.set(fd, transport);
  return transport;
}

/**
 * The keytar-shaped adapter the export-identity Keychain backend accepts as
 * an injected binding: compare-and-swap, read-back, and zeroization logic runs
 * unchanged while every actual Keychain touch happens inside the signed app.
 * The wire carries only one of four fixed logical names, never a service or
 * account, so companion input cannot expand the native app's authority.
 */
export function createMacOSKeychainBrokerBinding({
  transport,
} = {}) {
  if (!transport || typeof transport !== "object"
      || typeof transport.request !== "function") {
    fail("invalid_configuration");
  }
  function capabilityName(service, account) {
    const matches = Object.values(EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES)
      .filter((capability) => (
        capability.service === service && capability.account === account
      ));
    if (matches.length !== 1) {
      fail("invalid_configuration");
    }
    const name = macOSKeychainBrokerCapabilityName(matches[0]);
    if (name === null) fail("invalid_configuration");
    return name;
  }
  return Object.freeze({
    async getPassword(service, account) {
      const capability = capabilityName(service, account);
      const response = await transport.request({ op: "get", capability });
      const stored = response?.secret;
      if (stored === null || stored === undefined) return null;
      if (typeof stored !== "string" || !STORED_SECRET_PATTERN.test(stored)) {
        fail("broker_protocol");
      }
      return stored;
    },
    async setPassword(service, account, value) {
      const capability = capabilityName(service, account);
      if (typeof value !== "string" || !STORED_SECRET_PATTERN.test(value)) {
        fail("invalid_configuration");
      }
      await transport.request({ op: "set", capability, secret: value });
    },
    async deletePassword(service, account) {
      const capability = capabilityName(service, account);
      await transport.request({ op: "delete", capability });
      return true;
    },
  });
}

/**
 * Compatibility adapter retained for the contribution-device capability.
 * Unlike the general binding, this surface refuses every other logical
 * capability even though the shared wire transport can serve them.
 */
export function createContributionDeviceKeychainBrokerBinding(options = {}) {
  const binding = createMacOSKeychainBrokerBinding(options);
  const allowed = new Set([
    EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp,
  ]);
  function assertPair(service, account) {
    const capability = [...allowed].find((candidate) => (
      candidate.service === service && candidate.account === account
    ));
    if (capability === undefined) fail("invalid_configuration");
  }
  return Object.freeze({
    async getPassword(service, account) {
      assertPair(service, account);
      return binding.getPassword(service, account);
    },
    async setPassword(service, account, value) {
      assertPair(service, account);
      return binding.setPassword(service, account, value);
    },
    async deletePassword(service, account) {
      assertPair(service, account);
      return binding.deletePassword(service, account);
    },
  });
}

/** One cached transport per inherited descriptor; a socketpair has one reader. */
const sharedBindings = new Map();

export function createMacOSKeychainBrokerBindingFromEnvironment(
  environment = process.env,
) {
  const configuration = contributionDeviceKeychainBrokerConfiguration(
    environment,
  );
  if (configuration === null) return null;
  const key = configuration.fd;
  if (!sharedBindings.has(key)) {
    sharedBindings.set(key, createMacOSKeychainBrokerBinding({
      transport: createContributionDeviceKeychainBrokerTransport(
        configuration,
      ),
    }));
  }
  return sharedBindings.get(key);
}
