import { encodeTypedTelemetryId, TypedTelemetryError, decodeTypedTelemetryId } from "./typed-telemetry-codec";

export const TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST =
  "50a6e8e2aa5325fab5e5efee7bd90c0464342ec3b1fa064f304c966f9b1ae643";
export const MAX_TYPED_TELEMETRY_OWNER_ORIGINS = 8;
export type TypedTelemetryOriginFormat = "v1" | "v11";
export interface TypedTelemetryOwnerOrigin {
  namespaceId: number;
  sourceNamespace: string;
  typedOwnerId: number;
  accessMode: "current-write" | "retained-read";
}

const binary = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer;
const conflict = () => new TypedTelemetryError("TYPED_TELEMETRY_CONFLICT");

export function typedTelemetryOriginQualificationStatements(
  db: D1Database,
  sourceNamespace: string,
  format: TypedTelemetryOriginFormat,
): D1PreparedStatement[] {
  const original = binary(encodeTypedTelemetryId(sourceNamespace));
  const versionColumn = format === "v1" ? "v1_read_contract_version" : "v11_read_contract_version";
  return [
    db.prepare(`INSERT INTO typed_telemetry_origin_contracts(
      namespace_id,namespace_original,access_mode,v1_read_contract_version,v11_read_contract_version,
      source_schema_digest,registered_move_id,registered_at)
      SELECT id,?,'current-write',0,0,?,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM typed_telemetry_namespaces WHERE original_id=?
      ON CONFLICT(namespace_id) DO NOTHING`).bind(original, TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST, original),
    db.prepare(`UPDATE typed_telemetry_origin_contracts SET ${versionColumn}=2
      WHERE namespace_id=(SELECT id FROM typed_telemetry_namespaces WHERE original_id=?)
        AND namespace_original=? AND source_namespace=? AND access_mode='current-write'
        AND source_schema_digest=? AND registered_move_id IS NULL AND ${versionColumn}=0`)
      .bind(original, original, sourceNamespace, TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST),
  ];
}

export async function assertCurrentTypedTelemetryOrigin(
  db: D1Database,
  sourceNamespace: string,
  format: TypedTelemetryOriginFormat,
): Promise<void> {
  const versionColumn = format === "v1" ? "v1_read_contract_version" : "v11_read_contract_version";
  const original = binary(encodeTypedTelemetryId(sourceNamespace));
  const row = await db.prepare(`SELECT 1 AS ready FROM typed_telemetry_origin_contracts
    WHERE namespace_original=? AND source_namespace=? AND access_mode='current-write'
      AND source_schema_digest=? AND registered_move_id IS NULL AND ${versionColumn}=2`)
    .bind(original, sourceNamespace, TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST).first();
  if (!row) throw conflict();
}

/** Install one already verified historical namespace on a move destination.
 * The current-write origin is unchanged. The move id is retained as provenance
 * and exact retries converge; conflicting reuse is rejected by schema guards. */
export function retainedTypedTelemetryOriginStatements(
  db: D1Database,
  sourceNamespace: string,
  moveId: string,
  registeredAt: string,
): D1PreparedStatement[] {
  const original = binary(encodeTypedTelemetryId(sourceNamespace));
  return [
    db.prepare(`INSERT INTO typed_telemetry_origin_contracts(
      namespace_id,namespace_original,access_mode,v1_read_contract_version,v11_read_contract_version,
      source_schema_digest,registered_move_id,registered_at)
      SELECT id,?,'retained-read',0,2,?,?,? FROM typed_telemetry_namespaces WHERE original_id=?
      ON CONFLICT(namespace_id) DO NOTHING`)
      .bind(original, TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST, moveId, registeredAt, original),
  ];
}

interface OriginRow {
  namespace_id: number;
  namespace_original: ArrayBuffer;
  source_namespace: string;
  typed_owner_id: number;
  access_mode: "current-write" | "retained-read";
  read_version: number;
  source_schema_digest: string;
}

/** Bounded physical-database lookup for an already authenticated owner. Every
 * membership must have an exact qualified origin; partial results are refused.
 * This is a read seam for future copy/erasure callers, not movement authority. */
export async function readQualifiedTypedTelemetryOwnerOrigins(
  db: D1Database,
  participantId: string,
  format: TypedTelemetryOriginFormat,
): Promise<TypedTelemetryOwnerOrigin[]> {
  encodeTypedTelemetryId(participantId);
  const table = format === "v1" ? "typed_v1_owner_memberships" : "typed_v11_owner_memberships";
  const versionColumn = format === "v1" ? "v1_read_contract_version" : "v11_read_contract_version";
  const rows = (await db.prepare(`SELECT m.namespace_id,m.typed_owner_id,c.namespace_original,
      c.source_namespace,c.access_mode,c.${versionColumn} read_version,c.source_schema_digest
    FROM ${table} m
    JOIN typed_telemetry_owners owner ON owner.id=m.typed_owner_id AND owner.namespace_id=m.namespace_id
    LEFT JOIN typed_telemetry_origin_contracts c ON c.namespace_id=m.namespace_id
    WHERE m.participant_id=? ORDER BY c.source_namespace,m.namespace_id
    LIMIT ?`).bind(participantId, MAX_TYPED_TELEMETRY_OWNER_ORIGINS + 1).all<OriginRow>()).results;
  if (rows.length > MAX_TYPED_TELEMETRY_OWNER_ORIGINS) throw conflict();
  return rows.map((row) => {
    const original = new Uint8Array(row.namespace_original);
    if (row.read_version !== 2 || row.source_schema_digest !== TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST
        || (row.access_mode !== "current-write" && row.access_mode !== "retained-read")
        || decodeTypedTelemetryId(original) !== row.source_namespace) throw conflict();
    return { namespaceId: row.namespace_id, sourceNamespace: row.source_namespace,
      typedOwnerId: row.typed_owner_id, accessMode: row.access_mode };
  });
}
