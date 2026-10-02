/**
 * Community allowance breakdowns v1.3 (KM-7, owner decision round 7 and the
 * round-9 contract names): the d43c8f92 meaning of v1.1 plus one closed model
 * metadata block, served by GCP from cutover.
 *
 * GCP-owned and post-projection. The breakdown values are exactly what the
 * VENDORED d43c8f92 projectPublicAllowanceGraph returns (v1.1); this module
 * only relabels the schema version and appends `modelConfig`. It never
 * recomputes, reorders or filters a value, so a v1.3 payload reduces to the
 * v1.1 bytes by exactly two edits (reducePublicAllowanceBreakdownsV13): the
 * schemaVersion string, and the trailing `modelConfig` member. That is the
 * DECLARED parity difference; every other byte is the oracle's.
 *
 * The block (`modelConfig`) is the closed shape the tolerant public reader
 * accepts (apps/web/public/community-data.js on claude/gcp-fp-w-web,
 * publicModelMetadata): an array of exactly `{ id, label, family, order }`,
 * at most 128 entries, each id once. Its content comes from the catalog
 * baseline (manifest_version 1):
 *
 * - the public roster is every manifest model with provider `openai_codex`,
 *   allowanceTrack `primary` and hidden `false`, in manifest order. The reader
 *   refuses a block naming a separate-track or other-provider model, and a
 *   hidden model is never named;
 * - id and label are the manifest's, unchanged;
 * - family and order are presentation, which manifest version 1 does not
 *   carry. They come from a frozen table pinned to that version
 *   (PUBLIC_MODEL_PRESENTATION_BY_MANIFEST_VERSION): the seven models the
 *   d43c8f92 public page pins (apps/web/public/model-visuals.js
 *   MODEL_PRESENTATION_ORDER and its themes) keep their order 0..6 and family,
 *   and every other roster model is family `generic` with order
 *   7 + its roster index, which is the page's own fallback. A page reading the
 *   block therefore draws today's models in today's order and colours; what
 *   the block adds is a name and an order for a model the page's own catalog
 *   has never seen.
 *
 * Unknown names (owner decision round 5). Only manifest roster models are ever
 * named. A tuple whose id the manifest does not name gets no metadata entry,
 * so the reader skips it and states the gap; it is not removed here, because
 * that would change bytes the oracle serves. At d43c8f92 such a tuple cannot
 * occur: the vendored preview validation admits only reviewed catalog ids.
 *
 * Errors are content-free closed codes. This file has no imports and only
 * erasable TypeScript syntax, so parity scripts load it under plain Node type
 * stripping and the Worker and Cloud Run bundles take it unchanged.
 */

export const PUBLIC_ALLOWANCE_BREAKDOWNS_V13_SCHEMA_VERSION = "community-allowance-breakdowns-v1.3" as const;
/** The d43c8f92 projection's version, the only input this wrapper accepts. */
export const PUBLIC_ALLOWANCE_BREAKDOWNS_V13_BASE_SCHEMA_VERSION = "community-allowance-breakdowns-v1.1" as const;
/** The member name the tolerant reader reads the block from. */
export const PUBLIC_MODEL_METADATA_MEMBER = "modelConfig" as const;
export const PUBLIC_MODEL_METADATA_ENTRY_KEYS: readonly string[] = Object.freeze(["id", "label", "family", "order"]);
/** The v1.1 envelope, in the vendored projection's key order. */
export const PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS: readonly string[] = Object.freeze([
  "schemaVersion", "basis", "referencePlanType", "normalization", "modelBasis", "modelGate", "generatedAt", "days",
]);
/** The reader's bounds (community-data.js PUBLIC_MODEL_*), not looser. */
export const PUBLIC_MODEL_METADATA_MAX_ENTRIES = 128;
export const PUBLIC_MODEL_METADATA_ORDER_MAX = 9999;
/** The reader's id grammar intersected with the catalog token guard (catalog-token-guard-v1). */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .+_()×·/:-]{0,79}$/u;
const FAMILY_PATTERN = /^[a-z][a-z0-9-]{0,23}$/u;

export const PUBLIC_MODEL_METADATA_ERROR_CODES = Object.freeze([
  "PUBLIC_MODEL_METADATA_MANIFEST_UNSUPPORTED",
  "PUBLIC_MODEL_METADATA_CATALOG_INVALID",
  "PUBLIC_ALLOWANCE_BREAKDOWNS_BASE_INVALID",
  "PUBLIC_ALLOWANCE_BREAKDOWNS_V13_INVALID",
] as const);
export type PublicModelMetadataErrorCode = (typeof PUBLIC_MODEL_METADATA_ERROR_CODES)[number];

