/**
 * analytics_v2 store, prices (K-PERCARD, engine v2 design section 5): the
 * price cards each kernel prices with, the deduplicated price bases, each
 * owner-day's price row, and the kernel transitions with their stale
 * owner-days (staged migration analytics_v2_price_cards).
 *
 * Inside the run's write transaction (store.ts writeRunOutputs), after the
 * kernel row is registered:
 *  1. registerAnalyticsV2KernelPrices registers the run kernel's compute
 *     class and cards on its first write (analytics_v2_kernel_prices,
 *     analytics_v2_price_cards, analytics_v2_kernel_cards) and on every later
 *     write refuses a stored registration that differs
 *     (ANALYTICS_V2_KERNEL_PRICES_CONFLICT). A card is (card id, sha256 of its
 *     canonical JSON): a changed card is a new card_ref.
 *  2. recordAnalyticsV2PriceTransitions records, once per older kernel that
 *     still stamps stored owner-days, the transition to the run's kernel and
 *     its stale owner-days, from the proof proveAnalyticsV2PriceTransitions
 *     computed over the stored price inputs (the Job proves in its read
 *     snapshot; a direct store caller proves here). The proof's owner-day
 *     counts are re-read first; any difference is
 *     ANALYTICS_V2_PRICE_TRANSITION_STALE. This runs before the derived rows
 *     are replaced, so it sees the older kernel's rows.
 *  3. writeAnalyticsV2OwnerDayPrices, after the owner-day rows are written,
 *     inserts one price row per owner-day row with daily values (the
 *     owner-day delete cascades to the replaced price rows), mapping each
 *     row's card ids to the kernel's card refs and a price basis.
 *
 * Integer ids (card_ref, price_basis_id, transition_id) are assigned here as
 * the stored maximum plus a rank in a fixed order (card id and content,
 * basis digest, older kernel), under the refresh lock, so they are gap-free
 * and identical for identical histories; a rolled-back run assigns nothing.
 * They are local surrogates: the identities are the digests.
 *
 * Errors carry closed codes (store-run.ts AnalyticsV2StoreError, or the
 * price modules' own), never SQL text or a stored value.
 */

import type { PostgresClient } from "../postgres-client";
import { ANALYTICS_V2_TABLES, type AnalyticsV2OwnerDayPriceRow } from "./contract";
import type { AnalyticsV2RunStamp } from "./kernel";
import {
  ANALYTICS_V2_PRICE_PROJECTION_VERSION,
  analyticsV2KernelPriceCards,
  analyticsV2PriceCardSetSha256,
  decodeAnalyticsV2PriceInputs,
  type AnalyticsV2KernelPriceCards,
  type AnalyticsV2PriceCard,
  type AnalyticsV2PriceInput,
  type AnalyticsV2PricedEvent,
} from "./price-attribution";
import {
  ANALYTICS_V2_STALE_CAUSE,
  analyticsV2PriceDirtyOwnerDays,
  analyticsV2PriceTransitionProof,
  diffAnalyticsV2KernelCards,
  proveAnalyticsV2DayPrices,
  repriceableAnalyticsV2Projection,
  type AnalyticsV2PriceDirtyOwnerDay,
  type AnalyticsV2PriceTransitionProof,
  type AnalyticsV2StaleOwnerDay,
} from "./price-transition";
import {
  fail,
  insertRecordset,
  rowsOf,
  relation,
  type AnalyticsV2PriceTransitions,
  type AnalyticsV2PriceWriteSummary,
} from "./store-run";

const TABLES = ANALYTICS_V2_TABLES;
/** Stored owner-days read per page by the proof (each carries its deflated inputs). */
const PROOF_PAGE_ROWS = 100;
const OWNER_DIGEST = /^[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

/** A kernel's registered card: its ref and content. */
export interface AnalyticsV2KernelCardRef {
  readonly cardRef: number;
  readonly contentSha256: string;
}


const countOf = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("ANALYTICS_V2_PRICE_STATE_INVALID", field);
  return value as number;
};

