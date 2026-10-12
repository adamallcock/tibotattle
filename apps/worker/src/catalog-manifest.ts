/**
 * The signed catalog manifest (KM-1 contract, KM-2 envelope).
 *
 * The manifest is the reviewed vocabulary and price data the server and
 * analytics can load without a deploy: providers, models, price cards, speed
 * rules, API service tiers and plans. It is append-only and versioned by a
 * contiguous integer (`version`), hash-chained (`previousDigest`), and
 * distributed inside a signed envelope (`catalog-envelope-v1`, Ed25519 over a
 * domain-separated message).
 *
 * Version 1 is the BASELINE: a projection of the compiled d43c8f92 price
 * registry, reviewed model catalog and plan roster (projectCatalogManifest
 * with CATALOG_BASELINE_RELEASE). Pricing from it is byte-identical to the
 * compiled registry: its price cards are the compiled cards in their exact
 * key order, and `compat.registrySha256` reproduces the compiled
 * APP_PRICE_REGISTRY_SHA256 from them.
 *
 * The name guard (owner decision, round 7) is EXACTLY the v1.x wire grammar:
 * `[A-Za-z0-9._:-]`, 1 to 64 characters, case preserved, nothing else
 * refused. Model, provider, speed, tier and plan names are vocabulary, not
 * account identifiers (AGENTS.md, docs/decisions/2026-10-02-catalog-vocabulary-
 * plain-text.md): a value inside the grammar passes as plain text, including
 * colon-delimited ARNs; a value outside it (an ARN with '/', anything longer
 * than 64 characters) is `unrecognized`. Inside a manifest, which is reviewed
 * configuration rather than telemetry, an out-of-grammar token is refused.
 *
 * Boundary. This module is runtime-neutral and has no imports, so plain Node
 * type stripping, the Worker bundle and the Cloud Run bundle all load it
 * unchanged. Digests and signature checks are injected adapters (the
 * cross-check's package rule: no direct crypto in the contract), with
 * WebCrypto defaults exported separately. It lives in the Worker because the
 * GCP line holds the workspace packages at the d43c8f92 bytes (the IN-3 oracle
 * pins their installed index files); it is written to move into
 * packages/telemetry-contract and packages/accounting unchanged when those
 * bytes may move (client track KC-1/KC-2).
 *
 * Errors carry a closed code and a structural path, never a value.
 */

export const CATALOG_MANIFEST_SCHEMA_VERSION = "tibotattle-catalog-manifest-v1" as const;
export const CATALOG_ENVELOPE_FORMAT = "catalog-envelope-v1" as const;
/** Signed message = this prefix || payload bytes. Stops cross-protocol reuse. */
export const CATALOG_SIGNATURE_DOMAIN = "tibotattle-catalog-manifest-v1\n" as const;
export const CATALOG_TOKEN_GUARD_VERSION = "catalog-token-guard-v1" as const;
/** The v1.0/v1.1/v1.2 wire token grammar (telemetry-v1.ts BOUNDED_TOKEN). */
export const CATALOG_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
/** Consumers refuse a larger envelope before parsing it. */
export const CATALOG_MAX_ENVELOPE_BYTES = 1_048_576;
/** Leaves room for base64url expansion and the envelope keys under the envelope cap. */
export const CATALOG_MAX_PAYLOAD_BYTES = 778_240;
export const CATALOG_MAX_VERSION = 2_147_483_647;

export const CATALOG_ERROR_CODES = Object.freeze([
  "CATALOG_ENVELOPE_TOO_LARGE",
  "CATALOG_ENVELOPE_INVALID",
  "CATALOG_KEY_UNTRUSTED",
  "CATALOG_SIGNATURE_INVALID",
  "CATALOG_PAYLOAD_TOO_LARGE",
  "CATALOG_PAYLOAD_NOT_CANONICAL",
  "CATALOG_SCHEMA_INVALID",
  "CATALOG_TOKEN_OUT_OF_GRAMMAR",
  "CATALOG_PRICE_CARDS_INVALID",
  "CATALOG_REGISTRY_SHA_MISMATCH",
  "CATALOG_VERSION_REGRESSION",
  "CATALOG_VERSION_GAP",
  "CATALOG_CHAIN_MISMATCH",
  "CATALOG_NOT_APPEND_ONLY",
  "CATALOG_TRUSTED_KEYS_INVALID",
  "CATALOG_SIGNING_KEY_INVALID",
] as const);
export type CatalogErrorCode = (typeof CATALOG_ERROR_CODES)[number];

export class CatalogManifestError extends Error {
  readonly code: CatalogErrorCode;
  /** A structural path such as `priceCards[3].components[1]`; never a value. */
  readonly detail: string | null;

