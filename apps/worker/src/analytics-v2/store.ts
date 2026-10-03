/**
 * analytics_v2 store: the one write path of the analytics-refresh Job (A-3).
 *
 * writeRunOutputs persists one computeAnalyticsV2 result (contract.ts
 * AnalyticsV2RunOutputs) in ONE transaction on a dedicated client:
 *
 *  1. it re-takes the refresh advisory lock at transaction scope (re-entrant
 *     for the Job's session that already holds it; any other session is
 *     refused) and re-reads the journal cursor FOR UPDATE, refusing a cursor
 *     that moved since the Job's read snapshot;
 *  1a. it registers the run kernel's price cards and records the kernel
 *     transitions from older stored kernels with their stale owner-days
 *     (K-PERCARD, store-price.ts);
 *  2. it replaces the owner-scoped families (owner_day with its price rows, cache_bands,
 *     owner_fits, owner_model_dates) of the owners this run computed (source
 *     'effective'), and only inside the run's horizon: owner_day rows from
 *     horizon.ownerDayFromDay and cache_bands rows from
 *     horizon.cacheBandsFromDay. Rows of owners the run did not compute
 *     (opted out, disconnected, expired, unlinked or not ported) and rows
 *     older than the horizon are retained, never retired: a roster change
 *     stops future contributions only, and a display window is not a
 *     retention policy. The manual offline erasure runbook is the only path
 *     that deletes an owner's rows;
 *  3. it publishes each daily candidate whose content digest differs from the
 *     stored head: revision = max(previous, the day's revision floor,
 *     revisionSeed) + 1 (store-publication.ts nextPublishedRevision; REV-SEED)
 *     and releasedAt = nowMs. An unchanged digest keeps the row untouched, and a
 *     blocked day is never written, so it keeps its prior row (or stays
 *     absent). Each published day records its saved owner set and member
 *     contributions at that revision (store-owner-sets.ts, E-OWNERSET), after
 *     checking that the set the fold used is still the stored one; an
 *     unchanged head whose set was never recorded is adopted at its own
 *     revision;
 *  4. it upserts the preview, advances the journal cursor (never backwards),
 *     and inserts the run row with the refusal list, the publication
 *     summary, the kernel stamp and the digest of the community aggregate
 *     exclusions the run applied (N-EXCL).
 *
 * Any failure rolls the whole transaction back: no analytics_v2 row changes.
 *
 * Determinism (the zero-diff parity gate): a published payload is the
 * candidate payload with its three revision-bound fields (aggregateId,
 * revision, releasedAt) replaced by the values this store assigns, and
 * payload_sha256 digests the payload WITHOUT those fields. Given the same
 * prior state, revision floor, nowMs and revisionSeed, the stored rows are
 * byte-identical.
 * The candidate's payloadSha256 must equal analyticsV2DailyContentSha256 of
 * its payload; a disagreement is refused rather than silently re-derived.
 *
 * Errors carry closed codes, a field path at most and a SQLSTATE; never a
 * driver message, SQL text, bind value or kernel value.
 *
 * Layout (K-SPLIT): this module is the transaction and the public facade;
 * store-run.ts holds the output validation, the lock and cursor, the run row
 * and the prior-state read; store-derived.ts the owner-scoped families;
 * store-publication.ts the published heads and the preview;
 * store-owner-sets.ts the saved owner sets and contributions.
 */

import type { PostgresClient } from "../postgres-client";
import { ANALYTICS_V2_SHA256_PATTERN, type AnalyticsV2PublicationSummary, type AnalyticsV2RunOutputs } from "./contract";
import { analyticsV2CompatibilitySha256 } from "./kernel";
import { writeAnalyticsV2DerivedFamilies } from "./store-derived";
import { AnalyticsV2PriceError, analyticsV2KernelPriceCards } from "./price-attribution";
import { AnalyticsV2TransitionError } from "./price-transition";
import {
  AnalyticsV2PricingClassError,
  proveAnalyticsV2PriceTransitions,
  recordAnalyticsV2PriceTransitions,
  registerAnalyticsV2KernelPrices,
  writeAnalyticsV2OwnerDayPrices,
} from "./store-price";
import { writeAnalyticsV2OwnerSets } from "./store-owner-sets";
import { writeAnalyticsV2Preview, writeAnalyticsV2PublishedDaily } from "./store-publication";
// REV-SEED: the one published-revision computation, for every publishing path.
export { nextPublishedRevision } from "./store-publication";
import {
  AnalyticsV2StoreError,
  UUID,
  DECIMAL,
  advanceAnalyticsV2Cursor,
  fail,
  insertAnalyticsV2RunRow,
  lockAnalyticsV2Run,
  registerAnalyticsV2RunKernel,
  validRunStamp,
  prepareOutputs,
  quoteSchema,
  sortedDays,
  sqlStateOf,
  validHorizon,
  validTimings,
  WRITE_LOCK_TIMEOUT_MILLISECONDS,
  WRITE_STATEMENT_TIMEOUT_MILLISECONDS,
  type AnalyticsV2WriteReceipt,
  type WriteAnalyticsV2RunOptions,
} from "./store-run";