/** The stored cards of one kernel, or null when it never registered any (a kernel before K-PERCARD). */
async function readKernelPrices(client: PostgresClient, schema: string, kernelId: number): Promise<{
  readonly computeSha256: string | null; readonly cardsSha256: string; readonly cards: number; readonly projectionVersion: string;
  readonly registered: readonly (AnalyticsV2PriceCard & AnalyticsV2KernelCardRef)[];
} | null> {
  const prices = rowsOf<Record<string, unknown>>(await client.query(
    `SELECT compute_sha256, cards_sha256, cards, projection_version FROM ${relation(schema, TABLES.kernelPrices)}
      WHERE kernel_id = $1::smallint`, [kernelId]), "ANALYTICS_V2_READ_FAILED");
  if (prices.length === 0) return null;
  const row = prices[0]!;
  const cards = rowsOf<Record<string, unknown>>(await client.query(
    `SELECT kc.card_id, kc.card_ref, pc.content_sha256
       FROM ${relation(schema, TABLES.kernelCards)} kc
       JOIN ${relation(schema, TABLES.priceCards)} pc ON pc.card_ref = kc.card_ref AND pc.card_id = kc.card_id
      WHERE kc.kernel_id = $1::smallint
      ORDER BY kc.card_id COLLATE "C"`, [kernelId]), "ANALYTICS_V2_READ_FAILED");
  const registered = cards.map((card) => {
    if (typeof card.card_id !== "string" || typeof card.content_sha256 !== "string" || !SHA256.test(card.content_sha256)) {
      fail("ANALYTICS_V2_PRICE_STATE_INVALID", "kernelCards");
    }
    return Object.freeze({ cardId: card.card_id as string, contentSha256: card.content_sha256 as string,
      cardRef: countOf(card.card_ref, "kernelCards.cardRef") });
  });
  if ((row.compute_sha256 !== null && (typeof row.compute_sha256 !== "string" || !SHA256.test(row.compute_sha256)))
      || typeof row.cards_sha256 !== "string" || typeof row.projection_version !== "string") {
    fail("ANALYTICS_V2_PRICE_STATE_INVALID", "kernelPrices");
  }
  return Object.freeze({ computeSha256: row.compute_sha256 as string | null, cardsSha256: row.cards_sha256 as string,
    cards: countOf(row.cards, "kernelPrices.cards"), projectionVersion: row.projection_version as string,
    registered: Object.freeze(registered) });
}

/**
 * Register the run kernel's compute class and cards (first write) or verify
 * them (every later write), and return the kernel's card refs by card id.
 */
