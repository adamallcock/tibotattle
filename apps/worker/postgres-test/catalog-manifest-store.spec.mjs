// PostgreSQL 17 spec for the server catalog store (KM-3, stream KM-CORE):
// the staged catalog migration, the verifying loader, the pin and the read
// APIs for intake pricing and analytics.
//
// Covered refusals: a tampered signature, a non-append-only update (in the
// loader and in the database), a version regression (and a gap), an
// out-of-grammar token, a version 1 that is not the compiled baseline, a
// tampered stored row, forged or edited card and retraction rows, and a
// successor that activates before its predecessor. Covered reads: the
// compiled baseline fallback before any load, byte-identical pricing from the
// loaded baseline, pinning, staged activation, a key rotated out of the pins,
// and the cutover analytics binding (kernels stay on the compiled registry,
// stamped manifest version 1, with table faults report-only).
//
// Schemas: the promoted primary chain through the production runner plus the
// staged catalog migration through the staged-migrations harness (once the
// integrator promotes it, the stock chain alone; the spec finds the file by
// its suffix). Every key is a synthetic Ed25519 key generated at test time;
// every fixture is synthetic. Schemas are prefixed km_core_ and dropped.
//
// Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-.../socket PG_TEST_PORT=55433 \
//   node --test postgres-test/catalog-manifest-store.spec.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import frozenBaselineManifest from "../catalog/manifest-0001.json" with { type: "json" };
import pg from "pg";
import { createServer } from "vite";
import { APP_OFFICIAL_PRICE_CARDS, priceUsageEvent } from "@app-usagemonitor/accounting";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import { classifyContractOperations } from "../cloud-run/postgres-production-migrations.mjs";
import {
  applyStockAndStagedMigrations,
  listStagedMigrations,
  postgresTestEndpoint,
} from "./staged-migrations-harness.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PRICE_CARDS = frozenBaselineManifest.priceCards;
const CATALOG_SUFFIX = "_catalog_manifest_store.sql";
const NOW_MS = Date.parse("2026-10-02T12:00:00.000Z");
const KEY_ID = "catalog-test-km-core";

const endpoint = await postgresTestEndpoint();
const skip = endpoint === null ? "set PG_TEST_SOCKET or PG_TEST_HOST to a local PostgreSQL 17" : false;

let vite;
let contract;
let store;
let pool;
let migrationName;
let signer;
const schemas = [];

const clone = (value) => JSON.parse(JSON.stringify(value));
const q = (schema, name) => `"${schema}"."${name}"`;

async function loadModules() {
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
    resolve: { mainFields: ["module", "main"] },
  });
  return {
    contract: await vite.ssrLoadModule("/src/catalog-manifest.ts"),
    store: await vite.ssrLoadModule("/src/postgres-catalog-store.ts"),
  };
}

async function syntheticSigner(keyId = KEY_ID) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    trustedKeys: [{ keyId, publicKey: Buffer.from(raw).toString("base64") }],
    sign: async (manifest) => (await contract.signCatalogPayload({
      payloadText: contract.canonicalCatalogPayloadText(manifest), keyId, privateKeyPkcs8: pkcs8,
    })).envelopeText,
  };
}

async function successorOf(held, edit = () => {}) {
  const next = clone(held);
  next.version = held.version + 1;
  next.previousVersion = held.version;
  next.previousDigest = await contract.webCryptoSha256Hex(contract.canonicalCatalogPayloadText(held));
  next.projectedFromCommit = null;
  edit(next);
  next.compat.registrySha256 = await contract.webCryptoSha256Hex(
    JSON.stringify(contract.activeCatalogPriceCards(next)));
  return next;
}

function syntheticCard(model) {
  const card = clone(BASELINE_PRICE_CARDS.find((entry) => entry.provider === "openai"
    && entry.metadata?.total_input_context_band == null && entry.aliases === undefined
    && entry.service_tier === "standard"));
  // The id is a digest slug, so only the model token can be out of grammar.
  card.id = `openai:synthetic-${createHash("sha256").update(model).digest("hex").slice(0, 16)}:standard:km-core`;
  card.model = model;
  card.effective = { from: "2026-10-01" };
  return card;
}

function syntheticModel(id) {
  return { id, label: "Synthetic unseen model", provider: "openai_codex", allowanceTrack: "primary",
    pricingStatus: "published", priceModelId: id, hidden: false };
}

async function catalogMigration() {
  const [staged, stock] = await Promise.all([
    listStagedMigrations("primary"), readPostgresMigrations({ role: "primary" }),
  ]);
  const found = [...staged, ...stock].filter(({ name }) => name.endsWith(CATALOG_SUFFIX));
  assert.equal(found.length, 1, "exactly one catalog store migration, staged or promoted");
  return found[0];
}

async function createSchema() {
  const schema = `km_core_${randomBytes(6).toString("hex")}`;
  schemas.push(schema);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await applyStockAndStagedMigrations({ role: "primary", schema, pool, stagedFiles: [migrationName] });
  return schema;
}

