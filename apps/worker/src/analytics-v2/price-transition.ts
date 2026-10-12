/**
 * analytics-v2 kernel transitions and per-card price staleness (K-PERCARD,
 * engine v2 design section 5.3).
 *
 * A run on a kernel newer than the one that stamped stored owner-days
 * records one transition per older kernel (analytics_v2_kernel_transitions)
 * and the owner-days whose prices it makes stale
 * (analytics_v2_transition_stale). This module is the pure part: the card
 * diff, the proof over one stored owner-day's price inputs, the transition
 * verdict, and the derived-regime dirtiness a later incremental planner
 * reads. store-price.ts reads and writes the rows.
 *
 * The verdict. A transition is compatible only if BOTH hold:
 *   1. the compatibility claim: both kernels' compute class (compute_sha256,
 *      the compute closure without the vendored price registry, stamped at
 *      build time) is known and equal; and
 *   2. the proof: every stored event that the old kernel FULLY priced with
 *      cards that are all unchanged prices exactly as before (cost, status
 *      and card set) when this bundle's kernel reprices its stored inputs.
 * Otherwise it is incompatible and the derived regime goes cold.
 * Compatibility is proven, never assumed: an unknown compute class (a kernel
 * registered before K-PERCARD) is no claim.
 *
 * Stale owner-days, recorded with one cause each (the first that applies):
 *   1 card_changed:   an event selected a card the new kernel removed or
 *                     changed (same id, other content);
 *   2 repriced:       an event prices differently under the new kernel (a
 *                     new card now prices an unpriced or partially priced
 *                     event, or the proof failed for it);
 *   3 price_unknown:  the owner-day has daily values but no stored price
 *                     inputs this kernel can reprice (written before
 *                     K-PERCARD, or under another projection version).
 * An owner-day the old kernel refused (no daily values) has no price and is
 * not a price staleness; its recomputation is the compute class's concern.
 * The stale set is computed whatever the verdict, because the publication
 * regime (K-REPRICE) reprices stale heads either way.
 *
 * Registry identity is not a price staleness. Stored daily values carry the
 * price registry identity of the kernel that wrote them (registrySha256; the
 * vendored validateV11DailyProjectionValues refuses any other than its own,
 * and the merge and fold validate both inputs). A transition between kernels
 * whose registries differ (analytics_v2_kernels.price_registry_sha256)
 * therefore leaves every daily-valued owner-day of the older kernel needing
 * at least a restamp, even when the transition is compatible and the
 * owner-day is not stale. The dirtiness below derives that from the
 * immutable kernel rows ("registry"), so the recorded stale set stays the
 * price staleness only.
 *
 * Pure apart from what priceAnalyticsV2Input calls; no I/O.
 */
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import {
  ANALYTICS_V2_PRICE_PROJECTION_VERSION,
  ANALYTICS_V2_PRICE_STATUS,
  priceAnalyticsV2Input,
  sameAnalyticsV2Price,
  type AnalyticsV2PriceCard,
  type AnalyticsV2PriceInput,
  type AnalyticsV2PriceInputEvent,
  type AnalyticsV2PricedEvent,
} from "./price-attribution";

export const ANALYTICS_V2_TRANSITION_METHOD = "analytics-v2-kernel-transition-v1" as const;

/** analytics_v2_transition_stale.cause */
export const ANALYTICS_V2_STALE_CAUSE = Object.freeze({
  cardChanged: 1,
  repriced: 2,
  priceUnknown: 3,
} as const);
export type AnalyticsV2StaleCause = (typeof ANALYTICS_V2_STALE_CAUSE)[keyof typeof ANALYTICS_V2_STALE_CAUSE];

export type AnalyticsV2TransitionErrorCode = "ANALYTICS_V2_PRICE_TRANSITION_INVALID";

export class AnalyticsV2TransitionError extends Error {
  constructor(readonly code: AnalyticsV2TransitionErrorCode) {
    super(code);
    this.name = "AnalyticsV2TransitionError";
  }
}

