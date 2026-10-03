/**
 * analytics_v2 store, prices (K-PERCARD, engine v2 design section 5): the
 * price cards each kernel prices with, the deduplicated price bases, each
 * owner-day's price row, and the kernel transitions with their stale
 * owner-days (primary migration 0072_analytics_v2_price_cards.sql).
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
 * W1E (staged migration analytics_v2_pricing_classes; refresh optimization
 * program section 3.2.1, rank 4): a run whose bundle states a pricer
 * (kernel.ts analyticsV2BundledPricer) also registers its kernel's PRICING
 * CLASS in step 1, and the proof in step 2 is established in one of two ways,
 * recorded per transition (analytics_v2_transition_proofs):
 *  - method 1, reprice: every stored event of the older kernel is repriced
 *    under this bundle's kernel (K-PERCARD's proof). It is used whenever
 *    either kernel's pricing class is unknown (a kernel registered before
 *    W1E, or a bundle stating no pricer) or the classes differ: fail closed.
 *  - method 2, pricing-class identity: both kernels are registered in the
 *    same pricing class (the same pricing code, method version, projection
 *    and cards), so every stored input prices exactly as stored and the
 *    proof holds by that identity. The proof still reads every owner-day's
 *    row metadata (the counts, the price-unknown stale owner-days and the
 *    stored kernel and projection checks are the same as method 1's), but
 *    reprices only a deterministic sample of about 1 in
 *    ANALYTICS_V2_PRICING_CLASS_SAMPLE_DIVISOR owner-days (keyed by the
 *    class, the two kernels and the owner-day; the first priced owner-day
 *    always), never fetching the other owner-days' stored inputs. A sampled
 *    owner-day that does not price exactly as stored is a pricing class that
 *    under-covers its pricer: ANALYTICS_V2_PRICING_CLASS_SAMPLE_MISMATCH ends
 *    the run and nothing is written.
 * Either method yields the same verdict, counts and stale set for the same
 * stored state, so the recorded transition is the same; only the work and
 * the analytics_v2_transition_proofs row differ. A bundle stating no pricer
 * records no pricing class and no proof-method row.
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

import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import type { PostgresClient } from "../postgres-client";
import { ANALYTICS_V2_TABLES, type AnalyticsV2OwnerDayPriceRow } from "./contract";
import {
  analyticsV2BundledPricer,
  analyticsV2PricingClass,
  type AnalyticsV2Pricer,
  type AnalyticsV2PricingClass,
  type AnalyticsV2RunStamp,
} from "./kernel";
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
  type AnalyticsV2KernelCardDiff,
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
/** Stored owner-days read per page by a pricing-class identity proof (metadata only). */
const IDENTITY_PAGE_ROWS = 2_000;
const OWNER_DIGEST = /^[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

/**
 * W1E's tables (staged migration analytics_v2_pricing_classes). They decide
 * no stored value, so they stay out of contract.ts (the compute closure).
 */
export const ANALYTICS_V2_PRICING_CLASS_TABLES = Object.freeze({
  pricingClasses: "analytics_v2_pricing_classes",
  kernelPricingClasses: "analytics_v2_kernel_pricing_classes",
  transitionProofs: "analytics_v2_transition_proofs",
} as const);
export const ANALYTICS_V2_PRICING_CLASS_COLUMNS = Object.freeze({
  pricingClasses: Object.freeze(["pricing_class_id", "class_sha256", "pricer_sha256", "pricing_method_version",
    "projection_version", "cards_sha256", "first_kernel_id", "registered_at"] as const),
  kernelPricingClasses: Object.freeze(["kernel_id", "pricing_class_id", "registered_at"] as const),
  transitionProofs: Object.freeze(["transition_id", "method", "pricing_class_id", "sample_divisor",
    "repriced_owner_days", "repriced_events"] as const),
} as const);
export const ANALYTICS_V2_PRICING_CLASS_PRIMARY_KEYS = Object.freeze({
  pricingClasses: Object.freeze(["pricing_class_id"] as const),
  kernelPricingClasses: Object.freeze(["kernel_id"] as const),
  transitionProofs: Object.freeze(["transition_id"] as const),
} as const);
const CLASS_TABLES = ANALYTICS_V2_PRICING_CLASS_TABLES;

/** analytics_v2_transition_proofs.method */
export const ANALYTICS_V2_TRANSITION_PROOF_METHOD = Object.freeze({ reprice: 1, pricingClass: 2 } as const);
/** A pricing-class identity proof reprices about one owner-day in this many. */
export const ANALYTICS_V2_PRICING_CLASS_SAMPLE_DIVISOR = 100;
/** The sample key's method (analyticsV2PricingClassSampled). */
export const ANALYTICS_V2_PRICING_CLASS_SAMPLE_METHOD = "analytics-v2-pricing-class-sample-v1" as const;

export type AnalyticsV2PricingClassErrorCode =
  | "ANALYTICS_V2_PRICING_CLASS_CONFLICT"
  | "ANALYTICS_V2_PRICING_CLASS_SAMPLE_MISMATCH"
  | "ANALYTICS_V2_PRICING_CLASS_STATE_INVALID";

/** A closed, content-free pricing-class failure: the run ends, nothing is written. */
export class AnalyticsV2PricingClassError extends Error {
  constructor(readonly code: AnalyticsV2PricingClassErrorCode) {
    super(code);
    this.name = "AnalyticsV2PricingClassError";
  }
}

const classFail = (code: AnalyticsV2PricingClassErrorCode): never => { throw new AnalyticsV2PricingClassError(code); };

/** How one transition's proof was established (analytics_v2_transition_proofs). */
export interface AnalyticsV2TransitionEstablishment {
  readonly method: (typeof ANALYTICS_V2_TRANSITION_PROOF_METHOD)[keyof typeof ANALYTICS_V2_TRANSITION_PROOF_METHOD];
  /** The shared class (method 2), else null. */
  readonly pricingClassId: number | null;
  readonly sampleDivisor: number | null;
  readonly repricedOwnerDays: number;
  readonly repricedEvents: number;
}

/** A proven transition with how its proof was established (absent when the bundle states no pricer). */
export type AnalyticsV2EstablishedTransitionProof = AnalyticsV2PriceTransitionProof & {
  readonly establishment?: AnalyticsV2TransitionEstablishment;
};

/**
 * Whether a pricing-class identity proof reprices this owner-day: about one
 * in ANALYTICS_V2_PRICING_CLASS_SAMPLE_DIVISOR, keyed by the class, the two
 * kernels and the owner-day, so each transition samples its own owner-days
 * and a rerun samples the same ones.
 */
export async function analyticsV2PricingClassSampled(input: {
  readonly classSha256: string; readonly fromKernel: number; readonly toKernel: number;
  readonly ownerDigest: string; readonly day: string;
}): Promise<boolean> {
  const key = await sha256Hex(canonicalJson([ANALYTICS_V2_PRICING_CLASS_SAMPLE_METHOD, input.classSha256,
    input.fromKernel, input.toKernel, input.ownerDigest, input.day]));
  return Number.parseInt(key.slice(0, 12), 16) % ANALYTICS_V2_PRICING_CLASS_SAMPLE_DIVISOR === 0;
}

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
  cards: AnalyticsV2KernelPriceCards,
  pricer: AnalyticsV2Pricer | null = analyticsV2BundledPricer()): Promise<{
    readonly refs: ReadonlyMap<string, AnalyticsV2KernelCardRef>;
    readonly cardsRegistered: number;
    /** W1E: the kernel's pricing class, or null when the bundle stated no pricer (unknown). */
    readonly pricingClass: { readonly pricingClassId: number; readonly classSha256: string } | null }> {
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
  const pricingClass = pricer === null ? null : await registerAnalyticsV2PricingClass(client, schema, kernelId,
    await analyticsV2PricingClass({ pricer, projectionVersion: ANALYTICS_V2_PRICE_PROJECTION_VERSION,
      cardsSha256: cards.cardsSha256 }), registeredAt);
  return Object.freeze({
    refs: new Map(stored!.registered.map((card) => [card.cardId, Object.freeze({ cardRef: card.cardRef,
      contentSha256: card.contentSha256 })])),
    cardsRegistered,
    pricingClass,
  });
}

