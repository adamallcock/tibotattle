import {
  canonicalTelemetryV11Json, parseTelemetryV11Record,
  type TelemetryV11Stream, type TelemetryV12Record,
} from "@app-usagemonitor/telemetry-contract";

/** The existing d43 v1.2 analytical projection, shared by PostgreSQL readers
 * and classification proofs. This projects evidence; it grants no authority. */
export function telemetryV12AnalyticalProjection(stream: TelemetryV11Stream, value: TelemetryV12Record): string {
  const projected: Record<string, unknown> = { ...(value as unknown as Record<string, unknown>),
    schemaVersion: stream === "usage" ? "usage-event-v1.1"
      : stream === "quota" ? "quota-observation-v1.1" : "session-dimension-v1.1" };
  if (stream === "usage") {
    delete projected.boundaryFlags;
    delete projected.tieOrder;
    delete projected.cacheWriteTtl;
  }
  return canonicalTelemetryV11Json(parseTelemetryV11Record(stream, projected));
}