  constructor(code: CatalogErrorCode, detail: string | null = null) {
    super(code);
    this.name = "CatalogManifestError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code: CatalogErrorCode, detail: string | null = null): never {
  throw new CatalogManifestError(code, detail);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** sha256 of the UTF-8 bytes of `text`, as 64 lowercase hex. */
export type CatalogDigest = (text: string) => Promise<string> | string;
export type CatalogSignatureVerifier = (input: {
  publicKey: Uint8Array;
  message: Uint8Array;
  signature: Uint8Array;
}) => Promise<boolean> | boolean;

export interface CatalogTrustedKey {
  /** Closed key id, for example `catalog-prod-2026a`. */
  keyId: string;
  /** Standard base64 of the raw 32-byte Ed25519 public key. */
  publicKey: string;
}

export type PriceCard = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly service_tier: string;
};

export interface CatalogProvider { id: string; priceProvider: string; surface: string }
export interface CatalogModel {
  id: string;
  label: string;
  provider: string;
  allowanceTrack: "primary" | "spark";
  pricingStatus: "published" | "assumed_alias" | "unpriced";
  priceModelId: string | null;
  hidden: boolean;
}
export interface CatalogRetraction {
  cardId: string;
  inVersion: number;
  reason: "price_correction" | "withdrawn" | "superseded";
  supersededBy: string[];
}
export interface CatalogSpeed {
  billingSurface: "chatgpt_subscription" | "claude_subscription";
  token: string;
  rule: "standard_counterfactual" | "priority_ratio" | "unpriced";
}
export interface CatalogTier { priceProvider: string; token: string }
export interface CatalogPlan { id: string; label: string | null }

export interface CatalogManifest {
  schemaVersion: typeof CATALOG_MANIFEST_SCHEMA_VERSION;
  version: number;
  previousVersion: number | null;
  previousDigest: string | null;
  publishedAt: string;
  activateAt: string;
  projectedFromCommit: string | null;
  compat: {
    registryVersion: string;
    registryObservedAt: string;
    registrySha256: string;
    catalogVersion: string;
  };
  normalization: {
    priceBasis: "official_api_price_not_subscription_allowance";
    currency: "USD";
    per: "1000000";
    priceEpochBasis: "event_time_when_registry_has_effective_evidence";
    tokenGuard: typeof CATALOG_TOKEN_GUARD_VERSION;
  };
  assertions: { fastModeAssumedMultiplier: string };
  providers: CatalogProvider[];
  models: CatalogModel[];
  priceCards: PriceCard[];
  retractions: CatalogRetraction[];
  speeds: CatalogSpeed[];
  tiers: CatalogTier[];
  plans: CatalogPlan[];
}

export interface VerifiedCatalogManifest {
  manifest: CatalogManifest;
  /** The exact signed payload text (canonical JSON). */
  payloadText: string;
  /** sha256 of payloadText; the hash-chain link and the database digest. */
  digest: string;
  keyId: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Token guard (catalog-token-guard-v1 = the wire grammar, nothing else)
// ---------------------------------------------------------------------------

export function isCatalogToken(value: unknown): value is string {
  return typeof value === "string" && CATALOG_TOKEN_PATTERN.test(value);
}

export type CatalogTokenGuardResult =
  | { status: "token"; token: string }
  | { status: "unrecognized" }
  | { status: "missing" };

/**
 * Classify an observed vocabulary value. A string inside the wire grammar is
 * passed through as plain text, case preserved; any other string is
 * `unrecognized` (counted, never refused); null, undefined and the empty
 * string are `missing`.
 */
export function guardCatalogToken(value: unknown): CatalogTokenGuardResult {
  if (value === null || value === undefined || value === "") return { status: "missing" };
  return isCatalogToken(value) ? { status: "token", token: value } : { status: "unrecognized" };
}

// ---------------------------------------------------------------------------
// Primitive checks
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX40 = /^[0-9a-f]{40}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const CARD_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const VERSION_LABEL = /^[A-Za-z0-9._:-]{1,128}$/u;
const SOURCE_NAME = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
const COMPONENT_NAME = /^[a-z0-9_]{1,64}$/u;
const UNIT_NAME = /^[a-z]{1,32}$/u;
const SURFACE = /^[a-z0-9._-]{1,64}$/u;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const INTEGER_STRING = /^(?:0|[1-9]\d{0,17})$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const LABEL = /^[^\p{C}]{1,80}$/u;
const NOTE = /^[^\p{C}]{1,1024}$/u;
const MAX_URL_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function schema(path: string): never {
  return fail("CATALOG_SCHEMA_INVALID", path);
}

function cards(path: string): never {
  return fail("CATALOG_PRICE_CARDS_INVALID", path);
}

/** Exact keys, in exactly this order. */
function exactKeys(
  value: unknown,
  keys: readonly string[],
  path: string,
  onFail: (path: string) => never = schema,
): Record<string, unknown> {
  if (!isRecord(value)) onFail(path);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) onFail(path);
  return value;
}

/** Required keys plus allowed optional keys, any order, nothing else. */
function closedKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  onFail: (path: string) => never,
): Record<string, unknown> {
  if (!isRecord(value)) onFail(path);
  const keys = Object.keys(value);
  for (const key of required) if (!Object.hasOwn(value, key)) onFail(`${path}.${key}`);
  for (const key of keys) {
    if (!required.includes(key) && !optional.includes(key)) onFail(`${path}.${key}`);
  }
  return value;
}

function token(value: unknown, path: string): string {
  if (!isCatalogToken(value)) fail("CATALOG_TOKEN_OUT_OF_GRAMMAR", path);
  return value;
}

function text(value: unknown, pattern: RegExp, path: string, onFail: (path: string) => never = schema): string {
  if (typeof value !== "string" || !pattern.test(value)) onFail(path);
  return value;
}

function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isInstant(value: unknown): value is string {
  if (typeof value !== "string" || !INSTANT.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && `${parsed.toISOString().slice(0, 19)}Z` === value;
}

function httpsUrl(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || /[\s\p{C}]/u.test(value)) cards(path);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return cards(path);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") cards(path);
  return value;
}

function array(value: unknown, min: number, max: number, path: string, onFail: (path: string) => never = schema): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) onFail(path);
  return value;
}

// ---------------------------------------------------------------------------
// Price cards (the accounting section)
// ---------------------------------------------------------------------------

const CARD_REQUIRED = Object.freeze(["schema_version", "id", "provider", "model", "service_tier", "region",
  "effective", "components", "source", "metadata"]);
const CARD_OPTIONAL = Object.freeze(["aliases"]);
const METADATA_REQUIRED = Object.freeze(["pricing_basis", "api_service_tier", "subscription_speed_tier", "provenance"]);
const METADATA_OPTIONAL = Object.freeze(["total_input_context_band", "alias_assumptions", "coverage_note", "price_card_kind"]);
const PROVENANCE_KEYS = Object.freeze(["observed_at", "evidence_version", "evidence_sha256", "evidence_hash_scope",
  "evidence_urls", "vendor_effective_from", "vendor_effective_to", "historical_validity"]);
const HISTORICAL_VALIDITY = Object.freeze(["official_vendor_window", "reviewed_rate_without_vendor_effective_date"]);
const SHORT_BOUND = "max_total_input_tokens";
const LONG_BOUND = "min_total_input_tokens";

interface CardShape {
  band: "short" | "long" | null;
  /** The band's boundary from the card's own component conditions. */
  bound: bigint | null;
}

