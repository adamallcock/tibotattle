import { canonicalTelemetryV11Json, type TelemetryV11Chunk } from "@app-usagemonitor/telemetry-contract";
import { ApiError } from "./errors";
import { sha256Hex } from "./crypto";
import { encodeTypedTelemetryId } from "./typed-telemetry-codec";
import { readTypedTelemetryRowsByStorageIds } from "./typed-telemetry-compatibility";
import { persistTypedV11StagedChunk, type TypedV11ChunkMetadata } from "./typed-v11-admission";
import { existingTelemetryV11StagedChunk, persistTelemetryV11StagedChunk,
  type TelemetryV11StagedChunkRow } from "./telemetry-v11-repository";
import { insertTelemetryV1Chunk, type TelemetryV1ChunkInsert, type TelemetryV1ChunkRow } from "./telemetry-v1-repository";
import { insertTypedTelemetryV1Chunk, validateTypedTelemetryV1Receipt } from "./typed-v1-admission";
import type { TelemetryTransportPrincipal } from "./telemetry-transport-policy";
import type { OwnerStorageRoute } from "./storage-routing";
import { TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST } from "./typed-telemetry-origins";

export type TelemetryStorageMode = Readonly<{ kind: "json" } | { kind: "typed"; sourceNamespace: string }>;
interface StorageModeSettings {
  TELEMETRY_STORAGE_MODE?: unknown; TELEMETRY_STORAGE_NAMESPACE?: unknown;
  STORAGE_SOURCE_NAMESPACE_A?: unknown; STORAGE_SOURCE_NAMESPACE_B?: unknown;
  STORAGE_SOURCE_NAMESPACE_C?: unknown;
}
const unavailable = () => new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");

/** Deployment selection, never automatic schema detection or a fallback. */
export function parseTelemetryStorageMode(settings: StorageModeSettings): TelemetryStorageMode {
  if (settings.TELEMETRY_STORAGE_MODE === undefined || settings.TELEMETRY_STORAGE_MODE === "json") return { kind: "json" };
  if (settings.TELEMETRY_STORAGE_MODE !== "typed" || typeof settings.TELEMETRY_STORAGE_NAMESPACE !== "string") throw unavailable();
  const sourceNamespace = settings.TELEMETRY_STORAGE_NAMESPACE;
  try { encodeTypedTelemetryId(sourceNamespace); } catch { throw unavailable(); }
  return { kind: "typed", sourceNamespace };
}

/** Catalog bindings have independent immutable provenance namespaces. The
 * route selects an explicit configured namespace; shard schema cannot infer or
 * relabel it. Single-database mode retains the original global setting. */
export function telemetryStorageSettingsForRoute(
  settings: StorageModeSettings, route: OwnerStorageRoute,
): StorageModeSettings {
  if (route.mode === "single") return settings;
  const key = route.bindingName === "STORAGE_INGESTION_A" ? "STORAGE_SOURCE_NAMESPACE_A"
    : route.bindingName === "STORAGE_INGESTION_B" ? "STORAGE_SOURCE_NAMESPACE_B"
      : route.bindingName === "STORAGE_INGESTION_C" ? "STORAGE_SOURCE_NAMESPACE_C" : null;
  const namespace = key === null ? undefined : settings[key];
  if (settings.TELEMETRY_STORAGE_MODE !== "typed"
      || typeof namespace !== "string" || namespace.length === 0) throw unavailable();
  return { TELEMETRY_STORAGE_MODE: "typed", TELEMETRY_STORAGE_NAMESPACE: namespace };
}

/** Initialization checks the complete local migration contract transactionally;
 * the trusted deployment owner additionally verifies exact schema SQL hashes.
 * Requests read the immutable version/namespace pin, not every schema object.
 */
export async function resolveTelemetryStorageMode(db: D1Database, settings: StorageModeSettings,
  format: "v1" | "v11" = "v11"): Promise<TelemetryStorageMode> {
  const mode = parseTelemetryStorageMode(settings);
  if (mode.kind === "json") return mode;
  const stateTable = format === "v1" ? "typed_v1_admission_state" : "typed_v11_admission_state";
  try {
    const ready = await db.prepare(`SELECT 1 AS ready FROM ${stateTable} s
      JOIN typed_telemetry_namespaces n ON n.id=s.namespace_id
      JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=s.namespace_id
        AND origin.namespace_original=n.original_id AND origin.source_namespace=s.source_namespace
        AND origin.access_mode='current-write' AND origin.registered_move_id IS NULL
        AND origin.source_schema_digest=?
        AND origin.${format === "v1" ? "v1_read_contract_version" : "v11_read_contract_version"}=2
      JOIN typed_telemetry_schema v ON v.id=1 AND v.version=1
      WHERE s.id=1 AND s.source_namespace=? AND n.original_id=? AND s.runtime_contract_version=1`)
      .bind(TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST, mode.sourceNamespace,
        Uint8Array.from(encodeTypedTelemetryId(mode.sourceNamespace)).buffer).first();
    if (!ready) throw unavailable();
  } catch { throw unavailable(); }
  return mode;
}

