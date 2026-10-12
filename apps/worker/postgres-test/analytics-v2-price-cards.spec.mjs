/**
 * PG17 spec for K-PERCARD's per-card price staleness (primary 0072
 * analytics_v2_price_cards, staged as 0912 until the K-PERCARD merge;
 * src/analytics-v2/store-price.ts): the migration's
 * closed tables and fail-closed constraints, the store's card and basis
 * registration, and the kernel transitions it records from older stored
 * kernels, with the stale owner-days and the derived-regime dirtiness that
 * follow.
 *
 * Each case applies the stock primary chain through the production runner
 * and the price-cards file (stock once promoted, otherwise staged) through
 * the staged-migrations harness into a fresh random schema (dropped
 * afterwards). Older kernels' stored rows are
 * written by hand, with price inputs encoded by the real attribution module,
 * so a transition can be proven over states this bundle's own kernel cannot
 * produce (a changed card, a stale price). Synthetic, content-free values
 * only.
 *
 * Run: PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket \
 *      PG_TEST_PORT=55433 node --test postgres-test/analytics-v2-price-cards.spec.mjs
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
const PRICE_FILE = /^\d{4}_analytics_v2_price_cards\.sql$/u;
const ENDPOINT = await postgresTestEndpoint();
const PG_SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) and PG_TEST_PORT for the local PostgreSQL 17 cluster"
  : false;
const HORIZON = Object.freeze({ ownerDayFromDay: "2026-01-01", cacheBandsFromDay: "2026-01-01" });
const NOW = "2026-10-01T12:00:00.000Z";
const D1 = "2026-09-20";
const D2 = "2026-09-21";
const D3 = "2026-09-22";
const digest = (label) => createHash("sha256").update(`analytics-v2-price-cards-spec:${label}`).digest("hex");
const OWNER_A = digest("owner-a");
const OWNER_B = digest("owner-b");
const CLASS_X = digest("compute-class-x");
const CLASS_Y = digest("compute-class-y");

let vite;
let store;
let prices;
let contract;
let registry;
/** The vendored kernels (their daily-value validator and registry identity). */
let kernels;
let priceFileName;
let priceFileDirectory;
/** The bundle's own kernel cards. */
let bundleCards;