/** The stored pricing class of `kernelId`, or null when it has none (unknown). */
async function readKernelPricingClass(client: PostgresClient, schema: string, kernelId: number): Promise<{
  readonly pricingClassId: number; readonly classSha256: string;
} | null> {
  const rows = rowsOf<Record<string, unknown>>(await client.query(
    `SELECT k.pricing_class_id, c.class_sha256
       FROM ${relation(schema, CLASS_TABLES.kernelPricingClasses)} k
       JOIN ${relation(schema, CLASS_TABLES.pricingClasses)} c ON c.pricing_class_id = k.pricing_class_id
      WHERE k.kernel_id = $1::smallint`, [kernelId]), "ANALYTICS_V2_READ_FAILED");
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (typeof row.class_sha256 !== "string" || !SHA256.test(row.class_sha256)) classFail("ANALYTICS_V2_PRICING_CLASS_STATE_INVALID");
  return Object.freeze({ pricingClassId: countOf(row.pricing_class_id, "pricingClasses.id"),
    classSha256: row.class_sha256 as string });
}

/**
 * Register `pricingClass` (once, with the stored maximum id plus one) and
 * link `kernelId` to it (once); a stored class or link that differs is
 * ANALYTICS_V2_PRICING_CLASS_CONFLICT. Runs inside the write transaction,
 * after the kernel's cards (the migration's trigger holds the class to them).
 */
