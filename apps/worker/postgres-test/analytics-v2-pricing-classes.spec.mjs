/**
 * PG17 spec for W1E's pricing classes (staged migration
 * analytics_v2_pricing_classes; src/analytics-v2/store-price.ts and
 * kernel.ts): the migration's closed, append-only tables and their
 * consistency triggers, the store's class registration, and the kernel
 * transition proof established by pricing-class identity with a sampled
 * reprice instead of a full reprice: the same verdict, counts and stale set,
 * fail closed when either class is unknown or differs, and a failed sample
 * ends the run.
 *
 * The sources run through Vite with the build's pricer defines set to a
 * synthetic pricer (PRICER_A), so writeRunOutputs registers and proves as a
 * bundle built with a pricer would; a spec states another pricer (or none)
 * to the store functions directly. Each case applies the stock primary chain
 * and the pricing-classes file (staged, or stock once promoted) into a fresh
 * random schema, dropped afterwards. Synthetic, content-free values only.
 *
 * Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket \
 *      PG_TEST_PORT=55433 node --test postgres-test/analytics-v2-pricing-classes.spec.mjs
 *
 * ANALYTICS_V2_PRICING_CLASS_BENCH=<owner-days>x<events> also times the
 * transition proof both ways on that many synthetic stored owner-days.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import {
  NO_ANALYTICS_V2_EXCLUSIONS_SHA256,
  applyStockAndStagedMigrations,
  postgresTestEndpoint,
} from "./staged-migrations-harness.mjs";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIMARY_MIGRATIONS_DIRECTORY = join(WORKER_ROOT, "postgres", "migrations", "primary");
const STAGED_DIRECTORY = join(WORKER_ROOT, "postgres", "staged-migrations", "primary");
/** Found by its name suffix: staged under a placeholder number until the integrator promotes it. */
const CLASS_FILE = /^\d{4}_analytics_v2_pricing_classes\.sql$/u;
const PRICE_FILE = /^\d{4}_analytics_v2_price_cards\.sql$/u;
const ENDPOINT = await postgresTestEndpoint();
const PG_SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) and PG_TEST_PORT for the local PostgreSQL 17 cluster"
  : false;
const HORIZON = Object.freeze({ ownerDayFromDay: "2026-01-01", cacheBandsFromDay: "2026-01-01" });
const NOW = "2026-10-01T12:00:00.000Z";
const digest = (label) => createHash("sha256").update(`analytics-v2-pricing-classes-spec:${label}`).digest("hex");
const OWNER_A = digest("owner-a");
const OWNER_B = digest("owner-b");
const CLASS_X = digest("compute-class-x");
const METHOD = "server-api-price-equivalent-v0.5";
/** The pricer the "build" (Vite's defines) states. */
const PRICER_A = Object.freeze({ pricerSha256: digest("pricer-a"), pricingMethodVersion: METHOD });
/** Another pricer: another pricing class. */
const PRICER_B = Object.freeze({ pricerSha256: digest("pricer-b"), pricingMethodVersion: METHOD });

let vite;
let store;
let storePrice;
let prices;
let contract;
let kernelModule;
let registry;
let bundleCards;
let classFile;

before(async () => {
  vite = await createServer({ root: WORKER_ROOT, configFile: false, plugins: analyticsV2Config.plugins,
    resolve: analyticsV2Config.resolve, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    logLevel: "silent", define: { __ANALYTICS_V2_PRICER_SHA256__: JSON.stringify(PRICER_A.pricerSha256),
      __ANALYTICS_V2_PRICING_METHOD_VERSION__: JSON.stringify(PRICER_A.pricingMethodVersion) } });
  const load = (path) => vite.ssrLoadModule(path);
  store = await load("/src/analytics-v2/store.ts");
  storePrice = await load("/src/analytics-v2/store-price.ts");
  prices = await load("/src/analytics-v2/price-attribution.ts");
  contract = await load("/src/analytics-v2/contract.ts");
  kernelModule = await load("/src/analytics-v2/kernel.ts");
  registry = store.analyticsV2KernelRegistry();
  bundleCards = await prices.analyticsV2KernelPriceCards();
  assert.deepEqual({ ...kernelModule.analyticsV2BundledPricer() }, PRICER_A, "the sources run with the build's pricer");
  const staged = (await readdir(STAGED_DIRECTORY).catch(() => [])).find((name) => CLASS_FILE.test(name));
  const promoted = (await readdir(PRIMARY_MIGRATIONS_DIRECTORY)).find((name) => CLASS_FILE.test(name));
  classFile = { name: staged ?? promoted, directory: staged === undefined ? PRIMARY_MIGRATIONS_DIRECTORY : STAGED_DIRECTORY,
    staged: staged !== undefined };
  assert.ok(classFile.name, "the analytics_v2_pricing_classes migration is staged or promoted");
});