// The store's public surface (K-SPLIT): one import path for the Job, the
// route and the specs, whichever module now holds a name.
// The kernel stamp (K-STAMP): the Job resolves its bundle's kernel here.
export {
  ANALYTICS_V2_MANIFEST_BASELINE_VERSION,
  ANALYTICS_V2_METHOD_VERSION,
  analyticsV2BaselineRunStamp,
  analyticsV2BundledKernelIdentity,
  analyticsV2BundledPricer,
  analyticsV2PricingClass,
  analyticsV2KernelRegistry,
  resolveAnalyticsV2Kernel,
} from "./kernel";
export type { AnalyticsV2KernelEntry, AnalyticsV2KernelIdentity, AnalyticsV2RunStamp, AnalyticsV2Pricer, AnalyticsV2PricingClass } from "./kernel";
// K-PERCARD: the transition proof the Job runs in its read snapshot, and the
// derived-regime dirtiness an incremental planner reads.
export { ANALYTICS_V2_PRICING_CLASS_TABLES, ANALYTICS_V2_PRICING_CLASS_COLUMNS,
  ANALYTICS_V2_PRICING_CLASS_PRIMARY_KEYS, AnalyticsV2PricingClassError, analyticsV2PricingClassSampled,
  proveAnalyticsV2PriceTransitions, readAnalyticsV2PriceDirtyOwnerDays } from "./store-price";
export type { AnalyticsV2PriceTransitions, AnalyticsV2PriceWriteSummary } from "./store-run";
// E-OWNERSET: the contribution digests (the published revision is nextPublishedRevision above).
export { analyticsV2ContributionDigests } from "./owner-sets";
export {
  ANALYTICS_V2_CACHE_BANDS,
  ANALYTICS_V2_DAILY_REVISION_FIELDS,
  ANALYTICS_V2_MAX_DAILY_PAYLOAD_BYTES,
  ANALYTICS_V2_MAX_REVISION_SEED,
  ANALYTICS_V2_OUTPUT_LIMITS,
  ANALYTICS_V2_REVISION_FLOOR_COLUMNS,
  ANALYTICS_V2_REVISION_FLOOR_PRIMARY_KEYS,
  ANALYTICS_V2_REVISION_FLOOR_TABLES,
  AnalyticsV2StoreError,
  analyticsV2DailyContentSha256,
  analyticsV2UtcDay,
  assertAnalyticsV2RunOutputs,
  isAnalyticsV2Day,
  readAnalyticsV2RefreshState,
  stampAnalyticsV2DailyPayload,
} from "./store-run";
export type {
  AnalyticsV2RefreshState,
  AnalyticsV2RevisionFloorSummary,
  AnalyticsV2RunHorizon,
  AnalyticsV2StoreErrorCode,
  AnalyticsV2WriteReceipt,
  WriteAnalyticsV2RunOptions,
} from "./store-run";

/**
 * Persist one run's outputs atomically (see the module comment). Throws an
 * AnalyticsV2StoreError and leaves every analytics_v2 table unchanged on any
 * failure.
 */