before(async () => {
  vite = await createServer({ root: WORKER_ROOT, configFile: false, plugins: analyticsV2Config.plugins,
    resolve: analyticsV2Config.resolve, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    logLevel: "silent" });
  const load = (path) => vite.ssrLoadModule(path);
  store = await load("/src/analytics-v2/store.ts");
  prices = await load("/src/analytics-v2/price-attribution.ts");
  contract = await load("/src/analytics-v2/contract.ts");
  kernels = await load("/vendor/analytics-d43c8f92/entry.ts");
  registry = store.analyticsV2KernelRegistry();
  bundleCards = await prices.analyticsV2KernelPriceCards();
  const staged = (await readdir(STAGED_DIRECTORY).catch(() => [])).find((name) => PRICE_FILE.test(name));
  const promoted = (await readdir(PRIMARY_MIGRATIONS_DIRECTORY)).find((name) => PRICE_FILE.test(name));
  priceFileName = staged ?? promoted;
  priceFileDirectory = staged === undefined ? PRIMARY_MIGRATIONS_DIRECTORY : STAGED_DIRECTORY;
  assert.ok(priceFileName, "the analytics_v2_price_cards migration is staged or promoted");
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
    application_name: `analytics-v2-price-cards-spec-${label}`, options: "-c search_path=pg_catalog" });
  const schema = `analytics_v2_prices_${randomBytes(5).toString("hex")}`;
  let prefixRoot = null;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    if (prefixBelow === null) {
      await applyStockAndStagedMigrations({ role: "primary", schema, pool, stagedFiles: [priceFileName] });
    } else {
      prefixRoot = await mkdtemp(join(tmpdir(), "analytics-v2-price-cards-"));
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
function stamp(kernelId, computeSha256) {
  const kernel = { ...registry[0], kernelId, computeClosureSha256: digest(`closure-${kernelId}`) };
  return computeSha256 === undefined ? { kernel, manifestVersion: 1 } : { kernel, manifestVersion: 1, computeSha256 };
}

/** A synthetic v1.1 usage record's price projection for `modelId` on `day`. */
function input(modelId, day) {
  return prices.analyticsV2PriceInput({ provider: "openai_codex", modelId, billingSurface: "chatgpt_subscription",
    speedMode: "standard", apiServiceTier: "default", reasoningEffort: "high", eventTime: `${day}T12:00:00.000Z`,
    totalInputContextTokens: 1000, components: { inputUncachedTokens: 100, inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0, outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null } });
}

/** One owner-day's price row as the compute side emits it, from events priced by this bundle. */
async function priceRow(ownerDigest, day, events) {
  const { inputs, cardIds } = await prices.encodeAnalyticsV2PriceInputs(events);
  const unpriced = events.filter((event) => event.priced.status <= prices.ANALYTICS_V2_PRICE_STATUS.unpriced).length;
  const partial = events.filter((event) => event.priced.status === prices.ANALYTICS_V2_PRICE_STATUS.partiallyPriced).length;
  return { ownerDigest, day, cardIds, usageEvents: events.length, unpricedEvents: unpriced, partiallyPricedEvents: partial,
    inputs };
}

const priced = (modelId, day) => {
  const projection = input(modelId, day);
  return { input: projection, priced: prices.priceAnalyticsV2Input(projection) };
};

function outputs({ owners = [OWNER_A], ownerDays = [], ownerDayPrices = [] } = {}) {
  const nowMs = Date.parse(NOW);
  return {
    contractVersion: contract.ANALYTICS_V2_CONTRACT_VERSION, mode: "full", nowMs, today: NOW.slice(0, 10), revisionSeed: 0,
    owners: owners.map((ownerDigest) => ({ participantId: `participant-${ownerDigest.slice(0, 12)}`, ownerDigest,
      hasV1: false, hasV11: false, hasV12: true, hasLegacy: false, hasEffective: true, source: "effective" })),
    ownerDays, ownerDayPrices, cacheBands: [], ownerFits: [], ownerModelDates: [], dailyCandidates: [], blockedDays: [],
    // E-OWNERSET: no published day, so no saved owner set is folded or recorded.
    ownerSets: { contributionRetainedEvidenceAbsent: 0, savedMembersFolded: 0, memberContributionUnavailableDays: [],
      memberLinkUnavailableDays: [] },
    preview: null, refusals: [], journal: { lastSequence: null }, timings: {},
  };
}

async function write(client, schema, runStamp, runOutputs, options = {}) {
  return store.writeRunOutputs(client, runOutputs, { schema, runId: randomUUID(), startedAtMs: Date.parse(NOW),
    expectedCursor: null, horizon: HORIZON, stamp: runStamp, exclusionsSha256: NO_ANALYTICS_V2_EXCLUSIONS_SHA256,
    ...options });
}

/** One computed owner-day with daily values and its price row. */
async function computedDay(ownerDigest, day, events) {
  return { ownerDay: { ownerDigest, day, daily: { synthetic: true }, refusal: null },
    price: await priceRow(ownerDigest, day, events) };
}

/** Every analytics_v2 row, canonicalized, for exact before/after comparison. */
async function snapshot(pool, schema) {
  const rows = {};
  for (const table of Object.values(contract.ANALYTICS_V2_TABLES)) {
    rows[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text
      AS rows FROM ${quoted(schema, table)} t`)).rows[0].rows;
  }
  return rows;
}

const count = async (pool, schema, table) =>
  (await pool.query(`SELECT count(*)::integer AS n FROM ${quoted(schema, table)}`)).rows[0].n;

/**
 * Write an older kernel's stored state by hand: its kernel row (priced under
 * `registrySha256`, by default this bundle's registry), its price
 * registration (this bundle's cards with `changed` card ids given other
 * content and `omitted` card ids left out; no registration when `cards` is
 * false), owner-day rows and their price rows. A day is [owner, day, events]
 * with events an array, "no-price" or "refused", and an optional fourth
 * element: its stored daily value (by default a synthetic placeholder).
 */
async function seedOlderKernel(pool, schema, { kernelId, computeSha256, changed = [], omitted = [], cards = true, days,
  registrySha256 = null }) {
  const kernel = stamp(kernelId).kernel;
  const runId = randomUUID();
  await pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_kernels")} (kernel_id, production_commit,
      vendor_manifest_sha256, compute_closure_sha256, price_registry_sha256, price_registry_version, method_version,
      registered_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [kernelId, kernel.productionCommit, kernel.vendorManifestSha256, kernel.computeClosureSha256,
    registrySha256 ?? kernel.priceRegistrySha256, kernel.priceRegistryVersion, kernel.methodVersion, NOW]);
  const refs = new Map();
  if (cards) {
    const own = bundleCards.cards.filter((card) => !omitted.includes(card.cardId)).map((card) => changed.includes(card.cardId)
      ? { cardId: card.cardId, contentSha256: digest(`changed-${card.cardId}`) } : card);
    await pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_kernel_prices")} (kernel_id, compute_sha256, cards_sha256,
        cards, projection_version, registered_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [kernelId, computeSha256, await prices.analyticsV2PriceCardSetSha256(own), own.length,
      prices.ANALYTICS_V2_PRICE_PROJECTION_VERSION, NOW]);
    const top = (await pool.query(`SELECT coalesce(max(card_ref), 0)::integer AS top
      FROM ${quoted(schema, "analytics_v2_price_cards")}`)).rows[0].top;
    for (const [index, card] of own.entries()) {
      refs.set(card.cardId, top + index + 1);
      await pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_price_cards")} (card_ref, card_id, content_sha256,
          first_kernel_id) VALUES ($1, $2, $3, $4)`, [top + index + 1, card.cardId, card.contentSha256, kernelId]);
      await pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_kernel_cards")} (kernel_id, card_ref, card_id)
        VALUES ($1, $2, $3)`, [kernelId, top + index + 1, card.cardId]);
    }
  }
  for (const [ownerDigest, day, events, daily = { synthetic: true }] of days) {
    await pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_owner_day")} (owner_digest, day, daily, refusal, run_id,
        kernel_id, manifest_version) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
    [ownerDigest, day, events === "refused" ? null : JSON.stringify(daily),
      events === "refused" ? "source_conflict_or_order" : null, runId, kernelId]);
    if (!Array.isArray(events)) continue;
    const row = await priceRow(ownerDigest, day, events);
    const refList = row.cardIds.map((cardId) => refs.get(cardId)).sort((left, right) => left - right);
    const basisSha256 = digest(`basis-${kernelId}-${refList.join(",")}`);
    let basis = await pool.query(`SELECT price_basis_id FROM ${quoted(schema, "analytics_v2_price_bases")}
      WHERE basis_sha256 = $1`, [basisSha256]);
    if (basis.rows.length === 0) {
      basis = await pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_price_bases")} (price_basis_id, basis_sha256,
          card_refs) SELECT coalesce(max(price_basis_id), 0) + 1, $1, $2::integer[]
          FROM ${quoted(schema, "analytics_v2_price_bases")} RETURNING price_basis_id`, [basisSha256, refList]);
    }
    await pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_owner_day_price")} (owner_digest, day, price_basis_id,
        usage_events, unpriced_events, partially_priced_events, projection_version, codec, inputs, inputs_sha256,
        input_events, run_id, kernel_id, manifest_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, decode($9, 'base64'), $10, $11, $12, $13, 1)`,
    [ownerDigest, day, basis.rows[0].price_basis_id, row.usageEvents, row.unpricedEvents, row.partiallyPricedEvents,
      row.inputs.projectionVersion, row.inputs.codec, row.inputs.data, row.inputs.sha256, row.inputs.events, runId,
      kernelId]);
  }
}

async function transitions(pool, schema) {
  return (await pool.query(`SELECT from_kernel, to_kernel, compute_equal, proof_holds, compatible, cards_added,
      cards_removed, cards_changed, owner_days, events::integer AS events, stale_owner_days
     FROM ${quoted(schema, "analytics_v2_kernel_transitions")} ORDER BY transition_id`)).rows;
}

async function staleRows(pool, schema) {
  return (await pool.query(`SELECT t.from_kernel, t.to_kernel, s.owner_digest, s.day::text AS day, s.cause
     FROM ${quoted(schema, "analytics_v2_transition_stale")} s
     JOIN ${quoted(schema, "analytics_v2_kernel_transitions")} t ON t.transition_id = s.transition_id
    ORDER BY t.transition_id, s.owner_digest, s.day`)).rows;
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

test("PG17: the price-cards migration refuses a schema without the run stamps and creates nothing", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  const runStamps = (await readPostgresMigrations({ role: "primary" })).find((migration) =>
    /_analytics_v2_run_stamps\.sql$/u.test(migration.name));
  assert.ok(runStamps, "the run stamps are a promoted primary migration");
  await withSchema("prior", async ({ pool, schema, prefixRoot }) => {
    // The chain before the run stamps, then the price-cards SQL by hand (the
    // harness only applies a staged file, and a promoted one is not in the
    // prefix): it fails on the missing analytics_v2_kernels and rolls back.
    const prior = await applyStockAndStagedMigrations({ role: "primary", schema, pool, stagedFiles: [],
      rootDirectory: prefixRoot });
    assert.equal(prior.stockApplied, runStamps.version - 1, "the chain stops before the run stamps");
    const sql = await readFile(join(priceFileDirectory, priceFileName), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await assert.rejects(client.query(sql), (error) => error?.code === "42P01"
        && /analytics_v2_kernels/u.test(String(error.message)));
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const created = await pool.query(`SELECT count(*)::integer AS n FROM pg_class c JOIN pg_namespace n
      ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname LIKE 'analytics\\_v2\\_%price%'`, [schema]);
    assert.equal(created.rows[0].n, 0, "nothing of the price tables was created");
  }, { prefixBelow: runStamps.version });
});

test("PG17: the price tables are closed, append-only and tied to their owner-day rows", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  await withSchema("constraints", async ({ pool, schema }) => {
    const client = await pool.connect();
    try {
      const [first] = [await computedDay(OWNER_A, D1, [priced("gpt-5.6-sol", D1)])];
      await write(client, schema, stamp(1, CLASS_X), outputs({ ownerDays: [first.ownerDay], ownerDayPrices: [first.price] }));
    } finally {
      client.release();
    }
    const t = (table) => quoted(schema, table);
    const refused = { code: "P1005" };
    // Every registration table refuses UPDATE, DELETE and TRUNCATE.
    for (const [table, set] of [["analytics_v2_kernel_prices", "cards = cards"], ["analytics_v2_price_cards", "card_id = card_id"],
      ["analytics_v2_kernel_cards", "card_id = card_id"], ["analytics_v2_price_bases", "basis_sha256 = basis_sha256"]]) {
      await assert.rejects(pool.query(`UPDATE ${t(table)} SET ${set}`), refused, table);
      await assert.rejects(pool.query(`DELETE FROM ${t(table)}`), refused, table);
      await assert.rejects(pool.query(`TRUNCATE ${t(table)} CASCADE`), refused, table);
    }
    // A price row is never updated; it must belong to an owner-day row with
    // daily values, from the same run and kernel.
    const row = (await pool.query(`SELECT * FROM ${t("analytics_v2_owner_day_price")}`)).rows[0];
    await assert.rejects(pool.query(`UPDATE ${t("analytics_v2_owner_day_price")} SET usage_events = usage_events`), refused);
    const insertPrice = (overrides, on = pool) => {
      const value = { ...row, ...overrides };
      return on.query(`INSERT INTO ${t("analytics_v2_owner_day_price")} (owner_digest, day, price_basis_id, usage_events,
          unpriced_events, partially_priced_events, projection_version, codec, inputs, inputs_sha256, input_events, run_id,
          kernel_id, manifest_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [value.owner_digest, value.day, value.price_basis_id, value.usage_events, value.unpriced_events,
        value.partially_priced_events, value.projection_version, value.codec, value.inputs, value.inputs_sha256,
        value.input_events, value.run_id, value.kernel_id, value.manifest_version]);
    };
    await assert.rejects(insertPrice({ owner_digest: OWNER_B }), refused, "no owner-day row");
    await pool.query(`INSERT INTO ${t("analytics_v2_owner_day")} (owner_digest, day, daily, refusal, run_id, kernel_id,
        manifest_version) VALUES ($1, $2, NULL, 'source_conflict_or_order', $3, 1, 1)`, [OWNER_B, D1, row.run_id]);
    await assert.rejects(insertPrice({ owner_digest: OWNER_B }), refused, "a refused owner-day has no price");
    await pool.query(`INSERT INTO ${t("analytics_v2_owner_day")} (owner_digest, day, daily, refusal, run_id, kernel_id,
        manifest_version) VALUES ($1, $2, '{}', NULL, $3, 1, 1)`, [OWNER_B, D2, randomUUID()]);
    await assert.rejects(insertPrice({ owner_digest: OWNER_B, day: D2 }), refused, "another run's owner-day");
    await assert.rejects(insertPrice({ kernel_id: 9 }), refused, "another kernel's owner-day");
    const one = await pool.connect();
    try {
      for (const [overrides, code] of [[{ codec: "gzip" }, "23514"], [{ inputs: Buffer.alloc(0) }, "23514"],
        [{ input_events: row.usage_events + 1 }, "23514"], [{ unpriced_events: row.usage_events + 1 }, "23514"],
        [{ projection_version: "analytics-v2-price-input-v0" }, "23514"], [{ inputs_sha256: "A".repeat(64) }, "23514"],
        [{ price_basis_id: 999 }, "23503"]]) {
        await one.query("BEGIN");
        try {
          await one.query(`DELETE FROM ${t("analytics_v2_owner_day_price")}`);
          await assert.rejects(insertPrice(overrides, one), { code }, JSON.stringify(Object.keys(overrides)));
        } finally {
          await one.query("ROLLBACK");
        }
      }
    } finally {
      one.release();
    }
    // The owner-day delete takes its price row with it (the store replaces both).
    await pool.query(`DELETE FROM ${t("analytics_v2_owner_day")} WHERE owner_digest = $1`, [OWNER_A]);
    assert.equal(await count(pool, schema, "analytics_v2_owner_day_price"), 0);
    // A basis is sorted, unique, positive and names registered cards only.
    for (const refs of ["{2,1}", "{1,1}", "{{1},{2}}"]) {
      await assert.rejects(pool.query(`INSERT INTO ${t("analytics_v2_price_bases")} VALUES (900, $1, $2::integer[])`,
        [digest(refs), refs]), { code: "23514" }, refs);
    }
    for (const refs of ["{0}", "{1,NULL}", "{99999}"]) {
      await assert.rejects(pool.query(`INSERT INTO ${t("analytics_v2_price_bases")} VALUES (900, $1, $2::integer[])`,
        [digest(refs), refs]), (error) => ["P1005", "23514"].includes(error.code), refs);
    }
    // A transition's verdict is consistent: compatible only when both halves hold and its cards are known.
    const transition = (values) => pool.query(`INSERT INTO ${t("analytics_v2_kernel_transitions")}
        (transition_id, from_kernel, to_kernel, compute_equal, proof_holds, compatible, cards_added, cards_removed,
         cards_changed, owner_days, events, stale_owner_days, proof_run, recorded_at)
      VALUES (1, $1, $2, $3, $4, $5, $6, $6, $6, 1, 0, 0, $7, $8)`, values);
    const runId = (await pool.query(`SELECT run_id FROM ${t("analytics_v2_runs")} LIMIT 1`)).rows[0].run_id;
    await assert.rejects(transition([1, 1, true, true, true, 0, runId, NOW]), { code: "23514" }, "from < to");
    await pool.query(`INSERT INTO ${t("analytics_v2_kernels")} SELECT 2, production_commit, vendor_manifest_sha256,
      $1, price_registry_sha256, price_registry_version, method_version, registered_at
      FROM ${t("analytics_v2_kernels")} WHERE kernel_id = 1`, [digest("closure-2")]);
    await pool.query(`INSERT INTO ${t("analytics_v2_kernel_prices")} SELECT 2, compute_sha256, cards_sha256, cards,
      projection_version, registered_at FROM ${t("analytics_v2_kernel_prices")} WHERE kernel_id = 1`);
    await assert.rejects(transition([1, 2, true, false, true, 0, runId, NOW]), { code: "23514" }, "compatible needs the proof");
    await assert.rejects(transition([1, 2, false, true, true, 0, runId, NOW]), { code: "23514" }, "and the claim");
    await assert.rejects(transition([1, 2, true, true, true, null, runId, NOW]), { code: "23514" }, "and known cards");
    // Its proof run must exist when the transaction commits.
    await assert.rejects(transition([1, 2, false, true, false, null, randomUUID(), NOW]), { code: "23503" });
    await transition([1, 2, false, true, false, null, runId, NOW]);
    await assert.rejects(pool.query(`UPDATE ${t("analytics_v2_kernel_transitions")} SET compatible = false`), refused);
    await pool.query(`INSERT INTO ${t("analytics_v2_transition_stale")} VALUES (1, $1, $2, 3)`, [OWNER_A, D1]);
    await assert.rejects(pool.query(`INSERT INTO ${t("analytics_v2_transition_stale")} VALUES (1, $1, $2, 4)`,
      [OWNER_A, D2]), { code: "23514" });
    await assert.rejects(pool.query(`DELETE FROM ${t("analytics_v2_transition_stale")}`), refused);
    await assert.rejects(pool.query(`TRUNCATE ${t("analytics_v2_transition_stale")}`), refused);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("PG17: the store registers a kernel's cards and bases once, with stable ids, and refuses a disagreement atomically", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  await withSchema("registration", async ({ pool, schema }) => {
    const client = await pool.connect();
    try {
      const a1 = await computedDay(OWNER_A, D1, [priced("gpt-5.6-sol", D1), priced("synthetic-unpriced-model", D1)]);
      const a2 = await computedDay(OWNER_A, D2, [priced("gpt-5.6-sol", D2)]);
      const a3 = await computedDay(OWNER_A, D3, []);
      const run = outputs({ ownerDays: [a1.ownerDay, a2.ownerDay, a3.ownerDay],
        ownerDayPrices: [a1.price, a2.price, a3.price] });
      const first = await write(client, schema, stamp(1, CLASS_X), run);
      const cards = bundleCards.cards.length;
      assert.deepEqual(first.prices, { kernelCards: cards, cardsRegistered: cards, basesRegistered: 2, ownerDays: 3,
        transitions: [] });
      assert.deepEqual((await pool.query(`SELECT kernel_id, compute_sha256, cards_sha256, cards, projection_version
        FROM ${quoted(schema, "analytics_v2_kernel_prices")}`)).rows, [{ kernel_id: 1, compute_sha256: CLASS_X,
        cards_sha256: bundleCards.cardsSha256, cards, projection_version: prices.ANALYTICS_V2_PRICE_PROJECTION_VERSION }]);
      // Card refs are 1..n in card-id order; the basis digests are environment-independent.
      const refs = (await pool.query(`SELECT card_ref, card_id FROM ${quoted(schema, "analytics_v2_price_cards")}
        ORDER BY card_ref`)).rows;
      assert.deepEqual(refs.map((row) => row.card_id), bundleCards.cards.map((card) => card.cardId));
      assert.deepEqual(refs.map((row) => row.card_ref), refs.map((_, index) => index + 1));
      const rows = (await pool.query(`SELECT p.day::text AS day, p.usage_events, p.unpriced_events, p.inputs_sha256,
          b.basis_sha256, b.card_refs FROM ${quoted(schema, "analytics_v2_owner_day_price")} p
          JOIN ${quoted(schema, "analytics_v2_price_bases")} b USING (price_basis_id) ORDER BY p.day`)).rows;
      const expectedBasis = async (cardIds) => prices.analyticsV2PriceCardSetSha256(bundleCards.cards
        .filter((card) => cardIds.includes(card.cardId)));
      assert.deepEqual(rows, [
        { day: D1, usage_events: 2, unpriced_events: 1, inputs_sha256: a1.price.inputs.sha256,
          basis_sha256: await expectedBasis(a1.price.cardIds),
          card_refs: a1.price.cardIds.map((id) => refs.find((ref) => ref.card_id === id).card_ref).sort((l, r) => l - r) },
        { day: D2, usage_events: 1, unpriced_events: 0, inputs_sha256: a2.price.inputs.sha256,
          basis_sha256: await expectedBasis(a2.price.cardIds), card_refs: rows[1].card_refs },
        { day: D3, usage_events: 0, unpriced_events: 0, inputs_sha256: a3.price.inputs.sha256,
          basis_sha256: await expectedBasis([]), card_refs: [] },
      ]);
      assert.equal(rows[0].basis_sha256, rows[1].basis_sha256, "one basis for the same card set");
      // The same run again: nothing new registered, ids unchanged, rows replaced with identical content.
      const before = await pool.query(`SELECT * FROM ${quoted(schema, "analytics_v2_price_bases")} ORDER BY 1`);
      const second = await write(client, schema, stamp(1, CLASS_X), run);
      assert.deepEqual(second.prices, { kernelCards: cards, cardsRegistered: 0, basesRegistered: 0, ownerDays: 3,
        transitions: [] });
      assert.deepEqual((await pool.query(`SELECT * FROM ${quoted(schema, "analytics_v2_price_bases")} ORDER BY 1`)).rows,
        before.rows);

      const unchanged = await snapshot(pool, schema);
      // The same kernel stating another compute class, or none, is refused atomically.
      for (const conflicting of [stamp(1, CLASS_Y), stamp(1)]) {
        await assert.rejects(write(client, schema, conflicting, run), { code: "ANALYTICS_V2_KERNEL_PRICES_CONFLICT" });
      }
      // A price row naming a card the kernel does not have is refused atomically.
      const foreign = { ...a2.price, cardIds: ["synthetic:not-a-registered-card"] };
      await assert.rejects(write(client, schema, stamp(1, CLASS_X), outputs({ ownerDays: [a1.ownerDay, a2.ownerDay],
        ownerDayPrices: [a1.price, foreign] })), { code: "ANALYTICS_V2_PRICE_CARD_UNREGISTERED" });
      // Outputs whose price rows do not match their owner-day rows one to one are refused before any write.
      for (const [ownerDays, ownerDayPrices] of [[[a1.ownerDay], []], [[a1.ownerDay], [a1.price, a1.price]],
        [[a1.ownerDay], [a2.price]], [[{ ...a1.ownerDay, daily: null, refusal: "source_conflict_or_order" }], [a1.price]],
        [[a1.ownerDay], [{ ...a1.price, usageEvents: 3 }]], [[a1.ownerDay], [{ ...a1.price, cardIds: [...a1.price.cardIds, a1.price.cardIds[0]] }]],
        [[a1.ownerDay], [{ ...a1.price, inputs: { ...a1.price.inputs, data: "not base64" } }]],
        [[a1.ownerDay], [{ ...a1.price, extra: true }]]]) {
        await assert.rejects(write(client, schema, stamp(1, CLASS_X), outputs({ ownerDays, ownerDayPrices })),
          { code: "ANALYTICS_V2_OUTPUTS_INVALID" });
      }
      const { ownerDayPrices: _prices, ...withoutPrices } = outputs({ ownerDays: [a1.ownerDay] });
      await assert.rejects(write(client, schema, stamp(1, CLASS_X), withoutPrices), { code: "ANALYTICS_V2_OUTPUTS_INVALID",
        field: "ownerDayPrices" });
      assert.deepEqual(await snapshot(pool, schema), unchanged);
    } finally {
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// Kernel transitions
// ---------------------------------------------------------------------------

test("PG17: a compatible transition records exactly the stale owner-days, once, and the dirtiness follows", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  const sol = priced("gpt-5.6-sol", D1);
  const solCard = sol.priced.cardIds[0];
  const other = priced("gpt-5.5", D1);
  assert.equal(sol.priced.status, prices.ANALYTICS_V2_PRICE_STATUS.fullyPriced);
  assert.equal(other.priced.status, prices.ANALYTICS_V2_PRICE_STATUS.fullyPriced);
  assert.ok(!other.priced.cardIds.includes(solCard), "the two events are priced by different cards");
  await withSchema("compatible", async ({ pool, schema }) => {
    // Kernel 1 (same compute class) priced with one card changed since: A/D1
    // used that card (cause 1); A/D2 stored an event as unpriced that a card
    // now prices (cause 2, compatible); B/D1 prices exactly as stored; B/D2
    // has daily values but no price row (cause 3); B/D3 was refused.
    await seedOlderKernel(pool, schema, { kernelId: 1, computeSha256: CLASS_X, changed: [solCard], days: [
      [OWNER_A, D1, [sol]],
      [OWNER_A, D2, [{ input: other.input, priced: { costNanousd: 0, status: prices.ANALYTICS_V2_PRICE_STATUS.unpriced,
        cardIds: [] } }]],
      [OWNER_B, D1, [other]],
      [OWNER_B, D2, "no-price"],
      [OWNER_B, D3, "refused"],
    ] });
    const client = await pool.connect();
    try {
      const a1 = await computedDay(OWNER_A, D1, [sol]);
      const run = outputs({ ownerDays: [a1.ownerDay], ownerDayPrices: [a1.price] });
      const written = await write(client, schema, stamp(2, CLASS_X), run);
      assert.deepEqual(written.prices.transitions, [{ fromKernel: 1, toKernel: 2, compatible: true, ownerDays: 5,
        staleOwnerDays: 3 }]);
      assert.deepEqual(await transitions(pool, schema), [{ from_kernel: 1, to_kernel: 2, compute_equal: true,
        proof_holds: true, compatible: true, cards_added: 0, cards_removed: 0, cards_changed: 1, owner_days: 5, events: 3,
        stale_owner_days: 3 }]);
      assert.deepEqual(await staleRows(pool, schema), [
        { from_kernel: 1, to_kernel: 2, owner_digest: OWNER_A, day: D1, cause: 1 },
        { from_kernel: 1, to_kernel: 2, owner_digest: OWNER_A, day: D2, cause: 2 },
        { from_kernel: 1, to_kernel: 2, owner_digest: OWNER_B, day: D2, cause: 3 },
      ].sort((left, right) => (left.owner_digest < right.owner_digest ? -1 : left.owner_digest > right.owner_digest ? 1
        : left.day < right.day ? -1 : 1)));
      // The computed owner's rows are kernel 2 now; B's rows stay kernel 1.
      // Under kernel 2 only B's unpriced-cause owner-day is price-dirty: both
      // kernels price under the same registry, so B/D1 needs no restamp.
      assert.deepEqual(await store.readAnalyticsV2PriceDirtyOwnerDays(client, { schema, kernelId: 2,
        ownerDigests: [OWNER_A, OWNER_B] }), [{ ownerDigest: OWNER_B, day: D2, cause: "stale" }]);
      // The transition is recorded once: a later run on the same kernel adds none.
      const again = await write(client, schema, stamp(2, CLASS_X), run);
      assert.deepEqual(again.prices.transitions, []);
      assert.equal(await count(pool, schema, "analytics_v2_kernel_transitions"), 1);
      // A newer kernel proves its own transitions from both stored kernels.
      const third = await write(client, schema, stamp(3, CLASS_X), run);
      assert.deepEqual(third.prices.transitions.map((entry) => [entry.fromKernel, entry.toKernel, entry.compatible]),
        [[1, 3, true], [2, 3, true]]);
    } finally {
      client.release();
    }
  });
});

test("PG17: a compatible transition that adds a card under a new registry leaves every daily-valued owner-day to restamp", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  const sol = priced("gpt-5.6-sol", D1);
  const other = priced("gpt-5.5", D2);
  const added = other.priced.cardIds[0];
  assert.equal(other.priced.status, prices.ANALYTICS_V2_PRICE_STATUS.fullyPriced);
  assert.ok(!sol.priced.cardIds.includes(added), "the card kernel 2 adds does not price the kept event");
  const OLD_REGISTRY = digest("price-registry-of-kernel-1");
  assert.notEqual(OLD_REGISTRY, kernels.APP_PRICE_REGISTRY_MANIFEST.sha256);
  // What kernel 1 stored: daily values stamped with its own registry identity.
  const storedDaily = (day) => ({ ...kernels.createV11DailyProjectionValues(day), registrySha256: OLD_REGISTRY });
  await withSchema("registry", async ({ pool, schema }) => {
    // Kernel 1 (same compute class, an older registry without one card that
    // kernel 2 adds): B/D1 prices exactly as stored (not stale); B/D2 stored
    // an event as unpriced that the added card now prices (cause 2); B/D3
    // was refused (no daily values).
    await seedOlderKernel(pool, schema, { kernelId: 1, computeSha256: CLASS_X, omitted: [added],
      registrySha256: OLD_REGISTRY, days: [
        [OWNER_B, D1, [sol], storedDaily(D1)],
        [OWNER_B, D2, [{ input: other.input, priced: { costNanousd: 0, status: prices.ANALYTICS_V2_PRICE_STATUS.unpriced,
          cardIds: [] } }], storedDaily(D2)],
        [OWNER_B, D3, "refused"],
      ] });
    const client = await pool.connect();
    try {
      const a1 = await computedDay(OWNER_A, D1, [sol]);
      await write(client, schema, stamp(2, CLASS_X), outputs({ ownerDays: [a1.ownerDay], ownerDayPrices: [a1.price] }));
      assert.deepEqual(await transitions(pool, schema), [{ from_kernel: 1, to_kernel: 2, compute_equal: true,
        proof_holds: true, compatible: true, cards_added: 1, cards_removed: 0, cards_changed: 0, owner_days: 3, events: 2,
        stale_owner_days: 1 }]);
      assert.deepEqual((await staleRows(pool, schema)).map((row) => [row.owner_digest, row.day, row.cause]),
        [[OWNER_B, D2, 2]]);
      // The stale set is the price staleness only; every other daily-valued
      // owner-day of kernel 1 is still dirty, to restamp: its prices are
      // proven unchanged, but its daily values carry the older registry.
      assert.deepEqual(await store.readAnalyticsV2PriceDirtyOwnerDays(client, { schema, kernelId: 2,
        ownerDigests: [OWNER_A, OWNER_B] }), [{ ownerDigest: OWNER_B, day: D1, cause: "registry" },
        { ownerDigest: OWNER_B, day: D2, cause: "stale" }]);
      // Kept as stored, B/D1's daily values fail the new kernel's own
      // validator (and so its merge and fold); restamped, they pass.
      const kept = (await pool.query(`SELECT daily FROM ${quoted(schema, "analytics_v2_owner_day")}
        WHERE owner_digest = $1 AND day = $2`, [OWNER_B, D1])).rows[0].daily;
      assert.equal(kept.registrySha256, OLD_REGISTRY);
      assert.throws(() => kernels.validateV11DailyProjectionValues(kept), /V11_DAILY_PROJECTION_VALUES_INVALID/u);
      assert.throws(() => kernels.mergeV11DailyProjectionValues(kept, kernels.createV11DailyProjectionValues(D1)),
        /V11_DAILY_PROJECTION_VALUES_INVALID/u);
      kernels.validateV11DailyProjectionValues({ ...kept, registrySha256: kernels.APP_PRICE_REGISTRY_MANIFEST.sha256 });
    } finally {
      client.release();
    }
  });
});

test("PG17: a proof violation, another compute class or unknown cards make a transition incompatible", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  const other = priced("gpt-5.5", D1);
  const cases = [
    // A fully priced event on unchanged cards that prices differently now: the proof fails.
    ["violation", { computeSha256: CLASS_X, days: [[OWNER_B, D1, [{ input: other.input,
      priced: { ...other.priced, costNanousd: other.priced.costNanousd + 1 } }]], [OWNER_B, D2, [other]]] },
    { compute_equal: true, proof_holds: false, cards_added: 0 }, [[OWNER_B, D1, 2]]],
    // Another compute class: no claim, whatever the proof finds.
    ["compute", { computeSha256: CLASS_Y, days: [[OWNER_B, D1, [other]]] },
      { compute_equal: false, proof_holds: true, cards_added: 0 }, []],
    // A kernel before K-PERCARD (no price registration, no price rows): every priced owner-day is unknown.
    ["unknown", { computeSha256: null, cards: false, days: [[OWNER_B, D1, "no-price"], [OWNER_B, D2, "no-price"],
      [OWNER_B, D3, "refused"]] }, { compute_equal: false, proof_holds: true, cards_added: null },
    [[OWNER_B, D1, 3], [OWNER_B, D2, 3]]],
  ];
  for (const [label, older, verdict, stale] of cases) {
    await withSchema(`incompatible-${label}`, async ({ pool, schema }) => {
      await seedOlderKernel(pool, schema, { kernelId: 1, ...older });
      const client = await pool.connect();
      try {
        const a1 = await computedDay(OWNER_A, D1, [other]);
        await write(client, schema, stamp(2, CLASS_X), outputs({ ownerDays: [a1.ownerDay], ownerDayPrices: [a1.price] }));
        assert.deepEqual(await transitions(pool, schema), [{ from_kernel: 1, to_kernel: 2, compatible: false,
          cards_removed: verdict.cards_added, cards_changed: verdict.cards_added === null ? null : 0,
          owner_days: older.days.length, events: older.days.reduce((sum, [, , events]) =>
            sum + (Array.isArray(events) ? events.length : 0), 0), stale_owner_days: stale.length, ...verdict }], label);
        assert.deepEqual((await staleRows(pool, schema)).map((row) => [row.owner_digest, row.day, row.cause]), stale, label);
        // The derived regime goes cold: every owner-day of the older kernel is dirty.
        assert.deepEqual((await store.readAnalyticsV2PriceDirtyOwnerDays(client, { schema, kernelId: 2,
          ownerDigests: [OWNER_B] })).map((row) => [row.day, row.cause]),
        older.days.map(([, day]) => [day, "incompatible"]), label);
      } finally {
        client.release();
      }
    });
  }
});

test("PG17: corrupt stored inputs and a proof that no longer matches the stored rows fail the run atomically", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  const other = priced("gpt-5.5", D1);
  await withSchema("fail-closed", async ({ pool, schema }) => {
    await seedOlderKernel(pool, schema, { kernelId: 1, computeSha256: CLASS_X, days: [[OWNER_B, D1, [other]]] });
    const client = await pool.connect();
    try {
      const a1 = await computedDay(OWNER_A, D1, [other]);
      const run = outputs({ ownerDays: [a1.ownerDay], ownerDayPrices: [a1.price] });
      // The Job's proof, from its read snapshot; a row added since makes it stale.
      const proof = await store.proveAnalyticsV2PriceTransitions(client, { schema, stamp: stamp(2, CLASS_X) });
      assert.deepEqual(proof.transitions.map((entry) => [entry.fromKernel, entry.ownerDays, entry.compatible]), [[1, 1, true]]);
      await pool.query(`INSERT INTO ${quoted(schema, "analytics_v2_owner_day")} (owner_digest, day, daily, refusal, run_id,
          kernel_id, manifest_version) VALUES ($1, $2, NULL, 'source_conflict_or_order', $3, 1, 1)`,
      [OWNER_B, D3, randomUUID()]);
      const before = await snapshot(pool, schema);
      await assert.rejects(write(client, schema, stamp(2, CLASS_X), run, { priceTransitions: proof }),
        { code: "ANALYTICS_V2_PRICE_TRANSITION_STALE" });
      await assert.rejects(write(client, schema, stamp(2, CLASS_X), run, { priceTransitions: { ...proof, toKernel: 3 } }),
        { code: "ANALYTICS_V2_PRICE_TRANSITION_STALE" });
      assert.deepEqual(await snapshot(pool, schema), before);
      // Damaged stored inputs are never repriced partially: the run fails, nothing changes.
      await pool.query(`ALTER TABLE ${quoted(schema, "analytics_v2_owner_day_price")}
        DISABLE TRIGGER analytics_v2_owner_day_price_matches_owner_day`);
      await pool.query(`UPDATE ${quoted(schema, "analytics_v2_owner_day_price")}
        SET inputs = overlay(inputs placing '\\xff'::bytea from 3 for 1)`);
      await pool.query(`ALTER TABLE ${quoted(schema, "analytics_v2_owner_day_price")}
        ENABLE TRIGGER analytics_v2_owner_day_price_matches_owner_day`);
      const damaged = await snapshot(pool, schema);
      await assert.rejects(write(client, schema, stamp(2, CLASS_X), run), { code: "ANALYTICS_V2_PRICE_INPUTS_CORRUPT" });
      assert.deepEqual(await snapshot(pool, schema), damaged);
      assert.equal(await count(pool, schema, "analytics_v2_kernel_transitions"), 0);
    } finally {
      client.release();
    }
  });
});

