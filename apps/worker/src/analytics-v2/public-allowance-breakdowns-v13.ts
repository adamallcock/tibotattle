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
 * accepts (apps/web/public/community-data.js publicModelMetadata, on both
 * claude/gcp-fp-w-web and claude/gcp-fp-w-web-onmain): an array of exactly
 * `{ id, label, family, order }`, at most 128 entries, each id once. That
 * reader CHARTS every model a valid block names, including one its own hide
 * list keeps off the page, so the block names only models the public page is
 * meant to chart. Its content comes from the catalog baseline
 * (manifest_version 1) and a frozen per-version presentation table
 * (PUBLIC_MODEL_PRESENTATION_BY_MANIFEST_VERSION), because manifest version 1
 * carries no display section:
 *
 * - the public roster is every manifest model with provider `openai_codex`,
 *   allowanceTrack `primary` and hidden `false`, in manifest order, minus the
 *   version's `publicHidden` list. The reader refuses a block naming a
 *   separate-track or other-provider model, and neither a manifest-hidden nor
 *   a publicly hidden model is ever named;
 * - for version 1, `publicHidden` is the owner's selected public comparison
 *   ("six requested public allowance models", 2026-09-28: 6c3b683c on the
 *   d43c8f92 line, 2d6cfbc8 on main). It is the 35 older primary models the
 *   d43c8f92 page does not chart, which the shippable website branch
 *   (claude/gcp-fp-w-web-onmain) freezes as PUBLIC_ALLOWANCE_HIDDEN_IDS. What
 *   remains is exactly the d43c8f92 page's six charted models
 *   (community-data.js PUBLIC_ALLOWANCE_MODEL_CONFIG). GPT-5.5 is not among
 *   them;
 * - id and label are the manifest's, unchanged (for version 1 they equal the
 *   d43c8f92 page's own labels);
 * - family and order are presentation. For version 1 the pinned list is the
 *   d43c8f92 page's card order (astra, 6-sol, 6-luna, 5.6-terra, 5.6-sol,
 *   5.6-luna, orders 0..5), each with its model-visuals.js theme as family. A
 *   roster model neither pinned nor hidden (none in version 1) is family
 *   `generic`, ordered after the pinned ones by roster index. The block
 *   therefore names exactly the models the d43c8f92 page charts, in its order
 *   and with its themes. What a block adds after cutover is a name and an
 *   order for a model the page's own catalog has never seen.
 *
 * Unknown and hidden names (owner decision round 5). Only public roster
 * models are ever named. A tuple whose id the block does not name gets no
 * metadata entry: a reader that knows the id from its own catalog keeps the
 * tuple without charting it (a hidden model such as GPT-5.5), and a reader
 * that does not skips it and states the gap. The tuple is not removed here,
 * because that would change bytes the oracle serves. At d43c8f92 an id outside
 * the reviewed catalog cannot occur: the vendored preview validation admits
 * only reviewed catalog ids.
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
  /** Charted models in display order 0..n-1, each with its family. */
  readonly pinned: readonly (readonly [id: string, family: string])[];
  /**
   * Primary roster models kept off the public page, never named, so a reader
   * that charts every named model still never charts one. Each must be a
   * primary openai_codex model of the manifest, listed once, and not pinned.
   */
  readonly publicHidden: readonly string[];
  /** Family of every roster model neither pinned nor hidden: outside the reader's themed set. */
  readonly unpinnedFamily: string;
}

/**
 * Presentation per manifest version. Version 1 reproduces the d43c8f92 public
 * page: its six charted models (community-data.js PUBLIC_ALLOWANCE_MODEL_CONFIG)
 * in its card order, each with its model-visuals.js theme, and the owner's
 * hide list for every other primary model (see the module comment). A later
 * manifest that binds metadata must add its own entry here or carry
 * presentation itself. An absent version fails closed rather than borrowing
 * another version's roster or order.
 */
export const PUBLIC_MODEL_PRESENTATION_BY_MANIFEST_VERSION: Readonly<Record<number, PublicModelPresentation>> =
  Object.freeze({
    1: Object.freeze({
      pinned: Object.freeze([
        Object.freeze(["gpt-6-astra", "astra"] as const),
        Object.freeze(["gpt-6-sol", "sol"] as const),
        Object.freeze(["gpt-6-luna", "luna"] as const),
        Object.freeze(["gpt-5.6-terra", "terra"] as const),
        Object.freeze(["gpt-5.6-sol", "sol"] as const),
        Object.freeze(["gpt-5.6-luna", "luna"] as const),
      ]),
      publicHidden: Object.freeze([
        "codex-auto-review", "gpt-4-turbo-2024-04-09", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
        "gpt-4o", "gpt-4o-2024-05-13", "gpt-4o-mini", "gpt-5", "gpt-5-codex", "gpt-5-mini",
        "gpt-5-nano", "gpt-5-pro", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.2",
        "gpt-5.2-codex", "gpt-5.2-pro", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
        "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-codex", "gpt-5.5-pro", "gpt-5.6-sol-wm", "o1", "o1-pro",
        "o3", "o3-mini", "o3-pro", "o4-mini", "gpt-6.1-astra",
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

/** The manifest's primary Codex models (openai_codex, primary track), in manifest order. */
function primaryCodexModels(models: readonly PublicCatalogModel[]): PublicCatalogModel[] {
  if (!Array.isArray(models)) fail("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
  return models.filter((model) => isRecord(model) && model.provider === "openai_codex"
    && model.allowanceTrack === "primary");
}

/**
 * The closed metadata block for one manifest: its public roster (primary Codex
 * models that are neither manifest-hidden nor on the version's publicHidden
 * list) with the version's presentation. Throws when the version has no
 * presentation; when the hide list names a model that is not a primary Codex
 * model of the manifest, names one twice or names a pinned one; or when the
 * roster breaks the reader's grammars, bounds or uniqueness, or a pinned model
 * is missing from it. A reviewed catalog that cannot be published is refused,
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
  const primary = primaryCodexModels(manifest.models);
  const pinnedOrder = new Map(presentation.pinned.map(([id, family], index) => [id, { family, order: index }]));
  const primaryIds = new Set(primary.map((model) => model.id));
  const publicHidden = new Set(presentation.publicHidden);
  if (publicHidden.size !== presentation.publicHidden.length
      || presentation.publicHidden.some((id) => !primaryIds.has(id) || pinnedOrder.has(id))) {
    fail("PUBLIC_MODEL_METADATA_CATALOG_INVALID");
  }
  const roster = primary.filter((model) => model.hidden === false && !publicHidden.has(model.id));
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
