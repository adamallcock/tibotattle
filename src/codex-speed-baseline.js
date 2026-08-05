// Owner-only ledger of DECLARED Codex speed-mode baselines.
//
// WHAT THIS RECOVERS
// ------------------
// Codex records the speed mode only when it is applied or changed
// (`thread_settings_applied`), never at session start, so a session's BASELINE
// is absent from the rollout log. `~/.codex/config.toml` holds a top-level
// `service_tier` key with the CURRENT setting, which is the only place that
// baseline exists.
//
// WHY IT MAY NEVER BACKFILL
// -------------------------
// The Codex UI rewrites that file on every toggle - its mtime matched a tier
// change event to the exact second - so the key proves the value at READ TIME
// and nothing more. Applying it to history would silently mislabel past data.
// This module therefore stores each reading as a TIMESTAMPED observation and
// resolves it only over the interval it actually covers.
//
// COVERAGE SEMANTICS
// ------------------
// A window is `{ mode, firstSeenAt, lastSeenAt }` and covers turns in the
// CLOSED interval [firstSeenAt, lastSeenAt]: the configuration held this value
// at both ends, and any change strictly between them would itself have been
// written to the rollout log, where it wins outright. Turns after the newest
// `lastSeenAt` are simply not covered until the next reading extends it, and
// the gap after a value CHANGES is left uncovered because the moment of the
// change is unknown. Nothing is ever extrapolated backwards past a
// `firstSeenAt`.
//
// PRECEDENCE
// ----------
// observed (rollout log) > declared baseline covering the turn > owner's stated
// preference > inferred > unknown. A declaration can never override an
// observation; see `resolveEffectiveSpeedMode` in the accounting package.
//
// PRIVACY
// -------
// Only the `service_tier` key is ever read from the Codex configuration (see
// the platform port), and only a speed mode plus two timestamps are ever
// stored. The ledger holds no path, no account identifier, and no prompt
// content, and is written atomically with 0600 permissions through the reviewed
// platform storage port, exactly like the stated-preference document.
import { CODEX_SPEED_MODE_OBSERVABILITY } from "@app-usagemonitor/accounting";

import {
  createOwnerOnlyAutomaticContributionStorageContext,
  readCodexConfigServiceTier,
} from "./platform/index.js";
import { hasExactEnumerableKeys } from "./has-exact-enumerable-keys.js";

export const CODEX_SPEED_BASELINE_SCHEMA_VERSION =
  "codex-speed-baseline-v0.1";

/** Provenance label, distinct from both "observed" and the stated preference. */
export const CODEX_SPEED_BASELINE_PROVENANCE = "declared_codex_config";

// Fixed error codes. Callers map these to fixed statuses; no message from this
// module is ever rendered to a person.
export const CODEX_SPEED_BASELINE_ERROR_CODES = Object.freeze([
  "codex_speed_baseline_unavailable",
]);

/** Fixed, content-free outcomes of one collection-time reading. */
export const CODEX_SPEED_BASELINE_RECORD_STATUSES = Object.freeze([
  // A new window was opened because the declared value changed.
  "opened",
  // The newest window was extended because the declared value was unchanged.
  "extended",
  // Nothing usable was declared; the ledger was left exactly as it was.
  "undeclared",
]);

const MAXIMUM_LEDGER_BYTES = 8 * 1_024;
// Bounded history. Each toggle costs one window, so this is years of ordinary
// use; the oldest windows are dropped first and never merged.
const MAXIMUM_WINDOWS = 64;
const LEDGER_KEYS = Object.freeze(["schemaVersion", "windows"]);
const WINDOW_KEYS = Object.freeze(["firstSeenAt", "lastSeenAt", "mode"]);
const DECLARABLE_MODES = Object.freeze(["standard", "fast"]);

export class CodexSpeedBaselineError extends Error {
  constructor(code) {
    super(code);
    this.name = "CodexSpeedBaselineError";
    this.code = CODEX_SPEED_BASELINE_ERROR_CODES.includes(code)
      ? code
      : "codex_speed_baseline_unavailable";
  }
}