export class PublicModelMetadataError extends Error {
  readonly code: PublicModelMetadataErrorCode;
  constructor(code: PublicModelMetadataErrorCode) {
    super(code);
    this.name = "PublicModelMetadataError";
    this.code = code;
  }
}

function fail(code: PublicModelMetadataErrorCode): never {
  throw new PublicModelMetadataError(code);
}

/** The manifest model fields this module reads (catalog-manifest.ts CatalogModel). */
export interface PublicCatalogModel {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly allowanceTrack: string;
  readonly hidden: boolean;
}

export interface PublicModelMetadataEntry {
  readonly id: string;
  readonly label: string;
  readonly family: string;
  readonly order: number;
}

export interface PublicModelPresentation {
  /** Models in display order 0..n-1, each with its family. */
  readonly pinned: readonly (readonly [id: string, family: string])[];
  /** Family of every roster model not pinned: outside the reader's themed set. */
  readonly unpinnedFamily: string;
}

/**
 * Presentation per manifest version. Version 1 reproduces the d43c8f92 public
 * page (apps/web/public/model-visuals.js MODEL_PRESENTATION_ORDER and
 * MODEL_PRESENTATION_THEMES). A later manifest that binds metadata must add
 * its own entry here or carry presentation itself; an absent version fails
 * closed rather than borrowing another version's order.
 */
