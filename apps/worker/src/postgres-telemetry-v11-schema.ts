import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  type PostgresSchemaOptions,
} from "./postgres-client";

/** Canonical primary-schema names for the provider-neutral v1.1 transport. */
export interface PostgresTelemetryV11Tables {
  readonly primarySchema: string;
  readonly participants: string;
  readonly devices: string;
  readonly uploadAuthorizations: string;
  readonly formats: string;
  readonly participantFloors: string;
  readonly deviceFloors: string;
  readonly admissionWindows: string;
  readonly deviceConsents: string;
  readonly accountlessLedger: string;
  readonly accountlessOwners: string;
  readonly accountlessAuthorizations: string;
  readonly manifests: string;
  readonly chunks: string;
  readonly records: string;
  readonly pendingObjects: string;
}
export function resolvePostgresTelemetryV11Tables(
  options: PostgresSchemaOptions = {},
): PostgresTelemetryV11Tables {
  const schema = createPostgresSchemaConfig(options);
  const primary = quotePostgresIdentifier(schema.primarySchema);
  const table = (name: string): string => `${primary}.${quotePostgresIdentifier(name)}`;
  return Object.freeze({
    primarySchema: schema.primarySchema,
    participants: table("participants"),
    devices: table("device_credentials"),
    uploadAuthorizations: table("device_upload_authorizations"),
    formats: table("telemetry_transport_formats"),
    participantFloors: table("telemetry_transport_participant_floors"),
    deviceFloors: table("telemetry_transport_device_floors"),
    admissionWindows: table("telemetry_v1_chunk_admission_windows"),
    deviceConsents: table("telemetry_v11_device_consents"),
    accountlessLedger: table("accountless_enrollment_ledger"),
    accountlessOwners: table("accountless_upload_owners"),
    accountlessAuthorizations: table("accountless_v11_device_authorizations"),
    manifests: table("telemetry_v11_day_manifests"),
    chunks: table("telemetry_v11_chunks"),
    records: table("telemetry_v11_records"),
    pendingObjects: table("pending_objects"),
  });
}