function canonicalInstant(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const normalized = new Date(milliseconds).toISOString();
  return normalized === value ? normalized : null;
}

function validWindow(value) {
  if (!hasExactEnumerableKeys(value, WINDOW_KEYS)) return false;
  if (!DECLARABLE_MODES.includes(value.mode)) return false;
  const first = canonicalInstant(value.firstSeenAt);
  const last = canonicalInstant(value.lastSeenAt);
  return first !== null && last !== null
    && Date.parse(first) <= Date.parse(last);
}

function validLedgerDocument(value) {
  if (!hasExactEnumerableKeys(value, LEDGER_KEYS)) return false;
  if (value.schemaVersion !== CODEX_SPEED_BASELINE_SCHEMA_VERSION) return false;
  if (!Array.isArray(value.windows)) return false;
  if (value.windows.length > MAXIMUM_WINDOWS) return false;
  let previousEndMs = Number.NEGATIVE_INFINITY;
  let previousMode = null;
  for (const window of value.windows) {
    if (!validWindow(window)) return false;
    const startMs = Date.parse(window.firstSeenAt);
    // Windows must be disjoint, ordered, and never repeat an adjacent mode:
    // a repeat would mean two windows that should have been one extension.
    if (startMs < previousEndMs) return false;
    if (window.mode === previousMode) return false;
    previousEndMs = Date.parse(window.lastSeenAt);
    previousMode = window.mode;
  }
  return true;
}

/**
 * The speed mode declared for a turn, or null when no declaration covers it.
 *
 * A turn strictly before the first reading, in the gap after a value changed,
 * or after the newest reading resolves to null - never to a guessed default.
 */
export function declaredSpeedModeAt(windows, timestampMs) {
  if (!Array.isArray(windows)) return null;
  if (!Number.isFinite(timestampMs)) return null;
  for (const window of windows) {
    if (!validWindow(window)) continue;
    const startMs = Date.parse(window.firstSeenAt);
    const endMs = Date.parse(window.lastSeenAt);
    if (timestampMs >= startMs && timestampMs <= endMs) return window.mode;
  }
  return null;
}

/**
 * Map a raw Codex `service_tier` token to a speed mode, or null.
 *
 * The mapping is the provider's own published one, shared from the accounting
 * package so no surface restates it. An unrecognised token is an explicit
 * null: a new or renamed tier must never be guessed into Standard.
 */
export function codexServiceTierSpeedMode(token) {
  if (typeof token !== "string") return null;
  const observed = CODEX_SPEED_MODE_OBSERVABILITY.observedValues;
  const mode = Object.hasOwn(observed, token) ? observed[token] : null;
  return DECLARABLE_MODES.includes(mode) ? mode : null;
}

function projection(windows, { status, declaredMode = null } = {}) {
  return Object.freeze({
    schemaVersion: CODEX_SPEED_BASELINE_SCHEMA_VERSION,
    provenance: CODEX_SPEED_BASELINE_PROVENANCE,
    status,
    declaredMode,
    windows: Object.freeze(windows.map((window) => Object.freeze({ ...window }))),
    // What this evidence is allowed to attribute, restated wherever it lands.
    appliesTo: "turns_at_or_after_the_moment_the_key_was_read",
    neverBackfillsHistory: true,
    retainedKeys: Object.freeze(["service_tier"]),
  });
}