export async function registerAnalyticsV2KernelPrices(client: PostgresClient, schema: string,
  stamp: AnalyticsV2RunStamp, registeredAt: string,
  cards: AnalyticsV2KernelPriceCards): Promise<{ readonly refs: ReadonlyMap<string, AnalyticsV2KernelCardRef>;
    readonly cardsRegistered: number }> {
  const kernelId = stamp.kernel.kernelId;
  const computeSha256 = stamp.computeSha256 ?? null;
  const inserted = rowsOf(await client.query(
    `INSERT INTO ${relation(schema, TABLES.kernelPrices)}
       (kernel_id, compute_sha256, cards_sha256, cards, projection_version, registered_at)
     VALUES ($1::smallint, $2, $3, $4::integer, $5, $6::timestamptz)
     ON CONFLICT (kernel_id) DO NOTHING
     RETURNING kernel_id`,
    [kernelId, computeSha256, cards.cardsSha256, cards.cards.length, ANALYTICS_V2_PRICE_PROJECTION_VERSION, registeredAt],
  ), "ANALYTICS_V2_WRITE_FAILED").length === 1;
  let cardsRegistered = 0;
  if (inserted) {
    const incoming = JSON.stringify(cards.cards.map((card) => ({ card_id: card.cardId, content_sha256: card.contentSha256 })));
    const added = rowsOf(await client.query(
      `WITH incoming AS (
         SELECT card_id, content_sha256 FROM jsonb_to_recordset($1::jsonb) AS c(card_id text, content_sha256 text)
       ), missing AS (
         SELECT i.card_id, i.content_sha256 FROM incoming i
          WHERE NOT EXISTS (SELECT 1 FROM ${relation(schema, TABLES.priceCards)} p
                             WHERE p.card_id = i.card_id AND p.content_sha256 = i.content_sha256)
       ), top AS (SELECT coalesce(max(card_ref), 0) AS top FROM ${relation(schema, TABLES.priceCards)})
       INSERT INTO ${relation(schema, TABLES.priceCards)} (card_ref, card_id, content_sha256, first_kernel_id)
       SELECT top.top + row_number() OVER (ORDER BY m.card_id COLLATE "C", m.content_sha256)::integer,
              m.card_id, m.content_sha256, $2::smallint
         FROM missing m CROSS JOIN top
       RETURNING card_ref`,
      [incoming, kernelId]), "ANALYTICS_V2_WRITE_FAILED");
    cardsRegistered = added.length;
    const linked = await client.query(
      `INSERT INTO ${relation(schema, TABLES.kernelCards)} (kernel_id, card_ref, card_id)
       SELECT $2::smallint, p.card_ref, p.card_id
         FROM jsonb_to_recordset($1::jsonb) AS c(card_id text, content_sha256 text)
         JOIN ${relation(schema, TABLES.priceCards)} p ON p.card_id = c.card_id AND p.content_sha256 = c.content_sha256`,
      [incoming, kernelId]);
    if ((linked as { rowCount?: unknown } | null)?.rowCount !== cards.cards.length) fail("ANALYTICS_V2_WRITE_FAILED", "kernelCards");
  }
  const stored = await readKernelPrices(client, schema, kernelId);
  if (stored === null || stored.computeSha256 !== computeSha256 || stored.cardsSha256 !== cards.cardsSha256
      || stored.cards !== cards.cards.length || stored.projectionVersion !== ANALYTICS_V2_PRICE_PROJECTION_VERSION
      || stored.registered.length !== cards.cards.length
      || stored.registered.some((card, index) => card.cardId !== cards.cards[index]!.cardId
        || card.contentSha256 !== cards.cards[index]!.contentSha256)) {
    fail("ANALYTICS_V2_KERNEL_PRICES_CONFLICT");
  }
  return Object.freeze({
    refs: new Map(stored!.registered.map((card) => [card.cardId, Object.freeze({ cardRef: card.cardRef,
      contentSha256: card.contentSha256 })])),
    cardsRegistered,
  });
}

/** Older kernels that stamp stored owner-days and have no transition to `kernelId` yet, with their owner-day counts. */
async function pendingTransitions(client: PostgresClient, schema: string, kernelId: number):
Promise<readonly { readonly fromKernel: number; readonly ownerDays: number }[]> {
  const rows = rowsOf<Record<string, unknown>>(await client.query(
    `SELECT d.kernel_id::integer AS from_kernel, count(*)::integer AS owner_days
       FROM ${relation(schema, TABLES.ownerDay)} d
      WHERE d.kernel_id < $1::smallint
        AND NOT EXISTS (SELECT 1 FROM ${relation(schema, TABLES.kernelTransitions)} t
                         WHERE t.from_kernel = d.kernel_id AND t.to_kernel = $1::smallint)
      GROUP BY d.kernel_id
      ORDER BY d.kernel_id`, [kernelId]), "ANALYTICS_V2_READ_FAILED");
  return rows.map((row) => Object.freeze({ fromKernel: countOf(row.from_kernel, "transitions.fromKernel"),
    ownerDays: countOf(row.owner_days, "transitions.ownerDays") }));
}

/**
 * Prove every pending transition to the run's kernel over the stored price
 * inputs (price-transition.ts). Reads only; the Job runs it in its read
 * snapshot. `cards` and `price` default to this bundle's kernel (a spec may
 * state another).
 */