function validateCardStructure(card: unknown, index: number, priceBasis: string): CardShape {
  const path = `priceCards[${index}]`;
  const value = closedKeys(card, CARD_REQUIRED, CARD_OPTIONAL, path, cards);
  if (value.schema_version !== "0.1") cards(`${path}.schema_version`);
  text(value.id, CARD_ID, `${path}.id`, cards);
  token(value.provider, `${path}.provider`);
  token(value.model, `${path}.model`);
  token(value.service_tier, `${path}.service_tier`);
  token(value.region, `${path}.region`);
  if (Object.hasOwn(value, "aliases")) {
    const aliases = array(value.aliases, 1, 16, `${path}.aliases`, cards);
    const seen = new Set<string>();
    aliases.forEach((alias, aliasIndex) => {
      token(alias, `${path}.aliases[${aliasIndex}]`);
      if (seen.has(alias as string) || alias === value.model) cards(`${path}.aliases[${aliasIndex}]`);
      seen.add(alias as string);
    });
  }
  const effective = closedKeys(value.effective, [], ["from", "to"], `${path}.effective`, cards);
  for (const key of ["from", "to"]) {
    if (Object.hasOwn(effective, key) && !isDay(effective[key])) cards(`${path}.effective.${key}`);
  }
  if (typeof effective.from === "string" && typeof effective.to === "string" && effective.from > effective.to) {
    cards(`${path}.effective`);
  }

  const metadata = closedKeys(value.metadata, METADATA_REQUIRED, METADATA_OPTIONAL, `${path}.metadata`, cards);
  if (metadata.pricing_basis !== priceBasis) cards(`${path}.metadata.pricing_basis`);
  if (metadata.api_service_tier !== value.service_tier) cards(`${path}.metadata.api_service_tier`);
  if (metadata.subscription_speed_tier !== null) cards(`${path}.metadata.subscription_speed_tier`);
  const band = Object.hasOwn(metadata, "total_input_context_band") ? metadata.total_input_context_band : null;
  if (band !== null && band !== "short" && band !== "long") cards(`${path}.metadata.total_input_context_band`);
  if (Object.hasOwn(metadata, "coverage_note")) text(metadata.coverage_note, NOTE, `${path}.metadata.coverage_note`, cards);
  if (Object.hasOwn(metadata, "price_card_kind")) token(metadata.price_card_kind, `${path}.metadata.price_card_kind`);
  if (Object.hasOwn(metadata, "alias_assumptions")) {
    const assumptions = metadata.alias_assumptions;
    const aliases = (value.aliases ?? []) as string[];
    if (!isRecord(assumptions) || Object.keys(assumptions).length !== aliases.length
        || aliases.some((alias) => !Object.hasOwn(assumptions, alias))) {
      cards(`${path}.metadata.alias_assumptions`);
    }
    for (const alias of aliases) text(assumptions[alias], NOTE, `${path}.metadata.alias_assumptions`, cards);
  }

  const source = exactKeys(value.source, ["name", "url", "retrieved_at", "version"], `${path}.source`, cards);
  text(source.name, SOURCE_NAME, `${path}.source.name`, cards);
  httpsUrl(source.url, `${path}.source.url`);
  if (!isInstant(source.retrieved_at)) cards(`${path}.source.retrieved_at`);
  text(source.version, VERSION_LABEL, `${path}.source.version`, cards);

  const provenance = exactKeys(metadata.provenance, PROVENANCE_KEYS, `${path}.metadata.provenance`, cards);
  if (provenance.observed_at !== source.retrieved_at
      || provenance.evidence_version !== source.version) {
    cards(`${path}.metadata.provenance`);
  }
  text(provenance.evidence_sha256, HEX64, `${path}.metadata.provenance.evidence_sha256`, cards);
  token(provenance.evidence_hash_scope, `${path}.metadata.provenance.evidence_hash_scope`);
  array(provenance.evidence_urls, 1, 32, `${path}.metadata.provenance.evidence_urls`, cards)
    .forEach((url, urlIndex) => httpsUrl(url, `${path}.metadata.provenance.evidence_urls[${urlIndex}]`));
  for (const key of ["vendor_effective_from", "vendor_effective_to"]) {
    if (provenance[key] !== null && !isDay(provenance[key])) cards(`${path}.metadata.provenance.${key}`);
  }
  if (!HISTORICAL_VALIDITY.includes(provenance.historical_validity as string)) {
    cards(`${path}.metadata.provenance.historical_validity`);
  }

  // Per-card boundary rule: every component of a banded card carries the
  // same explicit boundary, short as an inclusive maximum, long as an
  // inclusive minimum; an unbanded card carries no conditions. The boundary
  // value is the card's own (no model-name branch); the short/long pairing
  // is checked across cards below.
  let bound: bigint | null = null;
  array(value.components, 1, 32, `${path}.components`, cards).forEach((component, componentIndex) => {
    const componentPath = `${path}.components[${componentIndex}]`;
    const entry = closedKeys(component, ["usage_component", "unit", "price"], ["conditions"], componentPath, cards);
    text(entry.usage_component, COMPONENT_NAME, `${componentPath}.usage_component`, cards);
    text(entry.unit, UNIT_NAME, `${componentPath}.unit`, cards);
    const price = exactKeys(entry.price, ["amount", "currency", "per"], `${componentPath}.price`, cards);
    text(price.amount, DECIMAL, `${componentPath}.price.amount`, cards);
    if (price.currency !== "USD") cards(`${componentPath}.price.currency`);
    text(price.per, DECIMAL, `${componentPath}.price.per`, cards);
    if (/^0(?:\.0+)?$/u.test(price.per as string)) cards(`${componentPath}.price.per`);
    if (band === null) {
      if (Object.hasOwn(entry, "conditions")) cards(`${componentPath}.conditions`);
      return;
    }
    const key = band === "short" ? SHORT_BOUND : LONG_BOUND;
    const conditions = exactKeys(entry.conditions, [key], `${componentPath}.conditions`, cards);
    const raw = text(conditions[key], INTEGER_STRING, `${componentPath}.conditions.${key}`, cards);
    const parsed = BigInt(raw);
    if (bound !== null && bound !== parsed) cards(`${componentPath}.conditions`);
    bound = parsed;
  });
  return { band: band as CardShape["band"], bound };
}

function rangeOverlap(left: PriceCard, right: PriceCard): boolean {
  const l = left.effective as { from?: string; to?: string };
  const r = right.effective as { from?: string; to?: string };
  return (l.from ?? "0000-00-00") <= (r.to ?? "9999-99-99") && (r.from ?? "0000-00-00") <= (l.to ?? "9999-99-99");
}

function sameContext(left: PriceCard, right: PriceCard): boolean {
  return left.provider === right.provider && left.model === right.model
    && left.service_tier === right.service_tier && left.region === right.region;
}

function sameEffective(left: PriceCard, right: PriceCard): boolean {
  const l = left.effective as { from?: string; to?: string };
  const r = right.effective as { from?: string; to?: string };
  return (l.from ?? null) === (r.from ?? null) && (l.to ?? null) === (r.to ?? null);
}

function bandOf(card: PriceCard): "short" | "long" | null {
  const metadata = card.metadata as Record<string, unknown>;
  return (metadata.total_input_context_band ?? null) as "short" | "long" | null;
}

/**
 * The active price-card set must stand on its own as a registry: unique ids,
 * no overlapping cards in one pricing context, aliases that never claim a
 * second canonical model, and short/long bands that meet exactly (the long
 * minimum is the short maximum plus one).
 */