async function registerAnalyticsV2PricingClass(client: PostgresClient, schema: string, kernelId: number,
  pricingClass: AnalyticsV2PricingClass, registeredAt: string): Promise<{
    readonly pricingClassId: number; readonly classSha256: string }> {
  await client.query(
    `INSERT INTO ${relation(schema, CLASS_TABLES.pricingClasses)}
       (pricing_class_id, class_sha256, pricer_sha256, pricing_method_version, projection_version, cards_sha256,
        first_kernel_id, registered_at)
     SELECT coalesce(max(pricing_class_id), 0) + 1, $1, $2, $3, $4, $5, $6::smallint, $7::timestamptz
       FROM ${relation(schema, CLASS_TABLES.pricingClasses)}
     ON CONFLICT (class_sha256) DO NOTHING`,
    [pricingClass.classSha256, pricingClass.pricerSha256, pricingClass.pricingMethodVersion,
      pricingClass.projectionVersion, pricingClass.cardsSha256, kernelId, registeredAt]);
  const stored = rowsOf<Record<string, unknown>>(await client.query(
    `SELECT pricing_class_id, pricer_sha256, pricing_method_version, projection_version, cards_sha256
       FROM ${relation(schema, CLASS_TABLES.pricingClasses)} WHERE class_sha256 = $1`, [pricingClass.classSha256]),
  "ANALYTICS_V2_WRITE_FAILED");
  if (stored.length !== 1 || stored[0]!.pricer_sha256 !== pricingClass.pricerSha256
      || stored[0]!.pricing_method_version !== pricingClass.pricingMethodVersion
      || stored[0]!.projection_version !== pricingClass.projectionVersion
      || stored[0]!.cards_sha256 !== pricingClass.cardsSha256) {
    classFail("ANALYTICS_V2_PRICING_CLASS_CONFLICT");
  }
  const pricingClassId = countOf(stored[0]!.pricing_class_id, "pricingClasses.id");
  await client.query(
    `INSERT INTO ${relation(schema, CLASS_TABLES.kernelPricingClasses)} (kernel_id, pricing_class_id, registered_at)
     VALUES ($1::smallint, $2::integer, $3::timestamptz)
     ON CONFLICT (kernel_id) DO NOTHING`, [kernelId, pricingClassId, registeredAt]);
  const linked = await readKernelPricingClass(client, schema, kernelId);
  if (linked === null || linked.pricingClassId !== pricingClassId || linked.classSha256 !== pricingClass.classSha256) {
    classFail("ANALYTICS_V2_PRICING_CLASS_CONFLICT");
  }
  return Object.freeze({ pricingClassId, classSha256: pricingClass.classSha256 });
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
 * inputs (price-transition.ts), by a full reprice or, when both kernels are
 * in the same pricing class, by that identity with a sampled reprice (see the
 * module comment). Reads only; the Job runs it in its read snapshot. `cards`,
 * `price` and `pricer` default to this bundle's kernel (a spec may state
 * others; a null `pricer` is an unknown pricing class).
 */