export async function proveAnalyticsV2PriceTransitions(client: PostgresClient, options: {
  readonly schema: string;
  readonly stamp: AnalyticsV2RunStamp;
  readonly cards?: AnalyticsV2KernelPriceCards;
  readonly price?: (input: AnalyticsV2PriceInput) => AnalyticsV2PricedEvent;
}): Promise<AnalyticsV2PriceTransitions> {
  const { schema, stamp } = options;
  const toKernel = stamp.kernel.kernelId;
  const cards = options.cards ?? await analyticsV2KernelPriceCards();
  const transitions: AnalyticsV2PriceTransitionProof[] = [];
  for (const { fromKernel, ownerDays: expected } of await pendingTransitions(client, schema, toKernel)) {
    const from = await readKernelPrices(client, schema, fromKernel);
    const diff = from === null ? null : diffAnalyticsV2KernelCards(from.registered, cards.cards);
    const stale: AnalyticsV2StaleOwnerDay[] = [];
    let ownerDays = 0, events = 0, violation = false;
    let after: { ownerDigest: string; day: string } | null = null;
    for (;;) {
      const page = rowsOf<Record<string, unknown>>(await client.query(
        `SELECT d.owner_digest, d.day::text AS day, (d.daily IS NOT NULL) AS has_daily,
                p.kernel_id::integer AS price_kernel, p.projection_version, p.codec, p.inputs, p.inputs_sha256,
                p.input_events
           FROM ${relation(schema, TABLES.ownerDay)} d
           LEFT JOIN ${relation(schema, TABLES.ownerDayPrice)} p ON p.owner_digest = d.owner_digest AND p.day = d.day
          WHERE d.kernel_id = $1::smallint
            AND ($2::text IS NULL OR (d.owner_digest, d.day) > ($2::text, $3::date))
          ORDER BY d.owner_digest, d.day
          LIMIT $4::integer`,
        [fromKernel, after?.ownerDigest ?? null, after?.day ?? null, PROOF_PAGE_ROWS]), "ANALYTICS_V2_READ_FAILED");
      for (const row of page) {
        if (typeof row.owner_digest !== "string" || !OWNER_DIGEST.test(row.owner_digest) || typeof row.day !== "string") {
          fail("ANALYTICS_V2_PRICE_STATE_INVALID", "ownerDay");
        }
        const ownerDigest = row.owner_digest as string, day = row.day as string;
        ownerDays += 1;
        after = { ownerDigest, day };
        // A refused owner-day has no price: not a price staleness.
        if (row.has_daily !== true) continue;
        if (row.price_kernel === null) {
          stale.push({ ownerDigest, day, cause: ANALYTICS_V2_STALE_CAUSE.priceUnknown });
          continue;
        }
        // A price row is written with its owner-day row by the same kernel, after that kernel's cards.
        if (row.price_kernel !== fromKernel || diff === null) fail("ANALYTICS_V2_PRICE_STATE_INVALID", "ownerDayPrice");
        if (!repriceableAnalyticsV2Projection(row.projection_version)) {
          stale.push({ ownerDigest, day, cause: ANALYTICS_V2_STALE_CAUSE.priceUnknown });
          continue;
        }
        const decoded = await decodeAnalyticsV2PriceInputs({ projectionVersion: row.projection_version as string,
          codec: row.codec as string, sha256: row.inputs_sha256 as string, events: row.input_events as number,
          bytes: row.inputs as Uint8Array });
        const proof = proveAnalyticsV2DayPrices(decoded.events, diff!, options.price);
        events += proof.events;
        violation ||= proof.violation;
        if (proof.cause !== null) stale.push({ ownerDigest, day, cause: proof.cause });
      }
      if (page.length < PROOF_PAGE_ROWS) break;
    }
    if (ownerDays !== expected) fail("ANALYTICS_V2_PRICE_TRANSITION_STALE");
    transitions.push(analyticsV2PriceTransitionProof({ fromKernel, toKernel, fromComputeSha256: from?.computeSha256 ?? null,
      toComputeSha256: stamp.computeSha256 ?? null, diff, ownerDays, events, violation, stale }));
  }
  return Object.freeze({ toKernel, transitions: Object.freeze(transitions) });
}

/**
 * Record the proven transitions (see the module comment). Refuses
 * ANALYTICS_V2_PRICE_TRANSITION_STALE when the pending transitions or their
 * owner-day counts are not exactly those the proof covered.
 */