after(async () => {
  await vite?.close();
});

function quoted(schema, table) {
  assert.match(schema, /^[a-z_][a-z0-9_]{0,62}$/u);
  assert.match(table, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${schema}"."${table}"`;
}

async function withSchema(label, callback, { prefixBelow = null } = {}) {
  const pool = new pg.Pool({ ...ENDPOINT, ssl: false, max: 4, connectionTimeoutMillis: 5_000,
    application_name: `analytics-v2-pricing-classes-spec-${label}`, options: "-c search_path=pg_catalog" });
  const schema = `analytics_v2_classes_${randomBytes(5).toString("hex")}`;
  let prefixRoot = null;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    if (prefixBelow === null) {
      await applyStockAndStagedMigrations({ role: "primary", schema, pool,
        stagedFiles: classFile.staged ? [classFile.name] : [] });
    } else {
      prefixRoot = await mkdtemp(join(tmpdir(), "analytics-v2-pricing-classes-"));
      await mkdir(join(prefixRoot, "primary"));
      for (const migration of await readPostgresMigrations({ role: "primary" })) {
        if (migration.version < prefixBelow) {
          await copyFile(join(PRIMARY_MIGRATIONS_DIRECTORY, migration.name), join(prefixRoot, "primary", migration.name));
        }
      }
    }
    return await callback({ pool, schema, prefixRoot });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    if (prefixRoot !== null) await rm(prefixRoot, { recursive: true, force: true });
  }
}

/** A run stamp for kernel `kernelId` (a synthetic code identity) stating compute class `computeSha256`. */
function stamp(kernelId, computeSha256 = CLASS_X) {
  const kernel = { ...registry[0], kernelId, computeClosureSha256: digest(`closure-${kernelId}`) };
  return { kernel, manifestVersion: 1, computeSha256 };
}

/** A synthetic v1.1 usage record's price projection for `modelId` on `day`, priced by this bundle. */
function priced(modelId, day, outputTokens = 50) {
  const input = prices.analyticsV2PriceInput({ provider: "openai_codex", modelId, billingSurface: "chatgpt_subscription",
    speedMode: "standard", apiServiceTier: "default", reasoningEffort: "high", eventTime: `${day}T12:00:00.000Z`,
    totalInputContextTokens: 1000, components: { inputUncachedTokens: 100, inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0, outputTextTokens: outputTokens, outputReasoningTokens: 25, outputCombinedTokens: null } });
  return { input, priced: prices.priceAnalyticsV2Input(input) };
}

const dayOf = (index) => new Date(Date.parse("2026-01-02T00:00:00.000Z") + index * 86_400_000).toISOString().slice(0, 10);

/**
 * Write an older kernel's stored state by hand: its kernel row, its price
 * registration (this bundle's cards) and owner-day rows with price rows. A
 * day is [owner, day, events] with events an array, "no-price" (daily values,
 * no price row) or "refused". Price rows share one basis per card list.
 */