export async function writeRunOutputs(
  client: PostgresClient,
  outputs: AnalyticsV2RunOutputs,
  options: WriteAnalyticsV2RunOptions,
): Promise<AnalyticsV2WriteReceipt> {
  if (client === null || typeof client !== "object" || typeof client.query !== "function"
      || options === null || typeof options !== "object") {
    fail("ANALYTICS_V2_RUN_INVALID");
  }
  const schema = quoteSchema(options.schema);
  if (typeof options.runId !== "string" || !UUID.test(options.runId)) fail("ANALYTICS_V2_RUN_INVALID", "runId");
  if (typeof options.startedAtMs !== "number" || !Number.isSafeInteger(options.startedAtMs)
      || options.startedAtMs < 0) {
    fail("ANALYTICS_V2_RUN_INVALID", "startedAtMs");
  }
  if (options.expectedCursor !== null
      && (typeof options.expectedCursor !== "string" || !DECIMAL.test(options.expectedCursor))) {
    fail("ANALYTICS_V2_RUN_INVALID", "expectedCursor");
  }
  if (typeof options.exclusionsSha256 !== "string" || !ANALYTICS_V2_SHA256_PATTERN.test(options.exclusionsSha256)) {
    fail("ANALYTICS_V2_RUN_INVALID", "exclusionsSha256");
  }
  const callerTimings = options.timings === undefined ? {} : validTimings(options.timings, "options.timings");
  const horizon = validHorizon(options.horizon);
  const stamp = validRunStamp(options.stamp);
  const wallClock = options.wallClock ?? Date.now;
  const prepared = await prepareOutputs(outputs, horizon);
  const priceCards = await analyticsV2KernelPriceCards();
  // The run's compatibility class; unknown (null) for a run without a resource record.
  const compatibilitySha256 = prepared.resources === null ? null
    : await analyticsV2CompatibilitySha256(stamp.kernel, prepared.resources.configuration);
  const writeStartedMs = wallClock();
  const runId = options.runId;
  const ownerDigests = prepared.ownerDigests;
  const releasedAt = new Date(prepared.nowMs).toISOString();

  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(`SET LOCAL statement_timeout='${WRITE_STATEMENT_TIMEOUT_MILLISECONDS}ms'`);
    await client.query(`SET LOCAL lock_timeout='${WRITE_LOCK_TIMEOUT_MILLISECONDS}ms'`);

    const storedCursor = await lockAnalyticsV2Run(client, schema, options.expectedCursor, prepared.lastSequence);
    await registerAnalyticsV2RunKernel(client, schema, stamp, releasedAt);
    // K-PERCARD: the kernel's cards, then the transitions from older stored
    // kernels (over their rows, before the derived rows are replaced).
    const kernelPrices = await registerAnalyticsV2KernelPrices(client, schema, stamp, releasedAt, priceCards);
    const transitions = await recordAnalyticsV2PriceTransitions(client, schema,
      options.priceTransitions ?? await proveAnalyticsV2PriceTransitions(client, { schema, stamp, cards: priceCards }),
      stamp, runId, releasedAt);
    const retainedOwners = await writeAnalyticsV2DerivedFamilies(client, schema, outputs,
      prepared.computedOwnerDigests, horizon, runId, stamp);
    const basesRegistered = await writeAnalyticsV2OwnerDayPrices(client, schema, outputs.ownerDayPrices,
      kernelPrices.refs, runId, stamp);
    const { published, unchanged, revisions, priorRevisions } = await writeAnalyticsV2PublishedDaily(client, schema,
      prepared, runId, releasedAt, stamp);
    const ownerSets = await writeAnalyticsV2OwnerSets(client, schema, prepared.dailyCandidates,
      { revisions, priorRevisions }, prepared.ownerSets, runId, stamp);
    await writeAnalyticsV2Preview(client, schema, outputs.preview, releasedAt, runId, stamp);
    const cursor = await advanceAnalyticsV2Cursor(client, schema, storedCursor, prepared.lastSequence, runId);

    const publication: AnalyticsV2PublicationSummary = {
      published: sortedDays(published),
      unchanged: sortedDays(unchanged),
      blocked: prepared.blockedDays,
      ownerSets,
    };
    const clockMs = wallClock();
    if (!Number.isSafeInteger(clockMs) || !Number.isSafeInteger(writeStartedMs)) {
      fail("ANALYTICS_V2_RUN_INVALID", "wallClock");
    }
    // Operational metadata only: a wall clock stepped backwards must not fail
    // a run, so finished_at is clamped to started_at.
    const finishedAtMs = Math.max(clockMs, options.startedAtMs);
    const timings = {
      ...prepared.timings,
      ...callerTimings,
      write: Math.max(0, clockMs - writeStartedMs),
    };
    // The run row's timings also carry the resource record (bounds applied,
    // and each effective owner's evidence size, estimate and sampled heap).
    const recorded = prepared.resources === null ? timings
      : { ...timings, resources: prepared.resources.configuration, owners: prepared.resources.owners,
        account: prepared.resources.account };
    await insertAnalyticsV2RunRow(client, schema, { runId, startedAtMs: options.startedAtMs, finishedAtMs,
      mode: prepared.mode, owners: ownerDigests.length, ownerDays: outputs.ownerDays.length,
      refusals: prepared.refusals, publication, timings: recorded, stamp, compatibilitySha256,
      exclusionsSha256: options.exclusionsSha256 });
    await client.query("COMMIT");
    transactionStarted = false;
    return Object.freeze({
      runId,
      state: "complete",
      mode: prepared.mode,
      owners: ownerDigests.length,
      ownerDays: outputs.ownerDays.length,
      retainedOwners,
      refusals: prepared.refusals.length,
      publication,
      cursor,
      timings,
      prices: Object.freeze({ kernelCards: priceCards.cards.length, cardsRegistered: kernelPrices.cardsRegistered,
        basesRegistered, ownerDays: outputs.ownerDayPrices.length, transitions }),
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The caller discards the connection; the transaction cannot commit.
      }
    }
    if (error instanceof AnalyticsV2StoreError) throw error;
    // K-PERCARD's closed, content-free codes (corrupt stored inputs, an invalid transition) pass through, and
    // W1E's (a kernel stating another pricing class than it registered, a failed sample, an invalid class state).
    if (error instanceof AnalyticsV2PriceError || error instanceof AnalyticsV2TransitionError
        || error instanceof AnalyticsV2PricingClassError) throw error;
    const sqlState = sqlStateOf(error);
    throw new AnalyticsV2StoreError("ANALYTICS_V2_WRITE_FAILED", sqlState === undefined ? {} : { sqlState });
  }
}
