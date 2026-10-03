/**
 * Server catalog store (KM-3): loader, pin and read APIs over primary
 * migration `0070_catalog_manifest_store.sql`.
 *
 * LOADER. loadCatalogManifestInTransaction verifies BEFORE it inserts:
 *   1. the envelope signature against the code-pinned keys the composition
 *      root passes (src/catalog-manifest-keys.ts), the closed schema, the
 *      canonical payload bytes and the registry SHA reproduction;
 *   2. the compiled assertions (no plan outside the compiled roster, the
 *      assumed Fast multiplier equal to the compiled one);
 *   3. under a lock on the manifest, card and retraction tables, append-only
 *      continuity against the held head, which is itself re-verified (the
 *      database is never trusted): version 1 first and equal to the compiled
 *      baseline projection, then exactly the held version plus one, naming the
 *      held digest, never activating before it, carrying every earlier card,
 *      model, plan, speed, tier and retraction;
 *   4. under the same lock, that the derived vocabulary (catalog_cards and
 *      catalog_card_retractions) is exactly the projection of that verified
 *      head: the same card ids with the same digest, provider, model and
 *      service tier, first_version within the chain, and the same retractions.
 *      A row written outside the loader is CATALOG_STORE_TAMPERED, so the
 *      card_no vocabulary can never disagree with the signed chain.
 * Reloading an identical manifest is a no-op; a different manifest for a
 * loaded version is refused. The migration enforces the chain, activation
 * order, head-version vocabulary rows and immutability again with triggers.
 *
 * READ APIs. These are BOOTSTRAP reads, not request-path reads: every call
 * fetches the full stored envelope (about 0.6 MB for the baseline) and
 * re-runs Ed25519, the closed schema and the registry SHA (about 11 ms of CPU
 * measured locally). Call them once per analytics run, or once per pin
 * re-read interval in a long-running process that keeps the result in memory
 * (design §5.3: the origin re-reads the pin every 5 minutes); never per
 * request. A tampered row (CATALOG_STORE_TAMPERED) or a row whose key is no
 * longer pinned (CATALOG_STORE_KEY_UNTRUSTED) is refused, never silently
 * replaced, wherever table content is served or bound.
 *   - readCatalogPricingRegistry: the price cards and registry identity for
 *     the pinned version (intake pricing). With no catalog table, no loaded
 *     manifest or none active yet, it returns the compiled d43c8f92 baseline,
 *     stamped manifest version 1.
 *   - readCatalogForAnalytics: what an analytics run stamps and binds. At
 *     cutover the kernels stay on the compiled registry (owner decision round
 *     7), so the default binding `compiled_registry` stamps manifest version 1
 *     and binds nothing. It still refuses a `frozen` pin on any other version,
 *     but the table is report-only there: a table fault is returned as a
 *     content-free `tableFault` code instead of stopping a run that binds
 *     nothing from the table. The `manifest` binding (the first post-cutover
 *     change, KM-4) stamps and returns the pinned manifest and fails closed.
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
  "CATALOG_STORE_KEY_UNTRUSTED",
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

/**
 * Re-verify a stored row; any disagreement is tampering, never a fallback. A
 * row naming a key that is not pinned is reported separately
 * (CATALOG_STORE_KEY_UNTRUSTED) and refused the same way: usually a key
 * rotated out of the pins, though a row written outside the loader can name
 * any key, so the code never proves the row genuine.
 */
