/**
 * analytics-v2 compute core, community outputs (K-SPLIT): the daily candidates
 * of the queued days and the admin allowance preview, folded from the
 * computed owners' results in owner-digest order. Moved out of compute.ts
 * unchanged in behaviour; compute.ts re-exports the public names.
 *
 * Daily candidates are stamped with the revision a first publication gets
 * (revisionSeed + 1) and releasedAt = nowMs. `payloadSha256` identifies the
 * CONTENT: it is the sha256 of the canonical payload without its revision
 * stamp (aggregateId, revision, releasedAt), so an unchanged day keeps its
 * revision. A-3 restamps a changed day with stampAnalyticsV2DailyPayload.
 */
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import {
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE,
  buildAdminCommunityAllowancePreview,
  buildCommunityDailyPayload,
  buildCommunityModelCompositionDay,
  publicInputs,
  validCachedAdminCommunityAllowancePreview,
  type AdminCommunityModelCompositionDay,
  type CachedCommunityModelCompositions,
  type CommunityAllowanceFit,
  type V11DailyProjectionValues,
  type V1ModelCompositionResult,
} from "../../vendor/analytics-d43c8f92/entry";
import type {
  AnalyticsV2DailyCandidate,
  AnalyticsV2Day,
  AnalyticsV2Owner,
  AnalyticsV2OwnerDigest,
} from "./contract";

/**
 * Model history dates, newest last: today and the 69 days before it. This is
 * d43c8f92 ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS; the fold checks the built
 * preview against it so a kernel change cannot drift silently.
 */
export const ANALYTICS_V2_MODEL_DATES = 70;

export type AnalyticsV2DailyPublicInputs = ReturnType<typeof publicInputs>;
export type AnalyticsV2DailyPayload = ReturnType<typeof buildCommunityDailyPayload>;

/** A daily candidate plus the revision-free public inputs it was built from. */
export interface AnalyticsV2ComputedDailyCandidate extends AnalyticsV2DailyCandidate {
  readonly payload: AnalyticsV2DailyPayload;
  readonly inputs: AnalyticsV2DailyPublicInputs;
}

const invalid = (what: string): never => { throw new TypeError(`ANALYTICS_V2_INPUT_INVALID:${what}`); };

/**
 * A daily payload's content identity: sha256 of its canonical JSON without the
 * revision stamp (aggregateId, revision, releasedAt). Equal for every stamp of
 * the same content, so A-3 and A-4 can verify a stored row against it.
 */
export async function analyticsV2DailyContentSha256(payload: AnalyticsV2DailyPayload): Promise<string> {
  const { aggregateId: _aggregateId, revision: _revision, releasedAt: _releasedAt, ...content } = payload;
  return sha256Hex(canonicalJson(content));
}

/**
 * The payload A-3 publishes for `candidate` under a given revision and
 * release time. The content (and so payloadSha256) is unchanged; only the
 * kernel's revision stamp (aggregateId, revision, releasedAt) differs.
 */
export async function stampAnalyticsV2DailyPayload(candidate: AnalyticsV2ComputedDailyCandidate,
  stamp: { revision: number; releasedAt: string }): Promise<AnalyticsV2DailyPayload> {
  if (!Number.isSafeInteger(stamp.revision) || stamp.revision < 1 || typeof stamp.releasedAt !== "string"
    || !Number.isFinite(Date.parse(stamp.releasedAt))
    || new Date(Date.parse(stamp.releasedAt)).toISOString() !== stamp.releasedAt) {
    throw new TypeError("ANALYTICS_V2_DAILY_STAMP_INVALID");
  }
  const payload = buildCommunityDailyPayload({ day: candidate.day, revision: stamp.revision,
    releasedAt: stamp.releasedAt, ...candidate.inputs });
  if (await analyticsV2DailyContentSha256(payload) !== candidate.payloadSha256) {
    throw new Error("ANALYTICS_V2_DAILY_CONTENT_CHANGED");
  }
  return payload;
}