function validateActiveCardSet(active: readonly PriceCard[], shapes: Map<string, CardShape>): void {
  const claimed = new Map<string, string>();
  for (const card of active) {
    for (const name of [card.model, ...((card.aliases ?? []) as string[])]) {
      const key = `${card.provider}\u0000${name}`;
      const prior = claimed.get(key);
      if (prior !== undefined && prior !== card.model) cards(`priceCards[${card.id}].aliases`);
      claimed.set(key, card.model);
    }
  }
  for (let left = 0; left < active.length; left += 1) {
    for (let right = left + 1; right < active.length; right += 1) {
      const a = active[left]!;
      const b = active[right]!;
      if (!sameContext(a, b) || !rangeOverlap(a, b)) continue;
      const bandA = bandOf(a);
      const bandB = bandOf(b);
      if (bandA === null || bandB === null || bandA === bandB) cards("priceCards.overlap");
      // A short and a long card for the same window must meet exactly.
      if (sameEffective(a, b)) {
        const short = bandA === "short" ? shapes.get(a.id)! : shapes.get(b.id)!;
        const long = bandA === "long" ? shapes.get(a.id)! : shapes.get(b.id)!;
        if (short.bound === null || long.bound === null || long.bound !== short.bound + 1n) {
          cards("priceCards.contextBoundary");
        }
      }
    }
  }
}

/** Card ids retracted by the manifest, with the active cards in manifest order. */
export function activeCatalogPriceCards(manifest: Pick<CatalogManifest, "priceCards" | "retractions">): PriceCard[] {
  const retracted = new Set(manifest.retractions.map((entry) => entry.cardId));
  return manifest.priceCards.filter((card) => !retracted.has(card.id));
}

/** The digest of one card's canonical bytes (JSON.stringify, key order preserved). */
export async function catalogCardDigest(card: PriceCard, digest: CatalogDigest): Promise<string> {
  return digest(JSON.stringify(card));
}

/**
 * The registry SHA the compiled kernels stamp, reproduced from the manifest:
 * sha256 of JSON.stringify(active cards), exactly as APP_PRICE_REGISTRY_SHA256
 * is sha256 of JSON.stringify(APP_OFFICIAL_PRICE_CARDS).
 */
export async function catalogRegistrySha256(
  manifest: Pick<CatalogManifest, "priceCards" | "retractions">,
  digest: CatalogDigest,
): Promise<string> {
  return digest(JSON.stringify(activeCatalogPriceCards(manifest)));
}

// ---------------------------------------------------------------------------
// The manifest payload
// ---------------------------------------------------------------------------

const MANIFEST_KEYS = Object.freeze(["schemaVersion", "version", "previousVersion", "previousDigest", "publishedAt",
  "activateAt", "projectedFromCommit", "compat", "normalization", "assertions", "providers", "models",
  "priceCards", "retractions", "speeds", "tiers", "plans"]);
const NORMALIZATION = Object.freeze({
  priceBasis: "official_api_price_not_subscription_allowance",
  currency: "USD",
  per: "1000000",
  priceEpochBasis: "event_time_when_registry_has_effective_evidence",
  tokenGuard: CATALOG_TOKEN_GUARD_VERSION,
});
const ALLOWANCE_TRACKS = Object.freeze(["primary", "spark"]);
const PRICING_STATUSES = Object.freeze(["published", "assumed_alias", "unpriced"]);
const RETRACTION_REASONS = Object.freeze(["price_correction", "withdrawn", "superseded"]);
const SPEED_SURFACES = Object.freeze(["chatgpt_subscription", "claude_subscription"]);
const SPEED_RULES = Object.freeze(["standard_counterfactual", "priority_ratio", "unpriced"]);

function version(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > CATALOG_MAX_VERSION) {
    schema(path);
  }
  return value;
}

function unique<T>(entries: readonly T[], key: (entry: T) => string, path: string): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const name = key(entry);
    if (seen.has(name)) schema(`${path}[${index}]`);
    seen.add(name);
  });
}

/**
 * Validate a parsed payload against the closed v1 schema and its internal
 * cross-references. Synchronous and digest-free; the registry SHA and the
 * signature are checked by verifyCatalogEnvelope / validateCatalogManifest.
 */