export async function recordAnalyticsV2PriceTransitions(client: PostgresClient, schema: string,
  proof: AnalyticsV2PriceTransitions, stamp: AnalyticsV2RunStamp, runId: string,
  recordedAt: string): Promise<AnalyticsV2PriceWriteSummary["transitions"]> {
  if (proof === null || typeof proof !== "object" || proof.toKernel !== stamp.kernel.kernelId
      || !Array.isArray(proof.transitions)) {
    fail("ANALYTICS_V2_PRICE_TRANSITION_STALE");
  }
  const pending = await pendingTransitions(client, schema, stamp.kernel.kernelId);
  if (pending.length !== proof.transitions.length || pending.some((entry, index) => {
    const proven = proof.transitions[index]!;
    return proven.fromKernel !== entry.fromKernel || proven.toKernel !== stamp.kernel.kernelId
      || proven.ownerDays !== entry.ownerDays;
  })) {
    fail("ANALYTICS_V2_PRICE_TRANSITION_STALE");
  }
  const summary = [];
  for (const transition of proof.transitions as readonly AnalyticsV2PriceTransitionProof[]) {
    const inserted = rowsOf<{ transition_id: unknown }>(await client.query(
      `INSERT INTO ${relation(schema, TABLES.kernelTransitions)}
         (transition_id, from_kernel, to_kernel, compute_equal, proof_holds, compatible, cards_added, cards_removed,
          cards_changed, owner_days, events, stale_owner_days, proof_run, recorded_at)
       SELECT coalesce(max(transition_id), 0) + 1, $1::smallint, $2::smallint, $3, $4, $5, $6::integer, $7::integer,
              $8::integer, $9::integer, $10::bigint, $11::integer, $12::uuid, $13::timestamptz
         FROM ${relation(schema, TABLES.kernelTransitions)}
       RETURNING transition_id`,
      [transition.fromKernel, transition.toKernel, transition.computeEqual, transition.proofHolds, transition.compatible,
        transition.cardsAdded, transition.cardsRemoved, transition.cardsChanged, transition.ownerDays, transition.events,
        transition.stale.length, runId, recordedAt]), "ANALYTICS_V2_WRITE_FAILED");
    if (inserted.length !== 1) fail("ANALYTICS_V2_WRITE_FAILED", "kernelTransitions");
    const transitionId = countOf(inserted[0]!.transition_id, "kernelTransitions.id");
    await insertRecordset(client,
      `INSERT INTO ${relation(schema, TABLES.transitionStale)} (transition_id, owner_digest, day, cause)
       SELECT transition_id, owner_digest, day, cause
         FROM jsonb_to_recordset($1::jsonb) AS row(transition_id integer, owner_digest text, day date, cause smallint)`,
      transition.stale.map((entry: AnalyticsV2StaleOwnerDay) => ({ transition_id: transitionId, owner_digest: entry.ownerDigest, day: entry.day,
        cause: entry.cause })),
      "transitionStale");
    summary.push(Object.freeze({ fromKernel: transition.fromKernel, toKernel: transition.toKernel,
      compatible: transition.compatible, ownerDays: transition.ownerDays, staleOwnerDays: transition.stale.length }));
  }
  return Object.freeze(summary);
}

/**
 * Insert one price row per owner-day row with daily values (the owner-day
 * rows are already written), with its price basis. Returns how many new
 * bases were registered.
 */
