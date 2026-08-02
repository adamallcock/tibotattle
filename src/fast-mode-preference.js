// Owner-only persistence for the Codex Fast-mode preference.
//
// Codex records the speed mode only when it is applied or changed
// (`thread_settings_applied`), never at session start, so turns before the
// first change in a session carry no recorded tier. This statement attributes
// exactly those turns and nothing else: an observed tier always wins over it.
// It is a local, content-free statement about how the owner runs Codex,
// holding no account identifier, no path, and no prompt content. It follows
// the automatic-contribution settings pattern: a single owner-only JSON
// document under the private state directory, written atomically with 0600
// permissions through the reviewed platform storage port.
import {
  CODEX_SPEED_MODE_OBSERVABILITY,
  DEFAULT_FAST_MODE_PREFERENCE,
  FAST_MODE_MULTIPLIER_SOURCE,
  FAST_MODE_PREFERENCE_VALUES,
  FAST_MODE_QUOTA_MULTIPLIERS,
  isFastModePreference,
} from "@app-usagemonitor/accounting";

import {
  createOwnerOnlyAutomaticContributionStorageContext,
} from "./platform/index.js";

export const FAST_MODE_PREFERENCE_SCHEMA_VERSION =
  "fast-mode-preference-v0.1";

// Fixed error codes. Callers map these to fixed HTTP statuses; no message from
// this module is ever rendered to a person.
export const FAST_MODE_PREFERENCE_ERROR_CODES = Object.freeze([
  "fast_mode_preference_invalid",
  "fast_mode_preference_unavailable",
]);

const MAXIMUM_SETTINGS_BYTES = 4 * 1_024;
const SETTINGS_KEYS = Object.freeze([
  "mode",
  "recordedAt",
  "schemaVersion",
]);

export class FastModePreferenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "FastModePreferenceError";
    this.code = FAST_MODE_PREFERENCE_ERROR_CODES.includes(code)
      ? code
      : "fast_mode_preference_unavailable";
  }
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function canonicalInstant(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const normalized = new Date(milliseconds).toISOString();
  return normalized === value ? normalized : null;
}

function validSettingsDocument(value) {
  return exactKeys(value, SETTINGS_KEYS)
    && value.schemaVersion === FAST_MODE_PREFERENCE_SCHEMA_VERSION
    && isFastModePreference(value.mode)
    && canonicalInstant(value.recordedAt) !== null;
}

// The projection handed to the local API. It repeats the published rates and
// their provenance so the dashboard never has to restate them from memory.
function projection(document, { source }) {
  return Object.freeze({
    schemaVersion: FAST_MODE_PREFERENCE_SCHEMA_VERSION,
    mode: document?.mode ?? DEFAULT_FAST_MODE_PREFERENCE,
    defaultMode: DEFAULT_FAST_MODE_PREFERENCE,
    availableModes: [...FAST_MODE_PREFERENCE_VALUES],
    recordedAt: document?.recordedAt ?? null,
    // "default" means nothing has been stated; "stated" means the owner chose.
    source,
    // What the rollout log can prove on its own, so the dashboard can say
    // plainly which turns this statement is allowed to attribute.
    logObservability: { ...CODEX_SPEED_MODE_OBSERVABILITY },
    appliesTo: "turns_with_no_observed_tier_only",
    multipliers: { ...FAST_MODE_QUOTA_MULTIPLIERS },
    multiplierSource: { ...FAST_MODE_MULTIPLIER_SOURCE },
  });
}

export function createFastModePreferenceController({
  settingsFile,
  storage = createOwnerOnlyAutomaticContributionStorageContext({
    createError: (code) => new FastModePreferenceError(
      code === "configuration_invalid"
        ? "fast_mode_preference_invalid"
        : "fast_mode_preference_unavailable",
    ),
  }),
  now = () => new Date(),
} = {}) {
  if (typeof settingsFile !== "string" || settingsFile.length < 1) {
    throw new TypeError("settingsFile must be a non-empty path");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");

  async function readDocument() {
    let text;
    try {
      text = await storage.readSettingsText({
        settingsFile,
        maximumBytes: MAXIMUM_SETTINGS_BYTES,
      });
    } catch (error) {
      if (error instanceof FastModePreferenceError) throw error;
      throw new FastModePreferenceError("fast_mode_preference_unavailable");
    }
    if (text === null) return null;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new FastModePreferenceError("fast_mode_preference_unavailable");
    }
    // A malformed or forward-version document is never silently repaired into
    // a mode; the caller sees an explicit failure instead.
    if (!validSettingsDocument(value)) {
      throw new FastModePreferenceError("fast_mode_preference_unavailable");
    }
    return value;
  }

  return Object.freeze({
    schemaVersion: FAST_MODE_PREFERENCE_SCHEMA_VERSION,
    settingsFile,

    /** The stated preference, or the default when nothing has been stated. */
    async inspect() {
      const document = await readDocument();
      return projection(document, {
        source: document === null ? "default" : "stated",
      });
    },

    /**
     * The mode alone, for callers that cannot fail (the dashboard snapshot).
     * An unreadable document degrades to the Standard default rather than
     * inventing a Fast attribution.
     */
    async readMode() {
      try {
        const document = await readDocument();
        return document?.mode ?? DEFAULT_FAST_MODE_PREFERENCE;
      } catch {
        return DEFAULT_FAST_MODE_PREFERENCE;
      }
    },

    async select(mode) {
      if (!isFastModePreference(mode)) {
        throw new FastModePreferenceError("fast_mode_preference_invalid");
      }
      let recordedAt = null;
      try {
        const instant = new Date(now());
        recordedAt = Number.isFinite(instant.getTime())
          ? instant.toISOString()
          : null;
      } catch {
        recordedAt = null;
      }
      if (recordedAt === null) {
        throw new FastModePreferenceError("fast_mode_preference_unavailable");
      }
      const document = {
        schemaVersion: FAST_MODE_PREFERENCE_SCHEMA_VERSION,
        mode,
        recordedAt,
      };
      try {
        await storage.writeSettingsText({
          settingsFile,
          text: `${JSON.stringify(document)}\n`,
          maximumBytes: MAXIMUM_SETTINGS_BYTES,
        });
      } catch (error) {
        if (error instanceof FastModePreferenceError) throw error;
        throw new FastModePreferenceError("fast_mode_preference_unavailable");
      }
      return projection(document, { source: "stated" });
    },
  });
}
