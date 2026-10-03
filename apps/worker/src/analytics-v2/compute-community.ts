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
 *
 * Community aggregate exclusions (N-EXCL, exclusions.ts): an owner excluded on
 * day D is outside D's community cohort, as d43c8f92's weekly builder removed
 * an excluded participant before anything else. It is left out of D's daily
 * fold (values and devices) and out of the preview's day D (its fits in the
 * band, its model result for date D, refused or evaluated); the preview's
 * coverage counts are those of today. Its refusals decide nothing there:
 * D is blocked only by an owner not excluded on D, and an owner without a
 * fit withholds the preview only while it is a member of a day the preview
 * carries (today's cohort for the coverage, each day's cohort for its band
 * and model date). The owner's own rows and refusals are unchanged. With no
 * exclusion the outputs are exactly the fold without them.
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
import { analyticsV2ExcludedOn, type AnalyticsV2ExclusionInterval } from "./exclusions";

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
  /**
   * queued day -> every owner that blocks it (a refused owner-day, the memory
   * budget, non-effective typed evidence), whether or not it is excluded.
   */
  readonly blockers: ReadonlyMap<AnalyticsV2Day, ReadonlySet<AnalyticsV2OwnerDigest>>;
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
   * model date -> effective owners whose evaluation the kernels refused, in
   * digest order. (A memory-refused owner has no fit, so the preview that
   * carries the model dates is withheld for the run; it is never listed here.)
   */
  readonly modelRefusedByDate: ReadonlyMap<AnalyticsV2Day, readonly AnalyticsV2OwnerDigest[]>;
  /** computed owner -> its active community aggregate exclusions (N-EXCL; absent: none). */
  readonly exclusions: ReadonlyMap<AnalyticsV2OwnerDigest, readonly AnalyticsV2ExclusionInterval[]>;
}

/**
 * The queued days' daily candidates, the days the community could not publish
 * (blockedDays, ascending) and the preview (or null when it is withheld).
 */