export async function proveAnalyticsV2PriceTransitions(client: PostgresClient, options: {
  readonly schema: string;
  readonly stamp: AnalyticsV2RunStamp;
  readonly cards?: AnalyticsV2KernelPriceCards;
  readonly price?: (input: AnalyticsV2PriceInput) => AnalyticsV2PricedEvent;
  readonly pricer?: AnalyticsV2Pricer | null;
}): Promise<AnalyticsV2PriceTransitions> {
  const { schema, stamp } = options;
  const toKernel = stamp.kernel.kernelId;
  const cards = options.cards ?? await analyticsV2KernelPriceCards();
  const pricer = options.pricer === undefined ? analyticsV2BundledPricer() : options.pricer;
  // W1E: this bundle's pricing class; null (unknown) proves every transition by a full reprice.
  const toClass = pricer === null ? null : await analyticsV2PricingClass({ pricer,
    projectionVersion: ANALYTICS_V2_PRICE_PROJECTION_VERSION, cardsSha256: cards.cardsSha256 });
  const transitions: AnalyticsV2EstablishedTransitionProof[] = [];
  for (const { fromKernel, ownerDays: expected } of await pendingTransitions(client, schema, toKernel)) {
    const from = await readKernelPrices(client, schema, fromKernel);
    const diff = from === null ? null : diffAnalyticsV2KernelCards(from.registered, cards.cards);
    const fromClass = toClass === null ? null : await readKernelPricingClass(client, schema, fromKernel);
    const shared = toClass !== null && fromClass !== null && fromClass.classSha256 === toClass.classSha256
      ? fromClass : null;
    if (shared !== null && (from === null || diff === null || diff.added.length + diff.removed.length
        + diff.changed.length !== 0 || from.cardsSha256 !== cards.cardsSha256
        || from.projectionVersion !== ANALYTICS_V2_PRICE_PROJECTION_VERSION)) {
      // One class, other cards or projection: the stored class does not describe the stored kernel.
      classFail("ANALYTICS_V2_PRICING_CLASS_STATE_INVALID");
    }
    const proven = shared === null
      ? await proveByReprice(client, schema, { fromKernel, diff, price: options.price })
      : await proveByPricingClass(client, schema, { fromKernel, toKernel, diff: diff!, price: options.price,
        classSha256: shared.classSha256 });
    if (proven.ownerDays !== expected) fail("ANALYTICS_V2_PRICE_TRANSITION_STALE");
    const proof = analyticsV2PriceTransitionProof({ fromKernel, toKernel, fromComputeSha256: from?.computeSha256 ?? null,
      toComputeSha256: stamp.computeSha256 ?? null, diff, ownerDays: proven.ownerDays, events: proven.events,
      violation: proven.violation, stale: proven.stale });
    transitions.push(toClass === null ? proof : Object.freeze({ ...proof, establishment: Object.freeze({
      method: shared === null ? ANALYTICS_V2_TRANSITION_PROOF_METHOD.reprice : ANALYTICS_V2_TRANSITION_PROOF_METHOD.pricingClass,
      pricingClassId: shared === null ? null : shared.pricingClassId,
      sampleDivisor: shared === null ? null : ANALYTICS_V2_PRICING_CLASS_SAMPLE_DIVISOR,
      repricedOwnerDays: proven.repricedOwnerDays,
      repricedEvents: proven.repricedEvents,
    }) }));
  }
  return Object.freeze({ toKernel, transitions: Object.freeze(transitions) });
}