/** The community fold's inputs: every computed owner's results, merged in owner-digest order. */
export interface AnalyticsV2CommunityInput {
  readonly nowMs: number;
  readonly revisionSeed: number;
  readonly queued: readonly AnalyticsV2Day[];
  readonly blocked: ReadonlySet<AnalyticsV2Day>;
  /** queued day -> computed owner -> unfinalized daily values (owners in digest order). */
  readonly dailyValues: ReadonlyMap<AnalyticsV2Day, ReadonlyMap<AnalyticsV2OwnerDigest, V11DailyProjectionValues>>;
  /** Effective owners that were computed (admitted by the memory budget), in digest order. */
  readonly computedOwners: readonly AnalyticsV2Owner[];
  readonly effectiveDigests: readonly AnalyticsV2OwnerDigest[];
  readonly devicesByDay: ReadonlyMap<AnalyticsV2Day, ReadonlyMap<AnalyticsV2OwnerDigest, number>>;
  readonly fitsByOwner: ReadonlyMap<AnalyticsV2OwnerDigest, readonly CommunityAllowanceFit[]>;
  readonly modelDates: readonly AnalyticsV2Day[];
  readonly compositionsByDate: ReadonlyMap<AnalyticsV2Day,
    ReadonlyArray<{ readonly ownerDigest: string; readonly result: V1ModelCompositionResult }>>;
  /**
   * model date -> effective owners whose evaluation the kernels refused. (A
   * memory-refused owner has no fit, so the preview that carries the model
   * dates is withheld for the run; it is never counted here.)
   */
  readonly modelRefusedByDate: ReadonlyMap<AnalyticsV2Day, number>;
}

/** The queued days' daily candidates and the preview (or null when it is withheld). */
export async function buildAnalyticsV2Community(input: AnalyticsV2CommunityInput): Promise<{
  readonly dailyCandidates: AnalyticsV2ComputedDailyCandidate[];
  readonly preview: unknown;
}> {
  const nowIso = new Date(input.nowMs).toISOString();
  const computedOwners = input.computedOwners;
  const dailyCandidates: AnalyticsV2ComputedDailyCandidate[] = [];
  for (const day of input.queued) {
    if (input.blocked.has(day)) continue;
    const byOwner = input.dailyValues.get(day)!;
    // A memory-refused owner blocks every queued day it has evidence on, so
    // on an unblocked day it has none: its values would be all zero, and
    // publicInputs adds nothing for an owner without records.
    const values = computedOwners.map((owner) => byOwner.get(owner.ownerDigest)!);
    const counted = input.devicesByDay.get(day);
    const devices = values.map((value, index) => {
      if (value.counts.usage + value.counts.quota + value.counts.session === 0) return 0;
      if (counted === undefined) return invalid("devicesByDay.missingDay");
      return counted.get(computedOwners[index]!.ownerDigest) ?? 1;
    });
    const inputs = publicInputs(values, devices);
    const payload = buildCommunityDailyPayload({ day, revision: input.revisionSeed + 1, releasedAt: nowIso, ...inputs });
    dailyCandidates.push(Object.freeze({ day, payload, payloadSha256: await analyticsV2DailyContentSha256(payload),
      inputs }));
  }

  // d43c8f92 publishStorageCommunityGraphPreview defers (cache_pending)
  // unless every member has a current fits result. An effective owner
  // without one, refused by the kernels or by the memory budget, withholds
  // the preview: a partial cohort would state coverage counts that silently
  // omit it.
  if (input.effectiveDigests.some((ownerDigest) => !input.fitsByOwner.has(ownerDigest))) {
    return { dailyCandidates, preview: null };
  }
  const fits = computedOwners.flatMap((owner) => input.fitsByOwner.get(owner.ownerDigest)!);
  const cohort = computedOwners.map((owner) => owner.ownerDigest);
  const modelDays: AdminCommunityModelCompositionDay[] = [];
  for (const day of input.modelDates) {
    const evaluated = input.compositionsByDate.get(day)!;
    // An effective owner the kernels refused for this date is still a member
    // of its cohort: it is counted as refused, never dropped, even when no
    // owner could be evaluated (owner decision 2026-10-01, D7). A date with
    // no effective member at all is not published.
    const refused = input.modelRefusedByDate.get(day)!;
    if (evaluated.length === 0 && refused === 0) continue;
    const collection: CachedCommunityModelCompositions = { compositions: [], v1ParticipantCount: refused,
      unsupportedSourceParticipantCount: 0, refusedParticipantCount: refused, storeAvailable: true };
    for (const { ownerDigest, result } of evaluated) {
      collection.v1ParticipantCount++;
      if (result.status === "ready") collection.compositions.push({ participantId: ownerDigest, composition: result });
      else collection.refusedParticipantCount++;
    }
    modelDays.push(buildCommunityModelCompositionDay(collection, day));
  }
  const built = buildAdminCommunityAllowancePreview(fits, input.nowMs, cohort, {
    modelConfig: ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG, basis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
    gate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE, days: modelDays });
  if (built.days.length !== ANALYTICS_V2_MODEL_DATES) throw new Error("ANALYTICS_V2_PREVIEW_DAYS_DRIFT");
  const preview = validCachedAdminCommunityAllowancePreview(built, built.generatedAt, input.nowMs) ? built : null;
  return { dailyCandidates, preview };
}