export async function buildAnalyticsV2Community(input: AnalyticsV2CommunityInput): Promise<{
  readonly dailyCandidates: AnalyticsV2ComputedDailyCandidate[];
  readonly blockedDays: AnalyticsV2Day[];
  readonly preview: unknown;
}> {
  const nowIso = new Date(input.nowMs).toISOString();
  const computedOwners = input.computedOwners;
  const excluded = (ownerDigest: AnalyticsV2OwnerDigest, day: AnalyticsV2Day): boolean =>
    analyticsV2ExcludedOn(input.exclusions.get(ownerDigest), day);
  // A day is blocked for the community only by an owner of its cohort: an
  // owner excluded on it (N-EXCL) keeps its own refusals but decides nothing.
  const blockedDays = input.queued.filter((day) =>
    [...input.blockers.get(day) ?? []].some((ownerDigest) => !excluded(ownerDigest, day)));
  const blocked = new Set(blockedDays);
  const dailyCandidates: AnalyticsV2ComputedDailyCandidate[] = [];
  for (const day of input.queued) {
    if (blocked.has(day)) continue;
    const byOwner = input.dailyValues.get(day)!;
    // A memory-refused owner blocks every queued day it has evidence on, so
    // on an unblocked day it has none or is excluded: either way it adds
    // nothing (publicInputs adds nothing for an owner without records). An
    // owner excluded on the day (N-EXCL) is left out of its fold, so an
    // excluded owner that blocked it, and so has no values, is never read.
    const included = computedOwners.filter((owner) => !excluded(owner.ownerDigest, day));
    const values = included.map((owner) => byOwner.get(owner.ownerDigest)!);
    const counted = input.devicesByDay.get(day);
    const devices = values.map((value, index) => {
      if (value.counts.usage + value.counts.quota + value.counts.session === 0) return 0;
      if (counted === undefined) return invalid("devicesByDay.missingDay");
      return counted.get(included[index]!.ownerDigest) ?? 1;
    });
    const inputs = publicInputs(values, devices);
    const payload = buildCommunityDailyPayload({ day, revision: input.revisionSeed + 1, releasedAt: nowIso, ...inputs });
    dailyCandidates.push(Object.freeze({ day, payload, payloadSha256: await analyticsV2DailyContentSha256(payload),
      inputs }));
  }

  // d43c8f92 publishStorageCommunityGraphPreview defers (cache_pending)
  // unless every member has a current fits result. An effective owner
  // without one, refused by the kernels or by the memory budget, withholds
  // the preview while it is a member of any day the preview carries: a
  // partial cohort would state coverage counts, a band or a model date that
  // silently omit it. An owner excluded on a day is not that day's member
  // (N-EXCL), so one excluded on every such day withholds nothing.
  const withoutFits = input.effectiveDigests.filter((ownerDigest) => !input.fitsByOwner.has(ownerDigest));
  const memberWithoutFits = (day: AnalyticsV2Day): boolean =>
    withoutFits.some((ownerDigest) => !excluded(ownerDigest, day));
  const today = nowIso.slice(0, 10);
  if (memberWithoutFits(today) || input.modelDates.some(memberWithoutFits)) {
    return { dailyCandidates, blockedDays, preview: null };
  }
  const modelDays: AdminCommunityModelCompositionDay[] = [];
  for (const day of input.modelDates) {
    // An owner excluded on this date (N-EXCL) is outside its composition,
    // evaluated or refused.
    const evaluated = input.compositionsByDate.get(day)!.filter(({ ownerDigest }) => !excluded(ownerDigest, day));
    // An effective owner the kernels refused for this date is still a member
    // of its cohort: it is counted as refused, never dropped, even when no
    // owner could be evaluated (owner decision 2026-10-01, D7). A date with
    // no effective member at all is not published.
    const refused = input.modelRefusedByDate.get(day)!.filter((ownerDigest) => !excluded(ownerDigest, day)).length;
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
  const models: Parameters<typeof buildAdminCommunityAllowancePreview>[3] = {
    modelConfig: ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG, basis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
    gate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE, days: modelDays };
  // The preview over the owners not excluded on `day`: its coverage and every
  // band day are computed from that cohort's fits.
  const excludedKey = (day: AnalyticsV2Day): string => computedOwners
    .filter((owner) => excluded(owner.ownerDigest, day)).map((owner) => owner.ownerDigest).join(",");
  const builds = new Map<string, ReturnType<typeof buildAdminCommunityAllowancePreview>>();
  const buildFor = (key: string) => {
    let built = builds.get(key);
    if (built === undefined) {
      const left = new Set(key === "" ? [] : key.split(","));
      const cohortOwners = computedOwners.filter((owner) => !left.has(owner.ownerDigest));
      built = buildAdminCommunityAllowancePreview(
        cohortOwners.flatMap((owner) => input.fitsByOwner.get(owner.ownerDigest)!), input.nowMs,
        cohortOwners.map((owner) => owner.ownerDigest), models);
      if (built.days.length !== ANALYTICS_V2_MODEL_DATES) throw new Error("ANALYTICS_V2_PREVIEW_DAYS_DRIFT");
      builds.set(key, built);
    }
    return built;
  };
  // The coverage is today's (the preview's last day), as d43c8f92 counts it.
  const base = buildFor(excludedKey(today));
  // Every band day's cohort has its fits (checked before any of them is built).
  if (base.days.some((previewDay) => memberWithoutFits(previewDay.day))) {
    return { dailyCandidates, blockedDays, preview: null };
  }
  // Each band day is its own day's aggregate: an owner excluded on that day
  // only is left out of that day's band. Without exclusions every day comes
  // from the one build, exactly as before.
  const days = base.days.map((previewDay, index) => {
    const own = buildFor(excludedKey(previewDay.day)).days[index]!;
    if (own.day !== previewDay.day) throw new Error("ANALYTICS_V2_PREVIEW_DAYS_DRIFT");
    return own;
  });
  const built = days.every((day, index) => day === base.days[index]) ? base
    : Object.freeze({ ...base, days: Object.freeze(days) });
  const preview = validCachedAdminCommunityAllowancePreview(built, built.generatedAt, input.nowMs) ? built : null;
  return { dailyCandidates, blockedDays, preview };
}