/** What one older kernel's stored owner-days proved. */
interface ProvenOwnerDays {
  readonly ownerDays: number;
  readonly events: number;
  readonly violation: boolean;
  readonly stale: readonly AnalyticsV2StaleOwnerDay[];
  readonly repricedOwnerDays: number;
  readonly repricedEvents: number;
}

/**
 * One stored owner-day row's checks before any reprice, shared by both
 * methods: a refused owner-day is skipped, a missing or other-projection
 * price row is price-unknown, and a price row of another kernel (or of a
 * kernel without cards) is invalid state. Returns whether it reprices.
 */
function priceRowStatus(row: Record<string, unknown>, fromKernel: number, diff: AnalyticsV2KernelCardDiff | null):
"skip" | "unknown" | "reprice" {
  if (row.has_daily !== true) return "skip";
  if (row.price_kernel === null) return "unknown";
  // A price row is written with its owner-day row by the same kernel, after that kernel's cards.
  if (row.price_kernel !== fromKernel || diff === null) fail("ANALYTICS_V2_PRICE_STATE_INVALID", "ownerDayPrice");
  return repriceableAnalyticsV2Projection(row.projection_version) ? "reprice" : "unknown";
}

function ownerDayKey(row: Record<string, unknown>): { ownerDigest: string; day: string } {
  if (typeof row.owner_digest !== "string" || !OWNER_DIGEST.test(row.owner_digest) || typeof row.day !== "string") {
    fail("ANALYTICS_V2_PRICE_STATE_INVALID", "ownerDay");
  }
  return { ownerDigest: row.owner_digest as string, day: row.day as string };
}

/** Decode one stored owner-day's inputs (the codec checks digest and event count) and prove them. */
async function proveStoredDay(row: Record<string, unknown>, diff: AnalyticsV2KernelCardDiff,
  price: ((input: AnalyticsV2PriceInput) => AnalyticsV2PricedEvent) | undefined) {
  const decoded = await decodeAnalyticsV2PriceInputs({ projectionVersion: row.projection_version as string,
    codec: row.codec as string, sha256: row.inputs_sha256 as string, events: row.input_events as number,
    bytes: row.inputs as Uint8Array });
  return proveAnalyticsV2DayPrices(decoded.events, diff, price);
}

/** Method 1 (K-PERCARD): reprice every stored event of `fromKernel`. */
async function proveByReprice(client: PostgresClient, schema: string, input: {
  readonly fromKernel: number; readonly diff: AnalyticsV2KernelCardDiff | null;
  readonly price: ((input: AnalyticsV2PriceInput) => AnalyticsV2PricedEvent) | undefined;
}): Promise<ProvenOwnerDays> {
  const { fromKernel, diff } = input;
  const stale: AnalyticsV2StaleOwnerDay[] = [];
  let ownerDays = 0, events = 0, violation = false, repriced = 0;
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
      const key = ownerDayKey(row);
      ownerDays += 1;
      after = key;
      const status = priceRowStatus(row, fromKernel, diff);
      if (status === "skip") continue;
      if (status === "unknown") {
        stale.push({ ...key, cause: ANALYTICS_V2_STALE_CAUSE.priceUnknown });
        continue;
      }
      const proof = await proveStoredDay(row, diff!, input.price);
      events += proof.events;
      repriced += 1;
      violation ||= proof.violation;
      if (proof.cause !== null) stale.push({ ...key, cause: proof.cause });
    }
    if (page.length < PROOF_PAGE_ROWS) break;
  }
  return { ownerDays, events, violation, stale, repricedOwnerDays: repriced, repricedEvents: events };
}