async function verifyStoredRow(
  row: ManifestRow,
  trustedKeys: readonly CatalogTrustedKey[],
  digest: CatalogDigest,
): Promise<VerifiedCatalogManifest> {
  let verified: VerifiedCatalogManifest;
  try {
    verified = await verifyCatalogEnvelope(row.envelope_text, { trustedKeys, digest });
  } catch (error) {
    if (error instanceof CatalogManifestError && error.code === "CATALOG_KEY_UNTRUSTED") {
      return storeError("CATALOG_STORE_KEY_UNTRUSTED");
    }
    // The caller's pinned-key list is malformed: a configuration error, not a table fault.
    if (error instanceof CatalogManifestError && error.code === "CATALOG_TRUSTED_KEYS_INVALID") {
      return storeError("CATALOG_STORE_ARGUMENT_INVALID");
    }
    return storeError("CATALOG_STORE_TAMPERED");
  }
  if (verified.version !== Number(row.version) || verified.digest !== row.digest || verified.keyId !== row.key_id) {
    storeError("CATALOG_STORE_TAMPERED");
  }
  return verified;
}

interface CardRow {
  card_no: number;
  card_id: string;
  card_digest: string;
  provider: string;
  model: string;
  service_tier: string;
  first_version: number;
}

interface RetractionRow {
  card_id: string;
  retracted_in: number;
  reason: string;
}

/**
 * The derived vocabulary must be exactly the projection of the verified head
 * (the database is never trusted, and the runtime role can INSERT):
 * - with no head, both tables are empty;
 * - otherwise catalog_cards holds exactly the head's card ids (every earlier
 *   card is carried, so the head names every card ever loaded), each with the
 *   head card's digest, provider, model and service tier, and a first_version
 *   inside the chain (1 to the head version) that never decreases in card_no
 *   order, which is load order;
 * - catalog_card_retractions holds exactly the head's retractions, each with
 *   its retracted_in version and reason.
 * Any other row is CATALOG_STORE_TAMPERED. Run at every load under the
 * loader's lock, this keeps first_version exact by induction: a row can only
 * be written under the head version (the migration's trigger), and a row
 * written outside the loader is extra at the next load.
 * Returns the known card ids.
 */