async function seedOlderKernel(pool, schema, { kernelId, days }) {
  const kernel = stamp(kernelId).kernel;
  // A fixed run id, so two schemas seeded alike hold byte-identical rows.
  const runId = digest(`seed-run-${kernelId}`).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/u, "$1-$2-$3-$4-$5");
  const t = (table) => quoted(schema, table);
  await pool.query(`INSERT INTO ${t("analytics_v2_kernels")} (kernel_id, production_commit, vendor_manifest_sha256,
      compute_closure_sha256, price_registry_sha256, price_registry_version, method_version, registered_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [kernelId, kernel.productionCommit, kernel.vendorManifestSha256, kernel.computeClosureSha256,
    kernel.priceRegistrySha256, kernel.priceRegistryVersion, kernel.methodVersion, NOW]);
  await pool.query(`INSERT INTO ${t("analytics_v2_kernel_prices")} (kernel_id, compute_sha256, cards_sha256, cards,
      projection_version, registered_at) VALUES ($1, $2, $3, $4, $5, $6)`,
  [kernelId, CLASS_X, bundleCards.cardsSha256, bundleCards.cards.length, prices.ANALYTICS_V2_PRICE_PROJECTION_VERSION, NOW]);
  const top = (await pool.query(`SELECT coalesce(max(card_ref), 0)::integer AS top FROM ${t("analytics_v2_price_cards")}`))
    .rows[0].top;
  const refs = new Map();
  await pool.query(`INSERT INTO ${t("analytics_v2_price_cards")} (card_ref, card_id, content_sha256, first_kernel_id)
    SELECT $1::integer + ordinality::integer, card_id, content_sha256, $2::smallint
      FROM ROWS FROM (jsonb_to_recordset($3::jsonb) AS (card_id text, content_sha256 text))
           WITH ORDINALITY AS c(card_id, content_sha256, ordinality)
    ON CONFLICT (card_id, content_sha256) DO NOTHING`,
  [top, kernelId, JSON.stringify(bundleCards.cards.map((card) => ({ card_id: card.cardId, content_sha256: card.contentSha256 })))]);
  for (const row of (await pool.query(`SELECT card_ref, card_id FROM ${t("analytics_v2_price_cards")}`)).rows) {
    refs.set(row.card_id, row.card_ref);
  }
  await pool.query(`INSERT INTO ${t("analytics_v2_kernel_cards")} (kernel_id, card_ref, card_id)
    SELECT $1::smallint, card_ref, card_id FROM ${t("analytics_v2_price_cards")}`, [kernelId]);
  const bases = new Map();
  const ownerDays = [];
  const priceRows = [];
  for (const [ownerDigest, day, events] of days) {
    ownerDays.push({ owner_digest: ownerDigest, day, daily: events === "refused" ? null : { synthetic: true },
      refusal: events === "refused" ? "source_conflict_or_order" : null });
    if (!Array.isArray(events)) continue;
    const { inputs, cardIds } = await prices.encodeAnalyticsV2PriceInputs(events);
    const refList = cardIds.map((cardId) => refs.get(cardId)).sort((left, right) => left - right);
    const key = refList.join(",");
    if (!bases.has(key)) {
      let basis = await pool.query(`SELECT price_basis_id FROM ${t("analytics_v2_price_bases")} WHERE basis_sha256 = $1`,
        [digest(`basis-${key}`)]);
      if (basis.rows.length === 0) {
        basis = await pool.query(`INSERT INTO ${t("analytics_v2_price_bases")} (price_basis_id, basis_sha256, card_refs)
          SELECT coalesce(max(price_basis_id), 0) + 1, $1, $2::integer[] FROM ${t("analytics_v2_price_bases")}
          RETURNING price_basis_id`, [digest(`basis-${key}`), refList]);
      }
      bases.set(key, basis.rows[0].price_basis_id);
    }
    const unpriced = events.filter((event) => event.priced.status <= prices.ANALYTICS_V2_PRICE_STATUS.unpriced).length;
    const partial = events.filter((event) => event.priced.status === prices.ANALYTICS_V2_PRICE_STATUS.partiallyPriced).length;
    priceRows.push({ owner_digest: ownerDigest, day, price_basis_id: bases.get(key), usage_events: events.length,
      unpriced_events: unpriced, partially_priced_events: partial, projection_version: inputs.projectionVersion,
      codec: inputs.codec, inputs: inputs.data, inputs_sha256: inputs.sha256, input_events: inputs.events });
  }
  for (let start = 0; start < ownerDays.length; start += 5_000) {
    await pool.query(`INSERT INTO ${t("analytics_v2_owner_day")} (owner_digest, day, daily, refusal, run_id, kernel_id,
        manifest_version)
      SELECT owner_digest, day, daily, refusal, $2::uuid, $3::smallint, 1
        FROM jsonb_to_recordset($1::jsonb) AS r(owner_digest text, day date, daily jsonb, refusal text)`,
    [JSON.stringify(ownerDays.slice(start, start + 5_000)), runId, kernelId]);
  }
  for (let start = 0; start < priceRows.length; start += 2_000) {
    await pool.query(`INSERT INTO ${t("analytics_v2_owner_day_price")} (owner_digest, day, price_basis_id, usage_events,
        unpriced_events, partially_priced_events, projection_version, codec, inputs, inputs_sha256, input_events, run_id,
        kernel_id, manifest_version)
      SELECT owner_digest, day, price_basis_id, usage_events, unpriced_events, partially_priced_events,
             projection_version, codec, decode(inputs, 'base64'), inputs_sha256, input_events, $2::uuid, $3::smallint, 1
        FROM jsonb_to_recordset($1::jsonb) AS r(owner_digest text, day date, price_basis_id integer,
          usage_events integer, unpriced_events integer, partially_priced_events integer, projection_version text,
          codec text, inputs text, inputs_sha256 text, input_events integer)`,
    [JSON.stringify(priceRows.slice(start, start + 2_000)), runId, kernelId]);
  }
}

/** Register `kernelId`'s pricing class under `pricer`, as that kernel's own run would (its cards are this bundle's). */
async function registerClass(pool, schema, kernelId, pricer) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const registered = await storePrice.registerAnalyticsV2KernelPrices(client, `"${schema}"`, stamp(kernelId), NOW,
      bundleCards, pricer);
    await client.query("COMMIT");
    return registered.pricingClass;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function emptyOutputs() {
  const nowMs = Date.parse(NOW);
  return {
    contractVersion: contract.ANALYTICS_V2_CONTRACT_VERSION, mode: "full", nowMs, today: NOW.slice(0, 10), revisionSeed: 0,
    owners: [], ownerDays: [], ownerDayPrices: [], cacheBands: [], ownerFits: [], ownerModelDates: [], dailyCandidates: [],
    blockedDays: [], ownerSets: { contributionRetainedEvidenceAbsent: 0, savedMembersFolded: 0,
      memberContributionUnavailableDays: [], memberLinkUnavailableDays: [] },
    preview: null, refusals: [], journal: { lastSequence: null }, timings: {},
  };
}

async function write(pool, schema, runStamp, options = {}) {
  const client = await pool.connect();
  try {
    return await store.writeRunOutputs(client, emptyOutputs(), { schema, runId: randomUUID(), startedAtMs: Date.parse(NOW),
      expectedCursor: null, horizon: HORIZON, stamp: runStamp, exclusionsSha256: NO_ANALYTICS_V2_EXCLUSIONS_SHA256,
      wallClock: () => Date.parse(NOW), ...options });
  } finally {
    client.release();
  }
}

async function prove(pool, schema, toKernel, options = {}) {
  const client = await pool.connect();
  try {
    return await store.proveAnalyticsV2PriceTransitions(client, { schema, stamp: stamp(toKernel), ...options });
  } finally {
    client.release();
  }
}

/** Every row of the given tables, canonicalized. */
async function snapshot(pool, schema, tables) {
  const rows = {};
  for (const table of tables) {
    rows[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text
      AS rows FROM ${quoted(schema, table)} t`)).rows[0].rows;
  }
  return rows;
}

