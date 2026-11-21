import { createHash } from "node:crypto";
import {
  initialTelemetryPerformanceSyncState,
  parseTelemetryPerformanceSyncState,
} from "../../src/application/index.js";
import { readJsonIfExists, writeJsonOwnerOnlyAtomic } from "../../src/storage.js";

const MISSING = Symbol("missing");
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export function createLocalTelemetryPerformanceState({ path, legacyPath, origin }) {
  const scopeForDevice = deviceId => typeof origin === "string"
    && typeof deviceId === "string" && DEVICE_ID.test(deviceId)
    ? createHash("sha256").update("tibotattle/performance-state/v2\0")
      .update(origin).update("\0").update(deviceId).digest("hex")
    : null;

  return Object.freeze({
    async read(deviceId) {
      const scope = scopeForDevice(deviceId);
      if (scope === null) return initialTelemetryPerformanceSyncState();
      const value = await readJsonIfExists(path, MISSING);
      if (value === MISSING) {
        const previous = legacyPath === null ? null : await readJsonIfExists(legacyPath, null);
        if (previous !== null && previous?.schemaVersion !== "telemetry-performance-sync-state-v1") {
          throw new Error("telemetry_performance_state_invalid");
        }
        return parseTelemetryPerformanceSyncState(previous);
      }
      if (!value || typeof value !== "object" || Array.isArray(value)
          || Object.keys(value).length !== 2 || typeof value.scope !== "string"
          || !DIGEST.test(value.scope)
          || value.state?.schemaVersion !== "telemetry-performance-sync-state-v2") {
        throw new Error("telemetry_performance_state_invalid");
      }
      const state = parseTelemetryPerformanceSyncState(value.state);
      return value.scope === scope ? state : initialTelemetryPerformanceSyncState();
    },
    async save(state, deviceId) {
      const scope = scopeForDevice(deviceId);
      if (scope === null) return;
      await writeJsonOwnerOnlyAtomic(path, { scope, state: parseTelemetryPerformanceSyncState(state) });
    },
  });
}