const invalid = (): never => { throw new AnalyticsV2TransitionError("ANALYTICS_V2_PRICE_TRANSITION_INVALID"); };
const SHA256 = /^[0-9a-f]{64}$/u;
const OWNER_DIGEST = /^[0-9a-f]{64}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** The card diff from one kernel's cards to another's, by card id and content. */
export interface AnalyticsV2KernelCardDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  /** Ids present in both with the same content. */
  readonly unchanged: ReadonlySet<string>;
}

function cardMap(cards: readonly AnalyticsV2PriceCard[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const card of cards) {
    if (card === null || typeof card !== "object" || typeof card.cardId !== "string" || map.has(card.cardId)
        || typeof card.contentSha256 !== "string" || !SHA256.test(card.contentSha256)) invalid();
    map.set(card.cardId, card.contentSha256);
  }
  return map;
}

export function diffAnalyticsV2KernelCards(from: readonly AnalyticsV2PriceCard[],
  to: readonly AnalyticsV2PriceCard[]): AnalyticsV2KernelCardDiff {
  if (!Array.isArray(from) || !Array.isArray(to)) invalid();
  const before = cardMap(from), after = cardMap(to);
  const added: string[] = [], removed: string[] = [], changed: string[] = [];
  const unchanged = new Set<string>();
  for (const [cardId, content] of before) {
    const next = after.get(cardId);
    if (next === undefined) removed.push(cardId);
    else if (next !== content) changed.push(cardId);
    else unchanged.add(cardId);
  }
  for (const cardId of after.keys()) if (!before.has(cardId)) added.push(cardId);
  return Object.freeze({ added: Object.freeze(added.sort()), removed: Object.freeze(removed.sort()),
    changed: Object.freeze(changed.sort()), unchanged });
}

/** What the proof found for one stored owner-day. */
export interface AnalyticsV2DayPriceProof {
  /** The stale cause, or null when every event prices exactly as stored. */
  readonly cause: AnalyticsV2StaleCause | null;
  /** True when an event fully priced by unchanged cards priced differently: the transition is incompatible. */
  readonly violation: boolean;
  readonly events: number;
}

/**
 * Reprice one stored owner-day's inputs under this bundle's kernel (`price`,
 * injectable for specs) and compare each result with the stored one.
 */
export function proveAnalyticsV2DayPrices(events: readonly AnalyticsV2PriceInputEvent[], diff: AnalyticsV2KernelCardDiff,
  price: (input: AnalyticsV2PriceInput) => AnalyticsV2PricedEvent = priceAnalyticsV2Input): AnalyticsV2DayPriceProof {
  if (!Array.isArray(events)) invalid();
  const gone = new Set([...diff.removed, ...diff.changed]);
  let cardChanged = false, repriced = false, violation = false;
  for (const { input, priced } of events) {
    if (priced.cardIds.some((cardId) => gone.has(cardId))) cardChanged = true;
    const now = price(input);
    if (sameAnalyticsV2Price(priced, now)) continue;
    repriced = true;
    if (priced.status === ANALYTICS_V2_PRICE_STATUS.fullyPriced && priced.cardIds.every((cardId) => diff.unchanged.has(cardId))) {
      violation = true;
    }
  }
  return Object.freeze({
    cause: cardChanged ? ANALYTICS_V2_STALE_CAUSE.cardChanged : repriced ? ANALYTICS_V2_STALE_CAUSE.repriced : null,
    violation,
    events: events.length,
  });
}

/** One stale owner-day of one transition. */
export interface AnalyticsV2StaleOwnerDay {
  readonly ownerDigest: string;
  readonly day: string;
  readonly cause: AnalyticsV2StaleCause;
}

/** The proven transition from one stored kernel to the run's kernel. */
export interface AnalyticsV2PriceTransitionProof {
  readonly fromKernel: number;
  readonly toKernel: number;
  /** Both compute classes known and equal (the claim). */
  readonly computeEqual: boolean;
  /** No proof violation. */
  readonly proofHolds: boolean;
  readonly compatible: boolean;
  /** Card diff counts, or null when the older kernel's cards were never registered. */
  readonly cardsAdded: number | null;
  readonly cardsRemoved: number | null;
  readonly cardsChanged: number | null;
  /** Stored owner-days of the older kernel the proof covered (the store re-checks this count before recording). */
  readonly ownerDays: number;
  /** Stored events repriced. */
  readonly events: number;
  /** Sorted by owner, then day. */
  readonly stale: readonly AnalyticsV2StaleOwnerDay[];
}