export function createCodexSpeedBaselineController({
  ledgerFile,
  configFile,
  storage = createOwnerOnlyAutomaticContributionStorageContext({
    createError: () => new CodexSpeedBaselineError(
      "codex_speed_baseline_unavailable",
    ),
  }),
  readServiceTier = readCodexConfigServiceTier,
  now = () => new Date(),
} = {}) {
  if (typeof ledgerFile !== "string" || ledgerFile.length < 1) {
    throw new TypeError("ledgerFile must be a non-empty path");
  }
  if (typeof configFile !== "string" || configFile.length < 1) {
    throw new TypeError("configFile must be a non-empty path");
  }
  if (typeof readServiceTier !== "function") {
    throw new TypeError("readServiceTier must be a function");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");

  async function readDocument() {
    let text;
    try {
      text = await storage.readSettingsText({
        settingsFile: ledgerFile,
        maximumBytes: MAXIMUM_LEDGER_BYTES,
      });
    } catch (error) {
      if (error instanceof CodexSpeedBaselineError) throw error;
      throw new CodexSpeedBaselineError("codex_speed_baseline_unavailable");
    }
    if (text === null) return { schemaVersion: CODEX_SPEED_BASELINE_SCHEMA_VERSION, windows: [] };
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new CodexSpeedBaselineError("codex_speed_baseline_unavailable");
    }
    // A malformed or forward-version ledger is never silently repaired into
    // coverage; the caller sees an explicit failure and attributes nothing.
    if (!validLedgerDocument(value)) {
      throw new CodexSpeedBaselineError("codex_speed_baseline_unavailable");
    }
    return value;
  }

  function readingInstant() {
    let instant;
    try {
      instant = new Date(now());
    } catch {
      return null;
    }
    return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
  }

  return Object.freeze({
    schemaVersion: CODEX_SPEED_BASELINE_SCHEMA_VERSION,
    ledgerFile,
    configFile,

    /** The stored windows and their provenance. */
    async inspect() {
      const document = await readDocument();
      return projection(document.windows, { status: "available" });
    },

    /**
     * The stored windows alone, for callers that cannot fail. An unreadable
     * ledger degrades to no coverage rather than inventing an attribution.
     */
    async readWindows() {
      try {
        return (await readDocument()).windows;
      } catch {
        return [];
      }
    },

    /**
     * One collection-time reading of the Codex configuration.
     *
     * Reads only `service_tier`, stamps it with the moment it was read, and
     * either extends the newest window (value unchanged) or opens a new one
     * (value changed). Anything missing, unreadable, or unrecognised is
     * fail-closed: the ledger is left exactly as it was, so the affected turns
     * stay attributable only by the stated preference or remain unknown.
     */
    async record() {
      const document = await readDocument();
      const windows = document.windows.map((window) => ({ ...window }));

      let declaration;
      try {
        declaration = await readServiceTier({ configFile });
      } catch {
        declaration = null;
      }
      const mode = declaration?.status === "declared"
        ? codexServiceTierSpeedMode(declaration.serviceTier)
        : null;
      if (mode === null) {
        return projection(windows, { status: "undeclared" });
      }

      const readAt = readingInstant();
      if (readAt === null) {
        return projection(windows, { status: "undeclared" });
      }
      const readAtMs = Date.parse(readAt);
      const newest = windows.at(-1) ?? null;
      // A clock that moved backwards cannot extend or open a window without
      // claiming coverage it never had. Fail closed and keep the ledger valid.
      if (newest !== null && readAtMs < Date.parse(newest.lastSeenAt)) {
        return projection(windows, { status: "undeclared" });
      }

      let status;
      if (newest !== null && newest.mode === mode) {
        newest.lastSeenAt = readAt;
        status = "extended";
      } else {
        windows.push({ firstSeenAt: readAt, lastSeenAt: readAt, mode });
        status = "opened";
      }
      while (windows.length > MAXIMUM_WINDOWS) windows.shift();

      const next = {
        schemaVersion: CODEX_SPEED_BASELINE_SCHEMA_VERSION,
        windows,
      };
      if (!validLedgerDocument(next)) {
        throw new CodexSpeedBaselineError("codex_speed_baseline_unavailable");
      }
      try {
        await storage.writeSettingsText({
          settingsFile: ledgerFile,
          text: `${JSON.stringify(next)}\n`,
          maximumBytes: MAXIMUM_LEDGER_BYTES,
        });
      } catch (error) {
        if (error instanceof CodexSpeedBaselineError) throw error;
        throw new CodexSpeedBaselineError("codex_speed_baseline_unavailable");
      }
      return projection(windows, { status, declaredMode: mode });
    },
  });
}
