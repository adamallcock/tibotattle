/**
 * Server catalog store (KM-3): loader, pin and read APIs over the staged
 * primary migration `*_catalog_manifest_store.sql`.
 *
 * LOADER. loadCatalogManifestInTransaction verifies BEFORE it inserts:
 *   1. the envelope signature against the code-pinned keys the composition
 *      root passes (src/catalog-manifest-keys.ts), the closed schema, the
 *      canonical payload bytes and the registry SHA reproduction;
 *   2. the compiled assertions (no plan outside the compiled roster, the
 *      assumed Fast multiplier equal to the compiled one);
 *   3. under a table lock, append-only continuity against the held head,
 *      which is itself re-verified (the database is never trusted): version 1
 *      first and equal to the compiled baseline projection, then exactly the
 *      held version plus one, naming the held digest, carrying every earlier
 *      card, model, plan, speed, tier and retraction.
 * Reloading an identical manifest is a no-op; a different manifest for a
 * loaded version is refused. The migration enforces the chain and
 * immutability again with triggers.
 *
 * READ APIs. Both re-verify the stored envelope on every read and refuse a
 * tampered row (CATALOG_STORE_TAMPERED) rather than fall back silently.
 *   - readCatalogPricingRegistry: the price cards and registry identity for
 *     the pinned version (intake pricing). With no catalog table, no loaded
 *     manifest or none active yet, it returns the compiled d43c8f92 baseline,
 *     stamped manifest version 1.
 *   - readCatalogForAnalytics: what an analytics run stamps and binds. At
 *     cutover the kernels stay on the compiled registry (owner decision round
 *     7), so the default binding `compiled_registry` stamps manifest version 1
 *     and binds nothing, while still reporting the table version; a `frozen`
 *     pin on any other version refuses. The `manifest` binding (the first
 *     post-cutover change, KM-4) stamps and returns the pinned manifest.
 *
 * Every table is schema-qualified: origin pools set no search_path.
 */

import {
  APP_OFFICIAL_PRICE_CARDS,
  APP_PRICE_REGISTRY_MANIFEST,
  FAST_MODE_ASSUMED_MULTIPLIER,
} from "@app-usagemonitor/accounting";
import {
  REVIEWED_MODEL_CATALOG,
  REVIEWED_MODEL_CATALOG_VERSION,
  TELEMETRY_PLAN_DISPLAY_NAMES,
  TELEMETRY_PLAN_TYPES,
} from "@app-usagemonitor/telemetry-contract";
import {
  CATALOG_BASELINE_DIGEST,
  CATALOG_BASELINE_RELEASE,
  CatalogManifestError,
  activeCatalogPriceCards,
  assertCatalogCompiledAssertions,
  assertCatalogManifestSuccessor,
  canonicalCatalogPayloadText,
  catalogCardDigest,
  projectCatalogManifest,
  verifyCatalogEnvelope,
  webCryptoSha256Hex,
  type CatalogDigest,
  type CatalogManifest,
  type CatalogTrustedKey,
  type CompiledCatalogInputs,
  type PriceCard,
  type VerifiedCatalogManifest,
} from "./catalog-manifest";
import {
  quotePostgresIdentifier,
  withPostgresRead,
  withPostgresTransaction,
  type PostgresClient,
  type PostgresPool,
} from "./postgres-client";

export const CATALOG_STORE_TABLES = Object.freeze({
  manifests: "catalog_manifests",
  cards: "catalog_cards",
  retractions: "catalog_card_retractions",
  pinEvents: "catalog_pin_events",
} as const);

export const CATALOG_PIN_MODES = Object.freeze(["latest_verified", "pinned", "frozen"] as const);
export type CatalogPinMode = (typeof CATALOG_PIN_MODES)[number];
export const CATALOG_PIN_REASONS = Object.freeze(["advance", "rollback", "staging", "freeze", "release"] as const);
export type CatalogPinReason = (typeof CATALOG_PIN_REASONS)[number];