/** Assemble and validate one transition verdict (see the module comment). */
export function analyticsV2PriceTransitionProof(input: {
  readonly fromKernel: number;
  readonly toKernel: number;
  readonly fromComputeSha256: string | null;
  readonly toComputeSha256: string | null;
  readonly diff: AnalyticsV2KernelCardDiff | null;
  readonly ownerDays: number;
  readonly events: number;
  readonly violation: boolean;
  readonly stale: readonly AnalyticsV2StaleOwnerDay[];
}): AnalyticsV2PriceTransitionProof {
  const { fromKernel, toKernel } = input;
  if (!Number.isSafeInteger(fromKernel) || !Number.isSafeInteger(toKernel) || fromKernel < 1 || fromKernel >= toKernel
      || !Number.isSafeInteger(input.ownerDays) || input.ownerDays < 0 || !Number.isSafeInteger(input.events)
      || input.events < 0 || typeof input.violation !== "boolean" || !Array.isArray(input.stale)
      || input.stale.length > input.ownerDays) invalid();
  for (const sha of [input.fromComputeSha256, input.toComputeSha256]) if (sha !== null && !SHA256.test(sha)) invalid();
  const stale = [...input.stale].sort((left, right) => left.ownerDigest < right.ownerDigest ? -1
    : left.ownerDigest > right.ownerDigest ? 1 : left.day < right.day ? -1 : left.day > right.day ? 1 : 0);
  for (const [index, entry] of stale.entries()) {
    if (!OWNER_DIGEST.test(entry.ownerDigest) || !DAY.test(entry.day)
        || !(Object.values(ANALYTICS_V2_STALE_CAUSE) as number[]).includes(entry.cause)
        || (index > 0 && stale[index - 1]!.ownerDigest === entry.ownerDigest && stale[index - 1]!.day === entry.day)) invalid();
  }
  const computeEqual = input.fromComputeSha256 !== null && input.fromComputeSha256 === input.toComputeSha256;
  const proofHolds = !input.violation;
  return Object.freeze({
    fromKernel, toKernel, computeEqual, proofHolds, compatible: computeEqual && proofHolds,
    cardsAdded: input.diff === null ? null : input.diff.added.length,
    cardsRemoved: input.diff === null ? null : input.diff.removed.length,
    cardsChanged: input.diff === null ? null : input.diff.changed.length,
    ownerDays: input.ownerDays, events: input.events, stale: Object.freeze(stale.map((entry) => Object.freeze({ ...entry }))),
  });
}

/** The projection version this bundle reprices. */
export function repriceableAnalyticsV2Projection(version: unknown): boolean {
  return version === ANALYTICS_V2_PRICE_PROJECTION_VERSION;
}

// ---------------------------------------------------------------------------
// Derived-regime dirtiness
// ---------------------------------------------------------------------------

/** Why a stored owner-day must be recomputed, or at least restamped, under the current kernel. */
export type AnalyticsV2PriceDirtyCause =
  /** Written before K-STAMP: no kernel, never inferred. */
  | "unattributed"
  /** No transition from its kernel to the current one is recorded: nothing proves it. */
  | "unproven"
  /** Its kernel's transition to the current one is incompatible: the derived regime is cold. */
  | "incompatible"
  /** Its kernel's transition is compatible but listed it stale. */
  | "stale"
  /**
   * Its kernel's transition is compatible and does not list it stale (its
   * prices are proven unchanged), but its kernel priced under another price
   * registry: its stored daily values carry that registry's identity, which
   * the current kernel's daily-value validator refuses. It must be restamped
   * with the current registry identity (or recomputed) before it is kept or
   * folded. A refused owner-day has no daily values and is never this.
   */
  | "registry";

export interface AnalyticsV2PriceDirtyOwnerDay {
  readonly ownerDigest: string;
  readonly day: string;
  readonly cause: AnalyticsV2PriceDirtyCause;
}