export const PUBLIC_MODEL_PRESENTATION_BY_MANIFEST_VERSION: Readonly<Record<number, PublicModelPresentation>> =
  Object.freeze({
    1: Object.freeze({
      pinned: Object.freeze([
        Object.freeze(["gpt-6-astra", "astra"] as const),
        Object.freeze(["gpt-6-sol", "sol"] as const),
        Object.freeze(["gpt-5.6-sol", "sol"] as const),
        Object.freeze(["gpt-5.6-terra", "terra"] as const),
        Object.freeze(["gpt-6-luna", "luna"] as const),
        Object.freeze(["gpt-5.6-luna", "luna"] as const),
        Object.freeze(["gpt-5.5", "classic"] as const),
      ]),
      unpinnedFamily: "generic",
    }),
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeysInOrder(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

/** The models a public page may name: openai_codex, primary track, not hidden, in manifest order. */
export function publicCatalogRoster(models: readonly PublicCatalogModel[]): PublicCatalogModel[] {
  if (!Array.isArray(models)) fail("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
  return models.filter((model) => isRecord(model) && model.provider === "openai_codex"
    && model.allowanceTrack === "primary" && model.hidden === false);
}

/**
 * The closed metadata block for one manifest: its public roster with the
 * version's presentation. Throws when the version has no presentation, or the
 * roster breaks the reader's grammars, bounds or uniqueness, or a pinned model
 * is missing from it; a reviewed catalog that cannot be published is refused,
 * never published partly.
 */
export function buildPublicModelMetadata(manifest: {
  readonly version: number;
  readonly models: readonly PublicCatalogModel[];
}): readonly PublicModelMetadataEntry[] {
  if (!isRecord(manifest) || !Number.isSafeInteger(manifest.version)
      || !Object.hasOwn(PUBLIC_MODEL_PRESENTATION_BY_MANIFEST_VERSION, manifest.version)) {
    fail("PUBLIC_MODEL_METADATA_MANIFEST_UNSUPPORTED");
  }
  const presentation = PUBLIC_MODEL_PRESENTATION_BY_MANIFEST_VERSION[manifest.version]!;
  const roster = publicCatalogRoster(manifest.models);
  const pinnedOrder = new Map(presentation.pinned.map(([id, family], index) => [id, { family, order: index }]));
  const ids = new Set<string>();
  const entries = roster.map((model, index): PublicModelMetadataEntry => {
    const pinned = pinnedOrder.get(model.id);
    const entry = {
      id: model.id,
      label: model.label,
      family: pinned?.family ?? presentation.unpinnedFamily,
      order: pinned?.order ?? presentation.pinned.length + index,
    };
    if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id) || ids.has(entry.id)
        || typeof entry.label !== "string" || !LABEL_PATTERN.test(entry.label)
        || !FAMILY_PATTERN.test(entry.family)
        || !Number.isSafeInteger(entry.order) || entry.order < 0 || entry.order > PUBLIC_MODEL_METADATA_ORDER_MAX) {
      fail("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
    }
    ids.add(entry.id);
    return Object.freeze(entry);
  });
  if (entries.length > PUBLIC_MODEL_METADATA_MAX_ENTRIES
      || presentation.pinned.some(([id]) => !ids.has(id))
      || new Set(entries.map((entry) => entry.order)).size !== entries.length) {
    fail("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
  }
  return Object.freeze(entries);
}

/** A structurally valid metadata block: the closed entry shape, grammars, bounds and unique ids and orders. */
export function isPublicModelMetadataBlock(value: unknown): value is readonly PublicModelMetadataEntry[] {
  if (!Array.isArray(value) || value.length > PUBLIC_MODEL_METADATA_MAX_ENTRIES) return false;
  const ids = new Set<unknown>();
  const orders = new Set<unknown>();
  for (const entry of value) {
    if (!isRecord(entry) || !exactKeysInOrder(entry, PUBLIC_MODEL_METADATA_ENTRY_KEYS)
        || typeof entry.id !== "string" || !ID_PATTERN.test(entry.id) || ids.has(entry.id)
        || typeof entry.label !== "string" || !LABEL_PATTERN.test(entry.label)
        || typeof entry.family !== "string" || !FAMILY_PATTERN.test(entry.family)
        || !Number.isSafeInteger(entry.order) || (entry.order as number) < 0
        || (entry.order as number) > PUBLIC_MODEL_METADATA_ORDER_MAX || orders.has(entry.order)) return false;
    ids.add(entry.id);
    orders.add(entry.order);
  }
  return true;
}

/**
 * v1.1 in, v1.3 out: the same object with the schema version relabelled in
 * place and `modelConfig` appended as the last member. The input must be the
 * vendored projection's exact v1.1 envelope; anything else is refused rather
 * than relabelled, so a changed projection can never be served as v1.3.
 */
export function wrapPublicAllowanceBreakdownsV13<T extends object>(
  breakdowns: T,
  metadata: readonly PublicModelMetadataEntry[],
): Omit<T, "schemaVersion"> & {
  readonly schemaVersion: typeof PUBLIC_ALLOWANCE_BREAKDOWNS_V13_SCHEMA_VERSION;
  readonly modelConfig: readonly PublicModelMetadataEntry[];
} {
  if (!isRecord(breakdowns) || !exactKeysInOrder(breakdowns, PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS)
      || breakdowns.schemaVersion !== PUBLIC_ALLOWANCE_BREAKDOWNS_V13_BASE_SCHEMA_VERSION) {
    fail("PUBLIC_ALLOWANCE_BREAKDOWNS_BASE_INVALID");
  }
  if (!isPublicModelMetadataBlock(metadata)) fail("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
  return {
    ...breakdowns,
    schemaVersion: PUBLIC_ALLOWANCE_BREAKDOWNS_V13_SCHEMA_VERSION,
    modelConfig: metadata,
  } as never;
}

/**
 * The declared difference, undone: a v1.3 block whose envelope is exactly the
 * v1.1 envelope plus a trailing `modelConfig`, returned as `{ base, metadata }`
 * where `base` is the v1.1 block (schemaVersion restored, modelConfig removed,
 * every other member untouched and in order). Throws
 * PUBLIC_ALLOWANCE_BREAKDOWNS_V13_INVALID for anything else, including a block
 * that is not structurally valid. Whether `metadata` is the EXPECTED block is
 * the caller's question.
 */
export function reducePublicAllowanceBreakdownsV13(value: unknown): {
  base: Record<string, unknown>;
  metadata: readonly PublicModelMetadataEntry[];
} {
  if (!isRecord(value)
      || !exactKeysInOrder(value, [...PUBLIC_ALLOWANCE_BREAKDOWNS_V11_KEYS, PUBLIC_MODEL_METADATA_MEMBER])
      || value.schemaVersion !== PUBLIC_ALLOWANCE_BREAKDOWNS_V13_SCHEMA_VERSION
      || !isPublicModelMetadataBlock(value.modelConfig)) {
    fail("PUBLIC_ALLOWANCE_BREAKDOWNS_V13_INVALID");
  }
  const { modelConfig, ...rest } = value;
  return {
    base: { ...rest, schemaVersion: PUBLIC_ALLOWANCE_BREAKDOWNS_V13_BASE_SCHEMA_VERSION },
    metadata: modelConfig as readonly PublicModelMetadataEntry[],
  };
}