/** A replay receipt proves complete retained records, not merely a header. */
export async function readTelemetryV11StorageReplay(db: D1Database, mode: TelemetryStorageMode,
  principal: TelemetryTransportPrincipal, chunk: TelemetryV11Chunk): Promise<TelemetryV11StagedChunkRow | null> {
  const prior = await existingTelemetryV11StagedChunk(db, principal, chunk);
  if (!prior) return null;
  if (prior.chunk_digest !== chunk.chunkDigest || prior.record_count !== chunk.records.length) {
    throw new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT");
  }
  if (mode.kind === "json") return prior;
  try {
    const proofs = (await db.prepare(`SELECT p.typed_record_id,p.stream,p.occurrence_id,r.source_row_id
      FROM typed_v11_record_admissions p JOIN typed_telemetry_records r ON r.id=p.typed_record_id
      WHERE p.chunk_id=? AND p.manifest_id=? ORDER BY r.source_row_id LIMIT 201`)
      .bind(prior.id, prior.manifest_id).all<{ typed_record_id: number; stream: string; occurrence_id: string; source_row_id: number }>()).results;
    if (proofs.length !== prior.record_count || proofs.length > 200) throw unavailable();
    const records = await readTypedTelemetryRowsByStorageIds(db, { sourceNamespace: mode.sourceNamespace,
      participantId: principal.participantId, storageRowIds: proofs.map(row => row.typed_record_id) });
    if (records.some((row, index) => row.format !== "v11" || row.device_id !== principal.deviceId || row.chunk_row_id !== prior.id
        || row.manifest_id !== prior.manifest_id || row.stream !== proofs[index]!.stream
        || row.occurrence_id !== proofs[index]!.occurrence_id || row.source_row_id !== proofs[index]!.source_row_id)
        || await sha256Hex(canonicalTelemetryV11Json(records.map(row => row.record))) !== chunk.chunkDigest) throw unavailable();
  } catch { throw unavailable(); }
  return prior;
}

export async function persistTelemetryV11StorageChunk(db: D1Database, mode: TelemetryStorageMode,
  principal: TelemetryTransportPrincipal, chunk: TelemetryV11Chunk,
  metadata: Omit<TypedV11ChunkMetadata, "sourceNamespace">, ownerRoute?: OwnerStorageRoute) {
  if (ownerRoute?.mode === "catalog" && mode.kind !== "typed") throw unavailable();
  return mode.kind === "typed"
    ? persistTypedV11StagedChunk(db, principal, chunk, { ...metadata, sourceNamespace: mode.sourceNamespace }, Date.now(), ownerRoute)
    : persistTelemetryV11StagedChunk(db, principal, chunk, metadata);
}

/** Header-only replay is insufficient once canonical rows live in typed storage.
 * The v1 owner also validates superseded receipts against their exact newer
 * same-slot journal event, without pretending the retired rows remain current.
 */
export async function readTelemetryV1StorageReceipt(db: D1Database, mode: TelemetryStorageMode,
  row: TelemetryV1ChunkRow, deviceId: string): Promise<TelemetryV1ChunkRow> {
  if (mode.kind === "json") return row;
  try {
    const verified = await validateTypedTelemetryV1Receipt(db, { sourceNamespace: mode.sourceNamespace,
      participantId: row.participant_id, deviceId, chunkRowId: row.id });
    if (!verified) throw unavailable();
    return verified;
  } catch { throw unavailable(); }
}

export async function persistTelemetryV1StorageChunk(db: D1Database, mode: TelemetryStorageMode,
  insert: TelemetryV1ChunkInsert & { authorizationEnvelopeDigest: string },
  ownerRoute?: OwnerStorageRoute): Promise<{ acceptedRecords: number; replay: boolean }> {
  if (ownerRoute?.mode === "catalog" && mode.kind !== "typed") throw unavailable();
  if (mode.kind === "typed") {
    try { return await insertTypedTelemetryV1Chunk(db, insert, mode.sourceNamespace, ownerRoute); }
    catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  }
  return { ...await insertTelemetryV1Chunk(db, insert), replay: false };
}