export function validateCatalogManifestPayload(value: unknown): CatalogManifest {
  const manifest = exactKeys(value, MANIFEST_KEYS, "manifest");
  if (manifest.schemaVersion !== CATALOG_MANIFEST_SCHEMA_VERSION) schema("schemaVersion");
  const current = version(manifest.version, "version");
  if (current === 1) {
    if (manifest.previousVersion !== null || manifest.previousDigest !== null) schema("previousVersion");
  } else {
    if (manifest.previousVersion !== current - 1) schema("previousVersion");
    text(manifest.previousDigest, HEX64, "previousDigest");
  }
  if (!isInstant(manifest.publishedAt)) schema("publishedAt");
  if (!isInstant(manifest.activateAt) || (manifest.activateAt as string) < (manifest.publishedAt as string)) {
    schema("activateAt");
  }
  if (manifest.projectedFromCommit !== null) text(manifest.projectedFromCommit, HEX40, "projectedFromCommit");

  const compat = exactKeys(manifest.compat, ["registryVersion", "registryObservedAt", "registrySha256",
    "catalogVersion"], "compat");
  text(compat.registryVersion, VERSION_LABEL, "compat.registryVersion");
  if (!isInstant(compat.registryObservedAt)) schema("compat.registryObservedAt");
  text(compat.registrySha256, HEX64, "compat.registrySha256");
  text(compat.catalogVersion, VERSION_LABEL, "compat.catalogVersion");

  const normalization = exactKeys(manifest.normalization, Object.keys(NORMALIZATION), "normalization");
  for (const [key, expected] of Object.entries(NORMALIZATION)) {
    if (normalization[key] !== expected) schema(`normalization.${key}`);
  }
  const assertions = exactKeys(manifest.assertions, ["fastModeAssumedMultiplier"], "assertions");
  text(assertions.fastModeAssumedMultiplier, DECIMAL, "assertions.fastModeAssumedMultiplier");

  const providers = array(manifest.providers, 1, 16, "providers").map((entry, index) => {
    const provider = exactKeys(entry, ["id", "priceProvider", "surface"], `providers[${index}]`);
    token(provider.id, `providers[${index}].id`);
    token(provider.priceProvider, `providers[${index}].priceProvider`);
    text(provider.surface, SURFACE, `providers[${index}].surface`);
    return provider as unknown as CatalogProvider;
  });
  unique(providers, (entry) => entry.id, "providers");
  const providerIds = new Set(providers.map((entry) => entry.id));
  const priceProviders = new Set(providers.map((entry) => entry.priceProvider));

  const tiers = array(manifest.tiers, 1, 64, "tiers").map((entry, index) => {
    const tier = exactKeys(entry, ["priceProvider", "token"], `tiers[${index}]`);
    token(tier.priceProvider, `tiers[${index}].priceProvider`);
    token(tier.token, `tiers[${index}].token`);
    if (!priceProviders.has(tier.priceProvider as string)) schema(`tiers[${index}].priceProvider`);
    return tier as unknown as CatalogTier;
  });
  unique(tiers, (entry) => `${entry.priceProvider}\u0000${entry.token}`, "tiers");
  const tierKeys = new Set(tiers.map((entry) => `${entry.priceProvider}\u0000${entry.token}`));

  const speeds = array(manifest.speeds, 1, 64, "speeds").map((entry, index) => {
    const speed = exactKeys(entry, ["billingSurface", "token", "rule"], `speeds[${index}]`);
    if (!SPEED_SURFACES.includes(speed.billingSurface as string)) schema(`speeds[${index}].billingSurface`);
    token(speed.token, `speeds[${index}].token`);
    if (!SPEED_RULES.includes(speed.rule as string)) schema(`speeds[${index}].rule`);
    return speed as unknown as CatalogSpeed;
  });
  unique(speeds, (entry) => `${entry.billingSurface}\u0000${entry.token}`, "speeds");

  const plans = array(manifest.plans, 1, 256, "plans").map((entry, index) => {
    const plan = exactKeys(entry, ["id", "label"], `plans[${index}]`);
    token(plan.id, `plans[${index}].id`);
    if (plan.label !== null) text(plan.label, LABEL, `plans[${index}].label`);
    return plan as unknown as CatalogPlan;
  });
  unique(plans, (entry) => entry.id, "plans");

  const priceCards = array(manifest.priceCards, 1, 4096, "priceCards", cards) as PriceCard[];
  const shapes = new Map<string, CardShape>();
  priceCards.forEach((card, index) => {
    const shape = validateCardStructure(card, index, NORMALIZATION.priceBasis);
    if (shapes.has(card.id)) cards(`priceCards[${index}].id`);
    shapes.set(card.id, shape);
    if (!priceProviders.has(card.provider)) cards(`priceCards[${index}].provider`);
  });

  const retractions = array(manifest.retractions, 0, 4096, "retractions").map((entry, index) => {
    const path = `retractions[${index}]`;
    const retraction = exactKeys(entry, ["cardId", "inVersion", "reason", "supersededBy"], path);
    text(retraction.cardId, CARD_ID, `${path}.cardId`);
    if (!shapes.has(retraction.cardId as string)) schema(`${path}.cardId`);
    const inVersion = version(retraction.inVersion, `${path}.inVersion`);
    if (inVersion < 2 || inVersion > current) schema(`${path}.inVersion`);
    if (!RETRACTION_REASONS.includes(retraction.reason as string)) schema(`${path}.reason`);
    array(retraction.supersededBy, 0, 16, `${path}.supersededBy`).forEach((cardId, supersededIndex) => {
      text(cardId, CARD_ID, `${path}.supersededBy[${supersededIndex}]`);
      if (!shapes.has(cardId as string) || cardId === retraction.cardId) {
        schema(`${path}.supersededBy[${supersededIndex}]`);
      }
    });
    return retraction as unknown as CatalogRetraction;
  });
  unique(retractions, (entry) => entry.cardId, "retractions");

  const typed = manifest as unknown as CatalogManifest;
  const active = activeCatalogPriceCards({ priceCards, retractions });
  if (active.length === 0) cards("priceCards.active");
  for (const card of active) {
    if (!tierKeys.has(`${card.provider}\u0000${card.service_tier}`)) cards(`priceCards[${card.id}].service_tier`);
  }
  validateActiveCardSet(active, shapes);

  const providerById = new Map(providers.map((entry) => [entry.id, entry]));
  const models = array(manifest.models, 1, 4096, "models").map((entry, index) => {
    const path = `models[${index}]`;
    const model = exactKeys(entry, ["id", "label", "provider", "allowanceTrack", "pricingStatus", "priceModelId",
      "hidden"], path);
    token(model.id, `${path}.id`);
    text(model.label, LABEL, `${path}.label`);
    if (!providerIds.has(model.provider as string)) schema(`${path}.provider`);
    if (!ALLOWANCE_TRACKS.includes(model.allowanceTrack as string)) schema(`${path}.allowanceTrack`);
    if (!PRICING_STATUSES.includes(model.pricingStatus as string)) schema(`${path}.pricingStatus`);
    if (model.pricingStatus === "unpriced") {
      if (model.priceModelId !== null) schema(`${path}.priceModelId`);
    } else {
      token(model.priceModelId, `${path}.priceModelId`);
    }
    if (typeof model.hidden !== "boolean") schema(`${path}.hidden`);
    return model as unknown as CatalogModel;
  });
  unique(models, (entry) => entry.id, "models");
  const modelById = new Map(models.map((entry) => [entry.id, entry]));
  // Price references resolve inside the catalog and to a card that names them.
  models.forEach((model, index) => {
    if (model.pricingStatus === "unpriced") return;
    const priceProvider = providerById.get(model.provider)!.priceProvider;
    const target = modelById.get(model.priceModelId!);
    if (target === undefined || target.provider !== model.provider) schema(`models[${index}].priceModelId`);
    const named = priceCards.some((card) => card.provider === priceProvider
      && card.model === model.priceModelId
      && (model.pricingStatus === "published"
        ? model.priceModelId === model.id
        : ((card.aliases ?? []) as string[]).includes(model.id)));
    if (!named) schema(`models[${index}].priceModelId`);
  });
  return typed;
}

// ---------------------------------------------------------------------------
// Canonical bytes
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The canonical payload text: JSON.stringify with the given key order. */
export function canonicalCatalogPayloadText(manifest: CatalogManifest): string {
  return JSON.stringify(manifest);
}

/**
 * Parse payload text, refusing any form other than the canonical one: no
 * whitespace, no duplicate keys, no non-canonical escapes or numbers. The
 * refusal works because JSON.stringify(JSON.parse(text)) differs from text
 * for each of those.
 */