test("PG17: a price row of another kernel, a malformed kernel registration and a conflicting stored basis fail the run atomically", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  const sol = priced("gpt-5.6-sol", D1);
  const other = priced("gpt-5.5", D2);
  // A stored price row must belong to its owner-day's kernel: one moved to
  // another registered kernel (the trigger that ties them disabled in the
  // fixture) is refused by the proof, not repriced.
  await withSchema("state-kernel", async ({ pool, schema }) => {
    await seedOlderKernel(pool, schema, { kernelId: 1, computeSha256: CLASS_X, days: [[OWNER_B, D1, [other]]] });
    const t = (table) => quoted(schema, table);
    await pool.query(`INSERT INTO ${t("analytics_v2_kernels")} SELECT 2, production_commit, vendor_manifest_sha256, $1,
      price_registry_sha256, price_registry_version, method_version, registered_at
      FROM ${t("analytics_v2_kernels")} WHERE kernel_id = 1`, [stamp(2).kernel.computeClosureSha256]);
    await pool.query(`INSERT INTO ${t("analytics_v2_kernel_prices")} SELECT 2, compute_sha256, cards_sha256, cards,
      projection_version, registered_at FROM ${t("analytics_v2_kernel_prices")} WHERE kernel_id = 1`);
    await pool.query(`ALTER TABLE ${t("analytics_v2_owner_day_price")} DISABLE TRIGGER analytics_v2_owner_day_price_matches_owner_day`);
    await pool.query(`UPDATE ${t("analytics_v2_owner_day_price")} SET kernel_id = 2`);
    await pool.query(`ALTER TABLE ${t("analytics_v2_owner_day_price")} ENABLE TRIGGER analytics_v2_owner_day_price_matches_owner_day`);
    const client = await pool.connect();
    try {
      const a1 = await computedDay(OWNER_A, D1, [sol]);
      const before = await snapshot(pool, schema);
      await assert.rejects(store.proveAnalyticsV2PriceTransitions(client, { schema, stamp: stamp(3, CLASS_X) }),
        { code: "ANALYTICS_V2_PRICE_STATE_INVALID", field: "ownerDayPrice" });
      await assert.rejects(write(client, schema, stamp(3, CLASS_X), outputs({ ownerDays: [a1.ownerDay],
        ownerDayPrices: [a1.price] })), { code: "ANALYTICS_V2_PRICE_STATE_INVALID", field: "ownerDayPrice" });
      assert.deepEqual(await snapshot(pool, schema), before);
    } finally {
      client.release();
    }
  });
  // A stored kernel registration the schema should never hold (its CHECK
  // dropped in the fixture) is refused when it is read, never trusted.
  await withSchema("state-registration", async ({ pool, schema }) => {
    const table = quoted(schema, "analytics_v2_kernel_prices");
    const check = (await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%compute_sha256%'`, [table])).rows;
    assert.equal(check.length, 1, "one CHECK guards the compute class");
    await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT "${check[0].conname}"`);
    await seedOlderKernel(pool, schema, { kernelId: 1, computeSha256: "A".repeat(64), days: [[OWNER_B, D1, [other]]] });
    const client = await pool.connect();
    try {
      const a1 = await computedDay(OWNER_A, D1, [sol]);
      const before = await snapshot(pool, schema);
      await assert.rejects(write(client, schema, stamp(2, CLASS_X), outputs({ ownerDays: [a1.ownerDay],
        ownerDayPrices: [a1.price] })), { code: "ANALYTICS_V2_PRICE_STATE_INVALID", field: "kernelPrices" });
      assert.deepEqual(await snapshot(pool, schema), before);
    } finally {
      client.release();
    }
  });
  // A stored basis whose digest names this card set but whose refs are
  // other cards is refused, not reused.
  await withSchema("basis-conflict", async ({ pool, schema }) => {
    const client = await pool.connect();
    try {
      const a1 = await computedDay(OWNER_A, D1, [sol]);
      const a2 = await computedDay(OWNER_A, D2, [other]);
      await write(client, schema, stamp(1, CLASS_X), outputs({ ownerDays: [a1.ownerDay], ownerDayPrices: [a1.price] }));
      const basisSha256 = await prices.analyticsV2PriceCardSetSha256(bundleCards.cards
        .filter((card) => a2.price.cardIds.includes(card.cardId)));
      const t = (table) => quoted(schema, table);
      const own = (await pool.query(`SELECT card_ref FROM ${t("analytics_v2_price_cards")} WHERE card_id = ANY($1::text[])`,
        [a2.price.cardIds])).rows.map((row) => row.card_ref);
      const foreign = (await pool.query(`SELECT min(card_ref)::integer AS ref FROM ${t("analytics_v2_price_cards")}
        WHERE NOT (card_ref = ANY($1::integer[]))`, [own])).rows[0].ref;
      await pool.query(`INSERT INTO ${t("analytics_v2_price_bases")} (price_basis_id, basis_sha256, card_refs)
        SELECT max(price_basis_id) + 1, $1, ARRAY[$2::integer] FROM ${t("analytics_v2_price_bases")}`, [basisSha256, foreign]);
      const before = await snapshot(pool, schema);
      await assert.rejects(write(client, schema, stamp(1, CLASS_X), outputs({ ownerDays: [a1.ownerDay, a2.ownerDay],
        ownerDayPrices: [a1.price, a2.price] })), { code: "ANALYTICS_V2_PRICE_BASIS_CONFLICT" });
      assert.deepEqual(await snapshot(pool, schema), before);
    } finally {
      client.release();
    }
  });
});

test("PG17: the offline purge removes one owner's stale rows only through the documented trigger bypass", {
  skip: PG_SKIP, timeout: 240_000,
}, async () => {
  const other = priced("gpt-5.5", D1);
  await withSchema("purge", async ({ pool, schema }) => {
    // Two owners stale under one recorded transition (no price inputs: cause 3).
    await seedOlderKernel(pool, schema, { kernelId: 1, computeSha256: null, cards: false, days: [
      [OWNER_A, D1, "no-price"], [OWNER_A, D2, "no-price"], [OWNER_B, D1, "no-price"]] });
    const client = await pool.connect();
    try {
      const b1 = await computedDay(OWNER_B, D2, [other]);
      await write(client, schema, stamp(2, CLASS_X), outputs({ owners: [OWNER_B], ownerDays: [b1.ownerDay],
        ownerDayPrices: [b1.price] }));
    } finally {
      client.release();
    }
    const table = quoted(schema, "analytics_v2_transition_stale");
    const stale = async () => (await pool.query(`SELECT owner_digest, day::text AS day FROM ${table}
      ORDER BY owner_digest, day`)).rows.map((row) => [row.owner_digest, row.day]);
    const enabled = async () => (await pool.query(`SELECT tgname, tgenabled FROM pg_trigger
      WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname`, [table])).rows
      .map((row) => [row.tgname, row.tgenabled]);
    const triggers = [["analytics_v2_transition_stale_append_only", "O"], ["analytics_v2_transition_stale_no_truncate", "O"]];
    const all = [[OWNER_A, D1], [OWNER_A, D2], [OWNER_B, D1]].sort((left, right) =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : 1);
    assert.deepEqual(await stale(), all);
    assert.deepEqual(await enabled(), triggers);
    // The running service has no way to remove them: the table is append-only.
    await assert.rejects(pool.query(`DELETE FROM ${table} WHERE owner_digest = $1`, [OWNER_A]), { code: "P1005" });
    await assert.rejects(pool.query(`TRUNCATE ${table}`), { code: "P1005" });
    // The offline purge (PURGE-1), as the table owner and inside its one
    // purge transaction, disables only the row trigger, deletes the erased
    // owner's rows and re-enables it before COMMIT (the staged migration's
    // header records these three statements).
    const purge = async (ownerDigest, finish) => {
      const owner = await pool.connect();
      try {
        await owner.query("BEGIN");
        await owner.query(`ALTER TABLE ${table} DISABLE TRIGGER analytics_v2_transition_stale_append_only`);
        const deleted = await owner.query(`DELETE FROM ${table} WHERE owner_digest = $1`, [ownerDigest]);
        await owner.query(`ALTER TABLE ${table} ENABLE TRIGGER analytics_v2_transition_stale_append_only`);
        await owner.query(finish);
        return deleted.rowCount;
      } finally {
        owner.release();
      }
    };
    // A purge that does not commit changes nothing, the trigger included.
    assert.equal(await purge(OWNER_A, "ROLLBACK"), 2);
    assert.deepEqual(await stale(), all);
    assert.deepEqual(await enabled(), triggers);
    assert.equal(await purge(OWNER_A, "COMMIT"), 2);
    assert.deepEqual(await stale(), [[OWNER_B, D1]]);
    // The table is append-only again for everyone after it.
    assert.deepEqual(await enabled(), triggers);
    await assert.rejects(pool.query(`DELETE FROM ${table}`), { code: "P1005" });
    // The transition keeps its content-free counts.
    assert.deepEqual((await transitions(pool, schema)).map((row) => [row.owner_days, row.stale_owner_days]), [[3, 3]]);
  });
});