const withoutEstablishment = ({ establishment: _establishment, ...proof }) => proof;
const count = async (pool, schema, table) =>
  (await pool.query(`SELECT count(*)::integer AS n FROM ${quoted(schema, table)}`)).rows[0].n;

/** A stored state with many priced owner-days, a refused one and one without a price row. */
function corpus(days) {
  const rows = [];
  for (let index = 0; index < days; index++) {
    const day = dayOf(index);
    rows.push([index % 2 === 0 ? OWNER_A : OWNER_B, day,
      [priced("gpt-5.6-sol", day), priced("gpt-5.6-sol", day, 7 + index), priced("synthetic-unpriced-model", day)]]);
  }
  rows.push([OWNER_A, dayOf(days + 1), "refused"]);
  rows.push([OWNER_B, dayOf(days + 2), "no-price"]);
  return rows;
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

test("PG17: the pricing-classes migration refuses a schema without the price cards and creates nothing", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  const priceCards = (await readPostgresMigrations({ role: "primary" })).find((migration) => PRICE_FILE.test(migration.name));
  assert.ok(priceCards, "the price cards are a promoted primary migration");
  await withSchema("prior", async ({ pool, schema, prefixRoot }) => {
    const prior = await applyStockAndStagedMigrations({ role: "primary", schema, pool, stagedFiles: [],
      rootDirectory: prefixRoot });
    assert.equal(prior.stockApplied, priceCards.version - 1, "the chain stops before the price cards");
    const sql = await readFile(join(classFile.directory, classFile.name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await assert.rejects(client.query(sql), (error) => error?.code === "42P01"
        && /analytics_v2_kernel_prices/u.test(String(error.message)));
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const created = await pool.query(`SELECT count(*)::integer AS n FROM pg_class c JOIN pg_namespace n
      ON n.oid = c.relnamespace WHERE n.nspname = $1 AND (c.relname LIKE '%pricing\\_class%'
        OR c.relname = 'analytics_v2_transition_proofs')`, [schema]);
    assert.equal(created.rows[0].n, 0);
  }, { prefixBelow: priceCards.version });
});

test("PG17: the pricing-class tables are closed and append-only, and hold a class to its kernels", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  await withSchema("constraints", async ({ pool, schema }) => {
    const t = (table) => quoted(schema, table);
    const tables = storePrice.ANALYTICS_V2_PRICING_CLASS_TABLES;
    for (const [key, table] of Object.entries(tables)) {
      const columns = await pool.query(`SELECT column_name::text AS name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, table]);
      assert.deepEqual(columns.rows.map((row) => row.name), [...storePrice.ANALYTICS_V2_PRICING_CLASS_COLUMNS[key]], table);
      const primaryKey = await pool.query(`SELECT a.attname::text AS name FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`,
      [`"${schema}"."${table}"`]);
      assert.deepEqual(primaryKey.rows.map((row) => row.name), [...storePrice.ANALYTICS_V2_PRICING_CLASS_PRIMARY_KEYS[key]]);
      // No owner-scoped column: nothing here joins the offline purge inventory.
      assert.equal(columns.rows.some((row) => row.name === "owner_digest"), false);
    }
    // The first write of a kernel built with a pricer registers its class.
    await write(pool, schema, stamp(1));
    const expected = await kernelModule.analyticsV2PricingClass({ pricer: PRICER_A,
      projectionVersion: prices.ANALYTICS_V2_PRICE_PROJECTION_VERSION, cardsSha256: bundleCards.cardsSha256 });
    assert.deepEqual((await pool.query(`SELECT pricing_class_id, class_sha256, pricer_sha256, pricing_method_version,
        projection_version, cards_sha256, first_kernel_id FROM ${t(tables.pricingClasses)}`)).rows,
    [{ pricing_class_id: 1, class_sha256: expected.classSha256, pricer_sha256: PRICER_A.pricerSha256,
      pricing_method_version: METHOD, projection_version: prices.ANALYTICS_V2_PRICE_PROJECTION_VERSION,
      cards_sha256: bundleCards.cardsSha256, first_kernel_id: 1 }]);
    assert.deepEqual((await pool.query(`SELECT kernel_id, pricing_class_id FROM ${t(tables.kernelPricingClasses)}`)).rows,
      [{ kernel_id: 1, pricing_class_id: 1 }]);
    const refused = { code: "P1005" };
    for (const [table, set] of [[tables.pricingClasses, "pricer_sha256 = pricer_sha256"],
      [tables.kernelPricingClasses, "pricing_class_id = pricing_class_id"]]) {
      await assert.rejects(pool.query(`UPDATE ${t(table)} SET ${set}`), refused, table);
      await assert.rejects(pool.query(`DELETE FROM ${t(table)}`), refused, table);
      await assert.rejects(pool.query(`TRUNCATE ${t(table)} CASCADE`), refused, table);
    }
    // A kernel's class names exactly that kernel's cards and projection.
    await seedOlderKernel(pool, schema, { kernelId: 2, days: [] });
    await pool.query(`INSERT INTO ${t(tables.pricingClasses)} VALUES (2, $1, $2, $3, $4, $5, 1, $6)`,
      [digest("other-class"), PRICER_B.pricerSha256, METHOD, prices.ANALYTICS_V2_PRICE_PROJECTION_VERSION,
        digest("other-cards"), NOW]);
    await assert.rejects(pool.query(`INSERT INTO ${t(tables.kernelPricingClasses)} VALUES (2, 2, $1)`, [NOW]), refused,
      "a class with other cards");
    for (const [values, code] of [[[3, "A".repeat(64), METHOD], "23514"], [[3, digest("c3"), "bad method!"], "23514"]]) {
      await assert.rejects(pool.query(`INSERT INTO ${t(tables.pricingClasses)} VALUES ($1, $2, $4, $3, $5, $4, 1, $6)`,
        [...values, PRICER_B.pricerSha256, prices.ANALYTICS_V2_PRICE_PROJECTION_VERSION, NOW]), { code });
    }
    // A proof method row: method 2 names a class both kernels are in.
    const runId = (await pool.query(`SELECT run_id FROM ${t("analytics_v2_runs")} LIMIT 1`)).rows[0].run_id;
    await pool.query(`INSERT INTO ${t("analytics_v2_kernel_transitions")} (transition_id, from_kernel, to_kernel,
        compute_equal, proof_holds, compatible, cards_added, cards_removed, cards_changed, owner_days, events,
        stale_owner_days, proof_run, recorded_at) VALUES (1, 1, 2, true, true, true, 0, 0, 0, 0, 0, 0, $1, $2)`,
    [runId, NOW]);
    const proof = (values) => pool.query(`INSERT INTO ${t(tables.transitionProofs)} (transition_id, method,
        pricing_class_id, sample_divisor, repriced_owner_days, repriced_events) VALUES (1, $1, $2, $3, 0, 0)`, values);
    await assert.rejects(proof([2, 1, 100]), refused, "kernel 2 is not in class 1");
    await assert.rejects(proof([2, null, 100]), (error) => ["P1005", "23514"].includes(error?.code),
      "method 2 names its class");
    await assert.rejects(proof([1, 1, null]), { code: "23514" }, "method 1 names none");
    await assert.rejects(proof([3, null, null]), { code: "23514" });
    await proof([1, null, null]);
    await assert.rejects(pool.query(`UPDATE ${t(tables.transitionProofs)} SET method = 1`), refused);
    await assert.rejects(pool.query(`DELETE FROM ${t(tables.transitionProofs)}`), refused);
    await assert.rejects(pool.query(`TRUNCATE ${t(tables.transitionProofs)}`), refused);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("PG17: a kernel's pricing class is registered once, shared by an equal class, and never replaced", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  await withSchema("registration", async ({ pool, schema }) => {
    const tables = storePrice.ANALYTICS_V2_PRICING_CLASS_TABLES;
    await write(pool, schema, stamp(1));
    await write(pool, schema, stamp(1));
    assert.equal(await count(pool, schema, tables.pricingClasses), 1);
    assert.equal(await count(pool, schema, tables.kernelPricingClasses), 1);
    // Another kernel with the same pricer and cards is in the same class.
    await write(pool, schema, stamp(2));
    assert.deepEqual((await pool.query(`SELECT kernel_id, pricing_class_id
      FROM ${quoted(schema, tables.kernelPricingClasses)} ORDER BY kernel_id`)).rows,
    [{ kernel_id: 1, pricing_class_id: 1 }, { kernel_id: 2, pricing_class_id: 1 }]);
    // A registered kernel stating another pricer is refused, and the transaction leaves nothing.
    await assert.rejects(registerClass(pool, schema, 2, PRICER_B), { code: "ANALYTICS_V2_PRICING_CLASS_CONFLICT" });
    assert.equal(await count(pool, schema, tables.pricingClasses), 1);
    // A bundle stating no pricer registers nothing (unknown) and is not a conflict.
    assert.equal(await registerClass(pool, schema, 2, null), null);
    await seedOlderKernel(pool, schema, { kernelId: 3, days: [] });
    assert.deepEqual(await registerClass(pool, schema, 3, PRICER_B), { pricingClassId: 2,
      classSha256: (await kernelModule.analyticsV2PricingClass({ pricer: PRICER_B,
        projectionVersion: prices.ANALYTICS_V2_PRICE_PROJECTION_VERSION, cardsSha256: bundleCards.cardsSha256 })).classSha256 });
  });
});

// ---------------------------------------------------------------------------
// The transition proof
// ---------------------------------------------------------------------------

test("PG17: a kernel bump in one pricing class is proven by identity with a sampled reprice, exactly as a full reprice", {
  skip: PG_SKIP, timeout: 600_000,
}, async () => {
  const days = corpus(240);
  const pricedDays = days.filter(([, , events]) => Array.isArray(events)).length;
  const events = pricedDays * 3;
  const runId = randomUUID();
  const outcomes = {};
  for (const label of ["identity", "unknown"]) {
    await withSchema(`proof-${label}`, async ({ pool, schema }) => {
      await seedOlderKernel(pool, schema, { kernelId: 1, days });
      // Kernel 1 was built with the same pricer as this bundle, or before W1E (no class).
      if (label === "identity") assert.deepEqual(await registerClass(pool, schema, 1, PRICER_A), { pricingClassId: 1,
        classSha256: (await kernelModule.analyticsV2PricingClass({ pricer: PRICER_A,
          projectionVersion: prices.ANALYTICS_V2_PRICE_PROJECTION_VERSION, cardsSha256: bundleCards.cardsSha256 })).classSha256 });
      const bundled = await prove(pool, schema, 2);
      const unknown = await prove(pool, schema, 2, { pricer: null });
      const other = await prove(pool, schema, 2, { pricer: PRICER_B });
      const [proof] = bundled.transitions;
      assert.equal(proof.ownerDays, days.length);
      assert.equal(proof.events, events);
      assert.equal(proof.compatible, true);
      assert.deepEqual(proof.stale.map((entry) => [entry.ownerDigest, entry.day, entry.cause]),
        [[OWNER_B, dayOf(242), 3]]);
      // Every method finds the same verdict, counts and stale set.
      assert.deepEqual(withoutEstablishment(unknown.transitions[0]), withoutEstablishment(proof));
      assert.deepEqual(withoutEstablishment(other.transitions[0]), withoutEstablishment(proof));
      assert.equal(unknown.transitions[0].establishment, undefined, "a bundle without a pricer records no method");
      assert.deepEqual({ ...other.transitions[0].establishment }, { method: 1, pricingClassId: null, sampleDivisor: null,
        repricedOwnerDays: pricedDays, repricedEvents: events });
      if (label === "identity") {
        const classSha256 = (await kernelModule.analyticsV2PricingClass({ pricer: PRICER_A,
          projectionVersion: prices.ANALYTICS_V2_PRICE_PROJECTION_VERSION, cardsSha256: bundleCards.cardsSha256 })).classSha256;
        let sampled = 0, first = true;
        for (const [ownerDigest, day, dayEvents] of [...days].sort((left, right) => (left[0] + left[1] < right[0] + right[1] ? -1 : 1))) {
          if (!Array.isArray(dayEvents)) continue;
          if (first || await storePrice.analyticsV2PricingClassSampled({ classSha256, fromKernel: 1, toKernel: 2,
            ownerDigest, day })) sampled += 1;
          first = false;
        }
        assert.ok(sampled >= 1 && sampled < pricedDays / 10, `about 1 in 100 owner-days is repriced (${sampled})`);
        assert.deepEqual({ ...proof.establishment }, { method: 2, pricingClassId: 1, sampleDivisor: 100,
          repricedOwnerDays: sampled, repricedEvents: sampled * 3 });
      } else {
        assert.equal(proof.establishment.method, 1, "an older kernel of unknown class is repriced in full (M4)");
      }
      // The run records the proven transition; only how it was established differs.
      await write(pool, schema, stamp(2), { runId, priceTransitions: bundled });
      outcomes[label] = {
        derived: await snapshot(pool, schema, Object.values(contract.ANALYTICS_V2_TABLES)),
        method: (await pool.query(`SELECT method, pricing_class_id, sample_divisor, repriced_owner_days,
          repriced_events::integer AS repriced_events
          FROM ${quoted(schema, storePrice.ANALYTICS_V2_PRICING_CLASS_TABLES.transitionProofs)}`)).rows,
        linked: (await pool.query(`SELECT kernel_id, pricing_class_id
          FROM ${quoted(schema, storePrice.ANALYTICS_V2_PRICING_CLASS_TABLES.kernelPricingClasses)} ORDER BY 1`)).rows,
      };
    });
  }
  assert.deepEqual(outcomes.identity.derived, outcomes.unknown.derived, "every analytics_v2 table is byte-identical");
  assert.equal(outcomes.identity.method.length, 1);
  assert.equal(outcomes.identity.method[0].method, 2);
  assert.deepEqual(outcomes.unknown.method, [{ method: 1, pricing_class_id: null, sample_divisor: null,
    repriced_owner_days: pricedDays, repriced_events: events }]);
  assert.deepEqual(outcomes.identity.linked, [{ kernel_id: 1, pricing_class_id: 1 }, { kernel_id: 2, pricing_class_id: 1 }]);
  assert.deepEqual(outcomes.unknown.linked, [{ kernel_id: 2, pricing_class_id: 1 }]);
});

test("PG17: a sampled owner-day that prices differently fails the run; a full reprice reports it as a violation", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  await withSchema("mismatch", async ({ pool, schema }) => {
    await seedOlderKernel(pool, schema, { kernelId: 1, days: corpus(12) });
    await registerClass(pool, schema, 1, PRICER_A);
    // A pricer the class does not describe: one nanodollar more for every priced event.
    const drifted = (input) => {
      const price = prices.priceAnalyticsV2Input(input);
      return price.status >= prices.ANALYTICS_V2_PRICE_STATUS.partiallyPriced
        ? { ...price, costNanousd: price.costNanousd + 1 } : price;
    };
    await assert.rejects(prove(pool, schema, 2, { price: drifted }), { code: "ANALYTICS_V2_PRICING_CLASS_SAMPLE_MISMATCH" });
    const full = await prove(pool, schema, 2, { price: drifted, pricer: PRICER_B });
    assert.equal(full.transitions[0].proofHolds, false);
    assert.equal(full.transitions[0].compatible, false);
    assert.equal(full.transitions[0].establishment.method, 1);
    // Nothing was written by the failed proofs.
    assert.equal(await count(pool, schema, "analytics_v2_kernel_transitions"), 0);
  });
});

test("PG17: an identity proof recorded where the kernels are not in one class is refused atomically", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  let forged;
  await withSchema("forge-source", async ({ pool, schema }) => {
    await seedOlderKernel(pool, schema, { kernelId: 1, days: corpus(6) });
    await registerClass(pool, schema, 1, PRICER_A);
    forged = await prove(pool, schema, 2);
    assert.equal(forged.transitions[0].establishment.method, 2);
  });
  await withSchema("forge-target", async ({ pool, schema }) => {
    await seedOlderKernel(pool, schema, { kernelId: 1, days: corpus(6) });
    const before = await snapshot(pool, schema, Object.values(contract.ANALYTICS_V2_TABLES));
    // The migration's trigger refuses it (store.ts reports a refused write as ANALYTICS_V2_WRITE_FAILED with its SQL state).
    await assert.rejects(write(pool, schema, stamp(2), { priceTransitions: forged }),
      { code: "ANALYTICS_V2_WRITE_FAILED", sqlState: "P1005" });
    assert.deepEqual(await snapshot(pool, schema, Object.values(contract.ANALYTICS_V2_TABLES)), before);
    assert.equal(await count(pool, schema, storePrice.ANALYTICS_V2_PRICING_CLASS_TABLES.transitionProofs), 0);
    // A malformed establishment is refused by the store itself, before its row (store.ts reports the store
    // module's own closed codes only for its own error classes; this one ends the write as ANALYTICS_V2_WRITE_FAILED).
    const bad = { ...forged, transitions: [{ ...forged.transitions[0], establishment: { ...forged.transitions[0].establishment,
      sampleDivisor: 7 } }] };
    await assert.rejects(write(pool, schema, stamp(2), { priceTransitions: bad }), (error) =>
      error?.code === "ANALYTICS_V2_WRITE_FAILED" && error?.sqlState === undefined);
    assert.deepEqual(await snapshot(pool, schema, Object.values(contract.ANALYTICS_V2_TABLES)), before);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(storePrice.recordAnalyticsV2PriceTransitions(client, `"${schema}"`, bad, stamp(2),
        randomUUID(), NOW), { code: "ANALYTICS_V2_PRICING_CLASS_STATE_INVALID" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// Measurement (opt-in)
// ---------------------------------------------------------------------------

const BENCH = /^(\d+)x(\d+)$/u.exec(process.env.ANALYTICS_V2_PRICING_CLASS_BENCH ?? "");

test("PG17 bench: the transition proof's run-start time by full reprice and by pricing-class identity", {
  skip: PG_SKIP || (BENCH === null ? "set ANALYTICS_V2_PRICING_CLASS_BENCH=<owner-days>x<events>" : false),
  timeout: 3_600_000,
}, async () => {
  const ownerDays = Number(BENCH[1]), perDay = Number(BENCH[2]);
  await withSchema("bench", async ({ pool, schema }) => {
    const models = ["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "synthetic-unpriced-model"];
    const rows = [];
    for (let index = 0; index < ownerDays; index++) {
      const day = dayOf(index % 300);
      const owner = digest(`bench-owner-${Math.floor(index / 300)}`);
      rows.push([owner, day, Array.from({ length: perDay }, (_, event) => priced(models[event % models.length], day,
        1 + ((index * perDay + event) % 9_973)))]);
    }
    const seedStarted = Date.now();
    await seedOlderKernel(pool, schema, { kernelId: 1, days: rows });
    await registerClass(pool, schema, 1, PRICER_A);
    await pool.query(`ANALYZE ${quoted(schema, "analytics_v2_owner_day")}`);
    await pool.query(`ANALYZE ${quoted(schema, "analytics_v2_owner_day_price")}`);
    const seedMs = Date.now() - seedStarted;
    const timed = async (options) => {
      const started = process.hrtime.bigint();
      const result = await prove(pool, schema, 2, options);
      return { ms: Number(process.hrtime.bigint() - started) / 1e6, proof: result.transitions[0] };
    };
    // Warm both paths once, then measure each three times, alternating.
    await timed({ pricer: PRICER_B });
    await timed({});
    const full = [], identity = [];
    for (let round = 0; round < 3; round++) {
      full.push(await timed({ pricer: PRICER_B }));
      identity.push(await timed({}));
    }
    assert.deepEqual(withoutEstablishment(identity[0].proof), withoutEstablishment(full[0].proof));
    const median = (values) => values.map((value) => value.ms).sort((left, right) => left - right)[1];
    const report = { ownerDays, eventsPerDay: perDay, events: ownerDays * perDay, seedMs,
      fullMs: full.map((value) => Math.round(value.ms)), identityMs: identity.map((value) => Math.round(value.ms)),
      fullMedianMs: Math.round(median(full)), identityMedianMs: Math.round(median(identity)),
      savedMedianMs: Math.round(median(full) - median(identity)),
      fullUsPerEvent: Number((median(full) * 1_000 / (ownerDays * perDay)).toFixed(3)),
      identityUsPerEvent: Number((median(identity) * 1_000 / (ownerDays * perDay)).toFixed(3)),
      identityRepricedOwnerDays: identity[0].proof.establishment.repricedOwnerDays };
    console.log(`ANALYTICS_V2_PRICING_CLASS_BENCH ${JSON.stringify(report)}`);
  });
});
