// Accountless contribution policy is distinct from explicit consent. This
// controller stores the selection only; it never creates credentials or sends
// data. The composition root must establish freshness and select a policy.
export const CONTRIBUTION_PREFERENCE_SCHEMA_VERSION = "local-contribution-preference-v1";
const MAXIMUM_BYTES = 4_096;
const VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const KEYS = ["basis", "destinationOrigin", "enabled", "policyVersion", "schemaVersion", "updatedAt"];
const BASES = new Set(["default_on", "user_choice", "legacy_preserved"]);

function failure() {
  const error = new Error("Contribution preference unavailable");
  error.code = "contribution_preference_unavailable";
  return error;
}

function validOrigin(value) {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password
      && (url.protocol === "https:"
        || (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== ""));
  } catch { return false; }
}

function validRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === KEYS.join("\0")
    && value.schemaVersion === CONTRIBUTION_PREFERENCE_SCHEMA_VERSION
    && typeof value.enabled === "boolean" && BASES.has(value.basis)
    && !(value.basis === "default_on" && !value.enabled)
    && !(value.basis === "legacy_preserved" && value.enabled)
    && typeof value.policyVersion === "string" && VERSION.test(value.policyVersion)
    && validOrigin(value.destinationOrigin)
    && typeof value.updatedAt === "string" && value.updatedAt.length === 24
    && Number.isFinite(Date.parse(value.updatedAt))
    && new Date(value.updatedAt).toISOString() === value.updatedAt;
}

export function createLocalContributionPreference({
  settingsFile,
  policyVersion,
  destinationOrigin,
  installationState = "unknown",
  defaultEnabled = false,
  now = () => new Date(),
}, { storage } = {}) {
  if (typeof settingsFile !== "string" || settingsFile.length === 0
      || typeof policyVersion !== "string" || !VERSION.test(policyVersion)
      || !validOrigin(destinationOrigin)
      || !["fresh", "existing", "unknown"].includes(installationState)
      || typeof defaultEnabled !== "boolean" || typeof now !== "function"
      || typeof storage?.readSettingsText !== "function"
      || typeof storage?.writeSettingsText !== "function") {
    throw new TypeError("Invalid contribution preference configuration");
  }
  let record = null;
  let initialized = false;
  let available = true;
  let operations = Promise.resolve();
  const serialize = (operation) => {
    const pending = operations.then(operation, operation);
    operations = pending.catch(() => {});
    return pending;
  };
  const project = () => {
    const current = available && record !== null
      && record.policyVersion === policyVersion
      && record.destinationOrigin === destinationOrigin;
    return Object.freeze({
      schemaVersion: CONTRIBUTION_PREFERENCE_SCHEMA_VERSION,
      available,
      current,
      enabled: current && record.enabled,
      basis: record?.basis ?? null,
      policyVersion: record?.policyVersion ?? null,
      destinationOrigin: record?.destinationOrigin ?? null,
      updatedAt: record?.updatedAt ?? null,
    });
  };
  const persist = async (enabled, basis) => {
    const instant = now();
    const date = instant instanceof Date ? instant : new Date(instant);
    if (!Number.isFinite(date.getTime())) throw failure();
    const next = { schemaVersion: CONTRIBUTION_PREFERENCE_SCHEMA_VERSION,
      enabled, basis, policyVersion, destinationOrigin, updatedAt: date.toISOString() };
    // No enabled projection can escape a failed durable write. Do not replace
    // unreadable state with a guessed fresh-install default.
    try {
      await storage.writeSettingsText({ settingsFile,
        text: `${JSON.stringify(next)}\n`, maximumBytes: MAXIMUM_BYTES });
      record = next;
    } catch {
      available = false;
      throw failure();
    }
  };
  const initialize = (initialSelection = null) => serialize(async () => {
    if (initialized) return project();
    initialized = true;
    try {
      const text = await storage.readSettingsText({ settingsFile, maximumBytes: MAXIMUM_BYTES });
      if (text === null) {
        const enabled = initialSelection ?? (installationState === "fresh" && defaultEnabled);
        await persist(enabled, initialSelection === null
          ? (enabled ? "default_on" : "legacy_preserved") : "user_choice");
      } else {
        if (typeof text !== "string" || text.length > MAXIMUM_BYTES) throw failure();
        const parsed = JSON.parse(text);
        if (!validRecord(parsed)) throw failure();
        record = parsed;
      }
    } catch { available = false; }
    return project();
  });
  return Object.freeze({
    initialize: () => initialize(),
    inspect: async () => { await initialize(); return serialize(async () => project()); },
    // Only a user action may call this method. Callers must await the durable
    // off selection before revoking credentials; failed revocation must never
    // undo the local preference. Stop in-flight transport on any write failure.
    setEnabled: async (enabled) => {
      if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
      await initialize(enabled);
      return serialize(async () => {
        if (!available) throw failure();
        await persist(enabled, "user_choice");
        return project();
      });
    },
  });
}