async function assertVocabularyIsHeadProjection(
  client: PostgresClient,
  sql: ReturnType<typeof tables>,
  held: VerifiedCatalogManifest | null,
  digest: CatalogDigest,
): Promise<Set<string>> {
  const cards = await client.query<CardRow>(
    `SELECT card_no, card_id, card_digest, provider, model, service_tier, first_version
     FROM ${sql.cards} ORDER BY card_no`);
  const retractions = await client.query<RetractionRow>(
    `SELECT card.card_id, retraction.retracted_in, retraction.reason
     FROM ${sql.retractions} AS retraction JOIN ${sql.cards} AS card USING (card_no)`);
  const retractionCount = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM ${sql.retractions}`);
  if (held === null) {
    if (cards.rows.length !== 0 || Number(retractionCount.rows[0]?.count) !== 0) storeError("CATALOG_STORE_TAMPERED");
    return new Set();
  }
  const { manifest } = held;
  if (cards.rows.length !== manifest.priceCards.length) storeError("CATALOG_STORE_TAMPERED");
  const headCards = new Map(manifest.priceCards.map((card) => [card.id, card]));
  let previousFirstVersion = 1;
  for (const row of cards.rows) {
    const card = headCards.get(row.card_id);
    const firstVersion = Number(row.first_version);
    if (card === undefined
        || row.card_digest !== await catalogCardDigest(card, digest)
        || row.provider !== card.provider
        || row.model !== card.model
        || row.service_tier !== card.service_tier
        || !Number.isSafeInteger(firstVersion)
        || firstVersion < previousFirstVersion
        || firstVersion > held.version) {
      storeError("CATALOG_STORE_TAMPERED");
    }
    previousFirstVersion = firstVersion;
  }
  // card_id is UNIQUE and the counts match, so the id sets are equal.
  const headRetractions = new Map(manifest.retractions.map((entry) => [entry.cardId, entry]));
  if (Number(retractionCount.rows[0]?.count) !== manifest.retractions.length
      || retractions.rows.length !== manifest.retractions.length) {
    storeError("CATALOG_STORE_TAMPERED");
  }
  for (const row of retractions.rows) {
    const entry = headRetractions.get(row.card_id);
    if (entry === undefined || Number(row.retracted_in) !== entry.inVersion || row.reason !== entry.reason) {
      storeError("CATALOG_STORE_TAMPERED");
    }
  }
  return new Set(headCards.keys());
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

  // One lock over the chain and its derived vocabulary: SHARE ROW EXCLUSIVE
  // conflicts with every INSERT, so no row can appear between the checks
  // below and the appends.
  await client.query(
    `LOCK TABLE ${sql.manifests}, ${sql.cards}, ${sql.retractions} IN SHARE ROW EXCLUSIVE MODE`);
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
  let held: VerifiedCatalogManifest | null = null;
  if (head.rows.length === 0) {
    if (candidate.version !== 1) {
      throw new CatalogManifestError("CATALOG_VERSION_GAP", "version");
    }
    if (candidate.digest !== CATALOG_BASELINE_DIGEST) storeError("CATALOG_BASELINE_MISMATCH");
  } else {
    held = await verifyStoredRow(head.rows[0]!, trustedKeys, digest);
    await assertCatalogManifestSuccessor({
      held: held.manifest, heldDigest: held.digest, next: candidate.manifest, digest,
    });
  }
  const knownIds = await assertVocabularyIsHeadProjection(client, sql, held, digest);

  const manifest = candidate.manifest;
  await client.query(
    `INSERT INTO ${sql.manifests} (version, previous_version, previous_digest, digest, key_id, envelope_text,
       published_at, activate_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)`,
    [manifest.version, manifest.previousVersion, manifest.previousDigest, candidate.digest, candidate.keyId,
      envelopeText, manifest.publishedAt, manifest.activateAt],
  );

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
    const inserted = await client.query(
      `INSERT INTO ${sql.retractions} (card_no, retracted_in, reason)
       SELECT card_no, $2, $3 FROM ${sql.cards} WHERE card_id = $1`,
      [retraction.cardId, manifest.version, retraction.reason],
    );
    // The validator guarantees the card is in the manifest, and the vocabulary
    // check and the inserts above guarantee its row: anything else is a fault.
    if (inserted.rowCount !== 1) storeError("CATALOG_STORE_TAMPERED");
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

/** The current pin; before the migration (no table) the pin is latest_verified and `sql` is null. */
async function readStorePin({ client, schema, nowMs }: {
  client: PostgresClient;
  schema: string;
  nowMs: number;
}): Promise<{ sql: ReturnType<typeof tables> | null; pin: CatalogPin }> {
  assertClient(client);
  assertNow(nowMs);
  const sql = tables(schema);
  const present = await client.query<{ present: boolean }>(
    "SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present", [sql.regclass]);
  if (present.rows[0]?.present !== true) return { sql: null, pin: { mode: "latest_verified", version: null } };
  return { sql, pin: await readPin(client, sql) };
}

/** The pinned, active, re-verified manifest, or null when the compiled baseline applies. */
async function resolveCatalog({ client, schema, trustedKeys, nowMs, digest }: {
  client: PostgresClient;
  schema: string;
  trustedKeys: readonly CatalogTrustedKey[];
  nowMs: number;
  digest: CatalogDigest;
}): Promise<ResolvedCatalog> {
  const { sql, pin } = await readStorePin({ client, schema, nowMs });
  if (sql === null) return { pin, verified: null };
  return { pin, verified: await resolvePinnedManifest({ client, sql, pin, trustedKeys, nowMs, digest }) };
}

async function resolvePinnedManifest({ client, sql, pin, trustedKeys, nowMs, digest }: {
  client: PostgresClient;
  sql: ReturnType<typeof tables>;
  pin: CatalogPin;
  trustedKeys: readonly CatalogTrustedKey[];
  nowMs: number;
  digest: CatalogDigest;
}): Promise<VerifiedCatalogManifest | null> {
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
  if (rows.length === 0) return null;
  return verifyStoredRow(rows[0]!, trustedKeys, digest);
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

/**
 * Intake pricing: the pinned table version, or the compiled baseline. A
 * bootstrap read (see the module header): it re-verifies the full envelope on
 * every call, so a request path must hold the result in memory and re-read
 * only per pin interval, never per request. Fails closed on a table fault.
 */
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

/**
 * Table faults the `compiled_registry` binding reports instead of throwing:
 * nothing from the table is bound there, so they must not stop the run.
 */
export const CATALOG_TABLE_FAULTS = Object.freeze([
  "CATALOG_STORE_TAMPERED",
  "CATALOG_STORE_KEY_UNTRUSTED",
  "CATALOG_PIN_NOT_ACTIVE",
] as const);
export type CatalogTableFault = (typeof CATALOG_TABLE_FAULTS)[number];

function isCatalogTableFault(error: unknown): error is CatalogStoreError & { code: CatalogTableFault } {
  return error instanceof CatalogStoreError && (CATALOG_TABLE_FAULTS as readonly string[]).includes(error.code);
}

export interface CatalogAnalyticsBinding {
  kernelBinding: CatalogKernelBinding;
  /** The manifest_version every run and derived row is stamped with. */
  stampManifestVersion: number;
  /** The manifest bound into the kernels; null while kernels use the compiled registry. */
  boundManifest: CatalogManifest | null;
  boundManifestDigest: string | null;
  /** What the table holds for the pin, reported even when not bound; null on a table fault. */
  tableManifestVersion: number | null;
  tableManifestDigest: string | null;
  /**
   * A content-free code when the table could not be resolved for the pin.
   * Only the `compiled_registry` binding reports one; the `manifest` binding
   * throws instead, because it would bind that table content.
   */
  tableFault: CatalogTableFault | null;
  pin: CatalogPin;
}

/**
 * Analytics: the stamp and binding for one refresh run.
 *
 * `compiled_registry` (the cutover default, owner decision round 7) stamps
 * version 1, which is the compiled registry by definition, and refuses a
 * frozen pin on any other version so a frozen deployment never runs on prices
 * it was not frozen to. The table is otherwise report-only: a tampered row, a
 * row whose key is no longer pinned or a pin on a version not yet active is
 * returned as `tableFault` (with null table fields) instead of stopping a run
 * that binds nothing from the table. Database errors and invalid arguments
 * still throw.
 *
 * `manifest` (KM-4, post-cutover) binds the pinned manifest and fails closed
 * on every fault.
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
  if (kernelBinding === "compiled_registry") {
    const { sql, pin } = await readStorePin({ client, schema, nowMs });
    if (pin.mode === "frozen" && pin.version !== CATALOG_BASELINE_RELEASE.version) {
      storeError("CATALOG_FROZEN_PIN_MISMATCH");
    }
    let verified: VerifiedCatalogManifest | null = null;
    let tableFault: CatalogTableFault | null = null;
    if (sql !== null) {
      try {
        verified = await resolvePinnedManifest({ client, sql, pin, trustedKeys, nowMs, digest });
      } catch (error) {
        if (!isCatalogTableFault(error)) throw error;
        tableFault = error.code;
      }
    }
    return Object.freeze({
      kernelBinding,
      stampManifestVersion: CATALOG_BASELINE_RELEASE.version,
      boundManifest: null,
      boundManifestDigest: null,
      tableManifestVersion: verified?.version ?? null,
      tableManifestDigest: verified?.digest ?? null,
      tableFault,
      pin,
    });
  }
  const { pin, verified } = await resolveCatalog({ client, schema, trustedKeys, nowMs, digest });
  const table = {
    tableManifestVersion: verified?.version ?? null,
    tableManifestDigest: verified?.digest ?? null,
    tableFault: null,
    pin,
  };
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