/**
 * The stored owner-days a run on `currentKernelId` must recompute, or at
 * least restamp, because of a kernel transition (engine v2 section 5.3):
 * every row whose kernel is not the current one, unless the recorded
 * transition from its kernel is compatible, does not list it stale, and
 * either crosses no price-registry change (`registryEqual`: both kernels'
 * analytics_v2_kernels.price_registry_sha256 are equal) or the row has no
 * daily values. A row on the current kernel is not price-dirty. Evidence
 * changes are the planner's concern, not this one. Rows are returned in
 * input order.
 */
export function analyticsV2PriceDirtyOwnerDays(input: {
  readonly currentKernelId: number;
  readonly transitions: readonly { readonly transitionId: number; readonly fromKernel: number; readonly toKernel: number;
    readonly compatible: boolean; readonly registryEqual: boolean }[];
  readonly stale: readonly { readonly transitionId: number; readonly ownerDigest: string; readonly day: string }[];
  readonly rows: readonly { readonly ownerDigest: string; readonly day: string; readonly kernelId: number | null;
    readonly hasDaily: boolean }[];
}): readonly AnalyticsV2PriceDirtyOwnerDay[] {
  if (!Number.isSafeInteger(input.currentKernelId) || input.currentKernelId < 1 || !Array.isArray(input.transitions)
      || !Array.isArray(input.stale) || !Array.isArray(input.rows)) invalid();
  const toCurrent = new Map<number, { transitionId: number; compatible: boolean; registryEqual: boolean }>();
  for (const transition of input.transitions) {
    if (transition.toKernel !== input.currentKernelId) continue;
    if (toCurrent.has(transition.fromKernel) || typeof transition.compatible !== "boolean"
        || typeof transition.registryEqual !== "boolean") invalid();
    toCurrent.set(transition.fromKernel, { transitionId: transition.transitionId, compatible: transition.compatible,
      registryEqual: transition.registryEqual });
  }
  const stale = new Set(input.stale.map((entry) => `${entry.transitionId}:${entry.ownerDigest}:${entry.day}`));
  const dirty: AnalyticsV2PriceDirtyOwnerDay[] = [];
  for (const row of input.rows) {
    if (!OWNER_DIGEST.test(row.ownerDigest) || !DAY.test(row.day) || typeof row.hasDaily !== "boolean") invalid();
    if (row.kernelId === input.currentKernelId) continue;
    let cause: AnalyticsV2PriceDirtyCause | null;
    if (row.kernelId === null) cause = "unattributed";
    else if (!Number.isSafeInteger(row.kernelId) || row.kernelId > input.currentKernelId) return invalid();
    else {
      const transition = toCurrent.get(row.kernelId);
      cause = transition === undefined ? "unproven" : !transition.compatible ? "incompatible"
        : stale.has(`${transition.transitionId}:${row.ownerDigest}:${row.day}`) ? "stale"
          : !transition.registryEqual && row.hasDaily ? "registry" : null;
    }
    if (cause !== null) dirty.push(Object.freeze({ ownerDigest: row.ownerDigest, day: row.day, cause }));
  }
  return Object.freeze(dirty);
}

/**
 * A model window's price-basis digest (engine v2 section 3.2: a scalar or
 * model-date memo key includes it): each day of the window with the digest
 * of its price basis (analytics_v2_price_bases.basis_sha256), or null when
 * the day has no price row (no evidence, or refused). A stale day's new basis
 * changes the digest of exactly the windows that contain it.
 */
export async function analyticsV2WindowPriceBasisSha256(
  days: readonly { readonly day: string; readonly basisSha256: string | null }[]): Promise<string> {
  if (!Array.isArray(days)) invalid();
  const entries = [...days].sort((left, right) => (left.day < right.day ? -1 : left.day > right.day ? 1 : 0));
  for (const [index, entry] of entries.entries()) {
    if (!DAY.test(entry.day) || (entry.basisSha256 !== null && !SHA256.test(entry.basisSha256))
        || (index > 0 && entries[index - 1]!.day === entry.day)) invalid();
  }
  return sha256Hex(canonicalJson([ANALYTICS_V2_TRANSITION_METHOD, entries.map((entry) => [entry.day, entry.basisSha256])]));
}
