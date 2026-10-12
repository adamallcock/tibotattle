import {
  canonicalTelemetryV11Json, telemetryV11RecordAnchor,
  type TelemetryV11Record, type TelemetryV11Stream,
} from "@app-usagemonitor/telemetry-contract";

/** Server-derived compatibility evidence, never accepted from a client field.
 * Keep this codec independent of storage/admission so both retained layouts
 * produce the same canonical bytes without an import cycle. */
export function telemetryV11LegacyProjection(stream: TelemetryV11Stream, record: TelemetryV11Record): {
  occurrenceId: string; canonicalRecord: string;
} | null {
  const copy = { ...record } as Record<string, unknown>;
  delete copy.accountPlanAttribution;
  copy.schemaVersion = stream === "usage" ? "usage-event-v1.0"
    : stream === "quota" ? "quota-observation-v1.0" : "session-dimension-v1.0";
  const anchor = telemetryV11RecordAnchor(stream, record);
  const occurrenceId = stream === "quota"
    ? `q:${Date.parse(anchor.observedAt)}:${copy.limitId}:${copy.slot}` : anchor.occurrenceId;
  if (stream === "quota" && (copy.usedPercent === null || copy.windowDurationMinutes === null
      || copy.resetsAt === null || occurrenceId.length > 128)) return null;
  if (stream === "quota") copy.observationId = occurrenceId;
  return { occurrenceId, canonicalRecord: canonicalTelemetryV11Json(copy) };
}