/**
 * Method 2 (W1E): both kernels are in the same pricing class, so every stored
 * input prices as stored. Every owner-day's metadata is read and checked as
 * method 1 checks it, its event count is the stored one (the codec holds
 * input_events to the document whenever it is decoded), and only the
 * sampled owner-days' inputs are fetched, decoded and repriced; any of them
 * that does not price exactly as stored is ANALYTICS_V2_PRICING_CLASS_SAMPLE_MISMATCH.
 */
async function proveByPricingClass(client: PostgresClient, schema: string, input: {
  readonly fromKernel: number; readonly toKernel: number; readonly diff: AnalyticsV2KernelCardDiff;
  readonly classSha256: string;
  readonly price: ((input: AnalyticsV2PriceInput) => AnalyticsV2PricedEvent) | undefined;
}): Promise<ProvenOwnerDays> {
  const { fromKernel, toKernel, diff, classSha256 } = input;
  const stale: AnalyticsV2StaleOwnerDay[] = [];
  let ownerDays = 0, events = 0, repricedOwnerDays = 0, repricedEvents = 0, priced = 0;
  let after: { ownerDigest: string; day: string } | null = null;
  for (;;) {
    const page = rowsOf<Record<string, unknown>>(await client.query(
      `SELECT d.owner_digest, d.day::text AS day, (d.daily IS NOT NULL) AS has_daily,
              p.kernel_id::integer AS price_kernel, p.projection_version, p.input_events
         FROM ${relation(schema, TABLES.ownerDay)} d
         LEFT JOIN ${relation(schema, TABLES.ownerDayPrice)} p ON p.owner_digest = d.owner_digest AND p.day = d.day
        WHERE d.kernel_id = $1::smallint
          AND ($2::text IS NULL OR (d.owner_digest, d.day) > ($2::text, $3::date))
        ORDER BY d.owner_digest, d.day
        LIMIT $4::integer`,
      [fromKernel, after?.ownerDigest ?? null, after?.day ?? null, IDENTITY_PAGE_ROWS]), "ANALYTICS_V2_READ_FAILED");
    const sampled: { ownerDigest: string; day: string }[] = [];
    for (const row of page) {
      const key = ownerDayKey(row);
      ownerDays += 1;
      after = key;
      const status = priceRowStatus(row, fromKernel, diff);
      if (status === "skip") continue;
      if (status === "unknown") {
        stale.push({ ...key, cause: ANALYTICS_V2_STALE_CAUSE.priceUnknown });
        continue;
      }
      events += countOf(row.input_events, "ownerDayPrice.inputEvents");
      // The first priced owner-day is always sampled, so a non-empty transition is never proven by identity alone.
      if (priced++ === 0 || await analyticsV2PricingClassSampled({ classSha256, fromKernel, toKernel, ...key })) {
        sampled.push(key);
      }
    }
    if (sampled.length > 0) {
      const rows = rowsOf<Record<string, unknown>>(await client.query(
        `SELECT p.owner_digest, p.day::text AS day, p.kernel_id::integer AS price_kernel, p.projection_version, p.codec,
                p.inputs, p.inputs_sha256, p.input_events
           FROM unnest($2::text[], $3::date[]) AS s(owner_digest, day)
           JOIN ${relation(schema, TABLES.ownerDayPrice)} p ON p.owner_digest = s.owner_digest AND p.day = s.day
          WHERE p.kernel_id = $1::smallint
          ORDER BY p.owner_digest, p.day`,
        [fromKernel, sampled.map((key) => key.ownerDigest), sampled.map((key) => key.day)]), "ANALYTICS_V2_READ_FAILED");
      if (rows.length !== sampled.length) fail("ANALYTICS_V2_PRICE_TRANSITION_STALE");
      for (const row of rows) {
        const proof = await proveStoredDay(row, diff, input.price);
        repricedOwnerDays += 1;
        repricedEvents += proof.events;
        if (proof.cause !== null || proof.violation) classFail("ANALYTICS_V2_PRICING_CLASS_SAMPLE_MISMATCH");
      }
    }
    if (page.length < IDENTITY_PAGE_ROWS) break;
  }
  return { ownerDays, events, violation: false, stale, repricedOwnerDays, repricedEvents };
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
  // W1E: every establishment is checked before any row is written.
  for (const transition of proof.transitions as readonly AnalyticsV2EstablishedTransitionProof[]) {
    if (transition.establishment !== undefined) validEstablishment(transition, transition.establishment);
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
    const establishment = (transition as AnalyticsV2EstablishedTransitionProof).establishment;
    if (establishment !== undefined) {
      await recordAnalyticsV2TransitionEstablishment(client, schema, transitionId, transition, establishment);
    }
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
 * How one transition's proof was established (W1E), checked: method 1
 * repriced every event and names no class; method 2 names a class, the
 * sample divisor and a proof that holds. The class itself is checked against
 * both kernels' stored classes by the migration's trigger when it is recorded.
 */
function validEstablishment(transition: AnalyticsV2PriceTransitionProof,
  establishment: AnalyticsV2TransitionEstablishment): void {
  if (establishment === null || typeof establishment !== "object") classFail("ANALYTICS_V2_PRICING_CLASS_STATE_INVALID");
  const { method, pricingClassId, sampleDivisor, repricedOwnerDays, repricedEvents } = establishment;
  const identity = method === ANALYTICS_V2_TRANSITION_PROOF_METHOD.pricingClass;
  if ((method !== ANALYTICS_V2_TRANSITION_PROOF_METHOD.reprice && !identity)
      || !Number.isSafeInteger(repricedOwnerDays) || repricedOwnerDays < 0 || repricedOwnerDays > transition.ownerDays
      || !Number.isSafeInteger(repricedEvents) || repricedEvents < 0 || repricedEvents > transition.events
      || (identity ? !Number.isSafeInteger(pricingClassId) || (pricingClassId as number) < 1
        || sampleDivisor !== ANALYTICS_V2_PRICING_CLASS_SAMPLE_DIVISOR || !transition.proofHolds
        : pricingClassId !== null || sampleDivisor !== null || repricedEvents !== transition.events)) {
    classFail("ANALYTICS_V2_PRICING_CLASS_STATE_INVALID");
  }
}

async function recordAnalyticsV2TransitionEstablishment(client: PostgresClient, schema: string, transitionId: number,
  transition: AnalyticsV2PriceTransitionProof, establishment: AnalyticsV2TransitionEstablishment): Promise<void> {
  validEstablishment(transition, establishment);
  const { method, pricingClassId, sampleDivisor, repricedOwnerDays, repricedEvents } = establishment;
  const inserted = rowsOf(await client.query(
    `INSERT INTO ${relation(schema, CLASS_TABLES.transitionProofs)}
       (transition_id, method, pricing_class_id, sample_divisor, repriced_owner_days, repriced_events)
     VALUES ($1::integer, $2::smallint, $3::integer, $4::integer, $5::integer, $6::bigint)
     RETURNING transition_id`,
    [transitionId, method, pricingClassId, sampleDivisor, repricedOwnerDays, repricedEvents]), "ANALYTICS_V2_WRITE_FAILED");
  if (inserted.length !== 1) fail("ANALYTICS_V2_WRITE_FAILED", "transitionProofs");
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
