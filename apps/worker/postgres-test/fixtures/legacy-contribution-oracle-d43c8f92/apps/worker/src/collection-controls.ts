import { ApiError } from "./errors";
import type { ErrorCode } from "./errors";

export const COLLECTION_CONTROLS_SCHEMA_VERSION =
  "collection-controls-v0.1";

export type CollectionControlName =
  | "enrollment"
  | "uploadRegistration"
  | "processing"
  | "publication";

export interface CollectionControls {
  schemaVersion: typeof COLLECTION_CONTROLS_SCHEMA_VERSION;
  state: "operational" | "degraded" | "contained";
  revision: number;
  enrollment: boolean;
  uploadRegistration: boolean;
  processing: boolean;
  publication: boolean;
}

interface CollectionControlRow {
  schema_version: string;
  enrollment_enabled: number;
  upload_registration_enabled: number;
  processing_enabled: number;
  publication_enabled: number;
  control_state: string;
  revision: number;
}

function validFlag(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function fail(): never {
  throw new ApiError(503, "COLLECTION_CONTROL_UNAVAILABLE");
}

export async function readCollectionControls(
  database: D1Database | undefined,
): Promise<CollectionControls> {
  if (!database || typeof database.prepare !== "function") fail();
  let row: CollectionControlRow | null;
  try {
    row = await database.prepare(`
      SELECT schema_version,
             enrollment_enabled,
             upload_registration_enabled,
             processing_enabled,
             publication_enabled,
             control_state,
             revision
        FROM collection_controls
       WHERE singleton = 1
    `).first<CollectionControlRow>();
  } catch {
    fail();
  }
  if (!row
      || row.schema_version !== COLLECTION_CONTROLS_SCHEMA_VERSION
      || !validFlag(row.enrollment_enabled)
      || !validFlag(row.upload_registration_enabled)
      || !validFlag(row.processing_enabled)
      || !validFlag(row.publication_enabled)
      || !["operational", "degraded", "contained"].includes(row.control_state)
      || !Number.isSafeInteger(row.revision)
      || row.revision < 1) {
    fail();
  }
  const controls = {
    schemaVersion: COLLECTION_CONTROLS_SCHEMA_VERSION,
    state: row.control_state as CollectionControls["state"],
    revision: row.revision,
    enrollment: row.enrollment_enabled === 1,
    uploadRegistration: row.upload_registration_enabled === 1,
    processing: row.processing_enabled === 1,
    publication: row.publication_enabled === 1,
  } satisfies CollectionControls;
  const enabledCount = [
    controls.enrollment,
    controls.uploadRegistration,
    controls.processing,
    controls.publication,
  ].filter(Boolean).length;
  if ((controls.state === "operational" && enabledCount !== 4)
      || (controls.state === "contained" && enabledCount !== 0)
      || (controls.state === "degraded"
        && (enabledCount === 0 || enabledCount === 4))) {
    fail();
  }
  return Object.freeze(controls);
}

const DISABLED_CODES: Record<CollectionControlName, ErrorCode> = {
  enrollment: "COLLECTION_ENROLLMENT_DISABLED",
  uploadRegistration: "UPLOAD_REGISTRATION_DISABLED",
  processing: "PROCESSING_DISABLED",
  publication: "PUBLICATION_DISABLED",
};

export async function assertCollectionControl(
  database: D1Database,
  name: CollectionControlName,
): Promise<CollectionControls> {
  const controls = await readCollectionControls(database);
  if (!controls[name]) {
    throw new ApiError(503, DISABLED_CODES[name]);
  }
  return controls;
}
