import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  type PostgresSchemaOptions,
} from "./postgres-client";

export interface PostgresTelemetryV12Tables {
  readonly participants: string;
  readonly devices: string;
  readonly participantFloors: string;
  readonly deviceFloors: string;
  readonly formats: string;
  readonly runtime: string;
  readonly capabilities: string;
  readonly accountlessLedger: string;
  readonly accountlessOwners: string;
  readonly accountlessAuthorizations: string;
  readonly retainedContributions: string;
  readonly inputVersions: string;
  readonly manifests: string;
  readonly chunks: string;
  readonly records: string;
  readonly predecessors: string;
  readonly domains: string;
  readonly domainDays: string;
  readonly domainHeads: string;
  readonly pendingObjects: string;
  readonly uploadAuthorizations: string;
  readonly admissionWindows: string;
  readonly v1Chunks: string;
  readonly v11Manifests: string;
  readonly v11Chunks: string;
}

export function resolvePostgresTelemetryV12Tables(options: PostgresSchemaOptions = {}): PostgresTelemetryV12Tables {
  const schema = createPostgresSchemaConfig(options);
  const prefix = quotePostgresIdentifier(schema.primarySchema);
  const table = (name: string) => `${prefix}.${quotePostgresIdentifier(name)}`;
  return Object.freeze({
    participants: table("participants"),
    devices: table("device_credentials"),
    participantFloors: table("telemetry_transport_participant_floors"),
    deviceFloors: table("telemetry_transport_device_floors"),
    formats: table("telemetry_transport_formats"),
    runtime: table("telemetry_v12_runtime"),
    capabilities: table("telemetry_v12_device_capabilities"),
    accountlessLedger: table("accountless_enrollment_ledger"),
    accountlessOwners: table("accountless_upload_owners"),
    accountlessAuthorizations: table("accountless_v12_device_authorizations"),
    retainedContributions: table("telemetry_contributions"),
    inputVersions: table("input_versions"),
    manifests: table("telemetry_v12_day_manifests"),
    chunks: table("telemetry_v12_chunks"),
    records: table("telemetry_v12_records"),
    predecessors: table("telemetry_v12_domain_predecessors"),
    domains: table("telemetry_v12_domains"),
    domainDays: table("telemetry_v12_domain_days"),
    domainHeads: table("telemetry_v12_domain_heads"),
    pendingObjects: table("pending_objects"),
    uploadAuthorizations: table("device_upload_authorizations"),
    admissionWindows: table("telemetry_v1_chunk_admission_windows"),
    v1Chunks: table("telemetry_v1_chunks"),
    v11Manifests: table("telemetry_v11_day_manifests"),
    v11Chunks: table("telemetry_v11_chunks"),
  });
}
