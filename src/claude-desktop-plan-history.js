import { constants } from "node:fs";
import { createHmac } from "node:crypto";
import { lstat, open } from "node:fs/promises";

export const CLAUDE_DESKTOP_PLAN_HISTORY_VERSION =
  "claude-desktop-plan-history-v0.1";
export const CLAUDE_DESKTOP_PLAN_HISTORY_AUTHORITY =
  "claude_desktop_plan_history";

const MAXIMUM_FILE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_SAMPLES = 100_000;
const MAXIMUM_METERS_PER_SAMPLE = 32;
const KNOWN_METERS = Object.freeze({
  fh: "five_hour",
  sd: "seven_day_all_models",
  xu: "extra_usage",
});

export class ClaudeDesktopPlanHistoryError extends Error {
  constructor(code) {
    super(`Claude Desktop plan history failed (${code})`);
    this.name = "ClaudeDesktopPlanHistoryError";
    this.code = `claude_desktop_plan_history_${code}`;
  }
}

function fail(code) {
  throw new ClaudeDesktopPlanHistoryError(code);
}

function checkSignal(signal) {
  if (signal === null || signal === undefined) return;
  if (typeof signal !== "object" || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function") fail("configuration");
  if (signal.aborted) fail("aborted");
}

function secretBuffer(secret) {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) fail("configuration");
  return Buffer.from(secret);
}

function keyed(secret, domain, ...values) {
  const digest = createHmac("sha256", secret)
    .update(`app-usagemonitor/${domain}/v1\0`, "utf8");
  for (const value of values) digest.update(String(value), "utf8").update("\0", "utf8");
  return digest.digest("hex");
}

function safeLimit(value, fallback, maximum) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    fail("configuration");
  }
  return selected;
}

function assertPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function parseClaudeDesktopPlanHistory(value, {
  secret,
  maximumSamples,
  maximumMetersPerSample,
  signal = null,
} = {}) {
  checkSignal(signal);
  const key = secretBuffer(secret);
  const sampleLimit = safeLimit(maximumSamples, MAXIMUM_SAMPLES, MAXIMUM_SAMPLES);
  const meterLimit = safeLimit(
    maximumMetersPerSample,
    MAXIMUM_METERS_PER_SAMPLE,
    MAXIMUM_METERS_PER_SAMPLE,
  );
  try {
  let parsed = value;
  if (typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array) {
    try {
      parsed = JSON.parse(Buffer.from(value).toString("utf8"));
    } catch {
      fail("malformed");
    }
  }
  if (!assertPlainObject(parsed) || parsed.version !== 2 || !Array.isArray(parsed.samples)
      || parsed.samples.length > sampleLimit) fail("unsupported_schema");

  const revisions = new Map();
  const observations = [];
  const unknownMeterKeys = new Set();
  for (const [sampleOrdinal, sample] of parsed.samples.entries()) {
    if ((sampleOrdinal & 255) === 0) checkSignal(signal);
    if (!assertPlainObject(sample) || !Number.isSafeInteger(sample.t) || sample.t < 0
        || typeof sample.org !== "string" || sample.org.length === 0
        || Buffer.byteLength(sample.org, "utf8") > 4_096 || !assertPlainObject(sample.u)) {
      fail("invalid_sample");
    }
    const meters = Object.keys(sample.u).sort((left, right) => left.localeCompare(right, "en"));
    if (meters.length < 1 || meters.length > meterLimit) fail("invalid_sample");
    const accountScope = keyed(key, "claude-desktop-account-scope", sample.org);
    for (const [meterOrdinal, rawMeter] of meters.entries()) {
      if (!/^[A-Za-z0-9_-]{1,64}$/u.test(rawMeter)) fail("invalid_meter");
      const utilization = sample.u[rawMeter];
      if (typeof utilization !== "number" || !Number.isFinite(utilization)
          || utilization < 0 || utilization > 100) fail("invalid_utilization");
      const knownMeter = KNOWN_METERS[rawMeter];
      const meterId = knownMeter ?? `unknown_${keyed(key, "claude-desktop-meter", rawMeter)}`;
      if (!knownMeter) unknownMeterKeys.add(meterId);
      const identity = `${accountScope}\0${sample.t}\0${meterId}`;
      const revision = (revisions.get(identity) ?? 0) + 1;
      revisions.set(identity, revision);
      observations.push({
        schemaVersion: CLAUDE_DESKTOP_PLAN_HISTORY_VERSION,
        provider: "anthropic_claude_code",
        authority: CLAUDE_DESKTOP_PLAN_HISTORY_AUTHORITY,
        accountScope,
        observedAtMs: sample.t,
        meterId,
        utilizationPercent: utilization,
        resetsAtMs: null,
        revision,
        sourceOrdinal: sampleOrdinal,
        meterOrdinal,
        observationKey: keyed(
          key,
          "claude-desktop-quota-observation",
          accountScope,
          sample.t,
          meterId,
          revision,
          utilization,
        ),
      });
    }
  }

  return {
    schemaVersion: CLAUDE_DESKTOP_PLAN_HISTORY_VERSION,
    sourceVersion: 2,
    sampleCount: parsed.samples.length,
    observationCount: observations.length,
    accountCount: new Set(observations.map((item) => item.accountScope)).size,
    unknownMeterCount: unknownMeterKeys.size,
    observations,
  };
  } finally {
    key.fill(0);
  }
}

export async function readClaudeDesktopPlanHistory(path, options = {}) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) fail("configuration");
  checkSignal(options.signal);
  const maximumFileBytes = safeLimit(options.maximumFileBytes, MAXIMUM_FILE_BYTES, MAXIMUM_FILE_BYTES);
  let handle;
  try {
    const before = await lstat(path);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || before.size > maximumFileBytes
        || (currentUid !== null && before.uid !== currentUid)
        || (process.platform !== "win32" && (before.mode & 0o022) !== 0)) {
      fail("source_unsafe");
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      fail("source_changed");
    }
    const raw = await handle.readFile({ signal: options.signal ?? undefined });
    checkSignal(options.signal);
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail("source_changed");
    return parseClaudeDesktopPlanHistory(raw, options);
  } catch (error) {
    if (error instanceof ClaudeDesktopPlanHistoryError) throw error;
    if (options.signal?.aborted === true) fail("aborted");
    fail("source_unavailable");
  } finally {
    await handle?.close().catch(() => {});
  }
}