export function parseCanonicalCatalogPayload(payloadText: string): unknown {
  if (encoder.encode(payloadText).byteLength > CATALOG_MAX_PAYLOAD_BYTES) fail("CATALOG_PAYLOAD_TOO_LARGE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return fail("CATALOG_PAYLOAD_NOT_CANONICAL");
  }
  if (JSON.stringify(parsed) !== payloadText) fail("CATALOG_PAYLOAD_NOT_CANONICAL");
  return parsed;
}

/** Validate a manifest object completely, including the registry SHA reproduction. */
export async function validateCatalogManifest(value: unknown, digest: CatalogDigest): Promise<CatalogManifest> {
  const manifest = validateCatalogManifestPayload(value);
  if (await catalogRegistrySha256(manifest, digest) !== manifest.compat.registrySha256) {
    fail("CATALOG_REGISTRY_SHA_MISMATCH", "compat.registrySha256");
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Append-only continuity
// ---------------------------------------------------------------------------

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The successor rules between the held manifest and a candidate:
 * - the version is exactly held + 1, naming the held version and digest;
 * - every provider, speed and tier entry is carried unchanged;
 * - every model and plan id is carried, with its core unchanged (a model's
 *   label and hidden flag, and a plan's label, may change);
 * - every card is carried with identical canonical bytes, active or retracted;
 * - earlier retractions are carried unchanged and new ones are in this version;
 * - publication time never moves backwards;
 * - activation time never moves backwards. A successor carries everything the
 *   held manifest does, so activating it earlier would make a pending
 *   manifest's content live before that manifest's own activateAt.
 */
export async function assertCatalogManifestSuccessor({ held, heldDigest, next, digest }: {
  held: CatalogManifest;
  heldDigest: string;
  next: CatalogManifest;
  digest: CatalogDigest;
}): Promise<void> {
  if (next.version <= held.version) fail("CATALOG_VERSION_REGRESSION", "version");
  if (next.version !== held.version + 1 || next.previousVersion !== held.version) {
    fail("CATALOG_VERSION_GAP", "version");
  }
  if (next.previousDigest !== heldDigest) fail("CATALOG_CHAIN_MISMATCH", "previousDigest");
  // Instants are fixed-width UTC (INSTANT), so text order is time order.
  if (next.publishedAt < held.publishedAt) fail("CATALOG_NOT_APPEND_ONLY", "publishedAt");
  if (next.activateAt < held.activateAt) fail("CATALOG_NOT_APPEND_ONLY", "activateAt");

  const carried = <T>(section: string, before: readonly T[], after: readonly T[], key: (entry: T) => string,
    core: (entry: T) => unknown) => {
    const byKey = new Map(after.map((entry) => [key(entry), entry]));
    before.forEach((entry, index) => {
      const successor = byKey.get(key(entry));
      if (successor === undefined || !sameJson(core(entry), core(successor))) {
        fail("CATALOG_NOT_APPEND_ONLY", `${section}[${index}]`);
      }
    });
  };
  carried("providers", held.providers, next.providers, (entry) => entry.id, (entry) => entry);
  carried("speeds", held.speeds, next.speeds, (entry) => `${entry.billingSurface}\u0000${entry.token}`,
    (entry) => entry);
  carried("tiers", held.tiers, next.tiers, (entry) => `${entry.priceProvider}\u0000${entry.token}`, (entry) => entry);
  carried("models", held.models, next.models, (entry) => entry.id, (entry) => [entry.id, entry.provider,
    entry.allowanceTrack, entry.pricingStatus, entry.priceModelId]);
  carried("plans", held.plans, next.plans, (entry) => entry.id, (entry) => entry.id);

  const nextCards = new Map(next.priceCards.map((card) => [card.id, card]));
  for (const [index, card] of held.priceCards.entries()) {
    const successor = nextCards.get(card.id);
    if (successor === undefined
        || await catalogCardDigest(card, digest) !== await catalogCardDigest(successor, digest)) {
      fail("CATALOG_NOT_APPEND_ONLY", `priceCards[${index}]`);
    }
  }
  held.retractions.forEach((entry, index) => {
    if (!sameJson(entry, next.retractions[index])) fail("CATALOG_NOT_APPEND_ONLY", `retractions[${index}]`);
  });
  next.retractions.slice(held.retractions.length).forEach((entry, offset) => {
    if (entry.inVersion !== next.version) {
      fail("CATALOG_NOT_APPEND_ONLY", `retractions[${held.retractions.length + offset}]`);
    }
  });
}

// ---------------------------------------------------------------------------
// Envelope (catalog-envelope-v1)
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = Object.freeze(["format", "keyId", "payload", "signature"]);
const BASE64URL = /^[A-Za-z0-9_-]*$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function bytesToBinary(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return binary;
}

export function encodeBase64(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes));
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Canonical standard base64 only (re-encoding must reproduce the input). */
export function decodeBase64(value: string): Uint8Array | null {
  if (!BASE64.test(value)) return null;
  const bytes = binaryToBytes(atob(value));
  return encodeBase64(bytes) === value ? bytes : null;
}

/** Canonical unpadded base64url only. */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  let bytes: Uint8Array;
  try {
    bytes = binaryToBytes(atob(padded));
  } catch {
    return null;
  }
  return encodeBase64Url(bytes) === value ? bytes : null;
}

export function catalogSignedMessage(payloadBytes: Uint8Array): Uint8Array {
  const prefix = encoder.encode(CATALOG_SIGNATURE_DOMAIN);
  const message = new Uint8Array(prefix.byteLength + payloadBytes.byteLength);
  message.set(prefix, 0);
  message.set(payloadBytes, prefix.byteLength);
  return message;
}

export interface ParsedCatalogEnvelope {
  keyId: string;
  payloadBytes: Uint8Array;
  payloadText: string;
  signature: Uint8Array;
}

/** Parse the closed envelope. Never parses the payload JSON. */
export function parseCatalogEnvelope(envelopeText: string): ParsedCatalogEnvelope {
  if (typeof envelopeText !== "string") fail("CATALOG_ENVELOPE_INVALID");
  if (encoder.encode(envelopeText).byteLength > CATALOG_MAX_ENVELOPE_BYTES) fail("CATALOG_ENVELOPE_TOO_LARGE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelopeText);
  } catch {
    return fail("CATALOG_ENVELOPE_INVALID");
  }
  if (!isRecord(parsed) || JSON.stringify(parsed) !== envelopeText) fail("CATALOG_ENVELOPE_INVALID");
  const keys = Object.keys(parsed);
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((key, index) => key !== ENVELOPE_KEYS[index])) {
    fail("CATALOG_ENVELOPE_INVALID");
  }
  if (parsed.format !== CATALOG_ENVELOPE_FORMAT) fail("CATALOG_ENVELOPE_INVALID", "format");
  if (typeof parsed.keyId !== "string" || !KEY_ID.test(parsed.keyId)) fail("CATALOG_ENVELOPE_INVALID", "keyId");
  const payloadBytes = typeof parsed.payload === "string" ? decodeBase64Url(parsed.payload) : null;
  if (payloadBytes === null || payloadBytes.byteLength === 0) fail("CATALOG_ENVELOPE_INVALID", "payload");
  if (payloadBytes.byteLength > CATALOG_MAX_PAYLOAD_BYTES) fail("CATALOG_PAYLOAD_TOO_LARGE");
  const signature = typeof parsed.signature === "string" ? decodeBase64Url(parsed.signature) : null;
  if (signature === null || signature.byteLength !== 64) fail("CATALOG_ENVELOPE_INVALID", "signature");
  let payloadText: string;
  try {
    payloadText = strictDecoder.decode(payloadBytes);
  } catch {
    return fail("CATALOG_PAYLOAD_NOT_CANONICAL");
  }
  return { keyId: parsed.keyId, payloadBytes, payloadText, signature };
}