export const CATALOG_STORE_ERROR_CODES = Object.freeze([
  "CATALOG_STORE_ARGUMENT_INVALID",
  "CATALOG_STORE_UNAVAILABLE",
  "CATALOG_STORE_TAMPERED",
  "CATALOG_BASELINE_MISMATCH",
  "CATALOG_VERSION_CONFLICT",
  "CATALOG_PIN_VERSION_UNKNOWN",
  "CATALOG_PIN_NOT_ACTIVE",
  "CATALOG_FROZEN_PIN_MISMATCH",
] as const);
export type CatalogStoreErrorCode = (typeof CATALOG_STORE_ERROR_CODES)[number];

export class CatalogStoreError extends Error {
  readonly code: CatalogStoreErrorCode;

  constructor(code: CatalogStoreErrorCode) {
    super(code);
    this.name = "CatalogStoreError";
    this.code = code;
  }
}

function storeError(code: CatalogStoreErrorCode): never {
  throw new CatalogStoreError(code);
}

const STATEMENT_TIMEOUT_MILLISECONDS = 30_000;
const LOCK_TIMEOUT_MILLISECONDS = 5_000;

// ---------------------------------------------------------------------------
// The compiled baseline
// ---------------------------------------------------------------------------

/**
 * The compiled inputs of this build: the Worker's installed workspace
 * packages, which the GCP line holds at the d43c8f92 bytes (the same bytes
 * the vendored kernels carry; test/catalog-manifest.spec.ts proves both
 * project to the committed baseline).
 */
export const COMPILED_CATALOG_INPUTS: Readonly<CompiledCatalogInputs> = Object.freeze({
  priceCards: APP_OFFICIAL_PRICE_CARDS as unknown as readonly PriceCard[],
  registryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
  registrySha256: APP_PRICE_REGISTRY_MANIFEST.sha256,
  registryObservedAt: APP_PRICE_REGISTRY_MANIFEST.observedAt,
  modelCatalog: REVIEWED_MODEL_CATALOG as unknown as CompiledCatalogInputs["modelCatalog"],
  modelCatalogVersion: REVIEWED_MODEL_CATALOG_VERSION,
  planTypes: TELEMETRY_PLAN_TYPES,
  planDisplayNames: TELEMETRY_PLAN_DISPLAY_NAMES as Readonly<Record<string, string>>,
  fastModeAssumedMultiplier: FAST_MODE_ASSUMED_MULTIPLIER,
});

/** Manifest version 1: the compiled baseline projection. */
export function compiledBaselineCatalogManifest(): CatalogManifest {
  return projectCatalogManifest(COMPILED_CATALOG_INPUTS, CATALOG_BASELINE_RELEASE);
}