export async function writeAnalyticsV2OwnerDayPrices(client: PostgresClient, schema: string,
  rows: readonly AnalyticsV2OwnerDayPriceRow[], refs: ReadonlyMap<string, AnalyticsV2KernelCardRef>, runId: string,
  stamp: AnalyticsV2RunStamp): Promise<number> {
  // Each distinct card list once: its sorted refs and its environment-independent digest.
  const bases = new Map<string, { readonly basisSha256: string; readonly cardRefs: readonly number[] }>();
  for (const row of rows) {
    const key = row.cardIds.join("\n");
    if (bases.has(key)) continue;
    const cards = row.cardIds.map((cardId) => {
      const ref = refs.get(cardId);
      if (ref === undefined) fail("ANALYTICS_V2_PRICE_CARD_UNREGISTERED", "ownerDayPrices.cardIds");
      return { cardId, ...ref! };
    });
    bases.set(key, Object.freeze({ basisSha256: await analyticsV2PriceCardSetSha256(cards),
      cardRefs: Object.freeze(cards.map((card) => card.cardRef).sort((left, right) => left - right)) }));
  }
  let basesRegistered = 0;
  const basisIds = new Map<string, number>();
  if (bases.size > 0) {
    const incoming = JSON.stringify([...bases.values()].map((basis) => ({ basis_sha256: basis.basisSha256,
      card_refs: basis.cardRefs })));
    basesRegistered = rowsOf(await client.query(
      `WITH incoming AS (
         SELECT basis_sha256, card_refs FROM jsonb_to_recordset($1::jsonb) AS b(basis_sha256 text, card_refs integer[])
       ), missing AS (
         SELECT i.basis_sha256, i.card_refs FROM incoming i
          WHERE NOT EXISTS (SELECT 1 FROM ${relation(schema, TABLES.priceBases)} p WHERE p.basis_sha256 = i.basis_sha256)
       ), top AS (SELECT coalesce(max(price_basis_id), 0) AS top FROM ${relation(schema, TABLES.priceBases)})
       INSERT INTO ${relation(schema, TABLES.priceBases)} (price_basis_id, basis_sha256, card_refs)
       SELECT top.top + row_number() OVER (ORDER BY m.basis_sha256 COLLATE "C")::integer, m.basis_sha256, m.card_refs
         FROM missing m CROSS JOIN top
       RETURNING price_basis_id`, [incoming]), "ANALYTICS_V2_WRITE_FAILED").length;
    const stored = rowsOf<Record<string, unknown>>(await client.query(
      `SELECT price_basis_id, basis_sha256, card_refs FROM ${relation(schema, TABLES.priceBases)}
        WHERE basis_sha256 = ANY($1::text[])`, [[...bases.values()].map((basis) => basis.basisSha256)]),
    "ANALYTICS_V2_WRITE_FAILED");
    const bySha = new Map([...bases.values()].map((basis) => [basis.basisSha256, basis]));
    for (const row of stored) {
      const basis = bySha.get(row.basis_sha256 as string);
      const refsStored = row.card_refs;
      if (basis === undefined || !Array.isArray(refsStored) || refsStored.length !== basis.cardRefs.length
          || refsStored.some((ref, index) => ref !== basis.cardRefs[index])) {
        fail("ANALYTICS_V2_PRICE_BASIS_CONFLICT");
      }
      basisIds.set(row.basis_sha256 as string, countOf(row.price_basis_id, "priceBases.id"));
    }
    if (basisIds.size !== bases.size) fail("ANALYTICS_V2_PRICE_BASIS_CONFLICT");
  }
  const kernelId = stamp.kernel.kernelId;
  await insertRecordset(client,
    `INSERT INTO ${relation(schema, TABLES.ownerDayPrice)}
       (owner_digest, day, price_basis_id, usage_events, unpriced_events, partially_priced_events, projection_version,
        codec, inputs, inputs_sha256, input_events, run_id, kernel_id, manifest_version)
     SELECT owner_digest, day, price_basis_id, usage_events, unpriced_events, partially_priced_events, projection_version,
            codec, decode(inputs, 'base64'), inputs_sha256, input_events, run_id, kernel_id, manifest_version
       FROM jsonb_to_recordset($1::jsonb)
         AS row(owner_digest text, day date, price_basis_id integer, usage_events integer, unpriced_events integer,
                partially_priced_events integer, projection_version text, codec text, inputs text, inputs_sha256 text,
                input_events integer, run_id uuid, kernel_id smallint, manifest_version integer)`,
    (function* () {
      for (const row of rows) {
        yield {
          owner_digest: row.ownerDigest,
          day: row.day,
          price_basis_id: basisIds.get(bases.get(row.cardIds.join("\n"))!.basisSha256),
          usage_events: row.usageEvents,
          unpriced_events: row.unpricedEvents,
          partially_priced_events: row.partiallyPricedEvents,
          projection_version: row.inputs.projectionVersion,
          codec: row.inputs.codec,
          inputs: row.inputs.data,
          inputs_sha256: row.inputs.sha256,
          input_events: row.inputs.events,
          run_id: runId,
          kernel_id: kernelId,
          manifest_version: stamp.manifestVersion,
        };
      }
    })(),
    "ownerDayPrices");
  return basesRegistered;
}