export function encodeCatalogEnvelope({ keyId, payloadText, signature }: {
  keyId: string;
  payloadText: string;
  signature: Uint8Array;
}): string {
  if (!KEY_ID.test(keyId)) fail("CATALOG_ENVELOPE_INVALID", "keyId");
  if (signature.byteLength !== 64) fail("CATALOG_ENVELOPE_INVALID", "signature");
  return JSON.stringify({
    format: CATALOG_ENVELOPE_FORMAT,
    keyId,
    payload: encodeBase64Url(encoder.encode(payloadText)),
    signature: encodeBase64Url(signature),
  });
}

function trustedKeyBytes(trustedKeys: readonly CatalogTrustedKey[], keyId: string): Uint8Array {
  if (!Array.isArray(trustedKeys)) fail("CATALOG_TRUSTED_KEYS_INVALID");
  const ids = new Set<string>();
  let found: Uint8Array | null = null;
  for (const entry of trustedKeys) {
    if (!isRecord(entry) || typeof entry.keyId !== "string" || !KEY_ID.test(entry.keyId)
        || ids.has(entry.keyId) || typeof entry.publicKey !== "string") {
      fail("CATALOG_TRUSTED_KEYS_INVALID");
    }
    ids.add(entry.keyId);
    const bytes = decodeBase64(entry.publicKey);
    if (bytes === null || bytes.byteLength !== 32) fail("CATALOG_TRUSTED_KEYS_INVALID");
    if (entry.keyId === keyId) found = bytes;
  }
  if (found === null) fail("CATALOG_KEY_UNTRUSTED", "keyId");
  return found;
}

/**
 * Verify an envelope completely, in this order: envelope shape and size, a
 * pinned key for its key id, the Ed25519 signature over the domain-prefixed
 * exact payload bytes, canonical payload JSON, the closed schema, and the
 * registry SHA reproduction. Nothing is parsed before the signature passes.
 */
export async function verifyCatalogEnvelope(envelopeText: string, {
  trustedKeys,
  digest = webCryptoSha256Hex,
  verifySignature = webCryptoVerifyEd25519,
}: {
  trustedKeys: readonly CatalogTrustedKey[];
  digest?: CatalogDigest;
  verifySignature?: CatalogSignatureVerifier;
}): Promise<VerifiedCatalogManifest> {
  const envelope = parseCatalogEnvelope(envelopeText);
  const publicKey = trustedKeyBytes(trustedKeys, envelope.keyId);
  let verified = false;
  try {
    verified = await verifySignature({
      publicKey,
      message: catalogSignedMessage(envelope.payloadBytes),
      signature: envelope.signature,
    }) === true;
  } catch {
    verified = false;
  }
  if (!verified) fail("CATALOG_SIGNATURE_INVALID");
  const manifest = await validateCatalogManifest(parseCanonicalCatalogPayload(envelope.payloadText), digest);
  return Object.freeze({
    manifest,
    payloadText: envelope.payloadText,
    digest: await digest(envelope.payloadText),
    keyId: envelope.keyId,
    version: manifest.version,
  });
}

// ---------------------------------------------------------------------------
// WebCrypto adapters (Node 22+, Workers)
// ---------------------------------------------------------------------------

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function webCryptoSha256Hex(textValue: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(textValue)));
}

export async function webCryptoVerifyEd25519({ publicKey, message, signature }: {
  publicKey: Uint8Array;
  message: Uint8Array;
  signature: Uint8Array;
}): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
}

/**
 * Sign canonical payload text with a PKCS#8 Ed25519 private key. Used by the
 * build-and-sign step and by tests with synthetic keys; the key bytes are
 * never retained or logged. Returns the envelope and the raw public key, so
 * the caller can check it against the pin before publishing.
 */
export async function signCatalogPayload({ payloadText, keyId, privateKeyPkcs8 }: {
  payloadText: string;
  keyId: string;
  privateKeyPkcs8: Uint8Array;
}): Promise<{ envelopeText: string; publicKey: string }> {
  parseCanonicalCatalogPayload(payloadText);
  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey("pkcs8", privateKeyPkcs8, { name: "Ed25519" }, true, ["sign"]);
  } catch {
    return fail("CATALOG_SIGNING_KEY_INVALID");
  }
  const jwk = await crypto.subtle.exportKey("jwk", privateKey) as JsonWebKey;
  const publicKey = typeof jwk.x === "string" ? decodeBase64Url(jwk.x) : null;
  if (publicKey === null || publicKey.byteLength !== 32) fail("CATALOG_SIGNING_KEY_INVALID");
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey,
    catalogSignedMessage(encoder.encode(payloadText))));
  return {
    envelopeText: encodeCatalogEnvelope({ keyId, payloadText, signature }),
    publicKey: encodeBase64(publicKey),
  };
}

// ---------------------------------------------------------------------------
// Baseline projection (version 1 = the compiled registry at d43c8f92)
// ---------------------------------------------------------------------------

/** The compiled inputs a projection reads; the caller supplies the modules. */
export interface CompiledCatalogInputs {
  priceCards: readonly PriceCard[];
  registryVersion: string;
  registrySha256: string;
  registryObservedAt: string;
  modelCatalog: readonly Readonly<Omit<CatalogModel, "hidden">>[];
  modelCatalogVersion: string;
  planTypes: readonly string[];
  planDisplayNames: Readonly<Record<string, string>>;
  fastModeAssumedMultiplier: number;
}

