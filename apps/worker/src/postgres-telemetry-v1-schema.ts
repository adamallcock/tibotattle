import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  type PostgresSchemaOptions,
} from "./postgres-client";

/**
 * Canonical primary-schema names shared by every PostgreSQL v1 adapter.
 *
 * Qualification harnesses use the same canonical table names in an explicitly
 * isolated schema. Production composition resolves to the operational
 * `tibotattle` schema and the D1-compatible table names below.
 */
export interface PostgresTelemetryV1Tables {
  readonly primarySchema: string;
  readonly chunks: string;
  readonly records: string;
  readonly deviceConsents: string;
  readonly admissionWindows: string;
  readonly devices: string;
  readonly authorizations: string;
  readonly pendingObjects: string;
  readonly insertContribution: string;
}

export function resolvePostgresTelemetryV1Tables(
  options: PostgresSchemaOptions = {},
): PostgresTelemetryV1Tables {
  const schema = createPostgresSchemaConfig(options);
  const primary = quotePostgresIdentifier(schema.primarySchema);
  const table = (name: string): string => `${primary}.${quotePostgresIdentifier(name)}`;
  return Object.freeze({
    primarySchema: schema.primarySchema,
    chunks: table("telemetry_v1_chunks"),
    records: table("telemetry_v1_records"),
    deviceConsents: table("telemetry_v1_device_consents"),
    admissionWindows: table("telemetry_v1_chunk_admission_windows"),
    devices: table("device_credentials"),
    authorizations: table("device_upload_authorizations"),
    pendingObjects: table("pending_objects"),
    insertContribution: `${primary}.${quotePostgresIdentifier("insert_telemetry_v1_contribution")}`,
  });
}