const load = (schema, envelopeText, trustedKeys = signer.trustedKeys) => store.loadCatalogManifest({
  pool, schema, envelopeText, trustedKeys,
});

async function withClient(work) {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

const readPricing = (schema, nowMs = NOW_MS, trustedKeys = signer.trustedKeys) => withClient((client) =>
  store.readCatalogPricingRegistry({ client, schema, trustedKeys, nowMs }));
const readAnalytics = (schema, kernelBinding, nowMs = NOW_MS, trustedKeys = signer.trustedKeys) =>
  withClient((client) => store.readCatalogForAnalytics({ client, schema, trustedKeys, nowMs, kernelBinding }));
const pin = (schema, mode, version, reason) => withClient((client) => store.setCatalogPin({
  client, schema, mode, version, reason,
}));

async function refusal(work) {
  try {
    await work();
  } catch (error) {
    return error?.code ?? "UNCODED";
  }
  return "NO_ERROR";
}

async function databaseRefusal(work) {
  try {
    await work();
  } catch (error) {
    return error?.message ?? "UNCODED";
  }
  return "NO_ERROR";
}

async function counts(schema) {
  const { rows } = await pool.query(`SELECT
      (SELECT count(*)::int FROM ${q(schema, "catalog_manifests")}) AS manifests,
      (SELECT count(*)::int FROM ${q(schema, "catalog_cards")}) AS cards,
      (SELECT count(*)::int FROM ${q(schema, "catalog_card_retractions")}) AS retractions`);
  return rows[0];
}

/** Price a sweep of synthetic events with both card sets and require identical bytes. */
function assertPricingIdentical(priceCards) {
  const context = { priceEpochBasis: "event_time_when_registry_has_effective_evidence" };
  let priced = 0;
  for (const card of BASELINE_PRICE_CARDS) {
    const band = card.metadata?.total_input_context_band ?? null;
    const bound = card.components[0]?.conditions;
    const totalInputContextTokens = band === "short" ? bound.max_total_input_tokens
      : band === "long" ? bound.min_total_input_tokens : "1000";
    for (const day of [card.effective.from, card.effective.to, "2026-08-01"].filter(Boolean)) {
      const event = {
        provider: card.provider, model: card.model, apiTier: card.service_tier,
        pricedAt: `${day}T12:00:00.000Z`, totalInputContextTokens,
        components: card.provider === "openai"
          ? { inputUncachedTokens: 1234, inputCacheReadTokens: 5678, inputCacheWriteTokens: 91,
            outputTextTokens: 2345, outputReasoningTokens: 678 }
          : { inputUncachedTokens: 1234, inputCacheReadTokens: 5678, inputCacheWrite5mTokens: 91,
            inputCacheWrite1hTokens: 17, outputCombinedTokens: 3023 },
      };
      const compiled = priceUsageEvent(event, { priceCards: BASELINE_PRICE_CARDS, pricingContext: context });
      const fromTable = priceUsageEvent(event, { priceCards, pricingContext: context });
      assert.equal(JSON.stringify(fromTable), JSON.stringify(compiled));
      if (compiled.coverageStatus !== "unpriced") priced += 1;
    }
  }
  assert.ok(priced > 150, "the sweep prices real events");
}

before(async () => {
  if (skip) return;
  ({ contract, store } = await loadModules());
  pool = new pg.Pool({
    ...endpoint, ssl: false, max: 4, application_name: "km-core-catalog-store-test", connectionTimeoutMillis: 5_000,
  });
  const version = await pool.query("SELECT version() AS version");
  assert.match(version.rows[0]?.version ?? "", /^PostgreSQL 17\./u);
  migrationName = (await catalogMigration()).name;
  signer = await syntheticSigner();
});

after(async () => {
  if (pool) {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
  if (vite) await vite.close();
});

test("the staged migration is purely additive: no contract operation", { skip }, async () => {
  const migration = await catalogMigration();
  assert.deepEqual(classifyContractOperations(migration.sql), []);
  // Origin pools set no search_path: every catalog function pins its own.
  const schema = await createSchema();
  const functions = await pool.query(`SELECT p.proname, p.proconfig FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 AND p.proname LIKE 'catalog\\_%' ORDER BY p.proname`, [schema]);
  assert.deepEqual(functions.rows.map((row) => row.proname),
    ["catalog_append_only", "catalog_envelope_payload_text", "catalog_manifests_continuity",
      "catalog_vocabulary_head_version"]);
  for (const row of functions.rows) {
    assert.ok(row.proconfig?.some((entry) => entry === `search_path=${schema}`
      || entry === `search_path="${schema}"` || entry.startsWith(`search_path=${schema},`)), row.proname);
  }
});

test("before any load the read APIs serve current compiled pricing with the retained manifest stamp", { skip }, async () => {
  const schema = await createSchema();
  const pricing = await readPricing(schema);
  assert.equal(pricing.source, "compiled_baseline");
  assert.equal(pricing.manifestVersion, 1);
  assert.equal(pricing.manifestDigest, null);
  assert.equal(JSON.stringify(pricing.priceCards), JSON.stringify(APP_OFFICIAL_PRICE_CARDS));
  assert.equal(pricing.registrySha256, store.COMPILED_CATALOG_INPUTS.registrySha256);
  assert.notEqual(pricing.registrySha256, frozenBaselineManifest.compat.registrySha256);
  const analytics = await readAnalytics(schema);
  assert.equal(analytics.kernelBinding, "compiled_registry");
  assert.equal(analytics.stampManifestVersion, 1);
  assert.equal(analytics.boundManifest, null);
  assert.equal(analytics.tableManifestVersion, null);

  // The real keys are pinned (round 11), and that alone loads nothing: with
  // the code pins of either channel and an empty store, every read is the
  // compiled baseline, which is what is served at cutover (round 7). Only a
  // deliberate load of a signed manifest changes that.
  const { catalogTrustedKeys } = await vite.ssrLoadModule("/src/catalog-manifest-keys.ts");
  for (const channel of ["production", "staging"]) {
    const trustedKeys = catalogTrustedKeys(channel);
    assert.equal(trustedKeys.length, 2, `${channel} has its current and next keys pinned`);
    const pinnedPricing = await readPricing(schema, NOW_MS, trustedKeys);
    assert.deepEqual([pinnedPricing.source, pinnedPricing.manifestVersion, pinnedPricing.manifestDigest],
      ["compiled_baseline", 1, null]);
    assert.equal(JSON.stringify(pinnedPricing.priceCards), JSON.stringify(APP_OFFICIAL_PRICE_CARDS));
    const cutover = await readAnalytics(schema, undefined, NOW_MS, trustedKeys);
    assert.deepEqual([cutover.kernelBinding, cutover.stampManifestVersion, cutover.boundManifest,
      cutover.tableManifestVersion, cutover.tableFault], ["compiled_registry", 1, null, null, null]);
    const bound = await readAnalytics(schema, "manifest", NOW_MS, trustedKeys);
    assert.deepEqual([bound.stampManifestVersion, bound.tableManifestVersion], [1, null]);
    assert.equal(bound.boundManifestDigest, contract.CATALOG_BASELINE_DIGEST, "the manifest binding binds the baseline");
  }
  // A synthetic key cannot load under the real pins: under its own key id it
  // is untrusted, and under a real key id its signature fails.
  const envelope = await signer.sign(store.compiledBaselineCatalogManifest());
  assert.equal(await refusal(() => load(schema, envelope, catalogTrustedKeys("production"))),
    "CATALOG_KEY_UNTRUSTED");
  const impersonator = await syntheticSigner(catalogTrustedKeys("production")[0].keyId);
  const forged = await impersonator.sign(store.compiledBaselineCatalogManifest());
  assert.equal(await refusal(() => load(schema, forged, catalogTrustedKeys("production"))),
    "CATALOG_SIGNATURE_INVALID");
  assert.equal(await refusal(() => load(schema, forged, catalogTrustedKeys("staging"))), "CATALOG_KEY_UNTRUSTED",
    "a production key id never verifies on the staging pins");
  assert.deepEqual(await counts(schema), { manifests: 0, cards: 0, retractions: 0 });

  // Before the migration (no table at all) the read is the same fallback.
  const bare = `km_core_${randomBytes(6).toString("hex")}`;
  schemas.push(bare);
  await pool.query(`CREATE SCHEMA "${bare}"`);
  assert.equal((await readPricing(bare)).source, "compiled_baseline");
});

test("the signed baseline loads once, idempotently, and prices byte-identically", { skip }, async () => {
  const schema = await createSchema();
  const baseline = store.compiledBaselineCatalogManifest();
  const envelope = await signer.sign(baseline);
  const receipt = await load(schema, envelope);
  assert.equal(receipt.status, "loaded");
  assert.equal(receipt.version, 1);
  assert.equal(receipt.cardsAdded, BASELINE_PRICE_CARDS.length);
  assert.equal(receipt.digest, await contract.webCryptoSha256Hex(contract.canonicalCatalogPayloadText(baseline)));
  assert.equal((await load(schema, envelope)).status, "already_loaded");
  assert.deepEqual(await counts(schema), { manifests: 1, cards: BASELINE_PRICE_CARDS.length, retractions: 0 });

  // Card numbers follow manifest order, and each digest is its canonical bytes.
  const cards = await pool.query(`SELECT card_no, card_id, card_digest FROM ${q(schema, "catalog_cards")}
    ORDER BY card_no`);
  assert.deepEqual(cards.rows.map((row) => row.card_id), BASELINE_PRICE_CARDS.map((card) => card.id));
  assert.equal(cards.rows[0].card_digest,
    await contract.webCryptoSha256Hex(JSON.stringify(BASELINE_PRICE_CARDS[0])));

  const pricing = await readPricing(schema);
  assert.equal(pricing.source, "catalog_table");
  assert.equal(pricing.manifestVersion, 1);
  assert.equal(pricing.manifestDigest, receipt.digest);
  assert.equal(pricing.registrySha256, frozenBaselineManifest.compat.registrySha256);
  assert.equal(JSON.stringify(pricing.priceCards), JSON.stringify(BASELINE_PRICE_CARDS));
  assertPricingIdentical(pricing.priceCards);
});

test("a tampered signature, an untrusted key or a non-baseline version 1 inserts nothing", { skip }, async () => {
  const schema = await createSchema();
  const baseline = store.compiledBaselineCatalogManifest();
  const envelope = JSON.parse(await signer.sign(baseline));
  const signature = envelope.signature;
  const flippedSignature = `${signature.slice(0, 20)}${signature[20] === "A" ? "B" : "A"}${signature.slice(21)}`;
  assert.equal(await refusal(() => load(schema, JSON.stringify({ ...envelope, signature: flippedSignature }))),
    "CATALOG_SIGNATURE_INVALID");
  const payload = envelope.payload;
  const flippedPayload = `${payload.slice(0, 500)}${payload[500] === "A" ? "B" : "A"}${payload.slice(501)}`;
  assert.equal(await refusal(() => load(schema, JSON.stringify({ ...envelope, payload: flippedPayload }))),
    "CATALOG_SIGNATURE_INVALID");
  const stranger = await syntheticSigner("catalog-test-stranger");
  assert.equal(await refusal(() => load(schema, JSON.stringify(envelope), stranger.trustedKeys)),
    "CATALOG_KEY_UNTRUSTED");
  const impostor = await syntheticSigner();
  assert.equal(await refusal(() => load(schema, JSON.stringify(envelope), impostor.trustedKeys)),
    "CATALOG_SIGNATURE_INVALID");

  // Correctly signed and internally valid, but not the compiled baseline.
  const altered = clone(baseline);
  altered.priceCards[0].components[0].price.amount = "0.01";
  altered.compat.registrySha256 = await contract.webCryptoSha256Hex(JSON.stringify(altered.priceCards));
  assert.equal(await refusal(async () => load(schema, await signer.sign(altered))), "CATALOG_BASELINE_MISMATCH");
  // A first manifest must be version 1.
  const second = await successorOf(baseline);
  assert.equal(await refusal(async () => load(schema, await signer.sign(second))), "CATALOG_VERSION_GAP");
  assert.deepEqual(await counts(schema), { manifests: 0, cards: 0, retractions: 0 });
});

test("successors append; edits, removals, regressions and gaps are refused", { skip }, async () => {
  const schema = await createSchema();
  const baseline = store.compiledBaselineCatalogManifest();
  await load(schema, await signer.sign(baseline));
  const retracted = baseline.priceCards.find((card) => card.provider === "anthropic");
  const v2 = await successorOf(baseline, (manifest) => {
    manifest.priceCards.push(syntheticCard("synthetic-unseen-model-km1"));
    manifest.models.push(syntheticModel("synthetic-unseen-model-km1"));
    manifest.retractions.push({ cardId: retracted.id, inVersion: 2, reason: "withdrawn", supersededBy: [] });
  });
  const v2Receipt = await load(schema, await signer.sign(v2));
  assert.deepEqual([v2Receipt.status, v2Receipt.cardsAdded, v2Receipt.retractionsAdded], ["loaded", 1, 1]);
  const pricing = await readPricing(schema);
  assert.equal(pricing.manifestVersion, 2);
  assert.equal(pricing.priceCards.some((card) => card.id === retracted.id), false);
  assert.equal(pricing.priceCards.some((card) => card.model === "synthetic-unseen-model-km1"), true);
  assert.notEqual(pricing.registrySha256, store.COMPILED_CATALOG_INPUTS.registrySha256);

  // Non-append-only updates, each correctly signed.
  const edits = [
    (manifest) => { manifest.priceCards[0].components[0].price.amount = "0.01"; },
    (manifest) => { manifest.priceCards.splice(1, 1); },
    (manifest) => { manifest.models[0].pricingStatus = "unpriced"; manifest.models[0].priceModelId = null; },
    (manifest) => { manifest.retractions = []; },
    (manifest) => { manifest.speeds.pop(); },
  ];
  for (const edit of edits) {
    const v3 = await successorOf(v2, edit);
    assert.equal(await refusal(async () => load(schema, await signer.sign(v3))), "CATALOG_NOT_APPEND_ONLY");
  }
  // Version regressions and conflicts: a different version 1 or 2, and a gap.
  const otherV2 = await successorOf(baseline, (manifest) => { manifest.models[0].label = "Different"; });
  assert.equal(await refusal(async () => load(schema, await signer.sign(otherV2))), "CATALOG_VERSION_CONFLICT");
  const v4 = await successorOf(await successorOf(v2));
  assert.equal(await refusal(async () => load(schema, await signer.sign(v4))), "CATALOG_VERSION_GAP");
  const brokenChain = await successorOf(v2, (manifest) => { manifest.previousDigest = "e".repeat(64); });
  assert.equal(await refusal(async () => load(schema, await signer.sign(brokenChain))), "CATALOG_CHAIN_MISMATCH");
  // Reloading an older loaded version is a no-op, not a regression.
  assert.equal((await load(schema, await signer.sign(baseline))).status, "already_loaded");
  assert.deepEqual(await counts(schema), { manifests: 2, cards: BASELINE_PRICE_CARDS.length + 1, retractions: 1 });

  // The database refuses the same outside the loader.
  for (const statement of [
    `UPDATE ${q(schema, "catalog_manifests")} SET key_id = key_id WHERE version = 1`,
    `DELETE FROM ${q(schema, "catalog_manifests")} WHERE version = 2`,
    `UPDATE ${q(schema, "catalog_cards")} SET card_digest = card_digest WHERE card_no = 1`,
    `DELETE FROM ${q(schema, "catalog_card_retractions")}`,
    `TRUNCATE ${q(schema, "catalog_cards")} CASCADE`,
    `TRUNCATE ${q(schema, "catalog_manifests")} CASCADE`,
  ]) {
    assert.equal(await databaseRefusal(() => pool.query(statement)), "catalog_append_only", statement);
  }
  const regression = `INSERT INTO ${q(schema, "catalog_manifests")}
      (version, previous_version, previous_digest, digest, key_id, envelope_text, published_at, activate_at)
    SELECT 1, NULL, NULL, digest, key_id, envelope_text, published_at, activate_at
    FROM ${q(schema, "catalog_manifests")} WHERE version = 1`;
  assert.equal(await databaseRefusal(() => pool.query(regression)), "catalog_manifests_version_regression");
  const gap = `INSERT INTO ${q(schema, "catalog_manifests")}
      (version, previous_version, previous_digest, digest, key_id, envelope_text, published_at, activate_at)
    SELECT 4, 3, digest, digest, key_id, envelope_text, published_at, activate_at
    FROM ${q(schema, "catalog_manifests")} WHERE version = 2`;
  assert.equal(await databaseRefusal(() => pool.query(gap)), "catalog_manifests_version_gap");
  assert.deepEqual(await counts(schema), { manifests: 2, cards: BASELINE_PRICE_CARDS.length + 1, retractions: 1 });
});

test("an out-of-grammar token is refused by the loader and by the table", { skip }, async () => {
  const schema = await createSchema();
  const baseline = store.compiledBaselineCatalogManifest();
  await load(schema, await signer.sign(baseline));
  const arnWithSlash = "arn:aws:bedrock:us-east-1:123456789012:foundation-model/anthropic.claude";
  for (const id of [arnWithSlash, "m".repeat(65), "gpt 7"]) {
    const v2 = await successorOf(baseline, (manifest) => {
      manifest.priceCards.push(syntheticCard(id));
      manifest.models.push(syntheticModel(id));
    });
    assert.equal(await refusal(async () => load(schema, await signer.sign(v2))), "CATALOG_TOKEN_OUT_OF_GRAMMAR");
  }
  // Inside the grammar a colon-delimited ARN is plain text and loads.
  const colonArn = "arn:aws:bedrock:us-east-1:123456789012:inference-profile";
  const v2 = await successorOf(baseline, (manifest) => {
    manifest.priceCards.push(syntheticCard(colonArn));
    manifest.models.push(syntheticModel(colonArn));
  });
  assert.equal((await load(schema, await signer.sign(v2))).status, "loaded");
  const stored = await pool.query(`SELECT model FROM ${q(schema, "catalog_cards")} WHERE first_version = 2`);
  assert.deepEqual(stored.rows.map((row) => row.model), [colonArn]);
  // The table holds the same grammar (written under the head version, so
  // only the grammar CHECK can refuse it).
  const outOfGrammar = `INSERT INTO ${q(schema, "catalog_cards")}
      (card_id, card_digest, provider, model, service_tier, first_version)
    VALUES ('synthetic:card', '${"a".repeat(64)}', 'openai', $1, 'standard', 2)`;
  assert.match(await databaseRefusal(() => pool.query(outOfGrammar, [arnWithSlash])), /check constraint/u);
});

test("a tampered stored row is refused on read, never served or replaced by the baseline", { skip }, async () => {
  const schema = await createSchema();
  await load(schema, await signer.sign(store.compiledBaselineCatalogManifest()));
  const row = await pool.query(`SELECT envelope_text FROM ${q(schema, "catalog_manifests")} WHERE version = 1`);
  const envelope = JSON.parse(row.rows[0].envelope_text);
  const signature = envelope.signature;
  const forged = JSON.stringify({ ...envelope,
    signature: `${signature.slice(0, 5)}${signature[5] === "A" ? "B" : "A"}${signature.slice(6)}` });
  // Only a superuser bypassing the append-only trigger can do this.
  await pool.query(`ALTER TABLE ${q(schema, "catalog_manifests")} DISABLE TRIGGER catalog_manifests_append_only`);
  await pool.query(`UPDATE ${q(schema, "catalog_manifests")} SET envelope_text = $1 WHERE version = 1`, [forged]);
  await pool.query(`ALTER TABLE ${q(schema, "catalog_manifests")} ENABLE TRIGGER catalog_manifests_append_only`);
  // Wherever table content would be served or bound, the read fails closed.
  assert.equal(await refusal(() => readPricing(schema)), "CATALOG_STORE_TAMPERED");
  assert.equal(await refusal(() => readAnalytics(schema, "manifest")), "CATALOG_STORE_TAMPERED");
  // The cutover binding binds nothing from the table, so the fault is
  // report-only there: the run proceeds on the compiled registry, stamped 1.
  const compiled = await readAnalytics(schema);
  assert.deepEqual([compiled.kernelBinding, compiled.stampManifestVersion, compiled.boundManifest,
    compiled.tableManifestVersion, compiled.tableManifestDigest, compiled.tableFault],
  ["compiled_registry", 1, null, null, null, "CATALOG_STORE_TAMPERED"]);
  // A frozen pin is still enforced before the table is consulted.
  await pin(schema, "frozen", 1, "freeze");
  assert.equal((await readAnalytics(schema)).tableFault, "CATALOG_STORE_TAMPERED");
  // The loader re-verifies the held head before appending to it.
  const next = await successorOf(store.compiledBaselineCatalogManifest());
  assert.equal(await refusal(async () => load(schema, await signer.sign(next))), "CATALOG_STORE_TAMPERED");
  // A digest that is not the payload's own fails the table check outright.
  await pool.query(`ALTER TABLE ${q(schema, "catalog_manifests")} DISABLE TRIGGER catalog_manifests_append_only`);
  assert.match(await databaseRefusal(() => pool.query(
    `UPDATE ${q(schema, "catalog_manifests")} SET digest = $1 WHERE version = 1`, ["b".repeat(64)])),
  /check constraint/u);
  await pool.query(`ALTER TABLE ${q(schema, "catalog_manifests")} ENABLE TRIGGER catalog_manifests_append_only`);
});

test("pins choose the read version; staged activation; the cutover analytics binding", { skip }, async () => {
  const schema = await createSchema();
  const baseline = store.compiledBaselineCatalogManifest();
  await load(schema, await signer.sign(baseline));
  const v2 = await successorOf(baseline, (manifest) => {
    manifest.publishedAt = "2026-10-01T00:00:00Z";
    manifest.activateAt = "2026-10-01T00:00:00Z";
    manifest.priceCards.push(syntheticCard("synthetic-unseen-model-km1"));
    manifest.models.push(syntheticModel("synthetic-unseen-model-km1"));
  });
  await load(schema, await signer.sign(v2));
  const v3 = await successorOf(v2, (manifest) => {
    manifest.publishedAt = "2026-10-02T00:00:00Z";
    manifest.activateAt = "2026-10-09T00:00:00Z";
    manifest.models[0].label = "Relabelled";
  });
  await load(schema, await signer.sign(v3));

  // latest_verified: the newest ACTIVE version.
  assert.equal((await readPricing(schema)).manifestVersion, 2);
  assert.equal((await readPricing(schema, Date.parse("2026-10-09T00:00:00.000Z"))).manifestVersion, 3);
  // Rollback by pin, and back.
  await pin(schema, "pinned", 1, "rollback");
  const pinned = await readPricing(schema);
  assert.deepEqual([pinned.manifestVersion, pinned.pin.mode], [1, "pinned"]);
  assert.equal(JSON.stringify(pinned.priceCards), JSON.stringify(BASELINE_PRICE_CARDS));
  await pin(schema, "pinned", 3, "staging");
  assert.equal(await refusal(() => readPricing(schema)), "CATALOG_PIN_NOT_ACTIVE");
  assert.equal(await refusal(() => readAnalytics(schema, "manifest")), "CATALOG_PIN_NOT_ACTIVE");
  // The cutover binding binds nothing from the table: report-only.
  const pending = await readAnalytics(schema);
  assert.deepEqual([pending.stampManifestVersion, pending.tableManifestVersion, pending.tableFault],
    [1, null, "CATALOG_PIN_NOT_ACTIVE"]);
  assert.equal(await refusal(() => pin(schema, "pinned", 9, "staging")), "CATALOG_PIN_VERSION_UNKNOWN");
  assert.equal(await refusal(() => pin(schema, "latest_verified", 2, "advance")), "CATALOG_STORE_ARGUMENT_INVALID");
  await pin(schema, "latest_verified", null, "advance");
  assert.equal((await readPricing(schema)).manifestVersion, 2);

  // Cutover: kernels on the compiled registry are stamped version 1 whatever
  // the table holds; the post-cutover manifest binding stamps the pin.
  const compiled = await readAnalytics(schema);
  assert.deepEqual([compiled.stampManifestVersion, compiled.boundManifest, compiled.tableManifestVersion,
    compiled.tableFault], [1, null, 2, null]);
  const bound = await readAnalytics(schema, "manifest");
  assert.equal(bound.stampManifestVersion, 2);
  assert.equal(bound.boundManifest.version, 2);
  assert.equal(bound.tableFault, null);

  // A key rotated out of the pins: refused wherever table content is served
  // or bound (named apart from tampering), report-only for the cutover binding.
  const rotated = (await syntheticSigner("catalog-test-rotated")).trustedKeys;
  assert.equal(await refusal(() => readPricing(schema, NOW_MS, rotated)), "CATALOG_STORE_KEY_UNTRUSTED");
  assert.equal(await refusal(() => readAnalytics(schema, "manifest", NOW_MS, rotated)),
    "CATALOG_STORE_KEY_UNTRUSTED");
  const unpinned = await readAnalytics(schema, undefined, NOW_MS, rotated);
  assert.deepEqual([unpinned.stampManifestVersion, unpinned.tableManifestVersion, unpinned.tableFault],
    [1, null, "CATALOG_STORE_KEY_UNTRUSTED"]);

  await pin(schema, "frozen", 2, "freeze");
  assert.equal(await refusal(() => readAnalytics(schema)), "CATALOG_FROZEN_PIN_MISMATCH");
  // The frozen pin is enforced even when the table itself is unreadable.
  assert.equal(await refusal(() => readAnalytics(schema, undefined, NOW_MS, rotated)),
    "CATALOG_FROZEN_PIN_MISMATCH");
  assert.equal((await readAnalytics(schema, "manifest")).stampManifestVersion, 2);
  await pin(schema, "frozen", 1, "freeze");
  assert.equal((await readAnalytics(schema)).stampManifestVersion, 1);

  // The pin log is append-only too.
  assert.equal(await databaseRefusal(() => pool.query(`DELETE FROM ${q(schema, "catalog_pin_events")}`)),
    "catalog_append_only");
  const events = await pool.query(`SELECT mode, version, reason FROM ${q(schema, "catalog_pin_events")}
    ORDER BY event_no`);
  assert.equal(events.rows.length, 5);
});

test("forged card and retraction rows are refused at the next load, never trusted", { skip }, async () => {
  const cardsTable = (schema) => q(schema, "catalog_cards");
  const retractionsTable = (schema) => q(schema, "catalog_card_retractions");
  const forgeCard = (schema, card, { digest, model, firstVersion }) => pool.query(
    `INSERT INTO ${cardsTable(schema)} (card_id, card_digest, provider, model, service_tier, first_version)
     VALUES ($1, $2, $3, $4, $5, $6)`, [card.id, digest, card.provider, model, card.service_tier, firstVersion]);
  const baseline = store.compiledBaselineCatalogManifest();
  const introduced = syntheticCard("synthetic-forgery-probe-km1");
  const v2 = await successorOf(baseline, (manifest) => {
    manifest.priceCards.push(introduced);
    manifest.models.push(syntheticModel("synthetic-forgery-probe-km1"));
  });
  const v2Envelope = await signer.sign(v2);
  const introducedDigest = await contract.catalogCardDigest(introduced, contract.webCryptoSha256Hex);

  // 1. The reported case: a row for a card the next manifest introduces,
  //    written ahead of it with another digest and model.
  const ahead = await createSchema();
  await load(ahead, await signer.sign(baseline));
  await forgeCard(ahead, introduced, { digest: "0".repeat(64), model: "some-other-model", firstVersion: 1 });
  assert.equal(await refusal(() => load(ahead, v2Envelope)), "CATALOG_STORE_TAMPERED");
  assert.deepEqual(await counts(ahead), { manifests: 1, cards: BASELINE_PRICE_CARDS.length + 1, retractions: 0 });

  // 2. The same card with its true bytes but written ahead of its manifest
  //    still claims a version that never carried it: refused.
  const exact = await createSchema();
  await load(exact, await signer.sign(baseline));
  await forgeCard(exact, introduced, { digest: introducedDigest, model: introduced.model, firstVersion: 1 });
  assert.equal(await refusal(() => load(exact, v2Envelope)), "CATALOG_STORE_TAMPERED");

  // 3. A row can only be written under the head version, so it can never
  //    claim an older version than the one it was written under.
  const history = await createSchema();
  await load(history, await signer.sign(baseline));
  await load(history, v2Envelope);
  const later = syntheticCard("synthetic-forgery-probe-km2");
  assert.equal(await databaseRefusal(() => forgeCard(history, later,
    { digest: "a".repeat(64), model: later.model, firstVersion: 1 })), "catalog_vocabulary_not_head_version");

  // 4. An existing card row edited behind the append-only trigger (superuser
  //    only) disagrees with the signed head: refused.
  const edited = await createSchema();
  await load(edited, await signer.sign(baseline));
  await pool.query(`ALTER TABLE ${cardsTable(edited)} DISABLE TRIGGER catalog_cards_append_only`);
  await pool.query(`UPDATE ${cardsTable(edited)} SET model = 'some-other-model' WHERE card_no = 1`);
  await pool.query(`ALTER TABLE ${cardsTable(edited)} ENABLE TRIGGER catalog_cards_append_only`);
  assert.equal(await refusal(() => load(edited, v2Envelope)), "CATALOG_STORE_TAMPERED");
  assert.deepEqual(await counts(edited), { manifests: 1, cards: BASELINE_PRICE_CARDS.length, retractions: 0 });

  // 5. A retraction written ahead of the manifest that retracts the card.
  //    Before this check it would have broken the legitimate load on the
  //    card_no key; now the load is refused as tampering instead.
  const retracted = baseline.priceCards.find((card) => card.provider === "anthropic");
  const v3 = await successorOf(v2, (manifest) => {
    manifest.retractions.push({ cardId: retracted.id, inVersion: 3, reason: "withdrawn", supersededBy: [] });
  });
  const retraction = await createSchema();
  await load(retraction, await signer.sign(baseline));
  await load(retraction, v2Envelope);
  const forgeRetraction = (schema, cardId, retractedIn, reason) => pool.query(
    `INSERT INTO ${retractionsTable(schema)} (card_no, retracted_in, reason)
     SELECT card_no, $2, $3 FROM ${cardsTable(schema)} WHERE card_id = $1`, [cardId, retractedIn, reason]);
  await forgeRetraction(retraction, retracted.id, 2, "price_correction");
  assert.equal(await refusal(async () => load(retraction, await signer.sign(v3))), "CATALOG_STORE_TAMPERED");
  assert.deepEqual(await counts(retraction),
    { manifests: 2, cards: BASELINE_PRICE_CARDS.length + 1, retractions: 1 });
  //    A retraction can only be written under the head version as well.
  assert.equal(await databaseRefusal(() => forgeRetraction(retraction, introduced.id, 1, "withdrawn")),
    "catalog_vocabulary_not_head_version");

  // 6. A legitimately loaded retraction whose reason is edited behind the
  //    trigger disagrees with the signed head at the next load.
  const reason = await createSchema();
  await load(reason, await signer.sign(baseline));
  await load(reason, v2Envelope);
  assert.equal((await load(reason, await signer.sign(v3))).retractionsAdded, 1);
  await pool.query(`ALTER TABLE ${retractionsTable(reason)} DISABLE TRIGGER catalog_card_retractions_append_only`);
  await pool.query(`UPDATE ${retractionsTable(reason)} SET reason = 'superseded'`);
  await pool.query(`ALTER TABLE ${retractionsTable(reason)} ENABLE TRIGGER catalog_card_retractions_append_only`);
  assert.equal(await refusal(async () => load(reason, await signer.sign(await successorOf(v3)))),
    "CATALOG_STORE_TAMPERED");

  // The untouched chain still loads every step.
  const clean = await createSchema();
  await load(clean, await signer.sign(baseline));
  await load(clean, v2Envelope);
  assert.equal((await load(clean, await signer.sign(v3))).status, "loaded");
  assert.equal((await load(clean, await signer.sign(await successorOf(v3)))).status, "loaded");
  const firstVersions = await pool.query(`SELECT first_version, count(*)::int AS cards
    FROM ${cardsTable(clean)} GROUP BY first_version ORDER BY first_version`);
  assert.deepEqual(firstVersions.rows, [
    { first_version: 1, cards: BASELINE_PRICE_CARDS.length }, { first_version: 2, cards: 1 },
  ]);
});

test("a successor may not activate before its predecessor, in the loader or the table", { skip }, async () => {
  const schema = await createSchema();
  const baseline = store.compiledBaselineCatalogManifest();
  await load(schema, await signer.sign(baseline));
  const v2 = await successorOf(baseline, (manifest) => {
    manifest.publishedAt = "2026-10-01T00:00:00Z";
    manifest.activateAt = "2026-12-01T00:00:00Z";
  });
  await load(schema, await signer.sign(v2));
  // A hotfix published later but activating earlier would carry v2 live early.
  const early = await successorOf(v2, (manifest) => {
    manifest.publishedAt = "2026-10-01T00:00:00Z";
    manifest.activateAt = "2026-10-01T00:00:00Z";
  });
  const earlyEnvelope = await signer.sign(early);
  assert.equal(await refusal(() => load(schema, earlyEnvelope)), "CATALOG_NOT_APPEND_ONLY");
  assert.equal((await readPricing(schema)).manifestVersion, 1, "v2 stays pending");

  // The table refuses the same row written outside the loader.
  const digest = await contract.webCryptoSha256Hex(contract.canonicalCatalogPayloadText(early));
  assert.equal(await databaseRefusal(() => pool.query(`INSERT INTO ${q(schema, "catalog_manifests")}
      (version, previous_version, previous_digest, digest, key_id, envelope_text, published_at, activate_at)
    VALUES (3, 2, $1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
  [early.previousDigest, digest, KEY_ID, earlyEnvelope, early.publishedAt, early.activateAt])),
  "catalog_manifests_activation_regression");
  assert.deepEqual(await counts(schema), { manifests: 2, cards: BASELINE_PRICE_CARDS.length, retractions: 0 });

  // Activating with or after v2 loads; both go live together on v2's date.
  const together = await successorOf(v2, (manifest) => {
    manifest.publishedAt = "2026-10-02T00:00:00Z";
    manifest.activateAt = "2026-12-01T00:00:00Z";
  });
  assert.equal((await load(schema, await signer.sign(together))).status, "loaded");
  assert.equal((await readPricing(schema)).manifestVersion, 1);
  assert.equal((await readPricing(schema, Date.parse("2026-12-01T00:00:00.000Z"))).manifestVersion, 3);
});