export interface CatalogRelease {
  version: number;
  previousVersion: number | null;
  previousDigest: string | null;
  publishedAt: string;
  activateAt: string;
  projectedFromCommit: string | null;
}

/** The production commit Cloudflare runs, and the parity basis of the GCP line. */
export const CATALOG_BASELINE_SOURCE_COMMIT = "d43c8f92a059d9c577776f7eca8a331eb305b8a6" as const;

/**
 * Version 1. Its publication and activation instants are the compiled
 * registry's own observation instant (APP_PRICE_REGISTRY_OBSERVED_AT at
 * d43c8f92), so the baseline is active for every event the compiled
 * registry already prices and the projection is deterministic.
 */
export const CATALOG_BASELINE_RELEASE: Readonly<CatalogRelease> = Object.freeze({
  version: 1,
  previousVersion: null,
  previousDigest: null,
  publishedAt: "2026-09-23T14:52:10Z",
  activateAt: "2026-09-23T14:52:10Z",
  projectedFromCommit: CATALOG_BASELINE_SOURCE_COMMIT,
});

/**
 * The digest of the canonical version-1 payload: the d43c8f92 projection,
 * byte for byte (apps/worker/catalog/manifest-0001.json). The loader accepts
 * no other version 1, and the compiled fallback is labelled version 1 only
 * while this build's compiled registry still projects to exactly this digest
 * (test/catalog-manifest.spec.ts). Re-vendoring at a later production commit
 * re-projects as a SUCCESSOR version; it never rewrites this one.
 */
export const CATALOG_BASELINE_DIGEST = "da55288b83bbc6d012a3c087dc82db05000dfaa9c4570e73c0a74d279deec941" as const;

/**
 * How the compiled server pricing treats each provider and speed
 * (server-pricing.ts tierForEvent and priceTelemetryUsageEvent at d43c8f92).
 * The manifest states them; it does not change them. Unknown and `other`
 * subscription speeds are priced as Standard (owner decision K-DECIDE).
 */
export const CATALOG_COMPILED_PROVIDERS: readonly CatalogProvider[] = Object.freeze([
  Object.freeze({ id: "openai_codex", priceProvider: "openai", surface: "openai.responses" }),
  Object.freeze({ id: "anthropic_claude_code", priceProvider: "anthropic", surface: "anthropic.messages" }),
]);
export const CATALOG_COMPILED_SPEEDS: readonly CatalogSpeed[] = Object.freeze([
  Object.freeze({ billingSurface: "chatgpt_subscription", token: "standard", rule: "standard_counterfactual" }),
  Object.freeze({ billingSurface: "chatgpt_subscription", token: "fast", rule: "priority_ratio" }),
  Object.freeze({ billingSurface: "chatgpt_subscription", token: "unknown", rule: "standard_counterfactual" }),
  Object.freeze({ billingSurface: "chatgpt_subscription", token: "other", rule: "standard_counterfactual" }),
  Object.freeze({ billingSurface: "claude_subscription", token: "standard", rule: "standard_counterfactual" }),
  Object.freeze({ billingSurface: "claude_subscription", token: "fast", rule: "standard_counterfactual" }),
  Object.freeze({ billingSurface: "claude_subscription", token: "unknown", rule: "standard_counterfactual" }),
  Object.freeze({ billingSurface: "claude_subscription", token: "other", rule: "standard_counterfactual" }),
] as CatalogSpeed[]);

/**
 * Project compiled code into a manifest. Price cards are taken by reference
 * in their exact order and key order; nothing is re-derived, so the canonical
 * bytes of the cards equal JSON.stringify of the compiled registry.
 */
export function projectCatalogManifest(compiled: CompiledCatalogInputs, release: CatalogRelease): CatalogManifest {
  const tiers: CatalogTier[] = [];
  const seenTiers = new Set<string>();
  for (const card of compiled.priceCards) {
    const key = `${card.provider}\u0000${card.service_tier}`;
    if (!seenTiers.has(key)) {
      seenTiers.add(key);
      tiers.push({ priceProvider: card.provider, token: card.service_tier });
    }
  }
  return {
    schemaVersion: CATALOG_MANIFEST_SCHEMA_VERSION,
    version: release.version,
    previousVersion: release.previousVersion,
    previousDigest: release.previousDigest,
    publishedAt: release.publishedAt,
    activateAt: release.activateAt,
    projectedFromCommit: release.projectedFromCommit,
    compat: {
      registryVersion: compiled.registryVersion,
      registryObservedAt: compiled.registryObservedAt,
      registrySha256: compiled.registrySha256,
      catalogVersion: compiled.modelCatalogVersion,
    },
    normalization: { ...NORMALIZATION } as CatalogManifest["normalization"],
    assertions: { fastModeAssumedMultiplier: String(compiled.fastModeAssumedMultiplier) },
    providers: CATALOG_COMPILED_PROVIDERS.map((entry) => ({ ...entry })),
    models: compiled.modelCatalog.map((entry) => ({
      id: entry.id,
      label: entry.label,
      provider: entry.provider,
      allowanceTrack: entry.allowanceTrack,
      pricingStatus: entry.pricingStatus,
      priceModelId: entry.priceModelId,
      hidden: false,
    })),
    priceCards: [...compiled.priceCards],
    retractions: [],
    speeds: CATALOG_COMPILED_SPEEDS.map((entry) => ({ ...entry })),
    tiers,
    plans: compiled.planTypes.map((id) => ({
      id,
      label: Object.hasOwn(compiled.planDisplayNames, id) ? compiled.planDisplayNames[id]! : null,
    })),
  };
}

/**
 * The compiled assertions a consumer checks before trusting a manifest: the
 * manifest may never widen the compiled plan roster (the v1.x wire is
 * closed), and every constant in `assertions` must equal the compiled value.
 */
export function assertCatalogCompiledAssertions(manifest: CatalogManifest, compiled: {
  planTypes: readonly string[];
  fastModeAssumedMultiplier: number;
}): void {
  const roster = new Set(compiled.planTypes);
  manifest.plans.forEach((plan, index) => {
    if (!roster.has(plan.id)) fail("CATALOG_SCHEMA_INVALID", `plans[${index}].id`);
  });
  if (manifest.assertions.fastModeAssumedMultiplier !== String(compiled.fastModeAssumedMultiplier)) {
    fail("CATALOG_SCHEMA_INVALID", "assertions.fastModeAssumedMultiplier");
  }
}