/**
 * The derived-regime dirtiness (engine v2 section 5.3) of the stored
 * owner-days of `ownerDigests` under the run kernel `kernelId`: the rows a
 * kernel transition makes the incremental planner recompute, or at least
 * restamp (price-transition.ts analyticsV2PriceDirtyOwnerDays). Whether a
 * transition crosses a price-registry change is read from the two kernels'
 * immutable rows (analytics_v2_kernels.price_registry_sha256). Reads only.
 */
export async function readAnalyticsV2PriceDirtyOwnerDays(client: PostgresClient, options: {
  readonly schema: string; readonly kernelId: number; readonly ownerDigests: readonly string[];
}): Promise<readonly AnalyticsV2PriceDirtyOwnerDay[]> {
  const { schema, kernelId, ownerDigests } = options;
  if (!Number.isSafeInteger(kernelId) || kernelId < 1 || !Array.isArray(ownerDigests)
      || ownerDigests.some((digest) => typeof digest !== "string" || !OWNER_DIGEST.test(digest))) {
    fail("ANALYTICS_V2_RUN_INVALID", "priceDirtiness");
  }
  const transitions = rowsOf<Record<string, unknown>>(await client.query(
    `SELECT t.transition_id, t.from_kernel::integer AS from_kernel, t.to_kernel::integer AS to_kernel, t.compatible,
            (f.price_registry_sha256 = c.price_registry_sha256) AS registry_equal
       FROM ${relation(schema, TABLES.kernelTransitions)} t
       JOIN ${relation(schema, TABLES.kernels)} f ON f.kernel_id = t.from_kernel
       JOIN ${relation(schema, TABLES.kernels)} c ON c.kernel_id = t.to_kernel
      WHERE t.to_kernel = $1::smallint ORDER BY t.transition_id`,
    [kernelId]), "ANALYTICS_V2_READ_FAILED");
  const stale = rowsOf<Record<string, unknown>>(await client.query(
    `SELECT s.transition_id, s.owner_digest, s.day::text AS day
       FROM ${relation(schema, TABLES.transitionStale)} s
       JOIN ${relation(schema, TABLES.kernelTransitions)} t ON t.transition_id = s.transition_id
      WHERE t.to_kernel = $1::smallint AND s.owner_digest = ANY($2::text[])`, [kernelId, ownerDigests]),
  "ANALYTICS_V2_READ_FAILED");
  const rows = rowsOf<Record<string, unknown>>(await client.query(
    `SELECT owner_digest, day::text AS day, kernel_id::integer AS kernel_id, (daily IS NOT NULL) AS has_daily
       FROM ${relation(schema, TABLES.ownerDay)} WHERE owner_digest = ANY($1::text[])
      ORDER BY owner_digest, day`, [ownerDigests]), "ANALYTICS_V2_READ_FAILED");
  const flag = (value: unknown, field: string): boolean => {
    if (typeof value !== "boolean") fail("ANALYTICS_V2_PRICE_STATE_INVALID", field);
    return value as boolean;
  };
  return analyticsV2PriceDirtyOwnerDays({
    currentKernelId: kernelId,
    transitions: transitions.map((row) => ({ transitionId: countOf(row.transition_id, "transitions.id"),
      fromKernel: countOf(row.from_kernel, "transitions.from"), toKernel: countOf(row.to_kernel, "transitions.to"),
      compatible: flag(row.compatible, "transitions.compatible"),
      registryEqual: flag(row.registry_equal, "transitions.registryEqual") })),
    stale: stale.map((row) => ({ transitionId: countOf(row.transition_id, "stale.id"), ownerDigest: row.owner_digest as string,
      day: row.day as string })),
    rows: rows.map((row) => ({ ownerDigest: row.owner_digest as string, day: row.day as string,
      kernelId: row.kernel_id === null ? null : countOf(row.kernel_id, "ownerDay.kernelId"),
      hasDaily: flag(row.has_daily, "ownerDay.hasDaily") })),
  });
}