/** sha256 of this build's compiled projection; equal to CATALOG_BASELINE_DIGEST at d43c8f92. */
export async function compiledBaselineDigest(): Promise<string> {
  return webCryptoSha256Hex(canonicalCatalogPayloadText(compiledBaselineCatalogManifest()));
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

function tables(schema: string) {
  let quoted: string;
  try {
    quoted = quotePostgresIdentifier(schema);
  } catch {
    return storeError("CATALOG_STORE_ARGUMENT_INVALID");
  }
  return {
    manifests: `${quoted}.${CATALOG_STORE_TABLES.manifests}`,
    cards: `${quoted}.${CATALOG_STORE_TABLES.cards}`,
    retractions: `${quoted}.${CATALOG_STORE_TABLES.retractions}`,
    pinEvents: `${quoted}.${CATALOG_STORE_TABLES.pinEvents}`,
    regclass: `${quoted}.${CATALOG_STORE_TABLES.manifests}`,
  };
}

function assertClient(client: unknown): asserts client is PostgresClient {
  if (client === null || typeof client !== "object" || typeof (client as PostgresClient).query !== "function") {
    storeError("CATALOG_STORE_ARGUMENT_INVALID");
  }
}

function assertNow(nowMs: unknown): asserts nowMs is number {
  if (typeof nowMs !== "number" || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    storeError("CATALOG_STORE_ARGUMENT_INVALID");
  }
}

interface ManifestRow {
  version: number;
  digest: string;
  key_id: string;
  envelope_text: string;
  activate_at: Date | string;
}

const MANIFEST_COLUMNS = "version, digest, key_id, envelope_text, activate_at";

/** Re-verify a stored row; any disagreement is tampering, never a fallback. */
async function verifyStoredRow(
  row: ManifestRow,
  trustedKeys: readonly CatalogTrustedKey[],
  digest: CatalogDigest,
): Promise<VerifiedCatalogManifest> {
  let verified: VerifiedCatalogManifest;
  try {
    verified = await verifyCatalogEnvelope(row.envelope_text, { trustedKeys, digest });
  } catch {
    return storeError("CATALOG_STORE_TAMPERED");
  }
  if (verified.version !== Number(row.version) || verified.digest !== row.digest || verified.keyId !== row.key_id) {
    storeError("CATALOG_STORE_TAMPERED");
  }
  return verified;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface CatalogLoadReceipt {
  status: "loaded" | "already_loaded";
  version: number;
  digest: string;
  keyId: string;
  cardsAdded: number;
  retractionsAdded: number;
}

/**
 * Verify and insert one envelope inside the caller's transaction. Refusals
 * are CatalogManifestError (signature, schema, grammar, continuity) or
 * CatalogStoreError (baseline, conflict); nothing is inserted on refusal.
 */
export async function loadCatalogManifestInTransaction({
  client,
  schema,
  envelopeText,
  trustedKeys,
  digest = webCryptoSha256Hex,
}: {
  client: PostgresClient;
  schema: string;
  envelopeText: string;
  trustedKeys: readonly CatalogTrustedKey[];
  digest?: CatalogDigest;
}): Promise<CatalogLoadReceipt> {
  assertClient(client);
  const sql = tables(schema);
  const candidate = await verifyCatalogEnvelope(envelopeText, { trustedKeys, digest });
  assertCatalogCompiledAssertions(candidate.manifest, COMPILED_CATALOG_INPUTS);

  await client.query(`LOCK TABLE ${sql.manifests} IN SHARE ROW EXCLUSIVE MODE`);
  const existing = await client.query<ManifestRow>(
    `SELECT ${MANIFEST_COLUMNS} FROM ${sql.manifests} WHERE version = $1`, [candidate.version]);
  const receiptFor = (status: CatalogLoadReceipt["status"], cardsAdded = 0, retractionsAdded = 0) => ({
    status, version: candidate.version, digest: candidate.digest, keyId: candidate.keyId, cardsAdded,
    retractionsAdded,
  });
  if (existing.rows.length === 1) {
    if (existing.rows[0]!.digest === candidate.digest) return receiptFor("already_loaded");
    return storeError("CATALOG_VERSION_CONFLICT");
  }
  const head = await client.query<ManifestRow>(
    `SELECT ${MANIFEST_COLUMNS} FROM ${sql.manifests} ORDER BY version DESC LIMIT 1`);
  if (head.rows.length === 0) {
    if (candidate.version !== 1) {
      throw new CatalogManifestError("CATALOG_VERSION_GAP", "version");
    }
    if (candidate.digest !== CATALOG_BASELINE_DIGEST) storeError("CATALOG_BASELINE_MISMATCH");
  } else {
    const held = await verifyStoredRow(head.rows[0]!, trustedKeys, digest);
    await assertCatalogManifestSuccessor({
      held: held.manifest, heldDigest: held.digest, next: candidate.manifest, digest,
    });
  }

  const manifest = candidate.manifest;
  await client.query(
    `INSERT INTO ${sql.manifests} (version, previous_version, previous_digest, digest, key_id, envelope_text,
       published_at, activate_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)`,
    [manifest.version, manifest.previousVersion, manifest.previousDigest, candidate.digest, candidate.keyId,
      envelopeText, manifest.publishedAt, manifest.activateAt],
  );

  const known = await client.query<{ card_id: string }>(`SELECT card_id FROM ${sql.cards}`);
  const knownIds = new Set(known.rows.map((row) => row.card_id));
  let cardsAdded = 0;
  for (const card of manifest.priceCards) {
    if (knownIds.has(card.id)) continue;
    await client.query(
      `INSERT INTO ${sql.cards} (card_id, card_digest, provider, model, service_tier, first_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [card.id, await catalogCardDigest(card, digest), card.provider, card.model, card.service_tier,
        manifest.version],
    );
    cardsAdded += 1;
  }
  let retractionsAdded = 0;
  for (const retraction of manifest.retractions) {
    if (retraction.inVersion !== manifest.version) continue;
    await client.query(
      `INSERT INTO ${sql.retractions} (card_no, retracted_in, reason)
       SELECT card_no, $2, $3 FROM ${sql.cards} WHERE card_id = $1`,
      [retraction.cardId, manifest.version, retraction.reason],
    );
    retractionsAdded += 1;
  }
  return receiptFor("loaded", cardsAdded, retractionsAdded);
}

function preserveCatalogError(error: unknown): Error | null {
  return error instanceof CatalogManifestError || error instanceof CatalogStoreError ? error : null;
}

/** loadCatalogManifestInTransaction in a bounded transaction of its own. */
export async function loadCatalogManifest(options: {
  pool: PostgresPool;
  schema: string;
  envelopeText: string;
  trustedKeys: readonly CatalogTrustedKey[];
  digest?: CatalogDigest;
}): Promise<CatalogLoadReceipt> {
  const { pool, ...rest } = options;
  tables(rest.schema);
  return withPostgresTransaction(pool, (client) => loadCatalogManifestInTransaction({ client, ...rest }), {
    operation: "catalog_manifest.load",
    statementTimeoutMilliseconds: STATEMENT_TIMEOUT_MILLISECONDS,
    lockTimeoutMilliseconds: LOCK_TIMEOUT_MILLISECONDS,
    preserveSafeError: preserveCatalogError,
  });
}

// ---------------------------------------------------------------------------
// Pin
// ---------------------------------------------------------------------------

export interface CatalogPin {
  mode: CatalogPinMode;
  version: number | null;
}

/** Append a pin event. pinned/frozen must name a loaded version. */
export async function setCatalogPin({ client, schema, mode, version, reason }: {
  client: PostgresClient;
  schema: string;
  mode: CatalogPinMode;
  version: number | null;
  reason: CatalogPinReason;
}): Promise<CatalogPin> {
  assertClient(client);
  const sql = tables(schema);
  if (!CATALOG_PIN_MODES.includes(mode) || !CATALOG_PIN_REASONS.includes(reason)
      || (mode === "latest_verified") !== (version === null)
      || (version !== null && (!Number.isSafeInteger(version) || version < 1))) {
    storeError("CATALOG_STORE_ARGUMENT_INVALID");
  }
  if (version !== null) {
    const loaded = await client.query(`SELECT 1 FROM ${sql.manifests} WHERE version = $1`, [version]);
    if (loaded.rows.length !== 1) storeError("CATALOG_PIN_VERSION_UNKNOWN");
  }
  await client.query(`INSERT INTO ${sql.pinEvents} (mode, version, reason) VALUES ($1, $2, $3)`,
    [mode, version, reason]);
  return { mode, version };
}

async function readPin(client: PostgresClient, sql: ReturnType<typeof tables>): Promise<CatalogPin> {
  const pin = await client.query<{ mode: CatalogPinMode; version: number | null }>(
    `SELECT mode, version FROM ${sql.pinEvents} ORDER BY event_no DESC LIMIT 1`);
  const row = pin.rows[0];
  return row === undefined ? { mode: "latest_verified", version: null } : { mode: row.mode, version: row.version };
}

interface ResolvedCatalog {
  pin: CatalogPin;
  verified: VerifiedCatalogManifest | null;
}

/** The pinned, active, re-verified manifest, or null when the compiled baseline applies. */
async function resolveCatalog({ client, schema, trustedKeys, nowMs, digest }: {
  client: PostgresClient;
  schema: string;
  trustedKeys: readonly CatalogTrustedKey[];
  nowMs: number;
  digest: CatalogDigest;
}): Promise<ResolvedCatalog> {
  assertClient(client);
  assertNow(nowMs);
  const sql = tables(schema);
  const present = await client.query<{ present: boolean }>(
    "SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present", [sql.regclass]);
  if (present.rows[0]?.present !== true) return { pin: { mode: "latest_verified", version: null }, verified: null };
  const pin = await readPin(client, sql);
  const now = new Date(nowMs).toISOString();
  let rows: readonly ManifestRow[];
  if (pin.mode === "latest_verified") {
    rows = (await client.query<ManifestRow>(
      `SELECT ${MANIFEST_COLUMNS} FROM ${sql.manifests} WHERE activate_at <= $1::timestamptz
       ORDER BY version DESC LIMIT 1`, [now])).rows;
  } else {
    rows = (await client.query<ManifestRow & { active: boolean }>(
      `SELECT ${MANIFEST_COLUMNS}, activate_at <= $2::timestamptz AS active FROM ${sql.manifests}
       WHERE version = $1`, [pin.version, now])).rows;
    if (rows.length !== 1) storeError("CATALOG_STORE_TAMPERED");
    if ((rows[0] as ManifestRow & { active: boolean }).active !== true) storeError("CATALOG_PIN_NOT_ACTIVE");
  }
  if (rows.length === 0) return { pin, verified: null };
  return { pin, verified: await verifyStoredRow(rows[0]!, trustedKeys, digest) };
}

// ---------------------------------------------------------------------------
// Read APIs
// ---------------------------------------------------------------------------

export interface CatalogPricingRegistry {
  source: "catalog_table" | "compiled_baseline";
  manifestVersion: number;
  manifestDigest: string | null;
  pin: CatalogPin;
  registryVersion: string;
  registrySha256: string;
  registryObservedAt: string;
  /** Active cards in manifest order: pass as `priceCards` to priceUsageEvent. */
  priceCards: readonly PriceCard[];
}

function compiledRegistry(pin: CatalogPin): CatalogPricingRegistry {
  return Object.freeze({
    source: "compiled_baseline",
    manifestVersion: CATALOG_BASELINE_RELEASE.version,
    manifestDigest: null,
    pin,
    registryVersion: COMPILED_CATALOG_INPUTS.registryVersion,
    registrySha256: COMPILED_CATALOG_INPUTS.registrySha256,
    registryObservedAt: COMPILED_CATALOG_INPUTS.registryObservedAt,
    priceCards: COMPILED_CATALOG_INPUTS.priceCards,
  });
}

/** Intake pricing: the pinned table version, or the compiled baseline. */
export async function readCatalogPricingRegistry({
  client, schema, trustedKeys, nowMs, digest = webCryptoSha256Hex,
}: {
  client: PostgresClient;
  schema: string;
  trustedKeys: readonly CatalogTrustedKey[];
  nowMs: number;
  digest?: CatalogDigest;
}): Promise<CatalogPricingRegistry> {
  const { pin, verified } = await resolveCatalog({ client, schema, trustedKeys, nowMs, digest });
  if (verified === null) return compiledRegistry(pin);
  const { manifest } = verified;
  return Object.freeze({
    source: "catalog_table",
    manifestVersion: manifest.version,
    manifestDigest: verified.digest,
    pin,
    registryVersion: manifest.compat.registryVersion,
    registrySha256: manifest.compat.registrySha256,
    registryObservedAt: manifest.compat.registryObservedAt,
    priceCards: Object.freeze(activeCatalogPriceCards(manifest)),
  });
}

export type CatalogKernelBinding = "compiled_registry" | "manifest";

export interface CatalogAnalyticsBinding {
  kernelBinding: CatalogKernelBinding;
  /** The manifest_version every run and derived row is stamped with. */
  stampManifestVersion: number;
  /** The manifest bound into the kernels; null while kernels use the compiled registry. */
  boundManifest: CatalogManifest | null;
  boundManifestDigest: string | null;
  /** What the table holds for the pin, reported even when not bound. */
  tableManifestVersion: number | null;
  tableManifestDigest: string | null;
  pin: CatalogPin;
}

/**
 * Analytics: the stamp and binding for one refresh run. `compiled_registry`
 * (the cutover default) stamps version 1, which is the compiled registry by
 * definition, and refuses a frozen pin on any other version so a frozen
 * deployment never runs on prices it was not frozen to.
 */
export async function readCatalogForAnalytics({
  client, schema, trustedKeys, nowMs, kernelBinding = "compiled_registry", digest = webCryptoSha256Hex,
}: {
  client: PostgresClient;
  schema: string;
  trustedKeys: readonly CatalogTrustedKey[];
  nowMs: number;
  kernelBinding?: CatalogKernelBinding;
  digest?: CatalogDigest;
}): Promise<CatalogAnalyticsBinding> {
  if (kernelBinding !== "compiled_registry" && kernelBinding !== "manifest") {
    storeError("CATALOG_STORE_ARGUMENT_INVALID");
  }
  const { pin, verified } = await resolveCatalog({ client, schema, trustedKeys, nowMs, digest });
  const table = {
    tableManifestVersion: verified?.version ?? null,
    tableManifestDigest: verified?.digest ?? null,
    pin,
  };
  if (kernelBinding === "compiled_registry") {
    if (pin.mode === "frozen" && pin.version !== CATALOG_BASELINE_RELEASE.version) {
      storeError("CATALOG_FROZEN_PIN_MISMATCH");
    }
    return Object.freeze({
      kernelBinding,
      stampManifestVersion: CATALOG_BASELINE_RELEASE.version,
      boundManifest: null,
      boundManifestDigest: null,
      ...table,
    });
  }
  if (verified === null) {
    return Object.freeze({
      kernelBinding,
      stampManifestVersion: CATALOG_BASELINE_RELEASE.version,
      boundManifest: compiledBaselineCatalogManifest(),
      boundManifestDigest: await compiledBaselineDigest(),
      ...table,
    });
  }
  return Object.freeze({
    kernelBinding,
    stampManifestVersion: verified.version,
    boundManifest: verified.manifest,
    boundManifestDigest: verified.digest,
    ...table,
  });
}

/** Pool variants: each read in its own bounded read-only transaction. */
export async function readCatalogPricingRegistryFromPool(options: {
  pool: PostgresPool;
  schema: string;
  trustedKeys: readonly CatalogTrustedKey[];
  nowMs: number;
}): Promise<CatalogPricingRegistry> {
  const { pool, ...rest } = options;
  tables(rest.schema);
  return withPostgresRead(pool, (client) => readCatalogPricingRegistry({ client, ...rest }), {
    operation: "catalog_manifest.read_pricing",
    statementTimeoutMilliseconds: STATEMENT_TIMEOUT_MILLISECONDS,
    lockTimeoutMilliseconds: LOCK_TIMEOUT_MILLISECONDS,
    preserveSafeError: preserveCatalogError,
  });
}

export async function readCatalogForAnalyticsFromPool(options: {
  pool: PostgresPool;
  schema: string;
  trustedKeys: readonly CatalogTrustedKey[];
  nowMs: number;
  kernelBinding?: CatalogKernelBinding;
}): Promise<CatalogAnalyticsBinding> {
  const { pool, ...rest } = options;
  tables(rest.schema);
  return withPostgresRead(pool, (client) => readCatalogForAnalytics({ client, ...rest }), {
    operation: "catalog_manifest.read_analytics",
    statementTimeoutMilliseconds: STATEMENT_TIMEOUT_MILLISECONDS,
    lockTimeoutMilliseconds: LOCK_TIMEOUT_MILLISECONDS,
    preserveSafeError: preserveCatalogError,
  });
}
